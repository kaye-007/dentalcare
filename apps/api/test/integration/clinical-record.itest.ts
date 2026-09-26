import { asTenant, closePools, errorCodeOf, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The clinical record, at the database — migration 0004.
 *
 * Every rule here is enforced below the application: by a missing privilege,
 * or by a trigger that fires whatever the application believes. So every
 * assertion connects as app_user, the runtime role, and tries the thing a bug
 * or a compromised process would try.
 *
 *   42501  insufficient_privilege            — the role was never granted it
 *   55000  object_not_in_prerequisite_state  — a record guard refused it
 */

const DENIED = '42501';
const LOCKED = '55000';

let s: Scenario;

beforeAll(async () => {
  s = await createScenario();
});

afterAll(async () => {
  await destroyScenario(s);
  await closePools();
});

async function insert(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await owner().query<{ id: string }>(`${sql} RETURNING id`, params);
  return rows[0]!.id;
}

/**
 * A fresh tooth per call. Active findings are unique per (patient, tooth,
 * surface, condition), so every test that leaves one behind would otherwise
 * collide with the next test's insert.
 */
const TEETH = [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36];
let nextTooth = 0;

const finding = (tooth = TEETH[nextTooth++ % TEETH.length]) =>
  insert(
    `INSERT INTO tooth_conditions (tenant_id, patient_id, tooth, condition)
     VALUES ($1, $2, $3, 'caries')`,
    [s.a.id, s.a.patientId, tooth],
  );

const procedure = (status = 'completed') =>
  insert(
    `INSERT INTO clinical_procedures (tenant_id, patient_id, tooth, description, status, fee)
     VALUES ($1, $2, 36, 'Composite filling', $3, 3000)`,
    [s.a.id, s.a.patientId, status],
  );

const note = () =>
  insert(
    `INSERT INTO patient_notes (tenant_id, patient_id, body) VALUES ($1, $2, 'Initial note')`,
    [s.a.id, s.a.patientId],
  );

const exam = () =>
  insert(`INSERT INTO perio_exams (tenant_id, patient_id) VALUES ($1, $2)`, [
    s.a.id,
    s.a.patientId,
  ]);

const withdraw = (table: string, id: string) =>
  asTenant(s.a.id, (c) =>
    c.query(
      `UPDATE ${table}
          SET entered_in_error_at = now(), entered_in_error_by = $1,
              entered_in_error_reason = 'Recorded on the wrong patient'
        WHERE id = $2`,
      [s.a.adminId, id],
    ),
  );

describe('nothing clinical can be deleted by the runtime role', () => {
  it.each([
    ['tooth_conditions', finding],
    ['clinical_procedures', () => procedure()],
    ['patient_notes', note],
    ['perio_exams', exam],
    [
      'patient_allergies',
      () =>
        insert(
          `INSERT INTO patient_allergies (tenant_id, patient_id, substance, severity)
           VALUES ($1, $2, 'Latex-' || gen_random_uuid(), 'severe')`,
          [s.a.id, s.a.patientId],
        ),
    ],
  ])('cannot DELETE from %s', async (table, make) => {
    const id = await make();
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) => c.query(`DELETE FROM ${table} WHERE id = $1`, [id])),
    );
    expect(code).toBe(DENIED);
  });

  /**
   * Every clinical table cascades from patients. Referential actions run as
   * the table owner, not the caller, so a DELETE on patients would erase the
   * whole record in one statement if the role still held it.
   */
  it('cannot DELETE a patient, which would cascade through the record', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) => c.query('DELETE FROM patients WHERE id = $1', [s.a.patientId])),
    );
    expect(code).toBe(DENIED);
  });
});

describe('withdrawal', () => {
  it('is possible, and keeps the row', async () => {
    const id = await finding();
    await withdraw('tooth_conditions', id);

    const { rows } = await ownerQuery<{ entered_in_error_reason: string }>(
      'SELECT entered_in_error_reason FROM tooth_conditions WHERE id = $1',
      [id],
    );
    expect(rows[0]?.entered_in_error_reason).toBe('Recorded on the wrong patient');
  });

  it('freezes the row: nothing about it can change afterwards', async () => {
    const id = await finding();
    await withdraw('tooth_conditions', id);

    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(`UPDATE tooth_conditions SET status = 'treated' WHERE id = $1`, [id]),
      ),
    );
    expect(code).toBe(LOCKED);
  });

  it('cannot be combined with an edit in the same statement', async () => {
    const id = await finding();
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `UPDATE tooth_conditions
              SET note = 'rewritten', entered_in_error_at = now(),
                  entered_in_error_reason = 'Covering tracks'
            WHERE id = $1`,
          [id],
        ),
      ),
    );
    expect(code).toBe(LOCKED);
  });

  it('requires a reason', async () => {
    const id = await finding();
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `UPDATE tooth_conditions SET entered_in_error_at = now() WHERE id = $1`,
          [id],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('frees the finding it withdrew to be charted correctly', async () => {
    const id = await finding(48);
    await withdraw('tooth_conditions', id);
    // Same patient, tooth, surface and condition, still active: the unique
    // index ignores withdrawn rows.
    await expect(finding(48)).resolves.toEqual(expect.any(String));
  });

  it('still refuses a true duplicate of a live finding', async () => {
    await finding(47);
    const code = await errorCodeOf(finding(47));
    expect(code).toBe('23505');
  });
});

describe('notes are written once', () => {
  it('cannot have their body edited', async () => {
    const id = await note();
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(`UPDATE patient_notes SET body = 'rewritten' WHERE id = $1`, [id]),
      ),
    );
    expect(code).toBe(DENIED);
  });

  it('CAN be withdrawn, which is the one column-level grant left', async () => {
    const id = await note();
    await expect(withdraw('patient_notes', id)).resolves.toBeDefined();
  });
});

describe('signing', () => {
  const sign = (table: string, id: string) =>
    asTenant(s.a.id, (c) =>
      c.query(`UPDATE ${table} SET signed_at = now(), signed_by = $1 WHERE id = $2`, [
        s.a.adminId,
        id,
      ]),
    );

  it('locks a procedure against every edit', async () => {
    const id = await procedure();
    await sign('clinical_procedures', id);

    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(`UPDATE clinical_procedures SET fee = 1 WHERE id = $1`, [id]),
      ),
    );
    expect(code).toBe(LOCKED);
  });

  it('still lets a signed procedure be withdrawn', async () => {
    const id = await procedure();
    await sign('clinical_procedures', id);
    await expect(withdraw('clinical_procedures', id)).resolves.toBeDefined();
  });

  it('refuses to sign unfinished work', async () => {
    const id = await procedure('planned');
    const code = await errorCodeOf(sign('clinical_procedures', id));
    expect(code).toBe('23514');
  });

  it('cannot change a procedure in the same statement that signs it', async () => {
    const id = await procedure();
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `UPDATE clinical_procedures SET fee = 1, signed_at = now() WHERE id = $1`,
          [id],
        ),
      ),
    );
    expect(code).toBe(LOCKED);
  });

  it('refuses new readings against a signed perio exam', async () => {
    const id = await exam();
    await owner().query(
      `INSERT INTO perio_measurements (tenant_id, exam_id, tooth, site, probing_depth)
       VALUES ($1, $2, 16, 'MB', 3)`,
      [s.a.id, id],
    );
    await sign('perio_exams', id);

    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO perio_measurements (tenant_id, exam_id, tooth, site, probing_depth)
           VALUES ($1, $2, 16, 'B', 4)`,
          [s.a.id, id],
        ),
      ),
    );
    expect(code).toBe(LOCKED);
  });

  it('refuses to rewrite an existing reading on a signed exam', async () => {
    const id = await exam();
    await owner().query(
      `INSERT INTO perio_measurements (tenant_id, exam_id, tooth, site, probing_depth)
       VALUES ($1, $2, 16, 'MB', 3)`,
      [s.a.id, id],
    );
    await sign('perio_exams', id);

    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(`UPDATE perio_measurements SET probing_depth = 9 WHERE exam_id = $1`, [id]),
      ),
    );
    expect(code).toBe(LOCKED);
  });
});

describe('billed work stays as billed', () => {
  async function invoiced(): Promise<{ procedureId: string; invoiceId: string }> {
    const procedureId = await procedure();
    const seq = Math.floor(Math.random() * 1_000_000_000);
    const invoiceId = await insert(
      `INSERT INTO invoices (tenant_id, patient_id, seq, invoice_number, total, subtotal, status)
       VALUES ($1, $2, $3, $4, 3000, 3000, 'unpaid')`,
      [s.a.id, s.a.patientId, seq, `INV-C-${seq}`],
    );
    await owner().query(
      `INSERT INTO invoice_line_items
         (tenant_id, invoice_id, description, quantity, unit_price, amount, procedure_id)
       VALUES ($1, $2, 'Composite filling', 1, 3000, 3000, $3)`,
      [s.a.id, invoiceId, procedureId],
    );
    return { procedureId, invoiceId };
  }

  it('refuses to change the fee of a procedure on a live invoice', async () => {
    const { procedureId } = await invoiced();
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(`UPDATE clinical_procedures SET fee = 1 WHERE id = $1`, [procedureId]),
      ),
    );
    expect(code).toBe(LOCKED);
  });

  it('refuses to withdraw a procedure on a live invoice', async () => {
    const { procedureId } = await invoiced();
    const code = await errorCodeOf(withdraw('clinical_procedures', procedureId));
    expect(code).toBe(LOCKED);
  });

  it('allows it once the invoice is cancelled', async () => {
    const { procedureId, invoiceId } = await invoiced();
    await owner().query(
      `UPDATE invoices SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'test'
        WHERE id = $1`,
      [invoiceId],
    );
    await expect(withdraw('clinical_procedures', procedureId)).resolves.toBeDefined();
  });
});

describe('the record-access log is append-only', () => {
  let entryId: string;

  beforeAll(async () => {
    const { rows } = await asTenant(s.a.id, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO patient_access_log
           (tenant_id, patient_id, actor_user_id, actor_label, actor_role, resource)
         VALUES ($1, $2, $3, 'admin@test', 'admin', 'chart')
         RETURNING id`,
        [s.a.id, s.a.patientId, s.a.adminId],
      ),
    );
    entryId = rows[0]!.id;
  });

  it('cannot be rewritten', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(`UPDATE patient_access_log SET resource = 'record' WHERE id = $1`, [entryId]),
      ),
    );
    expect(code).toBe(DENIED);
  });

  it('cannot be erased', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) => c.query('DELETE FROM patient_access_log WHERE id = $1', [entryId])),
    );
    expect(code).toBe(DENIED);
  });

  it('cannot be rewritten even by the owner role', async () => {
    const code = await errorCodeOf(
      owner().query(`UPDATE patient_access_log SET resource = 'record' WHERE id = $1`, [entryId]),
    );
    expect(code).toBe(DENIED);
  });

  it('is invisible to another clinic', async () => {
    const { rows } = await asTenant(s.b.id, (c) =>
      c.query('SELECT id FROM patient_access_log WHERE id = $1', [entryId]),
    );
    expect(rows).toEqual([]);
  });
});
