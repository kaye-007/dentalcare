import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CloudOff,
  MoreHorizontal,
  X,
} from 'lucide-react';
import { initials, avatarTint } from '../lib/format';

/* ── Avatar ──────────────────────────────────────────────── */
export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const tint = avatarTint(name);
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: tint.bg,
        color: tint.fg,
        fontSize: size * 0.38,
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/* ── Status pills — one semantic system across the app ───── */
/**
 * `done` is the finished, expected state (a visit completed, an invoice paid,
 * a drawer closed): a quiet check, not a coloured badge, so the exceptions
 * around it are what the eye finds.
 */
type PillKind = 'ok' | 'info' | 'warn' | 'danger' | 'neutral' | 'done';
const PILL_KINDS: readonly string[] = ['ok', 'info', 'warn', 'danger', 'neutral', 'done'];

const PILL_MAP: Record<string, { kind: PillKind; label: string }> = {
  // appointments
  scheduled: { kind: 'info', label: 'Scheduled' },
  checked_in: { kind: 'info', label: 'Checked in' },
  // Treatment underway — the one status that should catch the eye on a busy day.
  in_progress: { kind: 'warn', label: 'In progress' },
  completed: { kind: 'done', label: 'Completed' },
  cancelled: { kind: 'neutral', label: 'Cancelled' },
  no_show: { kind: 'warn', label: 'No-show' },
  // patients
  active: { kind: 'ok', label: 'Active' },
  inactive: { kind: 'neutral', label: 'Inactive' },
  archived: { kind: 'neutral', label: 'Archived' },
  // allergy severity — the only pill whose colour carries clinical meaning
  severe: { kind: 'danger', label: 'Severe' },
  moderate: { kind: 'warn', label: 'Moderate' },
  mild: { kind: 'neutral', label: 'Mild' },
  // medical history
  resolved: { kind: 'neutral', label: 'Resolved' },
  current: { kind: 'ok', label: 'Current' },
  stopped: { kind: 'neutral', label: 'Stopped' },
  // billing
  unpaid: { kind: 'danger', label: 'Unpaid' },
  partial: { kind: 'warn', label: 'Partial' },
  partially_paid: { kind: 'warn', label: 'Partial' },
  paid: { kind: 'done', label: 'Paid' },
};

/**
 * `status` is either a domain status from the map above or, for callers that
 * only want a colour, one of the five kinds themselves. The reminder log
 * passes `info` for "Automatic" — that used to fall through to neutral.
 */
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const m =
    PILL_MAP[status] ??
    (PILL_KINDS.includes(status)
      ? { kind: status as PillKind, label: status }
      : { kind: 'neutral' as PillKind, label: status });
  return <span className={`pill pill--${m.kind}`}>{label ?? m.label}</span>;
}

/* ── Page header — single pattern for every module page ──────
   The title is the page's h1. The topbar carries a breadcrumb, not a heading,
   so there is exactly one h1 per screen and it is the one the reader sees. */
export function PageHeader({
  title,
  meta,
  actions,
  back,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <>
      {back}
      <div className="page__head">
        <div className="page__head-main">
          {title && <h1 className="section-title">{title}</h1>}
          {meta && <p className="page__meta">{meta}</p>}
        </div>
        {actions && <div className="page__actions">{actions}</div>}
      </div>
    </>
  );
}

/* ── Empty state — one pattern everywhere ─────────────────── */
export function EmptyState({
  icon,
  title,
  body,
  action,
  framed = false,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  framed?: boolean;
}) {
  return (
    <div className={`empty${framed ? ' empty--framed' : ''}`}>
      <span className="empty__icon">{icon}</span>
      <p className="empty__title">{title}</p>
      {body && <p className="empty__body">{body}</p>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

/* ── Dialog behaviour shared by Modal and SidePanel ──────────── */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * What makes an overlay a dialog rather than a div that happens to float:
 * focus moves into it, Tab cannot wander out behind it, Escape closes it, and
 * focus returns to whatever opened it. An `autoFocus` field inside wins over
 * the container, so a form still opens with its cursor in the right place.
 */
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!node.contains(document.activeElement)) node.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = node.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return ref;
}

/**
 * Close on a click that both starts and ends on the backdrop. A plain onClick
 * also fires when someone drags to select text in a field and lets go outside
 * the dialog — which used to throw away a half-filled form.
 */
function useBackdropClose(onClose: () => void) {
  const downOnBackdrop = useRef(false);
  return {
    onMouseDown: (e: MouseEvent) => {
      downOnBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e: MouseEvent) => {
      if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
      downOnBackdrop.current = false;
    },
  };
}

function DialogTitle({
  id,
  className,
  title,
  subtitle,
  onClose,
}: {
  id: string;
  className: string;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div className={className}>
      <div
        className={`${className === 'panel__head' ? 'panel__titles' : 'modal__titles'}`}
      >
        <h2 id={id}>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <button
        type="button"
        className="iconbtn iconbtn--quiet"
        onClick={onClose}
        aria-label="Close"
      >
        <X size={18} />
      </button>
    </div>
  );
}

/* ── Modal — short, focused decisions ─────────────────────── */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const ref = useDialog(onClose);
  const backdrop = useBackdropClose(onClose);
  return (
    <div className="modal__overlay" {...backdrop}>
      <div
        ref={ref}
        className={`modal${wide ? ' modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <DialogTitle
          id={titleId}
          className="modal__head"
          title={title}
          subtitle={subtitle}
          onClose={onClose}
        />
        {children}
      </div>
    </div>
  );
}

/* ── Side panel — work that needs the page behind it ──────────
   Docked right on a desktop, a full-screen sheet on a phone. Children
   supply `.panel__body` (scrolls) and `.panel__foot` (stays put), usually
   wrapped in a `<form className="panel__form">`. */
export function SidePanel({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const ref = useDialog(onClose);
  const backdrop = useBackdropClose(onClose);
  return (
    <div className="panel__overlay" {...backdrop}>
      <div
        ref={ref}
        className={`panel${wide ? ' panel--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <DialogTitle
          id={titleId}
          className="panel__head"
          title={title}
          subtitle={subtitle}
          onClose={onClose}
        />
        {children}
      </div>
    </div>
  );
}

/* ── Sparkline (dashboard sample KPIs) ────────────────────── */
export function Sparkline({ data }: { data: number[] }) {
  const w = 72,
    h = 24;
  const min = Math.min(...data),
    max = Math.max(...data);
  const span = max - min || 1;
  const pts = data
    .map(
      (v, i) =>
        `${((i / (data.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--primary-300)" strokeWidth="1.6" />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════
   States — loading, failure, success. One pattern each, so a
   screen never invents how it waits or how it apologises.
   ══════════════════════════════════════════════════════════════ */

/** A still placeholder bar. Its shape tells the reader what is coming. */
export function Skeleton({
  width = '100%',
  height = 12,
  radius = 6,
}: {
  width?: number | string;
  height?: number;
  radius?: number;
}) {
  return (
    <span className="skel" style={{ width, height, borderRadius: radius }} aria-hidden />
  );
}

/** Placeholder list rows: the shape of a list that is still on its way. */
export function LoadingRows({
  rows = 4,
  avatar = false,
  label = 'Loading',
}: {
  rows?: number;
  avatar?: boolean;
  label?: string;
}) {
  return (
    <div className="skelrows" role="status">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skelrow" key={i}>
          {avatar && <Skeleton width={32} height={32} radius={16} />}
          <span className="skelrow__lines">
            <Skeleton width={`${48 + ((i * 17) % 30)}%`} height={12} />
            <Skeleton width={`${24 + ((i * 11) % 20)}%`} height={10} />
          </span>
          <Skeleton width={56} height={12} />
        </div>
      ))}
    </div>
  );
}

/** A whole page that has not arrived yet: its header, then its first card. */
export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="page" aria-busy="true">
      <div className="page__head">
        <div className="page__head-main skelhead">
          <Skeleton width={220} height={22} />
          <Skeleton width={140} height={12} />
        </div>
      </div>
      <div className="card">
        <LoadingRows rows={5} avatar label={label} />
      </div>
    </div>
  );
}

/**
 * Something failed. Says so in plain words and offers the one useful next
 * step. Never a stack trace or a status code: `humanError` has already turned
 * whatever came back into a sentence.
 */
export function ErrorState({
  title = 'Something went wrong',
  body,
  onRetry,
  framed = false,
}: {
  title?: string;
  body?: string;
  onRetry?: () => void;
  framed?: boolean;
}) {
  return (
    <div className={`empty empty--error${framed ? ' empty--framed' : ''}`} role="alert">
      <span className="empty__icon" aria-hidden>
        <CloudOff size={20} />
      </span>
      <p className="empty__title">{title}</p>
      {body && <p className="empty__body">{body}</p>}
      {onRetry && (
        <div className="empty__action">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Segmented control ───────────────────────────────────────
   A radiogroup that behaves like a physical switch: the thumb slides to the
   choice, so the eye follows what changed. Arrow keys move the choice. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  label: string;
  size?: 'md' | 'lg';
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    for (let step = 1; step <= options.length; step++) {
      const next =
        options[(index + dir * step + options.length * step) % options.length]!;
      if (!next.disabled) {
        onChange(next.value);
        e.currentTarget
          .querySelector<HTMLElement>(`[data-value="${next.value}"]`)
          ?.focus();
        return;
      }
    }
  };
  const style = { '--seg-n': options.length, '--seg-i': index } as CSSProperties;
  return (
    <div
      className={`seg seg--${size}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      style={style}
    >
      <span className="seg__thumb" aria-hidden />
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={o.value}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled}
            className={`seg__opt${on ? ' seg__opt--on' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Disclosure ──────────────────────────────────────────────
   Progressive disclosure as one component. The summary says what is inside
   and, while collapsed, what is already filled in. */
export function Disclosure({
  summary,
  hint,
  defaultOpen = false,
  children,
}: {
  summary: ReactNode;
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    // A field inside that the browser rejects opens the section, so a
    // required value is never missing from somewhere the user cannot see.
    <div
      className={`disclosure${open ? ' disclosure--open' : ''}`}
      onInvalidCapture={() => setOpen(true)}
    >
      <button
        type="button"
        className="disclosure__toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={16} className="disclosure__chev" aria-hidden />
        <span className="disclosure__summary">{summary}</span>
        {hint && !open && <span className="disclosure__hint">{hint}</span>}
      </button>
      <div className="disclosure__body" id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

/* ── More menu ───────────────────────────────────────────────
   Where secondary and rare actions live, so a header keeps one primary
   action. Callers leave out what the user cannot do, never disable it. */
export interface MoreItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
}
export function MoreMenu({
  items,
  label = 'More actions',
}: {
  items: MoreItem[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: globalThis.MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (items.length === 0) return null;

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const els = Array.from(
      wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
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
    <div className="moremenu" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="iconbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={18} aria-hidden />
      </button>
      {open && (
        <div
          className="moremenu__list"
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKey}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`moremenu__item${it.danger ? ' moremenu__item--danger' : ''}`}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Toasts ──────────────────────────────────────────────────
   Quiet confirmation that something worked. The same call shape as the
   NODE X console: `toast('Saved')`, `toast('Could not …', 'error')`.

   A reversible action says what it did and offers to take it back —
   `toast('Checked in.', { action: { label: 'Undo', run } })` — instead of
   asking "Are you sure?" first. A toast with an action stays longer, and
   waits while the pointer or the keyboard is on it. */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}
interface ToastItem {
  id: number;
  tone: 'ok' | 'error';
  message: string;
  action?: ToastAction;
}
type ToastOptions = { tone?: ToastItem['tone']; action?: ToastAction };
type ToastFn = (message: string, opts?: ToastItem['tone'] | ToastOptions) => void;
const ToastCtx = createContext<ToastFn | null>(null);
const noopToast: ToastFn = () => undefined;

function ToastView({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const ms = item.tone === 'error' ? 7000 : item.action ? 8000 : 4000;
    const timer = window.setTimeout(() => onDismiss(item.id), ms);
    return () => window.clearTimeout(timer);
  }, [held, item, onDismiss]);
  return (
    <div
      className={`toast toast--${item.tone}`}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
      }}
    >
      {item.tone === 'ok' ? (
        <CheckCircle2 size={17} aria-hidden />
      ) : (
        <AlertTriangle size={17} aria-hidden />
      )}
      <span className="toast__body">{item.message}</span>
      {item.action && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            onDismiss(item.id);
            void item.action!.run();
          }}
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast__close"
        aria-label="Dismiss"
        onClick={() => onDismiss(item.id)}
      >
        <X size={15} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback(
    (id: number) => setItems((ts) => ts.filter((t) => t.id !== id)),
    [],
  );
  const push = useCallback<ToastFn>((message, opts) => {
    const o: ToastOptions = typeof opts === 'string' ? { tone: opts } : (opts ?? {});
    const id = ++seq.current;
    setItems((ts) => [
      ...ts.slice(-2),
      { id, tone: o.tone ?? 'ok', message, action: o.action },
    ]);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Outside a provider (a print page) a toast is a no-op rather than a crash. */
export function useToast(): ToastFn {
  return useContext(ToastCtx) ?? noopToast;
}

/* ── Confirm ─────────────────────────────────────────────────
   `await confirm({...})` instead of window.confirm: the same one-line call
   site, but a dialog that looks like the product and says what happens. */
export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
}
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn | null>(null);
const nativeConfirm: ConfirmFn = (o) =>
  Promise.resolve(window.confirm(o.body ? `${o.title}\n\n${o.body}` : o.title));

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);
  const confirm = useCallback<ConfirmFn>(
    (o) => new Promise((resolve) => setPending({ ...o, resolve })),
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
        <Modal title={pending.title} onClose={() => settle(false)}>
          <div className="modal__body">
            {pending.body && <p className="modal__text">{pending.body}</p>}
            <div className="modal__foot">
              <div className="modal__foot-right">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => settle(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={`btn ${pending.danger ? 'btn--danger' : 'btn--primary'}`}
                  onClick={() => settle(true)}
                  autoFocus
                >
                  {pending.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

/** Outside a provider it falls back to the browser's dialog, so a call never hangs. */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmCtx) ?? nativeConfirm;
}
