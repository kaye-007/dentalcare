/**
 * Prettier, on the whole repository.
 *
 * The repository was formatted in one commit (f981e77), and that commit is
 * listed in .git-blame-ignore-revs so `git blame` still points at the change
 * that wrote a line. From then on every file Prettier owns is held to it:
 * committed or not, changed or not.
 *
 * The gate used to check only the files a change touched. It skipped files
 * that were not yet committed, so fifteen new files drifted unseen, and a
 * pull request against `main` turned it into a check of every file anyway.
 * A gate that means the same thing everywhere cannot drift.
 *
 * What Prettier owns is decided by .prettierignore and .gitignore (Prettier
 * reads both): build output, uploads, lockfiles and the generated
 * 0001_baseline are out.
 *
 * Line endings are LF on every platform (.gitattributes), so a Windows
 * checkout is not a wall of false failures.
 */
const { spawnSync } = require('child_process');

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const X = '\x1b[0m';

function main() {
  console.log(`${D}Checking every file Prettier owns.${X}`);

  const result = spawnSync(
    process.execPath,
    [require.resolve('prettier/bin/prettier.cjs'), '--check', '--ignore-unknown', '.'],
    { stdio: 'inherit' },
  );

  if (result.status === 0) {
    console.log(`${G}Formatting is clean.${X}`);
    return 0;
  }

  console.error(
    `\n${R}Formatting${X}  Run: ${D}npm run format${X}  (prettier --write .)\n` +
      `${D}Then commit the result. Only formatting changes; nothing else moves.${X}`,
  );
  return 1;
}

process.exit(main());
