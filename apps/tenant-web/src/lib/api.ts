import type { Permission, Role } from './permissions';

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
  ) {
    super(message);
  }
}

/**
 * Turn a failed Response into an ApiError. Nest returns validation failures as
 * a `message` array, so those are joined into one readable line.
 */
async function toApiError(res: Response): Promise<ApiError> {
  let message = res.statusText;
  try {
    const body = await res.json();
    message = Array.isArray(body.message)
      ? body.message.join(', ')
      : (body.message ?? message);
  } catch {
    /* response had no JSON body — keep statusText */
  }
  return new ApiError(res.status, message);
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
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) return false;
    tokenStore.set(body.accessToken);
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
  return fetch(`/api${path}`, { ...options, headers });
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
    return fetch(`/api${path}`, { method: 'POST', body: form, headers });
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
}

export interface PatientListItem {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  status: 'active' | 'inactive' | 'archived';
  createdAt: string;
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

export const DOCUMENT_KINDS = [
  'xray',
  'photo',
  'consent',
  'referral',
  'insurance',
  'report',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  xray: 'X-ray',
  photo: 'Photo',
  consent: 'Consent form',
  referral: 'Referral',
  insurance: 'Insurance',
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
  uploadedByName: string | null;
  createdAt: string;
  isImage: boolean;
}
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
}

export const api = {
  login(email: string, password: string) {
    return request<{ accessToken: string; refreshToken: string; user: AuthUser }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
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
  deleteNote(noteId: string) {
    return request<void>(`/patients/notes/${noteId}`, { method: 'DELETE' });
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
  deleteAllergy(patientId: string, id: string) {
    return request<{ deleted: true }>(`/patients/${patientId}/allergies/${id}`, {
      method: 'DELETE',
    });
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
  deleteCondition(patientId: string, id: string) {
    return request<{ deleted: true }>(`/patients/${patientId}/conditions/${id}`, {
      method: 'DELETE',
    });
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
  deleteMedication(patientId: string, id: string) {
    return request<{ deleted: true }>(`/patients/${patientId}/medications/${id}`, {
      method: 'DELETE',
    });
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
    } = {},
  ) {
    const form = new FormData();
    form.append('file', file);
    if (meta.kind) form.append('kind', meta.kind);
    if (meta.tooth !== undefined) form.append('tooth', String(meta.tooth));
    if (meta.takenOn) form.append('takenOn', meta.takenOn);
    if (meta.caption) form.append('caption', meta.caption);
    return upload<PatientDocument & { duplicate: boolean }>(
      `/patients/${patientId}/documents`,
      form,
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
  reason: 'not_working' | null;
}
export interface StaffMember {
  id: string;
  fullName: string;
  role: Role;
  status: 'active' | 'disabled';
  position: string | null;
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
  update(id: string, p: Partial<AppointmentPayload>) {
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
}
export interface TreatmentPayload {
  name: string;
  price: number;
  durationMinutes: number;
  visitType: 'single' | 'multiple' | null;
  status?: 'active' | 'inactive';
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

import type { Surface, ToothCondition } from '@dentalcare/shared';

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
  deleteCondition(id: string) {
    return request<{ deleted: true }>(`/tooth-conditions/${id}`, { method: 'DELETE' });
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
  remove(id: string) {
    return request<{ deleted: true }>(`/procedures/${id}`, { method: 'DELETE' });
  },
};

/* ── Perio charting ──────────────────────────────────────── */

export const PERIO_SITES = ['MB', 'B', 'DB', 'ML', 'L', 'DL'] as const;
export type PerioSite = (typeof PERIO_SITES)[number];

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
  deleteExam(examId: string) {
    return request<{ deleted: true }>(`/perio-exams/${examId}`, { method: 'DELETE' });
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
  /** present only when the requester holds payroll:read */
  salaryAmount?: number | null;
  salaryNote?: string | null;
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
    salaryAmount?: number;
    salaryNote?: string;
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
      salaryAmount?: number | null;
      salaryNote?: string | null;
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
  recordSalaryPayment(
    staffId: string,
    p: { amount: number; paidOn?: string; note?: string },
  ) {
    return request<SalaryPayment>(`/staff/${staffId}/salary-payments`, {
      method: 'POST',
      body: JSON.stringify(p),
    });
  },
  salaryPayments() {
    return request<SalaryPayment[]>('/staff/salary-payments');
  },
};

export interface WorkingDay {
  day: number;
  closed: boolean;
  open: string;
  close: string;
}
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
}
export const settingsApi = {
  get() {
    return request<ClinicSettings>('/settings');
  },
  update(p: Partial<ClinicSettings>) {
    return request<ClinicSettings>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(p),
    });
  },
};

/* ── Finance (M8) ───────────────────────────────────────── */
export type InvoiceStatus = 'unpaid' | 'partially_paid' | 'paid' | 'cancelled';
export type PaymentMethod = 'cash' | 'card' | 'bank';
export type ExpenseCategory =
  'rent' | 'materials' | 'utilities' | 'salaries' | 'lab' | 'other';

export interface InvoiceSummaryRow {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  total: number;
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
}
export interface PaymentHistoryRow extends Voidable {
  id: string;
  amount: number;
  method: PaymentMethod;
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
  period: 'month' | 'all';
  outstanding: number;
  totalInvoiced?: number;
  totalCollected?: number;
  totalExpenses?: number;
}

export const financeApi = {
  listInvoices(params: { q?: string; status?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.status && params.status !== 'all') qs.set('status', params.status);
    const s = qs.toString();
    return request<InvoiceSummaryRow[]>(`/invoices${s ? `?${s}` : ''}`);
  },
  getInvoice(id: string) {
    return request<InvoiceDetail>(`/invoices/${id}`);
  },
  createInvoice(p: { patientId: string; issuedAt?: string; items: LineItemPayload[] }) {
    return request<InvoiceSummaryRow>('/invoices', {
      method: 'POST',
      body: JSON.stringify(p),
    });
  },
  cancelInvoice(id: string) {
    return request<InvoiceSummaryRow>(`/invoices/${id}/cancel`, { method: 'PATCH' });
  },
  recordPayment(
    invoiceId: string,
    p: { amount: number; method: PaymentMethod; note?: string },
  ) {
    return request<InvoiceSummaryRow>(`/invoices/${invoiceId}/payments`, {
      method: 'POST',
      body: JSON.stringify(p),
    });
  },
  listPayments() {
    return request<PaymentHistoryRow[]>('/payments');
  },
  listExpenses(category?: string) {
    const s = category && category !== 'all' ? `?category=${category}` : '';
    return request<ExpenseRow[]>(`/expenses${s}`);
  },
  createExpense(p: {
    category: ExpenseCategory;
    amount: number;
    expenseDate?: string;
    note?: string;
  }) {
    return request<ExpenseRow>('/expenses', { method: 'POST', body: JSON.stringify(p) });
  },
  voidExpense(id: string, reason: string) {
    return request<{ voided: true }>(`/expenses/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  voidPayment(id: string, reason: string) {
    return request<InvoiceSummaryRow>(`/payments/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  summary(period: 'month' | 'all' = 'month') {
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
  };
  monthlyTrend: ReportTrendPoint[];
  revenueByTreatment: ReportBreakdownRow[];
  expensesByCategory: ReportBreakdownRow[];
  paymentsByMethod: ReportBreakdownRow[];
  appointmentsByDentist: ReportDentistRow[];
}

export const reportsApi = {
  overview(from?: string, to?: string) {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const s = qs.toString();
    return request<ReportOverview>(`/reports/overview${s ? `?${s}` : ''}`);
  },
};

/* ── Reminders (M10) ────────────────────────────────────── */
export interface Reminder {
  id: string;
  appointmentId: string;
  type: 'automatic' | 'manual';
  channel: string;
  status: 'pending' | 'sent' | 'failed';
  message: string;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
  patientName: string | null;
  appointmentStartsAt: string | null;
  appointmentReason: string | null;
}

export const remindersApi = {
  list(appointmentId?: string) {
    const s = appointmentId ? `?appointmentId=${appointmentId}` : '';
    return request<Reminder[]>(`/reminders${s}`);
  },
  /**
   * Records that a reminder was sent. For 'whatsapp' and 'email' the message
   * is handed to the staff member's own app — the row is a hand-off record,
   * not proof of delivery.
   */
  sendManual(appointmentId: string, channel: 'log' | 'whatsapp' | 'email' = 'log') {
    return request<Reminder>(`/appointments/${appointmentId}/reminders`, {
      method: 'POST',
      body: JSON.stringify({ channel }),
    });
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
  ) {
    return request<GeneratedInvoice>(`/treatment-plans/${planId}/invoice`, {
      method: 'POST',
      body: JSON.stringify(opts),
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
  ) {
    return request<PatientLedger>(`/patients/${patientId}/ledger/adjustments`, {
      method: 'POST',
      body: JSON.stringify(clean(p)),
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
