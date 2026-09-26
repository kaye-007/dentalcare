import {
  CURRENCIES,
  currencySymbol,
  formatMoney,
  isCurrency,
  moneyInputValue,
  parseMoney,
} from './money';

describe('formatMoney', () => {
  it('drops .00 from whole amounts and keeps cents when there are any', () => {
    expect(formatMoney(4500, 'EUR')).toBe('€45');
    expect(formatMoney(3750, 'EUR')).toBe('€37.50');
    expect(formatMoney(5, 'EUR')).toBe('€0.05');
  });

  it('groups thousands', () => {
    expect(formatMoney(123456789, 'EUR')).toBe('€1,234,567.89');
  });

  it('formats every supported currency without throwing', () => {
    for (const c of CURRENCIES) expect(formatMoney(100, c)).toMatch(/1/);
  });

  it('shows negatives, for ledger credits', () => {
    expect(formatMoney(-1250, 'EUR')).toContain('12.50');
  });

  it('refuses to print nonsense', () => {
    expect(formatMoney(Number.NaN, 'EUR')).toBe('—');
  });
});

describe('parseMoney', () => {
  it.each([
    ['45', 4500],
    ['45.5', 4550],
    ['45.50', 4550],
    ['45,50', 4550],
    ['0.05', 5],
    ['1,234', 123400],
    ['1.234', 123400],
    ['1,234.50', 123450],
    ['1.234,50', 123450],
    ['1 234,50', 123450],
    ['€ 45', 4500],
    ['45€', 4500],
    ['45.', 4500],
  ])('%p -> %i', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  /** The reason this function exists: 0.29 * 100 is not 29 in floating point. */
  it('is exact where float arithmetic is not', () => {
    expect(0.29 * 100).not.toBe(29);
    expect(1.15 * 100).not.toBe(115);
    expect(parseMoney('0.29')).toBe(29);
    expect(parseMoney('1.15')).toBe(115);
  });

  it('reads real thousands grouping, in either convention', () => {
    expect(parseMoney('1.234.567')).toBe(123456700);
    expect(parseMoney('1,234,567.89')).toBe(123456789);
    expect(parseMoney('1.234.567,89')).toBe(123456789);
  });

  it.each([
    '',
    'abc',
    '-5',
    '4.5555',
    '12.3.4,5',
    '.50',
    '1,23,4.5.6',
    '12,34,567',
    '1.234.50',
    '1,234,56',
  ])('refuses %p', (input) => {
    expect(parseMoney(input)).toBeNull();
  });
});

describe('moneyInputValue', () => {
  it('round-trips through parseMoney', () => {
    for (const minor of [0, 5, 99, 100, 3750, 4500, 123456]) {
      expect(parseMoney(moneyInputValue(minor))).toBe(minor);
    }
  });

  it('shows whole amounts without decimals', () => {
    expect(moneyInputValue(4500)).toBe('45');
    expect(moneyInputValue(4550)).toBe('45.50');
  });
});

describe('currencies', () => {
  it('recognises exactly the supported codes', () => {
    for (const c of CURRENCIES) expect(isCurrency(c)).toBe(true);
    for (const bad of ['eur', 'JPY', '', null]) expect(isCurrency(bad)).toBe(false);
  });

  it('has a symbol for each', () => {
    expect(currencySymbol('EUR')).toBe('€');
    for (const c of CURRENCIES) expect(currencySymbol(c).length).toBeGreaterThan(0);
  });
});
