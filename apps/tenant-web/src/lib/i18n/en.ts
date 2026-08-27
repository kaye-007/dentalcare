import type { MessageKey } from './sq';

/**
 * English.
 *
 * Typed as `Record<MessageKey, string>` against the Shqip dictionary, so the
 * compiler enforces both directions: a key added to `sq.ts` and forgotten here
 * is a missing-property error, and a key removed there but left here is an
 * unknown-property error. Neither can reach a user as a raw `nav.dashboard`
 * on screen.
 */
export const en: Record<MessageKey, string> = {
  /* ── navigation ─────────────────────────────────────────── */
  'nav.group.clinic': 'Clinic',
  'nav.group.finance': 'Finance',
  'nav.group.insights': 'Insights',
  'nav.dashboard': 'Dashboard',
  'nav.reservations': 'Reservations',
  'nav.patients': 'Patients',
  'nav.treatments': 'Treatments',
  'nav.staff': 'Staff',
  'nav.rooms': 'Rooms & hours',
  'nav.invoices': 'Invoices',
  'nav.payments': 'Payments',
  'nav.expenses': 'Expenses',
  'nav.financials': 'Financials',
  'nav.reports': 'Reports',
  'nav.activity': 'Activity',
  'nav.settings': 'Settings',
  'nav.open': 'Open navigation',
  'nav.close': 'Close navigation',
  'nav.workspace': 'Clinic workspace',
  'nav.logout': 'Sign out',
  'nav.reminderLog': 'Reminder log',

  /* ── roles ──────────────────────────────────────────────── */
  'role.admin': 'Doctor',
  'role.receptionist': 'Reception',

  /* ── appointment states ─────────────────────────────────── */
  'appt.status.scheduled': 'Scheduled',
  'appt.status.checked_in': 'Checked in',
  'appt.status.in_progress': 'In progress',
  'appt.status.completed': 'Completed',
  'appt.status.cancelled': 'Cancelled',
  'appt.status.no_show': 'No-show',

  /* ── invoices ───────────────────────────────────────────── */
  'invoice.status.unpaid': 'Unpaid',
  'invoice.status.partially_paid': 'Partial',
  'invoice.status.paid': 'Paid',
  'invoice.status.cancelled': 'Cancelled',
  'invoice.title': 'Invoices',
  'invoice.all': 'All',
  'invoice.col.invoice': 'Invoice',
  'invoice.col.patient': 'Patient',
  'invoice.col.date': 'Date',
  'invoice.col.total': 'Total',
  'invoice.col.paid': 'Paid',
  'invoice.col.balance': 'Balance',
  'invoice.col.status': 'Status',
  'invoice.new': 'New invoice',
  'invoice.empty.title': 'No invoices yet',
  'invoice.empty.body':
    'Bill a finished treatment, then record what the patient paid against it.',
  'invoice.empty.cta': 'Create your first invoice',
  'invoice.search': 'Search invoice or patient…',

  /* ── quick actions ──────────────────────────────────────── */
  'quick.title': 'Quick actions',
  'quick.newAppointment': 'New appointment',
  'quick.addPatient': 'Add patient',
  'quick.newInvoice': 'New invoice',
  'quick.addExpense': 'Add expense',
  'quick.paused':
    'Adding is paused while your trial is over. Everything already in the clinic stays readable.',

  /* ── odontogram ─────────────────────────────────────────── */
  'tooth.condition.caries': 'Caries',
  'tooth.condition.restored': 'Restored / filling',
  'tooth.condition.crown': 'Crown',
  'tooth.condition.bridge': 'Bridge',
  'tooth.condition.veneer': 'Veneer',
  'tooth.condition.root_canal': 'Root canal',
  'tooth.condition.implant': 'Implant',
  'tooth.condition.extracted': 'Extracted',
  'tooth.condition.missing': 'Missing',
  'tooth.condition.impacted': 'Impacted',
  'tooth.condition.fractured': 'Fractured',
  'tooth.condition.sealant': 'Sealant',
  'tooth.condition.watch': 'Watch',
  'tooth.family.pathology': 'Active pathology',
  'tooth.family.restoration': 'Existing restoration',
  'tooth.family.prosthetic': 'Fixed prosthetic',
  'tooth.family.absent': 'Absent / non-functional',
  'tooth.tip.tooth': 'Tooth {tooth}',
  'tooth.tip.surface': 'Surface {surface}',
  'tooth.tip.healthy': 'No findings recorded',
  'tooth.tip.select': 'Click to record a finding',

  /* ── sign in ────────────────────────────────────────────── */
  'login.title': 'Sign in to your clinic',
  'login.subtitle': 'Manage patients, appointments, and billing.',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.google': 'Continue with Google',
  'login.or': 'or',
  'login.error': 'Something went wrong. Try again.',
  'login.admin.title': 'Platform console',
  'login.admin.subtitle': 'Manage clinics, plans and trials.',

  /* ── settings ───────────────────────────────────────────── */
  'settings.language.title': 'Language',
  'settings.language.label': 'Interface language',
  'settings.language.hint':
    'Applies to this device only. Your colleagues can choose their own.',

  /* ── shared ─────────────────────────────────────────────── */
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.loading': 'Loading…',
  'common.search': 'Search',
};
