import { asTenant, closePools, errorCodeOf, ownerQuery } from './db';
import { createOperatory, createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Double-booking, refused by the database rather than by a check-then-insert.
 *
 * The distinction is the whole point. A service that SELECTs for a conflict
 * and then INSERTs has a window between the two, and the front desk is
 * exactly the place where two people book the same slot in the same second.
 * An EXCLUDE constraint is evaluated by the index at write time, so the
 * second writer loses no matter how close the two are.
 *
 * These tests therefore assert on the constraint, by name, from app_user —
 * the role the API actually uses.
 */

/** exclusion_violation. */
const CONFLICT = '23P01';

let s: Scenario;
let operatoryA: string;
let secondPatient: string;

const SLOT = {
  start: '2027-03-01T09:00:00Z',
  end: '2027-03-01T10:00:00Z',
};
/** Starts inside the first slot and runs past it. */
const OVERLAP = {
  start: '2027-03-01T09:30:00Z',
  end: '2027-03-01T10:30:00Z',
};
/** Begins exactly where the first ends — the ranges are '[)', so it fits. */
const ADJACENT = {
  start: '2027-03-01T10:00:00Z',
  end: '2027-03-01T11:00:00Z',
};

beforeAll(async () => {
  s = await createScenario();
  operatoryA = await createOperatory(s.a);

  const { rows } = await ownerQuery<{ id: string }>(
    `INSERT INTO patients (tenant_id, first_name, last_name, status)
     VALUES ($1, 'Second', 'Patient', 'active') RETURNING id`,
    [s.a.id],
  );
  secondPatient = rows[0].id;
});

afterAll(async () => {
  await destroyScenario(s);
  await closePools();
});

/** Book an appointment as clinic A, returning the PostgreSQL error code or null. */
function book(fields: {
  patientId: string;
  staffId?: string | null;
  operatoryId?: string | null;
  start: string;
  end: string;
}): Promise<string | null> {
  return errorCodeOf(
    asTenant(s.a.id, (c) =>
      c.query(
        `INSERT INTO appointments
           (tenant_id, patient_id, staff_id, operatory_id, reason, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, 'Checkup', $5, $6)`,
        [
          s.a.id,
          fields.patientId,
          fields.staffId ?? null,
          fields.operatoryId ?? null,
          fields.start,
          fields.end,
        ],
      ),
    ),
  );
}

describe('one dentist cannot be in two places at once', () => {
  it('accepts the first booking', async () => {
    const code = await book({
      patientId: s.a.patientId,
      staffId: s.a.adminId,
      ...SLOT,
    });

    expect(code).toBeNull();
  });

  it('refuses an overlapping booking for the same dentist', async () => {
    const code = await book({
      patientId: secondPatient,
      staffId: s.a.adminId,
      ...OVERLAP,
    });

    expect(code).toBe(CONFLICT);
  });

  /**
   * The ranges are half-open, `[)`, so 10:00–11:00 does not overlap
   * 09:00–10:00. Back-to-back appointments are the normal case and must not
   * be refused — a constraint that rejected them would be discovered by the
   * front desk, not by a test.
   */
  it('allows a booking that starts exactly when the last one ends', async () => {
    const code = await book({
      patientId: secondPatient,
      staffId: s.a.adminId,
      ...ADJACENT,
    });

    expect(code).toBeNull();
  });
});

describe('one chair cannot hold two patients at once', () => {
  const CHAIR = {
    start: '2027-04-01T09:00:00Z',
    end: '2027-04-01T10:00:00Z',
  };

  it('accepts the first booking in the room', async () => {
    const code = await book({
      patientId: s.a.patientId,
      operatoryId: operatoryA,
      ...CHAIR,
    });

    expect(code).toBeNull();
  });

  it('refuses a second patient in the same room at the same time', async () => {
    const code = await book({
      patientId: secondPatient,
      operatoryId: operatoryA,
      start: '2027-04-01T09:15:00Z',
      end: '2027-04-01T09:45:00Z',
    });

    expect(code).toBe(CONFLICT);
  });
});

describe('one patient cannot be in two appointments at once', () => {
  const PATIENT_SLOT = {
    start: '2027-05-01T09:00:00Z',
    end: '2027-05-01T10:00:00Z',
  };

  it('accepts the first appointment', async () => {
    const code = await book({ patientId: s.a.patientId, ...PATIENT_SLOT });

    expect(code).toBeNull();
  });

  /**
   * The mistake a busy front desk actually makes: two people booking the same
   * person, with no dentist or room assigned yet, so neither of the other two
   * constraints would catch it.
   */
  it('refuses a second overlapping appointment for the same patient', async () => {
    const code = await book({
      patientId: s.a.patientId,
      start: '2027-05-01T09:30:00Z',
      end: '2027-05-01T10:30:00Z',
    });

    expect(code).toBe(CONFLICT);
  });
});

describe('cancelled appointments free the slot', () => {
  /**
   * The constraints are partial — `WHERE status IN (...)` over the blocking
   * statuses only. A cancelled appointment must stop reserving the room, or
   * every cancellation would permanently burn a slot in the calendar.
   */
  it('a cancelled appointment does not block a rebooking', async () => {
    const slot = { start: '2027-06-01T09:00:00Z', end: '2027-06-01T10:00:00Z' };

    const first = await book({
      patientId: s.a.patientId,
      operatoryId: operatoryA,
      ...slot,
    });
    expect(first).toBeNull();

    // Still blocking while it stands.
    expect(
      await book({ patientId: secondPatient, operatoryId: operatoryA, ...slot }),
    ).toBe(CONFLICT);

    await ownerQuery(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = now()
        WHERE tenant_id = $1 AND operatory_id = $2 AND starts_at = $3`,
      [s.a.id, operatoryA, slot.start],
    );

    expect(
      await book({ patientId: secondPatient, operatoryId: operatoryA, ...slot }),
    ).toBeNull();
  });
});

describe('the constraints exist as constraints', () => {
  /**
   * Named explicitly, so that removing one is a visible act rather than a
   * behaviour that quietly stops being tested if a fixture changes shape.
   */
  it.each([
    'appointment_no_staff_overlap',
    'appointment_no_operatory_overlap',
    'appointment_no_patient_overlap',
  ])('%s is an EXCLUDE constraint on appointments', async (name) => {
    const { rows } = await ownerQuery<{ contype: string }>(
      `SELECT contype FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'appointments'::regclass`,
      [name],
    );

    expect(rows).toHaveLength(1);
    // 'x' is an exclusion constraint. A trigger or a CHECK would not be
    // race-free, which is the entire reason for choosing this.
    expect(rows[0].contype).toBe('x');
  });
});
