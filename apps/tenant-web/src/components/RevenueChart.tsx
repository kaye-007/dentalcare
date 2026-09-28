import { useMemo, useRef, useState } from 'react';
import { MINOR_UNITS } from '@dentalcare/shared';
import { formatMoney } from '../lib/format';
import { dateLocale } from '../lib/strings';

/**
 * Billed vs collected over time.
 *
 * TWO SERIES, ONE AXIS. Both are money in the same currency, so they share a
 * scale — a second y-axis would let the two lines cross wherever the scales
 * happened to put them and invite a comparison that means nothing.
 *
 * The two series are deliberately separate rather than one "revenue" line:
 * billed is what was invoiced, collected is what arrived. A clinic reading
 * only the first celebrates money it does not have; reading only the second
 * never notices it is invoicing far more than it collects. The gap between
 * the lines IS the reading.
 *
 * Colours are categorical slots 1 and 2 in fixed order — never reassigned when
 * a series is toggled, so a line keeps its identity across filter changes.
 */

export interface RevenuePoint {
  period: string;
  billed: number;
  collected: number;
}

const SERIES = [
  // Two measures on one axis, so the pair was checked for colour-vision
  // separation rather than picked: indigo vs ochre clears deutan/protan and
  // normal-vision thresholds. Collected wears the brand hue because it is
  // the measure the clinic actually cares about.
  { key: 'billed' as const, label: 'Billed', color: 'var(--data-2)' },
  { key: 'collected' as const, label: 'Collected', color: 'var(--data-1)' },
];

const W = 760;
const H = 260;
const PAD = { top: 16, right: 20, bottom: 30, left: 64 };

function niceCeiling(v: number): number {
  if (v <= 0) return 100;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}

/**
 * An axis label: "3.5M", "400k". The series are minor units, and the axis
 * read them as they came — a month of 3.6 million lek was labelled "400M".
 * The label is in whole units of the currency, like every amount on screen.
 */
function shortMoney(minor: number): string {
  const v = minor / MINOR_UNITS;
  if (Math.abs(v) >= 1_000_000) return `${Math.round(v / 100_000) / 10}M`;
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 100) / 10}k`;
  return String(Math.round(v));
}

export default function RevenueChart({
  data,
  granularity,
}: {
  data: RevenuePoint[];
  granularity: 'day' | 'month';
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const { points, max } = useMemo(() => {
    const peak = data.reduce((m, d) => Math.max(m, d.billed, d.collected), 0);
    return { points: data, max: niceCeiling(peak) };
  }, [data]);

  if (data.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 13 }}>
        No activity in this period.
      </p>
    );
  }

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const path = (key: 'billed' | 'collected') =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p[key])}`).join(' ');

  const label = (period: string) => {
    const d = new Date(`${period}T00:00:00Z`);
    return granularity === 'day'
      ? d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
      : d.toLocaleDateString(dateLocale(), { month: 'short', year: '2-digit' });
  };

  // Show at most ~8 tick labels so they never collide.
  const tickEvery = Math.max(1, Math.ceil(points.length / 8));
  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / plotW) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  const active = hover === null ? null : points[hover]!;

  return (
    <div className="viz">
      <div className="viz__head">
        {/* Legend is always present for two series — identity is never colour alone. */}
        <div className="viz__legend">
          {SERIES.map((s) => (
            <span key={s.key} className="viz__legenditem">
              <span className="viz__swatch" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setShowTable((v) => !v)}
          aria-expanded={showTable}
        >
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {showTable ? (
        <div className="periogrid__wrap" style={{ maxHeight: 300 }}>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>Period</th>
                <th className="num">Billed</th>
                <th className="num">Collected</th>
                <th className="num">Gap</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.period}>
                  <td>{label(p.period)}</td>
                  <td className="num">{formatMoney(p.billed)}</td>
                  <td className="num">{formatMoney(p.collected)}</td>
                  <td className="num">{formatMoney(p.billed - p.collected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="viz__plot">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="viz__svg"
            role="img"
            aria-label={`Billed and collected revenue by ${granularity}`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* Recessive grid — present enough to read a value, quiet enough to ignore. */}
            {gridLines.map((f) => (
              <g key={f}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={PAD.top + plotH * (1 - f)}
                  y2={PAD.top + plotH * (1 - f)}
                  className="viz__grid"
                />
                <text
                  x={PAD.left - 8}
                  y={PAD.top + plotH * (1 - f) + 4}
                  className="viz__axislabel"
                  textAnchor="end"
                >
                  {shortMoney(Math.round(max * f))}
                </text>
              </g>
            ))}

            {points.map((p, i) =>
              i % tickEvery === 0 ? (
                <text
                  key={p.period}
                  x={x(i)}
                  y={H - 10}
                  className="viz__axislabel"
                  textAnchor="middle"
                >
                  {label(p.period)}
                </text>
              ) : null,
            )}

            {hover !== null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                className="viz__crosshair"
              />
            )}

            {SERIES.map((s) => (
              <path
                key={s.key}
                d={path(s.key)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {/* Markers only on the hovered period — never a dot on every point. */}
            {hover !== null &&
              SERIES.map((s) => (
                <circle
                  key={s.key}
                  cx={x(hover)}
                  cy={y(points[hover]![s.key])}
                  r={4.5}
                  fill={s.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              ))}
          </svg>

          {active && (
            <div
              className="viz__tooltip"
              style={{ left: `${(x(hover!) / W) * 100}%` }}
              role="status"
            >
              <strong>{label(active.period)}</strong>
              {SERIES.map((s) => (
                <span key={s.key}>
                  <span className="viz__swatch" style={{ background: s.color }} />
                  {s.label}: {formatMoney(active[s.key])}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
