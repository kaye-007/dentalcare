/**
 * Seed the DEMO environment: exactly ONE clinic, in Albanian lek, that looks
 * like a small Tirana practice ten weeks into using DentalCare.
 *
 *   DEMO_ENV=true npm run seed          (into an empty database)
 *   DEMO_ENV=true npm run demo:reset    (wipe, then seed — the usual way)
 *
 * Every person, phone number, address and price here is FICTIONAL demo data.
 * Prices are an illustrative private-clinic price list for the demo, not a
 * claim about any real clinic's fees.
 *
 * ── Why everything is planned first and written second ────────────────────
 *
 * The figures a demo shows have to agree with each other wherever they are
 * looked at: the invoice, the patient's balance (the ledger), the payments
 * list, the cash drawer, the monthly summary and the reports. So the seed
 * builds the whole clinic in memory — visits, then the invoices those visits
 * produced, then the payments against them, then the drawer sessions those
 * cash payments landed in — and only then writes it, the same rows the API
 * writes when a receptionist does the same work:
 *
 *   invoice          → invoice + line items + ledger 'charge'
 *   payment          → payment + ledger 'payment' (negative) + invoice status
 *   cash payment     → also a drawer 'cash_sale' event in that day's session
 *   day's end        → count, review (expected vs counted) and close
 *
 * Money is integer MINOR units (0006): 3,000 L is stored as 300000.
 *
 * Refuses to run unless DEMO_ENV=true; guarded against production hosts by
 * scripts/lib/guard.js. Re-running on an already seeded demo does nothing —
 * use `npm run demo:reset` for a clean slate.
 */
const path = require('path');
const { createHash } = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const {
  assertNotProduction,
  assertDemoEnvironment,
  assertSchemaCurrent,
} = require('./lib/guard');

const BCRYPT_ROUNDS = 10;
const L = (lek) => Math.round(lek * 100); // lek → minor units

/* ════════════════ demo identity ════════════════ */
const DEMO_PASSWORD = 'Demo@2026!';
const TZ = 'Europe/Tirane';

const CLINIC = {
  name: 'DEMO',
  subdomain: 'demo',
  address: 'Rruga e Demos 1',
  city: 'Tiranë',
  postalCode: '1001',
  phone: '+355 4 000 0000',
  email: 'info@dentx.app',
};

const PLATFORM_ADMIN = {
  email: 'admin@dentx.app',
  fullName: 'Administrator i Platformës',
};

/** Three treatment rooms. Each dentist has a home room (0019). */
const ROOMS = [
  { name: 'Salla 1', color: '#4f7cac', description: 'Stomatologji e përgjithshme' },
  { name: 'Salla 2', color: '#5b9a8b', description: 'Endodonti dhe higjienë' },
  { name: 'Salla 3', color: '#b07d62', description: 'Kirurgji dhe implante' },
];

/**
 * The team: one owner, three dentists, one receptionist. Fictional people.
 * Salaries are monthly, in lek. The owner draws from profit, not a salary.
 */
const STAFF = [
  {
    key: 'owner',
    email: 'demo@dentx.app',
    fullName: 'Dr. Erion Hoxha',
    role: 'admin',
    position: 'Pronar i klinikës',
    salary: null,
    seesPatients: false,
  },
  {
    key: 'ardit',
    email: 'a.hoxha@dentx.app',
    fullName: 'Dr. Ardit Hoxha',
    role: 'dentist',
    position: 'Stomatolog i përgjithshëm',
    salary: 150000,
    seesPatients: true,
    room: 0,
  },
  {
    key: 'elira',
    email: 'e.dervishi@dentx.app',
    fullName: 'Dr. Elira Dervishi',
    role: 'dentist',
    position: 'Endodontiste',
    salary: 145000,
    seesPatients: true,
    room: 1,
  },
  {
    key: 'besnik',
    email: 'b.kola@dentx.app',
    fullName: 'Dr. Besnik Kola',
    role: 'dentist',
    position: 'Kirurg oral',
    salary: 160000,
    seesPatients: true,
    room: 2,
  },
  {
    key: 'ana',
    email: 'reception@dentx.app',
    fullName: 'Ana Kola',
    role: 'receptionist',
    position: 'Recepsioniste',
    salary: 60000,
    seesPatients: false,
  },
];
const DOCTORS = ['ardit', 'elira', 'besnik'];

/**
 * DEMO price list, in lek. Names are Albanian only, as a Tirana clinic
 * writes its own list; the UI around them stays English.
 *
 * key, name, price (L), minutes, visit type, lab cost (L, for expenses)
 */
const SERVICES = [
  ['consult', 'Konsultë', 1500, 20, 'single', 0],
  ['exam', 'Kontroll periodik', 2000, 30, 'single', 0],
  ['xray', 'Radiografi periapikale', 1000, 10, 'single', 0],
  ['opg', 'Radiografi panoramike (OPG)', 3000, 15, 'single', 0],
  ['cleaning', 'Pastrim profesional', 4000, 45, 'single', 0],
  ['scaling', 'Heqje guri', 3000, 30, 'single', 0],
  ['polish', 'Polirim', 1500, 15, 'single', 0],
  ['whitening', 'Zbardhim dhëmbësh', 20000, 75, 'single', 0],
  ['composite', 'Mbushje kompoziti', 4000, 40, 'single', 0],
  ['tempfill', 'Mbushje e përkohshme', 1500, 20, 'single', 0],
  ['rct1', 'Trajtim kanali, 1 kanal', 8000, 60, 'multiple', 0],
  ['rctm', 'Trajtim kanali, shumë kanale', 14000, 90, 'multiple', 0],
  ['extract', 'Ekstraksion dhëmbi', 3000, 30, 'single', 0],
  ['surgext', 'Ekstraksion kirurgjikal', 8000, 60, 'single', 0],
  ['implant', 'Implant dentar', 60000, 90, 'multiple', 0],
  ['abutment', 'Abatment', 15000, 30, 'single', 5000],
  ['pfm', 'Kurorë metal-qeramike', 12000, 60, 'multiple', 4000],
  ['zirconia', 'Kurorë zirkoni', 25000, 60, 'multiple', 8000],
  ['emax', 'Kurorë E-max', 30000, 60, 'multiple', 9000],
  ['tempcrown', 'Kurorë e përkohshme', 3000, 30, 'single', 0],
  ['cement', 'Cementim kurore', 2000, 20, 'single', 0],
  ['post', 'Kunj dhe kore', 6000, 45, 'single', 0],
  ['veneer', 'Fasetë porcelani', 30000, 60, 'multiple', 9000],
  ['compveneer', 'Fasetë kompoziti', 10000, 60, 'single', 0],
  ['bridge', 'Urë dentare, për element', 12000, 60, 'multiple', 4000],
  ['fulldenture', 'Protezë totale', 45000, 45, 'multiple', 15000],
  ['partialdenture', 'Protezë parciale', 35000, 45, 'multiple', 12000],
  ['nightguard', 'Pllakë nate', 10000, 30, 'single', 3000],
  ['retainer', 'Aparat retencioni', 12000, 30, 'single', 3500],
  ['perio', 'Trajtim periodontal', 8000, 60, 'multiple', 0],
];
const SERVICE = Object.fromEntries(
  SERVICES.map(([key, name, price, minutes, visitType, lab]) => [
    key,
    { key, name, price: L(price), minutes, visitType, lab: L(lab) },
  ]),
);

/**
 * What people come in for, and what each visit bills. Weights are per
 * dentist [Ardit, Elira, Besnik] — the surgeon does the implants, the
 * endodontist the root canals, and all three see check-ups.
 */
const VISITS = {
  checkup: ['Kontroll periodik', [['exam', 1]], [10, 6, 3]],
  newpt: [
    'Konsultë, pacient i ri',
    [
      ['consult', 1],
      ['xray', 1],
    ],
    [6, 5, 4],
  ],
  cleaning: ['Pastrim profesional', [['cleaning', 1]], [8, 8, 1]],
  scaling: [
    'Heqje guri dhe polirim',
    [
      ['scaling', 1],
      ['polish', 1],
    ],
    [3, 5, 1],
  ],
  filling: ['Mbushje kompoziti', [['composite', 1]], [12, 7, 2]],
  filling2: ['Mbushje kompoziti, dy dhëmbë', [['composite', 2]], [4, 3, 1]],
  rct: ['Trajtim kanali', [['rctm', 1]], [1, 8, 0]],
  rct1: ['Trajtim kanali, dhëmb i përparmë', [['rct1', 1]], [1, 5, 0]],
  rct2: ['Trajtim kanali, seanca e dytë', [], [0, 0, 0]],
  extraction: ['Ekstraksion dhëmbi', [['extract', 1]], [2, 1, 6]],
  surgical: [
    'Ekstraksion kirurgjikal',
    [
      ['surgext', 1],
      ['opg', 1],
    ],
    [0, 0, 5],
  ],
  implant: ['Vendosje implanti', [['implant', 1]], [0, 0, 3]],
  abutment: ['Abatment implanti', [['abutment', 1]], [0, 0, 2]],
  zirconia: ['Kurorë zirkoni', [['zirconia', 1]], [3, 1, 1]],
  emax: ['Kurorë E-max', [['emax', 1]], [1, 0, 0]],
  pfm: ['Kurorë metal-qeramike', [['pfm', 1]], [3, 1, 1]],
  postcore: ['Kunj dhe kore', [['post', 1]], [1, 2, 0]],
  whitening: ['Zbardhim dhëmbësh', [['whitening', 1]], [2, 1, 0]],
  compveneer: ['Fasetë kompoziti', [['compveneer', 1]], [1, 1, 0]],
  nightguard: ['Pllakë nate', [['nightguard', 1]], [1, 1, 0]],
  perio: ['Trajtim periodontal', [['perio', 1]], [0, 5, 1]],
  partial: ['Protezë parciale', [['partialdenture', 1]], [1, 0, 1]],
  review: ['Kontroll pas trajtimit', [], [3, 3, 5]],
  emergency: ['Dhimbje dhëmbi, mbushje e përkohshme', [['tempfill', 1]], [2, 2, 1]],
};

/** Which teeth a tooth-level service lands on. FDI notation. */
const TEETH = {
  composite: [16, 17, 26, 27, 36, 37, 46, 47, 14, 15, 24, 25, 34, 35, 44, 45, 11, 21],
  tempfill: [16, 26, 36, 46, 37, 47],
  rctm: [16, 26, 36, 46, 17, 27, 37, 47],
  rct1: [11, 12, 13, 21, 22, 23],
  extract: [18, 28, 38, 48, 17, 47, 15, 25],
  surgext: [38, 48, 18, 28],
  implant: [36, 46, 26, 16, 35, 45],
  abutment: [36, 46, 26, 16],
  zirconia: [16, 26, 36, 46, 15, 25],
  emax: [11, 21, 12, 22],
  pfm: [36, 46, 37, 47],
  post: [16, 26, 36, 46],
  compveneer: [11, 21, 12, 22],
};
/** The chart condition a completed procedure leaves behind. */
const LEAVES = {
  composite: ['restored', true],
  rctm: ['root_canal', false],
  rct1: ['root_canal', false],
  extract: ['extracted', false],
  surgext: ['extracted', false],
  implant: ['implant', false],
  zirconia: ['crown', false],
  emax: ['crown', false],
  pfm: ['crown', false],
  compveneer: ['veneer', true],
};

/* ════════════════ fictional patients ════════════════ */

/**
 * The walkthrough patients. Each has a story the demo can be scripted
 * around; the rest of the list is generated below.
 */
const FEATURED = [
  { first: 'Arben', last: 'Hoxha', gender: 'male', born: '1968-04-12', city: 'Tiranë' },
  { first: 'Gentian', last: 'Meta', gender: 'male', born: '1975-09-03', city: 'Durrës' },
  { first: 'Erisa', last: 'Kola', gender: 'female', born: '1991-02-21', city: 'Tiranë' },
  {
    first: 'Klajdi',
    last: 'Dervishi',
    gender: 'male',
    born: '1999-11-08',
    city: 'Tiranë',
  },
  { first: 'Elona', last: 'Leka', gender: 'female', born: '1994-06-17', city: 'Tiranë' },
  { first: 'Sara', last: 'Hoxha', gender: 'female', born: '2012-01-29', city: 'Tiranë' },
  { first: 'Andi', last: 'Kola', gender: 'male', born: '1987-03-14', city: 'Tiranë' },
  {
    first: 'Bora',
    last: 'Dervishi',
    gender: 'female',
    born: '1996-08-25',
    city: 'Elbasan',
  },
  { first: 'Ermal', last: 'Leka', gender: 'male', born: '1979-12-02', city: 'Tiranë' },
  { first: 'Jona', last: 'Meta', gender: 'female', born: '1989-05-30', city: 'Tiranë' },
];
const F = Object.fromEntries(FEATURED.map((p, i) => [`${p.first} ${p.last}`, i]));

const MALE = [
  'Alban',
  'Altin',
  'Ardian',
  'Arjan',
  'Armando',
  'Besart',
  'Bledar',
  'Dritan',
  'Edmond',
  'Elton',
  'Endri',
  'Enea',
  'Erald',
  'Fatjon',
  'Florian',
  'Gazmend',
  'Genc',
  'Ilir',
  'Indrit',
  'Jetmir',
  'Julian',
  'Klevis',
  'Kristi',
  'Leonard',
  'Lorenc',
  'Mario',
  'Marsel',
  'Mikel',
  'Olsi',
  'Orges',
  'Petrit',
  'Redon',
  'Rigers',
  'Sokol',
  'Taulant',
  'Valon',
  'Xhoni',
  'Ylli',
];
const FEMALE = [
  'Alketa',
  'Anisa',
  'Anxhela',
  'Arta',
  'Besiana',
  'Blerina',
  'Brikena',
  'Dorina',
  'Ela',
  'Elda',
  'Elsa',
  'Enkeleda',
  'Era',
  'Esmeralda',
  'Fjona',
  'Floriana',
  'Gerta',
  'Ina',
  'Irena',
  'Jonida',
  'Kejsi',
  'Klea',
  'Ledia',
  'Lindita',
  'Lorena',
  'Megi',
  'Mimoza',
  'Nertila',
  'Oriola',
  'Rovena',
  'Sidorela',
  'Teuta',
  'Valbona',
  'Xhesika',
  'Zamira',
];
const SURNAMES = [
  'Hoxha',
  'Kola',
  'Dervishi',
  'Leka',
  'Meta',
  'Shehu',
  'Krasniqi',
  'Berisha',
  'Prifti',
  'Gjoni',
  'Bardhi',
  'Rama',
  'Dushku',
  'Çela',
  'Hasani',
  'Mema',
  'Zeqiri',
  'Balliu',
  'Sula',
  'Tafa',
  'Nikolla',
  'Frashëri',
  'Bushati',
  'Malaj',
  'Progni',
  'Duka',
  'Xhafa',
  'Kapllani',
  'Lika',
  'Marku',
  'Ndreu',
  'Pepa',
  'Qosja',
  'Rexha',
  'Shkurti',
  'Toska',
  'Vata',
  'Zhupa',
  'Brahimi',
  'Kurti',
];
const CITIES = [
  ['Tiranë', 14],
  ['Durrës', 3],
  ['Elbasan', 1],
  ['Kavajë', 1],
  ['Vorë', 1],
];
const STREETS = [
  'Rruga e Durrësit',
  'Rruga e Elbasanit',
  'Rruga Myslym Shyri',
  'Rruga e Dibrës',
  'Rruga Ali Demi',
  'Rruga e Kavajës',
  'Rruga Sami Frashëri',
  'Rruga Qemal Stafa',
];
const GENERATED_PATIENTS = 290;
/** Patients last seen six to eleven months ago, for the Recall list. */
const RECALL_PATIENTS = 24;

/* ════════════════ deterministic pseudo-random ════════════════
 * Seeded, so a reset on Monday and one on Friday build the same clinic
 * (shifted to the new "today"). */
let _seed = 20260927;
function rnd() {
  _seed = (_seed * 1103515245 + 12345) % 2147483648;
  return _seed / 2147483648;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
function weighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) {
    if ((r -= w) < 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

/* ════════════════ the clinic's clock ════════════════
 * Everything is placed on the clinic's wall clock (Europe/Tirane), whatever
 * zone the machine running the seed is in. */
const dtf = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
function wall(date) {
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return p;
}
function zoneOffsetMs(date) {
  const p = wall(date);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
/** A wall-clock time on a clinic day ("2026-09-27", 9*60+30) as an instant. */
function at(ymd, minutes) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const first = guess - zoneOffsetMs(new Date(guess));
  return new Date(guess - zoneOffsetMs(new Date(first)));
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Monday = 0, as clinic_settings.working_hours stores it. */
function weekday(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
const NOW = new Date();
const TODAY = (() => {
  const p = wall(NOW);
  return `${p.year}-${p.month}-${p.day}`;
})();
const minutesNow = (() => {
  const p = wall(NOW);
  return +p.hour * 60 + +p.minute;
})();

/**
 * Mon–Fri 09:00–18:00, weekends 09:00–14:00. The demo clinic opens on
 * Sundays too, so a demo reset on any day of the week has a "today" with
 * patients in it and an open cash drawer.
 */
const HOURS = [
  ...[0, 1, 2, 3, 4].map((day) => ({
    day,
    closed: false,
    open: '09:00',
    close: '18:00',
  })),
  { day: 5, closed: false, open: '09:00', close: '14:00' },
  { day: 6, closed: false, open: '09:00', close: '14:00' },
];
function hoursOf(ymd) {
  const h = HOURS[weekday(ymd)];
  if (h.closed) return null;
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return { open: toMin(h.open), close: toMin(h.close), weekend: weekday(ymd) >= 5 };
}
const isOpen = (ymd) => hoursOf(ymd) !== null;
function nextOpenDay(ymd) {
  let d = ymd;
  while (!isOpen(d)) d = addDays(d, 1);
  return d;
}
function prevOpenDay(ymd) {
  let d = addDays(ymd, -1);
  while (!isOpen(d)) d = addDays(d, -1);
  return d;
}

const HISTORY_DAYS = 70;
const FUTURE_DAYS = 21;

/* ════════════════ build: patients ════════════════ */
function phone() {
  // Random fictional mobiles in the Albanian format. The demo sends nothing:
  // reminders go to the log channel and no patient has WhatsApp consent.
  return `+355 6${int(7, 9)} ${int(200, 999)} ${int(1000, 9999)}`;
}
function emailOf(first, last, n) {
  // example.com is reserved (RFC 2606) and can never reach a real inbox.
  const local = `${first}.${last}${n ? n : ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z.0-9]/g, '');
  return `${local}@example.com`;
}

function buildPatients() {
  const staffNames = new Set(STAFF.map((s) => s.fullName.replace(/^Dr\. /, '')));
  const taken = new Set(FEATURED.map((p) => `${p.first} ${p.last}`));
  const patients = FEATURED.map((p) => ({ ...p, featured: true, established: true }));
  while (patients.length < FEATURED.length + GENERATED_PATIENTS) {
    const gender = rnd() < 0.52 ? 'female' : 'male';
    const first = pick(gender === 'female' ? FEMALE : MALE);
    const last = pick(SURNAMES);
    const full = `${first} ${last}`;
    if (taken.has(full) || staffNames.has(full)) continue;
    taken.add(full);
    const year = 1950 + int(0, 62);
    patients.push({
      first,
      last,
      gender,
      born: `${year}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
      city: weighted(CITIES),
      featured: false,
      // Established patients were registered before the demo's history
      // starts; the others walk in as new patients during it.
      established: rnd() < 0.62,
    });
  }
  for (const p of patients) {
    p.phone = phone();
    p.email = emailOf(p.first, p.last);
    p.address = `${pick(STREETS)} ${int(2, 148)}`;
    p.visits = [];
  }
  return patients;
}

/* ════════════════ build: the calendar ════════════════ */

/**
 * The walkthrough visits, placed before the random ones so nothing overlaps
 * them. [patient, dentist, day offset (open days are found from it), start
 * "HH:MM", visit, options]
 */
const STORY = [
  // Arben Hoxha — implant 36 with Dr. Kola; plan in progress, crown to come.
  ['Arben Hoxha', 'besnik', -63, '10:00', 'newpt'],
  [
    'Arben Hoxha',
    'besnik',
    -56,
    '10:00',
    'implant',
    { plan: 'arben', item: 0, tooth: 36 },
  ],
  [
    'Arben Hoxha',
    'besnik',
    0,
    '12:30',
    'review',
    { reason: 'Implant 36, kontroll shërimi' },
  ],
  ['Arben Hoxha', 'besnik', 14, '10:00', 'abutment', { reason: 'Implant 36, abatment' }],
  // Gentian Meta — two zirconia crowns, 50,000 L billed, 30,000 L paid.
  ['Gentian Meta', 'ardit', -34, '11:00', 'newpt'],
  ['Gentian Meta', 'ardit', -20, '11:00', 'zirconia', { plan: 'gentian', crowns: true }],
  [
    'Gentian Meta',
    'ardit',
    6,
    '11:30',
    'review',
    { reason: 'Kurorat 14 dhe 15, kontroll' },
  ],
  // Erisa Kola — root canal 46 in two sessions with Dr. Dervishi; crown proposed.
  ['Erisa Kola', 'elira', -7, '10:00', 'rct', { tooth: 46 }],
  ['Erisa Kola', 'elira', 0, '11:00', 'rct2', { reason: 'Kanali 46, seanca e dytë' }],
  // Klajdi Dervishi — registered today, first visit this afternoon.
  ['Klajdi Dervishi', 'ardit', 0, '16:30', 'newpt'],
  // Elona Leka — cleaning, then whitening; settled.
  ['Elona Leka', 'elira', -45, '15:00', 'cleaning'],
  ['Elona Leka', 'ardit', -30, '15:00', 'whitening', { method: 'card' }],
  // Sara Hoxha — a child's check-up and cleaning; recall in six months.
  ['Sara Hoxha', 'elira', -2, '16:00', 'cleaning', { reason: 'Kontroll dhe pastrim' }],
  // Andi Kola — missed last week, rebooked for tomorrow.
  ['Andi Kola', 'ardit', -5, '09:30', 'filling', { status: 'no_show' }],
  ['Andi Kola', 'ardit', 1, '10:30', 'filling'],
  // Bora Dervishi — consultation, cancelled a follow-up, veneers proposed.
  ['Bora Dervishi', 'ardit', -10, '14:00', 'newpt'],
  ['Bora Dervishi', 'ardit', -3, '14:00', 'compveneer', { status: 'cancelled' }],
  [
    'Bora Dervishi',
    'ardit',
    9,
    '14:00',
    'review',
    { reason: 'Plani i fasetave, vendim' },
  ],
  // Ermal Leka — surgical extraction 38 on the last open day, review next week.
  ['Ermal Leka', 'besnik', -1, '09:00', 'surgical', { tooth: 38, method: 'cash' }],
  [
    'Ermal Leka',
    'besnik',
    7,
    '09:00',
    'review',
    { reason: 'Ekstraksioni 38, heqje qepjesh' },
  ],
  // Jona Meta — two fillings first thing this morning.
  // Charted by the dentist but not billed yet: what "Bill" turns into an
  // invoice at the desk, with the two fillings already on it.
  ['Jona Meta', 'ardit', 0, '09:00', 'filling2', { unbilled: true }],
];

/** Scripted visits fall on weekdays, except the ones on today and yesterday. */
function storyDay(offset) {
  if (offset === 0) return TODAY;
  if (offset === -1) return prevOpenDay(TODAY);
  let d = addDays(TODAY, offset);
  while (weekday(d) >= 5) d = addDays(d, offset > 0 ? 1 : -1);
  return d;
}
const hhmm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

function durationOf(visitKey) {
  const lines = VISITS[visitKey][1];
  const sum = lines.reduce((s, [k, q]) => s + SERVICE[k].minutes * q, 0);
  const minutes = Math.max(30, Math.ceil(sum / 15) * 15);
  return Math.min(minutes, 90);
}

function statusFor(ymd, startMin, endMin, forced) {
  if (forced) return forced;
  if (ymd < TODAY) {
    const r = rnd();
    return r < 0.88 ? 'completed' : r < 0.95 ? 'cancelled' : 'no_show';
  }
  if (ymd > TODAY) return rnd() < 0.04 ? 'cancelled' : 'scheduled';
  if (endMin <= minutesNow) return rnd() < 0.94 ? 'completed' : 'no_show';
  if (startMin <= minutesNow) return 'in_progress';
  if (startMin - minutesNow <= 20) return 'checked_in';
  return 'scheduled';
}

function buildCalendar(patients) {
  const visits = [];
  /** booked[ymd][doctor] = [[start, end], …] */
  const booked = {};
  const busyPatients = {}; // ymd -> Set(patientIndex)
  const book = (ymd, doctor, s, e) => {
    booked[ymd] = booked[ymd] || {};
    (booked[ymd][doctor] = booked[ymd][doctor] || []).push([s, e]);
  };
  const free = (ymd, doctor, s, e) =>
    !((booked[ymd] || {})[doctor] || []).some(([a, b]) => s < b && a < e);

  for (const [name, doctor, offset, start, visitKey, opts = {}] of STORY) {
    const ymd = storyDay(offset);
    const h = hoursOf(ymd);
    const dur = durationOf(visitKey);
    // A short day (weekend) pulls a late visit back inside opening hours; a
    // clash with another scripted visit moves it along by half an hour.
    let s = Math.min(hhmm(start), h.close - dur - 15);
    while (!free(ymd, doctor, s, s + dur) && s + dur < h.close) s += 30;
    const e = s + dur;
    const patient = F[name];
    book(ymd, doctor, s, e);
    (busyPatients[ymd] = busyPatients[ymd] || new Set()).add(patient);
    visits.push({ ymd, start: s, end: e, doctor, patient, visitKey, opts, story: true });
  }

  const newcomers = patients
    .map((p, i) => (!p.featured && !p.established ? i : -1))
    .filter((i) => i >= 0);
  // Recall: some established patients were last in six to eleven months ago
  // and have not been back. They are kept out of the daily calendar below.
  const lapsed = patients
    .map((p, i) => (!p.featured && p.established ? i : -1))
    .filter((i) => i >= 0)
    .slice(0, RECALL_PATIENTS);
  const lapsedSet = new Set(lapsed);
  const seen = new Set(
    patients
      .map((p, i) => (!p.featured && p.established && !lapsedSet.has(i) ? i : -1))
      .filter((i) => i >= 0),
  );
  let nextNewcomer = 0;

  for (let offset = -HISTORY_DAYS; offset <= FUTURE_DAYS; offset++) {
    const ymd = addDays(TODAY, offset);
    const h = hoursOf(ymd);
    if (!h) continue;
    const fill =
      (offset < 0
        ? 0.62
        : offset === 0
          ? 0.8
          : offset <= 7
            ? 0.55
            : offset <= 14
              ? 0.35
              : 0.2) * (h.weekend && offset !== 0 ? 0.6 : 1);
    const busy = (busyPatients[ymd] = busyPatients[ymd] || new Set());
    for (const [di, doctor] of DOCTORS.entries()) {
      let t = h.open;
      while (t < h.close) {
        // Lunch on weekdays, 13:00–13:30.
        if (!h.weekend && t >= 13 * 60 && t < 13 * 60 + 30) {
          t = 13 * 60 + 30;
          continue;
        }
        let visitKey = weighted(Object.entries(VISITS).map(([k, v]) => [k, v[2][di]]));
        const dur = durationOf(visitKey);
        const end = t + dur;
        const crossesLunch = !h.weekend && t < 13 * 60 && end > 13 * 60;
        if (end > h.close || crossesLunch || !free(ymd, doctor, t, end) || rnd() > fill) {
          t += 30;
          continue;
        }
        // A new patient's consultation is their first visit; everyone else
        // is somebody the clinic has seen before.
        let patient = -1;
        if (visitKey === 'newpt' && nextNewcomer < newcomers.length) {
          patient = newcomers[nextNewcomer++];
        } else {
          if (visitKey === 'newpt') visitKey = 'checkup';
          const pool = [...seen];
          for (let tries = 0; tries < 12; tries++) {
            const c = pick(pool);
            if (!busy.has(c)) {
              patient = c;
              break;
            }
          }
        }
        if (patient < 0) {
          t += 30;
          continue;
        }
        const realEnd = t + durationOf(visitKey);
        busy.add(patient);
        seen.add(patient);
        book(ymd, doctor, t, realEnd);
        visits.push({ ymd, start: t, end: realEnd, doctor, patient, visitKey, opts: {} });
        t = realEnd + (rnd() < 0.3 ? 15 : 0);
      }
    }
  }

  // Their last visit, before the ten weeks of daily history: paid by card at
  // the time, since the drawer only covers the history window.
  for (const patient of lapsed) {
    let ymd = addDays(TODAY, -int(190, 330));
    while (weekday(ymd) >= 5) ymd = addDays(ymd, -1);
    const doctor = pick(DOCTORS);
    const visitKey = rnd() < 0.5 ? 'checkup' : 'cleaning';
    const dur = durationOf(visitKey);
    let s = 9 * 60 + int(0, 14) * 30;
    while (!free(ymd, doctor, s, s + dur)) s += 30;
    book(ymd, doctor, s, s + dur);
    visits.push({
      ymd,
      start: s,
      end: s + dur,
      doctor,
      patient,
      visitKey,
      opts: { status: 'completed', method: 'card' },
    });
  }

  visits.sort((a, b) => (a.ymd === b.ymd ? a.start - b.start : a.ymd < b.ymd ? -1 : 1));
  for (const v of visits) {
    // A scripted visit in the past happened as scripted; one today follows
    // the clock without chance, so a walkthrough patient is never a no-show.
    const scriptedToday =
      v.ymd !== TODAY
        ? undefined
        : v.end <= minutesNow
          ? 'completed'
          : v.start <= minutesNow
            ? 'in_progress'
            : v.start - minutesNow <= 20
              ? 'checked_in'
              : 'scheduled';
    const forced =
      v.opts.status ||
      (v.story ? (v.ymd < TODAY ? 'completed' : scriptedToday) : undefined);
    v.status = statusFor(v.ymd, v.start, v.end, forced);
    v.startsAt = at(v.ymd, v.start);
    v.endsAt = at(v.ymd, v.end);
    v.reason = v.opts.reason || VISITS[v.visitKey][0];
    patients[v.patient].visits.push(v);
  }
  return visits;
}

/* ════════════════ build: money ════════════════ */

function methodFor(total, later) {
  if (later)
    return weighted([
      ['bank', 4],
      ['cash', 4],
      ['card', 2],
    ]);
  if (total > L(20000))
    return weighted([
      ['card', 5],
      ['cash', 3],
      ['bank', 2],
    ]);
  return weighted([
    ['cash', 6],
    ['card', 4],
  ]);
}
const roundTo = (minor, lek) => Math.round(minor / L(lek)) * L(lek);

/** Only instants that have already happened can carry a payment. */
function paidAtOn(ymd, minute) {
  const t = at(ymd, minute);
  return t.getTime() < NOW.getTime() ? t : null;
}
function laterPaymentDay(ymd, minDays, maxDays) {
  const d = nextOpenDay(addDays(ymd, int(minDays, maxDays)));
  return d <= TODAY ? d : null;
}

/** Completed visits whose work is charted but not yet invoiced. */
const UNBILLED = [];

function buildMoney(patients, visits) {
  const invoices = [];
  for (const v of visits) {
    if (v.status !== 'completed') continue;
    const spec = VISITS[v.visitKey][1];
    if (!spec.length) continue;
    const lines = [];
    for (const [key, qty] of spec) {
      const svc = SERVICE[key];
      // Tooth-level work is one line per tooth, so each line can carry its
      // tooth and the procedure performed on it.
      const teeth = TEETH[key];
      if (teeth) {
        const used = new Set();
        for (let n = 0; n < qty; n++) {
          let tooth = v.opts.tooth && n === 0 ? v.opts.tooth : pick(teeth);
          for (let k = 0; used.has(tooth) && k < 8; k++) tooth = pick(teeth);
          used.add(tooth);
          lines.push({ svc, qty: 1, tooth });
        }
      } else {
        lines.push({ svc, qty, tooth: null });
      }
    }
    if (v.opts.crowns) {
      // Gentian Meta: crowns on 14 and 15 — the 50,000 L invoice.
      lines.length = 0;
      lines.push({ svc: SERVICE.zirconia, qty: 1, tooth: 14 });
      lines.push({ svc: SERVICE.zirconia, qty: 1, tooth: 15 });
    }
    if (v.opts.unbilled) {
      UNBILLED.push({ visit: v, patient: v.patient, lines });
      continue;
    }
    const total = lines.reduce((s, l) => s + l.svc.price * l.qty, 0);
    invoices.push({
      visit: v,
      patient: v.patient,
      lines,
      total,
      ymd: v.ymd,
      payments: [],
    });
  }

  for (const inv of invoices) {
    const v = inv.visit;
    const age = Math.round((at(TODAY, 0) - at(inv.ymd, 0)) / 86400000);
    const atVisit = paidAtOn(inv.ymd, Math.min(v.end + 5, 23 * 60));
    const clampNow = () => new Date(NOW.getTime() - 60000);
    const payNow = (amount, method) =>
      inv.payments.push({ amount, method, at: atVisit || clampNow(), ymd: inv.ymd });
    const payLater = (amount, minD, maxD) => {
      const day = laterPaymentDay(inv.ymd, minD, maxD);
      if (!day) return;
      const when = paidAtOn(day, int(10 * 60, 12 * 60));
      if (when)
        inv.payments.push({
          amount,
          method: methodFor(amount, true),
          at: when,
          ymd: day,
        });
    };

    const story = inv.visit.opts;
    if (story.crowns) {
      payNow(L(30000), 'cash'); // 20,000 L stays on Gentian's account
      continue;
    }
    if (story.plan === 'arben') {
      payNow(L(30000), 'card');
      payLater(L(30000), 20, 20);
      continue;
    }
    if (story.method) {
      payNow(inv.total, story.method);
      continue;
    }

    if (inv.total <= L(20000)) {
      if (rnd() < 0.9) payNow(inv.total, methodFor(inv.total));
      else if (age > 14) payLater(inv.total, 3, 10);
      // otherwise: still owed — the patient said they would pay next visit.
    } else {
      const deposit = roundTo(inv.total / 2, 1000);
      payNow(deposit, methodFor(inv.total));
      if (age > 30) payLater(inv.total - deposit, 14, 21);
    }
  }

  // Invoice numbers follow issue order, as they would at the desk.
  invoices.sort((a, b) => a.visit.endsAt - b.visit.endsAt);
  invoices.forEach((inv, i) => {
    inv.seq = i + 1;
    inv.number = `INV-${String(i + 1).padStart(4, '0')}`;
    inv.paid = inv.payments.reduce((s, p) => s + p.amount, 0);
    inv.status =
      inv.paid === 0 ? 'unpaid' : inv.paid >= inv.total ? 'paid' : 'partially_paid';
  });
  return invoices;
}

/* ════════════════ build: the cash drawer ════════════════ */
const FLOAT = L(20000);
/** One day in the demo's history where the count came up short. */
const SHORT_BY = L(500);

function eventHash(prevHash, e) {
  // Must match apps/api/src/modules/clinic/cash-drawer/drawer-ledger.ts, or
  // the chain the drawer screen verifies would read as tampered with.
  const payload = JSON.stringify([
    prevHash,
    e.sessionId,
    e.seq,
    e.type,
    e.currency,
    e.amount,
    e.paymentId,
    e.fiscalCashDepositId,
    e.approvalId,
    e.reason,
    e.actorUserId,
    e.occurredAt,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

/* ════════════════ build: stock ════════════════ */

/**
 * DEMO stock list. Generic descriptions, no brands and no suppliers.
 * [name, category, unit, on hand, minimum, lots?]
 */
const INVENTORY = [
  ['Rezinë kompoziti A2 (shiringë 4 g)', 'Materiale konsumi', 'shiringë', 14, 6],
  ['Rezinë kompoziti A3 (shiringë 4 g)', 'Materiale konsumi', 'shiringë', 9, 6],
  ['Kompozit fluid A2', 'Materiale konsumi', 'shiringë', 3, 4],
  ['Adeziv bonding (5 ml)', 'Materiale konsumi', 'shishe', 4, 2],
  ['Xhel acidi 37%', 'Materiale konsumi', 'shiringë', 10, 4],
  ['Cement glas-jonomer', 'Materiale konsumi', 'set', 2, 2],
  ['Material mbushjeje e përkohshme', 'Materiale konsumi', 'kavanoz', 3, 2],
  ['Alginat për masë (500 g)', 'Materiale konsumi', 'paketë', 6, 3],
  ['Silikon për masë (putty + light body)', 'Materiale konsumi', 'set', 0, 2],
  ['Cement rezinoz', 'Materiale konsumi', 'set', 3, 2],
  ['Xhel hemostatik', 'Materiale konsumi', 'shiringë', 5, 3],
  ['Artikainë 4% me epinefrinë (50 karpula)', 'Anestezi', 'kuti', 6, 3, true],
  ['Lidokainë 2% me epinefrinë (50 karpula)', 'Anestezi', 'kuti', 2, 2, true],
  ['Xhel anestezik sipërfaqësor', 'Anestezi', 'kavanoz', 3, 1],
  ['Doreza ekzaminimi, M (100)', 'Njëpërdorimshe', 'kuti', 22, 10],
  ['Doreza ekzaminimi, S (100)', 'Njëpërdorimshe', 'kuti', 8, 10],
  ['Doreza kirurgjikale sterile 7.5', 'Njëpërdorimshe', 'palë', 40, 20],
  ['Maska fytyre (50)', 'Njëpërdorimshe', 'kuti', 12, 6],
  ['Aspiratorë pështyme (100)', 'Njëpërdorimshe', 'qese', 5, 3],
  ['Maja aspiratori kirurgjikal (100)', 'Njëpërdorimshe', 'qese', 1, 2],
  ['Peceta pacienti (500)', 'Njëpërdorimshe', 'paketë', 3, 1],
  ['Maja shiringe ajër/ujë (250)', 'Njëpërdorimshe', 'qese', 2, 1],
  ['Gjilpëra 27G të shkurtra (100)', 'Njëpërdorimshe', 'kuti', 4, 2],
  ['Gjilpëra 30G të shkurtra (100)', 'Njëpërdorimshe', 'kuti', 0, 2],
  ['Rulona pambuku (1000)', 'Njëpërdorimshe', 'qese', 6, 2],
  ['Garza 5×5 cm (100)', 'Njëpërdorimshe', 'paketë', 9, 4],
  ['Mikrofurça (100)', 'Njëpërdorimshe', 'paketë', 4, 2],
  ['Limë K 15–40 (6)', 'Endodonti', 'paketë', 12, 6],
  ['Limë H 15–40 (6)', 'Endodonti', 'paketë', 5, 4],
  ['Limë rrotulluese, të përziera (6)', 'Endodonti', 'paketë', 7, 5],
  ['Kone guta-perke', 'Endodonti', 'kuti', 6, 3],
  ['Kone letre', 'Endodonti', 'kuti', 3, 3],
  ['Hipoklorit natriumi 3% (1 L)', 'Endodonti', 'shishe', 4, 2],
  ['Siler endodontik', 'Endodonti', 'tub', 2, 1],
  ['Material kurore e përkohshme', 'Protetikë', 'kartuç', 3, 2],
  ['Lugë mase plastike (të përziera)', 'Protetikë', 'paketë', 5, 2],
  ['Fije retraksioni #0', 'Protetikë', 'shishe', 2, 1],
  ['Fije retraksioni #1', 'Protetikë', 'shishe', 1, 1],
  ['Cement i përkohshëm', 'Protetikë', 'tub', 3, 2],
  ['Qese sterilizimi 90×260 mm (200)', 'Sterilizim', 'kuti', 7, 4],
  ['Shirita treguese autoklave (250)', 'Sterilizim', 'paketë', 2, 1],
  ['Dezinfektant instrumentesh (5 L)', 'Sterilizim', 'bidon', 2, 1],
  ['Letra dezinfektuese sipërfaqesh', 'Sterilizim', 'enë', 9, 6],
  ['Dezinfektant duarsh (1 L)', 'Sterilizim', 'shishe', 5, 3],
  ['Braketa metalike, set pacienti', 'Ortodonci', 'set', 4, 2],
  ['Tel harku NiTi 0.014, sipër (10)', 'Ortodonci', 'paketë', 3, 2],
  ['Ligatura elastike', 'Ortodonci', 'paketë', 6, 2],
  ['Tel retensioni', 'Ortodonci', 'rrotull', 1, 1],
  ['Implant 4.0 × 10 mm', 'Implantologji', 'copë', 3, 2, true],
  ['Implant 3.5 × 11.5 mm', 'Implantologji', 'copë', 1, 2, true],
  ['Abatment shërimi 4.5 × 4 mm', 'Implantologji', 'copë', 6, 3],
  ['Vidë mbuluese', 'Implantologji', 'copë', 5, 3],
  ['Set frezash kirurgjikale', 'Implantologji', 'set', 1, 1],
  ['Granula kockore (0.5 g)', 'Implantologji', 'flakon', 2, 2],
];

/* ════════════════ write ════════════════ */
async function main() {
  assertDemoEnvironment({ action: 'seed' });
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }
  const { host, dbName } = assertNotProduction(process.env.DATABASE_URL);
  console.log(`\n  Seeding the demo clinic into ${host}/${dbName}\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  await assertSchemaCurrent(client);
  const hash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
  const q = (sql, params) => client.query(sql, params);

  try {
    const existing = await q(
      `SELECT t.id, (SELECT count(*)::int FROM patients p WHERE p.tenant_id = t.id) AS patients
         FROM tenants t WHERE t.subdomain = $1`,
      [CLINIC.subdomain],
    );
    if (existing.rows[0]?.patients > 0) {
      console.log('  The demo clinic already has data. Nothing to do.');
      console.log('  For a clean demo:  DEMO_ENV=true npm run demo:reset\n');
      return;
    }
    const others = await q(
      'SELECT count(*)::int AS n FROM tenants WHERE subdomain <> $1',
      [CLINIC.subdomain],
    );
    if (others.rows[0].n > 0) {
      console.log(
        `  Note: ${others.rows[0].n} other clinic(s) exist in this database. ` +
          'demo:reset removes them, so the console shows the demo clinic only.\n',
      );
    }

    /* ── plan everything ── */
    const patients = buildPatients();
    const visits = buildCalendar(patients);
    const invoices = buildMoney(patients, visits);

    await q('BEGIN');

    /* ── plans (configuration) and the platform administrator ── */
    const plans = [
      ['starter', 'Starter', 49],
      ['professional', 'Professional', 99],
      ['clinic_plus', 'Clinic+', 179],
    ];
    let planId = null;
    for (const [code, name, price] of plans) {
      const r = await q(
        `INSERT INTO plans (code, name, price_monthly) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, price_monthly = EXCLUDED.price_monthly
         RETURNING id`,
        [code, name, price * 100],
      );
      if (code === 'professional') planId = r.rows[0].id;
    }
    await q(
      `INSERT INTO platform_admins (email, password_hash, full_name, status)
       VALUES ($1,$2,$3,'active')
       ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name`,
      [PLATFORM_ADMIN.email, hash, PLATFORM_ADMIN.fullName],
    );

    /* ── the clinic: on a 30-day trial of Professional ── */
    const opened = at(addDays(TODAY, -HISTORY_DAYS - 14), 10 * 60);
    const t = await q(
      `INSERT INTO tenants (name, subdomain, status, plan_id, trial_ends_at, created_at, updated_at)
       VALUES ($1,$2,'active',$3, now() + interval '30 days', $4, $4)
       ON CONFLICT (subdomain) DO UPDATE SET name = EXCLUDED.name, plan_id = EXCLUDED.plan_id,
         trial_ends_at = EXCLUDED.trial_ends_at
       RETURNING id`,
      [CLINIC.name, CLINIC.subdomain, planId, opened],
    );
    const tenantId = t.rows[0].id;

    await q(
      `INSERT INTO clinic_settings
         (tenant_id, address, city, phone, email, working_hours, currency, timezone,
          phone_country_code, quote_currency, default_appointment_duration,
          reminders_enabled, reminder_hours_before, payroll_logging_enabled,
          default_checkout_mode, internal_receipts_enabled, reminder_locale)
       VALUES ($1,$2,$3,$4,$5,$6,'ALL',$7,'355','EUR',30,true,24,true,'internal',true,'sq')
       ON CONFLICT (tenant_id) DO UPDATE SET
         address = EXCLUDED.address, city = EXCLUDED.city, phone = EXCLUDED.phone,
         email = EXCLUDED.email, working_hours = EXCLUDED.working_hours`,
      [
        tenantId,
        CLINIC.address,
        CLINIC.city,
        CLINIC.phone,
        CLINIC.email,
        JSON.stringify(HOURS),
        TZ,
      ],
    );
    const loc = await q(
      `INSERT INTO locations (tenant_id, name, address, city, is_default)
       VALUES ($1,$2,$3,$4,true) RETURNING id`,
      [tenantId, CLINIC.name, CLINIC.address, CLINIC.city],
    );
    const locationId = loc.rows[0].id;

    /* ── rooms ── */
    const roomIds = [];
    for (const [i, r] of ROOMS.entries()) {
      const res = await q(
        `INSERT INTO operatories (tenant_id, name, description, sort_order, color, location_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenantId, r.name, r.description, i, r.color, locationId],
      );
      roomIds.push(res.rows[0].id);
    }

    /* ── team ── */
    const staff = {};
    for (const s of STAFF) {
      const r = await q(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status, position,
                            salary_amount, sees_patients, home_operatory_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$10) RETURNING id`,
        [
          tenantId,
          s.email,
          hash,
          s.fullName,
          s.role,
          s.position,
          s.salary ? L(s.salary) : null,
          s.seesPatients,
          s.room === undefined ? null : roomIds[s.room],
          opened,
        ],
      );
      staff[s.key] = r.rows[0].id;
    }
    const owner = staff.owner;
    const desk = staff.ana;
    const roomOf = Object.fromEntries(
      STAFF.filter((s) => s.room !== undefined).map((s) => [s.key, roomIds[s.room]]),
    );

    /* ── features: the cash drawer is on for the demo ── */
    await q(
      `INSERT INTO tenant_feature_settings (tenant_id, feature_key, enabled, updated_by)
       VALUES ($1,'cash_drawer',true,$2)`,
      [tenantId, owner],
    );
    const policy = {
      blindCount: false,
      maxRecounts: 1,
      thresholds: {
        EUR: { tolerance: 100, approval: 2000 },
        ALL: { tolerance: L(100), approval: L(2000) },
        USD: { tolerance: 100, approval: 2000 },
        GBP: { tolerance: 100, approval: 2000 },
        CHF: { tolerance: 100, approval: 2000 },
      },
      defaultFloat: { EUR: 0, ALL: FLOAT, USD: 0, GBP: 0, CHF: 0 },
    };
    await q(
      `INSERT INTO drawer_policies (tenant_id, blind_count, max_recounts, thresholds, default_float, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        tenantId,
        policy.blindCount,
        policy.maxRecounts,
        JSON.stringify({ ALL: policy.thresholds.ALL }),
        JSON.stringify({ ALL: FLOAT }),
        owner,
      ],
    );
    const drawer = await q(
      `INSERT INTO cash_drawers (tenant_id, location_id, name, currencies)
       VALUES ($1,$2,'Arka e recepsionit',ARRAY['ALL']) RETURNING id`,
      [tenantId, locationId],
    );
    const drawerId = drawer.rows[0].id;

    /* ── services ── */
    const serviceIds = {};
    for (const s of Object.values(SERVICE)) {
      const r = await q(
        `INSERT INTO treatments (tenant_id, name, price, duration_minutes, visit_type, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id`,
        [tenantId, s.name, s.price, s.minutes, s.visitType, opened],
      );
      serviceIds[s.key] = r.rows[0].id;
    }

    /* ── patients: registered before their first visit ── */
    const patientIds = [];
    for (const p of patients) {
      const first = p.visits[0];
      let registered;
      if (p.first === 'Klajdi' && p.last === 'Dervishi') {
        registered = new Date(
          Math.min(at(TODAY, 8 * 60 + 40).getTime(), NOW.getTime() - 3600000),
        );
      } else if (!p.established && first) {
        registered = new Date(first.startsAt.getTime() - int(1, 6) * 86400000);
      } else {
        registered = at(
          addDays(TODAY, -HISTORY_DAYS - int(20, 900)),
          int(9 * 60, 17 * 60),
        );
        // A recall patient's old visit can predate that; registration comes first.
        if (first && registered > first.startsAt) {
          registered = new Date(first.startsAt.getTime() - int(30, 700) * 86400000);
        }
      }
      if (registered > NOW) registered = new Date(NOW.getTime() - 3600000);
      p.registered = registered;
      const r = await q(
        `INSERT INTO patients
           (tenant_id, first_name, last_name, phone, email, gender, birth_date, address, city,
            status, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$11) RETURNING id`,
        [
          tenantId,
          p.first,
          p.last,
          p.phone,
          p.email,
          p.gender,
          p.born,
          p.address,
          p.city,
          desk,
          registered,
        ],
      );
      patientIds.push(r.rows[0].id);
    }
    const pid = (name) => patientIds[F[name]];

    await q(
      `INSERT INTO patient_allergies (tenant_id, patient_id, substance, reaction, severity, recorded_by)
       VALUES ($1,$2,'Penicilinë','Urtikarie dhe ënjtje e fytyrës','severe',$3),
              ($1,$4,'Lateks','Skuqje e lëkurës në kontakt','moderate',$3)`,
      [tenantId, pid('Erisa Kola'), staff.elira, pid('Gentian Meta')],
    );

    /* ── treatment plans ── */
    const plans2 = {};
    async function plan(key, patientName, dentist, title, status, items, extra = {}) {
      const proposed = extra.proposedAt || NOW;
      const r = await q(
        `INSERT INTO treatment_plans
           (tenant_id, patient_id, title, status, note, discount_amount, proposed_at,
            accepted_at, completed_at, dentist_id, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$7,$7) RETURNING id`,
        [
          tenantId,
          pid(patientName),
          title,
          status,
          extra.note || null,
          extra.discount || 0,
          proposed,
          extra.acceptedAt || null,
          extra.completedAt || null,
          staff[dentist],
        ],
      );
      const planId2 = r.rows[0].id;
      const ids = [];
      for (const [i, [svcKey, tooth, itemStatus]] of items.entries()) {
        const svc = SERVICE[svcKey];
        const it = await q(
          `INSERT INTO treatment_plan_items
             (tenant_id, plan_id, tooth, treatment_id, description, quantity, unit_fee, status,
              sort_order, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$9) RETURNING id`,
          [
            tenantId,
            planId2,
            tooth,
            serviceIds[svcKey],
            svc.name,
            svc.price,
            itemStatus,
            i,
            proposed,
          ],
        );
        ids.push(it.rows[0].id);
      }
      plans2[key] = { id: planId2, items: ids };
    }
    const dayOf = (offset) => at(storyDay(offset), 11 * 60);
    await plan(
      'arben',
      'Arben Hoxha',
      'besnik',
      'Implant 36 dhe kurorë',
      'in_progress',
      [
        ['implant', 36, 'completed'],
        ['abutment', 36, 'scheduled'],
        ['zirconia', 36, 'planned'],
      ],
      { proposedAt: dayOf(-63), acceptedAt: dayOf(-63) },
    );
    await plan(
      'gentian',
      'Gentian Meta',
      'ardit',
      'Kurora 14 dhe 15',
      'completed',
      [
        ['zirconia', 14, 'completed'],
        ['zirconia', 15, 'completed'],
      ],
      { proposedAt: dayOf(-34), acceptedAt: dayOf(-34), completedAt: dayOf(-20) },
    );
    await plan(
      'erisa',
      'Erisa Kola',
      'elira',
      'Kurorë pas trajtimit të kanalit 46',
      'proposed',
      [
        ['post', 46, 'planned'],
        ['zirconia', 46, 'planned'],
      ],
      {
        proposedAt: dayOf(-7),
        note: 'Pasi të përfundojë trajtimi i kanalit dhe dhëmbi të qetësohet.',
      },
    );
    await plan(
      'bora',
      'Bora Dervishi',
      'ardit',
      'Faseta kompoziti 12–22',
      'proposed',
      [
        ['compveneer', 12, 'planned'],
        ['compveneer', 11, 'planned'],
        ['compveneer', 21, 'planned'],
        ['compveneer', 22, 'planned'],
      ],
      {
        proposedAt: dayOf(-10),
        discount: L(4000),
        note: '10% zbritje nëse bëhen të katërta bashkë.',
      },
    );

    /* ── appointments ── */
    for (const v of visits) {
      const booked = new Date(
        Math.min(v.startsAt.getTime() - int(1, 12) * 86400000, NOW.getTime() - 7200000),
      );
      const createdAt = new Date(
        Math.max(booked.getTime(), patients[v.patient].registered.getTime()),
      );
      const s = v.status;
      const checkedIn =
        s === 'completed' || s === 'in_progress' || s === 'checked_in'
          ? new Date(
              Math.min(v.startsAt.getTime() - int(3, 12) * 60000, NOW.getTime() - 60000),
            )
          : null;
      const inProgress = s === 'completed' || s === 'in_progress' ? v.startsAt : null;
      const r = await q(
        `INSERT INTO appointments
           (tenant_id, patient_id, staff_id, operatory_id, reason, status, starts_at, ends_at,
            checked_in_at, in_progress_at, completed_at, cancelled_at, cancel_reason,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING id`,
        [
          tenantId,
          patientIds[v.patient],
          staff[v.doctor],
          roomOf[v.doctor],
          v.reason,
          s,
          v.startsAt,
          v.endsAt,
          checkedIn,
          inProgress,
          s === 'completed' ? v.endsAt : null,
          s === 'cancelled'
            ? new Date(
                Math.min(v.startsAt.getTime() - 30 * 3600000, NOW.getTime() - 3600000),
              )
            : null,
          s === 'cancelled' ? 'Pacienti telefonoi për ta shtyrë' : null,
          desk,
          createdAt,
        ],
      );
      v.id = r.rows[0].id;
    }

    /* ── drawer sessions: one per open day, today's still open ──
       At most one session per drawer may be unclosed (0014), so the past days
       are written already closed; their card totals are known from the plan.
       The event chain head is filled in once the events exist — the only
       change the forward-only trigger allows on a closed session. */
    const cardByDay = {};
    for (const inv of invoices) {
      for (const p of inv.payments) {
        if (p.method === 'card') cardByDay[p.ymd] = (cardByDay[p.ymd] || 0) + p.amount;
      }
    }
    const sessions = {}; // ymd -> { id, ymd, events, openedAt, closeAt }
    const firstDay = addDays(TODAY, -HISTORY_DAYS);
    for (let d = firstDay; d <= TODAY; d = addDays(d, 1)) {
      const h = hoursOf(d);
      if (!h) continue;
      const live = d === TODAY;
      const openedAt = live
        ? new Date(Math.min(at(d, h.open - 15).getTime(), NOW.getTime() - 5 * 60000))
        : at(d, h.open - 15);
      const closeAt = at(d, h.close + 15);
      const r = await q(
        `INSERT INTO drawer_sessions
           (tenant_id, drawer_id, location_id, business_date, status, blind, currencies,
            policy_snapshot, opened_by, opened_at, counting_started_at, closed_by, closed_at,
            card_total, card_batch_total)
         VALUES ($1,$2,$3,$4,$5,$6,ARRAY['ALL'],$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
        [
          tenantId,
          drawerId,
          locationId,
          d,
          live ? 'open' : 'closed',
          policy.blindCount,
          JSON.stringify(policy),
          desk,
          openedAt,
          live ? null : new Date(closeAt.getTime() - 6 * 60000),
          live ? null : desk,
          live ? null : closeAt,
          live ? null : cardByDay[d] || 0,
        ],
      );
      sessions[d] = {
        id: r.rows[0].id,
        ymd: d,
        openedAt,
        closeAt,
        events: [{ type: 'open', amount: FLOAT, paymentId: null, at: openedAt }],
      };
    }

    /** The dentist's record of one line of work, and what it leaves on the chart. */
    async function chartLine(patientId, v, line, planItemId) {
      const svcKey = line.svc.key;
      const proc = await q(
        `INSERT INTO clinical_procedures
           (tenant_id, patient_id, tooth, treatment_id, plan_item_id, appointment_id,
            description, clinician_id, status, fee, performed_on, signed_at, signed_by,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10,$11,$8,$8,$11,$11) RETURNING id`,
        [
          tenantId,
          patientId,
          line.tooth,
          serviceIds[svcKey],
          planItemId,
          v.id,
          line.svc.name,
          staff[v.doctor],
          line.svc.price * line.qty,
          v.ymd,
          v.endsAt,
        ],
      );
      const leaves = LEAVES[svcKey];
      if (leaves && line.tooth) {
        const [condition, hasSurface] = leaves;
        const surface = hasSurface
          ? svcKey === 'compveneer'
            ? 'F'
            : line.tooth % 10 >= 4
              ? 'O'
              : 'I'
          : null;
        await q(
          `INSERT INTO tooth_conditions
             (tenant_id, patient_id, tooth, surface, condition, status, note, dentist_id,
              created_by, recorded_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$7,$8,$8)
           ON CONFLICT DO NOTHING`,
          [
            tenantId,
            patientId,
            line.tooth,
            surface,
            condition,
            line.svc.name,
            staff[v.doctor],
            v.endsAt,
          ],
        );
      }
      return proc.rows[0].id;
    }

    /* ── work charted today and not billed yet ── */
    for (const w of UNBILLED) {
      for (const line of w.lines)
        await chartLine(patientIds[w.patient], w.visit, line, null);
    }

    /* ── invoices, lines, procedures, ledger, payments ── */
    for (const inv of invoices) {
      const v = inv.visit;
      const patientId = patientIds[inv.patient];
      const planKey = v.opts.plan;
      const planRef = planKey ? plans2[planKey] : null;
      const r = await q(
        `INSERT INTO invoices
           (tenant_id, patient_id, seq, invoice_number, treatment_plan_id, subtotal, tax_amount,
            total, currency, vat_rate_bp, status, issued_at, document_kind, document_chosen_by,
            document_chosen_at, notes, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,0,$6,'ALL',0,$7,$8,'internal',$9,$10,$11,$12,$13,$13)
         RETURNING id`,
        [
          tenantId,
          patientId,
          inv.seq,
          inv.number,
          planRef ? planRef.id : null,
          inv.total,
          inv.status,
          inv.ymd,
          inv.payments.length ? desk : null,
          inv.payments.length ? inv.payments[0].at : null,
          planRef ? 'Krijuar nga plani i trajtimit' : null,
          desk,
          v.endsAt,
        ],
      );
      inv.id = r.rows[0].id;

      for (const [idx, line] of inv.lines.entries()) {
        const svcKey = line.svc.key;
        let planItemId = null;
        if (planKey === 'arben' && svcKey === 'implant')
          planItemId = plans2.arben.items[0];
        if (planKey === 'gentian')
          planItemId = plans2.gentian.items[line.tooth === 14 ? 0 : 1];
        const procId = await chartLine(patientId, v, line, planItemId);
        await q(
          `INSERT INTO invoice_line_items
             (tenant_id, invoice_id, treatment_id, plan_item_id, procedure_id, tooth, description,
              quantity, unit_price, amount, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            tenantId,
            inv.id,
            serviceIds[svcKey],
            planItemId,
            procId,
            line.tooth,
            line.svc.name,
            line.qty,
            line.svc.price,
            line.svc.price * line.qty,
            idx,
          ],
        );
      }

      await q(
        `INSERT INTO ledger_entries
           (tenant_id, patient_id, invoice_id, entry_type, amount, currency, description,
            occurred_on, created_by, created_at)
         VALUES ($1,$2,$3,'charge',$4,'ALL',$5,$6,$7,$8)`,
        [
          tenantId,
          patientId,
          inv.id,
          inv.total,
          `Fatura ${inv.number}`,
          inv.ymd,
          desk,
          v.endsAt,
        ],
      );

      for (const p of inv.payments) {
        const session = p.method === 'cash' ? sessions[p.ymd] : null;
        const pay = await q(
          `INSERT INTO payments
             (tenant_id, invoice_id, amount, method, note, paid_at, created_by, drawer_session_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            tenantId,
            inv.id,
            p.amount,
            p.method,
            p.amount < inv.total && inv.payments.length === 1
              ? 'Paradhënie në vizitë'
              : null,
            p.at,
            desk,
            session ? session.id : null,
          ],
        );
        const methodName = { cash: 'cash', card: 'kartë', bank: 'bankë' }[p.method];
        await q(
          `INSERT INTO ledger_entries
             (tenant_id, patient_id, invoice_id, payment_id, entry_type, amount, currency,
              description, occurred_on, created_by, created_at)
           VALUES ($1,$2,$3,$4,'payment',$5,'ALL',$6,$7,$8,$9)`,
          [
            tenantId,
            patientId,
            inv.id,
            pay.rows[0].id,
            -p.amount,
            `Pagesë (${methodName}) për ${inv.number}`,
            p.ymd,
            desk,
            p.at,
          ],
        );
        if (session) {
          session.events.push({
            type: 'cash_sale',
            amount: p.amount,
            paymentId: pay.rows[0].id,
            at: p.at,
          });
        }
      }
    }

    /* ── chain each session's events, then count and close ── */
    const closedDays = Object.keys(sessions)
      .filter((d) => d < TODAY)
      .sort();
    const shortDay = closedDays[closedDays.length - 4];
    let expectedToday = 0;
    for (const s of Object.values(sessions)) {
      s.events.sort((a, b) => a.at - b.at);
      let prev = '0'.repeat(64);
      for (const [i, e] of s.events.entries()) {
        const occurredAt = e.at.toISOString();
        const facts = {
          sessionId: s.id,
          seq: i + 1,
          type: e.type,
          currency: 'ALL',
          amount: e.amount,
          paymentId: e.paymentId,
          fiscalCashDepositId: null,
          approvalId: null,
          reason: null,
          actorUserId: desk,
          occurredAt,
        };
        const h = eventHash(prev, facts);
        await q(
          `INSERT INTO drawer_events
             (tenant_id, session_id, seq, type, currency, amount, payment_id, actor_user_id,
              occurred_at, prev_hash, hash)
           VALUES ($1,$2,$3,$4,'ALL',$5,$6,$7,$8::timestamptz,$9,$10)`,
          [
            tenantId,
            s.id,
            facts.seq,
            e.type,
            e.amount,
            e.paymentId,
            desk,
            occurredAt,
            prev,
            h,
          ],
        );
        prev = h;
      }
      await q('UPDATE drawer_sessions SET last_seq = $2, last_hash = $3 WHERE id = $1', [
        s.id,
        s.events.length,
        prev,
      ]);
      const expected = s.events.reduce((sum, e) => sum + e.amount, 0);
      if (s.ymd === TODAY) {
        expectedToday = expected;
        continue;
      }

      const counted = s.ymd === shortDay ? expected - SHORT_BY : expected;
      const variance = counted - expected;
      const countedAt = new Date(s.closeAt.getTime() - 3 * 60000);
      await q(
        `INSERT INTO drawer_counts
           (tenant_id, session_id, attempt_no, currency, denominations, total, expected, counted_by, counted_at)
         VALUES ($1,$2,1,'ALL','{}',$3,$4,$5,$6)`,
        [tenantId, s.id, counted, expected, desk, countedAt],
      );
      await q(
        `INSERT INTO drawer_session_reviews
           (tenant_id, session_id, currency, expected, counted, variance, band, note, reviewed_by, created_at)
         VALUES ($1,$2,'ALL',$3,$4,$5,$6,$7,$8,$9)`,
        [
          tenantId,
          s.id,
          expected,
          counted,
          variance,
          variance === 0 ? 'exact' : 'note',
          variance === 0
            ? null
            : 'Mungojnë 500 L. Kusuri për një kartëmonedhë 5,000 L u dha dy herë në drekë; pronari u njoftua po atë mbrëmje.',
          desk,
          s.closeAt,
        ],
      );
    }

    /* ── Arben Hoxha's chart: history from before the demo starts ── */
    const ARBEN_CHART = [
      [18, 'missing', null, 'Hequr vite më parë, në një klinikë tjetër.'],
      [17, 'restored', 'O', 'Mbushje e vjetër kompoziti.'],
      [16, 'root_canal', null, 'Kanal i trajtuar, 2019.'],
      [16, 'crown', null, 'Kurorë metal-qeramike mbi dhëmbin me kanal të trajtuar.'],
      [14, 'caries', 'O', 'Lezion fillestar. Rishikim në kontrollin e ardhshëm.'],
      [26, 'restored', 'O', 'Kompozit.'],
      [12, 'watch', 'M', 'Demineralizim fillestar — rishikim pas gjashtë muajsh.'],
      [46, 'restored', 'O', 'Kompozit.'],
      [47, 'caries', 'O', 'Duhet mbushur.'],
    ];
    for (const [tooth, condition, surface, note] of ARBEN_CHART) {
      await q(
        `INSERT INTO tooth_conditions
           (tenant_id, patient_id, tooth, surface, condition, status, note, dentist_id, created_by,
            recorded_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$7,$8,$8)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          pid('Arben Hoxha'),
          tooth,
          surface,
          condition,
          note,
          staff.besnik,
          dayOf(-63),
        ],
      );
    }

    /* ── clinical notes on the walkthrough patients ── */
    const NOTES = [
      [
        'Arben Hoxha',
        'besnik',
        -56,
        'U vendos implanti 36, 4.0 × 10 mm. Stabilitet primar i mirë. Abatmenti i shërimit pas rreth tetë javësh.',
      ],
      [
        'Arben Hoxha',
        'besnik',
        -63,
        'Molari i parë poshtë majtas mungon prej dy vitesh. Lartësia e kockës e mjaftueshme në OPG. U diskutua implant kundrejt urës; preferon implantin.',
      ],
      [
        'Gentian Meta',
        'ardit',
        -20,
        'U cementuan kurorat e zirkonit 14 dhe 15. Kafshimi u kontrollua, pa pika të larta. U përdorën doreza pa lateks.',
      ],
      [
        'Erisa Kola',
        'elira',
        -7,
        'Kanali 46, seanca 1: hapje, gjatësia e punës, irrigim, medikament me hidroksid kalciumi. Alergji ndaj penicilinës — klindamicinë nëse nevojitet.',
      ],
      [
        'Elona Leka',
        'ardit',
        -30,
        'Zbardhim në klinikë, dy cikle. Pritet ndjeshmëri e lehtë për 24–48 orë.',
      ],
      [
        'Ermal Leka',
        'besnik',
        -1,
        'Ekstraksion kirurgjikal 38, me seksionim. Tre qepje. Udhëzimet pas ndërhyrjes u dhanë me shkrim.',
      ],
      [
        'Bora Dervishi',
        'ardit',
        -10,
        'Dëshiron një buzëqeshje më të bardhë për dasmën në pranverë. U shpjeguan opsionet e fasetave; do të vendosë pas konsultës.',
      ],
    ];
    for (const [name, doctor, offset, body] of NOTES) {
      await q(
        `INSERT INTO patient_notes (tenant_id, patient_id, body, author_id, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, pid(name), body, staff[doctor], at(storyDay(offset), 17 * 60)],
      );
    }

    /* ── running costs: rent, utilities, materials, lab, payroll ── */
    const months = [];
    for (let m = 3; m >= 0; m--) {
      const [y, mo] = TODAY.split('-').map(Number);
      const d = new Date(Date.UTC(y, mo - 1 - m, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const labByMonth = {};
    for (const inv of invoices) {
      const mo = inv.ymd.slice(0, 7);
      labByMonth[mo] =
        (labByMonth[mo] || 0) + inv.lines.reduce((s, l) => s + l.svc.lab * l.qty, 0);
    }
    const monthlySalaries = STAFF.filter((s) => s.salary).reduce(
      (s, x) => s + L(x.salary),
      0,
    );
    let expenseCount = 0;
    for (const mo of months) {
      const rows = [
        ['rent', L(120000), `${mo}-01`, 'Qiraja e klinikës'],
        [
          'utilities',
          L(int(22, 30) * 1000),
          `${mo}-12`,
          'Energji elektrike, ujë dhe internet',
        ],
        [
          'materials',
          L(int(70, 110) * 1000),
          `${mo}-08`,
          'Materiale dentare (shih Inventarin)',
        ],
        [
          'other',
          L(int(6, 15) * 1000),
          `${mo}-20`,
          pick([
            'Mirëmbajtje e pajisjeve',
            'Grumbullim i mbetjeve mjekësore',
            'Programi dhe linja telefonike',
          ]),
        ],
      ];
      if (labByMonth[mo])
        rows.push([
          'lab',
          labByMonth[mo],
          `${mo}-25`,
          'Laboratori dentar: kurora, abatmente dhe aparate',
        ]);
      // Payroll for a month is paid on the 5th of the next one.
      const [yy, mm] = mo.split('-').map(Number);
      const payday = new Date(Date.UTC(yy, mm, 5)).toISOString().slice(0, 10);
      rows.push(['salaries', monthlySalaries, payday, `Pagat për ${mo}`]);
      for (const [category, amount, date, note] of rows) {
        if (date > TODAY || date < addDays(TODAY, -HISTORY_DAYS - 30)) continue;
        await q(
          `INSERT INTO expenses (tenant_id, category, amount, expense_date, note, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, category, amount, date, note, owner, at(date, 12 * 60)],
        );
        expenseCount++;
        if (category === 'salaries') {
          for (const s of STAFF.filter((x) => x.salary)) {
            await q(
              `INSERT INTO salary_payments (tenant_id, staff_id, position, amount, paid_on, note, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [
                tenantId,
                staff[s.key],
                s.position,
                L(s.salary),
                date,
                `Paga për ${mo}`,
                owner,
              ],
            );
          }
        }
      }
    }

    /* ── stock ── */
    for (const [
      i,
      [name, category, unit, onHand, minimum, lots],
    ] of INVENTORY.entries()) {
      const used = onHand === 0 ? int(2, 4) : int(1, 6);
      const received = onHand + used;
      const receivedAt = at(addDays(TODAY, -int(30, 45)), 10 * 60);
      const usedAt = at(addDays(TODAY, -int(1, 12)), 16 * 60);
      const item = await q(
        `INSERT INTO inventory_items
           (tenant_id, name, category, unit, quantity, minimum_quantity, notes, created_by,
            track_lots, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          tenantId,
          name,
          category,
          unit,
          onHand,
          minimum,
          'Artikull demo',
          owner,
          !!lots,
          receivedAt,
          usedAt,
        ],
      );
      const itemId = item.rows[0].id;
      let lotId = null;
      if (lots) {
        // The first lot on the shelf runs out soonest — one expires inside the
        // 60-day warning window so the expiry alert has something to show.
        const expires = addDays(TODAY, i % 2 === 0 ? 40 : 300);
        const lot = await q(
          `INSERT INTO inventory_lots
             (tenant_id, item_id, lot_number, expires_on, quantity, received_on, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            tenantId,
            itemId,
            `DEMO-${1000 + i * 7}`,
            expires,
            onHand,
            receivedAt.toISOString().slice(0, 10),
            owner,
            receivedAt,
          ],
        );
        lotId = lot.rows[0].id;
      }
      await q(
        `INSERT INTO stock_movements
           (tenant_id, item_id, kind, quantity_delta, quantity_after, reason, created_by, created_at,
            lot_id, lot_quantity_after)
         VALUES ($1,$2,'receipt',$3,$3,'Furnizim',$4,$5,$6,$7)`,
        [tenantId, itemId, received, owner, receivedAt, lotId, lotId ? received : null],
      );
      await q(
        `INSERT INTO stock_movements
           (tenant_id, item_id, kind, quantity_delta, quantity_after, reason, created_by, created_at,
            lot_id, lot_quantity_after)
         VALUES ($1,$2,'usage',$3,$4,'Përdorur në sallat e trajtimit',$5,$6,$7,$8)`,
        [
          tenantId,
          itemId,
          -used,
          onHand,
          staff.ardit,
          usedAt,
          lotId,
          lotId ? onHand : null,
        ],
      );
    }

    /* ── labs, suppliers and lab work (0020) ── */
    // Who the clinic buys from, which laboratories make its crowns, and a
    // piece of lab work in each state the Lab page shows: being prepared, at
    // the lab, late, back and waiting to fit today, fitted, and cancelled.
    // Phones and addresses are the clinic's own obviously fictional kind, so
    // "Contact the lab" can never reach a real person.
    async function partner(kind, name, phoneNo, email, notes) {
      const r = await q(
        `INSERT INTO partners
           (tenant_id, kind, name, phone, email, notes, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
        [
          tenantId,
          kind,
          name,
          phoneNo,
          email,
          notes,
          owner,
          at(addDays(TODAY, -120), 9 * 60),
        ],
      );
      return r.rows[0].id;
    }
    const labArti = await partner(
      'lab',
      'Laboratori Dentar Arti',
      '+355 4 000 0101',
      'lab.arti@example.com',
      'Kurora zirkoni dhe E-max. Kalojnë për punët çdo ditë në orën 13:00.',
    );
    const labDurres = await partner(
      'lab',
      'Laboratori Protetik Durrës',
      '+355 4 000 0102',
      null,
      'Proteza dhe ura metal-qeramike.',
    );
    const supplyTirana = await partner(
      'supplier',
      'Furnizime Dentare Tirana',
      '+355 4 000 0201',
      'porosi.furnizime@example.com',
      'Porosi deri në orën 12:00, dorëzim të nesërmen.',
    );
    const supplyDurres = await partner(
      'supplier',
      'Depo Mjekësore Durrës',
      '+355 4 000 0202',
      null,
      null,
    );
    // Implants come from the brand's representative, who is not set up yet:
    // those items show as having no supplier.
    await q(
      `UPDATE inventory_items SET supplier_id = $2
        WHERE tenant_id = $1 AND category = ANY($3::text[])`,
      [
        tenantId,
        supplyTirana,
        ['Materiale konsumi', 'Endodonti', 'Protetikë', 'Ortodonci'],
      ],
    );
    await q(
      `UPDATE inventory_items SET supplier_id = $2
        WHERE tenant_id = $1 AND category = ANY($3::text[])`,
      [tenantId, supplyDurres, ['Njëpërdorimshe', 'Sterilizim', 'Anestezi']],
    );

    // Generated patients the stories below fit: an older one for a partial
    // denture, adults for a crown and for a bridge that was not made.
    const generated = patients
      .map((p, i) => ({ ...p, i }))
      .filter((p) => !p.featured && p.established);
    const older = generated.find((p) => p.born < '1962');
    const adults = generated.filter((p) => p.born >= '1970' && p.born < '1996');
    const labDay = (offset, minutes = 13 * 60) => at(storyDay(offset), minutes);
    async function labOrder(o) {
      await q(
        `INSERT INTO lab_orders
           (tenant_id, patient_id, lab_id, dentist_id, plan_item_id, work, teeth, material,
            shade, cost, due_on, status, notes, sent_at, received_at, fitted_at, cancelled_at,
            cancel_reason, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$4,$19,$20)`,
        [
          tenantId,
          o.patientId,
          o.labId,
          staff[o.dentist],
          o.planItemId || null,
          o.work,
          o.teeth,
          o.material || null,
          o.shade || null,
          o.cost,
          o.dueOn || null,
          o.status,
          o.notes || null,
          o.sentAt || null,
          o.receivedAt || null,
          o.fittedAt || null,
          o.cancelledAt || null,
          o.cancelReason || null,
          o.createdAt,
          o.fittedAt || o.cancelledAt || o.receivedAt || o.sentAt || o.createdAt,
        ],
      );
    }
    // Gentian Meta: the two zirconia crowns, fitted on the day they were billed.
    await labOrder({
      patientId: pid('Gentian Meta'),
      labId: labArti,
      dentist: 'ardit',
      work: 'Kurora zirkoni',
      teeth: [14, 15],
      material: 'Zirkon monolitik',
      shade: 'A2',
      cost: 2 * SERVICE.zirconia.lab,
      dueOn: storyDay(-21),
      status: 'fitted',
      createdAt: labDay(-30, 12 * 60),
      sentAt: labDay(-30),
      receivedAt: labDay(-22, 15 * 60),
      fittedAt: labDay(-20, 11 * 60 + 30),
    });
    // Arben Hoxha: the crown on implant 36, planned for after the abutment.
    await labOrder({
      patientId: pid('Arben Hoxha'),
      labId: labArti,
      dentist: 'besnik',
      planItemId: plans2.arben.items[2],
      work: 'Kurorë zirkoni mbi implant',
      teeth: [36],
      material: 'Zirkon',
      cost: SERVICE.zirconia.lab,
      dueOn: storyDay(24),
      status: 'preparing',
      notes: 'Masa me transfer implanti merret në vizitën e abatmentit.',
      createdAt: labDay(0, 12 * 60 + 50),
    });
    // Jona Meta: a night guard, back from the lab, to be given at today's visit.
    await labOrder({
      patientId: pid('Jona Meta'),
      labId: labArti,
      dentist: 'ardit',
      work: 'Pllakë nate',
      teeth: [],
      material: 'Akril i butë 2 mm',
      cost: SERVICE.nightguard.lab,
      dueOn: storyDay(-1),
      status: 'received',
      createdAt: labDay(-9, 10 * 60),
      sentAt: labDay(-9),
      receivedAt: labDay(-1, 14 * 60),
    });
    if (older) {
      // Late: the lab promised it two days ago and has not sent it back.
      await labOrder({
        patientId: patientIds[older.i],
        labId: labDurres,
        dentist: 'ardit',
        work: 'Protezë parciale',
        teeth: [35, 36, 37, 45, 46],
        material: 'Skelet metalik (Co-Cr)',
        shade: 'A3',
        cost: SERVICE.partialdenture.lab,
        dueOn: storyDay(-2),
        status: 'sent',
        notes: 'Prova e skeletit para montimit të dhëmbëve.',
        createdAt: labDay(-12, 11 * 60),
        sentAt: labDay(-12),
      });
    }
    if (adults[0]) {
      // At the lab, on time.
      await labOrder({
        patientId: patientIds[adults[0].i],
        labId: labDurres,
        dentist: 'elira',
        work: 'Kurorë metal-qeramike',
        teeth: [21],
        material: 'Metal-qeramikë',
        shade: 'A2',
        cost: SERVICE.pfm.lab,
        dueOn: storyDay(3),
        status: 'sent',
        createdAt: labDay(-4, 11 * 60),
        sentAt: labDay(-4),
      });
    }
    if (adults[1]) {
      // Cancelled, with the reason the list keeps.
      await labOrder({
        patientId: patientIds[adults[1].i],
        labId: labDurres,
        dentist: 'besnik',
        work: 'Urë metal-qeramike',
        teeth: [44, 45, 46],
        cost: 3 * SERVICE.bridge.lab,
        dueOn: storyDay(-30),
        status: 'cancelled',
        createdAt: labDay(-41, 10 * 60),
        cancelledAt: labDay(-40, 9 * 60 + 15),
        cancelReason: 'Pacienti zgjodhi implant në vend të urës.',
      });
    }

    /* ── reminder log for the last two weeks ── */
    const reminded = visits.filter(
      (v) => v.ymd < TODAY && v.ymd >= addDays(TODAY, -14) && v.status !== 'cancelled',
    );
    for (const v of reminded.slice(0, 30)) {
      const when = v.startsAt;
      const p = patients[v.patient];
      const fmt = new Intl.DateTimeFormat('sq-AL', {
        timeZone: TZ,
        hourCycle: 'h23',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      }).format(when);
      await q(
        `INSERT INTO reminders
           (tenant_id, appointment_id, patient_id, type, channel, status, message, sent_at, created_at)
         VALUES ($1,$2,$3,'automatic','log','sent',$4,$5,$5)`,
        [
          tenantId,
          v.id,
          patientIds[v.patient],
          `Përshëndetje ${p.first}, ju kujtojmë takimin tuaj në klinikën ${CLINIC.name} më ${fmt}. Na kontaktoni nëse duhet ta ndryshoni.`,
          new Date(when.getTime() - 24 * 3600000),
        ],
      );
    }

    await q('COMMIT');

    /* ── summary: the numbers the demo will show ── */
    const sums = await q(
      `SELECT
         (SELECT count(*) FROM patients      WHERE tenant_id=$1)::int AS patients,
         (SELECT count(*) FROM appointments  WHERE tenant_id=$1)::int AS appointments,
         (SELECT count(*) FROM appointments  WHERE tenant_id=$1
             AND (starts_at AT TIME ZONE $2)::date = $3::date)::int AS today,
         (SELECT count(*) FROM invoices      WHERE tenant_id=$1)::int AS invoices,
         (SELECT coalesce(sum(total),0) FROM invoices WHERE tenant_id=$1)::bigint AS invoiced,
         (SELECT coalesce(sum(amount),0) FROM payments WHERE tenant_id=$1)::bigint AS collected,
         (SELECT coalesce(sum(amount),0) FROM ledger_entries WHERE tenant_id=$1)::bigint AS ledger,
         (SELECT count(*) FROM inventory_items WHERE tenant_id=$1
             AND quantity <= minimum_quantity)::int AS low_stock,
         (SELECT count(*) FROM lab_orders WHERE tenant_id=$1
             AND status IN ('preparing', 'sent', 'received'))::int AS lab_open`,
      [tenantId, TZ, TODAY],
    );
    const c = sums.rows[0];
    const lek = (minor) => `${(Number(minor) / 100).toLocaleString('en-US')} L`;
    const outstanding = Number(c.invoiced) - Number(c.collected);
    if (outstanding !== Number(c.ledger)) {
      throw new Error(
        `Seed does not reconcile: invoices owe ${outstanding}, the ledger says ${c.ledger}`,
      );
    }

    console.log('  Demo clinic ready.\n');
    console.log(`    Clinic        ${CLINIC.name}  (subdomain: ${CLINIC.subdomain})`);
    console.log(
      `    Team          ${STAFF.length} (owner, 3 dentists, receptionist) · ${ROOMS.length} rooms`,
    );
    console.log(`    Services      ${SERVICES.length} (DEMO price list, lek)`);
    console.log(`    Patients      ${c.patients}`);
    console.log(`    Appointments  ${c.appointments}  (${c.today} today)`);
    console.log(
      `    Invoices      ${c.invoices}  ·  invoiced ${lek(c.invoiced)}  ·  collected ${lek(c.collected)}`,
    );
    console.log(`    Outstanding   ${lek(outstanding)}  (= sum of patient balances)`);
    console.log(`    Cash drawer   open today, expected ${lek(expectedToday)}`);
    console.log(`    Expenses      ${expenseCount}`);
    console.log(
      `    Stock         ${INVENTORY.length} items, ${c.low_stock} at or below minimum`,
    );
    console.log(`    Lab work      ${c.lab_open} open (one late, one back for today)\n`);
    console.log('  Accounts (fictional, demo only — see docs/DEMO_ACCOUNTS.md):');
    for (const s of STAFF)
      console.log(`    ${s.email.padEnd(22)} ${s.fullName} — ${s.position}`);
    console.log(`    ${PLATFORM_ADMIN.email.padEnd(22)} platform console`);
    console.log(`    Password for all: ${DEMO_PASSWORD}\n`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  });
}

module.exports = { CLINIC, STAFF, SERVICES, FEATURED, INVENTORY, DEMO_PASSWORD };
