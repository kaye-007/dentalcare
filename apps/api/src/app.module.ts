import { randomUUID } from 'node:crypto';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from '@/core/config/config.module';
import { AuthzModule } from '@/core/authz/authz.module';
import { ClinicAuditModule } from '@/core/audit/clinic-audit.module';
import { MfaModule } from '@/core/mfa/mfa.module';
import { ReadOnlyGuard } from '@/core/tenancy/read-only.guard';
import { OAuthModule } from '@/core/oauth/oauth.module';
import { OAuthRoutesModule } from '@/core/oauth/oauth-routes.module';
import { StorageModule } from '@/core/storage/storage.module';
import { DatabaseModule } from '@/core/database/database.module';
import { HealthModule } from '@/core/health/health.module';
import { TenancyModule } from '@/core/tenancy/tenancy.module';
import { TenantMiddleware } from '@/core/tenancy/tenant.middleware';
import { tenantMiddlewareExclusions } from '@/core/tenancy/tenant-routes';
import { RequestContextMiddleware, RequestContextModule } from '@/core/request-context/request-context';
import { EntitlementsModule } from '@/core/entitlements/entitlements.service';
import { IdempotencyInterceptor } from '@/core/idempotency/idempotency.interceptor';
import { FeaturesModule } from '@/modules/clinic/features';
import { CashDrawerModule } from '@/modules/clinic/cash-drawer';
import { WhatsAppModule } from '@/modules/clinic/whatsapp';
import { AuthModule } from '@/modules/clinic/auth';
import { PatientsModule } from '@/modules/clinic/patients';
import { PatientHistoryModule } from '@/modules/clinic/patient-history';
import { DocumentsModule } from '@/modules/clinic/documents';
import { AppointmentsModule } from '@/modules/clinic/appointments';
import { SchedulingModule } from '@/modules/clinic/scheduling';
import { StaffModule } from '@/modules/clinic/staff';
import { TreatmentsModule } from '@/modules/clinic/treatments';
import { ChartingModule } from '@/modules/clinic/charting';
import { PerioModule } from '@/modules/clinic/perio';
import { TreatmentPlansModule } from '@/modules/clinic/treatment-plans';
import { SettingsModule } from '@/modules/clinic/settings';
import { FinanceModule } from '@/modules/clinic/finance';
import { ReportsModule } from '@/modules/clinic/reports';
import { BillingModule } from '@/modules/clinic/billing';
import { AnalyticsModule } from '@/modules/clinic/analytics';
import { RemindersModule } from '@/modules/clinic/reminders';
import { AuditModule } from '@/modules/clinic/audit';
import { InventoryModule } from '@/modules/clinic/inventory';
import { PartnersModule } from '@/modules/clinic/partners';
import { LabModule } from '@/modules/clinic/lab';
import { FiscalizationModule } from '@/modules/clinic/fiscalization/fiscalization.module';
import { PlatformAuthModule } from '@/modules/platform/auth';
import { TenantsModule } from '@/modules/platform/tenants';
import { PlansModule } from '@/modules/platform/plans';
import { PlatformBillingModule } from '@/modules/platform/billing';
import { PlatformUsageModule } from '@/modules/platform/usage';
import { PlatformActivityModule } from '@/modules/platform/activity';

/**
 * Cloudflare Workers changes what the process can do, not what the app does.
 * Read once here so the module graph below stays declarative.
 */
const IS_WORKERS = process.env.RUNTIME === 'workers';

/**
 * pino-pretty when it is actually installed, plain JSON otherwise.
 *
 * It is a devDependency, and the container image installs with --omit=dev.
 * Asking pino for a transport that is not on disk is not a degraded log
 * format, it is a throw inside the logger constructor — so the API
 * crash-looped on every `docker compose up`, because compose defaults
 * NODE_ENV to development and this used to key on nothing else. Readable
 * output is a convenience; booting is not.
 */
function prettyTransport() {
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    require.resolve('pino-pretty');
  } catch {
    return undefined;
  }
  return { target: 'pino-pretty', options: { singleLine: true } };
}

@Module({
  imports: [
    AppConfigModule,
    // pino only on Node.
    //
    // A Workers bundler resolves pino to its browser build, which lacks the
    // internals pino-http drives; the node build instead reaches for
    // sonic-boom and thread-stream — file descriptors and worker threads,
    // neither of which a Worker has. Rather than fight either one, the
    // built-in Nest logger takes over there. It writes to console, which is
    // exactly what Cloudflare's Workers Logs ingests, and configureApp()
    // keeps the x-request-id correlation that pino-http provided here.
    ...(IS_WORKERS
      ? []
      : [
          LoggerModule.forRoot({
            // nestjs-pino's default is '*', which Nest 11 prefixes to '/api/*'
            // and then warns about ("Unsupported route path") on every boot —
            // path-to-regexp v8 needs a named splat. Same coverage, no warning.
            forRoutes: ['{*path}'],
            pinoHttp: {
              level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
              transport: prettyTransport(),
              genReqId: (req, res) => {
                const incoming = req.headers['x-request-id'];
                const id =
                  (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
                res.setHeader('x-request-id', id);
                return id;
              },
              redact: ['req.headers.authorization', 'req.headers.cookie'],
            },
          }),
        ]),

    // Baseline ceiling for every route. Login routes narrow this further with
    // their own @Throttle — see AuthController / PlatformAuthController.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    RequestContextModule,
    EntitlementsModule,
    AuthzModule,
    ClinicAuditModule,
    MfaModule,
    OAuthModule,
    OAuthRoutesModule,
    StorageModule,
    TenancyModule,
    HealthModule,
    AuthModule,
    PatientsModule,
    PatientHistoryModule,
    DocumentsModule,
    AppointmentsModule,
    SchedulingModule,
    StaffModule,
    TreatmentsModule,
    ChartingModule,
    PerioModule,
    TreatmentPlansModule,
    SettingsModule,
    FinanceModule,
    ReportsModule,
    BillingModule,
    AnalyticsModule,
    RemindersModule,
    AuditModule,
    InventoryModule,
    PartnersModule,
    LabModule,
    FiscalizationModule,
    FeaturesModule,
    CashDrawerModule,
    WhatsAppModule,
    PlatformAuthModule,
    TenantsModule,
    PlansModule,
    PlatformBillingModule,
    PlatformUsageModule,
    PlatformActivityModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global, so a controller written next month is covered without anyone
    // remembering to opt in. Outside the clinic plane it is a no-op.
    { provide: APP_GUARD, useClass: ReadOnlyGuard },
    // Global and inert unless a route is marked @Idempotent() and the request
    // carries an Idempotency-Key (0013).
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  /**
   * Every route resolves a clinic, except the ones that cannot.
   *
   * This was a hand-maintained list of thirty-five controllers. The list was
   * correct; the problem is what happens when it stops being — a clinic
   * controller added without being named here keeps working, keeps returning
   * rows, and nothing anywhere fails. See core/tenancy/tenant-routes.ts for
   * the exclusions and why each one is there.
   */
  configure(consumer: MiddlewareConsumer): void {
    // Request id, client IP and user agent for the evidence tables. First, and
    // on every route: platform and health requests are requests too.
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');

    consumer
      .apply(TenantMiddleware)
      .exclude(...tenantMiddlewareExclusions())
      // Every route, spelled as a named optional splat. Nest 11 joins a bare
      // '*' to the global prefix as '/api/*', which path-to-regexp v8 cannot
      // parse; it auto-converted that to this same pattern but logged an
      // "Unsupported route path" warning three times on every boot doing so.
      .forRoutes('{*path}');
  }
}
