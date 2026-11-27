// Strings of the effort and subagent-role fixes of 2026-11-08 (07 §2.3 추론 강도와 강도 고정, §2.4 역할 안내; decisions
// PE): a model pool entry's one `추론 강도` choice (an effort the conversation may change, or a fixed level), the help
// lines of the role efforts and the preset's `강도 고정`, and the subagent role guide of the editor's 자세히, 설정 >
// 프리셋 and 설정 > 에이전트 방식. Only lazy screens import this file, so none of it is in the first chunk (PF5).
import type { Preset } from "@own/protocol/preset"
import { featureText } from "@/queue/text"

export const presetEffortKo = {
  "own.pe.effort": "추론 강도",
  "own.pe.flexible": "평소 강도 · 대화가 바꿀 수 있어요",
  "own.pe.fixed": "고정 · 대화가 바꾸지 못해요",
  "own.pe.fixedLevel": "{level} 고정",
  "own.pe.flexibleHint": "평소에 쓰는 강도예요. 대화가 하위 에이전트를 부를 때마다 올리거나 내릴 수 있어요.",
  "own.pe.fixedHint": "언제나 {level}(으)로 돌아요. 대화가 다른 강도를 적어도 바꾸지 않아요.",
  "own.pe.presetFixed": "이 프리셋의 강도 고정({level})이 먼저라 지금은 {level}(으)로 돌아요.",
  "own.pe.rolesHint":
    "역할마다 하위 에이전트가 평소에 쓰는 강도예요. 대화가 부를 때마다 올리거나 내릴 수 있고, 아래 '강도 고정'을 고르면 그 값이 먼저예요.",
  "own.pe.noLevels": "이 모델은 추론 강도 단계가 없어서 강도 없이 돌아요.",
  "own.pe.noLevelsCompat":
    "이 모델의 추론 강도 단계를 몰라요. 설정 > 계정에서 이 계정의 '모델 기능…' → '추론 강도'를 정하면 여기서 고를 수 있어요.",
  "own.pe.roles": "하위 에이전트 역할",
  "own.pe.rolesNote":
    "메인은 일을 나눠 맡길 때 아래 역할 가운데 하나를 골라요. 하위 에이전트는 사용자에게 묻거나 다른 하위 에이전트를 또 부르지 않아요.",
  "own.pe.rolesFor": "'{preset}' 기준",
  "own.pe.role.explore": "코드와 파일을 빠르게 찾아 읽어요. 메인이 어디에 무엇이 있는지 알아봐야 할 때 맡겨요.",
  "own.pe.role.general": "메인처럼 여러 단계의 일을 해요. 서로 떨어진 일을 나란히 처리할 때 맡겨요.",
  "own.pe.role.own-review":
    "코드·계획·결과를 따로 한 번 더 봐요. 메인이 독립된 검토가 필요할 때 맡기고, 고칠 점을 알려 줄 뿐 직접 고치지 않아요.",
  "own.pe.role.own-quick": "작은 조회, 단순한 수정, 짧은 확인 같은 빠르고 쉬운 일을 맡아요.",
  "own.pe.role.own-deep": "깊이 생각해야 하는 어려운 문제를 맡아요.",
  "own.pe.access.search": "읽고 찾기만 해요. 파일을 고치거나 명령을 실행하지 않아요.",
  "own.pe.access.review": "파일을 고치지 않아요. 명령은 대화의 승인 모드를 따라요.",
  "own.pe.access.full": "파일 편집과 명령 실행까지 메인과 같은 도구를 써요. 대화의 승인 모드를 따라요.",
  "own.pe.unnamed": "이 프리셋의 안내문에 없어서 메인이 따로 고르지 않아요.",
  "own.pe.off": "나눠 맡기기가 '안 함'이라 메인이 하위 에이전트를 쓰지 않아요.",
  "own.pe.runs": "지금: {model} @ {account} · {effort}",
  "own.pe.runsNoMain": "메인 모델을 알면 어디서 도는지 보여요.",
  "own.pe.effortDefault": "기본(강도를 보내지 않음)",
  "own.pe.effortFixed": "{level} 고정",
  "own.pe.source.main": "메인과 같게",
  "own.pe.source.role": "프리셋의 역할 대상",
  "own.pe.source.fallback": "대상을 쓸 수 없어 메인으로",
  "own.pe.source.single": "프리셋이 정한 한 곳",
  "own.pe.source.poolDefault": "모델 묶음의 기본 규칙 · 메인이 다른 모델을 고를 수 있어요",
  "own.pe.source.poolMain": "모델 묶음에서 메인이 고르고, 안 고르면 메인과 같게",
  "own.pe.harnessRoles": "어떤 모델과 추론 강도로 도는지는 설정 > 프리셋에서 프리셋마다 정해요.",
} as const

export type PresetEffortKey = keyof typeof presetEffortKo

export const presetEffortEn: Partial<Record<PresetEffortKey, string>> = {
  "own.pe.effort": "Reasoning effort",
  "own.pe.flexible": "Usual effort · the conversation may change it",
  "own.pe.fixed": "Fixed · the conversation cannot change it",
  "own.pe.fixedLevel": "{level}, fixed",
  "own.pe.flexibleHint":
    "The effort it usually runs at. The conversation may raise or lower it for each subagent call.",
  "own.pe.fixedHint": "Always runs at {level}. A different effort the conversation asks for is not used.",
  "own.pe.presetFixed": "This preset's fixed effort ({level}) comes first, so it runs at {level} now.",
  "own.pe.rolesHint":
    "The effort each role's subagents usually run at. The conversation may raise or lower it per call; the preset's fixed effort below comes first.",
  "own.pe.noLevels": "This model has no effort levels; it runs without one.",
  "own.pe.noLevelsCompat":
    "This model's effort levels are not known. Set them under Settings > Accounts, the account's 'Model capabilities…' > 'Reasoning effort', to choose one here.",
  "own.pe.roles": "Subagent roles",
  "own.pe.rolesNote":
    "When the main hands off work it picks one of these roles. Subagents never ask you questions or start subagents of their own.",
  "own.pe.rolesFor": "With '{preset}'",
  "own.pe.role.explore": "Finds and reads code and files fast, when the main needs to know where something is.",
  "own.pe.role.general": "Works through multi-step tasks like the main, for separate pieces of work in parallel.",
  "own.pe.role.own-review":
    "Takes an independent second look at code, plans or results; reports what to fix and never edits.",
  "own.pe.role.own-quick": "Quick, simple tasks: small lookups, mechanical edits and short checks.",
  "own.pe.role.own-deep": "Hard problems that need deeper reasoning.",
  "own.pe.access.search": "Reads and searches only. Never edits files or runs commands.",
  "own.pe.access.review": "Never edits files. Commands follow the conversation's approval mode.",
  "own.pe.access.full": "The main's tools, file edits and commands included, under the conversation's approval mode.",
  "own.pe.unnamed": "This preset's guidance does not name it, so the main does not pick it on its own.",
  "own.pe.off": "Delegation is off, so the main does not use subagents.",
  "own.pe.runs": "Now: {model} @ {account} · {effort}",
  "own.pe.runsNoMain": "Shown once the main model is known.",
  "own.pe.effortDefault": "Default (no effort sent)",
  "own.pe.effortFixed": "{level}, fixed",
  "own.pe.source.main": "Same as main",
  "own.pe.source.role": "The preset's role target",
  "own.pe.source.fallback": "Its targets cannot run, so the main",
  "own.pe.source.single": "The preset's one target",
  "own.pe.source.poolDefault": "The model pool's default rule · the main may pick another model",
  "own.pe.source.poolMain": "The main picks from the model pool, else same as main",
  "own.pe.harnessRoles": "Which model and effort each role runs on is set per preset under Settings > Presets.",
}

/** Each role's one-line purpose (07 §2.4); a new role fails the type check until it has one. */
export const ROLE_PURPOSE: Readonly<Record<Preset.Role, PresetEffortKey>> = {
  explore: "own.pe.role.explore",
  general: "own.pe.role.general",
  "own-review": "own.pe.role.own-review",
  "own-quick": "own.pe.role.own-quick",
  "own-deep": "own.pe.role.own-deep",
}

export const presetEffortText = featureText(presetEffortKo, presetEffortEn)
export const usePresetEffortText = presetEffortText.use
