import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Meta's WhatsApp Cloud API, as each clinic's own account (0017).
 *
 * The token arrives per call, opened from the clinic's row a moment before —
 * nothing here holds one between calls. It goes in the Authorization header
 * and nowhere else: never in a URL, never in an error. Meta's own error text
 * is passed through a redaction of the token before it can reach a response,
 * a log or the database, in case an upstream message ever echoes it.
 */

const TIMEOUT_MS = 10_000;

export type GraphFailureKind =
  'auth' | 'not_found' | 'recipient' | 'template' | 'rate' | 'unreachable' | 'other';

export class GraphError extends Error {
  constructor(
    message: string,
    readonly kind: GraphFailureKind,
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

export interface GraphPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
}

export interface GraphTemplate {
  name: string;
  status: string;
  category?: string;
  language: string;
  parameter_format?: string;
  components?: {
    type: string;
    text?: string;
    format?: string;
    buttons?: { type: string; url?: string }[];
  }[];
}

export interface TemplateParameter {
  name: string;
  text: string;
}

/**
 * Meta error codes a receptionist can act on, in words. Anything else keeps
 * Meta's own sentence, with the code for whoever looks it up.
 */
const KNOWN: Record<number, { kind: GraphFailureKind; message: string }> = {
  190: {
    kind: 'auth',
    message:
      'The WhatsApp access token is invalid or has expired. Paste a new one in WhatsApp Settings.',
  },
  10: {
    kind: 'auth',
    message: 'The access token does not have permission for this WhatsApp account.',
  },
  200: {
    kind: 'auth',
    message: 'The access token does not have permission for this WhatsApp account.',
  },
  4: {
    kind: 'rate',
    message:
      'WhatsApp is limiting requests from this account. Try again in a few minutes.',
  },
  80007: {
    kind: 'rate',
    message:
      'WhatsApp is limiting requests from this account. Try again in a few minutes.',
  },
  130429: {
    kind: 'rate',
    message:
      'WhatsApp is limiting messages from this number. Try again in a few minutes.',
  },
  131056: {
    kind: 'rate',
    message: 'Too many messages to this patient in a short time. Try again later.',
  },
  131026: { kind: 'recipient', message: 'This number cannot receive WhatsApp messages.' },
  131030: {
    kind: 'recipient',
    message: 'This number is not on the WhatsApp test account’s allowed list.',
  },
  131031: { kind: 'auth', message: 'Meta has locked this WhatsApp Business account.' },
  133010: {
    kind: 'auth',
    message: 'The clinic’s WhatsApp number is not registered with the Cloud API.',
  },
  368: {
    kind: 'auth',
    message: 'Meta has temporarily blocked this account for a policy violation.',
  },
  132000: {
    kind: 'template',
    message: 'The template’s variables do not match the approved template.',
  },
  132001: {
    kind: 'template',
    message: 'The template does not exist in this language on the WhatsApp account.',
  },
  132005: { kind: 'template', message: 'The filled-in template text is too long.' },
  132007: { kind: 'template', message: 'The template text breaks a WhatsApp policy.' },
  132012: { kind: 'template', message: 'A template variable has the wrong format.' },
  132015: { kind: 'template', message: 'Meta has paused this template for low quality.' },
  132016: { kind: 'template', message: 'Meta has disabled this template.' },
};

@Injectable()
export class WhatsAppGraphClient {
  constructor(private readonly config: ConfigService) {}

  private base(): string {
    const root = (
      this.config.get<string>('WHATSAPP_GRAPH_BASE_URL') ?? 'https://graph.facebook.com'
    ).replace(/\/+$/, '');
    return `${root}/${this.config.get<string>('WHATSAPP_GRAPH_VERSION') ?? 'v25.0'}`;
  }

  private async call<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base()}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GraphError(
        'WhatsApp did not answer. Check the connection and try again.',
        'unreachable',
      );
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw toGraphError(res.status, json, token);
    return json as T;
  }

  /** The phone numbers of a WhatsApp Business Account the token can see. */
  async phoneNumbers(token: string, wabaId: string): Promise<GraphPhoneNumber[]> {
    const out = await this.call<{ data?: GraphPhoneNumber[] }>(
      token,
      'GET',
      `/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`,
    );
    return out.data ?? [];
  }

  /** Every template on the account with this name, in every language. */
  async templates(token: string, wabaId: string, name: string): Promise<GraphTemplate[]> {
    const query = new URLSearchParams({
      name,
      fields: 'name,status,category,language,parameter_format,components',
      limit: '100',
    });
    const out = await this.call<{ data?: GraphTemplate[] }>(
      token,
      'GET',
      `/${encodeURIComponent(wabaId)}/message_templates?${query.toString()}`,
    );
    // `name` filters by prefix on Meta's side; keep exact matches only.
    return (out.data ?? []).filter((t) => t.name === name);
  }

  /** Send an approved template. Returns Meta's message id. */
  async sendTemplate(
    token: string,
    phoneNumberId: string,
    input: {
      to: string;
      name: string;
      language: string;
      parameters: TemplateParameter[];
    },
  ): Promise<{ messageId: string; status: string | null }> {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'template',
      template: {
        name: input.name,
        language: { code: input.language },
        ...(input.parameters.length
          ? {
              components: [
                {
                  type: 'body',
                  parameters: input.parameters.map((p) => ({
                    type: 'text',
                    parameter_name: p.name,
                    text: p.text,
                  })),
                },
              ],
            }
          : {}),
      },
    };
    const out = await this.call<{
      messages?: { id?: string; message_status?: string }[];
    }>(token, 'POST', `/${encodeURIComponent(phoneNumberId)}/messages`, body);
    const id = out.messages?.[0]?.id;
    if (!id)
      throw new GraphError(
        'WhatsApp accepted the request but returned no message id.',
        'other',
      );
    return { messageId: id, status: out.messages?.[0]?.message_status ?? null };
  }
}

/** Meta's error, as something safe to show and store. Exported for the spec. */
export function toGraphError(
  httpStatus: number,
  body: unknown,
  token: string,
): GraphError {
  const err = (
    body as {
      error?: {
        code?: unknown;
        error_subcode?: unknown;
        message?: unknown;
        error_data?: { details?: unknown };
      };
    } | null
  )?.error;
  const code = typeof err?.code === 'number' ? err.code : null;
  const known = code !== null ? KNOWN[code] : undefined;
  if (known) return new GraphError(known.message, known.kind, code);

  // 100/33: the object does not exist, or this token cannot see it. Other
  // code-100 errors are bad parameters, and keep Meta's own words below.
  if ((code === 100 && err?.error_subcode === 33) || httpStatus === 404) {
    return new GraphError(
      'WhatsApp could not find that Business Account or Phone Number ID for this token.',
      'not_found',
      code,
    );
  }
  const detail =
    typeof err?.error_data?.details === 'string' ? err.error_data.details : undefined;
  const said = detail ?? (typeof err?.message === 'string' ? err.message : undefined);
  const text = said ? redact(said, token).slice(0, 300) : `HTTP ${httpStatus}`;
  return new GraphError(
    `WhatsApp refused the request${code !== null ? ` (code ${code})` : ''}: ${text}`,
    'other',
    code,
  );
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join('[redacted]') : text;
}
