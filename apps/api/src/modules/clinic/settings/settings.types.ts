/**
 * Domain vocabulary for the settings module.
 *
 * Extracted from the service because the DTOs need it too, and a DTO
 * importing its own service is a cycle: at runtime the module that
 * loads second sees `undefined` where a constant should be.
 *
 * WorkingDay itself lives in @dentalcare/shared — the settings screen
 * declared the same four fields, and the `day` index means 0 = Monday on both
 * sides, which is worth having written down in one place given that
 * `staff_availability.weekday` in the same database counts from Sunday.
 */
export { type WorkingDay } from '@dentalcare/shared';
