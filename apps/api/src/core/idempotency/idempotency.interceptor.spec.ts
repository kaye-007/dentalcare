import { withoutSecrets } from './idempotency.interceptor';

/**
 * The request hash is only there to tell one request from another. A PIN
 * inside it would be a four-to-six-digit secret under a fast hash, readable
 * by anyone who can read idempotency_keys — the bcrypt the database keeps it
 * under, undone.
 */
describe('what the request hash is taken over', () => {
  it('leaves out a PIN at the top of the body', () => {
    expect(
      withoutSecrets({ approverUserId: 'u1', pin: '4821', reason: 'Recounted' }),
    ).toEqual({ approverUserId: 'u1', reason: 'Recounted' });
  });

  it('leaves out a PIN nested in an approval, as a payout sends it', () => {
    expect(
      withoutSecrets({
        currency: 'ALL',
        amount: 500_000,
        reason: 'Lab courier',
        approval: { approverUserId: 'u1', pin: '4821' },
      }),
    ).toEqual({
      currency: 'ALL',
      amount: 500_000,
      reason: 'Lab courier',
      approval: { approverUserId: 'u1' },
    });
  });

  it('leaves out passwords, inside arrays too', () => {
    expect(
      withoutSecrets([{ password: 'x', currentPassword: 'y', note: 'kept' }]),
    ).toEqual([{ note: 'kept' }]);
  });

  it('keeps everything else as it was', () => {
    const body = {
      items: [{ description: 'Kontroll', unitPrice: 1, quantity: 2 }],
      n: null,
    };
    expect(withoutSecrets(body)).toEqual(body);
    expect(withoutSecrets(null)).toBeNull();
    expect(withoutSecrets('text')).toBe('text');
  });

  it('tells two approvals apart by everything but the PIN', () => {
    const a = JSON.stringify(
      withoutSecrets({ approverUserId: 'u1', pin: '1111', reason: 'A' }),
    );
    const b = JSON.stringify(
      withoutSecrets({ approverUserId: 'u1', pin: '2222', reason: 'A' }),
    );
    const c = JSON.stringify(
      withoutSecrets({ approverUserId: 'u1', pin: '1111', reason: 'B' }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
