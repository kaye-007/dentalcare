import { randomUUID } from 'node:crypto';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from '@/core/config/config.module';
import { AuthzModule } from '@/core/authz/authz.module';
import { ClinicAuditModule } from '@/core/audit/clinic-audit.module';
import { ReadOnlyGuard } from '@/core/tenancy/read-only.guard';
import { OAuthModule } from '@/core/oauth/oauth.module';
import { OAuthRoutesModule } from '@/core/oauth/oauth-routes.module';
import { StorageModule } from '@/core/storage/storage.module';
import { DatabaseModule } from '@/core/database/database.module';
import { HealthModule } from '@/core/health/health.module';
import { TenancyModule } from '@/core/tenancy/tenancy.module';
import { TenantMiddleware } from '@/core/tenancy/tenant.middleware';
import { AuthController, AuthModule } from '@/modules/clinic/auth';
import { PatientsController, PatientsModule } from '@/modules/clinic/patients';
import { AllergiesController, ConditionsController, MedicationsController, PatientHistoryController, PatientHistoryModule } from '@/modules/clinic/patient-history';
import { DocumentsController, DocumentsModule, PatientDocumentsController } from '@/modules/clinic/documents';
import { AppointmentsController, AppointmentsModule } from '@/modules/clinic/appointments';
import { AvailabilityController, OperatoriesController, SchedulingModule } from '@/modules/clinic/scheduling';
import { StaffController, StaffModule } from '@/modules/clinic/staff';
import { TreatmentsController, TreatmentsModule } from '@/modules/clinic/treatments';
import { ChartController, ChartingModule, PatientProceduresController, ProcedureCodesController, ProceduresController, ToothConditionsController } from '@/modules/clinic/charting';
import { PatientPerioController, PerioExamsController, PerioModule } from '@/modules/clinic/perio';
import { PatientPlansController, PlanItemsController, TreatmentPlansController, TreatmentPlansModule } from '@/modules/clinic/treatment-plans';
import { SettingsController, SettingsModule } from '@/modules/clinic/settings';
import { ExpensesController, FinanceModule, FinanceSummaryController, InvoicesController, PaymentsController } from '@/modules/clinic/finance';
import { ReportsController, ReportsModule } from '@/modules/clinic/reports';
import { BillingController, BillingModule, PatientLedgerController, PlanInvoiceController } from '@/modules/clinic/billing';
import { AnalyticsController, AnalyticsModule } from '@/modules/clinic/analytics';
import { RemindersController, RemindersModule } from '@/modules/clinic/reminders';
import { AuditController, AuditModule } from '@/modules/clinic/audit';
import { PlatformAuthModule } from '@/modules/platform/auth';
import { TenantsModule } from '@/modules/platform/tenants';
import { PlansModule } from '@/modules/platform/plans';

/**
 * Cloudflare Workers changes what the process can do, not what the app does.
 * Read once here so the module graph below stays declarative.
 */
const IS_WORKERS = process.env.RUNTIME === 'workers';

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
            pinoHttp: {
              level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
              transport:
                process.env.NODE_ENV === 'production'
                  ? undefined
                  : { target: 'pino-pretty', options: { singleLine: true } },
              genReqId: (req, res) => {
                const incoming = req.headers['x-request-id'];
                const id =
                  (Array.isArray(incoming) ? incoming[0] : incoming) ||
                  randomUUID();
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
    AuthzModule,
    ClinicAuditModule,
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
    PlatformAuthModule,
    TenantsModule,
    PlansModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global, so a controller written next month is covered without anyone
    // remembering to opt in. Outside the clinic plane it is a no-op.
    { provide: APP_GUARD, useClass: ReadOnlyGuard },
  ],
})
export class AppModule implements NestModule {
  // Tenant resolution applies to clinic (tenant-plane) routes. Health stays
  // global; future tenant controllers get added here as milestones land.
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantMiddleware)
      .forRoutes(
        AuthController,
        PatientsController,
        PatientHistoryController,
        AllergiesController,
        ConditionsController,
        MedicationsController,
        PatientDocumentsController,
        DocumentsController,
        AppointmentsController,
        OperatoriesController,
        AvailabilityController,
        StaffController,
        TreatmentsController,
        ChartController,
        ToothConditionsController,
        ProcedureCodesController,
        PatientProceduresController,
        ProceduresController,
        PatientPerioController,
        PerioExamsController,
        PatientPlansController,
        TreatmentPlansController,
        PlanItemsController,
        SettingsController,
        InvoicesController,
        PaymentsController,
        ExpensesController,
        FinanceSummaryController,
        ReportsController,
        PlanInvoiceController,
        PatientLedgerController,
        BillingController,
        AnalyticsController,
        RemindersController,
        AuditController,
      );
  }
}
