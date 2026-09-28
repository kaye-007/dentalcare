import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { CheckCircle2, FileKey2, Receipt, XCircle } from 'lucide-react';
import {
  fiscalApi,
  ApiError,
  type CashDeposit,
  type FiscalSettings,
  humanError,
} from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatMoney } from '../../lib/format';
import { ROLE_LABELS } from '../../lib/permissions';
import MoneyInput from '../MoneyInput';
import { SaveButton, useSave } from '../../pages/SettingsPage';
import { LoadingRows } from '../ui';

const CODE = /^[a-z]{2}[0-9]{3}[a-z]{2}[0-9]{3}$/;

function Check({ ok, children }: { ok: boolean; children: string }) {
  return (
    <li className="inline-row" style={{ gap: 6 }}>
      {ok ? (
        <CheckCircle2 size={15} color="var(--ok-fg)" aria-hidden />
      ) : (
        <XCircle size={15} color="var(--danger-fg)" aria-hidden />
      )}
      <span style={{ color: ok ? 'var(--ink)' : 'var(--muted)' }}>{children}</span>
    </li>
  );
}

/**
 * Albanian fiscalization: the register the clinic issues from, the certificate
 * that signs, who operates the register, and the day's opening cash.
 */
export default function FiscalCard() {
  const { can } = useAuth();
  const [s, setS] = useState<FiscalSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fiscalApi
      .settings()
      .then(setS)
      .catch((e) => setLoadError(humanError(e)));
  }, []);

  if (loadError) return <p className="formerror">{loadError}</p>;
  if (!s) return <LoadingRows rows={3} label="Loading" />;

  return (
    <>
      <ReadinessCard s={s} />
      <RegisterCard s={s} onSaved={setS} />
      <CertificateCard s={s} onSaved={setS} />
      <OperatorsCard s={s} onSaved={setS} />
      {s.enabled && can('invoices:fiscalize') && <CashCard />}
    </>
  );
}

function ReadinessCard({ s }: { s: FiscalSettings }) {
  return (
    <section className="card">
      <div className="card__head">
        <div>
          <h2>Fiscalization (fiskalizimi)</h2>
          <p className="card__sub">
            Registers invoices with the tax authority, which returns the NIVF and lets
            patients verify the invoice by QR code.
          </p>
        </div>
      </div>
      <div className="pad">
        {!s.available && (
          <p className="channel-note" style={{ marginTop: 0 }}>
            <strong>Not available on this deployment.</strong> Fiscalization needs the
            software code issued to the software's maker. Contact support.
          </p>
        )}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          <Check
            ok={s.seller.niptValid}
          >{`NIPT on the clinic profile${s.seller.nipt ? ` (${s.seller.nipt})` : ''}`}</Check>
          <Check ok={Boolean(s.seller.address && s.seller.town)}>
            Clinic address and city
          </Check>
          <Check ok={s.seller.currency === 'ALL'}>Currency is lek (ALL)</Check>
          <Check ok={Boolean(s.businessUnitCode && s.tcrCode)}>
            Business unit and cash register codes
          </Check>
          <Check ok={Boolean(s.certificate)}>Signing certificate installed</Check>
          <Check ok={s.operators.some((o) => o.operatorCode)}>
            At least one operator code
          </Check>
        </ul>
      </div>
    </section>
  );
}

function RegisterCard({
  s,
  onSaved,
}: {
  s: FiscalSettings;
  onSaved: (s: FiscalSettings) => void;
}) {
  const [form, setForm] = useState({
    enabled: s.enabled,
    environment: s.environment,
    businessUnitCode: s.businessUnitCode ?? '',
    tcrCode: s.tcrCode ?? '',
    isIssuerInVat: s.isIssuerInVat,
    vatExemptionCode: s.vatExemptionCode,
  });
  const save = useSave();
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    save.setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const out = await save.run(() =>
      fiscalApi.update({
        ...form,
        businessUnitCode: form.businessUnitCode.trim() || null,
        tcrCode: form.tcrCode.trim() || null,
      }),
    );
    if (out) onSaved(out);
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <h2>Register</h2>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <div className="grid2">
          <label className="field">
            <span>Business unit code</span>
            <input
              value={form.businessUnitCode}
              onChange={(e) => set('businessUnitCode', e.target.value.toLowerCase())}
              placeholder="ab123ab123"
            />
            {form.businessUnitCode && !CODE.test(form.businessUnitCode) && (
              <span className="row-issue">
                Two letters, three digits, two letters, three digits
              </span>
            )}
          </label>
          <label className="field">
            <span>Cash register (TCR) code</span>
            <input
              value={form.tcrCode}
              onChange={(e) => set('tcrCode', e.target.value.toLowerCase())}
              placeholder="cd456cd456"
            />
            {form.tcrCode && !CODE.test(form.tcrCode) && (
              <span className="row-issue">
                Two letters, three digits, two letters, three digits
              </span>
            )}
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Environment</span>
            <select
              value={form.environment}
              onChange={(e) =>
                set('environment', e.target.value as 'test' | 'production')
              }
            >
              <option value="test">Test — invoices are not legally valid</option>
              <option value="production">Production</option>
            </select>
          </label>
          <label className="field">
            <span>VAT exemption on untaxed lines</span>
            <input
              value={form.vatExemptionCode}
              onChange={(e) => set('vatExemptionCode', e.target.value.toUpperCase())}
              placeholder="TYPE_1"
            />
          </label>
        </div>
        <label className="hours-row__closed" style={{ width: 'auto' }}>
          <input
            type="checkbox"
            checked={form.isIssuerInVat}
            onChange={(e) => set('isIssuerInVat', e.target.checked)}
          />
          <span>The clinic is registered for VAT</span>
        </label>
        <label className="hours-row__closed" style={{ width: 'auto' }}>
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!s.available}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          <span style={{ color: 'var(--ink)', fontWeight: 600 }}>
            Issue fiscal invoices
          </span>
        </label>
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}

/** A file's bytes as base64, without holding a data: URL string around. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The certificate as issued: a .p12/.pfx file and its password. The file is
 * opened on the server, the key sealed there, and the password discarded; a
 * PEM someone has already converted is still accepted for the odd case.
 */
function CertificateCard({
  s,
  onSaved,
}: {
  s: FiscalSettings;
  onSaved: (s: FiscalSettings) => void;
}) {
  const [p12, setP12] = useState<{ name: string; base64: string } | null>(null);
  const [password, setPassword] = useState('');
  const [pem, setPem] = useState('');
  const [showPem, setShowPem] = useState(false);
  const save = useSave();
  const fileInput = useRef<HTMLInputElement>(null);

  async function readFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    save.setSaved(false);
    save.setError(null);
    if (file.size > 48_000) {
      save.setError('That file is too large to be a certificate.');
      return;
    }
    if (/.(p12|pfx)$/i.test(file.name)) {
      setP12({ name: file.name, base64: await base64Of(file) });
      setShowPem(false);
      setPem('');
    } else {
      setPem(await file.text());
      setShowPem(true);
      setP12(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const out = await save.run(() =>
      p12
        ? fiscalApi.installCertificateFile(p12.base64, password)
        : fiscalApi.installCertificate(pem),
    );
    if (out) {
      onSaved(out);
      // The key is sealed on the server now; nothing of it stays in the page.
      setP12(null);
      setPassword('');
      setPem('');
    }
  }

  const ready = p12 ? true : pem.length >= 100;

  return (
    <form className="card" onSubmit={submit} autoComplete="off">
      <div className="card__head">
        <div>
          <h2>
            <FileKey2 size={16} aria-hidden /> Signing certificate
          </h2>
          <p className="card__sub">
            {s.certificate
              ? `Installed: ${s.certificate.subject ?? 'certificate'} · valid until ${s.certificate.notAfter?.slice(0, 10) ?? '—'}`
              : 'The certificate issued by the tax authority for this clinic (.p12 or .pfx).'}
          </p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <input
          ref={fileInput}
          type="file"
          accept=".p12,.pfx,.pem,.crt,.key,.txt"
          hidden
          onChange={readFile}
        />
        <div className="inline-row">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => fileInput.current?.click()}
          >
            {p12 ? 'Choose another file' : 'Choose certificate file'}
          </button>
          <span className="field-hint">
            {p12 ? p12.name : '.p12 or .pfx, as the certificate authority issued it'}
          </span>
        </div>
        {p12 && (
          <label className="field" style={{ maxWidth: 360 }}>
            <span>Certificate password</span>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => {
                save.setSaved(false);
                setPassword(e.target.value);
              }}
            />
            <span className="field-hint">
              Used once to open the file and then discarded. The private key is sealed on
              arrival and cannot be downloaded again.
            </span>
          </label>
        )}
        {!p12 && (
          <button
            type="button"
            className="linkbtn"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setShowPem((v) => !v)}
          >
            {showPem ? 'Hide PEM input' : 'Have a PEM instead?'}
          </button>
        )}
        {!p12 && showPem && (
          <textarea
            rows={4}
            value={pem}
            onChange={(e) => {
              save.setSaved(false);
              setPem(e.target.value);
            }}
            placeholder="-----BEGIN PRIVATE KEY----- … -----BEGIN CERTIFICATE----- …"
            spellCheck={false}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
          />
        )}
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <button className="btn btn--primary btn--sm" disabled={save.busy || !ready}>
            {save.busy
              ? 'Checking…'
              : s.certificate
                ? 'Replace certificate'
                : 'Install certificate'}
          </button>
        </div>
      </div>
    </form>
  );
}

function OperatorsCard({
  s,
  onSaved,
}: {
  s: FiscalSettings;
  onSaved: (s: FiscalSettings) => void;
}) {
  const [codes, setCodes] = useState<Record<string, string>>(
    Object.fromEntries(s.operators.map((o) => [o.userId, o.operatorCode ?? ''])),
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveOne(userId: string) {
    const code = codes[userId]?.trim() ?? '';
    if (code && !CODE.test(code)) {
      setError(
        'Operator codes are two letters, three digits, two letters, three digits.',
      );
      return;
    }
    setError(null);
    setSavingId(userId);
    try {
      onSaved(await fiscalApi.setOperatorCode(userId, code || null));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <h2>Operators</h2>
          <p className="card__sub">
            Each person who issues fiscal invoices needs the operator code registered for
            them with the tax authority.
          </p>
        </div>
      </div>
      <div className="pad">
        <table className="mini-table">
          <thead>
            <tr>
              <th>Staff</th>
              <th>Operator code</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {s.operators.map((o) => {
              const changed = (codes[o.userId] ?? '') !== (o.operatorCode ?? '');
              return (
                <tr key={o.userId}>
                  <td>
                    {o.fullName}
                    <span className="cell-sub"> · {ROLE_LABELS[o.role] ?? o.role}</span>
                  </td>
                  <td>
                    <input
                      value={codes[o.userId] ?? ''}
                      onChange={(e) =>
                        setCodes((c) => ({
                          ...c,
                          [o.userId]: e.target.value.toLowerCase(),
                        }))
                      }
                      placeholder="ef789ef789"
                      aria-label={`Operator code for ${o.fullName}`}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={!changed || savingId === o.userId}
                      onClick={() => saveOne(o.userId)}
                    >
                      {savingId === o.userId ? 'Saving…' : 'Save'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {error && <p className="formerror">{error}</p>}
      </div>
    </section>
  );
}

function CashCard() {
  const [deposits, setDeposits] = useState<CashDeposit[] | null>(null);
  const [amount, setAmount] = useState<number | null>(0);
  const [operation, setOperation] = useState<'INITIAL' | 'WITHDRAW'>('INITIAL');
  const save = useSave();

  useEffect(() => {
    fiscalApi
      .cashDeposits()
      .then(setDeposits)
      .catch(() => setDeposits([]));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const out = await save.run(() =>
      fiscalApi.registerCashDeposit({ operation, amount: amount ?? 0 }),
    );
    if (out) {
      setDeposits((d) => [out, ...(d ?? [])]);
      if (out.status !== 'registered')
        save.setError(out.error ?? 'The tax authority did not confirm the declaration.');
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>
            <Receipt size={16} aria-hidden /> Cash in the register
          </h2>
          <p className="card__sub">
            Declare the opening cash at the start of each day, before the first cash
            invoice.
          </p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <div className="grid2">
          <label className="field">
            <span>Declaration</span>
            <select
              value={operation}
              onChange={(e) => setOperation(e.target.value as 'INITIAL' | 'WITHDRAW')}
            >
              <option value="INITIAL">Opening cash (start of day)</option>
              <option value="WITHDRAW">Cash taken out</option>
            </select>
          </label>
          <label className="field">
            <span>Amount</span>
            <MoneyInput value={amount} onChange={setAmount} placeholder="0" />
          </label>
        </div>
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <button className="btn btn--primary btn--sm" disabled={save.busy}>
            {save.busy ? 'Sending…' : 'Declare'}
          </button>
        </div>
        {deposits && deposits.length > 0 && (
          <table className="mini-table">
            <tbody>
              {deposits.slice(0, 5).map((d) => (
                <tr key={d.id}>
                  <td>{d.changeDateTime.replace('T', ' ').slice(0, 16)}</td>
                  <td>{d.operation === 'INITIAL' ? 'Opening cash' : 'Taken out'}</td>
                  <td>{formatMoney(d.amount)}</td>
                  <td>
                    {d.status === 'registered'
                      ? 'Confirmed'
                      : d.status === 'rejected'
                        ? 'Refused'
                        : 'Not reached'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </form>
  );
}
