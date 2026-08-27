/**
 * Domain vocabulary for the documents module.
 *
 * Extracted from the service because the DTOs need it too, and a DTO
 * importing its own service is a cycle: at runtime the module that
 * loads second sees `undefined` where a constant should be.
 */

/**
 * Patient documents — X-rays, consent forms, referrals, insurance cards.
 *
 * Bytes go to object storage; this table is the index. Three properties hold
 * the whole design together:
 *
 *  - Uploads are validated by MAGIC BYTES, not by the Content-Type the client
 *    claims, so a renamed executable cannot reach the bucket.
 *  - Downloads are short-lived PRE-SIGNED URLs minted per request, only after
 *    the row has been fetched through RLS. There is no public object and no
 *    guessable path.
 *  - Deletes are SOFT. The row is the record that a document ever existed;
 *    losing it silently would be worse than an orphaned object.
 */

export const DOCUMENT_KINDS = [
  'xray', 'photo', 'consent', 'referral', 'insurance', 'report', 'other',
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
