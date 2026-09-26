import {
  MAX_ATTEMPTS,
  applyReceipt,
  providerStatusToReminder,
  retryDelayMinutes,
} from './delivery-policy';

describe('retryDelayMinutes', () => {
  it('backs off, then stops at the attempt limit', () => {
    expect(retryDelayMinutes(1)).toBe(5);
    expect(retryDelayMinutes(2)).toBe(30);
    expect(retryDelayMinutes(MAX_ATTEMPTS)).toBeNull();
    expect(retryDelayMinutes(0)).toBeNull();
  });
});

describe('providerStatusToReminder', () => {
  it.each([
    ['queued', 'sent'],
    ['sent', 'sent'],
    ['delivered', 'delivered'],
    ['read', 'delivered'],
    ['undelivered', 'failed'],
    ['failed', 'failed'],
  ])('%s -> %s', (provider, ours) => {
    expect(providerStatusToReminder(provider)).toBe(ours);
  });

  it('does not guess at a status it has never seen', () => {
    expect(providerStatusToReminder('partially_delivered')).toBeNull();
  });
});

describe('applyReceipt', () => {
  it('moves a reminder forward', () => {
    expect(applyReceipt('sending', 'sent')).toBe(true);
    expect(applyReceipt('sent', 'delivered')).toBe(true);
    expect(applyReceipt('sent', 'failed')).toBe(true);
  });

  it('never backwards, whatever order the receipts arrive in', () => {
    expect(applyReceipt('delivered', 'sent')).toBe(false);
    expect(applyReceipt('delivered', 'failed')).toBe(false);
    expect(applyReceipt('failed', 'sent')).toBe(false);
  });

  it('gives no delivery status to a reminder that was never sent', () => {
    expect(applyReceipt('skipped', 'delivered')).toBe(false);
  });
});
