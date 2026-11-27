// Hidden models (07 §7.1 숨긴 모델, PF 2026-11-03): models the user took out of the lists, per provider group (an
// account kind such as `codex` or `claude-sub`, or `local:<providerID>`), stored in own's `policy.json`
// (`hiddenModels`, never the vault) and mirrored to remote hosts with the policy. The switcher's model column, the
// preset editor's model lists and 설정 > 프리셋 read them here; hiding never touches a preset or a conversation that
// uses the model. Read from `policy.get` once per server and again after every change made here (`policy.get` has no
// change event). Only lazy screens import this file (PF5).
import type { Account } from "@own/protocol"
import { Policy } from "@own/protocol/policy"
import { Preset } from "@own/protocol/preset"
import { createRoot, createSignal } from "solid-js"
import type { OwnStore } from "@/data"
import { showToast } from "@/switcher/toast"
import type { PresetFixesKey } from "./pf-strings"

export interface Hidden {
  readonly list: () => ReadonlyArray<Policy.HiddenModel>
  readonly is: (group: string | undefined, model: string) => boolean
  /** Whether this window may change the list (`policy.set`). */
  readonly editable: () => boolean
  readonly hide: (group: string, model: string) => Promise<void>
  readonly show: (group: string, model: string) => Promise<void>
  readonly refresh: () => Promise<void>
}

const stores = new WeakMap<OwnStore, Hidden>()

/** The hidden models of one server's own store (shared by every screen of that server). */
export function hiddenOf(own: OwnStore): Hidden {
  const known = stores.get(own)
  if (known) return known
  const made = createRoot(() => make(own))
  stores.set(own, made)
  return made
}

function make(own: OwnStore): Hidden {
  const [list, setList] = createSignal<ReadonlyArray<Policy.HiddenModel>>([])
  const refresh = async () => {
    if (!own.rpc.allowed("policy.get")) return
    const answer = await own.rpc.call("policy.get", {})
    setList(answer.policy.hiddenModels ?? [])
  }
  const write = async (next: ReadonlyArray<Policy.HiddenModel>) => {
    const answer = await own.rpc.call("policy.set", { patch: { hiddenModels: next } })
    setList(answer.policy.hiddenModels ?? next)
  }
  void refresh().catch(() => undefined)
  return {
    list,
    is: (group, model) => Policy.hidden({ hiddenModels: list() }, group, model),
    editable: () => own.rpc.allowed("policy.set"),
    hide: (group, model) =>
      write([...list().filter((item) => item.group !== group || item.model !== model), { group, model }]),
    show: (group, model) => write(list().filter((item) => item.group !== group || item.model !== model)),
    refresh,
  }
}

/**
 * The provider group a model of an account is hidden under: a local provider's `local:<id>`, else the account's kind
 * (every ChatGPT account shares `codex`); `undefined` for an account this window does not know.
 */
export function groupOfAccount(account: string, accounts: Readonly<Record<string, Account.View | undefined>>) {
  if (Preset.isLocal(account)) return account
  return accounts[account]?.kind
}

/**
 * 목록에서 숨기기 with its way back (CAM-9): hides the model, then a toast names it with `되돌리기`; a refused change
 * says why. Shared by the screens that hide from a list (the switcher's model column).
 */
export function hideWithUndo(input: {
  readonly hidden: Hidden
  readonly group: string
  readonly model: { readonly id: string; readonly name: string }
  readonly text: (key: PresetFixesKey, params?: Record<string, string>) => string
}) {
  const failed = (error: unknown) =>
    showToast({
      tone: "danger",
      message: input.text("own.pf.hiddenFailed", { message: error instanceof Error ? error.message : String(error) }),
    })
  void input.hidden
    .hide(input.group, input.model.id)
    .then(() =>
      showToast({
        message: input.text("own.pf.hiddenToast", { name: input.model.name }),
        action: {
          label: input.text("own.pf.undo"),
          run: () => void input.hidden.show(input.group, input.model.id).catch(failed),
        },
      }),
    )
    .catch(failed)
}

/** 다시 보이기 of one model; a refused change says why. */
export function showAgain(input: Omit<Parameters<typeof hideWithUndo>[0], "model"> & { readonly modelID: string }) {
  void input.hidden.show(input.group, input.modelID).catch((error: unknown) =>
    showToast({
      tone: "danger",
      message: input.text("own.pf.hiddenFailed", { message: error instanceof Error ? error.message : String(error) }),
    }),
  )
}
