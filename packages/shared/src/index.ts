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

export {
  CURRENCIES,
  CURRENCY_NAMES,
  MINOR_UNITS,
  MONEY_LOCALE,
  currencySymbol,
  formatMoney,
  isCurrency,
  moneyInputValue,
  parseMoney,
  type CurrencyCode,
} from './money';

export {
  REMINDER_CHANNELS,
  REMINDER_CHANNEL_NAMES,
  REMINDER_HOURS_OPTIONS,
  REMINDER_LOCALES,
  REMINDER_LOCALE_NAMES,
  REMINDER_PLACEHOLDERS,
  defaultReminderTemplate,
  formatAppointmentTime,
  isReminderChannel,
  isReminderLocale,
  isTimeZone,
  renderReminder,
  smsSegments,
  toE164,
  unknownPlaceholders,
  type ReminderChannelId,
  type ReminderHours,
  type ReminderLocale,
  type ReminderPlaceholder,
  type ReminderValues,
} from './reminders';

export { detectDelimiter, parseCsv, type CsvDelimiter } from './csv';

export {
  IMPORT_BATCH_LIMIT,
  IMPORT_DATE_FORMATS,
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  duplicatesWithinFile,
  guessMapping,
  normalizeImportRow,
  normalizeNationalId,
  parseImportDate,
  type ImportDateFormat,
  type ImportField,
  type ImportIssue,
  type ImportedPatient,
  type RawImportRow,
} from './patient-import';

export {
  ALBANIA_STANDARD_VAT_BP,
  VAT_CATEGORIES,
  formatRate,
  isVatCategory,
  vatCategoryLabel,
  vatCategoryOf,
  vatRateFor,
  vatSummary,
  type VatCategory,
  type VatGroup,
  type VatLine,
} from './vat';

export {
  FEATURES,
  FEATURE_GROUPS,
  FEATURE_KEYS,
  FEATURE_STATES,
  isFeatureKey,
  resolveFeatures,
  type FeatureDefinition,
  type FeatureGroup,
  type FeatureInputs,
  type FeatureKey,
  type FeatureState,
  type ResolvedFeature,
} from './features';

export {
  DEFAULT_VARIANCE_THRESHOLDS,
  DRAWER_DENOMINATIONS,
  DRAWER_EVENT_SIGN,
  DRAWER_EVENT_TYPES,
  VARIANCE_BANDS,
  VARIANCE_NOTE_MIN_LENGTH,
  countTotal,
  expectedCash,
  varianceBand,
  type DenominationCount,
  type DrawerEventLike,
  type DrawerEventType,
  type VarianceBand,
  type VarianceThresholds,
} from './cash-drawer';

export {
  MESSAGE_PLACEHOLDERS,
  MESSAGE_PURPOSES,
  MESSAGE_PURPOSE_KEYS,
  MESSAGE_PURPOSE_NAMES,
  WHATSAPP_VARIABLES,
  defaultMessageTemplate,
  isMessagePurpose,
  renderMessage,
  whatsappVariables,
  type MessagePurpose,
  type MessageValues,
} from './messages';
