# own/

own-open-code가 OpenCode에 더한 문서와 도구예요. 앱 소개와 빌드 방법은 루트의 [README](../README.ko.md)([English](../README.md))와 [BUILDING.ko.md](BUILDING.ko.md)([English](BUILDING.md))에 있어요. 이 폴더의 문서는 한국어예요.

- own의 코드는 `packages/own-*`와 이 `own/` 폴더에 있어요. upstream 파일을 고친 곳은 모두 [ledger/core-patches.yaml](ledger/core-patches.yaml)에 적고, `node own/scripts/check-ledger.mjs`가 확인해요([FORK.md](FORK.md) §6).
- 지금 상태, 릴리스, 남은 일은 [handoff/HANDOFF.md](handoff/HANDOFF.md)에 있어요.
- 그림(`readme/`)은 `bun own/scripts/readme/capture.ts`로 다시 만들어요.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/QUICK-GUIDE.md](docs/QUICK-GUIDE.md) | 빠른 시작(한 페이지): 설치, 처음 5분, 단축키, SSH·휴대폰 요약, Claude에게 맡길 수 있는 작업 |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | 사용 안내서: 빌드 산출물, 설치, 계정, 전환, 프리셋·울트라(5.5–5.7), SSH, 휴대폰, 문제 해결, 제거, 팀 모드(16장: 켜기, 받아들이기, 반영하기, 영역 정리와 재구성, 공유 폴더, 원격 팀), 다른 도구의 대화(17장) |
| [docs/01-architecture.md](docs/01-architecture.md) | 구성, 서비스 수명주기(Windows), 채널 격리, 보안, 코어 패치 예산, 로드맵, PoC 게이트 |
| [docs/02-accounts-providers-cache.md](docs/02-accounts-providers-cache.md) | 계정·slot·providerID 규칙, 로그인과 인증 주입, 전환 상태 기계, 캐시 비용 모델, 한도 텔레메트리, Claude 구독 플러그인 슬롯, RPC `own.accounts` |
| [docs/03-ui-ux.md](docs/03-ui-ux.md) | 화면 구조, "모델 @ 계정" 전환 UX, 한도 표시, 상태·오류, 한국어 IME 규칙, 컴포넌트 목록 |
| [docs/04-ssh-remote.md](docs/04-ssh-remote.md) | SSH 원격 프로젝트: 설치, 터널, 자격 증명 브로커, 게이트 RG1–RG17 |
| [docs/05-desktop-and-mobile.md](docs/05-desktop-and-mobile.md) | 데스크톱 셸(Electron), 네이티브 브라우저 패인, 모바일 원격 접근(게이트웨이, 페어링) |
| [docs/06-team-worktrees.md](docs/06-team-worktrees.md) | 팀 모드: 영역별 작업 폴더, 메인·담당 대화, 메인 멈춤, 지연 에셋, 합치기, 재구성, 공유 폴더, `.assets` 검사, SSH 원격 팀, RPC `own.team`. T1–T3 구현(T3 종료 확인 전) |
| [docs/07-presets.md](docs/07-presets.md) | LLM 행동 프리셋: 하위 에이전트 대상, 나눠 맡기기, 안전 상한, 울트라, 같은 회사 다른 구독 금지(R4), 원격 미러의 프리셋, 06과 합친 단계표. T1–T3 구현 |
| [docs/08-app-access.md](docs/08-app-access.md) | 앱 연결: Android 앱과 다른 PC의 데스크톱 앱, 지문 고정 TLS 리스너, tailnet·DDNS 경로 |
| [docs/09-session-import.md](docs/09-session-import.md) | 다른 도구(Codex, Claude Code)의 대화: 찾기·읽기 전용 보기·own 대화로 옮기기, 다른 도구의 파일은 읽기만, RPC `own.import`. I1·I2 구현 |
| [docs/10-codex-harness.md](docs/10-codex-harness.md) | 세션별 하네스: OpenCode 기본 / Codex 방식, 플러그인 `own.harness` |
| [FORK.md](FORK.md) | 브랜치, upstream 동기화 절차, 코어 패치 ledger, 릴리스 빌드(§8.2), 로컬 검사 |
| [design/prototype/index.html](design/prototype/index.html) | 클릭 가능한 정적 프로토타입(외부 리소스 없음, 브라우저로 바로 열기) |

## 패키지

| 패키지 | 역할 |
|---|---|
| `packages/own-protocol` (`@own/protocol`) | RPC `own.accounts`·`own.remote`·`own.team`·`own.computer`·`own.import` 정의, 공용 스키마(프리셋 `Preset` 포함), 번들용 `Portable` 정의 |
| `packages/own-runtime` (`@own/runtime`) | 서버 전용 프로세스 싱글턴, DPAPI vault client, ledger writer |
| `packages/own-accounts` (`@own/accounts`, 플러그인 `own.accounts`) | 계정·slot, 요청별 인증 주입, 전환 상태 기계, 비용 추정, 자격 증명 브로커, 프리셋과 하위 에이전트 관문(07) |
| `packages/own-team` (`@own/team`, 플러그인 `own.team`) | 팀 모드(06): 영역 작업 폴더, 팀 메인·담당 대화, 메인 요청·보고, 작업(op)과 되돌리기, 받아들이기·반영(T2), 재구성·공유 폴더·`.assets`·원격 팀(T3). T1부터, T3부터 SSH 호스트에서도 돎 |
| `packages/own-telemetry` (`@own/telemetry`, 플러그인 `own.telemetry`) | Claude 구독 슬롯 관측 |
| `packages/own-remote` (`@own/remote`, 플러그인 `own.remote`) | SSH 원격 호스트, 원격 접근 게이트웨이 |
| `packages/own-web` (`@own/web`) | SolidJS 웹 UI(데스크톱 렌더러, 브라우저 폴백, 휴대폰) |
| `packages/own-desktop` | Electron 데스크톱 셸(다른 PC를 여는 `원격 PC` 창 포함) |
| `packages/own-android` | Android 앱(Java, Gradle). 페어링한 PC의 own-web을 WebView로 연다(08) |
| `packages/own-computer-use` (`@own/computer-use`, 플러그인 `own.computer-use`) | Windows 컴퓨터 사용(RPC `own.computer`) |
| `packages/own-import` (`@own/import`, 플러그인 `own.import`) | 다른 도구의 대화 찾기·보기·옮기기(09, RPC `own.import`). 이 PC 전용, SSH 호스트에는 싣지 않음 |
| `packages/own-harness` (`@own/harness`, 플러그인 `own.harness`) | 세션별 하네스(10): OpenCode 기본 / Codex 방식. 플러그인 순서 맨 뒤. 아직 이 PC 전용(SSH 호스트에는 H1부터 실음) |
| `own/native/own-vault` | DPAPI 키 저장소 helper(Rust) |
| `own/launcher` | launcher `own.cmd`·`own.ps1` |

## 검사와 빌드

- 로컬 검사: FORK.md §9. 요약하면 `node own/scripts/check-ledger.mjs`, `node own/scripts/check-surface.mjs`, `oxlint`, 각 `packages/own-*`의 `bun run typecheck`와 `bun run test`, own-web의 e2e(`bun run test:e2e`, `test:e2e:<suite>`, `test:integration`, `check:fallback`), `node --test own/scripts/test/*.test.mjs`.
- 릴리스 빌드: `powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1 -Remote` (FORK.md §8.2, 릴리스 순서는 handoff/RELEASE.md). 설치는 하지 않습니다.
- 릴리스 스모크: `bun own/scripts/release-smoke.ts --out own/.out/build/<버전>`. 빌드를 임시 OWN_HOME에 설치해 launcher로 띄우고, 번들 플러그인(health, 계정 추가, 가짜 provider 왕복), 웹 폴백, 게이트웨이 깨우기와 loopback 전용을 확인합니다(17개 검사).
- 패키지 셸 게이트: `packages/own-desktop`의 `bun scripts/gates.ts --out <빌드 폴더>`, `bun scripts/smoke.ts …`(05 §14.1).

## 브랜치

- `main`: 우리 작업
- `upstream-v2`: upstream `anomalyco/opencode` 기본 브랜치의 미러(포크 기준 `00d179015f`)

이 저장소는 GitHub Actions를 꺼 두었습니다. upstream 워크플로에 deploy/publish가 포함되어 있기 때문입니다. 검사는 로컬에서 돌립니다([FORK.md](FORK.md)).

## 주의

`opencode-claude-auth-v2`(Claude 구독 슬롯)는 서드파티 플러그인이고, 2026-10-18부터 앱에 넣어 빌드합니다. Claude Code 신원을 흉내 내고 토큰을 중개하는 방식이라 Anthropic 약관과 충돌합니다. UI는 이 슬롯을 "비공식"으로 표시하고, 처음 쓸 때 한 번 동의를 받습니다.
