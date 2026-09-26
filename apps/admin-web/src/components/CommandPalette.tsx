import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Building2,
  CornerDownLeft,
  HardDrive,
  LayoutDashboard,
  Plus,
  Receipt,
  Rocket,
  Search,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import { api, clinicHost, type TenantRow } from '../lib/api';
import { ClinicMark, StatusPill } from './ui';

interface Item {
  id: string;
  group: 'Actions' | 'Go to' | 'Clinics';
  title: string;
  sub?: string;
  icon?: LucideIcon;
  clinic?: TenantRow;
  keywords?: string;
  run: () => void;
}

/**
 * Ctrl/⌘ K: jump to any clinic by name, subdomain or owner, to any screen,
 * or start the two things an operator starts most. The fastest way from "a
 * clinic just called" to that clinic's page.
 */
export default function CommandPalette({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (demo: boolean) => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [clinics, setClinics] = useState<TenantRow[] | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    api
      .tenants()
      .then(setClinics)
      .catch(() => setClinics([]));
  }, []);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };
    const term = q.trim().toLowerCase();
    const match = (...fields: (string | null | undefined)[]) =>
      !term || fields.some((f) => f?.toLowerCase().includes(term));

    const actions: Item[] = [
      {
        id: 'new',
        group: 'Actions',
        title: 'New clinic',
        icon: Plus,
        keywords: 'create add onboard',
        run: () => {
          onClose();
          onCreate(false);
        },
      },
      {
        id: 'demo',
        group: 'Actions',
        title: 'New demo clinic',
        sub: 'Seven-day trial',
        icon: Rocket,
        keywords: 'create trial sales',
        run: () => {
          onClose();
          onCreate(true);
        },
      },
    ];
    const pages: Item[] = [
      {
        id: 'p-overview',
        group: 'Go to',
        title: 'Overview',
        icon: LayoutDashboard,
        keywords: 'home dashboard',
        run: go('/'),
      },
      {
        id: 'p-clinics',
        group: 'Go to',
        title: 'Clinics',
        icon: Building2,
        keywords: 'tenants',
        run: go('/clinics'),
      },
      {
        id: 'p-billing',
        group: 'Go to',
        title: 'Billing',
        icon: Receipt,
        keywords: 'invoices overdue payments',
        run: go('/billing'),
      },
      {
        id: 'p-plans',
        group: 'Go to',
        title: 'Plans',
        icon: Tag,
        keywords: 'pricing price list',
        run: go('/plans'),
      },
      {
        id: 'p-usage',
        group: 'Go to',
        title: 'Usage',
        icon: HardDrive,
        keywords: 'storage',
        run: go('/usage'),
      },
      {
        id: 'p-activity',
        group: 'Go to',
        title: 'Activity',
        icon: Activity,
        keywords: 'audit log trail history',
        run: go('/activity'),
      },
    ];
    const found = (clinics ?? [])
      .filter((c) => match(c.name, c.subdomain, c.owner_email))
      .sort(
        (a, b) =>
          (a.status === 'deleted' ? 1 : 0) - (b.status === 'deleted' ? 1 : 0) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, term ? 8 : 5)
      .map<Item>((c) => ({
        id: `c-${c.id}`,
        group: 'Clinics',
        title: c.name,
        sub: `${clinicHost(c.subdomain)}${c.owner_email ? ` · ${c.owner_email}` : ''}`,
        clinic: c,
        run: go(`/tenants/${c.id}`),
      }));

    const keep = (i: Item) => match(i.title, i.sub, i.keywords);
    // While searching, clinics first: a name typed is nearly always a clinic.
    return term
      ? [...found, ...actions.filter(keep), ...pages.filter(keep)]
      : [...actions, ...pages, ...found];
  }, [q, clinics, navigate, onClose, onCreate]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[active]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  let lastGroup: string | null = null;

  return (
    <div
      className="palette__overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search the console"
      >
        <div className="palette__input">
          <Search size={18} aria-hidden />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search clinics, screens and actions…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `pal-${items[active]!.id}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && (
            <li className="palette__empty">
              {clinics === null ? 'Loading clinics…' : `Nothing matches “${q}”.`}
            </li>
          )}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            const Icon = item.icon;
            return (
              <li key={item.id} role="presentation">
                {header && <div className="palette__group">{header}</div>}
                <div
                  id={`pal-${item.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  className={`palette__item${i === active ? ' palette__item--active' : ''}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => item.run()}
                >
                  {item.clinic ? (
                    <ClinicMark name={item.clinic.name} size={30} />
                  ) : (
                    <span className="palette__icon">
                      {Icon && <Icon size={17} aria-hidden />}
                    </span>
                  )}
                  <span className="palette__meta">
                    <span className="palette__title">{item.title}</span>
                    {item.sub && <span className="palette__sub">{item.sub}</span>}
                  </span>
                  {item.clinic && item.clinic.status !== 'active' && (
                    <StatusPill status={item.clinic.status} />
                  )}
                  {i === active && <ArrowRight size={15} aria-hidden />}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="palette__foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={11} />
            </kbd>{' '}
            to open
          </span>
        </div>
      </div>
    </div>
  );
}
