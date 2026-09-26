import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api, ApiError, type AuthenticatedResult, type MfaStage } from '../lib/api';
import { t } from '../lib/strings';
import GoogleButton from '../components/GoogleButton';
import { RecoveryCodes, TotpEnrollment } from '../components/TwoStepSetup';

/**
 * Sign-in, in up to three steps.
 *
 *   credentials  ->  done
 *                ->  verify  (a code, or a recovery code)  ->  done
 *                ->  enroll  (QR + first code)  ->  recovery codes  ->  done
 *
 * The Google callback can land directly on verify or enroll: it passes the
 * challenge through router state, never the URL.
 */

type Step =
  | { kind: 'credentials' }
  | { kind: 'verify'; challengeToken: string }
  | { kind: 'enroll'; challengeToken: string }
  | { kind: 'codes'; codes: string[] };

interface LoginState {
  from?: { pathname: string };
  next?: string;
  challenge?: { token: string; stage: MfaStage };
}

function Brand() {
  return (
    <div className="auth__brand">
      <svg viewBox="0 0 28 28" width="34" height="34" aria-hidden>
        <circle cx="9" cy="9" r="4" fill="var(--logo-1)" />
        <circle cx="19" cy="9" r="3" fill="var(--logo-2)" />
        <circle cx="14" cy="19" r="3.4" fill="var(--logo-3)" />
        <line x1="9" y1="9" x2="14" y2="19" stroke="var(--logo-1)" strokeWidth="1.6" />
        <line x1="19" y1="9" x2="14" y2="19" stroke="var(--logo-2)" strokeWidth="1.6" />
      </svg>
      <div>
        <p className="auth__name">DentalCare</p>
        <p className="auth__by">by NODE X</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const { login, completeSignIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LoginState | null;
  const from = state?.from?.pathname ?? state?.next ?? '/';

  const [step, setStep] = useState<Step>(() =>
    state?.challenge
      ? { kind: state.challenge.stage, challengeToken: state.challenge.token }
      : { kind: 'credentials' },
  );
  // Tokens from a finished enrollment wait here until the recovery codes have
  // been acknowledged: the session starts only once they have been seen.
  const pending = useRef<AuthenticatedResult | null>(null);

  const done = () => navigate(from, { replace: true });
  const restart = () => {
    pending.current = null;
    setStep({ kind: 'credentials' });
  };

  return (
    <div className="auth">
      <div className="auth__panel">
        <Brand />

        {step.kind === 'credentials' && (
          <CredentialsStep
            onSignedIn={done}
            onSecondStep={(next) => setStep(next)}
            login={login}
            from={from}
          />
        )}

        {step.kind === 'verify' && (
          <VerifyStep
            challengeToken={step.challengeToken}
            onVerified={async (tokens) => {
              await completeSignIn(tokens);
              done();
            }}
            onRestart={restart}
          />
        )}

        {step.kind === 'enroll' && (
          <>
            <h1 className="auth__title">Set up two-step sign-in</h1>
            <p className="auth__sub">
              Your account needs a second step when you sign in. It takes a minute, and you
              only do it once.
            </p>
            <TotpEnrollment
              start={() => api.beginEnrollment(step.challengeToken)}
              confirm={async (code) => {
                const res = await api.confirmEnrollment(step.challengeToken, code);
                pending.current = res;
                return res.recoveryCodes;
              }}
              onEnrolled={(codes) => setStep({ kind: 'codes', codes })}
              submitLabel="Turn on and continue"
            />
            <button type="button" className="linkbtn auth__alt" onClick={restart}>
              Start over
            </button>
          </>
        )}

        {step.kind === 'codes' && (
          <>
            <h1 className="auth__title">Your recovery codes</h1>
            <RecoveryCodes
              codes={step.codes}
              doneLabel="I have saved them — continue"
              onDone={async () => {
                if (!pending.current) return restart();
                await completeSignIn(pending.current);
                pending.current = null;
                done();
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function CredentialsStep({
  login,
  onSignedIn,
  onSecondStep,
  from,
}: {
  login: ReturnType<typeof useAuth>['login'];
  onSignedIn: () => void;
  onSecondStep: (step: Step) => void;
  from: string;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const next = await login(email, password);
      if (next.kind === 'done') onSignedIn();
      else onSecondStep(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('login.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="auth__title">{t('login.title')}</h1>
      <p className="auth__sub">{t('login.subtitle')}</p>

      <form className="auth__form" onSubmit={onSubmit}>
        <label className="field">
          <span>{t('login.email')}</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@clinic.com"
            required
          />
        </label>
        <label className="field">
          <span>{t('login.password')}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
        </label>

        {error && <p className="auth__error">{error}</p>}

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>

      <GoogleButton next={from} />
    </>
  );
}

function VerifyStep({
  challengeToken,
  onVerified,
  onRestart,
}: {
  challengeToken: string;
  onVerified: (tokens: AuthenticatedResult) => Promise<void>;
  onRestart: () => void;
}) {
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = recovery
    ? value.replace(/[\s-]/g, '').length === 10
    : value.replace(/\s/g, '').length === 6;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.verifyMfa(
        challengeToken,
        recovery ? { recoveryCode: value.trim() } : { code: value.replace(/\s/g, '') },
      );
      await onVerified(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('login.error'));
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="auth__title">Two-step sign-in</h1>
      <p className="auth__sub">
        {recovery
          ? 'Enter one of your recovery codes. Each one works once.'
          : 'Enter the six-digit code from your authenticator app.'}
      </p>
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span>{recovery ? 'Recovery code' : 'Six-digit code'}</span>
          <input
            key={recovery ? 'recovery' : 'code'}
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            maxLength={recovery ? 11 : 7}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={recovery ? 'ABCDE-FGHJK' : '123 456'}
            autoFocus
            required
          />
        </label>
        {error && <p className="auth__error">{error}</p>}
        <button className="btn btn--primary" disabled={busy || !ready}>
          {busy ? 'Checking…' : 'Verify and sign in'}
        </button>
      </form>
      <button
        type="button"
        className="linkbtn auth__alt"
        onClick={() => {
          setRecovery((r) => !r);
          setValue('');
          setError(null);
        }}
      >
        {recovery ? 'Use my authenticator app instead' : 'Lost your phone? Use a recovery code'}
      </button>
      <button type="button" className="linkbtn auth__alt" onClick={onRestart}>
        Start over
      </button>
    </>
  );
}
