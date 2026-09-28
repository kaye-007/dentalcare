import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, KeyRound, Lock, Plus, ShieldCheck, UserCog } from 'lucide-react';
import {
  ApiError,
  availabilityApi,
  closuresApi,
  fiscalApi,
  staffApi,
  type AvailabilityEntry,
  type Closure,
  type StaffFull,
  humanError,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, EmptyState, Modal, PageHeader, SidePanel, StatusPill, LoadingRows } from '../components/ui';
import { plural, toDate } from '../lib/format';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from '../lib/permissions';
import { dateLocale } from '../lib/strings';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Roles whose people see patients unless the clinic says otherwise. */
const TREATING: Role[] = ['dentist', 'hygienist'];

function fmtDate(s: string) {
  return toDate(s).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The team: one list, one profile per person.
 *
 *   list     who they are, what they may do (role), whether they see patients,
 *            whether their sign-in is protected; disabled accounts apart
 *   profile  details and access · calendar · sign-in and security · fiscal
 *            operator code — everything about one person in one place
 *
 * Role is what someone may do in the app. "Sees patients" is whether they
 * have a calendar column — the two are separate, so a dentist does not have
 * to be an administrator to be on the calendar.
 */
export default function StaffPage() {
  const { user, can } = useAuth();
  const canManage = can('staff:manage');
  const [items, setItems] = useState<StaffFull[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showDisabled, setShowDisabled] = useState(false);

  const load = () =>
    staffApi
      .list()
      .then((l) => {
        setItems(l);
        setError(null);
      })
      .catch((e) => setError(humanError(e)));

  useEffect(() => {
    if (canManage) void load();
  }, [canManage]);

  const active = useMemo(() => (items ?? []).filter((s) => s.status === 'active'), [items]);
  const disabled = useMemo(() => (items ?? []).filter((s) => s.status !== 'active'), [items]);

  if (!canManage) {
    return (
      <div className="page">
        <EmptyState
          framed
          icon={<Lock size={22} />}
          title="Administrator access only"
          body="Staff accounts are managed by the clinic’s administrators."
        />
      </div>
    );
  }

  const open = items?.find((s) => s.id === openId) ?? null;
  const treating = active.filter((s) => s.seesPatients).length;

  return (
    <div className="page">
      <PageHeader
        title="Staff"
        meta={items ? `${plural(active.length, 'active member')} · ${treating} see patients` : '…'}
        actions={
          <button className="btn btn--primary" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add staff
          </button>
        }
      />
      {error && <p className="formerror">{error}</p>}

      <section className="card">
        {items === null ? (
          <LoadingRows rows={3} label="Loading" />
        ) : active.length === 0 ? (
          <EmptyState icon={<UserCog size={22} />} title="No staff yet" body="Add your first team member." />
        ) : (
          <StaffTable rows={active} selfId={user?.id} onOpen={setOpenId} />
        )}
      </section>

      {disabled.length > 0 && (
        <section className="card staff-disabled">
          <button
            type="button"
            className="staff-disabled__toggle"
            aria-expanded={showDisabled}
            onClick={() => setShowDisabled((v) => !v)}
          >
            <span>
              Disabled accounts <span className="muted">({disabled.length})</span>
            </span>
            <ChevronRight size={16} className={showDisabled ? 'is-open' : ''} aria-hidden />
          </button>
          {showDisabled && <StaffTable rows={disabled} selfId={user?.id} onOpen={setOpenId} />}
        </section>
      )}

      {open && (
        <StaffProfile
          member={open}
          isSelf={open.id === user?.id}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      )}
      {adding && (
        <AddStaffModal
          onClose={() => setAdding(false)}
          onSaved={(created) => {
            setAdding(false);
            void load().then(() => setOpenId(created.id));
          }}
        />
      )}
    </div>
  );
}

function StaffTable({
  rows,
  selfId,
  onOpen,
}: {
  rows: StaffFull[];
  selfId: string | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Person</th>
            <th className="hide-sm">Access</th>
            <th className="hide-sm hide-md">Sees patients</th>
            <th className="hide-sm hide-md">Two-step sign-in</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="row--click" onClick={() => onOpen(s.id)}>
              <td>
                <div className="namecell">
                  <Avatar name={s.fullName} size={32} />
                  <span>
                    <button
                      type="button"
                      className="table__link linkbtn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(s.id);
                      }}
                    >
                      {s.fullName}
                    </button>
                    {s.id === selfId && <span className="muted"> (you)</span>}
                    <span className="cell-sub cell-sub--block hide-sm">
                      {s.position ? `${s.position} · ` : ''}
                      {s.email}
                    </span>
                    {/* On a phone: the role and whether sign-in is protected. */}
                    <span className="cell-sub only-sm">
                      {ROLE_LABELS[s.role]} · two-step {s.twoStepEnabled ? 'on' : 'off'}
                    </span>
                  </span>
                </div>
              </td>
              <td className="hide-sm">
                <StatusPill status={s.role === 'admin' ? 'info' : 'neutral'} label={ROLE_LABELS[s.role]} />
              </td>
              <td className="hide-sm hide-md">
                {s.seesPatients ? <span className="staff-yes">Yes</span> : <span className="muted">—</span>}
              </td>
              <td className="hide-sm hide-md">
                {s.twoStepEnabled ? (
                  <span className="staff-yes">
                    <ShieldCheck size={14} aria-hidden /> On
                  </span>
                ) : (
                  <span className="muted">Off</span>
                )}
              </td>
              <td style={{ textAlign: 'right' }}>
                <ChevronRight size={16} className="muted" aria-hidden />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── one person ─────────────────────────────────────────── */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel__section staff-section">
      <h3 className="panel__section-title">{title}</h3>
      {children}
    </section>
  );
}

function StaffProfile({
  member,
  isSelf,
  onClose,
  onChanged,
}: {
  member: StaffFull;
  isSelf: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [fullName, setFullName] = useState(member.fullName);
  const [position, setPosition] = useState(member.position ?? '');
  const [role, setRole] = useState<Role>(member.role);
  const [seesPatients, setSeesPatients] = useState(member.seesPatients);
  const [busy, setBusy] = useState<null | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'mfa' | 'disable'>(null);
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [operatorCode, setOperatorCode] = useState(member.fiscalOperatorCode ?? '');
  const [hours, setHours] = useState<AvailabilityEntry[] | null>(null);
  const [timeOff, setTimeOff] = useState<Closure[] | null>(null);

  useEffect(() => {
    if (!member.seesPatients) return;
    availabilityApi.list(member.id).then(setHours).catch(() => setHours([]));
    const today = new Date().toISOString().slice(0, 10);
    const inAYear = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    closuresApi
      .list(today, inAYear)
      .then((all) => setTimeOff(all.filter((c) => c.staffId === member.id)))
      .catch(() => setTimeOff([]));
  }, [member.id, member.seesPatients]);

  const dirty =
    fullName.trim() !== member.fullName ||
    (position.trim() || null) !== (member.position ?? null) ||
    role !== member.role ||
    seesPatients !== member.seesPatients;

  async function run(kind: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function saveDetails(e: FormEvent) {
    e.preventDefault();
    await run(
      'details',
      () =>
        staffApi.update(member.id, {
          fullName: fullName.trim(),
          position: position.trim() || null,
          seesPatients,
          ...(isSelf ? {} : { role }),
        }),
      role !== member.role
        ? `Saved. ${member.fullName} is signed out and signs in again with the new access.`
        : 'Saved.',
    );
  }

  const disabled = member.status !== 'active';

  return (
    <SidePanel title={member.fullName} subtitle={`${ROLE_LABELS[member.role]} · ${member.email}`} onClose={onClose} wide>
      <div className="panel__body staff-profile">
        {notice && (
          <p className="channel-note" role="status" style={{ marginTop: 0 }}>
            {notice}
          </p>
        )}
        {error && <p className="formerror">{error}</p>}
        {disabled && (
          <p className="alertbanner alertbanner--muted" role="status">
            This account is disabled: {member.fullName.split(' ')[0]} cannot sign in.
          </p>
        )}

        <Section title="Details and access">
          <form className="form staff-form" onSubmit={saveDetails}>
            <div className="grid2">
              <label className="field">
                <span>Full name</span>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} />
              </label>
              <label className="field">
                <span>Job title</span>
                <input
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  placeholder="e.g. Orthodontist, Clinic manager"
                  maxLength={80}
                />
              </label>
            </div>
            <label className="field">
              <span>Access</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={isSelf}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <small className="muted">{isSelf ? 'You cannot change your own access.' : ROLE_DESCRIPTIONS[role]}</small>
            </label>
            <label className="checkrow">
              <input type="checkbox" checked={seesPatients} onChange={(e) => setSeesPatients(e.target.checked)} />
              <span>
                <strong>Sees patients.</strong> Has a column on the calendar, working hours, and appointments in their
                name.
              </span>
            </label>
            <div className="staff-form__foot">
              <button className="btn btn--primary btn--sm" disabled={!dirty || busy !== null}>
                {busy === 'details' ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </Section>

        {member.seesPatients && (
          <Section title="Calendar">
            <div className="staff-cal">
              <div>
                <p className="staff-cal__label">Working hours</p>
                {hours === null ? (
                  <p className="muted small">Loading…</p>
                ) : hours.length === 0 ? (
                  <p className="muted small">None set — they can be booked at any time the clinic is open.</p>
                ) : (
                  <ul className="staff-hours">
                    {hours
                      .slice()
                      .sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.startsAt.localeCompare(b.startsAt))
                      .map((h) => (
                        <li key={h.id}>
                          <span>{WEEKDAYS[h.weekday]}</span> {h.startsAt.slice(0, 5)}–{h.endsAt.slice(0, 5)}
                        </li>
                      ))}
                  </ul>
                )}
                <Link to="/rooms" className="table__link small">
                  Change working hours
                </Link>
              </div>
              <div>
                <p className="staff-cal__label">Time off</p>
                {timeOff === null ? (
                  <p className="muted small">Loading…</p>
                ) : timeOff.length === 0 ? (
                  <p className="muted small">Nothing coming up.</p>
                ) : (
                  <ul className="staff-hours">
                    {timeOff.map((c) => (
                      <li key={c.id}>
                        {fmtDate(c.startsOn)}
                        {c.endsOn !== c.startsOn ? ` – ${fmtDate(c.endsOn)}` : ''}
                        {c.reason ? <span className="muted"> · {c.reason}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <Link to="/settings?tab=schedule" className="table__link small">
                  Add time off
                </Link>
              </div>
            </div>
          </Section>
        )}

        <Section title="Sign-in and security">
          <ul className="staff-security">
            <li>
              <span>
                <strong>Two-step sign-in</strong>
                <span className="muted small">
                  {member.twoStepEnabled ? ' On — a code from their phone at every sign-in.' : ' Not set up yet.'}
                </span>
              </span>
              {!isSelf && member.twoStepEnabled && confirm !== 'mfa' && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirm('mfa')}>
                  <KeyRound size={14} aria-hidden /> Reset
                </button>
              )}
            </li>
            {confirm === 'mfa' && (
              <li className="staff-confirm">
                <span className="small">
                  For a lost phone. {member.fullName} is signed out everywhere and sets two-step sign-in up again next
                  time.
                </span>
                <span className="inline-row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger-ghost btn--sm"
                    disabled={busy !== null}
                    onClick={async () => {
                      if (await run('mfa', () => staffApi.resetMfa(member.id), 'Two-step sign-in reset.')) setConfirm(null);
                    }}
                  >
                    Reset two-step sign-in
                  </button>
                </span>
              </li>
            )}

            {!isSelf && (
              <li>
                <span>
                  <strong>Password</strong>
                  <span className="muted small"> Set a temporary password when they cannot sign in.</span>
                </span>
                {newPassword === null && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewPassword('')}>
                    Set new password
                  </button>
                )}
              </li>
            )}
            {newPassword !== null && (
              <li className="staff-confirm">
                <form
                  className="inline-row staff-password"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await run(
                        'password',
                        () => staffApi.resetPassword(member.id, newPassword),
                        'Password changed. Give it to them in person; they are signed out everywhere.',
                      )
                    ) {
                      setNewPassword(null);
                    }
                  }}
                >
                  <input
                    type="text"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    minLength={8}
                    required
                    aria-label="New temporary password"
                  />
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewPassword(null)}>
                    Cancel
                  </button>
                  <button className="btn btn--primary btn--sm" disabled={busy !== null}>
                    {busy === 'password' ? 'Saving…' : 'Save password'}
                  </button>
                </form>
              </li>
            )}

            {!isSelf && (
              <li>
                <span>
                  <strong>{disabled ? 'Account disabled' : 'Account'}</strong>
                  <span className="muted small">
                    {disabled
                      ? ' Cannot sign in. History and appointments are kept.'
                      : ' Disabling signs them out everywhere; nothing is deleted.'}
                  </span>
                </span>
                {disabled ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy !== null}
                    onClick={() => void run('status', () => staffApi.update(member.id, { status: 'active' }), 'Account enabled.')}
                  >
                    Enable
                  </button>
                ) : (
                  confirm !== 'disable' && (
                    <button type="button" className="btn btn--danger-ghost btn--sm" onClick={() => setConfirm('disable')}>
                      Disable
                    </button>
                  )
                )}
              </li>
            )}
            {confirm === 'disable' && (
              <li className="staff-confirm">
                <span className="small">Disable {member.fullName}? They are signed out now and cannot sign in again.</span>
                <span className="inline-row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger-ghost btn--sm"
                    disabled={busy !== null}
                    onClick={async () => {
                      if (await run('status', () => staffApi.update(member.id, { status: 'disabled' }), 'Account disabled.')) {
                        setConfirm(null);
                      }
                    }}
                  >
                    Disable account
                  </button>
                </span>
              </li>
            )}
          </ul>
        </Section>

        <Section title="Fiscal receipts">
          <form
            className="inline-row staff-fiscal"
            onSubmit={(e) => {
              e.preventDefault();
              const code = operatorCode.trim().toLowerCase();
              if (code && !/^[a-z]{2}\d{3}[a-z]{2}\d{3}$/.test(code)) {
                setError('Operator codes look like ab123ab123: two letters, three digits, two letters, three digits.');
                return;
              }
              void run('fiscal', () => fiscalApi.setOperatorCode(member.id, code || null), 'Operator code saved.');
            }}
          >
            <label className="field" style={{ flex: 1 }}>
              <span>Operator code</span>
              <input
                className="wa-mono"
                value={operatorCode}
                onChange={(e) => setOperatorCode(e.target.value)}
                placeholder="ab123ab123"
                maxLength={10}
              />
              <small className="muted">From the tax authority, for anyone who issues fiscal receipts.</small>
            </label>
            <button
              className="btn btn--ghost btn--sm"
              disabled={busy !== null || operatorCode.trim().toLowerCase() === (member.fiscalOperatorCode ?? '')}
            >
              {busy === 'fiscal' ? 'Saving…' : 'Save'}
            </button>
          </form>
        </Section>
      </div>
    </SidePanel>
  );
}

/* ── add someone ────────────────────────────────────────── */

function AddStaffModal({ onClose, onSaved }: { onClose: () => void; onSaved: (s: StaffFull) => void }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('dentist');
  const [position, setPosition] = useState('');
  const [seesPatients, setSeesPatients] = useState(true);
  const [touchedSees, setTouchedSees] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pickRole(r: Role) {
    setRole(r);
    // Follows the role until someone decides otherwise.
    if (!touchedSees) setSeesPatients(TREATING.includes(r));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await staffApi.create({
          fullName: fullName.trim(),
          email: email.trim(),
          password,
          role,
          position: position.trim() || undefined,
          seesPatients,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the staff member.');
      setBusy(false);
    }
  }

  return (
    <Modal wide title="Add staff member" subtitle="They sign in with the temporary password you set here." onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <div className="grid2">
          <label className="field">
            <span>Full name</span>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} autoFocus />
          </label>
          <label className="field">
            <span>Job title</span>
            <input
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="e.g. Orthodontist, Clinic manager"
              maxLength={80}
            />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@clinic.com" required />
          </label>
          <label className="field">
            <span>Temporary password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              required
              minLength={8}
            />
          </label>
        </div>
        <label className="field">
          <span>Access</span>
          <select value={role} onChange={(e) => pickRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <small className="muted">{ROLE_DESCRIPTIONS[role]}</small>
        </label>
        <label className="checkrow">
          <input
            type="checkbox"
            checked={seesPatients}
            onChange={(e) => {
              setTouchedSees(true);
              setSeesPatients(e.target.checked);
            }}
          />
          <span>
            <strong>Sees patients.</strong> Gets a column on the calendar and can have appointments.
          </span>
        </label>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add staff member'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

