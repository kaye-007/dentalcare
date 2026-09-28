import { PoolClient } from 'pg';

/**
 * "INV-0042", or whatever prefix the clinic chose (0009).
 *
 * The prefix is read inside the transaction that issues the invoice, and it
 * applies to NEW invoices only: a number already printed on a patient's bill
 * never changes, so a clinic that renames its series keeps both in its
 * history. Uniqueness still rests on the per-clinic sequence, not the text.
 */
export async function nextInvoiceNumber(
  client: PoolClient,
  seq: number,
): Promise<string> {
  const { rows } = await client.query<{ invoice_prefix: string | null }>(
    'SELECT invoice_prefix FROM clinic_settings LIMIT 1',
  );
  return formatInvoiceNumber(rows[0]?.invoice_prefix ?? 'INV-', seq);
}

export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(4, '0')}`;
}
