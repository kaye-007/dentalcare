import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  api,
  setSessionExpiredHandler,
  tokenStore,
  type AuthUser,
} from './api';
import { roleCan, type Permission } from './permissions';
import { setCurrency } from './format';
import { setClinicZone } from './clinic-time';

/**
 * Where a password sign-in lands: done, or at a second factor. The challenge
 * token proves the password and nothing else, so it lives in component state
 * for the next step and is never stored.
 */
export type SignInStep =
  | { kind: 'done' }
  | { kind: 'verify'; challengeToken: string }
  | { kind: 'enroll'; challengeToken: string };

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<SignInStep>;
  /** Store tokens the API issued at the end of a sign-in, and load the user. */
  completeSignIn: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  /**
   * Adopt a session minted elsewhere — today, the Google callback. Re-reads
   * /auth/me rather than trusting a decoded token, so the client's view of the
   * user comes from the same endpoint a password login uses.
   */
  adoptSession: (access: string, refresh?: string) => Promise<void>;
  /** Re-read /auth/me — after enrolling a second factor, say. */
  refreshUser: () => Promise<void>;
  logout: () => void;
  /**
   * Does the signed-in user hold this permission? Prefers the list the API
   * sent; falls back to the local matrix if an older session predates it.
   * Hides UI only — the API enforces the same rule on every route.
   */
  can: (permission: Permission) => boolean;
  /**
   * The clinic's trial has ended: reads still work, writes will not. Kept
   * beside `can` because callers need both to decide whether to show a
   * control — permission says "may you", this says "may anyone, right now".
   */
  readOnly: boolean;
  trialEndsAt: string | null;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      if (!tokenStore.access) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.me();
        if (!cancelled) setUser(me);
      } catch {
        tokenStore.clear();
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const completeSignIn = useCallback(
    async (tokens: { accessToken: string; refreshToken: string }) => {
      tokenStore.set(tokens.accessToken, tokens.refreshToken);
      try {
        setUser(await api.me());
      } catch (err) {
        tokenStore.clear();
        throw err;
      }
    },
    [],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<SignInStep> => {
      const res = await api.login(email, password);
      if (res.status === 'authenticated') {
        await completeSignIn(res);
        return { kind: 'done' };
      }
      return res.status === 'mfa_required'
        ? { kind: 'verify', challengeToken: res.challengeToken }
        : { kind: 'enroll', challengeToken: res.challengeToken };
    },
    [completeSignIn],
  );

  const adoptSession = useCallback(async (access: string, refresh?: string) => {
    tokenStore.set(access, refresh);
    try {
      setUser(await api.me());
    } catch (err) {
      tokenStore.clear();
      throw err;
    }
  }, []);

  const refreshUser = useCallback(async () => {
    setUser(await api.me());
  }, []);

  /**
   * Sign out here AND on the server. The local tokens go first, so the screen
   * is signed out even if the network is not; the revocation then ends the
   * session for anyone who copied the refresh token.
   */
  const logout = useCallback(() => {
    const refresh = tokenStore.refresh;
    tokenStore.clear();
    setUser(null);
    if (refresh) void api.logout(refresh).catch(() => undefined);
  }, []);

  // When a refresh fails the tokens are already gone; drop the user so the
  // router sends them to /login instead of leaving a shell with dead data.
  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null));
    return () => setSessionExpiredHandler(null);
  }, []);

  // Amounts arrive in the clinic's currency. Applied during render rather than
  // in an effect: an effect runs after the first paint, and every price on
  // that first screen would flash in euros before correcting itself. Setting
  // a module value to the same code twice is harmless.
  if (user?.currency) setCurrency(user.currency);
  // Likewise the clock: appointments are shown and booked in the clinic's zone.
  if (user?.timezone) setClinicZone(user.timezone);

  const granted = useMemo(
    () => (user?.permissions?.length ? new Set(user.permissions) : null),
    [user],
  );

  const can = useCallback(
    (permission: Permission) =>
      granted ? granted.has(permission) : roleCan(user?.role, permission),
    [granted, user],
  );

  // A session minted before the trial work has no `trial` block. Treating a
  // missing value as unrestricted is the right default here: the API refuses
  // the write regardless, so the worst case is a button that returns 402
  // rather than a paying clinic locked out by a stale token.
  const readOnly = user?.trial?.readOnly ?? false;
  const trialEndsAt = user?.trial?.endsAt ?? null;

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      completeSignIn,
      adoptSession,
      refreshUser,
      logout,
      can,
      readOnly,
      trialEndsAt,
    }),
    [user, loading, login, completeSignIn, adoptSession, refreshUser, logout, can, readOnly, trialEndsAt],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="boot">Loading…</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}
