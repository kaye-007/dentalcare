import { call, login, startApi, TestApi } from './api';
import { closePools, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Billing what the chart says was done: **Bill** starts from the dentist's
 * completed procedures, an invoice line can point at the procedure it bills,
 * and the same work can never be on two live invoices.
 */

let api: TestApi;
let s: Scenario;
let token: string;
let filling: string;
let xray: string;
let otherPatientsWork: string;

interface Unbilled {
  procedureId: string;
  description: string;
  fee: number;
  tooth: number | null;
}
interface Invoice {
  id: string;
  invoiceNumber: string;
  total: number;
  patientId: string;
}

const as = (method: string, path: string, body?: unknown) =>
  call<unknown>(api, method, path, { token, subdomain: s.a.subdomain, body });
const unbilled = async () =>
  (await as('GET', `/api/invoices/unbilled?patientId=${s.a.patientId}`))
    .body as Unbilled[];
const bill = (
  lines: { procedureId?: string; description: string; unitPrice: number }[],
) =>
  as('POST', '/api/invoices', {
    patientId: s.a.patientId,
    items: lines.map((l) => ({ ...l, quantity: 1 })),
  });

async function procedure(
  patientId: string,
  description: string,
  fee: number,
  tooth: number | null,
) {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO clinical_procedures
       (tenant_id, patient_id, tooth, description, clinician_id, status, fee, performed_on)
     VALUES ($1,$2,$3,$4,$5,'completed',$6,CURRENT_DATE) RETURNING id`,
    [s.a.id, patientId, tooth, description, s.a.adminId, fee],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  token = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  filling = await procedure(s.a.patientId, 'Mbushje kompoziti', 400000, 36);
  xray = await procedure(s.a.patientId, 'Radiografi periapikale', 100000, null);
  const other = await owner().query<{ id: string }>(
    `INSERT INTO patients (tenant_id, first_name, last_name) VALUES ($1,'Other','Patient') RETURNING id`,
    [s.a.id],
  );
  otherPatientsWork = await procedure(
    other.rows[0]!.id,
    'Ekstraksion dhëmbi',
    300000,
    48,
  );
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('billing charted work', () => {
  it('offers the completed, unbilled procedures as invoice lines', async () => {
    const lines = await unbilled();
    expect(lines.map((l) => l.procedureId).sort()).toEqual([filling, xray].sort());
    expect(lines.find((l) => l.procedureId === filling)).toMatchObject({
      description: 'Mbushje kompoziti',
      fee: 400000,
      tooth: 36,
    });
  });

  it("refuses to bill another patient's procedure", async () => {
    const res = await bill([
      {
        procedureId: otherPatientsWork,
        description: 'Ekstraksion dhëmbi',
        unitPrice: 300000,
      },
    ]);
    expect(res.status).toBe(400);
  });

  it('refuses the same procedure on two lines', async () => {
    const res = await bill([
      { procedureId: filling, description: 'Mbushje kompoziti', unitPrice: 400000 },
      { procedureId: filling, description: 'Mbushje kompoziti', unitPrice: 400000 },
    ]);
    expect(res.status).toBe(400);
  });

  it('links the line to the procedure and takes the tooth from the chart', async () => {
    const res = await bill([
      { procedureId: filling, description: 'Mbushje kompoziti', unitPrice: 400000 },
    ]);
    expect(res.status).toBe(201);
    const inv = res.body as Invoice;
    expect(inv.total).toBe(400000);
    const { rows } = await owner().query(
      'SELECT procedure_id, tooth FROM invoice_line_items WHERE invoice_id = $1',
      [inv.id],
    );
    expect(rows).toEqual([{ procedure_id: filling, tooth: 36 }]);

    // Billed work is no longer offered; the X-ray still is.
    expect((await unbilled()).map((l) => l.procedureId)).toEqual([xray]);
  });

  it('refuses to bill the same work twice', async () => {
    const res = await bill([
      { procedureId: filling, description: 'Mbushje kompoziti', unitPrice: 400000 },
    ]);
    expect(res.status).toBe(409);
  });

  it('offers the work again once its invoice is cancelled', async () => {
    const [inv] = (
      await as('GET', `/api/invoices?patientId=${s.a.patientId}&status=open`)
    ).body as Invoice[];
    expect(inv).toBeDefined();
    const cancelled = await as('PATCH', `/api/invoices/${inv!.id}/cancel`, {
      reason: 'Wrong patient',
    });
    expect([200, 201]).toContain(cancelled.status);
    expect((await unbilled()).map((l) => l.procedureId).sort()).toEqual(
      [filling, xray].sort(),
    );
  });

  it('filters the invoice list by patient', async () => {
    const rows = (await as('GET', `/api/invoices?patientId=${s.a.patientId}`))
      .body as Invoice[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.patientId === s.a.patientId)).toBe(true);
  });

  it('treats work as covered once a hand-built invoice follows it', async () => {
    // A clinic that billed by hand before lines could point at procedures:
    // the later, unlinked invoice is taken to cover the earlier work.
    const res = await bill([{ description: 'Konsultë', unitPrice: 150000 }]);
    expect(res.status).toBe(201);
    expect(await unbilled()).toEqual([]);
  });
});
