/* eslint-disable no-console */
/**
 * Seed platform data + two demo clinics. Runs as the admin role (bypasses RLS).
 * Idempotent.   npm run seed
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const PLANS = [
  { code: 'basic', name: 'Basic', price: 2900 },
  { code: 'pro', name: 'Professional', price: 5900 },
  { code: 'clinic_plus', name: 'Clinic+', price: 9900 },
];

const SUPERADMIN = {
  email: 'admin@nodex.al',
  password: 'Admin123!',
  fullName: 'NODE X Admin',
};

const CLINICS = [
  {
    clinic: { name: 'Avicena Clinic', subdomain: 'avicena' },
    plan: 'pro',
    users: [
      { email: 'owner@avicena.al', password: 'Owner123!', fullName: 'Dr. Adam H.', role: 'owner', position: 'Dentist' },
      { email: 'reception@avicena.al', password: 'Reception123!', fullName: 'Front Desk', role: 'frontdesk', position: 'Receptionist', salary: 55000 },
    ],
  },
  {
    clinic: { name: 'Smile Studio', subdomain: 'smile' },
    plan: 'basic',
    users: [
      { email: 'owner@smile.al', password: 'Owner123!', fullName: 'Dr. Lena P.', role: 'owner', position: 'Dentist' },
      { email: 'reception@smile.al', password: 'Reception123!', fullName: 'Reception Smile', role: 'frontdesk', position: 'Receptionist', salary: 50000 },
    ],
  },
];

/**
 * Refuse to run anywhere that looks like production.
 *
 * This script upserts well-known credentials that are published in the README
 * (admin@nodex.al / Admin123!, owner@avicena.al / Owner123!, ...). Running it
 * against a live database would overwrite real passwords with those defaults,
 * handing cross-tenant access to anyone who has read the repo. The upserts
 * below are additive, but a superadmin password reset is not recoverable by
 * re-running anything — so the guard has to come first.
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres', 'host.docker.internal'];

function assertNotProduction(connectionString) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production.');
  }

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string.');
  }

  const host = url.hostname;
  const dbName = url.pathname.replace(/^\//, '');

  if (/prod/i.test(dbName) || /prod/i.test(host)) {
    throw new Error(
      `Refusing to seed: "${host}/${dbName}" looks like production.`,
    );
  }
  if (!LOCAL_HOSTS.includes(host) && process.env.ALLOW_REMOTE_SEED !== 'yes') {
    throw new Error(
      `Refusing to seed a non-local database (${host}).\n` +
        '  This script overwrites passwords with the public demo defaults.\n' +
        '  If you really mean it, set ALLOW_REMOTE_SEED=yes.',
    );
  }

  console.log(`  Seeding ${host}/${dbName}\n`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }
  assertNotProduction(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // plans
    const planIds = {};
    for (const p of PLANS) {
      const r = await client.query(
        `INSERT INTO plans (code, name, price_monthly)
         VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, price_monthly = EXCLUDED.price_monthly
         RETURNING id`,
        [p.code, p.name, p.price],
      );
      planIds[p.code] = r.rows[0].id;
    }

    // superadmin
    const adminHash = await bcrypt.hash(SUPERADMIN.password, 10);
    await client.query(
      `INSERT INTO platform_admins (email, password_hash, full_name, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [SUPERADMIN.email, adminHash, SUPERADMIN.fullName],
    );

    // clinics
    for (const entry of CLINICS) {
      const t = await client.query(
        `INSERT INTO tenants (name, subdomain, status, plan_id)
         VALUES ($1, $2, 'active', $3)
         ON CONFLICT (subdomain) DO UPDATE SET name = EXCLUDED.name, plan_id = EXCLUDED.plan_id
         RETURNING id`,
        [entry.clinic.name, entry.clinic.subdomain, planIds[entry.plan]],
      );
      const tenantId = t.rows[0].id;
      for (const u of entry.users) {
        const hash = await bcrypt.hash(u.password, 10);
        await client.query(
          `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status, position, salary_amount)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
           ON CONFLICT (tenant_id, lower(email))
           DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name,
                         role = EXCLUDED.role, position = EXCLUDED.position, salary_amount = EXCLUDED.salary_amount`,
          [tenantId, u.email, hash, u.fullName, u.role, u.position || null, u.salary || null],
        );
      }
    }


    // ── demo patients + today's appointments (avicena only) ──
    const av = await client.query("SELECT id FROM tenants WHERE subdomain = 'avicena'");
    const avId = av.rows[0].id;
    const owner = await client.query(
      "SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1", [avId]);
    const ownerId = owner.rows[0].id;

    const DEMO_PATIENTS = [
      ['Elira','Hoxha','068 123 4567','elira.hoxha@example.al','female','Tirana'],
      ['Marko','Gjoka','069 222 1111','marko.gjoka@example.al','male','Tirana'],
      ['Sara','Leka','067 555 9012','sara.leka@example.al','female','Durres'],
      ['Driton','Bregu','068 777 3344',null,'male','Tirana'],
      ['Anila','Meta','069 888 1212','anila.meta@example.al','female','Vlore'],
    ];
    const patientIds = [];
    for (const [fn, ln, ph, em, g, city] of DEMO_PATIENTS) {
      const r = await client.query(
        `INSERT INTO patients (tenant_id, first_name, last_name, phone, email, gender, city, status, created_by)
         SELECT $1,$2,$3,$4,$5,$6,$7,'active',$8
          WHERE NOT EXISTS (SELECT 1 FROM patients WHERE tenant_id=$1 AND first_name=$2 AND last_name=$3)
         RETURNING id`, [avId, fn, ln, ph, em, g, city, ownerId]);
      if (r.rows[0]) patientIds.push(r.rows[0].id);
      else {
        const e = await client.query(
          'SELECT id FROM patients WHERE tenant_id=$1 AND first_name=$2 AND last_name=$3', [avId, fn, ln]);
        patientIds.push(e.rows[0].id);
      }
    }

    const apptCount = await client.query(
      'SELECT count(*)::int AS c FROM appointments WHERE tenant_id = $1', [avId]);
    if (apptCount.rows[0].c === 0) {
      const day = (offset, h, m) => {
        const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(h, m, 0, 0); return d;
      };
      const APPTS = [
        [patientIds[0], 'General checkup', day(0, 9, 0), day(0, 9, 45), 'completed'],
        [patientIds[1], 'Root canal — session 2', day(0, 10, 30), day(0, 11, 30), 'scheduled'],
        [patientIds[2], 'Tooth scaling', day(0, 14, 0), day(0, 15, 0), 'scheduled'],
        [patientIds[3], 'Teeth whitening', day(1, 11, 0), day(1, 12, 0), 'scheduled'],
        [patientIds[4], 'Extraction consult', day(2, 9, 30), day(2, 10, 0), 'scheduled'],
      ];
      for (const [pid, reason, st, en, status] of APPTS) {
        await client.query(
          `INSERT INTO appointments (tenant_id, patient_id, staff_id, reason, status, starts_at, ends_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$3)`,
          [avId, pid, ownerId, reason, status, st, en]);
      }
    }


    // ── default treatments catalog (both clinics) ──
    const DEFAULT_TREATMENTS = [
      ['General Checkup', 2000, 30, 'single'],
      ['Tooth Scaling', 4000, 60, 'single'],
      ['Teeth Cleaning', 3000, 45, 'single'],
      ['Tooth Filling', 5000, 60, 'single'],
      ['Tooth Extraction', 7000, 60, 'single'],
      ['Root Canal', 15000, 90, 'multiple'],
      ['Teeth Whitening', 12000, 60, 'multiple'],
    ];
    const allTenants = await client.query(
      "SELECT id FROM tenants WHERE subdomain IN ('avicena','smile')");
    for (const t of allTenants.rows) {
      for (const [name, price, dur, vt] of DEFAULT_TREATMENTS) {
        await client.query(
          `INSERT INTO treatments (tenant_id, name, price, duration_minutes, visit_type)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, lower(name)) DO NOTHING`,
          [t.id, name, price, dur, vt]);
      }
    }

    // ── sample tooth records for the first demo patient (avicena) ──
    const elira = await client.query(
      "SELECT id FROM patients WHERE tenant_id=$1 AND first_name='Elira' AND last_name='Hoxha'", [avId]);
    if (elira.rows[0]) {
      const recCount = await client.query(
        'SELECT count(*)::int AS c FROM tooth_records WHERE patient_id=$1', [elira.rows[0].id]);
      if (recCount.rows[0].c === 0) {
        const filling = await client.query(
          "SELECT id FROM treatments WHERE tenant_id=$1 AND name='Tooth Filling'", [avId]);
        await client.query(
          `INSERT INTO tooth_records (tenant_id, patient_id, tooth, condition, treatment_id, dentist_id, status, note, created_by)
           VALUES ($1,$2,21,'Caries',$3,$4,'done','Advanced decay treated',$4),
                  ($1,$2,36,'Caries',$3,$4,'pending','Decay in pulp — schedule filling',$4)`,
          [avId, elira.rows[0].id, filling.rows[0]?.id ?? null, ownerId]);
      }
    }


    // ── default clinic settings (both clinics) ──
    const DEFAULT_HOURS = JSON.stringify([
      { day: 0, closed: false, open: '09:00', close: '17:00' },
      { day: 1, closed: false, open: '09:00', close: '17:00' },
      { day: 2, closed: false, open: '09:00', close: '17:00' },
      { day: 3, closed: false, open: '09:00', close: '17:00' },
      { day: 4, closed: false, open: '09:00', close: '17:00' },
      { day: 5, closed: false, open: '09:00', close: '14:00' },
      { day: 6, closed: true, open: '09:00', close: '14:00' },
    ]);
    const SETTINGS = {
      avicena: ['Rr. Myslym Shyri 12', 'Tirana', '+355 4 222 1234', 'info@avicena.al'],
      smile: ['Rr. e Kavajes 88', 'Tirana', '+355 4 233 5678', 'hello@smile.al'],
    };
    for (const t of allTenants.rows) {
      const sub = (await client.query('SELECT subdomain FROM tenants WHERE id=$1', [t.id])).rows[0].subdomain;
      const cfg = SETTINGS[sub] || [null, null, null, null];
      const enableReminders = sub === 'avicena';
      await client.query(
        `INSERT INTO clinic_settings (tenant_id, address, city, phone, email, working_hours, reminders_enabled, reminder_hours_before)
         VALUES ($1,$2,$3,$4,$5,$6,$7,24)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [t.id, cfg[0], cfg[1], cfg[2], cfg[3], DEFAULT_HOURS, enableReminders]);
    }


    // ── sample finance data (avicena only, only if empty) ──
    const invCount = await client.query(
      'SELECT count(*)::int AS c FROM invoices WHERE tenant_id = $1', [avId]);
    if (invCount.rows[0].c === 0 && patientIds[0]) {
      // three fully-paid historical invoices across the last three months,
      // so the M9 trend chart has real shape on a fresh database
      const HIST = [
        [90, patientIds[1], 'Tooth Filling', 5000, 'card'],
        [60, patientIds[2], 'Root Canal', 15000, 'cash'],
        [30, patientIds[3], 'Teeth Whitening', 12000, 'bank'],
      ];
      let seq = 0;
      for (const [daysAgo, pid, tname, price, method] of HIST) {
        seq += 1;
        const issued = new Date(); issued.setDate(issued.getDate() - daysAgo);
        const iso = issued.toISOString().slice(0, 10);
        const tr = await client.query(
          'SELECT id FROM treatments WHERE tenant_id=$1 AND name=$2', [avId, tname]);
        const hInv = await client.query(
          `INSERT INTO invoices (tenant_id, patient_id, seq, invoice_number, total, status, issued_at, created_by)
           VALUES ($1,$2,$3,$4,$5,'paid',$6,$7) RETURNING id`,
          [avId, pid, seq, 'INV-' + String(seq).padStart(4, '0'), price, iso, ownerId]);
        await client.query(
          `INSERT INTO invoice_line_items (tenant_id, invoice_id, treatment_id, description, quantity, unit_price, amount)
           VALUES ($1,$2,$3,$4,1,$5,$5)`,
          [avId, hInv.rows[0].id, tr.rows[0]?.id ?? null, tname, price]);
        await client.query(
          `INSERT INTO payments (tenant_id, invoice_id, amount, method, paid_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [avId, hInv.rows[0].id, price, method, issued.toISOString(), ownerId]);
      }

      const scaling = await client.query(
        "SELECT id, name, price FROM treatments WHERE tenant_id=$1 AND name='Tooth Scaling'", [avId]);
      const checkup = await client.query(
        "SELECT id, name, price FROM treatments WHERE tenant_id=$1 AND name='General Checkup'", [avId]);
      const items = [
        [scaling.rows[0]?.id ?? null, 'Tooth Scaling', 1, scaling.rows[0]?.price ?? 4000],
        [checkup.rows[0]?.id ?? null, 'General Checkup', 1, checkup.rows[0]?.price ?? 2000],
      ];
      const total = items.reduce((s, it) => s + it[2] * it[3], 0);
      const inv = await client.query(
        `INSERT INTO invoices (tenant_id, patient_id, seq, invoice_number, total, status, created_by)
         VALUES ($1,$2,4,'INV-0004',$3,'partially_paid',$4) RETURNING id`,
        [avId, patientIds[0], total, ownerId]);
      for (const [tid, desc, qty, price] of items) {
        await client.query(
          `INSERT INTO invoice_line_items (tenant_id, invoice_id, treatment_id, description, quantity, unit_price, amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [avId, inv.rows[0].id, tid, desc, qty, price, qty * price]);
      }
      await client.query(
        `INSERT INTO payments (tenant_id, invoice_id, amount, method, note, created_by)
         VALUES ($1,$2,$3,'cash','Partial payment at desk',$4)`,
        [avId, inv.rows[0].id, Math.floor(total / 2), ownerId]);
    }
    const expCount = await client.query(
      'SELECT count(*)::int AS c FROM expenses WHERE tenant_id = $1', [avId]);
    if (expCount.rows[0].c === 0) {
      const EXPENSES = [
        [0, 'rent', 60000, 'Monthly clinic rent'],
        [0, 'materials', 18500, 'Composite + anesthetic restock'],
        [0, 'utilities', 7200, 'Electricity and water'],
        [0, 'lab', 12000, 'Crown lab work'],
        [30, 'rent', 60000, 'Monthly clinic rent'],
        [30, 'materials', 9300, 'Impression material'],
        [60, 'rent', 60000, 'Monthly clinic rent'],
        [60, 'utilities', 6800, 'Electricity and water'],
        [90, 'rent', 60000, 'Monthly clinic rent'],
        [90, 'lab', 8000, 'Bridge lab work'],
      ];
      for (const [daysAgo, cat, amt, note] of EXPENSES) {
        const d = new Date(); d.setDate(d.getDate() - daysAgo);
        await client.query(
          `INSERT INTO expenses (tenant_id, category, amount, expense_date, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [avId, cat, amt, d.toISOString().slice(0, 10), note, ownerId]);
      }
    }

    await client.query('COMMIT');

    console.log('\n  Seed complete.\n');
    console.log('  Superadmin (admin-web):');
    console.log(`    ${SUPERADMIN.email} / ${SUPERADMIN.password}\n`);
    console.log('  Demo clinics (tenant-web):');
    for (const e of CLINICS) {
      console.log(`    ${e.clinic.name} (${e.clinic.subdomain}) — plan ${e.plan}`);
      for (const u of e.users) console.log(`      ${u.role.padEnd(9)} ${u.email} / ${u.password}`);
    }
    console.log('');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
