// Per-feature string catalogs for the timeline operations (03 §18.7, 18.9, 18.10, 18.11): revert, queue,
// attachments and subagent keep their strings next to their code so the shared catalogs (src/i18n/ko.ts, en.ts) are
// edited only by the integrator. Keys use the `own.<area>.*` namespace and can move verbatim into ko.ts/en.ts
// (append-only sections named after the module). Keys 03 §14 already defines come from `useI18n().t`.
import { applyJosa, useI18n, type I18nParams, type Locale } from "@/i18n"

export type FeatureText<Key extends string> = (key: Key, params?: I18nParams) => string

/** Same rules as `translate` in src/i18n: current locale, Korean fallback, `{name}` params, Korean particles. */
export function featureText<Key extends string>(
  ko: Readonly<Record<Key, string>>,
  en: Readonly<Partial<Record<Key, string>>>,
) {
  const catalogs: Record<Locale, Readonly<Partial<Record<Key, string>>>> = { ko, en }
  const text = (locale: Locale, key: Key, params?: I18nParams) => {
    const template = catalogs[locale][key] ?? ko[key]
    const filled = params
      ? template.replace(/\{(\w+)\}/g, (match, name: string) => {
          const value = params[name]
          return value === undefined ? match : String(value)
        })
      : template
    return locale === "ko" ? applyJosa(filled) : filled
  }
  return {
    text,
    /** Reactive in JSX: reads the locale signal. */
    use(): FeatureText<Key> {
      const i18n = useI18n()
      return (key, params) => text(i18n.locale(), key, params)
    },
  }
}
