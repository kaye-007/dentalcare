import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { FeatureKey } from '@dentalcare/shared';
import { featuresApi, type ClinicFeature } from './api';
import { useAuth } from './auth';

/**
 * Which modules this clinic has switched on, for hiding what it does not use.
 *
 * Like the permission list, this is presentation only. The API refuses a
 * route whose feature is off (FeatureGuard, 403 `feature_unavailable`), so a
 * stale answer here costs a clear error, never access.
 */
interface FeaturesState {
  features: ClinicFeature[] | null;
  enabled: (key: FeatureKey) => boolean;
  /** Re-read after a switch changes, so the navigation follows at once. */
  refresh: () => Promise<void>;
  replace: (next: ClinicFeature[]) => void;
}

const FeaturesContext = createContext<FeaturesState | undefined>(undefined);

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [features, setFeatures] = useState<ClinicFeature[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFeatures(await featuresApi.list());
    } catch {
      // A clinic whose API predates the catalogue simply has none of the new
      // modules; everything that existed before keeps working.
      setFeatures([]);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setFeatures(null);
      return;
    }
    void refresh();
  }, [user, refresh]);

  const enabled = useCallback(
    (key: FeatureKey) => features?.some((f) => f.key === key && f.state === 'enabled') ?? false,
    [features],
  );

  return (
    <FeaturesContext.Provider value={{ features, enabled, refresh, replace: setFeatures }}>
      {children}
    </FeaturesContext.Provider>
  );
}

export function useFeatures(): FeaturesState {
  const ctx = useContext(FeaturesContext);
  if (!ctx) throw new Error('useFeatures must be used within FeaturesProvider');
  return ctx;
}

/** Fired after anything changes the signed-in person's drawer, so the top bar follows. */
export const DRAWER_CHANGED_EVENT = 'dentalcare:drawer-changed';

export function announceDrawerChange(): void {
  window.dispatchEvent(new Event(DRAWER_CHANGED_EVENT));
}
