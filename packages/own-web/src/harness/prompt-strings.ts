// 설정 > 에이전트 방식 strings (10 §3.11, harness/prompt-page.tsx): what each 에이전트 방식 sends, own's changes and
// 내 지시문. Only the lazy page reads them, so they stay out of the shared catalogs and the first chunk (PF5). The
// harness pill's and the settings list's words stay src/i18n keys (`own.harness.prompt.*`, `own.settings.harness*`).
import { featureText } from "@/queue/text"

export const promptsKo = {
  "own.prompts.intro":
    "에이전트 방식마다 모델에게 보내는 지시문이에요. 원본은 그 도구가 보내는 그대로, 개선판은 이 앱에 맞게 고친 판, 내 지시문은 내가 고친 판이에요. 새 대화의 처음 값은 설정 > 일반에서 정해요.",
  "own.prompts.harness": "에이전트 방식",
  "own.prompts.variant": "지시문",
  "own.prompts.model": "모델",
  "own.prompts.mode": "승인 모드",
  "own.prompts.examples": "쓸 수 있는 모델이 없어서 예시 모델로 보여요.",
  "own.prompts.opencode":
    "OpenCode 기본은 OpenCode가 만든 지시문을 그대로 보내요. 이 앱이 고친 곳도, 고를 지시문도 없어요.",
  "own.prompts.claudeCode":
    "Claude Agent 기본은 Claude Agent 계정의 모델에 Claude Code가 보내는 지시문을 그대로 보내고, 그 뒤에 OpenCode의 에이전트 역할과 지시문을 붙여요. 고를 지시문도, 이 앱이 고친 곳도 없어요. 다른 계정의 모델에서는 OpenCode 기본처럼 일해요.",
  "own.prompts.unavailable": "이 서비스에서는 지시문을 볼 수 없어요.",
  "own.prompts.failed": "지시문을 불러오지 못했어요",
  "own.prompts.retry": "다시 시도",
  "own.prompts.tier.catalog": "Codex 목록에 있는 GPT 모델이에요. 개선판도 원본과 같은 글을 보내요.",
  "own.prompts.tier.lean":
    "짧은 지시문을 받는 모델이에요(Claude Opus 4.8 이후, Fable, Mythos). 개선판은 이 앱이 새로 쓴 짧은 글을 보내요.",
  "own.prompts.tier.fallback": "Codex 목록에 없는 모델이에요. 개선판은 Codex의 대체 지시문에서 몇 곳을 고쳐 보내요.",
  "own.prompts.tier.pi": "Pi 방식은 모든 모델에 같은 글을 보내요.",
  "own.prompts.tier.dsh":
    "DeepSeek 방식은 모든 모델에 같은 글을 보내요. 사용자 메시지 칸은 사용자의 첫 메시지 뒤에 이 앱이 덧붙이는 글이에요.",
  "own.prompts.customMissing": "아직 저장한 내 지시문이 없어서 개선판을 보여요. 아래에서 만들어요.",
  "own.prompts.pickCustom": "이 글을 고쳐 쓰려면 지시문에서 내 지시문을 골라요.",
  "own.prompts.sent.title": "보내는 글",
  "own.prompts.sent.note":
    "빈 대화의 첫 요청에 들어가는 글이에요. 실제 대화에는 AGENTS.md, 스킬 목록, Code Mode 도구 목록, MCP 안내가 더해져요.",
  "own.prompts.search": "글에서 찾기",
  "own.prompts.search.count": "{count}곳",
  "own.prompts.search.none": "찾는 글이 없어요",
  "own.prompts.copyAll": "전체 복사",
  "own.prompts.copy": "복사",
  "own.prompts.copied": "복사했어요",
  "own.prompts.copyFailed": "복사하지 못했어요",
  "own.prompts.chars": "{count}자",
  "own.prompts.editable": "내 지시문으로 바꿀 수 있어요",
  "own.prompts.generated": "이 앱이 만들어요",
  "own.prompts.role.system": "시스템 글",
  "own.prompts.role.developer": "developer 메시지",
  "own.prompts.role.user": "첫 사용자 메시지",
  "own.prompts.part.base": "기본 지시문",
  "own.prompts.part.identity": "모델 이름",
  "own.prompts.part.permissions": "승인 모드 설명",
  "own.prompts.part.collaboration": "협업 모드",
  "own.prompts.part.agents": "멀티 에이전트 안내",
  "own.prompts.part.context": "덧붙인 안내",
  "own.prompts.part.agents-md": "AGENTS.md",
  "own.prompts.part.environment": "작업 환경",
  "own.prompts.part.preamble": "첫 문단",
  "own.prompts.part.tools": "도구 목록",
  "own.prompts.part.rules": "규칙",
  "own.prompts.part.addendum": "덧붙인 안내",
  "own.prompts.part.project": "프로젝트 지시문",
  "own.prompts.part.skills": "스킬",
  "own.prompts.part.cwd": "작업 폴더",
  "own.prompts.part.harness": "dsh 소개",
  "own.prompts.part.persona": "모델 소개",
  "own.prompts.part.time": "시간 정보",
  "own.prompts.part.perConversation": "작업 폴더, 셸, 시간대는 대화마다 달라요. 실제 요청에는 날짜도 들어가요.",
  "own.prompts.tools.title": "도구 {count}개",
  "own.prompts.tools.note":
    "이 방식이 따로 보내는 도구예요. OpenCode의 다른 도구(질문, 웹 검색, Code Mode 등)도 그대로 함께 가요.",
  "own.prompts.changes.title": "고친 곳",
  "own.prompts.changes.reference": "원본은 그 도구가 보내는 그대로예요. 개선판은 이 모델에서 아래 {count}곳을 고쳐요.",
  "own.prompts.changes.own": "개선판은 이 모델에서 아래 {count}곳을 고쳐요.",
  "own.prompts.changes.custom.codex": "내 지시문은 기본 지시문만 바꿔요. 나머지 고친 곳은 개선판과 같아요.",
  "own.prompts.changes.custom.pi": "내 지시문은 첫 문단만 바꿔요. 나머지 고친 곳은 개선판과 같아요.",
  "own.prompts.changes.custom.dsh": "내 지시문은 모델 소개 줄만 바꿔요. 나머지 고친 곳은 개선판과 같아요.",
  "own.prompts.changes.none": "이 모델에는 고친 곳이 없어요. 개선판도 원본과 같은 글을 보내요.",
  "own.prompts.changes.others": "다른 모델에서 고치는 곳 {count}곳",
  "own.prompts.changes.before": "원본",
  "own.prompts.changes.after": "개선판",
  "own.prompts.changes.removed": "뺐어요",
  "own.prompts.changes.added": "원본에는 없어요",
  "own.prompts.custom.title": "내 지시문",
  "own.prompts.custom.note.codex":
    "내 지시문은 기본 지시문만 바꿔요. 승인 모드 설명, 도구, 작업 환경은 이 앱이 만들어요. 모든 모델에 같은 글이 가요.",
  "own.prompts.custom.note.pi":
    "내 지시문은 Pi 지시문의 첫 문단만 바꿔요. 도구 목록, 규칙, 작업 폴더는 이 앱이 만들어요. 모든 모델에 같은 글이 가요.",
  "own.prompts.custom.note.dsh":
    "내 지시문은 dsh 지시문의 모델 소개 줄만 바꿔요. 도구 안내, 실행 정보, 시간 정보는 이 앱이 만들어요. {{model}}은 대화 모델의 ID로 바뀌어요.",
  "own.prompts.custom.patch":
    "{slot} 자리에는 이 앱이 파일 고치는 방법을 넣어요. 지우면 모델이 패치 모양을 모를 수 있어요.",
  "own.prompts.custom.start": "{model}(이)가 받는 글을 복사해서 시작해요.",
  "own.prompts.custom.fromOwn": "개선판에서 시작",
  "own.prompts.custom.fromReference": "원본에서 시작",
  "own.prompts.custom.copyOwn": "개선판 글로 바꾸기",
  "own.prompts.custom.copyReference": "원본 글로 바꾸기",
  "own.prompts.custom.label": "내 지시문 글",
  "own.prompts.custom.count": "{count} / {limit}자",
  "own.prompts.custom.save": "저장",
  "own.prompts.custom.saved": "내 지시문을 저장했어요",
  "own.prompts.custom.unsaved": "저장하지 않은 고친 내용이 있어요",
  "own.prompts.custom.discard": "고친 내용 버리기",
  "own.prompts.custom.cache":
    "다음 요청부터 바뀌어요. 내 지시문을 쓰는 대화는 그때 대화 앞부분 캐시를 한 번 새로 써요.",
  "own.prompts.custom.use":
    "대화에 쓰려면 대화 머리줄의 에이전트 방식 알약에서 내 지시문을 골라요. 새 대화의 처음 값은 설정 > 일반에서 정해요.",
  "own.prompts.custom.reset": "기본으로 되돌리기",
  "own.prompts.custom.resetTitle": "내 지시문을 지울까요?",
  "own.prompts.custom.resetBody":
    "{harness}의 내 지시문을 지워요. 내 지시문을 고른 대화와 새 대화는 다음 요청부터 개선판으로 일해요.",
  "own.prompts.custom.resetConfirm": "지우기",
  "own.prompts.custom.resetDone": "내 지시문을 지웠어요. 내 지시문을 고른 대화는 개선판으로 일해요.",
  "own.prompts.custom.empty": "글이 비어 있어요",
  "own.prompts.custom.tooLong": "{limit}자까지 쓸 수 있어요",
  "own.prompts.custom.failed": "내 지시문을 저장하지 못했어요",
  "own.prompts.custom.readOnly": "PC의 앱 창에서 고칠 수 있어요.",
  "own.prompts.changes.more": "자세히",
  "own.prompts.changes.moreLabel": "{title}: 설명서에서 자세히 보기",
  "own.prompts.compare": "비교",
  "own.prompts.compare.title.reference": "원본과 개선판 비교",
  "own.prompts.compare.title.custom": "개선판과 내 지시문 비교",
  "own.prompts.compare.note.reference":
    "부분마다 왼쪽이 원본, 오른쪽이 개선판이에요. 좁은 창에서는 위아래로 쌓여요. 다른 곳은 색으로 칠하고, 원본에서 빠진 곳에는 취소선을, 개선판에 더한 곳에는 밑줄을 그어요. 바뀐 곳 아래에 고친 까닭을 적어요. 달라진 줄바꿈과 띄어쓰기, 보이지 않는 문자는 ⏎, ·, ␍, ⍽ 같은 기호로 보여요.",
  "own.prompts.compare.note.custom":
    "부분마다 왼쪽이 개선판, 오른쪽이 저장한 내 지시문이에요. 좁은 창에서는 위아래로 쌓여요. 다른 곳은 색으로 칠하고, 개선판에서 빠진 곳에는 취소선을, 내 지시문에 더한 곳에는 밑줄을 그어요. 달라진 줄바꿈과 띄어쓰기, 보이지 않는 문자는 ⏎, ·, ␍, ⍽ 같은 기호로 보여요.",
  "own.prompts.compare.summary": "다른 부분 {changed}개, 같은 부분 {same}개",
  "own.prompts.compare.summaryTools": "다른 도구 {changed}개, 같은 도구 {same}개",
  "own.prompts.compare.failed": "비교할 다른 글을 불러오지 못했어요",
  "own.prompts.compare.identical": "두 글이 같아요.",
  "own.prompts.compare.noCustom": "저장한 내 지시문이 없어서 개선판과 같아요. 위에서 만들어요.",
  "own.prompts.compare.same": "같음",
  "own.prompts.compare.sameParts": "같은 부분 {count}개",
  "own.prompts.compare.partCount": "{name} {count}개",
  "own.prompts.compare.runs": "다른 곳 {count}곳",
  "own.prompts.compare.side.reference": "원본",
  "own.prompts.compare.side.own": "개선판",
  "own.prompts.compare.side.custom": "내 지시문",
  "own.prompts.compare.missing.reference": "원본에는 없어요",
  "own.prompts.compare.missing.own": "개선판에는 없어요",
  "own.prompts.compare.missing.custom": "내 지시문에는 없어요",
  "own.prompts.compare.noLines": "이 자리에는 줄이 없어요",
  "own.prompts.compare.whitespace.lines": "줄 끝·빈 줄만 달라요",
  "own.prompts.compare.whitespace.spaces": "띄어쓰기·줄바꿈만 달라요",
  "own.prompts.compare.whitespace.invisible": "보이지 않는 문자만 달라요",
  "own.prompts.compare.sr.del": "삭제 시작",
  "own.prompts.compare.sr.delEnd": "삭제 끝",
  "own.prompts.compare.sr.ins": "추가 시작",
  "own.prompts.compare.sr.insEnd": "추가 끝",
  "own.prompts.compare.sr.breaks": "줄바꿈 {count}개",
  "own.prompts.compare.sr.spaces": "띄어쓰기 {count}개",
  "own.prompts.compare.sr.tabs": "탭 {count}개",
  "own.prompts.compare.sr.returns": "CR 문자 {count}개",
  "own.prompts.compare.sr.nbsp": "줄바꿈 없는 공백 {count}개",
  "own.prompts.compare.sr.wide": "전각 공백 {count}개",
  "own.prompts.compare.sr.zero": "폭 없는 문자 {count}개",
  "own.prompts.compare.sr.soft": "소프트 하이픈 {count}개",
  "own.prompts.compare.sr.nel": "다음 줄 문자 {count}개",
  "own.prompts.compare.sr.control": "제어 문자 {count}개",
  "own.prompts.compare.sr.bidi": "방향 제어 문자 {count}개",
  "own.prompts.compare.sr.variant": "이체 선택자 {count}개",
  "own.prompts.compare.sr.tag": "태그 문자 {count}개",
  "own.prompts.compare.sr.filler": "한글 채움 문자 {count}개",
  "own.prompts.compare.copy.reference": "원본 복사",
  "own.prompts.compare.copy.own": "개선판 복사",
  "own.prompts.compare.copy.custom": "내 지시문 복사",
  "own.prompts.compare.lines": "같은 줄 {count}개 보기",
  "own.prompts.compare.linesHide": "같은 줄 접기",
  "own.prompts.compare.tools": "도구 설명",
  "own.prompts.compare.toolsSame": "같은 도구 {count}개",
  "own.prompts.compare.elsewhere": "글에 보이지 않는 곳",
  "own.prompts.compare.elsewhereNote":
    "도구 인자나 대화마다 다른 Code Mode 도구 목록처럼 위 글에 드러나지 않게 고친 곳이에요.",
  "own.prompts.subagent.title": "하위 에이전트",
  "own.prompts.subagent.note":
    "메인 모델이 하위 에이전트에게 일을 맡길 때 무엇이 가고 무엇이 돌아오는지예요. 보기만 할 수 있어요.",
  "own.prompts.subagent.tool": "맡기는 도구",
  "own.prompts.subagent.agents":
    "설명에 붙은 Available subagents 목록은 새 대화의 기본 에이전트({agent})가 맡길 수 있는 역할이에요. 대화의 에이전트에 따라 달라져요.",
  "own.prompts.subagent.mcp":
    "Claude Agent 계정의 모델에는 MCP 도구 {name}(으)로 가요. Claude Code는 설명을 2,048자에서 자르기 때문에, 설명이 길면 하위 에이전트 목록을 앞으로 옮겨서 보내요.",
  "own.prompts.subagent.codemode":
    "이 모델은 Code Mode로 돌아서 Codex의 에이전트 도구(spawn_agent)를 받지 않아요. 그래서 OpenCode의 subagent 도구로 맡겨요.",
  "own.prompts.subagent.ask.original":
    "Codex의 원래 글이에요. 하위 에이전트에게 고친 파일 경로를 마지막 답에 적게 하고, 돌아오면 메인이 고친 것을 빠르게 검토하라고 해요.",
  "own.prompts.subagent.ask.fallback":
    "Codex의 글을 이 앱에 맞게 몇 곳 고친 글이에요. 원래 글처럼 하위 에이전트에게 고친 파일 경로를 마지막 답에 적게 하고, 돌아오면 메인이 그 파일을 빠르게 검토하라고 해요.",
  "own.prompts.subagent.ask.lean":
    "이 앱이 새로 쓴 짧은 글이에요. 고친 파일 목록이나 검토는 따로 묻지 않고, 맡길 때 돌려받을 결과를 적으라고만 해요.",
  "own.prompts.subagent.ask.v2": "협업 도구의 spawn_agent는 고친 파일 목록이나 검토를 따로 묻지 않아요.",
  "own.prompts.subagent.first": "새 하위 에이전트가 받는 첫 메시지",
  "own.prompts.subagent.parentText": "(메인 모델이 {field}에 쓴 글 그대로)",
  "own.prompts.subagent.first.core": "같은 하위 에이전트에게 이어서 맡기면(sessionID) 메인 모델이 쓴 글만 가요.",
  "own.prompts.subagent.first.codex-v1":
    "앞에 붙는 줄 없이 메인 모델이 쓴 글이 그대로 가요. 대화 전체를 물려주면(fork_context) 메인 대화가 그 앞에 와요.",
  "own.prompts.subagent.first.codex-v2":
    "Codex의 작업 메시지 모양으로 가요. fork_turns를 빼거나 all로 두면 메인 대화 전체가 그 앞에 와요.",
  "own.prompts.subagent.sends": "따로 붙는 지시",
  "own.prompts.subagent.extra.none":
    "이 밖에 하위 에이전트에게 따로 붙는 지시는 없어요. 하위 에이전트도 메인과 같은 에이전트 방식의 지시문, AGENTS.md, 스킬을 받아요.",
  "own.prompts.subagent.extra.codex-v2":
    "Codex가 하위 에이전트에게 주는 역할 글을 함께 받아요(아래). 그 밖에는 메인과 같은 에이전트 방식의 지시문, AGENTS.md, 스킬을 받아요.",
  "own.prompts.subagent.role.opencode":
    "explore처럼 자기 지시문이 있는 역할로 맡기면, 모델별 기본 지시문 대신 그 역할의 지시문을 받아요.",
  "own.prompts.subagent.role.pi":
    "explore처럼 자기 지시문이 있는 역할로 맡기면, Pi 지시문의 첫 문단과 도구 목록·규칙 대신 그 역할의 지시문을 받아요.",
  "own.prompts.subagent.role.dsh":
    "explore처럼 자기 지시문이 있는 역할로 맡기면, 모델 소개 줄 대신 그 역할의 지시문을 받아요.",
  "own.prompts.subagent.role.claude-code":
    "explore처럼 자기 지시문이 있는 역할로 맡기면, Claude Agent 계정에서는 Claude Code 지시문 뒤의 에이전트 역할 자리에, 다른 계정에서는 모델별 기본 지시문 대신 그 역할의 지시문을 받아요.",
  "own.prompts.subagent.role.codex":
    "explore처럼 자기 지시문이 있는 역할로 맡기면, Codex 지시문은 그대로 두고 그 역할의 지시문을 developer 메시지 맨 앞에 더해요.",
  "own.prompts.subagent.preset": "프리셋이 위임 모드를 정하면, 메인 모델은 언제 맡길지 알려 주는 안내를 따로 받아요.",
  "own.prompts.subagent.role": "하위 에이전트의 역할 글",
  "own.prompts.subagent.returns": "돌아오는 글",
  "own.prompts.subagent.return.core":
    "메인 모델에게는 하위 에이전트가 마지막 단계에 쓴 글만 <subagent sessionID=… state=completed> 안에 담겨 가요. 중간 단계의 글과 도구 결과는 가지 않아요.",
  "own.prompts.subagent.return.codex-v1":
    "하위 에이전트가 끝나면 마지막 답이 <subagent_notification> 알림으로 메인에게 가고, wait_agent도 그 답을 돌려줘요. 중간 단계의 글과 도구 결과는 가지 않아요.",
  "own.prompts.subagent.return.codex-v2":
    "하위 에이전트가 끝나면 마지막 답이 FINAL_ANSWER 메시지로 메인에게 가요. wait_agent는 기다리기만 하고 내용을 돌려주지 않아요. 중간 단계의 글과 도구 결과는 가지 않아요.",
  "own.prompts.subagent.cut":
    "기다려서 받는 결과(포그라운드)가 {lines}줄이나 {size}를 넘으면 앞부분만 남기고 잘라요. 전체는 파일로 남고 그 경로가 함께 가요.",
  "own.prompts.subagent.background":
    "백그라운드로 맡긴 하위 에이전트는 끝나면 같은 모양의 알림으로 돌아와요. 이 알림은 자르지 않아요.",
  "own.prompts.subagent.notice":
    "프리셋 때문에 하위 에이전트의 모델이나 추론 강도가 요청과 달라졌을 때만, 이 앱이 그 사실을 결과 뒤에 한 줄로 붙여요.",
} as const satisfies Record<string, string>

export type PromptsKey = keyof typeof promptsKo

export const promptsEn: Partial<Record<PromptsKey, string>> = {
  "own.prompts.intro":
    "What each agent style sends the model. The original is what that tool sends, the revision is adapted to this app, and my instructions are your own edit. New conversations start with the choice in Settings > General.",
  "own.prompts.harness": "Agent style",
  "own.prompts.variant": "Instructions",
  "own.prompts.model": "Model",
  "own.prompts.mode": "Approval mode",
  "own.prompts.examples": "No model is available, so example models are shown.",
  "own.prompts.opencode":
    "OpenCode default sends OpenCode's own instructions as they are. This app changes nothing there and has no instructions to pick.",
  "own.prompts.claudeCode":
    "Claude Agent default sends a Claude Agent account's model the instructions Claude Code sends, as they are, followed by OpenCode's agent role and instructions. There are no instructions to pick and nothing this app changes. On other accounts' models it works like OpenCode default.",
  "own.prompts.unavailable": "This service cannot show the instructions.",
  "own.prompts.failed": "Could not load the instructions",
  "own.prompts.retry": "Try again",
  "own.prompts.tier.catalog": "A GPT model in Codex's catalog. The revision sends the same text as the original.",
  "own.prompts.tier.lean":
    "A model that gets short instructions (Claude Opus 4.8 and later, Fable, Mythos). The revision sends a short text written for this app.",
  "own.prompts.tier.fallback":
    "A model outside Codex's catalog. The revision sends Codex's fallback instructions with a few changes.",
  "own.prompts.tier.pi": "Pi sends every model the same text.",
  "own.prompts.tier.dsh":
    "DeepSeek style sends every model the same text. The user message parts are what this app adds after the user's first message.",
  "own.prompts.customMissing": "No instructions of yours are saved yet, so the revision is shown. Make them below.",
  "own.prompts.pickCustom": "To edit this text, pick My instructions above.",
  "own.prompts.sent.title": "What is sent",
  "own.prompts.sent.note":
    "The text of an empty conversation's first request. Real conversations also get AGENTS.md, the skill list, the Code Mode tool list and MCP notes.",
  "own.prompts.search": "Find in the text",
  "own.prompts.search.count": "{count} found",
  "own.prompts.search.none": "Nothing found",
  "own.prompts.copyAll": "Copy all",
  "own.prompts.copy": "Copy",
  "own.prompts.copied": "Copied",
  "own.prompts.copyFailed": "Could not copy",
  "own.prompts.chars": "{count} characters",
  "own.prompts.editable": "My instructions can replace this",
  "own.prompts.generated": "Made by this app",
  "own.prompts.role.system": "System text",
  "own.prompts.role.developer": "Developer message",
  "own.prompts.role.user": "First user message",
  "own.prompts.part.base": "Base instructions",
  "own.prompts.part.identity": "Model name",
  "own.prompts.part.permissions": "Approval mode text",
  "own.prompts.part.collaboration": "Collaboration mode",
  "own.prompts.part.agents": "Multi-agent notes",
  "own.prompts.part.context": "Added notes",
  "own.prompts.part.agents-md": "AGENTS.md",
  "own.prompts.part.environment": "Environment",
  "own.prompts.part.preamble": "Opening paragraph",
  "own.prompts.part.tools": "Tool list",
  "own.prompts.part.rules": "Rules",
  "own.prompts.part.addendum": "Added notes",
  "own.prompts.part.project": "Project instructions",
  "own.prompts.part.skills": "Skills",
  "own.prompts.part.cwd": "Working folder",
  "own.prompts.part.harness": "dsh introduction",
  "own.prompts.part.persona": "Model introduction",
  "own.prompts.part.time": "Time reading",
  "own.prompts.part.perConversation":
    "The working folder, shell and time zone differ per conversation. Real requests carry the date too.",
  "own.prompts.tools.title": "{count} tools",
  "own.prompts.tools.note":
    "The tools this style sends itself. OpenCode's other tools (questions, web search, Code Mode and others) go along unchanged.",
  "own.prompts.changes.title": "Changes",
  "own.prompts.changes.reference":
    "The original is what that tool sends. The revision changes {count} places for this model.",
  "own.prompts.changes.own": "The revision changes {count} places for this model.",
  "own.prompts.changes.custom.codex":
    "My instructions replace the base instructions only. The other changes are the revision's.",
  "own.prompts.changes.custom.pi":
    "My instructions replace the opening paragraph only. The other changes are the revision's.",
  "own.prompts.changes.custom.dsh":
    "My instructions replace the model introduction line only. The other changes are the revision's.",
  "own.prompts.changes.none": "Nothing changes for this model. The revision sends the original text.",
  "own.prompts.changes.others": "{count} changes for other models",
  "own.prompts.changes.before": "Original",
  "own.prompts.changes.after": "Revision",
  "own.prompts.changes.removed": "Removed",
  "own.prompts.changes.added": "Not in the original",
  "own.prompts.custom.title": "My instructions",
  "own.prompts.custom.note.codex":
    "My instructions replace the base instructions only. The approval text, tools and environment are made by this app. Every model gets the same text.",
  "own.prompts.custom.note.pi":
    "My instructions replace Pi's opening paragraph only. The tool list, rules and working folder are made by this app. Every model gets the same text.",
  "own.prompts.custom.note.dsh":
    "My instructions replace the model introduction line of dsh's instructions only. Tool guidance, runtime facts and the time reading are made by this app. {{model}} becomes the conversation model's ID.",
  "own.prompts.custom.patch":
    "This app puts how to edit files in place of {slot}. Without it the model may not know the patch shape.",
  "own.prompts.custom.start": "Starts from a copy of what {model} gets.",
  "own.prompts.custom.fromOwn": "Start from the revision",
  "own.prompts.custom.fromReference": "Start from the original",
  "own.prompts.custom.copyOwn": "Replace with the revision's text",
  "own.prompts.custom.copyReference": "Replace with the original's text",
  "own.prompts.custom.label": "My instructions text",
  "own.prompts.custom.count": "{count} / {limit} characters",
  "own.prompts.custom.save": "Save",
  "own.prompts.custom.saved": "Your instructions are saved",
  "own.prompts.custom.unsaved": "There are unsaved edits",
  "own.prompts.custom.discard": "Discard edits",
  "own.prompts.custom.cache":
    "Applies from the next request. Conversations on your instructions then write the cache of their start once more.",
  "own.prompts.custom.use":
    "To use them, pick My instructions in a conversation's agent style pill. New conversations start with the choice in Settings > General.",
  "own.prompts.custom.reset": "Reset to default",
  "own.prompts.custom.resetTitle": "Delete your instructions?",
  "own.prompts.custom.resetBody":
    "Deletes your instructions for {harness}. Conversations that picked them, and new ones, use the revision from their next request.",
  "own.prompts.custom.resetConfirm": "Delete",
  "own.prompts.custom.resetDone": "Your instructions are deleted. Conversations that picked them use the revision.",
  "own.prompts.custom.empty": "The text is empty",
  "own.prompts.custom.tooLong": "Up to {limit} characters",
  "own.prompts.custom.failed": "Could not save your instructions",
  "own.prompts.custom.readOnly": "Can be changed in the app window on the PC.",
  "own.prompts.changes.more": "More",
  "own.prompts.changes.moreLabel": "{title}: more in the manual",
  "own.prompts.compare": "Compare",
  "own.prompts.compare.title.reference": "Original and revision",
  "own.prompts.compare.title.custom": "Revision and my instructions",
  "own.prompts.compare.note.reference":
    "In each part the original is on the left and the revision on the right; a narrow window stacks them. What differs is colored: what the original loses is struck through, what the revision adds is underlined, and why it changed is written under each change. Changed line breaks, spaces and invisible characters show as signs such as ⏎, ·, ␍ and ⍽.",
  "own.prompts.compare.note.custom":
    "In each part the revision is on the left and your saved instructions on the right; a narrow window stacks them. What differs is colored: what the revision loses is struck through and what your instructions add is underlined. Changed line breaks, spaces and invisible characters show as signs such as ⏎, ·, ␍ and ⍽.",
  "own.prompts.compare.summary": "{changed} parts differ, {same} are the same",
  "own.prompts.compare.summaryTools": "{changed} tools differ, {same} are the same",
  "own.prompts.compare.failed": "Could not load the other text to compare",
  "own.prompts.compare.identical": "The two texts are the same.",
  "own.prompts.compare.noCustom": "No instructions of yours are saved, so they match the revision. Make them above.",
  "own.prompts.compare.same": "Same",
  "own.prompts.compare.sameParts": "{count} parts",
  "own.prompts.compare.partCount": "{name} ×{count}",
  "own.prompts.compare.runs": "{count} changes",
  "own.prompts.compare.side.reference": "Original",
  "own.prompts.compare.side.own": "Revision",
  "own.prompts.compare.side.custom": "My instructions",
  "own.prompts.compare.missing.reference": "Not in the original",
  "own.prompts.compare.missing.own": "Not in the revision",
  "own.prompts.compare.missing.custom": "Not in my instructions",
  "own.prompts.compare.noLines": "No lines here",
  "own.prompts.compare.whitespace.lines": "Only line ends and blank lines differ",
  "own.prompts.compare.whitespace.spaces": "Only spaces and line breaks differ",
  "own.prompts.compare.whitespace.invisible": "Only invisible characters differ",
  "own.prompts.compare.sr.del": "deletion start",
  "own.prompts.compare.sr.delEnd": "deletion end",
  "own.prompts.compare.sr.ins": "insertion start",
  "own.prompts.compare.sr.insEnd": "insertion end",
  "own.prompts.compare.sr.breaks": "{count} line breaks",
  "own.prompts.compare.sr.spaces": "{count} spaces",
  "own.prompts.compare.sr.tabs": "{count} tabs",
  "own.prompts.compare.sr.returns": "{count} carriage returns",
  "own.prompts.compare.sr.nbsp": "{count} no-break spaces",
  "own.prompts.compare.sr.wide": "{count} ideographic spaces",
  "own.prompts.compare.sr.zero": "{count} zero-width characters",
  "own.prompts.compare.sr.soft": "{count} soft hyphens",
  "own.prompts.compare.sr.nel": "{count} next-line characters",
  "own.prompts.compare.sr.control": "{count} control characters",
  "own.prompts.compare.sr.bidi": "{count} direction controls",
  "own.prompts.compare.sr.variant": "{count} variation selectors",
  "own.prompts.compare.sr.tag": "{count} tag characters",
  "own.prompts.compare.sr.filler": "{count} Hangul fillers",
  "own.prompts.compare.copy.reference": "Copy original",
  "own.prompts.compare.copy.own": "Copy revision",
  "own.prompts.compare.copy.custom": "Copy mine",
  "own.prompts.compare.lines": "Show {count} unchanged lines",
  "own.prompts.compare.linesHide": "Hide unchanged lines",
  "own.prompts.compare.tools": "Tool descriptions",
  "own.prompts.compare.toolsSame": "{count} tools are the same",
  "own.prompts.compare.elsewhere": "Not visible in the text",
  "own.prompts.compare.elsewhereNote":
    "Changes the text above does not show, such as tool arguments or the Code Mode tool list, which differs per conversation.",
  "own.prompts.subagent.title": "Subagents",
  "own.prompts.subagent.note":
    "What goes to a subagent when the main model hands it work, and what comes back. Read only.",
  "own.prompts.subagent.tool": "Delegation tool",
  "own.prompts.subagent.agents":
    "The Available subagents list in the description names the roles a new conversation's default agent ({agent}) may hand work to. It differs with the conversation's agent.",
  "own.prompts.subagent.mcp":
    "Claude Agent accounts' models get it as the MCP tool {name}. Claude Code cuts a description after 2,048 characters, so a long one has the subagent list moved to the front.",
  "own.prompts.subagent.codemode":
    "This model runs in Code Mode and gets none of Codex's agent tools (spawn_agent), so it hands work off with OpenCode's subagent tool.",
  "own.prompts.subagent.ask.original":
    "Codex's original text. It tells a subagent to list the file paths it changed in its final answer, and the main model to quickly review the changes when it returns.",
  "own.prompts.subagent.ask.fallback":
    "Codex's text with a few places changed for this app. Like the original, it tells a subagent to list the file paths it changed, and the main model to quickly review those files when it returns.",
  "own.prompts.subagent.ask.lean":
    "A short text this app wrote. It asks for no list of changed files and no review; it only says to state the result wanted back.",
  "own.prompts.subagent.ask.v2":
    "The collaboration tools' spawn_agent asks for no list of changed files and no review.",
  "own.prompts.subagent.first": "A new subagent's first message",
  "own.prompts.subagent.parentText": "(the main model's {field}, word for word)",
  "own.prompts.subagent.first.core":
    "Work handed to the same subagent again (sessionID) carries the main model's text alone.",
  "own.prompts.subagent.first.codex-v1":
    "The main model's text goes as it is, with no line in front. When the whole conversation is passed on (fork_context), the main conversation comes before it.",
  "own.prompts.subagent.first.codex-v2":
    "It goes in Codex's task message form. With fork_turns left out or all, the whole main conversation comes before it.",
  "own.prompts.subagent.sends": "Added instructions",
  "own.prompts.subagent.extra.none":
    "Nothing else is added for a subagent. It gets the same agent style instructions, AGENTS.md and skills as the main model.",
  "own.prompts.subagent.extra.codex-v2":
    "It also gets the role text Codex gives subagents (below). Otherwise it gets the same instructions, AGENTS.md and skills as the main model.",
  "own.prompts.subagent.role.opencode":
    "A role with instructions of its own, such as explore, gets them in place of the model's default instructions.",
  "own.prompts.subagent.role.pi":
    "A role with instructions of its own, such as explore, gets them in place of Pi's opening paragraph, tool list and rules.",
  "own.prompts.subagent.role.dsh":
    "A role with instructions of its own, such as explore, gets them in place of the model line.",
  "own.prompts.subagent.role.claude-code":
    "A role with instructions of its own, such as explore, gets them in the agent role after Claude Code's instructions on Claude Agent accounts, and in place of the model's default instructions elsewhere.",
  "own.prompts.subagent.role.codex":
    "A role with instructions of its own, such as explore, gets them at the start of the developer message; Codex's instructions stay as they are.",
  "own.prompts.subagent.preset":
    "When a preset sets a delegation mode, the main model gets a separate note on when to hand work off.",
  "own.prompts.subagent.role": "The subagent's role text",
  "own.prompts.subagent.returns": "What comes back",
  "own.prompts.subagent.return.core":
    "The main model gets only the text of the subagent's last step, inside <subagent sessionID=… state=completed>. Earlier steps' text and tool results do not go.",
  "own.prompts.subagent.return.codex-v1":
    "When a subagent finishes, its final answer reaches the main model in a <subagent_notification>, and wait_agent returns it too. Earlier steps' text and tool results do not go.",
  "own.prompts.subagent.return.codex-v2":
    "When a subagent finishes, its final answer reaches the main model as a FINAL_ANSWER message. wait_agent only waits and returns no content. Earlier steps' text and tool results do not go.",
  "own.prompts.subagent.cut":
    "A result the main model waits for (foreground) over {lines} lines or {size} keeps its start and is cut. The whole text is saved to a file whose path goes along.",
  "own.prompts.subagent.background":
    "A subagent sent to the background comes back as a notice of the same shape when it finishes. That notice is not cut.",
  "own.prompts.subagent.notice":
    "Only when a preset made a subagent's model or reasoning effort differ from the request does this app add one line saying so after the result.",
}

export const promptsText = featureText(promptsKo, promptsEn)
export const usePromptsText = promptsText.use
