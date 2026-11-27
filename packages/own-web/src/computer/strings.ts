// Computer use strings of the first chunk (01 §10.2): the header chip and the session `⋯` item. Everything else (the
// dialog, 설정 > 실험, the plugins row) is in `panel-strings.ts`, which only the lazy chunks load. Same `t()` rules as
// src/i18n (ko + en); `own.set.computerUse` is the settings page's shared key there.
import { catalogText, useCatalogText } from "@/projects/text"

export const computerKo = {
  "own.computer.menu": "이 대화에서 컴퓨터 사용…",
  "own.computer.chip": "컴퓨터 사용",
  "own.computer.chipActive": "PC 조작 중",
  "own.computer.chipActiveApp": "PC 조작 중 · {app}",
  "own.computer.chipStopped": "컴퓨터 사용 멈춤",
  "own.computer.chipTitle": "이 대화는 컴퓨터 사용이 켜져 있어요. 눌러서 바꾸기",
  "own.computer.stop": "멈추기",
  "own.computer.stopTitle": "모든 대화의 컴퓨터 사용을 멈춰요 (Ctrl+Alt+Shift+Q)",
  "own.computer.stopFailed": "멈추지 못했어요. Ctrl+Alt+Shift+Q를 누르세요.",
  "own.computer.chipNoVision": "컴퓨터 사용 · 이 모델로는 안 돼요",
  "own.computer.chipNoVisionTitle":
    "지금 모델은 그림을 볼 수 없어서 컴퓨터 사용이 동작하지 않아요. 그림을 볼 수 있는 모델로 바꾸거나, 눌러서 끄세요",
  "own.computer.noVisionSwitched":
    "바꾼 모델은 그림을 볼 수 없어서 이 대화의 컴퓨터 사용이 동작하지 않아요. 그림을 볼 수 있는 모델로 바꾸거나 컴퓨터 사용을 끄세요.",
} as const satisfies Record<string, string>

export type ComputerKey = keyof typeof computerKo

export const computerEn: Partial<Record<ComputerKey, string>> = {
  "own.computer.menu": "Computer use in this session…",
  "own.computer.chip": "Computer use",
  "own.computer.chipActive": "Operating the PC",
  "own.computer.chipActiveApp": "Operating the PC · {app}",
  "own.computer.chipStopped": "Computer use stopped",
  "own.computer.chipTitle": "Computer use is on for this session. Click to change",
  "own.computer.stop": "Stop",
  "own.computer.stopTitle": "Stops computer use for every session (Ctrl+Alt+Shift+Q)",
  "own.computer.stopFailed": "Could not stop it. Press Ctrl+Alt+Shift+Q.",
  "own.computer.chipNoVision": "Computer use · not with this model",
  "own.computer.chipNoVisionTitle":
    "The current model cannot see images, so computer use does nothing. Switch to a model that can see images, or click to turn it off",
  "own.computer.noVisionSwitched":
    "The model you switched to cannot see images, so computer use does nothing in this session. Switch to a model that can see images, or turn computer use off.",
}

export const computerText = catalogText(computerKo, computerEn)

export function useComputerText() {
  return useCatalogText(computerText)
}
