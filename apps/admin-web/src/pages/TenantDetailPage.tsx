import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Archive,
  CalendarDays,
  Check,
  ChevronLeft,
  Copy,
  CreditCard,
  Database,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  KeyRound,
  LayoutGrid,
  PauseCircle,
  PlayCircle,
  ReceiptText,
  RotateCcw,
  Settings,
  ShieldOff,
  Trash2,
  Users,
} from 'lucide-react';
import {
  api,
  ApiError,
  clinicHost,
  formatBytes,
  formatEuro,
  generatePassword,
  trialState,
  METHOD_LABELS,
  TENANT_BASE_DOMAIN,
  type Plan,
  type SubdomainCheck,
  type SubscriptionInvoice,
  type TenantDetail,
  type TenantUsage,
} from '../lib/api';
import { dayHeading, describe } from '../lib/activity';
import {
  daysSince,
  fmtDate,
  fmtDateTime,
  fmtDay,
  fmtNumber,
  fmtTime,
  monthLabel,
} from '../lib/format';
import { ColumnChart, ShareBars } from '../components/charts';
import PaymentModal from '../components/PaymentModal';
import { SubdomainState } from '../components/CreateClinicWizard';
import {
  Avatar,
  ClinicMark,
  Empty,
  Modal,
  SkeletonRows,
  StatusPill,
  TrialPill,
  useConfirm,
  useToast,
} from '../components/ui';
import { useCrumb, useShell } from '../components/shell';

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  dentist: 'Dentist',
  hygienist: 'Hygienist',
  assistant: 'Assistant',
  receptionist: 'Reception',
  accountant: 'Accountant',
};

type Tab = 'overview' | 'staff' | 'billing' | 'activity' | 'settings';
const TABS: { key: Tab; label: string; icon: typeof Users }[] = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'staff', label: 'Staff', icon: Users },
  { key: 'billing', label: 'Billing', icon: CreditCard },
  { key: 'activity', label: 'Activity', icon: Activity },
  { key: 'settings', label: 'Settings', icon: Settings },
];

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'overview') as Tab;
  const setTab = (next: Tab) =>
    setParams(next === 'overview' ? {} : { tab: next }, { replace: true });

  const toast = useToast();
  const confirm = useConfirm();
  const { refreshBadges } = useShell();
  const [t, setT] = useState<TenantDetail | null>(null);
  const [usage, setUsage] = useState<TenantUsage | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  useCrumb(t?.name);

  // Which clinic the URL names right now, and which request is the newest.
  // A response is written only if it is still the newest one for that clinic,
  // so a slow load can never show one clinic's staff under another's URL —
  // and "Reset" acts on whichever clinic the URL names.
  const routeId = useRef(id);
  const latest = useRef(0);
  useEffect(() => {
    routeId.current = id;
  }, [id]);

  const load = useCallback(async () => {
    if (!id || id !== routeId.current) return;
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const [detail, u] = await Promise.all([
        api.tenant(id),
        api.tenantUsage(id).catch(() => null),
      ]);
      if (ticket === latest.current) {
        setT(detail);
        setUsage(u);
      }
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void load();
    api
      .plans()
      .then(setPlans)
      .catch(() => setPlans([]));
  }, [load]);

  /** Run an action, show its error, reload. */
  async function act(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (success) toast(success);
      await load();
      refreshBadges();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (loading && !t) {
    return (
      <div className="page">
        <div className="card">
          <SkeletonRows rows={5} />
        </div>
      </div>
    );
  }
  if (!t || !id) {
    return (
      <div className="page">
        <div className="card">
          <Empty
            icon={AlertTriangle}
            title="No such clinic"
            body="It may have been deleted, or the link is wrong."
            action={
              <Link className="btn btn--ghost" to="/clinics">
                All clinics
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const deleted = t.status === 'deleted';
  const host = clinicHost(t.subdomain);

  async function suspend() {
    if (
      await confirm({
        title: `Suspend ${t!.name}?`,
        body: 'Nobody at the clinic can sign in until it is reactivated. Their records are untouched, and it can be reactivated at any time.',
        confirmLabel: 'Suspend clinic',
        icon: PauseCircle,
        tone: 'warn',
      })
    ) {
      void act(() => api.setStatus(id!, 'suspended'), `${t!.name} is suspended.`);
    }
  }

  async function archive() {
    if (
      await confirm({
        title: `Archive ${t!.name}?`,
        body: 'For a clinic that has left. Nobody can sign in; every record is kept. It drops out of billing runs.',
        confirmLabel: 'Archive clinic',
        icon: Archive,
        tone: 'warn',
      })
    ) {
      void act(() => api.setStatus(id!, 'archived'), `${t!.name} is archived.`);
    }
  }

  async function resetPassword(userId: string, name: string) {
    if (
      !(await confirm({
        title: `Issue a new password for ${name}?`,
        body: 'Their current password stops working at once. The new one is shown to you once, to hand over. The clinic sees this in its own activity log.',
        confirmLabel: 'Issue password',
        icon: KeyRound,
        tone: 'warn',
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const password = generatePassword();
      const res = await api.resetUserPassword(id!, userId, password);
      // Shown once. It is bcrypted on the way in and cannot be read back.
      setIssued({ email: res.email, password });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * For a clinic user who has lost their authenticator and their recovery
   * codes. A clinic administrator can do this for colleagues but not for
   * themselves, so for a sole administrator this is the only way back in.
   */
  async function resetMfa(userId: string, name: string) {
    if (
      !(await confirm({
        title: `Reset two-step sign-in for ${name}?`,
        body: 'They are signed out everywhere and set it up again at their next sign-in. The clinic sees this in its own activity log.',
        confirmLabel: 'Reset two-step sign-in',
        icon: ShieldOff,
        tone: 'warn',
      }))
    ) {
      return;
    }
    void act(async () => {
      const res = await api.resetUserMfa(id!, userId);
      toast(
        res.hadFactor
          ? `Two-step sign-in reset for ${res.email}.`
          : `${res.email} had not set up two-step sign-in; their sessions were ended.`,
      );
    });
  }

  return (
    <div className="page">
      <Link to="/clinics" className="back">
        <ChevronLeft size={16} /> All clinics
      </Link>

      <div className="hero">
        <div className="hero__id">
          <ClinicMark name={t.name} size={60} />
          <div style={{ minWidth: 0 }}>
            <h1 className="hero__title">{t.name}</h1>
            <div className="hero__meta">
              {deleted ? (
                <span>{host}</span>
              ) : (
                <a
                  className="hero__host"
                  href={`https://${host}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {host} <ExternalLink size={13} aria-hidden />
                </a>
              )}
              <StatusPill status={t.status} />
              {!deleted && <TrialPill trialEndsAt={t.trial_ends_at} paidLabel={null} />}
              {t.plan_name && (
                <span className="pill pill--plain">
                  {t.plan_name} · {formatEuro(t.price_monthly)}/mo
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="page__actions">
          {!deleted && t.status !== 'active' && (
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() =>
                act(() => api.setStatus(id, 'active'), `${t.name} is active again.`)
              }
            >
              <PlayCircle size={15} aria-hidden /> Reactivate
            </button>
          )}
          {t.status === 'active' && (
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void suspend()}
            >
              <PauseCircle size={15} aria-hidden /> Suspend
            </button>
          )}
          {!deleted && t.status !== 'archived' && (
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void archive()}
            >
              <Archive size={15} aria-hidden /> Archive
            </button>
          )}
          {deleted && (
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() =>
                act(
                  () => api.restoreTenant(id),
                  'Restored as suspended. Reactivate it when the clinic should have access again.',
                )
              }
            >
              <RotateCcw size={15} aria-hidden /> Restore
            </button>
          )}
        </div>
      </div>

      {deleted && (
        <div className="banner" role="status">
          <Trash2 size={16} aria-hidden />
          <span>
            Deleted {t.deleted_at ? fmtDateTime(t.deleted_at) : ''}
            {t.deletion_reason ? ` — “${t.deletion_reason}”` : ''}. Nobody can sign in.
            Every record is intact and can be restored
            {t.purge_after ? ` until at least ${fmtDateTime(t.purge_after)}` : ''};
            nothing is purged automatically.
          </span>
        </div>
      )}
      {!deleted &&
        trialState(t.trial_ends_at).kind === 'expired' &&
        t.status === 'active' && (
          <div className="banner banner--warn" role="status">
            <AlertTriangle size={16} aria-hidden />
            <span>
              The trial has ended, so the clinic is read-only. Mark it as paid or extend
              the trial from the Overview tab.
            </span>
          </div>
        )}
      {error && (
        <p className="formerror" style={{ marginBottom: 16 }}>
          {error}
        </p>
      )}

      <div className="utabs" role="tablist" aria-label="Clinic sections">
        {TABS.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={tab === x.key}
            className={`utab${tab === x.key ? ' utab--active' : ''}`}
            onClick={() => setTab(x.key)}
          >
            <x.icon size={15} aria-hidden />
            {x.label}
            {x.key === 'staff' && <span className="tab__count">{t.staff.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewTab
          t={t}
          usage={usage}
          plans={plans}
          busy={busy}
          act={act}
          confirm={confirm}
        />
      )}

      {tab === 'staff' && (
        <section className="card">
          <div className="card__head">
            <div>
              <h2>Staff</h2>
              <p className="card__sub">
                {t.active_user_count} of {t.user_count} accounts active. Recovery for a
                locked-out colleague starts here.
              </p>
            </div>
          </div>
          {t.staff.length === 0 ? (
            <Empty compact icon={Users} title="No staff accounts" />
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th className="num">Recovery</th>
                  </tr>
                </thead>
                <tbody>
                  {t.staff.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <div className="namecell">
                          <Avatar name={s.full_name} />
                          <div className="namecell__text">
                            <span className="namecell__title">{s.full_name}</span>
                            <span className="namecell__sub">{s.email}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="pill pill--plain">
                          {ROLE_LABEL[s.role] ?? s.role}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`pill ${s.status === 'active' ? 'pill--ok' : 'pill--neutral'}`}
                        >
                          {s.status.charAt(0).toUpperCase() + s.status.slice(1)}
                        </span>
                      </td>
                      <td className="num">
                        <div className="inline" style={{ justifyContent: 'flex-end' }}>
                          <button
                            className="btn btn--ghost btn--sm"
                            disabled={busy || deleted}
                            onClick={() => void resetPassword(s.id, s.full_name)}
                          >
                            <KeyRound size={14} aria-hidden /> New password
                          </button>
                          <button
                            className="btn btn--ghost btn--sm"
                            disabled={busy || deleted}
                            onClick={() => void resetMfa(s.id, s.full_name)}
                            title="Lost phone and recovery codes"
                          >
                            <ShieldOff size={14} aria-hidden /> Reset 2-step
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'billing' && <BillingTab tenantId={id} onChanged={() => void load()} />}

      {tab === 'activity' && (
        <section className="card">
          <div className="card__head">
            <div>
              <h2>Audit trail</h2>
              <p className="card__sub">
                Everything the console has done to this clinic, newest first.
              </p>
            </div>
          </div>
          <Trail audit={t.audit} plans={plans} />
        </section>
      )}

      {tab === 'settings' && (
        <SettingsTab t={t} busy={busy} act={act} confirm={confirm} />
      )}

      {issued && (
        <Modal
          title="New password issued"
          subtitle="Shown once — it is hashed on the way in and cannot be read back. The clinic sees this reset in its own activity log."
          icon={KeyRound}
          iconTone="ok"
          onClose={() => setIssued(null)}
          dismissable={false}
        >
          <IssuedBody issued={issued} onDone={() => setIssued(null)} />
        </Modal>
      )}
    </div>
  );
}

function IssuedBody({
  issued,
  onDone,
}: {
  issued: { email: string; password: string };
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const text = `Email:    ${issued.email}\nPassword: ${issued.password}`;
  return (
    <div className="modal__body">
      <pre className="handover">{text}</pre>
      <div className="modal__foot">
        <button
          type="button"
          className="btn btn--ghost modal__foot-left"
          onClick={async () => {
            await navigator.clipboard.writeText(
              `Email: ${issued.email}\nPassword: ${issued.password}`,
            );
            setCopied(true);
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn--primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, success?: string) => Promise<void>;
type Confirm = ReturnType<typeof useConfirm>;

/* ── overview ─────────────────────────────────────────────── */

function OverviewTab({
  t,
  usage,
  plans,
  busy,
  act,
  confirm,
}: {
  t: TenantDetail;
  usage: TenantUsage | null;
  plans: Plan[];
  busy: boolean;
  act: Act;
  confirm: Confirm;
}) {
  const deleted = t.status === 'deleted';
  const trial = trialState(t.trial_ends_at);
  const quiet = usage ? daysSince(usage.lastActivity) : null;

  // The clinic's own revenue is in this response too, and stays unread: the
  // console reports counts and sizes, never a clinic's takings.
  const months = useMemo(
    () =>
      (usage?.months ?? []).map((m) => ({
        key: m.month,
        label: monthLabel(m.month),
        title: monthLabel(m.month, 'long'),
        appointments: m.appointments,
        invoices: m.invoices,
      })),
    [usage],
  );

  return (
    <>
      <section className="card">
        <div className="stats">
          <div className="stat">
            <span className="stat__label">Active users</span>
            <span className="stat__value">
              {t.active_user_count}
              <small>of {t.user_count}</small>
            </span>
          </div>
          <div className="stat">
            <span className="stat__label">Patients</span>
            <span className="stat__value">{fmtNumber(t.patient_count)}</span>
          </div>
          <div className="stat">
            <span className="stat__label">Appointments this month</span>
            <span className="stat__value">{fmtNumber(t.appointments_this_month)}</span>
          </div>
          <div className="stat">
            <span className="stat__label">Storage</span>
            <span className="stat__value">{formatBytes(t.storage_bytes)}</span>
          </div>
        </div>
      </section>

      <div className="grid">
        <div className="stack span-8">
          <section className="card">
            <div className="card__head">
              <div>
                <h2>Use of the product</h2>
                <p className="card__sub">
                  Last six months.{' '}
                  {usage?.lastActivity
                    ? `Last activity ${quiet === 0 ? 'today' : quiet === 1 ? 'yesterday' : `${quiet} days ago`}.`
                    : 'No activity recorded yet.'}
                </p>
              </div>
              {quiet !== null && quiet > 30 && (
                <span className="pill pill--warn">Quiet for {quiet} days</span>
              )}
            </div>
            {usage ? (
              <div className="minis">
                <div>
                  <div style={{ padding: '14px var(--gutter) 0' }}>
                    <p className="mini__title">Appointments</p>
                    <p className="mini__value">
                      {fmtNumber(usage.appointments30d)}{' '}
                      <small className="muted" style={{ fontSize: 13, fontWeight: 500 }}>
                        in 30 days
                      </small>
                    </p>
                  </div>
                  <ColumnChart
                    columns={months.map((m) => ({ ...m, values: [m.appointments] }))}
                    series={[{ name: 'Appointments', color: 'var(--data-1)' }]}
                    format={(n) => fmtNumber(n)}
                    integer
                    height={180}
                    ariaLabel="Appointments per month"
                  />
                </div>
                <div>
                  <div style={{ padding: '14px var(--gutter) 0' }}>
                    <p className="mini__title">Invoices issued</p>
                    <p className="mini__value">
                      {fmtNumber(usage.invoices)}{' '}
                      <small className="muted" style={{ fontSize: 13, fontWeight: 500 }}>
                        all time
                      </small>
                    </p>
                  </div>
                  <ColumnChart
                    columns={months.map((m) => ({ ...m, values: [m.invoices] }))}
                    series={[{ name: 'Invoices', color: 'var(--data-1)' }]}
                    format={(n) => fmtNumber(n)}
                    integer
                    height={180}
                    ariaLabel="Invoices issued per month"
                  />
                </div>
              </div>
            ) : (
              <SkeletonRows rows={3} />
            )}
          </section>

          {usage && usage.storageByKind.length > 0 && (
            <section className="card">
              <div className="card__head">
                <div>
                  <h2>
                    <HardDrive size={16} aria-hidden /> Where the storage is
                  </h2>
                  <p className="card__sub">
                    {fmtNumber(usage.documents)} files · {formatBytes(usage.storageBytes)}
                  </p>
                </div>
              </div>
              <ShareBars
                empty="No files stored."
                rows={usage.storageByKind.map((k) => ({
                  key: k.kind,
                  label: k.kind.replace(/_/g, ' '),
                  value: k.bytes,
                  display: formatBytes(k.bytes),
                  note: `${fmtNumber(k.files)} files`,
                }))}
              />
            </section>
          )}
        </div>

        <div className="stack span-4">
          <section className="card">
            <div className="card__head">
              <h2>Subscription</h2>
              <TrialPill trialEndsAt={t.trial_ends_at} />
            </div>
            <div className="section">
              <label className="field">
                <span>Plan</span>
                <select
                  value={t.plan_id ?? ''}
                  disabled={busy || deleted}
                  onChange={(e) => {
                    const next = plans.find((p) => p.id === e.target.value);
                    void act(
                      () => api.setPlan(t.id, e.target.value || null),
                      next ? `Now on ${next.name}.` : 'Plan removed.',
                    );
                  }}
                >
                  <option value="">No plan</option>
                  {/* A retired plan is not offered, but a clinic still on one keeps showing it. */}
                  {t.plan_id && !plans.some((p) => p.id === t.plan_id) && (
                    <option value={t.plan_id}>{t.plan_name} (retired)</option>
                  )}
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {formatEuro(p.price_monthly)}/mo
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint">
                {trial.kind === 'paid'
                  ? 'Paid — no restriction. Billed on every monthly run while active.'
                  : trial.kind === 'running'
                    ? `Trial ends ${fmtDateTime(trial.endsAt)}. Not billed until then.`
                    : `Trial ended ${fmtDateTime(trial.endsAt)}; the clinic is read-only until it is marked as paid or extended.`}
              </p>
              <div className="inline">
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={busy || deleted}
                  onClick={() =>
                    act(() => api.setTrial(t.id, 7), 'Trial set to seven days from now.')
                  }
                >
                  {t.trial_ends_at ? '+7 days' : 'Start 7-day trial'}
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={busy || deleted}
                  onClick={() =>
                    act(
                      () => api.setTrial(t.id, 30),
                      'Trial set to thirty days from now.',
                    )
                  }
                >
                  {t.trial_ends_at ? '+30 days' : 'Start 30-day trial'}
                </button>
                {t.trial_ends_at && (
                  <button
                    className="btn btn--ok-ghost btn--sm"
                    disabled={busy}
                    onClick={() =>
                      act(
                        () => api.setTrial(t.id, null),
                        'Marked as paid. The read-only lock is lifted.',
                      )
                    }
                  >
                    <Check size={14} aria-hidden /> Mark as paid
                  </button>
                )}
                {trial.kind === 'running' && (
                  <button
                    className="btn btn--danger-ghost btn--sm"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: 'End the trial now?',
                          body: 'The clinic becomes read-only at once, until it is marked as paid or given more days.',
                          confirmLabel: 'End trial',
                          tone: 'danger',
                        })
                      ) {
                        void act(
                          () => api.setTrial(t.id, 0),
                          'Trial ended. The clinic is read-only.',
                        );
                      }
                    }}
                  >
                    End trial
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card__head">
              <h2>Details</h2>
            </div>
            <dl className="kv">
              <div>
                <dt>Owner</dt>
                <dd>{t.owner_email ?? '—'}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{t.phone ?? '—'}</dd>
              </div>
              <div>
                <dt>City</dt>
                <dd>{t.city ?? '—'}</dd>
              </div>
              <div>
                <dt>NIPT</dt>
                <dd>
                  {t.tax_number ? <span className="mono">{t.tax_number}</span> : '—'}
                </dd>
              </div>
              <div>
                <dt>Currency · zone</dt>
                <dd>
                  {t.currency ?? '—'} · {t.timezone ?? '—'}
                </dd>
              </div>
              <div>
                <dt>Fiscalization</dt>
                <dd>
                  {t.fiscalization_enabled ? (
                    <span className="pill pill--ok">On</span>
                  ) : (
                    <span className="pill pill--neutral">Off</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{fmtDateTime(t.created_at)}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}

/* ── billing ──────────────────────────────────────────────── */

/**
 * This clinic's own billing history.
 *
 * The fleet view answers "who owes us"; this answers "is THIS clinic good",
 * which is the question being asked when someone has already opened one
 * clinic — usually just before deciding whether to suspend it.
 */
function BillingTab({
  tenantId,
  onChanged,
}: {
  tenantId: string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<SubscriptionInvoice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [paying, setPaying] = useState<SubscriptionInvoice | null>(null);

  const load = useCallback(() => {
    api
      .tenantInvoices(tenantId)
      .then((r) => {
        setRows(r);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [tenantId]);
  useEffect(load, [load]);

  const totals = useMemo(() => {
    const r = rows ?? [];
    return {
      paid: r
        .filter((i) => i.status === 'paid')
        .reduce((s, i) => s + (i.paidAmount ?? i.amount), 0),
      open: r.filter((i) => i.status === 'open').reduce((s, i) => s + i.amount, 0),
      overdue: r
        .filter((i) => i.status === 'open' && i.overdue)
        .reduce((s, i) => s + i.amount, 0),
    };
  }, [rows]);

  return (
    <>
      <section className="card">
        <div
          className="stats"
          style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
        >
          <div className="stat">
            <span className="stat__label">Paid to date</span>
            <span className="stat__value">{formatEuro(totals.paid)}</span>
          </div>
          <div className="stat">
            <span className="stat__label">Open</span>
            <span className="stat__value">{formatEuro(totals.open)}</span>
          </div>
          <div className="stat">
            <span className="stat__label">Overdue</span>
            <span
              className="stat__value"
              style={totals.overdue ? { color: 'var(--danger-fg)' } : undefined}
            >
              {formatEuro(totals.overdue)}
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <div>
            <h2>Subscription invoices</h2>
            <p className="card__sub">
              What this clinic has been billed by NODE X, and what it has paid.
            </p>
          </div>
        </div>
        {failed ? (
          <p className="pad formerror">Could not load the billing history.</p>
        ) : rows === null ? (
          <SkeletonRows rows={3} />
        ) : rows.length === 0 ? (
          <Empty
            compact
            icon={ReceiptText}
            title="Never invoiced"
            body={
              <>
                Invoices are issued by the monthly run on the{' '}
                <Link to="/billing">Billing</Link> screen.
              </>
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Period</th>
                  <th className="num">Amount</th>
                  <th>Due</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <span className="mono">{i.number}</span>
                      {i.planName && <span className="cell-sub">{i.planName}</span>}
                    </td>
                    <td>{monthLabel(i.periodStart.slice(0, 7), 'long')}</td>
                    <td className="num">{formatEuro(i.amount)}</td>
                    <td>
                      {fmtDay(i.dueDate)}
                      {i.overdue && (
                        <span className="cell-sub cell-sub--alert">
                          {i.daysLate} days late
                        </span>
                      )}
                    </td>
                    <td>
                      <InvoiceState i={i} />
                    </td>
                    <td className="num">
                      {i.status === 'open' && (
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => setPaying(i)}
                        >
                          <Check size={14} aria-hidden /> Record payment
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {paying && (
        <PaymentModal
          invoice={paying}
          onClose={() => setPaying(null)}
          onDone={(outcome) => {
            toast(
              outcome === 'paid'
                ? `Payment recorded against ${paying.number}.`
                : `${paying.number} voided.`,
            );
            setPaying(null);
            load();
            onChanged();
          }}
        />
      )}
    </>
  );
}

export function InvoiceState({ i }: { i: SubscriptionInvoice }) {
  if (i.status === 'paid') {
    return (
      <>
        <span className="pill pill--ok">Paid</span>
        <span className="cell-sub">
          {[
            i.method ? METHOD_LABELS[i.method] : null,
            i.paidAt ? fmtDate(i.paidAt) : null,
            i.reference,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </>
    );
  }
  if (i.status === 'void') return <span className="pill pill--neutral">Void</span>;
  if (i.status === 'uncollectible')
    return <span className="pill pill--neutral">Uncollectible</span>;
  if (i.overdue) {
    return (
      <span className="pill pill--danger">
        <AlertTriangle size={12} aria-hidden /> Overdue
      </span>
    );
  }
  return <span className="pill pill--warn">Open</span>;
}

/* ── activity ─────────────────────────────────────────────── */

function Trail({ audit, plans }: { audit: TenantDetail['audit']; plans: Plan[] }) {
  const planMap = useMemo(() => new Map(plans.map((p) => [p.id, p.name])), [plans]);
  if (audit.length === 0) {
    return <Empty compact icon={Activity} title="Nothing recorded yet" />;
  }
  let lastDay = '';
  return (
    <ul className="feed">
      {audit.flatMap((a) => {
        const d = describe(a, planMap);
        const day = dayHeading(a.created_at);
        const header = day !== lastDay ? day : null;
        lastDay = day;
        return [
          header && (
            <li key={`day-${a.id}`} className="feed__day">
              {header}
            </li>
          ),
          <li key={a.id} className="feed__item">
            <span className={`feed__icon feed__icon--${d.tone}`}>
              <d.icon size={14} aria-hidden />
            </span>
            <div className="feed__body">
              <span className="feed__title">
                <b>{d.verb.replace(/ (of|at)$/, '')}</b>
              </span>
              {d.detail && <span className="feed__detail">{d.detail}</span>}
              <span className="feed__meta">
                {a.actor_label} · {fmtTime(a.created_at)}
              </span>
            </div>
          </li>,
        ];
      })}
    </ul>
  );
}

/* ── settings ─────────────────────────────────────────────── */

function SettingsTab({
  t,
  busy,
  act,
  confirm,
}: {
  t: TenantDetail;
  busy: boolean;
  act: Act;
  confirm: Confirm;
}) {
  const deleted = t.status === 'deleted';
  const [subdomain, setSubdomain] = useState(t.subdomain);
  const [check, setCheck] = useState<SubdomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => setSubdomain(t.subdomain), [t.subdomain]);

  useEffect(() => {
    const name = subdomain.trim();
    if (!name || name === t.subdomain) {
      setCheck(null);
      setChecking(false);
      return;
    }
    let stale = false;
    setChecking(true);
    const timer = window.setTimeout(() => {
      api
        .checkSubdomain(name, t.id)
        .then((c) => !stale && setCheck(c))
        .catch(() => !stale && setCheck(null))
        .finally(() => !stale && setChecking(false));
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [subdomain, t.subdomain, t.id]);

  const changed = subdomain.trim() !== t.subdomain && subdomain.trim() !== '';

  return (
    <div className="grid">
      <div className="stack span-7">
        <section className="card">
          <div className="card__head">
            <h2>
              <Globe size={16} aria-hidden /> Web address
            </h2>
          </div>
          <div className="section">
            <label className="field">
              <span>Subdomain</span>
              <div className="suffixed">
                <input
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
                  disabled={deleted}
                  aria-describedby="settings-subdomain"
                />
                <span>.{TENANT_BASE_DOMAIN}</span>
              </div>
              {changed ? (
                <SubdomainState
                  id="settings-subdomain"
                  checking={checking}
                  check={check}
                  empty={false}
                />
              ) : (
                <span id="settings-subdomain" className="field__hint">
                  Bookmarks and saved sign-ins on the old address stop working the moment
                  it changes.
                </span>
              )}
            </label>
            <div className="inline">
              <button
                className="btn btn--primary btn--sm"
                disabled={
                  busy || deleted || !changed || checking || check?.available !== true
                }
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Move to ${clinicHost(subdomain)}?`,
                      body: `Bookmarks and saved sign-ins on ${clinicHost(t.subdomain)} stop working immediately. Tell the clinic before you do this.`,
                      confirmLabel: 'Change address',
                      icon: Globe,
                      tone: 'warn',
                    })
                  ) {
                    void act(
                      () => api.changeSubdomain(t.id, subdomain.trim()),
                      `Now at ${clinicHost(subdomain.trim())}.`,
                    );
                  }
                }}
              >
                Change address
              </button>
              {changed && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => setSubdomain(t.subdomain)}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card__head">
            <h2>
              <Database size={16} aria-hidden /> Data export
            </h2>
          </div>
          <div className="section">
            <p className="hint">
              A JSON copy of every record of this clinic, with passwords, second factors
              and signing keys left out. For a clinic that is leaving, or before anything
              irreversible. It is not the platform backup: database restores are done from
              the provider's point-in-time recovery.
            </p>
            <div className="inline">
              <button
                className="btn btn--ghost btn--sm"
                disabled={busy}
                onClick={() =>
                  act(
                    () => api.exportTenant(t.id, `${t.subdomain}.json`),
                    'Export downloaded and recorded in the audit trail.',
                  )
                }
              >
                <Download size={14} aria-hidden /> Export clinic data
              </button>
            </div>
          </div>
        </section>
      </div>

      <div className="stack span-5">
        {!deleted && (
          <section className="card danger">
            <div className="card__head">
              <h2>
                <Trash2 size={16} aria-hidden /> Delete clinic
              </h2>
            </div>
            <div className="section">
              <p className="hint">
                Access stops at once. Records are kept and can be restored for at least 30
                days; nothing is purged automatically.
              </p>
              {deleting ? (
                <DeleteForm
                  subdomain={t.subdomain}
                  busy={busy}
                  onCancel={() => setDeleting(false)}
                  onConfirm={(confirmText, reason) =>
                    act(async () => {
                      await api.deleteTenant(t.id, confirmText, reason);
                      setDeleting(false);
                    }, `${t.name} deleted. It can be restored from its page.`)
                  }
                />
              ) : (
                <div className="inline">
                  <button
                    className="btn btn--danger-ghost btn--sm"
                    onClick={() => setDeleting(true)}
                  >
                    <Trash2 size={14} aria-hidden /> Delete…
                  </button>
                </div>
              )}
            </div>
          </section>
        )}
        <section className="card">
          <div className="card__head">
            <h2>
              <CalendarDays size={16} aria-hidden /> Lifecycle
            </h2>
          </div>
          <dl className="kv">
            <div>
              <dt>Created</dt>
              <dd>{fmtDateTime(t.created_at)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <StatusPill status={t.status} />
              </dd>
            </div>
            {t.deleted_at && (
              <div>
                <dt>Deleted</dt>
                <dd>{fmtDateTime(t.deleted_at)}</dd>
              </div>
            )}
            {t.purge_after && (
              <div>
                <dt>Restorable until</dt>
                <dd>{fmtDateTime(t.purge_after)}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>
    </div>
  );
}

/** Typing the subdomain again is a confirmation no stray click can give. */
function DeleteForm({
  subdomain,
  busy,
  onCancel,
  onConfirm,
}: {
  subdomain: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (confirm: string, reason: string) => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');
  return (
    <>
      <label className="field">
        <span>Reason</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Recorded in the audit trail"
          maxLength={300}
          autoFocus
        />
      </label>
      <label className="field">
        <span>
          Type <span className="mono">{subdomain}</span> to confirm
        </span>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          autoComplete="off"
        />
      </label>
      <div className="inline">
        <button className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn--danger btn--sm"
          disabled={busy || confirmText !== subdomain || reason.trim().length < 3}
          onClick={() => onConfirm(confirmText, reason.trim())}
        >
          Delete clinic
        </button>
      </div>
    </>
  );
}
