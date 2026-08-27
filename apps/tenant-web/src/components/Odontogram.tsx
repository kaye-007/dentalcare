import { useId, useMemo, type CSSProperties } from 'react';
import {
  CONDITION_STYLE,
  ENCODING_PALETTE,
  OUTLINE_RANK,
  archesFor,
  conditionStyle,
  formatTooth,
  isAnterior,
  surfaceName,
  surfacesFor,
  toothType,
  type ConditionGlyph,
  type ConditionStyle,
  type Dentition,
  type Notation,
  type Surface,
  type ToothOutline,
} from '../lib/tooth-notation';
import type { ToothCondition, ToothSummary } from '../lib/api';
import { useT } from '../lib/i18n';

/**
 * Surface-level odontogram.
 *
 * Each tooth is drawn as a five-region diagram — the classic dental "cross":
 * four side regions (mesial, distal, facial, lingual) around a centre that is
 * the occlusal table on posteriors and the incisal edge on anteriors. A
 * clinician can therefore see at a glance WHICH surface is affected, which a
 * single coloured tooth outline cannot convey.
 *
 * Orientation follows charting convention: the chart is drawn as the dentist
 * faces the patient, so the patient's RIGHT is on the viewer's LEFT. Mesial
 * means "toward the midline", so which side of the glyph is mesial depends on
 * the quadrant — getting this backwards would mislabel every finding.
 *
 * Conditions are encoded by family colour CROSSED WITH a pattern channel —
 * fill texture, outline style, or a glyph — never by hue alone. See the
 * commentary above CONDITION_STYLE in lib/tooth-notation.ts for why.
 */

const CELL = 34;      // width of one tooth cell, and the crown box
const TOOTH_H = 46;   // height of the tooth glyph including the root stub
const GAP = 3;
const LABEL_H = 18;

/**
 * Compile-time guarantee that the encoding is total. If the API learns a new
 * condition and lib/tooth-notation.ts is not updated to match, this fails the
 * build — rather than the chart silently drawing a clinician's new finding as
 * an unmarked tooth.
 */
const _ENCODING_IS_TOTAL: Record<ToothCondition, ConditionStyle> = CONDITION_STYLE;
void _ENCODING_IS_TOTAL;

/* ── pattern engine ──────────────────────────────────────────────────────
   Patterns are declared per SVG instance and namespaced by a React id, so
   two odontograms on one page (a comparison view, a print sheet) cannot
   collide on a fragment identifier and paint each other's textures.
   userSpaceOnUse keeps the texture continuous across a tooth rather than
   restarting it inside every five-sided region, which would read as noise. */

export function ConditionPatternDefs({ prefix }: { prefix: string }) {
  const P = ENCODING_PALETTE;
  return (
    <defs>
      {/* caries — diagonal hatch. The most alarming texture for the most
          urgent finding: it reads as "something is eating this tooth". */}
      <pattern
        id={`${prefix}-hatch`} width="5" height="5"
        patternUnits="userSpaceOnUse" patternTransform="rotate(45)"
      >
        <rect width="5" height="5" fill={P.crimson} fillOpacity="0.16" />
        <line x1="0" y1="0" x2="0" y2="5" stroke={P.crimson} strokeWidth="1.9" />
      </pattern>

      {/* fractured — zigzag, echoing the fracture line drawn over the crown. */}
      <pattern id={`${prefix}-zigzag`} width="6" height="6" patternUnits="userSpaceOnUse">
        <rect width="6" height="6" fill={P.crimson} fillOpacity="0.14" />
        <path
          d="M0 4.6 L1.5 1.6 L3 4.6 L4.5 1.6 L6 4.6"
          fill="none" stroke={P.crimson} strokeWidth="1.1"
        />
      </pattern>

      {/* sealant — dots. The thinnest texture for the thinnest restoration. */}
      <pattern id={`${prefix}-dots`} width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="4" fill={P.blue} fillOpacity="0.13" />
        <circle cx="2" cy="2" r="1" fill={P.blue} />
      </pattern>

      {/* veneer — vertical lines, reading as a facing laid over one surface. */}
      <pattern id={`${prefix}-vlines`} width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="4" fill={P.blue} fillOpacity="0.13" />
        <line x1="1" y1="0" x2="1" y2="4" stroke={P.blue} strokeWidth="1.4" />
      </pattern>
    </defs>
  );
}

/**
 * Paint for one affected surface region.
 *
 * 'dashed' keeps a faint fill rather than fill:none — a region with no fill
 * is only clickable on its stroke, and a watch surface has to stay as easy to
 * hit as any other.
 */
function surfacePaint(st: ConditionStyle, prefix: string): CSSProperties | null {
  switch (st.surfaceFill) {
    case 'solid':  return { fill: st.color };
    case 'hatch':  return { fill: `url(#${prefix}-hatch)` };
    case 'zigzag': return { fill: `url(#${prefix}-zigzag)` };
    case 'dots':   return { fill: `url(#${prefix}-dots)` };
    case 'vlines': return { fill: `url(#${prefix}-vlines)` };
    case 'dashed':
      return {
        fill: st.color, fillOpacity: 0.12,
        stroke: st.color, strokeWidth: 1.4, strokeDasharray: '2.6 1.8',
      };
    default: return null;
  }
}

/**
 * Marks drawn over a tooth. Every stroke is drawn twice — once in the surface
 * colour at a heavier width, then in the condition colour — so a glyph stays
 * legible on top of a dark solid restoration as well as on bare enamel.
 */
function Glyph({
  kind, color, s, rootTop, rootBottom,
}: {
  kind: ConditionGlyph;
  color: string;
  s: number;
  rootTop: number;
  rootBottom: number;
}) {
  const twice = (d: string, key?: string) => (
    <g key={key}>
      <path d={d} className="odo__glyph-halo" />
      <path d={d} className="odo__glyph-mark" style={{ stroke: color }} />
    </g>
  );

  switch (kind) {
    case 'fracture':
      return (
        <g className="odo__glyph">
          {twice(
            `M ${s * 0.16} ${s * 0.07} L ${s * 0.45} ${s * 0.36}` +
            ` L ${s * 0.29} ${s * 0.53} L ${s * 0.65} ${s * 0.77}` +
            ` L ${s * 0.47} ${s * 0.92}`,
          )}
        </g>
      );

    case 'strike':
      return (
        <g className="odo__glyph">
          <path d={`M 3 3 L ${s - 3} ${s - 3}`} className="odo__glyph-halo" />
          <path d={`M ${s - 3} 3 L 3 ${s - 3}`} className="odo__glyph-halo" />
          <path d={`M 3 3 L ${s - 3} ${s - 3}`} className="odo__glyph-mark" style={{ stroke: color }} />
          <path d={`M ${s - 3} 3 L 3 ${s - 3}`} className="odo__glyph-mark" style={{ stroke: color }} />
        </g>
      );

    case 'post': {
      // A threaded fixture seated in bone: shaft down the root, three threads.
      const cx = s / 2;
      const h = rootBottom - rootTop;
      return (
        <g className="odo__glyph">
          {twice(`M ${cx} ${rootTop - 3} L ${cx} ${rootBottom - 1}`)}
          {[0.2, 0.48, 0.76].map((f, i) => {
            const ty = rootTop + h * f;
            return twice(`M ${cx - 3.2} ${ty} L ${cx + 3.2} ${ty}`, `t${i}`);
          })}
        </g>
      );
    }

    case 'endo':
      // One fill line to the apex, which is how it is drawn on paper.
      return (
        <g className="odo__glyph">
          {twice(`M ${s / 2} ${rootTop - 5} L ${s / 2} ${rootBottom - 2.5}`)}
          <circle cx={s / 2} cy={rootBottom - 1.6} r={1.9}
            className="odo__glyph-dot" style={{ fill: color }} />
        </g>
      );

    case 'angled': {
      // A tooth lying at an angle beneath the gum: the bar is the gum line,
      // the tilted body is the tooth that never came through.
      const bx = s - 12;
      const by = s - 13;
      return (
        <g className="odo__glyph">
          {twice(`M ${bx - 1} ${by} L ${bx + 10.5} ${by}`)}
          <g transform={`rotate(38 ${bx + 4.8} ${by + 6})`}>
            <rect x={bx + 1.8} y={by + 2} width={6} height={8.6} rx={1.6}
              className="odo__glyph-badge-halo" />
            <rect x={bx + 1.8} y={by + 2} width={6} height={8.6} rx={1.6}
              className="odo__glyph-badge" style={{ stroke: color }} />
          </g>
        </g>
      );
    }

    // 'span' is a relationship between two teeth, so it is drawn by the arch.
    default:
      return null;
  }
}

interface Props {
  dentition: Dentition;
  notation: Notation;
  teeth: ToothSummary[];
  selected: number | null;
  onSelectTooth: (tooth: number) => void;
  onSelectSurface?: (tooth: number, surface: Surface) => void;
}

export default function Odontogram({
  dentition, notation, teeth, selected, onSelectTooth, onSelectSurface,
}: Props) {
  const rawId = useId();
  const prefix = useMemo(() => `odo${rawId.replace(/[^a-zA-Z0-9]/g, '')}`, [rawId]);

  const byTooth = useMemo(() => {
    const m = new Map<number, ToothSummary>();
    for (const t of teeth) m.set(t.tooth, t);
    return m;
  }, [teeth]);

  const { upper, lower } = archesFor(dentition);
  const width = Math.max(upper.length, lower.length) * (CELL + GAP);
  const rowH = TOOTH_H + LABEL_H + 10;

  return (
    <div className="odo">
      <svg
        className="odo__svg"
        viewBox={`0 0 ${width} ${rowH * 2 + 14}`}
        role="img"
        aria-label={`${dentition === 'primary' ? 'Primary' : 'Permanent'} dentition chart`}
      >
        <ConditionPatternDefs prefix={prefix} />
        <Arch
          teeth={upper}
          y={0}
          byTooth={byTooth}
          notation={notation}
          selected={selected}
          labelBelow={false}
          patternPrefix={prefix}
          onSelectTooth={onSelectTooth}
          onSelectSurface={onSelectSurface}
        />
        {/* Midline between the arches. */}
        <line
          x1={0} y1={rowH + 5} x2={width} y2={rowH + 5}
          stroke="var(--border)" strokeWidth={1}
        />
        <Arch
          teeth={lower}
          y={rowH + 14}
          byTooth={byTooth}
          notation={notation}
          selected={selected}
          labelBelow
          patternPrefix={prefix}
          onSelectTooth={onSelectTooth}
          onSelectSurface={onSelectSurface}
        />
      </svg>
    </div>
  );
}

function Arch({
  teeth, y, byTooth, notation, selected, labelBelow, patternPrefix,
  onSelectTooth, onSelectSurface,
}: {
  teeth: number[];
  y: number;
  byTooth: Map<number, ToothSummary>;
  notation: Notation;
  selected: number | null;
  labelBelow: boolean;
  patternPrefix: string;
  onSelectTooth: (t: number) => void;
  onSelectSurface?: (t: number, s: Surface) => void;
}) {
  const toothY = labelBelow ? y : y + LABEL_H;

  /**
   * Bridge connectors.
   *
   * A crown and a bridge are the same boundary; the only thing that makes a
   * bridge a bridge is that it spans. That relationship lives between two
   * teeth, so it cannot be drawn inside a single tooth glyph — it is drawn
   * here, across the cell gap, at the cervical third where a real connector
   * sits. Array adjacency is physical adjacency in both arches, including
   * across the midline.
   *
   * A bridge is charted abutment–pontic–abutment: the replaced tooth is not
   * itself marked `bridge`, it is marked `missing` or `extracted`, because
   * that is what it clinically is. So the connector cannot be a test on
   * neighbouring pairs — it has to walk the arch and find RUNS of abutments
   * separated only by pontics, then draw one continuous bar across the whole
   * unit. A run that is broken by a present, non-abutment tooth is two
   * bridges, not one: nothing spans over a standing tooth.
   *
   * One bar per unit rather than one per gap, so a multi-unit bridge has no
   * seams where segment halos overlap.
   */
  const spans = useMemo(() => {
    const conditionsOf = (t: number): readonly ToothCondition[] =>
      byTooth.get(t)?.activeConditions ?? [];
    const isAbutment = (t: number) => conditionsOf(t).includes('bridge');
    const isPontic = (t: number) =>
      conditionsOf(t).some((c) => c === 'missing' || c === 'extracted');

    // [startIndex, endIndex] of each connected bridge unit.
    const runs: Array<[number, number]> = [];
    let start: number | null = null;
    let lastAbutment: number | null = null;

    const close = () => {
      // A single abutment with nothing to reach is not a span. It stays a
      // bare thick outline, which is a data-entry question, not a drawing one.
      if (start !== null && lastAbutment !== null && lastAbutment > start) {
        runs.push([start, lastAbutment]);
      }
      start = null;
      lastAbutment = null;
    };

    teeth.forEach((tooth, i) => {
      if (isAbutment(tooth)) {
        if (start === null) start = i;
        lastAbutment = i;
        return;
      }
      // A pontic continues an open run; it never starts one, so a gap that
      // trails off the end of a bridge is not drawn into.
      if (start !== null && isPontic(tooth)) return;
      close();
    });
    close();

    const barY = toothY + CELL + 3;

    return runs.map(([a, b]) => {
      const first = teeth[a]!;
      const last = teeth[b]!;
      const pontics = teeth.slice(a + 1, b).filter(isPontic);
      const x1 = a * (CELL + GAP) + CELL / 2;
      const x2 = b * (CELL + GAP) + CELL / 2;
      const d = `M ${x1} ${barY} L ${x2} ${barY}`;
      const label = pontics.length
        ? `Bridge · abutments ${first} and ${last} · ` +
          `pontic${pontics.length > 1 ? 's' : ''} ${pontics.join(', ')}`
        : `Bridge · teeth ${first}–${last}`;
      return (
        <g key={`span-${first}-${last}`}>
          <path d={d} className="odo__span-halo" />
          <path d={d} className="odo__span" style={{ stroke: ENCODING_PALETTE.emerald }}>
            <title>{label}</title>
          </path>
        </g>
      );
    });
  }, [teeth, byTooth, toothY]);

  return (
    <g>
      {teeth.map((tooth, i) => {
        const x = i * (CELL + GAP);
        const summary = byTooth.get(tooth);
        const labelY = labelBelow ? y + TOOTH_H + 13 : y + 13;
        return (
          <g key={tooth}>
            <text
              x={x + CELL / 2}
              y={labelY}
              className={`odo__label${selected === tooth ? ' odo__label--sel' : ''}`}
              textAnchor="middle"
            >
              {formatTooth(tooth, notation)}
            </text>
            <ToothGlyph
              tooth={tooth}
              x={x}
              y={toothY}
              summary={summary}
              selected={selected === tooth}
              patternPrefix={patternPrefix}
              onSelectTooth={onSelectTooth}
              onSelectSurface={onSelectSurface}
            />
          </g>
        );
      })}
      {spans}
    </g>
  );
}

/**
 * One tooth as five clickable regions.
 *
 * The four outer trapezoids are the axial surfaces and the inner square is the
 * occlusal/incisal. Left and right map to mesial/distal by quadrant: in
 * quadrants 1, 4, 5 and 8 (the patient's right, drawn on the viewer's left)
 * the midline is to the RIGHT of the glyph, so mesial is the right-hand
 * region; in quadrants 2, 3, 6 and 7 it is the left.
 */
function ToothGlyph({
  tooth, x, y, summary, selected, patternPrefix, onSelectTooth, onSelectSurface,
}: {
  tooth: number;
  x: number;
  y: number;
  summary?: ToothSummary;
  selected: boolean;
  patternPrefix: string;
  onSelectTooth: (t: number) => void;
  onSelectSurface?: (t: number, s: Surface) => void;
}) {
  const t = useT();
  const s = CELL;
  const inset = s * 0.3;
  const centre: Surface = isAnterior(tooth) ? 'I' : 'O';

  const quad = Math.floor(tooth / 10);
  const midlineOnRight = [1, 4, 5, 8].includes(quad);
  const leftSurface: Surface = midlineOnRight ? 'D' : 'M';
  const rightSurface: Surface = midlineOnRight ? 'M' : 'D';

  // Upper teeth: palatal is toward the midline of the mouth, drawn at the
  // bottom of the upper arch (nearest the occlusal plane). Lower teeth mirror.
  const upper = [1, 2, 5, 6].includes(quad);
  const topSurface: Surface = upper ? 'F' : 'L';
  const bottomSurface: Surface = upper ? 'L' : 'F';

  const valid = surfacesFor(tooth);
  const active = summary?.activeConditions ?? [];

  /**
   * The boundary shows the single most consequential finding; a crowned tooth
   * that has also been root-treated is ordinary, not an edge case, so the
   * remaining findings still draw their own glyphs below.
   */
  const { outline, outlineColor } = active.reduce<{
    outline: ToothOutline; outlineColor: string | undefined;
  }>((best, c) => {
    const st = conditionStyle(c);
    return OUTLINE_RANK[st.outline] > OUTLINE_RANK[best.outline]
      ? { outline: st.outline, outlineColor: st.color }
      : best;
  }, { outline: 'none', outlineColor: undefined });

  // One mark per glyph kind, in the order the conditions were recorded.
  const marks: { kind: ConditionGlyph; color: string }[] = [];
  const seen = new Set<ConditionGlyph>();
  for (const c of active) {
    const st = conditionStyle(c);
    if (st.glyph === 'none' || st.glyph === 'span' || seen.has(st.glyph)) continue;
    seen.add(st.glyph);
    marks.push({ kind: st.glyph, color: st.color });
  }

  const phantom = outline === 'phantom';

  const region = (surface: Surface, points: string) => {
    if (!valid.includes(surface)) return null;
    const conds = summary?.surfaces?.[surface] ?? [];
    const paint = conds.length ? surfacePaint(conditionStyle(conds[0]!), patternPrefix) : null;
    return (
      <polygon
        key={surface}
        points={points}
        className={`odo__surface${paint ? ' odo__surface--filled' : ''}`}
        style={paint ?? undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (onSelectSurface) onSelectSurface(tooth, surface);
          else onSelectTooth(tooth);
        }}
      >
        <title>
          {`${surfaceName(tooth, surface)} — ${t('tooth.tip.tooth', { tooth })}` +
            (conds.length
              // Conditions are translated one by one rather than joined from a
              // pre-built English string: this <title> is what a screen reader
              // announces and what a dentist sees on hover.
              ? ` · ${conds.map((c) => t(`tooth.condition.${c}`)).join(', ')}`
              : ` · ${t('tooth.tip.healthy')}`)}
        </title>
      </polygon>
    );
  };

  const type = toothType(tooth);

  return (
    <g
      transform={`translate(${x}, ${y})`}
      className={
        `odo__tooth${selected ? ' odo__tooth--sel' : ''}` +
        `${phantom ? ' odo__tooth--phantom' : ''}`
      }
      onClick={() => onSelectTooth(tooth)}
    >
      {/* top */}
      {region(topSurface, `0,0 ${s},0 ${s - inset},${inset} ${inset},${inset}`)}
      {/* bottom */}
      {region(bottomSurface, `${inset},${s - inset} ${s - inset},${s - inset} ${s},${s} 0,${s}`)}
      {/* left */}
      {region(leftSurface, `0,0 ${inset},${inset} ${inset},${s - inset} 0,${s}`)}
      {/* right */}
      {region(rightSurface, `${s},0 ${s},${s} ${s - inset},${s - inset} ${s - inset},${inset}`)}
      {/* centre: occlusal or incisal */}
      {region(centre, `${inset},${inset} ${s - inset},${inset} ${s - inset},${s - inset} ${inset},${s - inset}`)}

      {/* Root stub, so molars read differently from incisors at a glance. */}
      <rect
        x={s * 0.34}
        y={s}
        width={s * 0.32}
        height={TOOTH_H - s}
        rx={2}
        className="odo__root"
        style={type === 'molar' ? { opacity: 0.9 } : undefined}
      />

      <rect
        x={0} y={0} width={s} height={s}
        className={`odo__outline odo__outline--${outline}`}
        style={outlineColor ? { stroke: outlineColor } : undefined}
      />

      {selected && (
        <rect
          x={-2.5} y={-2.5} width={s + 5} height={s + 5} rx={4}
          className="odo__selring"
        />
      )}

      {marks.map((m) => (
        <Glyph
          key={m.kind}
          kind={m.kind}
          color={m.color}
          s={s}
          rootTop={s}
          rootBottom={TOOTH_H}
        />
      ))}
    </g>
  );
}

/**
 * A single condition rendered at legend scale — the same colour, the same
 * texture, the same outline and the same glyph as the chart itself. A legend
 * that only showed the colour would be describing an encoding this chart no
 * longer uses.
 */
export function ConditionSwatch({
  condition, size = 18,
}: {
  condition: string;
  size?: number;
}) {
  const rawId = useId();
  const prefix = useMemo(() => `sw${rawId.replace(/[^a-zA-Z0-9]/g, '')}`, [rawId]);
  const st = conditionStyle(condition);
  const S = 24;
  const paint = surfacePaint(st, prefix);
  // A condition with no boundary of its own still needs an edge in the legend.
  const outlineClass = st.outline === 'none' ? 'legend' : st.outline;

  return (
    <svg
      className="odo__swatch"
      width={size} height={size}
      viewBox={`0 0 ${S} ${S}`}
      aria-hidden="true" focusable="false"
    >
      <ConditionPatternDefs prefix={prefix} />
      <rect
        x={2} y={2} width={S - 4} height={S - 4} rx={3}
        className="odo__swatch-body"
        style={paint ?? undefined}
      />
      <rect
        x={2} y={2} width={S - 4} height={S - 4} rx={3}
        className={`odo__outline odo__outline--${outlineClass}`}
        style={{ stroke: st.color }}
      />
      {st.glyph === 'span' ? (
        <g className="odo__glyph">
          <path d={`M 3 ${S - 6.5} L ${S - 3} ${S - 6.5}`} className="odo__span-halo" />
          <path
            d={`M 3 ${S - 6.5} L ${S - 3} ${S - 6.5}`}
            className="odo__span"
            style={{ stroke: st.color }}
          />
        </g>
      ) : (
        <Glyph
          kind={st.glyph}
          color={st.color}
          s={S}
          rootTop={S * 0.60}
          rootBottom={S - 3}
        />
      )}
    </svg>
  );
}
