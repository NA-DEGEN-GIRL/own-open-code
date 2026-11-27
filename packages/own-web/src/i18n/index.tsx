import { createContext, createSignal, useContext, type Accessor, type ParentProps } from "solid-js"
import { applyJosa } from "./josa"
import { ko, type I18nKey } from "./ko"

export type { I18nKey } from "./ko"
export { applyJosa } from "./josa"

export type Locale = "ko" | "en"
export type I18nParams = Readonly<Record<string, string | number>>

const LOCALE_KEY = "own.web.locale"
/**
 * The English catalog, once loaded: its own chunk (PF5). The entry waits for it when the stored language is English
 * (../entry.tsx), the palette loads it for the other language's words, and `t` falls back to Korean until it is there.
 */
const [english, setEnglish] = createSignal<Partial<Record<I18nKey, string>>>({})
const loading: { current?: Promise<void> } = {}

/** Loads the English catalog (once; a failed load may be tried again). */
export function loadEnglish() {
  return (loading.current ??= import("./en").then(
    (module) => void setEnglish(module.en),
    () => void delete loading.current,
  ))
}

export interface I18n {
  readonly locale: Accessor<Locale>
  setLocale(locale: Locale): void
  /** Looks the key up in the current locale, then Korean; fills `{name}` params and resolves Korean particles. */
  t(key: I18nKey, params?: I18nParams): string
  /** Locale-aware number formatting for counts and token amounts. */
  number(value: number, options?: Intl.NumberFormatOptions): string
}

export function createI18n(initial: Locale = storedLocale()): I18n {
  const [locale, setLocale] = createSignal<Locale>(initial)
  const formats = new Map<string, Intl.NumberFormat>()
  return {
    locale,
    setLocale(next) {
      if (next === "en") void loadEnglish()
      setLocale(next)
      document.documentElement.lang = next
      try {
        localStorage.setItem(LOCALE_KEY, next)
      } catch {}
    },
    t: (key, params) => translate(locale(), key, params),
    number(value, options) {
      const id = `${locale()}:${JSON.stringify(options ?? {})}`
      const format = formats.get(id) ?? new Intl.NumberFormat(locale(), options)
      formats.set(id, format)
      return format.format(value)
    },
  }
}

export function translate(locale: Locale, key: I18nKey, params?: I18nParams) {
  const template = (locale === "en" ? english()[key] : undefined) ?? ko[key]
  const filled = params ? template.replace(/\{(\w+)\}/g, (match, name: string) => fill(params[name], match)) : template
  return locale === "ko" ? applyJosa(filled) : filled
}

function fill(value: string | number | undefined, match: string) {
  return value === undefined ? match : String(value)
}

/** The chosen locale outside the component tree (lazy chunks that toast on a server event). */
export function storedLocale(): Locale {
  try {
    return localStorage.getItem(LOCALE_KEY) === "en" ? "en" : "ko"
  } catch {
    return "ko"
  }
}

const I18nContext = createContext<I18n>()

export function I18nProvider(props: ParentProps<{ value?: I18n }>) {
  const value = props.value ?? createI18n()
  // index.html says `ko`: the stored language decides the fonts and how a screen reader speaks from the first paint on.
  document.documentElement.lang = value.locale()
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
}

export function useI18n() {
  const value = useContext(I18nContext)
  if (!value) throw new Error("useI18n() needs <I18nProvider>")
  return value
}
