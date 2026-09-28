/**
 * No credential in the repository.
 *
 *   npm run secrets:check
 *
 * Every file git holds or would add (tracked, and untracked but not
 * ignored: the set the format gate checks) is scanned for credentials that
 * give themselves away by their shape: private keys, cloud and provider keys,
 * tokens, and database URLs carrying a real password to a real host. A match
 * fails the build unless its file is in ALLOWED below, with the reason it is
 * not a secret. A tracked .env fails too; only the .example templates may be
 * committed.
 *
 * This catches the accident: a key pasted into a test, a .env committed by
 * mistake. It cannot know a secret that has no shape, which is why secrets
 * live in `wrangler secret put` and the host's environment, never in files.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

/** [name, pattern]. Each pattern matches the credential, not its context. */
const PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Twilio account SID or API key', /\b(?:AC|SK)[0-9a-f]{32}\b/],
  ['Meta / WhatsApp access token', /\bEAA[A-Za-z0-9]{40,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  [
    'JSON Web Token',
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/,
  ],
];

/** postgres://user:password@host, where both look real. */
const DB_URL = /postgres(?:ql)?:\/\/[^:@/\s'"`]+:([^@\s'"`]+)@([^/:\s'"`]+)/g;
const PLACEHOLDER_PASSWORD =
  /^(?:p|pw|x|pass|password|PASSWORD|secret|changeme|CHANGE_ME|\*+|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+)$/;
const LOCAL_OR_PLACEHOLDER_HOST =
  /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|postgres|host\.docker\.internal|\$\{.*|<.*)$|PROJECT|HOST|example\.(?:com|org|net)/;

/**
 * Files whose matches are known not to be secrets. A path or a directory
 * prefix, and why. Adding to this list is a decision made in review.
 */
const ALLOWED = {
  'apps/api/src/modules/clinic/fiscalization/__fixtures__/':
    'throwaway self-signed test certificates and keys; they sign nothing real (fiscal-crypto.spec)',
  'apps/api/src/modules/clinic/fiscalization/fiscal-crypto.spec.ts':
    'a four-character fake key, testing that an encrypted key is refused',
  'apps/tenant-web/src/components/settings/FiscalCard.tsx':
    'the placeholder text of the certificate field',
  'scripts/secret-scan.js': 'the patterns themselves',
};

/** Every problem in one file's text: [line number, what]. */
function scanText(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) found.push([i + 1, name]);
    for (const m of line.matchAll(DB_URL)) {
      if (!PLACEHOLDER_PASSWORD.test(m[1]) && !LOCAL_OR_PLACEHOLDER_HOST.test(m[2])) {
        found.push([i + 1, 'database URL with a password']);
      }
    }
  });
  return found;
}

const allowed = (file) =>
  Object.keys(ALLOWED).some((p) => file === p || file.startsWith(p));
const isTrackedEnv = (file) =>
  /(^|\/)\.env(\.[^/]*)?$/.test(file) && !file.endsWith('.example');

function main() {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);

  const problems = [];
  for (const file of files) {
    if (isTrackedEnv(file))
      problems.push(`${file}: an environment file (only *.example belong in git)`);
    if (allowed(file) || !fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue; // binary
    for (const [line, what] of scanText(buf.toString('utf8'))) {
      problems.push(`${file}:${line}: ${what}`);
    }
  }

  if (problems.length) {
    console.error(`\x1b[31mPossible secrets\x1b[0m in ${problems.length} place(s):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      '\nRemove them and rotate anything real. A match that is not a secret goes in ALLOWED in scripts/secret-scan.js, with the reason.',
    );
    return 1;
  }
  console.log(`\x1b[32mNo secrets\x1b[0m in ${files.length} files.`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { scanText, isTrackedEnv };
