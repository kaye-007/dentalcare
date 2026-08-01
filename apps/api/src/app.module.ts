import { randomUUID } from 'node:crypto';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './core/config/config.module';
import { DatabaseModule } from './core/database/database.module';
import { HealthModule } from './core/health/health.module';
import { TenancyModule } from './core/tenancy/tenancy.module';
import { TenantMiddleware } from './core/tenancy/tenant.middleware';
import { AuthModule } from './tenant/auth/auth.module';
import { AuthController } from './tenant/auth/auth.controller';
import { PatientsModule, PatientsController } from './tenant/patients/patients.module';
import { AppointmentsModule, AppointmentsController } from './tenant/appointments/appointments.module';
import { StaffModule, StaffController } from './tenant/staff/staff.module';
import { TreatmentsModule, TreatmentsController } from './tenant/treatments/treatments.module';
import { MedicalRecordModule, MedicalRecordController } from './tenant/medical-record/medical-record.module';
import { SettingsModule, SettingsController } from './tenant/settings/settings.module';
import {
  FinanceModule,
  InvoicesController,
  PaymentsController,
  ExpensesController,
  FinanceSummaryController,
} from './tenant/finance/finance.module';
import { ReportsModule, ReportsController } from './tenant/reports/reports.module';
import { RemindersModule, RemindersController } from './tenant/reminders/reminders.module';
import { PlatformAuthModule } from './platform/platform-auth/platform-auth.module';
import { TenantsModule } from './platform/tenants/tenants.module';
import { PlansModule } from './platform/plans/plans.module';

@Module({
  imports: [
    AppConfigModule,
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
            (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    DatabaseModule,
    TenancyModule,
    HealthModule,
    AuthModule,
    PatientsModule,
    AppointmentsModule,
    StaffModule,
    TreatmentsModule,
    MedicalRecordModule,
    SettingsModule,
    FinanceModule,
    ReportsModule,
    RemindersModule,
    PlatformAuthModule,
    TenantsModule,
    PlansModule,
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
        AppointmentsController,
        StaffController,
        TreatmentsController,
        MedicalRecordController,
        SettingsController,
        InvoicesController,
        PaymentsController,
        ExpensesController,
        FinanceSummaryController,
        ReportsController,
        RemindersController,
      );
  }
}
