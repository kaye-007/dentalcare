// Public surface of this module. Everything else stays internal:
// a barrel that re-exports the world is just a longer import path.
export { ChartController } from './chart.controller';
export { ChartingModule } from './charting.module';
export { ConditionRow } from './charting.service';
export { PatientProceduresController } from './patient-procedures.controller';
export { ProcedureCodesController } from './procedure-codes.controller';
export { ProceduresController } from './procedures.controller';
export { ToothConditionsController } from './tooth-conditions.controller';
// Tooth notation is shared with the clinic SPA — see @dentalcare/shared. It
// is re-exported here rather than imported directly by perio and
// treatment-plans, because those modules ask charting what a valid tooth is
// and that remains the right question for them to ask.
export {
  ALL_TEETH,
  SURFACES,
  Surface,
  isValidSurface,
  isValidTooth,
  surfacesFor,
} from '@dentalcare/shared';
