import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { initials, avatarTint } from '../lib/format';

/* ── Avatar ──────────────────────────────────────────────── */
export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const tint = avatarTint(name);
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: tint.bg, color: tint.fg, fontSize: size * 0.38 }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/* ── Status pills — one semantic system across the app ───── */
type PillKind = 'ok' | 'info' | 'warn' | 'danger' | 'neutral';
const PILL_KINDS: readonly string[] = ['ok', 'info', 'warn', 'danger', 'neutral'];

const PILL_MAP: Record<string, { kind: PillKind; label: string }> = {
  // appointments
  scheduled: { kind: 'info', label: 'Scheduled' },
  checked_in: { kind: 'info', label: 'Checked in' },
  // Treatment underway — the one status that should catch the eye on a busy day.
  in_progress: { kind: 'warn', label: 'In progress' },
  completed: { kind: 'ok', label: 'Completed' },
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
  paid: { kind: 'ok', label: 'Paid' },
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
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
      <div className={`${className === 'panel__head' ? 'panel__titles' : 'modal__titles'}`}>
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
  const w = 72, h = 24;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--primary-300)" strokeWidth="1.6" />
    </svg>
  );
}
