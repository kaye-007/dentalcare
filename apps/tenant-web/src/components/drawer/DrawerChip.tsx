import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Banknote } from 'lucide-react';
import { drawerApi, type DrawerSession } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DRAWER_CHANGED_EVENT, useFeatures } from '../../lib/features';
import { timeOf } from './drawer-text';

/**
 * The receptionist's drawer, always in view: closed, open since when, being
 * counted, or waiting for a manager. One tap goes to the drawer.
 */
export default function DrawerChip() {
  const { can } = useAuth();
  const { enabled } = useFeatures();
  const location = useLocation();
  const [session, setSession] = useState<DrawerSession | null | undefined>(undefined);
  const active = can('drawer:operate') && enabled('cash_drawer');

  const load = useCallback(() => {
    if (!active) return;
    drawerApi
      .current()
      .then((c) => setSession(c.session))
      .catch(() => setSession(undefined));
  }, [active]);

  // Reload on navigation too: a payment page is where cash usually moves.
  useEffect(load, [load, location.pathname]);
  useEffect(() => {
    window.addEventListener(DRAWER_CHANGED_EVENT, load);
    return () => window.removeEventListener(DRAWER_CHANGED_EVENT, load);
  }, [load]);

  if (!active || session === undefined) return null;

  const { text, tone } = !session
    ? { text: 'Drawer closed', tone: 'neutral' }
    : session.status === 'open'
      ? { text: `Drawer open · ${timeOf(session.openedAt)}`, tone: 'ok' }
      : session.status === 'counting'
        ? { text: 'Closing drawer', tone: 'warn' }
        : { text: 'Drawer awaits approval', tone: 'danger' };

  return (
    <Link to="/drawer" className={`drawerchip drawerchip--${tone}`} aria-label={`${text}. Go to the cash drawer`}>
      <Banknote size={15} aria-hidden />
      <span className="drawerchip__text">{text}</span>
    </Link>
  );
}
