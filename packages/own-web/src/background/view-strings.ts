// Strings of the background job list and the output viewer (03 §19.7), lazy with them; the first-chunk ones are in
// strings.ts. Same namespace and rules (`own.background.*`, ko + en, `featureText`).
import { featureText } from "@/queue/text"

export const backgroundViewKo = {
  "own.background.kind.subagent": "하위 에이전트",
  "own.background.open": "열기 →",
  "own.background.stop": "종료",
  "own.background.stopNamed": "{label} 종료",
  "own.background.stopping": "종료 중…",
  "own.background.stopFailed": "종료하지 못했어요: {reason}",
  "own.background.elapsed": "{minutes}분째",
  "own.background.justStarted": "방금 시작",
  "own.background.output.title": "출력",
  "own.background.output.running": "실행 중",
  "own.background.output.exited": "끝남 (exit {code})",
  "own.background.output.ended": "끝남",
  "own.background.output.killed": "종료됨",
  "own.background.output.timeout": "시간 초과",
  "own.background.output.empty": "아직 출력이 없어요",
  "own.background.output.missing": "이 명령의 출력이 서버에 더 이상 없어요",
  "own.background.output.cut": "앞부분은 생략했어요 (마지막 {size}만 보여요)",
  "own.background.output.follow": "끝까지 따라가기",
  "own.background.output.copy": "복사",
  "own.background.output.copied": "출력을 복사했어요",
  "own.background.output.close": "닫기",
  "own.background.output.failed": "출력을 읽지 못했어요: {reason}",
  "own.background.output.where": "{shell} · {cwd}",
  "own.background.output.region": "명령 출력",
} as const satisfies Record<string, string>

export type BackgroundViewKey = keyof typeof backgroundViewKo

export const backgroundViewEn: Partial<Record<BackgroundViewKey, string>> = {
  "own.background.kind.subagent": "Subagent",
  "own.background.open": "Open →",
  "own.background.stop": "Stop",
  "own.background.stopNamed": "Stop {label}",
  "own.background.stopping": "Stopping…",
  "own.background.stopFailed": "Could not stop it: {reason}",
  "own.background.elapsed": "{minutes} min",
  "own.background.justStarted": "just started",
  "own.background.output.title": "Output",
  "own.background.output.running": "Running",
  "own.background.output.exited": "Finished (exit {code})",
  "own.background.output.ended": "Finished",
  "own.background.output.killed": "Stopped",
  "own.background.output.timeout": "Timed out",
  "own.background.output.empty": "No output yet",
  "own.background.output.missing": "The server no longer has this command's output",
  "own.background.output.cut": "Earlier output omitted (showing the last {size})",
  "own.background.output.follow": "Follow the end",
  "own.background.output.copy": "Copy",
  "own.background.output.copied": "Output copied",
  "own.background.output.close": "Close",
  "own.background.output.failed": "Could not read the output: {reason}",
  "own.background.output.where": "{shell} · {cwd}",
  "own.background.output.region": "Command output",
}

export const backgroundViewText = featureText(backgroundViewKo, backgroundViewEn)
export const useBackgroundViewText = backgroundViewText.use
