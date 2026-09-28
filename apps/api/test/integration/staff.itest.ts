import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The team (0018): what a staff record says, to whom, and the "sees patients"
 * switch that decides who has a calendar column — apart from the role, which
 * decides what someone may do.
 */

let api: TestApi;
let s: Scenario;
let admin: string;
let desk: string;
let deskId: string;

const A = (token: string, body?: unknown) => ({ token, subdomain: s.a.subdomain, body });

interface Staff {
  id: string;
  role: string;
  seesPatients: boolean;
  twoStepEnabled?: boolean;
  fiscalOperatorCode?: string | null;
  salaryAmount?: unknown;
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  const email = `desk@${s.a.subdomain}.test`;
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status, salary_amount)
     VALUES ($1,$2,$3,'Desk Person','receptionist','active', 50000) RETURNING id`,
    [s.a.id, email, await bcrypt.hash(s.password, 4)],
  );
  deskId = rows[0]!.id;
  admin = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  desk = (await login(api, s.a.subdomain, email, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('the staff list', () => {
  it('never carries a salary, to anyone', async () => {
    for (const token of [admin, desk]) {
      const res = await call<Staff[]>(api, 'GET', '/api/staff', A(token));
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/salary/i);
    }
  });

  it('shows sign-in and fiscal details to whoever manages staff only', async () => {
    const forAdmin = (await call<Staff[]>(api, 'GET', '/api/staff', A(admin))).body.find((x) => x.id === deskId)!;
    expect(forAdmin).toMatchObject({ twoStepEnabled: false, fiscalOperatorCode: null, seesPatients: false });
    const forDesk = (await call<Staff[]>(api, 'GET', '/api/staff', A(desk))).body.find((x) => x.id === deskId)!;
    expect(forDesk).not.toHaveProperty('twoStepEnabled');
    expect(forDesk).not.toHaveProperty('fiscalOperatorCode');
    expect(forDesk.seesPatients).toBe(false);
  });
});

describe('sees patients', () => {
  it('follows the role for a new account unless told otherwise', async () => {
    const dentist = await call<Staff>(api, 'POST', '/api/staff', A(admin, {
      fullName: 'Dr. New Dentist', email: `dentist@${s.a.subdomain}.test`, password: 'long-enough-1', role: 'dentist',
    }));
    expect(dentist.status).toBe(201);
    expect(dentist.body.seesPatients).toBe(true);

    const owner = await call<Staff>(api, 'POST', '/api/staff', A(admin, {
      fullName: 'The Owner', email: `owner@${s.a.subdomain}.test`, password: 'long-enough-1', role: 'admin',
    }));
    expect(owner.body.seesPatients).toBe(false);

    const treatingAdmin = await call<Staff>(api, 'POST', '/api/staff', A(admin, {
      fullName: 'Dr. Also Admin', email: `drad@${s.a.subdomain}.test`, password: 'long-enough-1', role: 'admin', seesPatients: true,
    }));
    expect(treatingAdmin.body).toMatchObject({ role: 'admin', seesPatients: true });
  });

  it('is changed by an administrator, and the change is on the activity trail', async () => {
    const res = await call<Staff>(api, 'PATCH', `/api/staff/${deskId}`, A(admin, { seesPatients: true }));
    expect(res.status).toBe(200);
    expect(res.body.seesPatients).toBe(true);
    const trail = await ownerQuery<{ summary: string }>(
      `SELECT summary FROM clinic_audit_log WHERE tenant_id = $1 AND action = 'staff.updated' AND entity_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [s.a.id, deskId],
    );
    expect(trail.rows[0]?.summary).toBe('Desk Person now sees patients');
  });

  it('is not changed by anyone else', async () => {
    const res = await call(api, 'PATCH', `/api/staff/${deskId}`, A(desk, { seesPatients: false }));
    expect(res.status).toBe(403);
  });

  it('no longer accepts a salary', async () => {
    const res = await call(api, 'PATCH', `/api/staff/${deskId}`, A(admin, { salaryAmount: 90000 }));
    expect(res.status).toBe(400);
    const row = (await ownerQuery<{ salary_amount: number }>('SELECT salary_amount FROM users WHERE id = $1', [deskId])).rows[0]!;
    expect(row.salary_amount).toBe(50000);
  });
});
