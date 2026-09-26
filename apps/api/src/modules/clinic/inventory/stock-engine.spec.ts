import {
  MOVEMENT_KINDS,
  deltaFor,
  isLowStock,
  isMovementKind,
  isOutOfStock,
  nextQuantity,
  parseQuantity,
  round2,
} from './stock-engine';

describe('round2', () => {
  it('keeps two places', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.235)).toBe(1.24);
    expect(round2(10)).toBe(10);
  });

  it('rounds the float64 edge cases the way a person expects', () => {
    // 1.005 is the classic: the nearest float64 is fractionally below it, so
    // a naive Math.round(x * 100) gives 1.00.
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
  });

  it('treats negatives symmetrically', () => {
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(-2.5)).toBe(-2.5);
  });

  it('refuses what is not a number', () => {
    expect(() => round2(NaN)).toThrow(RangeError);
    expect(() => round2(Infinity)).toThrow(RangeError);
  });
});

describe('parseQuantity', () => {
  it('accepts the strings node-postgres returns for numeric columns', () => {
    expect(parseQuantity('12.50')).toBe(12.5);
    expect(parseQuantity('0.00')).toBe(0);
  });

  it('refuses text, null and undefined', () => {
    expect(() => parseQuantity('twelve')).toThrow(RangeError);
    expect(() => parseQuantity(null)).toThrow(RangeError);
    expect(() => parseQuantity(undefined)).toThrow(RangeError);
  });

  it('refuses a value the column could not hold', () => {
    expect(() => parseQuantity(1e15)).toThrow(/larger than/);
  });
});

describe('deltaFor', () => {
  describe('the kind carries the sign, not the caller', () => {
    it('a receipt adds', () => {
      expect(deltaFor({ kind: 'receipt', amount: 5 }, 10)).toBe(5);
    });

    it('usage subtracts', () => {
      expect(deltaFor({ kind: 'usage', amount: 2 }, 10)).toBe(-2);
    });

    it('a write-off subtracts', () => {
      expect(deltaFor({ kind: 'write_off', amount: 3 }, 10)).toBe(-3);
    });

    it.each(['receipt', 'usage', 'write_off'] as const)(
      'a negative amount on %s is refused rather than flipped',
      (kind) => {
        expect(() => deltaFor({ kind, amount: -1 }, 10)).toThrow(/greater than zero/);
      },
    );

    it.each(['receipt', 'usage', 'write_off'] as const)(
      'zero is not a movement (%s)',
      (kind) => {
        expect(() => deltaFor({ kind, amount: 0 }, 10)).toThrow(/greater than zero/);
      },
    );

    it('requires an amount', () => {
      expect(() => deltaFor({ kind: 'usage' }, 10)).toThrow(/quantity is required/);
    });
  });

  describe('an adjustment is a stock count, not a delta', () => {
    it('counting fewer than recorded gives a negative delta', () => {
      expect(deltaFor({ kind: 'adjustment', countedQuantity: 8 }, 10)).toBe(-2);
    });

    it('counting more than recorded gives a positive delta', () => {
      expect(deltaFor({ kind: 'adjustment', countedQuantity: 14 }, 10)).toBe(4);
    });

    it('counting zero is allowed — the shelf is empty', () => {
      expect(deltaFor({ kind: 'adjustment', countedQuantity: 0 }, 6)).toBe(-6);
    });

    it('a count that agrees is refused, because it records nothing', () => {
      expect(() => deltaFor({ kind: 'adjustment', countedQuantity: 10 }, 10)).toThrow(
        /matches the current quantity/,
      );
    });

    it('needs the counted quantity', () => {
      expect(() => deltaFor({ kind: 'adjustment' }, 10)).toThrow(/quantity you counted/);
    });

    it('refuses a negative count', () => {
      expect(() => deltaFor({ kind: 'adjustment', countedQuantity: -1 }, 10)).toThrow(
        /cannot be negative/,
      );
    });
  });

  describe('fractional quantities stay exact', () => {
    it('0.1 + 0.2 does not become 0.30000000000000004', () => {
      expect(deltaFor({ kind: 'receipt', amount: 0.1 }, 0.2)).toBe(0.1);
      expect(nextQuantity(0.2, 0.1)).toBe(0.3);
    });

    it('an adjustment across fractions is exact', () => {
      expect(deltaFor({ kind: 'adjustment', countedQuantity: 2.5 }, 7.3)).toBe(-4.8);
    });
  });
});

describe('nextQuantity', () => {
  it('applies the change', () => {
    expect(nextQuantity(10, 5)).toBe(15);
    expect(nextQuantity(10, -4)).toBe(6);
  });

  it('reaching exactly zero is fine', () => {
    expect(nextQuantity(3, -3)).toBe(0);
  });

  it('refuses to go negative, and says what to do instead', () => {
    expect(() => nextQuantity(2, -5)).toThrow(/stock count/);
    expect(() => nextQuantity(2, -5)).toThrow(RangeError);
  });

  it('names the figures in the refusal, because that is the useful part', () => {
    expect(() => nextQuantity(2, -5)).toThrow(/2\.00 on record/);
  });

  it('refuses more than the column can hold', () => {
    expect(() => nextQuantity(9_999_999_999, 100)).toThrow(/more stock than/);
  });
});

describe('isLowStock', () => {
  it('is true at the minimum, not only below it', () => {
    expect(isLowStock({ quantity: 4, minimumQuantity: 4, status: 'active' })).toBe(true);
  });

  it('is true below the minimum', () => {
    expect(isLowStock({ quantity: 1, minimumQuantity: 4, status: 'active' })).toBe(true);
  });

  it('is false above it', () => {
    expect(isLowStock({ quantity: 5, minimumQuantity: 4, status: 'active' })).toBe(false);
  });

  it('is false for an archived item, however empty', () => {
    expect(isLowStock({ quantity: 0, minimumQuantity: 4, status: 'archived' })).toBe(
      false,
    );
  });

  it('a minimum of zero only fires when the shelf is empty', () => {
    expect(isLowStock({ quantity: 0, minimumQuantity: 0, status: 'active' })).toBe(true);
    expect(isLowStock({ quantity: 0.5, minimumQuantity: 0, status: 'active' })).toBe(
      false,
    );
  });

  it('compares fractions exactly', () => {
    expect(isLowStock({ quantity: 4.01, minimumQuantity: 4, status: 'active' })).toBe(
      false,
    );
    expect(isLowStock({ quantity: 3.99, minimumQuantity: 4, status: 'active' })).toBe(
      true,
    );
  });
});

describe('isOutOfStock', () => {
  it('separates empty from merely low', () => {
    expect(isOutOfStock({ quantity: 0, status: 'active' })).toBe(true);
    expect(isOutOfStock({ quantity: 0.5, status: 'active' })).toBe(false);
  });

  it('ignores archived items', () => {
    expect(isOutOfStock({ quantity: 0, status: 'archived' })).toBe(false);
  });
});

describe('isMovementKind', () => {
  it('accepts every kind the migration allows, and nothing else', () => {
    for (const kind of MOVEMENT_KINDS) expect(isMovementKind(kind)).toBe(true);
    expect(isMovementKind('delete')).toBe(false);
    expect(isMovementKind('')).toBe(false);
    expect(isMovementKind(undefined)).toBe(false);
  });

  it('lists exactly the four the CHECK constraint names', () => {
    expect([...MOVEMENT_KINDS].sort()).toEqual([
      'adjustment',
      'receipt',
      'usage',
      'write_off',
    ]);
  });
});
