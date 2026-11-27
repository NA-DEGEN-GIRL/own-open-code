# 17. creator 모드와 own 확장 (own.creator)

| 항목 | 값 |
|---|---|
| 문서 상태 | v0.5 (2026-11-06). 브랜치 `creator-remote`: 확장이 SSH 원격 호스트로 간다(§10, CRM-23–CRM-31). PC만 만들고 승인하고, 호스트는 브로커 미러로 읽기 전용 사본을 받는다. C2는 호스트의 샌드박스에서 단계 검사를 다시 하고, C3는 호스트마다 따로 허용할 때만 간다. main에는 아직 합치지 않음. v0.4 (2026-11-05). 브랜치 `merge-round11`: C0(creator 모드), C1(선언형 확장 `own.ext/1`), C2(생성 MCP 서버, §11), C3(코드 플러그인, 기본 꺼짐, §12). v0.4(보안 리뷰 반영, decisions MR15): C2는 own의 WebAssembly 샌드박스(QuickJS)에서 돈다 — 정적 검사는 경계가 아니라 이른 린트일 뿐. C3의 F5(폴더 해시 lstat·링크 거부, 캐시 안 씀, shim이 불러오기 전 새 해시 확인, 상대 import 확장자, `@ts-*` 거부)와 F4(읽기 전용 역할은 모든 C2 도구를 거부). main에는 아직 합치지 않음 |
| 목적 | 기능을 하나씩 하네스에 넣는 대신, 사용자가 대화로 own에 기능을 더한다. 모델이 쓰는 것은 own이 해석하는 선언(코드 아님)이고, 판마다 남아 되돌릴 수 있다 |
| 사용자 결정 | "추천대로 C3까지 진행해봐"(2026-11-04): 확장은 기본으로 모든 프로젝트에 적용되고 프로젝트 폴더 목록으로 좁힐 수 있다. C1의 첫 종류는 지시문 조각, 명령을 감싼 도구, 도구 허용·거부 규칙, 재시도 정책, 압축 프롬프트 추가. C3는 기본으로 꺼 둔다 |
| 관련 문서 | 조사 보고서 `own/reports/creator-mode-2026-11-04.md`, 01 §4(플러그인 순서), 02 §4.3(캐시 규칙 D1–D10), 07(프리셋), 10 §3.11(내 지시문), 11(압축 프롬프트), 결정 로그 CRM, 설명서 29장 |

---

## 0. 결정 (CRM)

| 번호 | 결정 |
|---|---|
| CRM-D1 | 새 own 플러그인 `own.creator`(`packages/own-creator`)가 creator 모드와 확장을 맡는다. 플러그인 순서의 맨 끝(own-omo 다음)이다. 압축·재시도 훅이 own-harness가 정한 것에 덧붙이고, 이 줄이 바뀌어도 다른 플러그인은 다시 불러오지 않는다 |
| CRM-D2 | 모든 단계가 한 저장소 `OWN_HOME\creator`를 쓴다. 확장마다 바뀌지 않는 판 폴더(`ext\<id>\v<n>`)와 `store.json`의 활성 판 번호가 있다. 되돌리기는 번호만 바꾼다. 판 파일의 해시가 기록과 다르면 그 판은 적용되지 않는다 |
| CRM-D3 | C0의 에이전트·명령·스킬은 설정 폴더에 markdown을 쓰지 않고 확장 항목으로 core의 transform에 등록한다. 그래서 판·되돌리기·프로젝트 범위가 C1과 같고, 사용자의 설정 폴더와 gray-matter(`---js`, SK2-19)를 건드리지 않는다 |
| CRM-D4 | 지시문 조각은 세션 instruction entry(`own.creator.ext.<id>`)로만 넣는다. system 프롬프트를 바꾸지 않는다. 명령 도구는 Code Mode 도구가 기본이고, 직접 도구(`direct: true`)는 고를 수 있지만 승인 카드가 캐시 경고를 단다 |
| CRM-D5 | 도구 규칙은 core 권한 `evaluate` 훅에서 own의 승인 묶음(읽기 전용·묻기·전체 허용) 뒤에 합친다. deny와 ask는 좁히기만 한다. allow는 넓히므로, 사용자가 설정 > 확장에서 그 판을 승인해야 켜진다. 모델 도구는 승인할 수 없다 |
| CRM-D6 | creator 모드의 쓰기(만들기·바꾸기·켜기·끄기·되돌리기·범위·지우기)는 전체 허용이 아니면 매번 묻는다(`creator`). 읽기 전용에서는 거절한다. 승인 카드는 확장이 하는 일과 캐시 영향을 항목마다 보여 준다 |
| CRM-D7 (2026-11-06) | 원격(SSH) 호스트: 확장은 호스트로 간다(§10). PC만 만들고 바꾸고 승인한다. 호스트는 브로커 미러로 PC 저장소의 읽기 전용 사본을 받아, 판 해시를 PC의 것과 맞춘 뒤 그 호스트의 대화에 적용한다. 범위는 호스트 id가 붙은 호스트 폴더, 명령 도구는 호스트의 셸과 승인, C2는 호스트의 샌드박스에서 단계 검사 뒤, C3는 호스트마다 판마다 따로 허용할 때만. 승인은 대화가 있는 곳에서 한다. 호스트가 PC 저장소에 쓰는 길은 없다 |
| CRM-D8 | core 패치는 없다. 쓰는 이음새는 모두 이미 있다: instruction entry, `tool.transform`·`agent.transform`·`skill.transform`·`command.transform`, `permission.evaluate`(P-047의 `saved` 포함), `tool.execute.before`(P-028의 `registered`), `shell.authorize`(P-019), `session.compaction`의 `prompt`(P-025), `session.retry` |
| CRM-D9 | `own.creator` RPC는 이 PC의 창에서만 쓴다. 쓰기는 `local` 범위이고, 휴대폰 게이트웨이는 이 이름공간 전체를 거절한다(`unknown_rpc`) |
| CRM-D10 (MR15) | C2: 생성 MCP 서버는 own의 WebAssembly JavaScript 샌드박스(QuickJS, MIT, `quickjs-emscripten-core`+`@jitl/quickjs-wasmfile-release-sync`, 0.32.0 고정)에서 돈다. own의 호스트(`runtime/mcp-host.ts`)가 별도 프로세스로 엔진을 띄우고 번들을 샌드박스에 넣는다. 샌드박스에는 환경·프로세스·Bun·Node·디스크가 없고, 나가는 길은 own의 브리지뿐이다: 프로젝트 파일(울타리)과 선언한 `hosts`로의 fetch. 호스트는 `--no-env-file`과 정리된 환경으로 띄운다. core의 MCP config 길(`ctx.mcp.transform`)로 범위 안의 Location에만 등록하고, 판이 바뀌면 그 서버만 다시 시작한다. Code Mode가 기본이다 |
| CRM-D11 | C2의 모든 호출은 묻는다: 묻기·읽기 전용은 매번, 전체 허용은 판마다 첫 호출 한 번. 의존성 설치는 허용 목록 안에서, 설치 스크립트 없이, 어떤 모드에서도 사용자 승인 뒤에만 |
| CRM-D12 (MR15) | 코드 판은 만들기 전에 단계 폴더에서 검사한다. C2: 설치 → 타입 검사(이른 린트) → 번들 → 시험·smoke(모두 샌드박스 안에서). 단계 검사가 샌드박스 밖에서 코드를 돌리는 일은 없다. C3: 타입 검사 → 시험 → e2e → 캐시 golden. C3의 단계 검사는 플러그인 코드를 돌리므로(서비스처럼 전체 권한), 돌리기 전에 별도 승인 카드로 먼저 묻는다. 하나라도 실패하면 판을 쓰지 않고 앞 판이 그대로다 |
| CRM-D13 (MR15 F5) | C3: 설정 > 고급 > 확장의 스위치(기본 꺼짐) 뒤에서만 만들고 싣는다. 판마다 사용자가 그 판을 승인해야 core의 로컬 플러그인 길(`plugins` 끝의 항목)로 실린다. 승인은 판 폴더 전체의 해시로 own-accounts의 trust에 남는다. 폴더 해시(`Hash.folder`)는 `lstat`로 걷고 심볼릭 링크·junction·reparse point가 있으면 해시를 거부한다(그 판은 적용 안 됨); 크기·시각 캐시를 쓰지 않는다. shim은 진입 파일을 불러오기 전에 config 항목의 해시를 새로 계산해 맞는지 확인한다. 상대 import는 확장자를 적어야 한다 |
| CRM-D14 | C3 코드는 own의 shim이 걸러 준 보기만 받는다: `context`·`compaction` 훅, 요청의 JSON 사본(인증 헤더·provider 옵션 없음). 훅이 던지면 그 Location에서만 꺼지고 서비스는 계속 돈다. 프로세스 안에서 막을 수 없는 것은 §12.5에 적는다 |
| CRM-D15 (MR15 F4) | 읽기 전용 역할(`explore`, `own-review`)은 모든 C2 도구(권한 접두사 `creator-`, creator 쓰기 동작 `creator`는 아님)를 승인 모드와 상관없이 거부한다. own-accounts의 읽기 전용 역할 훅이 `creator-` 접두사로 거부하고, own-creator의 `servers.ts`도 읽기 전용에서는 묻지 않고 거부한다 |
| CRM-D16 (MR15 L1/L2) | own의 ask는 모두 메시지를 단다(own-accounts webAsk·GitHub, own-team 셸, own-creator 규칙). 확장의 allow는 메시지 없는 ask(core 기본)만 풀 수 있으므로, 어떤 own 훅의 ask도 확장 allow가 풀지 못한다 |

---

## 1. 단계

| 단계 | 내용 | 코드가 도는 곳 | 이 문서 |
|---|---|---|---|
| C0 | creator 모드: 에이전트 `creator`, 조사·관리 도구, 작성 스킬. 에이전트·명령·스킬·내 지시문을 확장 항목으로 쓴다 | 없음(선언) | 구현 |
| C1 | 선언형 확장 `own.ext/1`: 지시문 조각, 명령 도구, 도구 규칙, 재시도 정책, 압축 프롬프트 추가 | 없음(선언). 명령 도구는 승인된 셸 명령 | 구현 |
| C2 | 생성 MCP 서버(`kind: "mcp"`): 판 폴더의 서버 소스, 별도 프로세스, Code Mode 기본, 부를 때마다 권한 질문 | 별도 프로세스 | 구현(§11) |
| C3 | 코드 플러그인(`kind: "plugin"`, 기본 꺼짐): 요청·압축 훅처럼 프로세스 안에서만 되는 것 | 서비스 프로세스 | 구현(§12) |

- 형식은 하나다. `kind`가 없거나 `declarative`면 C0·C1이다. `mcp`는 `mcp.server` 항목이 1–4개(선언 항목을 함께 둘 수 있다), `plugin`은 `plugin.code` 항목 하나만 담는다. 코드 항목은 제 종류의 확장에만 둘 수 있다.
- `list` RPC의 `stages`가 이 빌드가 도는 단계를 알린다(`{declarative: true, mcp: true, plugin: <C3 스위치>}`).

---

## 2. 구성

- 패키지 `packages/own-creator`, 플러그인 id `own.creator`. 다른 own 플러그인처럼 `OWN_OPEN_CODE=1`과 `ctx.app.version === EXPECTED_APP_VERSION`을 확인하고, 아니면 아무것도 하지 않는다.
- 옵션(`ctx.options`): `home`(OWN_HOME, 기본은 own-runtime의 해석), `enabled`(`false`면 아무것도 싣지 않음). 런처는 옵션을 주지 않으므로 기본값으로 돈다.
- 이름이 박힌 곳에 모두 더했다: own-accounts `Inventory.OWN_PACKAGES`(신뢰 목록), 런처 `ManagedPlugins`·관리 항목 정규식·`status --json`, own-remote `bundle.ts`의 `OWN_PACKAGES`(빌드 id)·`DESKTOP_PLUGINS`·`REMOTE_PLUGINS`(끝, QuickJS와 함께, §10), 원격 관리 config(`RemoteModel.managedConfig`, `mode: "remote"`), `build-desktop.ps1`, `build-remote.ps1`, `release-smoke.ts`, `opencode.jsonc.example`.
- 옵션 `mode`: `local`(기본, 이 PC)이나 `remote`(SSH 호스트, 미러, §10).
- 플러그인은 Location마다 하나씩 돈다. 각 인스턴스가 저장소를 읽고, 그 Location에 적용되는 확장(활성, 켜짐, 범위 안)만 적용한다.

| 파일 | 맡는 일 |
|---|---|
| `src/store.ts` | 저장소: 읽기, 판 쓰기, 해시, 활성 판, 되돌리기, 범위, 승인, 지우기, 잠금, 변경 알림 |
| `src/safety.ts` | 형식 밖의 검사: 자격 증명, 봉인된 동작, 이름 충돌, 폴더, 명령 환경 |
| `src/match.ts` | `when`과 적용 범위 맞추기 |
| `src/fragments.ts` | 지시문 조각(§5.1) |
| `src/command-tools.ts` | 명령 도구(§5.2) |
| `src/rules.ts` | 도구 규칙(§5.3)과 저장소 보호 |
| `src/hooks.ts` | 재시도 정책(§5.4), 압축 프롬프트 추가(§5.5) |
| `src/authored.ts` | creator 에이전트와 문(gate), C0의 에이전트·명령·스킬(§6) |
| `src/harness.ts` | 내 지시문 넘겨받기(§6.4) |
| `src/tools.ts` | `creator_inspect`, `creator_manage`(§6.1, §7) |
| `src/rpc.ts`, `src/views.ts` | 설정 > 확장의 RPC와 보기, 승인 카드 글(§7.2, §8) |
| `src/code.ts` | C2·C3 코드의 정적 검사: import 허용 목록, 금지 이름, 의존성 허용 목록(§11.6, §12.3) |
| `src/staging.ts` | 코드 판의 단계 검사(§11.4, §12.3)와 MCP 호스트 명령 |
| `src/servers.ts` | C2: MCP 서버 등록, 호출마다 묻기, 첫 사용 확인, 멈추기(§11) |
| `src/plugins.ts` | C3: config의 `plugins` 끝 항목, trust 승인 쓰기, 멈춤(crash) 기록(§12) |
| `src/remote.ts` | 이 PC: 호스트마다의 읽기 전용 보기와 파일 조각, 카드의 호스트 줄(§10) |
| `src/mirror.ts` | 호스트: 미러 동기화, 해시 확인, 호스트 단계 검사, 보고(§10.3) |
| `src/runtime.ts`, `src/runtime/*` | own이 판 폴더나 자식 프로세스에 쓰는 코드: `own-mcp.ts`(서버 도우미), `mcp-host.ts`(호스트), `own-plugin.ts`(C3 API), `own-shim.ts`·`own-plugin-server.ts`(C3 shim), `plugin-check.ts`(C3 e2e). 글로 읽어 묶음에 넣는다 |
| own-protocol `creator.ts`, `rpc-creator.ts` | 형식의 스키마, 한도, 효과 요약, 저장소 보기, RPC 정의 |

---

## 3. 형식 `own.ext/1`

### 3.1 매니페스트

```json
{
  "format": "own.ext/1",
  "id": "house-rules",
  "title": "House rules",
  "description": "선택",
  "kind": "declarative",
  "items": [ ... ]
}
```

- `id`: 소문자로 시작, 소문자·숫자·`-`, 2–40자. 확장의 폴더 이름이 된다.
- `items`: 1–24개. 한 확장 안에서 조각 id, 도구·에이전트·명령·스킬 이름, 내 지시문의 하네스가 겹치면 안 된다.
- JSON 스키마는 Effect Schema `Creator.Extension`에서 만든다(`Schema.toJsonSchemaDocument`). `creator_inspect` `schema`가 그대로 보여 준다. 판을 쓰기 전과 읽을 때마다 이 스키마로 디코드하고, 아래 검사를 더한다(`Creator.problems`, `Safety.problems`).

### 3.2 `when`

모든 항목은 `when`으로 더 좁힐 수 있다. 주어진 목록은 모두 맞아야 하고, 없는 목록은 다 맞는다.

| 키 | 맞추는 것 |
|---|---|
| `harness` | 세션의 하네스(`opencode`, `codex`, `pi`, `dsh`, `omo`, `claude-code`) |
| `agent` | 에이전트 id(`*` 글롭) |
| `model` | `<provider>/<model>` 또는 모델 id(`*` 글롭) |
| `project` | 폴더와 그 안의 폴더(절대 경로) |

- 확장 전체의 프로젝트 범위는 `store.json`이 정한다(§4.3). `when.project`는 그 안에서 항목 하나를 더 좁힌다.
- 도구와 에이전트처럼 Location 전체에 등록되는 것은 `when.project`만 등록 때 본다. 하네스·에이전트·모델 조건은 부를 때 확인하고, 맞지 않으면 도구가 "이 대화에서는 쓸 수 없다"고 답한다.

### 3.3 항목

| 종류 | 단계 | 필드 |
|---|---|---|
| `prompt.fragment` | C1 | `id`, `text`(≤ 4,000자) |
| `tool.command` | C1 | `name`(`ext_<name>`으로 등록), `description`, `command`(≤ 2,000자, `{{param}}`), `params`(≤ 8: `string`·`number`·`boolean`, `enum`, `optional`), `cwd`(프로젝트 안 상대 경로), `shell`(`default`·`powershell`·`bash`·`sh`), `timeoutSeconds`(1–600, 기본 120), `direct` |
| `tool.rule` | C1 | `rules`(1–32): `tool` 또는 `permission`(+`pattern`, 기본 `*`) 하나, `effect`(`deny`·`ask`·`allow`), `reason` |
| `retry` | C1 | `maxRetries`(0–10), `maxDelaySeconds`(2–10) |
| `compaction.prompt` | C1 | `text`(≤ 2,000자) |
| `agent` | C0 | `name`, `description`, `mode`(`primary`·`subagent`·`all`), `prompt`(≤ 20,000자), `model`(`provider/model`), `hidden`, `steps`(1–200) |
| `command` | C0 | `name`, `description`, `template`(`$ARGUMENTS`, `$1`…`$9`) |
| `skill` | C0 | `name`, `description`, `content` |
| `harness.instructions` | C0 | `harness`(`codex`·`pi`·`dsh`), `text`(≤ 100,000자) |
| `mcp.server` | C2 | `name`, `files`, `entry`, `dependencies`, `smoke`, `timeoutSeconds`, `memoryMb`, `direct`, `when`(§11.1). `kind: "mcp"`에만 |
| `plugin.code` | C3 | `files`, `entry`, `hooks`(`context`·`compaction`), `cache`(§12.2). `kind: "plugin"`에 이것 하나만 |

### 3.4 한도와 검사

- 한 확장의 조각 합계 ≤ 12,000자. 한 세션에 들어가는 모든 확장의 조각 합계 ≤ 24,000자: 넘치는 확장은 저장소 순서대로 빠진다.
- 명령 템플릿의 `{{name}}`은 모두 매개변수여야 한다. 템플릿과 `cwd`는 자격 증명 파일(보관함, `.credentials.json`, `auth.json`, `service-own.json`, 서비스 DB)이나 비밀 변수(`$env:…TOKEN`, `%…KEY%`, `${…SECRET}`), `OWN_HOME`·`CLAUDE_CONFIG_DIR`·`CODEX_HOME`, 환경 목록(`printenv`, `Get-ChildItem env:`)을 이름으로 부를 수 없다.
- 규칙 하나는 `tool`과 `permission` 중 정확히 하나를 쓴다. `pattern`은 `permission` 규칙에만 쓴다. `allow`는 `permission` 규칙에만, `*` 없는 구체적인 동작에만 쓴다. own의 문(`own_*`), `creator`, `tool_rule`, `computer`, `browser`, GitHub 쓰기(`github.write`: 그 도구·저장소·계정에 정확히 저장한 `항상 허용`만 푼다, 16 GH-26), 이미지(`image_generate`: 돈이나 요금제 사용량을 쓴다, 02 §9.6)는 넓힐 수 없다(MR14).
- 다른 켜진 확장이 쓰는 이름(도구·에이전트·명령·스킬·내 지시문의 하네스)과 앱이 이미 쓰는 이름(core·설정의 에이전트와 명령, 다른 플러그인의 도구, 에이전트 `creator`)은 쓸 수 없다.

---

## 4. 저장소 `OWN_HOME\creator`

### 4.1 배치

```
OWN_HOME\creator\
  store.json               확장 목록: 활성 판, 켜짐, 프로젝트 폴더, 승인한 판, 판 정보(해시), 기록
  store.lock               쓰기의 프로세스 간 잠금(own-runtime Lock)
  ext\<id>\v<n>\           판 하나: extension.json, 스킬이면 skills\<name>\SKILL.md,
                           C2: servers\<name>\(소스, own-mcp.ts, tsconfig.json, package.json·bun.lock·node_modules),
                           C3: 플러그인 소스, own-plugin.ts, own-shim.ts, server.ts(shim), tsconfig.json
  trash\<id>-<시각>\       지운 확장(최근 20개)
  skills\own-creator-*\    creator 모드의 스킬 파일(플러그인이 씀)
  harness.json             내 지시문을 넘겨받은 하네스와 원래 글(§6.4)
  runtime\                 own의 자식 프로세스 스크립트(mcp-host.ts, plugin-check.ts), 글이 바뀌면 다시 씀
  stage\                   코드 판의 단계 폴더(검사 중에만 있음)
  cache\bun\               C2 의존성 설치의 Bun 캐시
  temp\<id>\               C2 서버의 TEMP
  logs\<id>.log            확장의 로그(서버 시작·끝·stderr, 멈추기, 단계 검사, C3 멈춤), 256 KiB에서 .1로
  run\crashes.jsonl        C3 훅이 던진 기록(shim이 씀)
```

### 4.2 판

- 판은 쓴 뒤 바뀌지 않는다. 옆 폴더(`v<n>.<pid>.<rand>.tmp`)에 쓰고 fsync한 뒤 이름을 바꾼다. 그다음 폴더의 모든 파일을 해시한다(정렬한 상대 경로 + `\0` + 바이트 + `\0`의 sha256). 해시는 `store.json`의 판 정보에 남는다.
- 읽을 때마다 해시를 다시 잰다. 다르면 `tampered`, 파일이 없으면 `missing`, 디코드가 안 되면 `invalid`다. 어느 쪽이든 그 판은 적용되지 않는다. 플러그인은 저장소 폴더 전체를 감시하므로, 손으로 고친 판은 바로 적용을 멈춘다.
- 쓰기 전에 검사한다. 맞지 않는 매니페스트는 판 폴더도 기록도 남기지 않는다.
- `update`는 새 판(가장 큰 번호 + 1)을 쓰고 활성 판을 그리로 옮긴다. `rollback`은 이미 있는 판으로 활성 판만 옮긴다. 옮길 판이 적용되지 않는 판(해시가 다름, 이름 충돌)이면 거절한다.
- 판은 확장마다 50개까지 둔다. 넘치면 활성 판과 승인한 판이 아닌 가장 오래된 판부터 폴더째 지운다.
- 쓰기는 이 프로세스 안에서 차례로(뮤텍스), 프로세스 사이에서는 `store.lock`으로 한 번에 하나다. `store.json`은 temp 파일에 쓰고 이름을 바꾼다(`Fsx.writeAtomic`). 읽을 수 없는 `store.json`은 빈 저장소로 읽고, 다음 쓰기가 `store.json.broken-<시각>`으로 옮겨 둔다.

### 4.3 적용 범위

- `projects`가 비면 모든 프로젝트다. 폴더가 있으면 그 폴더와 그 안의 폴더에서만 적용된다(Windows는 대소문자를 가리지 않는다).
- 폴더 검사: 절대 경로, 있는 폴더, 드라이브·파일 시스템 루트가 아님, own의 집(OWN_HOME)을 담거나 그 안이 아님, 설정 폴더(`OPENCODE_CONFIG_DIR`)가 아님, 32개 이하. 같은 폴더는 한 번만 남긴다.
- 내 지시문 항목이 든 확장은 폴더로 좁힐 수 없다(§6.4).

### 4.4 상태

| 상태 | 뜻 |
|---|---|
| `active` | 켜짐, 활성 판이 온전함, 이름 충돌 없음 |
| `disabled` | 꺼짐(판과 활성 판은 그대로) |
| `invalid` | 활성 판이 디코드되지 않거나 앞 확장과 이름이 겹침 |
| `tampered` | 활성 판의 파일이 바뀜 |
| `missing` | 활성 판의 폴더가 없음 |
| `unavailable` | C3 확장인데 코드 플러그인 스위치가 꺼짐 |
| `pending` | C3의 활성 판을 사용자가 아직 승인하지 않음 |
| `outdated` | C3 판이 다른 앱 판에서 단계 검사를 거침(다시 만들어야 함) |

### 4.5 바뀜 알리기

- 이 프로세스의 쓰기는 모든 Location 인스턴스에 바로 알린다(`CreatorStore.onChange`). 다른 곳(다른 프로세스, 손으로 고침)의 변화는 폴더 감시가 150 ms 묶어서 잡는다.
- 다시 읽은 뒤 바뀐 도메인만 다시 짓는다: 명령 도구가 바뀌면 `tool.reload`, 에이전트면 `agent.reload`, 스킬이면 `skill.reload`, 명령이면 `command.reload`. 조각은 아는 세션마다 맞춘다(§5.1). RPC 이벤트 `changed`로 설정 화면에 알린다.
- 재시작은 필요 없다. core의 각 step은 `awaitActivation` 뒤에 도구 목록을 다시 읽는다.

---

## 5. C1 항목의 적용

### 5.1 지시문 조각

- 확장마다 instruction entry 하나: 키 `own.creator.ext.<id>`, 값은 그 세션에 맞는 조각들을 항목 순서대로 빈 줄로 이은 글.
- 맞추는 때: 프롬프트가 들어올 때(`session.prompt` 훅, core가 받기 전), 세션의 모델·에이전트·하네스가 바뀔 때(`session.model.selected`, `session.agent.selected`, `session.metadata.updated`), 확장이 바뀔 때(이 인스턴스가 맞춘 세션, 최근 500개). 그 세션의 Location 인스턴스만 맞춘다.
- 같은 값은 다시 쓰지 않는다. 없어야 할 `own.creator.*` 항목은 지운다.
- core가 렌더한다: 첫 step 전에 있으면 epoch baseline에 `<context key="own.creator.ext.<id>">`로 들어가고, 그 뒤의 바뀜은 다음 step 경계에서 대화 뒤에 붙는 durable System 메시지가 된다. 앞 바이트는 그대로라 캐시가 산다(§5.6). Codex 하네스도 core의 `api/*` 항목을 baseline에서 읽어 그대로 싣는다(own-harness `baseline.ts`).
- creator 세션에는 `own.creator.mode`(creator 모드의 안내)가 같은 길로 들어간다.

### 5.2 명령 도구

- 켜진 `tool.command` 항목마다 도구 `ext_<name>` 하나. 입력 스키마는 `params`의 JSON 스키마(추가 속성 없음)다.
- 부르면: 세션 조건 확인 → 인자 검사(이름, 형, `enum`, 길이) → 템플릿 채우기 → `shell.authorize`(P-019: 프로젝트 밖 `cwd`는 `external_directory`, 그다음 파싱한 명령마다 `shell`) → 실행. 승인 모드와 저장한 `항상 허용`이 core 셸 도구와 똑같이 정한다. 확장의 `permission` 규칙(§5.3)도 이 질문에 합쳐진다.
- 인자는 셸에 맞게 따옴표로 감싼다(PowerShell `'…''…'`, POSIX `'…'\''…'`). 문자열 하나는 언제나 한 단어다. 숫자와 참·거짓은 그대로 쓴다.
- 셸: `default`는 Windows에서 Windows PowerShell(`-NoLogo -NoProfile -NonInteractive -Command`, 출력 UTF-8), 그 밖에서는 `/bin/bash`(없으면 `sh`). `bash`는 Windows에서 Git Bash.
- 환경: 서비스 환경에서 비밀처럼 보이는 변수(KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, COOKIE, AUTH, SESSION)와 own·provider 변수(`OWN_*`, `OPENCODE_*`, `CLAUDE_*`, `CODEX_*`, `ANTHROPIC_*`, `OPENAI_*`, `DEEPSEEK_*`, `GITHUB_*`, `GH_*`, `GIT_ASKPASS`, `SSH_AUTH_SOCK`)를 뺀다. GitHub 로그인(16)도 붙이지 않는다.
- 결과: `exit <코드>`(또는 시간 초과) 다음 출력(stdout, stderr). 토큰 모양 글은 가리고(own-runtime `Redact.text`), 30,000자를 넘으면 끝을 남긴다. 시간 초과와 취소는 프로세스 나무 전체를 끝낸다(`ProcessTree`).
- Code Mode 도구가 기본이다(`codemode` 옵션 없음). 직접 도구(`direct: true`)는 요청의 도구 목록에 들어가므로, 더하거나 바꾸거나 빼면 열린 모든 대화의 캐시가 그 앞에서 깨진다. 승인 카드가 이를 경고한다.

### 5.3 도구 규칙

- `permission` 규칙은 core 권한 `evaluate` 훅에서 합친다. 이 훅은 에이전트 규칙, 세션 규칙(own의 승인 묶음), 저장한 규칙이 정한 뒤에 돈다. 에이전트·세션 규칙의 deny는 훅에 오지 않으므로 어떤 확장도 그것을 풀 수 없다.
  - 맞는 규칙 가운데 가장 센 것이 정한다: deny > ask > allow.
  - `deny`: deny로 바꾸고 이유를 단다(`Blocked by extension '<id>': <reason>`).
  - `ask`: allow를 ask로 바꾼다(전체 허용에서도 묻는다).
  - `allow`: 사용자가 그 판의 allow를 승인했을 때만(`loosen`에 활성 판 번호), core 규칙이 낸 ask를 allow로 바꾼다. deny는 바꾸지 않는다. 다른 own 훅이 이유(`message`)를 달아 쓴 ask(own-team의 위험한 git 명령 등)는 그대로 둔다. 그래서 own의 `evaluate` 훅들(확장 규칙, GitHub 쓰기, 읽기 전용 역할, own-team, 읽기 전용 역할의 `image_generate` 거절)은 어느 순서로 돌아도 조이기만 한다(MR14). C2 서버의 전체 허용 allow(§11.5)도 같다.
- `tool` 규칙은 `tool.execute.before`에서 모든 도구 호출(Code Mode 안의 호출 포함, P-028의 `registered` 이름도)에 맞춘다. `deny`는 호출을 거절하고, `ask`는 `tool_rule`(자원은 도구 이름, `항상 허용`은 그 도구)을 묻는다.
- 같은 훅이 저장소를 지킨다: `OWN_HOME\creator` 안을 고치는 `edit`는 거절한다. 확장은 creator 모드의 도구와 설정 > 확장으로만 바뀐다. 셸은 이 거절을 피할 수 있으므로, 판의 해시가 둘째 벽이다(§4.2).

### 5.4 재시도 정책

- core의 `session.retry` 훅에서, 대기가 있는 재시도(backoff)만 바꾼다. 대기 0의 즉시 재시도(own-accounts의 계정 전환, 새 로그인, 원격 유예)는 그대로 둔다.
- `maxRetries`: 그보다 큰 회차는 재시도하지 않는다. `maxDelaySeconds`: 대기를 그 이하로 줄인다. 맞는 항목이 여럿이면 가장 작은 값.
- core는 재시도가 만들 시도의 번호를 준다(첫 재시도가 2). `maxRetries` 1은 재시도 한 번이다.
- 줄이기만 한다: core는 최대 10번, 2초에서 두 배씩 10초까지 기다린다(`model-retry.ts`). 확장은 횟수를 늘리거나 2초보다 짧게 기다리게 할 수 없다.

### 5.5 압축 프롬프트 추가

- `session.compaction` 훅에서, own-harness가 정한 압축 프롬프트(P-025 `prompt`, 11)가 있을 때만 그 끝에 `Additional instructions for this summary (from the user's extensions):`와 맞는 글을 붙인다. own-creator가 own-harness 뒤에 있으므로 own-harness의 프롬프트에 붙는다.
- 압축 훅은 앞부분 시도(P-034)와 대체 모델마다 다시 돈다. 매번 새 사건에 한 번씩 붙이므로 겹치지 않는다.
- 결과를 이미 정한 압축(`result`)과 own의 프롬프트가 없는 압축(core 자신의 프롬프트)에는 붙이지 않는다.

### 5.6 캐시 규칙

| 바뀌는 것 | 열린 대화의 요청 | 근거 |
|---|---|---|
| 지시문 조각 | 앞 prefix 그대로, 대화 뒤에 System 메시지 | instruction entry(§5.1) |
| Code Mode 도구 | 도구 목록 그대로, Code Mode 카탈로그 delta가 대화 뒤에 | 02 D10, core `tool.ts` |
| 스킬 | 스킬 목록 바뀜이 대화 뒤에 | 지시문 원천의 바뀜 |
| 도구 규칙, 재시도 | 요청 글 그대로 | 권한·재시도 훅 |
| 압축 추가 | 압축 요청 끝에만 | §5.5 |
| 직접 도구 | 도구 목록이 바뀌어 캐시가 깨짐 | core가 이름순으로 정렬한 목록 |
| 하위 에이전트(`subagent`·`all`) | task 도구 설명이 바뀌어 캐시가 깨짐 | task 도구 |
| 내 지시문 | `custom` 대화의 기본 지시문이 바뀜 | 10 §3.11 |

- 승인 카드와 설정 > 확장은 항목마다 이 표의 말(캐시 유지, 열린 대화의 캐시를 한 번 깸, 압축 요청에만, 요청 글 변화 없음)을 보여 준다(`Creator.effects`).
- 확장이 없거나 꺼졌거나 다른 프로젝트에만 적용되면, 다른 하네스의 첫 요청은 바이트까지 own-creator가 없을 때와 같다(§12).

---

## 6. C0: creator 모드

### 6.1 에이전트와 문

- 에이전트 `creator`(primary, 이름 `creator`, 설명 "확장 만들기: …"). 사용자가 대화의 에이전트로 고른다. `system`은 정하지 않는다(core의 GPT·Claude 프롬프트를 끄지 않도록, own-accounts `presets/agents.ts`와 같은 이유).
- 문: creator의 도구는 권한 동작 `own_creator`를, 스킬은 id `own-creator-*`를 쓴다. 다른 모든 에이전트에 `{own_creator, *, deny}`와 `{skill, own-creator-*, deny}`를 붙이고, `creator`에만 둘의 allow를 붙인다. 자원 `*`의 deny는 목록에서 빼므로, 다른 대화의 요청에는 creator의 도구도 스킬도 나오지 않는다. 이 에이전트 transform은 이 Location의 `plugin.updated`마다 다시 등록해 설정 에이전트 뒤에 돈다(own-harness `Gate`의 방식).
- 안내: creator 세션에는 instruction entry `own.creator.mode`가 들어간다(`src/text/mode.md`: 조사 → 가장 약한 장치 → validate → create/update → 써 보기, 그리고 규칙).
- 스킬 두 개: `own-creator-extensions`(형식, 항목마다 템플릿, 캐시·안전 규칙), `own-creator-markdown`(에이전트·명령·스킬·내 지시문). `OWN_HOME\creator\skills\<id>\SKILL.md`로도 써 둔다(경로를 보여 주는 하네스가 열 수 있게).

### 6.2 도구

| 도구 | 하는 일 | 묻기 |
|---|---|---|
| `creator_inspect` | `overview`, `extensions`(저장소), `extension`(`id`: 판과 활성 매니페스트), `schema`(JSON 스키마, 한도, 항목 종류), `agents`, `commands`, `skills`, `tools`, `harness`(하네스별 내 지시문 여부) | 묻지 않음 |
| `creator_manage` | `validate`, `list`(쓰지 않음), `create`, `update`, `enable`, `disable`, `rollback`(`id`, `version`), `scope`(`id`, `projects`), `remove`(`id`) | 쓰기는 §7.1 |

- 둘 다 직접 도구(`codemode: false`)이고, 문 때문에 creator 세션에만 있다.
- 결과는 JSON 글이다: 성공이면 상태, 문제, 효과, 내 지시문을 바꾼 하네스, allow가 승인을 기다린다는 말. 실패면 `reason`과 `problems`(경로와 이유).

### 6.3 에이전트·명령·스킬 항목

- `agent`: `agent.transform`의 `update`로 만든다. 설명, 모드, `system`(= `prompt`), 모델, 숨김, step 수. 권한은 `tool.rule` 항목(`when.agent`)으로 준다. 이미 있는 에이전트 이름은 쓸 수 없다.
- `command`: `command.transform`의 `add`. 실행하면 템플릿을 core의 markdown 명령처럼 채워(`$ARGUMENTS`, `$1`…`$9`, 자리 표시가 없으면 인자를 뒤에 붙임) 그 세션에 프롬프트로 보낸다. 셸 끼워 넣기(``!`cmd` ``)는 하지 않는다.
- `skill`: `skill.transform`의 `add`. id와 이름은 `name`, 경로는 판 폴더의 `skills\<name>\SKILL.md`, 본문은 `content`. 이미 있는 스킬 id는 덮지 않는다.
- 셋 다 확장의 프로젝트 범위를 따른다(Location마다 등록).

### 6.4 내 지시문 항목

- 내 지시문(10 §3.11)은 own.harness가 하네스마다 하나씩 모든 프로젝트에 쓰는 글이다. 그래서 확장은 그것을 넘겨받는다: 확장이 처음 그 하네스의 글을 줄 때 사용자가 갖고 있던 글(없으면 없음)을 `harness.json`에 남기고 `prompt.custom.set`으로 바꾼다. 그 하네스의 글을 주는 확장이 더 없으면(끔, 지움, 그 항목이 없는 판으로 되돌림) 남긴 글로 되돌린다.
- own.harness의 RPC로만 쓴다. 검사와 보관은 own.harness의 것 하나다. 지금 글은 `prompt.preview`(`custom`)로 읽는다.
- 쓰기를 한 인스턴스가 쓰기 뒤에 맞춘다(creator 모드의 도구, 설정 > 확장). own.harness가 답하지 않으면 아무것도 바꾸지 않고 다음 쓰기를 기다린다.
- 이 항목이 든 확장은 폴더로 좁힐 수 없다. 대화는 프롬프트 변형 `내 지시문`(`custom`)일 때만 이 글을 쓴다.

---

## 7. 승인

### 7.1 creator 모드의 쓰기

- 세션 규칙을 own의 묶음처럼 읽는다(`edit`·`shell`의 자원 `*`·`**` 마지막 규칙): `edit` deny면 읽기 전용, `edit`과 `shell`이 allow면 전체 허용, 그 밖은 묻기.
- 읽기 전용: 쓰기를 거절한다("읽기 전용에서는 바꿀 수 없다").
- 묻기: 쓰기마다 `creator`를 묻는다. `항상 허용`은 저장하지 않는다(`save` 없음). 거절하면 아무것도 바뀌지 않는다.
- `creator`와 `tool_rule`은 own이 묻는 동작이다. 에이전트의 기본 규칙 `{*, *, allow}`(core의 기본 에이전트)가 이 질문에 답하지 않도록, `evaluate` 훅이 allow를 ask로 바꾼다. `tool_rule`은 그 도구에 저장한 `항상 허용`이 있을 때만 allow로 둔다(P-047의 `saved`). e2e가 처음 돌 때 이 질문이 묻지 않고 통과한 것을 잡았다.
- 전체 허용: 묻지 않는다.
- 묻기 전에 검사한다: 맞지 않는 매니페스트, 없는 확장·판, 충돌은 묻지 않고 바로 실패로 답한다.
- allow 규칙의 승인은 어떤 모드에서도 모델 도구로 할 수 없다(§8).

### 7.2 승인 카드

`creator` 요청의 자원이 카드의 줄이다. own-web은 이 동작을 `확장 바꾸기 승인`으로 보여 준다.

```
확장 house-rules 만들기 (판 1)
· 지시문 조각 style — 캐시 유지
· 명령 도구 ext_say, Code Mode — 캐시 유지
· 도구 규칙 deny webfetch — 요청 글 변화 없음
! allow 규칙은 설정 > 확장에서 사용자가 승인해야 켜져요
! 열린 대화의 프롬프트 캐시가 한 번 깨져요
```

메타데이터 `creator`에 동작, id, 효과 목록이 있다.

---

## 8. 설정 > 확장과 RPC

### 8.1 화면

- 설정 > 고급 > 확장(`/settings/creator`). 이 PC의 창에서만 보인다(`auth`가 `device`가 아님). 페이지·글·RPC 클라이언트는 lazy 청크에 있다(PF5).
- 확장마다 카드: 제목, id, 상태 태그, 활성 판, 설명, 하는 일(항목 종류, 이름, 캐시 영향), 문제, allow 승인(`넓히는 규칙 승인`·`승인 거두기`), 적용 범위(폴더 더하기·빼기·`모든 프로젝트로`), 판 기록(판마다 시각, 만든 쪽, 메모, `지금 판`, `내용 보기`, `이 판으로 되돌리기`), `지우기`(한 번 더 확인).
- 다른 창이나 creator 모드의 바뀜은 `rpc.own.creator.changed`로 와서 목록을 다시 읽는다.

### 8.2 RPC `own.creator`

| 메서드 | 범위 | 하는 일 |
|---|---|---|
| `list` | read | 확장 보기 목록, 형식, 저장소 폴더, 단계, 빌드 |
| `version.get` | read | 판 하나의 파일과 문제, 효과 |
| `enabled.set` | local | 켜기·끄기 |
| `rollback` | local | 활성 판 옮기기 |
| `remove` | local | 지우기(휴지통으로) |
| `scope.set` | local | 프로젝트 폴더(빈 목록 = 모든 프로젝트), `hostProjects`: 호스트 폴더(§10.2) |
| `hosts.set` | local | 보낼 호스트(`all`·`only`·`except`, §10.2) |
| `hostTrust.set` | local | C3 판 하나의 호스트마다 허용·철회(§10.5) |
| `loosen.set` | local | 판 하나의 allow 승인·철회 |
| `plugins.set` | local | C3 스위치(기본 꺼짐) |
| `trust.set` | local | C3 판 하나의 승인·철회 |
| `mcp.stop`, `mcp.start` | local | C2 서버 멈추기·다시 시작(이 서비스가 다시 시작할 때까지) |
| `log.get` | read | 확장 로그의 끝 300줄 |
| `crashes.clear` | local | C3의 멈춤 기록을 지우고 다시 싣기 |

- `list`는 `settings {plugins}`와 멈춘 서버 목록 `stopped`, 호스트 목록 `hosts`(브로커가 맡은 호스트와 보고한 호스트, `connected`, `reportedAt`)도 준다. 보기(`View`)에는 `kind`, `trusted`, `confirmed`, `crashes`, `hostProjects`, `hosts`, `hostTrusted`, `remote`(호스트마다 `reach`와 호스트의 보고)가 있다.
- 이벤트 `changed {ids, at}`. C3 멈춤 파일이 바뀌어도 온다.
- 오류: `not_found`, `version_not_found`, `invalid {problems}`, `scope_invalid {problems}`.
- 화면(§8.1)에는 이것도 있다: 맨 위의 `코드 플러그인` 스위치와 해요체 위험 설명, C2 카드의 `멈추기`·`다시 시작`, `로그 보기`, C3 카드의 `이 판 승인`·`승인 거두기`, `이 폴더에서 멈춤` 목록과 `다시 켜기`.
- 휴대폰 게이트웨이(05 §13)는 `own.creator`를 모르는 이름공간으로 거절한다. 원격 호스트의 own-creator는 이 RPC를 등록하지 않는다(§10.6).
- 화면의 카드마다 `SSH 호스트` 칸(own-web `src/creator/hosts.tsx`): 호스트마다 `보냄`·`빠짐`·`범위 밖`·`PC 전용`·`PC에서 안 켜짐`과 호스트의 보고, 보낼 호스트 고르기, 호스트 폴더 더하기·빼기, C3면 호스트마다 `<호스트>에서 이 판 허용`과 위험 설명. 호스트 이름은 own.remote `hosts.list`에서 읽는다.

---

## 9. 안전

1. **C0·C1의 코드는 돌지 않는다.** C0·C1의 확장은 데이터다. own-creator가 정해진 길로만 해석한다. 명령 도구가 실행하는 것은 사용자의 승인 모드가 허용한 셸 명령뿐이다. C2의 코드는 own의 WebAssembly 샌드박스 안에서(§11.6, 진짜 경계), C3의 코드는 서비스 안에서(§12.5, 경계 아님, 기본 꺼짐) 돈다.
2. **자격 증명을 읽지 못한다.** 명령의 환경에 비밀이 없고, 템플릿은 자격 증명 위치를 부를 수 없고, 출력의 토큰 모양은 가린다. 프롬프트 조각과 다른 항목은 무엇도 실행하지 않는다.
3. **own의 권한을 우회하지 못한다.** 규칙은 좁히기만 하고, 넓히는 것은 사용자의 승인 뒤에만, deny는 결코 풀지 않는다. own의 문과 creator 자신의 승인은 넓힐 수 없다. 명령은 core 셸 도구와 같은 승인을 거친다.
4. **한계.** 승인된 셸 명령(명령 도구)은 사용자의 권한으로 돈다(core 셸 도구와 같다). 자격 증명 이름 검사는 벽이지 샌드박스가 아니다: 승인한 명령이 다른 길로 파일을 읽는 것까지 막지는 못한다. 그래서 명령은 매번 셸 승인을 거친다. C2는 다르다 — 샌드박스가 진짜 경계여서, 정적 검사를 지난 코드도 디스크·네트워크·프로세스에 닿을 전역이 없다.
5. **저장소.** 판은 바뀌지 않고 해시로 지킨다(`Hash.folder`는 `lstat`로 걷고 링크가 있으면 거부, 캐시 안 씀). 파일 도구의 쓰기는 거절한다. 모든 쓰기는 기록(`history`, 최근 100개)에 남는다(누가: 모델·사용자).
6. **범위 검사.** 루트, own의 집, 설정 폴더, 없는 폴더, 상대 경로는 범위가 될 수 없다.
7. **읽기 전용 역할.** `explore`·`own-review`는 모든 C2 도구를 거부한다(§11.6 F4).
8. **원격 호스트.** 호스트는 PC 저장소를 읽기만 한다(§10.6). 판 파일은 PC의 해시와 같을 때만 쓰이고, C2는 호스트의 샌드박스에서 다시 검사되고, C3는 호스트마다 따로 허용해야 간다.

---

## 10. 원격(SSH) 호스트

**결정(CRM-D7, 2026-11-06 사용자 결정 "creator 확장은 SSH 원격 호스트에도 가야 한다")**: 확장은 호스트로 간다. 만들기·바꾸기·승인은 PC에서만 하고, 호스트는 PC 저장소의 읽기 전용 사본(미러)을 받아 그 호스트의 대화에 적용한다. 호스트가 PC의 저장소에 쓰는 길은 없다. 결정 CRM-23–CRM-31.

### 10.1 구성

| 곳 | 맡는 일 |
|---|---|
| PC own-creator `src/remote.ts` | 호스트마다의 보기(`Remote.view`)와 그 보기가 가리키는 파일 조각(`Remote.file`)을 own-runtime `CreatorBridge`에 내놓는다. 읽기만 한다 |
| PC own-accounts 브로커(04 §9.3) | 호스트의 `creator.get`·`creator.file`·`creator.report`에 답하고, 저장소가 바뀌면 `creator.changed`를 민다. normal 모드(같은 빌드)에서만 |
| 호스트 own-accounts(remote) | 브로커 세션을 `CreatorBridge` 링크로 내놓는다(요청, 세션이 올라옴·`creator.changed` 알림) |
| 호스트 own-creator(`mode: "remote"`) `src/mirror.ts` | 보기를 받아 판 파일을 가져오고, 해시를 PC의 판과 맞추고, C2면 호스트의 단계 검사를 샌드박스에서 다시 하고, 호스트의 `store.json`을 쓰고, 결과를 알린다 |
| own-remote | 원격 번들에 own-creator와 QuickJS(`quickjs/core`, `quickjs/variant`, `.wasm` 하나로 x64·arm64)를 싣고, 관리 config의 마지막에 `{own-creator, options: {home, mode: "remote"}}`를 둔다 |

- 원격 번들: `REMOTE_PLUGINS`의 끝에 own-creator. own-creator 폴더에는 `index.js`와 `quickjs\`의 ES 모듈(`.mjs`)과 `.wasm`만 함께 간다(소스 맵·선언·CommonJS 사본은 빼서 설치 스크립트의 체크섬 목록을 짧게 둔다)(`CREATOR_QUICKJS_FILES`가 빠지면 묶기가 실패하고 `inspectRemote`가 문제로 적는다). C2 타입 검사용 `types\`는 PC 전용이다(호스트는 소스에서 판을 만들지 않는다).
- 호스트의 own-creator는 `mode: "remote"`로 돈다: 저장소는 미러(`Store({mirror: true})`)이고 미러 쓰기와 C2 호출 확인 말고는 모든 쓰기가 `read_only`다. creator 에이전트·creator 스킬·`creator_inspect`·`creator_manage`·`own.creator` RPC가 없다. 나머지(조각, 규칙, 재시도, 압축, 에이전트·명령·스킬, 내 지시문, 명령 도구, C2 서버, C3 config)는 PC와 같은 코드가 같은 파일로 적용한다.

### 10.2 보기와 범위

PC는 호스트마다 보기를 만든다(`Creator.MirrorView`: `revision`, C3 스위치 `plugins`, `extensions[]`). 확장 하나(`MirrorEntry`)는 활성 판의 판 정보(`n`, `hash`, `createdAt`, `by`, `app`, `checks`), 파일 목록(경로와 크기, ≤ 4,000개, ≤ 64 MiB, 링크가 있으면 보내지 않음), 호스트의 범위 폴더, allow 승인 여부(`loosen`: PC의 승인 **그리고** 그 호스트의 판 허용이 있을 때만, §10.5), 호스트 허용(`hostTrusted`)이다.

확장이 호스트에 가는지(`Remote.reach`, 카드의 `remote[].reach`):

| 값 | 뜻 |
|---|---|
| `sent` | 보냄 |
| `inactive` | PC에서 적용 중이 아님(꺼짐, 깨짐, 충돌). C3는 온전하고(`active`·`pending`) 스위치가 켜져 있으면 PC의 승인과 상관없이 다음 줄로 간다 |
| `excluded` | 호스트 선택이 그 호스트를 빼냄 |
| `pc_only` | C3인데 그 호스트에 활성 판을 허용하지 않았거나 스위치가 꺼짐 |
| `out_of_scope` | 범위에 폴더가 있는데 그 호스트의 폴더가 없음 |

- **호스트 선택**(`Entry.hosts`, RPC `hosts.set`): `all`(기본), `only`(고른 호스트만, 비면 아무 데도), `except`(고른 호스트 빼고).
- **범위**: 범위 항목은 기계마다다. `projects`는 이 PC의 폴더, `hostProjects`는 호스트 id가 붙은 호스트의 폴더(`{host, directory}`, RPC `scope.set`의 `hostProjects`)다. 둘 다 비면 모든 기계의 모든 프로젝트, 아니면 적힌 폴더에서만. PC는 호스트 폴더를 절대 경로이고 루트가 아닌지만 본다(PC는 호스트 디스크를 못 본다). 호스트가 다시 본다(`Safety.hostFolders`: 절대 경로, 루트 아님, 호스트의 OWN_HOME·설정 폴더 아님). 폴더가 적힌 범위에서 쓸 수 있는 폴더가 하나도 남지 않으면 그 확장은 그 호스트에 적용되지 않는다(모든 프로젝트로 넓어지지 않는다).
- 내 지시문·C3처럼 모든 프로젝트에 적용되는 항목이 든 확장은 호스트 폴더로도 좁힐 수 없다.

### 10.3 동기화 (호스트)

`Mirror.sync`, 프로세스마다 하나(첫 인스턴스의 것), 링크가 올라올 때와 `creator.changed`마다, 한 번에 하나:

1. `creator.get`. 세션이 없거나 PC에 own-creator가 돌지 않아 보기가 없으면 마지막 미러를 그대로 둔다(끊겨도 호스트는 받은 사본을 쓴다). PC가 다른 빌드여서(drain, `skew_drain`) creator 메서드에 답하지 않으면 나머지는 두고 **C3 확장과 allow 승인만 거둔다**(CRM-34): PC에서 거둔 허용이 그 호스트에 닿을 길이 없기 때문이다.
2. 확장마다 활성 판 폴더의 해시가 PC의 `hash`와 같으면 그대로, 아니면 파일을 `creator.file`로 조각(≤ 512 KiB)마다 받아 옆 temp 폴더에 쓰고, 폴더 전체를 `Hash.folder`로 해시해 **PC의 판 해시와 같을 때만** 제자리로 옮긴다. 다르면 그 확장은 `failed`(호스트에 적용 안 됨). 경로에 `..`·`\`·`:`가 있으면 받지 않는다.
3. C2(`kind: "mcp"`)는 호스트의 단계 검사(`Staging.hostCheck`)를 한다: PC가 만든 번들이 해시에 들어 있으므로 다시 설치·번들하지 않고, 서버마다 확장의 시험을 번들해 **호스트의 샌드박스**에서 돌리고 smoke를 호스트의 own 호스트·샌드박스·울타리로 돌린다. 결과는 `<id>:<n>:<hash>`마다 `creator\mirror.json`에 남아 같은 판에는 다시 하지 않는다. 실패하면 `failed`, 서버는 등록되지 않는다. 단계마다 결과가 호스트의 확장 로그(`creator\logs\<id>.log`, `host staging …`)에 남는다.
4. 호스트의 `store.json`을 보기로 쓴다(`writeMirror`): 확장마다 활성 판 하나, 켜짐, 범위 = 호스트 폴더, `loosen` = PC의 승인, `trusted` = C3의 호스트 허용, `confirmed` = 호스트가 이미 가진 것(그 판의 것만). `settings.plugins`는 PC 스위치이면서 호스트 허용이 있는 C3가 있을 때만 켜진다. 보기에 없는 확장과 판의 폴더는 지운다. 그다음은 PC와 같다: 읽을 때마다 해시를 다시 재므로 호스트에서 손으로 고친 사본은 `tampered`가 되어 적용되지 않고, 다음 동기화가 PC의 판을 다시 받는다.
5. 내 지시문: 동기화한 인스턴스가 own.harness의 RPC로 넘겨받거나 되돌린다(§6.4, 호스트의 own.harness 저장소).
6. 붙은 모든 인스턴스가 다시 읽기를 마칠 때까지 기다린 뒤(그래야 `active`라는 보고가 그 호스트의 대화에 이미 들어 있다는 뜻이 된다) `creator.report`로 확장마다 `{id, n, status, problems}`를 알린다. PC는 이것을 메모리에만 두고(`CreatorBridge.reports`, 호스트마다 마지막 하나, 받은 시각은 PC의 시계) 카드의 호스트 줄에 보인다. PC의 저장소에는 쓰지 않는다.
   - 보고는 PC의 활성 판 것만 보인다(다른 판이면 `호스트의 답을 기다려요`). PC가 더는 보내지 않는데(빠짐·PC 전용·꺼짐) 호스트의 마지막 보고가 아직 `active`이면 그 줄은 `호스트에 아직 켜져 있어요. 호스트가 이 PC와 다시 이어져 맞출 때 빠져요.`라고 쓴다(CRM-34).
   - 한도(CRM-35): 보고의 `revision` ≤ 128자, 문제의 `path` ≤ 200자·`message` ≤ 400자, 확장 ≤ 256개·문제 ≤ 8개. 같은 내용의 보고는 다시 알리지 않고, 알림은 1초에 한 번으로 묶는다. 브로커는 호스트 세션마다 `creator.file`을 동시에 4개까지만 읽고, 그 세션의 소켓에 보낼 것이 8 MiB를 넘게 쌓여 있으면 거절한다(`invalid`). 브로커가 더는 맡지 않는 호스트의 보고는 지운다.
   - PC는 `creator.file`의 파일을 열기 직전에 다시 본다: 보기를 만들 때와 같은 크기의 보통 파일이 아니면(그사이 링크로 바뀌었거나 고쳐졌으면) 주지 않는다.

### 10.4 항목마다

| 항목 | 호스트에서 |
|---|---|
| 조각, 도구 규칙, 재시도, 압축 추가 | PC와 같다(호스트의 세션, 호스트의 권한 훅) |
| 에이전트·명령·스킬 | PC와 같다. 스킬 경로는 호스트의 판 폴더 |
| 내 지시문 | 호스트의 own.harness를 넘겨받는다(호스트마다 따로 남긴 원래 글) |
| 명령 도구 | 호스트의 셸(`/bin/bash`, 없으면 `sh`)과 호스트 대화의 승인(`shell.authorize`), 환경 정리·출력 가리기는 같다 |
| C2 MCP 서버 | 호스트의 실행 파일(Bun)로 own의 호스트와 QuickJS 샌드박스, 호스트의 허용 목록 환경·프로젝트 폴더·승인 모드. 부를 때 묻는 것과 `전체 허용`의 판마다 첫 확인(`confirmed`)은 호스트 대화에서, 호스트의 미러에 남는다 |
| C3 코드 플러그인 | PC 전용. 아래 §10.5 |

### 10.5 호스트마다의 허용: C3와 allow 규칙

- 사용자가 설정 > 확장의 그 확장 카드에서 호스트마다 `<호스트>에서 이 판 허용`(RPC `hostTrust.set`, `Entry.hostTrusted`의 `{host, n}`)을 누를 때만 그 호스트의 보기에 들어간다. PC의 `이 판 승인`(`trust`)과 따로이고 서로를 뜻하지 않는다. 판마다다(새 판은 다시 허용). 기록에 `host_trust`·`host_untrust`가 호스트 id와 남는다. 위험 문구는 PC의 것과 같다(`own.ext.hostTrust.risk`: 호스트의 서비스 안에서 나로 돌고, 호스트의 파일·네트워크와 호스트가 받는 계정 토큰에 닿는다).
- 허용이 없으면 PC는 그 판의 파일을 보내지 않는다(`pc_only`). 보기가 허용을 잘못 말해도 호스트의 저장소는 `trusted`가 없으면 `pending`(스위치가 꺼졌으면 `unavailable`)으로 읽어 싣지 않는다.
- **allow 규칙도 호스트마다다**(CRM-33): PC에서 승인한 넓히는 규칙(`loosen`)은 그 호스트에 그 판을 허용했을 때만 호스트에서 켜진다. 허용이 없으면 호스트는 규칙을 받되 allow는 꺼진 채로 두어 호스트의 기본 묻기가 그대로 남는다. PC의 승인은 이 PC의 대화에 대한 것이기 때문이다. 같은 `hostTrust.set`을 쓰고, 넓히는 규칙이 있는 확장의 카드에도 `<호스트>에서 이 판 허용`이 보이며 위험 문구는 `own.ext.hostLoosen.risk`다. 코드도 넓히는 규칙도 없는 판은 호스트마다 허용할 것이 없다(`invalid`).
- 허용된 판: 호스트의 own-creator가 PC와 같은 `CodePlugins.sync`로 호스트의 `trust.json`에 판 폴더 해시 승인을 먼저 넣고 config의 `plugins` 끝에 항목을 더한다. 호스트에서는 own-remote가 연결마다 `opencode.json`을 통째로 다시 쓰므로 C3 항목은 core가 그 뒤에 읽는 `opencode.jsonc`에 쓴다(없으면 만든다, creator 항목만 고친다). shim은 불러오기 전에 판 폴더의 해시를 새로 재어 맞춘다(F5). 그래서 폴더 해시 trust는 호스트에서도 확인된다.

### 10.6 승인은 대화가 있는 곳에서

- 확장을 만들고 바꾸고(켜기·끄기·되돌리기·범위·호스트 선택·지우기) allow 규칙과 C3를 승인하는 것은 PC에서만 한다(설정 > 확장, creator 모드).
- 대화의 승인(명령 도구의 셸, C2 호출, 도구 규칙의 `tool_rule`)은 그 대화가 있는 호스트에서, 호스트의 승인 모드로 한다.
- 호스트가 PC에 쓰는 길은 없다: 브로커의 creator 메서드는 읽기(`get`, `file`)와 메모리 보고(`report`)뿐이고, 모르는 메서드는 프레임 오류로 세션을 끝낸다. 호스트의 저장소는 `read_only`이고 호스트에는 `own.creator` RPC가 없다.

### 10.7 실제 호스트 연쇄

릴리스 연쇄의 phase C 뒤에 `test/real-host/c-creator.test.ts`가 돈다(2.2.5-own.3에서 처음 실제 호스트 6/6, decisions RL4-H2): 관리 config의 own-creator, 번들의 QuickJS, 조각·규칙·명령 도구가 호스트 대화에, C2가 호스트 샌드박스에서 단계 검사 뒤 호스트 대화에서 물어 돈다, C3는 허용 없이 가지 않는다, 호스트에서 고친 사본은 PC에 닿지 않는다, 되돌리기가 따라간다.

---

## 11. C2: 생성 MCP 서버 (`kind: "mcp"`)

### 11.1 형식

| 필드 | 뜻 |
|---|---|
| `type` | `mcp.server` |
| `name` | 소문자로 시작, 소문자·숫자·`-`, 2–24자. 서버 이름은 `creator-<id>-<name>`이고, core가 도구를 `creator-<id>-<name>_<tool>`로 부른다 |
| `files` | 파일 1–24개(상대 `/` 경로, `.`·`..` 없음, 코드는 소문자 `.ts`/`.js`/`.mts`/`.mjs`), 한 파일 ≤ 200,000자, 합 ≤ 600,000자. own의 이름과 설치·런타임 설정 파일(`.npmrc`, `.yarnrc*`, `bunfig.toml`, `.env*`)은 어느 깊이에서도 쓸 수 없다 |
| `entry` | 시작 파일(기본 `server.ts`). own의 `./own-mcp`에서 `serve`를 부른다 |
| `dependencies` | own 허용 목록의 npm 패키지(≤ 8, **정확한 판만**, 범위 없음) |
| `hosts` | `context.fetch`가 닿을 호스트(≤ 8, `api.example.com`·`127.0.0.1:8080`·`[::1]:3000`). 와일드카드 없음, 사용자가 판과 함께 승인 |
| `smoke` | 단계 검사가 모델처럼 부를 호출(≤ 8): `tool`, `arguments`, `expect`(답에 있어야 할 글) |
| `timeoutSeconds` | 호출 하나의 시간(1–300, 기본 60) |
| `memoryMb` | 서버의 메모리 상한(64–2,048, 기본 512) |
| `direct` | 직접 도구(기본은 Code Mode) |
| `when` | §3.2. `project`는 등록 때, 하네스·에이전트·모델은 부를 때(맞지 않으면 deny) |

- 판 폴더의 `servers\<name>\`에 파일과 own의 `own-mcp.ts`, `tsconfig.json`, 의존성이 있으면 `package.json`·`bun.lock`·`node_modules`가 있다. 해시는 이 모두를 덮는다(§4.2, `Hash.folder`는 파일 크기·시각이 같으면 앞 값을 다시 쓴다).

### 11.2 실행

- core의 MCP config 길로 등록한다: own-creator가 Location마다 `ctx.mcp.transform`에서 그 Location에 적용되는(켜짐, 범위 안, `when.project` 맞음) 서버만 `editor.set`한다. 판이 바뀌면 명령이 바뀌므로 core가 그 서버만 다시 시작한다(`ctx.mcp.reload`, 바뀐 것만).
- 명령: `[<서비스의 실행 파일>, OWN_HOME\creator\runtime\mcp-host.ts, <설정>]`, `environment: {BUN_BE_BUN: "1"}`, `cwd`는 대화의 프로젝트 폴더. 설치본에서는 서비스의 실행 파일이 `BUN_BE_BUN=1`로 Bun이 된다.
- own의 호스트는 **own의 WebAssembly 샌드박스(QuickJS)** 를 띄우고, 단계에서 번들한 서버 한 파일(`server.bundle.js`)을 샌드박스에 넣는다. 서버 코드에는 호스트 전역이 하나도 없다 — `process`·`Bun`·`require`·전역 `fetch`·Node·디스크가 없고, 나가는 길은 own의 브리지 `__own`뿐이다. 명령은 `[<bun>, "--no-env-file", mcp-host.ts, <설정>]`. CPU·시간·메모리 상한은 엔진이 건다(마감 시각의 interrupt 핸들러, 런타임 메모리 한도).
- 호스트 프로세스 자신도 정리된 허용 목록 환경으로 돈다(`Safety.serverEnv`). L5: 호스트에는 TEMP를 주지 않는다(own의 TEMP가 OWN_HOME 안을 가리키지 않게).
  - 남기는 것: `PATH`(사용자 프로필 안의 폴더는 뺌), `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `OS`, 프로세서 변수, `LANG`·`LC_*`, `TZ`, `TERM`, `NO_COLOR`.
  - 빈 값으로 두는 것(Windows 사용자 변수): `USERNAME`, `USERDOMAIN`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `LOGONSERVER`, `COMPUTERNAME`, `OneDrive*`, `USER`, `LOGNAME`.
  - own이 주는 것: `BUN_BE_BUN=1`, `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, `NO_COLOR=1`. TEMP·TMP는 없다(단계 검사의 own 도구에만 scratch TEMP를 준다).
  - 그 밖의 모든 것은 없다: 자격 증명, `OWN_*`·`OPENCODE_*`·`CLAUDE_*`·`CODEX_*`·provider 변수, GitHub 로그인.
  - 샌드박스 자체에는 환경이 아예 없다(프로세스·env 접근 불가). 울타리(프로젝트·deny·hosts·시간·메모리)는 호스트의 설정으로 전달한다.
- 호스트는 샌드박스와 MCP(JSON-RPC)를 중계하고, 로그를 확장 로그에 쓴다(토큰 모양 글은 가림). 시작·끝(종료 코드, 메모리 상한이면 그렇다고)도 로그에 남긴다. stdin이 닫히면 끝난다.

### 11.3 own 도우미 `own-mcp.ts`와 브리지

- 샌드박스 안에서 서버가 `serve({name, tools})`를 부른다. 도구마다 `description`, `input`(JSON 스키마 `type: "object"`), `run(args, context)`. 답은 글, `{text}`, `{json}`, `{error}`. `own-mcp.ts`는 샌드박스 안에서 돌며 own의 브리지(`__own`)에 꼴을 입힐 뿐, 경계가 아니다 — 경계는 호스트가 브리지 호출마다 거는 검사다. MCP(JSON-RPC: `initialize`, `tools/list`, `tools/call`, `ping`)는 호스트가 말한다.
- `context.files`(`read`, `write`, `list`, `exists`): 프로젝트 폴더 안만. 호스트의 울타리가 거절하는 것 — `:`(ADS·드라이브), 끝의 점·공백, junction·심볼릭 링크로 밖, `..`, UNC, `\\?\`, 8.3 단축 이름, 밖으로 나가는 경로(실제 경로로 판단), own의 집·설정 폴더·`.codex`·`.claude`, 그리고 깊이에 상관없이 `.ssh`·`.git`·`.git-credentials`·`.aws`·`.config/gh`·`.npmrc` 같은 자격 증명 파일·폴더와 `.env*`.
- `context.fetch(url, init?)`: 확장이 선언하고 사용자가 승인한 `hosts`로만. 와일드카드 없음, localhost·LAN도 선언·승인 없이는 안 됨. 호스트가 승인 목록으로 거른다(redirect 수동).
- 호출 시간(`timeoutSeconds`), 답 글 100,000자, 메모리 상한(엔진의 메모리 한도와 마감 interrupt).
- 확장의 시험용 `callTool(definition, name, args)`와 `test`/`expect`(샌드박스 안에서 돈다).

### 11.4 활성화 전 단계 검사

`creator_manage` `create`·`update`가 묻고(§11.5) 승인을 받은 뒤, 판을 쓰기 **전에** `OWN_HOME\creator\stage\<id>.<시각>.<rand>`에서 서버마다 차례로 한다. 번들·시험·smoke는 모두 샌드박스 안에서 돈다 — 단계 검사가 샌드박스 밖에서 서버 코드를 돌리는 일은 없다. own의 도구(설치·타입 검사)는 §11.2의 허용 목록 환경(이 단계에선 TEMP = 단계 scratch)을 쓴다.

1. **설치**(의존성이 있을 때): `bun install --ignore-scripts --no-progress`, 캐시 `creator\cache\bun`(확장마다). 설치 스크립트는 돌지 않는다. 레지스트리는 `--registry https://registry.npmjs.org/`로 못 박고(시험은 플러그인 옵션 `registry`), `.npmrc`·`.yarnrc*`·`bunfig.toml`·`.env*`는 어느 파일로도 받지 않는다. 의존성은 own 허용 목록의 순수 JS 라이브러리(제 의존성 없음)만, 정확한 판으로.
2. **타입 검사**(이른 린트, 경계 아님): `bun check`(strict, `lib: ESNext`, `types: []` — 샌드박스엔 Node·Bun이 없다).
3. **번들**: `Bun.build`(target browser, macro 끔)로 진입 파일을 한 파일(`server.bundle.js`)로. Node·Bun import(린트가 이미 거절)가 있으면 번들도 실패한다.
4. **확장의 시험**: `*.test.ts`를 번들해 샌드박스에서(`run: "test"`) 돌린다.
5. **가짜 모델 smoke**: 번들을 core와 똑같이 own의 호스트·샌드박스·울타리로 띄우고, 대본 클라이언트가 모델 역할을 한다: `initialize`, `tools/list`(도구 하나 이상, 이름 `[A-Za-z0-9_-]{1,64}`, `inputSchema.type: "object"`), `smoke`의 호출마다 오류 아님과 `expect`.

- 다 통과하면 저장소가 단계 폴더를 `ext\<id>\v<n>`으로 옮기고 해시한다. 판 정보에 `checks`(이름과 걸린 시간)와 `app`(앱 판)을 남긴다.
- 하나라도 실패하면 단계 폴더를 지우고 판을 쓰지 않는다. 앞 판이 그대로 활성이다. 도구 답은 `reason: "stage_failed"`, `problems`(`stage.<단계>`와 끝 출력), `checks`.
- 단계마다 결과가 확장 로그에 남는다.

### 11.5 승인

- **쓰기**: creator 모드의 쓰기 묻기(§7.1)와 같다. 의존성을 설치하는 판은 **전체 허용에서도** 묻는다. 카드에 `의존성 설치(<서버>): <패키지@판> — 허용 목록, 설치 스크립트 없이`와 `코드가 own의 WebAssembly 샌드박스에서 … 돌아요`가 붙는다.
- **호출**: core는 MCP 도구마다 그 이름의 권한을 묻는다(`creator-<id>-<name>_<tool>`, 자원 `*`). own-creator의 `evaluate` 훅이 own의 승인 모드로 정한다(deny는 그대로):
  - 묻기: 언제나 `ask`(에이전트의 `*` allow도, 저장한 `항상 허용`도 넘지 못한다).
  - 읽기 전용: `deny`(묻지 않음, §11.6 F4). own-accounts의 읽기 전용 역할도 `creator-` 접두사로 거부한다.
  - 전체 허용: 그 판의 호출을 사용자가 한 번 승인하기 전에는(어느 모드에서 승인했든) `ask`, 그 뒤에는 `allow`. 호출이 끝나면(`execute.after`, `completed`) 그 판을 `confirmed`에 넣는다. 새 판은 다시 처음이다.
  - `when`의 하네스·에이전트·모델이 맞지 않으면 deny.
  - core가 아직 가진 `creator-` 도구인데 이 인스턴스가 적용 중인 서버로 모르는 것(판이 막 바뀌었거나 호스트의 미러를 적용하는 중)은 어느 모드에서도 묻는다(CRM-32).
- 이 권한 이름은 `creator`로 시작하므로 어떤 확장의 allow 규칙도 넓힐 수 없다(§3.4).

### 11.6 안전

1. **샌드박스가 경계다.** 서버 코드는 own의 WebAssembly JavaScript 엔진(QuickJS) 안에서, 별도 프로세스로 돈다. 호스트 전역이 하나도 없다: `process`·`Bun`·`require`·전역 `fetch`·Node·디스크가 없다. 서비스의 메모리·인증 헤더·다른 플러그인에 닿지 않는다. 나가는 길은 own의 브리지뿐이고, 호스트가 호출마다 검사한다.
2. **자격 증명이 없다.** 샌드박스에는 환경이 아예 없다. 호스트도 허용 목록 환경이고(§11.2), 서버는 own의 집이 어디인지 받지 않는다.
3. **파일은 울타리 안에서만**(브리지의 `files`): 프로젝트 폴더 안만. `:`(ADS·드라이브), 끝의 점·공백, junction·심볼릭 링크로 밖, `..`, UNC, `\\?\`, 8.3 단축 이름, own의 집·설정·`.codex`·`.claude`, 깊이 상관없이 `.ssh`·`.git`·`.git-credentials`·`.aws`·`.config/gh`·`.npmrc`·`.env*` 같은 자격 증명 파일·폴더를 거절한다.
4. **네트워크는 선언한 호스트만**(브리지의 `fetch`): `hosts`에 적고 사용자가 승인한 호스트만. 와일드카드 없음, localhost·LAN도 선언·승인 없이는 안 됨.
5. **정적 검사는 경계가 아니라 이른 린트다**(`Code.problems`, 묻기 전에, 모든 파일을 대소문자 무시로): import(자기 파일·`./own-mcp`·선언한 의존성만; Node·Bun import 거절), 샌드박스에 없는 이름(`process`, `Bun`, `require`, 전역 `fetch`, …), 동적 `import()`·`import.meta`·import 속성, `.tsx`·`.cts` 같은 다른 확장자, 설치·런타임 설정 파일(`.npmrc`·`.yarnrc*`·`bunfig.toml`·`.env*`)을 걸러낸다. `Bun.Transpiler`는 macro를 끄고(`macro: false`) 돌린다 — untrusted 소스를 transpile·scan할 때 macro import가 실행되지 않게. 이름을 잘 숨긴 코드(문자열로 만든 이름 등)는 린트를 지날 수 있지만, 샌드박스에는 닿을 전역이 없으므로 아무것도 못 한다.
6. **의존성 허용 목록**: `zod`, `yaml`, `date-fns`, `dayjs`, `marked`, `diff`, `papaparse`, `semver`, `lodash-es`(순수 JS, 제 의존성 없음). 정확한 판만, 설치 스크립트 없이, own의 캐시에, `--registry https://registry.npmjs.org/`로.
7. **한계(막지 못하는 것).** CPU·시간·메모리는 엔진이 건다(마감 interrupt, 메모리 한도). 샌드박스 탈출(QuickJS·wasm 자체의 버그)은 엔진을 믿는다; 고정한 판(0.32.0)의 무결성을 npm integrity로 확인한다. 보관함 항목은 그래도 DPAPI와 own-vault entropy로 한 겹 더 잠겨 있다.

### 11.7 멈추기와 로그

- 설정 > 확장의 `멈추기`(`mcp.stop`): 이 서비스의 모든 Location에서 그 확장의 서버를 config에서 빼고(`ctx.mcp.reload`) core가 프로세스를 끝낸다. `다시 시작`(`mcp.start`)까지, 또는 서비스가 다시 시작할 때까지.
- `로그 보기`(`log.get`): 끝 300줄. 서버 시작(pid), stderr, 끝(코드), 멈추기, 단계 검사의 단계마다 결과. 토큰 모양 글은 가린다.
- creator 모드도 `creator_manage` `log`로 끝 120줄을 읽는다(고칠 때 쓴다).

## 12. C3: 코드 플러그인 (`kind: "plugin"`, 기본 꺼짐)

### 12.1 스위치

- 설정 > 고급 > 확장 맨 위의 `코드 플러그인 쓰기`(`store.json`의 `settings.plugins`, 기본 꺼짐). 해요체 위험 설명이 늘 보인다: 서비스 프로세스 안에서 돌고, own이 요청의 사본만 넘기지만 같은 프로세스 안의 코드를 완전히 막을 수는 없고, 판마다 승인한 것만 켜진다.
- 꺼져 있으면: `plugin` 확장의 `create`·`update`는 `plugins_off`로 거절한다(묻지 않음). 있던 확장은 `unavailable`이 되고 config 항목과 trust 승인이 빠진다.
- 스위치는 사용자만 바꾼다(RPC `plugins.set`). creator 모드의 도구로는 바꿀 수 없다.

### 12.2 형식과 shim

| 필드 | 뜻 |
|---|---|
| `type` | `plugin.code` |
| `files` | §11.1과 같다. 판 폴더의 맨 위에 쓴다. `server.ts`, `index.ts`도 own의 이름이다 |
| `entry` | 기본 `plugin.ts`. own의 `./own-plugin`에서 `definePlugin({hooks})`를 기본 내보내기로 |
| `hooks` | `context`(모든 모델 호출의 요청), `compaction`(압축 요청) 가운데 1–2개 |
| `cache` | `keeps`(기본)나 `breaks`. `keeps`면 golden이 캐시 prefix를 지키는지 본다(§12.3) |

- 요청·압축 훅만 받는다. 선언 항목(C1)이나 MCP 서버(C2)로 되는 일에는 쓰지 않는다(creator 모드의 안내와 스킬 `own-creator-code`).
- 확장 전체가 이 항목 하나다. core의 플러그인 목록이 모든 Location에 하나이므로 C3 확장은 폴더로 좁힐 수 없다(내 지시문과 같은 `globalOnly`).
- 판 폴더에 own이 쓰는 것: `own-plugin.ts`(API 타입과 `definePlugin`), `own-shim.ts`(훅을 돌리는 코드), `server.ts`(core가 싣는 진입 파일, `own-plugin-server.ts`), `own-plugin-env.d.ts`(타입 검사용 전역 몇 개), `tsconfig.json`.
- core가 싣는 것은 `server.ts`다. 플러그인 id는 `own.creator.ext.<id>`. 이것이 `own-shim.ts`로 플러그인의 진입 파일을 불러오고, `context`·`compaction` 훅만 등록한다. 훅에는 **사본**을 준다: `sessionID`, `agent`, `model`, `system`(글 부분만), `messages`(JSON 사본), `tools`(이름만), 압축이면 own의 `prompt`. 헤더, provider 옵션, own-accounts가 넣는 인증은 사본에 없다. 다른 도메인(도구, 세션, 자격 증명, RPC, 셸, config)도 넘기지 않는다.
- 훅이 끝나면 바뀐 것만 되돌려 쓴다: system 글, 고치거나 더한 메시지(그대로인 메시지는 원래 객체를 둔다), 압축의 `prompt`.

### 12.3 활성화 전 단계 검사

**단계 검사는 플러그인 코드를 돌린다(e2e 훅 검사). 서비스 안에서는 전체 권한이므로, 돌리기 전에 별도 승인 카드로 먼저 묻는다**(전체 허용에서도; §7, `Views.runCard`): "이 코드는 서비스 안에서 나로 돌고, 파일·네트워크에 다 닿고 계정 토큰·키를 읽어 밖으로 보낼 수 있다, own의 샌드박스가 없는 단계다." 그 뒤 §12.4의 활성화 승인(이 판 승인)은 그대로다.

단계 폴더에서(§11.4와 같은 자리, 같은 허용 목록 환경):

1. **타입 검사**: `bun check`, own의 플러그인 API 타입만(`types: []`, `own-plugin.ts`와 `own-plugin-env.d.ts`). Bun·Node·브라우저 API가 없으므로 디스크·네트워크·프로세스에 닿는 코드는 타입 검사를 통과하지 못한다. shim과 시험 파일은 뺀다.
2. **확장의 시험**: `bun test`.
3. **가짜 모델 e2e**: `plugin-check.ts`가 자식 프로세스에서 같은 `own-shim.ts`로 판을 싣고, 훅마다 고정된 요청(가짜 모델의 대화: system 하나, 메시지 셋, 도구 둘)을 돌린다. 던지거나 2초를 넘기거나 요청을 망가뜨리면 실패.
4. **캐시 golden**: 같은 요청을 두 번 돌려 바이트가 같아야 한다(훅은 요청의 순수 함수, 02 §4.3 D1). `cache: "keeps"`면 system, 도구, 마지막 메시지 앞의 모든 메시지가 플러그인이 없을 때와 바이트까지 같아야 한다.

정적 검사(품질 린트, 묻기 전에, 모든 파일을 대소문자 무시로): import는 자기 파일과 `./own-plugin`만(상대 import는 확장자를 적어야 한다, F5). 금지 이름은 §11.6의 것에 `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator`, `setInterval`을 더하고, `@ts-nocheck`·`@ts-ignore`·`@ts-expect-error`도 거부한다(품질 검사이지 경계가 아니다).

통과한 판은 `pending`이다. 판 정보의 `app`이 지금 앱 판과 다르면 `outdated`가 되어 싣지 않는다(다시 만들어야 함).

### 12.4 사용자 승인, trust, config

- 설정 > 확장의 `이 판 승인`(`trust.set`)이 그 판 하나를 `trusted`에 넣는다. 승인하지 않은 판은 결코 실리지 않는다. 새 판은 다시 승인해야 한다. creator 모드의 도구로는 승인할 수 없다.
- 실리는 판: 스위치 켜짐, 켜짐, 활성 판이 승인됨, 해시 온전함, 같은 앱 판(상태 `active`). own-creator가 이것을 맞춘다(`CodePlugins.sync`, 다시 읽을 때마다):
  1. **trust 먼저**: own-accounts의 `trust.json`에 이 서비스가 own-creator를 돌리는 모든 Location마다 `{location, source: local:<판 폴더>\server.ts, sha256: <판 폴더 해시>}`를 넣는다. 그래서 새 플러그인이 실릴 때 own-accounts가 그 Location을 `blocked_by_plugin`으로 보지 않고 인증을 계속 넣는다. 나중에 열린 Location은 그 Location의 own-creator가 setup 중에 넣는다(creator 플러그인보다 앞서 돈다).
  2. **config**: own 전역 config(`%OPENCODE_CONFIG_DIR%\opencode.jsonc`)의 `plugins` **끝**에 `{package: <판 폴더>, options: {entry, version, log, crashes, hookMs, hash}}`를 더한다(F5: `hash`는 판 폴더 해시). 맞지 않는 creator 항목은 뺀다. 맞는 항목은 그 자리에 둔다. core는 바뀐 첫 항목부터 다시 싣으므로 own 플러그인은 다시 싣지 않는다.
  3. **trust 정리**: 더는 실리지 않는 판의 승인을 뺀다.
- **own-accounts `Trust.fingerprint`를 폴더로 넓혔다**: 진입 파일 옆에 `own.ext/1`의 `plugin` 종류 `extension.json`이 있는 폴더(creator 판 폴더)는 진입 파일이 아니라 폴더 전체를 `Hash.folder`로 해시한다. own-creator가 판 정보에 남기는 값과 같다. 도우미 파일 하나만 바뀌어도 다시 막힌다. 다른 모든 플러그인은 진입 파일 해시 그대로다(쓰던 승인이 그대로 맞는다).
- **F5: shim이 불러오기 전에 새 해시를 확인한다.** `own-shim.ts`는 진입 파일을 `import`하기 전에 판 폴더의 해시를 `lstat`로 새로 계산해(링크가 있으면 거부) config 항목의 `hash`와 맞는지 본다. 다르면 불러오지 않고 crash로 적는다. 크기·시각 캐시는 쓰지 않는다. trust·변조 판정도 캐시를 쓰지 않는다(`Hash.folder`).
- **런처**: 자기 항목만 고치고 creator 항목은 손대지 않는다. 새 묶음은 own-creator 항목 바로 뒤, 곧 creator 항목 앞에 들어간다. `own config init --force`는 앞 config의 creator 항목을 새 목록의 끝으로 옮겨 준다(`Get-CreatorPluginEntries`).
- 끄기, 지우기, 되돌리기, 승인 거두기, 스위치 끄기: 같은 맞추기가 config 항목을 바꾸거나 빼고, 승인을 정리한다.

### 12.5 자격 증명과 프로세스 안의 한계

**C3는 정직하게 말한다: 승인한 코드는 나(사용자)로 서비스 안에서 돌고, 파일과 네트워크에 다 닿고 계정 토큰·키·자격 증명을 읽어 밖으로 보낼 수 있다.** 그래서 스위치가 기본 꺼짐이고, 단계 검사 전과 활성화 전에 각각 승인을 받고, 위험 설명이 UI와 설명서에 늘 그렇게 적혀 있다.

own이 하는 것:
- shim은 `context`·`compaction` 훅의 사본만 준다. 인증 헤더는 own-accounts가 `model.request`·`http.request` 훅에서 넣는데, C3에는 이 훅이 없다. 그래서 C3 훅의 길에는 인증이 지나가지 않는다.
- 정적 검사와 타입 검사는 품질 린트다(디스크·네트워크·프로세스·전역을 부르는 코드를 이른 단계에서 걸러낸다). 경계가 아니다.
- 승인은 판 폴더 전체의 해시다(F5: shim이 불러오기 전에 새로 확인, 링크 거부). 고친 코드는 다시 승인해야 실린다.

프로세스 안에서 막을 수 **없는** 것(그래서 정직하게 적는다):
- 같은 프로세스의 JavaScript다. 이름을 숨긴 코드(문자열로 만든 이름, 원형 사슬)는 린트를 지나 전역(`fetch`, `process.env`, `Bun.file`)에 닿을 수 있고, 그러면 서비스의 환경 변수, `OWN_HOME`의 파일, 계정 토큰, 다른 플러그인이 쓰는 전역에 닿아 밖으로 보낼 수 있다.
- 서비스의 메모리와 CPU를 함께 쓴다. 무한 루프는 훅 시간 제한(2초)이 끊지 못한다(동기 코드는 이벤트 루프를 막는다).
- 진짜 경계가 필요한 도구는 C2(샌드박스)를 쓴다.

### 12.6 멈춤(crash) 격리

- shim이 훅을 감싼다. 훅이 던지거나, 2초를 넘기거나, 요청을 망가뜨리면: 그 사건은 플러그인이 없었던 것처럼 그대로 가고, 그 Location에서 플러그인이 꺼지고(이 인스턴스의 다음 훅은 아무것도 하지 않음), `creator\run\crashes.jsonl`에 `{id, directory, version, at, hook, message}`가 남고, 로그에 적힌다. 서비스는 멈추지 않는다.
- 다시 실려도(다른 판으로 돌았다 오거나 서비스가 다시 시작해도) 그 Location과 그 판의 기록이 있으면 싣지 않는다. 다른 판이나 다른 Location은 상관없다.
- 설정 > 확장이 `이 폴더에서 멈춤`으로 보여 주고(`View.crashes`, 기록 파일이 바뀌면 `changed` 이벤트), `다시 켜기`(`crashes.clear`)가 기록을 지우고 config 항목의 `restart`를 바꿔 그 플러그인만 다시 싣는다.
- 싣다가 실패해도(import 오류, `definePlugin`이 없음) 같은 기록이 남는다.

### 12.7 되돌리기와 저장소

C1과 같다(§4): 판마다 바뀌지 않는 폴더, 해시, 활성 판 이동. 승인한 판(`trusted`)은 판 정리(50개)에서 빠지지 않는다. 되돌린 판도 승인이 있어야 실린다.

## 13. 시험

| 시험 | 파일 | 보는 것 |
|---|---|---|
| 단위 | `packages/own-creator/test/unit/format.test.ts` | 스키마, 경로가 붙은 문제, 안전 검사, 효과, 종류와 코드 항목 |
| 단위 | `test/unit/store.test.ts` | 판 쓰기, 해시, 갱신, 되돌리기, 변조, 켜기·끄기, 충돌, 예약 이름, 범위, 승인, 지우기, 깨진 store.json, 동시 쓰기, 알림 |
| 단위 | `test/unit/apply.test.ts` | `when`, 범위, 조각 합치기와 한도, 규칙 세기, 승인 모드 읽기, 인자 검사, 따옴표, 명령 환경, 명령 템플릿, 승인 카드 |
| 단위 | `test/unit/code.test.ts` | 이른 린트(node import·process·Bun·전역 fetch·동적 import·`.tsx`·`.npmrc`/`.env`·범위 판·`@ts-*` 거절, 문자열·정규식·멤버 접근은 괜찮음, 의존성 허용 목록), 환경 허용 목록(호스트엔 TEMP 없음), 그리고 **샌드박스 울타리(경계)**: 진짜 샌드박스에서 `read_file`을 돌려 프로젝트는 읽고 `..`·절대 경로·보관함·`.ssh`·ADS는 거절 |
| 단위 | `test/unit/staging.test.ts` | 진짜 Bun·샌드박스로: C2 타입 검사·번들·샌드박스 시험·샌드박스 smoke 통과와 저장, 가짜 레지스트리에서 설치(설치 스크립트 안 돎), 타입 오류·시험 실패·smoke 실패는 판 없음. C3 타입 검사·e2e·golden 통과, 던지는 훅, system을 바꾸는 훅(`cache` 선언 없으면 실패), 순수하지 않은 훅, Node에 닿는 코드 |
| 단위 | `test/unit/compose.test.ts` | own 훅이 조이기만 함(어느 순서든): 확장 allow는 core의 ask만 풀고, own-accounts webAsk·GitHub·own-team 셸·own-creator 규칙처럼 이유 붙은 ask는 못 푼다(L1/L2); allow는 `github.*`·`image_generate` 못 가리킴 |
| 단위(own-runtime) | `packages/own-runtime/src/hash.ts` | `Hash.folder`가 `lstat`로 걷고 링크·reparse point가 있으면 `FolderLinkError`로 거부, 캐시 안 씀(F5) |
| e2e(가짜 모델) | `test/e2e/creator.test.ts` | §6, C0·C1 전부 |
| e2e(가짜 모델) | `test/e2e/code.test.ts` | C2: node:fs import는 묻기 전에 거절, 만들기(카드의 설치 줄·샌드박스 문구)·설치·단계 검사·활성화, Code Mode라 도구 목록 그대로, 묻기는 매번·거절하면 안 돎, 샌드박스에서 프로젝트 폴더만 읽고 보관함은 못 읽음, **읽기 전용은 확정된 판도 묻지 않고 거부(F4)**, 전체 허용은 판마다 한 번, 새 판 핫 리로드, 깨진 판은 앞 판 유지, 되돌리기, 멈추기·다시 시작·로그. C3: 스위치 꺼짐이면 거절, 켜면 단계 실패(던지는 훅, 타입 오류)는 판 없음, 통과한 판은 승인 대기, 승인하면 `plugins` 끝 항목과 폴더 해시 trust, 훅이 요청에 닿음, 서비스 안에서 던지면 그 Location에서 꺼지고 서비스는 계속, 되돌리기, 스위치 끄면 항목과 승인이 빠짐 |
| e2e(교차) | `test/e2e/cross.test.ts` | 확장이 다른 own 기능과 함께 동작(MR14, 변경 없음) |
| own-accounts | `packages/own-accounts/test/presets/readonly.test.ts` | 읽기 전용 역할이 모든 C2 도구(`creator-…`)를 거부, `creator` 쓰기 동작은 아님(F4) |
| e2e(캐시) | `test/e2e/cache.test.ts` | 열린 대화에서 조각과 Code Mode 도구는 도구 목록과 prefix 캐시를 지키고, 직접 도구는 깬다 |
| e2e(golden) | `test/e2e/golden-unchanged.test.ts` | 빈 저장소, 꺼진 확장, 다른 프로젝트의 확장에서 opencode·codex·pi·dsh의 첫 요청이 own-omo의 golden과 바이트까지 같음 |
| own-accounts | `packages/own-accounts/test/plugins/trust.test.ts` | creator 판 폴더는 폴더 해시로 승인(진입 파일 해시는 안 맞음, 도우미 파일이 바뀌면 다시 막힘), 다른 `extension.json` 폴더는 진입 파일 해시 그대로 |
| 런처 | `own/scripts/test/install.test.mjs` | creator 항목이 갱신 뒤에도 끝에 남고, `config init --force`가 끝으로 옮겨 줌 |
| 단위 | `test/unit/remote.test.ts` | §10: 호스트마다의 보기(호스트 선택, 호스트 폴더 범위, C3는 호스트 허용만, PC trust와 따로), 보기 밖 파일 거절, 미러(해시가 다른 파일 거절, 호스트 저장소 읽기 전용, 호스트에서 고친 사본은 다시 받음, 갱신·되돌리기·지우기 따라감, 쓸 수 없는 호스트 폴더는 넓히지 않음, C2 호스트 단계 검사 통과·실패, 호출 확인은 호스트의 것, 허용이 빠진 C3는 싣지 않음) |
| own-accounts | `packages/own-accounts/test/broker/server.test.ts` | 브로커의 `creator.get`·`creator.file`·`creator.report`(메모리), `creator.changed` 밀기(묶어서 한 번), 모르는 메서드는 세션 끝, drain은 `skew_drain` |
| e2e(가짜 SSH) | `test/e2e/remote.test.ts` | own-remote의 가짜 SSH와 진짜 원격 서버: 조각·규칙·명령 도구가 호스트 대화에(셸은 호스트), C2가 호스트 샌드박스 단계 검사 뒤 호스트 대화에서 물어 돈다(확인은 호스트에), 허용 없는 C3는 가지 않음, 호스트는 PC를 못 바꾼다(RPC 없음, `read_only`, 고친 사본은 다시 받음), 갱신·되돌리기가 따라감 |
| 실제 호스트 phase C | `packages/own-remote/test/real-host/c-creator.test.ts` | §10.7(작성만, 다음 릴리스 연쇄에서 돈다) |
| 묶음 | `packages/own-remote/script/bundle.test.ts` | own-creator 묶음 옆의 Bun·Node 타입, own의 WebAssembly 엔진(`quickjs/core`, `quickjs/variant`의 `.wasm`), own의 도우미가 글로 들어감. 원격 묶음의 own-creator와 QuickJS(빠지면 문제) |
| own-web 단위 | `packages/own-web/src/creator/creator.test.ts` | RPC 이름·범위 표, 기기의 쓰기 막힘, 이벤트, 글, lazy 청크 |
| Playwright | `packages/own-web/e2e/creator/` (`bun run test:e2e:creator`, 포트 6871) | 고급의 섹션, 카드, 판 파일, 켜기·끄기, 되돌리기, 범위, allow 승인, 지우기, MCP 서버의 멈추기·다시 시작·로그, 코드 플러그인 스위치와 위험 설명, 판 승인, 좁은 창 |

## 14. core 패치

없다(CRM-D8). C2·C3도 이미 있는 이음새만 쓴다: `ctx.mcp.transform`·`reload`, MCP 도구의 권한(`<server>_<tool>`), `permission.evaluate`, `tool.execute.after`, core의 로컬 플러그인 config 길과 호스트 모듈 공유, 세션 `context`·`compaction` 훅. 기대는 곳을 surface에 더했다: `creator-mcp-local-spawn`, `creator-mcp-local-cwd`, `creator-mcp-tool-permission`, `creator-plugin-host-modules`, `creator-plugin-server-entry`.

C2 샌드박스는 own-creator의 새 런타임 의존성 `quickjs-emscripten-core`와 `@jitl/quickjs-wasmfile-release-sync`(둘 다 MIT, 0.32.0 고정, 공식 패키지, npm integrity 확인)를 쓴다. 번들은 이 둘의 `dist`를 own-creator 옆 `quickjs/core`·`quickjs/variant`로 복사한다(`bundle.ts` `CREATOR_QUICKJS`). core 패치는 아니다.
