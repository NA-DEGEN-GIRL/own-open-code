// 설정 > GitHub's plain rules (16, GH 2026-10-31): how an account, the account in use and a choice read on the page.
// No Solid, no RPC: the page and its tests share them.
import type { OwnGitHub } from "@own/protocol"
import { samePath } from "@/projects/path"
import type { GitHubKey } from "./strings"

export type Text = (key: GitHubKey, params?: Readonly<Record<string, string | number>>) => string

/** `회사 (octo-work)`, the site added when it is not github.com. */
export function accountName(account: Pick<OwnGitHub.Account, "label" | "login" | "site">) {
  const site = account.site === "https://github.com" ? "" : ` · ${new URL(account.site).host}`
  return `${account.label} (${account.login}${site})`
}

/** The account in use and where its choice came from, or why there is none. */
export function inUseText(view: Pick<OwnGitHub.View, "accounts" | "inUse">, text: Text) {
  const inUse = view.inUse
  if (!inUse || inUse.source === "none") return text("own.gh.inUse.none")
  if (inUse.source === "off") return text("own.gh.inUse.off")
  const account = view.accounts.find((item) => item.id === inUse.account)
  if (!account) return text("own.gh.inUse.none")
  return `${accountName(account)} · ${text(`own.gh.source.${inUse.source}`)}`
}

/** The tags of an account row: default, writes, the token kind and its expiry. */
export function accountTags(account: OwnGitHub.Account, view: Pick<OwnGitHub.View, "default">, text: Text) {
  return [
    ...(view.default === account.id ? [text("own.gh.default")] : []),
    text(account.write ? "own.gh.write" : "own.gh.read"),
    text(`own.gh.kind.${account.tokenKind}`),
    ...(account.hint ? [account.hint] : []),
    ...(account.expiresAt === undefined
      ? []
      : [text("own.gh.expires", { date: new Date(account.expiresAt).toISOString().slice(0, 10) })]),
  ]
}

/** A select's value for a choice: an account id, `off`, or `""` for none. */
export function choiceValue(choice: OwnGitHub.Choice | undefined) {
  return choice ?? ""
}

/** The choice a select's value stands for: `null` deletes the choice there. */
export function choiceOf(value: string): OwnGitHub.Choice | null {
  if (value === "") return null
  return value as OwnGitHub.Choice
}

/** The project choice at exactly `directory` (not one it inherits): this PC's, or with `host` that SSH host's (16 §8). */
export function projectChoiceAt(view: Pick<OwnGitHub.View, "projects">, directory: string | undefined, host?: string) {
  if (directory === undefined) return undefined
  return view.projects.find((item) => item.host === host && samePath(item.directory, directory))?.account
}

/** A conversation's own choice: this PC's, or with `host` that SSH host's. */
export function sessionChoice(view: Pick<OwnGitHub.View, "sessions">, sessionID: string, host?: string) {
  return view.sessions.find((item) => item.sessionID === sessionID && item.host === host)?.account
}

/** Whether this PC lets the SSH host `host` write on GitHub (16 §8.11, GH-49); a new host only reads. */
export function hostWrites(view: Pick<OwnGitHub.View, "settings">, host: string) {
  return (view.settings.writeHosts ?? []).includes(host)
}

/** The hosts that may write once `host` is allowed (`on`) or not, for `github.settings.set{writeHosts}`. */
export function writeHostsWith(view: Pick<OwnGitHub.View, "settings">, host: string, on: boolean) {
  const others = (view.settings.writeHosts ?? []).filter((item) => item !== host)
  return on ? [...others, host] : others
}

/** The error's words: a refused token, another user's token, an unreachable GitHub, a taken name. */
export function errorText(type: string | undefined, data: unknown, message: string, text: Text) {
  if (type === "github_token_invalid")
    return text(
      isRecord(data) && data.mismatch === true ? "own.gh.error.mismatch" : "own.gh.error.github_token_invalid",
    )
  if (type === "github_unavailable") return text("own.gh.error.github_unavailable")
  if (type === "vault_unavailable") return text("own.gh.error.vault_unavailable")
  if (type === "github_invalid" && isRecord(data) && data.field === "label") return text("own.gh.error.label")
  return text("own.gh.failed", { message })
}

/** GitHub's toolsets own offers to choose (16 §5.2). */
export const TOOLSETS = [
  "context",
  "repos",
  "issues",
  "pull_requests",
  "actions",
  "code_security",
  "dependabot",
  "discussions",
  "gists",
  "labels",
  "notifications",
  "orgs",
  "projects",
  "secret_protection",
  "security_advisories",
  "users",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
