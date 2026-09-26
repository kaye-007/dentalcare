import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Printer } from 'lucide-react';
import {
  CURRENCIES,
  formatMoney,
  formatRate,
  toothLabel,
  type CurrencyCode,
} from '@dentalcare/shared';
import { ApiError, estimatesApi, type Estimate } from '../lib/api';

/**
 * A treatment plan as a printed estimate ("preventiv"), for the patient to
 * take away — in the clinic's currency and, for a patient from abroad, in a
 * second one alongside.
 *
 * Every figure is the API's: the lines are priced by the same engine that
 * will invoice the accepted plan, and the conversion is done there, with the
 * rate, its date and its source printed at the foot. The labels are Albanian
 * with English beneath, because the reader may be either.
 */

function date(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export default function EstimatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [currency, setCurrency] = useState<CurrencyCode | 'none' | undefined>(undefined);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setError(null);
    estimatesApi
      .forPlan(id, currency)
      .then(setEstimate)
      .catch((e) =>
        setError(
          e instanceof ApiError ? e.message : 'The estimate could not be prepared.',
        ),
      );
  }, [id, currency]);

  useEffect(() => {
    const previous = document.title;
    if (estimate) document.title = `Preventiv · ${estimate.patient.name}`;
    return () => {
      document.title = previous;
    };
  }, [estimate]);

  const own = (minor: number) => (estimate ? formatMoney(minor, estimate.currency) : '');
  const other = (minor: number | null) =>
    estimate?.quote && minor !== null
      ? formatMoney(minor, estimate.quote.currency)
      : null;
  const q = estimate?.quote ?? null;

  return (
    <div className="printpage">
      <div className="printbar" role="toolbar" aria-label="Estimate actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => navigate(-1)}
        >
          <ChevronLeft size={15} aria-hidden /> Back
        </button>
        <div className="printbar__right">
          {estimate && (
            <label className="field">
              <span>Also show in</span>
              <select
                value={q ? q.currency : 'none'}
                onChange={(e) => setCurrency(e.target.value as CurrencyCode | 'none')}
              >
                <option value="none">No second currency</option>
                {CURRENCIES.filter((c) => c !== estimate.currency).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => window.print()}
            disabled={!estimate}
          >
            <Printer size={15} aria-hidden /> Print estimate
          </button>
        </div>
      </div>

      {error && <p className="formerror printpage__error">{error}</p>}
      {!estimate && !error && (
        <p className="muted printpage__error">Preparing the estimate…</p>
      )}

      {estimate && (
        <article className="estimate" aria-label="Treatment estimate">
          <header
            className="estimate__head"
            style={
              estimate.clinic.brandColor
                ? { borderColor: estimate.clinic.brandColor }
                : undefined
            }
          >
            <div>
              {estimate.clinic.logoUrl ? (
                <img
                  src={estimate.clinic.logoUrl}
                  alt={estimate.clinic.name}
                  style={{ maxHeight: 56, maxWidth: 180 }}
                />
              ) : (
                <h1>{estimate.clinic.name}</h1>
              )}
              {estimate.clinic.legalName &&
                estimate.clinic.legalName !== estimate.clinic.name && (
                  <p>{estimate.clinic.legalName}</p>
                )}
              {estimate.clinic.nipt && <p>NIPT {estimate.clinic.nipt}</p>}
              {(estimate.clinic.address || estimate.clinic.city) && (
                <p>
                  {[estimate.clinic.address, estimate.clinic.city]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}
              {estimate.clinic.phone && <p>Tel. {estimate.clinic.phone}</p>}
              {estimate.clinic.email && <p>{estimate.clinic.email}</p>}
            </div>
            <div className="estimate__right">
              <h1>PREVENTIV</h1>
              <p>Treatment estimate</p>
              <p>
                Data / Date: <strong>{date(estimate.issuedOn)}</strong>
              </p>
              <p>
                E vlefshme deri / Valid until:{' '}
                <strong>{date(estimate.validUntil)}</strong>
              </p>
            </div>
          </header>

          <section
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              gap: 16,
              marginTop: 16,
            }}
          >
            <div>
              <p
                className="muted"
                style={{ margin: 0, fontSize: 11, letterSpacing: '0.05em' }}
              >
                PACIENTI / PATIENT
              </p>
              <strong>{estimate.patient.name}</strong>
              {estimate.patient.dateOfBirth && (
                <p style={{ margin: 0 }}>{date(estimate.patient.dateOfBirth)}</p>
              )}
            </div>
            <div className="estimate__right">
              <p
                className="muted"
                style={{ margin: 0, fontSize: 11, letterSpacing: '0.05em' }}
              >
                PLANI / PLAN
              </p>
              <strong>{estimate.plan.title}</strong>
              {estimate.plan.dentistName && (
                <p style={{ margin: 0 }}>{estimate.plan.dentistName}</p>
              )}
            </div>
          </section>

          <div className="estimate__table-wrap">
            <table className="estimate__table">
              <thead>
                <tr>
                  <th>Procedura / Procedure</th>
                  <th className="num">Sasia / Qty</th>
                  <th className="num">Çmimi / Price</th>
                  <th className="num">TVSH / VAT</th>
                  <th className="num">Vlera / Amount</th>
                </tr>
              </thead>
              <tbody>
                {estimate.items.map((item, i) => (
                  <tr key={i}>
                    <td>
                      {item.description}
                      {item.tooth ? (
                        <span className="estimate__alt">{toothLabel(item.tooth)}</span>
                      ) : null}
                      {item.discountAmount > 0 && (
                        <span className="estimate__alt">
                          Zbritje / Discount −{own(item.discountAmount)}
                        </span>
                      )}
                    </td>
                    <td className="num">{item.quantity}</td>
                    <td className="num">{own(item.unitPrice)}</td>
                    <td className="num">
                      {item.taxRateBp > 0 ? formatRate(item.taxRateBp) : 'Përjashtuar'}
                    </td>
                    <td className="num">
                      {own(item.total)}
                      {other(item.totalQuote) && (
                        <span className="estimate__alt">≈ {other(item.totalQuote)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {estimate.totals.discount > 0 && (
                  <tr>
                    <td colSpan={4}>Zbritje / Discount</td>
                    <td className="num">−{own(estimate.totals.discount)}</td>
                  </tr>
                )}
                {estimate.totals.tax > 0 && (
                  <>
                    <tr>
                      <td colSpan={4}>Vlera pa TVSH / Before VAT</td>
                      <td className="num">
                        {own(estimate.totals.net)}
                        {other(estimate.totals.netQuote) && (
                          <span className="estimate__alt">
                            ≈ {other(estimate.totals.netQuote)}
                          </span>
                        )}
                      </td>
                    </tr>
                    {estimate.vat
                      .filter((g) => !g.exempt)
                      .map((g) => (
                        <tr key={g.taxRateBp}>
                          <td colSpan={4}>
                            TVSH {formatRate(g.taxRateBp)} mbi / on {own(g.net)}
                          </td>
                          <td className="num">{own(g.taxAmount)}</td>
                        </tr>
                      ))}
                  </>
                )}
                <tr className="estimate__grand">
                  <td colSpan={4}>Totali / Total ({estimate.currency})</td>
                  <td className="num">
                    {own(estimate.totals.total)}
                    {other(estimate.totals.totalQuote) && (
                      <span className="estimate__alt">
                        ≈ {other(estimate.totals.totalQuote)}
                      </span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {q && (
            <p className="estimate__note">
              Shumat në {q.currency} janë orientuese, me kursin 1 {q.currency} ={' '}
              {q.rate.toLocaleString('en-GB', { maximumFractionDigits: 4 })}{' '}
              {estimate.currency} (
              {q.source === 'fixed' ? 'kursi i klinikës' : `publikuar më ${date(q.asOf)}`}
              ). Pagesa kryhet në {estimate.currency}.
              <br />
              Amounts in {q.currency} are indicative, at 1 {q.currency} ={' '}
              {q.rate.toLocaleString('en-GB', { maximumFractionDigits: 4 })}{' '}
              {estimate.currency} (
              {q.source === 'fixed' ? "the clinic's rate" : `published ${date(q.asOf)}`}
              {q.stale ? ', the latest available' : ''}). Payment is taken in{' '}
              {estimate.currency}.
              {q.source === 'live' && q.provider === 'ExchangeRate-API' && (
                <>
                  {' '}
                  Rates by{' '}
                  <a
                    href="https://www.exchangerate-api.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    ExchangeRate-API
                  </a>
                  .
                </>
              )}
            </p>
          )}

          <p className="estimate__note">
            Ky preventiv bazohet në ekzaminimin aktual dhe mund të ndryshojë nëse gjatë
            trajtimit nevojiten procedura të tjera. Trajtimet mjekësore janë të
            përjashtuara nga TVSH-ja; procedurat estetike përfshijnë TVSH-në.
            <br />
            This estimate is based on the current examination and may change if further
            procedures prove necessary. Medical treatment is exempt from VAT; cosmetic
            procedures include it.
          </p>

          <div className="estimate__sign">
            <span>Mjeku / Dentist</span>
            <span>Pacienti / Patient</span>
          </div>
        </article>
      )}
    </div>
  );
}
