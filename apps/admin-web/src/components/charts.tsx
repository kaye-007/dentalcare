import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';

/**
 * Two chart forms, both hand-drawn SVG, which is all the console needs:
 * columns over months (one series, or two on one axis) and shares of a whole.
 *
 * The rules they follow, so a new chart does not have to rediscover them:
 *  - One y-axis, always. Two measures of different scale are two charts.
 *  - One series is ink. Two are blue and ember, in that fixed order — the
 *    validated pair from styles.css — and they get a legend.
 *  - Thin columns with rounded tops, sitting on the baseline; 2px between
 *    the columns of one group. A number on the latest column only.
 *  - Hover or focus a month for every value in it; the table view gives the
 *    same numbers to anyone who cannot or would rather not hover.
 */

export interface Series {
  name: string;
  color: string;
}

export interface Column {
  key: string;
  /** Axis label: "Sep". */
  label: string;
  /** Tooltip and table label: "September 2026". */
  title: string;
  values: number[];
}

const PAD = { top: 18, right: 8, bottom: 26, left: 48 };

function niceMax(v: number): number {
  if (v <= 0) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

/** A column with rounded top corners and a square foot on the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function ColumnChart({
  columns,
  series,
  format,
  formatAxis = format,
  height = 220,
  integer = false,
  ariaLabel,
}: {
  columns: Column[];
  series: Series[];
  format: (n: number) => string;
  formatAxis?: (n: number) => string;
  height?: number;
  /** Counts: gridlines on whole numbers only. */
  integer?: boolean;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const tipId = useId();

  // Drawn at the width it is shown at, so one unit is one pixel and the axis
  // text stays 11.5px in a narrow card instead of shrinking with the viewBox.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry!.contentRect.width);
      if (w > 0) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = useMemo(() => {
    const peak = Math.max(0, ...columns.flatMap((c) => c.values));
    const m = niceMax(peak);
    return integer ? Math.max(4, Math.ceil(m / 4) * 4) : m;
  }, [columns, integer]);

  const H = height;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, columns.length);
  const groupW = Math.min(band * 0.62, series.length === 1 ? 34 : 52);
  const gap = series.length > 1 ? 2 : 0;
  const barW = (groupW - gap * (series.length - 1)) / series.length;
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const allZero = columns.every((c) => c.values.every((v) => v === 0));
  const lastIndex = columns.length - 1;

  const active = hover === null ? null : columns[hover];
  const tipLeft = hover === null ? 0 : ((PAD.left + band * hover + band / 2) / W) * 100;
  const tipTop = active === null ? 0 : (y(Math.max(...active.values)) / H) * 100;

  return (
    <div className="viz" ref={box}>
      <div className="viz__head">
        {series.length > 1 ? (
          <div className="viz__legend">
            {series.map((s) => (
              <span key={s.name} className="viz__legenditem">
                <span className="viz__swatch" style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </div>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="iconbtn iconbtn--quiet"
          onClick={() => setTable((t) => !t)}
          aria-pressed={table}
          title={table ? 'Show chart' : 'Show as table'}
          aria-label={table ? 'Show chart' : 'Show as table'}
        >
          {table ? <BarChart3 size={16} /> : <Table2 size={16} />}
        </button>
      </div>

      {table ? (
        <div className="viz__table">
          <table className="table">
            <thead>
              <tr>
                <th>Month</th>
                {series.map((s) => (
                  <th key={s.name} className="num">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => (
                <tr key={c.key}>
                  <td>{c.title}</td>
                  {c.values.map((v, i) => (
                    <td key={series[i]!.name} className="num">
                      {format(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <svg
            className={`viz__svg${hover !== null ? ' viz--dim' : ''}`}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={ariaLabel}
            onMouseLeave={() => setHover(null)}
          >
            {grid.map((g) => (
              <g key={g}>
                <line
                  className={g === 0 ? 'viz__baseline' : 'viz__grid'}
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={y(max * g)}
                  y2={y(max * g)}
                />
                {(g > 0 || !allZero) && (
                  <text
                    className="viz__tick"
                    x={PAD.left - 10}
                    y={y(max * g) + 4}
                    textAnchor="end"
                  >
                    {formatAxis(max * g)}
                  </text>
                )}
              </g>
            ))}

            {columns.map((c, i) => {
              const x0 = PAD.left + band * i + (band - groupW) / 2;
              return (
                <g key={c.key}>
                  {hover === i && (
                    <rect
                      className="viz__hover"
                      x={PAD.left + band * i + 2}
                      y={PAD.top}
                      width={band - 4}
                      height={plotH}
                      rx={8}
                    />
                  )}
                  {c.values.map((v, si) => {
                    const x = x0 + si * (barW + gap);
                    return (
                      <path
                        key={si}
                        className={`viz__bar${hover === i ? ' viz__bar--on' : ''}`}
                        d={columnPath(x, y(v), barW, PAD.top + plotH - y(v))}
                        fill={series[si]!.color}
                      />
                    );
                  })}
                  <text
                    className="viz__tick"
                    x={PAD.left + band * i + band / 2}
                    y={H - 6}
                    textAnchor="middle"
                    style={
                      i === lastIndex
                        ? { fill: 'var(--ink)', fontWeight: 600 }
                        : undefined
                    }
                  >
                    {c.label}
                  </text>
                  {/* The one direct label: the month that is still running. */}
                  {i === lastIndex &&
                    hover === null &&
                    series.length === 1 &&
                    c.values[0]! > 0 && (
                      <text
                        className="viz__label"
                        x={x0 + groupW / 2}
                        y={y(c.values[0]!) - 7}
                        textAnchor="middle"
                      >
                        {format(c.values[0]!)}
                      </text>
                    )}
                  <rect
                    className="viz__hit"
                    x={PAD.left + band * i}
                    y={PAD.top}
                    width={band}
                    height={plotH + PAD.bottom}
                    tabIndex={0}
                    aria-describedby={hover === i ? tipId : undefined}
                    aria-label={`${c.title}: ${c.values.map((v, si) => `${series[si]!.name} ${format(v)}`).join(', ')}`}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>

          {active && (
            <div
              id={tipId}
              className="viz__tip"
              role="tooltip"
              style={{
                left: `${Math.min(88, Math.max(12, tipLeft))}%`,
                top: `${tipTop}%`,
              }}
            >
              <div className="viz__tip-title">{active.title}</div>
              {active.values.map((v, si) => (
                <div key={si} className="viz__tip-row">
                  <span
                    className="viz__tip-key"
                    style={{ background: series[si]!.color }}
                  />
                  <b>{format(v)}</b>
                  <span>{series[si]!.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Parts of one whole, largest first, each with its value written out. */
export function ShareBars({
  rows,
  empty,
}: {
  rows: {
    key: string;
    label: string;
    value: number;
    display: ReactNode;
    note?: ReactNode;
  }[];
  empty: ReactNode;
}) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (rows.length === 0 || total === 0) return <div className="viz__empty">{empty}</div>;
  return (
    <div className="hbars">
      {rows.map((r) => {
        const pct = (r.value / total) * 100;
        return (
          <div className="hbar__row" key={r.key}>
            <div className="hbar__meta">
              <span className="hbar__label">{r.label}</span>
              <span className="hbar__value">
                {r.display}
                {r.note && <small>{r.note}</small>}
              </span>
            </div>
            <span
              className="hbar__track"
              role="img"
              aria-label={`${r.label}: ${Math.round(pct)}% of the total`}
            >
              <span className="hbar__fill" style={{ width: `${Math.max(pct, 1.5)}%` }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
