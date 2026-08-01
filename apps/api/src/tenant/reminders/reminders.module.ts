import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessTokenPayload } from '../auth/auth.service';
import { AuthModule } from '../auth/auth.module';
import { ChannelRegistry, LogChannel } from './channels/channels';

/* ════════ shared ════════ */
interface ReminderRow {
  id: string;
  appointment_id: string;
  type: string;
  channel: string;
  status: string;
  message: string;
  error: string | null;
  sent_at: string | null;
  created_at: string;
  patient_name: string | null;
  appointment_starts_at: string | null;
  appointment_reason: string | null;
}

const SELECT = `
  SELECT r.id, r.appointment_id, r.type, r.channel, r.status, r.message,
         r.error, r.sent_at, r.created_at,
         (p.first_name || ' ' || p.last_name) AS patient_name,
         a.starts_at AS appointment_starts_at, a.reason AS appointment_reason
    FROM reminders r
    JOIN appointments a ON a.id = r.appointment_id
    JOIN patients p ON p.id = a.patient_id`;

const map = (r: ReminderRow) => ({
  id: r.id,
  appointmentId: r.appointment_id,
  type: r.type,
  channel: r.channel,
  status: r.status,
  message: r.message,
  error: r.error,
  sentAt: r.sent_at,
  createdAt: r.created_at,
  patientName: r.patient_name,
  appointmentStartsAt: r.appointment_starts_at,
  appointmentReason: r.appointment_reason,
});

function renderMessage(opts: {
  patient: string;
  clinic: string;
  startsAt: Date;
  reason: string;
}): string {
  const date = opts.startsAt.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const time = opts.startsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `Hi ${opts.patient}, this is a reminder of your appointment (${opts.reason}) at ${opts.clinic} on ${date} at ${time}. Reply to the clinic if you need to reschedule.`;
}

/* ════════ service ════════ */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly channels: ChannelRegistry,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /* request-scoped: list log (optionally per appointment) */
  list(appointmentId?: string) {
    return this.tx(async (client) => {
      const params: unknown[] = [];
      let where = '';
      if (appointmentId) {
        params.push(appointmentId);
        where = `WHERE r.appointment_id = $1`;
      }
      const { rows } = await client.query<ReminderRow>(
        `${SELECT} ${where} ORDER BY r.created_at DESC LIMIT 200`,
        params,
      );
      return rows.map(map);
    });
  }

  /* request-scoped: manual trigger for one appointment */
  sendManual(appointmentId: string, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const appt = await client.query<{
        starts_at: string; status: string; reason: string;
        patient_name: string; patient_phone: string | null; clinic_name: string;
      }>(
        `SELECT a.starts_at, a.status, a.reason,
                (p.first_name || ' ' || p.last_name) AS patient_name,
                p.phone AS patient_phone,
                t.name AS clinic_name
           FROM appointments a
           JOIN patients p ON p.id = a.patient_id
           JOIN tenants t ON t.id = a.tenant_id
          WHERE a.id = $1`,
        [appointmentId],
      );
      const row = appt.rows[0];
      if (!row) throw new NotFoundException('Appointment not found');
      if (row.status !== 'scheduled') {
        throw new BadRequestException('Reminders can only be sent for scheduled appointments');
      }
      const message = renderMessage({
        patient: row.patient_name,
        clinic: row.clinic_name,
        startsAt: new Date(row.starts_at),
        reason: row.reason,
      });
      const id = await this.deliver(client, {
        tenantId,
        appointmentId,
        type: 'manual',
        message,
        to: row.patient_phone,
        createdBy: userId,
      });
      const out = await client.query<ReminderRow>(`${SELECT} WHERE r.id = $1`, [id]);
      return map(out.rows[0]!);
    });
  }

  /* scheduler-scoped: scan one tenant for due automatic reminders */
  async scanTenant(tenantId: string, hoursBefore: number): Promise<number> {
    return this.db.withTenant(tenantId, async (client) => {
      const due = await client.query<{
        id: string; starts_at: string; reason: string;
        patient_name: string; patient_phone: string | null; clinic_name: string;
      }>(
        `SELECT a.id, a.starts_at, a.reason,
                (p.first_name || ' ' || p.last_name) AS patient_name,
                p.phone AS patient_phone,
                t.name AS clinic_name
           FROM appointments a
           JOIN patients p ON p.id = a.patient_id
           JOIN tenants t ON t.id = a.tenant_id
          WHERE a.status = 'scheduled'
            AND a.starts_at > now()
            AND a.starts_at <= now() + ($1 || ' hours')::interval
            AND NOT EXISTS (
              SELECT 1 FROM reminders r
               WHERE r.appointment_id = a.id AND r.type = 'automatic'
            )
          ORDER BY a.starts_at
          LIMIT 100`,
        [String(hoursBefore)],
      );
      let sent = 0;
      for (const a of due.rows) {
        const message = renderMessage({
          patient: a.patient_name,
          clinic: a.clinic_name,
          startsAt: new Date(a.starts_at),
          reason: a.reason,
        });
        try {
          await this.deliver(client, {
            tenantId,
            appointmentId: a.id,
            type: 'automatic',
            message,
            to: a.patient_phone,
            createdBy: null,
          });
          sent += 1;
        } catch (err: unknown) {
          // unique-index race (another scan got there first) — safe to skip
          if ((err as { code?: string }).code === '23505') continue;
          throw err;
        }
      }
      return sent;
    });
  }

  /** Insert the reminder row, deliver via the active channel, record outcome. */
  private async deliver(
    client: PoolClient,
    opts: {
      tenantId: string;
      appointmentId: string;
      type: 'automatic' | 'manual';
      message: string;
      to: string | null;
      createdBy: string | null;
    },
  ): Promise<string> {
    const channel = this.channels.active();
    const ins = await client.query<{ id: string }>(
      `INSERT INTO reminders (tenant_id, appointment_id, type, channel, status, message, created_by)
       VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING id`,
      [opts.tenantId, opts.appointmentId, opts.type, channel.id, opts.message, opts.createdBy],
    );
    const id = ins.rows[0]!.id;
    try {
      await channel.send({ to: opts.to, message: opts.message });
      await client.query(
        `UPDATE reminders SET status = 'sent', sent_at = now() WHERE id = $1`,
        [id],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'delivery failed';
      await client.query(
        `UPDATE reminders SET status = 'failed', error = $2 WHERE id = $1`,
        [id, msg.slice(0, 500)],
      );
      this.logger.error(`reminder ${id} failed: ${msg}`);
    }
    return id;
  }
}

/* ════════ scheduler ════════
 * A real server-side background job: every REMINDER_SCAN_INTERVAL_MS it scans
 * all active tenants with reminders enabled and creates+delivers due
 * automatic reminders. It runs in-process in the API for the MVP single-VPS
 * deployment; because the scan is idempotent (partial unique index on
 * automatic reminders), it can be lifted into a dedicated worker process or a
 * BullMQ repeatable job post-MVP without any schema or logic change. */
@Injectable()
export class ReminderSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReminderSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly reminders: RemindersService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval = this.config.get<number>('REMINDER_SCAN_INTERVAL_MS') ?? 60_000;
    this.timer = setInterval(() => void this.tick(), interval);
    this.logger.log(`reminder scheduler started (every ${interval}ms, channel: internal log)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return; // never overlap scans
    this.running = true;
    try {
      const tenants = await this.db.adminQuery<{
        id: string;
        reminder_hours_before: number;
      }>(
        `SELECT t.id, cs.reminder_hours_before
           FROM tenants t
           JOIN clinic_settings cs ON cs.tenant_id = t.id
          WHERE t.status = 'active' AND cs.reminders_enabled = true`,
      );
      for (const t of tenants.rows) {
        const sent = await this.reminders.scanTenant(t.id, t.reminder_hours_before);
        if (sent > 0) this.logger.log(`tenant ${t.id}: ${sent} automatic reminder(s) sent`);
      }
    } catch (err: unknown) {
      this.logger.error(`scan failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }
}

/* ════════ controller ════════ */
@Controller()
@UseGuards(JwtAuthGuard)
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get('reminders')
  list(@Query('appointmentId') appointmentId?: string) {
    return this.reminders.list(appointmentId);
  }

  @Post('appointments/:id/reminders')
  sendManual(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.reminders.sendManual(id, user.sub);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [RemindersController],
  providers: [RemindersService, ReminderSchedulerService, LogChannel, ChannelRegistry],
})
export class RemindersModule {}
