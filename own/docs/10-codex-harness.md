# 10. own 하네스 (Codex 기준)

| 항목 | 값 |
|---|---|
| 문서 상태 | Draft v0.1 (2026-10-11). 설계만. 구현 전 |
| 목적 | 모든 모델이 쓰는 own 하네스를 하나 만든다. 기준은 Codex CLI이고, 모델에게 보이는 것과 그 결과를 만드는 동작을 Codex와 거의 같게 맞춘다. 기존 OpenCode 하네스는 선택지로 남기고, 이후 다른 하네스도 같은 틀로 더한다 |
| Codex 기준 | `openai/codex` `8c0f701167`(2026-10-11, Apache-2.0). 로컬 사본 `D:\#Projects\own-open-code\refs\codex`. 이 PC의 Codex CLI는 0.157 |
| 조사 근거 | `own/reports/`의 하네스 평가(2026-10-11)와 이 문서 §2의 Codex 지도. 경로 표기 `codex:`는 `codex-rs/` 기준 |
| 관련 문서 | 02 §4.3(결정성 D1–D10), 07(프리셋), FORK §6(코어 패치 ledger), §10(라이선스) |

---

## 0. 결정 (사용자, 2026-10-11)

| 번호 | 결정 |
|---|---|
| H-D1 | **하네스 통일.** 모든 모델(GPT, Claude, DeepSeek 등)이 같은 own 하네스로 일한다. 새 세션 기본은 `codex`(Codex 기준), 선택지로 `opencode`(OpenCode 기본)를 둔다. 하네스는 앞으로 더 늘린다 |
| H-D2 | **Codex와 거의 동일.** 프롬프트뿐 아니라 Rust 안의 동작(요청 구성, 문법 기반 도구, 결과 형식, 자르기, 압축·중단 처리)까지 맞춘다. 필요하면 코어를 고친다. 코어 패치는 패치마다 ledger에 적고 사용자 예외 승인을 단다(FORK §6) |
| H-D3 | **기존 세션**은 손대지 않고 `opencode` 하네스로 표시만 한다 |
| H-D4 | **도중 전환 허용.** 하네스를 바꿔도 세션이 이어지게 이전 도구 기록을 결정적으로 번역하고, 전환 안내를 한 번 남긴다. 02 D5(전환 안내 없음)의 예외다. 전환 때 캐시를 한 번 처음부터 쓴다 |
| H-D5 | Codex의 프롬프트와 도구 문구는 **데이터**로 가져온다(모델 카탈로그 일부). 코드에 박지 않고, Codex 변경은 추적 스크립트로 따라간다. Apache-2.0 표기와 NOTICE를 둔다 |
| H-D7 | **기본 지시문은 하네스의 원본이 기본이다**(사용자, 2026-10-14). Codex 방식은 Codex CLI의 것, Pi 방식은 Pi의 것을 그대로 쓴다. own이 고친 판은 세션마다 고를 수 있는 선택지로만 둔다(§3.9). **고침(2026-10-16, UI-D8)**: 처음 값은 여전히 원본이다. 다만 설정 > 일반의 `지시문`에서 개선판을 새 대화의 기본값으로 정할 수도 있다(서비스의 `defaults.set`, §3.8). 화면 이름은 `기본 지시문`/`own 개선판`에서 `지시문`/`개선판`으로 바뀌었다. **고침(2026-10-17, 사용자)**: 새 최상위 세션은 팀이 만든 것까지 개선판으로 시작한다. 플러그인 옵션 `prompt`의 처음 값이 `own`이다. 설정 > 일반에 저장한 서비스 기본값이 있으면 그것이 이긴다(UI-D8). 원본은 고를 수 있는 선택지로 남는다 |
| H-D6 | **코어 패치는 더하기만 한다.** 하네스용 코어 패치는 패치 예산의 예외로 승인한다(사용자, 2026-10-11). 단 기존 코어 동작은 그대로 살아 있어야 한다. 패치는 어떤 하네스도 쓰지 않으면 동작이 바뀌지 않는 **확장 지점**이고, Codex 전용이 아니라 이후 다른 하네스 플러그인도 쓸 수 있게 일반적으로 만든다. `opencode` 하네스는 패치가 있어도 지금과 같은 바이트를 보낸다(§4의 비교로 확인) |
| CAG(2026-10-31) | **Claude Agent 경로**(02 §8.10)의 기본 하네스는 새 `claude-code`(Claude Code 자신의 지시문)다. 다른 하네스는 자기 지시문을 프로바이더 옵션으로 넘겨(전달 방식) Claude에 닿게 한다(3.12) |

---

## 1. 하네스란 (이 문서의 범위)

하네스 = 모델에게 보이는 모든 것 + 그것을 만드는 동작이다. own 하네스 프로필은 아래 여섯 층을 정한다. 대화 저장, 스트리밍, 계정·전환·캐시(own-accounts), 팀·원격·화면은 하네스 밖이고 모든 하네스가 같이 쓴다.

| 층 | 내용 |
|---|---|
| 요청 구성 | 지시문을 어디에 어떤 순서로 넣는지, 요청 필드 |
| 프롬프트 | 기본 지시문, 권한·협업 문구, 환경 정보, AGENTS.md 형식 |
| 도구 목록 | 이름, 설명, 입력 형식(JSON 또는 문법) |
| 도구 결과 | 결과 머리말, 오류 문구, 자르기 규칙 |
| 루프 동작 | 중단·모델 전환 안내, 압축, 재시도 |
| 승인·실행 환경 | 승인 문구, 샌드박스 |

---

## 2. Codex가 실제로 하는 것 (`8c0f701167` 기준)

### 2.1 프롬프트는 모델 카탈로그에서 온다

- 모델마다 기본 지시문이 `codex:models-manager/models.json`의 `model_messages.instructions_template`에 있다(11개 모델, 17–22k자). 모델 id는 가장 긴 접두어로 고른다(`codex:models-manager/src/manager.rs` 865-929).
- 카탈로그는 도구 방식(`tool_mode`, `use_responses_lite`, `apply_patch_tool_type`), 자르기 정책(모두 `tokens 10000`), 추론·verbosity 기본값도 정한다. 원격 `/models`로 바뀔 수 있다.
- 카탈로그에 없는 모델은 `codex:models-manager/prompt.md`(21,178자)를 쓰고 **`apply_patch`가 없다**(`codex:models-manager/src/model_info.rs` 98-157).
- `update_plan`은 2026-08-31부터 기본 꺼짐이고, 꺼져 있으면 프롬프트의 계획 문단을 지운다(`codex:prompts/src/update_plan_instructions.rs`).

### 2.2 요청 입력 순서 (`codex:core/src/client.rs` 950-1084, `codex:core/src/session/mod.rs` 4317-4592)

1. (Responses Lite만) `additional_tools` 입력 항목: 모든 도구를 `functions` 네임스페이스로 묶음
2. **기본 지시문**: `instructions` 필드가 아니라 첫 `developer` 메시지(2026-10-05부터)
3. **developer 메시지 하나**에 조각들: `<model_switch>`(모델이 바뀐 때) → 설정의 개발자 지시 → `<skills_instructions>` → `<permissions instructions>` → `<collaboration_mode>` → (해당 시) persistent·apps·plugins 안내 → `<tools>`(지연 도구 이름공간, 0.167.0부터) → 멀티 에이전트 안내
4. 따로 넣는 developer 메시지들(멀티 에이전트 역할 등)
5. **user 메시지 하나**: `# AGENTS.md instructions` + `<INSTRUCTIONS>` 블록, 그리고 `<environment_context>`(cwd, shell, current_date, timezone, network, filesystem)
6. 대화. 이후 턴에는 바뀐 조각만 다시 넣는다

요청 필드: `tool_choice:"auto"`, `parallel_tool_calls`(Lite면 false), `reasoning{effort, summary?, context?}`(Lite면 `context:"all_turns"`), `store:false`, `include:["reasoning.encrypted_content"]`, `prompt_cache_key`=스레드 id, `text.verbosity`(기본 low), `client_metadata`.

### 2.3 도구 두 방식

| 방식 | 모델 | 모델이 보는 도구 |
|---|---|---|
| Direct | gpt-5.5 | `exec_command`, `write_stdin`, `apply_patch`(**freeform, Lark 문법**), `view_image`, `request_user_input`, `web_search`(호스팅), 그 밖 MCP·멀티 에이전트 |
| Code Mode Only + Responses Lite | GPT-6, GPT-5.6 등 | freeform `exec`(JavaScript) + `wait`가 중심. 나머지 도구는 `exec` 안에서 `tools.<name>()`으로 부름. 설명에 TypeScript 선언이 붙음 |

예전 `shell`·`shell_command`와 JSON `apply_patch`는 2026-08-20에 없어졌다.

### 2.4 결과 형식과 자르기

- `exec_command`/`write_stdin`: `Chunk ID`, `Wall time: X.XXXX seconds`, `Process exited with code N` 또는 `Process running with session ID N`, `Original token count`, `Output:` 다음 본문(`codex:core/src/tools/context.rs` 380-575).
- 한 번 실행 형식(`apply_patch` 포함): `Exit code`, `Wall time: X.X seconds`, `Total output lines`(잘렸을 때), `Output:`(`codex:core/src/tools/mod.rs` 87-140).
- 자르기: 4바이트=1토큰, 가운데를 잘라 `…N tokens truncated…`, 기본 10,000토큰 + 1.2배 여유, 수집 버퍼 1 MiB(앞뒤 512 KiB)(`codex:utils/string/src/truncate.rs`, `codex:utils/output-truncation/src/lib.rs`).
- 모르는 도구: `unsupported call: {name}`. 중단된 도구: `aborted by user`.

### 2.5 `apply_patch`

문법은 `codex:core/assets/tools/apply_patch.lark`(18줄). 파서는 관대 모드(앞뒤 공백, heredoc 감싸기 허용), 4단계 느슨한 일치(정확 → 끝 공백 → 양끝 공백 → 유니코드 정규화), 줄바꿈은 원래 것을 유지(2026-10-05). 오류 문구와 25개 시나리오 시험이 있다(`codex:apply-patch/tests/fixtures/scenarios/`). own의 `patch`(upstream `packages/util/src/patch.ts`)가 같은 계열이지만 오류 문구와 줄바꿈 처리가 다르다.

### 2.6 루프 동작

- 압축: OpenAI는 원격 v2(요청 끝에 `compaction_trigger` 항목), 그 밖은 로컬 요약(`codex:prompts/templates/compact/prompt.md`, `summary_prefix.md`). 기준은 own 공통 압축의 core 기준(큰 창은 창의 85%, upstream v2.1).
- 중단: 다음 요청에 `<turn_aborted>` 조각. 모델 전환: `<model_switch>` 조각에 새 모델의 지시문 전체.

---

## 3. own 설계

### 3.1 패키지

- `packages/own-harness`(`@own/harness`, 플러그인 `own.harness`, 플러그인 순서 맨 뒤). 하네스 레지스트리, 세션 바인딩, 요청 훅, 도구, 결과 형식, 전환과 기록 번역을 맡는다.
- `src/opencode/`: 아무것도 바꾸지 않는 기준 하네스.
- `src/codex/`: Codex 기준 하네스.
- `src/pi/`: Pi 코딩 에이전트 기준 하네스 `pi`(12). 데이터 표기는 `pi-data/`(MIT NOTICE).
- `src/dsh/`: DeepSeek deepseek-harness 기준 하네스 `dsh`(13, 2026-10-19). 데이터 표기는 `dsh-data/`(MIT NOTICE, 옮긴 파일 해시, dsh 스냅샷).
- `codex-data/`: Codex에서 가져온 데이터(카탈로그 일부, `prompt.md`, `apply_patch.lark`, 도구 설명 문구, 압축 문구)와 NOTICE. 생성 스크립트가 만들고 손으로 고치지 않는다.

### 3.2 세션 바인딩

- 세션을 만들 때 `metadata["own.harness"] = {id, v}`를 넣는다. 자식 세션은 이를 물려받는다(upstream `core/session.ts` 284-287). 값이 없으면 `opencode`.
- 기본 지시문 변형(§3.9)은 같은 값의 `prompt`다. 원본(`reference`)이면 키를 쓰지 않아 값이 `{id, v}` 그대로이고, own 개선판이면 `{id, v, prompt: "own"}`이다. 자식은 하네스와 함께 물려받는다. own이 metadata를 다시 쓰는 Codex 멀티 에이전트 자식도 부모의 변형을 받는다(`sessions.ts` `stamp`).
- 새 최상위 세션의 기본값은 **서비스**가 정한다(2026-10-16, UI-D8): 설정 > 일반에서 고른 값(RPC `defaults.set`, 플러그인 storage의 `defaults`)이 있으면 그것, 없으면 플러그인 옵션 `default`·`prompt`(처음 값 `codex`·`own`. `prompt`는 2026-10-17까지 `reference`였다, H-D7). `session.created`마다 이 값을 읽어 metadata 없는 최상위 세션에 찍는다(`src/defaults.ts`, `index.ts`). 그래서 이 창, 휴대폰, 다른 PC, 팀 메인·담당·동료가 같은 기본값으로 시작한다. 자식은 계속 부모를 물려받는다. 저장된 값이 깨졌으면(디코드 실패) 옵션으로 돌아간다.
  - 저장값에는 플러그인 옵션과 다른 칸만 남긴다(2026-10-17 리뷰). 설정 > 일반은 한 줄만 바꿔도 다른 줄에 보이는 값까지 함께 보낸다. 그것을 다 저장하면 하네스만 바꿔도 그때의 지시문 처음 값이 굳는다. 옵션과 같은 칸은 저장하지 않으므로 옵션의 처음 값이 바뀌면 따라간다. 옵션과 다르게 고른 칸(예: 원본)은 다른 줄을 바꿔도 남는다.
  - 2026-10-17 전에 저장된 값(`version` 없음)에서는 하네스만 쓰고, 지시문은 `own`일 때만 쓴다. 그때의 `reference`는 대부분 하네스를 바꿀 때 딸려 저장된 옛 처음 값이라, 일부러 고른 원본과 구별할 수 없다. 그래서 이런 설치도 개선판으로 시작한다. 일부러 원본을 골라 두었다면 설정 > 일반에서 한 번 다시 고른다.
- 전환은 RPC `own.harness.set{sessionID, id}`. 실행 중이 아닐 때만 받는다.

### 3.3 요청 구성 (`context`·`compaction`·`generate` 훅, 같은 변환, D1·D2를 지킴)

`codex` 하네스일 때:
1. `system`을 비우고, 앞쪽 메시지로 §2.2의 순서를 만든다. 대화 중간의 system 역할 메시지는 Responses에서 `developer`로 나가므로(upstream `ai/protocols/open-responses.ts` 614-628) 기본 지시문과 developer 묶음은 앞쪽 system 메시지로, AGENTS.md와 `<environment_context>`는 앞쪽 user 메시지로 넣는다.
2. 기본 지시문: 모델이 카탈로그에 있으면 그 템플릿, 없으면 `prompt.md`. 모델 계열별 조정 칸을 둔다. 2026-10-16부터 own 개선판의 짧은 지시문 층이 쓴다(§3.9).
3. own의 지시문 항목(`own.preset`, `own.team.role`)과 Code Mode 카탈로그, skill 목록은 Codex의 조각 형식으로 옮겨 developer 묶음에 넣는다.
   - 설정 `instructions`(glob으로 찾은 파일과 http(s) URL, upstream 1e63a3bb73)는 Codex의 `developer_instructions` 설정처럼 다룬다: 내용을 빈 줄로 이어 developer 묶음의 맨 앞(설정 에이전트의 `system` 다음)에 하나로 넣는다. 빈 내용은 넣지 않는다(Codex도 빈 `developer_instructions`는 넣지 않는다). AGENTS.md 블록에는 own 전역 AGENTS.md(Codex의 사용자 지시)와 프로젝트 AGENTS.md(루트부터)만 간다. core 기준선은 경로만 남기므로 `Baseline.sources`가 모양으로 가른다: 맨 앞의 작업 폴더 밖 AGENTS.md는 전역, 이어지는 작업 폴더와 그 위 폴더의 AGENTS.md는 프로젝트, 그 밖의 첫 항목부터는 설정 것이다. 설정 `instructions`가 없는 세션의 요청 바이트는 전과 같다.
     - 작업 폴더는 core가 푸는 대로 실제 경로로 푼 것(`realCwd`)과 견준다. 플러그인이 위치마다 한 번 `realpath`로 구해 요청 빌드에 넘긴다(빌드는 순수 함수로 둔다). core는 걷는 폴더와 찾은 파일을 실제 경로로 적으므로(`fs.resolve`), junction이나 심볼릭 링크로 연 위치를 클라이언트가 쓴 경로와 견주면 프로젝트 AGENTS.md가 모두 전역이나 설정 것으로 잘못 갈린다.
     - 모양으로 가를 수 없어 남는 경우(기준선에 출처가 없다): ① 앞에 전역·프로젝트 AGENTS.md가 없으면 작업 폴더와 그 위 폴더 밖의 설정 `AGENTS.md`는 전역으로 읽힌다. ② core가 걷지 않은 작업 폴더나 그 위 폴더의 설정 `AGENTS.md`(프로젝트 루트나 걷기를 멈추는 홈 폴더보다 위, 또는 프로젝트 찾기가 꺼진 때)가 전역·프로젝트 파일 바로 다음에 오면 프로젝트 파일로 읽힌다. ③ 작업 폴더가 전역 설정 폴더 안에 있으면 전역 AGENTS.md가 프로젝트 파일로 읽힌다. ④ 그 자체가 심볼릭 링크인 프로젝트 AGENTS.md는 대상 경로로 적힌다. 대상이 그 폴더들 밖이면 맨 앞일 때 전역으로 읽히고, 아니거나 이름이 다르면(AGENTS.md → CLAUDE.md) 그 파일과 뒤의 모든 파일이 설정 것으로 읽힌다.
4. 도구를 Codex 목록으로 바꾼다(§3.4). 필드: `parallelToolCalls`, `textVerbosity`, `reasoningSummary`, `include`, `store`를 Codex 값으로 맞춘다.
5. 모든 변환은 저장된 기록과 대상 모델만으로 정해지는 순수 함수다. 시간·시도 횟수에 따라 바뀌는 바이트를 넣지 않는다(날짜는 세션 기준선의 날짜를 쓴다).

### 3.4 도구

| Codex 도구 | own 구현 | 비고 |
|---|---|---|
| `exec_command`, `write_stdin` | 새로 구현. 세션 ID가 있는 실행 프로세스(최대 64), 출력 수집 1 MiB 앞뒤 버퍼, `yield_time_ms`, PTY 선택 | upstream `shell`과 권한(`shell`)·명령 검사를 같이 쓴다. Windows는 pwsh와 ConPTY. 읽기 전용에서는 단순한 읽기를 own이 직접 답하고, `write_stdin`은 아무 프로세스에도 닿지 않는다(§3.10) |
| `apply_patch` | Codex 파서·적용 규칙을 옮겨 새로 구현(오류 문구, 줄바꿈 유지) | 처음에는 JSON `{input}`, 코어 확장 뒤 freeform |
| `view_image` | 새 구현(이미지 읽어 첨부) | 이미지도 `read`를 묻는다(실제 경로까지, §3.10) |
| `request_user_input` | upstream `question`을 빌려 감싼다 | |
| `update_plan` | Codex처럼 기본 꺼짐. 켜면 own 할 일 표시로 연결 | |
| `web_search` | OpenAI 계열은 `전체 허용`에서 호스팅 도구, 그 밖(`묻기`·`읽기 전용`, 다른 모델)은 own 웹 검색(MR12-5) | |
| `exec`, `wait` (Code Mode Only) | upstream Code Mode 해석기(`packages/codemode`) 위에 Codex 도우미(`text`, `image`, `store`/`load`, `notify`, `setTimeout`, `exit`, `yield_control`, `ALL_TOOLS`, 첫 줄 `// @exec:` 설정)를 얹는다 | 3단계 |
| 멀티 에이전트(`spawn_agent` 등) | own 하위 에이전트와 프리셋 관문으로 연결 | 뒷단계. 그전에는 own `subagent` 도구를 그대로 둠 |

### 3.5 결과 형식

§2.4의 머리말과 자르기 규칙을 그대로 옮긴다. 결과는 도구가 직접 만들고 `metadata.truncated`를 세워 upstream의 앞부분 자르기를 건너뛴다(upstream `core/tool-output.ts` 68).

### 3.6 코어 확장 지점 (패치 후보)

플러그인으로 안 되는 것만 코어에 확장 지점으로 넣는다. 본체는 `own-harness`에 둔다.

| 후보 | 내용 | 필요한 이유 |
|---|---|---|
| P-019 freeform 도구 | 도구 정의에 문법 형식을 더하고, Responses에서 `type:"custom"`으로 보내며, `custom_tool_call`(입력 delta 포함)을 읽고 다시 보낼 때 `custom_tool_call`·`custom_tool_call_output`으로 낸다 | `@opencode/ai`가 function 도구만 보낸다(`ai/protocols/open-responses.ts` 453-464) |
| P-020 Responses Lite | `additional_tools` 입력 항목, `tools` 필드 생략, `reasoning.context` | GPT-6 계열의 실제 요청 모양 |
| P-021 요청 세부 | 항목 ID(`msg_<uuidv5>`, `at_<uuidv5>`), `client_metadata` 등 훅으로 못 맞추는 필드 | §4 비교에서 차이가 남을 때만 |
| P-022 루프 동작 | 중단 뒤 `<turn_aborted>`, 원격 압축 v2(`compaction_trigger`) | 훅으로 못 맞출 때만 |

각 패치는 `OWN-PATCH(P-0xx)` 표시, ledger 항목, `over_budget: true`와 사용자 `exception_approval`(H-D6, 2026-10-11)을 갖는다(FORK §6.1 5). 모든 패치는 H-D6대로 더하기만 한다. 예를 들어 P-019는 도구 정의에 선택 필드를 더할 뿐이라, 그 필드를 쓰지 않는 도구와 `opencode` 하네스의 요청은 패치 전과 바이트가 같아야 한다. 이것을 패치마다 시험으로 확인한다.

### 3.7 하네스 전환과 기록 번역

- 전환하면 다음 요청부터 새 하네스의 요청 구성과 도구를 쓴다. 이전 도구 호출 기록은 요청을 만들 때마다 같은 규칙으로 번역한다. 예: `shell{command}` ↔ `exec_command{cmd}`, `patch{patchText}` ↔ `apply_patch` 입력, 결과 머리말은 원래 결과 텍스트를 그대로 둔다. 번역할 수 없는 도구(`edit`, `write` 등)는 원래 이름 그대로 두고 전환 안내에 적는다.
- 전환 때 durable system 메시지 하나: "하네스가 X에서 Y로 바뀌었다. 지금 쓸 수 있는 도구는 …. 앞의 다른 이름 도구 호출은 기록이다."
- 결정적이므로 전환 뒤 요청은 다시 캐시를 탄다.

### 3.8 화면

화면 이름은 **에이전트 방식**이다(2026-10-16, 03 §14.1). 화면에 `하네스`라는 말은 쓰지 않는다. 이름은 `Codex 방식` / `Pi 방식` / `DeepSeek 방식`(13, 2026-10-19) / `OpenCode 기본`, 지시문 변형은 `지시문`: `원본` / `개선판`.

- **설정 > 일반**(`harness/default-setting.tsx`): `새 대화의 에이전트 방식` [Codex 방식 | Pi 방식 | DeepSeek 방식 | OpenCode 기본](고른 방식의 한 줄 설명이 줄 설명 앞에 붙는다, 2026-10-19)과(OpenCode 기본이 아니면) `지시문` [원본 | 개선판 | 내 지시문(§3.11, 그것을 아는 서비스에서만)]. 바꾸면 이 PC 서비스의 `defaults.set`을 부르고 `새 대화의 에이전트 방식을 {name}(으)로 정했어요`. 설명은 `팀 모드 대화, 휴대폰과 다른 PC에서 만든 대화도 이 값으로 시작해요.` 범위가 `local`이라 휴대폰·다른 PC 창에서는 잠기고 `PC의 앱 창에서 바꿀 수 있어요.` `defaults.set`을 모르는 옛 서비스(`rpc.method_not_found`)는 `이 서비스에서는 기본값을 바꿀 수 없어요…`를 보이고 옵션 값을 그대로 쓴다. SSH 원격 호스트는 자기 플러그인 옵션(처음 값 `codex`·`own`)을 쓴다.
- **새 대화 화면의 알약**: 서비스의 기본값(`list`의 `default`·`defaultPrompt`)을 보인다. 새 대화 화면을 열 때마다, 그리고 창이 다시 포커스를 받을 때마다 다시 읽는다(다른 창의 설정 > 일반에서 바꿨을 수 있으므로). 여기서 고르면 **그 화면의 새 대화 하나에만** 쓴다. 고른 값은 서버와 화면(프로젝트 하나의 새 대화 화면, 또는 홈)에 묶여, 설정 같은 페이지를 거쳐 다른 프로젝트의 새 대화 화면으로 가도 그곳에는 쓰이지 않는다. 알약이 있는 채로 다른 새 대화 화면으로 옮기거나 대화를 만들면 버린다. 창에 저장하지 않는다(localStorage 키 `own.web.harness.newSession*`는 더 쓰지 않으므로, 예전에 이 창에서 Pi나 개선판을 골라 둔 사용자는 설정 > 일반에서 한 번 정하면 된다). 입력창은 첫 전송 때 알약이 보이는 값을 새 세션 metadata에 넣는다. 그래서 서버의 찍기를 기다리는 동안 알약이 `OpenCode 기본`으로 보이지 않고 첫 요청도 그 방식이다. 기본값을 아직 모르면(`list` 실패) 아무것도 넣지 않고 서버가 찍는다.
- **대화 머리의 알약**: 앞에 에이전트 아이콘, 이름(개선판이면 `· 개선판`), 이름·툴팁 `에이전트 방식: {name}`. 기존 세션은 `OpenCode 기본`. 머리줄이 좁으면 짧은 이름(`Codex`/`Pi`/`OpenCode`)이 되고, 대화 화면의 아주 좁은 머리줄(640px 미만, 휴대폰)에서는 숨는다(03 §4.4). 새 대화 화면에서는 숨지 않는다.
- **메뉴**: `이 대화의 에이전트 방식` 네 줄(설명: Codex `Codex CLI의 지시문과 도구로 일해요. GPT 모델에 가장 잘 맞아요.`, Pi `Pi 코딩 에이전트처럼 읽기·실행·고치기·쓰기 네 도구로 가볍게 일해요.`, DeepSeek `DeepSeek가 만든 코딩 에이전트(dsh)의 지시문과 도구로 일해요. DeepSeek V4 모델에 맞춰져 있어요.`, OpenCode `OpenCode의 원래 방식이에요. 예전에 만든 대화도 이 방식이에요.`), 아래칸 `지시문`(OpenCode 기본에서는 숨김, `내 지시문`과 `지시문 보기·고치기` 링크는 §3.11), 캐시 안내 `다음 메시지부터 바뀌어요. 지시문과 도구가 바뀌어 대화 앞부분 캐시를 한 번 새로 써요…`, 설명서 10.12 링크. 실행 중이면 줄을 잠그고 `지금 실행 중이라 바꿀 수 없어요. 응답이 끝나면 다시 열어 주세요.`, `switch` 범위가 없는 기기는 `이 기기에서는 바꿀 수 없어요. PC의 앱 창에서 바꿔 주세요.`
- **대화 `⋯` > `에이전트 방식 바꾸기…`**: 최상위 대화에서 같은 메뉴를 연다. 알약이 화면에 있으면 알약 아래, 숨었으면 가운데. 닫으면 포커스는 알약(보이면) 또는 `⋯` 단추로 돌아간다.
- 도구 카드는 `exec_command`·`apply_patch` 등 새 이름도 알맞게 그린다.
- 다른 창이 기본값을 바꾼 것은 이벤트로 알리지 않는다. 입력창이 만들 때 알약이 보이는 값을 metadata에 넣으므로, 새 대화 화면을 열어 둔 다른 창은 그 창이 다시 포커스를 받기 전까지 옛 기본값을 보이고, 그사이 그 창에서 만든 대화도 **보인 값(옛 기본값)으로** 시작한다. 서버가 새 기본값으로 바꿔 찍지 않는다. 그 창으로 돌아가 포커스를 주면(창을 누르거나 고르면) 다시 읽어 새 값을 보인다(2026-10-16 리뷰, 받아들인 차이는 포커스를 받지 않은 채 만든 경우뿐).
- **메뉴의 포커스**: 메뉴를 열면 고른 줄에 포커스가 간다. 실행 중이거나 `switch` 범위가 없어 모든 줄이 잠겼으면 메뉴 자체가 포커스를 받아, Esc로 닫힌다.
- **대화 `⋯`의 요청**: `에이전트 방식 바꾸기…`는 그 대화의 알약이 바로 받는다. 받을 알약이 없으면 요청을 버리므로, 나중에 그 대화의 알약이 생길 때 메뉴가 저절로 열리지 않는다.

### 3.9 기본 지시문 변형 (2026-10-14)

- **결정 H-D7**(2026-10-17 고침): 새 최상위 세션의 처음 값은 own 개선판이다. 원본은 세션마다, 그리고 설정 > 일반에서 고를 수 있다. 2026-10-14부터 2026-10-16까지는 원본이 처음 값이었다.
  - Codex 방식에서 카탈로그의 GPT 모델은 두 변형의 바이트가 같다(아래).
  - Pi 방식에서는 GPT를 포함한 모든 모델이 개선판의 한 줄 Code Mode 목록을 받는다.
- **저장**: §3.2의 `prompt`. 새 최상위 세션의 기본값은 서비스의 저장값(`defaults.set`), 없으면 플러그인 옵션 `prompt`(기본 `own`, 2026-10-17. 그 전에는 `reference`)다(§3.2). 메타데이터에 변형을 적지 않은 세션(원본을 고른 세션과, 변형이 생기기 전에 만든 세션)은 원본이다(`PROMPT_FALLBACK`). RPC `own.harness.session.set{sessionID, harness, prompt?}`가 바꾸고, `prompt`를 빼면 지금 변형을 유지한다. 변형만 바꿀 때는 전환 안내를 남기지 않는다. 다음 요청부터 다른 지시문이 가므로 그때 캐시를 한 번 처음부터 쓴다. `list`는 `prompts`와 `defaultPrompt`를(2026-10-18부터 `custom`도), `session.get`·`session.set`은 `prompt`를 돌려준다. 세 번째 변형 `custom`(내 지시문)은 §3.11이다.
- **Codex 방식의 개선판**(`src/codex/variant.ts`, 2026-10-16 개정):
  - Codex 카탈로그에 있는 GPT 모델은 개선판에서도 원본과 같다. OpenAI가 모델마다 맞춘 글이고, 골든 시험이 그 바이트를 지킨다.
  - 카탈로그 밖 모델은 모델 ID로 두 층으로 나눈다(`CodexVariant.lean`).
    - **짧은 지시문 층**: Claude Opus 4.8 이후(Opus 5.x 포함), Fable, Mythos. Claude Code 2.1.154가 짧은 시스템 프롬프트를 준 모델과 같다. Claude Agent 경로(02 §8.10)의 모델 id인 Claude Code의 별칭 `opus`·`fable`(`[1m]` 포함)도 이 층이다(별칭은 Claude Code의 가장 새 Opus·Fable을 가리킨다, 2026-11-01). `sonnet`·`haiku`는 아니다. `prompt.md`(16,979자) 대신 own이 새로 쓴 `src/codex/variant-base.md`를 보낸다(보내는 글 4,345자). 그 안의 패치 절은 두 층이 함께 쓰는 `CodexVariant.PATCH`다.
      - Claude Code 글(2026-07-24)의 전환을 따랐다. 규칙 대신 판단, 예시 대신 형식, 도구 사용법은 도구 설명에만, 겹친 지시는 하나로 줄였다.
      - 담은 것: own 앱과 Markdown 화면, AGENTS.md 범위, 확인 방법, 진행 알림 한 줄, 마지막 답의 모양, 파일 링크(`[이름](경로:줄)`은 파일 탭에서 열림), 패치 형식과 `exec_command`로 보내는 `apply_patch <<'EOF'` 모양.
      - 다른 폴더 기준으로 패치하려면 `cd <폴더> &&` 대신 호출의 `workdir`를 쓰게 한다. own(Codex)의 heredoc 판별은 `cd C:\work &&`처럼 역슬래시가 든 Windows 경로를 받지 않아, 그 패치가 PowerShell로 그냥 넘어가기 때문이다.
      - 모델 ID 판별은 부분 일치다(`anthropic/claude-opus-4.8`, Bedrock `anthropic.claude-opus-5-5`, `-fast`도 해당). 날짜가 붙은 `claude-opus-4-20250514`는 4.0으로 읽는다. 모르는 ID는 아래 층으로 간다.
    - **그 밖**(Sonnet 전부, Haiku, Opus 4.7 이하, DeepSeek 등): `prompt.md`를 쓰되 열 곳을 own에 맞게 바꾼다.
      - 정체성 첫 줄("Codex CLI와 같은 도구·계획·승인"이라는 말은 뺐다), 권한 상승을 요청할 수 있다는 문장, "Codex는 OpenAI의 오픈소스 인터페이스" 문장, "사용자가 같은 컴퓨터에 있다", "CLI가 꾸밀 평문", "ANSI는 CLI가 입힌다".
      - `apply_patch` 줄: own에 없는 `{"command":["apply_patch",…]}` 형식 대신 짧은 지시문 층과 같은 패치 절(`CodexVariant.PATCH`: heredoc 모양, Add·Delete·Update와 `*** Move to`, `@@` 머리, 줄 앞 기호, 앞뒤 세 줄, `workdir`)을 주고, "`apply_patch` 도구는 없다. `exec_command`에 주는 `cmd`의 첫머리다"와 Codex의 예시 하나를 덧붙인다. 2026-10-14에 파일을 통째로 다시 쓴 모델(DeepSeek)이 이 층이라, 형식 설명이 짧은 층보다 적으면 안 된다.
      - "`apply_patch`를 부른 뒤 다시 읽지 마라. 도구 호출이 실패한다" 줄을 "`exec_command` 결과가 패치가 됐는지 알려 준다"로 바꾼다. 2026-10-16 실시험에서 DeepSeek이 이 줄 때문에 없는 `apply_patch` 도구를 한 번 불렀다.
      - 검증 안내의 Codex 승인 정책 이름(**never**, **untrusted**·**on-request**)을 own 모드 이름(**full**, **ask**)으로 바꾼다.
  - **두 층 모두**:
    - `<permissions instructions>`가 own 승인 모드를 실제 동작대로 설명한다.
      - 모드는 `전체 허용`·`묻기`·`읽기 전용`이다. 샌드박스와 권한 상승 요청은 없다. 명령은 작업 폴더가 있는 컴퓨터에서 진짜로 돈다(SSH 원격이면 원격 호스트).
      - 작업 폴더 밖 접근은 어느 모드에서도 묻지 않는다. v2.0.28부터의 upstream 동작이고, 2026-10-17에 사용자가 그대로 두기로 했다(FT-Q1). 그래서 문구도 밖을 따로 묻는다고 말하지 않는다. 문구에 폴더 경로는 넣지 않는다(경로는 `<environment_context>`에 있다). 그래야 다른 폴더의 대화와 팀 모드 작업 폴더가 이 블록을 캐시에서 읽는다. 2026-10-16 실시험에서 경로가 든 문구는 다른 폴더에서 시스템 글 약 2.3K 토큰을 다시 썼다. 보호 파일(자격 증명, own 설정) 패치는 늘 거절된다. `묻기`에서 거절 사유를 적으면 모델이 그 사유를 받고, 사유 없이 거절하면 턴이 끝난다.
      - `읽기 전용` 문구는 명령을 하나도 돌리지 않는다고 말하고, own이 직접 답하는 읽기(파일 하나나 그 일부, 폴더 목록, `rg`·`Select-String` 검색)를 명령 이름으로 알린다. 플래그는 나열하지 않는다. 한 셸에서만 받는 이름은 셸을 밝힌다(`head`·`tail`·`sed -n`은 bash·zsh·sh, `Get-Content`·`Get-ChildItem`·`Select-String`은 PowerShell). 보호 경로 없이 셸만 막은 규칙이라 읽기를 답하지 않는 세션에는 예전 문구(모든 `exec_command`가 권한 오류로 끝난다)를 준다(§3.10, 2026-10-17).
      - `묻기` 문구는 명령과 패치를 먼저 보여 주고 답을 기다린다고 말하고, 같은 읽기는 묻지 않고 own이 직접 답한다고 같은 명령 이름으로 알린다(RO-D4 고침, 2026-10-17). `.env` 읽기는 그래도 묻는다고 함께 적는다. own이 직접 답하다가 거절하는 읽기(16 MiB가 넘거나 글이 아닌 파일, 폴더에 쓴 `Select-String`, 프로젝트 밖 폴더 검색)는 결과가 그 사유를 말하고, 같은 일을 하는 다른 명령은 다른 명령처럼 묻는다고도 적는다. 그래서 모델이 그 거절을 막다른 길로 읽지 않는다. 보호 경로가 없는 `묻기` 규칙처럼 읽기를 답하지 않는 세션에는 이 문장들을 뺀다.
      - 화면 이름(`전체 허용`·`묻기`·`읽기 전용`, 영어 화면의 Full access·Ask·Read only)과 바꾸는 곳(대화 머리의 승인 모드 단추)도 알려 준다. 이 이름은 own-web `own.approval.full|ask|readOnly`(ko.ts·en.ts)와 같아야 하고, 화면 이름을 바꾸면 `variant.ts`의 `MODES`도 바꾼다.
    - `<environment_context>`에서 Codex 샌드박스가 지키는 `.git`·`.agents`·`.codex` 읽기 전용 항목을 뺀다. own은 이것을 막지 않는다. 남겨 두면 모델이 커밋을 못 한다고 여길 수 있다.
    - `exec_command` 입력에서 `sandbox_permissions`·`justification`·`prefix_rule`을 뺀다.
    - core Code Mode 목록을 Pi 개선판처럼 도구당 한 줄로 줄인다(`PiVariant.codemode`).
    - `spawn_agent` 설명의 Codex 계정 GPT 모델 목록을 뺀다. Codex 문장("기본은 내 모델") 뒤에 own 규칙 한 문장을 붙인다. 같은 공급자의 모델이고, `# Your Model`의 Model ID처럼 쓴다. 고정 목록은 넣지 않는다. 계정이나 모델이 바뀔 때마다 캐시 맨 앞의 도구 바이트가 바뀌기 때문이다.
    - 위임을 허락하는 근거에 `own.preset` 문맥의 위임 모드(프리셋의 나눠 맡기기 지시)를 더한다. 그 문맥의 역할·`agent`·`background`·추론 수준·모델 묶음 이름은 core `subagent` 도구에 맞춘 글이라 `spawn_agent` 인자가 아니라고 함께 적는다. 모델 묶음 이름을 `model`로 넘기면 collab-v1이 부모 공급자에서 없는 모델 ID를 만들어 하위 에이전트가 첫 요청에서 실패하기 때문이다(§8 Q3).
    - own에 없는 '갈라진 작업 공간' 두 줄을 고친다. own이 쓰지 않는 `reasoning_effort`를 뺀다.
    - 짧은 지시문 층은 위임 규칙도 짧은 글(1,087자)로 바꾼다.
  - core의 `# Your Model` 블록(모델 이름)을 남긴다. 원본은 Codex처럼 뺀다. GPT 템플릿에는 모델 이름이 있지만 대체 지시문에는 없다.
  - `<model_switch>`도 같은 변형, 같은 층의 지시문을 넣는다.
  - **측정**(가짜 공급자, 첫 요청 'hi', `bun script/prompt-capture.ts --prompt own`, 시스템 글 + 메시지 JSON + 도구 JSON 글자 수, 2026-10-16):

    | 요청 | 전 | 후 |
    |---|---|---|
    | codex · Claude Opus 5.5 | 49,856자 | 26,143자(−48%, 약 12.5K → 6.5K 토큰) |
    | codex · Claude Sonnet 5.5 | 49,860자 | 42,914자(−14%) |
    | codex · DeepSeek V4 Pro | 50,327자 | 43,381자(−14%) |

    원본(`reference`)의 모든 캡처와, 개선판의 GPT·Pi·OpenCode 캡처는 전과 바이트가 같다(임시 경로와 ID만 정규화). 비교: opencode · Claude 22,460자, pi · Claude 개선판 15,233자.
  - **실계정 비교**(2026-10-16, `own/reports/harness-live-2026-10-16.md`): Claude Opus 5.5와 DeepSeek V4 Pro로 bugfix·steps·delegate·catalog·search를 원본과 개선판으로 돌렸다(Claude $3.18).
    - 두 지시문 모두 모든 과제를 통과했다.
    - 파일 수정이 패치였던 비율: 개선판 Claude 15/15, DeepSeek 11/11. 원본은 둘 다 0이고, 모든 수정이 PowerShell 통째 쓰기였다.
    - Claude 첫 요청은 15.6K → 9.1K 토큰이다.
    - 합격 기준을 모두 넘어 짧은 지시문 층을 켠 채로 둔다.
  - 팀이 만드는 세션도 다른 새 최상위 세션처럼 서비스 기본값을 따른다. 2026-10-17에 사용자가 처음 값을 개선판으로 정했다(H-D7 고침, 보고서 §5의 질문).
  - 이제 `bun script/prompt-capture.ts`는 플러그인의 처음 값(개선판)으로 찍는다. 원본은 `--prompt reference`다. 2026-10-17 확인(임시 경로와 ID만 정규화): `--prompt reference` 캡처는 그 전의 기본 캡처와 바이트가 같다. 기본 캡처는 그 전의 `--prompt own` 캡처와 같고, Codex 방식 카탈로그 밖 모델(Claude·DeepSeek) 세 개의 `<permissions instructions>`만 다르다. 같은 날 `묻기` 문구에서 작업 폴더 밖을 따로 묻는다는 구절을 뺐기 때문이다(FT-Q1).
- **Pi 방식의 개선판**(`src/pi/variant.ts`): Pi 지시문은 그대로 둔다. `<addendum>`에 들어가는 core Code Mode 목록만 도구당 한 줄(경로, 인자 이름, 설명)로 줄인다. 2026-10-14 캡처에서 4,815자가 1,763자가 됐다. 목록을 모르는 모양이 하나라도 있으면 core가 쓴 그대로 둔다.
- **OpenCode 기본**: 변형이 없다. 메뉴에서도 숨긴다.
- 실측은 `own/reports/harness-live-2026-10-14.md` §6에 있다.

### 3.10 읽기 전용·묻기 모드의 읽기 (2026-10-17)

- **문제**: own에는 OS 샌드박스가 없어서 `읽기 전용`은 모든 셸 명령을 거절한다(`shell ** deny`). Codex의 모델은 파일을 `exec_command`로만 읽는다(`Get-Content`, `cat`, `rg`). 그래서 읽기 전용 대화에서는 파일 하나도 읽지 못했다. 원본 권한 문구("샌드박스는 파일 읽기만 허락한다")도 사실과 달랐다.
- **Codex는**(참고 클론 `refs/codex`, 하네스 기준 rust-v0.162.1):
  - 0.162.1은 Windows에서 샌드박스 없이 read-only + never이면 규칙에 없는 명령을 모두 거절한다(`core/src/exec_policy.rs` 789-806). 샌드박스가 있으면 명령을 돌리고 쓰기는 샌드박스가 막는다. own의 지금 동작과 같았다.
  - 안전한 명령 목록(`is_known_safe_command`, PowerShell은 `is_safe_command_windows`)은 2026-08-19 #39630(`942af8447b`)에서 지워졌다. 그 목록도 경로 인자를 보지 않아 `Get-Content ~\.claude\.credentials.json`을 통과시켰다. 2026-10-14에 가져오지 않은 이유다.
  - `read_file`·`list_dir`·`grep_files` 도구는 시험용 모델(`test-gpt-5`)에만 있었고 지금은 없다.
- **결정(RO-D1)**: 읽기 전용에서 `exec_command`가 단순한 읽기 명령을 **실행하지 않고** own이 직접 읽어 답한다(`src/codex/read-only.ts`). 프로세스는 띄우지 않는다. 도는 것은 core `grep`·`glob` 안의 고정 인자 ripgrep(`--no-config`, 전처리기 없음)뿐이라 쓰기는 일어날 수 없다. 안전은 해석기가 맞는지에 기대지 않는다. 내용을 돌려주는 파일마다 `read`를 물으므로 해석기가 틀려도 보호 경로는 지켜지고, 결과 모양만 달라진다.
- **결정(RO-D4 고침, 사용자 2026-10-17)**: `묻기`에서도 같은 읽기 명령을 같은 방법으로 승인 카드 없이 답한다. 그 밖의 명령은 전처럼 셸 승인(`shell.authorize`)으로 가서 묻는다. 아래의 권한 흐름, 폴더 검색 규칙(RO-R2), 홀로 있는 CR 처리, 결과 모양과 거절 글은 두 모드에서 같다. 크기·바이너리·폴더 검색의 거절 글은 그래서 모드 이름을 말하지 않는다. `묻기`에서도 보호 파일 읽기는 카드 없이 거절된다. 예전에는 카드에서 허락하면 셸이 그 파일을 읽었다.
- **받는 모양**: 이 밖의 플래그·단계·인자 수는 받지 않는다. 첫 표는 일부러 작다(설계 리뷰). `nl`, `wc`, `find`, `grep`, `Test-Path` 같은 것은 실계정 시험에서 모델이 필요로 할 때 더한다.

  | 종류 | PowerShell | POSIX 셸(bash·zsh·sh) |
  |---|---|---|
  | 파일 하나나 그 일부 | `Get-Content`·`gc`·`cat`·`type` 파일 하나(`-Path`·`-LiteralPath`)와 `-TotalCount`(`-Head`·`-First`), `-Tail`(`-Last`), `-Raw` 가운데 하나. 뒤에 `Select-Object -Skip k -First n` 한 단계 | `cat f`, `head`·`tail` [`-n N`·`-N`] `f`, `sed -n 'A,Bp' f`(`'Ap'`, `'A,$p'`) |
  | 폴더 한 단계 | `Get-ChildItem`·`gci`·`ls`·`dir` [폴더] [`-File`] [`-Force`] [`-Name`] | `ls` [`-1aAlFh`] [폴더] |
  | 하위 파일 전체 | `Get-ChildItem -Recurse -File` [`-Filter f`] [`-Name`] [`-Force`] | (두 셸 공통 줄) |
  | 내용 검색 | `Select-String` [`-Pattern`] `p` [`-Path`] 파일 [`-SimpleMatch`] [`-CaseSensitive`] | (두 셸 공통 줄) |
  | 두 셸 공통 | `rg` [`-n` `-i` `-F` `-l`] [`-g glob`] [`-e`] 패턴 [경로 하나], `rg --files` [`--hidden`] [`-g glob`] [폴더] | 같음 |

  - 경로는 글자 그대로여야 한다. 와일드카드(`* ? [ ]`), 변수, `\\서버` 경로, `:`가 든 스트림·공급자 경로(`a.txt:s`, `Env:`, `HKCU:`)는 받지 않는다. `~`는 홈 폴더로만(`~`, `~/…`) 받고, 검색과 하위 파일 목록에는 받지 않는다.
  - 셸 문법이 하나라도 있으면 받지 않는다: `;`, `&&`, 리디렉션, `$`, 백틱, 괄호, 줄바꿈, 유니코드 따옴표·대시, `--%`, 그 밖의 파이프. `cmd` 셸은 받지 않는다.
- **결과 모양**: 끝난 명령처럼 답한다. `Chunk ID`·`Wall time`·`Process exited with code N` 머리말, 1 MiB 앞뒤 수집, 자르기 규칙이 실제 실행과 같다(§3.5). 출력 모양은 실제 명령과 다를 수 있다.
  - PowerShell은 그 OS의 줄 끝, POSIX는 `\n`이다. 파일은 UTF-8(BOM은 뺀다)이나 BOM이 있는 UTF-16LE로 읽는다. 16 MiB가 넘거나 앞 8 KiB에 NUL이 있으면 읽지 않는다(종료 코드 1).
  - 폴더 한 단계: 이름을 한 줄씩, 폴더는 구분자로 끝난다. PowerShell의 표 형식이 아니고 폴더를 먼저 둔다.
  - 하위 파일 전체: core `glob`로 파일 이름만 얻는다(무시 파일을 따르고, `-Force`·`--hidden`이 없으면 숨김 파일을 뺀다, 2,000개까지). `Get-ChildItem -Recurse`는 전체 경로, `-Name`은 폴더 기준 상대 경로, `rg --files`는 rg처럼 보인다.
  - 검색: core `grep`으로 찾는다(숨김 파일 포함, 문맥 줄 없음, 500줄까지). rg 모양은 `경로:줄:글`이고 줄 번호는 `-n`일 때만, 파일 하나를 검색하면 경로가 없다. `-l`은 경로만 보인다. Select-String은 `상대경로:줄:글`이다. 찾지 못하면 rg는 종료 코드 1이다.
- **권한 흐름**:
  - 먼저 작업 폴더를 셸 승인과 같이 확인한다(`permission.paths`).
  - 파일이나 폴더를 읽을 때마다 `permission.paths`(작업 폴더 밖이면 `external_directory`)와 `read`를 묻는다. 실제 경로(`realpath`: 링크, 정션, 8.3 짧은 이름)가 글자 경로와 다르면 실제 경로로도 묻고, 실제 경로를 읽는다. 그래서 작업 폴더 안의 링크로도 보호 파일을 읽지 못한다. `.env`는 기본 규칙대로 묻는다.
  - 검색은 먼저 대상(파일이나 폴더)을 파일 읽기와 같이 확인한다. 그래서 보호 파일을 검색하면 패턴과 상관없이 권한 오류로 끝난다. 이 확인 전에는 대상이 있는지도 보지 않는다.
  - 폴더는 실제 경로가 프로젝트 안일 때만 검색한다(RO-R2). own의 보호 경로 규칙(승인 묶음의 꼬리)은 절대 경로라 프로젝트 안의 리소스(상대 경로)에는 걸리지 않는다. own-accounts의 `evaluate` 훅(01 §13 PP)은 상대 경로도 Location 폴더에서 풀어 판정하므로 core `grep`의 파일별 판정(P-031)이 프로젝트 안의 보호 파일도 뺀다. 그래서 찾지 못했다는 결과가 보호 파일에 대해 아무것도 알려 주지 않는다. 프로젝트 밖 폴더(`..`, 절대 경로, 밖을 가리키는 링크·정션)는 패턴과 상관없는 거절 글(종료 코드 2)로 답한다. 그 안의 파일 하나는 경로로 검색할 수 있다. core `grep`은 폴더 안의 링크를 따라가지 않는다.
  - core `grep`은 자기 `grep` 권한을 묻는다. 규칙이 `grep`을 거절하면 검색도 그 오류로 끝난다. 결과를 돌려주기 전에 맞은 파일 모두를 위와 같이 확인한다. 하나라도 거절되면 호출 전체가 권한 오류로 끝나고, 어떤 줄도 모델에게 가지 않는다. 맞은 줄의 파일을 확인하지 못해도 끝낸다.
  - 하위 파일 목록은 core `glob`가 `glob` 권한을 묻는다. 이름만 보이므로 glob 도구와 같다.
- **언제 답하나**: 세션 규칙에서 마지막 `{shell, **}` 규칙이 deny(`읽기 전용`)나 ask(`묻기`)이고, 그 뒤에 절대 경로 `{read, …, deny}`(own-accounts가 쓰는 보호 경로)가 하나 이상 있고, action이 `shell`에 맞는 규칙(`*` 같은 와일드카드 포함)이 그 뒤에 없을 때만이다(`CodexReadOnly.serves`). 뒤에 `{shell, Get-Content *, deny}` 같은 사용자 규칙이 있으면 own-accounts `modeOf`처럼 사용자 지정으로 보고 답하지 않는다(2026-10-17 리뷰). 하네스 도구 게이트의 allow(하네스를 바꾸면 맨 뒤에 붙는다)나 브라우저 연결 allow처럼 `shell`에 맞지 않는 뒤 규칙은 상관없다. 권한 문구의 모드를 고르는 `Fragments.mode`보다 엄격하다. `{shell, **}` 규칙이 없으면(`Fragments.mode`는 `묻기`로 읽는다) 답하지 않는다. 보호 경로 없이 셸만 막은 사용자 규칙은 예전처럼 모든 명령을 거절하고, own 개선판 권한 문구도 예전 거절 문구를 쓴다. 원본 문구(Codex 바이트, RO-D2)는 바꾸지 않으므로 이 경우 "샌드박스는 파일 읽기만 허락한다"는 말이 맞지 않는다. 보호 경로 없는 `묻기` 규칙은 예전처럼 읽기도 묻고, 개선판 문구도 그 읽기를 알리지 않는다. 세션 정보를 읽지 못하면 답하지 않는다. `전체 허용`에서는 답하지 않고 명령을 그대로 돌린다.
- **셸을 쓰지 않는 역할(2026-11-03, 결정 SA-1)**: 하위 에이전트 `explore`는 모든 승인 모드에서 셸이 막힌다(07 §2.4, own-accounts `ReadOnly`, 역할 목록은 `Preset.NO_SHELL_ROLES`). 그래서 부모가 `전체 허용`이면 `serves`가 거짓이라 `exec_command`가 셸 승인으로 가서 거절되고, explore는 파일 하나도 읽지 못했다(`읽기 전용`·`묻기`에서는 부모 묶음 덕에 읽었다). 이제 그런 역할의 세션은 승인 모드와 보호 경로 규칙과 상관없이 위의 읽기를 답한다(`CodexReadOnly.answers(rules, agent)`). 권한 흐름은 같다: 내용을 돌려주는 파일마다 `read`를 묻는다. 권한 문구도 역할에게는 `읽기 전용`으로 쓴다(`Fragments.mode(rules, agent)`: 고치지도 명령을 돌리지도 못하는 것이 사실이다). 표 밖의 명령은 거절되고, 거절 글은 own-accounts의 글(이 하네스에 없는 core `read`·`grep`·`glob`을 쓰라는) 대신 역할의 사유를 적는다(`refused(reason, agent)`). Code Mode의 `tools.exec_command`도 같다. Pi 방식의 `bash`도 같은 읽기를 답한다(12 §3.5). explore 자식은 Code Mode의 core `subagent`(MultiAgent v1 모델, 예: GPT-5.6 Luna)나 `@explore` 같은 core 경로로 생긴다. Codex의 `spawn_agent`는 부모의 에이전트로 자식을 만든다.
- **거절**: `읽기 전용`에서 표 밖의 명령은 전처럼 셸 승인(P-019)으로 가서 거절된다. 모델에게는 맨 권한 오류 대신 거절 사유와 own이 답하는 읽기를 적은 글을 돌려준다. 같은 명령을 그대로 다시 시도하지 않게 하려는 것이다(Code Mode의 `tools.exec_command`는 그 글로 실패한다). `묻기`에서는 표 밖의 명령을 셸 승인이 묻는다.
  - 명령 노드가 없는 문장은 예전에 셸 승인을 건너뛰고 실행됐다. PowerShell 식(`[IO.File]::WriteAllText(…)`), 식과 리디렉션(`'x' > 파일`), bash의 대입이나 리디렉션만 있는 문장이 그렇다. 이제 명령 전체로 `shell`을 묻는다(P-019 `ShellParse.asked`, RO-D5). `cd`·`Set-Location`만 있는 명령은 그대로 건너뛴다.
  - PowerShell은 홀로 있는 CR(뒤에 LF가 없는 `\r`)에서도 문장을 끝내는데, 셸 검사기는 그것을 공백으로 읽어 그 뒤 문장을 묻지 않았다. 이제 PowerShell 명령은 그런 CR을 줄바꿈으로 읽어 검사한다(`ShellParse.approval`). CR이 든 명령은 셸과 상관없이 명령 전체와 줄마다도 묻는다. bash는 CR을 낱말 안에 두는데 검사기는 그것도 공백으로 읽기 때문이고, 첫 명령에 저장한 '항상 허용' 규칙이 뒤 문장까지 덮지 않게 하려는 것이다(RO-R1).
  - 거절 글은 `읽기 전용`에서 규칙이 거절했을 때(`Permission.BlockedError`)만 준다. `묻기`에서 규칙이 거절하면 권한 오류가 그대로 간다. 사용자 규칙이 띄운 카드를 사용자가 사유와 함께 거절하면 그 사유가 `묻기`처럼 그대로 가고, 사유 없는 거절은 턴을 끝낸다. 다른 실패도 그대로 간다.
- **write_stdin(RO-D3)**: 읽기 전용은 프로세스를 띄우지 않으므로, 남아 있는 프로세스는 모드를 바꾸기 전에 띄운 것이다. 그런 프로세스에는 입력을 보내지 않고 출력도 읽지 않는다(`write_stdin failed: …`). 프로세스를 끝내지는 않는다.
- **view_image**: 모든 모드에서 이미지도 위와 같이 `read`를 묻는다(실제 경로 포함). 예전에는 아무 권한도 묻지 않았다.
- **바뀌지 않는 것**: 도구 목록과 `exec_command` 정의(모드에 따라 다른 것은 웹 검색뿐이다. 2026-11-03부터는 `전체 허용`만 호스팅 `web_search`, 나머지는 core `websearch`다, `request.ts` `hostedSearch`, MR12-5. 에이전트 규칙(사용자 설정)이 검색을 막으면 `전체 허용`에서도 `websearch`다, `searchDenied`, RL2-M2), 승인 규칙 묶음(own-accounts `CORE`, `modeOf`), 원본 권한 문구(Codex의 `sandbox-read-only.md`와 `approval-never.md`, 이제 사실에 더 가깝다, RO-D2). 골든과 프롬프트 캡처는 바이트가 같다. own 개선판의 읽기 전용 문구와 `묻기` 문구(2026-10-17)만 바뀌어, own이 답하는 읽기를 이름으로 알린다(§3.9).
- **남은 위험**:
  - `묻기`에서도 이 읽기는 카드 없이 프로젝트 밖 파일을 읽는다. read 도구와 같다(작업 폴더 밖은 어느 모드에서도 묻지 않는다, FT-Q1). 보호 파일은 막히고 `.env`는 묻는다.
  - 결과 모양이 실제 명령과 다르다. 목록 형식, 하위 목록은 파일만, 문맥 줄 없음, 정규식은 rg 문법(Select-String도), 대소문자 구분이 그렇다. 받지 않는 모양은 거절되고 모델이 한 번 더 시도한다.
  - 보호는 `read` 도구와 같은 수준이다. 실제 경로까지 보지만, 프로젝트를 홈 폴더나 OWN_HOME, 또는 그 위에서 열면 작업 폴더 안의 보호 파일이 Location 상대 리소스가 되어 절대 경로 규칙에 걸리지 않는다. read 도구와 Pi의 읽기에도 있는 기존 틈이다.
  - 하드 링크는 실제 경로로 구별되지 않는다. 작업 폴더 안에 전부터 있던 하드 링크는 보호 파일을 가리켜도 작업 폴더 안의 파일로 읽힌다.
  - 프로젝트 안 폴더 검색은 맞은 파일만 확인한다. 그래서 프로젝트 안에서 `read`를 묻거나 막는 상대 경로 규칙(`.env`의 묻기, 사용자가 더한 규칙)은 찾지 못한 결과에는 걸리지 않는다.
  - 모드를 바꾸기 전에 띄운 프로세스는 끝날 때까지 돈다(쓰기도 할 수 있다). 세션을 지우거나 서비스가 멈출 때 끝난다.
  - core `grep`·`glob` 도구는 2026-10-18부터 돌려줄 파일마다 `read`를 판정한다(P-031): `grep`은 `read`가 허용인 파일의 줄만 보여 주고 빠진 파일 수를 알리며, `glob`은 `read`가 거절인 경로만 뺀다. 그 전에는 OpenCode 기본·Pi 방식에서 보호 파일과 `.env`의 줄이 검색 결과로 나왔다(upstream #17073, not planned).
- **시험**: `test/unit/codex/read-only.test.ts`(받는 모양, 설계 리뷰의 공격 명령을 포함한 거절 목록, 문구가 이름 붙인 명령이 그 셸에서 모두 받아지는지, `serves`), `test/unit/codex/variant.test.ts`(읽기를 답하지 않는 읽기 전용 문구), core `test/shell-parse-asked.test.ts`(명령 노드 없는 문장, 홀로 있는 CR), `test/e2e/codex.test.ts`의 "codex harness in read-only mode"(읽기·검색·목록, 보호 파일과 폴더를 직접·`..`·절대 경로·정션·`Select-String`으로 찾되 맞는 패턴과 맞지 않는 패턴의 답이 같은지, 쓰기·명령 노드 없는 문장·홀로 있는 CR의 거절, 도구 목록, `묻기`, 보호 경로 없는 규칙, 사유를 적은 거절, write_stdin, view_image, Code Mode).

### 3.11 지시문 보기와 내 지시문 (2026-10-18)

사용자 요청(2026-10-18): 설명서나 자세한 설정에서 에이전트 방식마다 시스템 지시문, own이 실제로 고친 곳, 고칠 수 있는 곳을 자세히 보고, 원하면 고치고, 기본으로 되돌리고 싶다.

- **세 번째 변형 `custom`(화면 이름 `내 지시문`)**. `PROMPTS`는 `reference`·`own`·`custom`이다(`rpc-harness-routing.ts`). 내 지시문은 **개선판에서 고칠 수 있는 한 부분만 사용자의 글로 바꾼 것**이다. 나머지는 그 모델이 개선판에서 받는 것 그대로다.
  - Codex 방식: 기본 지시문(첫 developer 메시지, 다른 경로에서는 첫 시스템 글). `<permissions instructions>`, `<collaboration_mode>`, 스킬 목록, AGENTS.md, `<environment_context>`, 도구와 도구 설명(`exec_command` 인자, `spawn_agent` 설명 포함), `# Your Model` 유지, 한 줄 Code Mode 목록은 개선판대로 만든다. 그래서 카탈로그의 GPT 모델에서는 Codex의 권한 문구 그대로, 카탈로그 밖 모델에서는 own 권한 문구다(`CodexVariant.revised`가 `own`과 `custom`에 같다).
  - Pi 방식: Pi 지시문의 첫 문단(12 §3.2). `<tools>`, `<rules>`, `<addendum>`, 프로젝트 지시문, 스킬, `<cwd>`는 만든다.
  - DeepSeek 방식: dsh의 페르소나 줄(13 §3.2). 고정 줄, 도구 안내, 실행 정보, 시간 정보는 만든다. `{{model}}`·`{{provider}}`를 채운다.
  - OpenCode 기본: 고칠 곳이 없다(입력 스키마가 `codex`·`pi`·`dsh`만 받는다).
  - 한 에이전트 방식에 글 하나다. 그 방식의 **모든 모델**이 같은 글을 받는다. `<model_switch>`와 하위 에이전트(메타데이터를 물려받는다)도 같다.
- **안전하게 남기는 것**. 승인 모드 설명과 도구 부분은 own이 실제로 막고 허용하는 것을 모델에게 알리는 글이라 편집 대상이 아니다(읽기 전용으로 보인다). Codex 방식의 패치 절(`CodexVariant.PATCH`, own이 `exec_command`에서 가로채는 heredoc 모양)은 기본 지시문 안에 있으므로 자리 표시 `{{patch}}`로 남긴다. 시작 글을 복사할 때 패치 절을 `{{patch}}`로 바꾸고(`CodexVariant.start`), 보낼 때 다시 넣는다(`instructions`). 사용자가 `{{patch}}`를 지우면 패치 모양 설명이 빠진다. 화면이 그렇게 알린다. 그래서 개선판에서 시작해 고치지 않고 저장한 글은 개선판과 바이트가 같다(단위 시험).
- **저장**: own.harness 플러그인 저장소 `prompt/custom/<harness>` = `{text, updatedAt}`(`src/custom.ts`). 기본값(`defaults`)처럼 모든 Location의 인스턴스와 모든 클라이언트가 같은 글을 본다. 요청 훅이 `custom` 세션의 요청마다 읽으므로 저장하거나 지우면 그 세션의 **다음 요청**부터 바뀐다. 그때 캐시 맨 앞이 바뀌어 대화 앞부분 캐시를 한 번 새로 쓴다. 저장한 글이 없거나 저장값을 읽지 못하면 `custom` 세션은 `own`으로 일한다. 글은 공백만이면 안 되고 100,000자까지다(`Custom.LIMIT`, `prompt_invalid{reason: "empty" | "too_long", limit}`).
- **RPC**(own.harness, `rpc-harness.ts`):
  - `prompt.preview{harness, prompt, model?, mode?, directory?}`(범위 `read`): 그 방식의 요청 빌더(`CodexRequest.build`, `PiRequest.build`)를 빈 대화의 초안으로 돌려 나온 글을 부분마다(`kind`, 자리 `developer`·`system`·`user`, `editable`) 돌려준다. 초안에는 core의 에이전트 지시문 자리 표시와 core 형식의 `# Your Model` 블록만 있다. AGENTS.md, 스킬, Code Mode 목록, MCP 안내, 날짜는 대화마다 달라 빠진다. 도구는 그 방식의 관문 동작(`Gate.ACTION`·`PI_ACTION`)을 단 도구만이고, 빌더의 이름 바꾸기와 개선판 고침을 거친 이름·설명이다. core의 다른 도구는 그대로 함께 간다. 그 밖에 `applied`(내 지시문 글이 없으면 `own`), `tier`(Codex: `catalog`·`lean`·`fallback`), 고친 곳 목록(`changes`), 내 지시문의 시작 글(`starts.reference`·`starts.own`, 그 모델 기준), 저장한 글, 고를 모델(서비스에 켜진 모델, 없으면 예시 모델 넷과 `examples: true`)을 준다. 모델을 주지 않으면 첫 모델, 모드를 주지 않으면 `ask`(own 번들의 보호 경로가 있다고 보고 `reads`는 전체 허용이 아닐 때 참), 폴더를 주지 않으면 그 Location 폴더다.
  - `prompt.custom.set{harness, text | null}`(범위 `local`): 저장하거나 `null`로 지운다(`기본으로 되돌리기`). 목록(`List`)으로 답한다.
  - `list`에 `custom`(글이 저장된 방식들)이 붙는다. 2026-10-18 전 서비스에는 없으므로 선택 필드다. `defaults.set`과 `session.set`은 `custom`도 받는다.
- **고친 곳 목록**(`changes`)은 `variant.ts`에서 나오므로 실제 동작과 어긋나지 않는다. `REPLACEMENTS`와 `SPAWN_AGENT_REPLACEMENTS`는 항목마다 한국어 `title`·`why`와 `from`·`to`를 갖는다. 그 밖의 고침은 `NOTES`(짧은 기본 지시문, 승인 모드 설명, 작업 환경의 읽기 전용 폴더, `exec_command`의 권한 상승 인자, 모델 이름 블록, Code Mode 목록, `spawn_agent`의 짧은 설명·모델 목록·추론 강도 인자)와 `PiVariant.CHANGE`가 제목과 이유를 갖고, `prompts.ts`가 원본·개선판 글을 채운다(승인 모드 설명과 작업 환경은 고른 모드로). `applies`는 **개선판이 그 모델에 하는 고침**인지다: 대체 지시문 층은 `REPLACEMENTS`, 짧은 지시문 층은 `lean`, 둘 다 나머지. 카탈로그의 GPT 모델은 하나도 없다. Code Mode 목록은 대화마다 달라 설명만 있다. 이 글들은 화면 낱말 규칙(03 §14.1)을 따른다: 해요체, 문장 안의 `own` 대신 `이 앱`(단위 시험이 막는다). 화면이 영어여도 한국어로 보인다(열린 점).
- **화면**: 설정 > 에이전트 방식(03 §5.7, `harness/prompt-page.tsx`, 상태는 `prompt-state.ts`). 에이전트 묶음의 첫 페이지다.
  - 에이전트 방식 탭, 지시문(원본 / 개선판 / 내 지시문, 내 지시문은 그것을 아는 서비스에서만), 모델, 승인 모드. 모델 줄 설명은 층이다(`Codex 목록에 있는 GPT 모델이에요. 개선판도 원본과 같은 글을 보내요.` 등). 모델은 이 기기에서 그 서버에 마지막으로 고른 모델(localStorage `own.web.prompts.model`, 서버마다)로 시작하고, 없으면 사용자가 쓰는 모델: 새 대화가 시작할 모델(전환기에서 고른 조합, 그 폴더에서 마지막에 쓴 모델, 새 대화 계정의 묶음 기본 모델, `switcher/new-session.ts`), 그것도 없으면 가장 최근 대화의 모델, 그다음 서비스의 첫 모델이다. 서비스가 더 내주지 않는 모델이면 서비스의 첫 모델로 다시 묻는다. 대화 목록과 계정 기본값은 페이지를 연 뒤에 읽힐 수 있어서, 고르거나 기억된 모델이 없는 동안에는 쓰는 모델이 알려지는 때 한 번 그 모델로 옮긴다.
  - `보내는 글`: 부분마다 이름(`기본 지시문`, `모델 이름`, `승인 모드 설명`, `협업 모드`, `작업 환경`, Pi는 `첫 문단`, `도구 목록`, `규칙`, `작업 폴더` …), 자리, `내 지시문으로 바꿀 수 있어요` 또는 `이 앱이 만들어요`, 글자 수, `복사`. 고정폭이고 줄바꿈을 지키며 가로로 넘치지 않는다. `글에서 찾기`는 찾은 곳을 강조하고 `{n}곳`을 센다. `전체 복사`.
  - `도구 {n}개`, `고친 곳`(원본: `원본은 그 도구가 보내는 그대로예요. 개선판은 이 모델에서 아래 {n}곳을 고쳐요.`, 개선판: `개선판은 이 모델에서 아래 {n}곳을 고쳐요.`, 내 지시문: `내 지시문은 기본 지시문만 바꿔요…`, 없으면 `이 모델에는 고친 곳이 없어요…`). 다른 모델에서 고치는 곳은 접어 둔다. 항목마다 제목, 이유, 원본과 개선판 글을 나란히(좁으면 위아래로).
  - `내 지시문`(지시문에서 고를 때): 고치는 범위 설명, `{{patch}}` 설명(Codex), 저장한 글이 없으면 `개선판에서 시작`·`원본에서 시작`(고른 모델이 받는 글). 편집 칸, 글자 수, `저장`, `고친 내용 버리기`, `개선판 글로 바꾸기`·`원본 글로 바꾸기`, `기본으로 되돌리기`(확인 창 `내 지시문을 지울까요?` / `… 내 지시문을 고른 대화와 새 대화는 다음 요청부터 개선판으로 일해요.`), 캐시 안내 `다음 요청부터 바뀌어요. 내 지시문을 쓰는 대화는 그때 대화 앞부분 캐시를 한 번 새로 써요.` 저장하지 않은 편집은 이 페이지가 열려 있는 동안 방식마다 남는다.
  - 휴대폰·다른 PC는 읽기만 한다(`PC의 앱 창에서 고칠 수 있어요.`). `prompt.preview`를 모르는 옛 서비스는 `이 서비스에서는 지시문을 볼 수 없어요…`. OpenCode 기본 탭은 `OpenCode 기본은 OpenCode가 만든 지시문을 그대로 보내요…`.
- **비교**(2026-10-24, 사용자 요청: 원본과 개선판의 차이를 한 번에 보고, 왜 고쳤는지 설명서 링크나 작은 글씨로 보고 싶다): 지시문 줄의 `비교` 단추(`aria-pressed`)를 켜면 `보내는 글`·`도구 {n}개`·`고친 곳` 대신 두 변형을 나란히 보인다. 원본이나 개선판을 고른 채면 원본(왼쪽)과 개선판(오른쪽), 내 지시문을 고른 채면 개선판과 저장한 내 지시문이다. 같은 모델·모드·폴더로 `prompt.preview`를 두 번 부른다(RPC는 그대로다). 논리는 `harness/prompt-compare.ts`, 화면은 `prompt-compare-view.tsx`이고 둘 다 설정의 지연 청크에 있다(PF5).
  - 부분은 종류와 그 종류 안의 순서로, 도구는 이름으로 짝짓는다(순서가 달라도 같은 이름끼리). `identity`처럼 한쪽에만 있는 부분·도구만 그쪽에 `원본에는 없어요`(`개선판에는 없어요`, `내 지시문에는 없어요`)라고 쓴다. 다른 곳은 줄 단위로 찾고(공통 앞뒤 줄을 떼고 LCS, 빈 줄만 사이에 둔 바뀐 덩어리는 하나로), 바뀐 덩어리 안은 낱말 단위로 칠한다(낱말, 띄어쓰기 묶음, 줄바꿈 하나, 기호 하나). 덩어리는 같은 줄바꿈과 보이는 글자 32자 이상 같은 줄기에서 끊어 조각마다 따로 보고, 보이는 글자의 40%도 같지 않은 조각(다시 쓴 글)은 통째로 칠한다. 그래서 큰 삭제 옆의 작은 고침도 제 낱말만 칠해진다(Codex 대체 층 `spawn_agent`: 모델 목록 삭제 옆에서 `model` 인자 줄은 더한 한 문장만). 표 하나(양쪽 약 1,000토큰)에 들어가지 않는 큰 덩어리는 줄부터 짝짓고 짝마다 따로 칠한다. 보이는 글자가 같고 양쪽에 한 번씩만 있는 줄이 먼저 짝이 되고(그중 순서가 맞는 가장 긴 사슬. CRLF 사본, 들여쓰기만 바꾼 줄), 그 사이에서는 보이는 글자의 절반 이상이 같은 줄끼리 같은 글자가 가장 많도록 짝짓는다(줄 짝 표가 250,000칸을 넘으면 500줄 창). 그래서 모든 줄을 고치고 줄 덩어리를 더하거나 뺀 글도 고친 곳만 칠한다. 짝 사이의 줄은 함께 칠하고, 그 줄들의 작은 쪽 글자 40%도 다른 쪽에 없으면 다시 쓴 글로 보고 짝짓지 않는다. 표 하나에 들어가지 않는 조각(수천 단어의 한 줄)은 양쪽에 한 번씩만 있는 낱말을 핀으로 삼아(순서가 맞는 가장 긴 사슬) 그 사이를 다시 칠하고, 그런 낱말이 없으면 1,000토큰 창(긴 줄은 줄 안에서 자른다)으로 나눈다. 단어 대부분이 다른 큰 조각은 표 없이 통째로 칠한다. 보이지 않는 문자만 다른 낱말은 그 문자만 칠한다(소프트 하이픈을 넣은 낱말은 하이픈만, 이어 붙인 두 낱말은 빠진 띄어쓰기만). 같은 줄바꿈은 칠에 넣지 않아, 다시 쓴 글도 줄마다 따로 칠한다. 줄을 더하거나 뺀 덩어리의 빈 쪽은 `이 자리에는 줄이 없어요`, 내용만 지운 줄은 빈 줄로 남는다. dsh 시간 정보의 시각은 두 미리 보기가 따로 읽으므로 한쪽 시각으로 맞춘다.
  - 공백과 그려도 아무것도 보이지 않는 문자만 다른 칠은 기호로 그린다: 줄바꿈 `⏎`(줄은 그대로 바뀐다), 띄어쓰기 `·`(다른 공백 문자도), 탭 `→`, CR `␍`, 줄바꿈 없는 공백 `⍽`, 전각 공백 `□`, 소프트 하이픈 `¬`, NEL `␤`, 그 밖의 제어 문자 `␀`…`␟`·`␡`·`␦`, 방향 제어 문자(LRM, RLM, 임베딩, 오버라이드, 아이솔레이트) `⇄`, 이체 선택자 `◌`, 태그 문자 `⌑`, 한글 채움 문자 `▯`, 폭 없는 문자와 그 밖의 기본 무시 문자(`\p{Default_Ignorable_Code_Point}` 전부)·행간 주석 문자 `⁞`. 기본 무시 문자는 엔진의 유니코드 속성으로 찾고, 단위 시험이 유니코드 목록(DerivedCoreProperties)의 범위마다 기호와 알림을 확인한다. 글자가 있는 칠 안에서도 띄어쓰기(U+0020)와 탭 말고는 모두 기호로 그리고, 칠 안에서 보이는 글자가 없는 줄을 끝내는 줄바꿈(더하거나 뺀 빈 줄, 이어 붙인 두 줄)은 `⏎`로 그린다. 고친 줄 옆에 더하거나 뺀 빈 줄은 따로 칠한다(빈 줄의 줄바꿈은 빈 줄의 줄바꿈끼리만 맞춘다). 점선 테두리는 기호에만 두르고 칠이 끝나는 줄바꿈은 칠 밖에 그려, 테두리가 다음 줄로 넘어가지 않는다. 기호는 선택되지 않고 옆에 숨긴 실제 문자가 복사된다. Chromium은 복사할 때 줄바꿈 없는 공백을 띄어쓰기로 바꾸므로, 비교의 각 칸이 `copy`를 받아 선택한 글 그대로(숨긴 실제 문자 포함)를 `text/plain`에 쓴다(`copyReal`). 공백만 다른 덩어리 아래에는 `줄 끝·빈 줄만 달라요`(줄 끝 공백·CR·빈 줄·마지막 줄바꿈만), `보이지 않는 문자만 달라요`(위의 보이지 않는 문자만) 또는 `띄어쓰기·줄바꿈만 달라요`. 같은 줄바꿈은 칠하지 않는다.
  - 칠은 색만으로 가르지 않는다(WCAG 1.4.1): 왼쪽에서 빠진 곳은 취소선, 오른쪽에 더한 곳은 밑줄, 선 색은 `--own-danger`/`--own-ok`. 스크린 리더는 칠마다 `삭제 시작`…`삭제 끝`, `추가 시작`…`추가 끝`을 듣는다(`data-sr`를 `::before`/`::after` 생성 콘텐츠로 읽어 글을 복사해도 섞이지 않는다). 기호는 종류마다 `줄바꿈 1개`, `소프트 하이픈 1개 (U+00AD)`처럼 듣는다. 띄어쓰기(U+0020)·탭·CR·줄바꿈만이 아니면 코드 포인트를 한 번씩 붙인다(여섯 개까지, 그 뒤는 `…`). 마우스를 올려도 같은 말이 뜬다. 밝은·어두운 테마 모두 칠한 글자·이름표·알림 글자가 4.5:1, 선이 3:1 이상이다(Playwright가 잰다).
  - 같은 부분은 `같음`으로 접히고, 같은 부분이 잇달면 `같은 부분 {n}개` 하나로 접힌다. 바뀐 부분 안의 긴 같은 줄은 바뀐 곳 옆 세 줄만 두고 `같은 줄 {n}개 보기`로 접힌다. 이 접기 단추는 하나라 펼쳐도 그 자리에 남아 초점을 지키고, 이름(`같은 줄 접기`)과 `aria-expanded`만 바뀌며 `aria-controls`로 숨긴 줄을 가리킨다. 부분마다 `원본 복사`·`개선판 복사`(같은 부분은 `복사`). 바뀐 덩어리의 두 쪽은 칸 폭이 560px 아래면 위아래로 쌓인다(컨테이너 질의). 모두 단추나 `<details>`라 키보드로 다룬다. 사용자가 열거나 닫은 부분과 펼친 같은 줄(부분과 숨긴 줄의 번호로 기억한다)은 모델·모드를 바꿔 다시 그려도 그대로이고, 부분과 조각은 열쇠로 그려 같은 요소가 남으므로 초점도 그대로다(비교를 끄면 잊는다).
  - 요약은 부분과 도구를 따로 센다: `다른 부분 {n}개, 같은 부분 {m}개 · 다른 도구 {n}개, 같은 도구 {m}개`. 옆 변형의 미리 보기만 실패하면 고른 변형은 그대로 두고 비교 자리에 `비교할 다른 글을 불러오지 못했어요`와 `다시 시도`를 보인다.
  - 고친 까닭: 원본↔개선판에서는 개선판이 그 모델에 하는 고침(`applies`)마다 원본 글(`before`)이나 개선판 글(`after`)이 놓인 곳과 겹치는 첫 덩어리 아래에 작은 글씨로 제목, 이유의 첫 문장, `자세히`를 단다. 글을 그대로 찾지 못하면 그 고침의 `part`에 맞는 부분의 첫 빈 덩어리에 단다. 어디에도 없는 고침(`exec_command`의 권한 상승 인자, 대화마다 다른 Code Mode 목록 등)은 맨 아래 `글에 보이지 않는 곳`에 모은다. 개선판↔내 지시문에는 달지 않는다(다른 곳은 사용자의 글이다).
  - `자세히`는 앱 안 설명서를 그 고침의 항목(`#pc-<id의 점을 -로>`, 예: `pc-codex-base-where`)에서 연다(`openManual(place, anchor)`). `고친 곳` 목록의 항목에도 붙는다. 이 빌드의 설명서에 없는 앵커(새 서비스가 더한 고침)는 맨 위가 아니라 그 장(`#ch10-13`)에서 연다(뷰어가 틀을 읽은 뒤 앵커가 없으면 장으로 옮긴다). 설명서 10.13 `고친 곳 하나하나`의 목록은 own-harness `script/prompt-manual.ts`(`bun run prompt-manual`)가 `prompt.preview`의 고친 곳에서 방식·모델 층별로 만든다. 항목은 `<li id="pc-…">`(HTML 블록)이고 열린 항목은 `:target`으로 표시된다. `REPLACEMENTS`와 `SPAWN_AGENT_REPLACEMENTS`는 이제 고정 `id`를 가져 고친 곳의 id(`codex.base.<id>`, `codex.spawn.<id>`)와 앵커가 항목을 더하거나 옮겨도 바뀌지 않는다. own-harness `test/unit/prompt-manual.test.ts`는 목록이 최신인지, 모든 고친 곳(모든 `REPLACEMENTS` 포함)이 장과 만든 설명서 HTML에 앵커를 하나씩 갖는지, 목록 제목과 10.13 표가 이름 대는 모델이 `CodexVariant.lean`의 층과 맞는지, 표의 `열 곳`이 `REPLACEMENTS` 수와 맞는지 본다. 어느 승인 모드에서도, 견본 모델 어느 쪽에서도 하지 않는 고침은 목록을 만들 때 실패한다(엉뚱한 묶음에 들어가지 않게).
  - 작은 글씨의 이유는 `why`의 첫 문장이라, 각 `why`는 첫 문장에 무엇을 왜 고쳤는지를 담는다(배경은 그 뒤에).
- **하위 에이전트**(2026-11-07, 사용자 요청: 하위 에이전트를 어떻게 부르고 어떤 지시를 주는지 보고 싶다): 탭마다 맨 아래 읽기 전용 부분 `하위 에이전트`. 보는 것뿐이라 모델에게 가는 바이트는 바뀌지 않는다.
  - **RPC.** `PromptPreview.subagent`(선택 필드, 2026-11-07 전 서비스에는 없다)와 새 메서드 `prompt.subagent{}`(범위 `read`, OpenCode 기본 탭용). 모양은 `PromptSubagent{kind: "core" | "codex-v1" | "codex-v2", tool?: {name, description}, agent?, opening, guidance, cut?: {lines, bytes}}`. own.harness 메서드는 9개다. own 플러그인 RPC라 공개 HttpApi와 생성 클라이언트는 그대로이고, rpcHash(셸↔렌더러 IPC 계약, 05 §5.5)의 입력이 아니어서 `a9f246494fb7bbbf` 그대로다. 게이트웨이는 `OwnHarness.MethodScope`를 그대로 읽으므로 휴대폰·다른 PC도 `read`로 본다. own-web의 범위표 사본 `HARNESS_SCOPE`에 같은 줄을 더했다(사본은 시험이 대조한다).
  - **core `subagent`**(`pi`, `dsh`, `claude-code`의 미리 보기, `prompt.subagent`): 도구 설명은 레지스트리에 있는 core `subagent`의 설명에, core 문맥 훅이 붙이는 "Available subagents:" 목록을 같은 규칙으로 붙인 것이다(`core/src/tool/plugin/subagent.ts` `hook`). 대상 에이전트는 새 대화의 기본 에이전트다: core `Agent.list`가 맨 앞에 두는 선택 가능한 에이전트(`agent`). 그 권한으로 `subagent`가 거절이 아니고, 숨김이 아니며 `mode`가 `primary`가 아닌 에이전트를 id 순으로 적는다(판정은 `DshReadable.evaluate`, core `Permission.evaluate`와 같다). 모델이 Claude Agent 프로바이더면 이름 `mcp__opencode__subagent`와 Claude Code의 2,048자 자르기(긴 설명은 목록을 앞으로, core `ToolNames.description`). `opening`은 `You are a subagent spawned by another session.\n`, `cut`은 core 도구 출력 한도 `{lines: 2000, bytes: 51200}`다. own-harness는 core에 기대지 않으므로 이 둘과 MCP 이름·자르기는 own-harness 쪽에 있고, 단위 시험이 core 소스(`subagent.ts`의 join)와 상수(`ToolOutput.MAX_LINES`·`MAX_BYTES`), `ToolNames`와 대조한다. 하네스의 `tools` 목록은 그대로 그 하네스 도구만이다.
  - **Codex**: `kind`는 모델의 `multi_agent_version`(`CodexRequest.collaboration`)이 정한다. v2면 도구 `collaboration__spawn_agent`, `opening`은 `CodexAgents.interAgentMessage("NEW_TASK", "/root/<task_name>", "/root", "")`, `guidance`는 자식이 받는 `<multi_agent_role>`(`CodexAgents.roleText`). v1이면 `multi_agent_v1__spawn_agent`이고 앞줄도 역할 글도 없다. 도구 설명은 미리 보기의 `tools`에 있는 그대로다(층별 개선판 포함). 다만 Code Mode의 v1 모델(`CodexRequest.codeMode`, 예: Responses의 GPT-5.6 Luna·codex-auto-review)은 v1 에이전트 도구를 받지 않고 core `subagent`를 최상위로 받으므로(§6.3), 미리 보기도 `kind: "core"`로 core의 설명을 보인다. 화면은 그 까닭(`own.prompts.subagent.codemode`)과, 자기 지시문이 있는 역할의 글이 Codex 지시문을 그대로 두고 developer 메시지 맨 앞에 들어간다는 것(`role.codex`)을 말한다. 처음 판(SAV)은 이 모델도 `codex-v1`로 보였다(리뷰 SAV-R1).
  - **화면**(`harness/subagent-view.ts`가 글을 만들고 `prompt-page.tsx`가 그린다): `맡기는 도구`(접힌 원문과 첫 줄, 목록 설명, MCP 이름 설명), `새 하위 에이전트가 받는 첫 메시지`(`opening` 뒤에 `(메인 모델이 prompt에 쓴 글 그대로)`, Codex는 `message`), `따로 붙는 지시`(없음, 자기 지시문이 있는 역할의 글이 들어가는 자리는 방식마다 다름, 프리셋 위임 안내), Codex v2의 `하위 에이전트의 역할 글`, `돌아오는 글`(마지막 단계 글만, 포그라운드는 `cut`에서 앞부분을 남기고 자름, 백그라운드 알림은 자르지 않음, 프리셋 알림 한 줄). Codex는 `spawn_agent`가 무엇을 묻는지 층과 지시문으로 말한다: Codex의 원래 글(목록의 GPT 모델, 모든 모델의 원본)과 대체 층 개선판은 고친 파일 경로와 검토를 묻고, 짧은 층 개선판(`SPAWN_AGENT_LEAN`)은 묻지 않고 "돌려받을 결과"만 말하며, v2는 묻지 않고 `wait_agent`가 내용을 돌려주지 않는다. own-harness 단위 시험이 이 말이 기대는 원문(`SPAWN_AGENT_LEAN`, v1·v2 `spawn_agent`, v2 `wait_agent`)을 대조한다. OpenCode 기본 탭은 `prompt.subagent`를 페이지가 열린 동안 한 번 읽고(실패하면 다음에 탭을 열 때 다시), 옛 서비스면 이 부분이 없다. omo 탭은 한 줄이다(15 §6). 설명서는 10.16.
  - 시험: own-protocol `rpc-harness.test.ts`, own-harness `prompts.test.ts`(`하위 에이전트` 묶음), `sessions.test.ts`(`prompt.subagent` 처리기), e2e `prompts.test.ts`(Pi·DeepSeek 요청의 `subagent` 설명이 미리 보기와 같다, OpenCode 기본 요청의 것이 `prompt.subagent`와 같다, Code Mode의 GPT-5.6 Luna 요청은 Responses Lite의 `additional_tools`에 core `subagent`를 싣고 v1 에이전트 도구가 없으며 그 설명이 미리 보기와 같다), own-web `harness/subagent-view.test.ts`, `prompt-state.test.ts`.
- **알약과 메뉴, 설정 > 일반**: 메뉴의 `지시문`에 `내 지시문`이 생긴다(서비스의 `list.prompts`가 `custom`을 가질 때만). 설명은 `설정 > 에이전트 방식에서 고친 기본 지시문으로 일해요…`, 그 방식에 글이 없으면 `저장한 내 지시문이 없어서 지금은 개선판으로 일해요…`. 메뉴를 열 때마다 `list`를 다시 읽고(새 대화 화면을 거치지 않고 대화를 바로 연 창은 서버마다 한 번 먼저 읽는다), 아래에 `지시문 보기·고치기`(설정 페이지로). 알약은 실제로 도는 것을 말한다: 글이 있으면 `· 내 지시문`, 없으면 `· 개선판`(`data-prompt`는 메타데이터의 `custom` 그대로). 설정 > 일반의 `지시문`도 같은 세 값이고, 처음 값이 내 지시문인데 그 방식에 글이 없으면 `이 방식의 내 지시문이 아직 없어서 새 대화는 개선판으로 일해요…`.
- **옛 클라이언트·서비스**: 옛 own-web의 `promptOf`는 `custom`을 `reference`로 읽어 알약에 `· 개선판`이 없고 메뉴가 원본을 표시한다. 그 창에서 다른 변형을 고르면 그 값이 저장된다. 옛 서비스는 `custom` 입력을 거절하고 `list.prompts`에 없으므로 새 own-web은 내 지시문을 보이지 않는다.
- **시험**: 단위 `test/unit/prompts.test.ts`(빌더가 만든 부분, 원본·개선판·내 지시문, 글 없음 → 개선판, 시작 글을 그대로 저장하면 그 변형과 같은 바이트, 고친 곳의 `applies`, 한국어 글 규칙), `sessions.test.ts`(`prompt.custom.set` 저장·거절·지우기, 처음 값 `custom`), own-protocol `rpc-harness.test.ts`. e2e `test/e2e/prompts.test.ts`: Codex 방식(원본·개선판 × GPT-5.5 Responses, Claude Opus 5.5, Claude Sonnet 5.5, DeepSeek V4 Pro)과 Pi 방식(원본·개선판 × GPT-5.5, Claude Opus 5.5)의 실제 요청과 미리 보기가 부분·도구 설명까지 같다. 내 지시문을 저장하면 다음 요청의 기본 지시문이 그 글(패치 절 포함)이고 나머지는 개선판과 같으며, 지우면 같은 대화의 다음 요청이 개선판이다. Pi는 첫 문단만 바뀌고 처음 값을 내 지시문으로 둘 수 있다. own-web `harness/prompt-state.test.ts`, Playwright `e2e/prompts/prompts.pw.ts`(보기 → 시작 → 고치기 → 저장 → 새 대화 알약에서 고르기 → 가짜 공급자가 받은 요청 확인 → 되돌리기 → 같은 대화의 다음 요청이 개선판, 375px 폭). 원본·개선판의 `prompt-capture` 캡처 15개씩은 바뀌기 전과 바이트가 같다(임시 경로와 ID만 정규화). 비교(2026-10-24): own-web `harness/prompt-compare.test.ts`(줄·낱말 차이, 다시 쓴 글, 큰 삭제 옆 작은 고침, 줄마다 따로 보기, 공백 기호와 `whitespace`, 보이지 않는 문자의 기호·코드 포인트·하이픈만 칠하기·`copyReal`, 600·1,200단어 한 줄의 한 낱말, 모든 줄을 고친 17 KB에 줄 30·60·120개 더하기와 60개 빼기(칠한 글자가 실제 고친 양의 1.1배 + 50자 안)와 그 시간, 부분·도구 짝(순서가 달라도), 고친 곳 자리, 시각 맞추기, 접기, 같은 부분 묶기, 앵커), `prompt-state.test.ts`(비교가 옆 변형도 묻는다, 옆 변형만 실패), Playwright 같은 파일의 비교 시험(DeepSeek 방식 비교 → 같음 펼치기 → 까닭 → `자세히`가 설명서를 그 항목에서 연다 → 없는 앵커는 10.13 → Codex 방식 목록 밖 모델과 `spawn_agent` → 내 지시문 → 375px), 키보드만으로 같은 줄 펼치고 접기(초점 유지), Pi 방식 내 지시문 = 개선판 + 줄바꿈의 `⏎`, 보이지 않는 문자(소프트 하이픈·폭 없는 공백·태그 문자·RLM·NEL의 기호, 코드 포인트를 붙인 이름과 툴팁, 하이픈만 칠하기, `보이지 않는 문자만 달라요`), 실제 Ctrl+C가 줄바꿈 없는 공백을 지키는지(그 시험의 컨텍스트에만 클립보드 권한), 밝은·어두운 테마의 대비, `test:e2e:prompts`의 비교 배치 점검(1440·1280·1152·1024·820·375px. ui-audit의 데모 세계에는 own.harness가 없어 여기서 돈다).

---

### 3.12 Claude Agent 위의 하네스 (2026-10-31, CAG)

Claude Agent 경로(02 §8.10)에서는 upstream 프로바이더 `claude-agent`가 claude를 띄운다. claude는 Claude Code의 고정 지시문(preset) 뒤에 OpenCode의 역할(`claudeCodeAgent`)과 지시문(`claudeCodeInstructions`)을 덧붙여 보내고, 이 둘은 요청 옵션에서만 읽는다. 프로바이더의 훅은 core 내장이라 own 플러그인보다 먼저 돌며 core가 만든 system을 옵션에 옮긴다. 그래서 하네스가 나중에 `event.system`을 바꾸면 Claude에 닿지 않는다(보고서 4장). own은 다음처럼 한다.

- **`claude-code` 하네스(화면 이름 "Claude Agent 기본")**: id 목록(`OwnHarnessRouting.IDS`)의 마지막이다. core의 요청을 그대로 두는 `opencode` 길이고, Claude에는 Claude Code의 preset이 앞에 간다. 프롬프트 변형과 내 지시문은 없다(`CUSTOM_HARNESSES`에 없음). 다른 provider에서는 `opencode`와 같다. 레지스트리 `{id: "claude-code", tools: opencode의 것}`, 관문은 `opencode`처럼 도구가 없다.
- **기본값**: 만드는 쪽이 하네스를 정하지 않은 새 최상위 대화가 `claude-agent` 모델로 만들어지면 `claude-code`다(`Sessions.stamp`, `session.created`의 `model`). 저장된 기본값보다 앞선다. 자식은 부모 것을 물려받고, 정해서 만든 것은 그대로다. own-web은 새 대화의 모델이 `claude-agent`이고 사용자가 이 초안에서 하네스를 고르지 않았으면 `claude-code`를 넘긴다.
- **전달 방식(codex·pi·dsh)**: 하네스가 요청을 다 만든 뒤(`context`·`compaction`·`generate` 모두) provider가 `claude-agent`면 자기 system 전체(부분들의 글을 `\n\n`으로 이은 것)를 `claudeCodeAgent`에, 빈 글을 `claudeCodeInstructions`에 넣는다. 그래서 그 하네스가 다른 provider에 보낼 지시문(AGENTS.md, own의 지시문 항목 `own.team.role`·`own.team.handoff`·`own.preset`, 내 지시문, 스킬, Codex collab 글)이 Claude Code preset 뒤에 한 번 간다. `opencode`·`claude-code`는 프로바이더의 옵션을 그대로 둔다. omo는 own-omo가 같은 일을 한다(15 §3.11).
- **Codex의 `apply_patch`**: 이 경로의 도구는 MCP 도구라 JSON만 받는다. Codex는 Responses가 아니면 `apply_patch`를 빼고 `exec_command` heredoc을 가르치는데, `claude-agent`에서는 `apply_patch`를 JSON `{input}` 함수 도구로 두고(`jsonPatch`) 지시문도 그에 맞는 패치 안내로 바꾼다(모든 단계). 2026-10-14 실측에서 Claude가 이 모양을 잘 썼다.
- **도구**: 하네스 도구는 그대로 요청의 도구 목록이 되어 MCP 서버 `opencode`로 Claude에 간다(`mcp__opencode__<이름>`, 설명은 2,048자에서 자름). Claude가 부르면 프로바이더가 OpenCode 도구 호출로 돌려주고, own의 권한·하네스 코드로 실행된다. Claude Code의 내장 도구는 꺼져 있다.
- **바이트 동일성**: 이 모든 것은 provider가 `claude-agent`일 때만이다. 다른 provider의 요청은 그대로다(골든·prompts·full-prefix 시험).
- **한계**: Claude Code preset과 하네스 지시문이 함께 놓인다(preset만 바꿔 끼우기는 코어 패치 P-040, 선택). preset은 자기 내장 도구를 전제로 쓴 글이고, Pi·dsh는 날짜·환경을 한 번 더 쓴다. 전달하는 system이 바뀌면(날짜가 든 지시문이면 하루에 한 번) claude가 다시 뜬다. Responses 전용 기능(P-020–P-026, Codex `exec`)은 이 경로에 없다.
- 시험: own-harness `test/unit/claude-agent.test.ts`, core `test/plugin/provider/claude-agent/own-harness-delivery.test.ts`(진짜 프로바이더와 upstream 가짜 claude 위에서 각 하네스의 지시문과 도구가 Claude에 닿고, pi `read`·codex `exec_command`가 하네스 이름으로 OpenCode에 돌아온다).

## 4. 동일성 검증

1. **요청 비교(골든).** 이 PC의 Codex CLI를 API 키 방식으로 e2e-kit 가짜 Responses 서버에 붙여, 정해진 시나리오(도구 호출을 미리 정한 대화)에서 Codex가 보내는 요청을 기록한다. 같은 시나리오를 own `codex` 하네스로 돌려 정규화(id, 날짜, 경로, uuid)한 요청을 비교한다. 입력 항목 순서, 조각 텍스트, 도구 정의, 필드가 같아야 한다. Codex 버전을 고정하고 기록한다.
2. **Codex 시험 옮기기.** `apply_patch` 25개 시나리오와 오류 문구, 자르기 시험, 결과 형식 시험.
3. **실제 성능.** 모델별로 `opencode` / `codex` / 진짜 Codex를 같은 과제로 비교한다. 실계정 실행은 사용자가 한다.

---

## 5. Codex 변경 따라가기

- `own/ledger/codex-pin.json`: 기준 커밋, 날짜, Codex CLI 버전.
- `own/scripts/codex-sync.ts`: `refs/codex`를 최신으로 받고, 추적 경로(카탈로그, 프롬프트 조각, 도구 설명, 결과 형식, 자르기, `apply_patch`, 압축, 요청 구성)의 바뀐 커밋을 보고한다. `models.json`은 모델별 `tool_mode`·자르기·기본값과 템플릿 해시로 비교한다. 승인하면 `codex-data/`를 다시 만들고 시험을 돌린다.
  - `--apply`는 `codex-data/`와 함께 own-protocol의 카탈로그 slug 목록(`src/codex-slugs.ts`, 생성물)도 다시 만든다. own-accounts의 Codex 모델 목록은 이 목록으로 own이 아는 모델인지 가른다(§6.10).
  - CLI는 `--cli-prefix <폴더>`에, 없으면 참고 클론 옆 `codex-cli/<버전>`에 설치한다(메인 체크아웃 옆이 아니다. `D:\own-open-code`에는 `refs\`가 없다). `--no-cli`는 CLI를 받지 않고 고정만 옮긴다. CLI 내려받기는 사용자 승인이 필요하다.
  - `script/codex-golden.ts`는 쓰는 CLI(`OWN_CODEX_BIN`, 고정 버전 설치본, `PATH`의 `codex` 순)의 `--version`이 고정 버전(`codex-pin.json`의 `cli`)과 다르면 멈춘다. 다른 버전으로 찍은 골든은 엉뚱한 릴리스와 비교하게 된다.
- 변화가 잦은 곳: `models.json`(약 주 2회), 요청 구성(`session/mod.rs`, `context/`, `client.rs`), Code Mode, 압축. 안정적인 곳: `apply_patch`, 자르기.
- own 개선판의 글(`src/codex/variant-base.md`, 권한 문구, `spawn_agent` 문단)은 own이 쓴 글이라 `codex-sync`가 따라가지 않는다. 바꾸는 Codex 원문(`REPLACEMENTS`, `SPAWN_AGENT_REPLACEMENTS`, `SPAWN_AGENT_START`)은 원문에 그대로 한 번 있는지 단위 시험이 확인한다. Codex가 그 문구를 바꾸면 시험이 깨진다.

---

## 6. 단계

| 단계 | 내용 | 코어 수정 |
|---|---|---|
| H0 | 틀: 레지스트리, 세션 바인딩, 새 세션 선택·표시, 전환과 기록 번역, `codex-data` 생성과 `codex-sync` | 없음 |
| H1 | Codex Direct 방식: 요청 구성, `exec_command`·`write_stdin`, `apply_patch`(JSON), `view_image`, `request_user_input`, 결과 형식·자르기, 골든 요청 비교 | 없음 |
| H2 | freeform 도구(P-019), Responses Lite(P-020), 필요하면 요청 세부(P-021) | 있음 |
| H3 | Code Mode Only(`exec`, `wait`)로 GPT-6 계열 맞추기 | H2 위에서 |
| H4 | 중단·모델 전환 안내, 압축 동일화(필요하면 P-022) | 경우에 따라 |
| H5 | 승인 문구와 Windows 샌드박스 | 별도 결정 (own 개선판의 승인 문구는 2026-10-16에 own 문구로 바꿈. 원본은 미정) |

GPT 외 모델의 조정은 H1 뒤 측정 결과로 정한다.

### 6.1 H0 결과 (2026-10-11)

- **플러그인** `packages/own-harness`(`own.harness`): 요청은 아직 바꾸지 않는다. 그래서 지금은 두 하네스 모두 upstream 요청을 그대로 보낸다.
  - `src/sessions.ts`: `session.created`에서 하네스를 찍는다. 최상위 세션은 플러그인 옵션 `default`(처음 값 `codex`), 자식은 부모의 하네스다. 메타데이터는 읽고 합쳐서 쓴다(`session.update`가 메타데이터 전체를 바꾸기 때문).
  - `src/registry.ts`·`src/history.ts`: 하네스별 셸·패치 도구 형식과 기록 번역(`History.translate`, 순수 함수). 요청 훅에 연결하는 것은 H1이다(Codex 도구가 생긴 뒤).
  - `src/notice.ts`: 전환 안내 `<harness_switch>…</harness_switch>`. synthetic 메시지(`resume: false`, `steer`)로 남겨 다음 프롬프트 앞에 들어간다. core가 synthetic을 user 역할로 보내므로, H1의 `codex` 요청 구성이 이 태그를 찾아 developer 메시지로 옮긴다.
  - 실행 중 판단: 그 인스턴스가 본 `session.execution.*` 이벤트로 한다.
- **RPC** `own.harness`(`@own/protocol/rpc-harness`): `list`, `session.get`, `session.set{sessionID, harness}`(오류 `session_not_found`, `session_busy`), `defaults.set{harness, prompt}`(2026-10-16, 범위 `local`, 새 최상위 세션의 기본값을 플러그인 storage `defaults`에 저장하고 새 `list`를 돌려줌. 게이트웨이는 `MethodScope`를 따르므로 기기에는 막힘), 이벤트 `session.changed`. 메타데이터 도우미는 `rpc-harness-routing`(own-web 첫 묶음용, 실행 import 없음).
- **화면**(H0 당시): 헤더의 하네스 알약(`Codex 방식` / `OpenCode 기본`). 세션에서는 전환 메뉴와 캐시 안내를 보여 줬다. 새 세션 화면의 기본값은 이때 창마다 localStorage에 두었지만, 2026-10-16부터는 서비스의 `defaults.set` 값이고 알약은 그 화면의 대화 하나만 고른다(3.8).
- **Codex 데이터**: `codex-data/`는 `script/codex-data.ts`가 Codex git 객체에서 만든다(Windows 작업 트리의 CRLF를 피함, `.gitattributes`로 줄바꿈 변환 막음). `own/ledger/codex-pin.json`과 `own/scripts/codex-sync.ts`(영역·모델별 변경 보고, `--apply`로 핀 이동과 재생성).
- **시험**: 단위 15개, 서버 부팅 e2e 3개(기본값·상속·명시값, 전환 안내가 다음 요청에 한 번, 프롬프트 앞에), own-web 계약 시험.
- **원격·게이트웨이 (2026-10-12)**: 원격(SSH) 설치도 `own-harness`를 싣는다(`REMOTE_PLUGINS`, 관리 설정 5번, 옵션 없음이라 새 세션은 `codex`. 2026-10-29부터 그 뒤 6번이 own-omo, 15 §1). 가드는 이 PC와 같게 통과한다: 서비스 env의 `OWN_OPEN_CODE=1`, 같은 릴리스 버전(버전이 다른 호스트는 `incompatible`). 휴대폰 게이트웨이는 이 PC와 호스트(`/srv/<hostId>`) 모두에서 `list`·`session.get`을 `read`로, `session.set`을 `switch`(모델 전환과 같은 범위)로 통과시키고, `rpc.own.harness.session.changed`는 세션 이벤트처럼 보낸다. 헤더 알약은 모든 서버에서 보이고 그 서버의 `runtime.harness`로 바꾼다.
- **남은 것**: 설정 화면의 기본값 항목은 헤더 알약으로 대신한다. Windows가 아닌 호스트는 Windows 캡처에서 Codex의 Windows 전용 부분(`exec_command`의 Windows safety rules, Windows용 `yield_time_ms` 설명)을 Codex의 POSIX 문구로 바꿔 보낸다(`src/codex/platform.ts`). `exec_command`는 POSIX에서 자기 프로세스 그룹으로 띄워 끝낼 때 그룹 전체를 끝낸다.

### 6.2 H1 결과 (2026-10-11, Codex Direct · gpt-5.5)

- **기준 버전**: Codex CLI 정식판 **0.162.1**(`rust-v0.162.1`, 092d3acd6b). 2026-10-30부터 0.165.0(§6.10), 2026-11-01부터 0.166.0(§6.12), 2026-11-12부터 0.167.0(§6.13), 2026-11-23부터 0.171.0이다(§6.14). `own/ledger/codex-pin.json`에 `release`·`cli`를 적고, `own/scripts/codex-sync.ts`는 최신 정식 릴리스 태그를 따라간다(`--apply`가 태그를 받아 `codex-data`를 다시 만들고 같은 버전 CLI를 `refs/codex-cli/<버전>`에 설치). 사용자 전역 `codex`(0.157.0)는 건드리지 않는다.
- **골든**: `script/codex-golden.ts`가 고정 버전 Codex CLI를 버리는 `CODEX_HOME`, 가짜 키, 죽은 프록시(외부 접속 차단)로 e2e-kit 가짜 Responses 서버에 붙여 실제 요청을 기록한다(`test/golden/codex/*.json`). 제공자는 이름이 `OpenAI`인 사용자 정의 제공자(WebSocket 끔)라 요청이 OpenAI 모양이다. gpt-5.5 장면의 도구 정의는 `codex-data/tools.win32.json`이 되어 하네스가 그 바이트를 그대로 보낸다.
- **Windows 빌드 흔적**: Codex Windows 빌드는 `include_str!` 템플릿(prompt.md, 권한 문구, apply_patch 문법)을 CRLF로 보내고 문법의 `%import`가 `0mport`로 깨져 있다. own은 저장소 원본(LF)을 보내고, 골든 비교는 CRLF만 접는다.
- **요청 구성**(`src/codex/request.ts`, 순수 함수): `[developer: 기본 지시문]`, `[developer: own 문맥 항목·Code Mode·MCP·참조·플러그인 조각 / <skills_instructions> / <permissions instructions> / <collaboration_mode> / (지연 도구가 있으면) <tools>]`, `[user: AGENTS.md / <environment_context>]`, 그다음 대화. core의 시스템 조각은 역할별로 가른다(에이전트 기본 프롬프트·`# Your Model`는 버리고, 설정 에이전트의 `system`은 developer 지시문으로 보존, 기준선은 `src/codex/baseline.ts`가 다시 읽음). Responses가 아닌 모델은 같은 내용을 `system`에 둔다.
  - 권한 문구: own 승인 모드 → Codex(`full`=danger-full-access+never, `ask`=workspace-write+on-request, `read-only`=read-only+never). `<environment_context>`의 `filesystem`도 같은 매핑.
  - 옵션: `parallel_tool_calls`, `text.verbosity`, 기본 추론 강도, 카탈로그가 `none`이면 추론 요약을 지운다(`reasoningSummary: null`).
- **도구**(`src/codex/tools.ts`, 권한은 P-019로 core와 같게): `exec_command`·`write_stdin`(Codex 통합 실행 이식, `src/codex/exec/*`), `apply_patch`(Codex 엔진 이식, Responses에서는 freeform 문법 도구), `view_image`, `request_user_input`(Plan 에이전트에서만, 아니면 Codex 거부 문구). 셸 heredoc `apply_patch`는 Codex처럼 가로챈다. 이 도구들은 `Gate`로 `codex` 세션에만 보인다. core의 `shell`·`patch`·`edit`·`write`·`read`·`glob`·`grep`·`question`·`skill`·`webfetch`는 `codex` 요청에서 빠진다.
- **코어 확장 지점**: P-019(플러그인 도구 권한 요청), P-020(Responses freeform 도구), P-021(developer 조각을 input_text 항목으로). 모두 더하기만 하고 `opencode` 하네스의 요청은 그대로다(ai 시험 1,790개 통과).
- **동일성**: `test/e2e/golden.test.ts`가 같은 장면을 own으로 돌려 Codex 0.162.1 요청과 비교한다. 기본 지시문, permissions, AGENTS.md, environment_context, 프롬프트, 호출과 결과(머리말 형식), 공유 도구 5개 정의, 요청 필드가 같다. **남은 차이**: goals 도구 3개, `tool_search`, 호스팅 `web_search`, `tool_choice: "auto"` 생략(API 기본값).
- **GPT-6 계열(H3)**: Codex는 gpt-6.x·gpt-5.6을 Code Mode Only + Responses Lite로 부른다(골든 `exec-gpt6`): 첫 입력 `additional_tools`(namespace `functions`: freeform `exec`·`wait`·`request_user_input`·`request_user_input_async`, `clock`: sleep, `collaboration`: 에이전트 도구 6개), `tools` 필드 없음, `parallel_tool_calls:false`, `reasoning.context:"all_turns"`, `<multi_agent_role>`·`<multi_agent_mode>` developer 메시지, `exec` 결과는 `Script completed\nWall time X.X seconds\nOutput:\n` + 항목들. §6.3에서 맞췄다.
- 이후 닫힌 차이: goals 도구(§6.4), 호스팅 `web_search`(P-023), `tool_choice: "auto"`(P-022), `tool_search`(§6.5). gpt-5.5 골든은 남은 차이가 없다.
- **카탈로그 밖 모델**: `test/e2e/golden-unknown.test.ts`가 `exec-unknown-model`과 비교한다. 대체 지시문, `apply_patch` 없음, `view_image`의 `detail` 없음(카탈로그 `supports_image_detail_original`), `multi_agent_v1`을 처음부터, 캐시 모드 `web_search`(전체 접근일 때만 live, 이미지 결과는 카탈로그 `web_search_tool_type`), `reasoning.summary: auto`까지 같다. 다른 것은 own의 Code Mode(`execute`)와 그 안내(Direct 세션에서 own 도구용), `<collaboration_mode>`(own은 대화형 앱처럼 동작)뿐이다.

### 6.3 H3 결과 (2026-10-12, Code Mode · GPT-6 계열)

- **요청**(`src/codex/request.ts`): 카탈로그 `tool_mode: code_mode_only`이고 Responses·freeform 경로면 Code Mode 도구를 보낸다. `exec`(Codex JavaScript 문법의 freeform), `wait`, `request_user_input`, `request_user_input_async`(카탈로그가 켠 모델), `clock.sleep`(`experimental_supported_tools`에 `clock`), `collaboration.*`(§6.5). Responses Lite면 `additional_tools` 항목(id는 Codex처럼 세션 id 이름공간의 UUIDv5), `parallel_tool_calls:false`, `reasoning.context:"all_turns"`. core의 `execute`(Code Mode)와 그 안내 문구는 빠진다. `<collaboration_mode>`는 모델 카탈로그의 재정의 문구를 쓴다.
- **런타임**(`src/codex/code-mode/*`): upstream `@opencode/codemode` 해석기 위에 Codex의 셀 모델(`exec` 양보·`wait`·`terminate`, 첫 줄 `// @exec:` 프래그마, `text`/`image`/`store`/`load`/`notify`/`setTimeout`/`yield_control`/`exit` 도우미, 출력 자르기)을 이식했다. V8과 언어 차이는 남는다.
- **중첩 도구**(`src/codex/code-mode-tools.ts`): `exec` 안의 `tools.exec_command`·`write_stdin`(Codex `code_mode_result` 객체), `apply_patch`(성공 시 `{}`), `view_image`(`{image_url, detail}`), `clock__curr_time`, goals 3개. 권한은 Direct 도구와 같은 길(P-019)로 `exec` 호출 아래에서 묻는다. `exec` 설명은 Codex가 보낸 설명에서 있는 도구의 절만 남긴다. `notify(...)`는 Codex처럼 바로 별도 출력 항목으로 넣는다(§6.8).
- **own 도구 중첩**(`src/codex/code-mode/declarations.ts`): own이 남기는 도구(MCP, core의 Code Mode 도구, 다른 플러그인 도구)는 Codex가 MCP·동적 도구를 넣듯 `exec` 안의 `tools.<이름>(args)`가 된다. 설명 절과 TypeScript 선언은 Codex의 JSON Schema→TS 렌더러 이식으로 만든다(내장 도구 선언이 캡처와 바이트까지 같음). 도구 목록은 `exec`가 불릴 때 `ctx.tool.list()`로 읽는다. MCP 호출은 `CallToolResult` 객체로 답한다. 출력 스키마가 있는 MCP 아닌 도구는 프로그램에 그 출력만 주므로, 그 결과에 함께 든 그림 파일(own.computer-use의 스크린숏)은 `image(...)`를 부른 것처럼 셀 출력에 바로 넣고 파일 이름을 지킨다(Codex에 없는 own의 동작, 2026-11-24 결정 CUU-5: 전에는 codex 대화가 스크린숏을 보지 못했다). `subagent`는 v2 모델에서 빠지고, 그 밖의 모델에서는 최상위로 남는다.
  - 작업 폴더 대화(06 §13, 2026-11-24)도 이 길이다: `tools.worktree__start(…)` 등. Codex Direct 모델은 core `execute`의 `tools.worktree.start(…)`. Codex의 도구 집합(직접 도구)은 바뀌지 않는다. 기존 Code Mode 대화는 `exec` 설명에 중첩 도구가 더해져 도구 정의가 한 번 바뀐다(WH-6).
- **`request_user_input_async`**(`src/codex/async-question.ts`): 카탈로그가 켠 모델에서 질문을 보여 주고 `{"accepted":true}`로 답한다(답은 나중에 보통 입력으로 온다).
- **코어 확장 지점**: P-024(평면 도구를 Responses 네이티브 namespace로 보내고 받기: `clock__sleep` ↔ `clock.sleep`), P-020 보강(`custom_tool_call` 재전송에 `status: "completed"`).
- **동일성**: `test/e2e/golden-gpt6.test.ts`가 `exec-gpt6` 장면을 비교한다. `additional_tools`(collaboration 포함), developer 메시지 전부(skills 목록은 설치마다 달라 틀만), 환경 문맥, `exec` 호출과 출력 항목, 요청 필드가 같다. **남은 차이**: `exec` 설명의 `web__run` 절(§6.8). MCP 리소스 도구 3개 절은 들어가 있다.

### 6.4 goals (2026-10-12)

- `src/codex/goals/*`: Codex goal 확장 이식(인자 해석과 오류 문구, 저장 모양, 예산·시간 회계, 계속 판단, 템플릿 3개).
- `src/codex/goal-runtime.ts`: 목표는 플러그인 저장소(`goal/<sessionID>`)에 둔다. 단계가 끝날 때마다 토큰(캐시 안 된 입력+출력+추론)과 시간을 청구하고, 예산을 넘는 순간 Codex의 예산 안내를 steer로 넣는다. 턴이 끝났는데 목표가 `active`면 Codex의 숨은 계속 메시지(`<codex_internal_context source="goal">`)를 synthetic으로 넣어 다음 턴을 연다. 사용자 중단은 `paused`, 사용량 한도는 `usageLimited`, 빈 답이나 `exec` 실패가 이어진 자동 턴은 `blocked`. 턴은 마지막 사용자 메시지나 목표의 계속 메시지(metadata `source: own.harness.goal`, `kind: continuation`)에서 시작한다. Codex에서 턴을 여는 입력(사용자 입력, `turn_trigger: "goal"`)이 이 둘이다. 그 밖의 synthetic 메시지는 숨은 메시지나 시스템 메시지라 앞 턴에 든다: core가 잘린 답 뒤에 넣는 이어 쓰기(출력 한도·끊긴 스트림), Code Mode `notify` steer, 백그라운드 셸·하위 에이전트 결과, 에이전트 사이 메시지, 하네스 전환 안내, 목표 자신의 예산 안내. 이들은 진행 중인 턴에 들어오거나, 쉬던 세션을 깨우더라도 Codex가 턴을 열지 않는 일이다(surface `computer-use-team-turn-metadata-projection`).
- 시험: 단위 76개, e2e(목표 생성 → 자동 계속 → `update_goal complete` → 멈춤).
- **사용자의 `/goal`(2026-10-31, merge round 8, MR8-15)**: upstream v2.2부터 core에 `/goal`(#59437, core의 목표 반복: 턴마다 검토 모델이 판정)이 있다. `codex` 대화에서 `/goal`은 Codex TUI의 `/goal`(rust-v0.165.0 `chatwidget/slash_dispatch.rs`, `app/thread_goal_actions.rs`, app-server `thread/goal/set`·`clear`, origin `User`)을 이 하네스의 목표로 돌린다. 그래서 사용자가 정한 목표와 모델의 `get_goal`·`create_goal`·`update_goal`이 한 목표다. 다른 하네스의 대화는 core의 `/goal` 그대로다. own-harness가 core의 명령을 감싼다(`GoalRuntime.command`, core P-038의 `editor.get`).
  - `/goal <목표>`: 예산 없는 새 `active` 목표가 그 대화의 목표를 바꾼다(쓴 양도 새로. TUI는 남은 목표가 있으면 물은 뒤 지우고 새로 정하는데, own은 서버 명령이라 묻지 못하고 바로 바꾼다). 쉬는 대화면 Codex의 계속 메시지로 바로 턴을 연다(`continue_if_idle`), 턴이 돌고 있으면 그 턴이 끝날 때 이어 간다. 빈 답·`exec` 실패 횟수는 새로 센다.
  - `/goal pause`·`resume`: 상태만 바꾼다. 예산을 넘은 목표를 다시 하면 `budgetLimited`로 남는다. 이룬 목표는 그대로다. 다시 한 목표는 쉬는 대화면 바로 이어 간다. `/goal clear`: 목표를 지운다.
  - 빈 `/goal`: TUI의 목표 메뉴 대신 목표·상태·쓴 토큰·시간과 사용법을 명령 실패 글로 돌려준다(core의 빈 `/goal`과 같은 방식). `/goal edit`(TUI의 편집기)는 새 목표로 바꾸는 법을 알려 준다. 파일·에이전트·스킬을 붙인 `/goal`은 거절한다(TUI는 붙인 그림을 파일로 만들어 목표 글에 넣는다).
  - 문구는 한국어(own), 규칙은 Codex 것이다. 목록 줄은 own-web이 하네스에 맞춰 바꾼다(03 §18.13).
  - 시험: 단위 `test/unit/codex/goal-runtime.test.ts`(쉬는 대화의 바로 계속, 도는 턴 뒤 계속과 바꾸기, pause·resume·clear·예산, 빈 `/goal`·edit·너무 긴 목표, 감싼 명령이 codex 대화에서만 Codex 목표를 돌림), e2e `test/e2e/goal-command.test.ts`(실제 서버: codex 대화의 `/goal`은 Codex 계속 메시지로 바로 턴을 열고 `update_goal`로 끝나며 core의 시작 글이 나가지 않음, opencode 대화는 core의 시작 글), core `test/command.test.ts`(P-038).

### 6.5 멀티 에이전트 v2 (2026-10-12)

- `src/codex/agents/*`: Codex MultiAgentV2 도구 6개의 인자 해석·대상 해석·오류와 출력 문구, `<multi_agent_role>`·`<multi_agent_mode>` 문구, 에이전트 간 메시지 형식.
- `src/codex/collab.ts`: own 자식 세션 위의 Host. 루트 세션이 `/root`, 생성된 에이전트는 자식 세션(메타데이터 `own.harness.agentPath`). `fork_turns` 기본값 `all`은 부모가 마지막 요청에 보낸 기록을 복사해 자식 요청 앞에 둔다(에이전트 메시지 제외. 2026-10-30부터는 부모 요청 전체를 그대로 둔다, §6.11). NEW_TASK는 턴을 열거나 steer하고, MESSAGE·FINAL_ANSWER는 턴을 열지 않는다. 자식 턴이 끝나면 FINAL_ANSWER가 부모로 가고 `wait_agent`가 깬다. 사용자 입력이 그 턴에 끼워 넣기로 들어오면 `wait_agent`는 `Wait interrupted by new input.`(Codex의 `steered`)으로, `clock.sleep`은 일찍 끝난다. 대기열 입력은 끼워 넣기로 바뀌기 전에는 깨우지 않는다(Codex의 TUI는 대기열 메시지를 턴이 끝날 때까지 클라이언트에 둔다, 11 §7.2, RC-64). Codex의 `agent_message` 항목 대신 텍스트 형태(assistant 메시지)로 보낸다.
- v2 모델에서는 own의 `subagent` 도구가 빠진다.
- **v1**(`src/codex/agents/v1.ts`, `src/codex/collab-v1.ts`, `src/codex/tool-search.ts`): gpt-5.5처럼 카탈로그가 `supports_search_tool`인 모델은 `multi_agent_v1` 도구 5개를 클라이언트 `tool_search` 뒤에 숨긴다(P-026: 정의는 안 보내고, 검색 결과 `tool_search_output`가 namespace를 싣는다). 카탈로그 밖 모델은 같은 namespace를 처음부터 보낸다. 검색은 Codex의 BM25 이식(토크나이저·불용어·Snowball 어간, k1 1.2, b 0.75). v1 에이전트는 Codex 스레드 id(UUID)와 별명을 가진 자식 세션이고, `wait_agent`는 최종 상태를, 부모는 `<subagent_notification>`을 턴 없이 받는다. Direct 요청에서 own의 `subagent`는 Codex의 에이전트 도구로 바뀐다.
- 시험: v1 단위, e2e(`tool_search` → `spawn_agent` → `wait_agent` 완료).
- 시험: 단위 8개, e2e(생성 → 자식 실행 → `wait_agent` 완료 → 부모 기록에 FINAL_ANSWER).
- 화면: own-web은 `exec`를 core Code Mode 카드로, `spawn_agent`를 자식 세션으로 이어지는 하위 에이전트 카드로 그린다.

### 6.6 압축 (2026-10-12)

- own 슬롯은 요약 압축을 쓰므로(계정 전환 때문에 암호화된 원격 압축 항목을 쓰지 않음) Codex의 로컬 압축을 따른다(`src/codex/compaction.ts`).
- 압축 요청: Codex 요청 모양 그대로(도구 포함, 접두 캐시 유지), 마지막에 own 공통 체크포인트 지시문(`src/checkpoint.ts`, 11 §2). 2026-10-14부터 모든 모델이 분석 칸 없는 판을 쓴다(11 §6.9). 2026-10-13 측정에서 Codex 요약 프롬프트(`compact-prompt.md`)보다 좋았고, GPT에서는 분석 칸이 오히려 점수를 낮췄다(11 §6). core는 자기 요약 프롬프트를 훅 뒤에 붙이므로 P-025(압축 훅이 지시문·답 점검·재요청·체크포인트 메타데이터를 정함)를 더했다.
- 이후 요청: core의 `<conversation-checkpoint>` 하나에 체크포인트와 사용자가 한 말(최근부터 20k 토큰, 경계 메시지는 자름, 문맥 조각과 이전 요약 제외, 순서대로)을 담는다. core가 요약하지 않고 남긴 최근 대화(`recent`)는 그 뒤에 `<recent-context>`로 붙인다. 2026-10-13 이전에 Codex 프롬프트로 만든 체크포인트는 계속 Codex의 대체 기록(사용자 메시지들, 그다음 `SUMMARY_PREFIX\n<요약>`)으로 보낸다. Codex는 초기 문맥을 마지막 사용자 메시지 앞에 다시 넣지만 own은 맨 앞에 둔다.
- 시험: 단위 4개, e2e(두 번 묻고 압축 → 압축 요청에 분석 칸 없는 체크포인트 지시문·도구 있음 → 다음 요청에 체크포인트와 사용자 메시지 원문).
- 2026-10-14: 압축은 하네스와 상관없이 같은 방식이다(11 §3). `opencode` 하네스 세션도 같은 지시문으로 압축하고 체크포인트를 같은 모양으로 다시 넣는다. core가 자기 지시문으로 만든 예전 체크포인트(own 메타데이터 없음)는 그대로 둔다. 압축이 실패하면 대체 모델, 그다음 코드로 만든 체크포인트로 이어 가고 표시한다(P-025 확장).

### 6.7 코어 확장 지점 (H3 이후)

- P-024: 평면 도구를 Responses 네이티브 namespace에 넣어 보내고 받기(`clock.sleep`, `collaboration.*`, v1 도구).
- P-025: 압축 훅이 요약 프롬프트와 체크포인트 메타데이터를 정함.
- P-026: 클라이언트 `tool_search`(`tool_search_call`/`tool_search_output`)와 지연 도구(정의는 안 보내고 호출만 평면 이름으로).
- 모두 더하기만 하고 표지가 없는 도구·요청은 그대로다. ledger에 예외 승인과 함께 적었다.

### 6.8 남은 틈 메우기 (2026-10-14)

- **실행 중 명령 출력**(`src/codex/exec/live.ts`): `exec_command`·`write_stdin`이 기다리는 동안 지금까지의 출력을 도구 진행(`context.progress` → `session.tool.progress`)의 `metadata.output`으로 보낸다. 250ms에 한 번까지, 바뀐 때만, 끝부분 64K자까지. `exec_command`는 `{command, output}`, `write_stdin`은 `{session, output}`. 셸 카드는 실행 중이면 이 값을, 끝나면 도구 결과(모델이 받은 Codex 형식 텍스트)를 보여 준다. 모델이 받는 결과는 바뀌지 않는다(같은 명령을 진행 없이 돌린 결과와 같음을 시험으로 확인).
  - Code Mode `exec` 안의 `tools.exec_command`·`write_stdin`도 같은 값을 `exec` 카드(core Code Mode 카드)에 보낸다. 셀이 `exec` 호출보다 오래 살면(양보 뒤 `wait`) 그 뒤 진행은 버린다(core는 끝난 호출의 진행을 거부한다). 같은 셀에서 명령 여럿이 함께 돌면 마지막에 보낸 것이 보인다. `exec` 안의 다른 도구가 보내는 진행도 같은 이유로 `exec`가 끝난 뒤에는 버린다.
- **멀티 에이전트 트리 저장**(`src/codex/agent-store.ts`): v2·v1 트리의 에이전트(경로, v1의 id·별명·깊이·닫힘, 상태)를 루트 세션마다 플러그인 저장소(`collab/<루트>`, `collab-v1/<루트>`)에 둔다. `fork_turns: all`·`fork_context`로 복사한 기록은 에이전트마다 `collab-fork/<세션>`에 둔다(JSON이 1,600만 자를 넘으면 저장하지 않고 경고만 남긴다. Codex도 자식마다 rollout에 복사본을 쓴다. v2 전체 기록 포크의 모양은 §6.11). Codex의 `restore_v2_agent_metadata`와 같은 일이다.
  - 재시작 뒤 트리는 처음 쓸 때 읽는다: 에이전트 도구 호출, 그 에이전트 실행의 시작·끝(이 경우 FINAL_ANSWER나 `<subagent_notification>`도 그대로 부모에게 간다), 에이전트 요청의 fork 조회. 지워진 세션의 에이전트는 읽을 때 뺀다. v1 별명은 다시 예약하고, 끝난 순서도 이어 간다.
  - 재시작 전에 돌던 에이전트는 `interrupted`로 읽는다. core는 최상위 세션만 이어 돌리고, Codex도 복원한 에이전트의 실행을 다시 열지 않는다. `followup_task`·`send_input`으로 다시 시킬 수 있다.
  - 이벤트는 모든 Location 인스턴스에 가므로, 세션의 Location 인스턴스만 저장소에서 읽어 답한다. 세션이 지워지면 그 기록을 지운다. `wait_agent` 대기와 mailbox는 메모리에만 둔다(재시작이 대기 중인 호출을 끝내고, 다음 요청이 mailbox를 비우므로).
- **notify 즉시 전달**: Codex는 `notify(...)`를 그 셀을 연 `exec` 호출의 `custom_tool_call_output` 하나로 실행 중인 턴에 바로 넣는다(`core/src/tools/code_mode/delegate.rs`; 턴이 없으면 버리고, 모델 자르기 예산에 20%를 더한 토큰으로 자른다). own은 같은 텍스트를 바로 synthetic 메시지(`steer`, `resume: false`)로 넣고, Code Mode 요청을 만들 때 같은 `exec` 호출의 도구 결과로 바꾼다(`CodeModeTools.notifications`). 다음 단계 경계에 들어가므로 Codex가 다음 요청에 넣는 것과 같은 자리다(그 `exec` 결과 뒤). 턴이 돌지 않을 때는 버리고, 호출이 기록에 없으면(압축으로 사라짐) 뺀다. `exec`·`wait` 결과에는 더 이상 붙이지 않는다.
  - **남은 차이**: Codex의 항목에는 `name: "exec"`가 있지만 core의 Responses 변환은 `custom_tool_call_output`에 `name`을 넣지 않는다(코어 패치 없이는 못 맞춘다). 화면에는 synthetic 메시지(`exec notify`)가 따로 보인다. Direct 요청이나 다른 하네스에서는 `<exec_notify call_id="…">` 사용자 텍스트로 남는다.
- **골든의 남은 차이**: MCP 리소스 도구 3개 절은 이미 들어가 있다(Code Mode에서는 Codex처럼 MCP 서버가 없어도 넣는다, `spec_plan.rs` `add_mcp_resource_tools`). `web__run`은 OpenAI 검색 백엔드를 부르는 도구(`search_query`, `image_query`, `open`, `click`, `find`, `screenshot`, `finance`, `weather`, `sports`, `time`, `turn0search0` 같은 참조 ID)라 own에 같은 도구가 없다. 설명만 넣으면 모델이 없는 기능을 부르므로 넣지 않는다. 이 명령들을 own 웹 검색으로 구현해야 닫힌다.
- **시험**: 단위(실시간 출력 5, 트리 저장 5, notify 요청 변환 1·전달 2), e2e `collab-restart`(같은 데이터로 서버를 다시 띄운 뒤 `followup_task`가 `/root/helper`를 찾고, 그 요청이 재시작 전과 같은 fork 앞부분과 하위 에이전트 역할로 시작하고, `wait_agent`가 FINAL_ANSWER에 깬다), `code-mode-notify`(다음 요청에 `exec` 출력이 둘, notify가 뒤).
- **발견(고치지 않음)**: goal 런타임은 모든 Location 인스턴스에서 `session.execution.started`를 받아 단계마다 청구하고 턴 끝을 처리한다(`src/index.ts`). Location이 둘 이상 열려 있으면 목표 사용량이 겹쳐 청구되고 계속 메시지가 두 번 들어갈 수 있다. 세션의 Location 인스턴스만 처리하게 해야 한다.

---

### 6.9 실사용 시험과 Codex CLI 기준 남은 차이 (2026-10-14)

- **실계정 시험**(`own/reports/harness-live-2026-10-14.md`): 아래 세 가지를 모두 끝까지 성공했다.
  - 계정 01→03 전환, 압축, DeepSeek 전환, gpt-6.1-sol 전환이 들어간 이어지는 과제.
  - 심어 둔 버그 5개 고치기(GPT·DeepSeek).
  - 웹 검색.
  - 시험 중에 찾은 두 문제를 고쳤다.
    - 앱이 하네스를 메타데이터로 넣어 만든 세션에 Codex 도구가 없던 문제(`Sessions.stamp`).
    - GPT-6 Code Mode에 검색 도구가 없던 문제. core `websearch`를 `exec` 안 `tools.websearch`로 넣었다. Codex의 `web__run`은 OpenAI 내부 백엔드라 own에 없다.
- **웹 검색**: OpenAI Responses 모델의 Direct 요청은 `전체 허용`에서 Codex의 호스팅 `web_search`를 쓴다. 그 밖의 모델, Code Mode, 그리고 `묻기`·`읽기 전용`(MR12-5, 2026-11-03)은 core `websearch`를 쓰고, 공급자는 own-accounts의 `own-chatgpt`다(사용자의 ChatGPT 계정으로 검색, 02).
  - 고른 까닭(MR12-5): 호스팅 검색은 공급자가 돌려서 own이 승인을 물을 자리가 없다. Codex 자신도 웹 검색 전에 묻지 않는다. 승인 정책은 실시간(`external_web_access: true`, 전체 접근)과 OpenAI 캐시 검색(그 밖) 중 무엇을 쓸지만 정한다(`config/mod.rs` `resolve_web_search_mode_for_turn`, `tools/hosted_spec.rs`). own의 `묻기`·`읽기 전용`은 검색마다 검색어를 보이고 묻기로 했으므로(MR11), 그 모드에서는 호스팅 도구 대신 묻는 core `websearch`를 보낸다. 충실도에서 달라지는 것: 그 모드의 도구 목록에 `web_search` 대신 `websearch` 함수 도구가 있고, 검색은 Codex의 캐시 검색 대신 사용자가 고른 검색 서비스로 간다. 골든(`exec-basic`, 전체 접근)은 그대로다. 모드를 바꾸면 전에도 `web_search` 정의(`external_web_access`)가 바뀌어 prefix가 한 번 새로 쓰였으므로 캐시 비용은 같다.
- **승인과 샌드박스(결정)**: Codex의 OS 샌드박스(workspace-write, 네트워크 차단)와 on-request 승인은 옮기지 않는다. own의 승인 모드(`전체 허용`·`묻기`·`읽기 전용`)와 기억하는 규칙으로 대신한다.
  - 원본(`reference`)에서는 모델에게 주는 권한 문구가 Codex 그대로이고, 모드는 §6.2 매핑을 따른다. own 개선판의 카탈로그 밖 모델은 own 승인 모드를 그대로 설명하는 문구를 받는다(§3.9, 2026-10-16).
  - `sandbox_permissions`·`justification`의 검사와 오류 문구는 Codex와 같다. 다만 own은 OS 샌드박스가 없어서 `묻기`에서는 모든 명령을 묻는다. (own 개선판의 카탈로그 밖 모델에는 이 두 입력을 보내지 않는다. 검사는 그대로 남긴다. 그래서 `justification`만 든 호출에 돌아가는 오류 문구는 개선판에서도 `sandbox_permissions: "require_escalated"`를 권한다. 원본에서 개선판으로 바꾼 세션의 앞 기록에 Codex 모양 호출이 남은 경우에만 생기고, 모델이 그 필드를 보내도 own은 무시하므로 그대로 둔다.)
  - Codex의 "안전한 명령 자동 허용"은 넣지 않았다. 셸로 보호 경로(자격 증명 파일)를 읽는 명령이 묻지 않고 지나갈 수 있기 때문이다.
- **Codex CLI 0.162.1 기준 남은 차이**
  1. OS 샌드박스 없음(위 결정).
  2. Code Mode 런타임: V8 대신 upstream `@opencode/codemode` 해석기다.
     - 클래스, getter/setter, BigInt, 사용자 Symbol이 안 된다. 오류 문구를 보고 모델이 고쳐 쓴다.
     - 정규식, async/await, 제너레이터, 구조 분해, Map/Set/Date/URL은 된다(2026-10-14 점검).
  3. `exec_command`의 `tty: true`는 진짜 PTY가 아니라, stdin을 열어 둔 파이프다. 대화형 프로그램 일부가 다르게 보인다.
  4. `web__run`(OpenAI 내부 검색·열기·클릭) 없음. 대신 `tools.websearch`를 쓴다.
  5. 멀티 에이전트 메시지가 Codex의 `agent_message` 항목이 아니라 텍스트다.
  6. `notify` 추가 출력에 `name: "exec"`가 없다(core 변환). 그 synthetic 메시지가 대화에 보인다.
  7. 압축 뒤 초기 문맥은 맨 앞에 둔다(Codex는 마지막 사용자 메시지 앞). 캐시에 유리해서 유지한다.
  8. 암호화 원격 압축은 쓰지 않는다(11, 합의).
  9. gpt-5.6-luna 같은 Code Mode + v1 에이전트 모델 조합, MCP 리소스 페이지 넘김, own 중첩 도구의 `## opencode` 이름공간 머리말은 아직 Codex와 다르다(작음).
- **모델 바꾸기 안내 `<model_switch>`**(2026-10-14; Responses Lite 모델로 연 창은 2026-10-30부터 §6.10의 `<model_instructions>`): Codex는 대화 중에 모델이 바뀌면 그 턴 앞에 새 모델의 기본 지시문을 담은 developer 메시지를 넣는다(`core/src/context/model_switch_instructions.rs`). own에는 이것이 빠져 있었다. 그래서 GPT-6(Code Mode)에서 Claude로 바꾼 실시험에서 Claude가 앞 기록의 `exec`를 흉내 내 없는 도구를 불렀다. 이제 같은 자리에 같은 문구를 넣는다. developer 메시지가 없는 경로(Chat Completions, Anthropic)에는 user 메시지로 넣는다. 같은 모델로 계정만 바꾼 경우는 넣지 않는다. 넣은 뒤 Anthropic API로 같은 전환을 다시 돌렸더니 Claude가 `exec_command`만 쓰고 도구 오류가 없었다(`own/reports/harness-live-2026-10-14.md` §5.1).
- **ChatGPT 캐시**: 백엔드는 `session-id` 헤더로 캐시를 고른다(없으면 같은 요청도 적중 0). own codex 슬롯은 core의 affinity 값을 이 헤더로 보낸다(own-accounts `auth.ts`).

### 6.10 Codex 0.165.0 따라가기 (2026-10-30)

- **기준 버전**: Codex CLI 정식판 **0.165.0**(`rust-v0.165.0`, 360319d8de, 2026-10-27). `codex-sync --apply --no-cli`로 옮겼다. 묶은 프롬프트·템플릿 파일은 `models.json` 말고 모두 0.162.1과 바이트가 같다(`codex-data/source.json`). 0.166.0(2026-10-29)도 나왔지만 이번 범위가 아니었다(2026-11-01 §6.12에서 옮겼다).
- **GPT-6.1 Terra**: 카탈로그에 `gpt-6.1-terra`가 새로 들어왔다. Code Mode Only, Responses Lite, 기본 강도 `low`, v2 에이전트, 기본 창 500k이고, 기본 지시문과 `<collaboration_mode>` 글은 Terra 것이다. 나머지 요청 필드와 글은 GPT-6.1 Sol과 같다. `codex-data/models.json`은 이제 `supports_reasoning_effort_updates`도 담는다.
- **추론 강도 갱신 `configuration_update`**: 0.165.0에서 `reasoning_effort_override` 기능이 안정판·기본 켜짐이 됐다(`codex-rs/features`). 카탈로그가 `supports_reasoning_effort_updates`를 켠 모델(`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`)을 OpenAI 경로로 부르면 Codex는 다음처럼 한다(`core/src/session/reasoning_effort.rs`). own은 `src/codex/effort.ts`가 저장된 기록을 단계마다 다시 걸으며 같은 장부를 다시 만든다.
  1. 세션의 첫 맥락 창: 첫 사용자 메시지(와 그 턴의 입력) 바로 뒤, 첫 요청 앞에 `{type: "configuration_update", reasoning: {effort}}`를 하나 넣는다.
  2. 그 뒤로는 강도가 바뀐 단계 앞에만 하나 더 넣는다. 비교 대상은 가장 최근 갱신의 강도이고, 갱신이 없으면 창의 고정 강도다. 같은 강도로 되돌아가도 하나 더 넣는다.
  3. 요청의 `reasoning.effort`는 그 창의 첫 강도로 고정한다. 강도를 바꿔도 캐시된 앞부분이 그대로다.
  4. 압축(own의 checkpoint)이 끝난 창에는 갱신을 넣지 않는다. 압축 뒤 첫 단계의 강도가 새 고정 강도가 되고, 그 뒤 바뀔 때만 넣는다. 압축 요청 자신은 갱신을 더하지 않고 고정 강도를 쓴다.
  5. 이어진 두 갱신은 마지막 것으로 합친다(@opencode/ai의 Responses 변환이 한다). 꼬리의 같은 갱신은 다시 쓴다(다시 보낸 요청).
  6. 갱신을 받지 않는 모델로 넘어간 단계는 고정을 푼다. 다른 갱신 모델로 바꾸면 그 모델의 강도를 다시 넣고 새로 고정한다. 전체 기록을 이어받은 하위 에이전트는 부모의 갱신과 고정을 이어받는다.
  - 갱신은 core의 강도 표시(`Message.effort`)로 낸다. 각 표시의 `previous`는 고정 강도이고 요청 옵션의 강도는 마지막 표시의 강도라, core의 `resolveEffortUpdates`가 고정 강도를 맨 위로 보내고 표시는 `configuration_update`로 바뀐다. 이런 모델에서는 core가 강도 전환 자리에 넣은 표시를 빼고 이 자리로 옮긴다. core의 표시는 `History.translate`와 요청 다시 짜기를 거쳐도 그대로 남으므로, 카탈로그가 켜지 않은 모델(`gpt-6-sol` 등)과 다른 공급자에서는 전처럼 core의 표시를 둔다(캐시를 지키는 own의 기존 동작, 07 `Variant.supportsEffortUpdates`와 같다).
  - **Sign in with ChatGPT**: 토큰 공유는 `configuration_update`를 거절한다(02 §3.2c). own-accounts의 `Shape.withoutEffortUpdates`는 own-harness보다 먼저 도는 훅이라(플러그인 순서) 하네스가 나중에 넣은 표시를 볼 수 없다. 그래서 하네스가 `own-siwc-*` 슬롯에서는 갱신을 만들지 않는다(`Kind.ProviderID`). `generate` 호출도 만들지 않는다(Codex의 제목 요청처럼).
  - 기록에 갱신이 없던 기존 세션은 이 판으로 처음 요청할 때 첫 사용자 메시지 뒤에 갱신이 생겨 캐시가 한 번 새로 쓰인다. 그 뒤 요청은 앞부분이 그대로다.
  - 남은 차이: 출력 없이 실패한 단계(대화에 보이지 않는 assistant 메시지)는 걷지 않는다. Codex는 그 시도에서 강도를 고정하므로, 첫 요청이 실패한 뒤 강도를 바꿔 다시 보내면 맨 위 강도가 다를 수 있다.
- **도구 증분 창(`incremental_tools`)**: 0.165.0에서 이 기능이 안정판·기본 켜짐이 됐다(c953dacb42, #55368, `codex-rs/features`). Responses Lite 모델로 열린 맥락 창은 도구 선언과 기본 지시문을 창 안에 기록하므로, 대화 중에 모델이 바뀌어도 앞부분을 다시 쓰지 않는다(`core/src/session/world_state.rs` `current_window_uses_incremental_tools`, `context/world_state/model.rs`, `context/model_instructions.rs`, 장면 스냅숏 `all__suite__scenarios__incremental_tools__incremental_tools.snap`). 0.162.1을 따른 own은 모델이 바뀌면 새 모델의 기본 지시문으로 앞부분을 다시 만들고 `<model_switch>`를 넣었다. 그래서 Sol·Terra·Astra 사이를 바꾸면 요청이 앞부분 둘째 항목부터 기준 버전이 보내는 것과 달랐다. 프롬프트 캐시는 모델마다 따로이므로 얻는 것은 주로 Codex와 같은 입력이고, 같은 창에서 앞 모델로 돌아가거나 한 모델로 계속 갈 때 앞부분이 한 가지로 남는다. 이제 `src/codex/incremental.ts`가 저장된 기록을 다시 걸으며 같은 규칙을 따른다.
  1. 창을 연 모델: 가장 최근 창 시작(own의 checkpoint나 그것을 바꾼 요약, 네이티브 압축) 뒤 첫 단계의 모델, 단계가 없으면 요청의 모델이다. 그 모델과 요청의 모델이 모두 이 경로의 Responses Lite일 때만 증분 창이다. 그 밖의 창(gpt-5.5로 연 창, 다른 공급자)은 Codex의 보통 창처럼 지금까지대로 `<model_switch>`를 넣고 지금 모델로 앞부분을 만든다.
  2. 증분 창의 앞부분은 창을 연 모델의 기본 지시문과 `<collaboration_mode>` 글을 쓴다. 첫 `additional_tools`는 요청의 도구다.
  3. 모델이 바뀐 턴의 사용자 메시지 바로 앞에 developer 메시지 `<model_instructions>`를 넣는다. 본문은 `The current model is {모델}.`과, 창이 마지막으로 기록한 기본 지시문과 다를 때 `The following instructions replace the previous base instructions:` 뒤 빈 줄과 새 기본 지시문이다(빈 지시문이면 Codex의 제거 문구). Terra와 Astra는 기본 지시문이 같아 모델 줄만 나간다. 그 뒤에 새 모델의 `<collaboration_mode>`를 developer 메시지로 다시 넣는다. Codex의 협업 모드 스냅숏에 모델이 들어 있어(`StepSettings::effective_collaboration_mode`) 모델이 바뀔 때마다 다시 나간다.
  4. 창 안에서 Lite가 아닌 모델(gpt-5.5)로 바뀐 단계는 Codex의 보통 단계처럼 `<model_switch>`와 그 모델의 `<collaboration_mode>`를 넣고 모델만 기록한다. 그래서 다음 Lite 모델은 기본 지시문을 다시 보낸다.
  5. 압축이 끝나면 새 창이 열리고, 그 창의 첫 단계 모델로 앞부분을 만든다. 압축 요청도 같은 기록을 보낸다.
  - 남은 차이: (가) 도구 목록이 바뀔 때 Codex가 붙이는 `This is an incremental tools update…` 안내와 `additional_tools` 변경분, 없어진 도구 안내(`world_state/top_level_tools.rs`)는 넣지 않는다. own은 첫 `additional_tools`에 언제나 요청의 지금 도구를 넣는다. GPT-6 모델 사이(Sol·Terra·Astra·Luna)에서는 own이 만드는 도구가 바이트까지 같아 앞부분이 그대로다. GPT-5.6·v1 에이전트 모델과 오갈 때나 MCP처럼 도구가 바뀔 때만 첫 항목이 바뀐다. 모델이 보는 도구는 Codex와 같고 캐시만 새로 쓴다. 변경분을 기록 중간에 넣으려면 @opencode/ai의 P-022가 중간 `additional_tools` 자리와 창 처음의 도구 목록을 따로 받아야 해서, 이번에는 코어 패치를 하지 않았다. (나) 지시문 변형(원본·개선판·내 지시문), 계획 모드, 권한 모드를 바꾸면 지금까지처럼 앞부분을 다시 만든다(Codex는 해당 갱신을 붙인다). (다) core는 다른 모델이 만든 assistant 항목의 공급자 id와 암호화 추론을 다음 모델에 보내지 않는다(`packages/core/src/session/runner/to-llm-message.ts` `sameModel`). 그래서 모델을 바꾼 요청은 창 앞부분과 첫 사용자 메시지까지는 앞 요청과 같고, 그 뒤 앞 모델의 첫 응답에서 달라질 수 있다. Codex는 기록을 그대로 보낸다.
  - 시험: own-harness `test/unit/codex/incremental.test.ts`(Sol → Terra, 같은 지시문의 Terra → Astra, gpt-5.5를 거친 전환, gpt-5.5로 연 창, 압축 뒤 새 창, Responses가 아닌 경로, `<model_instructions>` 세 모양), e2e `test/e2e/incremental.test.ts`(실제 서버와 가짜 OpenAI Responses에서 Sol → Terra → Sol: 둘째 요청은 첫 요청을 바이트까지 그대로 잇고, 셋째 요청도 앞 요청을 잇는다. 전환마다 사용자 메시지 앞에 `<model_instructions>`와 새 `<collaboration_mode>`가 있고 `<model_switch>`는 없다. 바꾸기 전 request.ts로는 실패한다). 실계정 확인(`script/live/incremental.ts`, ChatGPT 01, 2026-10-30): Sol 한 턴 뒤 Terra 한 턴, 요청 2개 모두 200, 둘째 요청이 첫 요청을 그대로 잇고 사용자 메시지 앞에 두 갱신이 있다.
- **고른 강도가 실제로 가도록 (고침)**: core는 variant의 설정(강도)을 요청 옵션이 아니라 모델 기본값에 둔다. 하네스는 옵션에 강도가 없으면 카탈로그 기본 강도를 넣었는데, 요청 옵션이 모델 기본값을 이기므로 `codex` 세션에서 고른 강도(`high` 등)가 카탈로그 기본(`low` 등)으로 바뀌어 나갔다(H1부터). 이제 강도 variant를 골랐으면 기본 강도를 넣지 않는다(Codex의 `effective_reasoning_effort`: 고른 값, 없으면 모델 기본).
- **own이 모르는 Codex 모델**: own-accounts가 받는 Codex 모델 목록의 행 가운데, slug가 묶은 카탈로그의 어느 slug로도 시작하지 않는 새 모델은 빼고 센다(own-protocol `CodexModels.decode`, `ROWS` 4). 하네스가 카탈로그를 가장 긴 앞부분으로 찾으므로 `gpt-6.1-terra-fast`는 Terra로 안다. 모르는 모델은 Codex의 대체 지시문과 도구로 돌게 되므로 다음 `codex-sync`까지 기다린다. 화면에는 기존 `own이 아직 모르는 Codex 모델 n개는 빠졌어요 · own 업데이트가 필요해요`로 보인다. 기준보다 옛 모델은 빼지 않는다: 기준 커밋까지의 카탈로그 기록에 있던 slug(`CODEX_RETIRED_SLUGS`, 통째로 맞춤)나 `upgrade` 힌트가 있는 행이다. 그 행의 후속 모델·은퇴 날짜·창·우선순위·속도가 프리셋 수리와 등록에 그대로 쓰인다(07 §4.3·§4.5). 두 slug 목록은 `codex-data.ts`가 own-protocol에 만들어 둔다(옛 목록은 카탈로그 파일의 이름 바뀜까지 따라간 git 기록에서 읽는다. own-protocol은 own-harness를 가져오지 않는다).
- **own-accounts**: Codex 모델 목록을 묻는 빌드 버전 `CodexMeta.BACKEND.clientVersion`을 0.165.0으로 올렸다.
- **골든**: 0.165.0 CLI 내려받기를 승인받기 전이라 다시 찍지 못했다. `exec-gpt6.json`은 0.162.1 캡처에 첫 사용자 메시지 뒤 `configuration_update {effort: low}`를 두 요청 모두에 더한 파생 골든이고, `exec-terra.json`은 그것을 Terra의 카탈로그 글로 바꾼 파생 골든이다(근거는 각 파일의 `derived`: Codex 0.165.0 장면 스냅숏 `all__suite__scenarios__astra_code_mode_call_timing.snap`에서 0.162.1과 다른 것은 갱신 한 줄뿐이고 도구·developer 글 해시가 같다. `spawn_agent`의 모델 목록은 우선순위 상위 5개라 Terra(7)가 들지 않는다). `golden-gpt6.test.ts`가 Sol과 Terra 두 장면을 돌린다.
  - **다시 찍음(2026-10-31, merge round 8, MR8-18)**: 사용자가 내려받기를 승인해 npm `@openai/codex@0.165.0`을 임시 폴더에 깔고 `OWN_CODEX_BIN=<그 codex.cmd> bun script/codex-golden.ts`로 네 장면을 모두 실제 CLI로 다시 찍었다(가짜 Responses 서버, 버리는 `CODEX_HOME`, 죽은 프록시). `exec-gpt6`·`exec-terra`는 파생 골든과 id·날짜·실행 시간 말고는 같았다. 다른 것은 테스트가 빼는 Codex 내부 메타데이터 `internal_chat_message_metadata_passthrough`뿐이다(0.165.0이 기본 지시문 항목에도 `turn_id`·`create_time`을 달고 메시지마다 `content_item_metadata`의 `provenance`를 단다. own은 이 필드를 보내지 않는다). `exec-unknown-model`도 같았다. `exec-basic`(gpt-5.5, Direct)에서 하나가 달랐다: 0.165.0은 다시 보내는 `function_call`에 서버가 준 `status: "completed"`를 그대로 둔다(codex 5ef96ab278, #52742). 그래서 하네스가 OpenAI Responses 경로에서 P-022의 새 옵션 `completedCalls`를 켜고, @opencode/ai가 다시 보내는 `function_call`에 `status: "completed"`를 단다(옵션이 없는 요청과 다른 하네스는 그대로, WebSocket 이어 보내기는 function call을 status 없이 비교하므로 영향 없음). `codex-data/tools.win32.json`과 `code-mode.win32.json`은 버전 줄 말고 바뀌지 않았다.

### 6.11 Codex 0.163–0.165 런타임 따라잡기 (2026-10-30)

- **기준**: Codex `rust-v0.165.0`(`refs/codex`, 읽기만). 옮긴 것은 런타임 동작 다섯 가지다. `codex-data`, 골든, `own/ledger/codex-pin.json`은 이 절이 아니라 §6.10이 0.165.0으로 옮겼다(두 브랜치는 merge-round8에서 합쳤다). 골든 장면 셋(`exec-basic`, `exec-gpt6`, `exec-unknown-model`)은 에이전트가 하나라 요청이 바뀌지 않는다. 코어 패치는 없다.
- **Code Mode 중단**(#51835, 0.163.0에서 Stable·기본 켬, Codex `interrupt_active_cells`): 사용자가 세션 실행을 멈추면(`session.execution.interrupted`, `reason: "user"`) 그 세션의 살아 있는 셀을 모두 끝낸다(`CodeModeTools.Runtimes.interrupt`). 앞선 `exec`가 양보해 두고 돌던 셀도 끝나서, 다음 `wait`는 `exec cell <id> not found`를 받는다. 저장 값(`store`)은 남는다. `shutdown` 중단은 셀을 두고 플러그인 종료에 맡긴다. 다른 에이전트의 `interrupt_agent`도 core에는 `user` 중단이라 같다(Codex도 `TurnAbortReason::Interrupted`).
  - 셀이 잘리면(중단, `wait`의 `terminate`, `exit()`, 세션 끝) 중첩 호출도 잘린다(`ToolContext.terminated`). 그때 첫 수집 중이던 중첩 `exec_command`는 프로세스를 끝낸다(`ExecRequest.signal`). 프로그램이 그 프로세스 id를 알 길이 없기 때문이다. Codex는 통합 실행 저장소에 남겨 두는데, own은 끝낸다(CXR-2). 셀이 정상으로 끝날 때 기다리지 않은 중첩 호출의 프로세스와 Direct `exec_command`는 이전처럼 남는다(`<turn_aborted>` 문구대로).
  - 중단 이벤트는 실행이 정리된 뒤 비동기로 온다. 그사이 새 턴이 셀을 만들 수 있는 틈은 모델 요청 한 번보다 짧아서 따로 막지 않는다.
- **`exit()`가 셀 전체를 끝냄**(#52748, Codex `terminate_execution`): 예외를 던지지 않고 해석기를 중단해서 셀을 바로 성공으로 끝낸다. 해석기는 중단에 `catch`·`finally`를 돌리지 않으므로 그 뒤 핸들러·타이머·promise 콜백이 돌지 않는다. `exit()` 앞의 출력과 `store` 쓰기는 남는다. 중단이 다음 단계에 닿기 전에 코드가 더 돌아도 호스트 함수는 효과가 없다(Codex의 `exit_requested` 가드): `text`·`notify`·`image`·`audio`·`generatedImage`·`store`·`yield_control`·`clearTimeout`은 아무것도 하지 않고, `setTimeout`은 `undefined`를 돌려주고, 중첩 호출은 시작하지 않는다(끝나지 않는 promise). 잡을 수 있던 표식 `__codex_code_mode_exit__`은 없앴다.
  - Codex 시험 중 객체 리터럴 getter(`get stack()`, `get image_url()`)를 쓰는 경우는 해석기가 getter를 지원하지 않아 옮기지 않았다. `toJSON`·`toString`으로 `exit()`를 부르는 경우는 옮겼다.
- **전체 기록 포크가 부모 앞부분을 유지**(#55548, 0.164.0에서 #52535의 `preserve_fork_prefix`를 기본으로): `fork_turns`를 생략하거나 `all`로 만든 v2 자식의 요청은 부모가 마지막에 보낸 요청을 그대로 앞에 둔다. 기본 지시문, `additional_tools`, developer 조각, 부모의 `<multi_agent_role>`·`<multi_agent_mode>`, 환경 문맥, 에이전트 메시지, 해설, 도구 기록이 모두 들어간다. 그 뒤 순서는 다음과 같다.
  1. 생성 호출(`spawn_agent`)과 Codex의 `aborted` 출력. 부모에게는 아직 출력이 없는 호출이라 Codex가 `ensure_call_outputs_present`로 채우는 값이다.
  2. Codex의 이어받은 문맥 안내(developer, `You are now a newly spawned child agent. …`, `CodexRequest.INHERITED_NOTICE`).
  3. 자식의 `<multi_agent_role>`.
  4. 기본 지시문이 이어받은 것과 다르면(다른 모델) `<model_switch>`.
  5. developer 메시지가 이어받은 어느 것과도 다르면(다른 승인 모드 등) 자식의 developer 메시지.
  6. 자식의 `<multi_agent_mode>`.
  7. 환경 문맥이 다르면 자식의 문맥 메시지.
  8. 자식의 대화(작업 NEW_TASK부터).
  - Codex의 현재 시각 안내는 own이 보내지 않으므로 없다. 같은 모델·권한·Location의 자식은 1·2·3·6·8만 붙는다.
  - `additional_tools` 항목 id는 포크 사슬의 첫 세션 이름공간으로 만든다(`thread`). 도구가 같으면 첫 항목까지 바이트가 같다. 손자는 자식 요청을 그대로 앞에 둔다.
  - 부모의 그 단계 추론과 해설은 넣지 못한다. core가 진행 중인 단계를 플러그인에 보여 주지 않기 때문이다(Codex는 넣는다).
  - 저장(`collab-fork/<세션>`): `{prefix: {system, messages, thread}}`. JSON이 1,600만 자를 넘으면 경고(`agent_fork_prefix_not_stored`)를 남기고 이전 방식으로 포크한다. 이전 방식은 에이전트 메시지와 `<multi_agent_role>`를 뺀 부모 대화를 자식의 초기 문맥 뒤에 두는 것이다. 예전에 저장한 포크(메시지 배열)는 이전 방식 그대로 읽고 옮기지 않는다.
  - Responses가 아닌 경로에서는 요청을 기록하지 않아 이전 방식이다. 이어받은 자식이 나중에 Responses가 아닌 모델로 바뀌면 이어받은 대화만 둔다. v1(`fork_context`)은 바뀌지 않는다(Codex도 v2만).
  - 캐시: 자식은 부모 세션 id를 affinity(`session-id`, `prompt_cache_key`)로 보내므로 첫 요청이 부모의 캐시를 읽는다. 손자는 자식 id를 보내 자식과 다른 캐시 자리에 간다. Codex는 트리 전체가 루트 id를 쓴다. core `SessionAffinity`의 규칙(자식은 부모의 것)이라 고치지 않았다.
- **기다림과 sleep**(#55644): `wait_agent`와 `clock.sleep`이 시작할 때 그 턴에 이미 닿아 다음 단계를 기다리는 입력이 있으면 바로 끝낸다(`ResetWatch.pending`: 끼워 넣기 입력, 백그라운드 안내. 대기열 입력과 대기 중인 문맥 비우기 뒤의 입력은 빠진다). `wait_agent`는 에이전트 메시지가 아닌 입력이 있으면 `steered`(`Wait interrupted by new input.`)이고, Codex처럼 mailbox보다 먼저 본다. `clock.sleep`은 `Sleep interrupted by new input.`이다.
- **goal 중단 회계**(#52640): 사용자가 아닌 원인으로 멈춘 자동 계속 턴이 활동 없이 끝나면, 빈 답 턴과 함께 3턴 한도에 센다(Codex `empty_response_goal`: `automatic && !has_activity && (empty_final || interrupted)`). 3이 되면 `blocked`이고, 그 전이면 계속 메시지가 이어진다. own에서 그런 원인은 다른 에이전트가 멈추는 경우다(v2 `interrupt_agent`, v1 `send_input`의 `interrupt`). core는 API로 온 중단을 모두 `user`로 적으므로, 트리가 멈추기 직전에 표시를 남기고(`GoalRuntime.stopping`) 중단 이벤트에서 한 번 읽는다(`TurnOutcome.kind: "aborted"`). 실행 중인 턴이 없었으면 표시를 거둔다. 사용자 중단은 Codex TUI처럼 `paused`다. 중단된 턴은 `exec` 실패 횟수를 바꾸지 않는다(Codex는 턴이 정상으로 끝날 때만 본다).
- **시험**: 단위 36개 추가(`exit` 15가지 경우·호스트 함수 가드·양보 뒤 `exit`·중첩 호출 자르기, 셀 일괄 종료, 중단 이벤트, `exec_command` 프로세스 끝내기, 포크 요청 4, 포크 저장 4, 기다림·sleep·`pending` 4, goal 회계 4). e2e: `code-mode-interrupt`(양보한 셀의 긴 `exec_command`를 기다리던 중 멈추면 그 프로세스가 사라지고, 다음 턴에 셀은 없고 저장 값은 남는다), `collab-fork`(자식·손자의 첫 요청이 부모의 생성 요청과 바이트가 같고 그 뒤 모양이 위 순서다), `collab-restart`(재시작 뒤 자식 요청도 같은 앞부분). 골든 시험 파일은 바꾸지 않았다.
- **merge-round8에서 합친 결과**(2026-10-30, upstream v2.2.1 동기화·§6.10과 함께):
  1. `code-mode-tools.ts`·`collab.ts`·`codex/agent-store.ts`는 동기화 쪽 `@opencode/ai/effect` 가져오기를 쓴다. §6.10의 `effort.ts`·`incremental.ts`도 같은 진입점으로 옮겼다.
  2. `session.execution.interrupted`는 v2.2.1에서도 이름과 `reason` 값(`user`·`shutdown`·`superseded`·`inactivity`)이 같고, core가 내는 것은 `user`·`shutdown`뿐이다. 형식으로 거르는 구독(#58864)이 생겼지만 거르지 않는 구독도 그대로 모든 이벤트를 받는다. 셀 중단은 그대로 `user`에만 반응한다.
  3. Code Mode는 동기화의 "끝나지 않는 promise에 멈춘 셀은 계속 실행 중"(`isStuck`)과 이 절의 `exit()`를 함께 둔다. `exit()`가 결과를 정한 셀은 멈춤 판정을 거치지 않는다.
  4. 보존한 앞부분 포크와 §6.10의 강도 갱신: 갱신 걷기는 이어받은 요청부터 시작한다. 그래서 자식은 부모의 갱신과 고정 강도를 이어받고, 같은 강도면 갱신을 더하지 않으며, 다른 강도면 자식 작업 뒤에 하나만 더한다(`request.test.ts`). 기록만 이어받는 포크는 전처럼 그 기록 안의 갱신을 본다.
  5. 다른 모델의 자식(2026-10-31, MR8-17에서 닫음): 부모가 Responses Lite 창에서 보낸 요청은 저장한 앞부분에 그 창의 마지막 모델과 기본 지시문을 함께 둔다(`AgentStore.Prefix.window`). 자식이 Responses Lite 모델로 돌면 Codex처럼 그 창을 이어 간다: 역할 다음에 `<model_switch>` 대신 `<model_instructions>`(자식의 모델, 기본 지시문이 창의 것과 다르면 그 지시문)와, 모델이 바뀌었으면 자식의 `<collaboration_mode>`를 developer 메시지로 넣고, developer 메시지 전체는 협업 글 말고 다른 부분이 다를 때만 다시 보낸다(권한 모드가 다를 때 등). 자식이 Lite가 아닌 모델이거나 창 정보가 없는 앞부분(이 판 전에 저장한 포크)은 전처럼 `<model_switch>`다. 강도 갱신을 받지 않는 모델의 자식은 Codex처럼 이어받은 `configuration_update`가 빠진다(Codex `client.rs` `build_responses_request`가 지원하지 않는 모델의 요청에서 지움). 시험: 단위 `request.test.ts`(Terra 자식은 `<model_instructions>`·`<collaboration_mode>`만, 권한이 다른 5.6 Sol 자식은 developer 메시지도, 창 없는 옛 앞부분은 `<model_switch>`), e2e `collab-fork.test.ts`(손자가 `spawn_agent`의 `model: gpt-6-astra`로 돌고 첫 요청이 부모 요청을 바이트까지 그대로 이은 뒤 `<model_instructions>`와 `<collaboration_mode>`가 오고 `<model_switch>`가 없다).
  6. 합친 트리에서 own-harness e2e 21개 파일 92/92(`collab*`·`code-mode*`·골든 포함), 단위 통과.

### 6.12 Codex 0.166.0 따라가기 (2026-11-01, 병합 9회차, CX166)

- **기준 버전**: Codex CLI 정식판 **0.166.0**(`rust-v0.166.0`, 6ff1e1ca3b, 2026-10-29, npm `latest`). `codex-sync --ref <refs\codex> --to rust-v0.166.0 --apply --cli-prefix <임시 폴더>`로 옮겼다. `own/ledger/codex-pin.json`과 `codex-data/source.json`이 그 커밋을 가리킨다. 0.165.0의 고정 커밋(360319d8de)은 릴리스 가지의 커밋이라 0.166.0의 조상이 아니다. 그래서 바뀐 것은 커밋 목록이 아니라 트리 diff로 판단했다.
- **묶은 데이터**: 카탈로그(`models.json`, 모델 12개 그대로), `prompt.md`, 압축 템플릿, 권한 템플릿, `apply_patch.lark`가 0.165.0과 바이트가 같다. `codex-data/tools.win32.json`·`code-mode.win32.json`은 0.166.0 CLI로 다시 찍었고 버전 줄 말고 바뀌지 않았다.
- **골든**: npm `@openai/codex@0.166.0`을 임시 폴더에 깔고 네 장면을 모두 실제 CLI로 다시 찍었다(가짜 Responses 서버, 버리는 `CODEX_HOME`, 죽은 프록시). id·시각·날짜·`turn_started_at_unix_ms`를 빼면 요청 본문과 헤더가 0.165.0 캡처와 같다. 골든 시험 4/4.
  - 캡처 스크립트 고침: Codex는 Windows에서 사용자 폴더를 시스템에서 찾고(`dirs::home_dir`) `HOME`·`USERPROFILE`을 보지 않는다. 그래서 이 PC 사용자의 `~/.agents/skills`에 든 스킬이 `<skills_instructions>`에 들어갔다(그 폴더는 0.165.0 캡처 뒤에 생겼다). `codex-golden.ts`가 이제 `<HOME>/.agents/skills` 뿌리와 그 스킬을 빼고 남은 뿌리의 별칭을 당긴다. 그 폴더가 없는 PC가 보내는 것과 같다. 골든 시험은 스킬 목록을 원래 틀만 비교한다.
- **런타임 변경 없음**: 0.166.0에서 기본으로 켜진 변경 가운데 모델이 보는 것이나 Responses로 가는 것을 바꾸는 것은 없다(트리 diff를 영역마다 읽음).
  - 같은 글을 내는 구조 변경: `exec_command` 출력 렌더링이 `unified_exec/output.rs`(`CapturedStream::render`)로 옮겼지만 글과 잘림 경고는 같다(#57185, #56535, #57191). Code Mode 출력 잘림 도우미(#57584), `exec_command` 준비 단계(#57435, #57438), `apply_patch` 핸들러·런타임 분리(#57261)와 `invocation.rs`의 `intercepts_command`(#57573, 호출하는 곳이 시험뿐), fork 기록 거르기의 이동(#57278, #57586), 스킬 목록 렌더링도 모델에게 가는 글이 같다. 압축은 토큰 셈과 그림 처리만 바뀌고 프롬프트는 같다.
  - own이 하지 않는 것: 파일 참조 그림의 `[image unavailable]`(#57585, own은 그림을 본문에 넣는다), 추론 토큰 셈, 권한 프롬프트의 카탈로그 훅(카탈로그가 쓰는 모델이 없다), 확장의 world-state 앞부분, 호스트가 주는 `msg_input_<uuid>`, `web.run`의 문헌 검색, `image_gen`, 앱 서버·호스트·전송·Guardian·TUI·Windows 샌드박스 쪽.
  - 기본 꺼짐(0.166.0): `untrusted_as_tool_output`, `omit_skill_descriptions`, `skill_catalog_deltas`, `simplified_selection_hints`, `guardian_native_multi_agent_history`, `mcp_connection_sharing`, `critical_path_timing`.
  - 옮기지 않은 것 하나: Code Mode `ALL_TOOLS`의 설명 순서(#57462). 0.165.0에서 기본 꺼짐이던 `code_mode_tool_description_first`가 없어지고, 이름공간 안 도구의 설명이 늘 `도구 설명` 다음 `이름공간 설명`이다. own의 `ALL_TOOLS` 항목에는 이름공간 설명이 처음부터 없다(하네스가 core의 이름공간 설명을 받지 못한다). 그래서 뒤집을 것이 없다. 내장 중첩 도구(`exec_command` …, `clock__curr_time`)의 `ALL_TOOLS` 설명에 선언(`exec tool declaration`)이 붙지 않는 것과 함께 남은 차이다(0.166.0 이전부터). `exec` 설명 자체와 `## <이름공간>` 머리는 바뀌지 않았다.
- **own-accounts**: Codex 모델 목록을 묻는 빌드 버전 `CodexMeta.BACKEND.clientVersion`을 0.166.0으로 올렸다. "더 새 릴리스"로 0.166.0을 쓰던 시험은 0.167.0을 쓴다.
- **바뀌지 않은 앞선 결정**: `/goal`(MR8-15), 일반 모델 기본값(MR8-16), 다른 모델 자식의 창 이어 가기(MR8-17), `completedCalls`(MR8-18)와 그 밖의 MR8-15–MR8-29는 그대로다.

### 6.13 Codex 0.167.0 따라가기 (2026-11-12, CX167)

- **기준 버전**: Codex CLI 정식판 **0.167.0**(`rust-v0.167.0`, 086ccc833b, 2026-11-05, npm `latest`). `codex-sync --ref <refs\codex> --to rust-v0.167.0 --apply --cli-prefix <refs\codex-cli\0.167.0>`로 옮겼다. `own/ledger/codex-pin.json`, `codex-data/source.json`(커밋과 날짜만. 추적 파일 15개의 해시는 그대로), own-protocol `codex-slugs.ts` 머리말이 그 커밋을 가리킨다. 카탈로그(모델 12개), `prompt.md`, 압축·권한·협업 템플릿, `apply_patch.lark`는 0.166.0과 바이트가 같다. 0.168·0.169 알파의 변경(`view_image`의 `detail` 없앰, Code Mode 출력 잘림, 신뢰하지 않는 문맥의 `agent` 도구 출력, `web_search_provider`)은 정식판을 기다린다.
- **모델이 보는 변경 하나**(`deferred_tool_world_state`, 0e31c29e25 #58410, 0.167.0부터 기본 켬): 지연 도구의 이름공간이 `tool_search` 설명에서 빠지고 developer 조각 `<tools>`로 옮겼다. own은 이것을 그대로 옮겼다(`src/codex/fragments.ts` `deferredTools`, Codex `core/src/context/world_state/tools.rs`·`tools_budget.rs`).
  - `tool_search` 정의: 출처 목록(`You have access to tools from the following sources:` 줄과 `- Multi-agent tools: …`)을 늘 뺀다(`ToolSearch.definition(…, "omit")`).
  - 처음 문맥: developer 메시지의 마지막 조각(`<collaboration_mode>` 다음)으로 `<tools>\nDeferred tool namespaces:\n- multi_agent_v1: Tools for spawning and managing sub-agents.\n</tools>`를 넣는다. 이름은 UTF-8 바이트 순서, 설명은 첫 줄을 다듬어 250자로 자르고(`...`), 조각 전체는 4 KiB 안이다. 넘치면 이름을 먼저 모두 지키고 남은 바이트를 설명에 한 글자씩 돌아가며 나눈다. 이름만으로도 넘치면 `... N additional namespaces omitted.`를 넣는다. own에서 지연 도구는 v1 에이전트 도구뿐이라 실제로는 이 한 줄이다. 그래서 이 조각은 OpenAI Responses의 gpt-5.5(Codex 카탈로그에서 `tool_search`를 쓰는 Direct 모델) 대화에만 나간다. 카탈로그 밖 모델은 v1 도구를 처음부터 보내고, GPT-6 계열은 Code Mode라 지연 도구가 없다. ChatGPT 계정은 gpt-5.5를 받지 않으므로(2026-11-12 실측: `The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.`) OpenAI API 키 경로에서만 나간다.
  - 창 안에서 모델이 바뀔 때: 창의 처음 문맥은 창의 첫 단계 모델의 목록을 그대로 둔다(Codex가 기록해 둔 문맥이다). 바뀐 단계 앞에는 `<model_switch>`(또는 Lite 창의 `<model_instructions>`) 다음에 바뀐 것만 `<tools>`로 넣는다: `Added deferred tool namespaces:` / `Removed deferred tool namespaces:`, 다 빠지면 `No deferred tool namespaces remain.`. 목록이 비면 Codex는 기록하지 않으므로, 다시 생기면 `Deferred tool namespaces:` 전체가 나간다. Lite 창에서는 새 `<collaboration_mode>`와 `<tools>`가 developer 메시지 하나에 같이 들어간다(Codex가 합치는 조각들이다). 보통 창에서는 own이 `<collaboration_mode>`를 다시 보내지 않으므로 `<tools>`만의 developer 메시지다. 새 창(압축 뒤)은 그 창의 첫 단계 모델로 다시 시작하고, 그 앞의 전환에는 넣지 않는다.
  - 캐시: gpt-5.5 대화는 처음 한 번 앞부분이 바뀐다(`tool_search` 설명과 developer 메시지). 다른 모델은 바이트가 그대로다.
  - 프롬프트 보기(§3.11): `<tools>` 조각은 `tools` 칸(도구 목록)으로 보인다. `context`(덧붙인 안내)로 두면 원본·개선판 비교에서 다른 안내 조각과 짝지어졌다(CX167-10).
- **골든**: npm `@openai/codex@0.167.0`을 `refs\codex-cli\0.167.0`(npm 설치 폴더, git 클론이 아니다)에 깔고 네 장면을 실제 CLI로 다시 찍었다. `exec-basic`은 developer 메시지 셋째 조각 `<tools>`와 `tool_search` 설명만 바뀌었고, `exec-gpt6`·`exec-terra`·`exec-unknown-model`은 버전·id·시각·날짜만 바뀌었다. `tools.win32.json`은 `tool_search` 설명과 버전 줄, `code-mode.win32.json`은 버전 줄만 바뀌었다. 골든 시험은 `<tools>` 조각이 Codex 캡처와 같은지 본다.
- **own-accounts**: `CodexMeta.BACKEND.clientVersion`을 0.167.0으로 올렸다. "더 새 릴리스"로 0.167.0을 쓰던 시험은 0.168.0을 쓴다.
- **남은 차이**(이번에 닫지 않음):
  1. Code Mode + MultiAgent v1 모델(gpt-5.6-luna, codex-auto-review)은 own에서 여전히 `tool_search`와 v1 에이전트 도구가 없다(§6.9 남은 차이 9). Codex 0.167.0은 이 모델들에도 `<tools>`를 보낸다.
  2. 보통 창(gpt-5.5로 연 창 등)에서 모델이 바뀌면 Codex는 새 모델의 `<collaboration_mode>`를 다시 보내고(협업 모드 스냅숏에 모델이 들어 있다) 그 뒤에 `<tools>`를 같은 developer 메시지에 붙인다. own의 보통 창은 처음 문맥의 `<collaboration_mode>`를 지금 모델로 다시 만들고 전환 지점에는 넣지 않는다(0.165.0 이전부터의 차이). 그래서 그 자리에 `<tools>`만의 메시지가 된다.
  3. 0.167.0의 기본 꺼짐 기능(서버 쪽 Code Mode 출력 잘림, `interrupt_on_cancel`, `suppress_model_change_announcements`, `incremental_exec_tools`)과 own이 하지 않는 것(Guardian, TUI, `web.run`, 오디오, Cyber 접근 프로그램)은 그대로다.
- 시험: own-harness 단위 `test/unit/codex/deferred-tools.test.ts`(Codex `tools_tests.rs`·`tools_budget_tests.rs`의 경우와 기대 글, gpt-5.5 → v2 모델 → gpt-5.5, `tool_search` 없는 모델로, Lite 창의 합친 메시지, 새 창), `tool-search.test.ts`, e2e 골든 넷과 `codex`. 실계정은 ChatGPT 01의 기본 모델(`gpt-6.1-sol` low)로 버그 고치기 16/16이다(CX167-8). OpenAI 키의 gpt-5.5 실측은 아직 없다.

### 6.14 Codex 0.171.0 따라가기와 서버 행으로 새 모델 돌리기 (2026-11-23, 2.2.6-own.18, CX171)

- **계기**: 사용자의 ChatGPT 계정 카드에 `⚠ own이 아직 모르는 Codex 모델 2개는 빠졌어요 · own 업데이트가 필요해요`. 2026-11-22 계정 01의 실제 목록(실계정 키트의 forwarder로 `GET /models`만, 모델 요청 없음)에서 빠진 것은 `gpt-6.2-sol`·`gpt-6.2-astra`였다. 둘 다 판정 필드 값은 모두 own이 다루는 값이고, slug가 번들 카탈로그(0.167.0)보다 새것이라 빠졌다. 두 모델은 Codex `rust-v0.169.1`부터 번들 카탈로그에 있다.
- **기준 버전**: Codex CLI 정식판 **0.171.0**(`rust-v0.171.0`, ccf9be8cc4, 2026-11-19). `codex-sync --ref <refs\codex> --to rust-v0.171.0 --apply`로 옮겼고, 사용자 승인으로 npm `@openai/codex@0.171.0`을 `refs\codex-cli\0.171.0`에 깔아(Smart App Control이 막지 않음) 골든을 실제 CLI로 다시 찍었다. 카탈로그는 모델 14개(`gpt-6.2-sol`·`gpt-6.2-astra` 추가, 기존 모델의 설명·우선순위·지시문 갱신). `own-accounts`의 `CodexMeta.BACKEND.clientVersion`은 0.171.0이다. "더 새 릴리스"로 0.168.0을 쓰던 시험은 0.172.0을 쓴다.
- **옮긴 모델이 보는 변경**(골든 차이와 0.167.0→0.171.0 트리 diff를 영역마다 읽은 결과):
  1. `send_message_to_user_async`(0.167.0부터 있던 Codex 도구. 카탈로그가 `experimental_supported_tools`에 적은 모델에 Direct 도구로, GPT-6.2가 처음): `src/codex/send-message.ts`. 인자는 `{message}`(serde `deny_unknown_fields`, 다듬은 뒤 비면 `message must not be empty`), 답은 `{"accepted":true}`, 메시지는 기록의 metadata `message`로 남는다. Code Mode 모델에서는 `request_user_input_async` 다음에 `functions` 이름공간으로 나간다.
  2. `view_image`의 `detail`(#59282 `unified_image_budget`, 기본 켬): 매개변수와 출력 스키마에서 빠졌다(캡처). Code Mode의 `view_image` 결과는 `{image_url}`만이다. own은 Codex처럼 그림을 원본 크기 기준으로 다시 줄이지 않는다(전부터의 차이).
  3. `spawn_agent` 모델 목록 상한 5 → 16(#62051, `MAX_LISTED_MODELS`).
  4. `exec_command`의 `login` 설명(#61744): Windows 캡처는 PowerShell 문구, 그 밖에서는 `Request login-shell startup. Omit to inherit.`(`Platform.text`).
  5. 카탈로그 지시문·협업·다중 에이전트 글(데이터).
- **옮기지 않은 것**(남은 차이):
  1. goal 목표를 신뢰하지 않는 독립 도구 출력으로 보내기(#60342, `untrusted_as_tool_output` 기본 켬): Codex는 계속 지시문에서 목표 문단을 빼고, 목표를 `call_id` 없는 `function_call_output`(`name: goal_objective`, `namespace: agent`, 1,000토큰 가운데 자름)으로 넣는다. own의 요청 변환(@opencode/ai P-022)은 그런 항목을 만들 자리가 없어 코어 패치가 든다. own은 0.167.0의 글(목표를 `<objective>`로 안에 둠)을 그대로 쓴다.
  2. Code Mode 호스트 출력 1 MiB 자르기 안내(#59973), `content()` 전역(#60665): 한 관찰이 1 MiB를 넘을 때만 다르다.
  3. 요청 헤더 `accept-encoding: zstd,gzip`(#61264): 전송 계층이고 본문과 무관하다.
  4. 0.171.0의 기본 꺼짐 기능과 own이 하지 않는 것(Guardian, TUI, app-server, `web.run`과 그 `literature_search_query`, 이미지 생성 애니메이션)은 그대로다.
- **서버 행으로 새 모델 돌리기(사용자 결정, 2026-11-23: "새 모델마다 손으로 codex-sync를 하는 것은 안 된다")**: Codex는 ChatGPT 로그인에서 백엔드 `/models`의 행만으로 요청을 만든다(`models-manager/src/manager.rs` `apply_remote_models`, remote only. 번들 카탈로그는 쓰지 않는다). 행에는 지시문(`model_messages.instructions_template`, 옛 `base_instructions`)과 도구·자르기·강도 값이 다 있다. 실측(2026-11-22, 계정 01): 서버의 `gpt-6.2-*` 지시문은 0.171.0 번들보다도 새것이고, 다른 모델의 서버 지시문은 0.171.0 번들과 같다. 그래서 own이 Codex와 바이트까지 같아지려면 서버 행을 써야 한다.
  1. own-protocol `CodexModels.decode`가 행마다 셋 중 하나로 판정한다(07 §4.5 "서버 행으로 바로 돌리기"): 모르는 enum 값이면 뺀다. 하네스가 아직 따라 하지 못하는 값(`runtimeGap`)이면 번들에 없는 모델은 빼고 번들 모델은 번들 항목을 쓴다. 나머지는 `HarnessRow`로 받는다. 빠진 행은 `Left{slug, field, value}`로 남는다. 판정 목록은 하위 에이전트 감사(0.171.0 `ModelInfo`의 모든 필드가 요청에 주는 효과와 하네스의 처리)에서 나왔다.
  2. own-accounts는 받은 `HarnessRow`를 공유 스냅샷의 `harness`에 두고(`ROWS` 5, 계정마다의 목록에는 이유만) 같은 프로세스의 플러그인에 `codexModels.rows{have}`(범위 `local`)로 준다. 플러그인 사이의 타입 있는 길(own.accounts RPC, dsh 검색의 `protectedPaths.patterns`와 같은 방식)이고 `globalThis`는 쓰지 않는다.
  3. own-harness `src/codex/served.ts`가 Codex 요청을 만들기 전마다 리비전을 들고 묻고, 바뀌었을 때만 행을 받아 `Catalog.serve`로 둔다. `Catalog.lookup`은 서버 행(가장 긴 앞부분) → 번들 카탈로그 → 이름공간 → 대체 메타데이터 순이다. 서버 행에 없는 필드는 Codex `ModelInfo`의 serde 기본값을 따르고, `supports_parallel_tool_calls`는 Codex처럼 늘 참이다(Responses Lite에서는 원래대로 꺼짐). 지시문이 없는 행은 같은 계열의 첫 번들 모델 지시문을 빌린다(`CodexModels.nearest`. Codex는 그런 목록을 통째로 거절하므로 맞출 Codex 요청이 없다). `spawn_agent`의 모델 목록은 서버 행으로 만든다(Codex `spawn_agent_models_description`: 목록에 보이는 행, 우선순위 순, 16개, 강도와 기본 표시, 속도 tier). 하네스가 돌리지 못해 빠진 행은 이 목록에 없다(Codex는 계정의 모든 행을 늘어놓는다).
  4. `experimental_supported_tools`는 판정하지 않는다. Codex도 모르는 이름은 무시한다. 하네스는 고정 릴리스가 읽는 이름을 모두 구현한다(`Catalog.EXPERIMENTAL_TOOLS`: `clock`, `request_user_input_async`·`send_user_message_async`, `send_message_to_user_async`, `literature_search_query`는 own에 없는 `web.run`만 바꾼다). GPT-6.2의 `multi_agent_v2_in_code_mode`는 0.171.0이 읽지 않는다.
  5. SSH 호스트: 호스트는 목록을 받지 않는다(자격 증명은 lease 규칙 밖으로 나가지 않음). 대신 PC의 미러 보기(04 §9.2)가 서버 행을 내용 해시로 싣고(`MirrorView.codexRows`, 선택 필드), 호스트가 갖지 않은 행만 broker 메서드 `codexRow.get`으로 받아 호스트의 `codex-meta.json` `harness`에 쓴다(`store.changed{codex-meta}`). 그래서 호스트 대화도 같은 행으로 돈다. 행 하나가 수십 KB라 템플릿처럼 따로 받는다(프레임 1 MiB). broker `PROTO` 1과 `MIRROR_SCHEMA_VERSION`, rpcHash는 그대로다. 옛 호스트는 필드를 무시하고, 새 호스트는 옛 PC(필드 없음)에게 묻지 않는다. 실서버 단계 B의 RG20이 확인한다: PC의 `codex-meta.json`에 행을 쓰면 호스트 파일에 그 행이 생기고, 호스트의 codex 하네스 세션 요청에 그 행의 지시문이 실린다.
  6. 모델 고르기: models.dev가 아직 싣지 않은 모델도 서버 행으로 등록한다(07 §4.4 "서버 행", `Registration.served`). 같은 계열의 고정 템플릿 모델처럼 만들고(패키지, 기능, 계열, 강도 설정) 이름·창·강도는 행의 것(`display_name`, `max_context_window`, `supported_reasoning_levels`에서 `ultra` 뺌)이다. 템플릿에 쓰지 않으므로 models.dev가 그 모델을 실으면 템플릿 diff가 더한 카탈로그 항목으로 바뀌고, 행이 사라지면 함께 사라진다. `accounts.list`의 `models[]`가 `source: "served"`로 표시하고, 모델 고르기 창은 그 모델 아래에 흐린 글씨로 `모델 정보 일부는 서버 목록 기준이에요`를 보인다(지연 로드되는 Codex 문자열). `-fast` 같은 속도 항목은 만들지 않는다.
  6. 오늘의 두 모델: 서버 행 판정만으로 둘 다 돈다. 다만 이 판의 동기화 전(0.167.0 하네스)이었다면 `send_message_to_user_async`가 없어 Codex 0.167.0이 보내는 도구 하나가 빠졌을 것이다(그 도구는 0.167.0에도 있었고 번들 모델 중 쓰는 모델이 없어 옮기지 않았다). 이 판부터 하네스가 고정 릴리스의 실험 도구를 다 구현하므로, 같은 모양의 다음 모델은 업데이트 없이 돈다.
- (위 5·6은 2026-11-23 범위 추가: 사용자의 일이 대부분 SSH 호스트에서 돌고, 새 모델이 models.dev보다 먼저 서버 목록에 나오기 때문이다.)
- **업데이트가 필요한 것(자동이 아닌 것)**: ① 판정 필드에 하네스가 모르는 값(새 셸 방식, 새 apply_patch 형식, `code_mode` 같은 새 도구 방식, 새 자르기 방식, 새 검색·에이전트·요약·verbosity 값). ② `runtimeGap`의 값(모델별 도구·권한 글, 스킬 사용 글, Guardian, 검색 공급자, 새 입력 종류). ③ 고정 릴리스 뒤 Codex가 새로 읽기 시작한 실험 도구 이름(그때까지 own은 옛 Codex처럼 무시한다). ④ 모델과 상관없는 Codex의 요청·도구·출력 변경(이번 §6.14의 1–4 같은 것). 화면은 ①②를 모델과 값으로, ③④는 `새 Codex 0.172.0 출시 · …` 안내로 알린다.
- **다음 동기화를 한 명령으로**: `own/scripts/codex-sync-trial.ts`. 새 브랜치의 일회용 작업 트리(`.worktrees/codex-sync-<버전>`)를 만들고, `bun install`, `codex-sync --apply`(같은 버전 CLI가 이미 깔려 있으면 골든도 다시 찍음. CLI 내려받기는 사용자 승인이 필요해서 하지 않는다), 타입 검사와 단위·골든 e2e를 돌리고, 새 릴리스에서 서버 행 판정이 못 따라가는 것(Codex enum의 새 값, Codex가 새로 읽는 실험 도구 이름)과 기본값이 바뀐 기능 플래그를 찾아, 만든 것을 그 브랜치에 커밋하고 `own/.out/codex-sync/<버전>/report.md`를 쓴다. 병합·push·설치는 하지 않는다. `--scan-only`는 지금 작업 트리에서 찾기만 한다(0.171.0: 새 값 0, 새 이름 0). 사용자 PC에서 스스로 빌드하거나 설치하는 백그라운드 작업은 두지 않는다.
- **시험**: own-protocol `codex-models.test.ts`(서버 행 판정: 새 모델이 행으로 돈다, `base_instructions` 승격, 빌린 지시문과 `nearest`, `runtimeGap` 11가지와 이유 글, 숨김 행, 이유 목록), own-accounts `codex-meta.test.ts`(행 저장과 `rows`의 리비전, 보기의 `left`·`accountLeft`·`borrowed`)와 `codex-version.e2e.test.ts`(0.172.0에서 나온 새 모델이 지시문을 빌려 돈다), own-harness 단위(`catalog.test.ts` 서버 카탈로그 다섯 가지와 `spawn_agent` 목록이 Codex 캡처와 같음, `send-message.test.ts`, `platform.test.ts`), e2e 골든 다섯(`exec-basic`, `exec-gpt6`, `exec-terra`, 새 `exec-gpt62`, `exec-unknown-model`, 모두 0.171.0 캡처)과 **새 `runtime-row.test.ts`**: 가짜 Codex 백엔드가 번들에 없는 `gpt-6.9-nova`(0.171.0의 `gpt-6.2-sol` 행 이름만 바꿈, `test/golden/codex/runtime-row-catalog.json`)를 목록에 내면 own-accounts가 받아 하네스가 그 행으로 돌고, 요청이 같은 행을 `model_catalog_json`으로 받은 Codex CLI 0.171.0의 요청(`exec-runtime-row.json`, 새 골든 장면)과 알려진 차이 말고 같다. own-web `codex-models.test.ts`(이유 있는 안내, 빌린 지시문, 새 Codex 안내).

## 7. 위험

- **upstream merge 부담.** 코어 패치가 2–4개 늘어난다. 확장 지점만 넣고 본체는 패키지에 두어 충돌 면을 줄인다.
- **Codex 변화 속도.** 요청 구성과 카탈로그가 자주 바뀐다. 추적 스크립트로 주기적으로 반영한다.
- **정체성.** ChatGPT 구독 경로에서 요청 본문은 Codex와 같아지지만, 헤더(`originator: opencode`)는 바꾸지 않는다.
- **도구 동작 차이.** `exec_command`의 PTY 세션, Code Mode 해석기와 V8의 언어 차이는 그대로 같아질 수 없다. §4 비교와 측정으로 차이를 드러낸다.
- **읽기 전용 읽기의 모양.** own이 직접 답하는 읽기(§3.10)는 받는 모양이 적고 출력 모양이 실제 명령과 다르다. 모델이 다른 모양을 쓰면 거절돼 한 번 더 시도한다. 실계정 GPT·Claude 시험으로 모양을 넓힐지 정한다.

---

## 8. 열린 질문

1. (닫힘, H-D6) 코어 패치 예외는 더하기만 하는 확장 지점에 한해 승인됐다. 패치 목록이 정해지면 ledger에 적는다.
2. (보류, 2026-10-14) Windows `exec_command`의 PTY 방식. 지금은 파이프와 열린 stdin이다. Codex도 `tty: false`가 기본이고, 실시험의 과제는 모두 파이프로 충분했다. 대화형 프로그램이 문제로 드러나면 core PTY 모듈을 플러그인에 여는 확장 지점을 검토한다.
3. 멀티 에이전트 도구를 Codex 이름으로 바꿀 시점과 own 프리셋 관문과의 연결.
   - (2026-10-16) codex 하네스의 `spawn_agent`는 아직 프리셋의 역할(`agent`)과 모델 묶음 이름을 받지 않는다. 하위 에이전트는 부모의 공급자에서 돌고, 바꿀 수 있는 것은 모델 ID뿐이다. own 개선판도 이것을 바꾸지 않는다. 다만 `own.preset` 문맥이 위임을 허락하는 근거가 된다고 알린다(§3.9). 연결은 따로 할 일이다.
4. (닫힘, 2026-10-14) GPT 외 모델에 쓸 기본 지시문은 Codex처럼 카탈로그 밖 모델용 `prompt.md` 그대로다. DeepSeek이 실시험의 모든 과제(이어지는 과제, 버그 고치기, 검색)를 이 지시문으로 끝냈다. 계열별 조정은 문제가 측정될 때만 넣는다.
   - (2026-10-16, 고침) 2026-10-14 실시험 기록에서 Claude와 DeepSeek 모두 대체 지시문의 `apply_patch` 안내(`{"command":["apply_patch",…]}`, own에 없는 호출 형식)를 쓰지 못하고 PowerShell로 파일 전체를 다시 썼다. 그래서 승인 요청과 도구 카드에 바뀐 내용이 보이지 않았다. 문제가 측정됐으므로 own 개선판에서는 바꾼다(§3.9). Claude Opus 4.8 이후·Fable·Mythos는 own이 새로 쓴 짧은 지시문을 받고, 나머지 카탈로그 밖 모델은 대체 지시문의 그 줄을 own이 가로채는 heredoc 모양으로 바꿔 받는다. 원본은 그대로다(H-D7). 2026-10-16 실시험에서 개선판의 수정은 모두 패치였다(Claude 15/15, DeepSeek 11/11, 원본은 0, `own/reports/harness-live-2026-10-16.md`).
