import {
  BadRequestException,
  Body,
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
import { IsIn, IsOptional } from 'class-validator';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PermissionsGuard } from '../../core/authz/permissions.guard';
import { RequirePermissions } from '../../core/authz/permissions.decorator';
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
  /**
   * `channel` records HOW the clinic is contacting the patient.
   *
   *   'whatsapp' | 'email' — the staff member is opening their own WhatsApp or
   *     mail app from the appointment screen. Nothing is delivered by this
   *     server, so the row records a HAND-OFF, not a delivery. Only the person
   *     who pressed send knows whether the message actually went.
   *   'log' (default) — the built-in internal channel, delivered here.
   */
  async sendManual(
    appointmentId: string,
    userId: string,
    channel: 'log' | 'whatsapp' | 'email' = 'log',
  ) {
    const tenantId = this.tenant.getRequiredTenantId();

    const row = await this.db.withTenant(tenantId, async (client) => {
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
      const r = appt.rows[0];
      if (!r) throw new NotFoundException('Appointment not found');
      if (r.status !== 'scheduled') {
        throw new BadRequestException('Reminders can only be sent for scheduled appointments');
      }
      return r;
    });

    const message = renderMessage({
      patient: row.patient_name,
      clinic: row.clinic_name,
      startsAt: new Date(row.starts_at),
      reason: row.reason,
    });

    const id = await this.createReminder(tenantId, {
      appointmentId,
      type: 'manual',
      message,
      createdBy: userId,
      channel,
    });

    if (channel === 'log') {
      await this.deliverAndRecord(tenantId, id, row.patient_phone, message);
    } else {
      // Handed to the staff member's own app. Mark it as dispatched — there is
      // no delivery receipt to wait for and nothing this server can retry.
      await this.db.withTenant(tenantId, async (client) => {
        await client.query(
          `UPDATE reminders SET status = 'sent', sent_at = now() WHERE id = $1`,
          [id],
        );
      });
    }

    return this.db.withTenant(tenantId, async (client) => {
      const out = await client.query<ReminderRow>(`${SELECT} WHERE r.id = $1`, [id]);
      return map(out.rows[0]!);
    });
  }

  /* scheduler-scoped: scan one tenant for due automatic reminders */
  async scanTenant(tenantId: string, hoursBefore: number): Promise<number> {
    const due = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query<{
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
      return res.rows;
    });

    let sent = 0;
    for (const a of due) {
      const message = renderMessage({
        patient: a.patient_name,
        clinic: a.clinic_name,
        startsAt: new Date(a.starts_at),
        reason: a.reason,
      });
      let id: string;
      try {
        id = await this.createReminder(tenantId, {
          appointmentId: a.id,
          type: 'automatic',
          message,
          createdBy: null,
        });
      } catch (err: unknown) {
        // Unique-index race: another scanner claimed this appointment first.
        // Safe to skip — and safe to *continue* the loop, because each claim
        // now runs in its own transaction. Previously the whole scan shared
        // one transaction, so the 23505 aborted it and every following
        // statement failed with 25P02, discarding the entire pass.
        if ((err as { code?: string }).code === '23505') continue;
        throw err;
      }
      await this.deliverAndRecord(tenantId, id, a.patient_phone, message);
      sent += 1;
    }
    return sent;
  }

  /**
   * Claim the appointment by inserting a pending reminder row, in its own
   * short transaction. Throws 23505 if another scanner got there first.
   */
  private async createReminder(
    tenantId: string,
    opts: {
      appointmentId: string;
      type: 'automatic' | 'manual';
      message: string;
      createdBy: string | null;
      /** Overrides the configured channel for manual hand-offs. */
      channel?: string;
    },
  ): Promise<string> {
    const channelId = opts.channel ?? this.channels.active().id;
    return this.db.withTenant(tenantId, async (client) => {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO reminders (tenant_id, appointment_id, type, channel, status, message, created_by)
         VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING id`,
        [tenantId, opts.appointmentId, opts.type, channelId, opts.message, opts.createdBy],
      );
      return ins.rows[0]!.id;
    });
  }

  /**
   * Deliver through the active channel and record the outcome.
   *
   * Delivery happens OUTSIDE any transaction. Sending is a network call to a
   * third party: holding a database connection open for its duration would tie
   * up the pool, and — more seriously — a later rollback would erase the
   * reminder row after the message had already left, so the next scan would
   * send it again. Committing the claim first, then delivering, keeps the
   * at-most-once guarantee that the partial unique index is there to provide.
   */
  private async deliverAndRecord(
    tenantId: string,
    id: string,
    to: string | null,
    message: string,
  ): Promise<void> {
    const channel = this.channels.active();
    let error: string | null = null;
    try {
      await channel.send({ to, message });
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'delivery failed';
      this.logger.error(`reminder ${id} failed: ${error}`);
    }

    try {
      await this.db.withTenant(tenantId, async (client) => {
        if (error === null) {
          await client.query(
            `UPDATE reminders SET status = 'sent', sent_at = now() WHERE id = $1`,
            [id],
          );
        } else {
          await client.query(
            `UPDATE reminders SET status = 'failed', error = $2 WHERE id = $1`,
            [id, error.slice(0, 500)],
          );
        }
      });
    } catch (err: unknown) {
      // The message may already have gone out; leaving the row 'pending' is
      // the honest record. Never let bookkeeping failure abort the scan.
      this.logger.error(
        `reminder ${id}: could not record outcome: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/* ════════ scheduler ════════
 * Scans every active tenant with reminders enabled and creates + delivers the
 * automatic reminders that have come due.
 *
 * WHO CALLS tick() DEPENDS ON THE RUNTIME:
 *
 *   node    — this service owns a setInterval, as it always has. That is what
 *             a long-running container should do.
 *   workers — nothing here runs it. A Worker has no resident process between
 *             requests to hold a timer, so the hourly Cron Trigger declared in
 *             wrangler.jsonc calls tick() through the scheduled handler in
 *             apps/api/worker/index.ts.
 *
 * Either way the scan is idempotent — a partial unique index on automatic
 * reminders means a duplicate or overlapping pass claims nothing and delivers
 * nothing — so nothing about the schema or the logic changes between the
 * two runtimes. */
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
    if (this.config.get<string>('RUNTIME') === 'workers') {
      this.logger.log(
        'reminder scheduler idle in-process — driven by the Cloudflare Cron Trigger',
      );
      return;
    }
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
export class SendReminderDto {
  @IsOptional()
  @IsIn(['log', 'whatsapp', 'email'])
  channel?: 'log' | 'whatsapp' | 'email';
}

// Bare @Controller() on purpose: the two routes below live under different
// resource roots ('reminders' and 'appointments/:id/reminders'), so each
// carries its full path rather than sharing a prefix.
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get('reminders')
  @RequirePermissions('reminders:read')
  list(@Query('appointmentId') appointmentId?: string) {
    return this.reminders.list(appointmentId);
  }

  @Post('appointments/:id/reminders')
  @RequirePermissions('reminders:send')
  sendManual(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendReminderDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.reminders.sendManual(id, user.sub, body?.channel ?? 'log');
  }
}

@Module({
  imports: [AuthModule],
  controllers: [RemindersController],
  providers: [RemindersService, ReminderSchedulerService, LogChannel, ChannelRegistry],
})
export class RemindersModule {}
