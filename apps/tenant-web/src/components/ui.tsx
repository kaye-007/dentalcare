import type { ReactNode } from 'react';
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
  paid: { kind: 'ok', label: 'Paid' },
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const m = PILL_MAP[status] ?? { kind: 'neutral' as PillKind, label: status };
  return <span className={`pill pill--${m.kind}`}>{label ?? m.label}</span>;
}

/* ── Page header — single pattern for every module page ──── */
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
          {title && <h2 className="section-title">{title}</h2>}
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

/* ── Modal ────────────────────────────────────────────────── */
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
  return (
    <div className="modal__overlay" onClick={onClose}>
      <div className={`modal${wide ? ' modal--wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>{title}</h2>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
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
      <polyline points={pts} fill="none" stroke="var(--teal-300)" strokeWidth="1.6" />
    </svg>
  );
}
