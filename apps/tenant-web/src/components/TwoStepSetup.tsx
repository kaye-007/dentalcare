import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import { Check, Copy } from 'lucide-react';
import { ApiError, type TotpSetup } from '../lib/api';

/**
 * The pieces of two-step sign-in that appear both at sign-in and in account
 * security: the QR code, the enrollment form, and the recovery codes.
 */

/**
 * A QR code drawn as one SVG path.
 *
 * Rendered from the module matrix rather than from the library's own SVG
 * string, so nothing reaches the DOM through innerHTML — the value encoded
 * here is a secret, and it deserves the most boring rendering path there is.
 */
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

/** "JBSWY3DPEHPK3PXP" -> "JBSW Y3DP EHPK 3PXP", for typing by hand. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

/**
 * Enrol an authenticator app.
 *
 * `start` asks the API for a new secret — exactly once per mount. A second
 * call would retire the first secret server-side while its QR code was still
 * on screen, and the code the person then typed would never match.
 */
export function TotpEnrollment({
  start,
  confirm,
  onEnrolled,
  submitLabel = 'Turn on two-step sign-in',
}: {
  start: () => Promise<TotpSetup>;
  confirm: (code: string) => Promise<string[]>;
  onEnrolled: (recoveryCodes: string[]) => void;
  submitLabel?: string;
}) {
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start()
      .then(setSetup)
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not start setting up two-step sign-in.',
        ),
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
      setError(
        err instanceof ApiError
          ? err.message
          : 'That code did not work. Try the newest one.',
      );
      setBusy(false);
    }
  }

  return (
    <form className="auth__form" onSubmit={submit}>
      {setup ? (
        <>
          <ol className="mfasteps">
            <li>
              Open an authenticator app on your phone — Google Authenticator, Microsoft
              Authenticator, 1Password or similar.
            </li>
            <li>Scan this code, or type the key in by hand.</li>
            <li>Enter the six-digit code the app shows.</li>
          </ol>
          <div className="mfaqr">
            <QrCode value={setup.otpauthUri} />
          </div>
          <p className="mfakey">
            <span>Key</span>
            <code>{grouped(setup.secret)}</code>
          </p>
          <label className="field">
            <span>Six-digit code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
              placeholder="123 456"
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
        <button className="btn btn--primary" disabled={busy || digits.length !== 6}>
          {busy ? 'Checking…' : submitLabel}
        </button>
      )}
    </form>
  );
}

/**
 * Recovery codes, shown once. The person has to say they have kept them
 * before anything moves on, because there is no second chance to see them.
 */
export function RecoveryCodes({
  codes,
  onDone,
  doneLabel = 'I have saved these codes',
}: {
  codes: string[];
  onDone: () => void;
  doneLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="auth__form">
      <p className="voidnote">
        Keep these somewhere safe — a password manager, or printed and locked away. If you
        lose your phone, each code signs you in once. They will not be shown again.
      </p>
      <ol className="recovery">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="inlineform__foot">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={async () => {
            await navigator.clipboard.writeText(codes.join('\n'));
            setCopied(true);
          }}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? 'Copied' : 'Copy codes'}
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={onDone}>
          {doneLabel}
        </button>
      </div>
    </div>
  );
}
