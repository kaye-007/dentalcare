import { Minus, Plus } from 'lucide-react';
import {
  DRAWER_DENOMINATIONS,
  countTotal,
  formatMoney,
  type CurrencyCode,
} from '@dentalcare/shared';
import type { DenominationCounts } from '../../lib/api';

/**
 * Count a drawer note by note, one currency at a time.
 *
 * Large steppers for a phone held in one hand, and a typed quantity for a
 * receptionist counting a thick stack. The running total is the shared
 * `countTotal`, which is what the API records — so the figure on screen is
 * the figure that is saved.
 *
 * It never shows what the drawer should hold. In a blind count that number
 * comes back only after the count is submitted.
 */
export default function CountGrid({
  currency,
  value,
  onChange,
}: {
  currency: CurrencyCode;
  value: DenominationCounts;
  onChange: (next: DenominationCounts) => void;
}) {
  const denominations = DRAWER_DENOMINATIONS[currency];
  const total = countTotal(currency, value) ?? 0;

  const set = (d: number, qty: number) => {
    const next = { ...value };
    if (qty <= 0) delete next[String(d)];
    else next[String(d)] = Math.min(qty, 99_999);
    onChange(next);
  };

  return (
    <div className="countgrid" role="group" aria-label={`Count of ${currency} in the drawer`}>
      {denominations.map((d) => {
        const qty = value[String(d)] ?? 0;
        const label = formatMoney(d, currency);
        return (
          <div className="countgrid__row" key={d}>
            <span className="countgrid__label">{label}</span>
            <div className="stepper">
              <button
                type="button"
                className="stepper__btn"
                aria-label={`One fewer ${label}`}
                onClick={() => set(d, qty - 1)}
                disabled={qty === 0}
              >
                <Minus size={16} aria-hidden />
              </button>
              <input
                className="stepper__input"
                inputMode="numeric"
                pattern="[0-9]*"
                aria-label={`How many ${label}`}
                value={qty === 0 ? '' : String(qty)}
                placeholder="0"
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/\D/g, ''));
                  set(d, Number.isFinite(n) ? n : 0);
                }}
              />
              <button
                type="button"
                className="stepper__btn"
                aria-label={`One more ${label}`}
                onClick={() => set(d, qty + 1)}
              >
                <Plus size={16} aria-hidden />
              </button>
            </div>
            <span className="countgrid__sub">{qty ? formatMoney(d * qty, currency) : '—'}</span>
          </div>
        );
      })}
      <div className="countgrid__total" aria-live="polite">
        <span>Counted</span>
        <strong>{formatMoney(total, currency)}</strong>
      </div>
    </div>
  );
}
