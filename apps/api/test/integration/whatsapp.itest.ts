import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import type { TestApi } from './api';
import { asTenant, closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * WhatsApp reminders from each clinic's own number (0017), against a real
 * database, the real API, and a stand-in for Meta's Graph API that records
 * what it was sent.
 *
 * What must hold:
 *   the token      is never returned, never stored in the clear, and a wrong
 *                  one is never saved
 *   the clinic     sees only its own connection, templates and sends
 *   eligibility    is decided by the server, again, at send time
 *   one reminder   per appointment, whatever the tabs and clicks
 *   the content    carries name, clinic, date and time — never the reason
 */

const GOOD_TOKEN = `EAAtest${'x'.repeat(40)}`;
const WABA = '100200300400';
const PHONE_ID = '555666777888';
const UNREACHABLE = '+355690000099';

interface Sent {
  to: string;
  template: { name: string; language: { code: string }; components?: { parameters: { parameter_name: string; text: string }[] }[] };
}

let graph: Server;
const sent: Sent[] = [];
let api: TestApi;
let call: typeof import('./api').call;
let login: typeof import('./api').login;
let s: Scenario;
let admin: string;
let desk: string;
let adminB: string;
let templateId: string;
const pid: Record<string, string> = {};
const appt: Record<string, string> = {};

const A = (token: string, body?: unknown, headers?: Record<string, string>) => ({ token, subdomain: s.a.subdomain, body, headers });
const key = () => `k-${randomUUID()}`;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

/** Meta, as far as this feature talks to it. */
function fakeGraph(): Server {
  return createServer(async (req, res) => {
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) {
      return reply(401, { error: { code: 190, message: 'Invalid OAuth access token.' } });
    }
    const url = new URL(req.url!, 'http://graph');
    if (req.method === 'GET' && url.pathname === `/v25.0/${WABA}/phone_numbers`) {
      return reply(200, { data: [{ id: PHONE_ID, display_phone_number: '+355 69 000 0000', verified_name: 'Klinika Test' }] });
    }
    if (req.method === 'GET' && url.pathname === `/v25.0/${WABA}/message_templates`) {
      const all = [
        {
          name: 'appointment_reminder_sq',
          status: 'APPROVED',
          category: 'UTILITY',
          language: 'sq',
          parameter_format: 'NAMED',
          components: [
            {
              type: 'BODY',
              text: 'Përshëndetje {{patient_name}}, kujtesë nga {{clinic_name}}: {{appointment_date}} në {{appointment_time}}.',
            },
          ],
        },
        { name: 'promo_offer', status: 'APPROVED', category: 'MARKETING', language: 'sq', components: [{ type: 'BODY', text: 'Ofertë!' }] },
        {
          name: 'numbered',
          status: 'APPROVED',
          category: 'UTILITY',
          language: 'sq',
          parameter_format: 'POSITIONAL',
          components: [{ type: 'BODY', text: 'Hi {{1}}' }],
        },
      ];
      return reply(200, { data: all.filter((t) => t.name.startsWith(url.searchParams.get('name') ?? '')) });
    }
    if (req.method === 'POST' && url.pathname === `/v25.0/${PHONE_ID}/messages`) {
      const msg = JSON.parse(await body(req)) as Sent;
      sent.push(msg);
      // Slow enough that two concurrent batches overlap.
      await new Promise((r) => setTimeout(r, 40));
      if (msg.to === UNREACHABLE) {
        return reply(400, { error: { code: 131026, message: 'Message undeliverable' } });
      }
      return reply(200, { messages: [{ id: `wamid.${randomUUID()}`, message_status: 'accepted' }] });
    }
    reply(404, { error: { code: 100, error_subcode: 33, message: 'Unknown path' } });
  });
}

async function patient(name: string, phone: string | null): Promise<string> {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO patients (tenant_id, first_name, last_name, phone, status) VALUES ($1,$2,'Test',$3,'active') RETURNING id`,
    [s.a.id, name, phone],
  );
  return rows[0]!.id;
}

/** An appointment tomorrow, in the clinic's zone, at `hour`. */
async function tomorrowAt(patientId: string, hour: number, status = 'scheduled'): Promise<string> {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, patient_id, reason, status, starts_at, ends_at, cancelled_at)
     SELECT $1, $2, 'Root canal treatment', $3, t, t + interval '30 minutes', CASE WHEN $3 = 'cancelled' THEN now() END
       FROM (SELECT (((now() AT TIME ZONE 'Europe/Tirane')::date + 1) + make_time($4, 0, 0)) AT TIME ZONE 'Europe/Tirane' AS t) x
     RETURNING id`,
    [s.a.id, patientId, status, hour],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  graph = fakeGraph();
  await new Promise<void>((r) => graph.listen(0, '127.0.0.1', r));
  process.env.WHATSAPP_GRAPH_BASE_URL = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;
  process.env.WHATSAPP_GRAPH_VERSION = 'v25.0';
  // Loaded after the environment is set: the API reads its config at import.
  const harness = await import('./api');
  call = harness.call;
  login = harness.login;
  api = await harness.startApi();

  s = await createScenario();
  await owner().query(`INSERT INTO clinic_settings (tenant_id, phone) VALUES ($1, '+355 4 222 3333')`, [s.a.id]);
  const email = `desk@${s.a.subdomain}.test`;
  await owner().query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status) VALUES ($1,$2,$3,'Desk','receptionist','active')`,
    [s.a.id, email, await bcrypt.hash(s.password, 4)],
  );
  admin = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  desk = (await login(api, s.a.subdomain, email, s.password)).accessToken;
  adminB = (await login(api, s.b.subdomain, s.b.adminEmail, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api?.close();
  await closePools();
  graph.closeAllConnections();
  await new Promise((r) => graph.close(r));
});

describe('the connection', () => {
  it('refuses a token Meta does not accept, and saves nothing', async () => {
    const res = await call<{ code: string; message: string }>(api, 'PUT', '/api/whatsapp/connection',
      A(admin, { accessToken: `EAAwrong${'y'.repeat(40)}`, phoneNumberId: PHONE_ID, wabaId: WABA }));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/invalid or has expired/);
    expect((await ownerQuery('SELECT 1 FROM clinic_whatsapp_connections WHERE tenant_id = $1', [s.a.id])).rowCount).toBe(0);
  });

  it('is managed by the administrator only', async () => {
    const res = await call(api, 'PUT', '/api/whatsapp/connection', A(desk, { accessToken: GOOD_TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA }));
    expect(res.status).toBe(403);
  });

  it('saves a working token sealed, and never returns it', async () => {
    const res = await call(api, 'PUT', '/api/whatsapp/connection', A(admin, { accessToken: GOOD_TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: true, displayPhoneNumber: '+355 69 000 0000', verifiedName: 'Klinika Test' });
    expect(JSON.stringify(res.body)).not.toContain(GOOD_TOKEN);

    const read = await call(api, 'GET', '/api/whatsapp/connection', A(desk));
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(GOOD_TOKEN);

    const row = (await ownerQuery<{ encrypted_access_token: string }>(
      'SELECT encrypted_access_token FROM clinic_whatsapp_connections WHERE tenant_id = $1', [s.a.id],
    )).rows[0]!;
    expect(row.encrypted_access_token).not.toContain(GOOD_TOKEN);
    expect(row.encrypted_access_token).not.toContain(GOOD_TOKEN.slice(0, 12));
  });

  it('tests the saved connection without the token being sent again', async () => {
    const res = await call<{ ok: boolean; displayPhoneNumber: string }>(api, 'POST', '/api/whatsapp/connection/test', A(admin, {}));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, displayPhoneNumber: '+355 69 000 0000' });
  });

  it('is invisible to another clinic', async () => {
    const res = await call<{ saved: boolean }>(api, 'GET', '/api/whatsapp/connection', { token: adminB, subdomain: s.b.subdomain });
    expect(res.body.saved).toBe(false);
    const n = await asTenant(s.b.id, async (c) =>
      (await c.query('SELECT count(*)::int AS n FROM clinic_whatsapp_connections')).rows[0].n,
    );
    expect(n).toBe(0);
  });
});

describe('templates', () => {
  it('accepts an approved Utility template with named variables', async () => {
    const res = await call<{ id: string; ready: boolean; isDefault: boolean; meta: { parameters: string[] } }>(
      api, 'POST', '/api/whatsapp/templates',
      A(admin, {
        displayName: 'Appointment Reminder Albanian',
        metaTemplateName: 'appointment_reminder_sq',
        languageCode: 'sq',
        previewBody: 'Përshëndetje {{patient_name}}, kjo është një kujtesë nga {{clinic_name}}.',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ready: true, isDefault: true });
    expect(res.body.meta.parameters).toEqual(['patient_name', 'clinic_name', 'appointment_date', 'appointment_time']);
    templateId = res.body.id;
  });

  it('marks a marketing or numbered template as not ready', async () => {
    const promo = await call<{ ready: boolean; meta: { problem: string } }>(api, 'POST', '/api/whatsapp/templates',
      A(admin, { displayName: 'Promo', metaTemplateName: 'promo_offer', languageCode: 'sq', previewBody: 'Ofertë' }));
    expect(promo.body.ready).toBe(false);
    expect(promo.body.meta.problem).toMatch(/Utility/);
    const numbered = await call<{ ready: boolean; meta: { problem: string } }>(api, 'POST', '/api/whatsapp/templates',
      A(admin, { displayName: 'Numbered', metaTemplateName: 'numbered', languageCode: 'sq', previewBody: 'Hi {{patient_name}}' }));
    expect(numbered.body.meta.problem).toMatch(/named variables/);
  });

  it('refuses a preview a reminder cannot fill', async () => {
    const res = await call(api, 'POST', '/api/whatsapp/templates',
      A(admin, { displayName: 'Balance', metaTemplateName: 'balance_x', languageCode: 'sq', previewBody: 'You owe {{balance}}' }));
    expect(res.status).toBe(400);
  });
});

describe('tomorrow', () => {
  beforeAll(async () => {
    pid.ok = await patient('Ardit', '069 111 2222');
    pid.noConsent = await patient('Blerta', '069 333 4444');
    pid.noPhone = await patient('Dritan', null);
    pid.cancelled = await patient('Elira', '069 555 6666');
    pid.unreachable = await patient('Fatos', null);
    pid.optedOut = await patient('Gent', '069 777 8888');
    pid.late = await patient('Hana', '069 999 0000');

    // Consent through the patient API, as the desk records it.
    for (const k of ['ok', 'noPhone', 'cancelled', 'optedOut', 'late']) {
      const res = await call(api, 'PATCH', `/api/patients/${pid[k]}`, A(desk, { whatsappOptIn: true, whatsappOptInSource: 'in_person' }));
      expect(res.status).toBe(200);
    }
    expect((await call(api, 'PATCH', `/api/patients/${pid.unreachable}`,
      A(desk, { whatsappOptIn: true, whatsappPhone: UNREACHABLE }))).status).toBe(200);
    expect((await call(api, 'PATCH', `/api/patients/${pid.optedOut}`, A(desk, { remindersOptOut: true }))).status).toBe(200);

    appt.ok = await tomorrowAt(pid.ok, 9);
    appt.noConsent = await tomorrowAt(pid.noConsent, 10);
    appt.noPhone = await tomorrowAt(pid.noPhone, 11);
    appt.cancelled = await tomorrowAt(pid.cancelled, 12, 'cancelled');
    appt.unreachable = await tomorrowAt(pid.unreachable, 13);
    appt.optedOut = await tomorrowAt(pid.optedOut, 14);
    appt.late = await tomorrowAt(pid.late, 15);
  });

  it('records consent with how it was given, as its own audit entry', async () => {
    const row = (await ownerQuery<{ whatsapp_opt_in: boolean; whatsapp_opt_in_source: string; whatsapp_opted_in_at: Date }>(
      'SELECT whatsapp_opt_in, whatsapp_opt_in_source, whatsapp_opted_in_at FROM patients WHERE id = $1', [pid.ok],
    )).rows[0]!;
    expect(row).toMatchObject({ whatsapp_opt_in: true, whatsapp_opt_in_source: 'in_person' });
    expect(row.whatsapp_opted_in_at).toBeTruthy();
    const audit = await ownerQuery(
      `SELECT 1 FROM clinic_audit_log WHERE tenant_id = $1 AND action = 'patient.whatsapp_consent' AND entity_id = $2`,
      [s.a.id, pid.ok],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('refuses a WhatsApp number that cannot be one', async () => {
    const res = await call(api, 'PATCH', `/api/patients/${pid.ok}`, A(desk, { whatsappPhone: '12' }));
    expect(res.status).toBe(400);
  });

  it('lists tomorrow with a reason for everyone who cannot be reminded', async () => {
    const res = await call<{
      summary: Record<string, number>;
      rows: { appointmentId: string; exclusion: string | null; values: Record<string, string> }[];
    }>(api, 'GET', '/api/whatsapp/reminders', A(desk));
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.rows.map((r) => [r.appointmentId, r]));
    expect(by[appt.ok]!.exclusion).toBeNull();
    expect(by[appt.noConsent]!.exclusion).toBe('no_consent');
    expect(by[appt.noPhone]!.exclusion).toBe('phone_missing');
    expect(by[appt.cancelled]!.exclusion).toBe('appointment_cancelled');
    expect(by[appt.optedOut]!.exclusion).toBe('opted_out');
    expect(by[appt.unreachable]!.exclusion).toBeNull();
    expect(res.body.summary).toMatchObject({ total: 7, eligible: 3, cancelled: 1, phoneProblem: 1, noConsent: 2 });
    expect(by[appt.ok]!.values).toMatchObject({ patient_name: 'Ardit', appointment_time: '09:00' });
  });

  it('is not the front desk of another clinic', async () => {
    const res = await call<{ rows: unknown[] }>(api, 'GET', '/api/whatsapp/reminders', { token: adminB, subdomain: s.b.subdomain });
    expect(res.body.rows).toHaveLength(0);
  });
});

describe('sending', () => {
  let date: string;

  beforeAll(async () => {
    date = (await ownerQuery<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Tirane')::date + 1)::text AS d`)).rows[0]!.d;
  });

  it('decides again on the server, and says what happened to each one', async () => {
    const res = await call<{ sent: number; failed: number; skipped: number; sends: { patientId: string; status: string; failureReason: string | null }[] }>(
      api, 'POST', '/api/whatsapp/reminders/send',
      A(desk, { date, templateId, appointmentIds: [appt.ok, appt.noConsent, appt.unreachable] }, { 'Idempotency-Key': key() }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sent: 1, failed: 1, skipped: 1 });
    const by = Object.fromEntries(res.body.sends.map((x) => [x.patientId, x]));
    expect(by[pid.ok]).toMatchObject({ status: 'accepted' });
    expect(by[pid.noConsent]).toMatchObject({ status: 'skipped', failureReason: 'No WhatsApp consent' });
    expect(by[pid.unreachable]!.failureReason).toMatch(/cannot receive WhatsApp/);
    expect(sent.map((m) => m.to).sort()).toEqual(['+355691112222', UNREACHABLE].sort());
  });

  it('sends the approved template with the patient’s name, date and time — never the treatment', async () => {
    const msg = sent.find((m) => m.to === '+355691112222')!;
    expect(msg.template.name).toBe('appointment_reminder_sq');
    expect(msg.template.language.code).toBe('sq');
    const params = msg.template.components![0]!.parameters;
    expect(params.map((p) => p.parameter_name)).toEqual(['patient_name', 'clinic_name', 'appointment_date', 'appointment_time']);
    expect(params[0]!.text).toBe('Ardit');
    expect(params[3]!.text).toBe('09:00');
    expect(JSON.stringify(msg)).not.toMatch(/Root canal/i);
  });

  it('never reminds the same appointment twice, from a second click or a second tab', async () => {
    const before = sent.length;
    const again = await call<{ sends: { status: string }[] }>(api, 'POST', '/api/whatsapp/reminders/send',
      A(desk, { date, templateId, appointmentIds: [appt.ok] }, { 'Idempotency-Key': key() }));
    expect(again.body.sends[0]!.status).toBe('already_sent');

    // Two tabs at once, each with its own key.
    const [one, two] = await Promise.all(
      [key(), key()].map((k) =>
        call<{ sends: { status: string }[] }>(api, 'POST', '/api/whatsapp/reminders/send',
          A(desk, { date, templateId, appointmentIds: [appt.late] }, { 'Idempotency-Key': k })),
      ),
    );
    const statuses = [one!.body.sends[0]!.status, two!.body.sends[0]!.status].sort();
    expect(statuses).toEqual(['accepted', 'already_sent']);
    expect(sent.length - before).toBe(1);
  });

  it('replays a repeated request instead of running it', async () => {
    const k = key();
    const first = await call(api, 'POST', '/api/whatsapp/reminders/send', A(desk, { date, templateId, appointmentIds: [appt.ok] }, { 'Idempotency-Key': k }));
    const before = sent.length;
    const replay = await call(api, 'POST', '/api/whatsapp/reminders/send', A(desk, { date, templateId, appointmentIds: [appt.ok] }, { 'Idempotency-Key': k }));
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(sent.length).toBe(before);
  });

  it('keeps the history, with batch summaries', async () => {
    const res = await call<{ batches: { sent: number; failed: number; skipped: number }[]; sends: { status: string }[] }>(
      api, 'GET', '/api/whatsapp/history', A(desk),
    );
    expect(res.status).toBe(200);
    expect(res.body.batches.length).toBeGreaterThanOrEqual(4);
    expect(res.body.batches.at(-1)).toMatchObject({ sent: 1, failed: 1, skipped: 1 });
    const other = await call<{ batches: unknown[]; sends: unknown[] }>(api, 'GET', '/api/whatsapp/history', { token: adminB, subdomain: s.b.subdomain });
    expect(other.body).toEqual({ batches: [], sends: [] });
  });

  it('marks the appointment as reminded on tomorrow’s list', async () => {
    const res = await call<{ rows: { appointmentId: string; exclusion: string | null; reminder: { status: string } | null }[] }>(
      api, 'GET', '/api/whatsapp/reminders', A(desk),
    );
    const row = res.body.rows.find((r) => r.appointmentId === appt.ok)!;
    expect(row).toMatchObject({ exclusion: 'already_sent', reminder: { status: 'accepted' } });
    // A failed one can be tried again.
    expect(res.body.rows.find((r) => r.appointmentId === appt.unreachable)!.exclusion).toBeNull();
  });
});

describe('disconnecting', () => {
  it('deletes the token, and nothing can be sent after', async () => {
    expect((await call(api, 'DELETE', '/api/whatsapp/connection', A(desk))).status).toBe(403);
    const res = await call<{ saved: boolean }>(api, 'DELETE', '/api/whatsapp/connection', A(admin));
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect((await ownerQuery('SELECT 1 FROM clinic_whatsapp_connections WHERE tenant_id = $1', [s.a.id])).rowCount).toBe(0);
    const send = await call<{ code: string }>(api, 'POST', '/api/whatsapp/reminders/send',
      A(desk, { date: '2030-01-01', templateId, appointmentIds: [appt.unreachable] }, { 'Idempotency-Key': key() }));
    expect(send.status).toBe(409);
    expect(send.body.code).toBe('whatsapp_not_connected');
  });
});
