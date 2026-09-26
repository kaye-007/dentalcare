import { createHash, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { importSigningKey, parseSigningMaterial } from './fiscal-crypto';
import {
  FiscalValidationError,
  computeIic,
  fiscalTotals,
  iicInput,
  issueDateTime,
  money,
  parseCisResponse,
  registerCashDepositXml,
  registerInvoiceXml,
  renderXml,
  signRequest,
  soapEnvelope,
  verificationUrl,
  type FiscalInvoiceInput,
} from './fiscal-xml';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const certPem = fixture('test-cert.pem');

async function material() {
  const m = await parseSigningMaterial(`${fixture('test-key.pem')}\n${certPem}`);
  return { key: await importSigningKey(m.pkcs8), certDer: m.certificateDer };
}

const header = { uuid: '5d8f7c1e-8a64-4f4b-9d1e-0c2b3a4d5e6f', sendDateTime: '2026-09-15T10:30:05+02:00' };

function invoice(over: Partial<FiscalInvoiceInput> = {}): FiscalInvoiceInput {
  return {
    nipt: 'L12345678A',
    seller: { name: 'Klinika "Dhëmbi" & Co', address: 'Rruga e Kavajës 12', town: 'Tiranë' },
    businessUnitCode: 'ab123ab123',
    tcrCode: 'cd456cd456',
    operatorCode: 'ef789ef789',
    softwareCode: 'gh012gh012',
    invOrdNum: 41,
    year: 2026,
    issueDateTime: '2026-09-15T10:30:00+02:00',
    typeOfInv: 'CASH',
    isIssuerInVat: false,
    vatExemptionCode: 'TYPE_1',
    payMethods: [{ type: 'BANKNOTE', amount: 1_200_000 }],
    items: [
      { name: 'Mbushje kompozit', unit: 'copë', quantity: 2, unitPrice: 500_000, discountAmount: 0, taxRateBp: 0, taxAmount: 0, total: 1_000_000 },
      { name: 'Pastrim', code: 'D1110', unit: 'copë', quantity: 1, unitPrice: 250_000, discountAmount: 50_000, taxRateBp: 0, taxAmount: 0, total: 200_000 },
    ],
    totalPrice: 1_200_000,
    ...over,
  };
}

describe('values as CIS writes them', () => {
  it('writes money exactly, from minor units', () => {
    expect(money(1_200_050)).toBe('12000.50');
    expect(money(5)).toBe('0.05');
    expect(money(-3000)).toBe('-30.00');
  });

  it('writes the issue time in the clinic’s zone with its offset, summer and winter', () => {
    expect(issueDateTime(new Date('2026-09-15T08:30:00Z'))).toBe('2026-09-15T10:30:00+02:00');
    expect(issueDateTime(new Date('2026-01-15T08:30:00Z'))).toBe('2026-01-15T09:30:00+01:00');
  });
});

describe('the NSLF (IIC)', () => {
  it('signs the pipe-joined fields and hashes the signature', async () => {
    const { key } = await material();
    const i = invoice();
    expect(iicInput(i)).toBe(
      'L12345678A|2026-09-15T10:30:00+02:00|41|ab123ab123|cd456cd456|gh012gh012|12000.00',
    );
    const { iic, iicSignature } = await computeIic(key, i);
    expect(iic).toMatch(/^[0-9A-F]{32}$/);
    const signature = Buffer.from(iicSignature, 'hex');
    expect(createHash('md5').update(signature).digest('hex').toUpperCase()).toBe(iic);
    expect(createVerify('RSA-SHA256').update(iicInput(i)).verify(certPem, signature)).toBe(true);
  });

  it('puts every field the portal needs into the verification link', () => {
    const url = new URL(verificationUrl('https://example.test/verify', invoice(), 'A'.repeat(32)));
    expect(url.searchParams.get('crtd')).toBe('2026-09-15T10:30:00+02:00');
    expect(url.search).toContain('%2B02%3A00');
    expect(url.searchParams.get('prc')).toBe('12000.00');
    expect(url.searchParams.get('ord')).toBe('41');
  });
});

describe('registerInvoiceXml', () => {
  const codes = { iic: 'A'.repeat(32), iicSignature: 'B'.repeat(512) };

  it('refuses an invoice whose lines or payments do not add up', () => {
    expect(() => fiscalTotals(invoice({ totalPrice: 1_199_999 }))).toThrow(FiscalValidationError);
    expect(() =>
      fiscalTotals(invoice({ payMethods: [{ type: 'BANKNOTE', amount: 1_000_000 }] })),
    ).toThrow(/payment methods/);
  });

  it('writes canonical XML: sorted attributes, escaped values, no self-closing tags', () => {
    const xml = registerInvoiceXml(invoice(), header, codes);
    expect(xml.startsWith('<RegisterInvoiceRequest xmlns="https://eFiskalizimi.tatime.gov.al/FiscalizationService/schema" Id="Request" Version="3">')).toBe(true);
    expect(xml).toContain('Name="Klinika &quot;Dhëmbi&quot; &amp; Co"');
    expect(xml).not.toMatch(/\/>/);
    expect(xml).toContain('<Header SendDateTime="2026-09-15T10:30:05+02:00" UUID="5d8f7c1e-8a64-4f4b-9d1e-0c2b3a4d5e6f"></Header>');
    expect(xml).toContain('InvNum="41/2026/cd456cd456"');
  });

  it('leaves VAT out entirely for an issuer outside the VAT system', () => {
    const xml = registerInvoiceXml(invoice(), header, codes);
    expect(xml).not.toContain('TotVATAmt');
    expect(xml).not.toContain('SameTaxes');
    expect(xml).not.toMatch(/ VR=/);
  });

  it('writes VAT rates, exemptions and the same-tax groups for a VAT issuer', () => {
    const xml = registerInvoiceXml(
      invoice({
        isIssuerInVat: true,
        items: [
          { name: 'Zbardhim', unit: 'copë', quantity: 1, unitPrice: 1_000_000, discountAmount: 0, taxRateBp: 2000, taxAmount: 200_000, total: 1_200_000 },
          { name: 'Kontroll', unit: 'copë', quantity: 1, unitPrice: 300_000, discountAmount: 0, taxRateBp: 0, taxAmount: 0, total: 300_000 },
        ],
        payMethods: [{ type: 'CARD', amount: 1_500_000 }],
        totalPrice: 1_500_000,
      }),
      header,
      codes,
    );
    expect(xml).toContain('TotPriceWoVAT="13000.00" TotVATAmt="2000.00" TypeOfInv="CASH"');
    expect(xml).toContain('VA="2000.00" VR="20.00"');
    expect(xml).toContain('EX="TYPE_1"');
    expect(xml).toContain('<SameTax ExemptFromVAT="TYPE_1" NumOfItems="1" PriceBefVAT="3000.00"></SameTax>');
    expect(xml).toContain('<SameTax NumOfItems="1" PriceBefVAT="10000.00" VATAmt="2000.00" VATRate="20.00"></SameTax>');
  });

  it('writes the rebate on a discounted line', () => {
    expect(registerInvoiceXml(invoice(), header, codes)).toContain('R="20.00" RR="true"');
  });
});

describe('the XML signature', () => {
  function verify(xml: string): boolean {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const node = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
    if (!node) throw new Error('no signature');
    const sig = new SignedXml({ publicCert: certPem });
    sig.loadSignature(node as unknown as Parameters<SignedXml['loadSignature']>[0]);
    return sig.checkSignature(xml);
  }

  it('is accepted by an independent XML-DSig implementation', async () => {
    const { key, certDer } = await material();
    const unsigned = registerInvoiceXml(invoice(), header, await computeIic(key, invoice()));
    const signed = await signRequest(unsigned, key, certDer);
    expect(verify(signed)).toBe(true);
  });

  it('still verifies inside the SOAP envelope it is sent in', async () => {
    const { key, certDer } = await material();
    const signed = await signRequest(
      registerCashDepositXml(
        { nipt: 'L12345678A', tcrCode: 'cd456cd456', operation: 'INITIAL', amount: 0, changeDateTime: header.sendDateTime },
        header,
      ),
      key,
      certDer,
    );
    const envelope = soapEnvelope(signed);
    const doc = new DOMParser().parseFromString(envelope, 'text/xml');
    const request = doc.getElementsByTagNameNS(
      'https://eFiskalizimi.tatime.gov.al/FiscalizationService/schema',
      'RegisterCashDepositRequest',
    )[0]!;
    expect(verify(request.toString())).toBe(true);
  });

  it('fails once a signed amount is changed', async () => {
    const { key, certDer } = await material();
    const signed = await signRequest(registerInvoiceXml(invoice(), header, await computeIic(key, invoice())), key, certDer);
    const tampered = signed.replace('TotPrice="12000.00"', 'TotPrice="1.00"');
    expect(tampered).not.toBe(signed);
    let ok: boolean;
    try {
      ok = verify(tampered);
    } catch {
      ok = false;
    }
    expect(ok).toBe(false);
  });
});

describe('parseCisResponse', () => {
  it('reads the NIVF from a namespaced answer', () => {
    const xml =
      '<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>' +
      '<ns2:RegisterInvoiceResponse xmlns:ns2="x"><ns2:Header RequestUUID="u"/>' +
      '<ns2:FIC>0f2a3b4c-5d6e-7f80-91a2-b3c4d5e6f708</ns2:FIC></ns2:RegisterInvoiceResponse></env:Body></env:Envelope>';
    expect(parseCisResponse(xml, 'FIC')).toEqual({ ok: true, code: '0f2a3b4c-5d6e-7f80-91a2-b3c4d5e6f708' });
  });

  it('reads a fault, with its code', () => {
    const xml =
      '<env:Envelope><env:Body><env:Fault><faultcode>env:Server</faultcode>' +
      '<faultstring>Signature is not valid &amp; was refused</faultstring>' +
      '<detail><code>11</code></detail></env:Fault></env:Body></env:Envelope>';
    expect(parseCisResponse(xml, 'FIC')).toEqual({
      ok: false,
      faultCode: '11',
      faultString: 'Signature is not valid & was refused',
    });
  });

  it('never reads an unrecognised answer as success', () => {
    expect(parseCisResponse('<html>Bad gateway</html>', 'FIC').ok).toBe(false);
  });
});

describe('renderXml', () => {
  it('escapes text and drops characters XML cannot carry', () => {
    expect(renderXml({ name: 'N', children: ['a<b & c\u0001\r'] })).toBe('<N>a&lt;b &amp; c&#xD;</N>');
  });
});
