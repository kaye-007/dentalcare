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
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  auth = true,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  // In production the subdomain (Host) identifies the clinic. For local dev
  // we send it explicitly; defaults to the demo clinic.
  const tenant =
    (import.meta.env.VITE_TENANT_SUBDOMAIN as string | undefined) ?? 'avicena';
  headers.set('X-Tenant-Subdomain', tenant);
  if (auth && tokenStore.access) {
    headers.set('Authorization', `Bearer ${tokenStore.access}`);
  }

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.message)
        ? body.message.join(', ')
        : body.message ?? message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'owner' | 'frontdesk';
  tenantId: string;
  clinicName: string;
}

export interface PatientListItem {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  status: 'active' | 'inactive';
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
  status: 'active' | 'inactive';
  createdAt: string;
  notes: PatientNote[];
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
};

// Drop empty-string optionals so the API doesn't reject them on validation.
function clean(p: PatientPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v !== '' && v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/* ── Appointments (M6) ──────────────────────────────────── */
export type ApptStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';
export interface Appointment {
  id: string;
  patientId: string;
  patientName: string;
  staffId: string | null;
  staffName: string | null;
  reason: string;
  status: ApptStatus;
  startsAt: string;
  endsAt: string;
}
export interface StaffMember {
  id: string;
  fullName: string;
  role: 'owner' | 'frontdesk';
  status: 'active' | 'disabled';
  position: string | null;
}
export interface AppointmentPayload {
  patientId: string;
  staffId?: string;
  startsAt: string;
  endsAt: string;
  reason: string;
}

export const appointmentsApi = {
  list(params: { from?: string; to?: string; patientId?: string }) {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.patientId) qs.set('patientId', params.patientId);
    const s = qs.toString();
    return request<Appointment[]>(`/appointments${s ? `?${s}` : ''}`);
  },
  create(p: AppointmentPayload) {
    return request<Appointment>('/appointments', { method: 'POST', body: JSON.stringify(p) });
  },
  update(id: string, p: Partial<AppointmentPayload> & { status?: ApptStatus }) {
    return request<Appointment>(`/appointments/${id}`, { method: 'PATCH', body: JSON.stringify(p) });
  },
  staff() {
    return request<StaffMember[]>('/staff');
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
export interface ToothRecord {
  id: string;
  tooth: number;
  condition: string;
  status: 'pending' | 'done';
  note: string | null;
  recordedAt: string;
  treatmentId: string | null;
  treatmentName: string | null;
  dentistId: string | null;
  dentistName: string | null;
}
export interface ToothRecordPayload {
  tooth: number;
  condition: string;
  treatmentId?: string;
  dentistId?: string;
  status?: 'pending' | 'done';
  note?: string;
}

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
    return request<Treatment>(`/treatments/${id}`, { method: 'PATCH', body: JSON.stringify(p) });
  },
};

export const medicalRecordApi = {
  list(patientId: string) {
    return request<ToothRecord[]>(`/patients/${patientId}/medical-record`);
  },
  create(patientId: string, p: ToothRecordPayload) {
    return request<ToothRecord>(`/patients/${patientId}/medical-record`, {
      method: 'POST',
      body: JSON.stringify(p),
    });
  },
  update(recordId: string, p: Partial<ToothRecordPayload>) {
    return request<ToothRecord>(`/medical-record/${recordId}`, {
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
  role: 'owner' | 'frontdesk';
  status: 'active' | 'disabled';
  position: string | null;
  /** present only when the requester is the owner */
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
    fullName: string; email: string; password: string; role: 'owner' | 'frontdesk';
    position?: string; salaryAmount?: number; salaryNote?: string;
  }) {
    return request<StaffFull>('/staff', { method: 'POST', body: JSON.stringify(p) });
  },
  update(id: string, p: {
    fullName?: string; role?: 'owner' | 'frontdesk'; status?: 'active' | 'disabled';
    position?: string | null; salaryAmount?: number | null; salaryNote?: string | null;
  }) {
    return request<StaffFull>(`/staff/${id}`, { method: 'PATCH', body: JSON.stringify(p) });
  },
  recordSalaryPayment(staffId: string, p: { amount: number; paidOn?: string; note?: string }) {
    return request<SalaryPayment>(`/staff/${staffId}/salary-payments`, {
      method: 'POST', body: JSON.stringify(p),
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
    return request<ClinicSettings>('/settings', { method: 'PATCH', body: JSON.stringify(p) });
  },
};

/* ── Finance (M8) ───────────────────────────────────────── */
export type InvoiceStatus = 'unpaid' | 'partially_paid' | 'paid' | 'cancelled';
export type PaymentMethod = 'cash' | 'card' | 'bank';
export type ExpenseCategory = 'rent' | 'materials' | 'utilities' | 'salaries' | 'lab' | 'other';

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
export interface InvoicePayment {
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
export interface PaymentHistoryRow {
  id: string;
  amount: number;
  method: PaymentMethod;
  note: string | null;
  paidAt: string;
  invoiceId: string;
  invoiceNumber: string;
  patientName: string;
}
export interface ExpenseRow {
  id: string;
  category: ExpenseCategory;
  amount: number;
  expenseDate: string;
  note: string | null;
}
export interface FinanceSummary {
  period: 'month' | 'all';
  totalInvoiced: number;
  totalCollected: number;
  outstanding: number;
  totalExpenses: number;
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
    return request<InvoiceSummaryRow>('/invoices', { method: 'POST', body: JSON.stringify(p) });
  },
  cancelInvoice(id: string) {
    return request<InvoiceSummaryRow>(`/invoices/${id}/cancel`, { method: 'PATCH' });
  },
  recordPayment(invoiceId: string, p: { amount: number; method: PaymentMethod; note?: string }) {
    return request<InvoiceSummaryRow>(`/invoices/${invoiceId}/payments`, {
      method: 'POST', body: JSON.stringify(p),
    });
  },
  listPayments() {
    return request<PaymentHistoryRow[]>('/payments');
  },
  listExpenses(category?: string) {
    const s = category && category !== 'all' ? `?category=${category}` : '';
    return request<ExpenseRow[]>(`/expenses${s}`);
  },
  createExpense(p: { category: ExpenseCategory; amount: number; expenseDate?: string; note?: string }) {
    return request<ExpenseRow>('/expenses', { method: 'POST', body: JSON.stringify(p) });
  },
  deleteExpense(id: string) {
    return request<void>(`/expenses/${id}`, { method: 'DELETE' });
  },
  summary(period: 'month' | 'all' = 'month') {
    return request<FinanceSummary>(`/finance/summary?period=${period}`);
  },
};

/* ── Reports (M9, owner-only) ───────────────────────────── */
export interface ReportBreakdownRow { label: string; value: number }
export interface ReportDentistRow { label: string; total: number; completed: number }
export interface ReportTrendPoint { month: string; collected: number; expenses: number; profit: number }
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
  sendManual(appointmentId: string) {
    return request<Reminder>(`/appointments/${appointmentId}/reminders`, { method: 'POST' });
  },
};
