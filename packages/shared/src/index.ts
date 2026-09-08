/**
 * Contracts both planes must agree on.
 *
 * The rule for this package is narrow on purpose: a module belongs here only
 * because it is genuinely imported by two packages and disagreement between
 * them would be a defect. It is not a utilities bin. Nothing lands here
 * speculatively, and nothing lands here that only one app uses.
 *
 * ── Why every name is listed ──────────────────────────────────────────────
 *
 * `export * from './tooth-notation'` would be shorter and does not work. tsc
 * compiles it to `__exportStar(require(...))`, which Rollup cannot see
 * through, so the clinic SPA failed to build with "archesFor is not exported
 * by dist/index.js" — a runtime-shaped error produced at bundle time.
 *
 * Listing the names is also the honest version: this is the package's public
 * surface, and a barrel that re-exports whatever happens to be in a file is
 * just a longer import path.
 */
export {
  // dentition
  ALL_TEETH,
  PERMANENT_LOWER,
  PERMANENT_TEETH,
  PERMANENT_UPPER,
  PRIMARY_LOWER,
  PRIMARY_TEETH,
  PRIMARY_UPPER,
  QUADRANT_LABELS,
  archesFor,
  dentitionOf,
  isAnterior,
  isLower,
  isPosterior,
  isPrimary,
  isUpper,
  isValidTooth,
  positionOf,
  quadrantOf,
  toothType,
  type Dentition,
  type ToothType,
  // surfaces
  SURFACES,
  isValidSurface,
  surfaceName,
  surfacesFor,
  type Surface,
  type SurfaceOrWhole,
  // notation
  formatTooth,
  fromUniversal,
  toUniversal,
  toothLabel,
  type Notation,
  // conditions
  ABSENT_CONDITIONS,
  CONDITION_LABELS,
  TOOTH_CONDITIONS,
  WHOLE_TOOTH_CONDITIONS,
  isAbsent,
  isCondition,
  isWholeToothCondition,
  type ToothCondition,
} from './tooth-notation';

export {
  ADMIN_ONLY,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  can,
  canAll,
  isRole,
  normalizeRole,
  permissionsFor,
  type Permission,
  type Role,
} from './permissions';

export {
  DOCUMENT_KINDS,
  PERIO_SITES,
  type DocumentKind,
  type PerioSite,
  type WorkingDay,
} from './api-types';
