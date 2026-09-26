import { convertMinor, parseRateResponse } from './fx-rates.service';

describe('parseRateResponse', () => {
  // Trimmed from a real open.er-api.com answer for EUR, 17 September 2026.
  const body = {
    result: 'success',
    provider: 'https://www.exchangerate-api.com',
    time_last_update_unix: 1789603351,
    base_code: 'EUR',
    rates: { EUR: 1, ALL: 91.776383, USD: 1.150344 },
  };

  it('reads lek per euro, with the day and the provider for attribution', () => {
    expect(parseRateResponse(body, 'ALL')).toEqual({
      rate: 91.776383,
      provider: 'ExchangeRate-API',
      asOf: '2026-09-17',
    });
  });

  it('refuses an error answer or a missing currency rather than inventing a rate', () => {
    expect(
      parseRateResponse({ result: 'error', 'error-type': 'unsupported-code' }, 'ALL'),
    ).toBeNull();
    expect(parseRateResponse({ ...body, rates: { EUR: 1 } }, 'ALL')).toBeNull();
    expect(parseRateResponse({ ...body, rates: { ALL: -3 } }, 'ALL')).toBeNull();
    expect(parseRateResponse(null, 'ALL')).toBeNull();
  });
});

describe('convertMinor', () => {
  it('converts clinic minor units to quote minor units, to the cent', () => {
    // 100 000 lek at 91.776383 lek per euro is €1 089.60.
    expect(convertMinor(10_000_000, 91.776383)).toBe(108_960);
    expect(convertMinor(0, 91.776383)).toBe(0);
  });
});
