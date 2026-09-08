/**
 * Vocabulary at the HTTP boundary.
 *
 * Narrow on purpose. The clinic SPA declares 67 response interfaces and the
 * API declares almost none — it returns row-shaped objects straight from SQL
 * — so there is no existing set of shared response types to lift, and
 * inventing one would mean writing a client contract the API does not
 * actually reference. A type that looks authoritative and binds nothing is
 * worse than an honest hand-written client interface.
 *
 * What IS shared is this: the small closed vocabularies the API validates a
 * request against and the UI offers as choices. When those disagree, the user
 * picks something from a dropdown and the API rejects it — which is the same
 * failure the surface codes and tooth conditions could have produced, and the
 * reason they are in tooth-notation.ts rather than in three places.
 *
 * Everything here was verified identical on both sides before being moved.
 */

/* ══════════════════════ periodontal charting ══════════════════════ */

/**
 * Six probing sites per tooth: buccal and lingual, each mesial / mid /
 * distal. The order is the order they are charted and drawn in, so it is part
 * of the contract rather than an implementation detail.
 */
export const PERIO_SITES = ['MB', 'B', 'DB', 'ML', 'L', 'DL'] as const;

export type PerioSite = (typeof PERIO_SITES)[number];

/* ══════════════════════ patient documents ══════════════════════ */

/**
 * What a stored file is. Used to filter the document list and to label an
 * upload; the API rejects anything outside this set.
 */
export const DOCUMENT_KINDS = [
  'xray',
  'photo',
  'consent',
  'referral',
  'insurance',
  'report',
  'other',
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/* ══════════════════════ clinic opening hours ══════════════════════ */

/**
 * One day of the clinic's week.
 *
 * `day` is **0 = Monday … 6 = Sunday**, which is NOT JavaScript's
 * `Date#getDay()`. Both sides already agreed on this — the API's
 * DEFAULT_HOURS makes day 5 a short Saturday and day 6 a closed Sunday, and
 * the settings screen labels index 0 "Monday" — but it is worth stating,
 * because `staff_availability.weekday` in the same database uses the OTHER
 * convention (0 = Sunday, matching getDay()). Two tables, two meanings for
 * the same small integer; nothing joins them today, and anything that ever
 * does must convert.
 *
 * `open` and `close` are 'HH:MM'. They are meaningless when `closed` is true,
 * and the API still validates their format, so a client must send something
 * parseable either way.
 */
export interface WorkingDay {
  day: number;
  closed: boolean;
  open: string;
  close: string;
}
