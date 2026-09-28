/**
 * Ask Cloudflare whether both Hyperdrive configs have caching disabled.
 *
 *   npm run cf:check-caching -w @dentalcare/api
 *   node scripts/check-hyperdrive-caching.mjs [--config <wrangler.jsonc>]
 *
 * WHY THIS EXISTS
 *
 * Hyperdrive's result cache is keyed on the query text, not on the transaction
 * that set app.current_tenant_id. With caching on, a row read by one clinic
 * can be served to another. Caching is a property of the config in the
 * Cloudflare account, not of the binding in wrangler.jsonc, so nothing that
 * reads this repository — check-cloudflare-bindings.mjs, the dry run, the
 * integration suite — can see it. Until now the only evidence was a line in
 * DEPLOYMENT.md asking someone to look.
 *
 * WHAT IT DOES
 *
 * Reads both ids from wrangler.jsonc with the same parser the bindings check
 * uses, runs `wrangler hyperdrive get <id>` for each, and reads `caching` from
 * the JSON wrangler prints. It needs a logged-in wrangler (or
 * CLOUDFLARE_API_TOKEN) and network access.
 *
 * WHAT IT REFUSES TO GUESS
 *
 *   exit 0   both configs report caching.disabled === true
 *   exit 1   a config has caching on, or the ids are still placeholders
 *   exit 2   UNVERIFIED — wrangler failed, or printed something this script
 *            cannot read. That is not a pass. Check by hand with
 *            `npx wrangler hyperdrive get <id>`.
 *
 * Written against the Hyperdrive config shape in Cloudflare's API
 * documentation; it has not yet been run against a real account.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  DEFAULT_CONFIG,
  REQUIRED_BINDINGS,
  hyperdriveEntries,
  idProblem,
  parseJsoncTree,
} from './check-cloudflare-bindings.mjs';

const PASS = 0;
const FAIL = 1;
const UNVERIFIED = 2;

function parseArgs(argv) {
  const out = { config: DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' && argv[i + 1]) out.config = resolve(argv[++i]);
    else if (arg.startsWith('--config=')) out.config = resolve(arg.slice(9));
    else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

/** The first complete JSON object in `text`, or null. Wrangler prints a banner first. */
export function firstJsonObject(text) {
  for (
    let start = text.indexOf('{');
    start !== -1;
    start = text.indexOf('{', start + 1)
  ) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

/**
 * What a config's `caching` says: 'disabled', 'enabled', or 'unknown'.
 *
 * Only an explicit `disabled: true` counts as disabled. A config with caching
 * on may report `disabled: false`, or omit the flag and carry max_age instead;
 * both are 'enabled'. No `caching` field at all is 'unknown', not a pass.
 */
export function cachingState(config) {
  const caching = config?.caching;
  if (caching === undefined || caching === null || typeof caching !== 'object')
    return 'unknown';
  return caching.disabled === true ? 'disabled' : 'enabled';
}

function main() {
  let args;
  let entries;
  try {
    args = parseArgs(process.argv.slice(2));
    entries = hyperdriveEntries(parseJsoncTree(readFileSync(args.config, 'utf8')));
  } catch (err) {
    console.error(`check-hyperdrive-caching: ${err.message}`);
    process.exit(UNVERIFIED);
  }
  const shown = relative(process.cwd(), args.config) || args.config;

  let exit = PASS;
  for (const { binding } of REQUIRED_BINDINGS) {
    const entry = entries.find((e) => e.binding === binding);
    const problem = entry ? idProblem(entry.id) : 'is not declared';
    if (problem) {
      console.error(`${binding}: ${problem} in ${shown}. Run cf:check first.`);
      exit = Math.max(exit, FAIL);
      continue;
    }

    const run = spawnSync('npx', ['wrangler', 'hyperdrive', 'get', entry.id], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (run.status !== 0) {
      console.error(
        `${binding} (${entry.id}): UNVERIFIED — wrangler exited ${run.status}.\n` +
          `${(run.stderr || run.stdout || '').trim()}`,
      );
      exit = Math.max(exit, UNVERIFIED);
      continue;
    }

    const state = cachingState(firstJsonObject(run.stdout));
    if (state === 'disabled') {
      console.log(`${binding} (${entry.id}): caching disabled.`);
    } else if (state === 'enabled') {
      console.error(
        `${binding} (${entry.id}): CACHING IS ON. One clinic's rows can be served to another.\n` +
          `  Fix: npx wrangler hyperdrive update ${entry.id} --caching-disabled`,
      );
      exit = FAIL;
    } else {
      console.error(
        `${binding} (${entry.id}): UNVERIFIED — could not read "caching" from wrangler's output.\n` +
          `  Check by hand: npx wrangler hyperdrive get ${entry.id}`,
      );
      exit = Math.max(exit, UNVERIFIED);
    }
  }

  if (exit === PASS) console.log('Both Hyperdrive configs have caching disabled.');
  process.exit(exit);
}

main();
