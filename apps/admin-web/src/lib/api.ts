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
  staff: { email: string; full_name: string; role: string; status: string }[];
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
};
