import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CircleCheck,
  X,
  type LucideIcon,
} from 'lucide-react';
import { trialState, type TenantStatus } from '../lib/api';
import { initials } from '../lib/format';

/* ── identity ─────────────────────────────────────────────── */

/** Six tints from the palette's own family. A name always gets the same one. */
const TINTS = [
  { bg: '#fbe8e2', fg: '#a63a20' },
  { bg: '#e7eef9', fg: '#2f5f9e' },
  { bg: '#e2f4ec', fg: '#107452' },
  { bg: '#f6ecd9', fg: '#7a5412' },
  { bg: '#ecebe8', fg: '#3a3a40' },
  { bg: '#f1e8f4', fg: '#6b3f7a' },
];

function tintOf(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

/** A clinic: rounded square, so it never reads as a person. */
export function ClinicMark({ name, size = 36 }: { name: string; size?: number }) {
  const t = tintOf(name);
  return (
    <span
      className="clinicmark"
      style={{
        width: size,
        height: size,
        background: t.bg,
        color: t.fg,
        fontSize: size * 0.36,
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/** A person: a circle. */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const t = tintOf(name);
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: t.bg,
        color: t.fg,
        fontSize: size * 0.38,
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/* ── status ───────────────────────────────────────────────── */

export const STATUS_LABEL: Record<TenantStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  archived: 'Archived',
  deleted: 'Deleted',
};
const STATUS_TONE: Record<TenantStatus, string> = {
  active: 'ok',
  suspended: 'warn',
  archived: 'neutral',
  deleted: 'danger',
};

export function StatusPill({ status }: { status: TenantStatus }) {
  return (
    <span className={`pill pill--${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
  );
}

/**
 * A trial is a countdown, not a status, so it reads as one: blue while there
 * is room, amber in the last two days, red once it has run out — which is
 * exactly what an expired trial feels like from the clinic's side.
 */
export function TrialPill({
  trialEndsAt,
  paidLabel = 'Paid',
}: {
  trialEndsAt: string | null;
  paidLabel?: string | null;
}) {
  const t = trialState(trialEndsAt);
  if (t.kind === 'paid')
    return paidLabel ? <span className="pill pill--plain">{paidLabel}</span> : null;
  if (t.kind === 'expired') {
    return (
      <span className="pill pill--danger">
        {t.daysAgo === 0 ? 'Trial ended today' : `Trial ended ${t.daysAgo}d ago`}
      </span>
    );
  }
  return (
    <span className={`pill ${t.daysLeft <= 2 ? 'pill--warn' : 'pill--info'}`}>
      {t.daysLeft === 1 ? 'Trial · 1 day left' : `Trial · ${t.daysLeft} days left`}
    </span>
  );
}

/* ── empty & loading ──────────────────────────────────────── */

export function Empty({
  icon: Icon,
  title,
  body,
  action,
  tone,
  compact,
}: {
  icon: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  tone?: 'ok';
  compact?: boolean;
}) {
  return (
    <div className={`empty${compact ? ' empty--compact' : ''}`}>
      <span className={`empty__icon${tone ? ` empty__icon--${tone}` : ''}`}>
        <Icon size={22} aria-hidden />
      </span>
      <p className="empty__title">{title}</p>
      {body && <p className="empty__body">{body}</p>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skelrows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skelrow" key={i}>
          <span className="skel" style={{ width: 36, height: 36, borderRadius: 11 }} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="skel" style={{ width: `${38 + ((i * 17) % 30)}%` }} />
            <span
              className="skel"
              style={{ width: `${22 + ((i * 11) % 20)}%`, height: 10 }}
            />
          </span>
          <span className="skel" style={{ width: 70 }} />
        </div>
      ))}
    </div>
  );
}

/* ── figures ──────────────────────────────────────────────── */

export function Kpi({
  label,
  value,
  note,
  icon: Icon,
  tone,
  meter,
  href,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  icon: LucideIcon;
  tone?: 'alert' | 'warn' | 'dark';
  /** 0..1 — how much of something is done. */
  meter?: number;
  href?: string;
}) {
  const body = (
    <>
      <div className="kpi__top">
        <span className="kpi__label">{label}</span>
        <span className="kpi__icon">
          <Icon size={16} aria-hidden />
        </span>
      </div>
      <span className="kpi__value">{value}</span>
      {meter !== undefined && (
        <span className="meter" aria-hidden>
          <span
            className={`meter__fill${tone === 'dark' ? ' meter__fill--ember' : ''}`}
            style={{ width: `${Math.max(0, Math.min(1, meter)) * 100}%` }}
          />
        </span>
      )}
      {note && <span className="kpi__note">{note}</span>}
    </>
  );
  const className = `kpi${tone ? ` kpi--${tone}` : ''}`;
  return href ? (
    <Link className={className} to={href}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/* ── sortable columns ─────────────────────────────────────── */

export type SortDir = 'asc' | 'desc';

export function SortHeader<K extends string>({
  label,
  k,
  sort,
  onSort,
  numeric,
}: {
  label: string;
  k: K;
  sort: { key: K; dir: SortDir };
  onSort: (k: K) => void;
  numeric?: boolean;
}) {
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className={numeric ? 'num' : undefined}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="sorth"
        data-active={active}
        onClick={() => onSort(k)}
      >
        {label}
        <Icon size={12} aria-hidden />
      </button>
    </th>
  );
}

/** Click once for the natural order of a column, again to flip it. */
export function useSort<K extends string>(
  initial: K,
  initialDir: SortDir = 'desc',
  ascByDefault: K[] = [],
) {
  const [sort, setSort] = useState<{ key: K; dir: SortDir }>({
    key: initial,
    dir: initialDir,
  });
  const asc = useRef(ascByDefault);
  const onSort = useCallback(
    (k: K) =>
      setSort((s) =>
        s.key === k
          ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' }
          : { key: k, dir: asc.current.includes(k) ? 'asc' : 'desc' },
      ),
    [],
  );
  return { sort, onSort };
}

/* ── modal ────────────────────────────────────────────────── */

/**
 * One dialog. Escape and the backdrop close it, unless it is showing
 * something that cannot be shown twice — a password, recovery codes — in
 * which case only its own button does. Focus moves in on open and back to
 * whatever opened it on close.
 */
export function Modal({
  title,
  subtitle,
  icon: Icon,
  iconTone,
  onClose,
  dismissable = true,
  size,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  iconTone?: 'danger' | 'warn' | 'ok';
  onClose: () => void;
  dismissable?: boolean;
  size?: 'wide' | 'narrow';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Read during the first render, before anything inside has taken focus.
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    // A control marked autoFocus has already been focused by React.
    if (!ref.current?.contains(document.activeElement)) {
      const first = ref.current?.querySelector<HTMLElement>('input, select, textarea');
      (first ?? ref.current)?.focus();
    }
    const back = opener.current;
    return () => back?.focus?.();
  }, []);

  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissable]);

  return (
    <div
      className="modal__overlay"
      onMouseDown={(e) => dismissable && e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className={`modal${size ? ` modal--${size}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal__head">
          <div className="modal__titles">
            {Icon && (
              <span
                className={`modal__icon${iconTone ? ` modal__icon--${iconTone}` : ''}`}
              >
                <Icon size={20} aria-hidden />
              </span>
            )}
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {dismissable && (
            <button
              type="button"
              className="iconbtn iconbtn--quiet"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── toasts ───────────────────────────────────────────────── */

interface Toast {
  id: number;
  tone: 'ok' | 'error';
  message: string;
}
const ToastCtx = createContext<((message: string, tone?: Toast['tone']) => void) | null>(
  null,
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback(
    (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)),
    [],
  );
  const push = useCallback(
    (message: string, tone: Toast['tone'] = 'ok') => {
      const id = ++seq.current;
      setToasts((ts) => [...ts.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4500);
    },
    [dismiss],
  );

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`}>
            {t.tone === 'ok' ? (
              <CircleCheck size={17} aria-hidden />
            ) : (
              <AlertTriangle size={17} aria-hidden />
            )}
            <span className="toast__body">{t.message}</span>
            <button
              type="button"
              className="toast__close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  if (!push) throw new Error('useToast outside ToastProvider');
  return push;
}

/* ── confirmation ─────────────────────────────────────────── */

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'warn' | 'default';
  icon?: LucideIcon;
}
const ConfirmCtx = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(null);

/**
 * `await confirm({...})` instead of window.confirm: the same one-line call
 * site, but a dialog that looks like the product and says what will happen.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);

  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ ...o, resolve })),
    [],
  );
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const value = useMemo(() => confirm, [confirm]);
  return (
    <ConfirmCtx.Provider value={value}>
      {children}
      {pending && (
        <Modal
          title={pending.title}
          icon={pending.icon ?? AlertTriangle}
          iconTone={pending.tone === 'default' ? undefined : (pending.tone ?? 'warn')}
          onClose={() => settle(false)}
          size="narrow"
        >
          <div className="modal__body">
            {pending.body && (
              <p className="hint" style={{ fontSize: 14 }}>
                {pending.body}
              </p>
            )}
            <div className="modal__foot">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => settle(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${pending.tone === 'danger' ? 'btn--danger' : 'btn--primary'}`}
                onClick={() => settle(true)}
                autoFocus
              >
                {pending.confirmLabel}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const c = useContext(ConfirmCtx);
  if (!c) throw new Error('useConfirm outside ConfirmProvider');
  return c;
}
