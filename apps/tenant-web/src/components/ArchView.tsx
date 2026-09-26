import { useId, useMemo, type KeyboardEvent } from 'react';
// Anatomy — the same module the API validates against.
import {
  archesFor,
  formatTooth,
  toothType,
  type Dentition,
  type Notation,
  type ToothType,
} from '@dentalcare/shared';
// Drawing — this app's alone.
import {
  ENCODING_PALETTE,
  FAMILY_KEYS,
  anatomicalName,
  conditionStyle,
} from '../lib/tooth-notation';
import type { ToothSummary } from '../lib/api';
import { t } from '../lib/strings';

/**
 * The arch view: the mouth seen from above, each tooth a shaded crown.
 *
 * This is the overview a clinician reads first — which teeth carry something,
 * where they sit, which one is selected. It deliberately carries less than
 * the Surfaces chart: a tooth is tinted by its most consequential finding
 * rather than painted surface by surface, and every condition is listed in
 * the tooth's accessible name and in the record beside it. Surface-level
 * charting stays one tap away in the Surfaces view.
 *
 * The depth is real geometry, not decoration. Crown widths follow average
 * mesiodistal widths, so a molar is wider than an incisor by the amount it
 * actually is; teeth are spaced by arc length so they touch the way they do
 * in a mouth; and every crown is lit from the same top-left point in screen
 * space, which is what makes forty separate shapes read as one solid arch.
 */

type Tint = keyof typeof ENCODING_PALETTE;

/** Which finding colours a tooth when it has several: disease first. */
const TINT_RANK: Record<Tint, number> = { crimson: 5, amber: 4, emerald: 3, blue: 2, grey: 1 };

/** Light → dark gradient stops for each family colour, lit from the top left. */
const TINT_STOPS: Record<Tint, readonly [string, string, string]> = {
  crimson: ['#fff1f1', '#f5c3c3', '#df9494'],
  amber: ['#fff8e8', '#f6dfa6', '#e5bb62'],
  blue: ['#eef5fc', '#c4dbf0', '#91b8e0'],
  emerald: ['#ecf8f1', '#bde5ce', '#82cba4'],
  grey: ['#f7f8f9', '#e0e3e7', '#c4c9d0'],
};
const ENAMEL_STOPS = ['#ffffff', '#f2f3f7', '#d6dae3'] as const;
const SELECTED_STOPS = ['#aab1f8', '#6a74ee', '#4450e0'] as const;

const TINT_BY_COLOUR = new Map<string, Tint>(
  (Object.entries(ENCODING_PALETTE) as [Tint, string][]).map(([k, v]) => [v, k]),
);

/* ── crown sizes ───────────────────────────────────────────────────────────
   Average mesiodistal crown widths in millimetres, by position in the
   quadrant (index 1 = central incisor). Only the proportions matter; the
   arch scales them to fit. */
const PERMANENT_UPPER = [0, 8.6, 6.6, 7.6, 7.0, 6.6, 10.2, 9.2, 8.6];
const PERMANENT_LOWER = [0, 5.4, 5.9, 6.9, 7.0, 7.1, 11.0, 10.4, 9.9];
const PRIMARY_UPPER = [0, 6.5, 5.2, 7.0, 7.3, 8.8];
const PRIMARY_LOWER = [0, 4.2, 4.6, 5.8, 7.8, 9.8];

/** Buccolingual depth — how far the crown reaches from cheek to tongue. */
const DEPTH: Record<ToothType, number> = {
  incisor: 6.4,
  canine: 7.8,
  premolar: 8.8,
  molar: 10.6,
};

function crownWidth(tooth: number, upper: boolean): number {
  const quad = Math.floor(tooth / 10);
  const pos = tooth % 10;
  const table =
    quad >= 5
      ? upper
        ? PRIMARY_UPPER
        : PRIMARY_LOWER
      : upper
        ? PERMANENT_UPPER
        : PERMANENT_LOWER;
  return table[pos] ?? 7;
}

/* ── arch geometry ─────────────────────────────────────────────────────────
   Each arch is half an ellipse. The upper opens downward with the incisors at
   the top of the picture, the lower opens upward with its incisors at the
   bottom, and the molar ends of the two sit GAP apart across the middle —
   the occlusal plane. As on the Surfaces chart, the patient's right is on the
   viewer's left. */
const RX = 100;
const RY = 112;
const GAP = 20;
const SAMPLES = 720;

/**
 * Real crown widths differ by a factor of two — a lower central incisor is
 * half a lower first molar. Drawn to scale, the front teeth shrank to beads
 * nobody could click. The power curve keeps the order and most of the
 * difference while holding every tooth at a size a finger can hit.
 */
const soften = (mm: number) => Math.pow(mm, 0.7);
/** Crowns drawn a little deeper than wide read as teeth rather than pebbles. */
const DEPTH_BOOST = 1.18;

interface Seat {
  tooth: number;
  x: number;
  y: number;
  /** Radians. Local +y points out of the mouth (buccal / labial). */
  rot: number;
  w: number;
  d: number;
  nx: number;
  ny: number;
}

function seatArch(teeth: readonly number[], upper: boolean, depthBoost: number): Seat[] {
  const cy = upper ? -GAP / 2 : GAP / 2;
  const sign = upper ? -1 : 1;
  const point = (th: number) => ({ x: RX * Math.cos(th), y: cy + sign * RY * Math.sin(th) });

  // Arc length along the half ellipse, from the viewer's left (θ = π) to right.
  const table: { th: number; len: number }[] = [];
  let len = 0;
  let prev = point(Math.PI);
  for (let i = 0; i <= SAMPLES; i++) {
    const th = Math.PI * (1 - i / SAMPLES);
    const p = point(th);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
    table.push({ th, len });
  }

  const widths = teeth.map((tooth) => soften(crownWidth(tooth, upper)));
  const spacing = 0.25;
  const raw = widths.reduce((s, w) => s + w, 0) + spacing * (teeth.length - 1);
  const usable = len * 0.97;
  const k = usable / raw;
  let cursor = (len - usable) / 2;

  return teeth.map((tooth, i) => {
    const w = widths[i]! * k;
    const centre = cursor + w / 2;
    cursor += w + spacing * k;

    let lo = 0;
    let hi = table.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (table[mid]!.len < centre) lo = mid + 1;
      else hi = mid;
    }
    const p = point(table[lo]!.th);

    // Outward normal of the ellipse at p.
    let nx = p.x / (RX * RX);
    let ny = (p.y - cy) / (RY * RY);
    const n = Math.hypot(nx, ny) || 1;
    nx /= n;
    ny /= n;

    return {
      tooth,
      x: p.x,
      y: p.y,
      // Rotating local (0, 1) by rot lands on (nx, ny).
      rot: Math.atan2(-nx, ny),
      w,
      d: soften(DEPTH[toothType(tooth)]) * k * depthBoost,
      nx,
      ny,
    };
  });
}

/**
 * The crown outline and its grooves, already rotated into place.
 *
 * Coordinates are transformed here rather than with an SVG `transform`, so
 * every crown's bounding box stays screen-aligned — which is what keeps the
 * gradient's light source in the same corner for every tooth on the arch.
 */
function crownPaths(seat: Seat): { crown: string; grooves: string } {
  const type = toothType(seat.tooth);
  const cos = Math.cos(seat.rot);
  const sin = Math.sin(seat.rot);
  const P = (lx: number, ly: number) =>
    `${(seat.x + lx * cos - ly * sin).toFixed(2)} ${(seat.y + lx * sin + ly * cos).toFixed(2)}`;

  const a = seat.w / 2;
  const b = seat.d / 2;
  // How square each outline is: 0.55 is an ellipse, 0.9 nearly a rectangle.
  const k = type === 'molar' ? 0.84 : type === 'premolar' ? 0.72 : type === 'canine' ? 0.6 : 0.86;
  // A canine comes to a point on its cheek side.
  const bOut = type === 'canine' ? b * 1.16 : b;

  const crown =
    `M ${P(0, -b)} C ${P(a * k, -b)} ${P(a, -b * k)} ${P(a, 0)}` +
    ` C ${P(a, bOut * k)} ${P(a * k, bOut)} ${P(0, bOut)}` +
    ` C ${P(-a * k, bOut)} ${P(-a, bOut * k)} ${P(-a, 0)}` +
    ` C ${P(-a, -b * k)} ${P(-a * k, -b)} ${P(0, -b)} Z`;

  let grooves: string;
  switch (type) {
    case 'molar':
      grooves =
        `M ${P(-a * 0.56, -b * 0.06)} Q ${P(0, b * 0.18)} ${P(a * 0.56, -b * 0.06)}` +
        ` M ${P(-a * 0.08, -b * 0.52)} L ${P(a * 0.08, b * 0.52)}`;
      break;
    case 'premolar':
      grooves = `M ${P(-a * 0.48, 0)} Q ${P(0, b * 0.16)} ${P(a * 0.48, 0)}`;
      break;
    case 'canine':
      grooves = `M ${P(0, -b * 0.3)} L ${P(0, bOut * 0.55)}`;
      break;
    default:
      grooves = `M ${P(-a * 0.55, -b * 0.08)} L ${P(a * 0.55, -b * 0.08)}`;
  }
  return { crown, grooves };
}

interface Props {
  dentition: Dentition;
  notation: Notation;
  teeth: ToothSummary[];
  selected: number | null;
  onSelectTooth: (tooth: number) => void;
}

export default function ArchView({ dentition, notation, teeth, selected, onSelectTooth }: Props) {
  const rawId = useId();
  const prefix = useMemo(() => `arch${rawId.replace(/[^a-zA-Z0-9]/g, '')}`, [rawId]);

  const byTooth = useMemo(() => {
    const m = new Map<number, ToothSummary>();
    for (const summary of teeth) m.set(summary.tooth, summary);
    return m;
  }, [teeth]);

  const seats = useMemo(() => {
    const { upper, lower } = archesFor(dentition);
    // Ten teeth an arch already get large crowns; boosting their depth as well
    // pushed the primary molars into each other.
    const boost = dentition === 'primary' ? 1 : DEPTH_BOOST;
    return [...seatArch(upper, true, boost), ...seatArch(lower, false, boost)];
  }, [dentition]);

  // The selected tooth is drawn last so its ring sits over its neighbours.
  const ordered = useMemo(
    () => [...seats].sort((x, y) => Number(x.tooth === selected) - Number(y.tooth === selected)),
    [seats, selected],
  );

  const gradient = (id: string, stops: readonly [string, string, string]) => (
    <radialGradient id={id} cx="34%" cy="28%" r="82%">
      <stop offset="0%" stopColor={stops[0]} />
      <stop offset="55%" stopColor={stops[1]} />
      <stop offset="100%" stopColor={stops[2]} />
    </radialGradient>
  );

  return (
    <div className="arch">
      <svg
        className="arch__svg"
        viewBox="-140 -164 280 328"
        role="group"
        aria-label={t(dentition === 'primary' ? 'tooth.chart.primary' : 'tooth.chart.permanent')}
      >
        <defs>
          {gradient(`${prefix}-enamel`, ENAMEL_STOPS)}
          {gradient(`${prefix}-selected`, SELECTED_STOPS)}
          {(Object.keys(TINT_STOPS) as Tint[]).map((tint) => (
            <g key={tint}>{gradient(`${prefix}-${tint}`, TINT_STOPS[tint])}</g>
          ))}
          <filter id={`${prefix}-lift`} x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#1e2360" floodOpacity="0.2" />
          </filter>
        </defs>

        {/* The occlusal plane and the midline — the frame a clinician reads
            orientation from. Faint, because they are not data. */}
        <line x1={-30} y1={0} x2={30} y2={0} className="arch__axis" />
        <line x1={0} y1={-30} x2={0} y2={30} className="arch__axis" />
        <text x={-38} y={3} className="arch__side" textAnchor="end">
          {t('tooth.side.right')}
        </text>
        <text x={38} y={3} className="arch__side">
          {t('tooth.side.left')}
        </text>

        {ordered.map((seat) => (
          <ArchTooth
            key={seat.tooth}
            seat={seat}
            prefix={prefix}
            notation={notation}
            summary={byTooth.get(seat.tooth)}
            selected={seat.tooth === selected}
            onSelect={onSelectTooth}
          />
        ))}
      </svg>
    </div>
  );
}

function ArchTooth({
  seat,
  prefix,
  notation,
  summary,
  selected,
  onSelect,
}: {
  seat: Seat;
  prefix: string;
  notation: Notation;
  summary?: ToothSummary;
  selected: boolean;
  onSelect: (tooth: number) => void;
}) {
  const { crown, grooves } = crownPaths(seat);
  const active = summary?.activeConditions ?? [];
  const absent = summary?.isAbsent ?? false;

  let tint: Tint | null = null;
  for (const c of active) {
    const candidate = TINT_BY_COLOUR.get(conditionStyle(c).color) ?? 'grey';
    if (!tint || TINT_RANK[candidate] > TINT_RANK[tint]) tint = candidate;
  }

  const fill = selected
    ? `url(#${prefix}-selected)`
    : absent
      ? 'none'
      : tint
        ? `url(#${prefix}-${tint})`
        : `url(#${prefix}-enamel)`;
  const stroke = selected ? undefined : tint ? ENCODING_PALETTE[tint] : undefined;

  const label = formatTooth(seat.tooth, notation);
  const labelX = seat.x + seat.nx * (seat.d / 2 + 9);
  const labelY = seat.y + seat.ny * (seat.d / 2 + 9) + 3.2;

  const findings = active.length
    ? active.map((c) => t(`tooth.condition.${c}`)).join(', ')
    : t('tooth.tip.healthy');

  const onKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(seat.tooth);
    }
  };

  return (
    <g
      className={`arch__tooth${selected ? ' arch__tooth--selected' : ''}${
        absent ? ' arch__tooth--absent' : ''
      }${tint && !selected ? ' arch__tooth--flagged' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${t('tooth.tip.tooth', { tooth: label })}, ${anatomicalName(seat.tooth)}: ${findings}`}
      onClick={() => onSelect(seat.tooth)}
      onKeyDown={onKeyDown}
    >
      <title>{`${label} · ${anatomicalName(seat.tooth)} — ${findings}`}</title>
      {selected && <path d={crown} className="arch__selring" />}
      <path
        d={crown}
        className="arch__crown"
        style={{ fill, ...(stroke ? { stroke } : {}) }}
        filter={absent ? undefined : `url(#${prefix}-lift)`}
      />
      {!absent && <path d={grooves} className="arch__groove" />}
      {!absent && (
        <ellipse
          cx={seat.x - seat.w * 0.14}
          cy={seat.y - seat.d * 0.16}
          rx={Math.max(1.2, seat.w * 0.16)}
          ry={Math.max(0.9, seat.d * 0.11)}
          className="arch__shine"
        />
      )}
      <text
        x={labelX.toFixed(1)}
        y={labelY.toFixed(1)}
        textAnchor="middle"
        className={`arch__label${selected ? ' arch__label--selected' : tint ? ' arch__label--flagged' : ''}`}
      >
        {label}
      </text>
    </g>
  );
}

/** What the arch's colours mean. Selection is listed because it is the one
 *  colour on the arch that is not a finding. */
export function ArchLegend() {
  const items: { key: string; label: string; background: string; border: string; dashed?: boolean }[] = [
    {
      key: 'pathology',
      label: t(FAMILY_KEYS.pathology),
      background: TINT_STOPS.crimson[1],
      border: ENCODING_PALETTE.crimson,
    },
    {
      key: 'watch',
      label: t('tooth.condition.watch'),
      background: TINT_STOPS.amber[1],
      border: ENCODING_PALETTE.amber,
    },
    {
      key: 'restoration',
      label: t(FAMILY_KEYS.restoration),
      background: TINT_STOPS.blue[1],
      border: ENCODING_PALETTE.blue,
    },
    {
      key: 'prosthetic',
      label: t(FAMILY_KEYS.prosthetic),
      background: TINT_STOPS.emerald[1],
      border: ENCODING_PALETTE.emerald,
    },
    {
      key: 'absent',
      label: t(FAMILY_KEYS.absent),
      background: 'transparent',
      border: ENCODING_PALETTE.grey,
      dashed: true,
    },
    { key: 'selected', label: 'Selected', background: SELECTED_STOPS[1], border: '#2b3288' },
  ];
  return (
    <ul className="archlegend" aria-label="What the colours mean">
      {items.map((i) => (
        <li key={i.key}>
          <span
            className="archlegend__dot"
            style={{
              background: i.background,
              borderColor: i.border,
              borderStyle: i.dashed ? 'dashed' : 'solid',
            }}
            aria-hidden
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
