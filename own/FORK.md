# FORK.md: own-open-code 포크 운영

| 항목 | 값 |
|---|---|
| 저장소 | `origin` = 비공개 저장소(기본 브랜치 `main`). 공개 저장소를 만들 때 `NA-DEGEN-GIRL/own-open-code`에서 `NA-DEGEN-GIRL/own-open-code-private`로 이름을 바꾸고 `origin` URL도 바꿔요. 그 뒤 `NA-DEGEN-GIRL/own-open-code`는 `own/scripts/public-export.ts`로 만든 공개 저장소예요(`own/reports/public-release-audit-2026-11-26.md` 8장). |
| upstream | `upstream` = https://github.com/anomalyco/opencode, branch `dev`(2026-10 전에는 `v2`) |
| 로컬 브랜치 | `main` = 우리 작업, `upstream-v2` = upstream 기본 브랜치의 순수 미러(우리 커밋 없음). upstream은 2026-10 v2.0.28 무렵 기본 브랜치를 `v2`에서 `dev`로 바꿨고(`v2`는 `4617210822`에서 멈춤, `dev`의 조상), 미러는 이름은 그대로 두고 `dev`를 따릅니다. 둘 다 `origin`에 push되어 있음 |
| fork base | `00d179015f` (2026-09-26). release marker `39021dfd67` "sync release versions for v2.0.18"에서 5커밋 뒤 |
| 버전 | 루트 `package.json` 2.2.0(upstream v2.2.1과 같은 코드 `79349e840f` merge, 2026-10-30, `SYNC_LOG.md`. 태그 `v2.2.1`의 release 커밋 `3ebcf9a32c`는 dev 밖에서 버전 숫자만 올리므로 받지 않았습니다). 우리 빌드 버전은 받은 코드에 맞춘 `2.2.1-own.<k>`이고 다음 릴리스가 `2.2.1-own.1`입니다(§8; `build-own.ps1 -Version 2.2.1-own.1`은 루트 버전과 달라 경고 한 줄을 냅니다). 그전 빌드는 `2.0.32-own.<k>`(마지막 `2.0.32-own.9`), `2.0.28-own.<k>`(마지막 `2.0.28-own.6`), 그 전은 `2.0.24-own.<k>`(마지막 `2.0.24-own.3`), `2.0.18-own.<k>`(마지막 `2.0.18-own.7`) |
| 작업 트리 | `D:\own-open-code` (git worktree, `main`). `D:\#Projects\own-open-code`는 detached 원본 체크아웃이고 작업에 쓰지 않습니다(§11 "Windows 체크아웃 주의") |
| 문서 상태 | Draft v0.4 (2026-09-27, 데스크톱 셸 own-desktop과 SSH 원격 own-remote 반영, 05와 레이아웃·빌드·surface 목록 맞춤). 2026-10-02(T1): own-team 패키지와 플러그인 순서(§1), T1 surface 항목(§7), 빌드 입력·번들·manifest의 own-team(§8.2–§8.3), Q15. 2026-10-02(T2): T2 surface 항목(§7), 팀 모드 영역의 링크 사본(`--assume-unchanged`)과 개발자 모드는 안내만(§11 "Windows 체크아웃 주의"). 2026-10-04(T3): 원격 호스트의 플러그인 순서(§1), T3 surface 항목(§7), 원격 git-lfs 빌드 단계(§8.2)와 manifest `remote_artifacts.tools`(§8.3), git-lfs 라이선스 행(§10), 공유 폴더 링크와 그 `info/exclude` 줄(§11). 2026-10-09(IMPORT, 09): own-import 패키지와 7번 자리(§1), RPC id 다섯(§1), own-import 시험 명령(§4), surface 항목(§7), 데스크톱 번들 여섯·빌드 id 입력·release-smoke·manifest(§8.2–§8.3). 문서 목록은 다음과 같습니다.<br>- 아키텍처: `own/docs/01-architecture.md`<br>- 계정·캐시·RPC 계약: `02-accounts-providers-cache.md`<br>- UI: `03-ui-ux.md`<br>- SSH 원격: `04-ssh-remote.md`<br>- 데스크톱 셸·네이티브 브라우저 패인·모바일 확장: `05-desktop-and-mobile.md`<br>- 팀 모드(영역별 작업 폴더): `06-team-worktrees.md`<br>- LLM 행동 프리셋: `07-presets.md`<br>- 앱 연결(Android 앱, 다른 PC의 데스크톱 앱): `08-app-access.md`<br>- 다른 도구(Codex, Claude Code)의 대화 가져오기: `09-session-import.md` |

**원칙은 네 가지입니다.**
- (1) upstream 파일은 수정하지 않는 것이 기본입니다. 수정하면 ledger에 기록합니다.
- (2) 우리 코드는 `own/`과 `packages/own-*`에만 둡니다.
- (3) upstream은 **rebase하지 않고 merge**합니다. merge 시점은 release marker 단위입니다.
- (4) upstream 코드를 **고치지 않고 가져다 쓰는 것**(vendor 복사, 빌드 시 치환, deep import)은 패치가 아닙니다. 그래도 전부 `own/ledger/vendored.yaml`과 `own/upstream-surface.json`에 등록합니다(§7). 데스크톱 셸은 이 방식만으로 만듭니다(01 §4.1, 05 §4).

---

## 1. 저장소 레이아웃

표시 규칙: `(예정)`은 아직 없는 파일이고, `(P3 이후)`·`(R0 이후)`처럼 단계가 붙은 것은 그 단계에서 생깁니다(단계는 01 §17, 04 §21). 표시가 없으면 2026-09-27 현재 저장소에 있습니다.

```text
own/                                  ← 문서·도구 전용. upstream 코드가 import하지 않음
  README.md                           ← own/ 안내와 문서 목록
  FORK.md                             ← 이 문서
  docs/01-architecture.md             ← 시스템 아키텍처
  docs/02-accounts-providers-cache.md ← 계정·캐시·한도·RPC 계약(데이터 기준)
  docs/03-ui-ux.md                    ← 웹 UI/UX
  docs/04-ssh-remote.md               ← SSH 원격 (own-remote)
  docs/05-desktop-and-mobile.md       ← 데스크톱 셸(own-desktop), 네이티브 브라우저 패인, 모바일 확장
  docs/06-team-worktrees.md           ← 팀 모드(영역별 작업 폴더, own-team)
  docs/07-presets.md                  ← LLM 행동 프리셋
  docs/08-app-access.md               ← 앱 연결: Android 앱, 다른 PC의 데스크톱 앱(own-android, own-desktop 원격 PC), 모바일 미리보기
  docs/09-session-import.md           ← 다른 도구(Codex, Claude Code)의 대화 찾기·보기·옮기기 (own-import, IMPORT)
  docs/10-codex-harness.md            ← 세션별 하네스: OpenCode 기본 / Codex 방식 (own-harness, H0부터)
  design/prototype/index.html         ← 클릭 가능한 UI 프로토타입 (03, 외부 리소스 없음)
  upstream-surface.json               ← 우리가 의존하는 upstream 계약(심볼·경로·코드 영역 해시). check-surface 입력 (§7)
  ledger/core-patches.yaml            ← 코어 패치 ledger (§6)
  ledger/vendored.yaml                ← upstream에서 vendor·치환·deep import한 파일 목록 (§7). `T3 (06 §4.13)` 주석 블록은 원격에 동봉하는
                                         git-lfs의 기록(출처, 버전, 압축 파일과 sha256, 라이선스, §10. 목록 항목이 아님)
  ledger/cherry-picks.yaml            ← 긴급 cherry-pick 목록 (§4)
  ledger/omo-pin.json                 ← vendor/oh-my-opencode/pin.json의 사본(태그·커밋·라이선스 해시). omo-vendor.ts가 씀 (§10, 15)
  ledger/typecheck-baseline.yaml      ← (예정) Windows에서 실패하는 upstream lint/typecheck 기준선 (§3).
                                         지금은 기준선이 비어 있어 파일이 없음. 실패가 생길 때 만듦
  ledger/SYNC_LOG.md                  ← upstream merge마다 1항목
  scripts/build-own.ps1               ← own 채널 빌드와 격리 검증 (§8.2). 지금은 §8.2의 1단계(CLI)만 구현
  scripts/check-ledger.mjs            ← upstream 대비 diff = ledger 검증 (Node 22, Bun 불필요)
  scripts/check-surface.mjs           ← 우리가 의존하는 upstream 심볼·경로 존재 검증 (Node 22)
  scripts/lib/, scripts/test/         ← 스크립트 공용 모듈(git, yaml-lite, verify-own-binary.ps1)과 그 테스트
  scripts/lib/release-ids.mjs         ← (예정) build id와 rpcHash 계산의 단일 구현 (§8.2 1b). 셸·own-web 개발 빌드도 이것을 씀
  scripts/sync.ps1                    ← (예정) 미러 갱신과 merge 보조
  scripts/check.ps1                   ← (예정) 로컬 CI 한 번에 실행 (§9)
  scripts/release-smoke.ts            ← 빌드 산출물 스모크(설치 레이아웃, launcher, 번들 플러그인, fake provider 왕복, 게이트웨이 깨우기)
  scripts/pe-inventory.ts             ← 릴리스 PE 목록(내용으로 찾은 PE의 경로·크기·sha256·Authenticode 상태와 서명자
                                         → own/release/<ver>/pe-inventory.json, P1-15)
  scripts/db-stats.ts                 ← 세션 DB 읽기 전용 통계(한글 토큰 밀도, 잘림·빈 응답, 이미지 바이트. 본문은 출력하지
                                         않음) → own/.out/db-stats/<time>/report.{json,md}, WP13
  scripts/ds-probe.ts                 ← DeepSeek 측정(캐시 유지 시간, thinking 이력 수용, 선택적 창 선점 확인. 사용자가 실행)
                                         → own/.out/ds-probe/<time>/report.{json,md}, WP14
  scripts/gates/g7.ts, g8.ts          ← 실계정 게이트 G7(한도 수집)·G8(retry 제어) 증거 수집(사용자가 실행, 02 §7.8). 공용
                                         gate.ts. --self-test는 e2e-kit fake로 → own/.out/gates/<time>-g7|g8/evidence.{json,md}
  scripts/android-emulator.ps1        ← (선택) Android Emulator 준비 확인과 사용자가 실행할 명령 출력. 실행 중인 에뮬레이터에만
                                         APK 설치와 페어링 링크 열기(adb). 시스템 변경 없음 (08 §4.3)
  config/opencode.jsonc.example       ← %USERPROFILE%\.config\own-open-code\opencode.jsonc 예시
                                         (plugins 순서는 아래 규칙, permissions, update:"disable", share:"disabled")
  config/ratecards.default.json       ← rate card 기본값 (설치 시 OWN_HOME\ratecards.json의 seed)
  launcher/own.cmd, own.ps1           ← launcher v0 (start/stop/restart/status/pair/open)
  launcher/install.ps1                ← (예정) 버전 설치와 전환 (§8.4)
  native/own-vault/                   ← Rust DPAPI helper (JS workspace 아님)
  native/own-cu-helper/               ← computer-use 대체 엔진(driver: "helper") helper: C# 5, 윈도 기본 .NET
                                         Framework csc.exe로 빌드(build.ps1 → target\own-cu-helper.exe, SDK·설치
                                         불필요). 기본 엔진은 플러그인 안 FFI 드라이버. 프로토콜은 그 폴더의 README.md
  vendor/claude-auth/                 ← 앱에 넣는 서드파티 Claude 플러그인의 입력 (package.json("type":"module"),
                                         package-lock.json, server.js, patches/<ver>.json). 빌드가 설치·확인·패치·
                                         번들해 app\<ver>\plugins\claude-auth\에 둠(2026-10-18, 02 §8.2)
  vendor/oh-my-opencode/              ← own-omo가 돌리는 서드파티 OpenCode 1 플러그인 oh-my-opencode(SUL-1.0)의 입력. src/(고정 태그의
                                         원본 바이트, 런타임 진입점의 import 닫힘), source.json·pin.json(해시·고정), LICENSE.md·
                                         THIRD-PARTY-NOTICES.md(그대로 복사), MODIFICATIONS.md(고친 내용), patches/<tag>.json(빌드 때만
                                         적용, OMO-P1…). 빌드가 패치해 묶어 app\<ver>\plugins\own-omo\에 둠(2026-10-28, 15)
  tools/fake-provider/                ← (예정, P2) E2E·smoke용 가짜 provider (Node). 지금은
                                         packages/own-accounts/test/e2e-kit/fakes/(Bun)가 테스트에서 이 역할을 함
  tools/remote-e2e/                   ← (R1 이후) SSH 원격 E2E 도구 (04 §20)
  scripts/remote-live-test.ps1        ← (R1 이후) 실제 호스트 대상 원격 시험 (04 §20)
  release/<version>/manifest.json     ← (첫 릴리스부터) 릴리스별 고정 정보 (§8)
  release/<version>/perf.json         ← (첫 릴리스부터) 성능 게이트 PF1–PF8 결과 (01 §6.6, §16.3)
  .gitignore, .gitattributes          ← own 전용 산출물 무시(.out/, *.log), *.cmd CRLF. 루트 파일은 수정하지 않음
packages/own-protocol/                ← @own/protocol: RPC 정의(Rpc.PortableDefinition, RPC id own.accounts·own.remote·own.team·own.computer·own.import)·공용 스키마 (브라우저·서버 공용)
packages/own-runtime/                 ← @own/runtime: 프로세스 싱글턴(빌드 id 키, 참조 카운트, 파일 락), vault client, 파일 저장소,
                                         ledger writer, lastResponse 저장소, refresh single-flight, 해시 유틸 (서버 전용)
packages/own-accounts/                ← @own/accounts (플러그인 id own.accounts): 계정·slot·인증 주입·요청 형성·전환 상태 머신·추정기,
                                         RPC id own.accounts 핸들러 등록
packages/own-team/                    ← @own/team (id own.team, T1부터): 팀 모드(06). 플러그인 순서 3번 자리, RPC id own.team.
                                         컨트롤러 싱글턴(빌드 id 키, OWN_HOME\locks\team-controller.lock), 등록부(KV), 작업(op),
                                         메인 요청·보고, git 실행, 팀 도구 8개. 구조는 패키지 ARCHITECTURE.md. UI는 own-web src/team/
packages/own-telemetry/               ← @own/telemetry (id own.telemetry): Claude 구독 슬롯('anthropic') 관측
packages/own-remote/                  ← (R0 이후) @own/remote (id own.remote): SSH 원격. src/vendor/에 upstream desktop SSH 모듈 복사 (04 §4.3).
                                         script/native.ts·bundle.ts: 원격 교차 빌드 입력, 고정 git-lfs(T3), REMOTE_PLUGINS
packages/own-web/                     ← @own/web: UI (SolidJS). 데스크톱 렌더러이자 웹 폴백 UI. 지금은 뼈대(src/index.tsx)만 있고 P3에서 구현
                                         src/adapter/: upstream UI 패키지를 import하는 유일한 층 (03 §16.1)
                                         src/host/{types,web,desktop,index}.ts: OwnHost (05 §6.6). desktop.ts만 @opencode/desktop
                                           렌더러 api를 deep import하고, index.ts가 desktop.ts를 dynamic import함 (01 §6.2)
                                         e2e/performance/: 성능 게이트 하네스 (packages/app/e2e/performance에서 vendor)
packages/own-desktop/                 ← (P4 이후) own-desktop: Electron 셸. upstream packages/desktop main 재사용 (05 §4.1)
                                         src/main/index.ts, desktop.ts (vendor), own-env.ts (env 스냅샷), own-ipc.ts (own:service.*)
                                         src/overrides/{constants,environment}.ts (빌드 시 치환, 05 §4.3)
                                         src/overrides/{gui-extensions,extension-manager}.ts (빌드 시 치환: GUI 확장은 브라우저
                                           패인 하나, 설치형 확장 없음. v2.0.24, 05 §8.1)
                                         src/overrides/security.ts (빌드 시 치환: 렌더러 권한에 마이크(오디오만) 더함, VOICE,
                                           05 §4.3·§7.8), src/main/media-permission.ts (그 판정, 원격 PC 창도 씀)
                                         src/main/own-browser.ts (패인 다운로드의 PC에 저장, 05 §8.4)
                                         src/main/service/{background-service-own,desktop-cli-own}.ts (layer 교체, 05 §5.3·§5.4)
                                         src/preload/index.ts ((선택) vendor + window.own), src/fallback/index.html (폴백 페이지, 05 §5.5)
                                         electron.vite.config.ts, electron-builder.config.ts (upstream 설정을 import해 덮어씀), test/
packages/own-android/                 ← Android 앱 dev.own.opencode.android (Java, Gradle; own/scripts/build-android.ps1, 08 §4.2)
packages/own-computer-use/            ← @own/computer-use (id own.computer-use): Windows 컴퓨터 사용, Effect API 플러그인.
                                         기본 드라이버는 bun:ffi로 Win32를 직접 부르는 워커 스레드 둘(별도 exe 없음).
                                         플러그인 순서 6번 자리(own-team이 없던 빌드에서는 다섯 번째 항목), RPC id own.computer
                                         (01 §10.2, 패키지 README.md·ARCHITECTURE.md).
                                         UI는 own-web src/computer/ (03 §5.7.2)
packages/own-import/                  ← @own/import (id own.import, IMPORT부터): 다른 도구(Codex, Claude Code)의 대화 찾기·읽기 전용
                                         보기·옮기기(09). Effect API 플러그인, 훅 없음, 플러그인 순서 7번, RPC id own.import.
                                         스캔·파싱은 Worker 스레드 하나(번들은 Worker 소스를 define OWN_IMPORT_WORKER_SOURCE로 품음).
                                         다른 도구의 파일은 읽기만 함. 구조는 패키지 ARCHITECTURE.md. UI는 own-web src/import/ (03 §5.9)
packages/own-harness/                 ← @own/harness (id own.harness): 세션별 하네스(OpenCode 기본 / Codex 방식), Effect API 플러그인.
                                         10-codex-harness.md. 플러그인 순서 8번(맨 뒤). H0에는 훅이 없고, 뒤 단계의 요청 훅이 다른
                                         own 플러그인의 훅 다음에 요청을 바꿔야 하므로 맨 뒤에 둠. codex-data/는 생성 스크립트로 가져온
                                         Codex 자료(LICENSE·NOTICE 포함, §10). 이 PC 전용(원격 번들에는 H1의 요청 훅부터 실음)
packages/own-omo/                     ← @own/omo (id own.omo, 2026-10-28): oh-my-opencode를 OpenCode 2에서 돌리는 v1 플러그인 호스트(15).
                                         하네스 `omo (원본)`. script/bundle.ts가 own/vendor/oh-my-opencode를 패치해 omo-runtime.js로
                                         묶음. 플러그인 순서는 own-harness 다음. 원격(SSH) 번들에도 맨 뒤(2026-10-29, 15 §1)
packages/own-creator/                 ← @own/creator (id own.creator, 2026-11-04): creator 모드와 own의 확장(17). 저장소
                                         OWN_HOME\creator(바뀌지 않는 판 폴더와 활성 판), 지시문 조각·명령 도구·도구 규칙·재시도·압축
                                         추가·에이전트·명령·스킬·내 지시문의 해석기, 생성 MCP 서버(C2, 별도 프로세스)와 코드 플러그인
                                         (C3, 기본 꺼짐, config `plugins` 끝 항목과 trust 승인), RPC own.creator(설정 > 확장). 플러그인
                                         순서 맨 뒤(own-omo 다음). 이 PC 전용(원격 번들에 없음, 17 §10). core 패치 없음
```

- 패키지 이름은 01 §4·02·03·04·05·06·09와 같습니다: `own-protocol`, `own-runtime`, `own-accounts`, `own-remote`, `own-team`, `own-telemetry`, `own-web`, `own-desktop`, `own-computer-use`, `own-android`, `own-import`, `own-harness`.
  - `own-runtime`은 플러그인 번들에 함께 들어가는 서버 전용 라이브러리입니다(01 §4).
  - RPC id는 `own.accounts`(own-accounts 등록, 메서드 목록은 02 §9, IMPORT부터 69개, NOTES의 워크스페이스 노트 `notes.*`와 VOICE의 음성 입력 `voice.*`, 원격 Claude(04 §8.11)의 `plugin.claudeAuth.{remote.ack,remote.set,fastAck}`를 더해 80개), `own.remote`(own-remote 등록, 04 §16), `own.team`(own-team 등록, 06 §2.7, T1부터), `own.computer`(own-computer-use 등록, `@own/protocol/rpc-computer`), `own.import`(own-import 등록, `@own/protocol/rpc-import`, 09 §5, IMPORT부터) 다섯입니다. 휴대폰 게이트웨이는 `own.computer` 중 `status`와 `killswitch.engage`만 통과시키고(보고 멈추기, 05 §13.4), `session.approval.set{computerUse:"on"}`과 `computer`를 허용하는 규칙을 담은 세션 생성·가져오기도 PC에서만 받습니다(05 §13.4). `own.team`은 범위표로 보고 `local` 메서드를 막습니다(T1, 06 §2.7. T3부터 `/srv/<hostId>`의 원격 팀도 같은 표). `own.import`도 범위표(`OwnImportRouting.MethodScope`)와 입력별 판정(`OwnImportRouting.scopeOf`)으로 봅니다: 보기는 `read`(요청한 폴더의 프로젝트 대화만), 옮기기는 `prompt`, `sources.configure`와 PC의 모든 대화(`scope:"all"`), 비밀을 남기는 가져오기(`redact:false`)는 `local`이고 `/srv/<hostId>`의 `own.import`는 언제나 막습니다(09 §5.5, 05 §13.5). own.import의 보조 세션 표시(`own.import.helper`)를 metadata에 쓰는 세션 생성·가져오기·고치기도 PC에서만 받습니다(다음 시작 때 지워지므로). `own.computer` 규칙은 그대로이고 앱 기기(08)도 같은 규칙을 지납니다.
- 플러그인은 own 전역 config `%USERPROFILE%\.config\own-open-code\opencode.jsonc`(`OPENCODE_CONFIG_DIR`)에만 설정합니다.
  - 순서는 `[own.accounts, own.remote(R1부터), own.team(06, T1부터), heymaaz.claude-auth-v2(2026-10-18부터 앱에 포함), own.telemetry, own.computer-use, own.import(09, IMPORT부터), own.harness(10, H0부터)]`입니다(01 §4, 02 §8.2, 04 §4.1, 06 §2.6, 09 §5.1, 10). own.remote가 들어오기 전에도 2번 자리는 own-remote용으로 비워 둡니다(04 §21 이음매 5). own.team은 3번이라 claude-auth 줄이 바뀌어도 다시 시작하지 않습니다. `own-computer-use`는 6번 자리입니다(own-team이 없던 빌드에서는 다섯 번째 항목, 01 §10.2). 에이전트 변환이 own-accounts의 에이전트가 생긴 뒤에 돌아야 하므로 요청 경로 플러그인들 뒤에 둡니다. `own-import`는 7번 자리입니다. 훅이 없고, config는 처음 바뀐 자리 뒤의 플러그인만 다시 불러오므로 끝에 더하면 다른 플러그인이 다시 뜨지 않습니다. `own-harness`는 맨 뒤 8번 자리입니다. H0에는 훅이 없어 더해도 다른 플러그인이 다시 뜨지 않고, 뒤 단계(10 H1)의 요청 훅은 다른 own 플러그인의 훅이 모두 돈 뒤에 요청을 바꿔야 하기 때문입니다. launcher가 관리하는 항목이며(`own.ps1` `$ManagedPlugins` = own-accounts, own-remote, own-team, claude-auth, own-telemetry, own-computer-use, own-import, own-harness. 번들 경로 정규식과 `own status`의 플러그인 표에도 own-import·own-harness·claude-auth), 업데이트가 새 번들을 가져오면 기존 config에 그 앞 번들 다음 줄로 넣습니다(launcher 0.5.0. own-team은 own-remote 줄 다음, 곧 claude-auth 줄 앞. own-import는 own-computer-use 줄 다음. own-harness는 own-import 줄 다음. 사용자가 지운 항목은 다시 넣지 않고 `does not load own-import` 같은 경고만 냄). claude-auth(launcher 0.6.0, 2026-10-18)는 늘 켜짐이라 없으면 own-team 줄 다음에 넣고, 옛 `thirdparty\claude-auth` 줄은 그 자리에서 번들 줄로 바꾸며, 설치·업데이트가 성공한 뒤 옛 npm 설치 파일만 지웁니다(계정 목록·상태·로그인은 남김, 02 §8.2 7번). own-accounts의 신뢰 목록(`packages/own-accounts/src/plugins/inventory.ts` `OWN_PACKAGES`)에도 같은 번들 이름이 있어야 합니다. 없으면 그 번들을 싣는 모든 Location이 `blocked_by_plugin`입니다(06 §10.4 #3).
  - `config/opencode.jsonc.example`도 이 순서를 따릅니다(2026-10-02 고침: own.team 3번 자리, own.computer-use 6번. IMPORT: own-import 맨 끝. H0: own-harness가 그 뒤 맨 끝).
  - **원격 호스트의 순서(04 §4.1, 06 §4.13, T3부터. own.telemetry는 04 §8.11부터)**: `[own.accounts(mode=remote), own.remote(mode=agent), own.team(mode=remote), own.telemetry]`. claude-auth, own-computer-use, own-import는 원격에 싣지 않습니다(Claude 구독은 PC egress 중계, 04 §8.11). own-harness도 아직 싣지 않습니다(요청 훅이 들어오는 10 H1부터 실음). own-remote가 원격 managed config(`<OWN_HOME>`의 절대 경로를 옵션 `home`에)를 통째로 씁니다. own-computer-use와 own-import를 싣지 않는 이유는 그대로입니다(원격 호스트에는 컴퓨터 사용이 없고 게이트웨이는 `/srv/<hostId>`의 `own.computer`를 늘 막습니다. own-import는 이 PC의 Codex·Claude Code 저장소만 읽고, 게이트웨이는 `/srv/<hostId>`의 `own.import`도 늘 막습니다, 09 §7.1 I3). 원격 번들 목록은 `packages/own-remote/script/bundle.ts`의 `REMOTE_PLUGINS`이고 `build-remote.ps1`과 release-smoke가 같은 목록을 봅니다(§8.2).
  - 브라우저 도구(`opencode.browser`)는 config로 끄지 않습니다. 설치 프로필별 `"-opencode.browser"`는 쓰지 않습니다. 서비스가 하나라 전역으로 끄면 데스크톱 세션에서도 사라지기 때문입니다. 대신 브라우저 패인이 없는 호스트(웹·모바일)가 **세션을 만들 때** 세션 권한 `{action:"browser", resource:"*", effect:"deny"}`를 새깁니다(05 §8.7, 03 §18.15).
  - upstream 설치본의 config(`~/.config/opencode/opencode.json[c]`)에는 쓰지 않습니다.
- 루트 `package.json`의 `workspaces.packages`에 이미 `packages/*`가 있으므로 `packages/own-*`가 자동으로 포함됩니다. **루트 파일은 고치지 않습니다.**
- 패키지 이름은 `@own/*`입니다. upstream의 `@opencode/*`와 충돌하지 않습니다. 예외는 `own-desktop` 하나입니다. electron-builder가 설치 디렉터리 이름(`%LOCALAPPDATA%\Programs\own-desktop`)을 package name에서 만들기 때문에 scope 없는 이름을 씁니다.
- 루트 `.gitignore`에 `dist`가 이미 있어서 `packages/own-*/dist`는 무시됩니다. `own/` 산출물은 `own/.gitignore`로 처리합니다.
- `bun.lock`에는 불가피하게 우리 항목이 들어갑니다. 이 파일은 ledger 예외이며, merge할 때 theirs를 택하고 재생성합니다(§5).

---

## 2. 브랜치와 태그

| 이름 | 용도 | 규칙 |
|---|---|---|
| `upstream-v2` | upstream 기본 브랜치(`dev`, 예전 `v2`) 미러 | `--ff-only`로만 갱신합니다. 우리 커밋은 금지입니다. `origin`에도 push해서 백업합니다(§4 step 1의 husky 예외). |
| `main` | 우리 제품의 기준선 | upstream merge 커밋과 우리 커밋만 둡니다. 항상 빌드 가능해야 합니다. |
| `sync/v2.0.N` | upstream merge 작업 | 검증을 통과하면 `main`에 ff-merge하고 삭제합니다. |
| `feat/*`, `fix/*`, `poc/*` | 기능 작업 | `main`에서 분기합니다. sync 중에는 새로 만들지 않습니다. |
| `own-patch/P-xxx` | (선택) 코어 패치 작업 | 커밋 1개로 squash해서 `main`에 넣습니다. |
| 태그 `v2.0.N-own.K` | 릴리스 | upstream 태그와 이름이 겹치지 않습니다. upstream 태그는 fetch하지 않습니다(§3). |

---

## 3. 1회 설정

Git Bash 기준입니다. PowerShell에서도 `git` 명령은 같습니다.

**GitHub Actions 비활성화 (완료, 2026-09-26 확인)**
- `main`이 `origin`의 기본 브랜치이므로, Actions가 켜져 있으면 upstream의 schedule workflow가 우리 저장소에서 돕니다: `close-issues.yml`, `close-prs.yml`, `compliance-close.yml`, `docs-update.yml`, `stats.yml`(`.github/workflows/`에서 `schedule:`이 있는 파일).
- 그래서 이 설정은 Phase 0이 아니라 **저장소를 push한 즉시** 해야 합니다. 2026-09-26에 `gh api repos/NA-DEGEN-GIRL/own-open-code/actions/permissions`가 `{"enabled":false,…}`를 돌려주는 것을 확인했습니다.
- 다시 켜진 것을 발견하면 바로 아래 명령을 실행합니다. 확인 명령은 릴리스 체크리스트(§11)에 있습니다.

```bash
# 비공개 저장소(이름을 바꾼 뒤에는 own-open-code-private)와 공개 저장소 둘 다
gh api -X PUT repos/NA-DEGEN-GIRL/own-open-code-private/actions/permissions -F enabled=false
gh api repos/NA-DEGEN-GIRL/own-open-code-private/actions/permissions      # {"enabled":false,...} 확인
gh api repos/NA-DEGEN-GIRL/own-open-code/actions/permissions              # 공개 저장소도 {"enabled":false,...}
```

**로컬 git 설정**

```bash
cd /d/own-open-code          # 작업 트리(worktree). "#"이 든 경로는 쓰지 않음 (§11)

# 충돌 해결을 기억해서 다음 merge에 재사용
git config rerere.enabled true
git config rerere.autoupdate true

# upstream으로 실수로 push하는 것을 막고, upstream 태그는 받지 않음
git remote set-url --push upstream DISABLED
git config remote.upstream.tagOpt --no-tags

# (선택) bun.lock을 merge할 때 자동으로 theirs 선택 — 로컬 전용, .gitattributes는 수정하지 않음
git config merge.theirs-lock.name "take upstream lockfile, regenerate later"
git config merge.theirs-lock.driver "cp -f %B %A"
printf 'bun.lock merge=theirs-lock\n' >> .git/info/attributes
```

**Bun과 husky (로컬 CI 게이트)**
- **Bun은 1.4.4가 설치돼 있습니다(2026-10-31, merge round 8, MR8-22; 1.4.2는 2026-09-27, §11).** 설치할 버전은 루트 `package.json`의 `packageManager`(현재 `bun@1.4.4`, upstream v2.2.1)입니다. 설치는 처음과 같이 WinGet Node 폴더의 npm 전역 패키지(`npm i -g bun@<ver>`)이고, 되돌릴 때는 `npm i -g bun@<이전 판>`입니다. upstream이 이 값을 올리면 sync 때 그 버전을 먼저 설치합니다(§4 step 5, §11).
- 설치한 뒤 `bun install`을 실행하면 루트 `prepare`가 husky(9.1.7)를 설치합니다. 이후 `git push` 때마다 `.husky/pre-push`가 Bun 버전이 `packageManager`와 맞는지 확인하고 `bun run check`를 실행합니다. `check`는 `oxlint` + `bun turbo typecheck --concurrency=3`이고, `packages/console/*`, `packages/stats/*`, desktop을 포함한 **모노레포 전체**를 검사합니다.
- **기준선(P0).** Windows에서 `bun run check`를 돌려, upstream 패키지 중 lint/typecheck가 실패하는 것을 `own/ledger/typecheck-baseline.yaml`에 기록합니다(`{upstream_commit, failing: [{package, tool, count}]}`). `packages/own-*`는 기준선에 들어갈 수 없습니다. 2026-09-27 현재는 심볼릭 링크를 복구한 뒤 전체가 통과하므로 기준선이 비어 있습니다(§11).
- **원칙은 우회 금지**(`--no-verify` 금지)입니다. 예외는 아래 두 경우뿐이고, 둘 다 `HUSKY=0`(husky 9의 훅 끄기)으로만 하며 `SYNC_LOG.md`에 기록합니다.
  - (a) **미러 push**: `HUSKY=0 git push origin upstream-v2`. upstream 코드 그대로이므로 우리 게이트의 대상이 아닙니다. 체크아웃된 트리를 검사하는 훅이 미러에서 실패하면 백업이 막히기 때문입니다.
  - (b) **기준선과 같은 실패**: `own/scripts/check.ps1 -Baseline`(예정)이 `bun turbo typecheck --continue`와 oxlint를 돌려 실패 집합이 기준선과 **같거나 작고**, `packages/own-*`는 모두 통과함을 확인한 경우에만 `HUSKY=0 git push origin main`을 허용합니다. SYNC_LOG에 check.ps1 출력 요약을 남기고, 기준선이 줄었으면 파일을 갱신합니다.
- Bun이 없는 기계에서는 `bun install`을 할 수 없으므로 husky 훅도 설치되지 않습니다. 그때는 Node 전용 검사(`check-ledger.mjs`, `check-surface.mjs`)만 실행합니다.

---

## 4. upstream 동기화 절차

- **주기**: 주 1회. 필요한 upstream 수정이 들어왔으면 그때 수시로 합니다. **기능 작업 도중에는 하지 않습니다.**
- **merge 지점**: 기본은 최신 release marker 커밋(`sync release versions for v2.0.N`)입니다. v2의 `v2.0.N` 태그는 v2 브랜치 밖의 커밋을 가리키므로 쓰지 않습니다 `[research]`.
- **tip merge**: 필요한 수정이 marker 이후에 있으면 `upstream-v2` tip이나 특정 커밋까지 merge해도 됩니다. 이 경우 사유를 `SYNC_LOG.md`에 적습니다. 현재 `main`은 marker `39021dfd67`보다 5커밋 앞선 tip(`00d179015f`)에서 시작했습니다.

```bash
cd /d/own-open-code
test -z "$(git status --porcelain)" || { echo "작업 트리가 깨끗하지 않음"; exit 1; }

# 1) 미러 갱신 (미러 push만 husky 예외, §3 (a))
git fetch upstream +refs/heads/dev:refs/remotes/upstream/dev --no-tags
git switch upstream-v2
git merge --ff-only upstream/dev
HUSKY=0 git push origin upstream-v2

# 2) merge 대상 선택 (기본: 최신 release marker)
REL=$(git log upstream-v2 --grep '^sync release versions for v2' -1 --format=%H)
# 새 marker가 없으면(이미 main의 조상이면) 여기서 끝낸다. 없으면 빈 sync 브랜치가 생긴다.
git merge-base --is-ancestor "$REL" main && { echo "no new release marker"; git switch main; exit 0; }
VER=$(git log -1 --format=%s "$REL" | sed 's/^sync release versions for v//')   # 예: 2.0.19
git log --oneline main.."$REL" | wc -l                                           # 들어올 커밋 수
git diff --stat "$(git merge-base main "$REL")" "$REL" -- $(node own/scripts/check-ledger.mjs --list-files)  # 패치 파일에 upstream 변경이 있는지 미리 확인
git show "$REL:package.json" | grep '"packageManager"'                           # Bun 버전이 바뀌었는지

# 3) sync 브랜치에서 merge
git switch -c "sync/v$VER" main
git merge --no-ff "$REL" -m "merge upstream v$VER ($(git rev-parse --short "$REL"))"

# 4) 충돌 해결 (§5 정책)
git diff --name-only --diff-filter=U                 # 충돌 파일 목록
git checkout --theirs bun.lock && git add bun.lock   # merge driver를 설정했다면 생략
#   ledger 패치 파일: 패치 의도대로 다시 적용하고 OWN-PATCH 마커 유지 → git add
#   그 밖의 upstream 파일: theirs (원래 우리 diff가 없어야 함)
git commit --no-edit                                 # merge 커밋 완료

# 5) 재생성과 검증
#   packageManager의 Bun 버전이 바뀌었으면 먼저 그 버전을 설치 (pre-push가 버전을 검사함)
bun install                                          # bun.lock 재생성 (우리 workspace 항목 복원)
git add bun.lock && git commit -m "chore(own): regenerate bun.lock for upstream v$VER" || true
node own/scripts/check-ledger.mjs                    # upstream 대비 diff == active 패치 + 미흡수 cherry-pick
node own/scripts/check-surface.mjs                   # 우리가 의존하는 upstream 계약이 그대로인지
#   --update가 적는 recordedAt.upstream은 `git merge-base HEAD upstream-v2`다. 미러가 이번 release보다 늦으면
#   (sync를 미러보다 먼저 한 브랜치) 옛 release가 적히므로, 먼저 로컬 미러를 앞으로 옮긴다(push하지 않음):
#   git update-ref refs/heads/upstream-v2 "$REL" "$(git rev-parse upstream-v2)"   # merge round 8에서 79349e840f로
bun run typecheck                                    # turbo typecheck (packages/own-* 포함). 실패는 기준선과 비교
(cd packages/own-protocol && bun test)
(cd packages/own-runtime && bun test)
(cd packages/own-accounts && bun test)               # e2e-kit(upstream 서버 소스 부팅) 포함
(cd packages/own-telemetry && bun test)
(cd packages/own-remote && bun test)                 # (R0 이후) vendor한 SSH 모듈 테스트 포함
(cd packages/own-team && bun test --timeout 900000) # (T1 이후) git 픽스처, 가짜 PluginContext, 서버 부팅 e2e(가짜 LLM 지시문). 약 20분
(cd packages/own-computer-use && bun test)           # 단위 + 서버 부팅 e2e(소스·번들). 실제 데스크톱 시험은 OWN_CU_REAL=1일 때만
(cd packages/own-import && bun test test/unit && bun run test:e2e)  # (IMPORT 이후) 단위 + own-team 하네스로 서버 부팅 e2e(I1·옮기기·보조 세션).
#   fixture는 모두 합성이고 실제 ~/.codex·~/.claude는 읽지 않음. IG5 성능은 쉬는 PC에서 bun run test:perf(OWN_IMPORT_PERF=1)
(cd packages/own-harness && bun test)                # (H0 이후) 단위: 세션별 하네스 바인딩·옵션·codex-data(10)
(cd packages/own-web && bun run test)                # (P3 이후) 단위. 팀·프리셋 화면 e2e는 bun run test:e2e:team, test:e2e:presets(06 §11.2),
#   다른 도구의 대화 화면은 bun run build && bun run test:e2e:import(09, Edge, 합성 원본)
(cd packages/core && bun run script/test.ts <원장 verify 줄의 파일>)  # core 패치 verify. 전체 suite는 순수 upstream과 비교
(cd packages/ai && bun test)                         # P-018·P-021~P-024·P-026 verify(v2.2.5 이후 아무 단계도 안 돌려 6개가 못 읽힌 채였음, MR12-2)
(cd packages/server && bun test test/session-reset-media.test.ts test/session-synthetic-background.test.ts)  # P-035
(cd packages/schema && bun test)                     # P-018·P-035의 event-manifest
(cd packages/client && bun run check:generated) && (cd packages/protocol && bun run check:generated)
bun run --cwd packages/own-desktop build             # (P4 이후) 치환 키가 모두 매칭되는지(buildEnd), deep import와 @opencode/app export 경로(§7)가 살아 있는지
bun own/scripts/release-smoke.ts                     # own 채널 빌드 → 설치 레이아웃 → service → RPC health → fake-provider 왕복
#   upstream이 packages/desktop, packages/plugin-browser, packages/app(desktop main이 import하는 export 6개(§7)와
#   e2e/performance)를 바꿨으면 check-surface의 drift 보고를 검토하고 G-D1·G-D2(01 §16.2)와 PF2–PF4를 다시 본다.
#   rpcHash 입력(§8.2 1b)이 바뀌었으면 G-D6, plugin-browser나 packages/gui-extensions/src/browser가 바뀌었으면
#   G-D5(P5 이후, own-desktop scripts/browser-agent.ts)도 다시 본다

# 6) 반영
git switch main
git merge --ff-only "sync/v$VER"
git push origin main                                 # pre-push(husky)가 bun run check 실행 (§3 예외 (b) 참고)
git branch -d "sync/v$VER"

# 7) 기록: own/ledger/SYNC_LOG.md에 항목 추가 (아래 형식)
```

**merge 범위에 특정 upstream 커밋이 들어올 때** (2026-10-05, `own/reports/external-repos-2026-10-05.md`)

두 커밋 모두 v2.0.24 sync(2026-10-07)에서 들어와 아래대로 처리했습니다(`SYNC_LOG.md` v2.0.24 항목). 이후 sync에는 해당하지 않고, 같은 계약은 surface 항목 `session-output-limit`·`session-instruction-order`·`env-builtin`이 지킵니다. 아래는 그때의 지시로 남깁니다.

- **`d9987ef9c8` 이상을 merge하기 전**(`feat(core): fit output limits to the context window`). 이 커밋부터 core가 primary·compaction 요청에 `maxTokens`를 넣습니다. ChatGPT 백엔드가 이를 거절하므로 upstream은 providerID `openai`에서만 지웁니다(`plugin/provider/openai.ts` `omitOutputLimit`). own slot은 이 예외에 걸리지 않으므로 merge 전에 두 가지가 `main`에 있는지 확인합니다.
  - own-accounts 요청 형성(`packages/own-accounts/src/auth/auth.ts` `onRequestShape`의 `NO_OUTPUT_LIMIT`, 2026-10-05 들어감)이 `own-codex-*`·`own-oai-*` slot의 `context`·`compaction` 요청에서 `maxTokens`를 지웁니다. 없으면 ChatGPT 계정 세션이 모두 거절될 수 있습니다.
  - ds `none` 변형의 출력 한도 결정 D2(같은 `onRequestShape`, `Auth.DS_THINKING_OFF_OUTPUT`, 2026-10-05 들어감): own은 `maxTokens`가 비어 있을 때만 65,536을 넣으므로 merge 뒤에는 upstream이 넣은 값이 이기고 own 쪽은 저절로 물러납니다. merge 뒤 할 일은 없고, ds `none` 요청의 `max_tokens`가 core 값인지만 봅니다.
  - 둘 다 `context`·`compaction` hook에서만 합니다(upstream `omitOutputLimit`과 같은 범위). `generate` 호출자가 정한 한도는 건드리지 않습니다.
  - **merge 중에 P-017을 다시 적용합니다.** 이 커밋은 P-017이 고친 영역을 다시 씁니다. `estimateContext`가 `{measured, estimated}`를 돌려주는 `estimatePrompt`가 되고, runner(`session/runner/llm.ts`)는 새 출력 한도를 `SessionCompaction.estimatePrompt(loaded)`로 `shared` 없이 계산합니다. 그래서 P-017은 이 merge에서 충돌하고, 그대로 두면 같은 모델의 다른 slot 측정값이 출력 한도 경로에 닿지 않습니다. `estimatePrompt`에 P-017을 다시 적용하고, runner의 출력 한도 경로에도 `shared`를 넘길지 정한 뒤(P-016의 `why`가 그 경로를 이유로 듦) P-017 시험을 다시 돌립니다(ledger P-017 `merge_note`).
- **`bda798b167`을 처음 들이는 merge**(`fix(core): drop session ID and order instructions for prompt-cache reuse`). 내장 지시에서 세션 ID 줄을 빼고 지시 순서를 바꿉니다(`core/date`가 앞으로). 모든 세션의 지시 기준선이 한 번 다시 렌더링되므로 **활성 세션마다 cold 요청이 1회** 생깁니다. 그 merge의 `SYNC_LOG.md` 항목과 그 merge를 싣는 릴리스 노트에 반드시 적습니다. check-surface는 `env-builtin`을 CHANGED로 보고합니다(예상된 변화, §7).

**`SYNC_LOG.md` 항목 형식**

```markdown
## 2026-10-03 · upstream v2.0.19 (`abcdef1234`) → main `1234abcd`
- 범위: 00d179015f..abcdef1234 (NNN commits), marker merge / tip merge 사유: …
- 충돌: bun.lock(theirs+regen), packages/cli/script/app-assets.ts (P-001 재적용)
- 패치 상태: P-001 active, P-002 active
- cherry-pick 흡수: (없음 | <sha> → cherry-picks.yaml에서 제거)
- surface 변화: (check-surface 출력 요약) 예) SessionModelRequest 필드 추가, 영향 없음
- 검증: typecheck ✅(기준선 대비 신규 실패 0) own tests ✅ smoke ✅ G2 인증 주입 재검 ✅
- Bun: packageManager bun@1.4.2 (변경 없음)
- husky 예외: 미러 push HUSKY=0 / main push 정상
- claude-auth shim override(@opencode/plugin) 갱신: 2.0.18 → 2.0.19, G9 재검 ✅
```

**rebase하지 않는 이유**
- 저장소가 private이고 협업자가 없으므로 선형 이력의 이점이 작습니다.
- merge를 쓰면 rerere가 충돌 해결을 재사용합니다.
- upstream 이력(하루 약 50커밋)을 우리 커밋 위로 다시 쓰지 않으므로 감사 추적이 쉽습니다.
- 패치가 너무 낡으면 새 `own-patch(P-xxx)` 커밋으로 다시 만듭니다.

**긴급 cherry-pick**
- 기본은 **tip merge**(위 "tip merge")입니다. 필요한 수정만 급히 받아야 하고 tip merge가 부담스러울 때만 `git cherry-pick -x <upstream sha>`로 `main`에 가져옵니다.
- cherry-pick한 커밋은 `git diff upstream-v2...main`에서 "ledger에 없는 upstream 파일 변경"으로 보입니다. 그래서 같은 커밋에서 `own/ledger/cherry-picks.yaml`에 항목을 추가합니다.

```yaml
- upstream_sha: 0123456789abcdef0123456789abcdef01234567
  picked_as: <main의 커밋 sha>
  files: [packages/core/src/session/compaction.ts]
  reason: "compaction 무한 루프 수정 (upstream PR #NNNNN)"
  date: 2026-10-01
```

- `check-ledger.mjs`는 `upstream_sha`가 아직 `git merge-base main upstream-v2`의 조상이 아니면 그 `files`의 diff를 허용합니다. 다음 merge로 merge-base가 그 sha를 지나가면 항목을 "흡수됨"으로 보고하고, 그 sync에서 항목을 지웁니다.
- `SYNC_LOG.md`에 "cherry-picked"로 기록합니다.

---

## 5. 충돌 정책

| 경로 | 정책 |
|---|---|
| `own/**`, `packages/own-*/**` | 우리 것을 유지합니다. upstream은 건드리지 않으므로 충돌이 나지 않아야 합니다. 충돌이 나면 upstream이 같은 이름을 새로 만든 것이므로 **즉시 조사**합니다. |
| `bun.lock` | **theirs를 택하고 `bun install`로 재생성**합니다. 손으로 합치지 않습니다. |
| `nix/**`, `flake.*` | theirs. nix는 쓰지 않습니다. `bun.lock`이 달라서 nix 해시가 어긋나도 무시합니다. |
| `.github/**` | theirs. Actions가 저장소 단위로 꺼져 있으므로 실행되지 않습니다(§3). |
| `README*.md`(P-065, 2026-11-26) | `README.md`와 `README.ko.md`는 **ours**(`git checkout --ours README.md README.ko.md && git add README.md README.ko.md`), 나머지 번역본은 own에 없으므로 upstream이 고쳐서 `deleted by us`로 나오면 다시 지웁니다(`git status --porcelain \| sed -n 's/^DU \(README\..*\.md\)$/\1/p' \| xargs -r git rm -q`). upstream이 새 번역본을 더하면 충돌 없이 들어오므로 그것도 `git rm`하고 ledger P-065의 `removed` 목록에 더합니다. upstream README의 새 내용(설치 방법 등)은 own에 해당하지 않습니다. |
| ledger에 있는 패치 파일 | upstream 변경을 먼저 받아들인 뒤 **패치 의도를 최소한으로 다시 적용**하고 `OWN-PATCH(P-xxx)` 마커를 유지합니다. 영역이 크게 바뀌었으면 ledger의 `anchor`를 갱신하고, 패치가 불필요해졌으면(upstream이 같은 기능을 제공) `status: upstreamed`로 바꾸고 제거합니다. |
| cherry-pick한 파일 | theirs. upstream이 같은 커밋을 가져왔으므로 우리 쪽 사본을 버리고, `cherry-picks.yaml` 항목을 지웁니다. |
| cherry-pick과 active 패치가 함께 있는 파일 (2026-10-11: `packages/core/test/session-runner.test.ts`, c9e1ed7080 + P-018) | upstream이 그 cherry-pick을 가져왔으면 theirs를 택한 뒤 패치의 `OWN-PATCH` 구간만 다시 넣습니다. 아직이면 일반 패치 파일처럼 다룹니다. `check-ledger.mjs`는 이런 파일을 active 패치 파일로 검사합니다(§6.4 3). |
| upstream이 패치 파일을 rename/삭제 | rename이면 경로를 따라가서 ledger `path`를 갱신합니다. 삭제면 해당 기능을 어디로 옮겼는지 찾아서 새 anchor를 정하고, 안 되면 대안을 설계합니다(sync 보류). |
| 그 밖의 upstream 파일 | theirs. 우리 diff가 없어야 합니다(`check-ledger.mjs`가 보장). |
| 벤더 복사본 (own-web 안의 `packages/app` 유래 파일, own-remote 안의 desktop SSH 모듈, own-desktop의 `src/main/index.ts`·`src/main/desktop.ts`, (선택) `src/preload/index.ts`) | 텍스트 충돌은 없습니다. `check-surface.mjs`가 원본 해시 변화를 **drift**로 보고하면 수동으로 검토하고, `vendored.yaml`의 커밋과 해시를 갱신합니다. |
| own-desktop이 빌드 시 치환하거나 deep import하는 upstream 파일 (`packages/desktop/src/main/constants.ts`, `lifecycle/environment.ts`, `extension/manager.ts`, `windows/security.ts`(VOICE), `packages/gui-extensions/src/main.ts`, own-web이 쓰는 `renderer/ipc-client.ts` 등), 그리고 desktop main이 import하는 `@opencode/app` export 대상(v2.0.24부터 2개, §7) | 텍스트 충돌은 없습니다. upstream이 파일을 옮기거나 이름을 바꾸면 own-desktop 빌드가 `buildEnd` 검사나 모듈 해석 실패로 멈춥니다. own-web이 `packages/app`를 대체해도 own-desktop 빌드는 이 6개로 `packages/app`에 묶여 있습니다. 치환본을 새 원본에 맞춰 다시 만들고 `vendored.yaml`을 갱신합니다. 치환 대상의 동작이 바뀌었으면(예: 새 env 주입, 새 프로토콜 등록) G-D1·G-D2를 다시 봅니다 |
| 컴파일 drift (`@opencode/session-ui`/`client`/`ui` API 변경) | own-web의 **adapter 층(`packages/own-web/src/adapter/`, 03 §16.1)**에서만 흡수합니다. typecheck가 실패하면 sync 브랜치에서 고친 뒤에 반영합니다. |

**sync 중단 기준**
- check-surface에서 **계약 파괴**가 발견된 경우: 훅 이름이나 필드 변경, `model.request` trigger 위치 변경, Auth.none 조건 변경, cache-policy 상수 변경, 플러그인 자동 발견 규칙 변경, RPC 경로 변경 등.
- 스모크 테스트의 G2(인증 주입)가 실패한 경우.
- typecheck의 신규 실패가 `packages/own-*`에서 난 경우(기준선 예외 불가).
- own-desktop 빌드가 치환 키 불일치로 실패했는데, 치환 대상의 새 동작이 서비스 기동·프로토콜 등록·업데이터에 닿는 경우. 01 §4.1 표의 `background-service.ts`, `lifecycle/environment.ts`, `constants.ts` 행과 GUI 확장 호스트의 내장 목록·관리자(`packages/gui-extensions/src/main.ts`, `extension/manager.ts`, 05 §8.1)가 여기에 해당합니다.

이때는 `main`에 반영하지 않고, 대응 설계를 먼저 합니다.

---

## 6. 코어 패치 규칙과 ledger

### 6.1 규칙
1. 플러그인 API, config, HTTP API로 해결할 수 있으면 패치하지 않습니다.
2. 크기는 **30줄 이하**입니다. 대상 파일은 최근 30일 upstream 커밋이 **5회 이하**여야 합니다. 예외는 ledger에 사유를 적고 upstream PR(또는 issue)을 먼저 올렸을 때만 허용합니다. 예외가 필요한 항목은 상태에 "예외 승인 필요"를 붙입니다.
   - P-017(`compaction.ts` churn 20, 그 시험 16, `session/runner/llm.ts` 9. upstream-v2 미러 `e1b7299bc9` 기준, 그전 미러로는 17·12)은 2026-10-07 사용자가 이 패치에 한해 upstream 먼저 규칙을 면제했습니다(ledger `exception_approval`, §12 Q19 (a)(b) 해결).
   - P-018(멈춘 모델 스트림 감시, 2026-10-11)은 사용자가 코어 패치 예외로 승인했습니다(ledger `exception_approval`). churn(`ai/src/schema/options.ts` 6, `core/src/provider.ts` 12, 두 core 시험 7·23)과 마커 사이 줄 수(`ai/src/route/client.ts` 83, 새 ai 시험 249, core 시험 73·35·77)가 규칙을 넘고, upstream issue/PR은 올리지 않았습니다(올리려면 사용자 승인).
   - v2.0.24 sync에서 runner 출력 한도 경로(`runner/llm.ts`)가 P-017에 더해져 마커 사이가 34 + 4 = 38줄로 30줄 상한을 넘습니다. 같은 의도의 확장이라 2026-10-08 작업 지시로 받아들였습니다(§12 Q19 (c) 해결).
3. 코드에 `// OWN-PATCH(P-xxx) begin` … `// OWN-PATCH(P-xxx) end` 마커를 답니다.
4. 커밋은 패치당 1개이고, 제목은 `own-patch(P-xxx): <imperative>`입니다. 같은 커밋에서 ledger의 `status`를 `planned`→`active`로 바꿉니다.
   - 지금 active인 여섯은 이 규칙을 지키지 못하고 기능 커밋 안에 들어갔습니다. P-001·P-002는 phase 3 커밋, P-014는 작업 공간 설정 커밋, P-015–P-017은 EXT wave 커밋입니다. ledger `commits`에 그 커밋을 적어 두었습니다. 이미 올린 이력은 다시 쓰지 않고, 새 패치부터 이 규칙을 지킵니다.
   - P-018은 작업 지시(2026-10-11)대로 패키지별 conventional 커밋 두 개(`fix(ai): …`, `fix(core): …`)로 나눠 넣었고, 두 제목 모두 `P-018`을 적습니다.
5. **예산**
   - 처음 계획(2026-09-26)은 데스크톱 모드(기본 제품) 0개, 웹 폴백 전용 planned P-001/P-002 2개였습니다(01 §12.1).
   - 지금(2026-10-28) active는 26개입니다. 셈에 드는 6개는 P-001·P-002(웹 폴백), P-014(버전 확인의 런타임 초기화 생략), P-015(PowerShell UTF-8 출력), P-016(한글·CJK 토큰 추정), P-017(같은 모델 slot 사이 측정값)입니다. 나머지 20개는 한도 초과 예외입니다. P-018(멈춘 모델 스트림 감시), P-019…P-026·P-028(own harness가 쓰는 core seam, H-D6), P-027(AGENTS.md의 한국어 보고 지시), P-029(실패하던 core 시험 세 개를 고친 시험 전용 패치, FT-D1), P-030(core shell 도구가 명령 노드 없는 명령도 묻게 함), P-031(grep·glob이 read 규칙을 따름), P-032(요청 hook이 256,000 상한 전의 출력 한도를 봄, 출력 상한 설정 02 §4.9), P-033(0x80000000 이상인 Windows PTY 종료 코드를 부호 없는 값으로 기록, 음수 코드 하나로 `GET /api/pty`가 400이던 문제), P-034(요약 압축이 대화 전체를 먼저 보내 세션 캐시를 이어 씀, H-D6 형식의 seam, 11 §2.1), P-035(되돌릴 수 있는 문맥 비우기 경계, 처음으로 공개 HttpApi를 바꾸는 패치, 그 전달 규칙을 AGENTS.md에도 한 줄 적음, 03 §18.18·11 §7), P-036(Markdown 머리말을 YAML로만 읽어 gray-matter의 `---js` eval을 막음, SK2-C1, upstream 이슈는 올리지 않음), P-037(세션이 없는 own의 control Location을 core의 한 시간 정리에서 빼 둠, SSH 터널·자격 중개·팀 리더가 61분 만에 끊기던 문제, RH-13)입니다. P-030은 2026-10-17(RO-Q1), P-031은 2026-10-18(GR-1), P-032는 2026-10-19(OL), P-033은 2026-10-22(PX), P-034는 2026-10-24(CC), P-035는 2026-10-24(RC, 2026-10-25 다시 확인), P-036은 2026-10-25(SK2-C1) 사용자가 승인했습니다. P-037은 사용자가 2026-10-27에 core 패치 판단을 맡긴 대로 2026-10-28에 넣었습니다(RH-13). 2026-10-31(CAG, 브랜치 `claude-agent`)에는 같은 위임으로 P-045(Claude Agent의 claude가 own이 정한 계정 폴더에서만 뜨고 그 폴더의 기록을 읽음. 처음 번호는 P-038이었는데 merge-round8이 그 번호를 "Command editor get"에 먼저 써서 2026-11-01에 바꿨습니다. 같은 날 2단계로 대화마다의 폴더와 폴더 없는 기록 확인의 닫힘을 더했습니다), P-039(Claude Code의 한도 보고와 사용량 답을 플러그인에 넘김), P-042(claude에 서비스 env의 허용 목록만 줌)를 넣었고, 2026-11-01 3단계에 P-043(Claude가 보지 못한 기록을 Claude Code의 원래 형식 기록으로 써서 이어 받게 함, 기록의 확인·되돌리기 더미·안 쓰는 기록 지우기)과 P-044(살아 있는 claude 프로세스 수의 상한, LRU, 붙잡힌 프로세스 보호, 짧은 쉼 타이머, 예비)를 넣었습니다. 다섯 다 cherry-pick한 upstream Claude Agent 프로바이더(`packages/core/src/plugin/provider/claude-agent/`, `own/ledger/cherry-picks.yaml`) 안이라 upstream-v2의 churn은 0입니다. 2026-11-03에는 같은 위임으로 P-051(설치된 Claude Code가 초기화 답에 버전을 싣지 않으면 `--version`을 읽고, 그래도 모르면 막지 않음, 창이 하나도 없는 모델 목록은 시작할 때 다시 확인, 02 §8.10.14)을, 사용자 결정(CAG-R, "원격에서도 되도록")으로 P-052(SSH 호스트 대화의 Claude Agent가 이 PC의 claude를 own 브로커로 몰고, PC가 인자·env·입력을 거르고 자기 풀에 셈, 02 §8.10.13)를 넣었습니다. 기본 제품도 P-014–P-018 다섯 개를 씁니다. planned 패치는 없습니다.
   - 동시에 active인 패치는 최대 6개입니다. 지금 셈에 드는 것이 6/6이므로 코어 패치를 더 넣으려면 먼저 하나를 내립니다(`upstreamed`·`dropped`).
   - **한도 초과 예외**: 2026-10-11 사용자가 P-018을 한도를 넘겨 7번째로 승인했습니다. ledger에 `over_budget: true`와 사용자의 `exception_approval`을 적은 패치는 셈에서 빠지고, `check-ledger.mjs`는 경고로 알립니다. `exception_approval`이 없으면 실패합니다. 이 예외는 패치마다 사용자의 명시적 결정으로만 붙입니다.
6. 모든 패치에 `verify`(재현 테스트나 수동 절차)와 `remove_when`(제거 조건)을 적습니다.
7. ID는 이 ledger의 `P-0xx`가 정본입니다. 다른 문서(01·02·03)도 `P-0xx`를 직접 인용합니다.

### 6.2 ledger 형식 (`own/ledger/core-patches.yaml`)

```yaml
- id: P-001
  title: "Select the embedded web app root via OPENCODE_WEB_APP"
  status: planned            # planned(아직 적용 안 함) | active(적용됨) | candidate | upstreamed | dropped | rejected
  files:
    - path: packages/cli/script/app-assets.ts
      anchor: 'const root = path.resolve(import.meta.dirname, "../../app")'   # 줄 번호가 아니라 안정적인 코드 조각
      marker: "OWN-PATCH(P-001)"
      churn_30d: 2
  why: "own-web을 CLI 바이너리에 임베드해 same-origin으로 서빙(pairing 쿠키). 플러그인 API에는 정적 자산 경로가 없음"
  alternatives_rejected:
    - "별도 정적 서버+리버스 프록시: 가능하지만 프로세스가 하나 더 생김(G11 실패 시 fallback)"
    - "packages/app 수정: 30일 churn 332, Codex형 레이아웃 불가"
  upstream: { issue: null, pr: null, target_branch: v2 }
  commits: []
  verify: ["OPENCODE_WEB_APP=own-web bun run --cwd packages/cli build --single → own-web 자산이 서빙되는지(G11)"]
  remove_when: "upstream이 커스텀 앱 루트 빌드 옵션을 제공"
  added: 2026-09-26
```

### 6.3 초기 ledger

churn30은 2026-08-27부터 2026-09-26까지 `upstream-v2`에서 해당 파일을 건드린 커밋 수입니다(로컬에서 `git log upstream-v2 --since=2026-08-27 -- <file>`로 측정).

| ID | 상태 | 파일 (anchor) | 내용 | 크기 | churn30 | upstream PR 후보 | 활성화 조건 / 제거 조건 |
|---|---|---|---|---|---|---|---|
| **P-001** | **planned (웹 폴백 전용)** | `packages/cli/script/app-assets.ts:8` (`const root = …"../../app"`) | `path.resolve(import.meta.dirname, "../..", process.env.OPENCODE_WEB_APP ?? "app")`. own-web 빌드는 이 스크립트가 넘겨주는 `OPENCODE_CHANNEL`과 `VITE_OPENCODE_SERVER_MODE=origin`을 따르고, `vite build` 결과를 `dist/`에 둠. 데스크톱 렌더러는 이 패치 없이 `app\<ver>\web`에서 뜸 | 1–2줄 | 2 | **예** | P3(own-web 코어)에서 웹 폴백과 함께 적용 / upstream이 옵션을 제공하거나, 게이트웨이 서빙으로 바꾸면 제거(01 §12.2) |
| **P-002** | **planned (웹 폴백 전용)** | `packages/cli/src/app-assets.ts:22` (`const root = …"../../app/dist"`) | local 채널(소스 실행)에서 같은 선택 | 1–2줄 | 1 | **예** (P-001과 같은 PR) | P-001과 같음 |
| P-003 | candidate | `packages/util/src/global.ts:12` (`const app = "opencode"`) | 채널별 앱 루트로 config/data/state/cache를 완전히 격리. `OPENCODE_CONFIG_DIR` env 의존 제거 | 3–5줄 | 0 | 보류 | G1에서 env 브리지(01 §5.2)로도 막지 못하는 경로가 확인되면 |
| P-004 | candidate (**예외 승인 필요**) | `packages/ai/src/route/executor.ts`, `packages/schema/src/session-error.ts`, `packages/core/src/session/to-session-error.ts` | retry 이벤트와 SessionError에 `retryAfterMs`와 rate-limit 상세(utilization/status 포함)를 실음. `to-session-error.ts`가 churn 6으로 규칙(≤5)을 넘으므로, 켤 때는 core 쪽을 매핑 1–2줄로 줄이거나 예외 승인 | 약 25줄 | 3 / 0 / **6** | 예 | G8에서 `http.response`·`ws.receive` 기반 상관 판정이 불안정할 때 |
| P-005 | candidate (**예외 승인 필요**) | `packages/core/src/session/model-request.ts` | WS handshake 응답 헤더를 플러그인 훅으로 노출 | 약 15줄 | **18** | 예 | G7에서 Codex 한도를 WS 경로로 얻지 못할 때(대안: in-band `codex.rate_limits`, HTTP transport) |
| P-006 | candidate (후속) | `packages/core/src/session/usage.ts` (+ schema) | 1h cache write 분리, TTL 반영 비용 | 약 20줄 | 2 | 예 | Anthropic 1h 모드를 도입할 때 |
| P-007 | rejected | `packages/core/src/model-resolver.ts` | 요청별 credential 선택. 세션 밖 LLM 호출(`generate.text`)까지 덮는 유일한 방법(01 §8.3). 관련 upstream 이슈 anomalyco/opencode#50556(계정 전환이 서버 전역, 2026-09-22) | 약 30줄 | **17** | 예 | G2에서 Auth.none 경로와 대체 경로가 모두 실패하거나, 세션 밖 호출 지원이 필요할 때만 재검토 |
| P-008 | rejected | `packages/core/src/plugin/host.ts` | 플러그인 `session.compact/fork` | – | **23** | – | 프런트가 HTTP로 처리 |
| P-009 | rejected | `packages/core/src/plugin/provider/openai.ts` | ChatGPT OAuth 구현 export | – | 13 | – | own-accounts에서 재구현 |
| P-010 | rejected | `packages/core/src/credential.ts`, `packages/core/src/kv.ts` | DB 저장 시 DPAPI 암호화 | – | 2 / 1 | – | 우리 비밀은 DB에 두지 않음(기본 = `own-vault.exe` DPAPI vault). DB 평문 저장은 서드파티 Claude 슬롯의 자체 동작과 명시적 대체 모드(02 §3.7)뿐 |
| P-011 | candidate (후속, **예외 승인 필요**) | `packages/core/src/session/model-request.ts` | 훅에서 요청 단위 `cache` 정책(TTL 포함) 지정 | 약 10줄 | **18** | 예(upstream 제안 우선) | Anthropic 1h 모드를 수동 hint 없이 일반화할 때(01 R9) |
| P-012 | candidate | `packages/core/src/integration.ts` | credential별 refresh 세마포어 | 약 15줄 | **10** (예외 필요) | 예 | 02 §3.7 대체 모드를 켤 때 |
| P-013 | candidate (후속) | `packages/core/src/session/generate.ts` | 세션 `generate`에 model 지정 | 약 10줄 | **6** (예외 필요) | 예 | 인계 요약·떠나기 전 1h 갱신을 다른 모델로 할 때 |

### 6.4 `check-ledger.mjs` 동작 (Node 22, Bun 불필요)

1. `git diff --name-only upstream-v2...main`을 구합니다. merge-base 기준이므로 우리가 바꾼 파일만 나옵니다.
2. 허용 경로를 제외합니다: `own/**`, `packages/own-*/**`, `bun.lock`.
3. `own/ledger/cherry-picks.yaml`에서 `upstream_sha`가 아직 `git merge-base main upstream-v2`의 조상이 **아닌** 항목의 `files`를 제외합니다. 이미 조상이 된 항목은 "흡수됨 — 항목 삭제 필요"로 경고합니다. 단 active 패치도 적은 파일은 제외하지 않고 4·5의 검사를 받습니다(두 diff가 한 파일에 있음, §5).
4. 남은 파일 집합이 ledger에서 **`status: active`**인 `files[].path`와 **정확히 같아야** 합니다.
   - ledger에 없는 변경은 금지입니다(실패).
   - `active`인데 diff가 없으면 stale입니다(실패).
   - `planned`는 "아직 적용하지 않음"이므로 diff가 없어야 정상입니다. `planned`인데 diff가 있으면 "status를 active로 바꿀 것"으로 실패합니다.
5. 각 active 패치 파일에 `OWN-PATCH(P-xxx)` begin/end 마커가 있고, 마커 사이 줄 수가 ledger 한도 이하인지 확인합니다.
   - `generated: true`인 파일(손으로 고치지 않는 생성 결과: P-035의 `packages/client` 생성 클라이언트와 `packages/protocol/openapi.json`)은 마커를 찾지 않습니다. diff 집합(4)에는 그대로 들고, 그 검사는 각 패키지의 `bun run check:generated`입니다(2026-10-24, RC).
   - `unmarked: true`인 파일(주석을 넣을 수 없는 파일: P-066의 `LICENSE`. 라이선스 본문은 그대로여야 GitHub가 MIT로 알아봐요)도 마커를 찾지 않고, 그 패치의 `verify`로 확인합니다(2026-11-26).
   - active 패치 수가 6을 넘으면 실패합니다. `over_budget: true`인 패치는 세지 않되 `exception_approval`이 있어야 하고, 경고로 알립니다(§6.1 규칙 5).
6. `--list-files`는 active·planned 패치 파일과 미흡수 cherry-pick 파일 목록을 출력합니다(§4에서 사용).
   - `removed: true`인 파일(own이 지운 upstream 파일: P-065의 번역 README)은 있으면 실패합니다. merge가 되살린 것을 잡습니다(2026-11-26).
7. `awaiting_approval: true`인 패치(상태와 상관없이)가 있으면 실패합니다. 사용자가 아직 승인하지 않은 패치는 main과 릴리스에 들어가면 안 되기 때문입니다(SK2-20). 그 패치를 준비하는 브랜치 안에서만 `--allow-pending`으로 경고로 바꿔 돌릴 수 있습니다. 릴리스 사슬(§9의 로컬 CI 표, upstream sync와 릴리스 점검표, 빌드 스크립트)은 이 플래그를 쓰지 않습니다. 사용자가 승인하면 `awaiting_approval`을 지우고 `exception_approval`에 그 결정을 적습니다.

---

## 7. 벤더·치환·deep import ledger (`own/ledger/vendored.yaml`)과 surface 목록

upstream 코드를 고치지 않고 가져다 쓰는 방법은 세 가지입니다. 셋 다 코어 패치가 아니므로 `check-ledger.mjs`의 diff 대상이 아닙니다. 대신 전부 `vendored.yaml`에 적고, 의존하는 계약은 `own/upstream-surface.json`에 적습니다.

| `kind` | 뜻 | 예 | upstream이 바뀌면 |
|---|---|---|---|
| `vendor` | 파일을 우리 패키지로 **복사**하고 필요하면 고침 | own-web의 `virtualizer.tsx`, own-remote의 `ssh/command.ts`, own-desktop의 `main/index.ts`·`main/desktop.ts` | check-surface가 원본 해시 drift를 경고합니다. 수동으로 검토합니다 |
| `substitute` | 빌드할 때 `resolveId`로 upstream 모듈을 **우리 파일로 바꿔 끼움** | own-desktop의 `main/constants.ts`, `main/lifecycle/environment.ts`, `main/extension/manager.ts`, `main/windows/security.ts`, `main/ipc-handlers/files.ts`, `gui-extensions/src/main.ts` | 매칭되지 않은 치환 키가 있으면 `buildEnd`에서 빌드가 실패합니다. 원본 해시 drift도 경고합니다 |
| `deep-import` | 복사 없이 upstream 소스 경로나 export 경로를 **직접 import** | own-desktop의 나머지 main 모듈과 브라우저 GUI 확장(`gui-extensions/src/browser/{index,main}.ts`), desktop main이 끌고 오는 `@opencode/app` export 2개, own-web `src/host/desktop.ts`의 `ipc-client.ts`·`shared/ipc-transport.ts` | 경로가 사라지면 빌드가 실패합니다. 동작 변화는 surface 항목의 영역 해시로 잡습니다 |

- **대상 목록**
  - own-web(`vendor`): `packages/app`의 export map이 막고 있는 순수 모듈 몇 개를 복사해서 씁니다. 후보는 `session/timeline/virtualizer.tsx`, `observe-element-offset.ts`, `virtual-items.ts`, `composer/suggestions/machine.ts`, `prompt-parts.ts`입니다.
  - own-web 성능 하네스(`vendor`): `packages/app/e2e/performance/benchmark.ts`와 필요한 fixture·probe(01 §6.6)
  - own-desktop(01 §4.1, 05 §4.2)
    - `vendor`: `src/main/index.ts`, `src/main/desktop.ts`, 필요하면 `src/preload/index.ts`
    - `substitute`: `src/main/constants.ts` → `src/overrides/constants.ts`, `src/main/lifecycle/environment.ts` → `src/overrides/environment.ts`, 그리고 v2.0.24부터 GUI 확장 호스트의 내장 목록 `packages/gui-extensions/src/main.ts` → `src/overrides/gui-extensions.ts`(브라우저 확장 하나, 업데이터·SSH·WSL·pairing 없음)와 관리자 `src/main/extension/manager.ts` → `src/overrides/extension-manager.ts`(설치형 확장 없음, 모든 빌드). 05 §4.3, §8.1. 2026-10-10부터 파일 IPC 처리기 `src/main/ipc-handlers/files.ts` → `src/overrides/ipc-files.ts`(폴더 선택 창을 요청한 창의 모달로, 창마다 하나. 03 §18.3)
    - `deep-import`: 나머지 main 모듈(05 §4.2 표), 브라우저 GUI 확장의 정의·main 진입과 `sdk/main.ts`(상대 경로. 패키지 exports에 `./browser`가 없음), own-web desktop host의 `renderer/ipc-client.ts`·`shared/ipc-transport.ts`
    - `deep-import`(`@opencode/app` export): upstream desktop main은 `@opencode/app`의 export 경로를 import합니다. 그래서 own-web이 `packages/app`를 대체해도 own-desktop 빌드는 `packages/app`에 묶여 있습니다. `source`에는 export 대상 파일(`packages/app/package.json` exports로 해석)을 적습니다.
      - v2.0.24(f406d93a66)부터는 값 import 2개(`desktop-menu`, `i18n/desktop-native`)뿐입니다. `./ssh`, `./desktop`, `./updater`, `./wsl/types`는 upstream이 지웠고 그 쓰임은 GUI 확장으로 옮겨졌습니다. 아래는 v2.0.18 기준 6개 기록입니다.
      - 값 import 3개. 바뀌면 빌드와 셸 동작이 같이 바뀝니다.
        - `@opencode/app/desktop-menu` → `src/shell/commands/desktop-menu.ts`: `native/menu.ts:8`(`DESKTOP_MENU`, `desktopMenuVisible`), `native/menu-actions.ts:2`(타입)
        - `@opencode/app/i18n/desktop-native` → `src/runtime/i18n/desktop-native.ts`: `native/translations.ts:7`, `ipc-handlers/app.ts:2`(`parseDesktopNativeBundle`)
        - `@opencode/app/ssh` → `src/servers/ssh/types.ts`: `ssh/service.ts:8`(`SshConfig`), `shared/ipc-rpc/ssh.ts:3`, `shared/ipc-rpc/events.ts:6`(IPC 스키마 `SshState` 등. 그래서 rpcHash 입력에 들어감, §8.2 1b)
      - 타입 import 3개: `@opencode/app/desktop` → `src/desktop.ts`(`browser-pane.ts:1`의 `BrowserPaneTarget` 등), `@opencode/app/updater` → `src/shell/updates/types.ts`(`updater/index.ts:5`, `updater/live.ts:5`), `@opencode/app/wsl/types` → `src/servers/wsl/types.ts`(`wsl/ipc.ts:5`, `wsl/runtime.ts:2`, `wsl/servers.ts:10`)
      - sync할 때 남은 export 대상 파일과 `packages/app/package.json`의 exports를 own-desktop의 drift 검토 대상에 넣습니다(§4 step 5, §11).
    - layer 교체(`BackgroundService`, `DesktopCli`)는 우리 새 코드(`src/main/service/{background-service-own,desktop-cli-own}.ts`)라 목록에 넣지 않습니다. 다만 교체되는 원본 `src/main/service/background-service.ts`, `src/main/service/desktop-cli.ts`는 surface 항목으로 감시합니다.
  - own-remote(`vendor`, 04 §4.3): `ssh/command.ts`, `ssh/askpass.ts`, `ssh/controller.ts`, `remote/cli.ts` 일부
  - upstream이 아닌 서드파티 입력은 이 ledger 대상이 아닙니다: `own/vendor/claude-auth/`(npm lock과 패치)와 `own/vendor/oh-my-opencode/`(고정 태그의 원본 바이트, `source.json`·`pin.json`, 사본 `own/ledger/omo-pin.json`, 패치 `patches/<tag>.json`, 15 §7). 고정과 갱신 절차는 각 폴더의 README.md에 있고, 라이선스 취급은 §10입니다.

```yaml
- dest: packages/own-web/src/vendor/virtualizer.tsx
  source: packages/app/src/session/timeline/virtualizer.tsx
  kind: vendor
  upstream_commit: 00d179015f
  source_sha256: "<hash at copy time>"
  local_changes: "useLanguage 의존 제거"
  license: MIT (upstream LICENSE)
- dest: packages/own-desktop/src/overrides/constants.ts
  source: packages/desktop/src/main/constants.ts
  kind: substitute
  upstream_commit: 00d179015f
  source_sha256: "<hash at copy time>"
  local_changes: "CHANNEL=prod, APP_NAME=Own OpenCode, APP_ID=dev.own.opencode.desktop (비패키지: …desktop.local)"
  license: MIT (upstream LICENSE)
- dest: packages/own-web/src/host/desktop.ts
  source: packages/desktop/src/renderer/ipc-client.ts
  kind: deep-import
  upstream_commit: 00d179015f
  source_sha256: "<hash at record time>"
  local_changes: "없음(import만)"
  license: MIT (upstream LICENSE)
```

- `vendor`·`substitute` 파일 첫 줄에는 `// Vendored from <source> @ <commit> (MIT). See own/ledger/vendored.yaml`을 둡니다. 치환본이면 `Vendored` 대신 `Substitutes`를 씁니다.
- `check-surface.mjs`는 `source`의 현재 해시가 기록된 해시와 다르면 drift로 경고합니다. 실패로 처리하지는 않습니다.
- 지금 `vendored.yaml` 머리 주석의 항목 모양에는 `kind`가 없습니다. 첫 own-desktop 항목을 넣을 때 위 모양으로 더합니다(05 §4.7).
- **선택 필드 두 개(v2.0.24 sync, 2026-10-07).** `not_ported`는 drift 검토에서 사본에 옮기지 않은 upstream 변경을 적습니다(사본이 upstream과 다른 이유). `removed_upstream: <sha>`는 upstream이 원본을 후속 파일 없이 지운 커밋입니다. 그 항목은 원본이 없어도 drift로 보고하지 않고(check-surface가 ok로 봄) 사본은 그때부터 우리 것이지만, MIT 출처 기록이므로 항목은 지우지 않습니다. `check-surface.mjs`와 ledger 형식 시험이 두 필드를 받습니다.
- **`own/upstream-surface.json`에 더할 데스크톱·브라우저 항목**(01 §4.1, §10, 05 §4.7). 형식은 기존 항목과 같습니다(`require`/`absent`/`regions`). id는 05 §4.7과 **같은 이름**을 씁니다. 이 표가 두 문서의 합집합이고, 05에 없는 id는 FORK에서 더한 것입니다. 경로는 따로 적지 않으면 `packages/desktop/` 기준입니다.

  | id(제안) | 파일 | 기대 | 깨지면 |
  |---|---|---|---|
  | `desktop-no-exports` | `package.json:26` | `exports`가 없고 `main`만 있음(deep import 전제) | deep import 방식 재검토 |
  | `desktop-entry-order` | `src/main/index.ts:15-31` | `configureApplication` → 락 → `registerRendererScheme` → whenReady → `createEarlyWindow` → `import("./desktop")` | vendor한 `index.ts` 재검토 |
  | `desktop-layers` | `src/main/desktop.ts` | provide 5개(Ipc, BackgroundService, DesktopCli, DesktopInitialization, ApplicationLifecycle), 첫 창과 함께 `extensions.start`(v2.0.24) | vendor한 `desktop.ts` 재검토 |
  | `desktop-constants-exports` | `src/main/constants.ts` | `CHANNEL`, `VERSION`, `APP_NAME`, `APP_ID`(v2.0.24에 `UPDATER_ENABLED`가 빠짐) | 치환 파일 수정 |
  | `desktop-environment-exports` | `src/main/lifecycle/environment.ts` | export 6개, `setAsDefaultProtocolClient("opencode")` 위치(`:39-40`) | 치환 파일 수정. G-D2 재실행 |
  | `desktop-protocol-first-wins` | `src/main/windows/protocol.ts:38-39` | `isProtocolHandled`이면 등록하지 않음(우리 선등록의 전제) | 렌더러 위치 방식(05 §5.5) 재설계 |
  | `desktop-renderer-auth` | `src/main/windows/security.ts:42-53`, `src/main/service/sidecar-credentials.ts:26-29` | Basic은 top frame + 렌더러 URL + 서비스 origin 요청에만 붙음 | 인증 방식 재검토(05 §6.4) |
  | `desktop-renderer-cors` | `src/main/windows/headers.ts:10-20` (`security.ts:54-56`이 렌더러 session의 모든 응답에 적용) | `Access-Control-Allow-Origin: *`로 덮어씀. `Allow-Headers`는 없을 때만 `*, authorization`, `Max-Age`는 없을 때만 7200 | 서버 CORS(`server-cors-renderer`)와 preflight 규칙(05 R-D9) 재검토 |
  | `desktop-bg-service-iface` | `src/main/service/background-service.ts:10-13` | `{connection, reconnect}` | own layer 수정 |
  | `desktop-ensure-default-file` | `src/main/service/background-service.ts`, `packages/client/src/promise/service.ts` | `file` 없이 ensure하면 `service.json`을 씀 | 교체 이유 재확인(G-D1) |
  | `desktop-cli-iface` | `src/main/service/desktop-cli.ts:16-26` | `Resolved{version, command, binary?, wslBuild?}`, `{resolve, install}` | own layer 수정 |
  | `desktop-ipc-contract` | rpcHash 입력 목록 전체(§8.2 1b) | v2.0.24: App+Storage+File+Window+Menu+Event+Extension 그룹(Updater·Wsl·Ssh·Browser는 GUI 확장으로). 처음 기록은 IPC 태그 81개(`Rpc.make` 합계, 2026-09-27). 입력 파일의 import 대상 집합이 기록과 같음(v2.0.24: 목록 안 파일, `effect`(`unstable/rpc`·`unstable/workers` 포함), `ipc-transport.ts`의 타입 import `@opencode/gui-extensions/sdk/bridge`, 브라우저 `ipc.ts`의 `@opencode/plugin-browser/rpc`와 `packages/gui-extensions/src/sdk`. `electron`·`@opencode/schema/*`·`ssh/types.ts`는 더 이상 없음). 새 대상이 생기면 실패 | rpcHash가 바뀜 → own-web 재빌드와 셸 재설치. 새 import면 입력 목록 갱신 |
  | `desktop-app-imports` | `packages/app/package.json` exports 중 desktop main이 import하는 경로와 그 대상 파일(v2.0.24: 2개) | desktop main이 import하는 이름이 그대로 있음 | own-desktop 빌드 실패 가능. 값 import가 바뀌면 셸 메뉴·번역 재확인 |
  | `desktop-dev-cdp` | `src/main/lifecycle/configure.ts:26-27` | 비패키지 빌드만 `remote-debugging-port`를 엶(기본 9222) | 패키지 빌드 노출 재검토(01 §13) |
  | `desktop-builder-afterpack` | `electron-builder.config.ts:99-108` | upstream `afterPack`은 번들 CLI(`opencode-cli.exe`, `.version`) 검사만 함. 없으면 빌드 실패 | own 설정은 `afterPack`을 no-op로 덮으므로(05 §4.5), upstream이 다른 일을 더하면 옮겨 옴 |
  | `electron-toolchain` | `package.json:49,53-55,58` | electron 44.9.1, electron-vite 6.0.0-beta.1, electron-builder·app-builder-lib 26.15.7, vite 8.2.4 | own-desktop devDependencies를 맞춤. 예외: electron은 own이 44.10.2로 앞섬(보안 수정, 결정 EL-1). upstream이 44.10.2 이상을 고정하면 그 판을 받고 `shell.test.ts`의 예외를 지움 |
  | `server-cors-renderer` | `packages/server/src/cors.ts:11-20` | `http://localhost:*`, `http://127.0.0.1:*`, `oc://renderer`, tauri origin, `*.opencode.ai` 허용. `127.0.<k>.2`는 허용하지 않음(04 §4.4) | 앞쪽이 깨지면 렌더러 호출이 막힘. 뒤쪽이 깨지면 출시 차단(04 RG16) |
  | `browser-attach-v4` | `packages/gui-extensions/src/browser/pane.ts`(v2.0.24 전 `src/main/browser-pane.ts:244`), 짝 `browser-attach-v4-server`(`packages/plugin-browser/src/connection.ts`) | 양쪽 모두 version 4, register의 server id는 확장 호스트가 끝점으로 풂 | 패인 호환 재확인(G-D5) |
  | `browser-pane-ipc` (v2.0.24, `browser-pane-target`을 대신함) | `packages/gui-extensions/src/browser/ipc.ts` | own-web이 `ExtensionCall`로 부르는 `browser.pane` Ipc(메서드·이벤트 모양). rpcHash 입력 | own-web desktop host 수정, rpcHash 재생성 |
  | `browser-extension-definition`, `browser-embed-child-view`, `desktop-extension-host-builtins`, `desktop-extension-server-endpoints`, `desktop-extension-ipc-guard` (v2.0.24) | `gui-extensions/src/browser/index.ts`, desktop `src/main/extension/{embeds,host}.ts`, `ipc-handlers/extensions.ts` | 브라우저 확장이 혼자 compose됨, embed는 창 contentView 자식, 내장 목록·관리자를 쓰는 자리, server id → 끝점(Basic), Extension IPC는 렌더러 URL 창만 | 05 §4.3·§8.1·§8.2 재검토 |
  | `browser-pane-endpoint-auth` (v2.0.24부터 `desktop-extension-server-endpoints`) | `src/main/extension/host.ts` `server`(v2.0.24 전 `src/main/browser-pane.ts:119-124`) | main이 Basic을 붙임: `endpoint.password`가 있으면 그것(username 기본 `opencode`), 없으면 `SidecarCredentials`. 렌더러는 서비스 비밀번호를 갖지 않음 | 원격 세션 패인의 토큰 처리(05 §8.6) 재검토 |
  | `browser-tools-registration` | `packages/plugin-browser/src/tools.ts:33-56`, `packages/core/src/tool.ts:229-232,292-295` | `permission:"browser"`, `codemode:true`. 마지막 매칭 규칙이 `resource:"*"` deny면 스냅샷에서 빠짐(`whollyDisabled`, `tool.ts:231`) | 세션 권한 새김(05 §8.7) 재검토 |
  | `codemode-catalog-instructions` | `packages/core/src/codemode/tool.ts:61`, `packages/core/src/codemode/instructions.ts:32-124` | `execute` 설명은 불변, 카탈로그 변화는 Instructions delta | 05 §8.7 재검토 |
  | `compaction-keep-ceiling` (**기존 항목 확장**) | `packages/core/src/session/compaction.ts`, `packages/core/src/config/plugin/compaction.ts` | 지금 항목: `keep: 15_000`, ceiling = window의 90% 또는 `window − buffer`. 더할 것: 같은 ceiling이 요약 요청의 크기 예산(`cap`/`budget`)으로도 쓰임(`compaction.ts:203-211`, 창을 모르면 `UNKNOWN_WINDOW`로 계산). 설정은 전역(01 §8.7 R16) | 02 추정기 상수와 다운시프트 가드, 자동 압축 설정(D6) 재검토 |

  - 04 §4.4 표의 "CORS 허용 목록" 행은 `server-cors-renderer`, "데스크톱 main의 Basic 주입 조건" 행은 `desktop-renderer-auth`와 같은 항목입니다. 04의 나머지 SSH 행은 04가 id를 정합니다.
  - 05 §4.7과 이름을 합쳤습니다: 이전 판의 `desktop-sidecar-auth-origin`은 `desktop-renderer-auth`로, `browser-attach-version`은 `browser-attach-v4`로, `desktop-opencode-scheme`은 `desktop-environment-exports`로, `compaction-ceiling`은 기존 `compaction-keep-ceiling`으로 흡수했습니다. `browser-plugin-internal`(`-opencode.browser`로 끄는 전제)은 그 방식을 쓰지 않으므로(§1) 빼고 `browser-tools-registration`, `codemode-catalog-instructions`로 바꿨습니다.
- **팀 모드·프리셋 항목(T0, 06 §2.6·§10.4 #6, 07 §8.2).** 06 §2.6의 HTTP 계약은 `service-session-http-api`(짝 `service-session-http-api-permission`), `session-instruction-entries-endpoint`, `session-active-endpoint`, `service-config-channel`이고, 작업 폴더 지우기 막이(06 §10.4 #5)는 `worktree-remove-ignored-files`입니다. 프리셋 관문·`opencode_models` 거르기·내장 에이전트 모델·위임 문장·effort 갱신 거울의 id는 07 §8.2 "계약" 행이 목록입니다. check-surface 항목은 파일 하나씩이라, 여러 파일에 걸친 계약은 `browser-attach-v4`처럼 주 항목과 짝 항목으로 나눕니다.
- **팀 모드·프리셋 항목(T1, 2026-10-02).** T1이 더 기대게 된 계약이다. 07 §8.2 "계약" 행에서 T0에 없던 것: `instruction-entry-rendering`(`own.preset` 항목 갱신이 대화 끝에 붙는 문구, 07 §3.3·PG4), `hook-scope-filter`의 기대·영향에 evaluate 훅 순서(07 §2.4, 06 §2.6)를 더함, `session-child-inherits`(자식이 부모 권한·metadata를 복사: 읽기 전용 역할, 컴퓨터 allow, 02 §9.2). own-team의 self-HTTP와 플러그인 계약(06 §2.6): `team-session-create`, `team-session-generate`(판단 호출), `team-session-synthetic`·`team-synthetic-no-prompt-hook`(synthetic은 `prompt` 훅을 지나지 않음), `team-session-inbox`(목록·취소·delivery), `team-session-log-after`(`after` 커서), `team-session-messages`, `team-session-metadata-replace`(metadata PATCH는 통째 교체), `team-worktree-refresh`, `team-tool-namespace`(Code Mode `tools.team.<name>`, 그 밖 `team_<name>`, `tool-effective-name`의 짝). 2026-10-02 T1 리뷰 수정에서 더한 것: own-computer-use의 own.team 턴 거절(`src/gate.ts` teamTurn)이 기대는 `computer-use-team-turn-context`·`-history`·`-markers`·`-metadata-projection`, own-team의 안전 지점·TI-3과 팀 홈 옮기기가 기대는 `team-shell-list`·`team-shell-info`·`team-shell-tool-session-tag`·`team-pty-list`·`team-pty-info`·`team-session-move-inbox`. `plugin-activation-order`(3번 자리 own.team과 그 이유), `builtin-plugin-placement`·`plugin-updated-after-activation`(own-team `src/tools/index.ts` relocate, own-computer-use `src/agents.ts`), `computer-use-wholly-disabled`(`src/agents.ts`), `tool-hook-order`·`tool-hook-shapes`(own-team `src/hooks/tool.ts`)의 영향 설명도 고쳤다. 모두 163개 항목이 통과한다(`node own/scripts/check-surface.mjs`).
- **팀 모드·프리셋 항목(T2, 2026-10-02).** 06 T2가 더 기대게 된 계약: `team-session-permissions-write`(`ctx.session.update{permissions}`가 세션 규칙 전체를 정하고 `ctx.session.get`이 규칙을 돌려줌. 받아들인 담당에 팀 allow를 붙이고 떼는 own-team `Permissions.write`, 06 §2.8·§3.7), `team-session-permissions-replace`(권한 쓰기는 합치기가 아니라 통째 교체: own-team이 팀 규칙만 읽고-고치고-씀), `session-inbox-enqueued-event`(사용자 프롬프트 접수 신호 `session.inbox.enqueued`: own-accounts의 없어진 메인 경보 07 §4.3과 own-team 보고 접기 06 §5.5). 07 T2의 Codex 메타데이터 끝점은 upstream OpenCode 표면이 아니라 own 코드의 상수 블록(`CodexMeta.BACKEND`)에 두고 PG7 (나)로 확인한다(07 §4.5). wave 4(T2.20)가 07 쪽 가정을 더했다: `codex-model-metadata-endpoint`(Codex 모델 목록의 가정. upstream이 그 목록을 스스로 읽기 시작하면 `absent`로 알아챔), `models-dev-file-source`와 짝 `models-dev-file-env`(`OPENCODE_MODELS_PATH`, PG5), `models-dev-refresh-event`, `models-dev-deprecated-dropped`, 그리고 메타데이터를 앞에 둔 `codex-model-filter` 기대 문구. 같은 wave의 06 쪽: 시험만 기대는 `codemode-catalog-update-message`(own-team e2e가 TG16의 "delta 1"로 세는 core의 카탈로그 갱신 메시지)와, own-web의 큰 파일 폴더 턴 안내(06 §4.14)가 `team.need_paths` 행을 읽는 `codemode-progress-tool-calls`. T2 wave 4 뒤 172개 항목이 통과한다. T2 리뷰(2026-10-03)가 `session-execution-events`를 더했다: 실행 끝 이벤트 `session.execution.succeeded`·`failed`·`interrupted`(멈춤 이유 `user` 등)는 T1부터 own-team 요청 접수·Main 멈춤(`dispatch/admit.ts`), 교체(`sessions/rotate.ts`), 팀 계정 재개(`sessions/team-account.ts`), 보고 접기(`report/events.ts`)가 읽었고 T2에서 안전 지점 맞추기(`controller.ts`), cone 따라가기(`assets/drift.ts`), 내려놓기(`assets/release.ts`)가 더 읽는다(own-accounts 전환, own-remote 게이트웨이, own-web도 읽음). 173개 항목이 통과한다.
- **팀 모드·프리셋 항목(T3, 2026-10-04).** T3가 새로 기대게 된 upstream HTTP 계약은 `event-subscribe-rpc-events` 하나다(`packages/protocol/src/groups/event.ts`: `GET /api/event`는 모든 Location의 네이티브 이벤트와 플러그인 RPC 이벤트 `rpc.<id>.<name>`의 SSE이고 휘발성. 게이트웨이 피드가 이 PC에서 읽던 것을 T3부터 준비된 SSH 호스트마다 좁게도 읽어 `team.decision`을 만듦, 05 §13.6). 이미 있던 항목 중 T3가 다시 기대는 것은 `ref`·`onBreak`만 넓혔다(해시 영역은 그대로): `team-session-move-inbox`(사용자의 대화 옮기기 `reorg/rehome.ts`와 폴더 따라가기 `reconcile/area.ts`도 `ctx.session.move{delivery:"queue"}`), `team-session-generate`(재구성 제안 `reorg/propose.ts`), `team-worktree-refresh`(끝내기의 폴더 지우기 뒤 `reorg/remove.ts`), `service-config-channel`(원격 서비스의 own.team self-HTTP가 그 호스트의 `service-own.json`을 읽음, 06 §2.6), `session-execution-events`(공유 폴더 다시 잇기 `assets/shared.ts`). 대화 옮기기의 HTTP 경로 `session.move`는 쓰지 않는다(플러그인 ctx로 부름). 174개 항목이 통과한다(`node own/scripts/check-surface.mjs`).
- **매 요청 다시 보내는 바이트와 내장 skill id(2026-10-05, `own/reports/external-repos-2026-10-05.md` P1-6·P0-1).** upstream이 모델이 매번 받는 바이트를 바꾸면 merge 때 미리 알도록 파일·영역 해시 항목을 더했다: `prompt-bytes-default`(`session/runner/prompt/system.txt`), `prompt-tool-guidance`(`session/system-prompt.ts`), `prompt-bytes-gpt`·`-gpt-astra`·`-kimi`·`-meta`·`-trinity`(`plugin/system-prompt/*.txt` 파일 전체. 기존 `delegation-sentence-*`는 그대로 두고 `anthropic.txt`는 넣지 않음), `tool-surface-patch-predicate`(`patch.ts`의 `usePatch`), `shell-tool-description`(`shell.ts`의 설명과 입력 스키마), `env-builtin`(`instructions/builtins.ts`의 내장 지시 목록 전체와 순서). 이 항목의 CHANGED는 계약 파괴가 아니라 바이트 변화다. 프롬프트·도구 항목은 그 템플릿 계열의 활성 세션마다 업그레이드 뒤 cold 요청 1회이므로 `SYNC_LOG.md`의 surface 변화와 릴리스 노트에 적고 D9(02 §4.3)를 다시 본다. `env-builtin`의 값 변화는 기존 세션에 delta 1회(cold 아님)이고 새 세션의 기준선만 바뀐다(순서가 바뀌면 cold 1회, §4). own-accounts가 내장 skill을 id로 고치므로(`packages/own-accounts/src/skills.ts`) `builtin-skill-ids`(`plugin/skill.ts`의 `opencode`·`report`)와 짝 `builtin-skill-ids-opencode-md`(`opencode.md`의 전역 설정 문단)도 더했다. 186개 항목이 통과한다.
- **prefix 지문의 이미지 trim 계산(2026-10-06, P0-2b, 02 §7.8.1).** own-accounts의 prefix 지문(`src/telemetry/prefix-watch.ts`)은 hook 뒤에 core가 오래된 이미지를 잘라 내는 규칙을 같은 상수로 따라 계산한다. 그래서 `request-image-bound`(`session/model-request.ts`의 `boundImages`: 25 MiB를 넘으면 15 MiB까지, 크기 계산식)를 더했다. 깨지면 `PrefixWatch.IMAGE_TRIGGER_BYTES`·`IMAGE_TARGET_BYTES`·`imageCut`을 고치고, 같은 기준 아래에 둔 own-computer-use의 요청당 20 MiB(`Budget.REQUEST_BYTES`)도 다시 본다. 187개 항목이 통과한다.
- **EXT 리뷰 수정(2026-10-06).** own이 기대던 upstream 동작인데 항목이 없던 것을 더했다. `cli-heap-signal`(`packages/cli/src/heap.ts`: SIGUSR1 heap snapshot은 평범한 `process.on("SIGUSR1", handler)` 하나. 원격 서비스의 own-remote `muteHeapSignal`이 모든 SIGUSR1 listener를 no-op 하나로 바꿔 무장한 broker 키와 lease가 디스크에 남지 않게 함, 04 §15 SEC-1)와 짝 `cli-heap-signal-start`(`index.ts`: CLI 시작에서 플러그인보다 먼저 `Heap.listen`). `codemode-nested-call-id`(`codemode/tool.ts`: Code Mode 프로그램의 도구 호출은 execute 호출의 context를 그대로 받아 같은 id로 `execute.before`·`after`에 옴. own-accounts 반복 호출 안내의 `Repeat.CODE_MODE`가 기댐). `deepseek-thinking-off-variant`(`variant.ts`: DeepSeek에서 생각을 끄는 변형은 id `none`뿐. 결정 D2의 `Auth.DS_THINKING_OFF_OUTPUT`이 기댐). `tool-hook-order`의 onBreak에 `Repeat.render`(출력만 있는 결과를 core `normalizeContent`처럼 그림)를 더했다. 191개 항목이 통과한다.
- **속도(Fast·Ultrafast, 2026-10-06, 02 §4.8).** 코어 패치 없이 own 플러그인 hook만 쓰므로, 기대게 된 upstream 동작을 항목으로 더했다. `models-dev-speed-modes`(`core/src/models-dev.ts`: models.dev `experimental.modes`가 `<model>-<mode>` 모델로 등록되고 `modelID`가 기본 모델, 모드의 body·headers·비용이 그 모델의 것. own은 이것으로 tier 값과 가격을 읽고 화면 선택지에서 그 항목을 숨김), `open-responses-service-tier`와 `open-responses-service-tier-option`(`ai/src/protocols/open-responses.ts`, `utils/open-responses-options.ts`: 요청 옵션 `serviceTier`가 HTTP와 WebSocket `response.create`가 함께 쓰는 본문의 `service_tier`가 되고 아무 문자열이라 `ultrafast`도 남음), `session-request-provider-options`(`core/src/session/model-request.ts`: hook 옵션 중 생성 설정이 아닌 것이 provider 옵션), `speed-http-request-body`(같은 파일: `http.request` hook이 바꾼 요청의 헤더와 본문이 그대로 나감. Anthropic의 `speed`와 fast beta를 여기서 넣음), `anthropic-options-no-speed`(`ai/src/protocols/anthropic-messages.ts`: core Anthropic에 `speed`가 없고 필요한 beta를 hook 전에 합침. `absent`라 upstream이 `speed`를 넣으면 CHANGED). Claude 구독 슬롯 요청의 편집은 02 §8.3 I5a의 문서화한 예외다(claude-auth는 서드파티라 surface가 아니라 02에 적음). 197개 항목이 통과한다.
- **upstream v2.0.24 sync(2026-10-07–08, `SYNC_LOG.md`).** 옮겨진 코드의 짝 항목 `session-affinity-header`·`-rule`, `retry-classification`, `service-registration-probe`, `local-provider-registration`, `effort-updates-claude-version`과 `explore-agent-rules`(explore의 shell, own은 agent 변환에서 마지막 `{shell,*,deny}`로 다시 숨김)를 더했다. 리뷰 뒤 더한 것: `session-output-limit`(`session/model-request.ts`: core가 hook 전에 기본 `maxTokens`를 넣는 자리와 상수. NO_OUTPUT_LIMIT·D2·P-016 보정·P-017 runner 경로가 기댐), `session-instruction-order`(`session/context.ts`: 요청마다 지시를 합치는 순서. 바뀌면 활성 세션마다 cold 1회), `provider-route-timeouts`와 짝 `-false`(`provider.ts`의 5분 header·chunk timeout과 끄는 값 `false`. compat slot이 끔), `chatgpt-sharing-models`(`plugin/provider/chatgpt.ts`의 Sign in with ChatGPT 모델 집합. own `SHARING_MODELS`가 따름), `models-dev-text-only`와 짝 `model-supports-text`(텍스트 입출력이 없는 모델이 카탈로그에서 빠짐. own 템플릿 diff가 그 모델을 없어진 것으로 보지 않음). 211개 항목 중 204개가 통과한다. `electron-toolchain`과 `browser-*` 6개가 BROKEN으로 남아 §5에 따라 `main` 반영을 막는다. 2026-10-08: `electron-toolchain`은 44.4.5로 맞췄고(`fbda3da350`), 브라우저 패인을 upstream GUI 확장 호스트 위로 다시 붙이면서(05 §8.1) 6개 항목을 새 위치로 옮기고(`browser-pane-target` → `browser-pane-ipc`) `browser-extension-definition`, `browser-embed-child-view`, `desktop-extension-host-builtins`, `desktop-extension-server-endpoints`, `desktop-extension-ipc-guard`를 더했다. 216개 항목이 모두 통과한다.
- **스킬 가져오기(SKILLS, 2026-10-10, 09 §9).** own-import가 이 PC의 Codex·Claude Code 스킬과 git 저장소의 스킬을 own 전역 스킬 폴더(`%OPENCODE_CONFIG_DIR%\skills\<id>`)로 복사하므로, core가 그 폴더를 읽는 규칙(`skills-config-dir-sources`), SKILL.md 머리말과 id 규칙(`skill-file-frontmatter`, 영역 해시), gray-matter 읽기와 콜론 재시도(`config-markdown-sanitize`, 파일 해시)와 그 버전(`config-markdown-gray-matter-version`), Claude Code 개인 스킬이 이미 실리는 호환 뿌리(`compat-skill-roots`, `compat-skill-roots-home`)를 더했다. 250개 항목이 모두 통과한다.
- **가져오기(IMPORT I1·I2, 2026-10-08, 09 §1.1 IM-D4·§7.2).** own-import는 코어 패치 없이 upstream의 `experimental.session.import`, `session.compact`, `session.remove`, `experimental.session.log`를 쓰므로 그 계약을 항목으로 더했다. `session-import-route`와 짝 `session-import-handler`(`packages/server/src/handlers/session.ts`: payload의 location을 쓰고 없으면 서버의 `process.cwd()`, `ImportConflictError`는 409. 그래서 own-import `http.ts`가 location을 늘 보냄), `session-transfer-import`, `session-transfer-data`, `session-compact-route`, `session-remove-route`, `session-log-route`와 짝 `session-log-compaction-events`(`packages/schema/src/session-event.ts`: `session.compaction.ended`의 text·recent·cost·tokens와 `session.compaction.failed`의 error. `migrate/helper.ts`가 읽음), `history-latest-compaction`, `synthetic-user-role`, `compaction-agent-precedence`, `compaction-tool-output-max`, `recent-line-format`. `session-log-route`는 기존 `team-session-log-after`와 같은 영역을 해시하므로 그 route가 바뀌면 둘이 함께 보고된다. 그때 229개 항목이 모두 통과했다. IMPORT wave 5(2026-10-09)에서 보조 세션의 요약 끝 확인이 바뀌었다: 서비스는 `events.persist`가 켜져 있지 않으면 세션 이벤트를 durable하게 남기지 않아(CLI는 켜지 않음) 세션 로그에 압축의 끝이 나오지 않으므로, `migrate/helper.ts`는 보조 세션의 압축 메시지(`GET /api/session/:id/message?type=compaction&order=desc`)를 읽는다(09 §4.4 2번). 그 경로는 기존 `team-session-messages`가 해시하고, 압축 메시지 모양은 `session-message-compaction-shape`(`packages/schema/src/session-message.ts`의 running·completed·failed)가 본다. `session-log-route`·`session-log-compaction-events`는 로그를 따라가는 길(helper 단위 시험)에 남는다(wave 6에서 `session-message-compaction-shape`를 더해 230개). IMPORT 리뷰 수정(2026-10-09)에서 own-import가 self-HTTP로 읽는 나머지 경로의 항목을 더했다: 프로젝트 목록 `import-project-list`와 짝 `import-project-info`(`canonical`·`sandboxes`가 폴더 소속과 `directory_unknown`, 기기 범위의 프로젝트 한정을 정함), 가져올 Location의 `import-model-list`, `import-provider-list`와 짝 `import-provider-settings`(`canonical`·`settings.compaction`), `import-agent-get`과 짝 `import-agent-hidden`(core `Agent.get`이 숨긴 `compaction` 에이전트도 답함), `import-vcs-get`과 짝 `import-vcs-branch`. `location.catalog`는 `agent.get`의 `AgentNotFoundError`만 '압축 에이전트 없음'으로 보고, 그 밖의 실패(옮겨 간 경로의 404 포함)는 계획을 실패시킨다(대상을 요약 모델로 잘못 적지 않게). 239개 항목이 모두 통과한다.

---

## 8. 릴리스와 버전 고정 정책

### 8.1 버전 규칙
- `OPENCODE_VERSION = <포함된 최신 upstream release>-own.<k>`입니다. 예: `2.0.18-own.1`, `2.0.18-own.2`, upstream v2.0.19를 merge하면 `2.0.19-own.1`.
- `OPENCODE_CHANNEL = own`으로 고정합니다. DB `opencode-own.db`, 등록 파일 `service-own.json`, 채널 해시 포트가 이 값으로 정해집니다(`packages/cli/src/database-path.ts:4-12`, `packages/cli/src/services/service-config.ts:29-38`).
- 개발(소스 실행)은 채널 `local`이므로 운영 데이터와 분리됩니다.
- 태그는 `v<version>`입니다. 예: `v2.0.18-own.1`.

### 8.2 빌드 (Bun은 `packageManager` 버전, 작업 트리 `D:\own-open-code`)

산출물은 네 묶음입니다. 서비스 쪽(CLI, 플러그인, vault, 템플릿), 렌더러(`web\`), 데스크톱 셸, 원격 번들(04)입니다. 셸은 `app\<ver>\`에 들어가지 않고 따로 설치됩니다(01 §5.1).

출력 루트는 `build-own.ps1`과 같은 `own/.out/build/<ver>/`(아래 `$out`)입니다.

**지금 쓰는 명령(2026-09-28, `2.0.18-own.1`에서 사용).** 아래 1–6단계와 manifest를 스크립트 하나가 차례로 합니다. 설치·실행은 하지 않습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1 -Version 2.0.18-own.1 -Remote
```

- 1단계 `build-own.ps1`은 P-001에 따라 `OPENCODE_WEB_APP=own-web`으로 빌드하고, 검증에서 `GET /`의 `<title>`이 own-web인지도 봅니다(`-ClassicWebUi`면 upstream app).
- 1b build id(`packages/own-remote/script/bundle.ts build-id`)를 한 번 계산해 플러그인 번들과 `-Remote`의 `build-remote.ps1`에 넘깁니다. rpcHash는 `packages/own-desktop/scripts/rpc-hash.mjs --check`입니다.
- 3·3b·3c·4단계: 플러그인 번들 7개(own-accounts, own-remote, own-team, own-telemetry, own-computer-use, own-import, own-harness. 활성화 순서 그대로, `bundle.ts` `DESKTOP_PLUGINS`, own-team은 T1부터, own-import는 IMPORT부터, own-harness는 H0부터. own-import는 스캔 Worker `src/worker.ts`를 먼저 같은 define으로 번들하고 그 글을 define `OWN_IMPORT_WORKER_SOURCE`로 넣어 `index.js` 한 파일로 남김, `bundle.ts` `IMPORT_WORKER`), `cargo build --release --locked`한 `own-vault.exe`, `own/native/own-cu-helper/build.ps1`이 있으면 `own-cu-helper.exe`(없으면 경고하고 건너뜀), 템플릿을 `$out`에 둡니다.
  - `own-cu-helper.exe`는 서명하지 않은 빌드이고, csc 4.x에 `/deterministic`이 없어 해시가 빌드마다 바뀝니다. Smart App Control이 켜진 PC는 새 빌드를 막을 수 있습니다(helper README §4). 그래서 컴퓨터 사용의 기본 엔진은 helper가 아니라 플러그인 번들 안의 FFI 드라이버(`driver: "windows"`)입니다(01 §10.2). helper는 `driver: "helper"`를 고른 설치만 씁니다. 3c단계가 경고하고 건너뛴 릴리스에서는 그런 설치의 모든 동작이 `driver_unavailable`입니다.
- Android APK(08 §4.2)는 이 스크립트가 만들지 않습니다. `build-desktop.ps1`이 끝난 뒤 같은 `-Version`으로 `own\scripts\build-android.ps1`을 돌립니다(`-Version`을 빼면 루트 `package.json` 버전 + `-own.0`). 1단계(upstream `build.ts`)가 `$out`을 먼저 지우므로 순서를 바꾸면 APK가 사라집니다. 결과는 `$out\android\`(APK와 `android-build.json`)이고 manifest에는 아직 들어가지 않습니다.
- 6단계(`-Remote`, `build-remote.ps1`)는 T3부터 원격 대상마다 고정 버전 정적 git-lfs도 준비합니다(06 §4.13, 04 §5.2). 원격 대상은 upstream `build.ts`에 `OPENCODE_TARGET=<target>`로 넘깁니다. upstream v2.2의 `build.ts`는 `--target=`을 읽지 않아 그 인자만으로는 모든 대상을 빌드합니다(2026-10-30, v2.2.1 sync).
  - **2b단계 `git-lfs`**: `packages/own-remote/script/native.ts lfs`가 `GIT_LFS`에 고정한 버전(3.8.1)의 공식 Linux 릴리스 압축 파일(`git-lfs-linux-amd64-v3.8.1.tar.gz`, `git-lfs-linux-arm64-v3.8.1.tar.gz`)을 github.com/git-lfs/git-lfs 릴리스에서 받거나(`-NativeDir\git-lfs\archives`에 확인된 사본이 있으면 다시 씀) `-GitLfsArchive "linux-x64-baseline=<경로>;linux-arm64=<경로>"`의 로컬 사본을 받아, **쓰거나 풀기 전에** 고정 sha256과 맞춥니다. 그다음 `git-lfs-<ver>/git-lfs` 하나만 꺼내 그 대상 기계의 정적 ELF(64비트 LE, EXEC/DYN, PT_INTERP 없음)인지 보고, git-lfs 저장소의 `LICENSE.md`를 옆에 둡니다(공식 압축 파일에는 라이선스가 없음). 결과는 `-NativeDir\git-lfs\<ver>\<target>\{git-lfs, LICENSE.md}`입니다. `-GitLfsPin`(시험 전용, `-NoElfCheck`와만)은 가짜 압축 파일(`script/fixtures/git-lfs-fake.tar.gz`)의 고정값입니다.
  - **package 단계**: `bundle.ts package --tools <NativeDir>`가 대상마다 `remote\tools\git-lfs\<ver>\<target>\`에 복사하고(ELF 다시 확인, 바이너리나 라이선스가 없으면 실패) `remote\manifest.json`과 `remote\remote_artifacts.json`에 `tools["git-lfs"]`를 적습니다(§8.3). 대상 압축 파일(`<target>.tar.gz`)에는 넣지 않습니다. `remote-build-info.json`에 `git_lfs` 기록(압축 파일 이름·URL·sha256·바이트, 바이너리 sha256·바이트)이 붙습니다.
  - **plugins 단계**: `REMOTE_PLUGINS`(own-accounts, own-remote, own-team, own-telemetry, own-harness, own-omo)를 번들합니다. own-telemetry는 원격 Claude 세션의 긴 멈춤 방지 때문에 다시 싣습니다(04 §8.11). own-computer-use와 own-import(IMPORT, 이 PC 전용)는 원격에 싣지 않습니다. own-harness는 2026-10-12(10 §6.1)부터, own-omo는 2026-10-29(15 §1)부터 맨 뒤에 싣고, own-omo는 런타임·고지 파일·스킬을 함께 싣습니다. `bundle.test.ts`가 ps1의 목록과 `REMOTE_PLUGINS`가 같은지 봅니다.
  - **stage 단계(`build-desktop.ps1`)**: `remote_artifacts.json`에 대상 키 옆 `tools` 키가 생겼으므로 대상 목록은 원격 manifest의 `targets`에서 읽고, `remote\tools`를 `app\<ver>\remote\tools`로 복사합니다.
  - **release-smoke**(검사 27 → 29개): `app\<ver>\remote`의 대상마다 플러그인이 정확히 own-accounts·own-remote·own-team(04 §8.11부터 own-telemetry까지 넷)이고 own-computer-use가 없는지, `tools` git-lfs가 대상마다 파일·sha256·크기·라이선스가 맞고 압축 파일 안에 없는지 봅니다.
  - 공식 압축 파일 내려받기와 동봉은 2026-10-04 결정(작업 계획의 결정 기록)입니다. 실제 내려받기는 사용자가 대화에서 직접 확인하거나 손으로 받은 사본을 `-GitLfsArchive`로 줄 때만 합니다. 사용자가 확인한 것은 3.8.0 내려받기입니다(HANDOFF §4). 2026-10-30에 CVE 넷(CVE-2026-69260 SSH 원격 명령 인자를 따옴표로 감싸지 않음, CVE-2026-69261 리디렉션 뒤 다른 호스트로 Cookie 헤더를 보냄, CVE-2026-105802 줄바꿈이 든 하위 모듈 URL로 아무 프로그램이나 실행, CVE-2026-105803 `.lfsconfig`의 사용자 정의 전송 어댑터로 아무 프로그램이나 실행)을 고친 3.8.1(2026-10-22)로 고정값을 올렸습니다. 3.8.1의 고정 sha256과 크기는 릴리스 노트, GitHub API의 자산 digest, 릴리스의 `sha256sums.asc`(셋이 같음)에서 적었습니다. 사용자가 2026-10-31에 3.8.1 내려받기를 승인해 두 압축 파일을 받았고 sha256과 크기가 고정값과 같았습니다(MR8-21). `native.ts lfs`로 확인한 실행 파일은 linux-x64-baseline 13,959,328 B(sha256 `8bf08ae9…597c`), linux-arm64 12,910,752 B(`b0868f6c…3ff4`)이고, 확인한 압축 파일은 릴리스 작업 폴더의 `-NativeDir`(`D:\own-integration\own\.out\remote\native\git-lfs\archives`)에 3.8.0 것 옆에 있어 다음 `-Remote` 빌드가 다시 씁니다. 버전을 바꿀 때는 `native.ts` `GIT_LFS`와 `own/ledger/vendored.yaml`의 기록을 함께 바꿉니다(`native.test.ts`가 둘이 같은지 봄).
- **release-smoke**(2026-10-05, 검사 29 → 31개): temp root 폴더 이름이 명령줄이나 실행 파일 경로에 남은 프로세스가 없는지(P1-14a), 시작 뒤 `Microsoft-Windows-CodeIntegrity/Operational` 로그에 temp root 아래 파일 이벤트가 없는지(P1-15, 읽기만)를 봅니다.
- **release-smoke(IMPORT, 2026-10-08, 검사 하나 더함)**: `app\<ver>\plugins`의 번들 여섯이 모두 manifest의 build id를 품는지, config의 own 항목이 `[own-accounts, own-remote, own-team, own-telemetry, own-computer-use, own-import]` 순서인지, claude-auth 슬롯을 설치하면 슬롯이 own-team 뒤이고 own-import가 맨 뒤인지, 원격 대상 압축 파일마다 own-import가 없는지 보고, `own.import`의 `health`(릴리스 버전, `features`, Worker가 아직 뜨지 않음)를 부릅니다. own.import에서는 `health`만 부릅니다. `sources.list`·`sessions.*`는 이 PC의 Codex·Claude Code 저장소를 읽기 때문입니다. IMPORT 단계에서는 이 스크립트와 `build-desktop.ps1`을 돌리지 않았고, 다음 릴리스가 이 모양으로 처음 빌드합니다. 원격 대상 압축 파일마다 서드파티 claude-auth 표식이 없는지도 봅니다.
- **PE 목록**(P1-15): `pe-inventory.ts`가 `app\`·`desktop\`에서 내용(MZ + `PE\0\0`)으로 PE를 찾아 경로·크기·sha256과 Authenticode 상태·서명자를 `own/release/<ver>/pe-inventory.json`에 적습니다. 서명하지 않으므로 대부분 NotSigned입니다. Smart App Control 차단을 조사할 때 어느 파일이 바뀌었는지 비교하는 기준입니다.
- **launcher의 `PSModulePath`**(2026-10-05): `own.cmd`는 Windows PowerShell 5.1을 부르기 전에 `PSModulePath`를 비웁니다. PowerShell 7 창에서 `own`을 부르면 7의 모듈 폴더가 앞에 온 값을 물려받아 5.1이 7의 `Microsoft.PowerShell.Utility`를 읽고 `Get-FileHash`가 실패했기 때문입니다. 비우면 5.1이 자기 기본값(사용자와 Program Files의 `WindowsPowerShell\Modules`, `system32\WindowsPowerShell\v1.0\Modules`)을 만들고, `own.ps1`이 시작하는 서비스와 그 에이전트 셸도 이 값을 물려받습니다. cmd나 탐색기에서 시작한 서비스가 받던 값과 같습니다. pwsh 7 에이전트 셸은 시작할 때 자기 폴더를 앞에 더하므로 그대로 동작합니다. `own/scripts/test/launcher.test.mjs`가 PowerShell 7 같은 환경에서 `own.cmd start`를 돌려 확인합니다(01 §5.3 b2). 2026-10-26(MR6-14)부터는 `own.ps1`도 스스로 맞춥니다. 설치 프로그램(`installer.nsh`)과 데스크톱 셸은 `own.cmd`를 거치지 않고 `powershell.exe -File own.ps1`을 바로 부르기 때문입니다. Windows PowerShell(Desktop 판)에서 돌면 맨 위에서 `PSModulePath`를 5.1이 변수가 없을 때 만드는 기본값(사용자 값 또는 `문서\WindowsPowerShell\Modules`, 그다음 시스템 값 또는 Program Files와 `$PSHOME`의 `Modules`)으로 바꾸고, 파일 해시는 `Get-FileHash` 대신 .NET `SHA256`으로 셉니다(`Get-FileHex`). 둘 중 하나만 있어도 설치는 통과합니다. launcher 시험이 `own.ps1 start`를 바로 부를 때도 서비스가 `own.cmd`와 같은 값을 받는지, 설치 시험이 7의 `Microsoft.PowerShell.Utility`를 흉내 낸 모듈 폴더를 앞에 두고 설치·손상 거부·인계 갱신을 돌려 확인합니다. 릴리스 빌드는 `own.ps1`을 서명하거나 고정 해시로 적지 않습니다. `build-desktop.ps1`은 `bin\own.ps1`을 복사한 뒤 설치 프로그램 속 preflight 사본과 내용이 같은지만 비교하고, manifest 산출물과 PE 목록에는 들어가지 않습니다.
- manifest는 §8.3 모양입니다(`build_id`, 산출물 해시, `remote_artifacts`, `patches_active`, `thirdparty_slots`). `gates`는 게이트를 돌린 뒤 `own/release/<ver>/manifest.json`에 채웁니다.
- 마지막으로 `$out\app\`에 설치 레이아웃(`app\<ver>\`와 같은 모양)을, `$out\bin\`에 launcher를 둡니다. 설치는 이 폴더를 `%LOCALAPPDATA%\own-open-code\app\<ver>`로 복사하고 버전 포인터 `app\current.json`과 `opencode.jsonc`의 own 플러그인 항목을 그 버전으로 바꾸는 것입니다(`own.ps1 install`, `own/docs/USER-GUIDE.md` 2장). junction은 쓰지 않습니다(01 §5.5).

아래는 단계별 원래 명령입니다. PowerShell 7 기준입니다(3단계의 5.1 주의 참고).

```powershell
$ver = "2.0.18-own.1"
$out = "own/.out/build/$ver"

# 1) CLI: upstream build.ts를 고치지 않고 own 채널로 빌드하고 격리 디렉터리에서 검증 (build-info.json 생성)
#    upstream build.ts가 $out을 통째로 지우므로 다른 산출물은 모두 이 단계 뒤에 쓴다
$env:OPENCODE_WEB_APP = "own-web"          # P-001이 active일 때만(웹 폴백). 그 전에는 classic app이 임베드됨
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-own.ps1 -Version $ver

# 1b) 릴리스 id를 한 번 계산해 env로 넘긴다 (예정: own/scripts/lib/release-ids.mjs, 정의는 이 블록 아래)
$env:OWN_BUILD_ID = node own/scripts/lib/release-ids.mjs build-id --version $ver   # 입력 해시. 세 플러그인 번들에 같은 값
$env:OWN_RPC_HASH = node own/scripts/lib/release-ids.mjs rpc-hash                   # 셸·own-web desktop chunk·manifest에 같은 값 (G-D6)

# 2) 렌더러 (P3 이후): own-web 프로덕션 빌드 → 설치 레이아웃의 app\<ver>\web\ (데스크톱 렌더러 루트, 01 §6.1, 05 §5.5)
bun run --cwd packages/own-web build        # _assets, CSP 계약(01 §6.1). 소스맵 없음. vite 설정이 OWN_RPC_HASH를 desktop chunk에 새김
Copy-Item packages/own-web/dist "$out/web" -Recurse

# 3) 플러그인 번들 (의존성 포함 단일 ESM, 설치 위치에 node_modules가 없으므로 전부 번들)
#    일곱 번들(T1부터 own-team, IMPORT부터 own-import, H0부터 own-harness 포함)에 같은 define 세 개를 넣는다 (packages/own-accounts/src/build.ts:5-21, packages/own-telemetry/src/build.ts:4-15)
#    실제 빌드는 packages/own-remote/script/bundle.ts plugins (Bun.build define + minify + 같은 검사, build-desktop.ps1 3단계).
#    minify(perf P7)로 번들 크기가 반쯤 준다. 예: own-computer-use 약 575 KB → 299 KB (01 §10.2)
$define = @(
  '--define', "OWN_BUILD_ID=`"$env:OWN_BUILD_ID`"",   # runtime 싱글턴 키. 번들마다 다르면 싱글턴이 갈라짐
  '--define', "OWN_EXPECTED_APP_VERSION=`"$ver`"",    # 가드 1 비교값(own-accounts/src/health/guard.ts:21-23). 빠지면 "local" → skew, 계정 0개로 fail closed
  '--define', "OWN_PLUGIN_VERSION=`"$ver`""           # health.version·pluginVersions (own-accounts/src/health/health.ts:106-111)
)
bun build packages/own-accounts/src/index.ts  --target=bun --format=esm @define --outfile "$out/plugins/own-accounts/index.js"
bun build packages/own-remote/src/index.ts    --target=bun --format=esm @define --outfile "$out/plugins/own-remote/index.js"     # R0 이후
bun build packages/own-team/src/index.ts      --target=bun --format=esm @define --outfile "$out/plugins/own-team/index.js"         # T1부터
bun build packages/own-telemetry/src/index.ts --target=bun --format=esm @define --outfile "$out/plugins/own-telemetry/index.js"
bun build packages/own-computer-use/src/index.ts --target=bun --format=esm @define --outfile "$out/plugins/own-computer-use/index.js"
bun build packages/own-harness/src/index.ts   --target=bun --format=esm @define --outfile "$out/plugins/own-harness/index.js"      # H0부터. 순서는 own-import 다음(맨 뒤)
#    own-import(IMPORT부터)는 bundle.ts만 만든다: src/worker.ts를 먼저 같은 define으로 번들하고 그 글을
#    define OWN_IMPORT_WORKER_SOURCE로 index 빌드에 넣는다(CLI 한 줄로는 할 수 없음) → "$out/plugins/own-import/index.js"
#    검사: define이 빠졌거나 따옴표가 사라졌으면 실패시킨다
foreach ($p in 'own-accounts', 'own-remote', 'own-team', 'own-telemetry', 'own-computer-use', 'own-import', 'own-harness') {
  $js = "$out/plugins/$p/index.js"; if (-not (Test-Path $js)) { continue }   # own-remote는 R0 이후
  $text = Get-Content -Raw $js
  if ($text.Contains('typeof OWN_') -or -not $text.Contains("`"$env:OWN_BUILD_ID`"") -or -not $text.Contains("`"$ver`"")) {
    throw "define 누락 또는 따옴표 손실: $js" }
}
cargo build --release --locked --manifest-path own/native/own-vault/Cargo.toml
Copy-Item own/native/own-vault/target/release/own-vault.exe "$out/"
# 3c) computer-use helper (own/native/own-cu-helper/build.ps1가 있을 때만; 없으면 경고하고 helper 없이 진행)
powershell -NoProfile -ExecutionPolicy Bypass -File own/native/own-cu-helper/build.ps1
Copy-Item own/native/own-cu-helper/target/own-cu-helper.exe "$out/"

# 3a) 앱에 넣는 Claude 구독 플러그인 (02 §8.2, 2026-10-18): own/vendor/claude-auth의 lock으로 임시 폴더에 npm ci
#     (--ignore-scripts --prefer-offline) → 버전·integrity 확인 → patches/<ver>.json 적용(pre/post hash) → bun build 한 파일
#     → "$out/plugins/claude-auth"(server.js, package.json, own-bundle.json{빌드 id, 파일마다 sha256}, node_modules\…). 어긋나면 실패
bun own/scripts/claude-auth-bundle.ts --out "$out/plugins/claude-auth" --build-id $env:OWN_BUILD_ID

# 4) 템플릿 복사 (설치 레이아웃의 app\<ver>\templates\). claude-auth 템플릿은 2026-10-18부터 싣지 않음(3a가 대신함)
Copy-Item own/config/ratecards.default.json "$out/templates/"

# 5) 데스크톱 셸 (P4 이후, 01 §4.1, 05 §4·§10.1). CLI를 번들하지 않음(extraResources 비움), 업데이터 없음(GUI 확장 목록에 없음), 프로토콜 등록 안 함
bun run --cwd packages/own-desktop build    # electron-vite. OWN_RPC_HASH(1b)를 main·preload에 새김. 치환 키가 하나라도 매칭 안 되면 buildEnd에서 실패
Push-Location packages/own-desktop
bunx electron-builder --win --config electron-builder.config.ts   # NSIS oneClick per-user (또는 --dir). artifactName → own-opencode-win-x64.exe (05 §4.5)
Pop-Location
Copy-Item packages/own-desktop/dist/own-opencode-win-x64.exe "$out/desktop/"   # upstream directories.output = "dist" (electron-builder.config.ts:61-62)
#   manifest의 desktop.rpcHash에는 1b의 값을 그대로 적는다 (셸 빌드에서 따로 계산하지 않음)

# 6) 원격 번들 (04 §5.2, R0 이후): linux-x64-baseline, linux-arm64 CLI + 3단계와 같은 플러그인 파일 → "$out/remote/*.tar.gz"
#    (REMOTE_PLUGINS = own-accounts, own-remote, own-team, own-telemetry, own-harness, own-omo. T3부터 2b단계의 고정 git-lfs → "$out/remote/tools/git-lfs/<ver>/<target>/")
#    이 PC에서 교차 빌드(RG2, 2026-09-27 산출물 단계 통과): 네이티브 선택 의존성은 own-remote script/native.ts가 bun.lock 버전으로
#    받아 빌드 동안만 연결하고, 빌드 뒤 verify-binary(ELF·버전·채널·네이티브 라이브러리)가 검사한다. Linux 빌드 호스트는 대체 경로(-LinuxBinary)
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-remote.ps1 -Version $ver

# 7) 검증
bun own/scripts/release-smoke.ts --out $out           # 설치 레이아웃(temp OWN_HOME) → launcher → health(buildId·version) → own.team health 왕복(T1) → own.import health(IMPORT, Worker를 띄우지 않음) → fake-provider 왕복 → selfTest agentModels·worktree.inspect 왕복 → 앱에 든 claude-auth(own-bundle.json의 빌드 id·hash, 로드 순서, patched·동의·계정 없음, health) → 웹 폴백 → 게이트웨이 깨우기 → 남은 프로세스·CodeIntegrity 검사
bun own/scripts/pe-inventory.ts --root $out          # app\·desktop\의 PE 목록과 서명 상태 → own/release/<ver>/pe-inventory.json
#   수동 게이트: G-D1·G-D2·G-D6(매 릴리스), G-D3(조건부) — §8.3 규칙. 성능 PF1–PF8(01 §16.3) → own/release/<version>/perf.json
```

**릴리스 id 정의** (1b에서 한 번 계산하고, 다른 단계는 계산하지 않고 받아 씁니다)
- **`build_id`는 입력의 해시입니다. 출력(번들)의 해시가 아닙니다.**
  - 번들은 자기 해시를 자기 안에 담을 수 없습니다.
  - `build.ts`는 own-accounts, own-telemetry(그리고 own-remote)가 같은 id를 갖기를 요구합니다(`packages/own-accounts/src/build.ts:11-15`, `packages/own-telemetry/src/build.ts:10-11`). 그래서 id는 번들보다 먼저 정해져야 합니다.
  - 입력은 세 가지입니다.
    - 릴리스 version 문자열(`2.0.18-own.N`)
    - LF 정규화한 `bun.lock`
    - `packages/own-{protocol,runtime,accounts,telemetry,remote,team,computer-use,import,harness}/`의 `package.json`, `tsconfig.json`, `src/**` 파일(테스트 제외, 없는 패키지는 건너뜀. `packages/own-remote/script/bundle.ts` `OWN_PACKAGES`, own-team은 T1부터, own-import는 IMPORT부터, own-harness는 H0부터)
  - 계산: 파일마다 `<저장소 상대 경로(/ 구분)>\n<내용 sha256 hex>\n`를 경로 이름순으로 이어 붙이고 맨 앞에 version 줄을 둡니다. 그 sha256 hex의 앞 12자가 id입니다.
  - upstream 쪽 입력(번들에 들어가는 `@opencode/*` workspace 소스)은 version이 대표한다고 봅니다. 같은 version을 다른 upstream 커밋으로 다시 빌드하지 않는 것이 전제입니다(§8.1). 작업 트리가 dirty하면 id도 달라집니다. `build-info.json`의 `fork_dirty`로 드러납니다.
- **`OWN_EXPECTED_APP_VERSION`과 `OWN_PLUGIN_VERSION`은 둘 다 릴리스 version입니다.** 1단계 CLI가 보고하는 버전(`OPENCODE_VERSION`, `build-own.ps1` 검증 1번)과 같아야 가드 1이 통과합니다. define 세 개는 세 번들에 **똑같이** 넣습니다.
- **Windows PowerShell 5.1 주의(2026-09-27 이 PC에서 확인).** 5.1은 네이티브 명령 인자 안의 `"`를 벗깁니다. 그래서 `--define OWN_BUILD_ID="…"`가 `OWN_BUILD_ID=b7e2…`(식별자)로 넘어갑니다. Bun은 경고 없이 `typeof b7e2… === "string" ? …`를 만들고, 결과는 `"dev"`로 떨어집니다. PowerShell 7(7.6.6에서 확인)과 bash에서는 위 명령이 문자열 리터럴로 들어갑니다. `build-own.ps1`은 `powershell`(5.1)로 실행하므로, 3단계를 넣을 때 CLI 플래그 대신 `Bun.build({ define })`를 부르는 작은 bun 스크립트로 번들하고 위 검사를 유지합니다.
- **`rpcHash`는 셸 ↔ 렌더러 IPC 계약의 해시입니다(05 §5.5, G-D6).** 구현은 `packages/own-desktop/scripts/rpc-hash.mjs`(`rpcHashInputs`)이고, 입력(저장소 상대 경로 이름순, `*.test.ts` 제외)은 다음과 같습니다.
  1. `packages/desktop/src/shared/ipc-rpc.ts` (집계 파일)
  2. `packages/desktop/src/shared/ipc-rpc/*.ts`. 2026-09-27에는 10개(`app, browser, events, files, menu, ssh, storage, updater, window, wsl`), v2.0.24부터 7개(`app, events, extensions, files, menu, storage, window`)
  3. `packages/desktop/src/shared/ipc-transport.ts`
  4. `packages/desktop/src/shared/ipc-contract.ts`
  5. `packages/desktop/src/shared/window-bootstrap.ts` (main이 쓰고 preload가 읽는 bootstrap 인자)
  6. `packages/gui-extensions/src/browser/ipc.ts` (v2.0.24: own-web이 `ExtensionCall`로 부르는 브라우저 패인 Ipc. 05 §8.2)
  7. `packages/own-desktop/src/preload/own-api.ts` (`window.own` 계약)
  - 계산: 위 파일의 LF 정규화 내용을 경로 이름순으로 이어 붙인 sha256 hex의 앞 16자입니다. 2026-10-08 값은 `37e955092360b9ff`입니다(브라우저 Ipc를 넣기 전 `bc2d7e04298448bc`).
  - 처음 계획에 있던 `preload/index.ts`, `packages/app/src/servers/ssh/types.ts`, `packages/plugin-browser/src/rpc.ts`는 넣지 않았습니다. `Browser.State`·`Action` 스키마의 호환은 attach version(`browser-attach-v4`)과 G-D5가 봅니다.
  - 한 구현(`release-ids.mjs`)만 씁니다. 릴리스 빌드는 1b의 env 값을 셸 빌드(`OWN_RPC_HASH`), own-web desktop chunk, `manifest.json`의 `desktop.rpcHash`에 똑같이 새깁니다. 개발 빌드처럼 env가 없으면 own-desktop `electron.vite.config.ts`와 own-web vite 설정이 같은 모듈을 불러 계산합니다.
  - 목록 밖 모듈을 새로 import하면 surface 항목 `desktop-ipc-contract`(§7)가 실패시킵니다. 그때 목록을 고칩니다.
- `build-own.ps1`은 저장소 경로에 `#`이 있으면 멈춥니다. `own/.out` 밖으로 출력하지 않습니다(upstream `build.ts`가 출력 디렉터리를 지우기 때문).
- Electron 바이너리(151MB)는 처음 한 번 받습니다. electron-builder는 `bun.lock`을 감지해야 합니다. 작업 트리 밖에서 돌리면 `npm ls`로 떨어집니다(01 §18의 11).
- 셸은 서명하지 않습니다(SmartScreen 경고). upstream의 서명 훅은 `GITHUB_ACTIONS=true`일 때만 돌고 Actions는 꺼져 있습니다.

### 8.3 `own/release/<version>/manifest.json` (커밋 대상)

`app\<ver>\manifest.json`에도 같은 내용이 들어갑니다. 데스크톱 셸은 여기서 `version`(DesktopCli, 05 §5.4)과 `desktop.rpcHash`(렌더러 위치 결정, 05 §5.5)를 읽습니다(01 §5.3 c).

```json
{
  "version": "2.0.18-own.1",
  "channel": "own",
  "build_id": "<§8.2 1b의 입력 해시 12자. 세 플러그인 번들에 OWN_BUILD_ID로 같은 값이 들어감 (01 §4 싱글턴 키, health.buildId)>",
  "fork_commit": "<main sha>",
  "upstream": { "branch": "v2", "merged_commit": "00d179015f", "release_marker": "39021dfd67", "release": "2.0.18" },
  "toolchain": { "bun": "1.4.4", "node": "22.x (scripts/npm)", "rust": "<rustc -V>",
                 "electron": "44.10.2", "electron_vite": "6.0.0-beta.1", "electron_builder": "26.15.7" },
  "install_layout": "pointer",
  "artifacts": {
    "opencode.exe": "sha256:…",
    "web/": "sha256-tree:…",
    "plugins/own-accounts/index.js": "sha256:…",
    "plugins/own-remote/index.js": "sha256:…",
    "plugins/own-team/index.js": "sha256:… (T1, 2.0.18-own.6부터)",
    "plugins/own-telemetry/index.js": "sha256:…",
    "plugins/own-computer-use/index.js": "sha256:…",
    "plugins/own-import/index.js": "sha256:… (IMPORT부터, 스캔 Worker 소스를 품은 한 파일)",
    "plugins/own-harness/index.js": "sha256:… (H0 뒤의 첫 릴리스부터)",
    "own-vault.exe": "sha256:…",
    "own-cu-helper.exe": "sha256:… (helper를 빌드했을 때만)",
    "plugins/claude-auth/": "sha256-tree:… (2026-10-18부터, 앱에 든 Claude 구독 플러그인. 그 전에는 templates/claude-auth/의 세 파일)",
    "templates/ratecards.default.json": "sha256:…"
  },
  "desktop": { "version": "2.0.18-own.1", "app_id": "dev.own.opencode.desktop",
               "installer": "own-opencode-win-x64.exe", "installer_sha256": "…",
               "rpcHash": "<§8.2 1b의 값 16자, 셸 빌드·own-web desktop chunk와 같음 (G-D6)>" },
  "remote_artifacts": { "linux-x64-baseline": { "sha256": "…", "bytes": 0, "files": { "opencode": "sha256:…" } },
                        "linux-arm64":        { "sha256": "…", "bytes": 0, "files": { "opencode": "sha256:…" } },
                        "tools": { "git-lfs": { "version": "3.8.1", "targets": {
                          "linux-x64-baseline": { "file": "tools/git-lfs/3.8.1/linux-x64-baseline/git-lfs", "sha256": "…", "bytes": 0,
                                                  "files": { "git-lfs": "sha256:…", "LICENSE.md": "sha256:…" } },
                          "linux-arm64": { "file": "tools/git-lfs/3.8.1/linux-arm64/git-lfs", "sha256": "…", "bytes": 0,
                                           "files": { "git-lfs": "sha256:…", "LICENSE.md": "sha256:…" } } } } } },
  "patches_active": ["P-001", "P-002"],
  "thirdparty_slots": {
    "claude-auth": { "package": "opencode-claude-auth-v2", "version": "0.4.0-beta.5",
                     "integrity": "sha512-dVA2AY58JxrZP3QqetevB3yebwQLVoMGyBFrPbJPDdCgJ94UEzQpK9/5Jk0Ibeyeom5mWD/HInaJgfX9O5MljA==",
                     "overrides": { "@opencode/plugin": "2.0.24" },
                     "patch": "sha256:… (patches/<ver>.json, 2026-10-18부터)", "bundled": "plugins/claude-auth" }
  },
  "gates": { "desktop": { "G-D1": "pass", "G-D2": "pass", "G-D6": "pass", "G-D3": "skipped: 수명주기 변경 없음" },
             "perf": "perf.json" }
}
```

- 같은 폴더에 `pe-inventory.json`(§8.2 7단계 `pe-inventory.ts`, 2026-10-05부터)과 `perf.json`도 커밋합니다.
- `install_layout: "pointer"`(2.0.18-own.3부터): 이 버전의 플러그인과 셸이 `OWN_HOME\app\current.json`으로 버전 폴더를 찾습니다(01 §5.1, junction 없음). 이 키가 없는 버전(own.2 이하)으로 `own rollback`하면 launcher가 그 버전의 플러그인을 위해 `app\current` junction을 다시 둡니다(키가 없는 manifest는 own-accounts 번들에 `current.json` 문자열이 있는지로 판단).
- `patches_active`는 웹 폴백(P-001/P-002)을 켠 뒤의 예입니다. 데스크톱 모드만 쓰는 빌드라면 빈 배열입니다.
- `remote_artifacts`와 `plugins/own-remote`는 R0 이후에, `plugins/own-team`은 T1(2.0.18-own.6) 이후에, `plugins/own-import`는 IMPORT 뒤의 첫 릴리스부터, `plugins/own-harness`는 H0 뒤의 첫 릴리스부터 생깁니다(`build-desktop.ps1`이 `$pluginNames`마다 해시를 적음). 원격 번들(`REMOTE_PLUGINS`)에는 T3부터 own-team이 들어갑니다(원격 팀, 06 §4.13. T3 종료 빌드 2.0.18-own.7부터). own-import는 원격 번들에 들어가지 않습니다(release-smoke가 확인). own-harness는 2026-10-12(10 §6.1)부터, own-omo는 2026-10-29(15 §1)부터 맨 뒤에 들어갑니다(own-omo는 런타임과 세 고지 파일과 함께, release-smoke가 확인). 항목 모양(`sha256`, `bytes`, `files`)은 04 §5.2를 따릅니다.
- **`remote_artifacts.tools`(T3).** 원격에 동봉하는 도구의 기록입니다. 지금은 `git-lfs` 하나이고 대상마다 `file`(`remote\` 기준 경로), 바이너리의 `sha256`·`bytes`, 그 버전 폴더의 `sha256sum -c` 항목 `files`(`git-lfs`, `LICENSE.md`)를 둡니다. 원격 `remote\manifest.json`에도 같은 `tools`가 있고, own-remote `hosts.tools.ensure`가 호스트에 보내기 전에 로컬 파일을 이것과 맞춥니다(다르면 `tool_hash_mismatch`, 04 §16.2). `tools`는 대상 키와 같은 층에 있으므로 대상을 셀 때는 원격 manifest의 `targets`를 읽습니다.
- `installer`는 05 §4.5의 `artifactName`(`own-opencode-${os}-${arch}.${ext}`)에서 나온 이름이라 버전이 들어가지 않습니다. 버전은 `desktop.version`과 태그로 구분합니다.
- 키 이름은 대부분 snake_case지만 `desktop.rpcHash`만 셸 코드(05 §5.5 `manifest.desktop.rpcHash`)와 같게 camelCase로 둡니다.
- **데스크톱 게이트 규칙(릴리스마다).** 이 규칙은 manifest, §11 체크리스트, 01 §16.2가 같이 따릅니다.
  - 매 릴리스: G-D1(upstream 서비스 보존), G-D2(OS 통합 격리), G-D6(rpcHash). 셋 다 통과해야 출시합니다.
  - 조건부 G-D3(창과 서비스 수명 분리). 셸 수명주기 코드가 바뀐 릴리스에만 돌립니다. 대상은 own-desktop `src/main/{index,desktop,own-env,own-ipc}.ts`와 `src/main/service/*`, launcher의 start/stop/restart 경로, upstream `src/main/lifecycle/*`·`windows/*`의 drift입니다. 돌리지 않으면 이유를 적습니다.
  - 조건부 G-D4(알림)와 G-D5(브라우저 패인, P5 이후). 해당 기능 코드나 upstream `packages/gui-extensions/src/browser`(v2.0.24 전 `browser-pane*.ts`)·`packages/plugin-browser`가 바뀐 릴리스에만 돌립니다. 돌리면 같은 객체에 결과를 더합니다.

### 8.4 고정 원칙
- **자동 업데이트 없음.** own 전역 config(`%USERPROFILE%\.config\own-open-code\opencode.jsonc`)에 `"update": "disable"`을 두고, launcher가 `OPENCODE_DISABLE_AUTOUPDATE=1`을 설정합니다(`packages/cli/src/services/updater.ts:428-440`).
  - 업데이트 검사는 npm `@opencode/cli`와 비교하는 방식이 아닙니다. `https://opencode.ai/update/api/<channel>/<artifact>/npm?current=<version>`을 부르므로 우리 빌드는 채널 `own`으로 조회합니다(`updater.ts:235-245`). 설치는 감지된 설치 방식(npm/pnpm/bun 전역, `~/.opencode/bin`, brew, 실행 파일 옆 `@opencode/cli` manifest, `updater.ts:131-143`)이 필요하므로, `%LOCALAPPDATA%\own-open-code\app\…`의 바이너리는 "update skipped: installation method not found"로 끝납니다(`updater.ts:457-461`).
  - 그래도 끄는 이유: 기본 정책 `notify`(`updater.ts:151`)에서는 fork의 채널과 버전을 opencode.ai로 보내는 호출이 생기고, upstream이 채널 매핑이나 설치 방식 감지를 바꿀 때의 의외의 동작을 막기 위해서입니다.
- **플러그인은 `%USERPROFILE%\.config\own-open-code\opencode.jsonc`에 디렉터리 경로로 설정**하므로 npm 업데이트 검사 대상이 아닙니다. claude-auth는 lockfile과 integrity로 전이 의존성까지 고정하고, 빌드가 그 lock으로 설치·패치·번들해 앱에 넣습니다(3a). `own/vendor/claude-auth/package.json`의 `@opencode/plugin` override는 v2.0.24까지는 fork가 기반으로 하는 upstream release 버전과 맞췄고, v2.0.28부터는 일부러 `2.0.24`로 둡니다. 번들이 `@opencode/plugin`을 external로 두어 실행 때는 host 서비스가 주는 모듈(언제나 fork의 release)을 쓰고, `npm ci`가 설치하는 사본은 번들에도 앱에도 들어가지 않기 때문입니다(`own/vendor/claude-auth/README.md`). 빌드 자체가 새 release를 필요로 할 때만 올리고, 그때 lock을 다시 만들고 G9를 다시 검증합니다.
- **셸 업데이터도 없습니다.** v2.0.24부터 upstream 업데이터는 GUI 확장이고(패키지 빌드이면서 CHANNEL이 `dev`가 아니면 켜짐) own-desktop의 내장 GUI 확장 목록 치환(`src/overrides/gui-extensions.ts`)에 없으므로 셸 번들에 들어가지 않습니다. 그 전에는 `UPDATER_ENABLED=false`로 치환했습니다. builder 설정에는 `publish:null`을 둡니다. 셸은 `install.ps1`이나 수동 설치로만 바뀝니다(01 §5.5).
- **설치와 전환**은 `own/launcher/install.ps1`이 합니다.
  1. `%LOCALAPPDATA%\own-open-code\app\<version>\`에 배치합니다(`templates\`, `web\`, `remote\` 포함).
  2. 실행 중인 세션을 확인하고 사용자에게 확인받습니다. 연결된 원격 호스트의 실행 중 세션과 브로커 `proto` 호환도 확인합니다(04 §5.7).
  3. `service stop`
  4. `opencode-own.db`를 백업합니다.
  5. 버전 포인터 `app\current.json`을 새 버전으로 쓰고(temp → fsync → rename) `opencode.jsonc`의 own 플러그인 항목을 새 버전 폴더로 고칩니다. 데스크톱 렌더러(`web\`)도 같이 바뀝니다(셸은 페이지 로드마다 포인터를 읽음). 이전 launcher의 `app\current` junction은 따라가지 않고 링크만 지웁니다.
  6. 두 서비스 설정 파일(env 브리지, 01 §5.2)을 갱신하고 `service start`
  7. health를 확인합니다. 설치된 셸의 rpcHash가 새 manifest와 다르면 셸 설치 파일(NSIS)을 실행하라고 안내합니다. 셸 설치까지 `install.ps1`이 맡을지는 §12에 있습니다.
  8. 실패하면 이전 포인터, 플러그인 항목, DB로 되돌립니다.
- **롤백**: DB 마이그레이션은 되돌릴 수 없다고 가정합니다. 이전 버전으로 돌아갈 때는 그 버전으로 전환할 당시의 DB 백업을 함께 복원합니다(그 이후 세션은 export해 둠).
- **배포 범위**: 개인 사용 전용입니다. 바이너리와 셸 설치 파일을 공개 배포하지 않습니다. 공개하려면 §10의 고지 의무와 서명을 다시 검토해야 합니다.

---

## 9. CI 방침

- **GitHub Actions는 저장소 단위로 비활성화되어 있습니다**(§3, 2026-09-26 확인). upstream의 workflow 파일(`.github/workflows/*.yml`, 현재 27개)은 **지우지 않습니다**. 지우면 매 merge마다 충돌이 생깁니다. 저장소 설정으로 꺼 두면 새로 들어오는 workflow도 실행되지 않습니다. 특히 upstream의 `close-issues`, `close-prs`, `compliance-close`, `docs-update`, `stats`(schedule), `publish` 같은 예약·배포 workflow가 우리 저장소에서 돌면 안 됩니다.
- **로컬 CI** (`own/scripts/check.ps1`, 예정. 그 전에는 아래 명령을 하나씩 실행합니다):

| 단계 | 명령 | Bun 필요 |
|---|---|---|
| ledger | `node own/scripts/check-ledger.mjs` | 아니오 |
| surface | `node own/scripts/check-surface.mjs` | 아니오 |
| 순수 로직 단위 | `node --test --experimental-strip-types packages/own-*/test/pure/**/*.test.ts` | 아니오 |
| lint + typecheck | `bun run check` (= `oxlint` + `bun turbo typecheck --concurrency=3`). `-Baseline`이면 `--continue`로 돌려 `typecheck-baseline.yaml`과 비교 | 예 |
| own 패키지 테스트 | 각 `packages/own-*`에서 `bun test` | 예 |
| Android 단위 | `packages/own-android`에서 `gradlew --no-daemon --offline testDebugUnitTest`. 그 프로세스에만 `JAVA_HOME=%LOCALAPPDATA%\Programs\jdk-21`, `ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk`. 받을 것이 있으면 `--offline`이 실패하므로 내려받기는 사용자가 따로 합니다 | 아니오 |
| 녹화 테스트 | `CI=true` + `@opencode/http-recorder` 카세트 (카세트가 없으면 실패) | 예 |
| 비밀 스캔 | `gitleaks detect --no-banner` (설치되어 있으면. 루트 `.gitleaksignore` 준수) + own 전용 규칙(`sk-`, `sk-ant-`, `xai-`, JWT `eyJ…`, `.dpapi` 파일 커밋 금지) | 아니오 |
| 스모크 (예정) | `own/scripts/smoke.ps1` (빌드 산출물, fake-provider) | 예 |
| 데스크톱 빌드 (P4 이후) | `bun run --cwd packages/own-desktop build`. 치환 키 매칭 검사(`buildEnd`), deep import와 `@opencode/app` export 경로 확인 | 예 |
| 성능 (P3 이후) | `packages/own-web/e2e/performance`(01 §6.6). PF2–PF5, PF7은 프로덕션 번들로 자동, PF1·PF6·PF8은 패키지 셸에서 수동 | 예 |

- **push 게이트**: husky `pre-push`가 `bun run check`를 실행합니다. 우회는 §3의 두 예외(미러 push, 기준선과 같은 upstream 실패)뿐이고 둘 다 기록합니다.
- **merge 게이트**: sync 브랜치에서 위 표를 전부 통과해야(typecheck는 기준선 대비 신규 실패 0) `main`에 ff-merge합니다.
- 비용이 큰 실계정 PoC 게이트(G2, G4, G7 등)와 데스크톱 게이트(G-D1–G-D6)는 CI에 넣지 않습니다. 릴리스 체크리스트(§11)에서 §8.3의 게이트 규칙대로 실행합니다. own-desktop `test/`의 D1·D2·D6 자동 시험(05 §4.1)은 그때 쓰는 도구입니다.
- 성능 결과는 기계에 따라 다르므로 CI 통과 조건이 아니라 **릴리스 게이트**입니다. 기준 기계(이 PC)에서만 판정하고 `own/release/<version>/perf.json`에 남깁니다(01 §16.3).

---

## 10. 라이선스

| 대상 | 라이선스 | 취급 |
|---|---|---|
| upstream OpenCode (이 저장소 전체) | MIT (`LICENSE`, "Copyright (c) 2025 opencode") | `LICENSE`와 파일 내 고지는 수정하지 않습니다. 코어 패치는 upstream 파일의 파생물이므로 MIT로 두고, upstream PR로 기여할 수 있게 유지합니다. |
| 우리 코드 (`own/**`, `packages/own-*`) | `"private": true`, `"license": "MIT"` | 저장소 소유자가 MIT로 정함(2026-11-26). 루트 `LICENSE`에 업스트림과 우리 저작권 줄이 함께 있음(P-066), 예외는 `own/THIRD-PARTY-NOTICES.md` |
| `packages/app`, `packages/desktop`에서 vendor·치환한 파일 | MIT (upstream, `packages/desktop/package.json`도 MIT) | 파일 머리의 출처 주석과 `vendored.yaml`에 기록합니다. |
| Electron(Chromium 포함), electron-builder의 NSIS | Electron은 MIT. 번들된 Chromium과 그 의존성은 각 라이선스(셸 설치 파일의 `LICENSES.chromium.html`) | 비공개 사용 전제입니다. 공개 배포로 바꾸면 고지를 다시 확인합니다. |
| lighthouse (셸 런타임 의존성, 선택) | Apache-2.0 | 브라우저 감사 기능을 넣을 때만 포함합니다(01 §20). |
| `uqr`, `qr-scanner` (후속 페어링 QR) | MIT ⚠(도입할 때 확인) | upstream `packages/app`가 이미 씁니다(01 §6.4). |
| opencode-claude-auth-v2 | MIT (npm `package.json`, 패키지의 `LICENSE`) | **2026-10-18부터 앱에 넣어 배포합니다**(사용자 결정 "넣고 항상 켜기"). 빌드가 고정 lock으로 설치하고 own의 패치(저장소의 `own/vendor/claude-auth/patches/`)를 적용해 한 파일로 묶습니다. 패키지 자신의 파일만 묶이고(다른 패키지 코드 없음), 게시된 `LICENSE`를 `app\<ver>\plugins\claude-auth\node_modules\opencode-claude-auth-v2\LICENSE`에 함께 둡니다. 개인 사용 전용 배포 범위(§8.4)는 그대로입니다. 약관 위험은 라이선스와 별개이며 UI에서 정보로 고지합니다(`01-architecture.md` §9, `02` §8). 그 전에는 번들·재배포하지 않고 사용자가 UI에서 설치를 요청하면 npm에서 받았습니다. |
| trycua `cua-driver` | MIT | 채택하지 않았습니다(2026-10-01 엔진 결정: 자체 드라이버. 기본은 플러그인 안 FFI, 대체로 `own-cu-helper`). 나중의 선택 Driver 어댑터 후보로만 남깁니다. 쓰게 되면 설치 스크립트로 받고 번들하지 않습니다. |
| trycua `cua-perception` | **AGPL-3.0-only** | **사용하지 않습니다.** 설치하거나 번들하거나 링크하지 않습니다. |
| iFurySt/open-codex-computer-use | MIT | 도구 계약 참고용입니다. 코드를 복사하면 `vendored.yaml`에 기록합니다. |
| own-vault Rust 의존성 (`windows`, `serde` 등) | MIT/Apache-2.0 | `own/native/own-vault/THIRD_PARTY.md`를 `cargo about` 같은 도구로 생성합니다. |
| `own-cu-helper` (우리 코드, C#) | 우리 코드와 같음 | 윈도 기본 .NET Framework 4.x(`csc.exe`, `System.Drawing`, `UIAutomationClient`)는 Windows 구성 요소라 번들·재배포하지 않습니다. 서드파티 코드가 없습니다. |
| computer-use FFI 드라이버 (우리 코드, `packages/own-computer-use/src/driver/windows/ffi`) | 우리 코드와 같음 | Windows 시스템 DLL(user32, gdi32, gdiplus, ole32, kernel32, advapi32, shcore, dwmapi, UIAutomationCore)을 Bun 내장 `bun:ffi`로 부릅니다. 번들·재배포하는 바이너리가 없습니다. |
| Gradle wrapper (`packages/own-android/gradle/wrapper/gradle-wrapper.jar`, Gradle 9.8.0) | Apache-2.0 | 저장소에 커밋한 바이너리입니다. APK에는 들어가지 않습니다. |
| `androidx.webkit:webkit` (own-android) | Apache-2.0 (Maven POM) | APK에 들어갑니다(`ProxyController`). |
| `com.google.android.gms:play-services-code-scanner` (own-android) | ML Kit Terms of Service(POM). 딸린 `play-services-base`·`-basement`는 Android Software Development Kit License | APK에 들어가는 Google 독점 라이브러리입니다. 오픈 소스가 아니므로 공개 배포로 바꾸면 약관을 다시 확인합니다. QR 스캔에만 씁니다. |
| `junit:junit` 4.13.2, `org.json:json` (own-android 시험 전용) | EPL-1.0, Public Domain (Maven POM) | JVM 단위 시험에만 쓰고 APK에는 들어가지 않습니다. |
| git-lfs 3.8.1 (원격 호스트용 공식 정적 Linux 빌드, linux-amd64·arm64, T3. 2026-10-30에 3.8.0에서 올림, CVE 네 개 수정) | MIT (Git LFS `LICENSE.md`). Go에서 복사한 BSD-3-Clause 부분이 있고, 묶인 Go 모듈 의존성은 각자의 라이선스 | 공식 릴리스 바이너리를 고치지 않고 원격 산출물 `app\<ver>\remote\tools\git-lfs\<ver>\<target>\`에 `LICENSE.md`와 함께 둡니다(공식 압축 파일에 라이선스가 없어 git-lfs 저장소의 파일을 씀. 대상 압축 파일 안에는 넣지 않음). 그 저장소가 LFS를 쓰는 SSH 호스트에만 올려 `<OWN_HOME>/tools/git-lfs/<ver>/`에 두고(sudo 없음) 이 PC에는 설치하지 않습니다(06 §4.13, 04 §16.2). 출처·버전·압축 파일 sha256은 `own/ledger/vendored.yaml`의 주석 기록입니다. 내려받기와 동봉은 2026-10-04 결정이고, 실제 내려받기는 사용자가 대화에서 확인하거나 `-GitLfsArchive`로 사본을 줄 때만 합니다(사용자 확인은 3.8.0과 2026-10-31의 3.8.1. 3.8.1 압축 파일은 2026-10-31에 받았고 sha256과 크기가 고정값과 같음, §8.2 2b단계, MR8-21). 비공개 사용 전제이며, 공개 배포로 바꾸면 Go 의존성 고지를 다시 확인합니다. |
| `gray-matter` 4.0.3과 그 의존성 `js-yaml` 3.x (own-import 번들, SKILLS) | MIT | upstream core가 이미 쓰는 같은 버전입니다. own-import 번들 `index.js`에 들어갑니다(SKILL.md 머리말 읽기, 09 §9.3). |
| openai/codex (Codex CLI) | Apache-2.0 | own-harness의 codex-data/(모델 카탈로그 일부, prompt.md, apply_patch 문법, 압축 문구)를 생성 스크립트로 가져옵니다. LICENSE·NOTICE를 같이 둡니다. 기준 커밋은 own/ledger/codex-pin.json, 갱신은 own/scripts/codex-sync.ts. |
| earendil-works/pi (Pi 코딩 에이전트) | MIT ("Copyright (c) 2025 Mario Zechner") | own-harness의 `pi` 하네스(src/pi/)가 지시문, 도구 문구와 동작을 옮겼습니다(12, 기준 `dd30101cf`, v1.5.1). `pi-data/`에 LICENSE·NOTICE와 옮긴 파일의 해시(`source.json`)를 둡니다. |
| deepseek-ai/deepseek-harness (dsh) | MIT ("Copyright (c) 2026 DeepSeek") | own-harness의 `dsh` 하네스(src/dsh/)가 지시문 구역, 기록에 붙는 메시지, 도구 문구와 동작을 옮겼습니다(13, 기준 `687f282e86`, dsh 0.2.1-rc.2, 그 위에 `f3803c9697`의 고침 세 가지와 `66491b05e3`(dsh 0.2.2-rc.1)의 쓰기 실패 문구. 읽기 전 쓰기 확인은 upstream과 달리 켜 둡니다, 13 §3.5). `dsh-data/`에 LICENSE·NOTICE, 옮긴 파일의 해시(`source.json`, 고침은 `backports`), 시험이 비교하는 dsh 스냅샷을 둡니다. DeepSeek 어댑터의 wire extension(`dsh_session_log`)과 텔레메트리는 옮기지 않습니다. |
| oh-my-opencode (omo, YeonGyu Kim) | SUL-1.0 (Sustainable Use License 1.0, 저장소의 `LICENSE.md`). MIT로 따로 배포되는 부분(lsp-tools-mcp, comment-checker, 실행 파일 패키지)은 각자의 라이선스 | v5.1.50(`d4d2204e07`)을 `own/vendor/oh-my-opencode`에 vendor하고(원본 바이트, `source.json`·`pin.json`, 사본 `own/ledger/omo-pin.json`), 빌드 때 own의 패치(`patches/<tag>.json`, OMO-P1…)를 적용해 `plugins/own-omo`에 `LICENSE.md`, `THIRD-PARTY-NOTICES.md`, `MODIFICATIONS.md`와 함께 둡니다. 번들 첫머리에도 라이선스와 MODIFICATIONS.md를 적습니다. 저장소 소유자의 개인·비상업 사용 전용이고(§8.4. SUL은 개인 사용을 위한 사용·복사·수정을 허락함), 상업적으로 재배포하지 않으며 upstream에 올리지 않습니다. 고지와 라이선스 문구는 지우거나 고치지 않습니다. MIT 부분은 vendor하지 않습니다(15). |
| 웹 폰트 (예: 한글 폰트를 번들한다면) | 예: SIL OFL-1.1 | 번들하면 라이선스 파일을 함께 둡니다. |
| 빌드된 바이너리의 번들 의존성 | 각 라이선스 | 비공개 사용 전제입니다. 공개 배포로 바꾸면 THIRD_PARTY 고지를 생성해야 합니다. |

---

## 11. 체크리스트

**upstream sync (매회)**
- [ ] 작업 트리가 깨끗하고, 진행 중인 기능 브랜치가 `main`에 반영되었거나 보류됨
- [ ] 미러 ff 갱신 및 push(`HUSKY=0`, 기록)
- [ ] 새 release marker가 있는지 확인(없으면 종료). tip merge면 사유 기록
- [ ] upstream `packageManager`의 Bun 버전 확인, 바뀌었으면 그 버전 설치
- [x] (v2.0.24에서 처리, 이후 해당 없음) 범위에 `d9987ef9c8`이 들어오면 merge 전에 codex·oai slot의 `maxTokens` 제거와 ds `none` 출력 한도 결정(비었을 때만, upstream 값 우선)이 `main`에 있는지 확인하고, merge 중에 P-017을 `estimatePrompt`에 다시 적용한 뒤 runner 출력 한도 경로의 `shared` 여부를 정하고 P-017 시험을 다시 돌림(§4)
- [x] (v2.0.24에서 처리, 이후 해당 없음) 범위에 `bda798b167`이 들어오면 지시 기준선 순서 변경(활성 세션마다 cold 1회)을 `SYNC_LOG.md`와 그 merge의 릴리스 노트에 적음(§4)
- [ ] merge → 충돌 정책 적용 → `bun install`로 lock 재생성
- [ ] check-ledger ✅(active 패치 + 미흡수 cherry-pick만) · check-surface ✅ (계약 파괴가 있으면 중단) · typecheck ✅(기준선 대비 신규 실패 0) · own 테스트 ✅ · smoke ✅
- [ ] check-surface의 프롬프트·도구 바이트 항목(`prompt-bytes-*`, `prompt-tool-guidance`, `tool-surface-patch-predicate`, `shell-tool-description`)이 CHANGED면 그 계열의 cold 1회를 `SYNC_LOG.md`와 릴리스 노트에 적고 D9 재확인. `env-builtin`은 delta 1회(§7)
- [ ] (P4 이후) own-desktop 빌드 ✅(치환 키 전부 매칭). `packages/desktop`·`packages/gui-extensions/src/{browser,sdk}`·`plugin-browser`·`packages/app`(desktop main이 import하는 export, §7)·`app/e2e/performance` drift 검토, 필요하면 G-D1·G-D2와 PF2–PF4 재검. rpcHash 입력(§8.2 1b)이 바뀌었으면 G-D6. upstream 내장 GUI 확장 목록(`gui-extensions/src/main.ts`)에 새 main 확장이 생기면 셸에 넣을지 정함(05 §8.1.1, 기본은 넣지 않음)
- [ ] Electron 판이 바뀌었으면 own-desktop devDependencies를 upstream과 같게 올림
- [ ] 흡수된 cherry-pick 항목 삭제
- [ ] claude-auth override 버전 확인, 패치 매니페스트가 그 버전에 맞는지(빌드 3a가 확인), G9 재검
- [ ] `main`에 ff 반영, push, `SYNC_LOG.md` 기록

**릴리스 (매회)**
- [ ] Actions 비활성 재확인(`gh api …/actions/permissions` → `{"enabled":false}`)
- [ ] 버전 `2.0.N-own.K` 결정, 빌드 env 설정(`OPENCODE_CHANNEL=own`, `OPENCODE_VERSION`, `OPENCODE_WEB_APP=own-web`)
- [ ] 빌드(§8.2): 바이너리 → build id·rpcHash 계산(1b) → `web`(own-web) → 플러그인 번들(define 3개, 번들 검사 통과) → claude-auth 번들(3a) → own-vault, templates → 데스크톱 셸(NSIS `own-opencode-win-x64.exe`) → (R0 이후) 원격 번들(T3부터 `REMOTE_PLUGINS`의 own-team과 sha256을 맞춘 고정 git-lfs, §8.2)
- [ ] 설치된 서비스의 `health`에서 `buildId`가 manifest `build_id`와 같고 `guard: "ok"`인지 확인(define 누락이면 `skew`)
- [ ] `manifest.json` 작성과 커밋, 태그 `v<version>`
- [ ] 수동 게이트: G2(인증 주입), G7(한도 수집), G14(비밀 위생, 셸 로그·userData 포함), G18(프로젝트 플러그인 차단) 최소 재검
- [ ] 데스크톱 게이트(§8.3 규칙): 매번 G-D1(upstream 서비스 보존), G-D2(`opencode://`·앱 id 격리), G-D6(rpcHash). 셸 수명주기 코드가 바뀌었으면 G-D3, 알림·브라우저 패인 쪽이 바뀌었으면 G-D4·G-D5. 결과를 manifest `gates.desktop`에 기록
- [ ] 컴퓨터 사용: `own-computer-use`(FFI 드라이버 포함)나 helper가 바뀌었으면 잠금 해제된 데스크톱에서 `OWN_CU_REAL=1 bun test test/real`(packages/own-computer-use, 두 드라이버 모두. helper 변형은 빌드해 둔 exe가 있을 때만 돎). `driver: "helper"`를 쓰는 설치가 있으면 빌드 로그에 3c단계 경고가 없고 `app\<ver>\own-cu-helper.exe`가 있는지도 확인
- [ ] 성능 게이트: PF1–PF8을 이 PC에서 측정, `own/release/<version>/perf.json` 커밋(실패는 출시 차단)
- [ ] `install.ps1`로 전환(DB 백업, env 브리지 포함), health 확인, 롤백 경로 확인. rpcHash가 바뀌었으면 셸 재설치

**1회성**
- [x] Actions 비활성(2026-09-26 `{"enabled":false}` 확인)
- [ ] rerere, upstream push 차단, upstream 태그 fetch 끔
- [x] Bun 1.4.2 설치(`npm i -g bun@1.4.2`) → `bun install` → husky 활성 확인(2026-09-27)
- [x] Windows lint/typecheck 기준선: 심볼릭 링크 복구 후 `bun run check` 전체 통과(2026-09-27, pre-push 기준)

**Windows 체크아웃 주의 (2026-09-27)**
- **현재 고정된 개발 도구에서는 실제 작업 경로의 `#`을 피합니다.** Windows나 Bun 자체의 파일명 제한이 아니라, OpenTUI 0.5.12 플러그인이 경로의 `#` 뒤를 잘라 발생하는 EISDIR와 Vite 8.2.2 개발 서버의 경로 처리 문제입니다. 기본 Bun 빌드와 일부 Vite production build는 통과해도 개발 서버까지 지원된다는 뜻은 아닙니다. 그래서 개발 워크트리는 `D:\own-open-code`(`main`)에 둡니다. 원본 체크아웃은 `D:\#Projects\own-open-code`이며 2026-09-29 확인한 브랜치는 `computer-use`입니다. 단순 subst/새 이름의 링크는 실제 경로가 다시 `#`을 포함할 수 있습니다. 물리 폴더 이름 변경 후 이전 경로를 junction으로 보존하는 방법은 격리 시험에서 통과했지만, 현재 Codex 관리 프로그램의 프로필 경로 이전도 필요합니다. 전체 폴더를 바로 바꾸지 말고 [경로 이전 검토](reports/programming-path-review-2026-09-29.md)를 참고합니다.
- **`core.autocrlf=false`** 로 둡니다. 켜 두면 `bun.lock` 등이 줄끝만 바뀐 채 수정됨으로 잡힙니다.
- **심볼릭 링크(43개, v2.0.32부터. upstream 9e68770074가 `packages/enterprise`를 지우기 전에는 57개, b9ca4d21b4 전에는 58개).** 개발자 모드가 꺼져 있으면 git이 링크를 대상 경로가 적힌 텍스트 파일로 풉니다. 그러면 `packages/app/src/custom-elements.d.ts` 때문에 `@opencode/desktop` typecheck가 실패하고, 파비콘 같은 공개 자산도 깨집니다. 지금은 링크 대상을 실제 파일로 복사한 뒤 `git update-index --skip-worktree`로 표시해 두었습니다. upstream sync 뒤에 링크 대상이 바뀌면 이 복사를 다시 해야 합니다. 개발자 모드를 켜고 `git config core.symlinks true` 후 해당 경로를 다시 체크아웃하는 것이 근본 해결입니다.
  ```bash
  git ls-files -s | awk '$1=="120000"{print $4}'   # 대상 목록
  git ls-files -v | grep '^S'                       # skip-worktree 표시 확인
  git ls-files -v | grep '^[a-z]'                   # assume-unchanged 표시 확인(소문자 태그)
  ```
- **팀 모드 영역의 링크 사본(06 §4.12, T2).** 팀 모드가 만드는 영역 폴더도 홈과 같은 사본을 쓰되, 표시는 영역 모양에 따라 다릅니다. `plain`·`full` 영역(sparse 아님)은 홈과 같은 `--skip-worktree`입니다. **sparse(코드 전용) 영역은 `--assume-unchanged`** 입니다. sparse-checkout이 skip-worktree 비트를 자기 것으로 쓰므로 손으로 붙인 skip-worktree는 `sparse-checkout add`·`reapply`·`set`에서 풀리고, 그 뒤 `git add -A`가 120000 → 100644 타입 변경을 링크 수만큼(지금 43개) 커밋하기 때문입니다. assume-unchanged는 그 명령들 뒤에도 남고 `commit -a`가 집지 않습니다. 폴더 링크의 사본은 `<git 공용 폴더>/info/exclude`에 `/<경로>/` 패턴을 더해 추적 안 된 파일로 잡히지 않게 합니다. **이 파일은 모든 작업 폴더가 함께 쓰므로 홈에도 걸립니다**: 홈에 둔 같은 폴더 사본도 무시된 파일이 됩니다(`status`에 나오지 않고 `git clean -fd`는 남기지만 `-x`는 지움). own은 그 줄을 `# own.team link copies (06 §4.12)` 머리줄 아래에 적고, 되돌리기가 영역 폴더를 지운 뒤 팀 홈 말고는 그 경로에 폴더 사본을 가진 작업 폴더가 없으면 그 줄을 뺍니다(남는 줄이 없으면 머리줄도). 남긴 영역, 받아들인 폴더, 끈 팀의 영역처럼 사본이 남아 있는 동안은 줄도 남습니다. 줄이 없으면 그 사본의 파일이 추적 안 된 파일로 보이고 `add -A`가 링크를 그 파일들로 바꾸기 때문입니다. 두 표시 모두 그 사본을 고쳐도 `status`가 비게 만들므로, own.team은 쓴 내용의 해시를 영역 기록에 적고 지우기·내려놓기·보류 ref·반영 전에 디스크와 비교합니다(고친 사본은 덮어쓰지 않음). 콘 밖을 가리키는 링크는 그 폴더를 들일 때까지 git의 링크 파일로 둡니다.
- **팀 모드의 공유 폴더 링크(06 §4.11, T3).** 켜기 판단이 "읽기 전용 데이터"로 고른 홈의 무시된 폴더(데이터셋, 가중치)는 사용자가 확인하면 원본을 읽기 전용으로 바꾸고(Windows는 사용자 SID에 `(OI)(CI)(WD,AD,WEA,WA,DE,DC)` 거부 ACE, Linux는 `chmod -R a-w`. 읽기는 그대로) 영역마다 같은 상대 경로에 링크를 둡니다(Windows junction, Linux symlink. 관리자 권한도 개발자 모드도 필요 없음). 링크는 git에게 추적 안 된 항목이므로 `<git 공용 폴더>/info/exclude`에 `/<이름>`(앞 `/`, 뒤 `/` 없음: `data/`는 Linux symlink에 맞지 않음)을 **`# own.team shared folders (06 §4.11)` 머리줄 아래**에 더합니다. 위 링크 사본의 `# own.team link copies (06 §4.12)` 줄과 같은 파일이고 같은 직렬 쓰기 하나로만 씁니다(동시에 쓰면 줄을 잃음). 이 파일은 홈에도 걸리므로 홈의 원본 폴더도 이미 무시된 폴더여야 하고(공유 대상의 조건), 켜기 되돌리기(`undo.shared`)는 링크를 따라가지 않고 지운 뒤 보호를 풀고 그 줄과 기록을 지웁니다. 영역 폴더를 지울 때도 own 링크를 먼저 따라가지 않고 지웁니다(`rm -rf data/`처럼 뒤에 `/`를 붙인 삭제는 링크를 따라가 원본을 지우므로 읽기 전용 보호가 먼저입니다). 이 PC의 사용자 폴더 권한은 확인 단계 없이 바뀌지 않고, 시험은 임시 폴더에만 ACL을 겁니다.
- **개발자 모드는 안내만 합니다.** own은 개발자 모드를 켜지 않고, 사용자 환경 변수·`~/.gitconfig`·시스템 설정도 바꾸지 않습니다. 팀 모드의 확인 단계 `symlinks-devmode`는 위 assume-unchanged 경로가 06 TG14에서 실패할 때만 나오는 안내(바뀌는 설정과 되돌리는 법)이고, 켜는 것은 사용자의 결정입니다. 켠 뒤의 근본 해결은 위와 같습니다(`core.symlinks true` 후 다시 체크아웃, 작업 폴더별 설정). Bun 설치 캐시도 같은 원칙입니다: own이 돌리는 설치에만 `BUN_INSTALL_CACHE_DIR=<영역 부모 폴더>\.own-bun-cache`를 넣고(같은 볼륨이라 하드링크), 사용자 변수를 옮기는 것은 팁으로만 보입니다.

---

## 12. 미확인/열린 질문

1. **Windows typecheck 기준선.** 2026-09-27에는 심볼릭 링크를 복구한 뒤 모노레포 전체가 통과했습니다. upstream sync 뒤 링크 대상이 바뀌면 다시 깨질 수 있습니다(§11). 기준선이 커지면 own 전용 pre-push(own 패키지만 typecheck)로 바꿀지 정해야 합니다.
2. **`--untrusted`와 이 저장소 자체.** 이 저장소는 `.opencode/plugins/`를 가지고 있습니다. 우리 저장소를 own 서비스로 열 때 그 플러그인을 승인할지, `--untrusted`로 열지 정해야 합니다(01 §13.2).
3. **cherry-pick 대 tip merge.** 기본을 tip merge로 두었습니다. 실제 운영에서 cherry-pick이 필요 없다면 `cherry-picks.yaml` 경로를 없애고 금지로 바꿀 수 있습니다.
4. **예외 승인이 필요한 후보 패치**(P-004, P-005, P-011, P-012, P-013)를 켤 때 upstream PR을 먼저 올리는 규칙을 지킬 수 있는지. `model-request.ts`(18)와 `model-resolver.ts`(17)는 hot 파일이라 upstream 제안이 우선입니다.
5. **라이선스.** 우리 코드는 MIT예요(저장소 소유자 결정 2026-11-26, P-066). 다른 라이선스를 따르는 부분은 `own/THIRD-PARTY-NOTICES.md`에 적어요.
6. **셸 설치와 업데이트 경로.** `install.ps1`이 NSIS 설치 파일까지 실행할지, 셸은 사용자가 따로 설치할지 정해야 합니다(01 §20 22). 서명(SmartScreen)과 시작 메뉴 바로가기(AUMID, 알림 G-D4)도 같이 정합니다.
7. **electron-vite 베타.** upstream이 6.0.0-beta.1을 쓰므로 같은 판을 고정합니다. upstream이 판을 바꾸면 own-desktop 설정의 upstream 함수 호출 방식도 바뀔 수 있습니다.
8. **치환 방식의 수명.** `resolveId` 치환은 upstream 파일 경로에 묶입니다. upstream이 main 구조를 크게 바꾸면 vendor 범위를 넓혀야 합니다. 그 경우에도 upstream 파일 수정(코어 패치)보다 vendor를 먼저 택합니다.
9. **`own/upstream-surface.json`의 데스크톱 항목**(§7 표)은 제안 id입니다. 05 §4.7과 이름을 합쳤고, check-surface에 실제로 넣으면서 영역과 해시를 확정합니다. `desktop-ipc-contract`의 "import 대상 집합" 검사와 `compaction-keep-ceiling` 확장은 check-surface에 새 검사 종류(import 목록 비교)가 필요할 수 있습니다 ⚠.
10. **rpcHash 입력 목록.** §8.2의 목록은 05 §5.5보다 넓습니다. `window-bootstrap.ts`, upstream `preload/index.ts`, `@opencode/app/ssh`의 `types.ts`, `@opencode/plugin-browser/rpc.ts`를 더했습니다. 05 §5.5와 §4.7 `desktop-ipc-contract`가 같은 목록을 써야 합니다.
    - 대가: `ipc-rpc/`는 최근 30일 upstream 커밋이 18회, `plugin-browser/src/rpc.ts`는 5회입니다(2026-09-27 측정). rpcHash가 자주 바뀌어 셸 재설치가 잦을 수 있습니다.
    - `@opencode/schema/*`는 해시에서 뺐습니다. IPC가 `rpc.ts`에서 쓰는 것이 `State`·`TabID`·`Action`뿐이고, `Session` 스키마는 attach 쪽에만 쓰인다고 봤기 때문입니다. `Action`이 schema 도우미에 기대는 범위는 확인하지 않았습니다 ⚠.
11. **Windows PowerShell 5.1의 `--define` 따옴표 손실**(§8.2). `build-own.ps1` 3단계를 `Bun.build({ define })` 스크립트로 만들지, 빌드 스크립트 전체를 PowerShell 7로 옮길지 정해야 합니다. 어느 쪽이든 번들 검사는 유지합니다.
12. **build id의 upstream 입력.** build id는 upstream workspace 소스를 직접 해시하지 않고 version이 대표한다고 봅니다(§8.2). "같은 version을 다른 커밋으로 다시 빌드하지 않음"을 스크립트가 강제할지(예: `own/release/<ver>/manifest.json`이 이미 있으면 거부) 정해야 합니다.
13. **단계 표기.** 이 문서는 01 §17을 따라 own-web을 P3, own-desktop을 P4로 표시했습니다. 05 §15는 DS0(셸 v0)을 Phase 2 시작과 함께 두어 서로 다릅니다. 둘 중 하나로 맞춰야 합니다.
14. **01과 맞출 것.** 이 문서가 바꾼 계약 중 01에 반영이 필요한 것이 있습니다.
    - §16.2 "G-D1, G-D2는 릴리스마다" → §8.3 게이트 규칙(G-D1·G-D2·G-D6 매번, G-D3·G-D4·G-D5 조건부)
    - §4·§10.1의 설치 프로필 `"-opencode.browser"` → 세션 권한 새김(05 §8.7)
    - §4의 build id 정의(번들 해시) → 입력 해시(§8.2 1b)
15. ~~**`config/opencode.jsonc.example` 갱신.**~~ 2026-10-01 고침: own.remote 2번 자리. 2026-10-02 고침: own.team 3번 자리, own.computer-use 6번 자리(§1). T1(2026-10-02): own-team이 실제 항목이 되었고(`<OWN_HOME>/app/<version>/plugins/own-team`), 주석이 슬롯을 그 뒤에 두는 이유를 적는다. launcher와 `release-smoke.ts`가 같은 순서를 검사한다.
16. **electron-builder 출력 위치.** upstream 설정의 `directories.output`이 `dist`라서 §8.2는 설치 파일을 `$out/desktop/`으로 복사합니다. own 설정에서 `directories.output`을 `own/.out/build/<ver>/desktop`으로 덮을지는 DS0에서 정합니다. 그 경우 `win-unpacked\`도 같이 옮겨집니다.
17. **manifest 키 표기.** `desktop.rpcHash`만 camelCase입니다(§8.3). manifest 전체를 한 표기로 바꿀지는 첫 릴리스 전에 정합니다. 바꾸면 05 §5.5 셸 코드도 같이 바꿔야 합니다.
18. **P-016의 잠정 밀도(EXT 리뷰, 2026-10-06).** 결정은 "WP13이 잰 밀도로 P-016"이었습니다. WP13의 `db-stats.ts` 실행(읽기만)은 own DB에서 쓸 수 있는 step 2개와 한글 0자를 찾아서 잰 값이 없습니다. 그래서 `DENSE_TOKENS_PER_CHAR = 0.6`은 공개 수치(o200k 한국어, DeepSeek 중국어)에서 온 잠정값입니다. 낮게 잡는 쪽이라 R8에는 안전합니다. 사용자가 정할 것: 잠정 0.6을 받아들일지(ledger P-016 `approval`에 적음), 한국어 데이터가 생길 때까지 P-016을 보류하거나 되돌릴지. 어느 쪽이든 후속 작업은 남습니다. own DB에 한국어 세션이 쌓이면 `bun own/scripts/db-stats.ts`(읽기만, 본문을 출력하지 않음)를 다시 돌려 report 1의 P-016 행으로 `DENSE_TOKENS_PER_CHAR`(또는 따로 둘 CJK 가중치)를 고칩니다.
19. **P-017의 예외 승인과 두 가지 차이(EXT 리뷰, 2026-10-06).** (a)·(b)는 2026-10-07 사용자 결정으로 해결했습니다(ledger P-017 `exception_approval`: upstream 먼저 규칙 면제, 두 차이 수용). (c)도 2026-10-08에 해결했습니다: v2.0.24 sync(2026-10-07)가 runner 출력 한도 경로(`session/runner/llm.ts`, churn 9)를 P-017에 더해 마커 사이가 34 + 4 = 38줄이 되었고(§6.1 규칙 2의 30줄 상한 초과), 같은 의도의 확장이라 그 sync의 작업 지시로 받아들였습니다. 빼면 한국어 기록에서 출력 한도가 남은 자리를 넘을 수 있었습니다(ledger P-017 `merge_note`). 처음 기록: (a) `compaction.ts` churn 17이라 §6.1 규칙 2의 예외입니다. 사용자가 upstream 먼저 규칙을 이 패치에 한해 면제하거나 upstream issue를 직접 올릴 때까지 ledger에 "예외 승인 필요"로 둡니다. upstream에 글을 올리는 것은 사용자의 일입니다. (b) GW-P17A 수용 기준과 두 가지가 다릅니다. 압축 뒤 provider 고유 항목(암호화된 reasoning 등)이 있어도 다른 slot의 측정값을 쓰고, 토크나이저 신호가 카탈로그 모델 id 하나라 own slot이 아닌 provider끼리도 같은 id면 값을 나눕니다. 사용자가 이 근사를 승인하거나, 공유 범위를 좁히라고(reasoning 항목이 없는 기준만, 같은 패키지만) 정해야 합니다. 좁히려면 assistant 메시지에 없는 provider 패키지 정보가 필요합니다(ledger P-017 `deviations`).
