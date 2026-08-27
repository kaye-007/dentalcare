/**
 * Domain vocabulary for the scheduling module.
 *
 * Extracted from the service because the DTOs need it too, and a DTO
 * importing its own service is a cycle: at runtime the module that
 * loads second sees `undefined` where a constant should be.
 */

/** 'HH:MM' or 'HH:MM:SS' in clinic-local time. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
