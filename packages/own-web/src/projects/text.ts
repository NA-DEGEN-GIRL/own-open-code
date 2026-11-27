// Feature string catalogs that live next to their module until the integrator moves them into src/i18n (append-only
// sections). Same rules as `translate` in src/i18n: current locale, Korean fallback, `{name}` params, Korean
// particles resolved after the params are filled in. Used by projects, mcp and policy.
import { applyJosa, useI18n, type I18nParams, type Locale } from "@/i18n"

export type CatalogText<K extends string> = (locale: Locale, key: K, params?: I18nParams) => string

export function catalogText<K extends string>(
  ko: Readonly<Record<K, string>>,
  en: Readonly<Partial<Record<K, string>>>,
): CatalogText<K> {
  return (locale, key, params) => {
    const template = (locale === "en" ? en[key] : undefined) ?? ko[key]
    const filled = params
      ? template.replace(/\{(\w+)\}/g, (match, name: string) => {
          const value = params[name]
          return value === undefined ? match : String(value)
        })
      : template
    return locale === "ko" ? applyJosa(filled) : filled
  }
}

/** Binds a catalog to the current locale: `const text = useCatalogText(projectsText)`. */
export function useCatalogText<K extends string>(text: CatalogText<K>) {
  const i18n = useI18n()
  return (key: K, params?: I18nParams) => text(i18n.locale(), key, params)
}
