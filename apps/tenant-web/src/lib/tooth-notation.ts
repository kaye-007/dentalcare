/**
 * Client mirror of the API's tooth notation.
 *
 * FDI is canonical here too; Universal is a display choice the clinician makes
 * and is converted only at render time. Keep in step with
 * apps/api/src/tenant/charting/tooth-notation.ts — the API is authoritative and
 * rejects anything this file gets wrong.
 */

export type Dentition = 'permanent' | 'primary';
export type Notation = 'fdi' | 'universal';

export const PERMANENT_UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
export const PERMANENT_LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
export const PRIMARY_UPPER = [55, 54, 53, 52, 51, 61, 62, 63, 64, 65];
export const PRIMARY_LOWER = [85, 84, 83, 82, 81, 71, 72, 73, 74, 75];

export function archesFor(d: Dentition): { upper: number[]; lower: number[] } {
  return d === 'primary'
    ? { upper: PRIMARY_UPPER, lower: PRIMARY_LOWER }
    : { upper: PERMANENT_UPPER, lower: PERMANENT_LOWER };
}

export const quadrantOf = (fdi: number) => Math.floor(fdi / 10);
export const positionOf = (fdi: number) => fdi % 10;
export const isUpper = (fdi: number) => [1, 2, 5, 6].includes(quadrantOf(fdi));
export const isAnterior = (fdi: number) => positionOf(fdi) <= 3;
export const isPrimary = (fdi: number) => quadrantOf(fdi) >= 5;

export type ToothType = 'incisor' | 'canine' | 'premolar' | 'molar';

export function toothType(fdi: number): ToothType {
  const p = positionOf(fdi);
  if (p <= 2) return 'incisor';
  if (p === 3) return 'canine';
  // Primary dentition has no premolars.
  if (isPrimary(fdi)) return 'molar';
  return p <= 5 ? 'premolar' : 'molar';
}

export const SURFACES = ['M', 'D', 'O', 'I', 'F', 'L'] as const;
export type Surface = (typeof SURFACES)[number];

const ANTERIOR: Surface[] = ['M', 'D', 'I', 'F', 'L'];
const POSTERIOR: Surface[] = ['M', 'D', 'O', 'F', 'L'];

export function surfacesFor(fdi: number): Surface[] {
  return isAnterior(fdi) ? ANTERIOR : POSTERIOR;
}

/** Clinically correct name for this surface on this specific tooth. */
export function surfaceName(fdi: number, s: Surface): string {
  switch (s) {
    case 'M': return 'Mesial';
    case 'D': return 'Distal';
    case 'O': return 'Occlusal';
    case 'I': return 'Incisal';
    case 'F': return isAnterior(fdi) ? 'Labial' : 'Buccal';
    case 'L': return isUpper(fdi) ? 'Palatal' : 'Lingual';
  }
}

const TO_UNIVERSAL: Record<number, string> = {
  18: '1', 17: '2', 16: '3', 15: '4', 14: '5', 13: '6', 12: '7', 11: '8',
  21: '9', 22: '10', 23: '11', 24: '12', 25: '13', 26: '14', 27: '15', 28: '16',
  38: '17', 37: '18', 36: '19', 35: '20', 34: '21', 33: '22', 32: '23', 31: '24',
  41: '25', 42: '26', 43: '27', 44: '28', 45: '29', 46: '30', 47: '31', 48: '32',
  55: 'A', 54: 'B', 53: 'C', 52: 'D', 51: 'E',
  61: 'F', 62: 'G', 63: 'H', 64: 'I', 65: 'J',
  75: 'K', 74: 'L', 73: 'M', 72: 'N', 71: 'O',
  81: 'P', 82: 'Q', 83: 'R', 84: 'S', 85: 'T',
};

export function formatTooth(fdi: number, notation: Notation): string {
  return notation === 'universal' ? TO_UNIVERSAL[fdi] ?? String(fdi) : String(fdi);
}

export const QUADRANT_LABELS: Record<number, string> = {
  1: 'Upper right', 2: 'Upper left', 3: 'Lower left', 4: 'Lower right',
  5: 'Upper right', 6: 'Upper left', 7: 'Lower left', 8: 'Lower right',
};

export function toothLabel(fdi: number, notation: Notation = 'fdi'): string {
  const q = QUADRANT_LABELS[quadrantOf(fdi)] ?? '';
  const n = formatTooth(fdi, notation);
  return `${q} · tooth ${n}${isPrimary(fdi) ? ' (primary)' : ''}`;
}

/* ══════════════════════ condition encoding ══════════════════════
 *
 * Thirteen clinical conditions cannot be told apart by hue. That is not a
 * matter of taste — it is arithmetic. Inside the lightness band where a mark
 * stays legible on white there is no set of thirteen colours that separates
 * under normal vision, let alone under protanopia or deuteranopia. The
 * previous table proved it the hard way: `crown` and `bridge` shared a hex
 * outright, `extracted` and `missing` shared another, `fractured` and
 * `watch` sat ΔE 5.0 apart for a clinician with perfect colour vision, and
 * `impacted` and `implant` were ΔE 1.1 apart under protanopia.
 *
 * So colour no longer carries the condition. Colour carries the FAMILY —
 * five values, validated pairwise — and the condition within a family is
 * carried by a second, non-colour channel:
 *
 *   surfaceFill   how an affected surface region is painted
 *   outline       how the tooth boundary is stroked
 *   glyph         a mark drawn over the tooth
 *
 * The invariant every change to this table must preserve: **no two
 * conditions may differ in colour alone.** Every pair differs in at least
 * one of the three channels above, so the chart survives a colour-blind
 * clinician, a bad monitor, and a black-and-white printout of a treatment
 * plan. Colour is the fast path; pattern is the guarantee.
 */

export type ConditionFamily = 'pathology' | 'restoration' | 'prosthetic' | 'absent';

/** How a surface region carrying this condition is painted. */
export type SurfaceFill = 'none' | 'solid' | 'hatch' | 'zigzag' | 'dots' | 'vlines' | 'dashed';

/** How the tooth boundary is stroked for a whole-tooth finding. */
export type ToothOutline = 'none' | 'solid' | 'thick' | 'dashed' | 'phantom';

/** A mark drawn over the tooth glyph. 'span' is drawn across teeth, not on one. */
export type ConditionGlyph = 'none' | 'fracture' | 'strike' | 'post' | 'endo' | 'angled' | 'span';

export interface ConditionStyle {
  family: ConditionFamily;
  color: string;
  surfaceFill: SurfaceFill;
  outline: ToothOutline;
  glyph: ConditionGlyph;
}

/**
 * The five family colours. Measured, not chosen — worst-case pairwise
 * separation across normal vision and all three dichromacies is recorded in
 * claude/ui-phase-c-odontogram.md. Every value clears 3:1 on white so it
 * works as a 1.8px stroke, not only as a fill.
 */
export const ENCODING_PALETTE = {
  crimson: '#b23b3b',   // active disease
  amber:   '#b5811f',   // monitor, not yet disease
  blue:    '#2f6fa8',   // existing restoration
  emerald: '#2e9e6b',   // fixed prosthetic
  grey:    '#6f767c',   // no functional tooth present
} as const;

/**
 * Dictionary keys, not text. The four families are drawn in the chart legend
 * and read out by screen readers, so they follow the interface language like
 * everything else on that screen.
 */
export const FAMILY_KEYS = {
  pathology: 'tooth.family.pathology',
  restoration: 'tooth.family.restoration',
  prosthetic: 'tooth.family.prosthetic',
  absent: 'tooth.family.absent',
} as const satisfies Record<ConditionFamily, string>;

export const ENCODED_CONDITIONS = [
  'caries', 'fractured', 'watch',
  'restored', 'sealant', 'veneer',
  'crown', 'bridge', 'implant', 'root_canal',
  'impacted', 'extracted', 'missing',
] as const;

export type EncodedCondition = (typeof ENCODED_CONDITIONS)[number];

const P = ENCODING_PALETTE;

export const CONDITION_STYLE: Readonly<Record<EncodedCondition, ConditionStyle>> = Object.freeze({
  /* ── active pathology ────────────────────────────────────────────────
     Caries is diagonal hatch; fracture is a zigzag fill plus a jagged line
     across the crown; watch is amber with a dashed perimeter and no solid
     fill, because a watch is an observation, not a lesion. Fractured and
     watch were the ΔE 5.0 pair — they now differ in hue, in fill texture
     and in whether a glyph is present. */
  caries:     { family: 'pathology',   color: P.crimson, surfaceFill: 'hatch',  outline: 'none',    glyph: 'none' },
  fractured:  { family: 'pathology',   color: P.crimson, surfaceFill: 'zigzag', outline: 'none',    glyph: 'fracture' },
  watch:      { family: 'pathology',   color: P.amber,   surfaceFill: 'dashed', outline: 'dashed',  glyph: 'none' },

  /* ── existing restorations ───────────────────────────────────────────
     One hue, three textures. Solid reads as the most substantial (a
     filling), dots as the thinnest (a sealant), vertical lines as a facing
     applied to one surface (a veneer). */
  restored:   { family: 'restoration', color: P.blue,    surfaceFill: 'solid',  outline: 'none',    glyph: 'none' },
  sealant:    { family: 'restoration', color: P.blue,    surfaceFill: 'dots',   outline: 'none',    glyph: 'none' },
  veneer:     { family: 'restoration', color: P.blue,    surfaceFill: 'vlines', outline: 'none',    glyph: 'none' },

  /* ── fixed prosthetics ───────────────────────────────────────────────
     All whole-tooth, so all carried by the outline plus a glyph. Crown is
     the boundary alone; bridge is the same boundary plus a connector bar
     drawn between adjacent bridged teeth — that bar is the whole point,
     because a bridge is a thing that spans and a crown is not. Implant
     gets a threaded post in the root; root canal gets a single fill line
     to the apex, which is how it is drawn on paper. */
  crown:      { family: 'prosthetic',  color: P.emerald, surfaceFill: 'none',   outline: 'thick',   glyph: 'none' },
  bridge:     { family: 'prosthetic',  color: P.emerald, surfaceFill: 'none',   outline: 'thick',   glyph: 'span' },
  implant:    { family: 'prosthetic',  color: P.emerald, surfaceFill: 'none',   outline: 'solid',   glyph: 'post' },
  root_canal: { family: 'prosthetic',  color: P.emerald, surfaceFill: 'none',   outline: 'solid',   glyph: 'endo' },

  /* ── absent or non-functional ────────────────────────────────────────
     Impacted is present but wrongly placed, so it keeps a dashed boundary
     and gains a tilted badge below the gum line. Extracted and missing are
     both phantom outlines; extracted adds the strike-through, because the
     clinical difference is whether this practice took it out. */
  impacted:   { family: 'absent',      color: P.grey,    surfaceFill: 'none',   outline: 'dashed',  glyph: 'angled' },
  extracted:  { family: 'absent',      color: P.grey,    surfaceFill: 'none',   outline: 'phantom', glyph: 'strike' },
  missing:    { family: 'absent',      color: P.grey,    surfaceFill: 'none',   outline: 'phantom', glyph: 'none' },
});

const FALLBACK_STYLE: ConditionStyle = {
  family: 'absent', color: P.grey, surfaceFill: 'none', outline: 'dashed', glyph: 'none',
};

/**
 * Style for a condition string. Falls back rather than throwing: an API that
 * has learned a new condition before this client has should render a visible
 * neutral mark, not crash the chart a clinician is mid-way through reading.
 */
export function conditionStyle(condition: string): ConditionStyle {
  return CONDITION_STYLE[condition as EncodedCondition] ?? FALLBACK_STYLE;
}

/**
 * Outline precedence when one tooth carries several whole-tooth findings —
 * crowned AND root-treated is ordinary, not an edge case. The boundary shows
 * the most consequential finding; the rest still draw their glyphs.
 */
export const OUTLINE_RANK: Record<ToothOutline, number> = {
  none: 0, solid: 1, dashed: 2, thick: 3, phantom: 4,
};

/** Findings the API rejects on a single surface. */
export const WHOLE_TOOTH_CONDITIONS = [
  'extracted', 'missing', 'implant', 'impacted', 'crown', 'bridge', 'root_canal',
];
