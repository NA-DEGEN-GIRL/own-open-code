// Defaults of a session this window is about to create (03 §5.1, 07 §2.2), shared by the home composer and the
// switcher so both show the same "모델 @ 계정": the folder is the project on screen, else (the new-conversation screen
// without a project) the server's 기본 대화 폴더, and only on an older service without one the most recent session's
// folder. The combination is the one chosen in the switcher, else the last one used in that folder, else the
// new-session account (07 §2.2 rule 3) with its provider group's default model. A folder never inherits another
// folder's model: the user sets that start with `새 대화 기본으로`. On an SSH host the Claude slot counts only while
// this PC relays it there (04 §8.11.13, the host's verdict `enabled`).
import type { Account } from "@own/protocol"
import { Kind } from "@own/protocol/kind"
import { Preset } from "@own/protocol/preset"
import type { ServerKey, ServerRuntime } from "@/data"
import { priceOf } from "@/presets/model"
import type { Route } from "@/routing/routes"
import { defaultFolder } from "@/projects/default-folder"
import { samePath } from "@/projects/path"
import { claudeServes } from "@/servers/claude"
import { targetFor } from "@/sidebar/target"
import type { TargetRef } from "./cost"
import { switcherControl } from "./control"
import { catalog, catalogFailed, catalogLoaded, providerModels } from "./labels"

export function newSessionDirectory(runtime: ServerRuntime, route: Route) {
  const index = runtime.sessions.state
  // A folder opened from the sidebar (18.3) carries the server-normalized path before the project is listed.
  if (route.name === "project")
    return targetFor(route.serverKey, route.projectID)?.directory ?? index.projects[route.projectID]?.directory
  const folder = defaultFolder(runtime)
  if (!folder.unsupported()) return folder.view()?.path
  const first = index.order[0]
  return first ? index.sessions[first]?.directory : undefined
}

/**
 * The folder the new-session screen's lookups read (models, `@` files, skills, attachments): the folder it starts in,
 * except a default conversation folder that does not exist yet. Its first use creates it; until then nothing asks for a
 * Location that cannot load, and the server's global models and skills are what such a folder would have anyway.
 */
export function newSessionLookup(runtime: ServerRuntime, route: Route) {
  const directory = newSessionDirectory(runtime, route)
  const view = defaultFolder(runtime).view()
  return directory !== undefined && view && !view.exists && samePath(view.path, directory) ? undefined : directory
}

export function newSessionTarget(
  runtime: ServerRuntime,
  serverKey: ServerKey,
  directory: string | undefined,
): TargetRef | undefined {
  const chosen = switcherControl.state.newSession[serverKey]
  if (chosen) return chosen
  const index = runtime.sessions.state
  const own = runtime.own.state
  const usable = (providerID: string) => {
    const account = runtime.own.accountFor(providerID)
    if (account)
      return account.status !== "retired" && account.status !== "disabled" && claudeServes(runtime, account.kind)
    // No account: a provider of the server's own config stays usable. An own slot (`own-<kind>-<slug>`) whose account
    // this server's registry no longer lists (removed on the PC, then mirrored to the host) has no slot any more: a
    // session created on it fails at its first request (found on a real SSH host, 04 §20.3 RG13).
    return own.status !== "ready" || Kind.ProviderID.parse(providerID) === undefined
  }
  const rows = index.order.flatMap((id) => {
    const row = index.sessions[id]
    return row?.model && usable(row.model.providerID) ? [row] : []
  })
  const recent = rows.find((row) => row.directory === directory)
  if (recent?.model) return { providerID: recent.model.providerID, id: recent.model.id, variant: recent.model.variant }
  const account = newSessionAccount(runtime)
  return account ? groupDefault(runtime, account) : undefined
}

/**
 * Whether a new session's "모델 @ 계정" ({@link newSessionTarget}) may still appear: the accounts, the group defaults or
 * the model catalog of the account it would start on have not answered yet. A send then says the screen is still
 * loading instead of "add your first account" (RL5-1: a tap 0.3 s after the page loaded, before the presets and the
 * policy answered, named an account the user already has as missing).
 */
export function newSessionLoading(runtime: ServerRuntime) {
  const own = runtime.own.state
  if (own.status === "idle" || own.status === "loading" || !own.defaultsLoaded) return true
  const account = newSessionAccount(runtime)
  if (!account || providerModels(runtime, account.providerID).length > 0) return false
  return !catalogLoaded(runtime) && !catalogFailed(runtime)
}

/**
 * 07 §2.2 rule 3, the same rule as the service's `pin()`: the kind's default account (`이 프로바이더의 기본 계정`) of the
 * most recent session's account, else that account, each only when it can serve now; else the first account in order
 * that can.
 */
function newSessionAccount(runtime: ServerRuntime) {
  const index = runtime.sessions.state
  const own = runtime.own.state
  const latest = index.order.map((id) => index.sessions[id]?.model).find((model) => model)
  const recent = latest ? runtime.own.accountFor(latest.providerID) : undefined
  const named =
    recent && recent.kind !== "claude-sub" && recent.kind !== "claude-agent"
      ? own.defaultAccounts[recent.kind]
      : undefined
  return (
    serving(runtime, named === undefined ? undefined : own.accounts[named]) ??
    serving(runtime, recent) ??
    own.accountOrder.map((id) => own.accounts[id]).find((account) => serving(runtime, account))
  )
}

/**
 * Whether an account can serve now, the service's test: `ready`, or an own account still `unverified` before its first
 * answer. The Claude slot's `unverified` means not acknowledged: its models are off. On an SSH host the Claude slot
 * also needs the host's verdict `enabled` (04 §8.11.13).
 */
function serving(runtime: ServerRuntime, account: Account.View | undefined) {
  if (!account) return undefined
  const usable = account.status === "ready" || (account.status === "unverified" && account.kind !== "claude-sub")
  return usable && claudeServes(runtime, account.kind) ? account : undefined
}

/**
 * The model a new session on this account starts with (07 §2.2): its provider group's default with that effort when
 * the account has it, else the group rule over the account's own models (07 §4.3; without the Codex hints only the
 * service reads), each priced like the service prices them: a ChatGPT login's free models by their API twin in the
 * catalog (`priceOf`, the `openai` catalog's price). Nothing until the group defaults have loaded, so the composer
 * never shows a guess first.
 */
function groupDefault(runtime: ServerRuntime, account: Account.View): TargetRef | undefined {
  const own = runtime.own.state
  if (!own.defaultsLoaded) return undefined
  const models = providerModels(runtime, account.providerID)
  const preferred = own.groupDefaults[account.kind]
  const everything = catalog(runtime)
  const choice =
    preferred && models.some((model) => model.id === preferred.id)
      ? preferred
      : Preset.defaultModel(
          account.kind,
          Preset.candidates(models, (model) => priceOf(model, everything)),
        )
  return choice ? { providerID: account.providerID, id: choice.id, variant: choice.variant } : undefined
}

/**
 * Whether the server serves `target` in `directory` before a new session is created on it (04 §12.4, MR11-1). A new
 * session on an SSH host starts on this PC's "모델 @ 계정" (`remote/picker.tsx`), but the host lists this PC's accounts
 * only once its mirror arrived through the credential broker, which may still be connecting right after the host
 * connected (tens of seconds under load). A session created before that failed its first prompt (`Model unavailable:
 * own-oai-…/gpt-6.1-terra`) and stayed failed. The folder's catalog is read once; the host's `model.updated` refreshes
 * it when the mirror lands, so this waits for that (`onWait` once) up to `timeoutMs`: `served`, or `missing` after it.
 * The user may leave the screen meanwhile (`left`): the wait ends at once with `left`, and nothing is created then
 * (MR12-5). `left` is read again right before `served` too, so a user who left during the catalog read, the last poll or
 * the caller's earlier steps (the default folder, decisions RL2-L3) is never sent to a new session. This PC lists its own
 * default: no wait and no request there.
 */
/** How often {@link hostServes} reads the host folder's catalog again while it waits. */
const RESYNC_MS = 3_000

export async function hostServes(
  runtime: ServerRuntime,
  target: Pick<TargetRef, "providerID" | "id">,
  directory: string,
  input: {
    readonly onWait?: () => void
    readonly left?: () => boolean
    readonly timeoutMs?: number
    readonly pollMs?: number
  } = {},
): Promise<"served" | "missing" | "left"> {
  const done = () => (input.left?.() ? "left" : "served")
  if (runtime.kind !== "ssh") return done()
  const served = () =>
    runtime.data.location.model
      .list({ directory })
      ?.some((model) => model.providerID === target.providerID && model.id === target.id && model.enabled) === true
  await runtime.data.location.model.sync({ directory }).catch(() => undefined)
  if (served()) return done()
  input.onWait?.()
  // 120 s (60 s before v2.4.1): the host's own.accounts now loads in the background after its service starts (#63814),
  // and only then registers the mirror's slots, so a freshly connected host takes longer to list this PC's models.
  const deadline = Date.now() + (input.timeoutMs ?? 120_000)
  // The catalog is read again every few seconds too: since upstream v2.4.0 (#63814) the host's plugins load in the
  // background, and a `model.updated` published before this client listened is not seen again.
  const state = { synced: Date.now() }
  while (Date.now() < deadline) {
    if (input.left?.()) return "left"
    await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 250))
    if (Date.now() - state.synced >= RESYNC_MS) {
      state.synced = Date.now()
      await runtime.data.location.model.sync({ directory }).catch(() => undefined)
    }
    if (served()) return done()
  }
  return input.left?.() ? "left" : "missing"
}
