/**
 * Domain vocabulary for the perio module.
 *
 * Extracted from the service because the DTOs need it too, and a DTO
 * importing its own service is a cycle: at runtime the module that
 * loads second sees `undefined` where a constant should be.
 */

/**
 * Periodontal charting.
 *
 * A perio exam is a snapshot: six sites per tooth, recorded in one sitting and
 * never edited afterwards except to correct the same sitting. Comparing two
 * exams over time is the entire clinical point, so measurements belong to an
 * exam rather than to the tooth — overwriting last year's readings would
 * destroy the trend a periodontist is looking for.
 *
 * Measurements are saved in BULK. A full-mouth chart is 32 teeth × 6 sites =
 * 192 readings entered in one pass; sending 192 requests would be slow and
 * would leave a half-recorded exam if the connection dropped partway.
 *
 * The SITE codes live in @dentalcare/shared. The clinic SPA declared the same
 * six in the same order, and that order is the order the chart is drawn in —
 * so it is part of the contract, not an implementation detail.
 */
export { PERIO_SITES, type PerioSite } from '@dentalcare/shared';
