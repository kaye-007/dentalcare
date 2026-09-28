import { formatMoney } from '../lib/format';

/**
 * Horizontal bars for a ranked breakdown — production by dentist, by room, by
 * procedure, and the A/R ageing buckets.
 *
 * Horizontal rather than vertical because the labels are names, not dates:
 * rotated vertical labels are the most common way a breakdown chart becomes
 * unreadable. Every row is directly labelled with its value, so the bar
 * conveys proportion and the number conveys the amount — neither has to be
 * estimated from the other.
 *
 * A single measure means a SINGLE hue, not a rainbow: the bars are one series,
 * and giving each row its own colour would imply a categorical distinction
 * that does not exist.
 */

export interface BarRow {
  label: string;
  value: number;
  /** Optional secondary figure shown after the value, e.g. "12 procedures". */
  meta?: string;
  /** Overrides the single hue — used only by the ageing buckets. */
  color?: string;
}

export default function BarBreakdown({
  rows,
  emptyText = 'Nothing recorded in this period.',
  format = formatMoney,
  max: maxOverride,
}: {
  rows: BarRow[];
  emptyText?: string;
  format?: (v: number) => string;
  max?: number;
}) {
  if (rows.length === 0) {
    return <p className="muted bars__empty">{emptyText}</p>;
  }

  // Scale to the largest bar, never to the sum: these are magnitudes to
  // compare with each other, not parts of a whole.
  const max = maxOverride ?? Math.max(...rows.map((r) => Math.abs(r.value)), 1);

  return (
    <ul className="bars">
      {rows.map((r) => {
        const pct = max > 0 ? Math.max(0, (Math.abs(r.value) / max) * 100) : 0;
        return (
          <li key={r.label} className="bars__row">
            <span className="bars__label" title={r.label}>{r.label}</span>
            <span className="bars__track">
              <span
                className="bars__fill"
                style={{
                  width: `${pct}%`,
                  ...(r.color ? { background: r.color } : {}),
                }}
              />
            </span>
            <span className="bars__value">
              {format(r.value)}
              {r.meta && <span className="cell-sub"> · {r.meta}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
