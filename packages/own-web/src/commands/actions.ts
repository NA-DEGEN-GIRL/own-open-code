// What the client commands do (03 §18.13). Each action is replaceable: the composer (integrator) passes the revert
// module's `undo`/`redo`, the context meter's compaction, etc. when those land; the defaults below call the server
// directly and are complete on their own.
//
// Switching rules (01 §17.1, 02 §5): `/model` only opens the "모델 @ 계정" switcher (estimate → dialog → router
// `switch.apply`); nothing here calls `switchModel`. `/agent` changes the agent only (`POST /session/:id/agent`,
// no model or account change; own.accounts has no agent method) and says the next request may be cold. `/undo`
// stages a revert, which the router treats as a cold point (R7).
import { newChatHost } from "@/servers/active"
import type { ServerKey, ServerRuntime } from "@/data"
import { useHost, type OwnHost } from "@/host"
import { useI18n, type I18nKey, type I18nParams, type Locale } from "@/i18n"
import { useRouter } from "@/routing/router"
import type { Route } from "@/routing/routes"
import { useShell } from "@/shell/context"
import { openSwitcher, showToast, type ToastInput } from "@/switcher"
import { useCommandText, type CommandText } from "./strings"
import { inFocusedPane } from "@/shell/pane-context"
import { openSide } from "@/side"

export interface CommandContext {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  readonly sessionID: string | undefined
  readonly directory: string | undefined
}

export interface CommandActions {
  newSession(context: CommandContext): void
  compact(context: CommandContext): Promise<void>
  /** `/reset-context [text]` (03 §18.18): the lazy context-reset chunk does it. */
  resetContext(context: CommandContext, text?: string): Promise<void>
  fork(context: CommandContext): Promise<void>
  undo(context: CommandContext): Promise<void>
  redo(context: CommandContext): Promise<void>
  exportSession(context: CommandContext): Promise<void>
  /** `/btw [질문]` (03 §4.4.2): the side panel, asking the question at once when there is one. */
  sideQuestion(context: CommandContext, question: string): void
  openSwitcher(context: CommandContext): void
  switchAgent(context: CommandContext, agent: string): Promise<void>
  /** Work panel tab (the terminal dock or the review module may take this over, see the report). */
  openTab(tab: "terminal" | "review", context: CommandContext): void
  toast(input: ToastInput): void
}

export interface CommandActionOptions {
  /** Puts the reverted message's text back into the composer (18.7), only when the box is empty. */
  readonly restoreDraft?: (text: string) => void
  /** Replace single actions (revert module, context meter, fork dialog…). */
  readonly overrides?: Partial<CommandActions>
}

/** Default actions, bound to the shell, router, host and toasts of the calling component. */
export function useCommandActions(options: CommandActionOptions = {}): CommandActions {
  const shell = useShell()
  const router = useRouter()
  const host = useHost()
  const i18n = useI18n()
  return createCommandActions(
    {
      navigate: (route) => router.navigate(route),
      openTab: (tab) => shell.openTab(tab),
      openSwitcher: () => openSwitcher({ anchor: inFocusedPane('[data-testid="composer-switcher"]') }),
      host,
      t: i18n.t,
      locale: i18n.locale,
      text: useCommandText(),
      toast: showToast,
    },
    options,
  )
}

/** What the default actions need from the app; tests pass fakes. */
export interface CommandDeps {
  readonly navigate: (route: Route) => void
  readonly openTab: (tab: "terminal" | "review", context: CommandContext) => void
  readonly openSwitcher: () => void
  readonly host: Pick<OwnHost, "capabilities" | "files">
  /** Shared catalog (`own.revert.*`). */
  readonly t: (key: I18nKey, params?: I18nParams) => string
  readonly locale?: () => Locale
  readonly text: CommandText
  readonly toast: (input: ToastInput) => void
}

export function createCommandActions(deps: CommandDeps, options: CommandActionOptions = {}): CommandActions {
  const text = deps.text
  const toast = options.overrides?.toast ?? deps.toast
  const focusComposer = () => requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())

  const defaults: CommandActions = {
    toast,
    newSession(context) {
      const projectID = context.sessionID
        ? (context.runtime.data.session.get(context.sessionID)?.projectID ??
          context.runtime.sessions.state.sessions[context.sessionID]?.projectID)
        : undefined
      // Same folder as the session on screen; the combination follows the new-session defaults (03 §5.1).
      deps.navigate(
        projectID
          ? { name: "project", serverKey: context.serverKey, projectID }
          : { name: "home", serverKey: newChatHost() },
      )
      focusComposer()
    },
    sideQuestion(context, question) {
      const sessionID = requireSession(context, text, toast)
      if (sessionID) openSide({ serverKey: context.serverKey, sessionID, ...(question ? { question } : {}) })
    },
    async compact(context) {
      const sessionID = requireSession(context, text, toast)
      if (!sessionID) return
      const run = () =>
        context.runtime.data.session.compact({ sessionID }).then(
          () => toast({ message: text("own.command.compactRequested") }),
          (error: unknown) => failed(toast, text, "compact", error),
        )
      // POST /compact commits a staged revert (core session.ts:252): ask first (03 §5.8.4 impactRevert).
      if (context.runtime.data.session.get(sessionID)?.revert)
        return toast({
          message: text("own.command.compactRevert"),
          action: { label: text("own.command.compactAnyway"), run: () => void run() },
        })
      await run()
    },
    async resetContext(context, args) {
      const sessionID = requireSession(context, text, toast)
      if (!sessionID) return
      const { resetContext } = await import("@/context-reset")
      await resetContext({ runtime: context.runtime, sessionID, locale: deps.locale?.() ?? "ko", toast, text: args })
    },
    async fork(context) {
      const sessionID = requireSession(context, text, toast)
      if (!sessionID) return
      try {
        const forked = await context.runtime.client().session.fork({ sessionID })
        context.runtime.data.session.remember(forked)
        deps.navigate({ name: "session", serverKey: context.serverKey, sessionID: forked.id })
        toast({ message: text("own.command.forked") })
        focusComposer()
      } catch (error) {
        failed(toast, text, "fork", error)
      }
    },
    async undo(context) {
      const sessionID = requireSession(context, text, toast)
      if (!sessionID) return
      const runtime = context.runtime
      // The transcript loads the open session's messages; without it (e.g. typed right after opening) load them here.
      if (!runtime.data.session.message.list(sessionID).length)
        await runtime.data.session.message.sync(sessionID).catch(() => undefined)
      const target = undoTarget(runtime, sessionID)
      if (!target) return toast({ message: text("own.command.nothingToUndo") })
      const stage = async () => {
        try {
          if (runtime.data.session.status(sessionID) === "running")
            await runtime.client().session.interrupt({ sessionID })
          await runtime.client().session.revert.stage({ sessionID, messageID: target.id, files: true })
          // Queued messages were written against the rewound history (18.7, upstream session/revert.ts).
          const queued = runtime.data.session.pending.list(sessionID).filter((item) => item.type === "user")
          await Promise.allSettled(
            queued.map((item) => runtime.client().session.inbox.cancel({ sessionID, inboxID: item.id })),
          )
          options.restoreDraft?.(target.text)
          toast({ message: text("own.command.undone") })
          if (queued.length) toast({ message: deps.t("own.revert.queueDropped", { n: queued.length }) })
        } catch (error) {
          failed(toast, text, "undo", error)
        }
      }
      // 18.7: a running turn is interrupted first, after asking.
      if (runtime.data.session.status(sessionID) === "running")
        return toast({
          message: text("own.command.undoRunning"),
          action: { label: text("own.command.undoInterrupt"), run: () => void stage() },
        })
      await stage()
    },
    async redo(context) {
      const sessionID = requireSession(context, text, toast)
      if (!sessionID) return
      if (!context.runtime.data.session.get(sessionID)?.revert) return toast({ message: text("own.command.noRevert") })
      try {
        await context.runtime.client().session.revert.clear({ sessionID })
        toast({ message: text("own.command.redone") })
      } catch (error) {
        failed(toast, text, "redo", error)
      }
    },
    async exportSession(context) {
      const sessionID = requireSession(context, text, toast)
      if (!sessionID) return
      try {
        const exported = await context.runtime.client().session.export({ sessionID })
        const name = exportFilename(exported.info)
        await save(deps.host, name, new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }))
        toast({ message: text("own.command.exported", { file: name }) })
      } catch (error) {
        failed(toast, text, "export", error)
      }
    },
    openSwitcher() {
      deps.openSwitcher()
    },
    async switchAgent(context, name) {
      const sessionID = requireSession(context, text, toast)
      if (!sessionID) return
      const runtime = context.runtime
      const location = context.directory ? { directory: context.directory } : undefined
      if (location && !runtime.data.location.agent.list(location))
        await runtime.data.location.agent.sync(location).catch(() => undefined)
      const agents = location ? (runtime.data.location.agent.list(location) ?? []) : []
      const wanted = name.toLowerCase()
      const agent = agents.find((item) => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted)
      if (!agent || agent.mode === "subagent")
        return toast({ message: text("own.command.agentUnknown", { agent: name }), tone: "danger" })
      if (runtime.data.session.get(sessionID)?.agent === agent.id)
        return toast({ message: text("own.command.agentSame", { agent: agent.name }) })
      try {
        await runtime.client().session.switchAgent({ sessionID, agent: agent.id })
        toast({ message: text("own.command.agentSwitched", { agent: agent.name }) })
      } catch (error) {
        failed(toast, text, "agent", error)
      }
    },
    openTab(tab, context) {
      deps.openTab(tab, context)
    },
  }
  return { ...defaults, ...options.overrides }
}

/** The user message `/undo` rewinds to: the last one, or the one before a staged revert (upstream `undo`). */
export function undoTarget(runtime: ServerRuntime, sessionID: string) {
  const users = runtime.data.session.message
    .list(sessionID)
    .flatMap((message) => (message.type === "user" ? [message] : []))
  const reverted = runtime.data.session.get(sessionID)?.revert?.messageID
  const boundary = reverted ? users.findIndex((message) => message.id === reverted) : users.length
  return boundary > 0 ? users[boundary - 1] : undefined
}

/** `<title>.json`; characters Windows does not allow in file names become `-`. */
export function exportFilename(info: { readonly id: string; readonly title?: string }) {
  const clean = (info.title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)
  return `${clean || info.id}.json`
}

async function save(host: CommandDeps["host"], name: string, data: Blob) {
  if (host.capabilities.saveDialog && host.files?.saveFile) {
    await host.files.saveFile({ name, data })
    return
  }
  const url = URL.createObjectURL(data)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function requireSession(context: CommandContext, text: CommandText, toast: CommandActions["toast"]) {
  if (context.sessionID) return context.sessionID
  toast({ message: text("own.command.needsSession") })
  return undefined
}

function failed(toast: CommandActions["toast"], text: CommandText, name: string, error: unknown) {
  console.error(`[own-web] /${name}`, error)
  toast({ message: text("own.command.failed", { name }), tone: "danger" })
}
