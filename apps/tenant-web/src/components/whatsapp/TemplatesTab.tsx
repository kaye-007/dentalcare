import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { FileText, Plus, RefreshCw } from 'lucide-react';
import {
  WHATSAPP_DEFAULT_PREVIEWS,
  WHATSAPP_REMINDER_VARIABLES,
  WHATSAPP_SAMPLE,
  renderWhatsAppPreview,
  unknownWhatsAppVariables,
  whatsAppReminderValues,
} from '@dentalcare/shared';
import {
  ApiError,
  whatsappApi,
  type WhatsAppTemplate,
  type WhatsAppTemplateInput,
  humanError,
} from '../../lib/api';
import { EmptyState, Modal, StatusPill, LoadingRows, useConfirm } from '../ui';

const LANGUAGES = [
  { code: 'sq', label: 'Albanian (sq)' },
  { code: 'en', label: 'English (en)' },
  { code: 'en_US', label: 'English, US (en_US)' },
  { code: 'en_GB', label: 'English, UK (en_GB)' },
  { code: 'it', label: 'Italian (it)' },
];

const STARTERS: Record<'sq' | 'en', WhatsAppTemplateInput> = {
  sq: {
    displayName: 'Appointment Reminder Albanian',
    metaTemplateName: 'appointment_reminder_sq',
    languageCode: 'sq',
    previewBody: WHATSAPP_DEFAULT_PREVIEWS.sq,
  },
  en: {
    displayName: 'Appointment Reminder English',
    metaTemplateName: 'appointment_reminder_en',
    languageCode: 'en',
    previewBody: WHATSAPP_DEFAULT_PREVIEWS.en,
  },
};

function templateState(t: WhatsAppTemplate): { status: string; label: string } {
  if (!t.isActive) return { status: 'neutral', label: 'Inactive' };
  if (t.ready) return { status: 'ok', label: 'Approved · ready' };
  if (!t.meta.checkedAt) return { status: 'neutral', label: 'Not checked with Meta' };
  return { status: 'danger', label: 'Not ready' };
}

/**
 * Which approved WhatsApp template carries the reminder, and what the local
 * preview says. The preview is for the clinic's eyes; what the patient gets
 * is the template Meta approved, filled with the same five details.
 */
export default function TemplatesTab() {
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<WhatsAppTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WhatsAppTemplate | WhatsAppTemplateInput | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () =>
    whatsappApi
      .templates()
      .then(setTemplates)
      .catch((e) => setError(humanError(e)));

  useEffect(() => {
    void load();
  }, []);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  }

  if (!templates)
    return error ? (
      <p className="formerror">{error}</p>
    ) : (
      <LoadingRows rows={3} label="Loading" />
    );

  return (
    <div className="wa-stack">
      <section className="card">
        <div className="card__head">
          <div>
            <h2>Message templates</h2>
            <p className="card__sub">
              Reminders use templates Meta has approved as Utility. Create the template in
              WhatsApp Manager first, with named variables such as {'{{patient_name}}'},
              then add it here with the same name and language.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => setEditing({ ...STARTERS.sq })}
          >
            <Plus size={15} aria-hidden /> New template
          </button>
        </div>
        {error && <p className="formerror pad">{error}</p>}

        {templates.length === 0 ? (
          <div className="pad">
            <EmptyState
              icon={<FileText size={22} />}
              title="No reminder template yet"
              body="Start from the Albanian or English reminder, then match its name to your approved Meta template."
              action={
                <div className="inline-row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => setEditing({ ...STARTERS.sq })}
                  >
                    Albanian reminder
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setEditing({ ...STARTERS.en })}
                  >
                    English reminder
                  </button>
                </div>
              }
            />
          </div>
        ) : (
          <ul className="wa-templates">
            {templates.map((t) => {
              const state = templateState(t);
              return (
                <li key={t.id} className="wa-template">
                  <div className="wa-template__main">
                    <p className="inline-row" style={{ gap: 8, margin: 0 }}>
                      <strong>{t.displayName}</strong>
                      {t.isDefault && <StatusPill status="info" label="Default" />}
                      <StatusPill status={state.status} label={state.label} />
                    </p>
                    <p className="small muted" style={{ margin: '4px 0 0' }}>
                      <span className="wa-mono">{t.metaTemplateName}</span> ·{' '}
                      {t.languageCode}
                      {t.meta.category ? ` · ${t.meta.category.toLowerCase()}` : ''}
                    </p>
                    {t.meta.problem && t.isActive && (
                      <p className="small wa-problem">{t.meta.problem}</p>
                    )}
                  </div>
                  <div className="wa-template__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busyId === t.id}
                      onClick={() =>
                        void act(t.id, () => whatsappApi.checkTemplate(t.id))
                      }
                    >
                      <RefreshCw size={14} aria-hidden /> Check with Meta
                    </button>
                    {!t.isDefault && t.isActive && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busyId === t.id}
                        onClick={() =>
                          void act(t.id, () =>
                            whatsappApi.updateTemplate(t.id, { isDefault: true }),
                          )
                        }
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setEditing(t)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busyId === t.id}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Delete ${t.displayName}?`,
                          body: 'Its send history keeps the name.',
                          confirmLabel: 'Delete template',
                          danger: true,
                        });
                        if (ok) void act(t.id, () => whatsappApi.deleteTemplate(t.id));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {editing && (
        <TemplateEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TemplateEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: WhatsAppTemplate | WhatsAppTemplateInput;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = 'id' in initial ? initial.id : null;
  const [form, setForm] = useState<WhatsAppTemplateInput>({
    displayName: initial.displayName,
    metaTemplateName: initial.metaTemplateName,
    languageCode: initial.languageCode,
    previewBody: initial.previewBody,
    isActive: initial.isActive ?? true,
    isDefault: initial.isDefault ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLTextAreaElement>(null);

  // Sample patient, tomorrow at 09:00 Tirana time.
  const sample = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const at = new Date(`${d.toISOString().slice(0, 10)}T09:00:00+02:00`);
    return whatsAppReminderValues({
      ...WHATSAPP_SAMPLE,
      startsAt: at,
      timeZone: 'Europe/Tirane',
      languageCode: form.languageCode,
    });
  }, [form.languageCode]);

  const unknown = unknownWhatsAppVariables(form.previewBody);
  const set = <K extends keyof WhatsAppTemplateInput>(
    k: K,
    v: WhatsAppTemplateInput[K],
  ) => setForm((f) => ({ ...f, [k]: v }));

  function insert(variable: string) {
    const el = body.current;
    const token = `{{${variable}}}`;
    if (!el) return set('previewBody', form.previewBody + token);
    const start = el.selectionStart ?? form.previewBody.length;
    const end = el.selectionEnd ?? start;
    set(
      'previewBody',
      form.previewBody.slice(0, start) + token + form.previewBody.slice(end),
    );
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (unknown.length)
      return setError(
        `Remove ${unknown.map((u) => `{{${u}}}`).join(', ')}: a reminder cannot fill it.`,
      );
    setBusy(true);
    setError(null);
    try {
      if (id) {
        await whatsappApi.updateTemplate(id, form);
        // Not connected yet is fine: the list shows it as not checked.
        await whatsappApi.checkTemplate(id).catch(() => undefined);
      } else {
        await whatsappApi.createTemplate(form);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the template.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={id ? 'Edit template' : 'New template'}
      subtitle="Must match a template Meta has approved"
      onClose={onClose}
      wide
    >
      <form className="modal__body wa-editor" onSubmit={submit}>
        <div className="wa-editor__form">
          <label className="field">
            <span>Template display name</span>
            <input
              value={form.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              maxLength={80}
              required
            />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Meta WhatsApp template name</span>
              <input
                className="wa-mono"
                value={form.metaTemplateName}
                onChange={(e) =>
                  set(
                    'metaTemplateName',
                    e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                  )
                }
                pattern="[a-z0-9_]+"
                required
              />
            </label>
            <label className="field">
              <span>Template language</span>
              <select
                value={form.languageCode}
                onChange={(e) => set('languageCode', e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
                {!LANGUAGES.some((l) => l.code === form.languageCode) && (
                  <option value={form.languageCode}>{form.languageCode}</option>
                )}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Local message preview</span>
            <textarea
              ref={body}
              rows={6}
              value={form.previewBody}
              onChange={(e) => set('previewBody', e.target.value)}
              maxLength={1024}
              required
            />
          </label>
          <div className="wa-chips" aria-label="Insert a variable">
            {WHATSAPP_REMINDER_VARIABLES.map((v) => (
              <button key={v} type="button" className="wa-chip" onClick={() => insert(v)}>
                {`{{${v}}}`}
              </button>
            ))}
          </div>
          <div className="inline-row" style={{ gap: 20, flexWrap: 'wrap' }}>
            <label className="checkrow">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => set('isActive', e.target.checked)}
              />
              <span>Active</span>
            </label>
            <label className="checkrow">
              <input
                type="checkbox"
                checked={form.isDefault}
                disabled={!form.isActive}
                onChange={(e) => set('isDefault', e.target.checked)}
              />
              <span>Default for reminders</span>
            </label>
          </div>
          {error && <p className="formerror">{error}</p>}
        </div>

        <aside className="wa-editor__preview" aria-label="Live preview">
          <p className="small muted" style={{ margin: 0 }}>
            Preview with a sample patient
          </p>
          <p className="wa-bubble">{renderWhatsAppPreview(form.previewBody, sample)}</p>
          {unknown.length > 0 && (
            <p className="small wa-problem">
              A reminder cannot fill {unknown.map((u) => `{{${u}}}`).join(', ')}.
            </p>
          )}
        </aside>

        <div className="modal__foot wa-editor__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save and check with Meta'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
