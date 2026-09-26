/**
 * Write the two Hyperdrive config ids into wrangler.jsonc.
 *
 *   npm run cf:set-hyperdrive -w @dentalcare/api -- --app <id> --admin <id>
 *   node scripts/set-hyperdrive-ids.mjs --app <id> --admin <id> [--config <path>]
 *
 * The ids come from `npx wrangler hyperdrive create` (or `list`) in the
 * Cloudflare account this deploys to. They cannot be generated or guessed
 * from here, which is why the repository ships placeholders and why
 * check-cloudflare-bindings.mjs refuses to deploy until they are replaced.
 *
 * WHY A SCRIPT FOR A TWO-LINE EDIT
 *
 * Because the edit is easy to get wrong in the one way that is not visible.
 * Pasting the same id into both slots, or the two ids into the wrong slots,
 * gives a file that deploys and serves requests. HYPERDRIVE_APP must be the
 * config that connects as app_user (NOBYPASSRLS). If it is the owner-role
 * config instead, Row-Level Security is bypassed for every clinic, and
 * nothing fails. So this script:
 *
 *   - takes each id by the binding it belongs to (--app, --admin), never by
 *     position in the file;
 *   - refuses anything that is not a 32-character lowercase hex config id;
 *   - refuses the same id for both;
 *   - replaces only the two id string values, found by parsing, not by a
 *     regular expression. Every comment, blank line, trailing comma and line
 *     ending in wrangler.jsonc stays byte-for-byte as it was;
 *   - checks the written result with the same rules as cf:deploy.
 *
 * It does not check that the app id really is the app_user config. Nothing
 * in the file can know which role a config connects as. `npx wrangler
 * hyperdrive get <id>` shows the user, and it is worth one look before the
 * first deploy.
 *
 * The ids are not secrets: an id grants nothing without the account's API
 * token, and the database password lives inside the Hyperdrive config at
 * Cloudflare, not here. Committing them is a normal choice.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  DEFAULT_CONFIG,
  REQUIRED_BINDINGS,
  findProblems,
  hyperdriveEntries,
  idProblem,
  parseJsoncTree,
} from './check-cloudflare-bindings.mjs';

const USAGE =
  'usage: npm run cf:set-hyperdrive -w @dentalcare/api -- --app <id> --admin <id> [--config <wrangler.jsonc>]';

/** Print why, and exit without having written anything. */
function refuse(message) {
  console.error(`set-hyperdrive-ids: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { config: DEFAULT_CONFIG };
  const known = new Set(['--app', '--admin', '--config']);
  for (let i = 0; i < argv.length; i++) {
    let name = argv[i];
    let val;
    const eq = name.indexOf('=');
    if (name.startsWith('--') && eq > 0) {
      val = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if (known.has(name)) {
      val = argv[++i];
    }
    if (!known.has(name)) refuse(`unknown argument "${argv[i]}"\n${USAGE}`);
    if (val === undefined || val === '') refuse(`${name} needs a value\n${USAGE}`);
    out[name.slice(2)] = val;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(args.config);
  const shown = relative(process.cwd(), configPath) || configPath;

  // Both, every time. Setting one would leave a file that still fails
  // cf:check, and it invites the half-finished state where the second id is
  // pasted by hand into the wrong slot.
  const wanted = REQUIRED_BINDINGS.map((r) => ({ ...r, id: args[r.flag.slice(2)] }));
  const missing = wanted.filter((w) => w.id === undefined);
  if (missing.length) {
    refuse(
      `missing ${missing.map((m) => m.flag).join(' and ')}. Both ids are required.\n${USAGE}`,
    );
  }

  for (const w of wanted) {
    const why = idProblem(w.id);
    if (why) {
      refuse(
        `${w.flag} ${why}.\n` +
          '  Use the id printed by `npx wrangler hyperdrive create` or `npx wrangler hyperdrive list`.',
      );
    }
  }

  const [app, admin] = wanted;
  if (app.id === admin.id) {
    refuse(
      '--app and --admin are the same id. HYPERDRIVE_APP must be a config that\n' +
        '  connects as app_user and HYPERDRIVE_ADMIN a separate one that connects as\n' +
        '  the owner role. With one config for both, the tenant plane bypasses\n' +
        "  Row-Level Security and every clinic can read every other clinic's records.",
    );
  }

  let source;
  let tree;
  try {
    source = readFileSync(configPath, 'utf8');
    tree = parseJsoncTree(source);
  } catch (err) {
    refuse(`cannot read ${shown}: ${err.message}`);
  }

  const entries = hyperdriveEntries(tree);
  const edits = [];
  for (const w of wanted) {
    const matches = entries.filter((e) => e.binding === w.binding);
    if (matches.length !== 1) {
      refuse(
        `${shown} declares ${w.binding} ${matches.length} times; expected exactly once.\n` +
          '  This script only replaces ids. It does not add or remove bindings.',
      );
    }
    const [entry] = matches;
    if (!entry.idNode) {
      refuse(`${w.binding} in ${shown} has no "id" string to replace.`);
    }
    edits.push({ ...w, before: entry.id, node: entry.idNode });
  }

  // Splice from the end so the earlier offsets stay valid.
  let next = source;
  for (const e of [...edits].sort((a, b) => b.node.start - a.node.start)) {
    next = next.slice(0, e.node.start) + JSON.stringify(e.id) + next.slice(e.node.end);
  }

  // Re-read what is about to be written, with the rules cf:deploy uses,
  // before touching the file. A parser mistake here must fail as a refusal,
  // never as a damaged wrangler.jsonc.
  const written = hyperdriveEntries(parseJsoncTree(next));
  for (const e of edits) {
    if (written.find((w) => w.binding === e.binding)?.id !== e.id) {
      refuse(`internal error: ${e.binding} did not come out as ${e.id}; nothing was written.`);
    }
  }

  if (next === source) {
    console.log(`${shown}: both Hyperdrive ids were already set to these values. Nothing changed.`);
  } else {
    writeFileSync(configPath, next);
    console.log(`Updated ${shown}:`);
    for (const e of edits) {
      console.log(`  ${e.binding.padEnd(16)}  ${e.before} -> ${e.id}`);
    }
  }

  const remaining = findProblems(parseJsoncTree(next));
  if (remaining.length) {
    console.error('\nThe ids are set, but the file is still not deployable:');
    for (const p of remaining) console.error(`  ${p.binding}  ${p.message}`);
    console.error('\nRun `npm run cf:check -w @dentalcare/api` for the full report.');
    process.exit(1);
  }

  console.log(
    '\nBoth bindings are valid and distinct. Before the first deploy, confirm which\n' +
      'role each config connects as. HYPERDRIVE_APP must show app_user:\n\n' +
      `  npx wrangler hyperdrive get ${app.id}\n` +
      `  npx wrangler hyperdrive get ${admin.id}\n\n` +
      'Then: npm run cf:deploy -w @dentalcare/api',
  );
}

main();
