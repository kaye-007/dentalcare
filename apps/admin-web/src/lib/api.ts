const KEY = 'dcx.access';

export const token = {
  get: () => localStorage.getItem(KEY),
  set: (t: string) => localStorage.setItem(KEY, t),
  clear: () => localStorage.removeItem(KEY),
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, options: RequestInit = {}, auth = true): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (auth && token.get()) headers.set('Authorization', `Bearer ${token.get()}`);
  const res = await fetch(`/api${path}`, { ...options, headers });
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
export interface Plan {
  id: string;
  code: string;
  name: string;
  price_monthly: number;
}
export type TenantStatus = 'active' | 'suspended' | 'archived';
export interface TenantRow {
  id: string;
  name: string;
  subdomain: string;
  status: TenantStatus;
  plan_name: string | null;
  owner_email: string | null;
  user_count: string;
  trial_ends_at: string | null;
  created_at: string;
}
export interface AuditRow {
  id: string;
  actor_label: string;
  action: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface TenantDetail {
  id: string;
  name: string;
  subdomain: string;
  status: TenantStatus;
  plan_name: string | null;
  trial_ends_at: string | null;
  created_at: string;
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
    req<{ accessToken: string; admin: Admin }>(
      '/platform/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
      false,
    ),
  me: () => req<Admin>('/platform/auth/me'),
  plans: () => req<Plan[]>('/platform/plans'),
  tenants: () => req<TenantRow[]>('/platform/tenants'),
  tenant: (id: string) => req<TenantDetail>(`/platform/tenants/${id}`),
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
};

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
