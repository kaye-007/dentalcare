import {
  nextStep,
  refusal,
  stageFromStamps,
  stampsAfter,
  type LabStamps,
} from './lab-status';

const NONE: LabStamps = { sentAt: null, receivedAt: null, fittedAt: null };
const T0 = new Date('2026-09-20T09:00:00Z');
const NOW = new Date('2026-09-28T10:00:00Z');

describe('lab work: moving along', () => {
  it('offers one next step at a time, and none once fitted or cancelled', () => {
    expect(nextStep('preparing')).toBe('sent');
    expect(nextStep('sent')).toBe('received');
    expect(nextStep('received')).toBe('fitted');
    expect(nextStep('fitted')).toBeNull();
    expect(nextStep('cancelled')).toBeNull();
  });

  it('allows any step forward, and fills a skipped stamp with the same moment', () => {
    expect(refusal('preparing', 'received', NONE, NOW)).toBeNull();
    expect(stampsAfter('received', NONE, NOW)).toEqual({
      sentAt: NOW,
      receivedAt: NOW,
      fittedAt: null,
    });
  });

  it('keeps the stamps it already had when moving on', () => {
    const sent = { ...NONE, sentAt: T0 };
    expect(stampsAfter('received', sent, NOW)).toEqual({
      sentAt: T0,
      receivedAt: NOW,
      fittedAt: null,
    });
  });

  it('undoes one step, and only one, clearing its stamp', () => {
    const back = { sentAt: T0, receivedAt: T0, fittedAt: null };
    expect(refusal('received', 'sent', back, NOW)).toBeNull();
    expect(stampsAfter('sent', back, NOW)).toEqual({
      sentAt: T0,
      receivedAt: null,
      fittedAt: null,
    });
    expect(refusal('received', 'preparing', back, NOW)).toMatch(/one step/);
  });

  it('takes back a Fitted tapped a moment ago, and never changes it after that', () => {
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const justNow = { sentAt: T0, receivedAt: T0, fittedAt: minutesAgo(1) };
    expect(refusal('fitted', 'received', justNow, NOW)).toBeNull();
    expect(stampsAfter('received', justNow, NOW)).toEqual({
      sentAt: T0,
      receivedAt: T0,
      fittedAt: null,
    });
    // Only the one step back, and never to cancelled.
    expect(refusal('fitted', 'sent', justNow, NOW)).toMatch(/finished/);
    expect(refusal('fitted', 'cancelled', justNow, NOW)).toMatch(/finished/);

    const settled = { sentAt: T0, receivedAt: T0, fittedAt: minutesAgo(11) };
    expect(refusal('fitted', 'received', settled, NOW)).toMatch(/finished/);
    expect(refusal('fitted', 'cancelled', settled, NOW)).toMatch(/finished/);
  });

  it('cancels from any open step, and reinstates to where the stamps say', () => {
    const atLab = { ...NONE, sentAt: T0 };
    expect(refusal('sent', 'cancelled', atLab, NOW)).toBeNull();
    expect(stageFromStamps(atLab)).toBe('sent');
    expect(refusal('cancelled', 'sent', atLab, NOW)).toBeNull();
    expect(refusal('cancelled', 'preparing', atLab, NOW)).toMatch(/where it was/);
  });

  it('refuses a move to where it already is', () => {
    expect(refusal('sent', 'sent', { ...NONE, sentAt: T0 }, NOW)).toMatch(/already/);
  });
});
