import {
  FEATURES,
  FEATURE_KEYS,
  isFeatureKey,
  resolveFeatures,
  type FeatureInputs,
} from './features';

const none: FeatureInputs = { plan: {}, overrides: {}, settings: {} };

describe('feature catalogue', () => {
  it('describes every key exactly once, under its own key', () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
    for (const key of FEATURE_KEYS) expect(FEATURES[key].key).toBe(key);
  });

  it('depends only on features that exist', () => {
    for (const key of FEATURE_KEYS) {
      for (const dep of FEATURES[key].dependsOn) expect(FEATURE_KEYS).toContain(dep);
    }
  });

  it('recognises keys and nothing else', () => {
    expect(isFeatureKey('cash_drawer')).toBe(true);
    for (const bad of ['Cash_drawer', 'commission', '', null, 3])
      expect(isFeatureKey(bad)).toBe(false);
  });
});

describe('resolveFeatures', () => {
  it('leaves a new desk module off until the clinic switches it on', () => {
    const r = resolveFeatures(none);
    expect(r.cash_drawer).toEqual({
      key: 'cash_drawer',
      state: 'disabled_by_clinic',
      entitledBy: 'default',
      missing: [],
    });
    expect(
      resolveFeatures({ ...none, settings: { cash_drawer: true } }).cash_drawer.state,
    ).toBe('enabled');
  });

  it('lets the plan withhold a feature the clinic switched on', () => {
    const r = resolveFeatures({
      plan: { cash_drawer: false },
      overrides: {},
      settings: { cash_drawer: true },
    });
    expect(r.cash_drawer.state).toBe('not_in_plan');
    expect(r.cash_drawer.entitledBy).toBe('plan');
  });

  it('lets an override win over the plan, in both directions', () => {
    const granted = resolveFeatures({
      plan: { cash_drawer: false },
      overrides: { cash_drawer: true },
      settings: { cash_drawer: true },
    });
    expect(granted.cash_drawer).toMatchObject({
      state: 'enabled',
      entitledBy: 'override',
    });

    const withheld = resolveFeatures({
      plan: { cash_drawer: true },
      overrides: { cash_drawer: false },
      settings: { cash_drawer: true },
    });
    expect(withheld.cash_drawer).toMatchObject({
      state: 'not_in_plan',
      entitledBy: 'override',
    });
  });

  it('never lets a plan or a clinic switch off a legal obligation', () => {
    const r = resolveFeatures({
      plan: { fiscalization: false },
      overrides: { fiscalization: false },
      settings: { fiscalization: false },
    });
    expect(r.fiscalization.state).toBe('enabled');
    expect(r.whatsapp_shortcuts.state).toBe('enabled');
  });

  it('resolves every catalogue key', () => {
    expect(Object.keys(resolveFeatures(none)).sort()).toEqual([...FEATURE_KEYS].sort());
  });
});
