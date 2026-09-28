/**
 * The pure parts of the backup and restore checks. The rest runs against a
 * real database, in the restore drill (docs/DEPLOYMENT.md).
 */

// Plain CommonJS used by node scripts; required, like guard.js.
const {
  normaliseSchema,
  compareFacts,
  describe: where,
} = require('./pg-tools') as {
  normaliseSchema: (dump: string) => string;
  compareFacts: (
    expected: { migration: string | null; tables: Record<string, number> },
    actual: { migration: string | null; tables: Record<string, number> },
  ) => string[];
  describe: (url: string) => string;
};

describe('normaliseSchema', () => {
  it('keeps the statements and drops what differs between two dumps of one schema', () => {
    const dump = [
      '--',
      '-- PostgreSQL database dump',
      '--',
      '\\restrict 3Xk9s0dfPq',
      'SET statement_timeout = 0;',
      "SELECT pg_catalog.set_config('search_path', '', false);",
      '',
      'CREATE TABLE public.patients (',
      '    id uuid NOT NULL',
      ');',
      '\\unrestrict 3Xk9s0dfPq',
    ].join('\n');
    expect(normaliseSchema(dump)).toBe(
      ['CREATE TABLE public.patients (', '    id uuid NOT NULL', ');'].join('\n'),
    );
  });

  it('does not hide a real difference', () => {
    expect(normaliseSchema('CREATE TABLE a (x int);')).not.toBe(
      normaliseSchema('CREATE TABLE a (x bigint);'),
    );
  });
});

describe('compareFacts', () => {
  const expected = {
    migration: '0025_auth_hardening',
    tables: { patients: 300, invoices: 12 },
  };

  it('finds nothing when everything came back', () => {
    expect(
      compareFacts(expected, { ...expected, tables: { ...expected.tables } }),
    ).toEqual([]);
  });

  it('names each difference', () => {
    expect(
      compareFacts(expected, {
        migration: '0024_money_idempotency',
        tables: { patients: 299, extra: 1 },
      }),
    ).toEqual([
      'last migration: 0024_money_idempotency, expected 0025_auth_hardening',
      'extra: not in the backup',
      'invoices: missing',
      'patients: 299 rows, expected 300',
    ]);
  });
});

describe('describe', () => {
  it('never prints the credentials', () => {
    expect(where('postgres://owner:s3cret@db.example.com:6543/dentalcare')).toBe(
      'db.example.com:6543/dentalcare',
    );
  });
});
