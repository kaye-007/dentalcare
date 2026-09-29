import type { Permission, Role } from './permissions';
// Re-exporting a type does not put it in local scope, and the response
// interfaces below refer to these by name.
import type {
  CurrencyCode,
  FeatureGroup,
  FeatureKey,
  FeatureState,
  VarianceBand,
  ImportDateFormat,
  ImportIssue,
  ReminderChannelId,
  ReminderLocale,
  DocumentKind,
  VatCategory,
  VatGroup,
  MessagePurpose,
  PerioSite,
  Surface,
  ToothCondition,
  WorkingDay,
  WhatsAppExclusion,
  WhatsAppOptInSource,
  WhatsAppSendStatus,
  WhatsAppValues,
} from '@dentalcare/shared';

const ACCESS_KEY = 'dc.access';
const REFRESH_KEY = 'dc.refresh';

export const tokenStore = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh?: string) {
    localStorage.setItem(ACCESS_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * The API's machine-readable reason, when it gave one — `drawer_not_open`,
     * `feature_unavailable`. What a screen branches on; `message` is what it
     * shows.
     */
    public code: string | null = null,
    /** The rest of the error body, e.g. the invoices a drawer close refused over. */
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** What the person at the desk reads when the failure is ours, not theirs. */
export const GENERIC_ERROR =
  'Something went wrong on our side. Please try again in a moment.';
export const NETWORK_ERROR =
  'DentalCare could not be reached. Check the internet connection and try again.';

/**
 * Words that only ever appear in a message that leaked from the machinery —
 * a database driver, a proxy, a runtime. The API's own messages are written
 * for people; these never are, so they are replaced rather than shown.
 */
const TECHNICAL =
  /\b(sql|syntax error|relation "|violates|constraint|econn|etimedout|enotfound|stack|undefined is not|cannot read propert|typeerror|referenceerror|internal server error|bad gateway|gateway time-?out|service unavailable|cloudflare|worker threw|exception|hyperdrive|postgres|pg_)\b/i;

function humanMessage(
  status: number,
  message: string,
  code: string | null = null,
): string {
  // A locked sign-in says how long to wait (API 0025); any other 429 is the
  // short per-minute brake, and "a moment" is the truth there.
  if (status === 429 && code === 'sign_in_locked' && message) return message;
  if (status === 429)
    return 'Too many attempts in a short time. Wait a moment and try again.';
  if (status === 413) return 'That file is too large to upload.';
  if (status >= 500 || TECHNICAL.test(message)) return GENERIC_ERROR;
  // Nest's defaults, which are true but say nothing a person can act on.
  if (status === 403 && (!message || /^forbidden( resource)?$/i.test(message)))
    return 'Your role does not allow this. Ask a clinic administrator if you need it.';
  if (
    status === 404 &&
    (!message || /^(not found|cannot (get|post|put|patch|delete) )/i.test(message))
  )
    return 'That record could not be found. It may have been removed.';
  if (!message) return GENERIC_ERROR;
  return message;
}

/**
 * Turn a failed Response into an ApiError. Nest returns validation failures as
 * a `message` array, so those are joined into one readable line. A server
 * failure never reaches the screen as its raw text — see `humanMessage`.
 */
async function toApiError(res: Response): Promise<ApiError> {
  let message = '';
  let code: string | null = null;
  let details: Record<string, unknown> = {};
  try {
    const body = await res.json();
    message = Array.isArray(body.message)
      ? body.message.join(', ')
      : (body.message ?? message);
    if (typeof body.code === 'string') code = body.code;
    if (body && typeof body === 'object') details = body as Record<string, unknown>;
  } catch {
    /* response had no JSON body — the status decides the wording */
  }
  return new ApiError(
    res.status,
    humanMessage(res.status, String(message), code),
    code,
    details,
  );
}

/**
 * The sentence to show for any caught error. An ApiError already carries a
 * human message; anything else (a thrown TypeError, a failed fetch) gets the
 * caller's own fallback, which names what was being attempted.
 */
export function humanError(err: unknown, fallback = GENERIC_ERROR): string {
  if (err instanceof ApiError) return err.message || fallback;
  // A plain Error thrown by our own code on purpose ("That image is too
  // large") is written for people; a runtime failure is not.
  if (
    err instanceof Error &&
    err.constructor === Error &&
    err.message &&
    !TECHNICAL.test(err.message)
  ) {
    return err.message;
  }
  return fallback;
}

/** fetch, with a network failure turned into an ApiError that reads like one. */
async function fetchOrFail(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    // An abort is the caller's decision, not a failure to report.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, NETWORK_ERROR, 'network');
  }
}

/**
 * A key for one user action that moves money, sent as `Idempotency-Key`.
 * Make it once per action — when the payment sheet opens — and send the same
 * key on every retry of that action, so a double tap or a lost response
 * cannot take the money twice (API migration 0013).
 *
 * The API refuses a money action without one (428), so every call below that
 * moves money takes the key as a required argument.
 */
export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

function idempotent(key: string): HeadersInit {
  return { 'Idempotency-Key': key };
}

/** Called when the session cannot be recovered, so the app can log out. */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn;
}

/**
 * In-flight refresh, shared by every request that gets a 401 at the same time.
 * Without this a page that fires four parallel calls would trigger four
 * refreshes and rotate the token out from under itself.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = tokenStore.refresh;
  if (!refreshToken) return false;

  const headers = new Headers({ 'Content-Type': 'application/json' });
  applyTenantHeader(headers);

  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
    if (!body.accessToken || !body.refreshToken) return false;
    // Refresh tokens rotate (migration 0005): the one just sent is spent, so
    // its successor has to be stored before anything else can reach for it.
    tokenStore.set(body.accessToken, body.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function applyTenantHeader(headers: Headers) {
  // In production the subdomain (Host) identifies the clinic. For local dev
  // we send it explicitly; defaults to the demo clinic. The API ignores this
  // header unless ALLOW_TENANT_HEADER=1 and NODE_ENV is not production.
  const tenant = (import.meta.env.VITE_TENANT_SUBDOMAIN as string | undefined) ?? 'demo';
  headers.set('X-Tenant-Subdomain', tenant);
}

async function send(
  path: string,
  options: RequestInit,
  auth: boolean,
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  applyTenantHeader(headers);
  if (auth && tokenStore.access) {
    headers.set('Authorization', `Bearer ${tokenStore.access}`);
  }
  return fetchOrFail(`/api${path}`, { ...options, headers });
}

/**
 * A binary response — an invoice PDF — fetched with the session's token.
 * Returned as a Blob so the caller can open or save it; an `<a href>` to the
 * API cannot carry the Authorization header. Retries once on 401 like
 * `request` does.
 */
export async function fetchBlob(path: string): Promise<Blob> {
  const doSend = () => {
    const headers = new Headers();
    applyTenantHeader(headers);
    if (tokenStore.access) headers.set('Authorization', `Bearer ${tokenStore.access}`);
    return fetchOrFail(`/api${path}`, { headers });
  };
  let res = await doSend();
  if (res.status === 401 && tokenStore.refresh) {
    refreshInFlight ??= refreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
    if (await refreshInFlight) {
      res = await doSend();
    } else {
      tokenStore.clear();
      onSessionExpired?.();
    }
  }
  if (!res.ok) throw await toApiError(res);
  return res.blob();
}

/**
 * Multipart upload. Deliberately does not set Content-Type: the browser must
 * generate it with the multipart boundary, and overriding it silently breaks
 * the upload. Retries once on 401 like `request` does.
 */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const doSend = () => {
    const headers = new Headers();
    applyTenantHeader(headers);
    if (tokenStore.access) {
      headers.set('Authorization', `Bearer ${tokenStore.access}`);
    }
    // A FormData body can be sent again as-is, so the 401 retry below is safe.
    return fetchOrFail(`/api${path}`, { method: 'POST', body: form, headers });
  };

  let res = await doSend();
  if (res.status === 401 && tokenStore.refresh) {
    refreshInFlight ??= refreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
    if (await refreshInFlight) {
      res = await doSend();
    } else {
      tokenStore.clear();
      onSessionExpired?.();
    }
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  auth = true,
): Promise<T> {
  let res = await send(path, options, auth);

  // The access token is short-lived (15m). On expiry, refresh once and replay
  // the original request rather than dumping the user back at the login page
  // mid-task.
  if (res.status === 401 && auth && tokenStore.refresh) {
    refreshInFlight ??= refreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
    const refreshed = await refreshInFlight;

    if (refreshed) {
      res = await send(path, options, auth);
    } else {
      tokenStore.clear();
      onSessionExpired?.();
    }
  }

  if (!res.ok) throw await toApiError(res);

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Trial state, resolved per request from `tenants.trial_ends_at`.
 *
 * Advisory only: it exists so the app can explain itself and stop offering
 * buttons that will 402. ReadOnlyGuard on the API is what actually refuses
 * the write. `endsAt` is null for a paying clinic.
 */
export interface TrialState {
  endsAt: string | null;
  readOnly: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  tenantId: string;
  clinicName: string;
  /** Server-resolved. UI gating only — never a security boundary. */
  permissions: Permission[];
  /** Absent on a session that predates the trial work; treated as unlimited. */
  trial?: TrialState;
  /** Two-step sign-in state, for prompts. The API enforces the requirement. */
  mfa?: { enrolled: boolean; required: boolean };
  /** Every amount the API returns is minor units (cents) of this currency. */
  currency?: CurrencyCode;
  /** The clinic's IANA time zone; appointments are shown and booked in it. */
  timezone?: string;
}

/* ── Sign-in, sessions and two-step sign-in (0005) ───────── */

export interface AuthenticatedResult {
  status: 'authenticated';
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

/**
 * A sign-in completes, or stops for a second factor. The challenge token is
 * good for ten minutes and for the next step only — it opens no route.
 */
export type LoginResult =
  | AuthenticatedResult
  | { status: 'mfa_required'; challengeToken: string; methods: ('totp' | 'recovery')[] }
  | { status: 'mfa_enrollment_required'; challengeToken: string };

export type MfaStage = 'verify' | 'enroll';

export interface TotpSetup {
  /** Base32. Shown once, for typing in by hand; the QR code carries it too. */
  secret: string;
  otpauthUri: string;
}

export interface MfaStatus {
  enrolled: boolean;
  confirmedAt: string | null;
  lockedUntil: string | null;
  recoveryCodesRemaining: number;
  required: boolean;
}

export interface ActiveSession {
  familyId: string;
  startedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  mfaVerified: boolean;
  current: boolean;
}

/** The signed-in user's own account security. Every role has these. */
export const securityApi = {
  mfaStatus() {
    return request<MfaStatus>('/auth/mfa');
  },
  setupTotp() {
    return request<TotpSetup>('/auth/mfa/totp/setup', { method: 'POST' });
  },
  confirmTotp(code: string) {
    return request<{ recoveryCodes: string[] }>('/auth/mfa/totp/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },
  regenerateRecoveryCodes(code: string) {
    return request<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },
  disableMfa(password: string, code: string) {
    return request<{ disabled: true }>('/auth/mfa/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code }),
    });
  },
  sessions() {
    return request<ActiveSession[]>('/auth/sessions');
  },
  revokeOtherSessions() {
    return request<{ revoked: number }>('/auth/sessions/revoke-others', {
      method: 'POST',
    });
  },
  revokeSession(familyId: string) {
    return request<{ revoked: true }>(`/auth/sessions/${familyId}/revoke`, {
      method: 'POST',
    });
  },
};

export interface PatientListItem {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  status: 'active' | 'inactive' | 'archived';
  createdAt: string;
  /** Present for roles that can read appointments. */
  nextAppointmentAt?: string | null;
  /** Minor units, what the patient owes (negative: credit). Roles that read invoices only. */
  balance?: number;
}
export interface PatientNote {
  id: string;
  body: string;
  created_at: string;
  author_name: string | null;
}
export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  gender: 'male' | 'female' | 'other' | null;
  birthDate: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  status: 'active' | 'inactive' | 'archived';
  createdAt: string;
  notes: PatientNote[];
  emergencyContact: {
    name: string;
    relationship: string | null;
    phone: string | null;
  } | null;
  archivedAt: string | null;
  archiveReason: string | null;
  archivedByName: string | null;
  /** The patient is not sent reminders. */
  remindersOptOut: boolean;
  remindersOptOutAt: string | null;
  /** Who decided: staff, the patient replying STOP, or the SMS provider. */
  remindersOptOutSource: 'staff' | 'patient' | 'provider' | null;
  /** Personal number or other national identifier. */
  nationalId: string | null;
  /** The patient's own reminder channel; null follows the clinic. */
  preferredChannel: ReminderChannelId | null;
  photoDocumentId: string | null;
  /** WhatsApp reminders (0017): the number, when not the phone, as E.164. */
  whatsappPhone: string | null;
  /** The patient agreed to WhatsApp reminders — when, and how. */
  whatsappOptIn: boolean;
  whatsappOptedInAt: string | null;
  whatsappOptInSource: WhatsAppOptInSource | null;
  /** Short-lived signed link to the profile picture. */
  photoUrl?: string | null;
  /** Travels with every patient load so no screen can miss a severe allergy. */
  allergySummary: {
    count: number;
    hasSevere: boolean;
    substances: string[];
  };
}
export type AllergySeverity = 'mild' | 'moderate' | 'severe';

export interface Allergy {
  id: string;
  substance: string;
  reaction: string | null;
  severity: AllergySeverity;
  notes: string | null;
  recordedByName: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Condition {
  id: string;
  name: string;
  status: 'active' | 'resolved';
  diagnosedOn: string | null;
  notes: string | null;
  recordedByName: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Medication {
  id: string;
  name: string;
  dosage: string | null;
  frequency: string | null;
  startedOn: string | null;
  endedOn: string | null;
  isCurrent: boolean;
  notes: string | null;
  recordedByName: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface MedicalHistory {
  allergies: Allergy[];
  conditions: Condition[];
  medications: Medication[];
  hasSevereAllergy: boolean;
  activeConditionCount: number;
  currentMedicationCount: number;
}

// The seven kinds the API accepts. From the shared package, so the upload
// picker cannot offer one the API would reject.
export { DOCUMENT_KINDS, type DocumentKind } from '@dentalcare/shared';

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  xray: 'X-ray',
  panoramic: 'Panoramic (OPG)',
  cbct: 'CBCT',
  photo: 'Photo',
  consent: 'Consent form',
  referral: 'Referral',
  insurance: 'Insurance',
  id_document: 'ID document',
  report: 'Report',
  other: 'Other',
};

export interface PatientDocument {
  id: string;
  patientId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  kind: DocumentKind;
  tooth: number | null;
  takenOn: string | null;
  caption: string | null;
  /** Before / after / progress, on photos. */
  photoTag: PhotoTag | null;
  uploadedByName: string | null;
  createdAt: string;
  isImage: boolean;
  /** JPEG, PNG or WEBP — something a browser can draw as a thumbnail. */
  isPreviewable: boolean;
}

export const PHOTO_TAGS = ['before', 'after', 'progress'] as const;
export type PhotoTag = (typeof PHOTO_TAGS)[number];
export const PHOTO_TAG_LABELS: Record<PhotoTag, string> = {
  before: 'Before',
  after: 'After',
  progress: 'Progress',
};
export interface SignedLink {
  url: string;
  fileName: string;
  contentType: string;
  expiresInSeconds: number;
}

export interface PatientList {
  items: PatientListItem[];
  total: number;
  page: number;
  pageSize: number;
}
export interface PatientPayload {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  gender?: 'male' | 'female' | 'other' | '';
  birthDate?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  status?: 'active' | 'inactive';
  emergencyContactName?: string;
  emergencyContactRelationship?: string;
  emergencyContactPhone?: string;
  /** Edit only — a new patient has not refused anything yet. */
  remindersOptOut?: boolean;
  nationalId?: string;
  /** '' follows the clinic's default channel. */
  preferredChannel?: ReminderChannelId | '';
  /** '' clears it: reminders then go to the phone above. */
  whatsappPhone?: string;
  whatsappOptIn?: boolean;
  whatsappOptInSource?: WhatsAppOptInSource;
}

export const api = {
  login(email: string, password: string) {
    return request<LoginResult>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
      false,
    );
  },
  verifyMfa(challengeToken: string, input: { code?: string; recoveryCode?: string }) {
    return request<AuthenticatedResult>(
      '/auth/mfa/verify',
      { method: 'POST', body: JSON.stringify({ challengeToken, ...input }) },
      false,
    );
  },
  beginEnrollment(challengeToken: string) {
    return request<TotpSetup>(
      '/auth/mfa/enroll/start',
      { method: 'POST', body: JSON.stringify({ challengeToken }) },
      false,
    );
  },
  confirmEnrollment(challengeToken: string, code: string) {
    return request<AuthenticatedResult & { recoveryCodes: string[] }>(
      '/auth/mfa/enroll/confirm',
      { method: 'POST', body: JSON.stringify({ challengeToken, code }) },
      false,
    );
  },
  /** Ends the session server-side. Holding the refresh token is the authority. */
  logout(refreshToken: string) {
    return request<{ signedOut: true }>(
      '/auth/logout',
      { method: 'POST', body: JSON.stringify({ refreshToken }) },
      false,
    );
  },
  me() {
    return request<AuthUser>('/auth/me');
  },
  changePassword(currentPassword: string, newPassword: string) {
    return request<{ changed: true }>('/auth/password', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  listPatients(params: { q?: string; status?: string; page?: number }) {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.status && params.status !== 'all') qs.set('status', params.status);
    if (params.page) qs.set('page', String(params.page));
    const s = qs.toString();
    return request<PatientList>(`/patients${s ? `?${s}` : ''}`);
  },
  /** Patients due for a check-up: last completed visit more than `months` ago, nothing booked. */
  recallDue(months: number) {
    return request<{ months: number; items: RecallPatient[] }>(
      `/patients/recall?months=${months}`,
    );
  },
  getPatient(id: string) {
    return request<Patient>(`/patients/${id}`);
  },
  createPatient(payload: PatientPayload) {
    return request<Patient>('/patients', {
      method: 'POST',
      body: JSON.stringify(clean(payload)),
    });
  },
  updatePatient(id: string, payload: PatientPayload) {
    return request<Patient>(`/patients/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(clean(payload)),
    });
  },
  addNote(patientId: string, body: string) {
    return request<PatientNote>(`/patients/${patientId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  },
  /** Notes are never edited or deleted; a wrong one is withdrawn with a reason. */
  withdrawNote(noteId: string, reason: string) {
    return request<{ withdrawn: true }>(`/patients/notes/${noteId}/entered-in-error`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  /**
   * Archives rather than deletes — dental records carry retention duties and
   * are referenced by appointments and invoices. Returns how many upcoming
   * appointments the archive affects, so the UI can say so.
   */
  archivePatient(id: string, reason?: string) {
    return request<Patient & { upcomingAppointmentsAffected: number }>(
      `/patients/${id}`,
      { method: 'DELETE', body: JSON.stringify({ reason: reason ?? '' }) },
    );
  },
  restorePatient(id: string) {
    return request<Patient>(`/patients/${id}/restore`, { method: 'POST' });
  },
};

/* ── Record access: who opened this patient's record ──────── */

export type PatientAccessResource =
  | 'record'
  | 'chart'
  | 'procedures'
  | 'perio'
  | 'history'
  | 'documents'
  | 'document_file'
  | 'treatment_plans'
  | 'billing'
  | 'messages';

export interface PatientAccessEntry {
  id: string;
  resource: PatientAccessResource;
  accessedAt: string;
  actor: {
    userId: string | null;
    label: string;
    role: string;
    currentName: string | null;
  };
}

export const patientAccessApi = {
  /** Administrator only (`audit:read`). */
  list(patientId: string, limit = 200) {
    return request<PatientAccessEntry[]>(
      `/patients/${patientId}/access-log?limit=${limit}`,
    );
  },
};

/** The body every "withdraw as entered in error" call sends. */
const withdrawal = (reason: string) => ({
  method: 'POST',
  body: JSON.stringify({ reason }),
});

/* ── Medical history: allergies, conditions, medications ─── */

export const historyApi = {
  summary(patientId: string) {
    return request<MedicalHistory>(`/patients/${patientId}/history`);
  },

  listAllergies(patientId: string) {
    return request<Allergy[]>(`/patients/${patientId}/allergies`);
  },
  createAllergy(
    patientId: string,
    payload: {
      substance: string;
      severity: AllergySeverity;
      reaction?: string;
      notes?: string;
    },
  ) {
    return request<Allergy>(`/patients/${patientId}/allergies`, {
      method: 'POST',
      body: JSON.stringify(clean(payload)),
    });
  },
  updateAllergy(
    patientId: string,
    id: string,
    payload: Partial<{
      substance: string;
      severity: AllergySeverity;
      reaction: string;
      notes: string;
    }>,
  ) {
    return request<Allergy>(`/patients/${patientId}/allergies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  withdrawAllergy(patientId: string, id: string, reason: string) {
    return request<{ withdrawn: true }>(
      `/patients/${patientId}/allergies/${id}/entered-in-error`,
      withdrawal(reason),
    );
  },

  listConditions(patientId: string) {
    return request<Condition[]>(`/patients/${patientId}/conditions`);
  },
  createCondition(
    patientId: string,
    payload: {
      name: string;
      status?: 'active' | 'resolved';
      diagnosedOn?: string;
      notes?: string;
    },
  ) {
    return request<Condition>(`/patients/${patientId}/conditions`, {
      method: 'POST',
      body: JSON.stringify(clean(payload)),
    });
  },
  updateCondition(
    patientId: string,
    id: string,
    payload: Partial<{
      name: string;
      status: 'active' | 'resolved';
      diagnosedOn: string;
      notes: string;
    }>,
  ) {
    return request<Condition>(`/patients/${patientId}/conditions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  withdrawCondition(patientId: string, id: string, reason: string) {
    return request<{ withdrawn: true }>(
      `/patients/${patientId}/conditions/${id}/entered-in-error`,
      withdrawal(reason),
    );
  },

  listMedications(patientId: string) {
    return request<Medication[]>(`/patients/${patientId}/medications`);
  },
  createMedication(
    patientId: string,
    payload: {
      name: string;
      dosage?: string;
      frequency?: string;
      startedOn?: string;
      endedOn?: string;
      notes?: string;
    },
  ) {
    return request<Medication>(`/patients/${patientId}/medications`, {
      method: 'POST',
      body: JSON.stringify(clean(payload)),
    });
  },
  updateMedication(
    patientId: string,
    id: string,
    payload: Partial<{
      name: string;
      dosage: string;
      frequency: string;
      startedOn: string | null;
      endedOn: string | null;
      notes: string;
    }>,
  ) {
    return request<Medication>(`/patients/${patientId}/medications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  withdrawMedication(patientId: string, id: string, reason: string) {
    return request<{ withdrawn: true }>(
      `/patients/${patientId}/medications/${id}/entered-in-error`,
      withdrawal(reason),
    );
  },
};

/* ── Documents: X-rays, consent forms, referrals ─────────── */

export const documentsApi = {
  list(patientId: string, kind?: DocumentKind) {
    const qs = kind ? `?kind=${kind}` : '';
    return request<PatientDocument[]>(`/patients/${patientId}/documents${qs}`);
  },
  counts(patientId: string) {
    return request<{ total: number; byKind: Partial<Record<DocumentKind, number>> }>(
      `/patients/${patientId}/documents/counts`,
    );
  },

  /**
   * `file` goes up as multipart. The server ignores the browser's declared
   * MIME type and sniffs the real magic bytes, so a mislabelled file is
   * refused there rather than trusted here.
   */
  upload(
    patientId: string,
    file: File,
    meta: {
      kind?: DocumentKind;
      tooth?: number;
      takenOn?: string;
      caption?: string;
      photoTag?: PhotoTag;
    } = {},
  ) {
    const form = new FormData();
    form.append('file', file);
    if (meta.kind) form.append('kind', meta.kind);
    if (meta.tooth !== undefined) form.append('tooth', String(meta.tooth));
    if (meta.takenOn) form.append('takenOn', meta.takenOn);
    if (meta.caption) form.append('caption', meta.caption);
    if (meta.photoTag) form.append('photoTag', meta.photoTag);
    return upload<PatientDocument & { duplicate: boolean }>(
      `/patients/${patientId}/documents`,
      form,
    );
  },

  /** Signed view links for every drawable image of the patient, for thumbnails. */
  thumbnails(patientId: string) {
    return request<{ id: string; url: string }[]>(
      `/patients/${patientId}/documents/thumbnails`,
    );
  },

  /** The cropped profile picture, already re-encoded by the browser. */
  setProfilePhoto(patientId: string, image: Blob) {
    const form = new FormData();
    form.append('file', image, 'profile.jpg');
    return upload<{ photoDocumentId: string; photoUrl: string }>(
      `/patients/${patientId}/photo`,
      form,
    );
  },
  clearProfilePhoto(patientId: string) {
    return request<{ photoDocumentId: null; photoUrl: null }>(
      `/patients/${patientId}/photo`,
      {
        method: 'DELETE',
      },
    );
  },

  /** Short-lived signed URL for inline preview. */
  viewUrl(id: string) {
    return request<SignedLink>(`/documents/${id}/view`);
  },
  /** Short-lived signed URL that triggers a download. */
  downloadUrl(id: string) {
    return request<SignedLink>(`/documents/${id}/download`);
  },
  update(
    id: string,
    payload: Partial<{
      kind: DocumentKind;
      tooth: number | null;
      takenOn: string | null;
      caption: string | null;
    }>,
  ) {
    return request<PatientDocument>(`/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  remove(id: string) {
    return request<{ deleted: true }>(`/documents/${id}`, { method: 'DELETE' });
  },
};

// Drop empty-string optionals so the API doesn't reject them on validation.
/**
 * Drop empty/undefined keys before sending. The API treats an absent field as
 * "leave alone" and an explicit null as "clear", so sending '' would set a
 * column to an empty string instead of NULL.
 */
function clean<T extends object>(p: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v !== '' && v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/* ── Appointments (M6) ──────────────────────────────────── */
export const APPT_STATUSES = [
  'scheduled',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type ApptStatus = (typeof APPT_STATUSES)[number];

export const APPT_STATUS_LABELS: Record<ApptStatus, string> = {
  scheduled: 'Scheduled',
  checked_in: 'Checked in',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

/** Statuses that still occupy a chair — mirrors BLOCKING_STATUSES on the API. */
export const APPT_ACTIVE_STATUSES: ApptStatus[] = [
  'scheduled',
  'checked_in',
  'in_progress',
];

export interface Appointment {
  id: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  patientEmail: string | null;
  staffId: string | null;
  staffName: string | null;
  operatoryId: string | null;
  operatoryName: string | null;
  operatoryColor: string | null;
  reason: string;
  status: ApptStatus;
  startsAt: string;
  endsAt: string;
  checkedInAt: string | null;
  inProgressAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  rescheduledAt: string | null;
}

export interface Operatory {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  color: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface AvailabilityEntry {
  id: string;
  staffId: string;
  staffName: string | null;
  weekday: number;
  startsAt: string;
  endsAt: string;
  operatoryId: string | null;
  operatoryName: string | null;
}

export interface StatusEvent {
  id: string;
  fromStatus: ApptStatus | null;
  toStatus: ApptStatus;
  note: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface FreeSlots {
  date: string;
  weekday: number;
  slots: { startsAt: string; endsAt: string }[];
  /** not_working: no shift that weekday. closed: a holiday or time off. */
  reason: 'not_working' | 'closed' | null;
  /** Why, when closed. */
  closure?: string;
  wholeClinic?: boolean;
}

/** A time the visit can be booked, with the practitioner and room already chosen. */
export interface FoundTime {
  startsAt: string;
  endsAt: string;
  staffId: string | null;
  staffName: string | null;
  operatoryId: string | null;
  operatoryName: string | null;
  operatoryColor: string | null;
}
export interface FoundTimes {
  times: FoundTime[];
  /** The dentist who saw the patient last, offered first. */
  usualStaffId: string | null;
  from: string;
  /** Where "more times" carries on: the day after the last one looked at. */
  nextFrom: string;
}

/** A holiday or closure (staffId null) or one person's time off. */
export interface Closure {
  id: string;
  staffId: string | null;
  staffName: string | null;
  startsOn: string;
  endsOn: string;
  reason: string;
  createdAt: string;
}

export const closuresApi = {
  list(from?: string, to?: string) {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const s = qs.toString();
    return request<Closure[]>(`/closures${s ? `?${s}` : ''}`);
  },
  create(p: { staffId?: string; startsOn: string; endsOn: string; reason: string }) {
    return request<Closure>('/closures', {
      method: 'POST',
      body: JSON.stringify(clean(p)),
    });
  },
  remove(id: string) {
    return request<{ deleted: true }>(`/closures/${id}`, { method: 'DELETE' });
  },
};
export interface StaffMember {
  id: string;
  fullName: string;
  role: Role;
  status: 'active' | 'disabled';
  position: string | null;
  /** Has a calendar column and a weekly schedule. */
  seesPatients: boolean;
  /** The room their new bookings start in. */
  homeOperatoryId?: string | null;
}
export interface AppointmentPayload {
  patientId: string;
  staffId?: string;
  operatoryId?: string;
  startsAt: string;
  endsAt: string;
  reason: string;
}

export const appointmentsApi = {
  list(params: {
    from?: string;
    to?: string;
    patientId?: string;
    staffId?: string;
    operatoryId?: string;
    status?: ApptStatus[];
  }) {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.patientId) qs.set('patientId', params.patientId);
    if (params.staffId) qs.set('staffId', params.staffId);
    if (params.operatoryId) qs.set('operatoryId', params.operatoryId);
    for (const st of params.status ?? []) qs.append('status', st);
    const s = qs.toString();
    return request<Appointment[]>(`/appointments${s ? `?${s}` : ''}`);
  },
  create(p: AppointmentPayload) {
    return request<Appointment>('/appointments', {
      method: 'POST',
      body: JSON.stringify(p),
    });
  },
  /** Details and timing only — status moves through `transition`. */
  update(
    id: string,
    p: Partial<
      Omit<AppointmentPayload, 'staffId' | 'operatoryId'> & {
        /** null clears it; absent keeps it. */
        staffId: string | null;
        operatoryId: string | null;
      }
    >,
  ) {
    return request<Appointment>(`/appointments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  /**
   * The only way status changes. The API enforces the state machine and
   * records who moved it and why.
   */
  transition(
    id: string,
    status: ApptStatus,
    opts: { reason?: string; note?: string } = {},
  ) {
    return request<Appointment>(`/appointments/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, ...opts }),
    });
  },
  history(id: string) {
    return request<StatusEvent[]>(`/appointments/${id}/history`);
  },
  /** Server-owned lifecycle rules, so the UI never keeps its own copy. */
  statuses() {
    return request<{
      statuses: ApptStatus[];
      transitions: Record<ApptStatus, ApptStatus[]>;
    }>('/appointments/statuses');
  },
  freeSlots(params: {
    staffId: string;
    date: string;
    duration?: number;
    operatoryId?: string;
  }) {
    const qs = new URLSearchParams({ staffId: params.staffId, date: params.date });
    if (params.duration) qs.set('duration', String(params.duration));
    if (params.operatoryId) qs.set('operatoryId', params.operatoryId);
    return request<FreeSlots>(`/appointments/free-slots?${qs}`);
  },
  /**
   * "When can she come in?" The server walks the working hours, closures and
   * bookings and answers with times that will book. `spread` (the default)
   * is a few a day across the coming fortnight; `spread: false` with
   * `days: 1` is every free start on one day. `ignore` leaves the visit being
   * moved out of the conflicts.
   */
  findTimes(p: {
    duration: number;
    staffId?: string;
    patientId?: string;
    operatoryId?: string;
    preferOperatoryId?: string;
    ignore?: string;
    from?: string;
    days?: number;
    limit?: number;
    spread?: boolean;
  }) {
    const qs = new URLSearchParams({ duration: String(p.duration) });
    if (p.staffId) qs.set('staffId', p.staffId);
    if (p.patientId) qs.set('patientId', p.patientId);
    if (p.operatoryId) qs.set('operatoryId', p.operatoryId);
    if (p.preferOperatoryId) qs.set('preferOperatoryId', p.preferOperatoryId);
    if (p.ignore) qs.set('ignore', p.ignore);
    if (p.from) qs.set('from', p.from);
    if (p.days) qs.set('days', String(p.days));
    if (p.limit) qs.set('limit', String(p.limit));
    if (p.spread === false) qs.set('spread', '0');
    return request<FoundTimes>(`/appointments/find-times?${qs}`);
  },
  staff() {
    return request<StaffMember[]>('/staff');
  },
};

/* ── Operatories (treatment rooms) ───────────────────────── */
export const operatoriesApi = {
  list(includeInactive = false) {
    return request<Operatory[]>(
      `/operatories${includeInactive ? '?includeInactive=1' : ''}`,
    );
  },
  create(p: { name: string; description?: string; sortOrder?: number; color?: string }) {
    return request<Operatory>('/operatories', {
      method: 'POST',
      body: JSON.stringify(clean(p)),
    });
  },
  update(
    id: string,
    p: Partial<{
      name: string;
      description: string;
      sortOrder: number;
      color: string;
      isActive: boolean;
    }>,
  ) {
    return request<Operatory>(`/operatories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  remove(id: string) {
    return request<{
      deleted: boolean;
      deactivated: boolean;
      appointmentsUsingRoom?: number;
    }>(`/operatories/${id}`, { method: 'DELETE' });
  },
};

/* ── Staff availability (weekly schedule) ────────────────── */
export const availabilityApi = {
  /** Their own, or anyone's with availability:manage. null clears it. */
  setHomeRoom(staffId: string, operatoryId: string | null) {
    return request<{ staffId: string; homeOperatoryId: string | null }>(
      `/availability/home-room/${staffId}`,
      { method: 'PUT', body: JSON.stringify({ operatoryId }) },
    );
  },
  list(staffId?: string) {
    return request<AvailabilityEntry[]>(
      `/availability${staffId ? `?staffId=${staffId}` : ''}`,
    );
  },
  create(p: {
    staffId: string;
    weekday: number;
    startsAt: string;
    endsAt: string;
    operatoryId?: string;
  }) {
    return request<AvailabilityEntry>('/availability', {
      method: 'POST',
      body: JSON.stringify(clean(p)),
    });
  },
  update(
    id: string,
    p: Partial<{
      weekday: number;
      startsAt: string;
      endsAt: string;
      operatoryId: string | null;
    }>,
  ) {
    return request<AvailabilityEntry>(`/availability/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  remove(id: string) {
    return request<{ deleted: true }>(`/availability/${id}`, { method: 'DELETE' });
  },
};

/* ── Treatments & Medical record (M7) ───────────────────── */
export interface Treatment {
  id: string;
  name: string;
  price: number;
  durationMinutes: number;
  visitType: 'single' | 'multiple' | null;
  status: 'active' | 'inactive';
  /** TVSH: medical is exempt, cosmetic carries the clinic's VAT rate. */
  vatCategory: VatCategory;
}
export interface TreatmentPayload {
  name: string;
  price: number;
  durationMinutes: number;
  visitType: 'single' | 'multiple' | null;
  status?: 'active' | 'inactive';
  vatCategory?: VatCategory;
}
/* ── Clinical charting (Phase 4) ─────────────────────────── */

/**
 * These are the API's own vocabulary, so they come from @dentalcare/shared
 * rather than being restated here.
 *
 * They were restated here — a third copy, after the API's and the one in
 * lib/tooth-notation.ts. All three happened to agree, which is the luckier
 * failure mode: the surface codes and the condition list are what the API
 * validates a chart entry against, so a copy that fell behind would send a
 * clinician a rejection for a finding the UI had offered them.
 */
export {
  SURFACES,
  TOOTH_CONDITIONS,
  CONDITION_LABELS,
  WHOLE_TOOTH_CONDITIONS,
  type Surface,
  type ToothCondition,
} from '@dentalcare/shared';

export interface ToothConditionRecord {
  id: string;
  tooth: number;
  surface: Surface | null;
  condition: ToothCondition;
  status: 'active' | 'treated' | 'resolved';
  note: string | null;
  dentistId: string | null;
  dentistName: string | null;
  resolvedByProcedureId: string | null;
  recordedAt: string;
  updatedAt: string;
}

export interface ToothSummary {
  tooth: number;
  conditions: ToothConditionRecord[];
  activeConditions: ToothCondition[];
  surfaces: Partial<Record<Surface, ToothCondition[]>>;
  isAbsent: boolean;
}

export interface DentalChart {
  patientId: string;
  conditions: ToothConditionRecord[];
  teeth: ToothSummary[];
  summary: {
    total: number;
    active: number;
    activeCaries: number;
    teethCharted: number;
  };
}

export interface ProcedureCode {
  id: string;
  system: 'CDT' | 'ICD10' | 'custom';
  code: string;
  description: string;
  defaultFee: number;
  treatmentId: string | null;
  isActive: boolean;
}

export interface ClinicalProcedure {
  id: string;
  tooth: number | null;
  surfaces: Surface[];
  description: string;
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled';
  fee: number;
  performedOn: string;
  note: string | null;
  clinicianId?: string | null;
  clinicianName: string | null;
  code: string | null;
  codeSystem: string | null;
  diagnosisCode?: string | null;
  diagnosisSystem?: string | null;
  planItemId?: string | null;
  appointmentId?: string | null;
  /** 'clinician' today; 'import' and 'ai_suggestion' are reserved for provenance. */
  source?: string;
  /** Set once signed. A signed procedure cannot be edited, only withdrawn. */
  signedAt?: string | null;
  signedByName?: string | null;
}

export const chartApi = {
  get(patientId: string) {
    return request<DentalChart>(`/patients/${patientId}/chart`);
  },
  addCondition(
    patientId: string,
    p: {
      tooth: number;
      surface?: Surface;
      condition: ToothCondition;
      status?: 'active' | 'treated' | 'resolved';
      dentistId?: string;
      note?: string;
    },
  ) {
    return request<ToothConditionRecord>(`/patients/${patientId}/chart/conditions`, {
      method: 'POST',
      body: JSON.stringify(clean(p)),
    });
  },
  updateCondition(
    id: string,
    p: Partial<{
      status: 'active' | 'treated' | 'resolved';
      note: string;
      dentistId: string;
    }>,
  ) {
    return request<ToothConditionRecord>(`/tooth-conditions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  /** Findings are never deleted; a wrong one is withdrawn with a reason. */
  withdrawCondition(id: string, reason: string) {
    return request<{ withdrawn: true }>(
      `/tooth-conditions/${id}/entered-in-error`,
      withdrawal(reason),
    );
  },
};

export const procedureCodesApi = {
  list(params: { system?: string; q?: string; includeInactive?: boolean } = {}) {
    const qs = new URLSearchParams();
    if (params.system) qs.set('system', params.system);
    if (params.q) qs.set('q', params.q);
    if (params.includeInactive) qs.set('includeInactive', '1');
    const s = qs.toString();
    return request<ProcedureCode[]>(`/procedure-codes${s ? `?${s}` : ''}`);
  },
  create(p: {
    system: 'CDT' | 'ICD10' | 'custom';
    code: string;
    description: string;
    defaultFee?: number;
    treatmentId?: string;
  }) {
    return request<ProcedureCode>('/procedure-codes', {
      method: 'POST',
      body: JSON.stringify(clean(p)),
    });
  },
  update(
    id: string,
    p: Partial<{
      code: string;
      description: string;
      defaultFee: number;
      treatmentId: string | null;
      isActive: boolean;
    }>,
  ) {
    return request<ProcedureCode>(`/procedure-codes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  remove(id: string) {
    return request<{ deleted: boolean; deactivated: boolean; usedBy?: number }>(
      `/procedure-codes/${id}`,
      { method: 'DELETE' },
    );
  },
};

export const proceduresApi = {
  list(patientId: string) {
    return request<ClinicalProcedure[]>(`/patients/${patientId}/procedures`);
  },
  log(
    patientId: string,
    p: {
      tooth?: number;
      surfaces?: Surface[];
      procedureCodeId?: string;
      diagnosisCodeId?: string;
      treatmentId?: string;
      planItemId?: string;
      appointmentId?: string;
      description: string;
      clinicianId?: string;
      status?: 'planned' | 'in_progress' | 'completed' | 'cancelled';
      fee?: number;
      performedOn?: string;
      note?: string;
      resolvesConditionIds?: string[];
    },
  ) {
    return request<ClinicalProcedure>(`/patients/${patientId}/procedures`, {
      method: 'POST',
      body: JSON.stringify(clean(p)),
    });
  },
  update(
    id: string,
    p: Partial<{
      description: string;
      status: string;
      fee: number;
      performedOn: string;
      clinicianId: string | null;
      note: string;
    }>,
  ) {
    return request<ClinicalProcedure>(`/procedures/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  /** Final: the database refuses every edit to a signed procedure. */
  sign(id: string) {
    return request<ClinicalProcedure>(`/procedures/${id}/sign`, { method: 'POST' });
  },
  withdraw(id: string, reason: string) {
    return request<{ withdrawn: true }>(
      `/procedures/${id}/entered-in-error`,
      withdrawal(reason),
    );
  },
};

/* ── Perio charting ──────────────────────────────────────── */

// Six probing sites per tooth, in charting order. From the shared package:
// the API validates against exactly this list.
export { PERIO_SITES, type PerioSite } from '@dentalcare/shared';

export interface PerioMeasurement {
  id: string;
  tooth: number;
  site: PerioSite;
  probingDepth: number | null;
  recession: number | null;
  bleeding: boolean;
  suppuration: boolean;
  plaque: boolean;
  attachmentLoss: number | null;
}

export interface PerioToothFinding {
  id: string;
  tooth: number;
  mobility: number | null;
  furcation: number | null;
  note: string | null;
}

export interface PerioExamSummary {
  id: string;
  patientId: string;
  examinedOn: string;
  clinicianId: string | null;
  clinicianName: string | null;
  note: string | null;
  createdAt: string;
  signedAt: string | null;
  signedByName: string | null;
  siteCount: number;
  bleedingCount: number;
  bleedingPercent: number;
}

export interface PerioExam {
  id: string;
  patientId: string;
  examinedOn: string;
  clinicianId: string | null;
  clinicianName: string | null;
  note: string | null;
  createdAt: string;
  /** Set once signed. A signed exam's readings are locked by the database. */
  signedAt: string | null;
  signedByName: string | null;
  measurements: PerioMeasurement[];
  findings: PerioToothFinding[];
  summary: {
    sitesRecorded: number;
    bleedingSites: number;
    suppurationSites: number;
    plaqueSites: number;
    bleedingPercent: number;
    deepPocketSites: number;
    maxProbingDepth: number | null;
    meanProbingDepth: number | null;
    teethWithMobility: number;
  };
}

export const perioApi = {
  listExams(patientId: string) {
    return request<PerioExamSummary[]>(`/patients/${patientId}/perio-exams`);
  },
  createExam(
    patientId: string,
    p: { examinedOn?: string; clinicianId?: string; note?: string } = {},
  ) {
    return request<PerioExam>(`/patients/${patientId}/perio-exams`, {
      method: 'POST',
      body: JSON.stringify(clean(p)),
    });
  },
  getExam(examId: string) {
    return request<PerioExam>(`/perio-exams/${examId}`);
  },
  /** Bulk upsert — a full-mouth chart is one request, not 192. */
  saveMeasurements(
    examId: string,
    body: {
      measurements: {
        tooth: number;
        site: PerioSite;
        probingDepth?: number | null;
        recession?: number | null;
        bleeding?: boolean;
        suppuration?: boolean;
        plaque?: boolean;
      }[];
      findings?: {
        tooth: number;
        mobility?: number | null;
        furcation?: number | null;
        note?: string;
      }[];
    },
  ) {
    return request<PerioExam>(`/perio-exams/${examId}/measurements`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  signExam(examId: string) {
    return request<PerioExam>(`/perio-exams/${examId}/sign`, { method: 'POST' });
  },
  withdrawExam(examId: string, reason: string) {
    return request<{ withdrawn: true }>(
      `/perio-exams/${examId}/entered-in-error`,
      withdrawal(reason),
    );
  },
};

/* ── Treatment plans ─────────────────────────────────────── */

export const PLAN_STATUSES = [
  'draft',
  'proposed',
  'accepted',
  'in_progress',
  'completed',
  'declined',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: 'Draft',
  proposed: 'Proposed',
  accepted: 'Accepted',
  in_progress: 'In progress',
  completed: 'Completed',
  declined: 'Declined',
};

export interface PlanItem {
  id: string;
  tooth: number | null;
  surfaces: Surface[];
  procedureCodeId: string | null;
  code: string | null;
  codeSystem: string | null;
  treatmentId: string | null;
  description: string;
  quantity: number;
  unitFee: number;
  discountAmount: number;
  status: 'planned' | 'scheduled' | 'completed' | 'cancelled';
  sortOrder: number;
  note: string | null;
  subtotal: number;
  total: number;
}

export interface PlanCost {
  subtotal: number;
  lineDiscounts: number;
  planDiscount: number;
  totalDiscount: number;
  total: number;
  completedTotal: number;
  remainingTotal: number;
  lineCount: number;
  completedLineCount: number;
  cancelledLineCount: number;
}

export interface TreatmentPlan {
  id: string;
  patientId: string;
  patientName: string;
  title: string;
  status: PlanStatus;
  note: string | null;
  discountAmount: number;
  proposedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  completedAt: string | null;
  dentistId: string | null;
  dentistName: string | null;
  createdAt: string;
  updatedAt: string;
  items: PlanItem[];
  cost: PlanCost;
  allowedTransitions: PlanStatus[];
}

export interface Estimate {
  clinic: {
    name: string;
    legalName: string | null;
    nipt: string | null;
    address: string | null;
    city: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    brandColor: string | null;
    logoUrl: string | null;
  };
  patient: { id: string; name: string; phone: string | null; dateOfBirth: string | null };
  plan: {
    id: string;
    title: string;
    status: PlanStatus;
    note: string | null;
    dentistName: string | null;
    createdAt: string;
    acceptedAt: string | null;
  };
  issuedOn: string;
  validUntil: string;
  currency: CurrencyCode;
  quote: {
    currency: CurrencyCode;
    rate: number;
    source: 'live' | 'fixed';
    provider: string | null;
    asOf: string;
    stale: boolean;
  } | null;
  items: {
    description: string;
    code: string | null;
    tooth: number | null;
    status: string;
    quantity: number;
    unitPrice: number;
    discountAmount: number;
    vatCategory: VatCategory;
    taxRateBp: number;
    net: number;
    taxAmount: number;
    total: number;
    totalQuote: number | null;
  }[];
  vat: VatGroup[];
  totals: {
    subtotal: number;
    discount: number;
    net: number;
    tax: number;
    total: number;
    netQuote: number | null;
    taxQuote: number | null;
    totalQuote: number | null;
  };
}

export const estimatesApi = {
  /** currency: a code for a second currency, 'none' for none, omitted for the clinic's default. */
  forPlan(planId: string, currency?: CurrencyCode | 'none') {
    return request<Estimate>(
      `/treatment-plans/${planId}/estimate${currency ? `?currency=${currency}` : ''}`,
    );
  },
};

export const treatmentPlansApi = {
  listForPatient(patientId: string, status?: PlanStatus) {
    const s = status ? `?status=${status}` : '';
    return request<TreatmentPlan[]>(`/patients/${patientId}/treatment-plans${s}`);
  },
  create(
    patientId: string,
    p: {
      title: string;
      note?: string;
      dentistId?: string;
      discountAmount?: number;
    },
  ) {
    return request<TreatmentPlan>(`/patients/${patientId}/treatment-plans`, {
      method: 'POST',
      body: JSON.stringify(clean(p)),
    });
  },
  get(id: string) {
    return request<TreatmentPlan>(`/treatment-plans/${id}`);
  },
  update(
    id: string,
    p: Partial<{
      title: string;
      note: string;
      dentistId: string | null;
      discountAmount: number;
    }>,
  ) {
    return request<TreatmentPlan>(`/treatment-plans/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  transition(id: string, status: PlanStatus, reason?: string) {
    return request<TreatmentPlan>(`/treatment-plans/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, reason }),
    });
  },
  remove(id: string) {
    return request<{ deleted: true }>(`/treatment-plans/${id}`, { method: 'DELETE' });
  },
  addItem(
    planId: string,
    p: {
      tooth?: number;
      surfaces?: Surface[];
      procedureCodeId?: string;
      treatmentId?: string;
      description: string;
      quantity?: number;
      unitFee?: number;
      discountAmount?: number;
      sortOrder?: number;
      note?: string;
    },
  ) {
    return request<PlanItem>(`/treatment-plans/${planId}/items`, {
      method: 'POST',
      body: JSON.stringify(clean(p)),
    });
  },
  updateItem(
    itemId: string,
    p: Partial<{
      tooth: number;
      surfaces: Surface[];
      description: string;
      quantity: number;
      unitFee: number;
      discountAmount: number;
      sortOrder: number;
      status: 'planned' | 'scheduled' | 'completed' | 'cancelled';
      note: string;
    }>,
  ) {
    return request<PlanItem>(`/treatment-plan-items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  removeItem(itemId: string) {
    return request<{ deleted: true }>(`/treatment-plan-items/${itemId}`, {
      method: 'DELETE',
    });
  },
};

export const treatmentsApi = {
  list(params: { q?: string; status?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.status && params.status !== 'all') qs.set('status', params.status);
    const s = qs.toString();
    return request<Treatment[]>(`/treatments${s ? `?${s}` : ''}`);
  },
  create(p: TreatmentPayload) {
    return request<Treatment>('/treatments', { method: 'POST', body: JSON.stringify(p) });
  },
  update(id: string, p: Partial<TreatmentPayload>) {
    return request<Treatment>(`/treatments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
};

/* ── Staff management + Settings (correction pass) ───────── */
export interface StaffFull {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  status: 'active' | 'disabled';
  position: string | null;
  /** Has a calendar column, a weekly schedule and appointments in their name. */
  seesPatients: boolean;
  /** Present only for whoever manages staff. */
  twoStepEnabled?: boolean;
  fiscalOperatorCode?: string | null;
  createdAt: string;
}
export interface SalaryPayment {
  id: string;
  staffName: string;
  position: string | null;
  amount: number;
  paidOn: string;
  note: string | null;
}
export const staffApi = {
  list() {
    return request<StaffFull[]>('/staff');
  },
  create(p: {
    fullName: string;
    email: string;
    password: string;
    role: Role;
    position?: string;
    seesPatients?: boolean;
  }) {
    return request<StaffFull>('/staff', { method: 'POST', body: JSON.stringify(p) });
  },
  update(
    id: string,
    p: {
      fullName?: string;
      role?: Role;
      status?: 'active' | 'disabled';
      position?: string | null;
      seesPatients?: boolean;
    },
  ) {
    return request<StaffFull>(`/staff/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  resetPassword(staffId: string, password: string) {
    return request<{ reset: true }>(`/staff/${staffId}/password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  /** Lost phone and recovery codes. Never allowed on your own account. */
  resetMfa(staffId: string) {
    return request<{ reset: true; hadFactor: boolean }>(`/staff/${staffId}/mfa/reset`, {
      method: 'POST',
    });
  },
  recordSalaryPayment(
    staffId: string,
    p: { amount: number; paidOn?: string; note?: string },
    idempotencyKey: string,
  ) {
    return request<SalaryPayment>(`/staff/${staffId}/salary-payments`, {
      method: 'POST',
      body: JSON.stringify(p),
      headers: idempotent(idempotencyKey),
    });
  },
  salaryPayments() {
    return request<SalaryPayment[]>('/staff/salary-payments');
  },
};

// day is 0 = Monday. See the note in @dentalcare/shared/api-types.
export { type WorkingDay } from '@dentalcare/shared';
export interface ClinicSettings {
  clinicName: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  workingHours: WorkingDay[];
  defaultAppointmentDuration: number;
  remindersEnabled: boolean;
  reminderHoursBefore: number;
  payrollLoggingEnabled: boolean;
  /** Two-step sign-in for every role, not only administrators. */
  mfaRequiredForAll: boolean;
  /** Fixed once the clinic records its first price or payment. */
  currency: CurrencyCode;
  /** IANA zone reminders are written in. */
  timezone: string;
  reminderLocale: ReminderLocale;
  /** The clinic's own wording, or null for the built-in message. */
  reminderTemplate: string | null;
  /** For numbers written the local way ("069 …"), without + or 00. */
  phoneCountryCode: string;
  /** The clinic's default automatic-reminder channel. */
  reminderChannel: ReminderChannelId;
  legalName: string | null;
  registrationNumber: string | null;
  /** NIPT. */
  taxNumber: string | null;
  website: string | null;
  brandColor: string | null;
  /** Short-lived signed link; read-only. */
  logoUrl: string | null;
  logoUpdatedAt: string | null;
  invoicePrefix: string;
  /** Basis points: 2000 is 20%. */
  vatRateBp: number;
  paymentTermsDays: number;
  paymentMethods: ClinicPaymentMethod[];
  /** Second currency printed on estimates, or null for none. */
  quoteCurrency: CurrencyCode | null;
  fxRateSource: 'live' | 'fixed';
  /** Clinic-currency units per ONE quote-currency unit, when fixed. */
  fxFixedRate: number | null;
  /** What the payment screen preselects when money is taken (API 0015). */
  defaultCheckoutMode: 'internal' | 'fiscal' | 'ask';
  /** Off for a clinic that fiscalizes everything: the option disappears. */
  internalReceiptsEnabled: boolean;
}

export interface ClinicPaymentMethod {
  id: string;
  label: string;
  kind: PaymentMethod;
  active: boolean;
}

/** Everything settings accepts; logoUrl and logoUpdatedAt are not settable. */
export type SettingsPayload = Partial<Omit<ClinicSettings, 'logoUrl' | 'logoUpdatedAt'>>;

export const settingsApi = {
  get() {
    return request<ClinicSettings>('/settings');
  },
  update(p: SettingsPayload) {
    return request<ClinicSettings>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  /** A JPEG the browser has already resized onto white. */
  uploadLogo(image: Blob) {
    const form = new FormData();
    form.append('file', image, 'logo.jpg');
    return upload<ClinicSettings>('/settings/logo', form);
  },
  removeLogo() {
    return request<ClinicSettings>('/settings/logo', { method: 'DELETE' });
  },
};

/* ── Fiscalization (Albania) ─────────────────────────────── */

export interface FiscalSettings {
  /** The deployment has a software code; without it nothing can be registered. */
  available: boolean;
  enabled: boolean;
  environment: 'test' | 'production';
  businessUnitCode: string | null;
  tcrCode: string | null;
  isIssuerInVat: boolean;
  vatExemptionCode: string;
  certificate: { subject: string | null; notAfter: string | null } | null;
  seller: {
    nipt: string | null;
    niptValid: boolean;
    name: string;
    address: string | null;
    town: string | null;
    currency: string;
  };
  operators: {
    userId: string;
    fullName: string;
    role: Role;
    operatorCode: string | null;
  }[];
}

export interface FiscalRecord {
  id: string;
  invoiceId: string;
  status: 'pending' | 'fiscalized' | 'rejected';
  environment: 'test' | 'production';
  typeOfInvoice: 'CASH' | 'NONCASH';
  businessUnitCode: string;
  tcrCode: string;
  operatorCode: string;
  softwareCode: string;
  invOrdNum: number;
  invNum: string;
  issueDateTime: string;
  /** Issuer Security Code (IIC). */
  nslf: string;
  /** Fiscal Identification Code (FIC), once the authority confirms. */
  nivf: string | null;
  qrUrl: string;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  fiscalizedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}

export interface FiscalReceipt {
  environment: 'test' | 'production';
  status: FiscalRecord['status'];
  seller: {
    name: string;
    nipt: string;
    address: string;
    town: string;
    phone: string | null;
    email: string | null;
  };
  invoiceNumber: string;
  buyerName: string;
  fiscal: FiscalRecord;
  cashier: { name: string | null; operatorCode: string };
  isIssuerInVat: boolean;
  vatExemptionCode: string;
  currency: 'ALL';
  items: {
    name: string;
    code: string | null;
    unit: string;
    quantity: number;
    unitPrice: number;
    discountAmount: number;
    taxRateBp: number;
    taxAmount: number;
    total: number;
  }[];
  vat: VatGroup[];
  totals: { net: number; vat: number; total: number };
  payments: { type: 'BANKNOTE' | 'CARD' | 'ACCOUNT'; amount: number }[];
}

export interface CashDeposit {
  id: string;
  operation: 'INITIAL' | 'WITHDRAW';
  amount: number;
  changeDateTime: string;
  status: 'registered' | 'rejected' | 'unreachable';
  fcdc: string | null;
  error: string | null;
  createdAt: string;
}

export const fiscalApi = {
  settings() {
    return request<FiscalSettings>('/fiscal/settings');
  },
  update(
    p: Partial<
      Pick<
        FiscalSettings,
        | 'enabled'
        | 'environment'
        | 'businessUnitCode'
        | 'tcrCode'
        | 'isIssuerInVat'
        | 'vatExemptionCode'
      >
    >,
  ) {
    return request<FiscalSettings>('/fiscal/settings', {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  installCertificate(pem: string) {
    return request<FiscalSettings>('/fiscal/certificate', {
      method: 'POST',
      body: JSON.stringify({ pem }),
    });
  },
  /** The .p12/.pfx as issued. The password opens it on the server and is not kept. */
  installCertificateFile(p12Base64: string, password: string) {
    return request<FiscalSettings>('/fiscal/certificate', {
      method: 'POST',
      body: JSON.stringify({ p12Base64, password }),
    });
  },
  setOperatorCode(userId: string, operatorCode: string | null) {
    return request<FiscalSettings>(`/fiscal/operators/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ operatorCode }),
    });
  },
  cashDeposits() {
    return request<CashDeposit[]>('/fiscal/cash-deposits');
  },
  registerCashDeposit(
    p: { operation: 'INITIAL' | 'WITHDRAW'; amount: number },
    idempotencyKey: string,
  ) {
    return request<CashDeposit>('/fiscal/cash-deposits', {
      method: 'POST',
      body: JSON.stringify(p),
      headers: idempotent(idempotencyKey),
    });
  },
  forInvoice(invoiceId: string) {
    return request<FiscalRecord | null>(`/invoices/${invoiceId}/fiscal`);
  },
  /** The printable receipt, built from what the tax authority received. */
  receipt(invoiceId: string) {
    return request<FiscalReceipt>(`/invoices/${invoiceId}/fiscal/receipt`);
  },
  fiscalize(invoiceId: string, idempotencyKey: string) {
    return request<FiscalRecord>(`/invoices/${invoiceId}/fiscal`, {
      method: 'POST',
      headers: idempotent(idempotencyKey),
    });
  },
  /** Everything still owed to the tax authority, with the 48-hour clock. */
  queue() {
    return request<FiscalQueue>('/fiscal/queue');
  },
  retry(id: string, idempotencyKey: string) {
    return request<FiscalRecord>(`/fiscal/queue/${id}/retry`, {
      method: 'POST',
      headers: idempotent(idempotencyKey),
    });
  },
};

export type QueueUrgency = 'routine' | 'watch' | 'urgent' | 'overdue';

export interface FiscalQueueItem {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  patientName: string;
  status: 'pending' | 'rejected';
  environment: 'test' | 'production';
  total: number;
  issueDateTime: string;
  nslf: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  ageMs: number;
  /** The 48-hour limit for a subsequent delivery. */
  deliverBy: string;
  msLeft: number;
  overdue: boolean;
  urgency: QueueUrgency;
}

export interface FiscalQueue {
  items: FiscalQueueItem[];
  counts: { pending: number; rejected: number; overdue: number; urgent: number };
}

/* ── Patient import ──────────────────────────────────────── */

export interface ImportRowResult {
  row: number;
  status: 'valid' | 'invalid' | 'duplicate';
  name: string;
  errors: ImportIssue[];
  duplicateOf:
    | { kind: 'file'; row: number }
    | { kind: 'patient'; patientId: string; name: string; match: 'nationalId' | 'phone' }
    | null;
  patientId?: string | null;
}

export interface ImportBatch {
  fileName: string;
  sourceLabel?: string;
  dateFormat: ImportDateFormat;
  skipDuplicates: boolean;
  rowOffset: number;
  rows: Record<string, string>[];
}

export interface ImportRecord {
  id: string;
  fileName: string;
  sourceLabel: string | null;
  rowsReceived: number;
  rowsImported: number;
  rowsSkipped: number;
  balancesTotal: number;
  createdAt: string;
  createdByName: string | null;
}

export const patientImportApi = {
  list() {
    return request<ImportRecord[]>('/patient-imports');
  },
  preview(batch: ImportBatch) {
    return request<{
      valid: number;
      invalid: number;
      duplicates: number;
      rows: ImportRowResult[];
    }>('/patient-imports/preview', { method: 'POST', body: JSON.stringify(batch) });
  },
  commit(batch: ImportBatch, idempotencyKey: string) {
    return request<{
      importId: string;
      imported: number;
      skipped: number;
      rows: ImportRowResult[];
    }>('/patient-imports', {
      method: 'POST',
      body: JSON.stringify(batch),
      headers: idempotent(idempotencyKey),
    });
  },
};

/* ── Finance (M8) ───────────────────────────────────────── */
export type InvoiceStatus = 'unpaid' | 'partially_paid' | 'paid' | 'cancelled';
export type PaymentMethod = 'cash' | 'card' | 'bank';
export type ExpenseCategory =
  'rent' | 'materials' | 'utilities' | 'salaries' | 'lab' | 'other';

/**
 * Which document a payment issued: `fiscal` (faturë e fiskalizuar, registered
 * with the tax authority) or `internal` (faturë fiktive, the clinic's own
 * receipt). The intent; `FiscalRecord` says what the authority did with it.
 */
export type InvoiceDocumentKind = 'internal' | 'fiscal';

export interface InvoiceSummaryRow {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  /** What the clinic meant to issue with it. */
  documentKind: InvoiceDocumentKind;
  total: number;
  /** TVSH included in the total. */
  taxAmount: number;
  currency: CurrencyCode;
  paid: number;
  balance: number;
  issuedAt: string;
  patientId: string;
  patientName: string;
}
export interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  /** Basis points; 0 is TVSH-exempt. */
  taxRateBp: number;
  taxAmount: number;
  /** Including TVSH. */
  amount: number;
  treatmentId: string | null;
  treatmentName: string | null;
}
/**
 * Money is never deleted — migration 0018 revoked DELETE from the database
 * role outright. A mistake is voided: the original row stays exactly as it was
 * taken and gains who reversed it, when, and why. Anything carrying these
 * three fields must render the voided state rather than filter it out;
 * hiding it would defeat the point of keeping it.
 */
export interface Voidable {
  voidedAt: string | null;
  voidReason: string | null;
  voidedByName: string | null;
}

export interface InvoicePayment extends Voidable {
  id: string;
  amount: number;
  method: PaymentMethod;
  /** The clinic's own name for the method, when it has one. */
  methodLabel: string | null;
  note: string | null;
  paidAt: string;
  recordedBy: string | null;
}
export interface InvoiceDetail extends InvoiceSummaryRow {
  items: InvoiceItem[];
  payments: InvoicePayment[];
}
export interface LineItemPayload {
  treatmentId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  /** Omitted: the treatment's category, or medical for a custom line. */
  vatCategory?: VatCategory;
  /** The charted procedure this line bills; the server checks it is unbilled. */
  procedureId?: string;
}

export interface RecallPatient {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  lastVisit: string;
  lastReason: string | null;
  lastDentist: string | null;
}

/** Completed chart work no invoice covers yet — what a new invoice starts with. */
export interface UnbilledProcedure {
  procedureId: string;
  tooth: number | null;
  description: string;
  /** Minor units. */
  fee: number;
  performedOn: string;
  treatmentId: string | null;
  vatCategory: VatCategory;
  clinicianName: string | null;
}
export interface PaymentHistoryRow extends Voidable {
  id: string;
  amount: number;
  method: PaymentMethod;
  methodLabel: string | null;
  note: string | null;
  paidAt: string;
  invoiceId: string;
  invoiceNumber: string;
  patientName: string;
}
export interface ExpenseRow extends Voidable {
  id: string;
  category: ExpenseCategory;
  amount: number;
  expenseDate: string;
  note: string | null;
}
/**
 * The API shapes this by permission: `outstanding` is always returned (the
 * front desk needs it to chase payments), while the aggregate view — revenue
 * against expenses — is withheld unless the caller holds reports:read. The
 * optional fields are absent, not zero, for Reception.
 */
export interface FinanceSummary {
  period: 'today' | 'month' | 'all';
  outstanding: number;
  totalInvoiced?: number;
  totalCollected?: number;
  totalExpenses?: number;
}

export interface CheckoutResult extends InvoiceSummaryRow {
  /** The registration, when this payment issued a fiscal invoice. */
  fiscal: FiscalRecord | null;
  /** Why it could not be registered, with the payment already recorded. */
  fiscalError: string | null;
}

export const financeApi = {
  /** `status: 'open'` is unpaid and partially paid together. */
  listInvoices(params: { q?: string; status?: string; patientId?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.status && params.status !== 'all') qs.set('status', params.status);
    if (params.patientId) qs.set('patientId', params.patientId);
    const s = qs.toString();
    return request<InvoiceSummaryRow[]>(`/invoices${s ? `?${s}` : ''}`);
  },
  getInvoice(id: string) {
    return request<InvoiceDetail>(`/invoices/${id}`);
  },
  unbilled(patientId: string) {
    return request<UnbilledProcedure[]>(
      `/invoices/unbilled?patientId=${encodeURIComponent(patientId)}`,
    );
  },
  createInvoice(
    p: { patientId: string; issuedAt?: string; items: LineItemPayload[] },
    idempotencyKey: string,
  ) {
    return request<InvoiceSummaryRow>('/invoices', {
      method: 'POST',
      body: JSON.stringify(p),
      headers: idempotent(idempotencyKey),
    });
  },
  cancelInvoice(id: string, idempotencyKey: string) {
    return request<InvoiceSummaryRow>(`/invoices/${id}/cancel`, {
      method: 'PATCH',
      headers: idempotent(idempotencyKey),
    });
  },
  /** The printable invoice, fetched with the session so it can be opened as a Blob URL. */
  invoicePdf(id: string) {
    return fetchBlob(`/invoices/${id}/pdf`);
  },
  /**
   * Take a payment and issue its document.
   *
   * `document: 'fiscal'` registers the invoice with the tax authority right
   * after the money is recorded. The payment is committed first, so a refusal
   * or an unreachable CIS comes back as `fiscalError` with the payment
   * already taken — never as a failed payment.
   */
  recordPayment(
    invoiceId: string,
    p: {
      amount: number;
      method?: PaymentMethod;
      methodId?: string;
      note?: string;
      document?: InvoiceDocumentKind;
    },
    idempotencyKey: string,
  ) {
    return request<CheckoutResult>(`/invoices/${invoiceId}/payments`, {
      method: 'POST',
      body: JSON.stringify(p),
      headers: idempotent(idempotencyKey),
    });
  },
  listPayments() {
    return request<PaymentHistoryRow[]>('/payments');
  },
  listExpenses(category?: string) {
    const s = category && category !== 'all' ? `?category=${category}` : '';
    return request<ExpenseRow[]>(`/expenses${s}`);
  },
  createExpense(
    p: {
      category: ExpenseCategory;
      amount: number;
      expenseDate?: string;
      note?: string;
    },
    idempotencyKey: string,
  ) {
    return request<ExpenseRow>('/expenses', {
      method: 'POST',
      body: JSON.stringify(p),
      headers: idempotent(idempotencyKey),
    });
  },
  voidExpense(id: string, reason: string, idempotencyKey: string) {
    return request<{ voided: true }>(`/expenses/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
      headers: idempotent(idempotencyKey),
    });
  },
  voidPayment(id: string, reason: string, idempotencyKey: string) {
    return request<InvoiceSummaryRow>(`/payments/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
      headers: idempotent(idempotencyKey),
    });
  },
  summary(period: 'today' | 'month' | 'all' = 'month') {
    return request<FinanceSummary>(`/finance/summary?period=${period}`);
  },
};

/* ── Activity trail (requires audit:read — the doctor only) ─ */
export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  /** One readable line, written by the API at the moment of the action. */
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  actor: {
    userId: string | null;
    /** Email, snapshotted when it happened — survives the account going away. */
    label: string;
    /** Role AT THE TIME, not the actor's role today. */
    role: string;
    currentName: string | null;
  };
}

export interface AuditFilter {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export const auditApi = {
  list(f: AuditFilter = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
      if (v !== undefined && v !== '' && v !== 'all') qs.set(k, String(v));
    }
    const s = qs.toString();
    return request<{ items: AuditEntry[]; total: number }>(`/audit${s ? `?${s}` : ''}`);
  },
  actions() {
    return request<{ actions: string[] }>('/audit/actions');
  },
};

/* ── Reports (requires reports:read) ─────────────────────── */
export interface ReportBreakdownRow {
  label: string;
  value: number;
}
export interface ReportDentistRow {
  label: string;
  total: number;
  completed: number;
}
export interface ReportTrendPoint {
  month: string;
  collected: number;
  expenses: number;
  profit: number;
}
export interface ReportOverview {
  range: { from: string; to: string };
  totals: {
    invoiced: number;
    collected: number;
    expenses: number;
    profit: number;
    outstanding: number;
    newPatients: number;
    appointments: number;
    appointmentsCompleted: number;
    appointmentsCancelled: number;
    appointmentsNoShow: number;
  };
  monthlyTrend: ReportTrendPoint[];
  revenueByTreatment: ReportBreakdownRow[];
  expensesByCategory: ReportBreakdownRow[];
  paymentsByMethod: ReportBreakdownRow[];
  appointmentsByDentist: ReportDentistRow[];
  /** Completed treatment in the period, by service, counted. */
  treatmentsPerformed: ReportBreakdownRow[];
  /** Stock recorded as used in the period, by item. */
  consumption: (ReportBreakdownRow & { unit: string })[];
  /** Ordered and fitted in the period; open and late are as of now. */
  lab: { ordered: number; fitted: number; open: number; late: number; cost: number };
}

export interface VatBand {
  rateBp: number;
  net: number;
  vat: number;
  gross: number;
  invoices: number;
}

export interface VatReport {
  from: string;
  to: string;
  bands: VatBand[];
  totals: { net: number; vat: number; gross: number };
  documents: {
    documentKind: InvoiceDocumentKind;
    registered: boolean;
    net: number;
    vat: number;
    gross: number;
    invoices: number;
  }[];
}

export const reportsApi = {
  vat(from?: string, to?: string) {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const s = qs.toString();
    return request<VatReport>(`/reports/vat${s ? `?${s}` : ''}`);
  },
  overview(from?: string, to?: string) {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const s = qs.toString();
    return request<ReportOverview>(`/reports/overview${s ? `?${s}` : ''}`);
  },
};

/* ── Reminders (M10) ────────────────────────────────────── */
/**
 * pending   waiting for its first attempt, or for a retry
 * sending   an attempt is in flight (or was interrupted — check the provider)
 * sent      accepted by the provider, or handed off to WhatsApp / email
 * delivered the carrier confirmed it arrived
 * failed    refused, or out of attempts; `error` says why
 * skipped   deliberately not sent; `error` says why
 */
export type ReminderStatus =
  'pending' | 'sending' | 'sent' | 'delivered' | 'failed' | 'skipped';

export interface Reminder {
  id: string;
  /** Null for a message that is not about one appointment (a balance notice). */
  appointmentId: string | null;
  patientId: string;
  purpose: MessagePurpose;
  invoiceId: string | null;
  /** Who sent it; null for an automatic reminder. */
  sentByName: string | null;
  type: 'automatic' | 'manual';
  /** 'sms' | 'log' | 'whatsapp' | 'email' */
  channel: string;
  status: ReminderStatus;
  message: string;
  error: string | null;
  errorCode: string | null;
  toAddress: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  providerStatus: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  patientName: string | null;
  appointmentStartsAt: string | null;
  appointmentReason: string | null;
}

export interface ReminderChannels {
  active: string;
  /** An SMS provider is configured for this deployment. */
  sms: boolean;
  /** WhatsApp Business is configured (approved sender and template). */
  whatsappBusiness: boolean;
  /** Viber Business Messages is configured. */
  viber: boolean;
  /** Delivery receipts come back, so "Delivered" means something. */
  deliveryReceipts: boolean;
}

export const remindersApi = {
  list(appointmentId?: string) {
    const s = appointmentId ? `?appointmentId=${appointmentId}` : '';
    return request<Reminder[]>(`/reminders${s}`);
  },
  channels() {
    return request<ReminderChannels>('/reminders/channels');
  },
  /**
   * 'sms' sends now through the provider. For 'whatsapp' and 'email' the
   * message is handed to the staff member's own app — the row is a hand-off
   * record, not proof of delivery.
   */
  sendManual(
    appointmentId: string,
    channel: 'sms' | 'log' | 'whatsapp' | 'email' = 'log',
  ) {
    return request<Reminder>(`/appointments/${appointmentId}/reminders`, {
      method: 'POST',
      body: JSON.stringify({ channel }),
    });
  },
};

/* ── Messages: one conversation per patient ─────────────── */

export type ConversationFilter = 'all' | 'whatsapp' | 'viber' | 'sms' | 'other';
export type SendChannel = 'sms' | 'whatsapp_business' | 'viber' | 'whatsapp' | 'log';

export interface Conversation {
  patientId: string;
  patientName: string;
  phone: string | null;
  preferredChannel: string | null;
  optedOut: boolean;
  messageCount: number;
  failedCount: number;
  last: {
    id: string;
    channel: string;
    status: ReminderStatus;
    purpose: MessagePurpose;
    message: string;
    createdAt: string;
  };
}

export interface MessageThread {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    e164: string | null;
    preferredChannel: string | null;
    optedOut: boolean;
    optOutSource: string | null;
  };
  clinic: {
    name: string;
    phone: string | null;
    address: string | null;
    locale: ReminderLocale;
    reminderTemplate: string | null;
    defaultChannel: string;
  };
  channels: {
    sms: boolean;
    whatsappBusiness: boolean;
    viber: boolean;
    whatsappPurposes: MessagePurpose[];
  };
  messages: Reminder[];
  context: {
    upcoming: {
      id: string;
      startsAt: string;
      reason: string | null;
      dentist: string | null;
      date: string;
      time: string;
    }[];
    visits: {
      id: string;
      startsAt: string;
      reason: string | null;
      dentist: string | null;
      visitDate: string;
    }[];
    latestVisit: { visitDate: string; dentist: string | null } | null;
    invoices: {
      id: string;
      invoiceNumber: string;
      issuedAt: string;
      balance: number;
      balanceText: string;
    }[];
    balance: number;
    balanceText: string;
    currency: CurrencyCode;
  };
}

export const messagesApi = {
  conversations(
    filter: { channel?: ConversationFilter; purpose?: MessagePurpose; q?: string } = {},
  ) {
    const params = new URLSearchParams();
    if (filter.channel && filter.channel !== 'all') params.set('channel', filter.channel);
    if (filter.purpose) params.set('purpose', filter.purpose);
    if (filter.q?.trim()) params.set('q', filter.q.trim());
    const qs = params.toString();
    return request<Conversation[]>(`/messages/conversations${qs ? `?${qs}` : ''}`);
  },
  thread(patientId: string) {
    return request<MessageThread>(`/patients/${patientId}/messages`);
  },
  /**
   * Sends now through the provider, or — for 'whatsapp' — returns a link that
   * opens the staff member's own WhatsApp with the text (a hand-off).
   */
  send(
    patientId: string,
    body: {
      purpose: MessagePurpose;
      channel: SendChannel;
      appointmentId?: string;
      invoiceId?: string;
    },
  ) {
    return request<{ message: Reminder; handoffUrl: string | null }>(
      `/patients/${patientId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  },
};

/* ── Billing, ledger and A/R (Phase 5) ───────────────────── */

export const LEDGER_ENTRY_TYPES = [
  'charge',
  'payment',
  'adjustment',
  'refund',
  'write_off',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const LEDGER_LABELS: Record<LedgerEntryType, string> = {
  charge: 'Invoice issued',
  payment: 'Payment received',
  adjustment: 'Adjustment',
  refund: 'Refund',
  write_off: 'Written off',
};

export interface LedgerEntry {
  id: string;
  entryType: LedgerEntryType;
  /** Signed: positive increases what the patient owes. */
  amount: number;
  currency: string;
  description: string;
  occurredOn: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  actorName: string | null;
  createdAt: string;
  balanceAfter: number;
}

export interface PatientLedger {
  patientId: string;
  entries: LedgerEntry[];
  balance: number;
  totalCharged: number;
  totalCredited: number;
}

export interface GeneratedInvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxRateBp: number;
  taxAmount: number;
  amount: number;
  tooth: number | null;
  code: string | null;
}

export interface GeneratedInvoice {
  id: string;
  invoiceNumber: string;
  patientId: string;
  patientName: string;
  treatmentPlanId: string | null;
  planTitle: string | null;
  status: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  currency: string;
  vatRateBp: number;
  issuedAt: string;
  dueOn: string | null;
  notes: string | null;
  paid: number;
  balance: number;
  items: GeneratedInvoiceLine[];
}

export interface AgeingBucket {
  key: 'current' | 'd31_60' | 'd61_90' | 'over_90';
  label: string;
  amount: number;
  count: number;
}

export interface ReceivableInvoice {
  invoiceId: string;
  invoiceNumber: string;
  patientId: string;
  patientName: string;
  total: number;
  paid: number;
  balance: number;
  issuedAt: string;
  dueOn: string | null;
  daysOutstanding: number;
  bucket: AgeingBucket['key'];
  currency: string;
}

export interface ReceivablesReport {
  totalOutstanding: number;
  invoiceCount: number;
  buckets: AgeingBucket[];
  invoices: ReceivableInvoice[];
}

export interface PatientBalance {
  patientId: string;
  patientName: string;
  balance: number;
  lastActivity: string;
}

export const billingApi = {
  /**
   * Bill a treatment plan. Only completed, not-yet-invoiced lines are taken
   * unless `completedOnly` is false — a clinic should not invoice work it has
   * not done.
   */
  generateFromPlan(
    planId: string,
    opts: {
      completedOnly?: boolean;
      issuedAt?: string;
      notes?: string;
    } = {},
    idempotencyKey: string,
  ) {
    return request<GeneratedInvoice>(`/treatment-plans/${planId}/invoice`, {
      method: 'POST',
      body: JSON.stringify(opts),
      headers: idempotent(idempotencyKey),
    });
  },
  ledger(patientId: string) {
    return request<PatientLedger>(`/patients/${patientId}/ledger`);
  },
  addAdjustment(
    patientId: string,
    p: {
      entryType: 'adjustment' | 'write_off' | 'refund';
      amount: number;
      description: string;
      occurredOn?: string;
    },
    idempotencyKey: string,
  ) {
    return request<PatientLedger>(`/patients/${patientId}/ledger/adjustments`, {
      method: 'POST',
      body: JSON.stringify(clean(p)),
      headers: idempotent(idempotencyKey),
    });
  },
  receivables() {
    return request<ReceivablesReport>('/billing/receivables');
  },
  balances() {
    return request<PatientBalance[]>('/billing/balances');
  },
};

/* ── Financial analytics (reports:read — admin only) ─────── */

export interface AnalyticsDashboard {
  from: string;
  to: string;
  billed: number;
  collected: number;
  expenses: number;
  netCollected: number;
  outstanding: number;
  collectionRate: number | null;
  invoiceCount: number;
  unpaidInvoiceCount: number;
  patientsSeen: number;
  proceduresDone: number;
}

export interface RevenuePoint {
  period: string;
  billed: number;
  collected: number;
  invoiceCount: number;
  paymentCount: number;
}

export interface RevenueReport {
  from: string;
  to: string;
  granularity: 'day' | 'month';
  series: RevenuePoint[];
  totals: {
    billed: number;
    collected: number;
    collectionRate: number | null;
    invoiceCount: number;
    paymentCount: number;
  };
}

/** One row of any breakdown; only the fields that dimension provides are set. */
export interface BreakdownRow {
  label?: string;
  clinicianId?: string | null;
  clinicianName?: string | null;
  operatoryId?: string | null;
  operatoryName?: string | null;
  code?: string | null;
  production: number;
  procedureCount: number;
  patientCount?: number;
  appointmentCount?: number;
  bookedMinutes?: number;
  bookedHours?: number;
  averageFee?: number;
}

export interface BreakdownReport {
  from: string;
  to: string;
  rows: BreakdownRow[];
}

const dateRange = (from?: string, to?: string) => {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const s = qs.toString();
  return s ? `?${s}` : '';
};

export const analyticsApi = {
  dashboard(from?: string, to?: string) {
    return request<AnalyticsDashboard>(`/analytics/dashboard${dateRange(from, to)}`);
  },
  revenue(granularity: 'day' | 'month', from?: string, to?: string) {
    const qs = new URLSearchParams({ granularity });
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return request<RevenueReport>(`/analytics/revenue?${qs}`);
  },
  byDentist(from?: string, to?: string) {
    return request<BreakdownReport>(`/analytics/by-dentist${dateRange(from, to)}`);
  },
  byOperatory(from?: string, to?: string) {
    return request<BreakdownReport>(`/analytics/by-operatory${dateRange(from, to)}`);
  },
  byProcedure(from?: string, to?: string) {
    return request<BreakdownReport>(`/analytics/by-procedure${dateRange(from, to)}`);
  },
};

/* ── Inventory ───────────────────────────────────────────── */

export type MovementKind = 'receipt' | 'usage' | 'adjustment' | 'write_off';

export interface InventoryItem {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  quantity: number;
  minimumQuantity: number;
  notes: string | null;
  status: 'active' | 'archived';
  /**
   * Resolved by the API, not recomputed here. The list, the dashboard badge
   * and the alerts endpoint have to agree about what "low" means, and the one
   * way to guarantee that is for only one of them to decide.
   */
  lowStock: boolean;
  outOfStock: boolean;
  /** Lot numbers and expiry dates are recorded for this item. */
  trackLots: boolean;
  expiryWarningDays: number;
  /** Earliest expiry among lots still holding stock. */
  nextExpiry: string | null;
  /** Resolved by the API against the database's date, like `lowStock`. */
  expiry: ExpiryState;
  /** Who it is reordered from (0020). */
  supplierId: string | null;
  supplierName: string | null;
  supplierPhone: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StockMovement {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  kind: MovementKind;
  /** Signed: negative for usage and write-offs. */
  quantityDelta: number;
  quantityAfter: number;
  reason: string | null;
  createdAt: string;
  actorName: string | null;
  lotId: string | null;
  lotNumber: string | null;
  patientId: string | null;
  patientName: string | null;
}

/** "none" — no expiry date; "expired" from the day after the date on the packet. */
export type ExpiryState = 'none' | 'ok' | 'expiring' | 'expired';

export interface InventoryLot {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  lotNumber: string;
  expiresOn: string | null;
  receivedOn: string;
  quantity: number;
  status: 'active' | 'recalled';
  recalledAt: string | null;
  recallReason: string | null;
  recalledByName: string | null;
  expiry: ExpiryState;
  createdAt: string;
}

export interface InventoryAlerts {
  items: InventoryItem[];
  lowCount: number;
  outOfStockCount: number;
  /** Active lots with stock inside their warning window, or past it. */
  expiringLots: InventoryLot[];
  expiringCount: number;
  expiredCount: number;
  /** Recalled lots somebody still has to take off the shelf. */
  recalledLots: InventoryLot[];
}

export interface LotUsage {
  lot: InventoryLot;
  uses: {
    id: string;
    createdAt: string;
    quantity: number;
    patientId: string | null;
    patientName: string | null;
    procedureId: string | null;
    procedureDescription: string | null;
    performedOn: string | null;
    actorName: string | null;
  }[];
  patientCount: number;
  /** Used from this lot with no patient recorded — the limit of a recall list. */
  unattributedQuantity: number;
}

export interface InventoryItemPayload {
  name: string;
  category?: string;
  unit: string;
  quantity?: number;
  minimumQuantity?: number;
  notes?: string;
  trackLots?: boolean;
  expiryWarningDays?: number;
  /** The lot of the opening stock, for a lot-tracked item. */
  lotNumber?: string;
  expiresOn?: string;
}

/**
 * A movement, in the clinic's own terms.
 *
 * `amount` is always positive — the kind decides the direction, so nobody has
 * to type a minus sign. An adjustment instead carries what was actually
 * counted, and the API works out the difference.
 */
export interface MovementPayload {
  kind: MovementKind;
  amount?: number;
  countedQuantity?: number;
  reason?: string;
  /** Lot-tracked items: an existing lot. Usage may leave it out (earliest expiry first). */
  lotId?: string;
  /** Lot-tracked receipts: the number on the packaging; a new one also takes expiresOn. */
  lotNumber?: string;
  expiresOn?: string;
  /** Usage only. */
  patientId?: string;
  procedureId?: string;
}

export const inventoryApi = {
  /** Who an item is reordered from; null for nobody. Reception may set it. */
  setSupplier(itemId: string, supplierId: string | null) {
    return request<InventoryItem>(`/inventory/${itemId}/supplier`, {
      method: 'PUT',
      body: JSON.stringify({ supplierId }),
    });
  },
  list(
    params: {
      q?: string;
      status?: string;
      category?: string;
      low?: boolean;
      expiring?: boolean;
    } = {},
  ) {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.status && params.status !== 'all') qs.set('status', params.status);
    if (params.category) qs.set('category', params.category);
    if (params.low) qs.set('low', '1');
    if (params.expiring) qs.set('expiring', '1');
    const s = qs.toString();
    return request<InventoryItem[]>(`/inventory${s ? `?${s}` : ''}`);
  },
  alerts() {
    return request<InventoryAlerts>('/inventory/alerts');
  },
  categories() {
    return request<string[]>('/inventory/categories');
  },
  recentMovements(limit = 100) {
    return request<StockMovement[]>(`/inventory/movements?limit=${limit}`);
  },
  get(id: string) {
    return request<InventoryItem>(`/inventory/${id}`);
  },
  create(p: InventoryItemPayload) {
    return request<InventoryItem>('/inventory', {
      method: 'POST',
      body: JSON.stringify(p),
    });
  },
  update(
    id: string,
    p: Partial<InventoryItemPayload> & { status?: 'active' | 'archived' },
  ) {
    return request<InventoryItem>(`/inventory/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  movements(itemId: string, limit = 100) {
    return request<StockMovement[]>(`/inventory/${itemId}/movements?limit=${limit}`);
  },
  recordMovement(itemId: string, p: MovementPayload) {
    return request<{ item: InventoryItem; movement: StockMovement }>(
      `/inventory/${itemId}/movements`,
      { method: 'POST', body: JSON.stringify(p) },
    );
  },
  lots(itemId: string) {
    return request<InventoryLot[]>(`/inventory/${itemId}/lots`);
  },
  lotUsage(lotId: string) {
    return request<LotUsage>(`/inventory/lots/${lotId}/usage`);
  },
  recallLot(lotId: string, reason: string) {
    return request<{ lot: InventoryLot; patientsAffected: number }>(
      `/inventory/lots/${lotId}/recall`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
  },
};

/* ── Features (API 0013) ─────────────────────────────────── */
export interface ClinicFeature {
  key: FeatureKey;
  name: string;
  description: string;
  group: FeatureGroup;
  alwaysOn: boolean;
  state: FeatureState;
  entitledBy: 'override' | 'plan' | 'default';
  missing: FeatureKey[];
  overrideExpiresAt: string | null;
  changedAt: string | null;
  changedBy: string | null;
}

export const featuresApi = {
  list() {
    return request<ClinicFeature[]>('/features');
  },
  set(key: FeatureKey, enabled: boolean) {
    return request<ClinicFeature[]>(`/features/${key}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  },
};

/* ── Cash drawer (API 0014) ──────────────────────────────── */
export type DrawerSessionStatus =
  'open' | 'counting' | 'pending_approval' | 'closed' | 'force_closed';
export type CurrencyAmounts = Partial<Record<CurrencyCode, number>>;
export type DenominationCounts = Record<string, number>;
export type Thresholds = Partial<
  Record<CurrencyCode, { tolerance: number; approval: number }>
>;

export interface DrawerPolicy {
  blindCount: boolean;
  maxRecounts: number;
  thresholds: Thresholds;
  defaultFloat: CurrencyAmounts;
}

export interface CashDrawer {
  id: string;
  name: string;
  tcrCode: string | null;
  currencies: CurrencyCode[];
  isActive: boolean;
  locationId: string;
  openSession: {
    id: string;
    status: DrawerSessionStatus;
    heldBy: { id: string; name: string };
  } | null;
}

export interface DrawerReview {
  currency: CurrencyCode;
  expected: number;
  counted: number;
  variance: number;
  band: VarianceBand;
  note: string | null;
}

export interface DrawerEvent {
  seq: number;
  type: string;
  currency: CurrencyCode;
  amount: number;
  paymentId: string | null;
  reason: string | null;
  actor: string | null;
  ip: string | null;
  userAgent: string | null;
  occurredAt: string;
}

export interface DrawerSession {
  id: string;
  drawer: { id: string; name: string };
  locationId: string;
  businessDate: string;
  status: DrawerSessionStatus;
  blind: boolean;
  currencies: CurrencyCode[];
  openedBy: { id: string; name: string };
  openedAt: string;
  countingStartedAt: string | null;
  closedBy: { id: string; name: string } | null;
  closedAt: string | null;
  /** Null while a blind count is still to come, for the person counting. */
  expected: CurrencyAmounts | null;
  thresholds: Thresholds | null;
  maxRecounts: number;
  cashPayments: number;
  cardTotal: number | null;
  cardBatchTotal: number | null;
  cardBatchNote: string | null;
  counts: {
    attempt: number;
    currency: CurrencyCode;
    total: number;
    expected: number;
    countedBy: string | null;
    countedAt: string;
    denominations: DenominationCounts;
  }[];
  reviews: DrawerReview[];
  approvals: {
    id: string;
    action:
      'drawer_variance' | 'drawer_payout' | 'drawer_force_close' | 'drawer_add_float';
    approver: string | null;
    method: 'pin' | 'session';
    selfApproved: boolean;
    reason: string;
    approvedAt: string;
  }[];
  events: DrawerEvent[] | null;
  chain: { valid: true } | { valid: false; brokenAtSeq: number } | null;
}

export interface FiscalDeclaration {
  status: 'not_required' | 'registered' | 'rejected' | 'unreachable' | 'failed';
  message: string | null;
}

export interface DrawerCurrent {
  session: DrawerSession | null;
  drawers: {
    id: string;
    name: string;
    currencies: CurrencyCode[];
    heldBy: string | null;
    defaultFloat: CurrencyAmounts;
  }[];
  /** The clinic's currency, which cash payments are taken in. */
  currency: CurrencyCode;
  /** What to start the day with: the last close's count, else the clinic default. */
  suggestedFloat: number;
  blindCount: boolean;
}

export interface DrawerChecklist {
  openInvoices: {
    id: string;
    invoiceNumber: string;
    patientName: string;
    balance: number;
  }[];
  card: { count: number; total: number };
  bank: { count: number; total: number };
}

export interface CountLine {
  currency: CurrencyCode;
  counted: number;
  expected: number;
  variance: number;
  band: VarianceBand;
}

export interface CountResult {
  attempt: number;
  recountsLeft: number;
  lines: CountLine[];
}

export interface DrawerSessionRow {
  id: string;
  drawer: { id: string; name: string };
  businessDate: string;
  status: DrawerSessionStatus;
  blind: boolean;
  openedBy: { id: string; name: string };
  openedAt: string;
  closedBy: { id: string; name: string } | null;
  closedAt: string | null;
  cardTotal: number | null;
  cardBatchTotal: number | null;
  reviews: DrawerReview[];
  recounted: boolean;
  selfApproved: boolean;
  voidedAfterClose: boolean;
}

export interface PinApproval {
  approverUserId: string;
  pin: string;
}

/** Each currency counted note by note, or typed as one total. */
type CountPayload = (
  | { currency: CurrencyCode; denominations: DenominationCounts }
  | { currency: CurrencyCode; total: number }
)[];

export const drawerApi = {
  current() {
    return request<DrawerCurrent>('/drawer/current');
  },
  policy() {
    return request<DrawerPolicy>('/drawer/policy');
  },
  updatePolicy(p: Partial<DrawerPolicy>) {
    return request<DrawerPolicy>('/drawer/policy', {
      method: 'PUT',
      body: JSON.stringify(p),
    });
  },
  drawers() {
    return request<CashDrawer[]>('/drawer/drawers');
  },
  createDrawer(p: { name: string; currencies: CurrencyCode[]; tcrCode?: string | null }) {
    return request<{ id: string }>('/drawer/drawers', {
      method: 'POST',
      body: JSON.stringify(p),
    });
  },
  updateDrawer(
    id: string,
    p: {
      name?: string;
      currencies?: CurrencyCode[];
      tcrCode?: string | null;
      isActive?: boolean;
    },
  ) {
    return request<{ id: string }>(`/drawer/drawers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  approvers() {
    return request<{ id: string; name: string }[]>('/drawer/approvers');
  },
  setApprovalPin(currentPassword: string, pin: string) {
    return request<{ set: true }>('/drawer/approval-pin', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, pin }),
    });
  },
  open(
    p: {
      /** Omitted: the clinic's drawer, created on first use. */
      drawerId?: string;
      floats: {
        currency: CurrencyCode;
        amount: number;
        denominations?: DenominationCounts;
      }[];
    },
    key: string,
  ) {
    return request<DrawerSession & { fiscalDeclaration: FiscalDeclaration }>(
      '/drawer/sessions',
      {
        method: 'POST',
        body: JSON.stringify(p),
        headers: idempotent(key),
      },
    );
  },
  drop(
    sessionId: string,
    p: { currency: CurrencyCode; amount: number; reason?: string },
    key: string,
  ) {
    return request<DrawerSession & { fiscalDeclaration: FiscalDeclaration }>(
      `/drawer/sessions/${sessionId}/drops`,
      { method: 'POST', body: JSON.stringify(p), headers: idempotent(key) },
    );
  },
  approvedMovement(
    kind: 'payout' | 'float',
    sessionId: string,
    p: { currency: CurrencyCode; amount: number; reason: string; approval?: PinApproval },
    key: string,
  ) {
    return request<DrawerSession>(
      `/drawer/sessions/${sessionId}/${kind === 'payout' ? 'payouts' : 'float'}`,
      { method: 'POST', body: JSON.stringify(p), headers: idempotent(key) },
    );
  },
  noSale(sessionId: string, reason: string) {
    return request<DrawerSession>(`/drawer/sessions/${sessionId}/no-sale`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  startCount(sessionId: string) {
    return request<{ session: DrawerSession; checklist: DrawerChecklist }>(
      `/drawer/sessions/${sessionId}/count/start`,
      { method: 'POST' },
    );
  },
  cancelCount(sessionId: string) {
    return request<DrawerSession>(`/drawer/sessions/${sessionId}/count/cancel`, {
      method: 'POST',
    });
  },
  submitCount(sessionId: string, counts: CountPayload, key: string) {
    return request<CountResult>(`/drawer/sessions/${sessionId}/counts`, {
      method: 'POST',
      body: JSON.stringify({ counts }),
      headers: idempotent(key),
    });
  },
  close(
    sessionId: string,
    p: {
      notes?: Partial<Record<CurrencyCode, string>>;
      cardBatchTotal?: number;
      cardBatchNote?: string;
      acknowledgeOpenInvoices?: boolean;
    },
    key: string,
  ) {
    return request<DrawerSession>(`/drawer/sessions/${sessionId}/close`, {
      method: 'POST',
      body: JSON.stringify(p),
      headers: idempotent(key),
    });
  },
  approve(sessionId: string, reason: string, key: string) {
    return request<DrawerSession>(`/drawer/sessions/${sessionId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
      headers: idempotent(key),
    });
  },
  approveWithPin(sessionId: string, p: PinApproval & { reason: string }, key: string) {
    return request<DrawerSession>(`/drawer/sessions/${sessionId}/approve-with-pin`, {
      method: 'POST',
      body: JSON.stringify(p),
      headers: idempotent(key),
    });
  },
  forceClose(
    sessionId: string,
    p: { counts: CountPayload; reason: string },
    key: string,
  ) {
    return request<DrawerSession>(`/drawer/sessions/${sessionId}/force-close`, {
      method: 'POST',
      body: JSON.stringify(p),
      headers: idempotent(key),
    });
  },
  sessions(
    q: {
      from?: string;
      to?: string;
      userId?: string;
      drawerId?: string;
      varianceOnly?: boolean;
    } = {},
  ) {
    const qs = new URLSearchParams();
    if (q.from) qs.set('from', q.from);
    if (q.to) qs.set('to', q.to);
    if (q.userId) qs.set('userId', q.userId);
    if (q.drawerId) qs.set('drawerId', q.drawerId);
    if (q.varianceOnly) qs.set('varianceOnly', 'true');
    const s = qs.toString();
    return request<DrawerSessionRow[]>(`/drawer/sessions${s ? `?${s}` : ''}`);
  },
  session(id: string) {
    return request<DrawerSession>(`/drawer/sessions/${id}`);
  },
};

/* ════════ WhatsApp reminders (0017) ════════
 * The clinic's own WhatsApp Cloud API number. The access token is sent to
 * save or test the connection and never comes back: nothing below has a
 * field for it in any response. */

export interface WhatsAppConnection {
  connected: boolean;
  saved: boolean;
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: 'connected' | 'failed' | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestResult: string | null;
  lastSuccessAt: string | null;
  connectedAt: string | null;
  timezone: string;
}

export interface WhatsAppTestResult {
  ok: boolean;
  message: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  testedAt: string;
}

export interface WhatsAppTemplate {
  id: string;
  displayName: string;
  metaTemplateName: string;
  languageCode: string;
  previewBody: string;
  isActive: boolean;
  isDefault: boolean;
  meta: {
    status: string | null;
    category: string | null;
    parameters: string[];
    checkedAt: string | null;
    problem: string | null;
  };
  /** Approved by Meta as a Utility template, with variables a reminder can fill. */
  ready: boolean;
  updatedAt: string;
}

export interface WhatsAppTemplateInput {
  displayName: string;
  metaTemplateName: string;
  languageCode: string;
  previewBody: string;
  isActive?: boolean;
  isDefault?: boolean;
}

export interface ReminderRow {
  appointmentId: string;
  patientId: string;
  patientName: string;
  whatsappPhone: string | null;
  startsAt: string;
  appointmentStatus: string;
  reminder: {
    status: WhatsAppSendStatus;
    at: string | null;
    failureReason: string | null;
  } | null;
  exclusion: WhatsAppExclusion | null;
  exclusionLabel: string | null;
  values: WhatsAppValues;
}

export interface ReminderDay {
  date: string;
  timezone: string;
  clinic: { name: string; phone: string | null };
  connection: { connected: boolean; displayPhoneNumber: string | null };
  template: WhatsAppTemplate | null;
  summary: {
    total: number;
    eligible: number;
    alreadyReminded: number;
    noConsent: number;
    phoneProblem: number;
    cancelled: number;
  };
  rows: ReminderRow[];
}

export interface WhatsAppSend {
  id: string;
  batchId: string;
  patientId: string;
  patientName: string;
  phone: string | null;
  appointmentAt: string;
  templateName: string;
  sentBy: string | null;
  sentAt: string | null;
  createdAt: string;
  status: WhatsAppSendStatus;
  live: boolean;
  failureReason: string | null;
}

export interface WhatsAppBatch {
  id: string;
  date: string;
  templateName: string;
  selected: number;
  sent: number;
  failed: number;
  skipped: number;
  startedAt: string;
  completedAt: string | null;
  by: string | null;
}

export const whatsappApi = {
  connection() {
    return request<WhatsAppConnection>('/whatsapp/connection');
  },
  test(p: { accessToken?: string; phoneNumberId?: string; wabaId?: string }) {
    return request<WhatsAppTestResult>('/whatsapp/connection/test', {
      method: 'POST',
      body: JSON.stringify(p),
    });
  },
  save(p: { accessToken?: string; phoneNumberId: string; wabaId: string }) {
    return request<WhatsAppConnection>('/whatsapp/connection', {
      method: 'PUT',
      body: JSON.stringify(p),
    });
  },
  disconnect() {
    return request<WhatsAppConnection>('/whatsapp/connection', { method: 'DELETE' });
  },
  templates() {
    return request<WhatsAppTemplate[]>('/whatsapp/templates');
  },
  createTemplate(p: WhatsAppTemplateInput) {
    return request<WhatsAppTemplate>('/whatsapp/templates', {
      method: 'POST',
      body: JSON.stringify(p),
    });
  },
  updateTemplate(id: string, p: Partial<WhatsAppTemplateInput>) {
    return request<WhatsAppTemplate>(`/whatsapp/templates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  deleteTemplate(id: string) {
    return request<{ deleted: true }>(`/whatsapp/templates/${id}`, { method: 'DELETE' });
  },
  checkTemplate(id: string) {
    return request<WhatsAppTemplate>(`/whatsapp/templates/${id}/check`, {
      method: 'POST',
    });
  },
  day(date?: string) {
    return request<ReminderDay>(`/whatsapp/reminders${date ? `?date=${date}` : ''}`);
  },
  send(p: { date: string; templateId: string; appointmentIds: string[] }, key: string) {
    return request<WhatsAppBatch & { sends: WhatsAppSend[] }>(
      '/whatsapp/reminders/send',
      {
        method: 'POST',
        body: JSON.stringify(p),
        headers: idempotent(key),
      },
    );
  },
  history(q: { batchId?: string; status?: WhatsAppSendStatus | '' } = {}) {
    const qs = new URLSearchParams();
    if (q.batchId) qs.set('batchId', q.batchId);
    if (q.status) qs.set('status', q.status);
    const s = qs.toString();
    return request<{ batches: WhatsAppBatch[]; sends: WhatsAppSend[] }>(
      `/whatsapp/history${s ? `?${s}` : ''}`,
    );
  },
};
/* ── Lab work, labs and suppliers (0020) ─────────────────── */

/** A dental laboratory or a material supplier: someone to call or message. */
export interface Partner {
  id: string;
  kind: 'lab' | 'supplier';
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  isActive: boolean;
}
export interface PartnerPayload {
  name?: string;
  phone?: string;
  email?: string;
  notes?: string;
  isActive?: boolean;
}

function partnersOf(base: '/labs' | '/suppliers') {
  return {
    list(includeRetired = false) {
      return request<Partner[]>(`${base}${includeRetired ? '?all=1' : ''}`);
    },
    create(p: PartnerPayload & { name: string }) {
      return request<Partner>(base, { method: 'POST', body: JSON.stringify(p) });
    },
    update(id: string, p: PartnerPayload) {
      return request<Partner>(`${base}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(p),
      });
    },
  };
}
export const labsApi = partnersOf('/labs');
export const suppliersApi = partnersOf('/suppliers');

export type LabStatus = 'preparing' | 'sent' | 'received' | 'fitted' | 'cancelled';

export interface LabOrder {
  id: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  labId: string | null;
  labName: string | null;
  labPhone: string | null;
  dentistId: string | null;
  dentistName: string | null;
  planItemId: string | null;
  planItemDescription: string | null;
  /** What the lab makes: "E-max crown". */
  work: string;
  /** FDI tooth numbers. */
  teeth: number[];
  material: string | null;
  shade: string | null;
  /** What the lab charges, minor units. */
  cost: number | null;
  /** YYYY-MM-DD */
  dueOn: string | null;
  status: LabStatus;
  notes: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  fittedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  /** Still preparing or at the lab, past its due date on the clinic's clock. */
  overdue: boolean;
}
export interface LabOrderPayload {
  patientId: string;
  work: string;
  teeth?: number[];
  labId?: string | null;
  dentistId?: string | null;
  planItemId?: string | null;
  material?: string | null;
  shade?: string | null;
  cost?: number | null;
  dueOn?: string | null;
  notes?: string | null;
}
export interface LabSummary {
  open: number;
  overdue: number;
  /** Back from the lab, waiting to be fitted. */
  ready: number;
  dueSoon: number;
}

export const labApi = {
  /** `open` (default): not yet fitted or cancelled. `done`: recently finished. */
  list(p: { scope?: 'open' | 'done'; patientId?: string } = {}) {
    const qs = new URLSearchParams();
    if (p.scope) qs.set('scope', p.scope);
    if (p.patientId) qs.set('patientId', p.patientId);
    const s = qs.toString();
    return request<LabOrder[]>(`/lab-orders${s ? `?${s}` : ''}`);
  },
  summary() {
    return request<LabSummary>('/lab-orders/summary');
  },
  create(p: LabOrderPayload) {
    return request<LabOrder>('/lab-orders', { method: 'POST', body: JSON.stringify(p) });
  },
  update(id: string, p: Partial<Omit<LabOrderPayload, 'patientId'>>) {
    return request<LabOrder>(`/lab-orders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
  /** One step along, one back (undo), or cancelled with a reason. */
  move(id: string, status: LabStatus, reason?: string) {
    return request<LabOrder>(`/lab-orders/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, reason }),
    });
  },
};
