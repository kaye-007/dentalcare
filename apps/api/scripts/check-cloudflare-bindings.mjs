/**
 * Refuse to deploy the API Worker while its Hyperdrive bindings are not real.
 *
 *   npm run cf:check -w @dentalcare/api                 strict: exit 1 if not deployable
 *   node scripts/check-cloudflare-bindings.mjs --warn   banner, exit 0 (cf:dry-run)
 *   ... --config <path>                                 another wrangler.jsonc (tests)
 *
 * WHY THIS EXISTS
 *
 * wrangler.jsonc ships with REPLACE_WITH_HYPERDRIVE_*_ID in both Hyperdrive
 * ids, because the real ids exist only in the Cloudflare account that creates
 * them. `wrangler deploy --dry-run` accepts that file happily. A dry run does
 * not talk to the account, so to it a placeholder is just a string. A green
 * dry run therefore looked like a deployable Worker when it was not. The real
 * `wrangler deploy` would then fail on the binding, and the error reads like a
 * Cloudflare problem rather than "nobody pasted the ids in".
 *
 * So cf:deploy runs this in strict mode BEFORE it spends a minute building,
 * and cf:dry-run runs it with --warn AFTER wrangler, so the NOT DEPLOYABLE
 * banner is the last thing on the screen instead of scrolled away above a
 * wall of bundle output.
 *
 * WHAT IT CHECKS, AND WHY THE LAST CHECK MATTERS MOST
 *
 *   - both HYPERDRIVE_APP and HYPERDRIVE_ADMIN are declared, once each;
 *   - every hyperdrive id is a Hyperdrive config id (32 lowercase hex
 *     characters, as `wrangler hyperdrive create` and `list` print them),
 *     not a placeholder and not something typed by hand;
 *   - the two ids are DIFFERENT.
 *
 * The third check is the one that matters for security. HYPERDRIVE_APP
 * connects as app_user, which is NOBYPASSRLS, so Row-Level Security holds.
 * HYPERDRIVE_ADMIN connects as the owner role, which bypasses RLS by design.
 * If both bindings point at one config, the tenant plane runs as whichever role
 * that config uses. If it is the owner, every clinic can read every other
 * clinic's records. Nothing in the deploy would fail and no test would go red;
 * it would simply be true in production. The same id in both slots is
 * therefore refused even though each id on its own is valid.
 *
 * It only reads. It never contacts Cloudflare. It cannot tell whether an id
 * really exists in the account; `wrangler deploy` finds that out, and says so
 * in terms that are clear once the id is at least shaped like an id.
 *
 * THE PARSER
 *
 * wrangler.jsonc is JSON with comments and trailing commas. Stripping comments
 * with a regular expression is not safe here: this very file has "//" inside
 * string values (the postgres:// connection strings and the schema path). So
 * this is a small recursive-descent parser that skips comments only outside
 * strings. It also records where every value starts and ends, which is what
 * lets set-hyperdrive-ids.mjs replace the two id strings in place without
 * touching a comment. That script imports it from here, so one parser defines
 * what "the id of HYPERDRIVE_APP" means. The integration test
 * cloudflare-config.itest.ts mirrors the comment-skipping rules, because
 * ts-jest loads CommonJS and cannot import this module.
 */
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));

/** The two bindings the Worker reads, and what each must connect as. */
export const REQUIRED_BINDINGS = [
  {
    binding: 'HYPERDRIVE_APP',
    flag: '--app',
    name: 'dentalcare-app',
    connection: 'postgres://app_user:PASSWORD@db.PROJECT.supabase.co:5432/postgres',
  },
  {
    binding: 'HYPERDRIVE_ADMIN',
    flag: '--admin',
    name: 'dentalcare-admin',
    connection: 'postgres://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres',
  },
];

/** A Hyperdrive config id, exactly as wrangler prints it. */
export const HYPERDRIVE_ID = /^[0-9a-f]{32}$/;

// ── JSONC ────────────────────────────────────────────────────────────────────

/**
 * Parse JSONC into a tree whose nodes carry their source span.
 *
 *   { type: 'object', members: [{ key, value }], start, end }
 *   { type: 'array', items: [...], start, end }
 *   { type: 'string' | 'number' | 'boolean' | 'null', value, start, end }
 *
 * `start` and `end` are offsets into `text`, end exclusive, so
 * `text.slice(node.start, node.end)` is the value exactly as written,
 * quotes included.
 */
export function parseJsoncTree(text) {
  let i = 0;

  const fail = (message) => {
    const before = text.slice(0, i).split('\n');
    const line = before.length;
    const column = before[before.length - 1].length + 1;
    throw new SyntaxError(`${message} at line ${line}, column ${column}`);
  };

  /** Whitespace and both comment forms, outside strings only. */
  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') {
        i++;
      } else if (c === '/' && text[i + 1] === '/') {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl;
      } else if (c === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2);
        if (close < 0) fail('unterminated block comment');
        i = close + 2;
      } else {
        return;
      }
    }
  };

  const string = () => {
    const start = i;
    for (i++; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') i++;
      else if (c === '\n') fail('unterminated string');
      else if (c === '"') {
        i++;
        return { type: 'string', value: JSON.parse(text.slice(start, i)), start, end: i };
      }
    }
    return fail('unterminated string');
  };

  const token = (re, type, convert) => {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) return null;
    const start = i;
    i += m[0].length;
    return { type, value: convert(m[0]), start, end: i };
  };

  const value = () => {
    skip();
    const start = i;
    const c = text[i];

    if (c === '{') {
      i++;
      const members = [];
      for (skip(); text[i] !== '}'; skip()) {
        if (text[i] !== '"') fail('expected a property name or "}"');
        const key = string().value;
        skip();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        members.push({ key, value: value() });
        skip();
        if (text[i] === ',') i++; // a trailing comma is legal JSONC
        else if (text[i] !== '}') fail('expected "," or "}"');
      }
      i++;
      return { type: 'object', members, start, end: i };
    }

    if (c === '[') {
      i++;
      const items = [];
      for (skip(); text[i] !== ']'; skip()) {
        items.push(value());
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail('expected "," or "]"');
      }
      i++;
      return { type: 'array', items, start, end: i };
    }

    if (c === '"') return string();

    return (
      token(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y, 'number', Number) ??
      token(/true|false/y, 'boolean', (s) => s === 'true') ??
      token(/null/y, 'null', () => null) ??
      fail(c === undefined ? 'unexpected end of file' : `unexpected character "${c}"`)
    );
  };

  const root = value();
  skip();
  if (i < text.length) fail('unexpected content after the top-level value');
  return root;
}

/** The plain JavaScript value of a tree node. */
export function toValue(node) {
  switch (node.type) {
    case 'object':
      return Object.fromEntries(node.members.map((m) => [m.key, toValue(m.value)]));
    case 'array':
      return node.items.map(toValue);
    default:
      return node.value;
  }
}

export function parseJsonc(text) {
  return toValue(parseJsoncTree(text));
}

const member = (objectNode, key) =>
  objectNode?.type === 'object'
    ? objectNode.members.find((m) => m.key === key)?.value
    : undefined;

/**
 * Every entry of the top-level "hyperdrive" array, with the tree node of its
 * id string so a caller can rewrite it in place.
 */
export function hyperdriveEntries(tree) {
  const list = member(tree, 'hyperdrive');
  if (!list) return [];
  if (list.type !== 'array') throw new SyntaxError('"hyperdrive" must be an array');
  return list.items.map((item, index) => {
    const binding = member(item, 'binding');
    const id = member(item, 'id');
    return {
      index,
      binding: binding?.type === 'string' ? binding.value : undefined,
      id: id?.type === 'string' ? id.value : undefined,
      idNode: id?.type === 'string' ? id : undefined,
    };
  });
}

// ── the check ────────────────────────────────────────────────────────────────

/** Why `id` is not a usable Hyperdrive id, or null if it is one. */
export function idProblem(id) {
  if (id === undefined) return 'has no "id" string';
  if (/^REPLACE_WITH_/.test(id)) return `id "${id}" is still the placeholder`;
  if (!HYPERDRIVE_ID.test(id)) {
    return `id "${id}" is not a Hyperdrive config id (32 lowercase hex characters)`;
  }
  return null;
}

/**
 * Everything wrong with the hyperdrive section, as { binding, message }
 * pairs. An empty list means deployable, as far as this file can tell.
 */
export function findProblems(tree) {
  const problems = [];
  const entries = hyperdriveEntries(tree);

  for (const { binding } of REQUIRED_BINDINGS) {
    const matches = entries.filter((e) => e.binding === binding);
    if (matches.length === 0) {
      problems.push({ binding, message: 'is not declared in "hyperdrive"', create: true });
    } else if (matches.length > 1) {
      problems.push({
        binding,
        message: `is declared ${matches.length} times; the Worker reads one`,
      });
    }
  }

  for (const entry of entries) {
    const label = entry.binding ?? `hyperdrive[${entry.index}]`;
    if (entry.binding === undefined) {
      problems.push({ binding: label, message: 'has no "binding" name' });
    }
    const why = idProblem(entry.id);
    if (why) problems.push({ binding: label, message: why, create: true });
  }

  const app = entries.find((e) => e.binding === 'HYPERDRIVE_APP');
  const admin = entries.find((e) => e.binding === 'HYPERDRIVE_ADMIN');
  if (app?.id !== undefined && app.id === admin?.id && HYPERDRIVE_ID.test(app.id)) {
    problems.push({
      binding: 'HYPERDRIVE_APP + HYPERDRIVE_ADMIN',
      message:
        `share one id (${app.id}). The tenant plane would connect with the ` +
        'platform role, which bypasses Row-Level Security: every clinic could ' +
        "read every other clinic's records. Each binding needs its own config.",
      create: true,
      both: true,
    });
  }

  return problems;
}

// ── output ───────────────────────────────────────────────────────────────────

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint('31');
const yellow = paint('33;1');
const bold = paint('1');
const dim = paint('2');

/** The problems, then the exact commands that resolve them. */
function report(problems, shownPath) {
  const lines = [];
  const width = Math.max(...problems.map((p) => p.binding.length));
  for (const p of problems) lines.push(`  ${bold(p.binding.padEnd(width))}  ${p.message}`);

  const needCreate = REQUIRED_BINDINGS.filter((r) =>
    problems.some((p) => p.create && (p.both || p.binding === r.binding)),
  );

  lines.push('', bold('How to fix it') + dim('  (run from apps/api)'), '');
  let step = 1;
  if (needCreate.length) {
    lines.push(
      `  ${step++}. Create the Hyperdrive config${needCreate.length > 1 ? 's' : ''}. ` +
        'Caching must stay disabled: its cache is keyed on the query, not',
      "     on the clinic, so a cached row from one clinic can be served to another.",
      "     Use Supabase's direct host on port 5432. If you created them already,",
      '     `npx wrangler hyperdrive list` shows the ids again.',
      '',
    );
    for (const r of needCreate) {
      lines.push(
        `       npx wrangler hyperdrive create ${r.name} --caching-disabled \\`,
        `         --connection-string="${r.connection}"`,
        '',
      );
    }
  }
  lines.push(
    `  ${step++}. Write both ids into ${shownPath}. This keeps every comment:`,
    '',
    '       npm run cf:set-hyperdrive -w @dentalcare/api -- --app <app id> --admin <admin id>',
    '',
    `  ${step}. Check again:`,
    '',
    '       npm run cf:check -w @dentalcare/api',
  );
  return lines.join('\n');
}

function banner(text) {
  const rule = '#'.repeat(78);
  return [rule, `##  ${text.padEnd(72)}##`, rule].map(yellow).join('\n');
}

// ── command line ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { warn: false, config: DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--warn') out.warn = true;
    else if (arg === '--config' && argv[i + 1]) out.config = resolve(argv[++i]);
    else if (arg.startsWith('--config=')) out.config = resolve(arg.slice(9));
    else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function main() {
  let args;
  let problems;
  let shownPath;
  try {
    args = parseArgs(process.argv.slice(2));
    shownPath = relative(process.cwd(), args.config) || args.config;
    problems = findProblems(parseJsoncTree(readFileSync(args.config, 'utf8')));
  } catch (err) {
    // A config this script cannot read is not a "warning". In --warn mode
    // wrangler has just parsed the same file successfully, so this means the
    // checker is wrong, and it should say so loudly rather than pass.
    console.error(red(`check-cloudflare-bindings: ${err.message}`));
    console.error(
      'usage: node scripts/check-cloudflare-bindings.mjs [--warn] [--config <wrangler.jsonc>]',
    );
    process.exit(2);
  }

  if (problems.length === 0) {
    console.log(`Hyperdrive bindings in ${shownPath}: both set, and distinct. Deployable.`);
    return;
  }

  if (args.warn) {
    console.log(
      [
        '',
        banner('NOT DEPLOYABLE: the bundle above built, the bindings are not real'),
        '',
        `${shownPath} would fail on \`wrangler deploy\` (npm run cf:deploy refuses it):`,
        '',
        report(problems, shownPath),
        '',
        yellow('#'.repeat(78)),
        '',
      ].join('\n'),
    );
    return;
  }

  console.error(
    [
      '',
      red(bold(`NOT DEPLOYABLE: ${shownPath} has no usable Hyperdrive bindings.`)),
      '',
      report(problems, shownPath),
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// Imported by set-hyperdrive-ids.mjs for the parser; run only when invoked.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
