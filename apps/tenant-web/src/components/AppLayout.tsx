import {
  Fragment,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  Clock,
  CornerDownRight,
  Lock,
  LogOut,
  Menu,
  Plus,
  ReceiptText,
  Search,
  Stethoscope,
  TrendingDown,
  UserPlus,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  api,
  financeApi,
  treatmentsApi,
  type InvoiceSummaryRow,
  type PatientListItem,
  type Treatment,
} from '../lib/api';
import { formatMoney } from '../lib/format';
import { t } from '../lib/strings';
import { dateLocale } from '../lib/strings';
import { inClinicZone } from '../lib/clinic-time';
import { Avatar, EmptyState, PageLoading, StatusPill } from './ui';
import { AccountSecurityButton } from './AccountSecurityModal';
import DrawerChip from './drawer/DrawerChip';
import { useFeatures } from '../lib/features';
import { BookingProvider, useBooking } from '../lib/booking';
import { MessagingProvider } from '../lib/messaging';
import {
  SECTIONS,
  isTopLevel,
  locate,
  pageVisible,
  visiblePages,
} from '../lib/navigation';

function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} aria-hidden>
      <circle cx="9" cy="9" r="4" fill="var(--logo-1)" />
      <circle cx="19" cy="9" r="3" fill="var(--logo-2)" />
      <circle cx="14" cy="19" r="3.4" fill="var(--logo-3)" />
      <line x1="9" y1="9" x2="14" y2="19" stroke="var(--logo-1)" strokeWidth="1.6" />
      <line x1="19" y1="9" x2="14" y2="19" stroke="var(--logo-2)" strokeWidth="1.6" />
    </svg>
  );
}

/** How much notice a clinic gets before the lock, in days. */
const TRIAL_WARNING_DAYS = 3;

/**
 * One bar, two states.
 *
 * Going from writable to read-only with no warning is the version of this
 * that makes people angry rather than making them buy: the first they learn
 * of it is a button that stopped working mid-task. So the last few days say
 * so, in a colour that reads as information rather than alarm, and only the
 * expiry itself is amber.
 */
function TrialBanner({ readOnly, endsAt }: { readOnly: boolean; endsAt: string | null }) {
  if (!endsAt) return null;

  const date = new Date(endsAt);
  const pretty = date.toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  if (readOnly) {
    return (
      <div className="trialbar trialbar--ended" role="status">
        <Lock size={15} />
        <span>
          <strong>Your trial ended</strong> on {pretty}. Everything you entered is still
          here — subscribe to start adding again.
        </span>
      </div>
    );
  }

  // Ceil, so the final partial day reads "1 day left" rather than "0".
  const daysLeft = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  if (daysLeft > TRIAL_WARNING_DAYS) return null;

  return (
    <div className="trialbar trialbar--ending" role="status">
      <Clock size={15} />
      <span>
        <strong>
          {daysLeft <= 1
            ? 'Your trial ends today'
            : `${daysLeft} days left in your trial`}
        </strong>
        {daysLeft <= 1 ? '' : ` — it runs until ${pretty}`}. After that the clinic stays
        readable but you cannot add anything new.
      </span>
    </div>
  );
}

/* ── search ─────────────────────────────────────────────────
   The front desk's most frequent lookup, one keystroke away on every page.
   Patients come first — the same search the patient list runs, so what it
   finds is what the list would find. Under them, for whoever moves fast:
   an invoice by number, a service with its price, the few things people
   start (Book appointment, Add patient…) and the pages of the app. Only what
   this person's role may open is ever offered. */
const MIN_SEARCH = 2;

/** Letters without their accents, lowercase — "pastrim" finds "Pastrim". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Does any word of `text` start with every word typed? ("new app" → "New appointment") */
const matches = (text: string, term: string) => {
  const words = fold(text).split(/[\s&/,·-]+/);
  return fold(term)
    .split(/\s+/)
    .filter(Boolean)
    .every((q) => words.some((w) => w.startsWith(q)));
};

/**
 * Other words people use for a page — in English, and in Albanian, which is
 * what the desk thinks in even with the app in English.
 */
const PAGE_WORDS: Record<string, string> = {
  '/reservations': 'appointments schedule agenda termine takime kalendar',
  '/messages': 'whatsapp reminders sms mesazhe kujtesa',
  '/patients': 'pacientet paciente',
  '/patients/recall': 'check-up due rikujtim kontroll',
  '/patients/import': 'excel csv upload importo',
  '/clinical': 'chart today klinike',
  '/treatments': 'prices price list catalogue sherbime cmimet',
  '/inventory':
    'stock supplies materials suppliers reorder magazina stoku materiale furnitore',
  '/lab':
    'laboratory crown bridge denture technician laboratori laborator kurore ure proteze protetike teknik',
  '/invoices': 'bills fatura',
  '/payments': 'receipts pagesa',
  '/drawer': 'cash till float arka',
  '/expenses': 'costs spending shpenzime',
  '/fiscal-queue': 'tax fiskalizim tatime',
  '/financials': 'money revenue income financat',
  '/reports': 'vat tvsh export raporte',
  '/activity': 'audit log history aktiviteti',
  '/settings': 'configuration preferences cilesime',
  '/staff': 'team doctors dentists users stafi',
  '/rooms': 'chairs hours salla dhoma',
};

interface Option {
  id: string;
  group?: string;
  run: () => void;
  body: ReactNode;
}

function fmtNext(iso: string) {
  return new Date(iso).toLocaleString(
    dateLocale(),
    inClinicZone({
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }),
  );
}

/**
 * On a desktop the box sits in the top bar. On a phone it is behind the
 * search button and takes over the top bar while it is open (`active`), so
 * finding a patient is one tap and a few letters from any screen — not a
 * trip to the patient list.
 */
function PatientSearch({
  active: shown,
  onDismiss,
}: {
  active: boolean;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const openBooking = useBooking();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PatientListItem[] | null>(null);
  // An invoice number typed into the same box ("INV-0691", "inv 69") finds
  // the invoice too — patients always come first.
  const [invoices, setInvoices] = useState<InvoiceSummaryRow[]>([]);
  const [services, setServices] = useState<Treatment[] | null>(null);
  const [active, setActive] = useState(0);
  const { can, readOnly } = useAuth();
  const { enabled } = useFeatures();
  const canSeeInvoices = can('invoices:read');
  const canSeeServices = can('treatments:read');
  const canBook = can('appointments:write') && !readOnly;

  // "/" or Ctrl/⌘+K jumps to search from anywhere that is not a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
      const cmdK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey;
      if (!slash && !cmdK) return;
      const target = e.target as HTMLElement | null;
      if (slash && target?.closest('input, textarea, select, [contenteditable="true"]'))
        return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (shown) inputRef.current?.focus();
  }, [shown]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_SEARCH) {
      setResults(null);
      setInvoices([]);
      return;
    }
    // The price list is small and changes rarely: fetched once, searched here.
    if (canSeeServices && services === null) {
      setServices([]);
      treatmentsApi
        .list({ status: 'active' })
        .then(setServices)
        .catch(() => setServices([]));
    }
    // A slower response for an older term must not overwrite a newer one.
    let stale = false;
    const invoiceTerm = /^[a-z]{2,6}[\s-]*\d/i.test(term)
      ? term.replace(/\s+/g, '')
      : null;
    const timer = window.setTimeout(() => {
      api
        .listPatients({ q: term, status: 'all' })
        .then((d) => {
          if (stale) return;
          setResults(d.items.slice(0, 6));
          setActive(0);
        })
        .catch(() => {
          if (!stale) setResults([]);
        });
      if (invoiceTerm && canSeeInvoices) {
        financeApi
          .listInvoices({ q: invoiceTerm })
          .then((rows) => !stale && setInvoices(rows.slice(0, 3)))
          .catch(() => !stale && setInvoices([]));
      } else {
        setInvoices([]);
      }
    }, 200);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [q, canSeeInvoices, canSeeServices, services]);

  const term = q.trim();
  const showList = open && term.length >= MIN_SEARCH;
  const patients = results ?? [];

  const reset = () => {
    setOpen(false);
    setQ('');
    setResults(null);
    inputRef.current?.blur();
    onDismiss();
  };
  const go = (to: string) => {
    reset();
    navigate(to);
  };

  // Everything this box can offer for the term, in the order it is offered.
  const options = useMemo<Option[]>(() => {
    if (term.length < MIN_SEARCH) return [];
    const out: Option[] = [];
    for (const p of patients) {
      const sub = p.nextAppointmentAt
        ? `Next ${fmtNext(p.nextAppointmentAt)}`
        : [p.phone, p.city].filter(Boolean).join(' · ') || p.email || '—';
      out.push({
        id: `p-${p.id}`,
        run: () => go(`/patients/${p.id}`),
        body: (
          <>
            <Avatar name={`${p.firstName} ${p.lastName}`} size={30} />
            <span className="gsearch__meta">
              <span className="gsearch__name">
                {p.firstName} {p.lastName}
              </span>
              <span className="gsearch__sub">{sub}</span>
            </span>
            {p.status !== 'active' && <StatusPill status={p.status} />}
          </>
        ),
      });
    }
    for (const inv of invoices) {
      out.push({
        id: `i-${inv.id}`,
        run: () => go(`/invoices/${inv.id}`),
        body: (
          <>
            <span className="gsearch__icon" aria-hidden>
              <ReceiptText size={15} />
            </span>
            <span className="gsearch__meta">
              <span className="gsearch__name">
                {inv.invoiceNumber} · {inv.patientName}
              </span>
              <span className="gsearch__sub">
                {formatMoney(inv.total)}
                {inv.balance > 0 ? ` · ${formatMoney(inv.balance)} owed` : ' · paid'}
              </span>
            </span>
          </>
        ),
      });
    }
    // A service answers "how much, how long" on the spot, and books it.
    for (const s of (services ?? []).filter((x) => matches(x.name, term)).slice(0, 3)) {
      out.push({
        id: `s-${s.id}`,
        group: 'Services',
        run: () => {
          if (canBook) {
            reset();
            openBooking({ treatmentId: s.id });
          } else go('/treatments');
        },
        body: (
          <>
            <span className="gsearch__icon" aria-hidden>
              <Stethoscope size={15} />
            </span>
            <span className="gsearch__meta">
              <span className="gsearch__name">{s.name}</span>
              <span className="gsearch__sub">
                {s.durationMinutes} min · {formatMoney(s.price)}
                {canBook ? ' · Book it' : ''}
              </span>
            </span>
          </>
        ),
      });
    }
    const actions = [
      {
        label: t('quick.newAppointment'),
        also: 'new appointment schedule visit',
        icon: CalendarPlus,
        allowed: canBook,
        run: () => {
          reset();
          openBooking();
        },
      },
      {
        label: t('quick.addPatient'),
        also: 'new patient register',
        icon: UserPlus,
        allowed: can('patients:write') && !readOnly,
        run: () => go('/patients/new'),
      },
      {
        label: t('quick.newInvoice'),
        also: 'bill charge',
        icon: ReceiptText,
        allowed: can('invoices:write') && !readOnly,
        run: () => go('/invoices?new=1'),
      },
      {
        label: t('quick.addExpense'),
        also: 'new expense spend',
        icon: TrendingDown,
        allowed: can('expenses:write') && !readOnly,
        run: () => go('/expenses?new=1'),
      },
    ];
    for (const a of actions) {
      if (!a.allowed || !(matches(a.label, term) || matches(a.also, term))) continue;
      const Icon = a.icon;
      out.push({
        id: `a-${a.label}`,
        group: 'Actions',
        run: a.run,
        body: (
          <>
            <span className="gsearch__icon" aria-hidden>
              <Icon size={15} />
            </span>
            <span className="gsearch__meta">
              <span className="gsearch__name">{a.label}</span>
            </span>
          </>
        ),
      });
    }
    const seen = new Set<string>();
    for (const sec of SECTIONS) {
      for (const page of visiblePages(sec, can, enabled)) {
        const label = t(page.label);
        const where = t(sec.label);
        const words = `${label} ${where} ${PAGE_WORDS[page.to] ?? ''}`;
        if (seen.has(page.to) || !matches(words, term)) continue;
        seen.add(page.to);
        out.push({
          id: `g-${page.to}`,
          group: 'Go to',
          run: () => go(page.to),
          body: (
            <>
              <span className="gsearch__icon" aria-hidden>
                <CornerDownRight size={15} />
              </span>
              <span className="gsearch__meta">
                <span className="gsearch__name">{label}</span>
                {where !== label && <span className="gsearch__sub">{where}</span>}
              </span>
            </>
          ),
        });
      }
    }
    // "See all" only when there are patients to see more of.
    if (patients.length > 0) {
      out.push({
        id: 'all',
        run: () => go(`/patients?q=${encodeURIComponent(term)}`),
        body: (
          <>
            <Search size={15} aria-hidden /> See all patients matching “{term}”
          </>
        ),
      });
    }
    return out;
    // `go` and `reset` only close over setters, navigate and onDismiss.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, patients, invoices, services, can, enabled, canBook, readOnly, openBooking]);

  const cancel = () => {
    setOpen(false);
    setQ('');
    setResults(null);
    onDismiss();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      e.currentTarget.blur();
      if (shown) cancel();
      return;
    }
    if (term.length < MIN_SEARCH) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      if (options.length > 0) setActive((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (options.length > 0) setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = options[Math.min(active, options.length - 1)];
      if (chosen) chosen.run();
      else go(`/patients?q=${encodeURIComponent(term)}`);
    }
  };

  const searching = results === null;

  return (
    <div className="gsearch" role="search">
      <label className="gsearch__box">
        <Search size={16} aria-hidden />
        <span className="sr-only">Search patients, services and pages</span>
        <input
          ref={inputRef}
          type="search"
          value={q}
          placeholder="Search patients by name, phone or ID…"
          autoComplete="off"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            showList && options.length > 0
              ? `${listId}-${Math.min(active, options.length - 1)}`
              : undefined
          }
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        <kbd className="gsearch__kbd" aria-hidden>
          /
        </kbd>
      </label>
      <button
        type="button"
        className="btn btn--quiet btn--sm gsearch__cancel"
        onClick={cancel}
      >
        Cancel
      </button>

      {showList && (
        <ul
          className="gsearch__list"
          id={listId}
          role="listbox"
          aria-label="Search results"
        >
          {searching && options.length === 0 && (
            <li className="gsearch__status" role="presentation">
              Searching…
            </li>
          )}
          {!searching && options.length === 0 && (
            <li className="gsearch__status" role="presentation">
              Nothing matches “{term}”
            </li>
          )}
          {options.map((o, i) => (
            <Fragment key={o.id}>
              {o.group && o.group !== options[i - 1]?.group && (
                <li className="gsearch__group" role="presentation">
                  {o.group}
                </li>
              )}
              <li
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`gsearch__option${o.id === 'all' ? ' gsearch__option--all' : ''}${
                  i === active ? ' gsearch__option--active' : ''
                }`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={o.run}
              >
                {o.body}
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── create menu ────────────────────────────────────────────
   Every "new" the signed-in user is allowed to make, from any page. Items
   the role cannot create are left out rather than shown disabled, and the
   whole menu goes when the trial is read-only. */
function NewMenu() {
  const { can, readOnly } = useAuth();
  const location = useLocation();
  const openBooking = useBooking();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);

  const items = [
    {
      to: '/reservations?new=1',
      label: t('quick.newAppointment'),
      icon: CalendarPlus,
      allowed: can('appointments:write'),
    },
    {
      to: '/patients/new',
      label: t('quick.addPatient'),
      icon: UserPlus,
      allowed: can('patients:write'),
    },
    {
      to: '/invoices?new=1',
      label: t('quick.newInvoice'),
      icon: ReceiptText,
      allowed: can('invoices:write'),
    },
    {
      to: '/expenses?new=1',
      label: t('quick.addExpense'),
      icon: TrendingDown,
      allowed: can('expenses:write'),
    },
  ].filter((i) => i.allowed);

  useEffect(() => setOpen(false), [location.pathname, location.search]);

  useEffect(() => {
    if (!open) return;
    wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (readOnly || items.length === 0) return null;

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const els = Array.from(
      wrapRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      els[(i + 1) % els.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      els[(i - 1 + els.length) % els.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="newmenu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn--ghost btn--sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Create new"
        onClick={() => setOpen((o) => !o)}
      >
        <Plus size={16} aria-hidden />
        <span className="topbar__label">New</span>
        <ChevronDown className="newmenu__caret" size={15} aria-hidden />
      </button>
      {open && (
        <div
          className="newmenu__list"
          id={menuId}
          role="menu"
          aria-label="Create new"
          onKeyDown={onMenuKey}
        >
          {items.map((item) => {
            const Icon = item.icon;
            const inner = (
              <>
                <span className="quick__icon" aria-hidden>
                  <Icon size={16} />
                </span>
                {item.label}
              </>
            );
            // Booking opens over the page you are on, not on the calendar.
            return item.to === '/reservations?new=1' ? (
              <button
                key={item.to}
                type="button"
                role="menuitem"
                className="newmenu__item"
                onClick={() => {
                  setOpen(false);
                  openBooking();
                }}
              >
                {inner}
              </button>
            ) : (
              <Link
                key={item.to}
                to={item.to}
                role="menuitem"
                className="newmenu__item"
                onClick={() => setOpen(false)}
              >
                {inner}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AppLayout() {
  const { user, logout, can, readOnly, trialEndsAt } = useAuth();
  const { enabled, features } = useFeatures();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const secnavRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const here = locate(location.pathname);
  const sectionPages = here ? visiblePages(here.section, can, enabled) : [];
  // A page reached by its address that this person's role cannot use: say so,
  // instead of rendering a screen whose every request comes back refused.
  // Feature-gated pages wait for the flags, so nothing flashes while loading.
  const blocked =
    here !== null &&
    (features !== null || !here.page.feature) &&
    !pageVisible(here.page, can, enabled);
  const blockedByFeature =
    blocked && here?.page.feature !== undefined && !enabled(here.page.feature);
  // The crumb names the page; on a detail route (/patients/123) it is the
  // link back up to the list.
  const nested = here ? !isTopLevel(location.pathname, here.page) : false;
  // On a page the crumb names the section (the tabs name the page); on a
  // detail route it names the list it came from and links back to it.
  const title = !here
    ? 'DentalCare'
    : nested && here.page.label !== 'nav.allPatients'
      ? t(here.page.label)
      : t(here.section.label);
  // Sub-pages as tabs, only where there is a choice and only on the pages
  // themselves — a detail route has its own way back.
  // Settings lists its own sections, Staff and Rooms among them, so the
  // tab row is only the way back from those two.
  const showSecnav =
    here !== null &&
    sectionPages.length > 1 &&
    !nested &&
    location.pathname !== '/settings';
  const clinicName = user?.clinicName ?? 'Clinic';

  // Close the mobile drawer whenever the route changes, so tapping a
  // destination doesn't leave the menu covering the page it just opened.
  useEffect(() => {
    setNavOpen(false);
    setSearching(false);
  }, [location.pathname]);

  // On a phone the section tabs can be wider than the screen; the one you
  // are on is always scrolled into view rather than left off the edge.
  useEffect(() => {
    const el = secnavRef.current?.querySelector<HTMLElement>('.secnav__item--active');
    const nav = secnavRef.current;
    if (!el || !nav || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = el.offsetLeft - (nav.clientWidth - el.offsetWidth) / 2;
  }, [location.pathname]);

  // The phone's four tabs are the four places this person goes all day: the
  // desk lives in Payments, a clinician in Clinical.
  const clinician = user
    ? ['dentist', 'hygienist', 'assistant'].includes(user.role)
    : false;
  const quick = [
    'dashboard',
    'calendar',
    'patients',
    clinician ? 'clinical' : 'payments',
  ];

  // Escape closes it, matching the dialogs elsewhere.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  // Focus follows the drawer: into it on open, back to the menu button on
  // close — otherwise a keyboard user is left on a control that just vanished.
  // Whatever opened the menu gets focus back — the menu button on a tablet,
  // the More tab on a phone, where the menu button is hidden.
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (navOpen) {
      wasOpen.current = true;
      openerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : toggleRef.current;
      closeRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      const back = openerRef.current;
      (back && back.offsetParent !== null ? back : toggleRef.current)?.focus();
    }
  }, [navOpen]);

  return (
    <MessagingProvider>
      <BookingProvider>
        <div className={`shell${navOpen ? ' shell--navopen' : ''}`}>
          <a className="skiplink" href="#main">
            Skip to content
          </a>
          <button
            className="scrim"
            aria-label={t('nav.close')}
            tabIndex={navOpen ? 0 : -1}
            onClick={() => setNavOpen(false)}
          />
          <aside className="sidebar" id="app-sidebar" aria-label="Sidebar">
            <div className="sidebar__top">
              <div className="clinic">
                <span className="clinic__mark">
                  <Logo size={22} />
                </span>
                <span className="clinic__meta">
                  <span className="clinic__name" title={clinicName}>
                    {clinicName}
                  </span>
                  <span className="clinic__label">DentalCare</span>
                </span>
              </div>
              <button
                ref={closeRef}
                className="iconbtn iconbtn--quiet sidebar__close"
                aria-label={t('nav.close')}
                onClick={() => setNavOpen(false)}
              >
                <X size={18} />
              </button>
            </div>

            <nav className="nav" aria-label="Main">
              {SECTIONS.map((sec) => {
                const pages = visiblePages(sec, can, enabled);
                if (pages.length === 0) return null;
                const Icon = sec.icon;
                const active = here?.section.key === sec.key;
                return (
                  <NavLink
                    key={sec.key}
                    to={pages[0]!.to}
                    end={sec.key === 'dashboard'}
                    aria-current={active ? 'page' : undefined}
                    className={`nav__item${active ? ' nav__item--active' : ''}`}
                  >
                    <Icon size={18} strokeWidth={1.9} aria-hidden />
                    <span>{t(sec.label)}</span>
                  </NavLink>
                );
              })}
            </nav>

            <div className="sidebar__foot">
              <div className="usercard">
                <Avatar name={user?.fullName ?? '?'} size={34} />
                <span className="usercard__meta">
                  <span className="usercard__name">{user?.fullName}</span>
                  <span className="usercard__role">
                    {user ? t(`role.${user.role}`) : ''}
                  </span>
                </span>
                <AccountSecurityButton />
                <button
                  className="iconbtn iconbtn--quiet"
                  onClick={logout}
                  title={t('nav.logout')}
                  aria-label={t('nav.logout')}
                >
                  <LogOut size={16} />
                </button>
              </div>
            </div>
          </aside>

          <div className="main">
            <header className={`topbar${searching ? ' topbar--searching' : ''}`}>
              <div className="topbar__lead">
                <button
                  ref={toggleRef}
                  className="iconbtn navtoggle"
                  aria-label={t('nav.open')}
                  aria-expanded={navOpen}
                  aria-controls="app-sidebar"
                  onClick={() => setNavOpen(true)}
                >
                  <Menu size={18} />
                </button>
                {/* Phones: the mark and the clinic, where the breadcrumb would be. */}
                <Link
                  to="/"
                  className="topbar__brand"
                  aria-label={`${clinicName} — home`}
                >
                  <span className="topbar__mark">
                    <Logo size={22} />
                  </span>
                  <span className="topbar__clinic">{clinicName}</span>
                </Link>
                <nav aria-label="Breadcrumb" className="topbar__crumbs">
                  <ol className="crumbs">
                    <li>
                      <span className="crumbs__clinic">{clinicName}</span>
                      <ChevronRight className="crumbs__sep" size={14} aria-hidden />
                    </li>
                    <li>
                      {nested && here ? (
                        <Link to={here.page.to} className="crumbs__here">
                          {title}
                        </Link>
                      ) : (
                        <span className="crumbs__here" aria-current="page">
                          {title}
                        </span>
                      )}
                    </li>
                  </ol>
                </nav>
              </div>

              <PatientSearch active={searching} onDismiss={() => setSearching(false)} />

              <div className="topbar__actions">
                {/* On a phone the search box does not fit the bar; this opens it
                over the bar instead. */}
                <button
                  type="button"
                  className="iconbtn topbar__searchlink"
                  aria-label="Search patients"
                  title="Search patients"
                  onClick={() => setSearching(true)}
                >
                  <Search size={17} aria-hidden />
                </button>
                <DrawerChip />
                {!readOnly && <NewMenu />}
              </div>
            </header>
            <TrialBanner readOnly={readOnly} endsAt={trialEndsAt} />
            <main className="content" id="main" tabIndex={-1}>
              {showSecnav && (
                <nav
                  className="secnav page"
                  aria-label={t(here!.section.label)}
                  ref={secnavRef}
                >
                  {sectionPages.map((p) => (
                    <NavLink
                      key={p.to}
                      to={p.to}
                      end
                      className={({ isActive }) =>
                        `secnav__item${isActive ? ' secnav__item--active' : ''}`
                      }
                    >
                      {t(p.label)}
                    </NavLink>
                  ))}
                </nav>
              )}
              {/* Keyed by path: each arrival fades in from where the eye already
              is. A query-string change (a tab, a filter) does not remount. */}
              <div className="route-enter" key={location.pathname}>
                <Suspense fallback={<PageLoading />}>
                  {blocked ? (
                    <div className="page">
                      <EmptyState
                        framed
                        icon={<Lock size={22} />}
                        title={
                          blockedByFeature ? 'Not switched on' : 'Not part of your role'
                        }
                        body={
                          blockedByFeature
                            ? 'This part of DentalCare is switched off for your clinic. An administrator can turn it on in Settings.'
                            : 'This page is for other roles in the clinic. Ask an administrator if you need it.'
                        }
                        action={
                          <Link to="/" className="btn btn--ghost btn--sm">
                            Back to the dashboard
                          </Link>
                        }
                      />
                    </div>
                  ) : (
                    <Outlet />
                  )}
                </Suspense>
              </div>
            </main>
          </div>

          {/* Phones: the four places this person goes all day, under the thumb,
          and everything else one tap away in the full menu. Never scrolls. */}
          <nav className="tabbar" aria-label="Quick navigation">
            {quick
              .map((key) => SECTIONS.find((sec) => sec.key === key)!)
              .map((sec) => {
                const pages = visiblePages(sec, can, enabled);
                if (pages.length === 0) return null;
                const Icon = sec.icon;
                const active = here?.section.key === sec.key;
                return (
                  <Link
                    key={sec.key}
                    to={pages[0]!.to}
                    className={`tabbar__item${active ? ' tabbar__item--active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon size={21} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
                    <span>{sec.key === 'dashboard' ? 'Home' : t(sec.label)}</span>
                  </Link>
                );
              })}
            <button
              type="button"
              className={`tabbar__item${
                here && !quick.includes(here.section.key) ? ' tabbar__item--active' : ''
              }`}
              aria-controls="app-sidebar"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Menu size={21} strokeWidth={1.8} aria-hidden />
              <span>More</span>
            </button>
          </nav>
        </div>
      </BookingProvider>
    </MessagingProvider>
  );
}
