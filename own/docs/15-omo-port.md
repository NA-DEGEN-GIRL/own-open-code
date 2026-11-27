# 15. omo 이식 (own-omo)

| 항목 | 값 |
|---|---|
| 문서 상태 | v0.4 (2026-10-29). main(`2.0.32-own.8`, 팀 수정 RH-15…RH-40)과 합침. 팀 모드의 omo 대화(§3.10: 팀 대화에서는 omo의 남은 할 일 이어서 하기를 끔), 원격(SSH) 호스트 번들과 관리 설정(§1, §3.2), 실호스트 E단계의 bugfix(§8): OMP-31…. v0.3까지: MVP 구현과 시험 완료, 리뷰 반영(문맥 비우기, 사용자 메시지 이벤트, 재시작 복구, `.omo` 상태 위치, 모델 이름, edit 오류, `/resume-continuation`, 알림 기록: §3, §4, OMP-15…), 검증 반영(불러오기 전의 폴더 환경 변수, 카운트다운 중의 수동 압축, 실패한 압축, codex golden의 스킬 루트: OMP-25…), 브랜치 `omo-port`(main에 합치지 않음) |
| 목적 | oh-my-opencode(omo)를 흉내 내지 않고 omo 코드 그대로 OpenCode 2 위에서 돌린다. omo는 OpenCode 1 플러그인이므로, own이 OpenCode 1 플러그인 호스트를 만들어 omo에게 OpenCode 1의 클라이언트·이벤트·훅을 주고 그 결과를 OpenCode 2에 옮긴다 |
| omo 기준 | `code-yeongyu/oh-my-openagent` 태그 `v5.1.50`(태그 객체 `fc005a310a`, 커밋 `d4d2204e07`, 2026-10-28, SUL-1.0). 로컬 사본 `D:\#Projects\own-open-code\refs\oh-my-opencode`(읽기 전용, 경로의 `#` 때문에 그 안에서 빌드하지 않는다). 고정값은 `own/vendor/oh-my-opencode/pin.json`과 사본 `own/ledger/omo-pin.json` |
| 관련 문서 | 10(하네스 틀), 11(공통 압축), FORK.md §1·§7·§10, `own/vendor/oh-my-opencode/README.md`·`MODIFICATIONS.md`, 대체 브랜치 `omo-harness`의 `own/docs/14-omo-harness.md`(own이 새로 쓴 흉내 하네스, 합치지 않음) |

---

## 0. 결정 (2026-10-28, OP)

| 번호 | 결정 |
|---|---|
| OP-D1 | 하네스 id `omo`. 화면 이름 `omo (원본)`(영어 `omo (original)`), 짧은 이름 `omo`. 새 대화 기본값은 그대로 `codex`. 대체 브랜치 `omo-harness`는 합치지 않고 남기며, 되살리면 id를 바꾼다 |
| OP-D2 | 진짜 omo `v5.1.50`(`d4d2204e07`)을 SUL-1.0에 따라 개인 용도로 vendor한다 |
| OP-D3 | `packages/own-omo`가 OpenCode 1 플러그인 호스트다. 런타임은 프로세스마다 한 번 불러오고(지연), Location마다 처음 필요할 때 시작한다 |
| OP-D4 | 모델 정책 `inherit`: omo의 모든 에이전트와 카테고리는 부모 세션의 현재 모델로 돈다 |
| OP-D5 | MVP 범위는 §5 |
| OP-D6 | 코어 패치 없음. omo 소스 패치는 OMO-P1…P9 아홉 개(§4. OMO-P9는 2026-11-20 HPC-4) |
| OP-D7 | own 정책: 하위 세션을 지우지 않는다, 권한을 넓히지 않는다, 텔레메트리·자동 업데이트·프로세스 핸들러 없음, own 설정 폴더만 읽는다, 토스트는 로그로 |
| OP-D8 | 버전 갱신은 `omo-vendor.ts`와 `omo-patch.ts rebase`로 한다(§7). 자동 업데이트는 없다 |

---

## 1. 구조

```
own/vendor/oh-my-opencode/      SUL-1.0 원본 바이트(src/), source.json·pin.json, LICENSE.md·THIRD-PARTY-NOTICES.md,
                                MODIFICATIONS.md, patches/v5.1.50.json, README.md (FORK §1)
packages/own-omo/
  src/runtime-entry.ts          번들 진입점: omo에서 호스트가 부르는 것만 내보낸다(아래 표)
  src/omo-runtime.d.ts          그 형식 선언. 호스트는 이것으로만 타입을 맞춘다(vendor 소스는 tsc 밖)
  src/shim/                     @opencode-ai/plugin(tool()), SDK·posthog-node·sharp 스텁, posthog 모듈, signal-exit
  script/resolve.ts             번들과 vendor 닫힘 계산이 같이 쓰는 모듈 해석기
  script/bundle.ts              패치 적용 → omo-runtime.js (§2)
  script/patch.ts               패치 매니페스트 만들기·적용·rebase
  src/index.ts                  플러그인 own.omo: 가드, 훅·이벤트 펌프·todo 도구 등록, 종료 처리
  src/runtime.ts                런타임 불러오기, Location별 시작, omo 시작 단계 교체
  src/config.ts                 own의 omo 설정과 사용자 설정 병합(§3.8)
  src/host/                     names, view, events, client, overlay, todo, tools, agents, commands, hooks, session
own/scripts/omo-vendor.ts       고정 태그에서 닫힘을 계산해 vendor (§7)
own/scripts/omo-patch.ts        make / apply / rebase
```

런타임 진입점이 내보내는 것: `createPluginModule`, `createManagers`, `setVersionCache`, `setMainSession`, `getSessionAgent`, `setLogFile`(두 omo 로거를 같은 파일로, 10 MB), `AGENT_DISPLAY_NAMES`, `getAgentConfigKey`, `getAgentToolRestrictions`, `OhMyOpenCodeConfigSchema`, `HookNameSchema`, `OMO_INTERNAL_INITIATOR_MARKER`, `z`(omo가 도구 인자를 만든 zod 사본), `version`.

산출물:

- 릴리스: `app\<ver>\plugins\own-omo\{index.js, omo-runtime.js, LICENSE.md, THIRD-PARTY-NOTICES.md, MODIFICATIONS.md, skills\}`. own-remote `bundle.ts`의 `DESKTOP_PLUGINS`에서 own-harness 다음(맨 뒤)이고, 그 단계가 `script/bundle.ts`도 같은 폴더로 돌린다. `build-desktop.ps1`은 런타임과 세 고지 파일이 있는지 보고 `plugins/own-omo/omo-runtime.js`의 해시를 manifest에 적는다. own-omo 번들은 가드 경고(`guard_failed`)에 빌드 id를 적어, 다른 own 플러그인처럼 `bundle.ts plugins`의 define 검사(빌드 id 글자)를 지난다(2026-10-29 전에는 쓰지 않는 빌드 id가 번들에서 빠져 릴리스의 플러그인 단계가 own-omo에서 실패했다, OMP-35).
- 원격(SSH) 호스트(2026-10-29, OMP-34): 원격 번들(`REMOTE_PLUGINS`)에도 맨 뒤에 싣는다. 대상(`linux-x64-baseline`, `linux-arm64`)마다 압축 파일에 `plugins/own-omo/{index.js, omo-runtime.js, LICENSE.md, THIRD-PARTY-NOTICES.md, MODIFICATIONS.md, skills/…/SKILL.md}`가 들어가고(런타임은 JS라 대상과 무관), 셋 중 하나라도 없으면 `packageTargets`가 묶지 않으며 `inspectRemote`(release-smoke)는 그런 압축 파일을 `own-omo without <파일>`로 알린다. 원격 관리 설정(04 §5.6)의 6번이 `{package: <OWN_HOME>/app/current/plugins/own-omo, options: {home: <OWN_HOME>}}`라 omo의 폴더와 기록이 그 설치의 OWN_HOME 아래다(§3.2). `build-remote.ps1`의 플러그인 단계가 런타임도 만든다.
- 소스 실행과 시험: `own/.out/omo`(번들 스크립트의 기본 출력), 또는 `OWN_OMO_RUNTIME`.
- own-accounts의 신뢰 목록(`plugins/inventory.ts` `OWN_PACKAGES`)에 `own-omo`를 더했다. launcher의 관리 목록(`own.ps1` `$ManagedPlugins`)에서 own-omo는 own-harness 다음, 맨 뒤다. 새로 설치하면 설정에 그 줄이 들어가고, own-omo가 없던 버전에서 업데이트하면 own-harness 줄 다음에 한 줄을 더한다(사용자가 지운 줄은 다시 넣지 않는다). `own status --json`의 `plugins`에 `own.omo`가 있다.

---

## 2. 빌드

`bun packages/own-omo/script/bundle.ts [--out <dir>] [--dev]`:

1. `src/`의 모든 파일을 `source.json` 해시로 확인하고 `packages/own-omo/.omo-stage/`(gitignore)에 둔다. npm import는 own-omo의 node_modules에서 풀린다(zod 4.6.5, jsonc-parser 3.3.1, @modelcontextprotocol/sdk 1.32.1, js-yaml 5.4.2, picomatch 4.0.7, proper-lockfile 4.1.2, picocolors 1.1.1, diff 9.0.0: omo의 lock과 같은 판).
2. `patches/v5.1.50.json`을 적용한다(`preSha256` → 각 `find`가 정확히 한 번 → `postSha256`).
3. `Bun.build`(target bun, ESM, minify, `.md`는 text)로 한 파일. 해석 규칙(`script/resolve.ts`): `@omo/*`는 omo-opencode/src, `@omo-root/*`는 vendor 루트, `@oh-my-opencode/<pkg>`는 그 package.json의 `exports`, `#name`은 가져오는 패키지의 `imports`. 바꿔 끼우는 것: `@opencode-ai/plugin`(own의 `tool()`과 `tool.schema = z`), `@opencode-ai/sdk`·`posthog-node`·`sharp`(쓰면 던지는 스텁), omo의 `shared/posthog.ts`(빈 `recordPluginTelemetry`, 그래서 PostHog 클라이언트·키·호스트가 번들에 없다), `signal-exit`(proper-lockfile이 불러오면 모든 신호에 리스너를 달기 때문, 빈 함수).
4. 첫 줄 `// @bun` 다음 줄에 `// oh-my-opencode v5.1.50 (SUL-1.0), modified by own-open-code: see MODIFICATIONS.md`. 출력 폴더에 세 고지 파일과 `skills\`(omo의 내장 스킬 여섯이 불러올 때 읽는 SKILL.md)를 둔다.
5. 배너가 없거나, 출력에 `posthog.com`이 있거나, 6 MB를 넘으면 실패한다. 지금 약 **3.81 MB**(3,811,559바이트). 같은 소스라도 빌드마다 축약된 이름이 달라 바이트가 조금 다르다(Bun이 비동기 해석 플러그인과 함께 모듈 순서를 바꾼다). 그래서 릴리스 manifest는 실제로 실은 파일의 해시를 적는다.

`--dev`는 축약 없이 인라인 source map을 붙인다(디버깅용, 릴리스 입력이 아님).

---

## 3. 호스트

### 3.1 이름

| OpenCode 2 | omo가 보는 이름(OpenCode 1) |
|---|---|
| 에이전트 `build` | `Sisyphus - ultraworker` |
| `omo-explore`, `omo-librarian`, `omo-oracle`, `omo-sisyphus-junior` | `explore`, `librarian`, `oracle`, `Sisyphus-Junior` |
| core 에이전트 `explore` | `explore (core)`(omo의 explore와 겹치지 않게) |
| 그 밖의 에이전트 | 같은 이름 |
| 도구 `shell {command, workdir, timeout(ms)}` | `bash {command, workdir, timeout}` |
| `read`·`write`·`edit`의 `path` | `filePath` |
| `patch {patchText}` | `apply_patch {patchText}` |
| `omo_<x>`(등록 이름) | `<x>`(요청에 보이는 이름과 omo가 보는 이름) |
| grep, glob, webfetch, question, skill | 같음 |

omo의 표시 이름이나 설정 키(대소문자 무관)로 부르면 위 표로 되돌린다(`Names.agents.toV2`). 모델에게는 core 도구를 OpenCode 2 이름과 입력으로 보낸다(`opencode` 하네스와 같음). omo의 훅만 OpenCode 1 이름과 입력을 본다.

### 3.2 런타임 불러오기와 시작

- **프로세스마다 한 번**: 환경 변수 `OMO_OWN_HOST=1`, `OMO_OWN_DATA_HOME`·`OMO_OWN_CACHE_HOME`(`<OWN_HOME>\thirdparty\omo\{data,cache}`), `OMO_OWN_STATE_HOME`(`<OWN_HOME>\thirdparty\omo\projects`, OMO-P6), `OMO_OWN_PROJECT_SKILLS`(서비스가 프로젝트 config를 읽으면 `1`, 아니면 `0`. OMO-P9), `OMO_OWN_CONFIG_DIR`(`OPENCODE_CONFIG_DIR`, 없으면 `<OWN_HOME>\thirdparty\omo\config`)을 먼저 두고 `globalThis[Symbol.for("own.omo.runtime")] ??= import(runtimeURL)`. omo는 불러오는 동안 몇 폴더를 정한다(agent-usage-reminder가 쓰는 `OPENCODE_STORAGE`, 업데이트 확인이 `mkdir`하는 `CACHE_ROOT_DIR`). 변수를 불러온 뒤에 두면 그 둘은 OpenCode 1의 `<XDG_DATA_HOME 또는 ~\.local\share>\opencode\storage`와 `~\.cache`가 된다(진짜 OpenCode 1·omo 설치와 같은 폴더이고 지워도 남는다). OpenCode 1처럼 모듈 하나, Location마다 `server()` 하나.
- **Location마다 처음 필요할 때**: omo 세션의 `prompt` 훅, omo 세션의 `session.created`, `omo`로 묶이는 `session.metadata.updated`. 요청 훅도 시작을 기다린다.
- 시작 순서: 런타임 불러오기(위 환경 변수가 먼저) → `setVersionCache("1.18.31")` → 로그 `<OWN_HOME>\thirdparty\omo\logs\omo.log` → `createPluginModule(교체).server(v1Input)` → `hooks.config(설정)` → 에이전트·도구·명령 등록.
- 교체하는 시작 단계(`createPluginModule` 주입): 정렬 shim, 정렬 순서, 레거시 경고, 작업 폴더 이전, 시작 이전 작업(빈 결과), 프로세스 정리(`Promise.resolve()`), 중복 플러그인·스킬 플러그인 탐지(없음), 서버 인증 주입, live 서버 경로, 텔레메트리, OpenClaw, tmux(꺼짐), 설정 읽기(own 설정을 그대로). `createManagers`에는 프로세스 정리 등록과 서버 표시를 빈 함수로 준다.
- **재시작 복구**: core는 재개한 실행의 도구를 drain이 시작할 때 고르고(`SessionContext.select`의 도구 snapshot), 그때는 own-omo의 어떤 훅도 아직 돌지 않았다. 그래서 own-omo는 이 Location의 최상위 omo 세션이 도는 동안(`session.execution.started`부터 끝날 때까지, 종료 `shutdown`과 프로세스 죽음은 남김) 플러그인 저장소에 `omo/busy/<Location 해시>/<세션>` 표시를 둔다(core의 실행 claim과 같은 수명, core가 최상위 세션만 재개하므로 하위 세션은 적지 않는다). 플러그인이 시작할 때 표시가 있으면 지우고, 그중 아직 omo 세션이 있으면 플러그인 활성화 안에서 omo를 시작하고 기다린다. 모든 drain은 플러그인 활성화를 기다리므로(`plugins.awaitActivation`) 재개한 실행의 첫 요청부터 omo 도구가 있다. 재개한 실행은 다시 표시한다. 표시가 없으면 시작은 예전처럼 처음 필요할 때다.

### 3.3 V1View: OpenCode 2 기록 → OpenCode 1 메시지

- user → `{role: user, agent, model}`. agent와 model은 세션의 현재 값에서 `agent-switched`·`model-switched`를 거슬러 접어서 그 시점의 값. 글은 저장된 사용자 글에 omo가 덧붙인 글(`metadata["own.omo"].append`)을 붙인 것, 파일은 file 부분. 세션의 overlay `tools`를 `tools`로.
- synthetic(과 skill) → `synthetic: true` 글 부분의 user.
- assistant → `{role: assistant, agent, providerID, modelID, finish, error, tokens, cost, time}`, 부분은 text, reasoning, tool `{callID, tool: v1이름, state}`(streaming → pending, running, completed(`output`은 글 내용), error). 중단된 단계(`aborted`)는 `MessageAbortedError`, 그 밖의 오류는 `APIError`.
- 끝난 압축 → `{agent: "compaction"}` user(`compaction` 부분)와 `{summary: true}` assistant(요약 글). 문맥 비우기(core P-035, `reason: "reset"`)도 같은 쌍이고 요약 글 부분만 없다. 그래서 비운 뒤 omo의 `latestMessageWasCompaction`이 참이라 비운 문맥에 이어서 하기를 넣지 않는다. 되돌린 비우기(`undone`)는 아무 경계도 아니라 뺀다.
- 실패한 압축(`failed`) → 같은 쌍이고, 요약 assistant에 `finish` 대신 오류(`APIError`, 중단이면 `MessageAbortedError`)가 있고 글 부분이 없다. OpenCode 1도 실패한 압축의 요약 메시지를 오류와 함께 남겼다. 실패한 수동 압축의 drain은 성공으로 끝나므로, 이 쌍이 없으면 다음 idle에 omo가 그 앞의 assistant를 마지막 메시지로 보고 이어서 할 수 있었다. 도는 중인 압축(`running`)은 뺀다.
- idle, system, shell, 전환 표시는 뺀다. 메시지 id는 그대로(오름차순이라 omo의 id 비교가 맞는다), 부분 id는 `prt_<메시지>_<n>`. `limit`은 마지막 n개.

### 3.4 클라이언트·이벤트·훅

**클라이언트**(`host/client.ts`, 결과는 `{data, error, response}`, `throwOnError`면 던짐):

| 메서드 | own |
|---|---|
| `session.create` | 부모가 있으면 **미루어 만든다**: id만 정해 두고 첫 `promptAsync` 때 `ctx.session.create({id, parentID, title, agent, model: 부모 모델, permissions: 부모 규칙 + omo의 deny·ask})`. 부모 없는 생성은 바로 만든다 |
| `session.get`, `messages`, `message` | 미룬 세션은 omo가 준 값과 빈 기록. 나머지는 `ctx.session.get`/`context` + V1View |
| `session.promptAsync` | 위의 생성, 이미 만든 하위 세션은 에이전트가 다르면 `switchAgent`, `body.system`·`body.tools`는 overlay, 글 부분이 모두 synthetic이거나 내부 표시(`<!-- OMO_INTERNAL_INITIATOR -->`)면 `ctx.session.synthetic({background: true, resume: !noReply, metadata: {source: "own.omo"}, description})`, 아니면 `ctx.session.prompt`. `body.model`·`variant`는 쓰지 않는다. 최상위 세션의 에이전트와 모델은 바꾸지 않는다 |
| `session.prompt` | 위 + `ctx.session.wait` + 마지막 assistant |
| `session.status` | 이벤트로 아는 바쁜 세션(OpenCode 1처럼 busy만) |
| `session.abort`, `summarize` | `interrupt`, `compact` |
| `session.delete` | **아무것도 하지 않는다**(사용자가 하위 대화를 볼 수 있게) |
| `session.todo` | 호스트 todo(§3.6) |
| `session.children`, `list` | 이벤트로 아는 하위 세션 |
| `tui.showToast` | own 기록 `<OWN_HOME>\logs\own-omo.log`에 `info` 한 줄(`omo notice`, 제목·글·종류). 10 MB를 넘으면 `.1`로 옮긴다. 없는 스킬 폴더(`ENOENT`)의 `Skill load error`는 omo가 시작할 때마다 폴더마다 내는 알림이라 적지 않는다(omo 기록에는 omo의 `[skill-load]` 줄이 남는다) |
| `app.agents` | omo 설정 결과의 에이전트(OpenCode 1이 보던 대로, 숨김 아님) + OpenCode 2의 나머지 에이전트(v1 이름) |
| `app.skills` | 빈 목록 |
| `provider.list`, `config.get` | own의 모델 목록, 기본 모델 |

synthetic 메시지의 설명: TODO CONTINUATION은 `omo: 남은 할 일을 이어서 해요`, 배경 작업 알림은 `omo: 배경 작업이 끝났어요`, 그 밖은 `omo 알림`.

**이벤트**(`host/events.ts`): OpenCode 2 이벤트 중 이 Location의 omo 세션 것만 OpenCode 1 이벤트로 바꿔 세션마다 차례대로 `hooks.event`에 넘긴다.

| OpenCode 2 | OpenCode 1 |
|---|---|
| `session.created` | `session.created {info}`(하위 세션 기억) |
| `session.deleted` | `session.deleted`(overlay·todo 지움) |
| `session.execution.started` | `session.status {busy}` |
| `succeeded` / `failed` / `interrupted` | (`session.error`) + `session.status {idle}` + `session.idle`. 중단은 `MessageAbortedError`, 종료(shutdown)는 넘기지 않는다 |
| `session.step.started` / `ended` / `failed` | `message.updated`(assistant, finish·토큰·오류) |
| `session.tool.called` / `success` / `failed` | `message.part.updated`(tool running·completed·error, v1 이름) |
| `session.text.ended` | `message.part.updated`(text) |
| `session.compaction.ended` | `session.compacted` |
| `session.inbox.enqueued` / `cancelled` | 없음(사용자·synthetic 항목, 수동 압축, 문맥 비우기를 전달될 때까지 기억) |
| `session.inbox.delivered`(사용자·synthetic) | `message.updated`(user, 세션의 지금 에이전트·모델) + 글 부분마다 `message.part.updated`(사용자 글에 omo의 append, synthetic 항목과 append의 부분은 `synthetic: true`). omo의 내부 프롬프트는 synthetic 항목이다(client) |
| `session.inbox.delivered`(수동 압축) | OpenCode 1의 압축 사용자 메시지: `message.updated`(user `compaction`), `message.part.updated`(`compaction` 부분). OpenCode 1처럼 omo의 이어서 하기 카운트다운(2초)을 끝낸다. 이것이 없으면 카운트다운 안에 끝난 압축 뒤에 TODO CONTINUATION이 갔다. 압축의 끝은 `session.compacted`, 쌍은 V1View(§3.3) |
| `session.inbox.delivered`(문맥 비우기) | 압축 쌍: `message.updated`(user `compaction`), `message.part.updated`(`compaction` 부분), `message.updated`(요약 assistant). `session.compacted`는 보내지 않는다 |
| 호스트 `todowrite` | `todo.updated` |

**훅**(`host/hooks.ts`, 모두 omo 세션에서만):

- `prompt` → `chat.message`: 입력 `{sessionID, agent, model, messageID}`, 출력 `{message, parts: [사용자 글]}`. 최상위 세션이면 `setMainSession`. 저장된 사용자 글은 그대로 두고, omo가 그 글 뒤에 붙인 것(ultrawork 블록)과 새로 더한 글 부분을 `metadata["own.omo"].append`에 둔다. 메시지의 agent·model·variant 변경은 쓰지 않고 로그만 남긴다.
- `context`·`compaction`·`generate`(같은 변환, 압축 요청이 같은 캐시를 읽게): own-accounts의 `own.preset` 항목을 뺀다(기준선의 블록과 기록의 바뀜·없어짐 알림. 안내문이 omo에 없는 core `subagent`를 말한다, 07 §3.3, 2026-11-07) → `build`면 system[0]을 Sisyphus 지시문으로 → omo의 `experimental.chat.system.transform`(Sisyphus 본문을 실제 모델에 맞게 다시 만듦) → 각 사용자 메시지에 그 메시지의 append(내구 메타데이터에서, 결정적) → 도구 `omo_<x>`를 `<x>`로(정의 객체는 그대로라 core가 등록 도구로 되돌림), core `subagent` 제거, 에이전트 제한(explore 등의 write·edit·task·call_omo_agent)과 overlay가 끈 도구 제거, 남은 도구마다 `tool.definition`(omo의 todowrite 설명 교체) → overlay `system`을 마지막 시스템 조각으로.
- 도구 `execute.before` → `tool.execute.before`(v1 이름과 입력, 바뀐 인자는 v2 입력으로, 던지면 `Tool.Error`), `execute.after` → `tool.execute.after`(글과 메타데이터를 바꾸면 반영, 메타데이터는 JSON으로).
- 도구 `execute.after`의 실패: OpenCode 1은 실패한 도구에 after 훅을 돌리지 않았다. 다만 omo의 edit-error-recovery가 아는 `edit` 실패 셋은 OpenCode 2 글을 OpenCode 1 글로 바꿔 `tool.execute.after`의 출력으로 준다(`No changes to apply: oldString and newString are identical` → `oldString and newString must be different`, `Could not find oldString in` → `oldString not found in content`, `Found N matches for oldString` → `oldString found multiple times and requires more code context to uniquely identify the intended match`). omo가 그 글 뒤에 붙인 것(복구 안내)은 모델이 받는 오류 글 뒤에 붙는다. 다른 실패와 다른 도구는 넘기지 않는다(그 훅을 돌리는 다른 켠 훅은 `task`만 보거나 검색 도구만 센다).
- 명령: `/stop-continuation`(omo 설명)과 own의 `/resume-continuation`(설명 `/stop-continuation으로 멈춘 omo의 남은 할 일 이어서 하기를 다시 켜요`). omo 세션이 아니면 둘 다 `omo (원본) 세션에서만 써요.`로 실패한다. omo 세션의 `/stop-continuation`은 `command.execute.before`를 돌리고 템플릿(`$ARGUMENTS`)을 프롬프트로 보낸다. `/resume-continuation`은 같은 훅만 돌리고(OMO-P8이 멈춤을 지운다) 프롬프트를 보내지 않는다. 세션이 쉬는 중이면 omo에게 `session.idle`을 한 번 더 주어, 남은 할 일이 있으면 omo가 바로 이어서 한다(카운트다운 2초 뒤). 도는 중이면 그 턴이 끝날 때부터 이어서 한다. OpenCode 1의 omo는 멈춤을 `/ulw-execute`(own에서 끔)나 세션 삭제로만 풀었고, 멈춤 표시의 주석이 말하는 `/resume-continuation`은 아직 없었다. 팀 대화(§3.10)에서는 `/resume-continuation`이 아무것도 하지 않고 `팀 대화에서는 omo가 남은 할 일을 이어서 하지 않아요. 다음 일은 팀 메인과 팀 소식이 정해요.`로 실패한다.
- 압축은 own-harness의 P-025/P-034 지시문을 그대로 쓴다. own-omo는 위 변환만 더한다.
- 플러그인이 닫히면 `hooks.dispose()`.

### 3.5 도구

- MVP로 잇는 omo 도구: `task`, `background_output`, `background_cancel`, `call_omo_agent`(`omo_*`로 등록, `{permission: "own_harness_omo", codemode: false}`). omo가 만드는 다른 도구는 등록하지 않는다.
- 입력 스키마: 인자마다 omo가 붙인 JSON Schema 대체(`normalizeToolArgSchemas`)나 zod 변환, `undefined`를 받지 않는 인자는 required. 객체 전체를 zod로 바꾸면 zod 4.6에서 그 대체 때문에 실패한다.
- 실행: zod `safeParse`(실패는 `Tool.Error`) → `Effect.tryPromise(signal => execute(args, v1ctx))`(중단하면 signal이 끊긴다). v1ctx의 `metadata()`는 진행 표시(`sessionId`를 `sessionID`로), `ask()`는 `ctx.permission.assert`. 결과가 글이면 그대로, 객체면 `output`과 `{...metadata, title}`, 보고된 하위 세션은 결과 메타데이터 `sessionID`로. 메타데이터는 JSON으로 줄인다(`undefined` 필드 하나가 core 기록을 막아 호출이 결과 없이 남았다).

### 3.6 todo

- 도구 `omo_todowrite`(요청 이름 `todowrite`), 입력 `{todos: [{id?, content, status: pending|in_progress|completed|cancelled, priority: high|medium|low}]}`. 설명은 OpenCode 1의 `todowrite.txt`(7feefb697f^, MIT). omo의 `todo-description-override`가 `tool.definition`으로 바꾼다.
- 저장 `ctx.storage` `omo/todo/<sid>`, 바꾸면 `todo.updated`. 결과 제목 `<남은 수> todos`, 내용은 JSON.
- runtime 없이 설정 단계에서 등록한다. own-harness는 이 Location에 `own_harness_omo` 도구가 있으면 own-omo가 돈다고 보고 `omo`를 내놓는다(§3.7).

### 3.7 하네스 선택 (own-harness, own-protocol)

- own-protocol `IDS`에 `omo`. `CUSTOM_HARNESSES`가 아니다(지시문 고르기 없음). 모르는 옛 빌드는 `bound()`가 undefined라 `opencode`로 돈다.
- own-harness `Gate`: `own_harness_omo` deny를 모든 에이전트에, allow는 omo 세션의 규칙에만(하위 세션이 물려받음). `Registry.omo` = opencode의 도구 형식, 전환 알림이 이름 대는 도구 `todowrite, task, background_output, background_cancel, call_omo_agent`. omo 세션의 요청 기록은 opencode처럼 번역한다.
- RPC `list`는 이 Location에 `own_harness_omo` 권한의 도구가 등록돼 있을 때만 `omo`를 넣고, `session.set`·`defaults.set`은 그렇지 않으면 `harness_unavailable`로 거절한다. own-omo가 없는 서비스에서 이미 `omo`로 묶인 세션은 `opencode`와 똑같이 돈다.
- 다른 하네스는 바뀌지 않는다: omo 도구는 gate, omo 에이전트는 숨김, 모든 훅은 omo 세션·같은 Location이 아니면 바로 돌아간다(세션별로 캐시, `session.metadata.updated`·`session.deleted`에 지움). omo의 `default_agent`와 전역 `permission`은 쓰지 않는다.

### 3.8 own의 omo 설정

- 전역: `telemetry: false`, `auto_update: false`, `model_fallback: false`, `runtime_fallback: false`, `hashline_edit: false`, `new_task_system_enabled: false`. 끈 기능: team_mode, tmux, monitor, goal, `tui.sidebar`. `claude_code` 전부 false. `disabled_mcps`: websearch, context7, grep_app, lsp.
- `disabled_agents`: hephaestus, prometheus, atlas, metis, momus, multimodal-looker, athena, athena-junior, council-member. `disabled_commands`: stop-continuation 말고 전부. `disabled_tools`: grep, glob, session_*, look_at, skill, skill_mcp, interactive_bash. `disabled_skills`: 내장 스킬 열둘. `keyword_detector.disabled_keywords`: team, hyperplan, hyperplan-ultrawork.
- `disabled_hooks`: omo가 아는 훅(57개) 중 MVP 열둘(§5)을 뺀 전부. 버전을 올려 새 훅이 생겨도 검토 전에는 꺼진다.
- 모델: `agents.{sisyphus, explore, librarian, oracle, sisyphus-junior}.model`과 카테고리 열 개의 `model` = 시작할 때의 own 기본 모델.
- 플러그인 옵션 `config`를 그 위에 깊이 합친다. 위 정책 키와 모델은 다시 own 값으로 둔다. omo의 `OhMyOpenCodeConfigSchema`로 확인하고 맞지 않으면 시작하지 않는다.
- 옵션: `enabled`(기본 true, false면 아무것도 등록하지 않고 `omo`도 사라짐), `models.policy`(`inherit`만 구현, `configured`는 받기만 함), `config`, `home`(2026-10-29: §3.2의 `<OWN_HOME>`. 없으면 `OWN_HOME`이나 그 기본값. 원격 관리 설정이 그 설치의 것을 준다, §1).

### 3.9 에이전트

- 설정 훅의 결과 `config.agent`에서 explore, librarian, oracle, sisyphus-junior를 `omo-<key>`로 등록한다: 이름 = omo 표시 이름, `system` = omo 지시문, 설명, 색, `mode: subagent`, `hidden: true`. 권한 = Agent 기본값 + 다른 하네스 gate의 deny + omo가 write·edit를 끈 에이전트는 `edit` deny.
- Sisyphus는 등록하지 않는다: omo 세션의 `build`가 Sisyphus다(system[0] 교체). `plan`은 core plan(omo는 plan의 이어서 하기를 건너뜀).

### 3.10 팀 모드 (2026-10-29, OMP-32)

own.team(06)의 팀 메인·담당·동료도 `omo`로 돌 수 있다(헤더 알약이나 own.harness `session.set`, own.team이 대신 만드는 대화는 이어받음, 06 §6.2). 이것은 own의 팀 모드이고, omo 자체의 team mode는 계속 끈다(§3.8).

- **팀 대화**: 부모가 없고 metadata `own.team`이 있는 세션(own.team이 만든 메인·담당·동료, 하위 세션은 metadata를 복사해도 아님), 또는 이 프로세스에서 own.team의 입력(`source: "own.team"`인 사용자·synthetic 항목: 메인 요청, 영역 메시지, 팀 소식, 인계 요청)을 받은 세션(받아들인 담당은 자기 metadata를 지킨다). `OmoSessions.Cache.isTeam`: metadata 판정은 metadata가 바뀌면 다시 읽고, 받은 입력은 세션이 지워질 때까지 남는다. 받아들인 담당은 서비스를 다시 켠 뒤 다음 팀 입력까지 팀 대화로 보이지 않는다.
- **이어서 하기를 끈다**: 호스트가 omo의 `createHooks`(시작 단계 주입, 런타임 진입점이 내보냄)를 감싸 todo-continuation-enforcer의 `handler`가 팀 대화의 `session.idle`을 받지 않게 한다(`Runtime.outsideTeams`). 그 밖의 사건, 그 밖의 훅과 세션은 그대로다. omo 소스 패치는 없다. 팀 대화의 `/resume-continuation`은 §3.4의 글로 실패한다.
- **이유**: 팀 대화가 언제 도는지는 own.team이 정한다(메인 요청, 팀 소식의 깨우기, 안전 지점, 인계 턴, 멈춤). omo의 이어서 하기는 그와 따로 깨워서 (1) 인계 턴을 마친 옛 담당이 쉬는 즉시(2초 뒤) 남은 할 일을 다시 시작해 새 담당과 같은 폴더에서 일하고, (2) 멈춘 영역이 혼자 돌며, (3) 메인은 팀 소식 사이에 영역에 맡긴 일을 스스로 하거나 상태를 되물었다. 팀의 깨우기와 겹치면 같은 결과로 두 번 돈다.
- **그대로인 것**: Sisyphus 지시문(system[0])과 그 뒤의 팀 역할 지시(system[1]의 지시문 항목), ultrawork, `task`와 배경 작업, 배경 작업이 다 끝났다는 깨우기(`resume: true`, 그 대화가 맡긴 일이라 팀의 일로 센다). omo가 깨우지 않고 넣는 알림(`noReply`, `resume: false`)은 own.harness의 바꿈 알림처럼 넣은 지 10초가 지나면 안전 지점이 일로 세지 않고(06 §8.4, RH-17), `SafePoint.work`도 아니라 교체의 인계를 막지 않는다.
- **알려진 한계**: 팀 모드를 꺼도 그 대화들은 metadata `own.team`이 남아 이어서 하기가 돌지 않는다(own-accounts의 유휴 압축도 같은 표시로 팀 대화를 건너뛴다).

---

### 3.11 Claude Agent에서 (2026-10-31, 10 §3.12)

- omo 대화가 `claude-agent`면 own-omo의 `transform` 끝에서 마지막 system(Sisyphus, omo의 system 변환, overlay)을 `claudeCodeAgent`에, 빈 글을 `claudeCodeInstructions`에 넣는다. Claude에는 Claude Code preset 뒤에 간다.
- 이 system에는 core의 `# Your Model` 블록과 날짜·환경도 남는다(프로바이더가 빼던 것). overlay로 도구 목록이 바뀌면 claude가 다시 뜬다.

## 4. 패치 (`own/vendor/oh-my-opencode/patches/v5.1.50.json`, MODIFICATIONS.md)

| Id | 파일 | 바꾼 것 | 이유 |
|---|---|---|---|
| OMO-P1 | `omo-opencode/src/shared/opencode-storage-detection.ts` | `OMO_OWN_HOST=1`이면 `isSqliteBackend()`가 true | 아니면 omo가 `~/.local/share/opencode/storage`의 v1 JSON 메시지 파일을 읽고 **쓴다**. true면 모든 메시지 경로가 클라이언트(호스트)로 간다 |
| OMO-P2 | `utils/src/xdg-data-dir.ts`(`OMO_OWN_DATA_HOME` 우선), `omo-opencode/src/shared/data-path.ts`(`OMO_OWN_CACHE_HOME` 우선) | 데이터·캐시를 `<OWN_HOME>\thirdparty\omo` 아래로 | 진짜 OpenCode·omo 설치와 `~/.cache`에서 떼어 둔다. omo가 불러오는 동안 정하는 폴더(`OPENCODE_STORAGE` 등)가 있어 호스트는 변수를 런타임을 불러오기 전에 둔다(§3.2) |
| OMO-P3 | `omo-opencode/src/features/background-agent/process-cleanup.ts` | `OMO_OWN_HOST=1`이면 정리 핸들러를 등록하지 않는다 | SIGINT·SIGTERM·SIGBREAK·exit 핸들러(6초 안에 `process.exit`)와 uncaughtException·unhandledRejection 리스너가 own 서비스에 생기지 않는다. 종료는 `dispose`가 한다 |
| OMO-P4 | 세 `opencode-config-dir.ts`(omo-opencode, skills-loader-core, claude-code-compat-core)의 `getCliDefaultConfigDir` | `OMO_OWN_HOST=1`이고 `OMO_OWN_CONFIG_DIR`이 있으면 그 폴더 | 아니면 사용자의 진짜 `~/.config/opencode`에서 omo 설정·스킬·명령을 읽는다(계획 문서의 `getOpenCodeConfigDirs` 대신 기본 폴더 자체를 바꿔 단수 `getOpenCodeConfigDir`도 덮는다) |
| OMO-P5 | `omo-opencode/src/plugin/tool-registry-core-tools.ts` | `OMO_OWN_HOST=1`이면 `task`의 `loadCurrentModelConfig`가 없다 | omo는 `task`를 부를 때마다 설정 파일을 다시 읽는다(`loadPluginConfig` 직접 import라 시작 단계 교체가 닿지 않는다). 그러면 own 설정의 카테고리 모델이 빠져 `deep-low`처럼 omo가 자기 모델(gpt-6.1-sol 등)을 요구하는 카테고리가 거절됐다(실계정 시험 2). 없으면 omo는 시작할 때 받은 설정을 쓴다 |
| OMO-P6 | `omo-opencode/src/features/run-continuation-state/storage.ts` | `OMO_OWN_HOST=1`이고 `OMO_OWN_STATE_HOME`이 있으면 이어서 하기 표시를 `<OMO_OWN_STATE_HOME>\<프로젝트 폴더 이름>-<프로젝트 경로 sha256 앞 12자>\run-continuation\<세션>.json`에 둔다 | 원본은 프로젝트의 `.omo\run-continuation\`에 쓴다. omo의 내부 실행 상태라 사용자가 볼 것이 아니고, 프로젝트 폴더에 도구 흔적을 남기지 않는다(사용자 결정). 사용자에게 보이는 계획 파일(`.sisyphus` 등, OpenCode 1에서도 프로젝트에 둠)은 옮기지 않는다. MVP에서 켠 기능 중 프로젝트에 쓰는 것은 이것뿐이다(boulder 상태 `.omo\boulder.json`은 끈 ulw-execute·atlas만 쓰고, `/stop-continuation`의 `clearBoulderState`는 지우기만 한다) |
| OMO-P7 | `omo-opencode/src/tools/delegate-task/tools.ts` | `OMO_OWN_HOST=1`이고 부모 모델을 알면 `task`의 모델(`categoryModel`, 카테고리와 `subagent_type` 둘 다)이 부모의 모델이다 | own은 하위 세션을 늘 부모 모델로 만든다(정책 `inherit`). 원본은 카테고리에 적힌 모델(own 기본 모델)로 하위 지시문을 만들고 결과 글에 `Model routing: parent used …, this subagent used …`을 적어, 실제와 다른 모델을 말했다. 이제 결과는 `Model: <부모 모델> (category: …)`이고 배경 작업 메타데이터의 모델도 같다 |
| OMO-P8 | `omo-opencode/src/plugin/command-execute-before.ts` | `OMO_OWN_HOST=1`이면 명령 `resume-continuation`이 멈춤 표시(`stopContinuationGuard.clear`)를 지운다 | 멈춤은 omo 플러그인 안의 상태라 호스트가 닿을 수 없다. own의 `/resume-continuation`(§3.4)이 이 훅을 부른다 |
| OMO-P9 | `skills-loader-core/src/features/opencode-skill-loader/loader.ts`(`discoverProjectClaudeSkills`·`discoverOpencodeProjectSkills`·`discoverProjectAgentsSkills`), 같은 폴더의 `opencode-config-skills-reader.ts`(`getConfigPaths`) | `OMO_OWN_HOST=1`이고 `OMO_OWN_PROJECT_SKILLS`가 `1`이 아니면 프로젝트 스킬 탐색 셋이 빈 목록을 돌려주고, 프로젝트의 `.opencode/opencode.json(c)`에서 스킬 폴더를 읽지 않는다 | omo는 코어의 스킬 목록과 따로 스킬을 직접 찾는다(Sisyphus 지시문의 스킬 이름, `task(load_skills)`가 하위 에이전트에 싣는 본문). 그래서 서비스가 프로젝트 config를 끈 채 떠 있어도(SSH 호스트의 `끔`·`지시 파일만`, 이 PC의 `--untrusted`) 프로젝트의 `.opencode/skills`·`.agents/skills`를 읽었다(2026-11-20 조사, `own/reports/host-project-config-2026-11-21.md`). own-omo가 코어 CLI와 같은 규칙(`OPENCODE_CONFIG_PROJECT_DISABLE`, 없으면 `OPENCODE_DISABLE_PROJECT_CONFIG`)으로 변수를 정한다(`Runtime.projectSkills`). omo의 탐색 함수는 여러 곳(skill-context, agent-skill-discovery, delegate-task의 skill-resolver, auto-slash-command)에서 불려서 own 설정만으로는 막을 수 없다 |

패치 없이 막은 것: 시작 단계 주입(§3.2), `setVersionCache`·로거 경로, 번들 별칭(§2), own 설정(§3.8). omo의 세션별 상태(이어서 하기 표시)는 OMO-P6로 프로젝트 밖(`<OWN_HOME>\thirdparty\omo\projects\`)에 둔다. 그래서 프로젝트에 `.omo\` 폴더가 생기지 않고 대화의 바뀐 파일 목록에도 보이지 않는다.

---

## 5. MVP 범위

- 잇는 OpenCode 1 훅(15개 중 10): `tool`, `config`, `chat.message`, `experimental.chat.system.transform`, `event`, `tool.execute.before`, `tool.execute.after`, `tool.definition`, `command.execute.before`, `dispose`. 잇지 않는 것: `chat.params`, `chat.headers`, `experimental.chat.messages.transform`, `experimental.session.compacting`, `experimental.compaction.autocontinue`.
- 켠 omo 훅: keyword-detector(ultrawork만), todo-continuation-enforcer, stop-continuation-guard, background-notification, agent-usage-reminder, delegate-task-retry, empty-task-response-detector, task-resume-info, todo-description-override, tasks-todowrite-disabler, write-existing-file-guard, edit-error-recovery.
- 에이전트: Sisyphus(build로), explore, librarian, oracle, sisyphus-junior(카테고리 위임에 필요). 도구: task, background_output, background_cancel, call_omo_agent, todowrite. 명령: stop-continuation, own의 resume-continuation. MCP: 없음. 스킬: omo의 내장 스킬과 스킬 도구(`skill`, `skill_mcp`)는 끈다. 다만 omo는 디스크의 스킬을 직접 찾아 Sisyphus 지시문에 이름을 적고 `task(load_skills)`로 하위 에이전트에 본문을 싣는다. 전역(`<config>/skills`, `~/.agents/skills`)은 늘 찾고, 프로젝트(`.opencode/skills`, `.agents/skills`)는 서비스가 프로젝트 config를 읽을 때만 찾는다(OMO-P9). `claude_code.skills`를 꺼 두었으므로 `.claude/skills`(전역·프로젝트)는 omo가 찾지 않는다. 코어의 스킬 목록에는 보이는 `.claude/skills` 스킬을 `load_skills`에 넣으면 `Skills not found`가 된다(알려진 한계. `claude_code.skills`를 켜면 Claude 앱이 `~/.claude/skills/synced`에 넣는 스킬 약 12,000자가 omo 지시문에 들어온다. own-harness가 코어 목록에서 일부러 빼는 것이다).

---

## 6. 화면 (own-web)

- 이름 `omo (원본)`/`omo`는 첫 청크의 i18n 키. 설명과 지시문 쪽 안내는 지연 청크 `harness/omo-strings.ts`(메뉴나 설정이 omo를 보일 때 불러옴).
- 하네스 목록은 RPC `list`를 따른다: 서비스가 omo를 내놓을 때만 알약 메뉴, 설정 > 일반, 설정 > 에이전트 방식에 나온다. omo에는 지시문 고르기가 없다(알약에 `개선판`이 붙지 않고, 메뉴에 지시문 줄과 `지시문 보기·고치기`가 없다). 설정 > 에이전트 방식의 omo 탭은 안내 한 줄: `omo는 SUL-1.0 라이선스예요. 이 앱은 개인 용도로만 쓰고, 고친 곳은 MODIFICATIONS.md에 적어 두었어요. 지시문은 omo가 요청마다 만들어서 미리 보기가 없어요.`
- 설정 > 에이전트 방식의 omo 탭 아래 `하위 에이전트`(2026-11-07, 10 §3.11)는 한 줄이다: `omo는 task 도구로 맡겨요. 돌아오는 글은 omo가 만들어요(걸린 시간, 에이전트, 하위 에이전트의 답, 이어서 맡길 때 쓸 task_id). 이 앱은 아무것도 더하지 않아요.`(`own.omo.subagent`). omo의 `task`(동기) 결과는 omo의 `buildSyncTaskCompletion`이 만든다: 걸린 시간, 에이전트(카테고리·모델), 하위 세션의 마지막 답, `<task_metadata>`(session_id·task_id). 켠 훅 `task-resume-info`가 `to continue: task(task_id=…)` 한 줄을 더하고, 빈 답은 `empty-task-response-detector`가 경고로 바꾼다. 원래 omo에서 결과에 git 변경 통계와 확인 알림을 붙이는 Atlas 훅은 부르는 쪽이 Atlas일 때만 돌고, own은 Atlas 에이전트와 그 훅을 끄므로(§4.8 `DISABLED_AGENTS`, `ENABLED_HOOKS`에 없음) 붙지 않는다(리뷰 SAV-R2: 처음 판의 한 줄은 붙는다고 했다).
- 대화 기록: `task`와 `call_omo_agent`는 하위 에이전트 카드(에이전트는 `subagent_type`이나 카테고리, 하위 대화는 결과의 `metadata.sessionID`), `todowrite`는 일반 카드.
- 명령 팔레트 키워드: omo, ultrawork, ulw, 울트라워크.
- PF5 409,303바이트(예산 409,600). main(`2.0.32-own.8`, 팀 기다림 카드)과 합친 뒤 409,414바이트(OMP-37).

---

## 7. 버전 갱신

1. `bun own/scripts/omo-vendor.ts --from <clone> --tag vX [--work <빈 폴더>]`: 사본은 `rev-parse`·`ls-tree`·`cat-file --batch`로만 읽는다(체크아웃·빌드 없음). 런타임 진입점의 닫힘을 번들 해석기로 다시 계산해(Bun의 metafile은 다시 내보내기만 하는 모듈을 빼므로 실제로 불러온 모듈을 센다) `src/`, `source.json`, `pin.json`, `omo-pin.json`, 라이선스 사본을 다시 쓴다. 내장 스킬이 불러올 때 읽는 SKILL.md도 넣는다. `LICENSE.md`가 바뀌면 멈춘다(읽고 정한 뒤 `--accept-license-change`).
2. `bun own/scripts/omo-patch.ts rebase --from v5.1.50 --to vX`: 각 편집을 다시 적용해(find가 정확히 한 번) `patches/vX.json`을 쓰고, 안 되는 것은 나열한다. 그 파일은 `omo-patch.ts make <pristine> <edited> <out>`으로 다시 만든다.
3. 다시 빌드하고 own-omo 단위·vendor·격리·e2e 시험과 golden을 돌린 뒤 MODIFICATIONS.md와 결정 기록에 적는다.

---

## 8. 시험

- 단위(`packages/own-omo/test/unit`): names, view, events, client, tools(todowrite 포함), config(omo 스키마로), vendor(해시, 고정, 라이선스, 패치, MODIFICATIONS), isolation(별도 프로세스에서 런타임 시작과 `task`의 after 훅: 정렬 함수 그대로, 신호·오류 리스너 수 그대로, fetch 0번, opencode 프로세스 없음, OWN_HOME의 omo 폴더 밖에 파일 없음(프로젝트에도, 시험이 정한 `XDG_DATA_HOME`·`XDG_CACHE_HOME`에도 없고 그 폴더도 생기지 않음. 이어서 하기 표시는 `projects\workspace-<해시>\run-continuation\`, agent-usage-reminder 기록은 `data\opencode\storage\agent-usage-reminder\`). fetch를 바꾸는 것은 텔레메트리·업데이트 통신이 없음을 보일 유일한 방법이라 쓴 예외).
- e2e(`test/e2e/omo.test.ts`, 실제 서버 + own-harness + own-omo + 가짜 DeepSeek chat): ultrawork(system[0] Sisyphus, 사용자 메시지 끝의 ultrawork 블록, 저장 글은 그대로, 도구 목록), todo 이어서 하기(남은 todo → synthetic `source: own.omo` → TODO CONTINUATION, 다 끝나면 10초 동안 요청 없음, 요청마다 앞 요청이 접두사), 배경 explore(부모 모델의 `omo-explore` 하위 세션, explore 지시문, 부모 깨우기, background_output, 하위 세션 남음, 서버의 `XDG_DATA_HOME\opencode\storage`에 아무것도 없고 agent-usage-reminder 기록은 OWN_HOME 아래), 동기 카테고리 deep-low(부모를 own 기본 모델이 아닌 모델로 만든다: omo가 자기 모델을 요구하는 카테고리도 `omo-sisyphus-junior`가 부모 모델로 돌고 결과가 바로 오며, 결과 글은 `Model: <부모 모델> (category: deep-low)`이고 `Model routing`이 없다, OMO-P5·P7), `/stop-continuation`(10초 동안 요청 없음, 프로젝트에 `.omo\` 없음, 표시는 OWN_HOME의 `projects\workspace-<해시>\run-continuation\`에 `stopped`) 뒤 `/resume-continuation`(쉬는 세션이 바로 TODO CONTINUATION, 표시 `idle`), 남은 todo가 있는 턴이 도는 중의 문맥 비우기와 omo 카운트다운 중의 문맥 비우기(둘 다 10초 동안 그 todo를 담은 요청 0번), omo 카운트다운 중의 수동 압축(압축 요청 1번 뒤 10초 동안 그 todo를 담은 요청 0번), 400 오류 뒤 사용자의 새 메시지(그 턴이 남긴 todo를 이어서 함), 틀린 `oldString`의 `edit`(도구 결과에 core 글과 omo의 `[EDIT ERROR - IMMEDIATE ACTION REQUIRED]`), 같은 서버의 `opencode` 세션은 그대로.
- 재시작 e2e(`test/e2e/restart.test.ts`): omo 세션의 모델 요청이 열린 채 서버를 멈추고 같은 데이터로 다시 켜면, 그 대화의 다음 첫 요청에 omo 도구(task, background_output, background_cancel, call_omo_agent, todowrite)가 있다. core의 재시작 복구는 관리 서비스(`serve --service`)에서만 돌고 그 프로세스 시험은 Windows에서 건너뛴다. e2e kit의 서버는 `serve --stdio`라 복구가 없어서, 시험은 synthetic 알림으로 drain을 시작한다(복구된 배경 작업의 알림과 같은 길). 어느 쪽이든 drain은 own-omo의 훅보다 먼저 도구를 고른다.
- 단위(리뷰 반영): 들어온 사용자·synthetic 메시지와 문맥 비우기의 OpenCode 1 이벤트(events), 비우기 표시와 되돌린 비우기(view), edit 실패의 다리(hooks), 명령 둘과 `omo (원본)` 오류 글(commands), 알림 기록과 없는 스킬 폴더(notices), `omo-vendor.ts`가 바뀐 `LICENSE.md`에서 아무것도 쓰지 않고 멈춤(vendor), 격리(프로젝트에 파일 없음, 상태는 `projects\` 아래).
- 단위(검증 반영): 들어온 수동 압축의 OpenCode 1 이벤트와 그 끝의 `session.compacted`(events), 실패한 압축의 쌍과 빠지는 도는 압축(view), 격리의 `task` after 훅과 시험이 정한 XDG 폴더(isolation). 각 시험은 고치기 전 코드에서 실패했다.
- golden(`test/e2e/golden-unchanged.test.ts`): `opencode`, `codex`, `pi`, `dsh` 세션의 첫 요청이 2904b08d7b에서 own-omo 없이 기록한 것과 바이트까지 같다(own-omo 켬, `enabled: false` 둘 다). 정규화는 작업 폴더, 임시 폴더, 날짜·시각, 스킬 목록과 codex의 시험 밖 스킬 루트다. core는 작업 폴더에서 위로 `.agents\skills`를 찾으므로 임시 폴더가 사용자 프로필 아래면 사용자의 스킬 폴더가 루트로 들어온다. 작업 폴더 밖이고 내장 `/`이 아닌 루트는 그 스킬 줄과 함께 빼고 남은 루트의 번호를 다시 매긴다. 그래서 codex golden에 사용자의 홈 경로와 스킬 글이 없고, `TEMP`가 어디든 같다.
- 실계정(`own/reports/omo-port-live-2026-10-29.md`, DeepSeek V4 Pro, `run.ts --omo`): bugfix 16/16, ulw + 위임 6/6(Sisyphus-Junior 배경 작업과 부모 깨우기), todo 이어서 하기 4/4(이어서 하기 1번). 요청 28번, 약 $0.04, 캐시 적중 84–96%. 여기서 OMO-P5를 찾았다. 리뷰 반영 뒤 두 번 더(같은 보고서 §4, `script/live/omo-checks.ts`): 남은 todo가 있는 턴 중의 문맥 비우기 뒤 omo 알림·요청 0, 400(프록시가 넣음) 뒤 새 메시지로 이어서 하기 1번. DeepSeek 요청 7번.
- own-protocol(옛 빌드는 omo를 opencode로, 지시문 없음, `harness_unavailable`), own-harness(gate 규칙, `list`가 own-omo 도구 없으면 omo를 숨김), own-web(알약·설정 상태, 지연 문구, 도구 별칭), Playwright prompts(설정 > 에이전트 방식의 omo 탭과 안내, 알약 메뉴의 `omo (원본)`, 그 대화가 Sisyphus와 ultrawork로 감, 서비스가 omo를 내놓지 않으면 줄이 없음).
- 팀 모드(2026-10-29, §3.10): 단위 `test/unit/team.test.ts`(팀 대화 판정과 캐시, 받은 팀 입력, `outsideTeams`가 팀 대화의 `session.idle`만 거름)와 `commands.test.ts`(팀 대화의 `/resume-continuation`). e2e `test/e2e/team.test.ts`(own-team의 e2e 하네스 + own-harness + own-omo, 가짜 DeepSeek): 팀 메인과 담당을 omo로 고정(담당의 바꿈 알림 1개가 대기함에 남음, RH-15), 첫 메인 요청이 `fresh`라 교체가 끝나고 이 앱이 인계를 쓰며 알림은 옛 대화에 남음, 새 담당이 omo로 요청을 받음, 메인과 새 담당이 `todowrite`로 할 일을 남김, 두 번째 `fresh` 요청에서 omo 담당이 인계 턴으로 메모를 쓰고 다음 담당이 omo로 요청을 받음, 메인·담당 요청에 Sisyphus와 팀 역할 지시가 함께 있음, 모든 대화가 쉰 뒤 12초 동안 TODO CONTINUATION 요청 0번. 이어서 하기를 거르지 않으면 마지막 확인에서 실패한다(OMP-33). own-team 단위 `safe-point.test.ts`: own-omo의 `noReply` 알림은 10초 뒤 일이 아니고 `SafePoint.work`도 아님.
- 원격(2026-10-29, §1): own-remote `script/bundle.test.ts`(목록, own-omo 압축 파일 배치, 런타임 없으면 묶지 않음, `inspectRemote`의 `own-omo without …`, own-omo 릴리스 번들의 define과 런타임), `test/unit/model.test.ts`(관리 설정 6번), `test/e2e/release-bundle.test.ts`(실제 번들을 가짜 SSH 호스트에 설치, own-omo 런타임 파일이 같음), own-web `e2e/linux-build/artifacts.pw.ts`(만든 Linux 번들의 배치). 실호스트 E단계(`test/real-host/e-live.test.ts`)의 bugfix가 codex, pi, opencode와 함께 omo로도 돈다: 그 폴더에서 호스트가 omo를 내놓는지 보고, 그 폴더에서 아무것도 15초 동안 돌지 않을 때 `node --test`(16/16)를 보며, 호스트의 `thirdparty/omo/logs/omo.log`에 omo 플러그인 시작 줄이 있어야 한다. C·D단계는 관리 설정과 설치 폴더의 플러그인 목록에 own-omo를 본다.

---

## 9. 비용, 남은 일

- 런타임 3.8 MB를 프로세스에 한 번 불러온다(처음 omo 세션을 쓸 때). omo 세션의 요청은 Sisyphus 지시문(약 34,000자)과 omo 도구 설명만큼 길다. 캐시는 요청마다 접두사가 유지된다(e2e).
- 모델 정책 `configured`(옵션의 에이전트·카테고리 모델 적용)와 `match`(omo의 대체 사슬로 own의 연결된 제공자 중 고르기, 비용 결정 필요)는 다음이다.
- omo는 시작할 때 없는 스킬 폴더를 읽다가 `Skill load error` 알림을 낸다. own은 그 폴더를 만들지 않고, 그 알림은 own 기록에 적지 않는다(§3.4).
- 할 일 목록은 문맥 비우기 뒤에도 남는다(압축과 같다). 비운 뒤 첫 턴이 끝날 때 그 할 일이 아직 열려 있으면 omo가 이어서 한다. 필요하면 `/stop-continuation`이나 `todowrite`로 정리한다.
- 다음에 할 것: MCP·스킬, omo 자체의 team mode, 모델에 v1 이름으로 도구 보이기(`Registry.omo`에 read·write·edit 형식 필요), own 화면의 알림(지금은 기록만).
- 가능한 코어 패치 후보(필요할 때만, 2026-10-27 위임에 따라 ledger에 적음): 플러그인 `SessionDomain`의 메시지 쪽 읽기(세션 도구가 HTTP 자기 호출 없이), 플러그인이 부를 수 있는 `session.active`(플러그인을 다시 불러와도 상태 맵 유지). 지금은 둘 다 필요 없다.
