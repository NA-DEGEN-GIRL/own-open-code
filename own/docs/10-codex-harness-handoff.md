# own.harness (Codex 하네스) 인계

이 작업을 이어받는 사람(또는 LLM)을 위한 문서다. 이 문서를 먼저 읽고, 그다음 `own/docs/10-codex-harness.md`(설계와 결과 §6.1–6.7), 저장소의 `AGENTS.md`(스타일·시험·커밋 규칙)를 읽는다.

## 1. 목표와 결정 (사용자, 2026-10-11)

- own(OpenCode v2 비공개 포크)은 세션마다 **하네스**를 고른다. `codex`(기본, OpenAI Codex CLI의 요청과 도구를 그대로 재현)와 `opencode`(upstream 그대로). 하네스는 나중에 더 늘 수 있다.
- 목표 수준: GPT와 GPT 외 모델 모두에서 Rust 쪽 동작까지 포함해 "Codex와 거의 같게".
- 코어 패치는 예산 예외로 허용하되 **더하기만 하는 일반 확장 지점**이어야 한다. 기존 코어와 `opencode` 하네스는 바이트까지 그대로여야 한다. 패치마다 `own/ledger/core-patches.yaml`에 `over_budget`과 `exception_approval`(H-D6)을 적는다.
- 사용자가 "원하는 수준까지 쭉 진행"하라고 했으므로 일상적인 결정은 묻지 않고 진행한다. 단 `main` 병합, push, upstream 이슈 게시는 사용자 승인이 필요하다.

## 2. 위치

- 워크트리 `D:\own-open-code\.worktrees\codex-mode`, 브랜치 `codex-mode`, `main` 4611ce9a36에서 갈라짐(인계 시점 60개 커밋 앞섬). 병합·push 안 됨. 작업 트리 깨끗함.
- `main`은 그 뒤 2.0.24-own.3까지 나아갔다. 병합할 때 `main`을 먼저 합치고 패치 번호를 맞춘다(`main`에서 P-018은 스트림 감시 패치가 쓴다).
- `#`이 없는 경로에서 작업한다(OpenTUI preload가 `#`에서 경로를 자른다). 저장소 원본 `D:\#Projects\own-open-code`에서는 시험을 돌리지 않는다.
- Codex 기준: **Codex CLI 0.162.1**(`rust-v0.162.1`, 커밋 092d3acd). 핀 `own/ledger/codex-pin.json`. 소스 클론 `D:\#Projects\own-open-code\refs\codex`는 `git -C "D:/#Projects/own-open-code/refs/codex" show 092d3acd:<경로>`로 읽는다(checkout·수정 금지). 고정 CLI 바이너리 `D:\#Projects\own-open-code\refs\codex-cli\0.162.1`. 사용자의 `~/.codex`와 전역 `codex`(0.157)는 건드리지 않는다.

## 3. 패키지 지도 (`packages/own-harness`)

| 경로 | 내용 |
|---|---|
| `src/index.ts` | 플러그인 진입점: 가드(`OWN_OPEN_CODE=1`, 앱 버전), 전체 등록, 이벤트 루프(실행 시작·끝, 단계 사용량, inbox, 삭제) |
| `src/gate.ts`, `sessions.ts`, `rpc.ts`, `history.ts`, `registry.ts`, `notice.ts` | H0: 세션 메타데이터의 하네스 바인딩, 권한 관문(codex 도구는 codex 세션에만 보임), RPC `own.harness`, 전환 시 기록 번역 |
| `src/hooks.ts` | 요청 훅(`context`/`compaction`/`generate`) → `CodexRequest.build`, 압축 프롬프트·메타데이터 |
| `src/codex/request.ts` | Codex 요청 구성: 앞머리 메시지, 도구(Direct, Code Mode, 에이전트, tool_search), 옵션(Responses Lite 등) |
| `src/codex/catalog.ts`, `baseline.ts`, `fragments.ts` | 모델 카탈로그 조회, core 기준선 시스템 조각 해석, Codex 문맥 조각 |
| `src/codex/tools.ts` (+ `exec/`, `apply-patch/`, `truncate/`) | Direct 도구: exec_command, write_stdin, apply_patch, view_image, request_user_input, web_search |
| `src/codex/code-mode-tools.ts`, `code-mode/` | Code Mode(GPT-6): exec/wait/clock.sleep, `@opencode/codemode` 위 JS 런타임, 중첩 도구, TS 선언 |
| `src/codex/goals/`, `goal-runtime.ts` | goal 확장과 세션 연결 |
| `src/codex/agents/`(`index.ts` v2, `v1.ts`, `args.ts`, `path.ts`), `collab.ts`, `collab-v1.ts`, `tool-search.ts`, `bm25/` | 자식 세션 위 멀티 에이전트 v2/v1, 클라이언트 tool search |
| `src/codex/compaction.ts`, `mcp-resources.ts`, `async-question.ts`, `clock.ts`, `platform.ts` | Codex 압축, MCP 리소스 도구, request_user_input_async, clock, POSIX 문구 |
| `codex-data/` | 생성물(손으로 고치지 않음): `script/codex-data.ts <codex 클론> 092d3acd`. `tools.win32.json`·`code-mode.win32.json`은 골든에서 오고 재생성 때 남는다 |
| `script/codex-golden.ts` | 실제 Codex 요청 캡처(버리는 CODEX_HOME, 이름이 "OpenAI"인 가짜 제공자, 죽은 프록시) → `test/golden/codex/*.json` |

함께 바뀐 패키지: `packages/ai`(P-020..P-024, P-026), `packages/core` + `packages/plugin`(P-019, P-025), `packages/own-web`(하네스 알약, 도구 카드 별칭), `packages/own-remote`(원격 번들, 게이트웨이 정책), `own/scripts`(codex-sync, 빌드 스크립트).

## 4. 코어 패치 (모두 ledger에 있음)

- P-019 플러그인 도구가 core 권한을 묻는다(`permission.paths`, `shell.authorize`. `permission.assert`는 v2.0.32부터 upstream 것을 쓰고, own-harness `HarnessPermission.assert`가 세션·에이전트·도구 호출을 채운다).
- P-020 Responses freeform(custom) 도구, custom_tool_call 재전송에 `status: completed`.
- P-021 developer 메시지를 input_text 항목들로.
- P-022 Responses Lite(`additional_tools`, `reasoning.context`, `tool_choice: auto`).
- P-023 호스팅 도구 정의 그대로 보내기(`x-opencode-hosted`).
- P-024 평면 플러그인 도구 ↔ Responses 네이티브 namespace(`x-opencode-namespace`), `deferred` 포함.
- P-025 압축 훅이 요약 프롬프트와 체크포인트 메타데이터를 정함.
- P-026 클라이언트 `tool_search`(`tool_search_call`/`tool_search_output`)와 지연 도구.

확인: `node own/scripts/check-ledger.mjs`(예산 초과 경고와 함께 `OK`). 패치 줄 수가 바뀌면 해당 항목의 `max_lines`·`commits`를 고친다.

## 5. 현재 상태 (2026-10-12)

실제 Codex 0.162.1 요청과의 골든 비교:
- `test/e2e/golden.test.ts`(gpt-5.5 Direct): 동일, 남은 차이 없음.
- `test/e2e/golden-gpt6.test.ts`(gpt-6.1-sol Code Mode): 중첩 `web__run`(OpenAI 내부 `alpha/search` 백엔드 필요, 일부러 흉내 내지 않음)과 own의 추가 중첩 `opencode__*` 도구(`KNOWN_GAPS`에 적음)만 다르다.
- `test/e2e/golden-unknown.test.ts`(카탈로그 밖 모델): own의 Code Mode `execute`와 그 안내, `<collaboration_mode>`만 다르다.

e2e로 확인한 동작: Direct 도구, freeform apply_patch, Code Mode, goal 자동 계속, v2 협업(생성·대기·FINAL_ANSWER), tool_search를 쓰는 v1 에이전트, Codex 압축. 원격 SSH 설치와 휴대폰 게이트웨이도 own.harness를 싣는다.

인계 시점 시험: own-harness 단위 390개, e2e 17개 통과. ai 전체 통과. `bun run check`는 lint 통과, typecheck는 `@opencode/desktop`(이 Windows 워크트리의 `app/src/custom-elements.d.ts` 심볼릭 링크, 원래 있던 문제)만 실패.

## 6. 남은 일 (후보이지 약속은 아님)

1. 에이전트 간 메시지를 assistant 텍스트로 보낸다. Codex는 `agent_message` 입력 항목을 쓴다(ai 확장 지점 필요).
2. Code Mode이면서 v1 에이전트인 모델(gpt-5.6-luna: `code_mode_only` + `multi_agent_version: v1`)은 아직 에이전트 도구가 없다.
3. 중첩 `opencode__*` 도구에 `## opencode` namespace 머리글이 없다(`ctx.tool.list()`로 namespace 설명이 안 보임).
4. Code Mode의 `notify(...)`는 즉시 넣지 않고 다음 결과의 머리말 뒤에 붙는다.
5. 압축 뒤 Codex는 초기 문맥을 마지막 사용자 메시지 앞에 다시 넣지만 own은 앞머리를 맨 앞에 둔다. core가 요약하지 않은 `recent`는 요약 뒤 `<recent-context>`로 붙는다.
6. v1·v2 에이전트 트리는 메모리에만 있다. 서버를 다시 켜면 실행 중 트리의 경로·id를 잃는다(자식 세션은 남음).
7. MCP 리소스: 페이지 나누기 없음(core가 첫 페이지만 읽음), 일부 필드 빠짐.
8. 사용자가 요청하면 `main`에 병합(`own/FORK.md` 릴리스 규칙, Changesets 쓰지 않음).

## 7. 작업 방법

- 시험은 패키지 폴더에서만: `cd packages/own-harness && bun test test/unit`, `bun test test/e2e/<파일>`(e2e는 실제 서버를 띄움: `startupTimeoutMs` 약 170초, `afterAll` 60초), `bun typecheck`. ai: `cd packages/ai && bun test`.
- 골든은 의도할 때만 다시 만든다: `bun script/codex-golden.ts`(고정 CLI, 네트워크 안 씀: 죽은 프록시). 골든 비교는 id, CRLF(Windows Codex 빌드가 템플릿에 CRLF를 넣음), `<current_date>`를 정규화한다.
- Codex 따라가기: `bun own/scripts/codex-sync.ts`가 변경을 보고하고, `--apply`가 핀을 옮기고 codex-data를 다시 만들고 CLI를 설치한다. 그다음 골든을 다시 돌려 차이를 고친다.
- 커밋: conventional(`feat(own): …`), 끝에 Co-Authored-By 줄, 경로를 명시해 stage(다른 에이전트가 작업 중이면 `git add -A` 금지), 줄바꿈은 LF(Windows에서 Python은 `open(..., newline="")`, 백슬래시가 든 TS는 셸 heredoc보다 Edit 도구).
- 안전: 실제 키·토큰을 입력하지 않는다. Smart App Control을 우회하지 않는다. `~/.codex`를 건드리지 않는다.
