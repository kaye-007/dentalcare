import { ConfigService } from '@nestjs/config';

/**
 * The secret that signs and verifies platform console tokens.
 *
 * The two planes used to share JWT_SECRET. That made a leak of the clinic
 * secret — the one held by the process that serves every clinic request — a
 * leak of the platform secret too, and a platform token is cross-tenant
 * authority over every clinic in the deployment. They are separate blast
 * radii and now separate keys.
 *
 * Development falls back to JWT_SECRET, so an existing .env keeps working and
 * nobody has to generate a second secret to run the app locally. Production
 * does not: env.validation requires PLATFORM_JWT_SECRET there, and requires it
 * to differ from JWT_SECRET, because a split that resolves to the same string
 * is a rename rather than a separation.
 *
 * One function rather than four call sites reading config, so signing and
 * verification cannot end up disagreeing about which key is in play.
 */
export function platformJwtSecret(config: ConfigService): string {
  return (
    config.get<string>('PLATFORM_JWT_SECRET') ||
    config.get<string>('JWT_SECRET')!
  );
}
