import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner } from './db';
import { createOperatory, createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * A practitioner's home room (0019): the room their new bookings start in.
 * Set by the person themselves or by whoever manages availability, never by
 * a colleague; retiring the room releases it.
 */

let api: TestApi;
let s: Scenario;
let admin: string;
let dentist: string;
let dentistId: string;
let room: string;

const A = (token: string, body?: unknown) => ({ token, subdomain: s.a.subdomain, body });

interface Staff {
  id: string;
  homeOperatoryId: string | null;
}

const homeOf = async (id: string) =>
  (await call<Staff[]>(api, 'GET', '/api/staff', A(admin))).body.find((x) => x.id === id)!
    .homeOperatoryId;

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  room = await createOperatory(s.a);
  const email = `dentist@${s.a.subdomain}.test`;
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status, sees_patients)
     VALUES ($1,$2,$3,'Dr. Home','dentist','active', true) RETURNING id`,
    [s.a.id, email, await bcrypt.hash(s.password, 4)],
  );
  dentistId = rows[0]!.id;
  admin = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  dentist = (await login(api, s.a.subdomain, email, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('home room', () => {
  it('starts empty and a practitioner can set their own', async () => {
    expect(await homeOf(dentistId)).toBeNull();
    const res = await call(api, 'PUT', `/api/availability/home-room/${dentistId}`, A(dentist, { operatoryId: room }));
    expect(res.status).toBe(200);
    expect(await homeOf(dentistId)).toBe(room);
  });

  it("refuses a colleague's without availability:manage", async () => {
    const res = await call(api, 'PUT', `/api/availability/home-room/${s.a.adminId}`, A(dentist, { operatoryId: room }));
    expect(res.status).toBe(403);
  });

  it('lets an administrator set and clear anyone’s', async () => {
    let res = await call(api, 'PUT', `/api/availability/home-room/${dentistId}`, A(admin, { operatoryId: null }));
    expect(res.status).toBe(200);
    expect(await homeOf(dentistId)).toBeNull();
    res = await call(api, 'PUT', `/api/availability/home-room/${dentistId}`, A(admin, { operatoryId: room }));
    expect(await homeOf(dentistId)).toBe(room);
  });

  it('is released when the room is retired, and a retired room cannot be chosen', async () => {
    const off = await call(api, 'PATCH', `/api/operatories/${room}`, A(admin, { isActive: false }));
    expect(off.status).toBe(200);
    expect(await homeOf(dentistId)).toBeNull();

    const res = await call(api, 'PUT', `/api/availability/home-room/${dentistId}`, A(admin, { operatoryId: room }));
    expect(res.status).toBe(400);
  });

  it('cannot point at another clinic’s room', async () => {
    const theirs = await createOperatory(s.b);
    const res = await call(api, 'PUT', `/api/availability/home-room/${dentistId}`, A(admin, { operatoryId: theirs }));
    expect(res.status).toBe(404);
  });
});
