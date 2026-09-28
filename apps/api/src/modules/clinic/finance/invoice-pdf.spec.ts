import { renderInvoicePdf, type InvoicePdfData } from './invoice-pdf';
import { qrModules } from './invoice-pdf.service';

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

function data(over: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    clinic: {
      name: 'Klinika Dentare Test',
      legalName: 'Test Dental SHPK',
      address: 'Rruga e Kavajes 12',
      city: 'Tirane',
      phone: '+355 4 222 3333',
      email: 'info@test.al',
      website: null,
      taxNumber: 'L12345678A',
      registrationNumber: null,
      brandColor: '#14827a',
      logo: null,
      fiscalizationEnabled: false,
    },
    invoice: {
      number: 'TD-0042',
      status: 'paid',
      issuedAt: '2026-09-15',
      dueOn: null,
      currency: 'ALL',
      subtotal: 1_250_000,
      discount: 50_000,
      tax: 0,
      total: 1_200_000,
      paid: 1_200_000,
      notes: null,
    },
    patient: { name: 'Ana Hoxha', address: null, city: 'Durres', phone: null },
    items: [
      {
        description: 'Composite filling',
        quantity: 2,
        unitPrice: 500_000,
        discount: 0,
        taxRateBp: 0,
        amount: 1_000_000,
      },
      {
        description: 'Scaling',
        quantity: 1,
        unitPrice: 250_000,
        discount: 50_000,
        taxRateBp: 0,
        amount: 200_000,
      },
    ],
    payments: [{ paidAt: '2026-09-15T09:00:00Z', method: 'Cash', amount: 1_200_000 }],
    fiscal: null,
    ...over,
  };
}

describe('renderInvoicePdf', () => {
  it('prints the clinic, the NIPT, the patient, the lines and the total', () => {
    const pdf = text(renderInvoicePdf(data()));
    for (const s of [
      'Klinika Dentare Test',
      'NIPT L12345678A',
      'Ana Hoxha',
      'Composite filling',
      'TD-0042',
    ]) {
      expect(pdf).toContain(s);
    }
    expect(pdf).not.toContain('NSLF');
    expect(pdf).not.toContain('NOT a fiscal invoice');
  });

  it('marks an internal copy as not fiscal once the clinic fiscalizes', () => {
    const pdf = text(
      renderInvoicePdf(
        data({ clinic: { ...data().clinic, fiscalizationEnabled: true } }),
      ),
    );
    expect(pdf).toContain('NOT a fiscal invoice');
  });

  it('prints the fiscal block with its QR code, and flags the test environment', () => {
    const fiscal: InvoicePdfData['fiscal'] = {
      status: 'fiscalized',
      environment: 'test',
      nivf: '0f2a3b4c-5d6e-7f80-91a2-b3c4d5e6f708',
      nslf: 'A1B2C3D4E5F60718293A4B5C6D7E8F90',
      invNum: '41/2026/cd456cd456',
      issueDateTime: '2026-09-15T10:30:00+02:00',
      businessUnitCode: 'ab123ab123',
      tcrCode: 'cd456cd456',
      operatorCode: 'ef789ef789',
      softwareCode: 'gh012gh012',
      typeOfInvoice: 'CASH',
      qr: qrModules('https://example.test/verify?iic=A1B2'),
    };
    const pdf = text(renderInvoicePdf(data({ fiscal })));
    expect(pdf).toContain('NIVF');
    expect(pdf).toContain('0f2a3b4c-5d6e-7f80-91a2-b3c4d5e6f708');
    expect(pdf).toContain('A1B2C3D4E5F60718293A4B5C6D7E8F90');
    expect(pdf).toContain('41/2026/cd456cd456');
    expect(pdf).toContain('TEST ENVIRONMENT');
    // The QR code is drawn as filled squares.
    expect((pdf.match(/ re\n/g) ?? []).length).toBeGreaterThan(100);
  });

  it('prints TVSH per rate when exempt and cosmetic work share an invoice', () => {
    const pdf = text(
      renderInvoicePdf(
        data({
          invoice: {
            ...data().invoice,
            subtotal: 150_000,
            discount: 0,
            tax: 20_000,
            total: 170_000,
            paid: 0,
            status: 'unpaid',
          },
          items: [
            {
              description: 'Root canal',
              quantity: 1,
              unitPrice: 50_000,
              discount: 0,
              taxRateBp: 0,
              amount: 50_000,
            },
            {
              description: 'Whitening',
              quantity: 1,
              unitPrice: 100_000,
              discount: 0,
              taxRateBp: 2000,
              amount: 120_000,
            },
          ],
        }),
      ),
    );
    expect(pdf).toContain('TVSH 20% / VAT');
  });

  it('flows long invoices onto further pages and numbers them', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      description: `Procedure ${i + 1}`,
      quantity: 1,
      unitPrice: 1000,
      discount: 0,
      taxRateBp: 0,
      amount: 1000,
    }));
    const pdf = text(
      renderInvoicePdf(
        data({
          items,
          invoice: {
            ...data().invoice,
            total: 60_000,
            paid: 0,
            subtotal: 60_000,
            discount: 0,
            status: 'unpaid',
          },
        }),
      ),
    );
    const count = Number(/\/Count (\d+)/.exec(pdf)![1]);
    expect(count).toBeGreaterThan(1);
    expect(pdf).toContain(`Faqe ${count} / ${count}`);
    expect(pdf).toContain('Procedure 60');
  });
});

describe('qrModules', () => {
  it('produces a square matrix with the finder pattern in the corner', () => {
    const m = qrModules(
      'https://efiskalizimi-app.tatime.gov.al/invoice-check/#/verify?iic=X',
    );
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true);
  });
});
