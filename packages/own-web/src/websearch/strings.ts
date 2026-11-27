// 웹 검색 strings (03 §18.2, WM 2026-10-19): 설정 > 웹 검색, the search card's title and line, the one-time hint above
// the composer, the first-use card's additions and the link on 설정 > 승인·권한. Kept next to the module; the keys can
// move verbatim into src/i18n/ko.ts / en.ts. The first-use card's own words (`own.websearch.*`) stay in the shared
// catalog. Prices with the user's own key are from own/reports/websearch-services-2026-10.md (checked 2026-10-19); the
// key strings (`own.ws.key.*`) began as Brave's in requests/strings.ts (SP 2026-10-19) and now serve every service whose
// key own's vault keeps (SK 2026-10-23).
import { featureText } from "@/queue/text"

export const webSearchKo = {
  // The search card (session-ui's title) and the line under it.
  "own.ws.card.subscription": "{name}(으)로 검색",
  "own.ws.card.free": "{name}(으)로 검색 (무료)",
  "own.ws.card.key": "{name}(으)로 검색 (내 키)",
  "own.ws.card.balance": "{name}(으)로 검색 (잔액)",
  "own.ws.card.unknown": "{name}(으)로 검색",
  "own.ws.card.multi": "여러 서비스로 검색",
  "own.ws.card.multiNames": "여러 서비스로 검색 · {names}",
  "own.ws.card.found": "결과를 찾은 서비스: {counts}",
  "own.ws.card.change": "검색 서비스 바꾸기",
  "own.ws.card.empty": "결과가 없어요. 키 없이 쓰는 {name}의 무료 한도가 찼을 수도 있어요.",

  // 설정 > 웹 검색
  "own.ws.lead":
    "에이전트가 웹에서 찾아볼 때 쓰는 검색 서비스예요. 이 PC의 서비스에서 한 번 정하면 모든 대화와 모델에 함께 적용돼요. 대화의 승인 모드와는 따로예요.",
  "own.ws.now": "지금 쓰는 서비스",
  "own.ws.now.default": "기본값",
  "own.ws.now.chosen": "직접 고름",
  "own.ws.now.unset": "아직 정하지 않았어요",
  "own.ws.now.loading": "불러오는 중…",
  "own.ws.source.default": "ChatGPT 계정이 있어서 이 앱이 기본으로 써요.",
  "own.ws.source.chosen": "여기서 고른 서비스예요.",
  "own.ws.source.unset": "대화 중에 고른 적이 있으면 그 답을 쓰고, 없으면 에이전트가 처음 검색할 때 한 번 물어요.",
  "own.ws.source.multi": "여기서 고른 방식이에요. 검색할 때마다 고른 서비스에 함께 물어요.",
  "own.ws.source.missing":
    "고른 서비스가 지금 목록에 없어요. 그래서 대화 중에 고른 답을 쓰거나, 없으면 처음 검색할 때 물어요.",
  "own.ws.cost.subscription": "ChatGPT 구독 사용량에서 빠져요",
  "own.ws.cost.free": "무료 · 키 없음 · 사용량 제한 있음",
  "own.ws.cost.key": "내 {name} 키로 검색해요 · {name} 요금이 붙어요",
  "own.ws.cost.env": "환경 변수의 {name} 키로 검색해요 · {name} 요금이 붙어요",
  "own.ws.cost.balance": "DeepSeek 잔액에서 빠져요 · 1,000건에 약 $0.75",
  // With the key in own's vault (Brave, and the keyed variants of core's keyless services, SK).
  "own.ws.cost.vault.brave": "내 키 · 요금 붙음 · 1,000건에 약 $5(매달 $5어치 무료)",
  "own.ws.cost.vault.exa": "내 키 · 요금 붙음 · 1,000건에 약 $7(매달 $10어치 무료)",
  "own.ws.cost.vault.firecrawl": "내 키 · 요금 붙음 · 1,000건에 약 $2~8(매달 1,000크레딧 무료)",
  "own.ws.cost.vault.parallel": "내 키 · 요금 붙음 · 1,000건에 약 $5(매달 5,000건 무료)",
  "own.ws.cost.vault.tavily": "내 키 · 요금 붙음 · 1,000건에 약 $8(매달 1,000크레딧 무료)",
  "own.ws.cost.vault.tinyfish": "내 키 · 지금은 요금 없음(2026-05-04부터 무료)",
  "own.ws.cost.any": "뽑힌 서비스에 따라 달라요",
  "own.ws.where": "검색어가 {name}(으)로 가요",
  "own.ws.where.subscription": "검색어가 ChatGPT(OpenAI)로 가요",
  "own.ws.where.balance": "검색어가 중국(DeepSeek) 서버로 가요",
  "own.ws.where.any": "검색어가 {names} 중 하나로 가요",
  "own.ws.chatgpt.login": "ChatGPT 계정에 다시 로그인해야 검색할 수 있어요.",
  "own.ws.chatgpt.add": "ChatGPT 계정을 연결하면 ChatGPT 구독으로 검색할 수 있어요.",
  "own.ws.accounts": "계정 →",
  "own.ws.mode": "검색 방식",
  "own.ws.mode.single": "한 서비스",
  "own.ws.mode.single.note": "검색할 때마다 서비스 하나에 물어요.",
  "own.ws.mode.multi": "여러 서비스 함께",
  "own.ws.mode.multi.note":
    "고른 서비스 모두에 한 번에 묻고 결과를 합쳐요. 같은 페이지는 한 번만 넣고, 여러 서비스가 함께 찾은 페이지를 앞에 둬요.",
  "own.ws.multi.pick": "함께 쓸 서비스",
  "own.ws.multi.pickNote":
    "처음에는 ChatGPT와 키 없이 쓰는 서비스가 골라져 있어요. 그중 여기서 키를 넣은 서비스는 그 키로 물어요(요금이 붙어요). DeepSeek, Brave, 환경 변수의 키를 쓰는 서비스는 직접 골라야 해요.",
  "own.ws.multi.none": "서비스를 하나 이상 고르세요.",
  "own.ws.multi.cost": "검색 한 번에 최대 약 {usd} (1,000번이면 약 {thousand})",
  "own.ws.multi.cost.free": "검색 한 번에 드는 돈: 없음",
  "own.ws.multi.cost.subscription": "ChatGPT 구독 사용량도 조금 써요",
  "own.ws.multi.cost.unknown": "{names}의 비용은 알 수 없어요",
  "own.ws.multi.time":
    "모든 서비스가 답하면 바로, 아니면 첫 결과 뒤 8초까지 기다려요(ChatGPT는 최대 25초). 실패하거나 빈 결과만 준 서비스는 잠시 쉬게 해요.",
  "own.ws.multi.asks": "{names}에 함께 물어요",
  "own.ws.where.multi": "검색어가 {names}(으)로 가요",
  "own.ws.pick": "검색 서비스 고르기",
  "own.ws.recommended": "추천",
  "own.ws.note.subscription":
    "ChatGPT 계정으로 검색해요. 한도에 걸린 계정은 건너뛰고 다음 계정으로 검색해요. 계정이 모두 한도에 걸리거나 다시 로그인해야 하면 검색이 실패해요.",
  "own.ws.note.exa":
    "키 없이는 무료예요(한도는 공개되지 않음). 키를 넣으면 달마다 10달러어치까지 무료, 그 뒤 1,000건에 약 7달러예요.",
  "own.ws.note.parallel":
    "키 없이는 무료예요(한도는 공개되지 않음). 키를 넣으면 달마다 5,000건까지 무료, 그 뒤 1,000건에 약 5달러예요.",
  "own.ws.note.tavily":
    "키 없이는 무료예요(한도는 공개되지 않음). 키를 넣으면 달마다 1,000크레딧까지 무료, 그 뒤 1,000건에 약 8달러예요.",
  "own.ws.note.firecrawl":
    "키 없이는 하루 한도 안에서 무료예요. 키를 넣으면 달마다 1,000크레딧까지 무료, 그 뒤 1,000건에 약 2~8달러예요.",
  "own.ws.note.tinyfish": "키 없이도 무료예요(분당 30건, 시간당 500건까지).",
  // own-accounts' DeepSeek and Brave (02 §9.2, SP 2026-10-19): listed, never the default.
  "own.ws.note.own-deepseek":
    "DeepSeek 계정의 키로 검색해요. 결과가 있는 검색에만 요금이 붙고, 잔액이 모자란 계정은 건너뛰고 다음 계정으로 검색해요. 이 앱이 기본으로 고르지 않아요.",
  "own.ws.note.brave":
    "Brave에서 직접 받은 키로 검색해요. Brave는 검색어를 남과 나누거나 학습에 쓰지 않는다고 해요(기록을 아예 남기지 않는 ZDR은 엔터프라이즈 요금제만). 이 앱이 기본으로 고르지 않아요.",
  "own.ws.brave.needKey": "키 필요",
  // A service's key under its row (own's vault, `websearch.key.get/set`): Brave's, and the five keyless services'.
  "own.ws.key.label": "{name} 키",
  "own.ws.key.saved": "저장됨 {hint}",
  "own.ws.key.none.brave": "없음 · 넣으면 Brave를 고를 수 있어요",
  "own.ws.key.none": "없음 · 넣으면 ‘{name} (내 키)’를 고를 수 있어요",
  "own.ws.key.add": "{name} 키 넣기…",
  "own.ws.key.replace": "{name} 키 바꾸기…",
  "own.ws.key.field": "{name} API 키",
  "own.ws.key.fieldNote": "이 PC의 키 저장소에만 저장되고 다시 보이지 않아요.",
  "own.ws.key.save": "저장",
  "own.ws.key.remove": "지우기",
  "own.ws.key.removeConfirm.brave": "Brave 키를 지울까요? Brave로는 검색할 수 없게 돼요.",
  "own.ws.key.removeConfirm": "{name} 키를 지울까요? ‘{name} (내 키)’가 목록에서 빠지고, 키 없이 쓰는 {name}만 남아요.",
  "own.ws.key.cancel": "취소",
  "own.ws.key.local": "키는 이 PC의 창에서만 넣고 바꿀 수 있어요.",
  "own.ws.key.invalid": "키 모양이 아니에요 (공백이나 제어 문자가 있음)",
  "own.ws.key.failed": "키를 저장하지 못했어요",
  "own.ws.any": "목록의 서비스 중 하나(자동)",
  "own.ws.note.any":
    "검색할 때마다 {names} 중 하나를 골라 써요. 어느 서비스로 갈지 미리 알 수 없어요. 사용량 제한에 걸린 서비스는 잠시 빼고 다른 서비스로 넘어가요.",
  "own.ws.note.anyEmpty": "키 없이 쓰는 서비스의 무료 한도가 차서 빈 결과만 돌려주면 다른 서비스로 넘어가지 않아요.",
  "own.ws.note.anyPaid": "돈이 드는 {names}도 뽑힐 수 있어요.",
  "own.ws.note.anyMulti": "무료 서비스를 여러 개 쓰려면 위의 ‘여러 서비스 함께’가 나아요.",
  "own.ws.off": "웹 검색 끄기",
  "own.ws.note.off": "모든 대화에서 웹 검색 도구가 빠져요. 다른 항목을 골라 저장하면 다시 켜져요.",
  "own.ws.now.off": "웹 검색이 꺼져 있어요",
  "own.ws.save": "저장",
  "own.ws.reset": "기본으로",
  "own.ws.reset.note": "여기서 고른 것을 지우고 이 앱의 기본으로 돌아가요. ChatGPT 계정이 있으면 ChatGPT예요.",
  "own.ws.saved": "웹 검색 서비스를 {choice}(으)로 바꿨어요",
  "own.ws.saved.off": "웹 검색을 껐어요",
  "own.ws.saved.default": "웹 검색 서비스를 기본값으로 바꿨어요",
  "own.ws.saved.multi": "웹 검색을 여러 서비스 함께 쓰기로 바꿨어요: {names}",
  "own.ws.codex":
    "Codex 방식에서 ChatGPT·OpenAI 계정의 GPT 모델은 여기 설정과 상관없이 OpenAI의 자체 검색을 써요(그 계정의 사용량).",
  "own.ws.prices":
    "가격은 2026-10-19에 확인한 값이라 바뀔 수 있어요. 키는 서비스 줄 아래에서 넣고, 이 PC의 키 저장소에만 저장돼요. 키를 넣은 서비스는 ‘(내 키)’ 줄이 따로 생기고, 키 없이 쓰는 줄은 그대로 무료예요.",
  "own.ws.failed": "웹 검색 설정을 저장하지 못했어요",
  "own.ws.readFailed": "웹 검색 설정을 읽지 못했어요",
  "own.ws.noScope": "이 연결에서는 웹 검색 설정을 바꿀 수 없어요. PC의 앱 창에서 바꿔 주세요.",
  "own.ws.unsupported": "서비스가 이 설정을 몰라요. 서비스를 새 버전으로 다시 시작하세요.",
  "own.ws.unknownService": "이 서버에 없는 검색 서비스예요. 목록을 다시 불러왔어요.",
  "own.ws.configUnavailable": "설정 파일(opencode.jsonc)을 읽거나 쓸 수 없어요.",
  "own.ws.none": "이 서버에 검색 서비스가 없어요",

  // The one-time hint above the composer.
  "own.ws.hint": "웹 검색이 무료 서비스({name})로 가고 있어요 · ChatGPT 구독으로 바꿀까요?",
  "own.ws.hint.switch": "ChatGPT로 바꾸기",
  "own.ws.hint.settings": "웹 검색 설정",
  "own.ws.hint.dismiss": "닫기",

  // 설정 > 승인·권한 and the first-use card.
  "own.ws.moved": "검색 서비스 고르기는 웹 검색 페이지에 있어요.",
  "own.ws.open": "웹 검색 설정 열기",
  "own.ws.dock.noChatGPT": "ChatGPT 계정을 연결하면 ChatGPT 구독으로 검색할 수 있어요.",
} as const satisfies Record<string, string>

export type WebSearchKey = keyof typeof webSearchKo

export const webSearchEn: Partial<Record<WebSearchKey, string>> = {
  "own.ws.card.subscription": "Search with {name}",
  "own.ws.card.free": "Search with {name} (free)",
  "own.ws.card.key": "Search with {name} (your key)",
  "own.ws.card.balance": "Search with {name} (balance)",
  "own.ws.card.unknown": "Search with {name}",
  "own.ws.card.multi": "Search with several services",
  "own.ws.card.multiNames": "Search with several services · {names}",
  "own.ws.card.found": "Results found by: {counts}",
  "own.ws.card.change": "Change search service",
  "own.ws.card.empty": "No results. {name}'s free tier without a key may be used up.",
  "own.ws.lead":
    "The search service the agent uses on the web. Set once for this PC's service, shared by every conversation and model, separate from a conversation's approval mode.",
  "own.ws.now": "In use now",
  "own.ws.now.default": "Default",
  "own.ws.now.chosen": "Chosen",
  "own.ws.now.unset": "Not chosen yet",
  "own.ws.now.loading": "Loading…",
  "own.ws.source.default": "This app uses it by default because a ChatGPT account is connected.",
  "own.ws.source.chosen": "Chosen here.",
  "own.ws.source.unset":
    "An answer given during a conversation applies; without one the agent asks once at its first search.",
  "own.ws.source.multi": "Chosen here. Each search asks the chosen services together.",
  "own.ws.source.missing":
    "The chosen service is not listed now, so an answer given during a conversation applies, or the first search asks.",
  "own.ws.cost.subscription": "Uses your ChatGPT subscription",
  "own.ws.cost.free": "Free · no key · usage limits",
  "own.ws.cost.key": "Searches with your {name} key · billed by {name}",
  "own.ws.cost.env": "Searches with the {name} key from an environment variable · billed by {name}",
  "own.ws.cost.balance": "Paid from your DeepSeek balance · about $0.75 per 1,000",
  "own.ws.cost.vault.brave": "Your own key · billed · about $5 per 1,000 ($5 free each month)",
  "own.ws.cost.vault.exa": "Your own key · billed · about $7 per 1,000 ($10 free each month)",
  "own.ws.cost.vault.firecrawl": "Your own key · billed · about $2–8 per 1,000 (1,000 credits free each month)",
  "own.ws.cost.vault.parallel": "Your own key · billed · about $5 per 1,000 (5,000 free each month)",
  "own.ws.cost.vault.tavily": "Your own key · billed · about $8 per 1,000 (1,000 credits free each month)",
  "own.ws.cost.vault.tinyfish": "Your own key · no charge for now (free since 2026-05-04)",
  "own.ws.cost.any": "Depends on the service picked",
  "own.ws.where": "Queries go to {name}",
  "own.ws.where.subscription": "Queries go to ChatGPT (OpenAI)",
  "own.ws.where.balance": "Queries go to DeepSeek's servers in China",
  "own.ws.where.any": "Queries go to one of {names}",
  "own.ws.chatgpt.login": "Sign in to a ChatGPT account again to search.",
  "own.ws.chatgpt.add": "Connect a ChatGPT account to search with your ChatGPT subscription.",
  "own.ws.accounts": "Accounts →",
  "own.ws.mode": "How to search",
  "own.ws.mode.single": "One service",
  "own.ws.mode.single.note": "Each search asks one service.",
  "own.ws.mode.multi": "Several services together",
  "own.ws.mode.multi.note":
    "Asks every chosen service at once and merges the results: each page once, pages several services found first.",
  "own.ws.multi.pick": "Services to use together",
  "own.ws.multi.pickNote":
    "ChatGPT and the keyless services start checked; those whose key you added here ask with that key (billed). DeepSeek, Brave and a service with a key from an environment variable must be checked by hand.",
  "own.ws.multi.none": "Check at least one service.",
  "own.ws.multi.cost": "At most about {usd} per search (about {thousand} per 1,000)",
  "own.ws.multi.cost.free": "Cost per search: none",
  "own.ws.multi.cost.subscription": "also a little of your ChatGPT subscription",
  "own.ws.multi.cost.unknown": "the cost of {names} is not known",
  "own.ws.multi.time":
    "Returns as soon as all answered, else 8 s after the first results (up to 25 s for ChatGPT). A service that fails or finds nothing rests for a while.",
  "own.ws.multi.asks": "Asks {names} together",
  "own.ws.where.multi": "Queries go to {names}",
  "own.ws.pick": "Choose a search service",
  "own.ws.recommended": "Recommended",
  "own.ws.note.subscription":
    "Searches with your ChatGPT accounts, skipping an account at its limit. When every account is at its limit or needs a sign-in, the search fails.",
  "own.ws.note.exa":
    "Free without a key (limits not published). With a key: $10 a month free, then about $7 per 1,000.",
  "own.ws.note.parallel":
    "Free without a key (limits not published). With a key: 5,000 a month free, then about $5 per 1,000.",
  "own.ws.note.tavily":
    "Free without a key (limits not published). With a key: 1,000 credits a month free, then about $8 per 1,000.",
  "own.ws.note.firecrawl":
    "Free within a daily limit without a key. With a key: 1,000 credits a month free, then about $2–8 per 1,000.",
  "own.ws.note.tinyfish": "Free without a key too (30 a minute, 500 an hour).",
  "own.ws.note.own-deepseek":
    "Searches with your DeepSeek account's key. Only searches with results are billed; an account low on balance is skipped for the next one. Never this app's default.",
  "own.ws.note.brave":
    "Searches with a key you got from Brave. Brave says queries are not shared or used for training (zero data retention only on enterprise plans). Never this app's default.",
  "own.ws.brave.needKey": "Key needed",
  "own.ws.key.label": "{name} key",
  "own.ws.key.saved": "Saved {hint}",
  "own.ws.key.none.brave": "None · with a key, Brave can be chosen",
  "own.ws.key.none": "None · with a key, ‘{name} (my key)’ can be chosen",
  "own.ws.key.add": "Add {name} key…",
  "own.ws.key.replace": "Replace {name} key…",
  "own.ws.key.field": "{name} API key",
  "own.ws.key.fieldNote": "Stored only in this PC's key store and never shown again.",
  "own.ws.key.save": "Save",
  "own.ws.key.remove": "Remove",
  "own.ws.key.removeConfirm.brave": "Remove the Brave key? Brave can no longer search.",
  "own.ws.key.removeConfirm": "Remove the {name} key? ‘{name} (my key)’ leaves the list; keyless {name} stays.",
  "own.ws.key.cancel": "Cancel",
  "own.ws.key.local": "Keys can be entered and changed only in a window on this PC.",
  "own.ws.key.invalid": "Not a key (it holds spaces or control characters)",
  "own.ws.key.failed": "Could not save the key",
  "own.ws.any": "Any listed service (automatic)",
  "own.ws.note.any":
    "Each search picks one of {names}, so you cannot tell ahead where it goes. A service at its rate limit is left out for a while.",
  "own.ws.note.anyEmpty":
    "A keyless service whose free tier is used up returns empty results, and the search does not move on.",
  "own.ws.note.anyPaid": "Paid services ({names}) may be picked too.",
  "own.ws.note.anyMulti": "To use several free services, choose ‘Several services together’ above.",
  "own.ws.off": "Turn off web search",
  "own.ws.note.off": "The web search tool is removed from every conversation. Save another choice to turn it back on.",
  "own.ws.now.off": "Web search is off",
  "own.ws.save": "Save",
  "own.ws.reset": "Back to default",
  "own.ws.reset.note":
    "Clears the choice made here; this app's default applies again (ChatGPT with a ChatGPT account).",
  "own.ws.saved": "Web search now uses {choice}",
  "own.ws.saved.off": "Web search is off",
  "own.ws.saved.default": "Web search is back to the default",
  "own.ws.saved.multi": "Web search now asks several services together: {names}",
  "own.ws.codex":
    "In Codex style, GPT models on ChatGPT or OpenAI accounts use OpenAI's own search whatever is chosen here (that account's usage).",
  "own.ws.prices":
    "Prices as checked on 2026-10-19; they may change. Keys go in under a service's row and stay only in this PC's key store. A service with your key gets its own ‘(my key)’ row; the keyless row stays free.",
  "own.ws.failed": "Could not save the web search setting",
  "own.ws.readFailed": "Could not read the web search setting",
  "own.ws.noScope": "This connection cannot change the web search setting. Change it in the app on the PC.",
  "own.ws.unsupported": "The service does not know this setting. Restart it with the new version.",
  "own.ws.unknownService": "This server does not list that search service. The list was reloaded.",
  "own.ws.configUnavailable": "The config file (opencode.jsonc) cannot be read or written.",
  "own.ws.none": "This server lists no search service",
  "own.ws.hint": "Web search is going to a free service ({name}) · switch to your ChatGPT subscription?",
  "own.ws.hint.switch": "Use ChatGPT",
  "own.ws.hint.settings": "Web search settings",
  "own.ws.hint.dismiss": "Close",
  "own.ws.moved": "Choosing the search service is on the Web search page.",
  "own.ws.open": "Open web search settings",
  "own.ws.dock.noChatGPT": "Connect a ChatGPT account to search with your ChatGPT subscription.",
}

export const webSearchText = featureText(webSearchKo, webSearchEn)
export const useWebSearchText = webSearchText.use
