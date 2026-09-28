import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import {
  WHATSAPP_EXCLUSION_LABELS,
  isLiveSend,
  whatsAppExclusion,
  whatsAppRecipient,
  whatsAppReminderValues,
  type WhatsAppExclusion,
  type WhatsAppSendStatus,
  type WhatsAppValues,
} from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { GraphError, WhatsAppGraphClient } from './graph-client';
import {
  WhatsAppService,
  mapTemplate,
  templateReady,
  type OpenConnection,
  type TemplateRow,
} from './whatsapp.service';
import { HistoryQueryDto, SendRemindersDto } from './dto/whatsapp.dto';

interface ClinicFacts {
  name: string;
  phone: string | null;
  timezone: string;
  countryCode: string;
}

interface AppointmentRow {
  appointment_id: string;
  patient_id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  whatsapp_phone_e164: string | null;
  whatsapp_opt_in: boolean;
  reminders_opt_out: boolean;
  starts_at: Date;
  status: string;
  last_status: WhatsAppSendStatus | null;
  last_at: string | null;
  last_reason: string | null;
  live: boolean;
}

/** How many sends run at once. Meta's limits are far above this; the clinic's patience is not. */
const PARALLEL = 5;

/**
 * Tomorrow's reminders: who can be reminded and why not, the send, and what
 * happened.
 *
 * Nothing a patient receives comes from the browser. The browser names
 * appointments; the API decides again who may be reminded, fills the approved
 * template from the record, and calls Meta.
 */
@Injectable()
export class WhatsAppRemindersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly graph: WhatsAppGraphClient,
    private readonly whatsapp: WhatsAppService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  private async clinic(client: PoolClient): Promise<ClinicFacts> {
    const { rows } = await client.query<{
      name: string;
      phone: string | null;
      timezone: string | null;
      phone_country_code: string | null;
    }>(
      `SELECT t.name, s.phone, s.timezone, s.phone_country_code
         FROM tenants t LEFT JOIN clinic_settings s ON s.tenant_id = t.id
        WHERE t.id = $1`,
      [this.tenant.getRequiredTenantId()],
    );
    const r = rows[0];
    return {
      name: r?.name ?? '',
      phone: r?.phone ?? null,
      timezone: r?.timezone ?? 'Europe/Tirane',
      countryCode: r?.phone_country_code ?? '355',
    };
  }

  /** Tomorrow's date in the clinic's zone. */
  private async tomorrow(client: PoolClient, timezone: string): Promise<string> {
    const { rows } = await client.query<{ d: string }>(
      `SELECT ((now() AT TIME ZONE $1)::date + 1)::text AS d`,
      [timezone],
    );
    return rows[0]!.d;
  }

  /** A day's appointments with each patient's consent and the latest reminder for it. */
  private async appointments(
    client: PoolClient,
    date: string,
    timezone: string,
    ids?: string[],
  ) {
    const { rows } = await client.query<AppointmentRow>(
      `SELECT a.id AS appointment_id, a.patient_id, p.first_name, p.last_name, p.phone,
              p.whatsapp_phone_e164, p.whatsapp_opt_in, p.reminders_opt_out,
              a.starts_at, a.status,
              ls.status AS last_status, ls.created_at AS last_at, ls.failure_reason AS last_reason,
              EXISTS (SELECT 1 FROM whatsapp_message_sends s
                       WHERE s.appointment_id = a.id AND s.patient_id = a.patient_id
                         AND s.reminder_type = 'appointment_reminder'
                         AND s.status IN ('queued','sending','accepted','sent')) AS live
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         LEFT JOIN LATERAL (
           SELECT s.status, s.created_at, s.failure_reason FROM whatsapp_message_sends s
            WHERE s.appointment_id = a.id AND s.status <> 'already_sent'
            ORDER BY s.created_at DESC LIMIT 1
         ) ls ON true
        WHERE (a.starts_at AT TIME ZONE $2)::date = $1::date
          ${ids ? 'AND a.id = ANY($3::uuid[])' : ''}
        ORDER BY a.starts_at, p.last_name, p.first_name`,
      ids ? [date, timezone, ids] : [date, timezone],
    );
    return rows;
  }

  private async defaultTemplate(client: PoolClient): Promise<TemplateRow | null> {
    const { rows } = await client.query<TemplateRow>(
      `SELECT id, display_name, meta_template_name, language_code, preview_body, is_active, is_default,
              meta_status, meta_category, meta_parameters, meta_checked_at, meta_check_error, updated_at
         FROM whatsapp_message_templates WHERE is_default AND is_active LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  private judge(
    r: AppointmentRow,
    clinic: ClinicFacts,
    connected: boolean,
    templateOk: boolean,
  ): { exclusion: WhatsAppExclusion | null; phone: string | null } {
    const recipient = whatsAppRecipient(
      { whatsappPhone: r.whatsapp_phone_e164, phone: r.phone },
      clinic.countryCode,
    );
    return {
      phone: recipient.phone,
      exclusion: whatsAppExclusion({
        appointmentStatus: r.status,
        optedOut: r.reminders_opt_out,
        optIn: r.whatsapp_opt_in,
        phoneProblem: recipient.problem,
        alreadySent: r.live,
        connected,
        templateReady: templateOk,
      }),
    };
  }

  private values(
    r: AppointmentRow,
    clinic: ClinicFacts,
    languageCode: string,
  ): WhatsAppValues {
    return whatsAppReminderValues({
      patientFirstName: r.first_name,
      clinicName: clinic.name,
      clinicPhone: clinic.phone,
      startsAt: new Date(r.starts_at),
      timeZone: clinic.timezone,
      languageCode,
    });
  }

  /* ── the day ────────────────────────────────────────────────────────── */

  async day(date?: string) {
    const conn = await this.whatsapp.getConnection();
    return this.tx(async (client) => {
      const clinic = await this.clinic(client);
      const day = date ?? (await this.tomorrow(client, clinic.timezone));
      const template = await this.defaultTemplate(client);
      const templateOk = template !== null && templateReady(template);
      const rows = await this.appointments(client, day, clinic.timezone);
      const language = template?.language_code ?? 'sq';

      const out = rows.map((r) => {
        const { exclusion, phone } = this.judge(r, clinic, conn.connected, templateOk);
        return {
          appointmentId: r.appointment_id,
          patientId: r.patient_id,
          patientName: `${r.first_name} ${r.last_name}`,
          whatsappPhone: phone ?? (r.whatsapp_phone_e164 || r.phone || null),
          startsAt: new Date(r.starts_at).toISOString(),
          appointmentStatus: r.status,
          reminder: r.last_status
            ? { status: r.last_status, at: r.last_at, failureReason: r.last_reason }
            : null,
          exclusion,
          exclusionLabel: exclusion ? WHATSAPP_EXCLUSION_LABELS[exclusion] : null,
          // The values the template is filled with — the same the send uses.
          values: this.values(r, clinic, language),
        };
      });

      const count = (fn: (x: (typeof out)[number]) => boolean) => out.filter(fn).length;
      return {
        date: day,
        timezone: clinic.timezone,
        clinic: { name: clinic.name, phone: clinic.phone },
        connection: {
          connected: conn.connected,
          displayPhoneNumber: conn.displayPhoneNumber,
        },
        template: template ? mapTemplate(template) : null,
        summary: {
          total: out.length,
          eligible: count((x) => x.exclusion === null),
          alreadyReminded: count((x) => x.exclusion === 'already_sent'),
          noConsent: count(
            (x) => x.exclusion === 'no_consent' || x.exclusion === 'opted_out',
          ),
          phoneProblem: count(
            (x) => x.exclusion === 'phone_missing' || x.exclusion === 'phone_invalid',
          ),
          cancelled: count((x) => x.exclusion === 'appointment_cancelled'),
        },
        rows: out,
      };
    });
  }

  /* ── sending ────────────────────────────────────────────────────────── */

  /**
   * Send the approved template to each chosen appointment's patient.
   *
   *   1  the connection works and the template, re-checked with Meta now, is
   *      approved — otherwise nothing is sent and no batch is recorded
   *   2  every appointment is judged again, here, as it stands now
   *   3  each one to send claims its slot in one transaction: the unique index
   *      lets one live send per appointment exist, so a second tab or click
   *      records `already_sent` instead of a second message
   *   4  then Meta is called, a few at a time, and each outcome is written
   *
   * Every chosen appointment ends with a row saying what happened to it.
   */
  async send(dto: SendRemindersDto, actor: ClinicAuditActor) {
    const conn = await this.whatsapp.openConnection();
    if (!conn) {
      throw new ConflictException({
        code: 'whatsapp_not_connected',
        message: 'Connect WhatsApp before sending reminders.',
      });
    }
    const checked = await this.whatsapp.checkTemplate(dto.templateId);
    if (!checked.isActive || !checked.ready) {
      throw new ConflictException({
        code: 'whatsapp_template_not_ready',
        message:
          checked.meta.problem ?? 'This template is not active or not approved by Meta.',
      });
    }
    const tenantId = this.tenant.getRequiredTenantId();

    const claimed = await this.tx(async (client) => {
      const clinic = await this.clinic(client);
      const template = await this.whatsapp.templateRow(client, dto.templateId);
      const rows = await this.appointments(
        client,
        dto.date,
        clinic.timezone,
        dto.appointmentIds,
      );
      const found = new Map(rows.map((r) => [r.appointment_id, r]));

      const batch = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_send_batches
           (tenant_id, selected_date, template_id, template_name, selected_count, initiated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          tenantId,
          dto.date,
          template.id,
          template.display_name,
          dto.appointmentIds.length,
          actor.userId,
        ],
      );
      const batchId = batch.rows[0]!.id;

      const toSend: { sendId: string; phone: string; values: WhatsAppValues }[] = [];
      let skipped = 0;
      for (const id of dto.appointmentIds) {
        const r = found.get(id);
        // Not this clinic's, or not on this day: nothing to record it against.
        if (!r) {
          skipped++;
          continue;
        }
        const { exclusion, phone } = this.judge(r, clinic, true, true);
        const base = [
          tenantId,
          batchId,
          r.patient_id,
          r.appointment_id,
          template.id,
          template.display_name,
          phone,
          actor.userId,
        ];
        if (exclusion) {
          await client.query(
            `INSERT INTO whatsapp_message_sends
               (tenant_id, batch_id, patient_id, appointment_id, template_id, template_name, recipient_phone, sent_by,
                status, failure_reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              ...base,
              exclusion === 'already_sent' ? 'already_sent' : 'skipped',
              WHATSAPP_EXCLUSION_LABELS[exclusion],
            ],
          );
          skipped++;
          continue;
        }
        const ins = await client.query<{ id: string }>(
          `INSERT INTO whatsapp_message_sends
             (tenant_id, batch_id, patient_id, appointment_id, template_id, template_name, recipient_phone, sent_by, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued')
           ON CONFLICT (tenant_id, appointment_id, patient_id, reminder_type)
             WHERE status IN ('queued','sending','accepted','sent')
           DO NOTHING
           RETURNING id`,
          base,
        );
        if (!ins.rows[0]) {
          // Another tab or click claimed it a moment ago.
          await client.query(
            `INSERT INTO whatsapp_message_sends
               (tenant_id, batch_id, patient_id, appointment_id, template_id, template_name, recipient_phone, sent_by,
                status, failure_reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'already_sent',$9)`,
            [...base, WHATSAPP_EXCLUSION_LABELS.already_sent],
          );
          skipped++;
          continue;
        }
        toSend.push({
          sendId: ins.rows[0].id,
          phone: phone!,
          values: this.values(r, clinic, template.language_code),
        });
      }
      return { batchId, template, toSend, skipped };
    });

    const outcome = await this.deliver(conn, claimed.template, claimed.toSend);

    return this.tx(async (client) => {
      await client.query(
        `UPDATE whatsapp_send_batches
            SET sent_count = $2, failed_count = $3, skipped_count = $4, completed_at = now()
          WHERE id = $1`,
        [claimed.batchId, outcome.accepted, outcome.failed, claimed.skipped],
      );
      await this.audit.record(client, actor, {
        action: 'whatsapp.reminders_sent',
        entityType: 'whatsapp_batch',
        entityId: claimed.batchId,
        summary:
          `Sent ${outcome.accepted} WhatsApp reminder${outcome.accepted === 1 ? '' : 's'} for ${dto.date}` +
          `${outcome.failed ? `, ${outcome.failed} failed` : ''}${claimed.skipped ? `, ${claimed.skipped} skipped` : ''}`,
        metadata: {
          batchId: claimed.batchId,
          accepted: outcome.accepted,
          failed: outcome.failed,
          skipped: claimed.skipped,
        },
      });
      return this.batch(client, claimed.batchId);
    });
  }

  private async deliver(
    conn: OpenConnection,
    template: TemplateRow,
    queue: { sendId: string; phone: string; values: WhatsAppValues }[],
  ): Promise<{ accepted: number; failed: number }> {
    let accepted = 0;
    let failed = 0;
    let stopped: string | null = null;
    const names = template.meta_parameters ?? [];

    const one = async (item: (typeof queue)[number]) => {
      if (stopped) {
        await this.finish(item.sendId, 'failed', null, `Not sent: ${stopped}`);
        failed++;
        return;
      }
      await this.finish(item.sendId, 'sending', null, null);
      try {
        const res = await this.graph.sendTemplate(conn.token, conn.phoneNumberId, {
          to: item.phone,
          name: template.meta_template_name,
          language: template.language_code,
          parameters: names.map((n) => ({
            name: n,
            text: item.values[n as keyof WhatsAppValues] ?? '',
          })),
        });
        await this.finish(item.sendId, 'accepted', res.messageId, null);
        accepted++;
      } catch (err) {
        const message =
          err instanceof GraphError ? err.message : 'The message could not be sent.';
        if (err instanceof GraphError && err.kind === 'unreachable') {
          // No answer: the message may have gone out. It stays claimed, so
          // nobody sends it a second time by accident.
          await this.finish(
            item.sendId,
            'sending',
            null,
            'WhatsApp did not answer; the message may have been delivered.',
          );
        } else {
          await this.finish(item.sendId, 'failed', null, message);
        }
        failed++;
        // A refused token or a blocked account fails every send after it too.
        if (err instanceof GraphError && err.kind === 'auth' && !stopped) {
          stopped = message;
          await this.whatsapp.markConnectionFailed(message);
        }
      }
    };

    for (let i = 0; i < queue.length; i += PARALLEL) {
      await Promise.all(queue.slice(i, i + PARALLEL).map(one));
    }
    return { accepted, failed };
  }

  private finish(
    sendId: string,
    status: WhatsAppSendStatus,
    apiMessageId: string | null,
    reason: string | null,
  ) {
    return this.tx((client) =>
      client.query(
        `UPDATE whatsapp_message_sends
            SET status = $2, api_message_id = coalesce($3, api_message_id), failure_reason = $4,
                sent_at = CASE WHEN $2 = 'accepted' THEN now() ELSE sent_at END, updated_at = now()
          WHERE id = $1`,
        [sendId, status, apiMessageId, reason],
      ),
    );
  }

  /* ── history ────────────────────────────────────────────────────────── */

  private async batch(client: PoolClient, id: string) {
    const b = (await this.batches(client, id))[0];
    if (!b) throw new BadRequestException('Batch not found');
    const sends = await this.sends(client, { batchId: id });
    return { ...b, sends };
  }

  private async batches(client: PoolClient, id?: string) {
    const { rows } = await client.query<{
      id: string;
      selected_date: string;
      template_name: string;
      selected_count: number;
      sent_count: number;
      failed_count: number;
      skipped_count: number;
      started_at: string;
      completed_at: string | null;
      by_name: string | null;
    }>(
      `SELECT b.id, b.selected_date::text AS selected_date, b.template_name, b.selected_count, b.sent_count,
              b.failed_count, b.skipped_count, b.started_at, b.completed_at, u.full_name AS by_name
         FROM whatsapp_send_batches b LEFT JOIN users u ON u.id = b.initiated_by_user_id
        ${id ? 'WHERE b.id = $1' : ''}
        ORDER BY b.started_at DESC LIMIT 50`,
      id ? [id] : [],
    );
    return rows.map((b) => ({
      id: b.id,
      date: b.selected_date,
      templateName: b.template_name,
      selected: b.selected_count,
      sent: b.sent_count,
      failed: b.failed_count,
      skipped: b.skipped_count,
      startedAt: b.started_at,
      completedAt: b.completed_at,
      by: b.by_name,
    }));
  }

  private async sends(client: PoolClient, q: HistoryQueryDto) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('$$', `$${params.length}`));
    };
    if (q.batchId) add('s.batch_id = $$', q.batchId);
    // The clinic's days (0023), not the server's.
    if (q.from)
      add('s.created_at >= ($$::date::timestamp AT TIME ZONE clinic_zone())', q.from);
    if (q.to)
      add('s.created_at < (($$::date + 1)::timestamp AT TIME ZONE clinic_zone())', q.to);
    if (q.status) add('s.status = $$', q.status);
    const { rows } = await client.query<{
      id: string;
      batch_id: string;
      patient_id: string;
      first_name: string;
      last_name: string;
      recipient_phone: string | null;
      starts_at: string;
      template_name: string;
      sent_by_name: string | null;
      sent_at: string | null;
      created_at: string;
      status: WhatsAppSendStatus;
      failure_reason: string | null;
    }>(
      `SELECT s.id, s.batch_id, s.patient_id, p.first_name, p.last_name, s.recipient_phone, a.starts_at,
              s.template_name, u.full_name AS sent_by_name, s.sent_at, s.created_at, s.status, s.failure_reason
         FROM whatsapp_message_sends s
         JOIN patients p ON p.id = s.patient_id
         JOIN appointments a ON a.id = s.appointment_id
         LEFT JOIN users u ON u.id = s.sent_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.created_at DESC, p.last_name
        LIMIT 500`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batch_id,
      patientId: r.patient_id,
      patientName: `${r.first_name} ${r.last_name}`,
      phone: r.recipient_phone,
      appointmentAt: r.starts_at,
      templateName: r.template_name,
      sentBy: r.sent_by_name,
      sentAt: r.sent_at,
      createdAt: r.created_at,
      status: r.status,
      live: isLiveSend(r.status),
      failureReason: r.failure_reason,
    }));
  }

  history(q: HistoryQueryDto) {
    return this.tx(async (client) => ({
      batches: await this.batches(client),
      sends: await this.sends(client, q),
    }));
  }
}
