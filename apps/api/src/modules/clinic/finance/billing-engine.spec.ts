import { AGEING_BUCKETS, CURRENCIES, LEDGER_ENTRY_TYPES, LEDGER_SIGN, VAT_RATE_SCALE, apportion, bucketFor, calculateInvoice, calculateInvoiceLine, collectionRate, deriveInvoiceStatus, isCurrency, planLinesToInvoiceLines, type InvoiceLineInput } from './billing-engine';

const line = (o: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({
  quantity: 1, unitPrice: 100, discountAmount: 0, taxRateBp: 0, ...o,
});

describe('apportion', () => {
  it('splits exactly, losing nothing', () => {
    for (const amount of [0, 1, 7, 100, 999, 12345]) {
      for (const weights of [[1], [1, 1], [1, 1, 1], [3, 5, 7], [10, 0, 1], [1, 2, 3, 4, 5]]) {
        const parts = apportion(amount, weights);
        expect(parts.reduce((s, v) => s + v, 0)).toBe(amount);
        expect(parts).toHaveLength(weights.length);
        expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      }
    }
  });

  it('handles the classic 100-across-3 case without losing a unit', () => {
    const parts = apportion(100, [1, 1, 1]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(100);
    expect(parts.sort()).toEqual([33, 33, 34]);
  });

  it('weights proportionally', () => {
    expect(apportion(100, [1, 3])).toEqual([25, 75]);
    expect(apportion(90, [1, 2, 3])).toEqual([15, 30, 45]);
  });

  it('spreads evenly when every weight is zero', () => {
    const parts = apportion(10, [0, 0, 0]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(10);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
  });

  it('is deterministic — the same input always splits the same way', () => {
    const a = apportion(1000, [7, 7, 7, 7, 7, 7, 7]);
    for (let i = 0; i < 20; i++) {
      expect(apportion(1000, [7, 7, 7, 7, 7, 7, 7])).toEqual(a);
    }
  });

  it('returns nothing for no lines, and ignores negative weights', () => {
    expect(apportion(100, [])).toEqual([]);
    const parts = apportion(100, [-5, 10]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(100);
  });
});

describe('line costing and VAT', () => {
  it('multiplies then discounts then taxes, in that order', () => {
    // 2 × 100 = 200, less 50 = 150 net, 20% VAT = 30, total 180.
    const c = calculateInvoiceLine(line({ quantity: 2, unitPrice: 100, discountAmount: 50, taxRateBp: 2000 }));
    expect(c.subtotal).toBe(200);
    expect(c.net).toBe(150);
    expect(c.taxAmount).toBe(30);
    expect(c.total).toBe(180);
  });

  it('charges VAT on the discounted value, never the gross', () => {
    const discounted = calculateInvoiceLine(line({ unitPrice: 200, discountAmount: 100, taxRateBp: 2000 }));
    const gross = calculateInvoiceLine(line({ unitPrice: 200, taxRateBp: 2000 }));
    expect(discounted.taxAmount).toBe(20);
    expect(gross.taxAmount).toBe(40);
  });

  it('applies no tax to an exempt line', () => {
    const c = calculateInvoiceLine(line({ unitPrice: 500, taxRateBp: 0 }));
    expect(c.taxAmount).toBe(0);
    expect(c.total).toBe(500);
  });

  it('rounds tax to whole units, half up', () => {
    // 10% of 105 = 10.5 → 11
    expect(calculateInvoiceLine(line({ unitPrice: 105, taxRateBp: 1000 })).taxAmount).toBe(11);
    // 10% of 104 = 10.4 → 10
    expect(calculateInvoiceLine(line({ unitPrice: 104, taxRateBp: 1000 })).taxAmount).toBe(10);
  });

  it('expresses fractional rates that a percentage integer could not', () => {
    // 8.5% of 1000 = 85
    expect(calculateInvoiceLine(line({ unitPrice: 1000, taxRateBp: 850 })).taxAmount).toBe(85);
  });

  it('never produces a negative line, whatever the stored data says', () => {
    const c = calculateInvoiceLine(line({ unitPrice: 100, discountAmount: 9999, taxRateBp: 2000 }));
    expect(c.net).toBe(0);
    expect(c.taxAmount).toBe(0);
    expect(c.total).toBe(0);
  });

  it('clamps an absurd tax rate to 100%', () => {
    const c = calculateInvoiceLine(line({ unitPrice: 100, taxRateBp: VAT_RATE_SCALE * 5 }));
    expect(c.taxAmount).toBe(100);
  });

  it('keeps every figure an integer', () => {
    for (const price of [1, 3, 7, 33, 99, 12345]) {
      for (const rate of [0, 850, 1000, 2000, 2350]) {
        const c = calculateInvoiceLine(line({ unitPrice: price, taxRateBp: rate }));
        expect(Number.isInteger(c.taxAmount)).toBe(true);
        expect(Number.isInteger(c.total)).toBe(true);
      }
    }
  });
});

describe('invoice totals', () => {
  it('totals an empty invoice to zero', () => {
    const c = calculateInvoice([]);
    expect(c.total).toBe(0);
    expect(c.hasTax).toBe(false);
  });

  it('sums lines and reconciles', () => {
    const c = calculateInvoice([
      line({ quantity: 2, unitPrice: 100, discountAmount: 50, taxRateBp: 2000 }),
      line({ unitPrice: 300 }),
    ]);
    expect(c.subtotal).toBe(500);
    expect(c.discountAmount).toBe(50);
    expect(c.net).toBe(450);
    expect(c.taxAmount).toBe(30);
    expect(c.total).toBe(480);
    expect(c.net + c.taxAmount).toBe(c.total);
    expect(c.subtotal - c.discountAmount).toBe(c.net);
  });

  it('mixes taxable and exempt lines correctly', () => {
    const c = calculateInvoice([
      line({ unitPrice: 100, taxRateBp: 2000 }),  // taxable: 20
      line({ unitPrice: 100, taxRateBp: 0 }),      // exempt
    ]);
    expect(c.taxAmount).toBe(20);
    expect(c.total).toBe(220);
    expect(c.hasTax).toBe(true);
  });

  it('reports no tax when every line is exempt', () => {
    expect(calculateInvoice([line(), line()]).hasTax).toBe(false);
  });
});

describe('plan → invoice conversion', () => {
  it('passes lines straight through when there is no plan discount', () => {
    const out = planLinesToInvoiceLines(
      [{ quantity: 1, unitFee: 100, discountAmount: 10, taxRateBp: 0 }], 0,
    );
    expect(out[0]!.discountAmount).toBe(10);
  });

  it('apportions the plan discount so the parts sum exactly', () => {
    const plan = [
      { quantity: 1, unitFee: 100, discountAmount: 0, taxRateBp: 0 },
      { quantity: 1, unitFee: 200, discountAmount: 0, taxRateBp: 0 },
      { quantity: 1, unitFee: 300, discountAmount: 0, taxRateBp: 0 },
    ];
    const out = planLinesToInvoiceLines(plan, 100);
    const added = out.reduce((s, l) => s + l.discountAmount, 0);
    expect(added).toBe(100);
    // Weighted by line value: 1/6, 2/6, 3/6 of 100.
    expect(out.map((l) => l.discountAmount)).toEqual([17, 33, 50]);
  });

  it('weights by the already-discounted value, not the gross', () => {
    const plan = [
      { quantity: 1, unitFee: 200, discountAmount: 150, taxRateBp: 0 }, // net 50
      { quantity: 1, unitFee: 200, discountAmount: 0, taxRateBp: 0 },   // net 200
    ];
    const out = planLinesToInvoiceLines(plan, 50);
    const added = out.map((l, i) => l.discountAmount - plan[i]!.discountAmount);
    expect(added.reduce((s, v) => s + v, 0)).toBe(50);
    // The cheaper-after-discount line absorbs less.
    expect(added[0]!).toBeLessThan(added[1]!);
  });

  it('caps the plan discount at the total value of the plan', () => {
    const out = planLinesToInvoiceLines(
      [{ quantity: 1, unitFee: 100, discountAmount: 0, taxRateBp: 0 }], 99999,
    );
    expect(out[0]!.discountAmount).toBe(100);
    expect(calculateInvoice(out).total).toBe(0);
  });

  it('produces an invoice total matching the plan total exactly', () => {
    // The property that matters: what was quoted is what gets invoiced.
    const cases: { lines: { quantity: number; unitFee: number; discountAmount: number; taxRateBp: number }[]; planDiscount: number }[] = [
      { lines: [{ quantity: 1, unitFee: 333, discountAmount: 0, taxRateBp: 0 }, { quantity: 1, unitFee: 667, discountAmount: 0, taxRateBp: 0 }], planDiscount: 100 },
      { lines: [{ quantity: 3, unitFee: 77, discountAmount: 11, taxRateBp: 0 }, { quantity: 2, unitFee: 49, discountAmount: 0, taxRateBp: 0 }], planDiscount: 37 },
      { lines: [{ quantity: 1, unitFee: 1, discountAmount: 0, taxRateBp: 0 }, { quantity: 1, unitFee: 1, discountAmount: 0, taxRateBp: 0 }, { quantity: 1, unitFee: 1, discountAmount: 0, taxRateBp: 0 }], planDiscount: 2 },
    ];
    for (const c of cases) {
      const planNet = c.lines.reduce(
        (s, l) => s + Math.max(0, l.unitFee * l.quantity - l.discountAmount), 0,
      );
      const expected = planNet - Math.min(c.planDiscount, planNet);
      const invoice = calculateInvoice(planLinesToInvoiceLines(c.lines, c.planDiscount));
      expect(invoice.total).toBe(expected);
    }
  });
});

describe('ledger', () => {
  it('signs entries so a balance is a plain sum', () => {
    expect(LEDGER_SIGN.charge).toBe(1);
    expect(LEDGER_SIGN.payment).toBe(-1);
    expect(LEDGER_SIGN.write_off).toBe(-1);
    for (const t of LEDGER_ENTRY_TYPES) {
      expect([1, -1]).toContain(LEDGER_SIGN[t]);
    }
  });

  it('nets a charge against its payment to zero', () => {
    const balance = 500 * LEDGER_SIGN.charge + 500 * LEDGER_SIGN.payment;
    expect(balance).toBe(0);
  });
});

describe('invoice status', () => {
  it('derives from what has been paid', () => {
    expect(deriveInvoiceStatus(100, 0, false)).toBe('unpaid');
    expect(deriveInvoiceStatus(100, 40, false)).toBe('partially_paid');
    expect(deriveInvoiceStatus(100, 100, false)).toBe('paid');
    // Overpayment still reads as paid; the excess shows on the ledger balance.
    expect(deriveInvoiceStatus(100, 150, false)).toBe('paid');
  });

  it('lets cancellation override everything', () => {
    expect(deriveInvoiceStatus(100, 100, true)).toBe('cancelled');
    expect(deriveInvoiceStatus(100, 0, true)).toBe('cancelled');
  });

  it('treats a zero-total invoice as settled', () => {
    expect(deriveInvoiceStatus(0, 0, false)).toBe('paid');
  });
});

describe('ageing and collection rate', () => {
  it('places days in the right bucket', () => {
    expect(bucketFor(0)).toBe('current');
    expect(bucketFor(30)).toBe('current');
    expect(bucketFor(31)).toBe('d31_60');
    expect(bucketFor(60)).toBe('d31_60');
    expect(bucketFor(61)).toBe('d61_90');
    expect(bucketFor(90)).toBe('d61_90');
    expect(bucketFor(91)).toBe('over_90');
    expect(bucketFor(5000)).toBe('over_90');
  });

  it('treats a negative age as current', () => {
    expect(bucketFor(-10)).toBe('current');
  });

  it('covers every day with exactly one bucket', () => {
    for (let d = 0; d <= 400; d++) {
      const matches = AGEING_BUCKETS.filter((b) => d >= b.min && d <= b.max);
      expect(matches).toHaveLength(1);
    }
  });

  it('computes a collection rate to one decimal', () => {
    expect(collectionRate(1000, 750)).toBe(75);
    expect(collectionRate(3, 1)).toBe(33.3);
    expect(collectionRate(1000, 1000)).toBe(100);
  });

  it('returns null when nothing was billed, rather than 0%', () => {
    expect(collectionRate(0, 0)).toBeNull();
    expect(collectionRate(-5, 0)).toBeNull();
  });
});

describe('currency', () => {
  it('recognises only supported codes', () => {
    for (const c of CURRENCIES) expect(isCurrency(c)).toBe(true);
    for (const bad of ['eur', 'XYZ', '', null, 3, {}]) expect(isCurrency(bad)).toBe(false);
  });

  it('includes the two the product actually needs', () => {
    expect(CURRENCIES).toContain('EUR');
    expect(CURRENCIES).toContain('ALL');
  });
});
