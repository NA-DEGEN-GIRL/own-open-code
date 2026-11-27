// Accounts module entry (03 §5.4, owner: accounts), lazy for /accounts and /accounts/add (20.2 R5). AccountManager:
// provider sections of account cards, the Claude plugin slot section, the Claude Agent section (02 §8.10, its own lazy
// chunk, loaded only while such an account exists), kinds without accounts, and the dialogs of the `⋯` menu, the
// add-account flow (5.4), the old-app import (5.4.2) and the Claude slot (5.4.1). Every write is an `own.accounts`
// RPC; `local`-scope methods only show when `own.rpc.allowed(method)` (02 §9.1).
import type { Account, Kind } from "@own/protocol"
import { createMemo, createSignal, For, lazy, Show, Suspense } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { Dialog, ProviderMark, Tag, createStatus, StatusLine } from "@/limits/kit"
import { observe } from "@/limits/observations"
import { loadPolicy, policyState, statusLine, updatePolicy } from "@/limits/shared"
import { useRouter } from "@/routing/router"
import { focusCompaction } from "@/settings/focus"
import { AccountCard, type CardAction } from "./account-card"
import { BudgetDialog, RemoveDialog, RenameDialog, ReplaceKeyDialog } from "./account-dialogs"
import { AddAccountDialog } from "./add-account"
import { CompatCapabilitiesDialog } from "./compat-capabilities"
import { ChatGPTLogin } from "./chatgpt-login"
import { ClaudeSection, ColorDialog, createClaudeStatus } from "./claude-slot"
import { CodexImportDialog, type CodexTarget } from "./codex-import"
import { errorMessage } from "./errors"
import { KIND_ORDER, kindLabel, pageSections, TYPE_LABEL, typeTag } from "./model"

const ClaudeAgentSection = lazy(() =>
  import("./claude-agent").then((module) => ({ default: module.ClaudeAgentSection })),
)
// 02 §3.3a `로컬 모델로 바꾸기` / `API 형식 바꾸기…`: its own chunk, loaded when first opened.
const LocalConvertDialog = lazy(() => import("./local-convert"))

/** Kinds drawn in sections of their own: neither has an API key, a default or the generic card's actions. */
const OWN_SECTION: ReadonlySet<Kind.Any> = new Set(["claude-sub", "claude-agent"])

export interface AccountsPageProps {
  readonly mode: "list" | "add"
  /** `add` only: open on this kind's key form. */
  readonly kind?: "oai"
}

type Open =
  | {
      readonly kind: "rename" | "color" | "budget" | "replaceKey" | "remove" | "relogin" | "capabilities" | "local"
      readonly accountID: string
    }
  | { readonly kind: "codex"; readonly target?: CodexTarget }

export default function AccountsPage(props: AccountsPageProps) {
  const data = useData()
  const i18n = useI18n()
  const router = useRouter()
  const own = data.local().own
  observe(own)
  void loadPolicy(own)
  const claude = createClaudeStatus(own)
  const status = createStatus()
  const [open, setOpen] = createSignal<Open>()
  // The old-app scan (`accounts.import.codex.list` reads the control center) runs only when an import entry is used:
  // the add dialog's type grid asks once, the import dialog lists. Visiting the page reads nothing.
  const canImport = () => own.rpc.allowed("accounts.import.codex.list")

  const accounts = () =>
    own.state.accountOrder.flatMap((id) => {
      const account = own.state.accounts[id]
      return account && account.status !== "retired" ? [account] : []
    })
  const sections = createMemo(() => pageSections(accounts().filter((account) => !OWN_SECTION.has(account.kind))))
  const agents = createMemo(() =>
    accounts().flatMap((account) => (account.kind === "claude-agent" ? [account.id] : [])),
  )
  const missing = createMemo(() => {
    const present = new Set(accounts().map((account) => account.kind))
    return KIND_ORDER.filter((kind) => kind !== "claude-sub" && !present.has(kind))
  })
  const dialogAccount = (kind: Open["kind"]) => {
    const current = open()
    if (!current || current.kind !== kind || !("accountID" in current)) return undefined
    return own.state.accounts[current.accountID]
  }
  const canAdd = () => own.rpc.allowed("accounts.add.key")

  const act = (action: CardAction, account: Account.View) => {
    status.clear()
    if (action === "compaction") {
      focusCompaction({ accountID: account.id })
      return router.navigate({ name: "settings", section: "compaction" })
    }
    if (action === "takeover" && account.connection.source)
      return setOpen({
        kind: "codex",
        target: { accountID: account.id, profileID: account.connection.source.profileID, mode: "takeover" },
      })
    if (action === "relink") return setOpen({ kind: "codex", target: { accountID: account.id } })
    if (action === "default") return void makeDefault(account)
    if (action === "autoSwitch") return void update(account, { autoSwitch: !account.autoSwitch })
    if (action === "pollBalance") return void update(account, { pollBalance: account.pollBalance === false })
    if (action === "enable") return void update(account, { enabled: true })
    if (action === "takeover") return
    setOpen({ kind: action, accountID: account.id })
  }

  const update = (account: Account.View, patch: { autoSwitch?: boolean; pollBalance?: boolean; enabled?: boolean }) =>
    own.rpc
      .call("accounts.update", { accountID: account.id, ...patch })
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))

  const makeDefault = async (account: Account.View) => {
    if (OWN_SECTION.has(account.kind)) return
    await own.rpc
      .call("policy.set", {
        patch: { defaults: { byKind: { ...policyState()?.policy.defaults.byKind, [account.kind]: account.id } } },
      })
      .then((output) => {
        updatePolicy(own, output.policy)
        status.ok(i18n.t("own.acct.defaultSet", { account: account.label, kind: kindLabel(i18n, account.kind) }))
      })
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }

  return (
    <section class="mx-auto w-full max-w-[980px] px-4 pb-12 pt-6 tablet:px-7" data-testid="page-accounts">
      <div class="mb-1 flex flex-wrap items-center gap-3">
        <h1 class="m-0 text-[20px] font-semibold leading-7">{i18n.t("own.accounts.title")}</h1>
        <div class="ml-auto flex gap-2">
          <Show when={canImport()}>
            <button
              type="button"
              class="own-btn"
              onClick={() => setOpen({ kind: "codex" })}
              data-testid="open-codex-import"
            >
              {i18n.t("own.acct.importOld")}
            </button>
          </Show>
          <Show when={canAdd()}>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              onClick={() => router.navigate({ name: "accountsAdd" })}
              data-testid="open-add-account"
            >
              + {i18n.t("own.accounts.add")}
            </button>
          </Show>
        </div>
      </div>
      <p class="m-0 mb-2 text-[13px] text-own-muted">{i18n.t("own.acct.lead")}</p>
      <Show when={!canAdd()}>
        <p class="m-0 mb-2 text-[12.5px] text-own-warn">{i18n.t("own.acct.localOnly")}</p>
      </Show>
      <StatusLine status={status} testid="accounts-status" />
      <Show
        when={own.state.status === "ready" || accounts().length}
        fallback={<p class="own-placeholder px-0">{statusLine(i18n, own.state.status)}</p>}
      >
        <Show when={!accounts().length}>
          <div class="own-acard my-4 text-center" data-testid="accounts-empty">
            <p class="m-0 mb-1 text-[15px] font-semibold">{i18n.t("own.empty.accounts")}</p>
            <p class="m-0 mb-3 text-[13px] text-own-muted">{i18n.t("own.empty.accountsBody")}</p>
            <div class="flex justify-center gap-2">
              <Show when={canAdd()}>
                <button
                  type="button"
                  class="own-btn"
                  data-variant="primary"
                  onClick={() => router.navigate({ name: "accountsAdd" })}
                >
                  {i18n.t("own.accounts.add")}
                </button>
              </Show>
              <Show when={canImport()}>
                <button type="button" class="own-btn" onClick={() => setOpen({ kind: "codex" })}>
                  {i18n.t("own.acct.importShort")}
                </button>
              </Show>
            </div>
          </div>
        </Show>
        <For each={sections()}>
          {(section) => (
            <section class="own-psec" data-kind={section.kind} data-testid="provider-section">
              <div class="own-psec-head">
                <ProviderMark kind={section.kind} />
                <h2>{kindLabel(i18n, section.kind)}</h2>
                <span class="ml-auto text-[12px] text-own-muted">
                  {i18n.t("own.acct.sectionCount", {
                    type: i18n.t(TYPE_LABEL[typeTag(own.state.accounts[section.ids[0]!]!)]),
                    n: section.ids.length,
                  })}
                </span>
              </div>
              <For each={section.ids}>{(id) => <AccountCard id={id} policy={policyState()} onAction={act} />}</For>
            </section>
          )}
        </For>
        {/* KIND_ORDER: Claude Agent, then the Claude slot, which stays last. */}
        <Show when={agents().length}>
          <Suspense>
            <ClaudeAgentSection ids={agents()} onRename={(id) => setOpen({ kind: "rename", accountID: id })} />
          </Suspense>
        </Show>
        <ClaudeSection claude={claude} onRename={(id) => setOpen({ kind: "rename", accountID: id })} />
        <Show when={missing().length && canAdd()}>
          <p
            class="m-0 mt-5 flex flex-wrap items-center gap-2 text-[12.5px] text-own-faint"
            data-testid="missing-kinds"
          >
            {missing()
              .map((kind: Kind.Any) => kindLabel(i18n, kind))
              .join(" · ")}
            <span>— {i18n.t("own.acct.noAccountYet")}</span>
            <button type="button" class="own-link" onClick={() => router.navigate({ name: "accountsAdd" })}>
              {i18n.t("own.accounts.add")}
            </button>
          </p>
        </Show>
      </Show>
      <p class="m-0 mt-6 flex items-center gap-2 text-[12px] text-own-faint">
        <Tag>{i18n.t("own.acct.vaultTag")}</Tag>
        {i18n.t("own.acct.secretsNote")}
      </p>

      <AddAccountDialog
        open={props.mode === "add"}
        kind={props.kind}
        canImport={canImport()}
        claude={claude}
        onClose={() => router.navigate({ name: "accounts" }, { replace: true })}
      />
      <CodexImportDialog
        open={open()?.kind === "codex"}
        target={(() => {
          const current = open()
          return current?.kind === "codex" ? current.target : undefined
        })()}
        onClose={() => setOpen(undefined)}
      />
      <RenameDialog account={dialogAccount("rename")} onClose={() => setOpen(undefined)} />
      <BudgetDialog account={dialogAccount("budget")} onClose={() => setOpen(undefined)} />
      <ReplaceKeyDialog account={dialogAccount("replaceKey")} onClose={() => setOpen(undefined)} />
      <RemoveDialog account={dialogAccount("remove")} onClose={() => setOpen(undefined)} />
      <CompatCapabilitiesDialog account={dialogAccount("capabilities")} onClose={() => setOpen(undefined)} />
      <Show when={dialogAccount("local")}>
        {(account) => (
          <Suspense>
            <LocalConvertDialog account={account()} onClose={() => setOpen(undefined)} />
          </Suspense>
        )}
      </Show>
      <Show when={dialogAccount("color")}>
        {(account) => <ColorDialog open account={account()} onClose={() => setOpen(undefined)} />}
      </Show>
      <Show when={dialogAccount("relogin")}>
        {(account) => (
          <Dialog
            open
            title={i18n.t("own.acct.reloginTitle", { account: account().label })}
            onClose={() => setOpen(undefined)}
          >
            <ChatGPTLogin
              accountID={account().id}
              onCancel={() => setOpen(undefined)}
              onDone={(result) => {
                setOpen(undefined)
                status.ok(i18n.t("own.acct.reauthDone", { account: result.account.label }))
              }}
            />
          </Dialog>
        )}
      </Show>
    </section>
  )
}
