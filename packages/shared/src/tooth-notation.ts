/**
 * Tooth notation and surface anatomy — the single source of truth.
 *
 * FDI (ISO 3950) is canonical everywhere in this system: database, API, and
 * every internal calculation. Universal numbering exists purely as a
 * presentation layer for clinicians trained in the US convention, and is
 * converted at the edge. Storing two notations would mean two things to keep
 * in step, and the one that drifted would be the one someone treated from.
 *
 * ── Why this file is here rather than in apps/api ─────────────────────────
 *
 * It existed three times: `apps/api/.../charting/tooth-notation.ts`,
 * `apps/tenant-web/src/lib/tooth-notation.ts`, and a third copy of the
 * surface and condition constants inside `apps/tenant-web/src/lib/api.ts`.
 * The client copy carried a header saying "keep in step with the API — the
 * API is authoritative and rejects anything this file gets wrong", which is
 * an accurate description of how the drift would be discovered: by a
 * clinician, at the chair, being told their charting was invalid.
 *
 * They had in fact drifted, in two places. Both are reconciled here, and the
 * reasoning is recorded because the resolution is a clinical decision:
 *
 *   toothType()   The API decided "is this primary?" by membership of the
 *                 twenty real primary teeth; the client decided it by
 *                 `quadrant >= 5`. For every tooth that exists the two agree.
 *                 They part only on numbers that are not teeth — 94 is
 *                 "premolar" by one and "molar" by the other. The membership
 *                 test is kept: a function about anatomy should answer from
 *                 anatomy, and a value that is not a tooth has no type.
 *
 *   toothLabel()  The API always rendered FDI and said "Unknown" for an
 *                 unrecognised quadrant; the client rendered whichever
 *                 notation the clinician had selected and said "" — which
 *                 produces a label beginning with a stray separator. The
 *                 client's signature is kept, because rendering the notation
 *                 the reader chose is the point of having notations, and the
 *                 API's "Unknown" is kept, because a label that silently
 *                 loses its quadrant is worse than one that admits it.
 *                 `notation` defaults to 'fdi', so existing API callers are
 *                 unchanged.
 *
 * Pure data and pure functions: no Nest, no database, no React. Every claim
 * below is covered in tooth-notation.spec.ts, because a numbering bug here
 * would mean charting the wrong tooth.
 */

/* ══════════════════════ dentition ══════════════════════ */

export type Dentition = 'permanent' | 'primary';

/**
 * FDI permanent teeth, quadrants 1–4, eight teeth each, each arch written
 * right to left as the clinician faces the patient — which is also the order
 * the odontogram draws them in.
 */
export const PERMANENT_UPPER: readonly number[] = Object.freeze([
  18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
]);
export const PERMANENT_LOWER: readonly number[] = Object.freeze([
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
]);

/** FDI primary teeth, quadrants 5–8, five teeth each. */
export const PRIMARY_UPPER: readonly number[] = Object.freeze([
  55, 54, 53, 52, 51, 61, 62, 63, 64, 65,
]);
export const PRIMARY_LOWER: readonly number[] = Object.freeze([
  85, 84, 83, 82, 81, 71, 72, 73, 74, 75,
]);

/**
 * The flat sets the API validates against, derived from the arches above
 * rather than written out a second time. Two lists of the same teeth in
 * different orders is exactly the shape that drifts.
 */
export const PERMANENT_TEETH: readonly number[] = Object.freeze([
  ...PERMANENT_UPPER,
  ...PERMANENT_LOWER,
]);
export const PRIMARY_TEETH: readonly number[] = Object.freeze([
  ...PRIMARY_UPPER,
  ...PRIMARY_LOWER,
]);
export const ALL_TEETH: readonly number[] = Object.freeze([
  ...PERMANENT_TEETH,
  ...PRIMARY_TEETH,
]);

/** The two arches of one dentition, for anything that draws a chart. */
export function archesFor(dentition: Dentition): {
  upper: readonly number[];
  lower: readonly number[];
} {
  return dentition === 'primary'
    ? { upper: PRIMARY_UPPER, lower: PRIMARY_LOWER }
    : { upper: PERMANENT_UPPER, lower: PERMANENT_LOWER };
}

export function isValidTooth(fdi: number): boolean {
  return ALL_TEETH.includes(fdi);
}

export function dentitionOf(fdi: number): Dentition | null {
  if (PERMANENT_TEETH.includes(fdi)) return 'permanent';
  if (PRIMARY_TEETH.includes(fdi)) return 'primary';
  return null;
}

/** FDI quadrant digit: 1–4 permanent, 5–8 primary. */
export function quadrantOf(fdi: number): number {
  return Math.floor(fdi / 10);
}

/** Position within the quadrant: 1 = central incisor … 8 = third molar. */
export function positionOf(fdi: number): number {
  return fdi % 10;
}

export function isUpper(fdi: number): boolean {
  const q = quadrantOf(fdi);
  return q === 1 || q === 2 || q === 5 || q === 6;
}

export function isLower(fdi: number): boolean {
  return !isUpper(fdi);
}

/** True for the twenty primary teeth, and for nothing else. */
export function isPrimary(fdi: number): boolean {
  return dentitionOf(fdi) === 'primary';
}

/**
 * Anterior = incisors and canines (positions 1–3). These have an incisal edge
 * rather than an occlusal table, which is what decides the valid surface set.
 */
export function isAnterior(fdi: number): boolean {
  return positionOf(fdi) <= 3;
}

export function isPosterior(fdi: number): boolean {
  return !isAnterior(fdi);
}

export type ToothType = 'incisor' | 'canine' | 'premolar' | 'molar';

export function toothType(fdi: number): ToothType {
  const p = positionOf(fdi);
  if (p <= 2) return 'incisor';
  if (p === 3) return 'canine';
  // Primary dentition has no premolars: positions 4 and 5 are molars.
  if (isPrimary(fdi)) return 'molar';
  return p <= 5 ? 'premolar' : 'molar';
}

export const QUADRANT_LABELS: Readonly<Record<number, string>> = Object.freeze({
  1: 'Upper right',
  2: 'Upper left',
  3: 'Lower left',
  4: 'Lower right',
  5: 'Upper right',
  6: 'Upper left',
  7: 'Lower left',
  8: 'Lower right',
});

/* ══════════════════════ surfaces ══════════════════════ */

/**
 * Six canonical surface codes. F and L are stored as orientation-neutral
 * codes and RENDERED with the clinically correct word: F is labial on
 * anteriors and buccal on posteriors; L is palatal on upper teeth and lingual
 * on lower. Storing the rendered word instead would make "buccal" and
 * "labial" two different surfaces to query.
 */
export const SURFACES = ['M', 'D', 'O', 'I', 'F', 'L'] as const;
export type Surface = (typeof SURFACES)[number];

/** Whole-tooth findings (an extraction, an implant) carry no surface. */
export type SurfaceOrWhole = Surface | null;

const ANTERIOR_SURFACES: readonly Surface[] = Object.freeze(['M', 'D', 'I', 'F', 'L']);
const POSTERIOR_SURFACES: readonly Surface[] = Object.freeze(['M', 'D', 'O', 'F', 'L']);

/**
 * Surfaces that exist on this tooth. Occlusal and incisal are mutually
 * exclusive: a molar has no incisal edge and an incisor has no occlusal table.
 */
export function surfacesFor(fdi: number): readonly Surface[] {
  return isAnterior(fdi) ? ANTERIOR_SURFACES : POSTERIOR_SURFACES;
}

export function isValidSurface(fdi: number, surface: Surface): boolean {
  return surfacesFor(fdi).includes(surface);
}

/** Clinically correct surface name for this specific tooth. */
export function surfaceName(fdi: number, surface: Surface): string {
  switch (surface) {
    case 'M':
      return 'Mesial';
    case 'D':
      return 'Distal';
    case 'O':
      return 'Occlusal';
    case 'I':
      return 'Incisal';
    case 'F':
      return isAnterior(fdi) ? 'Labial' : 'Buccal';
    case 'L':
      return isUpper(fdi) ? 'Palatal' : 'Lingual';
  }
}

/* ══════════════════════ Universal numbering ══════════════════════ */

/**
 * Universal permanent: #1 is the upper-right third molar, running left across
 * the upper arch to #16, then down to #17 at the lower-left third molar and
 * back right to #32.
 */
const FDI_TO_UNIVERSAL: Readonly<Record<number, number>> = Object.freeze({
  18: 1,
  17: 2,
  16: 3,
  15: 4,
  14: 5,
  13: 6,
  12: 7,
  11: 8,
  21: 9,
  22: 10,
  23: 11,
  24: 12,
  25: 13,
  26: 14,
  27: 15,
  28: 16,
  38: 17,
  37: 18,
  36: 19,
  35: 20,
  34: 21,
  33: 22,
  32: 23,
  31: 24,
  41: 25,
  42: 26,
  43: 27,
  44: 28,
  45: 29,
  46: 30,
  47: 31,
  48: 32,
});

/**
 * Universal primary uses letters A–T on the same path: A at the upper-right
 * second primary molar through J, then K at the lower-left second primary
 * molar through T.
 */
const FDI_TO_UNIVERSAL_LETTER: Readonly<Record<number, string>> = Object.freeze({
  55: 'A',
  54: 'B',
  53: 'C',
  52: 'D',
  51: 'E',
  61: 'F',
  62: 'G',
  63: 'H',
  64: 'I',
  65: 'J',
  75: 'K',
  74: 'L',
  73: 'M',
  72: 'N',
  71: 'O',
  81: 'P',
  82: 'Q',
  83: 'R',
  84: 'S',
  85: 'T',
});

const UNIVERSAL_TO_FDI: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries([
    ...Object.entries(FDI_TO_UNIVERSAL).map(([fdi, u]) => [String(u), Number(fdi)]),
    ...Object.entries(FDI_TO_UNIVERSAL_LETTER).map(([fdi, l]) => [l, Number(fdi)]),
  ]),
);

/** Universal label for an FDI tooth: "5" for permanent 14, "C" for primary 53. */
export function toUniversal(fdi: number): string | null {
  const n = FDI_TO_UNIVERSAL[fdi];
  if (n !== undefined) return String(n);
  return FDI_TO_UNIVERSAL_LETTER[fdi] ?? null;
}

/** Parse a Universal label back to FDI. Accepts "14", " 14 ", "c", "C". */
export function fromUniversal(label: string): number | null {
  const key = label.trim().toUpperCase();
  return UNIVERSAL_TO_FDI[key] ?? null;
}

export type Notation = 'fdi' | 'universal';

/** Render a tooth in the requested notation, falling back to FDI. */
export function formatTooth(fdi: number, notation: Notation): string {
  if (notation === 'universal') return toUniversal(fdi) ?? String(fdi);
  return String(fdi);
}

/**
 * A human-readable label: "Upper right · tooth 14".
 *
 * `notation` defaults to FDI, which is what the API used before this file
 * existed. An unrecognised quadrant reads "Unknown" rather than collapsing to
 * an empty string — see the reconciliation note at the top.
 */
export function toothLabel(fdi: number, notation: Notation = 'fdi'): string {
  const quadrant = QUADRANT_LABELS[quadrantOf(fdi)] ?? 'Unknown';
  const kind = isPrimary(fdi) ? ' (primary)' : '';
  return `${quadrant} · tooth ${formatTooth(fdi, notation)}${kind}`;
}

/* ══════════════════════ conditions ══════════════════════ */

/**
 * Clinical findings. Typed rather than free text so the chart can be queried
 * and coloured consistently — "which patients have untreated caries" is a
 * question a clinic asks, and free text cannot answer it.
 */
export const TOOTH_CONDITIONS = [
  'caries',
  'restored',
  'crown',
  'bridge',
  'veneer',
  'root_canal',
  'implant',
  'extracted',
  'missing',
  'impacted',
  'fractured',
  'sealant',
  'watch',
] as const;

export type ToothCondition = (typeof TOOTH_CONDITIONS)[number];

export const CONDITION_LABELS: Readonly<Record<ToothCondition, string>> = Object.freeze({
  caries: 'Caries',
  restored: 'Restored / filling',
  crown: 'Crown',
  bridge: 'Bridge',
  veneer: 'Veneer',
  root_canal: 'Root canal',
  implant: 'Implant',
  extracted: 'Extracted',
  missing: 'Missing',
  impacted: 'Impacted',
  fractured: 'Fractured',
  sealant: 'Sealant',
  watch: 'Watch',
});

/**
 * Conditions that describe the whole tooth rather than one surface. Recording
 * an extraction on the mesial surface is meaningless, so the API rejects it.
 */
export const WHOLE_TOOTH_CONDITIONS: readonly ToothCondition[] = Object.freeze([
  'extracted',
  'missing',
  'implant',
  'impacted',
  'crown',
  'bridge',
  'root_canal',
]);

export function isWholeToothCondition(c: ToothCondition): boolean {
  return WHOLE_TOOTH_CONDITIONS.includes(c);
}

export function isCondition(value: unknown): value is ToothCondition {
  return (
    typeof value === 'string' && (TOOTH_CONDITIONS as readonly string[]).includes(value)
  );
}

/**
 * A tooth that is no longer present cannot also carry surface findings.
 * Used to reject charting caries on an extracted tooth.
 */
export const ABSENT_CONDITIONS: readonly ToothCondition[] = Object.freeze([
  'extracted',
  'missing',
]);

export function isAbsent(c: ToothCondition): boolean {
  return ABSENT_CONDITIONS.includes(c);
}
