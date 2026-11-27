// Worktree conversations dock (03 §4.6.1, 06 §13.7; lazy): above the composer of a conversation whose metadata says
// it started worktree conversations (`own.worktreeChat{role:"parent"}`), one compact row per started one: its title,
// state (작업 중, 답 필요, 끝남, 막힘, 합침, 지움), branch and `열기`; above a started one (`role:"child"`), the way back
// to the conversation that started it. The list is own.team's `worktreeChat.list`, read again on `worktreeChat.changed`.
// A host whose own.team lacks the method (an older remote service) shows nothing.
import { createEffect, createResource, For, on, onCleanup, Show } from "solid-js"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { useData, type ServerKey } from "@/data"
import { featureText } from "@/queue/text"
import { useRouter } from "@/routing/router"
import "./dock.css"

const ko = {
  "own.wtchat.label": "작업 폴더 대화",
  "own.wtchat.count": "작업 폴더 대화 {n}",
  "own.wtchat.open": "열기",
  "own.wtchat.back": "원래 대화: {title}",
  "own.wtchat.backUntitled": "원래 대화로",
  "own.wtchat.where": "{branch} · 프로젝트 안 .worktrees",
  "own.wtchat.state.working": "작업 중",
  "own.wtchat.state.needs_user": "답 필요",
  "own.wtchat.state.done": "끝남",
  "own.wtchat.state.blocked": "막힘",
  "own.wtchat.state.integrated": "합침",
  "own.wtchat.state.removed": "지움",
} as const

const en: Partial<Record<keyof typeof ko, string>> = {
  "own.wtchat.label": "Worktree conversations",
  "own.wtchat.count": "Worktree conversations {n}",
  "own.wtchat.open": "Open",
  "own.wtchat.back": "Started from: {title}",
  "own.wtchat.backUntitled": "Back to the starting conversation",
  "own.wtchat.where": "{branch} · in the project's .worktrees",
  "own.wtchat.state.working": "Working",
  "own.wtchat.state.needs_user": "Needs you",
  "own.wtchat.state.done": "Done",
  "own.wtchat.state.blocked": "Blocked",
  "own.wtchat.state.integrated": "Integrated",
  "own.wtchat.state.removed": "Removed",
}

const strings = featureText(ko, en)

interface Listed {
  readonly items: ReadonlyArray<OwnTeam.WorktreeChat>
  readonly parent?: { readonly sessionID: string; readonly title?: string }
}

export default function WorktreeChatDock(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const router = useRouter()
  const text = strings.use()
  const runtime = () => data.get(props.serverKey())
  const usable = () => runtime()?.team.rpc.allowed("worktreeChat.list") === true
  const [list, { refetch }] = createResource(
    () => (usable() ? props.sessionID() : undefined),
    (sessionID): Promise<Listed> =>
      runtime()!
        .team.rpc.call("worktreeChat.list", { sessionID })
        .catch((): Listed => ({ items: [] })),
  )
  createEffect(
    on(runtime, (current) => {
      if (!current) return
      const stop = current.team.on("worktreeChat.changed", (event) => {
        const id = props.sessionID()
        const parent = list()?.parent?.sessionID
        if (event.data.parentID === id || event.data.parentID === parent) void refetch()
      })
      onCleanup(stop)
    }),
  )
  const open = (sessionID: string) => router.navigate({ name: "session", serverKey: props.serverKey(), sessionID })
  const items = () => list()?.items ?? []
  const parent = () => list()?.parent

  return (
    <Show when={items().length > 0 || parent()}>
      <section class="own-bj own-wtc" aria-label={text("own.wtchat.label")} data-testid="worktree-chat-dock">
        <Show when={parent()}>
          {(from) => (
            <div class="own-bj-row" data-testid="worktree-chat-parent">
              <span class="own-bj-row-text">
                {from().title ? text("own.wtchat.back", { title: from().title! }) : text("own.wtchat.backUntitled")}
              </span>
              <button type="button" class="own-bj-send" onClick={() => open(from().sessionID)}>
                {text("own.wtchat.open")}
              </button>
            </div>
          )}
        </Show>
        <For each={items()}>
          {(item) => (
            <div class="own-bj-row" data-testid="worktree-chat-row" data-state={item.state}>
              <span class="own-wtc-state" data-state={item.state}>
                {text(`own.wtchat.state.${item.state}`)}
              </span>
              <span class="own-bj-row-text" title={item.summary ?? item.directory}>
                {item.title}
                <span class="own-wtc-where"> · {text("own.wtchat.where", { branch: item.branch })}</span>
              </span>
              <button
                type="button"
                class="own-bj-send"
                data-testid="worktree-chat-open"
                onClick={() => open(item.sessionID)}
              >
                {text("own.wtchat.open")}
              </button>
            </div>
          )}
        </For>
      </section>
    </Show>
  )
}
