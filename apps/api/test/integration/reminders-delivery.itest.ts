import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestApi } from './api';
import { closePools, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';
import { twilioSignature } from '@/modules/clinic/reminders/channels/twilio';
import type { RemindersService } from '@/modules/clinic/reminders/reminders.service';

/**
 * Reminders that reach the patient (0008), end to end.
 *
 * Twilio is replaced by a local HTTP server that speaks its Messages API, so
 * the real channel code — form encoding, Basic auth, error classification —
 * runs unchanged. What this cannot prove is that Twilio itself behaves as its
 * documentation says; the signature test in twilio.spec.ts checks against
 * their published example, and nothing here has talked to the real service.
 *
 * The config module validates the environment when it is first imported, and
 * the stand-in's port is only known once it is listening. So, like
 * api-mfa.itest.ts, the API is required inside jest.isolateModules after the
 * SMS variables are set — a fresh module registry, the same code.
 */

let call: typeof import('./api').call;

const ACCOUNT = `AC${'0'.repeat(32)}`;
const TOKEN = 'integration-auth-token-0123';
const PUBLIC = 'https://api.test.local';
const RECEIPT_PATH = '/api/reminders/delivery/twilio';

interface Outbound {
  auth: string | null;
  to: string | null;
  body: string | null;
  from: string | null;
  callback: string | null;
}

const outbound: Outbound[] = [];
/** Scripted responses, consumed in order; an empty script accepts the message. */
const script: { status: number; body: unknown }[] = [];

let fake: Server;
let api: TestApi;
let s: Scenario;
let token: string;
let reminders: RemindersService;

const ENV = [
  'SMS_PROVIDER',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM',
  'TWILIO_API_BASE_URL',
  'PUBLIC_API_URL',
] as const;
const previousEnv: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

function startFakeTwilio(): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      outbound.push({
        auth: req.headers.authorization ?? null,
        to: form.get('To'),
        body: form.get('Body'),
        from: form.get('From'),
        callback: form.get('StatusCallback'),
      });
      const next = script.shift() ?? {
        status: 201,
        body: { sid: `SM${randomBytes(16).toString('hex')}`, status: 'queued' },
      };
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

beforeAll(async () => {
  fake = await startFakeTwilio();
  const port = (fake.address() as AddressInfo).port;

  for (const key of ENV) previousEnv[key] = process.env[key];
  Object.assign(process.env, {
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: ACCOUNT,
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_FROM: '+15005550006',
    TWILIO_API_BASE_URL: `http://127.0.0.1:${port}`,
    PUBLIC_API_URL: PUBLIC,
  });

  let harness!: typeof import('./api');
  let service!: typeof import('@/modules/clinic/reminders/reminders.service');
  jest.isolateModules(() => {
    harness = require('./api');
    // From the same registry as the app, or app.get() would look up a
    // different class object and find nothing.
    service = require('@/modules/clinic/reminders/reminders.service');
  });
  call = harness.call;

  api = await harness.startApi();
  s = await createScenario();
  token = (await harness.login(api, s.a.subdomain, s.a.adminEmail, s.password))
    .accessToken;
  reminders = api.app.get(service.RemindersService);

  await owner().query(
    `INSERT INTO clinic_settings
       (tenant_id, reminders_enabled, reminder_hours_before, phone, phone_country_code, timezone)
     VALUES ($1, true, 24, '+355 4 222 3333', '355', 'Europe/Tirane')
     ON CONFLICT (tenant_id) DO UPDATE SET
       reminders_enabled = true, reminder_hours_before = 24, phone = EXCLUDED.phone,
       phone_country_code = '355', timezone = 'Europe/Tirane'`,
    [s.a.id],
  );
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
  await new Promise((resolve) => fake.close(resolve));
  for (const key of ENV) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const asAdmin = (method: string, path: string, body?: unknown) =>
  call(api, method, path, { subdomain: s.a.subdomain, token, body });

/** A patient in clinic A with an appointment `inHours` from now. */
async function booked(opts: {
  firstName: string;
  phone: string | null;
  optedOut?: boolean;
  inHours?: number;
}): Promise<{ patientId: string; appointmentId: string }> {
  const optedOut = opts.optedOut ?? false;
  const patient = await owner().query<{ id: string }>(
    `INSERT INTO patients
       (tenant_id, first_name, last_name, phone,
        reminders_opt_out, reminders_opt_out_at, reminders_opt_out_source)
     VALUES ($1, $2, 'Tester', $3, $4::boolean,
             CASE WHEN $4::boolean THEN now() END,
             CASE WHEN $4::boolean THEN 'staff' END)
     RETURNING id`,
    [s.a.id, opts.firstName, opts.phone, optedOut],
  );
  const starts = new Date(Date.now() + (opts.inHours ?? 2) * 3_600_000);
  const appointment = await owner().query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, patient_id, reason, starts_at, ends_at)
     VALUES ($1, $2, 'Root canal, tooth 36', $3, $4) RETURNING id`,
    [s.a.id, patient.rows[0].id, starts, new Date(starts.getTime() + 30 * 60_000)],
  );
  return { patientId: patient.rows[0].id, appointmentId: appointment.rows[0].id };
}

interface Row {
  id: string;
  status: string;
  error: string | null;
  error_code: string | null;
  attempts: number;
  to_address: string | null;
  provider_message_id: string | null;
  delivered_at: Date | null;
  retry_later: boolean;
}

async function reminderFor(appointmentId: string): Promise<Row> {
  const { rows } = await owner().query<Row>(
    `SELECT id, status, error, error_code, attempts, to_address, provider_message_id,
            delivered_at, coalesce(next_attempt_at > now(), false) AS retry_later
       FROM reminders WHERE appointment_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [appointmentId],
  );
  if (!rows[0]) throw new Error(`no reminder for ${appointmentId}`);
  return rows[0];
}

function receipt(query: string, params: Record<string, string>, signature?: string) {
  const path = `${RECEIPT_PATH}?${query}`;
  return fetch(api.url(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature':
        signature ?? twilioSignature(TOKEN, `${PUBLIC}${path}`, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

let ana: { patientId: string; appointmentId: string };
let besa: { patientId: string; appointmentId: string };

describe('automatic reminders over SMS', () => {
  let noNumber: { appointmentId: string };
  let optedOut: { appointmentId: string };

  beforeAll(async () => {
    ana = await booked({ firstName: 'Ana', phone: '069 123 4567' });
    noNumber = await booked({ firstName: 'Blerina', phone: 'ask at reception' });
    optedOut = await booked({ firstName: 'Cela', phone: '068 765 4321', optedOut: true });
  });

  it('sends one SMS, in the clinic’s words, to an E.164 number', async () => {
    const result = await reminders.scanTenant(s.a.id);

    expect(result.sent).toBe(1);
    expect(outbound).toHaveLength(1);
    const sms = outbound[0]!;
    expect(sms.to).toBe('+355691234567');
    expect(sms.from).toBe('+15005550006');
    expect(sms.auth).toBe(
      `Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64')}`,
    );
    expect(sms.body).toContain('Ana');
    expect(sms.body).toContain('+355 4 222 3333');

    const row = await reminderFor(ana.appointmentId);
    expect(row).toMatchObject({
      status: 'sent',
      to_address: '+355691234567',
      attempts: 1,
    });
    expect(row.provider_message_id).toMatch(/^SM/);
    expect(sms.callback).toBe(
      `${PUBLIC}${RECEIPT_PATH}?tenant=${s.a.id}&reminder=${row.id}`,
    );
  });

  it('keeps the treatment and the surname off the lock screen', () => {
    expect(outbound[0]!.body).not.toContain('Root canal');
    expect(outbound[0]!.body).not.toContain('Tester');
  });

  it('does not message a patient who opted out, or one with no usable number — and says why', async () => {
    expect(await reminderFor(optedOut.appointmentId)).toMatchObject({
      status: 'skipped',
      error: 'The patient has opted out of reminders',
    });
    expect(await reminderFor(noNumber.appointmentId)).toMatchObject({
      status: 'skipped',
      error: 'No usable mobile number on file',
    });
  });

  it('a second pass sends nothing again', async () => {
    await reminders.scanTenant(s.a.id);
    expect(outbound).toHaveLength(1);
  });
});

describe('when the provider says no', () => {
  it('a busy provider is tried again later, not straight away', async () => {
    besa = await booked({ firstName: 'Besa', phone: '+355 67 222 1111' });
    script.push({ status: 503, body: { code: 20503, message: 'Service unavailable' } });

    await reminders.scanTenant(s.a.id);
    const before = outbound.length;
    expect(await reminderFor(besa.appointmentId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      retry_later: true,
    });

    await reminders.scanTenant(s.a.id);
    expect(outbound.length).toBe(before);

    await owner().query(
      `UPDATE reminders SET next_attempt_at = now() - interval '1 minute'
        WHERE appointment_id = $1`,
      [besa.appointmentId],
    );
    await reminders.scanTenant(s.a.id);
    expect(outbound.length).toBe(before + 1);
    expect(await reminderFor(besa.appointmentId)).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
  });

  it('an unsubscribed number stops reminders for that patient', async () => {
    const drita = await booked({ firstName: 'Drita', phone: '069 999 0000' });
    script.push({
      status: 400,
      body: { code: 21610, message: 'Attempt to send to unsubscribed recipient' },
    });

    await reminders.scanTenant(s.a.id);

    expect(await reminderFor(drita.appointmentId)).toMatchObject({
      status: 'failed',
      error_code: '21610',
    });
    const { rows } = await owner().query<{
      reminders_opt_out: boolean;
      reminders_opt_out_source: string;
    }>('SELECT reminders_opt_out, reminders_opt_out_source FROM patients WHERE id = $1', [
      drita.patientId,
    ]);
    expect(rows[0]).toEqual({
      reminders_opt_out: true,
      reminders_opt_out_source: 'provider',
    });
  });
});

describe('delivery receipts', () => {
  it('a signed receipt marks the reminder delivered', async () => {
    const row = await reminderFor(ana.appointmentId);
    const res = await receipt(`tenant=${s.a.id}&reminder=${row.id}`, {
      MessageSid: row.provider_message_id!,
      MessageStatus: 'delivered',
    });

    expect(res.status).toBe(204);
    const after = await reminderFor(ana.appointmentId);
    expect(after.status).toBe('delivered');
    expect(after.delivered_at).not.toBeNull();
  });

  it('a late "sent" does not undo "delivered"', async () => {
    const row = await reminderFor(ana.appointmentId);
    const res = await receipt(`tenant=${s.a.id}&reminder=${row.id}`, {
      MessageSid: row.provider_message_id!,
      MessageStatus: 'sent',
    });

    expect(res.status).toBe(204);
    expect((await reminderFor(ana.appointmentId)).status).toBe('delivered');
  });

  it('refuses a receipt that is unsigned or was changed after signing', async () => {
    const row = await reminderFor(besa.appointmentId);
    const query = `tenant=${s.a.id}&reminder=${row.id}`;
    const signedFor = { MessageSid: row.provider_message_id!, MessageStatus: 'sent' };

    expect((await receipt(query, signedFor, 'not-a-signature')).status).toBe(403);

    const tampered = await receipt(
      query,
      { ...signedFor, MessageStatus: 'delivered' },
      twilioSignature(TOKEN, `${PUBLIC}${RECEIPT_PATH}?${query}`, signedFor),
    );
    expect(tampered.status).toBe(403);
    expect((await reminderFor(besa.appointmentId)).status).toBe('sent');
  });

  it('a receipt naming another clinic reaches nothing, even correctly signed', async () => {
    const row = await reminderFor(besa.appointmentId);
    const res = await receipt(`tenant=${s.b.id}&reminder=${row.id}`, {
      MessageSid: row.provider_message_id!,
      MessageStatus: 'delivered',
    });

    expect(res.status).toBe(204);
    expect((await reminderFor(besa.appointmentId)).status).toBe('sent');
  });
});

describe('from the appointment screen', () => {
  it('knows SMS is available, with receipts', async () => {
    const res = await asAdmin('GET', '/api/reminders/channels');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sms: true, deliveryReceipts: true });
  });

  it('sends an SMS on demand', async () => {
    const elira = await booked({
      firstName: 'Elira',
      phone: '069 555 1234',
      inHours: 30,
    });
    const res = await asAdmin(
      'POST',
      `/api/appointments/${elira.appointmentId}/reminders`,
      {
        channel: 'sms',
      },
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      channel: 'sms',
      status: 'sent',
      toAddress: '+355695551234',
    });
  });

  it('refuses to text a patient who opted out', async () => {
    const fisnik = await booked({
      firstName: 'Fisnik',
      phone: '069 555 9876',
      optedOut: true,
      inHours: 30,
    });
    const res = await asAdmin(
      'POST',
      `/api/appointments/${fisnik.appointmentId}/reminders`,
      {
        channel: 'sms',
      },
    );

    expect(res.status).toBe(409);
  });
});

describe('the clinic’s own wording', () => {
  it('refuses a placeholder the message cannot fill', async () => {
    const res = await asAdmin('PATCH', '/api/settings', {
      reminderTemplate: 'Hello {first_name}, your {reason} is at {time}.',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a time zone that does not exist', async () => {
    const res = await asAdmin('PATCH', '/api/settings', { timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
  });

  it('sends what the clinic wrote', async () => {
    const saved = await asAdmin('PATCH', '/api/settings', {
      reminderTemplate: 'Kujtesë: {clinic} ju pret më {date} në orën {time}.',
      reminderLocale: 'sq',
    });
    expect(saved.status).toBe(200);

    await booked({ firstName: 'Gjergj', phone: '069 444 3322', inHours: 3 });
    await reminders.scanTenant(s.a.id);

    expect(outbound[outbound.length - 1]!.body).toMatch(/^Kujtesë: Clinic /);
  });
});
