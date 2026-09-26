import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import {
  defaultReminderTemplate,
  formatAppointmentTime,
  isReminderLocale,
  isTimeZone,
  renderReminder,
  toE164,
  type MessagePurpose,
  type ReminderLocale,
  type ReminderValues,
} from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { DeliveryError, type ReminderChannel, type TemplateValues } from './channels/channels';
import { ChannelRegistry } from './channels/registry';
import {
  applyReceipt,
  providerStatusToReminder,
  retryDelayMinutes,
  type ReminderStatus,
} from './delivery-policy';
import type { ManualChannel } from './dto/reminders.dto';

/* ════════ rows ════════ */
interface ReminderRow {
  id: string;
  appointment_id: string | null;
  patient_id: string;
  purpose: MessagePurpose;
  invoice_id: string | null;
  sent_by_name: string | null;
  type: string;
  channel: string;
  status: string;
  message: string;
  error: string | null;
  error_code: string | null;
  to_address: string | null;
  attempts: number;
  next_attempt_at: string | null;
  provider_status: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  created_at: string;
  patient_name: string | null;
  appointment_starts_at: string | null;
  appointment_reason: string | null;
}

export const REMINDER_SELECT = `
  SELECT r.id, r.appointment_id, r.patient_id, r.purpose, r.invoice_id,
         r.type, r.channel, r.status, r.message,
         r.error, r.error_code, r.to_address, r.attempts, r.next_attempt_at,
         r.provider_status, r.sent_at, r.delivered_at, r.created_at,
         (p.first_name || ' ' || p.last_name) AS patient_name,
         a.starts_at AS appointment_starts_at, a.reason AS appointment_reason,
         u.full_name AS sent_by_name
    FROM reminders r
    JOIN patients p ON p.id = r.patient_id
    LEFT JOIN appointments a ON a.id = r.appointment_id
    LEFT JOIN users u ON u.id = r.created_by`;
const SELECT = REMINDER_SELECT;

export const mapReminder = (r: ReminderRow) => ({
  id: r.id,
  appointmentId: r.appointment_id,
  patientId: r.patient_id,
  /** appointment_reminder | post_procedure_followup | unpaid_balance */
  purpose: r.purpose,
  invoiceId: r.invoice_id,
  /** Who sent it; null for an automatic reminder. */
  sentByName: r.sent_by_name,
  type: r.type,
  channel: r.channel,
  status: r.status,
  message: r.message,
  error: r.error,
  errorCode: r.error_code,
  toAddress: r.to_address,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  providerStatus: r.provider_status,
  sentAt: r.sent_at,
  deliveredAt: r.delivered_at,
  createdAt: r.created_at,
  patientName: r.patient_name,
  appointmentStartsAt: r.appointment_starts_at,
  appointmentReason: r.appointment_reason,
});
const map = mapReminder;
export type MessageRecord = ReturnType<typeof mapReminder>;

/** What a clinic's reminders are written with. */
export interface ClinicContext {
  name: string;
  phone: string | null;
  /** "Rruga e Kavajës 12, Tiranë" — street and city, as a patient needs it. */
  address: string | null;
  timezone: string;
  locale: ReminderLocale;
  template: string | null;
  countryCode: string;
  /** The clinic's default channel id; a patient may have chosen another. */
  channel: string;
}

interface Recipient {
  patient_id: string;
  starts_at: string | Date;
  first_name: string;
  phone: string | null;
  reminders_opt_out: boolean;
  preferred_channel: string | null;
  dentist_name: string | null;
}

/** The appointment and patient columns every reminder is written from. */
const RECIPIENT_COLUMNS = `a.patient_id, a.starts_at, p.first_name, p.phone, p.reminders_opt_out,
       p.preferred_channel, u.full_name AS dentist_name`;
const RECIPIENT_JOINS = `JOIN patients p ON p.id = a.patient_id
           LEFT JOIN users u ON u.id = a.staff_id`;

export interface ScanResult {
  sent: number;
  skipped: number;
  failed: number;
  retrying: number;
}

export type AttemptOutcome = 'sent' | 'retrying' | 'failed' | 'skipped';

/** How much one scan of one clinic may claim and attempt. */
const SCAN_LIMIT = 100;

function valuesFor(ctx: ClinicContext, who: Recipient): ReminderValues {
  const { date, time } = formatAppointmentTime(new Date(who.starts_at), ctx.timezone, ctx.locale);
  return {
    first_name: who.first_name,
    clinic: ctx.name,
    date,
    time,
    clinic_phone: ctx.phone ?? '',
    dentist: who.dentist_name ?? '',
    clinic_address: ctx.address ?? '',
  };
}

/**
 * The message for a channel. A template channel (WhatsApp) cannot send the
 * clinic's own wording, so its row records the built-in wording instead —
 * closer to what the patient actually sees.
 */
function compose(ctx: ClinicContext, who: Recipient, channel: ReminderChannel): string {
  const template =
    channel.kind === 'whatsapp' || !ctx.template
      ? defaultReminderTemplate(ctx.locale, Boolean(ctx.phone))
      : ctx.template;
  return renderReminder(template, valuesFor(ctx, who));
}

function templateValuesFor(ctx: ClinicContext, who: Recipient, channel: ReminderChannel): TemplateValues | null {
  if (channel.kind !== 'whatsapp') return null;
  const v = valuesFor(ctx, who);
  return {
    locale: ctx.locale,
    purpose: 'appointment_reminder',
    first_name: v.first_name,
    date: v.date,
    time: v.time,
    dentist: v.dentist,
    clinic: v.clinic,
  };
}

async function optOut(client: PoolClient, patientId: string, source: 'patient' | 'provider') {
  await client.query(
    `UPDATE patients
        SET reminders_opt_out = true,
            reminders_opt_out_at = coalesce(reminders_opt_out_at, now()),
            reminders_opt_out_source = coalesce(reminders_opt_out_source, $2),
            updated_at = now()
      WHERE id = $1`,
    [patientId, source],
  );
}

/* ════════ service ════════ */
/**
 * Appointment reminders: claiming, sending, retrying and receipts.
 *
 * ── The shape of one reminder ─────────────────────────────────────────────
 *
 *   claim     INSERT a row — pending, or skipped with the reason — in its own
 *             transaction. For automatic reminders the partial unique index
 *             on (appointment_id) makes that the at-most-once guarantee: two
 *             scanners racing for one appointment get one row.
 *   lease     pending → sending, again in its own transaction, so a second
 *             scanner cannot attempt the same row.
 *   send      OUTSIDE any transaction. It is a network call to a third party;
 *             holding a connection for it ties up the pool, and a rollback
 *             after the message left would erase the record that it did.
 *   settle    sending → sent, pending (retry later) or failed.
 *
 * A process that dies between send and settle leaves the row 'sending', and
 * nothing retries it. Whether that message went is a question for the
 * provider's log, and guessing "no" would text the patient twice.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly registry: ChannelRegistry,
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

  /** Which ways of reaching a patient this deployment has. */
  deliveryChannels() {
    const sms = this.registry.sms();
    const available = this.registry.available();
    return {
      active: this.registry.active().id,
      sms: sms !== null,
      whatsappBusiness: available.whatsapp_business,
      viber: available.viber,
      deliveryReceipts: sms?.receiptsEnabled() ?? false,
    };
  }

  /**
   * A reminder sent by a person from the appointment screen.
   *
   *   'sms'               sent now through the SMS provider
   *   'whatsapp'|'email'  the staff member's own app opened with the message;
   *                       nothing is delivered by this server, so the row
   *                       records a HAND-OFF, not a delivery
   *   'log' (default)     recorded on the internal log
   */
  async sendManual(appointmentId: string, userId: string, channel: ManualChannel = 'log') {
    const tenantId = this.tenant.getRequiredTenantId();

    const { who, ctx } = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query<Recipient & { status: string }>(
        `SELECT ${RECIPIENT_COLUMNS}, a.status
           FROM appointments a
           ${RECIPIENT_JOINS}
          WHERE a.id = $1`,
        [appointmentId],
      );
      const row = res.rows[0];
      if (!row) throw new NotFoundException('Appointment not found');
      if (row.status !== 'scheduled') {
        throw new BadRequestException('Reminders can only be sent for scheduled appointments');
      }
      return { who: row, ctx: await this.clinicContext(client, tenantId) };
    });

    const to = toE164(who.phone, ctx.countryCode);
    let id: string;

    if (channel === 'sms') {
      const sms = this.registry.sms();
      if (!sms) throw new BadRequestException('No SMS provider is configured for this deployment');
      if (who.reminders_opt_out) {
        throw new ConflictException('This patient has opted out of reminders');
      }
      if (!to) throw new BadRequestException('The patient has no usable mobile number on file');
      id = await this.claim(tenantId, {
        appointmentId, patientId: who.patient_id, purpose: 'appointment_reminder',
        type: 'manual', channel: sms.id, status: 'pending',
        message: compose(ctx, who, sms), to, createdBy: userId,
      });
      await this.attempt(tenantId, id);
    } else if (channel === 'log') {
      const log = this.registry.byId('log')!;
      id = await this.claim(tenantId, {
        appointmentId, patientId: who.patient_id, purpose: 'appointment_reminder',
        type: 'manual', channel: 'log', status: 'pending',
        message: compose(ctx, who, log), to, createdBy: userId,
      });
      await this.attempt(tenantId, id);
    } else {
      // Handed to the staff member's own app. There is no receipt to wait for
      // and nothing this server can retry.
      id = await this.claim(tenantId, {
        appointmentId, patientId: who.patient_id, purpose: 'appointment_reminder',
        type: 'manual', channel, status: 'sent',
        message: compose(ctx, who, this.registry.byId('log')!), to, createdBy: userId,
      });
    }

    return this.db.withTenant(tenantId, async (client) => {
      const out = await client.query<ReminderRow>(`${SELECT} WHERE r.id = $1`, [id]);
      return map(out.rows[0]!);
    });
  }

  /**
   * One pass over one clinic: claim what has come due, retire what can no
   * longer be sent, and attempt everything waiting.
   */
  async scanTenant(tenantId: string): Promise<ScanResult> {
    const result: ScanResult = { sent: 0, skipped: 0, failed: 0, retrying: 0 };

    const { due, ctx } = await this.db.withTenant(tenantId, async (client) => {
      const ctx = await this.clinicContext(client, tenantId);
      const { rows } = await client.query<Recipient & { id: string }>(
        `SELECT a.id, ${RECIPIENT_COLUMNS}
           FROM appointments a
           ${RECIPIENT_JOINS}
           JOIN clinic_settings cs ON cs.tenant_id = a.tenant_id
          WHERE a.status = 'scheduled'
            AND a.starts_at > now()
            AND a.starts_at <= now() + make_interval(hours => cs.reminder_hours_before)
            AND NOT EXISTS (
              SELECT 1 FROM reminders r
               WHERE r.appointment_id = a.id AND r.type = 'automatic'
            )
          ORDER BY a.starts_at
          LIMIT ${SCAN_LIMIT}`,
      );
      return { due: rows, ctx };
    });

    for (const a of due) {
      const to = toE164(a.phone, ctx.countryCode);
      // The patient's own choice, then the clinic's, then whatever this
      // deployment can actually send.
      const channel = this.registry.resolve('appointment_reminder', a.preferred_channel, ctx.channel);
      // Skipped rows are claimed too. "Why did nobody remind her?" deserves an
      // answer in the log, and the claim stops the next scan asking again.
      const skip = a.reminders_opt_out
        ? 'The patient has opted out of reminders'
        : channel.kind !== 'internal' && !to
          ? 'No usable mobile number on file'
          : null;
      try {
        await this.claim(tenantId, {
          appointmentId: a.id,
          patientId: a.patient_id,
          purpose: 'appointment_reminder',
          type: 'automatic',
          channel: channel.id,
          status: skip ? 'skipped' : 'pending',
          error: skip,
          message: compose(ctx, a, channel),
          templateValues: templateValuesFor(ctx, a, channel),
          to,
          createdBy: null,
        });
        if (skip) result.skipped += 1;
      } catch (err: unknown) {
        // Another scanner claimed this appointment first. Each claim runs in
        // its own transaction, so the loop carries on.
        if ((err as { code?: string }).code === '23505') continue;
        throw err;
      }
    }

    const waiting = await this.db.withTenant(tenantId, async (client) => {
      // A reminder for an appointment that was cancelled, moved into the past
      // or checked in is no longer worth sending.
      const retired = await client.query(
        `UPDATE reminders r
            SET status = 'skipped', error = 'The appointment is no longer upcoming',
                next_attempt_at = NULL, updated_at = now()
           FROM appointments a
          WHERE a.id = r.appointment_id
            AND r.purpose = 'appointment_reminder'
            AND r.status = 'pending'
            AND (a.status <> 'scheduled' OR a.starts_at <= now())`,
      );
      result.skipped += retired.rowCount ?? 0;

      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM reminders
          WHERE status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY created_at
          LIMIT ${SCAN_LIMIT}`,
      );
      return rows;
    });

    for (const { id } of waiting) {
      const outcome = await this.attempt(tenantId, id);
      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'retrying') result.retrying += 1;
      else if (outcome === 'failed') result.failed += 1;
    }
    return result;
  }

  /**
   * A delivery receipt from the provider.
   *
   * The receipt names the clinic, the reminder and the provider's message id,
   * and all three must agree: the lookup runs under the named clinic's RLS
   * context and requires the message id to match, so a receipt pointed at
   * another clinic finds nothing. Returns whether a reminder matched.
   */
  async recordReceipt(input: {
    tenantId: string;
    reminderId: string;
    providerMessageId: string;
    providerStatus: string;
    errorCode: string | null;
  }): Promise<boolean> {
    const next = providerStatusToReminder(input.providerStatus);
    return this.db.withTenant(input.tenantId, async (client) => {
      const { rows } = await client.query<{ status: ReminderStatus; patient_id: string }>(
        `SELECT r.status, r.patient_id
           FROM reminders r
          WHERE r.id = $1 AND r.provider_message_id = $2
          FOR UPDATE`,
        [input.reminderId, input.providerMessageId],
      );
      const row = rows[0];
      if (!row) return false;

      if (next && applyReceipt(row.status, next)) {
        await client.query(
          `UPDATE reminders
              SET status = $2::text,
                  provider_status = $3,
                  error_code = coalesce($4, error_code),
                  error = CASE WHEN $2::text = 'failed'
                               THEN 'The carrier could not deliver the message'
                               ELSE error END,
                  delivered_at = CASE WHEN $2::text = 'delivered' THEN now() ELSE delivered_at END,
                  updated_at = now()
            WHERE id = $1`,
          [input.reminderId, next, input.providerStatus, input.errorCode],
        );
      }
      // 21610 on a receipt: the patient replied STOP to this number.
      if (input.errorCode === '21610') await optOut(client, row.patient_id, 'patient');
      return true;
    });
  }

  /* ── helpers ───────────────────────────────────────────── */

  async clinicContext(client: PoolClient, tenantId: string): Promise<ClinicContext> {
    const { rows } = await client.query<{
      name: string;
      phone: string | null;
      address: string | null;
      city: string | null;
      timezone: string | null;
      reminder_locale: string | null;
      reminder_template: string | null;
      phone_country_code: string | null;
      reminder_channel: string | null;
    }>(
      `SELECT t.name, cs.phone, cs.address, cs.city, cs.timezone, cs.reminder_locale,
              cs.reminder_template, cs.phone_country_code, cs.reminder_channel
         FROM tenants t
         LEFT JOIN clinic_settings cs ON cs.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId],
    );
    const r = rows[0];
    const locale = r?.reminder_locale;
    return {
      name: r?.name ?? 'the clinic',
      phone: r?.phone?.trim() || null,
      // Settings refuses an unknown zone; this guards a row written some other
      // way, which would otherwise throw inside Intl and stop every reminder.
      timezone: r?.timezone && isTimeZone(r.timezone) ? r.timezone : 'Europe/Tirane',
      locale: isReminderLocale(locale) ? locale : 'en',
      template: r?.reminder_template ?? null,
      countryCode: r?.phone_country_code ?? '355',
      address: [r?.address?.trim(), r?.city?.trim()].filter(Boolean).join(', ') || null,
      channel: r?.reminder_channel ?? 'sms',
    };
  }

  /**
   * Insert a message row in its own short transaction. Throws 23505 on a lost
   * race. Public for MessagesService, which sends the other kinds of message
   * through this same pipeline.
   */
  async claim(
    tenantId: string,
    o: {
      appointmentId: string | null;
      patientId: string;
      purpose: MessagePurpose;
      invoiceId?: string | null;
      type: 'automatic' | 'manual';
      channel: string;
      status: 'pending' | 'skipped' | 'sent';
      message: string;
      to: string | null;
      createdBy: string | null;
      error?: string | null;
      templateValues?: TemplateValues | null;
    },
  ): Promise<string> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO reminders
           (tenant_id, appointment_id, type, channel, status, message, to_address, error,
            created_by, sent_at, template_values, patient_id, purpose, invoice_id)
         VALUES ($1,$2,$3,$4,$5::text,$6,$7,$8,$9, CASE WHEN $5::text = 'sent' THEN now() END, $10::jsonb,
                 $11,$12,$13)
         RETURNING id`,
        [
          tenantId,
          o.appointmentId,
          o.type,
          o.channel,
          o.status,
          o.message,
          o.to,
          o.error ?? null,
          o.createdBy,
          o.templateValues ? JSON.stringify(o.templateValues) : null,
          o.patientId,
          o.purpose,
          o.invoiceId ?? null,
        ],
      );
      return rows[0]!.id;
    });
  }

  /** Lease, send, settle. See the class comment for why each is separate. */
  async attempt(tenantId: string, id: string): Promise<AttemptOutcome> {
    const leased = await this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{
        channel: string;
        to_address: string | null;
        message: string;
        attempts: number;
        patient_id: string;
        template_values: TemplateValues | null;
      }>(
        `UPDATE reminders r
            SET status = 'sending', attempts = r.attempts + 1, updated_at = now()
          WHERE r.id = $1 AND r.status = 'pending'
          RETURNING r.channel, r.to_address, r.message, r.attempts, r.patient_id,
                    r.template_values`,
        [id],
      );
      return rows[0] ?? null;
    });
    if (!leased) return 'skipped';

    const channel = this.registry.byId(leased.channel);
    if (!channel) {
      await this.settle(tenantId, id, {
        status: 'failed',
        error: 'The channel that queued this reminder is no longer configured',
      });
      return 'failed';
    }

    try {
      const out = await channel.send({
        to: leased.to_address,
        message: leased.message,
        templateValues: leased.template_values,
        statusCallbackUrl: channel.statusCallbackUrl?.(tenantId, id) ?? null,
      });
      await this.settle(tenantId, id, {
        status: 'sent',
        providerMessageId: out.providerMessageId,
        providerStatus: out.providerStatus,
      });
      return 'sent';
    } catch (err: unknown) {
      const failure =
        err instanceof DeliveryError
          ? err
          : new DeliveryError('Delivery failed for an unexpected reason', { ambiguous: true });
      // The reminder id and our own reason — never the number or the message.
      this.logger.warn(`reminder ${id}, attempt ${leased.attempts}: ${failure.message}`);

      const delay = failure.retryable ? retryDelayMinutes(leased.attempts) : null;
      if (delay !== null) {
        await this.settle(tenantId, id, {
          status: 'pending',
          retryInMinutes: delay,
          error: failure.message,
          errorCode: failure.code,
        });
        return 'retrying';
      }

      await this.settle(tenantId, id, {
        status: 'failed',
        error: failure.message,
        errorCode: failure.code,
      });
      if (failure.optOut) {
        await this.db
          .withTenant(tenantId, (client) => optOut(client, leased.patient_id, 'provider'))
          .catch((e: unknown) =>
            this.logger.error(
              `reminder ${id}: could not record the opt-out: ${e instanceof Error ? e.message : e}`,
            ),
          );
      }
      return 'failed';
    }
  }

  private async settle(
    tenantId: string,
    id: string,
    o: {
      status: 'sent' | 'pending' | 'failed';
      providerMessageId?: string | null;
      providerStatus?: string | null;
      retryInMinutes?: number;
      error?: string | null;
      errorCode?: string | null;
    },
  ): Promise<void> {
    try {
      await this.db.withTenant(tenantId, async (client) => {
        await client.query(
          `UPDATE reminders
              SET status = $2::text,
                  sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE sent_at END,
                  provider_message_id = coalesce($3, provider_message_id),
                  provider_status = coalesce($4, provider_status),
                  next_attempt_at = CASE WHEN $5::int IS NULL THEN NULL
                                         ELSE now() + make_interval(mins => $5::int) END,
                  error = $6,
                  error_code = $7,
                  updated_at = now()
            WHERE id = $1`,
          [
            id,
            o.status,
            o.providerMessageId ?? null,
            o.providerStatus ?? null,
            o.retryInMinutes ?? null,
            o.error ?? null,
            o.errorCode ?? null,
          ],
        );
      });
    } catch (err: unknown) {
      // The message may already have gone. Leaving the row 'sending' is the
      // honest record, and it is never retried automatically.
      this.logger.error(
        `reminder ${id}: could not record the outcome: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
