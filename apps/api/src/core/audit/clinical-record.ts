import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { can } from '@dentalcare/shared';
import {
  AuditAction,
  ClinicAuditActor,
  ClinicAuditService,
} from './clinic-audit.service';

/**
 * Withdrawing and signing clinical entries.
 *
 * Migration 0004 made the database refuse to delete anything clinical and
 * refuse to edit anything signed or withdrawn. This file is the application
 * side of the same rules: one implementation of "withdraw as entered in
 * error" for all seven tables, so the reason check, the signed-entry check
 * and the audit line cannot drift between modules.
 */

export const CLINICAL_TABLES = {
  tooth_conditions: { entityType: 'tooth_condition', signable: false },
  clinical_procedures: { entityType: 'clinical_procedure', signable: true },
  perio_exams: { entityType: 'perio_exam', signable: true },
  patient_notes: { entityType: 'patient_note', signable: false },
  patient_allergies: { entityType: 'patient_allergy', signable: false },
  patient_conditions: { entityType: 'patient_condition', signable: false },
  patient_medications: { entityType: 'patient_medication', signable: false },
} as const;

export type ClinicalTable = keyof typeof CLINICAL_TABLES;

/**
 * object_not_in_prerequisite_state — what the record guards raise when a row
 * is signed, withdrawn or already billed. Their messages are written for a
 * person, so they pass through as a 409 unchanged.
 */
export const RECORD_LOCKED = '55000';

export function isRecordLocked(err: unknown): err is { code: string; message: string } {
  return (err as { code?: string } | null)?.code === RECORD_LOCKED;
}

/** Map a record-guard refusal to 409; rethrow anything else untouched. */
export function rethrowRecordLocked(err: unknown): never {
  if (isRecordLocked(err)) throw new ConflictException(err.message);
  throw err;
}

/** The columns every withdrawable row carries, as `SELECT *` returns them. */
interface ClinicalRow {
  patient_id: string;
  entered_in_error_at: unknown;
}

/** "Arben Hoxha", for an activity line. Empty when the patient cannot be read. */
async function patientName(client: PoolClient, patientId: string): Promise<string> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT first_name || ' ' || last_name AS name FROM patients WHERE id = $1`,
    [patientId],
  );
  return rows[0]?.name ?? '';
}

export interface WithdrawalRequest<Row> {
  table: ClinicalTable;
  id: string;
  reason: string;
  action: AuditAction;
  /** What the entry was, in words, for the activity trail. */
  describe: (row: Row) => string;
  /** Optional extra check against the locked row, before anything is written. */
  assert?: (row: Row) => void;
}

/**
 * Withdraw one clinical entry as entered in error, inside the caller's
 * transaction, and record it in the activity trail.
 *
 * The row is locked FOR UPDATE first, so two people withdrawing the same
 * entry at once produce one withdrawal and one clean 409 — not a trigger
 * error for whoever came second.
 *
 * A SIGNED entry may only be withdrawn by someone who could have signed it.
 * Otherwise signing would mean nothing: an assistant who cannot sign a
 * procedure could still make a signed one vanish from the chart.
 *
 * The audit line carries the reason but not a copy of the row. The row is
 * still in the database, and copying clinical content into a second table is
 * a second place it has to be protected.
 */
export async function withdrawEntry<Row extends ClinicalRow>(
  client: PoolClient,
  audit: ClinicAuditService,
  actor: ClinicAuditActor,
  req: WithdrawalRequest<Row>,
): Promise<Row> {
  const spec = CLINICAL_TABLES[req.table];
  const reason = req.reason.trim();
  if (reason.length < 3) {
    throw new BadRequestException('Say why this entry is wrong — the record keeps your reason');
  }

  const { rows } = await client.query<Row & { signed_at?: unknown }>(
    `SELECT * FROM ${req.table} WHERE id = $1 FOR UPDATE`,
    [req.id],
  );
  const row = rows[0];
  if (!row) throw new NotFoundException('That entry was not found');
  if (row.entered_in_error_at) {
    throw new ConflictException('That entry was already withdrawn as entered in error');
  }
  if (spec.signable && row.signed_at && !can(actor.role, 'clinical:sign')) {
    throw new ForbiddenException(
      'This entry is signed. Only a clinician who can sign may withdraw it.',
    );
  }
  req.assert?.(row);

  try {
    await client.query(
      `UPDATE ${req.table}
          SET entered_in_error_at = now(),
              entered_in_error_by = $2,
              entered_in_error_reason = $3
        WHERE id = $1`,
      [req.id, actor.userId, reason],
    );
  } catch (err) {
    rethrowRecordLocked(err);
  }

  const patient = await patientName(client, row.patient_id);
  await audit.record(client, actor, {
    action: req.action,
    entityType: spec.entityType,
    entityId: req.id,
    summary: `Withdrew ${req.describe(row)}${patient ? ` for ${patient}` : ''} as entered in error: ${reason}`,
    metadata: { patientId: row.patient_id, reason },
  });

  return row;
}

/**
 * Sign a procedure or perio exam. Signing is final: the record guard refuses
 * every later edit, so this refuses up front with the words a person needs
 * rather than letting them meet the trigger.
 */
export async function signEntry<Row extends ClinicalRow & { signed_at: unknown }>(
  client: PoolClient,
  audit: ClinicAuditService,
  actor: ClinicAuditActor,
  req: {
    table: 'clinical_procedures' | 'perio_exams';
    id: string;
    action: AuditAction;
    describe: (row: Row) => string;
    assert?: (row: Row) => void;
  },
): Promise<Row> {
  if (!can(actor.role, 'clinical:sign')) {
    throw new ForbiddenException('Your role cannot sign clinical entries');
  }
  const { rows } = await client.query<Row>(
    `SELECT * FROM ${req.table} WHERE id = $1 FOR UPDATE`,
    [req.id],
  );
  const row = rows[0];
  if (!row || row.entered_in_error_at) throw new NotFoundException('That entry was not found');
  if (row.signed_at) throw new ConflictException('That entry is already signed');
  req.assert?.(row);

  try {
    await client.query(
      `UPDATE ${req.table} SET signed_at = now(), signed_by = $2 WHERE id = $1`,
      [req.id, actor.userId],
    );
  } catch (err) {
    rethrowRecordLocked(err);
  }

  const patient = await patientName(client, row.patient_id);
  await audit.record(client, actor, {
    action: req.action,
    entityType: CLINICAL_TABLES[req.table].entityType,
    entityId: req.id,
    summary: `Signed ${req.describe(row)}${patient ? ` for ${patient}` : ''}`,
    metadata: { patientId: row.patient_id },
  });
  return row;
}
