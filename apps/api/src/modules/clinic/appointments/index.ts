// Public surface of this module. Everything else stays internal:
// a barrel that re-exports the world is just a longer import path.
export { AppointmentsController } from './appointments.controller';
export { AppointmentsModule } from './appointments.module';
export { allowedTransitions } from './status-machine';
