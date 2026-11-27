// 에이전트 방식 pill (10 §3.8): which harness the open conversation runs (`Codex 방식` / `Pi 방식` / `DeepSeek 방식` /
// `OpenCode 기본`, the last also for conversations made before own.harness) and switching it between runs. This PC and
// remote installs run the plugin (10 §6.1), so the pill shows on every server and switches through that server's
// client (`runtime.harness`), on a phone through the gateway too. The menu reuses the approval menu's look (requests.css
// `own-am`) and also picks the prompt variant (10 §3.9, 지시문: 원본, 개선판 or, on services that know it, 내 지시문,
// §3.11); the pill adds `개선판` or `내 지시문` while a conversation runs one. A conversation on 내 지시문 whose
// 에이전트 방식 has no saved text runs 개선판, and the pill and the menu say so. The menu links to 설정 > 에이전트 방식.
// New conversations start with the service's default (own.harness `list`, set in Settings > 일반 through
// `defaults.set`, harness/default-setting.tsx), read again when the screen opens and when the window gets focus back.
// On the new-conversation screen the pill makes a one-time pick for that screen's next conversation only; nothing is
// stored in this window. The composer names the shown harness at create time, so the first request already runs it and
// the header never shows `OpenCode 기본` while the server's stamp is on its way.
// The pill shrinks to its short name on a narrow header and hides on a conversation's narrowest one (styles/shell.css);
// the session ⋯ item `에이전트 방식 바꾸기…` opens the same menu through `requestHarnessMenu`.
// `Claude Agent 기본` (`claude-code`, 02 §8.10) belongs to the Claude Agent route: the menu offers it only on that
// route's models (or while a conversation runs it), and a new conversation on such a model runs it unless this
// screen's one-time pick named another 에이전트 방식. It has no prompt variants.
import {
  OwnHarnessRouting,
  type CustomHarnessID,
  type HarnessID,
  type PromptID,
} from "@own/protocol/rpc-harness-routing"
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
} from "solid-js"
import { OwnRpcError, useData, type ServerKey, type ServerRuntime } from "@/data"
import type { HarnessOutput } from "@/data/harness-rpc"
import { nextFrame } from "@/data/frame"
import { useI18n, type I18n, type Locale } from "@/i18n"
import { ManualLink } from "@/manual/link"
import type { Route } from "@/routing/routes"
import { useRouter } from "@/routing/router"
import { InlineIcon } from "@/shell/icons"
import { newSessionDirectory, newSessionTarget } from "@/switcher/new-session"
import { showToast } from "@/switcher/toast"
import "@/requests/requests.css"
import type { omoText } from "./omo-strings"

type Choice = { readonly harness: HarnessID; readonly prompt: PromptID }

/**
 * What a server's own.harness offers (`list`): its 에이전트 방식 (omo only while own-omo runs there, own/docs/15), its
 * prompt variants and the harnesses with a saved 내 지시문.
 */
type Offer = {
  readonly harnesses: readonly HarnessID[]
  readonly prompts: readonly PromptID[]
  readonly custom: readonly CustomHarnessID[]
}

/** A service that answered no `list` yet, or one from before 내 지시문 (2026-10-18). */
const OLDER: Offer = {
  harnesses: OwnHarnessRouting.IDS.filter((id) => id !== "omo" && id !== "claude-code"),
  prompts: ["reference", "own"],
  custom: [],
}

/** The new-conversation screen a one-time pick belongs to: one project's (`project:<server>:<id>`), or home. */
export function harnessScreen(route: Route) {
  return route.name === "project" ? `project:${route.serverKey}:${route.projectID}` : route.name
}

/**
 * The next new conversation's 에이전트 방식: the one-time pick of that screen, else the server's default as `list` last
 * answered (per server). A pick counts only on the screen it was made on, also when the header pill was gone in
 * between (a page), and is dropped when the pill's screen changes. On a Claude Agent model (`providerID`) the default is
 * `Claude Agent 기본`; a pick of it counts on that route only.
 */
export const newSessionHarness = createRoot(() => {
  const [picked, setPicked] = createSignal<Choice & { readonly serverKey: ServerKey; readonly screen: string }>()
  const [defaults, setDefaults] = createSignal<Readonly<Record<ServerKey, Choice>>>({})
  const [offers, setOffers] = createSignal<Readonly<Record<ServerKey, Offer>>>({})
  const asked = new Set<ServerKey>()
  const refresh = (runtime: ServerRuntime) => {
    if (!runtime.harness.allowed("list")) return
    void runtime.harness.call("list", {}).then(
      (list) => remember(runtime.key, list),
      () => undefined,
    )
  }
  const pickedOn = (serverKey: ServerKey, screen: string) => {
    const value = picked()
    return value?.serverKey === serverKey && value.screen === screen ? value : undefined
  }
  const shown = (serverKey: ServerKey, screen: string, providerID?: string): Choice | undefined => {
    const pick = pickedOn(serverKey, screen)
    const agent = providerID === OwnHarnessRouting.CLAUDE_AGENT
    if (pick && (agent || pick.harness !== "claude-code")) return pick
    const fallback = defaults()[serverKey]
    return agent ? { harness: "claude-code", prompt: fallback?.prompt ?? "own" } : fallback
  }
  const remember = (serverKey: ServerKey, list: HarnessOutput<"list">) => {
    setDefaults((all) => ({ ...all, [serverKey]: { harness: list.default, prompt: list.defaultPrompt } }))
    setOffers((all) => ({
      ...all,
      [serverKey]: { harnesses: list.harnesses, prompts: list.prompts, custom: list.custom ?? [] },
    }))
  }
  return {
    picked: pickedOn,
    shown,
    /** The server's prompt variants and saved 내 지시문 as `list` last answered. */
    offer: (serverKey: ServerKey): Offer => offers()[serverKey] ?? OLDER,
    /** Asks `list` once per server in this window when nothing has answered yet (a conversation opened directly). */
    ensure(runtime: ServerRuntime) {
      if (offers()[runtime.key] !== undefined || asked.has(runtime.key)) return
      asked.add(runtime.key)
      refresh(runtime)
    },
    pick(serverKey: ServerKey, screen: string, choice: Choice) {
      setPicked({ serverKey, screen, harness: choice.harness, prompt: choice.prompt })
    },
    reset() {
      setPicked(undefined)
    },
    /** Keeps what `list` or `defaults.set` answered for this server. */
    remember,
    /** Asks the server's default again; a server without own.harness or a failed call keeps the last answer. */
    refresh,
    /**
     * Metadata naming the shown 에이전트 방식 for a conversation on `providerID`'s model, for `session.create`; empty
     * while the default is not known yet, and then the server stamps its own default.
     */
    metadata(serverKey: ServerKey, screen: string, providerID?: string) {
      const value = shown(serverKey, screen, providerID)
      return value ? { [OwnHarnessRouting.META_KEY]: OwnHarnessRouting.value(value.harness, value.prompt) } : {}
    },
  }
})

const [menuRequest, setMenuRequest] = createRoot(() =>
  createSignal<{ readonly serverKey: ServerKey; readonly sessionID: string }>(),
)

/** A menu request no pill has taken yet. */
export const pendingHarnessMenu = menuRequest

/** Opens the 에이전트 방식 menu of a conversation (the session ⋯ item), centred when its header pill is hidden. */
export function requestHarnessMenu(serverKey: ServerKey, sessionID: string) {
  const request = { serverKey, sessionID }
  setMenuRequest(request)
  // The conversation's pill takes the request as it is set; one no pill took must not open later by surprise.
  queueMicrotask(() => {
    if (menuRequest() === request) setMenuRequest(undefined)
  })
}

/** Switches a conversation's 에이전트 방식 or prompt variant between runs and says how it went. */
export async function switchHarness(
  runtime: ServerRuntime,
  sessionID: string,
  input: { readonly harness: HarnessID; readonly prompt?: PromptID },
  i18n: I18n,
) {
  const message =
    input.prompt === undefined
      ? i18n.t("own.harness.applied", { name: i18n.t(`own.harness.name.${input.harness}`) })
      : i18n.t("own.harness.prompt.applied", { name: i18n.t(`own.harness.prompt.name.${input.prompt}`) })
  try {
    await runtime.harness.call("session.set", { sessionID, harness: input.harness, prompt: input.prompt })
    runtime.data.session.invalidate(sessionID)
    await runtime.data.session.sync(sessionID)
    showToast({ message })
    return true
  } catch (error) {
    console.error("[own-web] own.harness session.set failed", error)
    const busy = error instanceof OwnRpcError && error.type === "session_busy"
    showToast({ message: i18n.t(busy ? "own.harness.busy" : "own.harness.failed"), tone: "danger" })
    return false
  }
}

export function HarnessPill(props: {
  readonly serverKey: Accessor<ServerKey>
  readonly sessionID: Accessor<string | undefined>
}) {
  const data = useData()
  const i18n = useI18n()
  const router = useRouter()
  const [open, setOpen] = createSignal(false)
  const [centred, setCentred] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  let button: HTMLButtonElement | undefined
  const runtime = () => data.get(props.serverKey())
  const screen = () => harnessScreen(router.route())
  // The model's provider: the conversation's, or the one a new conversation would start on (the composer's target).
  const provider = createMemo(() => {
    const value = runtime()
    if (!value) return undefined
    const sessionID = props.sessionID()
    if (sessionID)
      return (value.data.session.get(sessionID)?.model ?? value.sessions.state.sessions[sessionID]?.model)?.providerID
    return newSessionTarget(value, props.serverKey(), newSessionDirectory(value, router.route()))?.providerID
  })
  const current = (): HarnessID => {
    const sessionID = props.sessionID()
    if (!sessionID) return newSessionHarness.shown(props.serverKey(), screen(), provider())?.harness ?? "codex"
    return OwnHarnessRouting.harnessOf(runtime()?.data.session.get(sessionID)?.metadata)
  }
  const prompt = (): PromptID => {
    const sessionID = props.sessionID()
    // Until `list` answers, the plugin's default (own-harness options.ts), as for the harness above.
    if (!sessionID) return newSessionHarness.shown(props.serverKey(), screen(), provider())?.prompt ?? "own"
    return OwnHarnessRouting.promptOf(runtime()?.data.session.get(sessionID)?.metadata)
  }
  const name = (id: HarnessID) => i18n.t(`own.harness.name.${id}`)
  const offer = () => newSessionHarness.offer(props.serverKey())
  // 내 지시문 without a saved text runs 개선판, so the pill names what runs.
  const shownPrompt = () => runs(prompt(), current(), offer())
  const suffix = () =>
    variantHarness(current()) === undefined || shownPrompt() === "reference"
      ? undefined
      : i18n.t(shownPrompt() === "custom" ? "own.harness.prompt.short.custom" : "own.harness.prompt.short.own")
  const label = () => (suffix() ? `${name(current())} · ${suffix()}` : name(current()))
  const short = () =>
    suffix() ? `${i18n.t(`own.harness.short.${current()}`)} · ${suffix()}` : i18n.t(`own.harness.short.${current()}`)
  const busy = () => {
    const sessionID = props.sessionID()
    return sessionID !== undefined && runtime()?.data.session.status(sessionID) === "running"
  }
  const allowed = () => props.sessionID() === undefined || runtime()?.harness.allowed("session.set") === true

  // The new-conversation screen shows the server's current default: read when a screen opens and when this window gets
  // focus back, since Settings in another window may have changed it.
  createEffect(
    on([runtime, props.sessionID, screen], ([value, sessionID]) => {
      if (!value || sessionID !== undefined) return
      const read = () => newSessionHarness.refresh(value)
      read()
      window.addEventListener("focus", read)
      onCleanup(() => window.removeEventListener("focus", read))
    }),
  )
  // The one-time pick belongs to the screen it was made on.
  createEffect(on(screen, () => newSessionHarness.reset(), { defer: true }))
  // A conversation opened directly (no new-conversation screen before it) asks once, so a 내 지시문 pill names what
  // runs from the start.
  createEffect(
    on(runtime, (value) => {
      if (value) newSessionHarness.ensure(value)
    }),
  )
  // An open menu asks the server again which variants it offers and which 내 지시문 are saved (설정 may have changed it).
  createEffect(
    on(open, (value) => {
      const server = runtime()
      if (value && server) newSessionHarness.refresh(server)
    }),
  )
  // The session ⋯ item: open here, anchored to the pill when it is on screen.
  createEffect(() => {
    const request = menuRequest()
    if (!request || request.serverKey !== props.serverKey() || request.sessionID !== props.sessionID()) return
    setMenuRequest(undefined)
    setCentred(button?.offsetParent === null)
    setOpen(true)
  })

  // The session store keeps the metadata of its last read: a switch from this or another window is read again.
  createEffect(() => {
    const value = runtime()
    const sessionID = props.sessionID()
    if (!value || !sessionID) return
    onCleanup(
      value.bus.on("session.metadata.updated", (event) => {
        if (event.data.sessionID !== sessionID) return
        if (
          OwnHarnessRouting.harnessOf(event.data.metadata) === current() &&
          OwnHarnessRouting.promptOf(event.data.metadata) === prompt()
        )
          return
        value.data.session.invalidate(sessionID)
        void value.data.session
          .sync(sessionID)
          .catch((error: unknown) => console.warn("[own-web] session failed to load", error))
      }),
    )
  })

  async function choose(next: Choice, change: "harness" | "prompt") {
    const sessionID = props.sessionID()
    if (!sessionID) {
      newSessionHarness.pick(props.serverKey(), screen(), next)
      return close()
    }
    const value = runtime()
    if (!value || (next.harness === current() && next.prompt === prompt())) return close()
    setPending(true)
    const done = await switchHarness(
      value,
      sessionID,
      change === "harness" ? { harness: next.harness } : { harness: next.harness, prompt: next.prompt },
      i18n,
    )
    setPending(false)
    if (done) close()
  }

  function close() {
    setOpen(false)
    // A hidden pill cannot take focus: give it back to the session ⋯ that opened the menu.
    if (button && button.offsetParent !== null) return button.focus()
    document.querySelector<HTMLElement>('[data-testid="header"] [data-testid="session-menu"]')?.focus()
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        class="own-target inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-own-border px-2.5 text-[12px] text-own-muted hover:bg-own-hover"
        data-testid="harness-pill"
        data-harness={current()}
        data-prompt={prompt()}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-label={i18n.t("own.harness.label", { name: label() })}
        title={i18n.t("own.harness.label", { name: label() })}
        onClick={() => {
          setCentred(false)
          setOpen((value) => !value)
        }}
      >
        <InlineIcon name="agent" size={13} />
        <span class="own-header-harness-full max-w-[12rem] truncate">{label()}</span>
        <span class="own-header-harness-short">{short()}</span>
      </button>
      <Show when={open()}>
        <HarnessMenu
          anchor={centred() ? undefined : button}
          session={props.sessionID() !== undefined}
          current={current()}
          prompt={prompt()}
          offer={offer()}
          agent={provider() === OwnHarnessRouting.CLAUDE_AGENT}
          pending={pending()}
          busy={busy()}
          allowed={allowed()}
          onChoose={(id) => void choose({ harness: id, prompt: prompt() }, "harness")}
          onChoosePrompt={(id) => void choose({ harness: current(), prompt: id }, "prompt")}
          onEdit={() => {
            close()
            router.navigate({ name: "settings", section: "harness" })
          }}
          onClose={close}
        />
      </Show>
    </>
  )
}

function HarnessMenu(props: {
  readonly anchor: HTMLElement | undefined
  readonly session: boolean
  readonly current: HarnessID
  readonly prompt: PromptID
  readonly offer: Offer
  /** The model is on the Claude Agent route, the only one `Claude Agent 기본` is offered on. */
  readonly agent: boolean
  readonly pending: boolean
  readonly busy: boolean
  readonly allowed: boolean
  readonly onChoose: (id: HarnessID) => void
  readonly onChoosePrompt: (id: PromptID) => void
  readonly onEdit: () => void
  readonly onClose: () => void
}) {
  const i18n = useI18n()
  const [place, setPlace] = createSignal<{ left: number; top: number }>()
  let root: HTMLDivElement | undefined
  const title = () => i18n.t(props.session ? "own.harness.menu" : "own.harness.newSession")
  const disabled = () => !props.allowed || props.pending || props.busy
  const shown = () => menuHarnesses(props.offer, props.current, props.agent)
  const description = (id: HarnessID) =>
    id === "omo" ? omoDescription(i18n.locale()) : i18n.t(`own.harness.desc.${id}`)

  onMount(() => {
    nextFrame(() => {
      if (!root) return
      const rect = props.anchor?.isConnected ? props.anchor.getBoundingClientRect() : undefined
      const width = root.offsetWidth
      const left = rect ? Math.min(Math.max(12, rect.right - width), innerWidth - width - 12) : (innerWidth - width) / 2
      setPlace({ left: Math.max(12, left), top: rect ? rect.bottom + 6 : 80 })
      // Every row is locked while the conversation runs or without the switch scope: the menu itself takes focus then,
      // so Escape still closes it.
      ;(root.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ?? root).focus()
    })
    const outside = (event: PointerEvent) => {
      const node = event.target
      if (!(node instanceof Node) || root?.contains(node) || props.anchor?.contains(node)) return
      props.onClose()
    }
    document.addEventListener("pointerdown", outside, true)
    onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  })

  return (
    <div
      ref={root}
      class="own-am"
      role="dialog"
      aria-label={title()}
      tabIndex={-1}
      data-testid="harness-menu"
      data-placed={place() ? "true" : "false"}
      style={place() ? { left: `${place()!.left}px`, top: `${place()!.top}px` } : undefined}
      onKeyDown={(event) => {
        if (event.isComposing || event.keyCode === 229) return
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
    >
      <p class="own-am-title">{title()}</p>
      <Show when={props.busy || !props.allowed}>
        <p class="own-am-note" data-testid="harness-menu-blocked">
          {i18n.t(props.busy ? "own.harness.busyNote" : "own.harness.noScope")}
        </p>
      </Show>
      <div role="menu" aria-orientation="vertical">
        <For each={shown()}>
          {(id) => (
            <button
              type="button"
              class="own-am-item"
              role="menuitemradio"
              aria-checked={props.current === id}
              data-testid={`harness-${id}`}
              disabled={disabled()}
              onClick={() => props.onChoose(id)}
            >
              <span class="own-rq-check" data-type="radio" aria-hidden="true">
                {props.current === id ? "✓" : ""}
              </span>
              <span class="own-rq-option-main">
                <span class="own-am-name">{i18n.t(`own.harness.name.${id}`)}</span>
                <span class="own-rq-option-desc">{description(id)}</span>
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={variantHarness(props.current)}>
        {(harness) => (
          <>
            <p class="own-am-title">{i18n.t("own.harness.prompt.title")}</p>
            <div role="menu" aria-orientation="vertical">
              <For each={OwnHarnessRouting.PROMPTS.filter((id) => props.offer.prompts.includes(id))}>
                {(id) => (
                  <button
                    type="button"
                    class="own-am-item"
                    role="menuitemradio"
                    aria-checked={props.prompt === id}
                    data-testid={`harness-prompt-${id}`}
                    disabled={disabled()}
                    onClick={() => props.onChoosePrompt(id)}
                  >
                    <span class="own-rq-check" data-type="radio" aria-hidden="true">
                      {props.prompt === id ? "✓" : ""}
                    </span>
                    <span class="own-rq-option-main">
                      <span class="own-am-name">{i18n.t(`own.harness.prompt.name.${id}`)}</span>
                      <span class="own-rq-option-desc">
                        {i18n.t(
                          id === "custom" && runs(id, harness(), props.offer) !== "custom"
                            ? "own.harness.prompt.missing"
                            : `own.harness.prompt.desc.${harness()}.${id}`,
                        )}
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
      <p class="own-am-note">{i18n.t(props.session ? "own.harness.switchNote" : "own.harness.newSessionNote")}</p>
      <Show when={variantHarness(props.current) !== undefined && props.offer.prompts.includes("custom")}>
        <button
          type="button"
          class="own-link mx-3 mb-1 self-start border-0 bg-transparent p-0"
          data-testid="harness-prompt-edit"
          onClick={() => props.onEdit()}
        >
          {i18n.t("own.harness.prompt.edit")}
        </button>
      </Show>
      <ManualLink place="harness" label="own.discover.manual.harness" class="mx-2 mb-1" />
    </div>
  )
}

// omo (원본)'s words are in a lazy chunk (omo-strings.ts), loaded the first time something shows omo. A signal, not a
// resource: reading a loading resource would suspend the menu or the setting around it until the chunk arrives.
const [omoWords, setOmoWords] = createSignal<typeof omoText>()

/** omo (원본)'s one-line description; empty until its strings have loaded (they load on the first read). */
export function omoDescription(locale: Locale) {
  const words = omoWords()
  if (words === undefined) void import("./omo-strings").then((module) => setOmoWords(() => module.omoText))
  return words?.text(locale, "own.omo.desc") ?? ""
}

/** The variant that runs: 내 지시문 of a 에이전트 방식 without a saved text runs 개선판. */
export function runs(
  prompt: PromptID,
  harness: HarnessID,
  offer: { readonly prompts: readonly PromptID[]; readonly custom: readonly CustomHarnessID[] },
): PromptID {
  if (prompt !== "custom") return prompt
  const custom = variantHarness(harness)
  return custom !== undefined && offer.custom.includes(custom) ? "custom" : "own"
}

/**
 * The 에이전트 방식 the menu lists: the service's, and the conversation's own even where it is no longer offered.
 * `Claude Agent 기본` only on a Claude Agent model (`agent`), or while it is the conversation's.
 */
export function menuHarnesses(offer: Pick<Offer, "harnesses">, current: HarnessID, agent: boolean) {
  return OwnHarnessRouting.IDS.filter(
    (id) => (offer.harnesses.includes(id) && (agent || id !== "claude-code")) || id === current,
  )
}

/**
 * The 에이전트 방식 whose prompt has variants (원본, 개선판, 내 지시문). OpenCode 기본 sends OpenCode's text, omo
 * (원본) the text omo builds per request and Claude Agent 기본 Claude Code's own: none has one to pick.
 */
export function variantHarness(harness: HarnessID): CustomHarnessID | undefined {
  return harness === "opencode" || harness === "omo" || harness === "claude-code" ? undefined : harness
}
