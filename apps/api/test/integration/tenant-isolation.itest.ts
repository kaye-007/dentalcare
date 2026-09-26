import { asTenant, closePools, errorCodeOf, owner, rawClient } from './db';
import { createOperatory, createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Tenant isolation, as app_user, against real policies.
 *
 * This is the property the whole product rests on, and the reason it has to
 * be tested here rather than in a unit test is that there is nothing in the
 * application to unit-test. The services deliberately do not filter by
 * tenant_id — `SELECT ... FROM patients` with no WHERE clause is the normal
 * shape — because the database is what scopes them. Mock the database and you
 * have mocked the entire security boundary.
 *
 * Every assertion below therefore runs through app_user, which is
 * NOSUPERUSER / NOBYPASSRLS. Run as the owner they would all still pass, and
 * they would keep passing after someone dropped every policy in the schema.
 */

let s: Scenario;

beforeAll(async () => {
  s = await createScenario();
});

afterAll(async () => {
  await destroyScenario(s);
  await closePools();
});

describe('reading across clinics', () => {
  it('clinic A sees its own patient', async () => {
    const rows = await asTenant(
      s.a.id,
      async (c) =>
        (await c.query('SELECT id FROM patients WHERE id = $1', [s.a.patientId])).rows,
    );

    expect(rows).toHaveLength(1);
  });

  it('clinic A cannot see clinic B’s patient, even by id', async () => {
    const rows = await asTenant(
      s.a.id,
      async (c) =>
        (await c.query('SELECT id FROM patients WHERE id = $1', [s.b.patientId])).rows,
    );

    expect(rows).toHaveLength(0);
  });

  it('clinic B sees its own patient and not A’s', async () => {
    const { own, other } = await asTenant(s.b.id, async (c) => ({
      own: (await c.query('SELECT id FROM patients WHERE id = $1', [s.b.patientId])).rows,
      other: (await c.query('SELECT id FROM patients WHERE id = $1', [s.a.patientId]))
        .rows,
    }));

    expect(own).toHaveLength(1);
    expect(other).toHaveLength(0);
  });

  /**
   * An unqualified SELECT is what the services actually issue. If the policy
   * were missing this returns both clinics' patients and nothing in the
   * application would notice.
   */
  it('an unfiltered SELECT returns only the current clinic', async () => {
    const rows = await asTenant(
      s.a.id,
      async (c) =>
        (
          await c.query<{ last_name: string }>(
            'SELECT last_name FROM patients WHERE last_name IN ($1, $2)',
            [s.a.patientLastName, s.b.patientLastName],
          )
        ).rows,
    );

    expect(rows.map((r) => r.last_name)).toEqual([s.a.patientLastName]);
  });

  it('users are scoped the same way', async () => {
    const rows = await asTenant(
      s.a.id,
      async (c) =>
        (
          await c.query<{ email: string }>(
            'SELECT email FROM users WHERE email IN ($1, $2)',
            [s.a.adminEmail, s.b.adminEmail],
          )
        ).rows,
    );

    expect(rows.map((r) => r.email)).toEqual([s.a.adminEmail]);
  });

  it('a clinic sees only its own tenants row', async () => {
    const rows = await asTenant(
      s.a.id,
      async (c) =>
        (await c.query<{ subdomain: string }>('SELECT subdomain FROM tenants')).rows,
    );

    expect(rows.map((r) => r.subdomain)).toEqual([s.a.subdomain]);
  });
});

describe('failing closed', () => {
  /**
   * The case that separates row-level security from a WHERE clause someone
   * forgot: what happens when no clinic has been established at all.
   *
   * There are two such states, and they behave differently. Both refuse, and
   * the test asserts what each actually does rather than the tidier story:
   *
   *   never set     current_setting(..., true) is NULL, NULL::uuid is NULL,
   *                 every policy compares false -> zero rows.
   *
   *   set, then     a transaction-local set_config reverts to the EMPTY
   *   released      STRING when the transaction ends, not to NULL. ''::uuid
   *                 does not parse, so the policy raises 22P02 instead of
   *                 filtering. Louder, and equally closed.
   *
   * The second is the state a pooled connection is in for the rest of its
   * life after serving one clinic request, so in a running API it is the
   * normal one. Nothing reaches it today — every tenant-table query goes
   * through withTenant(), and resolve_tenant() is SECURITY DEFINER — but a
   * future query on the tenant pool without a tenant would be a 500 rather
   * than an empty result. That is a robustness problem, not a leak: no
   * arrangement of this returns another clinic's rows.
   */
  it('a connection that never had a tenant returns zero rows', async () => {
    const client = await rawClient('app');
    try {
      const guc = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS v",
      );
      expect(guc.rows[0].v).toBeNull();

      const { rows } = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM patients',
      );
      expect(rows[0].n).toBe('0');
    } finally {
      await client.end();
    }
  });

  it('a released connection refuses rather than filtering', async () => {
    const client = await rawClient('app');
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant_id',
        s.a.id,
      ]);
      expect((await client.query('SELECT id FROM patients')).rows).toHaveLength(1);
      await client.query('COMMIT');

      // The setting is now '' — reverted, but not to NULL.
      const guc = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS v",
      );
      expect(guc.rows[0].v).toBe('');

      const code = await errorCodeOf(client.query('SELECT id FROM patients'));
      expect(code).toBe('22P02');
    } finally {
      await client.end();
    }
  });

  /**
   * The claim that matters, stated once over every tenant table rather than
   * one table at a time: with no clinic established, each either returns
   * nothing or refuses outright. Never a row.
   *
   * Each table gets its own connection, because a failed statement poisons
   * the rest of its transaction (25P02) and that would measure the first
   * failure repeatedly instead of each table independently.
   */
  it.each(['patients', 'users', 'invoices', 'appointments', 'payments'])(
    'yields no rows of any clinic from %s',
    async (table) => {
      const client = await rawClient('app');
      try {
        const result = await client
          .query(`SELECT id FROM ${table}`)
          .then((r) => ({ refused: false, rows: r.rows }))
          .catch((e: { code?: string }) => ({ refused: true, code: e.code }));

        if ('rows' in result) {
          expect(result.rows).toHaveLength(0);
        } else {
          expect(result.refused).toBe(true);
        }
      } finally {
        await client.end();
      }
    },
  );

  it('a garbage tenant id returns zero rows', async () => {
    const rows = await asTenant(
      '00000000-0000-0000-0000-000000000000',
      async (c) => (await c.query('SELECT id FROM patients')).rows,
    );

    expect(rows).toHaveLength(0);
  });

  /**
   * The context is transaction-local, so a pooled connection handed to the
   * next request cannot still be carrying the last clinic's identity. Getting
   * this wrong would show up as one clinic intermittently seeing another's
   * data under load — the worst possible failure to reproduce.
   */
  it('tenant context does not survive the transaction', async () => {
    const client = await rawClient('app');
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant_id',
        s.a.id,
      ]);
      await client.query('COMMIT');

      const { rows } = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS v",
      );
      expect(rows[0].v).not.toBe(s.a.id);
    } finally {
      await client.end();
    }
  });
});

describe('writing across clinics', () => {
  /**
   * WITH CHECK, not USING. A clinic could otherwise insert a row stamped with
   * another clinic's tenant_id — invisible to itself afterwards, and very
   * visible to the victim.
   */
  it('clinic A cannot insert a patient into clinic B', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO patients (tenant_id, first_name, last_name)
           VALUES ($1, 'Smuggled', 'Row')`,
          [s.b.id],
        ),
      ),
    );

    // 42501 is insufficient_privilege, which is what a WITH CHECK violation
    // raises: "new row violates row-level security policy".
    expect(code).toBe('42501');
  });

  it('clinic A cannot update clinic B’s patient', async () => {
    const updated = await asTenant(
      s.a.id,
      async (c) =>
        (
          await c.query('UPDATE patients SET first_name = $1 WHERE id = $2', [
            'Hijacked',
            s.b.patientId,
          ])
        ).rowCount,
    );
    expect(updated).toBe(0);

    // And the row is untouched, read back as the clinic that owns it.
    const { rows } = await owner().query<{ first_name: string }>(
      'SELECT first_name FROM patients WHERE id = $1',
      [s.b.patientId],
    );
    expect(rows[0].first_name).toBe('Test');
  });

  /**
   * Since 0004 no clinic can delete a patient at all — its own or anyone
   * else's — so that statement is refused before RLS is consulted. The RLS
   * property this test exists for is still worth proving on DELETE, so it is
   * proved on a table the runtime role may still delete from.
   */
  it('clinic A cannot delete clinic B’s rows', async () => {
    const roomB = await createOperatory(s.b);
    const deleted = await asTenant(
      s.a.id,
      async (c) => (await c.query('DELETE FROM operatories WHERE id = $1', [roomB])).rowCount,
    );
    expect(deleted).toBe(0);

    const { rows } = await owner().query('SELECT id FROM operatories WHERE id = $1', [roomB]);
    expect(rows).toHaveLength(1);
  });

  it('no clinic can delete a patient, its own included', async () => {
    for (const [tenant, patientId] of [
      [s.a.id, s.b.patientId],
      [s.a.id, s.a.patientId],
    ]) {
      const code = await errorCodeOf(
        asTenant(tenant, (c) => c.query('DELETE FROM patients WHERE id = $1', [patientId])),
      );
      expect(code).toBe('42501');
    }

    const { rows } = await owner().query(
      'SELECT id FROM patients WHERE id = ANY($1::uuid[])',
      [[s.a.patientId, s.b.patientId]],
    );
    expect(rows).toHaveLength(2);
  });

  /**
   * Re-stamping a row you legitimately hold is the same attack from the other
   * direction: move it into another clinic rather than reach into one.
   */
  it('clinic A cannot move its own patient into clinic B', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE patients SET tenant_id = $1 WHERE id = $2', [
          s.b.id,
          s.a.patientId,
        ]),
      ),
    );

    expect(code).toBe('42501');
  });
});

describe('the platform plane', () => {
  /**
   * The counterpart to everything above: the privileged connection is
   * supposed to see across clinics, because listing and suspending them is
   * what the console does. Isolation that also blocked the platform plane
   * would be a different bug, not a stronger guarantee.
   */
  it('sees both clinics', async () => {
    const { rows } = await owner().query<{ subdomain: string }>(
      'SELECT subdomain FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY subdomain',
      [[s.a.id, s.b.id]],
    );

    expect(rows.map((r) => r.subdomain).sort()).toEqual(
      [s.a.subdomain, s.b.subdomain].sort(),
    );
  });

  it('sees the patients of both clinics', async () => {
    const { rows } = await owner().query<{ last_name: string }>(
      'SELECT last_name FROM patients WHERE id = ANY($1::uuid[])',
      [[s.a.patientId, s.b.patientId]],
    );

    expect(rows).toHaveLength(2);
  });
});
