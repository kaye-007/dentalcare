import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate } from 'react-router-dom';
import { api, setSessionExpiredHandler, token, type Admin } from './api';

/** Where a password sign-in lands: done, or at the second step. */
export type SignInStep =
  | { kind: 'done' }
  | { kind: 'verify'; challengeToken: string }
  | { kind: 'enroll'; challengeToken: string };

interface AuthState {
  admin: Admin | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<SignInStep>;
  completeSignIn: (tokens: {
    accessToken: string;
    refreshToken: string;
  }) => Promise<void>;
  /** Adopt a session minted by the Google callback. */
  adoptSession: (access: string, refresh?: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let off = false;
    (async () => {
      if (!token.get()) return setLoading(false);
      try {
        const me = await api.me();
        if (!off) setAdmin(me);
      } catch {
        token.clear();
      } finally {
        if (!off) setLoading(false);
      }
    })();
    return () => {
      off = true;
    };
  }, []);

  const adoptSession = useCallback(async (access: string, refresh?: string) => {
    token.set(access, refresh);
    try {
      setAdmin(await api.me());
    } catch (err) {
      token.clear();
      throw err;
    }
  }, []);

  const completeSignIn = useCallback(
    (tokens: { accessToken: string; refreshToken: string }) =>
      adoptSession(tokens.accessToken, tokens.refreshToken),
    [adoptSession],
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

  /** Signed out here first, then on the server, so a slow network cannot keep the screen signed in. */
  const logout = useCallback(() => {
    const refresh = token.refresh();
    token.clear();
    setAdmin(null);
    if (refresh) void api.logout(refresh).catch(() => undefined);
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => setAdmin(null));
    return () => setSessionExpiredHandler(null);
  }, []);

  const value = useMemo(
    () => ({ admin, loading, login, completeSignIn, adoptSession, logout }),
    [admin, loading, login, completeSignIn, adoptSession, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { admin, loading } = useAuth();
  if (loading) return <div className="boot">Loading…</div>;
  if (!admin) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
