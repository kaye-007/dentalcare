/**
 * The credential shapes the secret scan refuses. Sample values are built at
 * run time so this file does not itself look like it holds one.
 */

const { scanText, isTrackedEnv } = require('./secret-scan') as {
  scanText: (text: string) => [number, string][];
  isTrackedEnv: (file: string) => boolean;
};

const hex = (n: number) => 'a1b2c3d4e5f6'.repeat(8).slice(0, n);
const alnum = (n: number) => 'Zx9Qw3Er7Ty1Ui5Op2As'.repeat(8).slice(0, n);
const names = (text: string) => scanText(text).map(([, what]) => what);

describe('scanText', () => {
  it.each([
    ['private key', `-----BEGIN ${'PRIVATE'} KEY-----`],
    ['AWS access key', `key = "AKIA${'ABCDEFGHIJKLMNOP'}"`],
    ['Twilio account SID or API key', `sid: 'AC${hex(32)}'`],
    ['Meta / WhatsApp access token', `token=EAA${alnum(60)}`],
    ['GitHub token', `ghp_${alnum(36)}`],
    ['Stripe live key', `sk_live_${alnum(24)}`],
    ['Google OAuth client secret', `GOCSPX-${alnum(28)}`],
    ['Google API key', `AIza${alnum(35)}`],
    ['JSON Web Token', `eyJ${alnum(20)}.eyJ${alnum(30)}.${alnum(43)}`],
  ])('finds a %s', (name, line) => {
    expect(names(line)).toContain(name);
  });

  it('finds a database URL with a real password to a real host', () => {
    const url = [
      'postgres://postgres:',
      'Hk29fjq8Lz',
      '@db.xyz123.supabase.co:5432/postgres',
    ];
    expect(names(url.join(''))).toEqual(['database URL with a password']);
  });

  it.each([
    'postgres://dentalcare:dentalcare@localhost:5432/dentalcare',
    'postgres://app_user:app_user_dev_pw@127.0.0.1:5432/dentalcare',
    'postgres://app_user:PASSWORD@db.PROJECT.supabase.co:5432/postgres',
    'postgres://u:p@db.example.com/x',
    'postgres://owner@host:5432/new_db',
    'postgres://dentalcare:pw@${host}:5432/x',
  ])('lets a local or placeholder URL through: %s', (line) => {
    expect(names(line)).toEqual([]);
  });

  it('reports the line', () => {
    expect(scanText(`one\ntwo\nsk_live_${alnum(20)}`)).toEqual([[3, 'Stripe live key']]);
  });

  it('leaves ordinary code alone', () => {
    expect(names("const token = request.headers.get('Idempotency-Key');")).toEqual([]);
    expect(names('A JWT is three base64url parts, eyJ… for the header.')).toEqual([]);
  });
});

describe('isTrackedEnv', () => {
  it.each(['.env', 'apps/api/.env', '.env.local', '.env.production'])(
    'refuses %s',
    (f) => {
      expect(isTrackedEnv(f)).toBe(true);
    },
  );

  it.each(['.env.example', '.env.production.example', 'src/environment.ts'])(
    'allows %s',
    (f) => {
      expect(isTrackedEnv(f)).toBe(false);
    },
  );
});
