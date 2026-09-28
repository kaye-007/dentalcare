/**
 * Every user-facing string in the clinic app.
 *
 * This was a two-language system with a Shqip dictionary, a locale context, a
 * picker on the login screen and a toggle in Settings. It is now one table in
 * one language, because the product ships in English only.
 *
 * The table survived the language did not. Keeping the strings in one place
 * rather than inlining 147 of them across 26 components is worth it on its own:
 * it is the difference between changing a word once and grepping for it, and it
 * keeps the wording of the product reviewable as a single file. `t()` is a
 * lookup with interpolation, not a translation layer.
 */

const STRINGS = {
  /* ── navigation ─────────────────────────────────────────── */
  'nav.group.clinic': 'Clinic',
  'nav.group.finance': 'Finance',
  'nav.group.insights': 'Insights',
  'nav.dashboard': 'Dashboard',
  'nav.reservations': 'Calendar',
  'nav.calendar': 'Calendar',
  'nav.clinical': 'Clinical',
  'nav.clinicalToday': 'Today',
  'nav.allPatients': 'All patients',
  'nav.import': 'Import',
  'nav.recall': 'Recall',
  'nav.patients': 'Patients',
  'nav.treatments': 'Services & prices',
  'nav.staff': 'Staff',
  'nav.rooms': 'Rooms & hours',
  'nav.invoices': 'Invoices',
  'nav.payments': 'Payments',
  'nav.drawer': 'Cash drawer',
  'nav.fiscalQueue': 'Fiscalization',
  'nav.expenses': 'Expenses',
  'nav.financials': 'Overview',
  'nav.reports': 'Reports',
  'nav.activity': 'Activity',
  'nav.settings': 'Settings',
  'nav.clinicSettings': 'Settings',
  'nav.open': 'Open navigation',
  'nav.close': 'Close navigation',
  'nav.workspace': 'Clinic workspace',
  'nav.logout': 'Sign out',
  'nav.reminderLog': 'Reminder log',

  /* ── roles ──────────────────────────────────────────────── */
  'role.admin': 'Administrator',
  'role.dentist': 'Dentist',
  'role.hygienist': 'Hygienist',
  'role.assistant': 'Assistant',
  'role.receptionist': 'Reception',
  'role.accountant': 'Accountant',

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
  'quick.newAppointment': 'Book appointment',
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
  'tooth.chart.permanent': 'Tooth chart — permanent dentition',
  'tooth.chart.primary': 'Tooth chart — primary dentition',
  'tooth.side.right': 'RIGHT',
  'tooth.side.left': 'LEFT',
  'tooth.arch.upper': 'UPPER',
  'tooth.arch.lower': 'LOWER',

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

  /* ── inventory ──────────────────────────────────────────── */
  'nav.inventory': 'Inventory',
  'nav.lab': 'Lab work',
  'nav.messages': 'Messages',
  'inv.title': 'Inventory',
  'inv.meta': 'Clinic materials and supplies, and what is running out',
  'inv.tab.items': 'Items',
  'inv.tab.movements': 'Movements',
  'inv.search': 'Search item or category',
  'inv.filter.all': 'All',
  'inv.filter.low': 'Low stock',
  'inv.filter.archived': 'Archived',
  'inv.filter.category': 'All categories',
  'inv.add': 'Add item',
  'inv.empty.title': 'Nothing stocked yet',
  'inv.empty.body':
    'Add gloves, anaesthetic, filling material — anything you want to be told about before it runs out.',
  'inv.emptyLow.title': 'Nothing is running low',
  'inv.emptyLow.body': 'Every item is above its reorder level.',
  'inv.emptyArchived': 'No archived items.',
  'inv.col.item': 'Item',
  'inv.col.category': 'Category',
  'inv.col.inStock': 'In stock',
  'inv.col.minimum': 'Minimum',
  'inv.col.status': 'Status',
  'inv.col.updated': 'Updated',
  'inv.col.when': 'When',
  'inv.col.change': 'Change',
  'inv.col.after': 'After',
  'inv.col.who': 'Who',
  'inv.col.reason': 'Reason',
  'inv.badge.low': 'Low stock',
  'inv.badge.ok': 'In stock',
  'inv.stockIn': 'Add stock',
  'inv.stockOut': 'Use stock',
  'inv.count': 'Count stock',
  'inv.badge.out': 'Out of stock',
  'inv.alerts.title': 'Needs ordering',
  'inv.alerts.one': '1 item running low',
  'inv.alerts.many': '{count} items running low',
  'inv.alerts.none': 'Stock levels are fine',
  'inv.alerts.view': 'Open inventory',
  'inv.record': 'Record movement',
  'inv.history': 'History',
  'inv.movements.recent': 'Recent movements',
  'inv.movements.empty': 'No movements yet.',
  'inv.kind.receipt': 'Received',
  'inv.kind.usage': 'Used',
  'inv.kind.adjustment': 'Stock count',
  'inv.kind.write_off': 'Write-off',
  'inv.kind.receipt.help': 'New supply arrived.',
  'inv.kind.usage.help': 'Used treating patients.',
  'inv.kind.adjustment.help': 'You counted the shelf and it disagreed.',
  'inv.kind.write_off.help': 'Expired, damaged or lost.',
  'inv.form.name': 'Name',
  'inv.form.namePlaceholder': 'e.g. Latex gloves, size M',
  'inv.form.category': 'Category',
  'inv.form.categoryPlaceholder': 'e.g. Consumables',
  'inv.form.unit': 'Counted in',
  'inv.form.unitPlaceholder': 'box, piece, ml',
  'inv.form.opening': 'Opening stock',
  'inv.form.minimum': 'Warn me at or below',
  'inv.form.notes': 'Notes',
  'inv.form.amount': 'Quantity',
  'inv.form.counted': 'Quantity you counted',
  'inv.form.reason': 'Reason',
  'inv.form.reasonRequired': 'Reason (required)',
  'inv.form.reasonPlaceholder': 'What happened?',
  'inv.form.currentlyHave': 'You currently have {quantity} {unit}',
  'inv.action.archive': 'Archive',
  'inv.action.restore': 'Restore',
  'inv.action.edit': 'Edit',
  'inv.saved': 'Saved.',
  'inv.recorded': 'Recorded. {name}: {quantity} {unit} left.',
  'inv.archived': '"{name}" archived.',
  'inv.restored': '"{name}" restored.',
  'inv.error.generic': 'Something went wrong. Please try again.',
  'inv.archivedNote': 'This item is archived. Restore it to record movements against it.',
  'inv.filter.expiring': 'Expiring soon',
  'inv.emptyExpiring.title': 'Nothing is close to its expiry date',
  'inv.emptyExpiring.body': 'Lots inside their warning window will show here.',
  'inv.badge.expiring': 'Expires {date}',
  'inv.badge.expired': 'Expired {date}',
  'inv.badge.recalled': 'Recalled',
  'inv.expiry.one': '1 lot expiring soon',
  'inv.expiry.many': '{count} lots expiring soon',
  'inv.expiry.expired': '{count} past their date',
  'inv.expiry.recalled': 'Recalled stock still on the shelf: {items}',
  'inv.lots': 'Lots',
  'inv.lots.title': 'Lots — {name}',
  'inv.lots.empty': 'No lots yet. A lot is recorded when its stock is received.',
  'inv.lots.col.lot': 'Lot',
  'inv.lots.col.expires': 'Expires',
  'inv.lots.col.received': 'Received',
  'inv.lots.col.quantity': 'On hand',
  'inv.lots.noExpiry': 'No expiry date',
  'inv.lots.recall': 'Recall',
  'inv.lots.recallTitle': 'Recall lot {lot}',
  'inv.lots.recallBody':
    'A recalled lot can no longer be used on patients or restocked. Its stock stays on record until it is written off. A recall cannot be undone.',
  'inv.lots.recallReason': 'Why is it being recalled?',
  'inv.lots.recallReasonPlaceholder': 'e.g. Manufacturer notice 14/2026',
  'inv.lots.recalled': 'Lot {lot} recalled. Patients who received it: {count}.',
  'inv.lots.patients': 'Who received it',
  'inv.lots.usageTitle': 'Lot {lot} — who received it',
  'inv.lots.usageEmpty': 'Nothing from this lot has been recorded as used on a patient.',
  'inv.lots.unattributed':
    '{quantity} {unit} from this lot was recorded as used without a patient, and cannot be traced.',
  'inv.lots.col.patient': 'Patient',
  'inv.lots.col.procedure': 'Procedure',
  'inv.form.trackLots': 'Track lot numbers and expiry dates',
  'inv.form.trackLotsHelp':
    'For anything that expires or can be recalled — anaesthetic, composite, implants. Each delivery then records its lot, and what was used can be traced to the patient.',
  'inv.form.expiryWarning': 'Warn this many days before expiry',
  'inv.form.lotNumber': 'Lot number',
  'inv.form.lotNumberPlaceholder': 'As printed on the packaging',
  'inv.form.expiresOn': 'Expiry date',
  'inv.form.lot': 'Lot',
  'inv.form.lotAuto': 'Earliest expiry first',
  'inv.form.lotChoose': 'Choose the lot',
  'inv.form.patient': 'Used for a patient',
  'inv.col.lot': 'Lot',
  'inv.col.patient': 'Patient',
} as const;

export type StringKey = keyof typeof STRINGS;

/**
 * Look up a string, filling `{name}` placeholders from `vars`.
 *
 * A key that does not exist returns the key itself rather than `undefined`, so
 * a typo shows up on screen as `patients.title` instead of blanking the label
 * it was meant to be.
 */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  const template: string = STRINGS[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * The locale for Intl date, time and number formatting.
 *
 * Fixed at en-GB: day before month, 24-hour clock, which is what an Albanian
 * clinic reads correctly. It is deliberately NOT the browser locale — a
 * receptionist whose laptop is set to en-US would otherwise see 03/09 as the
 * ninth of March on an appointment list everyone else reads as the third of
 * September.
 */
export function dateLocale(): string {
  return 'en-GB';
}
