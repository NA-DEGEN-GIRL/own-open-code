// Strings of the 계정·한도 tab's `이 대화` card and its context bar (03 §4.7.1, §5.8.3, UX 2026-10-26). Only the lazy
// panel chunk reads them, so none is in the first chunk (PF5); the card reuses the shared keys it already had
// (`own.pill.cache`, `own.cache.*`, `own.lim.autoAt`, `own.claude.costUnknown`, `own.lim.switch`, …).
import { featureText } from "@/queue/text"

export const sessionCardKo = {
  "own.lim.sess.totals": "지금까지 입력 {input} (캐시 {hit}) · 출력 {output}",
  "own.lim.sess.autoAt": "자동 압축 {tokens}",
  "own.lim.sess.side": "곁질문 {n}번 포함",
} as const satisfies Record<string, string>

export type SessionCardKey = keyof typeof sessionCardKo

export const sessionCardEn: Partial<Record<SessionCardKey, string>> = {
  "own.lim.sess.totals": "So far: input {input} (cache {hit}) · output {output}",
  "own.lim.sess.autoAt": "auto-compact at {tokens}",
  "own.lim.sess.side": "includes {n} side questions",
}

export const sessionCardText = featureText(sessionCardKo, sessionCardEn)
export const useSessionCardText = sessionCardText.use
