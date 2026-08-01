import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { AuthModule } from '../auth/auth.module';

export interface WorkingDay {
  day: number;          // 0 = Monday … 6 = Sunday
  closed: boolean;
  open: string;         // 'HH:MM'
  close: string;        // 'HH:MM'
}

export const DEFAULT_HOURS: WorkingDay[] = [
  { day: 0, closed: false, open: '09:00', close: '17:00' },
  { day: 1, closed: false, open: '09:00', close: '17:00' },
  { day: 2, closed: false, open: '09:00', close: '17:00' },
  { day: 3, closed: false, open: '09:00', close: '17:00' },
  { day: 4, closed: false, open: '09:00', close: '17:00' },
  { day: 5, closed: false, open: '09:00', close: '14:00' },
  { day: 6, closed: true, open: '09:00', close: '14:00' },
];

export class UpdateSettingsDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  clinicName?: string;

  @IsOptional() @IsString() @MaxLength(200)
  address?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsEmail({}, { message: 'Enter a valid clinic email' })
  email?: string;

  @IsOptional() @IsArray()
  workingHours?: WorkingDay[];

  @IsOptional() @IsInt() @Min(15) @Max(240)
  defaultAppointmentDuration?: number;

  @IsOptional() @IsBoolean()
  remindersEnabled?: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(168)
  reminderHoursBefore?: number;

  @IsOptional() @IsBoolean()
  payrollLoggingEnabled?: boolean;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateHours(hours: WorkingDay[]) {
  if (hours.length !== 7) throw new BadRequestException('Working hours must cover all 7 days');
  for (const h of hours) {
    if (typeof h.day !== 'number' || h.day < 0 || h.day > 6) {
      throw new BadRequestException('Invalid day in working hours');
    }
    if (typeof h.closed !== 'boolean') throw new BadRequestException('Invalid closed flag');
    if (!h.closed) {
      if (!TIME_RE.test(h.open) || !TIME_RE.test(h.close)) {
        throw new BadRequestException('Times must be in HH:MM format');
      }
      if (h.close <= h.open) {
        throw new BadRequestException('Closing time must be after opening time');
      }
    }
  }
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  get() {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const t = await client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantId]);
      const s = await client.query(
        `SELECT address, city, phone, email, working_hours, default_appointment_duration,
                reminders_enabled, reminder_hours_before, payroll_logging_enabled
           FROM clinic_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      const row = s.rows[0];
      return {
        clinicName: t.rows[0]?.name ?? '',
        address: row?.address ?? '',
        city: row?.city ?? '',
        phone: row?.phone ?? '',
        email: row?.email ?? '',
        workingHours:
          row && Array.isArray(row.working_hours) && row.working_hours.length === 7
            ? (row.working_hours as WorkingDay[])
            : DEFAULT_HOURS,
        defaultAppointmentDuration: row?.default_appointment_duration ?? 45,
        remindersEnabled: row?.reminders_enabled ?? false,
        reminderHoursBefore: row?.reminder_hours_before ?? 24,
        payrollLoggingEnabled: row?.payroll_logging_enabled ?? true,
      };
    });
  }

  async update(dto: UpdateSettingsDto) {
    if (dto.workingHours) validateHours(dto.workingHours);
    const tenantId = this.tenant.getRequiredTenantId();
    await this.db.withTenant(tenantId, async (client) => {
      if (dto.clinicName !== undefined) {
        await client.query('UPDATE tenants SET name = $1, updated_at = now() WHERE id = $2', [
          dto.clinicName,
          tenantId,
        ]);
      }
      await client.query(
        `INSERT INTO clinic_settings
           (tenant_id, address, city, phone, email, working_hours, default_appointment_duration,
            reminders_enabled, reminder_hours_before, payroll_logging_enabled)
         VALUES ($1,$2,$3,$4,$5, coalesce($6::jsonb, '[]'::jsonb), coalesce($7, 45),
                 coalesce($8, false), coalesce($9, 24), coalesce($10, true))
         ON CONFLICT (tenant_id) DO UPDATE SET
           address = coalesce($2, clinic_settings.address),
           city = coalesce($3, clinic_settings.city),
           phone = coalesce($4, clinic_settings.phone),
           email = coalesce($5, clinic_settings.email),
           working_hours = coalesce($6, clinic_settings.working_hours),
           default_appointment_duration = coalesce($7, clinic_settings.default_appointment_duration),
           reminders_enabled = coalesce($8, clinic_settings.reminders_enabled),
           reminder_hours_before = coalesce($9, clinic_settings.reminder_hours_before),
           payroll_logging_enabled = coalesce($10, clinic_settings.payroll_logging_enabled),
           updated_at = now()`,
        [
          tenantId,
          dto.address ?? null,
          dto.city ?? null,
          dto.phone ?? null,
          dto.email ?? null,
          dto.workingHours ? JSON.stringify(dto.workingHours) : null,
          dto.defaultAppointmentDuration ?? null,
          dto.remindersEnabled ?? null,
          dto.reminderHoursBefore ?? null,
          dto.payrollLoggingEnabled ?? null,
        ],
      );
    });
    return this.get();
  }
}

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Patch()
  @UseGuards(OwnerGuard)
  update(@Body() dto: UpdateSettingsDto) {
    return this.settings.update(dto);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService, OwnerGuard],
})
export class SettingsModule {}
