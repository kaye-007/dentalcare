/**
 * Shqip — the source of truth.
 *
 * This dictionary defines the key set; `en.ts` is typed as
 * `Record<MessageKey, string>` against it. That direction is deliberate: the
 * product ships to Albanian clinics, so Albanian is the language that must
 * never be incomplete. A key added here and forgotten in English fails `tsc`,
 * and so does an English key that no longer exists here.
 *
 * Keys are flat and dotted rather than nested, so a template literal like
 * `appt.status.${status}` resolves to a real union member and is checked at
 * compile time instead of falling through to the key text at runtime.
 */
export const sq = {
  /* ── navigation ─────────────────────────────────────────── */
  'nav.group.clinic': 'Klinika',
  'nav.group.finance': 'Financa',
  'nav.group.insights': 'Analiza',
  'nav.dashboard': 'Paneli',
  'nav.reservations': 'Rezervimet',
  'nav.patients': 'Pacientët',
  'nav.treatments': 'Trajtimet',
  'nav.staff': 'Stafi',
  'nav.rooms': 'Dhomat dhe oraret',
  'nav.invoices': 'Faturat',
  'nav.payments': 'Pagesat',
  'nav.expenses': 'Shpenzimet',
  'nav.financials': 'Financat',
  'nav.reports': 'Raportet',
  'nav.activity': 'Aktiviteti',
  'nav.settings': 'Cilësimet',
  'nav.open': 'Hap menunë',
  'nav.close': 'Mbyll menunë',
  'nav.workspace': 'Hapësira e klinikës',
  'nav.logout': 'Dil',
  'nav.reminderLog': 'Regjistri i kujtesave',

  /* ── roles ──────────────────────────────────────────────── */
  'role.admin': 'Mjeku',
  'role.receptionist': 'Recepsioni',

  /* ── appointment states ─────────────────────────────────── */
  'appt.status.scheduled': 'E planifikuar',
  'appt.status.checked_in': 'Ka mbërritur',
  'appt.status.in_progress': 'Në proces',
  'appt.status.completed': 'E përfunduar',
  'appt.status.cancelled': 'E anuluar',
  'appt.status.no_show': 'Nuk u paraqit',

  /* ── invoices ───────────────────────────────────────────── */
  'invoice.status.unpaid': 'E papaguar',
  'invoice.status.partially_paid': 'Pjesërisht',
  'invoice.status.paid': 'E paguar',
  'invoice.status.cancelled': 'E anuluar',
  'invoice.title': 'Faturat',
  'invoice.all': 'Të gjitha',
  'invoice.col.invoice': 'Fatura',
  'invoice.col.patient': 'Pacienti',
  'invoice.col.date': 'Data',
  'invoice.col.total': 'Totali',
  'invoice.col.paid': 'Paguar',
  'invoice.col.balance': 'Mbetja',
  'invoice.col.status': 'Statusi',
  'invoice.new': 'Faturë e re',
  'invoice.empty.title': 'Ende asnjë faturë',
  'invoice.empty.body':
    'Faturoni një trajtim të përfunduar, pastaj regjistroni sa pagoi pacienti.',
  'invoice.empty.cta': 'Krijoni faturën e parë',
  'invoice.search': 'Kërko faturë ose pacient…',

  /* ── quick actions ──────────────────────────────────────── */
  'quick.title': 'Veprime të shpejta',
  'quick.newAppointment': 'Takim i ri',
  'quick.addPatient': 'Shto pacient',
  'quick.newInvoice': 'Faturë e re',
  'quick.addExpense': 'Shto shpenzim',
  'quick.paused':
    'Shtimi është ndalur sepse prova ka mbaruar. Gjithçka që keni futur mbetet e lexueshme.',

  /* ── odontogram ─────────────────────────────────────────── */
  'tooth.condition.caries': 'Karies',
  'tooth.condition.restored': 'E mbushur',
  'tooth.condition.crown': 'Kurorë',
  'tooth.condition.bridge': 'Urë',
  'tooth.condition.veneer': 'Faseta',
  'tooth.condition.root_canal': 'Trajtim kanalar',
  'tooth.condition.implant': 'Implant',
  'tooth.condition.extracted': 'E hequr',
  'tooth.condition.missing': 'Mungon',
  'tooth.condition.impacted': 'E bllokuar',
  'tooth.condition.fractured': 'E thyer',
  'tooth.condition.sealant': 'Sigjilim',
  'tooth.condition.watch': 'Në vëzhgim',
  'tooth.family.pathology': 'Patologji aktive',
  'tooth.family.restoration': 'Restaurim ekzistues',
  'tooth.family.prosthetic': 'Protezë fikse',
  'tooth.family.absent': 'Mungon / jofunksionale',
  /** Tooltip on a charted tooth: "Dhëmbi 16 · Karies · Sipërfaqja O" */
  'tooth.tip.tooth': 'Dhëmbi {tooth}',
  'tooth.tip.surface': 'Sipërfaqja {surface}',
  'tooth.tip.healthy': 'Pa gjetje të regjistruara',
  'tooth.tip.select': 'Kliko për të regjistruar një gjetje',

  /* ── sign in ────────────────────────────────────────────── */
  'login.title': 'Hyni në klinikën tuaj',
  'login.subtitle': 'Menaxhoni pacientët, takimet dhe faturimin.',
  'login.email': 'Email',
  'login.password': 'Fjalëkalimi',
  'login.submit': 'Hyr',
  'login.submitting': 'Duke hyrë…',
  'login.google': 'Vazhdo me Google',
  'login.or': 'ose',
  'login.error': 'Diçka shkoi keq. Provoni sërish.',
  'login.admin.title': 'Konsola e platformës',
  'login.admin.subtitle': 'Menaxhoni klinikat, planet dhe provat.',

  /* ── settings ───────────────────────────────────────────── */
  'settings.language.title': 'Gjuha',
  'settings.language.label': 'Gjuha e ndërfaqes',
  'settings.language.hint':
    'Vlen vetëm për këtë pajisje. Kolegët tuaj mund të zgjedhin gjuhën e tyre.',

  /* ── shared ─────────────────────────────────────────────── */
  'common.cancel': 'Anulo',
  'common.save': 'Ruaj',
  'common.loading': 'Duke u ngarkuar…',
  'common.search': 'Kërko',
} as const;

/** Every key the application may ask for. */
export type MessageKey = keyof typeof sq;
