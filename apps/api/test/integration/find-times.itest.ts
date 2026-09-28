import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner } from './db';
import { createOperatory, createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * "When can she come in?" — GET /appointments/find-times, and the pieces of
 * the booking flow that lean on it: conflicts that say what to do next, a
 * move that does not collide with itself, and a check-in that can be undone.
 *
 * Monday 1 March 2027: far enough ahead that "now" never hides a time, and
 * Tirana is on winter time (UTC+1), so 09:00 on the clinic's clock is 08:00Z.
 */

let api: TestApi;
let s: Scenario;
let token: string;
let dentist: string;
let second: string;
let home: string;
let other: string;

const MONDAY = '2027-03-01';
const A = (body?: unknown) => ({ token, subdomain: s.a.subdomain, body });

interface Found {
  times: {
    startsAt: string;
    endsAt: string;
    staffId: string | null;
    staffName: string | null;
    operatoryId: string | null;
  }[];
  usualStaffId: string | null;
  from: string;
  nextFrom: string;
}
const find = (query: string) =>
  call<Found>(api, 'GET', `/api/appointments/find-times?${query}`, A());

async function practitioner(name: string, room: string | null) {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status,
                        sees_patients, home_operatory_id)
     VALUES ($1,$2,$3,$4,'dentist','active', true, $5) RETURNING id`,
    [
      s.a.id,
      `${name.toLowerCase().replace(/\W/g, '')}@${s.a.subdomain}.test`,
      await bcrypt.hash(s.password, 4),
      name,
      room,
    ],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  home = await createOperatory(s.a);
  other = await createOperatory(s.a);
  dentist = await practitioner('Dr. Ardit Hoxha', home);
  second = await practitioner('Dr. Elira Dervishi', null);
  token = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('finding a time', () => {
  it('offers the soonest times, each with a practitioner and a room', async () => {
    const res = await find(`duration=30&from=${MONDAY}&days=2`);
    expect(res.status).toBe(200);
    const { times } = res.body;
    // A spread day: its first free time in the morning, at midday and in the
    // afternoon — on the clinic's clock, inside the default opening hours.
    expect(times.slice(0, 3).map((t) => t.startsAt)).toEqual([
      '2027-03-01T08:00:00.000Z',
      '2027-03-01T11:00:00.000Z',
      '2027-03-01T14:00:00.000Z',
    ]);
    for (const t of times) {
      expect([dentist, second]).toContain(t.staffId);
      expect([home, other]).toContain(t.operatoryId);
    }
    expect(res.body.nextFrom).toBe('2027-03-03');
  });

  it('starts a practitioner in their own room', async () => {
    const res = await find(`duration=30&from=${MONDAY}&days=1&staffId=${dentist}`);
    expect(res.body.times[0]).toMatchObject({ staffId: dentist, operatoryId: home });
  });

  it("follows a practitioner's shift on the clinic's clock", async () => {
    await owner().query(
      `INSERT INTO staff_availability (tenant_id, staff_id, weekday, starts_at, ends_at)
       VALUES ($1, $2, 1, '14:00', '16:00')`,
      [s.a.id, second],
    );
    const res = await find(
      `duration=30&from=${MONDAY}&days=1&spread=0&staffId=${second}`,
    );
    const starts = res.body.times.map((t) => t.startsAt);
    expect(starts[0]).toBe('2027-03-01T13:00:00.000Z');
    expect(starts.at(-1)).toBe('2027-03-01T14:30:00.000Z');

    // The older per-practitioner endpoint reads the same shift the same way.
    const slots = await call<{ slots: { startsAt: string }[] }>(
      api,
      'GET',
      `/api/appointments/free-slots?staffId=${second}&date=${MONDAY}&duration=60`,
      A(),
    );
    expect(slots.body.slots.map((x) => x.startsAt)).toEqual([
      '2027-03-01T13:00:00.000Z',
      '2027-03-01T14:00:00.000Z',
    ]);
  });

  it('refuses a question it cannot answer, in words', async () => {
    expect((await find('duration=2')).status).toBe(400);
    expect((await find('duration=30&staffId=nobody')).status).toBe(400);
    expect((await find('duration=30&from=2027-02-30')).status).toBe(400);
  });
});

describe('booking what was found', () => {
  let booked: string;

  it('books an offered time, and stops offering it', async () => {
    const first = (await find(`duration=30&from=${MONDAY}&days=1&staffId=${dentist}`))
      .body.times[0]!;
    const res = await call<{ id: string }>(
      api,
      'POST',
      '/api/appointments',
      A({
        patientId: s.a.patientId,
        staffId: first.staffId,
        operatoryId: first.operatoryId,
        startsAt: first.startsAt,
        endsAt: first.endsAt,
        reason: 'Check-up',
      }),
    );
    expect(res.status).toBe(201);
    booked = res.body.id;

    const again = await find(`duration=30&from=${MONDAY}&days=1&staffId=${dentist}`);
    expect(again.body.times[0]!.startsAt).toBe('2027-03-01T08:30:00.000Z');
  });

  it('says a taken time is taken, with a code the screen can act on', async () => {
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO patients (tenant_id, first_name, last_name) VALUES ($1,'Jona','Meta')
       RETURNING id`,
      [s.a.id],
    );
    const res = await call<{ code: string; message: string }>(
      api,
      'POST',
      '/api/appointments',
      A({
        patientId: rows[0]!.id,
        staffId: dentist,
        startsAt: '2027-03-01T08:00:00.000Z',
        endsAt: '2027-03-01T08:30:00.000Z',
        reason: 'Check-up',
      }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slot_taken');
    expect(res.body.message).toMatch(/already booked/);

    const busy = await call<{ code: string }>(
      api,
      'POST',
      '/api/appointments',
      A({
        patientId: s.a.patientId,
        startsAt: '2027-03-01T08:15:00.000Z',
        endsAt: '2027-03-01T08:45:00.000Z',
        reason: 'Check-up',
      }),
    );
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('patient_busy');
  });

  it('never offers the patient a time they are already booked', async () => {
    const res = await find(
      `duration=30&from=${MONDAY}&days=1&spread=0&patientId=${s.a.patientId}`,
    );
    expect(res.body.times.map((t) => t.startsAt)).not.toContain(
      '2027-03-01T08:00:00.000Z',
    );
  });

  it('moving a visit does not collide with where it is now', async () => {
    const res = await find(
      `duration=30&from=${MONDAY}&days=1&staffId=${dentist}&ignore=${booked}`,
    );
    expect(res.body.times[0]!.startsAt).toBe('2027-03-01T08:00:00.000Z');
  });

  it('can take a check-in back', async () => {
    const path = `/api/appointments/${booked}/status`;
    expect((await call(api, 'POST', path, A({ status: 'checked_in' }))).status).toBe(201);
    const back = await call<{ status: string; checkedInAt: string | null }>(
      api,
      'POST',
      path,
      A({ status: 'scheduled' }),
    );
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ status: 'scheduled', checkedInAt: null });
  });
});

describe("the patient's own dentist", () => {
  it('comes first once they have been seen', async () => {
    await owner().query(
      `INSERT INTO appointments (tenant_id, patient_id, staff_id, reason, status,
                                 starts_at, ends_at, completed_at)
       VALUES ($1, $2, $3, 'Filling', 'completed',
               '2026-01-05T09:00:00Z', '2026-01-05T09:30:00Z', '2026-01-05T09:30:00Z')`,
      [s.a.id, s.a.patientId, second],
    );
    // The next Monday: Dr. Ardit works all day, Dr. Elira from 14:00.
    const res = await find(
      `duration=30&from=2027-03-08&days=1&spread=0&patientId=${s.a.patientId}`,
    );
    expect(res.body.usualStaffId).toBe(second);
    const byStart = new Map(res.body.times.map((t) => [t.startsAt, t.staffId]));
    // In the morning only Dr. Ardit is there; from two, both are free and
    // the patient's own dentist is the one offered.
    expect(byStart.get('2027-03-08T08:00:00.000Z')).toBe(dentist);
    expect(byStart.get('2027-03-08T13:00:00.000Z')).toBe(second);
  });
});
