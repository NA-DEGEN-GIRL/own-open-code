// Web search services as 설정 > 웹 검색, the search cards and the conversation hint describe them (03 §18.2, WM
// 2026-10-19): who answers, what a search costs and where the query goes. Every service the server lists is shown,
// in the server's list order with ChatGPT first. Core's keyless services (packages/core/src/plugin/websearch/) and own's
// ChatGPT, DeepSeek and Brave (02 §9.2, SP 2026-10-19) get their own notes; any other (a plugin's) only its name.
// own's keyed variants (`own-exa` …, SK 2026-10-23) are core's keyless services asked with the user's key from own's
// vault: listed next to the keyless one, with the key's price, and the one `여러 서비스 함께` asks while listed.
// `여러 서비스 함께` (own's `own-multi`, MS 2026-10-19) is a way of searching, not a service of the list: the page
// shows it as a mode, a search card names the services that found its results (each merged result ends with a
// `Found by: …` line). Pure: no Solid; strings come in as `text`.
import type { Approval } from "@own/protocol"
import { storedLocale } from "@/i18n"
import type { FeatureText } from "@/queue/text"
import type { WebSearchKey } from "./strings"
import { isKeyless, type Keyless } from "./used"

export { CHATGPT, KEYLESS, isKeyless, type Keyless } from "./used"

export interface Listed {
  readonly id: string
  readonly name: string
}

/**
 * What a search with the service costs: `subscription` (ChatGPT usage), `balance` (own's DeepSeek: the `ds` account's
 * balance, $0.75 per 1,000), `vault` (own's Brave and keyed variants with the key in own's vault, billed by the
 * service), `free` (a keyless service without a key: free within its limits), `key`/`env` (the user's own key for a
 * core service in core's credentials or an environment variable, billed by that service), `unknown` (another service).
 */
export type Cost = "subscription" | "balance" | "vault" | "free" | Approval.WebSearchKey | "multi" | "unknown"

/**
 * own-accounts' multi-service search (`여러 서비스 함께`, `Approval.WEB_SEARCH_MULTI`); the server lists it only while
 * it is chosen. Spelled out: a value import of the protocol module would pull its schema code into the first chunk.
 */
export const MULTI = "own-multi"

/** own-accounts' DeepSeek and Brave services (02 §9.2): listed, never the default, and they cost money. */
export const DEEPSEEK = "own-deepseek"
export const BRAVE = "brave"

/** The services whose key own keeps (`SearchKey.Service`). */
export type SearchKeyService = typeof BRAVE | Keyless

/**
 * The keyless service of own's keyed variant (`own-exa` → `exa`, own-accounts `KeyedSearch`, `SearchKey.providerID`),
 * `undefined` for any other id. Spelled out like {@link MULTI}.
 */
export function keylessOf(id: string): Keyless | undefined {
  const service = id.startsWith("own-") ? id.slice("own-".length) : ""
  return isKeyless(service) ? service : undefined
}

/** own's keyed variant of a keyless service (`exa` → `own-exa`). */
export function keyedOf(id: Keyless) {
  return `own-${id}`
}

/**
 * The service whose own key (own's vault, `websearch.key.*`) belongs under a row of the page: Brave's under Brave,
 * a keyless service's under its keyed variant while that is listed, else under the keyless service itself.
 */
export function keyServiceOf(id: string, listed: readonly Listed[]): SearchKeyService | undefined {
  if (id === BRAVE) return BRAVE
  const keyless = keylessOf(id)
  if (keyless) return keyless
  return isKeyless(id) && !listed.some((item) => item.id === keyedOf(id)) ? id : undefined
}

/**
 * The service `여러 서비스 함께` asks for a selected id (own-accounts `KeyedSearch.resolve`): a keyless one through its
 * keyed variant while that is listed, a keyed variant whose key is gone keyless again, any other as it is.
 */
export function asked(id: string, listed: readonly Listed[]) {
  const keyless = isKeyless(id) ? id : keylessOf(id)
  if (!keyless) return id
  if (listed.some((item) => item.id === keyedOf(keyless))) return keyedOf(keyless)
  return listed.some((item) => item.id === keyless) ? keyless : id
}

/** The rows of `여러 서비스 함께`: one per service, a keyless service as its keyed variant while that is listed. */
export function multiRows<T extends Listed>(services: readonly T[]) {
  return services.filter((item) => {
    const id = item.id
    return !(isKeyless(id) && services.some((other) => other.id === keyedOf(id)))
  })
}

/** Names for ids session-ui would only capitalize (`own-chatgpt` → `Own-chatgpt`). */
const NAMES: Readonly<Record<string, string>> = {
  "own-chatgpt": "ChatGPT",
  [DEEPSEEK]: "DeepSeek",
  [BRAVE]: "Brave",
  exa: "Exa",
  firecrawl: "Firecrawl",
  parallel: "Parallel",
  tavily: "Tavily",
  tinyfish: "TinyFish",
}

/** The service's name: as the server lists it (`Exa (내 키)` for a keyed variant), else the known name, else its id. */
export function serviceName(id: string, listed?: readonly Listed[]) {
  const keyless = keylessOf(id)
  const name = listed?.find((item) => item.id === id)?.name ?? NAMES[id] ?? (keyless ? `${NAMES[keyless]} (내 키)` : id)
  // The service lists a keyed variant in Korean.
  return storedLocale() === "en" ? name.replace(/ \(내 키\)$/, " (my key)") : name
}

/** The name of the service behind an id: a keyed variant's keyless service (`Exa`), else {@link serviceName}. */
export function baseName(id: string, listed?: readonly Listed[]) {
  return serviceName(keylessOf(id) ?? id, listed)
}

/** A keyless service counts as free until the server says a key is in use (`keys` not loaded yet: free). */
export function costOf(id: string, keys?: Readonly<Record<string, Approval.WebSearchKey>>): Cost {
  if (id === "own-chatgpt") return "subscription"
  if (id === MULTI) return "multi"
  if (id === DEEPSEEK) return "balance"
  if (id === BRAVE || keylessOf(id)) return "vault"
  const key = keys?.[id]
  if (key) return key
  return isKeyless(id) ? "free" : "unknown"
}

/**
 * The services in the order the page and the dock show them: ChatGPT first (recommended), then the server's order,
 * each keyed variant right after its keyless service. `own-multi` is not one of them (it is the
 * `여러 서비스 함께` mode).
 */
export function ordered<T extends Listed>(listed: readonly T[]) {
  const services = listed.filter((item) => item.id !== MULTI)
  const variants = (id: string) => services.filter((item) => keylessOf(item.id) === id)
  const placed = services.filter((item) => {
    const keyless = keylessOf(item.id)
    return item.id !== "own-chatgpt" && !(keyless && services.some((other) => other.id === keyless))
  })
  return [
    ...services.filter((item) => item.id === "own-chatgpt"),
    ...placed.flatMap((item) => [item, ...variants(item.id)]),
  ]
}

/**
 * The service that answers searches now, as far as this window can tell (`websearch.get` and the list):
 * - `service`: one service; `chosen` when the config file names it, else own's default (ChatGPT while listed);
 *   `missing` when the chosen one is not listed now (core then falls back to its first-use answer or asks);
 * - `any`: core's `random` over the listed services; `off`: no web search; `multi`: `여러 서비스 함께`;
 * - `unset`: nothing chosen and no ChatGPT service: a first-use answer in core's KV (unreadable) or the form decides.
 */
export type Current =
  | { readonly type: "service"; readonly id: string; readonly chosen: boolean; readonly missing: boolean }
  | { readonly type: "any" }
  | { readonly type: "off" }
  | { readonly type: "multi" }
  | { readonly type: "unset" }

export function current(choice: Approval.WebSearchChoice | undefined, listed: readonly Listed[]): Current {
  if (choice?.type === "any" || choice?.type === "off" || choice?.type === "multi") return { type: choice.type }
  if (choice?.type === "service")
    return { type: "service", id: choice.id, chosen: true, missing: !listed.some((item) => item.id === choice.id) }
  if (listed.some((item) => item.id === "own-chatgpt"))
    return { type: "service", id: "own-chatgpt", chosen: false, missing: false }
  return { type: "unset" }
}

/**
 * The one-time hint's case (설정 hint, WM): searches answered by a free keyless service while the ChatGPT service is
 * listed. The first such service of `used`, if any.
 */
export function freeWhileChatGPT(
  used: readonly string[],
  listed: readonly Listed[],
  keys?: Readonly<Record<string, Approval.WebSearchKey>>,
): Keyless | undefined {
  if (!listed.some((item) => item.id === "own-chatgpt")) return undefined
  return used.find((id): id is Keyless => costOf(id, keys) === "free")
}

type Text = FeatureText<WebSearchKey>
type Keys = Readonly<Record<string, Approval.WebSearchKey>> | undefined

/** A search that costs money: own's DeepSeek (its balance), Brave and the keyed variants with a price (the user's key). */
export function paid(id: string) {
  const cost = costOf(id)
  return cost === "balance" || (cost === "vault" && PRICES[id] !== 0)
}

/**
 * The search card's title (session-ui shows it as is, transcript/tool-alias.ts): `ChatGPT로 검색`,
 * `Parallel로 검색 (무료)`, `Exa로 검색 (내 키)` (a key from an environment variable or own's vault too: `own-exa`),
 * `DeepSeek로 검색 (잔액)`, `Fake Search로 검색`; `여러 서비스로 검색 · ChatGPT·Exa·Parallel` with the services that
 * found its results (`found`, from its {@link foundBy} lines; none while it runs).
 */
export function cardTitle(
  provider: string,
  listed: readonly Listed[] | undefined,
  keys: Keys,
  text: Text,
  found: readonly string[] = [],
) {
  const cost = costOf(provider, keys)
  if (cost === "multi")
    return found.length > 0 ? text("own.ws.card.multiNames", { names: found.join("·") }) : text("own.ws.card.multi")
  return text(`own.ws.card.${cost === "env" || cost === "vault" ? "key" : cost}`, {
    name: baseName(provider, listed),
  })
}

/** The line each result of `여러 서비스 함께` ends with (own-accounts `MultiSearch.FOUND_BY`). */
const FOUND_BY = /^Found by: (.+)$/gm

/**
 * The services that found a `여러 서비스 함께` search's results and how many each, in the order they first appear,
 * read from the tool's text (core's result list).
 */
export function foundBy(texts: readonly string[]) {
  const counts = new Map<string, number>()
  for (const text of texts)
    for (const match of text.matchAll(FOUND_BY))
      for (const name of match[1]!.split(", ")) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count }))
}

/**
 * What one search of `여러 서비스 함께` may cost with `ids` chosen (prices of 2026-10-19, per search; with a key
 * a service's monthly free tier comes first, so these are upper bounds): `usd` summed over the paid ones,
 * `subscription` when ChatGPT is among them, `unknown` the names whose price this app does not know.
 */
export function multiCost(ids: readonly string[], listed: readonly Listed[], keys: Keys) {
  const priced = ids.map((id) => ({ id, cost: costOf(id, keys) }))
  return {
    usd: priced.reduce(
      (sum, item) => sum + (PRICES[item.cost === "key" || item.cost === "env" ? `${item.id}:key` : item.id] ?? 0),
      0,
    ),
    subscription: priced.some((item) => item.cost === "subscription"),
    unknown: priced
      .filter(
        (item) =>
          item.cost === "unknown" ||
          ((item.cost === "key" || item.cost === "env") && PRICES[`${item.id}:key`] === undefined),
      )
      .map((item) => serviceName(item.id, listed)),
  }
}

/** USD per search with a key: Exa, Parallel, Tavily, Firecrawl (upper bound) and TinyFish (free), the report's. */
const KEY_PRICES: Readonly<Record<Keyless, number>> = {
  exa: 0.007,
  parallel: 0.005,
  tavily: 0.008,
  firecrawl: 0.008,
  tinyfish: 0,
}

/**
 * USD per search: own's DeepSeek and Brave, own's keyed variants (`own-<id>`) and core's services with a key of core's
 * (`<id>:key`).
 */
const PRICES: Readonly<Record<string, number>> = {
  [DEEPSEEK]: 0.00075,
  [BRAVE]: 0.005,
  ...Object.fromEntries(
    Object.entries(KEY_PRICES).flatMap(([id, usd]) => [
      [`own-${id}`, usd],
      [`${id}:key`, usd],
    ]),
  ),
}

/**
 * What a search with the service costs and where its query goes: `ChatGPT 구독 사용량에서 빠져요` ·
 * `검색어가 ChatGPT(OpenAI)로 가요`, `무료 · 키 없음 · 사용량 제한 있음` · `검색어가 Parallel로 가요`, or with the user's
 * own key `내 Parallel 키로 검색해요 · Parallel 요금이 붙어요`; DeepSeek `DeepSeek 잔액에서 빠져요 · 1,000건에 약 $0.75` ·
 * `검색어가 중국(DeepSeek) 서버로 가요`, Brave and the keyed variants `내 키 · 요금 붙음 · 1,000건에 약 $7(매달 $10어치
 * 무료)` · `검색어가 Exa로 가요` (the keyless service's name). Another service: where only (its cost is not known here).
 */
export function facts(service: Listed, keys: Keys, text: Text) {
  const cost = costOf(service.id, keys)
  const where = text("own.ws.where", { name: keylessOf(service.id) ? baseName(service.id) : service.name })
  if (cost === "subscription") return [text("own.ws.cost.subscription"), text("own.ws.where.subscription")]
  if (cost === "multi") return []
  if (cost === "balance") return [text("own.ws.cost.balance"), text("own.ws.where.balance")]
  if (cost === "vault") return [text(`own.ws.cost.vault.${keylessOf(service.id) ?? BRAVE}`), where]
  if (cost === "unknown") return [where]
  if (cost === "free") return [text("own.ws.cost.free"), where]
  return [text(`own.ws.cost.${cost}`, { name: service.name }), where]
}

/**
 * The service's own note on 설정 > 웹 검색 (free tier, price with a key, how own's services pick an account):
 * ChatGPT's, DeepSeek's, Brave's and the keyless ones' (a keyed variant has its keyless service's).
 */
export function noteKey(id: string): WebSearchKey | undefined {
  if (id === "own-chatgpt") return "own.ws.note.subscription"
  if (id === DEEPSEEK || id === BRAVE) return `own.ws.note.${id}`
  const keyless = keylessOf(id) ?? id
  return isKeyless(keyless) ? `own.ws.note.${keyless}` : undefined
}
