export * as GitHubMask from "./mask.js"

import type { Deps } from "../deps.js"
import { McpProbe } from "../mcp/probe.js"
import { GitHubStore } from "./store.js"

/**
 * What hides the connected accounts' tokens in a text (GH-18, GH-30): every account's token and refresh token, git's
 * Basic login of the token, their base64 forms, and the tokens replaced or removed in the last 30 days (by hash). This
 * PC's tool results and model requests (`GitHubConnection`) and the results this PC relays to an SSH host
 * (`GitHubRelay.call`, GH-50) use it.
 */
export interface Mask {
  /** Each connected account's values, by id: kept for an account whose token the vault does not give. */
  readonly accounts: ReadonlyMap<string, ReadonlyArray<string>>
  readonly text: (text: string) => string
  /** Nothing to mask. */
  readonly empty: boolean
}

/**
 * The mask of now. An account whose token the vault does not give keeps `previous`'s values (fail closed, GH-30); a
 * file that cannot be read rejects.
 */
export async function read(deps: Pick<Deps, "runtime" | "clock">, previous?: Mask): Promise<Mask> {
  const file = await GitHubStore.file(deps).read()
  const secrets = await Promise.all(
    file.accounts.map(async (entry) => {
      const secret = await GitHubStore.secret(deps, entry.id)
      // The vault did not answer: this account's last known values stay masked.
      if (!secret) return [entry.id, previous?.accounts.get(entry.id) ?? []] as const
      const values = [
        ...loginForms(entry.login, secret.token),
        ...(secret.refresh === undefined ? [] : [secret.refresh, ...base64Forms(secret.refresh)]),
      ]
      return [entry.id, values] as const
    }),
  )
  const accounts = new Map(secrets)
  const values = [...accounts.values()].flat()
  const masker = values.length === 0 ? undefined : McpProbe.masker(values)
  const now = deps.clock.now()
  const retired = new Set((file.retired ?? []).filter((item) => item.until > now).map((item) => item.hash))
  return {
    accounts,
    // Retired tokens first: a live token's mask may cut part of one (a shared run), and then its hash would not match.
    text: (text) => {
      const kept = maskRetired(text, retired)
      return masker ? masker.text(kept) : kept
    },
    empty: values.length === 0 && retired.size === 0,
  }
}

/**
 * A token and git's Basic login of it as they may show in a text: the token, its base64 forms, and base64 of
 * `<login>:<token>` with its forms. Never the login alone.
 */
export function loginForms(login: string, token: string) {
  const basic = `${login}:${token}`
  return [token, ...base64Forms(token), Buffer.from(basic).toString("base64"), ...base64Forms(basic)]
}

/**
 * The base64 forms of a value as they show inside a longer base64 text (a `data:` URI, an `Authorization: Basic`
 * header, a file's encoded content): at each of the three byte alignments, only the characters the value alone
 * decides, in the standard and the URL alphabets (GH-30).
 */
export function base64Forms(value: string) {
  const bytes = Buffer.from(value)
  return [0, 1, 2].flatMap((shift) => {
    const encoded = Buffer.concat([Buffer.alloc(shift), bytes])
      .toString("base64")
      .replace(/=+$/, "")
    const rest = (shift + bytes.length) % 3
    const inner = encoded.slice(shift === 0 ? 0 : 4, encoded.length - (rest === 0 ? 0 : rest + 1))
    return inner.length < McpProbe.MASK_MIN ? [] : [inner, inner.replaceAll("+", "-").replaceAll("/", "_")]
  })
}

/** What looks like a GitHub token: its prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`). */
const TOKEN_SHAPE = /gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}/g

/** `text` with every token-shaped word whose hash is a retired token's cut out (GH-30). */
function maskRetired(text: string, retired: ReadonlySet<string>) {
  if (retired.size === 0) return text
  return text.replace(TOKEN_SHAPE, (found) => (retired.has(GitHubStore.hashOf(found)) ? "••••" : found))
}
