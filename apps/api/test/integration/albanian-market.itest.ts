import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, login, startApi, TestApi } from './api';
import { closePools, errorCodeOf, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The Albanian-market pass (0012), against a real database and the real API:
 * TVSH on invoices, patient messages and their conversation view, estimates
 * in a second currency, the .p12 certificate upload, identity documents.
 *
 * No provider is configured here, so messages go to the internal log or are
 * handed off; the delivery pipeline itself is covered by
 * reminders-delivery.itest.ts. The exchange rate is the clinic's fixed rate,
 * so nothing reaches the network.
 */

let api: TestApi;
let s: Scenario;
let tokenA: string;
let tokenB: string;
let appointmentId: string;

const as = (token: string, subdomain: string, body?: unknown) => ({
  token,
  subdomain,
  body,
});
const rowsOf = async <T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
) => (await ownerQuery<T>(text, params)).rows;
const A = (body?: unknown) => as(tokenA, s.a.subdomain, body);

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  await owner().query(
    `INSERT INTO clinic_settings
       (tenant_id, currency, vat_rate_bp, phone, reminder_locale, quote_currency, fx_rate_source, fx_fixed_rate)
     VALUES ($1, 'ALL', 2000, '+355 4 222 3333', 'sq', 'EUR', 'fixed', 100)`,
    [s.a.id],
  );
  await owner().query(`UPDATE patients SET phone = '069 123 4567' WHERE id = $1`, [
    s.a.patientId,
  ]);
  const appt = await owner().query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, patient_id, starts_at, ends_at, reason, status)
     VALUES ($1, $2, now() + interval '2 days', now() + interval '2 days 30 minutes', 'Check-up', 'scheduled')
     RETURNING id`,
    [s.a.id, s.a.patientId],
  );
  appointmentId = appt.rows[0]!.id;
  tokenA = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  tokenB = (await login(api, s.b.subdomain, s.b.adminEmail, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('TVSH', () => {
  let cosmeticId: string;
  let medicalId: string;

  it('keeps a TVSH category on each treatment', async () => {
    const cosmetic = await call<{ id: string; vatCategory: string }>(
      api,
      'POST',
      '/api/treatments',
      A({
        name: 'Zbardhim dhëmbësh',
        price: 1_000_000,
        durationMinutes: 60,
        vatCategory: 'cosmetic',
      }),
    );
    const medical = await call<{ id: string; vatCategory: string }>(
      api,
      'POST',
      '/api/treatments',
      A({
        name: 'Mbushje kompozite',
        price: 500_000,
        durationMinutes: 45,
      }),
    );
    expect(cosmetic.status).toBe(201);
    expect(cosmetic.body.vatCategory).toBe('cosmetic');
    expect(medical.body.vatCategory).toBe('medical');
    cosmeticId = cosmetic.body.id;
    medicalId = medical.body.id;
  });

  it('charges TVSH on cosmetic work billed directly, and none on medical work', async () => {
    const res = await call<{ id: string; total: number }>(
      api,
      'POST',
      '/api/invoices',
      A({
        patientId: s.a.patientId,
        items: [
          {
            treatmentId: cosmeticId,
            description: 'Zbardhim dhëmbësh',
            quantity: 1,
            unitPrice: 1_000_000,
          },
          {
            treatmentId: medicalId,
            description: 'Mbushje kompozite',
            quantity: 2,
            unitPrice: 500_000,
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    // 10 000 L cosmetic + 20% = 12 000 L; 2 × 5 000 L medical, exempt.
    expect(res.body.total).toBe(2_200_000);

    const detail = await call<{
      taxAmount: number;
      items: { taxRateBp: number; taxAmount: number; amount: number }[];
    }>(api, 'GET', `/api/invoices/${res.body.id}`, A());
    expect(detail.body.taxAmount).toBe(200_000);
    expect(detail.body.items.map((i) => [i.taxRateBp, i.taxAmount, i.amount])).toEqual([
      [2000, 200_000, 1_200_000],
      [0, 0, 1_000_000],
    ]);
  });

  it('lets a custom line be marked cosmetic', async () => {
    const res = await call<{ total: number }>(
      api,
      'POST',
      '/api/invoices',
      A({
        patientId: s.a.patientId,
        items: [
          {
            description: 'Faseta estetike',
            quantity: 1,
            unitPrice: 300_000,
            vatCategory: 'cosmetic',
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(360_000);
  });
});

describe('patient messages', () => {
  const path = () => `/api/patients/${s.a.patientId}/messages`;

  it('shows the conversation with what the composer needs', async () => {
    const res = await call<{
      patient: { e164: string | null };
      messages: unknown[];
      context: { upcoming: { id: string }[]; balance: number; balanceText: string };
      channels: { sms: boolean };
    }>(api, 'GET', path(), A());
    expect(res.status).toBe(200);
    expect(res.body.patient.e164).toBe('+355691234567');
    expect(res.body.messages).toEqual([]);
    expect(res.body.context.upcoming.map((a) => a.id)).toEqual([appointmentId]);
    expect(res.body.context.balance).toBe(2_560_000);
    expect(res.body.channels.sms).toBe(false);

    const logged = await rowsOf<{ n: string }>(
      `SELECT count(*)::text AS n FROM patient_access_log WHERE patient_id = $1 AND resource = 'messages'`,
      [s.a.patientId],
    );
    expect(Number(logged[0]!.n)).toBeGreaterThan(0);
  });

  it('records an appointment reminder in Albanian', async () => {
    const res = await call<{
      message: {
        status: string;
        purpose: string;
        message: string;
        appointmentId: string;
        sentByName: string;
      };
    }>(
      api,
      'POST',
      path(),
      A({ purpose: 'appointment_reminder', channel: 'log', appointmentId }),
    );
    expect(res.status).toBe(201);
    expect(res.body.message.status).toBe('sent');
    expect(res.body.message.purpose).toBe('appointment_reminder');
    expect(res.body.message.appointmentId).toBe(appointmentId);
    expect(res.body.message.message).toMatch(
      /^Përshëndetje Test, ju kujtojmë takimin tuaj/,
    );
    expect(res.body.message.sentByName).toBe('Admin avicena');
  });

  it('hands a balance notice to WhatsApp with the amount owed', async () => {
    const res = await call<{
      message: {
        status: string;
        channel: string;
        message: string;
        appointmentId: string | null;
      };
      handoffUrl: string;
    }>(api, 'POST', path(), A({ purpose: 'unpaid_balance', channel: 'whatsapp' }));
    expect(res.status).toBe(201);
    expect(res.body.message.channel).toBe('whatsapp');
    expect(res.body.message.appointmentId).toBeNull();
    expect(res.body.message.message).toMatch(
      /detyrim i papaguar prej 25[\s\u00a0\u202f.]?600/,
    );
    expect(res.body.handoffUrl.startsWith('https://wa.me/355691234567?text=')).toBe(true);
  });

  it('refuses what cannot be sent, with the reason', async () => {
    const followup = await call<{ message: string }>(
      api,
      'POST',
      path(),
      A({ purpose: 'post_procedure_followup', channel: 'log' }),
    );
    expect(followup.status).toBe(400);
    expect(followup.body.message).toMatch(/no completed visit/);

    const sms = await call<{ message: string }>(
      api,
      'POST',
      path(),
      A({ purpose: 'unpaid_balance', channel: 'sms' }),
    );
    expect(sms.status).toBe(400);
    expect(sms.body.message).toMatch(/not set up/);

    const noAppointment = await call(
      api,
      'POST',
      path(),
      A({ purpose: 'appointment_reminder', channel: 'log' }),
    );
    expect(noAppointment.status).toBe(400);
  });

  it('lists the conversation under its channel only', async () => {
    const whatsapp = await call<
      { patientId: string; messageCount: number; last: { purpose: string } }[]
    >(api, 'GET', '/api/messages/conversations?channel=whatsapp', A());
    expect(whatsapp.status).toBe(200);
    expect(whatsapp.body).toHaveLength(1);
    expect(whatsapp.body[0]!.last.purpose).toBe('unpaid_balance');

    const all = await call<{ messageCount: number }[]>(
      api,
      'GET',
      '/api/messages/conversations',
      A(),
    );
    expect(all.body[0]!.messageCount).toBe(2);

    const sms = await call<unknown[]>(
      api,
      'GET',
      '/api/messages/conversations?channel=sms',
      A(),
    );
    expect(sms.body).toEqual([]);
  });

  it('respects an opt-out on every channel that reaches the phone', async () => {
    await owner().query(
      `UPDATE patients SET reminders_opt_out = true, reminders_opt_out_at = now(), reminders_opt_out_source = 'staff'
        WHERE id = $1`,
      [s.a.patientId],
    );
    const handoff = await call(
      api,
      'POST',
      path(),
      A({ purpose: 'unpaid_balance', channel: 'whatsapp' }),
    );
    expect(handoff.status).toBe(409);
    const recorded = await call(
      api,
      'POST',
      path(),
      A({ purpose: 'unpaid_balance', channel: 'log' }),
    );
    expect(recorded.status).toBe(201);
    await owner().query(
      `UPDATE patients SET reminders_opt_out = false, reminders_opt_out_at = NULL, reminders_opt_out_source = NULL
        WHERE id = $1`,
      [s.a.patientId],
    );
  });

  it("does not show one clinic another clinic's conversation", async () => {
    const res = await call(
      api,
      'GET',
      `/api/patients/${s.a.patientId}/messages`,
      as(tokenB, s.b.subdomain),
    );
    expect(res.status).toBe(404);
    const list = await call<unknown[]>(
      api,
      'GET',
      '/api/messages/conversations',
      as(tokenB, s.b.subdomain),
    );
    expect(list.body).toEqual([]);
  });

  it("refuses, in the database, a message about one patient's appointment sent to another", async () => {
    const other = await owner().query<{ id: string }>(
      `INSERT INTO patients (tenant_id, first_name, last_name, status) VALUES ($1, 'Other', 'Person', 'active') RETURNING id`,
      [s.a.id],
    );
    const code = await errorCodeOf(
      owner().query(
        `INSERT INTO reminders (tenant_id, appointment_id, patient_id, purpose, type, channel, status, message)
         VALUES ($1, $2, $3, 'appointment_reminder', 'manual', 'log', 'sent', 'x')`,
        [s.a.id, appointmentId, other.rows[0]!.id],
      ),
    );
    expect(code).toBe('23514');
    const orphan = await errorCodeOf(
      owner().query(
        `INSERT INTO reminders (tenant_id, patient_id, purpose, type, channel, status, message)
         VALUES ($1, $2, 'appointment_reminder', 'manual', 'log', 'sent', 'x')`,
        [s.a.id, s.a.patientId],
      ),
    );
    expect(orphan).toBe('23514');
  });
});

describe('estimates', () => {
  let planId: string;

  beforeAll(async () => {
    const treatment = await rowsOf<{ id: string }>(
      `INSERT INTO treatments (tenant_id, name, price, is_taxable) VALUES ($1, 'Faseta porcelani', 2500000, true) RETURNING id`,
      [s.a.id],
    );
    const plan = await rowsOf<{ id: string }>(
      `INSERT INTO treatment_plans (tenant_id, patient_id, title, discount_amount)
       VALUES ($1, $2, 'Rehabilitim estetik', 0) RETURNING id`,
      [s.a.id, s.a.patientId],
    );
    planId = plan[0]!.id;
    await owner().query(
      `INSERT INTO treatment_plan_items (tenant_id, plan_id, description, quantity, unit_fee, treatment_id, sort_order)
       VALUES ($1, $2, 'Faseta porcelani', 2, 2500000, $3, 0),
              ($1, $2, 'Pastrim profesional', 1, 400000, NULL, 1)`,
      [s.a.id, planId, treatment[0]!.id],
    );
  });

  it('prices the plan with TVSH, and in euro at the clinic rate', async () => {
    const res = await call<{
      currency: string;
      quote: { currency: string; rate: number; source: string } | null;
      items: { taxRateBp: number; total: number; totalQuote: number }[];
      totals: { net: number; tax: number; total: number; totalQuote: number };
    }>(api, 'GET', `/api/treatment-plans/${planId}/estimate`, A());
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('ALL');
    expect(res.body.quote).toEqual(
      expect.objectContaining({ currency: 'EUR', rate: 100, source: 'fixed' }),
    );
    // 2 × 25 000 L cosmetic + 20% = 60 000 L; 4 000 L cleaning, exempt.
    expect(res.body.items.map((i) => [i.taxRateBp, i.total])).toEqual([
      [2000, 6_000_000],
      [0, 400_000],
    ]);
    expect(res.body.totals).toEqual(
      expect.objectContaining({ net: 5_400_000, tax: 1_000_000, total: 6_400_000 }),
    );
    // 64 000 L at 100 L per euro is €640.
    expect(res.body.totals.totalQuote).toBe(64_000);
  });

  it('prints without a second currency when asked', async () => {
    const res = await call<{ quote: unknown }>(
      api,
      'GET',
      `/api/treatment-plans/${planId}/estimate?currency=none`,
      A(),
    );
    expect(res.body.quote).toBeNull();
  });

  it('keeps the estimate currency different from the clinic currency', async () => {
    const res = await call(api, 'PATCH', '/api/settings', A({ quoteCurrency: 'ALL' }));
    expect(res.status).toBe(400);
    const settings = await call<{
      quoteCurrency: string;
      fxRateSource: string;
      fxFixedRate: number;
    }>(api, 'GET', '/api/settings', A());
    expect(settings.body).toEqual(
      expect.objectContaining({
        quoteCurrency: 'EUR',
        fxRateSource: 'fixed',
        fxFixedRate: 100,
      }),
    );
  });
});

describe('fiscal certificate as issued', () => {
  const p12 = (name: string) =>
    readFileSync(
      join(__dirname, '../../src/modules/clinic/fiscalization/__fixtures__', name),
    ).toString('base64');

  it('installs a .p12 with its password and keeps nothing of the password', async () => {
    const res = await call<{ certificate: { subject: string } | null }>(
      api,
      'POST',
      '/api/fiscal/certificate',
      A({
        p12Base64: p12('test-legacy.p12'),
        password: 'Çelës-Fiskal-ë',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.certificate?.subject).toContain('CN=Klinika Test');

    const audit = await rowsOf<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM clinic_audit_log WHERE tenant_id = $1 AND action = 'fiscal.certificate_installed'`,
      [s.a.id],
    );
    expect(audit[0]!.metadata.format).toBe('pkcs12');
    expect(JSON.stringify(audit)).not.toContain('Çelës');
  });

  it('says so when the password is wrong', async () => {
    const res = await call<{ message: string }>(
      api,
      'POST',
      '/api/fiscal/certificate',
      A({
        p12Base64: p12('test-modern.p12'),
        password: 'wrong',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/password is not correct/);
  });
});

describe('identity documents', () => {
  it('are a document kind the database accepts', async () => {
    const res = await owner().query<{ kind: string }>(
      `INSERT INTO patient_documents (tenant_id, patient_id, storage_key, file_name, content_type, byte_size, checksum, kind)
       VALUES ($1, $2, 'tenants/x/patients/y/id.jpg', 'id.jpg', 'image/jpeg', 100, 'c', 'id_document')
       RETURNING kind`,
      [s.a.id, s.a.patientId],
    );
    expect(res.rows[0]!.kind).toBe('id_document');
  });
});
