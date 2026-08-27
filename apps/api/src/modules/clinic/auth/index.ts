// Public surface of this module. Everything else stays internal:
// a barrel that re-exports the world is just a longer import path.
export { AuthController } from './auth.controller';
export { AuthModule } from './auth.module';
export { AuthService } from './auth.service';
export { JwtAuthGuard } from './jwt.guard';
