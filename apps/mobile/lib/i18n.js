import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import en from '../locales/en.json';
import hi from '../locales/hi.json';

export const i18n = new I18n({ en, hi });

// The handset's language, falling back to English for anything we do not ship.
i18n.locale = getLocales()[0]?.languageCode ?? 'en';
i18n.enableFallback = true;
i18n.defaultLocale = 'en';

export const t = (key, options) => i18n.t(key, options);

/**
 * Checklist labels are `{ en, hi }` objects served by the API, not entries in a
 * locale file — the questions change without an app release, so their
 * translations have to travel with the data.
 */
export const localised = (value) =>
  typeof value === 'string' ? value : (value?.[i18n.locale] ?? value?.en ?? '');
