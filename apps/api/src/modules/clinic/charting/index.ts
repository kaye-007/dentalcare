// Public surface of this module. Everything else stays internal:
// a barrel that re-exports the world is just a longer import path.
export { ChartController } from './chart.controller';
export { ChartingModule } from './charting.module';
export { ConditionRow } from './charting.service';
export { PatientProceduresController } from './patient-procedures.controller';
export { ProcedureCodesController } from './procedure-codes.controller';
export { ProceduresController } from './procedures.controller';
export { ToothConditionsController } from './tooth-conditions.controller';
export { ALL_TEETH, SURFACES, Surface, isValidSurface, isValidTooth, surfacesFor } from './tooth-notation';
