// `Codex 최신 모델 자동 확인` (07 §4.5, CA 2026-10-19): the row on 설정 > 프리셋's ChatGPT tab and the account card's
// note about Codex models own leaves out. A catalog of its own, loaded with those screens. Same rules as the projects
// catalog (`own.project.*`): ko + en, Korean fallback, `{name}` params, Korean particles.
import { catalogText, useCatalogText } from "@/projects/text"

export const codexModelsKo = {
  "own.codexModels.title": "Codex 최신 모델 자동 확인",
  "own.codexModels.note":
    "하루 한 번 Codex 최신 버전 번호를 확인해서, own을 업데이트하지 않아도 새 Codex 모델의 정보를 받아요. 계정 정보는 보내지 않아요.",
  "own.codexModels.on": "켬",
  "own.codexModels.off": "끔",
  "own.codexModels.version": "지금 Codex {version} 기준으로 목록을 받아요",
  "own.codexModels.checked": "마지막 확인 {when}",
  "own.codexModels.notChecked": "아직 확인 전이에요",
  "own.codexModels.buildOnly": "own에 들어 있는 버전이에요",
  "own.codexModels.unknown": "own이 아직 모르는 Codex 모델 {n}개는 빠졌어요 · own 업데이트가 필요해요",
  "own.codexModels.leftOut": "own이 아직 못 돌리는 Codex 모델은 빠졌어요: {list} · own 업데이트가 필요해요",
  "own.codexModels.borrowed": "서버가 지시문을 주지 않은 모델은 비슷한 모델의 지시문으로 돌아요: {list}",
  "own.codexModels.newer": "새 Codex {latest} 출시 · 새 모델은 바로 쓰고, 새 도구와 형식은 own 업데이트가 필요해요",
  "own.codexModels.served": "모델 정보 일부는 서버 목록 기준이에요",
  "own.codexModels.savedOn": "켰어요. 더 새 Codex가 있으면 목록을 다시 받아요.",
  "own.codexModels.savedOff": "껐어요. own에 들어 있는 버전으로 목록을 다시 받아요.",
  "own.codexModels.failed": "바꾸지 못했어요. 다시 해 보세요.",
  "own.codexModels.readOnly": "이 기기에서는 바꿀 수 없어요. PC의 앱 창에서 바꿔 주세요.",
  "own.codexModels.unavailable": "이 서비스는 이 설정을 아직 몰라요. 서비스를 새 버전으로 다시 시작하세요.",
} as const satisfies Record<string, string>

export type CodexModelsKey = keyof typeof codexModelsKo

export const codexModelsEn: Partial<Record<CodexModelsKey, string>> = {
  "own.codexModels.title": "Check for new Codex models",
  "own.codexModels.note":
    "Once a day own reads the newest Codex version number, so new Codex models' details arrive without an own update. No account data is sent.",
  "own.codexModels.on": "On",
  "own.codexModels.off": "Off",
  "own.codexModels.version": "Lists are asked as Codex {version}",
  "own.codexModels.checked": "last checked {when}",
  "own.codexModels.notChecked": "not checked yet",
  "own.codexModels.buildOnly": "the version built into own",
  "own.codexModels.unknown": "{n} Codex models own does not know yet are left out · own needs an update",
  "own.codexModels.leftOut": "Codex models own cannot run yet are left out: {list} · own needs an update",
  "own.codexModels.borrowed": "Models the server gave no instructions for run with a similar model's: {list}",
  "own.codexModels.newer": "Codex {latest} is out · new models work now; new tools and formats need an own update",
  "own.codexModels.served": "Some model details come from the server's list",
  "own.codexModels.savedOn": "Turned on. If a newer Codex is out, the lists are fetched again.",
  "own.codexModels.savedOff": "Turned off. The lists are fetched again as the version built into own.",
  "own.codexModels.failed": "Could not change it. Try again.",
  "own.codexModels.readOnly": "This device cannot change it. Change it in the app window on the PC.",
  "own.codexModels.unavailable":
    "This service does not know this setting yet. Restart the service on the new version.",
}

export const codexModelsText = catalogText(codexModelsKo, codexModelsEn)

export function useCodexModelsText() {
  return useCatalogText(codexModelsText)
}
