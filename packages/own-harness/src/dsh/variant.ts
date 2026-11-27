// own's revision of a dsh session's request (13, 10 §3.9), the `own` prompt variant. dsh's own text stays; only what
// does not hold in own changes:
// - dsh's runtime context names its file sandbox and its approval answerers, which own does not have; the revision
//   says what own's approval mode does instead (the Codex harness's revision does the same, codex/variant.ts);
// - the shell tool's description promises `[sandbox: …]` denial markers own never prints;
// - the time reading says the browser reported no time zone (own's clients send none); the revision names this
//   machine's zone, which own runs on;
// - core's Code Mode catalog is cut to one line per tool, as in the Pi and Codex revisions (pi/variant.ts).
// The `custom` variant (내 지시문, 10 §3.11) is the revision with the user's text in place of dsh's persona line.
export * as DshVariant from "./variant.js"

import type { OwnHarness } from "@own/protocol/rpc-harness"
import { CodexVariant } from "../codex/variant.js"
import type { DshContext } from "./context.js"
import { DshShellTool } from "./shell-tool.js"

/** Whether `prompt` runs own's revision: `own`, and `custom`, which only replaces the persona line. */
export function revised(prompt: OwnHarness.PromptID | undefined) {
  return prompt === "own" || prompt === "custom"
}

/** The revision's runtime-context policy: own's approval mode in place of dsh's file policy and approval policy. */
export function policy(mode: DshContext.Mode) {
  return [`${MODE_TEXT[mode]} ${CodexVariant.MODES}`]
}

const MODE_TEXT: Readonly<Record<DshContext.Mode, string>> = {
  full: "Approval mode: full. own runs your commands, writes and edits without asking the user; only changes to a few protected files (credentials, own's settings) are refused. Commands run for real on the machine that holds the working directory, with no sandbox and with network access, so take care with commands that delete or overwrite what the task does not need changed.",
  ask: `Approval mode: ask. Before a command runs or a file is written or edited, own shows it to the user and waits for an answer, unless an earlier "always allow" covers it; changes to a few protected files (credentials, own's settings) are always refused. Reads and searches run without asking. Commands run for real, with no sandbox and with network access. If the user declines with a note, the tool result carries the note; follow it, and do not repeat the declined call unchanged.`,
  "read-only":
    "Approval mode: read-only. own refuses commands, writes and edits in this session, so those calls fail with a permission error; reads and searches still work. When the task needs more, tell the user what you would run or change.",
}

/** The revision's shell description: dsh's without the sandbox sentence. */
export function shellDescription(description: string) {
  return description.replace(` ${DshShellTool.SANDBOX_SENTENCE}`, "")
}

/** The revision's time-zone line: the machine's zone, in dsh's wording for a zone the request reported. */
export function zone(timeZone: string) {
  return `Time zone of this machine: ${timeZone}. Interpret otherwise-unqualified dates and times in this zone.`
}

/** The revision's changes with their Korean titles and reasons for 설정 > 에이전트 방식 (prompts.ts). */
export const NOTES = {
  policy: {
    title: "승인 모드 설명",
    why: "이 앱에는 dsh 파일 샌드박스도 승인 응답자도 없어서, 실행 정보의 그 설명 대신 전체 허용·묻기·읽기 전용이 실제로 하는 일을 알려요.",
  },
  sandbox: {
    title: "셸 도구 설명의 샌드박스 문장",
    why: "이 앱은 [sandbox: …] 표시를 내지 않아서, 샌드박스가 막으면 그 표시가 붙는다는 dsh 셸 설명의 문장을 뺐어요.",
  },
  zone: {
    title: "시간 정보의 시간대",
    why: "이 앱은 dsh가 쓰는 브라우저 시간대를 보내지 않아 원본은 시간대를 '알 수 없음'이라고 해서, 개선판은 이 앱이 도는 PC의 시간대를 적어요.",
  },
  catalog: {
    title: "Code Mode 도구 목록",
    why: "OpenCode의 Code Mode 목록은 도구마다 입력과 출력 타입을 모두 적어 길어서(도구 8개에 약 5,000자), Pi·Codex 개선판처럼 인자 이름과 설명 한 줄로 줄여요. 목록은 대화마다 달라 여기서는 설명만 보여요.",
  },
} as const
