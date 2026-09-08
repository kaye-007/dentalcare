/**
 * Prettier, on the files this change actually touches.
 *
 * ── Why not `prettier --check .` ──────────────────────────────────────────
 *
 * This codebase is hand-wrapped, not machine-formatted. SQL sits in template
 * literals broken at clause boundaries, long comment blocks are aligned by
 * eye, and Nest decorators are laid out to read. Prettier disagrees with 185
 * of ~310 files, and it disagrees at every print width — 80, 90 and 100 were
 * all measured, and the best of them still rewrote 8,864 lines.
 *
 * Running that once would be a single mechanical commit, and it would also
 * bury this branch's real changes underneath it, permanently spoil
 * `git blame` on the security-critical files, and make a later migration
 * baseline diff unreadable. The formatting is not the problem to fix here.
 *
 * So the gate is on new work: whatever a change adds or edits must be
 * formatted, and the rest is left alone. Drift stops, nothing is rewritten,
 * and the repository converges file by file — at the moment someone is
 * already reading that file anyway.
 *
 * ── What "this change" means ──────────────────────────────────────────────
 *
 *   default             uncommitted work: staged + unstaged
 *   FORMAT_BASE_REF=x   everything that differs from x
 *   --all               the whole repository, for the curious
 *
 * CI sets FORMAT_BASE_REF to the pull request's base commit, or to the commit
 * a push started from. Comparing against `main` is deliberately NOT the
 * default: `main` here is a single "Add project files" commit with the entire
 * project layered on top of it, so a merge-base diff is every file in the
 * repository and the gate would degenerate into the repo-wide check above.
 */
const { execFileSync, spawnSync } = require('child_process');

const ALL = process.argv.includes('--all');
const BASE_REF = process.env.FORMAT_BASE_REF || '';

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const X = '\x1b[0m';

/** Extensions Prettier owns here. Everything else it would only guess at. */
const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml)$/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Paths from a `git diff --name-only`, filtered to what Prettier handles. */
function collect(sets) {
  const files = new Set();
  for (const set of sets) {
    for (const line of set.split('\n')) {
      const file = line.trim();
      if (file && EXTENSIONS.test(file)) files.add(file);
    }
  }
  return [...files].sort();
}

/**
 * Deleted files still appear in a diff and Prettier cannot read them, so the
 * filter is ACMR — added, copied, modified, renamed.
 */
const NAMES = ['diff', '--name-only', '--diff-filter=ACMR'];

function scope() {
  if (!BASE_REF) {
    return {
      label: 'uncommitted changes',
      files: collect([git([...NAMES, 'HEAD']), git([...NAMES, '--cached', 'HEAD'])]),
    };
  }

  let base;
  try {
    base = git(['rev-parse', '--verify', `${BASE_REF}^{commit}`]);
  } catch {
    // A force-push, a shallow clone, or a first push where the "before" commit
    // is all zeroes. Checking nothing is right; failing would be theatre.
    return { label: null, files: [] };
  }

  return {
    label: BASE_REF,
    files: collect([
      git([...NAMES, base, 'HEAD']),
      git([...NAMES, 'HEAD']),
      git([...NAMES, '--cached', 'HEAD']),
    ]),
  };
}

function main() {
  let files;
  let label;

  if (ALL) {
    console.log(`${D}Checking every file Prettier owns.${X}`);
    files = ['.'];
  } else {
    const found = scope();

    if (found.label === null) {
      console.log(`${D}Cannot resolve ${BASE_REF} — nothing checked.${X}`);
      return 0;
    }
    if (found.files.length === 0) {
      console.log(`${G}No formattable files changed (${found.label}).${X}`);
      return 0;
    }

    files = found.files;
    label = found.label;
    console.log(`${D}Checking ${files.length} changed file(s) — ${label}.${X}`);
  }

  const result = spawnSync(
    process.execPath,
    [
      require.resolve('prettier/bin/prettier.cjs'),
      '--check',
      '--ignore-unknown',
      ...files,
    ],
    { stdio: 'inherit' },
  );

  if (result.status === 0) {
    console.log(`${G}Formatting is clean.${X}`);
    return 0;
  }

  console.error(
    `\n${R}Formatting${X}  Run: ${D}npx prettier --write <the files above>${X}\n` +
      `${D}Only files this change touches are checked; the rest of the${X}\n` +
      `${D}repository is deliberately left as it is.${X}`,
  );
  return 1;
}

process.exit(main());
