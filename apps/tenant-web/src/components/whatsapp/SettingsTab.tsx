import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Link2Off, PlugZap, XCircle } from 'lucide-react';
import { isTimeZone } from '@dentalcare/shared';
import {
  ApiError,
  settingsApi,
  whatsappApi,
  type WhatsAppConnection,
  type WhatsAppTemplate,
  type WhatsAppTestResult,
  humanError,
} from '../../lib/api';
import { StatusPill, LoadingRows, useConfirm } from '../ui';

/** Zones a clinic here is likely to be in. The stored zone is offered too. */
const COMMON_TIMEZONES = [
  'Europe/Tirane',
  'Europe/Belgrade',
  'Europe/Skopje',
  'Europe/Podgorica',
  'Europe/Athens',
  'Europe/Rome',
  'Europe/Berlin',
  'Europe/Zurich',
  'Europe/London',
  'UTC',
];

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}

/**
 * The clinic's own WhatsApp Cloud API account.
 *
 * The access token is typed here, sent once to be tested and saved, and never
 * shown again: the API has no response with it, and this page keeps it only
 * in the input until saving clears it. Nothing is written to browser storage.
 */
export default function SettingsTab() {
  const confirm = useConfirm();
  const [conn, setConn] = useState<WhatsAppConnection | null>(null);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [token, setToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [timezone, setTimezone] = useState('Europe/Tirane');
  const [countryCode, setCountryCode] = useState('355');
  const [test, setTest] = useState<WhatsAppTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'test' | 'save' | 'disconnect' | 'zone'>(null);

  const load = () =>
    Promise.all([whatsappApi.connection(), whatsappApi.templates(), settingsApi.get()])
      .then(([c, t, clinic]) => {
        setConn(c);
        setTemplates(t);
        setPhoneNumberId(c.phoneNumberId ?? '');
        setWabaId(c.wabaId ?? '');
        setTimezone(c.timezone);
        setCountryCode(clinic.phoneCountryCode);
      })
      .catch((e) => setError(humanError(e)));

  useEffect(() => {
    void load();
  }, []);

  async function run<T>(
    kind: NonNullable<typeof busy>,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  const fields = () => ({
    accessToken: token.trim() || undefined,
    phoneNumberId: phoneNumberId.trim(),
    wabaId: wabaId.trim(),
  });

  async function onTest() {
    setTest(null);
    const out = await run('test', () => whatsappApi.test(fields()));
    if (out) {
      setTest(out);
      await load();
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const out = await run('save', () => whatsappApi.save(fields()));
    if (out) {
      setConn(out);
      setToken(''); // gone from the page as well
      setTest(null);
      setNotice(
        'WhatsApp is connected. The access token is stored encrypted and will not be shown again.',
      );
    }
  }

  async function onDisconnect() {
    const ok = await confirm({
      title: 'Disconnect WhatsApp?',
      body: 'The saved access token is deleted and reminders stop until you connect again.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    const out = await run('disconnect', () => whatsappApi.disconnect());
    if (out) {
      setConn(out);
      setNotice('WhatsApp is disconnected and the access token was deleted.');
    }
  }

  async function onDefault(id: string) {
    const out = await run('save', () =>
      whatsappApi.updateTemplate(id, { isDefault: true }),
    );
    if (out) await load();
  }

  async function onZone(e: FormEvent) {
    e.preventDefault();
    if (!isTimeZone(timezone))
      return setError(`"${timezone}" is not a time zone, e.g. Europe/Tirane.`);
    if (!/^[1-9][0-9]{0,2}$/.test(countryCode.trim()))
      return setError('The country code is 1 to 3 digits, e.g. 355.');
    const out = await run('zone', () =>
      settingsApi.update({ timezone, phoneCountryCode: countryCode.trim() }),
    );
    if (out) setNotice('Saved.');
  }

  if (!conn)
    return error ? (
      <p className="formerror">{error}</p>
    ) : (
      <LoadingRows rows={3} label="Loading" />
    );

  const defaultTemplate = templates.find((t) => t.isDefault);

  return (
    <div className="wa-stack">
      {notice && (
        <p className="channel-note" role="status" style={{ margin: 0 }}>
          {notice}
        </p>
      )}

      <section className="card">
        <div className="card__head">
          <div>
            <h2>Connection status</h2>
            <p className="card__sub">
              The WhatsApp Business number reminders are sent from.
            </p>
          </div>
          {conn.saved ? (
            <StatusPill
              status={conn.connected ? 'ok' : 'danger'}
              label={conn.connected ? 'Connected' : 'Connection failed'}
            />
          ) : (
            <StatusPill status="neutral" label="Not connected" />
          )}
        </div>
        <dl className="wa-facts pad">
          <div>
            <dt>WhatsApp number</dt>
            <dd>
              {conn.displayPhoneNumber ?? '—'}
              {conn.verifiedName ? (
                <span className="muted small"> · {conn.verifiedName}</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Last successful test</dt>
            <dd>{when(conn.lastSuccessAt)}</dd>
          </div>
          <div>
            <dt>Last test</dt>
            <dd>
              {conn.lastTestedAt ? (
                <>
                  {when(conn.lastTestedAt)} ·{' '}
                  <span className={conn.lastTestOk ? '' : 'wa-problem'}>
                    {conn.lastTestResult}
                  </span>
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>
      </section>

      <form className="card" onSubmit={onSave}>
        <div className="card__head">
          <div>
            <h2>WhatsApp Cloud API</h2>
            <p className="card__sub">
              From Meta’s WhatsApp Manager → API Setup. Use a permanent (system user)
              access token so reminders do not stop when a temporary token expires.
            </p>
          </div>
        </div>
        <div className="form" style={{ paddingTop: 16 }}>
          <label className="field">
            <span>WhatsApp access token</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                conn.saved
                  ? 'Saved and hidden — paste a new token only to replace it'
                  : 'EAA…'
              }
              required={!conn.saved}
            />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Phone Number ID</span>
              <input
                className="wa-mono"
                inputMode="numeric"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value.replace(/\D/g, ''))}
                required
              />
            </label>
            <label className="field">
              <span>WhatsApp Business Account ID</span>
              <input
                className="wa-mono"
                inputMode="numeric"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value.replace(/\D/g, ''))}
                required
              />
            </label>
          </div>

          {test && (
            <p
              className={`inline-row wa-test ${test.ok ? 'wa-test--ok' : 'wa-test--bad'}`}
              role="status"
              style={{ gap: 8 }}
            >
              {test.ok ? (
                <CheckCircle2 size={16} aria-hidden />
              ) : (
                <XCircle size={16} aria-hidden />
              )}
              {test.ok
                ? `Connected to ${test.displayPhoneNumber ?? 'the number'}${test.verifiedName ? ` (${test.verifiedName})` : ''}.`
                : test.message}
            </p>
          )}
          {error && <p className="formerror">{error}</p>}

          <div className="card__foot wa-actions">
            {conn.saved && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void onDisconnect()}
                disabled={busy !== null}
              >
                <Link2Off size={15} aria-hidden /> Disconnect WhatsApp
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void onTest()}
              disabled={
                busy !== null || !phoneNumberId || !wabaId || (!conn.saved && !token)
              }
            >
              <PlugZap size={15} aria-hidden />{' '}
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <button className="btn btn--primary btn--sm" disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save connection'}
            </button>
          </div>
        </div>
      </form>

      <section className="card">
        <div className="card__head">
          <div>
            <h2>Reminder defaults</h2>
            <p className="card__sub">
              Which template reminders use, the clinic’s time zone for “tomorrow”, and how
              local numbers are read.
            </p>
          </div>
        </div>
        <div className="form" style={{ paddingTop: 16 }}>
          <div className="grid2">
            <label className="field">
              <span>Default template</span>
              <select
                value={defaultTemplate?.id ?? ''}
                onChange={(e) => e.target.value && void onDefault(e.target.value)}
                disabled={templates.length === 0}
              >
                {!defaultTemplate && (
                  <option value="">
                    {templates.length ? 'Choose…' : 'Add one in Message templates'}
                  </option>
                )}
                {templates
                  .filter((t) => t.isActive)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.displayName} ({t.metaTemplateName})
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>Template language</span>
              <input
                value={defaultTemplate?.languageCode ?? '—'}
                readOnly
                aria-readonly
              />
            </label>
          </div>
          <form className="grid2" onSubmit={onZone}>
            <label className="field">
              <span>Clinic time zone</span>
              <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {(COMMON_TIMEZONES.includes(timezone)
                  ? COMMON_TIMEZONES
                  : [timezone, ...COMMON_TIMEZONES]
                ).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Country code for local numbers</span>
              <input
                inputMode="numeric"
                value={countryCode}
                onChange={(e) =>
                  setCountryCode(e.target.value.replace(/D/g, '').slice(0, 3))
                }
                aria-describedby="cc-hint"
              />
              <small id="cc-hint" className="muted">
                “069 123 4567” is sent to +{countryCode || '355'} 69 123 4567.
              </small>
            </label>
            <div className="field">
              <button
                className="btn btn--ghost btn--sm"
                disabled={busy !== null}
                style={{ justifySelf: 'start' }}
              >
                {busy === 'zone' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
