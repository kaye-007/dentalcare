import { DELIVERY_WINDOW_HOURS, queueTiming } from './fiscal-queue';

const ISSUED = '2026-09-17T08:00:00+02:00';
const at = (hoursAfter: number) => new Date(new Date(ISSUED).getTime() + hoursAfter * 3_600_000);

describe('fiscal delivery window', () => {
  it('counts from when the invoice was issued, not from the last attempt', () => {
    const t = queueTiming(ISSUED, at(3));
    expect(t.ageMs).toBe(3 * 3_600_000);
    expect(new Date(t.deliverBy).getTime()).toBe(new Date(ISSUED).getTime() + DELIVERY_WINDOW_HOURS * 3_600_000);
    expect(t.msLeft).toBe(45 * 3_600_000);
  });

  it('stays routine for the first hours, while the retries work', () => {
    expect(queueTiming(ISSUED, at(0)).urgency).toBe('routine');
    expect(queueTiming(ISSUED, at(11.9)).urgency).toBe('routine');
  });

  it('asks for a look after twelve hours and for action after forty', () => {
    expect(queueTiming(ISSUED, at(12)).urgency).toBe('watch');
    expect(queueTiming(ISSUED, at(39.9)).urgency).toBe('watch');
    expect(queueTiming(ISSUED, at(40)).urgency).toBe('urgent');
    expect(queueTiming(ISSUED, at(47.9)).urgency).toBe('urgent');
  });

  it('is overdue exactly at the 48-hour limit, and stays overdue', () => {
    expect(queueTiming(ISSUED, at(48))).toMatchObject({ overdue: true, urgency: 'overdue', msLeft: 0 });
    expect(queueTiming(ISSUED, at(60)).overdue).toBe(true);
    expect(queueTiming(ISSUED, at(60)).msLeft).toBeLessThan(0);
  });

  it('never reports a negative age for a clock that ran backwards', () => {
    expect(queueTiming(ISSUED, at(-1)).ageMs).toBe(0);
  });
});
