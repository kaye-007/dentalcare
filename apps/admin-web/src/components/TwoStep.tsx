import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import { ApiError, type TotpSetup } from '../lib/api';

/**
 * Two-step sign-in pieces for the console: the QR code, the enrollment form
 * and the recovery codes. The clinic app has its own copy styled for its own
 * design; the behaviour — one secret per mount, codes shown once — is the same.
 */

/** Drawn as one SVG path from the module matrix; nothing goes through innerHTML. */
export function QrCode({ value, size = 184 }: { value: string; size?: number }) {
  const { path, extent } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 2;
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
    return { path: d, extent: count + quiet * 2 };
  }, [value]);

  return (
    <svg
      className="qrcode"
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      role="img"
      aria-label="QR code to scan with your authenticator app"
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function TotpEnrollment({
  start,
  confirm,
  onEnrolled,
}: {
  start: () => Promise<TotpSetup>;
  confirm: (code: string) => Promise<string[]>;
  onEnrolled: (recoveryCodes: string[]) => void;
}) {
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One secret per mount: a second start would retire the secret whose QR
  // code is on screen, and the code typed from it would never match.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start()
      .then(setSetup)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not start setup.'),
      );
  }, [start]);

  const digits = code.replace(/\s/g, '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onEnrolled(await confirm(digits));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code did not work.');
      setBusy(false);
    }
  }

  return (
    <form className="auth__form" onSubmit={submit}>
      {setup ? (
        <>
          <ol className="mfasteps">
            <li>Open an authenticator app on your phone.</li>
            <li>Scan this code, or type the key in by hand.</li>
            <li>Enter the six-digit code it shows.</li>
          </ol>
          <div className="mfaqr">
            <QrCode value={setup.otpauthUri} />
          </div>
          <p className="mfakey">
            <span>Key</span>
            <code>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </p>
          <label className="field">
            <span>Six-digit code</span>
            <input
              className="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
              autoFocus
              required
            />
          </label>
        </>
      ) : (
        !error && <p className="auth__sub">Preparing your key…</p>
      )}
      {error && <p className="auth__error">{error}</p>}
      {setup && (
        <button
          className="btn btn--primary btn--block"
          disabled={busy || digits.length !== 6}
        >
          {busy ? 'Checking…' : 'Turn on and continue'}
        </button>
      )}
    </form>
  );
}

export function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="auth__form">
      <p className="mfanote">
        Keep these somewhere safe. If you lose your phone, each code signs you in once.
        They will not be shown again. A console account is authority over every clinic —
        treat these like the password.
      </p>
      <ol className="recovery">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="mfaactions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(codes.join('\n'));
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy codes'}
        </button>
        <button type="button" className="btn btn--primary" onClick={onDone}>
          I have saved them — continue
        </button>
      </div>
    </div>
  );
}
