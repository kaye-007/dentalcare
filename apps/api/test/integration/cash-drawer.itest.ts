import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { asTenant, closePools, errorCodeOf, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Foundations (0013) and the cash drawer (0014), against a real database and
 * the real API: the feature switch, idempotent payments, a whole shift from
 * float to approved variance, the chained event log, and the isolation and
 * append-only guarantees the evidence depends on.
 *
 * Fiscalization is not configured for the clinic, so no declaration reaches
 * the network; `declareForDrawer` answers `not_required`.
 */

let api: TestApi;
let s: Scenario;
let admin: string;
let desk: string;
let desk2: string;
let adminB: string;
let accountant: string;
let receptionistId: string;
let drawerId: string;
let sessionId: string;
let firstCashPaymentId: string;

const A = (token: string, body?: unknown, headers?: Record<string, string>) => ({
  token,
  subdomain: s.a.subdomain,
  body,
  headers,
});
const key = () => `k-${randomUUID()}`;

async function createUser(role: string, label: string): Promise<{ id: string; email: string }> {
  const email = `${label}@${s.a.subdomain}.test`;
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
     VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
    [s.a.id, email, await bcrypt.hash(s.password, 4), `${label} person`, role],
  );
  return { id: rows[0]!.id, email };
}

async function invoice(token: string, amount: number): Promise<string> {
  const res = await call<{ id: string }>(api, 'POST', '/api/invoices', A(token, {
    patientId: s.a.patientId,
    items: [{ description: 'Mbushje kompozite', quantity: 1, unitPrice: amount }],
  }));
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  await owner().query(`INSERT INTO clinic_settings (tenant_id, currency) VALUES ($1, 'ALL')`, [s.a.id]);
  await owner().query(`INSERT INTO clinic_settings (tenant_id, currency) VALUES ($1, 'ALL')`, [s.b.id]);

  const r = await createUser('receptionist', 'desk');
  receptionistId = r.id;
  const r2 = await createUser('receptionist', 'desk-two');
  const acc = await createUser('accountant', 'books');

  admin = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  desk = (await login(api, s.a.subdomain, r.email, s.password)).accessToken;
  desk2 = (await login(api, s.a.subdomain, r2.email, s.password)).accessToken;
  accountant = (await login(api, s.a.subdomain, acc.email, s.password)).accessToken;
  adminB = (await login(api, s.b.subdomain, s.b.adminEmail, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('the feature switch', () => {
  it('refuses drawer routes while the clinic has not turned the drawer on', async () => {
    const res = await call<{ code: string; state: string }>(api, 'GET', '/api/drawer/current', A(desk));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'feature_unavailable', state: 'disabled_by_clinic' });
  });

  it('lists the catalogue with legal obligations always on', async () => {
    const res = await call<{ key: string; state: string; alwaysOn: boolean }[]>(api, 'GET', '/api/features', A(desk));
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.map((f) => [f.key, f]));
    expect(byKey.cash_drawer).toMatchObject({ state: 'disabled_by_clinic', alwaysOn: false });
    expect(byKey.fiscalization).toMatchObject({ state: 'enabled', alwaysOn: true });
  });

  it('lets only the administrator switch it, and never a legal obligation', async () => {
    expect((await call(api, 'PATCH', '/api/features/cash_drawer', A(desk, { enabled: true }))).status).toBe(403);
    expect((await call(api, 'PATCH', '/api/features/fiscalization', A(admin, { enabled: false }))).status).toBe(400);
    const on = await call<{ key: string; state: string }[]>(api, 'PATCH', '/api/features/cash_drawer', A(admin, { enabled: true }));
    expect(on.status).toBe(200);
    expect(on.body.find((f) => f.key === 'cash_drawer')?.state).toBe('enabled');
  });

  it('records who switched it, with the request it came from', async () => {
    const rows = (
      await ownerQuery<{ request_id: string | null; ip: string | null; user_agent: string | null }>(
        `SELECT request_id, ip, user_agent FROM clinic_audit_log
          WHERE tenant_id = $1 AND action = 'features.updated' ORDER BY created_at DESC LIMIT 1`,
        [s.a.id],
      )
    ).rows;
    expect(rows[0]?.request_id).toBeTruthy();
    expect(rows[0]?.ip).toBeTruthy();
  });

  it('keeps a plan override above the clinic switch', async () => {
    // As the platform plane writes it: the owner role, inside a transaction
    // that names the clinic (FORCE binds the owner too).
    const client = await owner().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [s.b.id]);
      await client.query(
        `INSERT INTO tenant_entitlement_overrides (tenant_id, feature_key, value, reason)
         VALUES ($1, 'cash_drawer', 'false'::jsonb, 'integration test: withheld')`,
        [s.b.id],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const res = await call<{ code: string }>(api, 'PATCH', '/api/features/cash_drawer', {
      token: adminB, subdomain: s.b.subdomain, body: { enabled: true },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('feature_not_in_plan');
  });
});

describe('setting up drawers', () => {
  it('saves the clinic policy', async () => {
    const res = await call<{ blindCount: boolean; defaultFloat: Record<string, number> }>(
      api, 'PUT', '/api/drawer/policy',
      A(admin, {
        blindCount: true,
        maxRecounts: 1,
        thresholds: { ALL: { tolerance: 10_000, approval: 200_000 } },
        defaultFloat: { ALL: 1_000_000 },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.defaultFloat.ALL).toBe(1_000_000);
  });

  it('refuses a threshold below its tolerance', async () => {
    const res = await call(api, 'PUT', '/api/drawer/policy', A(admin, {
      thresholds: { ALL: { tolerance: 500, approval: 100 } },
    }));
    expect(res.status).toBe(400);
  });

  it('creates a drawer for administrators only, holding the clinic currency', async () => {
    expect((await call(api, 'POST', '/api/drawer/drawers', A(desk, { name: 'Nope', currencies: ['ALL'] }))).status).toBe(403);
    expect((await call(api, 'POST', '/api/drawer/drawers', A(admin, { name: 'Euro only', currencies: ['EUR'] }))).status).toBe(400);
    const res = await call<{ id: string }>(api, 'POST', '/api/drawer/drawers', A(admin, {
      name: 'Front desk', currencies: ['ALL', 'EUR'],
    }));
    expect(res.status).toBe(201);
    drawerId = res.body.id;
  });

  it('refuses a float whose notes and coins do not add up to it', async () => {
    const back = await call<{ id: string }>(api, 'POST', '/api/drawer/drawers', A(admin, { name: 'Back office', currencies: ['ALL'] }));
    const res = await call(api, 'POST', '/api/drawer/sessions', A(admin, {
      drawerId: back.body.id,
      floats: [{ currency: 'ALL', amount: 1_000_000, denominations: { '500000': 1 } }],
    }));
    expect(res.status).toBe(400);
    const opened = (await ownerQuery('SELECT 1 FROM drawer_sessions WHERE drawer_id = $1', [back.body.id])).rowCount;
    expect(opened).toBe(0);
  });
});

describe('a shift', () => {
  it('refuses a cash payment while no drawer is open, and still takes a card', async () => {
    const inv = await invoice(admin, 300_000);
    const cash = await call<{ code: string }>(api, 'POST', `/api/invoices/${inv}/payments`, A(desk, { amount: 100_000, method: 'cash' }));
    expect(cash.status).toBe(409);
    expect(cash.body.code).toBe('drawer_not_open');
    const card = await call(api, 'POST', `/api/invoices/${inv}/payments`, A(desk, { amount: 100_000, method: 'card' }));
    expect(card.status).toBe(201);
  });

  it('opens with a counted float, hiding the expected total in blind mode', async () => {
    const res = await call<{ id: string; status: string; expected: unknown; fiscalDeclaration: { status: string } }>(
      api, 'POST', '/api/drawer/sessions',
      A(desk, {
        drawerId,
        floats: [
          { currency: 'ALL', amount: 1_000_000, denominations: { '1000000': 1 } },
          { currency: 'EUR', amount: 10_000, denominations: { '5000': 2 } },
        ],
      }, { 'Idempotency-Key': key() }),
    );
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.expected).toBeNull();
    expect(res.body.fiscalDeclaration.status).toBe('not_required');
    sessionId = res.body.id;
  });

  it('opens a drawer only once at a time', async () => {
    const again = await call<{ code: string }>(api, 'POST', '/api/drawer/sessions', A(desk, { drawerId }));
    expect(again.body.code).toBe('drawer_in_use');
    const other = await call<{ code: string }>(api, 'POST', '/api/drawer/sessions', A(admin, { drawerId }));
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('drawer_in_use');
  });

  it('takes a colleague cash payment into the shared drawer, exactly once', async () => {
    const inv = await invoice(admin, 850_000);
    const k = key();
    // desk2 did not open the drawer; the cash still goes into it.
    const first = await call<{ status: string }>(api, 'POST', `/api/invoices/${inv}/payments`,
      A(desk2, { amount: 850_000, method: 'cash' }, { 'Idempotency-Key': k }));
    const replay = await call<{ status: string }>(api, 'POST', `/api/invoices/${inv}/payments`,
      A(desk2, { amount: 850_000, method: 'cash' }, { 'Idempotency-Key': k }));
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);

    const payments = (await ownerQuery<{ id: string; drawer_session_id: string }>(
      'SELECT id, drawer_session_id FROM payments WHERE invoice_id = $1', [inv],
    )).rows;
    expect(payments).toHaveLength(1);
    expect(payments[0]!.drawer_session_id).toBe(sessionId);
    firstCashPaymentId = payments[0]!.id;

    const different = await call<{ code: string }>(api, 'POST', `/api/invoices/${inv}/payments`,
      A(desk2, { amount: 1, method: 'cash' }, { 'Idempotency-Key': k }));
    expect(different.status).toBe(422);
    expect(different.body.code).toBe('idempotency_key_reused');
  });

  it('drops cash to the safe, but not more than the drawer holds', async () => {
    const ok = await call(api, 'POST', `/api/drawer/sessions/${sessionId}/drops`, A(desk, { currency: 'ALL', amount: 500_000 }));
    expect(ok.status).toBe(201);
    const tooMuch = await call(api, 'POST', `/api/drawer/sessions/${sessionId}/drops`, A(desk, { currency: 'ALL', amount: 50_000_000 }));
    expect(tooMuch.status).toBe(400);
  });

  it('pays out only with a manager PIN that is right', async () => {
    const unapproved = await call<{ code: string }>(api, 'POST', `/api/drawer/sessions/${sessionId}/payouts`,
      A(desk, { currency: 'ALL', amount: 50_000, reason: 'Courier for lab work' }));
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.code).toBe('approval_required');

    const pin = await call(api, 'PUT', '/api/drawer/approval-pin', A(admin, { currentPassword: s.password, pin: '4821' }));
    expect(pin.status).toBe(200);
    expect((await call(api, 'PUT', '/api/drawer/approval-pin', A(desk, { currentPassword: s.password, pin: '1111' }))).status).toBe(403);

    const wrong = await call<{ code: string }>(api, 'POST', `/api/drawer/sessions/${sessionId}/payouts`,
      A(desk, { currency: 'ALL', amount: 50_000, reason: 'Courier for lab work', approval: { approverUserId: s.a.adminId, pin: '0000' } }));
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('approval_wrong');
    const attempts = (await ownerQuery<{ n: number }>('SELECT approval_pin_failed_attempts AS n FROM users WHERE id = $1', [s.a.adminId])).rows[0];
    expect(attempts?.n).toBe(1);

    const approved = await call(api, 'POST', `/api/drawer/sessions/${sessionId}/payouts`,
      A(desk, { currency: 'ALL', amount: 50_000, reason: 'Courier for lab work', approval: { approverUserId: s.a.adminId, pin: '4821' } }));
    expect(approved.status).toBe(201);
  });

  it('takes a voided cash payment back off the drawer while it is open', async () => {
    const inv = await invoice(admin, 200_000);
    const paid = await call(api, 'POST', `/api/invoices/${inv}/payments`, A(desk, { amount: 200_000, method: 'cash' }));
    expect(paid.status).toBe(201);
    const pay = (await ownerQuery<{ id: string }>('SELECT id FROM payments WHERE invoice_id = $1', [inv])).rows[0]!;
    const voided = await call(api, 'POST', `/api/payments/${pay.id}/void`, A(desk, { reason: 'Patient paid by card instead' }));
    expect(voided.status).toBe(201);
    const types = (await ownerQuery<{ type: string }>('SELECT type FROM drawer_events WHERE session_id = $1 ORDER BY seq', [sessionId])).rows.map((r) => r.type);
    expect(types).toEqual(['open', 'open', 'cash_sale', 'drop', 'payout', 'cash_sale', 'cash_sale_voided']);
  });

  it('refuses cash while counting, and lets the receptionist go back before counting', async () => {
    const start = await call<{ session: { status: string } }>(api, 'POST', `/api/drawer/sessions/${sessionId}/count/start`, A(desk));
    expect(start.status).toBe(201);
    expect(start.body.session.status).toBe('counting');

    const inv = await invoice(admin, 100_000);
    const cash = await call<{ code: string }>(api, 'POST', `/api/invoices/${inv}/payments`, A(desk, { amount: 100_000, method: 'cash' }));
    expect(cash.body.code).toBe('drawer_counting');

    const back = await call<{ status: string }>(api, 'POST', `/api/drawer/sessions/${sessionId}/count/cancel`, A(desk));
    expect(back.body.status).toBe('open');
    await call(api, 'POST', `/api/drawer/sessions/${sessionId}/count/start`, A(desk));
  });

  it('reveals expected cash only once the count is in, and allows one recount', async () => {
    const before = await call<{ expected: unknown }>(api, 'GET', `/api/drawer/sessions/${sessionId}`, A(desk));
    expect(before.body.expected).toBeNull();

    // Expected ALL: 1,000,000 float + 850,000 sale − 500,000 drop − 50,000 payout = 1,300,000.
    const first = await call<{ attempt: number; recountsLeft: number; lines: { currency: string; expected: number; variance: number; band: string }[] }>(
      api, 'POST', `/api/drawer/sessions/${sessionId}/counts`,
      A(desk, { counts: [
        { currency: 'ALL', denominations: { '1000000': 1, '200000': 1, '50000': 1 } },
        { currency: 'EUR', denominations: { '5000': 2 } },
      ] }),
    );
    expect(first.status).toBe(201);
    const all = first.body.lines.find((l) => l.currency === 'ALL')!;
    expect(all).toMatchObject({ expected: 1_300_000, variance: -50_000, band: 'note' });
    expect(first.body.recountsLeft).toBe(1);

    const second = await call<{ attempt: number; lines: { currency: string; band: string; variance: number }[] }>(
      api, 'POST', `/api/drawer/sessions/${sessionId}/counts`,
      A(desk, { counts: [
        { currency: 'ALL', denominations: { '1000000': 1 } },
        { currency: 'EUR', denominations: { '5000': 2 } },
      ] }),
    );
    expect(second.body.attempt).toBe(2);
    expect(second.body.lines.find((l) => l.currency === 'ALL')).toMatchObject({ variance: -300_000, band: 'approval' });

    const third = await call<{ code: string }>(api, 'POST', `/api/drawer/sessions/${sessionId}/counts`,
      A(desk, { counts: [{ currency: 'ALL', denominations: {} }, { currency: 'EUR', denominations: {} }] }));
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('no_recounts_left');
  });

  it('will not return to taking cash once counted', async () => {
    const back = await call<{ code: string }>(api, 'POST', `/api/drawer/sessions/${sessionId}/count/cancel`, A(desk));
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('drawer_counted');
  });

  it('makes leaving unpaid invoices and a large shortage deliberate', async () => {
    await invoice(desk, 120_000);
    const unacknowledged = await call<{ code: string }>(api, 'POST', `/api/drawer/sessions/${sessionId}/close`,
      A(desk, { notes: { ALL: 'Counted twice, still short' } }));
    expect(unacknowledged.status).toBe(409);
    expect(unacknowledged.body.code).toBe('open_invoices');

    const noNote = await call<{ code: string }>(api, 'POST', `/api/drawer/sessions/${sessionId}/close`,
      A(desk, { acknowledgeOpenInvoices: true }));
    expect(noNote.status).toBe(400);
    expect(noNote.body.code).toBe('variance_note_required');

    // Closed by the colleague who did not open it: the drawer is the desk's.
    const closed = await call<{ status: string; closedBy: unknown; reviews: { currency: string; band: string }[] }>(
      api, 'POST', `/api/drawer/sessions/${sessionId}/close`,
      A(desk2, { acknowledgeOpenInvoices: true, notes: { ALL: 'Counted twice, still short' }, cardBatchTotal: 100_000 }, { 'Idempotency-Key': key() }),
    );
    expect(closed.status).toBe(201);
    expect(closed.body.status).toBe('pending_approval');
    expect(closed.body.reviews.find((r) => r.currency === 'ALL')?.band).toBe('approval');
  });

  it('is approved by the administrator, never by the receptionist herself', async () => {
    const byDesk = await call(api, 'POST', `/api/drawer/sessions/${sessionId}/approve`, A(desk, { reason: 'fine' }));
    expect(byDesk.status).toBe(403);
    const asDeskPin = await call<{ code: string }>(api, 'POST', `/api/drawer/sessions/${sessionId}/approve-with-pin`,
      A(desk, { approverUserId: receptionistId, pin: '1234', reason: 'fine' }));
    expect(asDeskPin.body.code).toBe('approval_not_approver');

    const approved = await call<{ status: string; approvals: { action: string; selfApproved: boolean }[] }>(
      api, 'POST', `/api/drawer/sessions/${sessionId}/approve`, A(admin, { reason: 'Recount by manager confirmed the shortage' }));
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('closed');
    expect(approved.body.approvals.find((a) => a.action === 'drawer_variance')?.selfApproved).toBe(false);
  });

  it('notes a void after close against the session without changing its review', async () => {
    const voided = await call(api, 'POST', `/api/payments/${firstCashPaymentId}/void`, A(desk, { reason: 'Invoice raised twice' }));
    expect(voided.status).toBe(201);
    const list = await call<{ id: string; status: string; voidedAfterClose: boolean }[]>(api, 'GET', '/api/drawer/sessions', A(admin));
    const row = list.body.find((r) => r.id === sessionId)!;
    expect(row).toMatchObject({ status: 'closed', voidedAfterClose: true });
  });
});

describe('the evidence', () => {
  it('shows oversight a verified chain, and finds a tampered event', async () => {
    const intact = await call<{ chain: { valid: boolean } }>(api, 'GET', `/api/drawer/sessions/${sessionId}`, A(admin));
    expect(intact.body.chain).toEqual({ valid: true });

    const client = await owner().connect();
    try {
      await client.query('ALTER TABLE drawer_events DISABLE TRIGGER drawer_events_no_rewrite');
      await client.query('UPDATE drawer_events SET amount = amount + 1 WHERE session_id = $1 AND seq = 3', [sessionId]);
      await client.query('ALTER TABLE drawer_events ENABLE TRIGGER drawer_events_no_rewrite');
    } finally {
      client.release();
    }
    const broken = await call<{ chain: { valid: boolean; brokenAtSeq: number } }>(api, 'GET', `/api/drawer/sessions/${sessionId}`, A(admin));
    expect(broken.body.chain).toEqual({ valid: false, brokenAtSeq: 3 });
  });

  it('cannot be rewritten or removed by the runtime role', async () => {
    for (const table of ['drawer_events', 'drawer_counts', 'drawer_session_reviews', 'manager_approvals']) {
      expect(await errorCodeOf(asTenant(s.a.id, (c) => c.query(`UPDATE ${table} SET tenant_id = tenant_id`)))).toBe('42501');
      expect(await errorCodeOf(asTenant(s.a.id, (c) => c.query(`DELETE FROM ${table}`)))).toBe('42501');
    }
    expect(await errorCodeOf(asTenant(s.a.id, (c) => c.query('DELETE FROM drawer_sessions')))).toBe('42501');
  });

  it('refuses to move a closed session backwards', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) => c.query(`UPDATE drawer_sessions SET status = 'open' WHERE id = $1`, [sessionId])),
    );
    expect(code).toBe('23514');
  });

  it('is invisible to another clinic', async () => {
    const rows = await asTenant(s.b.id, async (c) =>
      (await c.query('SELECT count(*)::int AS n FROM drawer_events WHERE session_id = $1', [sessionId])).rows[0].n,
    );
    expect(rows).toBe(0);
  });

  it('lets the accountant read the reports and nothing clinical', async () => {
    expect((await call(api, 'GET', '/api/drawer/sessions', A(accountant))).status).toBe(200);
    expect((await call(api, 'GET', `/api/drawer/sessions/${sessionId}`, A(accountant))).status).toBe(200);
    expect((await call(api, 'POST', '/api/drawer/sessions', A(accountant, { drawerId }))).status).toBe(403);
    expect((await call(api, 'GET', '/api/patients', A(accountant))).status).toBe(403);
  });
});

describe('switching the drawer off', () => {
  it('waits for open sessions, which the sole administrator may force-close', async () => {
    const opened = await call<{ id: string }>(api, 'POST', '/api/drawer/sessions', A(admin, { drawerId }));
    expect(opened.status).toBe(201);

    const refused = await call<{ code: string }>(api, 'PATCH', '/api/features/cash_drawer', A(admin, { enabled: false }));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('feature_in_use');

    const forced = await call<{ status: string; approvals: { selfApproved: boolean }[] }>(
      api, 'POST', `/api/drawer/sessions/${opened.body.id}/force-close`,
      A(admin, { counts: [{ currency: 'ALL', denominations: { '1000000': 1 } }, { currency: 'EUR', denominations: {} }], reason: 'End of test day, counted by owner' }),
    );
    expect(forced.status).toBe(201);
    expect(forced.body.status).toBe('force_closed');
    expect(forced.body.approvals[0]?.selfApproved).toBe(true);

    const off = await call(api, 'PATCH', '/api/features/cash_drawer', A(admin, { enabled: false }));
    expect(off.status).toBe(200);
    // With the drawer off, cash is taken as before.
    const inv = await invoice(admin, 50_000);
    expect((await call(api, 'POST', `/api/invoices/${inv}/payments`, A(desk, { amount: 50_000, method: 'cash' }))).status).toBe(201);
  });
});

describe('the simple day', () => {
  it('asks which drawer when the clinic still runs several', async () => {
    const on = await call(api, 'PATCH', '/api/features/cash_drawer', A(admin, { enabled: true }));
    expect(on.status).toBe(200);
    const res = await call<{ code: string }>(api, 'POST', '/api/drawer/sessions', A(desk, {}));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('drawer_choose');
  });

  it('opens without any setup, creating the drawer on first use', async () => {
    const drawers = await call<{ id: string }[]>(api, 'GET', '/api/drawer/drawers', A(admin));
    for (const d of drawers.body) {
      expect((await call(api, 'PATCH', `/api/drawer/drawers/${d.id}`, A(admin, { isActive: false }))).status).toBe(200);
    }
    const before = await call<{ session: unknown; drawers: unknown[] }>(api, 'GET', '/api/drawer/current', A(desk));
    expect(before.body).toMatchObject({ session: null, drawers: [] });

    const opened = await call<{ id: string; drawer: { name: string }; status: string }>(
      api, 'POST', '/api/drawer/sessions',
      A(desk, { floats: [{ currency: 'ALL', amount: 400_000 }] }, { 'Idempotency-Key': key() }),
    );
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ status: 'open', drawer: { name: 'Cash drawer' } });

    // Everyone at the desk sees the same open drawer.
    const seen = await call<{ session: { id: string } | null }>(api, 'GET', '/api/drawer/current', A(desk2));
    expect(seen.body.session?.id).toBe(opened.body.id);
    sessionId = opened.body.id;
  });

  it('closes on a typed total, and starts the next day from it', async () => {
    const inv = await invoice(admin, 150_000);
    expect((await call(api, 'POST', `/api/invoices/${inv}/payments`, A(desk2, { amount: 150_000, method: 'cash' }))).status).toBe(201);

    await call(api, 'POST', `/api/drawer/sessions/${sessionId}/count/start`, A(desk2));
    const both = await call(api, 'POST', `/api/drawer/sessions/${sessionId}/counts`,
      A(desk2, { counts: [{ currency: 'ALL', total: 550_000, denominations: { '500000': 1 } }] }));
    expect(both.status).toBe(400);

    const counted = await call<{ lines: { expected: number; variance: number; band: string }[] }>(
      api, 'POST', `/api/drawer/sessions/${sessionId}/counts`,
      A(desk2, { counts: [{ currency: 'ALL', total: 550_000 }] }),
    );
    expect(counted.status).toBe(201);
    expect(counted.body.lines[0]).toMatchObject({ expected: 550_000, variance: 0, band: 'exact' });

    const closed = await call<{ status: string }>(api, 'POST', `/api/drawer/sessions/${sessionId}/close`,
      A(desk2, { acknowledgeOpenInvoices: true }, { 'Idempotency-Key': key() }));
    expect(closed.status).toBe(201);
    expect(closed.body.status).toBe('closed');

    const next = await call<{ session: unknown; suggestedFloat: number; currency: string }>(api, 'GET', '/api/drawer/current', A(desk));
    expect(next.body).toMatchObject({ session: null, suggestedFloat: 550_000, currency: 'ALL' });
  });
});
