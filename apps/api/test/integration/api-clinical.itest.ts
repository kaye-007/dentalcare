import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The clinical record over HTTP: withdrawal, signing and the access log, as a
 * receptionist, a dentist and the administrator each meet them.
 *
 * clinical-record.itest.ts proves the database refuses; this proves the API
 * says so in the right words and that the SPA-facing routes behave — no
 * DELETE route survives, a signed entry is out of reception's reach, and a
 * read is recorded where the administrator can see it.
 */

let api: TestApi;
let s: Scenario;
const tokens = { admin: '', reception: '', dentist: '' };

async function addUser(role: string): Promise<string> {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@${s.a.subdomain}.test`;
  await owner().query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
     VALUES ($1, $2, $3, $4, $5, 'active')`,
    [s.a.id, email, await bcrypt.hash(s.password, 4), `Test ${role}`, role],
  );
  return email;
}

const as = (who: keyof typeof tokens, body?: unknown) => ({
  subdomain: s.a.subdomain,
  token: tokens[who],
  body,
});

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  const receptionEmail = await addUser('receptionist');
  const dentistEmail = await addUser('dentist');
  tokens.admin = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  tokens.reception = (await login(api, s.a.subdomain, receptionEmail, s.password)).accessToken;
  tokens.dentist = (await login(api, s.a.subdomain, dentistEmail, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

async function chartFinding(tooth: number): Promise<string> {
  const res = await call<{ id: string }>(
    api,
    'POST',
    `/api/patients/${s.a.patientId}/chart/conditions`,
    as('dentist', { tooth, surface: 'O', condition: 'caries' }),
  );
  expect(res.status).toBe(201);
  return res.body.id;
}

async function chart() {
  const res = await call<{ conditions: { id: string; status: string }[] }>(
    api,
    'GET',
    `/api/patients/${s.a.patientId}/chart`,
    as('reception'),
  );
  expect(res.status).toBe(200);
  return res.body.conditions;
}

async function logProcedure(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call<{ id: string }>(
    api,
    'POST',
    `/api/patients/${s.a.patientId}/procedures`,
    as('dentist', {
      tooth: 36,
      description: 'Composite filling',
      status: 'completed',
      fee: 3000,
      ...extra,
    }),
  );
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('reception and the clinical record', () => {
  /**
   * Reception reads the chart and takes the intake history; it does not write
   * the odontogram, a perio exam or a treatment plan (0009).
   */
  it('reads the chart but cannot chart, log a procedure, start a perio exam or plan', async () => {
    expect((await call(api, 'GET', `/api/patients/${s.a.patientId}/chart`, as('reception'))).status).toBe(200);
    const refused = [
      ['POST', `/api/patients/${s.a.patientId}/chart/conditions`, { tooth: 16, condition: 'caries' }],
      ['POST', `/api/patients/${s.a.patientId}/procedures`, { description: 'Filling' }],
      ['POST', `/api/patients/${s.a.patientId}/perio-exams`, {}],
      ['POST', `/api/patients/${s.a.patientId}/treatment-plans`, { title: 'Plan' }],
    ] as const;
    for (const [method, path, body] of refused) {
      const res = await call(api, method, path, as('reception', body));
      expect(res.status).toBe(403);
    }
  });

  it('records the medical history at intake', async () => {
    const res = await call(
      api,
      'POST',
      `/api/patients/${s.a.patientId}/allergies`,
      as('reception', { substance: 'Penicillin', severity: 'severe' }),
    );
    expect(res.status).toBe(201);
  });
});

describe('withdrawing a finding', () => {
  it('needs a reason', async () => {
    const id = await chartFinding(46);
    const res = await call(api, 'POST', `/api/tooth-conditions/${id}/entered-in-error`, as('dentist', {}));
    expect(res.status).toBe(400);
  });

  it('takes it off the chart, keeps it in the database, and records why', async () => {
    const id = await chartFinding(47);
    const res = await call(
      api,
      'POST',
      `/api/tooth-conditions/${id}/entered-in-error`,
      as('dentist', { reason: 'Charted on the wrong tooth' }),
    );
    expect(res.status).toBe(201);

    expect((await chart()).map((c) => c.id)).not.toContain(id);

    const { rows } = await ownerQuery<{ reason: string; by: string | null }>(
      `SELECT entered_in_error_reason AS reason, entered_in_error_by AS by
         FROM tooth_conditions WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.reason).toBe('Charted on the wrong tooth');
    expect(rows[0]?.by).not.toBeNull();

    const audit = await ownerQuery<{ action: string }>(
      'SELECT action FROM clinic_audit_log WHERE entity_id = $1 ORDER BY created_at',
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'clinical.finding_recorded',
      'clinical.finding_withdrawn',
    ]);
  });

  it('cannot be done twice', async () => {
    const id = await chartFinding(45);
    const body = { reason: 'Recorded twice' };
    await call(api, 'POST', `/api/tooth-conditions/${id}/entered-in-error`, as('dentist', body));
    const again = await call(api, 'POST', `/api/tooth-conditions/${id}/entered-in-error`, as('dentist', body));
    expect(again.status).toBe(409);
  });

  it('has no DELETE route any more', async () => {
    const id = await chartFinding(44);
    const res = await call(api, 'DELETE', `/api/tooth-conditions/${id}`, as('admin'));
    expect(res.status).toBe(404);
    expect((await chart()).map((c) => c.id)).toContain(id);
  });
});

describe('signing a procedure', () => {
  let procedureId: string;

  beforeAll(async () => {
    procedureId = await logProcedure();
  });

  it('is refused to reception', async () => {
    const res = await call(api, 'POST', `/api/procedures/${procedureId}/sign`, as('reception'));
    expect(res.status).toBe(403);
  });

  it('is allowed to a dentist, and locks the procedure', async () => {
    const signed = await call<{ signedAt: string | null }>(
      api,
      'POST',
      `/api/procedures/${procedureId}/sign`,
      as('dentist'),
    );
    expect(signed.status).toBe(201);
    expect(signed.body.signedAt).toEqual(expect.any(String));

    const edit = await call<{ message: string }>(
      api,
      'PATCH',
      `/api/procedures/${procedureId}`,
      as('dentist', { note: 'Changed my mind' }),
    );
    expect(edit.status).toBe(409);
    expect(edit.body.message).toMatch(/signed/i);
  });

  it('puts a signed procedure beyond reception’s reach', async () => {
    const res = await call(
      api,
      'POST',
      `/api/procedures/${procedureId}/entered-in-error`,
      as('reception', { reason: 'Wrong patient' }),
    );
    expect(res.status).toBe(403);
  });

  it('lets a clinician who can sign withdraw it', async () => {
    const res = await call(
      api,
      'POST',
      `/api/procedures/${procedureId}/entered-in-error`,
      as('dentist', { reason: 'Wrong patient' }),
    );
    expect(res.status).toBe(201);

    const list = await call<{ id: string }[]>(
      api,
      'GET',
      `/api/patients/${s.a.patientId}/procedures`,
      as('dentist'),
    );
    expect(list.body.map((p) => p.id)).not.toContain(procedureId);
  });

  it('refuses to sign work that is not finished', async () => {
    const planned = await logProcedure({ status: 'planned' });
    const res = await call(api, 'POST', `/api/procedures/${planned}/sign`, as('dentist'));
    expect(res.status).toBe(409);
  });
});

describe('withdrawing a procedure', () => {
  /** If the filling never happened, the caries it treated is still there. */
  it('reopens the finding it had marked as treated', async () => {
    const findingId = await chartFinding(37);
    const procedureId = await logProcedure({ tooth: 37, resolvesConditionIds: [findingId] });
    expect((await chart()).find((c) => c.id === findingId)?.status).toBe('treated');

    const res = await call(
      api,
      'POST',
      `/api/procedures/${procedureId}/entered-in-error`,
      as('dentist', { reason: 'Logged against the wrong visit' }),
    );
    expect(res.status).toBe(201);
    expect((await chart()).find((c) => c.id === findingId)?.status).toBe('active');
  });
});

describe('a periodontal exam', () => {
  /**
   * Also the regression for a bug this pass found: the exam used to be read
   * back through a second transaction that could not see the uncommitted
   * insert, so creating one answered 404.
   */
  it('starts, records readings, signs, and then refuses readings', async () => {
    const started = await call<{ id: string }>(
      api,
      'POST',
      `/api/patients/${s.a.patientId}/perio-exams`,
      as('dentist', {}),
    );
    expect(started.status).toBe(201);
    const examId = started.body.id;

    const reading = { measurements: [{ tooth: 16, site: 'MB', probingDepth: 3 }] };
    const saved = await call<{ summary: { sitesRecorded: number } }>(
      api,
      'POST',
      `/api/perio-exams/${examId}/measurements`,
      as('dentist', reading),
    );
    expect(saved.status).toBe(201);
    expect(saved.body.summary.sitesRecorded).toBe(1);

    const signed = await call<{ signedAt: string | null }>(
      api,
      'POST',
      `/api/perio-exams/${examId}/sign`,
      as('dentist'),
    );
    expect(signed.status).toBe(201);
    expect(signed.body.signedAt).toEqual(expect.any(String));

    const after = await call(api, 'POST', `/api/perio-exams/${examId}/measurements`, as('dentist', reading));
    expect(after.status).toBe(409);
  });
});

describe('notes', () => {
  it('are withdrawn, never deleted', async () => {
    const added = await call<{ id: string }>(
      api,
      'POST',
      `/api/patients/${s.a.patientId}/notes`,
      as('reception', { body: 'Called about pain on 36' }),
    );
    expect(added.status).toBe(201);

    const gone = await call(api, 'DELETE', `/api/patients/notes/${added.body.id}`, as('admin'));
    expect(gone.status).toBe(404);

    const withdrawn = await call(
      api,
      'POST',
      `/api/patients/notes/${added.body.id}/entered-in-error`,
      as('reception', { reason: 'Wrong patient' }),
    );
    expect(withdrawn.status).toBe(201);

    const patient = await call<{ notes: { id: string }[] }>(
      api,
      'GET',
      `/api/patients/${s.a.patientId}`,
      as('admin'),
    );
    expect(patient.body.notes.map((n) => n.id)).not.toContain(added.body.id);
  });
});

describe('record access', () => {
  it('records a read, where the administrator can see it', async () => {
    const read = await call(api, 'GET', `/api/patients/${s.a.patientId}`, as('reception'));
    expect(read.status).toBe(200);

    const log = await call<{ resource: string; actor: { role: string } }[]>(
      api,
      'GET',
      `/api/patients/${s.a.patientId}/access-log`,
      as('admin'),
    );
    expect(log.status).toBe(200);
    expect(
      log.body.some((e) => e.resource === 'record' && e.actor.role === 'receptionist'),
    ).toBe(true);
  });

  it('collapses repeat views of the same section within five minutes', async () => {
    await call(api, 'GET', `/api/patients/${s.a.patientId}/perio-exams`, as('dentist'));
    await call(api, 'GET', `/api/patients/${s.a.patientId}/perio-exams`, as('dentist'));

    const { rows } = await ownerQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_access_log
        WHERE patient_id = $1 AND resource = 'perio' AND actor_role = 'dentist'`,
      [s.a.patientId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('is not readable by anyone but the administrator', async () => {
    for (const who of ['reception', 'dentist'] as const) {
      const res = await call(api, 'GET', `/api/patients/${s.a.patientId}/access-log`, as(who));
      expect(res.status).toBe(403);
    }
  });
});

describe('radiographs are filed as what they are (0021)', () => {
  let docId: string;

  beforeAll(async () => {
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO patient_documents
         (tenant_id, patient_id, storage_key, file_name, content_type, byte_size, checksum, kind)
       VALUES ($1, $2, 'tenants/x/patients/y/opg.jpg', 'opg-2025.jpg', 'image/jpeg', 100, 'c', 'xray')
       RETURNING id`,
      [s.a.id, s.a.patientId],
    );
    docId = rows[0]!.id;
  });

  it('re-labels an old X-ray as the panoramic it is, and a scan as a CBCT', async () => {
    for (const kind of ['panoramic', 'cbct']) {
      const res = await call<{ kind: string }>(
        api,
        'PATCH',
        `/api/documents/${docId}`,
        as('dentist', { kind }),
      );
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe(kind);
    }
  });

  it('refuses a kind that is not one', async () => {
    const res = await call(
      api,
      'PATCH',
      `/api/documents/${docId}`,
      as('dentist', { kind: 'ultrasound' }),
    );
    expect(res.status).toBe(400);
  });
});
