import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import {
  MONEY_LOCALE,
  defaultMessageTemplate,
  formatAppointmentTime,
  formatMoney,
  isCurrency,
  renderMessage,
  toE164,
  type CurrencyCode,
  type MessagePurpose,
} from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import type { ClinicAuditActor } from '@/core/audit/clinic-audit.service';
import type { ReminderChannel, TemplateValues } from './channels/channels';
import { ChannelRegistry } from './channels/registry';
import { TwilioWhatsAppChannel } from './channels/whatsapp';
import {
  REMINDER_SELECT,
  RemindersService,
  mapReminder,
  type ClinicContext,
} from './reminders.service';
import type { ConversationFilter, SendMessageDto } from './dto/messages.dto';

/** Which stored channel ids each filter on the conversation list means. */
const FILTER_CHANNELS: Readonly<
  Record<Exclude<ConversationFilter, 'all'>, readonly string[]>
> = {
  whatsapp: ['whatsapp_business', 'whatsapp'],
  viber: ['viber'],
  sms: ['sms'],
  other: ['log', 'email'],
};

const PROVIDER_CHANNELS = new Set(['sms', 'whatsapp_business', 'viber']);

const LOCALE_TAG = { en: MONEY_LOCALE, sq: 'sq-AL' } as const;

/**
 * The Messages screen: every message a clinic has sent a patient, grouped into
 * one conversation per patient, and the three kinds of message staff can send
 * from it.
 *
 * Sending goes through RemindersService's own claim → attempt pipeline, so a
 * follow-up or a balance notice is retried, receipted and recorded exactly as
 * an appointment reminder is. What this adds is choosing and filling the
 * message: which visit a reminder is for, which visit a follow-up asks about,
 * how much a balance notice says is owed.
 *
 * Every message is written from the clinic's built-in wording and the values
 * below — never free text typed at the desk. That keeps treatment details off
 * patients' lock screens, and it is the only thing WhatsApp would carry anyway.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly reminders: RemindersService,
    private readonly registry: ChannelRegistry,
    private readonly whatsapp: TwilioWhatsAppChannel,
  ) {}

  /* ── the conversation list ─────────────────────────────────────────── */

  conversations(opts: {
    channel?: ConversationFilter;
    purpose?: MessagePurpose;
    q?: string;
  }) {
    const channels =
      opts.channel && opts.channel !== 'all' ? FILTER_CHANNELS[opts.channel] : null;
    const q = opts.q?.trim() ? `%${opts.q.trim().replace(/[%_\\]/g, '\\$&')}%` : null;
    return this.db.withTenant(this.tenant.getRequiredTenantId(), async (client) => {
      const { rows } = await client.query<{
        patient_id: string;
        first_name: string;
        last_name: string;
        phone: string | null;
        preferred_channel: string | null;
        reminders_opt_out: boolean;
        id: string;
        channel: string;
        status: string;
        message: string;
        purpose: MessagePurpose;
        created_at: string;
        total: string;
        failed: string;
      }>(
        `WITH filtered AS (
           SELECT r.id, r.patient_id, r.channel, r.status, r.message, r.purpose, r.created_at
             FROM reminders r
            WHERE ($1::text[] IS NULL OR r.channel = ANY($1::text[]))
              AND ($2::text IS NULL OR r.purpose = $2::text)
         ), latest AS (
           SELECT DISTINCT ON (patient_id) *
             FROM filtered
            ORDER BY patient_id, created_at DESC
         ), counts AS (
           SELECT patient_id, count(*)::text AS total,
                  count(*) FILTER (WHERE status = 'failed')::text AS failed
             FROM filtered
            GROUP BY patient_id
         )
         SELECT l.*, c.total, c.failed, p.first_name, p.last_name, p.phone,
                p.preferred_channel, p.reminders_opt_out
           FROM latest l
           JOIN counts c ON c.patient_id = l.patient_id
           JOIN patients p ON p.id = l.patient_id
          WHERE $3::text IS NULL
             OR (p.first_name || ' ' || p.last_name) ILIKE $3
             OR p.phone ILIKE $3
          ORDER BY l.created_at DESC
          LIMIT 200`,
        [channels ? [...channels] : null, opts.purpose ?? null, q],
      );
      return rows.map((r) => ({
        patientId: r.patient_id,
        patientName: `${r.first_name} ${r.last_name}`,
        phone: r.phone,
        preferredChannel: r.preferred_channel,
        optedOut: r.reminders_opt_out,
        messageCount: Number(r.total),
        failedCount: Number(r.failed),
        last: {
          id: r.id,
          channel: r.channel,
          status: r.status,
          purpose: r.purpose,
          message: r.message,
          createdAt: r.created_at,
        },
      }));
    });
  }

  /* ── one patient's conversation ────────────────────────────────────── */

  async thread(patientId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    const data = await this.db.withTenant(tenantId, async (client) => {
      const patient = await this.patientRow(client, patientId);
      const ctx = await this.reminders.clinicContext(client, tenantId);
      const currency = await this.currency(client);

      const { rows: messages } = await client.query(
        `${REMINDER_SELECT} WHERE r.patient_id = $1 ORDER BY r.created_at ASC LIMIT 500`,
        [patientId],
      );
      const { rows: upcoming } = await client.query<{
        id: string;
        starts_at: Date;
        reason: string | null;
        dentist: string | null;
      }>(
        `SELECT a.id, a.starts_at, a.reason, u.full_name AS dentist
           FROM appointments a LEFT JOIN users u ON u.id = a.staff_id
          WHERE a.patient_id = $1 AND a.status = 'scheduled' AND a.starts_at > now()
          ORDER BY a.starts_at LIMIT 5`,
        [patientId],
      );
      const { rows: visits } = await client.query<{
        id: string;
        starts_at: Date;
        reason: string | null;
        dentist: string | null;
      }>(
        `SELECT a.id, a.starts_at, a.reason, u.full_name AS dentist
           FROM appointments a LEFT JOIN users u ON u.id = a.staff_id
          WHERE a.patient_id = $1 AND a.status = 'completed'
          ORDER BY a.starts_at DESC LIMIT 5`,
        [patientId],
      );
      const { rows: invoices } = await client.query<{
        id: string;
        invoice_number: string;
        issued_at: string;
        balance: string;
      }>(
        `SELECT i.id, i.invoice_number, i.issued_at::text AS issued_at,
                (i.total - coalesce((SELECT sum(amount) FROM payments pay
                                      WHERE pay.invoice_id = i.id AND pay.voided_at IS NULL), 0))::text AS balance
           FROM invoices i
          WHERE i.patient_id = $1 AND i.status IN ('unpaid','partially_paid')
          ORDER BY i.issued_at DESC LIMIT 10`,
        [patientId],
      );
      const balance = await this.balanceOf(client, patientId);
      const latest = await this.latestVisit(client, patientId);
      return {
        patient,
        ctx,
        currency,
        messages,
        upcoming,
        visits,
        invoices,
        balance,
        latest,
      };
    });

    const { patient, ctx, currency } = data;
    const when = (d: Date) =>
      formatAppointmentTime(new Date(d), ctx.timezone, ctx.locale);
    const money = (minor: number) => formatMoney(minor, currency, LOCALE_TAG[ctx.locale]);
    const available = this.registry.available();

    return {
      patient: {
        id: patient.id,
        firstName: patient.first_name,
        lastName: patient.last_name,
        phone: patient.phone,
        /** The number messages go to, or null when the one on file cannot be used. */
        e164: toE164(patient.phone, ctx.countryCode),
        preferredChannel: patient.preferred_channel,
        optedOut: patient.reminders_opt_out,
        optOutSource: patient.reminders_opt_out_source,
      },
      clinic: {
        name: ctx.name,
        phone: ctx.phone,
        address: ctx.address,
        locale: ctx.locale,
        /** The clinic's own reminder wording; not used for WhatsApp. */
        reminderTemplate: ctx.template,
        defaultChannel: ctx.channel,
      },
      channels: {
        sms: available.sms,
        whatsappBusiness: available.whatsapp_business,
        viber: available.viber,
        /** Kinds of message with an approved WhatsApp template. */
        whatsappPurposes: this.whatsapp.supportedPurposes(),
      },
      messages: data.messages.map(mapReminder),
      /** Values the composer previews with, formatted as the message will be. */
      context: {
        upcoming: data.upcoming.map((a) => ({
          id: a.id,
          startsAt: a.starts_at,
          reason: a.reason,
          dentist: a.dentist,
          ...when(a.starts_at),
        })),
        visits: data.visits.map((a) => ({
          id: a.id,
          startsAt: a.starts_at,
          reason: a.reason,
          dentist: a.dentist,
          visitDate: when(a.starts_at).date,
        })),
        invoices: data.invoices
          .map((i) => ({
            id: i.id,
            invoiceNumber: i.invoice_number,
            issuedAt: i.issued_at,
            balance: Number(i.balance),
          }))
          .filter((i) => i.balance > 0)
          .map((i) => ({ ...i, balanceText: money(i.balance) })),
        /** The visit a follow-up names when no appointment is chosen: the latest visit or logged treatment. */
        latestVisit: data.latest
          ? { visitDate: when(data.latest.at).date, dentist: data.latest.dentist }
          : null,
        balance: data.balance,
        balanceText: money(Math.max(0, data.balance)),
        currency,
      },
    };
  }

  /* ── sending ───────────────────────────────────────────────────────── */

  async send(patientId: string, dto: SendMessageDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();

    const prepared = await this.db.withTenant(tenantId, async (client) => {
      const patient = await this.patientRow(client, patientId);
      const ctx = await this.reminders.clinicContext(client, tenantId);
      const filled = await this.fill(client, patientId, dto, ctx);
      return { patient, ctx, ...filled };
    });
    const { patient, ctx, values, appointmentId, invoiceId } = prepared;

    // Consent first: a patient who opted out is not messaged by any route that
    // reaches their phone, the staff member's own WhatsApp included.
    if (patient.reminders_opt_out && dto.channel !== 'log') {
      throw new ConflictException('This patient has asked not to receive messages.');
    }

    const to = toE164(patient.phone, ctx.countryCode);
    let channel: ReminderChannel | null = null;
    if (PROVIDER_CHANNELS.has(dto.channel)) {
      channel = this.registry.byId(dto.channel);
      if (!channel) {
        throw new BadRequestException(
          `${channelName(dto.channel)} is not set up on this deployment.`,
        );
      }
      if (!this.registry.carries(channel, dto.purpose)) {
        throw new BadRequestException(
          'WhatsApp has no approved template for this kind of message yet. Send it by SMS or Viber instead.',
        );
      }
    }
    if (dto.channel !== 'log' && !to) {
      throw new BadRequestException('The patient has no usable mobile number on file.');
    }

    const templateChannel = channel?.kind === 'whatsapp';
    const message = composeMessage(dto.purpose, ctx, values, { templateChannel });
    const templateValues: TemplateValues | null = templateChannel
      ? {
          locale: ctx.locale,
          purpose: dto.purpose,
          ...(values as Omit<TemplateValues, 'locale' | 'purpose'>),
        }
      : null;

    const handoff = dto.channel === 'whatsapp';
    const id = await this.reminders.claim(tenantId, {
      appointmentId,
      patientId,
      purpose: dto.purpose,
      invoiceId,
      type: 'manual',
      channel: dto.channel,
      status: handoff ? 'sent' : 'pending',
      message,
      to,
      createdBy: actor.userId,
      templateValues,
    });
    if (!handoff) await this.reminders.attempt(tenantId, id);

    const row = await this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`${REMINDER_SELECT} WHERE r.id = $1`, [id]);
      return mapReminder(rows[0]);
    });
    return {
      message: row,
      /** For a hand-off: the link that opens WhatsApp with this text, for this patient. */
      handoffUrl:
        handoff && to
          ? `https://wa.me/${to.slice(1)}?text=${encodeURIComponent(message)}`
          : null,
    };
  }

  /* ── helpers ───────────────────────────────────────────────────────── */

  /** The values a message is written from, and what it is about. */
  private async fill(
    client: PoolClient,
    patientId: string,
    dto: SendMessageDto,
    ctx: ClinicContext,
  ) {
    const { rows: p } = await client.query<{ first_name: string }>(
      'SELECT first_name FROM patients WHERE id = $1',
      [patientId],
    );
    const base = {
      first_name: p[0]!.first_name,
      clinic: ctx.name,
      clinic_phone: ctx.phone ?? '',
    };

    if (dto.purpose === 'appointment_reminder') {
      if (!dto.appointmentId)
        throw new BadRequestException(
          'Choose the appointment to remind the patient about.',
        );
      const a = await this.appointmentOf(client, patientId, dto.appointmentId);
      if (a.status !== 'scheduled' || new Date(a.starts_at).getTime() <= Date.now()) {
        throw new BadRequestException(
          'Reminders are for upcoming, scheduled appointments.',
        );
      }
      const { date, time } = formatAppointmentTime(
        new Date(a.starts_at),
        ctx.timezone,
        ctx.locale,
      );
      return {
        values: {
          ...base,
          date,
          time,
          dentist: a.dentist ?? '',
          clinic_address: ctx.address ?? '',
        },
        appointmentId: a.id,
        invoiceId: null,
      };
    }

    if (dto.purpose === 'post_procedure_followup') {
      let visit: { id: string | null; at: Date; dentist: string | null } | null = null;
      if (dto.appointmentId) {
        const a = await this.appointmentOf(client, patientId, dto.appointmentId);
        if (a.status !== 'completed')
          throw new BadRequestException('A follow-up is about a completed visit.');
        visit = { id: a.id, at: new Date(a.starts_at), dentist: a.dentist };
      } else {
        const latest = await this.latestVisit(client, patientId);
        if (latest) visit = { id: null, ...latest };
      }
      if (!visit)
        throw new BadRequestException(
          'This patient has no completed visit to follow up on.',
        );
      return {
        values: {
          ...base,
          visit_date: formatAppointmentTime(visit.at, ctx.timezone, ctx.locale).date,
          dentist: visit.dentist ?? '',
        },
        appointmentId: visit.id,
        invoiceId: null,
      };
    }

    // unpaid_balance
    const currency = await this.currency(client);
    let owed: number;
    let invoiceId: string | null = null;
    if (dto.invoiceId) {
      const { rows } = await client.query<{ status: string; balance: string }>(
        `SELECT i.status,
                (i.total - coalesce((SELECT sum(amount) FROM payments pay
                                      WHERE pay.invoice_id = i.id AND pay.voided_at IS NULL), 0))::text AS balance
           FROM invoices i WHERE i.id = $1 AND i.patient_id = $2`,
        [dto.invoiceId, patientId],
      );
      if (!rows[0]) throw new NotFoundException('Invoice not found for this patient');
      if (rows[0].status === 'cancelled')
        throw new BadRequestException('That invoice is cancelled.');
      owed = Number(rows[0].balance);
      invoiceId = dto.invoiceId;
    } else {
      owed = await this.balanceOf(client, patientId);
    }
    if (owed <= 0)
      throw new BadRequestException(
        'Nothing is owed, so there is no balance to remind the patient of.',
      );
    return {
      values: { ...base, balance: formatMoney(owed, currency, LOCALE_TAG[ctx.locale]) },
      appointmentId: null,
      invoiceId,
    };
  }

  /** The most recent completed appointment or logged treatment, whichever is later. */
  private async latestVisit(client: PoolClient, patientId: string) {
    const { rows } = await client.query<{ at: Date; dentist: string | null }>(
      `SELECT at, dentist FROM (
         SELECT a.starts_at AS at, u.full_name AS dentist
           FROM appointments a LEFT JOIN users u ON u.id = a.staff_id
          WHERE a.patient_id = $1 AND a.status = 'completed'
         UNION ALL
         SELECT cp.performed_on::timestamptz AS at, u.full_name AS dentist
           FROM clinical_procedures cp LEFT JOIN users u ON u.id = cp.clinician_id
          WHERE cp.patient_id = $1 AND cp.status = 'completed' AND cp.entered_in_error_at IS NULL
       ) visits ORDER BY at DESC LIMIT 1`,
      [patientId],
    );
    return rows[0] ? { at: new Date(rows[0].at), dentist: rows[0].dentist } : null;
  }

  private async patientRow(client: PoolClient, patientId: string) {
    const { rows } = await client.query<{
      id: string;
      first_name: string;
      last_name: string;
      phone: string | null;
      preferred_channel: string | null;
      reminders_opt_out: boolean;
      reminders_opt_out_source: string | null;
    }>(
      `SELECT id, first_name, last_name, phone, preferred_channel, reminders_opt_out, reminders_opt_out_source
         FROM patients WHERE id = $1`,
      [patientId],
    );
    if (!rows[0]) throw new NotFoundException('Patient not found');
    return rows[0];
  }

  private async appointmentOf(
    client: PoolClient,
    patientId: string,
    appointmentId: string,
  ) {
    const { rows } = await client.query<{
      id: string;
      status: string;
      starts_at: Date;
      dentist: string | null;
    }>(
      `SELECT a.id, a.status, a.starts_at, u.full_name AS dentist
         FROM appointments a LEFT JOIN users u ON u.id = a.staff_id
        WHERE a.id = $1 AND a.patient_id = $2`,
      [appointmentId, patientId],
    );
    if (!rows[0]) throw new NotFoundException('Appointment not found for this patient');
    return rows[0];
  }

  private async balanceOf(client: PoolClient, patientId: string): Promise<number> {
    const { rows } = await client.query<{ balance: string }>(
      'SELECT coalesce(sum(amount), 0)::text AS balance FROM ledger_entries WHERE patient_id = $1',
      [patientId],
    );
    return Number(rows[0]?.balance ?? 0);
  }

  private async currency(client: PoolClient): Promise<CurrencyCode> {
    const { rows } = await client.query<{ currency: string }>(
      'SELECT currency FROM clinic_settings LIMIT 1',
    );
    return isCurrency(rows[0]?.currency) ? (rows[0]!.currency as CurrencyCode) : 'EUR';
  }
}

/**
 * The text of a message. A template channel (WhatsApp) shows its approved
 * wording, which is the built-in one; the clinic's own reminder wording is
 * used everywhere else it exists.
 */
export function composeMessage(
  purpose: MessagePurpose,
  ctx: Pick<ClinicContext, 'locale' | 'phone' | 'template'>,
  values: Record<string, string>,
  opts: { templateChannel: boolean },
): string {
  const template =
    purpose === 'appointment_reminder' && ctx.template && !opts.templateChannel
      ? ctx.template
      : defaultMessageTemplate(purpose, ctx.locale, Boolean(ctx.phone));
  return renderMessage(template, purpose, values);
}

function channelName(id: string): string {
  return id === 'whatsapp_business' ? 'WhatsApp' : id === 'viber' ? 'Viber' : 'SMS';
}
