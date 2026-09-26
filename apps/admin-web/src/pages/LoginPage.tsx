import { useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Building2,
  Eye,
  EyeOff,
  ReceiptText,
  ScrollText,
  ShieldCheck,
} from 'lucide-react';
import { useAuth, type SignInStep } from '../lib/auth';
import { api, ApiError, type MfaStage, type PlatformAuthenticated } from '../lib/api';
import GoogleButton from '../components/GoogleButton';
import { RecoveryCodes, TotpEnrollment } from '../components/TwoStep';
import { Logo } from '../components/Layout';

/**
 * Console sign-in. Every console account uses two-step sign-in, so after the
 * password this normally continues to a code — or, the first time, to setting
 * one up.
 */

type Step =
  | { kind: 'credentials' }
  | { kind: 'verify'; challengeToken: string }
  | { kind: 'enroll'; challengeToken: string }
  | { kind: 'codes'; codes: string[] };

/** The mark and name, for the phone layout where the ink half is hidden. */
function Brand() {
  return (
    <div className="auth__brand">
      <span className="brand__mark">
        <Logo size={24} />
      </span>
      <div>
        <p className="auth__logo-name">DentalCare</p>
        <p className="brand__label">NODE X · Control</p>
      </div>
    </div>
  );
}

/** What this is, for whoever has just been given an account. */
function Aside() {
  return (
    <aside className="auth__aside" aria-hidden>
      <div className="auth__logo">
        <span className="auth__logo-mark">
          <Logo size={24} />
        </span>
        <div>
          <p className="auth__logo-name">DentalCare</p>
          <p className="auth__logo-by">NODE X · Control</p>
        </div>
      </div>
      <div className="auth__pitch">
        <h2>
          The control room for <em>every clinic</em> on DentalCare.
        </h2>
        <p>
          Onboard clinics, run subscription billing, and keep an audited record of
          everything done from here.
        </p>
        <ul className="auth__points">
          <li>
            <Building2 aria-hidden /> Clinics, trials and plans in one place
          </li>
          <li>
            <ReceiptText aria-hidden /> Monthly billing, payments and overdue follow-up
          </li>
          <li>
            <ScrollText aria-hidden /> A permanent audit trail of every action
          </li>
          <li>
            <ShieldCheck aria-hidden /> Two-step sign-in on every console account
          </li>
        </ul>
      </div>
      <p className="auth__legal">For NODE X staff only. Access is recorded.</p>
    </aside>
  );
}

export default function LoginPage() {
  const { login, completeSignIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as {
    challenge?: { token: string; stage: MfaStage };
  } | null;

  const [step, setStep] = useState<Step>(() =>
    state?.challenge
      ? { kind: state.challenge.stage, challengeToken: state.challenge.token }
      : { kind: 'credentials' },
  );
  const pending = useRef<PlatformAuthenticated | null>(null);

  const done = () => navigate('/', { replace: true });
  const restart = () => {
    pending.current = null;
    setStep({ kind: 'credentials' });
  };

  return (
    <div className="auth">
      <Aside />
      <main className="auth__main">
        <div className="auth__panel">
          <Brand />

          {step.kind === 'credentials' && (
            <Credentials
              login={login}
              onNext={(next) => (next.kind === 'done' ? done() : setStep(next))}
            />
          )}

          {step.kind === 'verify' && (
            <Verify
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
                Console accounts can reach every clinic, so every one of them needs a
                second step at sign-in.
              </p>
              <TotpEnrollment
                start={() => api.beginEnrollment(step.challengeToken)}
                confirm={async (code) => {
                  const res = await api.confirmEnrollment(step.challengeToken, code);
                  pending.current = res;
                  return res.recoveryCodes;
                }}
                onEnrolled={(codes) => setStep({ kind: 'codes', codes })}
              />
              <button type="button" className="authlink" onClick={restart}>
                Start over
              </button>
            </>
          )}

          {step.kind === 'codes' && (
            <>
              <h1 className="auth__title">Your recovery codes</h1>
              <RecoveryCodes
                codes={step.codes}
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
      </main>
    </div>
  );
}

function Credentials({
  login,
  onNext,
}: {
  login: (email: string, password: string) => Promise<SignInStep>;
  onNext: (next: SignInStep) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onNext(await login(email, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="auth__title">Welcome back</h1>
      <p className="auth__sub">Sign in to the NODE X platform console.</p>
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@nodex.al"
            autoComplete="username"
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>Password</span>
          <div className="passfield">
            <input
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="iconbtn iconbtn--quiet"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide password' : 'Show password'}
              aria-pressed={show}
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>
        {error && <p className="auth__error">{error}</p>}
        <button className="btn btn--primary btn--block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <GoogleButton />
    </>
  );
}

function Verify({
  challengeToken,
  onVerified,
  onRestart,
}: {
  challengeToken: string;
  onVerified: (tokens: PlatformAuthenticated) => Promise<void>;
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
      await onVerified(
        await api.verifyMfa(
          challengeToken,
          recovery ? { recoveryCode: value.trim() } : { code: value.replace(/\s/g, '') },
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="auth__title">Two-step sign-in</h1>
      <p className="auth__sub">
        {recovery
          ? 'Enter one of your recovery codes. Each works once.'
          : 'Enter the six-digit code from your authenticator app.'}
      </p>
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span>{recovery ? 'Recovery code' : 'Six-digit code'}</span>
          <input
            key={recovery ? 'recovery' : 'code'}
            className={recovery ? 'mono' : 'otp'}
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            maxLength={recovery ? 11 : 7}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            required
          />
        </label>
        {error && <p className="auth__error">{error}</p>}
        <button className="btn btn--primary btn--block" disabled={busy || !ready}>
          {busy ? 'Checking…' : 'Verify and sign in'}
        </button>
      </form>
      <button
        type="button"
        className="authlink"
        onClick={() => {
          setRecovery((r) => !r);
          setValue('');
          setError(null);
        }}
      >
        {recovery
          ? 'Use my authenticator app instead'
          : 'Lost your phone? Use a recovery code'}
      </button>
      <button type="button" className="authlink" onClick={onRestart}>
        Start over
      </button>
    </>
  );
}
