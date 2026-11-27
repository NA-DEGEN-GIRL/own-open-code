# 12. Pi 하네스

| 항목 | 값 |
|---|---|
| 문서 상태 | v0.3 (2026-11-10, Pi 1.5.1로 기준 갱신 §3.7). 구현과 시험 완료 |
| 목적 | 세션 하네스에 세 번째 선택지 `pi`를 더한다. Pi 코딩 에이전트처럼 보이게 한다: Pi의 시스템 지시문, 도구 이름·설명·입력 형식, 결과 문구와 자르기 규칙. 압축은 모든 하네스 공통 방식(11)을 그대로 쓴다 |
| Pi 기준 | `earendil-works/pi` `dd30101cf`(v1.5.1, 2026-11-10, MIT, Copyright (c) 2025 Mario Zechner. 처음 옮긴 기준은 `3daa20280`, v1.2.0+22, 그다음 `e7a0df27c`, v1.4.0+211). 로컬 사본 `D:\#Projects\own-open-code\refs\pi`. 경로 표기 `pi:`는 `packages/coding-agent/src/` 기준 |
| 관련 문서 | 10(하네스 틀, Codex 하네스), 11(공통 압축), 02 §4.3(결정성 D1) |

---

## 0. 결정 (사용자, 2026-10-14)

| 번호 | 결정 |
|---|---|
| P-D1 | 하네스 id `pi`. 화면 이름 `Pi 방식`(영어 `Pi`). 새 세션 기본값은 그대로 `codex` |
| P-D2 | 시스템 지시문은 Pi의 구조(앞말, `<tools>`, `<rules>`, `<addendum>`, `<project_context>`, `<skills>`, `<cwd>`)를 그대로 옮긴다. Pi 자신의 문서 안내(`docs`)만 뺀다 |
| P-D3 | 도구는 Pi 기본 네 개 `read`·`bash`·`edit`·`write`. 이름·설명·입력 형식·결과 문구·자르기를 Pi와 같게 한다. core의 겹치는 도구는 빼고, 나머지 own·플러그인 도구는 Pi가 말하는 "그 밖의 도구"로 둔다 |
| P-D4 | 기록 번역: Pi `bash{command}` ↔ 셸 동작. Pi에는 패치 도구가 없어 이전 패치 호출은 이름을 그대로 둔다(전환 안내에 적음) |
| P-D5 | 압축은 공통 방식(11). Pi 세션도 같은 지시문으로 압축하고 체크포인트를 같은 모양으로 넣는다 |

---

## 1. Pi가 하는 것

- **시스템 지시문**(`pi:core/system-prompt.ts`): 이름 붙은 구역을 순서대로 이어 붙인다. 앞말은 태그 없이, 나머지는 `<이름>…</이름>`으로 감싸고 빈 줄로 잇는다. `<tools>`는 한 줄 설명(snippet)이 있는 도구만 적고 "그 밖의 도구가 있을 수 있다"는 문장을 붙인다. `<rules>`는 셸 안내 한 줄, 도구별 지침, 고정 두 줄. `<project_context>`는 전역 AGENTS.md 다음 프로젝트 파일을 루트부터. 사용자 지정 지시문(SYSTEM.md)이 있으면 앞말을 바꾸고 `<tools>`·`<rules>`를 뺀다. 날짜와 환경 정보는 없다.
- **도구**(`pi:core/tools/`): `read`(줄 번호 없이 본문, `offset`/`limit`, 2000줄 또는 50KB에서 자르고 이어 읽기 안내, 이미지는 첨부), `bash`(stdout·stderr 한 줄기, 뒤쪽 2000줄 또는 50KB, 전체 출력은 임시 파일, 실패 시 `Command exited with code N`), `edit`(`edits[]` 여러 개를 원본 기준으로 정확히 맞추고, 안 되면 공백·따옴표·대시를 접은 느슨한 일치, BOM 유지, 고치지 않은 줄의 줄바꿈은 줄마다 그대로), `write`(부모 폴더까지 만들고 덮어씀).
- **Windows**: 기본 도구는 `bash`이고 Git Bash(`Program Files\Git\bin\bash.exe`, 없으면 PATH의 bash)로 돈다. 셸 파일이 있는지는 `access(F_OK)`로 본다(Store 별칭도 통과). `%SystemRoot%` 아래 `System32`·`Sysnative`의 `bash.exe`는 예전 WSL 실행기로 보고 명령을 stdin으로 준다. PowerShell 도구는 따로 있고 기본으로 꺼져 있다.
- **오류**: 도구가 던진 오류 문구가 그대로 모델에게 가고 오류 표시(`isError`)가 붙는다.

---

## 2. own이 옮긴 것

### 2.1 파일

| 파일 | 내용 |
|---|---|
| `src/pi/prompt.ts` | 지시문 구역 만들기, 스킬 목록 형식, 도구별 snippet·지침 |
| `src/pi/request.ts` | Pi 세션의 요청 구성(순수 함수) |
| `src/pi/tools.ts` | 네 도구를 플러그인 도구로 등록, own 권한 연결 |
| `src/pi/read.ts`·`bash.ts`·`edit.ts`·`write.ts` | 각 도구의 실행과 결과 문구 |
| `src/pi/edit-diff.ts`·`truncate.ts`·`output.ts`·`paths.ts`·`shell.ts`·`args.ts` | 일치·차이 표시, 자르기, 출력 모으기, 경로 해석, 셸 찾기·실행, 입력 검사 |
| `pi-data/` | Pi의 MIT `LICENSE`, `NOTICE`, 옮긴 원본 파일과 해시(`source.json`) |

### 2.2 요청 (`hooks.ts`의 `context`·`compaction`·`generate` 훅)

- core의 시스템 조각을 Pi 지시문 하나로 바꾼다. 재료는 core 기준선(`codex/baseline.ts`로 다시 읽음): AGENTS.md 파일들 → `<project_context>`, 기준선이 나열한 스킬 → `<skills>`, Location 폴더(`/`로 바꿈) → `<cwd>`.
- own이 지켜야 하는 문맥은 `<addendum>`에 넣는다: Code Mode 목록, MCP 안내, 참조 폴더, own 문맥 항목(`own.preset`, `own.team.role` 등 `<context key>` 형식), 다른 플러그인이 붙인 시스템 조각. core의 날짜·환경 구역과 `# Your Model`은 뺀다(Pi에 없음).
- OpenAI Responses 모델에서는 Pi처럼 지시문을 첫 developer 메시지로 보내고, 그 밖에서는 시스템 지시문으로 보낸다.
- 기록은 Pi 도구 이름으로 번역하고(`History.translate`), 체크포인트는 공통 형식으로 그린다(`CodexCompaction.render`). 저장된 기록과 대상 모델만으로 정해지므로 같은 기록은 같은 바이트다.

### 2.3 도구와 권한

- core에도 `read`·`edit`·`write`가 있어 이름이 겹친다. 그래서 Pi 도구는 `pi_read`·`pi_bash`·`pi_edit`·`pi_write`로 등록하고, Pi 세션의 요청에서만 Pi 이름으로 바꿔 보낸다. core는 이름을 바꾼 정의를 원래 도구로 되돌려 실행한다. 다른 하네스 세션에는 core 도구가 그대로 남는다.
- 목록 관문: Pi 도구는 권한 동작 `own_harness_pi`를 달고, 모든 에이전트에 거부, `pi` 세션에만 허용 규칙이 붙는다(`Gate.PI_ALLOW`). 만들 때 하네스를 지정한 세션도 같다.
- 권한(P-019): `read`는 `read`, `edit`·`write`는 차이를 보여 주는 `edit`, `bash`는 core 셸과 같은 승인(`ctx.shell.authorize`). 다만 `읽기 전용`·`묻기`와 `explore` 역할에서는 간단한 읽기 명령을 own이 직접 답한다(§3.5, 2026-11-03). Location 밖 경로는 `external_directory` 규칙을 먼저 본다(v2.0.28부터 core 기본 규칙이 allow라 사용자에게는 묻지 않는다, 02 §9.2). 같은 파일의 수정은 한 번에 하나씩(Pi의 파일 변경 줄).
- Pi 요청에서 빠지는 core 도구: `shell`, `patch`, `edit`, `write`, `read`, `glob`, `grep`. 나머지(`question`, `skill`, `webfetch`, `websearch`, `subagent`, todo, Code Mode `execute`, MCP, 컴퓨터 사용 등)는 남는다.
- 하위 에이전트(2026-11-07): core `subagent`는 이름과 설명 그대로 간다. 새 자식은 `You are a subagent spawned by another session.` 한 줄과 부모의 글을 받고, 같은 Pi 지시문·AGENTS.md·스킬을 받는다. 자기 `system`이 있는 역할(core `explore`)은 그 글이 `customPrompt`가 되어 Pi의 첫 문단과 `<tools>`·`<rules>`를 대신한다. 설정 > 에이전트 방식의 Pi 탭 `하위 에이전트`가 실제 설명(Available subagents 목록 포함)과 돌아오는 글을 보인다(10 §3.11).

- 작업 폴더 대화(06 §13, 2026-11-24): own.team의 `worktree_*` 도구는 core `execute` 안에 남는다(`tools.worktree.start(…)`). Pi의 네 도구는 그대로다.

### 2.4 전환과 화면

- 전환 안내: Pi로 갈 때 `Earlier exec_command calls are shown as bash.`, 패치 도구는 이름이 그대로라는 줄, Pi 도구 목록 줄을 넣는다. `opencode`↔`codex` 안내 문구는 예전과 같다.
- 화면: 하네스 알약과 메뉴에 `Pi 방식`. 도구 카드는 `bash`를 셸 카드로 그리고, Pi `edit`의 한 건짜리 `edits`는 core 편집 카드의 미리보기 필드로 바꿔 보인다(`own-web` `transcript/tool-alias.ts`). 결과의 `metadata.files`가 있으면 그 차이를 그린다.

---

## 3. 이번에 정한 것 (애매했던 점)

| 항목 | 정한 내용 |
|---|---|
| 설정 에이전트의 자체 지시문 | Pi의 사용자 지정 지시문(SYSTEM.md)으로 본다. 앞말을 바꾸고 `<tools>`·`<rules>`가 빠진다(explore 하위 에이전트 등) |
| 설정 `instructions`(파일·URL) | Pi의 덧붙인 지시문(`--append-system-prompt`, APPEND_SYSTEM.md)으로 본다: 내용을 Pi가 덧붙일 글을 잇듯 빈 줄로 이어 `<addendum>` 맨 앞에 둔다. 빈 내용은 넣지 않는다(Pi는 빈 `--append-system-prompt`를 버리고, Codex도 빈 `developer_instructions`를 넣지 않는다). `<project_context>`에는 전역 AGENTS.md와 프로젝트 AGENTS.md(루트부터)만 간다(`Baseline.sources`, 10 §3.3). 작업 폴더는 실제 경로로 견주므로 junction·심볼릭 링크로 연 위치도 같다. 기준선만으로 가를 수 없는 경우(앞에 아무것도 없는 설정 `AGENTS.md`, core가 걷지 않은 위 폴더의 설정 `AGENTS.md`, 전역 설정 폴더 안의 작업 폴더, 그 자체가 링크인 AGENTS.md)는 10 §3.3에 적었다. 설정 `instructions`가 없는 세션의 바이트는 전과 같다 |
| 실패 결과 | Pi 문구 그대로 보통 결과로 돌려준다. core의 도구 오류는 모델에게 JSON 묶음(`{"error":…}`)으로 가서 문구가 달라지기 때문이다. 셸 카드는 `exit`로 실패를 표시한다 |
| 입력 검사 | core 검사 대신 Pi 방식(선택값 null 제거, 형 변환, `Validation failed for tool "edit": …`)을 도구 안에서 한다. 오류에 Pi 이름이 나온다 |
| core 입력 보정과 `edit` | core의 입력 보정 플러그인이 모델이 부른 이름(`edit`)으로 도구를 찾아 Pi `edits`를 지우던 문제는 P-028로 고쳤다: 별칭 호출은 실제로 실행할 도구(`pi_edit`)의 형식으로 보정한다 |
| 시간 제한 없는 명령 | Pi의 `bash`는 기본 시간 제한이 없다. own은 모델이 `timeout`을 주지 않으면 600초 뒤 Pi의 시간 초과 문구로 끝낸다. Windows에서 Git Bash heredoc을 읽는 네이티브 프로그램(`python - <<'EOF'`)이 끝나지 않아 턴이 멈춘 일이 있었다(2026-10-14 실시험). 도구 설명과 스키마는 Pi 그대로다 |
| `PI_*` 환경 변수 | `PI_SESSION_ID`(own 세션 id), `PI_PROVIDER`, `PI_MODEL`을 넣는다. `PI_SESSION_FILE`·`PI_REASONING_LEVEL`은 없다 |
| 작업 폴더가 있는 이전 셸 호출 | Pi `bash`에는 폴더 칸이 없어 `cd '<폴더>' && <명령>`으로 보인다 |
| 이미지 | PNG·JPEG·GIF·WebP는 그대로 첨부. Pi의 크기 줄이기와 BMP→PNG 변환은 없어서 BMP는 Pi의 변환 실패 문구로 답한다 |

---

### 3.1 own 개선판 (2026-10-14, 10 §3.9)

- 세션마다 `지시문`을 `개선판`(처음 값, 2026-10-17 H-D7 고침. 그 전에는 원본) 또는 `원본`으로 고를 수 있다. 개선판에서는 GPT를 포함한 모든 모델이 한 줄 Code Mode 목록을 받는다.
- 개선판은 Pi 지시문을 그대로 두고, `<addendum>`의 core Code Mode 목록만 도구당 한 줄로 줄인다(`src/pi/variant.ts`). 실측은 `own/reports/harness-live-2026-10-14.md` §6에 있다.
- 같은 줄이기를 Codex 방식의 개선판도 쓴다(10 §3.9, 2026-10-16).

### 3.2 내 지시문 (2026-10-18, 10 §3.11)

- 세 번째 지시문 `내 지시문`(`custom`)은 개선판에서 Pi 지시문의 **첫 문단**(`PiPrompt.PREAMBLE`, "You are a coding assistant running inside pi…", Pi 1.5.0 전에는 "You are an expert coding assistant operating inside pi…")만 사용자의 글로 바꾼다. own이 더한 `PiPrompt.Options.preamble`이 그 자리를 채운다. `<tools>`, `<rules>`, `<addendum>`, `<project_context>`, `<skills>`, `<cwd>`는 그대로 만든다. Pi의 SYSTEM.md(`customPrompt`)는 첫 문단과 함께 `<tools>`·`<rules>`도 빼므로 쓰지 않는다.
- 설정 에이전트의 자기 지시문(`customPrompt`)이 있으면 지금처럼 그것이 이긴다.
- 원본과 개선판의 첫 문단은 같다. 그래서 `개선판에서 시작`과 `원본에서 시작`이 같은 글을 복사한다.
- 저장한 글이 없으면 개선판으로 일한다. 원본·개선판 요청의 바이트는 바뀌지 않는다.

### 3.3 Pi 기준 갱신 (2026-10-30)

- 기준을 `3daa20280`(v1.2.0+22)에서 `e7a0df27c`(v1.4.0+211)로 올렸다. `pi-data/source.json`의 해시 25개를 다시 계산하니 4개만 바뀌었다: `utils/shell.ts`(아래), `ai/utils/text.ts`(새 `ownedSlice`, 메모리용이라 옮길 것 없음), `ai/utils/validation.ts`(§4 인자 JSON 오류), `test/tools.test.ts`(Pi `grep` 시험 두 개, own pi에는 `grep`이 없음). 시스템 지시문, 스킬 목록, 네 도구(`read`·`bash`·`edit`·`write`)의 원본은 바이트가 같다. 그래서 "Pi와 같다"는 말이 그대로 맞고 요청 바이트도 그대로다. 옮긴 셸 시험 세 파일의 해시를 더해 28개가 됐다. 그 뒤 v1.5.1로 다시 올린 것은 §3.7.
- `src/pi/shell.ts`에 Pi 1.4.0의 셸 고침을 옮겼다:
  - 셸 파일 확인을 `existsSync` 대신 `accessSync(F_OK)`로 한다(28bea006b). Node의 `existsSync`는 Windows에서 Store 별칭(`%LOCALAPPDATA%\Microsoft\WindowsApps`)을 거절할 수 있다(nodejs/node#36790). Bun의 `existsSync`는 이 PC에서 별칭을 받지만 Pi와 같은 방법으로 맞췄다.
  - 예전 WSL `bash.exe` 판정은 `C:\Windows`를 박아 두지 않고 `%SystemRoot%` 아래 `System32`·`Sysnative`를 본다. `%SystemRoot%`가 드라이브로 시작하지 않으면 아무것도 맞지 않고, 비어 있을 때만 `X:\Windows` 꼴을 본다(61060ddf8, #9490).
  - `taskkill.exe` 경로는 `SystemRoot || "C:\Windows"`(빈 값도 기본값으로, 61060ddf8).
  - macOS는 프로세스 묶음을 `SIGKILL` 전에 `SIGSTOP`으로 멈춘다(27cc6bfc0, #11252). 죽은 자식이 기다리던 셸을 먼저 깨워 `a; b`의 `b`가 시작되는 경쟁을 줄인다. 멈추기가 실패해도 죽이기는 한다. Linux·Windows는 그대로다.
  - 옮기지 않은 것: 설치 폴더(`ProgramFiles\PowerShell\7`, `SystemRoot\System32\WindowsPowerShell`)에서 PowerShell 찾기(61060ddf8). own pi에는 PowerShell 도구가 없다.
  - own에서 고친 것 하나: PATH에서 `bash.exe`를 찾는 `where`가 Bun의 기본값(시작할 때의 환경)이 아니라 지금의 `process.env`로 돈다. Pi(Node `spawnSync`)와 같다. 옮긴 시험이 이 차이를 찾았다.

### 3.4 Claude Agent에서 (2026-10-31, 10 §3.12)

- provider가 `claude-agent`면 Pi의 system 전체가 Claude Code preset 뒤의 역할(`claudeCodeAgent`)로 간다. Pi 지시문은 AGENTS.md와 플러그인 부분을 이미 담고 있어 겹치거나 빠지지 않는다.
- 도구 `read`·`bash`·`edit`·`write`는 `mcp__opencode__*`로 Claude에 가고 OpenCode가 실행한다.

### 3.5 읽기 전용·묻기·explore의 읽기 (2026-11-03, 결정 SA-1·SA-2)

- **문제**: Pi의 도구는 `read`·`bash`·`edit`·`write`뿐이다. `read`는 파일 하나만 읽고, 폴더 목록과 검색은 `bash`로만 한다(Pi 지시문도 "Use bash for file operations like ls, rg, find"). 그래서 `bash`가 막히면 폴더를 볼 수 없었다.
  - `읽기 전용`은 모든 셸 명령을 거절한다(`shell ** deny`). 메인이든 하위 에이전트든 `ls`도 못 했다.
  - 하위 에이전트 `explore`는 모든 승인 모드에서 셸이 막힌다(07 §2.4, own-accounts `ReadOnly`). 그래서 Pi 방식의 explore는 파일 이름을 모르면 아무것도 읽지 못했다. 사용자가 본 "explore 에이전트는 읽기 전용이라 shell(목록 조회) 권한이 없었습니다"가 이것이다. 거절 글도 Pi에 없는 `grep`·`glob` 도구를 쓰라고 했다.
- **결정(SA-1)**: Codex 방식의 읽기 전용 읽기(10 §3.10)를 Pi의 `bash`에도 쓴다. `bash`가 bash 모양의 간단한 읽기(`cat`, `head`·`tail`, `sed -n 'A,Bp'`, `ls`, `rg`, `rg --files`)를 **프로세스 없이** 직접 답한다(`CodexReadOnly.parse(…, "bash")`·`run`). 받는 모양, 권한 흐름(파일마다 `read`, 실제 경로까지), 폴더 검색 규칙, 거절은 10 §3.10과 같다. 결과는 Pi의 `bash` 결과처럼 만든다(`PiBash.answered`: 빈 출력은 `(no output)`, 0이 아닌 종료 코드는 `Command exited with code N`, 2,000줄·50KB 자르기와 임시 파일).
  - 언제: 세션 규칙이 own의 `읽기 전용`·`묻기` 묶음(보호 경로 포함, `CodexReadOnly.serves`)이거나, 세션의 에이전트가 셸을 쓰지 않는 역할(`Preset.NO_SHELL_ROLES`, 지금은 `explore`)일 때다. 역할은 승인 모드와 상관없이 늘 답한다(`CodexReadOnly.answers`). `전체 허용`의 다른 에이전트는 명령을 그대로 돌린다.
  - 거절: `읽기 전용`이나 `explore`에서 표 밖의 명령은 셸 승인으로 가서 거절되고, 모델은 맨 권한 오류 대신 own이 답하는 읽기를 bash 이름으로 적은 글을 받는다(`CodexReadOnly.refusedBash`). `explore`에게는 own-accounts의 글(core `read`·`grep`·`glob`을 쓰라는) 대신 역할의 글을 준다. `묻기`에서 표 밖의 명령은 전처럼 묻는다.
- **결정(SA-2)**: `묻기`에서도 같은 읽기를 카드 없이 답한다. 사용자가 Codex 방식에 정한 RO-D4(2026-10-17)와 같게 맞췄다. Pi의 `read`는 원래 `묻기`에서 묻지 않으므로 읽기만 묻지 않는 것은 전과 같다.
- **바뀌지 않는 것**: Pi 도구 목록과 정의, `read`·`edit`·`write`의 동작, `전체 허용`의 명령 실행(역할 밖). Pi 지시문은 §3.6의 Windows 한 줄 말고는 바이트가 같다.

### 3.6 Windows에서 `bash`가 무엇인지 (2026-11-03, 결정 SA-3)

- Pi의 `bash`는 Windows에서 Git Bash다(`PiShell.bashConfig`: `Program Files\Git\bin\bash.exe`, 없으면 PATH의 `bash.exe`). Pi 원본도 같고(`utils/shell.ts`), PowerShell은 Pi가 기본으로 끈 다른 도구다. 그래서 `bash`가 core가 보고하는 셸(pwsh)을 쓰게 바꾸지 않는다. 도구 이름과 설명이 bash이고, Pi의 모델은 bash 문법을 쓰기 때문이다.
- 문제: Pi 지시문은 어떤 셸인지 말하지 않는다. 한편 AGENTS.md나 사용자는 흔히 PowerShell을 말하고, Windows에서 다른 하네스의 셸도 PowerShell이다. 그래서 모델이 `bash`에 `Get-ChildItem`을 보냈다가 실패했다(사용자 보고, 2026-11-03).
- 결정: Windows에서만 `<rules>`에 own의 한 줄을 더한다. Pi 확장이 지침을 더하는 자리(`promptGuidelines`)이고, Pi의 도구 지침 다음, Pi의 두 규칙 앞이다. 원본·개선판·내 지시문 모두 같다(변형이 아니라 이 PC의 사실이다).
  - `On Windows the bash tool runs Git Bash, not PowerShell: use bash syntax and POSIX commands (ls, cat, rg); PowerShell cmdlets such as Get-ChildItem do not work in it`
  - Git Bash가 아니면 이름만 바뀐다: 예전 WSL 실행기는 `WSL's bash`, 그 밖은 `bash (<경로>)`. bash가 없으면 줄을 넣지 않는다(그때 `bash`는 Pi의 오류로 끝난다). 다른 OS에는 넣지 않는다.
  - 서비스가 뜰 때 Location마다 한 번 정한다(`PiShell.windowsGuidelines`). 같은 PC에서는 늘 같은 바이트라 캐시가 지켜진다. 이 판이 깔린 뒤 Windows의 Pi 대화는 지시문이 한 번 바뀌어 첫 요청에서 캐시를 처음부터 쓴다.
  - 설정 > 에이전트 방식의 지시문 보기도 같은 줄을 보인다.

### 3.7 Pi 1.5.1로 기준 갱신 (2026-11-10, 결정 PI151)

- 기준을 `e7a0df27c`(v1.4.0+211)에서 `dd30101cf`(v1.5.1, 2026-11-10)로 올렸다. 그사이 470개 커밋이 있었고, `pi-data/source.json`의 해시 28개 중 12개가 바뀌었다: `system-prompt.ts`, `skills.ts`, 도구 `read`·`bash`·`edit`·`edit-diff`·`write`·`truncate`, `utils/paths.ts`, `ai/utils/validation.ts`, 시험 `system-prompt.test.ts`·`tools.test.ts`. 옮긴 Pi 시험 네 파일(`read-streaming.test.ts`, `edit-tool-diff-before-write.test.ts`, `suite/regressions/11613-bash-timeout-after-shell-exit.test.ts`, `ai/test/validation.test.ts`)과 문구·변환 규칙을 옮긴 pi-schema 두 파일(`schema/src/explain.ts`·`coerce.ts`)을 더해 34개가 됐다. 이 판에서 Pi 지시문과 도구 문구는 다시 Pi와 바이트가 같다.
- **지시문**(705d047cb, Pi 1.5.0): 첫 문단이 `You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.`, `<tools>`의 끝 줄이 `Additional tools may be available.`, `edit` 지침이 네 줄에서 두 줄(`Use edit for targeted changes. Batch changes to one file in a single call.`, `Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.`), 스킬 안내의 상대 경로 줄이 `Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.`로 바뀌었다(422자 짧아짐. Pi의 `docs` 구역도 바뀌었지만 own은 그 구역을 넣지 않는다). 원본과 개선판은 그대로 따르고, 내 지시문은 사용자의 첫 문단을 두고 나머지 세 곳만 바뀐다. 첫 요청의 바이트가 바뀌므로 **이 판이 깔린 뒤 기존 Pi 대화는 첫 요청에서 캐시를 한 번 처음부터 쓴다**(§3.6 때와 같다).
- **편집의 줄바꿈**(d448c51e2, #11751, #8544): 전에는 파일에서 처음 만난 줄바꿈으로 파일 전체를 다시 썼다. CRLF와 LF가 섞인 파일은 편집 한 번에 모든 줄의 줄바꿈이 바뀌고, 줄 안에 홀로 있는 CR은 줄바꿈이 됐다. 승인 카드는 LF로 맞춘 글끼리 비교하므로 사용자에게 보이지 않았다(Windows 저장소에서 git 차이가 파일 전체로 번졌다). 이제 일치는 전처럼 LF로 맞춘 글에서 하고, 바꿀 범위만 원본에 끼워 넣는다(`PiEditDiff.applyReplacementsToOriginal`). 새 글의 줄바꿈은 바꿀 범위가 시작하는 줄의 것을 따르고(끝 줄이 줄바꿈 없이 끝나면 그 앞 줄), 홀로 있는 CR은 LF가 하나도 없는 파일에서만 줄바꿈으로 본다. 남긴 CR과 새 글의 LF가 이음매에서 만나 CRLF 하나로 합쳐지지 않도록 LF를 하나 더한다. 느슨한 일치는 전처럼 닿은 줄만 통째로 다시 쓰고, 그 밖의 줄은 바이트가 그대로다. CR이 없는 파일은 전과 같다. 표시용 차이와 패치는 이제 쓰기 전에 만든다. Pi의 창 단위 차이(`generateEditDiff`, 바뀐 곳 앞뒤 32줄만 비교)는 옮기지 않았다: own의 승인 카드(`tools.ts` `fileDiff`)가 어차피 파일 전체를 비교하고, 차이와 패치의 글은 같다.
- **입력 검사 문구**(6536f8012, Pi 1.5.0): Pi가 TypeBox 대신 `@earendil-works/pi-schema`로 검사한다. 빠진 필수 값은 하나씩 `- <경로>: missing`, 형이 다르면 `- <경로>: expected <형>, got <형>`(정수는 `integer`, `null`·`array`는 `object`와 따로)으로 알린다. 객체가 아닌 인자는 `root`에서 알린다. 변환도 넓어졌다(TypeBox 1.3.27 `Value.Convert` 규칙): 값 하나는 한 칸짜리 배열로, 필수 문자열의 null은 `"null"`로, 숫자에는 `"true"`/`"false"`와 `12n` 꼴도 받는다. own은 pi-schema에 기대지 않고 `src/pi/args.ts`의 작은 검사기에 Pi 네 도구가 쓰는 형(문자열, 숫자, 객체, 객체 배열)만큼 옮겼다.
- **셸이 끝난 뒤의 시간 초과**(06aa6563e, #11813, #11613): 셸은 끝났는데 셸이 띄운 뒷단 프로세스가 물려받은 출력 관에 계속 쓰면, 시간 초과 문구 뒤에 `. The shell exited with code X after Y seconds, but background processes it started kept writing output until the timeout.`이 붙는다(`PiShell.TimeoutError`). own은 시간 제한을 주지 않은 명령도 600초에 끝내므로(§3), `npm run dev &` 같은 명령이 시간 초과로 끝나도 모델이 셸의 실제 종료 코드를 안다. Windows에서는 셸 pid가 사라진 뒤 `taskkill /T`가 뒷단 프로세스를 찾지 못해 출력이 멈출 때까지 기다린다. 이 한계는 전에도 있었다. own은 셸이 **마감 전에** 끝났을 때만 이 문장을 붙인다(Pi에 없는 조건): 부하가 큰 이 PC에서 Git Bash가 뜨는 데 2–3초가 걸려, 3초 제한에 셸이 3.2초에 끝났는데 Pi의 코드대로면 `exited ... after 3.2 seconds`가 붙었다(실시험, 모델이 앞뒤가 안 맞는다고 지적). 이벤트 루프가 늦게 돌아 마감 콜백보다 종료 이벤트를 먼저 처리한 경우다.
- **흘려 읽기**(3a7bb6f48, #11750, #9654): `read`가 파일을 통째로 읽어 Buffer, 문자열, 줄 배열로 세 번 들고 있던 것을 조각으로 읽고, 보일 줄(그리고 자르기 판단에 필요한 한 줄)만 들고 나머지는 센다. 모델이 읽는 글은 같다. 열 때의 크기까지만 읽으므로 읽는 중에 커지는 파일도 끝난다. 소수나 음수 범위는 전처럼 통째로 읽는다(배열 자르기가 뜻을 정함). 이 PC에서 200MB 로그의 한 줄 읽기: 최대 메모리 536MB → 약 100MB. own은 조각을 Pi(Node의 64KiB)보다 큰 1MiB로 읽는다. Bun은 조각마다 비용이 있어, 부하가 있는 이 PC에서 같은 읽기가 64KiB로는 2.7–16초, 1MiB로는 0.9–2.8초였다(통째 읽기는 0.7–0.8초). 서비스 프로세스 하나를 모든 대화가 같이 쓰므로 메모리를 줄이는 쪽을 골랐다.
- 옮기지 않은 것: 서로게이트를 자르지 않는 자르기(`sliceHead`·`sliceTail`, own pi에는 `grep`의 줄 자르기와 `truncateMiddle`이 없다), Windows에서 대소문자를 무시하는 경로 비교(`utils/paths.ts`·`skills.ts`, own의 스킬 목록은 core 기준선에서 온다), 도구 반환 형(`TypeBoxAgentTool`), `grep`·`find`·`ls` 고침(own pi에는 그 도구가 없다), Pi 1.5의 공급자 기능(캐시 데우기 등).

## 4. 남은 차이

- **엄격 스키마**: Pi는 도구 입력을 공급자의 엄격 모드(`strict: true`, 선택값을 null 허용으로 바꿈)로 보내려 한다. own은 공급자 계층 그대로 엄격하지 않게 보낸다.
- **오류 표시**: Pi는 실패에 `isError`(Anthropic `is_error`)를 붙이지만 own은 문구만 같다.
- **진행 표시**: Pi TUI의 실시간 셸 출력·편집 미리보기 렌더러는 옮기지 않았다(codex의 `exec_command` 실시간 출력은 `bash`에 아직 없다). own 도구 카드가 그린다. 중단은 Pi의 `Command aborted` 대신 core의 중단 상태로 남는다.
- **입력 검사 문구**: pi-schema의 문구와 변환 규칙을 Pi 네 도구가 쓰는 형만큼 옮겼다(§3.7). 그 밖의 형(정수, 불리언, 합집합, `$ref` 등)과 pi-schema의 세 번째 단계(형별 원시 변환)는 네 도구에 쓰이지 않아 없다.
- **인자 JSON 오류**: Pi 1.4.0은 깨진 도구 인자 JSON을 앞부분만 읽어 쓰지 않고 `Invalid arguments for tool "…": …`로 알린다(`validation.ts`의 `argumentsError`, 87f9a3641). own에서는 도구 호출의 인자를 core가 읽으므로 그 판정과 문구는 core를 따른다.
- **요청 필드**: `store`, 캐시 키, 추론 설정 등은 own 공급자 계층을 따른다. Pi의 지시문 구역 갱신(바뀐 구역만 새 시스템 메시지로 보냄)은 하지 않고 매 요청 지시문을 다시 만든다.
- **이전 core 호출**: 다른 하네스에서 한 core `edit{oldString,newString}` 호출은 이름이 같아 그 입력 모양 그대로 보인다.
- **스킬·확장**: Pi의 확장 도구, 프롬프트 템플릿, 설정 파일은 없다. own 스킬과 own 도구를 쓴다. own 도구에는 snippet이 없어 `<tools>` 목록에는 Pi 네 도구만 나온다.

---

## 5. 시험

- 단위(`test/unit/pi/`): 지시문(Pi `system-prompt.test.ts` 이식과 기본 지시문 전체 비교), 도구(Pi `tools.test.ts`·`edit-tool-legacy-input.test.ts` 이식: 읽기 자르기·offset·limit·이미지, 쓰기, 편집 일치·중복·겹침·느슨한 일치·CRLF·BOM, bash 종료 코드·자르기·임시 파일·시간 초과), 셸(`shell.test.ts`: Pi `shell-path-exists`·`windows-shell-config`·`shell-kill-process-tree` 시험을 흉내 모듈 없이 실제 파일과 프로세스로. 이 PC의 Store 별칭, PATH에서 찾은 별칭 `bash.exe`, `ProgramFiles`의 Git Bash, `%SystemRoot%` 아래 WSL 판정 표, 취소한 `a; b`의 `b`가 돌지 않음), 경로(`path-utils.test.ts` 이식), 입력 검사, 요청 구성, 기록 번역과 전환 안내(`history.test.ts`), 관문 규칙(`sessions.test.ts`).
- Pi 1.5.1(2026-11-10, §3.7): `test/unit/pi/tools.test.ts`에 Pi의 줄바꿈 열 경우(CRLF·LF 파일에 넣는 줄, 섞인 줄바꿈 두 가지, 홀로 있는 CR, 여러 편집, 느슨한 일치, 이음매 두 가지, 무작위 3,000개)와 own의 Windows 섞인 파일 한 경우, 쓰기 전 차이(흉내 모듈 없이 차이가 실패하는 계획으로), 셸이 끝난 뒤의 시간 초과(뒷단 프로세스가 8초만 쓰고, 쓰기 시작한 뒤에 셸이 끝나게 해서 Windows에서도 돈다. 부하로 출력이 100ms 멈춰 기다림이 일찍 끝나면 세 번까지 다시 해 본다). `test/unit/pi/read-streaming.test.ts`(Pi 시험 이식: 통째로 읽던 예전 방식과 같은 결과를 조각 크기 1·4096으로, 상세의 키 순서, 깨진 UTF-8, 소수·음수 범위, 기본 스트림, 자라는 파일, 200MB 한 줄을 자식 프로세스에서 최대 메모리 200MB 아래로, 중단). `test/unit/pi/support.test.ts`(pi-schema 문구와 변환). `test/unit/pi/prompt.test.ts`의 기본 지시문 전체 비교는 첫 문단까지 글자로 적는다. own-omo의 캐시 회귀 골든 `test/golden/unchanged/pi.win32.json`은 다시 기록했다.
- 읽기 전용·explore 읽기와 Windows 줄(2026-11-03): `test/unit/codex/read-only.test.ts`의 `CodexReadOnly.answers`(모든 모드의 explore, 다른 에이전트는 모드대로, `refusedBash`가 이름 붙인 명령이 모두 bash에서 받아짐), `test/unit/pi/tools.test.ts`(`PiBash.answered`), `test/unit/pi/shell.test.ts`(`windowsGuidelines`), `test/unit/pi/request.test.ts`(`<rules>` 자리), e2e `test/e2e/subagents.test.ts`(모든 하네스·모드에서 explore·general 하위 에이전트), `test/e2e/shells.test.ts`(하네스마다 지시문이 말하는 셸과 실제 셸).
- e2e(`test/e2e/pi.test.ts`, 서버 부팅 + 가짜 Responses): Pi 지정 세션이 Pi 지시문과 Pi 도구만(+ own 도구) 보냄, `read → edit → write → bash`가 승인 요청을 거쳐 Pi 문구로 답함, 실패 문구, `opencode` 세션에는 Pi 도구 없음, 공통 압축, `codex → pi` 전환 안내와 `exec_command`→`bash` 번역.
- own-web: `tool-alias.test.ts`(bash 셸 카드, Pi edit 미리보기), `harness.test.ts`.
- 실계정(2026-10-14, `own/reports/harness-live-2026-10-14.md`): 이어지는 과제(계정 01→03, 압축, DeepSeek, gpt-6.1-sol), 버그 고치기(GPT·DeepSeek), 웹 검색 모두 성공. 시간과 성공률은 codex·opencode 하네스와 같은 범위였다.
