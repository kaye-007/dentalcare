import { LOCALES, LOCALE_LABELS, LOCALE_NAMES, useI18n } from '../lib/i18n';

/**
 * SQ | EN.
 *
 * A two-item segmented control rather than a dropdown: with exactly two
 * options a select costs an extra click to show one alternative, and this sits
 * on the login screen where a receptionist who cannot read the interface needs
 * to find it without reading anything.
 *
 * The labels are never translated — "SQ" and "EN" name their own languages, so
 * they stay legible no matter which one is currently active.
 */
export default function LanguageToggle({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const { locale, setLocale } = useI18n();

  return (
    <div
      className={`langtoggle${size === 'sm' ? ' langtoggle--sm' : ''}`}
      role="group"
      aria-label="Gjuha / Language"
    >
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          className={`langtoggle__btn${l === locale ? ' langtoggle__btn--active' : ''}`}
          // The accessible name is the language's own name, not the two-letter
          // code, which a screen reader would spell out one letter at a time.
          aria-label={LOCALE_NAMES[l]}
          aria-pressed={l === locale}
          onClick={() => setLocale(l)}
        >
          {LOCALE_LABELS[l]}
        </button>
      ))}
    </div>
  );
}
