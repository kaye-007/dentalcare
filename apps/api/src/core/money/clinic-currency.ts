import { PoolClient } from 'pg';
import { type CurrencyCode, formatMoney, isCurrency } from '@dentalcare/shared';

/**
 * The clinic's currency, read inside the caller's tenant transaction.
 *
 * A clinic without a settings row is EUR — the same default the database
 * applies (migration 0006's clinic_currency_of), so the application and the
 * triggers can never disagree about it.
 */
export async function clinicCurrency(client: PoolClient): Promise<CurrencyCode> {
  const { rows } = await client.query<{ currency: string }>(
    'SELECT currency FROM clinic_settings LIMIT 1',
  );
  const currency = rows[0]?.currency;
  return isCurrency(currency) ? currency : 'EUR';
}

/**
 * An amount in minor units, as it should read in an activity line: "€37.50".
 *
 * Audit summaries written before 0006 hold bare whole-unit numbers; these name
 * their currency, so the two can never be confused when read side by side.
 */
export async function moneyText(client: PoolClient, minor: number): Promise<string> {
  return formatMoney(minor, await clinicCurrency(client));
}
