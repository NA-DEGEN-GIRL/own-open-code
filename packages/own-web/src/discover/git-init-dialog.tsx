// `Git 저장소로 만들기` (03 §4.3.1, 06 §3.0), a lazy chunk. Says what happens before it happens (P3): the folder, that
// only a `.git` folder appears with `main` as the default branch and no file changes. Team mode and worktrees need a
// first save point (commit), so the dialog offers it (on by default; the user's click on the button makes it) with:
//   - the proposed .gitignore (build output, caches, logs, local secrets, OS files; its text one click away, never
//     over the folder's own .gitignore), and how many files it leaves out;
//   - what the commit would take: count and size, the biggest files;
//   - large and binary files left out unless picked one by one (a note suggests Git LFS), repositories inside never;
//   - who commits: git's own identity, or a name and email typed here when git has none (never made up).
// Everything runs on the service that owns the project (own.team `project.gitInit.plan` / `project.gitInit`). After
// it the project list and the folder's VCS info are read again, so `[팀]` and `⑂` light up, and the dialog offers
// `팀 모드 켜기…` where team mode can start.
import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { useData } from "@/data"
import { formatBytes } from "@/files/strings"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { resolveProject } from "@/projects/fs"
import { baseName } from "@/projects/path"
import { setNewSessionTarget } from "@/sidebar/target"
import { canEnableTeam, useEnableTeam } from "@/team/enable"
import "@/worktree/panel.css"
import type { GitInitRequest } from "./git-init"
import {
  canRun,
  confirmKey,
  defaults,
  failureText,
  insideParent,
  listed,
  needsIdentity,
  proposalOn,
  request as requestOf,
  summary,
  visibleFlagged,
  visibleLargest,
  type Choices,
} from "./git-init-model"
import { useGitInitText } from "./git-init-strings"

export default function GitInitDialog(props: { readonly request: GitInitRequest; readonly onClose: () => void }) {
  const text = useGitInitText()
  const i18n = useI18n()
  const data = useData()
  const router = useRouter()
  const enableTeam = useEnableTeam()
  const id = createUniqueId()
  const runtime = () => data.get(props.request.serverKey)
  const directory = props.request.directory
  const [plan, setPlan] = createSignal<OwnTeam.GitInitPlan>()
  const [planError, setPlanError] = createSignal<unknown>()
  const [choices, setChoices] = createSignal<Choices>({ commit: true, gitignore: true, include: new Set() })
  const [name, setName] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [working, setWorking] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [done, setDone] = createSignal<OwnTeam.GitInitResult>()
  const size = (bytes: number) => formatBytes(i18n.locale(), bytes)
  const parent = () => insideParent(planError())
  const files = () => {
    const current = plan()
    return current ? listed(current) : undefined
  }
  const committing = () => choices().commit && files() !== undefined
  const totals = createMemo(() => {
    const current = plan()
    return current ? summary(current, choices()) : undefined
  })

  function inspect() {
    const current = runtime()
    setPlan(undefined)
    setPlanError(undefined)
    setFailure(undefined)
    if (!current) return
    void current.team.rpc.call("project.gitInit.plan", { directory }).then(
      (answer) => {
        setPlan(answer)
        setChoices(defaults(answer))
        setName(answer.identity.name ?? "")
        setEmail(answer.identity.email ?? "")
      },
      (error: unknown) => setPlanError(error),
    )
  }

  async function run() {
    const current = runtime()
    const planned = plan()
    const identity = { name: name(), email: email() }
    if (!current || !planned || working() || !canRun(planned, choices(), identity)) return
    setWorking(true)
    setFailure(undefined)
    try {
      const result = await current.team.rpc.call("project.gitInit", requestOf(planned, choices(), identity))
      // The project (its `vcs`) and the folder's VCS info, read again: `[팀]` and `⑂` light up.
      const location = { directory }
      current.data.project.invalidate()
      current.data.location.invalidate(location)
      await Promise.all([current.data.project.sync(), current.data.location.syncInfo(location)]).catch(() => undefined)
      setDone(result)
      // Without the kept id (an older service) the folder's project changed: follow it from the old project's page.
      const route = router.route()
      if (
        result.projectID &&
        props.request.projectID &&
        result.projectID !== props.request.projectID &&
        route.name === "project" &&
        route.projectID === props.request.projectID
      )
        router.navigate({ name: "project", serverKey: props.request.serverKey, projectID: result.projectID })
    } catch (error) {
      setFailure(failureText(text, error))
    } finally {
      setWorking(false)
    }
  }

  /** Team mode can start in the folder now (its project is a Git one with a first commit). */
  const teamReady = createMemo(() => {
    const result = done()
    const current = runtime()
    if (!result?.commit || !current) return false
    return canEnableTeam(current, {
      directory,
      projectID: result.projectID ?? props.request.projectID,
      ...(props.request.sessionID ? { sessionID: props.request.sessionID } : {}),
    })
  })

  async function openParent(folder: string) {
    const current = runtime()
    if (!current) return
    const resolved = await resolveProject(current.client(), folder).catch(() => undefined)
    if (!resolved) return
    props.onClose()
    setNewSessionTarget({
      serverKey: props.request.serverKey,
      projectID: resolved.projectID,
      directory: resolved.directory,
      name: baseName(resolved.directory),
    })
    router.navigate({ name: "project", serverKey: props.request.serverKey, projectID: resolved.projectID })
  }

  function toggleInclude(path: string, on: boolean) {
    setChoices((current) => {
      const include = new Set(current.include)
      if (on) include.add(path)
      else include.delete(path)
      return { ...current, include }
    })
  }

  let cancel: HTMLButtonElement | undefined
  let dialog: HTMLDivElement | undefined
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  onMount(() => {
    cancel?.focus()
    runtime()?.team.ensure()
    inspect()
  })
  onCleanup(() => returnTo?.isConnected && returnTo.focus())
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return
    event.stopPropagation()
    if (!working()) props.onClose()
  }
  document.addEventListener("keydown", escape, true)
  onCleanup(() => document.removeEventListener("keydown", escape, true))

  function keydown(event: KeyboardEvent) {
    if (event.key !== "Tab" || !dialog) return
    const items = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), summary")]
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <Portal>
      <div class="own-wt-scrim" onClick={() => !working() && props.onClose()} />
      <div
        ref={dialog}
        class="own-wt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        data-testid="git-init"
        data-state={done() ? "done" : plan() ? "ready" : planError() ? "refused" : "loading"}
        onKeyDown={keydown}
      >
        <h2 id={`${id}-title`} class="own-wt-title">
          {text("own.gitInit.title")}
        </h2>
        <p class="own-wt-here">
          <b>{baseName(directory) || directory}</b>
          <span class="own-wt-path" data-testid="git-init-folder">
            {directory}
          </span>
        </p>
        <Show
          when={done()}
          fallback={
            <>
              <p id={`${id}-body`} class="own-wt-body" data-testid="git-init-what">
                {plan()?.state === "unborn"
                  ? text("own.gitInit.unborn")
                  : `${text("own.gitInit.what", { branch: plan()?.branch ?? "main" })} ${text("own.gitInit.why")}`}
              </p>
              <Show when={!plan() && !planError()}>
                <p class="own-wt-body" data-testid="git-init-loading">
                  {text("own.gitInit.loading")}
                </p>
              </Show>
              <Show when={planError()}>
                {(error) => (
                  <ul class="own-wt-notes">
                    <li data-tone="danger" role="alert" data-testid="git-init-refused">
                      {failureText(text, error())}
                    </li>
                  </ul>
                )}
              </Show>
              <Show when={plan()}>{(current) => <Ready plan={current()} />}</Show>
            </>
          }
        >
          {(result) => (
            <ul id={`${id}-body`} class="own-wt-notes" data-testid="git-init-done">
              <li class="text-own-text">
                {result().commit && result().committed
                  ? text("own.gitInit.doneCommit", {
                      branch: result().branch,
                      commit: result().commit!.slice(0, 7),
                      n: result().committed!.count,
                      size: size(result().committed!.bytes),
                    })
                  : text("own.gitInit.done", { branch: result().branch })}
              </li>
              <Show when={result().excluded}>
                <li>{text("own.gitInit.doneExcluded", { n: result().excluded })}</li>
              </Show>
              <li>{result().commit ? text("own.gitInit.doneNext") : text("own.gitInit.doneNoCommit")}</li>
            </ul>
          )}
        </Show>
        <Show when={failure()}>
          {(message) => (
            <ul class="own-wt-notes">
              <li data-tone="danger" role="alert" data-testid="git-init-failed">
                {message()}
              </li>
            </ul>
          )}
        </Show>
        <div class="own-wt-actions">
          <Show
            when={done()}
            fallback={
              <>
                <Show when={parent()}>
                  {(folder) => (
                    <button
                      type="button"
                      class="own-wt-btn"
                      data-testid="git-init-open-parent"
                      onClick={() => void openParent(folder())}
                    >
                      {text("own.gitInit.openParent")}
                    </button>
                  )}
                </Show>
                <Show when={planError() && !parent()}>
                  <button type="button" class="own-wt-btn" data-testid="git-init-retry" onClick={() => inspect()}>
                    {text("own.gitInit.retry")}
                  </button>
                </Show>
                <button
                  ref={cancel}
                  type="button"
                  class="own-wt-btn"
                  disabled={working()}
                  onClick={() => props.onClose()}
                >
                  {text("own.gitInit.cancel")}
                </button>
                <Show when={plan()}>
                  {(current) => (
                    <button
                      type="button"
                      class="own-wt-btn"
                      data-primary
                      data-testid="git-init-confirm"
                      disabled={working() || !canRun(current(), choices(), { name: name(), email: email() })}
                      onClick={() => void run()}
                    >
                      {working() ? text("own.gitInit.working") : text(confirmKey(current(), choices()))}
                    </button>
                  )}
                </Show>
              </>
            }
          >
            <button type="button" class="own-wt-btn" data-testid="git-init-close" onClick={() => props.onClose()}>
              {text("own.gitInit.close")}
            </button>
            <Show when={teamReady()}>
              <button
                type="button"
                class="own-wt-btn"
                data-primary
                data-testid="git-init-enable-team"
                onClick={() => {
                  props.onClose()
                  void enableTeam({
                    serverKey: props.request.serverKey,
                    directory,
                    ...(props.request.sessionID ? { sessionID: props.request.sessionID } : {}),
                  })
                }}
              >
                {text("own.gitInit.enableTeam")}
              </button>
            </Show>
          </Show>
        </div>
      </div>
    </Portal>
  )

  function Ready(inner: { readonly plan: OwnTeam.GitInitPlan }) {
    const planned = inner.plan
    return (
      <>
        <Show when={planned.state === "none"}>
          <label class="own-wt-inline" data-testid="git-init-commit">
            <input
              type="checkbox"
              checked={committing()}
              disabled={working() || !listed(planned)}
              onChange={(event) => setChoices((current) => ({ ...current, commit: event.currentTarget.checked }))}
            />
            <b>{text("own.gitInit.commit")}</b>
          </label>
        </Show>
        <Show
          when={listed(planned)}
          fallback={
            <ul class="own-wt-notes">
              <li data-tone="warn" data-testid="git-init-too-many">
                {planned.files.kind === "too_many"
                  ? text("own.gitInit.tooMany", { n: planned.files.count, limit: planned.files.limit })
                  : ""}
              </li>
            </ul>
          }
        >
          {(listing) => (
            <Show
              when={committing()}
              fallback={
                <p class="own-wt-body" data-testid="git-init-commit-off">
                  {text("own.gitInit.commitOff")}
                </p>
              }
            >
              <p class="own-wt-body">{text("own.gitInit.commitAbout")}</p>
              <ul class="own-wt-notes">
                <Show
                  when={!planned.gitignore.exists}
                  fallback={<li data-testid="git-init-gitignore-exists">{text("own.gitInit.gitignoreExists")}</li>}
                >
                  <li>
                    <label class="own-wt-inline" data-testid="git-init-gitignore">
                      <input
                        type="checkbox"
                        checked={proposalOn(planned, choices())}
                        disabled={working() || listing().proposalRequired}
                        onChange={(event) =>
                          setChoices((current) => ({ ...current, gitignore: event.currentTarget.checked }))
                        }
                      />
                      {text("own.gitInit.gitignore")}
                    </label>
                    <Show when={listing().proposal.count}>
                      <div data-testid="git-init-gitignore-leaves">
                        {listing().proposalRequired
                          ? `${text("own.gitInit.gitignoreLeavesCount", { n: listing().proposal.count })} ${text("own.gitInit.gitignoreRequired")}`
                          : text("own.gitInit.gitignoreLeaves", {
                              n: listing().proposal.count,
                              size: size(listing().proposal.bytes),
                            })}
                      </div>
                    </Show>
                    <details>
                      <summary class="cursor-pointer">{text("own.gitInit.gitignoreShow")}</summary>
                      <pre
                        class="own-wt-mono m-0 mt-1 max-h-40 overflow-auto p-2 text-[11.5px]"
                        data-testid="git-init-proposal"
                      >
                        {planned.gitignore.proposal}
                      </pre>
                    </details>
                  </li>
                </Show>
                <Show when={totals()}>
                  {(total) => (
                    <li class="text-own-text" data-testid="git-init-summary">
                      {text("own.gitInit.summary", { n: total().count, size: size(total().bytes) })}
                    </li>
                  )}
                </Show>
                <Show when={listing().nested.length}>
                  <li data-tone="warn" data-testid="git-init-nested">
                    {text("own.gitInit.nested", { n: listing().nested.length, paths: listing().nested.join(", ") })}
                  </li>
                </Show>
              </ul>
              <Show when={visibleLargest(planned, choices()).length}>
                <p class="own-wt-legend m-0">{text("own.gitInit.largest")}</p>
                <ul class="own-wt-guard-list" data-testid="git-init-largest">
                  <For each={visibleLargest(planned, choices())}>
                    {(item) => (
                      <li class="own-wt-guard-row" title={item.path}>
                        <span class="own-wt-guard-path">{item.path}</span>
                        <span class="own-wt-guard-meta">{size(item.bytes)}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={visibleFlagged(planned, choices()).length}>
                <ul class="own-wt-notes">
                  <li data-tone="warn" data-testid="git-init-flagged-note">
                    <b>{text("own.gitInit.flagged", { n: visibleFlagged(planned, choices()).length })}</b>{" "}
                    {text("own.gitInit.flaggedAbout")}
                  </li>
                </ul>
                <ul class="own-wt-guard-list" data-testid="git-init-flagged">
                  <For each={visibleFlagged(planned, choices())}>
                    {(item) => (
                      <li class="own-wt-guard-row" title={item.path}>
                        <label class="own-wt-inline m-0 min-w-0 flex-1" data-testid="git-init-flagged-item">
                          <input
                            type="checkbox"
                            checked={choices().include.has(item.path)}
                            disabled={working()}
                            onChange={(event) => toggleInclude(item.path, event.currentTarget.checked)}
                          />
                          <span class="own-wt-guard-path">{item.path}</span>
                        </label>
                        <span class="own-wt-guard-meta">
                          {item.binary ? text("own.gitInit.binary") : text("own.gitInit.large")} · {size(item.bytes)}
                        </span>
                      </li>
                    )}
                  </For>
                  <Show when={listing().flaggedMore}>
                    <li class="own-wt-guard-row own-wt-guard-more">
                      {text("own.gitInit.flaggedMore", { n: listing().flaggedMore })}
                    </li>
                  </Show>
                </ul>
              </Show>
              <Show
                when={needsIdentity(planned)}
                fallback={
                  <p class="own-wt-body" data-testid="git-init-author">
                    {text("own.gitInit.identityUses", {
                      name: planned.identity.name ?? "",
                      email: planned.identity.email ?? "",
                    })}
                  </p>
                }
              >
                <fieldset class="own-wt-field" data-testid="git-init-identity">
                  <legend class="own-wt-legend">{text("own.gitInit.identity")}</legend>
                  <p class="own-wt-body m-0">{text("own.gitInit.identityAbout")}</p>
                  <input
                    class="own-wt-input"
                    aria-label={text("own.gitInit.identityName")}
                    placeholder={text("own.gitInit.identityName")}
                    value={name()}
                    disabled={working()}
                    data-testid="git-init-name"
                    onInput={(event) => setName(event.currentTarget.value)}
                  />
                  <input
                    class="own-wt-input"
                    type="email"
                    aria-label={text("own.gitInit.identityEmail")}
                    placeholder={text("own.gitInit.identityEmail")}
                    value={email()}
                    disabled={working()}
                    data-testid="git-init-email"
                    onInput={(event) => setEmail(event.currentTarget.value)}
                  />
                </fieldset>
              </Show>
            </Show>
          )}
        </Show>
      </>
    )
  }
}
