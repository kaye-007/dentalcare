import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { WHATSAPP_REMINDER_VARIABLES, templateVariables, unknownWhatsAppVariables } from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { GraphError, WhatsAppGraphClient, type GraphTemplate } from './graph-client';
import { WhatsAppTokenBox } from './token-box';
import { ConnectionDto, TemplateDto, TestConnectionDto, UpdateTemplateDto } from './dto/whatsapp.dto';

interface ConnectionRow {
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  encrypted_access_token: string;
  token_key_id: string;
  connection_status: 'connected' | 'failed';
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_result: string | null;
  last_success_at: string | null;
  connected_at: string;
}

export interface TemplateRow {
  id: string;
  display_name: string;
  meta_template_name: string;
  language_code: string;
  preview_body: string;
  is_active: boolean;
  is_default: boolean;
  meta_status: string | null;
  meta_category: string | null;
  meta_parameters: string[] | null;
  meta_checked_at: string | null;
  meta_check_error: string | null;
  updated_at: string;
}

/** What the rest of the module needs to send: never leaves the API. */
export interface OpenConnection {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  token: string;
}

const TEMPLATE_COLUMNS = `id, display_name, meta_template_name, language_code, preview_body, is_active, is_default,
  meta_status, meta_category, meta_parameters, meta_checked_at, meta_check_error, updated_at`;

/** Approved, a Utility template, and every variable one a reminder can fill. */
export function templateReady(t: Pick<TemplateRow, 'is_active' | 'meta_status' | 'meta_check_error' | 'meta_checked_at'>) {
  return t.is_active && t.meta_checked_at !== null && t.meta_status === 'APPROVED' && t.meta_check_error === null;
}

export function mapTemplate(t: TemplateRow) {
  return {
    id: t.id,
    displayName: t.display_name,
    metaTemplateName: t.meta_template_name,
    languageCode: t.language_code,
    previewBody: t.preview_body,
    isActive: t.is_active,
    isDefault: t.is_default,
    meta: {
      status: t.meta_status,
      category: t.meta_category,
      parameters: t.meta_parameters ?? [],
      checkedAt: t.meta_checked_at,
      problem: t.meta_check_error,
    },
    ready: templateReady(t),
    updatedAt: t.updated_at,
  };
}

/**
 * Judge a template as Meta holds it. Returns the problem in words, or null
 * when it can carry a reminder. Exported for the spec.
 */
export function judgeMetaTemplate(found: GraphTemplate | undefined, languageCode: string): {
  problem: string | null;
  parameters: string[];
} {
  if (!found) {
    return { problem: `There is no template with this name in language "${languageCode}" on the WhatsApp account.`, parameters: [] };
  }
  if (found.status !== 'APPROVED') {
    return { problem: `Meta has not approved this template (status: ${found.status.toLowerCase()}).`, parameters: [] };
  }
  if (found.category && found.category !== 'UTILITY') {
    return {
      problem: `Appointment reminders must be Utility templates; this one is ${found.category.toLowerCase()}.`,
      parameters: [],
    };
  }
  const components = found.components ?? [];
  const hasOtherVariables = components.some(
    (c) =>
      (c.type !== 'BODY' && typeof c.text === 'string' && /\{\{/.test(c.text)) ||
      (c.format !== undefined && c.format !== 'TEXT' && c.type === 'HEADER') ||
      (c.buttons ?? []).some((b) => typeof b.url === 'string' && /\{\{/.test(b.url)),
  );
  if (hasOtherVariables) {
    return { problem: 'Only the message body may have variables: no header media, header variables or button links.', parameters: [] };
  }
  const bodyText = components.find((c) => c.type === 'BODY')?.text ?? '';
  const parameters = templateVariables(bodyText);
  if (parameters.some((p) => /^\d+$/.test(p)) || (found.parameter_format && found.parameter_format !== 'NAMED' && parameters.length)) {
    return {
      problem: `Use named variables in the template, such as {{patient_name}}, not numbered ones like {{1}}.`,
      parameters,
    };
  }
  const unknown = unknownWhatsAppVariables(bodyText);
  if (unknown.length) {
    return {
      problem: `The template uses ${unknown.map((u) => `{{${u}}}`).join(', ')}; a reminder can only fill ${WHATSAPP_REMINDER_VARIABLES.map((v) => `{{${v}}}`).join(', ')}.`,
      parameters,
    };
  }
  return { problem: null, parameters };
}

/**
 * The clinic's WhatsApp connection and its reminder templates.
 *
 * Every read here is scoped by RLS to the signed-in clinic: the tenant comes
 * from the verified session, never from the request body. The access token is
 * sealed on the way in and opened only by `openConnection`, whose result
 * never leaves the API.
 */
@Injectable()
export class WhatsAppService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly graph: WhatsAppGraphClient,
    private readonly box: WhatsAppTokenBox,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  private async row(client: PoolClient): Promise<ConnectionRow | null> {
    const { rows } = await client.query<ConnectionRow>(
      `SELECT waba_id, phone_number_id, display_phone_number, verified_name, encrypted_access_token, token_key_id,
              connection_status, last_tested_at, last_test_ok, last_test_result, last_success_at, connected_at
         FROM clinic_whatsapp_connections LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /* ── connection ─────────────────────────────────────────────────────── */

  /** The connection as the clinic sees it. Never the token. */
  getConnection() {
    return this.tx(async (client) => {
      const r = await this.row(client);
      const tz = await client.query<{ timezone: string }>('SELECT timezone FROM clinic_settings LIMIT 1');
      return {
        connected: r !== null && r.connection_status === 'connected',
        saved: r !== null,
        wabaId: r?.waba_id ?? null,
        phoneNumberId: r?.phone_number_id ?? null,
        displayPhoneNumber: r?.display_phone_number ?? null,
        verifiedName: r?.verified_name ?? null,
        status: r?.connection_status ?? null,
        lastTestedAt: r?.last_tested_at ?? null,
        lastTestOk: r?.last_test_ok ?? null,
        lastTestResult: r?.last_test_result ?? null,
        lastSuccessAt: r?.last_success_at ?? null,
        connectedAt: r?.connected_at ?? null,
        timezone: tz.rows[0]?.timezone ?? 'Europe/Tirane',
      };
    });
  }

  /** Ask Meta whether these credentials reach this phone number on this account. */
  private async probe(token: string, wabaId: string, phoneNumberId: string) {
    try {
      const numbers = await this.graph.phoneNumbers(token, wabaId);
      const number = numbers.find((n) => n.id === phoneNumberId);
      if (!number) {
        return {
          ok: false as const,
          message: 'This Phone Number ID does not belong to that WhatsApp Business Account.',
        };
      }
      return {
        ok: true as const,
        displayPhoneNumber: number.display_phone_number ?? null,
        verifiedName: number.verified_name ?? null,
        message: 'Connected.',
      };
    } catch (err) {
      return { ok: false as const, message: err instanceof GraphError ? err.message : 'The connection test failed.' };
    }
  }

  /**
   * Test the credentials in the form or, with none given, the saved ones.
   * Testing the saved connection records the result on it.
   */
  async test(dto: TestConnectionDto) {
    const tenantId = this.tenant.getRequiredTenantId();
    const saved = await this.tx((client) => this.row(client));
    const token = dto.accessToken ?? (saved ? this.openRow(tenantId, saved) : null);
    const wabaId = dto.wabaId ?? saved?.waba_id;
    const phoneNumberId = dto.phoneNumberId ?? saved?.phone_number_id;
    if (!token || !wabaId || !phoneNumberId) {
      throw new BadRequestException('Enter the access token, Phone Number ID and Business Account ID to test.');
    }
    const result = await this.probe(token, wabaId, phoneNumberId);
    const testedAt = new Date().toISOString();

    const usesSaved =
      saved !== null && !dto.accessToken && wabaId === saved.waba_id && phoneNumberId === saved.phone_number_id;
    if (usesSaved) {
      await this.tx((client) =>
        client.query(
          `UPDATE clinic_whatsapp_connections
              SET last_tested_at = $1, last_test_ok = $2, last_test_result = $3,
                  last_success_at = CASE WHEN $2 THEN $1::timestamptz ELSE last_success_at END,
                  connection_status = CASE WHEN $2 THEN 'connected' ELSE 'failed' END,
                  display_phone_number = coalesce($4, display_phone_number),
                  verified_name = coalesce($5, verified_name),
                  updated_at = now()`,
          [testedAt, result.ok, result.message, result.ok ? result.displayPhoneNumber : null, result.ok ? result.verifiedName : null],
        ),
      );
    }
    return {
      ok: result.ok,
      message: result.message,
      displayPhoneNumber: result.ok ? result.displayPhoneNumber : null,
      verifiedName: result.ok ? result.verifiedName : null,
      testedAt,
    };
  }

  /** Save the connection. Only credentials that pass the test are saved. */
  async save(dto: ConnectionDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    const saved = await this.tx((client) => this.row(client));
    const token = dto.accessToken ?? (saved ? this.openRow(tenantId, saved) : null);
    if (!token) throw new BadRequestException('Enter the WhatsApp access token.');

    const result = await this.probe(token, dto.wabaId, dto.phoneNumberId);
    if (!result.ok) {
      throw new UnprocessableEntityException({ code: 'whatsapp_test_failed', message: result.message });
    }
    const sealed = this.box.seal(tenantId, token);
    await this.tx(async (client) => {
      await client.query(
        `INSERT INTO clinic_whatsapp_connections
           (tenant_id, waba_id, phone_number_id, display_phone_number, verified_name,
            encrypted_access_token, token_key_id, connection_status,
            last_tested_at, last_test_ok, last_test_result, last_success_at, connected_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'connected', now(), true, $8, now(), $9)
         ON CONFLICT (tenant_id) DO UPDATE SET
           waba_id = EXCLUDED.waba_id, phone_number_id = EXCLUDED.phone_number_id,
           display_phone_number = EXCLUDED.display_phone_number, verified_name = EXCLUDED.verified_name,
           encrypted_access_token = EXCLUDED.encrypted_access_token, token_key_id = EXCLUDED.token_key_id,
           connection_status = 'connected', last_tested_at = now(), last_test_ok = true,
           last_test_result = EXCLUDED.last_test_result, last_success_at = now(),
           connected_at = CASE WHEN clinic_whatsapp_connections.phone_number_id = EXCLUDED.phone_number_id
                               THEN clinic_whatsapp_connections.connected_at ELSE now() END,
           connected_by = EXCLUDED.connected_by, updated_at = now()`,
        [tenantId, dto.wabaId, dto.phoneNumberId, result.displayPhoneNumber, result.verifiedName,
         sealed.ciphertext, sealed.keyId, result.message, actor.userId],
      );
      await this.audit.record(client, actor, {
        action: 'whatsapp.connected',
        entityType: 'whatsapp_connection',
        entityId: null,
        summary: `Connected WhatsApp ${result.displayPhoneNumber ?? dto.phoneNumberId}${dto.accessToken ? ' with a new access token' : ''}`,
        // Identifiers only. Never the token.
        metadata: { wabaId: dto.wabaId, phoneNumberId: dto.phoneNumberId, tokenReplaced: Boolean(dto.accessToken) },
      });
    });
    return this.getConnection();
  }

  /** Forget the connection, and with it the token. History stays. */
  async disconnect(actor: ClinicAuditActor) {
    await this.tx(async (client) => {
      const { rows } = await client.query<{ display_phone_number: string | null; phone_number_id: string }>(
        'DELETE FROM clinic_whatsapp_connections RETURNING display_phone_number, phone_number_id',
      );
      if (!rows[0]) throw new NotFoundException('WhatsApp is not connected.');
      await this.audit.record(client, actor, {
        action: 'whatsapp.disconnected',
        entityType: 'whatsapp_connection',
        entityId: null,
        summary: `Disconnected WhatsApp ${rows[0].display_phone_number ?? rows[0].phone_number_id}; the access token was deleted`,
      });
    });
    return this.getConnection();
  }

  private openRow(tenantId: string, r: ConnectionRow): string {
    try {
      return this.box.open(tenantId, { ciphertext: r.encrypted_access_token, keyId: r.token_key_id });
    } catch {
      // A rotated-away key or a tampered row: the clinic has to paste the token again.
      throw new ConflictException({
        code: 'whatsapp_token_unreadable',
        message: 'The saved WhatsApp access token can no longer be read. Paste it again in WhatsApp Settings.',
      });
    }
  }

  /** The working connection, token included, for sending. Null when there is none. */
  async openConnection(): Promise<OpenConnection | null> {
    const tenantId = this.tenant.getRequiredTenantId();
    const r = await this.tx((client) => this.row(client));
    if (!r || r.connection_status !== 'connected') return null;
    return {
      wabaId: r.waba_id,
      phoneNumberId: r.phone_number_id,
      displayPhoneNumber: r.display_phone_number,
      token: this.openRow(tenantId, r),
    };
  }

  /** Meta refused the token mid-batch: the connection is not working any more. */
  async markConnectionFailed(message: string) {
    await this.tx((client) =>
      client.query(
        `UPDATE clinic_whatsapp_connections
            SET connection_status = 'failed', last_tested_at = now(), last_test_ok = false,
                last_test_result = $1, updated_at = now()`,
        [message],
      ),
    );
  }

  /* ── templates ──────────────────────────────────────────────────────── */

  listTemplates() {
    return this.tx(async (client) => {
      const { rows } = await client.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLUMNS} FROM whatsapp_message_templates ORDER BY is_default DESC, lower(display_name)`,
      );
      return rows.map(mapTemplate);
    });
  }

  async templateRow(client: PoolClient, id: string): Promise<TemplateRow> {
    const { rows } = await client.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM whatsapp_message_templates WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Template not found');
    return rows[0];
  }

  private checkPreview(body: string) {
    const unknown = unknownWhatsAppVariables(body);
    if (unknown.length) {
      throw new BadRequestException(
        `The preview uses ${unknown.map((u) => `{{${u}}}`).join(', ')}, which a reminder cannot fill.`,
      );
    }
  }

  private rethrowDuplicate(err: unknown): never {
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictException('There is already a template with this Meta name and language.');
    }
    throw err;
  }

  async createTemplate(dto: TemplateDto, actor: ClinicAuditActor) {
    this.checkPreview(dto.previewBody);
    const tenantId = this.tenant.getRequiredTenantId();
    const id = await this.tx(async (client) => {
      const count = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM whatsapp_message_templates');
      const isActive = dto.isActive ?? true;
      // The first template is the default: there is nothing to choose between.
      const isDefault = isActive && (dto.isDefault ?? count.rows[0]!.n === 0);
      if (isDefault) await client.query('UPDATE whatsapp_message_templates SET is_default = false WHERE is_default');
      const { rows } = await client
        .query<{ id: string }>(
          `INSERT INTO whatsapp_message_templates
             (tenant_id, display_name, meta_template_name, language_code, preview_body, is_active, is_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [tenantId, dto.displayName.trim(), dto.metaTemplateName, dto.languageCode, dto.previewBody.trim(), isActive, isDefault],
        )
        .catch((e: unknown) => this.rethrowDuplicate(e));
      await this.audit.record(client, actor, {
        action: 'whatsapp.template_saved',
        entityType: 'whatsapp_template',
        entityId: rows[0]!.id,
        summary: `Added the WhatsApp template ${dto.displayName.trim()} (${dto.metaTemplateName}, ${dto.languageCode})`,
      });
      return rows[0]!.id;
    });
    return this.checkTemplate(id).catch(() => this.getTemplate(id));
  }

  getTemplate(id: string) {
    return this.tx(async (client) => mapTemplate(await this.templateRow(client, id)));
  }

  async updateTemplate(id: string, dto: UpdateTemplateDto, actor: ClinicAuditActor) {
    if (dto.previewBody !== undefined) this.checkPreview(dto.previewBody);
    const recheck = await this.tx(async (client) => {
      const cur = await this.templateRow(client, id);
      const isActive = dto.isActive ?? cur.is_active;
      const isDefault = isActive && (dto.isDefault ?? cur.is_default);
      if (isDefault && !cur.is_default) {
        await client.query('UPDATE whatsapp_message_templates SET is_default = false WHERE is_default');
      }
      const metaChanged =
        (dto.metaTemplateName !== undefined && dto.metaTemplateName !== cur.meta_template_name) ||
        (dto.languageCode !== undefined && dto.languageCode !== cur.language_code);
      await client
        .query(
          `UPDATE whatsapp_message_templates
              SET display_name = $2, meta_template_name = $3, language_code = $4, preview_body = $5,
                  is_active = $6, is_default = $7, updated_at = now()
                  ${metaChanged ? ', meta_status = NULL, meta_category = NULL, meta_parameters = NULL, meta_checked_at = NULL, meta_check_error = NULL' : ''}
            WHERE id = $1`,
          [
            id,
            dto.displayName?.trim() ?? cur.display_name,
            dto.metaTemplateName ?? cur.meta_template_name,
            dto.languageCode ?? cur.language_code,
            dto.previewBody?.trim() ?? cur.preview_body,
            isActive,
            isDefault,
          ],
        )
        .catch((e: unknown) => this.rethrowDuplicate(e));
      await this.audit.record(client, actor, {
        action: 'whatsapp.template_saved',
        entityType: 'whatsapp_template',
        entityId: id,
        summary: `Changed the WhatsApp template ${dto.displayName?.trim() ?? cur.display_name}`,
      });
      return metaChanged;
    });
    return recheck ? this.checkTemplate(id).catch(() => this.getTemplate(id)) : this.getTemplate(id);
  }

  async deleteTemplate(id: string, actor: ClinicAuditActor) {
    await this.tx(async (client) => {
      const cur = await this.templateRow(client, id);
      await client.query('DELETE FROM whatsapp_message_templates WHERE id = $1', [id]);
      await this.audit.record(client, actor, {
        action: 'whatsapp.template_deleted',
        entityType: 'whatsapp_template',
        entityId: id,
        summary: `Deleted the WhatsApp template ${cur.display_name}; its send history keeps the name`,
      });
    });
    return { deleted: true as const };
  }

  /**
   * Ask Meta how this template stands — approved, Utility, the variables it
   * uses — and remember the answer. A reminder is sent only with a template
   * whose last check passed; the send re-checks before every batch.
   */
  async checkTemplate(id: string) {
    const conn = await this.openConnection();
    if (!conn) {
      throw new ConflictException({ code: 'whatsapp_not_connected', message: 'Connect WhatsApp before checking templates.' });
    }
    const t = await this.tx((client) => this.templateRow(client, id));
    let judged: { problem: string | null; parameters: string[] };
    let found: GraphTemplate | undefined;
    try {
      const all = await this.graph.templates(conn.token, conn.wabaId, t.meta_template_name);
      found = all.find((x) => x.language === t.language_code);
      judged = judgeMetaTemplate(found, t.language_code);
    } catch (err) {
      if (err instanceof GraphError && err.kind === 'auth') await this.markConnectionFailed(err.message);
      judged = { problem: err instanceof GraphError ? err.message : 'Could not reach WhatsApp.', parameters: [] };
    }
    await this.tx((client) =>
      client.query(
        `UPDATE whatsapp_message_templates
            SET meta_status = $2, meta_category = $3, meta_parameters = $4, meta_checked_at = now(),
                meta_check_error = $5, updated_at = now()
          WHERE id = $1`,
        [id, found?.status ?? null, found?.category ?? null, JSON.stringify(judged.parameters), judged.problem],
      ),
    );
    return this.getTemplate(id);
  }
}
