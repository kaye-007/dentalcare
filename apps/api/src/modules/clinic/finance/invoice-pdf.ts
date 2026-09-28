import {
  formatMoney,
  formatRate,
  vatSummary,
  type CurrencyCode,
} from '@dentalcare/shared';
import {
  A4,
  PdfDocument,
  PdfPage,
  textWidth,
  wrapText,
  type Rgb,
} from '@/core/pdf/pdf-writer';

/**
 * The printable invoice, as data in and bytes out.
 *
 * Two variants from one layout. A fiscal invoice carries the authority's
 * block — QR code, NIVF, NSLF, the register and operator codes — and nothing
 * can print it without them. A standard invoice is the clinic's own record;
 * when the clinic fiscalizes, it says in print that it is not a fiscal
 * invoice, so an internal copy cannot pass for a receipt.
 *
 * Labels are Albanian with English beneath: the document is issued in
 * Albania and read by patients who may be either.
 */

export interface InvoicePdfData {
  clinic: {
    name: string;
    legalName: string | null;
    address: string | null;
    city: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    taxNumber: string | null;
    registrationNumber: string | null;
    brandColor: string | null;
    /** JPEG bytes, or null for no logo. */
    logo: Uint8Array | null;
    fiscalizationEnabled: boolean;
  };
  invoice: {
    number: string;
    status: 'unpaid' | 'partially_paid' | 'paid' | 'cancelled';
    issuedAt: string;
    dueOn: string | null;
    currency: CurrencyCode;
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    paid: number;
    notes: string | null;
  };
  patient: {
    name: string;
    address: string | null;
    city: string | null;
    phone: string | null;
  };
  items: {
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    taxRateBp: number;
    amount: number;
  }[];
  payments: { paidAt: string; method: string; amount: number }[];
  fiscal: {
    status: 'pending' | 'fiscalized' | 'rejected';
    environment: 'test' | 'production';
    nivf: string | null;
    nslf: string;
    invNum: string;
    issueDateTime: string;
    businessUnitCode: string;
    tcrCode: string;
    operatorCode: string;
    /** Who operated the register, printed beside the operator code. */
    cashierName?: string | null;
    softwareCode: string;
    typeOfInvoice: 'CASH' | 'NONCASH';
    qr: readonly (readonly boolean[])[];
  } | null;
}

const MARGIN = 48;
const INK: Rgb = [0.07, 0.1, 0.17];
const MUTED: Rgb = [0.34, 0.38, 0.45];
const RULE: Rgb = [0.87, 0.89, 0.92];
const TINT: Rgb = [0.96, 0.97, 0.98];
const WARN: Rgb = [0.53, 0.35, 0.05];

function hexColor(hex: string | null): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!m) return [0.29, 0.34, 0.89];
  return [
    parseInt(m[1]!, 16) / 255,
    parseInt(m[2]!, 16) / 255,
    parseInt(m[3]!, 16) / 255,
  ];
}

function date(iso: string): string {
  const d = iso.slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : iso;
}

const STATUS: Record<InvoicePdfData['invoice']['status'], string> = {
  unpaid: 'E PAPAGUAR / UNPAID',
  partially_paid: 'PAGUAR PJESËRISHT / PARTIALLY PAID',
  paid: 'E PAGUAR / PAID',
  cancelled: 'ANULUAR / CANCELLED',
};

export function renderInvoicePdf(d: InvoicePdfData): Uint8Array {
  const doc = new PdfDocument(`Invoice ${d.invoice.number}`);
  const accent = hexColor(d.clinic.brandColor);
  const money = (minor: number) => formatMoney(minor, d.invoice.currency);
  const right = A4.width - MARGIN;
  const logo = d.clinic.logo ? doc.addJpeg(d.clinic.logo) : null;

  let page = doc.addPage();
  let y = 0;

  const header = (p: PdfPage) => {
    p.rect(0, 0, A4.width, 6, accent);
    let top = 40;
    if (logo) {
      const scale = Math.min(150 / logo.width, 56 / logo.height, 1);
      p.image(logo, MARGIN, top, logo.width * scale, logo.height * scale);
    } else {
      p.text(MARGIN, top + 20, d.clinic.name, { size: 16, bold: true, color: accent });
    }
    const title = d.fiscal ? 'FATURË TATIMORE' : 'FATURË';
    p.text(right, top + 14, title, { size: 18, bold: true, align: 'right' });
    p.text(right, top + 28, d.fiscal ? 'Fiscal invoice' : 'Invoice', {
      size: 9,
      color: MUTED,
      align: 'right',
    });
    p.text(right, top + 44, d.invoice.number, { size: 11, bold: true, align: 'right' });
    top += 72;
    return top;
  };

  const newPage = () => {
    page = doc.addPage();
    y = header(page) + 8;
    tableHead();
  };

  y = header(page);

  // ── seller and patient ──
  const sellerLines = [
    d.clinic.legalName && d.clinic.legalName !== d.clinic.name
      ? d.clinic.legalName
      : null,
    d.clinic.address,
    d.clinic.city,
    d.clinic.phone ? `Tel. ${d.clinic.phone}` : null,
    d.clinic.email,
    d.clinic.website,
    d.clinic.taxNumber ? `NIPT ${d.clinic.taxNumber}` : null,
    d.clinic.registrationNumber ? `Nr. regjistrimi ${d.clinic.registrationNumber}` : null,
  ].filter((l): l is string => Boolean(l));

  page.text(MARGIN, y, 'SHITËSI / FROM', { size: 7.5, bold: true, color: MUTED });
  page.text(MARGIN, y + 14, d.clinic.name, { size: 10.5, bold: true });
  sellerLines.forEach((l, i) =>
    page.text(MARGIN, y + 27 + i * 12, l, { size: 9, color: MUTED }),
  );

  const col2 = 320;
  page.text(col2, y, 'KLIENTI / BILL TO', { size: 7.5, bold: true, color: MUTED });
  page.text(col2, y + 14, d.patient.name, { size: 10.5, bold: true });
  [d.patient.address, d.patient.city, d.patient.phone]
    .filter(Boolean)
    .forEach((l, i) => page.text(col2, y + 27 + i * 12, l!, { size: 9, color: MUTED }));

  const metaTop = y + 27 + 3 * 12 + 8;
  const meta: [string, string][] = [
    ['Data e lëshimit / Issued', date(d.invoice.issuedAt)],
    ...(d.invoice.dueOn
      ? [['Afati / Due', date(d.invoice.dueOn)] as [string, string]]
      : []),
    ['Statusi / Status', STATUS[d.invoice.status]],
  ];
  meta.forEach(([k, v], i) => {
    page.text(col2, metaTop + i * 13, k, { size: 8.5, color: MUTED });
    page.text(right, metaTop + i * 13, v, { size: 8.5, bold: true, align: 'right' });
  });

  y = Math.max(y + 27 + sellerLines.length * 12, metaTop + meta.length * 13) + 22;

  // ── lines ──
  const cols = { qty: 330, unit: 395, discount: 450, vat: 492, amount: right };
  const descWidth = cols.qty - MARGIN - 30;

  function tableHead() {
    page.rect(MARGIN, y, right - MARGIN, 20, TINT);
    const hy = y + 13;
    page.text(MARGIN + 6, hy, 'Përshkrimi / Description', {
      size: 8,
      bold: true,
      color: MUTED,
    });
    page.text(cols.qty, hy, 'Sasia', {
      size: 8,
      bold: true,
      color: MUTED,
      align: 'right',
    });
    page.text(cols.unit, hy, 'Çmimi', {
      size: 8,
      bold: true,
      color: MUTED,
      align: 'right',
    });
    page.text(cols.discount, hy, 'Zbritje', {
      size: 8,
      bold: true,
      color: MUTED,
      align: 'right',
    });
    page.text(cols.vat, hy, 'TVSH', {
      size: 8,
      bold: true,
      color: MUTED,
      align: 'right',
    });
    page.text(cols.amount - 6, hy, 'Vlera', {
      size: 8,
      bold: true,
      color: MUTED,
      align: 'right',
    });
    y += 20;
  }

  tableHead();
  const bottomLimit = A4.height - (d.fiscal ? 230 : 150);
  for (const item of d.items) {
    const lines = wrapText(item.description, 9.5, descWidth);
    const rowHeight = Math.max(22, 10 + lines.length * 12);
    if (y + rowHeight > bottomLimit) newPage();
    lines.forEach((l, i) => page.text(MARGIN + 6, y + 14 + i * 12, l, { size: 9.5 }));
    const ry = y + 14;
    page.text(cols.qty, ry, String(item.quantity), { size: 9.5, align: 'right' });
    page.text(cols.unit, ry, money(item.unitPrice), { size: 9.5, align: 'right' });
    page.text(cols.discount, ry, item.discount ? money(item.discount) : '—', {
      size: 9.5,
      align: 'right',
      color: MUTED,
    });
    page.text(cols.vat, ry, item.taxRateBp ? `${item.taxRateBp / 100}%` : '—', {
      size: 9.5,
      align: 'right',
      color: MUTED,
    });
    page.text(cols.amount - 6, ry, money(item.amount), {
      size: 9.5,
      bold: true,
      align: 'right',
    });
    y += rowHeight;
    page.line(MARGIN, y, right, y, 0.5, RULE);
  }

  // ── totals ──
  // TVSH one row per rate, so a bill with exempt and cosmetic work shows
  // what was charged on what, as the fiscal receipt does.
  const vatGroups = vatSummary(
    d.items.map((i) => {
      const net = i.quantity * i.unitPrice - i.discount;
      return { taxRateBp: i.taxRateBp, net, taxAmount: Math.max(0, i.amount - net) };
    }),
  ).filter((g) => !g.exempt && g.taxAmount > 0);
  if (y + 110 + vatGroups.length * 14 > bottomLimit) newPage();
  y += 14;
  const totals: [string, string, boolean][] = [
    ['Nëntotali / Subtotal', money(d.invoice.subtotal), false],
    ...(d.invoice.discount
      ? [
          ['Zbritje / Discount', `−${money(d.invoice.discount)}`, false] as [
            string,
            string,
            boolean,
          ],
        ]
      : []),
    ...(d.invoice.tax
      ? vatGroups.length > 0
        ? vatGroups.map(
            (g) =>
              [
                `TVSH ${formatRate(g.taxRateBp)} / VAT (${money(g.net)})`,
                money(g.taxAmount),
                false,
              ] as [string, string, boolean],
          )
        : [['TVSH / VAT', money(d.invoice.tax), false] as [string, string, boolean]]
      : []),
    ['Totali / Total', money(d.invoice.total), true],
    ['Paguar / Paid', money(d.invoice.paid), false],
    ['Detyrimi / Balance', money(d.invoice.total - d.invoice.paid), true],
  ];
  const labelX = 360;
  for (const [label, value, strong] of totals) {
    page.text(labelX, y, label, {
      size: strong ? 10 : 9,
      bold: strong,
      color: strong ? INK : MUTED,
    });
    page.text(right - 6, y, value, {
      size: strong ? 10.5 : 9.5,
      bold: strong,
      align: 'right',
    });
    y += strong ? 17 : 14;
  }

  if (d.payments.length) {
    let py = y - totals.length * 15 + 6;
    page.text(MARGIN, py - 10, 'PAGESAT / PAYMENTS', {
      size: 7.5,
      bold: true,
      color: MUTED,
    });
    for (const p of d.payments.slice(0, 6)) {
      page.text(MARGIN, py + 4, `${date(p.paidAt)}  ·  ${p.method}`, {
        size: 9,
        color: MUTED,
      });
      page.text(290, py + 4, money(p.amount), { size: 9, align: 'right' });
      py += 13;
    }
  }

  if (d.invoice.notes) {
    y += 8;
    wrapText(d.invoice.notes, 8.5, right - MARGIN)
      .slice(0, 4)
      .forEach((l) => {
        page.text(MARGIN, y, l, { size: 8.5, color: MUTED });
        y += 11;
      });
  }

  // ── fiscal block, or the notice that this is not one ──
  if (d.fiscal) {
    const f = d.fiscal;
    const top = A4.height - 200;
    page.line(MARGIN, top - 12, right, top - 12, 0.75, RULE);
    const qrSize = 118;
    page.qr(f.qr, right - qrSize, top, qrSize);
    const rows: [string, string][] = [
      ['NIVF', f.nivf ?? 'Në pritje / pending'],
      ['NSLF', f.nslf],
      ['Nr. i faturës', f.invNum],
      ['Data dhe ora', f.issueDateTime.replace('T', ' ')],
      ['Njësia e biznesit', f.businessUnitCode],
      ['Arka (TCR)', f.tcrCode],
      [
        'Operatori',
        f.cashierName ? `${f.operatorCode} (${f.cashierName})` : f.operatorCode,
      ],
      ['Kodi i softuerit', f.softwareCode],
      [
        'Mënyra e pagesës',
        f.typeOfInvoice === 'CASH'
          ? 'Me para në dorë / Cash'
          : 'Pa para në dorë / Non-cash',
      ],
    ];
    rows.forEach(([k, v], i) => {
      page.text(MARGIN, top + 10 + i * 13, k, { size: 8, color: MUTED });
      page.text(MARGIN + 105, top + 10 + i * 13, v, {
        size: 8,
        bold: k === 'NIVF' || k === 'NSLF',
      });
    });
    if (f.environment === 'test') {
      page.text(
        MARGIN,
        top + 10 + rows.length * 13 + 6,
        'MJEDIS TESTIMI — nuk është faturë tatimore e vlefshme / TEST ENVIRONMENT — not a valid fiscal invoice',
        {
          size: 8,
          bold: true,
          color: WARN,
        },
      );
    } else if (f.status !== 'fiscalized') {
      page.text(
        MARGIN,
        top + 10 + rows.length * 13 + 6,
        'NIVF në pritje: fatura po dërgohet te administrata tatimore / NIVF pending: being delivered to the tax authority',
        {
          size: 8,
          bold: true,
          color: WARN,
        },
      );
    }
  } else if (d.clinic.fiscalizationEnabled) {
    page.text(
      MARGIN,
      A4.height - 96,
      'Dokument i brendshëm — NUK është faturë tatimore / Internal document — NOT a fiscal invoice',
      {
        size: 8.5,
        bold: true,
        color: WARN,
      },
    );
  }

  // ── page numbers, now that the count is known ──
  const pages = doc.pageList;
  pages.forEach((p, i) => {
    p.line(MARGIN, A4.height - 44, right, A4.height - 44, 0.5, RULE);
    p.text(MARGIN, A4.height - 30, `${d.clinic.name} · ${d.invoice.number}`, {
      size: 7.5,
      color: MUTED,
    });
    p.text(right, A4.height - 30, `Faqe ${i + 1} / ${pages.length}`, {
      size: 7.5,
      color: MUTED,
      align: 'right',
    });
  });

  return doc.toBytes();
}

/** Width helper re-exported for the spec's layout assertions. */
export { textWidth };
