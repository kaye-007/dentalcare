import {
  LotCandidate,
  daysUntil,
  expiryState,
  isIsoDate,
  pickLot,
  usageBlocker,
} from './lot-engine';

const TODAY = '2026-09-14';

const lot = (o: Partial<LotCandidate> = {}): LotCandidate => ({
  id: o.lotNumber ?? 'L1',
  lotNumber: 'L1',
  expiresOn: '2027-01-01',
  receivedOn: '2026-01-01',
  quantity: 10,
  status: 'active',
  ...o,
});

describe('isIsoDate', () => {
  it('accepts real calendar dates only', () => {
    expect(isIsoDate('2026-09-14')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-9-14')).toBe(false);
    expect(isIsoDate('14/09/2026')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

describe('expiry', () => {
  it('counts whole days, across a month end', () => {
    expect(daysUntil('2026-10-01', TODAY)).toBe(17);
    expect(daysUntil(TODAY, TODAY)).toBe(0);
    expect(daysUntil('2026-09-13', TODAY)).toBe(-1);
  });

  it('a lot is usable on its date and expired the day after', () => {
    expect(expiryState(TODAY, TODAY, 30)).toBe('expiring');
    expect(expiryState('2026-09-13', TODAY, 30)).toBe('expired');
  });

  it('warns within the item’s own window, and not before', () => {
    expect(expiryState('2026-10-14', TODAY, 30)).toBe('expiring');
    expect(expiryState('2026-10-15', TODAY, 30)).toBe('ok');
    expect(expiryState('2026-09-20', TODAY, 0)).toBe('ok');
  });

  it('has nothing to say about a lot with no expiry date', () => {
    expect(expiryState(null, TODAY, 30)).toBe('none');
  });
});

describe('usageBlocker', () => {
  it('refuses recalled and expired lots, with the reason', () => {
    expect(usageBlocker(lot({ status: 'recalled' }), TODAY)).toMatch(/recalled/);
    expect(usageBlocker(lot({ expiresOn: '2026-09-01' }), TODAY)).toMatch(
      /expired on 2026-09-01/,
    );
    expect(usageBlocker(lot(), TODAY)).toBeNull();
    expect(usageBlocker(lot({ expiresOn: null }), TODAY)).toBeNull();
  });
});

describe('pickLot', () => {
  it('takes the earliest expiry first', () => {
    const picked = pickLot(
      [
        lot({ id: 'late', lotNumber: 'late', expiresOn: '2027-06-01' }),
        lot({ id: 'soon', lotNumber: 'soon', expiresOn: '2026-10-01' }),
        lot({ id: 'none', lotNumber: 'none', expiresOn: null }),
      ],
      2,
      TODAY,
    );
    expect(picked.id).toBe('soon');
  });

  it('puts a lot with no expiry date last', () => {
    const picked = pickLot(
      [
        lot({ id: 'none', expiresOn: null }),
        lot({ id: 'dated', expiresOn: '2030-01-01' }),
      ],
      1,
      TODAY,
    );
    expect(picked.id).toBe('dated');
  });

  it('breaks a tie on expiry by what arrived first', () => {
    const picked = pickLot(
      [
        lot({ id: 'new', receivedOn: '2026-08-01' }),
        lot({ id: 'old', receivedOn: '2026-02-01' }),
      ],
      1,
      TODAY,
    );
    expect(picked.id).toBe('old');
  });

  it('skips expired, recalled and empty lots', () => {
    const picked = pickLot(
      [
        lot({ id: 'expired', expiresOn: '2026-09-01' }),
        lot({ id: 'recalled', expiresOn: '2026-09-20', status: 'recalled' }),
        lot({ id: 'empty', expiresOn: '2026-09-21', quantity: 0 }),
        lot({ id: 'good', expiresOn: '2026-12-01' }),
      ],
      1,
      TODAY,
    );
    expect(picked.id).toBe('good');
  });

  it('never splits one usage across lots', () => {
    const lots = [lot({ id: 'a', quantity: 3 }), lot({ id: 'b', quantity: 4 })];
    expect(() => pickLot(lots, 5, TODAY)).toThrow(
      /No single lot holds 5.*largest usable lot has 4/,
    );
    expect(pickLot(lots, 4, TODAY).id).toBe('b');
  });

  it('compares exactly at two decimal places', () => {
    expect(pickLot([lot({ quantity: 0.3 })], 0.1 + 0.2, TODAY).id).toBe('L1');
  });

  it('says why when every lot with stock is unusable', () => {
    expect(() =>
      pickLot([lot({ expiresOn: '2026-01-01' }), lot({ status: 'recalled' })], 1, TODAY),
    ).toThrow(/expired or recalled/);
  });

  it('says so when there is nothing at all', () => {
    expect(() => pickLot([], 1, TODAY)).toThrow(/no stock/);
    expect(() => pickLot([lot({ quantity: 0 })], 1, TODAY)).toThrow(/no stock/);
  });
});
