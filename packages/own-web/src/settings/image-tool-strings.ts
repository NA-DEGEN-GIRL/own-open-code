// 설정 > 이미지 만들기 (decisions US5, IS): the page's words, a catalog of its own so they load with the page, not in
// the first chunk. Same rules as the projects catalog.
import { catalogText, useCatalogText } from "@/projects/text"

export const imageToolKo = {
  "own.imageTool.lead":
    "켜면 대화의 모델이 도구(image_generate)로 이미지를 만들어요. OpenAI API 키 계정을 아래 순서대로 쓰고, 키가 모두 바닥나면 ChatGPT 구독으로 대신 만들 수 있어요.",
  "own.imageTool.toggle": "모델에 이미지 만들기 도구 주기",
  "own.imageTool.default": "기본은 꺼져 있어요.",
  "own.imageTool.cost":
    "켜거나 끄면 모든 대화의 도구 목록이 바뀌어서, 대화마다 다음 요청 한 번은 캐시를 다시 써요. 이미지를 만들 때마다 그 이미지 모델의 요금이 들어요.",
  "own.imageTool.shared": "이 PC의 서비스에 저장돼서 모든 창과 기기, SSH 원격 호스트의 대화에 같이 적용돼요.",
  "own.imageTool.on": "켰어요. 다음 요청부터 도구 목록에 들어가요.",
  "own.imageTool.off": "껐어요. 다음 요청부터 도구 목록에서 빠져요.",
  "own.imageTool.readOnly": "이 기기에서는 바꿀 수 없어요. PC의 앱 창에서 바꿔 주세요.",
  "own.imageTool.unknown": "이 서비스는 이 설정을 아직 몰라요. 서비스를 새 버전으로 다시 시작하세요.",
  "own.imageTool.model": "모델 (API 키)",
  "own.imageTool.family.auto": "gpt-image-2.6 자동 (권장): 그림마다 AI가 Flare와 Sunburst 중에서 골라요",
  "own.imageTool.family.flare": "gpt-image-2.6-flare만: 가장 빨라요",
  "own.imageTool.family.sunburst": "gpt-image-2.6-sunburst만: 정밀한 편집과 고품질",
  "own.imageTool.family.gpt-image-2": "gpt-image-2만: Codex CLI 기본과 같아요",
  "own.imageTool.price":
    "100만 토큰당 글 입력 $5(캐시 $1.25), 이미지 입력 $8(캐시 $2), 이미지 출력 $30이에요. 세 모델 모두 같아요. 2026-11-06 OpenAI 요금표 기준이에요.",
  "own.imageTool.quality": "기본 품질",
  "own.imageTool.size": "기본 크기",
  "own.imageTool.auto": "자동",
  "own.imageTool.quality.low": "낮음 (가장 싸요)",
  "own.imageTool.quality.medium": "중간",
  "own.imageTool.quality.high": "높음",
  "own.imageTool.keys": "OpenAI API 키 순서",
  "own.imageTool.useKeys": "API 키 쓰기",
  "own.imageTool.useKeys.off":
    "꺼 두면 API 키는 하나도 쓰지 않고 바로 Codex 구독으로 만들어요. 키마다 켜고 끄려면 켠 채로 아래 체크를 써요.",
  "own.imageTool.keys.lead":
    "위에서부터 써요. 잔액이나 한도가 바닥났다는 답(insufficient_quota 같은)을 받은 키는 6시간 동안 건너뛰고 다음 키로 넘어가요. 일시적인 요청 제한은 같은 키로 다시 시도해요.",
  "own.imageTool.keys.none": "아직 OpenAI API 키 계정이 없어요.",
  "own.imageTool.keys.add": "OpenAI API 키 추가",
  "own.imageTool.keys.use": "이미지에 쓰기",
  "own.imageTool.keys.up": "위로",
  "own.imageTool.keys.down": "아래로",
  "own.imageTool.keys.exhausted": "바닥남 ({code}, {at}에 확인)",
  "own.imageTool.keys.clear": "다시 쓰기",
  "own.imageTool.keys.notReady": "쓸 수 없는 상태",
  "own.imageTool.codex": "Codex 구독으로 대신 만들기",
  "own.imageTool.codex.lead":
    "키가 모두 바닥나면 ChatGPT 구독 계정으로 만들어요. 남은 한도가 많은 계정부터 쓰고, 모델은 Codex가 정해요(지금은 gpt-image-2). 구독 한도에서 차감돼요.",
  "own.imageTool.codex.terms":
    "여러 구독 계정을 번갈아 써서 한도를 피하는 건 OpenAI 이용 약관에 어긋날 수 있어요. 쓸지는 직접 정해 주세요.",
  "own.imageTool.codex.used": "{percent}% 사용",
  "own.imageTool.codex.limited": "한도에 닿음",
  "own.imageTool.codex.none": "ChatGPT 구독 계정이 없어요.",
  "own.imageTool.saved": "저장했어요.",
} as const satisfies Record<string, string>

export type ImageToolKey = keyof typeof imageToolKo

export const imageToolEn: Record<ImageToolKey, string> = {
  "own.imageTool.lead":
    "When on, the conversation's model makes images with a tool (image_generate), using your OpenAI API key accounts in the order below, and a ChatGPT subscription when every key is used up.",
  "own.imageTool.toggle": "Give models the image tool",
  "own.imageTool.default": "Off by default.",
  "own.imageTool.cost":
    "Turning it on or off changes every conversation's tool list, so each conversation's next request writes its cache once again. Every image costs what that image model charges.",
  "own.imageTool.shared":
    "Stored in this PC's service, so it applies to every window, device and SSH remote host alike.",
  "own.imageTool.on": "On. The tool is listed from the next request.",
  "own.imageTool.off": "Off. The tool leaves the list from the next request.",
  "own.imageTool.readOnly": "This device cannot change it. Change it in the app window on the PC.",
  "own.imageTool.unknown": "This service does not know this setting yet. Restart the service on the new version.",
  "own.imageTool.model": "Model (API keys)",
  "own.imageTool.family.auto": "gpt-image-2.6 auto (recommended): the AI picks Flare or Sunburst for each image",
  "own.imageTool.family.flare": "gpt-image-2.6-flare only: the fastest",
  "own.imageTool.family.sunburst": "gpt-image-2.6-sunburst only: precise edits and high fidelity",
  "own.imageTool.family.gpt-image-2": "gpt-image-2 only: as Codex CLI's default",
  "own.imageTool.price":
    "Per 1M tokens: text input $5 (cached $1.25), image input $8 (cached $2), image output $30, the same for all three models. OpenAI's price list of 2026-11-06.",
  "own.imageTool.quality": "Default quality",
  "own.imageTool.size": "Default size",
  "own.imageTool.auto": "Auto",
  "own.imageTool.quality.low": "Low (cheapest)",
  "own.imageTool.quality.medium": "Medium",
  "own.imageTool.quality.high": "High",
  "own.imageTool.keys": "OpenAI API key order",
  "own.imageTool.useKeys": "Use API keys",
  "own.imageTool.useKeys.off":
    "Off, no API key is used at all and images go straight to a Codex subscription. To switch keys one by one, keep it on and use the checks below.",
  "own.imageTool.keys.lead":
    "Used from the top. A key answered with no money or quota (such as insufficient_quota) is skipped for 6 hours and the next key is used. A plain rate limit is retried on the same key.",
  "own.imageTool.keys.none": "No OpenAI API key account yet.",
  "own.imageTool.keys.add": "Add an OpenAI API key",
  "own.imageTool.keys.use": "Use for images",
  "own.imageTool.keys.up": "Up",
  "own.imageTool.keys.down": "Down",
  "own.imageTool.keys.exhausted": "Used up ({code}, seen {at})",
  "own.imageTool.keys.clear": "Use again",
  "own.imageTool.keys.notReady": "Not usable",
  "own.imageTool.codex": "Make it with a Codex subscription instead",
  "own.imageTool.codex.lead":
    "When every key is used up, a ChatGPT subscription account makes the image, the one with the most remaining limit first; Codex picks the model (gpt-image-2 now). It counts against the plan's limits.",
  "own.imageTool.codex.terms":
    "Rotating several subscription accounts to get around limits can conflict with OpenAI's terms. It's your choice.",
  "own.imageTool.codex.used": "{percent}% used",
  "own.imageTool.codex.limited": "At its limit",
  "own.imageTool.codex.none": "No ChatGPT subscription account.",
  "own.imageTool.saved": "Saved.",
}

export const imageToolText = catalogText(imageToolKo, imageToolEn)

export function useImageToolText() {
  return useCatalogText(imageToolText)
}
