import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, FileDown, Printer } from 'lucide-react';
import { formatRate } from '@dentalcare/shared';
import { ApiError, financeApi, fiscalApi, type FiscalReceipt } from '../lib/api';
import QrCode from '../components/QrCode';

/**
 * The fiscal receipt ("kupon tatimor"), sized for an 80 mm receipt printer
 * and readable on A4.
 *
 * Every figure comes from the registration the tax authority received, not
 * from the invoice screen. The labels are Albanian because this is a document
 * issued under Albanian law and handed to the patient; the app around it stays
 * in English.
 *
 * What the receipt must carry, and where it is here:
 *
 *   seller name, NIPT, address      header
 *   fiscal invoice number, date     "Nr. i faturës", "Data dhe ora"
 *   operator (cashier)              "Arkëtari", name and operator code
 *   items with TVSH rate            one block per line
 *   TVSH summary per rate           "Përmbledhja e TVSH-së"
 *   totals, payment method          "Totali", "Mënyra e pagesës"
 *   NIVF, NSLF, BU/TCR/software     footer codes
 *   QR code to the verification     footer
 */

const amount = new Intl.NumberFormat('sq-AL', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const lek = (minor: number) => `${amount.format(minor / 100)}`;

/** "2026-09-17T10:30:00+02:00" -> "17.09.2026 10:30:00", as registered, with no zone conversion. */
function fiscalDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}` : iso;
}

const PAY_LABEL: Record<string, string> = {
  BANKNOTE: 'Para në dorë',
  CARD: 'Kartë',
  ACCOUNT: 'Transfertë bankare',
};

export default function FiscalReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [receipt, setReceipt] = useState<FiscalReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    fiscalApi
      .receipt(id)
      .then(setReceipt)
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : 'The receipt could not be loaded.'),
      );
  }, [id]);

  useEffect(() => {
    const previous = document.title;
    if (receipt) document.title = `Kupon ${receipt.fiscal.invNum}`;
    return () => {
      document.title = previous;
    };
  }, [receipt]);

  async function pdf() {
    if (!id) return;
    setPdfBusy(true);
    try {
      const blob = await financeApi.invoicePdf(id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="printpage">
      <div className="printbar" role="toolbar" aria-label="Receipt actions">
        <Link to={`/invoices/${id}`} className="btn btn--ghost btn--sm">
          <ChevronLeft size={15} aria-hidden /> Back to invoice
        </Link>
        <div className="printbar__right">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={pdf}
            disabled={pdfBusy}
          >
            <FileDown size={15} aria-hidden /> {pdfBusy ? 'Preparing…' : 'A4 PDF'}
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => window.print()}
            disabled={!receipt}
          >
            <Printer size={15} aria-hidden /> Print receipt
          </button>
        </div>
      </div>

      {error && <p className="formerror printpage__error">{error}</p>}
      {!receipt && !error && (
        <p className="muted printpage__error">Loading the receipt…</p>
      )}

      {receipt && (
        <article
          className="receipt"
          aria-label={`Fiscal receipt ${receipt.fiscal.invNum}`}
        >
          {receipt.environment === 'test' && (
            <p className="receipt__banner">
              MJEDIS TESTIMI — NUK ËSHTË FATURË E VLEFSHME
            </p>
          )}
          <header className="receipt__head">
            <strong className="receipt__seller">{receipt.seller.name}</strong>
            <span>NIPT: {receipt.seller.nipt}</span>
            <span>
              {receipt.seller.address}, {receipt.seller.town}
            </span>
            {receipt.seller.phone && <span>Tel: {receipt.seller.phone}</span>}
          </header>

          <h1 className="receipt__title">FATURË TATIMORE</h1>

          <dl className="receipt__meta">
            <dt>Nr. i faturës</dt>
            <dd>{receipt.fiscal.invNum}</dd>
            <dt>Nr. i brendshëm</dt>
            <dd>{receipt.invoiceNumber}</dd>
            <dt>Data dhe ora</dt>
            <dd>{fiscalDate(receipt.fiscal.issueDateTime)}</dd>
            <dt>Arkëtari</dt>
            <dd>
              {receipt.cashier.name ?? '—'}
              <br />
              <span className="receipt__code">{receipt.cashier.operatorCode}</span>
            </dd>
            <dt>Klienti</dt>
            <dd>{receipt.buyerName}</dd>
          </dl>

          <table className="receipt__items">
            <thead>
              <tr>
                <th scope="col">Artikulli</th>
                <th scope="col">Vlera</th>
              </tr>
            </thead>
            <tbody>
              {receipt.items.map((item, i) => (
                <tr key={i}>
                  <td>
                    <span className="receipt__item">{item.name}</span>
                    <span className="receipt__sub">
                      {item.quantity} {item.unit} × {lek(item.unitPrice)}
                      {item.discountAmount > 0 ? ` − ${lek(item.discountAmount)}` : ''}
                      {' · '}
                      {!receipt.isIssuerInVat
                        ? 'pa TVSH'
                        : item.taxRateBp > 0
                          ? `TVSH ${formatRate(item.taxRateBp)}`
                          : `Përjashtuar (${receipt.vatExemptionCode})`}
                    </span>
                  </td>
                  <td className="receipt__num">{lek(item.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {receipt.isIssuerInVat && (
            <section className="receipt__vat" aria-label="Përmbledhja e TVSH-së">
              <p className="receipt__label">Përmbledhja e TVSH-së</p>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Norma</th>
                    <th scope="col">Baza</th>
                    <th scope="col">TVSH</th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.vat.map((g) => (
                    <tr key={g.taxRateBp}>
                      <td>{g.exempt ? 'Përjashtuar' : formatRate(g.taxRateBp)}</td>
                      <td className="receipt__num">{lek(g.net)}</td>
                      <td className="receipt__num">
                        {g.exempt ? '—' : lek(g.taxAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <dl className="receipt__totals">
            <dt>Vlera pa TVSH</dt>
            <dd>{lek(receipt.totals.net)}</dd>
            {receipt.isIssuerInVat && (
              <>
                <dt>TVSH</dt>
                <dd>{lek(receipt.totals.vat)}</dd>
              </>
            )}
            <dt className="receipt__grand">TOTALI (ALL)</dt>
            <dd className="receipt__grand">{lek(receipt.totals.total)}</dd>
          </dl>

          <dl className="receipt__meta">
            {receipt.payments.map((p, i) => (
              <div key={i} className="receipt__pair">
                <dt>{i === 0 ? 'Mënyra e pagesës' : ''}</dt>
                <dd>
                  {PAY_LABEL[p.type] ?? p.type} · {lek(p.amount)}
                </dd>
              </div>
            ))}
          </dl>

          <footer className="receipt__codes">
            <dl>
              <dt>NIVF</dt>
              <dd>{receipt.fiscal.nivf ?? 'Në pritje të konfirmimit'}</dd>
              <dt>NSLF</dt>
              <dd>{receipt.fiscal.nslf}</dd>
              <dt>Njësia e biznesit</dt>
              <dd>{receipt.fiscal.businessUnitCode}</dd>
              <dt>Arka (TCR)</dt>
              <dd>{receipt.fiscal.tcrCode}</dd>
              <dt>Kodi i softuerit</dt>
              <dd>{receipt.fiscal.softwareCode}</dd>
            </dl>
            <div className="receipt__qr">
              <QrCode
                text={receipt.fiscal.qrUrl}
                label="Kodi QR për verifikimin e faturës"
              />
            </div>
            <p className="receipt__small">
              Skanoni kodin QR për të verifikuar faturën në portalin e tatimeve.
            </p>
            {receipt.fiscal.status !== 'fiscalized' && receipt.environment !== 'test' && (
              <p className="receipt__small">
                Fatura është lëshuar dhe po dërgohet te administrata tatimore (NIVF në
                pritje).
              </p>
            )}
          </footer>
        </article>
      )}
    </div>
  );
}
