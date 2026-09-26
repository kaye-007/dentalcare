import { formatRate, vatCategoryOf, vatRateFor, vatSummary } from './vat';

describe('vat', () => {
  it('reads the taxable flag as the Albanian categories', () => {
    expect(vatCategoryOf(false)).toBe('medical');
    expect(vatCategoryOf(null)).toBe('medical');
    expect(vatCategoryOf(true)).toBe('cosmetic');
  });

  it('charges the clinic rate on cosmetic work only', () => {
    expect(vatRateFor('medical', 2000)).toBe(0);
    expect(vatRateFor('cosmetic', 2000)).toBe(2000);
    // A clinic not registered for VAT charges none on anything.
    expect(vatRateFor('cosmetic', 0)).toBe(0);
  });

  it('formats rates without trailing zeros', () => {
    expect(formatRate(2000)).toBe('20%');
    expect(formatRate(650)).toBe('6.5%');
    expect(formatRate(0)).toBe('0%');
  });

  it('groups lines by rate, exempt first', () => {
    const groups = vatSummary([
      { taxRateBp: 2000, net: 10_000, taxAmount: 2_000 },
      { taxRateBp: 0, net: 5_000, taxAmount: 0 },
      { taxRateBp: 2000, net: 2_550, taxAmount: 510 },
    ]);
    expect(groups).toEqual([
      { taxRateBp: 0, exempt: true, lineCount: 1, net: 5_000, taxAmount: 0 },
      { taxRateBp: 2000, exempt: false, lineCount: 2, net: 12_550, taxAmount: 2_510 },
    ]);
  });
});
