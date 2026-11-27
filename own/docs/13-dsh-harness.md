# 13. DeepSeek 하네스 (dsh)

| 항목 | 값 |
|---|---|
| 문서 상태 | v0.3 (2026-11-10, upstream 쓰기 실패 문구 §3.3, 읽기 전 쓰기 확인 유지 §3.5, 다음 맞춤 목록 §3.6). v0.2(2026-10-30, upstream 고침 세 가지 §3.3). 구현과 시험 완료 |
| 목적 | 세션 하네스에 네 번째 선택지 `dsh`를 더한다. DeepSeek의 코딩 에이전트 deepseek-harness(dsh)처럼 보이게 한다: dsh의 시스템 지시문 구역과 순서, 사용자 메시지 뒤에 붙는 실행 정보·작업 지시문·스킬 목록·시간 정보, 도구 이름·설명·입력 형식·결과 문구·자르기, 반복 호출 알림. 모든 모델에서 돌고 DeepSeek V4 Pro·Flash에 맞춘다 |
| dsh 기준 | `deepseek-ai/deepseek-harness` `687f282e86`(dsh-v0.2.1-rc.2, 2026-10-17, MIT, Copyright (c) 2026 DeepSeek). 로컬 사본 `D:\#Projects\own-open-code\refs\deepseek-harness`(읽기 전용). 경로 표기 `dsh:`는 저장소 루트 기준. 옮긴 파일과 해시는 `packages/own-harness/dsh-data/source.json`. 기준은 그대로 두고 그 위에 upstream `f3803c9697`(dsh-v0.2.2-alpha.2, 2026-10-28)의 고침 세 가지와 `66491b05e3`(dsh-v0.2.2-rc.1, 2026-11-04)의 쓰기 실패 문구를 옮겼다(§3.3, 해시는 `source.json`의 `backports`) |
| 관련 문서 | 10(하네스 틀), 11(공통 압축), 12(Pi 하네스), 02 §4.3(결정성 D1), `own/reports/external-repos-2026-10-05.md` §2.3 |

---

## 0. 결정 (사용자, 2026-10-19)

| 번호 | 결정 |
|---|---|
| DH-D1 | 하네스 id `dsh`. 화면 이름 `DeepSeek 방식`(영어 `DeepSeek style`, 짧은 이름 `DeepSeek`). 새 세션 기본값은 그대로 `codex` |
| DH-D2 | dsh 자체를 들이지 않고, codex·pi처럼 own 하네스 플러그인 안에 옮긴다(dsh는 Cordis 위의 "모든 것이 플러그인" 구조라 그대로는 못 쓴다). 코어 패치는 새로 만들지 않고 P-019…P-028 확장 지점만 쓴다 |
| DH-D3 | 원본(`reference`)은 dsh 그대로, 개선판(`own`)은 이 앱에서 사실이 아닌 곳만 고친다(§3.1), 내 지시문(`custom`)은 dsh의 모델 소개 줄을 바꾼다(§3.2) |
| DH-D4 | **dsh DeepSeek 어댑터의 wire extension과 텔레메트리는 옮기지 않는다.** 특히 `dsh_session_log`(기본으로 켜져 세션 로그 전체를 DeepSeek에 올림, `dsh:docs/deepseek-llm-api-wire-extensions.md`)와 OpenTelemetry 업로드. 요청 본문에는 own chat completions의 필드만 간다(e2e가 본문의 키 목록을 지킨다) |
| DH-D5 | 압축은 공통 방식(11). dsh의 압축 문턱은 하네스마다 정할 확장 지점이 없어 적기만 한다(§2.4) |

---

## 1. dsh가 하는 것

- **시스템 지시문**(`dsh:packages/core/system-prompt/src/index.ts`): 플러그인이 정해진 순서 값(`SECTION_ORDERS`)에 구역을 등록하고, 순서 값·이름 순으로 모아 빈 구역을 빼고 빈 줄로 잇는다. 처음은 고정 줄 `You are an AI agent powered by DeepSeek Harness.`, 다음은 배포 페르소나(웹 앱 표준 프리셋 `You are a coding agent powered by the {{model}} model.`, `{{model}}`은 모델 ID), 그다음 도구마다 한두 문장의 안내(그 도구가 목록에 있을 때만), MCP, 끝에 지역 사실(체크아웃 경로, 웹 주소). "지역 경로와 주소는 재사용되는 지시문 뒤에 둔다"가 dsh의 규칙이다.
- **세션 사실은 기록 메시지로**: 작업 폴더, 파일 정책(샌드박스), 승인 정책은 시스템 지시문이 아니라 사용자 메시지 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`로 들어가고, 바뀔 때만 다시 들어간다(`dsh:packages/core/agent-loop/src/runtime-context.ts`). AGENTS.md는 `<system-reminder>` 틀의 사용자 메시지(`dsh:packages/context/agent-instructions`, 65,536바이트 예산), 스킬 목록도 `<system-reminder>` 메시지(`dsh:packages/skill/tool-skill`), 시간은 10분마다 한 번 `Time sampled while preparing turn N, step M: …` 메시지(`dsh:packages/context/time-context`). 첫 단계의 순서는 [사용자 메시지][AGENTS.md][실행 정보][스킬][시간]이다(dsh 스냅샷 `snapshots/web/fresh-round-trip`, `session/agent-instructions`, `session/office-skills`로 확인).
- **도구**: Windows는 `pwsh`(`pwsh -NoLogo -NoProfile -NonInteractive -Command`, 명령 앞에 UTF-8 출력 설정), 그 밖은 `bash`(`bash -c`). 기본 시간 제한 120초, 최대 600초, 넘으면 죽인다(작업 등록소가 있으면 배경 작업으로 넘기지만 own은 옮기지 않음). stdout·stderr 각 64,000바이트의 끝을 남기고 넘친 전체는 임시 파일. `NO_COLOR=1`·`PAGER=cat`·`GIT_PAGER=cat`(bash는 `TERM=dumb`도), 부모 환경에서 이름에 KEY·PASSWORD·SECRET·TOKEN이 든 변수와 `DSH_*`는 빼고 `DSH_*` 사실을 넣는다. `read`(줄 번호 `N: 글`, 2000줄·줄당 2000자·50KB), `write`·`edit`(읽지 않은 파일은 덮어쓰거나 고칠 수 없고 읽은 뒤 바뀐 파일은 거절, `fs-observation-policy`), `glob`(ripgrep, 숨김·무시 파일 포함, 100개), `grep`(ripgrep `--json`, 250줄), `todo_write`. 모든 도구 이름은 코드 단위 순으로 정렬해 보낸다. 실패는 `Error: <글>` 결과다.
- **루프**: 같은 도구·같은 인자(키 정렬 JSON) 호출이 3·5·8번 이어지면 결과 뒤에 알림 메시지(`dsh:packages/guard/repeat-tool-reminder`). 요청마다 머리(모델·설정·도구)를 기록하고 `initial`/`resume`/`change`/`series` 이유를 남긴다(`dsh:packages/core/agent-loop/src/agent.ts` `buildRequest`). DeepSeek 어댑터는 `max_tokens` 256,000과 thinking `high`를 기본으로 보낸다(`dsh:packages/llm/llm-deepseek/src/{defaults,serialize}.ts`). 오류는 잔액·할당량 소진을 rate limit보다 먼저 읽는다(`dsh:packages/llm/llm/src/error.ts` `isQuotaExceededError`, `llm-deepseek/src/transport.ts`). 압축 문턱은 `min(0.8·창, 창 − max_tokens − 65,536)`이다(`dsh:packages/compaction/compaction-basic/src/config.ts`).

---

## 2. own이 옮긴 것

### 2.1 파일

| 파일 | 내용 |
|---|---|
| `src/dsh/prompt.ts` | 시스템 지시문 구역, 순서 값, 페르소나와 `{{model}}`·`{{provider}}` |
| `src/dsh/context.ts` | 실행 정보, AGENTS.md 틀과 예산, 스킬 목록, 시간 정보 |
| `src/dsh/request.ts` | dsh 세션의 요청 구성(순수 함수) |
| `src/dsh/tools.ts` | 일곱 도구를 플러그인 도구로 등록, own 권한 연결 |
| `src/dsh/shell.ts`·`output.ts`·`shell-tool.ts` | pwsh·bash 실행, 출력 꼬리와 넘침 파일, 셸 도구의 설명·입력·결과 문구 |
| `src/dsh/fs.ts`·`observe.ts` | `read`·`write`·`edit`, 읽은 판(version) 기억과 거절 문구 |
| `src/dsh/search.ts`·`readable.ts` | `glob`·`grep`과 결과 저장, 검색 결과의 `read` 규칙(§2.3) |
| `src/dsh/todo.ts` | `todo_write` |
| `src/dsh/reminder.ts` | 반복 호출 알림 |
| `src/dsh/series.ts` | 요청 시리즈 이유(로그) |
| `src/dsh/errors.ts` | 잔액 소진 판별 |
| `src/dsh/snapshots.ts` | 실행 정보가 들어간 자리(플러그인 저장소) |
| `src/dsh/variant.ts` | 개선판의 고친 곳과 이유 |
| `src/dsh/args.ts` | dsh 입력 검사 문구 |
| `dsh-data/` | dsh의 MIT `LICENSE`, `NOTICE`, 옮긴 원본 파일과 해시(`source.json`), 시험이 비교하는 dsh 스냅샷(`snapshots/`) |

### 2.2 요청 (`hooks.ts`의 `context`·`compaction`·`generate` 훅)

- core의 시스템 조각을 dsh 지시문 하나로 바꾼다. 순서: 고정 줄 → 페르소나 → 도구 안내(pwsh 또는 bash, read, write, edit, glob, grep) → MCP 안내(`MCP_SERVERS`) → Code Mode 목록과 참조 폴더(`TOOLS_SDK`) → own 문맥 항목(`<context key>`)과 다른 플러그인이 붙인 시스템 조각(own 순서 값 9500) → 빈 페르소나 뒷말. core의 날짜·환경 구역과 `# Your Model`은 뺀다(dsh에 없음). own에 없는 도구의 dsh 안내(배경 작업, 웹, 목표, 워크플로, 하위 에이전트, `present`, `@` 파일 참조, 계획 모드)는 dsh가 그 도구가 없을 때 하듯 넣지 않는다.
- OpenAI Responses 모델에서는 지시문을 첫 developer 메시지로, 그 밖에서는 시스템 지시문으로 보낸다(dsh가 OpenAI를 부르는 pi-ai 어댑터도 같다).
- 기록은 dsh 도구 이름으로 번역하고(`History.translate`, dsh에는 패치 도구가 없어 이전 패치 호출은 이름을 그대로 둔다), 체크포인트는 공통 형식으로 그린다.
- 그 위에 dsh가 기록에 남기는 메시지를 요청마다 같은 자리에 넣는다. 모두 저장된 기록과 그 시각만으로 정해지므로 같은 기록은 같은 바이트다.
  - 첫 사용자 메시지 뒤 첫 단계: AGENTS.md(core 기준선이 읽은 파일, 전역 → 프로젝트 루트 → 아래, 프로젝트 파일은 작업 공간 루트 기준 경로, 전역 파일은 `~/…`), 실행 정보, 스킬 목록(own `skill` 도구가 받는 스킬 ID), 시간.
  - 각 단계 시작(사용자 메시지 뒤나 도구 결과 뒤): 앞 시간 정보에서 10분이 지났으면 시간 정보. 시각은 그 단계 직전 메시지의 시각(사용자 메시지는 만든 때, 도구가 있는 단계는 도구가 끝난 때)이다. 차례 번호는 보이는 기록 안의 사용자 메시지 수, 단계 번호는 그 뒤 모델 답 수다.
  - 단계의 도구 결과 바로 뒤: 반복 호출 알림.
  - 실행 정보가 바뀐 때(승인 모드를 바꿈): 그때 기록의 마지막 메시지 뒤 단계 시작에 새 실행 정보. 자리는 플러그인 저장소에 세션마다 남겨(`dsh/context/<세션>`, 최근 16개) 다음 요청도 같은 자리에 넣는다. 압축으로 그 메시지가 사라지면 새 첫 단계에 다시 넣는다.
- 압축 요청의 사용자 원문 보존(`CodexCompaction.retained`)에는 이 덧붙인 메시지가 들어가지 않는다(번역한 원래 기록을 넘김).

### 2.3 도구와 권한

- core에도 `read`·`write`·`edit`·`glob`·`grep`이 있어 이름이 겹친다. 그래서 `dsh_pwsh`(또는 `dsh_bash`)·`dsh_read`·`dsh_write`·`dsh_edit`·`dsh_glob`·`dsh_grep`·`dsh_todo_write`로 등록하고 dsh 세션 요청에서만 dsh 이름으로 바꿔 보낸다. core는 같은 정의 객체로 원래 도구를 찾는다. 별칭 호출의 입력 보정은 P-028이 실제 도구 기준으로 한다.
- 목록 관문: 권한 동작 `own_harness_dsh`, 모든 에이전트에 거부, `dsh` 세션에만 허용(`Gate.DSH_ALLOW`).
- 권한(P-019): `read`는 `read`, `write`·`edit`는 차이를 보여 주는 `edit`(Location 밖은 `external_directory` 먼저. `~/…`로 쓴 홈 폴더 경로도 여기에 든다, §3.3), 셸은 core 셸과 같은 승인(`ctx.shell.authorize`), `glob`·`grep`은 core처럼 그 패턴으로 `glob`·`grep`. 같은 파일의 수정은 한 번에 하나씩(dsh의 파일 잠금).
- **검색 결과와 `read`(P-031)**: core `grep`·`glob`은 2026-10-18부터 결과 파일마다 `read`를 판정한다. 플러그인 API에는 그 판정(`Permission.check`)이 없어, dsh `grep`·`glob`은 에이전트와 세션의 규칙을 읽어 core `Permission.evaluate`와 같은 방법(마지막으로 맞는 규칙, core wildcard)으로 판정한다(`readable.ts`). `grep`은 허용인 파일의 줄만 보이고 빠진 파일 수를 core 문구로 알리며, `glob`은 거절인 경로만 뺀다. 사용자가 저장한 "항상 허용"은 보지 못하므로 core보다 엄격할 수는 있어도 느슨하지 않다. own-accounts의 `evaluate` 훅이 거절하는 보호 경로(기본 목록과 사용자 목록, 01 §13 PP)는 규칙에 없으므로, 검색마다 own.accounts `protectedPaths.patterns`(프로세스 안 RPC)로 패턴을 받아 맞는 파일을 뺀다(own.accounts가 답하지 않으면 규칙만으로 판정). 판정을 플러그인에 열어 주면 바꾼다(§5).
- dsh 요청에서 빠지는 core 도구: `shell`, `patch`, `edit`, `write`, `read`, `glob`, `grep`. 나머지(`question`, `skill`, `webfetch`, `websearch`, `subagent`, Code Mode `execute`, MCP, 컴퓨터 사용 등)는 이름 그대로 남는다.
- 작업 폴더 대화(06 §13, 2026-11-24): own.team의 `worktree_*` 도구는 Code Mode `execute` 안에 있어 dsh 도구 일곱 뒤의 `execute`로 닿는다.
- 하위 에이전트에게 가는 글(2026-11-07): core `subagent`는 설명 그대로이고 dsh의 하위 에이전트 안내 구역은 넣지 않는다(아래 표). 새 자식은 `You are a subagent spawned by another session.` 한 줄과 부모의 글을 받고, 같은 dsh 지시문·AGENTS.md·스킬을 받는다. 자기 `system`이 있는 역할(core `explore`)은 그 글이 페르소나 줄을 대신한다(`agentInstructions`). 설정 > 에이전트 방식의 DeepSeek 탭 `하위 에이전트`가 실제 설명과 돌아오는 글을 보인다(10 §3.11).
- 도구 순서: dsh 도구 일곱은 dsh처럼 코드 단위 이름순으로 앞에, own의 나머지 도구는 그 뒤에 core 순서로 보낸다. 처음에는 모두를 이름순으로 섞었는데, 그러면 Code Mode `execute`가 두 번째가 되어 실계정 시험에서 DeepSeek·Claude가 dsh 세션 6번 중 5번 `execute`를 한 번씩 헛되이 불렀다(codex·pi 세션은 10번 중 0번). 뒤로 옮긴 뒤 5번 중 0번이다. dsh에는 Code Mode가 없으므로 dsh 도구 목록은 dsh 그대로이고, own이 더한 도구만 codex·pi처럼 뒤에 붙는다.
- **하위 에이전트(2026-11-03, 결정 SA)**: dsh에는 `read`·`glob`·`grep`이 있어, 셸이 막힌 `explore`(모든 모드)와 `읽기 전용`의 하위 에이전트도 폴더를 훑고(`glob`) 파일을 읽는다. 셸 읽기를 따로 답하지 않는다(Codex·Pi 방식과 달리 필요 없다). own-accounts의 거절 글("Use read, grep and glob instead")이 dsh의 도구 이름과 맞다. `explore`의 실행 정보는 부모의 모드와 상관없이 `읽기 전용` 정책으로 쓴다(`Fragments.mode(rules, agent)`: 고치지도 명령을 돌리지도 못하는 것이 사실이다).
- 셸: Windows는 PowerShell 7(`Program Files\PowerShell\7`) → PATH의 `pwsh.exe` → Windows PowerShell 5.1 순으로 찾는다. 도구 이름 자체가 `pwsh`라 지시문이 말하는 셸과 실제 셸이 같다(`test/e2e/shells.test.ts`). POSIX에서 시간 초과·중단은 SIGTERM, 3초 뒤 SIGKILL, Windows는 `taskkill /F /T`(종료 코드 1). `DSH_SHELL=1`, `DSH_SESSION_ID`(own 세션 id)를 넣는다.

### 2.4 루프 동작

| dsh 동작 | own에서 | 근거 |
|---|---|---|
| 반복 호출 알림(3·5·8번, 결과 뒤, 사용자 메시지에서 다시 셈) | 옮김. 요청 구성에서 기록으로 계산해 단계 결과 바로 뒤에 넣는다. 앞부분 바이트는 바뀌지 않는다. 막지는 않는다 | `reminder.ts` |
| 요청 시리즈 이유 | 옮김. 지속 이벤트는 만들지 않고(AGENTS.md: durable events는 최소), 플러그인 프로세스가 세션마다 마지막 주 요청의 해시를 기억해 이유가 있을 때 로그 한 줄 `dsh_request_series {reason, startsSeries, changed, kept}`을 쓴다. 모델에는 가지 않는다 | `series.ts` |
| DeepSeek `max_tokens` 256,000 | 이미 같다. core가 min(카탈로그 출력, 256,000)을 창에 맞춰 보내고, ds 템플릿의 V4 출력은 393,216이라 256,000이 간다(e2e가 확인). 따로 넣지 않는다. 설정 > 출력 상한(02 §4.9)의 기본 `이 값을 넘기지 않기` 256,000도 같은 값이고, 사용자가 바꾸면 dsh 대화도 그 값을 따른다. 창 끝에서 core가 줄이는 것은 own 압축 문턱이 dsh보다 높아서 그대로 둔다 | `model-request.ts` `outputLimit` |
| DeepSeek thinking 기본 `high` | own DeepSeek 변형(none/low/high/max)은 이미 dsh와 같은 thinking·effort 짝을 보낸다. 변형을 고르지 않은 세션(`default`)에만 `reasoning_effort: high`를 넣는다. 네이티브 DeepSeek 경로(`@opencode/ai/providers/deepseek`)에서만 | `hooks.ts` |
| 잔액 소진을 rate limit보다 먼저 | 옮김. dsh 세션의 `retry` 훅에서 잔액·할당량 문구(또는 402)인 오류의 대기 후 재시도를 멈춘다. 즉시 재시도(own-accounts의 계정 전환)는 그대로 둔다 | `errors.ts` |
| 압축 문턱 `min(0.8·창, 창 − max_tokens − 65,536)`(1M 창이면 678,464) | 옮기지 못함. own 공통 압축은 core의 문턱(창 − max(창의 15%, RESERVE_MIN), upstream v2.1부터 15%. 또는 설정 `compaction.buffer`)을 쓰고, 하네스마다 정할 확장 지점이 없다. 실행 중에 플러그인이 압축을 부르면 Session Core 규칙(한 시도에 `llm.stream` 하나, durable continuation)과 맞지 않는다 | `core/src/session/compaction.ts` `calculateCeiling` |

### 2.5 전환과 화면

- 전환 안내: dsh로 갈 때 `Earlier exec_command calls are shown as pwsh.`(Windows), 패치 도구는 이름이 그대로라는 줄, dsh 도구 목록 줄. 지난 셸 호출에는 `description`을 지어 넣지 않는다.
- 화면: 하네스 알약과 메뉴에 `DeepSeek 방식`(설명 `DeepSeek가 만든 코딩 에이전트(dsh)의 지시문과 도구로 일해요. DeepSeek V4 모델에 맞춰져 있어요.`), 설정 > 일반 `새 대화의 에이전트 방식`에 `DeepSeek 방식`(고른 방식의 한 줄 설명을 줄 설명 앞에 보임), 설정 > 에이전트 방식에서 보기·고치기(§3.2). 도구 카드는 `pwsh`를 셸 카드로 그리고, dsh `read`·`write`·`edit`의 `file_path`·`old_string`·`new_string`·`replace_all`을 core 카드의 이름으로 바꿔 보인다(`own-web` `transcript/tool-alias.ts`). 팀 모드 큰 파일 폴더 감시도 `pwsh`와 `file_path`를 본다(`own-team` `assets/guard.ts`).

---

## 3. 이번에 정한 것 (애매했던 점)

| 항목 | 정한 내용 |
|---|---|
| 어느 dsh 구성을 원본으로 보나 | 웹 앱의 표준 에이전트 프리셋(`dsh:packages/bundle/web-app/presets/standard.patch.yml`)과 기본 번들. 셸은 플랫폼대로(Windows `pwsh`). 시험이 dsh 스냅샷 `session/pwsh-tool-turn`과 `web/fresh-round-trip`의 지시문·도구 스키마와 비교한다(옮기지 않은 도구의 구역과 필드는 빼고) |
| 샌드박스 | dsh 기본은 파일 샌드박스(workspace-write)와 승인 묻기다. own에는 샌드박스가 없으므로 셸 도구는 dsh가 샌드박스 실행기 없이 등록하는 꼴(`sandbox_permissions`·`justification` 없음)로 보낸다. 원본의 설명과 실행 정보에 남은 샌드박스 문장은 dsh 그대로 두고 개선판이 고친다 |
| own 승인 모드 → dsh 정책 | `full` = danger-full-access + 승인 never, `ask` = workspace-write + ask, `read-only` = read-only + ask(dsh 권한 프리셋 짝) |
| 설정 에이전트의 자체 지시문 | dsh 에이전트 프리셋의 페르소나 행처럼 페르소나 자리를 대신한다 |
| 설정 `instructions`(파일·URL) | dsh에는 AGENTS.md 말고 지시 파일이 없어, 같은 작업 공간 지시 틀에 `Instructions from: <경로>`로 전역 AGENTS.md와 프로젝트 AGENTS.md 사이에(설정 순서대로) 넣는다. 전역 파일처럼 작업 폴더로 가는 길의 폴더가 아니라 설정에서 오므로 어느 프로젝트 AGENTS.md보다 넓은 것으로 본다(dsh의 로컬 덧붙임 `AGENTS.local.md`는 같은 폴더의 기본 파일 바로 뒤에 오므로, 폴더가 없는 설정 항목의 자리가 되지 못한다). dsh 틀은 더 구체적인 지시가 넓은 지시보다 앞선다고 하고, 예산이 넘치면 넓은 것부터 빼고 가장 구체적인 것을 마지막에 자른다. 그래서 예산을 넘는 설정 항목이 프로젝트 AGENTS.md보다 먼저 빠지고 작업 폴더의 AGENTS.md가 가장 오래 남는다(설정 것을 맨 뒤에 두면 큰 항목 하나가 AGENTS.md를 모두 밀어낸다). 경로는 AGENTS.md와 같은 규칙(작업 공간 루트 기준, 홈은 `~/…`), URL은 그대로 쓴다(`Baseline.sources`, 10 §3.3). 작업 폴더는 실제 경로로 견주므로 junction·심볼릭 링크로 연 위치도 같다. 기준선만으로 가를 수 없는 경우(앞에 아무것도 없는 설정 `AGENTS.md`, core가 걷지 않은 위 폴더의 설정 `AGENTS.md`, 전역 설정 폴더 안의 작업 폴더, 그 자체가 링크인 AGENTS.md)는 10 §3.3에 적었다. 설정 `instructions`가 없는 세션의 바이트는 전과 같다 |
| 실패 결과 | dsh 문구(`Error: <글>`)를 보통 결과로 돌려준다(Pi와 같은 이유: core 도구 오류는 JSON 묶음이 됨). 셸 카드는 `exit`로 실패를 표시한다 |
| 읽은 판 기억 | 플러그인 프로세스 메모리에 세션마다(최근 256 세션). 서비스를 다시 켜면 잊는다(dsh도 다시 열면 잊는다). 다른 하네스에서 읽은 파일도 dsh에서 다시 읽어야 고칠 수 있다 |
| `{{model}}` | 모델 ID. 내 지시문에서도 `{{model}}`·`{{provider}}`를 바꾼다. 모르는 이름은 dsh처럼 오류를 내지 않고 그대로 둔다 |
| 브라우저 시간대 | own 화면은 시간대를 보내지 않는다. 원본은 dsh의 `missing` 문구(`Browser time zone for this request: unavailable…`)와 서비스 시간대의 시각, 개선판은 이 PC의 시간대 |
| `DSH_HOME`·`DSH_PROFILE` | own에는 dsh 홈과 프로필이 없어 넣지 않는다 |
| 스킬 목록의 이름 | own `skill` 도구가 받는 스킬 ID를 쓴다(dsh는 이름) |
| rg | dsh는 ripgrep을 함께 싣는다. own은 PATH의 `rg`, 없으면 core가 받아 두는 opencode 캐시의 `rg`(`Global.Path.bin`)를 쓴다. core가 아직 받지 않았으면(새 홈에서 core 검색을 한 번도 안 씀) dsh `glob`·`grep`이 core의 `glob`·`grep`을 같은 패턴으로 한 번 불러 core가 받게 한다(같은 권한을 묻고, 결과는 쓰지 않음). 그래도 없으면 dsh의 실행 실패 문구. 실계정 시험 1회차에서 새 홈의 첫 `glob`이 이 문구로 실패해 고쳤다. glob·grep에 묻기 규칙을 둔 사용자만 이 첫 한 번에 두 번 묻는다(own 승인 모드에는 그런 규칙이 없다) |

### 3.1 own 개선판 (2026-10-19, 10 §3.9)

dsh 글은 그대로 두고, 이 앱에서 사실이 아닌 곳만 고친다(`src/dsh/variant.ts`, 설정 > 에이전트 방식 `고친 곳`에 이유가 나온다).

| 고친 곳 | 원본 | 개선판 | 이유 |
|---|---|---|---|
| 실행 정보의 정책 | `Current DSH file policy: …` + `Approval policy: …` | own 승인 모드 설명(Codex 개선판과 같은 사실: 무엇을 묻고, 보호 파일은 거절되고, 화면 이름과 바꾸는 곳) | own에는 dsh 파일 샌드박스와 승인 응답자가 없다 |
| 셸 설명의 샌드박스 문장 | `Commands may run under a file sandbox; … [sandbox: …]` | 뺌 | own은 그런 표시를 내지 않는다 |
| 시간 정보의 시간대 | `Browser time zone … unavailable` | `Time zone of this machine: <zone>. …` | own은 이 PC에서 돈다 |
| Code Mode 목록 | core가 쓴 그대로 | 도구당 한 줄(`PiVariant.codemode`) | Pi·Codex 개선판과 같다 |

### 3.2 내 지시문 (10 §3.11)

- 바꾸는 곳은 페르소나 줄(`You are a coding agent powered by the {{model}} model.`) 하나다. 고정 줄, 도구 안내, 실행 정보, 시간 정보는 만든다. 개선판의 고친 곳은 그대로 든다.
- `개선판에서 시작`과 `원본에서 시작`은 같은 글이다(페르소나는 두 판이 같다).
- 설정 에이전트의 자기 지시문이 있으면 그것이 이긴다.

### 3.3 upstream 고침 옮김 (2026-10-30, 2026-11-10)

기준(`687f282e86`)은 그대로 두고, upstream `f3803c9697`(dsh-v0.2.2-alpha.2)에서 스스로 닫힌 고침 세 가지를, 2026-11-10에 `66491b05e3`(dsh-v0.2.2-rc.1)에서 쓰기 실패 문구를 옮겼다. 코드, 시험, `dsh-data/NOTICE`가 `upstream f3803c9697`·`upstream 66491b05e3`로 출처를 적는다. 도구 설명과 스키마, 지시문은 바뀌지 않아 요청 바이트(첫 요청 골든)는 그대로다.

| 고침 | upstream | own |
|---|---|---|
| `~` 펼치기 | ae0dfd1003, 32004176bf (fs-local `expandHomePrefix`) | `src/dsh/fs.ts` `resolve`가 맨 앞의 `~`, `~/`, Windows에서만 `~\`를 홈 폴더로 바꾼다. `~user`와 뒤쪽의 `~` 조각은 글자 그대로다. 디렉터리 항목 이름은 이 길을 지나지 않는다(own에는 목록 도구가 없어 `./~`로 닿는 폴더가 그 경우다). 전에는 `read`·`write`·`edit`가 작업 폴더에 `~`라는 폴더를 만들었다(실제 버그). 펼친 홈 경로는 Location 밖이므로 `external_directory` 규칙(기본 허용)을 거친다. `glob`·`grep`의 `path`는 upstream처럼 펼치지 않는다 |
| `glob` 가지치기 | ef284800b9, e8bdbbe823, b1c8c9bbbc, f9ef03834a | `path`가 없고 패턴의 폴더 조각이 모두 평범한 이름(`.`, `..`, VCS 폴더가 아님, `[\w .-]`만)이면 `--glob=!**`와 `--glob={폴더들}/`를 패턴 앞에 넣는다. ripgrep은 마지막에 맞는 glob을 따르므로 결과는 같고, 다른 폴더(예: 큰 `node_modules`)에 들어가지 않는다. 두 인자가 8 KiB를 넘으면 예전처럼 전체를 걷는다 |
| `grep`의 빈 `include` | 080a2c60b3, 4e4badb8f3 | 정확히 빈 문자열은 빠진 것으로 본다(필터 없음). 공백만 있는 값은 여전히 `include must be a non-empty glob when given` |
| 쓰기 실패 문구(`66491b05e3`) | 9b154c04a6, 8f798da97d(fsio `writeIoError`), 시험 7fab3cf976 | `src/dsh/fs.ts` `writeAtomic`. OS가 거절한 쓰기(EACCES, Windows가 읽기 전용 파일에 주는 EPERM)는 `cannot write "<경로>": permission denied`(`FS_PERMISSION_DENIED`), 그 밖에 OS가 알린 실패는 `cannot write "<경로>": <OS의 글>`(`FS_IO_ERROR`)이다. `write`와 `edit` 모두 같고, 경로는 모델이 보는 경로다. 전에는 Node 오류가 그대로 가서 거절도 `EPERM: operation not permitted, rename '…\.f.txt.<pid>.<uuid>.tmpdir\f.txt.tmp' -> …`처럼 임시 폴더 경로가 모델에 보였다. 이제 거절에는 임시 폴더 경로가 없다. 그 밖의 실패는 upstream처럼 Node의 글을 그대로 담으므로 임시 폴더 경로가 보일 수 있다. 임시 폴더 지우기는 upstream처럼 되는 만큼만 한다: 이름 바꾸기가 끝난 쓰기는 지우기가 실패해도(예: 다른 프로세스가 그 폴더를 잡고 있을 때) 성공이고 빈 임시 폴더만 남는다. 이름 바꾸기가 실패하면 그 오류가 간다. 이름이 약 200자를 넘는 파일은 upstream처럼 쓸 수 없다(임시 폴더 이름이 파일 이름보다 50자쯤 길어 255자 한도를 넘으므로 `FS_IO_ERROR`). 쓰기가 실패할 때만 보이는 글이다 |

같은 커밋들의 다른 바뀜(목표 도구와 샌드박스 인자 설명, 문서)은 own에 없는 도구이거나 바이트를 바꾸므로 옮기지 않았다.

---

### 3.4 Claude Agent에서 (2026-10-31, 10 §3.12)

- provider가 `claude-agent`면 dsh의 system 전체가 Claude Code preset 뒤의 역할(`claudeCodeAgent`)로 간다.
- DeepSeek 전용 설정(강도 기본 `high`, 잔액 소진 때 재시도 멈춤)은 DeepSeek 패키지에서만 돌아 이 경로에서는 쓰이지 않는다.

### 3.5 읽기 전 쓰기 확인은 그대로 둔다 (upstream과 다름, 2026-11-10, DH-16)

upstream은 dsh-v0.2.2-alpha.3(2026-11-03; 바꾼 커밋 `fe5450b152`·`14d3e53c19`, 2026-10-29; 안내 `dsh:docs/upgrade-guide/v0.2.2-alpha.2/fs-observation-policy-default-off/guide.md`)부터 `fs-observation-policy`를 끈 채 내보낸다. 그래서 dsh의 `write`·`edit`는 읽지 않은 파일도 덮어쓰고 고친다. own은 이 확인(`src/dsh/observe.ts`, `fs.ts`의 `planWrite`·`planEdit`)을 원본·개선판·내 지시문 모두에서 켜 둔다.

- 이유: 팀 모드에서는 여러 에이전트가 같은 폴더의 파일을 고치고, 사용자도 편집기에서 같은 파일을 고친다. 확인이 없으면 모델이 읽은 뒤 바뀐 파일을 보지 못한 채 덮어쓴다(`FS_STALE_VERSION`이 막는 일). 내놓은 dsh(rc.1까지)에는 이 경우를 다루는 글이 없다. upstream master에만 하위 에이전트 안내 구역의 글(쓰기 범위를 나누라, 셸과 포매터는 충돌 확인 없이 덮어쓸 수 있다, `dsh:packages/subagent/tool-subagent/src/index.ts`, `0487699ae4` 2026-10-31, rc.1에는 없음)이 있고, 그것도 글로만 다룬다. own은 그 구역을 넣지 않는다(§2.3).
- DH-D3("원본은 dsh 그대로")과 다른 곳은 이 동작 하나다. 지시문은 기준(`687f282e86`)의 글 그대로이고, 그 글의 `(the default fs-observation-policy requires it)`는 own에서 지금도 사실이다. 거절 문구(`FS_NOT_OBSERVED`, `FS_STALE_VERSION`과 고치는 방법)도 기준의 dsh 글이다.
- 다음 맞춤(§3.6)에서 괄호를 뺀 upstream 안내를 가져와도 모델은 여전히 먼저 읽으라는 말을 듣고, 어기면 같은 거절 문구를 받는다. 그래서 동작과 글이 어긋나지 않는다.
- 기록: `dsh-data/NOTICE`, 결정 DH-16.

### 3.6 다음 dsh 맞춤에서 한꺼번에 가져올 것 (2026-11-10, DH-18)

이번에는 지시문 바이트를 바꾸지 않는다. 바꿀 때마다 진행 중인 dsh 대화가 캐시를 처음부터 한 번 다시 쓰므로(찬 요청 한 번), dsh 0.2.2 정식이 나오면 아래를 모두 한 번에 가져온다. 그때 기준(`source.json`의 `commit`)을 옮기고, `dsh-data/snapshots/`(지시문 둘, `context-messages.json`)을 새로 받고, 첫 요청 골든 `test/golden/dsh/first-request.pwsh.json`을 다시 기록한다. 아래 글은 2026-11-10 upstream master `fcc0ad4621`(dsh-v0.2.2-rc.1 `66491b05e3` 뒤)에서 읽었다.

| 바뀜 | upstream | own에서 바뀔 곳 |
|---|---|---|
| `read` 안내가 셸 읽기 명령과 줄 범위를 말함: `Use the read tool — not shell commands like cat, sed, head, or tail — to inspect text files. Use offset and limit to read a line range or continue a large file.` | `15c9e6006b`(2026-10-26), master에만 있음(rc.1에는 없음) | `src/dsh/fs.ts` `READ_SECTION`. 세 판 모두 |
| `write`·`edit` 안내의 괄호 뺌: `Read an existing file before overwriting it with write and prefer edit for targeted changes.`, `Read a file before editing it unless you just created or edited it in this session.` | `fe5450b152`·`14d3e53c19`(2026-10-29), alpha.3·rc.1 | `src/dsh/fs.ts` `writeSection`·`EDIT_SECTION`. 확인은 그대로 둔다(§3.5) |
| `ask` 승인 문장: `Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.` | `747cbf13b6`(2026-10-19), alpha.2부터. 정책 바뀜 안내(`c29cda3777`)는 own에 없다 | `src/dsh/context.ts` `policy()`의 `ask`·`read-only`. 원본만 보낸다(개선판·내 지시문은 own 승인 모드 글, §3.1) |
| AGENTS.md 예산을 전역 묶음과 프로젝트 묶음에 65,536바이트씩 따로(합쳐 최대 두 배, 넘치면 묶음마다 넓은 것부터 빼고 마지막 것을 자름) | `114da79e42`(2026-10-18), alpha.2부터 | `src/dsh/context.ts` `instructions()`. 합쳐 64 KiB를 넘을 때만 바이트가 바뀐다. 설정 `instructions` 항목(§3 표)을 어느 묶음에 셀지 그때 정한다 |
| `apply_patch` 도구 | 들어왔다가 내보내는 기본값에서 "잠시" 꺼짐(`e1609fe164`, 2026-11-02) | 지금은 없음. upstream이 다시 켜면 dsh 대화에 Codex 방식의 패치 엔진으로 `apply_patch`를 열지 정한다(지금 dsh 요청은 core `patch`를 뺀다, §2.3) |

쓰기 실패 문구(§3.3)는 실패할 때만 보이는 글이라 이번에 먼저 옮겼다.

## 4. 옮기지 않은 것 (이유)

| dsh | 이유 |
|---|---|
| DeepSeek 어댑터의 wire extension(`dsh_session_log` 등), 세션 로그 DeepSeek 업로드, OpenTelemetry | DH-D4. 사용자 데이터를 밖으로 보낸다 |
| DeepSeek Anthropic 호환 Messages 엔드포인트 | own DeepSeek 계정은 chat completions로 간다. 요청 모양은 own 공급자 계층이 정한다 |
| 배경 작업(`run_in_background`, `job_output`·`job_kill`·`job_list`, 시간 초과 시 배경으로 넘김) | 작업 등록소 전체가 필요하다. dsh도 등록소가 없으면 앞 실행만 하고 죽이는 같은 꼴을 쓴다 |
| 파일 샌드박스와 권한 상승(`sandbox_permissions`) | own에는 샌드박스가 없다. 승인은 own 승인 모드가 한다 |
| 계획 모드(`exit_plan_mode`, 계획 검토) | 검토 화면과 모드 상태가 필요하다. own `plan` 에이전트는 자기 지시문(페르소나 자리)과 권한으로 돈다 |
| `ask_user_question`, `present`, `read_image`, 웹 검색·가져오기, 목표, 일정, 하위 에이전트·워크플로·`send_message` | own 도구(`question`, `webfetch`, `websearch`, `subagent` 등)가 이름 그대로 남는다. dsh 안내 구역도 넣지 않는다 |
| 전체 도구 결과 토큰 예산(spill-policy 12,500)과 오래된 결과 다듬기(tool-result-pruner) | 결과를 고쳐 쓰는 것이라 앞부분 바이트를 바꾼다. 셸·읽기·검색 도구 자신의 자르기는 옮겼다 |
| 중첩 AGENTS.md를 파일을 건드릴 때 더 넣기 | core의 지시문 갱신(`session.instructions.updated`, 기록 속 시스템 메시지)이 같은 일을 한다 |
| 도구 목록이 바뀔 때의 developer 메시지(`tool-addition`·`tool-removal`) | 기록에 지속 메시지를 써야 한다. own은 하네스 전환 안내만 남긴다 |
| 압축 문턱 | §2.4 |
| 요청 시리즈 머리의 지속 기록(`request/header`) | 로그로 대신한다(§2.4) |

---

## 5. 열린 점

- **검색의 `read` 판정**: 플러그인 API(P-019 `PermissionDomain`)에 core `Permission.check`(P-031)를 여는 `ctx.permission.check(input, context)`가 있으면 `readable.ts`의 규칙 판정을 core 판정(저장한 승인과 `evaluate` 훅 포함)으로 바꾼다. 코어 패치 추가라 사용자 승인이 필요하다.
- **하네스별 압축 문턱**: dsh 문턱을 쓰려면 압축 훅(P-025)이나 세션 요청 훅에 "이 세션의 문턱"을 줄 자리가 필요하다. 지금은 own 문턱(큰 창은 85%)이 dsh(약 68%)보다 늦게 압축한다.
- **bash 골든**: 첫 요청 바이트 골든은 Windows(`pwsh`)만 기록했다. 다른 플랫폼은 `OWN_UPDATE_GOLDEN=1`로 만든다.

---

## 6. 시험

- 단위(`test/unit/dsh/`):
  - `prompt.test.ts`: dsh 스냅샷과 지시문을 구역까지 비교(Windows pwsh 구성, 웹 표준 프리셋 bash 구성), 조건부 구역, own 안내의 자리, 실행 정보·AGENTS.md(예산 포함)·스킬 목록·시간 정보 문구를 dsh 스냅샷 글과 비교.
  - `tools.test.ts`: 도구 스키마를 dsh 스냅샷과 비교(옮기지 않은 필드 제외), 입력 검사 문구, `read` 창과 꼬리말·실패 문구, 읽은 뒤 쓰기·바뀐 파일 거절·다른 세션, `edit` 고유 일치·CRLF 유지·`replace_all`, 셸 종료 표시·`[stderr]`·UTF-8 한글·`DSH_*`·비밀 이름 변수 제외·시간 초과 표시, `glob`·`grep`(실제 rg)·P-031 판정·결과 저장 꼬리말, rg가 아직 없을 때 core 도구를 한 번 불러 받게 함, `todo_write`.
  - `request.test.ts`: 지시문 교체, dsh 도구의 이름순(own 도구는 뒤)과 같은 정의 객체, 첫 단계의 덧붙인 메시지 순서, 다음 차례에서 같은 바이트·10분 규칙·실행 정보 바뀜, 반복 호출 알림의 자리와 사용자 메시지에서 다시 셈, 기록 번역과 같은 바이트, Responses, 설정 에이전트 지시문, 개선판·내 지시문.
  - `support.test.ts`: 요청 시리즈 이유, 잔액 판별, 관문 규칙, 셸 기록 번역.
  - `fs-local.test.ts`·`fs-search.test.ts`(§3.3, upstream `filesystem.spec.ts` "home prefix"와 `tool-fs-search` 시험 이식): `~`·`~/`·Windows `~\`, `~user`와 뒤쪽 `~`, `~/` 뒤의 `..`, `./~` 폴더. `glob` 인자(`{a,b}/` 묶음과 중복 제거, `-`·점·공백 이름, 대소문자, 가지치기 안 하는 패턴, `path`가 있을 때, VCS 폴더, 8 KiB 예산의 경계 8192·0·23·262바이트)와 실제 rg로 가지친 결과가 안 가지친 결과와 같음(무시·숨김 파일, 없는 폴더, junction, 큰 `node_modules`). `grep`의 빈 `include`와 공백 `include`. `tools.test.ts`에도 `~/…` 읽기·쓰기·고치기와 빈 `include`·가지친 `glob`를 도구로 돌리는 경우가 있다.
  - 쓰기 실패(§3.3, upstream `fsio.spec.ts` "atomic write failures" 이식): `fs-local.test.ts`는 POSIX의 읽기 전용 폴더(바로 아래와 없는 하위 폴더, root가 아닐 때)에서 `FS_PERMISSION_DENIED`, 일반 파일이 막은 부모 경로에서 OS의 글을 담은 `FS_IO_ERROR`(모든 플랫폼), Windows의 읽기 전용 파일 바꾸기에서 `FS_PERMISSION_DENIED`와 원래 내용·임시 폴더 없음을 본다. `tools.test.ts`는 같은 거절이 `write`·`edit` 모두 `Error: cannot write "<경로>": permission denied`로 가고 임시 폴더 경로가 보이지 않음을, 다른 실패는 `Error: cannot write "<경로>": `로 시작함을 본다. upstream이 시험용 고리로 넣는 준비 중 결함 경우는 own에 그 고리가 없어 옮기지 않았다. 이름 바꾸기 뒤 임시 폴더 지우기가 실패하는 경우도 같은 이유로 단위 시험이 없다(다른 프로세스가 그 폴더를 잡는 경합으로만 생긴다). 2026-11-10 검토 때 재현해, 고치기 전에는 `FS_IO_ERROR`, 고친 뒤에는 성공임을 확인했다(DH-20).
  - `prompts.test.ts`: 설정 > 에이전트 방식 미리 보기(부분, 도구, 고친 곳, 내 지시문).
- e2e(`test/e2e/dsh.test.ts`, 서버 부팅 + 가짜 DeepSeek chat completions): dsh 지정 세션이 dsh 지시문·도구·덧붙인 메시지를 보냄, `max_tokens` 256,000과 `reasoning_effort: high`, 본문 키는 own 필드뿐, `read → edit → write → 셸`이 승인 요청을 거쳐 dsh 문구로 답함, 첫 요청 바이트 골든(`test/golden/dsh/first-request.pwsh.json`, 작업 폴더·시각·호출 ID·설치된 스킬만 정규화), 실패 문구와 반복 알림, `opencode` 세션에는 dsh 도구 없음, 공통 압축과 압축 뒤 덧붙인 메시지, `codex → dsh` 전환 안내와 `exec_command`→`pwsh` 번역.
- own-web: `harness/harness.test.ts`(알약·메뉴의 이름과 설명, 변형 설명, 내 지시문 없을 때), `default-state.test.ts`(설정의 `DeepSeek 방식`과 한 줄 설명), `transcript/tool-alias.test.ts`(pwsh 셸 카드, `file_path` 이름 바꾸기), i18n 낱말 시험.
- own-team `assets/guard.test.ts`(dsh `write{file_path}`와 `pwsh`), own-protocol `rpc-harness.test.ts`.
- 실계정(2026-10-19): `own/reports/harness-live-2026-10-19.md`. bugfix 과제를 DeepSeek V4 Pro에서 dsh 7번(원본 5, 개선판 2)·pi 5번·codex 5번, Claude Opus 5.5에서 dsh 4번 돌려 모두 성공했다. 시험 중 rg 받기(§3)와 도구 순서(§2.3)를 고쳤다.
