// 설정 > 출력 상한 (03 §5.7.4, 02 §4.9): the page's words, a catalog of its own so they load with the page, not in the
// first chunk. Same rules as the projects catalog. The numbers come from `@own/protocol` OutputLimit ({claude}, {ds},
// {min}, {max}, {cap}), so the text and the service agree.
import { catalogText, useCatalogText } from "@/projects/text"

export const outputLimitKo = {
  "own.output.lead": "한 번 답할 때 생각과 답을 합쳐 넘지 않을 양이에요. 문맥 창(읽을 수 있는 양)과는 달라요.",
  "own.output.choice": "출력 상한",
  "own.output.cap": "이 값을 넘기지 않기",
  "own.output.capNote":
    "모델이 한 번에 쓸 수 있는 양이 이보다 작으면 그만큼, 대화가 문맥 창을 거의 채웠으면 남은 자리만큼만 보내요.",
  "own.output.max": "최대",
  "own.output.unit": "토큰",
  "own.output.field": "출력 상한 토큰 수",
  "own.output.default": "기본",
  "own.output.omit": "출력 상한 보내지 않기",
  "own.output.omitNote": "모델이나 회사가 정한 기본값에 맡겨요.",
  "own.output.omitClaude":
    "Claude는 회사 API가 값을 꼭 요구해서 {claude}을 보내요. 모델 최대나 남은 자리가 더 작으면 그만큼만 보내요.",
  "own.output.omitDeepSeek":
    "DeepSeek는 생각을 켜면 서버 기본값(64K, 노력 최대는 128K)을 써요. 생각을 끄면 서버 기본값 8K가 너무 짧아 {ds}을 보내요.",
  "own.output.omitOthers": "그 밖의 회사와 직접 붙인 서버는 그쪽 기본값을 써요.",
  "own.output.never":
    "ChatGPT 구독·OpenAI API 키·OpenRouter에는 어느 쪽이든 보내지 않아요. ChatGPT는 값을 받지 않고, OpenAI와 OpenRouter는 요청한 양만큼 한도나 잔액을 미리 잡기 때문이에요.",
  "own.output.compaction":
    "대화 요약(자동 압축)은 어느 쪽이든 32,000을 넘기지 않고, 제목 만들기 같은 작은 요청은 회사 기본값을 써요.",
  "own.output.cache":
    "바꿔도 보내는 대화 내용은 그대로라 캐시가 깨지지 않아요. 다만 생각 예산을 직접 정하는 Claude 모델(4.5 이하)은 예산이 이 값의 절반을 넘지 못해서, 그런 대화는 다음 요청에서 캐시를 한 번 다시 써요.",
  "own.output.shared": "이 PC의 서비스에 저장돼서 모든 창과 기기, SSH 원격 호스트의 대화에 같이 적용돼요.",
  "own.output.save": "저장",
  "own.output.reset": "기본으로",
  "own.output.saved": "저장했어요. 다음 요청부터 적용돼요.",
  "own.output.resetDone": "기본값({cap}을 넘기지 않기)으로 되돌렸어요.",
  "own.output.range": "{min}에서 {max} 사이의 숫자로 넣어 주세요.",
  "own.output.readOnly": "이 기기에서는 바꿀 수 없어요. PC의 앱 창에서 바꿔 주세요.",
  "own.output.unknown": "이 서비스는 이 설정을 아직 몰라요. 서비스를 새 버전으로 다시 시작하세요.",
} as const satisfies Record<string, string>

export type OutputLimitKey = keyof typeof outputLimitKo

export const outputLimitEn: Partial<Record<OutputLimitKey, string>> = {
  "own.output.lead":
    "The most one reply may write, thinking and answer together. It is not the context window (how much the model can read).",
  "own.output.choice": "Output limit",
  "own.output.cap": "Do not go over this value",
  "own.output.capNote":
    "When the model can write less in one reply, or the conversation has nearly filled the context window, less is sent.",
  "own.output.max": "Up to",
  "own.output.unit": "tokens",
  "own.output.field": "Output limit in tokens",
  "own.output.default": "Default",
  "own.output.omit": "Send no output limit",
  "own.output.omitNote": "The model's or the provider's default applies.",
  "own.output.omitClaude":
    "Claude's API requires a value, so {claude} is sent; less when the model's maximum or the room left is smaller.",
  "own.output.omitDeepSeek":
    "DeepSeek uses its server default with thinking on (64K, 128K at maximum effort). With thinking off its 8K default is too short, so {ds} is sent.",
  "own.output.omitOthers": "Other providers and servers you added use their own default.",
  "own.output.never":
    "ChatGPT subscriptions, OpenAI API keys and OpenRouter never get one: ChatGPT does not accept it, and OpenAI and OpenRouter hold the requested amount against your limits or balance.",
  "own.output.compaction":
    "Conversation summaries (auto compaction) stay at 32,000 or less either way; small requests such as titles use the provider's default.",
  "own.output.cache":
    "A change keeps what is sent the same, so the cache stays. Claude models with a set thinking budget (4.5 and older) keep the budget under half of this value, so such a conversation writes its cache once more.",
  "own.output.shared":
    "Kept on this PC's service, so every window and device and the conversations on SSH hosts use the same value.",
  "own.output.save": "Save",
  "own.output.reset": "Use default",
  "own.output.saved": "Saved. It applies from the next request.",
  "own.output.resetDone": "Back to the default (do not go over {cap}).",
  "own.output.range": "Type a number from {min} to {max}.",
  "own.output.readOnly": "This device cannot change it. Change it in the app window on the PC.",
  "own.output.unknown": "This service does not know this setting yet. Restart the service on the new version.",
}

export const outputLimitText = catalogText(outputLimitKo, outputLimitEn)

export function useOutputLimitText() {
  return useCatalogText(outputLimitText)
}
