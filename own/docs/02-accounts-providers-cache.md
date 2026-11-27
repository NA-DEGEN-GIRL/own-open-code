# 02. 계정 · 프로바이더 · 한도 · 캐시 인지 전환 스펙

| 항목 | 값 |
|---|---|
| 문서 | `own/docs/02-accounts-providers-cache.md` (accounts-cache 핵심 스펙) |
| 상태 | 초안 v0.4 (2026-09-27). v0.3: 사용자 결정 D1–D8 반영(Codex 로그인 가져오기 3.2a, 자동 압축 기준 4.7, core 미기록 사용량 7.5, 클라이언트 무관·메서드 범위 9.1, 도구 집합 4.3 D10). v0.4: 리뷰 반영(압축·title 사용량 출처 7.5, D10을 세션 생성 때 새김으로 재작성, 자식 세션 규칙 5.11, revert 처리 4.7.4·5.9, 메서드 범위를 05 이름으로 9.1, 계정 소스 변경 경로 8.7, takeover 위험 3.2a, 승인 모드 RPC 9.2). 2026-09-28: 이전 앱에 저장된 API 키 연결(linked 전용) 3.2b, `accounts.import.keys.*` 9.2. 2026-10-02(06·07 T0 반영): 5.11 규칙 2를 07 §5.4 관문으로(T0에 구현), KV `sess:<root>:preset` 2.4.6, tool·agent hook 4.1, `presets.list`·`presets.defaults.set`·`worktree.inspect`·`presets.changed` 9.1–9.4, T0 프로토콜 변경 9.5. 2026-10-02(T1): 같은 회사 다른 구독·팀 모드·종량제 하위 에이전트 5.10, 관문 T1·읽기 전용 역할·세션 트리 기다리기·팀 거르기 5.11, KV `presetUsage`·`presetConsent` 2.4.6, 경보 7.7, 플러그인 순서 표 8.2, 프리셋·세션 프리셋 메서드 8개와 `teamOp`·`children`·`busyChildren`·컴퓨터 사용 allow와 자식 9.1–9.4, T1 프로토콜 변경 9.5. 2026-10-02(T2): 저장 파일 `presets.json`·`codex-meta.json` 2.3, 템플릿 표시 `addedAt`·`upstream`·`update` 2.4.1·2.4.2, codex 창의 메타데이터 층 3.6, 고정 템플릿 diff와 Codex 메타데이터 3.6a·3.8, 받아들이기·빼기·되돌리기의 delta 1 예외 4.3 D10, T2 경보 7.7, 프리셋 수리·없어진 메인·템플릿 갱신 필드 9.2–9.3, T2 프로토콜 변경 9.5. 2026-10-05(외부 저장소 조사 `own/reports/external-repos-2026-10-05.md` P1-5·P2-8·P1-3·P2-16): 호환되지 않는 schema 변경 규칙 2.3, 세션 사이 공유 prefix 정정 4.3 D10, DeepSeek 공식 가격과 피크 시간 2.4.4·6.2, 경보 `output_truncated`·`empty_completion` 7.7. 2026-10-06(결정 D3, P1-3c): 요금표 피크 시간대 `peak`, DeepSeek 금액을 요금표와 요청 시각으로 계산 2.4.4·6.2·7.5·9.5. 2026-10-09(IMPORT, 09): RPC id 다섯(`own.import`) 9.1, `estimate.request`(`read` 19개, 합계 69개)와 가져온 세션의 측정 제외 9.1·9.2, IMPORT 프로토콜 변경 9.5. 2026-10-09(NOTES, 05 §8.8): 워크스페이스 노트 `notes.{list,get,put,remove}`(`read` 2·`prompt` 2, 합계 73개)·이벤트 `notes.changed`(19개)·오류 `note_not_found`·`note_conflict`·`notes_limit` 9.1–9.4, KV `notes:*` 2.4.6, NOTES 프로토콜 변경 9.5. **2026-10-09(VOICE)**: 음성 입력(받아쓰기)의 전용 키와 인식 3.9, 저장 위치 `voice.json`·`vault\voice-<서비스>.dpapi` 2.3, 메서드 `voice.get`·`voice.set`·`voice.key.set`·`voice.transcribe`와 범위 9.1·9.2(`read` 1·`prompt` 1·`admin` 1·`local` 1, NOTES와 합쳐 77개), 오류 `voice_*` 9.4. **2026-10-10(여러 Claude 계정, 사용자 결정 C-D1–C-D3)**: 위험 8.1, 로컬 패치 8.2 2a단계, I9 8.3, `patchSha256` 동의 8.4, 계정마다의 한도 8.5, 여러 Claude 계정 8.7(이전 "계정 전환의 한계"를 바꿈), Claude↔Claude 자동 전환 8.8과 5.10 예외, 메서드 9.2. **2026-10-11(여러 Claude 계정 리뷰 반영)**: 패치 상태 `stale`·보관 원본·기록 먼저 쓰기·수리 8.2 2a, `patched`만 여러 계정·읽기 실패·플러그인 순서·로그인 없는 계정 거절·팀이 늦게 생긴 경우 8.7, 트리마다 한 번의 전환·`claudeToClaude`는 `auto|off`·옛 계정 소진은 세션에 알리지 않음·계정마다 사용 가능 판정 8.8·5.10. **2026-10-11(IDEAS)**: 전역 아이디어 노트 `ideas.{list,put,remove}`(`read` 1·`prompt` 2)·이벤트 `ideas.changed`·오류 `idea_conflict`·`ideas_limit` 9.1–9.4, KV `ideas:*` 2.4.6, IDEAS 프로토콜 변경 9.5. **2026-10-18(DF)**: 기본 대화 폴더 `conversationFolder.{get,set,ensure}`와 폴더 열기 시작 위치 `folderPicker.{get,set}`(`read` 2·`prompt` 1·`admin` 2, 코드 합계 102개)·이벤트 `conversationFolder.changed`·`folderPicker.changed`·오류 `conversation_folder_unavailable`·`folder_picker_unavailable` 9.1–9.4, KV `conversationFolder`·`folderPicker` 2.4.6, DF 프로토콜 변경 9.5. **2026-10-18(CB, 사용자 결정 "넣고 항상 켜기")**: Claude 구독 플러그인을 앱에 넣고 늘 켬 8.1·8.2(빌드 단계·번들 확인·옛 설치에서 옮기기·물러난 RPC), 로컬 동의 없음 8.4, 원격 동의는 번들의 pin 8.4a, `다시 로그인`과 연결 credential refresh(버그 1) 8.2·8.7, 메서드 9.2. **2026-10-19(CA, 사용자 결정 "최신 버전 자동 확인")**: Codex 모델 목록을 Codex 최신 릴리스 버전으로 묻기(07 §4.5), 저장 `codex-meta.json`의 `latest`·`autoVersion`·`rejected` 2.3, Codex 메타데이터 층 3.6a 6번, 메서드 `codexModels.{get,set}`(`read` 1·`admin` 1, 코드 합계 104개)·이벤트 `codexModels.changed` 9.1–9.3, CA 프로토콜 변경 9.5. **2026-10-19(CW, 사용자 결정 "경고 보이고 확인하기")**: 추가 사용량 위험과 약관 배경의 출처 8.1, 청구 판정·카드 경고·확인 방법·첫 요청 알림 8.9, 청구 판정 헤더 7.1·7.3, `claude_extra_usage`의 뜻 바로잡음과 `claude_first_request` 7.7, KV `claude:firstRequest:<accountID>` 2.4.6, CW 프로토콜 변경 9.5. **2026-10-19(SP, 병합 때 적음)**: DeepSeek·Brave 웹 검색 서비스와 Brave 키 9.2(`websearch.key.{get,set}`, `read` 1·`local` 1, CA와 합쳐 코드 합계 106개), 저장 `vault\websearch-brave.dpapi` 2.3, SP 프로토콜 변경 9.5. **2026-10-19(MS, 사용자 요청 "여러 서비스 함께")**: 여러 서비스 웹 검색 `own-multi` 9.2(`websearch.get/set`의 `multi`, 메서드 수 그대로), KV `websearch:multi` 2.4.6, MS 프로토콜 변경 9.5. **2026-10-19(OL, 사용자 결정 "코어 수정을 하면서 설정값으로")**: 출력 상한 설정 4.9, `policy.json`의 `outputLimit` 2.4.3, 4.1 hook 표의 session `context` 행(출력 상한이 맨 앞), `policy.set{patch.outputLimit}`과 `setting_out_of_range` 9.2(메서드 수 그대로), OL 프로토콜 변경 9.5, 코어 패치 P-032 10장, 의존 표 10.1 세 줄. **2026-10-23(SK, 사용자 결정 "키는 own vault에")**: 키를 받는 upstream 웹 검색 서비스(Exa, Firecrawl, Parallel, Tavily, TinyFish)의 키를 Brave처럼 own vault에 두고 own의 `own-<서비스>`가 그 키로 검색 9.2(`websearch.key.{get,set}`의 서비스 다섯, 메서드 수 그대로), 저장 `vault\websearch-<서비스>.dpapi` 2.3, SK 프로토콜 변경 9.5. **2026-10-24(CC, 사용자 결정 (1) P-034 승인 "바꾸기", (2) 자리 비움 압축은 켜는 선택지)**: 캐시를 이어 쓰는 요약 요청(대화 전체, P-034)과 그 판정 4.7.5, 자리를 비운 사이 압축 4.7.7, 캐시 시계를 요청 시작 기준으로 2.4.6, KV `sess:<sid>:idleCompaction` 2.4.6, `max_tokens: 0` 유지 요청 안 함 4.6, 압축 줄의 `compaction` 7.5, ⑥ `h_c` 6.3, CC 프로토콜 변경 9.5. **2026-10-24(CC 실측 반영, CC-12–CC-15)**: 전체 요청을 breakpoint 캐시(Anthropic, Claude 구독, lookback이 있는 OpenAI GPT-5.6+)에서 최근 부분이 lookback보다 길고 older 끝 항목이 식었을 수 있을 때로 좁힘·고정 생각 예산 제외·실제 창으로 맞춤·기록 바로잡음 4.7.5, 화면에 띄운 대화는 자리 비움이 아님(`session.presence`, `read` 1, 코드 합계 107개)·취소와 재시작 뒤 표시 4.7.7·9.1·9.2, ⑥ `h_c`와 계산 예 6.3·6.4. **2026-10-24(CC 리뷰 반영, CC-16)**: 전체 요청을 Anthropic 엔진(API 키·Claude 구독)으로만 좁힘(OpenAI GPT-5.6+는 실측 전까지 older, `unmeasured`)·판정이 없으면 older·대체 모델의 요약은 `older`/`stand-in`·ChatGPT 실측을 있는 그대로 4.7.5·6.3 ⑥·7.5, 자리 비움 압축을 hook에서 대화 기록으로 알아봄·늦게 전달된 것은 버림·자리 비움 감지 시간 4.7.7·2.4.3·2.4.6·9.2, CC-16 프로토콜 변경 9.5. **2026-10-24(DS, 사용자 요청 "적용가능하다면 넣도록해")**: DeepSeek 공식 API에는 빠른 tier가 없어 넣지 않음(문서와 실측, 코드 변경 없음) 4.8 `쓸 수 있는 속도`. 같은 날 고침: 들은 "DeepSeek Ultrafast"는 Fireworks 모델 id(`compat` 계정), OpenAI Ultrafast 모델(GPT-6 Astra·GPT-6.1 Sol), Telnyx는 DeepSeek에 Flex. **2026-10-24(RC, core P-035)**: 문맥 비우기와 그 되돌리기를 cold point로 봄(epoch, slot 캐시 기준선, 측정 크기를 모름) 4.7.4·2.4.6, prefix 원인 `reset`·`reset-undo` 7.8.1. **2026-10-25(RC 2차)**: 분배기 하나가 비우기를 알아봄(재시작 뒤에도), 비운 뒤·되돌린 뒤 전환 추정의 `P` 4.7.4. **2026-10-25(RC 4차)**: COMPACTING의 `compact-then-switch`는 문맥 비우기의 전달에서 전환으로 넘어감 4.7.4, 5.4. **2026-10-25(RC 5차)**: core가 비우기의 전달에서 그 뒤에 넣은 압축도 필요 없음으로 정리, 비우기가 기다리는 동안 `compaction.due`를 내지 않음 4.7.4. **2026-10-25(RC 6차)**: 이벤트 스트림을 다시 구독한 뒤에는 그 판정이 놓쳤을 수 있는 비우기의 전달·취소와 압축의 끝을 서버에서 다시 읽음 4.7.4. **2026-10-24(SM, 사용자 요청 "설정에서 MCP 설치·스킬 가져오기")**: own이 더하는 MCP 서버와 목록 스위치 유지, 연결 시험, 다른 도구(Codex, Claude Code)의 MCP 설정 가져오기 9.2(`mcp.*` 7개, `admin` 1·`local` 6, 코드 합계 114개)·이벤트 `mcp.changed` 9.3·오류 `mcp_name_taken`·`mcp_not_found`·`mcp_secret_missing`·`mcp_invalid` 9.4, 저장 `mcp.json`·`vault\mcp-<id>.dpapi` 2.3, 비밀을 받는 메서드 9.1, SM 프로토콜 변경 9.5. **2026-10-25(SM 리뷰 2, SM-22)**: 인자 안의 값(환경 변수 쌍·헤더·주소·아는 도구의 짧은 플래그·더 긴 인자 안의 키)과 Claude Code가 쓴 주소의 값 조각, vault가 다시 답하면 다시 읽기와 `mcp.changed`, 서버가 닿던 곳의 목록 스위치만 바꾸기, 연결 시험의 서버 이름·도구 설명 가리기, `mcp.list{directory}`의 `errors`(core 오류 글에서 값을 뺀 것), 같은 정의의 다른 값(`also[].differs`·`values`, `Pick.place`)과 값이 든 주소의 keyed hash, 가져오기의 vault 먼저·nonce 되돌리기, 레지스트리 답의 한도(조각 읽기 4 MiB, 개수, 자르는 글과 빼는 방법, 긴 `nextCursor`, 버전 없는 항목) 9.2·9.3. **2026-10-25(SM 리뷰 3, SM-25)**: mcp-proxy의 두 인자 헤더, JSON 객체 인자, `${이름:-기본값}`과 `${이름}글자`, base64 경로 조각을 키 저장소로, `${이름:-기본값}`의 뜻, 연결 시험은 비밀인 값만 가림 9.2. **2026-10-26(SL, 사용자 요청 "cl02 cl03으로해도 cl01이 한것처럼 표기되는데, 실제 버그인지 표기 버그인지 확인")**: 표기 버그(경로는 맞음). 압축 줄의 `messageID`는 압축 메시지 7.5, KV 캐시 항목과 `cache.state` slot의 `accountID`(서명한 계정, 화면은 그 계정에만 캐시 상태를 보임) 2.4.6·9.2, SL 프로토콜 변경 9.5. **2026-10-26(CR, 사용자 질문 "왜 AC-01이랑 02 03이랑 다르게 동작하는지")**: own 전용 로그인의 갱신이 모두 같은 까닭(토큰 끝점의 429)으로 실패했고 AC-01만 다른 코드는 없음 8.7, 갱신 요청을 Claude Code 2.1.282의 것으로(헤더·`scope`·POST 한 번·답 읽기·되쓰기)·400/401/403은 기다리지 않는 끝난 실패·`claude -p` 대체 없음·`ownOnRefresh`·`ownAccounts().refresh`·거절 문구 8.2 3번, 카드의 갱신 줄 `claude.refresh`(`Account.ClaudeRefresh`)·`account.status{reason: "claude_refresh"}`·`own-accounts.log` 기록 8.7, 첫 요청 알림은 답이 온 요청에 8.9·2.4.6. **2026-10-27(SL-8)**: 서버의 캐시 판정을 서명한 계정 단위로: Claude 계정마다의 캐시 항목 `sess:<sid>:cache:anthropic@<accountID>` 2.4.6, `cache.state`의 Claude 계정마다 slot 9.2, 캐시를 이어 쓰는 요약 요청의 판정 `account` 4.7.5, 자리 비움 압축의 `account` 4.7.7, 전환 추정의 대상 Claude 계정(`switch.estimate{accountID}`) 8.7·9.2, SL-8 프로토콜 변경 9.5. **2026-10-27(SL-17)**: 대기·예약 전환 기록(WAIT_SAFE·COMPACTING·SCHEDULED·SWITCHING)과 전환 추정의 대상이 닿을 Claude 계정 `accountID` 5.4·9.2, 재시작 뒤에도 캐시 판정(전환 추정, `cache.state`, 속도 추정)은 대화 트리의 binding으로 계정을 읽음 8.7·9.2, SL-17 프로토콜 변경 9.5. **2026-10-26(RP, 사용자 요청 "reset 권 … 표기가 가능하고 쓰는게 가능하다면 그 동작도")**: ChatGPT 구독(`codex`)의 리셋권 수를 `wham/usage`에서 읽어 보이고, 사용자가 확인한 뒤에만 쓴다 7.1·7.1.1, Claude 리셋권은 보이지도 쓰지도 않고 링크만 8.5, `quota.resetCredits.list`·`redeem.plan`·`redeem.execute`와 범위 9.1·9.2, `quota.snapshot`·`quota.updated`의 `resetCredits` 9.2·9.3, `not_supported`·`credential_not_ready`·`limit_reset_failed` 9.4. 2026-10-27(RP-13): `/consume`을 보낸 뒤의 `list`는 답이 없었어도 다시 읽고, 쓴 뒤 읽기에 수가 없으면 수를 모름으로 둔다(`quota.updated`의 `resetCredits: null`) 7.1.1·9.2·9.3, `credential_not_ready`의 `cause` 9.4. **2026-10-26(SG, 사용자 요청 "스킬·MCP는 전역으로 설치하고 안 쓸 프로젝트에서 따로 끄기")**: 스킬 스위치와 쓰는 곳(`skillset.view`·`skillset.switch`, `read` 1·`admin` 1, 코드 합계 118개)·이벤트 `skillset.changed`·오류 `skillset_invalid` 9.1–9.4, 저장 `skill-switches.json`과 `mcp.json` version 2(전역 스위치) 2.3, MCP 목록의 전역 스위치·`null`로 지우기·물려받는 값은 저장하지 않음·`mcp.summary`의 `overrides` 9.2, SG 프로토콜 변경 9.5. **2026-10-26(SG 리뷰)**: version 1 `mcp.json`을 읽을 때 올림 2.3·9.2, 쓰는 곳이 안에 든 스킬과 납작한 스킬 파일에 닿음 9.2, 스킬 스위치 뒤 own-web이 읽은 모든 스킬 목록을 낡은 것으로 표시 9.2·9.3, 가져올 때 고른 쓰는 곳(`바꾸기`도, `모든 프로젝트`는 남은 것을 지움) 9.2. **2026-10-27(MR7, 병합 7회차)**: 쓴 뒤 읽기에 수가 없으면 수를 지운 다음 창을 알린다 7.1.1(MR7-3), 속도 추정이 Claude 슬롯과 Anthropic 키의 Fast 가격을 찾는다(모드 항목의 `speed`는 보낸 그대로 비교한다, SL-22) 4.8(MR7-7), RP 메서드 3개의 항목과 병합한 판의 메서드 121개 9.2(MR7-28). **2026-10-30(RR, 요금표 갱신)**: Anthropic Sonnet 5.5·Haiku 5.5(100k 이하 단가, 긴 프롬프트 구간은 모델링하지 않음)·Fable 5.1 카드, OpenAI API 5.6+와 xAI의 cache read를 카탈로그 값으로(`readMul` 뺌, GPT-6.1 0.05·r_in), Codex GPT-6 Astra credit 카드 2.4.4·6.2. **2026-10-31(CAG-5, 사용자 결정 C-D3 기본값 철회)**: `autoSwitch.claudeToClaude`의 새 설치 기본과 값이 없을 때의 대체값을 `off`로, 이미 있는 `policy.json`은 그대로 2.4.3·5.10·8.1·8.7·8.8. 2026-10-31(CAG): Claude Agent 경로(8.10)를 0·1단계로 더했다. kind `claude-agent`, 계정 폴더 하나, 코어 P-045·P-039·P-042, RPC `claudeAgent.*`(9.2). 2026-11-01(MR9, 병합 9회차): GitHub 연결(16)의 `github.*` 10개를 9.1 범위표에 합쳐 메서드 142개. 2026-11-04(UPD): 외부 도구 업데이트(05 §20)의 `tools.*` 5개(`local`)를 9.1 범위표에 더해 메서드 147개. 2026-11-04(병합 11회차, MR13): IM의 `image.get`·`image.clear`와 LMT의 `accounts.local.detect`까지 합쳐 메서드 150개 |
| 기준 소스 | fork base upstream v2 `00d179015f` (루트 `package.json` 2.0.18) |
| 대상 패키지 | 이름은 01 §4·`own/FORK.md` §1과 같다.<br>- `packages/own-accounts`(`@own/accounts`, 플러그인 id `own.accounts`). **RPC id `own.accounts`**의 핸들러를 등록한다<br>- `packages/own-telemetry`(`@own/telemetry`, 플러그인 id `own.telemetry`)<br>- `packages/own-protocol`(`@own/protocol`, 브라우저·서버 공용). RPC id `own.accounts`의 정의(`Rpc.PortableDefinition`)와 공용 스키마(Account, ProviderSlot, LimitWindow, LedgerLine, SwitchState …)<br>- `packages/own-runtime`(`@own/runtime`, 서버 전용). 프로세스 싱글턴(빌드 id 키, 참조 카운트, 파일 락), vault client, 파일 저장소, ledger writer, lastResponse 저장소, refresh single-flight, 해시 유틸<br>- 소비자 `packages/own-web`(`@own/web`). 데스크톱 앱 `packages/own-desktop`(Electron 셸, 01)의 렌더러, 웹 폴백, 이후 모바일 클라이언트가 모두 같은 own-web 코드로 이 RPC를 부른다. 셸(Electron main)은 이 문서의 로직을 갖지 않는다(9.1)<br>- `packages/own-remote`(`@own/remote`, RPC id `own.remote`, 04). 원격 세션도 이 문서의 상태 머신·ledger·압축 규칙을 그대로 쓴다<br>- 소비자 `packages/own-import`(`@own/import`, RPC id `own.import`, 09). `estimate.request`(9.2)를 loopback으로 부르고, 그것이 가져온 세션은 Z·로컬 창 측정에서 빠진다<br>- 설정의 플러그인 순서: `[own.accounts, own.remote(04, 설치 시), own.team(06, 나오면), heymaaz.claude-auth-v2(선택 슬롯), own.telemetry, own.computer-use(01 §10.2), own.import(09 §5.1)]`(8.2) |
| 관련 문서 | `01-architecture.md`(구성·보안·원장·데스크톱 셸), `own/FORK.md`(포크 운영), `03-ui-ux.md`(화면·문구), `04-ssh-remote.md`(SSH 원격, RPC id `own.remote`), 05(원격 접근·모바일, 별도 문서. 기기 pairing·게이트웨이·푸시는 05가 기준). 이 문서가 계정·캐시·한도·압축 기준의 데이터·정책·RPC 계약 기준이고, 03은 표시를 정한다. RPC id `own.accounts`의 메서드·이벤트 목록은 이 문서 9장이 유일한 기준이며, 01 §15와 03 §16.3은 그 목록을 쓴다. `own.remote`의 목록은 04 §16이 기준이다 |

**근거 표기**
- `core/src/x.ts:10-20`처럼 적은 경로는 `D:\own-open-code\packages\` 기준이다. upstream 파일은 fork base `00d179015f`와 같고, `own-*` 패키지는 `ba9ed4e9dd` 기준이다(`D:\#Projects\own-open-code`는 쓰지 않는다). 로컬 소스가 리서치 파일과 다르면 로컬 소스를 따랐다.
- `[R-design]` 등은 세션 리서치 파일이다(scratchpad `C:\Users\<user>\AppData\Local\Temp\claude\D---Projects-own-open-code\74c66f49-...\scratchpad\`).
  - `[R-design]` cache_design.md
  - `[R-verify]` cache_verify.txt
  - `[R-report]` report.md
  - `[R-critique]` critique.md
  - `[R-claudeauth]` claudeauth.json
  - `[R-terms]` terms.json
  - `[R-omo]` omo_summary.txt
  - `[R-codex-rl]` scratchpad `pc/codex-rs_codex-api_src_rate_limits.rs`
  - `[R-desktop]` desktop_verdict.md(own-desktop 타당성 결론, 권위 있음), desktop_build.md
  - `[R-gap]` gap_final.md(v2 기능 격차 목록)
  - `[R-modelsdev]` modelsdev.json(models.dev 스냅샷, 2026-09-26. 4.7의 창 크기 예시)
- **⚠미검증**: 소스나 1차 문서로 확인하지 못한 가정이다. 괄호 안 `AC-Pnn`은 확정할 PoC 번호다(11장).

---

## 1. 핵심 결정 요약

1. **providerID = 캐시 도메인.**
   - 캐시가 공유되지 않는 두 계정은 절대 같은 providerID를 쓰지 않는다.
   - MVP에서는 계정 하나가 providerID(=slot) 하나를 쓴다.
   - 같은 도메인 안에서 여러 credential을 요청마다 돌리는 풀링은 kind별 교차 재생 PoC를 통과한 뒤에만 켠다.
   - providerID는 `own-<kind>-<slug>` 형식이며 만든 뒤 바꾸지 않는다.
   - identity system part의 `Provider ID` 줄은 slot 중립 값으로 정규화한다(D9). 그래야 같은 도메인의 slot끼리 `Z + u_1`까지 prefix가 같다.
2. **비밀은 우리 vault(Windows DPAPI)에만 둔다.** vault 입출력은 Rust helper `own-vault.exe`가 한다(01 §13.1). 요청 시점에 `model.request` hook으로 인증 헤더를 넣는다.
   - 이를 위해 계정 provider가 core의 `Auth.none` 경로를 타도록 설정한다(3.6, 4.2).
   - 복호화한 값은 프로세스 메모리 캐시에서 읽는다. hot path에서는 helper를 기다리지 않는다(2.4.5).
   - OpenCode `credential` 테이블(평문)은 Claude 구독 슬롯(서드파티 플러그인 자체 동작)과, 명시적으로 켜고 UI에 따로 표시하는 대체 모드(3.7)만 쓴다.
   - linked로 가져온 ChatGPT 계정(3.2a)은 이전 앱의 `auth.json`을 읽기만 하고 우리 쪽에 복사하지 않는다.
3. **ChatGPT 로그인은 우리 플러그인이 직접 하거나, 이전 앱(codex-multi-provider)의 로그인을 가져온다**(3.2, 3.2a). 새 로그인의 기본은 device code다.
   - 토큰 계열 하나에는 refresher 하나만 둔다: 프로세스 안 single-flight와 프로세스 사이 lease 파일.
   - 가져오기의 기본은 **linked**다. 이전 앱 프로필의 `auth.json`을 읽기만 하고 절대 쓰거나 refresh하지 않는다. 이전 앱이 유일한 refresher로 남는다. **takeover**를 고르면 토큰을 vault로 한 번 옮기고 그때부터 우리가 유일한 refresher다.
   - Codex CLI 자체의 `~/.codex/auth.json`, Codex 앱, 내장 `openai` 로그인과는 여전히 토큰을 공유하지 않는다.
4. **계정 provider는 업스트림 배선을 재현한다.** 내장 ChatGPT 설정은 `openai` ID에만 걸려 있기 때문이다(`core/src/plugin/provider/openai.ts:254-309`).
   - 정적 설정: native package, `canonical`, baseURL, transport, `compaction:{type:"summary"}`
   - 요청 시점 헤더: Authorization, `chatgpt-account-id`, `session-id`
   - 모델 정의는 **고정 템플릿**(pinned model template)으로 복사한다.
5. **계정 전환과 프로바이더/모델 전환은 하나의 상태 머신으로 다룬다.**
   - 트리거는 세 가지뿐이다: 수동, hard 한도 소진, 인증 실패. 일시적 429와 사용률 임계값은 트리거가 아니다.
   - 전환은 safe point(유휴)에서만 한다. cooldown과 circuit breaker를 둔다.
   - 선택지: 지금 / 압축 후 / 전환 후 압축 / cold point 예약 / 곁가지 포크 / 새 세션 인계
   - 상태 머신은 own-accounts가 소유한다. 플러그인이 할 수 없는 HTTP 동작(compact, fork, 새 세션)은 프런트엔드가 실행한다.
6. **구독 계정에서 나가는 자동 전환은 하지 않는다.** 구독끼리(`ask|off`)와 구독→종량제(`ask|off`) 모두 제안만 한다. 01 §1.2·§8.6과 같다. 구독끼리 자동으로 돌리면 약관상 한도 우회로 볼 여지가 있다[R-critique #4].
7. **비용 추정은 범위로 낸다.**
   - 추정기는 TTL 하한/상한, lookback, 압축 요청 자체의 cold 가능성을 반영한다.
   - 결과는 "지금 +X / 압축 후 +Y / N분 후 +0" 형태다.
   - 구독 한도 %는 보정이 끝나야 점 추정으로 보여 준다.
8. **한도·사용량은 수동(passive)으로 수집한다.** own slot은 own-accounts가, Claude 구독 슬롯(`anthropic`)은 own-telemetry가 관측한다(01 §3.1·§14.1).
   - own-accounts: 읽기 전용 `http.response`·`experimental.ws.receive` hook(setup 1회, unscoped, slot 레지스트리로 거름), step·usage 이벤트 구독, 선택적 잔액·키 조회(leader poller)로 모은다.
   - own-telemetry: claude-auth **뒤**에서 `anthropic` 응답의 unified 헤더만 모은다.
   - 둘 다 공통 `LimitWindow` 모델로 정규화하고, step 단위 ledger(JSONL)에 남긴다. 파일 쓰기는 `@own/runtime`의 ledger writer 하나로 한다(01 §4).
   - Codex 한도를 WS 경로에서 못 얻으면(AC-P15 실패) 그 slot을 HTTP transport로 돌린다. 코어 패치 없이 매 응답 헤더를 얻는다(3.6, 7.1).
9. **Claude Pro/Max = 서드파티 플러그인 슬롯.** 사용자가 설치하는 플러그인 `opencode-claude-auth-v2`가 쓰는 `anthropic` provider를 예약해 둔다.
   - 격리 규칙 8개를 지킨다(8.3).
   - `anthropic`은 플러그인이 감지되고 위험 고지 동의가 기록된 경우에만 활성이다. 그 밖에는 비활성이다(8.4).
   - UI에는 읽기 전용 합성 계정 `acc_claude_slot`으로 보인다(9.2).
10. **이 문서의 프런트엔드 계약은 own-accounts가 등록하는 RPC id `own.accounts`와 `rpc.own.accounts.*` 이벤트다**(9장, T1 기준 메서드 63개·이벤트 17개). SSH 원격의 `own.remote`는 04 §16, 팀 모드의 `own.team`은 06 §2.7, 컴퓨터 사용의 `own.computer`는 01 §10.2가 정한다. 전역 호출은 control location으로 보낸다(01 §2·§15).
11. **이 문서 범위(계정·캐시·한도·압축 기준·가져오기)에는 코어 패치가 필요 없다.** UI 임베드(웹 폴백)에는 01 §12의 P-001/P-002가 필요하다. 데스크톱 셸이 주 클라이언트가 되면서 이 둘은 웹 폴백 용도로 격하된다([R-desktop] §6, 01). 패치는 원장 ID로 적는다(10장). P-007·P-008·P-009는 rejected다. P-004·P-005는 게이트가 실패할 때만, P-006·P-011·P-013은 Phase 3에서, P-012는 대체 모드(3.7)를 켤 때만 검토하는 candidate다.
12. **책임 분담의 원칙은 01 §3.1과 같다.** own-accounts는 요청을 만들고, own slot 응답을 읽기 전용으로 관측해 한도·ledger를 기록하고 hard 소진을 판정하며, 전환을 결정한다. own-telemetry는 claude-auth 뒤에 등록되어야 하는 유일한 관측인 `anthropic`(Claude 구독 슬롯)의 최종 응답만 관측하고, 그 슬롯의 긴 멈춤 방지 retry 결정을 한다. 둘은 `own-runtime` 싱글턴으로 상태를 주고받는다(2.3, 4.1).
13. **자동 압축 기준은 own slot 모델의 실효 창(`limit.input`)으로 정한다**(4.7). core 식 `ceiling(ctx) = ctx − max(floor(0.15·ctx), 16k)`(`ctx = limit.input || limit.context`, 16k는 창이 32k 이상일 때만. upstream v2.1의 `RESERVE_SHARE` 0.15부터, 그전에는 0.1(d9987ef9c8), 그보다 전에는 `floor(0.9·ctx)`. `core/src/session/compaction.ts` calculateCeiling)는 그대로 두고, 우리가 등록하는 모델의 `limit.input`만 바꾼다. 코어 패치가 없다.
   - 설정은 kind 기본 → kind×모델 → 계정 → 계정×모델 → 세션 순으로 푼다. 세션 값은 "더 일찍"만 되고, 기준에 닿으면 own-accounts가 revert가 없음을 확인한 뒤 플러그인 `ctx.session.compact`(upstream 924c12b291)로 서버에서 압축을 넣는다. 연결된 클라이언트가 없어도 된다. `compaction.due` 이벤트는 알림으로 남는다(4.7.4, 2026-10-08).
   - 모든 kind가 v2 기본값(core ceiling. 창에서 15%와 16k 중 큰 쪽을 남김, 큰 창은 85%)이다(07 §6.1, US-1 2026-10-30: upstream v2.1의 15%를 따르고 core를 10%로 되돌리지 않는다). 단 compat는 창의 90%다(upstream d9987ef9c8 전의 core 규칙). 흔히 작은 로컬 창이라 16k를 남기면 32,768 창이 16,768(51%)에서 압축되기 때문이다(R8, 4.7.3). 창은 살아 있는 카탈로그 값이고(07 §4.4) 짧게 잡지 않는다. overflow 오류가 core 분류에 맞지 않을 수 있는 compat는 창을 줄이지 않고 계정 카드에 경고를 보인다(07 §6.2 #2, PG9). `keep`은 core 전역 값 하나라 kind마다 다르게 둘 수 없다. 전역으로 줄이는 것(모든 kind에 적용)과 P-014 중 무엇을 할지는 사용자 결정이다(4.7.6, Q29).
14. **ledger는 플러그인이 core 이벤트로 받지 못하는 사용량도 센다**(7.5).
   - 세션 `generate`(/btw 곁질문, warming ping, 새 세션 인계 요약)는 core가 로그만 남긴다(`core/src/session/generate.ts:64`).
   - title 요청은 core가 `session.usage.recorded`로만 남기는데, 이 이벤트는 공개 manifest에 없어 플러그인에 오지 않는다(`schema/src/session-event.ts:618,707-711`, `core/src/plugin/host.ts:255-265`).
   - 그래서 own-accounts가 `http.response{kind:"generate"|"title"}`에서 응답 사본의 SSE usage를 읽어 적는다. 압축 사용량은 공개 이벤트 `session.compaction.ended/failed`의 `tokens`·`cost`에서 얻는다.
15. **클라이언트와 무관하다.** 계정·전환·캐시·한도·압축·SSH 세션 로직은 모두 서비스 안 플러그인에 있다. 데스크톱 셸(own-desktop), 웹 폴백, 이후 모바일은 같은 RPC를 부르는 얇은 클라이언트다.
   - 도구 집합은 **세션을 만들 때** 정해지고, 그 뒤 어느 클라이언트가 붙었는지나 브라우저 호스트 연결 여부로 바뀌지 않는다(4.3 D10, 규칙의 소유는 05 §8.7).
   - 원격 기기(모바일 등)는 05의 기기별 토큰으로 들어오고, `own.accounts` 메서드는 05 §13.5의 범위 이름(`read|switch|admin`)과 원격 금지 `local`로 제한한다(9.1).

---

## 2. 도메인 모델

### 2.1 개념

```
ProviderKind  codex | siwc | oai | anth | ds | xai | or | compat | claude-sub | claude-agent
     │
     ├── QuotaDomain (한도·지출이 합산되는 경계)  ──<  Account  >──  CacheDomain (서버 캐시가 공유되는 경계)
     │                                                 │ 1..N (MVP: 1)
     │                                          ProviderSlot  providerID = own-<kind>-<slug>
     │                                                 │ models = pinned template
     │                                                 ▼
     └──────────────────────────────  Session.model = {providerID, id, variant}   ← 세션의 계정 바인딩
```

| 개념 | 정의 | 저장 |
|---|---|---|
| **ProviderKind** | 인증 방식, 프로토콜, 한도 신호가 같은 묶음 | 코드 상수 |
| **CacheDomain** | 서버측 prompt cache가 공유되는 경계. 예: ChatGPT 로그인, OpenAI org, Anthropic workspace | `accounts.json.cacheDomains` |
| **QuotaDomain** | 한도와 지출이 합산되는 경계. 예: ChatGPT seat, OpenAI org(+project), Anthropic org | `accounts.json.quotaDomains` |
| **Account** | 사람이 인식하는 로그인 또는 키 하나. id는 `acc_<ulid>`이고 바뀌지 않는다. 라벨, 약칭, 색을 가진다 | `accounts.json.accounts[]` |
| **ProviderSlot** | OpenCode에 등록하는 provider 하나. providerID는 cache domain을 대표한다 | `accounts.json.slots` |
| **vault 항목** | 계정 하나의 비밀. 키는 accountId다(01 §7·§13과 `own/native/own-vault/README.md`도 같음). linked 가져오기 계정은 vault 항목이 없다(3.2a) | `vault\<accountId>.dpapi` |
| **Claude 슬롯 합성 계정** | 서드파티 슬롯을 UI에서 계정처럼 보이게 하는 읽기 전용 항목. id `acc_claude_slot`, providerID `anthropic` | `accounts.json.claudeSlot`(메타데이터만) |
| **세션 바인딩** | 세션의 현재 `Model.Ref`가 곧 바인딩이다. `ModelSelected` 이벤트로 이미 영속된다(`core/src/session/session.ts:97-109`) | 추가 저장 없음. 이력은 ledger |

- **계정과 세션의 대응**
  - MVP에서는 slot 하나에 계정 하나다. 따라서 `step.started.model.providerID`만 보면 그 step을 어느 계정이 처리했는지 안다(`schema/src/session-event.ts:332-344`).
  - 풀링을 켜면 플러그인이 요청마다 쓴 credential을 ledger에 적는다. 코어 이벤트에는 credential 정보가 없다(`schema/src/session-error.ts:7-11`, 이벤트 스키마 전반).
  - **자식 세션(하위 에이전트)도 자기 바인딩을 가진다.** 새 자식의 모델은 `input.model ?? agent.model ?? parent.model`이고(`core/src/tool/plugin/subagent.ts:184`), `input.model`은 LLM이 고른다. 그래서 자식이 부모와 다른 계정으로 갈 수 있다. 규칙은 5.11이다.

### 2.2 providerID 규칙

- **R-ID-1. providerID는 캐시 도메인을 나타낸다.** 캐시 도메인이 다른 계정이 같은 providerID를 쓰면 안 된다.
  - 이유 1: core는 `providerID`와 model id가 모두 같을 때만 이전 턴의 reasoning, encrypted content, item id, signature를 다시 보낸다(`core/src/session/runner/to-llm-message.ts:153-156`). 같은 providerID로 계정을 바꾸면 A의 암호화 상태가 B로 재생된다.
  - 이유 2: 그렇게 재생하면 org 불일치 계열 오류가 보고되어 있다[R-report §3.2(2)].
- **R-ID-2. 같은 도메인에 계정이 둘 이상이면 PoC 전까지는 계정마다 slot을 따로 만든다.**
  - 한 slot에 묶는 풀링은 그 kind의 교차 재생 PoC(AC-P33/34/35)가 통과한 뒤에만 켠다.
  - slot이 따로면 같은 도메인끼리 전환해도 prefix가 달라진다. 원인은 두 가지다.
    - identity system part에 providerID가 들어간다(`core/src/plugin/identity.ts:9-16`, `splice(1,0,…)`은 `:27`). **D9 정규화(4.3)로 이 차이를 없앤다.** 정규화가 없으면 system[1]부터 갈라진다.
    - 상대 slot 턴의 reasoning·signature·item id가 빠진다(`core/src/session/runner/to-llm-message.ts:153-156`). 이것은 없앨 수 없으므로 첫 assistant 메시지부터 갈라진다.
  - 그래서 비용 모델은 "같은 도메인 = 무료"로 보지 않는다. 재사용 상한은 `Z + u_1`이다(6.3 ①, [R-verify] critical #1).
- **R-ID-3. 형식은 `own-<kind>-<slug>`다.**
  - `kind`는 `codex|siwc|oai|anth|ds|xai|or|compat` 중 하나다.
  - `slug`는 4–8자 `[a-z0-9]` 난수이며 만든 뒤 바꾸지 않는다. 사용자가 slug를 정하지 않는다(01 §8.1과 같음).
  - **한 번 쓴 providerID는 재사용하지 않는다.** 계정을 삭제해도 slot을 `retired`로 남긴다(01 §8.1, 9.2 `accounts.remove.*`).
  - 라벨, 이메일, 조직명은 넣지 않는다. providerID는 system prompt(`identity.ts:13`)와 재생 판정(`to-llm-message.ts:154`)에 쓰이므로, 바꾸면 그 세션의 과거 턴이 모두 외부 provider 이력이 된다.
  - `/`와 `#`는 쓰지 않는다(`Model.Ref.parse`, `schema/src/model.ts:25-38`).
- **R-ID-4. 예약 ID**
  - `anthropic`은 Claude 구독 슬롯 전용이다(8장).
  - models.dev가 쓰는 ID(`openai`, `anthropic`, `deepseek`, `xai`, `openrouter` 등)에는 우리 계정을 올리지 않는다.
    - ModelsDev가 이 ID마다 key·env integration을 만든다(`core/src/plugin/models-dev.ts:34-59`). 그러면 `Auth.none` 조건인 "connection 없음"이 깨지기 쉽다(`core/src/model-resolver.ts:361-364,374-380`).
  - `own-` 접두어를 쓰면 이런 충돌이 원천적으로 생기지 않는다.
- **R-ID-5. 이름 규칙**
  - `provider.name`(표시명)에는 라벨을 넣어도 된다. 예: "ChatGPT · 업무".
  - `model.name`에는 계정 라벨을 넣지 않는다. identity가 `model.name`을 system prompt에 넣기 때문이다(`identity.ts:9-16,22-26`).

**kind별 규칙**

| kind | providerID 예 | CacheDomain | QuotaDomain | 풀링(MVP) | 교차 재생 |
|---|---|---|---|---|---|
| `codex` (ChatGPT Plus/Pro/Business) | `own-codex-7k2m` | ChatGPT 로그인 1개(`chatgpt-account-id` + 사용자). 계정별 격리는 정황 3개로 추정한 것이고 문서는 없다[R-design 1.1] ⚠ | seat: 5h·주간 창과 credits | 금지 | 같은 Business workspace의 seat끼리 캐시와 encrypted item을 공유하는지 미확인(AC-P34). 공유되더라도 자동 회전은 약관 위험이 있다(5.10) |
| `siwc` (Sign in with ChatGPT, 토큰 공유) | `own-siwc-s4c8` | 발급 client(사용자 + workspace 하나)마다 따로(`chatgpt_sharing`, 3.2c). codex 로그인과 공유하지 않는다 | `chatgpt_sharing`(발급 client). ChatGPT 요금제 사용량과 앱별 주간 상한. codex seat 창과 합산되는지 ⚠ | 금지 | 미확인 ⚠ |
| `oai` (OpenAI API key) | `own-oai-q9x1` | organization. "Caches are not shared across organizations"[R-verify]. project/key 사이 공유는 ⚠ | org(+project)의 RPM·TPM. cached 토큰도 TPM에 포함된다[R-verify] | 키 1개/slot. 같은 org 키 풀링은 AC-P35 이후 | `encrypted_content`는 org에 묶인다[R-report] |
| `anth` (Anthropic API key) | `own-anth-w3p8` | workspace[R-verify] | org(rate, spend). workspace 한도는 더 낮게만 설정할 수 있다[R-verify #4] | 키 1개/slot. 같은 workspace 풀링은 AC-P33 이후 | 다른 키에서 signature가 통하는지 ⚠ |
| `ds` (DeepSeek) | `own-ds-m2r5` | user[R-design] | 계정 선불 잔액 | 키 1개/slot | reasoning은 평문 `reasoning_content`로 재생된다(`ai/src/protocols/openai-chat.ts:455-480`). 위험이 낮다 |
| `xai` | `own-xai-c8d1` | 문서 없음. 키 단위로 가정[R-design] ⚠ | team | 키 1개/slot | ⚠ |
| `or` (OpenRouter) | `own-or-h4t6` | 상위 provider와 OpenRouter 라우팅에 따른다. 키 단위로 가정 ⚠ | 키 credit limit, 계정 credits | 키 1개/slot | ⚠ |
| `compat` (기타 OpenAI 호환, Base URL + 키) | `own-compat-b5n0` | 키 단위(보수적) | 알 수 없음. 로컬 집계만 | 키 1개/slot | ⚠. reasoning 재생 여부는 서버마다 다르다 |
| `claude-sub` (서드파티 슬롯) | `anthropic` (고정). 합성 계정 `acc_claude_slot` | Claude 계정 | unified 5h·7d 창 | 1개. Windows에서 가져올 수 있는 계정이 1개뿐이고, v2는 integration당 active credential이 1개다 | 해당 없음 |
| `claude-agent` (Claude Agent 경로, 8.10) | `claude-agent` (upstream 내장, 고정). 계정 `accounts.json` `claudeAgents[]`(`acc_<ulid>`) | Claude 계정(같은 계정도 claude-auth와 요청 바이트가 달라 캐시는 따로) | unified 5h·7d·모델별 주간 창(claude가 스트림과 사용량 질문으로 알림, 8.10.4) | 1단계는 계정 1개. 2단계에서 여러 계정(손 전환만) | 해당 없음 |

### 2.3 저장 위치

`OWN_HOME`은 다음 순서로 정한다.
- Windows 운영: `%LOCALAPPDATA%\own-open-code`(01 §5.1 설치 레이아웃과 같은 루트)
- Windows 개발(채널 `local`): 플러그인 옵션 `home`으로 `%LOCALAPPDATA%\own-open-code-dev`를 준다. 운영 vault와 섞이지 않게 하기 위해서다(01 §5.4).
- 원격 Linux(04, 완성 범위): `${XDG_DATA_HOME:-~/.local/share}/own-open-code`. 내용은 04 §5.3이 기준이다(vault 없음)
- 모두 플러그인 옵션 `home`으로 바꿀 수 있다(`ctx.options`, `core/src/plugin/module.ts:131`).

| 경로 | 내용 | 비밀 | 쓰는 쪽 |
|---|---|---|---|
| `accounts.json` | 레지스트리: 도메인, 계정(자격 증명 출처 `credential`, 압축 설정 `compaction` 포함), slot, 고정 모델 템플릿, Claude 슬롯 메타데이터 | 아니오 | own-accounts. 사용자 변경은 RPC 경유 |
| `policy.json` | 전환 정책, 임계값, fallback chain, UI 확인 임계값, 기본 계정, kind별 자동 압축 기본값(`compaction.byKind`, 4.7) | 아니오 | own-accounts |
| (외부) 이전 앱 `<control-center>\state.json`, `profiles\<id>\codex\auth.json` | 이전 앱(codex-multi-provider)의 프로필 목록과 ChatGPT 토큰(3.2a) | **예** | **이전 앱만 쓴다.** own-accounts는 읽기만 한다. OWN_HOME 밖이고 경로는 `accounts.json`의 `credential.source.authPath`에만 남는다 |
| (외부) 이전 앱 `<app>\profiles\deepseek.dpapi`, `<app>\work\control-center\credentials\<id>.dpapi`, `providers.json`, `profiles\provider.json` | 이전 앱이 저장한 API 키(DPAPI, entropy 없음)와 그 공급자 설정(3.2b) | 키 파일만 **예** | **이전 앱만 쓴다.** 키 파일은 `own-vault.exe` `linked.get`이 읽기만 한다(메모리에서 복호화). 경로는 `accounts.json`의 `credential.source.path`에만 남는다 |
| `claude-auth.json` | Claude 구독 슬롯의 계정 소스 `{configDir, setAt}`(8.7). 경로만 있고 비밀은 없다 | 아니오 | own-accounts(`plugin.claudeAuth.changeSource.execute`). launcher의 `Get-BridgeEnv`가 읽어 서비스 env에 `CLAUDE_CONFIG_DIR`로 넣는다(8.3 I8의 유일한 예외) |
| `ratecards.json` | 요율, TTL 하한·상한, lookback | 아니오 | 사용자 편집 또는 업데이트 |
| `trust.json` | 프로젝트 플러그인 승인 기록 `[{location, source, sha256, approvedAt}]`(01 §13.2) | 아니오 | own-accounts. 사용자 승인·철회는 RPC `plugin.trust.*`(9.2) 경유 |
| `presets.json` | 묶음별 프리셋, ★, 가벼운 짝, 새 대화 기본 모델, 수리 기록(T2), 전역 시작 프리셋·울트라 상한(07 §8.1) | 아니오 | own-accounts. 사용자 변경은 RPC `presets.*`(9.2) 경유 |
| `codex-meta.json`(T2) | Codex 모델 메타데이터의 마지막 스냅샷 `{version, kinds:{codex:{source:"backend"\|"pc-cache", fetchedAt, etag?, clientVersion?, rows?, rejected?, models}}, accounts?, latest?:{version, fetchedAt}, autoVersion?}`(07 §4.5). 창·추론 강도 단계·우선순위·은퇴 날짜의 둘째 층. CA(2026-10-19): `latest`는 레지스트리에서 읽은 Codex 최신 릴리스, `autoVersion`은 설정 `Codex 최신 모델 자동 확인`(없으면 켬), `rejected`는 목록에서 own이 뺀 행 수. 2026-11-23(own.18, `rows` 5): `left`는 뺀 행과 이유(`{slug, field, value}`), `harness`는 own-harness가 돌리는 서버 행(공유 스냅샷만, 07 §4.5 "서버 행으로 바로 돌리기") | 아니오 | own-accounts(control Location이 받아 씀, `store.changed{codex-meta}`). 받기 전에는 이 PC Codex CLI의 `models_cache.json`을 읽기만 한다 |
| `vault\<accountId>.dpapi` | 토큰·키(DPAPI CurrentUser + 앱 entropy) | **예** | `own-vault.exe`(요청은 own-accounts만) |
| `vault\voice-openai.dpapi`, `vault\voice-deepgram.dpapi`(VOICE) | 음성 입력 **전용** API 키(3.9). 계정이 아니므로 `accounts.json`에 없고, 계정 키와 섞이지 않는다 | **예** | `own-vault.exe`(요청은 own-accounts `voice.key.set`·`voice.transcribe`만) |
| `vault\websearch-brave.dpapi`(SP, 2026-10-19), `vault\websearch-exa.dpapi`·`-firecrawl`·`-parallel`·`-tavily`·`-tinyfish`(SK, 2026-10-23) | 웹 검색 서비스의 사용자 키(9.2): `brave`의 Brave Search API 키, core의 키 없는 다섯 서비스를 내 키로 쓰는 `own-<서비스>`의 키. 음성 키처럼 계정이 아닌 기능 키이고, core의 credential 표에도 환경 변수에도 들어가지 않는다 | **예** | `own-vault.exe`(요청은 own-accounts `websearch.key.set`과 그 서비스의 검색만) |
| `voice.json`(VOICE) | 음성 입력 설정 `{schemaVersion:1, enabled, provider, language, usage[]}`(3.9). `usage`는 달·서비스마다 인식한 초와 횟수뿐(글자·오디오 없음) | 아니오 | own-accounts(`voice.set`, `voice.transcribe`). 처음에는 꺼짐(`enabled:false`, OpenAI, 한국어) |
| `mcp.json`(SM, 2026-10-24) | own이 더한 MCP 서버와 목록 스위치 `{version:2, servers:[{id, name, scope, transport, origin?, registry?, createdAt, updatedAt, check?}], overrides:[{directory?, name, enabled}]}`(9.2 "MCP 서버"). `directory`가 없는 스위치는 모든 프로젝트의 것이다(SG, 2026-10-26). version 1 파일(모든 스위치에 폴더가 있음)은 읽을 때 version 2로 올린다. own 서버의 아무것도 바꾸지 않던 `enabled:true` 스위치를 빼고 읽으므로 모든 변경은 올린 값 위에서 정해지고, 파일은 첫 변경이 version 2로 쓴다(9.2 `mcp.enable`, SG-17). 환경 변수와 헤더는 **이름만**, 주소는 `?` 앞까지만 있다(`query`가 그 뒤가 있다는 표시). 값이 든 인자는 `${이름}`(그 이름의 저장된 환경 변수 값)으로, 값이 든 주소는 `••••`나 가져온 `${VAR}`로 보이는 꼴(`hidden`)로만 있다. `codemode`는 정했을 때만 있다. `check`는 마지막 연결 시험(도구 이름, 실패 이유, 값을 지운 오류 글) | 아니오 | own-accounts(`mcp.save`, `mcp.remove`, `mcp.enable`, `mcp.test`, `mcp.import.apply`). 모든 Location의 `mcp.transform`이 읽는다(core가 처음 접기 전에) |
| `mcp-hosts.json`(MH, 2026-11-26) | 사용자가 SSH 호스트의 MCP 서버에 보낸 값의 기록 `{version:1, sends:[{id, hostId, server, names, source:{type:"own", id}|{type:"file", name}, at}]}`(9.2 "MCP 서버를 SSH 호스트에서", 04 §13.1). 호스트·서버 id와 값 이름만. 값의 사본은 vault `mcp-send-<id>` | 아니요 | own-accounts(control) |
| `skill-switches.json`(SG, 2026-10-26) | 스킬 스위치와 쓰는 곳 `{version:1, switches:[{id, directory?, enabled}], scopes:[{folder, directory}]}`(9.2 "스킬 스위치와 쓰는 곳"). 스킬 id와 폴더만 있고 스킬 내용은 없다. 스위치 2,000개, 쓰는 곳 500개까지. 파일이 없으면 모든 스킬이 모든 프로젝트에서 켜져 있다 | 아니오 | own-accounts control 인스턴스(`skillset.switch`). 모든 Location의 `skill.transform`이 첫 등록 전에 읽고 `skillset.changed`마다 다시 읽는다 |
| `vault\mcp-<id>.dpapi`(SM, 2026-10-24) | own이 더한 MCP 서버 하나의 값: 환경 변수 값(인자에서 옮긴 값 포함), 헤더 값, 주소의 `?` 뒤, 값이 든 주소 전체(JSON 한 덩어리, 기능 키 종류). 값이 없는 서버는 항목이 없다 | **예** | `own-vault.exe`(요청은 own-accounts의 `mcp.*`와 그 서버를 띄우는 `mcp.transform`, 연결 시험만) |
| `vault\mcp-send-<id>.dpapi`(MH, 2026-11-26) | 한 호스트의 한 MCP 서버에 보낸 값의 사본(`mcp-<id>`와 같은 JSON). 보낼 때 own 서버의 값이나 설정 파일 서버의 값(페이지가 그 파일에서 읽어 한 번 넘김)에서 고른 이름만 | **예** | `own-vault.exe`(브로커의 `mcp.values`, `mcp.hosts.*`만) |
| `vault\<accountId>.dpapi.prev` | 직전 버전. refresh 중 크래시에 대비 | **예** | `own-vault.exe` |
| `vault\<accountId>.lock` | refresh lease `{pid, startedAt, until}` | 아니오 | own-accounts(`own-runtime`) |
| `state\limits.json` | 계정별 마지막 `LimitWindow` 스냅샷 | 아니오 | `@own/runtime`(leader 인스턴스). own slot 창은 own-accounts가, `anthropic`의 `claude.*` 창만 own-telemetry가 runtime 한도 저장소에 올린다(7.4) |
| `ledger\usage-YYYY-MM.jsonl` | step별 사용량. 내용과 토큰 값은 기록하지 않는다 | 아니오 | `@own/runtime`의 단일 ledger writer. 줄은 own-accounts가 step·압축 이벤트와 generate·title 응답 사본(플러그인이 이벤트로 못 받는 분)으로 만든다(`anthropic` 세션 포함, 7.5) |
| `ledger\events-YYYY-MM.jsonl` | 전환, 경보, 로그인, 소진 이벤트. 증거 수집 창이 도는 동안의 요청별 prefix 비교(`prefix`, 7.8.1). DeepSeek 웹 검색의 과금 검색(`websearch`, 9.2) | 아니오 | `@own/runtime`의 단일 ledger writer. 전환·로그인·경보·own slot 소진은 own-accounts가, `anthropic` 소진과 `claude_extra_usage` 판정만 own-telemetry가 넘긴다 |
| KV(own-accounts 네임스페이스) | 세션별 전환 상태, home slot, strip 규칙, TTL 모드, 확인 생략 설정, 캐시 상태, compaction epoch, 세션 압축 기준, 자식 세션 목록과 정책, 서드파티 동의 기록(2.4.6) | 아니오 | own-accounts |
| [M1+, 05 기준] `devices.json`, `feed\feed-YYYY-MM.jsonl`, `vault\push-vapid.dpapi`, push 구독 파일 | 원격 기기 등록(토큰 해시·범위), 알림 피드, Web Push VAPID 키(05 §13.5·§13.6·§16) | `push-vapid.dpapi`만 예 | own-remote(로컬 모드). 이 문서는 형식을 정하지 않는다 |

- **전역 데이터는 파일에 둔다.** 플러그인 인스턴스는 Location마다 따로 뜨고(`core/src/plugin.ts:295-300`), 로컬 플러그인은 Location·reload마다 cache-busting import로 다시 불린다(`plugin/src/source.node.ts:8-16`). 그래서 모듈 싱글턴은 공유되지 않는다.
  - 프로세스 전역 상태는 `@own/runtime`의 `globalThis[Symbol.for("own-open-code.runtime/<buildId>")]`에 **데이터만** 둔다(01 §4와 같은 키). 로직은 각 플러그인 모듈 코드에 둔다.
    - 키에 빌드 id(세 플러그인 번들 own-accounts·own-remote·own-telemetry의 해시, 빌드 때 새김. 01 §4·04 §4.1과 같음)를 넣는다. 고정 키를 쓰면 hot reload 뒤에도 옛 코드가 든 싱글턴이 살아남는다.
    - Location 인스턴스가 setup에서 `acquire`, dispose에서 `release`하는 참조 카운트를 둔다. 0이 될 때만 vault helper를 닫고 ledger를 flush한다.
    - 빌드가 바뀐 직후 옛·새 싱글턴이 잠시 공존할 수 있다. 이 겹침은 메모리 뮤텍스가 아니라 파일 락(`locks\registry.lock`, `vault\<accountId>.lock` lease, 3.5 F3)이 막는다.
  - 이 싱글턴이 두 플러그인 사이의 유일한 통로다. 서로의 KV를 읽지 않는다(01 §4).
    - own-accounts → runtime: own slot의 한도 스냅샷, 소진 기록, 마지막 응답 캡처, ledger 줄, 전환·로그인·경보 기록. 캐시 상태와 strip 규칙은 own-accounts 안에서 만들고 자기 KV에 둔다
    - own-telemetry → runtime → own-accounts: `anthropic`의 unified 한도 스냅샷(`claude.*`), `anthropic` 소진 기록과 마지막 응답 캡처, `claude_extra_usage` 판정
    - own-telemetry는 own slot 레지스트리가 필요 없다. hook을 `{providerID:"anthropic"}` scope로만 등록하기 때문이다(4.1)
  - 파일 쓰기 규칙
    - temp 파일에 쓰고 fsync한 뒤 rename한다.
    - 프로세스 안에서는 뮤텍스를 쓴다. 금지된 두 번째 프로세스(`--standalone` 등, 01 §5.4)가 떠도 파일이 깨지지 않게 `OWN_HOME\locks\registry.lock`도 쓴다.
    - 쓸 때마다 `revision`을 올린다. `schemaVersion`은 아래 규칙대로만 바꾼다. 모르는 필드는 보존한다.
  - **호환되지 않는 schema 변경(2026-10-05 규칙, 첫 `schemaVersion: 2` 전에 정함)**
    - 지금 레지스트리 파일은 `schemaVersion: 1`로 고정한 schema로 읽는다(`own-protocol/src/registry.ts:136`, `policy.ts:113`, `ratecard.ts:66`). 쓸 수 없는 파일은 자동으로 덮어쓰지 않는다(`own-runtime/src/store.ts` `StoreError`).
    - 버전 전환 절차가 백업하는 것은 DB뿐이다(01 §5.5 "버전 전환 절차" 3번). 그래서 새 빌드가 `accounts.json`을 그 자리에서 v2로 덮어쓰면 `own rollback` 뒤의 이전 빌드가 그 파일을 거부한다. 사용자에게는 계정이 모두 사라진 것처럼 보인다.
    - 이전 빌드가 읽을 수 있는 변경(선택 필드 추가 등)은 지금처럼 같은 파일과 같은 `schemaVersion`을 쓴다. 이전 빌드는 모르는 필드를 보존한다.
    - 이전 빌드가 읽을 수 없는 변경(필수 필드 추가, 필드의 뜻이나 형식 변경, 필드 삭제)은 **버전 이름이 붙은 새 파일**에 쓴다. 예: `accounts.v2.json`. v1 파일 `accounts.json`은 덮어쓰지도, 옮기지도, 지우지도 않는다.
    - 마이그레이션은 `@own/protocol`의 순수 함수다. 이웃 버전 사이에만 둔다(`v1 → v2`, `v2 → v3`). 파일 I/O 없이 값만 바꾸고, 실제 모양의 fixture 파일로 시험한다.
    - 새 빌드(vN)는 vN 파일이 있으면 그것을 읽는다. 없으면 vN-1 파일을 읽어 마이그레이션한 결과로 vN 파일을 만든다. 그보다 오래된 파일만 있으면 이웃 함수를 차례로 적용한다.
    - 그래서 `own rollback`은 계속 동작한다. 이전 빌드는 손대지 않은 자기 버전 파일을 그대로 읽는다.
    - 롤백한 동안 vN-1 파일에 생긴 변경은 다시 올릴 때 이미 있는 vN 파일에 자동으로 합쳐지지 않는다. 처리 방법은 첫 v2 변경 때 정한다 ⚠.
    - ledger JSONL은 줄마다 `v`를 둔다(`Ledger.Line`, ledger `Event`). 줄 형식이 바뀌면 `v`를 올려 같은 파일에 덧붙인다. 읽는 쪽은 해석하지 못하는 줄을 건너뛰므로(`own-runtime/src/ledger-writer.ts` `#read`) 롤백한 빌드는 새 줄만 빼고 읽는다.
- **세션 단위 데이터는 KV에 둔다.** `ctx.storage`는 전역 KV이고 플러그인 id별 네임스페이스를 쓴다(`core/src/plugin/host.ts:584-611`, `core/src/kv.ts:36-83`).
  - 평문이므로 비밀은 넣지 않는다.
  - `scan`은 한 번에 1000개까지다. 대량 기록(ledger)은 넣지 않는다.
  - 재시작하면 own-accounts가 setup에서 자기 KV를 읽어 `own-runtime`에 다시 올린다. own-telemetry는 KV를 쓰지 않는다.

### 2.4 스키마와 예시

#### 2.4.1 `accounts.json`

```jsonc
{
  "schemaVersion": 1,
  "revision": 42,
  "cacheDomains": {
    "cd_7k2m": { "kind": "codex", "scope": "chatgpt_login", "externalId": "<chatgpt-account-id>", "poolingVerified": false },
    "cd_w3p8": { "kind": "anth",  "scope": "anthropic_workspace", "externalId": "wrkspc_01…", "poolingVerified": false },
    "cd_q9x1": { "kind": "oai",   "scope": "openai_org", "externalId": "org-…", "poolingVerified": false }
  },
  "quotaDomains": {
    "qd_7k2m":   { "kind": "codex", "scope": "chatgpt_seat" },
    "qd_org_ab": { "kind": "anth",  "scope": "anthropic_org", "externalId": "<organization-id>" },
    "qd_q9x1":   { "kind": "oai",   "scope": "openai_org_project", "externalId": "org-…/proj_…" }
  },
  "accounts": [
    {
      "id": "acc_01JAX3…",
      "kind": "codex",
      "label": "업무",
      "shortLabel": "업",
      "color": "violet",                      // 03 문서의 8색 토큰 이름
      "providerID": "own-codex-7k2m",
      "cacheDomain": "cd_7k2m",
      "quotaDomain": "qd_7k2m",
      "billing": "subscription",              // subscription | metered | prepaid
      "identity": {
        "chatgptAccountId": "…",
        "emailMasked": "na***@gmail.com",
        "plan": "plus",                        // ⚠ claim 이름 확인 필요(AC-P22)
        "fingerprint": "sha256:5c1e…"          // 계정 가드(3.1 C5)
      },
      "autoSwitch": false,                     // 구독은 기본 false (5.10)
      "budget": null,                          // metered 전용 {monthlyUSD}
      "status": "ready",                       // ready | exhausted | auth_failed | needs_reauth | disabled | misconfigured | unverified | retired
      "createdAt": "2026-09-26T11:02:00Z",
      "lastVerifiedAt": "2026-09-26T11:02:05Z",
      "lastUsedAt": "2026-09-26T12:40:11Z",    // 마지막 step 시각. own-accounts가 step 이벤트에서 얻어 주기적으로 저장
      "pollBalance": null                      // ds·or·xai 계정만 true|false(기본 true). 잔액·키 조회(7.2), 03 §5.4 "잔액·키 조회 끄기". 그 밖 kind는 null
    },
    {
      "id": "acc_01JAX9…",
      "kind": "anth",
      "label": "회사 · prod",
      "shortLabel": "회",
      "color": "teal",
      "providerID": "own-anth-w3p8",
      "cacheDomain": "cd_w3p8",
      "quotaDomain": "qd_org_ab",
      "billing": "metered",
      "identity": { "organizationId": "…", "workspaceId": "wrkspc_01…", "keyHint": "sk-ant-…9fQ2" },
      "autoSwitch": true,
      "budget": { "monthlyUSD": 200 },
      "status": "ready",
      "compaction": { "maxTriggerTokens": 400000 }   // 4.7 계정 단위 압축 기준. 없거나 null이면 kind 기본값
    },
    {
      "id": "acc_01JB2Q…",
      "kind": "codex",
      "label": "개인",                          // 가져올 때 이전 앱 alias가 기본값
      "shortLabel": "개",
      "color": "indigo",
      "providerID": "own-codex-p1q2",
      "cacheDomain": "cd_p1q2",
      "quotaDomain": "qd_p1q2",
      "billing": "subscription",
      "identity": { "chatgptAccountId": "…", "emailMasked": "ch***@gmail.com", "plan": "pro", "fingerprint": "sha256:9a0d…" },
      "autoSwitch": false,
      "status": "ready",
      "credential": {                          // 3.2a. 없으면 {type:"vault"}. linked는 vault 항목이 없다
        "type": "linked-codex-source",         // | "takeover-codex-source"(+ takenOverAt) | "vault"
        "source": { "app": "codex-multi-provider", "profileID": "02", "alias": "개인",
                    "authPath": "D:\\#Projects\\codex-multi-provider\\work\\control-center\\profiles\\02\\codex\\auth.json" },
        "linkedAt": "2026-09-27T09:10:00Z"
      },
      "remote": "allow"                        // 04 §8.9: 원격 호스트에 인증 lease를 줄지. 기본 allow
    }
  ],
  "slots": {
    "own-codex-7k2m": {
      "kind": "codex",
      "accounts": ["acc_01JAX3…"],
      "pooling": "off",                        // off | rotate(PoC 통과 도메인만)
      "modelTemplate": "tpl_codex_20260926",   // 같은 kind의 slot은 같은 템플릿을 공유한다(2.4.2)
      "transport": "websocket"                 // codex만: websocket | http. AC-P15 실패 시 http(3.6)
    },
    "own-anth-w3p8": {
      "kind": "anth",
      "accounts": ["acc_01JAX9…"],
      "pooling": "off",
      "modelTemplate": "tpl_anth_20260926"
      // 새 대화 기본 모델은 slot에 두지 않는다. 묶음마다 하나이고 presets.json에 있다(07 §2.2). 옛 파일의
      // "defaultModel"은 읽지 않고 남겨 둔다
    }
  },
  "modelTemplates": {
    "tpl_codex_20260926": {
      "kind": "codex",
      "sourceProvider": "openai",
      "source": "snapshot",                    // snapshot(3.6a 캡처) | bundled(동봉 대체 템플릿)
      "capturedAt": "2026-09-26T11:02:00Z",
      "models": [ /* 2.4.2 형식의 Model.Info 목록(providerID 제외). T2: 모델마다 own 표시 addedAt?(뒤에 더한 모델),
                     upstream?:"missing"(카탈로그에서 사라짐, 지우지 않고 켜진 채 status:"deprecated"로 등록), 07 §4.4 */ ],
      "update": { "detectedAt": "2026-10-02T09:00:00Z", "fields": ["name"] }   // T2, 선택: 고정 필드 변경이 refreshCatalog를 기다림(3.6a)
    }
  },
  "claudeSlot": {                              // 합성 계정 acc_claude_slot의 표시 메타데이터만. 비밀 없음
    "accountID": "acc_claude_slot", "label": null, "shortLabel": "C", "color": "orange"   // label=null이면 connection label 사용(8.5)
    // 선택 "configDir": "<OWN_HOME>\\claude-accounts\\acc_…" — `own 전용 로그인으로 바꾸기`로 옮긴 계정 1의 폴더(8.7, CS 2026-10-22)
  }
}
```

#### 2.4.2 고정 모델 템플릿 항목(Model.Info)

필드는 `schema/src/model.ts:119-142`를 따른다. 값은 models.dev 원본을 **그대로 복사**한 뒤 kind 규칙(3.6)을 적용한다. 아래는 형태만 보이는 예시다.

```json
{
  "id": "gpt-5.5",
  "modelID": "gpt-5.5",
  "family": "gpt",
  "name": "GPT-5.5",
  "package": "@opencode/ai/providers/openai",
  "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] },
  "variants": [{ "id": "low" }, { "id": "medium" }, { "id": "high" }, { "id": "xhigh" }],
  "time": { "released": 1767225600000 },
  "cost": [],
  "status": "active",
  "enabled": true,
  "limit": { "context": 400000, "input": 272000, "output": 128000 }
}
```

- **왜 고정하나**
  - models.dev가 갱신되면 원본 정의가 바뀐다(`core/src/plugin/models-dev.ts:60-64`).
  - identity는 `model.name`을 system prompt에 넣고, Optimize/Patch plugin은 `id/modelID/family`를 본다(`core/src/plugin/optimize.ts:36-45,71-80`, `tool/plugin/patch.ts:295-306`).
  - 그래서 카탈로그가 바뀌면 사용자 모르게 prefix가 달라진다.
- **같은 kind의 slot은 같은 템플릿을 공유한다.** 새 계정은 그 kind의 현재 템플릿을 쓴다. 계정마다 다른 시점에 캡처하면 `model.name`이 달라져 같은 도메인 전환의 `Z`가 갈라지기 때문이다(D9, 6.3 ①).
- **캡처 방법**은 3.6a에 있다. RPC 핸들러는 transform fold 밖이라 카탈로그를 직접 읽을 수 없다.
- **갱신**은 명시적 동작(`accounts.update{refreshCatalog:true}`)으로만 한다. 갱신은 그 kind의 모든 slot에 한꺼번에 적용한다. UI는 "다음 요청에서 이 종류의 계정 캐시가 한 번 다시 쓰입니다"라고 알린다.
- **T2(07 §4.4)**: 요청 바이트에 들어가지 않는 것은 갱신 없이 따라간다. 새 모델 ID는 `addedAt`과 함께 바로 더하고, 사라진 ID는 `upstream:"missing"`으로 남기고, `limit`·`cost`·`status`·출시일은 등록할 때마다 살아 있는 값이다(3.6a). 고정 필드가 바뀐 것만 템플릿의 `update`에 적고 `템플릿 갱신 있음`으로 사용자의 갱신을 기다린다.

#### 2.4.3 `policy.json`

```jsonc
{
  "schemaVersion": 1,
  "autoSwitch": {
    "apiToApi": "auto",                      // 같은 kind API 키끼리: auto | ask | off (계정의 autoSwitch=true일 때만)
    "subscriptionToApi": "ask",              // 구독 소진 → 종량제 API: ask | off. "auto"는 policy.set이 policy_denied로 거부(01 §8.6)
    "subscriptionToSubscription": "ask",     // ask | off. "auto"는 거부한다(약관 위험, 01 §1.2)
    "toClaudeSlot": "off",                   // 고정값. 서드파티 슬롯으로는 자동 전환하지 않는다
    "claudeToClaude": "off",                 // 이 PC의 Claude 구독 계정끼리(8.8): auto | off. 새 설치 기본·값이 없을 때 off(CAG-5, 아래)
    "inTurnFailover": false                  // AC-P17b 통과 전 false. Phase 3
  },
  "hysteresis": { "cooldownMinutes": 30, "cooldownRequests": 20, "breakerAutoPerHour": 2, "breakerFlapMinutes": 10, "breakerOpenMinutes": 30, "coldSumFactor": 3 },
  "thresholds": {                           // 토큰 크기 조언 문턱은 없다(07 §6.1 U6, §6.2 #9–#11)
    "anthropicWatermarkBlocks": 15,
    "unknownTtlIdleMinutes": 60,             // TTL 상한을 모르는 도메인(codex 등)의 보수적 유휴 기준. 03 §6.3과의 차이는 12장 Q13
    "scheduleDeadlineMinMinutes": 30,        // 예약 deadline = max(이 값, 2 × 유휴 기준) (5.4)
    "confirm": { "silentBelowTokens": 20000, "dialogAtTokens": 100000, "dialogAtQuotaPercent": 5, "dialogAtUSD": 0.5 }   // 03 §6.2
  },
  "horizonRequests": 20,
  "fallbackChains": { "default": [] },       // 예: ["own-oai-q9x1","own-oai-z7k3","own-anth-w3p8"]. 자동 전환용 chain에는 구독 slot을 넣지 않는다
  "hideBuiltinProviders": "auto",            // "auto" | string[] | false. 서버에서 activation:"disabled"(3.8, 01 §8.2)
  "defaults": {                              // 03 §5.4 "이 프로바이더의 기본 계정으로". 새 대화의 계정 고르기(07 §2.2 3)
    "byKind": { "codex": "acc_01JAX3…", "anth": "acc_01JAX9…" }
  },
  "awayDetect": { "enabled": true, "hiddenMinutes": 10 },   // 03 §6.3 "자리 비움 감지": cold-point 추천과 자리 비움 압축(4.7.7)의 화면 판정에 쓴다
  "compaction": {                            // 4.7 kind 기본값의 사용자 변경분만. 없는 kind·필드는 코드 상수(4.7.3 표, 모두 v2)를 쓴다. 아래 값은 사용자가 직접 줄인 예
    "byKind": {
      "ds":     { "triggerPercent": 60, "maxTriggerTokens": 200000 },
      "compat": { "models": { "qwen3-coder-plus": { "maxTriggerTokens": 96000 } } }   // kind×모델
    }
  },
  "secretCacheSeconds": 600,                 // 복호화 비밀의 메모리 캐시 TTL. 0이면 캐시하지 않음(01 §8.3)
  "credentialBackend": "vault",              // vault | opencode-credential(대체 모드, 3.7)
  "outputLimit": { "mode": "cap", "maxTokens": 256000 },   // 생략 가능(없으면 이 값). 메인 요청의 출력 상한(4.9): cap = 이 값을 넘기지 않기(4,096–1,000,000), omit = 보내지 않기(수는 기억만)
  "repeatReminderExclude": ["computer_*"]    // 생략 가능. 같은 도구 반복 호출 안내(D4)가 세지 않는 도구 이름(* 와일드카드). 없으면 코드 기본값 ["computer_*"]. 파일에서만 바꾸며 policy.set으로는 바꿀 수 없다
}
```

- **Claude 계정끼리 자동 전환(`autoSwitch.claudeToClaude`, 8.8)**: 사용자 결정 2026-10-31(CAG-5, C-D3 기본값 철회): 새로 설치하면 `autoSwitch.claudeToClaude` 기본은 `off`다. 값이 없을 때의 대체값도 `off`다. 이미 있는 `policy.json`은 그대로 둔다(옮기기 코드 없음). 이유: 한도에 막히면 다른 Claude 계정으로 저절로 옮기는 것은 Anthropic 이용 정책의 '한도를 피하려는 여러 계정'으로 읽힐 수 있다(own/reports/claude-agent-provider-2026-10-31.md §10.3, §15). API 키와 다른 회사 계정의 자동 전환은 그대로다. 저장소는 첫 쓰기 전까지 내장 기본값을 읽으므로, `policy.json`이 아직 없는 설치도 `off`가 된다. 사용자는 설정 > 전환 정책의 `Claude 계정 사이`에서 `자동`을 고를 수 있다.
- **자동 전환 chain 규칙**: `fallbackChains`의 목록에 `billing:"subscription"` slot이 들어 있으면 자동 전환에는 쓰지 않는다. 그런 chain은 "추천" 정렬(5.7)에만 쓴다. `policy.set`은 구독 slot이 둘 이상 들어간 chain을 자동용으로 저장하려 하면 `policy_denied`를 돌려준다.
- **지운 필드**: `thresholds`의 `compactAdviceUsedPercent`·`compactMinTokens`·`compactAfterSwitchMinTokens`·`newSessionAdviceTokens`(07 §6.2 #9–#11)와 `defaults.global`(07 §2.2). 저장소는 모르는 키를 남기므로(`Registry.preserveUnknown`) 이 키들은 따로 지운다: 리더가 시작할 때 한 번, 그리고 `policy.set`의 쓰기마다.
- **`hideBuiltinProviders:"auto"`**: 사용자가 own 계정을 가진 kind의 내장 provider를 숨긴다. codex·oai → `openai`, ds → `deepseek`, xai → `xai`, or → `openrouter`. `anthropic`은 이 설정이 아니라 Claude 슬롯 규칙(8.4)을 따른다.
- **출력 상한(`outputLimit`, 4.9, 2026-10-19)**: 없으면 core 기본(256,000을 넘기지 않기)과 같은 요청이 나간다. `policy.set{patch.outputLimit}`이 통째로 바꾸고 `null`이 지운다(설정 화면의 `기본으로`). 원격 호스트는 정책 미러(`MirrorView.policy`)로 같은 값을 받는다.
- **같은 도구 반복 호출 안내(`repeatReminderExclude`, D4)**: own slot으로 간 요청의 도구 호출만 센다. (세션, agent)마다 같은 도구를 같은 인자(키 정렬)로 연속 3·5·8번째 부르면 도구 결과 텍스트 **앞**에 짧은 고정 안내를 붙인다. 사용자 입력이 오면 다시 세고, 호출을 막지는 않는다. 목록의 도구와 Code Mode 프로그램 안의 호출은 세지 않는다(`own-accounts/src/guard/repeat.ts`).

#### 2.4.4 `ratecards.json` (6.2 표의 원본)

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-30",
  "cards": [
    { "match": { "kind": "codex", "model": "gpt-5.6-sol" }, "unit": "credits", "in": 100, "read": 10, "write": null, "out": 500,
      "ttl": { "warmLowerSec": 300, "coldUpperSec": null }, "lookback": null, "note": "프로모션가, 2026-11-21 이후 변동 가능" },
    { "match": { "kind": "codex", "model": "gpt-5.5" }, "unit": "credits", "in": 125, "read": 12.5, "write": null, "out": 750,
      "ttl": { "warmLowerSec": 300, "coldUpperSec": null } },
    { "match": { "kind": "codex", "model": "gpt-6-astra" }, "unit": "credits", "in": 250, "read": 25, "write": null, "out": 1250,
      "ttl": { "warmLowerSec": 300, "coldUpperSec": null } },
    { "match": { "kind": "anth", "model": "claude-opus-5-5" }, "unit": "USD", "in": 4.0, "read": 0.2, "write5m": 5.0, "write1h": 8.0, "out": 20.0,
      "ttl": { "warmLowerSec": 300, "coldUpperSec": 300, "oneHour": { "warmLowerSec": 3600, "coldUpperSec": 3600 } }, "lookback": { "blocks": 20 } },
    { "match": { "kind": "anth", "model": "claude-sonnet-5-5" }, "unit": "USD", "in": 2.0, "read": 0.1, "write5m": 2.5, "write1h": 4.0, "out": 10.0,
      "ttl": { "warmLowerSec": 300, "coldUpperSec": 300, "oneHour": { "warmLowerSec": 3600, "coldUpperSec": 3600 } }, "lookback": { "blocks": 20 } },
    // claude-haiku-5-5(≤100K 단가)·claude-fable-5-1도 같은 모양(6.2)
    { "match": { "kind": "oai", "modelGte": "gpt-5.6" }, "unit": "USD", "inFromCatalog": true, "writeMul": 1.25,   // read는 카탈로그 cache.read
      "ttl": { "warmLowerSec": 1800, "coldUpperSec": 1800 }, "lookback": { "messageEnds": 20 } },
    { "match": { "kind": "oai", "modelLt": "gpt-5.6" }, "unit": "USD", "inFromCatalog": true, "readMul": 0.1, "writeMul": 1.0,
      "ttl": { "warmLowerSec": 1800, "coldUpperSec": 86400 } },
    { "match": { "kind": "ds", "model": "deepseek-v4-pro" }, "unit": "USD", "in": 1.32, "read": 0.044, "write": null, "out": 3.96, "offPeakMul": 0.5,
      "peak": [ { "days": [1, 2, 3, 4, 5], "from": "01:00", "to": "04:00" }, { "days": [1, 2, 3, 4, 5], "from": "06:00", "to": "10:00" } ],
      "ttl": { "warmLowerSec": 0, "coldUpperSec": 259200 } },   // 단가는 피크 단가. peak 밖에서는 × offPeakMul(6.2)
    { "match": { "kind": "ds", "model": "deepseek-flash" }, "unit": "USD", "in": 0.30, "read": 0.006, "write": null, "out": 1.20, "offPeakMul": 0.5,
      "peak": [ { "days": [1, 2, 3, 4, 5], "from": "01:00", "to": "04:00" }, { "days": [1, 2, 3, 4, 5], "from": "06:00", "to": "10:00" } ],
      "ttl": { "warmLowerSec": 0, "coldUpperSec": 259200 } },
    { "match": { "kind": "xai" }, "unit": "USD", "inFromCatalog": true, "ttl": { "warmLowerSec": 0, "coldUpperSec": null } },   // read는 카탈로그 cache.read
    { "match": { "kind": "compat" }, "unit": "USD", "inFromCatalog": true, "ttl": { "warmLowerSec": 0, "coldUpperSec": null } }   // 요율은 사용자가 모델마다 입력(3.3)
  ]
}
```

- `out`은 ratecard 값, 없으면 카탈로그 `cost.output`을 쓴다. Opus 5.5는 $20/1M이다(Anthropic 공개 요율 $4 / $20, cache read $0.20).
- `read`는 ratecard 값, 없으면 `readMul`·r_in, 그것도 없으면 카탈로그 `cost.cache.read`, 끝내 없으면 r_in(할인 없음)이다. oai 5.6+와 xai 카드는 `readMul`을 두지 않고 카탈로그 값을 그대로 쓴다(2026-10-30, RR). 모델마다 배수가 달라서다(GPT-6.1 0.05·r_in, GPT-5.6·GPT-6 0.1·r_in, grok-4.5 0.15·r_in, grok-4.7 0.25·r_in).
- 카드가 없는 모델은 USD 카탈로그로 r_in·r_out을 알아도 TTL이 `0`/알 수 없음이라 모든 재사용 추정이 cold다(`Rates.resolve`). 그래서 자주 쓰는 모델은 카드를 둔다.
- `r_out`을 끝내 모르면 추정기는 `r_out`이 필요한 선택지(6.3 ⑥ 압축 후 전환, ⑦ 전환 후 압축, ⑩ 새 세션 인계)에 `delta:null, reason:"rate_unknown"`을 내고 `available:false`로 둔다. 0으로 계산하지 않는다.
- `speed`(선택, 2026-10-06, 4.8): 구독 kind(`codex`, `siwc`)의 속도 tier 배수 카드 `{match, tier, included?, credits?, source, date, note?}`다. `tier`는 요청 값(`priority`, `ultrafast`), `included`는 요금제 포함 사용량을 쓰는 배수(Fast 2.5, Ultrafast 8), `credits`는 구매 크레딧 배수(2, 6)다. `source`와 `date`는 숫자를 읽은 곳과 날짜다(시드: learn.chatgpt.com/docs/speed, 2026-10-06). API kind는 카드가 없고 카탈로그 모드 가격을 쓴다. 이 필드가 없는 기존 파일은 시드의 `speed`를 읽는다.
- `peak`(선택, 2026-10-06 결정 D3): 피크 가격 시간대 목록이다. 항목은 `days`(UTC 요일, 0 = 일요일 … 6 = 토요일)와 `from`–`to`(UTC `HH:MM`, `from`은 넣고 `to`는 뺀다, `24:00`까지 쓸 수 있다)다. 자정을 넘는 시간대는 두 항목으로 나눠 적는다. `from`이 `to`보다 늦거나 같으면 파일을 읽지 못한다.
  - 카드의 단가(`inFromCatalog`면 카탈로그에서 가져온 단가도)는 피크 단가다. 요청 시각이 어느 시간대에도 들지 않으면 모든 단가(`in`·`read`·cold·`out`)에 `offPeakMul`을 곱한다(`Ratecard.multiplier`). 추정기와 ledger 비용(7.5)이 같은 규칙을 쓴다.
  - `peak`가 없는 카드는 시각과 상관없이 같은 단가다. `offPeakMul`만 있고 `peak`가 없으면 `offPeakMul`은 쓰지 않는다. 이 필드가 생기기 전에 저장된 `ratecards.json`도 그대로 읽히고, 그 파일의 ds 카드는 하루 종일 피크 단가다(ledger도 7.5의 이전 규칙대로 core USD). 시드를 쓰는 설치(파일이 없으면 시드를 읽는다)는 바로 새 값을 쓴다.

#### 2.4.5 vault 항목(복호화 후 평문 형태)

```jsonc
// vault\acc_01JAX3….dpapi  (ChatGPT OAuth)
{ "v": 1, "type": "oauth", "family": "openai-chatgpt",
  "access": "<jwt>", "refresh": "<opaque>", "idToken": "<jwt>",
  "expiresAt": 1790000000000, "obtainedAt": 1789990000000, "generation": 7 }

// vault\acc_01JAXB….dpapi  (Sign in with ChatGPT 토큰 공유, kind siwc)
{ "v": 1, "type": "oauth", "family": "openai-chatgpt-sharing",
  "access": "<opaque>", "refresh": "<opaque>", "idToken": "<jwt>",
  "expiresAt": 1790000000000, "obtainedAt": 1789996400000, "generation": 1,
  "clientId": "oaiapp_…", "scopes": ["openid", "…", "chatgpt.tokens.use.direct"],
  "earliestRefreshAt": 1789998200000 }

// vault\acc_01JAX9….dpapi  (API key)
{ "v": 1, "type": "key", "key": "<secret>", "generation": 1 }
```

- **OAuth `family`**: `openai-chatgpt`(codex)와 `openai-chatgpt-sharing`(siwc, 3.2c). kind와 family가 맞지 않는 항목은 `kind_mismatch`로 거절한다. `clientId`(발급된 client id), `scopes`, `earliestRefreshAt`(epoch ms)은 비밀이 아닌 토큰 공유 메타데이터다. refresh 뒤에도 남는다: 응답에 `scope`가 없으면 이전 scopes를 유지하고, `earliestRefreshAt`은 새 토큰 응답의 값으로 바뀐다(없으면 지운다). 이 필드가 없는 이전 항목도 그대로 읽힌다.

- **암호화와 파일 이름**: DPAPI CurrentUser, `optionalEntropy = "own-open-code/v1/" + accountId`, 파일 `vault\<accountId>.dpapi`. 두 문서가 같은 규칙을 써야 한 쪽이 쓴 blob을 다른 쪽이 읽는다. 01 §13과 helper 구현(`own/native/own-vault/src/dpapi.rs:18`, README "entropy")이 이 값으로 정리되었다(12장 Q15 해결).
- **입출력은 `own-vault.exe`(Rust helper) 하나로 한다**(01 §13.1). `bun:ffi` 직접 호출과 PowerShell `ProtectedData`는 쓰지 않는다. 앞의 것은 experimental이고 플러그인을 Bun 런타임에 묶는다. 뒤의 것은 호출당 수백 ms가 들고 실행 정책·AMSI 변수가 있다.
  - `own-runtime`이 프로세스당 helper 하나를 장수 자식 프로세스로 띄운다. 최소 env로 실행하고, 서버가 끝나면 stdin EOF로 함께 끝난다. 죽으면 다시 띄운다.
  - 프로토콜: stdin/stdout JSON-lines. **비밀은 argv로 넘기지 않는다.**
    - `{"op":"get","id":"<accountId>"}` → `{"ok":true,"value":"<평문 JSON>","generation":7}` 또는 `{"ok":false,"error":"not_found"|"decrypt_failed"}`
    - `{"op":"put","id","value","keepPrev":true}` → 임시 파일에 쓰고 `MoveFileEx(MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)`로 교체한다. `keepPrev`면 직전 파일을 `.prev`로 남긴다(F4).
    - `{"op":"delete","id","shred":true}` → 본 파일과 `.prev`를 지운다(crypto-shred, F7).
    - `{"op":"list"}` → `{ids:[…]}`
  - `.prev`와 `.lock`은 01 §5.1 설치 레이아웃에도 있다.
- **복호화 비밀 메모리 캐시**(01 §8.3의 비밀 캐시와 같은 것)
  - 위치: `own-runtime`의 프로세스 전역 Map. 키는 `accountId + ":" + generation`이다.
  - TTL: `policy.secretCacheSeconds`(기본 600초). 0이면 캐시하지 않는다.
  - 무효화: refresh로 새 토큰을 쓰거나 `replaceKey`·`accounts.remove.execute`가 성공하면 즉시 그 항목을 지우고 새 값을 넣는다.
    - 무효화는 진행 중인 읽기도 무른다(SK-12, 2026-10-23). 항목마다 epoch가 있고 무효화가 그것을 올린다. 그 전에 시작한 읽기는 답을 기다리던 호출에만 돌려주고 캐시에 넣지 않으며, 뒤에 오는 읽기는 그것과 합치지 않고 새로 읽는다.
    - 계정과 기능 키(음성, 웹 검색)를 지울 때는 vault `delete` 앞과 뒤에 무효화한다. delete가 도는 동안 시작한 읽기가 키를 찾았을 수 있기 때문이다. 그렇지 않으면 지운 키가 TTL 동안 캐시에 남아 쓰인다.
  - `model.request`는 primary·compaction·title·generate와 모든 retry attempt마다 불린다(`core/src/session/model-request.ts:261-278`). 그래서 **hot path에서는 캐시만 읽는다.**
    - 캐시가 비어 있으면 accountId마다 single-flight로 helper `get`을 한 번 부르고 그 Promise를 기다린다. 이 대기는 디스크 I/O가 아니라 helper IPC다.
    - 미리 채우기: setup, `switch.apply`, `switch.estimate` 때 대상 계정의 캐시를 채워 둔다. 그래서 전환 뒤 첫 요청에서 미스가 거의 나지 않는다.
  - 로그, 이벤트, RPC 출력에 값을 남기지 않는다. 로그에는 SHA-256 앞 8자만 쓴다.
- 원격 호스트(04)에는 vault가 없다. 원격 own-accounts는 로컬 브로커가 요청마다 주는 짧은 인증 lease를 쓰고, refresh token은 원격에 가지 않는다(04 §8). 이전 판의 "비Windows는 backend만 바꾼다"는 이것으로 바뀌었다.
- linked 가져오기 계정(3.2a)은 vault 항목이 없다. 비밀은 이전 앱의 `auth.json`에서 읽어 같은 메모리 캐시 규칙(TTL `secretCacheSeconds`)으로 둔다.
- 이전 앱 API 키를 연결한 계정(3.2b)도 vault 항목이 없다. 키는 `own-vault.exe` `linked.get`이 이전 앱 파일에서 복호화한 값을 메모리에만 두고(파일 경로 + mtime·크기 기준, 같은 TTL), 파일이 바뀌거나 401을 받으면 다시 읽는다.

#### 2.4.6 KV 키(세션 단위)

| 키 | 네임스페이스 | 값 |
|---|---|---|
| `sess:<sid>:switch` | own-accounts | 5.4의 SwitchState. BLOCKED의 "리셋까지 대기" 예약 `{resumeAt, message}`도 여기에 둔다 |
| `sess:<sid>:home` | own-accounts | `{providerID, pinned, since}` (5.8) |
| `sess:<sid>:strip` | own-accounts | StripRule[] (4.4) |
| `sess:<sid>:ttlMode:<providerID>` | own-accounts | `"5m"\|"1h"`(4.5, Phase 3) |
| `sess:<sid>:confirmOverride` | own-accounts | `{silentBelowTokens}`. 03 §6.3 "이 세션에서는 100k 미만이면 다시 묻지 않기". RPC `switch.setConfirmOverride`(9.2)로만 쓴다 |
| `ack:claudeAuth` | own-accounts | `{acknowledgedAt, pluginVersion, integrity, noticeHash}` (8.4). 2026-10-18부터 쓰지도 읽지도 않는다(옛 기록은 남김) |
| `chatgpt:agentHost` | own-accounts | 이 PC의 Sign in with ChatGPT `ext_agent_host_id`(`urn:uuid:<v4>`, 3.2c). 첫 로그인 전에 한 번 만들고 계속 쓴다. 비밀이 아니다 |
| `sess:<sid>:cache:<providerID>`, Claude 계정은 `sess:<sid>:cache:anthropic@<accountID>` | own-accounts | `{lastReqAt, L, epoch, modelID, variant, watermark:{messageID, partIndex}, blocksSince, messageEndsSince, imageTrimEpoch, accountID?}`(`accountID`: 마지막 요청에 서명한 계정, SL 2026-10-26, 9.2 `cache.state`). step 이벤트로 갱신한다(01 §7). 여러 Claude 계정은 `anthropic` slot 하나를 함께 쓰지만 회사의 캐시는 계정(조직)마다 따로라서, Claude 구독 slot의 항목은 그 요청에 서명한 계정마다 둔다(`Cache.keyAccount`, `Kv.cache(sid, pid, accountID)`, SL-8 2026-10-27). 다른 provider는 계정이 하나라 provider 키 그대로다. 다른 계정의 step도 이 항목을 늙힌다(`blocksSince`). 그 전에 provider 키로 쓴 `anthropic` 항목은 그것이 적은 계정(적지 않았으면 아무 계정)의 항목으로 읽고, 그 계정의 새 항목을 쓸 때 지운다. `lastReqAt`는 그 요청을 **보낸** 시각(step 시작)이다. 캐시 수명은 요청 시작부터 재고 답을 만드는 시간도 그 안에 들어가기 때문이다(CC 2026-10-24. 그 전에는 step이 끝난 시각이라 남은 시간이 답 생성 시간만큼 늦게 보였다) |
| `sess:<sid>:idleCompaction` | own-accounts | `CompactionCache.IdleRecord` `{epoch, inputID, at, deadline}`. 자리를 비운 사이 압축(4.7.7)을 넣은 epoch, 그 inbox 항목, 넣은 시각과 그때의 캐시 마감. 같은 epoch에 두 번 넣지 않고, 압축 hook이 그 항목을 알아보고 늦게 전달된 것을 버리기 위한 기록(CC-16) |
| `sess:<sid>:epoch` | own-accounts | cold point 계수. `compaction.ended`마다, `session.revert.committed`마다(4.7.4 "revert"), 그리고 문맥 비우기의 전달과 되돌리기마다(4.7.4 "문맥 비우기") 1 올린다. 단조 증가만 하고 줄이지 않는다 |
| `sess:<sid>:compaction` | own-accounts | `{triggerTokens, setAt}`. 세션 압축 기준("더 일찍"만, 4.7.4). RPC `compaction.setSession`(9.2)으로만 쓴다 |
| `sess:<sid>:compactionDue` | own-accounts | `{inputID, epoch, P, at}`. 마지막으로 낸 `compaction.due`(9.3). 같은 epoch에 두 번 내지 않기 위한 기록. revert가 staged되면 지운다(4.7.4) |
| `sess:<sid>:children` | own-accounts | 자식 세션 id 목록. `session.created{parentID}`(`schema/src/session-event.ts:51-66`)로 채운다. plugin session 도메인에 목록 조회가 없어서 둔다(`plugin/src/promise/session.ts:153-170`). 승인 모드 전파(9.2 `session.approval.set`)와 자식 규칙(5.11)이 쓴다 |
| `sess:<sid>:childPolicy` | own-accounts | `{policy:"follow"\|"keep", providerID, since}`. 부모가 마지막으로 전환할 때 정한 자식 처리(5.11). `providerID`는 부모가 떠난 slot이다 |
| `sess:<root>:preset` | own-accounts | `Preset.Binding`(07 §5.1) `{presetID, group, revision, appliedAt, entryHash, ultra?, team?}`. 루트 세션에만 둔다. 자식은 루트의 값을 따른다(07 §2.8). T0: 루트 `session.created`에서 계정 고정(`pin()`) 뒤 같은 세션 작업 줄에서 **없을 때만** 묶음의 ★(없으면 `builtin:<group>`)으로 쓴다(`packages/own-accounts/src/presets/binding.ts`). 하위 에이전트 관문(5.11, 07 §5.4)이 호출마다 읽는다. T1: `session.preset.apply`가 언제나 덮어쓰고(07 §5.3), `ultra`는 `session.ultra.set`(`{raiseClaude?, before?, pending?}`. `pending`은 메인이 옮긴 뒤 비용 창을 기다리는 울트라 강도, 07 §2.9, 2026-10-02 T1 리뷰 수정), `team`은 own.team이 넘긴 팀 문맥(`apply{team}`, 없으면 그대로, `null`이면 지움)이다 |
| `sess:<root>:presetUsage` | own-accounts | `Preset.Usage` `{perSession, raise?:{messageID, perMessage}}`(T1, 07 §2.6). 대화당 하위 에이전트 누계와 `session.preset.raiseOnce`가 늘린 메시지 하나. 메시지당 수와 예약은 `@own/runtime` 메모리에만 둔다 |
| `sess:<root>:presetConsent` | own-accounts | `Preset.Consent` `{accounts:{<accountID>:{allow, at}}}`(T1, 07 §5.4 4단계). 역할이 종량제 계정으로 넘어갈 때 사용자가 이 대화에서만 답한 값. `session.preset.consent`로만 쓴다 |
| `sess:<sid>:speed` | own-accounts | `Speed.State` `{choice?, setAt?, beta?:{since, modelID}}`(4.8). 루트의 `choice`(없으면 표준)는 `session.speed.set`으로만 쓴다. `beta`는 그 세션에서 Anthropic fast beta 헤더를 처음 보낸 때와 모델이다(자식도 가짐). 압축이 끝나면 지운다 |
| `ack:claudeFast` | own-accounts | `Speed.Consent` `{at}`(4.8). Claude 구독 슬롯의 Fast가 추가 사용량으로 과금된다는 한 번만 받는 동의. `session.speed.set{consent:true}`로만 쓴다 |
| `claude:firstRequest:<accountID>` | own-accounts | `{at, sessionID}`(8.9, CW 2026-10-19). 이 서비스가 그 Claude 계정으로 처음 요청을 보낸 때와 그 트리의 루트. 있으면 `claude_first_request`를 다시 내지 않는다. own-accounts의 `http.response` hook만 쓴다(CR 2026-10-26: 답이 온 요청, 전에는 `http.request`) |
| `notes:<워크스페이스 키 해시>` | own-accounts | 워크스페이스 노트의 목록 `{notes:[{id, title, rev, updatedAt}]}`(만든 순서, NOTES, 9.2). 키 해시는 정규 워크스페이스 키(`Notes.workspaceKey`)의 SHA-256 앞 32자. 세션 단위가 아니라 워크스페이스 단위이고, `notes.put`·`notes.remove`만 쓴다. 마지막 노트를 지우면 행도 지운다 |
| `notes:<워크스페이스 키 해시>:<노트 id>` | own-accounts | 그 노트의 내용(문자열, 200,000자 이하). 제목과 revision은 목록 행에 있다 |
| `ideas:<아이디어 id>` | own-accounts | 아이디어 노트 하나 `{id, text, color, pinned, rev, createdAt, updatedAt}`(IDEAS, 9.2). 프로젝트·세션과 상관없는 전역 행이고 `ideas.put`·`ideas.remove`만 쓴다. `ideas.list`는 접두사 `ideas:`를 훑는다(500개씩) |
| `projectList` | own-accounts | 프로젝트 순서와 고정(SBL, 9.2) `{pinned: id[], order: id[]\|null, orderedAt: ms\|null}`. 사이드바가 이 서비스의 프로젝트를 늘어놓는 순서다. 서비스마다 하나(이 PC, SSH 호스트, 다른 PC)이고 `projectList.set`만 쓴다. 행이 없거나 읽을 수 없으면 고정 없음, 기본 순서. id만 있고 경로나 이름은 없다 |
| `conversationFolder` | own-accounts | 기본 대화 폴더(DF, 9.2) `{path}`(절대 경로). 사용자가 설정 > 일반에서 고른 폴더이고, 행이 없으면 서비스의 기본값이다. 서비스마다 하나(이 PC, SSH 호스트, 다른 PC)이고 `conversationFolder.set`만 쓴다. 기본값과 같은 폴더는 저장하지 않는다 |
| `websearch:multi` | own-accounts | `여러 서비스 함께`(MS 2026-10-19, 9.2)가 물을 웹 검색 서비스 `{services: id[]}`, 설정 > 웹 검색에 보이는 순서. 행이 없으면 지금 목록에 있는 서비스에 대한 own의 기본(ChatGPT와 키 없는 core 서비스)이다. 서버에 하나라 모든 창과 기기가 같다. `websearch.set{multi, services}`만 쓰고, 다른 선택을 저장해도 남는다 |
| `folderPicker` | own-accounts | 폴더 열기 시작 위치(DF, 9.2) `{start}`(있는 폴더의 절대 경로). 행이 없으면 클라이언트가 마지막으로 연 폴더의 상위 폴더, 그것도 없으면 홈 폴더에서 연다. `folderPicker.set`만 쓴다 |
| `protectedPaths` | own-accounts | 에이전트가 못 여는 파일·폴더의 사용자 목록(PP, 9.2, 01 §13) `{paths: string[]}`. 사용자가 적거나 고른 그대로(`~` 유지) 더한 순서로 둔다. 행이 없으면 빈 목록이다. `protectedPaths.add`·`remove`만 쓰고, 쓴 뒤 런타임 broadcast `protectedPaths.changed`로 모든 Location의 인스턴스가 바로 받는다 |

- 동의 기록 키 `ack:claudeAuth`는 01 §7·§9.1과 같다.

---

## 3. 로그인과 자격 증명

### 3.1 원칙

- **C1. 비밀은 vault에만 둔다.**
  - OpenCode `credential` 테이블에 넣지 않는다. 값이 평문 JSON이다(`core/src/credential/sql.ts:5-14`).
  - provider·model overlay에도 넣지 않는다. `GET /api/provider`가 `settings`와 `headers`를 그대로 돌려준다(`server/src/handlers/provider.ts:12-29`).
  - 예외는 두 가지뿐이다. Claude 구독 슬롯(서드파티 플러그인 자체 동작, 8장), 그리고 사용자가 명시적으로 켜고 UI에 평문 저장으로 표시되는 대체 모드(3.7).
  - linked 가져오기(3.2a)는 예외가 아니라 "우리가 저장하지 않는" 경우다. 비밀은 이전 앱이 이미 둔 파일에 있고 우리는 읽기만 한다. 우리 쪽 어디에도(vault, DB, KV, 로그) 복사하지 않는다. takeover는 vault로 복사한다.
- **C2. 서버 환경 변수에 키를 두지 않는다.**
  - shell 도구의 자식 프로세스가 환경 변수를 상속하므로 모델이 읽을 수 있다[R-critique #19].
  - 우리 provider는 `Auth.none` 경로라 환경 변수를 보지 않는다(`model-resolver.ts:374-380`). Anthropic 패키지의 `ANTHROPIC_API_KEY` 대체 경로(`ai/src/providers/anthropic.ts:32-37`)도 route auth가 none이면 쓰이지 않는다.
- **C3. 토큰 계열 하나에는 refresher 하나.**
  - OpenAI refresh token은 쓸 때마다 바뀐다. 두 곳에서 같은 계열을 refresh하면 "refresh token was already used"가 난다(openai/codex #6498, #9634, [R-critique #2(c)]).
  - 계정의 토큰은 세 출처 중 하나다(`accounts.json.accounts[].credential`, `packages/own-protocol/src/credential.ts:55-59`).
    - `vault`(기본): 우리 플러그인으로 새로 로그인한 계정(3.2). 우리가 유일한 refresher다.
    - `linked-codex-source`: 이전 앱(codex-multi-provider) 프로필의 로그인을 **읽기만** 한다(3.2a). 이전 앱이 유일한 refresher이고 우리는 refresh를 절대 하지 않는다.
    - `takeover-codex-source`: 이전 앱 프로필의 토큰을 vault로 한 번 복사했다(3.2a). 그때부터 우리가 유일한 refresher이고 이전 앱의 그 프로필은 다시 로그인해야 할 수 있다.
    - `linked-legacy-key`(API 키 계정): 이전 앱이 저장한 API 키 파일을 **읽기만** 한다(3.2b). refresh할 것이 없고, 키를 바꾸는 쪽은 이전 앱뿐이다.
  - 이전 판의 "가져오기는 만들지 않는다"는 사용자 결정(2026-09-27, D7)으로 위 3.2a 설계로 바뀌었다. refresher를 하나로 두는 원칙은 그대로다. linked는 우리가 refresher가 아니고, takeover는 이전 앱을 refresher에서 빼는 방식으로 이 원칙을 지킨다.
  - 여전히 공유하지 않는 것: Codex CLI 자체의 `~/.codex/auth.json`, Codex 앱, OpenCode 내장 `openai` 로그인. 이들은 각자 refresh하므로 linked로 읽어도 우리 쪽에서 막을 방법이 없다. 가져오기 대상은 이전 앱의 control-center 프로필뿐이다.
- **C4. 전역 active를 바꾸는 업스트림 경로를 쓰지 않는다.**
  - `connect.key`와 OAuth complete는 항상 새 credential을 activate한다(`core/src/credential.ts:100-148`).
  - own-web은 우리 kind에 대해 내장 connect UI를 노출하지 않는다. 내장 `openai`에 ChatGPT가 연결되어 있으면 경고만 한다.
- **C5. 계정 가드.** 재로그인 결과의 지문(`sha256(chatgpt_account_id + ":" + sub)`, `packages/own-runtime/src/hash.ts:44-46`)이 저장된 지문과 다르면 거부한다. 문구는 "다른 계정으로 로그인되었습니다"다. 이전 프로젝트 `docs/design/shared-login-storage-42.md`의 account guard에서 가져왔다.
  - 가져온 계정(3.2a)에도 같은 가드를 매 읽기마다 적용한다. 기대 값은 레지스트리의 `identity.chatgptAccountId`와 `identity.fingerprint`다(`packages/own-runtime/src/credentials.ts:433-435`). 파일의 `tokens.account_id`와 JWT claim의 account id가 서로 달라도 거부한다(`packages/own-runtime/src/codex-source.ts:131-135`).
  - 지문은 `sub`까지 보므로 같은 ChatGPT Business workspace의 다른 구성원(account id는 같고 사용자가 다름)도 거부된다(`codex-source.ts:93-101`).
- **C6. `originator: "opencode"`를 유지한다.** `codex_cli_rs` 같은 다른 클라이언트로 위장하지 않는다[R-critique #2(d)]. client id는 업스트림과 같은 `app_EMoamEEZ73f0CkXaXp7hrann`이다(`openai.ts:13`).
  - Sign in with ChatGPT(3.2c)는 공유 client를 쓰지 않는다. 사용자가 로그인할 때 이 앱의 client를 새로 등록하고, 등록 이름(`agent_name_hint`)은 이 앱의 실제 이름 `Own OpenCode`다. 첫 등록에만 보내고 다른 앱 이름을 쓰지 않는다.

### 3.2 ChatGPT(codex) 로그인

**구현 위치**: 업스트림 OAuth 구현은 모듈 내부에 있고 integration `openai`에 묶여 있다(`openai.ts:50-107,169-228`). 그래서 `own-accounts`에 그 로직을 옮겨 온다(MIT). 구현을 export하는 코어 패치는 원장 P-009이고 rejected다. `openai.ts`의 최근 30일 커밋은 13건이다.

**device code(기본, 브라우저 없는 환경도 됨)** — 호출 순서는 `openai.ts:179-225`와 같다.
1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode` 본문 `{client_id}` → `{device_auth_id, user_code, interval}`
2. UI에 `user_code`와 `https://auth.openai.com/codex/device`를 보여 준다. RPC 이벤트는 `account.status{phase:"awaiting_user"}`다.
3. `POST …/api/accounts/deviceauth/token` 본문 `{device_auth_id, user_code}`로 폴링한다.
   - 간격은 `max(interval,1s) + 3s`다.
   - 403과 404는 대기 중이라는 뜻이다. 그 밖의 상태 코드는 실패다.
4. 200 응답 `{authorization_code, code_verifier}`를 받으면 `POST …/oauth/token`으로 교환한다. `redirect_uri`는 `https://auth.openai.com/deviceauth/callback`이다(`openai.ts:323-335`).

**브라우저 PKCE(보조)**
- `localhost:1455`에서 받고, 안 되면 1457을 쓴다(`openai.ts:15-16,109-133`).
- scope와 추가 파라미터는 `openai.ts:388-401`과 같다.
- 1455는 Codex CLI 로그인과 겹치므로 기본값을 device code로 둔다[R-critique #2(c)].

**완료 처리**
1. 받은 토큰(`access`, `refresh`, `id_token`, `expiresAt = now + expires_in`)을 **곧바로 vault에 쓰고 fsync한다.**
2. claim을 읽는다. `chatgpt_account_id`는 `openai.ts:403-417`의 순서로 찾는다. email, plan, 사용자 id 추출은 ⚠AC-P22.
3. **중복 로그인은 어느 흐름에서든 재인증이다.** 두 번째 계정을 만들지 않는다.
   - 재인증 흐름(`start{accountID}`): 지문이 그 계정과 같아야 한다. 다르면 거부한다(C5).
   - 새 계정 흐름(`start{}`): 같은 지문의 계정이 있으면 `status`가 `duplicateOf: accountID`를 돌려준다. `complete`는 새 계정을 만들지 않고 그 계정의 토큰을 새 값으로 바꾼다. 응답은 `{account, reauthenticated:true}`다.
   - 03 §5.4는 새 계정 흐름에서 `duplicateOf`를 받으면 `이미 추가된 계정입니다 ("개인 Pro"). 이 로그인으로 기존 계정의 로그인을 갱신할까요?`를 묻는다. 사용자가 `기존 계정 로그인 갱신`을 누르면 `complete`, `취소`를 누르면 `cancel`을 부른다.
4. `accounts.json`에 cache domain, quota domain, account, slot을 만든다. 모델 템플릿은 codex kind의 현재 템플릿을 쓰고, 없으면 3.6a 규칙으로 새로 만든다.
5. provider를 다시 불러오라고 알린다(3.8).

### 3.2a Codex 로그인 가져오기(codex-multi-provider, 사용자 결정 D7)

이전 앱(codex-multi-provider)에 이미 로그인된 ChatGPT 프로필을 새로 로그인하지 않고 계정으로 쓴다. 프로토콜과 runtime은 구현되어 있다(`packages/own-protocol/src/rpc.ts:174-209,484-517`, `credential.ts`, `packages/own-runtime/src/codex-source.ts`, `credentials.ts`). 이 절은 그 동작의 계약이다.

**원본**
- control-center 루트: 기본 `D:\#Projects\codex-multi-provider\work\control-center`(`codex-source.ts:17-18`). 다른 루트는 own-accounts 플러그인 옵션 `codexImportRoot`로 준다(`packages/own-accounts/src/options.ts`, 구현 진행 중. e2e는 이 옵션으로 가짜 control-center를 가리킨다).
- `state.json`에서는 `profiles[].{id, alias, auth_mode, login_state}`만 읽는다(`credential.ts:136-147`). 읽기 상한은 16 MiB다.
- `profiles\<id>\codex\auth.json`: `{auth_mode, tokens:{id_token, access_token, refresh_token, account_id}, last_refresh}`(`credential.ts:89-134`). 읽기 상한은 1 MiB이고(`codex-source.ts:20-21`), 모르는 필드는 메모리에서도 버린다.
- 프로필 id는 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`만 받는다. 그래서 id로 `profiles\` 밖을 가리킬 수 없다(`credential.ts:15`, `codex-source.ts:111,186-200`). RPC는 경로가 아니라 profileID만 받고, 경로는 서버가 만든다(`rpc.ts:490-492`).
- `auth_mode`가 없으면 Codex CLI의 `resolved_mode`처럼 `OPENAI_API_KEY`가 있으면 apikey, 없으면 chatgpt로 본다(`credential.ts:115-118`). chatgpt 모드이고 세 토큰이 모두 있어야 가져올 수 있다.
- 이 파일들은 linked와 takeover 모두 **절대 쓰지 않는다.** 쓰는 쪽은 이전 앱과 그 앱이 띄우는 Codex 런타임뿐이다.

**두 모드**

| | linked(기본) | takeover |
|---|---|---|
| 비밀 위치 | 이전 앱의 `auth.json`(읽기만). vault 항목 없음 | `vault\<accountId>.dpapi`(한 번 복사, `.prev` 보존) |
| refresher | 이전 앱만. 우리는 token endpoint를 부르지 않는다(`credentials.ts:262-268`) | 우리만(3.5 F1–F7) |
| 이전 앱의 그 프로필 | 계속 쓸 수 있다 | 우리 첫 refresh 뒤 그 프로필의 refresh token이 죽는다. 이전 앱은 다시 로그인해야 할 수 있다. **⚠ 이전 앱에서 이 프로필을 다시 열면 우리 로그인까지 끊길 수 있다**(아래 "takeover 뒤 이전 앱 재사용 위험") |
| 만료·401 | 이전 앱이 새 토큰을 쓸 때까지 stale(`codex_source_stale`, 아래) | 3.5 규칙대로 우리가 refresh |
| 계정 삭제 | 원본 파일을 건드리지 않는다. `accounts.remove.plan`의 `willShredVault:false`(`rpc.ts:552-553`) | vault를 shred한다(F7). 원본 파일은 건드리지 않는다 |
| `accounts.list` 표시 | `connection:{type:"oauth", method:"codex-linked", source:{app, profileID, alias, mode:"linked", superseded:false}}`(`account.ts` Connection) | `method:"codex-takeover"`, `source.superseded:true` |
| plan 경고 | `linked_depends_on_source` | `takeover_supersedes_source` |

**흐름(RPC, 9.2)**
1. `accounts.import.codex.list{}` → `{available, sources:[CodexCandidate]}`
   - `available:false`면 control-center의 `state.json`을 읽을 수 없다(이전 앱 미설치 등). UI는 가져오기 입구를 숨긴다.
   - 후보마다 `importable`, `problem`(`unreadable|parse_failed|not_chatgpt|missing_tokens|token_expired|account_mismatch`, `packages/own-protocol/src/error.ts:9-18`), 마스킹한 email, plan, `lastRefresh`를 준다. 이미 가져온 프로필이면 `importedAs:{accountID, mode}`도 준다. 토큰 값은 없다.
   - 후보마다 파일을 한 번 읽고 토큰은 메모리에 남기지 않는다(`CodexSource.inspect`, `codex-source.ts:166-175`).
2. `accounts.import.codex.plan{profileID, mode?:"linked"|"takeover", accountID?}` → `{nonce, expiresAt, profileID, alias, mode, identity, duplicateOf, warnings}`. 부작용이 없다.
   - `duplicateOf`: 같은 지문의 계정이 이미 있다(own 로그인 계정 포함). `execute`는 새 계정을 만들지 않고 그 계정의 `credential`을 바꾼다. 3.2 3번 "중복 로그인은 재인증"과 같은 규칙이다. providerID가 그대로이므로 캐시에 영향이 없다.
   - `accountID`: 지문 탐지 대신 이 계정을 대상으로 다시 연결(re-link)하거나 takeover한다. 원본이 그 계정의 로그인이 아니면 `source_invalid{reason:"account_mismatch"}`다.
   - `warnings`: `linked_depends_on_source`(linked), `takeover_supersedes_source`(takeover), `source_token_expired`(지금 토큰이 만료됨. linked면 이전 앱이 갱신할 때까지 쓸 수 없다).
3. 확인 대화상자(파괴적 동작 규칙, 9.2) → `accounts.import.codex.execute{nonce, label?, color?}` → `{account, mode, reauthenticated}`
   - **execute는 원본을 다시 읽는다.** plan과 execute 사이에 이전 앱이 refresh했을 수 있기 때문이다(`Credentials.takeover`는 execute 시점에 읽는다, `credentials.ts:289-318`).
   - 새 계정이면 3.2 완료 처리 4–5번(도메인·slot·템플릿 생성, provider reload)과 같다. `label` 기본값은 alias다.
   - takeover: vault에 `put{keepPrev:true}`로 쓴다(`obtainedAt`은 원본 `last_refresh`). 그다음 **곧바로 강제 refresh를 한 번 한다.** own-accounts의 execute 핸들러가 `Credentials.refresh(account, refresher, {force:true})`를 부른다(runtime `takeover()`는 복사만 한다). 두 곳이 같은 refresh token을 쥔 시간을 없애 refresher를 확정하기 위해서다.
     - 이 refresh가 `refresh_token_reused`로 실패하면 이전 앱이 그 사이 refresh한 것이다. 원본을 다시 읽어 **한 번만** 다시 한다. 또 실패하면 `needs_reauth`로 두고 알린다.
     - client id(소스 확인): 이전 앱 런타임의 refresh client id는 상수 `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`으로 우리 값(C6)과 같다(`D:\#Projects\codex-multi-provider\runtime\codex-rs\login\src\auth\manager.rs:1708`). 이 값을 바꾸는 env `CODEX_APP_SERVER_LOGIN_CLIENT_ID`는 `oauth_client_id()`가 읽지만(`manager.rs:201,1710-1714`) 설정하는 곳은 테스트뿐이다(`runtime/codex-rs/login/tests/suite/auth_refresh.rs:99,188`, `app-server/tests/suite/v2/account.rs:2348`. 이전 앱의 `manager\`·`scripts\`·`config\`에는 없음). 그래도 첫 refresh가 client 불일치 계열 오류(`invalid_client`, `unauthorized_client`)로 실패하면 execute는 takeover를 되돌리고(vault 항목 shred, credential을 linked로) 오류로 알린다. 원본 계열은 쓰이지 않았으므로 linked로 계속 쓸 수 있다 ⚠구현. AC-P39 (g)는 이 확인을 실제 프로필로 한 번 하는 점검이다.
   - 오류: `nonce_invalid`, `account_not_found`(plan 뒤 대상 계정이 지워짐), `source_not_found{profileID}`, `source_invalid{profileID, reason}`, `template_unavailable`, `vault_unavailable`(`rpc.ts:501-517`).
4. 모드 바꾸기
   - linked → takeover: 같은 계정에 `plan{mode:"takeover", accountID}` → `execute`. 계정 id와 providerID가 같아 캐시에 영향이 없다.
   - takeover → linked: 이전 앱에서 그 프로필로 **다시 로그인한 뒤에만** 의미가 있다. 우리 refresh로 원본 계열이 이미 죽었기 때문이다. execute는 우리 vault 항목을 shred한다 ⚠구현 확인 필요.

**takeover 뒤 이전 앱 재사용 위험** ⚠
- 이전 앱 런타임은 프로필을 열 때 access token이 만료에 가까우면 **먼저 refresh한다**(`should_refresh_proactively`, `manager.rs:2924-2946`). client id와 token endpoint가 우리와 같다(`manager.rs:1708`).
- 그래서 takeover 뒤 사용자가 이전 앱에서 그 프로필을 다시 열면, 이전 앱은 우리가 이미 회전시킨(죽은) refresh token을 보낸다.
- OAuth 서버가 refresh token 재사용을 감지하면 그 **계열 전체**를 폐기하는 경우가 흔하다. auth.openai.com이 그렇게 하는지는 확인하지 못했다. 그렇게 한다면 우리 takeover 계정도 경고 없이 `needs_reauth`가 된다.
- 대응
  - `takeover_supersedes_source` 경고와 03의 takeover 확인 문구에 이 위험을 넣는다: "takeover 뒤에는 이전 앱에서 이 프로필을 열지 마세요. 열면 이 앱의 로그인도 끊길 수 있습니다."
  - AC-P39 (i)로 "우리 회전 뒤 옛 refresh token을 한 번 재사용했을 때 우리 계열이 살아남는지"를 기록한다.
  - 계열 폐기가 확인되면, 이전 앱을 계속 쓰는 동안에는 linked를 유일한 안전한 모드로 권하고 takeover는 이전 앱에서 그 프로필을 더 쓰지 않을 사용자에게만 연다.

**linked 읽기 규칙**(`CodexSource.Reader`, `codex-source.ts:256-378`)
- 요청마다 파일을 읽지 않는다. 메모리 스냅샷을 쓰고, 다음 경우에만 다시 읽는다.
  - `stat` 결과 mtime이나 크기가 바뀌었다. `stat`은 최대 1초에 한 번이다(`statIntervalMs`).
  - 스냅샷이 `policy.secretCacheSeconds`(기본 600초)보다 오래됐다.
  - 401을 받았다.
- 동시 요청은 읽기 하나를 공유한다.
- **요청 경로에서 도는 비용(구현 그대로)**: `model.request` → `Credentials.headersFor` → `Reader.usable()`이 요청 경로 **안에서** 돈다(`packages/own-runtime/src/credentials.ts:384-399`, `codex-source.ts:343-371`). 비용은 계정마다 비동기 `fs.stat` 최대 1초에 한 번이고, 위 조건일 때만 파일 전체(1 MiB 상한)를 다시 읽는다. 동시 요청은 그 한 번을 기다린다. 이 대기는 턴의 모델 요청 준비에만 걸리고 UI 스레드와 무관하다(9.1 성능 계약).
  - D4 성능 게이트(03, 01 §16.3)에서 이 대기가 문제로 재어지면, stat과 재읽기를 leader의 백그라운드 갱신기로 옮기고 hook은 스냅샷만 읽게 바꾼다. 그때 401 직후 재읽기만 요청 경로에 남긴다 ⚠(12장 Q40).
- 이전 앱이 파일을 제자리에서 쓰는 중이라 반쯤 읽히면(`parse_failed`/`unreadable`) 마지막 정상 토큰을 3번까지 더 쓴다(`graceReads`). 그 뒤에는 문제를 보고한다.
- 만료 60초 전(`expiryMarginMs`)부터는 만료로 본다.
- 401을 받으면(`Credentials.unauthorized`, `credentials.ts:168-182`) 그 access token의 hash를 기억하고 파일을 다시 읽는다. 이전 앱이 다른 토큰을 쓸 때까지 그 계정은 stale이다.
- 파일에 지문이 다른 로그인이 들어오면(이전 앱에서 계정을 바꿈) 스냅샷을 즉시 버리고 다시 쓰지 않는다(`codex-source.ts:368-369`). 계정 상태는 `misconfigured`, 문제는 `account_mismatch`다.

**stale 처리(`codex_source_stale`)**
- 조건: linked 계정의 토큰이 만료(여유 60초 포함)됐거나 401로 거부됐고, 이전 앱이 아직 새 토큰을 쓰지 않았다(`codex-source.ts:250-254`, `credentials.ts:27-28`).
- 동작
  - `model.request`는 인증 헤더를 넣지 않는다. 4.1의 실패 처리와 같다(hook은 throw하지 않는다). 요청은 401로 끝나고 retry hook이 T-AUTH로 기록한다.
  - 계정 상태는 `auth_failed`, reason은 `codex_source_stale`이다. 전역 경보 `codex_source_stale`(warning)을 내고(`packages/own-protocol/src/alert.ts:26-27`) 전환 후보에서 뺀다(5.7).
  - **refresh를 시도하지 않는다.** 이전 앱이 파일을 새로 쓰면(mtime 변화) 다음 요청에서 저절로 풀린다. 풀리면 상태를 `ready`로 되돌리고 `account.status`를 낸다.
  - 쉬는 동안에도 풀렸는지 알 수 있게, leader 인스턴스가 stale 계정의 원본을 1분에 한 번 `stat`한다. 내용은 바뀌었을 때만 읽는다.
- UI 힌트(문구는 03이 정한다)
  - 계정 카드: "이전 앱이 로그인을 갱신하지 않았습니다 — 이전 앱에서 이 프로필을 한 번 실행하세요". 동작은 `[가져오기로 전환(takeover)]`, `[다른 계정으로 전환]`.
  - 입력창: stale 계정에 묶인 세션에서는 보내기 전에 배너를 보인다. 보내면 401로 끝나기 때문이다.
  - 가져오기 대화상자: linked는 "이전 앱이 계속 로그인을 갱신해야 합니다(이전 앱을 지우거나 오래 쓰지 않으면 이 계정도 멈춥니다)", takeover는 "이제 이 앱이 로그인을 관리합니다. 이전 앱의 이 프로필은 다시 로그인해야 할 수 있습니다. 이전 앱에서 이 프로필을 열지 마세요. 열면 이 앱의 로그인도 끊길 수 있습니다"(위 "takeover 뒤 이전 앱 재사용 위험").
  - 이메일은 마스킹한다. 원본 파일 경로는 비밀이 아니지만 계정 상세에서만 보인다.
- ChatGPT access token의 수명(이전 앱이 쉬는 동안 linked 계정이 얼마나 버티는지)은 ⚠이다. AC-P39에서 기록한다.

**원격 lease와의 관계**(04 §8)
- 원격 호스트에 lease를 줄 때 linked 계정은 우리가 refresh할 수 없다. 04 §8.5의 "남은 수명이 짧으면 먼저 refresh" 대신, 남은 수명이 lease 최소 유효 기간보다 짧으면 lease를 `source_stale`로 거절한다 ⚠(04와 맞출 것, 12장).
- 가져오기 메서드는 로컬 파일 경로를 읽으므로 범위가 `local`이다(9.1). 원격 기기에서는 부를 수 없다.

**테스트**
- 단위 테스트(있음)
  - `packages/own-runtime/test/codex-source.test.ts`: 토큰 값을 드러내지 않는 파싱, 쓸 수 없는 원본 분류, 안전하지 않은 id 건너뛰기, stat 간격, 원본에 쓰지 않음, 401 뒤 stale, 이전 앱의 refresh를 집어 옴, 반쯤 쓴 파일 유예, 다른 로그인 거부, 동시 읽기 공유
  - `packages/own-runtime/test/credentials.test.ts`: linked는 vault와 refresher를 건드리지 않음, 401 뒤 재읽기, 다른 ChatGPT 로그인과 같은 workspace의 다른 구성원 거부(지문 가드), takeover는 한 번 복사한 뒤 우리가 refresh하고 원본은 그대로
- e2e(AC-P39, 11장): `packages/own-accounts/test/e2e-kit/fixtures/codex-multi-provider.ts`로 가짜 control-center를 만들고 가짜 Codex backend(`fakes/codex.ts`)로 요청한다. 테스트는 실제 `D:\#Projects\codex-multi-provider\…` 프로필을 절대 읽지 않는다(`packages/own-accounts/test/e2e-kit/README.md`).

### 3.2b 이전 앱에 저장된 API 키 연결(codex-multi-provider, linked 전용)

이전 앱(codex-multi-provider)에 저장된 API 키(처음은 DeepSeek)를 새로 입력하지 않고 계정으로 쓴다. 3.2a의 linked와 같은 원칙이다: **우리는 참조만 저장하고**, 이전 앱의 암호화 파일은 쓰지도, 복사하지도, 다시 암호화하지도 않는다. 키는 요청할 때 메모리에서만 복호화한다. takeover(우리 vault로 복사)는 없다. 키를 옮기고 싶으면 사용자가 3.3으로 새로 추가한다.

**원본(이전 앱 소스로 확인, 읽기 전용)**
- 이전 앱 루트 `<app>` = 이름이 `codex-multi-provider`인 디렉터리. 기본 `D:\#Projects\codex-multi-provider`이고, own-accounts 옵션 `codexImportRoot`(control center)가 `<app>\work\control-center`이면 그 두 단계 위다(`LegacyKey.appRootOf`, `packages/own-runtime/src/legacy-key.ts`). 그 모양이 아니면 목록은 `available:false`다(테스트·e2e backend의 `legacy-control-center` 같은 가짜 루트가 여기에 해당해 실제 파일에 닿지 않는다).
- 키 파일 위치는 이전 앱의 `credential_ref`로 정해진다(`scripts\manager_core\providers.py` `_secret_path`): `legacy:deepseek` → `<app>\profiles\deepseek.dpapi`, `dpapi:<providerId>` → `<app>\work\control-center\credentials\<providerId>.dpapi`.
- 형식: DPAPI CurrentUser, **optional entropy 없음**, `CRYPTPROTECT_UI_FORBIDDEN`, 헤더 없는 raw blob. 평문은 앞뒤 공백을 뺀 키 문자열의 UTF-8(`_crypt_secret`, `save_key`).
- 비밀이 아닌 설정: 관리자 레지스트리 `<app>\work\control-center\providers.json`의 `providers[].{id, name, base_url, protocol, credential_ref}`와 `models[].{provider_id, wire_model_id, capabilities.context_window}`. 레지스트리가 없으면 이전 앱처럼(`ProviderRegistry._legacy`) `<app>\profiles\provider.json` `{base_url, protocol, model}`을 `legacy:deepseek` 공급자 "DeepSeek" 하나로 본다. `credential_ref`가 `legacy:deepseek`이나 `dpapi:<자기 id>`가 아니면 이전 앱도 거부하므로 목록에 넣지 않는다.
- kind 대응(`LegacyKey.kindOf`): 공식 API 호스트가 kind를 정한다. `api.deepseek.com` → `ds`, `api.openai.com` → `oai`, `api.anthropic.com` → `anth`, `api.x.ai` → `xai`, `openrouter.ai` → `or`. 그 밖의 HTTPS 호스트는 이전 앱이 `chat_completions`로 말했고 모델에 context window가 있을 때만 `compat`(slot `baseURL` = 이전 앱 URL, 모델 = 이전 앱 모델)이다. 나머지는 `unsupported_provider`다. 알려진 kind는 우리 endpoint와 템플릿을 쓴다(이전 앱 URL과 모델은 plan에 정보로만 보인다).

**복호화: own-vault `linked.get`(0.2.0, `own/native/own-vault/README.md` 5.3)**
- runtime은 entropy 없는 DPAPI를 직접 풀 수 없다(01 §13.1: `bun:ffi`·PowerShell 금지). 그래서 helper에 읽기 전용 op 하나를 두었다: `{"op":"linked.get","path"}` → `{value, size, mtimeMs}`.
- helper는 허용 목록 경로만 연다: 드라이브 절대 경로이고 끝이 `codex-multi-provider\profiles\<name>.dpapi` 또는 `codex-multi-provider\work\control-center\credentials\<name>.dpapi`(대소문자 무시, `..`·`.`·빈 구성 요소·끝 점/공백·ADS·UNC·`\\?\` 거부), `codex-multi-provider`부터 파일까지 reparse point 없음, 일반 파일, 16 KiB 이하. 파일은 읽기 공유 모드로 열어 이전 앱이 언제든 교체할 수 있다. 오류 메시지에 값과 경로를 넣지 않는다. 허용 목록이 없으면 helper가 사용자의 모든 entropy 없는 DPAPI blob(브라우저 등)을 푸는 도구가 된다.
- TS client도 같은 검사를 먼저 한다(`Vault.linkedPathProblem`). helper가 0.1.0이면 `unknown_op` → 문제 `helper_outdated`.

**참조(`accounts.json`)**: `credential: {type:"linked-legacy-key", source:{app:"codex-multi-provider", providerRef, name, path}, linkedAt}`(`packages/own-protocol/src/credential.ts` `LinkedLegacyKey`). vault 항목은 없다. 레지스트리에는 `identity.keyHint`(끝 4자)만 남는다. `accounts.list`의 `connection`은 `{type:"key", method:"legacy-key-linked", legacyKey:{app, providerRef, name}}`이고 파일 경로는 보내지 않는다.

**읽기 규칙**(`LegacyKey.Reader`, runtime `Credentials`)
- 키는 프로세스 메모리에만 둔다(private field. JSON·inspect·로그에 나오지 않음). 캐시 키는 파일 경로 + helper가 읽은 mtime·크기다.
- 요청마다 helper를 부르지 않는다. `stat`은 최대 1초에 한 번이고, mtime이나 크기가 바뀌었거나, `policy.secretCacheSeconds`(기본 600초)가 지났거나, **401을 받았으면**(`Credentials.unauthorized` → `invalidate`) 다음 사용 때 helper로 다시 읽는다.
- 파일이 없어지거나, 풀 수 없거나, 키 형식이 아니게 되면 기억한 키를 즉시 버리고 다시 쓰지 않는다(이전 앱에서 지운 키는 여기서도 멈춘다). 실패한 파일은 1초 안에 다시 읽지 않는다. helper에 닿지 못하면 `vault_unavailable`(일시적)다.
- 헤더는 kind 규칙 그대로다(4.1: `anth` `x-api-key`, 나머지 `Authorization: Bearer`). refresh·lease·`.prev`는 없다(F9와 같음).
- 상태(`credentials/status.ts`): 파일 문제(`not_found`, `decrypt_failed`, `path_denied`, `invalid_key`, `unreadable`, `helper_outdated`) → `misconfigured`(reason = 문제). 파일이 다시 쓸 수 있는 키를 가지면 `ready`로 돌아온다(leader가 1분마다 `stat`). 공급자가 키를 거부하면(연결 테스트 401) `auth_failed`, reason `legacy_key_rejected`이고, 파일을 읽을 수 있다는 것만으로는 풀리지 않는다(연결 테스트가 성공해야 `ready`). `codex_source_stale` 경보는 내지 않는다.
- 원격 호스트(04 §8)에는 다른 key 계정처럼 lease 헤더로 간다(만료가 없으므로 refresh 문제 없음). 파일을 읽을 수 없으면 lease는 `source_stale`로 거절된다.

**흐름(RPC, 9.2 `accounts.import.keys.*`, 범위 `local`)**
1. `list{}` → `{available, keys:[LegacyKeyCandidate]}`. **복호화하지 않는다**(키 파일은 `lstat`만). 항목마다 `providerRef, name, kind|null, baseURL, models, keySaved, importable, problem?, importedAs?{accountID}`. 키와 경로는 없다.
2. `plan{providerRef}` → `{nonce, expiresAt, providerRef, name, kind, label, baseURL, model, keyHint, duplicateOf, warnings}`. 키를 한 번 읽어(메모리) `keyHint`와 중복을 본다. 경로는 서버가 `providerRef`로 만든다(RPC는 경로를 받지 않음). `label` 제안은 `"<이전 앱 이름> (이전 앱)"`(예: `DeepSeek (이전 앱)`). `duplicateOf`: 같은 파일을 연결한 계정, 또는 같은 kind(compat은 같은 base URL)에서 인증 헤더 hash가 같은 계정(vault·linked 모두). `warnings`: 항상 `linked_key_depends_on_source`, 이전 앱 모델이 우리 템플릿에 없으면 `model_not_in_template`.
3. 확인 → `execute{nonce, label?, color?, dryRun?}` → `{account|null, dryRun, keyHint, test:{ok, skipped, detected?}}`.
   - execute는 **파일을 다시 읽는다**(plan 뒤 이전 앱이 바꿨을 수 있음). 중복이면 `duplicate_account{accountID}`.
   - `dryRun:true`: 읽기와 중복 확인까지만 하고 연결 테스트를 보내지 않으며 계정을 만들지 않는다. nonce는 그대로 유효하다.
   - 아니면 kind의 연결 테스트(3.3 표, `ds`는 `GET /user/balance`)를 한다. 실패하면 `probe_failed{status?, message}`이고 아무것도 만들지 않는다. 성공하면 3.3 4–5번처럼 도메인·slot·템플릿을 만들되 vault에는 쓰지 않는다(`method:"legacy-key-linked"`).
   - 오류: `nonce_invalid`, `legacy_key_not_found{providerRef}`(공급자나 키 파일 없음), `legacy_key_invalid{providerRef, reason}`(`OwnError.LegacyKeyProblem`), `probe_failed`, `duplicate_account`, `template_unavailable`, `vault_unavailable`, `remote_managed`.
4. 이후
   - `accounts.update{replaceKey}`는 `policy_denied{field:"replaceKey"}`다. 키는 이전 앱에서 바꾼다(여기서 따라감).
   - `accounts.remove.plan`의 `willShredVault`는 `false`이고, `execute`는 우리 참조(계정·slot 상태)만 바꾼다. vault helper를 부르지 않고 이전 앱 파일도 건드리지 않는다.
   - 승인 모드 규칙 묶음(9.2 `session.approval.*`, `switching/approval.ts` `protectedPaths`)은 키 파일의 디렉터리(`<app>\profiles`, `…\credentials`)를 모든 모드에서 보호 경로로 넣는다.

**테스트**: own-vault `cargo test`(허용 목록·reparse point·크기·entropy 없는 blob·PowerShell `ProtectedData`로 만든 키를 실제 exe가 읽음), `packages/own-runtime/test/legacy-key.test.ts`(허용 목록 거울, 목록, reader 캐시·재읽기·폐기, 헤더), `vault.test.ts`(실제 exe), `packages/own-accounts/test/credentials/legacy-import.test.ts`(list/plan/execute·dryRun·중복·401·상태·삭제), `legacy-import.e2e.test.ts`(실제 서버 + 실제 `own-vault.exe` + PowerShell로 만든 가짜 DPAPI 키 + DeepSeek fake: 요청 헤더, 키 교체 추적, `replaceKey` 거부, 삭제 뒤 파일 불변, 비밀 비노출), `packages/own-web/e2e/legacy-keys.spec.ts`(모의 RPC). 테스트는 실제 이전 앱 파일을 읽지 않는다.

### 3.2c Sign in with ChatGPT(토큰 공유, kind `siwc`)

OpenAI의 공식 "Sign in with ChatGPT" 토큰 공유(2026-09-29 공개)로 ChatGPT 요금제 사용량을 공개 API에서 쓰는 로그인이다. 3.2의 Codex 방식 로그인과 같은 RPC(`accounts.add.chatgpt.{start,status,complete,cancel}`)와 같은 대화상자를 쓰고, `start{method:"siwc"}`로 고른다. 결과는 별도 kind `siwc`(providerID `own-siwc-<slug>`)다.

**구현 위치**: `packages/own-accounts/src/credentials/sharing.ts`(`ChatgptSharing`). 업스트림 `core/src/plugin/provider/chatgpt.ts`(0f83038253, MIT)의 상수와 순서를 옮겼다. 업스트림 코어 플러그인을 쓰지 않는 이유는 두 가지다. 그 플러그인은 내장 `openai` provider에 붙어서 `hideBuiltinProviders:"auto"`(2.4.3)에 함께 숨고, credential 테이블(C1)과 전역 active(C4)를 쓴다. 로그인 관리(시도, 콜백, 가드)는 `credentials/chatgpt.ts`의 `Manager`가 Codex 로그인과 같이 맡는다.

**codex와 다른 점**

| 항목 | codex(3.2) | siwc |
|---|---|---|
| client | 고정 공개 client `app_EMoamEEZ73f0CkXaXp7hrann` | 첫 로그인은 `dynamic_agent_client` + `agent_name_hint="Own OpenCode"`로 등록하고, 콜백이 돌려준 발급 client id(`oaiapp_…`)를 그 계정에 저장해 계속 쓴다 |
| endpoint | `/oauth/authorize`, `/oauth/token`, device code | `/api/accounts/authorize`, `/api/accounts/oauth/token`, `/api/accounts/oauth/revoke`, `/.well-known/jwks.json`(모두 `endpoints.oauthIssuer` 아래). device code 없음 |
| 콜백 | `http://localhost:1455`(또는 1457) | `http://127.0.0.1:<임시 포트>/auth/callback`. localhost를 쓰지 않는다(등록이 콜백 host에 묶인다) |
| 추론 | `https://chatgpt.com/backend-api/codex`, websocket, `chatgpt-account-id`·`session-id`·`originator` 헤더, zstd 본문 | 공개 API 기본 base URL(`settings.baseURL` 생략), HTTP, `Authorization: Bearer`와 Codex 클라이언트의 세션 헤더 `session-id`(세션 affinity)·`thread-id`·`x-client-request-id`(세션 ID), zstd 본문(업스트림 `chatgpt.ts` 5183ea45c3·5673bfa4a8, 2026-10-24). `chatgpt-account-id`·`originator`는 없다 |
| 신원 | `chatgpt_account_id` + `sub`, 서명 검증 없음(토큰 endpoint 응답) | jose로 검증한 ID token의 `sub`와 email. 지문은 `sha256(발급 client id + ":" + sub)` |
| 도메인 | cache `chatgpt_login`, quota `chatgpt_seat`(account id) | cache·quota 모두 `chatgpt_sharing`, externalId = 발급 client id |
| 압축 | provider summary | provider와 **모든 모델**에 summary(`/responses/compact` 없음) |

**흐름**
1. `start{method:"siwc", accountID?, consent?, retryOf?}`
   - `ext_agent_host_id`를 KV `chatgpt:agentHost`(2.4.6)에서 읽고, 없으면 `urn:uuid:<v4>`를 만들어 **저장한 뒤** 쓴다. 읽거나 저장할 수 없으면 시작하지 않는다(`host_id_unavailable`). 읽기가 실패했을 때 새 id로 덮어쓰지 않는다(그러면 이 PC의 host가 OpenAI 쪽에서 바뀐다).
   - 새 계정은 `dynamic_agent_client`로 등록한다. 다른 계정의 client id를 빌리지 않는다(업스트림은 활성 credential의 id를 재사용해 "계정 추가"가 기존 등록을 재인증하는 문제가 있다).
   - 예외는 다시 시도뿐이다. `retryOf`가 끝난(실패·취소) 새 계정 시도를 가리키고 그 시도가 발급 client id를 받았으면(콜백이 준 id. 거절 콜백도 id를 주면 기억한다) 그 id를 다시 쓴다. "동의 후 다시 시도"나 JWKS 장애 뒤의 재시도가 client를 하나 더 등록해 ChatGPT 설정에 주인 없는 앱을 남기지 않게 하려는 것이다(OpenAI 문서: 동의 재시도는 저장한 client id로 한다). 완료된 시도와 재로그인 시도의 id는 넘기지 않는다.
   - 재로그인(`accountID`)은 그 계정의 발급 client id를 쓴다. vault 항목의 `clientId`가 먼저이고, 없으면 cache domain의 externalId다. 둘 다 없으면 `client_id_missing`이다. `agent_name_hint`는 보내지 않는다.
   - 재로그인 대상은 같은 kind여야 한다. siwc로 codex 계정을, device/browser로 siwc 계정을 재로그인하면 `account_not_found`다.
   - PKCE(S256), `state`, `nonce`를 새로 만들고, `127.0.0.1` 포트 0에 listener를 먼저 띄운 뒤 authorize URL을 돌려준다. scope는 `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`이다. `consent:true`(사용자가 "동의 다시 받기"를 누른 경우)만 `prompt=consent`를 더한다. ⚠ 이 값이 scope 동의를 실제로 다시 묻는지 확인하지 못했다. 업스트림 `chatgpt.ts`에는 `force_reconsent`가 주석으로만 남아 있다(12장 53).
2. 콜백(GET `/auth/callback`)
   - Host가 `127.0.0.1:<port>`가 아니면 400(DNS rebinding). 다른 경로는 404, GET이 아니면 405.
   - `state`가 정확히 하나이고 시간 일정 비교로 같아야 한다. 아니면 400이고 **시도를 소모하지 않는다**(엉뚱한 요청 하나가 로그인을 실패시키지 않는다). `code`가 없을 때도 같다.
   - `error`가 있으면(state가 맞을 때) `authorization_denied`로 끝낸다.
   - `client_id`: 시도에 묶인 id(재로그인의 저장 id, 또는 앞선 콜백이 준 id)와 다르면 `client_mismatch`로 끝내고 교환하지 않는다. 재인증 콜백은 `client_id`를 빼도 된다. id가 없거나 `dynamic_agent_client`면 `client_id_missing`, 형식(`^[A-Za-z0-9_-]{1,200}$`)이 아니면 `client_id_invalid`다.
   - 교환: `grant_type=authorization_code`, 발급 client id, `code_verifier`, 같은 `redirect_uri`, `resource`. 네트워크 오류나 5xx면 503 페이지를 주고 시도를 **대기 중으로 둔다**. 콜백 페이지를 다시 열면 같은 client id로 다시 교환한다(새 등록이 생기지 않는다).
   - 응답 `scope`에 `chatgpt.tokens.use.direct`가 없으면 `token_sharing_not_granted`다. UI는 "동의 다시 받기"(`consent:true`, `retryOf`)를 제안한다.
   - ID token 검증(jose 6.0.11): RS256, `iss` = issuer, `aud` = 발급 client id, `iss/aud/exp/iat/sub` 필수, 시계 허용 5초, `sub`가 비어 있지 않음, `azp`는 없거나 client id, `nonce`가 이 시도의 값. JWKS를 가져오지 못하면 `jwks_unavailable`(나중에 다시)이고 잘못된 신원(`id_token_invalid`)과 구분한다. 신원 claim(`sub`, `nonce`, `azp`, `iss`, `aud`, `exp`)은 한 묶음으로 읽어 하나라도 모양이 틀리면 실패한다. email·plan·account id는 하나씩 읽어 모양이 틀린 것만 버린다(`Jwt.sharing`). 서명이 맞는 토큰이 `email: null` 하나로 로그인을 막지 않게 하려는 것이다.
   - 이 검사들(scope, ID token)로 버리는 토큰 응답은 아무도 갖지 않으므로 그 refresh token을 백그라운드에서 revoke한다(최선 노력, 기다리지 않는다). 교환 뒤에 버리는 토큰도 같다. `authorized` 시도를 취소하거나 만료시킬 때, 시도가 끝난 뒤 도착한 토큰, 계정 가드가 거절한 토큰(`account_not_found`, `account_mismatch`, `identity_missing`), `complete`가 vault에 쓴 뒤 계정을 만들지 못해 지우는 토큰이다(`chatgpt_sharing_attempt_revoked`). 그대로 두면 누구도 갖지 않고 앱에서 끝낼 수도 없는 30일짜리 refresh family가 issuer에 남는다.
   - 교환이나 계정 가드가 예외로 끝나면 시도를 `callback_failed`로 끝내고(가진 토큰은 위처럼 revoke) 실패 페이지(500)를 준다. 시도가 교환 중 표시를 단 채 만료까지 대기하지 않게 하려는 것이다. jose를 불러오지 못하거나 issuer로 JWKS URL을 만들 수 없으면 예외 대신 `jwks_unavailable`이다.
   - 그다음 3.2와 같은 계정 가드(C5)를 지난 뒤에만 성공 페이지(200)를 준다. 모든 콜백 페이지는 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, 스크립트 없는 CSP, `nosniff`를 단다.
3. `complete`는 3.2와 같다. 토큰을 vault에 먼저 쓴다(family `openai-chatgpt-sharing`, `clientId`, `scopes`, `earliestRefreshAt`, 2.4.5). 새 계정의 라벨 기본값은 마스킹된 email, 없으면 "ChatGPT"다. `method`는 `chatgpt-siwc`다.
   - 다른 `complete`가 아직 쓰는 중인 시도는 `attempt_storing`으로 거절한다. 같은 토큰을 두 번 써서 두 계정이 refresh family 하나를 나누지 않게 하려는 것이다. 재로그인 대상이 그사이 사라져 `account_not_found`로 답할 때는 토큰을 시도에 돌려준다. 그래야 뒤의 취소나 만료가 그 family를 revoke한다.
   - 재로그인은 대체된 항목을 revoke하지 않고 `.prev`에 둔다 ⚠(12장 55). 재로그인은 계정의 발급 client를 다시 쓰므로 옛 family와 새 family가 같은 사용자 + client grant에 속한다. issuer가 refresh token 하나를 revoke할 때 그 grant 전체를 지우면(Auth0 계열 동작) 방금 저장한 새 토큰도 함께 끝나고, 재로그인할 때마다 같은 일이 되풀이되어 제거 후 추가로만 되살릴 수 있다. 실제 계정으로 재로그인 뒤 새 토큰이 계속 refresh되는 것을 확인하면 쓰기 성공 뒤 옛 family를 revoke한다. 그때까지 `.prev`는 쓰이지 않는 살아 있는 family를 디스크(vault)에 남긴다. 계정 삭제는 `.prev`도 지우지만 revoke는 지금 항목만 하므로, 그 family는 issuer에서 만료될 때까지 남는다.
4. **중복 판정은 kind 안에서만 한다.** 같은 사용자의 codex 계정과 지문이 우연히 같아도 siwc 로그인이 codex 계정을 재인증하지 않고, 그 반대도 없다(`ChatgptLogin.duplicateOf(…, kind)`). 같은 사용자가 "계정 추가"를 다시 하면 새 client가 등록되므로 새 계정이 된다(발급 client는 사용자 + workspace 하나에 묶인다).

**요청**
- 인증 헤더는 `Authorization: Bearer <access>` 하나다(`Credentials.headersFor`). family가 kind와 맞지 않는 항목은 `kind_mismatch`로 보내지 않는다. 요청에 이미 있는 Codex 전용 헤더(`chatgpt-account-id`, `originator`, `x-codex-*`)와 세션 헤더(`session-id`, `thread-id`, `x-client-request-id`. 대소문자를 가리지 않는다)는 인증 헤더처럼 먼저 지운다. core가 붙이는 `x-session-affinity`, `X-Session-Id`, `User-Agent`, `x-opencode-*`와 본문의 `prompt_cache_key`, `store:false`는 그대로다(업스트림도 같다).
- **세션 헤더**(사용자 결정 2026-10-24, SW). 인증을 넣은 뒤 업스트림 토큰 공유(`core/src/plugin/provider/chatgpt.ts` model.request hook, 5183ea45c3, upstream PR #53767)와 같은 세 헤더를 같은 값으로 넣는다(`auth/auth.ts` onModelRequest). 업스트림 주석대로 ChatGPT는 prompt cache를 고를 곳(affinity)을 `session-id`로 정한다. 2.0.32-own.2까지 own은 이 헤더 없이 보냈다.
  - `session-id` = 세션 affinity. core가 모든 요청에 싣는 `x-session-affinity`(`SessionAffinity.get`)를 그대로 쓴다: 하위 에이전트(자식 세션)는 부모 ID, fork는 원본 ID, 나머지는 자기 ID다. 본문의 `prompt_cache_key`도 같은 affinity에서 나온다(core `model-request.ts`. `ses_` + 64자 hex면 앞 4자를 뺀 값). codex의 `session-id`도 같은 값이다(4.1).
  - `thread-id`, `x-client-request-id` = 그 세션 자신의 ID. 요청마다 새로 만드는 값이 아니다(업스트림이 그렇게 보낸다).
  - 그래서 세 값은 한 세션의 모든 요청(primary, compaction, title, generate, 재시도, 계정 전환 뒤)에서 같다. 팀 모드의 영역 메인과 owner는 각자 루트 세션(`parentID` 없음)이라 자기 ID를 쓰고, 영역 안의 하위 에이전트는 그 영역 메인의 값을 쓴다. 업스트림에 팀 영역은 없지만 규칙(루트 세션마다 하나, 자식은 부모 것)이 같다.
  - 인증을 넣지 못한 요청(fail closed, 4.1)에는 세션 헤더도 넣지 않는다. 그 요청은 401로 끝난다.
  - Codex 전용 헤더(`chatgpt-account-id`, `originator`, `x-codex-*`)는 업스트림도 토큰 공유에 보내지 않으므로 계속 뺀다.
- **본문 압축**: provider `settings.encoding = "zstd"`(3.6). 업스트림처럼(5673bfa4a8) 이 route는 약 1 MiB가 넘는 비압축 본문을 거절하고 zstd를 푼다. slot에 자기 base URL이 있으면 업스트림이 설정한 baseURL에 하듯 압축하지 않는다(siwc 로그인은 그 값을 쓰지 않는다). 시험용 endpoint 재정의(`endpoints.openai`)에서도 압축한다. 가짜 서버(`e2e-kit` `fake-server.ts`)가 route처럼 zstd·gzip 본문을 풀고, 풀 수 없는 본문에는 400을 준다. 런타임에 zstd가 없으면 core가 압축 없이 보낸다(`ai/src/protocols/shared.ts` compressBody).
- `context`·`compaction`·`generate` hook에서 이 route가 거절하는 옵션을 뺀다: `maxTokens`, `temperature`, `topP`, `topLogprobs`, `metadata`, `safetyIdentifier`, `truncation`, `maxToolCalls`(`Shape.stripSharingOptions`). `-fast` 모델의 `service_tier`는 업스트림처럼 둔다 ⚠. core는 이 hook의 옵션을 빈 객체로 시작하고 생성 옵션을 넣지 않으므로, 이 제거는 다른 플러그인이 넣은 옵션을 막는 것이다. 그래서 실제 서버 e2e가 아니라 `auth/shape.test.ts`가 확인한다. 모델·variant의 `body` 덮어쓰기는 이 hook을 거치지 않아 제거되지 않는다 ⚠.
- **입력 항목**(2026-10-10 사용자 보고, 2.0.24-own.2). 이 route는 Responses 입력 항목 가운데 텍스트·이미지·파일 메시지, item reference, 추가 도구, 압축 요약, reasoning, `web_search_call`, 개발자 function·custom tool 호출, programmatic tool calling 항목만 받는다(오류 본문이 직접 적는 목록). 나머지는 `subscription_sharing_unsupported_capability`(`param:"input"`)로 거절한다.
  - 원인이 된 항목은 `configuration_update`다. 같은 모델에서 추론 강도만 바꾸면(예 `high` → `max`) core가 그 자리에 effort marker를 남기고(`core/src/session/runner/to-llm-message.ts` modelSwitched), OpenAI Responses가 GPT-6 이상에서 그것을 `{type:"configuration_update"}` 항목으로 낮춘다(`ai/src/protocols/open-responses.ts` lowerMessages, `openai-responses.ts` supportsEffortUpdates). 그래서 강도를 바꾼 대화만 그다음 요청부터 모두 실패했고, 새 대화나 다른 모델로 바꾼 대화는 성공했다.
  - 처리: siwc 요청의 `context`·`compaction`·`generate` hook에서 effort marker(effort 부분 하나만 있는 system 메시지)를 뺀다(`Shape.withoutEffortUpdates`). effort 갱신이 없는 경로와 같아져 `reasoning.effort`는 지금 variant의 값이다(`ai/src/effort-updates.ts` resolveEffortUpdates). 기록의 순수 함수라 강도를 바꾸지 않은 대화의 바이트는 그대로이고, 바꾼 대화도 요청마다 같은 prefix를 보낸다. 요청을 만들 때마다 적용하므로 이미 실패하던 대화도 다음 요청부터 낫는다. own-harness의 `codex` 하네스는 이 hook 뒤에 돌며 Codex 0.165.0의 갱신 항목을 스스로 넣으므로(10 §6.10), `own-siwc-*` 슬롯에서는 아예 만들지 않는다.
  - 모델 정보의 `compatibility.supportsEffortUpdates:false`로는 하지 않는다. core의 `Model.Compatibility` 스키마(`schema/src/model.ts`)에 그 필드가 없어 등록한 모델에서 요청까지 전달되지 않기 때문이다(core 패치 없이 불가).
  - 비용 창도 맞춘다. `Variant.supportsEffortUpdates`는 siwc에 `false`라 강도 변경의 `switch.estimate.variantOnly`는 `{preservesCache:false, reason:"route_unsupported"}`다(5.1). 강도를 바꾸면 그다음 요청은 prefix 전체를 다시 쓴다.
  - 그래도 이 코드로 거절되고 아무 hook도 다시 보내지 않으면(속도 tier 거절은 4.8이 다시 보낸다) 경보 `sharing_unsupported_input`(오류, 세션, `{providerID, modelID, param}`)을 낸다. 문구: `이 대화에는 ChatGPT 구독 공유가 지원하지 않는 항목(<param 설명>)이 있습니다. 다른 계정으로 바꾸거나 이 항목을 빼고 다시 시도하세요.` 같은 기록은 다시 보내도 같은 답이므로 재시도하지 않고, 계정도 바꾸지 않는다. core의 세션 오류 문구(영문)는 그대로다.
  - 다른 항목(도구 결과 안의 `input_image`·`input_file`, namespace가 붙은 function 호출, 다른 provider에서 온 hosted tool 기록)은 실제로 거절된 증거가 없어 바꾸지 않는다 ⚠(12장 49).
- 원격(SSH) 호스트에는 codex처럼 lease를 준다. ⚠ siwc 토큰을 SSH 원격 호스트에 빌려주는 것이 토큰 공유 약관에 맞는지 확인하지 못했다(12장 54). 동작은 바꾸지 않았다. 원격의 lease 조립은 siwc에 세션 헤더를 더하지 않는다. 위의 세 세션 헤더는 로컬과 같이 인증 hook이 넣는다. 남은 수명이 최소 유효 기간(04 §8.5, 7분)보다 짧아도 `earliest_refresh_at` 전이면 브로커는 강제 refresh를 하지 않는다. 이른 refresh를 issuer가 4xx로 거절하면 계정이 `needs_reauth`가 되기 때문이다. 대신 아직 유효한 현재 토큰을 refresh가 허용되는 시각까지, 늦어도 `expiresAt − 1분`까지 짧게 빌려준다. 만료 전 5분 여유는 refresh할 시간인데 그 refresh를 할 수 없고, issuer는 만료까지 토큰을 받기 때문이다. 원격은 lease가 끝나면 다시 청하고, 그때 브로커가 refresh한다. 남는 시간이 없으면(만료 1분 안) lease를 거절한다(`vault_unavailable`). issuer가 `earliest_refresh_at`을 만료 1분 안쪽으로 주면 그 몇십 초 동안 원격 요청이 실패한다 ⚠(12장 51).

**모델**
- kind 공유 템플릿(D4, D9)은 업스트림 대체 목록(`gpt-5.5`, `gpt-5.6-luna/sol/terra`, `gpt-6-astra`, `gpt-6-luna/sol`, `gpt-6.1-sol`과 각 `-fast`)과 카탈로그의 교집합이다. pro 모드는 빼고, `cost: []`, 모델마다 `settings.compaction = {type:"summary"}`다(`Templates.SHARING_MODELS`, 번들 `templates/siwc.json`).
- `accounts.test`는 `GET /v1/models`(Bearer, 과금 없음)로 한다. 401만 토큰 문제로 본다(`auth_failed`, 다음 사용 때 refresh). 403은 자격·정책·지역 문제라 refresh로 낫지 않으므로 `probe_failed`로 답하고 토큰을 이른 refresh 대상으로 표시하지 않는다. 오류 본문이 공유 오류 코드를 주면 그 코드가 `message`다(`Classify.sharingCode`). 화면은 키 거부 문구 대신 그 코드를 보인다. 응답은 `{models:[…]}`이고 항목마다 따로 해석해 깨진 항목만 버린다. `visibility:"list"`이고 `supported_in_api`가 `false`가 아닌 것만 쓴다. 대체 목록 중 템플릿에 없는 모델을 계정 카탈로그가 보여 주면 그 항목으로 만들어 템플릿에 더한다(`ChatgptSharing.deriveModels`). 계정별로 모델을 끄지는 않는다(공유 템플릿).
- **창은 계정 카탈로그로 줄이지 않는다(2026-10-08, R8).** upstream은 "OpenAI 버그"로 이 카탈로그 동기화를 끄고 API 카탈로그(`openai`)의 모델과 창을 그대로 쓴다(209346a0fe). own도 계정 카탈로그의 `context_window`로 템플릿을 낮추지 않고, 등록 때 다른 kind처럼 살아 있는 `openai` 스냅샷의 `limit`을 쓴다(`Templates.live`, 07 §4.4. 번들 값 1.05M/922k → core 압축 783,700). 그전 빌드가 낮춰 둔 템플릿도 다음 fold에서 살아 있는 창으로 등록된다. 계정 카탈로그에서 새로 더한 모델의 창은 스냅샷에 그 모델이 없을 때만 쓰인다. 요금제가 실제로 더 작은 창에서 거절하면 그 오류의 overflow 복구에 기댄다 ⚠(12장 52).

**refresh와 오류**
- refresh는 3.5와 같다. 본문은 `grant_type=refresh_token`, 발급 client id, `resource`이고 `scope`는 보내지 않는다. `earliest_refresh_at`을 지킨다(F1). 종료 코드(`invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused`)는 `needs_reauth`다. 새 ID token이 오면 `sub`가 같아야 한다(다르면 `account_mismatch`).
- 오류 코드표(`Classify.SHARING_CODES`, 현재 9개 + 옛 `_v2_` 이름)는 상태 코드보다 먼저 본다.
  - `usage_limit_exceeded`, `user_not_eligible`: hard. 재시도하지 않고 계정을 소진으로 둔다. 리셋 시각을 지어내지 않는다(앱별 상한이 있을 수 있다). 다만 응답이 요금제 헤더(`x-codex-*`, 7.1)를 실어 와 다 찬(100%) `codex.*` 창이 있으면 그 창이 관측한 `resetAt`을 소진 시각으로 쓴다(`Classify` `fullPlanWindow`, 2026-10-10). 그런 창이 없으면(앱별 상한) 지금처럼 `retry-after`나 본문의 리셋 값, 없으면 백오프다. 본문의 리셋 값은 Codex `usage_limit_reached` 본문과 같은 이름(`resets_at` epoch 초, `resets_in_seconds`, `error` 아래나 최상위)이다. 그 값이 있고 요금제 헤더의 다 찬 창이 없으면 다 찬 창 `siwc.usage`(`사용량 한도`, 100%, 그 `resetAt`, `source:"error"`, `Windows.sharingLimit`, SW 2026-10-22)도 만든다. 실제 토큰 공유 429 본문에서 이 값을 본 적은 아직 없다(12장 48). 이 창이 다 찬 채로 그 계정의 성공 응답이 오면 한도가 풀린 것이므로 `resetAt`을 그 시각으로 옮겨 `리셋됨(추정)`이 된다. 계정·인스턴스마다 첫 사용량 한도 응답은 로그 `usage_limit_answer{accountID, providerID, status, headers, fields, reset}`(헤더 이름과 본문 필드 이름만, 값 없음)를 남긴다. `windowId`는 `null`로 두어 `account.status`의 `reason`이 계속 이 코드다(UI 배너가 이 코드를 본다). core는 이 429를 RateLimit으로 보고 10번 재시도하므로 retry hook이 `retry:false`로 막는다.
  - `invalid_user`, `chatpass_v2_scope_not_authorized`, `chatpass_v2_invalid_authorization_context`: 재시도하지 않고 곧바로 auth다. `logins.rejected`가 그 세대를 다시 쓰지 않게 막아 새 로그인 전까지 `needs_reauth`로 둔다.
  - `unsupported_capability`, `route_not_supported`, `v2_client_not_enabled`: 재시도하지 않는다. 계정은 소진으로 두지 않는다. `unsupported_capability`는 경보 `sharing_unsupported_input`을 낸다(위 "입력 항목").
  - `usage_unavailable`, `user_unavailable`: transient. core의 제한된 재시도를 둔다.
- 비용: 요금제 과금이라 단위는 credits다. 요율 카드가 없으면 비용을 모름으로 두고 $0으로 보이지 않는다.

**삭제**: `accounts.remove.execute{mode:"delete"}`는 vault 항목을 먼저 읽어 두고, 지우기에 성공한 뒤에만 그 refresh token을 revoke한다(`token`, `token_type_hint=refresh_token`, `client_id`). 지우기가 실패하면 계정은 남아 계속 동작해야 하므로 revoke하지 않는다(`Credentials.remove{revoker}`). 네트워크 오류와 5xx만 최대 2번 다시 시도하고, 백그라운드에서 하므로 삭제를 막지 않는다. 확인되지 않으면 로그에만 남는다(`chatgpt_sharing_revoke_unconfirmed`). 그래서 UI는 제거 확인 대화상자에서 미리 "확인되지 않으면 ChatGPT 설정에서 이 앱의 연결을 직접 해제하세요"라고 알린다(03 §5.4). 등록된 client와 host id는 그대로 둔다.

**UI**(03 §5.4)
- ChatGPT 로그인 대화상자의 세 번째 선택지 `Sign in with ChatGPT`다. 레이블은 OpenAI가 허용한 형식을 한국어 화면에서도 그대로 쓴다. siwc 계정의 재로그인은 이 방식만, codex 계정의 재로그인은 코드·브라우저만 보인다.
- `token_sharing_not_granted`와 siwc의 `authorization_denied`는 `동의 후 다시 시도`를 준다. 사용자가 누를 때만 `start{consent:true, retryOf}`로 다시 연다. 새 계정의 `다시 시도`도 `retryOf`를 보낸다. `client_mismatch`, `client_id_missing`/`client_id_invalid`, `id_token_invalid`, `jwks_unavailable`, `identity_missing`, `account_mismatch`는 각자 문구가 있다.
- 이 브라우저에서 처음 새 siwc 계정을 추가하면 완료 단계에 `ChatGPT 요금제로 연결됨`을 한 번 보인다. siwc 계정 카드에는 `ChatGPT 요금제 사용 · 사용량 관리`(https://chatgpt.com/settings/usage)가 붙는다.
- 사용량 한도는 메시지 문구가 아니라 코드로 안다. 소진을 알리는 `account.status`의 `reason`이 `subscription_sharing_usage_limit_exceeded`다(9.3). 그 계정에 묶인 세션에 배너(`사용량 관리`, `다른 계정으로 전환…`)를, 카드에 한 줄을 보인다. 리셋 시각은 약속하지 않는다. 429가 스스로 리셋을 말해 `siwc.usage` 창이 있을 때만 배너가 `<N> 후 리셋 · ChatGPT가 응답에 적어 보낸 시각이에요`(`own.chatgpt.usageLimitReset`)를 덧붙이고, 카드·대시보드·`계정·한도` 탭에는 그 창이 막대로 보인다. core의 세션 오류 문구에는 HTTP 429의 코드가 들어 있지 않다(본문의 `error.message`만 쓴다).
- 한도 창(7.1): 응답이 요금제 헤더를 실어 오면 codex와 같은 `5시간`·`주간` 막대를 보인다. 그런데 실제 토큰 공유 응답은 지금까지 그 헤더를 실어 온 적이 없고(12장 48), 이 토큰으로 사용량을 물을 곳도 없다(7.1 siwc 줄). 그래서 창이 하나도 없는 siwc 계정은 `관측된 한도 없음` 대신 `아직 받은 한도 정보가 없어요 · 이 로그인 방식(토큰 공유)은 한도를 알려 주지 않는 것으로 보여요 · ChatGPT 설정 > 사용량에서 확인하세요`(`own.lim.sharingUnreported`)를 보인다(계정 카드, 한도 대시보드 카드, 작업 패널 `계정·한도` 탭의 닫힌 줄과 펼친 줄. 계정의 한도 막대를 그리는 모든 곳이 계정 kind를 넘긴다. 설정의 표시 미리보기만 예시 창이라 넘기지 않는다). 계정 카드에는 바로 아래 `사용량 관리` 링크가 있다. 문구는 아는 것만 말한다: 실제 토큰 공유 성공 응답의 헤더를 직접 본 사람은 아직 없고, 사용자 설치의 창이 비어 있다는 것만 안다(12장 48). 그전 문구 `확인 중 · 응답에 ChatGPT 요금제 한도가 오면 표시해요`(`own.lim.sharingPending`)는 언젠가 채워질 것처럼 읽혔고, 첫 SW 문구 `ChatGPT가 이 로그인 방식에는 요금제 한도를 알려 주지 않아요`는 확인되지 않은 것을 사실처럼 말해 2026-10-22에 다시 바꿨다(SW).
- 재연결 때의 재동기화(9.1)는 이 표시를 `quota.snapshot`의 `exhausted`(지금 걸려 있는 소진과 그 `reason`)로 다시 맞춘다. 소진 기록은 메모리에만 있어 서비스가 재시작하면 사라지고 `ready`도 오지 않는다. 스트림이 끊긴 동안 보낸 `ready`도 다시 오지 않는다. 목록이 아직 문제 상태로 보이는 계정의 로그인 문제 reason은 남긴다(레지스트리는 소진을 기록하지 않는다).

**테스트**: `packages/own-accounts/test/credentials/sharing.test.ts`(authorize 파라미터, 교환과 버린 응답의 revoke, ID token 행렬과 모양이 틀린 profile claim, refresher와 회전된 ID token의 `sub` 비교, revoke, 카탈로그가 창을 줄이지 않음), `siwc.test.ts`(RPC 흐름: host id와 읽기 실패, 엉뚱한 콜백, rebinding, client 불일치, 재로그인 가드, kind별 중복, scope 없음·거절 뒤 같은 client로 동의 재시도, 교환 재시도, refresh·earliest, `accounts.test`가 창을 줄이지 않음·403, rejected, 교환 뒤 버린 토큰의 revoke, 삭제 revoke와 지우기 실패), `sharing.e2e.test.ts`(실제 서버. 모든 요청이 세 세션 헤더를 같은 값으로 싣고 `Content-Encoding: zstd` 본문이며, 실제 하위 에이전트(`subagent` 도구) 요청은 부모의 `session-id`와 자기 `thread-id`·`x-client-request-id`를, fork는 원본의 `session-id`를 싣는다. `prompt_cache_key`는 `session-id`와 같은 affinity다. 응답의 요금제 헤더가 `quota.snapshot`의 `codex.primary`·`codex.secondary`가 되고, 그 헤더가 실린 사용량 한도 429는 창의 리셋 뒤로 소진 시각을 잡는다), `test/auth/inject.test.ts`(siwc 헤더 셋, 남아 있던 다른 대소문자의 세션 헤더 제거, 요청마다 같은 값, 자식의 affinity), `test/remote/sharing.test.ts`(lease, earliest까지의 짧은 lease), `test/broker/lease.test.ts`, telemetry·auth·slots 단위 테스트(`test/telemetry/parsers.test.ts`의 siwc 헤더 파싱과 소진 시각, `telemetry.test.ts`의 요금제 헤더 창). 가짜 issuer는 실제 RSA 키로 ID token에 서명하고 JWKS를 낸다(`e2e-kit/fakes/chatgpt-sharing.ts`). 실제 OpenAI endpoint는 부르지 않는다.

### 3.3 API 키 추가(`oai`, `anth`, `ds`, `xai`, `or`, `compat`)

1. RPC `accounts.add.key{kind, label, key, options}`로 받는다. 비밀을 받는 RPC는 이것과 `accounts.update{replaceKey}` 둘뿐이다.
2. **연결 테스트**(과금 없거나 매우 작은 호출)로 도메인을 식별한다.

| kind | 테스트 호출 | 도메인 식별 | 확인 전 기본값 |
|---|---|---|---|
| `oai` | `GET https://api.openai.com/v1/models` | 응답 헤더 `openai-organization` ⚠, `openai-project` ⚠. 사용자가 org/project를 입력할 수도 있다 | 키 단위 도메인(보수적) |
| `anth` | `GET https://api.anthropic.com/v1/models?limit=1` (`x-api-key`, `anthropic-version: 2023-06-01`) | organization 헤더 ⚠. workspace는 첫 `/v1/messages` 응답의 `anthropic-workspace-id`로 확정한다(헤더 이름은 [R-verify]에서 확인) | 키 단위. 첫 응답 뒤 병합을 제안 |
| `ds` | `GET https://api.deepseek.com/user/balance` ⚠ | 식별자가 없다. 사용자가 "같은 DeepSeek 계정"이라고 표시할 수 있다 | 키 단위 |
| `xai` | `GET https://api.x.ai/v1/api-key` ⚠ | `team_id` ⚠ | 키 단위 |
| `or` | `GET https://openrouter.ai/api/v1/key` ⚠ | 없음 | 키 단위 |
| `compat` | `GET {baseURL}/models` | 없음 | 키 단위 |

3. **같은 도메인이 감지되면**(03 §5.4의 "같은 캐시 도메인 감지")
   - MVP는 "별도 slot으로 추가"만 할 수 있다.
   - "기존 계정에 키로 추가(캐시 공유)"는 `cacheDomains[x].poolingVerified=true`일 때만 보인다(AC-P33/35).
4. 키는 vault에 저장하고, 레지스트리에는 `keyHint`(끝 4자)만 남긴다.
5. **모델 템플릿**: 그 kind의 현재 템플릿을 쓴다. 없으면 3.6a 규칙으로 만든다. `anth` 템플릿의 모델에 `cost`가 비어 있으면 거부하고 동봉 템플릿을 쓴다(I6).
6. **`compat` 전용**
   - `options.baseURL`(필수, 비밀 아님)은 slot `settings.baseURL`에 정적으로 둔다.
   - 모델은 `GET {baseURL}/models` 응답에서 사용자가 고른다. 응답이 없으면 모델 id를 직접 입력받는다.
   - `limit.context`와 요율(`cost`)은 사용자가 입력한다. **`limit.context`는 필수다.** 없으면 core가 자동 압축을 하지 않는다(`core/src/session/compaction.ts:870-871`, 4.7). 요율이 없으면 비용은 토큰으로만 보여 준다.
   - 템플릿은 slot마다 따로다. 공유할 카탈로그가 없기 때문이다.
   - **그림 입력과 도구(로컬 모델, 2026-10-18).** 사용자 결정은 "로컬 모델도 모든 것을 쓸 수 있게"다. 모델마다 `capabilities.input`(그림 입력)과 `capabilities.tools`(도구)를 정한다. 전에는 모든 compat 모델이 `{tools:true, input:["text"]}`로 등록되어 그림을 보는 모델도 그림을 받지 못했고, 도구가 없는 모델도 도구를 받았다.
     - 설정: 모델마다 `image`·`tools` = `auto` | `on` | `off`(`accounts.add.key`의 `options.models[]`, 나중에는 `accounts.update{compatCapabilities}`). `auto`는 저장하지 않는다(없음 = `auto`).
     - 서버가 알려 주는 값(`CompatProbe`, 계정의 base URL에만 계정의 인증 헤더를 보낸다): Ollama는 `POST {root}/api/show {model}`의 `capabilities` 배열(`vision`, `tools`. 0.6.4부터. `image`는 그림 생성이라 보지 않는다). LM Studio는 `GET {root}/api/v1/models`의 `capabilities.vision`과 `trained_for_tool_use`, 없으면 옛 `GET {root}/api/v0/models`의 `type`(`vlm` = 그림)과 `capabilities`의 `tool_use`. LM Studio는 도구를 배우지 않은 모델에도 기본 도구 프롬프트로 도구를 주므로 `trained_for_tool_use:false`는 "모름"이다. llama.cpp 서버는 `GET {root}/props?model=<id>`의 `modalities.vision`(`--mmproj`로 projector를 불렀는지)과 `chat_template_caps.supports_tool_calls`, `/props`가 없으면 `/models` 항목의 `architecture.input_modalities`. vLLM과 그 밖의 서버는 알려 주지 않는다(모름).
     - 등록 값: 사용자 설정(`on`/`off`)이 먼저, 다음이 서버 값, 둘 다 없으면 전과 같은 `input:["text"]`·`tools:true`(`Templates.compatCapabilities`). 계정 `compat.capabilities[모델]` = `{detected?:{image?, tools?}, image?, tools?}`에 둔다. slot의 템플릿 모델 `capabilities`를 그 값으로 바로 고쳐 쓴다(compat 템플릿은 diff하지 않으므로 `템플릿 갱신 있음`을 거치지 않는다). 값이 같은 모델은 바이트 그대로 둔다.
     - 읽는 때: 계정을 추가할 때, 서비스가 시작할 때 서버나 모델 기능을 한 번도 읽지 못한 계정(이 기능 전에 추가한 계정 포함, control Location), `accounts.test`(`연결 확인`, own-web `모델 기능… > 서버에서 다시 읽기`)가 통과했을 때.
     - 캐시: 바뀐 모델은 요청 바이트(도구 목록, 그림 부분)가 실제로 바뀌므로 그 slot의 대화는 다음 요청에서 캐시를 한 번 새로 쓴다. 이것은 받아들인다.
     - 그림: `input`에 `image`가 있으면 core의 openai-compatible 경로가 그림을 Chat Completions `image_url`의 data URL로 보낸다(`ai/src/protocols/openai-chat.ts` `lowerMedia`, 도구 결과의 그림은 뒤따르는 user 메시지). own-web 첨부는 모델 목록의 `capabilities.input`으로 그림을 inline으로 보낸다. 없으면 own-web은 그림을 파일 경로(`Attached file:`)로 보내고 core는 그림 부분을 오류 문구로 바꾼다. Ollama의 `/v1/chat/completions`는 GIF data URL을 받지 않는다(png·jpeg·webp만, `openai/openai.go` `decodeImageURL`). 받아 둔 그림은 그 뒤 모든 요청을 실패시키므로, 서버가 Ollama인 compat slot의 요청에서는 own-accounts가 그 밖의 그림을 core가 못 읽는 그림에 넣는 문구로 바꾼다(core의 xAI 규칙과 같은 방식, `Shape.ollamaImages`).
     - 도구 꺼짐: core는 `capabilities.tools`를 요청에 쓰지 않는다(도구를 언제나 보낸다). Ollama는 도구 기능이 없는 모델에 도구가 든 요청을 거절한다. 그래서 own-accounts가 그 모델의 `context`·`compaction`·`generate` 요청에서 도구 정의를 뺀다(`auth.onRequestShape`, 하네스 hook보다 먼저). 대화는 그대로 되고 도구 호출만 없다. own-web 입력창은 `이 모델은 도구를 쓰지 못해요. …`를 보인다. 하위 에이전트 대상에서도 빠진다(07 §3.4 `capabilities.tools`).
     - 컴퓨터 사용: 그림을 못 보는 모델에서는 쓰지 않는다(01 §10.2 "그림을 보는 모델").

### 3.3a 로컬 모델(`로컬 모델`, 사용자 결정 2026-11-03, LMT)

사용자 요청: 로컬 모델을 `기타 OpenAI 호환`과 헷갈리지 않게 따로 추가하고, 여러 API 형식을 고르고, 대화와 하위 에이전트에서 추론 강도(effort)를 쓰게 한다. 로컬 모델 계정은 **kind `compat`에 `compat.local`이 붙은 계정**이다. 새 kind를 만들지 않으므로 providerID(`own-compat-<slug>`)와 3.3의 모든 compat 규칙(그림 입력·도구 감지, Ollama 실행 창, 도구 꺼짐, Ollama 그림 규칙)이 그대로 적용되고, 바꾸기와 되돌리기가 대화를 끊지 않는다.

1. **API 형식**(`Account.LocalFormat`, 계정의 `compat.local.format`). Base URL은 모든 형식에서 `…/v1`로 끝난다.

   | 형식 | 화면 | 등록 package | 요청 |
   |---|---|---|---|
   | `chat` | `OpenAI 호환` | `@opencode/ai/providers/openai-compatible` | `POST {baseURL}/chat/completions` |
   | `responses` | `OpenAI Responses` | `@opencode/ai/providers/openai/responses` | `POST {baseURL}/responses`. `openai-compatible-responses`는 core가 apiKey 인증을 요구해(own은 요청마다 헤더를 넣는다) 쓰지 않는다 |
   | `anthropic` | `Anthropic 호환` | `@opencode/ai/providers/anthropic-compatible` | `POST {baseURL}/messages`, 키는 `Authorization: Bearer` |
   | `ollama` | `Ollama` | `@opencode/ai/providers/openai-compatible` | Ollama의 `/v1/chat/completions`. 모델 정보는 Ollama 고유 `/api/*`(3.3)에서 읽는다 |

   - 형식은 slot 템플릿 모델의 `package`와 provider 등록 package를 정한다(`LocalModel.packageOf`). 형식을 바꾸면 그 계정 대화의 다음 요청에서 캐시를 한 번 새로 쓴다.
2. **추가**(`accounts.add.key{kind:"compat", options.local:{format}}`).
   - **키는 선택**이다(`key` 생략 가능, 로컬 모델만). 키 없이 추가하면 vault에 아무것도 넣지 않고 `compat.local.keyless: true`를 둔다. 그 계정의 요청에는 자격 증명 헤더를 넣지 않고(`logins.headers`가 빈 헤더를 돌려준다), 인증 교체 검사(4.2)는 "자격 증명 없음"을 기대한다. 나중에 `키 교체`(`replaceKey`)로 키를 넣으면 `keyless`가 빠진다.
   - 연결 테스트는 3.3과 같은 `GET {baseURL}/models`다(키가 없으면 헤더 없이).
   - 서버 프리셋(화면만): Ollama `:11434`, LM Studio `:1234`, llama.cpp `:8080`, vLLM `:8000`(`http://127.0.0.1:<port>/v1`). Ollama 프리셋은 형식도 `ollama`로 바꾼다.
   - **`서버에서 불러오기`**: RPC `accounts.local.detect{baseURL, format, key?}` → `{ok, status?, family?, models:[{id, context?, output?, image?, tools?, reasoning?}], latencyMs}`. `/models`가 답하면 모든 모델 id를, 앞 40개는 3.3의 감지(서버 계열, 출력 한도, 그림·도구)와 아래 추론 감지, 창(`max_model_len`, llama.cpp `meta.n_ctx_train`, LM Studio `max_context_length`, Ollama `num_ctx` 또는 GGUF `<arch>.context_length`)까지 읽는다. 키는 그 base URL에만 보내고 저장하지 않는다. 스코프 `local`(이 PC의 창만), 원격 서비스는 `remote_managed`.
3. **추론 강도**(effort). 모델마다 `Account.Reasoning` 하나: `effort`(단계 이름 목록과 서버 기본값), `toggle`(켬·끔), `budget`(생각 예산).
   - **서버가 알려 주는 것**(`CompatDetected.reasoning`, `null` = 추론 안 함, 없음 = 모름):
     - `/models` 항목의 `reasoning_efforts`(+`default_reasoning_effort`): 그 단계들. 사용자의 로컬 서버(tensorfold, 2026-11-03 실측)가 이렇게 알려 준다.
     - 라우터의 `supported_parameters`에 `reasoning_effort`나 `reasoning`: `low`·`medium`·`high`.
     - Ollama `/api/show` `capabilities`: `thinking`이 있으면 gpt-oss는 `low`·`medium`·`high`, 그 밖은 켬·끔. 목록에 없으면 `null`.
     - LM Studio `/api/v1/models` `capabilities.reasoning.allowed_options`: `off`·`on` 밖의 이름이 있으면 그 단계(+`off`면 `none`), `on`만 있으면 켬·끔, `off`뿐이면 `null`.
     - vLLM, llama.cpp, 그 밖: 알려 주지 않는다. 사용자가 고른다.
   - **사용자 설정**(`CompatCapabilities.reasoning`, `accounts.add.key`의 `models[].reasoning`, 나중에는 `accounts.update{compatCapabilities:[{id, reasoning}]}`): `auto`(저장 안 함, 서버 값) | `off` | `{style:"effort", levels}` | `{style:"toggle"}` | `{style:"budget"}`. 설정이 서버 값보다 먼저다.
   - **등록**: 실제 추론 방식으로 모델의 `variants`를 만든다(`LocalModel.variants`, core `variant.ts`의 프로토콜별 모양을 따른다). 템플릿 모델에 바로 쓰고, 값이 같으면 바이트 그대로 둔다(LM-6과 같은 방식). `기타 OpenAI 호환` 계정도 같은 규칙이다(형식은 `chat`).

     | 방식 \ 형식 | `chat`, `responses` | `ollama` | `anthropic` |
     |---|---|---|---|
     | `effort` | 단계마다 `settings.reasoningEffort` → `reasoning_effort` / `reasoning.effort` | 같음 | 단계마다 `thinking.budget_tokens`(출력 한도−1과 32k 중 작은 값까지 고르게 나눔, 최소 1024). `none`은 `thinking: disabled` |
     | `toggle` | `none`·`thinking` = `chat_template_kwargs.enable_thinking` false·true | `none`·`thinking` = `reasoning_effort` `none`·`high` | `none` = disabled, `thinking` = 예산 min(16k, 상한) |
     | `budget` | 없음 | 없음 | `none`, `high`(절반), `max`(상한) |

   - 단계를 고르지 않은 요청은 추론 값을 보내지 않는다(서버 기본값). 대화의 강도 단추, 프리셋의 역할·모델 묶음 강도, 하위 에이전트의 `#<강도>`(07 §2.3)는 모두 이 `variants`를 쓰므로 따로 손대지 않는다. 하위 에이전트는 부모 모델과 강도를 물려받는다(core `subagent`).
   - 추론을 읽는 때: 3.3의 LM-5와 같다. 이 기능 전에 읽은 서버(`CompatServer.reasoningRead`가 없음)는 서비스 시작 때 한 번 더 읽는다.
4. **돈**. 로컬 모델은 무료다. 저장하는 `billing`은 `metered` 그대로 두고(옛 버전이 파일을 읽을 수 있게), 보이는 값과 돈 규칙은 `Account.chargeOf` = `local`을 쓴다.
   - `accounts.list`의 `billing: "local"`. 요율 카드 계산은 0 USD(`telemetry` `catalogCost`), 프리셋 인벤토리·풀 카드는 `로컬 · 무료`(`runs: "local"`, 가격 없음), 예산·종량제 동의(`session.preset.consent`)·`PresetBudget.paid`·월 예산 소진에서 빠진다. R4(회사마다 구독 하나)는 구독만 세므로 해당 없음. 하위 에이전트 강도 올리기(`free`, 07 §2.3)도 허용된다.
   - 계정 카드에는 예산 메뉴와 `자동 전환` 표시가 없다. `키 교체`는 있다(키를 넣거나 바꾼다).
   - 프리셋 대상 고르기에서는 `로컬 LLM` 아래에 계정 이름으로 나온다(발견된 Ollama·LM Studio provider와 같은 칸).
5. **기존 `기타 OpenAI 호환` 계정**.
   - 카드의 `로컬 모델로 바꾸기`(또는 `⋯` 메뉴) → 형식을 고르는 창 → `accounts.update{local:{format}}`. 키, 모델, 설정은 그대로다. 로컬 모델 카드의 같은 메뉴는 `API 형식 바꾸기…`와 `기타 OpenAI 호환으로 되돌리기`(`local: null`, `compat.notLocal: true`)다. 키 없이 추가한 로컬 모델은 키를 넣기 전에는 되돌리지 않는다(`policy_denied{field:"local"}`).
   - **자동 전환**: control Location이 시작할 때 base URL이 이 PC나 집 안 네트워크(loopback, `localhost`, `*.local`, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, `fc00::/7`, `fe80::/10`)이고 요율이 있는 모델이 없고 사용자가 되돌린 적이 없는 compat 계정을 로컬 모델로 바꾼다(형식은 서버가 Ollama면 `ollama`, 그 밖은 `chat`). 요율이 있는 계정은 돈이 드는 사내 서버일 수 있으므로 카드의 버튼만 보인다.
6. 원격(SSH 호스트, 2026-11-22 SLM로 바꿈): 로컬 모델은 **이 PC를 거쳐** 쓴다(04 §8.14). 호스트는 그 요청을 이미 있는 SSH 터널의 egress 전달로 이 PC의 중계(`/local/<accountID>`, 요청마다 MAC)에 보내고, 이 PC가 slot의 baseURL로 보내며 키가 있으면 키를 붙인다. 호스트는 lease를 받지 않고 키는 PC를 떠나지 않는다. 자동이고 스위치는 없다(호스트 계정 범위와 계정의 `remote`가 정함). 전환기에는 `PC 경유`가 붙는다. 주소가 이 PC의 loopback인 `기타 OpenAI 호환` 계정도 같다(`Broker.viaPc`).
   - 전에는 "키 없는 로컬 모델은 broker 임대 없이 빈 헤더, 원격에서 쓰려면 호스트에서 닿는 주소여야 한다"였다. 실제로는 미러가 `compat`을 싣지 않아 호스트가 키 없는 줄 몰랐고, 빈 lease를 받은 요청이 "자격 증명 없는 own slot"으로 sink에 가 턴이 0초 만에 `own_broker_unavailable`로 끝났다(04 §8.14.1). 키가 있어도 loopback 주소는 호스트 자신이라 닿지 않았다.
   - 미러는 이제 계정의 `compat`(서버 계열, 출력 한도, 능력, `local.format`, `keyless`는 빼고)을 싣는다(04 §8.14.4). 그래서 호스트의 등록(형식별 패키지, Ollama 규칙, `billing: "local"`)이 PC와 같다.
   - 대가: 이 PC가 꺼져 있거나 연결이 끊기면 그 호스트 대화는 답할 수 없다.

### 3.4 Claude 구독 슬롯

OpenCode integration UI 흐름을 그대로 쓴다. 자세한 내용은 8.2에 있다. 우리 vault는 쓰지 않는다.

### 3.5 refresh와 토큰 회전 규칙

- **F1. 갱신 시점**: `expiresAt − now < 5분`일 때, 또는 401을 받은 뒤 한 번. 5분은 core `connection.resolve`와 같은 기준이다(`core/src/integration.ts:694-695`).
  - 토큰 공유(siwc) 항목에 `earliestRefreshAt`이 있으면 그 시각이 지나야 due다(`Refresh.due`, `Refresh.deferredUntil`). 그 전에는 아직 유효한 현재 access를 계속 쓴다. 이 제한은 **유효한 토큰에만** 건다. 이미 만료된 토큰은 그 시각 전이라도 refresh한다(재시작 뒤에는 401 경로가 없어 아무것도 회복시키지 못하기 때문이다). 만료 시각 이후의 값도 무시한다(잘못 읽은 값이나 시계 차이가 계정을 묶어 두지 않게). 401 뒤 한 번은 이 제한을 무시하고, 명시적 `force`(브로커 lease 등)는 무시하지 않는다(`deferred`로 답한다). 응답의 `earliest_refresh_at`은 숫자면 epoch 초, 문자열이면 ISO 시각이다(`Refresh.earliestOf`).
- **F2. 프로세스 안 single-flight**: accountId마다 진행 중인 refresh Promise를 `own-runtime`에 하나만 둔다. 여러 Location 인스턴스가 이것을 공유한다. 끝나면 비밀 캐시(2.4.5)를 새 값으로 바꾼다.
- **F3. 프로세스 사이 lease**
  - `vault\<accountId>.lock`을 배타적으로 만든다(`open(path,"wx")`). 내용은 `{pid, startedAt, until: now+60s}`다.
  - 잡은 뒤 vault를 **다시 읽는다**. 다른 프로세스가 이미 갱신했으면(`generation` 증가) 건너뛴다.
  - `until`이 지났거나 pid가 죽었으면 stale로 보고 지운다.
  - Windows에서 다른 프로세스가 연 채로 지운 lease는 잠시 delete-pending으로 남아, 그동안 `open(path,"wx")`가 `EPERM`(또는 `EACCES`)으로 실패한다. 그 이름이 아직 보이면 경합으로 보고 같은 백오프와 마감 시간으로 기다린다. 보이지 않으면 한 번만 다시 만들고, 또 실패하면 오류를 낸다(`own-runtime/src/lock.ts` `create`).
- **F4. 쓰고 나서 쓴다(persist-before-use)**
  - 새 토큰은 받자마자 helper `put{keepPrev:true}`로 원자적으로 쓴다. 이전 값은 `.prev`에 남는다.
  - 그다음에 lock을 풀고 access token을 쓴다.
  - 받은 뒤 쓰기 전에 크래시하면 계열이 죽는다. 이 경우 `needs_reauth`로 두고 사용자에게 알린다.
- **F5. 오류 분류**
  - `invalid_grant`, `refresh_token_reused`, "already used" → `needs_reauth`. 재시도 루프를 돌지 않는다.
  - 네트워크 오류와 5xx → 30초에서 5분까지 백오프한다. 현재 access가 아직 유효하면 계속 쓴다.
- **F6. 유휴 계정을 백그라운드에서 주기적으로 갱신하지 않는다.** 요청할 때만 갱신한다. 장기 미사용 시 refresh token이 만료되는지는 ⚠이며, 선택 기능으로 주 1회 keepalive를 둘 수 있다(기본 꺼짐).
- **F7. 삭제(`accounts.remove.execute`, `mode:"delete"`)하면 vault 파일과 `.prev`를 지운다(crypto-shred).** slot은 retire한다(9.2). `mode:"disable"`은 vault를 남긴다. codex 토큰 revoke 호출은 ⚠이라 MVP에 넣지 않는다. siwc는 지우기 전에 refresh token을 revoke한다(3.2c, 실패해도 삭제는 진행).
- **F8. Claude 슬롯 토큰은 claude-auth 플러그인이 갱신한다.** 이 토큰은 Claude Code CLI와 공유된다(8.7). 우리는 건드리지 않는다. 원격 호스트의 요청도 PC egress 중계(04 §8.11)가 같은 프로세스의 플러그인 export로 서명하므로, 갱신은 PC에서 플러그인의 기존 경로로만 일어난다. own 코드는 `connection.resolve`를 부르지 않고 토큰 값을 읽지 않는다.
- **F9. linked 가져오기 계정은 F1–F7의 대상이 아니다**(3.2a). refresh, lease, `.prev`가 없다. 401과 만료는 원본 재읽기와 stale 처리로만 다룬다(`credentials.ts:168-182,262-268`).
- **F10. takeover는 execute 직후 강제 refresh로 refresher를 확정한다**(3.2a 3번). 그 뒤는 F1–F7과 같다.
  - 이 확정은 **이전 앱이 그 프로필을 다시 열지 않는다**는 전제에서만 성립한다. 이전 앱은 프로필을 열 때 스스로 refresh하므로 죽은 refresh token을 다시 보낼 수 있고, 서버가 재사용에 계열 전체 폐기로 반응하면 우리 계열도 죽는다 ⚠(3.2a "takeover 뒤 이전 앱 재사용 위험", AC-P39 (i)). 그때 우리 쪽 결과는 F5의 `needs_reauth`다.

### 3.6 계정 provider 설정(필수 요건)

플러그인이 `ctx.provider.transform`에서 `editor.add({info, models})`로 등록한다(`plugin/src/promise/provider.ts:15-28`).
- `add`는 `AISDKNative.rewrite`를 **거치지 않는다**(`core/src/provider.ts:297-303`). 그래서 package를 처음부터 native로 적어야 한다.

| 속성 | 값 | 근거 |
|---|---|---|
| `id` | `own-<kind>-<slug>` | 2.2 |
| `activation` | `"enabled"` | `Auth.none` 조건(`model-resolver.ts:374-375`). availability에서도 항상 보인다(`core/src/provider.ts:368-381`) |
| `integrationID` | **적지 않는다** | resolver는 `integrationID ?? providerID`로 connection을 찾는다(`model-resolver.ts:361-364`). `own-*` 이름의 integration이나 credential이 없으므로 결과는 undefined다(`integration.ts:678-681`). 실제 조건은 "integrationID 없음"이 아니라 "connection 없음"이다 |
| `settings.apiKey/authToken/accessToken` | 없음 | `hasConfiguredAuth`(`model-resolver.ts:417-421`) |
| `package` | codex/siwc/oai: `@opencode/ai/providers/openai`<br>anth: `@opencode/ai/providers/anthropic`<br>ds: `@opencode/ai/providers/deepseek`<br>xai: `@opencode/ai/providers/xai`<br>or: `@opencode/ai/providers/openrouter`<br>compat: `@opencode/ai/providers/openai-compatible`<br>**각 모델 항목의 `package`도 같은 값으로 적는다** | `usesAPIKeyAuth` 목록(`model-resolver.ts:423-459`)에 있어야 한다. 여섯 값 모두 목록에 있다. 원본 `@ai-sdk/openai-compatible`을 두면 host 매핑이 providerID 기준(`deepseek` 항목, `core/src/aisdk-native.ts:80-96`)이라, 우리 ID에서는 범용 `openai-compatible`로 바뀐다. 그래서 ds는 native 이름을 직접 적는다 |
| `canonical` | `openai` / `anthropic` / `deepseek` / `xai` / `openrouter`. compat는 적지 않는다 | `LanguageModel.provider = canonical ?? providerID`(`model-resolver.ts:236`). 그래서 provider 이름에 따른 lowering이 업스트림 내장 provider와 같아진다. 예: Anthropic `?beta=true`(`ai/src/protocols/anthropic-messages.ts:1665`), DeepSeek `requireReasoning`(`openai-chat.ts:555-560`). provider 아이콘도 이것으로 고른다. claude-auth는 Ref의 providerID만 보므로 영향이 없다(8.3) |
| `name` | "ChatGPT · 업무" | 표시용 |
| `settings.baseURL` | codex: `https://chatgpt.com/backend-api/codex`(`openai.ts:20`)<br>compat: 사용자 입력(필수)<br>나머지(siwc 포함): 생략(기본값 `https://api.openai.com/v1`) 또는 테스트 재정의 | hook에서 baseURL을 바꾸지 않는다. native compaction이 있으면 step이 죽는다(`core/src/session/model-request.ts:279-293`) |
| `settings.transport` | **slot 정책 값 `slots[pid].transport`를 따른다.**<br>- codex 기본: `"websocket"`(업스트림 내장 `openai`와 같음, `openai.ts:258-261`)<br>- codex에서 AC-P15가 실패하면: `"http"` = 이 속성을 **적지 않는다**(HTTP SSE)<br>- 나머지 kind: 적지 않는다 | WS는 primary 요청에만 쓰인다(`webSocket==="session" && transport==="websocket"`, `model-request.ts:326-327`). WS 경로에서는 `http.response`가 불리지 않고, 핸드셰이크 **응답** 헤더도 hook에 오지 않는다(`:327-338`). HTTP로 두면 `x-codex-*` 헤더가 매 primary 응답마다 `http.response`에 온다(7.1). 잃는 것은 WS의 증분 업로드(`previous_response_id`)뿐이고, 이는 대역폭 차이이지 과금 차이가 아니다[R-design S11] ⚠AC-P04에서 hit률 동등성을 함께 잰다 |
| `settings.encoding` | codex: `"zstd"`. Codex endpoint 재정의(시험)가 있으면 적지 않는다<br>siwc: `"zstd"`. slot에 자기 base URL이 있으면 적지 않는다(시험용 endpoint 재정의에는 적는다, 3.2c)<br>나머지: 적지 않는다 | 두 ChatGPT route는 약 1 MiB가 넘는 비압축 본문을 거절하고 zstd를 푼다(업스트림 `openai.ts` v2.0.28, `chatgpt.ts` 5673bfa4a8. 업스트림은 baseURL을 설정하면 끈다). zstd가 없는 런타임은 압축 없이 보낸다 |
| `settings.compaction` | `{type:"summary"}` | native window는 provenance에 providerID가 들어 있어 다른 slot에서 재생되지 않는다(`core/src/session/provider-context.ts:23`). 기본값도 summary지만 명시한다[R-verify minor] |
| `headers`(정적) | codex: `originator: "opencode"`, `x-codex-beta-features: remote_compaction_v2`(`openai.ts:264-268`)<br>나머지: 없음 | **계정 식별자와 비밀은 넣지 않는다**(C1) |
| `body` | 없음. codex에는 AC-P18 전까지 필드를 추가하지 않는다 | [R-design S12] |
| `models` | 고정 템플릿의 전체 `Model.Info`. `retired` slot은 모든 모델 `enabled:false` | 2.4.2, 3.6a |
| `models[].limit.input` | **자동 압축 실효 창** `ctx_eff` = core ceiling이 `T_slot`에 닿는 가장 작은 창(4.7, `Compaction.windowFor`). `T_slot`이 v2 기본(원래 창의 core ceiling)과 같으면 템플릿 값을 그대로 둔다(키를 추가하지 않음). `limit.context`와 `limit.output`은 템플릿 값 그대로다 | core 자동 압축 기준은 `limit.input \|\| limit.context`의 ceiling(`ctx − max(floor(0.15·ctx), 16k)`, v2.1부터 15%)이다(`core/src/session/compaction.ts` calculateCeiling). `limit.output`은 variant 예산에 쓰이므로 바꾸지 않는다(`core/src/variant.ts:45-47,72`) |
| codex 모델 규칙 | 필터는 `openai.ts` `codexDisallowed`와 그 모델 변환을 복제한다(upstream v2.1 cdf1c200a6부터 ChatGPT 계정은 gpt-5.5 이하를 거절한다. gpt-5.3-codex-spark도).<br>- 허용: `gpt-N.M`에서 5.5보다 큰 것<br>- 금지: `gpt-5.6`, `body.reasoning.mode==="pro"`<br>`cost: []`. upstream은 모든 codex 모델을 `limit: {context: 400000, input: 272000}`(`openai.ts:292-294`)으로 두지만 own은 따르지 않는다: 알려진 Codex 창(`Templates.codexLimit`)을 이 순서로 본다. (1) **T2**: Codex 메타데이터 스냅샷(07 §4.5)에 그 모델이 있고 `max_context_window`가 있으면 그것이 입력 창이고(`context_window`만 있는 행은 창을 주지 않는다. 모든 행이 272k인 Codex 기본 창이라 모델 능력보다 짧다, R8) 문맥은 그 위에 출력 한도를 더한 값(gpt-6.1-sol 872k → core 압축 741,200). (2) spark 128k/100k, gpt-5.5 400k/272k(필터에 걸려 등록되지 않는다). (3) 대역 목록 `CODEX_LONG_CONTEXT`(긴 문맥 6개와 `-fast`, 1M/872k. PG7 (나) 뒤에 지움). 셋 다 없으면 살아 있는 카탈로그 창이고 경보 `codex_window_unverified`를 모델마다 낸다(07 §6.2 #4) | ChatGPT 토큰으로는 codex 대상 모델만 쓸 수 있다 |
| siwc 모델 규칙 | 토큰 공유 대체 목록(`Templates.SHARING_MODELS`)과 카탈로그의 교집합, pro 모드 제외, `cost: []`, 모델마다 `settings.compaction = {type:"summary"}`(3.2c). 정적 헤더와 `transport`는 없다 | 업스트림 `chatgpt.ts`와 같다 |
| 그 밖의 kind 모델 | 3.6a의 스냅샷을 복사한다. `cost`는 **명시적으로 유지**한다 | claude-auth가 `anthropic` 모델의 cost를 `[]`로 바꾸는데, 그 값이 우리 쪽으로 새어 들지 않게 한다(8.3 I6) |

**codex slot 예시**(`editor.add`에 넘기는 info)
```json
{
  "id": "own-codex-7k2m",
  "name": "ChatGPT · 업무",
  "canonical": "openai",
  "activation": "enabled",
  "package": "@opencode/ai/providers/openai",
  "settings": { "baseURL": "https://chatgpt.com/backend-api/codex", "transport": "websocket", "compaction": { "type": "summary" } },
  "headers": { "originator": "opencode", "x-codex-beta-features": "remote_compaction_v2" }
}
```
`slots[pid].transport`가 `"http"`이면 `settings.transport` 키를 뺀다. 이 값을 바꾸면 WS 연결이 끊기고 다음 요청부터 HTTP로 간다. prefix 바이트는 같으므로 캐시에 주는 영향은 없다고 가정한다 ⚠AC-P04.

**anth slot 예시**
```json
{
  "id": "own-anth-w3p8",
  "name": "Anthropic · 회사 prod",
  "canonical": "anthropic",
  "activation": "enabled",
  "package": "@opencode/ai/providers/anthropic",
  "settings": { "compaction": { "type": "summary" } }
}
```

### 3.6a 고정 모델 템플릿 캡처

**문제**: `ProviderEditor`는 transform fold 안에서만 있다(`plugin/src/promise/provider.ts:8-28`, `core/src/plugin/host.ts:202-225`). fold 밖(RPC 핸들러)에서 쓸 수 있는 것은 다음뿐이다.
- `ctx.provider.list/get`: **사용 가능한** provider의 `Provider.Info`만. 모델이 없다(`host.ts:189-200`).
- `ctx.model.list`: 모든 transform이 끝난 뒤의 **사용 가능한** 모델만(`host.ts:227-228`).

그래서 RPC 핸들러에서 읽으면 세 가지가 틀어진다.
- `anthropic` 모델은 이미 claude-auth가 `cost=[]`로 바꾼 뒤다. I6가 막으려는 누수 그대로다.
- `anthropic`은 동의 전이거나 플러그인이 없으면 비활성이라 목록에 없다(8.4, `core/src/provider.ts:368-381`).
- `hideBuiltinProviders`로 숨긴 provider도 목록에 없다.

**규칙**
1. own-accounts의 `provider.transform` fold 안에서 스냅샷을 뜬다. 이 fold는 내장 pre 플러그인(ModelsDev, OpenAI 등) 뒤, claude-auth 앞에서 돈다(`core/src/plugin/supervisor.ts:91-95`, `core/src/plugin/internal.ts:213-248`).
   - 대상: `editor.get(c)?.models`, `c ∈ {openai, anthropic, deepseek, xai, openrouter}`. 비활성 provider의 레코드도 여기서는 보인다.
   - 저장: `own-runtime`의 `catalogSnapshot[c] = {models, takenAt}`. **메모리에만 두고 fold 안에서 I/O를 하지 않는다**(3.8).
   - fold는 provider reload마다 다시 돈다. 스냅샷은 매번 갱신된다. 고정된 템플릿에서 요청 바이트에 들어가는 필드(이름, 계열, variants, package, settings, capabilities)는 바뀌지 않고, `limit`·`cost`·`status`·출시일은 등록할 때마다 같은 모델 ID의 스냅샷 값을 쓴다(07 §4.4. codex는 `cost:[]` 그대로, 가격이 빈 스냅샷은 고정 가격 유지, compat는 스냅샷이 없음).
2. RPC 핸들러(`accounts.add.*`, `refreshCatalog`)는 이 스냅샷으로 템플릿을 만든다.
   - codex: `openai` 스냅샷에 codex 규칙(3.6 표)을 적용한다. 업스트림의 codex 필터와 `cost:[]`는 `ctx.model.transform`에 있어서(`openai.ts:271-297`) provider fold의 스냅샷에는 아직 적용되지 않았다. 그래서 우리가 직접 적용한다.
   - oai: `openai` 스냅샷 그대로.
   - anth: `anthropic` 스냅샷. **모델 하나라도 `cost`가 비어 있으면 스냅샷을 쓰지 않는다**(`template_unavailable` 뒤 3번 규칙).
   - ds·xai·or: 각 canonical 스냅샷.
   - compat: 스냅샷이 없다. 사용자 입력으로 만든다(3.3). 모델의 `capabilities`는 사용자 설정과 서버가 알려 준 값을 따른다(3.3 "그림 입력과 도구").
3. **동봉 대체 템플릿**: models.dev가 아직 로드되지 않았거나(오프라인 첫 실행) 2번 검사에 걸리면, 빌드 때 `@own/accounts` 번들에 넣어 둔 `templates/<kind>.json`을 쓴다. 서버 전용 데이터이므로 브라우저 번들에 들어가는 `@own/protocol`에는 두지 않는다. `source:"bundled"`로 표시하고, 사용자가 나중에 `refreshCatalog`로 바꿀 수 있다.
4. 종량제 kind(oai, anth, ds, xai, or)의 템플릿에서 `cost`가 빈 모델은 등록하지 않고 경보 `template_cost_missing`을 낸다. 지출이 $0으로 보이는 것을 막기 위해서다.
5. **템플릿 diff(T2, 07 §4.4, `packages/own-accounts/src/slots/template-diff.ts`)**. fold마다 각 고정 템플릿을 그 원본 provider의 스냅샷과 비교한다(순수·동기 함수, I/O 없음). 무엇이 남는지는 fold 뒤에 `Slots`가 `accounts.json`에 쓴다(3.8).
   - **새 모델 ID**: kind 규칙(2번)으로 만든 항목을 `addedAt`과 함께 템플릿에 바로 더한다. 고를 수 있게 될 뿐 바인딩·프리셋·가벼운 짝·묶음 기본 모델·세션 바이트는 그대로다(own-web의 `새` 표시).
   - **사라진 모델 ID**: 지우지 않고 `upstream:"missing"`을 붙이고 켜진 채 `status:"deprecated"`로 등록한다(그 모델의 세션은 계속 돌고 새로 고르지는 않음. 07 §4.3 수리 알림의 출발점, 07 §4.4). 다시 나타나면 표시를 뗀다. 그 provider의 스냅샷이 비었으면(오프라인 첫 실행, 그 provider를 보지 못한 fold) 아무것도 표시하지 않는다.
   - **살아 있는 필드**(`limit`, `cost`, `status`, `time.released`): 템플릿에 쓰지 않고 등록할 때마다 `Templates.live`로 읽는다(1번). `codex`·`siwc`의 `cost:[]`와 `siwc`의 고정 창은 그대로다(3.2c).
   - **고정 필드**(이름, 계열, variants, package, settings, capabilities …): 바뀌면 템플릿의 `update{detectedAt, fields}`만 적고 경보 `template_update_available`을 변경마다 한 번 낸다. 계정 카드 `템플릿 갱신 있음 [갱신]`이 `accounts.update{refreshCatalog}`이고, 그것으로 템플릿을 다시 잡으면 `update`가 지워진다(D4·D9, 사용자가 고르는 cold 지점).
   - 이름 변경은 삭제 + 추가다. `compat`는 사용자 템플릿이라 비교하지 않는다. `accounts.list`의 계정 보기는 `templateUpdate`와 표시가 붙은 모델(`models[{id, addedAt?, upstream?}]`)을 준다(9.2).
6. **Codex 메타데이터 층(T2, 07 §4.5, `packages/own-accounts/src/slots/codex-meta.ts`)**. `codex` kind만 쓴다(`siwc`와 다른 kind는 읽지 않음). control Location이 준비된 `codex` slot의 토큰으로 Codex 백엔드의 모델 목록을 받아(etag, 시작할 때와 `refreshCatalog`·첫 ChatGPT 로그인 때) `OWN_HOME\codex-meta.json`(2.3)에 둔다. 실패하면 마지막 값, 한 번도 받지 못했으면 이 PC Codex CLI의 `models_cache.json`(읽기만)이다. fold는 파일을 읽지 않고 fold 밖에서 읽어 둔 메모리 스냅샷(`CodexMeta.current()`)을 본다(3.8). 스냅샷이 바뀌면 그 Location의 provider를 다시 접는다. 쓰는 곳: Codex 창(3.6 표), 추론 강도 단계 순서와 울트라 강도(07 §2.3, §2.9), 묶음 기본 모델 ②와 가격 순위의 앞자리(07 §2.2, §3.4), 은퇴 날짜 표시와 후속 모델 제안(07 §4.3), `effort_update_drift`(07 §3.5). 끝점 가정은 `CodexMeta.BACKEND` 한 곳이다(⚠PG7 (나)). CA(2026-10-19): 묻는 `client_version`은 빌드 상수와, 설정 `Codex 최신 모델 자동 확인`이 켜져 있으면 npm 레지스트리에서 하루 한 번 읽은 Codex 최신 릴리스 중 높은 쪽이다(`CodexMeta.LATEST`, 07 §4.5 CA). 버전이 바뀌면 모든 목록을 etag 없이 다시 받는다. own의 codex 하네스가 다루지 못하는 값이 있는 행은 빼고 세어 `codexModels.get`(9.2)이 보인다.

### 3.7 대체 모드 `credentialBackend: "opencode-credential"`

업스트림이 `Auth.none` 교체(`model-resolver.ts:374-380`, 최근 30일 17커밋)를 없애거나 바꾸면 vault 방식이 한꺼번에 깨진다. 그때 켜는 모드다.

- slot마다 전용 integration `own-<kind>-<slug>`를 만든다.
  - API 키는 key 메서드로 저장한다.
  - ChatGPT는 우리 OAuth 구현을 그 integration의 oauth 메서드(authorize/refresh)로 등록한다.
- 그러면 resolver가 native auth를 적용한다(`model-resolver.ts:303-314`).
- 대가
  - 키와 토큰이 평문 DB에 저장된다.
  - refresh 직렬화가 없다. 여러 Location이 동시에 refresh하면 계열이 죽을 수 있다. 막으려면 코어에 credential별 refresh 세마포어가 필요하다(원장 P-012, candidate: 대체 모드 사용 시, 10장).
- 이 모드는 기본값이 아니다. 사용자가 명시적으로 켜야 하고, UI는 평문 저장임을 따로 표시한다(03 `own.accounts.keyStorageFallback`). 기본 모드는 vault다(03 `own.accounts.keyStorage`).

### 3.8 등록 시점과 재조정(reconcile)

- `setup`에서 레지스트리를 **먼저 읽고** `own-runtime`에 올린 뒤 transform과 hook을 등록한다. fold 안에서는 파일을 읽지 않는다.
- **hook은 setup에서 한 번만 등록한다**(4.1 "등록 방식", 01 §8.3). 요청을 바꾸는 hook과 own slot의 읽기 전용 관측 hook(`http.response`, `experimental.ws.receive`, `retry`) 모두 own-accounts가 setup에서 unscoped로 한 번 등록하고, hook 안에서 `own-runtime`의 slot 레지스트리로 거른다. 계정이 바뀌어도 다시 등록하지 않는다.
  - own-telemetry의 hook은 `{providerID:"anthropic"}` scope로 setup에서 한 번 등록하고, 재조정과 상관없다.
- 레지스트리가 바뀌면(RPC 변경, 다른 프로세스의 파일 변경) 다음 순서로 처리한다.
  1. `own-runtime`이 모든 Location 인스턴스에 알린다. 다른 프로세스의 변경은 `fs.watch`로 받는다.
  2. 각 인스턴스가 `ctx.provider.reload()`를 부른다. hook은 건드리지 않는다.
- **같은 경로로 전파하는 것**: Claude 슬롯 동의(ack) 기록 변경, 플러그인 감지 상태 변경(8.4), `hideBuiltinProviders` 변경, 자동 압축 기준 변경(`policy.compaction`, `accounts[].compaction`, 4.7.4), 가져온 계정의 credential 변경(3.2a), T2의 Codex 메타데이터 스냅샷 변경(`store.changed{codex-meta}`, 3.6a 6번)과 템플릿 diff가 fold 뒤에 쓴 템플릿 변경(3.6a 5번). 이것들도 provider fold 결과를 바꾸기 때문이다. 한 Location에서만 reload하면 다른 프로젝트에서는 재시작 전까지 옛 상태가 남는다. 프로젝트 플러그인 승인 변경(`trust.json`, 9.2 `plugin.trust.*`)도 같은 알림으로 모든 Location이 allowlist를 다시 검사하게 한다(4.2).
- 런타임 중에 provider reload가 모든 Location에 반영되는지는 ⚠AC-P30. hook을 다시 등록하지 않으므로 AC-P30은 provider reload만 확인한다. 실패하면 계정 추가·제거 뒤 서비스 재시작을 안내한다.
- 같은 id의 플러그인을 두 번 올리면 거부된다(`core/src/plugin/supervisor.ts:98-111`). own-accounts(`own.accounts`)는 **own 전용 전역 설정** `%OPENCODE_CONFIG_DIR%\opencode.jsonc`에 한 번만 올린다.
  - `OPENCODE_CONFIG_DIR = %USERPROFILE%\.config\own-open-code`이고, 플러그인은 `%USERPROFILE%\.config\own-open-code\opencode.jsonc`에만 설정한다(01 §5.1). 소스에서 띄우는 개발 채널(`local`)만 `%USERPROFILE%\.config\own-open-code-dev\opencode.jsonc`를 쓴다(01 §5.4). launcher가 `OPENCODE_CONFIG_DIR`을 설정한다(`util/src/global.ts:79`, `cli/src/server-process.ts:36`).
  - upstream 설치본의 `~/.config/opencode/opencode.json[c]`에는 절대 쓰지 않는다. 쓰면 사용자의 upstream OpenCode가 우리 플러그인과 claude-auth를 동의 없이 불러온다.
  - 대상 경로는 8.2의 표를 따른다.

### 3.9 음성 입력 전용 키와 받아쓰기(VOICE, 2026-10-09)

Codex·Claude 앱처럼 입력창(과 노트)에 말로 글을 넣는 기능이다. 화면은 03 §4.6·§5.7.3, 마이크 권한은 05 §7.8, 조사 근거는 `own/reports/voice-input-2026-10-09.md`(`claude/external-repo-research-5fbe07` 브랜치)다.

- **1단계는 파일 인식이다.** own-web이 녹음을 끝낸 뒤 한 번에 보내고, 서비스가 인식한 글자를 돌려준다. 말하는 동안 글자가 나오는 실시간 인식(`gpt-live-transcribe`, Realtime API)은 하지 않는다. 서비스 표 `Voice.SERVICES`(`@own/protocol` `voice.ts`)의 줄마다 `mode`가 있어서 실시간 서비스는 `mode` 다른 줄로 더한다.

  | 서비스 | 모델 | 언어 | 힌트 |
  |---|---|---|---|
  | OpenAI(기본) | `gpt-transcribe` | `languages[]`로 보낸다(이 모델은 `language`를 받지 않음, upstream `openai-transcription.ts`) | `prompt` |
  | Deepgram | `nova-3` | `language`. `자동`이면 `detect_language=true` | 영어일 때만 `keyterm`(최대 20개). 한국어에는 보내지 않는다 |

- **엔진은 upstream `@opencode/ai` Transcription이다**(`transcription.ts`, 프로토콜 `openai-transcription`·`deepgram-transcription`). 새 SDK는 없다. own-accounts `src/voice/voice.ts`가 export 경로로 직접 import한다(`own/ledger/vendored.yaml` deep-import, surface `voice-openai-transcription`·`voice-deepgram-transcription`·`voice-auth-headers`). 인증은 `Auth.headers`에 음성 키의 `Authorization` 헤더 하나만 넣는다. env 변수나 config의 자격 증명은 읽지 않는다.
- **키는 음성 입력 전용이다(사용자 결정 2026-10-09).** OpenAI도 Deepgram도 설정 > 음성 입력에서 따로 넣은 키만 쓴다.
  - 모델 계정(`oai` API 키 계정 포함)의 키, ChatGPT 구독(`codex`·`siwc`) 토큰으로는 **절대** 받아쓰기를 하지 않는다. 음성 키가 없으면 요청을 보내지 않고 `voice_unavailable{reason:"key_missing"}`이다(계정 키로 대신하지 않음).
  - 반대로 음성 키는 모델 요청에 쓰이지 않고 계정으로 보이지 않는다. vault 항목 id가 `voice-openai`·`voice-deepgram`이고 계정 id는 `acc_…`라서 겹치지 않는다. `Credentials.headersFor`(모델 요청의 주입)는 계정만 받고, 음성 키는 `Credentials.storeFeatureKey`·`featureHeaders`·`inspectFeatureKey`·`removeFeatureKey`로만 다룬다(`own-runtime/src/credentials.ts`). `accounts.list`, slot, 원격 브로커의 lease(계정 레지스트리 기준)에도 나오지 않는다.
  - 키 입력: 설정 > 음성 입력의 서비스별 비밀번호 칸 → `voice.key.set{provider, key}`(`local`: 이 PC의 창에서만). 키는 요청 본문에만 실리고 폼 상태에서 바로 지운다. 서비스는 키를 vault에만 쓰고(바꾸면 이전 키는 `.prev`), 응답과 `voice.get`에는 `configured`와 끝 네 자리 `keyHint`(`sk-…9fQ2`)만 돌려준다. 로그에는 서비스와 설정 여부만 남긴다. `key:null`은 키와 `.prev`를 지운다(shred). 앞뒤 공백은 자르고, 공백·제어 문자가 섞이면 `voice_key_invalid`다. 확인용 호출(probe)은 하지 않는다. 키가 틀리면 첫 받아쓰기가 `voice_failed{reason:"auth"}`로 알린다.
- **받아쓰기 흐름**: own-web 녹음(MediaRecorder, 오디오만) → `voice.transcribe{audio(base64), mediaType, durationMs?, language?, hint?}`(control location) → own-accounts가 설정(`voice.json`)과 음성 키로 `Transcription.generate` 한 번 → `{text, provider, model, seconds, language?}`. 자동으로 보내지 않는다. 글자는 own-web이 커서 위치에 넣는다(03 §4.6).
  - 꺼져 있으면 `voice_unavailable{reason:"disabled"}`로 아무것도 보내지 않는다.
  - `language`가 없으면 설정을 쓴다(`auto`, `ko` 기본, `en`). `hint`는 own-web이 만든 프로젝트 파일 이름과 자주 나온 식별자(03 §4.6, 600자까지)다. 서비스로 가는 것은 오디오와 이 힌트뿐이다.
- **한도**(`Voice.*`, 호스트 스키마와 핸들러가 같이 본다): 녹음 180초(`MAX_SECONDS`, own-web이 그때 멈춤), 4 MiB(`MAX_AUDIO_BYTES`, base64 약 5.6 MB), 힌트 600자, 키 512자, 인식 90초(`TIMEOUT_MS`, 넘으면 `voice_failed{reason:"timeout"}`). 빈 녹음·base64가 아닌 값·초과는 서비스로 보내기 전에 `voice_audio_invalid{reason, max?}`다. 게이트웨이는 이 메서드 하나만 64 KiB 본문 검사 한도 대신 `VOICE_BODY_LIMIT`(녹음 한도 + 64 KiB)까지 읽는다(05 §13.4).
- **저장하지 않는 것**: 오디오와 인식한 글자는 파일·로그·감사·ledger·세션 기록 어디에도 남기지 않는다. 로그 줄(`voice_transcribed`, `voice_transcribe_failed`)에는 서비스, 바이트 수, 초, 걸린 ms, 실패 분류만 있다. 모델이 보는 것은 사용자가 고쳐서 보낸 글자뿐이라 prompt cache와도 상관없다.
- **사용량**: 성공할 때마다 `voice.json` `usage`에 그 달(UTC)·서비스의 초와 횟수를 더한다(`Voice.addUsage`, 서비스마다 24달). 초는 서비스가 돌려준 길이, 없으면 녹음기가 잰 길이다. 설정 화면이 분으로 보인다. 계정 사용량(7.5)과는 따로다(계정이 아니므로).
- **실패 분류**(`voice_failed{provider, reason, status?, retryable}`, 서비스의 본문·메시지는 넣지 않음): `auth`(401·403), `rate_limited`(429), `quota`, `rejected`(잘못된 요청·지원하지 않는 형식), `network`, `timeout`, `provider`(5xx 등). own-web은 녹음을 들고 있다가 `다시 시도`로 같은 녹음을 다시 보낸다.
- **범위와 위치**: `voice.get` `read`, `voice.set` `admin`, `voice.key.set` `local`, `voice.transcribe` `prompt`(유료 API 시간을 쓰므로, 05 §13.5). 모두 control location이다(9.1). 원격 서비스(04 §16.5)는 넷 모두 `remote_managed`이고, 게이트웨이는 `/srv/<hostId>`의 `voice.*`를 막는다. 키와 사용량은 이 PC의 것이다.
- **호스트 결정(VOICE)**: RPC id를 새로 두지 않고 `own.accounts`의 메서드로 넣었다. vault 접근(`own-runtime` credentials)과 비밀 처리 규칙, 게이트웨이 범위표(`OwnAccounts.MethodScope`), control location 경로, 원격 모드의 `remote_managed`, own-web의 RPC 클라이언트를 그대로 쓰기 때문이다. 여섯째 RPC id(`own.voice`)는 같은 플러그인이 등록하게 되어 분리의 이득은 없고 게이트웨이 분기와 클라이언트만 늘린다.
- **시험**: `packages/own-accounts/test/voice/voice.test.ts`(가짜 받아쓰기 서비스 `test/e2e-kit/fakes/transcription.ts`: 키·언어·힌트, 한도, 실패 분류, 계정 키로 대신하지 않음, 음성 키가 계정 목록·모델 요청에 없음, 로그·파일에 오디오·글자·키 없음), `own-protocol/test/voice.test.ts`, 게이트웨이 `own-remote/test/gateway/{policy,gateway}.test.ts`. 실계정 확인은 사용자가 `own/scripts/voice-live-check.ts`로 한다(로컬 서비스의 RPC만 부르므로 스크립트는 키를 보지 않음, 한국어 견본 WAV는 Windows 내장 음성 합성으로 만듦).

---

## 4. 토큰 주입과 요청 형성

### 4.1 hook 표와 소유

책임 분담은 01 §3.1·§8.3과 같다. own-accounts는 요청을 만들고(인증, context), own slot 응답을 읽기 전용으로 관측하며(한도, ledger, 캐시 상태, hard 소진 판정, 경보), 전환을 결정한다(상태 머신, RPC). own-telemetry는 `anthropic`(Claude 구독 슬롯)의 최종 응답만 관측하고 그 슬롯의 긴 멈춤 방지 retry 결정을 한다. 둘은 `own-runtime`으로만 상태를 주고받는다(2.3). 설정의 플러그인 순서는 `[own.accounts, own.remote, own.team, heymaaz.claude-auth-v2(선택 슬롯), own.telemetry, own.computer-use]`다(8.2). 아래 표의 accounts·telemetry는 두 플러그인을 줄인 이름이다.

| hook | 플러그인 | 등록 방식 | 하는 일 | 근거 |
|---|---|---|---|---|
| `provider.transform` | accounts | setup 1회 | slot 등록(3.6), 카탈로그 스냅샷(3.6a), `anthropic` activation 규칙(8.4), `hideBuiltinProviders` 적용 | `core/src/plugin/host.ts:202-225` |
| session `model.request` | accounts | setup 1회, **unscoped**. 첫 줄에서 `own-runtime` slot 레지스트리에 없는 providerID면 아무것도 바꾸지 않고 반환. 이 Location이 `blocked_by_plugin`(4.2 allowlist)이면 인증 헤더를 넣지 않는다 | 인증 헤더 주입(아래 표).<br>codex는 추가로 `chatgpt-account-id`, `session-id` = core의 `x-session-affinity`(자식은 부모 것, upstream 1fc05ca590), `originator`.<br>baseURL은 건드리지 않는다.<br>session 요청 네 kind(primary, compaction, title, generate)에서 실행된다. **stateless generate에서는 실행되지 않는다**(아래) | 호출 위치 `model-request.ts:261-278`. `Auth.none`이면 hook 헤더가 그대로 나간다(`model-resolver.ts:374-380`, `ai/src/route/transport/http.ts:50-59`). WS 핸드셰이크도 같은 parts를 쓴다(`ai/src/route/transport/websocket.ts:462-475`) |
| session `context`, `compaction`, `generate` | accounts | 같음(unscoped + 레지스트리 필터) | D9 identity 정규화(모든 own slot), cache hint(anth slot과 Claude 모델을 쓰는 or slot), strip 규칙. `context`에서는 사용자 출력 상한(4.9)이 이 행보다 먼저 모든 provider에 적용된다(own slot이 아니어도). 출력 한도는 `context`·`compaction`에서만 정한다(upstream `omitOutputLimit`이 거는 두 hook과 같은 범위): codex·oai·or slot은 `maxTokens`를 지우고(codex는 ChatGPT 백엔드가 거절하고, oai는 OpenAI가 요청한 출력 한도만큼 분당 토큰 한도를 미리 세고, or는 OpenRouter가 요청한 출력 한도의 값만큼 잔액을 미리 잡아 잔액이 모자라면 짧은 답이면 될 요청도 402로 거절함. or는 2026-10-08, d9987ef9c8 전처럼 한도를 보내지 않음), ds slot의 `none` 변형은 `maxTokens`가 비어 있을 때만(출력 상한 `보내지 않기`, 4.9) 65,536을 core의 `outputCeiling`에 맞춰 넣는다(결정 D2. DeepSeek의 생각 끔 기본값 8K에서 답이 잘리지 않게. upstream `d9987ef9c8` merge 뒤에는 core가 넣은 값이 이긴다). `generate` 호출자가 정한 한도는 그대로 둔다. 프롬프트 바이트는 바뀌지 않는다. **출력 한도 말고는 세 hook에 같은 변환을 적용한다**. 맨 끝에서, 증거 수집 창이 도는 동안에만 prefix 지문(7.8.1)을 잡는다(읽기만) | 수동 hint는 보존된다(`ai/src/cache-policy.ts:11-13,47`). 내장 Identity hook이 먼저 돈다(`core/src/plugin/internal.ts:233`, `identity.ts:20-33`) |
| session `prompt` | accounts | setup 1회, 전역 | 보류 전환 처리(5.3 방법 2). **AC-P26(= 01 G8b) 통과 전에는 이 hook 안에서 `switchModel`을 부르지 않는다.** 그동안 보류 전환은 5.3 방법 1·3으로만 적용하고, 이 hook은 busy 세션에 온 메시지의 `delivery`를 `"queue"`로 바꾸는 일만 한다. 미고정 세션 고정(01 §8.5)도 같은 게이트를 따른다. 통과 뒤에는 **세션이 idle일 때만** 이 hook에서 보류 전환을 적용하고, busy면 WAIT_SAFE를 그대로 두고 `delivery`를 `"queue"`로 바꾼다 | `core/src/session/prompt.ts:40-51,88`(hook이 바꾼 `delivery`를 core가 쓴다), `plugin/src/promise/session.ts:14-20` |
| `ctx.event.subscribe` | accounts | setup 1회 | `execution.started/succeeded/failed/interrupted`로 세션 busy/idle 추적, `model.selected`, `compaction.started/ended/failed`, `plugin.updated`로 상태 머신·슬롯 감지(8.4)·allowlist 재검사(4.2). `session.created`로 미고정 세션 고정(01 §8.5)과 자식 목록(`parentID`, 5.11). `step.started/ended/failed`와 `compaction.ended/failed`의 `tokens`·`cost`로 ledger(7.5)와 캐시 상태(2.4.6). `session.revert.staged/cleared/committed`로 압축 실행 차단과 캐시 상태 재계산(4.7.4 "revert"). `session.moved`로 세션 상태 인계(5.4). `session.instructions.updated`로 카탈로그 delta 감지(4.3 D10). Location마다 중복 수신되므로 이벤트 id로 거른다.<br>**`session.usage.recorded`는 받을 수 없다.** 공개 manifest(`SessionEvent.Definitions`)에 없고 `DurableDefinitions`에만 있으며, `ctx.event.subscribe`는 `EventManifest.isServer \|\| isRpcEvent`만 넘긴다 | `core/src/plugin/host.ts:255-265`, `schema/src/event-manifest.ts:71-84`, `schema/src/session-event.ts:51-66,94-101,243-257,264-276,332-390,585-651,655-711` |
| session `http.response` | accounts | setup 1회, **unscoped**, **읽기만**. 첫 줄에서 slot 레지스트리에 없는 providerID(`anthropic` 포함)면 반환 | 한도 헤더, 오류 헤더, 오류 본문 앞부분 캡처 → `LimitWindow`, 마지막 응답 캡처(7.2). 인증 swap 확인(4.2). strip 오류 패턴 감지(4.4). **`kind:"generate"` 또는 `kind:"title"`의 성공 응답이면 `response.clone()`의 SSE를 백그라운드에서 끝까지 읽어 usage를 얻는다**(7.5). hook은 이 읽기를 기다리지 않고 원래 `response`를 그대로 둔다. 이벤트에 `sessionID`, `kind`, `model`(Ref)이 이미 있으므로 다른 곳에서 짝을 찾지 않는다 | `model-request.ts:211,295-321`(`scope = {sessionID, agent, model, kind}`를 `http.response`에 그대로 넘김, `:312-315`). 4xx·429도 보인다(`ai/src/route/executor.ts:235-248`). generate와 title은 WS를 쓰지 않으므로 항상 이 경로다(WS는 primary와 native 압축만, `core/src/session/runner/llm.ts:242`, `compaction.ts:316`) |
| `experimental.ws.receive` | accounts | setup 1회, unscoped, **읽기만**. `own-codex-*`만, 부분 문자열로 먼저 거름 | `codex.rate_limits` 프레임과 rate-limit 계열 `error`/`response.failed` 프레임 캡처(01 §14.3). frame은 그대로 돌려준다 | `model-request.ts:326-350`(WS 경로는 `has` 검사 없이 항상 trigger) |
| session `retry` | accounts | setup 1회, unscoped. slot 레지스트리의 own slot만 처리 | hard/transient 분류(5.2). hard면 `{retry:false}`로 바꾸고 소진 기록을 `own-runtime`에 올린다. `inTurnFailover=true`(Phase 3)이면 같은 hook에서 5.9(h) failover를 결정한다 | `core/src/session/runner/retry.ts:94-120` |
| tool `execute.before` | accounts | setup 1회(`ctx.tool.hook`), 모든 provider. 첫 줄에서 `event.tool !== "subagent"`면 반환 | 하위 에이전트 관문(5.11 규칙 2를 대신하는 07 §5.4, T0): 허용 집합 밖의 대상은 `input.agent`를 `own-preset:` 문장으로 바꿔 거절하고, 허용한 대상은 `input.model`에 명시적으로 쓴다. 입력만 바꾸고 throw하지 않으며 세션 상태(권한, 지시 항목, 모델)를 쓰지 않는다 | 같은 방식을 subagent 도구가 직접 쓴다(`core/src/tool/plugin/subagent.ts:271-280`). hook 모양은 `plugin/src/promise/tool.ts:38-46`(`input`이 바꿀 수 있는 필드). 내장 pre 플러그인의 hook이 먼저 돈다(8.2 순서). surface `subagent-*`, `tool-hook-order`, `tool-hook-shapes`, `builtin-plugin-placement` |
| tool `execute.after` | accounts | setup 1회(`ctx.tool.hook`). 첫 줄에서 `event.tool !== "opencode_models"`면 반환 | `models` 도구 결과를 루트 세션의 메인 provider로 거른다(07 §5.4, T0. T1에서 허용 집합의 provider로 넓힘). 다른 계정은 LLM에게 보이지 않는다. 도구 결과라 요청 앞부분과 무관하다 | 실제 이름은 namespace가 붙은 `opencode_models`(`core/src/tool/runtime.ts:276-279`). surface `opencode-models-tool`, `tool-effective-name` |
| `agent.transform` | accounts | setup 1회 + 이 Location의 `plugin.updated`마다 다시 등록하는 늦은 등록 하나 | 숨긴 내장 에이전트(title, summary, compaction)의 설정 `model`이 own 구독 slot이면 지우고 경보 `internal_agent_model_removed`(07 §5.4 "내장 에이전트의 모델"). `subagent` 모드 에이전트는 관문이 호출마다 본다. fold 안에서 I/O 없음 | 설정의 `agents.*`는 모든 설정 플러그인 뒤에 도는 내장 post 플러그인 `ConfigAgentPlugin`이 넣으므로(`core/src/plugin/internal.ts:250-267`) setup 등록만으로는 보지 못한다. 그래서 `plugin.updated` 뒤에 다시 등록해 맨 뒤에 둔다(`packages/own-accounts/src/presets/agents.ts`. 아래 "등록 방식"의 유일한 예외이고, 요청 hook이 아니라 transform이라 플러그인 순서 문제가 없다). surface `builtin-plugin-placement`, `plugin-updated-after-activation`, `agent-title-model-fallback` |
| session `http.response` | telemetry | setup 1회, **`{providerID:"anthropic"}` scoped**, **읽기만** | unified 헤더 캡처 → `claude.*` `LimitWindow`, 마지막 응답 캡처, 추가 사용량 청구 감지(`claude_extra_usage`, 7.7). `kind:"generate"`나 `kind:"title"`이면 own-accounts와 같은 방법으로 usage를 읽어 `own-runtime`에 넘긴다(7.5) | claude-auth **뒤**라 최종 응답을 본다(01 §4) |
| session `retry` | telemetry | setup 1회, `{providerID:"anthropic"}` scoped | unified `rejected` 또는 retry-after 15분 초과 429면 `{retry:false}`와 소진 기록(8.8). **전환은 결정하지 않는다**(own-accounts 몫) | `retry.ts:94-120` |
| `experimental.ws.handshake` | 쓰지 않음 | – | 인증은 `model.request`로 충분하다. AC-P01에서만 읽기 전용으로 헤더를 검증한다 | |

**등록 방식을 이렇게 정한 이유**(01 §8.3)
- `{providerID}` scope는 `trigger`에서 콜백을 거르는 필터일 뿐이다(`core/src/plugin/hooks.ts:88-95`). core 동작을 바꾸는 것은 `has()`를 부르는 곳, 즉 HTTP wrapper를 켤지 정하는 `http.request`/`http.response`뿐이다(`hooks.ts:97-102`, `model-request.ts:295-297`).
- own-accounts는 모든 hook(요청을 바꾸는 `model.request`, `context`, `compaction`, `generate`, `prompt`와 읽기 전용 `http.response`, `ws.receive`, `retry`)을 setup에서 한 번 unscoped로 등록하고 안에서 slot 레지스트리로 거른다. 계정마다 런타임에 scoped hook을 등록하면 두 문제가 생긴다.
  - setup에서 등록한 콜백은 설정 순서대로 놓이지만, 런타임에 등록하면 목록 끝에 붙는다(`core/src/plugin.ts:127` "Registrations are ordered by setup"). 그러면 claude-auth·own-telemetry보다 뒤에 놓여 plugins 순서가 깨진다.
  - hook 등록은 Promise다(`plugin/src/promise/registration.ts:15-19`). 등록이 끝나기 전에 provider reload가 먼저 반영되면 인증 없는 요청이 나간다.
  - 계정을 추가해도 hook을 다시 등록하지 않으므로 AC-P30 의존이 provider reload 하나로 줄어든다.
  - 대가: unscoped `http.response` 때문에 모든 provider의 HTTP 호출이 wrapper 경로를 탄다(요청 body 재버퍼링, `model-request.ts:295-323`). 내장 provider는 숨겨져 있고, 슬롯이 설치되면 claude-auth의 unscoped http hook이 이미 같은 비용을 만든다(8.3 I7). `ws.receive`는 프레임마다 불리므로 부분 문자열로 먼저 거른 뒤에만 JSON을 파싱한다.
- own-telemetry는 `anthropic` 하나만 보므로 setup에서 `{providerID:"anthropic"}` scoped로 등록한다. own slot 요청에서는 불리지 않는다.
- **필터 규칙**: own-* 레지스트리에 없는 providerID(`anthropic` 포함)의 요청은 **절대 바꾸지 않는다**(4.6, 8.3 I5). 01 §9.3(4)의 "provider-scoped이든 접두어로 거르든 `own-*`에만 작용" 규칙과 같다.

**`model.request`가 넣는 헤더**

| kind | 헤더 |
|---|---|
| codex | `Authorization: Bearer <access>`, `chatgpt-account-id: <identity.chatgptAccountId>`, `session-id: <session affinity>`(자식 세션은 부모 ID, upstream 1fc05ca590), `originator: opencode` |
| siwc | `Authorization: Bearer <access>`, `session-id: <session affinity>`, `thread-id: <session ID>`, `x-client-request-id: <session ID>`(업스트림 `chatgpt.ts` 5183ea45c3, 3.2c "세션 헤더"). 다른 Codex 헤더는 없다 |
| oai, ds, xai, or, compat | `Authorization: Bearer <key>` |
| oai (선택) | `OpenAI-Organization`, `OpenAI-Project`: 사용자가 입력한 경우만. 계정마다 고정 값 |
| anth | `x-api-key: <key>`. `anthropic-version`은 route가 넣는다(`anthropic-messages.ts:1670`). `Authorization`은 넣지 않는다 |

- 헤더 값은 비밀 메모리 캐시(2.4.5)에서 읽는다. 주입한 인증 헤더의 SHA-256 앞 8자를 `own-runtime.injected[sessionID][providerID]`에 남긴다. 4.2의 인증 swap 확인이 이 값을 쓴다.
- **`http.request`로 인증하지 않는 이유**
  - WS 경로에는 적용되지 않는다. codex primary는 WS로 간다.
  - `Auth.none`이면 native 헤더 방식(`Authorization`, `x-api-key`)을 더미 자격 증명 없이 그대로 쓸 수 있다. `http.request`로 덮어쓰려면 route auth가 먼저 성공해야 해서 더미 값이 필요하고 더 취약하다(01 §8.3 대체 경로).
  - `Auth.none`이 막히는 경우의 대안은 3.7이다.
  - 참고: HTTP wrapper(요청 body 재버퍼링과 응답 재포장)는 그 providerID에 `http.request`나 `http.response` 중 **하나라도** 있으면 켜진다(`model-request.ts:295-321`). own-accounts의 unscoped `http.response` 때문에 모든 provider가 이 경로를 탄다(위 "대가"). claude-auth가 설치되어도 같다(8.3 I7).
- **stateless generate 한계**
  - `ctx.generate.text`와 `POST /api/experimental/generate`는 모델(지정하지 않으면 **기본 모델**)을 resolve한 뒤 session hook 없이 `llm.generate`를 부른다(`core/src/generate.ts:38-67`, `core/src/plugin/host.ts:271-272`, `protocol/src/groups/generate.ts:8`).
  - own slot은 `Auth.none`이므로(`model-resolver.ts:374-380`) 이 경로의 요청은 인증 없이 나가 401로 끝난다. 사용자 기본 모델이 own slot이면 `ctx.generate.text`를 쓰는 서드파티 플러그인도 실패한다.
  - 대응
    - own-web은 `/api/experimental/generate`를 own 모델로 부르지 않는다. 필요하면 세션 generate(`POST /api/session/:id/generate`)를 쓴다.
    - `diagnostics.selfTest`는 기본 모델이 own slot이면 경고 `default_model_own_slot`을 낸다(4.2).
    - 근본 해결은 요청별 connection override다. 원장 P-007이고 rejected다(G2 실패 때만 재검토). 동작은 AC-P36으로 기록한다.
- **실패 처리**
  - session hook에는 실패 채널이 없고, 던지면 defect가 된다(`core/src/plugin/hooks.ts:21-30`, `plugin/src/promise/adapter.ts:577-579`). 그래서 **절대 throw하지 않는다.**
  - 토큰이 없으면(`needs_reauth`) 헤더를 넣지 않고 로그 `auth_missing`만 남긴다. 요청은 401로 끝나고, core가 Authentication으로 분류한다(`ai/src/provider-error.ts:168-169`). 그 뒤 own-accounts의 retry hook이 T-AUTH를 기록하고, 상태 머신이 재로그인이나 전환을 제안한다.

### 4.2 시작 자가 진단(slot마다, setup과 reload 뒤)

각 slot에서 아래를 확인한다. 하나라도 틀리면 계정 상태를 `misconfigured`로 두고, 전환 대상에서 빼고, 경보를 낸다.
- `activation === "enabled"`
- `ctx.integration.get(providerID)`의 connection이 0개
- provider·model settings에 인증 키가 없음
- package가 허용 목록에 있음

추가 점검
- provider overlay 전체에서 비밀처럼 보이는 문자열(`sk-`, `eyJ`, `sk-ant-` 등)을 찾는다. 있으면 경보를 낸다.
- **인증 swap 런타임 확인**: own-accounts의 읽기 전용 `http.response`가 받은 `event.request`의 인증 헤더 hash가 `model.request`가 넣은 hash(4.1)와 같은지 본다.
  - 다르거나, 인증 헤더가 두 개이거나, 우리가 넣지 않은 인증 헤더가 있으면 slot을 `misconfigured`로 두고 경보 `auth_swap_broken`을 낸다.
  - 업스트림이 `Auth.none` 조건(`model-resolver.ts:374-380`)을 바꾸면 여기서 바로 드러난다. 판정에는 HTTP 요청이 있어야 한다. WS를 쓰는 codex slot은 compaction·title 요청에서 판정한다.
- **기본 모델 점검**: `ctx.model.default()`가 own slot이면 경고 `default_model_own_slot`(4.1 stateless generate 한계).
- **프로젝트 플러그인 allowlist**(Location마다, 01 §13.2)
  - `ctx.plugin.list()`의 항목을 검사한다. 허용: builtin, `app\current\plugins\` 아래의 own 플러그인, `thirdparty\claude-auth`, `trust.json`에 `{location, source, sha256}`로 승인된 항목.
  - 그 밖의 플러그인이 있으면 그 Location 상태를 `blocked_by_plugin`으로 두고 경보 `untrusted_plugin`을 낸다. 그 Location의 `model.request`는 인증 헤더를 넣지 않는다(요청은 401로 실패한다). 계정 상태는 바꾸지 않는다.
  - `plugin.updated` 이벤트마다, 그리고 `trust.json`이 바뀔 때(3.8 전파) 다시 검사한다. 승인한 파일의 SHA-256이 바뀌면 다시 막는다.
  - 풀기: 사용자가 UI에서 `plugin.trust.approve.plan` → `execute`로 승인한다(9.2).
- **업스트림 표면 점검**: 10.1 목록 중 런타임에 확인할 수 있는 항목(identity 줄 형식, `anthropic` 레코드 존재 등)을 확인한다.
- RPC `diagnostics.selfTest`로 수동 실행할 수 있다.

### 4.3 결정성 규칙

- **D1.** hook이 만드는 body, system, messages, tools는 (저장된 history, 대상 Ref, 레지스트리 정적 데이터)의 순수 함수다.
  - 시각, 난수, attempt 번호, 계정 라벨, 한도 값을 쓰지 않는다.
  - runner는 attempt마다 context를 다시 만든다(`core/src/session/runner/llm.ts:213-243`). 그래서 attempt마다 결과가 달라지면 prefix가 흔들린다.
- **D2.** `context`, `compaction`, `generate`에 같은 변환을 적용한다.
  - 요약 요청은 같은 system과 tools에 older 메시지를 붙인 것이다. 그래서 primary prefix를 그대로 공유한다(`core/src/session/compaction.ts:236-242,553-567`).
- **D3.** slot 안에서 헤더 값은 토큰이 갱신될 때만 바뀐다.
  - 바뀌면 WS가 다시 연결된다. affinity가 `url + sha256(정렬한 헤더)`이기 때문이다(`core/src/session/model-transport.ts:116-117`).
  - 과금에는 영향이 없다[R-design S11].
- **D4.** providerID, `model.name`, family, variants를 바꾸지 않는다(템플릿 고정).
- **D5.** 전환 알림을 transcript에 넣지 않는다. `synthetic`와 instruction entry 모두 금지다.
  - 넣으면 모든 계정 history에 영구 토큰으로 남는다[R-design S8]. 알림은 UI에만 표시한다.
- **D6. 압축 설정.** core의 `auto`·`buffer`·`keep`은 Location 단위 설정 하나다(`core/src/session/compaction.ts:38-44,187-195`, 설정 반영은 `core/src/config/plugin/compaction.ts:15-24`). 플러그인 API로는 바꿀 수 없다(plugin Context에 config·compaction 도메인이 없음, `plugin/src/promise/plugin.ts:27-53`).
  - own 전역 설정에 `buffer`와 `auto:false`를 두지 않는다. `keep`은 기본 15k를 두고, 바꾸는 것은 사용자 선택이다(전역 keep, 4.7.6·12장 Q29).
  - 압축 **시점**은 slot 모델의 `limit.input`으로 slot마다 정한다(4.7). `limit`은 요청 바이트에 들어가지 않으므로(identity는 name·provider id·model id만, `core/src/plugin/identity.ts:9-16`) 기준을 바꿔도 prefix는 그대로다.
- **D7.** 계정만 바꾸는 전환에서는 variant를 유지한다.
  - 메시지 단위 effort 갱신을 지원하지 않는 경로에서는 variant 변경이 곧 prefix 전체 재작성이다(5.1).
  - effort marker가 요청 effort와 맞지 않으면 모든 marker가 제거되어 prefix 중간이 다시 쓰인다(`ai/src/effort-updates.ts:20-25`).
- **D8.** 인라인 이미지가 25 MiB를 넘으면 core가 오래된 이미지를 잘라 낸다(`model-request.ts:135-186`). 동작은 결정적이지만 prefix가 바뀌는 지점이므로 추정기에 반영한다.
- **D9. identity 정규화.** 내장 Identity 플러그인은 `context`·`compaction`·`generate` hook에서 system에 `# Your Model` 블록을 끼워 넣는다. 이 블록에 `- Provider ID: <providerID>`가 들어간다(`core/src/plugin/identity.ts:9-16,27-32`). 그대로 두면 같은 캐시 도메인의 두 slot도 system[1]부터 갈라진다.
  - 우리 hook은 Identity 뒤에 돈다. 내장 pre 플러그인이 설정 플러그인보다 먼저 등록되기 때문이다(`core/src/plugin/internal.ts:213-248`, `supervisor.ts:91-95`).
  - own slot 요청에서, 텍스트가 `# Your Model\n`으로 시작하는 system part를 찾아 `- Provider ID:` 줄을 slot 중립 값으로 바꾼다.
    - 값은 `canonical`(codex·oai → `openai`, anth → `anthropic` 등)이다. compat는 `openai-compatible`이다.
    - `- Name:` 줄은 고정 템플릿의 `model.name`이고, 같은 kind의 slot은 템플릿을 공유하므로(2.4.2) 이미 같다. `- Model ID:` 줄도 같다.
  - 위치가 아니라 내용으로 찾는다. 다른 플러그인이 system 순서를 바꿔도 결정적이다(D1). 블록이 없거나 형식이 다르면 아무것도 바꾸지 않고 경보 `identity_format_changed`를 낸다(10.1 표면 목록).
  - 효과: 같은 도메인 slot 사이에서 tools, system, 첫 사용자 메시지까지 바이트가 같아진다. 그래서 6.3 ①의 `Z_t + u_1`이 참이 되고, AC-P05·P33·P35는 우리 prefix 차이가 아니라 **서버의 캐시 공유 여부**를 재게 된다.
  - 이 정규화는 slot을 처음 등록할 때부터 켠다. 나중에 켜면 모든 own 세션이 한 번 cold가 된다.
  - 모델이 보는 provider 이름이 `own-codex-7k2m` 대신 `openai`가 된다. 모델 동작에는 영향이 없다고 가정한다(G17 품질 A/B에서 함께 본다).
- **D10. 도구 집합은 세션마다 생성 때 정해진다.** 그 뒤에는 어느 클라이언트(데스크톱 셸, 웹 폴백, 모바일)가 붙어 있는지, 브라우저 호스트가 연결됐는지로 바뀌지 않는다.
  - **규칙의 소유**: 규칙은 05 §8.7 안 D(세션 생성 때 호스트 capability로 세션 권한을 새김) 하나이고, 화면과 문구는 03 §18.15가 정한다. 02는 그 규칙의 캐시 비용 판단(아래)과 런타임 감지만 정한다.
  - **캐시 비용: 도구 두 종류를 구별한다**(소스 확인)
    - **직접 도구**(`codemode:false`): `edit`, `patch`, `write`, `shell`, `read`, `glob`, `grep`, `question`, `skill`, `subagent`, `webfetch`, `websearch`(예: `core/src/tool/plugin/edit.ts:123`, `shell.ts:192`)와 `codemode:false`로 설정한 MCP 서버의 도구. 정의가 요청의 `tools`에 직접 들어간다(`core/src/tool.ts:234,257-261`). 하나를 넣거나 빼면 그 세션의 prefix가 처음부터 다시 쓰인다.
    - **Code Mode 도구**(`codemode`가 `false`가 아닌 것): 브라우저 도구(`plugin-browser/src/tools.ts:50`), `opencode.*` 도구(`core/src/tool/plugin/opencode.ts:95,115,140`), 기본 설정의 MCP 도구(`core/src/tool/mcp.ts:45`, `core/src/mcp/index.ts:293-297`. 스스로 Code Mode인 일부 서버는 `codemode:false`가 기본, `core/src/plugin/mcp-codemode-defaults.ts:7-31`). 요청에는 `execute` 도구 하나만 들어가고 그 설명은 바뀌지 않는다(`core/src/codemode/tool.ts:61-68`). 카탈로그는 세션별 Instructions로 간다(`core/src/session/context.ts:131,149`).
      - 기준선(baseline)은 compaction epoch마다 고정되어 모든 요청의 앞에 렌더링된다(`core/src/session/instruction-state.ts:164-175`).
      - 그 뒤 카탈로그가 바뀌면 durable `session.instructions.updated` 텍스트로 대화 **뒤에 덧붙는다**. 짧으면 delta, 길면 대체 문구다(`instruction-state.ts:41-60`, `core/src/codemode/instructions.ts:32-124`, `session/history.ts:140-161`). 다음 압축 때 기준선으로 다시 접힌다.
      - 그래서 기존 세션에서 Code Mode 도구를 켜고 끄면 **그 세션에 delta 한 번**이 붙고 앞 prefix는 그대로다. 이전 판의 "그 뒤 모든 세션의 모든 slot이 한 번 cold"는 틀렸다.
      - 새 세션은 바뀐 기준선으로 시작한다. 같은 캐시 도메인 slot 사이의 `Z + u_1` 재사용(6.3 ①)은 한 세션 안의 일이라 영향이 없다.
      - **세션 사이에 같은 prefix는 짧다(2026-10-05 정정).** 이전 판은 "세션 사이에 같아지는 `Z`(tools + system + 기준선)"라고 적었다. 지금 base에서는 틀렸다.
        - 요청의 system은 `[system[0] 에이전트 프롬프트, system[1] identity(D9), system[2] 기준선]`이다(`core/src/session/model-request.ts:84-91`, `core/src/plugin/identity.ts:27`).
        - 기준선은 내장 항목부터 렌더링된다(`core/src/session/context.ts:147-155`). 첫 내장 항목 `core/environment`는 `<env>` 둘째 줄에 `Current conversation session ID: <id>`를 넣는다(`core/src/instructions/builtins.ts:31`).
        - 그래서 세션 사이에 바이트가 같은 것은 tools + system[0] + (같은 템플릿이면 identity) + 기준선의 첫 두 줄(안내 문장과 `<env>`)까지다.
        - 그 뒤의 Code Mode 카탈로그, AGENTS.md, skill 목록, `own.preset`·`own.team.role` 같은 지시 항목은 바이트가 같아도 세션마다 처음부터 cold다. 팀 담당, 프리셋 하위 에이전트, 새 세션 인계의 첫 요청이 여기에 해당한다.
        - 6.3의 식은 세션 사이 공유를 가정하지 않는다. ⑩ 새 세션 인계는 `Z_t` 전체를 `r_cold`로 센다.
        - upstream `bda798b167`(`fix(core): drop session ID and order instructions for prompt-cache reuse`)이 세션 ID 줄을 지운다. 기준선 순서도 공유가 큰 것부터로 바꾼다: Code Mode 카탈로그, MCP, references, skill, discovery(AGENTS.md), 날짜, 환경, 지시 항목. 그 뒤에는 같은 날·같은 폴더·같은 설정의 세션끼리 지시 항목 앞까지 같아진다.
        - 그 commit을 처음 들이는 merge에서는 기존 세션의 기준선 순서가 바뀐다. 그래서 **활성 세션마다 cold 요청이 1회** 생긴다. 환경 값에서 세션 ID 줄이 빠지므로 지시 갱신 delta도 1회 붙는다. 이 비용은 그 merge의 `SYNC_LOG.md`와 릴리스 노트에 적는다(`own/FORK.md` §4 동기화 절차, §11 체크리스트).
        - own은 세션 ID 줄을 기준선 끝으로 옮기는 플러그인(`moveSessionLines`)을 만들지 않는다. upstream이 같은 일을 하고, 만들면 그 merge 때 순서가 한 번 더 바뀌어 cold가 한 번 더 생기기 때문이다.
  - **브라우저 도구 사실**: `opencode.browser`는 내장 pre 플러그인으로 항상 등록되고(`core/src/plugin/internal.ts:89,216`), 도구 정의는 호스트 연결과 상관없이 setup에서 한 번 등록된다(`plugin-browser/src/tools.ts:33-58`). 호스트가 붙지 않은 세션에서 부르면 모델은 `[browser.disconnected] No desktop browser is connected to this session…` 도구 오류를 받는다(`plugin-browser/src/connection.ts:136-141`). `Browser is unavailable.`(`connection.ts:58,81,97`)은 모델이 받는 문구가 아니라 호스트 쪽 RPC 처리기의 오류다.
  - **규칙(05 §8.7 안 D를 따른다)**
    - 브라우저 패인 capability(`browserPane`, 05 §6.2)가 없는 호스트가 세션을 만들면 세션 권한에 `{action:"browser", resource:"*", effect:"deny"}`를 새긴다. 도구가 스냅샷과 카탈로그에서 빠진다(`core/src/tool.ts:229-232,292-295`). 데스크톱에서 만든 세션에는 새기지 않는다.
    - 이미 있는 세션의 권한은 클라이언트가 바뀌어도 자동으로 바꾸지 않는다. 데스크톱 세션을 웹이나 휴대폰에서 이어 가도 카탈로그는 그대로이고, 호출은 `[browser.disconnected]`로 빨리 끝난다.
    - 나중에 켜는 것은 세션마다의 명시적 동작이다(`PATCH /api/session/:id{permissions}`로 그 규칙만 뺌, 03 §18.15). 비용은 delta 한 번이다(위). "캐시를 처음부터 다시 씀" 경고를 띄우지 않는다.
    - 자식 세션은 생성 때 부모 권한을 복사하므로 따로 처리하지 않는다(`core/src/session.ts:273-276`).
    - 웹 전용 설치(own-desktop이 없는 PC)에서 own 전역 config에 `-opencode.browser`를 첫 실행부터 두는 01 §10.1의 설치 프로필은 이 규칙과 결과가 같다(그 PC에는 호스트가 생길 수 없음). 게다가 TUI·`own run`처럼 규칙을 새기지 않는 클라이언트가 만든 세션에서도 도구를 뺀다. 이 문법은 내장 플러그인에도 먹힌다(`core/src/plugin/supervisor.ts:39-44`. guarded 목록 `internal.ts:271`에 `opencode.browser`가 없음). 나중에 own-desktop을 설치하며 이 항목을 지우면 기존 세션마다 delta가 한 번 붙는다. 이 보강을 둘지는 01이 정한다. 데스크톱이 설치된 PC에서는 두지 않는다(05 §8.7이 안 B를 기각한 이유: 서비스가 하나라 데스크톱 세션에서도 사라짐).
  - **세션 승인 모드**(03 §18.8, [R-gap] #8): 대상이 직접 도구(`edit`, `shell`)이므로 `resource:"*"` deny로 만들면 모드를 바꿀 때마다 그 세션의 prefix가 처음부터 다시 쓰인다. 03이 고른 규칙 모양은 도구를 목록에 남긴다. `읽기 전용`은 `resource:"**"` deny다. 규칙 판정은 와일드카드라 모든 자원에 맞지만, 목록에서 빼는 판정 `whollyDisabled`는 `resource === "*"`만 본다(`tool.ts:292-295`). 규칙 묶음은 own-accounts가 `session.approval.set`(9.2)으로 만든다. 그래서 승인 모드 변경은 캐시에 영향이 없다.
  - **MCP 연결·해제**: 기본 설정의 MCP 도구는 Code Mode라 delta 한 번이다. `codemode:false`로 설정한 서버는 직접 도구라 prefix 전체가 다시 쓰인다(AC-P19).
  - **팀 모드(06, T1)와 프리셋(07)**: 팀 도구 8개는 Code Mode 도구(namespace `team`, `team_<name>`)이고 모든 에이전트가 세 권한 action(`team.main`, `team.owner`, `team.member`)에 `resource:"*"` deny를 갖는다(06 §2.8). 팀 메인·담당은 만들 때 그 역할의 allow를 받으므로 카탈로그 기준선에 처음부터 들어 있다(팀 메인은 언제나 새로 만든다, 06 §3.7).
    - **받아들이기·빼기·되돌리기의 delta 1 예외(T2, 06 §2.8·§3.7).** 이미 있는 대화를 담당으로 받아들이는 것은 명시적인 세션별 권한 변경이고 그 세션에만 닿는다. (1) 켤 때·`팀에 넣기` 때는 등록만 하고 그 대화에 아무것도 쓰지 않는다: delta 0. (2) 그 영역의 첫 메인 요청 때 팀 도구 allow(`team.owner`, `team.member`), 지시 항목 `own.team.role`, 팀 문맥 바인딩을 붙인다: 다음 step 경계에 지시 갱신(`session.instructions.updated`)이 1회 붙는다. `team`은 설명 있는 namespace라 그 갱신은 카탈로그 교체 문구다(05 §8.7). 앞 prefix는 그대로이고 크기와 관계없이 그 대화를 이어 쓴다. (3) 빼기(`area.unadopt`)와 켜기·`팀에 넣기` 되돌리기는 붙인 것만 떼므로 붙인 세션에 1회, 붙기 전이면 0이다. (4) R4 예외(06 §10.1)로 팀 계정의 새 대화가 이어 가면 옛 대화에는 아무것도 쓰지 않는다(0). 쓰기는 정확한 팀 규칙만 읽고-고치고-쓰고, 바로 뒤 own-accounts `session.approval.set{sessionID, mode:<지금 모드>}`(`custom`이면 건너뜀, `computerUse`는 넘기지 않음)를 다시 불러 승인 묶음과 보호 경로 deny를 맨 뒤에 둔다. 팀이 아닌 세션, 팀 메인, 만든 담당의 delta는 0이고 own-accounts `toolset_changed`는 0이다(06 TG16).
    - 프리셋의 역할 에이전트(`own-review`·`own-quick`·`own-deep`)는 `hidden`이라 subagent 도구의 설명 바이트를 바꾸지 않는다(07 §5.2, PG4). 프리셋 안내문은 도구가 아니라 지시 항목 `own.preset`이다(07 §3.3).
  - **런타임 감지**
    - own-accounts `context` hook이 own slot 요청의 도구 정의 hash(이름·설명·입력 스키마)와 system hash를 세션·slot별로 메모리에 기억한다. 바뀌면 `toolset_changed`(info) 경보를 내고, 추정기는 그 slot의 `W`를 0으로 본다. 재시작 뒤 첫 요청은 기준선만 잡는다.
    - **`toolset_changed`는 Code Mode 카탈로그 변경을 보지 못한다.** 그 변경은 도구 정의나 system이 아니라 메시지(Instructions delta)에 들어가기 때문이다. 그 경우는 공개 이벤트 `session.instructions.updated`(`schema/src/session-event.ts:264-276`)를 구독해 안다. 추정기는 delta 텍스트 길이/4를 다음 요청의 새 cold 부분(`δ`)에 더하고 `W`는 그대로 둔다. 경보는 내지 않는다.
    - **메시지까지 보는 비교는 켜야 동작한다**(prefix 지문, 7.8.1). 증거 수집 창이 도는 동안에는 도구·system에 더해 메시지도 블록마다 직전 요청과 비교해, 처음 달라진 곳과 그 원인을 `events.jsonl`의 `prefix` 줄로 남긴다. 설명되지 않는 재작성만 `prefix_diverged`(info)다.

### 4.4 strip 규칙

- **기본은 추가 strip이 필요 없다.** 다른 providerID가 만든 메타데이터는 core가 이미 뺀다.
  - `to-llm-message.ts:153-206`
  - Responses reasoning 제거: `ai/src/protocols/open-responses.ts:491-505,673-674`
  - Anthropic thinking을 text로 강등: `anthropic-messages.ts:935-949`
  - Claude 5.1 이상은 `drop_block`이 기본이다(`anthropic-messages.ts:1017-1027`).
- **안전망은 풀링 모드나, 같은 slot에서 재로그인 이상이 생겼을 때만 켠다.**
  1. own-accounts의 읽기 전용 `http.response`·`ws.receive`와 `retry` hook이 아래 오류 패턴을 감지해 strip 제안을 만든다.
     - `invalid_encrypted_content`, `could not be verified`, `could not be decrypted`, `organization_id`, `not issued to this caller`, `Invalid signature in thinking block` ⚠
  2. own-accounts가 KV `sess:<sid>:strip`에 규칙을 저장한다. 형식은 `{providerID, dropBefore: messageID, kinds: ["reasoning.encrypted","thinking.signature","item.id"], until:"next-compaction"}`다.
  3. own-accounts의 `context`, `compaction`, `generate` hook이 **매 요청** 이 규칙을 적용한다. 규칙은 epoch가 끝날 때(다음 `compaction.ended`)까지 유지되므로 prefix는 한 번만 바뀐다.
- retry hook은 요청을 바꿀 수 없다(`plugin/src/promise/session.ts:127-136`). 그래서 규칙을 저장해 두고, 다음 attempt에서 context hook이 적용하는 구조다.
- 대상이 A일 때 **A 시기 블록은 절대 고치지 않는다.**

### 4.5 Anthropic cache hint

- **기본값**: core auto policy가 last tool, 첫·마지막 system, tail 1개에 5분 TTL로 hint를 둔다(`cache-policy.ts:17-21`). 우리는 평소에 hint를 추가하지 않는다.
- **예산 배분 규칙(소스 확인)**: 수동 hint가 먼저 예산을 쓰고, auto는 `4 − 수동 개수`만큼을 **tools → system → messages 순서로** 채운다(`cache-policy.ts:150-161`). auto hint는 TTL이 없어서(`makeHint(undefined)`, `:47-48`) 5분이다. lowering은 hint마다 따로 `cache_control`을 만들고 순서를 고치지 않으며, tools를 system보다 먼저 내보낸다(`anthropic-messages.ts:502-510,1044-1060`).
- **watermark(복귀 지원, 5분)**
  - 조건: 세션이 A로 돌아왔는데, A의 마지막 요청 이후 추가된 블록이 `blocksSince ≥ 15`(20 block lookback[R-verify]에 여유를 둔 값)
  - 동작: 수동 hint 2개를 둔다. 둘 다 TTL 없음(5분)이다.
    - A가 마지막으로 보낸 입력 메시지의 위치(watermark). 위치는 `markMessageAt`과 같은 규칙으로 고른다: 마지막 text part, 없으면 마지막 part(`cache-policy.ts:90-112`).
    - tail
  - 남은 2 slot은 auto가 tools와 system[0]에 쓴다. 모두 5분이라 TTL 순서 문제가 없다. 넘치는 hint는 lowering에서 버려진다(`anthropic-messages.ts:1044-1066`).
  - watermark 위치는 own-accounts가 step 이벤트로 기록한 캐시 상태(`sess:<sid>:cache:<providerID>.watermark`, 2.4.6)에서 읽는다. 결정적이다(D1).
- **1h 모드(떠나기 전에만 의미가 있다) — Phase 3**
  - 단계: 01 §17은 이 모드를 Phase 3에 둔다. 1h write 비용을 core가 정확히 계산하려면 P-006이 필요하고(7.2), 아래 400 위험도 AC-P16으로 먼저 확인해야 한다. MVP에서는 RPC가 `unsupported_strategy`를 돌려주고, 03 §5.6 토글은 "예정"으로 보인다(12장 Q13).
  - 복귀용 캐시 항목은 A의 **마지막 요청**이 tail에 쓴 것이다. 그러니 1h TTL은 그 요청에 이미 붙어 있어야 한다. 돌아오는 요청에 붙이면 늦다[R-verify #3].
  - **켜는 경로**: 03 §5.6 세션 정보의 `곧 계정을 바꿀 예정 — 캐시 1시간 유지` 토글 하나뿐이다. 토글은 RPC `cache.setTtlMode{sessionID, providerID, mode}`를 부르고, own-accounts가 KV `sess:<sid>:ttlMode:<providerID>`에 저장한다. 전환 대화상자(6.5)에는 이 선택지가 없다. 일시적 429는 전환 사유가 아니므로(5.2) 자동으로 켜지 않는다.
  - **400 위험**: Anthropic은 한 요청 안에서 1h breakpoint가 5m breakpoint보다 앞에 있어야 한다[R-verify]. 수동 1h hint가 3개뿐이면 auto가 남은 1개를 **tools**(system보다 앞)에 5분으로 둔다. 그러면 5m가 1h보다 앞에 오고 요청이 400으로 거부된다.
  - **규칙: 1h 모드에서는 수동 1h hint를 항상 정확히 4개 둔다.** 그래서 auto 예산이 0이 된다.
    - 1순위: system[0], system[last](system part가 2개 이상일 때), tail
    - 4번째 자리(1순위에서 부족한 만큼): watermark(있으면) → 현재 compaction epoch의 첫 메시지(압축 요약 또는 첫 사용자 메시지) → system의 다른 part(인덱스 1부터 차례로)
    - 메시지 위치는 모두 `markMessageAt` 규칙(마지막 text part, 없으면 마지막 part)으로 고른다. 모든 위치는 저장된 history만으로 정해진다(D1).
    - **4개를 채울 수 없으면**(system part 2개 이하이고 메시지가 1개뿐인 아주 짧은 세션) 그 요청에는 1h hint를 하나도 두지 않고 기본 5분 동작을 쓴다. 이런 세션은 1h로 얻는 것이 없다.
    - hook에서는 tools에 hint를 달 수 없지만, system[0] hint가 tools부터 system[0]까지를 덮는다.
  - 더 나은 방법은 hook이 `request.cache = {tools:true, system:true, messages:{tail:1}, ttlSeconds:3600}`을 정하게 하는 것이다. 그러면 auto가 모든 자리를 1h로 채운다. 지금은 hook이 `cache`를 정할 수 없다(`model-request.ts:238-259`에서 `LLM.request`에 `cache`를 넘기지 않음). 원장 P-011(candidate, Phase 3, 예외 승인 필요, 10장)이다.
  - `ttlSeconds ≥ 3600`은 `ttl:"1h"`로 바뀐다(`ai/src/protocols/utils/cache.ts:12-13`, `anthropic-messages.ts:500-510`). beta 헤더 없이 받아들여지는지는 ⚠AC-P16.
  - 비용: 1h write는 5m 대비 입력 요율 0.75배만큼 더 비싸다(2.0x vs 1.25x). 이미 5m로 캐시된 prefix가 1h hint에서 다시 쓰이는지(=prefix 전체 추가 비용), 새 tail만 쓰이는지는 ⚠. 추정기는 이 두 값을 범위로 표시한다.
  - 권장 대안은 5.9(e)의 곁가지 포크다.
- **OpenRouter의 Claude 모델**: upstream 74dbc509d7부터 core auto policy가 OpenRouter의 `anthropic/` 모델에 tools·system 처음과 끝·tail breakpoint를 둔다(`cache-policy.ts` gatewayPolicy). 그전에는 OpenRouter를 건너뛰어 own이 system[0]과 tail에 수동 hint를 두었으나, 이제 own은 hint를 두지 않는다 ⚠AC-P31.

### 4.6 하지 않는 것

- 캐시 도메인이 다른 계정끼리 providerID를 공유하지 않는다.
- `credential.activate`와 `opencode auth switch`로 전역 계정을 바꾸지 않는다.
- `anthropic` provider에 baseURL, 헤더, credential을 넣지 않는다.
- **own이 아닌 provider의 요청은 절대 바꾸지 않는다.** unscoped로 등록한 hook(4.1)은 첫 줄에서 slot 레지스트리로 거른다. 예외는 하나, 사용자가 켠 Claude 구독 슬롯의 Fast다(4.8, 8.3 I5a). `prompt` hook은 전환과 `delivery`만 다루고 prompt 내용을 바꾸지 않는다.
- own 모델로 stateless generate(`ctx.generate.text`, `POST /api/experimental/generate`)를 부르지 않는다. 인증 hook이 불리지 않아 401이 난다(4.1).
- hook에서 baseURL을 바꾸지 않는다.
- AC-P18 전에는 codex body에 필드를 추가하지 않는다.
- 계정마다 `promptCacheKey`를 다르게 만들지 않는다.
  - hook으로는 바꿀 수 없다. 값은 세션에서 나온다(`model-request.ts:237,252`).
  - 격리는 서버가 하므로 계정별 key로 얻는 것이 없다[R-design S10].
- 떠나온 계정을 keep-warm ping으로 데우지 않는다[R-design].
  - `warming`은 현재 모델만 ping한다(`core/src/plugin/warming.ts:49-50`).
  - ping 한 번마다 prefix를 read하는 비용이 든다. core `warming` 설정을 켜면 그 ping도 ledger에 `purpose:"warming"`으로 남는다(7.5).
  - 자리를 비운 동안 Anthropic 요청을 `max_tokens: 0`으로 다시 보내 캐시를 붙잡는 유지 요청도 하지 않는다(CC 2026-10-24, 승인되지 않음). 대신 켜는 선택지인 자리 비움 압축이 있다(4.7.7).
- `anthropic` 모델의 `limit`을 바꾸지 않는다(4.7.2). own 전역 설정에 `compaction.auto:false`나 `compaction.buffer`를 두지 않는다(4.7.6).
- 클라이언트 종류나 브라우저 호스트 연결로 **이미 있는 세션의** 도구 집합을 바꾸지 않는다. 브라우저 도구는 세션을 만들 때만 새기고, 나중 변경은 세션마다의 명시적 동작이다(D10, 05 §8.7).

### 4.7 자동 압축 기준(사용자 결정 D6)

#### 4.7.1 v2가 자동 압축을 정하는 방식(소스 확인)

- **설정**: `SessionCompaction.Settings = {auto, buffer?, keep}`이고 초기값은 `{auto:true, keep:15_000}`이다(`core/src/session/compaction.ts:38-44,189`).
  - config의 `compaction.{auto, buffer, keep.tokens}`가 Location마다 이 값을 덮는다(`core/src/config/plugin/compaction.ts:15-24`, `schema/src/config/compaction.ts`).
  - provider·model의 `settings.compaction`은 `{type:"summary"|"native"}`뿐이라 기준을 담을 수 없다(`schema/src/provider.ts:35-41,47-55`, `schema/src/model.ts:57-63`).
- **시점**: runner가 step마다 모델 요청 전에 `compact({reason:"auto"})`를 부른다(`core/src/session/runner/llm.ts:217`).
  - `auto`가 꺼져 있으면 수동 외에는 모두 건너뛴다. overflow 복구도 포함이다(`compaction.ts:201-202`).
  - 기준은 `ceiling = calculateCeiling(model.limit, buffer)`다(`:203`). `window = limit.input || limit.context`이고, 0 이하면 무한대(자동 압축 없음), `buffer`가 없으면 `window − max(floor(window × 0.1), 16k)`(16k는 창이 32k 이상일 때만, upstream d9987ef9c8), 있으면 `window − buffer`다. **`limit.output`은 보지 않는다.**
  - 발동 조건(`due`): 직전 메시지가 완료된 압축이 아니고, 이 providerID가 잰 마지막 prompt가 마지막 checkpoint 뒤에 있으며, `estimateContext ≥ ceiling`이다(`:225-234`). `estimateContext`는 이 providerID의 마지막 측정 step의 `input+cache.read+cache.write+output+reasoning`에 그 뒤 메시지의 문자 수 기반 추정을 더한 값이다(`:845-864`). 코어 패치 P-017로 이 기준(anchor)은 같은 카탈로그 모델 id를 쓰는 다른 provider가 잰 step일 수도 있다. 세션의 가장 새 완료 압축이 이 모델의 history가 시작하는 압축과 같고(압축이 없어도 성립) 그 history에 native checkpoint가 없을 때만이다. 그래서 같은 모델의 계정 slot 사이를 전환해도 측정값이 이어지고, 기준 뒤의 꼬리만 문자 수로 추정한다. 문자 수 추정(`Token.estimate`)은 코어 패치 P-016으로 한글을 글자당 0.65토큰, 그 밖의 CJK를 0.6토큰, 나머지를 길이/4로 센다(`core/src/util/token.ts`). 값은 2026-10-07 실제 계정 측정(`own/reports/token-density-2026-10-07.md`: 한글 0.68–0.79, CJK 0.62–0.75)의 가장 낮은 값 바로 아래다(R8).
  - overflow: provider가 "too long"으로 거절하면 `compact({reason:"overflow"})`로 한 번 복구한다(`runner/llm.ts:261-266`). 거절 판정은 오류 문구 정규식과 오류 코드다(`ai/src/provider-error.ts:17-37,146-157`). 문구가 맞지 않는 서버에서는 복구가 일어나지 않는다.
- **요약 요청의 크기**: 예산은 `ceiling`이다(overflow면 `min(ceiling, 추정 × 0.7)`, `compaction.ts:203-212,292`). older 부분이 예산을 넘으면 오래된 교환부터 버리고 텍스트로 합친다(`:386-395,448`). **그래서 기준을 낮추면 요약 요청의 상한도 함께 낮아진다.**
- **keep**: 요약은 older만 보내고 최근 `keep` 토큰은 원문 텍스트로 남긴다(`:255-292`). 나누기는 compaction hook보다 먼저 일어나므로(`:261-268`) hook으로 keep을 바꿀 수 없다.
- **수동 압축**: `POST /api/session/:id/compact`는 기본 `steer`라 다음 step 경계에서 끼어든다(`protocol/src/groups/session.ts:496-513`). 예산은 그 모델의 ceiling이다.
  - staged revert가 있으면 **입장(admission) 전에 먼저 commit한다**(`core/src/session/session.ts:251`). 요청이 기존 압축에 합쳐지거나 409가 나도 commit은 이미 일어난다. commit은 경계 메시지부터 뒤를 DB에서 지운다(`core/src/session/projector.ts:739-764`). 그래서 자동으로 보내는 `POST /compact`는 되돌릴 수 있던 복원을 데이터 손실로 바꿀 수 있다(4.7.4 "revert").
  - 같은 `id`의 처리(`SessionInbox.admitCompaction`, `core/src/session/inbox.ts:204-224`): 그 id가 아직 대기 중이면 그 항목을 그대로 돌려준다(멱등). 다른 압축이 대기 중이면 id와 상관없이 그것에 합쳐진다. 그 id가 이미 전달되어 메시지가 됐으면 `LifecycleConflict`이고 HTTP 409 `CompactionConflictError`가 된다(`session.ts:254-259`).

#### 4.7.2 방식 선택

| 후보 | 판정 | 이유 |
|---|---|---|
| (a) slot의 provider settings | 불가 | `Provider.Settings.compaction`은 요약 방식만 담는다. core 설정은 Location 전역이다(4.7.1) |
| (b) **slot 모델의 실효 `limit.input`** | **채택(주 수단)** | core 식을 그대로 쓰므로 턴 안 step마다, overflow 복구까지 core가 지킨다. 연결된 클라이언트가 없어도 동작한다. 코어 패치가 없다. `limit`은 요청 바이트에 없어 prefix에 영향이 없다(D6) |
| (c) 플러그인·프런트 주도 압축(core `auto:false`) | 주 수단으로는 기각 | `auto:false`면 overflow 복구도 꺼진다(`compaction.ts:201-202`). core 기준을 끄고 매 step을 플러그인이 대신 판정할 이유가 없다 |
| (c') 세션 "더 일찍"만 own-accounts가 압축을 넣음 | **채택(보조)** | 세션 값이 같은 slot 모델을 쓰는 다른 세션에 영향을 주면 안 되므로 (b)로 할 수 없다. 기준에 닿으면 own-accounts가 플러그인 `ctx.session.compact`로 압축을 넣는다(4.7.4) |
| (d) 서비스 자기 호출(loopback) | **대체됨(2026-10-08)** | upstream 924c12b291이 플러그인 session domain에 `compact`를 열어 서비스 password 없이 같은 일을 한다(아래). 옛 안은 접속 정보(`127.0.0.1`, 포트, password, `%OPENCODE_CONFIG_DIR%\service-own.json`)로 `POST /api/session/:id/compact`를 스스로 부르는 것이었다 |

- **서버에서 압축 넣기**(`ctx.session.compact`, 2026-10-08. Q31의 답)
  - 플러그인 API라 HTTP·서비스 password·원격 접속 정보가 필요 없다. 원격 호스트(04)의 own-accounts도 자기 서버에 같은 호출을 한다.
  - hook 안에서 부르지 않는다. 같은 세션의 runner가 hook을 기다리는 동안 다시 들어가면 교착·재진입 위험이 있다. 세션 이벤트 처리(`step.ended` 뒤, RPC 처리 안)에서만 부른다. 입장(admission)만 하고 실행을 기다리지 않으므로 이벤트 큐를 막지 않는다.
  - revert 규칙(4.7.4 "revert")을 그대로 따른다: 부르기 직전 `ctx.session.get`으로 `revert`가 없음을 확인하고, 있으면 넣지 않고 staged로 기록한다.
  - `compaction.due`의 `inputID`를 `id`로 넘긴다. 다시 넣거나 클라이언트가 같은 id로 보내도 같은 항목이고, 이미 전달된 id의 409(`CompactionConflictError`)는 넣은 것으로 친다(4.7.1).
  - 실패하면 로그(`compaction_admit_failed`)를 남기고 `compaction.due`는 그대로 내므로 연결된 클라이언트가 같은 id로 할 수 있다. 다음 `step.ended`에 한 번 더 넣는다.
  - **범위(05 §13.5와 맞출 것)**: 서버가 넣으므로 `switch` 범위만 있는 기기도 `compaction.setSession`(세션 값)과 `switch.apply`의 압축 전략으로 압축을 일으킬 수 있다. 전에는 압축 실행이 `prompt` 범위 클라이언트의 몫이었다(9.1). 압축은 기록을 지우지 않고 staged revert는 지키므로 이 문서는 받아들이지만, 05의 범위표와 own-web의 전략 숨김(9.1)은 따로 맞춘다.

- **(b)의 한계**
  - `keep`은 slot마다 바꿀 수 없다(4.7.6).
  - **늦추는 쪽으로는** kind의 ceiling까지만 된다: v2 기본(core ceiling, `ctx − max(floor(0.15·ctx), 16k)`), compat는 `floor(0.9·ctx)`(4.7.3 `ceilingOf`). 원래 창보다 큰 `limit.input`은 compat가 90%에 닿을 때만 적는다. core가 창의 15% 이상을 남기므로 v2.1부터는 compat의 모든 창이다. core가 `limit.input`을 읽는 곳은 이 ceiling뿐이고 출력 한도는 `limit.context`로 맞추므로(`core/src/session/model-request.ts` outputLimit) 요청 크기나 출력 한도는 원래 창을 넘지 않는다.
  - `anthropic`(Claude 구독 슬롯)은 우리 provider가 아니라서 모델 limit을 바꾸지 않는다(I5, 4.6). 이 슬롯은 v2 기본과 세션 "더 일찍"만 된다.
  - 전역 `compaction.buffer`가 있으면 core 식이 `ctx_eff − buffer`로 바뀐다. own 전역 설정은 buffer를 두지 않는다. 사용자가 own 전역 설정 파일에 넣으면 selfTest가 경고한다(own-accounts가 그 파일을 직접 읽는다). 프로젝트 설정의 값은 런타임 불일치 경보 `compaction_threshold_mismatch`(7.7)로만 안다.
  - 등록 모델의 `limit.input`이 원래 창과 달라져도 upstream 클라이언트의 문맥 표시는 바뀌지 않는다. TUI, upstream app, ACP 모두 `limit.context`로 비율과 크기를 낸다(`tui/src/util/session.ts:71`, `app/src/session/timeline/session-context-usage.tsx:80`, `cli/src/acp/service.ts:573-580`). 그래서 거기서는 낮춘 기준이 보이지 않는다(모두 원래 창 기준 %). own-web은 원래 창을 `cache.state.compaction.windowTokens`, 기준을 `triggerTokens`(9.2)에서 읽는다.

#### 4.7.3 설정 모델과 kind 기본값

**설정 한 벌**(`Compaction.Setting`, 모든 필드 선택)
- `triggerPercent`: 원래 창 `ctx`에 대한 기준 비율(10–90).
- `maxTriggerTokens`: 기준 상한(토큰). `null`이면 상한이 없다.
- `minReserveTokens`: `ctx`에서 최소한 이만큼은 비워 둔다(출력, 도구 결과, 추정 오차).
- `models`: 모델 id별로 위 세 필드. kind 기본값과 계정 설정에서만 쓴다.

**계산**(slot·모델마다)
```
ctx     = 템플릿의 limit.input || limit.context       (0이면 core는 자동 압축을 하지 않는다 → compat는 창 입력 필수, 3.3)
T_raw   = min(triggerPercent/100 · ctx,  maxTriggerTokens ?? ∞,  ctx − minReserveTokens)
T_floor = min(ceiling(ctx),  K + 48,000)             K = own 전역 설정의 keep(기본 15,000, 4.7.6). 압축 직후 문맥 S≈Z+S_sum+K(기본 약 35–45k)보다 여유를 둔다
T_slot  = clamp(T_raw, T_floor, ceilingOf(ctx, kind)) 늦추기는 kind의 ceiling까지만. triggerPercent 90(최대)은 그 ceiling 자체(큰 창은 85%, compat는 90%)
ctx_eff = windowFor(T_slot)                           → 등록 모델의 limit.input. ceiling(ctx_eff) = T_slot. T_slot = ceiling(ctx)이면 등록하지 않는다
ceiling(c) = c − max(floor(0.15·c), c ≥ 32k ? 16k : 0) core calculateCeiling(upstream v2.1 `RESERVE_SHARE` 0.15, d9987ef9c8의 16k). windowFor는 T + 16k와 ceil(T / 0.85) 중 ceiling이 T에 닿는 작은 쪽
ceilingOf(c, kind) = kind = compat ? max(ceiling(c), floor(0.9·c)) : ceiling(c)   own `Compaction.ceilingOf`
T       = min(T_slot, T_session ?? ∞)                 세션 값은 T_floor ≤ T_session < T_slot (4.7.4)
```
- `T_floor`는 압축 직후 다시 기준에 닿아 step마다 압축하는 반복을 막는다. `ctx`가 작아 `ceiling(ctx) < K + 48k`이면 v2 기본으로 떨어지고, 설정 화면은 "이 모델은 창이 작아 압축 기준을 바꿀 수 없습니다"를 보인다. compat는 그런 창에서도 `T_floor`와 90% 사이에서 바꿀 수 있다.
- **compat의 90%(R8, 2026-10-08; US-1 2026-10-30).** upstream d9987ef9c8부터 core는 창이 32k 이상이면 16k를 남기고, v2.1부터는 창의 15%와 16k 중 큰 쪽을 남긴다. compat는 흔히 작은 로컬 창이라 32,768 창이 16,768(51%), 49,152 창이 33,152, 65,536 창이 49,536에서 압축된다. 그래서 compat만 kind ceiling을 `floor(0.9·ctx)`로 두어 그 전의 기준으로 되돌린다: 32,768 → 29,491, 49,152 → 44,236, 65,536 → 58,982, 128,000 → 115,200, 200,000 → 180,000. core 식 그대로 거기에 닿도록 원래 창보다 큰 `limit.input = windowFor(T_slot)`을 등록한다(32,768 → 45,491, 128,000 → 135,529, 200,000 → 211,764). core가 모든 창에서 10%보다 많이 남기므로 v2.1부터는 compat의 모든 창이 등록한다(전에는 160k보다 작은 창만).
  - **compat에만 두는 이유(2026-10-08 sync 리뷰에서 정함, US-1에서 다시 확인).** 다른 kind(or, oai, xai, ds, anth, codex, siwc)는 core 식을 그대로 쓴다: 큰 창은 85%(1,000,000 → 850,000), 106,667보다 작은 창은 16k를 남긴다(64k → 48,000, 128k → 108,800). 그런 API 모델은 추론 모델이 많아 기준에서 답과 요약에 남는 자리가 10%(64k면 6.5k)로 줄면 아래 "대가"의 압축 실패가 더 잦다. upstream이 15%와 16k를 남기는 이유가 이 출력 자리와 큰 마지막 step이다. R8은 등록 창을 줄이지 않는 것이고(창은 그대로), 이 16k는 출력 자리라 core 기본을 따른다. compat는 32k 같은 작은 로컬 창에서 16k가 창의 절반이라 예외로 둔다. 다른 kind도 90%로 바꿀지는 사용자 결정으로 남긴다(SYNC_LOG 2026-10-08).
  - **출력 한도는 안전하다.** core가 `limit.input`을 읽는 곳은 자동 압축 ceiling뿐이다. 출력 한도(`model-request.ts` outputLimit)는 `limit.context`(원래 창)에서 측정값과 추정값×1.15를 뺀 자리로 줄이고, 요약 요청의 출력 한도는 원래 창에서 요약 예산(= T_slot)을 뺀 값이다. 요약 요청은 그 예산 안으로 줄여 보낸다. 그래서 prompt + 출력 한도는 원래 창을 넘지 않고, `limit.output`과 `limit.context`는 바꾸지 않는다(4.7.6).
  - **대가.** 기준에 닿았을 때 답과 요약에 남는 자리가 core의 15%(최소 16k)가 아니라 창의 10%다(32,768 창이면 3,277). 이는 d9987ef9c8 전과 같은 크기다. core는 요약 요청의 출력 한도를 `원래 창 − 요약 예산(T_slot)`으로 잡으므로(core `session/compaction.ts` prepare, 하한 1,024), 요약이나 그 앞의 추론이 이 자리를 넘으면 finish `length`로 끝나고 core가 `compaction.failed`("Compaction summary reached the output token limit")로 바꾼다. 그러면 자동 압축이 다음 step 경계에서 다시 돌고(그때마다 요약 요청 비용), provider overflow로 core가 요청을 줄일 때까지 반복될 수 있다. 추론 토큰을 많이 쓰는 로컬 모델을 80k보다 작은 창에서 쓰면 그 계정이나 모델에 `더 일찍`을 둔다: `minReserveTokens: 8000` 이상(요약에 8k), `16000`이면 core 기본과 같다. 실패는 대화에 압축 실패 줄로 보인다(경보 `compaction_failed`는 전환 중 압축에만 쓴다).
  - 프로젝트나 전역 config의 `compaction.buffer`는 core 식을 `ctx_eff − buffer`로 바꾸므로 compat에서는 원래 창 기준보다 `ctx_eff − ctx`만큼 늦어진다(4.7.2 (b)의 한계와 같은 경보 `compaction_threshold_mismatch`).
  - own-web의 설정 미리 보기(`settings/compaction-model.ts` `preview`)는 아직 kind를 넘기지 않아 compat의 `모델 한도`를 core ceiling으로 보인다. 계정 목록의 `compaction.effective`와 `cache.state.compaction`은 등록값과 같다(후속: `Compaction.resolve`에 kind를 넘김).

**kind 기본값**(초기값. 코드 상수이고 `policy.compaction.byKind`로 바꾼다)

| kind | triggerPercent | maxTriggerTokens | minReserveTokens | 예: 원래 창 → 기준 T | 근거 |
|---|---|---|---|---|---|
| `codex` | 90(v2) | 없음 | 없음 | gpt-5.6-sol 872,000(알려진 Codex 창, 3.6) → **741,200**. 목록 밖 gpt-6.1-sol은 카탈로그 922,000 → 783,700. gpt-5.5 이하는 ChatGPT 계정에서 쓸 수 없다(upstream v2.1 Codex 필터) | 사용자 결정(v2 기본). overflow 오류가 core 분류와 맞다(`context_length_exceeded`). upstream의 272k는 따르지 않는다(07 §6.2 #4) |
| `siwc` | 90(v2) | 없음 | 없음 | gpt-5.5 922,000(`templates/siwc.json`의 `limit.input`) → 783,700 | codex와 같은 모델군이고 같은 공개 API 오류를 쓴다. 압축 방식은 summary뿐이다(`/responses/compact` 없음, 3.2c) |
| `anth` | 90(v2) | 없음 | 없음 | claude-opus-5-5 1,000,000 → **850,000**[R-modelsdev] | 사용자 결정(v2 기본). 비용 상한이 필요하면 계정에 `maxTriggerTokens`를 둔다(6.3 ⑫로 비교) |
| `claude-sub` | 90(v2, 고정) | – | – | 1,000,000 → 850,000 | 우리 provider가 아니다(I5). 세션 "더 일찍"만 된다 |
| `claude-agent` | 90(v2) | 없음 | 없음 | Claude Code가 알려 준 창 1,000,000 → 850,000 | kind 기본과 계정 설정을 받는다(CAG-50). 코어는 자기 기준을 두고 own-accounts가 대화마다 더 이른 기준을 지킨다(8.10.5) |
| `oai` | 90(v2) | 없음 | 없음 | gpt-5.5 922,000 → 783,700 | D6에 없다. codex와 같은 모델군이고 overflow 분류가 맞아 v2로 둔다 ⚠사용자 확인(12장) |
| `ds` | 90(v2) | 없음 | 없음 | deepseek-v4-pro 1,048,576(v2.2.1 카탈로그) → **891,290** | 창을 줄이지 않는다(07 §6.1). ratecard `TTL_lo = 0`(6.2)이라 큰 문맥의 cold 비용(피크 $1.32/1M이면 891k ≈ $1.18)이 걱정되면 사용자가 계정이나 kind에 `더 일찍`을 둔다(6.3 ⑫로 비교) |
| `xai` | 90(v2) | 없음 | 없음 | grok-4.7 500,000 → 425,000 | 캐시 도메인·TTL 문서가 없다(2.2). 그래도 창은 줄이지 않는다(07 §6.1) |
| `or` | 90(v2) | 없음 | 없음 | anthropic/claude-opus-5.5 1,000,000 → 850,000. deepseek-chat-v3.1 163,840 → 139,264 | 상위 provider와 라우팅에 따라 오류 문구가 다를 수 있다. 창은 줄이지 않고 overflow 분류는 PG9로 확인한다(07 §6.1) |
| `compat` | 90(v2, 창의 90%) | 없음 | 없음 | 사용자가 입력한 창 128,000 → **115,200**(`limit.input` 135,529 등록. core만이면 108,800). 32,768 → 29,491 | 작은 로컬 창이 많아 core의 16k 예비분 대신 90%를 지킨다(위 "compat의 90%"). 창 크기가 사용자 입력이라 틀릴 수 있다(3.3). 서버 오류 문구가 core 정규식과 맞지 않으면 overflow 복구가 일어나지 않는다(`ai/src/provider-error.ts:17-37`). 그래도 창을 줄이지 않고, 모든 compat 계정 카드에 `넘침 자동 복구 확인 안 됨 · 서버 창을 정확히 적으세요`를 보인다. T1의 PG9가 분류를 확인한 서버에서만 뗀다(07 §6.2 #2) |

- 보수적 kind 기본값(`종류 기본(보수적)`)은 없다(07 §6.2 #2–#3). 더 일찍 압축하는 것은 사용자가 직접 정한 값(`직접 정하기`)뿐이고, 설정 화면은 그 값의 출처를 함께 보인다(4.7.4 `source`).
- 숫자는 초기값이다. AC-P40과 실제 사용 ledger로 조정한다. DeepSeek·xAI의 긴 문맥 품질에 대해서는 이 문서가 주장하지 않는다. 비용과 overflow 복구의 신뢰도만 근거로 삼았다.

#### 4.7.4 해석 순서와 세션 값

해석 순서(뒤가 이긴다)
1. v2 core 기본 `ceiling(ctx) = ctx − max(floor(0.15·ctx), 16k)`(16k는 창이 32k 이상일 때만, upstream d9987ef9c8. 15%는 v2.1부터). compat는 `max(ceiling(ctx), floor(0.9·ctx))`(4.7.3 `ceilingOf`)
2. kind 기본값(4.7.3 표의 코드 상수 위에 `policy.compaction.byKind[kind]`)
3. kind × 모델(`policy.compaction.byKind[kind].models[modelID]`)
4. 계정(`accounts[].compaction`)
5. 계정 × 모델(`accounts[].compaction.models[modelID]`)
6. 세션(`sess:<sid>:compaction.triggerTokens`, 더 일찍만)

- 1–5는 필드마다 덮는다. 결과가 `T_slot`이고 slot 등록 때 `ctx_eff`로 굳는다.
  - 설정이 바뀌면 레지스트리 revision을 올리고, 3.8의 재조정으로 모든 Location이 `provider.reload()`를 한다. runner는 step마다 모델을 다시 읽으므로(`runner/llm.ts:213-243`) 다음 step부터 적용된다 ⚠AC-P40(AC-P30과 함께 확인).
  - 결과마다 `source`(`v2|kind|kindModel|account|accountModel|session`)를 남겨 UI가 값의 출처를 보인다.
- **세션 값(6)**
  - `T_floor ≤ T_session < T_slot`만 받는다. 벗어나면 `setting_out_of_range{field:"triggerTokens", min, max}`다. 세션별로 늦추거나 끄는 기능은 없다(core `auto`는 Location 전역이다).
  - 세션이 다른 slot으로 전환하면 `T = min(새 slot의 T_slot, T_session)`이다. `T_session`이 새 slot의 `T_floor`보다 작으면 `T_floor`로 올린다.
  - **실행은 서버가 한다(2026-10-08).** own-accounts가 그 세션의 `step.ended`마다 `P`를 본다. `P`는 마지막 step의 `input+cache.read+cache.write+output+reasoning`이고, core `estimateContext`의 측정 기준과 같은 값이다(`compaction.ts:861-863`). 그 뒤에 붙은 도구 결과만큼 실제 문맥보다 조금 작다. 아래가 모두 참이면 압축을 넣고 세션 이벤트 `compaction.due{sessionID, inputID, P, triggerTokens, epoch}`(9.3)를 낸다.
    - `P ≥ T_session`
    - 이 epoch에 아직 내지 않았다(`sess:<sid>:compactionDue`)
    - 압축이 진행 중이거나 대기 중이 아니고, 전환 상태가 COMPACTING이 아니다
    - 문맥 비우기가 기다리고 있지 않다(아래 "문맥 비우기", RC-42). 비우면 압축할 것이 없고, core가 그 압축을 비우기의 전달에서 취소하므로 그 뒤에 같은 id로 넣는 클라이언트가 빈 새 문맥을 압축하게 된다. 비우기가 전달되거나 취소된 뒤의 `step.ended`에서 다시 판정한다(전달이면 cold point라 다음 측정까지 `P`가 없다)
    - 세션에 staged revert가 없다(아래 "revert")
  - `inputID`는 own-accounts가 `SessionMessage.ID.create()`로 한 번 만든다. own-accounts가 **직전에 `ctx.session.get`으로 revert가 없음을 확인한 뒤**(아래) 플러그인 `ctx.session.compact({sessionID, id: inputID})`로 넣는다(4.7.2 "서버에서 압축 넣기", `SessionCompaction.compact`). 그때 revert가 보이면 넣지도 이벤트를 내지도 않고 staged로 기록한다. 연결된 클라이언트가 없어도 된다.
    - 이벤트는 그 뒤에 알림으로 낸다. 이벤트를 받은 클라이언트(`prompt` 범위, 9.1)가 예전처럼 같은 id로 `POST /api/session/:id/compact`를 보내도 한 번만 들어간다(소스 확인, 4.7.1). 대기 중이면 같은 항목이 돌아오고, 이미 전달됐으면 409 `CompactionConflictError`다. 클라이언트는 409를 무시한다.
  - `compaction.started`가 오면 due 기록을 지운다. 오지 않으면 다음 `step.ended`에서 같은 `inputID`로 한 번 더 넣고 낸다. 서버의 입장이 실패했을 때(로그 `compaction_admit_failed`) 연결된 클라이언트가 같은 id로 할 수 있게 이벤트는 그대로 낸다.
  - 그래서 세션 값은 앱이 닫혀 있어도 적용된다(Q31). UI의 "앱이 열려 있을 때만 적용" 표시는 뗀다(03, 후속).
- **revert(메시지 복원, [R-gap] #7)와 압축**
  - 구독: `session.revert.staged/cleared/committed`(`schema/src/session-event.ts:641-651`, 공개 manifest `:702-704`).
  - **staged**: 그 세션의 `sess:<sid>:compactionDue`와 `cache.state.compaction.pendingDue`를 지우고, 메모리에 `revertStaged`를 둔다(재시작 뒤에는 `ctx.session.get`의 `revert`로 복구). 이 동안은
    - 압축을 넣지 않고 `compaction.due`를 내지 않는다.
    - `switch.estimate`의 `compact-then-switch`와 `switch-then-compact`는 `available:false, reason:"revert_staged"`다. `switch.apply`가 이 전략으로 오면 `revert_staged` 오류다(9.4). 서버도 압축을 넣지 않는다.
    - 압축 기준 변경의 "먼저 압축한 뒤 적용"(4.7.5)도 그 세션에는 권하지 않는다(`compactionImpact`의 행에 `revertStaged:true`).
  - **cleared**: 플래그를 지운다. 다음 `step.ended`에서 다시 판정한다.
  - **입장 규칙**: 서버가 넣는 압축(세션 값, 5.9(b)(c)의 전략)은 넣기 직전에 `ctx.session.get`의 `revert`를 확인한다. 클라이언트가 자동으로 보내는 모든 `POST /compact`(`compaction.due`, 재연결 때 본 `pendingDue`, "먼저 압축한 뒤 적용")도 보내기 **직전에** `GET /api/session/:id`의 `revert`가 비어 있는지 확인한다. 있으면 보내지 않는다. 이벤트와 요청 사이에 다른 클라이언트가 복원을 stage할 수 있기 때문이다. 사용자가 누른 수동 압축은 03이 확인 대화상자로 다룬다(복원이 확정된다는 문구).
  - **committed**(`to` = 경계 메시지): 경계부터 뒤가 지워진다(`core/src/session/projector.ts:739-764`). own-accounts는
    - `sess:<sid>:epoch`를 1 올린다. 경계가 마지막 압축 checkpoint보다 앞이면 그 checkpoint가 지워지므로 epoch 의미가 바뀌기 때문이다. 줄이지 않고 올리기만 해서 epoch 비교(6.3 ①)가 "달라짐"으로 판정되게 한다.
    - 모든 slot의 캐시 상태(`sess:<sid>:cache:*`)를 다시 잡는다: `L`은 남은 기록 기준으로 모르므로 `W^lo = 0`, `W^hi = 옛 L`로 둔다(앞부분 캐시는 살아 있을 수 있다). `blocksSince`, `messageEndsSince`, watermark는 경계 뒤를 가리키면 지운다. 다음 step이 새 기준선을 잡는다.
    - `compaction.due` 기록을 지우고 `cache.state`를 낸다.
  - 01 §8.7 R7("revert 뒤 첫 요청은 cold point")과 같은 판단이다. AC-P45로 확인한다.
  - 수동 압축 경로이므로 예산은 `T_slot`의 ceiling이다. 세션 값으로 일찍 압축해도 요약 요청이 잘리지 않는다.
- **문맥 비우기(core P-035, 03 §18.18, 11 §7, RC 2026-10-24)와 압축**
  - 구독: 비우기는 inbox 항목 `reset`의 `session.inbox.enqueued`와 그 id의 `session.inbox.delivered`, 되돌리기는 `session.reset.undone`이다. 전달 이벤트에는 id만 있으므로 이벤트 분배기(`events.ts`)의 `Resets.Tracker` 하나가 넣은 항목의 종류를 기억하고(취소는 `session.inbox.cancelled`), 그 결과를 모듈에 `EventMeta.reset`으로 넘긴다. 이 프로세스가 넣는 것을 보지 못한 항목(재시작 전에 넣음)의 전달은 세션 문맥(`ctx.session.context`)을 읽어 알아본다: core가 전달된 비우기를 그 id의 표시로 문맥 맨 앞에 두기 때문이다(RC-21).
  - 둘 다 cold point다. 비우면 요청의 메시지 부분이 첫 메시지부터 바뀌고(앞 대화가 빠짐), 되돌리면 앞 대화가 다시 들어온다. 그래서 committed revert처럼
    - `sess:<sid>:epoch`를 1 올린다(로그 `context_reset{kind:"reset"|"undo", epoch}`).
    - 모든 slot의 캐시 상태(`sess:<sid>:cache:*`)에서 watermark, `blocksSince`, `messageEndsSince`를 지운다(`CacheState.cleared`). `L`과 `lastReqAt`은 그대로 둔다: 지시문·도구 부분과, 되돌리면 앞 대화 부분의 캐시가 살아 있을 수 있다.
    - 측정 크기 `P`를 모른다(tracker의 마지막 step과 압축 뒤 추정을 지움). `cache.state.compaction.P`와 세션 목록의 `P`는 다음 `step.ended`까지 `null`이다. 자리 비움 압축(4.7.7)은 그동안 `small`로 건너뛴다.
    - 전환 추정(6장)의 `P`는 0이 아니라 추정값이다(RC-21). 비운 뒤에는 고정 앞부분 `Z`, 되돌린 뒤에는 비우기 직전에 잰 크기에 비운 뒤 대화가 `Z` 위로 늘린 만큼을 더한 값이다. 비우기를 이 프로세스가 보지 못했으면(재시작) 세션 기록에서 센다: 표시 앞의 마지막 측정 요청에 표시 뒤 대화가 늘린 만큼(`Resets.restoredSize`, own-web `undoCost`와 같은 계산). planner는 이 프로세스가 재지 않은 세션이면 세션 목록의 마지막 `P`를 쓴다.
    - `cache.state`를 낸다.
  - 세션 값 판정(위)은 다음 `step.ended`의 `P`로 다시 한다. 되돌린 뒤 문맥이 기준을 넘으면 core가 다음 단계 전에 자동 압축한다. own-web은 되돌리기 전에 그 크기를 보여 묻는다(03 §18.18).
  - D10 도구 집합 기준선(4.3)은 비우기에서 잊는다. 비우기는 지시문 epoch를 옮기므로 다음 요청의 system이 그때의 지시문 값으로 다시 그려진다(11 §7).
  - `compact-then-switch`가 COMPACTING으로 기다리는 동안 비우기가 전달되면 압축이 끝난 것처럼 WAIT_SAFE로 넘어가 전환한다(RC-37). core는 비우기가 전달될 때 아직 시작하지 않은 압축을, 비우기보다 먼저 들어왔든 기다리는 비우기 뒤에 들어왔든 필요 없음으로 취소하므로(11 §7.2, RC-42) `compaction.ended`도 `compaction.failed`도 오지 않는다. 그래서 비우기가 이미 기다릴 때 고른 `compact-then-switch`도 같다: 압축은 비우기 뒤에서 기다리다 정리되고, 전환은 그 턴이 끝나 비우기가 될 때 된다. 기다리면 10분 동안 보내기를 막게 된다. 비운 문맥은 고정 앞부분뿐이라 전환이 싸다. 4차까지 이 문단은 비우기보다 먼저 들어온 압축만 적었고, 비우기 뒤에 넣은 압축은 core에서 `Nothing to compact yet`으로 실패했다(RC-29).
  - 기다리는 비우기는 switching tracker가 그 항목의 `session.inbox.enqueued`부터 전달·취소까지 기억한다(`waitingReset`). 그동안 `compaction.due`를 내지 않는다(위 판정). 이벤트 스트림이 밀려(4096개) 다시 구독하면 그 사이의 이벤트는 사라진다(`events.ts`). 그래서 다시 구독한 뒤 첫 이벤트에서 모든 세션의 `waitingReset`과 `compacting`을 확인 전으로 두고(`onResubscribe`), 그 세션의 `compaction.due` 판정이 서버에서 다시 읽는다: 기다리는 비우기는 세션 inbox(`GET /api/session/:id/inbox`, 자기 HTTP, 06 §2.6), 도는 압축은 세션 문맥의 `running` 압축 메시지다. 읽는 동안 그 세션의 비우기·압축 이벤트가 오면 읽은 값은 버리고 다음 판정에서 다시 읽는다. 그래서 놓친 전달이나 압축의 끝 때문에 `compaction.due`가 막힌 채 남지 않고, 놓친 비우기 넣기 때문에 비우기를 기다리는 세션에 보내지도 않는다(RC-52). 자리 비움 압축(4.7.7)은 답하지 않은 inbox 항목이 있으면 원래 건너뛴다.
- **설정 화면이 쓰는 데이터**: 계정별 결과는 `accounts.list`의 `compaction.effective[]`, kind 기본값은 `policy.get`의 `compactionDefaults`, 세션 값과 현재 문맥은 `cache.state.compaction`(9.2)이다. 문맥 막대의 기준 표시(03)는 `cache.state.compaction.triggerTokens`와 `windowTokens`를 쓴다.

#### 4.7.5 캐시·전환과의 관계

- **압축 = cold point.** `compaction.ended`마다 epoch가 올라가고 이 세션의 모든 slot 캐시가 cold가 된다(2.4.6). SCHEDULED 전환(`trigger:"compaction"|"either"`)은 여기서 실행된다(5.9(d)). 기준이 낮을수록 cold point가 자주 온다. `cache.state.compaction.remainingTokens`로 "다음 압축까지 약 N 토큰"을 보일 수 있다.
- **요약 요청의 캐시.** 요약 요청은 같은 system·tools에 기록을 붙인다(D2). 자동 압축은 턴 안 step 경계에서 바로 일어나므로(`runner/llm.ts:217`) 소스의 마지막 요청이 대개 `TTL_lo` 안이다.
  - **older 요청이 이미 맞는 때(실측 2026-10-24, own/reports/cached-compaction-2026-10.md §9).** 따뜻한 압축에서는 older 요청도 95~97%를 캐시에서 읽었다. older 끝은 최근 부분 첫 요청들의 breakpoint에서 몇 칸 앞이고, Anthropic은 breakpoint에서 20칸 안의 항목을 읽기 때문이다. 이때 전체 요청은 최근 부분만큼 커서 오히려 조금 비쌌다(Anthropic 압축 한 번에 입력분 +$0.0004~0.0016). ChatGPT(가장 긴 접두 캐시)는 엇갈렸다: W1은 89.1% → 94.5%로 입력분이 0.29 → 0.24 cr로 줄었고, W3는 입력분이 0.19 → 0.25 cr로 늘었다. 전체 값은 같거나(0.53 → 0.53) 요약 길이(출력)가 좌우했다(0.43 → 0.54). older가 놓친 곳은 하나다: 최근 부분이 20칸(도구 호출 약 10번)보다 길고, older 끝을 덮는 마지막 요청이 5분보다 전인 경우(S1: older 71~72%, 전체 98%).
  - **전체 요청(P-034).** 그래서 첫 시도로 **대화 전체**(older + 남길 최근 부분)를 다음 기본 요청과 같은 바이트로 보내고 맨 끝에 지시문을 붙이는 것은(11 §2.5) 아래 조건을 모두 채울 때뿐이다. 직전 요청이 써 둔 끝 항목을 읽으므로 `h_c≈1`이다. 이득을 잰 곳은 Anthropic 엔진뿐이라 그곳으로만 한정한다(CC-16).
    1. **Anthropic 엔진의 breakpoint 캐시**: `anth`, Claude 구독(20블록). 요금표 카드에 lookback이 있는 `oai`(GPT-5.6 이후, `messageEnds` 20)도 breakpoint 캐시지만 전체 요청을 재 보지 않았으므로 잴 때까지 older다(`unmeasured`). 그 밖(`codex`·`siwc`의 HTTP와 WebSocket, oai 5.5 이하, `ds`, `xai`, `or`, `compat`, own이 아닌 회사)은 가장 긴 접두를 스스로 읽어 older가 이미 맞으므로 늘 older다(`longest-prefix`). ChatGPT는 실측도 엇갈렸다(위).
    2. **따뜻함**: 마지막 기본 요청을 **보낸 시각**부터 `TTL_lo`가 지나지 않았고 그 요청이 같은 모델·변형(아니면 `cold`·`model`, `TTL_lo`가 0이면 `no-ttl`). Claude 구독은 그 요청에 서명한 계정(G4, 8.5)과 압축이 돌 계정(대화 트리의 계정, 8.7)이 같아야 한다(아니면 `account`, SL-8 2026-10-27). Claude 계정을 바꾼 직후의 압축은 새 계정에서 돌고, 새 계정에는 이 대화의 캐시가 없으므로 대화 전체를 보내면 전체를 새로 쓴다.
    3. **최근 부분이 lookback보다 김**: 남는 첫 메시지부터 끝까지를 Anthropic이 세는 방식으로 센다. 내용 블록이고, 이어진 도구 호출 묶음과 도구 결과 묶음은 각각 한 칸이다. lookback 안이면 마지막 요청의 항목이 older 끝을 덮는다(`short`).
    4. **older 끝 항목이 식었을 수 있음**: older 끝에서 lookback 안에 끝난 마지막 step(그 요청의 항목이 older가 읽을 항목)이 **시작한** 지 `TTL_lo`가 지났거나, 이 프로세스가 그 step의 시작을 보지 못했다. `TTL_lo` 안이면 older가 그 항목을 읽는다(`fresh`).
  - 판정 자리: own-accounts의 `compaction` hook(own-harness보다 먼저 돈다)이 첫 실행에 1·2를 보고 `own.compaction.cache`(`CompactionCache.CacheVerdict`)에 적는다. own-harness는 판정이 `full`일 때만 `prefix:"full"`을 켠다. 판정이 없으면(own-accounts가 없거나 hook이 돌지 않음) 어느 회사든 older다(fail closed, CC-16). 두 번째 실행(`kept`, 대화 전체가 보임)에 own-accounts가 3·4를 보고, older가 맞으면 `prefix`를 끄고 `metadata.prefix`에 `{request:"older", reason:"short"|"fresh"}`를 적는다. 판정이 실패하면 older다(첫 실행 `error`, 두 번째 `error`).
  - core는 overflow, **고정 생각 예산**(`thinking:{type:"enabled", budget}`: Claude 3.7·4.0–4.5, core `variant.ts`의 `claudeInfo.manual`, 예: Haiku 4.5의 thinking·high·max. 평문 사용자 메시지가 오면 앞선 턴의 생각을 빼고, 압축의 작은 출력 한도가 예산을 줄이므로(`fitThinkingBudget`) 어느 쪽이든 캐시된 요청과 달라짐, `thinking`), stand-in, 두 번째 hook 실행의 거절(hook이 준 이유, 없으면 `declined`), **모델의 실제 창** − 16k에 안 들어감(`limit.context` 기준, P-017의 측정 크기. own-accounts가 기준을 낮추면 `limit.input`은 그 창이라 쓰지 않음, `fit`), 가격 구간을 넘음(`tier`)이면 지금의 older 요청을 보내고 그 이유를 `prefix:{request:"older", reason}`로 남긴다. 전체 요청은 한 번만 보내고, 실패(오류·잘림·빈 답)하면 곧바로 older로 간다(`failed`). 남는 부분이 없어 older가 곧 대화 전체(`full`)인데 글로 바뀌어 나가면 `flattened`다.
  - 기록은 그 뒤에 대체 모델(stand-in)이나 코드 요약이 체크포인트를 써도 남는다(예: `older`·`failed`). 읽을 때(`CompactionCache.sentOf`, ledger와 압축 내용 창) 대체 모델의 요약은 그 모델 자신의 older 요청에서 왔고 세션 캐시를 읽지 않았으므로 `older`/`stand-in`이다. core가 세션 모델의 시도를 `full`로 적었어도(남는 부분이 없을 때) 그렇다(CC-16). 코드 요약은 어떤 요청도 쓰지 않았으므로 요청 모양을 보이지 않는다(`undefined`).
  - 남길 최근 부분은 약 15k가 아니다. `keep` 경계 앞의 마지막 사용자 메시지부터라서 지금 턴 전체(수십만 토큰)일 수 있다. 자동 압축은 문맥이 기준(창의 85%) 근처일 때 돌아 200k 창은 창 − 30k 안에 들어갈 자리가 거의 없다. 이득은 긴 에이전트 턴(도구 호출 10번 이상) 뒤의 1M 창 압축과, 그런 턴 뒤 쉬었다가 누른 `/compact`에서 나온다.
  - ledger 압축 줄의 `compaction`(`CompactionCache.Sent` `{request, reason?, trigger?}`)과 `hit`(압축의 모든 요청을 합친 캐시 비율)로 압축마다 확인한다(7.5). 그 줄의 캐시 항목(2.4.6 `lastReqAt`, `L`)은 **마지막으로 보낸** 압축 요청의 시작 시각과, own slot이면 스트림이 알린 그 요청 자신의 크기다(합이 아님).
- **압축 직후 첫 요청**은 `S` 전체를 cold로 쓴다. 기준에 따른 요청당 평균 비용은 6.3 ⑫로 계산해 설정 화면에 v2 기본과 나란히 보인다.
- **기준을 현재 문맥보다 낮추면** 다음 step에서 곧바로 자동 압축된다. 이때 요약 예산이 새 기준이라(4.7.1) `Z + P_older`가 새 기준을 넘으면 오래된 교환이 요약에서 빠진다.
  - 그래서 `accounts.update{compaction}`과 `policy.set{patch.compaction}`은 `dryRun:true`로 먼저 부를 수 있다. 저장하지 않고 `compactionImpact{sessions:[{sessionID, P, triggerTokens, truncates}]}`를 돌려준다(9.2).
  - UI는 `truncates:true`인 세션이 있으면 "먼저 지금 기준으로 압축한 뒤 적용"을 권한다. own-web이 그 세션들에 `POST /compact`를 보내고(옛 기준 예산으로 돈다) `compaction.ended`를 받은 뒤 저장한다.
- **작은 창으로 전환하기 전 압축**(5.6): 대상의 실효 기준 `T_t`를 쓴다.
  - `P_t ≥ T_t`: 대상에서 무엇이 일어나는지는 세션이 이미 압축된 적이 있는지에 달렸다. core `due()`는 **현재 providerID로 잰 prompt가 마지막 checkpoint 뒤에 없으면** 자동 압축을 하지 않는다(`core/src/session/compaction.ts:225-234,879-884`).
    - 한 번도 압축하지 않은 세션: checkpoint도 측정값도 없어(`-1 < -1`이 거짓) 문자 수 추정으로 판정한다. 도착하자마자 대상에서 cold 요약이 돌고, 요약 예산 `T_t`를 넘는 부분은 버려진다.
    - 이미 압축한 적이 있는 세션: 대상 slot의 측정값이 checkpoint 뒤에 없으므로 첫 요청은 **압축 없이 통째로** 나간다. 결과는 `P_t` 전체의 cold write이거나, 창을 넘으면 overflow 거절 뒤 복구 압축이다(`runner/llm.ts:261-266`, 예산 `min(ceiling, 추정 × 0.7)`). 자동 압축은 그다음 step부터다.
    - 어느 경우든 대상에서 비싼 일이 생기므로, 소스를 쓸 수 있으면 `compact-then-switch`를 강제한다(`now`는 `available:false, reason:"target_context_too_small"`).
  - `0.8·T_t ≤ P_t < T_t`: 대상에서 곧 압축된다(경고 `target_compacts_soon`). 요청 몇 개 안에 대상에서 cold 요약 비용이 생기므로 `compact-then-switch`를 권장 후보로 올린다(6.3 ⑦로 비교).
  - 압축 뒤 문맥 `S_t ≥ 0.8·T_t`이면 압축해도 곧 다시 닿으므로 `new-session`을 권한다.
  - 소스를 쓸 수 없어 `switch-then-compact`가 되면 요약이 대상에서 예산 `T_t`로 돈다. `Z + P_older > T_t`이면 경고 `compaction_may_truncate`를 붙이고 `new-session`을 함께 권한다.
- **원격 호스트**(04)의 own-accounts는 미러 레지스트리의 `compaction` 설정으로 같은 `ctx_eff`를 계산한다. 세션 값 KV는 원격 DB에 있고, `compaction.due`도 원격 서버가 낸다(04 §12.6의 서버별 이벤트 경로).

#### 4.7.6 `keep`과 하지 않는 것

- `keep`(원문으로 남기는 최근 토큰, 기본 15k)은 core의 **config 전역 값 하나**다(4.7.1). kind·계정·세션마다 다르게 둘 수는 없다. 사용자 결정 D6의 "보수적 kind는 keep을 작게"는 두 방법 중 하나로 한다. **어느 쪽인지는 사용자 결정이다(12장 Q29).**
  - **(가) 전역 keep(코어 패치 없음).** own 전역 설정 `%OPENCODE_CONFIG_DIR%\opencode.jsonc`의 `compaction.keep.tokens`를 바꾼다(`core/src/config/plugin/compaction.ts:21`). 03 §5.8.4의 "최근 원문 유지" 칸이 이것이다.
    - 대가: Codex·Claude를 포함한 **모든 kind**에 적용된다. keep을 줄이면 v2 기본 kind도 압축 뒤 원문이 줄어든다. 기술적 불가가 아니라 이 대가를 받아들일지의 선택이다.
    - 쓰는 경로: `policy.set{patch:{compaction:{keepTokens}}}`를 own-accounts가 받아 own 전역 설정 파일의 그 키만 고친다(jsonc 주석 보존, 8.2 5번의 설정 편집과 같은 방식). 다시 읽기는 config watcher가 한다. `policy.json`에는 저장하지 않는다. 설정 파일이 유일한 원본이다.
    - 범위: 4,000 ≤ keepTokens ≤ 60,000 ⚠(하한·상한은 초기값). 벗어나면 `setting_out_of_range{field:"compaction.keepTokens"}`.
    - `T_floor`(4.7.3)는 설정된 `K`로 다시 계산한다. 모든 slot을 다시 등록한다(3.8).
    - `cache.state.compaction.keepTokens`와 `policy.get`의 `compaction.keepTokens`는 **설정 파일에서 읽은 값**을 보고한다(프로젝트 설정의 덮어쓰기는 모른다, 4.7.2).
  - **(나) kind별 keep.** P-014(10장, 제안)를 열어야만 된다. 그 전에는 보수적 kind는 기준 자체를 낮춘다. `T_floor`(63k) 이상의 기준에서 keep 15k는 기준의 약 24% 이하이고, 256k 기준에서는 약 6%다.
  - 결정 전 기본은 keep 15k 그대로다.
- own 전역 설정에 `compaction.auto:false`, `compaction.buffer`를 두지 않는다. 03 §5.8.4의 전역 "자동 압축 [켜짐]" 토글을 끄면 overflow 복구까지 꺼진다(`compaction.ts:201-202`). 이 토글을 둘지는 03과 맞춘다(12장 Q13).
- `limit.output`, `limit.context`, `model.name`, variants를 바꾸지 않는다(D4, `core/src/variant.ts:45-47,72`). 바꾸는 것은 `limit.input`뿐이다(compat의 90%에서는 원래 창보다 클 수 있다, 4.7.3).
- 세션 값으로 core 자동 압축을 늦추거나 끄지 않는다.
- 설정 해석과 ⑫ 비용 비교는 `@own/protocol`의 순수 함수(`Compaction.resolve`, `Compaction.cycleCost`)로 두어 서버와 own-web이 같은 코드를 쓴다. 설정 화면의 미리 보기에는 새 RPC가 필요 없다.

#### 4.7.7 자리를 비운 사이 압축(사용자 결정 CC 2026-10-24)

사용자가 자리를 비운 동안 캐시가 식기 직전에 압축해, 돌아와서 보내는 첫 요청이 문맥 전체를 cold로 다시 쓰지 않고 체크포인트와 최근 부분만 쓰게 한다. own이 스스로 기준보다 일찍 압축하는 일이라 U6·07 P-D8과 다른 길이므로 **켜는 선택지이고 기본은 꺼짐**이다(`policy.compaction.idle.enabled`, 03 §5.8.4).

- **언제**: 마지막 기본 요청을 **보낸** 시각 + `TTL_lo`가 마감이다. 마감 30초 전(`CompactionCache.IDLE.leadSeconds`)에 타이머가 돈다. 세션 실행이 끝날 때 맞추고, 새 step·실행·압축이 시작하면 지운다.
- **어떤 캐시**: 수명이 `TTL_lo`에서 확실히 끝나는 것(`TTL_lo = TTL_hi > 0`, `CompactionCache.idleSuits`)만. 지금은 OpenAI API GPT-5.6 이후(30분)다. Anthropic API 키와 Claude 구독(5분)은 아래 "자리 비움 20분"을 채우지 못해 돌지 않는다. 1시간 모드(4.5, Phase 3)가 생기면 약 59분 30초 뒤에 돈다. ChatGPT(`codex`, `siwc`: 실제 수명을 모름), DeepSeek(보장이 없고 cold 비용이 작음)는 제외하고, 수명이 더 길거나 모르는 kind(oai 5.5 이하, xai, or, compat)는 규칙에서 빠진다.
- **돌 때의 조건**(모두 참): 설정이 켜져 있고 core `auto`가 켜짐, 마감 전(절전에서 깬 경우 건너뜀), 세션이 바쁘지 않고 압축 중이 아님, 대기 중인 inbox 항목·권한 질문이 없음, 전환 상태가 쉬는 중(STEADY·COOLDOWN·FAILED), 그 사이 새 기본 요청이 없었음, 그 사이 대화 트리가 다른 Claude 계정으로 옮기지 않았음(옮겼으면 그 계정에는 지킬 캐시가 없다, `account`, SL-8), 실행이 끝난 뒤 `minIdleMinutes`(기본 20분) 이상 지남, **화면에 띄워 둔 대화가 아님**(아래), 측정된 `P ≥ minTokens`(기본 100k), 하위 에이전트·팀(`own.team`)·가져온(`own.import`) 세션이 아님, 일하는 하위 에이전트(바쁜 하위 세션)가 없음, 구독 slot(Claude 구독, 구독 계정)의 한도 창이 80% 미만, 이 epoch에 아직 넣지 않음(`sess:<sid>:idleCompaction`).
- **읽는 중은 자리 비움이 아님(CC-14, CC-16).** 긴 답을 읽는 사용자는 아무것도 보내지 않는다. 클라이언트(own-web의 입력창)는 그 대화가 보이는 화면에 있고 지난 1분 안에 손댔으면 1분마다 `session.presence{sessionID}`(9.2, `read`)를 보낸다. 클라이언트는 따로 기다리는 시간을 두지 않는다. `policy.awayDetect`가 켜져 있으면(기본, `hiddenMinutes` 10) 마지막 신호 뒤 `hiddenMinutes`가 지나지 않은 대화는 건너뛴다(`present`). 그래서 창을 숨기거나 마지막으로 만진 뒤 `hiddenMinutes`(최대 1분 더)가 지나야 자리를 비운 것이다. 설정 화면의 글도 이 값을 읽는다. 신호를 보내지 않는 클라이언트뿐이면 위의 빈 시간만 본다.
- **어느 압축이 자리 비움 압축인가(CC-16).** 압축 hook이 그때 바로 본다. runner는 전달한 `/compact` 항목을 그 항목 id의 실행 중 압축 메시지로 먼저 저장하고 hook을 부르므로, hook은 대화 기록(`session.context`)의 실행 중 압축 id를 이 epoch 기록(`sess:<sid>:idleCompaction`)의 `inputID`와 비교한다. 같으면 자리 비움 압축이고 다르면 사용자의 `/compact`다. 이벤트가 어떤 순서로 오든, 서비스가 다시 시작한 뒤든 같다. 전달되기 전에 취소된 항목은 전달되지 않으니 표시될 일이 없다.
- **늦게 전달되면 버림(CC-16).** 넣은 항목이 마감(기록의 `deadline`) 뒤에야 전달되거나(넣은 뒤 서비스가 다시 시작한 경우 등, 캐시가 식음), 넣은 뒤 사용자가 돌아왔으면(그 대화에 프롬프트를 보냄, 또는 `awayDetect`가 켜져 있을 때 화면 신호) hook이 P-034 `cancel`로 요청 없이 끝낸다. 압축은 취소(`aborted`)로 남고 대화는 그대로다. ledger 이벤트 `compaction.idle`의 `outcome`이 `late` 또는 `returned`다.
- **넣기**: `compaction.due`와 같은 길(`SessionCompaction.compact`, 4.7.4)로 넣으므로 넣기 직전 staged revert를 확인한다. 연결된 클라이언트가 없어도 된다.
- **압축 요청**: own-accounts `compaction` hook이 metadata `own.compaction.trigger:"idle"`을 적는다. 캐시가 따뜻하므로 4.7.5의 규칙대로 읽는다: 대개 older 요청이 그대로 맞고, Anthropic에서 최근 부분이 lookback보다 길고 그 앞 항목이 식었을 수 있으면 전체 요청이다. 지금 이 압축이 도는 OpenAI GPT-5.6+는 전체 요청을 아직 보내지 않는다(`unmeasured`). own-harness는 이 압축에 대체 모델과 코드 요약을 두지 않는다. 실패하면 대화를 그대로 둔다.
- **기록과 표시**: ledger 이벤트 `compaction.idle`(넣을 때 `{outcome:"admitted", deadline, ttlMs, P}`, 버릴 때 `{outcome:"late"|"returned", deadline, P}`)과 압축 줄의 `compaction.trigger:"idle"`. 대화의 압축 표시와 압축 내용 창에 "자리를 비운 사이 압축했어요"(03 §4.5).
- **손익**: 압축 비용 C가 돌아왔을 때 아끼는 값보다 작으면 이득이다. Opus 5.5 200k: C ≈ $0.13, 돌아온 첫 요청 $1.00 → $0.18, 본전 복귀 확률 16%(600k 8%, gpt-6-astra 200k 21%). 돌아왔을 때 원문 대신 요약을 보는 손해는 값에 넣지 않았다(own/reports/cached-compaction-2026-10.md §4.5).
- **하지 않는 것**: Anthropic `max_tokens: 0` 유지 요청(keep-alive)은 승인되지 않았다(4.6 "keep-warm 없음" 그대로).

### 4.8 속도(Fast·Ultrafast, 사용자 결정 2026-10-06)

세션마다 고르는 속도다. 같은 모델을 더 빠르게 돌리고 더 많이 쓴다. 모델 전환이 아니라 요청 필드라서 프롬프트 바이트는 그대로다(4.3). 입력창의 `속도: 표준 | Fast | Ultrafast`(03 §4.6)가 고르고 루트 세션의 KV `sess:<root>:speed`(`Speed.State`, 2.4.6)에 둔다. 프리셋에는 두지 않고(07 U1) 새 대화는 언제나 표준에서 시작한다. 새 대화 화면과 전환기에서 첫 메시지 전에 고를 수 있고(아래 "새 대화와 전환기", 2026-10-10), 그 선택은 그 대화 하나에만 간다. 순수 규칙은 `@own/protocol` `Speed`, 나머지는 own-accounts `src/speed/`(`SessionSpeed`)다.

- **보내는 값**
  - OpenAI 계열(`codex`, `siwc`, `oai`): `context`·`compaction` hook에서 요청 옵션 `serviceTier`에 그 계정 목록의 tier id를 넣는다. core가 HTTP 본문과 WebSocket `response.create`에 `service_tier`로 보낸다(10.1 `open-responses-service-tier`). Fast는 `priority`, Ultrafast는 `ultrafast`다. API의 별칭 `fast`와 표준 `default`는 보내지 않는다. `generate`는 언제나 표준이다. Codex CLI가 함께 보내는 `x-codex-routing-hint: model=<slug>;tier=<tier>`는 보내지 않는다. Codex 소스에서 그 헤더는 tier 없이도 Codex 백엔드 요청마다 붙는 라우팅 힌트이고 tier를 고르는 것은 본문이기 때문이다(API 키 경로에는 헤더가 없다). 받은 tier로 확인한다(아래).
  - Anthropic(`anth`, Claude 구독 슬롯): core 옵션에 `speed`가 없어(10.1 `anthropic-options-no-speed`) `http.request` hook에서 본문에 `speed:"fast"`를 넣고 `anthropic-beta`에 `fast-mode-2026-02-01`을 덧붙인다. 그 헤더는 캐시 키의 일부라서 한 대화에서 처음 보낸 뒤에는 표준 요청에도 계속 붙인다(Claude Code와 같음). 모델이 바뀌거나 압축이 끝나면 뗀다(그때 prefix를 어차피 다시 쓴다). `title`·`generate`에는 붙이지 않는다.
  - 카탈로그 모드 항목(`<id>-fast`, `<id>-ultrafast`. core가 models.dev `experimental.modes`를 모델 하나로 등록함, 10.1 `models-dev-speed-modes`)은 프롬프트 prefix가 기본 모델과 달라서 own 화면의 선택지에서 뺀다. 이미 그 항목에 있는 세션은 그대로 돌고, 속도 단추는 `Fast 전용 모델`로 잠긴다.
- **쓸 수 있는 속도**(코드에 적지 않고 찾는다)
  - `codex`: Codex 모델 목록(`GET …/backend-api/codex/models?client_version=<v>`, 빌드 상수 0.164.0, 2026-10-19부터 더 새 Codex 릴리스가 있으면 그 버전. 07 §4.5 CA)의 `service_tiers[{id, name, description}]`(옛 `additional_speed_tiers`)를 **계정마다** 그 계정 토큰과 etag로 받아 `codex-meta.json` `accounts`에 둔다(모델 사실은 첫 계정의 `kinds.codex` 그대로). 그 계정 목록을 아직 못 받았으면 공유 스냅샷, 그다음 템플릿의 `-fast` 모드를 `unverified`로 보인다. `default_service_tier`는 쓰지 않는다(새 대화는 표준). `client_version` 0.157.0은 이 PC에 설치된 최신 Codex(2026-10-06 확인)다.
  - `siwc`: 계정 카탈로그(`GET /v1/models`, `accounts.test`마다와 프로세스마다 한 번)에 tier가 있으면 그것, 없으면 카탈로그 모드를 `unverified`로 보이고 거절 응답으로 배운다.
  - `oai`, `anth`: 카탈로그 모드(fold 스냅샷, 그다음 고정 템플릿). 가격은 모드 가격이다.
  - Claude 구독 슬롯: 카탈로그 모드(claude-auth가 비용을 0으로 바꾸기 전의 fold 스냅샷, I6)와 한 번만 받는 동의(KV `ack:claudeFast`: "요금제 한도가 아니라 추가 사용량으로 과금").
  - 그 밖의 kind는 없다.
    - DeepSeek(`ds`, 2026-10-24 문서와 실계정 확인, DS): 공식 API에는 어느 endpoint에도 빠른 tier가 없다. 가격표는 `deepseek-flash`·`deepseek-v4-pro`와 피크·비혼잡(반값) 요율뿐이고, 변경 기록(2026-04-24~10-17)에도 없다. Chat Completions에 `service_tier:"priority"`를 실으면 200으로 받되 무시한다(응답에 tier가 없고, 같은 `system_fingerprint`, 속도 관련 헤더 없음). Anthropic endpoint 문서는 `service_tier`를 Ignored, Responses API 문서는 Not supported로 적는다. `GET /models`의 모델 항목에도 tier 필드가 없다. 표준 `deepseek-flash`(생각 끔, 비혼잡)는 첫 토큰 0.55초, 출력 초당 293토큰이었다(`priority` 276). DeepSeek 앱의 "Fast Mode"는 Flash·Pro 모델 선택이었고 API tier가 아니다. 그래서 `ds`에는 Fast를 넣지 않는다. DeepSeek 자신의 API에 더 빠른 tier가 아예 없고, `service_tier`는 잰 대로 무시되기 때문이다. 근거는 `own/reports/ds-speed-2026-10-24.md`다.
      - 들은 "DeepSeek Ultrafast"는 Fireworks AI의 `accounts/fireworks/models/deepseek-v4p1-flash-ultrafast`일 가능성이 크다(docs.fireworks.ai/serverless/serverless-modes, 2026-10-24 확인). DeepSeek V4.1 Flash를 Fireworks의 Ultrafast 모드로 돌린다. 모델은 같고, 목표는 초당 1500토큰 이상이다. 요청 필드가 아니라 모델 id(`-ultrafast`)로 고르고, private preview라서 Fireworks에 접근을 신청해야 한다. own에서는 Fireworks 키, Base URL `https://api.fireworks.ai/inference/v1`, 그 모델 id로 만든 `compat` 계정(`기타 OpenAI 호환`)이다. 계정·모델이 따로라서 그리로 옮기면 캐시가 차갑고(4.3), 속도 단추의 tier가 아니다(`compat`은 `none:"kind"`).
      - OpenAI의 Ultrafast(`service_tier:"ultrafast"`)는 2026-08-13 GPT-5.6 Sol 제한 미리보기로 시작했고, GPT-6 Astra(2026-09-29)와 GPT-6.1 Sol(2026-10-08)에서 쓸 수 있다. own은 OpenAI 계열(`codex`, `siwc`, `oai`)에서 이미 고른다.
      - 다른 호스트의 DeepSeek 상품도 own에서는 `compat` 계정이다. DeepInfra는 `service_tier:"priority"`를 받는다. Telnyx의 Priority는 Kimi K2.6에만 있고, DeepSeek V4.1 Flash에는 더 느리고 싼 Flex(`service_tier:"flex"`)만 있다.
- **거절과 대체**(결정 6): tier가 실린 요청이 출력 전에 실패하면 `retry` hook이 판정한다(`SpeedRefusal`). OpenAI 계열은 tier를 말하는 4xx다(siwc `subscription_sharing_unsupported_capability`와 `param:"service_tier"` 포함, 401·429 제외). Codex는 받지 않는 tier에 HTTP 400 `{"detail":"Unsupported service_tier: <tier>"}`, WebSocket `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Unsupported service_tier: <tier>"}}`로 답한다(2026-10-18 실측): 이유 코드 `unsupported_tier`. Anthropic은 429·529(Fast 한도와 Fast가 없는 조직. 쿨다운은 1분 또는 `retry-after`부터, Fast 성공 없이 이어지면 두 배씩 최대 1시간)와 `speed`·추가 사용량을 말하는 4xx다. 그 계정·모델·tier를 표시하고(`runtime.speed`: 거절은 그 계정 목록을 다시 받을 때까지, 쿨다운은 끝날 때까지) 곧바로(`delay 0`) 다시 보낸다. 다음 요청은 Ultrafast → Fast → 표준으로 내려간다. 계정은 절대 바꾸지 않는다(R2/R4). 경보 `speed_fallback`과 `session.speed.changed{reason: fallback|cooldown}`을 내고, 쿨다운이 끝나면 `recovered`를 낸다. 거절 이유는 숨기지 않는다(CL, 2026-10-18): 경보 문구가 한국어 이유와 provider의 말(`fields.detail`, 응답의 `detail` 또는 `error.message`, 200자까지)을 싣고, `session.speed.changed{reason:"fallback"}`의 `cause`가 이유 코드를 실어 토스트가 `더 빠른 속도가 거절되어 Fast로 보내요(이 계정·모델에서는 지원하지 않는 속도예요). 계정은 그대로예요`처럼 말한다. 메뉴의 거절된 줄 설명도 offer `reason`으로 같은 이유를 보인다(`unsupported_tier`, 구독 공유 미지원, 크레딧 없음, `HTTP <n> 오류`).
- **받은 속도**: tier를 보낸 요청의 응답만 읽는다(OpenAI `response.service_tier`, Anthropic `usage.speed`. HTTP는 응답 사본을 백그라운드에서 끝까지 읽고 마지막 값, Codex WebSocket은 프레임마다 ledger 값을 고치되 판정은 끝 이벤트 `response.completed`·`response.incomplete`의 값으로 한다. `response.created`는 보낸 값을 그대로 돌려줄 수 있어서다). 보낸 것보다 느리게 처리됐으면(`default`, `standard`, `flex`, Ultrafast 요청의 `priority`) ledger 줄의 `speed.served`(7.5)와 화면의 회색 배지로 남고, 그 줄은 처리된 속도의 가격이다. 바꾼 뒤 첫 요청의 cache read로 그 kind의 tier 변경이 캐시를 남기는지 잰다(6.3 ⑬).
  - **ChatGPT 요금제는 받은 속도를 말하지 않는다**(codex CL 2026-10-18, siwc SW 2026-10-22): ChatGPT Codex 백엔드는 보낸 tier와 상관없이 `response.created`·`response.in_progress`에 `auto`, `response.completed`에 `default`를 싣는다(HTTP와 WebSocket 같음). 계정 01·`gpt-6-astra`에서 같은 800토큰 출력이 표준 58, `priority` 94(WebSocket 89), `ultrafast` 503(HTTP 헤더 힌트 없이 480, WebSocket 494) 토큰/초였다. 2026-10-22에 같은 로그인·`gpt-6.1-sol`·HTTP로 다시 재니 표준 61, `priority` 108, `ultrafast` 441(텍스트 delta 기준)이었고 답은 늘 `default`였다. tier는 그대로 처리됐고 `x-codex-routing-hint` 헤더도 필요 없었다. Codex CLI도 이 값을 읽지 않는다.
    - Sign in with ChatGPT(`siwc`)도 같다(SW, 2026-10-22). 사용자 세션 DB를 읽기 전용으로 열어(2026-10-10~22, 내용은 읽지 않고 시각과 토큰 수만) siwc step의 출력 속도(출력+추론 토큰 ÷ 첫 출력부터 끝까지, 400토큰 이상)를 쟀다. 보낸 tier는 ledger의 `speed.requested`로 짝지었다. 표준 `gpt-6-astra` 55개는 중앙값 38 토큰/초였고, Ultrafast `gpt-6-astra` 2개는 85·194, Ultrafast `gpt-6.1-sol` 19개는 중앙값 137(최대 395), Fast `gpt-6-astra` 3개는 13·56·56이었다. 그런데 Ultrafast·Fast로 보낸 63개의 답이 모두 `default`였다(3개는 tier를 말하지 않음). 토큰 공유 route도 tier를 처리하면서 그것을 말하지 않는다.
    - 그래서 판정은 kind가 아니라 ChatGPT 요금제 단위다(`Kind.isOAuth`: `codex`, `siwc`). 그 slot의 `auto`·`default`는 "말하지 않음"으로 읽는다(`SpeedWire.reported`): ledger `served:null`(보낸 tier로 과금), 회색 배지·`speed_downgraded`·아래의 `ignored` 판정이 없다. 응답이 더 빠른 tier 이름을 스스로 말할 때만(예: Ultrafast 요청에 `priority`) 판정한다. 2026-10-18 사용자 보고(01에서 Ultrafast가 Fast로, 이어 Fast가 표준으로 내려감)와 2026-10-22 보고(2.0.28-own.6, siwc 01–04에서 같은 일)가 이 오판이었다. 2026-10-18 보고도 siwc였다: 그날 ledger의 tier 요청 줄은 모두 siwc(Ultrafast 3번, 이어 Fast 3번, 모두 `default`)이고, 10월 ledger에 tier를 보낸 codex 줄은 없다. CL은 01을 codex로 가져와 codex 경로만 고쳤다. 진짜 거절(4xx)은 위 "거절과 대체"대로 이유와 함께 내려간다.
  - **알림은 한 번**(2026-10-10): 느린 처리가 이어지는 동안(그 계정·모델·tier, `runtime.speed.served`) 첫 번째만 경보 `speed_downgraded`와 `session.speed.changed{reason:"downgraded"}`(토스트 `provider가 이번 Ultrafast 요청을 더 느린 속도로 처리했습니다(그 속도의 요금). 혼잡하면 잠시 그럴 수 있습니다`)를 낸다. 그대로 처리된 응답이 오면 이어짐이 끝나고, 다음 느린 처리가 다시 첫 번째다.
  - **지원하지 않는 tier**(2026-10-10): 그 계정·모델에서 한 번도 그대로 처리된 적 없는 tier가 연달아 `Speed.IGNORED_AFTER`(3)번 느리게 처리되면 provider가 그 tier를 주지 않는 것으로 본다. 거절과 같게 `unavailable`(`reason:"ignored"`, 그 계정 목록을 다시 읽을 때까지)로 표시해 다음 요청이 Ultrafast → Fast → 표준으로 내려가고, 경보 `speed_fallback{reason:"ignored"}`와 `session.speed.changed{reason:"ignored"}`(토스트 `Ultrafast 요청이 계속 더 느리게 처리되어 Fast로 보냅니다. 이 계정·모델은 Ultrafast를 지원하지 않는 것 같습니다`)를 낸다. 고른 속도는 그대로라서 단추는 회색 `Ultrafast(을)를 지금 쓸 수 없어 Fast(으)로 보냅니다`다. 한 번이라도 그대로 처리된 tier는 이렇게 표시하지 않는다(혼잡이나 Fast 증가 한도로 잠시 표준 처리되는 경우). 표준 처리된 요청은 표준 요금이라 세 번의 시도는 돈을 더 쓰지 않는다. 계정은 바꾸지 않는다(R2/R4).
  - 근거(사용자 보고, 2.0.24-own.2): Sign in with ChatGPT 계정의 `gpt-6.1-sol` 대화에서 중간에 Ultrafast로 바꾼 뒤 31개 step이 모두 `service_tier:"ultrafast"`로 나가 `default`로 돌아왔고(ledger `speed`, 응답 하나는 tier를 말하지 않음), 출력 속도도 대부분 초당 수십 토큰(가장 빠른 step도 약 130)으로 표준과 같았다. 계정 카탈로그(`GET /v1/models`)는 그 모델에 Ultrafast를 적어 `basis:"account"`, `available`로 보였다. 비교는 맞았고(표준 처리를 표준으로 읽음) 문제는 매 step 같은 토스트가 뜨고 Fast로 내려가지 않은 것이었다. 그 계정이 Ultrafast를 실제로 받는지(요금제, token sharing 경로)는 `own/scripts/speed-tier-probe.ts`로 사용자가 확인한다(`own/reports/speed-live-checks.md` 4). → SW(2026-10-22)에서 고쳐 읽음: 그 `default`는 처리된 속도가 아니었다. 가장 빠른 step의 약 130 토큰/초는 표준의 출력 속도보다 높고, 같은 계정의 그 뒤 세션도 위처럼 표준보다 빨랐다. "비교는 맞았다"는 틀린 결론이었다.
- **하위 에이전트**(07 §2.10, Codex와 같음): 루트의 실제 속도를, 자식이 루트 메인과 같은 계정에 있고 자식 모델 목록에 같은 속도가 있을 때만 물려받는다. `메인과 같게`, 같은 계정의 가벼운 모델, 같은 계정의 고정 대상이 여기에 든다. 다른 계정·프로바이더는 절대 물려받지 않는다. 더 느린 속도로 내려가지 않는다(없으면 표준).
- **팀 모드**(06 §10.1): 속도는 대화마다다. `팀과 같게`는 모델과 강도만 따르고 속도를 복사하지 않으며, 담당 교체로 만든 담당 대화도 표준으로 시작한다. `모든 영역 Fast` 동작은 두지 않았다(영역마다 계정·비용 창·동의가 달라 작지 않음).
- **비용 창**(6.3 ⑬): `session.speed.set{dryRun}`의 `change`. 속도는 문맥 한도를 바꾸지 않는다(R8). ⚠ 실계정 확인 세 가지는 `own/reports/speed-live-checks.md`다.
- **새 대화와 전환기(사용자 결정 2026-10-10).** 사용자 보고: 새 대화에서 DeepSeek으로 시작했다가 ChatGPT로 바꾸면 첫 메시지 전에 속도를 고를 곳이 없고, 대화를 시작한 뒤에도 속도 단추가 나오지 않을 때가 있었다.
  - 세션 없이 메인(계정 provider와 모델)의 속도를 묻는 `speed.offers`(9.2)를 둔다. 새 대화 입력창과 전환기의 `속도` 줄은 화면의 대상이 바뀔 때마다(계정·모델) 그것을 다시 읽는다. own-web은 대상마다 참조 수로 보고(`watchSpeedOffers`), 다시 연결·`accounts.changed`·`plugin.status`·`session.speed.changed`에 다시 읽는다.
  - 새 대화의 선택은 서버마다 하나인 대기 값이다. 대화를 만든 뒤 시작 프리셋 다음, 첫 프롬프트 전에 그 대상이 그 속도를 주면 `session.speed.set`으로 적용하고(Claude 구독은 고를 때 동의 카드를 먼저 거침), 다음 새 대화는 다시 표준이다. 아직 캐시가 없으므로 비용 창은 없다(배지가 배수·가격을 보인다).
  - 낙관적 생성 경쟁: 입력창은 서버가 세션을 만들기 전에 그 세션으로 이동하므로 첫 `session.speed.get`이 모르는 세션을 묻는다. 서비스는 그럴듯한 빈 보기 대신 `none:"session"`으로 답하고, own-web은 `session.created`에서(바인딩처럼) 그 보기와 프리셋 보기를 다시 읽는다. 대화 생성이 끝난 뒤에도 한 번 더 읽는다(`refreshSpeed`).
  - 더 빠른 속도가 없는 메인도 단추를 숨기지 않고 회색으로 두며 이유를 보인다: `View.none`/`Targeted.none` = `provider`(own이 다루지 않는 provider, Claude 슬롯 없음), `kind`(DeepSeek·xAI·OpenRouter·compat처럼 tier가 없는 종류), `model`(이 계정·모델 목록에 지금 더 빠른 tier가 없음. Priority가 없는 요금제), `session`(위 경쟁). 거절된(`unavailable`)·쉬는 중인 제안은 메뉴에서 빼지 않고 이유와 함께 흐리게 둔다.
  - 전환기에서 모델과 속도를 함께 바꾸면 전환이 먼저이고, 그 세션이 새 메인으로 바뀐 뒤 새로 읽은 보기로 같은 `session.speed.set{dryRun}`·비용 창·동의를 거친다(10분 안에 그 메인이 되지 않으면 버림).

### 4.9 출력 상한(사용자 결정 2026-10-19, OL)

한 번 답할 때 생각과 답을 합쳐 넘지 않을 양이다(요청 옵션 `maxTokens`, 회사마다 `max_tokens`·`max_output_tokens`·`max_completion_tokens`). 문맥 창(읽을 수 있는 양)과 다르다. 사용자 결정: 지금 동작을 기본으로 두고 이해할 수 있는 설정으로 만든다("코어 수정을 하면서 설정값으로", P-032). 결정 기록은 `own/handoff/decisions-2026-10.md` OL이다.

- **core 기본(바꾸지 않음)**: `core/src/session/model-request.ts` outputLimit. 메인과 요약 요청에 min(카탈로그 출력 한도(없으면 32,000), 256,000)을 넣고, 프롬프트가 남긴 자리(문맥 창 − 측정값 − ceil(추정값 × 1.15), 최소 1,024)에 맞춘다. 요약은 32,000도 넘지 않는다. 제목과 `generate`에는 넣지 않는다(회사 기본).
- **설정**: `policy.outputLimit`(2.4.3, `OutputLimit.Setting`) 하나다. 서비스마다 하나이고 정책 미러로 SSH 원격 호스트도 같은 값을 쓴다. 03 §5.7.4가 화면이다.
  - `cap` `이 값을 넘기지 않기`(기본, 256,000 = core 상한 `OutputLimit.CORE_CAP`): min(`outputCeiling`, 사용자 값). `outputCeiling`은 core가 256,000 상한 없이 낸 같은 값이다(모델 출력 한도를 남은 자리에 맞춘 것, P-032). 그래서 256,000 아래로는 core 값을 그대로 낮추고, 위로는 DeepSeek V4(393,216)처럼 출력이 큰 모델이 끝까지 쓸 수 있다. 모델 한도를 넘는 요청은 나가지 않는다.
  - 범위는 4,096–1,000,000이다. 아래로는 생각하는 모델이 답할 자리가 없다(Claude의 생각 예산은 1,024 이상이고 한도보다 작아야 한다). 위로는 어느 모델의 한도보다 커서 뜻이 없다. 밖이면 `setting_out_of_range`(9.2).
  - `omit` `출력 상한 보내지 않기`: 보내지 않으므로 모델이나 회사 기본이 정한다. 수는 기억만 한다(다시 `cap`을 고르면 그 수).
- **적용 위치**: own-accounts `context` hook의 맨 앞(`auth/output-limit.ts`), 모든 provider(Claude 구독 슬롯 `anthropic`과 내장 provider 포함). 그 뒤의 own slot 형성(4.1)이 kind 규칙을 그대로 적용한다. 요약(`compaction`)은 core의 32,000 상한을, 제목과 `generate`는 지금 값을 그대로 쓴다. 기본값이면 아무것도 바꾸지 않는다. 앞선 hook이 지운 한도(upstream `openai` provider)는 지운 채로 둔다. upstream v2.0.32(ae8d59f8b5)부터 요약 요청은 hook 뒤에 core가 실제로 보내는 요청이 창에 남긴 자리로 한 번 더 낮춘다(`fitOutput`, 최소 1,024. 한도를 새로 넣거나 올리지 않으므로 한도가 없는 codex·oai·or 요청은 그대로). 기록을 더 줄일 수 없는 큰 대화에서 Claude·DeepSeek이 입력 + `max_tokens` > 창으로 거절하던 경우다. own 하네스의 요약 문구(P-025)도 같은 맞춤을 받는다.
- **잘린 답(upstream v2.0.32, a3f7f42ac9)**: 답이 상한에 걸려 `length`로 끝나면 core가 숨은 synthetic 메시지("Break the remaining work into smaller pieces", 화면에 보이지 않음)로 다음 step을 부른다. 인자가 끝나지 않은 도구 호출은 실행하지 않고, 인자 앞 2,048자와 함께 `tool.input-incomplete`로 모델에 돌려준다. 세 답이 연달아 잘리면 턴이 `output-limit` 오류로 끝난다. 그래서 상한을 아주 낮게 잡으면(예: 4,096) 긴 답이나 큰 파일 쓰기에서 이 오류가 날 수 있다. 이어 부르기는 기록 뒤에 붙을 뿐이라 prompt cache는 그대로다. ChatGPT 계열(codex·siwc·oai)은 한도를 보내지 않아 거의 겪지 않는다. own-accounts 경보 `output_truncated`(7.7)는 잘릴 때마다(중복 제거 창 안에서 한 번) 알린다.
- **`보내지 않기`에서 회사마다 되는 일**

| 대상 | 보내는 것 | 이유 |
|---|---|---|
| Claude(`anthropic` 슬롯, `anth`) | min(32,000, `outputCeiling`) | Messages API는 `max_tokens`가 필수다. 비어 있으면 어댑터가 32,000(`DEFAULT_MAX_TOKENS`, 10.1 `anthropic-default-max-tokens`)을 채우지만 모델 최대와 남은 자리에 맞추지 않으므로 own이 맞춰 보낸다(출력이 작은 모델이 400을 받지 않게) |
| DeepSeek(`ds`) 생각 켬 | 없음 | 서버 기본 64K(노력 `max`는 128K). 최대 393,216(DeepSeek API 문서, 2026-10-19 확인) |
| DeepSeek 생각 끔(`none`) | min(65,536, `outputCeiling`) | 서버 기본 8K가 긴 답과 파일 쓰기를 조용히 자른다(결정 D2, external-repos P0-4 option C) |
| ChatGPT(`codex`), Sign in with ChatGPT(`siwc`), `oai`, `or`, 내장 `openai` | 없음(설정과 상관없음) | 4.1: ChatGPT 백엔드와 토큰 공유 route는 거절하고, OpenAI는 요청량만큼 분당 토큰 한도를 미리 세며, OpenRouter는 그만큼 잔액을 미리 잡는다 |
| xAI, compat, 그 밖의 내장 provider | 없음 | Chat Completions·Responses 어댑터는 값이 없으면 필드를 뺀다(10.1 `openai-chat-absent-max-tokens`). 서버 기본(보통 모델 최대나 남은 창)을 쓴다 |

- **창이 거의 찼을 때(결정)**: `이 값을 넘기지 않기`는 지금처럼 남은 자리에 맞춘다. `보내지 않기`는 보내지 않는 요청을 맞추지 않는다. 보내지 않은 요청은 남은 자리보다 많이 달라는 요청이 아니고, 서버가 자기 기본값을 자기 창 안에서 정한다(vLLM은 창 − 프롬프트, Ollama·llama.cpp는 문맥 끝까지, OpenAI는 창 끝에서 멈춤). 값을 대신 채우는 두 경우(Claude 32,000, DeepSeek 생각 끔 65,536)만 남은 자리에 맞춘다. 프롬프트 + 요청 출력이 창을 넘으면 거절하는 서버가 있기 때문이다(Claude 4.1 이하는 400, 4.5부터는 `model_context_window_exceeded`로 멈춤). 자동 압축 기준(창 − max(10%, 16k), 4.7)이 보통 그 전에 압축한다.
- **캐시**: `maxTokens`는 요청 옵션이고 프롬프트 바이트가 아니다(4.3). own의 prefix 지문(7.8.1)과 toolset 지문(D10)은 system·tools·messages만 보고, 회사의 prompt cache도 prefix만 본다. Codex WebSocket 이어 쓰기(`ai/src/protocols/open-responses-continuation.ts`)는 `input` 밖의 필드가 같아야 이어 쓰고 `max_output_tokens`도 그 비교에 들지만, codex에는 어느 쪽이든 보내지 않아 영향이 없다. 예외 하나: 생각 예산을 직접 정하는 Claude 모델(`thinking.type:"enabled"`, 4.5 이하와 Haiku 4.5)은 어댑터가 예산을 `max_tokens`의 절반 아래로 줄인다(`fitThinking`). 그래서 설정을 바꾸면 그런 대화는 다음 요청에서 생각 설정이 바뀌어 메시지 캐시를 한 번 다시 쓴다(시스템·도구 캐시는 남음. 예: Sonnet 4.5 `max` 31,999 → `보내지 않기` 16,000). 설정 화면이 이것을 한 줄로 알린다. 4.6부터의 adaptive thinking에는 예산이 없어 영향이 없다.
- **하네스**: own의 codex 하네스는 출력 한도를 따로 정하지 않는다. ChatGPT·OpenAI 계열 대상이면 Codex CLI처럼 보내지 않고(Codex CLI의 `ResponsesApiRequest`에는 `max_output_tokens` 필드가 없다, `refs/codex` `codex-rs/codex-api/src/common.rs`), 다른 회사 모델이면 이 설정을 따른다. 바꾸지 않았다. DeepSeek 하네스(dsh, 13장)도 자체 기본값을 두지 않고 이 설정을 따른다(13 §2.4, 결정 DH-5).
- **범위**: 전역 하나다. 회사마다 다른 것은 `보내지 않기`의 결과뿐이라 회사·모델별 덮어쓰기는 두지 않았다. 필요해지면 `policy.outputLimit.byKind`로 더한다.
- **검증**: own-accounts `test/auth/output-limit-setting.test.ts`(형성, `policy.set`)와 `test/auth/output-limit.e2e.test.ts`(실서버, 가짜 Anthropic·DeepSeek·OpenAI·Codex가 받은 본문), core `test/session-output-ceiling.test.ts`(P-032), own-protocol `test/output-limit.test.ts`, own-web `src/settings/output-limit.test.ts`와 `e2e/output-limit.spec.ts`.

---

## 5. 전환 상태 머신

### 5.1 전환의 종류

대상은 언제나 `Model.Ref {providerID, id, variant?}` 하나다. 다음 세 종류를 모두 같은 머신으로 처리한다.

| 종류 | 예 | 캐시 영향 |
|---|---|---|
| 계정 전환 | `own-codex-7k2m/gpt-5.5#high` → `own-codex-p1q2/gpt-5.5#high` | 도메인이 다르면 대상 prefix 전체가 cold다. 같은 도메인이면 D9 덕분에 `Z + u_1`까지만 재사용할 수 있다. 첫 assistant부터는 A의 메타데이터가 빠져 갈라진다(6.3 ①) |
| 프로바이더·모델 전환 | → `own-anth-w3p8/claude-opus-5-5#high` | system[0](Optimize)과 tools(patch↔edit/write)가 달라 처음부터 cold다(`optimize.ts:15-29`, `patch.ts:297-305`) |
| variant만 변경 | `#high` → `#medium` | 메시지 단위 effort 갱신을 지원하는 경로에서 두 variant가 모두 effort 단계(`low`/`medium`/`high` 등)일 때만 캐시가 유지된다. 지원 경로: Anthropic Claude Opus 5 이상·Fable/Mythos 5.1 이상(`ai/src/protocols/anthropic-messages.ts:1007-1015`), OpenAI Responses `gpt-6-astra\|sol\|luna`(pro 모드와 `contextManagement` 요청 제외, `openai-responses.ts:146-155`). 단 siwc는 같은 모델이어도 지원하지 않는 경로다(`configuration_update` 거절, 3.2c "입력 항목"). 그 밖(GPT-5.x, DeepSeek, xAI, 이전 Claude, `default`나 effort가 아닌 variant, `to-llm-message.ts:233-248`)은 prefix 전체 재작성이다(`ai/src/effort-updates.ts:1-2,16-17`). 과거 effort marker가 요청 effort와 어긋나면 marker가 모두 지워져 prefix 중간부터 다시 쓴다(`effort-updates.ts:20-25`). 판정 결과는 `switch.estimate`의 `variantOnly`(9.2)로 낸다 |

### 5.2 트리거와 분류

**트리거는 세 가지뿐이다.**
- **T-MANUAL**: 사용자
- **T-HARD**: hard 한도 소진, 또는 모델 사용 불가
- **T-AUTH**: refresh를 한 번 해도 401/403

**트리거가 아닌 것**: 일시적 429·529·5xx(같은 계정에서 대기), 사용률 임계값(권고만), 비용 차이(제안만). opencodex #4546 교훈이다[R-verify community].
- 멈춘 스트림도 트리거가 아니다(코어 패치 P-018). keepalive나 `response.in_progress`만 오고 진전이 없는 스트림, 도구 입력이 2분 넘게 자라지 않는 스트림, 15분을 넘긴 Responses 시도, ChatGPT 백엔드의 `request_timeout`은 모두 재시도 가능한 read timeout이 되어 같은 계정에서 재시도(출력 전)하거나 이어 한다(출력 뒤). timeout 재시도는 최대 3회이고 그 뒤에는 턴 오류로 남는다(03 §4.5 `이어서`). compat slot은 chunk timeout을 끈 채 등록하므로 이 감시도 기본으로 꺼진다. 다만 SSE 주석(`: keep-alive`)만 5분 동안 온 응답은 compat slot에서도 같은 재시도 가능한 read timeout으로 끊는다(2026-11-27, RL31): 줄 서 있는 요청을 붙잡고 있을 뿐이기 때문이다. 아무 바이트도 없는 침묵은 로컬 서버가 긴 프롬프트를 읽는 중일 수 있어 그대로 기다린다.

**kind별 오류 분류**

| kind | hard(전환 사유) | transient(같은 계정에서 대기) |
|---|---|---|
| codex | 429이면서 본문 `usage_limit_reached` 또는 "usage limit". core는 429에서 QUOTA_TEXT를 보고 QuotaExceeded로 분류한다(`provider-error.ts:106,162-167`). 또는 헤더 `x-codex-rate-limit-reached-type`가 있거나(`[R-codex-rl]` 188), 최근 스냅샷의 primary/secondary 사용률이 100 이상 | 그 밖의 429(retry-after), 5xx |
| siwc | 상태 코드보다 오류 코드를 먼저 본다(3.2c `Classify.SHARING_CODES`, 옛 `_v2_` 이름 포함). `subscription_sharing_usage_limit_exceeded`(429), `subscription_sharing_user_not_eligible`(403). core는 이 429를 재시도하므로 retry hook이 `retry:false`로 막는다. 리셋 시각은 응답이 준 값만 쓴다. `invalid_user`와 `chatpass_v2_*`는 곧바로 T-AUTH(`needs_reauth`)다 | `subscription_sharing_usage_unavailable`, `subscription_sharing_user_unavailable`(503) |
| oai | 429 `insufficient_quota`(`provider-error.ts:63-70`), 402 | 429 `rate_limit_exceeded` |
| anth | 429 `enforced_spend_limit_reached`(org 지출 상한). core는 RateLimit으로 분류해 최대 10회 재시도하므로 **우리 retry hook이 hard로 덮어쓴다**. 400 "workspace API usage limits"(그 workspace만)[R-verify #4] | 429 `rate_limit_error` + retry-after, 529 |
| ds | 402(잔액 부족) | 429, 503 |
| xai | 402/403 credits ⚠ | 429 |
| or | 402. 단 본문이 "This request requires more credits, or fewer max_tokens. … can only afford N"이고 N이 1,024(core의 최소 출력 한도) 이상이면 소진이 아니다: 잔액이 요청한 출력 한도의 값보다 적을 뿐이다. `unknown`(`max_tokens_unaffordable`)으로 두고 계정을 소진으로 두지 않는다(2026-10-08). 이 문구는 모든 kind에서 같게 본다. N이 없거나 1,024보다 작으면(음수 잔액 포함) 소진이다. 같은 계정에서 10분 안에 다시 오면(그 사이 성공 없이, `Telemetry.UNAFFORDABLE_REPEAT_MS`) 아무것도 요청 출력을 줄이지 않는 것이므로 `hard`(`max_tokens_unaffordable`, 가장 짧은 대기 15분)로 올려 전환이 움직이게 한다. own은 or에 출력 한도를 보내지 않지만(`NO_OUTPUT_LIMIT`) OpenRouter가 한도 없는 요청에 모델 기본 최대 출력을 잡는지는 실계정(잔액 적은 계정)으로 확인하지 않았다 | 429 |
| claude 슬롯 | unified status `rejected`, 또는 5h/7d status `rejected`. retry-after가 15분을 넘는 429. 모델별 주간 묶음(7.3)의 거절(`7d_oi-status: rejected`, 또는 `status: rejected`이고 `representative-claim`이 `seven_day_overage_included`·`seven_day_opus`·`seven_day_sonnet`)은 그 묶음의 소진이다(그 모델 묶음만, 아래 소진 기록) | `allowed_warning`(경고만), 529 |
| 공통 | 401/403: 한 번 refresh 후에도 실패하면 T-AUTH(`provider-error.ts:168-169`) | |

- **분류 주체**: own slot은 own-accounts의 retry hook(4.1, 01 §14.3), `anthropic`(Claude 슬롯)은 own-telemetry의 retry hook(8.8)이다. 결과(`{accountID, windowId, until, class}`)를 `own-runtime`에 올리고, own-accounts 상태 머신이 그것을 보고 5.9(g)의 계획을 세운다.
- **재료 헤더**: retry 이벤트에는 `{type, message, status}`와, upstream c14a1f5acf부터 provider의 응답 본문 `response.body`가 있다(`schema/src/session-error.ts`, `core/src/session/to-session-error.ts` providerError). 헤더는 없다. 그래서 같은 세션의 마지막 응답 캡처(own slot은 own-accounts `http.response`/`ws.receive`, `anthropic`은 own-telemetry `http.response`)의 헤더와 본문 앞부분(최대 2KB, 30초 이내)을 함께 본다. 캡처가 없으면(30초가 지났거나 잡지 못함) 오류의 `response.body` 앞 2KB를 본문으로 읽는다(`Classify.BODY_HEAD_CHARS`, 2026-10-08). upstream은 토큰 공유 오류의 `message`를 친절한 문구로 바꾸고 코드는 본문에만 남기므로, siwc 코드 판정은 이 본문에 기댄다. 리셋 헤더(`retry-after`)는 여전히 캡처에서만 온다. 원장 P-004(candidate)가 바라던 것 중 본문은 이렇게 upstream에 들어왔다.
- **재시도 상한(소스 확인)**: core는 최대 10회, 간격 2초에서 10초까지, `retry-after`는 회당 15분까지 따른다(`core/src/session/runner/retry.ts:66-89`). hard를 늦게 판정하면 한 턴이 오래 멈춘다(8.8).
- **quota domain 전파**
  - org 지출 상한처럼 quota domain 단위의 hard는 그 domain의 모든 계정을 `exhausted`로 둔다.
  - workspace 한도는 그 workspace 계정만 `exhausted`로 둔다.
- **소진 기록**: `{accountID, windowId, until}`. `until`은 `resetAt + 1~3분 지터`이고, `resetAt`을 모르면 15분, 30분, 60분 순으로 늘린다. 다른 세션에서 성공 응답이 오면 즉시 해제한다.
  - 모델별 주간 묶음의 기록(LV 2026-10-24): 거절한 창(`Unified.rejected`: 제품군 자신의 `-status`가 먼저, 계정 전체 창 `5h`·`7d`가 `7d_oi`보다 먼저, 없으면 `representative-claim`이 가리키는 창)이 모델별 주간 묶음이면 `windowId`가 그 묶음이고, 그 기록은 그 모델 묶음의 요청만 막는다(`LimitModel.accountWide`). `until`은 그 묶음의 리셋(Opus·Sonnet 주간은 최상위 `reset`), 없으면 retry-after, 그것도 없으면 백오프 15분이다. 예전에는 묶음의 거절을 창 없는 계정 전체 기록(백오프 15분)으로 남겨, 5일 뒤 리셋되는 Opus 주간에 막힌 대화가 약 17분 뒤 `계속`을 보내 다시 거절됐고 같은 계정의 Sonnet 대화도 막혔다.
  - 계정마다 계정 전체 기록 하나와 묶음마다 기록 하나를 따로 둔다(`Limits.Store`): 서로 덮어쓰지 않는다. 모델을 묻는 판정(`exhaustion(accountID, model)`)은 계정 전체 기록과 그 모델 묶음의 기록을 보고(둘 다면 더 늦게 풀리는 것), 모델 없는 판정은 계정 전체 기록만 본다. 성공 응답은 계정 전체 기록과 그 응답 모델의 묶음 기록만 해제한다: Sonnet 성공은 Opus 주간 기록을 지우지 않는다.
  - 계정 상태로 알리는 것은 계정 전체 기록뿐이다: `account.status{exhausted}`(9.3)와 `quota.snapshot`의 `exhausted`(9.2)에는 묶음 기록이 없다. 그래서 휴대폰 알림 `quota.exhausted`(05 §13.6)도 계정 전체 한도에서만 온다. 다른 모델은 그대로 쓸 수 있으므로 계정을 한도 도달로 알리지 않는 것이다. 거절된 대화는 자기 전환 상태(5.9(g), BLOCKED·PLANNED)로 안다.

### 5.3 safe point(유휴에서만 전환)

- **safe point**는 두 가지다.
  - (a) 세션이 idle이다(실행 중 execution 없음).
  - (b) `inTurnFailover=true`이고, 출력이 하나도 나오기 전에 실패한 step이 retry hook에서 결정을 기다리는 중이다.
- **스트리밍 중에는 절대 바꾸지 않는다.**
  - `switch.apply{strategy:"now"}`가 busy 세션에 오면 보류로 바꾸고, 다음 safe point에 적용한다. 03 §6.3의 "다음 턴부터 적용"이 이것이다.
  - 모델 확정은 step마다 일어난다(`specs/v2/session.md:72`, `llm.ts:213-243`). 그래서 턴 중간에 `switchModel`하면 턴 도중에 계정이 바뀐다.
- **idle 판정**: own-accounts가 `session.execution.started` 뒤 짝이 맞는 `succeeded`/`failed`/`interrupted`가 왔는지로 세션마다 추적한다(`schema/src/session-event.ts:243-257`). 재시작 직후에는 `ctx.session.get`의 상태로 초기화한다.
- **적용 방법**
  1. idle이고 입력이 없으면: `await ctx.session.wait({sessionID})` 뒤 `ctx.session.switchModel({sessionID, model})`을 부른다(`core/src/plugin/host.ts:533,549`). Ref가 같으면 no-op이다(`session.ts:97-109`).
     - 실행 중인 턴이 끝나면(`execution.succeeded/failed/interrupted`) own-accounts가 곧바로 보류 전환(WAIT_SAFE)을 이 방법으로 적용한다.
  2. 다음 prompt admission 때: `prompt` hook에서 처리한다. **hook 안의 `switchModel`은 AC-P26(= 01 G8b) 통과 전까지 꺼 둔다**(01 §8.3·§8.5).
     - `prompt` hook은 **모든 admission**에서 불린다. 기본 `delivery`는 `"steer"`라서 busy 세션에 온 메시지도 여기를 지난다(`core/src/session/prompt.ts:40-51`).
     - 그리고 `switchModel`은 `ModelSelected`를 조건 없이 바로 발행하고(`session.ts:97-109`), 실행 중인 턴은 다음 step·attempt에서 모델을 다시 읽는다(`core/src/session/runner/llm.ts:215`). 그래서 busy 세션에서 여기서 전환하면 **턴 도중에 계정이 바뀐다.** 같은 세션의 admission 중에 부른 `switchModel`이 runner와 경합하거나 막히는지도 확인되지 않았다(`plugin/src/promise/session.ts:14-20`).
     - **AC-P26 통과 전(기본)**: 이 hook은 `switchModel`을 부르지 않는다. 보류 전환은 방법 1(idle 경로)과 방법 3(own-web 전송 경로)으로만 적용한다. hook이 하는 일은 busy 세션에 온 메시지의 `event.delivery`를 `"queue"`로 바꾸는 것뿐이다. core는 hook이 바꾼 `delivery`를 쓴다(`prompt.ts:88`). 그러면 메시지는 steer되지 않고 현재 턴이 끝난 뒤 새 턴으로 실행된다. `session.created`를 놓친 미고정 세션의 고정(01 §8.5)도 이 hook에서 하지 않고 idle 경로와 own-web 전송 경로로만 한다.
     - **AC-P26 통과 뒤**: **세션이 idle일 때만** 이 hook에서 보류 전환을 적용하고 미고정 세션을 고정한다. busy면 WAIT_SAFE를 그대로 두고 `delivery`를 `"queue"`로 바꾸는 규칙은 같다.
     - 순서 보장: 현재 턴이 끝나면 방법 1이 전환을 적용하고, 그다음 큐의 메시지가 새 턴을 시작해야 한다. 큐 메시지의 첫 step이 전환보다 먼저 시작되는 경합이 있는지는 AC-P26 (d)에서 확인한다.
  3. own-web 전송 경로
     - idle 세션: `switch.apply`를 부른 뒤 `POST /prompt`를 순서대로 보낸다. 업스트림 app도 전송 직전에 `switchModel`을 부른다(`app/src/composer/submit.ts:355-373`).
     - WAIT_SAFE가 걸린 busy 세션: 후속 메시지를 `delivery:"queue"`로 보내고, 입력창에 `현재 턴이 끝난 뒤 B로 실행` 칩을 보인다. 이 표시가 없으면 사용자는 메시지가 옛 계정으로 steer될 것을 알 수 없다.
     - AC-P26의 경합 검사가 실패하면: own-web은 메시지를 클라이언트에 잡아 두었다가 `binding.changed`를 받은 뒤 보낸다. 다른 클라이언트(TUI 등)는 방법 2의 queue 변환만 적용된다.
     - idle 세션에 WAIT_SAFE가 남아 있는 틈(방법 1이 적용하기 직전)에 다른 클라이언트가 보낸 메시지는, AC-P26 통과 전에는 옛 계정으로 실행될 수 있다. own-web은 방법 3을 쓰므로 해당하지 않는다.

### 5.4 상태

```
                ┌──────────── T-MANUAL / T-HARD / T-AUTH ────────────┐
                ▼                                                    │
 STEADY ──► PLANNED ──(확인 또는 정책 auto)──► WAIT_SAFE ──► SWITCHING ──► COOLDOWN ──► STEADY
   ▲          │                                  ▲    ▲           │
   │          ├─ compact-then-switch ─► COMPACTING ┘    │           └─ model.selected 미확인 30초 ─► FAILED
   │          ├─ cold-point ──────────► SCHEDULED ──────┘ (cold point 도달)
   │          ├─ fork / new-session ──► DELEGATED (새 세션이 STEADY로 시작, 원 세션은 STEADY)
   │          └─ cancel / 만료 ────────► STEADY
   └───────── BLOCKED (대상 없음) ── 리셋·계정 추가·사용자 선택 ──► PLANNED
                 └─ waitReset(하위 상태) ── resumeAt 도달 ──► ctx.session.prompt(message) ──► STEADY
```

| 상태 | 필드 | 들어오는 조건 | 나가는 조건 |
|---|---|---|---|
| STEADY | `slot` | 기본 상태 | 트리거 |
| PLANNED | `estimateID, target, options[], reason, expiresAt(+5분)` | `switch.estimate` 또는 자동 계획 | apply, cancel, 만료 |
| WAIT_SAFE | `target, strategy, reason, accountID?` | apply했는데 busy | safe point → SWITCHING |
| COMPACTING | `target, requestedAt, timeout(10분), accountID?` | compact-then-switch | `compaction.ended`나 문맥 비우기의 전달(4.7.4) → WAIT_SAFE. `compaction.failed`나 타임아웃 → PLANNED + 경보 |
| SCHEDULED | `target, trigger:"compaction"\|"idle_ttl"\|"either", idleMinutes, uncertain, deadline, accountID?` | cold-point 선택 | cold point 도달 → WAIT_SAFE. deadline → PLANNED(다시 묻기). 사용자 메시지 → 유휴 시계 재시작(03 §6.3) |
| SWITCHING | `target, issuedAt, accountID?` | `switchModel` 호출 | `session.model.selected` 수신 → COOLDOWN. 30초 안에 확인이 없으면 FAILED |
| COOLDOWN | `until, requestsLeft` | 전환 완료 | 30분이 지나고 20요청을 넘기면(둘 중 늦은 쪽) → STEADY |
| BLOCKED | `reason, nextResetAt, waitReset?:{resumeAt, message}` | 정당한 대상이 없음(모두 소진·인증 실패) | 리셋, 계정 추가, 사용자 선택. `waitReset`이 있으면 `resumeAt`에 `ctx.session.prompt(message)`를 보내고 STEADY |
| DELEGATED | `childSessionID` | fork 또는 new-session | 즉시 STEADY(원 세션) |
| FAILED | `error` | 전환 확인 실패 | 사용자 재시도 |

- **SCHEDULED의 값**
  - `idleMinutes`: 소스 도메인의 `TTL_hi`(분). 모르면(codex 등) `policy.thresholds.unknownTtlIdleMinutes`(기본 60)를 쓰고 `uncertain:true`로 둔다. UI는 `uncertain`을 "캐시 유지 시간 미측정" 태그로 보인다(03 §6.3과의 차이는 12장 Q13).
  - `deadline`: 예약 시각 + `max(scheduleDeadlineMinMinutes, 2 × idleMinutes)`. 기본값으로는 Anthropic(5분)이 30분, codex(60분, 불확실)가 120분이다. deadline이 유휴 기준보다 짧으면 유휴 트리거가 한 번도 불릴 수 없으므로 이 식으로 항상 길게 둔다.
- **`accountID`(선택, SL-17 2026-10-27)**: 대상이 `anthropic`이고 Claude 구독 slot이 있으면, 그 상태에 들어설 때 대화 트리가 묶인 Claude 계정(8.7)을 적는다. 다른 provider는 계정이 하나라 적지 않는다. 전환기는 다른 회사의 대화를 Claude로 바꾸기 전에 트리를 고른 Claude 계정으로 옮기는데(`plugin.claudeAuth.session.set`), 대화의 binding(9.2 `session.binding`)은 전환이 끝날 때까지 옛 회사의 계정이다. 그래서 클라이언트는 대기·예약 표시(입력창 칩, 헤더 알약, 사이드바, 대기열, 늦게 끝난 전환의 알림, 03 §6.3)에 이 계정을 쓴다. 그 전에는 provider로 찾아 첫 Claude 계정(AC-01)을 보였다. 이 값은 상태에 들어설 때 정하므로, 기다리는 동안 다른 곳에서 트리를 또 옮기면 다음 상태(WAIT_SAFE에서 SWITCHING 등)까지는 앞의 계정이 남는다. 이 필드가 없는 이전 기록은 대화의 계정으로 읽는다.
- 상태는 KV `sess:<sid>:switch`에 저장한다. 서버가 재시작되어도 이어진다.
  - 재시작 뒤 WAIT_SAFE·SCHEDULED·COMPACTING은 다시 평가한다.
  - BLOCKED의 `waitReset` 타이머는 setup에서 다시 건다. `resumeAt`이 이미 지났으면 바로 보내지 않고 `switch.suggested{reason:"reset_passed"}`로 사용자에게 묻는다. 재시작 사이에 사용자가 다른 일을 했을 수 있기 때문이다.
  - 타이머는 leader 인스턴스가 아니라 그 세션 location 인스턴스가 건다. 한 세션에 타이머가 둘 생기지 않게 `own-runtime`에 세션별로 하나만 둔다.
- **세션 이동(`session.moved`)**: 워크트리 흐름([R-gap] #19)이 `session.move`로 세션의 location을 바꾸면 공개 이벤트 `session.moved{location, projectID, subpath?}`가 온다(`schema/src/session-event.ts:94-101`, `schema/src/session-inbox.ts:31-35`).
  - 옛 location 인스턴스는 그 세션의 SCHEDULED·`waitReset` 타이머와 메모리의 전환 상태(WAIT_SAFE 대상, busy/idle 추적, 캐시 상태 메모리)를 `own-runtime`의 세션별 자리에 넘기고 자기 타이머를 끈다. 새 location의 own-accounts 인스턴스가 그 자리를 넘겨받아 타이머를 다시 건다. 새 location 인스턴스가 아직 없으면 `own-runtime`이 들고 있다가, 그 location의 첫 setup이나 첫 세션 RPC 때 넘긴다. KV 상태(`sess:<sid>:*`)는 전역이라 옮기지 않는다(2.3).
  - 옛 인스턴스가 이동 뒤에도 그 세션에 `switchModel` 등을 할 수 있는지는 확인하지 못했다 ⚠. core의 `SessionContext.select`는 세션 location이 자기 location과 다르면 중단하므로(`core/src/session/context.ts:121-123`) 실행은 새 location에서만 된다. 그래서 이동 뒤의 세션 조작은 새 location 인스턴스만 한다.
  - 클라이언트는 이 이벤트를 받으면 그 세션의 세션 메서드(9.1)를 새 directory로 보낸다. own-accounts는 새 location에서 `cache.state`와 `switch.state`를 한 번 낸다.
- **외부 전환 감지**: TUI나 upstream app이 `POST /api/session/:id/model`을 직접 부르면 `session.model.selected`가 온다. 우리가 낸 것이 아니면 `reason:"external"`로 기록하고 STEADY로 둔다. 막지 않는다.

### 5.5 히스테리시스와 차단기

- **cooldown**: 전환한 뒤 30분 **그리고** 20요청 동안은 자동 전환을 하지 않는다.
  - 예외: 현재 slot에서 난 T-HARD와 T-AUTH
  - 사용자 수동 전환은 cooldown과 상관없다.
- **circuit breaker**: 아래 중 하나면 30분 동안 열린다. 열려 있는 동안 자동 전환을 멈추고 제안만 하며, `flap` 경보를 낸다.
  - 세션당 1시간에 자동 전환이 2회 이상
  - 사용자 조작 없이 10분 안에 A→B→A
  - 최근 15분 cold 합계가 3·P를 넘음
- **소진된 계정**: `until` 전에는 대상 후보에서 뺀다.
- 수치는 모두 `policy.json.hysteresis`에서 바꿀 수 있다. 기본값은 [R-design 4.4]에서 가져왔다.

### 5.6 선택지 고르기

| 상황 | 기본 선택 |
|---|---|
| cold point, 또는 새 세션(턴 없음) | `now` |
| `P_t ≥ T_t`. `T_t`는 대상의 실효 자동 압축 기준이다(4.7. v2 기본이면 대상 창의 ceiling `ctx − max(floor(0.15·ctx), 16k)`, `compaction.ts` calculateCeiling). 대상에서는 cold 요약, 또는 (이미 압축한 세션이면) 압축 없는 통째 cold 전송이나 overflow 복구가 일어난다(4.7.5) | 소스를 쓸 수 있으면 `compact-then-switch`(강제, `now`는 `available:false, reason:"target_context_too_small"`). 쓸 수 없으면 `new-session`. `switch-then-compact`는 `Z + P_older > T_t`이면 `compaction_may_truncate` 경고를 붙인다(4.7.5) |
| `0.8·T_t ≤ P_t < T_t` | 대상에서 곧 압축된다(경고 `target_compacts_soon`). 소스를 쓸 수 있으면 `compact-then-switch`를 권장 후보로 본다(아래 권장 규칙과 6.3 ⑦). 압축 뒤 문맥 `S_t ≥ 0.8·T_t`이면 `new-session` |
| 소스를 쓸 수 있고 대상에서 곧 압축되지 않음 | `now`. 비용만을 이유로 `compact-then-switch`를 권하지 않는다(07 §6.2 #11). 두 선택지의 비용은 그대로 보인다 |
| 소스가 hard 소진, P ≥ 0.6·ctx_t, H ≥ 손익분기(6.3 ⑦) | `switch-then-compact` |
| 급하지 않은 수동 전환이고 cold point가 곧 옴, 또는 자리 비움 감지(`policy.awayDetect`) | `cold-point`. 트리거는 `either`(압축 직후 또는 유휴 `idleMinutes`). 소스 TTL 상한을 모르면(codex) 유휴 기준은 60분이고 `uncertain`이다. deadline은 5.4 식 |
| 곧 A로 돌아올 곁가지 작업 | `fork` |

- **`recommended` 규칙**: 03 §6.3은 `switch.estimate`의 `options[].recommended`를 그대로 표시하고 문맥 크기로 따로 판단하지 않는다. 그래서 권장 판정은 여기서만 한다.
  - 토큰 크기 문턱은 없다(07 §6.1 U6). 문맥을 바꾸는 선택지(압축, 새 세션)는 대상 창과 기준에 비춘 비율로만 권한다.
  - `compact-then-switch`에는 대상에서 곧 압축될 때(`0.8·T_t ≤ P_t`, 4.7.5)만 `recommended:true`를 붙인다. 압축 뒤 문맥도 `S_t ≥ 0.8·T_t`이면 `new-session`이다.
  - 소스를 쓸 수 없으면 `switch-then-compact`는 `P ≥ 0.6·ctx_t`이고 H가 손익분기(6.3 ⑦) 이상일 때만 권한다. 그 밖에는 `now`다.
  - 과금 단위가 다르면(예: 요약은 credits, 전환은 USD) 비교하지 않는다. 어느 선택지에도 `recommended`를 붙이지 않고 기본 선택은 `now`다. 단, 대상 문맥이 모자라 `now`가 `available:false`이면 표 둘째 줄의 강제 선택을 따른다.
  - 자리 비움 감지(`policy.awayDetect`)가 켜져 있고 곧 자리를 비울 것으로 보이면 `cold-point`에 `recommended`를 붙일 수 있다.
  - 그 밖의 선택지는 위 표의 기본 선택일 때만 `recommended`를 붙인다(과금 단위가 같을 때).
- `compact-then-switch`를 Anthropic 소스에 쓸 때는 이득이 작을 수 있다(6.4 예시 2). 추정기가 두 선택지 비용을 모두 보여 주고 경고 `anthropic_compaction_may_be_cold`를 붙인다.

### 5.7 대상 고르기(자동 전환과 "추천" 정렬)

1. **후보**: 세션 요구를 만족하는 slot·모델
   - tools 지원
   - 최근 window에 이미지가 있으면 이미지 입력 지원
   - 압축 뒤 문맥이 대상 기준 안에 들어간다: `S_t < 0.8·T_t`(4.7.5). 창 크기는 등록 모델이 아니라 **템플릿의 원래 값**으로 본다(등록 모델의 `limit.input`은 `ctx_eff`다, 3.6)
   - `P_t ≥ T_t`인 대상도 후보로 둔다. 다만 5.6에 따라 `compact-then-switch`가 강제되고 점수에 압축 비용이 들어간다
2. **거르기**
   - 계정 `ready`, quota domain이 소진되지 않음. linked 가져오기 계정이 stale(`codex_source_stale`, 3.2a)이면 뺀다
   - 소스가 아님
   - 정책(5.10)과 계정 `autoSwitch`
   - breaker가 닫혀 있음
3. **fallback chain이 있으면** 과금 단위가 다른 그룹 사이에서는 그 순서를 지킨다. 같은 단위 안에서만 점수로 정렬한다.
4. **점수(같은 단위)**: `score(t) = Δ_now(t) + H · c_req(t)`
   - H는 `policy.horizonRequests`(기본 20)다. 세션 ledger에 턴당 요청 중앙값이 있으면 그 값 × 5를 쓴다.
   - 동점이면 headroom이 큰 쪽이다. `headroom = min_windows(1 − used%/100)`이고, 리셋이 60분 안이면 보정한다.
5. 되돌아가는 전환은 W>0이어서 점수가 자연히 낮아진다. 별도 가산점을 두지 않는다.

출력은 사유를 붙인 순위 목록이다: `{providerID, score, deltaNow, perRequest, headroom, excludedReason?}`.

### 5.8 원래 계정으로 돌아가기

- **home slot**: 세션을 시작할 때의 slot, 또는 사용자가 "이 세션의 기본 계정"으로 고정한 slot이다. KV `sess:<sid>:home`에 둔다.
- **hard 소진 때문에 떠났을 때**
  - `homeReturn{slot, eligibleAt=resetAt}`을 기록한다.
  - home이 다시 쓸 수 있게 되면 아래 둘 중 하나일 때만 돌아간다.
    - (a) 사용자가 "리셋되면 원래 계정으로"를 켰다.
    - (b) `Δ_return < H·(c_req(현재) − c_req(home))`. 예: 현재가 종량제 API이고 home이 구독이다.
  - 돌아가는 시점은 **cold point**(압축 직후, 또는 현재 slot idle > TTL 상한)다. 그 밖에는 제안만 한다.
  - 5시간 창이 리셋될 무렵이면 home 캐시는 이미 만료되어 있다. 그래서 돌아가는 비용은 cold 기준으로 추정한다.
- **짧은 수동 다녀오기**: "원래 계정으로 돌아가기"를 강조하고 warm 추정을 보여 준다. `W_home = L_home`이 되는 조건은 다음이 모두 참일 때다.
  - `now − lastReqAt_home < TTL_lo`
  - epoch가 같다(그 사이 compaction 없음)
  - model id와 variant가 같다
  - 이미지 trim이 없었다
  - Anthropic: `blocksSince < 20`이거나 watermark hint가 있다
  - OpenAI 5.6+: `messageEndsSince < 20` ⚠
- **되돌리기(03 §6.2)**: 전환한 뒤 첫 step이 **시작되기 전**이면 `switch.undo`로 이전 Ref로 되돌린다. 비용이 없다.

### 5.9 실행 순서(API 호출)

**(a) 지금 전환**
```
UI  → RPC switch.estimate {sessionID, target}          ← {estimateID, options[]}
UI  → RPC switch.apply {sessionID, estimateID, target, strategy:"now", reason:"manual"}
ACC : busy → WAIT_SAFE (응답 {state:"WAIT_SAFE"}) / idle → ctx.session.wait → ctx.session.switchModel
SRV : durable session.model.selected {model, previous}  (schema/src/session-event.ts:84)
ACC : SWITCHING → COOLDOWN, 전환 기록을 @own/runtime ledger writer로 events.jsonl에 씀, rpc 이벤트 switch.recorded / binding.changed
UI  → POST /api/session/:id/prompt   (사용자의 다음 입력. WAIT_SAFE 중이면 delivery:"queue", 5.3)
```
ACC = own-accounts, TM = own-telemetry, UI = own-web, SRV = core.
own-web이 아닌 클라이언트가 쓰는 HTTP 경로는 `POST /api/session/{id}/model {model}` → 204다(`protocol/src/groups/session.ts:342`). own-web은 사유를 ledger에 남기려고 항상 RPC를 쓴다.

**(b) 압축 후 전환(compact-then-switch)**
```
UI  → RPC switch.apply {strategy:"compact-then-switch", ...}
ACC : staged revert 있음? → 오류 revert_staged (4.7.4 "revert")
      estimate 이후 이미 compaction.ended가 있었음? → (a)처럼 즉시 전환
      아니면 COMPACTING → ctx.session.get 으로 revert 없음 확인 → ctx.session.compact {sessionID}   (upstream 924c12b291; idle이면 곧 시작)
      응답 {state:"COMPACTING"} (clientAction 없음. 넣지 못하면 PLANNED + 경보 "압축 실패 — 지금 전환할까요?")
SRV : session.compaction.started → session.compaction.ended (durable)
ACC : compaction.ended 수신 → wait → switchModel(target) → COOLDOWN
      compaction.failed 또는 10분 타임아웃 → PLANNED + 경보 "압축 실패 — 지금 전환할까요?"
```
- 03 §6.5처럼 UI가 먼저 compact와 wait를 한 뒤 `switch.apply{strategy:"compact-then-switch"}`를 불러도 된다. 플러그인이 epoch 변화를 보고 곧바로 전환한다.
- 2026-10-08부터 플러그인이 압축을 직접 넣는다. upstream이 plugin session domain에 `compact`를 열었다(924c12b291, 원장 P-008이 바라던 것). 그전에는 응답의 `clientAction:{type:"compact"}`를 받은 프런트가 HTTP로 했고, 클라이언트가 응답 뒤에 끊기면 10분 타임아웃까지 아무도 압축하지 않았다. 지금은 `clientAction`을 내지 않으므로 옛 own-web도 두 번 압축하지 않는다.
- COMPACTING 중에 revert가 staged되면 PLANNED로 돌리고 `switch.state`를 낸다(4.7.4 입장 규칙).

**(c) 전환 후 압축(switch-then-compact, 소스 소진)**
```
ACC : switchModel(target) → (revert 확인 뒤) ctx.session.compact {sessionID} (이제 대상 모델이 요약) → 응답 {state:"SWITCHING"}
      세션이 돌고 있어 WAIT_SAFE로 미뤄졌으면, 안전 지점에서 전환한 뒤 같은 방법으로 압축을 넣는다(전에는 이 경우 압축이 빠졌다)
```
요약 요청이 대상에서 `Z + P_older`를 cold로 읽는다. 손익분기는 6.3 ⑦이다. staged revert가 있으면 이 전략은 `available:false, reason:"revert_staged"`다(4.7.4).

**(d) cold point 예약(`switch.schedule`)**
- SCHEDULED 상태로 둔다(필드는 5.4). own-accounts가 다음 중 먼저 오는 때에 WAIT_SAFE로 넘긴다.
  - `trigger`가 `compaction` 또는 `either`: `compaction.ended`
  - `trigger`가 `idle_ttl` 또는 `either`: 소스 idle이 `idleMinutes`를 넘음(타이머). 사용자 메시지가 오면 타이머를 다시 시작한다.
  - deadline(→ PLANNED, 다시 묻기)
- 소스 `TTL_hi`를 모르면(codex) `idleMinutes = unknownTtlIdleMinutes`(기본 60)로 예약하고 `uncertain:true`를 붙인다. 03 §6.3은 이 경우를 `trigger:"compaction"`만으로 제한한다(12장 Q13). AC-P08로 codex TTL을 재면 ratecards 값으로 바꾼다.
- 예약하지 않는 경우(`available:false`)
  - 소스 캐시가 이미 식었다: `reason:"source_already_cold"`(03 `"지금 전환"과 비용이 같습니다`)
  - 소스 `TTL_hi`가 하루를 넘는다(DeepSeek 등): `reason:"ttl_too_long"`(03 `캐시가 수 시간~수일 유지되어 기다리는 이점이 없습니다`)

**(e) 곁가지 포크(fork)**
```
UI  → POST /api/session/:id/fork {before?}            (protocol/src/groups/session.ts:309) → S'
UI  → RPC switch.apply {sessionID:S', target, strategy:"now"}
```
- S'는 B에서 cold로 시작한다. 원 세션 S는 A에 **그대로** 남는다.
- 그래서 A로 돌아올 때 B 구간 suffix와 lookback 문제가 없다[R-design S13].
- fork의 cache key는 `fork.sessionID`를 물려받는다(`model-request.ts:237`).

**(f) 새 세션 인계(new-session)**
1. 소스를 쓸 수 있으면 `POST /api/session/:id/generate {prompt: HANDOFF_PROMPT}`로 요약을 만든다. 현재 모델(A)을 쓰므로 warm read다(`warming.ts:49-50`). 이 요청의 사용량은 core가 기록하지 않는다(`core/src/session/generate.ts:64`). own-accounts가 응답 사본의 SSE usage로 ledger에 적는다(7.5).
2. 소스를 쓸 수 없으면 모델 호출 없이 seed를 만든다: 마지막 checkpoint 요약 + 최근 사용자 메시지 N개 + 열린 파일 목록.
3. `POST /api/session {title, model: target, location:{directory}, metadata:{own:{seededFrom:S}}}`
4. `POST /api/session/:new/prompt`로 seed를 보낸다.
5. RPC `switch.apply{strategy:"new-session", childSessionID}`로 기록한다(DELEGATED).

**(g) 자동 hard 트리거(MVP, 유휴에서만)**
```
step 실패 → core retry 정책 → retry hook(ACC. anthropic이면 TM): 분류 = hard → decision {retry:false}; 소진 기록(until) → own-runtime(ledger writer로 events.jsonl)
execution.failed → ACC: 소진 기록을 읽고 대상 자동 선택(5.7)
   정책 auto(API 키끼리만) : WAIT_SAFE → switchModel → COOLDOWN; rpc switch.recorded + switch.suggested{continue:true}
   정책 ask(구독 소스는 항상) : PLANNED; rpc switch.suggested (UI 배너 "B로 전환 후 계속")
   대상 없음  : BLOCKED{nextResetAt}; UI "리셋까지 대기" → switch.waitReset
UI: [계속] → POST /prompt "계속"   (영구 메시지가 남는다)
```
- **자식 세션이 소진될 때**(5.11)
  - 자식(하위 에이전트) 세션도 own-accounts에게는 하나의 세션이라 위 흐름을 그대로 탄다. 다만 자식의 입력창은 비활성이고(03 §18.11) 사용자는 부모 화면을 본다.
  - 그래서 자식의 `switch.suggested`는 own-web이 자식의 `parentID`로 찾아 **부모 화면**에 띄운다(RPC 모양은 같음). 자식의 BLOCKED `waitReset`은 쓰지 않는다. 자식은 부모가 다시 부를 때 이어진다.
  - 부모가 소진된 slot을 떠나면(T-HARD·T-AUTH) 부모의 `childPolicy`는 `follow`다(5.11). 그 slot에 묶인 자식 중 idle인 것은 own-accounts가 곧바로 `ctx.session.switchModel`로 부모의 대상 slot에 맞춘다. 실행 중인 백그라운드 자식은 그 자식의 retry hook이 hard를 판정해 멈추고, 부모가 다시 부를 때 `execute.before`(5.11)가 slot을 맞춘다.
  - 자식끼리나 자식→부모로 소진이 전파되는 것은 quota domain 규칙(5.2)과 같다. 같은 계정을 쓰면 같이 `exhausted`다.

**(h) 턴 안 failover(`policy.inTurnFailover`, Phase 3, AC-P17b 통과 전에는 꺼짐)**
- own-accounts의 retry hook(4.1)이 hard로 분류하면, 같은 hook 안에서 대상(5.7)을 고르고 `switchModel(target)`을 부른 뒤 `decision {retry:true, delay:0}`을 준다. runner가 attempt마다 모델을 다시 확정하므로(`llm.ts:213-243`) 다음 attempt는 B로 간다.
- 분류와 failover 결정이 own-accounts의 한 hook 안에 있으므로 다른 플러그인의 판정을 기다리거나 attempt 표식을 남길 필요가 없다. 분류 함수는 `@own/accounts` 안에 둔다. own-telemetry의 retry hook은 `anthropic` scope라 own slot 요청에서는 불리지 않는다.
- "계속" 메시지가 남지 않는다.
- 조건: 출력 전에 실패했다(429는 대개 출력 전이다). 자동 전환 정책(5.10)을 똑같이 따른다. 구독 소스에서는 쓰지 않는다.

**(i) 리셋까지 대기(`switch.waitReset`, 03 §6.6)**
- BLOCKED의 하위 상태로 둔다: `waitReset:{resumeAt: resetAt + 지터(1~3분), message}`. KV `sess:<sid>:switch`에 저장하고, 재시작하면 setup에서 타이머를 다시 건다(5.4).
- `resetAt`은 그 세션의 모델을 지금 막는 것이 모두 풀리는 시각이다(LV 2026-10-24): BLOCKED의 `nextResetAt`, 그 모델을 막는 소진 기록(5.2. 묶음 기록은 그 모델 묶음일 때만), 그 세션이 도는 계정의 `exhausted` 창 가운데 그 모델을 막는 것(7.3. 모델별 주간 묶음은 그 모델 묶음일 때만, Claude의 추가 사용량은 혼자 막지 않는다, `LimitRank.blocks`) 중 가장 늦은 것이다. 다 찬 Opus 주간은 Opus 대화를 그 주간 리셋까지 기다리게 하고, 같은 계정의 Sonnet 대화의 기다림을 늘리지 않는다(Sonnet 대화는 기다릴 것이 없으면 `no_reset_known`). 예전에는 BLOCKED의 `nextResetAt`이나 소진 기록을 창보다 먼저 써서, 짧은 계정 전체 기록이 묶음의 리셋을 가렸다.
  - 그 세션이 도는 계정은 `anthropic`이면 바인딩이 읽는 트리의 Claude 계정이다(`claude.accountOf(sessionID)`, 8.7, `session.binding`과 같다). 동기 `peek`은 재시작 직후 바인딩을 아직 모르면 기본 계정을 돌려주므로 쓰지 않는다.
- `resumeAt`에 own-accounts가 `ctx.session.prompt`로 설정 문구(기본 "계속")를 보낸다.
- 영구 메시지가 남는다는 점을 UI가 알린다. `switch.cancel`로 취소한다.

**컴포넌트 분담**

| 기능 | own-accounts | own-telemetry | own-web |
|---|---|---|---|
| 레지스트리, vault, 로그인 | 수행 | – | 화면 |
| provider·model 등록, 토큰 주입, context hook | 수행 | – | – |
| 한도·사용량 수집, `LimitWindow`, ledger, 캐시 상태, 경보 | own slot 전부와 모든 step의 ledger 줄 수행(파일은 `@own/runtime`의 단일 writer로 씀) | `anthropic`의 unified 창(`claude.*`)과 `claude_extra_usage` 판정만(runtime으로 넘김) | 표시 |
| hard 소진 판정(retry hook) | own slot 수행 | `anthropic`만 수행(8.8) | 배너 |
| 추정기 | 수행 | `anthropic` 한도 창 제공(runtime) | 표시 |
| 상태 머신, 트리거 처리, `switchModel` | 수행 | – | 확인 대화상자 |
| RPC id `own.accounts` 핸들러와 이벤트 발행 | 수행(유일한 등록·발행자, 9.1) | runtime으로 `anthropic` 데이터 전달 | 호출·구독 |
| compact | –(P-008 rejected). 서버 자기 호출은 후보(4.7.2 (d)) | – | revert 확인 뒤 `POST /api/session/:id/compact`(4.7.4) |
| Codex 로그인 가져오기(3.2a) | 수행(원본 읽기, takeover의 복사와 refresh) | – | 화면 |
| 자동 압축 기준(4.7) | 해석, slot 모델 `limit.input` 등록, `compaction.due` 판정과 서버 쪽 압축 입장 | – | 설정 화면, 문맥 막대. `compaction.due`는 알림(압축은 서버가 `ctx.session.compact`로 넣음, 4.7.4) |
| generate·title·압축 사용량(7.5) | own slot의 generate·title SSE 사본 읽기, 압축 이벤트의 tokens·cost, ledger 줄 | `anthropic`의 generate·title SSE 사본 읽기(runtime으로 넘김) | 세션 비용 표시 |
| 자식 세션 모델 규칙(5.11) | `execute.before` hook, `childPolicy` | – | 자식의 전환 제안을 부모 화면에 표시 |
| 승인 모드(9.2 `session.approval.*`) | 규칙 묶음 생성, 부모와 끝나지 않은 자식 PATCH | – | 헤더 알약, 확인 대화상자 |
| fork, 새 세션, 계속 | 기록 | – | `POST /fork`, `POST /api/session`, `/prompt`, `/generate` |

### 5.10 구독 계정 정책(약관)

- **구독 계정에서 나가는 자동 전환은 하지 않는다.** 01 §1.2·§8.6과 같다.
  - 구독끼리(ChatGPT A→B, Claude 슬롯 등): `ask|off`만 있다. 소비자 구독을 한도 때문에 자동으로 돌리면 한도 우회로 볼 수 있다[R-critique #4; R-omo 102·433].
  - 구독 → 종량제 API: `ask|off`만 있다. 돈이 드는 전환이고, 01이 구독의 자동 failover를 비목표로 두었다. 사용자가 원하면 12장 Q12에서 opt-in으로 다시 정한다.
  - `policy.set`이 이 두 값에 `"auto"`를 받으면 `policy_denied`를 돌려준다.
  - 사용자가 제안을 눌러 전환하는 것은 허용한다(수동).
- **자동 전환용 fallback chain에는 구독 slot을 넣지 않는다**(2.4.3). 03 §6.7의 "구독 계정끼리의 자동 전환은 제공하지 않는다"와 같다.
- **API 키끼리**: 계정 `autoSwitch=true`이고 정책이 `auto`일 때만 자동이다. 03 §6.7과 같다.
- **서드파티 Claude 슬롯으로는 자동 전환하지 않는다**(`toClaudeSlot`은 `off` 고정).
- **예외 하나: 이 PC의 Claude 구독 계정끼리(2026-10-10, 사용자 결정 C-D3).** Claude 계정이 한도로 막히면 그 대화의 세션 트리(팀이면 팀 전체)를 이 PC의 다른 Claude 계정으로 자동으로 옮긴다. 정책 `autoSwitch.claudeToClaude`(`auto`·`off`. 출력 전에 바꾸므로 물어볼 틈이 없어 `ask`는 받지 않음, `policy_denied`)이고, 다른 회사로는 가지 않는다(Claude → 다른 회사는 여전히 제안, 다른 회사 → Claude는 여전히 `off`). 위 첫 줄의 "구독끼리 자동 전환 안 함"을 Claude끼리에 한해 사용자가 바꾼 것이다. 한도 우회로 보일 수 있다는 위험은 8.1과 위험 고지 8번에 적었다. 흐름은 8.8.
  - 기본값(사용자 결정 2026-10-31, CAG-5, C-D3 기본값 철회): 새로 설치하면 `off`이고 값이 없을 때도 `off`다. 사용자가 `auto`를 골라야 이 예외가 켜진다. 이미 있는 `policy.json`의 값은 그대로 둔다(2.4.3).
- round-robin 배정은 하지 않는다. 새 세션을 만들 때 headroom 순 **추천**만 한다.
- 하위 에이전트가 LLM의 선택으로 다른 구독 계정에 가는 것도 이 정책의 우회다. 5.11이 막는다.
- **같은 회사의 다른 구독 계정은 하위 에이전트로도 팀 영역으로도 쓰지 않는다(07 R4·U5, T1).** 세션 하나(팀이면 팀 전체)에서 회사마다 구독 계정은 하나이고, 메인과 같은 회사면 메인의 계정이어야 한다(`Preset.allowed`, 07 §5.4). 같은 ChatGPT 로그인의 `codex` 계정과 `siwc` 계정은 구독 하나로 센다(그래서 ChatGPT 01 팀의 영역이 같은 로그인의 `siwc` 계정을 쓸 수 있다). 로그인을 모르면 따로 센다. 다른 로그인은 언제나 다른 구독이다. 하위 에이전트의 고정 대상은 메인과 같은 회사면 메인 계정 자신이어야 하므로, 같은 로그인의 다른 slot도 하위 에이전트 대상이 되지 않는다. 경고를 받고 허용하는 길은 없다.
- **팀 모드(06)**: 영역의 메인은 처음에 팀 메인과 같고(`팀과 같게`), 팀은 회사마다 구독 계정 하나다(R4, 07 §5.1). 영역에 계정을 자동 배정하거나 돌리지 않으며 계정당 동시 담당 상한도 두지 않는다(06 §10.1·§10.3). 팀의 구독 계정을 바꾸는 것은 own.team의 `team.account` 작업뿐이다(5.11 4·5번, 06 §10.1). 받아들인 대화(T2)는 그 계정 그대로 이어 쓰고, 팀 메인과 같은 회사의 다른 구독이면 첫 메인 요청 때 팀 계정의 새 대화로 이어 간다. 그 다른 구독에서는 인계 턴도 돌리지 않는다(프로그램 인계, 06 §3.7·§6.2). 판정할 수 없으면 붙이지 않는다(실패하면 닫힘).
- **프리셋의 종량제 하위 에이전트(07 §5.4, T1)**: 사용자가 켠 계정만, 계정의 월 예산 안에서만 쓴다. 제안·시작 틀·예비 대상에 저절로 들어가지 않는다. 구독 대상이 막혀 목록의 다음이 종량제 대상이면 저절로 넘어가지 않고 이번 호출을 거절한 뒤 화면 카드가 묻는다(`[이 대화에서만] [아니오]`, `session.preset.consent`, 9.2).

### 5.11 자식 세션(하위 에이전트)의 계정

[R-gap] must #11(하위 에이전트 화면), should #23(백그라운드 작업)이 자식 세션을 많이 만든다. 12장 Q10을 소스로 답한 결과, 계정 정책에 구멍이 두 개 있다.

**사실(소스 확인)**
- 새 자식의 모델은 `override ?? agent.model ?? parent.model`이다(`core/src/tool/plugin/subagent.ts:184`). `override`는 subagent 도구의 `model` 입력이고 LLM이 채운다(`subagent.ts:168`).
- 도구 설명 자체는 중립이다. "사용자가 명시적으로 요청할 때만"이라는 말은 `model` 입력의 설명(`subagent.ts:36-39`, `models` 도구로 찾아 "자기 provider부터" 보라고 함)과 설명 없는 에이전트의 대체 문구(`subagent.ts:303`)에만 있다(07 §2.9에서 고침). `models` 도구(실제 이름 `opencode_models`)는 **사용 가능한 모든 모델**을 돌려주고 세션의 providerID를 앞에 정렬하며 provider 이름으로도 거른다(`core/src/tool/plugin/opencode.ts:134-195`). own slot은 provider 이름에 계정 라벨이 있어("ChatGPT · 업무", 3.6) 다른 계정도 그대로 보인다. T0부터 own-accounts가 이 결과를 거른다(규칙 2).
- 이어 부르는 자식(`input.sessionID`)은 `model` 입력이 있거나 agent가 바뀔 때만 모델을 바꾼다(`subagent.ts:168-181`). 그 밖에는 자식이 원래 slot에 남는다.
- 자식은 생성 때 부모의 권한·metadata를 복사한다(`core/src/session.ts:273-276`). 요청의 cache key 계열은 부모를 따른다(`affinity = parentID ?? …`, `core/src/session/model-request.ts:237`).
- D9 상호작용: 부모가 `own-codex-*`여도 identity의 `Provider ID:` 줄은 `openai`다(4.3 D9). 모델이 "자기 provider"를 이 값으로 알고 `openai/gpt-5.5`를 넘기면 내장 `openai`로 간다. 숨긴 provider면(`hideBuiltinProviders`) resolve가 실패해 도구 오류가 되고, 숨기지 않았으면 전역 credential로 과금된다.

**구멍**
- (가) LLM이 자식을 다른 계정(구독→구독 포함)으로 보낼 수 있다. 상태 머신, 5.10, fallback chain을 모두 거치지 않는다.
- (나) 부모가 A에서 B로 전환한 뒤(예: A hard 소진) 이어 부르는 자식은 A에 남는다.

**규칙**
1. own-accounts는 setup에서 `ctx.tool.hook("execute.before")`와 `ctx.tool.hook("execute.after")`를 한 번 등록한다(4.1). subagent 도구가 자기 입력을 고치는 것과 같은 방식이다(`subagent.ts:271-280`). `execute.before`는 `event.tool === "subagent"`일 때만 본다. `event.sessionID`가 부모다. 입력만 고치고 throw하지 않는다(promise 플러그인의 throw는 도구 실패가 아니라 세션 오류가 된다).
2. **하위 에이전트 관문(07 §5.4, T0에 구현)**. 이 규칙의 옛 판("다른 own slot은 종량제이고 `ready`면 둔다", "Claude 슬롯은 지운다")은 T0부터 쓰지 않는다. 구현은 `packages/own-accounts/src/presets/{access,gate,models-filter,agents,presets}.ts`다.
   - **허용 집합**(07의 `A(root)`. T0은 묶음마다 `평소대로`뿐): 루트 세션의 메인 계정(그 slot)의 모델 + 그 호출의 에이전트에 한해 설정 `agent.model`이 가리키는 로컬 provider나 own 종량제·선불 계정(쓸 수 있는 상태, 5.7 2번 거르기 통과, R4(`Preset.allowed`) 통과, 월 예산 남음).
   - **LLM이 적은 `model`**: 역할 이름(`review` 등)이면 메인과 같게 돈다. 메인 slot의 모델이면 그대로 둔다. 메인 slot kind의 canonical(`openai`, `anthropic` 등, D9 값)이고 그 model id가 메인 slot에 있으면 providerID를 메인 slot으로 **바꾼다**. 그 밖(다른 own slot, Claude 슬롯, 내장 provider)은 **거절한다**. LLM이 provider를 고르게 하지 않는다(07 §3.1). 종량제 계정을 하위 에이전트로 쓰는 길은 설정 `agent.model`(T0)과 프리셋 역할(T1)뿐이다.
   - **거절**: `input.agent`를 `own-preset:`으로 시작하는 문장(`Preset.rejection`. 역할 이름만 적고 "사용자에게 물어라"로 끝남)으로 바꾼다. core가 `Unknown agent: <문장>` 도구 실패로 LLM에게 돌려준다(`subagent.ts:134-135`). 경보 `subagent_rejected`(info, 세션, `{requested, reason}`). 화면은 실패 카드가 아니라 중립 칩이다(03 §18.11).
   - **설정 `agent.model`이 own 구독 slot**(다른 ChatGPT 계정, Claude 슬롯)이면 전역 설정이라 세션별 R4를 판단할 수 없으므로 부모 Ref로 바꿔 돌리고 경보 `subagent_model_overridden`(info, 세션 = 부모, `{requested, used}`)을 낸다. 예산을 다 쓴 종량제 대상은 거절한다(`reason: "budget"`).
   - 관문이 정한 대상은 `input.model`에 명시적으로 쓴다. core의 `override ?? agent.model ?? parent.model`(`subagent.ts:184`)에서 설정의 `agent.model`이 이기지 못하게 하기 위해서다. 세션에는 아무것도 쓰지 않으므로 요청 앞부분이 그대로다.
   - **`models` 도구 거르기**(`execute.after`): `opencode_models` 결과를 허용 집합의 provider만 남긴다(T0은 메인 provider만, T1부터 프리셋의 고정 대상 provider까지). 다른 계정은 LLM에게 보이지 않는다.
   - **숨긴 내장 에이전트의 모델**(title 등, `agent.transform`): 설정 `model`이 own 구독 slot이면 지운다. 제목은 세션 provider의 작은 모델로 돈다(4.1, 경보 `internal_agent_model_removed`, `diagnostics.selfTest.agentModels`).
   - **T1(07 §5.4)**: 허용 집합 = 메인 계정의 모델 + 루트 바인딩 프리셋의 대상(역할별 목록, `workers.single`, 해석한 Ref) + 설정 `agent.model`의 로컬·종량제 대상 − 5.7의 거르기를 통과하지 못한 대상 − 예산을 다 쓴 종량제 대상. LLM은 `agent`에 역할(`explore`, `general`, `own-review`, `own-quick`, `own-deep`)만 적고 관문이 그 역할의 첫 쓸 수 있는 대상을 `input.model`에 쓴다. 목록 밖 provider로 조용히 바꾸지 않고, 끝이면 `메인과 같게`로 돌며 그 호출의 결과에 적는다. 구독 대상이 막혀 다음이 종량제면 동의(`session.preset.consent`) 전까지 거절한다. 상한(동시·메시지당·대화당, 07 §2.6)은 `@own/runtime`의 동기 예약 맵으로 세고 넘으면 기다리지 않고 거절한다. R4 판정은 `Preset.allowed`(바인딩의 `team` 포함) 하나로 하며, 같은 ChatGPT 로그인의 `codex`·`siwc`는 구독 하나로 보되 메인 회사의 고정 대상은 메인 계정 자신만 된다(5.10).
   - **읽기 전용 역할(T1, 07 §2.4)**: 자식은 부모의 세션 규칙을 물려받으므로(`core/src/session.ts:273-276`, surface `session-child-inherits`) 부모가 `ask`·`full`이면 `explore`·`own-review`의 deny가 풀린다. own-accounts의 `permission` `evaluate` 훅이 그 세션들의 `edit`(그리고 `explore`의 `shell`)과 `computer`를 `deny`로 되돌린다. 훅은 조이기만 하고 들어온 `deny`를 바꾸지 않는다(07 §2.4, PG10).
   - 확인은 07 PG1·PG2의 T0 부분((가)·(마)), T1의 PG2 (나)–(사)·PG4·PG10·PG11(07 §8.4). upstream 계약은 `own/upstream-surface.json`의 `subagent-*`, `opencode-models-tool`, `tool-*`, `agent-*`, `builtin-plugin-placement`, `plugin-updated-after-activation`, `permission-evaluate-hook`, `hook-scope-filter`, `session-child-inherits`, `instruction-entry-rendering`이다.
3. **이어 부르는 자식(`sessionID` 입력)**: 관문은 자식의 지금 slot이 지금 허용 집합에 있으면 그대로 둔다(캐시 유지). 없으면 그 역할의 대상(T0은 부모 Ref)을 `model`에 써서 옮긴다(07 §5.5). T1부터 `childPolicy:"keep"`은 자식 slot이 허용 집합을 통과할 때(다른 회사, 종량제, 로컬)만 남는다. 아래 `follow` 규칙의 자식 맞추기는 그대로다. 자식의 현재 slot(own-accounts 바인딩, 없으면 `ctx.session.get`)을 본다.
   - 그 slot의 계정이 쓸 수 없는 상태(`exhausted`, `auth_failed`(linked stale 포함), `needs_reauth`, `retired`, `disabled`)이거나, 부모의 `childPolicy`가 `follow`이고 자식 slot이 `childPolicy.providerID`(부모가 떠난 slot)이면, `model`을 부모의 현재 Ref로 채운다. 그러면 subagent 도구가 자식에 `switchModel`을 부른다(`subagent.ts:172-181`).
   - `childPolicy`가 `keep`이면 자식을 그대로 둔다. 자식의 A 캐시가 살아 있을 수 있기 때문이다.
4. **`childPolicy`**(KV `sess:<sid>:childPolicy`, 2.4.6): 부모가 COOLDOWN에 들어갈 때 정한다. T-HARD·T-AUTH면 `follow`, T-MANUAL이면 `keep`이 기본이다. `follow`일 때 idle인 자식은 부모 전환 직후 own-accounts가 곧바로 맞춘다(5.9(g)). 자식 목록은 KV `sess:<sid>:children`이다.
5. `agent.model`이 설정 파일에서 내장 provider를 가리키는 경우(예전 Q10 걱정): T0부터 관문이 설정 `agent.model`도 호출마다 보므로(2번) 하위 에이전트로는 허용 집합에 없어 거절된다. 숨긴 내장 에이전트의 모델은 subagent 도구를 거치지 않으므로 `agent.transform`이 own 구독 slot만 지우고(2번), 종량제·로컬·내장 provider는 사용자의 명시 설정으로 둔다. selfTest는 지운 것을 `agentModels`로 보인다(9.2).
6. **safe point를 세션 트리로(T1, 07 §5.5).** 메인을 같은 회사의 다른 구독 계정으로 바꿀 때(예: ChatGPT 01 소진 → 02) 옛 계정에서 실행 중인 자식(상대 대상 포함)이 있으면 `switch.estimate`가 `busyChildren:{count, accountID}`를 돌려주고, `switch.apply{children}`의 `after-idle`(처음 값)은 WAIT_SAFE에서 그 자식들이 끝나기를 기다리며 `stop`은 먼저 멈춘다. 그래서 한 루트가 두 ChatGPT 구독을 동시에 쓰는 때가 없다. 다른 회사·종량제·로컬 자식은 기다리지 않는다.
7. **팀 거르기(T1, 07 §5.5, 06 §10.1).** 루트 바인딩의 `team`이 있으면 (1) 전환 대상 순위(`switching/targets.ts`)와 소진 제안(`switch.suggested`)에서 팀 밖의 같은 회사 구독 계정을 뺀다(담당 세션에는 팀 계정만, 팀 메인에는 같은 회사 다른 구독을 `팀 계정 바꾸기…`로만). (2) 팀 세션에서 팀의 그 회사 구독 계정을 바꾸는 `switch.estimate`·`switch.apply`·`switch.schedule`은 own.team의 작업 표식 `teamOp`(06 `op_<ulid>`)가 없으면 `team_switch_required{teamID}`로 거절한다. `switch.apply`는 `teamOp`가 own.team이 그 팀에서 지금 돌리는 `team-account` 작업인지 `ctx.rpc` own.team `op.get`으로 확인하고, 아니면 없는 것과 같다. 게이트웨이는 기기가 보낸 `teamOp`와 `session.preset.apply`의 `team`을 막는다(05 §13.4, 2026-10-02 T1 리뷰 수정). own-web은 이 오류(또는 `session.preset.get`의 `team.role:"main"`)를 보고 06 `team.account` 흐름을 연다. 모든 클라이언트(휴대폰 포함)에 같은 서버 규칙이다.
- AC-P44로 확인한다.

---

## 6. 비용 모델과 추정기

### 6.1 변수

| 기호 | 뜻 | 출처 |
|---|---|---|
| `P_cur` | 현재 slot의 다음 요청 입력 추정치. 직전 step `input+cache.read+cache.write`에 직전 출력과 새 메시지(문자 수/4)를 더한다 | `session.step.ended.tokens`(`schema/src/session-event.ts:359-374`) |
| `Z` | system + tools 토큰. 세션 첫 step의 P에서 첫 사용자 메시지 추정치를 뺀다 | ledger |
| `P_t` | 대상 t로 렌더링했을 때의 입력. `P_t ≈ ρ_t·(P_cur − Z_cur) + Z_t`. ρ는 토크나이저 차이와 strip 보정이다. 기본 1.0, Anthropic 대상은 1.1 ⚠AC-P14 | 추정 |
| `L_s` | slot s가 이 세션에서 마지막으로 보낸 입력 | KV cache state |
| `W_t` | 대상 캐시에서 재사용할 수 있는 prefix | ① |
| `r_in, r_read, r_w5, r_w1h, r_out` | 요율 | ratecards |
| `r_cold,t` | anth: `r_w5`(1h 모드면 `r_w1h`). oai 5.6+: `1.25·r_in`. codex·oai ≤5.5·ds·xai: `r_in` | [R-design 2.1] |
| `TTL_lo, TTL_hi` | 캐시가 살아 있다고 볼 하한(W 계산용)과, 죽었다고 볼 상한(cold point용). 하나의 TTL로 두 결정을 하면 한쪽으로 틀린다 | [R-verify #6] |
| `K` | 압축 뒤 원문 그대로 남기는 최근 토큰. 기본 15,000. core의 config 전역 값이고, 바꾸면 모든 kind에 적용된다(4.7.6 (가)). 추정기는 `cache.state.compaction.keepTokens`를 쓴다 | `compaction.ts:189`, `core/src/config/plugin/compaction.ts:21` |
| `ctx_t`, `T_t` | 대상 t의 원래 창(템플릿)과 실효 자동 압축 기준. `T_t = ceiling(ctx_eff,t)` = `ctx_eff,t − max(floor(0.15·ctx_eff,t), 16k)`(4.7.3, d9987ef9c8, v2.1). 세션 값이 있으면 그 값과의 최솟값 | 4.7 |
| `P_older` | 요약 요청이 보내는 older 부분. `P − Z − K` | `compaction.ts:236-242` |
| `S_sum` | 요약 출력(약 8k, 측정으로 보정) | ledger |
| `S` | 압축 뒤 컨텍스트. `Z + S_sum + K + m` | |
| `δ` | 요청당 새로 붙는 cold 부분(직전 출력 + 도구 결과). ledger 중앙값 | |
| `H` | 앞으로 예상하는 요청 수 | 5.7 |

단위: codex는 credits, API는 USD, Claude 슬롯은 한도 %뿐이다.

### 6.2 요율과 캐시 파라미터(초기값)

| 대상 | 단위 | r_in | r_read | r_cold | TTL_lo / TTL_hi | lookback | 출처·비고 |
|---|---|---|---|---|---|---|---|
| Codex GPT-5.6 Sol | credits/1M | 100 | 10 | 100(write 과금 없음) | 5m / 알 수 없음 | ⚠ | [R-design 1.1]. 프로모션가(2026-11-21까지) |
| Codex GPT-5.6 Terra | 〃 | 50 | 5 | 50 | 〃 | ⚠ | 〃. 출력 300(요금표 2026-10-31, legacy) |
| Codex GPT-5.6 Luna | 〃 | 5 | 0.5 | 5 | 〃 | ⚠ | Codex credit 요금표(2026-10-31 확인, legacy). 출력 30 |
| Codex GPT-5.5 | 〃 | 125 | 12.5 | 125 | 〃 | ⚠ | 〃 |
| Codex GPT-6 Sol | 〃 | 50 | 5 | 50 | 〃 | ⚠ | Codex credit 요금표(2026-10-31 확인). 출력 250 |
| Codex GPT-6 Luna | 〃 | 2.5 | 0.25 | 2.5 | 〃 | ⚠ | 〃. 출력 12.5 |
| Codex GPT-6.1 Sol | 〃 | 50 | 2.5 | 50 | 〃 | ⚠ | 〃. 출력 250 |
| Codex GPT-6.1 Terra | 〃 | 25 | 1.25 | 25 | 〃 | ⚠ | 〃. 출력 125 |
| Codex GPT-6 Astra | 〃 | 250 | 25 | 250 | 〃 | ⚠ | Codex credit 요금표 `learn.chatgpt.com/docs/pricing`(2026-10-30 확인, Standard 속도). 출력 1,250 |
| OpenAI API GPT-5.6+ | USD | 카탈로그 | 카탈로그(GPT-5.6·6 0.1·r_in, GPT-6.1 0.05·r_in) | 1.25·r_in | 30m / 30m | 이전 message end 20개 | [R-verify]. r_read는 2026-10-30부터 카탈로그 값(전에는 0.1·r_in이라 GPT-6.1을 두 배로 셈) |
| OpenAI API ≤5.5 | USD | 카탈로그 | ~0.1·r_in | r_in | 30m / 24h | 문서 없음 | `24h` retention도 보통 30분 정도 유지[R-verify #6] |
| Anthropic Opus 5.5 | USD | 4.00 | 0.20 | 5.00(5m) / 8.00(1h) | 5m/5m, 1h 모드 60m/60m | block 20개 | [R-verify] |
| Anthropic Sonnet 5.5 | USD | 2.00 | 0.10 | 2.50(5m) / 4.00(1h) | 〃 | 〃 | 공식 가격표 `platform.claude.com/docs/en/about-claude/pricing`(2026-10-30 확인). 출력 10 |
| Anthropic Haiku 5.5 | USD | 0.10 | 0.01 | 0.125(5m) / 0.20(1h) | 〃 | 〃 | 〃. 출력 0.50. 프롬프트 100,000 토큰 이하 단가다. 넘는 요청은 모든 단가가 5배인데 모델링하지 않는다(아래) |
| Anthropic Fable 5.1 | USD | 10.00 | 0.25 | 12.50(5m) / 20.00(1h) | 〃 | 〃 | 〃. 출력 50 |
| DeepSeek v4-pro, 피크 | USD | 1.32 | 0.044 | 1.32(write 과금 없음) | 0 / 72h(가정) | – | 공식 가격표 `api-docs.deepseek.com/quick_start/pricing`(2026-10-05 확인). 출력 3.96 |
| DeepSeek v4-pro, 비피크 | USD | 0.66 | 0.022 | 0.66 | 〃 | – | 〃. 출력 1.98 |
| DeepSeek flash, 피크 | USD | 0.30 | 0.006 | 0.30 | 〃 | – | 〃. 출력 1.20. 템플릿 id는 `deepseek-flash`다. 가격표는 `deepseek-v4-flash`를 Flash 가격으로 받는 옛 이름으로 적는다 |
| DeepSeek flash, 비피크 | USD | 0.15 | 0.003 | 0.15 | 〃 | – | 〃. 출력 0.60 |
| xAI | USD | 카탈로그 | 카탈로그(grok-4.5 0.15·r_in, grok-4.3 0.16·r_in, grok-4.6·4.7 0.25·r_in) | r_in | 0 / 알 수 없음 | ⚠ | r_read는 2026-10-30부터 카탈로그 값(전에는 2차 출처의 ~0.25·r_in) |
| OpenRouter | 상위 요율 | – | – | – | 0 / 알 수 없음 | ⚠ | |
| Claude 슬롯 | 한도 % | – | – | – | 5m/5m(1h 가능) | block 20개 | 8.6 |

- `TTL_hi`가 "알 수 없음"이면 idle 기준 cold point는 `unknownTtlIdleMinutes`(기본 60분)로 잡고 `uncertain`으로 표시한다(5.9(d)). codex는 AC-P08(T5)로 측정해 바꾼다.
- `r_out`은 ratecards `out`(없으면 카탈로그 `cost.output`)이다. Codex 5.6 Sol 500 cr, 5.6 Terra 300, 5.6 Luna 30, 5.5 750 cr, GPT-6 Sol 250, GPT-6 Luna 12.5, GPT-6.1 Sol 250, GPT-6.1 Terra 125, GPT-6 Astra 1,250 cr, Anthropic Opus 5.5 $20/1M, Sonnet 5.5 $10, Haiku 5.5 $0.50, Fable 5.1 $50, DeepSeek v4-pro $3.96·flash $1.20(피크). 모르면 ⑥⑦⑩을 계산하지 않는다(2.4.4).
- **Haiku 5.5의 긴 프롬프트 단가**: 프롬프트(입력, cache read, cache write를 모두 센 것)가 100,000 토큰을 넘는 요청은 요청 전체가 $0.50 / $2.50, read $0.05, write 5m $0.625 / 1h $1이다. 카드는 100,000 이하 단가만 적고 이 구간은 모델링하지 않는다. 그래서 넘는 요청의 추정은 5배 낮다 ⚠. 요금표 schema에 토큰 구간이 없어서다(2026-10-30, RR). 대화가 100k를 쉽게 넘는 에이전트 작업에서는 이 차이가 크므로, 구간을 schema에 넣는 일은 남은 일이다.
- **Codex credit 카드(2026-10-31, MR8-20)**: 공개 요금표(`learn.chatgpt.com/docs/pricing`)에 있는 GPT-6.1 Sol·Terra, GPT-6 Luna, GPT-5.6 Luna의 카드를 넣고 GPT-6 Sol·GPT-5.6 Terra의 출력 단가를 채웠다. 요금표에 없는 Codex 모델(카탈로그의 `codex-auto-review` 등)은 카드가 없고, 그 모델로의 추정은 그대로 `rate_unknown`이다. 요금표의 Daybreak Blue·Red는 템플릿 모델이 아니라 넣지 않았다. Fast·Ultrafast 배수는 `speed` 카드다(Ultrafast 카드는 지금 GPT-6 Astra만).
- **DeepSeek 피크 시간**: 평일 01–04시와 06–10시(UTC), 곧 10–13시와 15–19시(KST)다. 그 밖의 시간은 비피크이고 모든 단가가 절반이다(ratecard `offPeakMul: 0.5`). ds 카드의 `peak`가 이 시간대를 적는다(2.4.4).
  - 추정기는 추정하는 시각(`deps.clock.now()`)의 단가를 쓴다(`Rates.resolve`의 `at`). 시각을 주지 않으면 피크 단가다.
  - ledger 비용은 요청 시각의 단가로 계산한다(7.5 "비용"). 요청 시각은 step의 `started`(요청을 보낸 시각)이고, 압축·generate·title 줄은 줄의 `ts`다. DeepSeek가 요청을 받은 시각과 끝낸 시각 가운데 어느 쪽으로 과금하는지는 확인하지 못했다 ⚠. 경계에 걸친 요청만 다르다.
  - 공휴일은 따로 다루지 않는다. 평일이면 피크다 ⚠.
  - 고정 템플릿의 카탈로그 `cost`는 이 표와 다르다(`own-accounts/src/slots/templates/ds.json`). flash는 비피크 가격(0.15 / 0.003 / 0.60)이고, v4-pro는 옛 가격(0.435 / 0.003625 / 0.87)이라 공식 비피크 가격보다도 낮다. core가 step에 싣는 USD(`step.ended.cost`, 7.5 "비용")는 이 카탈로그 값으로 계산된다(`core/src/session/runner/step.ts:230`). 그래서 ledger의 DeepSeek 금액은 core USD 대신 요금표와 요청 시각으로 계산한다(2026-10-06, 결정 D3, 7.5 "비용"). core USD는 `costUSDOpenCode`에 비교용으로 남는다. `/user/balance` 잔액 차이와 맞춰 볼 수 있다.

### 6.3 식

**① 재사용 prefix**
```
W_t^lo =  L_t      if t를 이 세션에서 썼고 ∧ now−lastReq_t < TTL_lo,t ∧ epoch_t = epoch_now
                      ∧ modelID·variant 같음 ∧ lookbackOK_t ∧ 이미지 trim 없음
          Z_t+u_1  elif t와 소스가 같은 CacheDomain이지만 providerID가 다름 ∧ D9 정규화 확인됨 ∧ 소스가 TTL_lo 안
          Z_pre    elif t와 소스가 같은 CacheDomain이지만 providerID가 다름 ∧ D9 미확인 ∧ 소스가 TTL_lo 안
          0        otherwise
W_t^hi = 같은 식에서 TTL_lo를 TTL_hi로 바꾼 값 (TTL_hi 모름 → W_t^lo)
lookbackOK: anth → blocksSince<20 ∨ watermark hint;  oai5.6+ → messageEndsSince<20 ⚠;  그 외 → true ⚠
```
- `u_1`은 첫 사용자 메시지다. `Z_pre`는 tools + system[0]이다(identity part 앞까지).
- 둘째 줄: D9(4.3)가 identity의 `Provider ID` 줄을 slot 중립 값으로 바꾸므로 tools·system·`u_1`까지 바이트가 같다. 첫 assistant부터는 상대 slot의 메타데이터가 빠지므로(`to-llm-message.ts:153-156`) 거기서 갈라진다. [R-verify] critical #1 수정을 반영한 것이다.
- 셋째 줄: D9가 꺼져 있거나 identity 형식이 바뀌어 정규화를 확인하지 못하면(`identity_format_changed`, 4.3) system[1]에서 갈라지므로 `Z_pre`만 재사용한다.
- 같은 도메인이라도 서버가 slot 사이에 캐시를 실제로 공유하는지는 kind마다 ⚠이다(AC-P05·P33·P35). 확인 전에는 `W_t^lo`에 둘째·셋째 줄을 쓰지 않고 0으로 둔다. `W_t^hi`에만 쓴다.
- `epoch_t = epoch_now` 조건은 revert commit도 본다. `session.revert.committed`마다 epoch가 올라가므로(2.4.6, 4.7.4 "revert") 그 뒤 첫 요청은 `W^lo = 0`이다. `W^hi`는 옛 `L_t`로 둔다(경계 앞 prefix의 캐시는 살아 있을 수 있음).
- Code Mode 카탈로그 delta(4.3 D10)는 `W`를 바꾸지 않고 `δ`에 더한다.

**② 전환 뒤 첫 요청**
```
C_first(t) = W_t·r_read,t + (P_t − W_t)·r_cold,t
```

**③ 머물 때**
```
C_stay = L_cur·r_read,cur + (P_cur − L_cur)·r_cold,cur
```

**④ 전환 추가 비용(같은 단위)**
```
Δ_now(t) = C_first(t) − C_stay        범위: [W^hi로 계산, W^lo로 계산]
```

**⑤ 요청당 정상 비용**: 단위가 다르면 따로 적는다.
```
c_req(t) = P_t·r_read,t + δ·r_cold,t
```

**⑥ 압축 후 전환**
```
C_compact(src) = (Z + P_older)·[h_c·r_read,src + (1−h_c)·r_cold,src] + S_sum·r_out,src
C_first'(t)    = S·r_cold,t
Δ_compact      = C_compact + C_first' − C_stay
c_req'(t)      = S·r_read,t + δ·r_cold,t
```
`h_c`는 요약 요청의 hit률이다(실측 2026-10-24, own/reports/cached-compaction-2026-10.md §9).
- codex, oai ≤5.5, ds(longest-prefix 캐시): 소스 마지막 요청이 `TTL_lo` 안이면 약 1. older 요청이 그대로 읽는다(ChatGPT 89~96%, DeepSeek 96%).
- anth(Claude 구독 포함): 마지막 기본 요청 시작이 `TTL_lo` 안이면 older 요청도 약 0.96이다(Haiku·Sonnet 95.7~96.7%). older 끝에서 20칸 안의 최근 요청이 그 항목을 덮기 때문이다. 0이 되는 것은 최근 부분이 20칸(도구 호출 약 10번)보다 길고 older 끝을 덮는 요청이 5분보다 전일 때뿐이고(시스템·도구만 맞아 S1에서 71~72%)[R-verify #5], 그때 전체 요청(4.7.5, P-034)이 약 0.98로 메운다.
- oai 5.6+: ⚠ breakpoint 방식(카드 lookback `messageEnds` 20)이라 anth처럼 최근 부분이 lookback보다 길고 older 끝 항목이 식었으면 older가 놓칠 수 있다. 전체 요청은 재 보지 않아 보내지 않는다(`unmeasured`, CC-16). 실측 없음.

**⑦ 전환 후 압축(소스 소진)**: 이후 H 요청 기준으로 비교한다.
```
no-compact = C_first(t) + (H−1)·c_req(t)
compact    = (Z+P_older)·r_cold,t + S_sum·r_out,t + S·r_cold,t + (H−1)·c_req'(t)
gain = no-compact − compact  > 0  이면 압축.   손익분기 H* = 1 + [compact_fixed − C_first(t)] / [c_req(t) − c_req'(t)]
```

**⑧ cold point에서 전환**
- 압축 직후: `Δ_cp ≈ Z_t·(r_cold,t − r_read,t)`. system과 tools는 소스에서 warm이었을 수 있기 때문이다.
- 소스 idle > `TTL_hi`: `Δ_cp ≈ 0`. 소스도 어차피 cold다.
- 표시는 "거의 0(추정)"이다.

**⑨ 곁가지 포크**: `Δ_fork = Δ_now`다. 대신 원 세션의 A 캐시가 보존된다는 이득을 문구로 보여 준다.

**⑩ 새 세션 인계**
```
C_new = [P_src·r_read,src + h_prompt·r_cold,src + seed_out·r_out,src]  (소스 사용 가능할 때만)
        + (Z_t + seed + m)·r_cold,t
```

**⑪ 구독 한도 %(codex, Claude 슬롯)**
```
Δused% = k_u·U + k_c·C + k_o·O      (U = input+cache.write, C = cache.read, O = output+reasoning)
```
- 보정 전(7.6 기준 미달): %를 **보여 주지 않고** credits만 보여 준다.
- `k_u`만 추정된 경우: `k_c ∈ [0.1·k_u, 1·k_u]`로 **범위**를 보여 준다. 03 §6.3의 "약 4–9%"가 이 범위다.
- 보정이 끝나면: 점 추정과 90% 구간을 보여 준다.
- 요금표의 cached 가중치(0.1×)를 구독 한도 가중치로 그대로 쓰지 않는다. OpenAI가 "Credit prices alone don't determine included subscription usage"라고 밝혔다[R-verify quota].

**⑫ 압축 주기 비용(자동 압축 기준 비교, 4.7.5)**: 같은 slot에 계속 머물 때 기준 `T`에 따른 요청당 평균 비용이다.
```
S        = Z + S_sum + K                              압축 직후 문맥
n(T)     = max(1, (T − S) / δ)                        압축 사이 요청 수
P̄(T)     = (S + T) / 2                                주기 평균 입력
C_cmp(T) = (T − K)·[h_c·r_read + (1−h_c)·r_cold] + S_sum·r_out     요약 요청 한 번(⑥에서 Z+P_older ≈ T−K)
c̄(T)     = P̄·r_read + δ·r_cold  +  [C_cmp(T) + S·(r_cold − r_read)] / n(T)
```
- 둘째 항은 압축 한 번의 비용과 압축 직후 첫 요청의 cold(`S` 전체 재작성)를 주기 안 요청들이 나눠 가진 것이다.
- `TTL_lo = 0`인 kind(ds, xai, or, compat, 6.2)는 비용 상한(최악) 계산에서 `r_read`를 `r_cold`로 둔다. 캐시 적중이 보장되지 않기 때문이다(① `W^lo = 0`). 그러면 `c̄ ∝ P̄`가 되어 `T`를 낮출수록 요청당 상한이 준다. 사용자가 직접 `더 일찍`을 정할 때 보이는 정보다(보수적 kind 기본값은 없다, 4.7.3).
- 설정 화면은 v2 기본(`ceiling(ctx)`, 4.7.3)과 선택한 `T`의 `c̄`를 나란히 보인다. 계산은 `@own/protocol`의 `Compaction.cycleCost`이고, `Z`·`δ`·`S_sum`은 `cache.state.compaction`과 ledger 중앙값(없으면 `Z=12k, δ=3k, S_sum=8k`)을 쓴다.
- 요율 단위가 다르면(credits와 USD) 한 화면에서 비교하지 않는다.

**⑬ 속도만 바꿀 때**(4.8, `session.speed.set{dryRun}`의 `change`): 프롬프트 바이트는 그대로라 캐시와 단가만 바뀐다.
```
C_stay = L·r_read + (P − L)·r_cold         지금 속도의 단가
C_kept = L·r_read' + (P − L)·r_cold'       새 속도의 단가, 캐시가 남음
C_lost = P·r_cold'                          새 속도로 prefix를 다시 씀
```
- OpenAI 계열은 속도를 바꿀 때 캐시가 남는지 문서가 없다 ⚠(실측 1). 그 kind의 "바꾼 뒤 첫 요청"(직전 요청 5분 안, 같은 모델)이 3번 이상이고 80% 이상이 한쪽이면 그 값(`basis:"measured"`), 아니면 `[C_kept, C_lost] − C_stay` 범위(`cache:"unknown"`, `cache_unverified`).
- Anthropic은 처음 Fast를 켜는 요청(beta 헤더가 처음)이 `C_lost − C_stay`(`first_fast_rewrite`), 그 뒤 끄고 켜는 것은 `C_kept − C_stay`다 ⚠(실측 3).
- 새 단가: `codex`는 카드 credits × 속도 카드의 `credits`, API는 기본 단가 × (모드 입력 가격 / 기본 입력 가격), Claude 슬롯은 모드 가격 USD(표준이 한도 %라서 Fast 요청의 USD가 그대로 Δ, `extra_usage`. 표준으로 돌아가면 0). `siwc`처럼 단가를 모르면 `delta:null`, `rate_unknown`과 `factor`(한도 배수)만 보인다.
- `factor`는 요청당 단가 배수다(입력 단가 비, 없으면 `included` 배수).

### 6.4 계산 예

공통 가정: `P_cur = 153k`(직전 입력 L = 150k, 새 부분 3k), `Z = 12k`, `K = 15k`, `P_older = 126k`, `S_sum = 8k`, `S = 12k + 8k + 15k + 2k = 37k`, `δ = 3k`.

**압축 요청 한 번의 값(실측으로 고친 예, 2026-10-24).** Opus 5.5(입력 $4·쓰기 $5·읽기 $0.2·출력 $20, 1M당), 900k 대화, 시스템·도구 1.2만, 남길 최근 부분 1.5만, 지시문 0.8천(인용 포함 1.2천), 직전 요청 뒤 새로 붙은 것 3천, 요약 출력 4천(조사 §3.5의 가정).
- 따뜻하고 최근 부분이 lookback 안(대부분): older 요청이 older 끝을 덮는 최근 항목을 읽어 **약 $0.26**이다. 전체 요청은 최근 부분만큼 더 읽어 **약 $0.28**이라 보내지 않는다(`short`). 실측의 작은 대화에서는 압축 한 번에 입력분 $0.0004~0.0016 차이였다(W1·W3).
- 최근 부분이 20칸보다 길고 older 끝을 덮는 요청이 5분보다 전(S1 모양): older는 시스템·도구만 맞아 약 87만을 다시 써 **약 $4.45**, 전체 요청은 직전 요청 전체를 읽어 **약 $0.28**이다. 이때만 전체 요청을 보낸다. 실측의 작은 대화: Haiku 입력분 $0.0067 → $0.0054, Sonnet $0.0179 → $0.0124.

**예시 1. Codex 계정 전환 A→B (GPT-5.6 Sol, 둘 다 Plus)**
- 머묾: `150k×10 + 3k×100` = 1.5 + 0.3 = **1.8 cr**
- 지금 전환: `W_B = 0` → `153k×100` = 15.3 cr → **Δ = +13.5 cr**
- 압축 후 전환(`h_c = 1`, A의 마지막 요청이 5분 이내)
  - 요약 요청 `138k×10 + 8k×500` = 1.38 + 4.0 = 5.38
  - B의 첫 요청 `37k×100` = 3.7
  - 합계 9.08 → **Δ = +7.3 cr**
  - 이후 요청당 `37k×10 + 3k×100` = 0.67 cr. 머물 때는 1.83이므로 **−63%**다.
- 전환 후 압축(A가 이미 소진된 경우)
  - no-compact = 15.3 + 1.83(H−1)
  - compact = 13.8 + 4.0 + 3.7 + 0.67(H−1) = 21.5 + 0.67(H−1)
  - gain = −6.2 + 1.16(H−1) → **H ≥ 7 요청이면 이득**이다. 에이전트 턴 하나로 쉽게 넘는다.
- cold point: codex TTL 상한을 모른다. 트리거는 `either`다.
  - 다음 압축 직후에 걸리면: `Δ_cp ≈ 12k×(100−10)` ≈ **+1.1 cr**
  - 60분 유휴에 걸리면: **≈ 0(불확실)**. 60분 뒤에도 A 캐시가 살아 있으면 머무는 쪽이 더 쌌으므로 실제 추가 비용이 생긴다. 그 상한은 지금 전환과 같은 +13.5 cr이다.
  - 표시: `+0~1.1 cr (불확실)`
- 새 세션 인계
  - A에서 요약 생성 `150k×10 + 3k×100 + 6k×500` = 1.5 + 0.3 + 3.0 = 4.8
  - B의 첫 요청 `(12k+6k+2k)×100` = 2.0
  - 합계 6.8 → **Δ = +5.0 cr**. 문맥 일부를 잃는다.
- **권장(`recommended`)은 `지금 전환`이다**(5.6). 153k는 대상 기준(gpt-5.6-sol의 Codex 창 872k면 741,200, 272k 창이어도 231,200)의 80%보다 작아 대상에서 곧 압축되지 않으므로, 비용만으로 압축을 권하지 않는다(07 §6.2 #11). A가 소진된 경우도 153k가 대상 창의 60%보다 작아 `지금 전환`이다(07 §6.2 #10). 위 비용은 모두 선택지 옆에 그대로 보인다.

**예시 2. Anthropic 다른 workspace로 전환(같은 org, Opus 5.5)**
- 머묾: `150k×0.20 + 3k×5.00` = $0.030 + $0.015 = **$0.045**
- 지금 전환: `153k×5.00` = $0.765 → **Δ = +$0.72**
  - 1h 모드이면 `153k×8.00` = $1.22다.
  - 이때 cache_creation 153k가 **같은 org의 ITPM**을 쓴다. 한도 여유는 늘지 않는다[R-verify #4]. 그래서 같은 org 안의 자동 전환은 workspace 한도가 원인일 때만 한다.
- 압축 후 전환
  - `h_c = 0`인 경우(최근 창을 만드는 데 5분 넘게 걸림): 요약 요청 `138k×5.00` = $0.69 + 요약 출력 `8k×20.00` = $0.16. B의 첫 요청 `37k×5.00` = $0.185. 합계 $1.035 → **Δ = +$0.99**
  - 지금 전환(+$0.72)보다 **비싸다.** 이후 요청이 작아지는 이득(요청당 `37k×0.20` vs `153k×0.20`, 약 $0.023 절감)은 12요청쯤 지나야 따라잡는다. 그래서 UI는 "Anthropic에서는 압축 이득이 작을 수 있음"을 표시하고 AC-P09로 측정한다.
  - `h_c = 1`인 경우: `138k×0.20` = $0.028 + $0.16 + $0.185 = $0.37 → **Δ = +$0.33**. 이때는 이득이다.

**예시 3. A로 돌아오기(Anthropic, TTL 안)**
- 상황: B에서 3턴, 4분 뒤 A로 돌아온다. `L_A = 150k`, 새 부분 11k(A의 마지막 출력 1k + B 구간 8k + 새 메시지 2k), 12 block.
  - `W_A = 150k` → `150k×0.20 + 11k×5.00` = **$0.085**(cold $0.805 대비 약 1/9)
- B 구간이 30 block이고 watermark가 없으면: `W_A ≈ Z` → 약 **$0.75**. watermark hint가 있으면 다시 $0.085가 된다(4.5).
- 7분 걸렸다면(5분 TTL 초과): cold($0.805)다.
  - 떠나기 전에 1h 모드를 켰다면 추가 비용은 범위로 보인다: 최선 `3k×(8−5)` ≈ $0.009, 최악(5m prefix를 1h로 다시 씀) `150k×8.00` ≈ $1.2 ⚠AC-P16.

**예시 4. 프로바이더 전환: Codex(5.6 Sol) → DeepSeek v4-pro(피크), ρ = 1.0**
- DeepSeek 첫 요청: `153k×1.32` = **$0.20**(비피크 $0.10)
- 이후 요청당: `153k×0.044 + 3k×1.32` ≈ $0.011
- Codex에 머물 때: 요청당 1.83 cr
- 40분 뒤 Codex로 돌아오면
  - `W^lo = 0`(TTL_lo 5분)이면 15.3 cr
  - `W^hi`는 모른다. 표시는 "+13.5 cr (캐시가 살아 있으면 더 적음)"이다.

**예시 5. 한도 % 표시 형식(가상 수치)**
- 부분 보정으로 `k_u = 8.0e-5 %/토큰`을 얻었다고 하자. `k_c ∈ [0.1·k_u, 1·k_u]`다.
- 지금 전환: B에서 U = 153k → `153k × 8.0e-5` = **12.24%**
- 머물 때: A에서 C = 150k, U = 3k → `150k × [0.8e-5, 8.0e-5]` + `3k × 8.0e-5` = `[1.2%, 12%] + 0.24%` = **[1.44%, 12.24%]**
- 전환 추가분 Δ = 12.24% − [1.44%, 12.24%] = **[0%, 10.8%]** → 표시 `5시간 한도 +0%~+11% (보정 중)`
  - 범위의 아래 끝(0%)은 cached 토큰이 구독 한도에서 uncached와 같게 셀 때다. 그러면 전환해도 한도 소비가 늘지 않는다.
- 대화상자는 Δ(추가분)를 주 숫자로 보이고, 전환 첫 요청이 쓰는 양(`12.2%`)은 `[자세히]`에 보인다. 두 숫자를 섞지 않는다.
- 숫자는 형식을 보여 주는 예시일 뿐이다.

### 6.5 UI 출력 계약

`switch.estimate`의 `options[]`를 03 §6.3 대화상자가 그대로 쓴다.

```
B(ChatGPT · 개인 · GPT-5.5 high)로 전환 — 현재 문맥 153k
 ◉ 지금 전환 (권장)     +13.5 cr              5시간 한도: 보정 중
 ○ 압축 후 전환          +7.3 cr               이후 요청당 −63%
 ○ 캐시가 식은 뒤 전환    +0~1.1 cr (불확실)     다음 압축 직후 또는 약 60분 유휴 · Codex 캐시 유지 시간 미측정
 ○ 새 세션으로 인계       +5.0 cr               문맥 일부 손실
 ─ 더 보기
 ○ 곁가지 포크           +13.5 cr              원 세션은 A 캐시 유지
```

- `Δ_lo ≠ Δ_hi`이면 `+X~Y`로 쓴다.
- `recommended`는 5.6의 권장 규칙으로만 붙인다. 위 예시는 문맥이 대상 기준의 80%보다 작아 `지금 전환`이 권장이다. `압축 후 전환`이 더 싸게 보여도 비용만으로는 권하지 않는다(07 §6.2 #11). 03은 이 값을 그대로 표시한다.
- 각 선택지에 `display:"primary"|"secondary"`를 붙인다. 03 §6.3 대화상자의 네 선택지(압축 후 / 지금 / 캐시가 식은 뒤 / 새 세션)가 primary이고, `fork`는 secondary("더 보기")다. `switch-then-compact`는 소스를 쓸 수 없을 때 `compact-then-switch` 자리를 대신한다(03 §6.3 비활성 문구).
- 신뢰도 표시: 이 세션의 측정 step 수와 추정기 최근 오차를 쓴다(7.7). 03의 "신뢰도 중간 (측정 14단계 기반)"이 이것이다.

---

## 7. 한도와 사용량 텔레메트리

### 7.1 kind별 출처

수집 지점의 hook과 poller는 own slot이면 own-accounts의 것이고, Claude 슬롯(`anthropic`)이면 own-telemetry의 것이다(4.1, 01 §14.1).

| kind | 신호 | 수집 지점 | 비고 |
|---|---|---|---|
| codex | 헤더 `x-codex-primary-used-percent`(float), `-primary-window-minutes`, `-primary-reset-at`(epoch 초), `secondary-*`, `x-codex-credits-{has-credits,unlimited,balance}`, `x-codex-rate-limit-reached-type`, `x-codex-limit-name`. 추가 제품군 `x-<limit_id>-primary-*` | `http.response`. `transport:"websocket"` slot에서는 compaction·title 같은 HTTP 요청에서만, `transport:"http"` slot에서는 **모든 primary 응답**에서 | 파서 `[R-codex-rl]` 28-110,188-240,263-272. 실측(2026-10-18): 모든 HTTP 응답에 온다. 같이 오는 `x-codex-plan-type`, `x-codex-active-limit`, `x-codex-primary-over-secondary-limit-percent`는 읽지 않는다. 창이 하나인 요금제(`promax`)는 primary가 주간(10080분)이고 secondary 제품군이 비어서 온다(`0`, `0`, `""`, `0`): codex-rs `has_data`처럼 사용률·길이가 0이고 `reset-at`이 없으면 창을 만들지 않는다(`reset-after-seconds: 0`만으로는 만들지 않음). credits 플래그는 `True`/`False` |
| codex | WS 본문 이벤트 `{"type":"codex.rate_limits","plan_type","rate_limits":{"primary":{"used_percent","window_minutes","reset_at"},"secondary":…},"credits":{…},"metered_limit_name"}` | `experimental.ws.receive`(WS slot) | `[R-codex-rl]` 125-175. v2는 이 이벤트를 무시만 한다. 실측(2026-10-18, AC-P15): **응답마다 첫 프레임으로 온다**(한 소켓의 두 번째 응답에도). 모양 `{type, plan_type, rate_limits:{allowed, limit_reached, primary:{used_percent, window_minutes, reset_after_seconds, reset_at}, secondary|null}, code_review_rate_limits, additional_rate_limits, credits:{has_credits, unlimited, balance:"<소수 문자열>"}, promo}`. 이어서 `codex.response.metadata`(`headers`에 `x-models-etag`, `x-codex-turn-state`. 한도 없음)가 온다. WS 핸드셰이크 응답 헤더에는 한도 헤더가 없다(그래서 P-005는 필요 없다). own 경로(own.accounts codex slot, codex 하네스와 기본 하네스 모두, 소스와 2.0.24-own.3 릴리스 빌드)에서 이 프레임이 `quota.snapshot`·`quota.updated`의 `codex.primary`·`codex.credits`가 되는 것을 실계정으로 확인했다(`packages/own-harness/script/live/limits.ts`) |
| codex | `GET <chatgpt>/wham/usage`(`https://chatgpt.com/backend-api/wham/usage`, Codex CLI `/status`가 읽는 것. 2026-10-18부터 켜짐, CL) | own-accounts leader poller | 요청 경로(헤더·프레임)가 15분 안에 창을 주지 않은 codex 계정만 15분마다 묻는다(앱을 막 켰을 때, 대화가 없는 계정, 관측이 오지 않은 경로의 빈칸). 토큰을 갱신하지 않는다: 유효 시간이 10분 넘게 남은 로그인만 묻고, 상태도 바꾸지 않는다. `pollBalance:false`면 끈다. 모양 `{plan_type, rate_limit:{allowed, limit_reached, primary_window:{used_percent, limit_window_seconds, reset_after_seconds, reset_at}, secondary_window}, additional_rate_limits:[{limit_name, metered_feature, rate_limit}]|null, credits, rate_limit_reached_type:{type}|null, rate_limit_reset_credits:{available_count, applicable_available_count}|null}`(`Windows.codexUsage`, `source:"poll"`). `rate_limit_reset_credits`는 창이 아니라 리셋권 수다(7.1.1, `ResetCredits.fromUsage`). 같은 poll이 창과 함께 그 수를 올린다. `endpoints.codex`를 옮긴 시험은 루트도 옮겨진다(`…/backend-api/codex` → `…/backend-api`) |
| siwc | codex와 같은 요금제 헤더 제품군(`x-codex-primary-*`, `-secondary-*`, `x-codex-credits-*`, `x-<limit_id>-primary-*`, reached-type)과 `x-ratelimit-*`를 모두 읽는다(`Windows.fromResponse`, 2026-10-10). 창 id·라벨·정규화는 codex와 같다(`codex.primary` "5시간", `codex.secondary` "주간", `codex.credits`). 오류 응답(status ≥ 400)의 헤더도 `source:"error"`로 읽는다. 실제 토큰 공유 응답은 둘 다 싣지 않는다(SW, 2026-10-22, 12장 48): 사용자 설치에서 2026-10-10~22에 siwc 응답이 창을 하나도 만들지 않았다(`state\limits.json`에 siwc 창 없음). 같은 `http.response` hook의 속도 판정이 그 응답들을 읽었으니 hook은 돌았다. 그전 실측도 같다(primary 97개, 창 0개). 그래도 둘 다 계속 읽어서, route가 싣기 시작하면 곧바로 막대가 된다. 요금제 헤더가 없는 첫 primary 성공 응답은 계정·인스턴스마다 한 번 로그 `limits_absent{accountID, providerID, headers}`(헤더 이름만, 값 없음, 7.2 로그)로 남는다. 그 응답들은 모두 Codex 세션 헤더 없이(`Authorization`만) 보낸 요청의 답이었다. 2026-10-24부터 요청이 업스트림 토큰 공유처럼 `session-id`·`thread-id`·`x-client-request-id`를 싣는다(3.2c "세션 헤더"). 이 헤더가 route의 요금제 헤더에 영향을 주는지는 모른다 ⚠. 새 빌드를 처음 켠 뒤 첫 요금제 없는 응답이 다시 `limits_absent`를 남기므로 로그로 확인한다 | `http.response`(siwc slot은 HTTP) | WebSocket이 없어 `codex.rate_limits` 프레임도 없다(토큰 공유는 HTTP만). poller도 없다(SW에서 다시 확인): OpenAI 토큰 공유 안내(developers.openai.com/siwc, models-and-inference)가 이 흐름을 ChatGPT `backend-api` endpoint로 보내지 말라고 하고, access token의 인증 정보는 앱이 읽을 수 없다(token-reference: `encrypted_auth_metadata`, account id 없음). 그래서 `wham/usage`(`backend-api`)를 siwc 토큰으로 부르지 않는다. 사용 한도는 429 `subscription_sharing_usage_limit_exceeded`의 소진(3.2c)으로만 알고, 공식 안내도 그때 ChatGPT 설정 > 사용량으로 안내하라고 한다. 그 429 본문이 리셋(`resets_at`, `resets_in_seconds`)을 말하면 다 찬 창 `siwc.usage`가 된다(3.2c, `Windows.sharingLimit`). UI는 창이 없으면 `own.lim.sharingUnreported`를 보이고 카드에 `사용량 관리` 링크를 둔다(3.2c). 헤더 확인은 로그의 `limits_absent`와 `usage_limit_answer`(429의 헤더·본문 필드 이름)나 `bun own/scripts/siwc-limits-check.ts`(7.8 캡처를 siwc slot에만 켜고 헤더 이름, 한도형 헤더 값, 스트림 이벤트 종류를 출력)로 한다 |
| anth | `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`, `retry-after`, `anthropic-workspace-id`, 오류 코드 | `http.response` | core는 이 헤더를 실패 때만 파싱한다(`executor.ts:42-78,119-140`). 성공 응답은 우리가 읽는다 |
| oai | `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`(reset은 `6m0s` 같은 기간 문자열), `openai-organization` ⚠ | `http.response` | cached 토큰도 TPM에 포함된다[R-verify] |
| ds | `GET /user/balance` → `{is_available, balance_infos[{currency,total_balance,…}]}` ⚠. 402 | own-accounts leader poller, `http.response` | rate-limit 헤더는 문서에 없다. 웹 검색 `own-deepseek`(9.2)의 과금 검색도 이 잔액에서 빠지고, 이벤트 원장에 `websearch` 줄로 남는다(사용량 원장·예산에는 들지 않음) |
| xai | `x-ratelimit-*` ⚠. 키 정보 조회 ⚠ | `http.response`, own-accounts leader poller | |
| or | `GET /api/v1/key` → `{data:{usage, limit, limit_remaining, is_free_tier, rate_limit}}` ⚠. `/api/v1/credits` ⚠ | own-accounts leader poller | |
| compat | `x-ratelimit-*`가 오면 읽는다. 없으면 로컬 집계만 | `http.response` | |
| claude 슬롯 | 헤더 `anthropic-ratelimit-unified-{status, reset, representative-claim}`와 창 제품군 `{5h, 7d, 7d_oi}-{utilization, reset, status, surpassed-threshold}`, `overage-{status, utilization, reset, surpassed-threshold, in-use, disabled-reason}`. 오류 본문의 추가 사용량 거절 문구(8.9). Anthropic은 이 헤더를 문서로 밝히지 않는다(이름과 값은 Claude Code 소스·사용자 보고, 8.9). Claude Code는 창 표 `[five_hour, 5h], [seven_day, 7d], [seven_day_overage_included, 7d_oi], [overage, overage]`를 돌며 제품군마다 `-utilization`, `-reset`, `-surpassed-threshold`를 읽는다. `7d_oi`는 그 앱이 "Fable limit"이라 부르는 모델별 주간 묶음이고, 그 창을 싣는 계정의 응답에만 온다(LV, 2026-10-24). 최상위 `reset`은 `representative-claim`이 제품군 없는 모델 주간 창(`seven_day_opus`, `seven_day_sonnet`)을 가리킬 때만 그 창의 리셋으로 읽는다. 읽지 않는 것: `fallback`, `fallback-percentage`, `grace-*`, `overage-scope`, `overage-period*`, `slow-*`, `upgrade-paths`. Claude Code의 OAuth 사용량 API(`seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, `model_scoped`)는 부르지 않는다(03 §7.1) | own-telemetry `http.response`(claude-auth **뒤**) | 성공 응답에도 온다. 8.5, 8.9 |
| 지출(API) | 우리 ledger가 토큰×요율로 집계한다. Admin/Usage API는 admin 키가 필요해서 MVP에서 뺀다 | ledger | 계정 `budget`과 비교한다 |

**Codex 한도 수집의 결정 순서**(요구사항 3: 5시간·주간 사용률과 리셋 시각을 늘 보여 준다)
1. AC-P15에서 WS `codex.rate_limits` 프레임이 매 턴 오는지 본다. 오면 codex slot은 `transport:"websocket"`을 유지한다.
2. 오지 않으면 codex slot의 `transport`를 `"http"`로 바꾼다(3.6). 코어 패치 없이 매 primary 응답의 `x-codex-*` 헤더를 `http.response`로 얻는다. 잃는 것은 WS 증분 업로드뿐이다.
3. P-005(WS 응답 헤더 hook)와 `wham/usage`는 2번도 쓸 수 없을 때만 검토한다.
- 결정은 slot 정책 값(`slots[pid].transport`)으로 두고, 결과를 AC-P04·AC-P15 기록에 남긴다. 사용자는 설정에서 slot마다 바꿀 수 있다.
- 결과(2026-10-18, CL): 1번이 맞다. 프레임이 응답마다 오므로 codex slot은 `websocket`을 유지한다. 앱을 막 켰거나 대화가 없을 때의 빈칸은 3번의 `wham/usage` poll이 메운다(위 표).

#### 7.1.1 리셋권(사용 한도 리셋 크레딧, RP 2026-10-26)

ChatGPT는 구독 계정에 사용 한도를 지금 다시 채우는 **리셋권**(usage limit reset credit)을 가끔 준다. Codex CLI의 `/usage` > `Redeem reset`이 그것을 쓴다(`refs/codex` `codex-rs/backend-client/src/client/rate_limit_resets.rs`, `tui/src/chatwidget/usage.rs`). own은 `codex` 계정에서만 그 수를 보이고, 사용자가 확인한 뒤에만 쓴다.

- **대상**: `codex` kind만이다. Sign in with ChatGPT(`siwc`)는 토큰을 `backend-api`로 보내지 말라는 안내 때문에 묻지도 쓰지도 않는다(7.1 siwc 행). Claude 구독은 8.5, API 키에는 리셋권이 없다. 나머지 kind의 세 메서드는 업스트림 요청 없이 `not_supported{kind}`로 답한다.
- **끝점**(경로는 codex-rs의 `PathStyle::ChatGptApi`, 루트는 `endpoints.chatgpt`):

  | 요청 | 모양 | 쓰는 곳 |
  |---|---|---|
  | `GET <chatgpt>/wham/usage` | `rate_limit_reset_credits:{available_count, applicable_available_count}` | leader poller(7.2), 소진 때 한 번, 대화상자, 쓴 뒤 한 번 |
  | `GET <chatgpt>/wham/rate-limit-reset-credits` | `{credits:[{id, reset_type, status, granted_at, expires_at\|null, title?, description?, …}], available_count, total_earned_count}` | 대화상자만 |
  | `POST <chatgpt>/wham/rate-limit-reset-credits/consume` | 본문 `{"redeem_request_id": <uuid>, "credit_id"?: <id>}`, 답 `{code, windows_reset}` | `redeem.execute`만 |

  - 수는 0 이상의 정수만 받는다. 없거나 `null`이거나 형식이 틀리면 수를 모르는 것이다(`ResetCredits.fromUsage`). `applicable_available_count`는 받은 그대로 둔다. 무엇을 세는지는 문서도 Codex도 말하지 않는다 ⚠(실측 2026-10-26: 01은 `{2, 0}`, 03은 `{0, 0}`, Codex는 읽지 않는다). 그래서 화면과 판단에는 `available_count`만 쓴다.
  - 목록의 시각은 RFC 3339이고 epoch ms가 된다. `expires_at:null`은 기한 없음이다. 모르는 `status`는 `unknown`, `reset_type`은 받은 그대로다. id나 읽을 수 있는 `granted_at`이 없는(또는 `expires_at`을 읽을 수 없는) 항목은 버린다(`ResetCredits.fromDetails`).
  - 답 `code`는 `reset`·`nothing_to_reset`·`no_credit`·`already_redeemed` 넷이고 `windows_reset`이 없으면 0이다(codex-rs와 같다). 다른 `code`는 답이 없는 것으로 본다.
  - `x-openai-codex-luna-reserve`는 보내지 않는다(Codex도 수동 조회에는 보내지 않는다).
- **저장**: `Limit.ResetCredits{accountID, providerID, availableCount, applicableCount?, credits?, observedAt, source:"poll", origin?}`는 창(`LimitWindow`)이 아니다. 순위·소진·카드 상태에 들지 않는다. 런타임 한도 저장소가 계정마다 최신 관측을 두고(`Limits.Store.upsertCredits`) `state\limits.json`의 `resetCredits`에 저장한다(`schemaVersion`은 1 그대로, 옛 파일에는 없다). 수만 읽은 관측은 수가 같으면 알고 있던 목록을 남긴다. 화면은 `observedAt`으로 나이를 보인다. 유료 `codex.credits`(7.3)와는 코드에서도 문구에서도 따로 둔다.
- **읽는 때**: 규칙은 7.2 poller와 같다. leader만 읽는다. 토큰의 남은 시간이 10분을 넘을 때만 읽고 갱신하지 않는다. `pollBalance:false`면 백그라운드 읽기를 끈다. siwc는 묻지 않는다.
  - poller가 이미 읽는 `wham/usage`마다 수를 함께 올린다.
  - `codex` 계정의 hard 소진이 기록될 때(`exhausted` 방송) 아는 수가 15분보다 오래되었거나 없으면 `wham/usage`를 한 번 더 읽는다. 읽기가 실패해도 그 계정은 15분 안에 다시 읽지 않는다.
  - 대화상자를 열 때와 대화상자의 `새로 고침`, 펼친 줄의 `리셋권 확인`(`quota.resetCredits.list`): 목록과 `wham/usage`를 함께 읽는다(각 10초). 계정마다 최소 2분 간격이고 그 안에는 마지막 답을 돌려준다. 실패한 읽기는 다음 읽기를 막지 않는다. `/consume`을 보내면 답이 오든 안 오든(답을 잃은 시도는 이미 쓰였을 수 있다) 다음 `list`는 바로 다시 읽는다. 보내기 전이나 보내는 동안 읽은 목록은 다시 주지 않는다(RP-13, Codex TUI도 열 때마다 다시 읽는다). 그 목록으로 새 확인(새 요청 id)을 하면 리셋권 하나를 더 쓸 수 있기 때문이다.
  - 쓴 뒤(`reset`, `already_redeemed`) `wham/usage`를 한 번 읽는다. 그 읽기가 실패하거나 수가 없으면 수는 **모름**이 된다(Codex와 같다). 저장소에서 지우고(`Limits.Store.forgetCredits`, `limits.json`에서도 빠진다) 다음 `quota.updated`가 `resetCredits: null`을 싣는다. 지우기는 그 읽기의 창을 알리기 전에 한다(알림의 `quota.updated`가 저장소의 수를 싣기 때문이다. 거꾸로면 다음 틱까지 약 5초 동안 쓰기 전의 수가 다시 보였다, MR7-3). 쓰기 전의 수를 남은 수로 보이지 않는다.
  - 백그라운드 읽기(poller, 소진)는 목록 끝점을 부르지 않는다. 대화상자만 부른다.
- **쓰기는 두 단계다**(01 §13의 파괴적 동작 규칙). control location에서 PC의 runtime leader가 돌린다. 원격 서비스(SSH 호스트)는 세 메서드 모두 `remote_managed`로 답한다: 호스트는 리셋권을 읽지도 쓰지도 않는다.
  - `quota.resetCredits.redeem.plan{accountID, creditID?}`: 요청을 보내지 않는다. `redeem_request_id = crypto.randomUUID()`를 정해 1회용 nonce(10분, `Nonces.Scope`)에 묶고, 확인 화면이 말할 것(계정 이름, 목록이 알려 준 그 리셋권의 제목·기한, 지금 창)을 돌려준다.
  - `quota.resetCredits.redeem.execute{nonce}`: `/consume`을 보낸다(로그인 헤더 + `content-type: application/json`, 10초).
    - 네 `code` 중 하나가 오면 nonce를 쓴다(다시 못 쓴다).
    - 연결 실패·시간 초과·오류 상태·모르는 답은 `limit_reset_failed{reason, status?, retryable:true}`이고 nonce를 남긴다. 다시 시도는 **같은** `redeem_request_id`를 보낸다. ChatGPT는 같은 id를 한 번만 쓰므로(두 번째는 `already_redeemed`) 답을 못 받은 시도 뒤의 재시도가 리셋권을 두 번 쓰지 않는다.
    - `reset`·`already_redeemed`: `wham/usage`를 다시 읽어 창과 수를 올리고(`quota.updated`), 그 계정의 소진을 지워 `account.status{ready}`가 되게 하고, 로그 `reset_credit_redeemed{accountID, outcome, windowsReset}`를 남긴다(토큰·리셋권 id·요청 id 없음). 고른 리셋권은 알던 목록에서 뺀다.
    - `nothing_to_reset`: 지금 리셋할 한도가 없고 리셋권은 그대로다. `no_credit`: 고른 것이 없으면 남은 리셋권이 없다(수 0을 올린다, codex-rs와 같다). 고른 리셋권이면 그것을 더는 쓸 수 없다(목록을 다시 읽게 한다). 둘 다 로그 `reset_credit_refused{accountID, outcome}`.
    - 로그인이 쓸 수 없는 상태면 `credential_not_ready{accountID, cause}`이고 요청도 갱신도 하지 않는다(nonce는 남는다). `cause`는 화면이 까닭을 말하게 한다: `expiring`(10분 이하 남음), `needs_reauth`(계정 상태가 `needs_reauth`이거나 로그인이 거절·손상됨), `missing`(저장된 로그인 없음), `source_stale`(이전 앱이 연결된 로그인을 갱신하지 않음), `unusable`(그 밖). `list`와 `plan`도 같다. 로그인 헤더는 `credentials.headersFor`를 refresher 없이 부른다. `logins.headers`는 401 뒤의 첫 사용에 갱신할 수 있어서 쓰지 않는다.
- **자동으로 쓰지 않는다**: 전환, 자동 전환, 재시도·소진 hook, 팀, 울트라, 프리셋, 시작, poller 어디에서도 `/consume`을 부르지 않는다. 쓰기는 UI에서 사용자가 확인 버튼을 누른 뒤의 `execute`뿐이다(03 §7.1.1). 소진 hook은 수를 읽기만 한다.
- **범위**(9.1): `list`는 계정의 로그인으로 ChatGPT에 묻는 점검이라 `accounts.test`처럼 `admin`, `redeem.plan`·`redeem.execute`는 리셋권을 되돌릴 수 없게 쓰므로 `local`이다. 휴대폰과 다른 PC는 수(`quota.snapshot`, `quota.updated`)만 보고 쓰지 못한다.
- **테스트**: 파서 `packages/own-accounts/test/telemetry/parsers.test.ts`(실측 `{2, 0}`, 없음·`null`·음수·형식 오류, 목록의 `expires_at:null`과 모르는 상태, 답 넷), RPC `test/telemetry/limit-reset.test.ts`(가짜 `e2e-kit/fakes/codex.ts`: poller·소진 읽기, `list`의 2분, 1회용·만료 nonce, 시간 초과 뒤 같은 id, 500, `not_supported`·`credential_not_ready`에 업스트림 요청 0, 성공의 `quota.updated`·`ready`, 소진과 poll이 이어져도 `/consume` 0, 답을 잃은 쓰기와 500 뒤 2분 안의 `list`가 다시 읽음, 쓴 뒤 읽기에 수가 없거나 읽기가 실패하면 수 모름과 `resetCredits: null`, `credential_not_ready`의 `cause` 넷), 실서버 `test/integration/e2e.test.ts`(소진이 수를 한 번 읽고 아무것도 쓰지 않음), 런타임 `own-runtime/test/ledger.test.ts`, 실계정 포워더 `own-harness/test/unit/live-forwarder.test.ts`(`rate-limit-reset-credits` 경로는 어느 길로도 404, 자격 증명을 읽기 전).

#### 7.1.2 5시간 창이 없는 Claude 계정(N5H 2026-11-03)

Anthropic이 2026-10-30부터 **인증된(verified) Ultra 계정**(옛 Max 20x)의 5시간 한도를 없앴다. 그런 계정에는 주간 한도(전체 모델 주간과 Fable 주간)만 있다. Anthropic 안내(support.claude.com "What is the Ultra plan?", "How do usage and length limits work?", 2026-11 기준)는 이것을 "five-hour limit"이 없다고 말하고, claude.ai 사용량 화면에서는 `Current session` 막대가 사라진다고 한다. 인증 전 Ultra 계정은 임시 한도가 있고, Pro와 Max는 그대로 5시간과 주간이 다 있다. Claude Code 문서(status line `rate_limits`)는 `five_hour`, `seven_day`가 "각각 따로 없을 수 있다"고 적고, 사용자 보고(2026-11-01)에서 그런 계정의 값은 `{"seven_day": …}`뿐이고 `five_hour` 키가 아예 없었다. Claude Code 변경 기록에는 이 변경 항목이 없다. 그 계정의 unified 헤더 모양은 공개된 자료가 없다 ⚠: own은 `5h-*` 제품군이 빠져 오는 것으로 본다.

- **규칙**: 다음 관측 하나가 그 계정(서명한 계정, 8.5)에 5시간 창이 **없다**고 말한다. 그러면 저장소가 그 계정의 `claude.5h`를 잊는다(`Limits.Store.drop`, `limits.updated{dropped}` → 그 계정의 `quota.updated`, 연결된 호스트도 잊는다). 모름·0%·소진으로 두지 않는다.
  - claude-auth 경로(own-telemetry `http.response`, PC egress 중계): **성공 응답**(status < 400)이 주간 제품군(`7d-{utilization, reset, status, surpassed-threshold}` 중 하나라도 값이 있음)을 싣고, `5h-*` 헤더가 하나도 없고, `representative-claim`이 `five_hour`가 아니다(`Unified.withoutFiveHour`).
  - Claude Agent 경로: 사용량 답이 요금제 한도를 주고(`rate_limits_available`이 `false`가 아님) `seven_day`가 있는데 `five_hour`가 없거나 `null`이다(`ClaudeAgent.withoutFiveHour`).
- **말하지 않는 것**: 오류 응답(거절된 요청은 어떤 창을 실을지 다를 수 있다), unified 헤더가 아예 없는 응답(API 키, 헤더를 빼는 프록시, 7.1 siwc처럼), 주간 제품군도 없는 응답(모델 주간만 주장한 응답), `rate_limit_event`(창 하나만 이름 붙인다). 이것들로는 5시간 창을 지우지 않는다.
- **돌아옴**: 뒤의 응답이 `5h-*`를 다시 실으면(인증 전 임시 한도, 요금제 변경) 그 창은 평소처럼 다시 생긴다. 따로 기억하는 표시는 없다: 계정마다 "5시간 없음"은 저장소에 `claude.5h`가 없고 주간이 있다는 사실뿐이다.
- **화면**(03 §7.2): 창이 없으니 막대도 이름도 없다. 사이드바 `사용 중 계정`, 입력창, 전환기, 계정 카드, `계정·한도` 탭, 대시보드 모두 주간이 맨 앞이다. 빈 `5시간` 자리나 `— 알 수 없음`을 두지 않는다.
- **전환·제안**: Claude 계정끼리 고를 때 앞 기준인 5시간 사용률 자리에 그 계정의 주간 사용률을 쓴다(`LimitRank.claudeFirst`, 자동 전환 8.8, Claude Agent 제안 8.10.10). 창이 하나도 없는 계정은 전처럼 맨 뒤다. 5시간 창이 있는 계정끼리의 순서는 그대로다. 5시간 리셋을 기다리거나 경고하는 일은 그 창이 없으니 생기지 않는다. 남은 양(`switch.estimate`의 `remaining.fiveHour`)은 `null`이다.
- **테스트**: `own-accounts/test/claude/unified.test.ts`(규칙, 파서, 저장소), `own-telemetry/test/observe.test.ts`(성공은 지움, 429는 남김, 다시 오면 돌아옴), `own-accounts/test/broker/egress.test.ts`, `test/claude-agent/agent.test.ts`, `test/claude/autoswitch.test.ts`, `own-protocol/test/limit-rank.test.ts`, own-web `limits/summary.test.ts`·`accounts/claude-agent.test.ts`, Playwright `e2e/accounts-limits.spec.ts`.

### 7.2 수집 구현 규칙

- **수집 주체**(01 §14.1)
  - own slot: own-accounts가 모은다. 읽기 전용 `http.response`, `experimental.ws.receive`, 잔액·키 leader poller(DeepSeek, OpenRouter, xAI)를 쓴다.
  - Claude 슬롯(`anthropic`): own-telemetry가 unified 헤더만 모은다.
  - 저장은 모두 `@own/runtime`의 한도 저장소와 단일 ledger writer로 한다. own-accounts는 RPC와 이벤트로 둘 다 내보낸다(9.1).
- **`http.response`는 헤더만 읽는다.** `event.response.body`를 소비하지 않는다(SSE 스트림이 깨진다).
  - 오류 응답(status ≥ 400)만 `response.clone().text()`의 앞 2KB를 읽는다. 오류 응답은 스트림이 아니기 때문이다.
  - 예외: `kind:"generate"`와 `kind:"title"`의 성공 응답은 `response.clone()`의 SSE를 백그라운드 작업으로 끝까지 읽어 usage만 뽑는다(7.5). hook은 이 작업을 기다리지 않고, 원래 `response`는 core가 그대로 읽는다. 내용(텍스트)은 버리고 저장하지 않는다. 두 응답은 짧아(곁질문, 인계 요약, `OK` ping, 제목 한 줄) 복제 버퍼 비용이 작다. 구현은 `packages/own-accounts/src/telemetry/stream.ts`(`StreamUsage`)와 `telemetry.ts`의 `streamUsage`다.
- **Anthropic 1h write 분리(정밀 모드, 기본 꺼짐)**: `response.body.tee()`로 SSE `message_start`/`message_delta`의 `cache_creation.ephemeral_{5m,1h}_input_tokens`를 읽는다 ⚠.
  - core는 providerMetadata를 버리고 cache.write 요율 하나로만 비용을 계산한다(`core/src/session/usage.ts:10-35`). 그래서 1h write는 잘못 계산된다. 코어에서 고치는 것은 원장 P-006(candidate, Phase 3)이다.
- **`ws.receive`**: frame 문자열에 `"codex.rate_limits"`, `"usage_limit"`, `"rate_limit"`, `"response.failed"`, `"type":"error"` 중 하나가 들어 있을 때만 JSON을 파싱한다(01 §14.3). frame은 **그대로** 돌려준다.
- **poller**
  - own-accounts의 프로세스 전역 leader(런타임의 첫 인스턴스, control location 인스턴스가 있으면 그것, dispose되면 다시 뽑음) 하나만 돈다.
  - 계정마다 최소 간격 15분이다. 사용자가 새로고침을 요청하면 2분이다.
  - 최근 24시간 안에 쓴 계정이나 UI가 보고 있는 계정만 조회한다.
  - 계정별로 끌 수 있다: `accounts.update{pollBalance:false}`(9.2, 03 §5.4 "잔액·키 조회 끄기"). 기본은 켜짐이다.
  - codex의 `wham/usage`(2026-10-18, 7.1 표): `pollBalance`가 `false`가 아니면 켜짐이고, 요청 경로가 15분 안에 창을 준 계정은 묻지 않는다.
- **로그**(SW, 2026-10-22): own-accounts의 줄은 stderr와 함께 `OWN_HOME\logs\own-accounts.log`에도 쓴다(`Logger.create{file}`, 한 줄 JSON, Redact를 거친 값). 백그라운드 서비스의 stderr는 시작이 끝나면 아무도 읽지 않는 pipe라서(`client/src/service-contender.ts`가 시작 오류용 8 KiB 끝부분만 보고 놓는다) 그전에는 이 줄이 모두 사라졌다. core의 로그(`~\.local\share\opencode\log\`)에는 플러그인이 쓸 길이 없다. 프로세스마다 버퍼 스트림 하나로 덧붙이고 Location 인스턴스가 그것을 나눠 써서, 로그를 남기는 hook이 디스크를 기다리지 않는다(원격 서비스의 `debug` 수준에서도). 파일이 10 MiB를 넘으면 다음 줄 전에 `own-accounts.log.1`로 옮긴다(하나만 둔다. 크기는 연 때의 파일 크기부터 이 프로세스가 쓴 만큼 센다. 열린 스트림은 옮긴 파일을 따라가 남은 줄을 거기에 쓰고 닫힌다). 옮길 수 없으면(다른 프로세스가 삭제 공유 없이 잡고 있을 때) 1분마다 다시 시도하고, 그동안 파일이 20 MiB(`FILE_CAP_BYTES`)를 넘으면 그 뒤 줄은 버린다. 그래서 파일은 끝없이 커지지 않는다. 열거나 쓸 수 없는 파일은 그 줄만 잃는다(stderr에는 간다). guard가 막은 인스턴스는 OWN_HOME에 쓰지 않는다. 줄에는 토큰도 사용자의 말도 없다: 값은 Redact를 거치고(Bearer 값, 키, JWT, 토큰 이름의 필드), 웹 검색 줄(`websearch_query`)은 질의 없이 걸린 시간·결과 수·오류 코드만, 한도 줄은 헤더와 본문 필드의 이름만 쓴다. 테스트가 실서버 로그 파일의 모든 줄을 이 기준으로 훑는다(`test/e2e-kit` `logLeaks`, `sharing.e2e.test.ts`). 한도와 속도를 볼 때 찾을 줄: `limits_observed`, `limits_absent`, `usage_limit_answer`, `speed_downgraded`, `speed_ignored`, `speed_fallback`, `alert`, `exhausted`.
- **세션 단위 캡처 캐시**: `own-runtime.lastResponse[sessionID] = {providerID, status, headers subset, bodyHead, authHash8, at}`. retry 분류(5.2), 인증 swap 확인(4.2), 턴 안 failover(5.9(h))에 쓴다. TTL은 30초다.

### 7.3 `LimitWindow` 모델

```ts
type LimitWindow = {
  id: string                 // "codex.primary" | "codex.secondary" | "codex.<limitId>.primary"(codex·siwc) | "siwc.usage"(429가 말한 리셋, 3.2c)
                             // | "claude.5h" | "claude.7d" | "claude.7d_oi" | "claude.7d_opus" | "claude.7d_sonnet" | "claude.overage"
                             // | "anth.requests" | "anth.input_tokens" | "anth.output_tokens" | "oai.requests" | "oai.tokens"
                             // | "ds.balance" | "ds.balance.granted" | "or.key_limit" | "api.budget_month"
  accountID: string          // Claude 슬롯은 합성 계정 "acc_claude_slot"
  providerID: string
  scope: "account" | "quota_domain"
  kind: "rolling_quota" | "rate" | "balance" | "spend_cap" | "budget"
  label: string              // "5시간", "주간", "분당 입력 토큰", "잔액", "이번 달 예산"
  windowMinutes?: number     // 300, 10080 …
  usedPercent?: number       // 0..100
  remaining?: number
  limit?: number
  unit?: "requests" | "tokens" | "input_tokens" | "output_tokens" | "USD" | "CNY" | "credits"
  resetAt?: number           // epoch ms
  status: "ok" | "warning" | "exhausted" | "unknown"
  confidence: "live" | "recent" | "stale" | "estimated" | "unknown"
  source: "header" | "ws_event" | "poll" | "error" | "ledger" | "estimate"
  observedAt: number
}
```

**정규화 규칙**

| 원본 | 변환 |
|---|---|
| codex primary/secondary | `usedPercent` 그대로. `resetAt = reset_at×1000`. `label`은 `windowMinutes`로 정한다: 300 → "5시간", 10080 → "주간", 그 밖은 "{h}시간". `status`: 100 이상이거나 reached-type 헤더가 있으면 exhausted, 85 이상이면 warning |
| codex credits | `id:"codex.credits"`, `kind:"balance"`, `remaining = balance`. **창 정보를 지우지 않는다**(이전 프로젝트 `scripts/manager_core/native_usage.py:20-35`의 병합 규칙). 유료 크레딧이고 리셋권(7.1.1, 창이 아님)과 다르다 |
| claude unified | 제품군 `5h` → `claude.5h` "5시간", `7d` → `claude.7d` "주간", `7d_oi` → `claude.7d_oi` "주간 · Fable"(LV, 2026-10-24). `usedPercent = utilization×100`(1을 넘으면 100을 넘는다, 예: `7d_oi-utilization: 1.02` → 102), `resetAt = reset×1000`. `status`: rejected → exhausted, allowed_warning → warning, allowed → ok. `surpassed-threshold`가 오면(Claude Code의 읽기) allowed나 상태 없는 창도 warning이다. 상태 헤더가 없으면 사용률로 정한다(100 이상 exhausted, 85 이상 warning). `representative-claim`이 `seven_day_opus`나 `seven_day_sonnet`이면 그 창의 제품군 헤더가 없으므로 최상위 `status`와 `reset`으로 `claude.7d_opus` "주간 · Opus" / `claude.7d_sonnet` "주간 · Sonnet"을 만든다(사용률 없음, 상태만). `representative-claim`은 모든 창의 `meta.representative`로 둔다. 화면의 가장 빠듯한 창은 이 값이 아니라 남은 양으로 고른다(03 §7.2): Anthropic은 주간이 훨씬 빠듯해도 `five_hour`를 보낸다(anthropics/claude-code#12829: 5시간 1.8% 사용, 주간 73.7% 사용). `claude.overage`만 `meta.billing`(`extra_usage`\|`rejected`, 8.9 판정)과 `meta.disabledReason`(`overage-disabled-reason` 원문)을 더 둔다. `meta.billing`이 바뀌면 의미 있는 변화다(7.4). 모델별 주간 묶음 셋(`claude.7d_oi` Fable, `claude.7d_opus`, `claude.7d_sonnet`)은 계정 전체가 아니라 그 모델 묶음의 요청만 제한한다(own-protocol `LimitModel`, LV 2026-10-24): 모델 id에 `fable`·`opus`·`sonnet`이 든 요청만 막고, 계정 요약(`accounts.list`의 `limitsSummary.worst`)의 후보가 아니다. 화면의 가장 빠듯한 창(03 §7.2), Claude 계정끼리의 자동 전환 대상(8.8), 리셋까지 대기(5.9(i)), 소진 기록(5.2)이 이것을 따른다. `claude.overage`(추가 사용량)는 요금제 너머의 여유이지 따로 선 한도가 아니다(own-protocol `LimitRank.extra`, LV 2026-10-24): 순위에 들지 않고, 계정 요약을 정하지 않으며, 혼자서는 계정을 막지 않는다(자동 전환 대상 8.8, 리셋까지 대기 5.9(i)). 그 판정은 그것이 덮을 요금제 창(그 모델을 막는 `rolling_quota` 창)이 다 찼을 때만 그 창과 함께 앞에 선다(03 §7.2) |
| rate(anth/oai) | `usedPercent = 100·(1 − remaining/limit)`. `resetAt`: anth는 RFC3339, oai는 기간 문자열을 now에 더한다 |
| balance(ds/or) | `remaining`. `is_available=false`이거나 0 이하면 exhausted |
| ds 보너스 | `granted_balance > 0`일 때만 보조 창 `ds.balance.granted`(두 번째 통화는 `ds.balance.<cur>.granted`), `label:"보너스"`, `status:"ok"`. 소진 판단은 늘 `ds.balance`(`total_balance`)이고 `topped_up_balance`는 창을 만들지 않아 두 번 세지 않는다. 다 쓴 보너스는 0으로 한 번 올린다(`Windows.deepseekBalance`) |
| budget | ledger의 이번 달 지출 / `account.budget.monthlyUSD`. 다른 창처럼 `own-runtime` 한도 저장소에 있는 창이다(LV 2026-10-25, 7.4) |

### 7.4 신선도와 병합

- **confidence**
  - `live`: 관측한 지 2분 이내
  - `recent`: 15분 이내
  - `stale`: 15분 초과
  - `resetAt`이 지났는데 새 관측이 없으면 `usedPercent`를 0으로 추정하고 `estimated`로 둔다. 03의 "리셋됨(추정)"이 이것이다.
  - 계정 요약(`accounts.list`의 `limitsSummary.worst`, 9.2)은 모델 없이 매긴 하나의 순위(own-protocol `LimitRank.ranked`, 03 §7.2)의 첫 창이다(LV 2026-10-24). own-web의 모든 화면이 같은 함수로 첫 창을 고른다. 예전의 상태 우선 정렬(소진 > 주의 > 정상, 그다음 사용률)은 화면과 어긋났다: `surpassed-threshold`로 주의인 50%의 5시간이 80%의 주간을 앞섰다. 요약은 그 창의 이름(`label`, 예: `5시간`)도 싣는다(LV 2026-10-25 다섯째 검토, 선택 필드): 카드가 창을 받기 전에도 `주의 · 5시간 남음 16%`로 쓰게 한다. 이름이 없는 옛 서비스의 요약이면 카드는 상태 낱말만 쓴다(03 §5.4).
  - 리셋 없이 관측된 모델별 주간 묶음(7.3)은 관측이 `stale`이 되면(15분 초과) 값은 그대로 두고 `status`를 `unknown`으로 둔다(`LimitModel.lapsed`, LV 2026-10-24). 그 묶음은 그 모델의 응답에만 실려 와서 저장소는 마지막 관측을 계속 들고 있고(다른 모델의 응답은 그 묶음을 지우지 않는다), 리셋이 없으면 막힌 상태를 끝낼 것이 없다. 화면은 그 값을 흐리게 `오래됨` 꼬리표와 함께 보이지만, 그 묶음은 가장 빠듯한 창이 되지 않고 계정을 막지도 않는다. 리셋이 있는 묶음은 다른 창처럼 그 리셋까지 상태를 지킨다.
- **병합**: 같은 `id`는 `observedAt`이 최신인 값을 쓴다. 오류 응답에서 얻은 관측(`source:"error"`)도 최신이면 반영한다.
- 창의 스냅샷 변화가 의미 있으면(사용률 ±1pt, status 변화, 새 창) `own-runtime` 한도 저장소에 올리고, runtime leader 인스턴스가 `state\limits.json`에 저장한다. own slot 창은 own-accounts가, `anthropic`의 `claude.*` 창만 own-telemetry가 올린다. own-accounts leader가 `quota.updated`를 낸다(9.1). 전송 빈도는 계정당 최대 1회/5초다.
- **월 예산 창**(`api.budget_month`, 7.3 budget, LV 2026-10-25)도 저장소의 창이다. 그래서 계정 요약(`limitsSummary.worst`), `quota.updated`, `quota.snapshot`이 같은 창들로 순위를 매긴다. 전에는 `quota.snapshot`만 그때 ledger로 계산해 붙였다: 92% 쓴 예산이 화면의 첫 창인데 카드 상태는 `정상`이었고(서버 요약에 예산이 없었다), 다음 `quota.updated`가 그 계정의 창을 예산 없는 목록으로 바꿔 예산 줄이 사라졌다. own-accounts leader가 시작할 때, 예산이 있는 계정의 ledger 줄(이 PC의 것과 호스트의 것)마다, 계정 설정이 바뀔 때 다시 계산해 올리고, `quota.snapshot`도 답하는 계정의 것을 먼저 다시 계산한다(07 §5.4의 예산 판정이 읽는 값). 지출마다 `remaining`이 바뀌므로 의미 있는 변화이고, 화면은 `quota.updated`로 바로 받는다. 예산을 지운 계정은 그 창을 잃고(`Limits.Store.drop`), 그 계정의 `quota.updated`는 남은 창만, 없으면 빈 목록을 싣는다. 원격 서비스는 계산하지 않는다: 예산도 기록의 ledger도 없으므로 이 PC가 다른 창과 함께 보낸 것을 쓴다(04 §8.4 `quota.updated`). 이 PC가 지운 창은 그 push의 `dropped`(`{accountID, id}`)로 호스트도 지운다(LV 2026-10-25). 전에는 호스트가 받은 창을 합치기만 해서, 지운 예산이 그 달이 끝날 때까지 호스트의 전환 판단에 남았다.

### 7.5 사용량 ledger

**한 줄 형식**(`ledger\usage-YYYY-MM.jsonl`)
```json
{"v":1,"ts":1790001234567,"sessionID":"ses_…","messageID":"msg_…","kind":"primary",
 "accountID":"acc_01JAX3…","providerID":"own-codex-7k2m","modelID":"gpt-5.5","variant":"high",
 "credentialRef":null,"transport":"websocket","switchEpoch":3,"compactionEpoch":1,
 "tokens":{"input":2890,"cacheRead":149120,"cacheWrite":0,"cacheWrite1h":null,"output":812,"reasoning":1204},
 "P":152010,"hit":0.981,"cost":{"unit":"credits","amount":2.39,"source":"ratecard"},
 "costUSDOpenCode":0,"coldExpected":null}
```

**연결 방법(correlation)**: own-accounts의 `ctx.event.subscribe`가 한다(4.1). `anthropic` 세션의 step도 같은 방법으로 기록한다.
1. `session.step.started`에서 `{assistantMessageID → model}`을 얻는다(`session-event.ts:332-344`).
2. `session.step.ended/failed`에서 tokens와 cost를 얻는다(`:358-390`). provider별 cache 필드 매핑은 core가 이미 맞춰 둔다.
   - Anthropic `anthropic-messages.ts:1123-1150`
   - Responses `open-responses.ts:843-859`
   - Chat/DeepSeek `openai-chat.ts:889-910`
3. `kind`: primary는 step 이벤트다.
   - **compaction**은 공개 이벤트 `session.compaction.ended/failed`에서 얻는다. 줄의 `messageID`는 그 압축 메시지 id다(SL 2026-10-26: core와 같은 규칙으로 `session.compaction.started`의 `inputID`, 없으면 그 이벤트 id의 `msg_` 형, 시작을 못 봤으면 `failed`의 `inputID`나 끝 이벤트 id의 `msg_` 형). UI는 이 줄로 압축 표시와 `압축 내용 보기`에 그 요청에 서명한 계정을 적는다(03 §4.5). 그 전의 압축 줄은 `null`이다. 캐시 상태의 watermark(2.4.6)는 압축 메시지를 쓰지 않는다(뒤 요청의 breakpoint가 아님). 두 이벤트 모두 `tokens`와 `cost`를 싣고, `ended`는 `model`도 싣는다(`schema/src/session-event.ts:607-639`). 압축 요청 하나하나가 끝날 때마다 과금되므로 실패·중단된 압축도 사용량이 있다(`core/src/session/compaction.ts:588-598`). `failed`에는 model이 없으므로 `model.request{kind:"compaction"}`에서 기억한 Ref로 채운다. 한 세션은 압축을 동시에 둘 돌리지 않으므로(`compaction.ts:588-589`) 세션별 한 칸이면 된다. 없으면 현재 바인딩을 쓴다.
     - CC(2026-10-24): `ended` 이벤트의 `metadata`(체크포인트의 것)에서 요청 모양을 읽어 줄의 `compaction`(`CompactionCache.Sent` `{request:"full"|"older", reason?, trigger?:"idle"}`)에 적는다. core의 `prefix` 기록이 있으면 그것, 없으면 own-accounts 판정(`own.compaction.cache`)의 `older`와 그 이유다(4.7.5). core 기록이나 own-accounts 판정이 있는 체크포인트를 대체 모델이 썼으면 `{request:"older", reason:"stand-in"}`이다(그 모델의 older 요청, CC-16). P-034 전의 체크포인트, own hook 없이 만든 것, 모델 없이 만든 코드 요약(어떤 요청도 쓰지 않음, CC-13)은 비운다. `hit`은 그 압축의 모든 요청(전체 요청이 실패한 뒤의 older 요청 포함)을 합친 캐시 비율이다. 캐시 상태(2.4.6)의 `lastReqAt`와 `L`은 **마지막으로 보낸** 압축 요청의 것이다: `http.request`에서 잰 보낸 시각, own slot이면 그 응답 스트림이 알린 그 요청 자신의 크기(모르면 합, CC-13).
   - **title**과 **generate**는 아래 "플러그인이 core 이벤트로 받지 못하는 사용량"의 방법으로 채운다.
   - `session.usage.recorded{source:"title"|"compaction"}`(`session-event.ts:158-167`)는 **쓰지 않는다.** 이 이벤트는 공개 manifest에 없어(`session-event.ts:707-711` "Internal and replay-only events are excluded from the public manifest", `:618` "that event never reaches clients") 플러그인의 `ctx.event.subscribe`에 오지 않는다(`core/src/plugin/host.ts:255-265`, `schema/src/event-manifest.ts:71-84`). 이전 판의 "usage.recorded와 직전 `model.request`로 채운다"는 한 번도 발동하지 않는 규칙이었고, 그 결과 압축과 title 요청이 ledger에서 빠져 ⑫ 비용 비교, AC-P09, 예산, 7.6 보정이 모두 적게 셌다. 구현 중인 코드는 이미 이 판의 방법을 쓴다(`packages/own-accounts/src/telemetry/stream.ts:7-8`, `telemetry.ts:608-640,697-760`).
4. 전환 뒤 첫 step이면 추정기 예측값을 `coldExpected`로 넣어 오차를 잰다(AC-P14).
5. `credentialRef`는 풀링 모드에서만 채운다. own-accounts의 `model.request`가 고른 계정의 accountId다.
6. own-accounts가 이 줄을 `@own/runtime`의 단일 ledger writer로 파일에 쓰고(01 §4), 같은 줄을 `ledger.step` 이벤트로 UI에 보낸다(9.3).

**플러그인이 core 이벤트로 받지 못하는 사용량**(v0.3, v0.4에서 title 추가)
- **무엇이 빠지나**(소스 확인)
  - core가 사용량 이벤트를 내는 곳은 step(`session.step.ended/failed`), `session.usage.recorded{source:"title"|"compaction"}`(`core/src/session/title.ts:56-64`, `core/src/session/compaction.ts:592-598`), 그리고 압축의 공개 이벤트 `session.compaction.ended/failed`(같은 수치를 반복해 실음, `session-event.ts:617-620`)다.
  - 플러그인이 받을 수 있는 것은 step과 압축 공개 이벤트뿐이다. **title**의 사용량은 `session.usage.recorded`에만 있어 플러그인에 오지 않는다(위 3번).
  - 세션 `generate`는 응답 usage를 로그로만 남긴다(`core/src/session/generate.ts:63-64`). 이 경로를 쓰는 것:
    - `/btw` 곁질문: upstream app이 `POST /api/session/:id/generate`를 부른다(`app/src/session/btw/model.ts:67`, `protocol/src/groups/session.ts:706`). own-web이 이 기능을 넣으면 같은 경로다([R-gap] #35)
    - core `warming` ping: `ctx.session.generate`로 4분마다 현재 모델에 보낸다(`core/src/plugin/warming.ts:9-13,48-50`). config `warming`을 켰을 때만 돈다
    - 새 세션 인계 요약(5.9(f))
    - `ctx.session.generate`를 쓰는 서드파티 플러그인
  - stateless generate(`ctx.generate.text`, `POST /api/experimental/generate`)는 session hook이 없어 보이지 않는다. own slot에서는 인증이 없어 어차피 401이다(4.1). 이 경로는 세지 않는다.
- **방법**(generate와 title 공통)
  1. **짝 찾기가 필요 없다.** `http.response` 이벤트가 `sessionID`, `kind`, `model`(Ref)을 이미 싣는다(`core/src/session/model-request.ts:211,312-315`). 이전 판의 `own-runtime.pendingGenerate[sessionID]` 간접 참조는 지운다. sessionID로 짝을 지으면 같은 세션의 /btw generate와 warming ping이 동시에 돌 때 서로 섞이기 때문이다.
  2. generate와 title은 WS를 쓰지 않으므로(WS는 primary와 native 압축만, `runner/llm.ts:242`, `compaction.ts:316`) 응답이 항상 `http.response`에 온다. slot 레지스트리 필터 뒤 own slot의 성공 응답이면 `response.clone()`의 SSE를 백그라운드에서 끝까지 읽어 마지막 usage를 뽑는다(7.2 예외). 필드 매핑은 step과 같은 규칙이다: Anthropic `message_start`+`message_delta`의 usage, Responses `response.completed.usage`, Chat 마지막 청크의 `usage`(1–2번 줄의 core 매핑 위치와 같게) ⚠AC-P41.
  3. 줄: `kind:"generate"|"title"`, `messageID:null`, `usageSource:"stream"`, cost는 ratecard(codex credits, API USD. core가 준 USD를 받지 못하므로 `source:"ratecard"`). 캐시 상태(2.4.6)의 `lastReqAt`와 `L`도 갱신한다. generate는 같은 prefix를 읽으므로 캐시를 데운다. title은 prefix가 달라(agent system + 첫 사용자 메시지만, `title.ts:66-71`) 캐시 상태를 바꾸지 않는다.
  4. 파싱에 실패하거나 응답이 끊기면 `tokens:null`, `usageSource:"estimate"`로 남기고 cost는 `P`(generate: 그 세션의 마지막 `L` + 프롬프트 문자 수/4, title: 첫 사용자 메시지 문자 수/4)로 추정한다(`source:"estimate"`). 이런 줄이 한 시간에 3개를 넘으면 `generate_usage_missing`(info) 경보를 낸다(title 포함).
  5. `purpose`(generate만): 같은 백그라운드 작업에서 `event.request`의 본문 사본을 읽어 끝 4 KiB에 warming 프롬프트(JSON 이스케이프)가 있으면 `"warming"`이다. 본문은 HTTP wrapper가 이미 메모리에 버퍼링했으므로(`model-request.ts:305-311`) 추가 I/O가 없다. warming 자신도 마지막 사용자 메시지가 프롬프트와 같은지로 자기 ping을 알아본다(`core/src/plugin/warming.ts:67-76`). 기본 프롬프트(`warming.ts:10`)를 알아보고, 사용자가 config로 바꾸면 own 전역 설정 파일에서 읽은 값을 쓴다. 프로젝트 설정의 값은 놓칠 수 있다 ⚠. 그 밖은 `null`이다. /btw와 인계 요약을 나누는 것은 ⚠(12장).
  6. `anthropic`(Claude 슬롯)의 generate·title은 own-telemetry가 같은 방법으로 usage를 읽어 `own-runtime`에 넘기고, 줄은 own-accounts가 쓴다(4.1 표). 압축은 own-accounts가 공개 이벤트로 직접 적는다.
  7. own의 이미지 도구(9.6, IM 2026-11-03)는 호출마다 `kind:"image"` 줄을 쓴다(`Telemetry.recordImage`). `messageID:null`, 모델은 쓴 이미지 모델, provider는 답한 slot이다. API 키: `tokens`는 Images API `usage`의 입력(캐시 제외)·캐시 읽기·출력, cost는 `OwnImage.RATES`로 낸 USD(`source:"ratecard"`). Codex 구독: `tokens:null`, `cost:null`(구독 한도 창에 남는다). 캐시 상태는 바꾸지 않는다.
  8. 곁질문(9.7, BTW 2026-11-22)은 답마다 `kind:"side"` 줄을 쓴다(`Telemetry.recordSide`). `messageID:null`, 토큰은 core가 응답에서 읽어 돌려준 사용량(`usageSource:"event"`), 비용은 요율표(없으면 core가 낸 USD)다. 같은 요청의 generate 줄은 쓰지 않는다(`http.response`가 `side`를 건너뛴다). step이 아니라서 캐시 상태·경보·압축 판단을 움직이지 않고 턴 바닥줄에도 들어가지 않는다. 계정·세션 합계와 예산에는 들어간다.
- **어디에 쓰이나**
  - 계정·세션 합계(`accounts.usage`, `ledger.session`)와 03의 세션 비용 표시. core의 세션 통계(`session.usage.*`)는 generate를 빼므로 own-web은 세션 비용을 ledger 합계에서 읽는다(03과 맞출 것).
  - 한도 보정(7.6). generate도 구독 한도를 쓰기 때문이다. `tokens:null`인 줄이 든 구간은 보정 표본에서 뺀다.
- **새 필드**(모두 선택, 없으면 이전 의미)
  - `usageSource: "event" | "stream" | "estimate"`(없으면 `"event"`)
  - `purpose: "warming" | null`
  - `server: "local" | <hostId>`(04 §10.4. 없으면 `"local"`)
  - `speed: {requested, served}`(4.8): 보낸 속도 tier와 응답이 말한 tier(`null` = 말하지 않음). 표준 요청은 없다

**비용**
- codex: ratecard credits
- API: core가 준 USD(`step.ended.cost`)를 쓴다. 1h 정밀값이 있으면 ratecard로 다시 계산한다.
  - 예외: 카드에 `peak`(2.4.4)가 있으면(ds) core USD 대신 ratecard로 계산한다(`source:"ratecard"`). core USD는 시각과 상관없는 카탈로그 가격이기 때문이다(6.2). 단가는 요청 시각의 것이다(step은 `started`, 그 밖의 줄은 `ts`. 비피크면 × `offPeakMul`). core가 준 USD는 그대로 `costUSDOpenCode`에 둔다.
  - 사용량이 없어 `P`로 추정하는 줄(`source:"estimate"`)도 요청 시각의 단가를 쓴다.
- Claude 슬롯: 한도 %만 있다. cost는 claude-auth가 `[]`로 두므로 0이다. 예외: Fast 요청은 추가 사용량으로 과금되므로 모드 가격(USD)으로 계산한다(4.8).
- 속도(4.8): 응답이 더 느린 tier를 말하지 않은 Fast·Ultrafast 줄은 `codex`·`siwc`가 ratecard credits × 속도 카드의 `credits`, API는 모드 가격(`source:"ratecard"`, core USD는 `costUSDOpenCode`)이다. 표준으로 처리된 줄은 표준 가격이다.

**집계와 보존**
- 메모리에 (세션×계정), (계정×일), (계정×시간) 합계를 두고, 5분마다 `ledger\rollup.json`에 쓴다. 시간 단위 합계는 03 §5.5의 5시간·7일 추이 그래프(`accounts.usage{groupBy:"hour"}`)에 쓴다. 세션 행에는 `projectID`와 전환 횟수를 함께 둔다.
- 원본은 12개월 보존하고, 지난 달 파일은 gzip으로 압축한다(01 §5.1·§14.2와 같음).

### 7.6 한도 보정(회귀)

- **(계정, 모델)마다 모으는 쌍**: 같은 창의 연속 스냅샷 사이 `Δused%`와, 그 사이 ledger 토큰을 클래스별로 합한 `(U, C, O)`
- **제외**: 창이 리셋된 구간, `Δused% = 0`(해상도 미만)인 구간 중 토큰이 작은 것, `tokens:null`인 줄(7.5 generate 추정)이 든 구간
- 보정 결과는 원격 호스트에 push한다(`calibration.updated`, 04 §8.4).
- **적합**: 음수 없는 최소제곱(`k_c ≤ k_u` 제약), 반감기 7일 가중
- **보정 완료 기준**: 표본 30개 이상이고 R² ≥ 0.6. 그 전에는 6.3 ⑪의 범위 규칙을 쓴다.
- **codex 해상도**: 헤더 값은 float다(`[R-codex-rl]` 테스트의 12.5). 실제 해상도는 ⚠AC-P28.

### 7.7 경보

| 조건 | 동작 |
|---|---|
| 세션당 1시간에 자동 전환 2회 이상, 또는 사용자 없이 10분 안에 A→B→A | `flap` 경보. breaker를 30분 연다 |
| 최근 15분 cold 합계 > 3·P | breaker를 연다. "prefix 변동 의심" |
| 계정에 머무는 동안 rolling hit < 60%. 전환·압축 뒤 첫 step은 빼고, P ≥ 20k, 최근 5 step 기준 | `low_hit`. hook 결정성과 헤더를 점검하라고 알린다 |
| TTL_lo 안에서 돌아왔는데 첫 step hit < 0.8·(L/P) | `return_miss`. lookback, compaction, variant를 점검하라고 알린다 |
| 추정기 오차(예측 cold 대 실측 input+cache.write) > ±25% | `estimator_drift`. ρ와 TTL을 재보정한다 |
| 세션 history에 다른 providerID의 native compaction이 있음 | `native_trap`(오류 수준). 설정을 위반한 것이다 |
| 인라인 이미지 합계가 20 MiB를 넘음 | `image_trim_soon` |
| `anthropic` 연결 유형이 `env` 또는 `key` | `claude_slot_billing`(8.9) |
| provider overlay에 비밀처럼 보이는 문자열이 있음 | `secret_in_overlay`(오류) |
| 관측한 요청의 인증 헤더 hash가 주입 hash와 다름(4.2) | `auth_swap_broken`(오류). slot을 `misconfigured`로 |
| identity 블록을 찾지 못하거나 형식이 다름(D9) | `identity_format_changed`. 6.3 ①은 `Z_pre`로 떨어진다 |
| 종량제 템플릿에 `cost`가 빈 모델(3.6a) | `template_cost_missing` |
| 기본 모델이 own slot(4.1 stateless generate) | `default_model_own_slot`(경고) |
| `anthropic` 오류 응답의 본문 앞 2KB(7.2)에 추가 사용량 거절 문구가 있음(`ExtraUsage.PHRASES`: 400 `Third-party apps now draw from your extra usage`, 팀의 `…draw from extra usage`, `You're out of extra usage`, 429 `Usage credits are required for this model`) | `claude_extra_usage`(위험). 세션 경보. 2026-10-19(CW)부터 뜻을 바로잡았다: 요청은 **거절됐고 청구되지 않았다**(사용자 보고에서 토큰 0). Anthropic이 이 요청을 서드파티 사용으로 보고 추가 사용량에서 내려 했지만 추가 사용량이 꺼져 있거나 모자랐다는 뜻이다. 그 계정의 `claude.overage`를 `meta.billing:"rejected"`로 둔다(8.9). 문구 목록은 `@own/protocol` `extra-usage.ts` 한 곳이다. 서버 문구가 바뀌면 놓칠 수 있다 ⚠(03 §5.4.1(d)) |
| 이 서비스가 어떤 Claude 계정으로 처음 요청을 보냄(8.9, KV `claude:firstRequest:<accountID>`가 없음) | `claude_first_request`(warning, 세션 = 트리의 루트). 계정마다·서비스마다 한 번. 입력창이 붙잡지 않는 알림을 띄운다(03 §5.4.1(d)) |
| Location에 allowlist 밖 프로젝트 플러그인이 있음(4.2, 01 §13.2) | `untrusted_plugin`(오류). Location 상태 `blocked_by_plugin`, 그 Location에서 인증 주입 중지. `plugin.trust.approve.*`로 풀린다 |
| model 없는 세션을 감지함(01 §8.5) | `unpinned_session`(경고). own-accounts가 기본 모델로 고정을 시도하고(idle 경로. `prompt` hook 안 고정은 AC-P26 통과 뒤, 5.3), 못 하면 UI가 "기본값(미고정)"으로 보인다 |
| 가드 1 실패: 버전 불일치 또는 env 마커 없음(01 §5.4) | `guard_skew`(오류). `health.guard`가 `skew` 또는 `unmanaged`. 이때 own-accounts는 slot과 hook을 등록하지 않는다 |
| linked 가져오기 계정의 토큰이 만료되거나 401로 거부됐고 이전 앱이 아직 갱신하지 않음(3.2a) | `codex_source_stale`(경고, 전역). 계정 `auth_failed`, 전환 후보에서 뺌. 원본이 바뀌면 저절로 풀림 |
| `compaction.started{reason:"auto"}` 때의 `P`가 기대 기준 `T_slot`과 ±10% 넘게 다름(4.7.2. 프로젝트 설정의 `compaction.buffer` 등). **비교에서 빼는 것 둘**: (1) slot이 바뀐 뒤 그 slot의 측정 step이 아직 없는 동안의 첫 자동 압축. `due()`가 새 providerID의 측정값을 기준으로 삼기 때문이다(`compaction.ts:225-234`, 4.7.5). (2) overflow 복구 압축. core는 수동이 아닌 압축을 모두 `reason:"auto"`로 알린다(`compaction.ts:377`, 스키마는 `auto`·`manual`뿐 `session-event.ts:591`). 그래서 `compaction.started` 직전 30초 안에 같은 세션의 마지막 응답 캡처(7.2 `lastResponse`)가 4xx이고 본문 앞부분이 core overflow 판정(`ai/src/provider-error.ts:50-59,146-157`)에 맞거나, WS 경로에서 같은 뜻의 `error`/`response.failed` 프레임이 왔으면 overflow로 보고 비교하지 않는다 ⚠(판정 정확도는 AC-P40에서 본다) | `compaction_threshold_mismatch`(경고, 세션). 설정 화면에 "설정 파일이 압축 기준을 바꾸고 있습니다" |
| own slot 요청의 도구 정의 hash나 system hash가 같은 세션·slot의 직전 요청과 다름(4.3 D10). Code Mode 카탈로그 delta는 여기에 잡히지 않는다(메시지에 붙음) | `toolset_changed`(info, 세션). 추정기는 그 slot의 `W`를 0으로 본다 |
| 설정 `agent.model`이 own 구독 slot(다른 ChatGPT 계정, Claude 슬롯)이라 관문이 그 subagent 호출을 부모 Ref로 돌림(5.11 규칙 2, 07 §5.4) | `subagent_model_overridden`(info, 세션 = 부모). `{requested, used}`를 message에 적는다 |
| 관문이 subagent 호출을 거절함: LLM이 적은 다른 계정·provider, 예산을 다 쓴 종량제 대상, 이 대화에서 아직 허락하지 않은 종량제 대상(`consent`, T1), 상한(`caps`, T1), 나눠 맡기기 `off`, 판단할 수 없음(5.11 규칙 2, 07 §5.4) | `subagent_rejected`(info, 세션). `{requested, reason}`을 message에 적는다. 화면은 실패 카드가 아니라 중립 칩(03 §18.11) |
| 고정 대상이나 가벼운 짝의 모델이 사라짐(07 §4.3) | `preset_needs_repair`(warning, 전역, T1에 선언, T2부터 냄). 모델 사건마다 한 번(그 모델을 쓰는 프리셋 수와 함께), 리더만. 그 역할은 고칠 때까지 다음 대상이나 `메인과 같게`. 알린 사건은 프로세스 메모리에만 있어 재시작 뒤 아직 사라진 모델은 한 번 더 낸다. 후속 모델 제안은 `presets.list` `repairs`(9.2) |
| `presets.json`에 같은 회사의 다른 구독 계정을 가리키는 대상이 있음(손으로 고친 파일, 07 §5.4) | `preset_entry_dropped`(warning, 전역, T1). `{presetID, role}`. 그 대상만 빼고 읽는다 |
| 묶음의 새 대화 기본 모델이 사라짐(07 §4.3) | `group_default_model_missing`(warning, 전역, T1에 선언, T2부터 냄). 새 대화는 07 §2.2 규칙의 결과로 시작하고 저장값은 `user`든 `auto`든 지우지 않고 `missing`으로 둔다(T2) |
| 로컬 모델의 실행 창을 모르거나 요청에 모자람(07 §6.2 #8) | `local_window_unverified`(info, 전역, T1). 모델마다 한 번. 그동안 `presets.suggest`가 그 모델을 제안하지 않는다 |
| 숨긴 내장 에이전트(title 등)의 설정 `model`이 own 구독 slot이라 `agent.transform`이 지움(07 §5.4) | `internal_agent_model_removed`(warning, 전역). 에이전트·모델마다 한 번. `diagnostics.selfTest.agentModels`에도 보인다 |
| 알려진 Codex 구독 창이 없는 Codex 모델을 살아 있는 카탈로그 창으로 등록함(3.6, 07 §6.2 #4) | `codex_window_unverified`(info, 전역). 모델마다 한 번 |
| Codex 메타데이터의 `supports_reasoning_effort_updates`와 own의 upstream 거울(`Variant.supportsEffortUpdates`)이 다름(07 §3.5, §4.5) | `effort_update_drift`(info, 전역, T2). 모델마다 한 번. 원장 후보로 적고 비용 창은 upstream 동작을 따른다 |
| 고정 템플릿의 고정 필드(이름, 계열, variants, settings …)가 카탈로그에서 바뀜(3.6a 5번, 07 §4.4) | `template_update_available`(info, 전역, T2). 변경마다 한 번. 계정 카드 `템플릿 갱신 있음`, `accounts.update{refreshCatalog}`로 풀림 |
| 세션의 메인 모델이나 그 추론 강도가 사라진 루트에 사용자 프롬프트가 들어옴(07 §4.3) | `session_model_unavailable`·`session_variant_unavailable`(warning, 세션, T2). core가 그 step을 `ModelUnavailableError`·`VariantUnavailableError`로 실패시키므로 own-web은 보내기 전에 막고 전환을 묻는다(`session.preset.get` `main`). 저절로 바꾸지 않는다 |
| Codex 모델 메타데이터를 받지 못함(3.6a 6번, 07 §4.5) | `codex_meta_unavailable`(info, 전역, T2). 선언만 했고 PG7 (나)로 끝점을 확인하기 전에는 내지 않는다(로그 `codex_meta_fetch_failed`만). 그동안 마지막 스냅샷, 그다음 PC의 Codex CLI 캐시, 그다음 "메타데이터 없음" 규칙 |
| generate·title 사용량을 스트림에서 읽지 못한 줄이 1시간에 3개 초과(7.5) | `generate_usage_missing`(info, 전역) |
| own slot의 step(`session.step.ended`)이 finish `length`로 끝남. 답이 출력 한도에서 잘렸다. upstream v2.0.32(a3f7f42ac9)부터 core가 숨은 synthetic 메시지로 이어서 쓰게 하고(도구 호출이 끝나지 않았으면 그 호출은 실행하지 않고 `tool.input-incomplete`로 실패시킴), 세 번 연달아 잘리면 턴을 `output-limit` 오류로 끝낸다 | `output_truncated`(info, 세션). `{providerID, modelID, finish}`를 `events.jsonl` 줄에 적는다. 같은 세션·code는 경보 중복 제거 창 안에서 한 번만 낸다. 압축·generate 요청은 보지 않는다 |
| own slot의 step이 finish `stop`인데 보이는 출력이 0임(`tokens.output` 0. reasoning은 세지 않음. 입력도 0이면 provider가 usage를 주지 않은 것이라 뺀다). 턴이 답도 오류도 없이 끝난다 | `empty_completion`(info, 세션). 필드와 중복 제거는 `output_truncated`와 같다 |
| 증거 수집 창(7.8)이 한 줄도 쓰지 못하고 끝남(`stop`, 시간 만료, 새 `start`. 서비스 종료는 빼고) | `capture_empty`(전역). 그동안 그 창의 세션·slot에서 own slot step이 돌았으면 warning(hook이 그 응답을 보지 못함. 2.0.18-own.1의 플러그인 차단처럼 조용한 빈 관측), 아니면 info. `{captureID, steps, mode}`를 `events.jsonl` 줄에 적는다 |
| 증거 수집 창이 도는 동안 own slot primary 요청이 같은 세션·slot의 직전 primary 요청과 다른 블록을 보냈는데, 압축·revert·모델·에이전트·도구 집합·strip·이미지 trim·지시 갱신 어느 것도 설명하지 못함(7.8.1) | `prefix_diverged`(info, 세션). `{providerID, modelID, agent, at, lcp, previous}`를 `events.jsonl` 줄에 적는다. 같은 세션·slot·모델·블록 종류는 경보 중복 제거 창 안에서 한 번만 낸다. 비교 결과는 경보와 상관없이 요청마다 `prefix` 줄로 남는다 |
| 속도 tier가 실린 요청이 그 tier 때문에 거절됨(4.8: 계정에 없음, 거부, Anthropic Fast 한도) | `speed_fallback`(info, 세션). `{providerID, modelID, tier, reason}`. 곧바로 더 느린 속도로 다시 보내고 계정은 바꾸지 않는다 |
| 응답이 보낸 것보다 느린 tier를 말함(OpenAI API 키 `service_tier:"default"`, Anthropic `usage.speed:"standard"`. ChatGPT 요금제 `codex`·`siwc`의 `auto`·`default`는 말하지 않은 것이라 들지 않고, 더 느린 tier 이름만 든다, 4.8) | `speed_downgraded`(info, 세션). 이어지는 느린 처리의 첫 번째만(4.8). ledger 줄 `speed.served`는 매번, 회색 배지 |
| 한 번도 그대로 처리된 적 없는 tier가 연달아 `Speed.IGNORED_AFTER`번 느리게 처리됨(4.8) | `speed_fallback`(info, 세션) `reason:"ignored"`. 그 tier를 `unavailable`로 두고 더 느린 속도로 보낸다 |
| siwc 요청이 `subscription_sharing_unsupported_capability`로 거절됐고 아무 hook도 다시 보내지 않음(3.2c "입력 항목") | `sharing_unsupported_input`(오류, 세션). `{providerID, modelID, param}`. 한국어로 지원하지 않는 항목을 알리고 계정 전환이나 항목 제거를 권한다. 재시도·계정 전환은 하지 않는다 |
| 원격 관련 6개: `broker_unavailable`, `remote_spool_overflow`, `remote_observation_rejected`, `remote_skew`, `remote_host_identity_changed`, `remote_clock_skew` | 04 §16.5가 기준이다 |

- 판정: `claude_extra_usage`는 `anthropic` 응답을 보는 own-telemetry가 판정해 `own-runtime`에 올린다. 나머지 경보는 모두 own-accounts가 판정한다(`claude_slot_billing`은 연결 유형으로 판정, 8.9). UI로는 모두 own-accounts가 `alert` 이벤트로 낸다(9.3).

### 7.8 실계정 증거 수집(켜야 동작, P0-3a)

실계정 게이트 G7·AC-P15(모르는 헤더 이름), G8(WS `error`·`response.failed`의 실제 모양)에 쓸 증거를 모은다. 마지막 응답 캡처(7.2)는 허용 목록 헤더만 남기므로(`LastResponse.pickHeaders`) 그 밖의 헤더 이름은 여기서만 보인다. 구현은 own-accounts `src/telemetry/capture.ts`, 순수 함수는 own-runtime `src/wiretap.ts`다.

- **켜기와 끄기**: RPC `diagnostics.capture.{start,stop,status}`(9.2). 전역 메서드라 control location으로 부르고, 범위는 `local`이다(파일이 로컬 경로와 헤더 목록을 담으므로 원격 기기에서 부를 수 없다). 창은 기본 30분, 최대 1,440분이고 시간이 다 되면 스스로 끝난다(`expired`). 새 `start`는 돌던 창을 `replaced`로 끝낸다.
- **꺼져 있을 때 비용 없음**: 따로 등록하는 hook이 없다. own-accounts의 기존 읽기 전용 hook(`http.response`, `experimental.ws.handshake`, `experimental.ws.receive`, `retry`, 4.1)이 창이 없으면 필드 하나를 읽고 돌아간다. 본문을 복제하지 않는다.
- **기록 대상**: 창의 세션(`sessionID`, 없으면 모두)과 slot(`providerIDs`, 없으면 모든 own slot)의 own slot 요청만. `anthropic`은 보지 않는다.
  - `http.response`: 상태, **모든 응답 헤더 이름**. 4xx·5xx면 `clone()`한 본문 앞 64KB의 모양이나 해시(2초 안에 오지 않으면 `null`). SSE 응답이면 clone을 백그라운드에서 끝까지 읽어(최대 5분) 이벤트 종류별 수와 새 구조의 모양을 한 줄(`stream`)로 쓴다.
  - `experimental.ws.handshake`: 요청 헤더 이름(WS 응답 헤더 hook은 없다, P-005).
  - `experimental.ws.receive`: 프레임 종류별 수. 구조(키·값 종류·열거 값)마다 처음 한 번만 쓰고, `error`, `response.failed`, `response.incomplete`, `response.completed`, `response.done`, `codex.rate_limits`, `usage`나 `error`가 있는 프레임은 매번 쓴다. 프레임은 바꾸지 않는다.
  - `retry`: core의 오류 type·status, 메시지 길이(내용은 쓰지 않음), own-accounts 판정(5.2), core가 받은 결정(`retry`/`stop`).
- **모드**
  - `hash`: 이름, 상태, 종류, 수, 모양의 해시만.
  - `shape`: 추가로 모양과 한도 같은 헤더의 값(`LastResponse` 허용 목록과 `ratelimit|retry|reset|quota|usage|credit|limit|balance` 이름. 인증 헤더는 빼고, 가림 처리, 256자). 모양에서 문자열은 `<str:길이>`, 숫자는 `<num>`이다. 열거 키(`type`, `code`, `status`, `reason`, `plan_type`, `finish_reason` …)의 짧은 값과 `usage`·`limit`·`tokens` 객체 안의 숫자만 남는다. Responses lifecycle 이벤트는 `status`, `error`, `incomplete_details`, `usage`, `service_tier`만 남긴다(지시와 도구 echo는 버림).
- **줄과 파일**: 줄마다 `{v:1, capture, ts, sessionID, providerID, modelID, accountID, accountKind, kind, transport, event, …}`이고 `Redact.value`를 거친다. 인증 헤더는 해시 앞 8자(`authHash8`)만, URL은 쿼리 없이 남긴다. 파일은 `<OWN_HOME>\diagnostics\captures\<YYYY-MM-DD>\<sessionID>.jsonl`, 창 요약(프레임·이벤트 종류별 수)은 그날의 `windows.jsonl`이다. 소유자 전용(폴더 0700, 파일 0600)이고 7일 지난 날짜 폴더는 창을 시작할 때와 leader의 정리 때 지운다. 창 하나는 최대 5,000줄이고 넘친 줄은 `dropped`로 센다.
- **프로세스 하나에 창 하나**: hook은 Location 인스턴스마다 돌고 RPC는 control location에서 돌므로, 창은 빌드별 프로세스 싱글턴(`globalThis`, 01 §4)에 둔다. 창을 연 인스턴스가 만료 타이머와 step 수(runtime broadcast `ledger.line`)를 갖고, 그 인스턴스가 멈추면 창은 `shutdown`으로 끝난다(경보 없음). `stop`은 아직 읽는 중인 줄을 최대 2초 기다린 뒤 요약 줄까지 쓰고 답한다.
- **빈 창**: 한 줄도 쓰지 못하고 끝나면 `capture_empty`(7.7).
- **게이트 스크립트**(사용자가 실행, 실계정): `own/scripts/gates/g7.ts`(계정마다 한 단어 턴 몇 개 → 요청마다 한도, 헤더 이름 표), `g8.ts`(평소 사용 중 긴 창 `--watch`/`--collect`, 또는 소진된 계정으로 한 턴을 돌려 30초 기준을 잰다). 결과는 `own/.out/gates/<시각>-g7|g8/evidence.{json,md}`이고, 서비스 비밀번호나 비밀처럼 보이는 문자열이 있으면 쓰지 않는다. AC-P24(`x-should-retry`)와 Claude 슬롯은 다루지 않는다.
- **하지 않는 것**: 본문 전체 기록(11장 "해시만 기록"의 예외라 사용자 결정), 평소 상시 수집(P0-3b, 보류).

#### 7.8.1 prefix 지문(켜야 동작, P0-2b)

증거 수집 창이 도는 동안, 창의 세션·slot으로 나가는 own slot primary 요청을 같은 세션·slot의 직전 primary 요청과 블록 단위로 비교한다. 결정성 규칙 D1·D9·D10(4.3)과 G4·AC-P05의 "직렬화 prefix 해시 일치"를 실제 요청으로 확인하고, 결과만 말하는 `low_hit`·`prefix_drift`(7.7)를 "own이 바이트를 바꿨나"로 나눠 보기 위해서다. 구현은 own-accounts `src/telemetry/prefix-watch.ts`, 순수 함수는 own-runtime `src/prefix.ts`다.

- **켜기**: 따로 없다. `diagnostics.capture.start`의 창이 같은 범위(세션, slot)로 켠다. 창이 없으면 `context` hook이 창 상태를 한 번 묻고 돌아간다. 해시는 하지 않고 그 slot의 직전 지문을 지운다. 그래서 창과 창 사이를 건너 비교하지 않는다.
- **블록**: own-accounts의 `context`·`compaction`·`generate` hook 맨 끝(D9 identity 정규화와 strip 규칙 뒤)에서 요청을 캐시 순서의 블록으로 나눈다. 도구 정의 1개(도구 순서 포함), system part마다 1개, 메시지마다 1개다.
  - 블록마다 정규형(키 정렬, `undefined` 제외, bytes는 bytes 그대로)의 64-bit 해시를 메모리에만 둔다. cache hint(`cache`, `cache_control`)는 이름으로 뺀다.
  - 요청 종류는 뒤따르는 `model.request`만 알므로 비교는 거기서 한다(D10과 같은 짝짓기). 압축·generate·title 요청은 비교하지 않는다. 압축 요청은 그 세션의 압축 epoch를 올린다.
- **원인**: 직전 요청을 통째로 재사용하면 `append`, 비교할 직전 요청이 없으면 `first`다. 다르면 처음 달라진 블록 위치(`lcp`)에 다음 순서로 원인을 붙인다.
  1. `compaction`: 그 사이의 압축 요청이나 `session.compaction.ended`
  2. `revert`: `session.revert.committed`
  3. `reset`·`reset-undo`: 문맥 비우기의 전달과 되돌리기(4.7.4 "문맥 비우기", core P-035)
  4. `model`: 모델이나 variant가 다름
  5. `agent`: 에이전트가 다름
  6. `toolset`: 도구 정의나 system이 다름. 경보는 D10의 `toolset_changed`(4.3)가 같은 요청에 대해 따로 낸다
  7. 메시지가 달라졌을 때만: `strip`(이 요청을 고친 strip 규칙이 다름, 4.4), `image-trim`(core가 잘라 내는 이미지 수가 바뀜, 아래), `instructions`(`session.instructions.updated`)
  8. 그 밖은 `unexplained`. 이때만 `prefix_diverged`(info, 세션, 7.7)를 낸다
- **이미지 trim(D8)**: core는 hook 뒤에 25 MiB 규칙으로 오래된 이미지를 안내 문구로 바꾼다(`core/src/session/model-request.ts` `boundImages`, 15 MiB까지). hook에는 보이지 않으므로 같은 규칙으로 잘리는 이미지 수를 계산한다. 그 수가 바뀌면 새로 잘린 첫 이미지의 메시지를 `lcp`로 삼는다. core가 이 상수나 크기 계산을 바꾸면 이 계산도 고친다(surface `request-image-bound`).
- **줄**: primary 요청마다 `events-YYYY-MM.jsonl`에 ledger writer로 한 줄을 쓴다. `{type:"prefix", accountID, providerID, sessionID, data:{cause, lcp, previous, blocks, at, modelID, variant, agent, ms}}`(`Ledger.Prefix`)다.
  - `previous`와 `blocks`는 직전·이번 요청의 블록 수다. `lcp`가 `previous`와 같으면 앞을 고치지 않은 것이다.
  - `at`은 처음 달라진 직전 블록의 종류(`tools`|`system`|`message`)다.
  - `ms`는 hook이 창 상태 조회, 지문, 비교에 쓴 시간이다.
  - 해시와 내용은 쓰지 않는다.
- **비용**(2026-10-06, 이 PC, Bun 1.4.2): 지문만 잰 중앙값은 메시지 400개·글자 4 MB가 약 9 ms, 여기에 10 MiB 인라인 이미지를 더하면 약 12 ms, 메시지 1,000개와 25 MiB 이미지가 약 23 ms다. 같은 요청을 SHA-256으로 해시하면 64–231 ms라서 wyhash(`Bun.hash`)를 쓴다. 이 해시는 한 프로세스 안의 비교 키일 뿐이고 저장하지 않는다. PG4 e2e(요청당 블록 6–41개)의 `ms`는 0.5–4.8 ms였다.
- **보이지 않는 것**
  - own-accounts 뒤에 도는 `context` hook(own-computer-use의 스크린샷 정리)과 core의 protocol lowering이 바꾼 바이트. `append`로 보인다.
  - 블록 안 JSON 키 순서. 서버 캐시가 키 순서를 보는지는 확인하지 않았다 ⚠.
  - 같은 세션·slot·모델·에이전트의 요청 둘이 shape와 `model.request` 사이에 겹치면(예: primary 도중의 `/btw` generate) 비교가 어긋나 info 경보가 날 수 있다(D10과 같은 한계).

---

## 8. Claude 구독 플러그인 슬롯

### 8.1 성격

- **대상**: `heymaaz/opencode-claude-auth-v2`, npm `opencode-claude-auth-v2@0.4.0-beta.5`
  - 2026-09-26 기준 `latest`/`beta` 태그가 모두 이 버전이었다. 2026-10-07에 `0.4.0-beta.6`이 `latest`가 되었다(`beta`는 그대로 이 버전).
  - 무결성: `sha512-dVA2AY58JxrZP3QqetevB3yebwQLVoMGyBFrPbJPDdCgJ94UEzQpK9/5Jk0Ibeyeom5mWD/HInaJgfX9O5MljA==`
  - **포크 은퇴(2026-10-16)와 후속판을 쓰지 않는 까닭(2026-10-30 결정 CV)**: 이 패키지는 `griffinmartin/opencode-claude-auth`의 OpenCode 2 전용 포크다. 2026-10-16에 모든 판이 npm에서 deprecated 되었다("OpenCode 2 support is now available upstream. Replace this plugin with opencode-claude-auth@latest (3.0.0 or newer)."). 빌드의 `npm ci`가 이 경고를 내지만 lock과 integrity는 그대로라 빌드는 된다. own은 `0.4.0-beta.5`와 own의 패치에 머문다. `0.4.0-beta.6`과 후속판 `opencode-claude-auth@3.0.0`(플러그인 id `griffinmartin.claude-auth`)은 쓰지 않는다. 기능상 얻는 것이 없고(둘 다 `ccVersion` `2.1.280` 그대로다. beta.6이 바꾼 것은 갱신 요청에 `User-Agent`를 붙인 것 하나이고, own의 패치는 이미 Claude Code의 갱신 요청 그대로 보낸다(8.2 3번 CR)), 후속판은 플러그인 id가 달라 감지·순서·신뢰 목록을 다시 맞춰야 하고, 버전·integrity가 바뀌면 원격 사용 동의(8.4a)를 다시 물어야 한다.
  - **알리는 Claude Code 버전(2026-10-30, CV)**: 플러그인은 요청마다 Claude Code 버전을 알린다(`User-Agent: claude-cli/<ver> (external, sdk-cli)`, 청구 헤더 `cc_version=<ver>.<접미사>`). 원본은 `2.1.280`이고, own의 패치가 그때의 npm `@anthropic-ai/claude-code` `stable`인 `2.1.308`로 올린다(8.2 3번). Claude Code는 Sonnet 5.5를 2.1.284에서, Haiku 5.5를 2.1.293에서 더했고, Anthropic은 모델이 요구하는 최소 버전보다 낮은 Claude Code의 요청을 `claude_code_version_too_old`로 거절할 수 있다(Claude Code 2.1.308이 이 오류 종류와 문구를 안다). 2.1.280으로 Sonnet 5.5·Haiku 5.5가 실제로 거절되는지는 실계정으로 확인하지 않았다(2026-10-26 사용자 화면에는 AC-01의 Haiku 5.5 단계가 정상으로 보였다). 버전은 다음 기준으로 고른다: npm `stable` 태그의 판(`latest`보다 보수적), 청구 접미사의 salt(`59cf53e54c78`)·글자 위치(4, 7, 20)·신원 줄(`You are Claude Code, Anthropic's official CLI for Claude.`)이 그 판에서 그대로인지 확인한다(2.1.308 바이너리와 2.1.312에서 확인, 2026-10-30). 갱신 요청의 모양(토큰 끝점, `axios/1.15.2`, 기본 scope)도 2.1.312까지 그대로다.
- **앱에 들어 있고 늘 켜져 있다(사용자 결정 2026-10-18 "넣고 항상 켜기", CB).** 릴리스 빌드가 커밋한 lock으로 고정 버전을 설치·확인하고 own의 패치를 적용해 `app\<ver>\plugins\claude-auth`에 싣는다(8.2). 사용자 PC에서는 내려받기, 설치, 패치, 제거가 없다. 패키지는 MIT 라이선스이고, 그 `LICENSE`를 함께 싣는다(FORK.md §1). 원격 호스트에는 싣지 않는다(04 §8.11은 PC에서 중계한다).
  - 이전(2026-10-18 전)에는 사용자가 카드에서 고지에 동의한 뒤 이 PC에서 `npm ci`로 설치하고(`thirdparty\claude-auth`), 로컬 패치를 따로 적용하고, 제거할 수 있었다. 이 흐름은 설치 실패가 잦았다. 바꾼 까닭과 옛 설치에서 옮기는 방법은 8.2 7번이다.
- 이 플러그인의 신원 위장 동작을 다시 구현하거나 고치지 않는다. PC egress 중계는 같은 프로세스에 로드된 플러그인 인스턴스의 export(`injectClaudeIdentity`, `prepareClaudeRequest`, `finishClaudeResponse`)를 그대로 부른다(04 §8.11.4.5).
- **약관 배경**: 현재 Anthropic 공식 문구는 서드파티가 Claude.ai 로그인을 제공하거나 구독 credential로 요청을 중계하는 것을 허용하지 않는다[R-terms]. 공식 경로는 Anthropic API 키(`own-anth-*`)다. 원격 호스트의 요청을 이 PC의 구독 로그인으로 보내는 것은 이 "중계"에 더 가깝다. 그래서 원격 사용은 별도 고지·동의(`ack:claudeRemote`)와 호스트별 켜기를 요구한다(8.4a).
  - 2026-10-19 확인(8.9): 이 문구는 Claude Code 문서 "Legal and compliance"의 "Authentication and credential use"에 있다. 2026-02 중순(2026-02-01 사본에 없고 2026-02-18 사본에 있음, 2026-02-19~20 보도)에 구독 OAuth는 Claude Code와 claude.ai 전용이라는 문장이 들어갔고, 지금은 "Claude Code and other native Anthropic applications"라고 쓴다. 소비자 약관 자체의 시행일은 2025-10-08 그대로다. 서버 쪽 막음은 2026-01-09부터 있다.
- **추가 사용량 위험(결정 CB의 위험 문구, 2026-10-19 사용자 결정 CW "경고 보이고 확인하기")**: Anthropic은 2026-04-04 12시(PT)부터 서드파티 도구·하네스로 쓴 구독 사용을 구독 한도에 넣지 않고 추가 사용량(extra usage, 종량제. 지금 이름은 usage credits)으로 청구한다고 알렸다. 이 플러그인의 요청도 그렇게 청구되거나, 추가 사용량이 꺼져 있으면 거절될 수 있다. 반대로 Anthropic 도움말은 2026-06-15·2026-10-07에 서드파티 앱 사용이 구독 한도에서 나간다고 썼다. own은 어느 쪽인지 장담하지 않는다. 플러그인은 그대로 늘 켜 두고(CB), 카드에 늘 보이는 경고와 확인 방법을 두며, 응답이 알려 주는 판정을 보여 준다(8.9). 위험 고지(03 §5.4.1(a)) 3번이 이것을 말한다.
- **여러 Claude 계정(사용자 결정 2026-10-10, C-D1–C-D3)**: 한 PC에서 Claude 구독 계정 여러 개를 대화마다 동시에 쓰고(C-D1), 이를 위해 플러그인을 조금 고치며(패치, C-D2. 2026-10-18부터는 빌드가 적용한다, 8.2 3번), 한 계정이 한도에 막히면 다른 Claude 계정으로 저절로 옮긴다(C-D3, 8.8. 2026-10-31 CAG-5부터 새 설치 기본은 꺼짐, 2.4.3). 8.7이 전체 설계다.
  - **위험(사용자에게 알린 것)**: 한 PC·IP·지문에서 소비자 구독 여러 개를 동시에 쓰고 한도를 피하려고 저절로 돌리는 것은 Anthropic이 쉽게 알아챌 수 있고, 소비자 약관의 "한도 우회" 금지와 부딪칠 수 있다. 여러 계정이 함께 제한되거나 정지될 수 있다. 사용자는 이전에 플러그인 약관 위험을 받아들였고, 이 기능은 그 위험을 키운다. 위험 고지(03 §5.4.1(a))의 7·8·9번이 이것을 말한다. 2026-10-18부터 고지는 동의 없이 정보로 보인다(8.4).
  - Claude Code와 같은 로그인 폴더를 함께 쓰면 refresh token 회전이 겹쳐 한쪽에 죽은 refresh token이 남을 수 있다. 그래서 새로 추가하는 계정은 own 전용 폴더를 쓴다(8.7). 2026-10-22(CS)부터 Claude Code 자신의 폴더(`%USERPROFILE%\.claude`, 보통 가져온 계정 1)는 **읽기만 한다**. own은 그 로그인을 새로 고치거나 쓰지 않으므로 Claude Code의 토큰을 회전시키지 않는다(8.2 3번, 8.7 "Claude Code의 로그인 폴더").

### 8.2 앱에 든 플러그인과 연결(2026-10-18, 사용자 결정 CB "넣고 항상 켜기")

이 절이 이전의 "플러그인 설치"(템플릿 복사 → 사용자 PC에서 `npm ci` → 로컬 패치 → 설정 편집, 제거)를 바꿨다. 플러그인은 앱 빌드에 들어 있고, 설정의 `plugins`에 늘 있다. 실행 중에는 npm, 패치, 설치, 제거가 없다.

1. **저장소의 입력**: `own/vendor/claude-auth/`(FORK.md §1). 빌드 단계의 입력일 뿐이며 그 자리에 설치하지 않는다.
   - `package.json`: `{"private":true,"type":"module","dependencies":{"opencode-claude-auth-v2":"0.4.0-beta.5"},"overrides":{"@opencode/plugin":"2.0.24"}}`(호스트 판을 따름, v2.0.24 sync `75c8c47e2c`)
   - `package-lock.json`(커밋). 버전과 integrity는 이 lock이 정한다.
   - `server.js`: `export { default } from "opencode-claude-auth-v2"`
   - `patches/<버전>.json`: 그 버전의 패치 매니페스트(3번).
2. **빌드 단계**(`own/scripts/claude-auth-bundle.ts --out <dir> --build-id <id>`, `build-desktop.ps1` 3a단계). 하나라도 어긋나면 빌드가 실패하고 `--out`에는 아무것도 쓰지 않는다.
   - `install`: 임시 폴더에 `package.json`과 lock을 복사하고 `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline`(npm 캐시에 있으면 오프라인). npm이 lock의 integrity로 모든 tarball을 확인한다.
   - `verify`: 설치된 패키지와 npm의 숨은 lock이 위 버전·integrity(8.1)를 말하는지 본다.
   - `patch`: 매니페스트의 모든 파일이 `preSha256`이고, 모든 `find`가 앞 편집이 남긴 글에서 정확히 한 번 나오고, 결과가 `postSha256`인지 본다.
   - `bundle`: 고친 패키지를 `bun build`(target bun, ESM, minify 없음)로 `dist/index.js` 한 파일로 묶는다(약 86 KB). 호스트가 플러그인에 주는 `@opencode/plugin`과 `effect`는 외부로 둔다. 패키지의 모듈은 자기 파일, `node:` 내장, 이 둘만 가져올 수 있다(다른 패키지 코드가 섞이지 않으므로 패키지의 MIT `LICENSE`가 파일 전체를 덮는다).
   - `check`: 묶은 파일이 불러와지고(작업 폴더의 호스트 모듈 대역으로) 플러그인 id, 패치 표지, own이 부르는 export를 갖는지 본다.
   - `write`: 다음 구조를 쓴다. 이전 npm 설치본(`node_modules` 약 132–171 MB) 대신 약 93 KB다.

     ```
     app\<ver>\plugins\claude-auth\
       server.js                                export { default } from "opencode-claude-auth-v2"
       package.json                             {"private": true, "type": "module"}
       own-bundle.json                          {schema:1, package, version, integrity, patchSha256, buildId, files:{경로: sha256}}
       node_modules\opencode-claude-auth-v2\    게시된 package.json·index.js·LICENSE와 고친 dist\index.js
     ```

   - `own-bundle.json`의 `buildId`는 릴리스 manifest의 `build_id`다(소스 실행용 번들은 `--build-id`를 주지 않으면 `null`). `files`는 그 밖의 모든 파일의 sha256이다.
   - **`node_modules` 아래 두는 까닭**: upstream 로더(`plugin/src/source.bun.ts`)는 로컬 플러그인의 자기 파일을 불러올 때마다 다시 평가하지만(Location마다 한 벌) `node_modules` 아래 파일은 모듈 캐시에 남긴다. 플러그인은 계정을 모듈 상태에 두고, 모든 Location과 own의 egress 중계(`ClaudeWire`, 04 §8.11.5)가 그 상태를 함께 써야 하므로 npm 설치 때의 자리에 둔다.
   - 소스 실행(개발): `bun own/scripts/claude-auth-bundle.ts --out own/.out/claude-auth`. own-accounts는 이 폴더도 앱의 번들처럼 믿는다(소스 실행일 때만, `ClaudeBundle.devDir`).
3. **패치**(2026-10-10 사용자 결정 C-D2. 2026-10-18부터 빌드가 적용한다)
   - **매니페스트**: `own/vendor/claude-auth/patches/0.4.0-beta.5.json`. 파일마다 `{file, preSha256, postSha256, edits:[{find, replace}]}`이고 단순 문자열 치환이다. 매니페스트 자신에 버전·integrity·표지 이름(`OWN_MULTI_ACCOUNT`)이 있고, 그 파일 바이트의 sha256이 `patchSha256`이다(`own-bundle.json`에 적힌다). 매니페스트는 `own/scripts/claude-auth-patch.ts`로 만든다(원본 사본과 고친 사본을 비교해 만들고, 적용 결과가 고친 사본과 같은지 확인). 플러그인 버전을 올리면 그 버전의 매니페스트가 있어야 빌드가 된다.
   - **고치는 내용**(설계 가드 G1–G3·G7, 2026-10-18 추가분)
     - G1 계정 이름: 계정 키 = 정규화한 config 폴더(`path.resolve`, Windows는 소문자). 모든 계정별 맵, 쿨다운, 진행 중 refresh, refresh 잠금, backoff, 로그 키가 이 키를 쓴다(문자열 `"file"`을 쓰지 않음). 계정 목록은 own이 쓴 `<상태 폴더>\claude-accounts.json` `{version:2, default, accounts:[{key, configDir, label, readOnly?}]}`에서 읽고(파일이 바뀌면 다음 조회 때 다시 읽음), `CLAUDE_CONFIG_DIR`에서 읽지 않는다. `version`은 2026-10-23(CS 재검토)부터 2다. 예전 own이 쓴 `version:1`(`readOnly`가 없을 수 있음)이나 모르는 버전의 목록도 계정은 읽지만, own이 다시 쓸 때까지 own이 만든 폴더(`<OWN_HOME>\claude-accounts\…`, 상태 폴더 `<OWN_HOME>\thirdparty\claude-auth`의 두 단계 위) 밖의 계정은 모두 읽기만 한다(아래 "Claude Code 자신의 로그인 폴더").
     - own 계정 모드(2026-10-18): 다중 계정 모드가 늘 켜져 있다(`isOwnAccountsMode`). 상태 폴더를 아직 모르거나, 목록 파일이 없거나 읽을 수 없거나, 계정이 없으면 계정 없음이다(실패하면 닫힘). `%USERPROFILE%\.claude`를 스스로 찾아 쓰지 않는다. 그래서 **Claude 계정을 연결하기 전에는 아무 요청도 서명하거나 보내지 않는다**.
     - 상태 폴더(2026-10-18): export `ownUseStateDir(dir)`. own이 로드된 모듈에 `<OWN_HOME>\thirdparty\claude-auth`를 알려 준다(`ClaudeWire`). 계정 목록 파일, 계정별 상태와 잠금(`claude-auth-state\`)이 여기 있다. 버전 폴더 밖이므로 앱 업데이트가 로그인을 지우지 않는다(이전 npm 설치와 같은 폴더).
     - G2 묶기: export `bindSession(sessionID, key)`, `unbindSession`, `accountOf(request)`, `ownAccounts()`(키와 라벨, 토큰 없음). `http.request` hook은 `event.sessionID`의 계정으로 서명한다(8.3 I9).
     - G3 빌리기 없음: `tryFallbackAccount`와 그 호출 세 곳, 접미사 계정의 primary 채택을 지운다. 요청·refresh·중계 경로에서 암묵 기본값 `getActiveAccount()`를 지운다(다중 계정 모드에서 계정을 말하지 않으면 계정 없음). 401 강제 refresh도 계정마다 하나로 묶는다. 긴 문맥 beta 제외 상태도 계정마다다.
     - 연결 credential의 refresh(2026-10-18, 버그 1): `anthropic` integration의 연결 credential은 "연결됨"을 나타낼 뿐이고, 요청은 언제나 대화의 계정으로 서명한다(G2). core는 만료 5분 전부터 요청마다 이 credential을 refresh한다(`Integration.connection.resolve`). 그래서 이 refresh(`refreshOwnOAuthCredential`)는 credential이 이름 댄 계정(`configDir`, 없으면 `source`)의 로그인 폴더에서 읽기만 하고, 네트워크를 쓰지 않으며, 실패하지 않는다. 그 폴더에 쓸 만한 로그인이 없으면 저장된 값을 그대로 두고 1시간 뒤 다시 본다. 이전에는 이 refresh가 계정 1의 토큰을 네트워크로 갱신하다 실패하면 다른 계정의 요청까지 `Claude OAuth refresh failed. Run \`claude\` to re-authenticate.`로 실패했다.
     - 토큰 갱신 요청(2026-10-18): Claude Code가 이 client id로 쓰는 끝점 `https://platform.claude.com/v1/oauth/token`과 JSON 본문을 쓴다(원래는 `https://claude.ai/v1/oauth/token`과 form 본문).
     - **갱신 요청은 Claude Code 2.1.282의 요청 그대로(2026-10-26, CR)**: 사용자 질문 "왜 AC-01이랑 02 03이랑 다르게 동작하는지"를 따라가 보니, own 전용 로그인(AC-01·AC-02·AC-03 모두)의 갱신이 **같은 까닭으로** 모두 실패하고 있었다. 토큰 끝점이 플러그인의 갱신에 늘 HTTP 429로 답했고, 가장 그럴듯한 까닭은 요청의 모양, 특히 런타임의 기본 `User-Agent: Bun/1.4.2`다(플러그인은 `Content-Type`만 보냈다. 같은 PC에서 Claude Code 자신의 요청은 끝점의 검증까지 갔고, upstream 0.4.0-beta.6의 고침 하나가 이 헤더다). 그래서 Claude Code의 `dae`(axios로 보냄)와 같게 보낸다.
       - 헤더: `Content-Type: application/json`, `Accept: application/json, text/plain, */*`, `User-Agent: axios/1.15.2`.
       - 본문: `{grant_type: "refresh_token", refresh_token, client_id, scope}`. `scope`는 로그인에 저장된 `scopes`(Claude Code의 `.credentials.json`이 적어 둠)를 공백으로 이은 것이고, 없으면 Claude Code의 기본값 `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins`다.
       - POST는 한 번이다(Claude Code도 429에 다시 보내지 않는다). 전에는 `fetchWithRetry`가 429·529에 2초·4초 간격으로 세 번 보냈다. 시간 제한은 15초다(Claude Code는 30초. 이제 POST 하나가 15초를 다 쓴다).
       - 답은 Claude Code처럼 읽는다: `access_token`, `refresh_token`(없으면 지금 것을 그대로), `expires_in`(초), `refresh_token_expires_in` → `refreshTokenExpiresAt`, `scope` → `scopes`(없으면 요청한 것을 그대로). 되쓰기는 두 토큰과 만료 시각 옆에 `refreshTokenExpiresAt`과 `scopes`를 더한다(`subscriptionType` 등은 그대로).
       - 따르지 않은 것: Claude Code는 기본 클라이언트일 때 기본 scope에 저장된 프로젝트 scope를 더해 요청하고 `invalid_scope`이면 저장된 scope로 한 번 더 보낸다. 받은 scope를 그대로 요청하면 다시 보낼 일이 없다. `invalid_grant`일 때 Claude Code가 폴더의 로그인을 지우는 것도 따르지 않는다.
     - **갱신 결과의 분류와 기록(2026-10-26, CR)**
       - 분류(`classifyRefreshFailure`): 토큰 끝점의 400·401·403(본문이 무엇이든: 죽은 grant, 중첩된 `invalid_request_error`, HTML 거절 페이지)과 죽은 토큰 코드(`invalid_grant`, `invalid_client`, `unauthorized_client`, `unsupported_grant_type`)는 **끝난 실패(terminal)**다. refresh token이 없는 로그인도 그렇다. 429, 5xx, 답 없음(네트워크, 시간 초과), 토큰 없는 200은 **잠깐의 실패(transient)**다. 전에는 죽은 토큰 코드 넷만 끝난 실패여서 400 `invalid_request_error`나 403도 45초를 기다렸다.
       - 끝난 실패는 기다리지 않고 바로 거절한다. 같은 요청 안에서 같은 refresh token을 다시 보내지도 않는다(`getCredentialsWithBackoff`가 끝난 실패를 먼저 본다). 다음 요청이 한 번 더 해 본다.
       - 잠깐의 실패는 그대로 물러난다(기본 15초, `Retry-After`는 60초까지). 요청 하나의 45초 대기도 그대로지만, 물러남이 대기 끝보다 늦게 끝나면 그 자리에서 거절한다(기다려도 실패할 뿐이므로). 물러남이 짧으면(예: `Retry-After: 1`) 그 요청 안에서 다시 보내 이어 간다.
       - `claude -p . --model haiku` 대체 갱신은 하지 않는다(CS-8 (b) 닫음). 요청이 Claude Code의 것과 같으므로 Claude Code도 같은 답을 받는다. 이 대체는 실제 요청을 보내고, 서비스를 최대 2 × 60초 멈추고(`execSync`), `invalid_grant`이면 Claude Code가 폴더의 로그인을 지웠다.
       - own에 알림: 새 export `ownOnRefresh(listener)`(모듈마다 듣는 쪽 하나, 마지막에 정한 것). 갱신마다 `started`(계정 키, 라벨, 계기 `expiry`·`401`, 만료 시각), `ok`(걸린 시간, 새 만료 시각, refresh token 회전 여부), `failed`(종류, HTTP 상태, OAuth 오류 코드, 설명, 답 없음의 까닭, `Retry-After`, 다음 갱신 시각)를 알린다. 설명은 160자로 자르고, 그 안에 보낸 refresh·access token이 있으면 `[token]`으로 바꾼다. **토큰은 알리지 않는다.** own-accounts 리더가 듣고 `own-accounts.log`에 적는다(8.7 "로그인 새로 고침").
       - `ownAccounts()`는 계정마다 마지막 갱신 실패를 함께 준다: `refresh: {kind, at, status, error?, reason?, retryAt?}`(`reason`은 `network`, `timeout`, `unparsable`, `no_refresh_token`). 갱신이 되거나, 폴더의 로그인이 바뀌면(`다시 로그인`. 끝난 실패인 계정은 `.credentials.json`의 수정 시각이 바뀌었을 때 다시 읽음) 지운다. 요청 없이도 카드가 따라온다.
     - **Claude Code 자신의 로그인 폴더는 읽기만(2026-10-22, CS)**: Claude Code가 쓰는 로그인 폴더의 계정은 Claude Code와 같은 refresh token을 쓴다. Claude OAuth의 refresh token은 회전하므로, 둘 중 나중에 refresh한 쪽이 죽은 토큰을 든다(사용자 보고 2026-10-22: AC-01의 `로그인이 만료되었고 새로 고치지 못해`). 어느 계정이 그런지는 **own이 정해** 목록 파일에 계정마다 `readOnly: true`로 적는다(8.7 "Claude Code의 로그인 폴더": 계정 1의 기본 폴더, realpath와 자격 증명 파일 비교). 플러그인의 `ownSharedLogin(configDir)`은 목록의 `readOnly`를 보고(검토 지적 1, 2026-10-22: 전에는 `%USERPROFILE%\.claude`와 철자만 비교해 정션·다른 철자·`claude-auth.json` 폴더를 놓쳤다), 목록이 빠뜨려도 닫히도록 두 가지를 **더한다**(CS 재검토 a, 2026-10-23: 업데이트 뒤 첫 시작에는 예전 own이 쓴 `readOnly` 없는 목록이 남아 있고, `plugins` 모듈과 중계가 `ClaudeAccounts.start`의 `sync()`보다 먼저 플러그인에 목록을 읽힐 수 있어, 만료 30초 전 `%USERPROFILE%\.claude` 토큰을 refresh해 Claude Code의 파일에 썼다).
       - 이 프로세스가 보는 Claude Code의 폴더, `%USERPROFILE%\.claude`와 `CLAUDE_CONFIG_DIR`(launcher가 계정 소스를 넘기는 곳)는 목록과 상관없이 늘 읽기 전용이다. 폴더의 realpath(`realpathSync.native`, 8.3 짧은 이름도 풂), `.credentials.json`의 realpath(파일 심볼릭 링크)와 파일 id(`stat` bigint `dev:ino`, 하드 링크)로 비교한다. own이 정하는 것의 일부라서 own의 결정과 어긋나지 않는다.
       - 이 판의 목록(`version:2`)이 아니면 own이 만든 폴더 밖의 계정은 모두 읽기 전용이다(위 G1).
       - 폴더를 모르는 계정(`configDir` 없음)도 읽기 전용이다(닫힘, CS 2차 검토 a, 2026-10-23). own의 목록에서 온 계정은 늘 폴더가 있지만, 폴더 없는 계정의 refresh·되쓰기·`claude -p`는 Claude Code의 폴더(`CLAUDE_CONFIG_DIR` 또는 `%USERPROFILE%\.claude`)로 넘어가기 때문이다. 다시 읽을 자기 파일도 없다.
       - 읽기 전용인 계정은 아래와 같이 다룬다.
       - 요청 때 폴더를 다시 읽기만 하고(원래 동작), 만료 1분 전부터는 토큰 끝점, write-back, `claude -p` 대체 갱신, refresh 잠금, 45초 대기를 모두 하지 않고 바로 거절한다(`refreshIfNeeded`, `getCredentialsWithBackoff`).
       - 만료됐는데 `.credentials.json`이 있으면 곧바로 한 번 더 읽고, 그사이 Claude Code가 다 써서 읽히면 그것을 쓴다(CS 재검토 d: 전에는 이 읽기가 성공해도 버렸다). 그래도 읽히지 않으면(Claude Code가 아직 쓰는 중) 150 ms 뒤 **한 번만** 다시 읽고, 그래도 쓸 수 없으면 거절한다(`ownReadOnlyCredentials`, 검토 지적 5).
       - 401에서도 폴더를 다시 읽을 뿐 강제 refresh를 하지 않는다(`forceRefreshAccountOnce`). Claude Code가 새 토큰을 써 두었으면 그것으로 한 번 다시 보낸다.
       - `writeBackCredentials`는 이 폴더면 아무것도 쓰지 않고 `false`다(어느 경로로 와도).
       - `ownAccounts()`는 이 계정의 토큰이 만료됐을 때 그 `.credentials.json`의 수정 시각을 보고, 바뀌었을 때만 다시 읽는다. 그래서 Claude Code가 새로 고치면 요청 없이도 own의 카드가 따라온다(8.7).
       - 연결 credential의 가져오기(`buildOAuthCredential`)와 refresh도 같은 규칙이다(네트워크 없음).
       - own 전용 폴더의 계정(추가한 계정, 옮긴 계정 1)은 그대로 refresh하고 새 토큰을 **자기 폴더에만** 쓴다.
     - 오류 문구(2026-10-18): 서명하지 못한 요청의 오류는 한국어로 그 계정의 이름(목록 파일의 `label`, `ownAccountLabel`)과 할 일을 말한다. 로그인을 읽을 수 없음·만료되고 새로 고치지 못함은 `… 계정 화면에서 그 계정의 [다시 로그인]을 누르세요.`, 정해진 계정 없음은 `… 전환기(Ctrl+.)에서 Claude 계정을 고르세요.`다(8.7 `다시 로그인`). Claude Code 자신의 폴더인 계정이 만료됐으면(CS) `AC-01은 Claude Code와 같은 로그인을 써요. 그 로그인이 만료됐어요. Claude Code에서 요청을 한 번 보내거나, own 전용 로그인으로 바꾸세요. 바꾸려면 own-open-code의 계정 화면에서 그 계정의 [own 전용 로그인으로 바꾸기]를 누르세요. Claude Code도 로그아웃됐다면 Claude Code에서 /login을 하세요.`다(`은/는`은 라벨 끝소리로 고름. 쉬고 있는 Claude Code는 스스로 새로 고치지 않으므로 기다리기만 하라고 하지 않는다(CS 재검토 e). 마지막 문장: 예전 판이 같은 refresh token을 먼저 써 버렸으면 토큰 묶음 전체가 무효가 되어 Claude Code도 로그아웃됐을 수 있다). 토큰 끝점이 잠깐 안 될 때(429·5xx·네트워크, 위 "갱신 결과의 분류와 기록")는 어느 계정이든 다시 로그인을 시키지 않고, 끝점이 무엇이라고 했는지와 다음 요청이 언제 다시 새로 고치는지를 말한다(CR, 2026-10-26. 전에는 `Claude 로그인 서버에 잠시 연결하지 못했어요 · 잠시 뒤 다시 시도해요. …` 한 가지였다): 429는 `Claude 로그인 서버가 로그인 새로 고침을 잠시 막았어요(HTTP 429 rate_limit_error) · 49초 뒤 다음 요청에서 다시 새로 고쳐요. Claude 계정 AC-02의 요청은 보내지 않았어요.`, 5xx는 `Claude 로그인 서버가 잠시 답하지 못했어요(HTTP 503) · …`, 답이 없으면 `Claude 로그인 서버에 연결하지 못했어요(연결 실패) · …`(또는 `(시간 초과)`). 시각은 물러남이 끝나는 때다. 끝난 실패(400·401·403, 죽은 토큰 코드, refresh token 없음)는 `Claude 계정 AC-02의 로그인을 새로 고치지 못했어요(HTTP 400 invalid_grant) · own-open-code의 계정 화면에서 그 계정의 [다시 로그인]을 누르세요. 요청은 보내지 않았어요.`다(HTTP 상태와 OAuth 오류 코드, 코드가 없으면 상태만, refresh token이 없으면 `(새로 고침 토큰 없음)`). 어느 갱신 결과도 남지 않은 드문 경우(다른 프로세스가 잠금을 쥐고 아무것도 쓰지 않음)만 예전의 `Claude 계정 …의 로그인이 만료되었고 새로 고치지 못해 요청을 보내지 않았습니다. …`다.
     - G7: `x-claude-code-session-id`는 (계정, 대화)마다 하나다(원래는 프로세스마다 하나).
     - **알리는 Claude Code 버전과 Haiku의 강도(2026-10-30, CV, 8.1)**: `model-config.js`의 `ccVersion`을 `2.1.280`에서 `2.1.308`로 올린다. User-Agent가 `claude-cli/2.1.308 (external, sdk-cli)`, 청구 헤더가 `cc_version=2.1.308.<접미사>`가 된다. 모델별 덮어쓰기의 `haiku` 키를 `haiku-4`로 좁힌다: Haiku 4.5(`claude-haiku-4-5`, 날짜 붙은 id 포함)만 `output_config.effort`(와 `thinking.effort`)를 지우고 effort beta를 빼며, `claude-haiku-5-5`는 강도를 그대로 보낸다(API 키로 확인: Haiku 5.5는 `effort: "high"`에 200, Haiku 4.5는 400 `This model does not support the effort parameter.`). Haiku 3·3.5는 은퇴해 덮어쓰기가 필요 없다. effort beta 헤더(`effort-2025-11-24`)는 원래처럼 Opus 4.6·4.7에만 붙고 Haiku 5.5에는 붙지 않는다(effort는 GA라 필요 없음).
     - **버전 거절의 한국어 문구(2026-10-30, CV)**: 응답이 HTTP 400이고 `error.details.error_code`가 `claude_code_version_too_old`이거나 문구가 Claude Code가 알아보는 두 모양(`Claude Code <ver> does not support this model; version <ver> or newer is required`, `Claude Code <ver> is older than the minimum version required by your organization's policy`)이면, `finishClaudeResponse`가 상태·`error.type`·`details`는 그대로 두고 `error.message`만 바꾼다: `Anthropic이 이 요청을 거절했어요(HTTP 400 claude_code_version_too_old) · 앱에 든 Claude 구독 플러그인이 알리는 Claude Code 버전(2.1.308)이 이 모델이 요구하는 2.1.320보다 낮아요. own-open-code를 최신 버전으로 업데이트하세요. 그때까지는 다른 Claude 모델이나 Anthropic API 키 계정을 쓰세요. (원문: …)`(조직 정책이면 `조직 정책이 정한 최소 버전보다`, 문구 모양을 모르면 `Anthropic이 요구하는 최소 버전보다`). core는 이 400을 다시 보내지 않는 요청 오류로 보고 `error.message`를 대화에 보인다. 다시 보내지 않는다(모든 요청이 같은 버전을 알림). PC 중계(04 §8.11)도 같은 함수를 지나므로 원격 대화에도 같은 문구가 간다. 다른 400은 온 그대로다.
     - 추가 사용량 거절(2026-10-19, CW, 8.9): 새 `isExtraUsageRefusal`(8.9 표의 거절 문구 넷, 둥근 따옴표도)에 맞는 응답은 긴 문맥 오류가 아니다. 그래서 `isLongContextError`가 `You're out of extra usage`를 더는 맞추지 않고, 거절에는 긴 문맥 beta(`context-1m-2025-08-07`, `interleaved-thinking-2025-05-14`)를 빼고 다시 보내지도, 그 모델에서 beta를 계속 끄지도 않는다. 429 뒤 토큰이 바뀌었을 때의 재전송(`provider.js`)과 `fetchWithRetry`의 429 대기 재시도(`http.js`)도 거절이면 하지 않는다. 거절은 온 그대로 core와 own-telemetry에 간다. 진짜 긴 문맥 오류(`Extra usage is required for long context requests`, `long context beta is not yet available`)의 fallback은 그대로다.
     - 잠금: 모든 계정이 `<상태 폴더>\claude-auth-state\`의 계정별 잠금을 쓴다. `~/.local/share/opencode` 상태를 원래 OpenCode와 함께 쓰지 않는다. 2026-10-22(CS) 전에는 `%USERPROFILE%\.claude` 계정이 원래 OpenCode의 잠금을 썼다. 그 계정은 이제 refresh하지 않으므로 잠금을 잡지 않는다(Claude Code는 이 잠금을 몰랐다).
4. **실행 중 확인과 상태**: own-accounts는 시작할 때와 `plugin.updated`마다 번들 폴더(`ClaudeBundle.read`)의 `own-bundle.json`을 읽고 모든 파일의 sha256을 확인한다. 고칠 것이 없으므로 패치 상태는 만들어질 때부터 `patched`다.
   - `plugin.claudeAuth.status.patch = {state, sha256, loaded}`, `status.bundle = {version, integrity, patchSha256, buildId}`(앱에 번들이 없으면 `null`), `status.acknowledged`는 늘 `null`(8.4).
   - `patched`: 로드된 claude-auth가 앱의 번들(설치된 버전의 `app\<ver>\plugins\claude-auth`, 소스 실행이면 `own/.out/claude-auth`도)이고 모든 파일이 기록의 hash다. 여러 계정을 쓴다.
   - `modified`: 파일 하나라도 다르거나, 로드된 claude-auth가 앱의 번들이 아니다(예: 설정에 남은 옛 `thirdparty\claude-auth` 설치). integrity 불일치처럼 막는다(경고 `integrity_mismatch`, `not_bundled`). 수리는 앱 다시 설치 또는 서비스 다시 시작이다.
   - `pristine`·`stale`·`no_manifest`: 이전 서비스만 보내는 값이다(프로토콜 호환).
   - `loaded`: 로드된 모듈이 표지 export `OWN_MULTI_ACCOUNT = 1`과 다중 계정 export를 갖는지다(`ClaudeWire.multi`). 확인된 번들인데 거짓이면 경고 `patch_restart`.
   - 여러 계정은 **`patched`이고 `loaded`일 때만** 쓴다. 그 밖에는 계정 하나로 돌고, 다른 계정에 묶인 대화는 서명 전에 거절한다(8.3 I9, 경보 `claude_account_refused`).
   - 경고: `bundle_missing`(이 설치에 번들이 없고 로드된 claude-auth도 없음, 앱 다시 설치), `not_loaded`(번들이 있는데 로드되지 않음, 다시 시작), `not_bundled`, `integrity_mismatch`, `patch_restart`, `order_<순서>`, `claude_slot_billing`(8.9). `health`는 `claude_auth_missing`, `claude_auth_unverified`, `claude_auth_order:<순서>`를 내고, `pluginVersions.claudeAuth`는 확인된 번들의 버전이다.
   - 신뢰: 번들 폴더와 상태 폴더는 플러그인 허용 목록(own-accounts trust) 없이 통과한다. 그 밖의 경로에 있는 claude-auth는 다른 로컬 플러그인처럼 승인을 받아야 한다.
5. **설정 파일과 `plugins` 순서**: `%OPENCODE_CONFIG_DIR%\opencode.jsonc`(= `%USERPROFILE%\.config\own-open-code\opencode.jsonc`, 3.8). 순서는 `[own.accounts, own.remote, own.team, heymaaz.claude-auth-v2(앱에 포함), own.telemetry, own.computer-use, own.import, own.harness]`다(own.remote는 아래 끝 항목, own.team은 06 §2.6, own.computer-use는 01 §10.2, own.import는 09 §5.1, own.harness는 10). claude-auth 줄은 own 항목처럼 launcher가 관리한다(`own install`/`update`가 `<ver>`를 바꾸고, 없으면 own.team 줄 뒤에 넣는다. FORK §8.2). upstream 설치본의 `~/.config/opencode`는 건드리지 않는다.

   | 모드 | 설정 파일 | `plugins` |
   |---|---|---|
   | 운영(T1, 2.0.18-own.6) | `%USERPROFILE%\.config\own-open-code\opencode.jsonc` | `["<OWN_HOME>\app\<ver>\plugins\own-accounts", "<OWN_HOME>\app\<ver>\plugins\own-remote", "<OWN_HOME>\app\<ver>\plugins\own-team", "<OWN_HOME>\app\<ver>\plugins\claude-auth", "<OWN_HOME>\app\<ver>\plugins\own-telemetry", "<OWN_HOME>\app\<ver>\plugins\own-computer-use", "<OWN_HOME>\app\<ver>\plugins\own-import", "<OWN_HOME>\app\<ver>\plugins\own-harness"]`(`OWN_HOME` = `%LOCALAPPDATA%\own-open-code`. 설정 파일에는 펼친 절대 경로로 쓴다. 설치·업데이트가 각 항목의 `<ver>`를 바꾼다, FORK §8.2. claude-auth 줄은 2026-10-18부터) |
   | 개발(채널 `local`, 01 §5.4) | `%USERPROFILE%\.config\own-open-code-dev\opencode.jsonc` | `["<repo>\packages\own-accounts", "<repo>\packages\own-remote", "<repo>\packages\own-team", "<repo>\own\.out\claude-auth", "<repo>\packages\own-telemetry", "<repo>\packages\own-computer-use", "<repo>\packages\own-import", "<repo>\packages\own-harness"]`(claude-auth는 2번의 소스 실행 번들). 소스로 띄운 own-team의 self-HTTP는 채널 `local`의 등록 파일 `service-local.json`(또는 플러그인 옵션 `service:{url, password}`)을 읽는다(06 §2.6) |

   - 로컬 대상은 **디렉터리여야 한다**(`core/src/config/plugin/source.ts:150-154`). 진입점은 `server`, 없으면 `index`다(`plugin/src/host.ts:17-43`). 운영 번들은 `plugins\own-accounts\index.js`, claude-auth는 `plugins\claude-auth\server.js`다(01 §5.1).
   - **순서 보장은 항목이 모두 로컬 디렉터리일 때만 성립한다.** supervisor는 로컬에 있는 것부터 먼저 활성화하고, 설치 중인 npm spec 패키지는 나중에 활성화한다(`supervisor.ts:154` "Activate everything available locally before waiting on missing package installs"). 그래서 npm spec 항목(`opencode-claude-auth-v2@…`)은 순서를 보장하지 못하므로 쓰지 않는다.
   - 로컬 항목끼리의 활성화 순서는 config 순서를 따른다(`supervisor.ts:91-95`).
   - own-remote(04)는 `own.accounts` 바로 뒤, own-team(06, T1)은 그 뒤 3번이다(04 §4.1·§22, 06 §2.6, 09 §5.1, 10). claude-auth가 own.team 뒤에 있으므로 그 줄이 바뀌어도 own.team은 다시 시작하지 않는다(설정이 바뀌면 처음 바뀐 자리 뒤의 플러그인만 다시 띄움). own-computer-use는 6번이다. own-import(09)는 7번이다(IMPORT부터). 훅이 없어 요청 경로에 끼지 않고, 끝 쪽이라 더하거나 바꿔도 다른 플러그인을 다시 띄우지 않는다. launcher는 업데이트 때 own-computer-use 줄 뒤에 넣는다. own-harness(10)는 맨 뒤 8번이다(H0부터). H0에는 훅이 없어 더해도 다른 플러그인을 다시 띄우지 않고, H1의 요청 훅은 다른 own 플러그인의 훅이 모두 돈 뒤에 요청을 바꿔야 한다. launcher는 업데이트 때 own-import 줄 뒤에 넣는다. `plugin.claudeAuth.status.order`는 claude-auth가 own.team 앞이면 `before_own_team`, own.accounts 앞이면 `before_own_accounts`, own.telemetry 뒤면 `after_own_telemetry`, 없으면 `missing`이다(9.2).
6. **프로젝트에서 끄기**: 프로젝트 `opencode.json`에 `"-<같은 대상 문자열>"`을 넣는다. 정확히 일치해야 한다(`source.ts:113-120`). 그 Location에서는 `anthropic`이 비활성이 된다(8.4).
7. **옛 설치에서 옮기기**(launcher 0.6.0, 2026-10-18)
   - `own install`/`update`가 설정에서 옛 줄(`<OWN_HOME>\thirdparty\claude-auth`, 또는 그 아래 `server.js`)을 알아보고 그 자리에서 `app\<ver>\plugins\claude-auth`로 바꾼다. 줄이 없으면 own.team 줄 뒤에 넣는다. 사용자가 일부러 지운 own 줄처럼 다시 넣지 않는 규칙은 claude-auth에는 없다(늘 켜짐).
   - 설치·업데이트가 성공하고 설정에 옛 줄이 더는 없을 때만 옛 npm 설치의 파일을 지운다: `node_modules`(약 132 MB), `package.json`, `package-lock.json`, `server.js`, `own-patch.json`, `own-patch-original`. 하나라도 지우지 못하면 경고만 내고 다음 업데이트에서 다시 시도한다.
   - 남기는 것: 계정 목록 `claude-accounts.json`, `claude-auth-state\`(계정별 상태·잠금), 계정 폴더(`<OWN_HOME>\claude-accounts\<id>`), `OWN_HOME\claude-auth.json`, OpenCode 데이터베이스의 연결 credential, 옛 KV 동의 기록(읽지 않음). 다시 로그인할 필요가 없다.
   - 되돌리기: 이 판보다 옛 앱으로 돌아가면 옛 npm 설치가 지워졌으므로 그 판의 `설치`를 다시 해야 한다(로그인은 그대로).
   - 바꾼 까닭: 실행 중 설치는 Node·npm·네트워크·백신 상태에 따라 자주 실패했고, 패치를 따로 적용하고 서비스를 다시 시작해야 여러 계정을 쓸 수 있었다. 앱에 넣으면 버전·integrity·패치가 빌드에서 한 번 확인되고, 업데이트가 앱과 함께 온다.
8. **구독 가져오기**
   - 전제: Claude Code에 로그인되어 있어야 한다(`claude auth login`).
   - `POST /api/integration/anthropic/connect/oauth`, method `claude-code`(`protocol/src/groups/integration.ts:83`).
   - authorize가 이미 해결된 콜백을 돌려주므로 버튼 하나로 끝난다[R-claudeauth].
   - RPC `plugin.claudeAuth.importSubscription`이 이 호출을 대행한다. 플러그인이 감지되지 않았으면 `plugin_not_installed`다. 패치된 플러그인은 계정이 둘 이상이면 고르는 칸을 보이므로, own은 OAuth 답 `{account: 계정 1의 key}`를 명시해 넘긴다.
9. **물러난 RPC**(프로토콜 호환): `plugin.claudeAuth.install.plan`·`install.execute`·`uninstall.plan`·`uninstall.execute`·`patch.plan`·`patch.execute`는 스키마에 남고, 부르면 `internal_error`("built_in: the Claude plugin ships with the app and is always on")로 거절한다. `plugin.claudeAuth.ack`는 옛 클라이언트를 위해 성공으로 답하고 아무것도 저장하지 않는다. own-web은 이것들을 부르지 않는다. 플러그인은 제거하지 않는다. Claude를 쓰지 않으려면 계정을 연결하지 않거나 더한 계정을 뺀다(계정 없이는 아무것도 보내지 않음).

### 8.3 격리 규칙

- **I1.** `anthropic` provider와 integration은 이 슬롯 전용이다. API 키는 두지 않는다.
- **I2.** 우리 Anthropic API 키 계정은 `own-anth-*` providerID를 쓰고, integration을 쓰지 않는다(vault).
  - claude-auth의 rewrite hook은 `event.model.providerID === "anthropic"`이고, integration `anthropic`의 active credential이 claude-code OAuth일 때만 동작한다[R-claudeauth].
  - hook의 `event.model`은 세션 Ref다(`model-resolver.ts:383-386`, `model-request.ts:211`). `canonical:"anthropic"`은 Ref를 바꾸지 않는다. 그래서 우리 요청은 rewrite되지 않는다.
- **I3.** 우리 provider에 `integrationID:"anthropic"`을 주지 않는다.
  - 주면 구독 OAuth가 `authToken`으로 매핑되어(`model-resolver.ts:306-307`) 플러그인 변환 없이 날것의 구독 bearer가 나간다.
- **I4.** integration `anthropic`에 key credential을 만들지 않는다. 만들면 OAuth credential이 비활성화된다(`credential.ts:100-125`).
- **I5.** `anthropic`에 baseURL이나 헤더를 설정하지 않는다. 우리 mutating hook은 own slot 레지스트리로 거르므로(4.1) `anthropic` 요청에는 절대 작용하지 않는다. AC-P23이 이를 확인한다.
  - claude-auth의 rewrite는 host를 확인하지 않는다. baseURL을 바꾸면 OAuth bearer가 그 host로 간다.
- **I5a(2026-10-06, 4.8).** I5의 예외 하나. 사용자가 그 대화에서 Fast를 켰고 한 번만 받는 동의(KV `ack:claudeFast`)가 있으면 own-accounts의 `http.request` hook이 `anthropic` 요청 본문에 `speed:"fast"`를 넣고 `anthropic-beta`에 `fast-mode-2026-02-01`을 덧붙인다(그 뒤 그 대화의 표준 요청에는 헤더만). baseURL, credential, 그 밖의 헤더와 필드는 건드리지 않는다. claude-auth의 `http.request`는 뒤에 돌며 들어온 `anthropic-beta`를 자기 beta와 합치고 본문의 다른 필드를 그대로 둔다(claude-auth `provider.ts` `buildRequestHeaders`, `transforms.ts` `transformBody`). 그런 요청의 응답만 `usage.speed`를 읽으려고 사본을 읽는다. Fast 요청의 비용은 모드 가격으로 ledger에 적는다(7.5).
- **I5b(2026-10-09).** PC egress 중계(04 §8.11)의 upstream origin은 상수 `https://api.anthropic.com`이고, 호스트가 준 Host·절대 URL·`beta=true` 밖의 query는 쓰지 않는다. I5의 "host 확인 없음"이 원격 경로로 번지지 않게 하기 위해서다.
- **I6.** `own-anth-*` 모델은 cost를 명시하고, 고정 템플릿에서 등록한다. 템플릿의 원본은 own-accounts의 provider fold가 claude-auth **앞**에서 뜬 스냅샷이다(3.6a). RPC 핸들러에서 `ctx.model.list()`로 읽으면 claude-auth가 바꾼 `cost=[]`가 들어오므로 쓰지 않는다.
  - config provider의 canonical 복제는 post 단계에서 변환 결과를 복제한다(`core/src/config/plugin/provider.ts:59-66`). 우리는 config `providers`에 선언하지 않으므로 이 경로를 타지 않는다(01 §8.2).
- **I7.** claude-auth는 `http.request`/`http.response`를 unscoped로 등록한다. unscoped 항목은 모든 providerID에 맞으므로(`core/src/plugin/hooks.ts:97-102`) **claude-auth가 설치되면 모든 provider의 HTTP 호출이 wrapper 경로를 탄다**(요청 body 재버퍼링과 응답 재포장, `model-request.ts:295-321`). 기능 영향은 없고 오버헤드만 있다. own-accounts의 unscoped `http.response`도 같은 효과를 내므로(4.1) 추가 비용은 없다. 우리 읽기 hook 중 `anthropic`용은 own-telemetry(뒤)에만 두고, own-accounts의 unscoped 관측 hook은 `anthropic`을 첫 줄에서 거른다.
- **I8.** 우리 서버 런처는 `ANTHROPIC_*`(`ANTHROPIC_API_KEY` 포함), `CLAUDE_*`, `OPENCODE_CLAUDE_AUTH_*`를 서비스 env에서 **지우고** 스스로 설정하지 않는다(`own/launcher/own.ps1:65,128-143`). 이 값들은 플러그인이 프로세스 전체에 적용하기 때문이다.
  - **예외 하나**: 사용자가 8.7 계정 소스 변경으로 고른 `CLAUDE_CONFIG_DIR`. launcher의 `Get-BridgeEnv`(`own.ps1:158-167`)가 `OWN_HOME\claude-auth.json`의 `configDir`을 읽어 서비스 env 맵에 이 키 하나만 다시 넣는다. 다른 `CLAUDE_*`는 여전히 지운다. 이 launcher 변경은 01·05와 맞출 계약이다(12장 Q16).
  - 여러 Claude 계정(8.7)은 이 env를 쓰지 않는다. 패치된 플러그인은 계정 목록을 own이 쓴 파일에서 읽고, 로그인 창에만 그 계정의 `CLAUDE_CONFIG_DIR`을 준다.
- **I9(2026-10-10, 여러 Claude 계정, 가드 G2·G4).** 계정 선택은 요청 헤더로 하지 않는다. own-accounts의 `http.request` hook은 claude-auth보다 앞에 돈다(8.2 3번의 순서). 이 hook이 세션의 Claude 계정을 정하고(트리·팀의 바인딩, 없으면 기본 계정, 8.7), 패치된 claude-auth 모듈 — core가 로드한 바로 그 인스턴스, 04 §8.11.5의 `ClaudeWire`와 같은 로더 — 의 `bindSession(sessionID, key)`를 부른다. 그다음 claude-auth의 `http.request` hook이 그 계정의 자격 증명(`getAccountBySource(key)`)으로만 서명한다. 연결 credential, 활성 계정, 다른 계정으로 서명하는 경로는 없다.
  - 실패하면 닫힘: 플러그인이 모르는 계정, 바인딩도 기본 계정도 없음, 계정 하나로 도는 플러그인(앱의 번들이 아님·확인 실패·재시작 전)에서 다른 계정에 묶인 대화는 서명하기 전에 예외로 끝난다. own-accounts의 이 hook은 일부러 `hook.safe`로 감싸지 않는다(다른 hook과 다름).
  - 귀속(G4): 패치된 플러그인이 서명한 요청 객체를 WeakMap에 적어 `accountOf(event.request)`로 알려 준다. own-runtime의 `claude` 귀속 저장소가 이것을 own 계정 id로 바꿔 own-telemetry(한도·소진·경보)와 ledger에 넘긴다. 속도(4.8)의 Fast 표시는 아직 슬롯 하나(`acc_claude_slot`)로 센다. 응답이 올 때의 바인딩이 아니라 서명한 계정이다.

### 8.4 동의 없음과 차단

- **동의 없음(2026-10-18, 사용자 결정 CB)**: 플러그인이 앱에 들어 있고 늘 켜져 있으므로 로컬 동의를 받지 않는다. 위험 고지(03 §5.4.1(a))는 정보로 보인다. `status.acknowledged`는 늘 `null`이고, `plugin.claudeAuth.ack`는 저장하지 않는다(8.2 9번). 원격 사용 동의(8.4a)와 Fast 동의(`ack:claudeFast`, 4.8)는 그대로다.
  - 이전 규칙(2026-10-18 전): KV `ack:claudeAuth = {acknowledgedAt, pluginVersion, integrity, noticeHash, patchSha256?}`가 설치본의 버전·integrity·고지 해시(·패치 해시)와 모두 맞을 때만 슬롯을 켰다. 그 기록은 지우지 않고 읽지도 않는다.
  - 아무것도 보내지 않는 조건: 연결된 Claude 계정이 없으면 플러그인은 계정이 없고(8.2 3번 own 계정 모드) 서명하지 않는다. `anthropic` provider도 연결이 없으면 내장 activation(`auto`)대로 보이지 않는다. own의 `http.request` hook은 계정을 정하지 못하면 서명 전에 실패한다(8.3 I9).
- **`anthropic` activation 규칙(하나로 정함, 01 §8.2 "슬롯이 설치된 경우에만 보이게"와 같다)**
  - `enabled`로 두는 조건: 플러그인이 감지되었고 **그리고** 앱의 번들로 확인되었다(`detected && verified`, 8.2 4번). 이때도 own-accounts는 `activation` 값을 건드리지 않고 원래 값(내장 기본)으로 둔다. 원격 호스트에서는 claude-auth가 없으므로 own-accounts가 미러 판정이 `enabled`일 때 `activation:"enabled"`와 모델 `cost:[]`를 직접 둔다(04 §8.11.4.3).
  - 그 밖에는 모두 `"disabled"`다. 플러그인이 설치되지 않은 경우도 포함한다. 그래서 `ANTHROPIC_API_KEY` env나 전역 credential로 내장 `anthropic`이 조용히 과금되는 경로도 막힌다. Anthropic API는 `own-anth-*`로만 쓴다.
  - 적용 위치: own-accounts의 provider transform. claude-auth는 name과 integrationID만 설정하고 activation은 건드리지 않는다[R-claudeauth].
  - 결과: 비활성이면 모델 목록에서 빠지고, 이미 이 슬롯에 묶인 세션은 모델을 쓸 수 없다는 오류로 멈춘다. 서버 쪽에서 강제하는 장치다.
- **플러그인 감지**
  - `ctx.plugin.list()`에서 id `heymaaz.claude-auth-v2`인 항목이 활성 상태인지 본다(`core/src/plugin/host.ts:419-421`, id는 [R-claudeauth]). id가 바뀌면 package 이름 `opencode-claude-auth-v2`로 본다. 감지할 때 로드된 항목의 폴더가 앱의 번들인지와 그 `own-bundle.json`의 버전·integrity·hash를 확인해 `own-runtime`에 둔다(8.2 4번).
  - 시점: own-accounts setup에서는 claude-auth가 아직 활성화되기 전이다(순서상 뒤). 그래서 `plugin.updated` 이벤트(`schema/src/plugin.ts:46`)를 받을 때마다 다시 확인한다. transform fold 안에서는 목록을 조회하지 않고, 확인 결과를 `own-runtime`에 두고 읽는다(3.8의 no-I/O 규칙).
- **전파**: 감지 상태나 확인 결과가 바뀌면 3.8의 재조정 경로로 **모든 Location 인스턴스**가 `ctx.provider.reload()`를 부른다. 한 Location에서만 부르면 다른 열린 프로젝트에서는 재시작 전까지 `anthropic`이 비활성으로 남는다. AC-P24가 이를 확인한다.

### 8.4a 원격 사용 동의

KV `ack:claudeRemote = {acknowledgedAt, pluginVersion, integrity, noticeHash}`는 이 PC에만 있다. 슬롯이 확인된 번들이고(2026-10-18 전에는 유효한 로컬 동의), 세 값이 번들의 pin(`status.bundle`의 버전·integrity)과 원격 고지 해시(`REMOTE_HASH`)와 같을 때만 유효하다. 앱 업데이트로 플러그인 버전이 바뀌면 원격 사용은 다시 묻는다. 패치만 바뀐 업데이트(예: 2026-10-30 CV의 `ccVersion` `2.1.308`)는 다시 묻지 않는다(`Claude.ackValid`는 버전·integrity·고지 해시만 보고 `patchSha256`은 보지 않는다). 로컬 고지 `HASH`는 바꾸지 않는다. 호스트별 켜기는 `accounts.json`의 `claudeSlot.remoteHosts`이고, 기본값은 비어 있다. 원격에서는 `plugin.claudeAuth.*`가 `remote_managed`다(04 §8.11.12).

### 8.5 한도 표시

- **보여 줄 수 있는 것**: 응답에 실려 오는 unified 헤더만 쓴다(7.1).
  - 5h·7d 사용률과 리셋 시각(5시간 창이 없는 계정은 주간만, 7.1.2)
  - 상태(허용·주의·차단)
  - 대표 창
  - 초과 사용 상태와 청구 판정(`claude.overage`의 `meta.billing`, 8.9)
  - 사용하지 않는 동안에는 갱신되지 않는다(`confidence` 저하).
- **보여 줄 수 없는 것**: 남은 메시지 수나 토큰 수, 플랜의 절대 한도, API 방식의 지출.
- **하지 않는 것**: `api.anthropic.com/api/oauth/usage` 폴링. 추론 외 용도로 토큰을 써서 약관 노출이 커진다[compat §1.6].
- **Claude 리셋권(RP 2026-10-26)**: 보이지도 쓰지도 않는다. 응답의 unified 헤더는 리셋권을 싣지 않고, 실을 수 있는 곳은 위의 `oauth/usage`뿐이다. 설치된 Claude Code 2.1.282에도 리셋권을 쓰는 요청이 없다(문자열 검색: 사용량 안내는 `claude.ai/settings/usage` 링크뿐). 약관상 구독의 사용량 관리는 claude.ai나 Claude Desktop에서 하는 일이다. 그래서 펼친 한도와 한도에 닿은 대화의 배너에 흐린 줄 `Claude 리셋권은 claude.ai 설정 > 사용량에서 확인하고 쓸 수 있어요`(https://claude.ai/settings/usage 링크)만 둔다(03 §7.1.1). `quota.resetCredits.*`는 Claude 계정에 `not_supported`로 답한다.
- 표시 라벨: `Claude Max · na***@…`. credential label에 tier와 email이 들어 있다[R-claudeauth]. `GET /api/integration/anthropic`의 connection label을 쓴다. 사용자가 `accounts.update`로 라벨을 바꾸면 `accounts.json.claudeSlot.label`이 우선한다.
- **UI에서의 계정 정체성**: 계정 1은 합성 계정 `acc_claude_slot`(9.2 `accounts.list`)이다. 색, 약칭, 칩, 세션 수, "사용 중 계정" 목록, 한도 막대가 모두 이 id를 쓴다. 추가한 Claude 계정(8.7)은 `acc_<ulid>`이고 `accounts.list`에 `kind:"claude-sub"`, `providerID:"anthropic"`, `claude:{managed, default, folder, email?, loaded, shared?, stale?, accountUuid?}`로 따로 나온다(`shared`·`stale`: Claude Code 자신의 폴더와 그 로그인의 만료, 8.7 CS. `accountUuid`: SK2 2026-10-24, 기록의 값이나 계정 1이면 그 폴더의 `.claude.json`에서 폴더마다 한 번 읽은 값, 비밀 아님. 스킬 가져오기가 Claude 앱의 `skillssynced<org>_<account>` 폴더를 계정 이름으로 부를 때 쓴다, 09 §9.10). 계정마다 카드, 라벨, 색, 세션 수, 한도 막대가 따로 있다.
- **계정마다의 한도(2026-10-10)**: unified 헤더에서 만든 `LimitWindow`(`claude.5h`, `claude.7d`, `claude.overage`)의 `accountID`는 **그 요청에 서명한 Claude 계정**이다(8.3 I9의 귀속, `Unified.parse(…, accountID)`). 응답이 올 때의 바인딩이 아니다. 소진 기록(`limits.exhaust`), extra-usage 경보, 긴 멈춤 판단(8.8)도 그 세션의 마지막 서명 계정에 붙는다. ledger 줄의 `accountID`도 같다(own-accounts telemetry, `runtime.claude.lastOf`). 원격 호스트의 요청은 egress proof v2가 이름 댄 계정으로 PC가 서명하고 그 계정에 귀속한다(04 §8.11.18).

### 8.6 캐시

- `anthropic`(구독)과 `own-anth-*`(API) 사이 전환은 **완전히 cold**다. 도메인이 다르고, 플러그인이 prefix 바이트 배치를 바꾸기 때문이다(identity 블록, system 이동, 도구 이름 변경)[compat §1.3 #10].
- 플러그인 버전이 바뀌면(`cc_version`) 세션마다 한 번 cold가 된다.
  - 청구 헤더는 `system[0]`(cache_control 없음)이고 캐시되는 블록이 모두 그 뒤에 있다. 그래서 알리는 버전을 바꾸는 업데이트(2026-10-30 CV, `2.1.280` → `2.1.308`)는 업데이트 뒤 각 Claude 구독 대화의 첫 요청을 한 번 cold로 만든다(그 앞의 도구 정의만 캐시에 남을 수 있음). 다음 요청부터는 같은 바이트다(`patched-plugin.test.ts` "an update from 2.1.280 changes only system[0]"). 릴리스 노트에 적는다.
- 플러그인이 `extended-cache-ttl` beta를 항상 보내므로 1h hint가 적용될 수 있다. 다만 이 슬롯에 우리 hint를 넣는 것은 MVP에서 하지 않는다(I5).

### 8.7 여러 Claude 계정(2026-10-10, 사용자 결정 C-D1–C-D3)

이 절이 이전의 "계정 전환의 한계"(Windows에서는 계정 1개만, 바꾸려면 `CLAUDE_CONFIG_DIR`을 바꾸고 재시작하는 전역 전환)를 바꿨다. 플러그인 0.4.0-beta.5는 Windows·Linux에서 계정 하나만 읽는다(`readAllClaudeAccounts`, `CA/keychain.js:247-256`). 그러나 내부는 이미 `source`마다 서명한다(`getAccountBySource`, `prepareClaudeRequest(…, source)`). 그래서 패치(8.2 3번)로 여러 config 폴더를 여러 계정으로 읽게 하고, 대화마다 계정을 정한다. core 패치는 없다.

**사용자 결정(2026-10-10)**
- C-D1 쓰임: Codex 계정처럼, 서로 다른 대화가 서로 다른 Claude 계정을 **동시에** 쓴다.
- C-D2 구현: 플러그인을 작게 패치한다(8.2 3번). 재구현이 아니다. 2026-10-18부터는 빌드가 패치를 적용해 앱에 싣고(재배포, MIT), 무결성 검사는 패치된 파일의 기록을 본다.
- C-D3 자동 전환: Claude 계정끼리는 한도가 차면 저절로 바꾼다(같은 회사끼리만, 다른 회사로는 안 감). 이것은 이전의 "Claude 슬롯은 자동 전환하지 않음"을 Claude↔Claude에 한해 바꾼다(5.10, 8.8). 2026-10-31 사용자 결정 CAG-5가 기본값만 철회했다: 새로 설치하면 `claudeToClaude`는 `off`이고, 설정은 남아 사용자가 `자동`을 고를 수 있다. 이미 저장된 `auto`는 한 번 `off`로 바꾸고 알린다(CAG-15, 8.8).
- 그대로인 것: R4/U5(하위 에이전트·팀은 회사마다 구독 하나), 로그인은 사용자가 직접 한다, PC마다 고지·동의, 원격 중계는 토큰을 PC에 둔다.
- 쉬운 로그인: 로그인 정보가 어디 있는지 몰라도 된다(아래 "추가").

**계정과 등록부**
- 계정 1 = 슬롯 자신(`acc_claude_slot`). 폴더는 `accounts.json` `claudeSlot.configDir`(`own 전용 로그인으로 바꾸기`로 옮긴 own 폴더, 아래 "Claude Code의 로그인 폴더"), 없으면 `OWN_HOME\claude-auth.json`의 `configDir`(아래 "계정 1의 폴더"), 없으면 `%USERPROFILE%\.claude`다. 표시 정보는 `accounts.json` `claudeSlot`(라벨·약칭·색·`remoteHosts`)에 있다. ledger·한도와 호환되도록 id를 그대로 둔다.
- 추가한 계정 = `accounts.json` `claudeAccounts[]` `{accountID: acc_<ulid>, key, configDir, label, shortLabel, color, managed, email?, accountUuid?, addedAt}`. `key`는 정규화한 폴더(`path.resolve`, Windows는 소문자)로 플러그인 안의 이름이다. `managed`는 own이 만든 폴더(`<OWN_HOME>\claude-accounts\<id>`)다. `email`은 가린 값, `accountUuid`는 같은 로그인을 두 번 넣지 않기 위한 값이다(비밀 아님).
- 기본 계정 `claudeDefault`(없으면 `acc_claude_slot`): 바인딩 없는 새 대화가 쓰는 계정이다. 스위처에서 마지막으로 고른 계정이 기본이 된다(`session.set`, `default.set`).
- 리더가 `<OWN_HOME>\thirdparty\claude-auth\claude-accounts.json` `{version:2, default: key, accounts:[{key, configDir, label, readOnly?}]}`을 쓴다. 키, 폴더, own의 라벨(오류 문구용), 읽기 전용 표시(CS, 아래 "Claude Code의 로그인 폴더")뿐이다. 패치된 플러그인은 이 파일이 바뀌면 다음 조회 때 다시 읽고, 이미 아는 계정의 상태는 그대로 둔다.
- **이 판의 목록 전에는 서명하지 않는다(CS 재검토 a, 2026-10-23)**: 인스턴스는 디스크의 목록이 이 판(`version:2`, `ClaudeBundle.LIST_VERSION`)인 것을 본 뒤에만 요청을 서명하게 둔다(`ClaudeAccounts.ready`). 업데이트 뒤 첫 시작에는 예전 own이 쓴 `readOnly` 없는 목록이 있고, `plugins` 모듈과 중계가 `start`의 `sync()`보다 먼저 플러그인에 그 목록을 읽힐 수 있기 때문이다. 리더는 아직 못 썼으면 요청 때 다시 쓰고, 다른 인스턴스는 리더의 목록이 있는지 본다. 그 전(또는 쓰기가 실패하면)에는 서명 전에 `Claude 계정 목록을 아직 준비하지 못했어요 · 잠시 뒤 다시 시도해요. 계속 뜨면 서비스를 다시 시작해요. Claude 계정 {label}의 요청은 보내지 않았어요.`로 거절하고(경보 `claude_account_refused`) 다음 요청이 다시 본다. PC 중계(04 §8.11.5)도 그때까지 `not_ready`(`wire`)다. 플러그인 쪽에도 같은 경우의 닫힘이 있다(8.2 3번).

**대화의 계정(바인딩, G2, 07 R4)**
- KV `claude:session:<root>` `{accountID, at}`: 루트 세션 트리가 쓰는 계정이다. 하위 에이전트는 루트의 계정을 쓴다(own이 요청마다 그 세션을 묶는다). 팀에 속한 루트(프리셋 바인딩의 `team.teamID`)는 KV `claude:team:<teamID>`가 먼저다. 그래서 트리 하나·팀 하나는 언제나 Claude 계정 하나다.
- 새 트리가 처음 요청할 때 바인딩이 없으면 그때의 기본 계정을 적어 둔다. 기본이 나중에 바뀌어도 그 대화는 옮겨지지 않는다.
- 스위처의 `Claude · {label}`(`plugin.claudeAuth.session.set{sessionID, accountID}`)은 그 트리(팀이면 팀 전체)를 옮기고 그 계정을 기본으로 한다. 캐시는 새로 쌓인다. 전환 추정(`switch.estimate`)은 대상의 캐시를 그 Claude 계정의 항목(2.4.6)에서 읽는다: 대상 계정은 `accountID`, 없으면 대화 트리의 계정이다. 대화가 머무는 쪽도 트리의 계정이다. 그래서 AC-03에서 돈 대화를 AC-01로 옮긴 뒤 세 번째 계정 AC-02로 가는 추정은 차갑고, 수명 안에 AC-03으로 돌아가는 추정은 따뜻하다(SL-8 2026-10-27. 그 전에는 `anthropic` 항목 하나라 어느 Claude 계정으로 가든 따뜻하게 보였다). 트리의 계정은 트리의 binding에서 읽는다(`accountOf`). 플러그인의 동기 조회(`peek`)는 서비스가 다시 시작된 뒤 그 트리의 요청이나 binding 읽기가 한 번 돌기 전까지 기본 계정을 답하므로, 전환 추정·`cache.state`(9.2)·속도 추정(4.8)이 그것을 쓰면 다른 계정에 묶인 대화를 기본 계정의 캐시로 판정했다(SL-17 2026-10-27). 새 대화에서 고르면 `plugin.claudeAuth.default.set{accountID}`만 부른다. 옮긴 대화마다 `binding.changed`를 낸다.
- 요청마다(8.3 I9): own-accounts `http.request`가 바인딩을 읽어 `bindSession(sessionID, key)` → claude-auth가 그 계정으로 서명. 계정 하나로 도는 플러그인(앱의 번들이 아님·`patched`가 아님·재시작 전)에서는 바인딩이 없거나 계정 1인 대화만 가고(이때 바인딩을 쓰지 않음), 다른 계정에 묶인 대화는 서명 전에 거절된다(경보 `claude_account_refused`). 없어진 계정에 묶인 대화도 거절된다.
- 실패하면 닫힘(2026-10-11): 다음은 모두 서명 전에 거절한다(경보 `claude_account_refused`). 플러그인이 그 계정의 로그인을 갖지 않음(`ownAccounts()`에 키가 없음. 목록 파일이 없어 플러그인이 원래 동작으로 돌 때도 여기에 걸림), 플러그인 순서에서 claude-auth가 own.accounts보다 앞(`before_own_accounts`, 앞 요청의 바인딩으로 서명하게 됨). 바인딩·루트·팀을 읽다 실패하면 요청이 실패하고 아무것도 쓰지 않는다(읽기 실패를 "바인딩 없음"으로 보고 기본 계정을 써 넣지 않음). 패치된 플러그인도 own이 묶은 대화를 목록 파일 없이 받으면 서명하지 않는다.
- 팀이 나중에 생길 때(07 R4, 2026-10-11): 루트의 팀은 요청마다 프리셋 바인딩에서 다시 읽는다(own-team이 이미 돈 루트를 팀에 넣을 수 있음). 팀 바인딩이 없으면 한 번만, 트리마다 하나씩 차례로 정한다: 팀 문맥의 `accounts`에 든 Claude 계정, 없으면 이 루트가 이미 쓰던 계정, 없으면 이 서비스가 아는 다른 팀원 루트가 쓰던 계정, 없으면 기본 계정. 팀원 루트의 자기 바인딩이 팀 계정과 다르면 팀 계정으로 다시 적고 `claude.bound`·`binding.changed{external}`를 낸다. 팀을 옮기면(`session.set`, 자동 전환, 계정 빼기) 팀원 루트의 자기 바인딩도 같이 옮긴다.
- `plugin.claudeAuth.session.get{sessionID}` → `{accountID, bound}`. `session.binding`의 `accountID`도 그 대화의 Claude 계정이다.

**추가(`Claude 계정 추가`, 쉬운 로그인, G9)**
- RPC `plugin.claudeAuth.accounts.add.plan{}` → `add.execute{nonce}` → `add.status{attemptID}`(1초마다). 메서드 범위 `local`: 이 PC의 창에서만 된다. 다른 기기는 `로그인 추가는 이 PC의 창에서만 할 수 있습니다.`를 본다. 원격 서비스는 `remote_managed`다.
- `plan{accountID?}`: 슬롯 감지와 다중 계정 export 로드가 필요하다(아니면 `plugin_not_installed`, `claude_account_unavailable{not_patched}`). `accountID`를 주면 **다시 로그인**(2026-10-18)이다: 새 계정을 만들지 않고 그 계정의 폴더(계정 1이면 계정 1의 폴더)에서 같은 로그인 창을 연다. 설치된 Claude Code를 찾는다: `%USERPROFILE%\.local\bin\claude.exe`, 없으면 `Bun.which("claude")`. 새 id와 폴더 `<OWN_HOME>\claude-accounts\<id>`를 정한다. 결과 `{nonce, expiresAt, cli, folder}`.
- `execute`: Claude Code가 없으면 `claude_account_unavailable{cli_missing}`, 이미 창이 열려 있으면 `{busy}`. 폴더를 만들고 `claude auth login --claudeai`를 **이 PC의 보이는 콘솔 창**에서 연다(`cmd /d /c start "Claude Code 로그인" /wait …`). env는 시스템 변수 허용 목록과 `CLAUDE_CONFIG_DIR=<폴더>`뿐이다(`ANTHROPIC_*`, 다른 `CLAUDE_*`, own·OpenCode 변수, 서비스 비밀번호는 넘기지 않음).
- 기다리는 동안 보는 것은 둘뿐이다: `<폴더>\.credentials.json`이 있는지와 수정 시각(1초 간격, 10분 상한), 창의 종료 코드. **파일 내용은 절대 읽지 않는다.** 10분이 지나면 창(프로세스 트리)을 닫는다(`timeout`). 로그인 없이 닫히면 `failed`.
- 로그인 뒤 `<폴더>\.claude.json`에서 `oauthAccount.emailAddress`와 `oauthAccount.accountUuid`만 읽는다(기본 폴더면 `%USERPROFILE%\.claude.json`도). 이미 있는 계정의 uuid와 같으면 `duplicate`(그 계정 id)이고 own이 방금 만든 폴더를 지운다. 아니면 `claudeAccounts`에 더하고, 계정 목록 파일을 쓰고, `claudeSlot.changed{accounts}`를 낸다. 화면 문구의 요금제는 플러그인이 만든 라벨(`Claude Max: …`)에서 읽는다(own은 토큰을 읽지 않음).
- own은 비밀번호를 입력하지 않고, 토큰을 다루지 않으며, Claude Code를 내려받거나 설치하지 않는다. 사용자가 더하는 계정은 전용 폴더를 쓴다. 매일 쓰는 `~/.claude`를 함께 쓰면 Claude Code의 토큰 회전과 겹친다.

**기존 로그인 가져오기(`이 PC의 기존 Claude Code 로그인 가져오기`)**
- `plugin.claudeAuth.accounts.detect{}` → `{found: {folder, email(가림)} | null, imported}`. 폴더는 계정 1의 폴더다. 로그인이 있는지는 `.credentials.json`이 있는지로만 보고, 이메일은 `.claude.json`의 `oauthAccount.emailAddress`만 읽는다.
- 버튼 하나로 기존 `plugin.claudeAuth.importSubscription`(8.2 8번)을 부른다.

**다시 로그인(2026-10-18, 버그 1)**
- 로그인이 없거나 만료된 계정(`accounts.list`의 `status:"needs_reauth"`, 플러그인의 `ownAccounts()`에 키가 없음)은 카드에 `이 계정의 로그인이 없거나 만료됐어요 — [다시 로그인]을 누르세요.`와 `다시 로그인`을 보인다. 카드의 `⋯`에도 있다(이 PC의 창에서만).
- `plugin.claudeAuth.accounts.add.plan{accountID}` → `add.execute` → `add.status`(위 "추가"와 같음). 끝나면 `다시 로그인했어요: {label}`. 대화의 오류 문구(8.2 3번)가 이 버튼을 가리킨다.
- 갱신이 끝난 실패로 끝난 계정(아래 "로그인 새로 고침")은 이 일반 문구 대신 카드의 갱신 줄이 까닭과 `다시 로그인`을 보인다.
- 읽기 전용 계정(Claude Code가 쓰는 폴더, CS 2026-10-22, 아래)에서는 그 폴더에 로그인하지 않는다. 그 폴더에 다시 로그인하면 Claude Code의 로그인을 바꿔 놓고, 폴더를 계속 함께 쓰므로 같은 일이 되풀이된다. 대신 아래 `own 전용 로그인으로 바꾸기`가 된다(`plan`의 `move: true`). `plan`과 `execute`는 그때 폴더를 다시 읽는다(CS 재검토 c, 15초 감시의 값이 아님). `다시 로그인`으로 계획한 뒤 그 폴더가 Claude Code의 것이 되면(정션·링크를 만듦) `execute`가 `nonce_invalid`로 거절하고, 다시 계획하면 옮기기가 된다.

**로그인 새로 고침(own이 갱신하는 계정, 2026-10-26, CR)**
- 까닭(사용자 질문 2026-10-26 "왜 AC-01이랑 02 03이랑 다르게 동작하는지"): 코드에서 AC-01을 다르게 다루는 곳은 없었다. 세 계정 모두 갱신 요청이 토큰 끝점의 HTTP 429로 같은 방식으로 실패했고, 요청마다 약 50초를 기다린 뒤 `Claude 로그인 서버에 잠시 연결하지 못했어요`로 거절됐다(8.2 3번 "갱신 요청은 Claude Code 2.1.282의 요청 그대로"). 달라 보인 것은 기록과 화면이다. AC-01은 같은 까닭으로 세 가지 문구를 겪었고(10-22 2.0.28-own.6의 `만료되었고 새로 고치지 못해`, 10-24 Claude Code와 같은 로그인일 때의 공유 로그인 문구, 옮긴 뒤 잠깐의 실패 문구), AC-02·AC-03은 처음 쓴 날에야 실패가 보였고 아무것도 보내지 않았는데 `이 계정의 첫 Claude 요청이에요`가 떴다(8.9). 그리고 모든 카드가 갱신이 실패하는 동안에도 `ready`였다.
- 카드(`accounts.list`의 `claude.refresh`, `Account.ClaudeRefresh`): own이 갱신하는 모든 Claude 계정(계정 1이든 더한 계정이든 같다. Claude Code의 로그인 폴더인 계정에는 없다)은 플러그인의 `ownAccounts().refresh`와 만료 시각으로 같은 한 줄을 보인다.
  - `failed`(끝난 실패): `status`는 `needs_reauth`이고 `usable()`, 자동 전환(8.8), 원격 미러의 `usable`에서 빠진다. 카드는 일반 문구 대신 `로그인을 새로 고치지 못했어요(HTTP 400 invalid_grant) · 다시 로그인하세요.`와 `다시 로그인`을 보인다(경고).
  - `retrying`(잠깐의 실패): `ready` 그대로, 보통 글씨 한 줄 `로그인 새로 고침이 잠시 막혔어요(HTTP 429 rate_limit_error) · 다음 요청에서 다시 해요`.
  - `due`: 액세스 토큰이 만료됐지만 아직 아무도 갱신해 보지 않았다. **오류가 아니다**(첫 요청이 새로 고침). `ready`, 흐린 글씨 `로그인 토큰이 만료됐어요 · 다음 요청에서 새로 고쳐요`.
  - 그 밖(살아 있는 토큰, 갱신 성공): 줄이 없다. 상태가 없을 때 까닭은 HTTP 상태와 오류 코드, 답이 없으면 `연결 실패`·`시간 초과`, refresh token이 없으면 `새로 고침 토큰 없음`이다. 문구는 own-web `accounts/claude-refresh-strings.ts`(지연 로드).
- 따라가기: 리더는 플러그인의 갱신 알림(`ownOnRefresh`, 8.2 3번)을 듣고 그 자리에서 카드의 줄을 바꾸며, 15초 감시 때 플러그인의 상태를 다시 읽는다. 줄이 바뀌면 `account.status{accountID, status: needs_reauth|ready, reason: "claude_refresh"}`를 낸다. own-web은 Claude 계정의 `account.status`가 이 까닭이면 상태가 같아도 `accounts.list`를 다시 읽는다. `다시 로그인`이 폴더에 새 로그인을 쓰면 플러그인이 다음 조회에서 그것을 읽고 실패를 지운다(요청 없이).
- 기록(CS-8 (d) 닫음): 갱신마다 `OWN_HOME\logs\own-accounts.log`에 scope `own.accounts.claude`로 한 줄을 쓴다. `claude_refresh_started`(info: `accountID`, `label`, `trigger` `expiry|401`, `expiresAt`), `claude_refresh_ok`(info: `ms`, `expiresAt`, `rotated`), `claude_refresh_failed`(warn: `kind` `terminal|transient`, `status`, `error`, `description`(160자, 토큰은 `[token]`), `reason`, `retryAfterMs`, `retryAt`, `ms`). 토큰은 적지 않는다(플러그인이 알리지 않고, own의 로거도 가린다). 카드의 줄이 바뀌면 `claude_refresh_line`도 남는다.

**Claude Code의 로그인 폴더(계정 1과 그 폴더를 쓰는 모든 계정, 2026-10-22, CS)**
- 까닭(사용자 보고 2026-10-22, 2.0.28-own.6): AC-01은 가져온 기존 로그인이라 폴더가 `C:\Users\<사용자>\.claude`, 곧 Claude Code 자신의 폴더였다. 그때까지 패치된 플러그인은 이 계정의 토큰이 만료 1분 안이면 스스로 refresh해 회전된 토큰을 Claude Code의 `.credentials.json`에 써 넣었다. Claude Code도 같은 토큰을 refresh하므로, 둘이 엇갈리면 한쪽이 이미 쓴 refresh token을 내밀어 `invalid_grant`를 받았다(own이 지면 `로그인이 만료되었고 새로 고치지 못해`, Claude Code가 지면 Claude Code 로그아웃). 잠금도 서로 달랐다. 이 오류는 늘 나는 것이 아니라 토큰 수명마다(만료 때 둘 다 쓰고 있으면) 몰려서 난다. Claude Code가 새로 고치면 저절로 풀린다. 토큰 끝점의 일시 장애(429·5xx·네트워크)가 45초 넘게 가도 같은 문구가 났다(CS-10에서 잠깐의 실패 문구로, CR에서 끝점이 한 말과 다음 갱신 시각을 말하는 문구로 바뀜, 8.2 3번).
- **누가 정하나(검토 지적 1, 2026-10-22)**: own이다. 계정 1이 own 폴더(`claudeSlot.configDir`) 없이 기본 폴더에 있으면 그 폴더가 `%USERPROFILE%\.claude`든 `claude-auth.json`이 정한 폴더든(launcher가 Claude Code의 `CLAUDE_CONFIG_DIR`로 넘기는, 사용자가 Claude Code로도 쓰는 프로필인 경우가 많음) **늘** 읽기 전용이다. 다른 계정도 폴더의 realpath가 Claude Code의 폴더(`%USERPROFILE%\.claude`, 그 기본 폴더, 서비스의 `CLAUDE_CONFIG_DIR`) 중 하나의 realpath와 같거나(정션, 다른 철자), 그 `.credentials.json`이 Claude Code 폴더의 `.credentials.json`과 realpath나 파일 id(`stat` bigint `dev:ino`)가 같으면(파일 심볼릭 링크, 하드 링크, CS 재검토 b) 읽기 전용이다. own은 이것을 시작할 때, 목록을 쓸 때, 15초 감시 때, 그리고 `add.plan`·`add.execute`·`remove.plan`·`remove.execute`를 처리할 때마다 다시 읽고(CS 재검토 c), 리더가 목록 파일에 `readOnly: true`를 적는다(바뀌면 다시 씀). 플러그인은 이 표시를 따르고 `%USERPROFILE%\.claude`와 `CLAUDE_CONFIG_DIR`은 스스로도 읽기 전용으로 본다(8.2 3번, own의 결정의 일부). `계정 빼기`의 `로그인 폴더도 지우기`도 읽기 전용 폴더에는 보이지 않고, 계획 뒤 읽기 전용이 된 폴더는 `execute`가 지우지 않는다(`folderDeleted:false`).
- 이제 이 폴더는 **읽기만** 한다(8.2 3번): own은 Claude Code의 토큰을 refresh하지도, 쓰지도, `claude -p`로 갱신하지도 않는다. 토큰이 살아 있으면 그대로 서명하고, 만료되면(1분 여유) 요청을 거절하며 `AC-01은 Claude Code와 같은 로그인을 써요. 그 로그인이 만료됐어요. Claude Code에서 요청을 한 번 보내거나, own 전용 로그인으로 바꾸세요. …`라고 말한다. Claude Code가 새로 고치면(Claude Code에서 요청 한 번) 다음 요청이 그 토큰을 읽는다. 쉬고 있는 Claude Code는 스스로 새로 고치지 않으므로, 어느 문구도 기다리기만 하라고 하지 않는다(CS 재검토 e).
- **그래서 멈춘다(검토 지적 2)**: Claude Code가 쉬고 있으면 AC-01은 액세스 토큰이 만료될 때마다(몇 시간마다) 멈춘다. 화면과 설명서는 이것을 그대로 말하고 `own 전용 로그인으로 바꾸기`를 진짜 해결로 권한다(카드 `Claude Code가 쉬고 있으면 몇 시간마다 멈춰요 · own 전용 로그인으로 바꾸면 own이 직접 갱신해요`).
- 카드(`accounts.list`): 이 계정의 `claude.shared: true`. 토큰이 만료됐으면 `claude.stale: true`이고 `status`는 `needs_reauth`다(만료 시각은 플러그인의 `ownAccounts().expiresAt`, 토큰 아님). `usable()`과 자동 전환(8.8)의 후보, 원격 미러의 `usable`에서도 빠진다. 카드는 `AC-01은 Claude Code와 같은 로그인을 쓰는데, 그 로그인이 만료돼 멈췄어요. Claude Code에서 요청을 한 번 보내면 Claude Code가 새로 고쳐서 다시 돼요. …`와 `own 전용 로그인으로 바꾸기` 단추를 보인다. 만료 전에는 한 줄 `Claude Code가 쉬고 있으면 몇 시간마다 멈춰요 · …`와 같은 단추다. 계정 1만이 아니라 `claude.shared`인 **모든** Claude 카드가 같다(CS 재검토 f: 정션·링크·`claude-auth.json` 폴더의 추가 계정). 전환기는 `Claude Code에서 요청을 한 번 보내거나 own 전용 로그인으로 바꿔요`라고 흐리게 보이고, 한도 패널도 `다시 로그인 필요` 대신 같은 줄을 보인다.
- 새로 고침 따라가기: 리더가 15초마다 플러그인의 만료 시각을 본다(플러그인은 만료된 이 계정의 `.credentials.json` 수정 시각이 바뀌었을 때만 다시 읽음). 이 계정이 만료되거나 다시 살아나면 `account.status{accountID, status: needs_reauth|ready, reason?: "claude_shared_stale"}`를 낸다. own-web은 Claude 계정의 `account.status`가 목록의 상태와 다르면 `accounts.list`를 다시 읽는다. 같은 15초마다 모든 인스턴스가 플러그인이 든 로그인 목록을 다시 읽는다(나중에 Claude Code에 로그인한 경우).
- `own 전용 로그인으로 바꾸기`(`다시 로그인`과 같은 RPC): `plugin.claudeAuth.accounts.add.plan{accountID}` → `{…, folder: <OWN_HOME>\claude-accounts\acc_<새 id>, move: true}` → `add.execute` → `add.status`. 같은 Claude Code 로그인 창을 새 폴더에 연다. 로그인이 끝나면
  - 이 PC의 **다른** 계정과 같은 uuid면 `duplicate`이고 새 폴더를 지운다(계정 1 자신의 이전 로그인과 같은 uuid는 괜찮음. 같은 계정의 두 번째 로그인).
  - 옮기기 전 폴더의 로그인(`ClaudeLogin.profile`: `.claude.json`의 `oauthAccount`만 읽음)과 uuid가 **다르면**(다른 Claude 계정으로 로그인, 검토 지적 4) `mismatch`이고 새 폴더를 지우며 계정 1은 그대로다. 화면은 `다른 Claude 계정으로 로그인했어요 · 같은 계정으로 다시 로그인하거나 계정을 새로 추가하세요`와 `새 계정으로 추가`(같은 창이 `Claude 계정 추가`가 됨)를 보인다. 어느 쪽 uuid든 알 수 없으면 옮긴다.
  - 아니면 `accounts.json` `claudeSlot.configDir = <새 폴더>`를 적는다. id(`acc_claude_slot`), 라벨, 약칭, 색, 원격 호스트, 대화 바인딩(KV는 id로 적힘), ledger·한도 기록은 그대로다. 계정 목록 파일을 다시 쓰고(`key`가 새 폴더) `claudeSlot.changed{accounts}`를 낸다. 서비스를 다시 시작하지 않는다. 끝나면 `own 전용 로그인으로 바꿨어요: {label}`.
  - 창을 닫거나 시간이 지나면 새 폴더를 지우고 계정 1은 그대로다.
  - Claude Code의 `%USERPROFILE%\.claude`는 읽지도 지우지도 바꾸지도 않는다. 그다음부터 own은 새 폴더의 로그인을 다른 전용 계정처럼 refresh한다.
- `claude-auth.json`(아래 "계정 1의 폴더")을 쓰지 않는 까닭: launcher가 재시작 때 그 `configDir`을 서비스 env `CLAUDE_CONFIG_DIR`로 넣는다. 그러면 own-import의 Claude Code 기본 위치(09, `CLAUDE_CONFIG_DIR`이 있으면 그것)가 사용자의 대화 기록이 없는 전용 폴더로 바뀐다. `claudeSlot.configDir`은 서비스 안에서만 쓰이고 재시작이 필요 없다. 둘 다 있으면 `claudeSlot.configDir`이 이긴다. 그래서 own 폴더로 옮긴 뒤의 계정 소스 변경은 조용히 무시되지 않고 거절된다(아래 "계정 1의 폴더", 검토 지적 3).
- 대화의 오류가 가리키는 단추와 카드의 단추가 같다. `기존 로그인 가져오기`(`detect`)의 폴더도 계정 1의 지금 폴더다.

**빼기(`계정 빼기…`)**
- `plugin.claudeAuth.accounts.remove.plan{accountID}` → `{nonce, boundSessions, deleteFolder:{offered, default}}`. 그 계정에 묶인 트리·대화를 보여 준다. 그 대화들은 기본 계정으로 옮겨진다(빼는 계정이 기본이면 기본은 계정 1로).
- `로그인 폴더도 지우기`는 own이 만든 폴더일 때만 보이고 처음 값이 켜짐이다. `%USERPROFILE%\.claude`에는 절대 보이지 않는다. 계정 1(`acc_claude_slot`)은 빼지 않는다(플러그인은 앱과 함께 있고 제거하지 않는다, 8.2 9번).
- `remove.execute{nonce, deleteFolder}` → `{movedSessions, folderDeleted}`.
- 라벨·색 바꾸기는 `accounts.update{accountID, label?, shortLabel?, color?}`를 그대로 쓴다(계정 1은 `claudeSlot`, 나머지는 `claudeAccounts`에 적음).

**계정 1의 폴더(계정 소스 변경)**
- 패치 전에는 이 RPC로만 계정을 바꿀 수 있었다. 플러그인이 늘 패치된 채로 앱에 들어 있으므로(2026-10-18) `계정 소스 변경…` 메뉴는 없다(다른 폴더는 계정으로 더한다). RPC와 계약은 그대로 남는다.
- **계정 소스 변경 RPC**(01 §9.4): `plugin.claudeAuth.changeSource.plan{configDir}` → `changeSource.execute{nonce}`
  - `plan`은 다음을 돌려준다: 실행 중인 세션(`GET /api/session/active`와 같은 정보), 새 경로에 `.credentials.json`이 있는지, 서비스 재시작이 필요하다는 경고.
  - 실행 중인 세션이 있으면 `execute`는 `session_busy`로 거부한다. 사용자가 턴을 끝내거나 중단한 뒤 다시 시도한다.
  - own의 로그인 폴더(`<OWN_HOME>\claude-accounts` 아래, 경로나 realpath로)는 계정 소스가 될 수 없다. `plan`은 `leaveOwnLogin`이 있어도 `setting_out_of_range{field:"configDir"}`로 거절하고, 계획 뒤 그렇게 된 폴더(정션)는 `execute`가 `nonce_invalid`로 거절한다(CS 재검토 h: 소스는 launcher가 Claude Code의 `CLAUDE_CONFIG_DIR`로 넘기므로 그 폴더가 읽기 전용이 되어 다음 만료에 멈췄다).
  - 계정 1이 own 폴더(`claudeSlot.configDir`, `own 전용 로그인으로 바꾸기`)에 있으면 `plan`과 `execute`가 `claude_account_unavailable{reason:"own_login"}`으로 거절한다(CS, 검토 지적 3: 전에는 파일만 쓰고 무시됐다). Claude Code가 쓰는 폴더(읽기 전용)로 되돌아가기는 `plan{configDir, leaveOwnLogin: true}`로 **명시할 때만** 된다. 그러면 `execute`가 파일을 쓰고(또는 지우고) `claudeSlot.configDir`을 지운다. 라벨·색·바인딩은 그대로이고, 아무도 이름 대지 않게 된 own 폴더는 정리(sweep)가 지운다.
  - **지금 launcher로는 env를 넘길 길이 없다**(소스 확인). launcher는 서비스를 띄우기 전에 `CLAUDE_*`를 모두 지우고(`own/launcher/own.ps1:65,128-143`), 서비스 env 맵(`service-own.json`의 `env`)을 시작할 때마다 고정 목록으로 다시 쓴다(`Get-BridgeEnv`/`Write-EnvBridge`, `own.ps1:158-191`. `cors` 외의 알 수 없는 키는 보존하지 않음). `configDir`을 받는 launcher 명령도 없고(`open|start|stop|restart|status|url|pair|env|config|tui|run|version`), 05의 `OwnHost.service.restart`도 `{force}`만 받는다(05 §5.6·§6.2).
  - **그래서 경로를 이렇게 정한다(계약)**
    1. `execute`가 돌려주기 **전에** 고른 디렉터리를 `OWN_HOME\claude-auth.json` `{configDir, setAt}`에 쓴다(2.3, temp→fsync→rename). 경로는 비밀이 아니다. `configDir:null`로 부르면 파일을 지워 기본값(`%USERPROFILE%\.claude`)으로 돌아간다.
    2. launcher `Get-BridgeEnv`는 이 파일이 있으면 `CLAUDE_CONFIG_DIR = configDir`를 env 맵에 넣는다. I8의 유일한 `CLAUDE_*` 예외다. 경로가 절대 경로가 아니거나 없으면 넣지 않고 경고만 출력한다.
    3. `execute`의 출력은 `{clientAction:{type:"restart-service"}}`이고 **인자가 없다.** 데스크톱은 `host.service.restart({force:false})`(05 §5.6, `own.cmd restart`)를, 웹 폴백과 모바일은 `PowerShell에서 own restart를 실행하세요` 안내와 명령 복사를 보인다(9.1). 재접속 뒤 own-web이 `importSubscription`을 다시 부른다.
  - 이 계약에는 launcher 변경이 필요하다(01 §5.3·05 §5.7 쪽 일, 12장 Q16). launcher가 이 파일을 읽게 되기 전에는 03이 "계정 소스 변경" 메뉴를 숨긴다. 파일을 써도 재시작 뒤 적용되지 않기 때문이다.
  - 대안(채택하지 않음): `own restart --claude-config-dir <dir>`와 `OwnHost.service.restart({force, claudeConfigDir})`. 재시작할 때마다 인자를 다시 넘겨야 하고, 셸 없이 `own start`로 띄우면 값이 사라진다. 파일 방식은 어떤 시작 경로에서도 같은 값을 쓴다.
  - 03의 Claude 계정 `⋯` 메뉴에 "계정 소스 변경"과 재시작 경고가 있어야 한다(12장 Q13).
- UI 문구
  - 요약 `Claude 구독 계정: {n}개`, 스위처 `Claude · {label}`(계정 1은 그 라벨 그대로)
  - `Claude 계정 추가`, `PC에 열린 창에서 Claude Code 로그인이 시작됩니다. 브라우저에서 로그인만 마치세요. 앱은 비밀번호나 토큰을 보지 않습니다.`, `로그인 기다리는 중… (창을 닫으면 취소됩니다)`, `추가했습니다: {plan} · {masked email}`, `이미 추가된 계정입니다.`
  - `이 PC의 기존 Claude Code 로그인 가져오기`, `찾은 로그인: {email} ({folder})`
  - `Claude Code가 설치되어 있지 않습니다. PowerShell에서 직접 설치한 뒤 다시 누르세요: irm https://claude.ai/install.ps1 | iex (또는 npm install -g @anthropic-ai/claude-code)`
  - `로그인 추가는 이 PC의 창에서만 할 수 있습니다.`(원격·모바일)
  - 카드: 계정마다 하나(비공식 배지, 한도 막대, `⋯` 라벨 바꾸기 / 색 바꾸기 / 새 대화의 기본으로 / 다시 로그인 / 계정 빼기…)
  - `이 계정의 로그인이 없거나 만료됐어요 — [다시 로그인]을 누르세요.`, `다시 로그인: {account}`, `다시 로그인했어요: {label}`
  - 갱신 줄(CR, own이 갱신하는 계정의 카드, 문구는 own-web `accounts/claude-refresh-strings.ts`): `로그인을 새로 고치지 못했어요({reason}) · 다시 로그인하세요.`와 `다시 로그인`, `로그인 새로 고침이 잠시 막혔어요({reason}) · 다음 요청에서 다시 해요`, `로그인 토큰이 만료됐어요 · 다음 요청에서 새로 고쳐요`. `{reason}`은 `HTTP 429 rate_limit_error`처럼 상태와 오류 코드, 또는 `연결 실패`·`시간 초과`·`응답을 읽지 못함`·`새로 고침 토큰 없음`
  - 계정이 Claude Code의 폴더일 때(CS, `claude.shared`인 모든 카드, 문구는 own-web `accounts/claude-shared-strings.ts`): `Claude Code가 쉬고 있으면 몇 시간마다 멈춰요 · own 전용 로그인으로 바꾸면 own이 직접 갱신해요`, 만료되면 `{account}(은)는 Claude Code와 같은 로그인을 쓰는데, 그 로그인이 만료돼 멈췄어요. Claude Code에서 요청을 한 번 보내면 Claude Code가 새로 고쳐서 다시 돼요. 멈추지 않게 하려면 own 전용 로그인으로 바꾸세요. Claude Code도 로그아웃됐다면 Claude Code에서 /login을 하세요.`, 전환기와 한도 패널 `Claude Code에서 요청을 한 번 보내거나 own 전용 로그인으로 바꿔요`, 창 본문 `{account}(은)는 Claude Code의 로그인({folder})을 함께 써서 이 앱이 새로 고치지 않아요. 이 앱 전용 폴더에 같은 Claude 계정으로 따로 로그인하면 이 앱이 새로 고쳐요. 이름, 색, 대화, 기록은 그대로예요. Claude Code의 로그인은 건드리지 않아요.`, 단추 `own 전용 로그인으로 바꾸기`, 창 제목 `own 전용 로그인으로 바꾸기: {account}`, 끝 `own 전용 로그인으로 바꿨어요: {label}`, 다른 Claude 계정이면 `다른 Claude 계정으로 로그인했어요 · 같은 계정으로 다시 로그인하거나 계정을 새로 추가하세요`와 `새 계정으로 추가`. 창의 문구는 계획(`plan.move`)이 오면 그것만 따른다(검토 지적 6). 이전의 `Claude Code와 토큰 공유 — 동시 사용 시 재로그인 필요할 수 있음`을 바꿨다.

### 8.8 긴 멈춤 방지

- **문제**: 플러그인은 429를 최대 3회 자체 재시도한다. 그 뒤 core가 최대 10회, 1회당 retry-after 15분 상한으로 다시 시도한다(`retry.ts:30-37,68-74`). 그래서 5h 창 거부 하나로 약 2.5시간 멈출 수 있다.
- **대응**: own-telemetry의 `retry` hook(`{providerID:"anthropic"}` scoped, 4.1)이 마지막 unified status가 `rejected`이거나 retry-after가 15분을 넘는 429이면 `{retry:false}`를 주고 소진 기록을 `own-runtime`에 올린다. 소진은 그 세션의 마지막 요청에 서명한 Claude 계정의 것이다(8.5). 그다음 own-accounts가 5.9(g)의 제안 흐름으로 넘긴다. 다른 회사로의 자동 전환은 하지 않는다(5.10). 원격 호스트에서도 own-telemetry가 같은 hook을 돌린다(04 §4.1, §8.11.8).
- **Claude 계정끼리의 자동 전환(2026-10-10, 사용자 결정 C-D3, 가드 G8)**: 이 PC에 Claude 계정이 여럿이면, 막힌 계정을 기다리지 않고 다른 Claude 계정으로 그 대화를 옮겨 바로 다시 보낸다.
  - 정책 `policy.autoSwitch.claudeToClaude`(`auto`, `off`. `ask`는 없음: 출력 전에 바꾸는 일이라 기다릴 수 없음). 설정 > 전환 정책의 `Claude 계정 사이` 줄(`자동`/`끄기`)에서 바꾼다. `off`면 아래를 하지 않고 위의 대응만 한다.
  - 기본값(사용자 결정 2026-10-31, CAG-5, C-D3 기본값 철회): 새로 설치하면 기본은 `off`이고, 값이 없을 때의 대체값도 `off`다(`ClaudeAccounts.onRetry`, `PolicyRules.apply`, 설정 화면이 같은 값을 쓴다). 이미 있는 `policy.json`에 `auto`가 저장돼 있으면 리더가 이 판으로 처음 시작할 때 한 번 `off`로 바꾼다(CAG-15, `PolicyRules.migrate`). 35d1a54409(2026-10-11)부터 모든 `policy.set`이 `auto`를 적었기 때문에, 사용자가 고르지 않았어도 설치본마다 `auto`였다. 바꿀 때 `policy.json`에 표시 `migrated.claudeToClaudeOff{changed: true, at}`를 남기고, 앱은 처음 정책을 읽은 창에서 `Claude 계정 사이 자동 전환을 껐어요. … 다시 켜려면 설정 > 전환 정책 > Claude 계정 사이에서 '자동'을 고르세요.`를 한 번 띄운 뒤 `policy.set{noticed: "claudeToClaudeOff"}`로 표시한다. 그 뒤에 사용자가 고른 값은 그대로다: `policy.set`이 `claudeToClaude`를 처음 이름 대면 표시 `{changed: false}`를 남겨 바꾸기가 다시 돌지 않는다. 이유는 Anthropic 이용 정책의 '한도를 피하려는 여러 계정'으로 읽힐 수 있어서다(own/reports/claude-agent-provider-2026-10-31.md §10.3, §15). API 키와 다른 회사 계정의 자동 전환은 그대로다. 다른 회사 → Claude(`toClaudeSlot`)는 그대로 `off`이고, Claude → 다른 회사는 그대로 제안이다.
  - 계기: own-accounts의 `retry` hook(own-telemetry보다 앞)이 그 세션의 `lastResponse`(같은 실패 응답)를 본다. unified 5h·7d·모델별 주간 묶음·전체 status가 `rejected`이거나(`Unified.rejected`, 소진 기록과 같은 읽기, 5.2), 429의 retry-after가 플러그인의 자체 재시도 상한(30초, `CA/http.js:46-52`)을 넘으면(한도 재설정이지 순간 폭주가 아님) 소진으로 본다. 계기는 거절한 창을 이름으로 갖는다(`claude.switch`의 `windowId`). 계정 하나로 도는 플러그인에서는 하지 않는다.
  - 대상: 막힌 계정이 아니고, 플러그인이 로그인을 가진 계정(`ownAccounts()`. 원격 서비스는 미러의 `usable: true`인 계정만, 04 §8.11.18), 지금 소진이 아니며(소진 기록·`exhausted` 창), 이 트리가 떠난 뒤 그 계정의 재설정 시각이 지난 계정 가운데 5시간 사용률이 가장 낮은 것(5시간 창이 없는 계정은 그 자리에 주간 사용률, 7.1.2. 모르는 값은 맨 뒤, 같으면 주간 사용률). 없으면 옮기지 않는다. 소진 기록과 `exhausted` 창은 거절된 요청의 모델을 막는 것만 센다(LV 2026-10-24, `LimitRank.blocks`): 모델별 주간 묶음(7.3)은 그 모델 묶음만 막으므로, Fable 주간이 다 찬 계정도 Sonnet 대화의 대상이 된다(5시간 10%·주간 20%·Fable 102% 거절인 계정과 5시간 90%·주간 95%인 계정이면 Sonnet 대화는 앞의 것으로, Fable 대화는 뒤의 것으로 간다). Opus 주간 기록만 있는 계정도 Sonnet 대화의 대상이다. 추가 사용량(`claude.overage`)이 거절이거나 다 찼다는 것만으로는 대상에서 빠지지 않는다(7.3).
  - 실행: 트리 전체(팀이면 팀 전체, R4)를 그 계정으로 다시 묶고(`claude:session:<root>` 또는 `claude:team:<teamID>`), `{retry:true, delay:0}`로 출력 전에 곧바로 다시 보낸다(`retry:speed`와 같은 방식). own-runtime에 전환 표시를 남겨 뒤에 도는 own-telemetry가 소진은 옛 계정에 기록하되 재시도 결정은 그대로 둔다. 이때 `exhausted` 방송에는 `sessionID`를 넣지 않는다(대화는 이미 다른 계정에서 돌므로 전환 계획기가 Claude 밖으로 옮기려 하지 않게). 전환 계획기도 그 세션의 지금 Claude 계정이 아닌 계정의 소진은 무시한다.
  - 트리마다 한 번(2026-10-11): 결정은 트리(팀)마다 하나씩 차례로 한다. 같이 거절된 형제 세션은 트리가 이미 다른 계정으로 옮겨졌으면 다시 옮기지 않고 그 계정으로 곧바로 다시 보낸다(차단기·알림·ledger에 세지 않음). 같은 거절(같은 `lastResponse`)을 두 번 쓰지 않으므로, 새 계정에서 응답 전에 실패한 재시도는 다시 전환하지 않는다.
  - 사용 가능 판정은 계정마다다(2026-10-11): 전환 계획기·관문의 `anthropic` 판정은 그 세션 트리의 Claude 계정의 소진을 보고, 세션이 없는 판정(새 대화, 프리셋 해석)은 Claude 계정 중 하나라도 쓸 수 있으면 쓸 수 있다. 전환이 남기는 ledger 줄의 `accountID`도 그 트리의 Claude 계정이다.
  - 차가운 캐시를 줄이는 규칙: 트리마다 한 시간에 `hysteresis.breakerAutoPerHour`(기본 2)번까지만 저절로 옮긴다(차단기). 떠난 계정으로는 거절된 창의 `resetAt`(모르면 1시간) 전에 돌아가지 않는다. 그 창이 모델별 주간 묶음(`주간 · Opus`, `주간 · Fable`, `주간 · Sonnet`)이면 그 모델 묶음으로만 돌아가지 않는다(LV 2026-10-25, `ClaudeSwitch.depart`/`returns`): Opus 트리가 Opus 주간이 찬 계정 1에서 계정 2로 옮긴 뒤 Sonnet으로 이어 가다 계정 2의 5시간에 막히면 계정 1로 돌아간다. 전에는 떠난 기록이 모델을 몰라 그 트리가 5일 동안 어느 모델로도 계정 1에 가지 않았다. Opus로는 그 주간이 풀릴 때까지 여전히 돌아가지 않는다. 계정 전체 창(5시간, 주간, 전체 status, 긴 retry-after)의 거절은 전처럼 모든 모델에 걸린다. 다만 옮기는 것은 트리 전체이고 모델은 세션마다 다를 수 있다(메인 Opus, 하위 에이전트 Sonnet). 그래서 갈 계정은 거절된 요청의 모델만이 아니라 트리의 메인이 지금 쓰는 모델(루트의, 팀이면 팀 루트들의 `model.selected`, `ClaudeSwitch.choose`의 `kept`)에도 열려 있어야 한다(LV 2026-10-25): 창, 소진 기록, 떠난 기록 어느 것으로든 그 모델이 막힌 계정은 고르지 않는다. 그 가드가 없으면 Sonnet 하위 에이전트의 거절이 Opus 메인까지 Opus 주간이 찬 계정 1로 데려가서, 메인은 다음 요청에서 그 주간에 막히고 그 리셋(며칠)까지 기다렸다. 이제는 갈 곳이 없으면 트리가 계정 2에 남고 하위 에이전트도 계정 2의 5시간 리셋을 기다린다. 메인이 Sonnet으로 바꾸면 계정 1로 돌아간다. 미리 옮기는 전환(능동 전환)은 하지 않는다. 소진으로 막혔을 때만 옮긴다.
  - 기록과 알림: events ledger `claude.switch{from, to, reason, windowId, auto:true}`, 경보 `claude_account_switched`(세션, info), 토스트 `Claude 한도 소진 — {from}에서 {to}로 바꿨습니다 (캐시 새로 쌓임)`. 옮긴 대화마다 `binding.changed`가 나간다.

### 8.9 과금 경로 표시

- 슬롯의 active connection이 무엇인지 보여 준다: `oauth(claude-code)`, `key`, `env`(`integration.ts:358-372`).
- OAuth를 지운 상태에서 `ANTHROPIC_API_KEY`가 있으면 슬롯이 조용히 API 과금으로 바뀐다. 이때 경보 `claude_slot_billing`을 낸다.
- 고정 배지: **"비공식/서드파티 플러그인 — 약관 위험"**

**추가 사용량 경고와 확인(2026-10-19, 사용자 결정 CW "경고 보이고 확인하기")**

플러그인은 그대로 늘 켜 둔다(CB). 대신 Claude 카드마다 경고를 늘 보이고, 응답이 알려 주는 청구 판정을 보이고, 사용자가 claude.ai에서 확인하는 방법을 준다. 동의를 받거나 요청을 막지는 않는다.

- **배경**(2026-10-19 확인, 실제 요청 없이 공개 정보와 코드만)
  - 2026-01-09: Anthropic이 Claude Code 밖에서 쓰는 구독 OAuth를 서버에서 막기 시작했다. 거절은 400 `invalid_request_error` `This credential is only authorized for use with Claude Code and cannot be used for other API requests.`다(사용자 보고: Roo-Code #10566, anomalyco/opencode #7456).
  - 2026-02 중순: Claude Code 법률 문서가 구독 OAuth를 Claude Code와 claude.ai 전용으로 정했다(8.1 약관 배경).
  - 2026-04-04 12시(PT): 서드파티 도구·하네스로 쓴 구독 사용은 구독 한도가 아니라 추가 사용량(종량제, 지금 이름 usage credits)으로 청구한다(TechRadar, GIGAZINE 2026-04-05, Implicator.ai).
  - 반대 신호: Anthropic 도움말 "Use the Claude Agent SDK with your Claude plan"(support.claude.com/en/articles/15036540)은 2026-06-15에 "Agent SDK, `claude -p`, 서드파티 앱 사용은 여전히 구독 한도에서 나간다", 2026-10-07에 "구독 한도로도 쓸 수 있다"고 썼다. 그러나 2026-10-07에도 서드파티 프록시의 요청이 아래 400으로 거절됐다(router-for-me/CLIProxyAPI #6432). 직접 OAuth를 쓰는 하네스는 여전히 서드파티로 분류되는 것으로 보인다(추정). 그래서 own은 "청구될 수 있다"고만 말한다.
  - 이 앱의 플러그인은 요청을 Claude Code처럼 꾸민다(`x-anthropic-billing-header`의 `cc_entrypoint` 기본 `sdk-cli`, User-Agent `claude-cli/<ver> (external, sdk-cli)`). 서버가 요청을 어떻게 나누는지는 공개되지 않았다.
- **own이 볼 수 있는 것**. Anthropic은 아래 헤더와 오류를 문서로 밝히지 않는다. 이름과 값은 Claude Code 소스(2026-03-31 공개 `src/services/claudeAiLimits.ts`), 이 PC의 Claude Code 2.1.288 바이너리, 사용자 보고에서 왔다.

  | 신호 | 근거 | 판정 |
  |---|---|---|
  | `…-unified-status: rejected`이고 `…-overage-status: allowed` 또는 `allowed_warning` | Claude Code `isUsingOverage`. Claude Code는 이때 추가 사용량으로 넘어갔다고 알린다 | `extra_usage` |
  | `…-overage-in-use: true` | Claude Code 2.1.288이 읽는다. 실제 응답에서 봤다는 보고는 엇갈린다(weave-os/router PR #1569는 봤다, sonichi/sutando PR #5286은 약 21만 표본에 없었다) | `extra_usage` |
  | `status: rejected`이고 `overage-status: rejected`. 이유는 `…-overage-disabled-reason`(`overage_not_provisioned`, `org_level_disabled`, `out_of_credits`, `org_spend_cap_reached`, `member_level_disabled` 등) | Claude Code의 enum. CLIProxyAPI #5920(429 `rate_limit_error` `This request would exceed your account's monthly spend limit.`, `org_spend_cap_reached`) | `rejected` |
  | 400 `invalid_request_error` `Third-party apps now draw from your extra usage, not your plan limits. …`. 팀은 `Third-party apps now draw from extra usage, not plan limits. Ask your workspace admin …` | anthropics/claude-code #45134(2026-04-08), CLIProxyAPI #6432(2026-10-07), NousResearch/hermes-agent #48176. 토큰 사용 0(openclaw #65399) | `rejected`, 경보 `claude_extra_usage` |
  | 400 `invalid_request_error` `You're out of extra usage. Add more at claude.ai/settings/usage and keep going.` | claude-code #45134, openclaw #65399. 추가 사용량이 꺼져 있을 때도 온다(openclaw #86761, `org_level_disabled`) | `rejected`, 경보 |
  | 429 `credits_required` `Usage credits are required for this model` | CLIProxyAPI #5920(`org_level_disabled`) | `rejected`, 경보 |
  | 그 밖의 응답 | 요청 하나가 구독 한도로 계산됐는지 추가 사용량으로 청구됐는지 알려 주는 표시는 공개된 것이 없다 | 알 수 없음 |

  - 판정 위치: `Unified.parse`가 `claude.overage` 창에 `meta.billing`과 `meta.disabledReason`을 둔다(7.3). 오류 본문은 own-telemetry가 `ExtraUsage.detect`로 보고 `Unified.refused`로 그 창을 `rejected`로 둔다. 응답에 overage 헤더가 없으면 창을 만든다(`status:"exhausted"`, `source:"error"`). 그 계정의 다음 성공 응답은 overage 헤더가 없어도 `rejected`와 그 거절의 상태를 지운다(상태 `unknown`: 요청이 다시 지나가니 거절은 끝났고, 추가 사용량이 지금 어떤지는 다음 응답이 말할 때까지 모른다, LV 2026-10-24). 다만 그 판정이 덮던 요금제 창(다 찬 `rolling_quota` 창)이 있으면, 그 창이 막는 모델의 성공만 지운다(LV 2026-10-25): #5920처럼 Fable 주간만 찼으면 Sonnet 답은 요금제로 지나간 것이라 Fable 대화의 `추가 사용량 거절됨`은 남고, Fable 답이 오면 지운다. 덮던 창이 없으면(본문만의 거절, CW의 `credits_required`) 어느 성공이든 지운다. PC egress 중계(04 §8.11.10)도 같은 파서로 헤더 판정을 얻는다. 원격 요청의 본문 판정은 호스트의 own-telemetry가 호스트 쪽에서 한다.
  - 플러그인(0.4.0-beta.5)은 unified 헤더를 읽지 않는다. 원래는 `You're out of extra usage`를 긴 문맥 오류로 잘못 알아(`dist/betas.js` `isLongContextError`) `context-1m-2025-08-07`·`interleaved-thinking-2025-05-14` beta를 빼고 두 번까지 다시 보내고(`provider.js`), 그 뒤 그 모델에서 그 beta를 계속 뺐다. 이 거절 하나에 요청이 셋까지 가고 interleaved thinking이 조용히 꺼졌다. 2026-10-19 패치(8.2 3번 "추가 사용량 거절")로 거절은 다시 보내지 않고 beta를 건드리지 않는다.
  - core의 재시도: own-telemetry의 `retry` hook은 마지막 오류 본문이 거절이면(`ExtraUsage.detect`) `{retry:false}`를 준다(429 `credits_required`는 core가 다시 보낼 수 있는 오류다). 소진으로 기록하지 않는다. own-accounts가 이미 다른 Claude 계정으로 옮겨 곧바로 다시 보내는 경우(8.8)는 그대로 둔다.
- **카드**(03 §5.4.1(d), 슬롯 카드와 더한 계정의 카드 모두)
  - 늘 보이는 한 줄(닫을 수 없음): `Anthropic 정책(2026-04-04)으로 Claude Code 밖에서 쓰는 구독 사용은 구독 한도가 아니라 추가 사용량(종량제)으로 청구될 수 있어요. claude.ai › 설정 › 사용량에서 확인하세요.`
  - 판정 줄: `extra_usage`면 `이 계정은 지금 추가 사용량으로 청구되고 있어요`(주의색), `rejected`면 `추가 사용량이 꺼져 있어 거절됐어요 · claude.ai에서 켜거나 API 키를 쓰세요`(위험색). 뒤에 `{n분 전} 응답 기준`. 판정이 없으면 줄이 없다. 다 써서 거절된 경우(`out_of_credits`, 지출 상한)도 같은 줄이다.
  - `자세히`(접힘): 날짜 넷(2026-01-09, 2026-02-19 무렵, 2026-04-04 12시 PT, 2026-06-15·2026-10-07 도움말), 이 앱이 알 수 있는 것과 없는 것(위 표의 마지막 줄), 확인 순서, `claude.ai 사용량 열기`(`https://claude.ai/settings/usage`), 출처(Anthropic 도움말 둘, Claude Code 법률 문서, 기사 셋, claude-code #45134).
- **확인 순서**(매뉴얼 20장): 그 계정으로 짧은 메시지를 하나 보낸다 → claude.ai › 설정 › 사용량(Settings › Usage)의 `Usage credits`(예전 이름 Extra usage) 칸, 또는 결제(Billing)를 본다 → 방금 쓴 만큼 금액이 늘었으면 추가 사용량으로 청구된 것이고, 구독 사용량만 늘었으면 구독 한도로 계산된 것이다. Anthropic은 credits가 쓰이기 시작하면 claude.ai에 "Now using credits."를 띄운다(support.claude.com/en/articles/12429409).
- **첫 요청 알림**
  - 이 서비스가 그 계정으로 처음 **보낸** 요청의 답이 오면(own-accounts의 `http.response` hook. 서명한 계정은 플러그인의 `accountOf(request)`, 원격 서비스는 중계 증명의 계정, 계정 하나로 도는 플러그인은 계정 1) KV `claude:firstRequest:<accountID>`가 없을 때 그 KV `{at, sessionID}`를 쓰고 세션 경보 `claude_first_request`(warning, 세션 = 트리의 루트, `accountID`)를 낸다. 2026-10-26(CR) 전에는 `http.request` hook이 서명할 계정을 정한 때 냈다. 그 뒤 플러그인이 로그인을 새로 고치지 못해 거절하면 아무것도 보내지 않았는데도 알림이 뜨고 기록이 남았다(AC-02·AC-03). 계정마다, 서비스마다 한 번이다(원격 서비스는 자기 KV에). 앱을 업데이트한 뒤에는 이미 쓰던 계정도 다음 요청에 한 번 뜬다.
  - **요청을 붙잡지 않는다.** 사용자 결정은 "경고 보이고 확인하기"이지 동의 요구가 아니다. 그리고 계정의 첫 요청은 입력창 밖(하위 에이전트, 자동 전환 뒤 재시도 8.8, 원격 호스트, 압축·제목)에서도 나가므로 입력창에서 막아도 다 막지 못한다. 막는 판은 보내기 경로마다 대기와 취소가 필요해 깔끔하지 않다.
  - 거절된 요청(8.3 I9의 실패하면 닫힘, 플러그인이 서명하지 못한 요청)은 첫 요청으로 세지 않는다. KV를 읽거나 쓰지 못하면 로그 `claude_first_request_failed`만 남기고, 요청은 그대로 가며, 그 계정의 다음 요청에서 다시 한다.
  - 입력창(03 §5.4.1(d)): 그 대화의 경보가 오면 칩 줄 `이 계정의 첫 Claude 요청이에요 · 추가 사용량으로 청구될 수 있어요 · [계속] [취소]`. `계속`은 닫고, `취소`는 그 턴을 멈춘다(`session.interrupt`, 턴이 도는 동안만 보임). 닫은 것은 그 페이지만 기억한다.

---

### 8.10 Claude Agent 경로(사용자 결정 CAG 2026-10-31, 0·1·2·3단계)

Claude 구독을 쓰는 두 번째 길이다(SSH 원격 호스트에서도 된다, 8.10.13). upstream v2.2.3의 core 내장 프로바이더 `claude-agent`(`packages/core/src/plugin/provider/claude-agent/`, 이 절에서 `CA/`)가 Agent SDK로 사용자의 수정하지 않은 `claude` 바이너리를 띄우고, 사용자는 그 Claude Code에 `claude auth login`으로 직접 로그인한다. 근거와 실측은 `own/reports/claude-agent-provider-2026-10-31.md`(이 절에서 "보고서")다. 이 절은 0단계(병합 위생), 1단계(계정 하나), 2단계(여러 계정, 손 전환, 8.10.10), 3단계(원래 형식 기록 8.10.11, 프로세스 풀 8.10.12)를 정한다.

**사용자 결정(2026-10-31)**
- CAG-D1: Claude Agent 경로를 지금 만든다.
- CAG-D2: claude-auth 경로(8.1–8.9)는 그대로 둔다. 두 경로가 나란히 간다.
- CAG-D3: Claude Agent 경로의 계정 전환은 손으로만 한다. 이 경로에는 자동 전환 길을 만들지 않는다.
- CAG-D4: claude-auth의 Claude↔Claude 자동 전환(8.8)도 새로 설치하면 기본이 `off`다(2.4.3, 5.10, CAG-5). 이미 저장된 `auto`는 한 번 `off`로 바꾸고 알린다(CAG-15, 8.8).

#### 8.10.1 성격

| 항목 | 값 |
|---|---|
| kind | `claude-agent`(`Kind.Any`). own slot이 아니므로 `Kind.Own`·`Kind.meta`에는 없다 |
| providerID | upstream 내장 `claude-agent` 하나(R-ID-4의 예외: own이 만든 id가 아니다) |
| 계정 | `accounts.json` `claudeAgents[]`(`Registry.ClaudeAgentAccount`: `accountID`, `configDir`, `label`, `shortLabel`, `color`, `email?`(가린 값), `accountUuid?`, `addedAt`). 2단계부터 여럿이다. 새 대화의 기본은 `claudeAgentDefault`(없으면 첫 계정)다 |
| 로그인 폴더 | `<OWN_HOME>\claude-agent\accounts\<accountID>`(`Layout.claudeAgent`). claude는 이 폴더를 `CLAUDE_CONFIG_DIR`로 받는다 |
| 기록 폴더 | `<OWN_HOME>\claude-agent\projects`. 모든 계정 폴더의 `projects`가 여기로 가는 junction이다(8.10.10) |
| 회사(R4) | `anthropic`(`Preset.company`). 구독(`billing: subscription`) |
| 프리셋 묶음 | `claude-agent`(자기 묶음. 모델은 Claude Code의 별칭 `opus`·`sonnet`·`haiku` 등) |
| 기본 에이전트 방식 | `claude-code`(10 §3.13) |
| 이름 | 화면에서는 "Claude Agent"다. Agent SDK 브랜딩 규칙에 따라 own의 기능 이름에 "Claude Code"를 쓰지 않는다 |

- own은 토큰을 읽거나 저장하지 않는다. 로그인 여부는 `<폴더>\.credentials.json`이 있는지만 보고(열지 않음), 표시용으로 `.claude.json`의 `oauthAccount.emailAddress`·`accountUuid`만 읽는다(8.7과 같은 규칙).
- 원격(SSH) 호스트의 대화에서도 쓴다(2026-11-03, 8.10.13): claude는 이 PC에서 돌고 호스트의 프로바이더가 own의 브로커로 그것을 몬다. 호스트에는 계정 폴더도 토큰도 없다.

#### 8.10.2 0단계: 경로 하나만, 갱신자 하나만

upstream 프로바이더를 그대로 두면 own 안에서 혼자 나타나고 돈다. 연결은 upstream의 `/connect`(external 방법 `claude-login`)로도 만들 수 있고, claude는 서비스의 env 전체를 물려받아 서비스의 `CLAUDE_CONFIG_DIR`(런처가 claude-auth 계정 1의 폴더로 둠, 없으면 사용자의 `~\.claude`)에서 로그인을 쓰고 토큰을 갱신한다(보고서 5.1). 그래서 다음을 지킨다.

1. **코어 P-045**(처음 번호 P-038. merge-round8이 그 번호를 먼저 써서 바꿨다): 실제 claude는 provider 설정이나 요청의 provider 옵션이 계정 폴더(`configDir` → `CLAUDE_CONFIG_DIR`)를 줄 때만 뜬다. 폴더가 없으면 옵션을 만들 때 실패하고, 상태 확인(probe)은 claude를 띄우지 않고 `failed`가 된다. SDK의 기록 확인·fork·삭제도 폴더 없이는 서비스의 `CLAUDE_CONFIG_DIR`을 보지 않고 실패한다(닫힘). 그래서 다른 길로 연결을 만들어도 아무 폴더의 토큰도 갱신하지 않는다.
2. **코어 P-042**: claude는 서비스 env의 허용 목록만 받는다(8.10.6).
3. **own-accounts의 provider fold**(`ClaudeAgent.fold`, `own.accounts`의 `provider.transform`): Claude Agent 계정이 있으면 `claude-agent`를 `activation: enabled`, `settings.configDir = 기본 계정의 폴더`로 둔다(상태 확인, 모델 목록, 세션 없는 요청). 대화의 요청은 그 트리 계정의 폴더를 따로 받는다(8.10.10). 계정이 없거나 원격 서비스면 `disabled`이고, 손으로 넣은 `configDir`도 지운다. 그래서 계정을 만들기 전에는 모델 목록에 나오지 않는다.
4. **연결은 own이 만든다**: 계정을 만들면 control Location이 upstream의 external 연결(`claude-login`, 라벨 `own`)을 한 번 만든다. 이것이 프로바이더의 상태 확인과 모델 목록(창 크기 포함)을 깨운다. own-web에는 upstream 연결 화면이 없다.
5. **한 폴더는 한 경로에만**: 이 경로의 폴더는 own이 `Layout.claudeAgent` 아래에 만든 것뿐이다. claude-auth의 출처 바꾸기(`changeSource`)는 이 아래 폴더를 거절한다(`ownLoginFolder`가 `claudeAccounts`와 `claudeAgent` 두 뿌리를 본다). claude-auth의 계정 추가는 `claude-accounts` 아래에 새 폴더를 만든다. 같은 Claude 계정을 두 경로에서 쓰려면 폴더 둘에 각각 로그인한다(갱신 토큰이 따로 생긴다).

#### 8.10.3 로그인

- `claudeAgent.setup{add?}`: `add` 없이는 계정이 없을 때만 첫 계정을 만든다(멱등). `add: true`면 계정을 하나 더 만든다(2단계, `created`). 폴더와 그 `projects` junction을 만들고 계정을 등록한다. 이어서 provider fold를 다시 돌리고 연결을 만든다.
- `claudeAgent.login{accountID?}`: 8.7의 로그인 창과 같은 장치(`ClaudeLogin.run`)로 `claude auth login --claudeai`를 이 PC의 콘솔 창에 연다(없으면 기본 계정). env는 코어 P-042의 허용 목록과 같은 목록에 `CLAUDE_CONFIG_DIR`과 그 폴더의 Anthropic 프로필 폴더(`ANTHROPIC_CONFIG_DIR`, 8.10.6)를 더한 것이다(`ClaudeAgent.loginEnvironment`, 시험이 `ClaudeIO.allowed`와 코어가 claude에 주는 값과 같은지 본다). 그래서 `USERNAME`·`USERDOMAIN`·`COMPUTERNAME`·`LOGONSERVER`는 빈 값이고 Claude Code의 업데이터·텔레메트리·오류 보고는 꺼진다. 사용자는 Claude Code가 연 브라우저에서 로그인한다. 창은 10분 뒤 닫는다. Claude Code가 없으면 `claude_account_unavailable{cli_missing}`, 창이 이미 열려 있으면 `{busy}`다. own은 Claude Code를 설치하지 않는다.
- 터미널 대안: `claudeAgent.status`의 계정마다 `commands`를 사용자가 직접 실행해도 된다. 명령 프롬프트(cmd)는 `commands.cmd`(`set "CLAUDE_CONFIG_DIR=<폴더>" && set "ANTHROPIC_CONFIG_DIR=<폴더>\anthropic" && "<claude>" auth login --claudeai`), PowerShell은 `commands.powershell`(`$env:CLAUDE_CONFIG_DIR = '<폴더>'; $env:ANTHROPIC_CONFIG_DIR = '<폴더>\anthropic'; & '<claude>' auth login --claudeai`)이다. 로그인 창과 같은 두 변수다. cmd 문법은 PowerShell에서 실패하므로 화면도 둘을 따로 보인다.
- 시험은 가짜 CLI(Bun 스크립트)만 쓴다. 실제 로그인을 자동으로 하지 않는다.

#### 8.10.4 한도(코어 P-039)

claude가 API를 부르므로 HTTP 훅으로 한도 헤더를 읽을 수 없다. 대신 claude가 스트림으로 주는 것과 사용량 질문을 쓴다.

| 출처 | own 창(`ClaudeAgent.fromRateLimit`·`fromUsage`, `own-protocol`) |
|---|---|
| `rate_limit_event.rate_limit_info`: `rateLimitType`이 이름 붙인 창(`five_hour` → `claude.5h`, `seven_day` → `claude.7d`, `seven_day_overage_included` → `claude.7d_oi`, `seven_day_opus` → `claude.7d_opus`, `seven_day_sonnet` → `claude.7d_sonnet`), `unifiedWindows`의 각 창, 추가 사용량(`claude.overage`, 청구 표시 8.9) | `usedPercent = utilization × 100`, `resetAt = resetsAt × 1000`, `status`: `rejected` → exhausted, `allowed_warning`·`surpassedThreshold` → warning. source `header` |
| 사용량 질문(`usage_EXPERIMENTAL…`, `skipBehaviors`): `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `model_scoped`(Fable·Opus·Sonnet), `seven_day_oauth_apps` → `claude.7d_apps`("주간 · 외부 앱"), 켜진 `extra_usage` → `claude.overage` | `utilization`은 이미 퍼센트다. source `poll`. API 키 로그인(`rate_limits_available: false`)이면 창이 없다. `seven_day`만 있고 `five_hour`가 없는 답은 그 계정의 `claude.5h`를 지운다(7.1.2) |

- 전달: 프로바이더가 등록 심볼 `opencode.claude-agent.observer`의 채널로 관찰(`configDir`, `sessionID`, `rateLimit`·`account`·`usage`)을 내고, own-accounts의 control Location 하나가 듣는다. 관찰의 폴더와 같은 폴더의 계정의 창이 된다(`runtime.limits.upsert` → `limits.updated` → `quota.updated`). `account`는 요금제 쪽(`subscriptionType`, `tokenSource`, `apiKeySource`, `apiProvider`)만 담는다. 로그인의 이메일과 조직은 프로바이더 밖으로 나가지 않는다.
- 사용량 질문은 Location마다의 프로바이더가 모두 받는다(`ClaudeObserver.serve`). 채널의 `usage`는 아직 열린 것 가운데 마지막 것으로 답하고, 마지막 하나가 닫힐 때 사라진다. 그래서 프로젝트 Location이 닫혀도 control Location의 "한도 새로 읽기"는 그대로 된다.
- 막힘: `rejected`인 창은 계정을 exhausted로 적는다(`runtime.limits.exhaust`, 그 창의 리셋까지). `exhausted` 방송에는 세션을 넣지 않는다. 그래서 전환 기계가 스스로 계획하지 않는다(CAG-D3).
- 사용량 질문: `claudeAgent.limits.refresh{accountID?}`(화면의 "한도 새로 읽기")가 프로바이더에 그 계정 폴더의 창을 묻는다. 그 폴더의 살아 있는 claude가 답하고, 없으면 프롬프트를 보내지 않는 짧은 claude가 답한다(모델 호출 없음, claude가 claude.ai 사용량 끝점을 부른다). 그래서 쉬는 계정의 한도도 읽힌다. 자동으로 주기 질문을 하지는 않는다.
- 요금제: 프로세스가 처음 뜰 때 알리는 `account.subscriptionType`과 사용량 답의 `subscription_type`을 계정 보기에 `plan`으로 둔다.

#### 8.10.5 캐시·압축·출력 상한

- 캐시 수명: 구독이면 1시간, API 키면 5분이다(보고서 7장, SDK `promptCacheTtl`). 텔레메트리의 `ttlOf`와 추정기(`Rates.resolve`, `CLAUDE_AGENT_TTL` 3600초)가 이 값을 쓴다. 계정마다 본다: 그 요청을 한 계정(ledger 줄의 `accountID`)의 로그인이 구독인지 API 키인지다(CAG-53. 전에는 기본 계정 하나로 보았다). 그래서 자리 비움 압축(4.7.7)이 이 경로에서도 켜진다. 한도 80% 이상이면 건너뛰는 규칙은 이 계정의 창으로 본다(`overLimit`). 마지막 요청 뒤에 대화가 다른 Claude Agent 계정으로 옮겼으면 건너뛴다(`moved`: 새 계정에는 지킬 캐시가 없다, CAG-53).
- Claude Code 자신의 자동 압축은 꺼져 있다(코어 격리 env `DISABLE_AUTO_COMPACT=1`). 압축은 OpenCode가 한다.
- **압축 기준(CAG-50, 2026-11-03)**: 이 경로는 다른 계정처럼 kind 기본과 계정 설정을 받는다(4.7.4의 1–5단계, `Compaction.chain{kind:"claude-agent"}`). 전에는 claude-sub처럼 V2 기본층만이었는데, 설정 화면이 Claude Agent 계정 줄에 `종류 기본 / 모델 한도 / 직접 정하기`를 보이고 `accounts.update{compaction}`은 그 계정을 찾지 못해 줄마다 `계정을 찾을 수 없어요. 다른 창에서 지웠을 수 있어요`가 났다(사용자 보고 2026-11-03).
  - 저장: kind 기본은 `policy.compaction.byKind["claude-agent"]`(`Compaction.tunable`), 계정 설정은 `accounts.json` `claudeAgents[].compaction`. `accounts.update{accountID, compaction, dryRun?}`은 Claude Agent 계정이면 이 경로의 창(`windows("claude-agent")`)으로 범위를 보고, `compactionImpact`(그 계정에 묶인 대화)를 돌려주고, 저장한다. 같은 호출에 다른 필드가 있으면 `policy_denied{field}`다(이름 바꾸기는 따로 부른다).
  - 창: 프로바이더가 Claude Code에게 받은 모델별 창(`limit.context`, 8.10.14)을 fold가 잡는다. 계정의 `accounts.list` `compaction.effective`는 이 경로의 모델(`opus`·`sonnet`·`haiku`·`fable` 등)마다의 `T_slot`이다. 전에는 `anthropic` 카탈로그의 claude-sub 값을 보였다. 모델과 창은 이 프로세스의 어느 Location이든 마지막 fold가 본 값이다. 프로바이더는 자기 확인이 돈 Location(프로젝트)에만 모델을 올리고, `accounts.list`와 설정에 답하는 control Location에는 하나도 없을 수 있기 때문이다(e2e로 확인).
  - 적용: 코어에는 이 경로의 프로바이더가 하나라 계정마다 다른 `limit.input`을 등록할 수 없다. 그래서 코어는 자기 기준(`ceiling(ctx)`, 85%)을 그대로 두고, own-accounts가 대화마다 그 트리 계정의 `T_slot`(세션 값이 있으면 둘 중 작은 것)을 지킨다. `step.ended`마다 `P ≥ T`이고 `T < ceiling(ctx)`이면 세션 값과 같은 길(`compaction.due`, 서버가 `session.compact`로 넣음, 4.7.4)로 압축을 넣는다(`SessionCompaction.check`의 `ownEnforced`). 이 경로의 상한은 코어 기준이므로 설정은 늘 그보다 이르거나 같다. `cache.state.compaction`, 전환 추정의 `compactAt`, 문맥 막대도 트리 계정의 값이다(`slots.compaction(providerID, modelID, window, sessionID)`).
  - P-034는 필요 없다(fork가 캐시를 이미 다시 쓴다).
- 압축 요청은 원래 대화의 Claude 기록을 계정 폴더 안에서 fork해 캐시를 읽는다(P-045의 폴더 저장소). 압축·문맥 비우기(P-035) 뒤의 다음 요청은 새 Claude 대화다(보고서 7장).
- 출력 상한(4.9): 이 경로에서는 own의 출력 상한 훅이 아무것도 하지 않는다. Claude Code가 자기 출력 예산을 정하고, 값을 주면 바뀔 때마다 claude가 다시 뜨기 때문이다.
- 비용: 구독은 $0이고 단위는 퍼센트(claude-sub와 같음)다. 추정기는 이 경로를 Anthropic 토크나이저로 본다(`ANTHROPIC_KINDS`).

#### 8.10.6 claude의 환경(코어 P-042)

- claude가 받는 env는 허용 목록이다: `SystemRoot`, `PATH`, `TEMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, Program Files 경로들, `OS`, 프로세서, `LANG`·`LC_*`, `TZ`, 프록시와 CA 묶음. 그리고 `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK`, `DISABLE_BUG_COMMAND`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`를 1로 둔다(텔레메트리 점검 TLM, `ClaudeIO.QUIET`). 로그인 창과 설정 > 업데이트의 `claude --version`·`claude update`도 같은 스위치를 받는다(업데이트는 `DISABLE_AUTOUPDATER` 없이). `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`은 두지 않는다: Claude Code 2.1.3xx는 그때 구독의 모델 목록(bootstrap)과 사용량 확인도 건너뛴다.
- 빠지는 것: `CLAUDE_*`(Claude Code 터미널의 `CLAUDE_CODE_USER_EMAIL`, 계정·조직 uuid, 세션 id, 메시징 소켓, 서비스의 `CLAUDE_CONFIG_DIR`), `ANTHROPIC_*`, `OPENCODE_*`(서비스 비밀번호 포함).
- 빈 값으로 넣는 것: `USERNAME`, `USERDOMAIN`, `LOGONSERVER`, `COMPUTERNAME`. Windows의 프로세스 시작(libuv, Node·Bun 모두)은 자식 env에 앞의 셋이 없으면 부모(서비스)의 값을 넣는다(2026-11-01 시험으로 확인). 빈 값이 있으면 넣지 않는다.
- 그 위에 연결 env(계정 폴더, 사용자가 정한 base URL·키)와 upstream의 격리 설정이 얹힌다. SDK의 `env`는 자식 env를 통째로 바꾸므로 다른 것은 새지 않는다. 개발 실행(`bun run dev`, `dev:live`)에서도 같다.
- **Anthropic 프로필 폴더(코어 P-045, 2026-11-10, 결정 CI-1).** Claude Code 2.1.242부터 폴더의 claude.ai 로그인이 없거나 만료되면 PC 전체의 Anthropic 프로필(`ant auth login`이나 키 없는 Console 로그인이 `%APPDATA%\Anthropic`에 남긴 것)로 넘어가 그 Console 조직에 과금한다(2.1.319는 경고만 더했다). `CLAUDE_CONFIG_DIR`은 이것을 막지 못하고 P-042는 `APPDATA`를 넘긴다. 그래서 `ClaudeQueryOptions.base`가 계정 폴더가 있으면 늘 `ANTHROPIC_CONFIG_DIR=<계정 폴더>\anthropic`을 넣는다(연결 env가 준 값도 덮는다). 이 폴더는 만들지 않는다: Claude Code는 이 폴더를 읽기만 하고, 없는 폴더와 빈 폴더는 똑같이 프로필이 없다. 빈 값은 넣지 않는다(Claude Code는 빈 값을 없는 것으로 보고 `%APPDATA%`로 간다). 채팅, 상태 확인(probe), 쉬는 계정의 사용량 읽기, 원격 호스트 대화의 PC 쪽 시작(8.10.13)이 모두 이 함수를 지나고, 로그인 창과 터미널 명령도 같은 값을 쓴다(8.10.3).
- 확인(2026-11-10, 설치된 Claude Code 2.1.319, 로그인 없는 임시 `CLAUDE_CONFIG_DIR`과 임시 `APPDATA`에 가짜 `configs/default.json`·`credentials/default.json`, 네트워크는 막음): 변수 없이 `claude auth status`는 `loggedIn: true`(가짜 프로필)였고, 빈 폴더나 없는 폴더를 가리키면 `loggedIn: false`, 가짜 프로필이 있는 폴더를 가리키면 그 프로필, 빈 값이면 다시 `%APPDATA%`의 프로필이었다. 사용자의 실제 `%APPDATA%\Anthropic`과 `~\.claude`는 보지 않았다.

#### 8.10.7 전환

- 이 경로의 계정 사이 전환은 손으로만 한다(CAG-D3). 2단계의 자세한 규칙은 8.10.10이다.
- 전환 기계(5장)는 이 경로를 대상으로 자동 전환하지 않는다(`mode()`가 `off`). 이 경로에서 나가는 것은 구독의 정책(`subscriptionToApi`·`subscriptionToSubscription`, 둘 다 `ask`/`off`만 가능)을 따른다. 그래서 자동으로 옮기는 일은 없고 제안만 있다. 한도에 막힌 창은 계정을 exhausted로 적되 세션을 이름 대지 않으므로 아무것도 옮기지 않는다.
- claude-auth(`anthropic`)와 Claude Agent(`claude-agent`) 사이의 이동은 provider 전환이다. 같은 Claude 계정이어도 요청 바이트가 달라 캐시는 차갑다.
- R4: 두 경로는 모두 회사 `anthropic`이다. 한 대화 트리나 팀이 claude-auth 계정과 Claude Agent 계정을 함께 쓰면 같은 회사의 다른 구독이므로 R4 위반이다. Claude Agent 계정끼리도 서로 다른 구독이다(8.10.10).

#### 8.10.8 RPC(9.2)

| 메서드 | 범위 | Location | 하는 일 |
|---|---|---|---|
| `claudeAgent.status` | read | control | 계정마다(기본 계정이 먼저) 폴더, 로그인 여부, 가린 이메일, 요금제, `default`, 터미널 명령 `commands{cmd, powershell}`. 찾은 Claude Code 경로(`cli`, 없으면 `null`), 마지막 로그인 창 상태(`login`: `idle`·`waiting`·`logged_in`·`failed`·`timeout`, `loginAccount`) |
| `claudeAgent.setup{add?}` | local | control | 첫 계정, 또는 `add`면 계정 하나 더(`created`). 상태를 돌려준다 |
| `claudeAgent.login{accountID?}` | local | control | 그 계정의 로그인 창을 연다. `account_not_found`, `claude_account_unavailable{cli_missing\|busy}` |
| `claudeAgent.remove{accountID?, deleteFolder}` | local | control | 계정을 빼고 그 계정의 트리·팀을 기본 계정으로 옮긴다(`movedSessions`). 계정이 없어지면 프로바이더를 끈다. `deleteFolder`면 이 경로가 만든 폴더만 지운다(그 안의 Claude Code 로그인도 사라진다. 공유 기록은 남는다) |
| `claudeAgent.limits.refresh{accountID?}` | read | control | 사용량 질문(8.10.4). 창과 요금제를 돌려준다 |
| `claudeAgent.session.get{sessionID}` | read | session | 그 대화 트리(팀이면 팀)의 계정과 바인딩 여부 |
| `claudeAgent.session.set{sessionID, accountID}` | switch | session | 트리(팀이면 팀 전체)를 그 계정으로 손으로 옮기고 그 계정을 기본으로 한다. 각 세션은 다음 턴부터 그 계정이다 |
| `claudeAgent.default.set{accountID}` | switch | control | 새 대화의 기본 계정 |
| `claudeAgent.pool.set{processes?, spares?}` | admin | control | 프로세스 풀의 상한(1–64, 기본 8)과 계정마다의 예비(0–2, 기본 0)를 `accounts.json` `claudeAgentPool`에 두고 프로바이더에 넘긴다. 풀(`live`, `cap`, `over`, `spares`, `waiting`)을 돌려준다(8.10.12) |
| `claudeAgent.folders.list` | read | control | 이 PC의 Claude 로그인 폴더 모두와 경로(`claude-auth`·`claude-agent`), 옮길 수 있는지(`movable`, `reason`) |
| `claudeAgent.folders.assign{accountID, route}` | local | control | 폴더를 다른 경로로 넘긴다(8.10.10 "폴더 나누기"). `account_not_found`, `claude_account_unavailable{slot\|claude_code\|not_managed\|not_patched}`, `session_busy` |

- `claudeAgent.status`는 3단계부터 `pool`(8.10.12)도 돌려준다. 이벤트 `claudeAgent.pool`(전역, leader)이 풀이 바뀔 때마다 같은 모양을 보낸다.
- `session.get`·`session.set`·`default.set`을 뺀 열은 원격 서비스에서 `remote_managed`다(`REMOTE_MANAGED`). 원격의 세 메서드는 호스트 대화의 계정과 호스트의 기본 계정을 다룬다(8.10.13).
- `accounts.list`의 보기: 계정마다 하나, `kind: "claude-agent"`, `providerID: "claude-agent"`, `billing: "subscription"`, `status`(`ready` 로그인됨, `needs_reauth` 로그인 필요, `misconfigured` Claude Code 없음), `thirdParty: false`, `readOnly: true`, `connection {oauth, claude-code}`, `claudeAgent {folder, loggedIn, email?, cli, plan?, checked?, default?, transcripts?}`, `sessions`는 그 계정에 묶인 대화 수다.
- `session.binding`의 `accountID`: `claude-agent`로 도는 대화는 그 트리의 Claude Agent 계정이다(전환기의 `현재` 표시, 계정·한도 탭의 `이 대화`).

#### 8.10.9 열린 항목(다음 단계)

- 3단계(원래 형식 기록 P-043, 프로세스 풀 P-044, 안 쓰는 기록 지우기)는 2026-11-01에 만들었다(8.10.11, 8.10.12).
- ⚠ 원래 형식 기록을 Claude Code 버전이 바뀔 때마다 실제 `claude`로 이어 받아 보는 시험(보고서 14장 6번)은 손으로 돌린다(`own/scripts/claude-agent/live-native.ts`). 버전 2.1.301에서 확인했다.
- ⚠ 구독 로그인에서의 실측(사용량 질문의 창 값, `rate_limit_event` 빈도, `seven_day_oauth_apps`가 이 경로를 막는지)은 하지 않았다. API 키에는 창이 없다. 그래서 실제 구독 한도 이벤트로 제안·막힘을 실측하지 못했고, 가짜 claude의 `rate_limit_event`와 사용량 답으로만 시험했다.

#### 8.10.10 2단계: 여러 계정, 손 전환(2026-11-01)

**폴더와 공유 기록**
- 계정은 저마다 `CLAUDE_CONFIG_DIR` 폴더(`<OWN_HOME>\claude-agent\accounts\<accountID>`)다. 로그인과 토큰은 그 폴더의 Claude Code가 갖는다.
- 모든 계정 폴더의 `projects`는 공유 기록 폴더 `<OWN_HOME>\claude-agent\projects`로 가는 junction이다(`Transcripts.ensure`). 그래서 대화를 다른 계정으로 옮기면 그 폴더에서 뜬 claude가 같은 Claude 대화를 `--resume`으로 이어 받는다(보고서 5.2). 프로바이더의 기록 확인·fork(P-045의 폴더 저장소)도 같은 기록을 본다.
- 만들기와 고치기: 계정을 만들 때, control Location이 시작할 때, 그리고 그 계정으로 가는 **요청마다** 확인한다(lstat와 readlink 한 번).
  - 없음: junction을 만든다.
  - 다른 곳이나 없는 곳을 가리키는 링크: 링크만 지우고(가리키던 폴더는 건드리지 않음) 다시 만든다. 공유 폴더가 없으면 먼저 만든다.
  - 진짜 폴더(링크 전에 Claude Code가 그 폴더에서 돈 경우): 그 안의 대화를 항목마다 공유 폴더로 옮기고 junction을 만든다. 공유 폴더에 이미 있는 이름은 공유 쪽을 두고 이쪽 것은 `projects.kept-<시각>`으로 옮긴다. 그 안의 junction·링크(실제 경로가 놓인 자리와 다른 항목)와 하드 링크가 둘 이상인 파일(다른 곳에도 이름이 있는 파일)은 어느 깊이에 있든 공유 폴더로 옮기지 않고 `projects.kept-<시각>`으로 옮긴다(CAG-34, CAG-44). 잃는 것이 없다.
  - 공유 폴더 자체: OWN_HOME 안의 진짜 폴더여야 한다(CAG-34). 없으면 OWN_HOME 아래로 한 단계씩 만든다. 공유 폴더나 그 위의 OWN_HOME 아래 폴더가 junction·링크이거나, 공유 폴더의 실제 경로가 OWN_HOME의 실제 경로 아래 그 자리가 아니면 고치지 않고 요청을 거절한다(`…가 다른 곳으로 이어진 링크(정션)예요. 대화 기록은 own 폴더 안의 진짜 폴더에만 둬요 — 그 링크를 지운 뒤 다시 시도하세요.`). own은 그 폴더에서 기록을 쓰고 지우기 때문이다. 예컨대 사용자가 공유 폴더를 `~/.claude/projects`로 이어 두면 프로바이더의 정리가 Claude Code 자신의 옛 기록을 지울 수 있었다. OWN_HOME 자체는 링크여도 된다. 이 확인을 지나야만 공유 폴더를 프로바이더에 알려 주고, 그때도 확인한 실제 경로(OWN_HOME의 실제 경로 아래 그 자리)로 알려 준다. 확인이 거절하는 동안에는 알려 주지 않는다(`shared` 없음, CAG-42).
  - 파일이거나 옮기기에 실패: 고치지 못한다. 요청을 보내지 않고 까닭을 말한다(예: `…projects가 폴더가 아니라 파일이에요. 그 파일을 옮기거나 지운 뒤 다시 시도하세요.`, 경보 `claude_account_refused`). 계정 카드에 `대화 기록 연결이 끊겼어요` 줄이 보인다(`transcripts: "broken"`).
- junction을 지워도 공유 기록은 남는다(시험으로 확인: `unlink`·`rm -r`이 junction을 따라가지 않음). 계정 빼기(`deleteFolder`)와 폴더 넘기기는 링크를 먼저 뗀다.

**대화의 계정(바인딩, 07 R4)**
- KV `claude-agent:session:<root>` `{accountID, at}`: 루트 세션 트리가 쓰는 계정이다. 하위 에이전트는 루트의 계정을 쓴다. 팀에 속한 루트(프리셋 바인딩의 `team.teamID`)는 KV `claude-agent:team:<teamID>`가 먼저다. 그래서 트리 하나·팀 하나는 언제나 Claude Agent 계정 하나다(8.7의 Claude 계정과 같은 규칙, `Bindings`).
- 새 트리가 처음 요청할 때 바인딩이 없으면 그때의 기본 계정을 적는다. 팀은 팀 문맥의 `accounts`에 든 Claude Agent 계정, 없으면 이 루트가 이미 쓰던 계정, 없으면 다른 팀원 루트의 계정, 없으면 기본 계정이다. 팀원 루트의 자기 바인딩이 팀 계정과 다르면 팀 계정으로 다시 적는다. 기본이 나중에 바뀌어도 그 대화는 옮겨지지 않는다.
- 없어진 계정에 묶인 트리의 요청은 다른 계정으로 옮기지 않고 거절한다(`이 대화의 Claude Agent 계정을 이 PC에서 쓸 수 없어요 — …`). 계정 빼기가 그 트리를 미리 기본 계정으로 옮긴다.

**요청마다(P-045, 대화마다의 폴더)**
- own-accounts의 `context`·`compaction`·`generate` 훅(`ClaudeAgent.onRequest`)이 `claude-agent` 요청에 그 트리 계정의 폴더를 provider 옵션 `configDir`로 넣는다. 코어의 언어 모델이 이것을 연결 env `CLAUDE_CONFIG_DIR`로 바꾼다(P-045). launch 키가 바뀌므로 다른 계정이면 claude가 다시 떠서 같은 Claude 대화를 이어 받는다. 이 훅은 감싸지 않는다: 바인딩을 읽지 못하거나, 계정이 없어졌거나, 기록 링크를 고치지 못하면 요청이 실패한다(닫힘).
- 세션 없는 요청(제목)은 provider 설정의 기본 계정 폴더다.
- **안전 지점**: 세션은 턴을 시작한 계정을 그 턴이 끝날 때까지 쓴다(`session.execution.succeeded`·`failed`·`interrupted`까지). 그래서 도구 결과를 기다리는 claude(붙잡힌 턴)가 옮기기 때문에 끊기지 않는다. 옮긴 트리의 각 세션은 다음 턴부터 새 계정이다. 같은 트리의 하위 에이전트가 먼저 새 계정으로 시작해 잠깐 두 계정이 함께 쓰일 수 있다.

**손 전환과 제안(CAG-D3)**
- 옮기는 길은 둘이다. 전환기(모델·계정 고르기)에서 다른 Claude Agent 계정의 줄을 고르거나, 계정·한도 탭에서 그 계정 줄의 `이 대화를 여기로 전환`이다. 둘 다 `claudeAgent.session.set`이고 그 계정을 새 대화의 기본으로도 한다. 새 대화에서 고르면 `claudeAgent.default.set`만 부른다.
- 제안: 계정·한도 탭에서 대화의 계정 줄 아래, 그 계정의 창 하나가 85% 이상이거나 막혔으면 여유가 가장 많은 다른 Claude Agent 계정(준비됨, 막힌 창 없음, 5시간 사용률이 낮은 순(5시간 창이 없는 계정은 주간, 7.1.2), 같으면 주간)을 `5시간 87% · CA2는 12%예요`처럼 보이고 `CA2로 옮기기`를 둔다. 단추는 그 계정을 고른 전환기를 열 뿐이다. `자동으로 옮기지 않아요. 옮기면 같은 대화를 이어 가고, 캐시는 새로 쌓여요.`
- 전환 기계, `retry` 훅, 한도의 막힘 어느 것도 이 경로의 계정을 바꾸지 않는다. 시험이 막힌 창 뒤에도 대화가 그 계정에 남는 것을 본다.

**쉬는 계정의 한도**
- 돌고 있지 않은 계정의 창은 `claudeAgent.limits.refresh{accountID}`가 그 계정 폴더의 짧은 claude(프롬프트 없음)로 읽는다(8.10.4). 카드의 `한도 새로 읽기`가 이것이다.

**R4와 팀**
- R4는 이 경로의 계정을 서로 다른 구독으로 본다(`lookup`이 모든 계정을 따로 안다). 대화의 main 계정은 그 트리의 계정이다(`member(providerID, root)`). 그래서 팀 문맥이 다른 Claude Agent 계정을 담거나 프리셋이 다른 Claude Agent 계정을 고정하면 위반이다.
- 팀은 메인과 같은 규칙을 따른다(06 §10.1): 팀 전체가 Claude Agent 계정 하나다. 팀원 대화에서 계정을 옮기면 팀 바인딩이 바뀌어 팀 전체가 옮긴다(각 세션은 다음 턴부터). own-team의 팀 문맥은 `claude-agent` 담당의 계정을 팀의 계정으로 읽는다(`claudeAgent.session.get`).

**폴더 나누기(한 폴더는 한 경로에만)**
- `계정` 화면 Claude Agent 묶음의 `Claude 로그인 폴더 나누기`가 이 PC의 Claude 로그인 폴더를 경로와 함께 보인다(`claudeAgent.folders.list`).
- claude-auth → Claude Agent: own이 만든 claude-auth 폴더만 된다. 계정 1(`slot`), Claude Code가 쓰는 폴더(`claude_code`, 8.7 CS), own이 만들지 않은 폴더(`not_managed`)는 안 되고, 그 계정의 대화가 도는 중이면 `session_busy`다. claude-auth가 먼저 계정을 놓고(`ClaudeAccounts.release`: 그 트리는 claude-auth의 기본 계정으로, 플러그인의 목록에서 빠짐) 폴더를 `claude-agent\accounts\<새 id>`로 옮긴 뒤(같은 볼륨의 rename) 링크를 만들고 Claude Agent 계정으로 등록한다. 로그인은 그대로 옮겨진다.
- Claude Agent → claude-auth: 이 앱의 claude-auth가 여러 계정을 쓸 때만 된다(`not_patched`). 그 계정의 대화가 돌지 않을 때만 된다. 프로바이더의 풀도 묻는다(관찰 채널의 `busy`, CAG-37): 그 폴더에서 일하는 claude가 있으면 `session_busy`이고, 쉬는 claude와 예비는 옮기기 전에 닫는다(목록은 묻기만 하고 닫지 않는다). claude-auth가 먼저 `claude-accounts\<새 id>`를 own이 만든 폴더로 받고(`ClaudeAccounts.adopt`, 그 정리가 폴더를 가져가지 않게), 폴더를 옮긴 뒤에야 계정을 빼고(대화는 기본 계정으로) 링크를 뗀다. 옮기기가 실패하면(폴더를 잡은 프로세스) claude-auth가 받은 계정을 도로 놓고 오류를 낸다. Claude Agent 계정과 폴더, 링크, 대화의 계정은 그대로다. 그 뒤로는 claude-auth만 그 로그인을 갱신한다.
- 어느 쪽이든 폴더 하나를 두 경로가 함께 갱신하는 때는 없다. claude-auth의 출처 바꾸기는 Claude Agent 폴더를 거절한다(시험).
#### 8.10.11 3단계: 원래 형식 기록(코어 P-043, 2026-11-01)

Claude가 보지 못한 기록을 글 하나(`<conversation-checkpoint>`)로 보내지 않고, Claude Code의 기록(JSONL) 항목으로 써서 이어 받게 한다(보고서 12장). 그래서 다른 provider의 도구 호출도 Claude에게는 자기 `tool_use`·`tool_result` 블록(id와 함께)으로 보이고, 새 턴에는 새 입력만 간다.

**원칙(보고서 14장)**
- 정본은 own DB 하나다. 쓰는 방향은 DB → Claude 기록 하나다. Claude 기록을 읽어 DB를 고치지 않는다.
- Claude 기록은 DB에서 만든 사본이고 버릴 수 있다. 같은 기록에서는 늘 같은 항목이 나온다: 항목 uuid는 (Claude 대화 id, 앞 항목, 묶음 지문)에서, 시각은 앞 항목의 시각에서 1 ms씩 뽑는다(새 기록은 2000-01-01부터). 새로 만든 기록의 Claude 대화 id도 (OpenCode 대화 id, 묶음 지문들)에서 뽑는다.
- own은 `user`·`assistant` 항목과 uuid 사슬만 쓴다. Claude Code의 내부 항목은 흉내 내지 않는다.

**언제 쓰나**: 요청이 `continue`(새 입력만 있고 살아 있는 claude가 있음)가 아니고 도구 결과를 기다리는 턴의 이어가기도 아니면, 프로세스를 닫고 기록을 맞춘 뒤 `--resume`한다. 묶음 중 마지막 사용자 입력 앞까지가 기록에 들어가고, 그 뒤의 사용자 입력이 새 턴이다(`NativeTranscript.inputStart`). 기록이 도구 결과로 끝나고 새 입력이 없으면 `Continue from where you left off.` 한 줄로 턴을 연다.
1. **짝이 가리키는 대화를 프롬프트가 온전히 이어 갈 때**(따라잡기): 파일을 확인하고(아래) 놓친 묶음을 그 대화 끝에 그대로 덧붙인다. 같은 Claude 대화가 이어진다. 다른 provider와 번갈아 써도 Claude 대화는 하나다.
2. **중간이 바뀌었을 때**(편집, undo, 파일 끝이 짝과 다름, 중단된 턴 뒤의 따라잡기): 원래 기록을 마지막 안전한 지점에서 fork한다(SDK `forkSession`, 바이트 그대로라 Claude의 서명된 생각과 캐시가 남는다). 그 뒤를 원래 형식으로 덧붙인다. 도구 호출과 결과 사이는 자르지 않는다.
3. **맞는 것이 없을 때**(처음 넘어옴, 압축 뒤, 파일이 없어짐이나 손으로 고침): 기록 전체를 새 Claude 대화로 만든다. 사용자 입력만 있으면 파일을 만들지 않고 새 대화를 연다.
- 곁가지 요청(`generate`·압축)과 OpenCode의 fork는 원래 대화의 기록을 쓰지 않는다. fork하거나 새로 만들고, 곁가지 것은 끝나면 지운다.

**변환**
| OpenCode 기록 | Claude 기록 항목 |
|---|---|
| 사용자 묶음 | `user`(글, 그림, PDF 블록. 역할 태그 없음) |
| assistant 메시지 | `assistant`(글 + `tool_use`). 이름은 `mcp__opencode__<도구>`, id는 Anthropic 형식이 아니면 `toolu_oc_<sha256>`로 늘 같게 바꾼다. 모델 `<synthetic>` |
| 도구 결과 묶음 | `user`(`tool_result`, 오류 표시, 뒤따르는 미디어). 변환은 프로바이더의 `ToolResult.collect` 그대로 |
| 다른 모델의 생각 | core의 to-llm-message와 같다: 읽을 수 있는 글만, 다른 provider의 서명은 없이. Anthropic은 서명 없는 thinking을 받지 않으므로 글 블록이 된다(own의 Anthropic 경로가 서명 없는 생각을 글로 바꾸는 것과 같음) |
| provider가 실행한 도구, 결과가 없는 호출, 짝 없는 결과 | `tool_use` 짝이 되지 않으므로 따라잡기의 `<tool-call>`·`<tool-result>` JSON 글로 남긴다 |
| 압축 요약(core의 `<conversation-checkpoint>` user 메시지) | 첫 `user` 항목 그대로. 프로바이더가 한 번 더 감싸던 태그(보고서 12.4)는 없다 |

**짝(record)과 확인**
- 플러그인 저장소 `sessions/<id>`의 짝에 더한 것: `seal`(own이 마지막으로 쓰거나 확인한 기록 앞부분: 마지막 uuid, user·assistant 메시지 수, 그 메시지들의 digest), `version`(항목을 쓴 Claude Code 버전), `previous`(바뀐 대화들, 최근 것부터 4개).
- 어긋남은 요청마다 잰다(DB 쪽, 지금의 `SyncDecision.decide`). 파일 쪽은 이어 받기 전마다 잰다: 파일이 있는지, `seal`의 앞부분이 그대로인지(수와 digest), 짝의 체크포인트가 차례대로 있고 파일이 짝의 마지막에서 끝나는지(중단된 턴은 Claude의 남은 답이 뒤따라도 된다).
  - 파일 없음, 앞부분이 바뀜(손으로 고침): 바뀐 파일은 지우고 DB에서 새로 만든다.
  - 앞부분은 그대로인데 끝이 다름(서버가 턴 중간에 죽음 등): 맞는 곳까지 fork하고 나머지를 만든다.
- 확인이 맞으면 그때의 끝으로, 그리고 프로세스가 쉼·풀·종료로 닫힐 때 다시 `seal`한다.

**비우기 되돌리기**: 대화가 바뀔 때(문맥 비우기, 압축, fork) 옛 짝을 `previous`에 둔다. 다음 프롬프트가 지금 짝과 맞지 않고 `previous`의 하나를 온전히 이어 가면 그 짝이 다시 지금 것이 된다. 그래서 비우기를 되돌리면 비우기 전 Claude 대화를 그대로 이어 받고, 비운 동안의 턴을 그 끝에 덧붙인다. 그 기록 파일이 없을 때만 DB에서 새로 만든다.

**안 쓰는 기록 지우기**: `previous`에서 밀려난 대화와 손으로 고쳐진 기록은 바로 지운다. 프로바이더가 시작하고 1분 뒤 공유 기록 폴더(`projects`)를 한 번 훑어, 어떤 짝(지금 것과 `previous`)도 가리키지 않고 살아 있는 프로세스도 쓰지 않으며 1시간(캐시 수명)보다 오래된 `.jsonl`과 그 옆 폴더를 지운다. P-043 전에 남은 옛 기록도 이렇게 정리된다. 이름이 Claude 대화 id(uuid)가 아닌 `.jsonl`(`.jsonl`, `...jsonl` 같은)은 기록으로 보지 않는다(CAG-34).

**공유 기록 폴더 안에서만(CAG-34, CAG-42)**: own-accounts가 확인을 지난 공유 기록 폴더를 그 실제 경로로 관찰 채널에 알려 준다(`shared`). 확인이 거절하면 지운다. 프로바이더는 기록을 쓰고 지우고 훑기 전에 매번 두 가지를 본다: 알려 받은 경로의 실제 경로가 그 경로 자체이고(Windows에서는 대소문자 무시), 계정 폴더 `projects`의 실제 경로가 그 경로다. 그래서 공유 폴더로 가는 길 어디에 junction이 있어도(`<OWN_HOME>\claude-agent` 자체가 다른 곳을 가리켜도) 거절한다. CAG-34까지는 공유 폴더의 마지막 이름만 봤고, own-accounts가 거절한 뒤에도 시작 때 알려 준 경로가 남아 있어 그 위 junction 너머의 기록을 지우고 쓸 수 있었다. 거절하면 훑기와 지우기는 경고만 남기고 건너뛰고, 쓰기는 요청을 실패시킨다(쓰지 못한 기록 없이 이어 받지 않는다). 까닭은 한국어로 말한다(`Claude Agent가 …projects의 대화 기록을 바꾸지 않았어요: …`). 쓰기와 지우기는 계정의 링크를 거치지 않고 확인한 공유 폴더 경로에서 한다. 링크인 대화 폴더(`projects/<폴더>`)와 그 아래 폴더(`<폴더>/<대화 id>`)도 거절하고, 쓸 기록 파일이 링크이거나 하드 링크가 둘 이상이면(다른 이름으로 바깥 파일을 바꾸게 되므로) 덧붙이지 않고 거절한다(CAG-44). 읽기는 막지 않는다. own-accounts의 고치기(8.10.10)와 따로 돌아도 밖을 건드리지 않는다. 남는 틈: 확인과 쓰기 사이에 누군가 대화 폴더를 junction으로 바꿔치기하면(OWN_HOME 안에서 그 순간을 노려 도는 프로그램) 막지 못한다.

**한계**
- 다른 provider의 생각은 서명이 없어 생각으로 넘기지 못한다(글이 된다). Claude 자신의 옛 생각은 원래 기록을 fork할 때만 남는다.
- 새로 만든 앞부분은 처음에 캐시 쓰기다. 원래 형식이 주는 것은 구조이지 비용이 아니다(보고서 12.5).

#### 8.10.12 3단계: 프로세스 풀(코어 P-044, 2026-11-01)

대화마다 claude가 하나씩 뜨므로(약 300 MB private) 서비스 전체의 살아 있는 claude 수에 상한을 둔다(보고서 9.3).

| 규칙 | 값 |
|---|---|
| 상한 | 기본 8. 설정 `claudeAgent.pool.set{processes}`(1–64, `accounts.json` `claudeAgentPool`)이 프로바이더의 관찰 채널(P-039)로 간다 |
| 닫기 | 새 프로세스가 자리가 없으면 가장 오래 쉰 프로세스부터 닫는다(LRU). 예비가 있으면 예비가 먼저다. 짝과 기록은 남아 다음 요청이 같은 대화를 이어 받는다 |
| 닫지 않음 | 턴이 도는 프로세스, 도구 결과를 기다리는 프로세스(하위 에이전트, 권한 질문, 질문 도구). 요청이 들어오는 중인 대화도 |
| 기다림 | 모두 닫을 수 없으면 새 시작은 줄을 서서 기다린다. 빈 자리는 온 차례대로 준다. 단 하위 에이전트를 기다리는데 살아 있는 하위 에이전트가 하나도 없는 부모의 하위 에이전트(그것 없이는 부모가 나아가지 못하는 시작)가 먼저이고, 그렇게 앞지른 시작마다 한 번만 앞지른다(CAG-45). 기다리는 대화는 `claudeAgent.pool`의 `waiting`에 있고, 화면에 줄이 보인다 |
| 넘김 | 교착을 풀 때만 상한을 넘긴다(`over`, CAG-35, CAG-43). 살아 있는 프로세스가 모두 다른 대화를 기다릴 수 있는 도구에 붙잡혀 있고(하위 에이전트 `subagent`·`task`, 질문 `question`; Claude가 그 도구를 부를 때 이름으로 안다), 그 상태가 3초 이어졌을 때(다시 볼 때 같은 프로세스들이 여전히 붙잡혀 있어야 한다)만, 기다리는 시작 중 부모가 있는 것(하위 에이전트) 하나를 띄운다. 보통 도구(읽기, 명령 등)를 기다리는 프로세스는 붙잡힌 것으로 세지 않는다: 그 도구는 곧 끝나 자리가 난다. 권한 질문은 지키는 도구 안에서 묻는 것이라 이름으로 알 수 없고, 사용자가 답하므로 세지 않는다. 부모가 다른 provider의 대화여도 된다(Claude Agent → GPT 하위 에이전트 → Claude Agent 하위 에이전트). 한 번에 하나다: 띄운 것이 도는 동안 다음 것은 그것도 붙잡힐 때까지 기다린다. 부모가 없는 대화는 넘기지 않는다. 넘김은 상한의 2배까지다. 그 너머로는 자기 부모가 하위 에이전트를 기다리는데 살아 있는 하위 에이전트가 없는 시작만 간다(기다리는 부모마다 하나, 하위 에이전트 사슬의 다음 단계). 나머지는 기다리며 줄이 보인다. `over`는 그때마다 살아 있는 것으로 센다 |
| 곁가지 요청 | 제목·`generate`·압축, 로그인 확인과 쉬는 계정의 한도 읽기(CAG-38)는 대화의 자리를 쓰지 않는다. 따로 상한만큼까지 돌고(넘으면 다른 곁가지 요청이 끝나기를 기다린다), 닫히지 않으며, 붙잡힌 것으로도 세지 않는다(CAG-46). 실행 중인 수(`live`)에는 들어간다. 계정 폴더를 넘길 때 그 폴더에서 도는 곁가지 요청도 바쁜 것으로 센다 |
| 설정 바꾸기 | 바로 적용한다(CAG-36). 상한을 올리면 기다리던 시작이 바로 뜨고, 내리면 상한을 넘는 쉬는 프로세스를 바로 닫는다. 돌거나 기다리는 것은 닫지 않고, 쉬게 되면 닫는다. 예비 수를 줄이면 넘는 예비를 닫는다 |
| 쉼 타이머 | 5분. 상한의 절반 이상이 쓰이면 2분이고, 이미 쉬는 프로세스도 쉰 때부터 2분으로 줄인다. OpenCode가 그 대화를 멈춰 결과가 오지 않을 도구 대기는 닫을 수 있다 |
| 예비(끄기 기본) | `spares`(0–2): 계정 폴더마다 마지막 새 대화와 같은 설정(지시문, 도구, 연결)으로 SDK `prewarm`(alpha) 프로세스를 미리 띄워 둔다. 다음 새 대화(이어 받을 기록이 없을 때)가 그것을 claim한다. 빈 자리가 있을 때만 띄우고, 상한에 닿으면 가장 먼저 닫는다. claim이 거절되면 보통 시작으로 돌아간다 |

- 팀 모드: 영역이 상한보다 많아도 상한을 지킨다. 담당 턴이 끝난 프로세스가 닫히고 기다리던 담당이 뜬다(e2e: 상한 2, 영역 3).
- 화면: 계정 화면 Claude Agent 묶음 아래 `실행 중인 Claude 3/8`(기다리는 대화 수, 넘긴 수)과 `바꾸기`(상한, 예비). 기다리는 대화의 입력창 위 `Claude Agent 프로세스가 모두 일하는 중이라 자리가 나기를 기다리고 있어요 (8/8)`. 창을 열거나 다시 연결할 때 Claude Agent 계정이 있으면 `claudeAgent.status`로 지금의 풀을 읽으므로, 기다리는 중에 연 창에도 바로 보인다(CAG-39).

#### 8.10.13 SSH 원격 호스트에서(코어 P-052, 2026-11-03, 사용자 결정 CAG-R)

사용자 결정(2026-11-03): "응 원격에서도 되도록 해야함" — Claude Agent 경로를 SSH 원격 호스트의 대화에서도 쓴다.

**고른 방식(CAG-R1): claude는 이 PC에서 돌고, 호스트의 프로바이더가 own의 브로커로 그것을 몬다.**

| 안 | 요지 | 판단 |
|---|---|---|
| (A) PC에서 claude, 호스트가 브로커로 몰기 | 호스트의 프로바이더가 claude의 stdio를 브로커 채널로 PC에 보낸다. PC가 계정 폴더에서 claude를 띄운다. 도구는 프로바이더의 MCP 도구 서버(호스트 프로세스 안)가 호스트의 OpenCode로 실행한다 | **채택** |
| (B) 호스트에서 claude | 호스트마다 Claude Code를 설치하고 계정마다 호스트 폴더에서 로그인한다 | 기각: 토큰이 호스트에 생긴다("자격 증명은 PC에" 원칙, 04 §8.1·§8.11·16 §8과 어긋남), 호스트마다 설치·업데이트·로그인, 계정 하나를 두 기계가 갱신하면 refresh token 회전이 겹친다(8.7) |

(A)가 되는 까닭(코드로 확인):
- 프로바이더는 Claude Code의 내장 도구를 끄고(`--tools=`, `permissionMode: dontAsk`, `allowedTools: mcp__opencode__*`) OpenCode의 도구만 MCP로 준다. 그 MCP 서버는 SDK의 in-process 서버(`createSdkMcpServer`)라 claude와의 대화가 claude의 stdio 위 control 메시지(`mcp_message`)다. 훅(PreToolUse·PostToolUse)도 같다. 그래서 stdio만 옮기면 도구는 호스트에서 그대로 돈다. claude 자신은 호스트의 파일을 만지지 않는다.
- SDK는 프로세스를 직접 띄우지 않게 할 수 있다(`spawnClaudeCodeProcess`: `{command, args, cwd, env}`를 받아 stdin·stdout을 돌려주는 함수). 프로바이더의 IO(`ClaudeIO.Interface`)가 이미 이 자리를 갖고 있다(시험의 가짜 claude가 쓰는 자리).
- 프로바이더가 claude 밖에서 하는 일(기록 확인·fork·삭제, 원래 형식 기록 쓰기·읽기·목록, `--version`)도 IO 한 곳을 지나므로 같이 옮길 수 있다.
- 지연: 도구 호출마다 왕복 한 번(MCP 요청이 PC→호스트, 결과가 호스트→PC), 토큰 스트림은 반 왕복이 더해진다. claude-auth 중계(04 §8.11)와 같은 크기다. 모델 트래픽은 PC에서 바로 Anthropic으로 간다.

**구성**
- 호스트(`deps.remote`): own-accounts가 관찰 채널(P-039)의 `relay`에 브로커 전달자를 둔다. 그동안 `ClaudeIO.real`은 호출마다 그것을 쓴다(`ClaudeRelay.io`): `spawn`은 브로커 스트림을 연 가짜 자식 프로세스, `sessionExists`·`fork`·`remove`·`transcripts.*`·`version`은 PC에서 하는 호출이다. 실행 파일 경로는 자리만 채우는 값(호스트의 `process.execPath`)이고 env는 비어 있다(PC가 만든다). 예비 프로세스(spare)는 호스트에서 쓰지 않는다.
- PC: 프로바이더가 관찰 채널의 `hosts`로 서버(`ClaudeRelay.server`)를 낸다. own-accounts의 브로커가 호스트의 스트림을 받아 그 서버에 넘긴다(`BrokerClaudeAgent`).
- 계정 폴더 이름: 호스트의 프로바이더 설정과 요청의 `configDir`은 경로가 아니라 `relay:<accountID>`다. PC가 그것을 그 계정의 폴더로 바꾼다. 호스트는 PC의 경로를 모른다.
- PC의 작업 폴더: 호스트 폴더마다 `<OWN_HOME>\claude-agent\hosts\<hostId>\<sha256(호스트 폴더) 앞 16자>`. claude의 cwd이고, 원래 형식 기록의 프로젝트 키도 이 폴더에서 나온다(호스트 폴더 이름은 PC에 경로로 쓰이지 않는다).

**PC가 지키는 것(호스트는 덜 믿는다, 04 §15)**
- 실행 파일은 PC의 `claude`(P-051, PATH)다. 호스트가 보낸 명령은 쓰지 않는다.
- 인자는 허용 목록으로만 받는다(`ClaudeRelay.gate`). 고정 플래그(`--output-format stream-json`, `--input-format stream-json`, `--verbose`, `--tools=`, `--allowedTools=mcp__opencode__*`, `--setting-sources=`, `--strict-mcp-config`, `--permission-mode=dontAsk`, `--settings {"disableAllHooks":true}`)는 값까지 같아야 하고 빠져도 안 된다. 그 밖에는 모델·노력·생각·`--resume`·`--session-id`·`--fork-session`·`--resume-session-at`·`--no-session-persistence`·`--include-partial-messages`만 값 검사와 함께 받는다. `--add-dir`, `--plugin-dir`, `--mcp-config`, `--dangerously-skip-permissions` 같은 것은 시작을 거절한다.
- env는 PC가 만든다: P-042 허용 목록 그대로(`ClaudeIO.allowed`), 그 계정의 `CLAUDE_CONFIG_DIR`과 그 폴더의 `ANTHROPIC_CONFIG_DIR`(8.10.6), PC 프로바이더 설정의 연결 env(base URL 등), upstream의 격리 env. 호스트에서는 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`(숫자), `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`만 값 검사 뒤 받는다. 호스트의 `ANTHROPIC_*`·`CLAUDE_CONFIG_DIR`은 받지 않는다.
- 호스트의 입력도 줄마다 거른다(`ClaudeRelay.admitInput`): 사용자 메시지(늘 `client_composed: true`, Claude Code 명령으로 읽히지 않게), claude 요청의 답(`control_response`), 취소, 그리고 프로바이더가 쓰는 control 요청(`initialize`, `interrupt`, `set_model`, `apply_flag_settings{effortLevel}`, `get_usage`, `get_context_usage`, `mcp_status`)만 지난다. `initialize`는 MCP 서버가 `opencode` 하나이고 `agents`·`plugins`·스킬이 없을 때만 지난다. `mcp_set_servers`, `update_settings`, `read_file`, `set_cwd`, `set_permission_mode` 같은 나머지 요청은 claude에 닿지 않고 오류 답을 받는다.
- claude의 출력에서 `initialize` 답의 계정은 요금제 쪽(`subscriptionType`, `tokenSource`, `apiKeySource`, `apiProvider`)만 남긴다. 이메일과 조직은 호스트로 가지 않는다.
- 계정: 호스트의 계정 범위(04 §8.9 `hosts[].accounts`)가 허용하는 Claude Agent 계정만 쓴다(아니면 거절, 한국어 까닭). 매 프로세스와 호출마다 그 계정의 공유 기록 링크를 확인한다(8.10.10).
- 호스트에 토큰이 가지 않는다: 로그인과 갱신은 PC의 Claude Code가 한다. 호스트가 받는 것은 claude의 스트림(대화, 도구 호출, 결과, 한도 이벤트)과 계정의 표시 정보뿐이다.

**브로커 위 스트림(04 §8.13)**: 프로세스와 호출은 모두 브로커 채널의 스트림이다(새 전달 없음). `claudeAgent.open`(프로세스는 PC 풀의 자리를 받은 뒤 답한다), `claudeAgent.start`(SDK의 인자와 env), `claudeAgent.write`(차례대로, 한 번에 128 Ki자), `claudeAgent.close`, 그리고 PC의 `claudeAgent.data`·`claudeAgent.exit` 푸시. 같은 빌드끼리(정상 모드)에서만 된다(GitHub와 같다).

**계정과 전환(PC와 같게, 손으로만)**
- 미러(04 §9.2)의 `claudeAgent.accounts`가 호스트가 쓸 수 있는 PC의 Claude Agent 계정이다(표시 정보와 `default`, `loggedIn`. 폴더·이메일·uuid 없음). 없으면 호스트에서 이 경로는 꺼져 있다.
- 호스트의 own-accounts가 PC와 같은 규칙(8.10.10)으로 대화 트리·팀을 계정 하나에 묶는다. 바인딩 KV(`claude-agent:session:<root>`, `claude-agent:team:<teamID>`)는 호스트 DB에 있다. 새 트리는 호스트의 기본 계정(KV `claude-agent:host-default`, 없으면 PC의 기본)으로 시작한다.
- 호스트에서 되는 RPC: `claudeAgent.session.get`, `claudeAgent.session.set`(트리를 옮기고 호스트의 기본으로도 둔다), `claudeAgent.default.set`(호스트의 기본). 계정 만들기·로그인·빼기·한도 새로 읽기·풀 설정·폴더는 PC의 것이라 여전히 `remote_managed`다.
- 다른 계정으로 옮기면 PC에서 그 계정 폴더의 claude가 같은 Claude 대화를 `--resume`으로 이어 받는다(모든 계정 폴더의 `projects`가 공유 기록 폴더다).

**원래 형식 기록(P-043)과 정리**: 호스트의 프로바이더가 PC에 기록을 쓰고 읽는다(위의 호출). 짝과 봉인은 호스트 DB에 있다. PC의 정리(프로바이더 시작 1분 뒤의 훑기)는 `hosts` 아래 프로젝트 폴더를 건드리지 않는다(관찰 채널의 `hostsRoot`). 호스트의 정리는 자기 호스트 폴더 아래의 기록만 보고 지운다.

**프로세스 풀(P-044)**: 호스트 대화의 claude도 PC 풀의 한 자리다. 자리가 없으면 호스트의 시작이 PC에서 기다린다(이 기다림은 30초 시작 시간 제한에 들지 않는다). 기다리는 대화는 PC의 `claudeAgent.pool`의 `waiting`에 호스트 대화 id로 나오고, own-web은 호스트 대화의 입력창 위에도 그 줄을 보인다(호스트의 저장소가 PC의 풀을 따른다). PC는 스트림을 줄 단위로 읽어 턴이 도는 중인지, 다른 대화를 기다릴 수 있는 도구(`subagent`·`task`·`question`)를 기다리는지 안다. 그래서 쉬는 호스트 프로세스는 로컬 것처럼 가장 오래 쉰 것부터 닫히고(입력을 끝내 기록을 마무리하게 한 뒤, 5초 뒤 강제), 교착 규칙(CAG-43)도 같다. 호스트는 닫힘을 바로 알고 다음 턴에 이어 받는다.

**한도(P-039)**: PC가 스트림에서 `rate_limit_event`와 시작 때의 요금제를 읽어 그 계정 폴더의 관찰로 낸다. 그래서 호스트 대화의 한도도 PC의 그 계정 창이 되고, 호스트에는 `quota.updated`로 간다. own-web은 원래 PC의 한도를 보인다(04 §12.6).

**끊김과 다시 연결**: 브로커 세션이 끊기면 PC가 그 세션의 claude를 모두 닫고(입력 끝 → 기록 마무리), 호스트는 같은 순간 그 프로세스들이 끝났다고 본다. 도는 턴은 실패하고, 다시 연결된 뒤의 다음 턴은 새 claude가 같은 Claude 대화를 `--resume`으로 이어 받는다(원래 형식 기록이 확인).

**모델 목록과 첫 프롬프트 기다림(MR11-1)**: 미러가 계정을 주면 호스트가 control Location에서 연결을 만들고(8.10.2 4번과 같은 연결), 그 연결이 프로바이더의 상태 확인을 깨운다. 그 확인의 claude도 PC에서 돈다(곁가지 자리). 모델 목록이 채워지면 호스트의 모델 목록에 `claude-agent/…`가 보인다. 그 확인은 연결을 만든 control Location에서 돌므로, 한 Location이 읽은 모델 목록은 같은 프로세스의 모든 Location 인스턴스에 간다(그 전에 열린 작업 폴더 Location도 모델을 얻는다). 계정 폴더가 아직 정해지지 않은 Location의 확인은 실패로 적지 않고 기다린다(own-accounts의 fold가 프로바이더보다 늦게 설정될 수 있다. 한 번 확인한 뒤 폴더가 없어지면 실패다). 그 전에 새 대화에서 보낸 첫 프롬프트는 own-web의 `hostServes`가 그 모델이 호스트 목록에 나올 때까지 기다린다(최대 60초, 다른 모델과 같은 규칙).

**호스트에서의 시스템 프롬프트**: claude가 보고하는 작업 폴더·플랫폼·git 상태는 PC의 것이다. 그래서 호스트의 프로바이더는 덧붙이는 글 끝에 그것이 작업 공간의 것이 아니라는 한 줄(`ClaudeRelay.NOTE`)을 더한다. OpenCode의 환경 정보(호스트 경로)는 그대로 간다.

**권한 질문과 쓰기 질문**: 도구가 호스트의 OpenCode에서 돌므로 호스트 대화에 평소대로 뜬다.

**시험**: 코어 `own-relay.test.ts`(인자·입력 거르기, 이메일 지우기, 한 프로세스 안의 호스트↔PC로 도구 턴, 끊김 뒤 이어 받기, PC 풀의 자리 기다림, 상태 확인), own-accounts fake-SSH e2e `test/remote/e2e/claude-agent-relay.test.ts`(가짜 claude CLI가 PC 쪽: 호스트 대화가 호스트에서 도구를 돌림, 다시 연결 뒤 이어 받기, 계정 전환, 압축, PC 한도, 호스트에 로그인 없음), 실제 호스트 C단계 항목(다음 릴리스에서 돌림).

**남은 것**
- 호스트에서 `claudeAgent.limits.refresh`(쉬는 계정의 한도 읽기)는 PC 화면에서 한다(`remote_managed`).
- 호스트 OpenCode가 대화를 멈춰 결과가 오지 않을 도구를 기다리는 claude(8.10.12 "쉼 타이머")를 PC는 모른다. 호스트의 쉼 타이머가 그것을 닫을 때까지 PC 풀에서 바쁜 것으로 센다.
- 다른 빌드끼리(drain 모드)는 이 경로가 없다.

#### 8.10.14 Claude Code 버전, 문맥 창, 계정마다의 표면(2026-11-03, CAG-49–CAG-53)

**어느 claude를 띄우나**: 이 경로는 이 PC에 설치된 Claude Code를 띄운다(`OPENCODE_CLAUDE_PATH`, 없으면 `PATH`의 `claude`). 릴리스는 SDK의 `claude.exe`(약 240 MB)를 싣지 않는다. 로그인 창(8.10.3)도 설치된 Claude Code다.

**버전 확인(코어 P-051, CAG-49)**
- SDK 0.3.301의 `initialize` 응답에서 `claude_code_version`은 선택 필드다. Claude Code 2.1.282(사용자 PC의 네이티브 설치)는 이 필드를 보내지 않는다. upstream은 버전이 없으면 오류(`Claude Code did not report its version, so compatibility could not be checked. Run "claude update".`)로 모든 대화를 막았다. 그래서 설치된 2.2.5-own.1에서 이 경로를 전혀 쓸 수 없었다.
- 지금: 응답에 버전이 없으면 그 바이너리의 `--version`을 읽는다(바이너리 파일의 경로·크기·시각마다 한 번, 실패는 기억하지 않음, 15초 상한). 그래도 모르면 경고만 남기고 대화를 막지 않는다(fail open). 알고 있는 버전이 2.1.248보다 낮을 때만 막고, 그 글은 한국어다: `Claude Code 2.1.200 버전은 너무 오래돼서 own에서 쓸 수 없어요(2.1.248 이상 필요). own은 이 PC에 설치된 Claude Code를 실행해요. 터미널에서 claude update로 업데이트한 뒤 다시 보내 주세요.`
- 읽은 버전은 상태 확인(probe)의 `version`과 원래 형식 기록의 `version`(8.10.11)에도 쓰인다.

**문맥 창(CAG-52)**
- 창은 Claude Code가 알려 준 값이다. 상태 확인이 모델마다 `setModel` 뒤 `getContextUsage{detail:"summary"}`의 `rawMaxTokens`를 읽는다(용량. `maxTokens`는 Claude Code 자신의 압축 창일 수 있다. Claude Code 2.1.257 이상). 계정·요금제에 따라 다를 수 있으므로 표를 박아 두지 않는다. 기본 계정의 폴더로 읽는다.
- 확인한 값(2026-11-03, 로그인 없이 SDK로 읽음): Claude Code 2.1.301은 `opus`(claude-opus-5-5), `sonnet`(claude-sonnet-5-5), `haiku`(claude-haiku-5-5), `fable`(claude-fable-5-1) 모두 1,000,000이다. 2.1.282는 `opus[1m]`과 `sonnet`(claude-sonnet-5)이 1,000,000, `haiku`(claude-haiku-4-5)가 200,000이다. Anthropic 문서도 Opus 5.5·Sonnet 5.5·Fable 5.1은 1M이 기본이자 최대이고(출력 128K), Haiku 5.5는 models.dev 카탈로그에서 1M, Haiku 4.5는 200K다.
- 사용자 PC의 문제: 버전이 없어 상태 확인이 창 읽기를 건너뛰었고(버전 조건), 저장된 모델 목록에 창이 없으니 모든 모델이 코어의 기본값 200,000으로 보였다(자동 압축도 170k). 대화의 시작 보고는 창을 담지 않으므로 그 목록은 다시 채워지지 않았다.
- 지금: 버전을 `--version`으로 읽으니 창을 읽는다. 저장된 목록의 모든 모델에 창이 없으면 시작할 때 상태 확인을 다시 돌린다(P-051, `provider.ts`). 일부 모델만 없으면(그 로그인이 쓸 수 없는 모델) 다시 돌리지 않는다.
- **없어진 `[1m]` 이름(2026-11-10, 결정 CI-2).** Claude Code 2.1.311은 바꾸는 것이 없는 곳에서 모델 이름의 `[1m]`을 뗐다(2.1.282의 `opus[1m]`이 지금은 1M인 `opus`). 사용자는 2026-11-08에 2.1.319로 올렸으므로, 그 전에 `claude-agent/opus[1m]`으로 저장된 대화는 목록에 없는 모델을 가리키고 코어가 그 단계를 `ModelUnavailableError`로 실패시킨다. own-accounts의 provider fold(`ClaudeAgent.fold`)는 목록에 `X`가 있고 `X[1m]`이 없으면 `X[1m]`을 `X`의 사본으로, `deprecated`로 다시 등록한다(07 §4.4와 같은 규칙). 요청은 `X`로 간다(`modelID`). 그래서 그런 대화는 그대로 이어지고, 어느 고르기 화면도 그 이름을 새로 보이지 않으며, 그 이름에 고정한 프리셋은 수리 알림이 `X`를 제안한다(`Preset.successor`의 이름 바뀜 규칙, 07 §4.3). 새 대화 기본값이 그 이름이면 07의 규칙대로 `missing`이 되고 자동 규칙의 모델로 시작한다. 숨긴 모델 목록의 `X[1m]`은 그 사본만 숨긴다. 코어 패치는 없다.
- **대화가 알려 주는 창(코어 P-053, 2026-11-08, 결정 PE-7).** 사용자 보고: Claude Agent의 Opus가 1M이 아니라 작은 창으로 보이고 쓰였다. 상태 확인의 창 읽기는 모든 모델을 합쳐 30초이고 모델 하나가 실패해도 넘어가므로, 읽지 못한 모델은 저장된 목록에서 코어 기본 200,000으로 남고(P-051의 다시 확인은 모든 모델에 창이 없을 때만) 문맥 막대와 자동 압축(170k)이 그 값을 쓴다. Claude Code는 대화의 턴마다 결과(`result`)의 `modelUsage[모델].contextWindow`에 그 모델의 창을 알려 준다(SDK 0.3.301, 녹화된 턴에 있음). 이제 턴이 끝나면 그 값이 관찰 채널로 가고(`windows{model, usage}`), 프로바이더는 **창이 없는 모델에만** 그 턴이 쓴 모델의 항목(resolved id와 같은 키나 canonical 이름, `[1m]`은 떼고 비교. 맞는 것이 없으면 항목이 하나일 때만 그것)을 넣고 목록을 저장한 뒤 다시 읽는다. 상태 확인이 읽은 창은 그대로다(upstream의 "대화의 시작 보고는 저장된 창을 지킨다"). 그래서 창을 못 읽은 모델도 첫 턴 뒤에는 Claude Code가 실제로 쓰는 창이 된다. 첫 턴 전에는 여전히 200,000이다. 사용자 PC에서 어느 쪽이었는지(창 읽기 실패·시간 초과, 또는 그 alias의 창이 실제로 작음)는 서비스 로그의 `Claude Code context discovery failed`/`timed out` 줄로 알 수 있고, 이번에는 읽지 않았다.

**모델 이름·창의 출처 하나·Fast(코어 P-060, 2026-11-22, 결정 CAM, 2.2.6-own.18)**
- **사용자 보고(2026-11-22)**: 모델 @ 계정 시트의 `CA-01의 모델`이 `Opus`·`Fable`·`Sonnet`·`Haiku`처럼 별칭만 보였고(버전을 알 수 없음), 줄은 `창 200k · 자동 압축 170k`인데 `선택: Sonnet …` 아래 줄은 `창 1M · 자동 압축 850k (모델 한도)`였으며, `Fable` 줄에는 창이 없었다. 속도는 `이 앱이 이 모델 회사의 요청을 다루지 않아 속도를 고를 수 없어요`였다.
- **원인 1(표시, CAM-2)**: 줄은 `accounts.list`의 계정 `compaction.effective`(own-accounts가 fold에서 본 이 경로의 모델과 창, CAG-50의 프로세스 공용 사본)이고, 클라이언트는 `accounts.changed` 때만 그것을 다시 읽는다. 아래 줄은 고를 때마다 새로 계산하는 `switch.estimate`의 `target.compactAt`이다. 이 경로의 모델 목록은 레지스트리 쓰기 없이 바뀌는데(저장된 목록 → 상태 확인이 읽은 창, 업데이트로 생긴 별칭, 턴이 알려 준 창) 아무도 `accounts.changed`를 내지 않아, 줄은 처음 읽은 목록(창 없는 저장 목록의 200k 기본값, Fable이 없던 목록)에 머물렀다. 지금: fold가 이 경로의 모델·이름·창이 바뀐 것을 보면 `accounts.changed`를 한 번 낸다(같은 목록이면 내지 않는다). 줄과 아래 줄은 같은 사본을 읽는다.
- **원인 2(실제 동작, CAM-3)**: 창을 읽지 못한 모델(상태 확인의 30초를 모든 모델이 나눠 써서 뒤 모델이 시간을 넘김, 업데이트로 생겨 대화의 시작 보고에만 실린 별칭)은 첫 턴까지 코어 기본 200,000이고, 코어는 그 대화를 170k에서 압축한다. Claude Code는 1M으로 돌린다. 지금: 창 읽기는 모델마다 15초다. 저장 목록은 상태 확인이 물어본 모델(`checked`)을 기억하고, 거기 없는 모델이 있으면(`checked`가 없는 예전 목록은 창 없는 모델이 있으면) 프로세스마다 한 번 상태 확인을 다시 돌린다(메시지 없음). 물어봤지만 읽지 못한 모델(그 로그인이 못 쓰는 모델)은 다시 묻지 않는다(P-053이 거절한 "매번 다시 확인"이 아니다). P-053은 그대로 첫 턴의 창으로 채운다.
- **진실(2026-11-22 측정)**: 이 PC의 Claude Code 2.1.329는 로그인 없이도, API 키로도 `opus`→claude-opus-5-5, `fable`→claude-fable-5-2, `sonnet`→claude-sonnet-5-5, `haiku`→claude-haiku-5-5이고 모두 `rawMaxTokens` 1,000,000이다. own의 세션 경로로 보낸 턴마다 `modelUsage[*].contextWindow`도 1,000,000이다. Models API의 `max_input_tokens`도 Opus 5.5·Sonnet 5.5·Haiku 5.5·Fable 5.1·Fable 5.2 모두 1,000,000(출력 128,000)이다. 1M 변형(`[1m]`)은 2.1.311부터 따로 없다. Claude Code가 `opus[1m]` 같은 줄을 따로 내면 그 줄은 자기 창과 함께 별도 모델로 보인다.
- **이름(CAM-8)**: 코어 목록의 이름은 Claude Code의 표시 이름에 그 별칭이 지금 도는 모델을 붙인다(`resolvedModel` → `Opus · Opus 5.5`, `Fable · Fable 5.2`). 표시 이름이 이미 버전을 담으면 그대로다. 별칭은 그대로 보내므로 Claude Code의 그 계열 기본을 따른다. `resolvedModel`을 주지 않는 Claude Code는 그 모델의 첫 턴이 `modelUsage` 하나로 알려 준 모델로 채운다. 그전에는 시트가 `버전은 첫 사용 뒤에 보여요`를 적는다. 고정 표는 두지 않는다.
- **사실 전달**: 코어는 목록이 바뀔 때마다 모델의 사실(id, 이름, `resolvedModel`, 창, `supportsFastMode`)을 P-039의 관찰 채널(`models`, `channel().models`)에 싣는다. own-accounts는 `ClaudeAgent.models()`로 읽는다.
- **Fast(CAM-6)**: Claude Code는 `supportsFastMode`인 모델(2.1.329: Opus 5.5, Fable 5.2)에 Fast를 준다. SDK 호스트는 `fastMode` 플래그 설정으로 켜야 한다(아니면 `fast_mode_disabled_reason: sdk_opt_in_required`). own-accounts의 속도(4.8)는 이 경로에 Fast 후보 하나를 낸다(`basis: account`, 가격은 anthropic 카탈로그에서 그 별칭이 도는 모델의 Fast 항목: Opus 5.5 $8/$40). Claude 슬롯과 같은 일회 동의(`Kv.ackClaudeFast`, 추가 사용량 과금)가 필요하다. Fast 요청은 제공자 옵션 `fastMode`를 싣고, 코어가 턴 입력 전에 `applyFlagSettings({fastMode})`를 보낸다(표준이면 끈다). 턴 결과의 `fast_mode_state`·`fast_mode_disabled_reason`이 채널(`fast`)로 오면, 그 요청을 보낸 Location의 속도가 `on`이면 Fast로 처리됨, 오래가는 까닭(`extra_usage_disabled`, `model_not_allowed`, `free` 등)이면 그 모델의 Fast를 `unavailable`, `cooldown`이면 잠시 쉼으로 표시하고 다음 턴부터 표준으로 보낸다(계정은 바꾸지 않는다). 표시는 이 경로 전체에 하나다(`claude-agent`). SSH 호스트의 중계는 `apply_flag_settings`의 불리언 `fastMode`를 통과시킨다.
- **비용 줄(CAM-7)**: 목적지가 Claude Agent 계정이면 시트와 비용 창의 비용 줄은 `비용 알 수 없음` 대신 한도 영향(알면) 또는 `토큰 요금 없이 구독 한도에서 써요`이고, `rate_unknown` 알림(`요율을 몰라 …`)은 내지 않는다. Claude 구독 슬롯의 `비용 알 수 없음 — 추가 사용량(API 요금)으로 청구될 수 있음`은 사용자 결정(CW)이라 그대로다.

**계정마다의 표면(CAG-53)**

| 표면 | 규칙 |
|---|---|
| ledger | 요청 줄의 `accountID`가 그 트리의 Claude Agent 계정이다(전에는 `null`). 그래서 `accounts.usage{accountID}`, 계정의 `lastUsedAt`(사이드바의 `사용 중 계정`), 성공한 요청이 지우는 막힘·인증 실패·백오프가 계정마다 된다 |
| 캐시 상태 | `Cache.keyAccount`가 `claude-agent`도 계정마다 나눈다(`sess:<sid>:cache:claude-agent@<accountID>`, SL-8과 같음). 다음 요청의 계정(`signsNext`)과 전환 추정이 읽는 계정(`cacheAccount`, 전환기에서 고른 다른 Claude Agent 계정 줄)도 같다 |
| 수명·자리 비움 압축 | 8.10.5 |
| 한도 배너 | 한도가 막힌 대화의 배너(`limit-reached-banner`)가 이 경로에도 뜬다(Claude 안내와 `다른 계정으로 전환…`) |
| 비용 | 구독은 코어가 값을 주지 않으므로 턴 비용이 `$0`이 아니라 `알 수 없음`이다(API 키 로그인은 값이 있다) |
| 계정 RPC | `accounts.remove.plan`은 `policy_denied`(`claudeAgent.remove`를 쓴다), `quota.resetCredits.*`는 `not_supported`, `presets.consent`와 `accounts.usage`는 이 계정을 받는다. 이름 바꾸기(`accounts.update{label, shortLabel, color}`)는 preset-fixes 가지가 더한다 |
| 카드 | 계정 카드에 `자동 압축: …` 줄과 `바꾸기`(설정의 그 계정 줄로 간다) |
| 원격 | SSH 호스트의 대화에서도 쓴다(8.10.13, 코어 P-052). 호스트에서 되는 RPC는 `claudeAgent.session.get`·`session.set`·`default.set`이고, 계정 만들기·로그인·빼기·한도 새로 읽기는 PC의 것이라 `remote_managed`다 |

## 9. 프런트엔드 API(플러그인 RPC)

### 9.1 방식

- **등록 주체**: RPC id `own.accounts`의 핸들러는 **own-accounts(플러그인 id `own.accounts`)만** 등록한다. `rpc.own.accounts.*` 이벤트는 그 정의를 등록한 registration의 `events.emit`으로만 낼 수 있다(`core/src/rpc.ts:69-104`). 그래서 own-telemetry가 만든 Claude 슬롯 데이터(`anthropic`의 `claude.*` 한도 창, 소진 기록, `claude_extra_usage` 경보)도 `own-runtime`을 거쳐 own-accounts가 낸다. own slot의 한도·ledger·경보는 own-accounts가 직접 만든다. own-telemetry는 RPC를 등록하지 않는다. 한도·사용량 조회도 `own.accounts`의 메서드다(`quota.snapshot`, `ledger.session`, `accounts.usage`, 9.2). 01 §15와 같다.
  - RPC id는 `own.accounts`, `own.remote`(04 §16, own-remote가 등록), `own.team`(06 §2.7, T1부터 own-team이 등록), `own.computer`(01 §10.2, own-computer-use가 등록), `own.import`(09 §5, IMPORT부터 own-import가 등록. SKILLS(2026-10-10)부터 스킬 메서드 `skills.*` 다섯이 더해짐, 09 §9.6) 다섯이다. 이전 판의 "다른 RPC id는 두지 않는다"는 04로 바뀌었다. 이 문서는 `own.accounts`만 정한다. own-import는 `own.accounts`의 `estimate.request`(9.2)와 `accounts.list`를 loopback으로 부른다(own-team의 RPC 호출과 같은 방식). 원격 모드(`health.mode:"remote"`)의 own-accounts는 전역 이벤트를 내지 않는다(04 §22).
- **호출**: `POST /api/rpc/own.accounts/<method>?location[directory]=<dir>`
  - 본문 `{input}` → 응답 `{output}`(`protocol/src/groups/rpc.ts:12-30`)
  - 선언된 오류는 HTTP 400 `RpcError{type, message, data?}`, 그 밖은 HTTP 500 `RpcInternalError{type:"rpc.internal"}`이다(`protocol/src/errors.ts:14-33`). 9.4의 규칙을 따라야 400이 된다.
- **이벤트**: `/api/event`로 `rpc.own.accounts.<name>`이 location과 함께 온다(`core/src/rpc.ts:98-103`).
- **정의**: `packages/own-protocol`(`@own/protocol`)의 `./rpc` export(`Rpc.PortableDefinition`, `schema/src/rpc.ts:43-60`)
  - 플러그인: `ctx.rpc.register(def, handlers)`(`plugin/src/promise/rpc.ts:25-31`)
  - own-web: `client.rpc(def).method(input, {location})`, `.events.on(name, fn)`(`client/src/promise/rpc.ts:18-35`)
- **location 규칙**(01 §2·§15와 같다)
  - **전역 메서드**(`health`, `accounts.*`, `quota.snapshot`, `policy.*`, `ratecards.*`, `presets.*`, `plugin.*`, `diagnostics.*`, `worktree.inspect`, `estimate.request`, `notes.*`, `ideas.*`, `voice.*`, `conversationFolder.*`, `folderPicker.*`, `projectList.*`, `mcp.*`, `skillset.*`)는 **control location**으로 부른다. 경로는 `%LOCALAPPDATA%\own-open-code\control`(빈 디렉터리, launcher와 설치기가 만든다)이다.
    - 이유: 서비스 cwd는 홈 디렉터리이고 파일 watcher가 기본으로 켜져 있다. 전역 호출을 임의의 location으로 보내면 홈 디렉터리 같은 무거운 location이 생길 수 있다(01 §5.3, G15).
    - 첫 실행이나 프로젝트가 없는 화면(03 §5.1 "첫 계정을 추가하세요")에서도 이 location으로 부를 수 있다.
    - own-web이 경로를 얻는 방법은 호스트마다 다르다(05 §6.2 OwnHost).
      - 웹 폴백(launcher·msedge 경로): launcher가 앱 URL fragment(`#control=<URL 인코딩 경로>`)로 넘기고 own-web이 기억한다.
      - 데스크톱(`oc://renderer`, [R-desktop] §4.5): fragment가 없다. main은 `OWN_HOME`을 알므로(05 §5.2·§5.4) **OwnHost가 `controlDir`을 내준다**(05와 맞출 계약: `HostConnection.controlDir` 또는 `OwnHost.controlDir`, 12장 Q41).
      - 원격 기기(05 게이트웨이, 모바일): 게이트웨이 설정이나 `own.remote`의 상태 응답(예: `gateway.status`)이 `/srv/local`의 `controlDir`을 준다(05 §13.4와 맞출 계약, Q41).
      - 위 셋 중 아무것도 없을 때만: **이미 열려 있는 프로젝트 location**(own-web이 세션 목록에서 아는 directory)으로 `health`를 불러 `controlDir`을 받는다. 임의의 directory(홈, 탐색 중인 폴더 등)로 `health`를 부르지 않는다. 그 호출 자체가 G15가 막으려는 무거운 Location을 만든다.
  - **세션 메서드**(`session.binding`, `cache.*`, `switch.*`, `ledger.session`, `compaction.setSession`, `session.presence`, `session.approval.*`, T1의 `session.preset.*`·`session.ultra.set`, 4.8의 `session.speed.*`)는 **그 세션의 directory**로 부른다. 그 세션의 hook, 타이머, 이벤트가 그 location 인스턴스에 있기 때문이다.
    - 세션이 이동하면(`session.moved`, 5.4) 클라이언트는 그 뒤의 세션 메서드를 새 directory로 보낸다. 옛 directory로 온 호출은 own-accounts가 새 location으로 넘긴 상태를 모르므로 결과가 낡을 수 있다.
  - 03 §16.3도 전역 조회를 control location으로 보낸다.
  - RPC는 플러그인 활성화를 기다린다(`server/src/handlers/rpc.ts:9-14`). 같은 id가 여러 번 등록되면 마지막 등록이 받는다(`core/src/rpc.ts:111`).
- **이벤트 발행과 중복 제거**
  - 모든 이벤트에 `eventId`(ULID)와 `origin: "global" | "session"`을 붙인다.
  - 전역 이벤트(`quota.updated`, `account.status`, `plugin.status`, `plugin.trust.changed`, `accounts.changed`, `presets.changed`)는 own-accounts의 **프로세스 leader 인스턴스만** 보낸다. control location 인스턴스가 있으면 그것이 leader다.
  - 세션 이벤트는 그 세션 location의 own-accounts 인스턴스가 보낸다. UI는 `eventId`로 중복을 거른다.
  - 발행자와 데이터 출처는 9.3 표에 있다.
- **보안**
  - 응답에 비밀을 넣지 않는다. 비밀을 받는 메서드는 `accounts.add.key`, `accounts.update{replaceKey}`, `voice.key.set`(3.9), `websearch.key.set`(9.2 SP), `mcp.save`·`mcp.test`(9.2 SM: MCP 서버의 환경 변수·헤더 값과 주소)뿐이다. `mcp.import.apply`는 값을 받지 않고, 같은 서비스가 `mcp.import.scan` 때 읽어 둔 값을 vault에 넣는다.
  - 로그와 ledger는 가림 처리한다.
  - 서버는 loopback 전용이다. 원격 기기는 05의 경로(기기별 pairing 토큰, Tailscale 같은 보안 터널)로만 들어온다. LAN에 평문으로 서비스를 열지 않는다.
- **클라이언트와 셸의 경계**(사용자 결정 D1·D3)
  - 이 문서의 로직(레지스트리, vault, 로그인·가져오기, 주입, 관측, ledger, 전환 상태 머신, 추정기, 압축 기준)은 모두 서비스 안의 own-accounts·own-telemetry·own-runtime에 있다. `own-vault.exe`도 서비스가 띄운다(2.4.5).
  - 데스크톱 셸(own-desktop의 Electron main)은 이 로직을 하나도 갖지 않고 비밀을 보지 않는다([R-desktop] §3 "렌더러는 비밀번호를 모릅니다"). 셸이 대신하는 것은 기기에 묶인 일뿐이다.
    - `accounts.add.chatgpt.start`의 `verificationURL`·`authorizeURL` 열기: own-web이 `host.openExternal`(데스크톱) 또는 새 창(웹)으로 연다
    - `clientAction:{type:"restart-service"}`(8.7): 데스크톱은 `OwnHost.service.restart({force})`(05 §5.6. main이 `own.cmd restart [--force]`를 실행). `serviceControl` capability가 없는 호스트(웹, 모바일)는 `PowerShell에서 own restart를 실행하세요` 안내와 명령 복사 버튼
    - 알림 표시: `switch.suggested`, `alert`, `account.status`를 받은 own-web이 host 알림 capability로 띄운다. `compaction.due`는 서버가 이미 넣은 압축의 알림이다. own-web이 같은 id로 다시 보내도 바뀌는 것이 없다(4.7.4)
  - 모바일(이후)도 같은 own-web 코드(Capacitor/PWA 포장, 05)로 같은 RPC를 부른다. 기기에 묶인 기능은 capability로 끈다.
- **원격 기기의 메서드 범위(scope)**(사용자 결정 D3, 자세한 인증은 05)
  - 원격 기기 토큰은 기기마다 따로 발급하고 취소할 수 있다(05). upstream 세션 토큰에는 범위가 없으므로, 범위는 05의 게이트웨이가 `/api/rpc/own.accounts/<method>` 경로로 강제한다. RPC 핸들러는 호출한 기기를 모른다.
  - 범위표는 `@own/protocol`이 `OwnAccounts.MethodScope`(메서드 이름 → 범위)로 내보낸다. 게이트웨이와 own-web이 같은 표를 쓴다. 새 메서드는 범위 없이 추가할 수 없다(타입으로 강제).
  - **범위 이름은 05 §13.5의 기기 범위를 그대로 쓴다**(`read`, `prompt`, `switch`, `files`, `terminal`, `admin`). `own.accounts` 메서드에 붙는 것은 `read`, `prompt`, `switch`, `admin`이고, 원격에서 절대 부를 수 없는 것은 `local`이다. 값의 타입은 `"read" | "prompt" | "switch" | "admin" | "local"`이다(`prompt`는 T1의 `session.preset.raiseOnce` 하나와 아래 HTTP 동작에 쓴다). **이 표가 05 §13.5와의 계약이다**(12장 Q36).

  | 범위 | 메서드(63개, T1. EXT의 `diagnostics.capture.*` 3개, 속도의 `session.speed.*` 2개와 `speed.offers`, IMPORT의 `estimate.request`, NOTES의 `notes.*` 4개, VOICE의 `voice.*` 4개, 원격 Claude(04 §8.11)의 `plugin.claudeAuth.{remote.ack,remote.set,fastAck}` 3개, 웹 검색 서비스(03 §18.2)의 `websearch.{get,set}` 2개, 아이디어 노트(IDEAS)의 `ideas.*` 3개를 더해 86개. 그 뒤 더한 것까지의 합계는 코드의 범위 표가 기준이다: DF(2026-10-18)의 `conversationFolder.*` 3개와 `folderPicker.*` 2개를 더해 102개, CA(2026-10-19)의 `codexModels.{get,set}` 2개와 SP(2026-10-19)의 `websearch.key.{get,set}` 2개를 더해 106개, SM의 `mcp.*` 9개 등으로 116개, RP(2026-10-26)의 `quota.resetCredits.*` 3개와 SG(2026-10-26)의 `skillset.{view,switch}` 2개를 더해 121개, CAG(2026-10-31)의 `claudeAgent.*` 5개와 그 2단계(2026-11-01)의 `claudeAgent.{session.get,session.set,default.set,folders.list,folders.assign}` 5개를 더해 131개, 3단계(2026-11-01)의 `claudeAgent.pool.set`을 더해 132개, GH(2026-10-31, 16 §7)의 `github.*` 10개를 더해 병합 9회차(MR9)의 판은 142개, IM(2026-11-03, 9.6)의 `image.get`·`image.clear`를 더해 144개, LMT(2026-11-03, 3.3a)의 `accounts.local.detect`를 더해 145개, UPD(2026-11-03, 05 §20)의 `tools.*` 5개를 더해 150개, PP(2026-11-07, 9.2)의 `protectedPaths.*` 5개를 더해 155개. 아래 다섯 줄은 2026-11-01에 코드의 범위 표(`OwnAccounts.MethodScope`)에서 다시 뽑았고, IM이 `read`와 `admin`에 하나씩, LMT가 `local`에 하나, UPD가 `local`에 다섯, PP가 `read`에 둘과 `local`에 셋을 더했다) | 원격 기기 |
  |---|---|---|
  | `read`(44) | `mcp.host.view`, `mcp.hosts.view`, `image.get`, `projectList.get`, `health`, `accounts.list`, `quota.snapshot`, `session.binding`, `cache.state`, `ledger.session`, `accounts.usage`, `switch.state`, `policy.get`, `ratecards.get`, `presets.list`, `presets.suggest`, `session.preset.get`, `session.speed.get`, `speed.offers`, `session.approval.get`, `plugin.claudeAuth.status`, `claudeAgent.status`, `claudeAgent.limits.refresh`, `claudeAgent.session.get`, `claudeAgent.folders.list`, `plugin.claudeAuth.session.get`, `plugin.trust.list`, `worktree.inspect`, `estimate.request`, `notes.list`, `notes.get`, `ideas.list`, `voice.get`, `websearch.get`, `conversationFolder.get`, `folderPicker.get`, `codexModels.get`, `mcp.summary`, `session.presence`, `skillset.view`, `websearch.key.get`, `github.view`, `protectedPaths.get`, `protectedPaths.patterns` | `read` 범위 기기(휴대폰 기본) |
  | `prompt`(10) | `session.preset.raiseOnce`, `notes.put`, `notes.remove`, `ideas.put`, `ideas.remove`, `voice.transcribe`, `conversationFolder.ensure`, `folderPicker.list`, `folderPicker.create`, `projectList.set` | `prompt` 범위 기기 |
  | `switch`(17) | `switch.estimate`, `switch.apply`, `switch.schedule`, `switch.cancel`, `switch.undo`, `switch.waitReset`, `switch.setConfirmOverride`, `cache.setTtlMode`, `compaction.setSession`, `session.preset.apply`, `session.ultra.set`, `session.preset.consent`, `session.speed.set`, `plugin.claudeAuth.session.set`, `plugin.claudeAuth.default.set`, `claudeAgent.session.set`, `claudeAgent.default.set` | `switch` 범위 기기(휴대폰 기본) |
  | `admin`(19) | `image.clear`, `accounts.test`, `quota.resetCredits.list`, `policy.set`, `claudeAgent.pool.set`, `ratecards.set`, `presets.set`, `presets.remove`, `presets.defaults.set`, `diagnostics.selfTest`, `session.approval.set`, `voice.set`, `websearch.set`, `conversationFolder.set`, `folderPicker.set`, `codexModels.set`, `skillset.switch`, `mcp.enable`, `github.bind` | `admin` 범위 기기(기기에는 주지 않기를 권장, 05 §13.5) |
  | `local`(79) | `mcp.host.{probe,save,remove,test,prefetch}`, `mcp.hosts.{send,unsend}`(MH), `tools.{view,settings.set,update.plan,update.execute,update.status}`(UPD, 05 §20), `accounts.add.key`, `accounts.local.detect`, `quota.resetCredits.redeem.plan`, `quota.resetCredits.redeem.execute`, `accounts.add.chatgpt.{start,status,complete,cancel}`, `accounts.import.codex.{list,plan,execute}`, `accounts.import.keys.{list,plan,execute}`, `accounts.update`, `accounts.remove.{plan,execute}`, `plugin.claudeAuth.{ack,importSubscription}`, `plugin.claudeAuth.{install,uninstall,changeSource,patch}.{plan,execute}`, `plugin.claudeAuth.{remote.ack,remote.set,fastAck}`, `plugin.claudeAuth.accounts.add.{plan,execute,status}`, `plugin.claudeAuth.accounts.detect`, `plugin.claudeAuth.accounts.remove.{plan,execute}`, `claudeAgent.{setup,login,remove,folders.assign}`, `plugin.trust.approve.{plan,execute}`, `plugin.trust.revoke`, `diagnostics.capture.{start,stop,status}`, `voice.key.set`, `websearch.key.set`, `mcp.{list,save,remove,test}`, `mcp.import.{scan,apply}`, `mcp.registry.search`, `github.add.token`, `github.device.{start,status,cancel}`, `github.update`, `github.remove`, `github.settings.set`, `github.test`, `protectedPaths.{add,remove,suggest}`, `codexModels.rows`(10 §6.14, 같은 프로세스의 own-harness) | 절대 안 됨. PC의 데스크톱·웹 클라이언트(loopback)만 |

  - **Claude Agent(CAG, 8.10.8)**: `claudeAgent.status`·`limits.refresh`(읽기와 사용량 질문, 모델 호출 없음)·`session.get`·`folders.list`는 `read`, 대화의 계정을 옮기는 `session.set`과 새 대화의 기본 `default.set`은 Claude 슬롯의 `plugin.claudeAuth.session.set`·`default.set`처럼 `switch`, 이 PC의 로그인 폴더를 만들고 지우고 옮기는 `setup`·`login`·`remove`·`folders.assign`은 `local`이다. 3단계의 프로세스 상한 `pool.set`은 전환 정책(`policy.set`)과 같은 설정이라 `admin`이다.
  - **GitHub(GH, 16 §7)**: 이름·로그인·폴더만 보는 `github.view`는 `read`(토큰은 없다), 계정 선택 `github.bind`는 MCP 목록 스위치처럼 `admin`, 토큰·쓰기 허용·own이 시작하는 프로그램을 다루는 나머지 8개는 `local`이다. 모두 위치 `control`이고 원격 서비스는 `remote_managed`다.
  - **외부 도구 업데이트(UPD, 05 §20)**: `tools.*` 5개는 모두 `local`이다. 보기(`tools.view`)도 이 PC의 프로그램 경로를 담고, 업데이트는 이 PC에서 프로그램을 실행하기 때문이다. 위치 `control`, 원격 서비스는 `remote_managed`다. 오류 `tool_not_updatable{component, reason: manual|missing}`, `tool_busy{id}`, `tool_job_not_found{id}`(9.4).
  - **`switch.estimate`는 `read`가 아니다.** 부작용이 있다: 세션을 PLANNED로 두고(5.4) 대상 계정의 비밀을 메모리 캐시에 미리 채운다(2.4.5). 05 §13.5 표는 이것을 `read`에 두므로 05가 `switch`로 옮긴다.
  - **음성 입력(VOICE, 3.9)**: `voice.transcribe`는 사용자의 유료 API 시간을 쓰므로 프롬프트를 보내는 일과 같은 `prompt`다. `voice.get`은 켜짐·서비스·키가 있는지(키는 아님)·분을 보는 조회라 `read`, `voice.set`은 전환 정책처럼 `admin`, 키를 받는 `voice.key.set`은 `local`이다. 게이트웨이는 `/srv/<hostId>`의 `voice.*`를 모두 막고, `voice.transcribe` 하나만 녹음 크기만큼 본문을 읽는다(05 §13.4).
  - **`estimate.request`(IMPORT, 09 §5.6)는 `read`다.** 아직 어느 세션도 돌지 않는 slot에서 요청 몇 개의 값을 매기기만 한다: PLANNED 상태도, 비밀 미리 읽기도 없다(9.2).
  - `switch.setConfirmOverride`, `cache.setTtlMode`, `compaction.setSession`은 세션의 전환·캐시 동작을 바꾸므로 `switch`다. 05 §13.5의 `switch` 목록(`switch.apply/schedule/cancel/undo/waitReset`)에 이 넷(`estimate` 포함)을 더한다.
  - **리셋권(RP, 7.1.1)**: `quota.resetCredits.list`는 계정의 로그인으로 ChatGPT에 묻는 점검이라 `accounts.test`처럼 `admin`이다. `redeem.plan`·`redeem.execute`는 리셋권을 되돌릴 수 없게 쓰므로 `local`이다: 이 PC의 창(데스크톱, loopback 웹)만 쓰고, 휴대폰과 다른 PC는 수만 본다(own-web은 `리셋권은 이 PC 화면에서만 쓸 수 있어요`를 보인다). 셋 다 control location이고 원격 서비스는 `remote_managed`다.
  - **`accounts.*` 쓰기와 `plugin.*` 쓰기는 모두 `local`이다.** 05 §13.4의 게이트웨이가 이것들을 어떤 범위로도 막기 때문이다(항상 막는 경로). 그래서 `accounts.update`에 `replaceKey`가 있는지 본문을 검사할 필요가 없다(이전 판의 ⚠ 해소). `accounts.test`만 쓰기가 아닌 점검이라 `admin`이다.
  - `plugin.claudeAuth.status`와 `plugin.trust.list`는 조회라 `read`다. 05 §13.4의 항상 막는 목록이 `plugin.*` 전체라서 지금은 원격에서 막힌다. 더 좁은 쪽이 이기므로 안전하다. 05가 그 목록을 `plugin.*` 쓰기로 좁히면 열린다(Q36).
  - `session.approval.set`은 기본이 `admin`이다. **입력이 `{sessionID, mode}`뿐이면(`ask`, `read-only`, `full` 모두) `prompt`다**(MUX 2026-11-06, Q36의 답, `OwnAccounts.scopeOf`). 그래서 휴대폰에서 만든 대화도 PC처럼 새 대화 화면의 모드로 시작하고, 휴대폰의 승인 모드 메뉴에서 세 모드를 다 고를 수 있다. `전체 허용`은 PC와 같은 확인(`전체 허용으로 바꾸기`)을 거친다. 사용자 결정(MUX-15): 처음에는 `전체 허용`만 PC 전용으로 두었으나, 사용자가 휴대폰에서도 고르게 했다. `browserTool`·`computerUse`가 함께 오면 그대로 `admin`이다(컴퓨터 사용 켜기는 05 §13.4대로 PC에서만). 게이트웨이(own-remote `gateway/policy.ts`)와 own-web(`OwnRpc.allowed(method, input)`)이 같은 함수를 쓴다.
  - **웹 검색 서비스(2026-10-10, 03 §18.2)**: `websearch.get`은 서버가 쓸 검색 서비스(키 아님)를 보는 조회라 `read`다. `websearch.set`은 에이전트의 검색어를 제3자 서비스로 보내게 하므로 `admin`이다(서버 전역 설정이라, 대화 하나의 모드만 고르는 `session.approval.set{sessionID, mode}`의 `prompt`와 다르다). 두 메서드는 control location에서 받는다(전역 설정).
  - `presets.list`, `presets.suggest`, `session.preset.get`(07 §8.1)은 조회라 `read`다. `presets.defaults.set`·`presets.set`·`presets.remove`는 묶음의 모든 계정과 그 프리셋을 쓰는 모든 세션을 바꾸므로 `admin`이다(휴대폰에서도 된다. 계정 RPC `accounts.update`의 `local`은 넓히지 않는다, 07 §8.1).
  - `session.preset.apply`, `session.ultra.set`, `session.preset.consent`(T1)와 `session.speed.set`(4.8)은 한 세션의 일하는 방식을 바꾸므로 `switch`다. `session.speed.set{consent:true}`(Claude 구독 슬롯 Fast의 추가 사용량 동의)도 `session.preset.consent`처럼 `switch`다. `consent`는 그 대화에서만 종량제 계정으로 넘어가는 것을 허락하고 계정 예산을 넘지 못한다(`preset_budget_exhausted`). `session.preset.raiseOnce`는 지금 사용자 메시지가 더 많은 일을 시작하게 하므로 메시지를 보내는 것과 같은 `prompt`다.
  - `worktree.inspect`(06 §10.4 #5)는 프로젝트의 작업 폴더 표에 있고 `git -C <root> worktree list`가 알려 주는 연결 작업 폴더만 읽는 조회라 `read`다(본문, 9.2). 지우기는 upstream `worktree.remove`이고 이 메서드는 아무것도 바꾸지 않는다. 원격 기기의 정리 화면도 같은 막이를 쓰려면 `read`가 필요하다.
  - **워크스페이스 노트(NOTES, 9.2)**: `notes.list`·`notes.get`은 조회라 `read`, `notes.put`·`notes.remove`는 사용자가 쓰는 글이라 메시지를 보내는 것과 같은 `prompt`다. 노트는 모델 입력에 들어가지 않으므로 `switch`·`admin`이 아니다. 그래서 휴대폰 기본 범위로 읽고 쓰고, `read`만 받은 기기의 노트 탭은 읽기 전용이다. 게이트웨이는 새 분기 없이 이 표로 판정하고 `rpc.own.accounts.notes.changed`도 다른 `rpc.own.accounts.*`처럼 통과시킨다(05 §13.4).
  - **아이디어 노트(IDEAS, 9.2)**: 워크스페이스 노트와 같은 까닭으로 `ideas.list`는 `read`, `ideas.put`·`ideas.remove`는 `prompt`다. 모델 입력에 들어가지 않는다. 본문은 아이디어 하나(2,000자)라 다른 RPC와 같은 64 KiB 검사 안에 들어가고, 게이트웨이에 새 분기가 없다. `rpc.own.accounts.ideas.changed`도 그대로 통과한다.
  - **에이전트가 못 여는 파일·폴더(PP, 2026-11-07, 9.2)**: `protectedPaths.get`은 기본 목록과 사용자 목록을 보는 조회라 `read`다(휴대폰과 다른 PC에서도 읽기 전용으로 보인다). `protectedPaths.patterns`는 같은 사실을 패턴으로 주는 조회라 `read`이고 own.harness의 dsh 검색이 프로세스 안에서 부른다. 사용자 목록을 바꾸는 `protectedPaths.add`·`remove`와 홈 폴더의 이름을 보는 `protectedPaths.suggest`는 `항상 허용`처럼 이 PC의 창에서만 하므로 `local`이다. 다섯 다 control location이고, 원격 서비스(SSH 호스트)도 스스로 답한다(`remote_managed`가 아님: 호스트가 자기 홈 폴더에 기본 목록을 놓고 자기 목록을 둔다). 오류 `protected_path_invalid{reason, path}`(`add`만), 이벤트 `protectedPaths.changed{paths}`(global).
  - **기본 대화 폴더와 폴더 열기 시작 위치(DF, 2026-10-18, 9.2)**: `conversationFolder.get`·`folderPicker.get`은 경로를 보는 조회라 `read`다. `conversationFolder.ensure`는 폴더 없이 새 대화를 시작할 때 그 폴더를 만드는 일이라 메시지를 보내는 것과 같은 `prompt`다. `conversationFolder.set`·`folderPicker.set`은 그 서비스의 모든 창과 기기가 따르는 설정이라 `voice.set`처럼 `admin`이다(`admin`이 있는 휴대폰은 경로 입력으로 바꾼다). 다섯 다 control location이고, 원격 서비스(SSH 호스트)도 스스로 답한다(`remote_managed`가 아님: 호스트가 자기 폴더를 정한다). 게이트웨이는 새 분기 없이 이 표로 판정한다.
  - **프로젝트 순서와 고정(SBL, 2026-11-26, 9.2)**: `projectList.get`은 세션 목록처럼 `read`, `projectList.set`은 대화를 고정하는 것(세션 metadata 쓰기)과 같은 `prompt`다. 둘 다 `control`이고 원격 서비스도 스스로 답한다(`remote_managed` 아님).
  - **폴더 열기 창의 목록과 새 폴더(SN, 2026-11-22, 9.2)**: `folderPicker.list`·`folderPicker.create`는 대화할 폴더를 열기까지의 단계라 `conversationFolder.ensure`와 같은 `prompt`다. `read`가 아닌 까닭: core의 목록(`/api/fs/list`)은 기기 범위 `files`가 있어야 하고(05 §13.5), `create`는 그 컴퓨터에 쓰는 일이다. 휴대폰과 다른 PC는 폴더 열기 창이 있는 곳에서 같은 범위로 쓴다. 둘 다 `control`이고 원격 서비스도 스스로 답한다(`remote_managed` 아님).
  - **Codex 모델 목록 버전(CA, 2026-10-19, 9.2)**: `codexModels.get`은 묻는 Codex 버전과 own이 뺀 행 수를 보는 조회라 `read`다(계정 정보 없음). `codexModels.set`은 모든 ChatGPT 계정의 목록과 그 모델의 창을 바꾸는 서비스 설정이라 `voice.set`처럼 `admin`이다. 둘 다 control location이고, 원격 서비스는 목록을 받지 않으므로 `remote_managed`다.
  - **`prompt` 범위가 필요한 동작**: `clientAction`(`fork`, `create-session`)의 HTTP 실행, 5.9(f)의 `generate`·`prompt`. 이것들은 `own.accounts` 메서드가 아니라 upstream HTTP라 05 §13.5의 `prompt` 범위("압축·포크")가 막는다. 그래서 `switch`만 있고 `prompt`가 없는 기기의 own-web은 `clientAction`이 필요한 전략(`fork`, `new-session`)을 숨긴다. 2026-10-08부터 압축(`compaction.due`, `compact-then-switch`, `switch-then-compact`)은 서버가 `ctx.session.compact`로 넣으므로 `switch` 범위로도 일어난다(4.7.2 "범위"). own-web은 아직 두 압축 전략도 숨긴다(후속).
  - `local`인 이유: 비밀을 받거나(키, 로그인), 로컬 파일 경로를 읽거나(가져오기, 신뢰 승인), 프로세스 안에 코드를 설치하거나(claude-auth), 계정 레지스트리를 바꾼다. `accounts.add.chatgpt.*`의 device code는 원격 기기에서도 기술적으로 가능하지만 05가 열기 전까지는 `local`이다.
  - 이벤트는 모두 `read` 범위다. 비밀이 없고 이메일은 마스킹되어 있다. `alert.directory` 같은 로컬 경로가 원격 기기에 보이는 것은 05에서 다시 본다.
  - 원격 기기가 원격(SSH) 세션을 보고 조작하는 경로는 PC 서비스를 거친다(04 §12.6의 서버 레지스트리를 PC가 대신 가짐, 05). 같은 범위표를 `own.remote`에도 둘지는 04·05가 정한다.
  - 푸시(이후): 전송은 05 §13.6을 따른다. PWA는 Web Push(VAPID, 우리 중계 없음, M2)가 먼저이고, 네이티브 앱의 FCM/APNs 중계는 M3다. 원본은 05의 알림 피드다. 이 문서가 정하는 것은 피드 후보 이벤트뿐이다: `switch.suggested`, `switch.state`(BLOCKED·FAILED), `account.status`(`exhausted`·`needs_reauth`·`auth_failed`), `alert`(severity ≥ warning). 05 §13.6의 피드 `kind`(`quota.exhausted`, `auth.expired`, `switch.suggested`, `claude_slot_billing` …)로 바꾸는 일은 own-remote가 한다.
- **재동기화**: `server.connected`를 받을 때마다 다음을 다시 부른다(03 §8).
  - `accounts.list`
  - `quota.snapshot`
  - 보이는 세션의 `session.binding`
  - 열린 세션의 `cache.state`(압축 기준 포함)와 `switch.state`
- **성능 계약**(사용자 결정 D4. 프런트엔드 예산은 03)
  - own 이벤트는 토큰 스트리밍과 무관하다. 가장 잦은 것이 step마다 한 번(`cache.state`, `ledger.step`, `compaction.due`)이고, `quota.updated`는 계정당 5초에 한 번 이하다(7.4). 그래서 스트리밍 중 입력·스크롤을 막을 own 이벤트는 없다.
  - `accounts.list`는 `revision`을 준다. own-web은 마지막 결과를 로컬에 두고 먼저 그린 뒤(세션 목록 1초 예산), `accounts.changed{revision}`이나 재동기화로 다시 확인한다. `session.binding`은 한 번에 500개까지 묶어 부른다(`rpc.ts:363`).
  - hook의 hot path는 대부분 메모리만 읽는다(2.4.5). 예외와 실제 비용:
    - generate·title usage 읽기(7.5)는 요청 경로 밖(백그라운드)에서 돈다.
    - linked 가져오기 계정(3.2a)의 원본 확인은 요청 경로 **안**에서 돈다: 계정마다 비동기 `fs.stat` 최대 1초에 한 번, mtime·크기·TTL·401 조건일 때만 1 MiB 이하 재읽기(`packages/own-runtime/src/credentials.ts:384-399`, `codex-source.ts:343-371`). 모델 요청 준비만 기다리게 하고 UI·스트리밍과는 무관하다. 성능 게이트에서 문제가 되면 백그라운드 갱신기로 옮긴다(3.2a, Q40).
    - 비밀 캐시 미스 때의 helper IPC(2.4.5).

### 9.2 메서드

이 절이 RPC id `own.accounts`의 **유일한 메서드 목록**이다(01 §15). 03 §16.3은 이 목록을 쓴다. 아래는 입력과 출력의 JSON이다.
- 메서드는 55개다: 구현된 46개(`packages/own-protocol/src/rpc.ts:347-668`, `accounts.import.codex.*` 3개 포함), v0.3에서 더한 `compaction.setSession`, v0.4에서 더한 `session.approval.get`·`session.approval.set`(03 §18.8의 요청), 2026-09-28에 더한 `accounts.import.keys.{list,plan,execute}`(3.2b), T0(2026-10-01)에 더한 `presets.list`·`presets.defaults.set`(07 §8.1의 T0 부분)과 `worktree.inspect`(06 §10.4 #5). 이벤트는 16개다(구현된 13개, `compaction.due`, `approval.changed`, T0의 `presets.changed`, 9.3). 범위는 9.1 표다.
- **T1(2026-10-02)에 더한 8개**: 07 §8.1의 `presets.suggest`, `presets.set`, `presets.remove`, `session.preset.get`, `session.preset.apply`, `session.ultra.set`, `session.preset.raiseOnce`와 스펙에 더한 `session.preset.consent`(07 §5.4 4단계의 카드가 부름). 그래서 메서드는 **63개**, 이벤트는 `session.preset.changed`를 더해 **17개**다. `switch.estimate`·`switch.apply`에 `teamOp?`·`children?`, `switch.schedule`에 오류 `team_switch_required`, `Estimate.Result`에 `busyChildren`이 붙었다(5.11 6·7번).
- EXT(2026-10-05)의 `diagnostics.capture.{start,stop,status}` 3개(7.8)와 속도(4.8)의 `session.speed.{get,set}` 2개로 68개, **IMPORT(2026-10-08, 09 §5.6)의 `estimate.request`로 69개**다. 이벤트는 속도의 `session.speed.changed`를 더해 18개이고 IMPORT는 이벤트를 더하지 않았다. 범위는 `read` 19, `prompt` 1, `switch` 13, `admin` 8, `local` 28이다(9.1 표).
- **NOTES(2026-10-09)의 `notes.{list,get,put,remove}` 4개로 73개**, 이벤트는 `notes.changed`를 더해 **19개**다(아래 "워크스페이스 노트"). 범위는 `read` 21, `prompt` 3, `switch` 13, `admin` 8, `local` 28이었다.
- **VOICE(2026-10-09, 3.9)의 `voice.get`·`voice.set`·`voice.key.set`·`voice.transcribe`로 77개**다. 이벤트는 더하지 않았다(설정을 바꾼 창은 결과를 바로 쓰고, 다른 창은 다음 `voice.get`에서 본다). 범위는 `read` 22, `prompt` 4, `switch` 13, `admin` 9, `local` 29다(9.1 표).
- **IDEAS(2026-10-11)의 `ideas.list`·`ideas.put`·`ideas.remove` 3개**(범위 `read` 1·`prompt` 2, 위치 `control`)와 이벤트 `ideas.changed`를 더했다(아래 "아이디어 노트"). 코드의 합계는 `packages/own-protocol/test/rpc.test.ts`의 범위 표가 기준이다(이 판에서 메서드 97개).
- **DF(2026-10-18)의 `conversationFolder.get`·`set`·`ensure`와 `folderPicker.get`·`set` 5개**(범위 `read` 2·`prompt` 1·`admin` 2, 위치 `control`)와 이벤트 `conversationFolder.changed`·`folderPicker.changed`를 더해 메서드 102개다(아래 "기본 대화 폴더").
- **CA(2026-10-19, 07 §4.5)의 `codexModels.get`·`codexModels.set` 2개**(범위 `read` 1·`admin` 1, 위치 `control`, 원격 서비스는 `remote_managed`)와 이벤트 `codexModels.changed`를 더해 메서드 104개다(아래 "Codex 모델 목록").
- **SP(2026-10-19)의 `websearch.key.get`·`websearch.key.set` 2개**(범위 `read` 1·`local` 1, 위치 `control`, 원격 서비스는 `remote_managed`)를 더해 병합한 판의 메서드는 106개다. 범위는 `read` 30, `switch` 15, `admin` 13, `local` 41, `prompt` 7이다(코드의 범위 표). MS(같은 날)는 메서드를 더하지 않고 `websearch.get/set`의 모양만 넓혔다.
- **CC-14(2026-10-24)의 `session.presence` 1개**(범위 `read`, 위치 `session`)로 메서드는 107개, 범위는 `read` 31이다(아래 "정책과 기타").
- **SM(2026-10-24, 03 §18.14)의 `mcp.list`·`mcp.summary`·`mcp.save`·`mcp.remove`·`mcp.enable`·`mcp.test`·`mcp.import.scan`·`mcp.import.apply`·`mcp.registry.search` 9개**(범위 `read` 1·`admin` 1·`local` 7, 위치 `control`, 원격 서비스는 `remote_managed`)와 이벤트 `mcp.changed`로 메서드는 116개, 범위는 `read` 32, `switch` 15, `admin` 14, `local` 48, `prompt` 7이다(아래 "MCP 서버").
- **SG(2026-10-26, 03 §19.6.1)의 `skillset.view`(`read`: 스킬 id·이름·폴더를 보는 조회, 스킬 목록과 같다)·`skillset.switch`(`admin`: 한 프로젝트나 모든 프로젝트에서 스킬을 켜고 끄기, MCP 목록 스위치와 같다)**(위치 `control`, 원격 서비스는 `remote_managed`)와 이벤트 `skillset.changed`로 메서드는 118개, 범위는 `read` 33, `switch` 15, `admin` 15, `local` 48, `prompt` 7이다(아래 "스킬 스위치와 쓰는 곳"). rpcHash는 그대로다(own RPC는 데스크톱 IPC 해시에 들지 않는다).
- **RP(2026-10-26, 7.1.1)의 `quota.resetCredits.list`(`admin`: 계정의 로그인으로 ChatGPT에 묻는 점검, `accounts.test`와 같다)·`quota.resetCredits.redeem.plan`·`quota.resetCredits.redeem.execute`(`local`: 리셋권을 되돌릴 수 없게 쓴다) 3개**(위치 `control`, 원격 서비스는 `remote_managed`)는 이벤트를 더하지 않았다(`quota.snapshot`·`quota.updated`의 `resetCredits`, 9.2·9.3). 병합 7회차(MR7, 2026-10-27)에서 SG와 합친 판의 메서드는 121개, 범위는 `read` 33, `switch` 15, `admin` 16, `local` 50, `prompt` 7이다(코드의 범위 표, `packages/own-protocol/test/rpc.test.ts`).
- 원격 Claude(2026-10-09, 04 §8.11)의 `plugin.claudeAuth.{remote.ack,remote.set,fastAck}` 3개(범위 `local`, 위치 `control`)로 **80개**다. 이벤트는 더하지 않았다. 범위는 `read` 22, `prompt` 4, `switch` 13, `admin` 9, `local` 32다(9.1 표).
- **SN(2026-11-22, 03 §18.3)의 `folderPicker.list`·`folderPicker.create` 2개**(범위 `prompt` 2, 위치 `control`, 원격 서비스도 답함)를 더해 메서드는 159개, 범위는 `read` 42·`switch` 17·`admin` 19·`local` 72·`prompt` 9다(`packages/own-protocol/test/rpc.test.ts`). 이벤트는 더하지 않았다.
- 이번 판의 스키마 변경 목록은 9.5에 모았다. 구현자는 그 목록대로 `@own/protocol`을 고친다.

**조회**

`health` `{}` →
```json
{ "version":"2.0.18-own.1","buildId":"b7e2c91a","pluginVersions":{"accounts":"0.1.0","telemetry":"0.1.0"},
  "vaultBackend":{"name":"own-vault","version":"0.1.0"},"vault":"ok",
  "guard":"ok","registryRevision":42,"controlDir":"C:\\Users\\…\\AppData\\Local\\own-open-code\\control",
  "locations":[{"directory":"D:\\work\\repo","allowlist":"ok"},{"directory":"D:\\tmp\\cloned","allowlist":"blocked_by_plugin"}],
  "sizes":{"kv":1048576,"ledger":5242880,"db":73400320},"warnings":[] }
```
- 필드는 01 §14.5를 따른다: fork 버전(`version`), 빌드 id(`buildId`, runtime 싱글턴 키와 같은 값, 2.3), 플러그인·vault 백엔드 버전, 가드 상태(`guard: "ok"|"skew"|"unmanaged"`), vault 접근 가능 여부(`vault: "ok"|"unavailable"`), 레지스트리 revision, Location별 플러그인 allowlist 상태(`allowlist: "ok"|"blocked_by_plugin"`, 4.2), KV·ledger·DB 크기. DB 크기가 임계값을 넘으면 `warnings`에 넣는다.
- `health`는 가드 1이 실패해도 등록되는 유일한 메서드다(01 §5.4). 이때 `guard`만 믿을 수 있고 나머지 필드는 비어 있을 수 있다.
- 원격 모드 필드(`mode:"local"|"remote"`, `broker`, `mirror`)는 04 §16.5가 정한다.

`accounts.list` `{}` →
```json
{ "revision": 42,
  "accounts": [
    { "id":"acc_01JAX3…","kind":"codex","label":"업무","shortLabel":"업","color":"violet",
      "providerID":"own-codex-7k2m","billing":"subscription","status":"ready","autoSwitch":false,
      "thirdParty":false,"readOnly":false,
      "identity":{"emailMasked":"na***@gmail.com","plan":"plus"},
      "connection":{"type":"oauth","method":"chatgpt-device"},
      "cacheDomain":{"id":"cd_7k2m","sharedWith":[]},"quotaDomain":{"id":"qd_7k2m","sharedWith":[]},
      "limitsSummary":{"worst":{"id":"codex.primary","label":"5시간","usedPercent":42,"resetAt":1790003000000,"status":"ok"}},
      "sessions":{"running":1,"total":7},
      "lastUsedAt":1790001200000 },
    { "id":"acc_claude_slot","kind":"claude-sub","label":"Claude Max · na***@…","shortLabel":"C","color":"orange",
      "providerID":"anthropic","billing":"subscription","status":"ready","autoSwitch":false,
      "thirdParty":true,"readOnly":true,
      "connection":{"type":"oauth","method":"claude-code","label":"Claude Max · na***@…"},
      "plugin":{"installed":true,"acknowledged":true,"version":"0.4.0-beta.5"},
      "limitsSummary":{"worst":{"id":"claude.5h","label":"5시간","usedPercent":61,"resetAt":1790004000000,"status":"ok"}},
      "sessions":{"running":0,"total":2},
      "lastUsedAt":1789990000000 }
  ] }
```
- **Claude 슬롯 합성 계정**: 앱에 번들이 있거나 claude-auth가 감지되면 `accounts[]`에 `acc_claude_slot`이 들어간다(2026-10-18부터 운영 빌드에서는 늘). 둘 다 없으면 빠진다.
  - `connection.type`: `"oauth"`(claude-code) | `"key"` | `"env"` | `"none"`. 03 §5.4.1(d)의 연결 유형 표시(`구독(claude-code)` / `API 키` / `환경 변수`)가 이 값이다. `key`나 `env`면 경보 `claude_slot_billing`도 함께 낸다(8.9).
  - `status`: 앱의 번들로 확인되지 않음 `"unverified"`(2026-10-18 전에는 동의 전), 연결 없음 `"needs_reauth"`, unified `rejected` `"exhausted"`, 그 밖 `"ready"`.
  - `readOnly:true`: 라벨·색·약칭만 `accounts.update`로 바꿀 수 있다. 키 교체, 자동 전환, 제거는 없다. 플러그인은 앱과 함께 있고 제거하지 않는다(8.2 9번).
- `lastUsedAt`: 마지막 step 시각(epoch ms). 03 사이드바의 "사용 중 계정 (최근 24시간)"이 이것으로 거른다.
- `pollBalance`: ds·or·xai 계정에만 `true|false`로 들어간다(잔액·키 조회, 7.2). 03 계정 `⋯` 메뉴의 "잔액·키 조회 끄기"가 이 값을 보인다.
- **가져온 codex 계정**(3.2a): `connection`이 `{"type":"oauth","method":"codex-linked"|"codex-takeover","source":{"app":"codex-multi-provider","profileID":"02","alias":"개인","mode":"linked"|"takeover","superseded":false|true}}`다(`packages/own-protocol/src/account.ts` Connection). stale이면 `status:"auth_failed"`이고 `account.status{reason:"codex_source_stale"}`가 따로 온다.
- **이전 앱 API 키를 연결한 계정**(3.2b): `connection`이 `{"type":"key","method":"legacy-key-linked","legacyKey":{"app":"codex-multi-provider","providerRef":"legacy:deepseek","name":"DeepSeek"}}`다. 파일 경로와 키는 없다. 키 파일 문제면 `status:"misconfigured"`(reason = `OwnError.LegacyKeyProblem`), 공급자가 키를 거부하면 `auth_failed`(reason `legacy_key_rejected`).
- **`compaction`**(4.7, 이번 판에서 추가): 계정마다 `{"setting": {…}|null, "effective":[{"modelID":"deepseek-v4-pro","windowTokens":1000000,"triggerTokens":256000,"source":"kind"}]}`. `setting`은 계정에 저장된 값(2.4.1), `effective`는 해석 결과(4.7.4)다. `acc_claude_slot`은 `setting:null`이고 `effective`의 `source`는 항상 `"v2"`다.
- **T2(07 §4.4, 선택 필드)**: `templateUpdate: {detectedAt, fields}` = 그 계정 템플릿의 고정 필드 변경이 `refreshCatalog`를 기다림(3.6a 5번, 03 §5.4 `템플릿 갱신 있음`). `models: [{id, addedAt?, upstream?: "missing"}]` = 표시가 붙은 템플릿 모델만(뒤에 더해짐 → 03 §5.2 `새` 표시, 카탈로그에서 사라짐 → 수리 알림). 없으면 표시가 없다.

`quota.snapshot` `{accountIDs?: string[]}` → `{windows: LimitWindow[], exhausted?: {accountID, reason, until}[], resetCredits?: ResetCredits[]}`. `resetCredits`는 ChatGPT 구독 계정마다 마지막 리셋권 수다(7.1.1, RP. 옛 서비스는 보내지 않는다). `windows`는 저장소의 창이고, 월 예산 창은 답하기 전에 다시 계산한다(7.4). `exhausted`는 지금 걸려 있는 계정 전체 소진이고(모델별 주간 묶음의 기록은 없다, 5.2) `reason`은 그 소진의 `account.status`와 같다(9.3). 재동기화가 놓친 `ready`나 서비스 재시작을 메운다(3.2c). 이 필드보다 오래된 서비스는 보내지 않는다.

**리셋권(RP 2026-10-26, 7.1.1)**: 셋 다 control location, `codex` 계정만. 다른 kind는 업스트림 요청 없이 `not_supported{kind}`, 쓸 수 없는 로그인은 `credential_not_ready{accountID, cause}`, 원격 서비스는 `remote_managed`.
- `quota.resetCredits.list` `{accountID}` → `{resetCredits: ResetCredits}`. 목록과 `wham/usage`를 읽는다(각 10초, 계정마다 최소 2분 간격, 그 안에는 마지막 답. 그 뒤 `/consume`을 보냈으면 답이 없었어도 다시 읽는다). 읽은 창도 올린다. 둘 다 실패하면 `limit_reset_failed{reason, status?, retryable:true}`.
- `quota.resetCredits.redeem.plan` `{accountID, creditID?}` → `{nonce, expiresAt, account:{id, label}, credit?:{id, title?, expiresAt?}, windows: LimitWindow[]}`. 요청을 보내지 않는다. nonce(10분)가 `redeem_request_id` 하나를 정한다.
- `quota.resetCredits.redeem.execute` `{nonce}` → `{outcome: "reset"|"nothing_to_reset"|"no_credit"|"already_redeemed", windowsReset?, resetCredits?, windows?}`. 네 답은 nonce를 쓰고, 답이 없으면 `limit_reset_failed`(nonce 남음, 재시도는 같은 id). `resetCredits`는 쓴 뒤 다시 읽은 수가 있을 때만 싣고, `reset`·`already_redeemed`에 없으면 수를 모르는 것이다(7.1.1). 오류: `nonce_invalid`, `account_not_found`, `not_supported`, `credential_not_ready`, `limit_reset_failed`, `remote_managed`.

`session.binding` `{sessionIDs: string[]}` →
```json
{ "bindings": [
  { "sessionID":"ses_…","model":{"providerID":"own-codex-7k2m","id":"gpt-5.5","variant":"high"},
    "accountID":"acc_01JAX3…","builtin":false,"thirdParty":false,"home":"own-codex-7k2m",
    "switch":{"state":"STEADY"} },
  { "sessionID":"ses_…","model":{"providerID":"anthropic","id":"claude-opus-5-5"},
    "accountID":"acc_claude_slot","builtin":false,"thirdParty":true,"home":"anthropic",
    "switch":{"state":"STEADY"} } ] }
```
- `builtin:true`는 세션이 전역 credential을 쓰는 내장 provider(`openai`, `deepseek` 등)에 묶여 있다는 뜻이다. UI는 경고를 띄운다. `anthropic`은 합성 계정으로 돌려주므로 `builtin:false, thirdParty:true`다.
- `accountID`가 `null`이면 모르는 provider다(외부 전환 등).

`cache.state` `{sessionID}` →
```json
{ "sessionID":"ses_…","now":1790001300000,
  "slots":[{ "providerID":"own-codex-7k2m","state":"warm","L":150000,"lastReqAt":1790001200000,
             "warmUntil":1790001500000,"coldAfter":null,"epoch":1,"blocksSince":0,"ttlMode":"5m" },
           { "providerID":"own-anth-w3p8","state":"cold","L":98000,"lastReqAt":1789990000000 }],
  "compaction":{ "providerID":"own-codex-7k2m","modelID":"gpt-5.5",
                 "windowTokens":272000,"triggerTokens":244800,"slotTriggerTokens":244800,"source":"v2",
                 "sessionTriggerTokens":null,"floorTokens":63000,"keepTokens":15000,"auto":true,
                 "P":153000,"remainingTokens":91800,
                 "cycle":{"Z":12000,"delta":3000,"summary":8000},
                 "pendingDue":null } }
```
`state` 판정
- `warm`: `age < TTL_lo`
- `cooling`: `TTL_lo ≤ age < TTL_hi`
- `cold`: `age ≥ TTL_hi`, 또는 epoch·model·variant 변경
- `unknown`: `TTL_hi`를 모르고 `age ≥ TTL_lo`

slot의 `accountID`(선택, SL 2026-10-26): 그 slot의 마지막 요청에 서명한 계정(ledger 줄의 것, KV `sess:<sid>:cache:<pid>`의 `accountID`). 여러 Claude 계정이 `anthropic` slot 하나를 함께 쓰고, 회사의 캐시는 한 계정(조직)의 것이다. 그래서 클라이언트는 이 상태를 그 계정에만 보인다: 대화의 캐시 배지(헤더, `이 대화` 카드, 되돌리기·포크·전환 창)는 대화가 묶인 계정(`session.binding`의 `accountID`)이 이 계정일 때만, 전환기의 계정 줄은 그 줄의 계정일 때만 이 상태를 쓰고, 아니면 차가움이다. 2026-10-26 전에는 AC-03으로 쓴 캐시가 AC-01·AC-02 줄에도 `캐시 n분 남음`으로 보였다. SL-8(2026-10-27)부터 서버의 판정도 계정 단위다: Claude 계정마다 항목이 따로라(2.4.6) `slots`에 `anthropic`이 계정마다 한 번씩 나오고(최근 것부터), 클라이언트는 그 계정의 slot을 고르고 계정이 없는 slot(그 전의 항목)만 대신 쓴다(`slotOf`). 대화가 지금 그 계정에 있을 때만 그 slot에 현재 모델을 맞춰 본다(다른 계정의 slot은 다른 slot처럼 나이로만 판정). 그 계정은 트리의 binding에서 읽는다(SL-17: 재시작 뒤 플러그인의 동기 조회는 기본 계정을 답해, 기본 계정의 slot에 현재 모델을 맞춰 봤다). 압축 요청 모양(4.7.5)과 전환 추정(8.7)도 서명한 계정으로 판정한다.

`compaction` 필드(4.7, 이번 판에서 추가. 메서드와 `cache.state` 이벤트에 모두 들어간다)
- 세션의 **현재** 모델 기준이다. model이 없는 세션(01 §8.5)이면 `null`이다.
- `windowTokens`: 템플릿의 원래 창. 문맥 막대의 분모다. 등록 모델의 `limit.input`(`ctx_eff`)을 쓰지 않는다.
- `triggerTokens`: 실효 기준 `T`(세션 값 포함). 문맥 막대의 기준 표시 위치다. `slotTriggerTokens`와 `source`(`v2|kind|kindModel|account|accountModel|session`)로 출처를 보인다.
- `floorTokens`: 세션 값의 하한(`T_floor`). `compaction.setSession`의 입력 범위는 `[floorTokens, slotTriggerTokens)`다.
- `keepTokens`, `auto`: own 전역 설정 파일에서 읽은 core 값(`compaction.keep.tokens`, `compaction.auto`). 사용자가 4.7.6 (가)로 keep을 바꿨으면 그 값이다. 읽지 못하면 `null`이다(프로젝트 설정은 모름, 4.7.2). `floorTokens`도 이 `keepTokens`로 계산한다.
- `P`, `remainingTokens = triggerTokens − P`: 마지막 step 기준(4.7.4). step이 없으면 `null`이다.
- `cycle`: ⑫ 계산에 쓰는 이 세션의 `Z`, `δ`, `S_sum` 추정(ledger 중앙값). own-web은 이것과 `ratecards.get`으로 `Compaction.cycleCost`를 계산한다.
- `pendingDue`: 아직 시작되지 않은 `compaction.due`의 `{inputID, P, triggerTokens}`. 서버가 이미 넣었고(4.7.4), 새로 연결한 클라이언트(`prompt` 범위)가 같은 id로 다시 보내도 같은 항목이다. 보내기 직전에 revert가 없음을 확인한다(4.7.4 입장 규칙). staged revert가 있는 동안은 항상 `null`이다.

`ledger.session` `{sessionID, limit?:200, cursor?}` → `{steps: LedgerLine[], totals:{byAccount:{…}}, switchCount, cursor?}`

`accounts.usage` `{accountID?, from, to, groupBy:"hour"|"day"|"session"|"model"}` → `{rows:[{key, tokens, cost, hitRate, requests, projectID?, switchCount?, lastActivityAt?}]}`
- `groupBy:"hour"`: 03 §5.5의 5시간·7일 추이 그래프용.
- `groupBy:"session"`: 행마다 `projectID`, `switchCount`, `lastActivityAt`를 채운다. 03 §5.5 세션 사용량 표(세션, 프로젝트, 계정, 모델, 입력, 출력, 비용, 전환 횟수, 마지막 활동)용이다. `accountID`를 비우면 모든 계정이다.

`plugin.claudeAuth.status` `{}` →
```json
{ "installed":true,"version":"0.4.0-beta.5","integrityOk":true,"order":"ok",
  "phase":"ready",
  "acknowledged":{"at":"2026-09-26T11:30:00Z","version":"0.4.0-beta.5","integrity":"sha512-dVA2AY58…","valid":true},
  "connection":{"type":"oauth","method":"claude-code","label":"Claude Max · na***@…"},
  "warnings":[] }
```
- `order` 값: `ok | before_own_accounts | before_own_team | after_own_telemetry | missing`
- `phase` 값: `absent | installing | installed | uninstalling | ready | error`
- `acknowledged.valid`: 기록된 동의가 설치본(또는 설치 전이면 동봉 템플릿)의 버전·integrity와 현재 `noticeHash`에 모두 맞는지(8.4). `false`면 UI는 위험 고지를 다시 보인다.

`cache.setTtlMode` `{sessionID, providerID, mode:"5m"|"1h"}` → `{mode}`(4.5, **Phase 3**. MVP에서는 `unsupported_strategy`)

**추정과 실행**

`switch.estimate` `{sessionID, target:{providerID,id,variant?}, accountID?, reason?:"manual"|"hard"|"auth"}` →
```json
{ "estimateID":"est_01JB…","expiresAt":1790001600000,
  "context":{"P":153000,"Z":12000,"units":{"source":"credits","target":"credits"}},
  "target":{"providerID":"own-codex-p1q2","id":"gpt-5.5","variant":"high","fits":true,
            "compactAt":{"windowTokens":272000,"triggerTokens":244800,"source":"v2"}},
  "options":[
    {"strategy":"now","delta":{"lo":13.5,"hi":13.5,"unit":"credits"},"quota":{"window":"codex.primary","percent":null,"state":"calibrating"},"perRequestAfter":1.83,"available":true,"display":"primary"},
    {"strategy":"compact-then-switch","delta":{"lo":7.3,"hi":7.3,"unit":"credits"},"perRequestAfter":0.67,"recommended":true,"available":true,"display":"primary"},
    {"strategy":"switch-then-compact","available":false,"reason":"source_available","display":"primary"},
    {"strategy":"cold-point","delta":{"lo":0,"hi":1.1,"unit":"credits"},"trigger":"either","idleMinutes":60,"uncertain":true,"available":true,"display":"primary"},
    {"strategy":"new-session","delta":{"lo":5.0,"hi":5.0,"unit":"credits"},"contextLoss":true,"available":true,"display":"primary"},
    {"strategy":"fork","delta":{"lo":13.5,"hi":13.5,"unit":"credits"},"available":true,"display":"secondary"}
  ],
  "warnings":["same_org_no_headroom"],   // 해당할 때만
  "variantOnly":null,                     // 대상이 현재와 variant만 다를 때만 {preservesCache, reason}
  "confidence":{"steps":14,"recentError":0.08},
  "inputs":{"W_lo":0,"W_hi":0,"rates":{"in":100,"read":10},"ttl":{"lo":300,"hi":null}} }
```
- 경고 코드: `same_org_no_headroom`, `cross_provider_reasoning_loss`, `target_context_too_small`, `image_trim`, `anthropic_compaction_may_be_cold`, `rate_unknown`, 그리고 이번 판에서 더한 `target_compacts_soon`(`0.8·T_t ≤ P_t < T_t`), `compaction_may_truncate`(대상에서 돌 요약이 예산 `T_t`를 넘음, 4.7.5).
- `target`에 `compactAt:{windowTokens, triggerTokens, source}`를 더한다(이번 판). 03 모델 전환기의 "전환 직후 자동 압축될 수 있음" 경고와 대상 문맥 표시는 이 값을 쓴다. `fits`는 `P_t < triggerTokens`다.
- `target.accountID`(선택, SL-17 2026-10-27): 대상이 `anthropic`이면 그 대상이 돌 Claude 계정이다. 입력의 `accountID`, 없으면 대화 트리가 묶인 계정(8.7)이다. 다른 provider에는 없다. 비용 창(03 §6.3)은 아직 전환 기록이 없으므로 `→ 계정`에 이 값을 쓴다.
- `available:false`일 때의 `reason`: `source_available`, `source_exhausted`, `source_already_cold`, `ttl_too_long`, `rate_unknown`, `policy_denied`, `target_context_too_small`, 그리고 v0.4에서 더한 `revert_staged`(`compact-then-switch`·`switch-then-compact`, 4.7.4).
- `recommended`: 5.6의 권장 규칙으로만 붙인다. 과금 단위가 다르면 어느 선택지에도 붙이지 않는다.
- `variantOnly`: 대상이 현재 Ref와 `providerID`·`id`가 같고 `variant`만 다를 때 채운다(5.1, 03 §4.6·§6.2). 그 밖에는 `null`이다.
  - 형식: `{preservesCache: boolean, reason: "message_effort_update" | "route_unsupported" | "non_effort_variant" | "effort_marker_mismatch"}`
  - `preservesCache:true`(`reason:"message_effort_update"`)는 메시지 단위 effort 갱신을 지원하는 경로이고 두 variant가 모두 effort 단계일 때뿐이다. 이때 `now`의 `delta`는 0이고, 03은 대화상자 없이 바로 적용한다.
  - `route_unsupported`: 경로가 메시지 단위 effort 갱신을 지원하지 않는다. `non_effort_variant`: `default`나 effort가 아닌 variant가 끼었다. `effort_marker_mismatch`: 과거 marker가 요청 effort와 어긋나 prefix 중간부터 다시 쓴다. 이 경우들은 일반 전환처럼 `options[]`의 비용을 쓴다.

- T1(07 §5.5): 입력에 `teamOp?: "op_…"`(06 own.team의 팀 계정 작업만 넘김)와 `children?: "after-idle" | "stop"`. 출력에 `busyChildren: {count, accountID} | null`: 같은 회사의 다른 구독 계정으로 갈 때 옛 계정에서 실행 중인 자식 수(상대 대상 포함). own-web 비용 창은 이것으로 `ChatGPT 01에서 하위 에이전트 2개가 실행 중입니다 [끝나면 바꾸기] [멈추고 바꾸기]`를 보인다. 팀 세션에서 팀의 그 회사 구독 계정을 바꾸는 대상이면 `teamOp` 없이는 `team_switch_required{teamID}`다(5.11 7번).

`switch.apply` `{sessionID, estimateID?, target, strategy, reason, childSessionID?, teamOp?, children?}` →
```json
{ "state":"COMPACTING" }
```
- `state` 값: `STEADY | WAIT_SAFE | SWITCHING | COOLDOWN | COMPACTING | SCHEDULED | DELEGATED | BLOCKED | FAILED`
  - `STEADY`: 대상 Ref가 현재와 같아 할 일이 없음(`switchModel` no-op, `session.ts:97-109`)
  - `BLOCKED`: 대상이 소진·인증 실패로 쓸 수 없음. `detail.nextResetAt`를 함께 준다
  - `FAILED`: `switchModel` 뒤 30초 안에 `model.selected`를 확인하지 못함
- `clientAction.type` 값: `compact | fork | create-session | restart-service`. `compact`는 2026-10-08부터 내지 않는다(압축은 서버가 넣음, 5.9(b)(c)). 스키마에는 옛 클라이언트를 위해 남는다. `restart-service`는 인자가 없다(v0.4에서 `configDir` 제거, 8.7). `fork`·`create-session`의 실행에는 기기의 `prompt` 범위가 필요하다(9.1).
- 오류: staged revert가 있는데 `strategy`가 `compact-then-switch`나 `switch-then-compact`면 `revert_staged`(9.4).
- T1: `children`의 `after-idle`(처음 값)은 옛 구독의 자식이 쉴 때까지 WAIT_SAFE에서 기다리고, `stop`은 그 자식들을 먼저 멈춘다. 팀 세션의 팀 구독 계정 변경은 `teamOp`가 있어야 하고, 없으면 `team_switch_required`(5.11 6·7번).

`switch.schedule` `{sessionID, target, trigger:"compaction"|"idle_ttl"|"either", idleMinutes?, deadlineMinutes?}` → `{state:"SCHEDULED", trigger, idleMinutes, uncertain, deadline}`
- `idleMinutes`를 비우면 소스 `TTL_hi`, 모르면 `unknownTtlIdleMinutes`(기본 60, `uncertain:true`)다.
- T1: 팀의 구독 계정은 예약 전환으로 옮기지 않는다. 그런 대상은 `team_switch_required`(07 §5.5).
- `deadlineMinutes`를 비우면 `max(30, 2 × idleMinutes)`다(5.4). `idleMinutes`보다 짧은 값은 `invalid_schedule`로 거부한다.

`switch.cancel` `{sessionID}` → `{state:"STEADY"}`. WAIT_SAFE, SCHEDULED, BLOCKED의 `waitReset`을 모두 취소한다.

`switch.undo` `{sessionID}` → `{state:"STEADY"}`. 전환한 뒤 첫 `step.started` 전에만 된다. 그 뒤에는 `undo_window_closed`.

`switch.state` `{sessionID}` → KV의 SwitchState를 그대로 돌려준다.

`switch.waitReset` `{sessionID, message?:"계속"}` → `{state:"BLOCKED", resumeAt:number}`. BLOCKED의 하위 상태로 저장하고 재시작 뒤 다시 건다(5.4, 5.9(i)).

`switch.setConfirmOverride` `{sessionID, silentBelowTokens: number|null}` → `{silentBelowTokens: number|null}`
- 03 §6.3 대화상자의 체크박스 `이 세션에서는 100k 미만이면 다시 묻지 않기`가 부른다. KV `sess:<sid>:confirmOverride`(2.4.6)에 저장한다. `null`이면 지우고 `policy.thresholds.confirm`으로 돌아간다.
- 이 세션에서만 `policy.thresholds.confirm.dialogAtTokens` 대신 쓰인다. 한도 %·금액 기준(`dialogAtQuotaPercent`, `dialogAtUSD`)은 바꾸지 않는다.
- 세션 메서드다(9.1 location 규칙).

`compaction.setSession` `{sessionID, triggerTokens: number|null}` → `{compaction}`(v0.3에서 추가, 기기 범위 `switch`)
- 세션 압축 기준("더 일찍")을 KV `sess:<sid>:compaction`(2.4.6)에 쓴다. `null`이면 지우고 계정·kind 값으로 돌아간다.
- 범위는 `[floorTokens, slotTriggerTokens)`다(`cache.state.compaction`, 4.7.4). 벗어나면 `setting_out_of_range{field:"triggerTokens", min, max}`다.
- 출력 `compaction`은 `cache.state.compaction`과 같은 형태다. 같은 값을 `cache.state` 이벤트로도 낸다.
- 현재 `P`가 이미 새 값 이상이면 곧바로 서버가 압축을 넣고 `compaction.due`를 낸다(4.7.4 조건을 만족할 때. staged revert가 있으면 둘 다 하지 않는다).
- 세션 메서드다(9.1 location 규칙).
- **웹 검색 서비스(2026-10-10)의 `websearch.{get,set}`으로 82개**다(원격 Claude 3개, VOICE 4개, NOTES 4개를 더한 80개에서). 이벤트는 더하지 않았다. 범위는 9.1 표다.
- **속도 선택지(2026-10-10)의 `speed.offers`(범위 `read`, 세션 없이 모델의 속도 선택지)로 83개**다. 이벤트는 더하지 않았다.

**승인 모드**(v0.4에서 추가. 03 §18.8의 요청, [R-gap] #8)

`session.approval.get` `{sessionID}` → `{mode:"read-only"|"ask"|"full"|"custom", rules: PermissionRule[], children:{open:number}, browserTool?:"on"|"off", computerUse?:"on"|"off"}`(기기 범위 `read`)
- `rules`는 세션의 `permissions`(`Session.Info.permissions`) 그대로다. `mode`는 그 안에 own-accounts가 만든 규칙 묶음(아래)이 정확히 있으면 그 모드, 없거나 사람이 고쳤으면 `"custom"`이다. 묶음 끝의 보호 경로 deny가 지금 목록과 달라도(계정 연결·해제, 설정 폴더나 DB 이동, 예전 빌드가 쓴 목록) 절대 경로 `{read, P, deny}`·`{edit, P, deny}` 쌍이 이어지면 그 모드로 읽는다(PP-4). 읽기는 규칙을 다시 쓰지 않고, 다음 모드 변경이 그 꼬리를 지금 목록으로 바꾼다.
- `browserTool`(v0.5, 03 §18.15)과 `computerUse`(01 §10.2)는 `rules`에서 읽은 값이다. `computerUse`는 `computer`에 맞는 마지막 규칙이 정확히 `{computer,*,allow}`일 때만 `on`이다(플러그인 gate와 같은 규칙). 예전 서비스에는 없다.
- `children.open`: 끝나지 않은 자식 세션 수(KV `sess:<sid>:children`, 2.4.6).
- 세션 메서드다.

`session.approval.set` `{sessionID, mode:"read-only"|"ask"|"full", browserTool?:"on"|"off", computerUse?:"on"|"off"}` → `{mode, patched: sessionID[], browserTool?, computerUse?}`(기기 범위 `admin`, `{sessionID, mode}`만이면 `prompt`, 9.1 MUX. 단 `computerUse:"on"`은 기기에서 받지 않는다, 05 §13.4)
- `browserTool`·`computerUse`는 같은 읽고-고치고-쓰기로 브라우저 deny와 `{computer,*,allow}` 규칙을 own 묶음 앞에 넣거나 뺀다(부모와 끝나지 않은 자식). 결과의 같은 이름 필드는 그 값을 넣은 호출에만 있고, 쓴 뒤 부모의 상태다. `computerUse:"on"`은 그 세션에서 에이전트가 이 PC의 마우스와 키보드를 쓰게 하므로 휴대폰 게이트웨이가 `local`로 막는다(PC에서만).
- **규칙 묶음은 own-accounts가 만든다**(own-web이 보호 경로를 알지 않게, 03 P10). 모양은 03 §18.8이 정한 그대로다.
  - `read-only`: `edit`·`shell` 규칙을 `resource:"**"` deny로, `webfetch`·`websearch`를 `ask`로 둔다(MR10-3, MR11, 아래). 편집과 셸 호출은 모두 거절되지만 도구는 목록에 남는다(`whollyDisabled`는 `resource === "*"`만 본다, `core/src/tool.ts:292-295`). 그래서 prefix가 그대로다(4.3 D10). Codex 방식은 단순한 읽기 명령을 실행하지 않고 `read` 권한으로 직접 읽어 답한다(10 §3.10). 규칙 묶음은 그대로다.
  - `ask`: `edit`·`shell`·`webfetch`·`websearch`를 `ask`로. Codex 방식은 같은 읽기 명령을 승인 카드 없이 직접 읽어 답하고, 그 밖의 명령은 묻는다(10 §3.10, 2026-10-17). 규칙 묶음은 그대로다.
  - `full`: `edit`·`shell`·`webfetch`·`websearch` allow **뒤에** 보호 경로 deny 규칙(01 §13의 vault, DB, 등록 파일, `.credentials.json`)을 다시 붙인다. 세션 규칙은 에이전트 규칙 뒤에 합쳐지고(`core/src/session/context.ts:131`) 마지막으로 맞는 규칙이 이기므로, 뒤에 붙이지 않으면 보호 규칙이 풀린다.
  - 묶음 끝의 보호 경로는 own의 자리(위 목록)뿐이다. 기본 목록(SSH 키, 다른 AI 도구의 로그인, 브라우저 프로필, 지갑 등)과 사용자 목록은 규칙으로 쓰지 않고 own-accounts의 `evaluate` 훅이 모든 세션에 적용한다(PP, 아래 "에이전트가 못 여는 파일·폴더"). 그래서 목록이 바뀌어도 어떤 세션의 규칙도 다시 쓰지 않는다.
- **웹 요청은 `full`에서만 묻지 않는다(MR10-3, 2026-11-02 코디네이터 결정; `websearch`는 MR11, 2026-11-03 코디네이터 결정).** `webfetch` 도구와 Code Mode의 `fetch`(같은 `webfetch` 권한, US5-8), 그리고 `websearch` 도구(검색어가 자원, Code Mode에는 없다)는 프롬프트 인젝션 뒤에 데이터를 밖으로 보낼 수 있다. 검색어에도 대화의 내용을 실을 수 있다. 그래서 `read-only`와 `ask`는 요청마다 URL 또는 검색어 카드를 띄운다. `항상 허용`은 프로젝트에 저장된 규칙이라 세션 규칙 뒤에 읽혀 그대로 듣는다(`save: ["*"]`: 그 프로젝트의 모든 웹 요청 또는 모든 검색). 읽기 전용 역할(`explore`, `own-review`, 07 §2.4)은 에이전트 규칙 `{webfetch,*,ask}`와 `{websearch,*,ask}`를 갖는다. 세션 규칙이 그 뒤라 `full`의 allow는 여전히 이기고, own 묶음이 없는 세션에서는 묻는다. 이 바뀜들 전에 쓴 묶음도 그 모드로 읽힌다(`SessionApproval.modeOf`, `custom`이 아니다). 옛 묶음은 두 세대다: MR10-3 전(`read-only`·`ask`에 웹 규칙이 없음)과 MR11 전(어느 모드에도 `websearch` 규칙이 없음). 그런 대화의 규칙은 읽을 때 다시 쓰지 않는다(읽기가 쓰면 `session.permissions` 이벤트가 가져오기와 스킬 화면의 흐름을 흔들었다, MR10-5). 대신 own-accounts의 `evaluate` 훅이 옛 `read-only`·`ask` 세션의 웹 요청(`webfetch`, `websearch`) allow를 `ask`로 바꾼다(`SessionApproval.legacyWeb`, `switching.webAsk`; 저장된 `항상 허용`이 덮는 요청은 그대로 허용). 옛 `full` 묶음은 훅이 없어도 에이전트 규칙이 검색을 허용해 전과 같다. 다만 그런 대화의 읽기 전용 역할은 다음 모드 변경 전까지 검색 전에 묻는다(세션에 `websearch` allow가 없다). 다음 모드 변경이 지금 묶음을 쓴다. **사용자의 deny는 남는다(MR12-5, 2026-11-03).** 설정 파일의 `permission`(core가 모든 에이전트의 규칙에 더한다)이나 에이전트 정의가 `webfetch`·`websearch`를 deny하면 own의 묶음은 그것을 풀지 않는다. 묶음은 세션 규칙이라 core가 에이전트 규칙 뒤에 읽어, 전에는 `full`의 allow가 그 deny를 이기고 `read-only`·`ask`의 `ask`는 카드로 바꿨다. 이제 `evaluate` 훅(`switching.webAsk`)이 그 에이전트 규칙만으로 판정해(`SessionApproval.agentDenies`: 맞는 규칙 중 마지막이 deny. own의 읽기 전용 역할이 deny 뒤에 붙이는 `ask`(`Preset.ROLE_WEB_ASK`)만 세지 않아 그 `ask`가 deny를 풀지 않는다. 사용자가 deny 뒤에 직접 쓴 `ask`는 센다, RL2-L2) deny면 deny로 둔다. codex 하네스는 에이전트 규칙이 어떤 검색이든 막으면 `전체 허용`에서도 호스팅 `web_search` 대신 own의 `websearch`를 보낸다(호스팅 검색은 검색어마다 판정할 수 없다, `CodexRequest.searchDenied`, RL2-M2). 저장된 `항상 허용`도 풀지 않는다(own 묶음이 없을 때 core의 순서와 같다). 에이전트를 읽지 못하면 allow를 `ask`로, 세션을 읽지 못하면 allow를 `ask`로 둔다(닫힌 쪽). `edit`·`shell`의 deny는 예전처럼 세션 규칙 순서를 따른다. 실서버 시험: own-accounts `test/switching/approval-webfetch.e2e.test.ts`.
- **읽고-고치고-쓴다.** 세션의 기존 규칙에서 own-accounts가 전에 만든 묶음만 빼고 새 묶음을 붙인다. 다른 규칙(브라우저 deny, 사용자가 저장한 규칙)은 지우지 않는다. 쓰기는 `ctx.session.update{sessionID, permissions}`다(`core/src/plugin/host.ts:537-542`, 내부 `setPermissions`).
- **부모와 끝나지 않은 자식을 함께 고친다.** 자식은 만들 때만 부모 규칙을 복사하기 때문이다(`core/src/session.ts:273-276`, surface `session-child-inherits`). `patched`가 고친 세션 목록이다. 이미 끝난 자식은 건드리지 않는다.
- **컴퓨터 사용 allow와 자식(T1, cu-review, 07 §5.4).** `computerUse:"on"`의 `{computer,*,allow}`는 own.computer `status`가 `policy.allowSubagents`를 보일 때만 끝나지 않은 자식에 쓴다(플러그인이 없거나 부르기에 실패하면 꺼진 것으로 읽음). 꺼져 있으면 자식에는 쓰지 않는다. 코어가 새 자식을 만들 때 부모의 규칙을 복사하므로 allow를 가진 채 생긴 자식은, `allowSubagents`가 꺼져 있으면 own-accounts가 `session.created{parentID}` 처리에서 같은 읽고-고치고-쓰기로 그 allow를 지운다(`switching.ts` `inheritedComputer`). 그 짧은 틈은 own.computer-use gate(자식 거부, 메인 모델이 아닌 자식 거부)와 읽기 전용 역할의 `computer` deny가 덮는다(01 §10.2). `computerUse`를 넣지 않은 호출(own.team이 권한을 쓴 뒤 부르는 `session.approval.set{sessionID, mode}` 포함)은 있던 allow를 그대로 둔다(06 §2.8).
- 캐시 영향이 없다(위 규칙 모양). 모드 변경은 전환이 아니므로 상태 머신과 ledger 전환 기록에 들어가지 않는다.
- 이벤트 `approval.changed`(9.3)를 낸다. 세션 메서드다.
- 오류: `setting_out_of_range{field:"mode"}`는 없다(스키마로 막음). 세션이 없으면 core 오류를 `internal_error`로 바꾼다.
- **모델·계정 전환은 승인 모드를 바꾸지 않는다(2026-10-10 확인).** 규칙은 세션 행의 `permissions`에 있고, `switch.apply`(`지금 전환`, 압축 뒤 전환)는 같은 세션의 모델만 바꾼다(`ctx.session.switchModel`). 곁가지 포크는 core가 부모의 `permission`을 그대로 복사하고(`core/src/session/projector.ts` `projectFork`), 새 세션 인계는 원 세션 규칙을 복사한다(03 §5.1, §16.3). 실서버 시험 `test/switching/approval-switch.e2e.test.ts`가 같은 계정의 다른 모델, 다른 계정, 되돌아오기 뒤에 `full`의 shell·patch·webfetch가 `permission.asked` 없이 도는지와 `session.approval.get`이 같은 규칙으로 `full`인지 본다.
- **`full`이 덮지 않는 것.** 묶음은 `edit`·`shell`·`webfetch`만 allow한다. 에이전트 기본 규칙의 `.env` 읽기 `ask`(`schema/src/agent.ts` `Info.default`)는 그대로 묻는다. 작업 폴더 밖 접근(`external_directory`)은 v2.0.28 동기화(2026-10-14, upstream 36a38058fb "stop asking for external directory access by default")부터 기본 규칙에 `ask`가 없어 어느 모드에서도 묻지 않는다. 밖의 파일 읽기는 바로 하고, 고치기는 모드의 `edit` 규칙을 따른다(`read-only` 거절, `ask` 묻기, `full` 허용). 2026-10-16에 확인했고, 2026-10-17에 사용자가 이 upstream 동작을 그대로 두기로 했다(FT-Q1). own 쪽에서 묻는 규칙을 되살리지 않는다. 웹 검색의 **검색 서비스 선택**은 권한 규칙이 아니라 서버 전역 설정이다(core KV `websearch:provider` 또는 config `websearch`). 그래서 어떤 승인 모드도 그 첫 사용 폼을 넘기지 않는다(03 §18.2). 미리 고르는 길은 아래 `websearch.set`이다. ChatGPT 계정이 있으면 아래 `own-chatgpt`가 기본이라 폼이 나오지 않는다.

**에이전트가 못 여는 파일·폴더**(PP, 2026-11-07. 01 §13 "에이전트 접근", 03 §18.8)

`protectedPaths.get` `{}` → `ProtectedPaths.View`: `{home, builtIn:[{id, group, paths, reason}], user:[{path, resolved}]}`(기기 범위 `read`, 위치 `control`)
- `builtIn`은 own의 자리(`own-vault`, `own-files`, `own-config`, `own-database`, `own-claude`, `own-claude-config`, `own-profiles`, 위 묶음의 꼬리와 같은 목록)와 기본 목록(own-accounts `src/protection/builtin.ts` 한 곳, 항목마다 한 줄 이유)이다. 기본 목록은 서비스가 도는 사용자의 홈 폴더(`os.homedir()`)와 그 OS의 `%APPDATA%`·`%LOCALAPPDATA%`·`~/Library/Application Support`·`$XDG_CONFIG_HOME`·`$CODEX_HOME`에 놓는다. 그 OS에 자리가 없는 항목은 빠진다. `paths`는 홈 폴더 아래면 `~`로 쓴다.
- `user`는 KV `protectedPaths`의 목록(적은 그대로)과 그 서비스에서 푼 절대 경로다. 폴더는 그 안의 모든 것, 파일은 그 파일 하나를 막는다.

`protectedPaths.add` `{path}` → `View`(기기 범위 `local`). 절대 경로나 `~`로 시작하는 경로만 받는다. 이미 있는 자리(다른 표기 포함)는 그대로 답한다. 거절은 `protected_path_invalid{reason:"relative"|"root"|"home"|"wildcard"|"too_many", path}`이고 아무것도 저장하지 않는다(최대 200개). 바꾸면 이벤트 `protectedPaths.changed{paths}`(global)를 낸다.

`protectedPaths.remove` `{path}` → `View`(기기 범위 `local`). 적은 그대로나 푼 경로로 뺀다. 모르는 경로는 그대로 답한다.

`protectedPaths.suggest` `{}` → `{items:[{name, path, folder}]}`(기기 범위 `local`). 홈 폴더 맨 위의 이름 중 민감해 보이는 것(wallet, backup, seed, mnemonic, recovery, keystore, secret, private, password, credential, vault, token, 낱말로 선 key(s)·otp·2fa, `.kdbx`·`.pem`·`.key`·`.p12`·`.pfx` 등)에서 이미 막힌 것을 뺀 최대 50개다. 저절로 더하지 않는다.

`protectedPaths.patterns` `{}` → `{patterns: string[]}`(기기 범위 `read`). 훅이 `read`·`edit`를 거절하는 모든 패턴(절대 경로, `/`, core 와일드카드)이다. 결과를 스스로 거르는 검색(own.harness의 dsh `grep`·`glob`)이 프로세스 안에서 부른다.

- **적용(훅)**: own-accounts의 permission `evaluate` 훅(`Protection.evaluate`)이 그 서비스의 모든 세션(모드 없는 `기본 규칙`, `사용자 지정`, 하위 에이전트, 팀 영역 포함)에 다음 도구 호출부터 적용한다. 조이기만 한다. `read`·`edit`의 자원(Location 기준 상대 경로는 그 폴더에서 푼다)이 목록에 맞으면 `deny`이고, 모델에는 영어 이유가 간다. `external_directory`(core가 Location 밖 폴더마다 `<폴더>/*`로 묻는다: 파일 도구의 폴더, 셸의 작업 폴더와 `cd`·`Set-Location` 대상)의 폴더가 목록의 폴더이거나 그 안이면 역시 `deny`다. 그래서 `cd ~/.ssh && …`와 그 안을 `workdir`로 둔 명령은 돌지 않는다.
- **같은 파일의 다른 표기(PP-10)**: 맞추기 전에 자원을 여러 표기로 푼다(own-runtime `PathForms.of`). 그대로의 경로, Windows에서 `\\?\`·`\\.\` 접두사를 뗀 것, 관리 공유(`\\<아무 호스트>\C$\…`)를 드라이브로 읽은 것, NTFS 스트림 꼬리(`::$DATA`, `::$INDEX_ALLOCATION`, `:이름`)를 자른 것, 실제 경로(`realpathSync.native`: 8.3 짧은 이름, 심볼릭 링크, 정션을 푼 것. 아직 없는 파일이면 가장 가까운 있는 폴더의 실제 경로 뒤에 나머지) 중 하나라도 맞으면 막는다. 네트워크 경로(관리 공유가 아닌 `\\server\share`)는 닿지 않는 호스트가 판정을 몇 초 붙잡을 수 있어 실제 경로를 읽지 않는다. dsh `grep`·`glob`의 거르기도 같은 함수를 쓴다. 그래서 core `grep`·`glob`의 결과 거르기(P-031), Codex·Pi의 직접 읽기와 `view_image`(실제 경로까지), Claude Agent의 MCP 도구도 같은 판정을 받는다. `shell`의 자원(명령마다의 글)이 목록의 경로를 가리키면 `ask`로 바꾸고 카드에 그 경로를 적는다(`전체 허용`과 저장된 `항상 허용` 위에서도). 이미 `deny`인 것은 그대로다. 다른 own 훅이 쓴 이유는 뒤에 남긴다.
- **셸 판정은 최선 노력이다.** 명령 글에서 `~`, `$HOME`, `${HOME}`, `$env:HOME`, `$env:USERPROFILE`, `%USERPROFILE%`, `$USERPROFILE`과 `APPDATA`·`LOCALAPPDATA`의 같은 꼴을 풀고(Windows는 대소문자 무시), 따옴표 안팎(셸처럼 이어 붙인 `"$HOME"/.ssh`, `~/".ssh"`도), 두 방향 슬래시, Git Bash의 `/c/…`와 WSL의 `/mnt/c/…`, `--flag=경로`·`-Path:경로`, `.`으로 시작하거나 슬래시가 든 상대 경로를 본다. 찾은 경로도 위의 여러 표기로 맞춘다(8.3 이름, 링크). 상대 경로는 Location 폴더와, 같은 도구 호출의 `external_directory`가 허용한 폴더(작업 폴더, `cd ~` 같은 대상: core는 대상이 있는 `cd`를 명령 글에서 빼고 그 물음으로 옮긴다)에서 푼다. 훅은 도구 호출(세션, 메시지, 호출 id)마다 그 폴더를 기억한다(최근 64개). 대상 없는 `cd`·`chdir`·`Set-Location`·`sl`은 core가 따로 된 명령으로 남기므로 홈 폴더를 더한다. 화면에 찍기만 하는 명령(`echo`, `printf`, `Write-Output`, `Write-Host`에 `>`·`<`·`|`·`;`·`&`·`(`·`` ` ``가 없을 때)과 `git commit|tag|merge|notes|stash`의 `-m`·`--message` 값, `gh`의 `--title`·`--body`·`-t`·`-b` 값은 경로로 읽지 않는다(그 메시지 안의 경로가 `전체 허용`의 카드를 띄우고 팀의 자동 허용을 멈추게 했다). 따옴표 안 글을 낱말로 나눠 보는 것은 그대로다(`python -c "open('…/.ssh/id')"`를 잡는다). 실행 중에 만드는 경로(변수, 문자열 이어 붙이기, `$(…)`), 와일드카드로만 맞는 경로(`~/.ss*`), 스크립트 파일 안의 경로, 목록을 담은 위 폴더 전체 검색(`rg secret ~`)은 보지 못한다. **사람이 없는 판정**: 예약 확인 코드(core `Permission.Unattended`)는 훅의 `ask`를 그 예약이 허용한 동작의 allow로 정리하므로, 보호 경로를 적은 셸 명령도 카드 없이 돈다(`read`·`edit`는 훅이 `deny`라 막힌다). 훅은 Unattended를 보지 못해 core 패치 없이는 닫을 수 없어 남겨 둔다(PP-10).
- **카드의 `항상 허용`**: 보호 경로를 가리키는 셸 카드의 글은 `ProtectedPaths.SHELL_NOTE`로 시작한다. own-web은 그런 카드에 `항상 허용`(과 `Mod+Enter`의 always)을 두지 않는다. 훅이 저장된 허용 위에서도 다시 묻기 때문에, 저장해도 그 카드는 다시 뜨고 같은 꼴의 다른 명령(`cat *`)만 묻지 않게 된다.
- **캐시**: 규칙·도구 목록·프롬프트를 바꾸지 않는다. Codex 방식의 모드 문구도 그대로다.
- **원격**: SSH 호스트의 서비스도 같은 모듈로 자기 홈 폴더에 기본 목록을 놓고 자기 KV에 사용자 목록을 둔다. own-web은 서버를 골라 그 서비스에 묻는다. 호스트의 `protectedPaths.changed`는 이 PC의 다른 창에 오지 않는다(원격 Publisher는 global을 내지 않는다). 바꾼 창은 답으로 바로 보이고, 다른 창은 그 호스트의 목록을 다시 열 때 읽는다.
- 시험: own-accounts `test/protection/protection.test.ts`(OS별 자리, 와일드카드, 사용자 경로, 제안, 셸 판정, 모듈·훅), `test/switching/approval-tail.test.ts`(예전 꼬리), `test/protection/protected.e2e.test.ts`(실제 서버), own-protocol `rpc.test.ts`, own-harness dsh `tools.test.ts`, own-web `requests/protected/protected.test.ts`.

**웹 검색 서비스**(2026-10-10. 03 §18.2)

`image.get` `{}` → `OwnImage.View`: `{setting:{family, quality, size, useKeys, codexFallback}, keys:[{accountID, label, on, ready, exhausted?:{code, at, until}}], codex:[{accountID, label, on, ready, usedPercent?, exhausted}]}`(기기 범위 `read`, 위치 `control`). 이미지 도구가 지금 시도할 순서 그대로다(9.6). 키 값은 없다.

`image.clear` `{accountID}` → `OwnImage.View`(기기 범위 `admin`, 위치 `control`). 그 OpenAI API 키의 `바닥남` 표시를 지워 다음 이미지에서 다시 시도한다(9.6). 사용자가 잔액을 채운 뒤 쓴다.

`websearch.get` `{}` → `{choice?: {type:"any"} | {type:"service", id} | {type:"off"} | {type:"multi"}, keys?: Record<id, "key" | "env">, multi?: {services: id[], custom}}`(기기 범위 `read`)
- own 전역 설정 `%OPENCODE_CONFIG_DIR%\opencode.jsonc`의 core 키 `websearch`를 읽는다(`false` → `off`, `{provider:"random"}` → `any`, `{provider:"own-multi"}` → `multi`, `{provider:<id>}` → `service`). 그 키가 없으면 `choice`가 없다. 이때 ChatGPT 계정이 있으면 아래 `own-chatgpt`가 쓰이고, 없으면 첫 사용 폼의 답(core가 서버 전역 KV `websearch:provider`에 둔 것, own은 읽지 못함)이 쓰이며, 답한 적이 없으면 다음 첫 사용 때 폼이 묻는다.
- `multi`(MS, 2026-10-19): `여러 서비스 함께`가 물을 서비스. 고른 방식과 상관없이 늘 온다(설정 > 웹 검색이 모드를 바꿀 때 체크 상자를 이것으로 채운다). `custom`이면 KV `websearch:multi`에 저장된 선택(2.4.6)이고, 아니면 지금 목록에 있는 서비스에 대한 own의 기본이다: `own-chatgpt`가 목록에 있으면 그것, 그다음 키 없이 쓰는 core 서비스(Exa, Firecrawl, Parallel, Tavily, TinyFish) 가운데 목록에 있고 core에 사용자 키(credential·환경 변수)가 없는 것. 그 서비스의 키가 own vault에 있어 `own-<서비스>`가 목록에 있으면 그것으로 묻는다(SK, 2026-10-23: 사용자가 이 앱에 그 키를 넣은 것이 곧 그 키로 쓰겠다는 뜻이다). 돈이 드는 `own-deepseek`·`brave`와 core에 키가 있는 서비스는 기본에 들지 않는다. 저장된 선택도 지금 묻는 id로 보인다(`exa`는 `own-exa`가 목록에 있으면 `own-exa`, 키를 지워 `own-exa`가 빠지면 다시 `exa`. 같은 서비스는 한 번). 저장된 선택에 지금 목록에 없는 서비스가 있어도 그대로 보인다(검색은 목록에 있는 것만 묻는다). 서비스 목록을 읽지 못하면 없다.
- `keys`(WM, 2026-10-19): 서버가 보이는 서비스 가운데 사용자 키를 쓰는 것. 그 서비스와 id가 같은 core integration에 연결이 있으면 `key`(저장된 credential) 또는 `env`(`EXA_API_KEY` 같은 환경 변수)다. 키 값은 읽지 않는다(`ctx.integration.list`의 `connections`만). 목록이나 integration을 읽지 못하면 `keys`가 없다. 설정 > 웹 검색의 비용 줄(`무료 · 키 없음 …` / `내 Parallel 키로 …`)과 카드 제목의 `(무료)`/`(내 키)`가 이것을 쓴다(03 §18.2).
- control location 메서드다(전역 설정).

`websearch.key.get` `{}` → `{keys:[{service, configured, keyHint?}], vault:"ok"|"unavailable"}`(기기 범위 `read`, 2026-10-19 SP, 2026-10-23 SK)
- 사용자 키를 받는 웹 검색 서비스 여섯(`brave`, `exa`, `firecrawl`, `parallel`, `tavily`, `tinyfish`, 이 순서)마다 키가 own vault(`websearch-<service>`)에 있는지와 끝 네 글자(`…a1B2`)다. 키는 돌려주지 않는다. control location에서 받고, 원격 서비스는 `remote_managed`다. 이전 서비스는 `brave` 한 줄만 준다(own-web은 그때 다른 서비스의 키 줄을 보이지 않는다).

`websearch.key.set` `{service, key: string | null}` → `websearch.key.get`과 같은 모양(`local`, 2026-10-19 SP, 2026-10-23 SK)
- `service`는 위 여섯 가운데 하나다. 앞뒤 공백을 뗀 키를 vault의 기능 키로 저장하고(`.prev`를 남김), `key:null`이면 지운다(shred). 모양이 키가 아니면 `websearch_key_invalid`, vault가 답하지 않으면 `vault_unavailable`. 키를 서비스에 미리 보내 확인하지 않는다(확인 호출도 요금이 들고, 첫 검색의 `auth`가 알린다).
- 바뀌면 runtime broadcast `searchKey.changed{service}`로 모든 Location이 웹 검색 서비스를 다시 접는다(`brave`나 `own-<service>`가 목록에 나오거나 빠짐). 로그는 `websearch_key_set{service, configured}`뿐이고 키나 끝 네 글자는 남기지 않는다. own-web의 `Brave 키 넣기…`·`Exa 키 넣기…`(03 §18.2)가 부른다.

`websearch.set` `{choice}` → `{choice?, keys?, multi?}`(기기 범위 `admin`). `choice`는 `get`의 넷에 `{type:"default"}`(WM, 2026-10-19)를 더한 것이고, `multi`는 `services?: id[]`(1–32개)를 가질 수 있다(MS)
- `multi`(MS): `services`가 있으면 그 서비스들(모두 지금 목록에 있어야 하고 `own-multi` 자신은 안 된다. 아니면 `websearch_unavailable{reason:"unknown_service", id}`)을 KV `websearch:multi`에 저장하고(중복은 뺌), config에 `{provider:"own-multi"}`를 쓴다. `services`가 없으면 저장된 선택(없으면 own의 기본)을 그대로 쓴다. 답의 `choice`는 `{type:"multi"}`다. 다른 선택을 저장해도 저장된 선택은 남아, 다시 `여러 서비스 함께`로 바꾸면 그대로 돌아온다. 로그는 `websearch_set{choice, services?: 개수}`뿐이다.
- core의 `websearch` 키를 쓴다(주석·줄 끝은 그대로, 임시 파일 뒤 이름 바꾸기). core는 config의 값을 KV보다 먼저 읽으므로(`core/src/websearch.ts` `selection`, `config/plugin/websearch.ts`) 설치된 서비스는 config watcher로 다시 읽은 뒤 모든 세션과 모델에 바로 쓴다. 폼에서 `웹 검색 끄기`로 KV에 `false`가 있어도 여기서 다른 값을 고르면 다시 켜진다(03 §18.2의 `다시 켜기`).
- `default`(설정 > 웹 검색 `기본으로`): config의 `websearch` 키를 지운다(그 위 주석 한 줄도 함께 지워진다, `jsonc-parser`). 파일이 없으면 아무것도 만들지 않는다. 답에는 `choice`가 없고, 아래 `own-chatgpt`가 다시 기본이 된다(ChatGPT 계정이 없으면 첫 사용 답이나 폼).
- `service`의 `id`는 서버가 지금 보이는 검색 서비스(`GET /api/websearch/provider`, `ctx.websearch.providers`)여야 한다. own은 사용자가 고르지 않은 서비스를 켜지 않는다. 예외는 아무것도 고르지 않았을 때의 기본인 아래 `own-chatgpt` 하나다.
- 오류 `websearch_unavailable{reason:"unknown_service", id}`(목록에 없는 서비스), `websearch_unavailable{reason:"config_unavailable"}`(`OPENCODE_CONFIG_DIR`이 없거나 파일이 JSONC가 아님. 파일은 그대로 둔다). `websearch.get`도 파일을 읽지 못하면 `config_unavailable`이다.
- 프로젝트 config(`.opencode/`)에 `websearch`가 있으면 그 프로젝트에서는 그것이 이긴다. own은 그 파일을 쓰지 않는다.

**ChatGPT 웹 검색 서비스 `own-chatgpt`**(2026-10-14. `src/websearch/chatgpt.ts`, `wire.ts`)

- **무엇**: core의 `websearch` 도구가 사용자의 ChatGPT(Codex) 구독 계정으로 검색하게 하는 검색 서비스다(이름 `ChatGPT`). 세션의 모델·하네스와 상관없이 쓴다(DeepSeek, Claude, compat, 어느 하네스든. `codex` 하네스의 OpenAI Responses 모델은 지금처럼 Codex의 hosted `web_search`를 직접 쓴다). 검색 한 번은 Codex 백엔드 `POST {codex}/responses` 한 번이다: `stream:true`, `store:false`, `instructions`, Codex의 hosted 도구 `{"type":"web_search","external_web_access":true}`(live 검색, Codex 0.162.1 `tool_spec.rs`), `include:["web_search_call.action.sources"]`, 엄격한 JSON 스키마 답(`text.format` json_schema `results:[{url,title,content}]`. Codex `--output-schema`가 hosted 도구와 함께 보내는 모양). 본문은 작아서 zstd 없이 JSON으로 보낸다.
- **결과**: 답의 `results`를 core `WebSearch.Result`로 바꾼다. http(s) 주소만, 주소당 하나, 순서대로, 최대 10개이고, OpenAI가 인용 링크에 붙이는 `utm_source=openai`는 뗀다. 답이 JSON이 아니거나 비어 있으면 `url_citation` 주석(제목, 인용된 줄)과 검색이 읽은 페이지(`action.sources`, 연 페이지)를 쓴다. 60초 안에 답이 끝나지 않으면 실패다.
- **등록**: own-accounts가 slot을 등록하는 모든 Location에서, `codex` 계정이 하나라도 있고 그것이 꺼지거나(`disabled`) 없어지지(`retired`) 않았으면 목록에 있다(WM, 2026-10-19. 전에는 `ready`·`unverified`일 때만이었다. 그래서 모든 ChatGPT 로그인이 `auth_failed`·`needs_reauth`가 되면 서비스가 빠지고, core KV에 남은 첫 사용 답(흔히 `random`)으로 검색어가 조용히 키 없는 제3자 서비스로 갔다. 이제 그 검색은 `auth`로 실패하고 카드가 ChatGPT를 말한다). 계정이 바뀌면(`store.changed{accounts}`) 다시 접는다. `siwc`(Sign in with ChatGPT)는 쓰지 않는다. 원격 서비스(04 §9)에서도 등록되고 자격 증명은 브로커 lease(`logins.headers`)다.
- **계정·모델**: 레지스트리 순서로 첫 `codex` 계정을 쓰고, 한도에 걸린 계정(`runtime.limits`의 소진, 또는 백엔드가 소진으로 알린 플랜 창)은 건너뛴다(전환 계획기와 같은 규칙). 로그인이 안 되거나(자격 증명 없음, 401·403) 한도에 걸리면(429, 스트림의 사용량 오류) 다음 계정으로 넘기고, 다른 실패(그 밖의 HTTP 상태, 네트워크, 시간 초과, 취소)는 그 검색을 끝낸다. 모델은 그 계정의 Codex 모델 목록(4.8, 없으면 공유 스냅샷 07 §4.5)에서 `gpt-5.6-luna` → `gpt-6-luna` → `gpt-5.5` 중 처음 있는 것, 셋 다 없으면 그 목록의 Codex 우선순위 첫 모델, 목록이 아예 없으면 `gpt-5.6-luna`다. 추론 강도는 `low`(목록에 `low`가 없으면 검색이 되는 가장 낮은 단계. `minimal`·`none`은 web search를 못 씀).
- **사용량**: 검색은 그 ChatGPT 구독의 Codex 사용량을 쓴다(모델 요청 하나와 같고, 모델이 여러 번 검색하면 그만큼). 답의 `x-codex-*` 헤더로 그 계정의 한도 창을 갱신하므로(`limits.updated`) 계정 화면에 바로 보이고, 한도에 걸린 계정은 다음 검색부터 건너뛴다. 원장(ledger) 줄은 쓰지 않는다.
- **기본 선택**: config에 `websearch` 키가 없고 다른 플러그인도 기본을 정하지 않았으면 `own-chatgpt`가 core의 기본이다(`editor.default.set`). 그래서 ChatGPT 계정이 있으면 첫 사용 폼이 나오지 않는다. 사용자가 고른 것(`websearch.set`의 서비스·`any`·`off`·`multi`, 프로젝트 config)은 언제나 이긴다: core의 config 접기는 `post` 내부 플러그인이라 이 플러그인의 접기 뒤에 돌며 config의 값으로 기본을 덮는다(`core/src/plugin/internal.ts`, 2026-10-19 MS에서 확인. 전에는 "먼저 돈다"고 적었지만 결과는 같다). 다른 플러그인이 이미 기본을 정했으면 건드리지 않는다. 단 폼으로 답해 core KV에만 있는 선택은 접기의 기본보다 뒤라서 `own-chatgpt`가 이긴다(own은 그 KV를 읽지 못함). 바꾸려면 설정 > 웹 검색에서 고른다(03 §18.2, 2026-10-19 전에는 설정 > 승인·권한 > 웹 검색).
- **오류**: 실패는 `ChatGPT web search failed (<code>)`로 core에 가고, core는 도구 결과를 `Unable to search the web for …`로 보인다. 쓸 수 있는 계정이 없으면 요청 없이 바로 실패한다: 모두 한도면 `usage_limit`, 목록에 있는 계정이 모두 다시 로그인해야 하면 `auth`, 그 밖에는 `no_account`. 코드는 `no_account`, `usage_limit`, `auth`, `timeout`, `cancelled`, `network`, `status_<n>`, `incomplete_stream`, 또는 백엔드 스트림의 오류 코드다. 비밀·이메일·ChatGPT 계정 id는 들어가지 않는다.
- **로그**: 검색마다 `websearch_query` 한 줄(`provider`, `slot`=own slot id, `durationMs`, `results`, 실패면 `error`). 검색어·토큰·이메일·ChatGPT 계정 id는 남기지 않는다.
- **시험**: `test/websearch/wire.test.ts`(요청 모양, 모델·강도 고르기, SSE 읽기의 JSON 경로와 인용 경로), `chatgpt.test.ts`(접기와 기본 선택, 계정 넘기기, 한도 건너뛰기, 실패 코드, 로그 위생), `chatgpt.e2e.test.ts`(실서버: DeepSeek 방언 세션의 `websearch`가 가짜 Codex 백엔드의 녹화 모양 스트림으로 결과를 받고, 폼·권한 요청은 0건). ⚠ 실계정 확인 전: json_schema와 `web_search`를 함께 보낸 요청을 ChatGPT 백엔드가 받는지, `action.sources` include, `gpt-5.6-luna`의 검색 품질과 걸리는 시간.
- **실계정 확인**(2026-10-14, 계정 01, `packages/own-harness/script/live/websearch.ts`): 요청 모양(`json_schema` + 호스팅 `web_search` + `include` + `instructions`, zstd 없는 JSON)을 백엔드가 받는다. 같은 검색어로 `gpt-5.6-luna` 9.0초(검색 1번, 결과 3), `gpt-6-luna` 9.7초(검색 2번, 결과 2), `gpt-5.5` 20.9초(결과 5). 모든 답에 `x-codex-*` 헤더가 있어 한도 창이 갱신된다.

**own이 더하는 웹 검색 서비스**(2026-10-19 SP. 서비스 id와 이름은 `GET /api/websearch/provider`가 보이는 값)

| id | 이름 | 목록에 있을 때 | 기본 | 보내는 곳과 내용 | 비용 |
|---|---|---|---|---|---|
| `own-chatgpt` | `ChatGPT` | `codex` 계정이 있을 때(위) | 아무것도 고르지 않았으면 기본 | `POST https://chatgpt.com/backend-api/codex/responses`: 검색어, 그 계정의 로그인 | 그 ChatGPT 구독의 Codex 사용량 |
| `own-deepseek` | `DeepSeek` | `ds` 계정이 있고 꺼지지 않았을 때(`disabled`·`retired` 말고 모든 상태) | **절대 기본이 아니다** | `POST https://api.deepseek.com/v1/tools/search`: 128자로 자른 검색어와 `count:10`, 그 계정의 키(`Authorization: Bearer`). 중국의 DeepSeek 서버 | 결과가 있는 HTTP 200만 1,000건에 $0.75. DeepSeek 잔액에서 빠진다 |
| `own-multi` | `여러 서비스` | 사용자가 `여러 서비스 함께`를 골랐을 때만(own 전역 config가 `{provider:"own-multi"}`) | 고를 때만 | 고른 서비스마다 그 서비스의 요청 그대로(아래 "여러 서비스 웹 검색"). 새 호스트는 없다 | 고른 서비스들의 비용의 합 |
| `brave` | `Brave` | own vault에 Brave 키(`websearch-brave`)가 있을 때 | **절대 기본이 아니다** | `GET https://api.search.brave.com/res/v1/web/search?q=…&count=10&extra_snippets=true`(한글 검색어면 `search_lang=ko&country=KR`): 400자·50단어로 자른 검색어, 사용자의 키(`X-Subscription-Token`) | 1,000건에 $5, 매달 $5 무료(Brave 요금) |
| `own-exa`, `own-firecrawl`, `own-parallel`, `own-tavily`, `own-tinyfish`(SK) | `Exa (내 키)` 등 | own vault에 그 서비스의 키(`websearch-<서비스>`)가 있을 때 | **절대 기본이 아니다**(`여러 서비스 함께`의 기본에서는 키 없는 같은 서비스 대신 묻는다) | core의 같은 서비스와 같은 주소와 요청(아래 "내 키로 쓰는 core 웹 검색 서비스"), 사용자의 키를 core가 두는 자리에 | 그 서비스 요금: Exa 1,000건에 약 $7(매달 $10어치 무료), Parallel 약 $5(매달 5,000건 무료), Tavily 약 $8(매달 1,000크레딧 무료), Firecrawl 약 $2–8(매달 1,000크레딧 무료), TinyFish 무료(2026-05-04부터) |

- 모두 core의 `websearch` 도구가 쓰는 서비스이고, 세션의 모델·하네스와 상관없다. upstream의 Exa, Firecrawl, Parallel, Tavily, TinyFish는 키를 넣어도 그대로 키 없이 목록에 있다.
- `own-deepseek`, `brave`와 `own-<서비스>`는 사용자가 고를 때만(`websearch.set`의 서비스, 첫 사용 폼의 `다른 검색 서비스 고르기`) 쓴다. 단 `목록의 서비스 중 하나(자동)`(core `random`)는 목록의 모든 서비스에서 뽑으므로 이것들도 뽑힐 수 있다. 그래서 첫 사용 카드의 `… 검색 허용` 아래와 고르는 목록, 설정의 목록이 돈이 드는 서비스의 안내를 보인다(03 §18.2).

**여러 서비스 웹 검색 `own-multi`**(2026-10-19 MS. `src/websearch/multi.ts`)

- **왜**: 사용자 요청(2026-10-19): "검색 서비스를 하나만이 아니라 여러 개 쓸 수 있나? 되면 다 쓰는 것도 나쁘지 않을 것 같다." 그전에는 검색 한 번이 늘 한 서비스로 갔다(고른 것, 또는 `random`이 대화마다 하나를 고르고 HTTP 429에서만 다른 것으로 넘김).
- **무엇**: 이름 `여러 서비스`의 웹 검색 서비스다. 검색 한 번에 고른 서비스 모두에 함께 묻고 답을 합쳐 core에 돌려준다. 고른 서비스는 KV `websearch:multi`(2.4.6), 없으면 own의 기본(위 `websearch.get`의 `multi`)이다. 지금 목록에 있는 서비스만 고른 순서대로 묻는다. 목록에 하나도 없으면 `no_service`로 실패한다.
- **등록**: own 전역 config가 `{provider:"own-multi"}`일 때만 모든 Location의 목록에 있다. 그래서 core의 `random`이 이것을 뽑지 않고 첫 사용 폼에도 나오지 않는다. core의 config 접기는 own-accounts의 접기 뒤에 돌아서(`post` 플러그인) 접기가 config의 선택을 볼 수 없으므로, 접기가 own의 config 파일을 직접(동기로) 읽는다. 파일이 바뀌면 core의 config watcher가 검색 서비스를 다시 접고 그때 다시 읽는다. 프로젝트 config의 `websearch`는 보지 않는다(own은 그 파일을 쓰지 않는다).
- **묻는 길**: own의 `own-chatgpt`·`own-deepseek`·`brave`와 `own-<서비스>`(SK)는 직접 부른다(위 각 절과 같은 요청, 같은 계정 고르기, 취소 신호 있음). 선택에 있는 키 없는 core 서비스는 그 키가 own vault에 있어 `own-<서비스>`가 목록에 있는 동안 그것으로 묻는다(`KeyedSearch.resolve`). 그 밖의 서비스(core의 키 없는 다섯, core에 사용자 키가 있는 서비스, 플러그인의 서비스)는 플러그인 API `ctx.websearch.query({query, providerID})`로 부른다. core는 `providerID`가 있으면 선택·KV·`random`·cooldown 없이 그 서비스를 바로 실행한다(`core/src/websearch.ts` `query`). 그 요청은 서비스 자신의 것이라 새 호스트가 없고, upstream 플러그인 코드를 옮기지 않았다. 이 길은 취소 신호를 받지 않아서, 마감 뒤에도 core 서비스의 요청은 끝까지 가고(core MCP 요청의 25초 시간 초과) 그 답은 버린다.
- **마감**: 모두 답하면 바로 돌려준다. 아니면 결과가 있는 첫 답 8초 뒤, 그것도 아니면 시작 25초 뒤에 돌려준다. 단 `own-chatgpt`가 아직 검색 중이면 25초까지 기다린다. ChatGPT 검색은 9–21초가 보통이고(위 실계정 확인), 그 구독 사용량은 답을 쓰든 말든 쓰이기 때문이다. 25초는 core MCP 요청의 시간 초과와 같아 core 서비스의 늦은 답이 이 마감과 비슷하게 끝난다. 마감에 남은 서비스는 `timeout`이고 own의 서비스는 그 요청을 취소한다. 도구 호출이 취소되면 모두 `cancelled`로 바로 끝난다.
- **합치기**: 페이지 주소를 정규화해(http·https 같음, 호스트 소문자와 `www.` 뺌, 끝 `/`·조각 뺌, `utm_*`·`fbclid`·`gclid` 같은 추적 매개변수 뺌, 나머지 매개변수 정렬) 같은 페이지는 하나로 둔다. 순위는 서비스마다의 순위로 매긴 reciprocal rank fusion(k = 60, 점수 Σ 1/(k + 순위))이다. 한 서비스가 같은 페이지를 두 번 주면 좋은 순위로 한 번만 센다. 같은 점수면 가장 좋은 순위, 그다음 서비스 순서다. 많아야 10개를 남긴다(서비스마다 8–10개를 묻는다. core 도구는 개수를 받지 않는다). 결과마다 가장 좋은 순위의 주소, 처음 있는 제목·내용·게시 시각을 쓰고, 내용 끝에 `Found by: ChatGPT, Exa`(찾은 서비스 이름) 줄을 붙인다. 모델이 이 줄을 읽고, own-web 카드가 이 줄을 센다(03 §18.2).
- **잠시 쉬게 하기**: 실패하거나 마감에 걸린 서비스, 다른 서비스가 결과를 찾았는데 빈 답을 준 서비스는 이번 검색에서 빠지고 잠시 쉰다(처음 2분, 다시 놓칠 때마다 두 배, 많아야 30분, 결과가 있는 답이 오면 지움). 빈 답은 Exa·Firecrawl의 키 없는 서버가 무료 한도를 다 쓴 뒤 core에 보이는 모양이다(upstream #54311). 모든 서비스가 빈 답이면 그 검색어에 결과가 없는 것으로 보고 아무도 쉬게 하지 않는다. 고른 서비스가 모두 쉬는 중이면 이번에는 모두에 묻는다. 쉬는 표는 서비스 프로세스에 하나다(무료 한도는 Location마다가 아니다).
- **모두 실패**: 어떤 서비스도 답하지 못하면 `Web search failed on every service (ChatGPT: auth, Exa: timeout)`처럼 서비스마다의 이유로 실패한다. 하나라도 답했으면(빈 답 포함) 그 결과를 돌려준다.
- **비용**: 고른 서비스 각각의 비용이다. DeepSeek의 과금 검색은 `own-deepseek`처럼 이벤트 원장에 `websearch` 줄을 쓰고, ChatGPT의 답은 그 계정의 한도 창을 갱신한다. 설정 > 웹 검색은 고른 유료 서비스로 `검색 한 번에 최대 약 $X`를 보인다(03 §18.2).
- **로그**: 검색마다 `websearch_query` 한 줄(`provider:"own-multi"`, `durationMs`, 합친 `results`, 서비스마다 `{id, durationMs, results | error}`, 쉬는 중이라 뺀 `skipped`, 서비스가 없으면 `error:"no_service"`). 검색어와 키는 남기지 않는다. 직접 부른 own 서비스는 자기 줄을 따로 쓰지 않는다.
- **시험**: `test/websearch/multi.test.ts`(접기와 config 읽기, 기본 선택, 주소 정규화, RRF 합치기와 10개, 동시에 묻기, 8초·25초 마감과 ChatGPT 기다리기, 취소, 쉬게 하기와 두 배, 모두 빈 답, 모두 실패, `no_service`, core 실패 코드, 검색어 없는 로그, DeepSeek 과금 원장 줄), `multi.e2e.test.ts`(실서버: 기본 선택이 보이고 `own-multi`는 목록에 없다. 없는 서비스와 `own-multi` 자신은 거절. DeepSeek·Brave·Fake Search를 골라 저장하면 세션의 `websearch`가 셋에 한 번씩 묻고 모델이 합친 목록(DeepSeek과 Brave가 함께 찾은 페이지가 먼저, `Found by`)을 읽는다. 원장 줄, 로그 한 줄. 다른 선택을 저장하면 `own-multi`가 목록에서 빠지고 선택은 남는다).

**DeepSeek 웹 검색 서비스 `own-deepseek`**(2026-10-19 SP. `src/websearch/deepseek.ts`)

- **무엇**: DeepSeek가 2026-10-17에 연 Search API(`POST {deepseek}/tools/search`, `endpoints.deepseek` 기본 `https://api.deepseek.com/v1`)로 검색한다. 키는 사용자의 `ds` 계정 키 그대로이고, 요청마다 `logins.headers`로 넣는다(모델 요청과 같은 길. own은 키를 읽어 내지 않는다). 본문은 `{query, count:10}`이고 본문 전체(`need_content`)는 묻지 않는다.
- **등록**: `ds` 계정이 하나라도 있고 꺼지지 않았으면(`disabled`·`retired`가 아닌 모든 상태) 모든 Location의 목록에 있다. 로그인에 문제가 있는 계정만 있어도 목록에 남기고 검색이 `auth`로 실패한다. 그래야 고른 DeepSeek이 사라져 검색이 조용히 다른 서비스로 가지 않는다(own-chatgpt의 WM 규칙과 같다). `editor.default.set`은 하지 않는다. 계정이 바뀌면(`store.changed{accounts}`) 다시 접는다. 원격 서비스(04 §9)에서도 등록되고 키는 브로커 lease다.
- **계정**: 레지스트리 순서로 `ready`(또는 `unverified`)인 `ds` 계정 중 소진(`runtime.limits.exhaustion`)이 없는 첫 계정을 쓴다. 402(잔액 부족)나 로그인 실패(키 없음, 401)면 다음 계정으로 넘기고, 다른 실패(그 밖의 HTTP 상태, 네트워크, 30초 시간 초과, 취소, 읽을 수 없는 본문)는 그 검색을 끝낸다. 401이면 `logins.unauthorized`를 알린다. 쓸 계정이 없으면 요청 없이 실패한다: 준비된 계정이 모두 소진이거나 잔액이 바닥난(`exhausted`) 계정이 있으면 `insufficient_balance`, 계정이 있지만 모두 문제가 있으면 `auth`, 없으면 `no_account`.
- **검색어**: 앞뒤 공백을 떼고 128자(코드 포인트, 서로게이트 쌍을 가르지 않음)에서 자른다. 빈 검색어는 요청 없이 `empty_query`다. 실호출(2026-10-19)에서 한국어 128자(UTF-8 296바이트)가 통과해, 한도는 바이트가 아니라 글자 수다.
- **결과**: 응답은 `{results:[…]}`다. 결과마다 `title`, `url`, `snippet`, `summary`, `content`(`need_content`가 없으면 `""`), `site_name`, `site_icon`, `date`(RFC 3339 또는 `null`), `rerank_score`, `authority`가 온다(실호출 확인). core 결과로는 http(s) 주소만, 주소당 하나, API 순서대로(이미 `rerank_score` 내림차순) 옮긴다. 제목, 내용은 `summary`(없으면 `snippet`)를 1,500자에서 자른 것(잘리면 `…`), `date`가 읽히면 게시 시각이다. 문서는 `summary`를 600~800자라고 하지만 실제로는 150~4,500자여서, 열 개가 다 길면 모델 문맥에 4만 자 넘게 들어가기 때문에 자른다. 제목이 빈 결과도 있다(core는 주소를 제목으로 보인다).
- **비용 기록**: DeepSeek는 결과가 있는 HTTP 200만 과금한다(빈 결과, 실패, 시간 초과는 무료). own은 과금되는 검색마다 이벤트 원장(`events-YYYY-MM.jsonl`)에 `type:"websearch"` 줄을 쓴다: `accountID`, `providerID`, `data:{service:"own-deepseek", cost:{unit:"USD", amount:0.00075, source:"estimate"}}`. 검색어는 넣지 않는다. 사용량 원장(`usage-*.jsonl`)에는 쓰지 않는다: 그 줄은 세션의 모델 요청 한 단계라 `sessionID`·`modelID`가 필요하고, 검색은 어느 세션 단계에도 속하지 않는다(core가 서비스에 세션을 넘기지 않음). 그래서 계정의 `이번 달 예산`(`api.budget_month`, 사용량 원장 합계)에는 아직 들지 않는다. 실제로 빠진 돈은 DeepSeek 잔액 창(`ds.balance`, leader poller가 15분마다 `GET /user/balance`)에 보인다.
- **오류**: 실패는 `DeepSeek web search failed (<code>)`로 core에 간다. 코드는 `no_account`, `auth`, `insufficient_balance`, `empty_query`, `timeout`, `cancelled`, `network`, `status_<n>`, `bad_response`다. 키와 검색어는 들어가지 않는다.
- **로그**: 검색마다 `websearch_query` 한 줄(`provider:"own-deepseek"`, `slot`, `durationMs`, `results`, 실패면 `error`). 검색어와 키는 남기지 않는다.
- **알릴 것**: 검색어가 중국의 DeepSeek 서버로 간다. DeepSeek 개인정보처리방침상 입력이 학습에 쓰일 수 있고 데이터 무보존(ZDR) 선택은 없다(own/reports/websearch-services-2026-10.md §2.2). UI는 설정 > 웹 검색과 첫 사용 카드에서 `DeepSeek 잔액에서 빠져요 · 1,000건에 약 $0.75 · 검색어가 중국(DeepSeek) 서버로 가요`를 보인다(03 §18.2).
- **실호출 확인**(2026-10-19, 사용자의 DeepSeek 키, live kit 중계 `packages/own-harness/script/live/deepseek-search.ts`, 요청 3번): 셋 다 HTTP 200, 결과 10개. 걸린 시간은 영어 2.0초(첫 연결 포함), 한국어 0.53초, 한국어 128자 0.48초. 한국어 뉴스 검색어(한국은행 기준금리)는 연합뉴스·헤럴드경제·서울경제 같은 한국 언론의 10월 기사 10개가 나왔고(`authority` 3~4, 요약도 한국어), 한국어 개발 질문은 npm·bun.sh 같은 영어 문서와 중국어 미러가 섞였다. 영어 개발 검색어는 bun.com 공식 글이 6번째였고 중국어 블로그·집계 사이트가 앞에 왔다.
- **시험**: `test/websearch/deepseek.test.ts`(접기와 기본 없음, 128자 자르기, 결과 옮기기와 1,500자 자르기, 402·401 넘기기, 쓸 계정이 없을 때의 코드, 빈 결과는 무과금, 원장 줄, 로그 위생), `services.e2e.test.ts`(실서버: `ds` 계정이 있어도 첫 사용 폼이 묻고 DeepSeek에는 요청이 없다. 설정에서 고르면 세션의 `websearch`가 그 계정 키로 한 번 검색하고 모델이 결과를 읽는다).

**Brave 웹 검색 서비스 `brave`**(2026-10-19 SP. `src/websearch/brave.ts`, 키 `src/rpc/search-key.ts`)

- **무엇**: Brave Search API(`GET {brave}/web/search`, `endpoints.brave` 기본 `https://api.search.brave.com/res/v1`)로 검색한다. 키는 사용자가 Brave에서 받은 것이다.
- **키**: 음성 입력 전용 키(3.9)처럼 own vault의 기능 키 `websearch-brave`(`vault\websearch-brave.dpapi`, DPAPI)다. 계정이 아니라 `accounts.json`에 없고, core의 integration·credential 표에도 없다(2026-10-19 SP 후속: core의 키 UI로 넣으면 `opencode-own.db`에 평문으로 남고, own-web은 core의 키 연결 API를 부르지 않기 때문이다, 01 §13). 사용자는 설정 > 웹 검색의 Brave 줄 아래 `Brave 키 넣기…`(own-web `websearch/brave-key.tsx`)로 넣고, own-web은 아래 `websearch.key.set`을 부른다. 환경 변수 `BRAVE_SEARCH_API_KEY`는 읽지 않는다(launcher가 넘기는 env는 셸 도구의 자식 프로세스가 물려받는다). 요청마다 `credentials.featureHeaders("websearch-brave", {header:"X-Subscription-Token"})`로 헤더만 받는다. 키는 로그·이벤트·RPC 답에 들어가지 않는다(상태와 끝 네 글자만).
- **등록**: Brave는 키 없이 쓸 수 없다. 그래서 키 없이도 쓰는 upstream 서비스와 달리 vault에 키가 있을 때만 core의 서비스 목록에 있다. 키 없이 목록에 두면 `random`이 키 없는 Brave를 뽑아 검색이 실패하기 때문이다. 설정 > 웹 검색은 키가 없을 때도 Brave를 고를 수 없는 `키 필요` 줄로 보이고 그 아래에 `Brave 키 넣기…`를 둔다(own-web만의 줄이고 core 목록과 `random`에는 들지 않는다, 03 §18.2). 키를 넣거나 빼면 `websearch.key.set`이 runtime broadcast `searchKey.changed{service}`를 보내고, 모든 Location이 vault를 다시 보고 상태가 바뀌었을 때만 접기를 다시 한다(core가 `websearch.updated`를 보내 목록이 바뀐다). `editor.default.set`은 하지 않는다. 원격 서비스에는 vault가 없으므로 호스트에서는 목록에 없다.
- **요청**: `q`(앞뒤 공백을 떼고 50단어·400자에서 자름, API 한도), `count=10`, `extra_snippets=true`. 검색어에 한글이 있으면 `search_lang=ko`, `country=KR`. 25초 안에 답이 없으면 실패다. 리다이렉트는 따르지 않는다(`redirect:"manual"`, 3xx는 `status_3xx`, SK-13 2026-10-23). 따라가면 키 헤더가 리다이렉트가 가리키는 호스트로 간다.
- **결과**: `web.results`를 core 결과로 옮긴다. http(s) 주소만, 주소당 하나, Brave 순서대로. 제목, 내용은 `description`과 `extra_snippets`(같은 글은 한 번)를 빈 줄로 이은 것이고 Brave의 `<strong>` 표시와 흔한 HTML 엔티티는 푼다. `page_age`(ISO 8601)가 읽히면 게시 시각이다(`age`는 "2 days ago" 같은 표시 글이라 읽지 않음). 웹 결과가 없는 답은 빈 결과다.
- **오류**: `Brave web search failed (<code>)`. 코드는 `no_key`, `vault_unavailable`, `auth`(401·403), `rate_limit`(429), `status_<n>`, `bad_response`, `empty_query`, `timeout`, `cancelled`, `network`다.
- **로그**: 검색마다 `websearch_query` 한 줄(`provider:"brave"`, `durationMs`, `results`, 실패면 `error`). 검색어와 키는 남기지 않는다.
- **알릴 것**: Brave는 검색어를 남과 나누거나 학습에 쓰지 않는다고 한다. 기록을 아예 남기지 않는 Zero Data Retention은 엔터프라이즈 요금제 기능이다(brave.com/search/api, 2026-10-19). 조사 보고서의 "구조상 ZDR"은 엔터프라이즈 기준이다. UI 안내는 `Brave 검색 · 직접 받은 키 · 1,000건에 약 $5(매달 $5 무료) · 검색어를 남과 나누거나 학습에 쓰지 않는다고 해요(기록을 아예 남기지 않는 ZDR은 엔터프라이즈 요금제만)`다.
- **시험**: 실제 키가 없어 가짜 서버로만 확인했다. `test/websearch/brave.test.ts`(`websearch.key.get/set`, vault의 기능 키, 키가 있을 때만 목록, 키를 넣고 빼면 다시 접기, 잘못된 키 거절, 기본 없음, 원격의 `remote_managed`, 요청 모양, 한국어 매개변수, 400자·50단어 자르기, 결과 옮기기, 오류 코드, 로그 위생), `services.e2e.test.ts`(실서버: 키 전에는 목록·integration 어디에도 없고, `websearch.key.set`으로 넣으면 목록에 나오고, 고르면 세션의 `websearch`가 Brave로 검색하며, 키는 DB와 WAL, 로그, 이벤트 어디에도 없다), own-web e2e `requests.spec.ts`(설정의 `Brave 키 넣기…` → 저장 → 목록에 `Brave`와 안내 → 지우기). ⚠ 실제 응답 모양과 품질은 확인하지 못했다.

**내 키로 쓰는 core 웹 검색 서비스 `own-exa`·`own-firecrawl`·`own-parallel`·`own-tavily`·`own-tinyfish`**(2026-10-23 SK. `src/websearch/keyed.ts`, 키 `src/rpc/search-key.ts`)

- **왜**: 사용자 결정(2026-10-23): 키를 받는 upstream 웹 검색 서비스의 API 키는 Brave처럼 own vault(DPAPI)에 둔다. core의 credential 표(`opencode-own.db`의 평문)에도, 환경 변수에도 두지 않고, 앱에서 지울 수 있어야 한다. upstream은 다섯 서비스(`packages/core/src/plugin/websearch/{exa,firecrawl,parallel,tavily,tinyfish}.ts`)에 `method: key`·`env` integration을 두고 키를 core의 integration 연결에서 읽는다. own-web은 core의 키 연결을 부르지 않는다(01 §13).
- **정한 길**: (a) own이 다섯의 키 쓰는 판을 자기 id로 등록하고 같은 upstream 주소로 직접 묻는다. (b) 검색 때 vault의 키를 core의 서비스에 넘기는 길은 없다: core의 활성 연결(`Integration.connection.active`)은 저장된 credential 행이거나 `process.env`의 환경 변수뿐이고(`core/src/integration.ts` `resolveConnections`), 저장하지 않는 credential을 받는 플러그인 API가 없다. 환경 변수에 넣으면 셸 도구의 자식 프로세스가 물려받고, credential로 넣으면 평문으로 남는다. 그래서 (a)이고 core 패치는 없다.
- **무엇**: 사용자의 키로 검색하는 own의 서비스 다섯이다. 이름은 `Exa (내 키)`, `Firecrawl (내 키)`, `Parallel (내 키)`, `Tavily (내 키)`, `TinyFish (내 키)`. core의 키 없는 같은 서비스(`exa` 등)는 키를 넣어도 그대로 무료로 목록에 남는다.
- **요청**: core의 요청을 옮겼다(upstream opencode, MIT, `1aae67e853`의 다섯 파일과 `mcp.ts`. check-surface `websearch-keyed-*`가 그 파일의 변화를 알린다). 주소·본문·헤더가 core와 같고, 키는 core가 두는 자리에 둔다.

  | id | 요청 | 키 |
  |---|---|---|
  | `own-exa` | `POST https://mcp.exa.ai/mcp` MCP `tools/call` `web_search_exa {query, numResults:8}` | 질의 매개변수 `exaApiKey`(`credentials.featureURL`) |
  | `own-firecrawl` | `POST https://mcp.firecrawl.dev/v2/mcp` `firecrawl_search {query, limit:8}` | `Authorization: Bearer` |
  | `own-parallel` | `POST https://search.parallel.ai/mcp` `web_search {objective, search_queries:[query]}` | `Authorization: Bearer` |
  | `own-tavily` | `POST https://api.tavily.com/search` `{query, search_depth:"basic", chunks_per_source:3, max_results:8}`, `X-Client-Name: opencode2` | `Authorization: Bearer` |
  | `own-tinyfish` | `POST https://agent.tinyfish.ai/mcp` `search {query}` | `X-API-Key` |

  MCP 요청은 TinyFish 말고는 `accept: application/json, text/event-stream`의 JSON-RPC 한 번이고(`initialize` 없음), Exa 말고는 core의 `User-Agent`(`opencode/<channel>/<version>/<name>`)를 보낸다. 답은 256 KiB까지 읽고 JSON 본문 또는 결과가 있는 첫 `data:` 줄에서 꺼내며, 25초나 도구 호출 취소에서 끝난다. TinyFish만은 v2.0.32부터 core처럼(86755e1cea) 검색 전에 MCP 세션을 연다. 키가 있는 `tools/call`은 `initialize`가 답한 `Mcp-Session-Id` 없이는 TinyFish가 거절하기 때문이다. 같은 헤더로 `initialize`(`protocolVersion` `2025-06-18`, `clientInfo` `opencode` `1.0`)를 보내고, 그 세션으로 `notifications/initialized`를 보낸 뒤 세션을 붙여 검색한다. 세션을 여는 두 단계는 검색과 따로 25초를 쓰고(답의 크기 한도, 도구 호출 취소, 아래 리다이렉트 규칙은 같다), `initialize`의 답에 세션이 없으면 `no_session`으로 실패한다. 검색마다 세션을 새로 연다. 그래서 TinyFish 검색 한 번은 요청 세 번을 차례로 보내고 최대 약 50초(세션 25초 + 검색 25초) 걸릴 수 있다. 새 호스트는 없다(core가 이미 쓰는 주소). 테스트 끝점이 주어졌는데 이 서비스의 끝점이 없으면 실제 호스트로 가지 않고 `no_endpoint`로 실패한다(Codex 버전 확인의 레지스트리와 같은 규칙). Brave처럼 리다이렉트는 따르지 않는다(3xx는 `status_3xx`, SK-13). 따라가면 TinyFish의 `X-API-Key` 같은 키 헤더가 다른 호스트로 간다(Bun은 다른 호스트로 갈 때 `Authorization`만 뗀다).
- **결과**: core가 옮기는 그대로다(Exa의 `Title:`·`URL:`·`Published:`·`Highlights:` 글, Parallel의 `structuredContent.results`, Firecrawl의 `data.web`, TinyFish의 `results`, Tavily의 `results`). 다른 점: http(s) 주소만 주소당 하나, MCP 결과의 `isError`(키의 크레딧이 다 됐거나 거절됨)는 빈 결과가 아니라 실패다(upstream #54311은 빈 결과로 읽음).
- **등록**: 그 서비스의 키가 vault에 있을 때만 모든 Location의 목록에 있다(키 없는 판은 core의 것이 있고, 키 없는 own 판을 두면 `random`이 뽑아 실패한다). Brave처럼 등록 뒤에 키를 찾고(플러그인 설정이 vault 도우미의 시작을 기다리지 않게), `searchKey.changed`에서 그 서비스만 다시 보고 상태가 바뀌었을 때만 다시 접는다. `editor.default.set`은 하지 않는다. 원격 서비스에는 vault가 없으므로 호스트에서는 목록에 없다.
- **여러 서비스 함께**: 선택(저장된 것이든 기본이든)의 키 없는 서비스는 `own-<서비스>`가 목록에 있는 동안 그것으로 묻고, 키를 지워 빠지면 다시 키 없이 묻는다. 같은 서비스는 한 번만 묻는다. 기본 선택에도 든다(사용자가 이 앱에 넣은 키다. 2026-10-23 사용자 확인). 그래서 설정 > 웹 검색의 비용 줄은 기본 선택에서도 그 키의 값을 더한다(03 §18.2). core에 키가 있는 서비스는 MS-7대로 기본에 들지 않는다. `own-tinyfish`는 요청 세 번을 차례로 보내 최대 약 50초 걸릴 수 있어서(위 요청), 다른 서비스가 먼저 결과를 내면 `own-multi`의 마감(결과가 있는 첫 답 8초 뒤, 늦어도 25초)에 잘리기 쉽다. 잘리면 그 검색은 `timeout`이고 요청은 취소된다.
- **오류**: `<이름> web search with your key failed (<code>)`. 코드는 `no_key`, `vault_unavailable`, `no_endpoint`, `auth`(401·403), `rate_limit`(429), `status_<n>`, `service_error`(MCP `isError`나 JSON-RPC 오류), `bad_response`, `too_large`, `empty_query`, `timeout`, `cancelled`, `network`다.
- **로그**: 검색마다 `websearch_query` 한 줄(`provider:"own-<서비스>"`, `durationMs`, `results`, 실패면 `error`). 검색어, 키, 요청 주소(Exa의 주소에는 키가 있다)는 남기지 않는다.
- **알릴 것**: 키를 넣으면 그 서비스의 요금이 붙는다(무료 몫 먼저, 위 표). TinyFish는 2026-05-04부터 무료다. 키의 사용량·남은 크레딧은 앱이 모른다(서비스의 대시보드).
- **시험**: 실제 키가 없어 가짜 서버로만 확인했다(e2e-kit `startFakeSearchServices`). `test/websearch/keyed.test.ts`(`websearch.key.get/set`의 다섯, 키가 있을 때만 목록과 다시 접기, 기본 없음, 서비스마다의 요청 모양과 키 자리·`User-Agent`·`X-Client-Name`, 결과 옮기기와 날짜, 실패 코드, 테스트 끝점 없는 `no_endpoint`, 로그 위생, `resolve`, 기본과 저장된 선택, `own-multi`가 키 판을 직접 부름), `keyed.e2e.test.ts`(실서버: 키 전에는 core의 다섯만, `websearch.key.set`으로 다섯 키를 넣으면 다섯 판이 목록에, 고르면 세션의 `websearch`가 `own-exa`로 `exaApiKey`와 함께 묻고 모델이 결과를 읽음, `여러 서비스 함께` 기본이 다섯 판에 한 번씩 묻고 함께 찾은 페이지가 먼저, 키는 DB·WAL·로그·이벤트 어디에도 없음, 키를 지우면 판이 빠지고 기본이 키 없는 서비스로 돌아감). ⚠ 실제 키로 응답 모양·품질·`isError` 문구를 확인하지 못했다.

**계정 관리**

`accounts.add.key` `{kind, label, key?, color?, options?:{baseURL?, organization?, project?, workspaceName?, models?:[{id, contextLimit?, outputLimit?, image?, tools?, reasoning?, cost?}], local?:{format}}}` →(`compat`는 `baseURL`과 `models`가 필요하다. `image`·`tools`는 `auto`|`on`|`off`, 없으면 `auto`, 3.3. `key`는 로컬 모델(`options.local`)만 생략할 수 있고 `reasoning`은 3.3a)

`accounts.local.detect` `{baseURL, format, key?}` → `{ok, status?, family?, models:[{id, context?, output?, image?, tools?, reasoning?}], latencyMs}`(3.3a, 아무것도 저장하지 않는다)
```json
{ "account":{ "id":"acc_…","providerID":"own-anth-w3p8","status":"ready" },
  "test":{ "ok":true,"detected":{"workspaceId":"wrkspc_…3kd","organizationId":null} },
  "sameDomainCandidates":[] }
```

`accounts.add.chatgpt.start` `{method:"device"|"browser"|"siwc", accountID?, consent?, retryOf?}`(`accountID`가 있으면 재인증, 대상은 method의 kind여야 한다. `consent`와 `retryOf`(다시 시도하는 끝난 새 계정 시도의 attemptID. 그 발급 client를 다시 쓴다)는 siwc 전용, 3.2c) →
```json
{ "attemptID":"att_…","method":"device","verificationURL":"https://auth.openai.com/codex/device","userCode":"ABCD-EFGH","expiresAt":1790001900000 }
```
browser 방식이면 `{attemptID, authorizeURL}`을, siwc면 `{attemptID, method:"siwc", authorizeURL, expiresAt}`을 돌려준다. UI가 그 URL을 연다.

`accounts.add.chatgpt.status` `{attemptID}` → `{phase:"pending"|"authorized"|"failed"|"cancelled", identity?:{emailMasked, plan}, duplicateOf?:accountID, error?}`. siwc의 `error`는 3.2c의 `token_sharing_not_granted`, `client_id_missing`, `client_id_invalid`, `client_mismatch`, `id_token_invalid`, `jwks_unavailable`를 더한다.

`accounts.add.chatgpt.complete` `{attemptID, label, color}` → `{account, reauthenticated:boolean}`
- 새 계정 흐름에서 `duplicateOf`가 있었으면 새 계정을 만들지 않고 그 계정의 토큰을 바꾼다. `reauthenticated:true`다(3.2 3번).

`accounts.add.chatgpt.cancel` `{attemptID}` → `{}`

**Codex 로그인 가져오기**(3.2a, 범위 `local`. 구현됨: `packages/own-protocol/src/rpc.ts:174-209,484-517`)

`accounts.import.codex.list` `{}` →
```json
{ "available": true,
  "sources": [
    { "profileID":"02","alias":"개인","importable":true,
      "identity":{"emailMasked":"ch***@gmail.com","plan":"pro"},
      "lastRefresh":"2026-09-26T22:14:05.123456789Z","importedAs":null },
    { "profileID":"05","alias":"테스트","importable":false,"problem":"token_expired",
      "identity":{"emailMasked":"te***@gmail.com"},"lastRefresh":"2026-08-01T10:00:00Z",
      "importedAs":{"accountID":"acc_01JB2Q…","mode":"linked"} } ] }
```
- `problem`: `unreadable | parse_failed | not_chatgpt | missing_tokens | token_expired | account_mismatch`.
- 토큰 값과 파일 경로는 없다.

`accounts.import.codex.plan` `{profileID, mode?:"linked"|"takeover", accountID?}`(`mode` 기본 `"linked"`) →
```json
{ "nonce":"non_…","expiresAt":1790001720000,"profileID":"02","alias":"개인","mode":"linked",
  "identity":{"emailMasked":"ch***@gmail.com","plan":"pro"},
  "duplicateOf":null,"warnings":["linked_depends_on_source"] }
```
- `warnings`: `linked_depends_on_source`, `takeover_supersedes_source`, `source_token_expired`.
- 오류: `source_not_found{profileID}`, `source_invalid{profileID, reason}`, `account_not_found`.

`accounts.import.codex.execute` `{nonce, label?, color?}` → `{account, mode, reauthenticated}`
- `reauthenticated:true`: `duplicateOf`나 `accountID` 대상의 credential을 바꿨고 새 계정은 만들지 않았다.
- takeover면 execute 안에서 강제 refresh까지 한다(3.2a 3번, F10).
- 오류: `nonce_invalid`, `account_not_found`, `source_not_found`, `source_invalid`, `template_unavailable`, `vault_unavailable`.

**이전 앱에 저장된 API 키 연결**(3.2b, 범위 `local`, 연결만 있음. `packages/own-protocol/src/rpc.ts` `accounts.import.keys.*`)

`accounts.import.keys.list` `{}` →
```json
{ "available": true,
  "keys": [
    { "providerRef":"legacy:deepseek","name":"DeepSeek","kind":"ds","baseURL":"https://api.deepseek.com",
      "models":["deepseek-flash"],"keySaved":true,"importable":true,"importedAs":null },
    { "providerRef":"dpapi:6a1d4b2f-8e3c-4d9f-8b7a-1c2d3e4f5061","name":"Lab","kind":null,
      "baseURL":"https://lab.example.test/v1","models":[],"keySaved":true,"importable":false,
      "problem":"unsupported_provider" } ] }
```
- 복호화하지 않는다. 키와 파일 경로는 없다. `problem`: `not_found | decrypt_failed | path_denied | invalid_key | unreadable | unsupported_provider | helper_outdated`.

`accounts.import.keys.plan` `{providerRef}` →
```json
{ "nonce":"non_…","expiresAt":1790001720000,"providerRef":"legacy:deepseek","name":"DeepSeek","kind":"ds",
  "label":"DeepSeek (이전 앱)","baseURL":"https://api.deepseek.com","model":"deepseek-flash","keyHint":"sk-…9fQ2",
  "duplicateOf":null,"warnings":["linked_key_depends_on_source"] }
```
- `providerRef`는 이전 앱의 `credential_ref`(`legacy:deepseek` 또는 `dpapi:<소문자 UUID>`)이고, 서버가 이것으로 경로를 만든다.
- `warnings`: `linked_key_depends_on_source`(항상), `model_not_in_template`.
- 오류: `legacy_key_not_found{providerRef}`, `legacy_key_invalid{providerRef, reason}`, `vault_unavailable`.

`accounts.import.keys.execute` `{nonce, label?, color?, dryRun?}` → `{account|null, dryRun, keyHint, test:{ok, skipped, detected?}}`
- 파일을 다시 읽고, 중복이면 `duplicate_account`. `dryRun`은 연결 테스트도 계정 생성도 하지 않고 nonce를 쓰지 않는다. 아니면 kind의 연결 테스트 뒤 계정을 만든다(vault에는 쓰지 않음).
- 오류: `nonce_invalid`, `legacy_key_not_found`, `legacy_key_invalid`, `probe_failed`, `duplicate_account`, `template_unavailable`, `vault_unavailable`.

`accounts.test` `{accountID}` → `{ok, status?, detected?, latencyMs}`
- `compat` 계정은 통과하면 서버를 다시 읽는다(서버 종류, 출력 한도, 모델의 그림 입력과 도구, 3.3).

`accounts.update` `{accountID, label?, shortLabel?, color?, autoSwitch?, budget?, replaceKey?, refreshCatalog?, enabled?, pollBalance?, compaction?, dryRun?, remote?, compatCapabilities?, local?}`(`compatCapabilities[].reasoning`과 `local`(`{format}` | `null`)은 compat만, 3.3a) → `{account, compactionImpact?}`
- `compatCapabilities`(2026-10-18): `[{id, image?, tools?}]`, 값은 `auto`|`on`|`off`. `compat` 계정만 받는다(다른 kind는 `policy_denied{field:"compatCapabilities"}`). 계정에 없는 모델 id가 하나라도 있으면 아무것도 저장하지 않고 `policy_denied{field:"compatCapabilities"}`다. 없는 필드는 그대로, `auto`는 서버 값을 다시 따른다. 등록이 바뀐 모델의 대화는 다음 요청에서 캐시를 한 번 새로 쓴다(3.3).
- `refreshCatalog`은 그 kind의 템플릿을 갱신한다(모든 slot에 적용, 2.4.2). 다음 요청 cold를 경고한다.
- `pollBalance`는 ds·or·xai 계정에서만 받는다(7.2 poller). 다른 kind에 주면 `policy_denied{field:"pollBalance"}`다.
- `acc_claude_slot`은 `label`, `shortLabel`, `color`만 받는다. 나머지(`compaction` 포함)는 `policy_denied`.
- 이전 앱 API 키를 연결한 계정(3.2b)의 `replaceKey`는 `policy_denied{field:"replaceKey"}`다. 키는 이전 앱에서 바꾸고, 이 계정은 그 파일을 따라간다.
- `compaction`(이번 판에서 추가): `Compaction.Setting | null`(4.7.3). `null`이면 계정 값을 지우고 kind 기본값을 따른다. 필드 범위를 벗어나면 `setting_out_of_range{field, min, max}`다(`triggerPercent` 10–90, `maxTriggerTokens` ≥ `T_floor`, `minReserveTokens` < 원래 창).
  - 저장하면 레지스트리 revision을 올리고 slot을 다시 등록한다(3.8). 캐시에 영향이 없다(4.3 D6).
- `dryRun`(이번 판에서 추가, `compaction`과 함께만 뜻이 있다): 저장하지 않고 `compactionImpact`만 돌려준다.
  - `compactionImpact`: `{sessions:[{sessionID, P, triggerTokens, truncates, revertStaged?}]}`. 이 계정 slot에 묶인 세션 중 `P ≥ 새 기준`인 것이다. `truncates`는 다음 자동 압축의 요약이 새 예산을 넘어 오래된 교환을 버릴 것인지다(4.7.5). `revertStaged:true`인 세션에는 "먼저 압축한 뒤 적용"을 권하지 않는다(4.7.4). 저장할 때도 같은 값을 돌려준다.

**파괴적 동작: 2단계(`plan` → nonce → `execute`)** — 01 §13 규칙
- `plan`은 부작용이 없고, 영향 범위와 `nonce`(1회용, 2분 유효, `own-runtime` 메모리에만 둠)를 돌려준다.
- `execute{nonce}`는 그 nonce가 가리키는 계획만 실행한다. 만료·재사용·다른 메서드의 nonce는 `nonce_invalid`다.
- UI는 `plan` 결과를 확인 대화상자로 보여 준 뒤에만 `execute`를 부른다.

`accounts.remove.plan` `{accountID, mode:"disable"|"delete"}` → `{nonce, expiresAt, affectedSessions:[sessionID], willShredVault:boolean}`
- linked 가져오기 계정은 vault 항목이 없으므로 `willShredVault`가 항상 `false`다. 원본 `auth.json`은 어느 경우에도 건드리지 않는다(3.2a). 이전 앱 API 키를 연결한 계정(3.2b)도 같다: 우리 참조만 지우고 이전 앱의 키 파일은 건드리지 않는다.

`accounts.remove.execute` `{nonce}` → `{account}`
- `disable`: vault는 남긴다. 계정 `status:"disabled"`, slot 모델 `enabled:false`. 되돌릴 수 있다(`accounts.update{enabled:true}`).
- `delete`: vault 파일을 crypto-shred(helper `delete{shred:true}`)하고 slot을 **retire**한다.
  - slot은 등록된 채로 남고 모든 모델이 `enabled:false`다. 계정 `status:"retired"`.
  - providerID는 재사용하지 않는다(R-ID-3, 01 §8.1). 과거 턴의 `step.started.model.providerID`가 계속 이 계정으로 귀속된다.
- 두 경우 모두 세션은 그대로 둔다. 다음 턴에 대상을 고르라고 제안한다(03 제거 확인 문구 `이 계정을 쓰는 세션 4개는 다음 턴에 다른 계정을 골라야 합니다.`).

**정책과 기타**

`policy.get` `{}` → `{policy, compactionDefaults}` / `policy.set` `{patch, dryRun?}` → `{policy, compactionImpact?}`
- `autoSwitch.subscriptionToSubscription`과 `autoSwitch.subscriptionToApi`에 `"auto"`, `toClaudeSlot`에 `"off"`가 아닌 값, 구독 slot이 둘 이상 들어간 자동용 chain은 `policy_denied`로 거부한다(5.10).
- `policy.compaction.byKind`(이번 판에서 추가, 2.4.3): kind 기본값의 사용자 변경분이다. `claude-sub`는 `policy_denied{field:"compaction.byKind.claude-sub"}`, 범위를 벗어나면 `setting_out_of_range`다. `dryRun`과 `compactionImpact`는 `accounts.update`와 같고, 그 kind의 모든 slot에 묶인 세션을 본다.
- `compactionDefaults`(출력만): 4.7.3 표의 코드 상수 `Record<kind, Compaction.Setting>`. 설정 화면이 기본값으로 재설정하는 동작과 출처 표시에 쓴다. 버튼 문구는 03이 정한다("되돌리기"는 `switch.undo` 전용, "복원"은 revert 전용이라 둘 다 쓰지 않는다, 03 §18.7).
- `policy.outputLimit`(4.9, 2026-10-19): `patch.outputLimit`은 `{mode, maxTokens}`를 통째로 바꾸고 `null`은 지운다(기본으로). `maxTokens`가 4,096–1,000,000 밖이면 `setting_out_of_range{field:"outputLimit.maxTokens", min, max}`다. 이전 서비스는 모르는 필드를 버리므로, own-web은 답의 `policy`에 보낸 값이 없으면 `이 서비스는 이 설정을 아직 몰라요`를 보인다.
- `policy.compaction.keepTokens`(v0.4, 4.7.6 (가)): get은 own 전역 설정 파일에서 읽은 값, set은 그 파일의 `compaction.keep.tokens`만 고친다. `policy.json`에는 저장하지 않는다. 사용자 결정(Q29) 전에는 03이 이 칸을 보이지 않거나 읽기 전용으로 둔다.

`ratecards.get` `{}` / `ratecards.set` `{cards}`

`session.presence` `{sessionID}` → `{}`(CC-14, 4.7.7). 세션 메서드(그 세션의 location), 범위 `read`. 클라이언트가 그 대화를 보이는 화면에 띄워 두고 지난 1분 안에 손댔을 때 1분마다 보낸다(own-web의 입력창, 따로 기다리는 시간 없음, CC-16). 서비스는 대화마다 마지막 시각만 메모리에 두고, `policy.awayDetect`가 켜져 있으면 그 뒤 `hiddenMinutes` 동안 자리 비움 압축을 하지 않는다(`present`). 넣은 자리 비움 압축이 그 신호 뒤에 전달되면 버린다(4.7.7). 그 밖에는 아무것도 바꾸지 않는다. 이 메서드가 없는 이전 서비스에는 클라이언트가 실패를 버린다.

`plugin.claudeAuth.ack` `{version, integrity, noticeHash, patchSha256?}` → `{acknowledgedAt}`. 2026-10-18부터 입력을 보지 않고 아무것도 저장하지 않는다(로컬 동의 없음, 8.4). 옛 클라이언트를 위해 남겼다.

`plugin.claudeAuth.install.plan`·`install.execute`·`uninstall.plan`·`uninstall.execute`(2026-10-18 전: 템플릿 복사·`npm ci`·설정 편집, 제거·credential 삭제): 스키마는 그대로 두고, 부르면 `internal_error`("built_in: the Claude plugin ships with the app and is always on")로 거절한다(8.2 9번).

`plugin.claudeAuth.changeSource.plan` `{configDir: string|null, leaveOwnLogin?: boolean}` → `{nonce, expiresAt, runningSessions:[sessionID], credentialsFound:boolean, restartRequired:true}`
- `configDir:null`은 기본값(`%USERPROFILE%\.claude`)으로 돌아가기다. 절대 경로가 아니거나 own의 로그인 폴더(`<OWN_HOME>\claude-accounts` 아래, 경로나 realpath로, `leaveOwnLogin`이 있어도)면 `setting_out_of_range{field:"configDir"}`(8.7 CS 재검토 h).
- 계정 1이 own 폴더(`claudeSlot.configDir`)에 있으면 `claude_account_unavailable{reason:"own_login"}`이다. `leaveOwnLogin: true`면 그 폴더를 떠나 이 소스로 간다(8.7 CS).

`plugin.claudeAuth.changeSource.execute` `{nonce}` → `{clientAction:{type:"restart-service"}}`. 실행 중인 세션이 있으면 `session_busy`(8.7). 계획 뒤 own 폴더로 옮겼고 `leaveOwnLogin`이 없었으면 `claude_account_unavailable{own_login}`. 계획 뒤 소스 폴더가 own의 로그인 폴더가 됐으면(정션) `nonce_invalid`.
- 돌려주기 전에 `OWN_HOME\claude-auth.json`에 `configDir`을 쓴다(8.7 계약). 재시작 뒤 launcher `Get-BridgeEnv`가 이 값을 서비스 env `CLAUDE_CONFIG_DIR`로 넣는다(8.3 I8 예외).

`plugin.claudeAuth.importSubscription` `{}` → `{ok, connection}`

`plugin.claudeAuth.remote.ack` `{version, integrity, noticeHash}` → `{acknowledgedAt}`. SSH 원격 호스트에서 이 슬롯을 쓰는 동의(KV `ack:claudeRemote`, 8.4a)다. `version`·`integrity`는 번들의 pin(`status.bundle`), `noticeHash`는 원격 고지 해시(`status.remote.noticeHash`)다. 다르면 `ack_required{reason:"stale"}`. 원격에서는 `remote_managed`(04 §8.11.12).

`plugin.claudeAuth.remote.set` `{hostId, enabled}` → `{hostId, enabled, state}`. 그 호스트를 `accounts.json`의 `claudeSlot.remoteHosts`에 넣거나 뺀다. 켜기는 원격 동의가 유효해야 하고(`ack_required{reason:"remote"}`), claude-auth가 감지되어 있어야 한다(`plugin_not_installed`). 끄기는 언제나 되고 그 호스트의 진행 중 중계를 멈춘다. `state`는 04 §8.11.4.3의 판정이다.

`plugin.claudeAuth.fastAck` `{}` → `{at}`. 이 슬롯의 Fast가 추가 사용량을 쓴다는 동의를 이 PC의 KV `ack:claudeFast`에 기록한다. 원격 세션의 `session.speed.set`이 `speed_consent_required{recordOn:"local"}`로 거절한 뒤 own-web이 부른다(04 §8.11.9).

**여러 Claude 계정과 패치(2026-10-10, 8.2 3번·8.7)**. `status`는 `patch:{state, sha256, loaded}`와 2026-10-18부터 `bundle:{version, integrity, patchSha256, buildId}|null`을 더 돌려준다. `patch.plan`·`patch.execute`는 2026-10-18부터 `internal_error`("built_in")로 거절한다(번들은 빌드 때 패치됨).

| 메서드 | 범위 | 입력 → 출력 | 오류 |
|---|---|---|---|
| `plugin.claudeAuth.patch.plan` | local | `{}` → `{nonce, expiresAt, sha256, runningSessions, restartRequired:true}` | `ack_required`, `plugin_not_installed`, `remote_managed` |
| `plugin.claudeAuth.patch.execute` | local | `{nonce}` → `{clientAction:{type:"restart-service"}}` | `nonce_invalid`, `session_busy`, `ack_required`, `plugin_not_installed`, `remote_managed` |
| `plugin.claudeAuth.accounts.add.plan` | local | `{accountID?}` → `{nonce, expiresAt, cli\|null, folder, move?}`(`accountID`: 그 계정의 다시 로그인, 2026-10-18. 그 계정이 읽기 전용(Claude Code가 쓰는 폴더나 그 정션·링크, 부를 때 다시 읽음)이면 `move: true`, 새 own 폴더로 옮김, 8.7 CS) | `plugin_not_installed`, `claude_account_unavailable`, `account_not_found`, `remote_managed` |
| `plugin.claudeAuth.accounts.add.execute` | local | `{nonce}` → `{attemptID}` | `nonce_invalid`(다시 로그인으로 계획한 폴더가 그사이 읽기 전용이 됨, 8.7 CS), `claude_account_unavailable{cli_missing\|not_patched\|busy}`, `remote_managed` |
| `plugin.claudeAuth.accounts.add.status` | local | `{attemptID}` → `{state: waiting\|added\|duplicate\|mismatch\|failed\|timeout, accountID?, label?}`(`mismatch`: 옮기기의 로그인이 다른 Claude 계정, 아무것도 안 바뀜, 8.7 CS) | `nonce_invalid`, `remote_managed` |
| `plugin.claudeAuth.accounts.detect` | local | `{}` → `{found:{folder, email}\|null, imported}` | `remote_managed` |
| `plugin.claudeAuth.accounts.remove.plan` | local | `{accountID}` → `{nonce, expiresAt, boundSessions, deleteFolder:{offered, default}}` | `account_not_found`, `remote_managed` |
| `plugin.claudeAuth.accounts.remove.execute` | local | `{nonce, deleteFolder}` → `{movedSessions, folderDeleted}`(계획 뒤 읽기 전용이 된 폴더는 지우지 않음, 8.7 CS) | `nonce_invalid`, `account_not_found`, `remote_managed` |
| `plugin.claudeAuth.session.get` | read, session | `{sessionID}` → `{accountID, bound}` | — |
| `plugin.claudeAuth.session.set` | switch, session | `{sessionID, accountID}` → `{accountID, sessions}` | `account_not_found`, `claude_account_unavailable{not_patched}` |
| `plugin.claudeAuth.default.set` | switch | `{accountID}` → `{accountID}` | `account_not_found`, `claude_account_unavailable`, `remote_managed` |
| `claudeAgent.status` | read | `{}` → `{account: {accountID, folder, loggedIn, email?, plan?} \| null, cli, command, login}`(8.10.8) | `remote_managed` |
| `claudeAgent.setup` | local | `{}` → 위와 같음. 폴더와 계정을 만들고 provider를 켠다(멱등) | `remote_managed` |
| `claudeAgent.login` | local | `{}` → 위와 같음. Claude Code의 로그인 창을 연다 | `account_not_found`, `claude_account_unavailable{cli_missing\|busy}`, `remote_managed` |
| `claudeAgent.remove` | local | `{deleteFolder}` → `{folderDeleted}` | `account_not_found`, `remote_managed` |
| `claudeAgent.limits.refresh` | read | `{}` → `{windows, plan}`(8.10.4) | `account_not_found`, `claude_account_unavailable`, `remote_managed` |

새 오류 `claude_account_unavailable{reason: cli_missing|not_patched|busy|own_login}`(`own_login`은 `changeSource.plan`·`execute`, 8.7 CS), 새 경보 `claude_account_switched`(8.8)·`claude_account_refused`(8.3 I9).

**프로젝트 플러그인 승인**(01 §13.2, 4.2 allowlist). 승인은 파괴적 동작 규칙(2단계)을 따른다. 전역 메서드이므로 control location으로 부른다.

`plugin.trust.list` `{}` →
```json
{ "locations":[
  { "directory":"D:\\tmp\\cloned","status":"blocked_by_plugin",
    "plugins":[{"id":"x","source":"local:D:\\tmp\\cloned\\.opencode\\plugins\\x.ts","sha256":"9f1c…","approved":false}] },
  { "directory":"D:\\work\\repo","status":"ok","plugins":[] } ] }
```
- `plugins[]`는 allowlist 기본 항목(builtin, own 플러그인, `thirdparty\claude-auth`)을 뺀 나머지다. `approved`는 `trust.json`에 같은 `{location, source, sha256}`가 있는지다.

`plugin.trust.approve.plan` `{directory, sources: string[]}` → `{nonce, expiresAt, directory, plugins:[{id, source, sha256}], warning}`
- 서버가 지금 파일의 SHA-256을 계산해 돌려준다. `warning`은 "승인한 플러그인은 서비스 프로세스 안에서 실행되며 인증 헤더를 볼 수 있습니다" 계열 고지다(01 §13.2 "정직한 한계").

`plugin.trust.approve.execute` `{nonce}` → `{directory, status:"ok"|"blocked_by_plugin"}`
- `trust.json`에 `{location, source, sha256, approvedAt}`를 쓰고, 모든 Location이 allowlist를 다시 검사하게 한다(3.8). plan 뒤 파일이 바뀌어 해시가 다르면 `trust_hash_mismatch`다.
- 같은 Location에 승인하지 않은 플러그인이 남아 있으면 `status`는 계속 `blocked_by_plugin`이다.

`plugin.trust.revoke` `{directory, source}` → `{directory, status}`. 승인을 지우고 다시 검사한다. 보호를 강하게 하는 방향이라 1단계다.

`diagnostics.selfTest` `{}` → `{slots:[{providerID, ok, problems[], authSwap:"ok"|"broken"|"unknown"}], secretScan:{ok, findings[]}, defaultModel:{ok, warning?:"default_model_own_slot"}, surface:{ok, changed:[…]}, agentModels?:{ok, removed:[{agent, model}]}}`(4.2, 10.1)
- `agentModels`(T0, 07 §5.4 "내장 에이전트의 모델"): 설정 `model`이 own 구독 slot이라 `agent.transform`이 지운 숨긴 에이전트(title, summary …)와 그 모델(`Model.Ref`). 지운 것이 있으면 `ok:false`이고 경보 `internal_agent_model_removed`가 에이전트·모델마다 한 번 나간다. 프로젝트 설정의 `agents.<id>.model`은 그 프로젝트의 Location에서만 접히므로, control location에서 답하는 selfTest는 runtime broadcast `agents.removed.query`로 살아 있는 모든 인스턴스의 결과를 모은다. 이 검사가 없는 빌드는 필드를 보내지 않는다.

**실계정 증거 수집**(7.8, P0-3a). 셋 다 전역 메서드(control location)이고 범위는 `local`이다. 결과는 모두 `CaptureStatus`다.

`diagnostics.capture.start` `{mode:"hash"|"shape", minutes?:1–1440(기본 30), sessionID?, providerIDs?:[…](1개 이상)}` → `{active, window:{id:"cap_<ULID>", mode, startedAt, until, endedAt|null, end:"stopped"|"expired"|"replaced"|"shutdown"|null, sessionID|null, providerIDs|null, records, dropped, steps, dir, files[]}|null}`
- 돌던 창은 `replaced`로 먼저 끝난다. `dir`은 `<OWN_HOME>\diagnostics\captures`, `files`는 그 아래 상대 경로(`<YYYY-MM-DD>/<sessionID>.jsonl`, 요약 `windows.jsonl`)다. `steps`는 창이 도는 동안 그 세션·slot의 own slot usage 줄 수다.

`diagnostics.capture.stop` `{}` → 같은 모양. 돌던 창을 `stopped`로 끝내고 읽는 중인 줄을 최대 2초 기다린 뒤 요약 줄까지 쓰고 답한다. 아무것도 쓰지 못한 창이면 `capture_empty`(7.7)가 나간다. 돌던 창이 없으면 상태를 그대로 돌려준다.

`diagnostics.capture.status` `{}` → 같은 모양. 돌던 창이 없으면 이 프로세스가 마지막으로 돌린 창(`active:false`), 그것도 없으면 `window:null`이다.

**프리셋**(07 §8.1의 T0 부분: 묶음마다 하나인 새 대화 기본 모델, 07 §2.2). 범위는 `presets.list`가 `read`, `presets.defaults.set`이 `admin`이고, 둘 다 control location(전역 메서드, 9.1)으로 부른다. 저장은 `OWN_HOME\presets.json`(계정이 아니라 묶음이 키, `accounts.json`에 두지 않음)이고 형식은 `Preset.File`이다.

`presets.list` `{group?}` → `{groups:[{group, defaultModel:{id, variant?, source:"auto"|"user", basis?, missing?}|null}]}`
- 살아 있는 계정이 있는 묶음과 `presets.json`에 있는 묶음을 돌려준다. 계정이 없는 묶음은 `defaultModel:null`이다.
- 아직 쓰지 않은 `auto` 값은 답할 때 계산만 하고 파일에 쓰지 않는다(`read`). `auto` 값을 쓰는 것은 서비스뿐이다(묶음의 첫 계정, T0 이전 사용자의 한 번 정하기, 07 §2.2). `basis`는 `auto`를 정한 근거(`codex-config`, `codex-meta`, `family-price`, `newest`, `first`)이고 화면의 출처 문구(`Codex 설정을 따름`)가 된다. `missing`이면 그 묶음의 살아 있는 계정에 그 모델이 없다.

`presets.defaults.set` `{group, defaultModel?: {id, variant?}|null}` → `{group, defaultModel}`(위 `groups[]`의 한 줄)
- 값을 주면 그 묶음의 `user` 값이 된다(카탈로그가 바뀌어도 바꾸지 않음). `null`이면 `auto`로 돌아가 지금 2.2 규칙으로 다시 정한다. 성공하면 leader가 `presets.changed`를 낸다(9.3). 원격 모드에서는 `remote_managed`다.

**프리셋 T1**(07 §8.1 전체. 모양은 `@own/protocol` `Preset`이 기준). 전역 메서드는 control location, `session.*`는 그 루트 세션의 location이다. 원격 모드(T3 전)에는 묶음마다 `평소대로`만 있고 쓰기는 `remote_managed`다(07 §8.1 원격).

`presets.list` `{group?}` → `{groups: GroupView[], newSession?, recent?, ultraCaps?}`
- T1의 `GroupView`: `{group, defaultModel, presets?: [{…Info, status:"ok"|"needs_repair", …}], star?, lighter?: {<mainModelID>:{model, source, missing?}}, status?, label?}`. 그 묶음의 저장한 프리셋(★ 먼저), ★, 가벼운 짝 표, 묶음 기본 모델의 출처 문구. 전역 `newSession`(`star`|`last-light`), 최근 프리셋, 전역 울트라 상한 단계(처음 값 `recommended`).

`presets.suggest` `{group, template?: "light-split"|"cross-review"|"local-explore"}` → `{draft, rows:{<role>:{targets, fill}}, starters:[{template, available, problem?}], pool?: {candidates: PoolCandidate[], recommended: string[]}}`
- 살아 있는 카탈로그로 역할마다 추천을 채운 초안(07 §3.4). 종량제·선불 대상은 넣지 않는다. 같은 회사의 다른 구독은 후보에도 없다. 실행 창이 확인되지 않은 로컬 모델은 제안하지 않는다(경보 `local_window_unverified`). `siwc` 계정은 `codex`처럼 `openai` 카탈로그 가격으로 줄 세운다(07 §3.4). 시작 틀은 쓸 수 없으면 `available:false`와 이유(`no-other-subscription` 등).
- `pool`(선택, T4 모델 묶음, 07 §3.4): 모델 묶음이 받을 수 있는 모델과 `추천 묶음`의 이름들이다. `PoolCandidate`는 모델 묶음 항목(`{key, model, account?, card}`, `account`가 없으면 메인 계정 항목)에 사실(`runs?`, `company?`, `price?`)과 `released?`를 더한 것이다. 순서는 메인 계정의 모델, 다른 회사 구독(회사마다 여유가 가장 큰 계정부터, 같은 모델은 같은 이름), 로컬(확인하지 못한 것은 `windowVerified:false`), 돈 드는 계정이다. `recommended`에는 돈 드는 항목이 없다. 옛 서비스의 답에는 없으므로 클라이언트는 그때 모델 묶음 선택지를 숨긴다.

`presets.set` `{preset: {id?, name, group, workers, delegation, caps, ultraCaps}, dryRun?, refreshCards?}` → `{preset, resolution, warnings:[{code:"paid"|"local-unverified", place}], dryRun}`
- 새로 만들 때는 `id`를 빼고, 고치면 `revision`이 1 오른다. R4는 팀 없이(메인 `null`, 묶음의 어느 계정이든 메인일 수 있음) 판정하고 위반이면 저장하지 않는다(`same_company_subscription{accountID}`). 모르는 대상이나 도구를 못 쓰는 대상은 `preset_target_unavailable{role}`, 다른 묶음 id는 `preset_wrong_group`, `평소대로`는 `preset_builtin_locked`. `resolution`은 그 묶음의 첫 살아 있는 계정의 새 대화 기본 모델로 해석한 미리 보기다.
- 모델 묶음(T4, 07 §2.1·§8.1): `workers.pool`이 비어 있지 않으면 `mode:"same"`과 `pool`로 저장한다. 형식(1–12개, 모델 묶음 이름 형식, 메모 120자 이하, 이름과 대상이 겹치지 않음)을 어기면 `internal_error` `pool_invalid`이고, 명시적인 빈 `pool: []`도 여기에 든다. 지금 쓸 수 없는 새 항목은 `preset_target_unavailable{role:"pool:<key>"}`다. 카드는 서비스가 얼린다: 새 항목은 지금 계산하고, 이름과 대상이 같은 항목은 저장된 카드를 두며, 클라이언트가 보낸 카드는 버린다. `refreshCards?: true`면 모든 카드를 다시 얼린다(`카드 새로 고치기`). `warnings[].place`와 `resolution.pool?`(항목마다 Ref나 건너뛴 이유와 사실)은 `Spot`(`pool:<key>`)을 쓴다.

`presets.remove` `{presetID}` → `{presetID, group, star}`
- 그 프리셋을 쓰던 세션은 묶음의 ★로 간다(★가 지워지는 프리셋이면 ★는 `평소대로`). `presets.changed{removed}`를 낸다.

`presets.defaults.set`(T1 전체) `{group, defaultModel?, star?, lighter?:{mainModelID, model}, newSession?, ultraCaps?}` → `GroupView`
- `star`에 `평소대로` id를 주면 ★를 지운다. `lighter`는 그 메인 모델의 짝을 `source:"user"`로 정한다. `newSession`·`ultraCaps`는 전역 값이다.

`session.preset.get` `{sessionID}` → `{binding: Binding|null, preset: Info|null, resolution|null, caps, counts:{running, message, session}, spend}`
- 바인딩(`team` 포함), 지금 프리셋과 지금 메인으로 해석한 결과, 울트라를 반영한 상한, 실행 중·이번 사용자 메시지·이번 대화의 하위 에이전트 수, 이번 대화의 종량제 금액(USD, 자식 ledger 합).

`session.preset.apply` `{sessionID, presetID, team?: Team|null, dryRun?}` → `{binding, resolution, entry:"unchanged"|"written"|"removed", dryRun}`
- 루트를 그 메인 계정 묶음의 프리셋에 묶는다. 세션의 직렬 작업 줄에서 돌고 `own.preset` 지시 항목을 쓴 뒤에 돌아온다(07 §3.3). 메인을 바꾸지 않으므로 `estimate`가 없다. `team`은 06 own.team만 넘긴다: 빼면 저장된 값을 두고, `null`이면 지운다. 다른 묶음 프리셋은 `preset_wrong_group{group}`, 팀 문맥에서 R4가 깨지면 `same_company_subscription{accountID}`이고 바인딩은 그대로다(07 §5.3). 단 같은 세션에 이미 묶인 프리셋을 새 `team`으로 다시 부를 때 그 프리셋 자신의 고정 대상만 R4를 깨면 받아들인다(T1, 관문이 그 역할을 다음 대상이나 `메인과 같게`로 돌리고 own.team이 수리 알림을 냄, 06 §10.1, 07 §8.1). 성공하면 `session.preset.changed`.

`session.ultra.set` `{sessionID, on, raiseClaude?, dryRun?}` → `{on, variant:{from, to}, estimate: Estimate.Result|null, switch?, dryRun}`
- 울트라를 켜거나 끈다(07 §2.9). 메인 강도가 바뀌는 회사면 02 variant 전환이다: `dryRun`이면 `estimate`만, 아니면 적용한 `switch`도 돌려준다. Claude(`claude-sub`, `anth`)는 강도를 바꾸지 않고 `raiseClaude`일 때만 `xhigh`로 올린다. 바인딩의 `ultra.before`에 켜기 전 variant를 적어 끌 때 돌아간다. 메인이 다른 계정·모델로 옮기면 울트라 강도를 다시 정한다: effort 갱신 경로면 바로 바꾸고, 아니면 `ultra.pending`(그 강도)을 적어 클라이언트가 비용 창으로 묻게 한다. 이 호출(`on:true`)이 그 강도로 바꾸고 `pending`을 지운다(07 §2.9, 2026-10-02 T1 리뷰 수정).

`session.preset.raiseOnce` `{sessionID, perMessage?}` → `{perMessage}`
- 지금 사용자 메시지의 `perMessage` 상한만 늘린다(칩의 `이번 메시지만 늘리기`, 07 §2.6). 값이 없으면 그 메시지가 요청한 수까지. `sess:<root>:presetUsage.raise`에 적는다.

`session.preset.consent` `{sessionID, accountID, allow}` → `{accountID, allow}`(스펙 추가, 07 §5.4 4단계)
- 역할이 구독 대상에서 종량제 계정으로 넘어갈 차례일 때 화면 카드(`[이 대화에서만] [아니오]`)의 답. 이 대화에만 적용하고(`sess:<root>:presetConsent`) 예산을 넘지 않는다: 예산을 다 쓴 계정의 허락은 `preset_budget_exhausted`, 모르는 계정은 `account_not_found`. `allow:false`면 그 역할은 종량제를 건너뛰고 목록의 다음(끝이면 `메인과 같게`)으로 간다.

**속도**(4.8, 2026-10-06. 세션 메서드, 루트의 값. 메서드는 68개, 이벤트는 18개)

`session.speed.get` `{sessionID}` → `Speed.View` `{sessionID, root, choice, effective, tier|null, offers: Offer[], fixed?, consent?: "needed"|"given", beta, served?, none?}`
- `choice`는 루트에 저장된 속도, `effective`·`tier`는 다음 요청이 보내는 것(대체 뒤, 자식은 물려받은 것)이다. `offers`는 그 세션 메인의 계정·모델이 지금 주는 속도(`{choice, tier, wire, basis:"account"|"catalog", status:"available"|"unverified"|"unavailable"|"cooldown", until?, reason?, name?, description?, billing?}`)이고 `billing`은 배지의 근거(`plan{included, credits}`, `api{input, output}`, `extra{input, output}`)다. `fixed`는 메인이 카탈로그 모드 항목일 때, `consent`는 Claude 구독 슬롯일 때만 있다. `served`는 루트의 마지막 Fast 요청이 받은 tier다. `none`(2026-10-10, 옛 서비스에는 없음)은 `offers`가 비고 `fixed`도 없을 때의 이유다: `provider`, `kind`, `model`, `session`(아직 모르는 세션, 4.8 "새 대화와 전환기").

`speed.offers` `{providerID, modelID}` → `Speed.Targeted` `{providerID, modelID, offers: Offer[], fixed?, consent?, none?}`(2026-10-10. `read`, 제어 위치)
- 세션 없이 그 메인이 지금 주는 속도다. 같은 메인의 `session.speed.get`과 같은 `offers`·`fixed`·`consent`·`none`이다. 새 대화 입력창과 전환기의 `속도` 줄이 읽는다. 원격 서버는 자기 슬롯으로 답한다.

`session.speed.set` `{sessionID, speed, dryRun?, consent?}` → `{view: Speed.View, change: Speed.Change|null, dryRun}`
- 루트의 속도를 바꾼다(자식의 호출은 그 루트). `dryRun`이면 바꾼 뒤의 `view`와 비용(`change`, 6.3 ⑬)만 돌려주고 저장하지 않는다. 메인이 그 속도를 주지 않으면 `speed_unavailable{speed, reason}`(`not_offered`, `unavailable`, `cooldown`, `fixed_model`, `no_model`), Claude 구독 슬롯의 첫 Fast에 `consent`가 없으면 `speed_consent_required`다. 바뀌면 `session.speed.changed{reason:"user"}`.

**프리셋 T2**(07 §4.3–§4.5, §7.2. 새 메서드는 없고 모두 선택 필드라 T1 클라이언트·서비스가 그대로 읽는다).
- `presets.list` → `repairs?: Repair[]`: 사라진 모델 하나에 알림 하나(`{model, uses}`). `uses`는 그 모델을 쓰던 곳마다 `{kind:"pin", group, presetID, place, account, suggestion?}`(프리셋의 고정 자리), `{kind:"lighter", group, main, suggestion?}`(메인 모델 `main`의 가벼운 짝), `{kind:"default", group, suggestion?}`(묶음의 새 대화 기본 모델)이다. `suggestion`은 서비스가 채운다: 고정 자리는 후속 모델(`Preset.successor`), 짝은 07 §4.2 규칙의 결과, 기본 모델은 새 대화가 지금 시작하는 모델. `GroupView`에 `history?`(수리 기록, 오래된 것 먼저)와 `retirements?`(그 묶음의 프리셋·짝·기본 모델이 쓰는 모델 → Codex 은퇴 시각 epoch ms, 흐린 날짜 표시만).
- `presets.set` `{…, repairOf?: {model, place}}`: 이 저장이 사라진 `model`을 `place`에서 고친다. 저장된 프리셋이 그 자리에 그 모델을 고정해 두었을 때만 `presets.json` `groups[g].history`에 `{at, presetID, place, from, to}`를 더한다. 저장된 프리셋이 같은 자리에 이미 가진 고정은 그 모델이 사라졌어도 거절하지 않는다(다른 역할만 고쳐 저장할 수 있게). T4부터 `place`는 `Spot`(역할, `single`, 모델 묶음 항목 `pool:<key>`)이다. 모델 묶음 항목을 고치면 그 항목의 이름을 새 모델로 다시 매기고 카드를 새로 얼리며, 기록은 `history`가 아니라 `groups[g].poolHistory`에 `{at, presetID, key, from, to?}`로 남긴다(`key` = 고치기 전 이름, `to` = 그 항목이 지금 도는 모델, 항목을 뺐으면 없음). 저장된 `history[].place`는 옛 빌드가 읽도록 역할이나 `single` 그대로다.
- `session.preset.get` → `main?: {missing: "model" | "variant", suggestion?: {id, variant?}}`: 세션의 메인 모델이나 그 추론 강도가 사라졌다. 다음 프롬프트는 core가 실패시키므로 클라이언트가 보내기 전에 02 전환을 제안으로 묻는다(03 §4.6). 쓸 수 있으면 없다.
- `presets.changed`는 `presets.json`이 그대로여도 열린 수리 알림이 바뀌면 나간다(9.3).

**프리셋 T4 모델 묶음**(07 v0.5 §2.1, §3.3, §8.1. 새 메서드·이벤트·오류 type은 없고 모두 선택 필드라 메서드 수는 그대로다. own RPC라 `bun run generate`도 필요 없다). 위의 `presets.suggest`·`presets.set` 줄에 더해:
- `presets.list` → `GroupView.poolHistory?`(모델 묶음 수리 기록). `repairs[].uses[]`의 `{kind:"pin", place:"pool:<key>", account?}`(메인 계정 항목이면 `account` 없음, 후속 모델은 그 묶음의 후보에서). `retirements`에 모델 묶음 모델이 들어간다.
- `session.preset.get`·`session.preset.apply` → `resolution.pool?` = `{main, entries}`. 모델 묶음 프리셋이 아니면 이 키가 없다.
- own.team 수리 알림(06 §10.1) → `OwnTeam.Repair.pool?: string[]`(팀 R4로 깨진 모델 묶음 고정의 이름).

**작업 폴더 지우기 막이**(06 §10.4 #5, §8.6, TG13. 03 §19.3의 정리 대화상자가 부른다). 범위 `read`, 위치 control location(전역 메서드, 9.1)이다.

`worktree.inspect` `{projectID, root, directory}` → `{nested:[{path, kind:"worktree"|"repository"}], scan:"complete"|"partial", lock:{reason}|null, ownLock, ignored:{entries:[{path, bytes}], count, bytes, truncated}}`
- `root`는 프로젝트의 주 작업 폴더, `directory`는 지우려는 연결 작업 폴더다(둘 다 절대 경로). 둘 다 그 프로젝트의 작업 폴더 표(`ctx.worktree.list{projectID}`, `worktree.remove`가 지우는 표)에 있어야 하고, 아니면 git도 파일 시스템도 부르지 않고 `not_found{directory}`다. `read` 기기가 이 PC의 다른 폴더를 읽게 하지 않기 위해서다. UNC·장치 경로(`\\host\share`, `//host/share`, `\\?\`, `\\.\`)도 다른 기계에 닿을 수 있어 `not_found`다. 그다음 `git -C <root> worktree list --porcelain -z`가 알려 주는 연결 작업 폴더만 읽는다. 주 작업 폴더나 목록에 없는 폴더는 `not_found{directory}`, git이 저장소로 열지 못하면 `not_git{directory}`다. git이 없거나 실행에 실패하면 `internal_error`다. 이 셋은 HTTP 400이고 화면은 막힌 채 `다시 살피기`를 보인다.
- `nested`: 그 안에 있는 다른 연결 작업 폴더와, 링크·junction을 따라가지 않는 폴더 걷기로 찾은 `.git` 항목(중첩 작업 폴더, submodule, 무시된 폴더 안의 독립 저장소). `git worktree remove`가 그 저장소의 저장하지 않은 작업까지 지우므로 화면은 지우기를 거절한다(06 TI-3 (b)).
- `lock`: `git worktree list`의 `locked` 줄(이유가 없으면 빈 문자열). `ownLock`이면 이유가 `own.team` 또는 `own:`으로 시작하는 own 잠금이다. 팀 모드만 그 폴더를 지운다(06 §3.8, TI-12).
- `ignored`: `git status --porcelain=v1 -z --ignored`의 무시 항목과 크기. 큰 것부터 20개(`entries`)와 전체 개수·바이트. `git worktree remove`는 묻지 않고 이것들을 지운다(06 TI-2).
- 걷기는 두 단계다. 먼저 모든 폴더를 너비 우선으로 읽어 `.git`을 찾고(얕은 무시 폴더의 독립 저장소를 깊은 `node_modules`보다 먼저 본다), 그다음에야 무시 파일의 크기를 잰다. `scan:"partial"`: 첫 단계가 항목 50만 개나 20초에서, 또는 크기 재기가 20초에서 멈췄다. 중첩 저장소를 다 찾지 못했을 수 있고 `ignored.bytes`는 최솟값이다. 화면은 이때 지우기를 거절하고 `다시 살피기`를 보인다(06 TI-3 (b)).
- 읽기만 한다. git은 셸 없이 인자 배열로 부른다(06 §4.3). own-web은 지우기 바로 앞에서 다시 부르고, 막이 결과·중첩 폴더·잠금·무시 항목 수가 확인 때와 같을 때만 `worktree.remove`를 부른다. 다르면 지우지 않고 새 결과를 보인다(06 TI-3 (e), §8.6 3단계).

**다른 도구의 대화 비용 추정**(09 §4.3, §4.6, §5.6, IMPORT 2026-10-08). own-import의 `migrate.plan`이 loopback으로 부른다(own-web은 부르지 않음). 범위 `read`, 위치 control location(전역 메서드, 9.1)이다. 핸들러는 `rpc/estimate.ts` → `switching.estimateRequest`이고 throw하지 않는다.

`estimate.request` `{target: Model.Ref, requests: [{prompt, output, cachedPrefix?}](64개까지), accountID?}` → `{unit, delta: Estimate.Delta|null, quota: Estimate.QuotaImpact|null, remaining: {fiveHour, weekly}|null, Z, zSource: "measured"|"default", exchange, window: number|null, ceiling: number|null}`
- 아직 어느 세션도 돌지 않는 slot에서 요청들의 값을 6장의 추정기(`firstRequest`, `compactRequest`, `quotaDelta`)와 요금표·한도 보정 그대로 매긴다. `cachedPrefix`가 없으면 cold 요청이다. 요청들을 합친 값이 `delta`이고, 필요한 요금을 모르면(로컬 모델 등) `null`이다. 구독이면 `quota`가 5시간·주간 창의 몫이다.
- `remaining`은 그 계정의 5시간·주간 창에 남은 % (모르는 창은 `null`)이고, own-import가 `quota_insufficient`(09 §4.6)를 판정하는 데 쓴다.
- `accountID`(선택, LV 2026-10-25 다섯째 검토)는 own-import가 받은 고른 계정(09 §5.2 `migrate.plan` `accountID`)이다. 그 계정이 `target`의 프로바이더를 맡으면(`anthropic`이면 Claude 계정 어느 것이든, 8.7) `remaining`을 그 계정의 창에서 읽는다. 없거나 그 프로바이더의 계정이 아니면 예전처럼 그 프로바이더의 계정(`anthropic`은 Claude 슬롯, 계정 1)이다. 요금과 Z·exchange는 프로바이더 단위라 같다.
- `Z`·`zSource`·`exchange`: 그 slot에서 최근 own.import가 쓰지 않은 **최상위** 세션들의 첫 step Z 중앙값과 step 증가분 중앙값이다(`Tracker.slotMeasure`). 잰 세션이 없으면 `Tracker.DEFAULTS.Z`(12k)와 `zSource:"default"`, `DEFAULTS.delta`(3k)다. 하위 에이전트 세션은 다른 에이전트의 시스템·도구를 쓰므로 세지 않는다.
- `window`·`ceiling`: slot 템플릿의 유효 `limit.input || limit.context`(01 R16)와 그 `Compaction.ceiling`. 모르면 `null`이고 own-import는 core 카탈로그로 계산한다.
- 상태를 바꾸지 않는다: PLANNED, 비밀 미리 읽기, ledger 줄이 없다. 오류: `account_not_found`, `slot_misconfigured`. 그 밖의 실패는 `internal_error`.
- **가져온 세션은 측정에서 뺀다**(09 §4.2). `session.created`의 metadata에 `own.import`가 있는 세션(가져온 대화와 숨긴 보조 세션)은 첫 step의 Z(`firstL`)와 slot 중앙값에 들어가지 않고(`switching/tracker.ts`), 로컬 모델의 요청 크기 학습(`presets/local-window.ts`)에서도 빠진다. 키 하나(`OwnImportRouting.marked`)로 판정한다. 그런 세션의 Z가 필요하면 그 slot의 Z를 쓴다. 보조 세션의 압축 사용량은 그대로 `UsageRecorded{source:"compaction"}`로 그 계정의 ledger에 남는다(7.5).

**워크스페이스 노트**(NOTES, 2026-10-09. 가운데 워크스페이스의 `노트` 탭, 05 §8.8). 이 PC 서비스가 노트를 갖고 있어 데스크톱 앱, 게이트웨이를 거친 휴대폰, 다른 PC의 원격 PC 창이 같은 노트를 본다. 넷 다 전역 메서드라 control location으로 부르고, 범위는 읽기 `read`, 쓰기 `prompt`다(9.1). 원격 모드(SSH 호스트)의 own-accounts는 `remote_managed`로 답한다: SSH 원격 프로젝트의 노트도 이 PC에 둔다. 핸들러는 `rpc/notes.ts` → `notes/store.ts`(`NoteStore`)이고 모듈이 없다(`worktree.inspect`처럼 상태가 없음). 모델 입력이나 세션에는 아무것도 쓰지 않는다(스레드 노트 03 §19.10과 다른 기능).

`notes.list` `{workspace}` → `{notes: [{id, title, rev, updatedAt}]}`
- 만든 순서대로, 내용 없이 준다. 없는 워크스페이스는 빈 목록이다.

`notes.get` `{workspace, id}` → `{id, title, text, rev, updatedAt}`
- 없으면 `note_not_found{id}`.

`notes.put` `{workspace, id, title?, text?, baseRev}` → `{rev, updatedAt}`
- `baseRev`가 저장된 revision일 때만 저장하고 `rev`를 1 올린다. `0`은 "아직 없는 노트"이고 새로 만든다. 빠진 `title`·`text`는 저장된 값을 그대로 둔다(새 노트는 빈 문자열). 그 밖에는 `note_conflict{current}`로 저장된 노트(지워졌으면 `null`)를 돌려주고 아무것도 쓰지 않는다. 다른 기기의 새 글을 조용히 덮어쓰지 않기 위해서다. 클라이언트는 충돌 안내를 보이고, 사용자가 `내 내용으로 저장`을 고르면 그 `current.rev`로 다시 부른다.
- 새 노트가 워크스페이스의 201번째면 `notes_limit{max:200}`.
- 성공하면 leader가 `notes.changed{workspace, id, rev}`를 낸다(9.3).

`notes.remove` `{workspace, id, baseRev?}` → `{removed}`
- `baseRev`를 주면 그 revision일 때만 지우고, 아니면 `note_conflict{current}`. 이미 없으면 `{removed:false}`이고 이벤트가 없다. 지웠으면 `notes.changed{workspace, id, rev:null}`.

- **입력 검사(경계에서 한 번).** `workspace`는 `@own/protocol` `Notes.workspaceKey`가 만드는 그대로의 정규 키여야 한다: 이 PC의 프로젝트는 `local:<폴더>`, SSH 원격 프로젝트는 `ssh:<hostId>:<원격 폴더>`이고, 폴더는 절대 경로, Windows 경로(드라이브, `\\서버\공유`)는 `\`·소문자, POSIX 경로는 대소문자 그대로, 겹친 구분자·`.`·`..`·끝 구분자 없음, 제어 문자 없음, 4,096자 이하다. 같은 폴더를 다르게 적은 키(`local:D:\work`, 끝의 `\`)는 거부한다. 그래야 데스크톱·휴대폰·다른 PC 창이 한 노트를 가리킨다. `id`는 `^[A-Za-z0-9_-]{1,64}$`(구분자·제어 문자 없음, 브라우저의 `crypto.randomUUID()`), `title`은 200자, `text`는 200,000자(UTF-16 단위) 이하다. 워크스페이스마다 노트는 200개까지다.
- **저장(2.4.6).** own-accounts KV(core DB의 플러그인 KV)에 워크스페이스마다 목록 행 하나(`notes:<키 해시>` = `{notes:[{id, title, rev, updatedAt}]}`, 만든 순서)와 노트마다 내용 행 하나(`notes:<키 해시>:<id>` = 문자열)를 둔다. 키 해시는 정규 키의 SHA-256 앞 32자다(경로는 KV 키로 쓰기에 길고 `:`를 품을 수 있다). `list`는 목록 행만 읽는다. 쓰기는 runtime 싱글턴의 `notes` 뮤텍스 아래에서 하나씩 돈다: 두 기기가 같은 순간에 저장해도 목록 행의 읽고-고치고-쓰기가 섞이지 않는다. 저장은 내용 행을 먼저, 목록 행을 나중에 쓴다(중간에 멈추면 목록이 한 revision 뒤에 남고 다음 저장이 다시 씀). 지우기는 목록 행을 먼저 고친다. 읽을 수 없는 목록 행은 빈 목록으로 덮지 않고 그 호출을 `internal_error`로 끝낸다.
- **게이트웨이(05 §13.4).** `notes.put`의 본문은 노트 하나가 통째로 오므로 1 MiB까지 읽는다(다른 RPC는 64 KiB). 판정은 범위표만 본다.

**아이디어 노트**(IDEAS, 2026-10-11. 머리줄의 `아이디어` 단추와 빠른 적기, 03 §4.4.1). 프로젝트나 대화와 상관없이 떠오른 생각을 적어 두는 전역 스티키 메모다. 대화 메모(03 §19.10, 세션 metadata)와 워크스페이스 노트(위, 폴더마다)와 따로 저장한다. 이 PC 서비스가 갖고 있어 데스크톱 앱, 게이트웨이를 거친 휴대폰, 다른 PC의 원격 PC 창이 같은 보드를 본다. 셋 다 전역 메서드라 control location으로 부르고, 범위는 읽기 `read`, 쓰기 `prompt`다(9.1). 원격 모드(SSH 호스트)의 own-accounts는 `remote_managed`로 답한다. 핸들러는 `rpc/ideas.ts` → `ideas/store.ts`(`IdeaStore`)이고 모듈이 없다. 모델 입력이나 세션에는 아무것도 쓰지 않는다.

- **워크스페이스 노트를 다시 쓰지 않은 까닭.** 예약 키(`notes.*`의 `global` 워크스페이스)로도 저장은 되지만, 아이디어에는 색·고정·만든 때가 있고 보드는 모든 아이디어를 내용과 함께 한 번에 읽는다(노트 목록은 제목만 읽음). 정규 워크스페이스 키 검사를 느슨하게 하지 않고 한도(2,000자·1,000개)를 따로 두려고 메서드 묶음을 나눴다. 저장 방식, 충돌 규칙, 범위, 이벤트는 노트와 같은 모양이다.

`ideas.list` `{}` → `{ideas: [{id, text, color, pinned, rev, createdAt, updatedAt}]}`
- 순서는 정하지 않는다. 보드가 `고정 먼저, 그다음 만든 때 최신 먼저`로 늘어놓는다(고쳐도 자리가 바뀌지 않는다).

`ideas.put` `{id, text?, color?, pinned?, createdAt?, baseRev}` → 저장된 아이디어 `{id, text, color, pinned, rev, createdAt, updatedAt}`
- `baseRev`가 저장된 revision일 때만 저장하고 `rev`를 1 올린다. `0`은 "아직 없는 아이디어"이고 새로 만든다. 이때 `text`가 있어야 한다(없으면 입력 검사에서 거절). 빠진 필드는 저장된 값을 그대로 둔다(새 아이디어는 `yellow`, 고정 안 함). 그 밖에는 `idea_conflict{current}`로 저장된 아이디어(지워졌으면 `null`)를 돌려주고 아무것도 쓰지 않는다. own-web은 색·고정만 바꾼 저장이면 `current.rev`로 한 번 더 보낸다(내용을 건드리지 않음). 내용을 고친 저장이면 새 내용을 카드에 보이고 사용자의 글은 편집 칸에 남겨 `내 글로 저장`을 기다린다.
- `createdAt`은 만들 때만 쓴다. 지운 아이디어를 `되돌리기`할 때 같은 id·내용·색·고정과 원래 만든 때로 다시 만들어 보드의 제자리로 돌아오게 한다. 지금보다 뒤의 값은 지금으로 줄인다.
- 새 아이디어가 1,001번째면 `ideas_limit{max:1000}`.
- 성공하면 leader가 `ideas.changed{id, rev}`를 낸다(9.3).

`ideas.remove` `{id, baseRev?}` → `{removed}`
- `baseRev`를 주면 그 revision일 때만 지우고, 아니면 `idea_conflict{current}`. 이미 없으면 `{removed:false}`이고 이벤트가 없다. 지웠으면 `ideas.changed{id, rev:null}`.

- **입력 검사(경계에서 한 번).** `id`는 `^[A-Za-z0-9_-]{1,64}$`(브라우저의 `crypto.randomUUID()`), `text`는 공백·줄바꿈만이 아닌 글이고 2,000자(UTF-16 단위) 이하, `color`는 `yellow`·`pink`·`green`·`blue`·`purple` 중 하나, `pinned`는 불, `createdAt`은 0 이상의 epoch ms다. 이 PC의 아이디어는 1,000개까지다. 태그는 따로 저장하지 않는다: 글 안의 `#낱말`을 own-web이 태그로 읽는다.
- **저장(2.4.6).** own-accounts KV에 아이디어마다 행 하나(`ideas:<id>` = 아이디어 전체)를 둔다. 한 개가 작고(2,000자) 1,000개까지라 `ideas.list`는 접두사 `ideas:`를 500개씩 훑어 다 읽는다. 쓰기는 워크스페이스 노트와 같은 runtime `notes` 뮤텍스 아래에서 하나씩 돈다: revision 비교와 1,000개 세기가 다른 기기의 저장과 섞이지 않는다. 읽을 수 없는 행은 숨기지 않고 그 호출을 `internal_error`로 끝내며 행은 그대로 둔다.
- **게이트웨이(05 §13.4).** 본문이 아이디어 하나라 다른 RPC와 같은 64 KiB 검사 안에 들어간다. 새 분기가 없다.

**기본 대화 폴더**(DF, 2026-10-18, 03 §5.1). 프로젝트를 고르지 않고 시작한 대화가 일하는 폴더다. 서비스마다 하나이고 그 서비스가 기본값을 정한다(이 PC, SSH 호스트, 다른 PC. 휴대폰은 PC의 것을 쓴다). 사용자의 선택은 그 서비스의 KV에 있어 모든 창과 기기가 같은 값을 본다. 핸들러는 `rpc/conversation-folder.ts` → `conversation-folder/folder.ts`(`ConversationFolders`)이고 모듈이 없다. 원격 모드도 같은 핸들러로 답한다.

**프로젝트 순서와 고정(SBL, 2026-11-26, 03 §4.3).** 사이드바가 이 서비스의 프로젝트를 늘어놓는 순서다. 전역 메서드이고 상태가 없다.

`projectList.get` `{}` → `{pinned: id[], order: id[]|null, orderedAt: ms|null}`
- `pinned`: 고정한 프로젝트, 사용자가 정한 순서. `order`: 나머지의 순서, `null`이면 기본 순서. `orderedAt`: `order`를 정한 때(그 뒤에 쓴, 순서에 없는 프로젝트는 맨 위에 온다).

`projectList.set` `{pinned?: id[], order?: id[]|null}` → `get`과 같은 모양
- 적은 쪽만 통째로 바꾼다(고정이 순서를, 순서가 고정을 덮지 않는다). `order: null`은 기본 순서다. 목록마다 500개, id는 200자까지, 겹친 id는 하나로 줄인다. 서비스는 id가 있는 프로젝트인지 보지 않는다(보관했다가 돌아올 수 있다). leader가 `projectList.changed`를 낸다.

`conversationFolder.get` `{}` → `{path, defaultPath, custom, exists}`
- `path`: 새 폴더 없는 대화가 시작하는 폴더(절대 경로). 사용자가 고른 것(`custom:true`), 없으면 기본값이다.
- `defaultPath`: 서비스의 기본값. Windows는 `%USERPROFILE%\Documents\Own OpenCode`다. Windows가 OneDrive로 옮길 수 있는 알려진 폴더가 아니라 프로필 아래 경로 그대로라서 대화 파일이 동기화되지 않는다. macOS는 `~/Documents/Own OpenCode`다. 그 밖(Linux, SSH 호스트)은 **`~/own-chats`**다(2026-11-22, SN, 2.2.6-own.16): 홈 바로 아래, 숨김 폴더가 아니고, 소문자에 띄어쓰기가 없어 셸에서 그대로 친다(`cd ~/own-chats`). XDG에는 대화나 작업 폴더의 자리가 없고(`XDG_DOCUMENTS_DIR`는 데스크톱의 `~/Documents`이고 서버에는 보통 없다), 데이터 폴더(`~/.local/share`)는 사람이 열어 보는 곳이 아니다. 그 전의 기본값(`~/Documents`가 있으면 `~/Documents/Own OpenCode`, 없으면 `~/Own OpenCode`)이 **이미 있는 호스트는 그것을 그대로 쓴다**: 그 폴더의 대화가 계속 `폴더 없는 대화`이고 아무것도 옮기지 않는다. 둘 다 있으면 `~/Documents/Own OpenCode`다. 홈은 core의 홈(`OPENCODE_TEST_HOME`, 없으면 OS 사용자 홈)이라 시험은 실제 폴더를 건드리지 않는다. 플러그인 옵션 `conversationFolder`가 있으면 그것이 기본값이다(시험용).
- OWN_HOME 아래에 두지 않은 까닭: 앱·vault·control 폴더가 있는 곳이고 앱을 지우면 함께 지워지며, own의 보호 경로 거부 `OWN_HOME/*.json`이 그 아래 모든 JSON 파일에 맞는다(core 와일드카드의 `*`는 구분자를 넘는다). 그래서 그 폴더의 대화는 JSON 파일을 읽지도 고치지도 못한다.
- `exists`: 폴더가 지금 있는지. 기본값은 처음 쓸 때 만든다. 서비스 시작이나 화면 열기로는 만들지 않는다.

`conversationFolder.ensure` `{}` → `get`과 같은 모양(`exists:true`)
- 폴더가 없으면 만들고(`mkdir -p`) 파일 하나를 써 보고 바로 지운다(쓰기 확인). 만들었으면 leader가 `conversationFolder.changed`를 낸다. own-web은 폴더 없는 새 대화를 만들기 바로 전에 부른다.
- 오류 `conversation_folder_unavailable{reason, path}`: `not_folder`(같은 이름의 파일), `create_failed`(드라이브가 없음, 권한, Windows 보안의 "제어된 폴더 액세스"가 켜져 문서 폴더를 막음. 이 PC는 2026-10-18에 꺼져 있었다), `not_writable`.

`conversationFolder.set` `{path: string|null}` → `get`과 같은 모양
- `null`은 기본값으로 돌아간다(KV 행을 지움). 고른 폴더와 그 안의 파일은 그대로 둔다.
- `~/…`(Windows는 `~\…`도)는 서비스 사용자의 홈 아래로 읽는다(SN, 2026-11-22). SSH 호스트의 설정 칸에서 `~/projects/own-chats`처럼 쓴다. 저장하는 값은 펼친 절대 경로다. `~` 하나는 홈 폴더 자체라 `home`으로 거절한다.
- 디스크를 보기 전에 거른다: `relative`(절대 경로가 아님), `root`(드라이브·파일 시스템 루트), `home`(홈 폴더 자체 또는 그 위), `app`(OWN_HOME과 그 안·위, own 설정 폴더 `OPENCODE_CONFIG_DIR`, 실행 중인 프로그램의 폴더. 그 위의 폴더는 own의 절대 경로 보호 거부가 덮지 못한다). 그다음 없으면 만들고 쓰기 확인을 한다(`not_folder`·`create_failed`·`not_writable`). 거절하면 아무것도 저장하지 않는다.
- 기본값과 같은 폴더는 저장하지 않는다(기본값이 바뀌면 따라간다). 저장하면 leader가 `conversationFolder.changed`를 낸다.
- Git 저장소 안의 폴더도 거르지 않는다. 그때 폴더 없는 대화는 그 저장소 프로젝트의 대화로 보인다(03 §4.3).

**폴더 열기 시작 위치**(DF, 2026-10-18, 03 §18.3). 폴더 열기 창(데스크톱의 폴더 선택 창과 앱 안의 폴더 열기 창)이 처음 보여 줄 폴더다. 같은 파일이 다룬다.

`folderPicker.get` `{}` → `{start: string|null, home}`
- `start`: 사용자가 고른 시작 폴더. `null`이면 클라이언트가 마지막으로 연 폴더(최근 목록의 맨 앞, 기본 대화 폴더는 뺌)의 상위 폴더에서, 그것도 없으면 `home`(서비스 사용자의 홈 폴더)에서 연다. 저장된 폴더가 없어졌으면 `null`로 읽는다.

`folderPicker.set` `{start: string|null}` → `get`과 같은 모양
- 있는 폴더의 절대 경로만 받는다. 드라이브 루트와 홈 폴더도 된다(둘러보기를 시작할 곳일 뿐이다). 만들지 않는다. 오류 `folder_picker_unavailable{reason:"relative"|"missing"|"not_folder", path}`. 저장하거나 지우면 leader가 `folderPicker.changed`를 낸다.

`folderPicker.list` `{path}` → `{path, entries:[{name, locked, owner?}], hidden}`(SN, 2026-11-22, 03 §18.3, 04 §17.4)
- 폴더 열기 창이 그 서비스의 컴퓨터에서 둘러보는 목록이다. 이 PC를 브라우저·휴대폰에서 열 때의 앱 안 선택기와 SSH 호스트의 선택기가 쓴다(데스크톱 앱이 이 PC를 열 때는 Windows의 폴더 선택 창이다). `path`는 절대 경로나 `~`·`~/…`이고, 답의 `path`는 펼치고 정리한 절대 경로다.
- `entries`: 폴더만(폴더로 가는 심볼릭 링크 포함, 파일과 끊긴 링크는 뺀다). 항목마다 서비스에서 `stat`을 한 번 하고, 서비스 사용자가 그 폴더를 읽고 들어갈 수 없으면(모드의 읽기·실행 비트를 소유자·그룹·나머지 순서로 본다. root는 언제나 됨) `locked:true`와 `owner`(Linux·macOS에서 `/etc/passwd`로 찾은 사용자 이름, 없으면 uid)다. 클라이언트가 항목마다 따로 묻지 않는다. Windows는 권한이 ACL에 있어 `stat`으로 알 수 없으므로, `stat` 자체가 거절된 폴더만 잠긴다(소유자 없음).
- `hidden`: 프로젝트가 될 수 없어 목록에서 뺀 폴더 수. 파일 시스템 루트나 마운트 지점(부모와 장치가 다르거나 `/` 자체)의 `lost+found`(fsck가 쓰는 복구 폴더, root만 읽음), Windows 드라이브 루트의 `System Volume Information`·`$Recycle.Bin`·`$WinREAgent`·`Config.Msi`다. 그 경로를 직접 입력하면 열 수 있다. 숨김 파일(`.`으로 시작)은 지금처럼 보인다.
- 오류 `folder_list_unavailable{reason, path, owner?}`: `relative`, `missing`(ENOENT), `not_folder`(파일이거나 ENOTDIR), `denied`(EACCES·EPERM·EROFS. `owner`는 그 폴더의 소유자), `failed`(그 밖). own-web은 `denied`를 `이 폴더는 읽을 권한이 없어요 (소유자: root).`로 보인다.
- 이 메서드가 없는 오래된 서비스(`rpc.method_not_found`)나 `prompt` 범위가 없는 연결에서는 own-web이 전처럼 core `fs.list`로 이름만 받는다(잠금 표시·숨김·`새 폴더` 없음).

`folderPicker.create` `{parent, name}` → `{path}`(SN, 2026-11-22)
- 폴더 열기 창의 `새 폴더`: `parent`(절대 경로나 `~/…`) 안에 `name` 폴더 하나를 만든다(`mkdir`, 상위 폴더는 만들지 않음). `name`은 앞뒤 공백을 자르고 NFC로 맞춘다. 한글 이름은 된다.
- 오류 `folder_create_unavailable{reason, path}`: `name`(빈 이름, `/`·NUL, `.`·`..`, 255바이트 넘음, Windows의 `\<>:"|?*`와 제어 문자, 예약 이름 `CON`·`NUL`·`COM1`…(확장자가 붙어도), 끝의 점·공백), `exists`(그 이름의 폴더나 파일이 이미 있음, `path`가 그것. own-web은 `그 폴더 열기`를 보인다), `relative`·`missing`·`not_folder`(부모), `denied`(부모에 쓸 권한 없음), `failed`. 이미 있는 폴더를 고르는 일은 하지 않는다.

**Codex 모델 목록**(CA, 2026-10-19, 07 §4.5). ChatGPT 계정의 Codex 모델 목록을 어느 Codex 버전으로 묻는지와, own이 뺀 행이다. control location의 Codex 메타데이터 모듈이 답한다. 원격 서비스는 목록을 받지 않으므로 둘 다 `remote_managed`다.

`codexModels.get` `{}` → `{autoVersion, version, build, latest?: {version, fetchedAt}, fetchedAt?, rejected, accounts: {<accountID>: number}}`
- `autoVersion`: 설정 `Codex 최신 모델 자동 확인`(기본 `true`). `version`: 지금 묻는 `client_version`(켜져 있으면 `build`와 `latest.version` 중 높은 쪽, 꺼져 있으면 `build`). `build`: 빌드 상수(`CodexMeta.BACKEND.clientVersion`). `latest`: npm 레지스트리에서 읽은 Codex 최신 릴리스와 읽은 시각(한 번도 못 읽었으면 없음). `fetchedAt`: 공유 목록(`kinds.codex`)을 백엔드에서 마지막으로 받은 시각. `rejected`: 공유 목록에서 own이 뺀 행 수(깨졌거나 own의 codex 하네스가 다루지 못하는 값. Codex가 숨기는 행은 세지 않음). `accounts`: 목록을 받은 codex 계정마다 그 계정 목록의 같은 수.

`codexModels.set` `{autoVersion: boolean}` → `get`과 같은 모양
- `codex-meta.json`에 저장한다(쓰지 못하면 `internal_error`, 아무것도 바뀌지 않음). 묻는 버전이 바뀌면 모든 codex 계정의 목록을 etag 없이 다시 받는다. 켤 때 저장된 값이 하루보다 오래됐으면 레지스트리를 바로 읽는다. 끄면 레지스트리를 읽지 않는다.
- 설정이 바뀌거나, 레지스트리에서 새 값을 읽거나, 목록을 다시 받아 보기가 바뀌면 leader가 `codexModels.changed`를 낸다.
- 2026-11-23(own.18, 07 §4.5 "서버 행으로 바로 돌리기"): `get`과 `set`의 답에 `left?: [{slug, field, value}]`(공유 목록에서 뺀 행과 이유), `accountLeft?: {<accountID>: [...]}`, `borrowed?: [{slug, from}]`(지시문 없는 서버 행이 빌린 번들 모델)를 더했다.

`codexModels.rows` `{have?: string}` → `{revision, rows?: HarnessRow[]}` (`local`, control, 2026-11-23)
- 같은 프로세스의 own-harness만 부른다(10 §6.14). 이 Location이 가진 공유 스냅샷의 `harness`(하네스가 돌리는 서버 행)와 그 리비전(안정 해시, 없으면 `none`)을 답한다. `have`가 지금 리비전이면 `rows`를 뺀다. 원격 서비스는 목록을 받지 않으므로 빈 목록이다(`remote_managed`가 아님).


**음성 입력(VOICE, 3.9)**: 네 메서드 모두 control location이고 원격 서비스는 `remote_managed`다.

`voice.get` `{}` →
```json
{ "enabled":true,"provider":"openai","language":"ko",
  "keys":[{"provider":"openai","configured":true,"keyHint":"sk-…9fQ2"},{"provider":"deepgram","configured":false}],
  "model":"gpt-transcribe",
  "usage":[{"month":"2026-10","provider":"openai","seconds":754.5,"requests":61}],
  "limits":{"maxSeconds":180,"maxAudioBytes":4194304,"maxHintChars":600},
  "vault":"ok" }
```
- `vault:"unavailable"`이면 키 상태를 알 수 없다(`configured:false`로 보임). 키 값은 어떤 응답에도 없다.

`voice.set` `{enabled?, provider?, language?}` → `voice.get`과 같은 모양. 준 필드만 바꾼다.

`voice.key.set` `{provider:"openai"|"deepgram", key:string|null}` → `voice.get`과 같은 모양. 오류 `voice_key_invalid`, `vault_unavailable`, `remote_managed`.

`voice.transcribe` `{audio, mediaType:"audio/webm"|"audio/ogg"|"audio/mp4"|"audio/mpeg"|"audio/wav", durationMs?, language?:"auto"|"ko"|"en", hint?}` →
```json
{ "text":"own-web 입력창에 받아쓴 글이 들어갑니다","provider":"openai","model":"gpt-transcribe","seconds":4.2,"language":"ko" }
```
- 오류 `voice_unavailable{reason:"disabled"|"key_missing", provider}`, `voice_audio_invalid{reason:"empty"|"encoding"|"too_large"|"too_long", max?}`, `voice_failed{provider, reason, status?, retryable}`, `vault_unavailable`, `remote_managed`. 앞의 둘과 `voice_audio_invalid`는 인식 서비스로 아무것도 보내지 않은 경우다.

**MCP 서버(SM, 2026-10-24, 03 §18.14)**: 설정 > MCP 서버의 `＋ 서버 추가…`·`고치기…`·`지우기…`, 목록의 스위치, `연결 시험`, `다른 도구에서 가져오기…`, `찾아서 설치…`. 아홉 메서드 모두 control location이고 원격 서비스는 `remote_managed`다(SSH 호스트의 MCP 서버는 그 호스트의 설정 파일 것이다). own은 이 서버를 설정 파일에 쓰지 않는다. `mcp.json`(2.3)과 vault 항목 `mcp-<id>`에 두고, own-accounts가 모든 Location(control은 빼고)에서 `ctx.mcp.transform`으로 core에 넘긴다. core의 설정 파일 접기(`opencode.config.mcp`, 내장이라 먼저 돈다) 뒤에 돌므로 같은 이름이면 own의 서버가 그 Location에서 이기고, 목록 스위치는 설정 파일의 서버에도 `disabled`로 들어간다. 바뀌면 runtime broadcast `mcp.changed`로 모든 Location이 스냅숏을 다시 읽고 `ctx.mcp.reload()`를 부른다(core는 설정이 같은 서버를 다시 띄우지 않는다). core는 transform을 등록하자마자 접으므로, `mcp.json`(서버와 목록 스위치)과 전역 설정의 `mcp.timeout`은 **등록 전에** 읽는다. 그래서 꺼 둔 설정 파일의 서버는 Location이 뜰 때 한 번도 띄워지지 않는다. 값은 등록 뒤에 읽는다(첫 vault 요청이 도우미를 띄우는 동안 플러그인 설정을 막지 않게, 웹 검색 키와 같다). 그 전까지와 vault가 답하지 않을 때 값을 둔 서버는 `disabled`로 넘기고, 목록 스위치가 켜라고 해도 켜지 않는다(값 없이 반쯤 뜨지 않게). 값을 못 읽은 서버가 있으면 1초 뒤에 다시 읽고, 못 읽을 때마다 기다림을 두 배로 늘린다(60초까지. vault에는 다시 답한다는 신호가 없다). 다시 읽어서 값이 돌아오면 그 Location은 다시 접고 runtime broadcast `mcp.changed`와 RPC 이벤트 `mcp.changed`를 낸다. 그래서 다른 Location도 바로 다시 읽고, 열린 설정 페이지는 `mcp.list`를 다시 읽어 `missing` 안내와 도는 서버가 맞는다(SM-22). 로그는 서버 이름·종류·개수만 남기고 값, 명령 줄, 주소는 남기지 않는다. 값을 못 읽은 서버 이름은 그 목록이 바뀔 때만 남긴다.

core의 앞선 내장 플러그인이 주는 기본값은 core의 설정 파일 접기가 넣은 서버에만 닿는다. own의 접기가 그 뒤에 돌므로 own은 자기 서버에 같은 기본값을 직접 준다: 전역 설정 문서(`OPENCODE_CONFIG_DIR`의 `opencode.json`, 그다음 `opencode.jsonc`, core의 순서)의 `mcp.timeout`을 서버마다 넣고(프로젝트 설정 파일의 `mcp.timeout`은 읽지 않는다, 4.7.2의 압축 설정과 같다. 접을 때마다 다시 읽어 바뀌었으면 한 번 더 접는다), `codemode`를 정하지 않은 서버에는 `McpCodeModeDefaultsPlugin`의 규칙(스스로 Code Mode인 `executor mcp`와 `executor.sh` 주소는 `codemode:false`, PostHog는 `x-posthog-mcp-mode: tools` 헤더)을 그대로 쓴다. check-surface 항목 `mcp-config-fold`·`mcp-codemode`가 core의 그 두 곳을 지킨다.

값은 파일과 답에 나오지 않는다. 명령과 인자는 `${이름}`으로 그 서버의 저장된 환경 변수 값을 부를 수 있고, own이 서버를 띄울 때(접기와 연결 시험) 값을 넣는다. 저장(`mcp.save`·`mcp.test`)과 가져오기는 값이 든 인자를 그렇게 옮긴다(own-protocol `McpSecrets.lift`, own-web도 같은 규칙으로 설정 파일 서버의 값을 `••••`로 보인다. SM-15, SM-22):
- 값을 받는 플래그 다음 인자와 `--플래그=…`의 뒤: 마지막 낱말이 `token`·`key`·`secret`·`password`·`auth`·`bearer`·`pat` 등인 플래그(`--api-key`, `--accessToken`, `--oauth2Bearer`, Go 꼴 `-token`. `--no-auth`·`--use-key` 같은 스위치는 빼고, 다음 인자가 `--x`나 `-v` 같은 플래그면 빼고). 한 글자 플래그는 그 도구를 알 때만 값을 받는다(`vercel`·`glab -t`, `openai -k`, `redis-cli -a`, `mongosh`·`sshpass -p`, `curl -u`. 명령이나 앞 인자가 그 도구를 부를 때). 다른 도구의 `-t`·`-k`는 다른 뜻이라(`gitea-mcp -t stdio`, `curl -k`) 그대로 둔다.
- 환경 변수 쌍: `-e`·`--env` 다음이나 `--env=` 뒤의 `KEY=VALUE`는 늘 값을 옮기고(`KEY=${KEY}`, docker·podman), 그 밖의 `KEY=VALUE`는 KEY가 비밀 이름 같을 때 옮긴다(낱말에 `token`·`secret`·`key`·`password`·`auth`·`cookie` 등이 있고 마지막 낱말이 `FILE`·`PATH`·`URL`·`ID` 등이 아님). 아니면 값만 아래 주소·키 규칙으로 본다(`DATABASE_URL=postgres://…`).
- 헤더: `--header`·`-H` 다음이나 `--header=` 뒤의 `이름: 값`, 그리고 어디서든 이름이 비밀 같은 `이름: 값`(`Authorization`, `x-api-key`, `Cookie`, `*token*`, `*secret*`, `*key*`). 값을 옮기고 `Bearer`·`Basic`·`Token` 같은 방식 낱말은 남긴다(`Authorization: Bearer ${AUTHORIZATION}`). mcp-proxy의 두 인자 꼴(`--headers Authorization "Bearer …"`, `-H X-Api-Key …`)도 같다: 헤더 플래그 다음 인자가 `:` 없는 헤더 이름이고 그 이름이 비밀 같으면 그다음 인자가 그 헤더의 값이다(SM-25).
- JSON 인자(`--config {"apiKey": …}`, `--config={…}`, `KEY={…}`, 홀로 쓴 `{…}`나 `[…]`, 앞의 빈칸도 받음): 이름이 비밀 같은 필드(안쪽 객체의 것도, 배열이면 그 배열의 이름으로 `{"apiKeys": […]}`)의 글 값을 옮기고(방식 낱말은 남김), 다른 글 값은 아래 주소·키 규칙으로 본다. 작은 JSON 토큰 읽개(own-protocol `McpJson`)로 바뀐 글 값만 제자리에 다시 쓰고 다른 토큰은 쓴 그대로 둔다. 그래서 큰 정수(`12345678901234567890`), 빈칸과 줄바꿈, 필드 순서가 바뀌지 않는다(SM-26. 전에는 `JSON.stringify`로 다시 써 큰 정수의 끝자리가 바뀌었다). 값은 그 글 자체로 저장하고, 서버를 띄울 때(`McpRules.expand`) JSON 인자의 글 안에 든 참조는 그 글을 읽어 값을 넣고 다시 JSON으로 쓴다. 그래서 `"`나 `\`가 든 값도 같은 JSON이 되고, 글 안의 JSON(문자열에 든 JSON)도 그대로 돌아온다(SM-26. 전에는 이스케이프한 꼴로 저장해, 서버가 값을 그대로 되풀이하면 가리지 못했다). 다시 쓰는 글은 원래 글의 이스케이프 꼴을 따른다(`McpJson.encode`, SM-27): 원래 글이 `/`를 `\/`로 썼으면 `\/`로, ASCII 밖 글자를 `\uXXXX`로 썼으면 ASCII 밖 글자를 모두 `\uXXXX`로(16진 대소문자도 그대로) 쓴다. 전에는 `JSON.stringify` 꼴로 써서 그 글의 `\/`와 `\uXXXX`가 풀렸다. 값을 넣어 다시 쓸 때도 그 글의 꼴을 따른다. 다만 값 전체를 옮긴 글은 인자에 `"${이름}"`만 남아 원래 꼴을 모르므로 기본 꼴(`JSON.stringify`: `/`와 ASCII 밖 글자를 그대로)로 쓴다. 그래서 같은 JSON 값으로 돌아오지만 이스케이프까지 같다고는 약속하지 않는다(SM-28. SM-27은 이런 글도 원래 꼴로 돌아온다고 적었다). 페이지에 보이는 꼴(`maskArgs`)은 `••••`가 읽히도록 ASCII 밖 글자를 풀어 쓴다.
- 주소 인자(`scheme://…`, `jdbc:postgresql://…`처럼 낱말이 여럿인 scheme도, SM-27): 사용자 정보(`URL_USERINFO`), 키 같은 경로 조각(`URL_KEY`, 아래), `?` 뒤의 모든 값(`URL_<이름>`. 값은 그 서버 프로세스의 환경 변수가 되므로 `?debug=1`이 `DEBUG`를 정하지 않게 앞에 `URL_`을 붙인다. JDBC 주소의 `?user=…&password=…`도 이 규칙이라 `URL_USER`·`URL_PASSWORD`가 된다). 호스트나 경로 뒤의 `;이름=값` 속성(`jdbc:sqlserver://h:1433;databaseName=app;password=…`, jTDS의 `…/db;password=…`)은 첫 `;`부터 연결 문자열로 읽어 이름이 비밀 같은 속성의 값만 옮긴다(`PASSWORD`, SM-27). 경로는 `/`와 `%2F`에서 나누고 `%2B`·`%3D`는 `+`·`=`로 읽는다. 키 같은 경로 조각은 알려진 키 꼴인 조각, 그리고 글자와 숫자가 섞인 24자 이상 조각(base64의 `+`와 끝의 `=` 채움도 받는다, SM-25) 가운데 GUID나 24자 이상의 16진 숫자 묶음이 든 것(만드는 법이 무작위라 키와 id를 가를 수 없어 늘 키로 본다. 조각의 어디에 있든 보므로 `dapi…`, `shpat_…`, `token_…`, `key-…`, `SK…`, `pat-na1-<GUID>`, `key_<GUID>`, `<16진>-us21`처럼 낱말 같은 머리나 꼬리가 붙어도 키다. 처음 SM-28은 조각 전체가 GUID나 16진일 때만 봐서, 머리가 낱말로 읽히면 이런 키가 보였다)이거나, 무작위로 보이거나(아래), 낱말로 읽히지 않는 것이다(SM-28). 낱말로 읽힌다는 것은 숫자를 뺀 글자가 대부분 두 자 이상의 낱말(낙타 표기 낱말, 대문자 묶음, 소문자 묶음)에 들고, 그 낱말들의 글자 쌍 가운데 75% 이상이 영어 낱말의 쌍(영어 글의 글자 쌍 99%를 이루는 261쌍. TypeScript 5.8 `lib.*.d.ts`의 문서 주석에서 셌다)이라는 뜻이다. 그래서 한 조각이 24자 이상인 이름(`gitmcp.io/amusi/CVPR2024-Papers-with-Code`, `scutan90/DeepLearning-500-questions`, `rasbt/python-machine-learning-book-3rd-edition`, `dev.azure.com/Contoso/Q4PlanningWorkspace2025Final`, `gitlab.com/my-group/backend-services-2024-migration`, `/workspaces/MarketingAnalytics2025Team`, `huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct`)은 그대로다(SM-28. 전에는 24자 이상이면 모두 숨겨, 숨긴 주소가 서버의 글에서 그 이름까지 가렸다). 무작위 키는 거의 숨는다: 시험한 24자 무작위 키 가운데 한쪽 대소문자와 숫자로 된 것은 약 1.2%, 대소문자가 섞인 것은 약 0.2%가 낱말로 읽혀 보였고, 32자 이상이면 0.5% 아래다(GUID와 16진 id는 머리나 꼬리가 붙어도 0%). 짧은 대문자 약어가 많은 이름(`aws-sdk-js-v3-client-s3-2024`)은 키로 볼 수 있다(숨기는 쪽으로 틀린다). base64 키 안의 `/`가 나눈 조각도 한 키로 본다(SM-26, SM-27에서 좁힘): 키 같은 조각 옆의 대소문자가 섞인 base64 조각 가운데 무작위로 보이는 것, 그리고 네 조각까지 모아서 키 길이(16·24·30·32·48·64바이트의 base64, 채움이 있든 없든)이고 대소문자와 숫자가 모두 들고 끝의 `=` 채움이나 `+`가 있으며(이름에는 없다) 무작위로 보이는 조각들이다. 무작위로 보인다는 것은 낙타 표기의 낱말과 세 자 이상의 숫자 묶음(`Paddle`, `Dashboard`, `ONNX`, `2025`)이 글자와 숫자의 60%에 못 미치고, 글자 종류(대문자·소문자·숫자)가 적어도 두 자에 한 번 바뀐다는 뜻이다. 보통 낱말(`mcp`, `Users`, `SSE`)이나 `${이름}`이 든 조각은 끼지 않고, 키 옆이라도 한쪽 대소문자만 쓴 조각(Slack의 `T0000`)도 끼지 않는다. 그래서 `/api/v1/servers/2025/mcp`, `server-filesystem-2025`, `repos%2Fmy-org%2F…` 같은 경로와 키 길이인 이름(`gitmcp.io/PaddlePaddle/Paddle2ONNX`, `/JohnSmith42/MyRepo2024`, `/Tenant01/Workspace2025`, `MyGroup1%2FMyProject2024`, `file:///Users/JaneDoe42/Projects2025`, `/mcp/MyProjectDashboard2025/sse`)은 그대로다(SM-27. SM-26의 길이 규칙은 이런 이름을 숨겼고, 숨긴 주소가 `fetch_Paddle2ONNX_documentation` 같은 서버의 글까지 가렸다). 키 같은 조각 옆의 이름(`/MyWorkspace2025/<키>`)도 끼지 않아 키만 숨는다. 일부러 놓치는 것: `/`가 나눈 채움 없는 키(22·32·40·43·64·86자)에 `+`가 없을 때, 그리고 24자에 못 미치는 22자 한 조각(16바이트 키나 짧은 id). 이름과 구별되지 않아서, 이름을 숨기느니 드문 키를 놓친다. 끝의 `=` 채움이나 `+`가 있는 나뉜 키도 다 숨지는 않는다(조각 하나가 보통 낱말이거나, `//`가 생기거나, 무작위로 보이지 않을 때): 무작위 키로 시험하면 통째로 숨는 것은 16·24바이트 키의 약 2/3, 32바이트 이상 키의 약 4/5이고, 한 조각도 숨지 않는 것은 16바이트 키의 약 30%, 24바이트의 약 14%, 32바이트의 약 4%, 48바이트 이상의 1% 아래다(SM-28에서 잼). 한 키로 본 조각들은 쓴 그대로(`/`, `%2F` 포함) 값 하나로 옮긴다.
- 연결 문자열 인자(SM-27): 두 부분 이상인 `이름=값;…`(ADO.NET·ODBC·Azure. 값은 `;`까지, 또는 `"…"`·`'…'`·ODBC의 `{…}` 안이고 겹친 따옴표와 `}}`는 한 글자다), 이름이 둘 이상인 libpq의 `host=… password=…`(값은 그대로나 `'…'` 안, `\` 이스케이프), Go MySQL의 `user:pass@tcp(host:3306)/db`(주소는 괄호에 주소를 넣은 프로토콜 `tcp(…)`·`unix(…)`·그 밖의 이름, 주소 없는 `tcp`·`unix`, 또는 아무것도 없는 `@/db`. 그래서 `scope:read@org/repo`, `feature:flag@origin/main`, `uvx:mcp-server@git/main`, `pkg:github/org/repo@main/sub/path`, `localhost:8080@main/path`는 아니다, SM-28. 비밀번호는 드라이버처럼 마지막 `@`까지이고, `/`나 `\`로 시작하면 폴더라서 아님), Oracle EZConnect의 `user/pass@host:1521/svc`와 `user/pass@//host[:포트]/svc`(뒤에 `:dedicated`나 `/인스턴스`도), JDBC의 `user/pass@host:포트:SID`(SID에 숫자도, `ORCL19`, SM-28. 셋 다 앞에 `jdbc:oracle:thin:`도)이면 비밀 부분만 옮기고 나머지는 쓴 그대로 둔다. Oracle은 서비스나 SID가 있어야 하고, `//`도 `jdbc:oracle:`도 없으면 포트가 리스너 포트(1500–1599, 2483, 2484)여야 한다(SM-28). 그래서 `owner/repo@v1.2.3`, `owner/repo@main:443`, `org/repo@host:8080/path`는 아니다. 비밀 부분은 이름이 비밀 같은 부분의 값(그 이름에서 만든 이름: `Password` → `PASSWORD`, `AccountKey` → `ACCOUNT_KEY`), Azure의 `SharedAccessSignature=sv=…&sig=…`에서 `sig`의 값(`SIG`), Go MySQL과 Oracle의 비밀번호(`PASSWORD`)다. 따옴표 안의 값은 드라이버가 읽는 값으로 저장한다(SM-28: 겹친 따옴표와 `}}`는 한 글자, libpq `'…'`의 `\'`·`\\`는 그 글자. SM-27은 따옴표 안의 글 그대로 저장해, 서버가 읽은 값을 되풀이하면 가리지 못했다). 따옴표는 인자에 남고(`Password="${PASSWORD}"`, `Pwd={${PWD}}`), 서버를 띄울 때(`McpRules.expand`) 연결 문자열의 따옴표 안 참조는 값을 넣은 뒤 그 따옴표 꼴로 다시 쓴다(`"…"`의 `"`는 `""`, `'…'`의 `'`는 `''`, `{…}`의 `}`는 `}}`, libpq `'…'`는 `'`와 `\` 앞에 `\`. 찾는 곳은 옮길 때와 같다: 인자 전체, 첫 `=` 뒤, 헤더의 `이름:` 뒤, 주소의 `;` 속성, JSON 글 안. own-protocol `McpDsn`). 그래서 인자는 같은 글로 돌아오고, 고칠 때 값 칸에는 실제 비밀번호를 넣으면 된다. 사람이 따옴표 안에 쓴 참조도 같고, 따옴표 밖의 참조는 값을 그대로 넣는다. 따옴표 없는 libpq 값(`\` 이스케이프가 있을 수 있다)은 쓴 그대로 저장한다. 비밀 이름이 아닌 `KEY=VALUE` 꼴로 시작하는 인자는 먼저 연결 문자열로 읽는다(`host=db password=…`, `Server=db;Password=…`). 비밀 이름의 `KEY=`는 전처럼 값 전체를 옮긴다. 그래서 `--config=key=ghp_…;mode=ro`의 키는 `KEY`로 옮긴다(SM-22의 `SECRET`에서 바뀜). 비밀 부분이 없는 연결 문자열(`Server=db;Database=app`)은 그대로다. 한 부분짜리 `password=…`는 `KEY=VALUE` 규칙을 따른다. Oracle의 TNS 별칭(`user/pass@ORCL`), `(DESCRIPTION=…)`, 리스너 포트가 아닌 `user/pass@host:8080/svc`(`//`를 붙이면 옮긴다)는 옮기지 않는다.
- 알려진 키 꼴(`sk-`, `ghp_`, `github_pat_`, `glpat-`, `xox?-`, `AKIA`, `AIza`, `ya29.`, `hf_`, `npm_`, `pypi-`)은 인자 전체든 더 긴 인자의 일부든(`prefix-ghp_…`, `key=ghp_…;mode=ro`) 그 부분만 옮긴다(`SECRET`).
- `${이름}` 옆(SM-25): 값 자리(위의 플래그 다음, 비밀 이름의 `KEY=`, 비밀 헤더, 사용자 정보, 쿼리 값)에서는 참조를 그대로 두고 그 사이의 글자·숫자가 든 조각을 옮긴다(`--token ${PREFIX}abc` → `${PREFIX}${TOKEN}`). 다른 자리에서도 참조 밖의 알려진 키 꼴은 옮기고(`MODE=${M}-ghp_…` → `MODE=${M}-${SECRET}`), 경로 조각에서는 참조 옆의 키 같은 조각도 옮긴다. Claude Code 꼴 `${이름:-기본값}`의 기본값은 값 자리에서는 늘, 다른 자리에서는 키처럼 보일 때(알려진 키 꼴이 들었거나 숫자와 글자가 섞인 20자 이상, 경로에서는 `/`로 나눈 조각마다) 옮긴다. 그 이름의 값이 없으면 기본값을 그 이름의 값으로 저장하고 `${이름}`만 남긴다. 이미 있으면 기본값은 쓰이지 않으므로 지우고 `${이름}`만 남긴다. 이미 있다는 것은 칸에서 받은 값이다. 같은 명령에서 먼저 옮긴 값(다른 기본값이나 인자의 값)이 그 이름을 차지했으면 이 기본값은 제 이름(`K_2`)으로 저장해, `${K:-A}`와 `${K:-B}`가 저마다 제 기본값을 받는다(SM-26. 같은 기본값이면 이름 하나를 같이 쓴다). 옮긴 기본값은 그대로 남는 다른 참조가 다르게 읽게 될 이름에 저장하지 않는다(SM-27): `--token ${K:-<키>} --mode ${K:-plain}`에서 `${K:-plain}`은 값 자리가 아니고 기본값이 키 같지 않아 그대로 남으므로, 키를 `K`에 저장하면 `--mode`가 키가 된다. 그래서 키는 `K_2`에 저장하고 `--mode`는 그대로 `plain`이다. 맨 `${K}`도 그 뜻(환경 변수 `K`)을 지켜, 옆의 기본값을 `K`에 저장하지 않는다. 그대로 남는 참조는 같은 규칙을 값을 저장하지 않고 한 번 돌려 미리 안다.
이름은 플래그·키·헤더 이름에서 만들고(`--api-key` → `API_KEY`), 같은 값이 이미 있으면 그 이름을 쓴다. 명령이나 인자가 그대로 부르는 이름은 그 참조가 같은 값을 읽을 때(같은 기본값)만 쓴다(`--api-key … --other ${API_KEY}` → `API_KEY_2`, SM-27). 이미 `${이름}`인 부분은 다시 옮기지 않는다. 주소는 `?` 뒤를 늘 vault에 두고, 그 앞에도 값이 있으면(사용자 정보, 위의 키 같은 경로 조각, 알려진 키 꼴) 주소 전체를 vault에 두고 파일과 답에는 그 조각을 `••••`로 바꾼 꼴과 `hidden:true`를 둔다. Claude Code에서 가져온 `${VAR}`는 명령·인자에서는 `${VAR}`로 남고(값은 환경 변수 값 VAR, 그 서버의 `env`가 VAR에 다른 값을 주면 `VAR_2`), 주소에서는 `${VAR}`를 쓴 꼴로 보인다(주소 전체는 vault). 그 꼴에서도 사용자 정보, 변수 옆의 키 조각은 `••••`이고, 기본값이 키처럼 보이는 `${UNSET:-…}`는 `${UNSET:-••••}`다(SM-22. 기본값은 20자부터, base64 조각도, SM-25). 명령과 인자의 `${이름:-기본값}`은 저장된 값 `이름`이고, 없으면 기본값이다(`McpRules.REFERENCE`·`expand`, 접기와 연결 시험 모두). 기본값이 있는 참조는 저장된 값을 요구하지 않는다(`mcp_invalid`가 아니고, 칸의 `${이름}` 문제도 아님, SM-25).

`mcp.list` `{directory?}` →
```json
{ "servers":[{"id":"mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6Y","name":"github","scope":{"type":"global"},
    "transport":{"type":"local","command":"npx","args":["-y","@example/github-mcp"],"env":[{"name":"GITHUB_TOKEN","hint":"…9fQ2"}]},
    "from":"codex","createdAt":1761300000000,"updatedAt":1761300000000,
    "check":{"at":1761300100000,"ok":true,"server":"github-mcp 1.2.0","tools":[{"name":"search_issues"}]}}],
  "overrides":[{"directory":"D:\\work\\game","name":"docs","enabled":false}],
  "vault":"ok" }
```
- `scope`: `{type:"global"}`(control이 아닌 모든 Location) 또는 `{type:"project", directory}`(그 폴더와 안쪽 폴더). 원격 주소는 `{type:"remote", url, query, hidden?, headers:[…], oauth}`이고 `url`은 `?` 앞까지다(`hidden`이면 값 조각을 `••••`나 `${VAR}`로 바꾼 꼴). `codemode`는 정했을 때만 있다. `hint`는 12자 이상인 값의 끝 네 글자다. 값은 어떤 답에도 없다.
- `from`은 `codex`·`claude-code`(가져옴)·`registry`(찾아서 설치, `registry:{name, version}`과 함께)다. `missing:true`는 저장한 값을 읽지 못한 서버다(vault가 답하지 않거나 항목을 읽을 수 없음). 그 서버는 모든 프로젝트에서 꺼져 있고 목록 스위치로도 켜지지 않는다.
- `vault:"unavailable"`이면 값을 둔 서버를 지금은 끈 채로 넘긴다.
- `directory`(절대 경로)를 주면 `errors:{<이름>: 글}`이 붙는다: 그 프로젝트 Location에서 실패한(`failed`·`needs_auth`) own의 서버마다 core의 오류 글(stdio 서버의 종료와 stderr 끝 등)에서 그 서버의 값을 연결 시험과 같은 규칙으로 `••••`로 바꾼 것(4,000자까지)이다. control 인스턴스가 플러그인 API `ctx.mcp.list({location})`로 그 Location을 읽는다(check-surface `mcp-list-location`, `mcp-status-error`). 값을 읽지 못한 서버의 글은 빼고, Location을 읽지 못하면 `errors`가 없다. own-web은 own의 서버에는 core의 글 대신 이것만 보인다(03 §18.14).

`mcp.summary` `{}` → `{servers:[{name, scope, from?, missing?}], overrides:[{directory?, name, enabled}]}`
- `overrides`(SG)는 목록의 스위치다. 다른 창도 행의 태그(`이 프로젝트에서 끔`, `이 프로젝트에서만 켬`, `모든 프로젝트에서 꺼 둠`)를 이 PC의 창처럼 보인다.
- 범위 `read`다. 휴대폰이나 다른 PC의 창이 목록의 출처 줄(`이 앱에서 더함 · …`, `Codex에서 가져옴`)과 값이 없어 꺼진 이유를 보이게 한다. 정의(명령, 인자, 주소), 값 이름, 시험 결과는 없다. 같은 이름의 설정 파일 서버가 있어도 그 Location에서 도는 것은 own의 서버이므로, 창은 설정 파일의 정의를 보이지 않는다.

`mcp.save` `{id?, name, scope, transport, registry?:{name, version?}}` → `mcp.list`와 같은 모양
- `name`은 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. 명령은 `{type:"local", command, args[], cwd?, env:[{name, value?}], codemode?}`, 주소는 `{type:"remote", url?, headers:[{name, value?}], oauth, codemode?}`다. `value`가 없으면 저장된 그 이름의 값을 그대로 둔다(없으면 `mcp_secret_missing{name}`). `url`이 없으면 저장된 주소(`?` 뒤와 값이 든 주소 포함)를 그대로 둔다. 새 서버에는 `url`이 있어야 하고 http·https만 받는다(`mcp_invalid{field:"url"}`). 프로젝트 폴더는 절대 경로여야 한다(`mcp_invalid{field:"directory"}`). 값이 든 인자는 환경 변수 값으로 옮기고(위), 명령과 인자의 `${이름}`이 환경 변수에 없으면 `mcp_invalid{field:"args"}`다.
- `scope`는 받은 그대로 저장한다. 고치기 창은 서버의 원래 범위를 보내고, 사용자가 범위 고르기에서 바꿀 때만 다른 범위를 보낸다(03 §18.14). `registry`는 찾아서 설치로 채운 새 서버의 레지스트리 이름과 버전이고, 고쳐도 남는다.
- 이름은 둘 다 돌 수 있는 곳에서 겹치면 안 된다(전역과 아무 범위, 또는 한쪽 폴더가 다른 쪽 안). 대소문자는 가리지 않는다(`mcp_name_taken{name}`). core는 한 Location에 이름마다 서버 하나만 두기 때문이다.
- 값은 vault에 먼저 쓰고(값이 없으면 항목을 지움) 그다음 `mcp.json`에 쓴다. 이름이나 범위를 바꾸면 그 서버의 목록 스위치(옛 이름이고 옛 범위 안의 폴더에 있는 것)만 따라간다: 새 범위 안이면 새 이름으로 바뀌고, 밖이면 지운다. 서버가 닿지 않던 프로젝트의 같은 이름 스위치(그곳 설정 파일의 서버 것)는 그대로다(SM-22). 저장하면 `check`는 지운다.

`mcp.remove` `{id}` → `mcp.list`와 같은 모양. vault 항목을 지운 뒤(실패하면 `vault_unavailable`, 아무것도 지우지 않음) 서버와 그 서버가 닿던 폴더의 그 이름 목록 스위치를 지운다. 다른 프로젝트의 같은 이름 스위치는 남긴다(SM-22).

`mcp.enable` `{directory?, name, enabled: boolean|null}` → `mcp.list`와 같은 모양. 목록의 스위치를 그 이름에 남긴다. `directory`가 없으면 모든 프로젝트의 스위치(설정 > MCP 서버 `모든 프로젝트`의 스위치, SG)이고, 있으면 그 프로젝트(폴더와 안쪽 폴더)의 것이다. 접기는 전역 스위치를 먼저, 그다음 그 Location을 담는 프로젝트 스위치를 얕은 폴더부터 깊은 폴더 순서로 적용한다(가장 깊은 것이 이긴다). 값을 못 읽은 서버는 어느 스위치로도 켜지 않는다. own의 서버와 설정 파일의 서버 모두에 core의 `disabled`로 들어가 서비스를 다시 시작해도 그대로다(core의 `POST /api/experimental/mcp/:name/connect|disconnect`는 다시 시작할 때까지만이다). 범위는 `admin`이다(이미 있는 서버를 켜고 끌 뿐 새 프로그램을 정하지 않는다).
- `enabled:null`은 정확히 그 자리(그 폴더, 또는 전역)의 스위치를 지운다. 그 자리는 다시 물려받는다(`되돌리기`).
- own의 서버가 그 자리에 닿으면(`McpFold.applies`, 전역 자리는 그 이름의 own 서버가 있으면) 그 자리가 물려받는 값과 같은 값은 저장하지 않고 그 자리의 스위치를 지운다. 물려받는 값은 전역 스위치, 그다음 그 폴더를 담는 더 얕은 폴더의 프로젝트 스위치(그 폴더 자신은 빼고)이고, 없으면 켜짐이다(own의 서버는 켜진 채 시작한다). 그래서 전역 `켜짐`은 저장하지 않고, 한 번 끄고 다시 켠 프로젝트에 남은 `켜짐`이 나중의 전역 `꺼짐`을 막지 않는다. 브리프의 "전역 스위치, 없으면 켜짐"보다 넓게 더 얕은 프로젝트 스위치도 센다(겹친 프로젝트에서 안쪽 `켜짐` 예외가 지워지지 않게, 결정 SG).
- 설정 파일 서버의 이름은 주어진 대로 저장한다(그 파일이 `disabled`로 꺼 두었을 수 있어 물려받는 값을 모른다).
- version 1의 `mcp.json`(2.3)은 읽을 때 version 2로 올린다(`McpStore.file`의 `normalize`: own-runtime `JsonFile`이 파일에서 읽은 값마다, 변경에 넘기기 전에 부른다). own 서버의 `enabled:true` 스위치 중 아무것도 바꾸지 않던 것(그 폴더를 담는 더 얕은 스위치가 끄지 않은 것)을 빼고 읽는다. version 1에서 own 서버는 켜진 채 시작하므로 접기는 같다. 꺼짐과 설정 파일 서버의 스위치는 그대로다. 변경은 올린 값 위에서 정하므로, version 1 파일의 첫 쓰기가 전역 `꺼짐`이어도 그런 `켜짐`이 그 프로젝트에 남아 전역 끔을 막지 않는다(SG-17. 처음에는 쓰기 직전에 올려서 새 전역 꺼짐과 견준 `켜짐`이 남았다). 파일은 첫 변경이 version 2로 쓴다.
- 서버의 이름을 바꾸거나 지우면 그 이름의 전역 스위치도 새 이름으로 따라가거나 지워진다. 같은 이름의 own 서버가 남아 있으면(서로 만나지 않는 폴더) 옛 이름의 전역 스위치도 남긴다.

`mcp.test` `{id?, transport?, directory?}` → `{at, ok, server?, tools:[{name, description?}], more?, failure?, status?, error?}`
- 저장된 서버(`id`)나 지금의 칸(`transport`, 칸에서 비운 값은 `id`의 저장된 값)을 잠깐 띄우거나(명령) 주소를 불러(Streamable HTTP) `initialize`와 `tools/list`(10쪽까지, 도구 200개까지)를 묻고 끈다. 명령은 서비스의 환경에 그 서버의 값을 더해 `directory`(없으면 프로젝트 범위의 폴더, 그것도 없으면 홈)에서 돈다. 상대 `cwd`는 그 폴더 기준이다(core와 같음). 멈추면 프로세스 트리째 끈다(`ProcessTree`). 20초 안에 끝나지 않으면 `timeout`이다.
- `failure`: `spawn`(명령을 못 띄움), `exited`(답하기 전에 끝남, `error`에 종료 코드와 오류 출력 끝 1,500자), `protocol`(MCP 답이 아님), `http`(`status`), `auth`(401: 저장한 뒤 core가 로그인한다), `timeout`. `error`에서 그 서버의 비밀인 값은 `••••`로 바뀐다. 서버가 답한 이름·버전(`server`, 300자까지)과 도구의 이름·설명도 같이 바꾼 뒤 답하고 `check`에 남긴다(값을 되풀이하는 서버, SM-22). 비밀인 값은 명령이나 인자가 `${이름}`으로 부르는 환경 변수 값(인자에서 옮긴 값은 모두 그렇다), 이름이 비밀 같은 환경 변수와 헤더의 값(SM-26부터 `keys`도 비밀 낱말이다: `apiKeys`, `API_KEYS`), 키처럼 보이는 값(경로 조각과 같은 규칙이라 `ANTHROPIC_MODEL=claude-3-5-sonnet-20241022` 같은 모델 이름은 아니다, SM-28), 이름과 상관없이 `scheme://` 주소인 값과 비밀 같은 부분(`Password=`, `pwd=`, `key=`, `AccountKey=`)이 있는 `이름=값;…` 연결 문자열(`McpSecrets.secretValue`, SM-26), 주소의 `?` 뒤와 숨긴 주소다. 주소와 연결 문자열은 비밀인 부분만 가린다. `REGION=us-east-1`, `Accept: application/json`, 폴더 경로, 비밀 부분이 없는 주소 같은 값은 가리지 않는다(SM-25, 가리는 법은 03 §18.14 가리기 규칙). 같은 목록이 연결 시험의 오류·오류 출력 끝·서버와 도구의 글, `mcp.json`의 `check`, `mcp.list`의 `errors`(core의 글)에 쓰인다.
- 저장된 서버를 그대로 시험하면 결과를 그 서버의 `check`로 남긴다(목록의 `도구 N개`). 칸의 시험은 남기지 않는다.

`mcp.import.scan` `{directory?}` →
```json
{ "nonce":"…","expiresAt":1761300600000,
  "files":[{"source":"codex","path":"C:\\Users\\demo\\.codex\\config.toml","state":"found","count":1}],
  "candidates":[{"key":"c1","source":"codex","name":"docs","suggested":"docs","scope":{"type":"global"},
    "transport":{"type":"local","command":"npx","args":["-y","docs-mcp"],"env":[{"name":"DOCS_KEY","hint":"…AbCd"}]},
    "enabled":true,"notes":["settings_dropped"],"imported":false}] }
```
- 사용자가 누를 때만 이 파일들을 연다: Codex `<codexHome>\config.toml`의 `[mcp_servers.*]`(`codexHome` 옵션, 아니면 `CODEX_HOME`, 아니면 `~\.codex`), Claude Code `<home>\.claude.json`의 `mcpServers`와 그 프로젝트 항목 `projects["<폴더>"].mcpServers`(`claudeHome` 옵션, 아니면 `%USERPROFILE%`와 서비스의 `CLAUDE_CONFIG_DIR`), 프로젝트의 `.mcp.json`. MCP 항목만 쓰고 파일은 바꾸지 않는다. 32 MiB가 넘는 파일은 읽지 않는다(`unreadable`).
- Claude Code의 `${VAR}`·`${VAR:-기본}`, Codex의 `env_vars`·`env_http_headers`·`bearer_token_env_var`는 이 서비스의 환경에서 읽는다(`env_read`, 없으면 그 값을 빼고 `env_missing`). Codex `enabled = false`는 `disabled`(처음에 체크하지 않음), `enabled_tools`·`disabled_tools`는 `tool_filter`, `http_headers_helper`는 `headers_helper`(실행하지 않음), 그 밖의 설정(시간 제한 등)은 `settings_dropped`다. 옛 SSE 방식(`type:"sse"`)은 `problem:"sse"`, 읽을 수 없는 항목은 `problem:"invalid"`로 가져올 수 없다.
- 값이 든 인자와 주소는 `mcp.save`처럼 옮긴다(`values_moved`). Claude Code의 `${VAR}`는 명령·인자·주소에 값으로 풀리지 않는다(위 "값은 파일과 답에 나오지 않는다").
- 같은 정의(명령·인자·환경 변수 이름, 또는 주소·`?` 뒤가 있는지·헤더 이름)가 여러 곳에 있으면 후보 하나다. 값이 든 주소(`hidden`)는 보이는 꼴이 아니라 진짜 주소의 keyed hash(서비스 프로세스마다 새 키의 HMAC-SHA256, 메모리에만)로 견준다. `••••`로 같아 보여도 다른 주소는 다른 후보다. 처음 찾은 곳이 `source`·`name`이고 나머지는 `also:[{source, name, differs?, values?}]`다. 값이 처음 곳과 다르면 `differs:true`와 그곳 값의 이름·끝 네 글자(`values`)가 붙는다(`값이 달라요`). 가져올 때 `place`로 고른 곳의 값을 쓰고, 없으면 처음 곳의 값을 쓴다. `imported`도 이 견줌을 쓴다(own의 값이 든 주소는 vault에서 읽어 견준다).
- `suggested`는 own의 서버와 겹치지 않는 쓸 수 있는 이름이다(맞지 않는 글자는 `-`, 겹치면 `-2`…; `McpRules.suggestName`, own-web의 붙여넣기와 같은 함수). 사용자 설정은 `global`, 프로젝트 항목과 `.mcp.json`은 그 프로젝트가 처음 값이다. `imported`는 own에 같은 정의의 서버가 있다는 뜻이다(어디서 가져왔든 직접 더했든, `이미 있음`).
- 읽은 값은 그 서비스의 메모리에만 10분 둔다(nonce). 답에는 이름과 끝 네 글자만 있다.

`mcp.import.apply` `{nonce, picks:[{key, name, scope, place?}]}` → `{imported:[{key, id, name}], view}`
- nonce는 한 번만 쓴다(만료·사용함·모름이면 `nonce_invalid`, 다시 읽으면 된다). 고른 것마다 이름과 범위를 `mcp.save`처럼 검사하고(`mcp_name_taken`, `mcp_invalid{field:"pick"|"directory"}`, 없는 `place`도 `pick`), 모두 맞을 때만 값을 vault에 넣고 서버를 더한다(`origin`에 값을 가져온 곳의 파일 종류와 원래 이름).
- 순서는 vault 먼저, `mcp.json` 다음이다. 적용하는 동안 nonce는 맵에서 빠져 같은 nonce로 두 번 가져오지 못한다. vault가 중간에 답하지 않거나 `mcp.json`을 쓰지 못하면 이번에 쓴 `mcp-<id>` 항목을 모두 지우고(지우지 못한 항목은 id만 `mcp_import_orphans`로 남김) nonce를 되돌린 뒤 `vault_unavailable`(또는 `internal_error`)다. 그래서 같은 읽기로 다시 가져올 수 있다(SM-22).

`mcp.registry.search` `{query?, cursor?}` →
```json
{ "registry":"https://registry.modelcontextprotocol.io",
  "entries":[{"name":"io.github.example/github","title":"GitHub","version":"1.4.0","publisher":"io.github.example",
    "repository":"https://github.com/example/github-mcp","status":"active","suggested":"github",
    "options":[{"type":"package","registryType":"npm","identifier":"@example/github-mcp","version":"1.4.0",
        "command":"npx","args":["-y","@example/github-mcp@1.4.0","--api-key","${API_KEY}"],
        "env":[{"name":"API_KEY","required":true,"secret":true}],"fill":[]},
      {"type":"remote","transport":"streamable-http","url":"https://mcp.example.com/{tenant}/mcp",
        "headers":[{"name":"Authorization","required":true,"secret":true,"template":"Bearer {api_key}"}],
        "variables":[{"name":"tenant","required":true,"secret":false}],"fill":["tenant"]}]}],
  "nextCursor":"io.github.example/github:1.4.0" }
```
- 찾아서 설치(03 §18.14). 공식 MCP Registry(`endpoints.mcpRegistry`, 기본 `https://registry.modelcontextprotocol.io`)의 `GET /v0.1/servers?limit=20&version=latest&search=…&cursor=…`를 이 PC에서 묻는다(15초). `search`는 레지스트리의 검색(서버 이름의 일부, 대소문자 무시)이다. 아무것도 저장·설치·실행하지 않는다.
- 항목마다 `server.json`의 패키지와 원격 주소를 own의 추가 양식이 받는 꼴로 바꾼다. 패키지는 실행할 명령을 그대로 보인다: npm `npx -y <id>@<버전>`(레지스트리의 `runtimeArguments`에 `-y`가 있으면 더하지 않음), PyPI `uvx <id>==<버전>`, OCI `docker run -i --rm -e <변수>… <이미지>:<버전>`, NuGet `dnx <id>@<버전> --yes`, 그 뒤에 `packageArguments`. 값이 정해진 인자는 그 값, 채울 인자는 `{이름}`(`fill`), 비밀 인자는 `${이름}`과 채울 환경 변수 값이다(값이 인자에 들어가지 않게). `cargo`·`mcpb`처럼 own이 바로 띄울 수 없는 것은 `problem:"runtime"`, stdio가 아닌 패키지는 `problem:"transport"`, 옛 SSE 주소는 `problem:"sse"`다. 원격 주소의 `{변수}`는 기본값이 있으면 넣고 없으면 `fill`에 남긴다. 값(`env`, `headers`, `variables`)은 이름, 설명, 필수, 비밀, 비밀이 아닌 기본값(`value`), `{…}`가 든 꼴(`template`)이다.
- `status:"deleted"`인 항목과 읽을 수 없는 항목은 그 항목만 뺀다. `publisher`는 이름의 `/` 앞(네임스페이스)이다. `suggested`는 이름의 마지막 조각을 `McpRules.suggestName`으로 만든 쓸 수 있는 이름이다.
- 레지스트리의 답은 남의 데이터다(SM-22). 본문은 조각으로 읽고 4 MiB를 넘는 순간(또는 `content-length`가 넘으면) 읽기를 멈춘다. 항목은 한 쪽(20개)까지, 항목마다 패키지 8개·원격 주소 8개, 인자는 종류마다 32개, 헤더·변수 32개, 값 64개까지 읽는다. 화면에만 보이는 글(제목 200자, 설명 500자, 게시자 200자, 값의 설명 500자, 꼴 500자, `registryType`·`transport` 32자)은 자른다. 양식이 그대로 쓰는 것(식별자 300자, 버전 100자, 인자 한 개 1,000자, 인자 64개, 채울 부분 100자, 주소 2,000자, 값 이름 128자)은 자르지 않는다(자른 명령은 다른 것을 실행한다). 넘는 방법은 빼고, 2,000자가 넘는 링크도 뺀다. 비밀이 아닌 기본값이 8,192자를 넘으면 채우지 않는다. `nextCursor`가 500자를 넘으면(이 메서드의 `cursor` 한도) 거기서 목록이 끝난 것으로 둔다. 버전이 빈 항목도 쓸 수 있다(`RegistryRef.version`은 선택).
- 실패는 `mcp_registry_unavailable{reason, status?}`: `offline`(연결이 없거나 15초 안에 답이 없음), `status`(오류 응답), `invalid`(서버 목록이 아님, 4 MiB 넘음), `disabled`(다른 endpoint만 받은 시험 서비스: 진짜 레지스트리는 묻지 않는다).

**MCP 서버를 SSH 호스트에서(MH, 2026-11-26, 04 §13.1, 03 §18.14)**: 이 PC의 MCP 서버를 SSH 호스트에 설치한다. 판정은 own-protocol `McpHostRules`(순수, own-web과 같은 함수)다.
- 호스트의 서비스(`deps.remote`)만 `mcp.host.*`에 답한다(이 PC는 `mcp_host_only{method}`). 목록은 호스트 OWN_HOME의 `mcp.json`(같은 꼴, 모두 `global`, 서버마다 `pc:{key, hash, at}`, 명령 서버는 번역이 정한 평문 변수 `fixed`), 값은 없다. 접기는 이 PC와 같은 `McpServers.register`에 호스트의 값 출처(`McpHostService.source`: 값이 필요 없는 서버는 빈 값, 아니면 브로커 `mcp.values`, 못 받으면 꺼짐, 다시 묻기는 브로커가 다시 붙거나 `mcp.changed` push가 올 때)를 준다.
- `mcp.host.view` `{}` → `{servers:[{id, name, transport, pc?, values:"none"|"ready"|"missing", check?, createdAt, updatedAt}], home}`(read).
- `mcp.host.probe` `{binaries?}` → `{at, os, arch, home, runtimes:{node?, npx?, uv?, uvx?, python?, pipx?, docker?, podman?, bun?, deno?:{version?}}, containers?:{docker?, podman?:"ok"|"denied"}, binaries:{<이름>: boolean}, ownBun?:{command, version?}}`(local). 서비스의 env에서 읽기만 하고(`--version`, `docker info`), sudo는 없다. 30초 캐시.
- `mcp.host.save` `{id?, name, transport, pc?}` → view(local). `~`와 `~/…`(명령, 인자, 작업 폴더, `--x=~/…`)는 호스트 홈의 절대 경로로 바꾼다. 이름 겹침 `mcp_name_taken`, 명령·인자의 `${이름}`이 `env`에 없으면 `mcp_invalid{field:"args"}`, http(s)가 아닌 주소 `mcp_invalid{field:"url"}`.
- `mcp.host.remove` `{id}`, `mcp.host.test` `{id}`(호스트에서 띄우는 연결 시험, PC가 보낸 값으로. 값이 없으면 없이 돌아 실패할 수 있다. 결과는 그 서버의 `check`), `mcp.host.prefetch` `{id}` → `{ok, kind:"npm"|"uv"|"none", output?}`(npx 패키지 `npm exec --yes --package=<pkg> -- true`, uvx·`uv tool run` 패키지 `uv tool install <pkg>`, 5분, 출력 끝 1,500자를 값을 가려서). 모두 local.
- 이 PC의 `mcp.hosts.send` `{hostId, server, source:{type:"own", id}|{type:"file", name, transport}, names}` → `{sends}`(local): 사용자가 누른 보내기. 값을 vault `mcp-send-<id>`에 복사하고(이름 하나라도 없으면 `mcp_secret_missing`, own 서버가 없으면 `mcp_not_found`) 기록을 `mcp-hosts.json`에 둔 뒤 runtime broadcast `mcp.hosts.changed{hostId}`로 브로커가 그 호스트에 `mcp.changed`를 보낸다. 같은 호스트·서버의 이전 사본은 지운다. `URL`은 주소의 `?` 뒤와 숨긴 주소다. `mcp.hosts.unsend` `{hostId, server}`는 사본과 기록을 지운다. `mcp.hosts.view` `{hostId?}`(read)는 기록(이름만)과 `differs`(own 서버의 값이 사본과 다름)다. 호스트는 셋 다 `remote_managed`.
- 브로커 `mcp.values {server}`는 그 세션의 호스트 id로 기록을 찾아 사본을 답한다. 다른 호스트의 같은 서버 id는 받지 못한다.
- 설치 도구 `own_mcp_install`(호스트 Location마다, 직접 도구): 모든 에이전트에 `{own_mcp_install, *, deny}`(local `plugin.updated`마다 다시 맨 뒤)를 두어 대화 규칙이 허용한 대화(own-web이 `AI에게 설치 맡기기`로 만든 것)에서만 보인다. 대화의 `metadata.own.mcpInstall`(`McpHost.Job`: `key`, `hash`, `name`, `env`, `codemode?`)이 없으면 거절한다. 입력 `{command, args, cwd?, fixed?}`(`fixed`에 일의 값 이름은 넣을 수 없음), `permission.assert`(resource = 서버 이름)를 거쳐 `evaluate` 훅이 승인 모드대로 정한다(`묻기` ask, `읽기 전용` deny). 같은 키나 이름의 서버를 바꿔 쓰고 연결 시험 결과를 글로 돌려준다.

**스킬 스위치와 쓰는 곳(SG, 2026-10-26, 03 §19.6.1)**: 스킬은 전역이 먼저다. core가 읽는 이 앱의 스킬 폴더(`OPENCODE_CONFIG_DIR\skills`, own-import의 복사본이 가는 곳), 전역 폴더, Claude Code 개인 폴더(`~\.claude\skills`), core의 기본 제공 스킬은 모든 프로젝트에서 쓰고, 프로젝트 폴더의 스킬(`.opencode\skills`)은 core가 그 프로젝트에서만 읽는다. own.accounts는 그 위에 두 가지 기록을 `skill-switches.json`(2.3)에 두고 각 프로젝트의 스킬에서 꺼진 것을 뺀다. 두 메서드 모두 control location이고 원격 서비스는 `remote_managed`다(SSH 호스트의 스킬은 그 호스트 폴더의 것이다).
- 스위치 `{id, directory?, enabled}`: 스킬 id 하나를 모든 프로젝트(`directory` 없음)나 한 프로젝트 폴더와 그 안쪽 폴더에서 끄거나 다시 켠다. core의 기본 제공 스킬(`opencode`, `report`)도 끌 수 있다. id로 정하므로 같은 id의 프로젝트 스킬에도 닿는다.
- 쓰는 곳 `{folder, directory}`(`이 프로젝트만`): `folder`의 스킬을 `directory`와 그 안쪽에서만 쓴다. `folder`는 스킬의 폴더(`SKILL.md`가 있는 곳. core는 스킬 폴더 아래의 `{*.md,**/SKILL.md}`를 모두 스킬로 읽으므로 그 폴더 아래에 든 스킬도 함께다)이거나, 폴더를 다른 스킬과 함께 쓰는 납작한 스킬(`<id>.md`)이면 그 파일이다(SG-19). 경로로 정하므로 다른 폴더의 같은 id 스킬(프로젝트 스킬)은 그대로다.
- 판정(own-accounts `SkillsetFold.judge`): (a) 스킬 파일이 `folder` 자체이거나 그 안에 있는(`Location.within`) 쓰는 곳 가운데 가장 깊은 것(`SkillsetFold.scopeOf`)의 `directory`가 이 Location을 담지 않으면 `scope`로 끈다. 그래서 묶음 폴더의 쓰는 곳은 그 안의 스킬에도 닿고, 그 안에 더 깊은 쓰는 곳이 있으면 그것이 이긴다(SG-19. 처음에는 `dirname(path)`와 같은 `folder`만 봐서 안에 든 스킬이 빠져나갔고, 납작한 스킬의 쓰는 곳은 그 폴더의 납작한 스킬 모두에 닿았다). 쓰는 곳이 스위치보다 앞선다. (b) 아니면 켜짐에서 시작해 그 id의 전역 스위치(`global`), 이 Location을 담는 프로젝트 스위치를 얕은 것부터 깊은 것 순서로(`project`) 적용하고, 끔이면 마지막에 정한 쪽으로 끈다. control Location은 아무것도 빼지 않는다(그 목록이 카탈로그다).
- 접기: 모든 Location(control은 빼고)의 own-accounts가 `ctx.skill.transform`으로 판정된 스킬을 `editor.remove(id)`로 빼고, 뺀 것(id, 이름, 설명, 경로, `autoinvoke`; 내용은 아님)을 기억한다. core의 설정 폴더 스킬은 구성 플러그인 뒤에 도는 내장 `post` 플러그인(`ConfigCompatibilityPlugin`, `ConfigSkillPlugin`, check-surface `builtin-plugin-placement`)이 더하므로, 설정 단계의 끝(`Hooks.register` 뒤)에 한 번 등록하고 그 Location의 `plugin.updated`(`meta.local`)마다 다시 등록해 마지막에 돌게 하며 이전 등록은 치운다(07 §5.4 숨은 에이전트 모델 접기, own-harness `src/skills.ts`의 synced 스킬 빼기와 같은 방식). 등록은 하나씩 차례로 한다. 파일은 첫 등록 전에 읽는다. 재시작 뒤 실측(SG): core의 Location 첫 답은 빈 목록이고, 기본 제공 스킬이 오고, 약 0.7초 뒤 설정 폴더 스킬이 온다. 꺼 둔 프로젝트의 목록에는 그 스킬이 한 번도 나오지 않았다(8초 동안 계속 물음, 세 번).
- 모듈: own-accounts 모듈 `skillset`(`modules.ts`의 `FACTORIES`·`ORDER`·`EVENT_ORDER`)이 상태를 가진다. 원격 서비스(`deps.remote`)는 아무것도 등록하지 않는다. 마지막 접기에서 뺀 것이 바뀌면 `skills_switched_off{ids}`를 한 번 남긴다. runtime broadcast `skillset.removed.query{directory, reply}`(`agents.removed.query`와 같은 모양)에 자기 폴더(`Location.same`)일 때 답한다. 멈추면 등록과 구독을 모두 치운다.
- `skillset.view` `{directory?}` → `{catalog, switches, scopes, off?}`. `catalog`는 control Location의 스킬(`ctx.skill.list()`, 내용은 뺌)이다. `directory`가 있으면 `off`는 그 프로젝트 Location이 마지막 접기에서 뺀 것(`skillset.removed.query`의 답)이고, 그 Location이 이 프로세스에 열려 있지 않으면 카탈로그로 판정한 것에 카탈로그에 없는 id(프로젝트 폴더의 스킬)의 프로젝트 스위치를 id만으로 더한다. 각 줄은 `{id, by: "scope"|"global"|"project", name?, description?, path?, autoinvoke?}`다.
- `skillset.switch` `{changes: [{id, directory?, enabled: boolean|null}] (400개까지), scopes?: [{folder, directory: string|null}] (200개까지)}` → `skillset.view`(폴더 없이)와 같은 모양. control 인스턴스가 한 번의 `store.update` 안에서 쓰는 곳을 먼저(같은 `folder`는 바꾸고 `null`은 지움), 스위치를 다음에 바꾼다. 스위치는 정확히 그 자리의 것을 바꾸거나 `null`이면 지운다. 그 자리가 물려받는 값(`SkillsetFold.inherited`: 전역 스위치, 그 폴더를 담는 더 얕은 프로젝트 스위치, 없으면 켜짐; 쓰는 곳은 세지 않음)과 같은 값은 지우기로 저장한다. 그래서 전역 `켜짐`은 저장하지 않는다. 상대 경로(`directory`, `folder`), 빈 입력(`changes`), 보관 한도를 넘김(`changes`, `scopes`)은 `skillset_invalid{field}`이고 아무것도 저장하지 않는다.
- 알림: 쓴 뒤 runtime broadcast `skillset.changed{settle}`로 모든 Location에 알린다. 각 Location은 파일을 다시 읽고 스냅숏이 바뀌었을 때만 `ctx.skill.reload()`를 부르며 그 일을 `settle`로 넘긴다. control 인스턴스는 열린 Location이 모두 접을 때까지(5초까지) 기다린 뒤 RPC 이벤트 `skillset.changed`를 내고 답한다. core는 플러그인의 `ctx.skill.reload()`를 Location 없는 `skill.updated`로 알리고 own-web의 데이터 층(`client/src/solid/data.ts`)은 Location 없는 그 이벤트로 목록을 다시 읽지 않으므로, 페이지가 이 답이나 이벤트를 받고 그 프로젝트의 스킬 목록을 다시 읽는다(결정 SG, core 변경 없음). 그리고 own-web의 서버 런타임(첫 청크, `staleSkillsOnSwitch`)은 RPC 이벤트 `skillset.changed`에서 그 런타임이 읽은 모든 Location의 스킬 목록을 낡은 것으로 표시한다. 창과 휴대폰은 저마다 자기 이벤트 스트림으로 이 이벤트를 받으므로, 다음 `@`·`/` 목록, ✦ 팝오버, 설정 페이지가 어느 창에서든 그 목록을 다시 읽는다(SG-18. 처음에는 열린 설정 페이지의 프로젝트와 열린 팝오버의 폴더만 다시 읽어, 다른 프로젝트의 `@` 목록이 끈 스킬을 내놓았고 고르면 `SkillNotFoundError`로 실패했다).
- 캐시: 스킬을 켜거나 끄면 그 Location의 스킬 목록이 바뀌므로 core는 그 프로젝트 대화의 다음 요청에 스킬 목록 변화를 한 번 붙인다. Codex·Pi·DeepSeek 방식(own-harness)은 스킬 목록을 요청 앞부분에 두고 지금 목록에 없는 id를 바로 뺀다(`sessionSkills`). 그래서 그 대화는 다음 요청에서 캐시를 처음부터 다시 쓴다. 캐시가 바뀌지 않는 스킬 블록은 사용자가 정할 선택지로 남긴다(결정 SG).
- 가져오기와 지우기(09 §9.4, §9.6): own-web은 가져올 때(새 복사본도, 같은 이름의 복사본을 `바꾸기`로 바꿀 때도) 먼저 복사본 폴더(`<skills.list directory>\<최종 id>`)에 고른 쓰는 곳을 저장하고 그다음 복사한다. `이 프로젝트만`이면 그 프로젝트이고, `모든 프로젝트`면 그 폴더의 쓰는 곳을 지운다(손으로 지운 폴더가 남긴 쓰는 곳, SG-21). 그 폴더 안의 쓰는 곳도 지운다. 이미 그렇다면 쓰지 않는다. 복사가 실패하면 쓰는 곳을 이전대로 돌린다. 업데이트의 `다시 가져오기`만 쓰는 곳을 건드리지 않는다(SG-20. 처음에는 `바꾸기`도 건드리지 않아 `이 프로젝트만`으로 바꾼 복사본이 옛 쓰는 곳에 남았다). `skills.remove`가 성공하면 그 폴더와 그 안의 쓰는 곳을 지운다.
- 로그는 개수와 끈 id만 남긴다(폴더는 남기지 않는다).

### 9.3 이벤트(`rpc.own.accounts.<name>`)

발행자는 모두 own-accounts다(9.1). "데이터 출처"는 own-accounts가 그 값을 어디서 받는지다.

| 이름 | 데이터 | 발행 인스턴스 | 데이터 출처 |
|---|---|---|---|
| `accounts.changed` | `{eventId, revision}` | leader | own-accounts 레지스트리 |
| `quota.updated` | `{eventId, accountID, windows: LimitWindow[], resetCredits?: ResetCredits \| null}` | leader | own slot은 own-accounts, `anthropic`의 `claude.*` 창은 own-telemetry → `own-runtime`. 월 예산 창 포함(7.4). 창을 잃은 계정(예산 삭제)은 빈 목록일 수 있다. `resetCredits`는 그 계정의 리셋권 수를 알 때마다 싣는다(7.1.1, RP). 창이 아니고, 수만 바뀌어도 낸다. `null`은 수를 모르게 된 것이다(쓴 뒤 읽기에 수가 없음, RP-13): 화면은 보이던 수를 지운다 |
| `account.status` | `{eventId, accountID, status, reason?, until?, phase?}`. 로그인 진행 상황 포함. 소진이면 `reason`은 소진된 창 id, 창이 없으면 분류 코드(예: siwc `subscription_sharing_usage_limit_exceeded`, 3.2c), 그것도 없으면 class(`hard`/`auth`)다. 모델별 주간 묶음의 소진은 계정 상태가 아니므로 내지 않는다(5.2) | leader | 로그인·refresh·own slot 소진·인증 실패는 own-accounts, `anthropic` 소진은 own-telemetry → `own-runtime` |
| `cache.state` | `{eventId, sessionID, slots:[…], compaction}`. step이 끝날 때, warm→cooling→cold 경계에서, 압축 기준이 바뀔 때(4.7) | 세션 location | own-accounts 캐시 상태(KV, 2.4.6)와 압축 기준 해석 |
| `compaction.due` | `{eventId, sessionID, inputID, P, triggerTokens, epoch}`. 세션 압축 기준("더 일찍")에 닿았다. own-accounts가 revert가 없음을 확인한 뒤 `ctx.session.compact{id: inputID}`로 이미 넣었다(2026-10-08). 받은 클라이언트가 같은 id로 보내도 같은 항목이거나 409다(4.7.4). staged revert 동안은 내지 않는다. v0.3에서 추가 | 세션 location | own-accounts(`step.ended` 판정) |
| `approval.changed` | `{eventId, sessionID, mode, patched: sessionID[]}`. `session.approval.set`이 부모와 자식의 권한을 고쳤다. v0.4에서 추가 | 세션 location | own-accounts(9.2 승인 모드) |
| `binding.changed` | `{eventId, sessionID, model, previous, accountID, reason, external:boolean}` | 세션 location | core `session.model.selected` |
| `switch.recorded` | `{eventId, sessionID, from, to, strategy, reason, estimate:{lo,hi,unit}, actual?:{cold, unit}}`. `actual`은 첫 step이 끝난 뒤 한 번 더 보낸다 | 세션 location | own-accounts 상태 머신. `actual`은 own-accounts ledger 줄(7.5) |
| `switch.scheduled` | `{eventId, sessionID, target, trigger, idleMinutes, uncertain, deadline}` | 세션 location | own-accounts |
| `switch.state` | `{eventId, sessionID, state, detail}` | 세션 location | own-accounts |
| `switch.suggested` | `{eventId, sessionID, reason:"hard"\|"auth"\|"home_available"\|"reset_passed", candidates:[…], continue:boolean}` | 세션 location | own-accounts(`anthropic` 소진 판정은 own-telemetry → `own-runtime`) |
| `ledger.step` | `{eventId, line: LedgerLine}` | 세션 location | own-accounts(step 이벤트 → runtime ledger writer, 7.5) |
| `alert` | `{eventId, code, severity, sessionID?, accountID?, directory?, message}` | 세션 경보는 세션 location, 전역·Location 경보는 leader | own-accounts(7.7). `claude_extra_usage`만 own-telemetry → `own-runtime` |
| `plugin.status` | `{eventId, plugin:"claudeAuth", phase, step?, ok?, error?}` | leader | own-accounts. 이 위치에서 claude-auth가 감지되거나 빠지면(감지·검증 상태가 바뀌면) 보낸다. Claude 구독 계정은 감지된 동안만 `accounts.list`에 들고, 이 변화는 레지스트리 리비전을 바꾸지 않는다. own-web은 이때 `accounts.list`를 다시 읽는다(CL, 2026-11-27: 서비스 시작 직후 읽은 목록에 AC-01..04가 빠진 채 남던 문제) |
| `plugin.trust.changed` | `{eventId, directory, status:"ok"\|"blocked_by_plugin", pending:number}` | leader | own-accounts allowlist 검사(4.2) |
| `presets.changed` | `{eventId, removed?: Preset.ID[]}`. `presets.json`이 바뀌었다(프리셋, ★, 가벼운 짝, 새 대화 기본 모델, 전역 설정). `removed`는 이 변경으로 지운 프리셋이다(그 세션들은 묶음의 ★로 감). 받은 클라이언트는 `presets.list`를 다시 부른다. T0에 더함, `removed`는 T1(07 §8.1). T2: 파일이 그대로여도 열린 수리 알림(`repairs`)이 바뀌면 낸다(07 §4.3) | leader | own-accounts(`store.changed{store:"presets"}`, T2는 수리 확인 `PresetRepair`도) |
| `session.preset.changed` | `{eventId, sessionID, binding: Preset.Binding}`. 루트 세션의 바인딩이 바뀌었다(`session.preset.apply`, 울트라 켜기·끄기, 지운 프리셋 뒤 ★로 다시 묶기). T1(07 §8.1) | 세션 location | own-accounts(KV `sess:<root>:preset`) |
| `session.speed.changed` | `{eventId, sessionID, choice, effective, tier, reason: "user"\|"fallback"\|"cooldown"\|"downgraded"\|"recovered"}`. 루트의 속도가 바뀌었다(4.8). 받은 클라이언트는 `session.speed.get`을 다시 읽고 `user`가 아니면 알림을 보인다 | 세션 location | own-accounts(KV `sess:<root>:speed`, `runtime.speed` 표시, 받은 tier) |
| `ideas.changed` | `{eventId, id, rev: number\|null}`. 아이디어 노트 하나가 저장되었거나(`rev`) 지워졌다(`null`). 내용은 싣지 않는다. 받은 클라이언트는 그 revision이 자기 것보다 새로우면 `ideas.list`를 다시 부른다(IDEAS, 9.2) | leader(호출이 오는 control location 인스턴스) | own-accounts(KV `ideas:*`) |
| `projectList.changed` | `{eventId, list:{pinned, order, orderedAt}}`. 프로젝트 순서나 고정이 바뀌었다(`projectList.set`). 받은 클라이언트는 그 값을 쓴다(SBL, 9.2). 원격 서비스는 전역 이벤트를 내지 않으므로 호스트의 다른 창은 다시 연결할 때 `get`으로 읽는다 | leader(control location 인스턴스) | own-accounts(KV `projectList`) |
| `conversationFolder.changed` | `{eventId, folder:{path, defaultPath, custom, exists}}`. 기본 대화 폴더가 바뀌었거나(`set`) 만들어졌다(`ensure`). 받은 클라이언트는 그 값을 쓴다(DF, 9.2). 원격 서비스는 전역 이벤트를 내지 않으므로 호스트의 창은 다시 연결할 때 `get`으로 읽는다 | leader(control location 인스턴스) | own-accounts(KV `conversationFolder`) |
| `folderPicker.changed` | `{eventId, picker:{start, home}}`. 폴더 열기 시작 위치가 바뀌었다(DF, 9.2) | leader | own-accounts(KV `folderPicker`) |
| `codexModels.changed` | `{eventId, view}`. `codexModels.get`의 답이 바뀌었다: 설정, 레지스트리에서 읽은 Codex 최신 릴리스, 묻는 버전, 목록을 받은 시각이나 own이 뺀 행 수(CA, 9.2). 받은 클라이언트는 그 값을 쓴다 | leader | own-accounts(`codex-meta.json`) |
| `mcp.changed` | `{eventId}`. own이 더한 MCP 서버나 목록 스위치, 저장된 서버의 시험 결과가 바뀌었다(SM, 9.2). vault가 다시 답해 값을 못 읽던 서버가 돌아와도 낸다(SM-22). 값은 싣지 않는다. 열린 설정 페이지는 `mcp.list`를 다시 읽는다 | leader | own-accounts(`mcp.json`, 값을 다시 읽은 Location) |
| `skillset.changed` | `{eventId}`. 스킬 스위치나 쓰는 곳이 바뀌었다(SG, 9.2 `skillset.switch`). 열린 Location이 모두 다시 접은 뒤에 낸다. id는 싣지 않는다. 열린 설정 페이지와 ✦ 스킬 팝오버는 `skillset.view`와 그 프로젝트의 스킬 목록을 다시 읽고, own-web은 그 창이 읽은 모든 Location의 스킬 목록을 낡은 것으로 표시한다(SG-18) | leader | own-accounts(`skill-switches.json`) |
| `claudeAgent.pool` | `{eventId, pool}`. Claude Agent 프로세스 풀이 바뀌었다(8.10.12): `live`, `cap`, `over`, `spares`, 자리를 기다리는 대화 `waiting[{sessionID, since}]`. 계정 화면의 `실행 중인 Claude n/cap` 줄과 기다리는 대화의 입력창 줄이 쓴다. 같은 값이면 다시 내지 않는다 | leader | 코어 프로바이더의 관찰 채널(P-044), `accounts.json` `claudeAgentPool` |
| `notes.changed` | `{eventId, workspace, id, rev: number\|null}`. 워크스페이스 노트가 저장되었거나(`rev`) 지워졌다(`null`). 제목·내용은 싣지 않는다. 받은 클라이언트는 자기 revision보다 새로우면 `notes.list`·`notes.get`을 다시 부른다(NOTES, 9.2) | leader(호출이 오는 control location 인스턴스) | own-accounts(KV `notes:*`) |

### 9.4 오류 `type`과 선언 규칙

- **선언 규칙(소스 확인)**: 400 `RpcError{type}`가 되려면 두 조건이 모두 필요하다.
  - 메서드 정의의 `errors` 맵에 그 type이 선언되어 있어야 한다(`schema/src/rpc.ts:13-17`). `rpc.`로 시작하는 이름은 예약되어 쓸 수 없다(`:48-60`).
  - 핸들러가 `context.error(type, message, data)`로 만든 값을 **돌려줘야** 한다(`plugin/src/promise/rpc.ts:7-17`, `plugin/src/promise/adapter.ts:128-150`).
  - 그렇지 않으면 core가 defect로 보고 500 `rpc.internal`로 바꾼다. 일반 `throw`나 reject, 선언하지 않은 type이 모두 그렇다(`core/src/rpc.ts:120-131,232-240`, `protocol/src/errors.ts:14-33`).
- **규칙**
  - `@own/protocol`의 각 메서드 정의에 그 메서드가 낼 수 있는 type을 모두 `errors` 맵으로 선언한다. 각 type에 `data` 스키마를 둔다(없으면 빈 object).
  - 핸들러는 절대 throw하지 않는다. 모든 오류 경로에서 `return context.error(...)`를 쓴다. 예상하지 못한 예외는 핸들러 최상단에서 잡아 `internal_error`로 바꾸고, 로그에는 가림 처리한 메시지만 남긴다.
  - own-web 계약 테스트(AC-P37)가 메서드마다 대표 오류 하나를 일으켜 "HTTP 400 + 기대한 type"을 확인한다.
- **type 목록**

| type | 주로 내는 메서드 | `data` |
|---|---|---|
| `account_not_found` | `accounts.*`, `switch.*` | `{accountID}` |
| `slot_misconfigured` | `switch.estimate/apply` | `{providerID, problems[]}` |
| `session_busy` | `plugin.claudeAuth.changeSource.execute`(apply는 WAIT_SAFE를 돌려주므로 거의 내지 않음) | `{sessionIDs[]}` |
| `estimate_expired` | `switch.apply` | `{estimateID}` |
| `no_eligible_target` | `switch.estimate` | `{reasons[]}` |
| `needs_reauth` | `accounts.test`, `switch.apply` | `{accountID}` |
| `probe_failed` | `accounts.add.key`, `accounts.test` | `{status?, message}` |
| `duplicate_account` | `accounts.add.key`(같은 키 재등록) | `{accountID}` |
| `ack_required` | `remote.ack`(번들의 pin·원격 고지 해시와 다름, `stale`), `remote.set`(원격 동의 없음, `remote`. 04 §8.11.12). 2026-10-18 전에는 `install.plan`, `importSubscription`, `ack`(로컬 동의 없음·값 불일치)도 | `{reason:"missing"\|"stale"\|"remote"}` |
| `policy_denied` | `policy.set`, `accounts.update`(합성 계정, `pollBalance`를 받지 않는 kind) | `{field}` |
| `trust_hash_mismatch` | `plugin.trust.approve.execute` | `{source, expected, actual}` |
| `undo_window_closed` | `switch.undo` | `{}` |
| `unsupported_strategy` | `switch.apply`, `cache.setTtlMode`(MVP) | `{strategy}` |
| `invalid_schedule` | `switch.schedule` | `{idleMinutes, deadlineMinutes}` |
| `nonce_invalid` | 모든 `*.execute` | `{}` |
| `plugin_not_installed` | `plugin.claudeAuth.changeSource.*`, `importSubscription`, `accounts.add.plan`, `remote.set`(켜기, 04 §8.11.12). claude-auth가 감지되지 않음 | `{}` |
| `template_unavailable` | `accounts.add.*`, `accounts.update{refreshCatalog}` | `{kind, reason}` |
| `vault_unavailable` | 비밀을 읽고 쓰는 모든 메서드 | `{}` |
| `source_not_found` | `accounts.import.codex.plan/execute`(구현됨) | `{profileID}` |
| `source_invalid` | `accounts.import.codex.plan/execute`(구현됨) | `{profileID, reason: "unreadable"\|"parse_failed"\|"not_chatgpt"\|"missing_tokens"\|"token_expired"\|"account_mismatch"}` |
| `legacy_key_not_found` | `accounts.import.keys.plan/execute`(3.2b) | `{providerRef}` |
| `legacy_key_invalid` | `accounts.import.keys.plan/execute`(3.2b) | `{providerRef, reason: "not_found"\|"decrypt_failed"\|"path_denied"\|"invalid_key"\|"unreadable"\|"unsupported_provider"\|"helper_outdated"}` |
| `setting_out_of_range` | `compaction.setSession`, `accounts.update{compaction}`, `policy.set{compaction}`(v0.3), `policy.set{compaction.keepTokens}`, `plugin.claudeAuth.changeSource.plan{configDir}`(v0.4: 상대 경로, CS: own의 로그인 폴더) | `{field, min: number\|null, max: number\|null}` |
| `revert_staged` | `switch.apply`(`compact-then-switch`, `switch-then-compact`)(v0.4, 4.7.4) | `{sessionID}` |
| `websearch_unavailable` | `websearch.get`, `websearch.set`(2026-10-10, 03 §18.2) | `{reason:"unknown_service"\|"config_unavailable", id?}` |
| `websearch_key_invalid` | `websearch.key.set`(2026-10-19 SP): 앞뒤 공백을 뗀 키가 비었거나 공백·제어 문자가 있음 | `{}` |
| `not_supported` | `quota.resetCredits.*`(RP, 7.1.1): `codex`가 아닌 계정(siwc, Claude, API 키). 업스트림 요청 없음 | `{kind}` |
| `credential_not_ready` | `quota.resetCredits.*`(RP): 로그인을 그대로 쓸 수 없음. `cause`: `expiring`(10분 이하 남음), `needs_reauth`, `missing`(저장된 로그인 없음), `source_stale`(이전 앱이 갱신하지 않음), `unusable`. 갱신하지 않는다 | `{accountID, cause}` |
| `limit_reset_failed` | `quota.resetCredits.list`, `redeem.execute`(RP): 답 없음(`timeout`, `network`), 오류 상태(`status`), 다른 답(`invalid`). `execute`의 nonce는 남고 재시도는 같은 요청 id | `{reason, status?, retryable}` |
| `remote_managed` | 원격 모드의 관리 메서드(04 §16.5), `presets.defaults.set`(T0), `presets.suggest`·`presets.set`·`presets.remove`(T1), `voice.*`(VOICE), `websearch.key.*`(SP) | `{method}` |
| `same_company_subscription` | `presets.set`, `session.preset.apply`(T1, 07 §5.4). 06 own.team과 같은 이름·같은 뜻 | `{accountID}` |
| `preset_not_found` | `presets.set`·`remove`, `session.preset.apply`(T1). 원격 서비스에는 T3 전까지 `평소대로`만 있다 | `{presetID}` |
| `preset_wrong_group` | `presets.set`, `session.preset.apply`(T1). `group`은 세션 메인 계정의 묶음 | `{group}` |
| `preset_target_unavailable` | `presets.set`, `session.preset.apply`(T1). 모르는 대상, 도구를 못 쓰는 대상 | `{role}`(`Preset.Spot`: 역할, `single`, T4부터 모델 묶음 항목 `pool:<key>`) |
| `preset_builtin_locked` | `presets.set`·`remove`(T1). `평소대로`는 바꾸거나 지울 수 없다 | `{presetID}` |
| `preset_budget_exhausted` | `session.preset.consent`(T1). 그 종량제 계정의 월 예산을 다 씀 | `{accountID}` |
| `speed_unavailable` | `session.speed.set`(4.8). 메인이 그 속도를 지금 주지 않음 | `{speed, reason}` |
| `speed_consent_required` | `session.speed.set`(4.8). Claude 구독 슬롯의 첫 Fast에 추가 사용량 동의가 없음. 원격 서비스는 KV에 쓰지 않고 `recordOn:"local"`을 붙인다(동의는 PC의 `plugin.claudeAuth.fastAck`, 04 §8.11.9) | `{recordOn?:"local"}` |
| `team_switch_required` | `switch.estimate`·`apply`·`schedule`(T1, 07 §5.5). 팀의 구독 계정은 own.team `team.account` 작업(`teamOp`)으로만 바뀐다 | `{teamID}` |
| `note_not_found` | `notes.get`(NOTES). 그 워크스페이스에 그 id의 노트가 없음(저장한 적 없거나 지워짐) | `{id}` |
| `note_conflict` | `notes.put`, `notes.remove`(NOTES). `baseRev`가 저장된 revision이 아님. `current`는 저장된 노트이고 지워졌으면 `null`이다 | `{current: {id, title, text, rev, updatedAt}\|null}` |
| `notes_limit` | `notes.put`(NOTES). 워크스페이스가 이미 `max`개를 가짐 | `{max}` |
| `idea_conflict` | `ideas.put`, `ideas.remove`(IDEAS). `baseRev`가 저장된 revision이 아님(만들기 `baseRev:0`인데 이미 있음 포함). `current`는 저장된 아이디어이고 지워졌으면 `null`이다 | `{current: {id, text, color, pinned, rev, createdAt, updatedAt}\|null}` |
| `ideas_limit` | `ideas.put`(IDEAS). 이 PC가 이미 `max`개(1,000)를 가짐 | `{max}` |
| `conversation_folder_unavailable` | `conversationFolder.set`, `conversationFolder.ensure`(DF). 그 폴더를 기본 대화 폴더로 쓸 수 없거나, 만들거나 쓰지 못함. 아무것도 저장하지 않음 | `{reason:"relative"\|"root"\|"home"\|"app"\|"not_folder"\|"create_failed"\|"not_writable", path}` |
| `folder_picker_unavailable` | `folderPicker.set`(DF). 절대 경로가 아니거나, 없거나, 폴더가 아님 | `{reason:"relative"\|"missing"\|"not_folder", path}` |
| `folder_list_unavailable` | `folderPicker.list`(SN). 그 폴더를 둘러볼 수 없음 | `{reason:"relative"\|"missing"\|"not_folder"\|"denied"\|"failed", path, owner?}` |
| `folder_create_unavailable` | `folderPicker.create`(SN). 아무것도 만들지 않음 | `{reason:"name"\|"exists"\|"relative"\|"missing"\|"not_folder"\|"denied"\|"failed", path}` |
| `mcp_name_taken` | `mcp.save`, `mcp.import.apply`(SM). own이 더한 다른 서버가 이 서버가 돌 곳에서 같은 이름을 씀(대소문자 무시) | `{name}` |
| `mcp_not_found` | `mcp.save`, `mcp.remove`, `mcp.test`(SM). own이 더한 서버 중 이 id가 없음 | `{id}` |
| `mcp_host_only` | `mcp.host.*`(MH). 이 PC의 서비스에 물었다: SSH 호스트의 메서드다 | `{method}` |
| `mcp_secret_missing` | `mcp.save`, `mcp.test`(SM). 값을 비워 "그대로 두기"로 한 이름에 저장된 값이 없음 | `{name}` |
| `mcp_registry_unavailable` | `mcp.registry.search`(SM). MCP Registry가 답하지 않음(`offline`), 오류로 답함(`status`), 서버 목록이 아님(`invalid`), 이 서비스는 묻지 않음(`disabled`) | `{reason, status?}` |
| `mcp_invalid` | `mcp.save`, `mcp.enable`, `mcp.test`, `mcp.import.apply`(SM). `url`(http·https가 아니거나 새 서버에 없음), `directory`(절대 경로가 아님), `test`(시험할 것이 없음), `pick`(그 읽기에 없는 후보), `args`(명령·인자의 `${이름}`에 맞는 환경 변수 값이 없음) | `{field:"url"\|"directory"\|"test"\|"pick"\|"args"}` |
| `skillset_invalid` | `skillset.switch`(SG). `directory`·`folder`가 절대 경로가 아님, 바꿀 것이 없음(`changes`), 보관 한도(스위치 2,000개, 쓰는 곳 500개)를 넘김(`changes`, `scopes`). 아무것도 저장하지 않음 | `{field:"directory"\|"folder"\|"changes"\|"scopes"}` |
| `voice_unavailable` | `voice.transcribe`(VOICE, 3.9). 꺼져 있거나 고른 서비스의 음성 키가 없음. 아무것도 보내지 않음 | `{reason:"disabled"\|"key_missing", provider}` |
| `voice_key_invalid` | `voice.key.set`(VOICE). 자른 뒤 비었거나 공백·제어 문자가 있음 | `{}` |
| `voice_audio_invalid` | `voice.transcribe`(VOICE). 빈 녹음, base64가 아님, 4 MiB 초과, 180초 초과 | `{reason:"empty"\|"encoding"\|"too_large"\|"too_long", max?}` |
| `voice_failed` | `voice.transcribe`(VOICE). 인식 서비스가 거절하거나 실패함. 서비스의 본문은 넣지 않는다 | `{provider, reason:"auth"\|"rate_limited"\|"quota"\|"rejected"\|"network"\|"timeout"\|"provider", status?, retryable}` |
| `internal_error` | 모두 | `{}` |

- **메서드 전용 오류**(T0): `worktree.inspect`의 `not_found{directory}`(프로젝트의 작업 폴더 표에 없음, UNC·장치 경로, 또는 `root`가 알려 주는 연결 작업 폴더가 아님)와 `not_git{directory}`(git이 저장소로 열지 못함)는 그 메서드에만 선언하고 `OwnError` 목록에는 넣지 않는다(`packages/own-protocol/src/rpc.ts` `worktreeErrors`). 선언과 `return context.error(...)` 규칙은 위와 같다.

### 9.5 v0.3·v0.4의 `@own/protocol` 변경 목록

구현자가 이 목록대로 고친다. 원격(04 §16.5)의 변경은 04가 기준이라 여기 넣지 않았다(`LedgerLine.server`만 겹쳐서 적음). v0.4 행은 표 아래에 따로 모았다.

| 파일 | 변경 |
|---|---|
| 새 `compaction.ts`(`export * as Compaction`) | `Setting = {triggerPercent?: Int 10–90, maxTriggerTokens?: PositiveInt\|null, minReserveTokens?: NonNegativeInt, models?: Record<Model.ID, Setting에서 models를 뺀 것>}`<br>`Source = "v2"\|"kind"\|"kindModel"\|"account"\|"accountModel"\|"session"`<br>`Effective = {modelID, windowTokens, triggerTokens, source}`<br>`View`(9.2 `cache.state.compaction`의 필드 전부, 세션 없는 호출에서는 `null`)<br>`Impact = {sessions: Array<{sessionID, P, triggerTokens, truncates: boolean}>}`<br>순수 함수 `resolve(chain, templateLimit, keep) → {triggerTokens, effectiveInput, source, floorTokens}`(4.7.3·4.7.4), `cycleCost(...)`(6.3 ⑫), 상수 `defaults: Record<Kind.Own \| "claude-sub", Setting>`(4.7.3 표) |
| `rpc.ts` Definition | 새 메서드 `"compaction.setSession"`: 입력 `{sessionID, triggerTokens: PositiveInt\|null}`, 출력 `{compaction: Compaction.View}`, 오류 `pick("setting_out_of_range")` |
| `rpc.ts` Events | 새 이벤트 `"compaction.due"`: `{...envelope, sessionID, inputID: SessionMessage.ID, P: NonNegative, triggerTokens: PositiveInt, epoch: NonNegativeInt}` |
| `rpc.ts` `accounts.update` | 입력에 `compaction?: Compaction.Setting\|null`, `dryRun?: boolean`. 출력에 `compactionImpact?: Compaction.Impact`. 오류에 `setting_out_of_range` |
| `rpc.ts` `policy.get` / `policy.set` | get 출력에 `compactionDefaults`. set 입력에 `dryRun?`, 출력에 `compactionImpact?`, 오류에 `setting_out_of_range` |
| 새 `scope.ts` 또는 `rpc.ts` | `MethodScope: { readonly [M in keyof Definition.methods]: "read"\|"prompt"\|"switch"\|"admin"\|"local" }`(9.1 표, v0.4에서 05 §13.5의 이름으로 바꿈). 모든 메서드에 값이 있어야 타입 검사를 통과한다 |
| `policy.ts` | `File.compaction?: {byKind: Partial<Record<Kind.Own, Compaction.Setting>>}`(`claude-sub`는 넣을 수 없음). `Patch.compaction` 같은 형태. `defaults`에는 넣지 않는다(코드 상수는 `Compaction.defaults`) |
| `account.ts` | `Info.compaction?: Compaction.Setting\|null`, `Info.remote?`(04). `View.compaction?: {setting: Compaction.Setting\|null, effective: Array<Compaction.Effective>}` |
| `cache.ts` | `Snapshot.compaction?: Compaction.View\|null`(메서드와 이벤트 공용) |
| `estimate.ts` | `Warning`에 `target_compacts_soon`, `compaction_may_truncate`. `Result.target`에 `compactAt?: {windowTokens, triggerTokens, source}` |
| `ledger.ts` | `Line.usageSource?: "event"\|"stream"\|"estimate"`, `Line.purpose?: "warming"\|null`, `Line.server?`(04 §10.4) |
| `alert.ts` | `Code`에 `compaction_threshold_mismatch`, `toolset_changed`, `generate_usage_missing`(`codex_source_stale`은 이미 있음). 원격 6개는 04 |
| `error.ts` | `setting_out_of_range: {field: String, min: NullOr(Finite), max: NullOr(Finite)}` |
| `kv.ts` | 키 `sess:<sid>:compaction`, `sess:<sid>:compactionDue`(2.4.6) |

**v0.4 추가 변경**

| 파일 | 변경 |
|---|---|
| `rpc.ts` Definition | 새 메서드 `"session.approval.get"`: 입력 `{sessionID}`, 출력 `{mode: "read-only"\|"ask"\|"full"\|"custom", rules: Array<PermissionRule>, children: {open: NonNegativeInt}}`. 새 메서드 `"session.approval.set"`: 입력 `{sessionID, mode: "read-only"\|"ask"\|"full"}`, 출력 `{mode, patched: Array<Session.ID>}`. 오류는 `pick()`(9.2) |
| `rpc.ts` Events | 새 이벤트 `"approval.changed"`: `{...envelope, sessionID, mode, patched: Array<Session.ID>}` |
| `rpc.ts` `switch.apply` | 오류에 `revert_staged` |
| `rpc.ts` `plugin.claudeAuth.changeSource.plan` | 입력 `configDir`을 `String(minLength 1) \| null`로(`rpc.ts:616`). 오류에 `setting_out_of_range` |
| `rpc.ts` `policy.get` / `policy.set` | `policy.compaction.keepTokens?: PositiveInt`(get은 설정 파일 값, set은 설정 파일에 씀. 4.7.6 (가)) |
| `switch.ts` | `RestartService`에서 `configDir` 제거(`switch.ts:58-62`, 8.7). `ChildPolicy = {policy: "follow"\|"keep", providerID, since}`(5.11) |
| `estimate.ts` | `UnavailableReason`에 `revert_staged`(`estimate.ts:45-54`) |
| `compaction.ts` | `Impact.sessions[].revertStaged?: boolean`(4.7.4). `resolve`의 `keep` 인자는 설정 파일의 값(기본 15,000) |
| `alert.ts` | `Code`에 `subagent_model_overridden`(5.11) |
| `error.ts` | `revert_staged: {sessionID}` |
| `kv.ts` | 키 `sess:<sid>:children`, `sess:<sid>:childPolicy`(2.4.6). `sess:<sid>:epoch`의 뜻이 "cold point 계수"(압축 + revert commit)로 넓어진다(형식은 같음) |
| `ledger.ts` | 형식 변경 없음. `kind:"title"` 줄은 이미 있는 `RequestKind`(`ledger.ts:13`)로 쓰고, `usageSource:"stream"`을 title에도 쓴다(7.5) |

- (2026-09-28, 추가만) 이전 앱 API 키 연결(3.2b): `Credential.LinkedLegacyKey`(`Ref`에 `linked-legacy-key`), `Credential.LegacyKeySource`·`LegacyProviderRef`·`LegacyProvidersFile`·`LegacyProviderFile`, `Account.ConnectionMethod` `legacy-key-linked`와 `Connection.legacyKey`, `OwnError.LegacyKeyProblem`, 오류 `legacy_key_not_found`·`legacy_key_invalid`, 메서드 `accounts.import.keys.{list,plan,execute}`(범위 `local`, location `control`), `LegacyKeyCandidate`·`LegacyKeyImportPlan`·`LegacyKeyImportWarning`. own-vault는 0.2.0(`linked.get`, `hello.ops`, 오류 `path_denied`, protocol은 1 그대로).
- 가져오기(`accounts.import.codex.*`, `Credential.*`, `source_not_found`, `source_invalid`, `codex_source_stale`)는 이미 구현되어 있어 변경이 없다. 3.2a의 takeover 직후 강제 refresh, takeover → linked의 vault shred, client 불일치 때의 되돌리기는 own-accounts 핸들러의 일이다(프로토콜 변경 없음).
- 구현 주의: `packages/own-accounts/src/telemetry/telemetry.ts`는 이미 압축을 공개 이벤트로, title·generate를 SSE 사본으로 적는다(7.5). 이 판에서 그 동작이 스펙이 되었다. 단, title 줄 뒤에 캐시 상태(`L`, `lastReqAt`)를 갱신하는지는 7.5 3번("title은 캐시 상태를 바꾸지 않는다")과 맞춘다.

**T0 변경(06 §10.4, 07 §8.3 T0, 2026-10-01)**. 릴리스 ①(`f8284fe1cd`)과 T0 wave 1·2(`6df0e0bc0e`, `f3a12f9f2a`)에 들어갔다.

| 파일 | 변경 |
|---|---|
| 새 `preset.ts`(`export * as Preset`, `index.ts`에서 내보냄) | 묶음 `Group`(`Kind.Any` \| `local:<providerID>`), `LOCAL_PROVIDERS`(`ollama`, `lmstudio`), `groupOf`, `isLocal`. 프리셋 `ID`(`pr_<ulid>` \| `builtin:<group>`), `builtinID`, `isBuiltin`, `Role`·`ROLES`·`roleOf`, `Target`, `Effort`, `RoleEntry`, `Workers`, `Delegation`, `Caps`·`CAPS`, `UltraCaps`, `Info`, `builtin`(`평소대로`), `Team`, `Binding`(KV 값), `effective`. R4: `Member`, `Lookup`, `Verdict`, `company`, `allowed`. 관문 거절: `REJECT_PREFIX = "own-preset:"`, `Rejection`, `rejection`. 새 대화 기본 모델(07 §2.2): `Basis`, `Choice`, `DefaultModel`, `GroupState`, `File`(`presets.json`), `empty`, `GroupView`, `Candidate`, `Entry`, `CodexHints`, `candidates`, `basePrice`, `defaultModel` |
| `rpc.ts` Definition | 새 메서드 `presets.list`, `presets.defaults.set`(9.2 "프리셋"), `worktree.inspect`(9.2 "작업 폴더 지우기 막이", 새 스키마 `WorktreeNested`·`WorktreeInspection`, 메서드 전용 오류 `not_found`·`not_git`, 9.4). `SelfTest.agentModels?: {ok, removed: Array<{agent: String, model: Model.Ref}>}` |
| `rpc.ts` Events | 새 이벤트 `presets.changed`: `{...envelope}`(전역) |
| `rpc-routing.ts` | `MethodScope`: `presets.list`·`worktree.inspect` = `read`, `presets.defaults.set` = `admin`(9.1 표). `MethodLocation`: 셋 다 `control`. `EventOrigin`: `presets.changed` = `global` |
| `alert.ts` | `Code`에 `codex_window_unverified`(info, 07 §6.2 #4), `subagent_rejected`(info, 세션, 5.11 규칙 2), `internal_agent_model_removed`(warning, 전역, 5.11 규칙 2). `compact_advice` 삭제(07 §6.2 #11). `subagent_model_overridden`의 뜻은 설정 `agent.model`이 own 구독 slot이라 부모 Ref로 돌린 경우로 바뀜(5.11 규칙 2) |
| `kv.ts` | 키 `sess:<root>:preset`(`Kv.preset`, 값 `Preset.Binding`, 2.4.6) |
| `policy.ts` | 조언 문턱 `newSessionAdviceTokens`·`compactAfterSwitchMinTokens`·`compactMinTokens`와 `compactAdviceUsedPercent` 삭제(07 §6.2 #9–#11), `defaults.global` 삭제(새 대화 기본 모델은 `presets.json`, 07 §2.2). 남는 것은 `defaults.byKind` |
| `registry.ts` | `slots[].defaultModel`은 더 쓰지도 읽지도 않는다. 옛 파일이 읽히도록 스키마에만 남긴다(3.4에서 지울 일은 07 §6.4) |
| `compaction.ts` | `defaults.compat`이 `V2`(보수적 kind 없음, 07 §6.2 #2). `resolve`의 바탕 `source`는 언제나 `"v2"` |
| `plugin.ts` | `ClaudeAuthOrder`에 `before_own_team`(06 §2.6의 설정 순서) |

**T1 변경(07 §8.1–§8.3 T1, 06 §2.7, 2026-10-02)**. T1 wave 1–5(`208176a8ec`, `df7f687fe1`, `63f81c8567`, `19725cecd4`, `ead2e74507`)에 들어갔다. 원칙은 추가만이다(T0과 통합 브랜치의 모양을 바꾸지 않음).

| 파일 | 변경 |
|---|---|
| `preset.ts` | 해석 `resolve`·`lighterPick`·상한 `caps`(울트라·`적극적으로` 메시지당 12)·`effortToVariant`·`ultraEffort`·`renderGuidance`·거절 문구 `rejection`/`parse`(`caps`·`consent` 사유 포함)·시작 틀 `STARTERS`·제안 `suggest`. R4: `loginOf`(같은 ChatGPT 로그인의 `codex`·`siwc`는 구독 하나), 메인 회사의 고정 대상은 메인 계정만. `siwc`의 새 대화 기본 모델은 Codex CLI 힌트 없는 codex 규칙, 가격은 `openai` 카탈로그. 새 스키마 `Save`, `Draft`, `Suggestion`, `StarterView`, `Resolution`, `SessionView`, `Usage`, `Consent`, `Warning`, `Place`, `NewSession`, `Listed`, `Status`, `DefaultLabel`, `GroupView` 확장(`presets`, `star`, `lighter`, `status`, `label`) |
| `rpc.ts` Definition | 새 메서드 8개(9.2 "프리셋 T1"). `switch.estimate`·`apply`에 `teamOp?: Switch.TeamOp`, `children?: Switch.Children`, 오류 `team_switch_required`. `switch.schedule`에 오류 `team_switch_required` |
| `rpc.ts` Events | 새 이벤트 `session.preset.changed{sessionID, binding}`(세션). `presets.changed`에 `removed?` |
| `rpc-routing.ts` | `MethodScope`: `presets.suggest`·`session.preset.get` = `read`, `session.preset.apply`·`session.ultra.set`·`session.preset.consent` = `switch`, `session.preset.raiseOnce` = `prompt`, `presets.set`·`presets.remove` = `admin`. `MethodLocation`: `presets.*` = `control`, `session.preset.*`·`session.ultra.set` = `session`. `EventOrigin`: `session.preset.changed` = `session` |
| `switch.ts` | `TeamOp`(`op_` 접두어), `Children`(`after-idle`·`stop`) |
| `estimate.ts` | `Result.busyChildren?: {count, accountID} \| null` |
| `error.ts` | `same_company_subscription`, `preset_not_found`, `preset_wrong_group`, `preset_target_unavailable`, `preset_builtin_locked`, `preset_budget_exhausted`, `team_switch_required` |
| `alert.ts` | `preset_needs_repair`, `preset_entry_dropped`, `group_default_model_missing`, `local_window_unverified`(7.7). `effort_update_drift`는 T2(Codex 메타데이터) |
| `kv.ts` | 키 `sess:<root>:presetUsage`, `sess:<root>:presetConsent`(2.4.6) |
| `account.ts` | `Info.compat`·`View.compat`: compat 계정의 서버 종류(PG9), 모델별 출력 한도와 그 출처(07 §6.2 #7), 로컬 서버의 실행 창(#8). 등록 창 자체는 줄이지 않는다(R8). 2026-10-18: `Info.compat.capabilities`(모델별 `{detected?, image?, tools?}`)와 `View.compat.models[].image`·`tools`(`{on, setting, detected?}`), `CompatSetting`(3.3 "그림 입력과 도구") |
| 새 `rpc-team.ts`, `rpc-team-routing.ts` | RPC id `own.team`(06 §2.7): `OwnTeam` id·스키마, 메서드 33개, 이벤트 8개, 오류 19개, 범위·위치 표, `PROMPT_SOURCE = "own.team"`, `DISPATCH_META`, `UPDATE_META`. 컴퓨터 사용 필드는 없다 |

**T2 변경(07 §8.1·§8.3 T2, 06 §2.7, 2026-10-02)**. T2 wave 1–3(`6cddbe532d`, `ddd6912149`, `4feb12429a`)에 들어갔다. 원칙은 그대로 추가만이고, 새 필드는 모두 선택이라 T1 클라이언트·서비스가 그대로 읽는다. 새 메서드는 없어서 `rpc-routing.ts`는 그대로다.

| 파일 | 변경 |
|---|---|
| 새 `codex-models.ts`(`export * as CodexModels`) | Codex 모델 메타데이터(07 §4.5): 저장 파일 `{version:1, kinds:{codex?: Snapshot}}`, `Snapshot{source:"backend"\|"pc-cache", fetchedAt, etag?, clientVersion?, models}`, 모델 행(`context_window`, `max_context_window`, `default_reasoning_level`, `supported_reasoning_levels`, `multi_agent_reasoning_effort`, `supports_reasoning_effort_updates`, `priority`, `upgrade{model, retirement_at}`), 행마다 따로 거르는 `decode`, `models_cache.json` 글을 스냅샷으로 바꾸는 `fromCache`, `find`·`maxInput`·`levels`·`ultraLevel`·`priority`·`upgrade`·`hints`. 모델 ID·창·가격을 적지 않는다. own-accounts에 이미 `CodexMeta` 모듈이 있어 이름을 나눴다 |
| `preset.ts` | `effortToVariant`·`ultraEffort`가 codex 계정의 메타데이터 단계 순서를 받음. 새 함수 `groupDefault`(저장된 `auto`는 다시 정하지 않음, 사라지면 `missing`), `callable`, `successor`, `presence`, `repairs`. 새 스키마 `RepairOf`, `RepairRecord`, `Use`, `Repair`. `Group.history?`, `GroupView.history?`·`retirements?`, `SessionView.main?` |
| `registry.ts` | `TemplateModel`에 own 표시 `addedAt?`·`upstream?:"missing"`, `ModelTemplate.update?`(`Account.TemplateUpdate`) |
| `account.ts` | `TemplateUpdate{detectedAt, fields}`, `ModelMark{id, addedAt?, upstream?}`, 계정 보기의 `templateUpdate?`·`models?`. T1 리뷰의 codex `identity.login`(지문)은 그대로 |
| `rpc.ts` | `presets.list`의 `repairs?`, `presets.set`의 `repairOf?`, `session.preset.get`의 `main?`(9.2 "프리셋 T2") |
| `alert.ts` | `effort_update_drift`, `template_update_available`, `session_model_unavailable`, `session_variant_unavailable`, `codex_meta_unavailable`(7.7) |
| `rpc-team.ts` | 06 T2: `SummaryLine`의 `heavy`·`pushed`, `Integration.checks`·`failure`(`IntegrationFailure`), `NoticeKind`의 `folder.followed`·`integration.waiting`·`undo.kept`, 폴더를 따라 옮긴 담당 대화의 세션 metadata `MOVED_META = "own.team.moved"`(`{at, from, to}`, 06 §8.8). T1의 항목은 바이트 그대로 |
| `rpc-team-text.ts`(`OwnTeamText`) | 팀 소식의 반영 줄(`INTEGRATION`, `integrationLine`)과 결정 기록 줄(`DECISION`, `DECIDED_BY`, `decisionLine`), 한 줄 요약이 세는 `integrated`·`undone`·`decided`. `@own/protocol/rpc-team-text` export는 T1 리뷰의 스펙 추가이고 T2 전에 사용자가 승인했다 |
| `index.ts` | `CodexModels` 내보내기 |

**EXT 변경(외부 저장소 조사 반영, 2026-10-05–06)**. EXT wave 1–5(`1499ff53c0`, `248336576a`, `d337df7c45`, `7938e6332c`, `441034c47a`)에 들어갔다. 원칙은 그대로 추가만이다. 새 필드는 모두 선택이고 새 enum 값은 이전 빌드가 모르는 값으로 건너뛰므로, 이전 클라이언트·서비스가 그대로 읽는다.

| 파일 | 변경 |
|---|---|
| `ratecard.ts` | 결정 D3: `PeakWindow{days: Array<0–6>, from: "HH:MM", to: "HH:MM"}`(`from < to`, `to`는 `24:00`까지)와 `Card.peak?: Array<PeakWindow>`, 순수 함수 `multiplier(card, at)`(2.4.4). 이전 `ratecards.json`도 그대로 읽히고, 이전 빌드는 `peak`를 무시한다(아는 필드만 읽음) |
| `rpc.ts` | 증거 수집 창(P0-3a, 7.8): 메서드 `diagnostics.capture.start{mode, minutes?, sessionID?, providerIDs?}`·`stop`·`status`(답은 모두 `CaptureStatus`), 스키마 `CaptureMode`(`hash`·`shape`), `CaptureEnd`(`stopped`·`expired`·`replaced`·`shutdown`), `CaptureWindow`, `CaptureStatus`, 상수 `CAPTURE_MAX_MINUTES`(1,440)·`CAPTURE_DEFAULT_MINUTES`(30) |
| `rpc-routing.ts` | `MethodScope`: `diagnostics.capture.*` 셋 = `local`(이 PC 창만. 수집 파일에 로컬 경로와 헤더 이름 목록이 있음). `MethodLocation`: 셋 = `control` |
| `alert.ts` | `output_truncated`·`empty_completion`(P2-16, 세션, info), `capture_empty`(P0-3a, 전역), `prefix_diverged`(P0-2b, 세션, info)(7.7) |
| `ledger.ts` | prefix 지문(P0-2b, 7.8.1): `PrefixBlock`(`tools`·`system`·`message`), `PrefixCause`, `events` 줄 `prefix`의 `data` 스키마 `Prefix{cause, lcp, previous, blocks, at, modelID, variant, agent, ms}` |
| `limit.ts` | 창 id `ds.balance.granted`(DeepSeek 잔액의 보너스 부분, P1-11). 다 쓰거나 만료되면 한 번 0으로 와서 이전 값을 덮고, own-web은 0인 보너스 창을 보이지 않는다 |
| `policy.ts` | `repeatReminderExclude?: Array<string>`(반복 호출 안내에서 뺄 도구 이름 패턴, 결정 D4. 없으면 `computer_*`) |

**속도 변경(4.8, 2026-10-06)**. 원칙은 그대로 추가만이다.

| 파일 | 변경 |
|---|---|
| 새 `speed.ts`(`export * as Speed`, `@own/protocol/speed`) | `Choice`, `Faster`, `ORDER`, `ANTHROPIC_BETA`, `PRIORITY`, `Wire`, `Basis`, `Status`, `Billing`, `Offer`, `State`(KV), `Consent`, `Served`, `View`, `Reason`, `ChangeWarning`, `Change`. 순수 함수 `choiceOf`, `requestTier`, `modeOf`, `listed`, `modes`, `offers`, `usable`, `resolve`(Ultrafast → Fast → 표준), `inherit`(하위 에이전트), `downgraded` |
| `codex-models.ts` | `Tier{id, name?, description?}`, 모델 행의 `service_tiers?`·`default_service_tier?`·`additional_speed_tiers?`(잘못된 tier 항목은 그 항목만 버림, 행은 남김), `tiers(model)`, 파일의 `accounts?: Record<accountID, Snapshot>` |
| `rpc.ts` | 메서드 `session.speed.get`·`session.speed.set`, 이벤트 `session.speed.changed`(9.2, 9.3). 2026-10-10: 메서드 `speed.offers`, `Speed.None`·`Speed.Targeted`, `View.none?` |
| `rpc-routing.ts` | `session.speed.get` = `read`, `session.speed.set` = `switch`, 둘 다 `session`. `session.speed.changed` = `session`. `speed.offers` = `read`, `control` |
| `error.ts` | `speed_unavailable{speed, reason}`, `speed_consent_required{}` |
| `alert.ts` | `speed_fallback`, `speed_downgraded`(7.7) |
| `ledger.ts` | `Line.speed?: {requested, served|null}`(7.5) |
| `ratecard.ts` | `SpeedCard`와 `File.speed?`(2.4.4) |
| `kv.ts` | `Kv.speed(sid)`, `Kv.ackClaudeFast`(2.4.6) |

**IMPORT 변경(09, 2026-10-08)**. IMPORT wave 1–3(`ca3cf4ac1d`, `c71ef74dc8`, `ca160fa424`)에 들어갔다. 원칙은 그대로 추가만이다. `own.import`의 정의는 이 문서가 아니라 09 §5가 정한다.

| 파일 | 변경 |
|---|---|
| `rpc.ts` | 메서드 `estimate.request`(9.2), 스키마 `EstimateRequestItem`, `EstimateRequestResult`. 메서드 69개 |
| `rpc-routing.ts` | `estimate.request` = `read`, `control` |
| 새 `rpc-import.ts`, `rpc-import-routing.ts`(`OwnImport`, `OwnImportRouting`) | RPC id `own.import`(09 §5.1–§5.5). `rpc-import-routing.ts`의 `META_KEY`(`"own.import"`)와 `marked(metadata)`를 own-accounts의 측정 제외(9.2)가 쓴다 |
| 새 `token.ts`(`Token`) | P-016과 같은 토큰 추정(09 §4.3, IG6). core를 런타임 의존으로 가져오지 않는다 |

**NOTES 변경(05 §8.8, 2026-10-09)**. 원칙은 그대로 추가만이다. RPC id는 늘지 않는다(`own.accounts`에 더함).

| 파일 | 변경 |
|---|---|
| 새 `notes.ts`(`Notes`, `@own/protocol/notes`) | 스키마 없는 순수 모듈(own-web 노트 chunk가 Effect 없이 import): 한도 `TITLE_MAX` 200, `TEXT_MAX` 200,000, `PER_WORKSPACE_MAX` 200, `WORKSPACE_MAX` 4,096, `ID_PATTERN`, `workspaceKey({host?, directory})`, `isWorkspaceKey(key)`, `normalizeDirectory(directory)`(9.2 "입력 검사") |
| `rpc.ts` | 스키마 `NotesWorkspace`, `NoteID`, `NoteMeta`, `Note`. 메서드 `notes.list`·`notes.get`·`notes.put`·`notes.remove`(9.2), 이벤트 `notes.changed`(9.3). 메서드 73개, 이벤트 19개 |
| `rpc-routing.ts` | `notes.list`·`notes.get` = `read`, `notes.put`·`notes.remove` = `prompt`, 넷 다 `control`. `notes.changed` = `global` |
| `error.ts` | `note_not_found{id}`, `note_conflict{current}`, `notes_limit{max}`(9.4) |
| `kv.ts` | `Kv.notesIndex(hash)`, `Kv.noteText(hash, id)`(2.4.6) |
| `@own/runtime` `runtime.ts` | 프로세스 싱글턴에 `notes: Lock.Mutex`(노트 쓰기를 하나씩) |

**IDEAS 변경(03 §4.4.1, 2026-10-11)**. 원칙은 그대로 추가만이다. RPC id는 늘지 않는다(`own.accounts`에 더함).

| 파일 | 변경 |
|---|---|
| 새 `ideas.ts`(`Ideas`, `@own/protocol/ideas`) | 스키마 없는 순수 모듈(own-web 첫 chunk가 Effect 없이 import): `TEXT_MAX` 2,000, `MAX` 1,000, `ID_PATTERN`, `COLORS`(`yellow`·`pink`·`green`·`blue`·`purple`) |
| `rpc.ts` | 스키마 `IdeaID`, `IdeaColor`, `Idea`, `IdeaPut`. 메서드 `ideas.list`·`ideas.put`·`ideas.remove`(9.2), 이벤트 `ideas.changed`(9.3) |
| `rpc-routing.ts` | `ideas.list` = `read`, `ideas.put`·`ideas.remove` = `prompt`, 셋 다 `control`. `ideas.changed` = `global` |
| `error.ts` | `idea_conflict{current}`, `ideas_limit{max}`(9.4) |
| `kv.ts` | `Kv.ideasPrefix`, `Kv.idea(id)`(2.4.6) |
| `@own/runtime` `runtime.ts` | 새 뮤텍스 없음: 아이디어 쓰기도 `notes` 뮤텍스 아래에서 하나씩 돈다 |

**DF 변경(03 §5.1, §18.3, 2026-10-18)**. 원칙은 그대로 추가만이다. RPC id는 늘지 않는다(`own.accounts`에 더함). 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다.

| 파일 | 변경 |
|---|---|
| 새 `conversation-folder.ts`(`ConversationFolder`) | `MAX_PATH` 1,024, `FOLDER_NAME` `Own OpenCode`, `View`, `SetInput`, `Problem`, `PickerView`, `PickerSetInput`, `PickerProblem` |
| `rpc.ts` | 메서드 `conversationFolder.get`·`set`·`ensure`, `folderPicker.get`·`set`(9.2), 이벤트 `conversationFolder.changed`·`folderPicker.changed`(9.3) |
| `rpc-routing.ts` | `get` 둘 = `read`, `set` 둘 = `admin`, `ensure` = `prompt`, 모두 `control`. 이벤트 둘 = `global` |
| `error.ts` | `conversation_folder_unavailable{reason, path}`, `folder_picker_unavailable{reason, path}`(9.4) |
| `kv.ts` | `Kv.conversationFolder`, `Kv.folderPicker`(2.4.6) |
| own-accounts `options.ts` | 플러그인 옵션 `conversationFolder`(기본값 바꾸기, 시험용) |

**SBL 변경(03 §4.3, 2026-11-26)**. 추가만이다: `project-list.ts`(`ProjectList.View`·`SetInput`), `rpc.ts`의 `projectList.get`·`set`과 이벤트 `projectList.changed`, `kv.ts`의 `Kv.projectList`(메서드 167개). RPC id와 오류는 늘지 않는다. 공개 HttpApi는 바뀌지 않고, 셸과 화면 사이의 rpcHash도 그대로다. 원격 서비스는 새 메서드 때문에 바뀐다(호스트는 평소의 업데이트, `proto` 1 그대로). 이전 서비스는 `rpc.method_not_found`로 답하고 own-web은 순서를 브라우저에 둔다.

**MH 변경(04 §13.1, 2026-11-26)**. 추가만이다: `mcp-host.ts`(`McpHost`: 호스트 목록·probe·보내기 기록·설치 일의 스키마)와 `mcp-host-rules.ts`(`McpHostRules`: 분석·번역·해시·설명, own-web도 씀), `rpc.ts`의 `mcp.host.view`·`mcp.host.probe`·`mcp.host.save`·`mcp.host.remove`·`mcp.host.test`·`mcp.host.prefetch`(SSH 호스트의 서비스가 답함, 이 PC는 `mcp_host_only`)와 `mcp.hosts.send`·`mcp.hosts.unsend`·`mcp.hosts.view`(이 PC가 답함, 호스트는 `remote_managed`), 오류 `mcp_host_only`, 브로커 메서드 `mcp.values`와 push `mcp.changed`(정상 모드만). 메서드 167 → 176개, 범위 `read` 45 → 47(`mcp.host.view`, `mcp.hosts.view`), `local` 73 → 80. RPC id는 늘지 않고, 공개 HttpApi와 rpcHash, `PROTO`와 `MIRROR_SCHEMA_VERSION`은 그대로다. 원격 서비스가 바뀌므로 호스트는 평소의 업데이트가 필요하다(업데이트 전에는 `호스트 최신 아님`).

**SN 변경(03 §5.1, §18.3, 04 §17.4, 2026-11-22, 2.2.6-own.16)**. 추가만이다. RPC id는 늘지 않는다(`own.accounts`에 더함). 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다. 셸과 화면 사이의 rpcHash도 그대로다(`ce794c06d73401d9`). 원격 서비스는 새 메서드와 새 기본값 때문에 바뀐다(호스트는 평소의 업데이트, `proto` 1 그대로). 이전 원격 서비스는 `folderPicker.list`·`create`에 `rpc.method_not_found`로 답하고, own-web은 core `fs.list`로 돌아가며 `새 폴더`를 숨긴다. 이전 서비스는 `conversationFolder.set`의 `~/…`를 `relative`로 거절한다.

| 파일 | 변경 |
|---|---|
| `conversation-folder.ts`(`ConversationFolder`) | `LINUX_FOLDER_NAME` `own-chats`, `MAX_NAME` 255, `ListInput`, `ListEntry`, `ListView`, `ListProblem`, `CreateInput`, `CreateView`, `CreateProblem` |
| `rpc.ts` | 메서드 `folderPicker.list`·`folderPicker.create`(9.2) |
| `rpc-routing.ts` | 둘 다 `prompt`, `control` |
| `error.ts` | `folder_list_unavailable{reason, path, owner?}`, `folder_create_unavailable{reason, path}`(9.4) |
| own-accounts `conversation-folder/folder.ts` | Linux 기본값 `~/own-chats`(이전 기본값이 있으면 그것), `set`의 `~/…`, `list`, `create` |

**CA 변경(07 §4.5, 2026-10-19)**. 원칙은 그대로 추가만이다. RPC id는 늘지 않는다(`own.accounts`에 더함). 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다.

| 파일 | 변경 |
|---|---|
| `codex-models.ts`(`CodexModels`) | `Version`(`major.minor.patch`), `Latest{version, fetchedAt}`, `View`, `SetInput`. `Snapshot.rejected?`, `File.latest?`·`File.autoVersion?`. `decode`가 own의 codex 하네스가 다루지 못하는 값이 있는 행을 빼고 세며 숨김 행은 세지 않는다. `ROWS` 2 → 3 |
| `rpc.ts` | 메서드 `codexModels.get`·`codexModels.set`(9.2, 오류 `remote_managed`), 이벤트 `codexModels.changed`(9.3) |
| `rpc-routing.ts` | `codexModels.get` = `read`, `codexModels.set` = `admin`, 둘 다 `control`. `codexModels.changed` = `global` |
| own-accounts `options.ts`·`endpoints.ts` | 끝점 `npmRegistry`(기본 `https://registry.npmjs.org`). 다른 끝점을 덮어쓴 서비스(시험)는 이것을 따로 주지 않으면 레지스트리를 읽지 않는다 |

**OL 변경(4.9, 2026-10-19)**. 원칙은 그대로 추가만이다. RPC 메서드는 늘지 않는다. 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다(코어 쪽은 플러그인 hook 타입만, P-032).

| 파일 | 변경 |
|---|---|
| 새 `output-limit.ts`(`OutputLimit`, `@own/protocol/output-limit`) | `Mode`(`cap`·`omit`), `Setting`, `SettingInput`, `CORE_CAP` 256,000, `DEFAULT`, `MIN_TOKENS` 4,096, `MAX_TOKENS` 1,000,000, `CLAUDE_DEFAULT` 32,000, `DS_THINKING_OFF` 65,536. 순수 함수 `resolve`, `check` |
| `policy.ts` | `File.outputLimit?: Setting`, `Patch.outputLimit?: SettingInput \| null` |

**siwc 입력 항목(3.2c, 2026-10-10)**. 원칙은 그대로 추가만이다.

| 파일 | 변경 |
|---|---|
| `alert.ts` | `sharing_unsupported_input`(오류, 세션, 7.7) |

**CW 변경(8.9, 2026-10-19)**. 원칙은 그대로 추가만이다. 새 필드는 선택이고 새 경보 코드는 이전 클라이언트가 모르는 값이다. RPC 메서드와 이벤트는 늘지 않는다.

| 파일 | 변경 |
|---|---|
| `alert.ts` | `claude_first_request`(warning, 세션 = 트리의 루트, 7.7) |
| `kv.ts` | `Kv.claudeFirstRequest(accountID)`(2.4.6) |
| `limit.ts` | `Window.meta`에 `billing?: "extra_usage" \| "rejected"`, `disabledReason?: string`(`claude.overage`만, 7.3) |
| `unified.ts` | `parse`가 `overage-in-use`·`overage-disabled-reason`을 읽고 `meta.billing`을 둔다. `billing(status, overage, inUse)`, `refused(windows, observedAt, accountID)` |
| `extra-usage.ts` | 문구 넷(7.7). 둥근 따옴표(’)도 맞춘다. 뜻을 "청구됨"에서 "거절됨"으로 바로잡음 |
| `@own/runtime` `limits.ts` | `significant`가 `meta.billing`의 변화를 센다 |

**SP 변경(9.2, 2026-10-19, 병합 때 적음)**. 원칙은 그대로 추가만이다. RPC id는 늘지 않는다(`own.accounts`에 더함). 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다.

| 파일 | 변경 |
|---|---|
| 새 `search-key.ts`(`SearchKey`) | `Service`(`brave`), `keyID(service)`(`websearch-<service>`), `MAX_KEY_CHARS` 512, `KeyState`, `View`, `SetInput` |
| `rpc.ts` | 메서드 `websearch.key.get`·`websearch.key.set`(9.2, 오류 `websearch_key_invalid`·`vault_unavailable`·`remote_managed`) |
| `rpc-routing.ts` | `websearch.key.get` = `read`, `websearch.key.set` = `local`, 둘 다 `control` |
| `error.ts` | `websearch_key_invalid`(9.4) |
| own-accounts `options.ts`·`endpoints.ts` | 끝점 `brave`(기본 `https://api.search.brave.com/res/v1`) |

**MS 변경(9.2, 03 §18.2, 2026-10-19)**. 원칙은 그대로 추가만이다. 메서드·이벤트는 늘지 않는다. 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다. 이전 클라이언트는 `websearch.get`의 새 값 `{type:"multi"}`과 `multi`를 모르므로 own-web은 서비스와 같은 판이어야 한다(같은 빌드에 들어 있다).

| 파일 | 변경 |
|---|---|
| `approval.ts` | `WEB_SEARCH_MULTI` = `"own-multi"`. `WebSearchChoice`에 `{type:"multi", services?: string[]}`(1–32개, `get`은 `services`를 주지 않는다). 새 `WebSearchMulti{services, custom}`, `WebSearchState.multi?` |
| `kv.ts` | `Kv.websearchMulti` = `websearch:multi`(2.4.6) |

**SK 변경(9.2, 03 §18.2, 2026-10-23)**. 원칙은 그대로 추가만이다. 메서드·이벤트는 늘지 않는다(106개). 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다. 이전 서비스는 `brave` 줄만 주고 다른 서비스의 `websearch.key.set`을 스키마에서 거절하므로 own-web은 키 줄을 그 서비스에만 보인다.

| 파일 | 변경 |
|---|---|
| `search-key.ts` | `Service`에 `exa`, `firecrawl`, `parallel`, `tavily`, `tinyfish`. 새 `KEYED`(키 없는 다섯), `isKeyed`, `providerID(service)`(`brave`, 아니면 `own-<service>`) |
| own-runtime `credentials.ts` | `featureURL(id, url, param)`: 기능 키를 질의 매개변수로 넣은 주소(Exa) |
| own-accounts `options.ts`·`endpoints.ts` | 끝점 `exa`, `firecrawl`, `parallel`, `tavily`, `tinyfish`(기본은 core의 주소 그대로, 아무것도 덧붙이지 않음) |

**SM 변경(9.2, 03 §18.14, 2026-10-24)**. 원칙은 그대로 추가만이다. 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다. 메서드 9개와 이벤트 1개를 더해 116개다. 이전 서비스는 `mcp.*`를 모르므로(`rpc.method_not_found`) own-web의 더하기·가져오기는 실패를 알린다. 목록 스위치는 그 서버에서 `mcp.enable`이 실패하면 오류로 보인다.

| 파일 | 변경 |
|---|---|
| 새 `mcp-rules.ts`(`export * as McpRules`, 하위 경로 `@own/protocol/mcp-rules`, 스키마 없음) | `NAME_PATTERN`, `ENV_NAME`, `HEADER_NAME`, `MAX_VALUE`(8192), `HINT_MIN`(12), `hint(value)`, `suggestName(name, taken)`, `REFERENCE`(`${이름}`), `references(text)`, `expand(text, values)`. own-accounts와 own-web이 같이 쓴다 |
| 새 `mcp.ts`(`export * as OwnMcp`) | `McpRules`의 규칙을 다시 내보낸다. `ID`(`mcp_<ulid>`), `Scope`, `Secret`, `Local`(`codemode?`), `Remote`(`hidden?`, `codemode?`), `Transport`, `Tool`, `MAX_TOOLS`(200), `Failure`, `Check`, `From`(`registry` 포함), `RegistryRef`, `Server`(`registry?`, `missing?`), `Override`, `View`, `SummaryServer`, `Summary`, `LocalInput`, `RemoteInput`, `TransportInput`, `SaveInput`(`registry?`), `TestInput`, `Source`, `Note`(`values_moved` 포함), `Problem`, `CandidateKey`, `Place`, `Candidate`(`also`), `SourceFile`, `SCAN_TTL_MS`, `Scan`, `Pick`, `Applied`, `RegistryValue`, `RegistryProblem`, `RegistryPackage`, `RegistryRemote`, `RegistryOption`, `RegistryEntry`, `REGISTRY_PAGE`(20), `RegistrySearch`, `RegistryPage` |
| `rpc.ts` Definition | `mcp.list`, `mcp.summary`, `mcp.save`, `mcp.remove`, `mcp.enable`, `mcp.test`, `mcp.import.scan`, `mcp.import.apply`, `mcp.registry.search`(9.2) |
| `rpc.ts` Events | `mcp.changed{...envelope}` |
| `rpc-routing.ts` | 범위 `mcp.summary` `read`, `mcp.enable` `admin`, 나머지 일곱 `local`. 위치 모두 `control`. `EventOrigin["mcp.changed"] = "global"` |
| `error.ts` | `mcp_name_taken{name}`, `mcp_not_found{id}`, `mcp_secret_missing{name}`, `mcp_invalid{field}`(`args` 포함), `mcp_registry_unavailable{reason, status?}` |
| own-runtime `credentials.ts` | `FeatureKeyID`에 `mcp-${string}`, 새 `mcpSecrets(id)`(그 서버의 값 글, `mcp.transform`과 연결 시험만) |
| own-runtime `broadcast.ts`, `home.ts` | topic `mcp.changed{}`, `Layout.mcp`(`OWN_HOME\mcp.json`) |

**SG 변경(9.2, 03 §19.6.1, §18.14, 2026-10-26)**. 메서드 2개와 이벤트 1개를 더해 118개다. 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다. MCP의 변경은 넓히기다: `Override.directory`가 선택이 되고 `mcp.enable`이 `directory` 없음과 `enabled:null`을 받는다. 이전 서비스는 그 입력을 스키마에서 거절하고, own-web은 그때 실패를 알린다. `mcp.summary`의 `overrides`는 새 필드라 이전 서비스의 답에는 없다(own-web은 태그를 그리지 않는다). rpcHash는 그대로다(`cbc59aad55a8107b`).

| 파일 | 변경 |
|---|---|
| 새 `skillset.ts`(`export * as OwnSkillset`, 하위 경로 `@own/protocol/skillset`) | `Switch {id(1–256자), directory?, enabled}`, `Scope {folder(스킬 폴더나 납작한 스킬 파일, SG-19), directory}`, `Entry {id, name, description?, path, autoinvoke?}`(내용 없음), `OffBy`(`scope`·`global`·`project`), `Off {id, by, name?, description?, path?, autoinvoke?}`, `View {catalog, switches, scopes, off?}`, `ViewInput {directory?}`, `Change {id, directory?, enabled: boolean\|null}`, `ScopeChange {folder, directory: string\|null}`, `SwitchInput {changes(400개까지), scopes?(200개까지)}`, `MAX_SWITCHES`(2,000), `MAX_SCOPES`(500). 글은 1–4,096자 |
| `rpc.ts` Definition | `skillset.view: method(ViewInput, View, pick("remote_managed"))`, `skillset.switch: method(SwitchInput, View, pick("skillset_invalid", "remote_managed"))`. `mcp.enable` 입력 `{directory?: string(1자 이상), name, enabled: boolean\|null}` |
| `rpc.ts` Events | `skillset.changed{...envelope}` |
| `rpc-routing.ts` | 범위 `skillset.view` `read`, `skillset.switch` `admin`. 위치 둘 다 `control`. `EventOrigin["skillset.changed"] = "global"` |
| `error.ts` | `skillset_invalid{field: "directory"\|"folder"\|"changes"\|"scopes"}` |
| `mcp.ts` | `Override.directory` 선택(없으면 모든 프로젝트), `Summary.overrides: Override[]` |
| own-runtime `broadcast.ts`, `home.ts` | topic `skillset.changed{settle?}`(각 Location이 다시 읽고 접는 일을 넘김), `skillset.removed.query{directory, reply(removed: Off[])}`, `Layout.skillSwitches`(`OWN_HOME\skill-switches.json`) |

**CC 변경(4.7.5, 4.7.7, 7.5, 2026-10-24)**. 원칙은 그대로 추가만이다. 메서드·이벤트는 늘지 않는다(106개). 공개 HttpApi는 바뀌지 않아 생성 클라이언트를 다시 만들지 않는다. 자리 비움 압축의 설정은 `policy.set{patch.compaction.idle}`(메서드 그대로)이고, 이전 서비스는 그 필드를 스키마에서 거절한다.

| 파일 | 변경 |
|---|---|
| 새 `compaction-cache.ts`(`export * as CompactionCache`, 하위 경로 `@own/protocol/compaction-cache`) | metadata 키 `CACHE_KEY`(`own.compaction.cache`), `TRIGGER_KEY`(`own.compaction.trigger`), `PREFIX_KEY`(core의 `prefix`). `CacheReason`(`warm`·`cold`·`model`·`transport`·`thinking`·`no-ttl`), `CacheVerdict{prefix, reason, ageMs?, ttlMs?}`, `PrefixRecord{request, reason?}`, `Sent{request, reason?, trigger?}`, `verdictOf`, `sentOf`. 자리 비움 압축의 `IDLE`(30초 앞당김, 100k, 20분, 80%), `IdleRecord{epoch, inputID, at}`, `idleSuits(ttl)`. own-web 첫 묶음에 들지 않게 `compaction.ts`와 나눴다 |
| `policy.ts` | `PolicyCompactionIdle{enabled, minTokens?, minIdleMinutes?}`, `PolicyCompaction.idle?`, `Patch.compaction.idle?`(주어진 필드만 바꿈) |
| `ledger.ts` | `Line.compaction?: CompactionCache.Sent`(7.5) |
| `kv.ts` | `Kv.idleCompaction` = `sess:<sid>:idleCompaction`(2.4.6) |

**CC 실측 반영(CC-12–CC-15, 2026-10-24)**. 추가만이다. 메서드 하나(`session.presence`, 107개)가 늘고 이벤트는 그대로다. 공개 HttpApi는 바뀌지 않는다.

| 파일 | 변경 |
|---|---|
| `compaction-cache.ts` | `CacheReason`에 `longest-prefix`·`error`를 더함(`transport`·`thinking`은 이전 체크포인트를 읽으려고 남김). 새 `RecentReason`(`short`·`fresh`·`error`: 두 번째 실행의 거절 이유, core 기록 `prefix.reason`에 남음). `sentOf`는 모델 없이 만든 코드 요약(`fallback`에 `model`이 없음)에 `undefined` |
| `rpc.ts`·`rpc-routing.ts` | 새 메서드 `"session.presence"`: 입력 `{sessionID}`, 출력 `{}`, 오류 `pick()`, 범위 `read`, 위치 `session`(9.2) |

**CC 리뷰 반영(CC-16, 2026-10-24)**. 추가와 그 브랜치 안의 바꿈뿐이다(릴리스 전). 메서드·이벤트는 그대로다(107개). 공개 HttpApi는 바뀌지 않는다.

| 파일 | 변경 |
|---|---|
| `compaction-cache.ts` | `CacheReason`에 `unmeasured`(OpenAI GPT-5.6+). `sentOf`는 core 기록이나 판정이 있는 대체 모델(`fallback.model`)의 요약을 `{request:"older", reason:"stand-in"}`로 읽음. `IdleRecord`에 `deadline`(넣을 때의 캐시 마감) |

**SL 변경(7.5, 9.2, 03 §4.5, 2026-10-26)**. 추가만이다. 메서드·이벤트는 그대로다. 공개 HttpApi는 바뀌지 않는다. 새 필드는 선택이라 이전 클라이언트·서비스가 그대로 읽는다. 이전 서비스와 붙은 새 own-web은 압축 줄을 찾지 못해 대화가 묶인 계정을 보이고, 캐시 배지는 계정을 거르지 않는다(지금과 같음).

| 파일 | 변경 |
|---|---|
| `ledger.ts` | `Line.messageID`의 뜻: `compaction` 줄은 그 압축 메시지 id(이전 줄은 `null`). `accountID` 주석에 Claude 계정의 서명자(G4)를 적음. 스키마는 그대로 |
| `cache.ts` | `Entry.accountID?: AccountID \| null`(2.4.6), `Slot.accountID?: AccountID`(9.2 `cache.state`) |

**SL-8 변경(2.4.6, 4.7.5, 4.7.7, 8.7, 9.2, 2026-10-27)**. 추가만이다. 메서드·이벤트 수는 그대로이고 공개 HttpApi는 바뀌지 않는다. 이전 클라이언트는 `anthropic` slot이 여럿이면 첫(가장 최근) slot을 읽는다. 이전 서비스와 붙은 새 own-web은 slot 하나를 그대로 읽는다(SL과 같음).

| 파일 | 변경 |
|---|---|
| `kv.ts` | `cache(sessionID, providerID, accountID?)`: Claude 계정의 항목 `sess:<sid>:cache:anthropic@<accountID>`. `cacheSlot(rest)`: 키에서 slot(provider, 계정)을 읽음 |
| `cache.ts` | `keyAccount(providerID, accountID)`: 항목을 계정으로 나누는 provider(`anthropic`과 계정이 있을 때)면 그 계정, 아니면 `undefined` |
| `compaction-cache.ts` | `CacheReason`에 `account`(압축이 마지막 요청에 서명한 계정이 아닌 Claude 계정에서 돎, 4.7.5) |
| `rpc.ts` | `switch.estimate`에 `accountID?: Account.ID`(대상이 돌 Claude 계정, 8.7. 다른 provider에는 쓰지 않음) |
| `rpc-team.ts` | `SummaryLine` `account`에 `accountID?: AccountID`(팀 메인이 지금 도는 계정, 06 §10.1) |

**SL-17 변경(5.4, 8.7, 9.2, 2026-10-27)**. 추가만이다. 메서드·이벤트 수는 그대로이고 공개 HttpApi는 바뀌지 않는다. 이전 클라이언트는 새 필드를 무시한다. 이전 서비스와 붙은 새 own-web은 대화의 계정을 보인다(Claude 대화는 맞고, 다른 회사에서 Claude로 가는 대기 전환은 전처럼 첫 Claude 계정).

| 파일 | 변경 |
|---|---|
| `switch.ts` | `State`의 WAIT_SAFE·COMPACTING·SCHEDULED·SWITCHING에 `accountID?: AccountID`(전환이 닿을 Claude 계정, 5.4) |
| `estimate.ts` | `Result.target.accountID?: AccountID`(대상이 돌 Claude 계정, 9.2) |

---

### 9.6 이미지 만들기 도구 (IM, 2026-11-03, GPT Image 2.6은 2026-11-06)

OpenAI의 최신 이미지 모델(`gpt-image-2.6-flare`, `gpt-image-2.6-sunburst`, IM-15)을 사용자의 OpenAI API 키 계정으로 쓰고, 키가 모두 바닥나면 ChatGPT 구독의 Codex 이미지 생성으로 대신 만든다. 결정은 decisions IM(설정 페이지는 IS), 사용 설명은 설명서 10.17 `이미지 만들기`다.

- **도구.** `설정 > 이미지 만들기`의 `모델에 이미지 만들기 도구 주기`(`policy.imageGenerate`, US5. 2026-11-08 IS 전에는 `설정 > 컴퓨터 사용 (실험)`의 한 부분이었다)가 켜져 있을 때만 own-accounts가 도구 `image_generate`를 등록한다(`src/image/tool.ts`). core의 `experimental_image_generate`는 켜든 끄든 늘 뺀다. core의 도구는 core의 이미지 클라이언트로 묻는데, own slot의 자격 증명은 세션 요청의 `model.request` 훅에서만 넣으므로(4.1) 상태 없는 생성에는 키가 실리지 않고, 키 사이의 대체와 구독 대체도 할 수 없기 때문이다. own의 도구는 Code Mode에 넣지 않는다(`codemode:false`, core 도구와 같다). Codex 방식의 Code Mode(`code_mode_only` 모델)에서도 `exec` 안에 넣지 않고 맨 위 도구로 둔다(IM-26). 넣으면 결과의 그림이 JavaScript에 base64 글자로 넘어가 모델이 그림을 보지 못하고 카드도 그려지지 않는다.
- **카탈로그.** 번들 models.dev 스냅숏에는 이미지 모델의 이미지 출력 단가가 없다. own slot은 글을 내지 않는 모델을 등록하지 않으므로(`Templates.supportsText`) 카탈로그나 템플릿을 고치지 않고, own의 목록과 요율을 `@own/protocol` `OwnImage`에 둔다. 요청은 own-accounts가 `<openai>/images/generations`(JSON)와 `/images/edits`(multipart `image[]`)에 직접 보낸다. 키는 `Logins.headers`로 이 프로세스 안에서만 붙이고 로그·셸·도구 결과에 남기지 않는다.
- **모델 계열**(`policy.image.family`, IM-15): `auto`(기본, 권장: 대화의 모델이 그림마다 `model`로 GPT Image 2.6 Flare나 Sunburst를 고른다, 없으면 Flare), `flare`(`gpt-image-2.6-flare`), `sunburst`(`gpt-image-2.6-sunburst`), `gpt-image-2`(Codex CLI의 기본). 고정 계열이면 도구가 `model`을 받지 않고, 계열 밖의 모델은 거절한다. 지난 2.5 id(`gpt-image-2.5-flare` 같은)를 주는 호출도 거절하고 2.6 id를 알려 준다(IM-16).
- **옮기기**(IM-16): 계열 이름 `auto`·`flare`·`sunburst`는 그대로라 2.5를 고른 설정은 그대로 2.6이 된다. 없어진 `gpt-image-1.5`가 저장된 `policy.json`도 읽히고(`OwnImage.StoredFamily`) `gpt-image-2`로 읽는다. 파일은 다음 `policy.json` 변경 때 `gpt-image-2`로 다시 쓰인다.
- **복잡도**(`complexity`, IM-17): 2.6 모델이 그리기 전에 얼마나 계획할지(`low|medium|high`, 생략하면 모델 기본)를 호출마다 고를 수 있다. 계열의 모든 모델이 받을 때(`auto`·`flare`·`sunburst`)만 도구가 이 인자를 보이고, 2.6 모델에만 보낸다(`gpt-image-2`와 Codex 구독 대체에는 보내지 않는다). 저장된 기본값은 없다. `quality`(`auto|low|medium|high`)와 `size`(`auto|1024x1024|1536x1024|1024x1536`)의 기본값도 여기 둔다. 호출이 따로 주면 그 값을 쓴다.
- **형식**(`output_format`, IM-21): `png`(기본), `jpeg`, `webp`, 2.6 모델이면 움직이는 `gif`(생성과 편집, `frame_count` 2~16장, 기본 9, `frame_duration_ms` 장당 20~2000ms, 기본 200)와 `svg`(생성만, 한 장, 입력 그림·`markup` 없이)도 있다. `complexity`처럼 계열의 모든 모델이 받는 형식만 도구가 보이고(`gpt-image-2` 계열은 `png|jpeg|webp`), 고른 모델이 받지 않으면 거절한다. `frame_count`·`frame_duration_ms`는 `gif`일 때만, 투명 배경은 `png`·`webp`일 때만 받는다(OpenAI 문서). `png`가 아닌 형식은 API 키에만 보낸다. Codex 구독 대체는 형식을 보내지 않고 PNG만 만들므로, 그런 요청에는 구독을 묻지 않고 카드에 한 줄(`구독(Codex)으로는 GIF를 만들 수 없어요 …`)로 이유를 남긴다. PNG를 GIF 대신 몰래 돌려주는 일은 없다. OpenAI는 SVG에 프로젝트 권한, GIF에 그 모델의 GIF 미리보기 권한이 필요하다고 한다. 권한이 없는 키는 OpenAI의 거절대로 다룬다(403은 다음 키, 그 밖의 400은 끝).
- **GIF 프레임 크기**(IM-31, IM-32): GIF의 `size`는 한 장(프레임)의 크기지만, OpenAI는 모든 프레임을 한 장의 시트에 그린다. 시트도 보통 그림의 한도(한 변 3840px 이하, 655,360~8,294,400픽셀)를 지켜야 해서, 1024x1024로 3장을 부탁하면 `No supported sheet fits 3 GIF frames at size '1024x1024'`로 거절된다(2026-11-09 실제 키). 시트의 칸 배치는 장 수로 정해진다(문서에 없고 OpenAI의 거절 문구로 확인, 돈 드는 그림 없이): 2~8장 4x2 또는 2x4, 9장 3x3, 10~12장 4x3·3x4·4x4, 13~16장 4x4(`OwnImage.gifSheets`, `gifFits`). 그래서 도구는 GIF의 크기가 고정값이면(호출이 준 값이나 설정의 기본 크기) 그 모양을 지키며 부탁한 크기 이하에서 그 장 수에 맞는 가장 큰 프레임(두 변 16의 배수)으로 낮춰 보낸다(`OwnImage.gifSize`): 정사각 2~9장 960x960, 10~12장 816x816, 13~16장 720x720, 가로 3:2는 1200x800·1152x768·1008x672·864x576, 세로 2:3은 그 반대. `auto`는 그대로 보낸다(OpenAI가 맞는 크기를 고른다). 낮췄으면 결과 글(`Frames are 960x960: …`)과 카드(`resized {from, to}`, own-web `프레임 크기 960x960 (요청한 1024x1024보다 줄였어요)`)에 밝힌다. 거절하지 않고 낮추는 까닭: 부탁한 크기로는 그 장 수가 아예 안 되고, OpenAI도 크기나 장 수를 줄이라고만 한다. 편집(`/images/edits`)의 GIF도 같은 규칙이다.
- **SVG 작성 모델**(IM-33, IM-34): OpenAI의 레퍼런스는 `svg.model`을 "SVG model selection"이 켜진 프로젝트에서 필수라고 적고, 실제 키는 이것 없이 보낸 SVG를 `SVG generation requires 'svg.model'.`(`missing_required_parameter`)로 거절했다. 그래서 SVG 요청에는 늘 `svg: {model: OwnImage.SVG_AUTHOR}`(`gpt-6-luna`)를 보낸다. 문서는 쓸 수 있는 작성 모델 목록도 기본값도 적지 않는다. GPT-6 Luna는 요금표에서 가장 싼 현재 GPT-6 모델이고 실제로 깔끔한 SVG를 썼다(IM-36). 추론 강도(`svg.reasoning.effort`)는 보내지 않는다(작성 모델의 기본). 설정 칸은 두지 않는다(문서에 고를 목록이 없고, 이 모델로 충분했다).
- **표시해서 고치기**(`markup`, IM-22): 편집(`images` 첫 그림)에 겹칠 투명 PNG 표시 층의 경로. multipart의 `markup` 파일로 보낸다. 보내기 전에 PNG인지, 투명 픽셀을 담을 수 있는지(알파 채널이나 `tRNS`), 첫 그림과 크기가 같은지(JPEG·WebP는 방향 때문에 가로세로가 바뀐 크기도 받는다. OpenAI가 방향을 적용한 뒤 다시 본다), 둘 다 16,777,216픽셀 이하인지 보고, 아니면 승인을 묻기 전에 이유와 함께 거절한다. 입력 그림처럼 `read` 승인을 따르고 20MiB까지다(OpenAI는 50MB). 2.6 계열에서만 보이고 API 키에만 보낸다. 지금 도구에 `mask`가 없으니 `mask`와 함께 쓰지 말라는 OpenAI의 조건은 저절로 지켜진다.
- **요율**(`OwnImage.RATES`, 2026-11-06 developers.openai.com/api/docs/pricing, IM-18): 100만 토큰당 글 입력 $5(캐시 $1.25), 이미지 입력 $8(캐시 $2), 이미지 출력 $30. 2.6 Flare·2.6 Sunburst·gpt-image-2가 같다. 요율표에는 계열이 고를 수 있는 세 모델만 둔다. ledger 줄은 만들 때 낸 비용을 담으므로 지난 2.5·1.5 모델의 요율은 필요 없다. 비용은 응답의 `usage`로 계산한다. 캐시 토큰은 OpenAI가 종류별로 나누면 그대로, 아니면 이미지 토큰부터 셈한다. GIF와 표시해서 고치기는 따로 값이 없고 같은 토큰 요율이다. SVG는 기준 그림의 `usage`를 이 요율로 셈하고, SVG를 쓰는 작성 모델의 토큰(`svg_usage`)을 그 모델의 요율(`OwnImage.AUTHOR_RATES`, 2026-11-09 요금표 Standard: `gpt-6-luna` 100만 토큰당 입력 $0.10, 캐시 $0.01, 출력 $0.50)로 더해 비용에 넣는다(IM-34, `OwnImage.authorCost`). `svg_usage`에는 캐시 구분이 없어 입력은 모두 입력 요율이고, 추론 토큰은 출력으로 센다(실제 답은 `total_tokens` = 입력 + 출력이라 추론이 출력 안에 들어 있었다. 따로 오면 `total_tokens` − 입력을 출력으로 센다). OpenAI가 날짜 붙은 스냅숏 이름으로 답해도 그 모델로 셈한다. 요율표에 없는 작성 모델이면 전처럼 비용에 넣지 않고 카드와 결과에 모델과 토큰 수만 보인다(IM-24). 카드의 `svgAuthor`는 `reasoning`, `total`, 셈했으면 `costUSD`도 담고, own-web은 `SVG 작성 gpt-6-luna: 입력 … · 출력 … 토큰 · $0.0008 (위 비용에 들어 있어요)`로 보인다.
- **켜고 끄기**(IM-12): 키와 구독 계정은 순서와 상관없이 하나씩 켜고 끈다(`keyOff`, `codexOff`). `useKeys`(설정의 `API 키 쓰기`, 기본 켬)를 끄면 키를 하나도 묻지 않고 단계에도 올리지 않은 채 바로 구독으로 간다. 켜고 끄기는 바닥남 표시와 따로다.
- **키 순서.** `oai` 계정을 `keyOrder` 순서로, 그 밖의 계정은 레지스트리 순서로 뒤에 둔다. `keyOff`의 계정은 건너뛴다. 각 키의 결과:
  - `insufficient_quota`·`billing_hard_limit_reached`·`billing_not_active`이거나 quota를 말하는 429: 그 코드와 본 시각을 own-accounts KV `image:exhausted`에 적고 6시간(`COOLDOWN_MS`) 건너뛴 뒤 다음 키로 간다. OpenAI에는 프로젝트 키의 잔액 API가 없어서 추측하지 않고 이 답만 믿는다. 그 키가 다시 답하거나 사용자가 `image.clear`(`다시 쓰기`)하면 지운다.
  - 그 밖의 429와 5xx·연결 끊김: 같은 키로 2초, 6초 뒤 다시 묻는다(`retry-after`는 20초까지 따른다). 그래도 실패하면 다음 키다.
  - 401은 `키가 거부됐어요`, 403·404는 `이 키로는 이 모델을 쓸 수 없어요`(조직 인증, 모델 권한)로 다음 키다.
  - 그 밖(내용 거절 `moderation_blocked` 같은 400)은 다른 키도 같은 답이라 거기서 끝낸다.
- **Codex 구독 대체**(`codexFallback`, 기본 켬, IM-3): 키가 모두 실패하면 `codex` 계정 가운데 `codexOff`에 없고 한도에 닿지 않은 계정을, 가장 빡빡한 창(`LimitRank.ranked`)의 사용률이 낮은 계정부터 시도한다. Codex의 이미지 도구가 보내는 그대로 `<codex>/images/generations`·`/images/edits`(JSON, 편집 그림은 data URL)에 `model:"gpt-image-2"`(백엔드의 모델, own이 고르지 않는다)로 묻는다. 응답의 `x-codex-*` 헤더는 그 계정의 한도 창을 고친다. 401·403·429는 다음 계정이다. 여러 구독 계정을 번갈아 써서 한도를 피하면 OpenAI 약관에 어긋날 수 있다는 한 줄 안내를 설정에 늘 보인다.
- **만들 계정이 없을 때**(IM-13): 켜진 키(`useKeys`가 켜졌을 때)가 모두 꺼졌거나 바닥남이고 켜진 구독도 모두 꺼졌거나 한도에 닿았으면, 승인을 묻지도 요청을 보내지도 않고 `status:"unavailable"` 카드를 낸다. 시도했다가 모두 실패해도 같다. 카드는 계정마다 이유를 담고, 무리째 빠진 것(`API 키 쓰기를 껐어요`, `OpenAI API 키 계정이 없어요`, `Codex 구독으로 대신 만들기를 껐어요`, `ChatGPT 구독 계정이 없어요`)은 한 줄씩이다. own-web은 `지금 이미지를 만들 수 있는 계정이 없어요`와 `이미지 설정 열기`·`OpenAI API 키 추가` 단추를 보이고, 도구 결과와 스킬은 모델에게 그 말을 전하고 다시 시도하지 말라고 한다.
- **저장과 결과.** 그림은 도구 결과의 파일 부분(`data:` URI)으로 대화에 들어가고, `<OWN_HOME>\images\<세션>\image_<ulid>.<확장자>`에 저장한다. 확장자, 파일 부분의 MIME, 카드의 형식은 요청이 아니라 받은 바이트로 정한다(PNG·JPEG·WebP·GIF 서명, SVG는 XML 머리 뒤의 `<svg` 뿌리, IM-23). 요청과 다른 형식이 오면 그 형식으로 저장하고 카드(`asked`)와 결과 글에 밝힌다. GIF는 첫 장만 정지 GIF로 파일 부분에 넣어 모델에게 보이고(움직이는 GIF를 거절하는 모델이 있고, 거절된 그림은 그 뒤 모든 요청을 깨뜨린다), 움직이는 전체는 카드의 `preview`로 보인다. SVG는 모델에게 그림으로 보내지 않는다(그림으로 SVG를 받는 모델이 없다). 결과 글에 크기와 경로를 알려 모델이 필요하면 파일을 글로 읽게 하고, 카드의 `preview`로만 보인다. `path`를 주면 프로젝트의 그 경로에 쓰고(확장자는 요청한 형식으로 바꿔서), 그 경로의 `edit` 승인을 묻는다. 받은 형식이 달라 다른 파일이 되면 그 파일도 묻는다. 입력 그림은 경로로 받고(첨부한 그림의 경로, 앞서 만든 그림의 경로) `read` 승인을 따른다. **그림을 만드는 것 자체는 묻지 않는다**(사용자 결정 2026-11-08, IM-27): `image_generate` 권한(자원은 모델)은 `묻기`·`읽기 전용`·`전체 허용` 어느 모드에서나 기본으로 허용이고, 승인 묶음(9.2)에 이 동작의 규칙이 없다. 하위 에이전트의 쓰기 역할도 같고, 읽기 전용 역할(`explore`, `own-review`)만 묻지 않고 거부한다(07 §2.4, MR13).
- **결과 카드**(`metadata.ownImage`, `OwnImage.CardData`): `status`(`running`·`done`·`unavailable`·`failed`), 모델, 경로(`key`|`codex`), 계정 이름, 비용(USD, 키일 때), 저장 경로, 받은 형식(`format`)과 다를 때의 요청 형식(`asked`), GIF 장 수(`frames`), 낮춘 GIF 프레임 크기(`resized`, IM-32), GIF·SVG의 `preview`(base64 `data:` URI), SVG 작성 토큰(`svgAuthor`), 시도한 계정마다의 결과와 이유(`steps`). own-web은 도구 카드 아래에 이 줄을 그린다. 그림은 base64 그림 `data:` URI만, 늘 `<img>`로만 그린다(`src/image/preview.ts`). 그래서 SVG 안의 스크립트나 `onload`는 돌지 않고 페이지에 SVG 요소가 들어가지 않는다(IM-23). `unavailable`이면 `이미지 설정 열기`(`/settings/image`)와 `OpenAI API 키 추가`(계정 추가 대화상자의 OpenAI 키 양식, `/accounts/add/oai`) 단추를 보인다.
- **사용량.** 호출마다 `kind:"image"` ledger 줄을 쓴다(7.5). API 키는 토큰(입력, 그중 캐시, 출력)과 요율로 낸 USD(`source:"ratecard"`), 구독은 토큰과 비용 없이 쓰고 사용량은 구독 한도 창에 남는다.
- **스킬 `imagegen`.** Codex에 들어 있는 같은 이름의 스킬(Apache-2.0)을 own에 맞게 고쳐 own 제공 스킬로 늘 등록한다(`/builtin/own/imagegen.md`, 설정 > 스킬의 `own 제공`). 원본과 바꾼 점은 `packages/own-accounts/src/image/skill/MODIFICATIONS.md`, 라이선스는 같은 폴더의 `LICENSE.txt`다. 모델 절은 계열을 따른다(`auto`면 Flare와 Sunburst를 고르는 기준, 고정이면 그 모델, 2.6 계열이면 `complexity`를 고르는 기준과 `Formats`(GIF는 짧은 반복 움직임, SVG는 아이콘·로고·단순한 벡터 그림), `Markup edits` 절, `gpt-image-2`면 래스터 세 형식만). 스킬 한 줄 설명도 계열을 따른다(IM-25). 도구가 꺼져 있으면 모델이 사용자에게 위 설정을 켜라고 해요체로 말하게 한다.
- **RPC.** `image.get`(`read`)과 `image.clear`(`admin`), 위치 `control`(9.2). 설정은 `policy.set{image}`(필드 단위로 바꾼다, `OwnImage.apply`)다.
- **시험과 실제 확인.** own-accounts 시험의 가짜 Images API(`test/image/openai-rules.ts`, `formats.test.ts`·`flow.e2e.test.ts`, 실제 확인 스크립트의 마른 실행도)는 OpenAI가 실제로 거절한 것을 똑같이 거절한다: 시트에 맞지 않는 GIF, `svg.model` 없는 SVG. 그래서 이 둘이 다시 깨지면 시험이 실패한다. 실제 키 확인은 `packages/own-harness/script/live/image-api.ts`다(PNG, 3장 GIF, SVG, 표시해서 고치기. 2026-11-09 결과는 IM-36).

### 9.7 곁질문 (`/btw`, BTW, 2026-11-22)

대화를 멈추지 않고 그 대화에 대해 묻는 한 번의 모델 호출이다. 화면은 03 §4.4.2, 결정은 decisions BTW, 측정은 `own/reports/side-question-2026-11-22.md`.

- **요청 모양(core P-061 `ctx.session.side`).** core의 `SessionGenerate.side`가 다음 primary 요청이 보낼 기록(정착한 메시지, 지시문의 첫 값, 아직 보내지 않은 지시문 갱신. `SessionHistory.preview`, 읽기만)을 그 요청과 같은 system·지시문·도구 카탈로그로 짓고, 그 뒤에 곁질문 차례(앞 질문과 답, 그리고 이번 질문)를 user·assistant 메시지로 붙여 `llm.stream` 한 번으로 보낸다. 요청 종류는 `generate`이고 훅에는 `side: true`가 간다(`generate` 훅 이벤트, `model.request`·`http.*` 범위). own-harness는 `side`인 generate를 다음 `context` 요청처럼 짓는다(Codex의 effort 갱신 항목 포함. dsh 스냅숏과 계열 로그는 남기지 않는다). 그래서 앞부분이 다음 primary 요청과 같고 제공자의 프롬프트 캐시가 그대로 맞는다. core는 입력·메시지·step·사용량·이벤트를 하나도 쓰지 않고, 재시도하지 않으며(흘러간 글이 겹친다), 도구 호출이 오면 거기서 끊는다(도구는 돌리지 않는다). WebSocket은 쓰지 않는다(그 소켓은 본 실행의 것): 늘 HTTP다.
- **첫 질문의 지시.** own-accounts가 첫 질문 앞에 `<side-question>…</side-question>`(곁질문이며 본 대화는 보지 못한다, 대화가 보여 준 것으로 짧게 답하라, 도구는 없으니 부르지 말라, 사용자의 말로 답하라)을 같은 user 메시지 안에 붙인다. 이어 묻기는 앞 차례를 바이트 그대로 다시 보내고 질문만 붙인다.
- **도구 선택.** 도구 목록은 늘 대화와 같게 둔다(빼면 prefix 맨 앞이 바뀐다). 첫 시도의 `tool_choice`는 경로마다 측정해 정한다(`SideQuestions.toolChoiceOf`, 보고서 §3): **모든 경로에서 보내지 않는다**(대화와 같은 `auto`). 2026-11-22 실측에서 `tool_choice:"none"`은 ChatGPT와 DeepSeek에서 첫 곁질문의 캐시를 0%(Pi·omo는 62–73%)로 떨어뜨렸고(보내지 않으면 96–99%), Claude Agent 경로에서는 도구를 아예 빼서 0%였다. Anthropic API 키와 OpenAI API 키는 어느 쪽이든 같았다(96.6–96.8%, 76–82%). 경로마다 다르게 두지 않고 한 규칙으로 둔다. 모델이 글 없이 도구부터 부르면 같은 요청을 한 번 `tool_choice:"none"`으로 다시 묻는다. 글을 낸 뒤 부르면 그 글까지가 답이고 `finish:"tool-calls"`다.
- **RPC**(`own.accounts`, 위치 `session`: 대화를 돌리는 서비스가 답한다. SSH 호스트의 대화는 호스트의 서비스가 호스트에서 묻는다).
  - `side.ask` `{sessionID, threadID?, question}` → `{thread}`(새 차례는 `running`). 범위 `prompt`. 오류 `side_unavailable{reason:"session"|"route", detail?}`, `side_not_found{threadID}`, `side_busy{max}`(대화 하나에 답을 기다리는 곁질문 2개 `Side.RUNNING_MAX`, 또는 그 곁질문의 답이 아직 흐르거나 8차례 `Side.TURNS_MAX`).
  - `side.get` `{sessionID, threadID}` → `{thread}`(흐르는 차례는 지금까지의 글). `read`.
  - `side.list` `{sessionID}` → `{threads: SideSummary[]}`(새것부터). `read`.
  - `side.cancel`·`side.remove` `{sessionID, threadID}`. `prompt`. 지우기는 흐르는 답을 먼저 멈춘다.
  - 이벤트(세션): `side.delta {sessionID, threadID, turn, offset, text}`(80ms마다 모아서. `offset`이 비면 클라이언트가 `side.get`으로 다시 읽는다), `side.ended {sessionID, threadID, index, turn}`.
- **저장.** own-accounts KV `sess:<sessionID>:side`(`Kv.side`)에 `{threads}`, 새것부터 12개(`Side.THREADS_MAX`), 답은 24,000자까지(`Side.cut`). 대화의 메시지·지시문·압축 입력이 아니다. 대화를 지우면 줄도 지운다. 흐르는 답은 프로세스 상태라 서비스가 다시 시작하면 그 차례는 `failed`(`서비스가 다시 시작돼 답이 끊겼어요.`)로 읽힌다. 5분(`Side.TIMEOUT_MS`)이 넘으면 멈춘다.
- **사용량.** 끝난 답마다 `kind:"side"` ledger 줄(7.5 항목 8). 차례에는 `tokens`와 `cost`(요율표 기준)가 남아 패널이 보인다.
- **SSH 호스트와 기기.** 메서드는 `REMOTE_MANAGED`가 아니므로 호스트의 own-accounts가 답한다(호스트의 계정 인증 헤더는 늘 그렇듯 브로커가 준다). 이 메서드를 모르는 옛 호스트 서비스는 `rpc.method_not_found`로 답하고 own-web은 `이 서비스는 곁질문을 몰라요. SSH 호스트의 대화면 그 호스트를 업데이트해 주세요.`를 보인다(앱 버전이 다르면 호스트 패널이 이미 `업데이트 필요`다). 원격 `proto`(브로커 선)는 바뀌지 않는다. 휴대폰·다른 PC는 게이트웨이가 `OwnAccounts.scopeOf`로 거른다: 묻기·멈추기·지우기 `prompt`, 읽기 `read`. 이벤트는 `own.accounts` 이벤트라 그 서버를 보는 기기에 간다(대화를 읽을 수 있는 기기다).

## 10. 코어 패치(원장 ID 기준)

**이 문서 범위(계정·캐시·한도)에는 코어 패치가 거의 필요 없다.** 예외는 출력 상한 설정(4.9)의 P-032와 캐시를 이어 쓰는 요약 요청(4.7.5)의 P-034다. UI 임베드(own-web을 same-origin으로 서빙)에는 원장의 planned 패치 P-001/P-002가 필요하다(01 §12.2, `own/FORK.md` §6.3). 아래는 이 스펙과 관련된 원장 항목이다. ID와 상태는 원장을 따른다.

| 원장 ID | 상태 | 내용 | 이 스펙에서 좋아지는 점 | 파일(churn30) |
|---|---|---|---|---|
| P-004 | candidate(G8 실패 시, 예외 승인 필요) | retry 이벤트에 `retryAfterMs`와 rate-limit 상세 | hard/transient를 응답 캡처 짝짓기 없이 분류(5.2) | `ai/src/route/executor.ts`, `schema/src/session-error.ts`, `core/src/session/to-session-error.ts`(3/0/6) |
| P-005 | candidate(G7 실패 시, 예외 승인 필요) | WS 핸드셰이크 응답 헤더 hook | codex 한도를 WS 경로에서도 얻음. 먼저 HTTP transport 전환(7.1)을 쓴다 | `core/src/session/model-request.ts`(18, hot) |
| P-006 | candidate(Phase 3) | 1h cache write 분리와 TTL 반영 비용 | 1h 모드 비용이 정확해짐(4.5, 7.2) | `core/src/session/usage.ts`(2) |
| P-007 | **rejected**(G2 실패 때만 재검토) | 요청별 credential 선택 | `Auth.none` 우회 없이 native auth, 풀링, stateless generate 인증(4.1) | `core/src/model-resolver.ts`(17, hot) |
| P-008 | **rejected** | 플러그인 `session.compact/fork`, `update(metadata)` | 압축 후 전환을 플러그인이 끝까지 처리. 지금은 프런트가 HTTP로 한다(5.9(b)) | `core/src/plugin/host.ts`(23, hot) |
| P-009 | **rejected** | ChatGPT OAuth 구현 export | own-accounts가 재구현한다(3.2) | `core/src/plugin/provider/openai.ts`(13) |
| P-011 | candidate(Phase 3, 예외 승인 필요) | hook이 요청 단위 `request.cache`(TTL 포함)를 정할 수 있게 | 1h 모드에서 hint 4개 배치가 필요 없고 400 위험이 사라짐(4.5) | `core/src/session/model-request.ts`(18, hot) |
| P-012 | candidate(대체 모드 사용 시, 예외 승인 필요) | credential별 refresh 세마포어 | 대체 모드(3.7)의 계열 충돌 방지 | `core/src/integration.ts`(10) |
| P-013 | candidate(Phase 3, 예외 승인 필요) | 세션 `generate`에 model 지정 | 인계 요약을 다른 모델로(5.9(f)) | `core/src/session/generate.ts`(6) |
| P-032 | **active**(2026-10-19, 한도 초과 예외, 사용자 승인) | 요청 hook이 256,000 상한 전의 기본 출력 한도 `outputCeiling`을 본다 | 출력 상한 설정이 core 값을 그대로 낮추고, DeepSeek V4(393,216)처럼 출력이 큰 모델에는 남은 자리를 다시 셈하지 않고 올린다(4.9) | `core/src/session/model-request.ts`(15, hot), `plugin/src/{effect,promise}/session.ts`(2/2), 새 시험 파일 |
| P-034 | **active**(2026-10-24, 한도 초과 예외 H-D6 형식, 사용자 승인 CC) | 요약 압축이 hook이 원하면 대화 전체를 먼저 한 번 보내고(두 번째 hook 실행에 `kept`), overflow·고정 생각 예산·hook의 거절(이유 포함)·실제 창·가격 구간을 보고 아니면 지금의 older 요청을 보냄. 그 결과를 체크포인트 metadata `prefix`에 남기고, 대체 모델·코드 요약의 체크포인트에도 이어 남김. hook이 `cancel`을 주면 요청 없이 취소로 끝냄(CC-16) | Anthropic(Claude 구독 포함)에서, 최근 부분이 lookback보다 길고 그 앞 항목이 식었을 수 있을 때 압축 요청이 직전 요청의 캐시를 읽음(4.7.5, 6.3 ⑥. 실측 S1: older 71~72% → 전체 98%), 자리 비움 압축이 따뜻한 캐시로 돌고 늦게 전달된 것은 버림(4.7.7) | `core/src/session/compaction.ts`(7), `core/src/session/model-request.ts`(13, hot), `plugin/src/{effect,promise}/session.ts`(2/2), 시험 |
| P-045 | **active**(2026-10-31, 한도 초과 예외, 사용자 위임 2026-10-27, CAG. 처음 번호 P-038) | Claude Agent의 실제 claude는 provider 설정이나 요청의 provider 옵션(대화마다, 2단계)의 계정 폴더(`configDir` → `CLAUDE_CONFIG_DIR`)에서만 뜨고, SDK의 기록 확인·fork·삭제도 그 폴더를 본다 | 갱신자가 둘인 폴더가 없다. 쉬고 난 뒤 이어 받기와 압축 fork가 계정 폴더에서 된다(8.10.2, 8.10.5) | `core/src/plugin/provider/claude-agent/claude/{io,folder-store,fork,query-options,status,sessions}.ts`(0, upstream-v2에 아직 없음) |
| P-039 | **active**(2026-10-31, 같음) | Claude Code의 `rate_limit_event`·시작 계정·사용량 답을 등록 심볼 채널로 플러그인에 넘기고, 폴더의 사용량을 물을 수 있게 | 이 경로의 한도 막대와 한도 이유(8.10.4) | `…/claude/{observer,sessions,session,probe}.ts`, `…/index.ts`(0) |
| P-042 | **active**(2026-10-31, 같음) | claude는 서비스 env의 허용 목록만 받는다 | 바깥 Claude Code 세션의 이메일·계정 id가 프롬프트에 들어가지 않는다(8.10.6) | `…/claude/io.ts`(0) |
| P-018 | **active**(2026-10-11, 한도 초과 예외, 사용자 승인) | 파싱한 모델 이벤트의 진전 감시(진전 없음 5분, 열린 도구 입력 2분, Responses 시도 15분)와 LocationActivity가 실행 중인 세션을 멈추지 않게 함 | 멈춘 스트림이 같은 계정에서 재시도·이어 하기로 회복되고, 전환 트리거(5.2)로 오인되지 않음. slot의 provider·모델 설정 `progressTimeout`·`toolInputTimeout`으로 kind별 조정 가능 | `ai/src/route/client.ts`, `ai/src/schema/options.ts`, `core/src/provider.ts`, `core/src/location-activity.ts`, `core/src/session/execution.ts`(5/6/12/0/3) |
| P-014(제안, 원장 미등록) | 제안(필요할 때만, 예외 승인 필요) | 모델 단위 압축 설정: `Model.Settings.compaction`에 `keep`·`buffer`를 더하고 `compact()`가 Location 전역 값보다 먼저 쓰게 함 | kind별 `keep`(4.7.6)과 실효 창 없이 정확한 기준. 지금은 필요 없다(4.7의 `limit.input` 방식으로 충분) | `core/src/session/compaction.ts`(31, hot), `schema/src/model.ts` |

- **upstream 제안(패치 아님)**: (1) 세션 `generate`가 usage를 기록하게 하는 것(`core/src/session/generate.ts:63-64`), (2) 플러그인이 받을 수 있는 공개 사용량 이벤트(예: `session.usage.recorded`를 공개 manifest에 넣거나 title·generate도 압축처럼 공개 이벤트에 `tokens`·`cost`·`model`을 싣기, `schema/src/session-event.ts:618,707-711`). 둘 다 받아들여지면 7.5의 SSE 사본 읽기를 지운다.

- 원장 규칙은 파일당 30줄 이하, 30일 커밋 5건 이하 파일만이다(01 §12.1). P-004(`to-session-error.ts` 6), P-005, P-011, P-012, P-013은 이 규칙을 넘으므로 켤 때 예외 승인과 upstream 제안이 먼저다.
- churn30은 2026-08-27~09-26 `upstream-v2` non-merge 커밋 수(로컬 측정)이고, 값은 원장(01 §12.2, FORK.md §6.3)을 따른다.

### 10.1 이 문서가 기대는 upstream 표면(`check-surface` 입력)

업스트림이 바뀌면 이 설계가 조용히 깨지는 지점이다. `own/scripts/check-surface.mjs`(FORK.md §4)의 입력 목록에 넣는다. 파일은 `own/upstream-surface.json`으로 둔다. 런타임에 확인할 수 있는 항목은 `diagnostics.selfTest`도 확인한다(4.2).

| 심볼 / 동작 | 파일(churn30) | 기대 값 | 깨지면 |
|---|---|---|---|
| `Auth.none` 교체 조건 | `core/src/model-resolver.ts:372-380`(17) | `activation==="enabled" && credential===undefined && !hasConfiguredAuth && usesAPIKeyAuth(package)` | 인증이 전역 credential·env로 떨어진다. selfTest `auth_swap_broken`. 3.7 대체 모드 |
| `usesAPIKeyAuth` 목록 | `model-resolver.ts:423-459` | openai, anthropic, deepseek, xai, openrouter, openai-compatible의 `@opencode/ai/providers/*` 포함 | 그 kind가 `Auth.none`을 못 탄다 |
| codex 허용·금지 목록, 모델 필터 | `core/src/plugin/provider/openai.ts:24-25,271-297`(13) | 허용 `gpt-5.5`, `gpt-5.3-codex-spark`, 5.4 초과. 금지 `gpt-5.5-pro`, `gpt-5.6`. `cost:[]`, `limit {400000, 272000}` | codex 템플릿 규칙(3.6) 갱신 |
| codex 헤더와 `session-id` hook | `openai.ts:254-309` | `originator: opencode`, `x-codex-beta-features: remote_compaction_v2`, `session-id` = 세션 affinity(자식은 부모 것), openai `transport` 기본 `websocket` | 3.6 표, 4.1 헤더 표 갱신 |
| 토큰 공유 세션 헤더와 zstd | `core/src/plugin/provider/chatgpt.ts` model.request hook, provider.transform | `session-id` = 세션 affinity, `thread-id`·`x-client-request-id` = 세션 ID, `originator`·`chatgpt-account-id` 없음, baseURL을 설정하지 않으면 `encoding: "zstd"`. surface id `chatgpt-sharing-session-headers` | 3.2c "세션 헤더"·"본문 압축", 3.6 `settings.encoding`, 4.1 헤더 표 갱신 |
| Identity 줄 형식과 위치 | `core/src/plugin/identity.ts:9-16,27`(2) | `# Your Model` / `- Name:` / `- Provider ID:` / `- Model ID:`, `system.splice(1,0,…)`, context·compaction·generate 세 hook | D9 정규화가 멈춘다(`identity_format_changed`). ① 셋째 줄로 떨어짐 |
| AUTO cache 순서와 예산 | `ai/src/cache-policy.ts:17-24,47-48,150-161`(2) | tools → system(첫·끝) → tail 1, 예산 4, 수동 먼저, auto는 TTL 없음 | 4.5 watermark·1h 배치 재검토 |
| Anthropic lowering 순서 | `ai/src/protocols/anthropic-messages.ts:502-510,1044-1060` | tools → system → messages, hint마다 독립 `cache_control`, 초과분 버림 | 4.5 재검토 |
| retry 일정 | `core/src/session/runner/retry.ts:66-89`(12) | 최대 10회, 2초→10초, `retry-after` 회당 15분 상한 | 8.8 멈춤 추정, 5.2 판정 시간 |
| compaction keep과 ceiling | `core/src/session/compaction.ts:189,867-873`(31, hot) | `keep: 15_000`, `window = limit.input \|\| limit.context`, buffer 없으면 `window − max(floor(window × 0.1), 16k)`(d9987ef9c8, 그전 `floor(window × 0.9)`), window ≤ 0이면 자동 압축 없음 | 6.1 `K`, 5.6, **4.7의 `ctx_eff` 식 전체**. 바뀌면 selfTest가 기준 불일치를 내고 `compaction_threshold_mismatch`가 늘어난다 |
| 요약 예산 = ceiling | `compaction.ts:203-212,292,386-395` | 요약 요청을 ceiling에 맞추고 넘으면 오래된 교환을 버림 | 4.7.5 `truncates`, `compaction_may_truncate` |
| 압축 설정의 범위 | `core/src/config/plugin/compaction.ts:15-24`, `schema/src/provider.ts:35-41`, `schema/src/model.ts:57-63` | 설정은 Location 전역, provider·model settings에는 요약 방식만 | 4.7.2 방식 선택. 모델 단위 설정이 생기면 그쪽으로 옮긴다 |
| `limit.output`만 variant 예산에 씀 | `core/src/variant.ts:45-47,72` | `limit.input`을 variant가 읽지 않음 | 4.7이 `limit.input`만 바꾸는 근거 |
| 수동 compact와 revert | `core/src/session/session.ts:247-264`, `core/src/session/inbox.ts:204-224`, `protocol/src/groups/session.ts:496-513` | `id` 선택 입력, 기본 `steer`, **입장 전에** staged revert를 commit, 같은 id 대기 중이면 멱등·전달 뒤면 409, 대기 중 압축에 합쳐짐 | 4.7.4 `compaction.due` 조건·클라이언트 revert 확인·중복 제거 |
| revert commit이 메시지를 지움 | `core/src/session/projector.ts:739-764`, `schema/src/session-event.ts:641-651` | 경계부터 뒤 메시지·inbox 삭제, 이벤트 `session.revert.*`가 공개 | 4.7.4 "revert", 2.4.6 epoch |
| 자동 압축 발동의 측정값 규칙 | `core/src/session/compaction.ts:225-234,879-884` | 현재 providerID의 측정 prompt가 마지막 checkpoint 뒤에 없으면 자동 압축 안 함. 추정의 기준 측정값은 P-017로 같은 모델 id의 다른 provider 것도 씀(4.7.1) | 4.7.5 작은 창 전환 설명, 7.7 `compaction_threshold_mismatch` 제외 규칙 |
| 압축 이벤트의 사유와 사용량 | `core/src/session/compaction.ts:377`, `schema/src/session-event.ts:585-639` | overflow도 `reason:"auto"`. `ended/failed`가 `tokens`·`cost`(ended는 `model`)를 실음 | 7.5 압축 ledger 줄, 7.7 |
| `session.usage.recorded`가 비공개 | `schema/src/session-event.ts:618,655-711`, `schema/src/event-manifest.ts:71-84`, `core/src/plugin/host.ts:255-265` | 공개 manifest에 없음 → 플러그인 구독에 안 옴 | 7.5 title을 SSE 사본으로 읽음. 공개되면 그쪽으로 바꾸고 사본 읽기를 끈다(이중 계산 방지) |
| 세션 generate usage 미기록 | `core/src/session/generate.ts:63-64` | usage를 로그로만 남김 | 7.5 SSE 사본 읽기. 기록하게 바뀌면 이중 계산을 막기 위해 끈다 |
| `http.response` 이벤트의 범위 필드 | `core/src/session/model-request.ts:211,312-315` | `{sessionID, agent, model, kind}`를 그대로 실음 | 7.5 짝 찾기 없음 |
| subagent 모델 결정과 입력 hook | `core/src/tool/plugin/subagent.ts:36-38,129-137,168-184,271-310`, `core/src/tool/plugin/opencode.ts:134-195`, `core/src/tool.ts:103-160` | `override ?? agent.model ?? parent.model`, 이어 부르면 override일 때만 전환, `execute.before`로 입력 수정 가능, 모르는 agent는 `Unknown agent:` 도구 실패, `opencode_models` 결과는 `execute.after`에서 고칠 수 있음. surface id는 5.11 규칙 2의 목록 | 5.11 규칙 2(07 §5.4 관문). 거절 경로가 깨지면 07 PG1의 예비안 |
| Code Mode 카탈로그 전달 | `core/src/codemode/tool.ts:61-68`, `core/src/codemode/instructions.ts:32-124`, `core/src/session/instruction-state.ts:41-60,164-175` | `execute` 설명 불변, 카탈로그 변경은 뒤에 덧붙는 Instructions delta, 기준선은 epoch마다 | 4.3 D10의 "delta 한 번" 판단. 카탈로그가 도구 설명이나 system으로 옮겨 가면 D10을 다시 본다 |
| warming 프롬프트 | `core/src/plugin/warming.ts:9-13,70-80` | 기본 프롬프트 문자열, 4분 간격, prompt 일치로 자기 ping 판별 | 7.5 `purpose:"warming"` |
| 도구 스냅샷 필터 | `core/src/tool.ts:229-261,292-295` | `resource:"*"` deny면 목록과 code mode 카탈로그에서 빠짐. `"**"` deny는 목록에 남김. `codemode:false`만 직접 정의 | 4.3 D10, 9.2 승인 모드 규칙 모양 |
| 브라우저 도구 등록 | `core/src/plugin/internal.ts:89,216,271`, `plugin-browser/src/tools.ts:33-58`, `plugin-browser/src/connection.ts:136-141` | 내장 pre 플러그인(guarded 아님), 호스트와 무관하게 정의 등록, `codemode:true`, 호스트 없으면 `[browser.disconnected]` | 4.3 D10(05 §8.7 안 D). 호스트 연결에 따라 정의가 바뀌게 되면 세션 생성 때 새김 규칙을 다시 본다 |
| HTTP wrapper 게이트 | `core/src/session/model-request.ts:295-321` | `has(http.request) \|\| has(http.response)`면 wrapper | 4.1 등록 방식, I7 |
| WS 경로 조건과 hook | `model-request.ts:326-350` | `webSocket==="session" && transport==="websocket"`, 핸드셰이크는 요청 헤더만 | 7.1 codex 수집 순서 |
| `prompt` hook의 `delivery` | `core/src/session/prompt.ts:40-51,88`(6) | 기본 `"steer"`, hook이 바꾼 값을 사용 | 5.3 queue 변환 |
| 플러그인 활성화 순서 | `core/src/plugin/supervisor.ts:91-95,154`(16) | 내장 pre → 설정 순서 → 내장 post. 로컬 먼저, 설치 중 npm은 나중 | 8.2 순서, D9 hook 순서 |
| hook scope 필터 | `core/src/plugin/hooks.ts:88-102`(2) | scope는 `trigger` 필터, `has()`는 unscoped 포함 | 4.1 등록 방식 |
| RPC 오류 인코딩 | `core/src/rpc.ts:120-131,232-240` | 선언된 `DeclaredError`만 400 | 9.4 |
| stateless generate | `core/src/generate.ts:38-67`(4) | session hook 없음 | 4.1 한계. 바뀌면 제한을 풀 수 있다 |
| 속도 요청 필드(4.8, 2026-10-06) | `core/src/models-dev.ts`, `ai/src/protocols/open-responses.ts`, `ai/src/protocols/utils/open-responses-options.ts`, `core/src/session/model-request.ts`, `ai/src/protocols/anthropic-messages.ts` | 모드 항목 `<id>-<mode>`(`modelID` = 기본 모델, 모드 body·headers·비용), hook 옵션 `serviceTier` → provider 옵션 → `service_tier`(아무 문자열), `http.request`가 바꾼 요청이 그대로 나감, core Anthropic에 `speed` 없음·beta는 hook 전에 합침. surface id `models-dev-speed-modes`, `open-responses-service-tier`, `open-responses-service-tier-option`, `session-request-provider-options`, `speed-http-request-body`, `anthropic-options-no-speed` | 4.8 요청 형성과 모드 숨김. Fast·Ultrafast가 조용히 표준으로 갈 수 있다 |
| 출력 한도 기본과 `outputCeiling`(4.9, 2026-10-19) | `core/src/session/model-request.ts` outputLimit, `plugin/src/{effect,promise}/session.ts` `SessionRequest` | 메인·요약 초안에 `maxTokens` = min(출력 한도(없으면 32k), 256k, 남은 자리)와 P-032의 `outputCeiling`(같은 값, 256k 상한 없이) | 출력 상한 형성(`auth/output-limit.ts`)과 D2. 10.1 `session-output-limit` |
| Claude 어댑터의 빈 출력 한도(4.9) | `ai/src/protocols/anthropic-messages.ts` | `maxTokens`가 없으면 `max_tokens` 32,000(`DEFAULT_MAX_TOKENS`), 명시 생각 예산은 그 절반 아래로 줄임(`fitThinking`) | `OutputLimit.CLAUDE_DEFAULT`, 설정 화면의 캐시 안내. `anthropic-default-max-tokens` |
| Chat Completions의 빈 출력 한도(4.9) | `ai/src/protocols/openai-chat.ts` | 값이 없으면 `max_tokens`·`max_completion_tokens`를 본문에서 뺌 | `보내지 않기` 표(DeepSeek 생각 켬, xAI, compat). `openai-chat-absent-max-tokens` |

---

## 11. PoC 테스트

**공통 준비**
- codex 계정 A·B(같은 모델과 variant)
- Anthropic 키: 다른 workspace 2개, 같은 workspace 1쌍
- OpenAI API 키: 같은 org 2개, 다른 org 1개
- DeepSeek 키 2개, OpenRouter 키 1개
- 결정적 prefix 약 60k(고정 파일 세트를 읽힘)
- 요청 body와 WS frame은 **hash만** 로그한다(내용과 토큰은 기록하지 않는다).

| ID | 목적 | 방법 | 통과 기준 | 실패 시 |
|---|---|---|---|---|
| AC-P01 | `Auth.none` 주입(모든 kind, compat 포함) | 읽기 전용 `http.request`와 `ws.handshake`에서 `Authorization`, `x-api-key`, `chatgpt-account-id` hash를 providerID별로 기록. 서버 env에 `OPENAI_API_KEY`와 `ANTHROPIC_API_KEY`를 둔 상태로도 실행. selfTest `authSwap` 판정도 함께 본다 | 모든 요청이 바인딩된 계정 값을 가짐. 계정 간 혼입 0. env 값 미사용. `MissingCredentialError` 0. selfTest `authSwap:"ok"` | 3.7 대체 모드 |
| AC-P02 | 모든 kind 적용 | primary, compaction, title, generate 각각 | 네 kind 모두 주입됨 | kind별 보완 |
| AC-P03 | 비밀 노출 | `GET /api/provider`, `/api/model`, KV dump, ledger에서 비밀 패턴 검색 | 0건 | 설계 수정 |
| AC-P04 | codex 동등성(T1) | 같은 대화를 내장 `openai`(ChatGPT)와 `own-codex-*`에서 10 step 도구 루프로 실행. `own-codex-*`는 `transport` websocket과 http 두 번 | 헤더 집합이 같음(인증 제외). step별 hit 차이 ≤ 5pt. 둘째 step부터 `cache.read ≥ 0.9×직전 P`. http transport도 같은 기준. 어느 transport를 기본으로 할지 결정을 기록 | 헤더·설정 재점검 |
| AC-P05 | 격리와 같은 도메인(T2) | 두 slot의 요청을 hash로 비교해 **tools + system + 첫 사용자 메시지(`Z + u_1`)까지 바이트가 같은지** 먼저 확인(D9). 그다음 A를 데우고 B의 첫 요청 | 다른 도메인: `cache.read ≤ 5%·P`. 같은 workspace·org: `cache.read ≥ 0.9·(Z+u_1)`. 이것이 서버의 slot 간 캐시 공유를 재는 기준이다. 결과로 6.3 ① `W_t^lo` 사용 여부를 정한다 | 도메인 표 수정. ①의 둘째 줄을 `W^hi`에만 둔다 |
| AC-P06 | TTL 안 복귀(T3a/T3b) | A→B(블록 15개 미만)→A를 5분 안에. 이어서 20블록 초과로 반복 | codex·oai·anth `return_hit ≥ 0.9`. 20블록 초과는 anth watermark가 있으면 ≥ 0.9. oai 5.6+와 codex는 측정값 기록 | lookback 모델 수정 |
| AC-P07 | byte 동일성(T4) | A의 마지막 요청과 복귀 요청 비교. 같은 kind의 두 slot 요청에서 identity part(D9 정규화 뒤)를 비교 | `L_A`까지 hash 일치. 두 slot의 identity part hash 일치 | hook 결정성 조사, D9 형식 확인 |
| AC-P08 | TTL 측정(T5) | 10/20/35/60/120분 뒤 복귀. codex, oai 5.5/5.6, DeepSeek | 측정값 기록 | ratecards TTL 갱신 |
| AC-P09 | 압축 경제성(T7 수정판) | P≈150k에서 compact-then-switch와 now를 비교. **요약 요청 자신의 `cache.read / (Z+P_older)`**를 anth, codex 5.5, codex 5.6에서 기록 | 합계 ≤ now의 70%(codex). 실측 S와 `h_c` 기록. anth는 측정 결과로 권장 규칙 조정 | 5.6 표 수정 |
| AC-P10 | compact 경로 | `POST /api/session/:id/compact`가 2.0.18 포크에서 동작하는지. 플러그인이 `compaction.ended`를 받는지 | 둘 다 성공 | UI 순서 조정 |
| AC-P11 | strip 안전망(T8) | 풀링 모드에서 A↔B 20회(cold point) | 암호화·org 오류 0회. 안전망이 발동했다면 이후 hash가 안정 | 풀링 금지 유지 |
| AC-P12 | flap 방지(T9) | 두 계정 모두 90% 상황을 가짜 provider로 모사 | cooldown 중 자동 전환 0회. 진동 없음 | 정책 수정 |
| AC-P13 | WS(T10) | 전환과 계정 안 token refresh | 교체해도 오류 없음. refresh 뒤 hit 변화 < 5pt | – |
| AC-P14 | 추정기 정확도(T11) | 예측 cold와 실측 `input+cache.write` 비교 | 오차 ±15%(codex, anth), ±25%(ds, xai) | ρ, Z 재보정 |
| AC-P15 | 한도 캡처(T12) | codex HTTP 헤더, WS `codex.rate_limits`, anth·oai 성공 헤더, 소진 응답 본문 형태(`usage_limit_reached`, `resets_in_seconds` ⚠). codex는 WS slot과 HTTP slot 두 가지로 | codex는 매 primary 턴마다 used%와 리셋 시각을 얻음. 소진 오류 분류 성공. WS 프레임이 오지 않으면 HTTP slot에서 매 응답 헤더를 얻는지 확인하고 codex 기본 `transport`를 `http`로 정해 기록(7.1). **결과(2026-10-18)**: WS 프레임이 응답마다 오고 HTTP 헤더도 온다. `websocket` 유지(7.1) | HTTP transport. 그것도 안 되면 P-005, wham/usage 검토 |
| AC-P16 | Anthropic 1h(T13 확장, Phase 3) | 1h 모드 hint 배치(4.5)를 네 경우로: (a) watermark 있음, (b) **watermark 없음**(4번째가 epoch 첫 메시지), (c) system part 3개 이상에 메시지 1개(4번째가 system의 다른 part), (d) 4자리를 채울 수 없는 짧은 세션. beta 헤더 없이. 떠나기 전 1h를 설정한 경우와 안 한 경우에 6–30분 뒤 복귀 | 네 경우 모두 400 없음. 요청 body의 `cache_control` 순서에서 5m가 1h보다 앞에 오는 경우 0건((d)는 1h hint 0개). 1h를 설정했으면 `return_hit ≥ 0.9`. 5m→1h 재기록 비용 측정 | 1h 모드 비활성 |
| AC-P17a | 턴 중간 소진 → 유휴 전환 → 계속(T14) | 도구 루프 중 소진 | 작업이 이어짐. 도구 중복 실행 없음 | – |
| AC-P17b | 턴 안 failover | retry hook에서 `switchModel` + `retry:true, delay:0` | 다음 attempt가 B providerID. 중복 실행 없음 | `inTurnFailover` 꺼 둠 |
| AC-P18 | codex body 필드(T15, 선택) | `prompt_cache_retention` 등 | 400이면 영구 금지로 기록 | – |
| AC-P19 | MCP 전후 tool hash(T16) | 연결·해제 | 같거나, 다르면 규칙 추가 | D 규칙 추가 |
| AC-P20 | 단일 refresher | 만료 직전에 두 Location과 두 프로세스가 동시 요청 | refresh HTTP 1회. 나머지는 새 토큰을 읽음. `refresh_token_reused` 0 | 락 보강 |
| AC-P21 | vault | `own-vault.exe` helper: get/put/delete/list, `put{keepPrev}` 중 강제 종료 후 복구, helper 재시작, 01과 같은 entropy·파일 이름으로 쓴 blob 교차 읽기. 비밀 캐시 적중률(요청 100개 중 helper 호출 수) | 복호화 성공. 비밀이 argv·로그·env에 없음. `.prev`로 복구. hot path helper 호출은 캐시 미스(첫 요청, TTL 만료, refresh 직후)에서만 | helper 수정. 01 §13.1 대안 재검토 |
| AC-P22 | ChatGPT 로그인 | device와 browser 흐름. claim 추출(email, plan, sub). 다른 계정으로 재인증 시도 | 로그인 성공. 다른 계정은 거부 | claim 경로 수정 |
| AC-P23 | claude-auth 격리 | 구독이 활성인 상태에서 `own-anth-*` 요청 | `x-api-key`만 있음(Bearer 없음). "You are Claude Code" system 없음. `session.usage` cost > 0. 플러그인 순서 경고 동작 | I 규칙 보강 |
| AC-P24 | Claude 슬롯 | 플러그인 없음 → `anthropic` 비활성. 설치 후 동의 전 → 비활성. 동의 → 활성. 이 변화를 **프로젝트 두 개를 연 상태**에서 확인(ack 전파). `plugin.updated` 뒤 감지. 연결 유형 표시. 성공 응답 unified 헤더 캡처. rejected에서 `retry:false`. `x-should-retry` 유무 | 전부 확인. 두 번째 Location도 재시작 없이 활성·비활성이 바뀜 | 8장 수정 |
| AC-P25 | 템플릿 고정 | models.dev refresh를 강제 | identity·system hash 불변 | 템플릿 로직 수정 |
| AC-P26 | admission 전환(= 01 G8b) | (a) idle 세션에서 보류 전환 상태로 prompt 전송(hook 안 `switchModel`을 켠 테스트 빌드). (b) **busy 세션 + 기본 `delivery:"steer"`** 로 보류 전환 중 메시지 전송. (c) (b)를 `delivery:"queue"`로. (d) 턴 종료 직후 큐 메시지와 전환의 순서. (e) model 없는 세션이 첫 `prompt` hook에서 고정됨 | (a) 새 턴 첫 step이 B. 교착 0, step 중복 0. (b)(c) **실행 중인 턴의 어느 step도 새 providerID를 갖지 않음**, 메시지는 다음 턴에서 B로 실행. (d) 큐 메시지의 첫 step이 B. (e) 첫 step 전에 고정됨 | 통과 전(기본)에는 hook 안 `switchModel`과 고정을 끄고 방법 1·3과 queue 변환만 쓴다(5.3). (a)(e) 실패 시 이 상태 유지. (d) 실패 시 own-web 클라이언트 보류(5.3) |
| AC-P27 | 외부 전환 감지 | TUI에서 `POST /model` | `binding.changed{external:true}` | – |
| AC-P28 | 한도 보정 | 실제 사용 1주 | 표본과 R² 기록. codex used% 해상도 확인 | 범위 표시 유지 |
| AC-P29 | 잔액·키 조회 | DeepSeek balance, OpenRouter key·credits 파싱 | 정상 파싱 | 수동 입력 |
| AC-P30 | 런타임 재조정 | 서버를 재시작하지 않고 계정 추가·제거. 프로젝트 두 개를 연 상태 | 모든 Location에서 `provider.reload`만으로 반영(새 slot 보임, retired 모델 비활성). hook은 재등록하지 않으며, setup에서 등록한 hook(요청 변형과 읽기 전용 관측)이 새 slot 요청에 적용됨 | provider가 안 바뀌면 재시작 안내(3.8) |
| AC-P31 | OpenRouter Claude hint | 수동 hint가 있을 때와 없을 때 | hint가 있을 때 `cache.read > 0` | 문서화 |
| AC-P32 | fork와 새 세션 흐름 | 5.9(e)(f) | 원 세션 A 캐시 유지. seed 세션 첫 cold ≤ 25k | – |
| AC-P33 | Anthropic 같은 workspace 풀링 | 키 A에서 thinking signature를 만들고 키 B로 재생 | 400 없음. hit ≥ 90% | 풀링 금지 |
| AC-P34 | codex 같은 workspace seat | 캐시 공유와 encrypted item 재생 | 기록만(약관상 자동 회전 안 함) | – |
| AC-P35 | OpenAI 같은 org 풀링 | `encrypted_content`를 다른 키로 재생 | 오류 0, hit ≥ 90% | 풀링 금지 |
| AC-P36 | stateless generate | 기본 모델을 own slot으로 두고 `ctx.generate.text`(테스트 플러그인)와 `POST /api/experimental/generate` 호출. 모델을 지정한 경우도 | 결과(401 예상)를 기록. selfTest가 `default_model_own_slot`을 냄. own-web 코드에 own 모델로 experimental generate를 부르는 곳이 없음 | P-007 재검토 근거로 기록 |
| AC-P37 | RPC 오류 계약 | own-web 계약 테스트: 메서드마다 대표 오류 하나(`estimate_expired`, `nonce_invalid`, `policy_denied` 등)를 일으킴. 핸들러 안 예외를 일부러 던지는 테스트 빌드도 | 선언한 오류는 HTTP 400 + 기대 type. 던진 예외는 `internal_error`(400)로 바뀌고 500 `rpc.internal`은 0건 | 9.4 규칙 보강 |
| AC-P38 | 템플릿 캡처 | (a) claude-auth 설치·동의 상태에서 anth 계정 추가, (b) 오프라인 첫 실행(models.dev 없음)에서 계정 추가, (c) `hideBuiltinProviders`로 숨긴 kind의 계정 추가 | (a) 템플릿 모델의 `cost`가 비어 있지 않음. (b) `source:"bundled"`로 추가됨. (c) 스냅샷에서 모델을 얻음 | 3.6a 수정 |
| AC-P39 | Codex 가져오기(3.2a) | e2e-kit 가짜 control-center(`fixtures/codex-multi-provider.ts`)와 가짜 Codex backend(`fakes/codex.ts`). (a) linked 가져오기 → 요청의 인증 hash가 원본 토큰과 같음. (b) 원본을 새 토큰으로 바꿈 → 다음 요청이 새 토큰. (c) 가짜 backend가 401 → stale, `codex_source_stale`, 원본 갱신 뒤 저절로 풀림. (d) 원본에 다른 지문의 로그인 → 거부. (e) takeover → execute 직후 `POST /oauth/token` 1회, 이후 우리가 refresh, 원본 파일 hash 불변. (f) plan과 execute 사이에 원본이 바뀜 → execute가 새 값을 씀. (g) 실제 이전 앱 토큰으로 takeover 첫 refresh가 성공하는지(수동, 값은 기록하지 않고 성공/실패만. 소스로는 client id가 같음을 확인함, 3.2a). (h) access token 수명(수동). (i) **takeover 뒤 옛 refresh token 재사용**: 우리 회전 뒤 원본 파일의 옛 refresh token으로 token endpoint를 한 번 부른다. 가짜 backend는 '재사용만 거절'과 '계열 전체 폐기' 두 동작으로 각각 돌리고, 실제 계정은 수동으로 한 번(이전 앱에서 그 프로필을 여는 것과 같음) | (a)–(f) 모두 통과. 원본 파일은 모든 단계에서 바이트가 같음. 토큰 값이 로그·ledger·RPC 출력에 없음. (i) 가짜 backend 두 동작에서 우리 상태가 각각 `ready` 유지 / `needs_reauth`로 알림. 실제 서버의 결과(우리 계열이 살아남는지)를 기록 | (g) 실패 시 takeover를 막고 linked만 연다. (i)에서 실제 서버가 계열을 폐기하면 이전 앱을 쓰는 동안 linked만 권한다(3.2a) |
| AC-P40 | 자동 압축 기준(4.7) | ds·compat 가짜 slot에서 kind 기본값, 계정 값, 세션 값을 차례로 두고 세션을 기준 너머로 키움. 설정을 바꾼 뒤 재시작 없이 다음 step. `dryRun` 결과. 세션 값은 클라이언트 둘이 같은 `compaction.due`를 받음. 이미 압축한 세션을 작은 창 slot으로 `now` 전환(테스트용 강제)해 첫 요청과 둘째 요청을 봄. overflow를 일으키는 가짜 서버 | `compaction.started{reason:"auto"}`가 `P ≈ T_slot`(±5%)에서 일어남. 요약 요청 크기 ≤ `T_slot`. prefix hash가 설정 변경 전후로 같음. 세션 값은 `compaction.due` → 압축 1회(중복 없음. 대기 중 재전송은 같은 항목, 전달 뒤 재전송은 409, 4.7.1). 작은 창 전환 뒤 첫 요청은 압축 없이 나가고(4.7.5) 그 압축은 `compaction_threshold_mismatch` 비교에서 빠짐. overflow 복구 압축도 빠짐(7.7) | 기준 식 재확인, P-014 검토 |
| AC-P41 | 플러그인이 이벤트로 못 받는 사용량과 압축 사용량(7.5) | own slot 세션에서 `POST /api/session/:id/generate`, core warming 켬(짧은 간격), 새 세션의 첫 턴(title 생성), 수동·자동 압축, 실패하는 압축(가짜 서버 5xx). Anthropic·Responses·Chat 세 프로토콜 가짜 서버. 같은 세션에서 /btw generate와 warming ping을 동시에 | ledger에 `kind:"generate"`와 `kind:"title"`, `usageSource:"stream"` 줄이 요청마다 하나. tokens가 가짜 서버가 보낸 usage와 같음. warming 줄은 `purpose:"warming"`. 동시 generate 두 줄이 섞이지 않음(짝 찾기 없음). `kind:"compaction"` 줄이 `compaction.ended/failed`마다 하나이고 tokens·cost가 이벤트 값과 같음. `session.usage.recorded`를 구독하지 않음(코드 검사) | 프로토콜별 파서 보강. 안 되면 `usageSource:"estimate"` |
| AC-P42 | 도구 집합(4.3 D10, 05 §8.7) | (a) 데스크톱에서 만든 세션을 셸 종료 뒤 웹 폴백으로, 두 클라이언트 동시 연결로 이어 감. (b) 웹에서 만든 세션(브라우저 deny 새김)을 데스크톱에서 열고 `이 세션에서 켜기`(PATCH). (c) 승인 모드를 `read-only` → `ask` → `full`로 바꿈(`session.approval.set`). (d) Code Mode MCP 서버 연결·해제 | (a) 도구 정의 hash와 system hash가 같음, `session.instructions.updated` 0건, `toolset_changed` 0건. (b) 도구 정의·system hash는 그대로이고 `session.instructions.updated`(text 있음)가 정확히 1건 덧붙음. 다음 요청의 `cache.read ≥ 0.9 × 직전 L`(앞 prefix 유지 ⚠ 01 G4 방식으로 잼). `toolset_changed` 0건. (c) 세 모드 모두 도구 정의 hash 불변. (d) delta 1건씩 | D10 판단 재검토(카탈로그가 앞으로 옮겨졌는지) |
| AC-P43 | 원격 기기 범위(9.1) | 05 게이트웨이 테스트 빌드에서 `read`, `read+switch`, `read+switch+prompt`, `admin` 기기 토큰으로 49개 메서드를 모두 부름. `switch`만 있는 기기에서 `compact-then-switch` 선택 | 범위 밖 메서드는 게이트웨이에서 거절, `local` 메서드는 원격에서 0건 성공. `switch.estimate`는 `read`만 있는 기기에서 거절. `MethodScope`에 빠진 메서드가 없음(타입 검사). `prompt`가 없는 기기의 own-web은 `clientAction`이 필요한 전략을 보이지 않음 | 범위표 수정(05와) |
| AC-P44 | 자식 세션 계정(5.11) | 가짜 LLM이 subagent 도구를 부름. (a) `model`에 다른 구독 slot(`own-codex-<다른>`) → (b) `openai/gpt-5.5`(D9 identity 값) → (c) `ready`인 종량제 slot(`own-ds-*`) → (d) `anthropic/…`. (e) 부모가 A hard 소진으로 B로 전환(`childPolicy:follow`) 뒤 같은 자식을 `sessionID`로 이어 부름, 그리고 idle 자식. (f) 부모 수동 전환(`keep`) 뒤 이어 부름 | (a)(d) `model`이 지워지고 자식 첫 step이 부모 slot, `subagent_model_overridden` 1건. (b) 부모 slot으로 바뀜. (c) 그대로 둠, 자식 step이 `own-ds-*`. (e) 이어 부른 자식의 첫 step이 B, idle 자식은 전환 직후 B. (f) 자식은 A 유지. 어느 경우도 hook이 throw하지 않음 | 5.11 규칙 수정. hook으로 안 되면 자식 전환 제안만(5.9(g)) |
| AC-P45 | revert와 압축(4.7.4) | 세션 값을 두고 문맥을 키운 뒤 복원을 stage. 그 상태에서 step을 더 돌림(가짜), `switch.estimate`로 압축 전략을 봄, 다른 클라이언트가 옛 `pendingDue`로 압축을 시도(클라이언트 규칙 준수 빌드와 규칙을 끈 빌드). 이어서 복원 확정(commit), 경계가 마지막 압축 checkpoint보다 앞인 경우도 | staged 동안 `compaction.due` 0건, `pendingDue:null`, 압축 전략 `available:false, reason:"revert_staged"`, `switch.apply`는 `revert_staged`. 규칙 준수 클라이언트는 `POST /compact`를 보내지 않음(규칙을 끈 빌드는 revert가 commit되는 것을 기록해 위험을 보임). commit 뒤 `sess:<sid>:epoch`가 1 오르고 `cache.state`의 모든 slot `W^lo = 0` | 4.7.4 규칙 보강 |

---

## 12. 미확인/열린 질문

번호는 다른 문서가 참조하므로(예: 01의 "02 Q10", 03의 "12장 Q13") 바꾸지 않는다. v0.3의 새 항목은 19번부터, v0.4의 새 항목은 40번부터 붙였고, 주제별 묶음 안에 넣었다. 해결된 항목은 번호를 남기고 "(해결됨)"으로 표시한다.

**측정으로 확정할 것**
1. **codex 캐시 성질(가장 큼)**: 범위(계정·seat), TTL, lookback 모두 문서가 없다. 초기값은 TTL_lo 5분이고 TTL_hi는 알 수 없음(유휴 예약은 60분, 불확실)이다(AC-P05·P06·P08).
2. **구독 한도에서 cached 토큰의 가중치.** 공개된 것이 없다. 보정 전에는 %를 범위로만 보여 준다(6.3 ⑪, 7.6).
3. **`prompt` hook 안 `switchModel`의 교착·step 중복, 그리고 queue 변환과 턴 종료 직후 전환의 순서**(AC-P26 (a)(d), 01 G8b). 통과 전에는 hook 안 `switchModel`을 끄고 방법 1·3만 쓴다. (d)에 경합이 있으면 own-web 클라이언트 보류로 바꾼다(5.3).
4. **retry hook의 `switchModel`이 다음 attempt에 반영되는지**(AC-P17b, Phase 3).
5. **`own-vault.exe` helper 동작과 비밀 캐시 적중률**(AC-P21). 01 §13.1의 결정을 따른다. `bun:ffi`·PowerShell 경로는 버렸다.
6. **API 키 연결 테스트 endpoint와 응답 헤더 이름**: `openai-organization`, Anthropic organization/workspace, DeepSeek balance, xAI api-key, OpenRouter key.
7. **Anthropic 1h hint가 기존 5m 항목을 "승격"하는지, 다시 쓰는지**(비용 범위, AC-P16, Phase 3).
8. **WS `codex.rate_limits` 프레임이 매 턴 오는지**(AC-P15). 오지 않으면 codex 기본 transport를 http로 바꾼다(7.1). 확인함(2026-10-18): 응답마다 온다. `wham/usage`는 요청 경로가 비워 둔 계정만 묻는다(7.1).
9. **D9 identity 정규화가 모델 품질에 영향이 없는지.** 모델이 보는 provider 이름이 `own-…` 대신 `openai` 등이 된다. G17 품질 A/B에서 함께 본다. D9가 하위 에이전트의 모델 선택을 헷갈리게 하는 문제는 5.11 2번이 막는다.
10. (해결됨, v0.4) **subagent 세션의 모델.** 소스로 답했다(5.11). 새 자식은 `override ?? agent.model ?? parent.model`(`core/src/tool/plugin/subagent.ts:184`)이고 `override`는 LLM이 고른다. `models` 도구가 다른 계정 slot도 보인다(`core/src/tool/plugin/opencode.ts:134-165`). 이어 부르는 자식은 override나 agent 변경 때만 모델이 바뀐다(`subagent.ts:168-181`). 구멍 두 개(다른 계정 라우팅, 부모 전환 뒤 자식이 옛 계정에 남음)는 `execute.before` hook과 `childPolicy`로 막는다. 남은 확인: own-accounts의 hook이 subagent 자신의 hook(내장 pre) 뒤에 도는지, `agent.model`이 내장 provider를 가리키는 설정은 selfTest 경고뿐인 것으로 충분한지(AC-P44).
11. **xAI, OpenRouter, compat의 캐시 도메인과 TTL.** 문서가 없어 키 단위, 0 TTL로 보수적으로 가정했다.
19. **이전 앱 토큰의 client id와 access token 수명**(AC-P39 (g)(h)).
   - (g) (해결됨, v0.4) client id는 소스로 같다: 이전 앱 런타임 `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`(`D:\#Projects\codex-multi-provider\runtime\codex-rs\login\src\auth\manager.rs:1708`). 바꾸는 env `CODEX_APP_SERVER_LOGIN_CLIENT_ID`(`manager.rs:201,1710-1714`)는 테스트에서만 설정된다. AC-P39 (g)는 실제 프로필로 한 번 하는 점검으로 남긴다.
   - (h) **access token 수명**은 아직 모른다. linked 계정이 이전 앱 없이 얼마나 버티는지를 정한다.
20. **takeover → linked 되돌리기의 vault shred**, **takeover 직후 강제 refresh**, **client 불일치 때의 되돌리기**가 own-accounts 핸들러에 구현되는지(3.2a 3·4번). runtime `takeover()`는 복사만 한다(`credentials.ts:289-318`).
21. **linked 계정의 원격 lease**: 우리가 refresh할 수 없으므로 04 §8.5의 "먼저 refresh" 대신 lease를 거절하는 규칙(3.2a)이 04와 맞는지.
22. (해결됨, v0.4) **`POST /compact`에 같은 `id`를 두 번 보낼 때.** `admitCompaction`(`core/src/session/inbox.ts:204-224`): 그 id가 대기 중이면 같은 항목을 돌려준다(멱등). 다른 압축이 대기 중이면 id와 상관없이 합쳐진다. 이미 전달돼 메시지가 됐으면 `LifecycleConflict` → 409 `CompactionConflictError`(`core/src/session/session.ts:254-259`). 클라이언트는 409를 무시한다. 어느 경우든 staged revert는 입장 전에 commit된다(`session.ts:251`). 그래서 4.7.4 "revert" 규칙을 더했다.
23. **provider reload가 실행 중인 세션의 다음 step에 새 `limit.input`을 반영하는지**(AC-P40, AC-P30과 함께). 반영되지 않으면 기준 변경은 다음 턴부터라고 UI에 적는다.
24. **generate·title 응답 SSE의 usage 필드**: 세 프로토콜 모두에서 마지막 usage를 사본으로 읽을 수 있는지(Chat 계열이 스트림 usage를 보내는지 포함, AC-P41).
25. (해결됨, v0.4) **`-opencode.browser`가 내장 pre 플러그인에도 먹히는지.** 먹힌다. remove 연산은 guarded가 아닌 모든 플러그인에 적용되고(`core/src/plugin/supervisor.ts:39-44`), guarded 목록은 `OpencodePlugin`과 `ConfigPolicyPlugin` 둘뿐이다(`core/src/plugin/internal.ts:271`). 다만 02의 규칙은 세션 생성 때 새김(05 §8.7 안 D)이고, 이 문법을 웹 전용 설치 보강으로 쓸지는 01이 정한다(4.3 D10, Q16).
26. (해결됨, v0.4) **등록 모델의 작은 `limit.input`이 upstream UI·TUI에서 보이는지.** 보이지 않는다. TUI, upstream app, ACP는 모두 `limit.context`로 문맥 비율과 크기를 낸다(`tui/src/util/session.ts:71`, `app/src/session/timeline/session-context-usage.tsx:80`, `cli/src/acp/service.ts:573-580`). 문제는 없고, 낮춘 기준이 거기에 표시되지 않을 뿐이다(4.7.2).
40. **linked 원본 확인을 요청 경로 밖으로 옮길지**(3.2a, 9.1 성능 계약). 지금 구현은 계정마다 비동기 `fs.stat` 최대 1초에 한 번과 변경 때 재읽기를 요청 경로 안에서 한다. D4 성능 게이트에서 문제로 재어지면 leader 백그라운드 갱신기로 옮긴다.
42. **`session.moved` 뒤의 인계**(5.4): 옛 location 인스턴스가 그 세션에 `switchModel`·`wait`를 할 수 있는지, 새 location 인스턴스가 아직 없을 때 `own-runtime`이 들고 있는 상태를 언제 넘길지. core는 location이 다르면 실행을 중단한다(`core/src/session/context.ts:121-123`).
43. **overflow 복구 압축 판정의 정확도**(7.7): 직전 응답 캡처와 core overflow 판정에 기댄다. WS 경로나 문구가 다른 서버에서 놓칠 수 있다(AC-P40).
44. **auth.openai.com이 refresh token 재사용에 계열 전체를 폐기하는지**(3.2a "takeover 뒤 이전 앱 재사용 위험", AC-P39 (i)). 폐기하면 이전 앱을 쓰는 동안에는 linked만 권한다.
45. **Code Mode 카탈로그 delta 뒤 앞 prefix의 캐시가 실제로 유지되는지**(4.3 D10, AC-P42 (b), 01 G4 방식). 소스로는 delta가 대화 뒤에 덧붙지만, provider 캐시 적중은 측정으로 확인한다.

47. **siwc 사용량이 codex seat의 5h·주간 창과 합산되는지**(3.2c). 합산된다면 quota domain을 `chatgpt_seat`로 묶어 소진이 서로 전파되게 한다. 실제 계정 캡처가 필요하다.
    - 2026-10-10 조사: OpenAI 문서(developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)는 Plus의 5시간 한도가 ChatGPT 요금제를 쓰는 모든 앱에 공유되고 앱마다 따로 주지 않는다고, Pro에는 5시간 한도가 없다고, 앱별 상한은 ChatGPT 설정 > 사용량에서 정한다고만 말한다. Codex가 그 "앱"에 드는지, 주간 창이 같은 풀인지는 말하지 않는다.
    - 그래서 codex 계정의 창을 같은 로그인의 siwc 계정에 옮겨 보이지 않는다. 앱별 상한이 있으면 codex 창이 siwc의 남은 양을 말하지 못하고, 같은 로그인으로 짝짓기도 실제로는 안 된다: 실사용 siwc 계정 3개의 ID token에 `chatgpt_account_id`와 plan claim이 없어 `identity.login`이 없다(`Jwt.sharing`은 `chatgpt_account_id` 없이는 login을 만들지 않는다). siwc 응답이 요금제 헤더를 실어 오면(48) 그 계정의 창은 그 자체로 보인다.
48. **siwc 요청에 오는 한도 헤더**(`x-ratelimit-*`, `x-codex-*`, 없음)와 `usage_limit_exceeded`의 리셋 힌트. 2026-10-10부터 `x-codex-*` 제품군과 `x-ratelimit-*`를 모두 읽는다(7.1). 확인된 것: 실제 응답에 쓸 수 있는 `x-ratelimit-*` 쌍은 없다(primary 97개, 창 0개). 확인되지 않은 것: `x-codex-*`가 오는지, 스트림에 한도 이벤트가 있는지. 공식 문서(models-and-inference, errors-and-recovery)는 응답 헤더를 말하지 않고, 사용량 한도는 429 `subscription_sharing_usage_limit_exceeded` 또는 스트림 중 `response.failed`로 온다고만 한다. 사용자가 `bun own/scripts/siwc-limits-check.ts`를 한 번 돌려 결과를 여기에 적는다. 아무 한도 헤더도 없으면 siwc 카드는 계속 `확인 중`과 `사용량 관리` 링크만 보이고, 파서를 실제 이름으로 고친다.
    - 2026-10-22(SW): 대부분 답했다. 사용자 설치(2.0.28-own.6)에서 2026-10-10~22의 siwc 응답이 `x-codex-*`도 `x-ratelimit-*`도 싣지 않았다. 그 응답들을 같은 hook의 속도 판정이 읽었는데 `state\limits.json`에 siwc 창이 하나도 없다. 스트림 본문도 한도를 싣지 않을 것이다: Codex 백엔드의 HTTP SSE에는 한도 이벤트가 없고(2026-10-22 실측: created, in_progress, output 항목, delta, `response.metadata`, completed), Codex도 HTTP에서는 헤더만 읽는다(`codex-api/src/sse/responses.rs`). 그래서 카드 문구를 `own.lim.sharingUnreported`(아직 받은 한도 정보 없음 · 이 방식은 알려 주지 않는 것으로 보임 · ChatGPT 설정 > 사용량)로 바꿨다(3.2c). 단정하지 않는다: 성공 응답의 실제 헤더를 직접 본 사람은 아직 없다. 남은 것: 헤더 이름 목록과 429 본문의 모양. 다음 실행부터 로그 `limits_absent`(성공 응답의 헤더 이름)와 `usage_limit_answer`(429의 헤더·본문 필드 이름, 리셋 유무)가 계정·인스턴스마다 한 번 남으므로(7.2 로그) 사용자가 스크립트를 돌리지 않아도 알 수 있다. 다른 이름의 한도 헤더가 보이면 파서를 고친다. 429 본문이 `resets_at`·`resets_in_seconds`를 실어 오면 이미 `siwc.usage` 창과 배너의 리셋으로 보인다(3.2c).
49. **토큰 공유 route가 받는 요청 모양**: 네임스페이스 없는 최상위 function 도구, `-fast`의 `service_tier:"priority"`, `include:["reasoning.encrypted_content"]`. 거절되면 `unsupported_capability`로 멈추므로(3.2c) 보이지만, 실제 Plus·Pro 계정으로 한 번 확인한다. 2026-10-10 실계정 오류가 받는 입력 항목 목록을 직접 알려 줬고 `configuration_update`는 거절됨이 확인됐다(3.2c "입력 항목", own은 effort marker를 뺀다). 아직 거절 증거가 없는 것: 도구 결과(`function_call_output`) 안의 `input_image`·`input_file`(computer use 스크린샷, 이미지 읽기), namespace가 붙은 function 호출(`computer`·`team` 도구), 다른 provider에서 온 hosted tool 기록. 거절이 보이면 `sharing_unsupported_input` 경보의 `param`과 증거 수집(7.8)으로 그 항목을 찾아 3.2c의 처리를 넓힌다.
50. **`agent_name_hint` 값**("Own OpenCode")과 ID token claim(`chatgpt_account_id`, `chatgpt_plan_type`가 오는지). 실제 로그인으로 확인한다.
51. **`earliest_refresh_at`의 형식과 값**(epoch 초 숫자인지 ISO 문자열인지, 만료 몇 분 전인지)과 그 전의 refresh를 issuer가 거절하는지. 값이 만료 1분 안쪽이면 그 사이 원격 lease가 끊긴다(3.2c). 실제 토큰 응답으로 확인한다.
52. **siwc 모델의 실제 context window**(API 카탈로그의 1.05M인지 요금제 창인지). 2026-10-08부터 upstream(209346a0fe)처럼 살아 있는 API 카탈로그 창을 쓰고 계정 카탈로그의 `context_window`로 낮추지 않는다(3.2c, R8). 요금제가 더 작은 창에서 거절하면 그 오류가 core의 overflow 분류에 맞아 복구 압축이 도는지 실계정으로 확인한다.
53. **`prompt=consent`가 scope 동의를 다시 묻는지**(3.2c). `동의 후 다시 시도`가 이 값을 보내지만 실제로 동의 화면이 다시 나오는지 확인한 적이 없다. 업스트림 `chatgpt.ts`에는 `force_reconsent`가 주석으로만 있다. 실제 계정으로 확인하고, 안 되면 파라미터나 안내 문구를 바꾼다.
55. **siwc refresh token 하나를 revoke하면 issuer가 같은 사용자 + client grant 전체를 끝내는지**(3.2c). 끝내지 않으면 재로그인이 대체한 family를 쓰기 성공 뒤 revoke한다(지금은 `.prev`에 둔다). 끝낸다면 지금 revoke하는 경로 가운데 재로그인 시도의 버린 응답(같은 사용자의 `identity_missing`, scope 없음, 시도가 끝난 뒤 도착한 토큰)도 저장된 계정의 토큰을 함께 끝내므로 그 revoke도 다시 본다. 실제 계정으로 재로그인 뒤 refresh를 확인한다. 44와 같은 종류의 issuer 동작이다.

**사용자 결정**
12. **구독 → 종량제 자동 전환.** 01 §8.6에 맞춰 `ask|off`만 두었다. 사용자가 원하면 opt-in `auto`(경고 뒤 저장)를 다시 열 수 있다. 구독끼리 자동 전환은 약관 위험 때문에 열지 않는다(03 "미확인/열린 질문" 1번도 이 결정으로 닫는다).
27. **OpenAI API(`oai`)의 압축 기본값.** D6에 없어 v2 기본(core ceiling, gpt-5.5면 약 830k)으로 두었다. codex처럼 272k 근처로 상한을 둘지 정한다(4.7.3).
28. **Claude API(`anth`) 1M 창의 v2 기본(900k).** 사용자 결정대로 v2로 두었지만 cold 한 번이 약 $4.5(Opus 5.5 write 5.00/1M 기준)다. 계정 기본 상한을 제안할지 정한다(6.3 ⑫로 비교해 보여 줌).
29. **"keep을 작게"**(4.7.6). 두 길 중 하나를 사용자가 고른다.
   - (가) 전역 keep: own 전역 설정 `compaction.keep.tokens`를 바꾼다(`core/src/config/plugin/compaction.ts:21`). 코어 패치가 없다. Codex·Claude를 포함한 **모든 kind**에 적용되고, `T_floor`를 설정된 K로 다시 계산한다. 03 §5.8.4의 "최근 원문 유지" 칸이 이 방식이다.
   - (나) kind별 keep: P-014(제안)를 열어야 한다.
   - 고르기 전 기본은 15k 그대로이고, 03의 keep 칸은 읽기 전용으로 둔다.
30. **ledger `purpose`의 세분화**: 지금은 `warming`만 알아본다. /btw와 인계 요약을 나누려면 own-web이 generate 직전에 목적을 알리는 방법(예: 짧은 RPC)이 필요하다. 필요한지 정한다(7.5).
31. **(해결, 2026-10-08) 세션 압축 기준은 "앱이 열려 있을 때만" 적용됐다**(4.7.4). upstream이 플러그인 session domain에 `compact`를 열어(924c12b291, P-008이 바라던 것) own-accounts가 서버에서 `ctx.session.compact`로 넣는다(4.7.2 "서버에서 압축 넣기"). 그래서 세션 값과 compact-then-switch·switch-then-compact(5.9(b)(c))가 클라이언트 없이 끝나고 `compaction.due` 이벤트는 알림으로만 남는다. loopback 안(4.7.2 (d))은 쓰지 않는다. 남은 것: 05 §13.5 범위표(압축이 `switch` 범위로 일어남)와 03의 "앱이 열려 있을 때만" 표시, own-web의 전략 숨김.
46. **자식 세션 규칙의 기본값**(5.11). LLM이 고른 다른 종량제 계정은 허용하고, 다른 구독 계정·Claude 슬롯은 지운다. 그래서 사용자가 대화로 명시한 "다른 ChatGPT 계정으로 하위 작업"도 지워진다. 이 경우를 수동 전환처럼 확인 대화상자로 열지 정한다. `childPolicy` 기본(T-HARD·T-AUTH면 `follow`, T-MANUAL이면 `keep`)도 확인한다.
54. **siwc 토큰을 SSH 원격 호스트에 빌려주는 것**(3.2c, 04 §8.5)이 토큰 공유 약관에 맞는지. 지금은 codex처럼 lease를 준다. 맞지 않거나 분명하지 않으면 siwc lease를 opt-in 설정 뒤로 옮긴다.

**03-ui-ux.md에 반영해야 할 것**(이 문서의 소유 범위 밖이라 여기서는 고치지 않았다. 03 담당이 반영한다)
13. 03과 프로토타입 변경 목록
   - **Codex cold-point**: 이 문서는 TTL 상한을 모르는 소스(codex)에도 `trigger:"either"`와 60분 유휴(`uncertain:true`)를 허용한다(5.4, 5.9(d)). 03 §6.3 표는 이 경우를 `trigger:"compaction"`만으로 제한하고 `deadlineMinutes:30`을 고정한다. 어느 쪽으로 맞출지 03 담당과 정한다. deadline 기본은 `max(30, 2×idleMinutes)`다.
   - **전환 대화상자 선택지**: 03 §6.3의 네 선택지는 `display:"primary"`와 같다. `fork`는 `display:"secondary"`이므로 03 대화상자에 "더 보기 → 곁가지 포크"를 더한다(6.5).
   - **1h 모드 토글**: 03 §5.6 토글은 `cache.setTtlMode`를 부른다. Phase 3이므로 MVP에서는 "예정"으로 비활성 표시한다(4.5).
   - **Claude 슬롯**: 합성 계정 `acc_claude_slot`(9.2)을 계정 카드·칩·한도 막대의 id로 쓴다. 제거 흐름(`plugin.claudeAuth.uninstall.*`)과 확인 문구, `anthropic` 세션의 "플러그인 없음" 배너, Claude 계정 `⋯` 메뉴의 "계정 소스 변경"(재시작 경고 포함)을 03 §5.4·§5.7에 더한다.
   - **파괴적 동작**: 계정 제거와 플러그인 설치·제거는 `plan` 결과를 보여 주는 확인 대화상자를 거친다(9.2).
   - **데이터 필드**: 03이 쓰는 `lastUsedAt`, `accounts.usage{groupBy:"hour"}`, 세션 행의 `projectID`·`switchCount`, `policy.defaults`, `policy.awayDetect`, KV `confirmOverride`를 이 문서에 추가했다. 03 쪽 데이터 출처 표(부록 A)에 반영한다.
   - **기타 OpenAI 호환 카드**: `compat` kind로 정의했다(2.2, 3.3). 03 카드와 필드(Base URL, 모델 id, 컨텍스트, 요율)를 이에 맞춘다.
   - RPC 메서드·이벤트 목록은 이 문서 9장이 기준이다. 03 §16.3이 이 목록을 쓰는지 확인할 것: `health`, `switch.state/undo/waitReset/setConfirmOverride`, `switch.estimate.variantOnly`, `cache.setTtlMode`, `accounts.remove.plan/execute`, `accounts.update{pollBalance}`, `plugin.claudeAuth.{install,uninstall,changeSource}.plan/execute`(`install.plan{}`은 입력 없음), `plugin.trust.list/approve.plan/approve.execute/revoke`, `policy.*`, `ratecards.*`, `diagnostics.selfTest`, 이벤트 `accounts.changed`, `switch.suggested`, `ledger.step`, `alert`, `plugin.trust.changed`.
   - **프로젝트 플러그인 승인 화면**: 03 Phase 2의 승인 화면은 `plugin.trust.list` → `plugin.trust.approve.plan` → 확인 대화상자 → `approve.execute`를 쓴다(9.2). Location 상태 `blocked_by_plugin`과 경보 `untrusted_plugin`을 표시한다.
   - **(v0.3) Codex 가져오기 화면**: 계정 추가 화면에 "이전 앱에서 가져오기"(`accounts.import.codex.list`가 `available:true`일 때만) → 프로필 목록(`problem`이면 흐리게, `importedAs`면 "가져옴" 표시) → 모드 선택(linked 기본, takeover는 경고) → `plan` 확인 대화상자 → `execute`. 계정 카드의 연결 표시(`codex-linked`/`codex-takeover`, `superseded`), stale 배너와 `[가져오기로 전환]`, 입력창 사전 배너(3.2a UI 힌트).
   - **(v0.4) takeover 경고 문구**: takeover 확인 대화상자와 `takeover_supersedes_source` 경고에 "takeover 뒤에는 이전 앱에서 이 프로필을 열지 마세요. 열면 이 앱의 로그인도 끊길 수 있습니다"를 넣는다(3.2a).
   - **(v0.3) 자동 압축 설정 화면**: 찾기 쉬운 위치 두 곳. (1) 설정 > 계정 & 한도 > 각 계정 `⋯` > "자동 압축 기준"(계정, 모델별), 설정 > 자동 압축(kind 기본값, `policy.get.compactionDefaults`와 `policy.compaction`), (2) 세션의 문맥 막대 클릭 → "이 세션만 더 일찍"(`compaction.setSession`, "앱이 열려 있을 때만" 표시). 값의 출처(`source`) 표시, v2 기본과 ⑫ 비용 비교, `dryRun`의 `truncates` 경고와 "먼저 압축한 뒤 적용"(4.7.5).
   - **(v0.4) 자동 압축 설정 화면 추가**: 기본값 재설정 버튼에 "되돌리기"·"복원"을 쓰지 않는다(03 §18.7 라벨 규칙, 9.2 `compactionDefaults`). "최근 원문 유지"(keep) 칸은 Q29 결정 전 읽기 전용이고, 결정이 (가)면 `policy.set{compaction.keepTokens}`를 쓴다(4.7.6). 전역 "자동 압축" 끄기는 overflow 복구도 끈다는 경고를 붙이거나 칸을 두지 않는다(4.7.6). 03 §5.8.2의 요청 이름(`compaction.effective`, `compaction.settings.*`, `compaction.session.set`, `compaction.changed`)은 이 문서의 이름(`accounts.list`의 `compaction`, `policy.*`, `compaction.setSession`, `cache.state`·`accounts.changed`)으로 맞춘다.
   - **(v0.3) 문맥 막대**: 분모는 `cache.state.compaction.windowTokens`, 기준 표시는 `triggerTokens`다(03 §4의 "자동 압축은 약 245k에서" 문구의 값). 등록 모델의 `limit.input`을 쓰지 않는다. 모델 전환기의 "전환 직후 자동 압축될 수 있음"은 `switch.estimate.target.compactAt`과 경고 `target_compacts_soon`·`compaction_may_truncate`를 쓴다.
   - **(v0.4) 압축 요청과 revert**: own-web이 자동으로 보내는 모든 `POST /compact`(`compaction.due`, `pendingDue`, 옛 `clientAction` compact, "먼저 압축한 뒤 적용". 앞의 셋은 2026-10-08부터 서버가 먼저 넣는다)는 직전에 `GET /api/session/:id`의 `revert`를 확인한다. 사용자가 누르는 수동 압축은 staged revert가 있으면 "복원이 확정됩니다" 확인을 보인다(4.7.4). `revert_staged`면 압축 전략을 흐리게 한다.
   - **(v0.3) 세션 비용**: core 세션 통계는 generate(/btw, warming, 인계)를 빼므로 세션 비용은 `ledger.session.totals`로 보인다(7.5). v0.4부터 ledger는 title과 압축 줄도 빠짐없이 적는다.
   - **(v0.4) 도구 집합**: 03 §18.15의 "도구 목록이 바뀌어 다음 요청에서 캐시를 처음부터 다시 씁니다"는 "이 세션의 다음 요청에 도구 안내가 한 번 덧붙습니다(앞부분 캐시는 유지)"로 고친다. "`Browser is unavailable.`로 실패" 인용은 `[browser.disconnected]`(`plugin-browser/src/connection.ts:136-141`)로 고친다(4.3 D10). 규칙 자체는 03 §18.15·05 §8.7과 같다.
   - **(v0.4) 승인 모드**: `session.approval.get/set`과 이벤트 `approval.changed`를 이 문서에 넣었다(9.2·9.3). 03 §16.3·부록 A의 "02에 추가 요청" 표시를 지운다. `set`의 기기 범위는 `admin`이다.
   - **(v0.4) 메서드 범위**: `MethodScope`의 이름이 05와 같은 `read|switch|admin|local`로 바뀌었다(9.1). `prompt` 범위가 없는 기기는 `clientAction`이 필요한 전략(압축 후·전환 후 압축·포크·새 세션)을 숨긴다.
   - **(v0.4) 자식 세션**: 자식의 `switch.suggested`는 부모 화면에 띄운다(5.9(g)). `subagent_model_overridden`은 부모 세션의 도구 카드 아래 한 줄 정보로 보인다(5.11).
   - **(v0.4) 계정 소스 변경**: launcher가 `claude-auth.json`을 읽게 되기 전에는 메뉴를 숨긴다. `restart-service`는 인자가 없고 데스크톱은 `host.service.restart`로 처리한다(8.7).
   - **(v0.4) control location**: 데스크톱은 OwnHost가 준 `controlDir`을 쓰고, 임의의 directory로 `health`를 부르지 않는다(9.1).
   - 03 §16.3의 목록에 더할 것: `accounts.import.codex.list/plan/execute`, `compaction.setSession`, `accounts.update{compaction, dryRun}`, `policy.get.compactionDefaults`, `policy.set{dryRun}`, `cache.state.compaction`, 이벤트 `compaction.due`, (v0.4) `session.approval.get/set`, 이벤트 `approval.changed`, `policy.compaction.keepTokens`.

**01-architecture.md·FORK.md와 맞출 것**
14. (해결됨) own slot 관측은 own-accounts, `anthropic` 관측은 own-telemetry로 정했다(01 §3.1·§8.3, 이 문서 4.1).
15. (해결됨) **vault 항목의 키와 entropy**: `vault\<accountId>.dpapi`, `"own-open-code/v1/" + accountId`로 01 §13과 helper 구현이 맞춰졌다(2.4.5).
16. **01·FORK 문구 조정 요청**. 01 §8.4의 가져오기(linked·takeover)와 §8.7 R5의 실효 기준은 01에 이미 반영되어(`01-architecture.md` §8.4 표, R5 행) 목록에서 뺐다.
   - 01 §8.2 표는 `own-oai-*`의 transport를 "미정"으로 둔다. 이 문서는 oai slot에 transport를 적지 않는다(HTTP). 한도 헤더를 매 응답에서 얻기 위해서다. AC-P04에서 hit률 차이가 없으면 이 문서 쪽을 권한다.
   - 01 §15: RPC id는 `own.accounts`, `own.remote`, `own.team`, `own.computer` 넷, `own.accounts` 메서드 63개·이벤트 17개(9.2, T1), 범위표 `MethodScope`(9.1, 05 이름).
   - (v0.4) 01 §10.1 "도구 목록 고정 규칙": 규칙을 05 §8.7 안 D(세션 생성 때 새김)로 바꾸고, 설치 프로필(`-opencode.browser`)은 웹 전용 설치의 보강으로만 둘지 정한다. "도구가 생기거나 없어지면 모든 세션의 다음 요청이 cold"와 "프로필 변경은 모든 세션 cold 경고"는 Code Mode 도구에는 틀리다(기존 세션마다 delta 한 번, 4.3 D10). "Browser is unavailable" 인용(`connection.ts:58,81,97`)은 `[browser.disconnected]`(`connection.ts:136-141`)로 고친다.
   - (v0.4) launcher(01 §5.3, `own.ps1`): `Get-BridgeEnv`가 `OWN_HOME\claude-auth.json`의 `configDir`을 `CLAUDE_CONFIG_DIR`로 넣는다. `CLAUDE_*` 제거 규칙의 유일한 예외다(8.3 I8, 8.7). 01 §9.4의 "`service set env`" 설명도 이 방식으로 바꾼다.
   - (v0.4) 01 §17.1 #9(승인 모드): PATCH는 02 `session.approval.set`이 부모와 끝나지 않은 자식에 한다(9.2).
   - (v0.3) own 전역 설정에 `compaction.auto:false`·`compaction.buffer`를 두지 않는 규칙(4.7.6)을 01의 설정 파일 절에 적는다. keep은 사용자 결정(Q29)이다.
   - FORK.md: P-014(제안)를 원장에 올릴지. upstream 제안 "세션 generate usage 기록"과 "플러그인이 받을 수 있는 공개 사용량 이벤트"(10장).
   - 01 §13: 원격 기기는 05 게이트웨이로만, 범위표로 제한(9.1). 데스크톱 main은 비밀을 보지 않는다.

**04-ssh-remote.md와 맞출 것**
32. linked 가져오기 계정의 lease 규칙(3.2a "원격 lease와의 관계"). 04 §8.5의 "먼저 refresh"는 linked에 쓸 수 없다.
33. 미러 레지스트리에 `accounts[].compaction`과 `policy.compaction`(v0.4의 `keepTokens` 포함)을 넣어 원격이 같은 `ctx_eff`를 계산하게 한다(4.7.5). 원격 세션의 `compaction.due`는 원격 서버가 낸다.
34. 원격 own-accounts도 generate·title usage를 같은 방법으로 읽고, 압축 사용량을 공개 이벤트로 적어 spool로 보낸다(7.5, 04 §10.1).
35. 04 §22가 02에 요청한 항목 중 이 판에서 반영한 것: `remote` 계정 필드(2.4.1 예시), `LedgerLine.server`(7.5), 원격 경보 6개(7.7, 04 기준), `remote_managed`(9.4), 2.4.5 "원격은 vault 없음", 9.1 RPC id 두 개, `health.mode`(9.2), 7.6 보정 push. 반영하지 않은 것(04가 기준으로 남음): 2.3 원격 OWN_HOME 내용, `policy.remote`, 3.5 lease 최소 유효 기간, 4.1 원격 `model.request` 경로, 9.1 control location 대체 규칙, `ledger.session{server}`·`accounts.usage{groupBy:"server"}`.
47. (v0.4) 4.7.2 (d) 서비스 자기 호출을 채택하면 원격 own-accounts가 원격 서비스의 접속 정보를 어떻게 얻는지(04 §5.3 원격 레이아웃).

**05(원격 접근·모바일)와 맞출 것**
36. (v0.4, 계약) **범위표**: `MethodScope` = `read|prompt|switch|admin|local`(9.1 표, 49개 메서드). 05 §13.5에서 `switch.estimate`를 `read`에서 `switch`로 옮기고, `switch` 목록에 `switch.estimate`, `switch.setConfirmOverride`, `cache.setTtlMode`, `compaction.setSession`을 더한다. `clientAction`(`fork`, `create-session`)의 실행은 `prompt`다. 압축은 2026-10-08부터 서버가 넣으므로 `compaction.setSession`·`switch.apply`의 `switch` 범위로 일어난다(4.7.2 "범위"). `accounts.*` 쓰기와 `plugin.*` 쓰기는 `local`이라 05 §13.4의 항상 막는 목록과 같다(이전 판의 `replaceKey` 본문 검사 문제는 사라짐). 남은 것: 05가 항상 막는 목록을 `plugin.*` 쓰기로 좁혀 `plugin.claudeAuth.status`·`plugin.trust.list` 조회를 열지. (`session.approval.set`의 좁히는 방향은 2026-11-06 MUX에서 `묻기`·`읽기 전용`을, MUX-15에서 `전체 허용`까지 `prompt`로 열었다, 9.1.)
37. `accounts.add.chatgpt.*` device code를 원격 기기에 열지.
38. 푸시 후보 이벤트(9.1)와 `alert.directory` 같은 로컬 경로를 원격 기기에 보일지. 전송은 05 §13.6(Web Push 먼저, FCM/APNs 중계는 M3)을 따른다.
39. 원격 기기가 SSH 원격 세션을 PC 서비스를 거쳐 볼 때 `own.remote`에도 범위표를 둘지(04와 함께).
41. (v0.4, 계약) **controlDir 공급**(9.1): 데스크톱 OwnHost가 `controlDir`을 내준다(제안: `HostConnection.controlDir`, main이 `OWN_HOME`에서 계산). 게이트웨이·모바일은 게이트웨이 설정이나 `own.remote`의 상태 응답(예: `gateway.status`)이 준다. 05 §6.2 인터페이스와 §13.4에 넣어야 한다.
48. (v0.4) `clientAction:{type:"restart-service"}`는 인자가 없고 `OwnHost.service.restart({force})`(05 §5.6)로 처리한다. 05 §5.6·§17의 "02 §9.2 restart-service" 문장과 같다. 계정 소스 경로는 파일(`claude-auth.json`)로 넘기므로 `restart`에 인자를 더하지 않는다(8.7).

**리뷰 반영 중 판단을 남긴 것**
17. **1h 모드 단계**: 리뷰는 MVP 포함과 Phase 3 중 하나를 고르라고 했다. 400 위험(4.5), P-006 비용 계산 공백, 01 §17을 근거로 **Phase 3**로 두었다.
18. **곁가지 포크**: 03 대화상자에 더하거나 이 문서에서 빼라는 리뷰 중, 백엔드에는 남기고 `display:"secondary"`로 두는 쪽을 택했다. fork는 A 캐시를 보존하는 유일한 선택지라서(R11) 없애지 않는다.
49. (v0.4) **D10에 대한 두 리뷰 의견**: 한 의견은 "웹 전용 설치 `-opencode.browser` + 데스크톱은 세션 생성 때 새김"의 결합을, 다른 의견은 설치 단위 규칙을 02에서 지우라고 했다. 02의 규칙은 세션 생성 때 새김 하나로 두고(소유는 05 §8.7·03 §18.15), 웹 전용 설치 보강은 결과가 같은 선택지로 적어 01에 넘겼다(4.3 D10, Q16).
50. (v0.4) **자식 세션의 다른 종량제 계정 허용**: 리뷰는 "지우거나, `switch.apply`와 같은 정책에서만 허용"을 제안했다. 구독 계정·Claude 슬롯은 지우고, `ready`인 종량제 계정은 허용하는 절충을 택했다. 사용자가 명시한 요청을 살리기 위해서다(Q46).
