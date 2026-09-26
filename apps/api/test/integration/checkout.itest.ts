import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The dual-mode checkout (0015) and the role boundaries around it.
 *
 * Fiscalization is deliberately NOT configured for this clinic: that is the
 * state every clinic is in before it installs a certificate, and it is what
 * proves the important property — choosing the fiscal invoice still records
 * the money, and reports the registration failure separately.
 */

let api: TestApi;
let s: Scenario;
let admin: string;
let desk: string;
let books: string;
let tooth: string;

const A = (token: string, body?: unknown) => ({ token, subdomain: s.a.subdomain, body });

async function user(role: string, label: string): Promise<string> {
  const email = `${label}@${s.a.subdomain}.test`;
  await owner().query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
     VALUES ($1,$2,$3,$4,$5,'active')`,
    [s.a.id, email, await bcrypt.hash(s.password, 4), `${label} person`, role],
  );
  return (await login(api, s.a.subdomain, email, s.password)).accessToken;
}

async function invoice(items: { description: string; quantity: number; unitPrice: number; vatCategory?: string }[]) {
  const res = await call<{ id: string; total: number }>(api, 'POST', '/api/invoices', A(admin, {
    patientId: s.a.patientId,
    items,
  }));
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  await owner().query(
    `INSERT INTO clinic_settings (tenant_id, currency, vat_rate_bp) VALUES ($1, 'ALL', 2000)`,
    [s.a.id],
  );
  admin = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  desk = await user('receptionist', 'desk');
  books = await user('accountant', 'books');
  tooth = await user('dentist', 'tooth');
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('choosing the document at checkout', () => {
  it('defaults to the fiscal invoice, and says so in settings', async () => {
    const res = await call<{ defaultCheckoutMode: string; internalReceiptsEnabled: boolean }>(
      api, 'GET', '/api/settings', A(desk),
    );
    expect(res.body.defaultCheckoutMode).toBe('fiscal');
    expect(res.body.internalReceiptsEnabled).toBe(true);
  });

  it('records an internal receipt without going near the tax authority', async () => {
    const inv = await invoice([{ description: 'Mbushje kompozite', quantity: 1, unitPrice: 350_000 }]);
    const paid = await call<{ documentKind: string; paid: number; fiscal: unknown; fiscalError: unknown }>(
      api, 'POST', `/api/invoices/${inv.id}/payments`,
      A(desk, { amount: 350_000, method: 'cash', document: 'internal' }),
    );
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ documentKind: 'internal', paid: 350_000, fiscal: null, fiscalError: null });

    const rows = await ownerQuery<{ document_kind: string; chosen: string | null }>(
      'SELECT document_kind, document_chosen_by::text AS chosen FROM invoices WHERE id = $1',
      [inv.id],
    );
    expect(rows.rows[0]!.document_kind).toBe('internal');
    expect(rows.rows[0]!.chosen).toBeTruthy();
    const fiscal = await ownerQuery('SELECT 1 FROM fiscal_invoices WHERE invoice_id = $1', [inv.id]);
    expect(fiscal.rowCount).toBe(0);
  });

  /**
   * The money is the patient's fact; the registration is the clinic's. A
   * clinic with no certificate installed still takes the payment, and is told
   * plainly that the invoice is not registered.
   */
  it('keeps the payment when the fiscal invoice cannot be registered', async () => {
    const inv = await invoice([{ description: 'Heqje dhëmbi', quantity: 1, unitPrice: 400_000 }]);
    const paid = await call<{ documentKind: string; paid: number; status: string; fiscal: unknown; fiscalError: string }>(
      api, 'POST', `/api/invoices/${inv.id}/payments`,
      A(desk, { amount: 400_000, method: 'card', document: 'fiscal' }),
    );
    expect(paid.status).toBe(201);
    expect(paid.body.paid).toBe(400_000);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.documentKind).toBe('fiscal');
    expect(paid.body.fiscal).toBeNull();
    expect(paid.body.fiscalError).toMatch(/fiscaliz/i);

    // The payment is real, and the invoice carries the intent for the queue.
    const kept = await ownerQuery<{ n: string }>(
      'SELECT count(*) AS n FROM payments WHERE invoice_id = $1 AND voided_at IS NULL', [inv.id],
    );
    expect(Number(kept.rows[0]!.n)).toBe(1);
  });

  it('refuses an internal receipt when the clinic has turned them off', async () => {
    const off = await call(api, 'PATCH', '/api/settings', A(admin, { internalReceiptsEnabled: false }));
    expect(off.status).toBe(200);

    const inv = await invoice([{ description: 'Kontroll', quantity: 1, unitPrice: 150_000 }]);
    const refused = await call<{ code: string }>(api, 'POST', `/api/invoices/${inv.id}/payments`,
      A(desk, { amount: 150_000, method: 'cash', document: 'internal' }));
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('internal_receipts_disabled');

    await call(api, 'PATCH', '/api/settings', A(admin, { internalReceiptsEnabled: true }));
  });

  it('asks for a choice when the clinic preselects nothing', async () => {
    await call(api, 'PATCH', '/api/settings', A(admin, { defaultCheckoutMode: 'ask' }));
    const inv = await invoice([{ description: 'Kontroll', quantity: 1, unitPrice: 150_000 }]);
    const refused = await call<{ code: string }>(api, 'POST', `/api/invoices/${inv.id}/payments`,
      A(desk, { amount: 150_000, method: 'cash' }));
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('checkout_document_required');

    await call(api, 'PATCH', '/api/settings', A(admin, { defaultCheckoutMode: 'fiscal' }));
  });
});

describe('the fiscal queue', () => {
  it('is readable by the desk, the accountant and the administrator', async () => {
    for (const token of [desk, books, admin]) {
      const res = await call<{ items: unknown[]; counts: { pending: number } }>(api, 'GET', '/api/fiscal/queue', A(token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    }
  });

  it('is closed to the clinical roles', async () => {
    expect((await call(api, 'GET', '/api/fiscal/queue', A(tooth))).status).toBe(403);
  });

  it('lets the desk push one, and the accountant only read', async () => {
    const fake = '00000000-0000-4000-8000-000000000001';
    // Reception may push: the refusal is "no such registration", not a 403.
    expect((await call(api, 'POST', `/api/fiscal/queue/${fake}/retry`, A(desk))).status).toBe(404);
    expect((await call(api, 'POST', `/api/fiscal/queue/${fake}/retry`, A(books))).status).toBe(403);
  });
});

describe('TVSH reporting', () => {
  it('splits the period by rate, and by what the authority has seen', async () => {
    const cosmetic = await call<{ id: string }>(api, 'POST', '/api/treatments', A(admin, {
      name: 'Zbardhim dhëmbësh', price: 1_200_000, durationMinutes: 45, vatCategory: 'cosmetic',
    }));
    const inv = await invoice([
      { description: 'Zbardhim dhëmbësh', quantity: 1, unitPrice: 1_000_000, vatCategory: 'cosmetic' },
      { description: 'Kontroll', quantity: 1, unitPrice: 200_000, vatCategory: 'medical' },
    ]);
    expect(cosmetic.status).toBe(201);
    await call(api, 'POST', `/api/invoices/${inv.id}/payments`,
      A(desk, { amount: inv.total, method: 'cash', document: 'internal' }));

    const res = await call<{
      bands: { rateBp: number; net: number; vat: number }[];
      totals: { vat: number };
      documents: { documentKind: string; registered: boolean; invoices: number }[];
    }>(api, 'GET', '/api/reports/vat', A(books));
    expect(res.status).toBe(200);

    const standard = res.body.bands.find((b) => b.rateBp === 2000)!;
    expect(standard.net).toBe(1_000_000);
    expect(standard.vat).toBe(200_000);
    expect(res.body.bands.find((b) => b.rateBp === 0)!.vat).toBe(0);
    expect(res.body.totals.vat).toBe(200_000);

    const internal = res.body.documents.find((d) => d.documentKind === 'internal' && !d.registered)!;
    expect(internal.invoices).toBeGreaterThanOrEqual(1);
  });

  it('is for the accountant and the administrator, not the desk or the chair', async () => {
    expect((await call(api, 'GET', '/api/reports/vat', A(books))).status).toBe(200);
    expect((await call(api, 'GET', '/api/reports/vat', A(admin))).status).toBe(200);
    expect((await call(api, 'GET', '/api/reports/vat', A(desk))).status).toBe(403);
    expect((await call(api, 'GET', '/api/reports/vat', A(tooth))).status).toBe(403);
  });
});

describe('the role boundaries the desk and the chair work inside', () => {
  it('lets reception run the day but not the clinical record or the profit', async () => {
    expect((await call(api, 'GET', '/api/appointments', A(desk))).status).toBe(200);
    expect((await call(api, 'GET', '/api/patients', A(desk))).status).toBe(200);
    expect(
      (await call(api, 'POST', `/api/patients/${s.a.patientId}/chart/conditions`,
        A(desk, { tooth: 11, condition: 'caries' }))).status,
    ).toBe(403);
    expect((await call(api, 'GET', '/api/analytics/dashboard', A(desk))).status).toBe(403);
    expect((await call(api, 'GET', '/api/reports/overview', A(desk))).status).toBe(403);
  });

  it('lets the dentist treat but not touch money settings or wages', async () => {
    expect((await call(api, 'GET', `/api/patients/${s.a.patientId}/chart`, A(tooth))).status).toBe(200);
    expect((await call(api, 'PATCH', '/api/settings', A(tooth, { vatRateBp: 0 }))).status).toBe(403);
    expect((await call(api, 'GET', '/api/staff', A(tooth))).status).toBe(200);
    expect((await call(api, 'GET', '/api/staff/salary-payments', A(tooth))).status).toBe(403);
  });

  it('keeps the accountant in the books and out of the chart', async () => {
    expect((await call(api, 'GET', '/api/invoices', A(books))).status).toBe(200);
    expect((await call(api, 'GET', '/api/payments', A(books))).status).toBe(200);
    expect((await call(api, 'GET', '/api/expenses', A(books))).status).toBe(200);
    expect((await call(api, 'GET', `/api/patients/${s.a.patientId}/chart`, A(books))).status).toBe(403);
    expect((await call(api, 'POST', `/api/invoices/${s.a.patientId}/payments`, A(books, { amount: 1, method: 'cash' })))
      .status).toBe(403);
  });
});
