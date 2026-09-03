/* eslint-disable no-console */
/**
 * Seed the RC1 demonstration environment: ONE clinic that looks like a real
 * practice a few months into operation.
 *
 *   npm run seed
 *
 * Idempotent — safe to re-run. For a clean slate use `npm run reset-demo`
 * first. Guarded against production by scripts/lib/guard.js.
 *
 * All money is integers in whole euros, matching apps/tenant-web/src/lib/format.ts.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { assertNotProduction, assertSchemaCurrent } = require('./lib/guard');

const BCRYPT_ROUNDS = 10;

/* ════════════════ demo identity ════════════════ */
const DEMO_PASSWORD = 'Demo@2026!';

const CLINIC = {
  name: 'Demo Dental Clinic',
  subdomain: 'demo',
  address: 'Mariahilfer Straße 88',
  city: 'Vienna',
  postalCode: '1070',
  phone: '+43 1 522 4180',
  email: 'praxis@dentx.app',
};

const PLATFORM_ADMIN = {
  email: 'admin@dentx.app',
  fullName: 'Platform Administrator',
  password: DEMO_PASSWORD,
};

/**
 * The clinic team. Access roles are 'admin' and 'receptionist' — migration
 * 0017 collapsed the model to two, the doctor (who is also the administrator)
 * and the front desk; the check constraint rejects every older word outright.
 *
 * `position` is a descriptive job title that grants no permissions, which is
 * why the clinicians below are seeded as `admin` while still reading as
 * dentists everywhere it matters clinically — and why `dentistIds` filters on
 * position rather than role. Both roles are seeded so permission-gated UI has
 * something to be tested against. Salaries are monthly, in euros.
 */
const STAFF = [
  {
    email: 'demo@dentx.app',
    fullName: 'Demo Administrator',
    role: 'admin',
    position: 'Clinic Director',
    salary: 6200,
    isPrimaryOwner: true,
  },
  { email: 'l.brandt@dentx.app', fullName: 'Dr. Lukas Brandt', role: 'admin', position: 'Dentist', salary: 5400 },
  { email: 's.ricci@dentx.app', fullName: 'Dr. Sofia Ricci', role: 'admin', position: 'Dentist', salary: 4800 },
  { email: 'j.moreau@dentx.app', fullName: 'Dr. Julien Moreau', role: 'admin', position: 'Orthodontist', salary: 5100 },
  { email: 'm.novak@dentx.app', fullName: 'Marta Novák', role: 'receptionist', position: 'Receptionist', salary: 2600 },
  { email: 'a.silva@dentx.app', fullName: 'Ana Silva', role: 'receptionist', position: 'Dental Assistant', salary: 2400 },
];

/** name, price (EUR), duration (min), visit type */
const TREATMENTS = [
  ['Consultation & Check-up', 45, 30, 'single'],
  ['Professional Cleaning', 75, 45, 'single'],
  ['Composite Filling', 120, 45, 'single'],
  ['Root Canal Treatment', 450, 90, 'multiple'],
  ['Tooth Extraction', 95, 30, 'single'],
  ['Surgical Extraction', 220, 60, 'single'],
  ['Porcelain Crown', 650, 60, 'multiple'],
  ['Dental Implant', 1450, 90, 'multiple'],
  ['Teeth Whitening', 280, 60, 'single'],
  ['Orthodontic Consultation', 60, 30, 'single'],
  ['Periodontal Treatment', 180, 60, 'multiple'],
  ['Dental Bridge', 1200, 90, 'multiple'],
  ['Paediatric Check-up', 40, 30, 'single'],
  ['Night Guard Fitting', 210, 45, 'single'],
];

/** first, last, gender, city, postal */
const PATIENTS = [
  ['Anna', 'Bauer', 'female', 'Vienna', '1010'],
  ['Matteo', 'Ricci', 'male', 'Vienna', '1020'],
  ['Sophie', 'Dubois', 'female', 'Vienna', '1030'],
  ['Lukas', 'Weber', 'male', 'Vienna', '1040'],
  ['Elena', 'Fernández', 'female', 'Vienna', '1050'],
  ['Jonas', 'Lindqvist', 'male', 'Graz', '8010'],
  ['Marta', 'Kowalska', 'female', 'Vienna', '1060'],
  ['Pieter', 'van Dijk', 'male', 'Vienna', '1070'],
  ['Chiara', 'Bianchi', 'female', 'Vienna', '1080'],
  ['Tomáš', 'Novák', 'male', 'Vienna', '1090'],
  ['Isabelle', 'Laurent', 'female', 'Linz', '4020'],
  ['Andreas', 'Schmidt', 'male', 'Vienna', '1100'],
  ['Núria', 'Serra', 'female', 'Vienna', '1110'],
  ['Felix', 'Hoffmann', 'male', 'Vienna', '1120'],
  ['Katarzyna', 'Nowak', 'female', 'Vienna', '1130'],
  ['Rui', 'Almeida', 'male', 'Salzburg', '5020'],
  ['Ingrid', 'Larsen', 'female', 'Vienna', '1140'],
  ['Stefan', 'Müller', 'male', 'Vienna', '1150'],
  ['Camille', 'Rousseau', 'female', 'Vienna', '1160'],
  ['Davide', 'Costa', 'male', 'Vienna', '1170'],
  ['Hanna', 'Virtanen', 'female', 'Vienna', '1180'],
  ['Sebastian', 'Wagner', 'male', 'Graz', '8020'],
  ['Léa', 'Girard', 'female', 'Vienna', '1190'],
  ['Milan', 'Horvat', 'male', 'Vienna', '1200'],
  ['Greta', 'Andersson', 'female', 'Vienna', '1210'],
];

const REASONS = [
  'Routine check-up', 'Professional cleaning', 'Filling — upper molar',
  'Root canal — session 1', 'Root canal — session 2', 'Crown fitting',
  'Implant consultation', 'Whitening session', 'Orthodontic review',
  'Extraction follow-up', 'Gum treatment', 'Emergency — toothache',
  'Night guard fitting', 'Paediatric check-up', 'Post-op review',
];

const CONDITIONS = [
  'Caries', 'Deep caries', 'Fractured cusp', 'Existing amalgam filling',
  'Gingival recession', 'Root canal treated', 'Crown in place', 'Wear facet',
];

/* ════════════════ deterministic pseudo-random ════════════════
 * Seeded so re-running produces the same clinic — a demo that changes shape
 * between runs is hard to script a walkthrough around. */
let _seed = 20260101;
function rnd() {
  _seed = (_seed * 1103515245 + 12345) % 2147483648;
  return _seed / 2147483648;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

function dayAt(offsetDays, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, minute, 0, 0);
  return d;
}
const isoDate = (d) => d.toISOString().slice(0, 10);

function phone() {
  // Fully random digits. An arithmetic pattern across 25 rows is obvious the
  // moment anyone scans the patient list.
  return `+43 6${int(60, 99)} ${int(100, 999)} ${int(1000, 9999)}`;
}

function birthDate(i) {
  const year = 1952 + ((i * 13) % 55);
  const month = 1 + ((i * 7) % 12);
  const day = 1 + ((i * 11) % 27);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const WORKING_HOURS = JSON.stringify([
  { day: 0, closed: false, open: '08:30', close: '18:00' },
  { day: 1, closed: false, open: '08:30', close: '18:00' },
  { day: 2, closed: false, open: '08:30', close: '18:00' },
  { day: 3, closed: false, open: '08:30', close: '19:00' },
  { day: 4, closed: false, open: '08:30', close: '15:00' },
  { day: 5, closed: true, open: '09:00', close: '13:00' },
  { day: 6, closed: true, open: '09:00', close: '13:00' },
]);

/* ════════════════ seed ════════════════ */
async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }
  const { host, dbName } = assertNotProduction(process.env.DATABASE_URL);
  console.log(`\n  Seeding demo clinic into ${host}/${dbName}\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  await assertSchemaCurrent(client);
  const hash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);

  try {
    await client.query('BEGIN');

    /* ── plans (application configuration, not demo data) ── */
    const plans = [
      ['starter', 'Starter', 49],
      ['professional', 'Professional', 99],
      ['clinic_plus', 'Clinic+', 179],
    ];
    let planId = null;
    for (const [code, name, price] of plans) {
      const r = await client.query(
        `INSERT INTO plans (code, name, price_monthly) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, price_monthly = EXCLUDED.price_monthly
         RETURNING id`,
        [code, name, price],
      );
      if (code === 'professional') planId = r.rows[0].id;
    }

    /* ── platform administrator (admin-web console) ── */
    await client.query(
      `INSERT INTO platform_admins (email, password_hash, full_name, status)
       VALUES ($1,$2,$3,'active')
       ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name`,
      [PLATFORM_ADMIN.email, hash, PLATFORM_ADMIN.fullName],
    );

    /* ── the demo clinic ── */
    const t = await client.query(
      `INSERT INTO tenants (name, subdomain, status, plan_id)
       VALUES ($1,$2,'active',$3)
       ON CONFLICT (subdomain) DO UPDATE SET name = EXCLUDED.name, plan_id = EXCLUDED.plan_id
       RETURNING id`,
      [CLINIC.name, CLINIC.subdomain, planId],
    );
    const tenantId = t.rows[0].id;

    await client.query(
      `INSERT INTO clinic_settings
         (tenant_id, address, city, phone, email, working_hours,
          default_appointment_duration, reminders_enabled, reminder_hours_before,
          payroll_logging_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,45,true,24,true)
       ON CONFLICT (tenant_id) DO UPDATE SET
         address = EXCLUDED.address, city = EXCLUDED.city, phone = EXCLUDED.phone,
         email = EXCLUDED.email, working_hours = EXCLUDED.working_hours`,
      [tenantId, CLINIC.address, CLINIC.city, CLINIC.phone, CLINIC.email, WORKING_HOURS],
    );

    /* ── team ── */
    const staffIds = {};
    for (const s of STAFF) {
      const r = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status, position, salary_amount)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7)
         ON CONFLICT (tenant_id, lower(email)) DO UPDATE SET
           full_name = EXCLUDED.full_name, role = EXCLUDED.role,
           position = EXCLUDED.position, salary_amount = EXCLUDED.salary_amount
         RETURNING id`,
        [tenantId, s.email, hash, s.fullName, s.role, s.position, s.salary],
      );
      staffIds[s.email] = r.rows[0].id;
    }
    const ownerId = staffIds['demo@dentx.app'];
    const dentistIds = STAFF.filter((s) => /Dentist|Orthodontist/.test(s.position)).map(
      (s) => staffIds[s.email],
    );

    /* ── treatment catalogue ── */
    const treatmentIds = {};
    for (const [name, price, dur, visit] of TREATMENTS) {
      const r = await client.query(
        `INSERT INTO treatments (tenant_id, name, price, duration_minutes, visit_type, status)
         VALUES ($1,$2,$3,$4,$5,'active')
         ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET
           price = EXCLUDED.price, duration_minutes = EXCLUDED.duration_minutes
         RETURNING id`,
        [tenantId, name, price, dur, visit],
      );
      treatmentIds[name] = r.rows[0].id;
    }

    /* ── patients ── */
    const patientIds = [];
    for (let i = 0; i < PATIENTS.length; i++) {
      const [first, last, gender, city, postal] = PATIENTS[i];
      const email = `${first}.${last}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z.]/g, '');
      const existing = await client.query(
        'SELECT id FROM patients WHERE tenant_id=$1 AND first_name=$2 AND last_name=$3',
        [tenantId, first, last],
      );
      if (existing.rows[0]) {
        patientIds.push(existing.rows[0].id);
        continue;
      }
      // Registration dates are spread across the last ~18 months. Without
      // this every patient reads "Registered today", which is the clearest
      // possible tell that the data was generated.
      const registeredAt = dayAt(-int(5, 540), int(8, 17), int(0, 59));
      const r = await client.query(
        `INSERT INTO patients
           (tenant_id, first_name, last_name, phone, email, gender, birth_date,
            address, city, postal_code, status, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$12) RETURNING id`,
        [
          tenantId, first, last, phone(), `${email}@example.at`, gender, birthDate(i),
          `${pick(['Lange Gasse', 'Neubaugasse', 'Josefstädter Straße', 'Praterstraße', 'Wiedner Hauptstraße'])} ${int(2, 148)}`,
          city, postal, ownerId, registeredAt,
        ],
      );
      patientIds.push(r.rows[0].id);
    }

    /* ── appointments: 8 weeks of history + 2 weeks ahead ── */
    const apptCount = await client.query(
      'SELECT count(*)::int AS c FROM appointments WHERE tenant_id=$1',
      [tenantId],
    );
    const createdAppointments = [];
    if (apptCount.rows[0].c === 0) {
      for (let offset = -56; offset <= 14; offset++) {
        const d = dayAt(offset, 9, 0);
        const weekday = d.getDay();
        if (weekday === 0 || weekday === 6) continue; // clinic closed
        const perDay = offset <= 0 ? int(3, 6) : int(2, 5);
        let slot = 0;
        // No patient twice in one day — three consecutive slots for the same
        // person looked like a generator artefact on the week view.
        const seenToday = new Set();
        for (let n = 0; n < perDay; n++) {
          const treatment = pick(TREATMENTS);
          const durationMin = treatment[2];
          const start = dayAt(offset, 8 + Math.floor(slot / 2), (slot % 2) * 30);
          slot += Math.ceil(durationMin / 30);
          if (start.getHours() >= 18) break;
          const end = new Date(start.getTime() + durationMin * 60000);

          let status = 'scheduled';
          if (offset < 0) {
            const roll = rnd();
            status = roll < 0.86 ? 'completed' : roll < 0.94 ? 'cancelled' : 'no_show';
          }
          let patientId = pick(patientIds);
          for (let tries = 0; seenToday.has(patientId) && tries < 8; tries++) {
            patientId = pick(patientIds);
          }
          seenToday.add(patientId);

          // Migration 0014 makes a 'completed' appointment with no
          // completed_at unrepresentable, so the terminal timestamp is written
          // with the row rather than patched in afterwards. A cancellation is
          // dated a day and a half out, which is when patients actually ring.
          const completedAt = status === 'completed' ? end : null;
          const cancelledAt = status === 'cancelled'
            ? new Date(start.getTime() - 36 * 3600 * 1000)
            : null;
          const r = await client.query(
            `INSERT INTO appointments
               (tenant_id, patient_id, staff_id, reason, status, starts_at, ends_at,
                completed_at, cancelled_at, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [tenantId, patientId, pick(dentistIds), pick(REASONS), status, start, end,
             completedAt, cancelledAt, ownerId],
          );
          createdAppointments.push({ id: r.rows[0].id, status, offset });
        }
      }
    }

    /* ── odontogram findings ────────────────────────────────────────────
       Writes tooth_conditions, which is what the chart endpoint reads.
       (The previous version of this block wrote tooth_records — a table
       migration 0015 drops. The seed did not fail gracefully there; it threw
       on the first SELECT and no demo data was created at all.)

       Patient one gets a deliberately complete chart: every one of the
       thirteen conditions, both O/I surface rules, a tooth that is crowned
       AND root-treated, and a three-unit bridge charted the way a dentist
       charts one — abutment, pontic, abutment. It is the fixture the chart
       UI is demonstrated and tested against. */
    const recCount = await client.query(
      'SELECT count(*)::int AS c FROM tooth_conditions WHERE tenant_id=$1',
      [tenantId],
    );
    if (recCount.rows[0].c === 0) {
      const WHOLE_TOOTH = [
        'extracted', 'missing', 'implant', 'impacted', 'crown', 'bridge', 'root_canal',
      ];
      // Occlusal exists only on posteriors, incisal only on anteriors; the
      // schema enforces it, so ask for the right one rather than be rejected.
      const chewing = (tooth) => (tooth % 10 >= 4 ? 'O' : 'I');

      const addFinding = async (patientId, tooth, condition, surface, note, status) => {
        const whole = WHOLE_TOOTH.includes(condition);
        await client.query(
          `INSERT INTO tooth_conditions
             (tenant_id, patient_id, tooth, surface, condition, status, note,
              dentist_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING`,
          [
            tenantId, patientId, tooth, whole ? null : surface, condition,
            status || 'active', note || null, pick(dentistIds), ownerId,
          ],
        );
      };

      const SHOWCASE = [
        [18, 'missing',    null,         'Never erupted.'],
        [17, 'restored',   chewing(17),  'Composite, placed 2024.'],
        [16, 'root_canal', null,         'Three canals, obturated.'],
        [16, 'crown',      null,         'Zirconia over the root-treated tooth.'],
        [15, 'sealant',    chewing(15),  'Preventive.'],
        [14, 'caries',     chewing(14),  'Cavitated, needs restoring.'],
        [14, 'caries',     'M',          'Extends mesially.'],
        [13, 'veneer',     'F',          'Aesthetic facing.'],
        [12, 'watch',      'M',          'Early demineralisation — review in 6 months.'],
        [11, 'fractured',  chewing(11),  'Incisal chip after trauma.'],
        [21, 'implant',    null,         'Titanium fixture, restored.'],
        // Three-unit bridge: 22 and 24 are the abutments, 23 is the pontic.
        [22, 'bridge',     null,         'Distal abutment, 22–24 bridge.'],
        [23, 'missing',    null,         'Pontic of the 22–24 bridge.'],
        [24, 'bridge',     null,         'Mesial abutment, 22–24 bridge.'],
        [25, 'extracted',  null,         'Removed 2023, not replaced.'],
        [26, 'impacted',   null,         'Mesioangular, under review.'],
        [27, 'restored',   chewing(27),  'Amalgam, long-standing.'],
        [27, 'caries',     'D',          'Recurrent at the distal margin.'],
        [28, 'missing',    null,         'Agenesis.'],
        [36, 'crown',      null,         'Full-coverage crown.'],
        [37, 'restored',   chewing(37),  'Composite.'],
        [46, 'restored',   chewing(46),  'Composite.'],
        [47, 'caries',     chewing(47),  'Occlusal lesion.'],
      ];
      for (const [tooth, condition, surface, note] of SHOWCASE) {
        await addFinding(patientIds[0], tooth, condition, surface, note);
      }

      /* Everyone else gets a plausible scatter, so the patient list does not
         look like twelve copies of the same mouth. */
      const POSTERIORS = [16, 17, 26, 27, 36, 37, 46, 47, 14, 15, 24, 25, 34, 35, 44, 45];
      const ANTERIORS = [11, 12, 13, 21, 22, 23, 31, 32, 33, 41, 42, 43];
      const SURFACE_CONDITIONS = ['caries', 'restored', 'restored', 'sealant', 'watch', 'fractured'];
      const WHOLE_CONDITIONS = ['crown', 'root_canal', 'missing', 'extracted', 'veneer'];

      for (const pid of patientIds.slice(1, 12)) {
        const seen = new Set();
        for (let n = 0; n < int(3, 7); n++) {
          const posterior = rnd() < 0.7;
          const tooth = pick(posterior ? POSTERIORS : ANTERIORS);
          const whole = rnd() < 0.25;
          const condition = whole ? pick(WHOLE_CONDITIONS) : pick(SURFACE_CONDITIONS);
          const surface = WHOLE_TOOTH.includes(condition)
            ? null
            : pick([chewing(tooth), 'M', 'D', 'F', 'L']);
          // The schema holds one active row per (tooth, surface, condition);
          // skipping here keeps the seed silent rather than relying on the
          // conflict clause to swallow a collision we could have avoided.
          const key = `${tooth}|${surface ?? '*'}|${condition}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await addFinding(
            pid, tooth, condition, surface,
            pick(['Reviewed at last visit.', 'Patient reports mild sensitivity.',
                  'Scheduled for follow-up.', 'Healing well.']),
            rnd() < 0.75 ? 'active' : 'treated',
          );
        }
      }
    }

    /* ── invoices, line items and payments over the last four months ── */
    const invCount = await client.query(
      'SELECT count(*)::int AS c FROM invoices WHERE tenant_id=$1',
      [tenantId],
    );
    if (invCount.rows[0].c === 0) {
      // Roughly one invoice per completed appointment over the period, which
      // is what a practice of this size actually bills. Fewer than that and
      // the reports show a loss-making clinic.
      // Issue dates are generated first and sorted, so invoice numbers
      // increase with date. Random dates against a running sequence produced
      // INV-0140 dated May sitting above INV-0138 dated July — the first
      // thing a practice manager would notice.
      const issueOffsets = Array.from({ length: 140 }, () => int(1, 120)).sort((a, b) => b - a);

      let seq = 0;
      for (let i = 0; i < 140; i++) {
        seq += 1;
        const daysAgo = issueOffsets[i];
        const issued = dayAt(-daysAgo, int(9, 17), pick([0, 15, 30, 45]));
        const lineCount = rnd() < 0.65 ? 1 : 2;
        const lines = [];
        for (let l = 0; l < lineCount; l++) {
          const [name, price] = pick(TREATMENTS);
          const qty = rnd() < 0.9 ? 1 : 2;
          lines.push({ name, price, qty });
        }
        const total = lines.reduce((s, l) => s + l.price * l.qty, 0);

        // Older invoices are more likely to be settled.
        const roll = rnd();
        const status = daysAgo > 45
          ? (roll < 0.9 ? 'paid' : 'partially_paid')
          : (roll < 0.55 ? 'paid' : roll < 0.8 ? 'partially_paid' : 'unpaid');

        const inv = await client.query(
          `INSERT INTO invoices
             (tenant_id, patient_id, seq, invoice_number, total, status, issued_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [tenantId, pick(patientIds), seq, `INV-${String(seq).padStart(4, '0')}`,
           total, status, isoDate(issued), ownerId],
        );
        const invoiceId = inv.rows[0].id;

        for (const l of lines) {
          await client.query(
            `INSERT INTO invoice_line_items
               (tenant_id, invoice_id, treatment_id, description, quantity, unit_price, amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [tenantId, invoiceId, treatmentIds[l.name], l.name, l.qty, l.price, l.price * l.qty],
          );
        }

        if (status === 'paid' || status === 'partially_paid') {
          const amount = status === 'paid' ? total : Math.max(1, Math.round(total * (0.3 + rnd() * 0.4)));
          // Clamp to now: settlement offsets were pushing recent invoices'
          // payments into the future, so the payments list showed dates that
          // had not happened yet.
          const paidAt = new Date(
            Math.min(
              issued.getTime() + int(0, 6) * 86400000 + int(0, 8) * 3600000,
              Date.now() - int(1, 90) * 60000,
            ),
          );
          await client.query(
            `INSERT INTO payments (tenant_id, invoice_id, amount, method, note, paid_at, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [tenantId, invoiceId, amount, pick(['card', 'card', 'bank', 'cash']),
             status === 'partially_paid' ? 'Part payment at reception' : null, paidAt, ownerId],
          );
        }
      }
    }

    /* ── running costs ── */
    const expCount = await client.query(
      'SELECT count(*)::int AS c FROM expenses WHERE tenant_id=$1',
      [tenantId],
    );
    if (expCount.rows[0].c === 0) {
      for (let m = 0; m < 4; m++) {
        const base = -m * 30;
        const rows = [
          ['rent', 2400, 'Practice rent'],
          ['utilities', int(210, 340), 'Electricity, water, heating'],
          ['materials', int(680, 1450), 'Composite, anaesthetic and consumables'],
          ['lab', int(900, 2100), 'Prosthetics laboratory work'],
          ['other', int(120, 380), pick(['Equipment servicing', 'Waste disposal contract', 'Software subscriptions'])],
        ];
        for (const [category, amount, note] of rows) {
          await client.query(
            `INSERT INTO expenses (tenant_id, category, amount, expense_date, note, created_by)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [tenantId, category, amount, isoDate(dayAt(base - int(0, 20), 12, 0)), note, ownerId],
          );
        }
      }
    }

    /* ── payroll log ── */
    const salCount = await client.query(
      'SELECT count(*)::int AS c FROM salary_payments WHERE tenant_id=$1',
      [tenantId],
    );
    if (salCount.rows[0].c === 0) {
      for (let m = 1; m <= 3; m++) {
        for (const s of STAFF) {
          await client.query(
            `INSERT INTO salary_payments
               (tenant_id, staff_id, position, amount, paid_on, note, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [tenantId, staffIds[s.email], s.position, s.salary,
             isoDate(dayAt(-m * 30, 12, 0)), 'Monthly salary', ownerId],
          );
        }
      }
    }

    /* ── a few clinical notes ── */
    const noteCount = await client.query(
      'SELECT count(*)::int AS c FROM patient_notes WHERE tenant_id=$1',
      [tenantId],
    );
    if (noteCount.rows[0].c === 0) {
      const NOTES = [
        'Patient reports sensitivity to cold on the upper left quadrant.',
        'Allergy noted: penicillin. Flagged for all future prescriptions.',
        'Prefers morning appointments. Works shifts.',
        'Anxious patient — allow extra chair time and explain each step.',
        'Recall due in six months for periodontal review.',
        'Referred by Dr. Brandt for orthodontic assessment.',
      ];
      for (let i = 0; i < NOTES.length; i++) {
        await client.query(
          `INSERT INTO patient_notes (tenant_id, patient_id, body, author_id)
           VALUES ($1,$2,$3,$4)`,
          [tenantId, patientIds[i], NOTES[i], pick(dentistIds)],
        );
      }
    }

    /* ── reminder history for past appointments ── */
    const remCount = await client.query(
      'SELECT count(*)::int AS c FROM reminders WHERE tenant_id=$1',
      [tenantId],
    );
    if (remCount.rows[0].c === 0 && createdAppointments.length) {
      const recent = createdAppointments.filter((a) => a.offset >= -14 && a.offset < 0).slice(0, 12);
      for (const a of recent) {
        const appt = await client.query(
          `SELECT a.starts_at, a.reason, (p.first_name || ' ' || p.last_name) AS patient
             FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id=$1`,
          [a.id],
        );
        const row = appt.rows[0];
        const when = new Date(row.starts_at);
        const message =
          `Hi ${row.patient}, this is a reminder of your appointment (${row.reason}) at ` +
          `${CLINIC.name} on ${when.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} ` +
          `at ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. ` +
          `Reply to the clinic if you need to reschedule.`;
        await client.query(
          `INSERT INTO reminders
             (tenant_id, appointment_id, type, channel, status, message, sent_at, created_by)
           VALUES ($1,$2,'automatic','log','sent',$3,$4,NULL)`,
          [tenantId, a.id, message, new Date(when.getTime() - 24 * 3600 * 1000)],
        );
      }
    }

    await client.query('COMMIT');

    /* ── summary ── */
    const counts = await client.query(
      `SELECT
         (SELECT count(*) FROM patients     WHERE tenant_id=$1) AS patients,
         (SELECT count(*) FROM appointments WHERE tenant_id=$1) AS appointments,
         (SELECT count(*) FROM treatments   WHERE tenant_id=$1) AS treatments,
         (SELECT count(*) FROM invoices     WHERE tenant_id=$1) AS invoices,
         (SELECT count(*) FROM payments     WHERE tenant_id=$1) AS payments,
         (SELECT count(*) FROM expenses     WHERE tenant_id=$1) AS expenses,
         (SELECT count(*) FROM users        WHERE tenant_id=$1) AS staff,
         (SELECT count(*) FROM reminders    WHERE tenant_id=$1) AS reminders`,
      [tenantId],
    );
    const c = counts.rows[0];

    console.log('  Demo clinic ready.\n');
    console.log(`    Clinic     ${CLINIC.name}  (subdomain: ${CLINIC.subdomain})`);
    console.log(`    Staff      ${c.staff}`);
    console.log(`    Patients   ${c.patients}`);
    console.log(`    Bookings   ${c.appointments}`);
    console.log(`    Catalogue  ${c.treatments} treatments`);
    console.log(`    Invoices   ${c.invoices}  (${c.payments} payments)`);
    console.log(`    Expenses   ${c.expenses}`);
    console.log(`    Reminders  ${c.reminders}\n`);
    console.log('  Clinic app  →  demo@dentx.app / ' + DEMO_PASSWORD);
    console.log('  Admin app   →  ' + PLATFORM_ADMIN.email + ' / ' + DEMO_PASSWORD + '\n');
  } catch (err) {
    await client.query('ROLLBACK');
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

module.exports = { CLINIC, STAFF, TREATMENTS, PATIENTS, DEMO_PASSWORD };
