export * as OpWords from "./words.js"

import type { OwnTeam } from "@own/protocol"

/**
 * An op's kind as the result cards title it (own-web `own.team.card.title.*`), for the main's tool texts and team
 * updates. Partial on purpose: a kind added later (another track) reads as its code name until it gets words.
 */
const WORDS: Readonly<Partial<Record<OwnTeam.OpKind, string>>> = {
  enable: "팀 모드 켜기",
  reorg: "팀 구성 바꾸기",
  integrate: "반영하기",
  rotate: "새 대화로 이어가기",
  paths: "큰 파일 폴더",
  retire: "영역 끝내기",
  disable: "팀 모드 끄기",
  undo: "되돌리기",
  home: "메인 폴더 바꾸기",
  adopt: "팀에 넣기",
  unadopt: "팀에서 빼기",
  "team-account": "팀 계정 바꾸기",
  seat: "담당 대화 바꾸기",
}

export function of(kind: OwnTeam.OpKind) {
  return WORDS[kind] ?? kind
}

/** What a step waits for, by its wait's `why` (RH-20), for `team_status`. */
const WAITS: Readonly<Record<string, string>> = {
  "safe-point": "영역이 쉬기를 기다림",
  turn: "담당 대화의 차례가 끝나기를 기다림",
  "main-idle": "팀 메인이 쉬기를 기다림",
  account: "옛 계정의 일이 끝나기를 기다림",
  "account-switch": "팀 메인의 계정 전환을 기다림",
}

export function waiting(why: string) {
  return WAITS[why] ?? "기다림"
}

/** The buttons a wait offers, as the screen names them (RH-20), the one that goes on first. */
const ACTIONS: ReadonlyArray<readonly [OwnTeam.WaitAction, string]> = [
  ["stop-shell", "명령 멈추고 진행"],
  ["force", "바로 진행"],
  ["cancel", "취소"],
]

/** `[명령 멈추고 진행]이나 [취소]를`: the buttons as one object of a sentence, with the particles their words take. */
export function actions(list: ReadonlyArray<OwnTeam.WaitAction>) {
  const words = ACTIONS.filter(([action]) => list.includes(action)).map(([, word]) => word)
  return words
    .map((word, index) =>
      index === words.length - 1 ? `[${word}]${final(word) ? "을" : "를"}` : `[${word}]${final(word) ? "이나" : "나"}`,
    )
    .join(" ")
}

/** Whether a Hangul word ends in a final consonant (받침), which picks the particle after it. */
function final(word: string) {
  const code = word.charCodeAt(word.length - 1) - 0xac00
  return code >= 0 && code < 11172 && code % 28 !== 0
}

/** `n분째` of a wait or a step that began at `since` (at least 1). */
export function minutes(since: number, now: number) {
  return `${Math.max(1, Math.floor((now - since) / 60_000))}분째`
}
