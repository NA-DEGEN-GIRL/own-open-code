// What the chat view toggles (src/chat-view, 03 §4.5 "대화 보기") change in the transcript. Presentational only: the
// projection drops hidden rows, own rows render nothing, and session-ui's meta spans get `display: none` (out of the
// tab order and the accessibility tree). Nothing reaches a session or the model.
import type { ChatView } from "@/chat-view"
import type { TimelineView } from "@/timeline-settings/detail"
import type { TurnSpeed } from "./usage"

/**
 * The timeline preset with the hidden categories of the chat view: thinking, tools (with shell runs and edits) and
 * subagents become session-ui `hidden` (failed shell runs and errors stay, session-ui's rule). The virtualizer keeps
 * measurements per presentation, so the key names what is hidden.
 */
export function chatTimelineView(view: TimelineView, shown: ChatView): TimelineView {
  if (shown.thinking && shown.tools && shown.subagents) return view
  const detail = view.detail
  const tools = shown.tools ? undefined : ("hidden" as const)
  const next = {
    shell: tools ? { ...detail.shell, placement: tools } : detail.shell,
    edit: tools ? { ...detail.edit, placement: tools } : detail.edit,
    thinking: shown.thinking ? detail.thinking : { ...detail.thinking, placement: "hidden" as const },
    subagents: shown.subagents ? detail.subagents : { placement: "hidden" as const },
    notices: detail.notices,
    tools: tools ? { placement: tools } : detail.tools,
    commentary: detail.commentary,
  }
  const hidden = (["thinking", "tools", "subagents"] as const).filter((key) => !shown[key])
  return {
    detail: next,
    reasoningMode: shown.thinking ? view.reasoningMode : "hidden",
    shellToolDefaultOpen: view.shellToolDefaultOpen,
    editToolDefaultOpen: view.editToolDefaultOpen,
    presentationKey: `${view.presentationKey}:-${hidden.join("-")}`,
  }
}

/**
 * The transcript body's `data-hide` (space-separated, CSS `~=`): session-ui's message meta spans that transcript.css
 * hides — agent and model (`model`) and times (`time`). Its answer meta line joins agent, model and duration, so it
 * goes when either is hidden. While `날짜·시각` is on, own's line above a prompt has its date and time, so the prompt's
 * hover time goes too (`stamp`). `undefined` when nothing is hidden. The answer's speed on that line (upstream v2.2.6,
 * 5a750e64a2) has no word: transcript.css always hides it, own's footer shows the speed (US6-20).
 */
export function hiddenMeta(shown: ChatView) {
  const hidden = [
    ...(["model", "time"] as const).filter((key) => !shown[key]),
    ...(shown.clock ? (["stamp"] as const) : []),
  ]
  return hidden.length ? hidden.join(" ") : undefined
}

export type FooterSlot =
  | "account"
  | "model"
  | "input"
  | "output"
  | "cost"
  | "rewrite"
  | "speed"
  | "firstToken"
  | "time"
  | "clock"

/**
 * The turn footer's parts in order (`● 개인 Pro · GPT-5.6 Sol · 입력 148k (캐시 96%) · 출력 2.1k · ≈15.8 cr 추정 · 42 t/s ·
 * 첫 토큰 1.2초 · 42초 · 10월 18일 오후 3:43`). `clock` is when the answer finished (or, still running, started). An
 * empty list draws no footer.
 */
export function footerSlots(
  shown: ChatView,
  input: {
    readonly speed: TurnSpeed | null
    readonly duration: boolean
    readonly rewrote: boolean
    readonly clock: boolean
  },
): FooterSlot[] {
  return [
    ...(shown.model ? (["account", "model"] as const) : []),
    ...(shown.usage ? (["input", "output", "cost"] as const) : []),
    ...(shown.usage && input.rewrote ? (["rewrite"] as const) : []),
    ...(shown.speed && input.speed ? (["speed"] as const) : []),
    ...(shown.speed && input.speed && input.speed.firstTokenMs !== null ? (["firstToken"] as const) : []),
    ...(shown.time && input.duration ? (["time"] as const) : []),
    ...(shown.clock && input.clock ? (["clock"] as const) : []),
  ]
}
