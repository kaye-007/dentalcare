/**
 * Domain vocabulary for the settings module.
 *
 * Extracted from the service because the DTOs need it too, and a DTO
 * importing its own service is a cycle: at runtime the module that
 * loads second sees `undefined` where a constant should be.
 */

export interface WorkingDay {
  day: number;          // 0 = Monday … 6 = Sunday
  closed: boolean;
  open: string;         // 'HH:MM'
  close: string;        // 'HH:MM'
}
