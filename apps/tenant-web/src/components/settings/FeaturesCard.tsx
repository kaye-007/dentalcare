import { useState } from 'react';
import { FEATURE_GROUPS, type FeatureGroup } from '@dentalcare/shared';
import { ApiError, featuresApi, type ClinicFeature } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFeatures } from '../../lib/features';
import { StatusPill } from '../ui';

const GROUP_LABEL: Record<FeatureGroup, string> = {
  front_desk: 'Front desk',
  clinical: 'Clinical',
  growth: 'Growth',
  team: 'Team',
  finance: 'Finance',
};

function stateOf(f: ClinicFeature): { kind: 'ok' | 'info' | 'warn' | 'danger' | 'neutral'; label: string } {
  if (f.alwaysOn) return { kind: 'ok', label: 'Always on' };
  switch (f.state) {
    case 'enabled':
      return { kind: 'ok', label: 'On' };
    case 'disabled_by_clinic':
      return { kind: 'neutral', label: 'Off' };
    case 'not_in_plan':
      return { kind: 'warn', label: 'Not in your plan' };
    case 'blocked':
      return { kind: 'warn', label: 'Needs another feature' };
  }
}

/**
 * Settings → Features: what the clinic has, and the switch for each module
 * its plan includes. Legal obligations have no switch.
 */
export default function FeaturesCard() {
  const { can } = useAuth();
  const { features, replace } = useFeatures();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mayChange = can('settings:manage');

  if (!features) return <p className="muted">Loading…</p>;

  async function toggle(f: ClinicFeature, on: boolean) {
    setBusyKey(f.key);
    setError(null);
    try {
      replace(await featuresApi.set(f.key, on));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that.');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <h2>Features</h2>
          <p className="card__sub">Modules this clinic can use. Turning one off keeps everything it recorded.</p>
        </div>
      </div>
      {error && <p className="formerror pad">{error}</p>}
      {FEATURE_GROUPS.map((group) => {
        const items = features.filter((f) => f.group === group);
        if (!items.length) return null;
        return (
          <div key={group} className="feature-group">
            <p className="nav__eyebrow pad-x">{GROUP_LABEL[group]}</p>
            <ul className="feature-list">
              {items.map((f) => {
                const st = stateOf(f);
                const switchable = mayChange && !f.alwaysOn && f.state !== 'not_in_plan';
                const on = f.state === 'enabled';
                return (
                  <li key={f.key} className="feature-row">
                    <div className="feature-row__text">
                      <span className="inline-row" style={{ gap: 8 }}>
                        <strong>{f.name}</strong>
                        <StatusPill status={st.kind} label={st.label} />
                      </span>
                      <span className="small muted">{f.description}</span>
                      {f.entitledBy === 'override' && f.overrideExpiresAt && (
                        <span className="small">
                          Trial access until {new Date(f.overrideExpiresAt).toLocaleDateString('en-GB')}
                        </span>
                      )}
                      {f.changedBy && f.changedAt && !f.alwaysOn && (
                        <span className="small muted">
                          Changed by {f.changedBy}, {new Date(f.changedAt).toLocaleDateString('en-GB')}
                        </span>
                      )}
                    </div>
                    {!f.alwaysOn && (
                      <label className="switch">
                        <input
                          type="checkbox"
                          role="switch"
                          checked={on}
                          disabled={!switchable || busyKey === f.key}
                          aria-label={`${f.name}: ${on ? 'on' : 'off'}`}
                          onChange={(e) => void toggle(f, e.target.checked)}
                        />
                        <span className="switch__track" aria-hidden />
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
