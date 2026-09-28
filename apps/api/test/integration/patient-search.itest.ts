import { call, login, startApi, TestApi } from './api';
import { closePools, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Finding a patient the way the desk actually types: a phone number said
 * aloud ("069 123 4567") against one stored with its country code
 * ("+355 69 123 4567"), and a name whose first letters were typed.
 */

let api: TestApi;
let s: Scenario;
let token: string;

interface Found {
  items: { firstName: string; lastName: string }[];
}
const search = async (q: string) =>
  (
    await call<Found>(api, 'GET', `/api/patients?q=${encodeURIComponent(q)}`, {
      token,
      subdomain: s.a.subdomain,
    })
  ).body.items.map((p) => `${p.firstName} ${p.lastName}`);

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  await owner().query(
    `INSERT INTO patients (tenant_id, first_name, last_name, phone)
     VALUES ($1,'Arta','Leka','+355 69 123 4567'),
            ($1,'Leka','Duka','+355 68 765 4321'),
            ($1,'Mira','Aleksi','+355 67 000 1111'),
            ($1,'Erisa','Çela',NULL),
            ($1,'Ana Maria','Hoxhë',NULL)`,
    [s.a.id],
  );
  token = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('patient search', () => {
  it('finds a number typed with the trunk zero and spaces', async () => {
    expect(await search('069 123 4567')).toEqual(['Arta Leka']);
  });

  it('finds a number typed with the country code and no spaces', async () => {
    expect(await search('+355691234567')).toEqual(['Arta Leka']);
  });

  it('finds a partial number', async () => {
    expect(await search('765 43')).toEqual(['Leka Duka']);
  });

  it('puts whoever starts with the typed name first', async () => {
    // "Leka" is Arta's surname and Leka Duka's first name; "Aleksi" merely
    // contains it. Both prefix matches come before the contains match.
    const found = await search('Lek');
    expect(found.slice(0, 2).sort()).toEqual(['Arta Leka', 'Leka Duka']);
    expect(found[2]).toBe('Mira Aleksi');
  });

  it('finds a name typed without its ë or ç', async () => {
    expect(await search('cela')).toEqual(['Erisa Çela']);
    expect(await search('hoxhe')).toEqual(['Ana Maria Hoxhë']);
    // And the other way round: an accent typed where the record has none.
    expect(await search('Lëka')).toContain('Arta Leka');
  });

  it('finds a name typed surname first, or by a later given name', async () => {
    expect(await search('Cela Erisa')).toEqual(['Erisa Çela']);
    expect(await search('maria hox')).toEqual(['Ana Maria Hoxhë']);
  });
});
