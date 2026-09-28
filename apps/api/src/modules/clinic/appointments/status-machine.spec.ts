import { APPOINTMENT_STATUSES, BLOCKING_STATUSES, STATUS_LABELS, TIMESTAMP_COLUMN, allowedTransitions, canTransition, explainRefusal, isBlocking, isStatus, type AppointmentStatus } from './status-machine';

describe('appointment status machine', () => {
  it('declares exactly the six documented statuses', () => {
    expect(APPOINTMENT_STATUSES).toEqual([
      'scheduled', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show',
    ]);
  });

  it('walks the happy path end to end', () => {
    expect(canTransition('scheduled', 'checked_in')).toBe(true);
    expect(canTransition('checked_in', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });

  it('allows the front desk to skip ahead when the day is busy', () => {
    // A walk-in seen immediately should not require three clicks.
    expect(canTransition('scheduled', 'in_progress')).toBe(true);
    expect(canTransition('scheduled', 'completed')).toBe(true);
    expect(canTransition('checked_in', 'completed')).toBe(true);
  });

  it('treats completed as terminal — billing depends on it', () => {
    expect(allowedTransitions('completed')).toEqual([]);
    for (const s of APPOINTMENT_STATUSES) {
      expect(canTransition('completed', s)).toBe(false);
    }
  });

  it('never marks a patient absent once treatment has started', () => {
    expect(canTransition('in_progress', 'no_show')).toBe(false);
    expect(canTransition('checked_in', 'no_show')).toBe(true);
    expect(canTransition('scheduled', 'no_show')).toBe(true);
  });

  it('lets in_progress only finish or be abandoned', () => {
    expect(allowedTransitions('in_progress')).toEqual(['completed', 'cancelled']);
  });

  it('reinstates a mistake to scheduled and nowhere else', () => {
    expect(allowedTransitions('cancelled')).toEqual(['scheduled']);
    expect(allowedTransitions('no_show')).toEqual(['scheduled']);
    expect(canTransition('cancelled', 'completed')).toBe(false);
    expect(canTransition('no_show', 'in_progress')).toBe(false);
  });

  it('lets a check-in be taken back, but not treatment once it has started', () => {
    expect(canTransition('checked_in', 'scheduled')).toBe(true);
    expect(canTransition('in_progress', 'scheduled')).toBe(false);
    expect(canTransition('in_progress', 'checked_in')).toBe(false);
  });

  it('never allows a self-transition', () => {
    for (const s of APPOINTMENT_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('has no transition to an undeclared status', () => {
    for (const s of APPOINTMENT_STATUSES) {
      for (const t of allowedTransitions(s)) {
        expect(APPOINTMENT_STATUSES).toContain(t);
      }
    }
  });

  it('keeps every non-terminal status able to reach a terminal one', () => {
    const terminal = (s: AppointmentStatus) => allowedTransitions(s).length === 0;
    for (const start of APPOINTMENT_STATUSES) {
      const seen = new Set<AppointmentStatus>([start]);
      const queue: AppointmentStatus[] = [start];
      let reached = false;
      while (queue.length) {
        const cur = queue.shift()!;
        if (terminal(cur)) { reached = true; break; }
        for (const next of allowedTransitions(cur)) {
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      expect(reached).toBe(true);
    }
  });
});

describe('blocking statuses', () => {
  it('blocks exactly the states that occupy a chair', () => {
    expect(BLOCKING_STATUSES).toEqual(['scheduled', 'checked_in', 'in_progress']);
    expect(isBlocking('scheduled')).toBe(true);
    expect(isBlocking('checked_in')).toBe(true);
    expect(isBlocking('in_progress')).toBe(true);
  });

  it('frees the slot once the appointment is resolved', () => {
    expect(isBlocking('completed')).toBe(false);
    expect(isBlocking('cancelled')).toBe(false);
    expect(isBlocking('no_show')).toBe(false);
  });
});

describe('status guards and labels', () => {
  it('recognises only real statuses', () => {
    for (const s of APPOINTMENT_STATUSES) expect(isStatus(s)).toBe(true);
    for (const bad of ['canceled', 'CHECKED_IN', 'pending', '', null, undefined, 3, {}]) {
      expect(isStatus(bad)).toBe(false);
    }
  });

  it('labels every status', () => {
    for (const s of APPOINTMENT_STATUSES) {
      expect(STATUS_LABELS[s]).toBeTruthy();
    }
  });

  it('stamps a timestamp for every status that has one, and only those', () => {
    expect(Object.keys(TIMESTAMP_COLUMN).sort()).toEqual(
      ['cancelled', 'checked_in', 'completed', 'in_progress'],
    );
    // no_show deliberately has none — absence is not an event with a duration.
    expect(TIMESTAMP_COLUMN.no_show).toBeUndefined();
    expect(TIMESTAMP_COLUMN.scheduled).toBeUndefined();
  });
});

describe('refusal messages', () => {
  it('explains a repeat click without sounding like an error', () => {
    expect(explainRefusal('completed', 'completed')).toContain('already completed');
  });

  it('names the real reason a completed appointment is frozen', () => {
    expect(explainRefusal('completed', 'scheduled')).toContain('cannot be changed');
  });

  it('explains why a patient mid-treatment is not a no-show', () => {
    expect(explainRefusal('in_progress', 'no_show')).toContain('already in progress');
  });

  it('tells the user what they CAN do', () => {
    const msg = explainRefusal('in_progress', 'checked_in');
    expect(msg).toContain('Completed');
    expect(msg).toContain('Cancelled');
  });

  it('produces a non-empty message for every illegal pair', () => {
    for (const from of APPOINTMENT_STATUSES) {
      for (const to of APPOINTMENT_STATUSES) {
        if (!canTransition(from, to)) {
          expect(explainRefusal(from, to).length).toBeGreaterThan(10);
        }
      }
    }
  });
});
