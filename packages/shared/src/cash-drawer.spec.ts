import {
  DEFAULT_VARIANCE_THRESHOLDS,
  DRAWER_DENOMINATIONS,
  countTotal,
  expectedCash,
  varianceBand,
} from './cash-drawer';
import { CURRENCIES } from './money';

describe('drawer denominations', () => {
  it.each(CURRENCIES)('lists %s largest first with no repeats', (currency) => {
    const list = DRAWER_DENOMINATIONS[currency];
    expect([...list].sort((a, b) => b - a)).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
    expect(list.every((d) => Number.isInteger(d) && d > 0)).toBe(true);
  });

  it('counts lek in minor units: a 5000 note and three 100 coins are ALL 5,300', () => {
    expect(countTotal('ALL', { '500000': 1, '10000': 3 })).toBe(530_000);
  });

  it('refuses a denomination the currency does not have', () => {
    expect(countTotal('ALL', { '300000': 1 })).toBeNull();
    expect(countTotal('EUR', { '1000000': 1 })).toBeNull();
  });

  it('refuses fractional, negative and absurd quantities', () => {
    expect(countTotal('EUR', { '500': 1.5 })).toBeNull();
    expect(countTotal('EUR', { '500': -1 })).toBeNull();
    expect(countTotal('EUR', { '500': 1_000_000 })).toBeNull();
  });

  it('treats an empty count as zero, which is a real answer for an empty drawer', () => {
    expect(countTotal('EUR', {})).toBe(0);
  });
});

describe('expectedCash', () => {
  it('adds the float and sales, takes off voids, payouts and drops, per currency', () => {
    expect(
      expectedCash([
        { type: 'open', currency: 'ALL', amount: 1_000_000 },
        { type: 'open', currency: 'EUR', amount: 10_000 },
        { type: 'cash_sale', currency: 'ALL', amount: 850_000 },
        { type: 'cash_sale', currency: 'ALL', amount: 200_000 },
        { type: 'cash_sale_voided', currency: 'ALL', amount: 200_000 },
        { type: 'payout', currency: 'ALL', amount: 50_000 },
        { type: 'drop', currency: 'ALL', amount: 500_000 },
        { type: 'add_float', currency: 'EUR', amount: 5_000 },
        { type: 'no_sale', currency: 'ALL', amount: 0 },
      ]),
    ).toEqual({ ALL: 1_300_000, EUR: 15_000 });
  });

  it('ignores a void recorded after the session closed', () => {
    expect(
      expectedCash([
        { type: 'open', currency: 'ALL', amount: 100 },
        { type: 'post_close_void', currency: 'ALL', amount: 100 },
      ]),
    ).toEqual({ ALL: 100 });
  });
});

describe('varianceBand', () => {
  const t = DEFAULT_VARIANCE_THRESHOLDS.ALL;

  it('asks nothing within tolerance, including exactly at it', () => {
    expect(varianceBand(0, t)).toBe('exact');
    expect(varianceBand(t.tolerance, t)).toBe('exact');
    expect(varianceBand(-t.tolerance, t)).toBe('exact');
  });

  it('asks for a note between tolerance and the approval threshold', () => {
    expect(varianceBand(t.tolerance + 1, t)).toBe('note');
    expect(varianceBand(-t.approval, t)).toBe('note');
  });

  it('needs approval above the threshold, short or over alike', () => {
    expect(varianceBand(t.approval + 1, t)).toBe('approval');
    expect(varianceBand(-(t.approval + 1), t)).toBe('approval');
  });
});
