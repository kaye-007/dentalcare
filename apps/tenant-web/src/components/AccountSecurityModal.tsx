import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Laptop, ShieldCheck, ShieldAlert } from 'lucide-react';
import {
  ApiError,
  securityApi,
  type ActiveSession,
  type MfaStatus,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateLocale } from '../lib/strings';
import { Modal } from './ui';
import { RecoveryCodes, TotpEnrollment } from './TwoStepSetup';

/**
 * The sidebar control that opens account security. It carries a warning tint
 * when two-step sign-in is required for this account and not yet set up —
 * a session that began before the requirement did.
 */
export function AccountSecurityButton() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const needsSetup = Boolean(user?.mfa?.required && !user.mfa.enrolled);

  return (
    <>
      <button
        className={`iconbtn iconbtn--quiet${needsSetup ? ' iconbtn--alert' : ''}`}
        onClick={() => setOpen(true)}
        title={needsSetup ? 'Set up two-step sign-in' : 'Account security'}
        aria-label="Account security"
      >
        {needsSetup ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}
      </button>
      {open && <AccountSecurityModal onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The signed-in person's own account security: two-step sign-in, recovery
 * codes, and the devices signed in as them.
 *
 * Every role can reach this. Protecting your own account is not a permission.
 */
export default function AccountSecurityModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      wide
      title="Account security"
      subtitle="Two-step sign-in and the devices signed in as you."
      onClose={onClose}
    >
      <div className="modal__body security">
        <TwoStepSection />
        <SessionsSection />
      </div>
    </Modal>
  );
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

type Mode = 'idle' | 'enrolling' | 'codes' | 'regenerate' | 'disable';

function TwoStepSection() {
  const { refreshUser } = useAuth();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    securityApi
      .mfaStatus()
      .then(setStatus)
      .catch(() => setError('Could not load your two-step sign-in status.'));
  }, []);
  useEffect(load, [load]);

  const showCodes = (next: string[]) => {
    setCodes(next);
    setMode('codes');
  };

  return (
    <section className="security__section">
      <h3>
        <ShieldCheck size={16} aria-hidden /> Two-step sign-in
      </h3>
      {error && <p className="formerror">{error}</p>}
      {!status ? (
        !error && <p className="muted">Loading…</p>
      ) : mode === 'enrolling' ? (
        <TotpEnrollment
          start={() => securityApi.setupTotp()}
          confirm={async (code) => (await securityApi.confirmTotp(code)).recoveryCodes}
          onEnrolled={showCodes}
        />
      ) : mode === 'codes' ? (
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            setMode('idle');
            load();
            void refreshUser();
          }}
        />
      ) : mode === 'regenerate' ? (
        <CodeForm
          label="Generate new recovery codes"
          hint="Your old codes stop working as soon as the new ones are issued."
          submit={async (code) => showCodes((await securityApi.regenerateRecoveryCodes(code)).recoveryCodes)}
          onCancel={() => setMode('idle')}
        />
      ) : mode === 'disable' ? (
        <CodeForm
          label="Turn off two-step sign-in"
          hint="Every other device signed in as you will be signed out."
          withPassword
          submit={async (code, password) => {
            await securityApi.disableMfa(password!, code);
            setMode('idle');
            load();
            void refreshUser();
          }}
          onCancel={() => setMode('idle')}
          danger
        />
      ) : status.enrolled ? (
        <>
          <p className="security__state security__state--on">
            On since {status.confirmedAt ? fmt(status.confirmedAt) : '—'} ·{' '}
            {status.recoveryCodesRemaining} recovery code
            {status.recoveryCodesRemaining === 1 ? '' : 's'} left
          </p>
          {status.recoveryCodesRemaining <= 3 && (
            <p className="formhint">
              You are running low on recovery codes. Generate new ones before you need them.
            </p>
          )}
          <div className="security__actions">
            <button className="btn btn--ghost btn--sm" onClick={() => setMode('regenerate')}>
              New recovery codes
            </button>
            {!status.required && (
              <button className="btn btn--danger-ghost btn--sm" onClick={() => setMode('disable')}>
                Turn off
              </button>
            )}
          </div>
          {status.required && (
            <p className="muted" style={{ fontSize: 12.5 }}>
              Required for your role at this clinic, so it cannot be turned off. If you lose
              your phone and your recovery codes, an administrator can reset it.
            </p>
          )}
        </>
      ) : (
        <>
          <p className={`security__state${status.required ? ' security__state--warn' : ''}`}>
            {status.required ? (
              <>
                <ShieldAlert size={14} aria-hidden /> Required for your account, and not set up
                yet. You will be asked to set it up at your next sign-in.
              </>
            ) : (
              'Off. A code from your phone at sign-in keeps your account safe even if your password leaks.'
            )}
          </p>
          <div className="security__actions">
            <button className="btn btn--primary btn--sm" onClick={() => setMode('enrolling')}>
              Set up two-step sign-in
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function CodeForm({
  label,
  hint,
  withPassword,
  submit,
  onCancel,
  danger,
}: {
  label: string;
  hint: string;
  withPassword?: boolean;
  submit: (code: string, password?: string) => Promise<void>;
  onCancel: () => void;
  danger?: boolean;
}) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await submit(code.replace(/\s/g, ''), withPassword ? password : undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
      setBusy(false);
    }
  }

  return (
    <form className="inlineform" onSubmit={onSubmit}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {hint}
      </p>
      {withPassword && (
        <label className="field">
          <span>Your password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
      )}
      <label className="field">
        <span>Code from your authenticator app</span>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
          autoFocus
          required
        />
      </label>
      {error && <p className="formerror">{error}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          className={`btn btn--sm ${danger ? 'btn--danger' : 'btn--primary'}`}
          disabled={busy || code.replace(/\s/g, '').length !== 6}
        >
          {busy ? 'Working…' : label}
        </button>
      </div>
    </form>
  );
}

/** "Chrome on Windows"-ish, without shipping a user-agent parser. */
function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

function SessionsSection() {
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    securityApi
      .sessions()
      .then(setSessions)
      .catch(() => setError('Could not load your signed-in devices.'));
  }, []);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const others = (sessions ?? []).filter((x) => !x.current);

  return (
    <section className="security__section">
      <h3>
        <Laptop size={16} aria-hidden /> Signed-in devices
      </h3>
      {error && <p className="formerror">{error}</p>}
      {sessions === null ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <>
          <ul className="list">
            {sessions.map((x) => (
              <li className="row" key={x.familyId}>
                <span className="row__main">
                  <span className="row__title">
                    {deviceLabel(x.userAgent)}
                    {x.current && <span className="pill pill--info" style={{ marginLeft: 8 }}>This device</span>}
                  </span>
                  <span className="row__sub">
                    Signed in {fmt(x.startedAt)} · last active {fmt(x.lastSeenAt)}
                    {x.ip ? ` · ${x.ip}` : ''}
                    {x.mfaVerified ? ' · two-step verified' : ''}
                  </span>
                </span>
                {!x.current && (
                  <button
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => act(() => securityApi.revokeSession(x.familyId))}
                  >
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
          {others.length > 0 && (
            <div className="security__actions">
              <button
                className="btn btn--danger-ghost btn--sm"
                disabled={busy}
                onClick={() => act(() => securityApi.revokeOtherSessions())}
              >
                Sign out everywhere else
              </button>
            </div>
          )}
          <p className="muted" style={{ fontSize: 12.5 }}>
            A device you sign out stops working within 15 minutes, when its access expires.
          </p>
        </>
      )}
    </section>
  );
}
