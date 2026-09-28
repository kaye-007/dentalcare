import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  settingsApi,
  type ClinicPaymentMethod,
  type ClinicSettings,
  type PaymentMethod,
} from '../../lib/api';
import { SaveButton, useSave } from '../../pages/SettingsPage';
import {
  ALBANIA_STANDARD_VAT_BP,
  CURRENCIES,
  type CurrencyCode,
} from '@dentalcare/shared';
import { forgetClinicVatRate } from '../../lib/vat';

const KIND_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank: 'Bank transfer',
};
const BUILT_IN = new Set(['cash', 'card', 'bank']);

function slug(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036F]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'method';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * Default tax, terms, numbering and the ways the clinic is paid.
 *
 * VAT is stored in basis points and entered as a percentage; the default
 * applies to taxable treatments on new invoices only. The invoice prefix
 * also applies to new invoices only — a number already printed never changes.
 */
export default function FinanceCard({
  settings,
  onSaved,
}: {
  settings: ClinicSettings;
  onSaved: (s: ClinicSettings) => void;
}) {
  const [vat, setVat] = useState(String(settings.vatRateBp / 100));
  const [terms, setTerms] = useState(String(settings.paymentTermsDays));
  const [prefix, setPrefix] = useState(settings.invoicePrefix);
  const [methods, setMethods] = useState<ClinicPaymentMethod[]>(settings.paymentMethods);
  const [newLabel, setNewLabel] = useState('');
  const [newKind, setNewKind] = useState<PaymentMethod>('card');
  const [quoteCurrency, setQuoteCurrency] = useState<CurrencyCode | ''>(
    settings.quoteCurrency ?? '',
  );
  const [fxSource, setFxSource] = useState<'live' | 'fixed'>(settings.fxRateSource);
  const [fxRate, setFxRate] = useState(
    settings.fxFixedRate ? String(settings.fxFixedRate) : '',
  );
  const [checkoutMode, setCheckoutMode] = useState(settings.defaultCheckoutMode);
  const [internalReceipts, setInternalReceipts] = useState(
    settings.internalReceiptsEnabled,
  );
  const save = useSave();
  const touch = () => save.setSaved(false);

  const vatBp = Math.round(Number(vat.replace(',', '.')) * 100);
  const vatValid = Number.isFinite(vatBp) && vatBp >= 0 && vatBp <= 10000;
  const prefixValid = /^[A-Za-z0-9/_.-]{0,12}$/.test(prefix);
  const fxRateNumber = Number(fxRate.replace(',', '.'));
  const fxRateValid =
    fxSource === 'live' || (Number.isFinite(fxRateNumber) && fxRateNumber > 0);

  function addMethod() {
    const label = newLabel.trim();
    if (!label) return;
    touch();
    setMethods((m) => [
      ...m,
      {
        id: slug(label, new Set(m.map((x) => x.id))),
        label,
        kind: newKind,
        active: true,
      },
    ]);
    setNewLabel('');
  }

  const update = (id: string, patch: Partial<ClinicPaymentMethod>) => {
    touch();
    setMethods((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!vatValid) {
      save.setError('VAT must be a percentage between 0 and 100.');
      return;
    }
    if (quoteCurrency && !fxRateValid) {
      save.setError('Enter the fixed exchange rate, or use the published rate.');
      return;
    }
    const out = await save.run(() =>
      settingsApi.update({
        quoteCurrency: quoteCurrency || null,
        fxRateSource: quoteCurrency ? fxSource : 'live',
        fxFixedRate: quoteCurrency && fxSource === 'fixed' ? fxRateNumber : null,
        vatRateBp: vatBp,
        paymentTermsDays: Math.max(0, Math.min(365, Number(terms) || 0)),
        invoicePrefix: prefix,
        paymentMethods: methods,
        defaultCheckoutMode: checkoutMode,
        internalReceiptsEnabled: internalReceipts,
      }),
    );
    if (out) {
      forgetClinicVatRate();
      onSaved(out);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Billing &amp; tax</h2>
          <p className="card__sub">Applied to invoices issued from now on.</p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <fieldset className="fieldset">
          <legend>What a payment issues</legend>
          <div className="grid2">
            <label className="field">
              <span>Preselected on the payment screen</span>
              <select
                value={checkoutMode}
                onChange={(e) => {
                  touch();
                  setCheckoutMode(e.target.value as 'internal' | 'fiscal' | 'ask');
                }}
              >
                <option value="fiscal">Faturë e fiskalizuar — the fiscal invoice</option>
                <option value="internal" disabled={!internalReceipts}>
                  Faturë fiktive — the internal receipt
                </option>
                <option value="ask">Nothing — reception chooses every time</option>
              </select>
            </label>
          </div>
          <label className="checkrow">
            <input
              type="checkbox"
              checked={internalReceipts}
              onChange={(e) => {
                touch();
                setInternalReceipts(e.target.checked);
                if (!e.target.checked && checkoutMode === 'internal')
                  setCheckoutMode('fiscal');
              }}
            />
            <span>
              <strong>Allow internal receipts.</strong> Off means every payment is
              registered with the tax authority. A cash or card taking is expected to be
              fiscalized when the money is taken, so leaving this on is a decision to
              check with your accountant.
            </span>
          </label>
        </fieldset>
        <div className="grid2">
          <label className="field">
            <span>TVSH rate on cosmetic treatments (%)</span>
            <input
              inputMode="decimal"
              value={vat}
              onChange={(e) => {
                touch();
                setVat(e.target.value);
              }}
              aria-invalid={!vatValid}
            />
            <span className="field-hint">
              Medical treatment is exempt (0%). This rate applies to treatments marked
              Cosmetic in the catalogue. The Albanian standard rate is{' '}
              {ALBANIA_STANDARD_VAT_BP / 100}%; a clinic not registered for VAT enters 0.{' '}
              {vatBp !== ALBANIA_STANDARD_VAT_BP && (
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => {
                    touch();
                    setVat(String(ALBANIA_STANDARD_VAT_BP / 100));
                  }}
                >
                  Use {ALBANIA_STANDARD_VAT_BP / 100}%
                </button>
              )}
            </span>
          </label>
          <label className="field">
            <span>Payment terms (days)</span>
            <input
              type="number"
              min={0}
              max={365}
              value={terms}
              onChange={(e) => {
                touch();
                setTerms(e.target.value);
              }}
            />
            <span className="field-hint">0 means payable on the day of issue.</span>
          </label>
        </div>

        <div className="grid2">
          <label className="field">
            <span>Second currency on estimates</span>
            <select
              value={quoteCurrency}
              onChange={(e) => {
                touch();
                setQuoteCurrency(e.target.value as CurrencyCode | '');
              }}
            >
              <option value="">None</option>
              {CURRENCIES.filter((c) => c !== settings.currency).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="field-hint">
              For patients from abroad: printed estimates show {settings.currency} and
              this currency side by side. Invoices and payments stay in{' '}
              {settings.currency}.
            </span>
          </label>
          {quoteCurrency && (
            <label className="field">
              <span>Exchange rate</span>
              <select
                value={fxSource}
                onChange={(e) => {
                  touch();
                  setFxSource(e.target.value as 'live' | 'fixed');
                }}
              >
                <option value="live">Published rate, updated daily</option>
                <option value="fixed">The clinic's own fixed rate</option>
              </select>
              {fxSource === 'fixed' && (
                <input
                  inputMode="decimal"
                  value={fxRate}
                  placeholder={`${settings.currency} per 1 ${quoteCurrency}, e.g. 100`}
                  aria-label={`${settings.currency} per 1 ${quoteCurrency}`}
                  aria-invalid={!fxRateValid}
                  onChange={(e) => {
                    touch();
                    setFxRate(e.target.value);
                  }}
                  style={{ marginTop: 6 }}
                />
              )}
              <span className="field-hint">
                {fxSource === 'fixed'
                  ? `How many ${settings.currency} one ${quoteCurrency} is worth on your estimates.`
                  : 'The rate and its date are printed on each estimate.'}
              </span>
            </label>
          )}
        </div>

        <label className="field" style={{ maxWidth: 320 }}>
          <span>Invoice number prefix</span>
          <input
            value={prefix}
            maxLength={12}
            onChange={(e) => {
              touch();
              setPrefix(e.target.value);
            }}
            aria-invalid={!prefixValid}
          />
          <span className="field-hint">
            Next invoices read like <strong>{prefix}0042</strong>. Letters, digits and / _
            . - only.
          </span>
        </label>

        <div className="field">
          <span>Payment methods</span>
          <table className="mini-table">
            <thead>
              <tr>
                <th>Name on receipts</th>
                <th>Counts as</th>
                <th style={{ width: 70 }}>In use</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {methods.map((m) => (
                <tr key={m.id}>
                  <td>
                    <input
                      value={m.label}
                      maxLength={60}
                      onChange={(e) => update(m.id, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={m.kind}
                      disabled={BUILT_IN.has(m.id)}
                      onChange={(e) =>
                        update(m.id, { kind: e.target.value as PaymentMethod })
                      }
                    >
                      {(Object.keys(KIND_LABEL) as PaymentMethod[]).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={m.active}
                      onChange={(e) => update(m.id, { active: e.target.checked })}
                    />
                  </td>
                  <td>
                    {!BUILT_IN.has(m.id) && (
                      <button
                        type="button"
                        className="iconbtn iconbtn--quiet"
                        aria-label={`Remove ${m.label}`}
                        onClick={() => {
                          touch();
                          setMethods((list) => list.filter((x) => x.id !== m.id));
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="inline-row" style={{ marginTop: 8 }}>
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. POS Credins, PayPal"
              maxLength={60}
              style={{ flex: 1, minWidth: 180 }}
            />
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as PaymentMethod)}
            >
              {(Object.keys(KIND_LABEL) as PaymentMethod[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={addMethod}
              disabled={!newLabel.trim()}
            >
              <Plus size={14} aria-hidden /> Add
            </button>
          </div>
          <span className="field-hint">
            "Counts as" is what reports and the tax authority see: a card terminal is a
            card payment, a transfer is a bank payment. A method in use on past payments
            is hidden, not deleted, when switched off.
          </span>
        </div>

        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}
