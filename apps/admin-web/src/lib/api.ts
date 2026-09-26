const ACCESS_KEY = 'dcx.access';
const REFRESH_KEY = 'dcx.refresh';

export const token = {
  get: () => localStorage.getItem(ACCESS_KEY),
  refresh: () => localStorage.getItem(REFRESH_KEY),
  set: (access: string, refresh?: string) => {
    localStorage.setItem(ACCESS_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear: () => {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Called when the session cannot be recovered, so the app can sign out. */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn;
}

/**
 * One refresh shared by every request that hits a 401 at the same moment.
 * Refresh tokens rotate (migration 0005), so four parallel refreshes would
 * spend the token four times — the grace period covers it, but there is no
 * reason to lean on it.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const refreshToken = token.refresh();
  if (!refreshToken) return false;
  try {
    const res = await fetch('/api/platform/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
    if (!body.accessToken || !body.refreshToken) return false;
    token.set(body.accessToken, body.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function send(path: string, options: RequestInit, auth: boolean) {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  const access = token.get();
  if (auth && access) headers.set('Authorization', `Bearer ${access}`);
  return fetch(`/api${path}`, { ...options, headers });
}

async function req<T>(path: string, options: RequestInit = {}, auth = true): Promise<T> {
  let res = await send(path, options, auth);

  // The console used to have no refresh at all: every administrator was
  // signed out fifteen minutes into whatever they were doing.
  if (res.status === 401 && auth && token.refresh()) {
    refreshInFlight ??= refreshSession().finally(() => {
      refreshInFlight = null;
    });
    if (await refreshInFlight) {
      res = await send(path, options, auth);
    } else {
      token.clear();
      onSessionExpired?.();
    }
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message = Array.isArray(b.message) ? b.message.join(', ') : b.message ?? message;
    } catch {
      /* keep */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Admin {
  id: string;
  email: string;
  fullName: string;
}

/* ── sign-in (0005) ───────────────────────────────────────── */

export interface PlatformAuthenticated {
  status: 'authenticated';
  accessToken: string;
  refreshToken: string;
  admin: Admin;
}

/**
 * Every console account must use two-step sign-in, so a password on its own
 * normally lands on 'mfa_required' or, the first time, on enrollment.
 */
export type PlatformLoginResult =
  | PlatformAuthenticated
  | { status: 'mfa_required'; challengeToken: string; methods: ('totp' | 'recovery')[] }
  | { status: 'mfa_enrollment_required'; challengeToken: string };

export type MfaStage = 'verify' | 'enroll';

export interface TotpSetup {
  secret: string;
  otpauthUri: string;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  price_monthly: number;
}
export type TenantStatus = 'active' | 'suspended' | 'archived' | 'deleted';

/**
 * Where clinics live: https://<subdomain>.<base>. Configured per deployment
 * (VITE_TENANT_BASE_DOMAIN); the console used to print .dentalcare.app while
 * production served dentalcare.com.
 */
export const TENANT_BASE_DOMAIN =
  (import.meta.env.VITE_TENANT_BASE_DOMAIN as string | undefined)?.trim() || 'dentalcare.com';

export function clinicHost(subdomain: string): string {
  return `${subdomain}.${TENANT_BASE_DOMAIN}`;
}

/** Counts, sizes and the subscription. Never a clinic's own revenue or patients' data. */
export interface TenantStats {
  user_count: number;
  active_user_count: number;
  patient_count: number;
  appointments_this_month: number;
  storage_bytes: number;
  owner_email: string | null;
}

export interface TenantRow extends TenantStats {
  id: string;
  name: string;
  subdomain: string;
  status: TenantStatus;
  plan_id: string | null;
  plan_name: string | null;
  plan_code: string | null;
  price_monthly: number | null;
  trial_ends_at: string | null;
  created_at: string;
  deleted_at: string | null;
  purge_after: string | null;
  deletion_reason: string | null;
  status_before_delete: string | null;
}

export interface PlatformOverview {
  clinics: Record<Exclude<TenantStatus, never>, number>;
  trials: number;
  /** Minor units: the sum of plan prices for active, paying clinics. */
  mrr: number;
  patients: number;
  storageBytes: number;
  appointmentsThisMonth: number;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * A date-only value ('YYYY-MM-DD') as a LOCAL date.
 *
 * `new Date('2026-09-15')` is parsed as UTC midnight, which renders as the
 * 14th anywhere west of Greenwich. Splitting the parts and building a local
 * date is what keeps a due date on the day it is due.
 */
export function toDay(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

/** Plan prices are minor units of euro. */
export function formatEuro(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
}
export interface AuditRow {
  id: string;
  actor_label: string;
  action: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface TenantDetail extends TenantRow {
  currency: string | null;
  timezone: string | null;
  phone: string | null;
  city: string | null;
  tax_number: string | null;
  fiscalization_enabled: boolean;
  staff: { id: string; email: string; full_name: string; role: string; status: string }[];
  audit: AuditRow[];
}

export interface CreateTenantPayload {
  clinicName: string;
  subdomain: string;
  ownerFullName: string;
  ownerEmail: string;
  ownerPassword: string;
  planId?: string;
  trialDays?: number;
  currency?: string;
  timezone?: string;
  phoneCountryCode?: string;
  phone?: string;
  address?: string;
  city?: string;
  taxNumber?: string;
}

export interface SubdomainCheck {
  subdomain: string;
  available: boolean;
  reason: string | null;
}

/**
 * How a clinic's trial reads right now. Derived from `trial_ends_at` alone —
 * there is no separate flag on the row, so these can never disagree with it.
 */
export type TrialState =
  | { kind: 'paid' }
  | { kind: 'running'; endsAt: string; daysLeft: number }
  | { kind: 'expired'; endsAt: string; daysAgo: number };

export function trialState(trialEndsAt: string | null): TrialState {
  if (!trialEndsAt) return { kind: 'paid' };
  const ends = new Date(trialEndsAt).getTime();
  const diff = ends - Date.now();
  // Ceil while it is running, so the last partial day still reads "1 day
  // left" rather than "0" — a countdown that hits zero a day early looks
  // broken to the person watching it.
  if (diff >= 0) {
    return { kind: 'running', endsAt: trialEndsAt, daysLeft: Math.ceil(diff / 86_400_000) };
  }
  return { kind: 'expired', endsAt: trialEndsAt, daysAgo: Math.floor(-diff / 86_400_000) };
}

export const api = {
  login: (email: string, password: string) =>
    req<PlatformLoginResult>(
      '/platform/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
      false,
    ),
  verifyMfa: (challengeToken: string, input: { code?: string; recoveryCode?: string }) =>
    req<PlatformAuthenticated>(
      '/platform/auth/mfa/verify',
      { method: 'POST', body: JSON.stringify({ challengeToken, ...input }) },
      false,
    ),
  beginEnrollment: (challengeToken: string) =>
    req<TotpSetup>(
      '/platform/auth/mfa/enroll/start',
      { method: 'POST', body: JSON.stringify({ challengeToken }) },
      false,
    ),
  confirmEnrollment: (challengeToken: string, code: string) =>
    req<PlatformAuthenticated & { recoveryCodes: string[] }>(
      '/platform/auth/mfa/enroll/confirm',
      { method: 'POST', body: JSON.stringify({ challengeToken, code }) },
      false,
    ),
  logout: (refreshToken: string) =>
    req<{ signedOut: true }>(
      '/platform/auth/logout',
      { method: 'POST', body: JSON.stringify({ refreshToken }) },
      false,
    ),
  me: () => req<Admin>('/platform/auth/me'),
  plans: () => req<Plan[]>('/platform/plans'),
  tenants: () => req<TenantRow[]>('/platform/tenants'),
  overview: () => req<PlatformOverview>('/platform/tenants/overview'),
  checkSubdomain: (name: string, except?: string) =>
    req<SubdomainCheck>(
      `/platform/tenants/subdomain-check?${new URLSearchParams({ name, ...(except ? { except } : {}) })}`,
    ),
  tenant: (id: string) => req<TenantDetail>(`/platform/tenants/${id}`),
  setPlan: (id: string, planId: string | null) =>
    req<{ id: string; planId: string | null }>(`/platform/tenants/${id}/plan`, {
      method: 'PATCH',
      body: JSON.stringify({ planId }),
    }),
  changeSubdomain: (id: string, subdomain: string) =>
    req<{ id: string; subdomain: string }>(`/platform/tenants/${id}/subdomain`, {
      method: 'PATCH',
      body: JSON.stringify({ subdomain }),
    }),
  deleteTenant: (id: string, confirmSubdomain: string, reason: string) =>
    req<{ id: string; status: 'deleted'; purgeAfter: string }>(`/platform/tenants/${id}/delete`, {
      method: 'POST',
      body: JSON.stringify({ confirmSubdomain, reason }),
    }),
  restoreTenant: (id: string) =>
    req<{ id: string; status: 'suspended' }>(`/platform/tenants/${id}/restore`, { method: 'POST' }),
  /** A JSON snapshot of the clinic's data, saved by the browser. Audited on the server. */
  exportTenant: async (id: string, fallbackName: string) => {
    const send = () => {
      const headers = new Headers();
      const access = token.get();
      if (access) headers.set('Authorization', `Bearer ${access}`);
      return fetch(`/api/platform/tenants/${id}/export`, { headers });
    };
    let res = await send();
    if (res.status === 401 && token.refresh()) {
      refreshInFlight ??= refreshSession().finally(() => {
        refreshInFlight = null;
      });
      if (await refreshInFlight) res = await send();
    }
    if (!res.ok) {
      let message = res.statusText;
      try {
        const b = await res.json();
        message = Array.isArray(b.message) ? b.message.join(', ') : b.message ?? message;
      } catch {
        /* keep */
      }
      throw new ApiError(res.status, message);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
  createTenant: (p: CreateTenantPayload) =>
    req<{ id: string; subdomain: string }>('/platform/tenants', {
      method: 'POST',
      body: JSON.stringify(p),
    }),
  setStatus: (id: string, status: TenantStatus) =>
    req<{ id: string; status: TenantStatus }>(`/platform/tenants/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  /** `days: null` converts the clinic to paid and lifts the read-only lock. */
  setTrial: (id: string, days: number | null) =>
    req<{ id: string; trialEndsAt: string | null }>(`/platform/tenants/${id}/trial`, {
      method: 'PATCH',
      body: JSON.stringify({ days }),
    }),
  resetUserPassword: (tenantId: string, userId: string, password: string) =>
    req<{ reset: true; email: string }>(
      `/platform/tenants/${tenantId}/users/${userId}/password`,
      { method: 'POST', body: JSON.stringify({ password }) },
    ),
  /** Lost authenticator AND recovery codes — the sole-administrator case. */
  resetUserMfa: (tenantId: string, userId: string) =>
    req<{ reset: true; email: string; hadFactor: boolean }>(
      `/platform/tenants/${tenantId}/users/${userId}/mfa/reset`,
      { method: 'POST' },
    ),

  // ── Subscription billing: what the clinic owes US (0016) ────────────────
  billingSummary: () => req<BillingSummary>('/platform/billing/summary'),
  subscriptionInvoices: (filter: { status?: string; overdue?: boolean } = {}) =>
    req<SubscriptionInvoice[]>(
      `/platform/billing/invoices?${new URLSearchParams({
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.overdue ? { overdue: 'true' } : {}),
      })}`,
    ),
  tenantInvoices: (tenantId: string) =>
    req<SubscriptionInvoice[]>(`/platform/billing/tenants/${tenantId}/invoices`),
  runBilling: (period?: string) =>
    req<{ considered: number; issued: number; numbers: string[] }>('/platform/billing/run', {
      method: 'POST',
      body: JSON.stringify(period ? { period } : {}),
    }),
  markInvoicePaid: (id: string, input: MarkPaidInput) =>
    req<{ id: string; status: 'paid'; paidAmount: number }>(
      `/platform/billing/invoices/${id}/pay`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  voidInvoice: (id: string, reason: string) =>
    req<{ id: string; status: 'void' }>(`/platform/billing/invoices/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // ── What each clinic consumes ───────────────────────────────────────────
  usage: () => req<FleetUsage>('/platform/usage'),
  tenantUsage: (tenantId: string) => req<TenantUsage>(`/platform/usage/${tenantId}`),

  // ── The price list ──────────────────────────────────────────────────────
  plansAll: () => req<PlanDetail[]>('/platform/plans/all'),
  createPlan: (input: { code: string; name: string; priceMonthly: number }) =>
    req<{ id: string }>('/platform/plans', { method: 'POST', body: JSON.stringify(input) }),
  updatePlan: (id: string, input: { name?: string; priceMonthly?: number; isActive?: boolean }) =>
    req<{ id: string }>(`/platform/plans/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),

  // ── Everything the console has done ─────────────────────────────────────
  activity: (q: { category?: ActivityCategory; limit?: number; cursor?: ActivityCursor | null } = {}) =>
    req<ActivityPage>(
      `/platform/activity?${new URLSearchParams({
        ...(q.category ? { category: q.category } : {}),
        ...(q.limit ? { limit: String(q.limit) } : {}),
        ...(q.cursor ? { before: q.cursor.before, beforeId: q.cursor.beforeId } : {}),
      })}`,
    ),
};

export interface PlanDetail extends Plan {
  is_active: boolean;
  created_at: string;
  /** Live clinics on the plan: everything but deleted. */
  clinic_count: number;
  /** Active and out of trial — what the next billing run invoices. */
  paying_count: number;
  /** Minor units: price × paying clinics. */
  mrr: number;
}

export type ActivityCategory = 'clinics' | 'billing' | 'plans';

export interface ActivityCursor {
  before: string;
  beforeId: string;
}

export interface ActivityEntry {
  id: string;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  tenant_id: string | null;
  tenant_name: string | null;
  subdomain: string | null;
  invoice_number: string | null;
  plan_name: string | null;
}

export interface ActivityPage {
  rows: ActivityEntry[];
  next: ActivityCursor | null;
}

export const PAYMENT_METHODS = ['bank_transfer', 'card', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: 'Bank transfer',
  card: 'Card',
  cash: 'Cash',
  other: 'Other',
};

export interface MarkPaidInput {
  method: PaymentMethod;
  amount?: number;
  paidAt?: string;
  reference?: string;
  note?: string;
}

export interface BillingSummary {
  /** Recurring revenue the active, out-of-trial clinics represent. */
  mrr: number;
  openCount: number;
  openTotal: number;
  overdueCount: number;
  overdueTotal: number;
  paidThisMonth: number;
  invoicedThisMonth: number;
  /** Active clinics with a plan that this month's run has not billed yet. */
  unbilledClinics: number;
}

export interface SubscriptionInvoice {
  id: string;
  number: string;
  tenantId: string;
  tenantName: string;
  subdomain: string;
  tenantStatus: string;
  periodStart: string;
  periodEnd: string;
  planCode: string | null;
  planName: string | null;
  amount: number;
  currency: string;
  status: 'open' | 'paid' | 'void' | 'uncollectible';
  issuedAt: string;
  dueDate: string;
  paidAt: string | null;
  paidAmount: number | null;
  method: PaymentMethod | null;
  reference: string | null;
  note: string | null;
  /** Derived server-side against the database's own clock, never stored. */
  overdue: boolean;
  daysLate: number;
}

export interface StorageByKind {
  kind: string;
  files: number;
  bytes: number;
}

export interface TenantUsageRow {
  tenantId: string;
  name: string;
  subdomain: string;
  status: string;
  planName: string | null;
  createdAt: string;
  users: number;
  patients: number;
  appointments: number;
  appointments30d: number;
  invoices: number;
  documents: number;
  storageBytes: number;
  lastActivity: string | null;
}

export interface FleetUsage {
  totals: {
    clinics: number;
    users: number;
    patients: number;
    appointments: number;
    invoices: number;
    documents: number;
    storageBytes: number;
  };
  tenants: TenantUsageRow[];
  storageByKind: StorageByKind[];
  /** Soft-deleted documents: storage we still pay for, no clinic can see. */
  reclaimable: { files: number; bytes: number };
}

export interface TenantUsage extends TenantUsageRow {
  storageByKind: StorageByKind[];
  months: { month: string; appointments: number; invoices: number; revenue: number }[];
}

/**
 * A password to hand to a clinic on day one. Readable over the phone, and
 * from `crypto.getRandomValues` rather than Math.random — this is a real
 * credential for a real clinic, even if it is only meant to last a week.
 */
export function generatePassword(): string {
  // No I/l/1/O/0 — every one of them gets misread aloud or mistyped.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
