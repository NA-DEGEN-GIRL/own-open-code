// Git write actions of the review tab (03 §19.2, [gap] 18; 01 §17.1 #18), part of the review tab's lazy chunk:
//
//   Git bar (`커밋 안 된 변경` and `브랜치 대 base`):  ⑂ feature ↑1 · 스테이징됨 2   [모두 스테이징] [커밋…] [푸시] [PR 만들기]
//   Active file (`커밋 안 된 변경`):  src/a.ts · 일부 스테이징됨   [스테이징] [스테이징 취소] [파일 되돌리기] [변경 덩어리 되돌리기…]
//
// Every action is a fixed command (commands.ts) that runs through `shell.create` only after the confirmation dock
// (the permission dock's frame, session-ui `./dock-prompt`) showed the exact command line, the folder and what it
// changes (03 §19 "확인 단계에서 무엇이 바뀌는지 적는다", P3). It does not depend on the approval mode: the user asked
// for it. Enter runs, Esc cancels; the commit message box sends with Ctrl/⌘+Enter (never while composing, 03 §12).
// Results stay in the dock: done (the PR link), or the exit code and the command's last output lines.
import type { FileDiffInfo } from "@opencode/client"
import "./git.css"
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { DockPrompt } from "@/adapter/dock-prompt"
import type { ServerKey, ServerRuntime } from "@/data"
import { nextFrame } from "@/data/frame"
import { useHost } from "@/host"
import { commitComposition, isEnter, isImeKey } from "@/ime/ime-enter"
import { isMac } from "@/keyboard"
import { notifyGitChanged } from "@/review/vcs-status"
import {
  applyReverse,
  canRevertHunks,
  commit,
  hasUnstaged,
  hunkPatch,
  isStaged,
  pullRequestUrl,
  push,
  PR_COMMAND,
  revert,
  splitHunks,
  stage,
  STAGE_ALL,
  tail,
  unstage,
  UnsupportedPathError,
  type CommandPlan,
  type FileState,
  type GitStatus,
  type Hunk,
  type ShellKind,
  type TempWrite,
} from "./commands"
import { runCommand, serverTmp, succeeded, tempPath, writeTemps, type RunResult } from "./runner"
import type { GitState } from "./state"
import { useGitText, type GitKey } from "./strings"

const WRITE_TIMEOUT_MS = 60_000
const NETWORK_TIMEOUT_MS = 180_000

type PlanKind = "stage" | "unstage" | "revert" | "stageAll" | "commit" | "push" | "pr" | "hunk"

interface Plan {
  readonly kind: PlanKind
  readonly title: GitKey
  readonly effect: string
  readonly commands: readonly string[]
  readonly writes: readonly TempWrite[]
  readonly files?: readonly string[]
  readonly patch?: string
  /** Commit: the message file the command reads, written from the message box when it runs. */
  readonly messageFile?: string
  readonly destructive?: boolean
  readonly timeoutMs: number
}

type Dock =
  | { readonly phase: "preparing"; readonly title: GitKey }
  | { readonly phase: "confirm" | "running"; readonly plan: Plan }
  | { readonly phase: "done"; readonly plan: Plan; readonly output: string; readonly url?: string }
  | {
      readonly phase: "failed"
      readonly title: GitKey
      readonly plan?: Plan
      readonly message: string
      readonly output?: string
    }
  | {
      readonly phase: "hunks"
      readonly file: string
      readonly loading: boolean
      readonly head?: readonly string[]
      readonly hunks?: readonly Hunk[]
      readonly note?: GitKey
    }

interface BuildContext {
  readonly kind: ShellKind
  readonly tmp: string
  readonly status: GitStatus
}

export function createGitActions(input: {
  readonly runtime: () => ServerRuntime | undefined
  readonly serverKey: () => ServerKey
  readonly directory: () => string | undefined
  readonly state: GitState
  /** The file's working-copy patch with 3 context lines (the review controller's bounded diff). */
  readonly loadPatch: (file: string) => Promise<FileDiffInfo | undefined>
  /** After any command ran: the review list refreshes. */
  readonly onChanged: () => void
}) {
  const text = useGitText()
  const [store, setStore] = createStore({ dock: undefined as Dock | undefined })
  const run = { token: 0 }

  const busy = () => store.dock?.phase === "preparing" || store.dock?.phase === "running"

  async function prepare(title: GitKey, build: (context: BuildContext) => Plan | undefined) {
    const runtime = input.runtime()
    const status = input.state.status()
    const kind = input.state.shell()
    if (!runtime || !status || !kind || busy()) return
    const token = ++run.token
    setStore("dock", { phase: "preparing", title })
    const tmp = await serverTmp(runtime).catch((error: unknown) => error)
    if (token !== run.token) return
    if (typeof tmp !== "string") return fail(title, text("own.git.writeFailed", { message: describe(tmp) }))
    const plan = attempt(() => build({ kind, tmp, status }))
    if (plan instanceof UnsupportedPathError)
      return fail(title, text("own.git.unsupported", { shell: kind, path: plan.message }))
    if (plan instanceof Error) return fail(title, plan.message)
    if (!plan) return setStore("dock", undefined)
    setStore("dock", { phase: "confirm", plan })
  }

  function fail(title: GitKey, message: string, plan?: Plan, output?: string) {
    setStore("dock", { phase: "failed", title, plan, message, output })
  }

  const describeFiles = (files: readonly string[]) =>
    files.length === 1 ? files[0]! : `${files[0]} +${files.length - 1}`

  function fromCommandPlan(
    kind: PlanKind,
    title: GitKey,
    effect: string,
    plan: CommandPlan,
    extra?: Partial<Plan>,
  ): Plan {
    return { kind, title, effect, commands: plan.commands, writes: plan.writes, timeoutMs: WRITE_TIMEOUT_MS, ...extra }
  }

  return {
    dock: () => store.dock,
    busy,
    close() {
      if (busy()) return
      run.token++
      setStore("dock", undefined)
    },
    /** A failed action back to its confirmation (the same command line, the commit message kept). */
    retry() {
      const dock = store.dock
      if (dock?.phase === "failed" && dock.plan) setStore("dock", { phase: "confirm", plan: dock.plan })
    },

    stage(files: readonly string[]) {
      void prepare("own.git.title.stage", (context) =>
        fromCommandPlan(
          "stage",
          "own.git.title.stage",
          text("own.git.effect.stage", { file: describeFiles(files) }),
          stage(context.kind, files, () => tempPath(context.tmp, "pathspec.txt")),
          { files },
        ),
      )
    },

    unstage(files: readonly string[]) {
      void prepare("own.git.title.unstage", (context) =>
        fromCommandPlan(
          "unstage",
          "own.git.title.unstage",
          text("own.git.effect.unstage", { file: describeFiles(files) }),
          unstage(context.kind, files, context.status.initial, () => tempPath(context.tmp, "pathspec.txt")),
          { files },
        ),
      )
    },

    revert(files: readonly string[]) {
      void prepare("own.git.title.revert", (context) => {
        const untracked = files.filter((file) => context.status.files.get(file)?.untracked)
        const tracked = files.filter((file) => !context.status.files.get(file)?.untracked)
        // A staged new file (index `A`) is removed too: restoring it to HEAD, where it does not exist, deletes it.
        const added = tracked.filter((file) => context.status.files.get(file)?.index === "A")
        const effect =
          untracked.length === files.length
            ? text("own.git.effect.revertUntracked", { file: describeFiles(files) })
            : untracked.length + added.length === files.length
              ? text("own.git.effect.revertAdded", { file: describeFiles(files) })
              : text("own.git.effect.revert", { file: describeFiles(files) })
        return fromCommandPlan(
          "revert",
          "own.git.title.revert",
          effect,
          revert(context.kind, { tracked, untracked, initial: context.status.initial }, (name) =>
            tempPath(context.tmp, `pathspec-${name}.txt`),
          ),
          { files, destructive: true },
        )
      })
    },

    stageAll() {
      void prepare("own.git.title.stageAll", () =>
        fromCommandPlan("stageAll", "own.git.title.stageAll", text("own.git.effect.stageAll"), {
          commands: [STAGE_ALL],
          writes: [],
        }),
      )
    },

    commit() {
      void prepare("own.git.title.commit", (context) => {
        const messageFile = tempPath(context.tmp, "commit-message.txt")
        const staged = [...context.status.files.values()].filter(isStaged).length
        return fromCommandPlan(
          "commit",
          "own.git.title.commit",
          text("own.git.effect.commit", { n: staged, branch: context.status.head ?? "HEAD" }),
          commit(context.kind, messageFile),
          { messageFile },
        )
      })
    },

    push() {
      void prepare("own.git.title.push", (context) => {
        const branch = context.status.head ?? "HEAD"
        return fromCommandPlan(
          "push",
          "own.git.title.push",
          context.status.upstream
            ? text("own.git.effect.push", { branch, upstream: context.status.upstream })
            : text("own.git.effect.pushNew", { branch }),
          { commands: [push(context.status.upstream !== undefined)], writes: [] },
          { timeoutMs: NETWORK_TIMEOUT_MS },
        )
      })
    },

    pr() {
      void prepare("own.git.title.pr", (context) =>
        fromCommandPlan(
          "pr",
          "own.git.title.pr",
          text("own.git.effect.pr", { branch: context.status.head ?? "HEAD" }),
          { commands: [PR_COMMAND], writes: [] },
          { timeoutMs: NETWORK_TIMEOUT_MS },
        ),
      )
    },

    /** `변경 덩어리 되돌리기…`: the file's hunks to choose from. */
    hunks(file: string) {
      if (busy()) return
      const token = ++run.token
      setStore("dock", { phase: "hunks", file, loading: true })
      void input
        .loadPatch(file)
        .catch(() => undefined)
        .then((diff) => {
          if (token !== run.token) return
          const parts = diff ? splitHunks(diff.patch) : undefined
          if (!parts || parts.hunks.length === 0)
            return setStore("dock", { phase: "hunks", file, loading: false, note: "own.git.hunksNone" })
          if (!canRevertHunks(parts.head) || diff?.status !== "modified")
            return setStore("dock", { phase: "hunks", file, loading: false, note: "own.git.hunksUnsupported" })
          setStore("dock", { phase: "hunks", file, loading: false, head: parts.head, hunks: parts.hunks })
        })
    },

    revertHunk(file: string, head: readonly string[], hunk: Hunk) {
      void prepare("own.git.title.hunk", (context) => {
        const patchFile = tempPath(context.tmp, "hunk.patch")
        const patch = hunkPatch(head, hunk)
        return {
          kind: "hunk",
          title: "own.git.title.hunk",
          effect: text("own.git.effect.hunk", { file }),
          commands: [applyReverse(context.kind, patchFile)],
          writes: [{ path: patchFile, content: patch }],
          patch: [hunk.header, ...hunk.lines].join("\n"),
          destructive: true,
          timeoutMs: WRITE_TIMEOUT_MS,
        }
      })
    },

    /** Runs the confirmed plan (the commit message comes from the message box). */
    async run(message?: string) {
      const dock = store.dock
      const runtime = input.runtime()
      const directory = input.directory()
      if (dock?.phase !== "confirm" || !runtime || !directory) return
      const plan = dock.plan
      if (plan.kind === "commit" && !message?.trim()) return
      const token = ++run.token
      setStore("dock", { phase: "running", plan })
      const writes = [
        ...plan.writes,
        ...(plan.messageFile && message ? [{ path: plan.messageFile, content: message.replace(/\r\n/g, "\n") }] : []),
      ]
      const written = await writeTemps(runtime, directory, writes).then(
        () => undefined,
        (error: unknown) => error,
      )
      if (token !== run.token) return
      if (written !== undefined)
        return fail(plan.title, text("own.git.writeFailed", { message: describe(written) }), plan)
      const results: RunResult[] = []
      for (const command of plan.commands) {
        const result = await runCommand(runtime, {
          directory,
          command,
          timeoutMs: plan.timeoutMs,
          label: plan.kind,
        }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
        if (token !== run.token) return
        if (result instanceof Error) {
          finished(runtime, directory)
          return fail(plan.title, text("own.git.startFailed", { message: result.message }), plan)
        }
        results.push(result)
        if (!succeeded(result)) {
          finished(runtime, directory)
          return fail(plan.title, failure(result), plan, tail(result.output))
        }
      }
      finished(runtime, directory)
      const output = results
        .map((result) => result.output.trim())
        .filter(Boolean)
        .join("\n")
      setStore("dock", {
        phase: "done",
        plan,
        output: tail(output, 12),
        url: plan.kind === "pr" ? pullRequestUrl(output) : undefined,
      })
    },
  }

  function failure(result: RunResult) {
    if (result.status === "timeout") return text("own.git.timeout")
    if (result.status === "killed") return text("own.git.killed")
    return text("own.git.failed", { code: result.exit ?? "?" })
  }

  function finished(runtime: ServerRuntime, directory: string) {
    input.state.refresh()
    input.onChanged()
    notifyGitChanged(runtime.key, directory)
  }
}

export type GitActions = ReturnType<typeof createGitActions>

function planOf(dock: Dock | undefined) {
  return dock && "plan" in dock ? dock.plan : undefined
}

function attempt<T>(build: () => T): T | Error {
  try {
    return build()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------------------------------------------
// Views

/** Repository line of the tab: branch, upstream distance, staged count and the repository-wide actions. */
export function GitBar(props: { readonly git: GitActions; readonly state: GitState }) {
  const text = useGitText()
  const status = () => props.state.status()
  const staged = createMemo(() => [...(status()?.files.values() ?? [])].filter(isStaged).length)
  const unstaged = createMemo(() => [...(status()?.files.values() ?? [])].some(hasUnstaged))
  const disabled = () => props.git.busy() || !status()
  return (
    <div class="own-git-bar" role="group" aria-label={text("own.git.bar")} data-testid="git-bar">
      <Show
        when={status()}
        fallback={
          <span class="own-git-note" data-testid="git-reading">
            {props.state.error()
              ? text("own.git.readFailed", { message: props.state.error()! })
              : text("own.git.reading")}
          </span>
        }
      >
        {(current) => (
          <span class="own-git-branch" data-testid="git-branch">
            <span aria-hidden="true">⑂</span>
            <span class="own-git-branch-name">{current().head ?? text("own.git.detached")}</span>
            <Show when={current().ahead > 0}>
              <span class="own-git-ab" title={text("own.git.ahead", { n: current().ahead })}>
                <span aria-hidden="true">↑{current().ahead}</span>
                <span class="own-sr-only">{text("own.git.ahead", { n: current().ahead })}</span>
              </span>
            </Show>
            <Show when={current().behind > 0}>
              <span class="own-git-ab" title={text("own.git.behind", { n: current().behind })}>
                <span aria-hidden="true">↓{current().behind}</span>
                <span class="own-sr-only">{text("own.git.behind", { n: current().behind })}</span>
              </span>
            </Show>
            <Show when={staged() > 0}>
              <span class="own-git-staged" data-testid="git-staged-count">
                · {text("own.git.stagedCount", { n: staged() })}
              </span>
            </Show>
          </span>
        )}
      </Show>
      <span class="own-git-grow" />
      <Show when={unstaged()}>
        <button
          type="button"
          class="own-git-btn"
          data-testid="git-stage-all"
          disabled={disabled()}
          onClick={() => props.git.stageAll()}
        >
          {text("own.git.stageAll")}
        </button>
      </Show>
      <button
        type="button"
        class="own-git-btn"
        data-testid="git-commit"
        disabled={disabled() || staged() === 0}
        title={staged() === 0 ? text("own.git.commitDisabled") : undefined}
        onClick={() => props.git.commit()}
      >
        {text("own.git.commit")}
      </button>
      <button
        type="button"
        class="own-git-btn"
        data-testid="git-push"
        disabled={disabled() || !status()?.head || status()?.initial}
        title={!status()?.head || status()?.initial ? text("own.git.pushDisabled") : undefined}
        onClick={() => props.git.push()}
      >
        {text("own.git.push")}
      </button>
      <Show when={props.state.gh()}>
        <button
          type="button"
          class="own-git-btn"
          data-testid="git-pr"
          disabled={disabled() || !status()?.head || status()?.initial}
          onClick={() => props.git.pr()}
        >
          {text("own.git.pr")}
        </button>
      </Show>
    </div>
  )
}

/** The active file's state and actions (`커밋 안 된 변경`). */
export function GitFileActions(props: {
  readonly git: GitActions
  readonly state: GitState
  readonly file: string
  readonly diff: FileDiffInfo | undefined
}) {
  const text = useGitText()
  const entry = (): FileState | undefined => props.state.status()?.files.get(props.file)
  const label = () => {
    const current = entry()
    if (!current) return text("own.git.state.clean")
    if (current.conflicted) return text("own.git.state.conflicted")
    if (current.untracked) return text("own.git.state.untracked")
    if (isStaged(current) && hasUnstaged(current)) return text("own.git.state.partial")
    if (isStaged(current)) return text("own.git.state.staged")
    return text("own.git.state.unstaged")
  }
  const disabled = () => props.git.busy() || !props.state.status()
  return (
    <div
      class="own-git-file"
      role="group"
      aria-label={text("own.git.fileActions", { file: props.file })}
      data-testid="git-file-actions"
    >
      <span class="own-git-file-state" data-testid="git-file-state" data-staged={isStaged(entry()) ? "" : undefined}>
        {label()}
      </span>
      <span class="own-git-grow" />
      <Show when={hasUnstaged(entry())}>
        <button
          type="button"
          class="own-git-btn"
          data-testid="git-stage"
          disabled={disabled()}
          onClick={() => props.git.stage([props.file])}
        >
          {text("own.git.stage")}
        </button>
      </Show>
      <Show when={isStaged(entry())}>
        <button
          type="button"
          class="own-git-btn"
          data-testid="git-unstage"
          disabled={disabled()}
          onClick={() => props.git.unstage([props.file])}
        >
          {text("own.git.unstage")}
        </button>
      </Show>
      <Show when={entry()}>
        <button
          type="button"
          class="own-git-btn"
          data-variant="danger"
          data-testid="git-revert"
          disabled={disabled()}
          onClick={() => props.git.revert([props.file])}
        >
          {text("own.git.revertFile")}
        </button>
      </Show>
      <Show when={props.diff?.status === "modified" && entry() && !entry()!.untracked}>
        <button
          type="button"
          class="own-git-btn"
          data-testid="git-hunks"
          disabled={disabled()}
          onClick={() => props.git.hunks(props.file)}
        >
          {text("own.git.revertHunks")}
        </button>
      </Show>
    </div>
  )
}

let seq = 0

/** The confirmation / progress / result dock of the current Git action. */
export function GitDock(props: { readonly git: GitActions; readonly directory: string | undefined }) {
  const text = useGitText()
  const host = useHost()
  const id = `own-git-title-${++seq}`
  const [composing, setComposing] = createSignal(false)
  const [message, setMessage] = createSignal("")
  const element = {
    root: undefined as HTMLDivElement | undefined,
    message: undefined as HTMLTextAreaElement | undefined,
  }
  const modEnter = isMac ? "⌘+Enter" : "Ctrl+Enter"

  const title = (): GitKey => {
    const dock = props.git.dock()
    if (!dock) return "own.git.dock"
    if (dock.phase === "preparing" || dock.phase === "failed") return dock.title
    if (dock.phase === "hunks") return "own.git.title.hunks"
    return dock.plan.title
  }

  const focusDock = (element?: HTMLElement) => nextFrame(() => element?.focus())
  // Each new step (hunk list → confirmation, running → result) takes the focus back into the dock when the control
  // that led there went away with the previous step, so Enter and Esc keep working from the keyboard.
  createEffect(
    on(
      () => props.git.dock()?.phase,
      (phase) => {
        // A commit that went through leaves an empty box for the next one; a failed one keeps its message for 다시 시도.
        if (phase === "done") setMessage("")
        if (!phase || phase === "preparing") return
        nextFrame(() => {
          const root = element.root
          if (!root?.isConnected || root.contains(document.activeElement)) return
          if (phase === "confirm" && planOf(props.git.dock())?.kind === "commit") return element.message?.focus()
          root.focus()
        })
      },
      { defer: true },
    ),
  )

  async function confirm() {
    const dock = props.git.dock()
    if (dock?.phase !== "confirm") return
    if (dock.plan.kind === "commit") {
      const box = element.message
      if (!box) return
      await commitComposition(box, composing())
      if (!box.value.trim()) return box.focus()
      return void props.git.run(box.value)
    }
    void props.git.run()
  }

  function cancel() {
    props.git.close()
    setMessage("")
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isImeKey(event, composing())) return
    const target = event.target
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return cancel()
    }
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return
    if (isEnter(event) && !event.shiftKey && !event.altKey && target === event.currentTarget) {
      event.preventDefault()
      void confirm()
    }
  }

  const messageKeydown = (event: KeyboardEvent) => {
    if (isImeKey(event, composing())) return
    if (isEnter(event) && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      void confirm()
    }
  }

  return (
    <Show when={props.git.dock()}>
      {(dock) => (
        <div class="own-git-dock" data-testid="git-dock" data-phase={dock().phase}>
          <DockPrompt
            kind="permission"
            ref={(root) => {
              element.root = root
              root.tabIndex = -1
              root.setAttribute("role", "group")
              root.setAttribute("aria-labelledby", id)
              root.setAttribute("aria-keyshortcuts", "Enter Escape")
              focusDock(root)
            }}
            onKeyDown={keydown}
            header={
              <div class="own-git-dock-head">
                <span class="own-git-dock-icon" aria-hidden="true">
                  ⑂
                </span>
                <span id={id} class="own-git-dock-title" data-testid="git-dock-title">
                  {text(title())}
                </span>
              </div>
            }
            footer={<DockFooter />}
          >
            <Switch>
              <Match when={dock().phase === "preparing"}>
                <p class="own-git-note" role="status">
                  {text("own.git.preparing")}
                </p>
              </Match>
              <Match when={dock().phase === "hunks" && (dock() as Extract<Dock, { phase: "hunks" }>)}>
                {(hunks) => <HunkList dock={hunks()} git={props.git} />}
              </Match>
              <Match when={planOf(dock())}>
                {(plan) => (
                  <PlanView
                    plan={plan()}
                    directory={props.directory}
                    commit={dock().phase === "confirm" && plan().kind === "commit"}
                    running={dock().phase === "running"}
                    message={message()}
                    onMessage={setMessage}
                    messageRef={(box) => {
                      element.message = box
                      focusDock(box)
                    }}
                    onKeyDown={messageKeydown}
                    onComposition={setComposing}
                    hint={text("own.git.messageHint", { key: modEnter })}
                  />
                )}
              </Match>
            </Switch>
            <Switch>
              <Match when={dock().phase === "running"}>
                <p class="own-git-note" role="status" data-testid="git-running">
                  {text("own.git.running")}
                </p>
              </Match>
              <Match when={dock().phase === "done" && (dock() as Extract<Dock, { phase: "done" }>)}>
                {(done) => (
                  <div class="own-git-result" role="status" data-testid="git-done">
                    <p class="own-git-ok">{text("own.git.done")}</p>
                    <Show when={done().url}>
                      {(url) => (
                        <button
                          type="button"
                          class="own-git-link"
                          data-testid="git-pr-link"
                          onClick={() => host.openExternal(url())}
                        >
                          {text("own.git.prOpen")} · {url()}
                        </button>
                      )}
                    </Show>
                    <Show when={done().output}>
                      <pre class="own-git-output" aria-label={text("own.git.output")}>
                        {done().output}
                      </pre>
                    </Show>
                  </div>
                )}
              </Match>
              <Match when={dock().phase === "failed" && (dock() as Extract<Dock, { phase: "failed" }>)}>
                {(failed) => (
                  <div class="own-git-result" role="alert" data-testid="git-failed">
                    <p class="own-git-error">{failed().message}</p>
                    <Show when={failed().output}>
                      <pre class="own-git-output" aria-label={text("own.git.output")} data-testid="git-output">
                        {failed().output}
                      </pre>
                    </Show>
                  </div>
                )}
              </Match>
            </Switch>
          </DockPrompt>
        </div>
      )}
    </Show>
  )

  function DockFooter() {
    const phase = () => props.git.dock()?.phase
    const plan = () => planOf(props.git.dock())
    return (
      <div class="own-git-actions">
        <Switch>
          <Match when={phase() === "confirm"}>
            <button type="button" class="own-git-btn" data-variant="ghost" data-testid="git-cancel" onClick={cancel}>
              {text("own.git.cancel")} <kbd>Esc</kbd>
            </button>
            <button
              type="button"
              class="own-git-btn"
              data-variant={plan()?.destructive ? "danger" : "primary"}
              data-testid="git-run"
              disabled={plan()?.kind === "commit" && !message().trim()}
              onClick={() => void confirm()}
            >
              {plan()?.kind === "commit" ? text("own.git.title.commit") : text("own.git.run")}{" "}
              <kbd>{plan()?.kind === "commit" ? modEnter : "Enter"}</kbd>
            </button>
          </Match>
          <Match when={phase() === "preparing" || phase() === "running"}>
            <button type="button" class="own-git-btn" data-variant="ghost" disabled>
              {text("own.git.cancel")}
            </button>
          </Match>
          <Match when={phase() === "failed" && plan()}>
            <button type="button" class="own-git-btn" data-variant="ghost" data-testid="git-close" onClick={cancel}>
              {text("own.git.close")}
            </button>
            <button type="button" class="own-git-btn" data-testid="git-retry" onClick={() => props.git.retry()}>
              {text("own.git.retry")}
            </button>
          </Match>
          <Match when={true}>
            <button type="button" class="own-git-btn" data-testid="git-close" onClick={cancel}>
              {text("own.git.close")}
            </button>
          </Match>
        </Switch>
      </div>
    )
  }
}

function PlanView(props: {
  readonly plan: Plan
  readonly directory: string | undefined
  readonly commit: boolean
  readonly running: boolean
  readonly message: string
  readonly onMessage: (value: string) => void
  readonly messageRef: (element: HTMLTextAreaElement) => void
  readonly onKeyDown: (event: KeyboardEvent) => void
  readonly onComposition: (composing: boolean) => void
  readonly hint: string
}) {
  const text = useGitText()
  const messageID = `own-git-message-${++seq}`
  return (
    <div class="own-git-plan" data-testid="git-plan">
      <p class="own-git-effect" data-testid="git-effect" data-destructive={props.plan.destructive ? "" : undefined}>
        {props.plan.effect}
      </p>
      <Show when={props.commit}>
        <label class="own-git-label" for={messageID}>
          {text("own.git.message")}
        </label>
        {/* Uncontrolled: the value is read when it runs, so nothing rewrites the box while composing (03 §12). */}
        <textarea
          ref={props.messageRef}
          id={messageID}
          value={untrack(() => props.message)}
          class="own-git-message"
          data-testid="git-message"
          rows={3}
          placeholder={text("own.git.messagePlaceholder")}
          spellcheck={false}
          onInput={(event) => props.onMessage(event.currentTarget.value)}
          onKeyDown={props.onKeyDown}
          onCompositionStart={() => props.onComposition(true)}
          onCompositionEnd={() => props.onComposition(false)}
        />
        <p class="own-git-hint">{props.hint}</p>
      </Show>
      <Show when={props.plan.patch}>
        <p class="own-git-label">{text("own.git.patch")}</p>
        <pre class="own-git-output own-git-patch" data-testid="git-patch">
          {props.plan.patch}
        </pre>
      </Show>
      <p class="own-git-label">{props.plan.commands.length > 1 ? text("own.git.commands") : text("own.git.command")}</p>
      <For each={props.plan.commands}>
        {(command) => (
          <code class="own-git-command" data-testid="git-command">
            {command}
          </code>
        )}
      </For>
      <Show when={props.plan.messageFile}>
        {(file) => <p class="own-git-hint">{text("own.git.messageFile", { path: file() })}</p>}
      </Show>
      <Show when={props.directory}>
        {(directory) => <p class="own-git-hint">{text("own.git.folder", { directory: directory() })}</p>}
      </Show>
    </div>
  )
}

function HunkList(props: { readonly dock: Extract<Dock, { phase: "hunks" }>; readonly git: GitActions }) {
  const text = useGitText()
  return (
    <div class="own-git-hunks" data-testid="git-hunks-list">
      <Switch>
        <Match when={props.dock.loading}>
          <p class="own-git-note" role="status">
            {text("own.git.hunksLoading")}
          </p>
        </Match>
        <Match when={props.dock.note}>{(note) => <p class="own-git-note">{text(note())}</p>}</Match>
        <Match when={props.dock.hunks}>
          {(hunks) => (
            <ul class="own-git-hunk-list">
              <For each={hunks()}>
                {(hunk) => (
                  <li class="own-git-hunk" data-testid="git-hunk">
                    <div class="own-git-hunk-head">
                      <code
                        class="own-git-hunk-header"
                        aria-label={text("own.git.hunkLabel", {
                          header: hunk.header,
                          added: hunk.additions,
                          deleted: hunk.deletions,
                        })}
                      >
                        {hunk.header.replace(/^(@@[^@]*@@).*$/, "$1")}
                      </code>
                      <span class="own-git-hunk-stats" aria-hidden="true">
                        <span class="own-git-add">+{hunk.additions}</span>
                        <span class="own-git-del">−{hunk.deletions}</span>
                      </span>
                      <button
                        type="button"
                        class="own-git-btn"
                        data-variant="danger"
                        data-testid="git-hunk-revert"
                        onClick={() => props.git.revertHunk(props.dock.file, props.dock.head ?? [], hunk)}
                      >
                        {text("own.git.hunkRevert")}
                      </button>
                    </div>
                    <pre class="own-git-output own-git-patch">
                      {hunk.lines
                        .filter((line) => line.startsWith("+") || line.startsWith("-"))
                        .slice(0, 6)
                        .join("\n")}
                    </pre>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Match>
      </Switch>
    </div>
  )
}
