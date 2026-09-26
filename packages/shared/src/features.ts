/**
 * The feature catalogue: every module a clinic can have switched on or off.
 *
 * ── Three separate questions ──────────────────────────────────────────────
 *
 * Whether a clinic can use a feature is decided by three inputs that change
 * for different reasons, and are stored apart so one never impersonates
 * another (migration 0013):
 *
 *   entitled   what the clinic's plan grants, or an override NODE X set for
 *              a pilot or a custom deal. Commercial.
 *   enabled    what the clinic itself has switched on. A clinic entitled to
 *              the cash drawer may still not want one.
 *   depends    another feature this one cannot work without.
 *
 * The API resolves the three into one state (core/entitlements) and refuses a
 * gated route unless that state is `enabled`. This file is the catalogue both
 * sides agree on — the keys, what each one is called, and the defaults.
 *
 * ── Only what exists ──────────────────────────────────────────────────────
 *
 * A feature is added here when it is built, not when it is planned. A
 * catalogue listing modules that do not exist would render as a settings page
 * full of switches that do nothing.
 *
 * ── Defaults ──────────────────────────────────────────────────────────────
 *
 * `defaultEntitled` applies while no plan names the feature. It is `true` for
 * every feature today, because no plan has entitlements yet and taking a
 * built module away from a clinic that already has it would be a regression
 * nobody asked for. `defaultEnabled` is what a clinic gets before it touches
 * the switch: on for what clinics already had before the catalogue existed,
 * off for a new module that changes how the desk works.
 */

export const FEATURE_KEYS = ['fiscalization', 'whatsapp_shortcuts', 'cash_drawer'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_GROUPS = ['front_desk', 'clinical', 'growth', 'team', 'finance'] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

export interface FeatureDefinition {
  key: FeatureKey;
  name: string;
  /** One sentence: what the clinic gets. Shown on the Features page. */
  description: string;
  group: FeatureGroup;
  defaultEntitled: boolean;
  defaultEnabled: boolean;
  dependsOn: readonly FeatureKey[];
  /**
   * A legal obligation or a free channel. The clinic cannot switch it off from
   * the Features page, and no plan may withhold it.
   */
  alwaysOn: boolean;
}

export const FEATURES: Readonly<Record<FeatureKey, FeatureDefinition>> = Object.freeze({
  fiscalization: {
    key: 'fiscalization',
    name: 'Fiscal invoices',
    description: 'Register invoices with the tax authority and print the NSLF, NIVF and QR code.',
    group: 'finance',
    defaultEntitled: true,
    defaultEnabled: true,
    dependsOn: [],
    alwaysOn: true,
  },
  whatsapp_shortcuts: {
    key: 'whatsapp_shortcuts',
    name: 'WhatsApp shortcuts',
    description: 'Open WhatsApp with a reminder already written, from the appointment.',
    group: 'front_desk',
    defaultEntitled: true,
    defaultEnabled: true,
    dependsOn: [],
    alwaysOn: true,
  },
  cash_drawer: {
    key: 'cash_drawer',
    name: 'Cash drawer',
    description:
      'Each receptionist opens a drawer with a float, counts it at the end of the shift, and explains any difference.',
    group: 'front_desk',
    defaultEntitled: true,
    defaultEnabled: false,
    dependsOn: [],
    alwaysOn: false,
  },
});

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && (FEATURE_KEYS as readonly string[]).includes(value);
}

/**
 * The one state a feature is in for a clinic.
 *
 *   enabled             usable
 *   disabled_by_clinic  entitled, switched off by the clinic
 *   not_in_plan         the plan (or an override) withholds it
 *   blocked             a feature it depends on is not enabled
 */
export const FEATURE_STATES = ['enabled', 'disabled_by_clinic', 'not_in_plan', 'blocked'] as const;
export type FeatureState = (typeof FEATURE_STATES)[number];

export interface ResolvedFeature {
  key: FeatureKey;
  state: FeatureState;
  /** Where the entitlement came from, for the admin console and support. */
  entitledBy: 'override' | 'plan' | 'default';
  /** Dependencies that are not enabled; empty unless `blocked`. */
  missing: FeatureKey[];
}

export interface FeatureInputs {
  /** The plan's value for each feature it names. Absent = the plan is silent. */
  plan: Partial<Record<FeatureKey, boolean>>;
  /** Active (unexpired, unrevoked) overrides. They win over the plan. */
  overrides: Partial<Record<FeatureKey, boolean>>;
  /** The clinic's own switches. Absent = the feature's default. */
  settings: Partial<Record<FeatureKey, boolean>>;
}

/**
 * Resolve every feature for one clinic. Pure, so the precedence is a truth
 * table under test rather than a query nobody can read.
 *
 * Precedence: override, then plan, then the catalogue default. An `alwaysOn`
 * feature ignores all three — a plan cannot withhold fiscalization and a
 * clinic cannot switch it off.
 */
export function resolveFeatures(inputs: FeatureInputs): Record<FeatureKey, ResolvedFeature> {
  const out = {} as Record<FeatureKey, ResolvedFeature>;

  const resolveOne = (key: FeatureKey, seen: Set<FeatureKey>): ResolvedFeature => {
    const done = out[key];
    if (done) return done;
    const def = FEATURES[key];

    if (def.alwaysOn) {
      return (out[key] = { key, state: 'enabled', entitledBy: 'default', missing: [] });
    }

    let entitledBy: ResolvedFeature['entitledBy'] = 'default';
    let entitled = def.defaultEntitled;
    if (inputs.plan[key] !== undefined) {
      entitled = inputs.plan[key]!;
      entitledBy = 'plan';
    }
    if (inputs.overrides[key] !== undefined) {
      entitled = inputs.overrides[key]!;
      entitledBy = 'override';
    }
    if (!entitled) {
      return (out[key] = { key, state: 'not_in_plan', entitledBy, missing: [] });
    }

    // A dependency cycle is a catalogue bug; treat the back-edge as missing
    // rather than recursing forever.
    const next = new Set(seen).add(key);
    const missing = def.dependsOn.filter(
      (d) => next.has(d) || resolveOne(d, next).state !== 'enabled',
    );
    if (missing.length) {
      return (out[key] = { key, state: 'blocked', entitledBy, missing });
    }

    const on = inputs.settings[key] ?? def.defaultEnabled;
    return (out[key] = { key, state: on ? 'enabled' : 'disabled_by_clinic', entitledBy, missing: [] });
  };

  for (const key of FEATURE_KEYS) resolveOne(key, new Set());
  return out;
}
