// 설정 > 자동 압축 > 자리를 비운 사이 압축 (02 §4.7.7, CC 2026-10-24): the section's words, a catalog of its own so
// they load with the settings page, not in the first chunk. {minutes} and {tokens} come from `CompactionCache.IDLE` and the
// stored setting, so the text and the service agree.
import { catalogText, useCatalogText } from "@/projects/text"

export const idleCompactionKo = {
  "own.idle.title": "자리를 비운 사이 압축",
  "own.idle.off": "끄기",
  "own.idle.on": "켜기",
  "own.idle.lead":
    "자리를 비운 동안 캐시가 식기 30초 전에 대화를 압축해요. 돌아와서 보내는 첫 요청이 대화 전체를 다시 쓰지 않고 요약과 최근 대화만 새로 써요. 기본은 꺼져 있어요.",
  "own.idle.when":
    "문맥이 {tokens} 토큰 이상이고 {minutes}분 넘게 아무 일이 없을 때만 해요. 대화마다 캐시 한 번에 한 번이에요.",
  "own.idle.present":
    "화면에 띄워 두고 최근에 만진 대화는 읽는 중으로 보고 하지 않아요. 창을 숨기거나 마지막으로 만진 뒤 {minutes}분이 지나야 자리를 비운 것으로 봐요.",
  "own.idle.presentOff":
    "자리 비움 감지(policy.json의 awayDetect)가 꺼져 있어서, 화면에 띄워 둔 대화도 아무 일이 없는 시간만 보고 압축해요.",
  "own.idle.skip":
    "하위 작업 대화, 하위 에이전트가 아직 일하는 대화, 팀 대화, 가져온 대화, 되돌리기를 확정하지 않은 대화, 대기 중인 메시지나 승인 질문이 있는 대화, 한도를 80% 넘게 쓴 구독 계정은 건너뛰어요. 실패하면 대체 모델이나 코드 요약 없이 대화를 그대로 둬요.",
  "own.idle.ttlTitle": "회사별 캐시 시간",
  "own.idle.ttl.oai": "OpenAI API 키(GPT-5.6 이후)",
  "own.idle.ttl.oaiValue": "30분 · 약 29분 30초 뒤에 압축",
  "own.idle.ttl.anth": "Anthropic API 키 · Claude 구독",
  "own.idle.ttl.anthValue": "5분 · 지금은 안 함",
  "own.idle.ttl.anthNote":
    "5분 캐시는 {minutes}분 자리 비움 조건을 채우지 못해요. 1시간 캐시 모드(예정)가 생기면 약 59분 30초 뒤에 압축해요.",
  "own.idle.ttl.codex": "ChatGPT 구독 · Sign in with ChatGPT",
  "own.idle.ttl.codexValue": "안 함 · 캐시가 언제 식는지 아직 몰라요",
  "own.idle.ttl.ds": "DeepSeek",
  "own.idle.ttl.dsValue": "안 함 · 캐시 보장이 없고 다시 읽기가 싸요",
  "own.idle.ttl.others": "OpenAI GPT-5.5 이하 · OpenRouter · xAI · 직접 붙인 서버",
  "own.idle.ttl.othersValue": "안 함 · 캐시가 더 오래 남을 수 있어요",
  "own.idle.clock": "캐시 시간은 마지막 요청을 보낸 때부터 재요. 답을 만드는 시간도 그 안에 들어가요.",
  "own.idle.breakEven":
    "손익: 압축 한 번 값이 돌아왔을 때 아끼는 값보다 작으면 이득이에요. 예를 들어 Opus 5.5에서 문맥 200k면 압축이 약 $0.13이고, 돌아와서 첫 요청이 $1.00에서 $0.18로 줄어요. 돌아올 확률이 16%를 넘으면 이득이에요(600k면 8%, gpt-6-astra 200k면 21%).",
  "own.idle.cost":
    "돌아오지 않으면 압축 값만 써요. 돌아오면 앞부분이 원문 대신 요약으로 바뀌어 있어요. 대화 기록은 화면에 그대로 남아요.",
  "own.idle.saved": "저장했어요.",
  "own.idle.readOnly": "이 기기에서는 바꿀 수 없어요. PC의 앱 창에서 바꿔 주세요.",
} as const satisfies Record<string, string>

export type IdleCompactionKey = keyof typeof idleCompactionKo

export const idleCompactionEn: Partial<Record<IdleCompactionKey, string>> = {
  "own.idle.title": "Compact while you are away",
  "own.idle.off": "Off",
  "own.idle.on": "On",
  "own.idle.lead":
    "While you are away, a conversation is compacted 30 seconds before its cache cools. The first request after you return then writes only the summary and the recent messages, not the whole conversation. Off by default.",
  "own.idle.when":
    "Only when the context is at least {tokens} tokens and nothing has happened for more than {minutes} minutes. Once per cache in each conversation.",
  "own.idle.present":
    "A conversation shown on a screen you touched lately counts as being read and is left alone; it counts as away once the window has been hidden, or not touched, for {minutes} minutes.",
  "own.idle.presentOff":
    "Away detection (awayDetect in policy.json) is off, so a conversation on screen is compacted by the idle time alone.",
  "own.idle.skip":
    "Skipped for subagent conversations, a conversation whose subagents are still working, team and imported conversations, a conversation with an unconfirmed revert, a queued message or an approval question, and subscription accounts above 80% of their limit. When it fails the conversation stays as it was, with no stand-in model or code summary.",
  "own.idle.ttlTitle": "Cache lifetime by provider",
  "own.idle.ttl.oai": "OpenAI API key (GPT-5.6 and later)",
  "own.idle.ttl.oaiValue": "30 min · compacts after about 29 min 30 s",
  "own.idle.ttl.anth": "Anthropic API key · Claude subscription",
  "own.idle.ttl.anthValue": "5 min · not for now",
  "own.idle.ttl.anthNote":
    "A 5-minute cache never meets the {minutes}-minute absence. With the 1-hour cache mode (planned) it would compact after about 59 min 30 s.",
  "own.idle.ttl.codex": "ChatGPT subscription · Sign in with ChatGPT",
  "own.idle.ttl.codexValue": "Never · when the cache cools is not known yet",
  "own.idle.ttl.ds": "DeepSeek",
  "own.idle.ttl.dsValue": "Never · no cache guarantee, and reading again is cheap",
  "own.idle.ttl.others": "OpenAI GPT-5.5 and older · OpenRouter · xAI · your own servers",
  "own.idle.ttl.othersValue": "Never · the cache may last longer",
  "own.idle.clock": "The lifetime counts from when the last request was sent; writing the reply counts against it.",
  "own.idle.breakEven":
    "Break-even: it pays when one compaction costs less than what it saves on your return. With Opus 5.5 at 200k, for example, the compaction is about $0.13 and the first request after you return drops from $1.00 to $0.18, so it pays once you return more than 16% of the time (8% at 600k, 21% for gpt-6-astra at 200k).",
  "own.idle.cost":
    "If you do not return, only the compaction is paid. If you do, the earlier part is a summary instead of the messages; the history stays on screen.",
  "own.idle.saved": "Saved.",
  "own.idle.readOnly": "This device cannot change it. Change it in the app window on the PC.",
}

export const idleCompactionText = catalogText(idleCompactionKo, idleCompactionEn)

export function useIdleCompactionText() {
  return useCatalogText(idleCompactionText)
}
