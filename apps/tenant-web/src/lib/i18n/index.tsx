import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { sq, type MessageKey } from './sq';
import { en } from './en';

export type { MessageKey } from './sq';

export const LOCALES = ['sq', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** Shqip is the default: the product ships to Albanian clinics. */
export const DEFAULT_LOCALE: Locale = 'sq';

export const STORAGE_KEY = 'dentalcare_locale';

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { sq, en };

/** Short label for the toggle. Never translated — it names its own language. */
export const LOCALE_LABELS: Record<Locale, string> = { sq: 'SQ', en: 'EN' };

/** What each locale is called IN that locale, for the settings picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  sq: 'Shqip',
  en: 'English',
};

/**
 * BCP-47 tags for Intl. Kept beside the dictionaries so dates, times and money
 * move with the interface language instead of staying frozen at en-GB — which
 * is what "translated" quietly failed to mean before this.
 */
const INTL_LOCALES: Record<Locale, string> = { sq: 'sq-AL', en: 'en-GB' };

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

function readStored(): Locale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isLocale(raw)) return raw;
  } catch {
    // Private mode, or storage disabled by policy. Not a reason to fail.
  }
  return DEFAULT_LOCALE;
}

/**
 * The Intl tag for the active locale.
 *
 * A module-level mirror of the React state, because date formatting happens
 * inside plain helper functions and `Intl` calls scattered through pages that
 * are not all hooks. The provider keeps it in step; nothing else writes it.
 */
let activeIntlLocale: string = INTL_LOCALES[readStoredSafely()];

function readStoredSafely(): Locale {
  return typeof window === 'undefined' ? DEFAULT_LOCALE : readStored();
}

export function dateLocale(): string {
  return activeIntlLocale;
}

export type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nState | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredSafely);

  useEffect(() => {
    activeIntlLocale = INTL_LOCALES[locale];
    // Screen readers and hyphenation both key off this; an Albanian interface
    // announced as English reads as gibberish.
    document.documentElement.lang = locale;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Preference simply does not persist. The session still works.
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);

  const t = useCallback<Translate>(
    (key, vars) => {
      // `?? key` cannot normally fire — the dictionaries are typed against one
      // another — but a stale bundle in a cached tab should show the key
      // rather than "undefined".
      const template = DICTIONARIES[locale][key] ?? sq[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in vars ? String(vars[name]) : whole,
      );
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

/** The common case: `const t = useT()`. */
export function useT(): Translate {
  return useI18n().t;
}
