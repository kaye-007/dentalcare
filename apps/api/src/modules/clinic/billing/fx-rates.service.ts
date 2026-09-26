import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import type { CurrencyCode } from '@dentalcare/shared';

/**
 * Exchange rates for the second currency on an estimate.
 *
 * ── What a rate here is for ───────────────────────────────────────────────
 *
 * An indication for a patient comparing prices at home: "about €1,090". It is
 * not used to book, charge or fiscalize anything — the ledger stays in the
 * clinic's own currency, and a fiscal invoice issued in foreign currency would
 * use the Bank of Albania's official rate for its day, which is a different
 * question. So a rate a few hours old is fine, and one that cannot be
 * refreshed is still printed, with its date, rather than blocking the page.
 *
 * ── Where it comes from ───────────────────────────────────────────────────
 *
 *   fixed   the clinic's own rate (Settings → Finance). Many clinics quote
 *           tourists at a round rate of their own, and it never goes stale.
 *   live    FX_RATES_URL, by default ExchangeRate-API's open endpoint, which
 *           publishes lek once a day and asks for attribution — printed on
 *           the estimate. The last good answer is kept in fx_rates, so an
 *           outage shows yesterday's rate marked as such.
 */

export interface QuoteRate {
  /** Clinic-currency units for ONE quote-currency unit. */
  rate: number;
  source: 'fixed' | 'live';
  /** Who published it, for the attribution line. */
  provider: string | null;
  /** The day the rate is for (YYYY-MM-DD). */
  asOf: string;
  /** A live rate that could not be refreshed. */
  stale: boolean;
}

const FRESH_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;

@Injectable()
export class FxRatesService {
  private readonly logger = new Logger(FxRatesService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * The rate for one quote currency at one clinic, read inside the caller's
   * transaction: the clinic's fixed rate if it has chosen one, otherwise the
   * published rate.
   */
  async rateFor(
    client: PoolClient,
    base: CurrencyCode,
    quote: CurrencyCode,
  ): Promise<QuoteRate> {
    const { rows: s } = await client.query<{
      fx_rate_source: string;
      fx_fixed_rate: string | null;
      updated_at: string;
    }>(
      'SELECT fx_rate_source, fx_fixed_rate, updated_at::text AS updated_at FROM clinic_settings LIMIT 1',
    );
    const settings = s[0];
    if (settings?.fx_rate_source === 'fixed' && settings.fx_fixed_rate) {
      return {
        rate: Number(settings.fx_fixed_rate),
        source: 'fixed',
        provider: null,
        asOf: settings.updated_at.slice(0, 10),
        stale: false,
      };
    }
    return this.published(client, base, quote);
  }

  private async published(
    client: PoolClient,
    base: CurrencyCode,
    quote: CurrencyCode,
  ): Promise<QuoteRate> {
    const { rows } = await client.query<{
      rate: string;
      source: string;
      as_of: string;
      fetched_at: Date;
    }>(
      'SELECT rate::text AS rate, source, as_of::text AS as_of, fetched_at FROM fx_rates WHERE base = $1 AND quote = $2',
      [base, quote],
    );
    const cached = rows[0];
    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < FRESH_MS) {
      return {
        rate: Number(cached.rate),
        source: 'live',
        provider: cached.source,
        asOf: cached.as_of,
        stale: false,
      };
    }

    const fetched = await this.fetchRate(base, quote);
    if (fetched) {
      await client.query(
        `INSERT INTO fx_rates (base, quote, rate, source, as_of, fetched_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (base, quote) DO UPDATE
           SET rate = EXCLUDED.rate, source = EXCLUDED.source, as_of = EXCLUDED.as_of, fetched_at = now()`,
        [base, quote, fetched.rate, fetched.provider, fetched.asOf],
      );
      return {
        rate: fetched.rate,
        source: 'live',
        provider: fetched.provider,
        asOf: fetched.asOf,
        stale: false,
      };
    }
    if (cached) {
      return {
        rate: Number(cached.rate),
        source: 'live',
        provider: cached.source,
        asOf: cached.as_of,
        stale: true,
      };
    }
    throw new ServiceUnavailableException(
      'No exchange rate could be fetched. Set a fixed rate in Settings → Finance, or try again later.',
    );
  }

  /** One request to the rate provider; null on any failure, which the caller handles. */
  async fetchRate(base: CurrencyCode, quote: CurrencyCode) {
    const template =
      this.config.get<string>('FX_RATES_URL') ??
      'https://open.er-api.com/v6/latest/{base}';
    const url = template.replace('{base}', encodeURIComponent(quote));
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        this.logger.warn(`exchange rate provider answered HTTP ${res.status}`);
        return null;
      }
      return parseRateResponse(await res.json(), base);
    } catch (err) {
      this.logger.warn(
        `exchange rate provider unreachable: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}

/**
 * ExchangeRate-API's open-access answer, for a request based on the QUOTE
 * currency: rates[base] is how many clinic-currency units one quote unit buys.
 */
export function parseRateResponse(
  body: unknown,
  base: CurrencyCode,
): { rate: number; provider: string; asOf: string } | null {
  const b = body as {
    result?: unknown;
    rates?: Record<string, unknown>;
    time_last_update_unix?: unknown;
    provider?: unknown;
  } | null;
  if (!b || b.result !== 'success' || !b.rates) return null;
  const rate = Number(b.rates[base]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const at =
    typeof b.time_last_update_unix === 'number'
      ? new Date(b.time_last_update_unix * 1000)
      : new Date();
  return {
    rate: Math.round(rate * 1e6) / 1e6,
    provider:
      typeof b.provider === 'string' && /exchangerate-api/i.test(b.provider)
        ? 'ExchangeRate-API'
        : 'published rates',
    asOf: at.toISOString().slice(0, 10),
  };
}

/** Minor units of the clinic currency -> minor units of the quote currency, rounded to the cent. */
export function convertMinor(minor: number, rate: number): number {
  return Math.round(minor / rate);
}
