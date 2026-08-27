// Public surface of this module. Everything else stays internal:
// a barrel that re-exports the world is just a longer import path.
export { PlatformAuthController } from './platform-auth.controller';
export { PlatformAuthModule } from './platform-auth.module';
export { PlatformAuthService, PlatformTokenPayload } from './platform-auth.service';
export { CurrentAdmin, PlatformJwtGuard } from './platform-jwt.guard';
