import { useId, useMemo, type CSSProperties } from 'react';
// Anatomy — the same module the API validates against.
import {
  archesFor,
  formatTooth,
  isAnterior,
  surfaceName,
  surfacesFor,
  toothType,
  type Dentition,
  type Notation,
  type Surface,
  type ToothType,
} from '@dentalcare/shared';
// Drawing — this app's alone.
import {
  CONDITION_STYLE,
  ENCODING_PALETTE,
  OUTLINE_RANK,
  conditionStyle,
  type ConditionGlyph,
  type ConditionStyle,
  type ToothOutline,
} from '../lib/tooth-notation';
import type { ToothCondition, ToothSummary } from '../lib/api';
import { t } from '../lib/strings';

/**
 * Surface-level odontogram, drawn as an anatomical arch.
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
        id={`${prefix}-hatch`}
        width="5"
        height="5"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="5" height="5" fill={P.crimson} fillOpacity="0.16" />
        <line x1="0" y1="0" x2="0" y2="5" stroke={P.crimson} strokeWidth="1.9" />
      </pattern>

      {/* fractured — zigzag, echoing the fracture line drawn over the crown. */}
      <pattern id={`${prefix}-zigzag`} width="6" height="6" patternUnits="userSpaceOnUse">
        <rect width="6" height="6" fill={P.crimson} fillOpacity="0.14" />
        <path
          d="M0 4.6 L1.5 1.6 L3 4.6 L4.5 1.6 L6 4.6"
          fill="none"
          stroke={P.crimson}
          strokeWidth="1.1"
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
    case 'solid':
      return { fill: st.color };
    case 'hatch':
      return { fill: `url(#${prefix}-hatch)` };
    case 'zigzag':
      return { fill: `url(#${prefix}-zigzag)` };
    case 'dots':
      return { fill: `url(#${prefix}-dots)` };
    case 'vlines':
      return { fill: `url(#${prefix}-vlines)` };
    case 'dashed':
      return {
        fill: st.color,
        fillOpacity: 0.12,
        stroke: st.color,
        strokeWidth: 1.4,
        strokeDasharray: '2.6 1.8',
      };
    default:
      return null;
  }
}

/**
 * Marks drawn over a tooth. Every stroke is drawn twice — once in the surface
 * colour at a heavier width, then in the condition colour — so a glyph stays
 * legible on top of a dark solid restoration as well as on bare enamel.
 */
function Glyph({
  kind,
  color,
  s,
  rootTop,
  rootBottom,
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
          <path
            d={`M 3 3 L ${s - 3} ${s - 3}`}
            className="odo__glyph-mark"
            style={{ stroke: color }}
          />
          <path
            d={`M ${s - 3} 3 L 3 ${s - 3}`}
            className="odo__glyph-mark"
            style={{ stroke: color }}
          />
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
          <circle
            cx={s / 2}
            cy={rootBottom - 1.6}
            r={1.9}
            className="odo__glyph-dot"
            style={{ fill: color }}
          />
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
            <rect
              x={bx + 1.8}
              y={by + 2}
              width={6}
              height={8.6}
              rx={1.6}
              className="odo__glyph-badge-halo"
            />
            <rect
              x={bx + 1.8}
              y={by + 2}
              width={6}
              height={8.6}
              rx={1.6}
              className="odo__glyph-badge"
              style={{ stroke: color }}
            />
          </g>
        </g>
      );
    }

    // 'span' is a relationship between two teeth, so it is drawn by the arch.
    default:
      return null;
  }
}

/* ── arch geometry ───────────────────────────────────────────────────────
   The chart is one ellipse: the upper arch across the top half, the lower
   across the bottom. That is what makes the two read as one mouth rather than
   two rows that happen to be stacked, and it is the view a clinician has
   looking into an open mouth — every occlusal surface facing the centre.

   The ellipse is taller than it is wide because a dental arch is: the molars
   run back along the sides and only the six anterior teeth cross the front.
   A circle would fan the molars outward and read as a smile.

   Each tooth is still the five-region cross this chart has always drawn —
   that is what makes a SURFACE clickable rather than a whole tooth — but the
   regions are now clipped to an anatomical crown outline and the group is
   rotated so the root points radially outward. Nothing about the encoding,
   the surface mapping or the hit areas changed; only where they sit. */

const RX = 132; // arch half-width at the molars
const RY = 196; // arch depth, front to back
const LABEL_RING = 1.2; // how far outside the arch the numbers sit

/**
 * Degrees swept by each arch, in SVG coordinates where +y points DOWN.
 *
 * The upper arch ascends 188° -> 352°, passing 270°, where sin is negative and
 * the teeth are therefore at the top of the picture. The lower arch DESCENDS
 * 172° -> 8°, passing 90°, at the bottom. Both sweeps are plain linear
 * interpolation between the two numbers; normalising the descending one by
 * adding 360° would send it through 270° as well and stack the lower arch on
 * top of the upper — which is exactly what the first version of this did.
 *
 * The small gaps either side of 0° and 180° are the midline: without them the
 * last upper tooth and the last lower tooth meet at the sides and the two
 * arches lose the seam that tells them apart.
 */
const UPPER_ARC = { from: 188, to: 352 };
const LOWER_ARC = { from: 172, to: 8 };

/** Crown box per tooth class — width across, height from occlusal to neck. */
const CROWN_W: Readonly<Record<ToothType, number>> = {
  incisor: 21,
  canine: 22,
  premolar: 25,
  molar: 31,
};
const CROWN_H: Readonly<Record<ToothType, number>> = {
  incisor: 25,
  canine: 26,
  premolar: 24,
  molar: 25,
};
/** Root length. A canine's root is the longest in the mouth; it should look it. */
const ROOT_LEN: Readonly<Record<ToothType, number>> = {
  incisor: 20,
  canine: 26,
  premolar: 18,
  molar: 19,
};

/** A selected tooth grows, so its five surfaces stay reachable on a phone. */
const SELECTED_SCALE = 1.32;

interface Placement {
  x: number;
  y: number;
  /** Degrees, measured on the ellipse from the centre of the mouth. */
  deg: number;
  /** Rotation applied to the tooth group so the root points outward. */
  rot: number;
}

function placeOnArch(
  index: number,
  count: number,
  arc: { from: number; to: number },
): Placement {
  const t = count === 1 ? 0.5 : index / (count - 1);
  // Straight interpolation, ascending or descending. See UPPER_ARC.
  const deg = arc.from + (arc.to - arc.from) * t;
  const rad = (deg * Math.PI) / 180;
  return {
    x: RX * Math.cos(rad),
    y: RY * Math.sin(rad),
    deg,
    // The glyph is drawn crown-up / root-down, so aligning local +y with the
    // outward ray is a quarter turn from the ray's own angle.
    rot: deg - 90,
  };
}

/** A point on a concentric ellipse — used for labels and bridge bars. */
function ellipsePoint(deg: number, scale: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: RX * scale * Math.cos(rad), y: RY * scale * Math.sin(rad) };
}

/**
 * The anatomical crown outline, in the local box (0,0)–(w,h) with the
 * occlusal or incisal edge along the top.
 *
 * These are drawn per class rather than as one rounded rectangle because the
 * silhouette is how a clinician finds a tooth without reading its number: a
 * molar is wide with four cusps, a canine has one point, an incisor is a
 * chisel. Getting that right is most of what makes the chart legible at a
 * glance.
 */
function crownOutline(type: ToothType, w: number, h: number): string {
  const r = w / 2;
  switch (type) {
    case 'incisor':
      // Chisel: a wide flat incisal edge narrowing toward the neck.
      return `M 0 1.5 Q 0 0 2 0 L ${w - 2} 0 Q ${w} 0 ${w} 1.5
              L ${w - 2.6} ${h} Q ${r} ${h + 2} 2.6 ${h} Z`;
    case 'canine':
      // One cusp, and the point is the whole identity of the tooth.
      return `M ${r} -2.5 L ${w} 5.5 L ${w - 2.6} ${h} Q ${r} ${h + 2} 2.6 ${h} L 0 5.5 Z`;
    case 'premolar':
      // Two cusps with a central groove.
      return `M 0 3 Q ${r * 0.5} -2.5 ${r} 2 Q ${r * 1.5} -2.5 ${w} 3
              L ${w - 3} ${h} Q ${r} ${h + 2} 3 ${h} Z`;
    default:
      // Molar: four cusps.
      return `M 0 4 Q ${r * 0.42} -2.5 ${r * 0.72} 2
              Q ${r} -3 ${r * 1.28} 2 Q ${r * 1.58} -2.5 ${w} 4
              L ${w - 3.5} ${h} Q ${r} ${h + 2} 3.5 ${h} Z`;
  }
}

/** Roots below the neck. The count is anatomical, not decorative. */
function rootOutlines(type: ToothType, w: number, h: number): string[] {
  const len = ROOT_LEN[type];
  const taper = (cx: number, width: number, lean: number) =>
    `M ${cx - width / 2} ${h - 1}
     Q ${cx - width / 2 + lean * 0.6} ${h + len * 0.7} ${cx + lean} ${h + len}
     Q ${cx + width / 2 + lean * 0.6} ${h + len * 0.7} ${cx + width / 2} ${h - 1} Z`;
  if (type === 'molar') {
    return [taper(w * 0.28, 7, -2.6), taper(w * 0.72, 7, 2.6)];
  }
  return [taper(w / 2, type === 'canine' ? 8 : 7, 0)];
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
  dentition,
  notation,
  teeth,
  selected,
  onSelectTooth,
  onSelectSurface,
}: Props) {
  const rawId = useId();
  const prefix = useMemo(() => `odo${rawId.replace(/[^a-zA-Z0-9]/g, '')}`, [rawId]);

  const byTooth = useMemo(() => {
    const m = new Map<number, ToothSummary>();
    for (const tooth of teeth) m.set(tooth.tooth, tooth);
    return m;
  }, [teeth]);

  const { upper, lower } = archesFor(dentition);

  // Room for the label ring, plus the deepest root, plus a little air.
  const halfW = RX * LABEL_RING + 34;
  const halfH = RY * LABEL_RING + 30;

  return (
    <div className="odo">
      <svg
        className="odo__svg"
        viewBox={`${-halfW} ${-halfH} ${halfW * 2} ${halfH * 2}`}
        role="img"
        aria-label={t(
          dentition === 'primary' ? 'tooth.chart.primary' : 'tooth.chart.permanent',
        )}
      >
        <ConditionPatternDefs prefix={prefix} />

        {/* Midline cross. The vertical is the facial midline, the horizontal
            the occlusal plane — the two references a clinician orients by. */}
        <line x1={-46} y1={0} x2={46} y2={0} className="odo__axis" />
        <line x1={0} y1={-46} x2={0} y2={46} className="odo__axis" />
        <text x={-56} y={4} className="odo__side" textAnchor="end">
          {t('tooth.side.right')}
        </text>
        <text x={56} y={4} className="odo__side">
          {t('tooth.side.left')}
        </text>
        <text x={0} y={-58} className="odo__side" textAnchor="middle">
          {t('tooth.arch.upper')}
        </text>
        <text x={0} y={66} className="odo__side" textAnchor="middle">
          {t('tooth.arch.lower')}
        </text>

        <Arch
          teeth={upper}
          arc={UPPER_ARC}
          byTooth={byTooth}
          notation={notation}
          selected={selected}
          patternPrefix={prefix}
          onSelectTooth={onSelectTooth}
          onSelectSurface={onSelectSurface}
        />
        <Arch
          teeth={lower}
          arc={LOWER_ARC}
          byTooth={byTooth}
          notation={notation}
          selected={selected}
          patternPrefix={prefix}
          onSelectTooth={onSelectTooth}
          onSelectSurface={onSelectSurface}
        />
      </svg>
    </div>
  );
}

function Arch({
  teeth,
  arc,
  byTooth,
  notation,
  selected,
  patternPrefix,
  onSelectTooth,
  onSelectSurface,
}: {
  // readonly: the arches come from @dentalcare/shared and are frozen there.
  teeth: readonly number[];
  arc: { from: number; to: number };
  byTooth: Map<number, ToothSummary>;
  notation: Notation;
  selected: number | null;
  patternPrefix: string;
  onSelectTooth: (t: number) => void;
  onSelectSurface?: (t: number, s: Surface) => void;
}) {
  const placements = useMemo(
    () => teeth.map((_, i) => placeOnArch(i, teeth.length, arc)),
    [teeth, arc],
  );

  /**
   * Bridge connectors.
   *
   * A crown and a bridge are the same boundary; the only thing that makes a
   * bridge a bridge is that it spans. That relationship lives between two
   * teeth, so it cannot be drawn inside a single tooth glyph — it is drawn
   * here, as an arc following the arch at the cervical third where a real
   * connector sits. Array adjacency is physical adjacency in both arches,
   * including across the midline.
   *
   * A bridge is charted abutment–pontic–abutment: the replaced tooth is not
   * itself marked `bridge`, it is marked `missing` or `extracted`, because
   * that is what it clinically is. So the connector cannot be a test on
   * neighbouring pairs — it has to walk the arch and find RUNS of abutments
   * separated only by pontics, then draw one continuous bar across the whole
   * unit. A run broken by a present, non-abutment tooth is two bridges, not
   * one: nothing spans over a standing tooth.
   */
  const spans = useMemo(() => {
    const conditionsOf = (tooth: number): readonly ToothCondition[] =>
      byTooth.get(tooth)?.activeConditions ?? [];
    const isAbutment = (tooth: number) => conditionsOf(tooth).includes('bridge');
    const isPontic = (tooth: number) =>
      conditionsOf(tooth).some((c) => c === 'missing' || c === 'extracted');

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

    // At the necks, where a real connector sits. The crown is centred on the
    // placement point and the root runs outward from it, so the cervical line
    // is just OUTSIDE the arch radius, not inside it.
    const BAR = 1.07;

    return runs.map(([a, b]) => {
      const first = teeth[a]!;
      const last = teeth[b]!;
      const pontics = teeth.slice(a + 1, b).filter(isPontic);
      const p1 = ellipsePoint(placements[a]!.deg, BAR);
      const p2 = ellipsePoint(placements[b]!.deg, BAR);
      const sweep = placements[b]!.deg > placements[a]!.deg ? 1 : 0;
      const d = `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${RX * BAR} ${RY * BAR} 0 0 ${sweep} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
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
  }, [teeth, byTooth, placements]);

  return (
    <g>
      {spans}
      {teeth.map((tooth, i) => {
        const p = placements[i]!;
        const label = ellipsePoint(p.deg, LABEL_RING);
        return (
          <g key={tooth}>
            <ToothGlyph
              tooth={tooth}
              place={p}
              summary={byTooth.get(tooth)}
              selected={selected === tooth}
              patternPrefix={patternPrefix}
              onSelectTooth={onSelectTooth}
              onSelectSurface={onSelectSurface}
            />
            {/* The number stays upright wherever it sits on the arch. Rotating
                it with its tooth would leave the back molars upside down. */}
            <text
              x={label.x.toFixed(1)}
              y={(label.y + 3.6).toFixed(1)}
              className={`odo__label${selected === tooth ? ' odo__label--sel' : ''}`}
              textAnchor="middle"
            >
              {formatTooth(tooth, notation)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * One tooth as five clickable regions, inside an anatomical outline.
 *
 * The four outer trapezoids are the axial surfaces and the inner rectangle is
 * the occlusal/incisal. Left and right map to mesial/distal by quadrant: in
 * quadrants 1, 4, 5 and 8 (the patient's right, drawn on the viewer's left)
 * the midline is to the RIGHT of the glyph, so mesial is the right-hand
 * region; in quadrants 2, 3, 6 and 7 it is the left.
 *
 * The regions are clipped to the crown outline, so the tooth is shaped like a
 * tooth while every surface keeps exactly the hit area it had as a square.
 */
function ToothGlyph({
  tooth,
  place,
  summary,
  selected,
  patternPrefix,
  onSelectTooth,
  onSelectSurface,
}: {
  tooth: number;
  place: Placement;
  summary?: ToothSummary;
  selected: boolean;
  patternPrefix: string;
  onSelectTooth: (t: number) => void;
  onSelectSurface?: (t: number, s: Surface) => void;
}) {
  const type = toothType(tooth);
  const w = CROWN_W[type];
  const h = CROWN_H[type];
  const inset = Math.min(w, h) * 0.3;
  const centre: Surface = isAnterior(tooth) ? 'I' : 'O';
  const clipId = `${patternPrefix}-clip-${tooth}`;

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
    outline: ToothOutline;
    outlineColor: string | undefined;
  }>(
    (best, c) => {
      const st = conditionStyle(c);
      return OUTLINE_RANK[st.outline] > OUTLINE_RANK[best.outline]
        ? { outline: st.outline, outlineColor: st.color }
        : best;
    },
    { outline: 'none', outlineColor: undefined },
  );

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
  const crown = crownOutline(type, w, h);

  const region = (surface: Surface, points: string) => {
    if (!valid.includes(surface)) return null;
    const conds = summary?.surfaces?.[surface] ?? [];
    const paint = conds.length
      ? surfacePaint(conditionStyle(conds[0]!), patternPrefix)
      : null;
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
              ? // Conditions are translated one by one rather than joined from a
                // pre-built English string: this <title> is what a screen reader
                // announces and what a dentist sees on hover.
                ` · ${conds.map((c) => t(`tooth.condition.${c}`)).join(', ')}`
              : ` · ${t('tooth.tip.healthy')}`)}
        </title>
      </polygon>
    );
  };

  return (
    <g
      transform={
        `translate(${place.x.toFixed(2)} ${place.y.toFixed(2)}) rotate(${place.rot.toFixed(2)})` +
        (selected ? ` scale(${SELECTED_SCALE})` : '')
      }
      className={
        `odo__tooth${selected ? ' odo__tooth--sel' : ''}` +
        `${phantom ? ' odo__tooth--phantom' : ''}`
      }
      onClick={() => onSelectTooth(tooth)}
    >
      {/* The crown box is centred on the placement point so a selected tooth
          grows about its own middle rather than drifting off the arch. */}
      <g transform={`translate(${-w / 2} ${-h / 2})`}>
        <defs>
          <clipPath id={clipId}>
            <path d={crown} />
          </clipPath>
        </defs>

        {/* Roots first, so the crown's own outline draws over the joint. */}
        {rootOutlines(type, w, h).map((d, i) => (
          <path key={i} d={d} className="odo__root" />
        ))}

        {selected && <path d={crown} className="odo__selring" />}

        <g clipPath={`url(#${clipId})`}>
          {/* top */}
          {region(topSurface, `0,0 ${w},0 ${w - inset},${inset} ${inset},${inset}`)}
          {/* bottom */}
          {region(
            bottomSurface,
            `${inset},${h - inset} ${w - inset},${h - inset} ${w},${h} 0,${h}`,
          )}
          {/* left */}
          {region(leftSurface, `0,0 ${inset},${inset} ${inset},${h - inset} 0,${h}`)}
          {/* right */}
          {region(
            rightSurface,
            `${w},0 ${w},${h} ${w - inset},${h - inset} ${w - inset},${inset}`,
          )}
          {/* centre: occlusal or incisal */}
          {region(
            centre,
            `${inset},${inset} ${w - inset},${inset} ${w - inset},${h - inset} ${inset},${h - inset}`,
          )}
        </g>

        <path
          d={crown}
          className={`odo__outline odo__outline--${outline}`}
          style={outlineColor ? { stroke: outlineColor } : undefined}
        />

        {marks.map((m) => (
          <Glyph
            key={m.kind}
            kind={m.kind}
            color={m.color}
            s={w}
            rootTop={h}
            rootBottom={h + ROOT_LEN[type]}
          />
        ))}
      </g>
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
  condition,
  size = 18,
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
      width={size}
      height={size}
      viewBox={`0 0 ${S} ${S}`}
      aria-hidden="true"
      focusable="false"
    >
      <ConditionPatternDefs prefix={prefix} />
      <rect
        x={2}
        y={2}
        width={S - 4}
        height={S - 4}
        rx={3}
        className="odo__swatch-body"
        style={paint ?? undefined}
      />
      <rect
        x={2}
        y={2}
        width={S - 4}
        height={S - 4}
        rx={3}
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
          rootTop={S * 0.6}
          rootBottom={S - 3}
        />
      )}
    </svg>
  );
}
