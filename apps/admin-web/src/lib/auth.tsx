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
import { api, token, type Admin } from './api';

interface AuthState {
  admin: Admin | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Adopt a session minted by the Google callback. */
  adoptSession: (access: string) => Promise<void>;
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

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    token.set(res.accessToken);
    setAdmin(res.admin);
  }, []);

  const adoptSession = useCallback(async (access: string) => {
    token.set(access);
    try {
      setAdmin(await api.me());
    } catch (err) {
      token.clear();
      throw err;
    }
  }, []);

  const logout = useCallback(() => {
    token.clear();
    setAdmin(null);
  }, []);

  const value = useMemo(
    () => ({ admin, loading, login, adoptSession, logout }),
    [admin, loading, login, adoptSession, logout],
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
