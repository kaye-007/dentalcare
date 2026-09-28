import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { settingsApi, ApiError, type ClinicSettings, humanError } from '../../lib/api';
import { prepareLogo } from '../../lib/image';
import { SaveButton, useSave } from '../../pages/SettingsPage';

const DEFAULT_BRAND = '#4b57e3';

/**
 * The clinic's own mark on what it prints. The logo is re-encoded in the
 * browser (see lib/image) because its destination is the invoice PDF.
 */
export default function BrandingCard({
  settings,
  onChange,
}: {
  settings: ClinicSettings;
  onChange: (s: ClinicSettings) => void;
}) {
  const [color, setColor] = useState(settings.brandColor ?? DEFAULT_BRAND);
  const [uploading, setUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = useSave();

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLogoError(null);
    setUploading(true);
    try {
      onChange(await settingsApi.uploadLogo(await prepareLogo(file)));
    } catch (err) {
      setLogoError(humanError(err, 'Could not upload the logo.'));
    } finally {
      setUploading(false);
    }
  }

  async function removeLogo() {
    setLogoError(null);
    try {
      onChange(await settingsApi.removeLogo());
    } catch (err) {
      setLogoError(err instanceof ApiError ? err.message : 'Could not remove the logo.');
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const out = await save.run(() => settingsApi.update({ brandColor: color }));
    if (out) onChange(out);
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Branding</h2>
          <p className="card__sub">
            The logo and colour on invoices and printed documents.
          </p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <div className="inline-row">
          <div className="logo-slot">
            {settings.logoUrl ? (
              <img src={settings.logoUrl} alt="Clinic logo" />
            ) : (
              <span className="muted" style={{ fontSize: 12.5 }}>
                No logo
              </span>
            )}
          </div>
          <div className="settings-stack" style={{ gap: 8 }}>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={pick}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
            >
              <ImagePlus size={14} aria-hidden />{' '}
              {uploading
                ? 'Uploading…'
                : settings.logoUrl
                  ? 'Replace logo'
                  : 'Upload logo'}
            </button>
            {settings.logoUrl && (
              <button
                type="button"
                className="btn btn--danger-ghost btn--sm"
                onClick={removeLogo}
              >
                <Trash2 size={14} aria-hidden /> Remove
              </button>
            )}
            <span className="field-hint">
              PNG, JPEG or WEBP. Transparent logos are placed on white.
            </span>
          </div>
        </div>
        {logoError && <p className="formerror">{logoError}</p>}

        <div className="field">
          <span>Brand colour</span>
          <div className="inline-row">
            <input
              className="swatch"
              type="color"
              value={color}
              onChange={(e) => {
                save.setSaved(false);
                setColor(e.target.value);
              }}
              aria-label="Pick a brand colour"
            />
            <input
              value={color}
              onChange={(e) => {
                save.setSaved(false);
                setColor(e.target.value);
              }}
              aria-label="Brand colour as a hex code"
              pattern="#[0-9a-fA-F]{6}"
              maxLength={7}
              style={{ maxWidth: 120 }}
            />
          </div>
        </div>
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}
