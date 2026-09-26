import { createContext, useContext, useEffect } from 'react';

/**
 * What the shell offers the page inside it: the two dialogs that can be
 * opened from anywhere, the breadcrumb, and a counter that ticks when a
 * clinic is created so a list on screen knows to load again.
 */
export interface Shell {
  openCreate: (demo?: boolean) => void;
  openPalette: () => void;
  setCrumb: (label: string | null) => void;
  /** Re-read the sidebar's counts after something changed them. */
  refreshBadges: () => void;
  /** Increments whenever a clinic is created. */
  version: number;
}

export const ShellCtx = createContext<Shell | null>(null);

export function useShell(): Shell {
  const s = useContext(ShellCtx);
  if (!s) throw new Error('useShell outside Layout');
  return s;
}

/** Name the current record in the breadcrumb, for as long as it is on screen. */
export function useCrumb(label: string | null | undefined) {
  const { setCrumb } = useShell();
  useEffect(() => {
    setCrumb(label ?? null);
    return () => setCrumb(null);
  }, [label, setCrumb]);
}
