/**
 * VAT (TVSH) on dental work, as Albanian law treats it.
 *
 * ── Two categories, one clinic rate ───────────────────────────────────────
 *
 * Medical care is an EXEMPT supply under the VAT law (Ligji nr. 92/2014,
 * neni 51): no TVSH is charged, and a fiscal invoice marks the line with an
 * exemption code rather than a 0% rate. Treatment done for appearance —
 * whitening, veneers chosen for looks — is not medical care and carries the
 * standard rate, 20%.
 *
 * So a treatment is one of two categories, and the percentage for "cosmetic"
 * is the clinic's own VAT rate (Settings → Finance), because a clinic that is
 * not registered for VAT charges none on anything. The database column is the
 * boolean `is_taxable` the schema has always had; this is the vocabulary a
 * person reads it in.
 *
 * Which category a procedure belongs to is the clinic's call, made with its
 * accountant, not something this file can decide.
 */

export const VAT_CATEGORIES = ['medical', 'cosmetic'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

export function isVatCategory(value: unknown): value is VatCategory {
  return (
    typeof value === 'string' && (VAT_CATEGORIES as readonly string[]).includes(value)
  );
}

/** The Albanian standard rate, in basis points. */
export const ALBANIA_STANDARD_VAT_BP = 2000;

export function vatCategoryOf(isTaxable: boolean | null | undefined): VatCategory {
  return isTaxable ? 'cosmetic' : 'medical';
}

/** Basis points charged on a line of this category at a clinic with this rate. */
export function vatRateFor(category: VatCategory, clinicRateBp: number): number {
  return category === 'cosmetic' ? Math.max(0, Math.round(clinicRateBp)) : 0;
}

/** "Medical · TVSH exempt" / "Cosmetic · TVSH 20%". */
export function vatCategoryLabel(category: VatCategory, clinicRateBp: number): string {
  if (category === 'medical') return 'Medical · TVSH exempt (0%)';
  return clinicRateBp > 0
    ? `Cosmetic · TVSH ${formatRate(clinicRateBp)}`
    : 'Cosmetic · no TVSH (clinic not VAT-registered)';
}

/** 2000 -> "20%", 650 -> "6.5%". */
export function formatRate(bp: number): string {
  const whole = bp % 100 === 0;
  return `${whole ? bp / 100 : (bp / 100).toFixed(2).replace(/0$/, '')}%`;
}

export interface VatLine {
  taxRateBp: number;
  /** Minor units after discount, before VAT. */
  net: number;
  /** Minor units of VAT on the line. */
  taxAmount: number;
}

export interface VatGroup {
  taxRateBp: number;
  /** True for the exempt group, which a receipt labels rather than rates. */
  exempt: boolean;
  lineCount: number;
  net: number;
  taxAmount: number;
}

/**
 * Lines grouped by rate, lowest first — the TVSH summary a fiscal receipt
 * prints and the SameTaxes block CIS receives, computed the same way.
 */
export function vatSummary(lines: readonly VatLine[]): VatGroup[] {
  const groups = new Map<number, VatGroup>();
  for (const l of lines) {
    const rate = Math.max(0, Math.round(l.taxRateBp));
    const g = groups.get(rate) ?? {
      taxRateBp: rate,
      exempt: rate === 0,
      lineCount: 0,
      net: 0,
      taxAmount: 0,
    };
    g.lineCount += 1;
    g.net += l.net;
    g.taxAmount += l.taxAmount;
    groups.set(rate, g);
  }
  return [...groups.values()].sort((a, b) => a.taxRateBp - b.taxRateBp);
}
