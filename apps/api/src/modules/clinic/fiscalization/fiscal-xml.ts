import { createHash, randomUUID } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { signRsaSha256 } from './fiscal-crypto';

/**
 * Albanian fiscalization messages: the XML, the codes, the signature.
 *
 * ── Status of this file ───────────────────────────────────────────────────
 *
 * Written to the DPT's Central Information System schema as published for
 * fiscalization (RegisterInvoiceRequest / RegisterCashDepositRequest, XML-DSig
 * enveloped signature, RSA-SHA256, exclusive canonicalization). It has been
 * checked against an independent XML-DSig implementation (xml-crypto, in the
 * spec) and NOT yet against the authority's test service, which needs a test
 * certificate and registered business unit, register and operator codes.
 * Treat the element and attribute set as a first draft to confirm there; see
 * DEPLOYMENT.md, "Fiscalization".
 *
 * ── Canonical by construction ─────────────────────────────────────────────
 *
 * The signature covers the canonical form of the request. Rather than parse
 * and canonicalize XML, this file only ever WRITES XML that is already in
 * exclusive-c14n form: one namespace declaration on the root, attributes
 * sorted, no self-closing tags, the c14n escaping rules, no whitespace
 * between elements. What is digested is then exactly the string produced.
 */

export const FISCAL_NS = 'https://eFiskalizimi.tatime.gov.al/FiscalizationService/schema';
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

/* ── writing canonical XML ───────────────────────────────────────────── */

export interface XmlNode {
  name: string;
  attrs?: Record<string, string | undefined>;
  children?: (XmlNode | string)[];
}

// XML 1.0 forbids most C0 controls outright, even escaped. A legacy import
// can carry one in a patient or treatment name; it is dropped, not sent.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function escapeText(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

function escapeAttr(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

/** Namespace declarations first, then attributes in code-point order. */
export function renderXml(node: XmlNode): string {
  const entries = Object.entries(node.attrs ?? {}).filter(
    (e): e is [string, string] => e[1] !== undefined,
  );
  const ns = entries.filter(([k]) => k === 'xmlns');
  const plain = entries
    .filter(([k]) => k !== 'xmlns')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const attrs = [...ns, ...plain].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  const inner = (node.children ?? [])
    .map((c) => (typeof c === 'string' ? escapeText(c) : renderXml(c)))
    .join('');
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}

/* ── values as CIS writes them ───────────────────────────────────────── */

/** Minor units -> "1234.50". Exact: integer arithmetic, never a float. */
export function money(minor: number): string {
  if (!Number.isSafeInteger(minor))
    throw new RangeError(`not an amount in minor units: ${minor}`);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Basis points -> "20.00". */
export function rate(bp: number): string {
  return money(bp);
}

/**
 * "2026-09-15T10:30:00+02:00": local wall time in the clinic's zone with its
 * offset, which is the form the schema requires and the form the verification
 * portal reads back from the QR code.
 */
export function issueDateTime(at: Date, timeZone = 'Europe/Tirane'): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const offset = (parts.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/* ── the invoice ─────────────────────────────────────────────────────── */

export type FiscalPayType = 'BANKNOTE' | 'CARD' | 'ACCOUNT';

export interface FiscalItem {
  name: string;
  code?: string | null;
  unit: string;
  quantity: number;
  /** Minor units, before VAT and before discount. */
  unitPrice: number;
  /** Minor units taken off this line. */
  discountAmount: number;
  taxRateBp: number;
  /** Minor units of VAT on this line. */
  taxAmount: number;
  /** Minor units, after discount and VAT — what the patient pays for the line. */
  total: number;
}

export interface FiscalInvoiceInput {
  nipt: string;
  seller: { name: string; address: string; town: string };
  businessUnitCode: string;
  tcrCode: string;
  operatorCode: string;
  softwareCode: string;
  invOrdNum: number;
  year: number;
  issueDateTime: string;
  typeOfInv: 'CASH' | 'NONCASH';
  isIssuerInVat: boolean;
  vatExemptionCode: string;
  payMethods: { type: FiscalPayType; amount: number }[];
  items: FiscalItem[];
  /** Minor units. Must equal the sum of the lines. */
  totalPrice: number;
}

export function invNum(
  i: Pick<FiscalInvoiceInput, 'invOrdNum' | 'year' | 'tcrCode'>,
): string {
  return `${i.invOrdNum}/${i.year}/${i.tcrCode}`;
}

/**
 * Totals the lines and refuses an invoice whose total does not reconcile. CIS
 * checks the same arithmetic, and a rejection there is harder to explain than
 * a refusal here.
 */
export function fiscalTotals(i: FiscalInvoiceInput) {
  let priceWoVat = 0;
  let vat = 0;
  let price = 0;
  for (const item of i.items) {
    if (item.total - item.taxAmount < 0)
      throw new FiscalValidationError(`"${item.name}" costs less than its VAT`);
    priceWoVat += item.total - item.taxAmount;
    vat += item.taxAmount;
    price += item.total;
  }
  if (price !== i.totalPrice) {
    throw new FiscalValidationError(
      `The invoice total (${money(i.totalPrice)}) does not equal the sum of its lines (${money(price)}).`,
    );
  }
  const paid = i.payMethods.reduce((s, p) => s + p.amount, 0);
  if (paid !== i.totalPrice) {
    throw new FiscalValidationError(
      `The payment methods add up to ${money(paid)}, not the invoice total of ${money(i.totalPrice)}.`,
    );
  }
  return { priceWoVat, vat, price };
}

export class FiscalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiscalValidationError';
  }
}

/** NIPT|IssueDateTime|InvOrdNum|BusinUnitCode|TCRCode|SoftCode|TotPrice */
export function iicInput(i: FiscalInvoiceInput): string {
  return [
    i.nipt,
    i.issueDateTime,
    String(i.invOrdNum),
    i.businessUnitCode,
    i.tcrCode,
    i.softwareCode,
    money(i.totalPrice),
  ].join('|');
}

/**
 * The NSLF. The signature is RSA-SHA256 over the IIC input, written as upper
 * case hex; the code itself is the MD5 of the signature bytes, also upper hex.
 */
export async function computeIic(
  key: webcrypto.CryptoKey,
  i: FiscalInvoiceInput,
): Promise<{ iic: string; iicSignature: string }> {
  const signature = await signRsaSha256(key, iicInput(i));
  return {
    iicSignature: signature.toString('hex').toUpperCase(),
    iic: createHash('md5').update(signature).digest('hex').toUpperCase(),
  };
}

/** The address the QR code opens: the authority's own check of this invoice. */
export function verificationUrl(
  base: string,
  i: FiscalInvoiceInput,
  iic: string,
): string {
  const q = new URLSearchParams({
    iic,
    tin: i.nipt,
    crtd: i.issueDateTime,
    ord: String(i.invOrdNum),
    bu: i.businessUnitCode,
    cr: i.tcrCode,
    sw: i.softwareCode,
    prc: money(i.totalPrice),
  });
  return `${base}?${q.toString()}`;
}

function itemNode(item: FiscalItem, i: FiscalInvoiceInput): XmlNode {
  const gross = item.unitPrice * item.quantity;
  const before = item.total - item.taxAmount;
  const rebatePercent = gross > 0 ? Math.round((item.discountAmount * 10000) / gross) : 0;
  const unitAfter = Math.round((item.unitPrice * (10000 + item.taxRateBp)) / 10000);
  const inVat = i.isIssuerInVat;
  return {
    name: 'I',
    attrs: {
      N: item.name.slice(0, 50),
      C: item.code ?? undefined,
      U: item.unit,
      Q: money(item.quantity * 100),
      UPB: money(item.unitPrice),
      UPA: money(inVat ? unitAfter : item.unitPrice),
      R: money(rebatePercent),
      RR: 'true',
      PB: money(before),
      VR: inVat && item.taxRateBp > 0 ? rate(item.taxRateBp) : undefined,
      VA: inVat && item.taxRateBp > 0 ? money(item.taxAmount) : undefined,
      EX: inVat && item.taxRateBp === 0 ? i.vatExemptionCode : undefined,
      PA: money(item.total),
    },
  };
}

function sameTaxes(i: FiscalInvoiceInput): XmlNode | null {
  if (!i.isIssuerInVat) return null;
  const groups = new Map<number, { count: number; before: number; vat: number }>();
  for (const item of i.items) {
    const g = groups.get(item.taxRateBp) ?? { count: 0, before: 0, vat: 0 };
    g.count += 1;
    g.before += item.total - item.taxAmount;
    g.vat += item.taxAmount;
    groups.set(item.taxRateBp, g);
  }
  return {
    name: 'SameTaxes',
    children: [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bp, g]) => ({
        name: 'SameTax',
        attrs: {
          NumOfItems: String(g.count),
          PriceBefVAT: money(g.before),
          VATRate: bp > 0 ? rate(bp) : undefined,
          VATAmt: bp > 0 ? money(g.vat) : undefined,
          ExemptFromVAT: bp === 0 ? i.vatExemptionCode : undefined,
        },
      })),
  };
}

export interface RequestHeader {
  uuid: string;
  sendDateTime: string;
  /** Set when delivering an invoice issued while CIS could not be reached. */
  subsequentDelivery?: 'NOINTERNET' | 'BOUNDBOOK' | 'SERVICE' | 'TECHNICALERROR';
}

export function newHeader(
  timeZone: string,
  subsequent?: RequestHeader['subsequentDelivery'],
): RequestHeader {
  return {
    uuid: randomUUID(),
    sendDateTime: issueDateTime(new Date(), timeZone),
    subsequentDelivery: subsequent,
  };
}

/** The unsigned RegisterInvoiceRequest, canonical. */
export function registerInvoiceXml(
  i: FiscalInvoiceInput,
  header: RequestHeader,
  codes: { iic: string; iicSignature: string },
): string {
  const totals = fiscalTotals(i);
  const invoice: XmlNode = {
    name: 'Invoice',
    attrs: {
      BusinUnitCode: i.businessUnitCode,
      IIC: codes.iic,
      IICSignature: codes.iicSignature,
      InvNum: invNum(i),
      InvOrdNum: String(i.invOrdNum),
      IsIssuerInVAT: String(i.isIssuerInVat),
      IsReverseCharge: 'false',
      IsSimplifiedInv: 'false',
      IssueDateTime: i.issueDateTime,
      OperatorCode: i.operatorCode,
      SoftCode: i.softwareCode,
      TCRCode: i.tcrCode,
      TotPrice: money(totals.price),
      TotPriceWoVAT: money(totals.priceWoVat),
      TotVATAmt: i.isIssuerInVat ? money(totals.vat) : undefined,
      TypeOfInv: i.typeOfInv,
    },
    children: [
      {
        name: 'PayMethods',
        children: i.payMethods.map((p) => ({
          name: 'PayMethod',
          attrs: { Amt: money(p.amount), Type: p.type },
        })),
      },
      {
        name: 'Seller',
        attrs: {
          Address: i.seller.address,
          Country: 'ALB',
          IDNum: i.nipt,
          IDType: 'NUIS',
          Name: i.seller.name,
          Town: i.seller.town,
        },
      },
      { name: 'Items', children: i.items.map((item) => itemNode(item, i)) },
      ...(sameTaxes(i) ? [sameTaxes(i)!] : []),
    ],
  };
  return renderXml({
    name: 'RegisterInvoiceRequest',
    attrs: { xmlns: FISCAL_NS, Id: 'Request', Version: '3' },
    children: [headerNode(header), invoice],
  });
}

export interface CashDepositInput {
  nipt: string;
  tcrCode: string;
  operation: 'INITIAL' | 'WITHDRAW';
  amount: number;
  changeDateTime: string;
}

export function registerCashDepositXml(
  c: CashDepositInput,
  header: RequestHeader,
): string {
  return renderXml({
    name: 'RegisterCashDepositRequest',
    attrs: { xmlns: FISCAL_NS, Id: 'Request', Version: '3' },
    children: [
      headerNode(header),
      {
        name: 'CashDeposit',
        attrs: {
          CashAmt: money(c.amount),
          ChangeDateTime: c.changeDateTime,
          IssuerNUIS: c.nipt,
          Operation: c.operation,
          TCRCode: c.tcrCode,
        },
      },
    ],
  });
}

function headerNode(h: RequestHeader): XmlNode {
  return {
    name: 'Header',
    attrs: {
      SendDateTime: h.sendDateTime,
      SubseqDelivType: h.subsequentDelivery,
      UUID: h.uuid,
    },
  };
}

/* ── the signature ───────────────────────────────────────────────────── */

/**
 * Sign a request produced above with an enveloped XML-DSig signature.
 *
 * The reference digest is SHA-256 over the request as written (canonical, and
 * without the signature, which is what the enveloped-signature transform
 * removes). The signature value is RSA-SHA256 over SignedInfo canonicalized as
 * its own apex, which is why the digested form carries the dsig namespace
 * declaration and the embedded form inherits it from <Signature>.
 */
export async function signRequest(
  unsignedXml: string,
  key: webcrypto.CryptoKey,
  certificateDer: Buffer,
): Promise<string> {
  const rootName = /^<([A-Za-z]+)[\s>]/.exec(unsignedXml)?.[1];
  if (!rootName) throw new Error('not a request produced by this module');
  const digest = createHash('sha256').update(unsignedXml, 'utf8').digest('base64');

  const signedInfo = (withNs: boolean): XmlNode => ({
    name: 'SignedInfo',
    attrs: withNs ? { xmlns: DSIG_NS } : {},
    children: [
      { name: 'CanonicalizationMethod', attrs: { Algorithm: EXC_C14N } },
      {
        name: 'SignatureMethod',
        attrs: { Algorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' },
      },
      {
        name: 'Reference',
        attrs: { URI: '#Request' },
        children: [
          {
            name: 'Transforms',
            children: [
              {
                name: 'Transform',
                attrs: {
                  Algorithm: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
                },
              },
              { name: 'Transform', attrs: { Algorithm: EXC_C14N } },
            ],
          },
          {
            name: 'DigestMethod',
            attrs: { Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' },
          },
          { name: 'DigestValue', children: [digest] },
        ],
      },
    ],
  });

  const signatureValue = (await signRsaSha256(key, renderXml(signedInfo(true)))).toString(
    'base64',
  );
  const signature = renderXml({
    name: 'Signature',
    attrs: { xmlns: DSIG_NS },
    children: [
      signedInfo(false),
      { name: 'SignatureValue', children: [signatureValue] },
      {
        name: 'KeyInfo',
        children: [
          {
            name: 'X509Data',
            children: [
              { name: 'X509Certificate', children: [certificateDer.toString('base64')] },
            ],
          },
        ],
      },
    ],
  });
  const close = `</${rootName}>`;
  return `${unsignedXml.slice(0, -close.length)}${signature}${close}`;
}

export function soapEnvelope(signedXml: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<SOAP-ENV:Header/><SOAP-ENV:Body>${signedXml}</SOAP-ENV:Body></SOAP-ENV:Envelope>`
  );
}

/* ── the answer ──────────────────────────────────────────────────────── */

export type CisAnswer =
  | { ok: true; code: string }
  | { ok: false; faultCode: string | null; faultString: string };

function tag(xml: string, name: string): string | null {
  const m = new RegExp(
    `<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9]+:)?${name}>`,
  ).exec(xml);
  return m ? decode(m[1]!.trim()) : null;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Read CIS's reply: the code it issued (FIC for an invoice, FCDC for a cash
 * deposit), or its fault. Anything else is reported as a fault with no code,
 * which the caller treats as "not acknowledged".
 */
export function parseCisResponse(xml: string, codeElement: 'FIC' | 'FCDC'): CisAnswer {
  const fault = tag(xml, 'faultstring');
  if (fault !== null)
    return { ok: false, faultCode: tag(xml, 'code'), faultString: fault };
  const code = tag(xml, codeElement);
  if (code) return { ok: true, code };
  return {
    ok: false,
    faultCode: null,
    faultString: 'The tax authority returned an answer this system does not recognise',
  };
}
