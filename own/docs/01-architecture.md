# 01. 시스템 아키텍처 & 백엔드 스펙

| 항목 | 값 |
|---|---|
| 프로젝트 | own-open-code (OpenCode v2 private fork) |
| 문서 상태 | Draft v0.4 (2026-09-27). 사용자 결정 D1–D8 반영: 데스크톱 앱, 네이티브 브라우저, 모바일 확장성, 성능 우선, v2 기능 동등성, auto-compaction 설정, Codex 로그인 가져오기, SSH 정렬. v0.4는 리뷰 반영판입니다: 브라우저 도구 정책을 05 §8.7 안 D로 통일, 05와의 경계 정리, R16 Location 단위, takeover 선행 조건, PF2/PF3 정의. 2026-10-02(T1): 팀 모드 own-team(§0 20, §3, §4, §15, §17 P9), 프리셋(§0 21), 컴퓨터 사용과 프리셋·팀의 경계(§10.2), 코어 패치 0개(§12.2), 게이트 표(§16.6). 2026-10-09(IMPORT, 09): 다른 도구의 대화 가져오기 own-import(§0 2·22, §3, §4 7번 자리, §5.1, §15 RPC id 다섯, §16.7, §17 P10) |
| fork base | upstream `v2` `00d179015f` (v2.0.18 release marker `39021dfd67` + 5 commits), root `package.json` 2.0.18 |
| 저장소 | `origin` = 비공개 저장소(github.com/NA-DEGEN-GIRL/own-open-code, 공개 저장소를 만들면 `own-open-code-private`로 이름을 바꿈), `upstream` = github.com/anomalyco/opencode `v2` |
| 작업 트리 | `D:\own-open-code` (git worktree, `main`). `D:\#Projects\own-open-code`는 쓰지 않습니다. 경로의 `#`이 Bun과 Vite를 깨뜨립니다(`own/FORK.md` §11 "Windows 체크아웃 주의") |
| 1차 플랫폼 | Windows 11 (26200), 한국어 사용자(한글 IME), Node 22.23.2, Bun 1.4.4(2026-10-31 설치, 그 전 1.4.2) |
| 관련 문서 | `own/FORK.md`(포크 운영), `own/docs/02-accounts-providers-cache.md`(계정·캐시·한도·RPC 계약의 **기준**), `own/docs/03-ui-ux.md`(화면·문구), `own/docs/04-ssh-remote.md`(SSH 원격의 **기준**), `own/docs/05-desktop-and-mobile.md`(데스크톱 셸 내부·OwnHost·브라우저 패인·원격 기기 접근의 **기준**), `own/docs/06-team-worktrees.md`(팀 모드), `own/docs/07-presets.md`(LLM 행동 프리셋), `own/docs/08-app-access.md`(Android 앱·다른 PC의 데스크톱 앱 연결의 **기준**) |

- **경로 표기**: 특별한 말이 없으면 저장소 루트 `D:\own-open-code` 기준 상대 경로이고, 줄 번호는 fork base 기준입니다. `[old]`는 이전 앱 `D:\#Projects\codex-multi-provider` 기준입니다.
- **근거 우선순위**: 로컬 소스가 사전 리서치(`report.md`, `cache_design.md` 등)와 다르면 로컬 소스를 따릅니다. 리서치에서 온 내용은 `[research]`로 표시합니다. 소스나 실측으로 확인하지 못한 항목은 ⚠로 표시합니다.
- **2026-09-27 연구 파일**(세션 scratchpad `C:\Users\<user>\AppData\Local\Temp\claude\D---Projects-own-open-code\74c66f49-5311-4cce-aef8-61a4ee203508\scratchpad\`)
  - `[desktop-verdict]` `desktop_verdict.md`: 데스크톱 셸 타당성 결론. 소스 스팟체크 21건. 이 문서의 데스크톱 결정은 이 파일을 기준으로 합니다.
  - `[desktop-build]` `desktop_build.md`: 빌드·PoC·패키징 기록. PoC 소스는 `own-desktop-poc\`입니다.
  - `[gap]` `gap_final.md`: v2 앱 대비 기능 갭 감사. 번호 1–46은 이 파일의 번호입니다.
- **문서 간 우선순위**: 데이터 스키마, 저장 파일, 정책 수치, RPC 계약은 02가 기준입니다. 화면은 03, SSH 원격은 04가 기준입니다. 05가 기준인 것은 다음과 같습니다. 이 문서의 해당 절은 요약과 `05 §x` 참조만 둡니다.
  - own-desktop 내부: 레이아웃, 빌드 시 치환, `BackgroundService(own)`·`DesktopCli(own)`, rpcHash, `window.own`(05 §4–§5)
  - `OwnHost` 인터페이스, capability 이름, T0 호출(05 §6)
  - 브라우저 패인 통합과 브라우저 도구의 세션 정책(05 §8)
  - 기기 페어링, 게이트웨이, 알림 피드·푸시(05 §13)

  이 문서가 정하는 것은 다음과 같습니다. 02·03·04·05와 어긋나는 부분은 §20에 적습니다.
  - 프로세스·패키지 경계(데스크톱 셸 포함)
  - 훅 배선, 보안 불변식, 포크 경계
  - 성능 예산(PF1–PF8)과 릴리스 게이트 색인
  - 로드맵
- **이름 충돌 주의**: D 번호를 구분해서 씁니다.
  - 사용자 결정은 "결정 D1–D8"입니다(2026-09-27). 05는 같은 결정을 "U-D1–U-D8"로 씁니다.
  - 데스크톱 게이트는 "G-D1–G-D6"입니다. `[desktop-verdict]`의 D1–D6, 05 §14.1의 D1–D6과 같습니다.
  - 02의 결정성 규칙은 "02 D1–D10"입니다.
  - 05가 새로 정한 게이트는 DP1–DP6(셸 성능·크기)과 MG1–MG8(원격 접근)입니다. 이 문서는 이름만 가리킵니다(§16).

---

## 0. 핵심 결정 요약

1. **서버는 하나입니다.** fork한 OpenCode v2 service 1개가 `opencode-own.db`의 유일한 writer입니다. 채널 `own`으로 빌드해서 DB, 등록 파일, 포트를 upstream 설치본과 분리합니다(`packages/cli/src/database-path.ts:4-12`, `packages/cli/src/services/service-config.ts:29-38`). 데스크톱 앱, 웹 폴백 창, (P8) 모바일은 모두 이 service의 클라이언트입니다.
2. **우리 코드는 새 패키지와 플러그인에 둡니다.** 위치는 `packages/own-*`와 `own/`입니다. 패키지 이름은 02·03·04·`own/FORK.md`와 같습니다.
   - 서버·공용: `own-protocol`(`@own/protocol`, RPC 정의와 공용 스키마), `own-runtime`(`@own/runtime`, 서버 전용 공용 라이브러리)
   - 플러그인: `own-accounts`(`@own/accounts`, 플러그인 id `own.accounts`), `own-remote`(`@own/remote`, 플러그인 id `own.remote`, 04), `own-team`(`@own/team`, 플러그인 id `own.team`, 06, T1부터), `own-telemetry`(`@own/telemetry`, 플러그인 id `own.telemetry`)
   - 클라이언트: `own-web`(`@own/web`, UI), `own-desktop`(Electron 셸)
   - Windows 컴퓨터 사용: `own-computer-use`(`@own/computer-use`, 플러그인 id `own.computer-use`, §10.2)
   - 다른 도구의 대화 가져오기: `own-import`(`@own/import`, 플러그인 id·RPC id `own.import`, 09, IMPORT부터)

   **코어 패치는 ledger가 정본입니다.** 처음 계획은 데스크톱 모드 0개, 웹 폴백(일반 브라우저 창) 전용 P-001/P-002(각 1–2줄) 둘이었습니다. 2026-10-11에는 active가 7개로 한도 6을 하나 넘었습니다. 웹 폴백의 P-001/P-002와 기본 제품도 쓰는 P-014(버전 확인), P-015(PowerShell UTF-8 출력), P-016(한글·CJK 토큰 추정), P-017(같은 모델 slot 사이 측정값), 그리고 사용자가 한도를 넘겨 승인한 P-018(멈춘 모델 스트림 감시)입니다(§12.2). 지금(2026-10-22) active는 22개이고, 그 뒤에 더한 P-019–P-033(마지막은 Windows PTY 종료 코드의 P-033)의 목록과 셈은 `own/FORK.md` §6.1 5번에 있습니다. 나머지 후보 패치는 PoC 게이트가 실패할 때만 켭니다.
3. **providerID는 계정이 아니라 캐시 도메인입니다.** 형식은 `own-<kind>-<slug>`이고 slug는 4–8자 난수입니다(02 R-ID-3). MVP에서는 계정 1개 = slot(providerID) 1개입니다. 계정 전환과 provider 전환은 모두 세션의 `Model.Ref` 교체(`switchModel`) 하나로 통일합니다. 전역 `credential.activate`는 쓰지 않습니다.
4. **모든 세션은 명시적 모델에 고정합니다.** `SessionInfo.model`은 optional이라 비어 있으면 매 attempt마다 전역 기본 모델로 해석됩니다(`packages/schema/src/session.ts:40`, `packages/core/src/session/runner/model.ts:88-94`). own-web은 세션 생성 때 항상 model을 보내고, own-accounts는 model 없는 세션을 고정합니다(§8.5).
5. **인증은 요청마다 주입합니다.** own provider는 `activation:"enabled"`이고 integration과 apiKey를 두지 않습니다. 그러면 resolver가 route auth를 `Auth.none`으로 바꾸고, `model.request` 훅이 넣은 인증 헤더가 살아남습니다(`packages/core/src/model-resolver.ts:374-380,417-421`). 훅은 **setup 시점에 한 번**, `own-` 접두어로 거르는 unscoped 훅으로 등록합니다(§8.3). 세션을 거치지 않는 LLM 호출(`generate.text`)에는 적용되지 않습니다.
6. **비밀은 DB와 env에 두지 않습니다.** DPAPI(CurrentUser)로 암호화한 파일 vault(`vault\<accountId>.dpapi`)에 둡니다. 암복호화는 작은 Rust helper `own-vault.exe`가 맡는 것이 기본입니다(§13.1, 02 §2.4.5). 평문 DB 저장은 두 경우뿐입니다.
   - 서드파티 Claude 구독 슬롯이 upstream `credential` 테이블에 저장하는 OAuth 토큰. 플러그인 자체 동작이며 UI에서 이 사실을 고지합니다.
   - Auth.none 경로가 깨질 때만 켜는 대체 모드 `credentialBackend:"opencode-credential"`(02 §3.7). UI에 대체 모드(평문 저장)임을 명시합니다.

   렌더러, 브라우저 패인, 원격 기기는 서비스 비밀번호와 provider 비밀을 받지 않습니다(§13).
7. **Claude 구독은 앱에 든 서드파티 플러그인으로 지원합니다(2026-10-18, 사용자 결정 CB "넣고 항상 켜기").** `opencode-claude-auth-v2@0.4.0-beta.5`를 빌드가 커밋한 lock으로 설치·확인하고 own의 패치를 적용해 `app\<ver>\plugins\claude-auth`에 싣고, 늘 켜 둡니다(02 §8.2). 사용자 PC에서는 내려받기·설치·패치·제거가 없습니다. 플러그인은 own 전역 config `%USERPROFILE%\.config\own-open-code\opencode.jsonc`에만 설정하고, 순서는 `[own.accounts, own.remote, own.team, heymaaz.claude-auth-v2(앱에 포함), own.telemetry, own.computer-use, own.import, own.harness]`로 고정합니다(§4, 04 §4.1, §10.2, 09 §5.1). 우리 provider와는 providerID, integration, 훅 범위가 모두 분리되도록 계약을 둡니다(§9).
8. **캐시 최적화는 규칙으로 강제합니다.** 규칙은 §8.7에 있습니다.
   - sticky 바인딩. 구독 계정은 수동 전환만 허용합니다.
   - 고정 모델 템플릿, summary compaction
   - compact-then-switch, cold-point 예약
   - 결정적 훅, variant 기억
   - 전환 전 비용 추정기
   - 도구 목록 안정: 브라우저 도구는 **세션을 만들 때** 호스트 capability로 세션 권한을 새겨 정하고(05 §8.7 안 D, §10.1), 승인 모드는 도구를 목록에 남기는 규칙으로 만듭니다(§17.1 9번).
9. **한도와 사용량은 수동적으로 수집합니다.** own slot은 own-accounts가, `anthropic` 슬롯은 claude-auth 뒤의 own-telemetry가 응답 헤더·WS 프레임·step 이벤트를 읽습니다. 저장은 02의 파일(`state\limits.json`, `ledger\usage-YYYY-MM.jsonl` 등)을 따르고, UI에는 RPC `own.accounts`와 `rpc.own.accounts.*` 이벤트로 전달합니다(02 §9).
10. **프로젝트 플러그인은 신뢰 경계입니다.** upstream은 프로젝트 `.opencode/plugins`를 자동으로 in-process 로드합니다. own-accounts는 Location별 플러그인 allowlist를 검사하고, 승인되지 않은 플러그인이 있으면 인증 주입을 멈춥니다(§13.2).
11. **제품은 데스크톱 앱입니다(결정 D1).** Codex 앱이나 Claude 앱 같은 형태입니다.
    - `packages/own-desktop`(Electron)이 upstream `packages/desktop`의 main 프로세스를 재사용하고, 렌더러로 own-web을 띄웁니다.
    - upstream 파일은 고치지 않습니다. 만드는 방법은 세 가지입니다(§4.1, `[desktop-verdict §1]`).
      - vendor 2개: `index.ts`, `desktop.ts`
      - 빌드 시 치환 2개: `constants.ts`, `lifecycle/environment.ts`
      - layer 교체 2개: `BackgroundService`, `DesktopCli`
    - 서비스를 띄우는 것은 여전히 launcher뿐입니다. 데스크톱은 등록 파일로 service를 찾고, 없으면 `own.cmd start`에 위임합니다(§5.3, 05 §5.3).
    - 일반 브라우저 창(`own open --browser`)은 폴백입니다.
    - own-web은 셸 기능을 `OwnHost` 인터페이스로만 씁니다. 구현은 web과 desktop 두 가지이고, UI는 capability로 게이트합니다. 인터페이스와 capability 이름은 05 §6.2가 기준입니다(§6.2).
12. **in-app 브라우저는 데스크톱 셸이 호스트합니다(결정 D2).**
    - 데스크톱 main의 WebContentsView + CDP 호스트(`packages/desktop/src/main/browser-pane.ts`)가 내장 `opencode.browser` 플러그인에 attach합니다.
    - 브라우저 도구는 Code Mode 도구입니다(`codemode:true`, `packages/plugin-browser/src/tools.ts:50`). 그래서 요청의 도구 정의(tools)에는 들어가지 않고, 세션별 Code Mode 카탈로그 Instructions에 들어갑니다. 카탈로그가 바뀌면 delta만 뒤에 덧붙습니다(§10.1).
    - 정책은 05 §8.7 안 D입니다. `browserPane` capability가 없는 호스트(웹 폴백, 모바일)가 세션을 **만들 때** 그 세션에 `browser` deny 권한을 새깁니다. 이미 있는 세션은 창 종류가 바뀌어도 바꾸지 않습니다. 사용자가 켜면 카탈로그 delta 한 번이 생깁니다(§10.1).
13. **로직은 서버에 둡니다. 모바일은 나중입니다(결정 D3).**
    - 계정·전환·캐시·한도·SSH 세션 로직은 모두 service와 RPC에 둡니다. 셸에는 기기에 묶인 기능만 둡니다(§3.2).
    - 원격 기기 접근은 기기별 토큰과 보안 터널(`tailscale serve`)로만 합니다. 서비스를 LAN에 평문으로 열지 않습니다(§6.4, §13.4). 메커니즘과 수치는 05 §13이 기준입니다.
    - 첫 모바일 단계는 게이트웨이가 서빙하는 PWA입니다(05 M1 = P8). Capacitor 앱과 FCM/APNs 중계는 후속입니다(05 M3).
14. **성능은 첫 구현부터 예산으로 관리합니다(결정 D4).** 예산은 다음과 같고, 릴리스 게이트 PF1–PF8로 둡니다(§6.6, §16.3).
    - 실행 후 1초 안에 세션 목록이 보임
    - 입력 지연 16ms 이하(한글 IME 조합 포함). 게이트 정의는 입력 처리 지연(`processingEnd − startTime`) p95이고, 이벤트→페인트는 따로 둡니다(PF2)
    - 2,000 메시지 세션에서 60fps 스크롤
    - 스트리밍이 입력과 스크롤을 막지 않음
15. **v2 앱 기능 동등성을 범위로 둡니다(결정 D5).** 번호는 `[gap]`의 번호입니다.
    - 1–16과 33(네이티브 브라우저): 완성 범위
    - 17–32: 바로 다음 범위
    - 34–42: 나중
    - 43–46: 하지 않음

    기능별 백엔드 출처와 순서는 §17.1에 있습니다.
16. **auto-compaction 설정은 provider·모델·계정별로 정합니다(결정 D6).**
    - 코어의 `compaction.auto/buffer/keep`은 **Location 단위** 상태입니다. 전역 config와 그 Location에서 위로 찾은 프로젝트 config를 차례로 덮어 만듭니다. provider·모델·세션별 값은 없습니다. 트리거는 모델의 `limit.input || limit.context`로 계산됩니다.
    - 그래서 provider·모델·계정별 차등은 코어 패치 없이 slot 템플릿의 유효 `limit.input`으로 합니다. 유효값은 그 Location의 유효 compaction 설정으로 계산하고, 프로젝트 설정이 기준을 바꾸거나 끄면 경고합니다(§8.7 R16). 정책 수치는 02 §4.7이 기준입니다.
17. **이전 앱의 Codex 로그인을 가져옵니다(결정 D7).** 방식은 두 가지이고, 토큰 계열 하나에 refresher 하나라는 규칙은 그대로입니다(§8.4).
    - linked(기본): 읽기 전용으로 따라가고 refresh하지 않습니다.
    - takeover: plan→execute로 vault에 복사합니다. 선행 조건은 이전 앱에서 그 프로필을 멈추는 것입니다. execute 직후 강제 refresh로 토큰 계열을 우리 쪽으로 확정하고, 그때부터 우리가 유일한 refresher입니다.
18. **Computer use는 자체 드라이버와 `own-computer-use` 플러그인으로 만듭니다(2026-10-01 결정, §10.2).** 기본 드라이버는 서비스 안 워커 스레드가 `bun:ffi`로 Win32를 직접 부르는 것이고, 자체 C# helper exe는 대체 엔진으로 남깁니다. cua-driver와 own-cua-proxy 계획은 버렸습니다. 세션마다 사용자가 켜야 동작합니다.
19. **SSH 원격은 완성 범위입니다.** Codex·Claude 앱처럼 원격 호스트의 프로젝트를 열고 같은 로컬 계정으로 작업합니다. 설계는 `04-ssh-remote.md`가 기준입니다(결정 D8, §11).
    - SSH는 Electron main이 아니라 로컬 service 안의 own-remote가 돌립니다.
    - 모바일(P8)도 PC service의 게이트웨이를 거쳐 원격 세션을 봅니다(05 §12).
20. **팀 모드는 `own-team` 플러그인입니다(06, §17 P9).** 한 프로젝트를 영역(작업 폴더)으로 나누고, 영역마다 담당 대화가 일하며, 팀 메인이 메인 요청으로 일을 맡깁니다. own.team은 결정적인 부분(등록부, 대기함, 작업(op), 보고, 깨우기)만 하고 LLM은 판단 호출(`session.generate`)에만 씁니다. 모델·계정을 고르지 않고(07), 크기로 대화를 바꾸거나 압축하지 않으며, 컴퓨터 사용을 켜거나 넘기지 않습니다. 플러그인 3번 자리, RPC id `own.team`, **코어 패치 0개**입니다. T1(2.0.18-own.6)에 켜기·끄기·되돌리기, 메인 요청·멈춤·보고, 담당 대화 교체와 인계 문서, 팀 계정 바꾸기, 설정 `팀`이 들어갔고, 받아들이기·합치기는 T2, 재구성·원격 팀은 T3입니다.
21. **프리셋은 LLM이 일하는 방식입니다(07).** 하위 에이전트 대상(역할별), 나눠 맡기기, 안전 상한을 프로바이더 묶음마다 저장합니다(`OWN_HOME\presets.json`). 메인 계정·모델·추론 강도는 프리셋이 아니라 입력창이 정합니다. own-accounts가 하위 에이전트 관문(`subagent` 도구의 `execute.before`), 세션 안내문 항목 `own.preset`, 읽기 전용 역할의 조이기만 하는 권한 훅, 울트라 스위치를 맡습니다. 같은 회사의 다른 구독 계정은 하위 에이전트나 팀 영역으로 쓰지 않습니다(R4). 코어 패치는 0개입니다.
22. **다른 도구의 대화는 `own-import` 플러그인이 찾고 보이고 옮깁니다(09, IMPORT).** 프로젝트 폴더에서 Codex·Claude Code가 남긴 대화를 이 PC 안에서 찾아 읽기 전용으로 보이고(I1), 사용자가 고르면 upstream의 `experimental.session.import`로 own 대화를 만듭니다(I2). 창에 들어가지 않으면 숨긴 보조 세션에서 core 압축으로 한 번 요약하거나 LLM 없이 요약합니다. 다른 도구의 파일은 읽기만 하고(SQLite는 own 임시 폴더의 사본만), 계정은 사용자가 고릅니다(07 R4). 플러그인 7번(맨 뒤) 자리, RPC id `own.import`, 훅 없음, **코어 패치 0개**입니다. 원격 호스트에는 싣지 않습니다(v1).

---

## 1. 목표와 비목표

### 1.1 목표
- **G-1** 한 세션 안에서 턴 사이에 **계정**과 **provider/모델**을 바꿀 수 있어야 합니다. 두 전환 모두 prompt cache 비용을 최소화하고, 전환하기 전에 비용 추정을 보여줘야 합니다.
- **G-2** provider마다 계정을 여러 개 둘 수 있어야 합니다: ChatGPT Plus/Pro(Codex 백엔드), OpenAI API, Anthropic API, DeepSeek, xAI, OpenRouter, 기타 OpenAI 호환(Base URL + 키).
- **G-3** 한눈에 보여야 하는 것
  - 각 세션과 각 턴이 **어떤 계정의 어떤 provider/모델**로 실행됐는지
  - 각 계정의 **한도**: 5시간/주간 창, reset 시각, API 지출, rate limit
- **G-4** **Codex 앱·Claude 앱 같은 데스크톱 앱**을 제공합니다(결정 D1).
  - 구성: 사이드바, 큰 트랜스크립트, 하단 composer, 오른쪽 작업 패널(리뷰·파일·터미널·브라우저·계정 & 한도)
  - Windows 우선이고 한글 IME를 1급으로 지원합니다.
  - 일반 브라우저 창은 폴백입니다.
- **G-5** upstream v2의 빠른 변화(30일에 non-merge 커밋 1,517개 `[research]`)를 싸게 따라가야 합니다. 그래서 코어 diff를 최소화하고 ledger로 관리합니다. 데스크톱 셸도 upstream 파일을 고치지 않습니다.
- **G-6** Claude 구독은 서드파티 플러그인 슬롯으로 공존시킵니다. Claude API 키는 정식 경로로 지원합니다.
- **G-7** 성능 예산(§6.6)을 첫 구현부터 지키고, 릴리스마다 측정합니다(결정 D4).
- **G-8** upstream v2 앱에서 매일 쓰던 기능을 own-web에서 제공합니다(결정 D5, §17.1). 예: 권한 dock, 리뷰·diff, 터미널, 되돌리기, 네이티브 브라우저.
- **G-9** 나중에 모바일 클라이언트가 같은 service에 붙어 세션을 보고 조작할 수 있어야 합니다(결정 D3). 그래서 지금부터 로직은 서버에 두고, UI는 capability로 나눕니다.

### 1.2 비목표
- 구독 계정의 **자동 로테이션이나 failover**는 하지 않습니다. rate-limit 우회로 해석될 수 있어서 약관 위험이 있습니다(02 §5.10). 자동 failover는 API 키 계정에만, 그리고 하드 트리거가 있을 때만 허용합니다.
- claude-auth-v2의 identity spoofing을 재구현하거나 수정하지 않습니다. 패치는 여러 계정·계정 묶기·오류 문구에만 닿습니다(02 §8.2 3번). MIT 라이선스이므로 그 `LICENSE`와 함께 앱에 넣어 배포합니다(2026-10-18 전에는 번들·재배포하지 않고 사용자가 설치했습니다).
- OS 수준 샌드박스는 두지 않습니다. OpenCode는 권한 규칙만 있고, `write`/`edit`/`patch` 도구는 서버 프로세스가 직접 파일을 씁니다.
- Codex·Claude Code **대화 이력** 가져오기는 IMPORT 단계(09 I1·I2)에서 들어갔습니다. 그 밖의 도구(OpenCode 계열, Gemini CLI 등)는 09 I3 후속입니다. Computer use는 첫 판(자체 드라이버, 세션마다 켜기)이 들어갔고, UI Automation 앱 상태 도구와 cua-driver 어댑터는 후속입니다(§10.2). Codex **로그인** 가져오기는 범위 안입니다(§8.4). SSH 원격은 MVP에 이음매만 넣고 그 뒤 R0–R3로 만듭니다(§11, 04 §21).
- Rust/Tauri 셸이나 자체 네이티브 GUI는 만들지 않습니다. 셸은 upstream Electron main을 재사용하는 own-desktop 하나입니다(결정 D1). 전역 단축키, 셸 자동 업데이트, 딥 링크는 범위 밖입니다(`[gap]` 43). 트레이는 2026-10-18에 들어갔습니다(05 §7.3): 마지막 창의 X는 기본으로 트레이로 숨기고, 트레이와 앱 안에 `앱 종료`(셸만)와 `완전 종료`(셸 + 이 PC의 서비스, launcher `own stop --force`)가 있습니다.
- upstream `packages/app`와 `packages/desktop`은 수정하지 않습니다. app은 디버깅용 "classic" UI로 빌드만 가능한 상태로 둡니다. desktop은 deep import, vendor, 빌드 시 치환으로만 씁니다(§4.1).
- 멀티 유저와 LAN 노출은 하지 않습니다. 서버는 127.0.0.1에만 바인딩합니다. 모바일 원격은 P8(05 M1)이며, 그때도 기기별 토큰과 보안 터널로만 엽니다(§6.4).
- 네이티브 모바일 앱(Capacitor)과 FCM/APNs 중계는 후속 범위입니다(05 M3). Web Push(05 M2)도 P8 뒤입니다. 지금은 이음매만 둡니다(§3.2, §6.4, §6.5, §17 P8).
- `[gap]` 34–42는 나중에 합니다(캐시 진단, `/btw`, 절전 방지, 알림 세분화, todo, 내보내기, 메시지 링크, 기타 설정, WSL). 43–46은 하지 않습니다(§17.1).

---

## 2. 용어

| 용어 | 정의 |
|---|---|
| **계정(Account)** | 사용자가 보는 단위입니다. accountId를 키로 하는 비밀 1개(`vault\<accountId>.dpapi`, 02 §2.4.5)와 메타데이터(label, 색, kind, 플랜)로 이루어집니다. id는 `acc_<ulid>`이고 바뀌지 않습니다(02 §2.4.1). linked Codex 계정은 vault 대신 이전 앱의 파일을 읽습니다(§8.4). |
| **kind** | `codex`(ChatGPT 구독) · `oai`(OpenAI API) · `anth`(Anthropic API) · `ds`(DeepSeek) · `xai` · `or`(OpenRouter) · `compat`(기타 OpenAI 호환, Base URL + 키) · `claude-sub`(서드파티 슬롯, 읽기 전용). `accounts.json`의 `kind`, providerID, LimitWindow id 접두어(`codex.*`, `anth.*`, `oai.*` …)에 같은 어휘를 씁니다(02 §2.1). |
| **캐시 도메인(cache domain)** | provider 서버가 prompt cache를 격리하는 단위입니다. kind별 규칙은 02 §2.2에 있습니다 `[research cache_design §1.1, cache_verify]`.<br>- ChatGPT: 로그인(`chatgpt-account-id`)<br>- OpenAI API: org<br>- Anthropic API: workspace<br>- DeepSeek: user<br>- xAI·OpenRouter·compat: 보수적으로 키 단위 |
| **쿼터 도메인(quota domain)** | 한도가 차감되는 단위입니다. Anthropic은 **org** 단위(workspace는 하위 한도)라서 캐시 도메인과 다릅니다 `[research cache_verify]`. |
| **slot / own provider** | OpenCode에 등록하는 provider 하나입니다.<br>- 형식: `own-<kind>-<slug>`. kind는 `codex`·`oai`·`anth`·`ds`·`xai`·`or`·`compat`이고, slug는 4–8자 `[a-z0-9]` 난수입니다.<br>- **만든 뒤 바꾸지 않습니다.** 라벨·이메일·조직명은 넣지 않습니다.<br>- 이유: providerID가 identity `system[1]`과 재생 판정에 들어갑니다(`packages/core/src/plugin/identity.ts:13,27`, `packages/core/src/session/runner/to-llm-message.ts:154-156`). |
| **슬롯(서드파티)** | 외부 구성요소를 끼우는 자리입니다. 서드파티 플러그인 슬롯(claude-auth)이 있습니다. 예약 슬롯이던 computer use는 launcher가 관리하는 own 플러그인이 됐습니다(§10.2). |
| **control location** | 계정·한도·플러그인 관리 RPC에만 쓰는 전용 빈 디렉터리 location입니다. 경로는 `%LOCALAPPDATA%\own-open-code\control`입니다.<br>- 세션 관련 RPC는 여기로 보내지 않습니다(§15).<br>- 비-VCS 디렉터리라 global project로 매핑되므로 여기서는 세션을 만들지 않습니다. |
| **P** | 다음 요청의 입력 토큰 추정치입니다: 마지막 step의 `input + cache.read + cache.write` + 새 메시지(02 §6.1). |
| **own-desktop (셸)** | `packages/own-desktop`입니다. upstream `packages/desktop`의 Electron main·preload를 재사용하고 렌더러만 own-web으로 바꾼 데스크톱 앱입니다. 앱 id는 `dev.own.opencode.desktop`, 제품명은 "Own OpenCode"입니다(§4.1). |
| **렌더러** | 데스크톱 창 안의 own-web입니다. 특권 스킴 `oc://renderer`에서 뜨고(`packages/desktop/src/main/windows/scheme.ts:4-26`), 서비스 비밀번호를 모릅니다(§6.1). |
| **웹 폴백** | 일반 브라우저 창(`own open --browser`, `msedge --app`)으로 own-web을 쓰는 모드입니다. 서비스가 임베드한 own-web(P-001/P-002)과 pairing 쿠키를 씁니다. |
| **세션 브라우저 권한** | 세션을 만들 때 호스트에 `browserPane` capability가 없으면 새기는 `{action:"browser", resource:"*", effect:"deny"}` 규칙입니다. 그 세션의 Code Mode 카탈로그에서 브라우저 도구가 빠집니다(05 §8.7 안 D, §10.1). |
| **OwnHost / capability** | own-web이 셸 기능을 쓰는 유일한 인터페이스입니다. capability는 그 기능 플래그입니다. 인터페이스, capability 이름, T0 호출은 05 §6이 기준입니다(§6.2). UI는 `kind`가 아니라 capability로 게이트합니다. |
| **브라우저 패인** | 데스크톱 main의 WebContentsView + CDP 호스트가 세션마다 `opencode.browser` 플러그인에 attach한 브라우저입니다(§10.1). |
| **codex source (linked / takeover)** | 이전 앱(codex-multi-provider)의 ChatGPT 로그인 파일입니다. linked는 읽기만 하고, takeover는 vault로 한 번 복사합니다(§8.4). |
| **게이트웨이(P8)** | 모바일 등 원격 기기가 닿는 유일한 끝점입니다. own-remote가 own-runtime의 프로세스 수명 런타임에 여는 loopback 리스너이고, 기기 토큰을 검증하고 service에 Basic을 붙여 중계합니다(§6.4, 05 §13.4). 아직 만들지 않습니다. |

---

## 3. 구성도

```text
Windows 11 사용자 세션 (단일 사용자, 모든 프로세스는 같은 사용자 권한)
│
├─ [앱] own-desktop  (Electron 44, %LOCALAPPDATA%\Programs\own-desktop)        ← 기본 클라이언트 (결정 D1)
│    ├─ main = upstream packages/desktop/src/main 재사용 (upstream 패치 0, §4.1)
│    │    · vendor: index.ts, desktop.ts        · 빌드 시 치환: constants.ts, lifecycle/environment.ts
│    │    · BackgroundService(own): discover(service-own.json) → 없으면 own.cmd start에 위임 (ensure 금지, §5.3)
│    │    · SidecarCredentials: 서비스 origin과 같은 요청에만 Basic 주입 (렌더러는 비밀번호를 모름)
│    │    · 네이티브: 폴더 선택 · 실제 경로 드래그 · 알림(AUMID) · 에디터/탐색기 열기 · 클립보드 이미지
│    │    · 브라우저 호스트: WebContentsView + CDP(webContents.debugger) ── attach(v4) ──▶ opencode.browser RPC
│    │    · Ssh/Wsl 레이어: import되지만 own-web이 부르지 않아 비활성 (SSH는 own-remote, §11)
│    └─ 렌더러: own-web @ oc://renderer   ← OWN_HOME\app\<version>\web (없으면 셸 번들의 폴백 페이지)
│         OwnHost(desktop) = preload window.electron + MessagePort Effect RPC
│
├─ [폴백] msedge --app=http://127.0.0.1:<port>/   own-web(서비스 임베드, P-001/P-002) · pairing 쿠키 · OwnHost(web)
│
│   두 클라이언트 공통:  REST /api/*    SSE /api/event (단일 스트림, 재연결 시 재동기화)
│                       RPC  POST /api/rpc/{own.accounts | own.remote | own.team | own.computer | own.import}/<method>?location[directory]=…
│         ▼
├─ opencode.exe  ← fork 빌드: OPENCODE_CHANNEL=own, OPENCODE_VERSION=2.0.18-own.N (고정)
│    = service 프로세스 1개 = opencode-own.db의 유일한 writer, 127.0.0.1 전용, launcher만 띄움
│    ├─ server: Basic/pair-cookie 인증, CORS(localhost·127.0.0.1·oc://renderer), WebUi(웹 폴백용 own-web)
│    ├─ core: session runner · model-resolver · compaction · permissions · PTY · VCS · MCP · KV
│    ├─ internal pre 플러그인: models.dev, openai(내장; own이 기본 비활성), identity,
│    │                         opencode.browser(항상 등록. 웹·모바일에서 만든 세션은 세션 권한으로 뺌, §10.1) ...
│    ├─ [주의] 프로젝트 .opencode/plugin(s)/ 자동 발견 플러그인 (설정된 플러그인보다 앞, §13.2)
│    ├─ config 플러그인 (own 전역 config ...\own-open-code\opencode.jsonc의 plugins 순서 = 활성화 순서, §4)
│    │    1) own.accounts (own-accounts)   계정 레지스트리 · slot/모델 등록(고정 템플릿, 유효 limit) · 요청별 인증 주입
│    │                      · Codex 로그인(device/PKCE)·가져오기(linked/takeover)·refresh · 전환 상태 머신·추정기
│    │                      · cache hint · own slot 관측 · 슬롯 설치 관리 · RPC id own.accounts 핸들러
│    │    2) own.remote (own-remote, 04)   SSH 호스트 · 터널 · 설치 · askpass · catalog · RPC id own.remote
│    │                      · [P8] 게이트웨이 리스너 · 기기 · 알림 피드 (own-runtime 프로세스 수명 런타임에서, 05 §13)
│    │    3) own.team (own-team, 06, T1)   팀 모드 · 영역(작업 폴더) · 메인 요청·보고·깨우기 · 작업(op)
│    │                      · 팀 도구 8개(Code Mode, team_*) · 조이기만 하는 evaluate 훅 · RPC id own.team
│    │                      · 컨트롤러 싱글턴(빌드 id, locks\team-controller.lock) · self-HTTP(loopback)
│    │    4) [앱에 포함] heymaaz.claude-auth-v2 (opencode-claude-auth-v2)   늘 켜짐, provider 'anthropic'만 재작성
│    │    5) own.telemetry (own-telemetry)  'anthropic' 전용 관측(unified 헤더) · retry 멈춤 방지. RPC 없음
│    │    6) own.computer-use (own-computer-use)  Effect API: computer 도구 · 실행 시점 게이트 · RPC id own.computer
│    │    7) own.import (own-import, 09)    Effect API, 훅 없음: Codex·Claude Code 대화 찾기·보기·옮기기 · RPC id own.import
│    │                      · Worker 스레드 하나(스캔·파싱) · 빌드 id 싱글턴 · self-HTTP(loopback: 세션 목록·import·압축 메시지·estimate.request)
│    ├─ internal post 플러그인: config providers ...
│    ├─ own-runtime 싱글턴 (globalThis, 빌드 id 키, 참조 카운트): vault client · 파일 저장소 · ledger writer
│    │                      · lastResponse 저장소 · refresh single-flight · codex source 읽기(linked)
│    │                      · 브로커 서버(04) · 프로세스 수명 런타임(own-remote가 터널·게이트웨이를 여기서 돌림)   ← 플러그인들이 공유
│    └─ SQLite opencode-own.db: 세션·메시지·이벤트·KV(plugin storage)
│                              + (슬롯 사용 시) anthropic OAuth credential (서드파티 설계) + MCP OAuth credential
│         │ stdio JSON-lines (env 최소화)   │ HTTPS/WSS, 요청마다 토큰 주입          │ ssh.exe (호스트당 1개, -L/-R, 04)
│         ▼                                 ▼                                       ▼
├─ own-vault.exe (Rust, DPAPI CurrentUser)  chatgpt.com/backend-api/codex         Linux 호스트: 원격 own service
│    %LOCALAPPDATA%\own-open-code\vault\*.dpapi   api.openai.com · api.anthropic.com   (브로커 lease로 로컬 계정 사용)
│                                                  api.deepseek.com · api.x.ai · openrouter.ai
│                                                  registry.npmjs.org(Codex 최신 버전 번호만, 인증 없음, 07 §4.5 CA)
│                                                  웹 검색: api.deepseek.com/v1/tools/search · api.search.brave.com (02 §9.2)
│                                                  내 키 웹 검색: core와 같은 mcp.exa.ai · mcp.firecrawl.dev · search.parallel.ai · api.tavily.com · agent.tinyfish.ai (SK)
├─ %LOCALAPPDATA%\own-open-code\{accounts,policy,ratecards,trust}.json, state\, ledger\, remote\   (§5.1)
├─ own.cmd / own.ps1 (launcher)   env 정리 → env 브리지 → service start
│                                  → open: own-desktop 실행 | --browser: pair → msedge --app
├─ [읽기 전용 입력] %USERPROFILE%\.claude\.credentials.json  (Claude Code 소유, claude-auth가 읽음)
│                  D:\#Projects\codex-multi-provider\work\control-center\profiles\<id>\codex\auth.json
│                  (이전 앱 소유, linked codex source, 절대 쓰지 않음, §8.4)
│                  %USERPROFILE%\.codex\sessions·archived_sessions·state_*.sqlite(사본으로만), %USERPROFILE%\.claude\projects
│                  (Codex·Claude Code 소유, own-import가 읽기만 함. auth.json·.credentials.json은 열지 않음, 09 §2.1)
└─ (선택) own-cu-helper.exe (C#, stdio JSON-lines) ← driver: "helper"일 때만 첫 도구 호출 때 띄움. 기본 드라이버는 서비스 안 워커 스레드 (§10.2)

[P8 = 05 M1, 결정 D3] 휴대폰 PWA(게이트웨이가 서빙하는 own-web) ── tailscale serve(HTTPS, tailnet 한정) ──▶ 게이트웨이(127.0.0.1:G, 기기 토큰 검증)
                                                                            ──▶ 127.0.0.1 service (Basic 주입) · /srv/<hostId> → 원격(04)
```

### 3.1 컴포넌트 책임

| 컴포넌트 | 책임 | 하지 않는 것 |
|---|---|---|
| opencode.exe (service) | 세션 실행, DB 단독 writer, HTTP/SSE API, 플러그인 호스트, PTY, 웹 폴백용 정적 UI 서빙 | 계정 로직(플러그인이 담당) |
| own-accounts | 담당하는 일:<br>- 계정과 slot 매핑, 고정 모델 템플릿(유효 limit 포함, R16), 인증 주입<br>- OAuth와 Codex 로그인 가져오기(§8.4)<br>- 전환 상태 머신과 추정기, cache hint<br>- own slot 관측(읽기 전용)<br>- 슬롯 설치, 플러그인 allowlist<br>- RPC id `own.accounts` 핸들러 등록 | compact/fork/새 세션 실행(프런트가 HTTP로 수행), `anthropic` 요청 변형 |
| own-remote (04) | SSH 호스트 레지스트리, ssh.exe 터널·설치·askpass, 원격 세션 토큰 서명, 브로커 arm, catalog, RPC id `own.remote`. (P8) 게이트웨이·기기·알림 피드(05 §13) | provider 비밀 읽기(브로커는 runtime 몫), ledger 쓰기, 세션 실행 |
| own-team (06) | 담당하는 일:<br>- 팀·영역·메인 요청 등록부(KV), 작업(op) 기록과 재개, 확인(nonce)과 되돌리기<br>- git 실행(작업 폴더, sparse cone, 보류 ref), 메인 요청 대기함과 메인 멈춤, 보고와 팀 소식, 메인 깨우기<br>- 담당 대화 교체·인계 문서, 팀 계정 바꾸기(팀 전체 기다리기), 영역 메인·프리셋을 own.accounts로 넘김<br>- 팀 도구 8개, RPC id `own.team` 핸들러 등록 | 모델·계정 고르기(사용자와 07), 크기로 대화 바꾸기·압축, 컴퓨터 사용 켜기·넘기기, 들어온 권한 `deny` 바꾸기 |
| own-telemetry | 담당하는 일:<br>- `anthropic`(Claude 구독 슬롯)의 최종 응답 관측(unified 헤더)<br>- 긴 멈춤 방지 retry 결정<br>- 결과를 runtime 저장소에 기록 | 요청 변형, RPC 등록, own slot 관측 |
| own-import (09) | 담당하는 일:<br>- Codex·Claude Code 저장소 읽기(허용 목록, SQLite는 사본만), 프로젝트 소속 판정, 색인(`OWN_HOME\state\import-index.json`, 내용 없음)<br>- 읽기 전용 보기와 검색(Worker 스레드, `.zst` 흘려 읽기)<br>- 옮기기 계획(창 비율, 요약 모델, 비용은 own.accounts `estimate.request`), 숨긴 보조 세션의 한 번 요약, 최종 가져오기<br>- RPC id `own.import` 핸들러 등록, 활성화 때 남은 보조 세션 정리 | 다른 도구의 파일 쓰기·잠그기, 그 도구 실행, 계정 고르기와 돌리기, 실패한 요약의 재시도, 훅 등록 |
| own-runtime | 프로세스 싱글턴이 담는 것:<br>- vault client, 원자적 파일 쓰기와 락, **단일 ledger writer**<br>- 한도 저장소, `lastResponse[sessionID]`, refresh single-flight<br>- linked codex source 읽기<br>- 브로커 서버(04), 프로세스 수명 런타임(own-remote의 터널과 P8 게이트웨이가 여기서 돎) | 훅 등록(플러그인이 함) |
| opencode.browser (내장) + 데스크톱 브라우저 호스트 | 플러그인: 브라우저 도구와 RPC(`Browser.Definition`). 호스트: 세션별 WebContentsView 조작(§10.1) | 계정·세션 로직. 웹 폴백·모바일에서는 호스트 없음 |
| own-web (렌더러/웹) | UI 전부: 전환 확인 대화상자, compact/fork/new-session HTTP 실행, 재동기화, 서버 목록(로컬+원격), 성능 예산(§6.6)의 화면 쪽 구현 | 비밀 보관, 정책의 최종 판정, 셸 API 직접 호출(`OwnHost` 경유만) |
| own-desktop (셸 main) | 창·WCO 타이틀바, 서비스 discover와 launcher 위임, 서비스 origin에 Basic 주입, 네이티브 기능(폴더 선택·드래그 경로·알림·에디터 열기·클립보드), 브라우저 호스트 | 서비스 기동(launcher 몫), 계정·세션·SSH 로직, 업데이트, `opencode://` 등록 |
| own-vault.exe | DPAPI 암복호화, 원자적 파일 교체 | 네트워크, 로깅 |
| launcher | 서비스 기동과 페어링, env 정리, env 브리지 파일, 버전 전환, `own open`에서 데스크톱 실행 | 서비스 감독(재시작 루프 없음) |
| [P8] 게이트웨이(own-remote) | 원격 기기의 유일한 끝점. 기기 토큰 검증, 범위 allowlist, service와 원격 서버로 중계, own-web 정적 서빙(§6.4, 05 §13.4) | LAN 바인딩, 비밀 전달 |

- 관측 역할 분담(02 §4.1 hook 표도 이 분담과 같아야 합니다): own slot의 `http.response`/`experimental.ws.receive`/`retry`는 own-accounts, `anthropic`은 own-telemetry가 맡습니다. own-telemetry가 따로 있는 이유는 **claude-auth 뒤에 등록돼야 하는 관측**이 `anthropic` 하나뿐이기 때문입니다(§4).

### 3.2 로직 배치 규칙 (결정 D3, backend-first)

**원칙.**
- 셸(Electron main)에는 비즈니스 로직을 두지 않습니다.
- 셸이 새로 하는 일은 모두 `OwnHost` capability(§6.2, 이름은 05 §6.2)로 드러납니다.
- 같은 결과를 서버 API로 얻을 수 있으면 서버 API를 씁니다.
- 그래야 웹 폴백과 P8 모바일이 같은 기능을 잃지 않습니다.

| 기능 | 로직 위치 | 데스크톱 셸의 역할 | 웹 폴백 | 모바일(P8) |
|---|---|---|---|---|
| 계정·slot·로그인(device code, Codex 가져오기) | service `own.accounts` | 없음. 인증 페이지를 `openExternal`로 열기만 함 | 같음 | 같음 |
| 전환·추정·캐시·한도·ledger·auto-compaction 설정 | service `own.accounts` | 없음 | 같음 | 같음 |
| 세션·권한·폼·대기열·되돌리기·PTY·VCS·파일 | service(upstream HTTP API) | 없음 | 같음 | 같음. 기기 범위는 05 §13.5 |
| SSH 원격 | service `own.remote` + own-runtime 브로커 | 없음(upstream Ssh 레이어는 비활성) | 같음 | 게이트웨이 경유 |
| 다른 도구의 대화(09) | service `own.import`(이 PC의 저장소만) | `원본 위치 열기`(로컬 연결의 `files.openPath`)뿐 | 같음 | 게이트웨이 경유. 보기 `read`, 옮기기 `prompt`, 찾을 곳 설정은 PC에서만(05 §13.5) |
| 프로젝트 폴더 열기 | service `fs.list`(control location, 절대 경로) | 네이티브 폴더 선택기(`nativeDirectoryPicker`) | 경로 입력 + 서버 폴더 목록 | 서버 폴더 목록 |
| 알림 | 대상 판정은 서버 이벤트 피드(§6.5) | 시스템 알림(AUMID) | HTML5 Notification(창이 열려 있을 때만) | Web Push 먼저, 네이티브 앱은 FCM/APNs 중계(05 §13.6) |
| 브라우저 패인 | service `opencode.browser` | WebContentsView + CDP 호스트 | 없음. 여기서 만든 세션에는 `browser` deny를 새김(§10.1) | 웹과 같음 |
| 에디터·탐색기 열기, 실제 경로 드래그, 클립보드 이미지 | – | 셸 IPC(`openInApp`, `nativeFilePaths`, `clipboardImage`) | `vscode://` 링크, 파일 업로드 | 없음 |
| 서비스 재시작 | launcher(`own.cmd restart`) | `window.own.service.restart` → launcher(05 §5.6) | 안내 문구 | 없음 |

---

## 4. 패키지와 디렉터리

모든 `packages/own-*`는 루트 `workspaces.packages`의 `packages/*` glob에 자동으로 포함됩니다(`package.json`). 따라서 루트 파일은 수정하지 않습니다. 이름은 `@own/*`이라서 upstream의 `@opencode/*`와 충돌하지 않습니다. `own-desktop`만 scope 없는 이름을 씁니다. electron-builder가 설치 디렉터리 이름을 package name에서 만들기 때문입니다(upstream은 `@opencodedesktop`, `[desktop-build §1]`).

| 경로 | 이름 | 런타임 | 내용 |
|---|---|---|---|
| `packages/own-protocol` | `@own/protocol` | 브라우저·서버 공용 | RPC 정의와 공용 스키마입니다.<br>- RPC id `own.accounts`의 정의(`Rpc.PortableDefinition`, `packages/schema/src/rpc.ts:43-60`). 메서드 80개·이벤트 19개(NOTES의 워크스페이스 노트 `notes.*`·`notes.changed`, VOICE의 음성 입력 `voice.*`, 원격 Claude의 `plugin.claudeAuth.{remote.ack,remote.set,fastAck}`까지), 목록은 02 §9.2–§9.3<br>- 공용 스키마: Account, ProviderSlot, LimitWindow, LedgerLine, SwitchState, Credential(linked/takeover), Preset(07) …, 02 §2.4·§7·§9<br>- `own.remote` 정의(04 §16, R0에서 추가), `own.computer` 정의(`rpc-computer.ts`, §10.2), `own.team` 정의(`rpc-team.ts`·`rpc-team-routing.ts`, 06 §2.7, T1), `own.import` 정의(`rpc-import.ts`·`rpc-import-routing.ts`, 09 §5, IMPORT), P-016과 같은 토큰 추정 `token.ts`(09 §4.3)<br>- 의존성은 `@opencode/schema`와 `effect`뿐 |
| `packages/own-runtime` | `@own/runtime` | 서버 전용(플러그인 번들에 각각 포함) | 프로세스 싱글턴입니다.<br>- 키: `globalThis[Symbol.for("own-open-code.runtime/<buildId>")]`. 빌드 id 키, 참조 카운트, 파일 락<br>- vault client, 파일 저장소(temp→fsync→rename, `locks\registry.lock`), ledger writer<br>- lastResponse 저장소, refresh single-flight, 결정적 해시 유틸<br>- codex source 읽기(`src/codex-source.ts`), 브로커 서버(04) |
| `packages/own-accounts` | `@own/accounts` (플러그인 id `own.accounts`) | 플러그인(Promise API) | 계정·slot, 인증 주입, 요청 형성, 전환 상태 머신, 추정기, RPC id `own.accounts` 핸들러 등록. §8, §14. e2e kit은 `test/e2e-kit` |
| `packages/own-remote` | `@own/remote` (플러그인 id `own.remote`) | 플러그인(Promise API). 로컬 `mode:"local"`, 원격 `mode:"agent"` | SSH 원격(04 §4). 프로세스 수명 런타임에서 ssh 터널·askpass·브로커 arm을 돌리고, RPC id `own.remote`을 등록 |
| `packages/own-team` | `@own/team` (플러그인 id `own.team`) | 플러그인(Promise API) | 팀 모드(06, T1부터). 프로세스·빌드마다 컨트롤러 하나(`OWN_HOME\locks\team-controller.lock`), 등록부(KV), 작업(op), 메인 요청, 보고, git 실행 핵심, RPC id `own.team` 등록. 구조는 패키지 `ARCHITECTURE.md` |
| `packages/own-telemetry` | `@own/telemetry` (플러그인 id `own.telemetry`) | 플러그인(Promise API) | §9.3, §14 (`anthropic` 전용) |
| `packages/own-web` | `@own/web` | 브라우저 · Electron 렌더러 | SolidJS·Vite·Tailwind입니다(03 §16.1).<br>- `workspace:*`로 쓰는 것: `@opencode/{client,session-ui,ui,util,schema}`, `@own/protocol`<br>- `src/host/`: OwnHost의 web/desktop 구현(§6.2, 05 §6.6). desktop 구현만 `@opencode/desktop`의 렌더러 api를 dynamic import합니다<br>- `e2e/performance/`: PF 게이트 하네스(§6.6) |
| `packages/own-desktop` | `own-desktop` (private, 제품명 "Own OpenCode") | Electron main·preload | upstream desktop main을 재사용하는 셸. 요약은 §4.1, 상세는 05 §4 |
| `packages/own-computer-use` | `@own/computer-use` | 플러그인(**Effect** API) | Windows 컴퓨터 사용(§10.2). 구조는 패키지 `ARCHITECTURE.md` |
| `packages/own-import` | `@own/import` (플러그인 id `own.import`) | 플러그인(**Effect** API), Worker 스레드 하나 | 다른 도구(Codex, Claude Code)의 대화 찾기·보기·옮기기(09, IMPORT부터). 프로세스·빌드마다 상태 하나(`own-open-code.import/<buildId>`), RPC id `own.import` 등록. 구조는 패키지 `ARCHITECTURE.md` |
| `own/native/own-vault` | (Rust crate) | Windows exe | DPAPI helper. JS workspace가 아닙니다. README가 wire protocol입니다. |
| `own/launcher` | `own.cmd`, `own.ps1`(서비스 명령과 설치 수명주기 `install`·`update`·`rollback`·`uninstall`, 0.3.0) | PowerShell 5.1+ | §5 |
| `own/vendor/claude-auth` | 앱에 넣는 Claude 플러그인의 입력 | npm | `package.json`(`"type":"module"`), `package-lock.json`, `server.js`, 패치 매니페스트 `patches/<ver>.json`. 플러그인 코드는 없습니다. 빌드가 `own/scripts/claude-auth-bundle.ts`로 이것을 설치·확인·패치·번들해 `app\<ver>\plugins\claude-auth\`에 둡니다(§9.2, 02 §8.2). |
| `own/config` | 예시 config, rate card 기본값 | – | `opencode.jsonc.example`(plugins 순서 예시. `compaction.auto`·`compaction.buffer`는 두지 않음, §8.7 R16), `ratecards.default.json`(첫 실행 때 `OWN_HOME\ratecards.json`의 seed, 02 §2.4.4) |
| `own/design/prototype` | UI 프로토타입 | 브라우저 | `index.html`(03) |
| `own/scripts` | 빌드·점검 스크립트 | Node 22 / PowerShell | `build-own.ps1`(own 채널 CLI 빌드), `check-ledger.mjs`, `check-surface.mjs`, `sync.ps1`, `smoke.ps1` |
| `own/ledger`, `own/upstream-surface.json` | 패치/벤더/cherry-pick ledger, upstream 계약 목록 | – | `core-patches.yaml`, `vendored.yaml`, `cherry-picks.yaml`, `SYNC_LOG.md`. 데스크톱 셸의 vendor·치환·deep import 경로도 여기에 등록합니다(`own/FORK.md` §7) |

**플러그인 설정 위치와 순서.**
- 플러그인은 own 전역 config `%USERPROFILE%\.config\own-open-code\opencode.jsonc`(`OPENCODE_CONFIG_DIR`)에만 설정합니다. upstream 설치본의 `~/.config/opencode/opencode.json[c]`는 건드리지 않습니다(§5.2).
- 순서는 `[own.accounts, own.remote, own.team, heymaaz.claude-auth-v2(앱에 포함), own.telemetry, own.computer-use, own.import, own.harness, own.omo, own.creator]`입니다(own.harness는 H0부터, 10. own.omo는 그 다음, 15. own.creator는 맨 뒤, 17). 각 항목은 디렉터리 경로로 적습니다(§9.2, 02 §8.2). 그 뒤, 목록의 맨 끝에는 사용자가 승인한 creator 코드 플러그인(C3, 17 §12.4)의 항목이 올 수 있습니다. own.creator가 쓰고 launcher는 옮기지 않습니다.
  - own-remote를 설치하기 전(R1 이전)에는 2번 자리를 비워 둡니다(04 §21 이음매 5).
  - own-remote가 2번인 이유: 슬롯 설치·제거 때 own-remote가 재시작되지 않게 하기 위해서입니다(04 §4.1).
  - own.team(06 §2.6)은 3번 자리입니다. T1 빌드(2.0.18-own.6)부터 launcher가 관리하는 번들이고(`own.ps1` `$ManagedPlugins`), 업데이트는 기존 config의 own-remote 줄 다음(claude-auth 줄 앞)에 넣습니다. claude-auth 줄이 바뀌어도 own.team이 다시 시작되지 않게 하기 위해서입니다. claude-auth 줄도 2026-10-18부터 launcher가 관리합니다(없으면 own.team 줄 뒤에 넣고 업데이트마다 `<ver>`를 바꿈, 02 §8.2 5·7번). own-team이 없던 빌드(own.5 이하)에는 그 자리가 없습니다.
  - `own-computer-use`는 6번 자리입니다(own-team이 없던 빌드에서는 다섯 번째 항목, §10.2). 에이전트 변환이 own-accounts의 에이전트가 생긴 뒤에 돌아야 하기 때문입니다. launcher가 관리하며, 업데이트가 새 번들을 가져오면 기존 config에 넣습니다.
  - `own-import`(09 §5.1)는 맨 뒤 7번 자리입니다(IMPORT부터). 훅이 없어 요청 경로에 끼지 않고, config는 처음 바뀐 자리 뒤의 플러그인만 다시 불러오므로 맨 끝에 더하면 다른 플러그인이 다시 뜨지 않습니다. launcher가 관리하며(`$ManagedPlugins`의 맨 끝), 업데이트는 기존 config의 own-computer-use 줄 뒤에 넣고, 사용자가 지운 줄은 다시 넣지 않습니다. own-accounts의 신뢰 목록(`plugins/inventory.ts` `OWN_PACKAGES`)에도 있어야 그것을 싣는 Location이 `blocked_by_plugin`이 되지 않습니다. 원격 호스트에는 싣지 않습니다(04 §4.1).
- 내장 `opencode.browser`는 끄지 않습니다(`"-opencode.browser"` 금지). 서비스가 하나라서 끄면 데스크톱 세션에서도 사라집니다. 세션별 처리는 §10.1입니다.

**왜 플러그인이 여러 개인가.**
- **순서.** 같은 이름의 훅은 등록 순서대로 실행됩니다(`packages/core/src/plugin/hooks.ts:66-95`).
  - 관측 훅은 claude-auth보다 **나중에** 등록돼야 합니다. Claude 구독 슬롯의 `http.response`를 claude-auth가 재전송한 **최종 응답**으로 관측하기 위해서입니다.
  - slot을 등록하는 쪽(own-accounts)은 claude-auth보다 앞에 있어야 합니다. 그래야 `anthropic` 카탈로그 모델을 claude-auth의 `cost=[]` 변형 이전 상태로 읽을 수 있습니다(transform은 등록 순서로 fold됨).
  - 이 두 조건 때문에 `anthropic` 관측만 own-telemetry(5번)에 둡니다.
  - own-remote는 session 훅과 provider transform을 등록하지 않으므로 2번에 두어도 이 조건을 깨지 않습니다(04 §4.1).
- **상태 공유.** 플러그인 인스턴스는 Location마다 따로 뜨고, local 플러그인은 로드할 때마다 새로 import됩니다.
  - 운영 바이너리는 Bun이므로 `#plugin-source`가 `source.bun.ts`로 해석됩니다(`packages/plugin/package.json` imports). 이 로더는 진입 파일과 `node_modules` 밖 로컬 의존성의 `require.cache`를 지운 뒤 다시 import합니다(`packages/plugin/src/source.bun.ts:11-68`).
  - Node 경로는 `__opencode_reload` 쿼리로 같은 효과를 냅니다(`packages/plugin/src/source.node.ts:10-16`).
  - 어느 쪽이든 모듈 싱글턴은 공유되지 않으므로 `globalThis`의 runtime 싱글턴을 거칩니다. KV를 교차로 읽지 않습니다.
- **싱글턴 규칙**
  - 키에 **빌드 id**를 넣습니다. 빌드 id는 own 패키지(protocol, runtime, accounts, telemetry, remote, team, computer-use, import) 소스의 입력 해시이고(`own/FORK.md` §8.2 1b, `packages/own-remote/script/bundle.ts` `OWN_PACKAGES`), 빌드 때 모든 플러그인 번들에 같은 값으로 새깁니다. `v1` 같은 고정 키를 쓰면 hot reload 뒤에도 옛 코드가 든 싱글턴이 살아남습니다. own-team의 컨트롤러도 같은 빌드 id를 키로 씁니다(`own-open-code.team-controller/<buildId>`). own-import는 색인·Worker·계획 nonce·가져오기 작업을 `own-open-code.import/<buildId>` 상태 하나에 둡니다(데스크톱 번들은 Location마다 다시 평가되므로).
  - Location 인스턴스가 setup에서 `acquire`, scope finalizer에서 `release`하는 **참조 카운트**를 둡니다. 0이 될 때만 vault 자식 프로세스를 닫고 ledger를 flush합니다. 한 Location의 정리가 공용 자원을 내리지 않게 하기 위함입니다. own-remote의 SSH 컨트롤러는 Location Scope가 아니라 프로세스 수명 런타임에서 돕니다(04 §4.1).
  - 빌드가 바뀐 직후 옛 싱글턴과 새 싱글턴이 잠시 공존할 수 있습니다. 이 겹침은 메모리 mutex가 아니라 파일 락이 막습니다: `vault\<accountId>.lock` lease, `locks\registry.lock`, `locks\remote-controller.lock`, `locks\team-controller.lock`(02 §2.3·§3.5 F3, 04 §4.1, 06 §2.6).
  - **ledger writer는 runtime의 것 하나**이고 모든 플러그인이 이것으로 씁니다. 줄마다 이벤트 id를 넣어 멱등 처리합니다(Location별 중복 구독 대비).
  - 싱글턴에는 raw 비밀 getter를 두지 않습니다(§13.2).

### 4.1 own-desktop 구성 (upstream 패치 0, 결정 D1)

**상세 구성(레이아웃, 치환 코드, builder 설정, 원장 항목)은 05 §4가 기준입니다.** 여기에는 프로세스 경계와 포크 경계에 걸리는 계약만 둡니다. `@opencode/desktop`에는 exports 맵이 없고 `main`만 있습니다(`packages/desktop/package.json:26`). 그래서 소스 경로로 deep import할 수 있습니다. 안정 API는 아니므로 모든 경로를 ledger와 surface 목록에 등록합니다(`[desktop-verdict §2]`).

| upstream 대상 (`packages/desktop/src/…`) | 방식 | 01이 요구하는 불변식 |
|---|---|---|
| `main/index.ts`, `main/desktop.ts` | **vendor**(05 §4.2) | `own-env` 스냅샷이 첫 import(05 §5.2). 렌더러 프로토콜을 upstream보다 먼저 등록(first-wins, `main/windows/protocol.ts:38-39`). `startSidecarProbe()` 제거. `BackgroundService`·`DesktopCli` layer 교체(`main/desktop.ts:36-46`) |
| `main/constants.ts` | **빌드 시 치환**(05 §4.3) | `APP_ID=dev.own.opencode.desktop`, `UPDATER_ENABLED=false`. export 5개(`CHANNEL`, `VERSION`, `UPDATER_ENABLED`, `APP_NAME`, `APP_ID`, `main/constants.ts:5-22`)를 모두 유지 |
| `main/lifecycle/environment.ts` | **빌드 시 치환**(05 §4.3) | `resolveId` 치환은 모듈 전체를 바꾸므로 **export를 전부 유지**합니다: `installContextMenu`, `prepareApplicationEnvironment`(시스템 CA + 프록시, `environment.ts:17-20,49-63`), `preferApplicationEnvironment`(own은 no-op), `prepareDesktop`(프로토콜 등록만 빼고 렌더러 등록·dock 아이콘 호출은 남김, `:36-47`), `loadProxyEnvironment`. `opencode://` 등록은 치환이 유일한 방어입니다(`:39-40`, `[desktop-build §4 risk 2]`) |
| `main/service/background-service.ts` | **layer 교체** `BackgroundService(own)`(§5.3, 05 §5.3) | discover만, `Service.ensure` 금지. 원본은 `file` 없이 ensure를 불러 upstream `service.json`의 서비스를 stop할 수 있습니다(`background-service.ts:41-47`, `packages/client/src/promise/service.ts:85-93,127-129`) |
| `main/service/desktop-cli.ts` | **layer 교체** `DesktopCli(own)`(05 §5.4) | `resolve`는 `app\<version>\opencode.exe`를 가리키고 복사하지 않습니다(원본은 `desktop-cli.ts:152-171`에서 197MB 복사). **`install`은 항상 거부**합니다. `Interface`가 `install`을 요구하고(`desktop-cli.ts:23-26`), upstream은 이것을 메뉴 동작 `installCli`(`ipc-handlers/app.ts:71`, `native/install-cli.ts`)에 연결합니다. upstream 구현도 macOS 밖에서는 실패하지만(`desktop-cli.ts:37-38`), own 구현이 `opencode.exe`를 PATH에 까는 동작을 갖게 되면 "raw exe를 PATH에 두지 않는다"(§5.4)가 깨지므로 명시적으로 거부합니다 |
| `electron-builder.config.ts` | spread 후 덮어씀(05 §4.5) | `protocols:[]`, `publish:null`, `extraResources`에서 CLI 제거. upstream `afterPack`은 번들 CLI가 없으면 예외를 던지므로(`electron-builder.config.ts:99-107`) **`afterPack`도 반드시 덮어씁니다.** CLI 없는 패키지는 아직 빌드해 보지 않았습니다 ⚠(PoC는 CLI를 번들함, DS0에서 확인) |
| 나머지 main(`windows/*`, `ipc*`, `browser*`, `ssh/*`, `wsl/*` …), `preload/index.ts`, `renderer/{api,ipc-client}.ts`, `shared/ipc-transport.ts` | 그대로 import 또는 deep import(05 §4.2, §6.6) | import할 때 부작용이 있는 파일은 `index.ts`, `desktop.ts`뿐입니다. `renderer/platform/*`, `desktop-app.tsx`는 쓰지 않습니다(`@opencode/app` 전체를 끌고 옴) |

- **코어 패치가 아닙니다.** upstream 추적 파일은 바뀌지 않으므로 `check-ledger.mjs`의 diff 대상이 아닙니다. 대신 vendor·치환·deep import 경로는 모두 `own/ledger/vendored.yaml`(`kind: vendor | substitute | deep-import`)과 `own/upstream-surface.json`에 등록합니다(`own/FORK.md` §7).
- **쓰지 않는 upstream 기능**(목록은 05 §6.5): Updater(`disabled`만 처리), Storage/Drafts, Wsl, Ssh UI, DeepLink, MenuCommand, `finishFirstLaunchOnboarding(true)`(부르면 Documents에 폴더가 생김, `main/lifecycle/onboarding.ts:36-46`).
- **Windows 창**(05 §7): frameless + WCO. 네이티브 메뉴가 없으므로(`main/native/menu.ts:26`) 단축키와 커맨드 팔레트는 own-web이 맡습니다. 창을 모두 닫으면 셸은 끝나지만 서비스는 계속 돕니다(`main/lifecycle/index.ts:108-110`).
- **툴체인**: upstream과 같은 판으로 고정합니다: electron-vite 6.0.0-beta.1, electron-builder 26.15.7, vite 8.2.4 `[desktop-build §1]`. electron만 기록된 예외로 upstream보다 앞섭니다: own-desktop은 44.10.2(2026-11-10, 결정 EL-1), upstream은 44.9.1(v2.2.1 sync, 2026-10-31; 그 전 44.4.5)입니다. 44.10.2의 Chromium·V8·PDFium 보안 수정과 Node 24.22.2가 아무 사이트나 여는 브라우저 패인에 필요해서입니다. upstream이 44.10.2 이상을 고정하면 upstream 판으로 돌아갑니다(그때 `packages/own-desktop/test/shell.test.ts`의 예외가 실패합니다).
- **크기**: 게이트는 05 DP5입니다(설치 파일 ≤ 150MB, 설치 후 ≤ 460MB). PoC 설치 파일은 CLI 포함 199.4MB(실측)였고, CLI를 뺀 권고안은 추정입니다 ⚠.

---

## 5. 프로세스와 서비스 수명주기 (Windows)

### 5.1 설치 레이아웃

```text
%LOCALAPPDATA%\own-open-code\          ← OWN_HOME (02 §2.3)
  bin\own.cmd, own.ps1                 ← PATH에 추가되는 유일한 진입점
  app\2.0.18-own.1\opencode.exe        ← fork 바이너리 (웹 폴백용 own-web 임베드, P-001)
  app\2.0.18-own.1\web\                ← own-web 빌드 = 데스크톱 렌더러 루트(oc://renderer). 서비스와 함께 버전 포인터로 교체
  app\2.0.18-own.1\plugins\own-accounts\index.js, own-remote\index.js, own-telemetry\index.js,
                    own-computer-use\index.js   (bun build 단일 번들, minify. T1부터 own-team\index.js,
                    IMPORT부터 own-import\index.js: 스캔 Worker 소스를 define으로 품은 한 파일)
  app\<ver>\plugins\claude-auth\server.js, package.json, own-bundle.json,
                    node_modules\opencode-claude-auth-v2\{package.json, index.js, LICENSE, dist\index.js}
                                       ← (2026-10-18) 앱에 든 Claude 구독 플러그인. 빌드 때 lock 설치·확인·패치,
                                          bun build 한 파일(약 86 KB, minify 없음). own-bundle.json에 빌드 id와
                                          파일마다 sha256 (02 §8.2)
  app\2.0.18-own.1\own-vault.exe
  app\2.0.18-own.1\own-cu-helper.exe   ← (§10.2) 컴퓨터 사용 대체 helper. driver: "helper"일 때만 첫 컴퓨터 동작 때 뜸
  app\2.0.18-own.1\remote\*.tar.gz     ← (04 §5.2) 원격 호스트용 Linux 번들
  app\2.0.18-own.1\templates\claude-auth\…   ← (2026-10-18 전) 슬롯 shim 템플릿. 지금은 싣지 않음
  app\2.0.18-own.1\templates\ratecards.default.json                                ← ratecards.json seed
  app\2.0.18-own.1\manifest.json       ← 버전, 커밋, 파일 해시, rpcHash(셸↔렌더러 IPC 계약 해시) (own/FORK.md §8)
  app\current.json                     ← 버전 포인터 {schema, version, path, previous, updatedAt, launcher}. launcher가 전환마다
                                          temp → fsync → rename으로 씀. launcher·셸·플러그인이 모두 여기서 app\<version>을 찾음
                                          (파일 옆의 app\<version>. path는 참고용). junction은 쓰지 않음(아래)
  accounts.json                        ← 레지스트리: 도메인, 계정, slot, 고정 모델 템플릿 (02 §2.4.1)
  policy.json                          ← 전환 정책·임계값·auto-compaction 정책 (02 §2.4.3)
  ratecards.json                       ← 요율, TTL 하한·상한 (02 §2.4.4)
  trust.json                           ← 프로젝트 플러그인 승인 기록 (§13.2)
  state\limits.json                    ← 계정별 마지막 LimitWindow 스냅샷 (02 §7.4)
  state\exe-version.json               ← launcher 캐시: 설치된 opencode.exe의 --version 판정 {key, version} (§5.3)
  state\computer-use-stop.json         ← (§10.2) 켜진 컴퓨터 사용 킬스위치 {engaged, reason, at}. reset이 지움
  locks\registry.lock                  ← 프로세스 사이 레지스트리 쓰기 락
  locks\remote-controller.lock         ← (04 §4.1) SSH 컨트롤러 단일화
  vault\<accountId>.dpapi              ← 비밀 (DPAPI). linked codex 계정은 파일 없음(§8.4)
  vault\<accountId>.dpapi.prev         ← 직전 버전 (refresh 중 크래시 대비)
  vault\<accountId>.lock               ← refresh lease {pid, startedAt, until}
  ledger\usage-YYYY-MM.jsonl           ← step별 사용량 (02 §7.5)
  ledger\events-YYYY-MM.jsonl          ← 전환·경보·로그인·소진 이벤트
  ledger\rollup.json                   ← 집계. 원본 12개월 보존, 지난 달 파일은 gzip
  remote\hosts.json, remote\<hostId>\… ← (04 §22) own-remote 상태 (catalog, ops, ack, leases, tunnel.pid)
  audit\computer-YYYY-MM.jsonl         ← (§10.2) 컴퓨터 사용 감사 로그. 이미지·입력 텍스트·창 제목 없음
  thirdparty\claude-auth\              ← Claude 플러그인의 상태 폴더: claude-accounts.json(own이 쓴 계정 목록),
                                          claude-auth-state\(계정별 상태·잠금). 버전 폴더 밖이라 업데이트에도 남음.
                                          2026-10-18 전에는 npm 설치 자리였고, launcher가 옛 설치 파일만 지움 (02 §8.2 7번)
  claude-accounts\<id>\                ← own이 만든 Claude 계정의 로그인 폴더 (02 §8.7)
  control\                             ← control location (빈 디렉터리)
  backup\opencode-own.<ver>.<ts>.db    ← 버전 전환 전 DB 백업
  [P8] devices.json                    ← 원격 기기 토큰 해시·범위·만료·폐기 기록 (05 §13.5)
  [P8] feed\feed-YYYY-MM.jsonl         ← 알림 피드, 30일·1만 개 상한 (05 §13.6, M2)
  [P8] vault\push-vapid.dpapi          ← Web Push VAPID 개인키 (05 §13.6, M2)

%LOCALAPPDATA%\Programs\own-desktop\   ← 데스크톱 셸 설치 위치 (electron-builder NSIS per-user. 이름은 package name에서 나옴)
%APPDATA%\dev.own.opencode.desktop\    ← 셸 userData: 창 상태, 렌더러 localStorage(세션 목록 캐시, §6.3), IndexedDB(초안 이미지), 브라우저 복원 기록

%USERPROFILE%\.config\own-open-code\   ← OPENCODE_CONFIG_DIR (launcher가 설정)
  opencode.jsonc                       ← 전역 config. 플러그인은 여기에만 설정 (plugins 순서 §4,
                                          permissions, update:"disable", share. compaction.auto/buffer는 두지 않음 §8.7 R16)
  service-own.json                     ← CLI 서비스 설정 {hostname 127.0.0.1, port, password, env}
%USERPROFILE%\.config\opencode\service-own.json        ← env 브리지 (§5.2). 위 파일과 같은 내용. 이 디렉터리에 쓰는 유일한 파일
%USERPROFILE%\.local\state\opencode\service-own.json   ← 등록 파일 {id,version,url,pid,password}. 데스크톱은 이것만 봄(§5.3)
%USERPROFILE%\.local\share\opencode\opencode-own.db    ← 세션 DB (채널별 파일)
```

### 5.2 채널 격리

| 자원 | upstream(latest) | own 채널 | 근거 |
|---|---|---|---|
| DB | `opencode.db` | `opencode-own.db` | `packages/cli/src/database-path.ts:4-12` |
| 등록 파일 | `service.json` | `service-own.json` | `service-config.ts:29-32` |
| 서비스 설정 파일 | `<global.config>/service.json` | `<global.config>/service-own.json` | `service-config.ts:99` |
| 기본 포트 | 49374 (`0xc0de`) | `10000 + hash("own") % 50000` (결정적) | `service-config.ts:34-38` |
| 전역 config | `~/.config/opencode` | `~/.config/own-open-code` (`OPENCODE_CONFIG_DIR`) | `packages/cli/src/server-process.ts:36`, `packages/util/src/global.ts:79` |
| data/state/cache 루트 | `opencode` | **공유**. 앱 이름이 `"opencode"`로 하드코딩돼 있음 | `packages/util/src/global.ts:12` |
| 데스크톱 앱 id·userData·AUMID | `ai.opencode.desktop`(dev·beta는 접미어 `.dev`·`.beta`), `%APPDATA%\<APP_ID>` | `dev.own.opencode.desktop` | `packages/desktop/src/main/constants.ts:15-22`, `lifecycle/configure.ts:30` |
| URL 스킴 | `opencode://` | **등록하지 않음** | `lifecycle/environment.ts:39-40` (치환, §4.1) |

- **등록 파일 마이그레이션은 안전합니다.** legacy 마이그레이션은 버전이 채널에 속할 때만 일어나므로, upstream의 `service.json`을 가져오지 않습니다(`service-config.ts:56-69`).
- **config 디렉터리는 env로 격리합니다.** 이 env가 없는 상태로 raw `opencode.exe`가 서비스를 새로 띄우면 upstream config를 읽을 위험이 있습니다. 패치 없는 완화책을 둡니다.
  - **env 브리지**: launcher가 `%USERPROFILE%\.config\opencode\service-own.json`에도 `{"env": {"OPENCODE_CONFIG_DIR": "<…\\own-open-code>", "OWN_OPEN_CODE": "1"}, hostname, port, password}`를 씁니다. 파일 이름이 채널 전용이라 upstream의 `service.json`과 겹치지 않습니다.
  - env 없이 실행된 raw exe도 서비스 설정을 `global.config`(= 기본 `~/.config/opencode`)에서 읽고(`service-config.ts:99,118-125`), 그 `env`를 spawn env에 합칩니다(`service-config.ts:109`, `packages/client/src/service-contender.ts:21` `env: {...process.env, ...env}`). 그래서 새로 뜬 서비스는 올바른 config 디렉터리와 마커를 갖습니다.
  - `%USERPROFILE%\.config\opencode`에는 이 채널 전용 env 브리지 파일 하나만 씁니다. upstream 설치본의 `opencode.json[c]`와 그 밖의 파일은 건드리지 않고, 플러그인은 `%USERPROFILE%\.config\own-open-code\opencode.jsonc`에만 설정합니다(§4).
  - 두 설정 파일은 launcher가 항상 같은 내용으로 씁니다. 서비스는 spawn할 때만 이 파일을 읽으므로 떠 있는 동안 써도 안전합니다. `service set …`은 쓰지 않습니다(서비스를 멈춤, §5.4).
  - 남는 틈: `opencode.exe serve --service`를 손으로 직접 실행하는 경우입니다. 금지 목록(§5.4)과 가드 1이 막습니다. 그래도 부족하다는 것이 G1에서 드러나면 후보 패치 **P-003**(채널별 앱 루트)을 켭니다.

### 5.3 누가 서비스를 띄우는가 (데스크톱은 launcher의 클라이언트)

**서비스를 띄우는 것은 launcher `own`뿐입니다.**
- Windows SCM 서비스가 아니라 **사용자 세션의 detached 프로세스**입니다. DPAPI 사용자 컨텍스트, 사용자의 git 자격증명, 향후 computer use 때문에 사용자 세션에서 실행해야 합니다.
- own-desktop도 서비스를 직접 띄우지 않습니다. 등록 파일로 서비스를 찾고, 없으면 launcher에 위임하는 **클라이언트**입니다(결정 D1).

```text
own open (시작 메뉴 바로가기, 기본)
 0. env 브리지: 두 service-own.json을 같은 내용으로 갱신 (§5.2)
 1. env 정리: OPENCODE_CONFIG_DIR 설정, OWN_OPEN_CODE=1, OPENCODE_DISABLE_AUTOUPDATE=1,
              OPENCODE_DISABLE_FREE_MODELS=1 설정, provider 키 env(OPENAI_API_KEY, ANTHROPIC_API_KEY,
              DEEPSEEK_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY …)와 ANTHROPIC_*/CLAUDE_*/OPENCODE_CLAUDE_AUTH_*,
              OpenTelemetry 내보내기 설정 OTEL_* 제거 (있으면 경고만 출력; 텔레메트리 점검 TLM)
 2. app\<version>\opencode.exe service start
      → Service.ensure: 등록 파일을 읽고 GET /api/info로 확인. 없거나 버전이 다르면
        '<self> serve --service'를 detached로 실행 (packages/client/src/effect/service.ts:54-143)
 3. own-desktop이 설치돼 있으면 실행하고 끝남 (페어링 없음. 데스크톱은 쿠키를 쓰지 않음)
    설치돼 있지 않으면 --browser와 같게 동작 (launcher v0은 아직 항상 msedge를 엶. P4에서 바꿈)
own open --browser (웹 폴백)
 3. 등록 파일의 password로 POST /api/pair → {code, expires_in:300} (packages/server/src/pairing.ts:24-28)
 4. msedge --app=http://127.0.0.1:<port>/auth/connect/<code>
      → HttpOnly 30일 쿠키 발급 후 302 / (packages/server/src/handlers/server.ts:28-51)
own-desktop 단독 실행 (셸 바로가기, 알림 클릭, 두 번째 인스턴스)   ← 상세 순서는 05 §5.3
 a. own-env: entry 최상단에서 Electron이 env를 건드리기 전에 process.env 스냅샷.
    셸은 이 스냅샷을 그대로 넘기고 키를 지우지 않음. 더하는 키는 실행 표시 OWN_LAUNCHER_CLIENT=desktop 하나
    (launcher가 읽고 지움, 아래). env 정리는 launcher 한 곳 (05 §5.2)
 b. BackgroundService(own).connect
    b1. Service.discover({file: <XDG_STATE_HOME | ~/.local/state>\opencode\service-own.json}) → healthy면 채택
        ※ Service.ensure는 절대 부르지 않고 version도 넘기지 않음
    b2. 없으면 %LOCALAPPDATA%\own-open-code\bin\own.cmd start 를 고정 인자로 실행
        (cmd.exe /d /s /c, a의 스냅샷 env, 닫힌 stdin, windowsHide, 타임아웃 60초).
        own.cmd가 PSModulePath를 비우고 powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass로 own.ps1을 부름
        (own/launcher/own.cmd:5-6). PowerShell 7 창의 값을 물려받으면 5.1이 7의 모듈을 읽어 Get-FileHash가 실패하기 때문.
        비우면 5.1이 자기 기본 모듈 경로를 만들고, 서비스와 그 에이전트 셸도 그 값을 물려받음 (own/FORK.md §8.2).
        own.ps1도 Windows PowerShell에서 돌면 맨 위에서 같은 기본값을 직접 만들고 파일 해시는 .NET으로 셈
        (2026-10-26). 설치 프로그램과 데스크톱 셸(05 §5.3)은 own.cmd 없이 powershell.exe -File own.ps1을 부르기 때문.
        Windows 클라이언트 기본 실행 정책(Restricted)에서도 동작하게 하기 위함.
        env 정리·브리지·service start는 launcher가 함.
        세션이 도는 중 버전 교체가 필요하면 launcher가 거부 (own/launcher/own.ps1:283-290)
        → 렌더러에 "own restart 필요"
    b3. 다시 discover → SidecarCredentials.set({url, password}) → 렌더러에는 {url}만 (awaitInitialization)
    reconnect도 같은 순서 (password가 바뀌었을 수 있으므로 등록 파일을 매번 다시 읽음)
 c. 셸↔렌더러 계약 검사 (첫 창 전, 05 §5.5): manifest rpcHash ≠ 셸 rpcHash 또는 app\<version>\web 없음
    → 렌더러 대신 셸 번들의 폴백 페이지를 등록 (배너가 아님, G-D6)
 d. 버전 스큐 검사 (첫 창 뒤, 비동기): 등록 파일의 서비스 version ≠ app\<version>\manifest.json version
    → 전체 화면 배너 (가드 2와 합침, §5.4)
own open --untrusted → 서비스를 OPENCODE_CONFIG_PROJECT_DISABLE=1로 (재)기동 (§13.2)
own tui | own run …  → 같은 env로 opencode.exe 실행 (같은 버전 → 기존 service 재사용)
own stop | restart    → 실행 중인 세션을 확인(GET /api/session/active)한 뒤 service stop
```

- **launcher의 고정 비용.** `own start`·`open`은 데스크톱의 cold path(b2)이기도 해서 기동마다 드는 비용을 줄였습니다.
  - **죽은 등록 파일.** 서비스는 정상 종료할 때만 등록 파일을 지우므로 재부팅·크래시·kill 뒤에는 파일이 남습니다. launcher는 파일의 `pid`가 살아 있는지 먼저 보고(`[Diagnostics.Process]::GetProcessById`, 핸들을 열지 않음), 없거나 죽었으면 `GET /api/info` 없이 stale로 봅니다. Windows PowerShell 5.1에서 닫힌 loopback 포트로의 연결은 실패까지 약 2초 걸리기 때문입니다. pid가 살아 있으면 지금처럼 `/api/info`로 확인합니다(pid 재사용 대비). `start`·`open`·`status`·`stop`과 install 계열이 모두 이 경로를 씁니다.
  - **exe 버전 캐시.** 가드 "own 채널 빌드만 띄운다"는 `opencode.exe --version`을 물어 확인합니다(warm 약 150 ms, 설치·재부팅 뒤 첫 실행은 수 초). 설치된 exe의 판정은 `OWN_HOME\state\exe-version.json`에 `{key: "<전체 경로>|<크기>|<LastWriteTimeUtc ticks>", version}`으로 남기고, 키가 같고 저장된 version이 own 버전(`-own.N`)일 때만 spawn을 건너뜁니다. 그 밖(다른 키, 깨진 파일, own이 아닌 version)은 모두 miss라서 다시 묻고, 거부의 근거가 되지 않습니다. 바뀐 exe는 크기나 수정 시각이 달라 다시 물립니다. `OWN_OPENCODE_EXE`(제자리에서 다시 빌드될 수 있는 개발 빌드)를 쓰면 늘 묻고 캐시를 읽지도 쓰지도 않습니다. 캐시는 이 프로세스의 쓰기가 실제 폴더에 닿는다고 확인된 실행(§5.5 패키지 앱 검사 통과)에서만 씁니다. 지워도 다음 기동에서 한 번 더 물을 뿐입니다.
  - **`OWN_LAUNCHER_CLIENT=desktop`.** own-desktop이 launcher를 부르는 모든 실행(`start`, `restart`, `open --browser`)에 넣습니다. launcher는 시작할 때 한 번 읽고 자기 env에서 지우므로 서비스는 물려받지 않습니다(그래서 서비스의 셸 도구에서 친 `own start`는 CLI 실행입니다). 효과는 게이트웨이 기동 깨우기를 건너뛰는 것 하나입니다(05 §13.4 2번).
- **창과 서비스는 수명이 다릅니다.** 데스크톱을 닫아도 서비스는 멈추지 않습니다(detached, upstream과 같음). 창을 닫아도 턴은 계속됩니다(G-D3).
- **서비스 env는 누가 창을 열었든 같습니다.**
  - upstream 데스크톱은 서비스 env에 `OPENCODE_CLIENT=desktop`, `OPENCODE_EXPERIMENTAL_FILEWATCHER`, `OPENCODE_EXPERIMENTAL_ICON_DISCOVERY`를 넣습니다(`main/lifecycle/environment.ts:26-32`). 우리는 치환으로 이것을 뺍니다.
  - 어차피 서비스는 launcher가 정리한 env로 뜹니다.
- **셸에 CLI를 번들하지 않습니다.** 이유는 두 가지입니다 `[desktop-build §4 risk 4]`.
  - 번들 CLI는 `app\<version>\plugins`와 버전이 어긋날 수 있고, 그러면 가드 1이 fail closed로 계정을 끕니다.
  - ensure가 launcher가 띄운 서비스를 교체할 수 있습니다.
- **개발 모드**
  - `OWN_DESKTOP_CHANNEL=local`이면 `service-local.json`과 `own-open-code-dev` config를 씁니다.
  - `ELECTRON_RENDERER_URL`은 own-web Vite 주소로 둡니다. `isRendererUrl`이 이 origin을 허용합니다(`main/windows/scheme.ts:16-26`).
  - upstream `bun dev`의 `OPENCODE_DESKTOP_ISOLATED_SERVER=1` 흐름은 쓰지 않습니다. 이 흐름에서는 서버가 LAN 주소로 광고됐습니다 `[desktop-build §4 risk 6]`.
- 로그온 시 자동 시작은 **선택 사항**입니다(Task Scheduler "at logon" → `own service start`, 숨김 실행). 재시작 루프를 도는 감독자는 두지 않습니다. 감독자가 둘이면 재시작 경합이 생기고, 결국 writer가 둘이 됩니다 `[research critique #5]`.
- 서비스 모드의 cwd는 홈 디렉터리입니다(`server-process.ts:55`). 그래서 모든 클라이언트 호출은 `location[directory]`를 **쿼리로 명시**해야 합니다(§15). 파일 watcher는 기본으로 켜져 있으므로(`server-process.ts:120`), 홈 디렉터리 location이 생기지 않게 합니다(G15).
- `--untrusted`는 서비스 전역 설정입니다. 서비스가 하나이므로 모든 프로젝트의 프로젝트 config(플러그인뿐 아니라 agent, command, 프로젝트 `opencode.json` 전체)가 꺼집니다(`server-process.ts:110-112`). 모드를 바꾸려면 서비스를 재시작해야 하므로 실행 중인 세션을 먼저 확인합니다.

### 5.4 single writer 규칙과 가드

- **금지 목록**
  - 같은 DB로 foreground `serve` 실행, 또는 `serve --service`를 손으로 실행
  - `--standalone` (별도 서버를 띄움, `packages/cli/src/services/standalone.ts:21-29`)
  - v2 ACP
  - 여러 버전을 동시에 설치해서 실행
  - 세션이 실행 중일 때 `service set …`/`unset …` 실행 (서비스가 멈춤, `service-config.ts:175-258`)
  - upstream OpenCode Desktop(stock)을 own exe나 own 서비스와 함께 쓰기. stock 셸은 `service.json`만 보고, 버전이 다르면 그 서비스를 stop할 수 있습니다(§4.1).
  - own-desktop이 `Service.ensure`를 직접 부르기, 셸에 CLI 번들
  - `opencode service set hostname 0.0.0.0` 등 서비스를 LAN에 여는 설정. upstream `pair` 명령은 다른 기기 연결 방법으로 이것을 안내합니다(`packages/cli/src/commands/handlers/pair.ts`의 마지막 안내문). 원격 기기는 §6.4 방식으로만 붙입니다.
- **개발 모드는 채널 `local`을 씁니다.** 소스에서 실행하면 DB가 `opencode-local.db`, 포트가 49375(Windows에서는 28895, upstream `defaultPort`가 0x8000 이상을 0x7000 묶음으로 옮김), 등록 파일이 `service-local.json`로 분리됩니다(`packages/cli/src/version.ts:6,10`). 따라서 운영 DB에 닿지 않습니다. 개발용 config는 `OPENCODE_CONFIG_DIR=%USERPROFILE%\.config\own-open-code-dev`로 둡니다. 개발 셸(비패키지)은 local 채널 서비스에만 붙입니다(CDP 포트, §13.3).
- **가드 1 (플러그인, fail closed).** own-accounts는 setup에서 다음을 확인합니다.
  - `ctx.app.version`이 번들에 새겨진 예상 버전과 같은지
  - env 마커 `OWN_OPEN_CODE=1`이 있는지

  하나라도 어긋나면 **slot(provider)도 훅도 등록하지 않습니다.** RPC `health`만 등록해서 `skew` 또는 `unmanaged`를 보고합니다. provider를 등록하고 훅만 빼면 관리되지 않는 인스턴스가 인증 없는 요청을 보내게 됩니다. 그래서 아예 own 모델이 없는 상태(`ModelUnavailableError`, `runner/model.ts:98-102`)로 보이게 실패시킵니다.
- **가드 2 (UI).** own-web은 `own.accounts` RPC가 없거나 `health`가 비정상이면 전체 화면 배너를 띄웁니다. 문구는 "관리되지 않는 서비스 인스턴스 — own restart 필요"입니다. 데스크톱에서는 서비스와 설치 버전의 스큐(§5.3 d)도 같은 배너로 보여 줍니다. 셸↔렌더러 rpcHash 불일치(§5.3 c)는 배너가 아니라 폴백 페이지입니다. `serviceControl` capability가 있으면 [서비스 재시작] 버튼을 둡니다(05 §5.6, §6.2).
- **가드 3 (플러그인 allowlist).** §13.2.
- **raw exe는 PATH에 두지 않습니다.** 진입점은 `own.cmd`(와 own-desktop 바로가기)뿐입니다. 셸의 `DesktopCli(own).install`(upstream IPC `installCli`)은 항상 거부합니다(§4.1).

### 5.5 버전 고정과 자동 업데이트 차단

- **자동 업데이트 차단 (이중).**
  - 전역 config에 `"update": "disable"`을 둡니다(`packages/schema/src/config.ts:38`, `packages/cli/src/services/updater.ts:109-124,436-440`).
  - launcher가 `OPENCODE_DISABLE_AUTOUPDATE=1`을 설정합니다(`updater.ts:428-435`). env가 먼저 검사되므로 이때 로그 사유는 `disabled`이고, launcher 없이 떴을 때만 `policy-disabled`가 찍힙니다.
  - **왜 끄는가(정확한 메커니즘).**
    - 업데이트 검사는 npm `@opencode/cli`와 비교하지 않습니다. `https://opencode.ai/update/api/<channel>/<artifact>/<npm|homebrew>?current=<version>`을 호출합니다(`updater.ts:235-245`). 우리 빌드라면 `…/own/cli/npm?current=2.0.18-own.N`입니다.
    - 설치하려면 감지된 설치 방식이 있어야 합니다: npm/pnpm/bun 전역, `~/.opencode/bin`, brew, 또는 실행 파일 옆 `@opencode/cli` manifest(`updater.ts:131-143`). `%LOCALAPPDATA%\own-open-code\app\…`의 바이너리는 어느 것에도 해당하지 않으므로 결과는 `update skipped: installation method not found`입니다(`updater.ts:457-461`).
    - 그래도 끄는 이유는 두 가지입니다.
      - 기본 정책이 `notify`라서(`updater.ts:151`) 켜 두면 fork의 채널과 버전을 opencode.ai로 보내는 네트워크 호출이 생깁니다.
      - upstream이 채널 매핑이나 설치 방식 감지를 바꿀 때 생길 수 있는 의외의 동작을 원천 차단합니다.
  - **셸 업데이터도 끕니다.** `UPDATER_ENABLED=false`로 치환하고 builder 설정에 `publish:null`을 둡니다. upstream 업데이트 URL은 beta·prod 채널에만 설정되고, PoC 빌드에는 `app-update.yml`이 생기지 않았습니다 `[desktop-build §1, §2]`.
- **플러그인 업데이트.** 우리 플러그인과 claude-auth 번들은 **디렉터리 경로**로 설정하므로 npm의 24시간 업데이트 검사 대상이 아닙니다(`packages/core/src/plugin/supervisor.ts:212`, `packages/util/src/npm.ts:61-83`).
- **버전 전환 절차** (구현: `own.ps1 install|update`, 데스크톱 설치 파일이 payload로 부른다. 다른 문서의 "install.ps1"은 이것이다. 사용자 절차는 USER-GUIDE 2장)
  1. 실행 중인 세션을 확인하고 사용자에게 확인받습니다. 연결된 원격 호스트의 실행 중 세션과 브로커 `proto` 호환도 확인합니다(04 §5.7).
  2. `service stop`
  3. `opencode-own.db`를 백업합니다. upstream DB 마이그레이션은 되돌릴 수 없다고 가정합니다.
  4. 버전 포인터 `app\current.json`을 새 버전으로 씁니다(temp → fsync → rename). 렌더러(`web\`)도 함께 바뀝니다. `opencode.jsonc`의 own 플러그인 항목(own-accounts, own-remote, own-telemetry)은 새 버전 폴더(`app/<ver>/plugins/<name>`)로 고칩니다. 그 밖의 항목·주석·서식은 그대로입니다.
  5. `service start`
  6. health를 확인합니다. 셸의 rpcHash가 새 `manifest.json`과 다르면 셸 재설치가 필요하다고 알립니다. 셸 설치를 install.ps1이 함께 맡을지는 §20에 있습니다.
  7. **열려 있는 데스크톱 렌더러 창을 모두 다시 로드합니다.** 렌더러는 `oc://renderer`가 페이지 로드마다 포인터가 가리키는 `app\<version>\web`을 루트로 고르므로(own-desktop `renderer-protocol.ts`, 예전에는 junction을 통해 요청마다 읽음)(`packages/desktop/src/main/windows/protocol.ts:52-83`), 옛 렌더러가 교체 뒤에 lazy chunk(PF5의 터미널·리뷰·브라우저·설정)를 부르면 해시 이름 파일이 없어 실패합니다. 규칙(05 §5.5와 같음):
     - own-web은 재연결 때 `GET /api/info`의 version이 자기 빌드 version과 다르면 초안을 저장하고 창을 다시 로드합니다. lazy chunk 로드가 실패해도 같은 동작을 제안합니다.
     - 다시 로드한 렌더러는 T0에서 자기 rpcHash와 셸의 `window.own.shell.rpcHash`를 비교합니다. 다르면 IPC를 부르지 않고 "셸 재설치 필요"를 보입니다(셸의 1차 검사는 시작 때만 돌기 때문, 05 §5.5).
  8. 실패하면 포인터, 플러그인 항목, DB를 이전 상태로 되돌립니다.
- 서비스가 떠 있는 동안 포인터나 플러그인 항목을 바꾸면 플러그인 hot reload 때문에 바이너리와 플러그인 버전이 어긋납니다. 그래서 launcher는 서비스를 멈춘 뒤에만 플러그인 항목을 고치고(`own start`는 새로 띄울 때만), 가드 1이 나머지를 막습니다(fail closed).
- **junction을 쓰지 않는 이유(2.0.18-own.3).** launcher 0.3.0까지는 `app\current`가 버전 폴더를 가리키는 junction이었습니다. 2.0.18-own.2를 설치한 PC(Windows 11 26200)에서 그 junction을 통해서는 파일을 열 수 없었고(`cmd /c dir`, Node, Bun, Electron 모두 실패. 속성 조회는 되므로 PowerShell `Test-Path`는 True), Temp 아래 junction은 됐습니다. 원인은 Windows가 아니라 **설치를 실행한 위치**였습니다: Claude 데스크톱 앱(MSIX 패키지 `Claude_pzs8sxrjxfjjc`, `FileSystemWriteVirtualization`)의 터미널·에이전트에서 설치 파일을 돌리면, 그 프로세스들이 `%LOCALAPPDATA%`에 새로 쓰는 파일은 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\…`로 옮겨지고 그 앱의 프로세스에게만 보입니다(`%TEMP%`는 가상화 대상이 아님). 그래서 OWN_HOME 전체가 그 앱의 사본에만 생겼고(탐색기·시작 메뉴 앱·일반 터미널에서는 없음 → 앱의 `설치되지 않았습니다`, "설치 훅이 안 돌았다"), 그 안에서 만든 junction은 실제로는 없는 경로를 가리켰습니다. 앱 밖(일반 프로세스)에서는 `%LOCALAPPDATA%` 아래 junction도 정상입니다(WMI로 띄운 프로세스에서 확인). 대책 두 가지: (1) 설치 레이아웃은 링크를 하나도 쓰지 않습니다(포인터 파일. 이전 설치의 junction은 링크 자체에서 대상만 읽고 다음 전환 때 링크만 지움. 포인터 이전 버전으로 되돌릴 때만 그 버전의 플러그인이 쓰도록 `app\current` junction을 다시 둠). (2) launcher가 자기 쓰기가 패키지 앱 사본으로 옮겨지는지 탐침 폴더로 확인하고(약 100 ms, 한 실행에 한 번), 그렇다면 install/update/rollback/uninstall/restart/tui/run과, open/start 중 서비스를 새로 띄우거나 바꿀 때(서비스가 없을 때, 모드나 버전이 달라 다시 띄울 때)를 종료 코드 5로 거부합니다. 건강한 서비스를 그대로 다시 쓰는 open/start는 OWN_HOME에 아무것도 쓰지 않으므로 검사 없이 통과합니다(종료 코드 0). 설치 파일은 파일을 풀기 전(customInit)에 알리고 끝냅니다. 검증: `own/scripts/test/install.test.mjs`의 `OWN_REAL_LOCALAPPDATA=1` 테스트(실제 `%LOCALAPPDATA%`, Claude 앱 안과 밖 양쪽).

### 5.6 중지와 재시작의 성질

- **Windows의 stop은 TerminateProcess입니다.** finalizer가 실행되지 않습니다(`packages/client/src/effect/service.ts:146-154,289-304`). 싱글턴 참조 카운트도 정리되지 않습니다. 그래서 vault·레지스트리 쓰기는 항상 temp→fsync→rename이고, lease 파일은 pid·만료 시각으로 stale 판정합니다(02 §3.5 F3).
- 진행 중이던 턴은 다음 부팅 때 write-ahead claim으로 재개되지만, exactly-once는 아닙니다(`packages/server/src/process.ts:237-239`). 그래서 provider 요청이 다시 나가고 캐시는 cold가 됩니다.
- 따라서 launcher와 UI는 "재시작 중"과 "재개됨" 상태를 보여 주고, 실행 중인 세션이 있으면 stop 전에 확인을 받습니다.
- own-desktop 종료, 창 닫기, 셸 크래시는 서비스와 무관합니다. 다시 열면 discover로 붙습니다(§5.3 b).

---

## 6. 프런트엔드 서빙과 인증

### 6.1 모드별 서빙과 인증

| 모드 | 서빙 | 인증 | 비고 |
|---|---|---|---|
| **데스크톱(기본)** | own-desktop 렌더러가 `oc://renderer/index.html`에서 뜹니다.<br>- 파일: `OWN_HOME\app\<version>\web`. vendor한 `index.ts`가 먼저 등록합니다(first-wins, §4.1). 없으면 셸 번들의 폴백 페이지<br>- API: `awaitInitialization()`이 준 절대 `baseUrl`(`http://127.0.0.1:<port>`)로 부름 | main이 Basic을 붙이는 조건은 셋입니다.<br>- 요청 origin이 서비스 origin과 **정확히 같음**(`packages/desktop/src/main/service/sidecar-credentials.ts:26-31`)<br>- 렌더러의 top frame 요청(`main/windows/security.ts:34-55`)<br>- 요청에 Authorization이 아직 없음<br><br>web view, 임베드 페이지, 프레임 없는 요청(워커·서비스 워커)에는 붙이지 않습니다. 쿠키와 pairing은 쓰지 않습니다.<br><br>**CORS**: main이 렌더러 session의 **모든** 응답에 `Access-Control-Allow-Origin: *`(와 서버가 보내지 않았으면 `Allow-Headers: *, authorization`, `Max-Age: 7200`)를 덮어씁니다. 서버의 CORS 정책과 무관하게, 렌더러가 닿는 모든 origin에 적용됩니다(`main/windows/security.ts:54-58`, `main/windows/headers.ts:10-20`). 서버 `cors.ts:15`의 `oc://renderer` 허용은 데스크톱에서는 쓰이지 않습니다 | - 렌더러는 비밀번호를 모릅니다(`sidecar-credentials.ts:20-23`는 `{url}`만 줌).<br>- **워커에서 API를 부르지 않습니다**(인증이 붙지 않음).<br>- PTY WebSocket은 URL 패턴 밖이라 Basic이 붙지 않으므로 ticket 흐름을 씁니다: `POST …/connect-token`으로 ticket을 받고(`packages/server/src/handlers/pty.ts:118-139`), `?ticket=`으로 연결합니다(`:143-156`). ticket은 `packages/core/src/pty/ticket.ts`, 클라이언트는 `packages/client/src/solid/pty.ts`, 인증 미들웨어의 건너뛰기는 `packages/server/src/middleware/authorization.ts:81-84`입니다.<br>- 라우팅: 메모리/해시 라우터(§6.2) |
| **웹 폴백** | own-web 빌드를 CLI 바이너리에 임베드합니다(**P-001/P-002**, §12). WebUi 핸들러가 `/api`·`/auth`·`/openapi.json` 밖의 경로를 인증 전에 SPA로 서빙합니다(`packages/cli/src/services/web-ui.ts:7-55`). | launcher가 만든 pairing 링크 → `HttpOnly; SameSite=Lax` 30일 쿠키 `opencode_session_<port>`. same-origin에서만 받아들여집니다(`packages/server/src/middleware/authorization.ts:63-70`). | - `?auth_token=`은 쓰지 않습니다. 브라우저 기록과 로그에 남기 때문입니다.<br>- 브라우저 패인이 없습니다(§10.1). |
| **개발** | own-web Vite dev server(`http://localhost:<vite>`) → local 채널 서비스. 데스크톱 개발은 `ELECTRON_RENDERER_URL`을 이 주소로 둡니다 | 웹: `Authorization: Basic base64("opencode:"+devPassword)`. 기본 CORS가 localhost를 허용합니다(`packages/server/src/cors.ts:11-20`). 데스크톱: main 주입 | SSE는 fetch 스트리밍으로 받습니다(`EventSource`는 헤더를 보낼 수 없음). |
| **원격(SSH, 04)** | 원격 service + `ssh -L`. 주소는 호스트별 loopback `127.0.<k>.2`입니다 | own-remote가 원격 서비스 비밀번호로 서명한 짧은 수명 세션 토큰 → `own.remote.resolve` → 렌더러가 Authorization 헤더를 직접 붙입니다(04 §12.1). 데스크톱 main은 로컬 비밀번호를 로컬 서비스 origin에만 붙이므로 원격 주소로 새지 않습니다.<br><br>**브라우저 패인 예외**: 원격 세션의 패인은 main이 Node HTTP로 원격 plugin-browser에 attach하므로, own-web이 원격 토큰을 main에 넘깁니다(§10.1 "원격 세션 패인의 자격 증명") | - 쿠키는 cross-origin에서 받아들여지지 않으므로 토큰 방식을 씁니다.<br>- 데스크톱의 CORS는 main의 응답 헤더 덮어쓰기로 통과합니다(위 데스크톱 행). 웹 폴백은 origin이 `http://127.0.0.1:<P>`이고 원격 서버 기본 CORS가 이를 허용합니다(`packages/server/src/cors.ts:13-14`).<br>- 데스크톱은 쿠키를 쓰지 않으므로 04 §7.3·§12.1의 쿠키 누출 논거는 웹 폴백에만 해당합니다.<br>- 원격 끝점을 `127.0.0.1`에 두지 않는 04 규칙은 모드와 관계없이 유지합니다. |
| **원격 기기(모바일, P8)** | 휴대폰 브라우저·PWA → `tailscale serve` → 게이트웨이. 게이트웨이가 `app\<version>\web`을 같은 origin으로 서빙합니다(05 §13.4, §13.9 M1). Capacitor 앱(M3)은 번들을 앱 안에 싣습니다 | 기기별 토큰(PWA는 HttpOnly 쿠키, 앱은 Bearer). 게이트웨이가 service에 Basic을 붙여 중계합니다. 서비스 비밀번호와 원격 토큰은 기기에 가지 않습니다 | 서비스는 계속 127.0.0.1 전용입니다. 상세는 05 §13 |

**CSP 제약.** 웹 폴백의 CSP는 `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'`이고 `worker-src`가 없습니다(`packages/cli/src/services/web-ui.ts:61-63`). 인라인 스크립트는 `id="oc-theme-preload-script"`인 것 하나만 해시로 허용되고, 자산 디렉터리는 `_assets`여야 합니다(`web-ui.ts:61-70`, `packages/app/vite.config.ts:41`). own-web 빌드는 이 계약을 지킵니다. 데스크톱 렌더러와 웹 폴백은 **같은 빌드**를 씁니다(라우팅 차이는 §6.2). 데스크톱의 `oc://renderer` 응답에는 CSP가 없으므로(`main/windows/protocol.ts`의 `addDocumentPolicy`는 Document-Policy만 붙임) 웹 폴백에서만 깨지는 코드가 생기기 쉽습니다. 그래서 다음을 빌드 규칙으로 둡니다.
- **워커는 같은 origin의 별도 파일로만 만듭니다.** `new Worker(new URL("./x.worker.ts", import.meta.url), {type:"module"})`처럼 써서 Vite가 `_assets`에 파일로 내보내게 합니다. `blob:`·인라인 워커는 `worker-src`가 `script-src 'self'`로 떨어지므로 웹 폴백에서 막힙니다. 마크다운·shiki·diff 워커(PF4)가 모두 대상입니다. shiki의 wasm은 `'wasm-unsafe-eval'`이 허용합니다.
- 서비스 워커는 쓰지 않습니다(stale 캐시 방지, 그리고 데스크톱에서 프레임 없는 요청은 인증이 붙지 않음). 예외는 P8 게이트웨이 origin의 PWA뿐입니다(05 §13.6).
- G11은 웹 폴백의 CSP 위반 0을 이 규칙으로 확인합니다.

### 6.2 OwnHost 계약 (own-web ↔ 셸)

**인터페이스(`OwnHost`, `HostCapabilities`, `HostConnection`), capability 이름과 모드별 값, T0 호출 순서는 05 §6.2–§6.3이 기준입니다.** 03(§16.7)과 이 문서는 그 이름을 그대로 씁니다(예: `nativeDirectoryPicker`, `nativeFilePaths`, `clipboardImage`, `openInApp`, `osNotifications`, `browserPane`, `serviceControl`, `windowControlsOverlay`, `keepScreenAwake`). 이 문서가 정하는 것은 다음 규칙뿐입니다.

- **백엔드 우선.** 셸 capability는 기기에 묶인 기능만 드러냅니다. 같은 결과를 서버 API로 얻을 수 있으면 capability를 만들지 않습니다(§3.2).
- **UI는 `kind`가 아니라 capability로 게이트합니다.** `kind` 비교는 `src/host/` 안에서만 허용하고 lint로 막습니다(05 §6.2).
- own-web에서 `@opencode/desktop`을 import하는 곳은 `src/host/desktop.ts` 하나뿐이고, `window.electron`이 있을 때만 dynamic import합니다(05 §6.6). 03 §16.1의 import 규칙은 이 예외를 둡니다.
- **라우팅과 창 bootstrap (같은 빌드를 두 모드에서 쓰기 위한 계약).**
  - 데스크톱의 `oc://renderer` 핸들러는 파일만 서빙하고 SPA 폴백이 없습니다(`packages/desktop/src/main/windows/protocol.ts:52-83`). 창은 항상 `index.html`로 열립니다(`main/windows/early.ts:87`, `main/windows/index.ts:143`). 그래서 path 라우터로 `pushState`한 뒤 다시 로드하거나 창을 복원하면 404가 됩니다. upstream 렌더러도 창마다 `windowID`를 키로 하는 메모리 라우터를 씁니다(`packages/desktop/src/renderer/desktop-app.tsx:32,73`).
  - 규칙: **데스크톱 모드의 own-web은 메모리 라우터(또는 해시 라우터)를 쓰고, 진입점은 `index.html` 하나입니다.** 창별 라우트와 상태는 `window.electron.windowID`·`bootstrap`(preload, `packages/desktop/src/preload/index.ts:24-29`)을 키로 own 저장소(localStorage)에 두었다가 복원합니다.
  - 웹 폴백은 path 라우팅을 그대로 씁니다. WebUi 핸들러가 `/api`·`/auth` 밖 경로에 SPA 폴백을 줍니다(`packages/cli/src/services/web-ui.ts:7-55`).
  - 라우트 이름(예: `/srv/<serverKey>/s/<sessionID>`, 05 §7.4)은 두 모드에서 같고, 라우터 구현만 host가 고릅니다.
  - 확인: G-D6(창 다시 로드·복원 뒤 404 없음)와 G11.
- **Windows 창 테두리**(WCO 밴드)는 05 §7.1이 기준입니다.

### 6.3 데이터 경로

- **연결**: `OpenCode.make` → `createClientConnection` → `createData`. upstream app의 배선과 같습니다(`packages/app/src/runtime/server/runtime.tsx:137-159`). 서버마다(로컬, 원격 호스트) 하나씩 둡니다(04 §12).
- **이벤트**: `/api/event`는 휘발성입니다. 연결당 4096 프레임 큐이고, 끊긴 동안의 이벤트는 유실됩니다(`packages/server/src/event-feed.ts:8,64-68`). 그래서 `server.connected`를 받을 때마다 다시 조회합니다. 대상은 다음과 같습니다.
  - active 세션, pending permission/form
  - 열린 세션의 messages/inbox
  - 02 §9.1의 재동기화 목록: `accounts.list`, `quota.snapshot`, 보이는 세션의 `session.binding`, 열린 세션의 `cache.state`·`switch.state`
- **계정·한도 데이터**: RPC `POST /api/rpc/own.accounts/<method>`와 `rpc.own.accounts.<event>` 이벤트를 씁니다(`packages/protocol/src/groups/rpc.ts:12-30`, `packages/core/src/rpc.ts:91-103`). location 규칙은 §15입니다.
- **세션 목록 캐시(PF1).** 렌더러는 서버별 마지막 세션 인덱스를 로컬에 두고, 서비스에 연결하기 전에 먼저 그립니다. 연결 뒤 재동기화 결과로 덮어씁니다.
  - 넣는 것: 제목, 시각, 계정 칩, 상태, 프로젝트. 메시지 본문과 비밀은 넣지 않습니다.
  - 저장소: 렌더러 **localStorage**(05 T0-2, 03 §16.7 `host.storage`). 첫 페인트 전에 동기로 읽을 수 있어야 1초 예산 안에 그릴 수 있기 때문입니다. 크기가 커지는 초안 이미지 같은 것만 IndexedDB에 둡니다. 데스크톱은 셸 userData 안, 웹은 브라우저 프로필 안입니다.
  - 캐시가 없거나 깨져도 정상 동작합니다.

### 6.4 원격 기기(모바일) 접근의 불변식 (P8, 결정 D3)

지금은 만들지 않습니다. **구조, 페어링 흐름(SAS 승인), 범위(`read/prompt/switch/files/terminal/admin`), 토큰 수명(기본 90일, 30일 유휴 만료), `own.remote` 메서드(`gateway.*`, `devices.*`, `feed.*`), 앱 형태(M1 PWA → M2 Web Push → M3 Capacitor)는 05 §13.3–§13.9가 기준입니다.** 이 문서는 어떤 메커니즘이든 지켜야 하는 불변식만 둡니다.

1. **서비스는 계속 `127.0.0.1` 전용입니다.** `service set hostname 0.0.0.0`은 금지입니다(§5.4). LAN 평문 노출과 공개 인터넷 노출(Funnel, 포트 포워딩)은 어떤 모드에서도 없습니다. 게이트웨이도 loopback에만 바인딩하고 LAN·`0.0.0.0` 바인딩을 거절합니다(05 MG1).
2. **원격 기기가 닿는 끝점은 게이트웨이 하나입니다.** 게이트웨이는 own-remote가 own-runtime의 프로세스 수명 런타임에 여는 loopback 리스너입니다(05 §13.4). 셸(Electron main)에 두지 않습니다. 셸이 꺼져 있어도 붙어야 하기 때문입니다. 서버 코드는 고치지 않습니다(zero-patch).
3. **기기 토큰은 기기별이고, 해시만 저장하고, 기기 하나를 즉시 폐기할 수 있어야 합니다.** upstream 세션 토큰(`<만료>.<HMAC>`, 키는 서비스 비밀번호에서 나옴, `packages/server/src/auth.ts:16,39-66`)은 기기에 주지 않습니다. 기기 하나만 폐기할 수 없기 때문입니다. 게이트웨이는 upstream `/api/pair`를 항상 막습니다(05 §13.4).
4. **서비스 비밀번호, 원격(SSH) 토큰, provider 비밀은 기기에 가지 않습니다.** 원격 세션도 PC를 거칩니다(결정 D8). 게이트웨이가 `/srv/<hostId>/…`를 own-remote 터널 주소(`127.0.<k>.2`)로 중계하고 원격 토큰을 붙입니다.
5. **게이트웨이가 서비스로 중계할 때의 헤더(PTY 포함).**
   - 들어온 `Authorization`, `Cookie`, `Origin`, `Referer`를 지우고 서비스 Basic을 넣습니다(05 §13.4).
   - `Origin`을 지우는 이유: PTY ticket 발급과 연결은 `isAllowedRequestOrigin`으로 origin을 검사합니다(`packages/server/src/handlers/pty.ts:125,155`, `persistent-pty.ts:101,114`). 프록시가 `Host`를 서비스 주소로 바꿔 보내면 `sameHost`가 맞지 않고, `capacitor://`나 tailnet `https://` origin은 기본 허용 목록에도 없어 거부됩니다. Origin이 없으면 통과합니다(`packages/server/src/cors.ts:22-25`).
   - 서비스 config의 `cors` 목록에 게이트웨이 origin을 **더하지 않습니다.** 더하면 그 origin의 모든 브라우저 페이지에 서비스 CORS가 열립니다. 인증과 origin 검사는 게이트웨이가 이미 끝냈습니다(05 §13.5 CSRF 규칙).
   - 서비스 비밀번호는 등록 파일 `service-own.json`에서 읽습니다(같은 사용자). 플러그인 API에는 이 값을 얻는 방법이 없기 때문입니다. 메모리에만 두고 로그에 남기지 않습니다. 서비스가 재시작되면 비밀번호가 바뀔 수 있으므로 서비스가 401을 주거나 등록 파일이 바뀌면 다시 읽습니다. 게이트웨이는 서비스 안에서 돌므로 서비스 재시작과 함께 다시 뜹니다.
6. **UI 준비.** own-web은 반응형(03 §4.2)과 터치 조작을 지금부터 지키고, 셸 전용 기능은 capability로만 드러냅니다(§6.2).

### 6.5 알림 이벤트 피드 (푸시 대비, 결정 D3)

- **알림 대상은 클라이언트가 아니라 서버 이벤트로 판정합니다.** 피드 항목의 종류, 저장(`OWN_HOME\feed\`, 기기별 커서), 읽기 메서드(`own.remote feed.list/ack`), 전달 순서(Web Push/VAPID 먼저, FCM/APNs 중계는 M3)는 05 §13.6이 기준입니다.
- own-web은 이 피드를 `NotificationFeed` 어댑터 하나로 받습니다. 데스크톱은 시스템 알림, 웹은 창이 열려 있을 때 HTML5 알림, 모바일은 푸시입니다.
- 불변식: 푸시 payload와 중계에는 id와 종류만 넣습니다(선택적으로 세션 제목). 모델 출력, 프롬프트, 경로, 계정 이메일, 비밀은 넣지 않습니다. 알림 동작으로 승인하거나 보내지 않습니다(05 §7.4).
- 읽음 상태 동기화는 upstream `session.view`/`time.viewed`를 씁니다(`[gap]` 37, 후속).

### 6.6 성능 아키텍처 (결정 D4)

**예산 수치와 릴리스 게이트는 이 절이 기준입니다.** 화면 쪽 구현 규칙은 03 §20.2, 셸 쪽 규칙과 DP1–DP6은 05 §9가 기준입니다. 03 §20.1의 B1–B10과 05 §9.1의 셸 예산은 같은 목표를 화면·셸 쪽에서 잰 것이고, 정의나 수치가 이 표와 다르면 이 표를 따릅니다. 기준 기계는 이 PC(Windows 11 26200)입니다.

| ID | 예산 | 측정 | 구조적 수단 |
|---|---|---|---|
| **PF1** | 데스크톱 셸 프로세스 시작부터 **1초 안에** 세션 목록이 보임(캐시). 서비스가 준비되면 새 목록으로 바꿈. **정의(확정)**: 시작 = 셸 main 번들 첫 줄의 시각(`own:shell-start`, 05 T0-6), 끝 = `own:sessions-visible`(행이 들어온 뒤 rAF 2번이고 첫 contentful paint가 화면에 표시된 뒤, 03 §20.3), 판정 = warm 실행 p95 ≤ 1,000ms. exe spawn부터의 시간은 함께 기록하되 판정하지 않습니다(Windows 프로세스 생성·검사가 들어가 한 번에 수백 ms 흔들림) | `packages/own-desktop/scripts/perf-shell.ts`(05 §9.4): 격리 홈에 등록한 서비스, 패키지 exe에 `--remote-debugging-port`로 CDP 연결, warm 5–10회·cold 3회, 부팅 분해(paint timing, long animation frame), 선택적 Chromium startup trace. upstream `bench-startup.ts`는 참고만 합니다 | 창을 먼저 띄우는 upstream 순서 유지(`main/index.ts:15-31`), 세션 목록 캐시(§6.3, 진입 모듈에서 먼저 읽음), 첫 렌더에 필요한 코드는 한 chunk와 데스크톱 chunk modulepreload(05 R-D12), 첫 렌더 경로에 main 동기 호출 없음, CPU raster(05 R-D13), 무거운 패널 lazy |
| **PF2** | **입력 처리 지연** p95 ≤ 16ms(한글 IME 조합 포함). 그리고 **이벤트→페인트** p95 ≤ 33ms(60Hz 두 프레임) | 대상: composer의 모든 keydown·beforeinput·compositionstart/update/end·input.<br>- 분모: own 리스너가 이 이벤트를 **모두** 셉니다(Event Timing은 16ms 이상 표본만 내므로 p95의 분모가 되지 못함).<br>- 처리 지연 = `processingEnd − startTime`(입력 지연 + 처리). Event Timing 표본이 없는 이벤트는 16ms 미만으로 셉니다. `durationThreshold`는 최소값 16을 씁니다.<br>- 이벤트→페인트 = Event Timing `duration`(8ms 단위 반올림). 60Hz에서는 일이 없어도 16–24ms가 나오므로 16ms 기준으로 쓰지 않습니다.<br>- 유휴, 스트리밍 중, 시작 뒤 90초 각각 | composer는 로컬 신호만 갱신. 입력 경로에 동기 IPC·네트워크·큰 JSON 파싱 없음. IME 규칙(03 §12) |
| **PF3** | 메시지 2,000개와 도구 카드가 많은 세션에서 스크롤 60fps: **표시된 프레임** 간격 p95 ≤ 16.7ms, 50ms 넘는 long task 0 | CDP trace(`Tracing` 도메인)의 프레임 이벤트(표시·누락 프레임)로 잽니다. rAF 간격은 main 스레드 콜백 진단일 뿐 표시된 프레임이 아니므로(`packages/app/e2e/performance/README.md:79`) 보조 지표로만 기록합니다 | 가상 스크롤, 정규화 store(메시지·part id 단위), 카드 높이 추정과 측정 캐시 |
| **PF4** | 스트리밍 중에도 PF2와 PF3 유지 | upstream streaming 시나리오(기본 delta 160개) + 동시 입력·스크롤 | SSE 이벤트 합치기(`flushInterval:16`, 03 §16.3), rAF 단위 반영, 마크다운·shiki·diff는 워커, 스트리밍 답변은 바뀐 블록만 다시 분석·렌더(아래 렌더러 규칙), 실행 중 표시에 끝없는 애니메이션 없음 |
| **PF5** | 첫 번들(렌더러 초기 JS) 상한. 초기값 gzip 400KB ⚠. 측정 뒤 조정 | 빌드 산출물 크기 검사 | lazy chunk로 분리: 터미널(ghostty-web), 리뷰·diff(pierre), 브라우저 패인, mermaid·katex, 설정 화면 |
| **PF6** | 시작 경합: 실행 뒤 90초 동안 입력 처리 지연(PF2 정의) 50ms 초과 0 | `bench-startup` 어댑터 실행 안에서 PF2와 같은 리스너·Event Timing + long task(§16.3) | 비필수 작업을 첫 입력 가능 시점 뒤로 미룸. 예: 카탈로그 재조회, 진단, 숨은 서버 재동기화 |
| **PF7** | 캐시된 세션으로 전환할 때 내용 표시 ≤ 100ms ⚠ | upstream session-tab-switch 벤치 | 타임라인 LRU(03 §20.2) |
| **PF8** | 숨은 창·유휴 상태에서 주기 타이머 0(카운트다운 1분 제외), 렌더러 CPU ≈ 0 | 성능 카운터 | always-on 폴링 금지. 숨어 있으면 무효화만 모아 두고 보일 때 반영 |

- **서비스 쪽 규칙**
  - 첫 화면은 목록·요약 API로만 그립니다.
  - 세션 본문은 열 때만 가져옵니다(`initialMessageLimit` 30, 03 §16.3).
  - 한도·캐시 값은 이벤트로 갱신합니다.
- **셸 쪽 규칙**
  - preload는 최소로 둡니다. upstream preload를 그대로 쓰고, own 확장은 함수 몇 개뿐입니다.
  - main에서 무거운 동기 작업을 하지 않습니다.
  - IPC 이벤트는 합쳐서 보냅니다.
- **렌더러 규칙**
  - 워커는 API를 부르지 않습니다(§6.1).
  - 워커는 같은 origin의 별도 파일로만 만듭니다. `blob:`·인라인 워커는 웹 폴백 CSP에서 막힙니다(§6.1 CSP 제약).
  - 스트리밍 delta는 rAF마다 한 번 반영합니다.
  - **스트리밍 중인 답변은 바뀐 블록만 다시 그립니다**(SR, 2026-10-20). 전에는 갱신마다 워커가 답변 전체를 다시 분석해 모든 블록을 돌려주고, 메인 스레드가 모든 블록을 훑고 답변 전체를 세 번 뒤졌으며, 마지막 블록을 단어마다 span으로 다시 만들었습니다. 보이는 세션 하나의 스트리밍만으로 렌더러 메인 스레드가 63–78 % 바빴습니다(`own/reports/ui-perf-many-sessions-2026-10.md`). 지금 규칙은 다음과 같습니다. own-web이 session-ui의 `markdown.tsx`와 워커 클라이언트를 빌드 때 바꿔 끼웁니다(`own/ledger/vendored.yaml`, 코어 패치 없음).
    - 워커는 이미 나눈 블록을 들고 있다가 마지막 안정 블록 경계 뒤의 꼬리만 다시 분석하고, 처음 바뀐 블록부터 돌려줍니다(`src/markdown/tail.ts`).
    - 바뀐 블록만 렌더하고, DOM에는 블록 순서대로 애니메이션 프레임마다 한 번만 씁니다. 끝난 블록은 마지막 모습으로 한 번 그린 뒤 건드리지 않습니다(블록 번호·모드·내용 해시로 확인, `src/markdown/stream.ts`).
    - 마지막(살아 있는) 블록은 제자리에서 고치고, 새로 온 글만 흐리게 나타냅니다. 단어마다 span을 만들지 않습니다(`src/markdown/morph.ts`).
    - 스트리밍 중에는 블록들을 `display: contents` 감싸개 하나에 넣어 둡니다. upstream의 `> [data-markdown-block]:last-child > *:last-child` 규칙 때문에 새 블록이 생길 때마다 Blink가 답변 하위 트리를 다시 계산했기 때문입니다. 첫·마지막 블록 표시(`data-markdown-first`/`-last`)로 같은 여백을 주고, 끝나면 블록을 감싸개 밖으로 꺼냅니다.
    - 스트림이 끝난 답변은 한 번에 그린 답변과 DOM이 같아야 합니다. 끝날 때 한 번 전체 분석과 대조하고, 블록을 넘어 열린 HTML 요소가 있는 답변은 한 블록으로 그립니다. 단위 시험(`src/markdown/*.test.ts`)과 Edge e2e(`e2e/transcript.spec.ts`)가 코드 블록·목록·표·한국어로 확인합니다.
    - 효과(데스크톱 셸, 세션 5개·20개, main과 번갈아 2번씩 잰 중앙값, `own/handoff/decisions-2026-10.md` SR): 키 입력이 16 ms 넘게 걸려 화면에 나온 비율 90 %→7 %, 91 %→15 %, 키→화면 p95 32→20 ms, 36→24 ms. 보이는 답변을 따라가는 6초 동안 렌더러 메인 스레드가 일한 시간(CDP trace) 51 %→22 %, 70 %→26 %, 셸 전체 CPU 157 %→101 %, 161 %→107 %.
  - **루트 요소(`:root`, `html`)에는 `:has()`를 걸지 않습니다.** Blink는 DOM 삽입마다 루트의 `:has()`를 확인하고, 모든 `:has()` 규칙의 대상 특징을 합친 무효화 집합으로 문서 전체를 다시 계산합니다. 속성은 이름으로 맞춥니다. 데스크톱 셸의 `:root:has(dialog[open]) … [data-testid="sidebar-band"]` 하나가 스트리밍 블록마다 `data-testid`를 가진 요소 약 800개(13–30 ms, 초당 약 9번)를, @opencode/ui의 tabs.css가 실린 뒤에는 `data-slot`을 가진 요소 약 550개(35 ms)를 다시 계산하게 했습니다. 이제 열린 대화상자는 `<html>`의 `data-wco-modal`로 비춥니다(`src/shell/titlebar-band.ts`). `src/styles/invalidation.test.ts`가 지킵니다.
  - **스트리밍 코드 블록은 복사 단추를 한 번만 만듭니다.** `data-slot`이 있는 요소를 넣으면 @opencode/ui의 `:has([data-slot=…])` 규칙이 확인되어서, 끝난 코드 블록은 같은 감싸개 안에서 `pre`만 바꿉니다.
  - **실행 중 표시에는 끝없는 애니메이션을 쓰지 않습니다.** 끝없는 맥동·회전은 무엇이 도는 동안 합성기가 화면을 디스플레이 주사율로 계속 다시 그리게 해서 키 입력이 늦게 보입니다(03 §7.6).
  - 셸 main의 브라우저 연결(attachment)은 서버(엔드포인트와 자격 증명)마다 이벤트 스트림 하나를 같이 씁니다(05 §8.2).
  - 무거운 패널은 처음 열 때 로드합니다.
- **이전 앱 교훈** `[old] docs/design`
  - 스트리밍 delta마다 renderer→main IPC를 보내면 delta 1,000개에 메시지 1,001개가 나갔습니다. 200ms로 합치자 2개가 됐습니다(`electron-background-performance-65.md`).
  - 시작 90초 동안 입력 지연이 최대 495ms, long task가 최대 1,307ms였습니다. 원인은 시작 경합이었습니다(`input-and-runtime-performance-68.md`). → PF6.
  - 숨은 창의 always-on 400ms 타이머를 없앴습니다(`electron-background-performance-65.md`). → PF8.
  - 진단 수집기 자체가 CPU를 먹었습니다(`input-and-runtime-performance-68.md`). → 관측은 가볍게, 표본 수에 상한을 둡니다.
- **측정 인프라**
  - `packages/app/e2e/performance`의 `benchmark` 픽스처와 `BENCHMARK` JSON 줄 형식을 가져옵니다. 위치는 `packages/own-web/e2e/performance/`이고 vendor로 기록합니다.
  - upstream 벤치는 기계에 따라 달라지는 예산을 단언하지 않습니다(`packages/app/e2e/performance/README.md`). 우리는 위 예산을 단언으로 더해 **릴리스 게이트**로 씁니다(§16.3).
  - 결과는 `own/release/<version>/perf.json`에 남깁니다.
- **런타임 관측**
  - 렌더러에 Event Timing·long task 관측기를 수동으로 둡니다.
  - 30초 창에 표본을 최대 256개만 보관합니다. 키, 텍스트, URL은 보관하지 않습니다 `[old] input-latency-67.md`.
  - 이전 앱의 교훈대로 "디스패치 지연"과 "이벤트→페인트"를 나눠 보고, 표본 0개를 지연 0으로 읽지 않습니다. 표본은 16ms 이상 느린 이벤트만이기 때문입니다(`[old] input-latency-67.md:35-37,50-52`, `input-and-runtime-performance-68.md:9-12`). 그래서 PF2 게이트는 벤치에서 own 리스너의 전체 이벤트 수를 분모로 씁니다.
  - 결과는 진단 화면에서만 봅니다.

---

## 7. 데이터 소유권

파일 형식과 필드는 02 §2.3–§2.4가 기준입니다. 여기서는 누가 쓰고 어디에 두는지만 정합니다.

| 데이터 | 저장소 | writer | 비밀 | 비고 |
|---|---|---|---|---|
| 세션, 메시지, durable 이벤트, 프로젝트, 권한 | `opencode-own.db` (upstream 스키마) | service(core) | 아니오 | 턴의 계정 귀속은 `session.step.started.model.providerID`(= slot)로 영속됩니다(`packages/schema/src/session-event.ts:333-345`). |
| 세션의 현재 계정/모델 | 같은 DB (`SessionInfo.model`, `session.model.selected`) | core (`switchModel`) | 아니오 | 바인딩을 따로 저장하지 않습니다. 단 `SessionInfo.model`은 **optional**이므로 "고정 규칙"(§8.5)이 지켜질 때만 원본이 됩니다. model이 없는 세션은 "기본값(미고정)"이고 계정이 정해져 있지 않습니다. |
| 레지스트리(도메인, 계정, slot, 고정 모델 템플릿) | `OWN_HOME\accounts.json` | own-accounts (runtime 파일 저장소, `locks\registry.lock`) | 아니오 | `schemaVersion`, `revision`. 모르는 필드는 보존. |
| 전환 정책, auto-compaction 정책, 요율 | `policy.json`, `ratecards.json` | own-accounts | 아니오 | 사용자 변경은 RPC 경유. auto-compaction의 효과는 slot 템플릿의 유효 `limit`로 반영(§8.7 R16) |
| 프로젝트 플러그인 승인 | `trust.json` | own-accounts | 아니오 | §13.2 |
| 한도 최신 스냅샷 | `state\limits.json` | runtime(leader 인스턴스) | 아니오 | LimitWindow(02 §7.3) |
| exe 버전 판정 캐시 | `state\exe-version.json` | launcher | 아니오 | `{key: 전체 경로·크기·수정 시각 ticks, version}`. own 버전만 저장, `OWN_OPENCODE_EXE`를 쓸 때는 읽지도 쓰지도 않음. 지워도 다음 기동에서 다시 물을 뿐(§5.3) |
| 사용량, 전환·경보 이력 | `ledger\usage-YYYY-MM.jsonl`, `events-YYYY-MM.jsonl`, `rollup.json` | **runtime ledger writer 하나**(모든 플러그인 공용, 원격 관측 포함 04 §10) | 아니오 | 12개월 보존, 지난 달 gzip. 이벤트 id로 멱등 처리. 내용·토큰 값은 기록하지 않음 |
| 세션별 전환·캐시 상태 | KV `sess:<sid>:{switch, cache:<providerID>, epoch, home, strip}` | own-accounts | 아니오 | `ctx.storage`는 플러그인 id별 전역 KV이고 평문입니다(`packages/core/src/plugin/host.ts:584-611`, `packages/core/src/kv.ts:36-83`). 비밀은 넣지 않습니다. |
| 서드파티 동의 | KV `ack:claudeAuth`(2026-10-18부터 쓰지 않음), `ack:claudeRemote`, `ack:claudeFast` | own-accounts | 아니오 | 02 §8.4 |
| API 키, OAuth 토큰(access/refresh/id) | `vault\<accountId>.dpapi` (+`.prev`, `.lock`) | own-accounts → runtime vault client | **예** | DPAPI CurrentUser + entropy `"own-open-code/v1/" + accountId`(02 §2.4.5). 대체 모드(02 §3.7)에서만 DB `credential` 테이블(평문)에 두며, UI에 대체 모드임을 표시합니다. |
| Claude 구독 OAuth (슬롯) | `opencode-own.db`의 `credential` 테이블 (평문) | claude-auth / core | **예** | 서드파티 설계라서 변경할 수 없습니다. UI에서 고지합니다. 원본은 `%USERPROFILE%\.claude\.credentials.json`(평문, Claude Code 소유). |
| linked Codex 로그인 (결정 D7) | `D:\#Projects\codex-multi-provider\work\control-center\profiles\<id>\codex\auth.json` | **이전 앱**(우리는 읽기만 함) | **예** | 절대 쓰지 않고 refresh하지 않습니다. 1MiB 상한, 토큰은 메모리에만 둡니다. vault 파일이 없습니다(§8.4). 레지스트리에는 위치(`CodexSource`)만 둡니다 |
| MCP OAuth credential | `opencode-own.db`의 `credential` 테이블 (평문) | core(MCP OAuth) | **예** | upstream 동작입니다. 통합 id는 `mcp_<sha1 16자>`이고(`packages/core/src/mcp/index.ts:170-176`) own provider 비밀과 섞이지 않습니다. MCP 로그인 UI 예외는 §13 |
| 서비스 비밀번호 | 등록 파일과 두 서비스 설정 파일 (평문) | CLI, launcher | 예(로컬) | upstream 모델입니다. 같은 사용자 경계에서는 허용합니다. 데스크톱 셸은 main 메모리에만 두고 렌더러에 주지 않습니다(§6.1) |
| UI 선호(탭, 필터, 초안), 세션 목록 캐시(PF1), 창별 라우트(§6.2) | 렌더러 localStorage(세션 목록 캐시 포함, §6.3). 초안 이미지만 IndexedDB. 데스크톱은 셸 userData 안, 웹은 브라우저 프로필 안 | own-web | 아니오 | 제목 등은 들어가지만 본문과 비밀은 넣지 않습니다. 사라져도 정상 동작해야 합니다. |
| 셸 상태(창 배치, 줌, 브라우저 복원 기록) | `%APPDATA%\dev.own.opencode.desktop\` | own-desktop(upstream main의 `storage/*`) | 아니오 | upstream 설치본의 userData와 분리됩니다(§5.2) |
| 브라우저 패인의 웹 데이터 | Electron 파티션 `opencode-browser-<uuid>`. attach마다 새로 만들고 `persist:` 접두어가 없음(`packages/desktop/src/main/browser-pane.ts:84`) | Chromium(셸) | 사이트 쿠키 | 디스크에 남지 않는 것으로 봅니다 ⚠(G-D5에서 확인) |
| 원격 세션 패인의 원격 토큰 | 셸 main 메모리(attachment 수명 동안만) | own-web이 넘김 → own-desktop main | 예(서버 접근 토큰) | 저장하지 않습니다. provider 비밀은 main에 가지 않습니다(§10.1) |
| [P8] 원격 기기 토큰, 알림 피드, VAPID 키 | `OWN_HOME\devices.json`(해시만), `feed\`, `vault\push-vapid.dpapi` | own-remote(게이트웨이) | 해시 / 아니오 / 예 | 05 §13.5–§13.6 |

**원칙: slot(= 캐시 도메인)을 providerID로 인코딩하기 때문에, 어떤 계정이 어떤 턴을 실행했는지를 따로 추적하는 테이블이 필요 없습니다.** 조건은 두 가지입니다.
- (1) 세션이 명시적 model로 고정돼 있을 것(§8.5)
- (2) slot에 계정이 1개일 것

예외는 후속 단계의 도메인 내 credential 풀이며, 이때는 요청 단위 `credentialRef`를 ledger에 기록합니다(02 §7.5).

---

## 8. 계정 라우팅 백엔드 (own-accounts)

### 8.1 provider = 캐시 도메인

- **이유**
  - (1) providerID가 바뀌면 Identity 플러그인의 `system[1]`(`- Provider ID: …`)이 바뀝니다(`packages/core/src/plugin/identity.ts:13,27`).
  - (2) 다른 providerID가 만든 턴은 reasoning, 서명, item id 없이 재생됩니다(`packages/core/src/session/runner/to-llm-message.ts:154-156`). 따라서 **계정마다 providerID를 두면 같은 캐시 도메인 안에서도 prefix가 갈라집니다** `[research cache_verify critical #1]`.
  - (3) 반대로 캐시 도메인이 다른데 providerID를 하나로 두면, 다른 org의 암호화 항목이 재생되어 `organization_id` 오류가 날 위험이 있습니다.
- **MVP 규칙: 계정 1개 = slot(providerID) 1개.** 같은 도메인에 계정이 둘 이상인 경우(예: 같은 Anthropic workspace의 키 두 개)도 별도 slot입니다. 한 slot에 묶는 도메인 내 credential 풀은 후속 단계이고, kind별 교차 재생 PoC(AC-P33/34/35)가 통과해야 켭니다(02 R-ID-2).
- **ID 규칙** (02 R-ID-3을 그대로 따릅니다)
  - `own-<kind>-<slug>`. kind는 `codex|oai|anth|ds|xai|or|compat`, slug는 **4–8자 `[a-z0-9]` 난수**입니다. 사용자가 slug를 정하지 않습니다. 라벨은 `provider.name`(표시명)에만 넣습니다.
  - `/`와 `#`는 쓰지 않습니다(`packages/schema/src/model.ts:25-38`).
  - **한 번 쓴 providerID는 이름을 바꾸거나 재사용하지 않습니다.** 계정을 삭제해도 slot을 "retired" 상태로 남겨서 과거 턴의 귀속을 보존합니다. 이때 모델은 enabled=false로 둡니다.
  - `own-` 접두어는 models.dev 카탈로그 id나 config가 만드는 integration id와 겹치지 않습니다. 이 점은 Auth.none 조건에 필요합니다(§8.3, `packages/core/src/plugin/models-dev.ts:34-59`).
- **중복 등록**
  - **같은 신원만 막습니다.** Codex는 지문 `sha256(chatgpt_account_id + ":" + sub)`(02 C5), API 키는 같은 키 해시입니다. 같은 지문으로 다시 로그인하면 "재인증(기존 계정 갱신)"으로 처리합니다.
  - **캐시 도메인이 같은 다른 키는 막지 않습니다.** 별도 slot으로 등록하고 `accounts.add.key` 응답의 `sameDomainCandidates`와 경보로 알립니다(02 §3.3). "기존 계정에 키로 추가(캐시 공유)"는 `poolingVerified=true`인 도메인에서만 보입니다.
  - **추가 시점 probe.** 키를 받으면 과금이 없거나 매우 작은 호출(`GET /v1/models` 등, 02 §3.3 표)로 키를 검증하고 org/workspace 헤더를 읽습니다. 헤더 이름은 **[미확인]**입니다: `openai-organization`, `openai-project`, Anthropic의 organization 헤더와 `anthropic-workspace-id`는 로컬 소스나 1차 문서로 확인하지 못했습니다(G2/G9에서 캡처). Anthropic workspace는 첫 `/v1/messages` 응답에서야 확정될 수 있습니다.
  - **사후 발견.** 나중에 두 slot의 도메인이 같다고 밝혀지면 `accounts.json.cacheDomains`를 병합하고 경보를 냅니다. slot은 그대로 두며(providerID 불변), 후속 단계의 credential 풀로 합치는 것을 **제안만** 합니다.

### 8.2 provider와 모델 등록

- **등록 방법**
  - `ctx.provider.transform`의 `editor.add({info, models})`로 등록합니다(`packages/plugin/src/promise/provider.ts:15-28`). `add`는 `AISDKNative.rewrite`를 거치지 않으므로 package를 처음부터 native로 적습니다(02 §3.6, `packages/core/src/provider.ts:297-303`).
  - **config의 `providers`에 선언하지 않습니다.** config provider는 같은 이름의 key integration을 자동으로 만들고(`packages/core/src/config/plugin/provider.ts:23-42`), canonical clone을 통해 claude-auth의 `cost=[]`를 상속할 수 있습니다 `[research §1.3 hazard 2]`.
  - 레지스트리는 setup에서 **먼저 읽고** transform을 등록합니다. fold 안에서는 파일을 읽지 않습니다(02 §3.8).
- **모델의 출처: 고정 모델 템플릿(기본).** 계정을 만들 때 canonical provider의 source definition(`editor.get(<canonical>).models`, 비활성 provider 포함, `provider.ts:8-13`)을 **한 번 캡처**해서 `accounts.json.modelTemplates`에 고정하고, 그 뒤로는 템플릿에서 등록합니다(02 §2.4.2).
  - 복사하는 필드: `id, modelID, family, name, capabilities, variants, limit, cost, options/body`. kind 규칙(아래 표)을 적용한 뒤 저장합니다.
  - 이유: Optimize, Identity, Patch 플러그인은 `model.id/modelID/family/name`을 기준으로 동작합니다(`packages/core/src/plugin/optimize.ts:36-45`, `identity.ts:23-27`). models.dev가 갱신될 때마다 live로 복사하면 사용자 모르게 prefix가 달라져 모든 계정이 조용히 cold가 됩니다(02 AC-P25).
  - **갱신은 명시적 동작**(`accounts.update{refreshCatalog:true}`)으로만 합니다. UI는 "다음 요청에서 이 계정 캐시가 한 번 다시 쓰입니다"라고 알립니다.

| kind | providerID | package | canonical | 정적 settings / headers (비밀 아님) | 요청 시 주입 (model.request) | cost / limit |
|---|---|---|---|---|---|---|
| codex (ChatGPT 구독) | `own-codex-<slug>` | `@opencode/ai/providers/openai` | `openai` | `baseURL: https://chatgpt.com/backend-api/codex`, `transport: websocket`, `compaction: {type:"summary"}`, headers `originator: opencode`, `x-codex-beta-features: remote_compaction_v2` | `Authorization: Bearer <access>`, `chatgpt-account-id`, `session-id: <session affinity>`(자식은 부모 ID), `originator` | `cost: []`, `limit {context 400000, input 272000}`, Codex 허용 모델만, `reasoning.mode=pro` 제외 |
| oai (API) | `own-oai-<slug>` | `@opencode/ai/providers/openai` | `openai` | transport **미정**: websocket 제안(upstream openai 기본값, `openai.ts:260`). 02 §3.6 기본은 적지 않음(= HTTP). AC-P04 결과로 정함(§20 Q11). `compaction: summary` | `Authorization: Bearer <key>` (+ 선택 `OpenAI-Organization`/`OpenAI-Project`, 계정마다 고정) | 템플릿 값 |
| anth (API) | `own-anth-<slug>` | `@opencode/ai/providers/anthropic` (claude-auth 변형 이전 카탈로그) | `anthropic` | `compaction: summary` | `x-api-key: <key>` | 템플릿 값을 **명시적으로 복사** (`$0` 누수 방지) |
| ds | `own-ds-<slug>` | `@opencode/ai/providers/deepseek` (**명시 필수**. 빠지면 범용 openai-compatible로 바뀜, `packages/core/src/aisdk-native.ts:80-96`) | `deepseek` | `compaction: summary` | `Authorization: Bearer` | 템플릿 |
| xai | `own-xai-<slug>` | `@opencode/ai/providers/xai` | `xai` | `compaction: summary` | `Authorization: Bearer` | 템플릿 |
| or | `own-or-<slug>` | `@opencode/ai/providers/openrouter` | `openrouter` | `compaction: summary` | `Authorization: Bearer` (+ 선택 `HTTP-Referer`, `X-Title`, 고정값) | 템플릿 |
| compat (기타 OpenAI 호환) | `own-compat-<slug>` | `@opencode/ai/providers/openai-compatible` | (적지 않음) | `baseURL: <사용자 입력, 필수>`, `compaction: summary` | `Authorization: Bearer` | slot마다 따로 만든 템플릿. 모델 id·`limit.context`·요율은 사용자 입력(02 §3.3) |
| claude-sub (슬롯) | `anthropic` (내장, **건드리지 않음**) | — | — | — | claude-auth가 처리 | 플러그인이 `[]`로 설정 |

- 각 모델 항목의 `package`도 slot과 같은 native 값으로 적습니다(`usesAPIKeyAuth` 목록, `model-resolver.ts:423-459`).
- **Codex wiring 재현.** 내장 openai 플러그인은 모든 ChatGPT 설정을 providerID `openai`에만 적용합니다(`packages/core/src/plugin/provider/openai.ts:254-309`). 그래서 own-accounts가 같은 내용을 재현합니다.
  - 모델 필터는 upstream과 같은 규칙입니다: 허용 `gpt-5.5`, `gpt-5.3-codex-spark`, 그리고 gpt-5.4보다 높은 버전. 거부 `gpt-5.5-pro`, bare `gpt-5.6`(`openai.ts:24-25,271-297`). upstream 주석상 `gpt-5.4-mini`의 대체는 `gpt-5.6-luna`입니다(`openai.ts:23`).
  - 동기화할 때마다 `check-surface.mjs`가 이 목록이 upstream과 달라졌는지 검사합니다.
- **baseURL은 settings에 정적으로 둡니다.** 훅에서 baseURL을 바꾸면 native compaction window가 있을 때 step이 죽습니다(`packages/core/src/session/model-request.ts:279-293`).
- **내장 provider 처리**
  - 사용자가 own 계정을 가진 kind의 **내장 카탈로그 provider**(`openai`, `deepseek`, `xai`, `openrouter`)는 `activation: "disabled"`로 숨깁니다(`policy.json.hideBuiltinProviders`). 목적은 전역 credential이나 env로 조용히 과금되는 경로를 막는 것입니다. UI 필터가 아니라 서버에서 끕니다: `hideBuiltinProviders:"auto"`면 own-accounts의 provider transform이 `activation:"disabled"`로 두고, 값이 바뀌면 모든 Location이 `provider.reload()`로 반영합니다(02 §2.4.3·§3.8, 결정됨).
  - `anthropic`은 claude-auth가 감지되고 **앱의 번들로 확인된 뒤에만** 활성으로 둡니다(2026-10-18 전에는 동의가 기록된 뒤). 그 전에는 own-accounts의 transform이 `activation:"disabled"`로 둡니다(02 §8.4).

### 8.3 요청별 인증 주입

- **Auth.none 조건** (`packages/core/src/model-resolver.ts:374-380,417-459`). 모두 충족해야 합니다.
  - `provider.activation === "enabled"`
  - `integrationID ?? providerID`에 연결이 없음. own provider는 integrationID를 두지 않고, 같은 id의 integration도 없습니다(`model-resolver.ts:361-364`).
  - settings에 `apiKey/authToken/accessToken`이 없음(`model-resolver.ts:417-421`)
  - package가 `usesAPIKeyAuth` 목록에 있음. openai, anthropic, deepseek, xai, openrouter, openai-compatible이 모두 포함됩니다.
- **훅 등록 방식: setup에서 한 번, 접두어로 거름.** 계정마다 런타임에 provider-scoped 훅을 추가하면 두 문제가 생깁니다.
  - (1) 훅 목록은 등록 순서대로 뒤에 붙습니다(`packages/core/src/plugin/hooks.ts:69-86`). 런타임 등록은 그 뒤에 setup된 claude-auth·own-telemetry 훅보다 **뒤**에 붙으므로 "등록 순서 = plugins 순서"(`packages/core/src/plugin.ts:127`)가 깨집니다.
  - (2) 훅 등록은 Promise입니다(`packages/plugin/src/promise/registration.ts:15-19`). 등록이 끝나기 전에 provider reload가 먼저 반영되면 인증 없는 요청이 나갑니다.

  그래서 own-accounts는 setup에서 아래 훅을 **한 번만** 등록하고, 콜백 안에서 providerID로 거릅니다. 계정 추가·삭제는 `ctx.provider.reload()`만 부릅니다.

| 플러그인 | 훅 | 등록 | 거르기 | 동작 |
|---|---|---|---|---|
| own-accounts | `provider.transform` | setup | – | slot 등록, `anthropic` activation(동의 전 disabled), 내장 provider 숨김 |
| own-accounts | session `model.request` | setup, unscoped | `providerID`가 `own-`로 시작하고 레지스트리에 있으며, 이 Location의 플러그인 allowlist가 통과(§13.2) | 인증 헤더 주입. 매 모델 호출마다 항상 trigger되므로 unscoped여도 추가 비용이 없습니다(`model-request.ts:262`) |
| own-accounts | session `context`, `compaction`, `generate` | setup, unscoped | `own-anth-*`, 그리고 Claude/Gemini family를 쓰는 `own-or-*` | cache hint(R9, R15), strip 규칙. 세 훅에 같은 변환(02 D2) |
| own-accounts | session `http.response` | setup, unscoped, **읽기 전용** | `own-*` | 한도 헤더, 오류 헤더와 본문 앞 2KB → runtime `lastResponse[sessionID]`, 한도 저장소 |
| own-accounts | `experimental.ws.receive` | setup, unscoped, **읽기 전용** | `own-codex-*`, 부분 문자열 사전 필터 | `codex.rate_limits`, rate-limit 계열 `error`/`response.failed` 프레임 → 같은 저장소(§14.3). frame은 그대로 돌려줌 |
| own-accounts | session `retry` | setup, unscoped | `own-*` | hard/transient 분류(§14.3, 02 §5.2) |
| own-accounts | session `prompt` | setup, unscoped | sessionID로 거름 | 미고정 세션 고정, 보류 전환 적용(G8b 통과 뒤, §8.5) |
| own-accounts | `ctx.event.subscribe` | setup | – | `session.created`, step/usage/model.selected/compaction/status 이벤트 |
| own-telemetry | session `http.response`, `retry` | setup, scoped `{providerID:"anthropic"}` | – | unified 헤더 캡처, 긴 멈춤 방지(§9.3-8) |

- **비용.** unscoped `http.response`가 있으면 `hooks.has`가 모든 provider에서 참이 되어, 모델 HTTP 요청마다 body를 한 번 버퍼링하는 래퍼가 붙습니다(`model-request.ts:295-323`). 내장 provider는 숨겨져 있고, 슬롯이 설치되면 claude-auth의 unscoped http 훅이 이미 같은 비용을 만들므로(02 I7) 받아들입니다. WS 경로는 `has` 검사 없이 항상 trigger됩니다(`model-request.ts:326-350`).
- **범위: 세션을 거치는 호출에만.** `model.request`는 `SessionModelRequest`에서만 trigger됩니다(`model-request.ts:262`; 그 밖의 trigger는 내장 provider 플러그인 자신의 등록뿐). 따라서 kind `primary/compaction/title/generate`(= 세션 `POST /api/session/:id/generate`)에는 적용되지만, **세션 밖 LLM 호출에는 적용되지 않습니다.**
  - `Generate.text`(`packages/core/src/generate.ts:38-72`)는 resolver로 모델을 고른 뒤 `llm.generate`를 바로 부릅니다. 플러그인의 `ctx.generate.text`(`packages/core/src/plugin/host.ts:271-273`)와 `POST /api/experimental/generate`(`packages/protocol/src/groups/generate.ts:8`)가 이 경로입니다.
  - Auth.none인 own provider로 이 경로를 타면 인증 헤더 없이 나가 401이 됩니다(누수는 아니고 실패입니다). 기본 모델이 own provider이면(내장이 숨겨져 있으므로 흔함) model 없이 `generate.text`를 부르는 다른 플러그인은 깨집니다.
  - 규칙: own-accounts, own-team, own-web은 own 모델로 `generate.text`/experimental generate를 **쓰지 않습니다**. 인계 요약은 세션 `generate`를 씁니다(02 §5.9(f)). own.team의 판단 호출(켜기·영역 제안, 06 §3.4)도 팀 메인 세션의 `POST /api/session/:id/generate`를 self-HTTP로 부르므로 그 세션의 계정으로 인증되고 대화 이력은 바뀌지 않습니다(surface `team-session-generate`). 이 경로까지 덮는 유일한 해결은 **P-007**(resolver의 요청별 credential 선택)입니다(§12).
- **대체 경로.** G2가 실패하면 `http.request`와 `experimental.ws.handshake`에서 auth **이후** 헤더를 덮어씁니다. 이 경우 route auth가 먼저 성공해야 하므로 더미 값이 필요하고, 그만큼 더 취약합니다. 그다음은 02 §3.7의 대체 모드(`credentialBackend:"opencode-credential"`)입니다. 이 모드에서는 키와 토큰이 평문 DB에 저장되므로 UI에 대체 모드임을 명시합니다.
- **훅 불변식**
  - 훅은 절대 throw하지 않습니다. Promise 훅이 reject되면 defect가 됩니다(`packages/plugin/src/promise/adapter.ts:577-579`, `hooks.ts:21-30`). 실패하면 헤더를 넣지 않고 넘겨서 provider가 401을 돌려주게 하고, 계정 상태를 `needs_reauth`로 바꿉니다(02 상태 enum).
  - 헤더 값은 slot 안에서 안정적이어야 합니다. 토큰 refresh 때만 바뀌어야 WS가 불필요하게 다시 연결되지 않습니다(`packages/core/src/session/model-transport.ts:117,309-320`).
  - 로그에는 SHA-256 앞 8자만 남깁니다.
- **비밀 캐시.** vault에서 복호화한 값은 runtime 싱글턴의 클로저 안 메모리 캐시에 보관합니다. TTL 기본값은 10분이고 0이면 캐시하지 않습니다. OAuth access token은 만료 5분 전에 refresh합니다(02 F1).

### 8.4 Codex(ChatGPT) 로그인, 가져오기, refresh

**방법은 세 가지입니다. 어느 방법이든 토큰 계열 하나에 refresher는 언제나 하나입니다**(02 §3.1 C3, 결정 D7로 개정). 이전 판의 "`~/.codex/auth.json`을 가져오지 않는다, 계정마다 새로 로그인한다"는 아래 표로 바뀌었습니다.

| 방법 | 토큰 원본 | refresher | vault | RPC |
|---|---|---|---|---|
| 새 로그인(device code 기본, 브라우저 PKCE 선택) | 우리 | own-accounts | `vault\<accountId>.dpapi` | `accounts.add.chatgpt.{start,status,complete,cancel}` |
| **가져오기: linked (기본)** | 이전 앱 profile의 `auth.json` | **이전 앱만** | 쓰지 않음 | `accounts.import.codex.{list,plan,execute}`, `mode:"linked"` |
| 가져오기: takeover | 가져오는 순간 vault로 한 번 복사 | own-accounts(이후 유일) | 씀 | 같음, `mode:"takeover"` |

- **새 로그인은 자체 구현합니다.** 내장 `chatgpt-browser`/`chatgpt-headless`는 integration `openai`에 묶여 있고 구현이 모듈 private입니다(`openai.ts:50-107,169-228`). 이것을 쓰면 두 문제가 생깁니다.
  - 토큰이 평문 DB에 저장됩니다.
  - 새 로그인이 전역 active를 뒤집습니다(`packages/core/src/credential.ts:108-124`).

  그래서 로직을 upstream에서 옮겨 옵니다(MIT, 02 §3.2).
- **로그인 방식**
  - 기본은 **device code**입니다. OAuth 콜백 포트 1455를 Codex CLI와 다투지 않기 위해서입니다.
  - 브라우저 PKCE는 선택 사항입니다.
  - client id는 upstream과 같은 공개 값을 쓰고 `originator: opencode`를 유지합니다. **`codex_cli_rs` 위장은 금지**합니다 `[research critique 2(d)]`.
- **이전 앱에서 가져오기 (결정 D7).** 프로토콜과 runtime은 구현돼 있습니다(`packages/own-protocol/src/rpc.ts:484-517`, `packages/own-runtime/src/codex-source.ts`).
  - **원본 위치**
    - 파일: `<control-center>\profiles\<profileID>\codex\auth.json`. alias는 `<control-center>\state.json`에서 읽습니다.
    - 기본 control center: `D:\#Projects\codex-multi-provider\work\control-center`(`codex-source.ts:10-18`).
    - `plan`은 profileID(구분자 없는 이름)만 받고, 경로는 서버가 만듭니다(`rpc.ts:489-496`).
    - 1MiB가 넘는 파일은 거부합니다(`codex-source.ts:21`).
  - **linked(기본)**: 원본을 **읽기만** 합니다.
    - 파일을 쓰지 않고, 토큰 엔드포인트를 부르지 않습니다. 이전 앱이 계속 유일한 refresher입니다(`packages/own-protocol/src/credential.ts:31-42`).
    - 파일이 바뀌거나 401을 받으면 원본을 다시 읽습니다.
    - 토큰이 만료됐거나 거절됐는데 원본이 갱신되지 않았으면, 그 계정의 요청을 멈추고 경보 `codex_source_stale`을 냅니다(`packages/own-protocol/src/alert.ts:26-27`). UI는 "이전 앱에서 로그인을 갱신하거나 takeover" 선택지를 보여 줍니다(문구는 03).
    - vault를 쓰지 않으므로 삭제해도 지울 것이 없습니다(`willShredVault=false`, `rpc.ts:551-553`). 경고 코드는 `linked_depends_on_source`입니다(`rpc.ts:177-184`).
    - 이 계정에는 runtime의 refresh single-flight와 `vault\<accountId>.lock` lease를 쓰지 않습니다. refresh를 하지 않기 때문입니다.
  - **takeover**: `plan` → `execute{nonce}`입니다. 흐름의 상세와 오류 코드는 02 §3.2a가 기준입니다.
    - 원본 토큰을 vault(oauth 항목)로 한 번 복사하고, 그 뒤로 우리가 유일한 refresher가 되게 합니다(02 §3.5 F1–F7).
    - 원본 파일은 쓰지 않습니다. 우리 레지스트리에만 superseded로 표시합니다(`credential.ts:44-53`).
    - **복사만으로는 refresher가 하나가 되지 않습니다.** `Credentials.takeover`는 토큰을 복사할 뿐입니다(`packages/own-runtime/src/credentials.ts:285-316`). 이전 앱(codex-multi-provider)이 그 프로필을 계속 돌리면 같은 토큰 계열을 refresh할 수 있고, 그쪽이 먼저 refresh하면 죽는 것은 **우리 vault 사본**입니다(`refresh_token_reused`/`invalid_grant`). 그래서 세 가지를 둡니다.
      - (1) **선행 조건.** 이전 앱에서 그 프로필을 멈추거나 끕니다. `plan`은 이것을 경고(`takeover_supersedes_source`와 함께 "이전 앱에서 이 프로필을 먼저 멈추세요")로 돌려주고, 확인 대화상자는 사용자의 확인 체크를 받습니다(문구는 03). 우리가 이전 앱의 실행 상태를 확인할 방법은 없으므로 사용자 확인에 기댑니다 ⚠.
      - (2) **execute 직후 강제 refresh 한 번.** own-accounts의 execute 핸들러가 `refresh(…, {force:true})`를 불러 토큰 계열을 우리 쪽으로 회전시킵니다(02 §3.2a). 그러면 이전 앱이 가진 사본이 무효가 되는 쪽입니다. 이 refresh가 `refresh_token_reused`로 실패하면 원본을 다시 읽어 한 번만 다시 합니다(02 §3.2a).
      - (3) **"원본이 동시에 refresh함" 분류.** takeover 뒤 일정 시간(초기값 24시간 ⚠) 안에 `refresh_token_reused`/`invalid_grant`가 나면 일반 `needs_reauth`로 두지 않고 reason `source_refreshed_concurrently`로 분류합니다. UI는 새 로그인 대신 "이전 앱이 아직 이 프로필을 쓰고 있습니다 — linked로 다시 연결"을 먼저 제안합니다. 이름과 기간은 02가 정합니다(§20).
      - 주의: OpenAI가 이미 회전된 refresh token의 재사용을 감지했을 때 그 계열 전체(우리 새 토큰 포함)를 폐기하는지는 확인하지 못했습니다 ⚠. 폐기한다면 (1)을 지키지 않은 이전 앱의 refresh 한 번으로 우리 계정도 죽습니다. 그래서 (1)은 선택이 아니라 선행 조건입니다. G19에서 확인합니다.
    - 이전 앱 profile은 다시 로그인해야 할 수 있습니다. 경고 코드는 `takeover_supersedes_source`입니다.
    - linked에서 takeover로 바꿀 때는 같은 계정 id로 합니다(`plan{accountID}`). providerID와 세션 바인딩은 그대로입니다.
  - **계정 가드**: `chatgpt_account_id`와 사용자 지문 `sha256(chatgpt_account_id + ":" + sub)`(02 C5)을 봅니다.
    - 원본이 기대한 로그인을 더 이상 담고 있지 않으면 `account_mismatch`로 거부합니다(`codex-source.ts:115-135`). 예: 이전 앱에서 그 profile에 다른 계정으로 다시 로그인한 경우.
    - 같은 지문의 계정이 이미 있으면 새 계정을 만들지 않고 재연결합니다.
  - **비밀 취급**: 읽은 토큰은 private 필드에만 둡니다. `toJSON`은 가림 문자열을 돌려줍니다(`codex-source.ts:49-80`). 로그·RPC·이벤트에는 해시 앞 8자만 남깁니다.
  - **SSH 브로커와의 관계**: 브로커는 lease를 주기 전에 토큰 남은 수명이 짧으면 먼저 refresh합니다(04 §8.5). linked 계정은 refresh할 수 없으므로 원본을 다시 읽고, 그래도 짧으면 lease를 거부합니다 ⚠. 02·04와 맞춰야 합니다(§20).
- **Codex CLI의 `~/.codex/auth.json`은 가져오지 않습니다.** 그 파일의 refresher는 Codex CLI 자신입니다. 우리와 동시에 refresh하면 "already used" 오류가 납니다 `[research critique 2(c)]`. linked 방식은 "원본 앱이 계속 refresh한다"는 전제에서만 안전하고, 그 전제는 이전 앱(codex-multi-provider)에만 둡니다.
- **refresh** (02 §3.5 F1–F7, 새 로그인과 takeover 계정)
  - 토큰 계열 하나당 refresher는 **하나**입니다. 프로세스 안은 runtime의 single-flight, 프로세스(와 빌드) 사이는 `vault\<accountId>.lock` lease입니다.
  - 새 토큰은 **쓰고 나서 씁니다**(persist-before-use): temp→fsync→rename, 이전 값은 `.prev`. Windows에서 rename은 `MoveFileEx(MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)`입니다.
  - refresh가 영구적으로 실패하면(`invalid_grant`, `refresh_token_reused` 등) 계정 상태를 `needs_reauth`로 바꾸고 `account.status` 이벤트를 냅니다.
- **계정 메타데이터**: JWT 클레임에서 `chatgpt_account_id`, 플랜, 이메일을 읽습니다(추출 경로는 AC-P22). 이메일은 UI에서 마스킹합니다. 재로그인 결과의 지문이 저장된 지문과 다르면 거부합니다(02 C5).

### 8.5 세션과 계정의 바인딩, 전환

**고정 규칙(모든 세션은 명시적 model을 가진다)**
- 문제: `SessionInfo.model`은 optional이고(`packages/schema/src/session.ts:40`), 비어 있으면 runner가 **매 attempt**마다 전역 기본 모델을 해석합니다(`packages/core/src/session/runner/model.ts:88-94`). TUI, `-m` 없는 `own run`, model을 빼고 세션을 만드는 클라이언트의 세션은 계정이 고정되지 않아서, 기본 모델이 바뀌면 조용히 계정(=캐시 도메인)이 바뀌고 UI에도 계정이 없습니다. 이것은 G-3과 R1/R2를 깹니다.
- 규칙
  - own-web은 `POST /api/session`에 항상 `model`을 보냅니다(`packages/protocol/src/groups/session.ts:225`).
  - own-accounts는 `session.created`(`packages/schema/src/session-event.ts:52`)에서 model이 없으면, 그 시점의 기본 모델(`ctx.model.default()`, `GET /api/model/default`)로 `ctx.session.switchModel`을 부릅니다. `previous`가 없는 `model-switched`는 LLM 메시지를 만들지 않으므로 prefix에 영향이 없습니다(`to-llm-message.ts:239-241`).
  - 서버 재시작 등으로 이 이벤트를 놓친 세션은 첫 `prompt` 훅에서 같은 처리를 합니다. 단 prompt 훅 안의 `switchModel`은 G8b 통과 전에는 쓰지 않고, 그때까지는 own-web 전송 경로(`switch.apply` 뒤 `POST /prompt`)와 idle 경로만 씁니다.
  - 고정되지 않은 레거시 세션은 UI에 **"기본값(미고정)"** 상태로 보여 주고, "기본 모델이 바뀌면 계정이 바뀝니다" 경고와 [이 계정으로 고정] 동작을 둡니다(03에 추가 필요, §20).
- **바인딩 조회**
  - 세션의 계정은 `SessionInfo.model.providerID`에서 레지스트리로 역조회합니다(02 `session.binding`).
  - 턴의 계정은 `session.step.started.model`로 알 수 있습니다(`packages/schema/src/session-event.ts:333-345`).
  - 서브에이전트 세션도 같은 방식입니다. agent 설정의 모델 ref가 내장 provider를 가리키면 전역 credential을 쓰므로 own providerID를 써야 합니다(부모 계정 상속 방법은 02 Q10, §20).

**전환 실행 주체** — 모든 전환은 02 §5의 상태 머신(`switch.apply`)을 거칩니다. 사유가 ledger(`events-YYYY-MM.jsonl`)와 상태 머신에 남게 하기 위함입니다(02 §5.9, 03 §16.3 "쓰기 원칙").

| 동작 | 실행 주체 | 방법 |
|---|---|---|
| 지금 전환 | own-web → own-accounts | RPC `switch.estimate` → `switch.apply{strategy:"now"}`. idle이면 `ctx.session.wait` 뒤 `ctx.session.switchModel`(`packages/core/src/plugin/host.ts:533,549`). busy면 WAIT_SAFE(다음 턴) |
| 압축 후 전환 | own-web(compact 실행) + own-accounts(상태) | `switch.apply{strategy:"compact-then-switch"}` → 응답 `clientAction:{type:"compact"}` → own-web `POST /api/session/:id/compact` → own-accounts가 `session.compaction.ended`를 받아 wait → `switchModel`. 플러그인 SessionDomain에는 `compact`가 없습니다(`packages/plugin/src/promise/session.ts:153-170`) |
| 전환 후 압축 | 같음 | 02 §5.9(c). 소스가 hard 소진일 때 |
| cold point 예약 | own-accounts | `switch.schedule` → SCHEDULED. `compaction.ended` 또는 소스 idle > `TTL_hi`가 되면 WAIT_SAFE → idle에서 `switchModel`. prompt 훅(admission) 적용은 G8b 통과 뒤에만 |
| 곁가지 fork | own-web + own-accounts | `POST /api/session/:id/fork` → fork 세션에 `switch.apply` |
| 새 세션 인계 | own-web | 02 §5.9(f). 새 세션 생성 때 `model`을 명시 |
| 대체(RPC 불가) | own-web | `POST /api/session/:id/model`. own-accounts는 이것을 `reason:"external"`로 기록합니다(02 §5.4). TUI 등 외부 클라이언트의 전환도 같은 방식으로 감지만 하고 막지 않습니다 |

- **세션이 busy일 때.** 스트리밍 중에는 절대 바꾸지 않습니다. `switch.apply{strategy:"now"}`가 busy 세션에 오면 WAIT_SAFE로 두고 다음 safe point(idle)에 적용합니다. UI는 "다음 턴부터"로 표시합니다. 모델은 step마다 다시 해석되므로(`packages/core/src/session/runner/llm.ts:213-243`) 턴 중간 `switchModel`은 에이전트 루프 중간에 계정을 바꿉니다. 그래서 **"다음 step부터" 옵션은 두지 않습니다.** 유일한 예외는 `policy.inTurnFailover=true`일 때의 hard 트리거 failover이고, 이것은 AC-P17b(G8 should) 통과 전에는 꺼져 있습니다.
- **cold point 예약의 메커니즘과 검증.** prompt 훅 안(같은 세션의 admission 중)이나 `Compaction.Ended` 처리 중에 부르는 `switchModel`이 runner와 경합하거나 막히는지는 확인되지 않았습니다(`packages/plugin/src/promise/session.ts:14-20`, `llm.ts:213-243`). G8b(= 02 AC-P26)가 "다음 step에 반영, 교착 없음, step 중복 없음"을 확인하기 전까지는 **idle에서만** 적용합니다(02 §5.3 방법 1·3).
- **`switch.estimate` 결과**(02 §9.2): 선택지별 추정치(`now` / `compact-then-switch` / `switch-then-compact` / `cold-point` / `fork` / `new-session`)와 경고 코드를 돌려줍니다. 전환 알림을 transcript에 넣지 않습니다(prefix 오염). 알림은 UI 전용입니다.

### 8.6 자동 전환 정책

정책 수치와 상태 전이는 02 §5.2·§5.5·§5.10과 `policy.json`이 기준입니다. 요약만 둡니다.

| 계정 종류 | 자동 전환 | 트리거 |
|---|---|---|
| 구독 (codex, claude-sub) | **없음(기본 `ask`)**. 제안만 하고 사용자가 누르면 전환 | 하드 소진이면 턴을 빨리 끝내고(§14.3) UI가 전환을 제안합니다. 구독→종량제 API도 기본 `ask`. 서드파티 슬롯으로는 자동 전환 금지 |
| API 키 | 계정 `autoSwitch=true`이고 정책이 `auto`일 때만, 같은 kind의 후보(또는 fallback chain)로 | 하드 트리거만: spend cap(`enforced_spend_limit_reached`), workspace 한도 400, refresh 후에도 반복되는 인증 실패, 잔액 소진. 일시적인 429는 같은 계정에서 대기(core retry) |

- **히스테리시스.** 전환 후 30분 **그리고** 20요청(둘 중 늦은 쪽) 동안은 하드 소진이 아니면 자동 전환을 금지합니다. 1시간에 자동 전환 2회 이상, 사용자 없이 10분 안에 A→B→A, 또는 최근 15분 cold 합계가 3·P를 넘으면 30분 circuit breaker를 겁니다(02 §5.5).
- **Anthropic.** 같은 org 안의 다른 workspace로 자동 전환하는 것은 **workspace 수준 한도가 트리거일 때만** 허용합니다. org 한도는 공유되기 때문입니다(02 §5.2 quota domain 전파).
- **retry 경로에서 `switchModel` 호출.** 다음 attempt가 새 모델로 해석될 가능성이 있지만(`llm.ts:213-243`) 검증되지 않았습니다(G8 should, AC-P17b). 검증되기 전까지는 턴을 끝낸 뒤 idle에서 전환합니다.

### 8.7 캐시 최적화 규칙 (계정 전환과 provider 전환 공통)

| # | 규칙 | 구현 위치 | 근거 |
|---|---|---|---|
| R1 | providerID = slot(캐시 도메인), 불변. 모든 세션은 명시적 model로 고정(§8.5). 전환은 `switch.apply`(내부적으로 `switchModel`)로만. `credential.activate`와 `connect/key`를 공유 integration에 쓰지 않음 | accounts, web | `model-resolver.ts:359-364`, `credential.ts:108-124`, `runner/model.ts:88-94` |
| R2 | sticky. 구독은 수동 전환만, API 키는 하드 트리거만(§8.6). flap breaker | accounts | `[research cache_design S1, critique #4]`, 02 §5.5 |
| R3 | 설정 동등화. 같은 kind의 slot은 **같은 고정 템플릿 규칙**으로 모델을 등록하고, 같은 model id와 variant로 전환(UI 기본값). Codex의 `session-id`와 헤더 재현 | accounts | `optimize.ts:36-45`, `openai.ts:298-309`, 02 §2.4.2 |
| R4 | 모든 own provider는 `compaction: {type:"summary"}`. native window는 providerID provenance에 묶여 있음 | accounts | `packages/core/src/session/provider-context.ts:23` |
| R5 | 다운시프트 가드: `P`가 대상의 **유효 ceiling**(R16, 기본 `ctx − max(floor(0.15·ctx), 16k)`, `ctx = limit.input‖limit.context`, upstream d9987ef9c8·v2.1)을 넘으면 대상에서 cold auto-compaction이 일어나므로 **현재(warm) 계정에서 먼저 compact**하도록 권고 | accounts(추정), web | `packages/core/src/session/compaction.ts:197-234,866-872,879-884` |
| R6 | compact-then-switch. `P ≥ 40k`인 계획된 전환에 권고. 추정할 때 최근 15k 토큰은 원문 유지, 요약 요청의 older 부분은 cold일 수 있음(Anthropic 소스는 특히)을 반영해 **범위**로 표시 | web(실행), accounts(추정) | `compaction.ts:189`, `[research cache_verify #5]`, 02 §5.6·§6.4 |
| R7 | cold point 예약. 캐시 도메인마다 `ttl_warm_lower`/`ttl_cold_upper` 두 값을 둠(아래 표, 원본은 `ratecards.json`). "likely +0"으로 표기. 적용은 idle에서만(§8.5) | accounts | `[research cache_verify #6]` |
| R8 | 결정적 훅. system/tools/history에 계정 정보·시각·난수를 넣지 않음. strip 규칙은 저장해 두고 epoch가 끝날 때까지 적용. synthetic이나 instruction으로 전환 알림을 넣지 않음 | accounts | `[research cache_design S7, S8]`, 02 §4.3 D1–D8 |
| R9 | **Anthropic 1h "떠나기 전" 모드 (후속, 사용자 opt-in)**. 기본은 auto policy(모두 5m). 1h 모드는 아래 "R9 상세"의 hint 배치 규칙을 정확히 지켜야 하며, 그렇지 않으면 요청이 400으로 거절됨 | accounts(`context`/`compaction`/`generate` 훅) | `packages/ai/src/cache-policy.ts:17-24,47-48,150-165`, `packages/plugin/src/promise/session.ts:33-36`, `[research cache_verify #3]`, 02 §4.5 |
| R10 | `promptCacheKey`와 `session-id`는 세션 기준 그대로 유지. 계정별 key를 만들지 않음 | (건드리지 않음) | `model-request.ts:237-259` |
| R11 | 곁가지 작업은 fork. 원 세션이 A 전용으로 깨끗하게 남음 | web | `[research cache_design S13]` |
| R12 | 추정기와 경보: 전환 전 비용(credits/토큰/$, 쿼터 %는 보정 전까지 범위로), flap, prefix 불안정(rolling hit < 60%), 복귀 miss | accounts, web | 02 §6, §7.7 |
| R13 | 모든 kind(primary/compaction/title/generate)에서 같은 slot을 씀. title 에이전트에 자체 `model`을 주지 않으면 `model.small(primary.providerID)`로 **같은 provider** 안에서 고르고(`packages/core/src/session/context.ts:95-119`), 실패하면 primary로 다시 시도함(`packages/core/src/session/title.ts:127-133`). title 에이전트가 내장 provider를 가리키지 않도록 설정 | accounts, config | 아래 "R13 상세" |
| R14 | **variant 기억.** (sessionID, providerID)마다 마지막 variant를 기억하고(KV `sess:<sid>:cache:<providerID>.variant`, 02 §2.4.6), 그 slot으로 돌아갈 때 기본값으로 복원. 사용자가 다른 variant를 고르면 전환 planner가 캐시 경고를 표시 | accounts, web | `packages/ai/src/effort-updates.ts:20-25`(마지막 marker ≠ 요청 effort면 모든 effort marker 제거), `to-llm-message.ts:239-248`(provider가 바뀌는 전환에는 marker를 만들지 않음) |
| R15 | **OpenRouter의 Claude/Gemini.** upstream 74dbc509d7부터 `openrouter` route의 auto policy가 `anthropic/` 모델에 tools·system·tail breakpoint를, Qwen에 system·tail을 두고, 그 밖(Gemini 포함)에는 두지 않음(Gemini는 마지막 breakpoint만 써서 tail hint가 손해). 그래서 own은 수동 hint를 두지 않음. 그전에는 정책을 건너뛰어 `context` 훅이 system[0]과 tail에 수동 hint를 두었음 | accounts | `cache-policy.ts:150-153`, `session.ts:33-36`, 02 §4.5, AC-P31 |
| R16 | **auto-compaction 차등(결정 D6).** 코어의 `auto`·`buffer`·`keep`은 **Location 단위** 상태이고, 전역 config와 그 Location의 프로젝트 config를 차례로 덮어 만듦. provider·모델·세션별 값은 없음. 트리거 ceiling은 모델의 `limit.input‖limit.context`에서 계산됨. 그래서 provider·모델·계정별 임계값은 own-accounts가 slot 템플릿의 **유효 `limit.input`**으로 정하되, **그 Location의 유효 `buffer`를 반영해** 계산함. 프로젝트 config가 `auto:false`나 `buffer`를 두면 경고. own 전역 config는 둘 다 두지 않음. 세션별 재정의는 "더 일찍"만 가능. compaction은 cold point이므로 R5·R7도 같은 유효 ceiling을 씀. 아래 "R16 상세" | accounts(템플릿·판정), web(설정 UI, 수동 compact) | `compaction.ts:38-44,187-211,225-233,654,866-872`, `packages/core/src/config/plugin/compaction.ts:14-22`, `packages/core/src/config/discovery.ts:33-36` |

**R9 상세 (Anthropic 1h 모드)**
- **순서 규칙.** Anthropic은 wire 순서(tools → system → messages)에서 **1h breakpoint가 5m breakpoint 뒤에 오는 것을 허용하지 않습니다.** TTL은 앞에서 뒤로 비증가(1h…1h, 5m…5m)여야 합니다 `[research cache_verify]`.
- **왜 수동 hint를 정확히 4개 두는가.** auto policy는 남은 예산(`4 − 수동 hint 수`)을 last tool → system 첫/끝 → tail 순서로 채우고(`cache-policy.ts:17-24,150-165`), auto hint에는 TTL이 없어 5m가 됩니다(`cache-policy.ts:47-48`). system과 tail에만 1h를 달면 auto가 **last tool에 5m**를 달고, tools는 system보다 앞이므로 5m가 1h 앞에 와서 400이 됩니다. 플러그인은 이 tool hint를 직접 지울 수도 없습니다. `context` 훅의 `tools`에는 `cache` 필드가 없기 때문입니다(`session.ts:33-36`).
- **배치.** 1h 모드가 켜진 slot의 **떠나기 전** A 요청마다 `context`/`compaction`/`generate` 훅이 수동 hint를 **정확히 4개** 둡니다. 배치 순서는 02 §4.5가 기준입니다: 1순위 `system[0]`, `system[last]`(system part가 2개 이상일 때), tail. 4번째 자리(1순위에서 부족한 만큼)는 watermark(있으면) → 현재 compaction epoch의 첫 메시지(압축 요약 또는 첫 사용자 메시지) → system의 다른 part(인덱스 1부터) 순서로 채웁니다. 그러면 auto 예산이 0이라 tool hint가 붙지 않습니다.
  - TTL: 기본은 4개 모두 `ttlSeconds: 3600`입니다(02 §4.5). tail만 5m로 두는 변형(system[0] 1h, system[last] 1h, watermark 1h, tail 5m, `[research cache.json]`)도 순서 규칙상 허용됩니다. 어느 쪽이 싼지는 G4b에서 정합니다.
  - `ttlSeconds ≥ 3600`은 `ttl:"1h"`로 바뀝니다(`packages/ai/src/protocols/utils/cache.ts:12-13`).
  - 메시지 위치는 모두 `markMessageAt` 규칙(마지막 text part, 없으면 마지막 part, `cache-policy.ts:90-112`)으로 고르고, 저장된 history만으로 정합니다(02 D1). 위 순서로도 4개를 채울 수 없으면(system part 2개 이하이고 메시지가 1개뿐인 아주 짧은 세션) **그 요청에는 1h hint를 하나도 두지 않습니다**(수동 hint 없이 auto 5m만, 02 §4.5). 1h 수동 hint 3개 + auto 5m tool 1개 조합은 절대 만들지 않습니다.
- **떠나기 전에만 의미가 있음.** 복귀 때 필요한 항목은 A의 마지막 요청이 쓴 것이므로, 1h는 그 요청에 이미 붙어 있어야 합니다. 복귀 요청에 붙이면 늦습니다 `[research cache_verify #3]`. 그래서 사용자가 "잠깐 다녀옴(복귀 예정)"을 고른 경우만 켭니다. 일시적 429로는 켜지 않습니다.
- **복귀 시(5m watermark 모드, MVP 가능).** 02 §4.5: 수동 hint 2개(watermark, tail, TTL 미지정) + auto 2개(last tool, system[0]). 모두 5m라 순서 규칙과 무관합니다.
- **게이트와 단계.** G4b(= 02 AC-P16): 1h 모드 요청이 Anthropic에서 **200**을 받고, `cache_creation.ephemeral_1h_input_tokens`/`ephemeral_5m_input_tokens` 분리가 배치대로 나오는지(4×1h면 5m write 0) 확인합니다. 요청 단위 `cache` 정책(`packages/ai/src/schema/messages.ts:394`)을 훅에서 지정할 수 있게 하는 패치(P-011, 02 §10의 `cand-cache-policy`)가 없는 동안 1h 모드는 **후속** 단계로 둡니다. 비용 계산은 P-006(1h write 분리)이 없으면 추정입니다.

**R13 상세 (title 모델과 구독 한도)**
- title 모델 선택은 `packages/core/src/session/context.ts:95-119`입니다. `Model.small`은 같은 providerID의 사용 가능 모델 중 family `gpt-luna` → `gemini-flash-lite` → `gemini-flash` → `claude-haiku` 순서로 고릅니다(`packages/core/src/model.ts:256-268`). 그래서 title은 **같은 own slot**에 머뭅니다.
- Codex slot: 필터가 `gpt-5.4-mini`·`gpt-5-mini`는 끄지만 `gpt-5.6-luna`(family `gpt-luna`)는 통과합니다(`openai.ts:23-25,282-291`). 따라서 고정 템플릿에 luna가 있으면 title은 luna + 최소 reasoning variant로 가고, **적은 양이지만 구독 한도를 씁니다**. 템플릿에 small family가 없거나 luna 호출이 실패하면 primary 모델로 가서 더 많이 씁니다(`title.ts:127-133`).
- 선택지: (a) codex 템플릿에 luna를 포함(기본), (b) 구독 slot만 쓰는 사용자는 title 에이전트를 끔(`agents.get("title")`가 없으면 제목 생성을 건너뜀, `context.ts:96-97`). ledger는 title 사용량을 `kind:"title"`로 따로 집계합니다(02 §7.5).

**R16 상세 (auto-compaction 설정, 결정 D6)** — 정책 수치, 저장 스키마, 기본값 표는 02가 기준입니다. 여기서는 로컬 소스로 확인한 메커니즘과 01의 선택만 적습니다.
- **v2가 트리거를 계산하는 방식**
  - 설정은 `Settings{auto, buffer?, keep}`이고 초기값은 `{auto:true, keep:15_000}`입니다(`packages/core/src/session/compaction.ts:38-44,187-195`).
  - **이 상태는 Location 단위입니다.** `SessionCompaction`은 `makeLocationNode`로 Location마다 따로 만들어집니다(`compaction.ts:654`). 값은 그 Location의 config 문서를 낮은 우선순위부터 차례로 덮어 만듭니다(`packages/core/src/config/plugin/compaction.ts:14-22`). 문서에는 전역 config뿐 아니라 Location 디렉터리에서 위로 올라가며 찾은 프로젝트 문서(`opencode.json[c]`, `.opencode/`)가 들어갑니다(`packages/core/src/config/discovery.ts:33-36`). provider·모델·세션별 값은 없습니다.
  - 따라서 **프로젝트 `.opencode/opencode.json`이나 `opencode.json`의 `compaction` 값이 그 Location의 기준을 바꿉니다.**
    - `compaction.buffer`가 있으면 ceiling이 `window − buffer`가 되어 아래의 `⌈T/0.9⌉` 식이 깨집니다(`compaction.ts:866-872`).
    - `compaction.auto:false`면 그 프로젝트에서는 자동 compaction이 조용히 꺼집니다. overflow 복구도 꺼집니다(`compaction.ts:201-202`). D6이 요구한 DeepSeek·xAI·OpenRouter·compat의 보수적 기준이 바로 이 경우에 사라집니다.
    - 예외: `--untrusted` 모드(`OPENCODE_CONFIG_PROJECT_DISABLE=1`, §13.2)에서는 프로젝트 문서를 찾지 않으므로(`discovery.ts:33-36`의 `options.project === false`) 전역 값만 적용됩니다.
  - `auto`가 꺼져 있으면 사용자가 부른 것 말고는 compact하지 않습니다(overflow 포함, `compaction.ts:201-202`). 수동 compaction(`POST /api/session/:id/compact`)은 여전히 됩니다.
  - ceiling은 `window = limit.input || limit.context`로 정합니다. `buffer`가 없으면 `window − max(floor(window × 0.1), 16k)`(16k는 창이 32k 이상일 때만, upstream d9987ef9c8. 그전에는 `floor(window × 0.9)`)이고, 있으면 `window − buffer`입니다. 창을 모르면(0) 자동 compaction은 일어나지 않습니다(`compaction.ts:866-872,203-208`).
  - 트리거 조건은 추정 컨텍스트가 ceiling 이상일 때입니다. 방금 compaction이 끝났거나 native 창의 측정값이 아직 없으면 미룹니다(`compaction.ts:225-233`). 추정에는 현재 provider의 측정값만 씁니다(`compaction.ts:878-883`).
  - 방식은 모델 `compaction.type`으로 고릅니다. `native`와 summary가 있고(`compaction.ts:213-216`), own slot은 모두 summary입니다(R4).
  - **ceiling은 트리거이면서 요약 예산입니다.** `cap`과 `budget`(`compaction.ts:203-211`)이 `summarize`로 가고, `deliver(…, budget − overhead)`(`:290`)를 거쳐, older 부분이 예산을 넘으면 `flattenAndDropOldest`가 오래된 교환부터 버립니다(`:385-393`). `limit.output`은 variant의 출력·추론 예산에 쓰입니다(`packages/core/src/variant.ts:45-72`).
- **01의 선택: slot 템플릿의 유효 `limit.input`** (코어 패치 없음. 수식과 해석 순서는 02 §4.7.3–§4.7.4가 기준)
  - 목표 임계값 T(토큰)에 대해, **그 Location의 유효 compaction 설정**으로 유효 `limit.input`을 정합니다. 원래의 `limit.input‖limit.context`를 넘지 않게 합니다.
    - 유효 `buffer`가 없으면: `유효 limit.input = windowFor(T)`, ceiling이 T에 닿는 가장 작은 창(`T + 16k`와 `⌈T / 0.9⌉` 중 작은 쪽, `@own/protocol` `Compaction.windowFor`)
    - 유효 `buffer`가 있으면: `유효 limit.input = T + buffer`. 이 값이 원래 창을 넘으면 T를 지킬 수 없으므로 원래 창을 쓰고 경고합니다.
  - slot 등록은 Location마다 따로 일어나므로(provider transform은 Location 인스턴스마다 fold됨, §4) Location별로 다른 값을 등록할 수 있습니다.
  - Location의 유효 설정을 own-accounts가 아는 방법은 ⚠입니다(§20). 후보는 두 가지입니다.
    - (a) 코어와 같은 발견 규칙(`discovery.ts`)으로 프로젝트 문서를 직접 읽음
    - (b) `GET /api/config?location[directory]=…`(Location의 config 문서 목록, 낮은 우선순위부터, `packages/protocol/src/groups/config.ts:9-21`)를 조회함. Promise 플러그인 API에는 config 도메인이 없습니다(`packages/plugin/src/promise/plugin.ts:27-53`).
    - 어느 쪽이든 config가 바뀌면 다시 계산하고 `provider.reload()`합니다. 02 §4.7.2의 런타임 불일치 경보 `compaction_threshold_mismatch`는 이 계산이 틀렸을 때의 보조 탐지로 남깁니다.
  - **경고.** 프로젝트 config가 `compaction.auto:false`나 `compaction.buffer`를 두면 own-accounts가 그 Location에 경보를 내고, 설정 화면과 컨텍스트 미터에 "이 프로젝트 설정이 자동 압축을 바꾸고/끄고 있습니다"를 보입니다(코드 이름은 02 §7.7이 정함). `auto:false`인 Location에서는 slot 기준도 세션 "더 일찍"과 같은 클라이언트 경로(`compaction.due` → `POST /compact`)로 지키는 것을 선택지로 둡니다. 이때도 overflow 복구는 꺼져 있고, 클라이언트가 붙어 있을 때만 됩니다 ⚠.
  - 템플릿에는 원래 값과 유효 값을 함께 두고, 등록에는 유효 값을 씁니다. 값이 바뀌면 `provider.reload()`만 부릅니다(§8.3).
  - `limit`은 prompt에 들어가지 않으므로 바꿔도 prefix는 그대로라고 봅니다 ⚠. G16에서 system·tool 해시로 확인합니다.
  - "더 큰 출력 여유"는 T를 낮추는 것으로 표현합니다. `limit.output`은 바꾸지 않습니다. variant 예산이 달라지면 요청 본문이 바뀌기 때문입니다.
- **기본값의 방향** (수치는 02)
  - Codex, Claude(API): v2 기본(core ceiling, `ctx − max(floor(0.15·ctx), 16k)`, upstream v2.1부터 15%)
  - DeepSeek, xAI, OpenRouter, compat: 더 이른 임계값과 더 큰 출력 여유
  - `claude-sub`(`anthropic`)은 내장 provider이고 §9.3의 "건드리지 않음" 계약 때문에 전역 기본만 적용됩니다.
- **범위의 한계** ⚠
  - 세션별 재정의는 **더 이른 임계값만** 됩니다. 저장은 RPC `compaction.setSession{sessionID, triggerTokens}`, 판정은 own-accounts가 `step.ended`마다 하고, 넘으면 세션 이벤트 `compaction.due{sessionID, inputID, P, triggerTokens, epoch}`를 냅니다. 받은 클라이언트가 `POST /api/session/:id/compact {id: inputID}`를 보냅니다(02 §4.7.4, §9.2–§9.3).
    - 그래서 세션 값은 **턴 사이(step 경계 뒤)에만, 그리고 클라이언트가 연결돼 있을 때만** 적용됩니다. UI는 "앱이 열려 있을 때만 적용"을 붙입니다. slot 기준(`T_slot`)은 클라이언트와 무관하게 코어가 지킵니다.
    - 구현된 `@own/protocol`에는 아직 compaction 메서드가 없습니다(메서드 46개, `health` 포함). `compaction.setSession`과 이벤트 `compaction.due`는 02 v0.3이 더한 계약입니다(47개·14개, 02 §9).
  - "더 늦게"와 "이 세션만 끄기"는 코어가 먼저 트리거하므로 패치 없이는 안 됩니다.
  - slot별 `keep`도 안 됩니다. 전역 `keep`(기본 15,000)을 유지합니다.
  - 이것이 꼭 필요하면 02가 요구사항을 적고, §12에 새 후보 패치로 올립니다.
- **요약 예산의 부작용.** ceiling이 곧 요약 예산이므로(위), 사용자가 T를 **지금 세션의 P보다 낮게** 바꾸거나, 전환으로 들어온 세션의 P가 대상의 T보다 크면, 다음 auto(또는 manual) compaction에서 가장 오래된 교환이 요약 입력에서 빠집니다(`compaction.ts:385-393`).
  - UI는 새 T가 열린 세션의 P보다 낮으면 경고하고, "지금 기준으로 먼저 압축한 뒤 적용"을 권합니다. 02의 `dryRun:true` → `compactionImpact{sessions[].truncates}`가 이 판정을 줍니다(02 §4.7.5).
  - 세션 "더 일찍"은 수동 compaction 경로라 예산이 `T_slot`의 ceiling이므로 잘리지 않습니다(02 §4.7.4).
  - 작은 창으로의 전환은 R5·R6(02 §4.7.5)이 먼저 compact하게 합니다.
- **캐시와의 관계**
  - compaction은 cold point입니다. 예약 전환(R7)은 `session.compaction.ended`를 적기로 씁니다.
  - 작은 창으로 가기 전의 사전 compaction(R5·R6)은 **대상의 유효 ceiling**을 기준으로 판단합니다.
  - 컨텍스트 미터는 원래 창을 100%로 그리고, 유효 ceiling 위치에 임계값 표시를 둡니다(03).

**TTL 초기값** (측정으로 교체할 값, G4와 T5. 원본은 `ratecards.json`의 `ttl`):

| 캐시 도메인 | ttl_warm_lower (W_t 계산용) | ttl_cold_upper (cold point용) |
|---|---|---|
| OpenAI API ≤5.5 | 30m | 24h |
| OpenAI API GPT-5.6+ | 30m | 30m |
| Codex | 5m | 미정(T5 측정 전에는 cold point 자동 예약 금지) |
| Anthropic API | 5m (1h 모드면 60m) | 5m (1h 모드면 60m) |
| DeepSeek | 0 | 수일 |
| xAI, OpenRouter | 0 | 미정 |

**추정식**: 02 §6.3이 기준입니다. 요지는 `Δ(t) ≈ (L_cur − W_t)·(r_cold − r_read)`이고, `W_t`는 다른 slot이면 0, 같은 slot으로 TTL 안에 복귀하면 `L_A`입니다(Anthropic은 lookback 20 block 조건 포함). Codex 쿼터 %는 3개 클래스 회귀가 수렴하기 전까지 범위로 표시합니다(02 §7.6).

---

## 9. 서드파티 플러그인: opencode-claude-auth-v2 (앱에 포함, 2026-10-18)

### 9.1 제품 개념
- own-web의 **플러그인** 화면에는 세 그룹이 있습니다.
  - (a) 기본 플러그인: own-accounts, own-remote(R1 이후 설치, 04 §21), own-telemetry. 항상 켜져 있고 끌 수 없습니다.
  - (b) **서드파티 · Claude 구독**: "opencode-claude-auth-v2". `앱에 포함 · 항상 켜짐`, 버전, 무결성(`앱의 기록과 일치`), 순서, 위험 안내, `Claude 계정 관리 →`. 설치·제거 버튼은 없습니다.
  - (c) Computer use: `own-computer-use`의 버전과 상태. 관리(중지, 기록)는 설정 > 실험, 켜기는 세션마다 합니다(§10.2).
  - 그 밖에 이 Location에서 발견된 **프로젝트 플러그인**과 승인 상태를 보여 줍니다(§13.2).
- 플러그인은 앱에 들어 있고 늘 켜져 있습니다(사용자 결정 2026-10-18 "넣고 항상 켜기"). 로컬 동의는 받지 않습니다. Claude 계정을 연결하기 전에는 아무 요청도 보내지 않습니다(02 §8.2 3번·§8.4). 카드와 Claude 묶음에는 항상 **"비공식/서드파티 플러그인 — 약관 위험"** 배지를 붙입니다.
  - 2026-10-18 전에는 설치 전에 1회 동의(KV `ack:claudeAuth`, 버전·무결성·고지 해시가 바뀌면 다시)를 받고, 이 PC에서 npm으로 설치했습니다. 이 흐름은 설치 실패가 잦았습니다.
- 고지문은 정보로 보입니다(문구는 03 §5.4.1(a)이 기준):
  - Anthropic 약관과 충돌할 수 있어 계정 제재 위험이 있음
  - Anthropic이 2026-04-04부터 서드파티 도구의 구독 사용을 추가 사용량(종량제)으로 청구한다고 알림. 요청이 추가 사용량으로 청구되거나, 추가 사용량이 꺼져 있으면 거절될 수 있음. 그래서 이 슬롯의 비용은 "알 수 없음"으로 표시하고, 카드에 경고와 확인 방법을 늘 보임(02 §8.9)
  - Claude Code와 토큰을 공유함(동시에 쓰면 재로그인이 필요할 수 있음)
  - refresh fallback이 `claude -p` 호출(Haiku)로 과금될 수 있음
  - 토큰이 OpenCode DB에 평문으로 저장됨
  - 이 앱이 조금 고친 판을 앱에 넣어 늘 켜 둠, 여러 계정을 자동으로 돌리는 것의 탐지 위험(02 §8.1)

### 9.2 빌드와 실행 (02 §8.2)
1. **빌드**(`build-desktop.ps1` 3a단계, `own/scripts/claude-auth-bundle.ts`): `own/vendor/claude-auth`의 커밋한 lock으로 임시 폴더에 `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` → 버전·integrity 확인 → 패치 매니페스트 적용(pre/post hash) → `bun build` 한 파일 → `app\<ver>\plugins\claude-auth\`와 `own-bundle.json`(빌드 id, 파일마다 sha256). 어느 hash든 다르면 빌드가 실패합니다. 릴리스 manifest에 이 폴더의 파일 해시가 들어갑니다(`own/FORK.md` §8.3).
   - **npm 실행(빌드 PC, Windows).** `.cmd` 파일은 shell 없이 spawn할 수 없으므로(Node 보안 수정 CVE-2024-27980 이후 EINVAL) `npm.cmd`를 직접 부르지 않고 `node.exe`로 `npm-cli.js`를 실행합니다. 사용자 PC에는 Node·npm이 필요 없습니다.
2. **설정**: launcher가 own 전역 config의 `plugins`에 `app\<version>\plugins\claude-auth`를 own.team 줄 뒤에 둡니다(`own install`/`update`, `$ManagedPlugins`). 대상은 디렉터리이고 entry는 `server.js`입니다(`packages/core/src/config/plugin/source.ts:150-154`, `packages/plugin/src/host.ts:17-43`).
3. **확인**: own-accounts가 시작할 때와 `plugin.updated`마다 `ctx.plugin.list()`에 플러그인이 보이는지(`host.ts:419-421`), 로드된 폴더가 앱의 번들인지, `own-bundle.json`의 hash가 맞는지, 순서가 맞는지(`plugin.claudeAuth.status.order`)를 봅니다. 맞지 않으면 계정 하나로 돌거나 막습니다(02 §8.2 4번).
4. **연결**: UI의 "Claude Code 구독 가져오기" 버튼 → RPC `plugin.claudeAuth.importSubscription` → `POST /api/integration/anthropic/connect/oauth`(method `claude-code`). 이 흐름은 `mode:"auto"` 단일 버튼입니다. 사전 조건은 Claude Code에 로그인(`claude auth login`)해 둔 상태입니다. 계정을 더 쓰려면 `Claude 계정 추가`, 만료된 로그인은 `다시 로그인`입니다(02 §8.7).
5. **옛 설치에서 옮기기**: `own install`/`update`가 옛 `thirdparty\claude-auth` 줄을 번들 줄로 바꾸고, 성공한 뒤 옛 npm 설치 파일만 지웁니다. 계정 목록·상태·로그인은 남습니다(02 §8.2 7번).
- **버전 올리기**는 앱 릴리스로만 합니다. 절차는 새 lock·새 패치 매니페스트 커밋 → 빌드 → 릴리스 노트입니다. `@latest`는 쓰지 않습니다.

### 9.3 공존 계약 (MUST, 02 §8.3 I1–I8과 같은 내용)
1. `anthropic` provider와 integration은 **Claude 구독 슬롯 전용**입니다. 여기에 API 키 credential을 만들지 않습니다. `Credential.create`는 같은 integration의 다른 credential을 비활성화하므로 구독이 조용히 꺼집니다(`credential.ts:108-124`).
2. 우리 Anthropic API 키 slot은 `own-anth-*`이고 integration을 두지 않습니다. claude-auth의 재작성 훅은 `event.model.providerID === "anthropic"`이면서 `anthropic` integration의 active credential이 `claude-code` OAuth일 때만 동작하므로, 우리 요청은 통과만 합니다 `[research plugin-compat §1.3]`. `canonical:"anthropic"`은 `Ref.providerID`를 바꾸지 않습니다(`model-resolver.ts:383-386`).
3. **`anthropic`에 baseURL이나 인증 헤더를 절대 설정하지 않습니다.** claude-auth는 호스트를 검사하지 않고 OAuth bearer를 붙입니다.
4. **우리의 변형(mutating) 훅은 `own-*` providerID에만 작용합니다**(provider-scoped이든 접두어로 거르든). `anthropic`에는 절대 작용하지 않습니다. `anthropic`의 읽기 전용 관측 훅(own-telemetry)은 claude-auth **다음**에 등록합니다.
5. Anthropic API 비용은 템플릿에서 **명시적으로 복사**합니다. canonical clone이 `cost=[]`를 상속하면 지출이 $0로 표시되는 문제가 생기므로 이를 막기 위함입니다.
6. 서비스 env에 claude-auth 조정 변수(`ANTHROPIC_CLI_VERSION`, `ANTHROPIC_USER_AGENT`, `ANTHROPIC_BETA_FLAGS`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AUTH_DEBUG`, `OPENCODE_CLAUDE_AUTH_*`)를 **설정하지 않습니다**. `CLAUDE_CONFIG_DIR`은 §9.4의 계정 소스(`OWN_HOME\claude-auth.json`)에서만 씁니다.
7. `anthropic` 슬롯의 활성 연결 종류(`oauth(claude-code)` / `key` / `env`)를 UI에 항상 표시합니다. OAuth가 삭제되고 env 키만 남으면 API 과금으로 조용히 바뀌는데, launcher가 env 키를 제거하므로 이 경로를 차단하고, 그래도 생기면 경보 `claude_slot_billing`을 냅니다(02 §8.9).
8. 5h/7d 거절 시 retry가 길게 멈추는 문제를 막습니다. claude-auth 자체 재시도에 core의 10회 재시도(회당 retry-after 최대 15분, `packages/core/src/session/runner/retry.ts:68-76,94-120`)가 겹치면 약 2.5시간 멈출 수 있습니다 `[research §1.3 hazard 6]`. 그래서 unified status가 `rejected`이면 own-telemetry의 `retry` 훅이 `{retry:false}`를 돌려줍니다.
9. 플러그인이 감지되고 앱의 번들로 확인되기 전에는 `anthropic`의 activation을 `"disabled"`로 둡니다(02 §8.4). 서버 쪽에서 강제하는 장치입니다.

### 9.4 한계 (문서화된 제약)
- 플러그인 0.4.0-beta.5는 원래 Windows에서 계정 1개만 읽습니다. own의 패치가 own이 쓴 목록의 config 폴더마다 계정 하나로 읽게 하고, 대화마다 계정을 정합니다(02 §8.7). v2는 integration당 active credential이 1개이므로 그 credential은 "연결됨" 표시로만 쓰고, 요청은 대화의 계정으로 서명합니다.
- 계정 1의 폴더는 `OWN_HOME\claude-auth.json`의 `configDir`(없으면 `%USERPROFILE%\.claude`)입니다. launcher가 이 값을 서비스 env `CLAUDE_CONFIG_DIR`로 넣습니다(02 §8.3 I8 예외). 다른 폴더는 계정으로 더합니다.
- 플러그인 버전이 바뀌면(앱 업데이트) `cc_version`이 바뀌어 세션당 1회 cold 재읽기가 생깁니다. 구독과 API 사이 전환은 캐시 도메인과 바이트 레이아웃이 모두 다르므로 항상 cold입니다(02 §8.6).
- 한도는 **패시브 헤더**(`anthropic-ratelimit-unified-*`)로만 읽습니다. `api/oauth/usage` 폴링은 하지 않습니다(추론 외 토큰 사용이 늘고 약관 노출도 커짐).

### 9.5 제거
- 플러그인은 앱과 함께 있고 따로 제거하지 않습니다(2026-10-18). 앱을 지우면 함께 지워집니다. Claude를 쓰지 않으려면 계정을 연결하지 않거나, 더한 계정을 `계정 빼기…`로 뺍니다(02 §8.7). 연결이 없으면 아무 요청도 보내지 않습니다.
- `RPC plugin.claudeAuth.uninstall.*`은 프로토콜 호환을 위해 남고 `internal_error`("built_in")로 거절합니다(02 §8.2 9번).

---

## 10. 도구 호스트: 네이티브 브라우저와 computer use

### 10.1 네이티브 in-app 브라우저 (결정 D2, 완성 범위)

`[gap]` 33은 원래 "나중(XL)"이었습니다. 데스크톱 셸이 호스트를 공짜로 주므로 완성 범위(must)로 올립니다. `[gap]` 15(브라우저 도구 처리 결정)는 이 절과 05 §8.7이 답합니다. 패인의 연결·소유·격리·레이아웃은 05 §8이, 화면은 03 §18.17이 기준입니다.

- **구성**
  - **서버 쪽**: 내장 플러그인 `opencode.browser`가 브라우저 도구와 RPC(`Browser.Definition`)를 등록합니다.
    - 위치: `packages/plugin-browser/src/index.ts:7`(id), `packages/core/src/plugin/internal.ts:89`(import), `:213-216`(`pre` 목록에 항상 포함)
    - CLI에 내장돼 있으므로 설치할 것이 없습니다.
    - 도구는 `codemode:true`, 권한 이름 `browser`입니다(`packages/plugin-browser/src/tools.ts:40-56`). 그래서 브라우저 도구는 요청의 도구 정의에 따로 들어가지 않고(Code Mode 도구는 모두 `execute` 하나로 묶임), Code Mode 카탈로그로 모델에 보입니다(`packages/core/src/tool.ts:234-259`).
  - **호스트 쪽**: 데스크톱 main의 `browser-pane.ts`가 세션마다 `rpc.attach({version: 4})`를 부릅니다(`packages/desktop/src/main/browser-pane.ts:244`).
    - 조작 대상은 `WebContentsView`(`browser-chromium.ts:59`)입니다.
    - 조작은 CDP로 합니다. `webContents.debugger`를 쓰므로 포트를 열지 않습니다(`browser-chromium.ts:177`).
    - 파티션은 attach마다 새로 만듭니다: `opencode-browser-<uuid>`(`browser-pane.ts:84`).
  - **호스트가 없을 때**: 도구 호출은 바로 실패하고 모델은 다음 오류를 받습니다(`packages/plugin-browser/src/connection.ts:136-141`). "[browser.disconnected] No desktop browser is connected to this session. Open this session in the desktop app and wait…". 이 문구는 모델에게 **데스크톱 앱을 기다리라**고 말합니다. 그래서 데스크톱에서 만든 세션을 웹 폴백이나 모바일에서 이어 갈 때 own-web은 "브라우저 도구는 데스크톱 앱에서 이 세션을 열어야 동작합니다" 배너를 보입니다(문구는 03). `connection.ts:58,81,97`의 "Browser is unavailable."는 데스크톱 쪽 RPC 오류이고 도구 호출 결과가 아닙니다.
- **own-web 쪽**
  - 패인 owner는 `isRendererUrl`로 판정합니다(`main/ipc-handlers/events.ts:31`). 그래서 own-web 렌더러가 그대로 owner가 됩니다.
  - 패인 UI는 03 §18.17(화면)과 05 §8.8(upstream `packages/app/src/session/browser/pane.tsx` 참고, 코드는 import하지 않음)이 기준입니다.
  - capability는 `browserPane`입니다(05 §6.2).
- **도구 목록 규칙 (prompt cache, 05 §8.7 안 D가 기준)**
  - **사실(로컬 소스)**
    - 브라우저 도구는 Code Mode 도구라 요청 도구 정의(tools)를 바꾸지 않습니다. `execute` 설명은 불변이고, 바뀌는 카탈로그는 Instructions로 갑니다(`packages/core/src/codemode/tool.ts:61`). 카탈로그가 바뀌면 전체를 다시 쓰지 않고 delta 문구를 만들고(`codemode/instructions.ts:32-124`), 이 값은 세션의 `InstructionsUpdated` durable 이벤트로 뒤에 덧붙습니다(`packages/core/src/session/instruction-state.ts:41-60`). 카탈로그는 세션마다 계산됩니다(`packages/core/src/session/context.ts:129-149`).
    - 권한 규칙이 도구를 전면 deny(`resource:"*"`, `effect:"deny"`)하면 그 도구는 스냅샷에서 빠집니다(`packages/core/src/tool.ts:229-232,292-295`). 세션 권한은 agent 권한 뒤에 합쳐집니다(`session/context.ts:129-134`).
    - 세션 생성·수정 API가 `permissions`를 받고(`packages/protocol/src/groups/session.ts:228,363`), 자식 세션은 생성 때 부모 권한을 복사합니다(`packages/core/src/session.ts:273-276`).
  - **규칙(05 §8.7 안 D)**
    1. own-web의 세션 생성 어댑터는 `host.capabilities.browserPane`이 거짓이면 `permissions`에 `{action:"browser", resource:"*", effect:"deny"}`를 넣습니다. 참이면 넣지 않습니다. 결정 D2의 "웹 모드에서는 처음부터 끔"은 이것으로 만족합니다. 데스크톱이 설치된 PC에서 웹 폴백으로 만든 세션도 처음부터 없습니다.
    2. 이미 있는 세션의 권한은 창 종류가 바뀌어도 **자동으로 바꾸지 않습니다.** 데스크톱에서 만든 세션을 웹이나 휴대폰에서 이어 가면 카탈로그는 그대로이고 호출은 위 오류로 바로 실패합니다.
    3. 웹에서 만든 세션을 데스크톱에서 켜려면 명시적 동작(`이 세션에서 켜기`)으로 `PATCH /api/session/:id{permissions}`를 부릅니다. 다른 규칙("항상 허용"으로 저장된 것 등)을 지우지 않게 **읽고-고치고-씁니다.** 결과는 카탈로그 delta 한 번이고 앞 prefix는 유지된다고 봅니다 ⚠(G-D5에서 잰다).
    4. 자식 세션은 생성 때 부모 규칙을 복사하므로 따라갑니다. 이미 있는 자식에는 3번이 전파되지 않습니다.
    5. TUI·`own run` 등 다른 클라이언트가 만든 세션에는 규칙이 없습니다(카탈로그에 있고 호출만 실패).
  - **하지 않는 것**: 전역 `"-opencode.browser"`나 전역 `permission.browser: deny`. 서비스가 하나라 데스크톱 세션에서도 사라집니다(05 §8.7 안 B·C). "설치 프로필"이라는 개념은 두지 않습니다.
  - **원격 호스트(04)**: 원격 세션에도 같은 생성 시점 규칙을 씁니다. 원격 세션을 만드는 own-web이 자기 호스트의 `browserPane`으로 판단합니다. 원격 service의 설치 단위 설정은 따로 두지 않습니다.
- **원격 세션 패인의 자격 증명 (결정 D2 × D8)**
  - 패인은 main이 Node HTTP로 attach합니다. 인증 헤더는 register IPC로 받은 `target.endpoint.password`로 만들고, 없을 때만 로컬 sidecar origin에 `SidecarCredentials`를 씁니다(`packages/desktop/src/main/browser-pane.ts:48-50,89-90,119-124`; `BrowserPaneEndpoint{url, username?, password?}`, `packages/app/src/runtime/platform/browser-pane.ts:3-9`).
  - 그래서 원격 세션의 패인은 own-web이 다음처럼 등록합니다: `{url: "http://127.0.<k>.2:<LP>", username: "opencode", password: <own.remote 세션 토큰>}`. 서버는 세션 토큰을 비밀번호 자리에서 받습니다(`packages/server/src/auth.ts:32-37`).
  - **main은 원격 토큰을 메모리에만, attachment 수명 동안만 둡니다.** 저장하거나 로그에 남기지 않습니다. provider 비밀은 main에 가지 않습니다. 이 점에서 §6.1의 "원격 토큰은 렌더러만 가진다"의 예외입니다.
  - **토큰 수명.** 04 §12.1의 원격 토큰은 기본 12시간(호스트 설정 8–24시간)이고, `resolve`가 남은 수명 1시간 미만이면 새로 서명합니다. attach RPC는 오래 살아서 토큰보다 길 수 있습니다. 규칙: own-web은 `tokenExpiresAt` 1시간 전, `host.state`의 `epoch` 변경, 또는 패인이 `suspended`/401로 닫힐 때 새 토큰으로 **다시 등록**합니다. 이미 열린 attach 스트림이 토큰 만료 뒤에도 유지되는지는 확인하지 못했습니다 ⚠(G-D5 원격 시나리오).
  - 범위: 패인에 넘기는 토큰은 own-web이 이미 가진 그 호스트의 서버 접근 토큰과 같은 것입니다. 새 범위를 만들지 않습니다(04 §12.1과 맞춤).
- **보안**
  - 페이지 내용은 신뢰하지 않는 데이터입니다. 도구 설명도 그렇게 말합니다(`packages/plugin-browser/src/tools.ts:38`).
  - 패인은 렌더러와 다른 파티션입니다. main의 Basic 주입은 렌더러 top frame에만 붙으므로 패인 페이지는 서비스 비밀번호를 받지 않습니다(`main/windows/security.ts:34-55`).
  - `file://` 로드는 로컬 서비스 세션의 워크스페이스 안만 허용됩니다(`browser-pane.ts:89-90,132`). 원격 서버면 루트가 비어 있습니다.
  - lighthouse(브라우저 감사)를 넣을지는 크기와 바꾸는 선택입니다(§20).
- **게이트**: G-D5(§16.2), 상세 시나리오는 05 D5.

### 10.2 Computer use (`own-computer-use`)

2026-10-01에 첫 판을 넣었습니다. 구조, 좌표 모델, 프로세스 안 드라이버는 패키지 `packages/own-computer-use/ARCHITECTURE.md`, 두 드라이버가 함께 쓰는 프로토콜과 helper 실측값은 `own/native/own-cu-helper/README.md`, 프로세스 안 드라이버 실측값은 패키지 `README.md`가 기준입니다. 이 절은 결정과 계약만 적습니다.

- **엔진 결정(2026-10-01, 같은 날 고침)**: 기본 엔진은 **프로세스 안 FFI 드라이버**(`driver: "windows"`)입니다. 서비스 프로세스 안의 Bun 워커 스레드 둘이 `bun:ffi`로 Windows DLL(user32, gdi32, gdiplus, ole32, kernel32, advapi32, shcore, dwmapi, UIAutomationCore)을 직접 부릅니다. 자체 C# helper `own/native/own-cu-helper`는 `driver: "helper"`로 고르는 대체 엔진으로 남깁니다.
  - 바꾼 이유: 서명 없는 helper exe를 Smart App Control이 켜진 이 PC의 Code Integrity가 막았습니다(새 빌드 9개 중 1개, 같은 날 실제 데스크톱 시험에서는 미리 빌드해 둔 exe도 이벤트 3077·3033으로 거부). 또 helper는 따로 빌드하고 릴리스 산출물로 실어야 하며, 시작에 125–270 ms가 듭니다. FFI 드라이버는 Windows 자체 DLL만 불러 Code Integrity가 새로 검사할 실행 파일이 없고, 워커 시작과 첫 `hello`가 약 20 ms입니다(패키지 README 실측).
  - 스레드: 동기 FFI는 서비스 이벤트 루프에서 돌지 않습니다. 데스크톱 워커 하나가 디스플레이, 캡처, 입력, 창 목록과 포커스, 정지 조합, 데스크톱 뮤텍스를 모두 맡습니다. DPI 컨텍스트, 뮤텍스, `RegisterHotKey(NULL)`이 모두 스레드에 묶이기 때문입니다. UI Automation은 두 번째 워커에서 돌아, 다른 앱의 UIA provider가 멈춰도 입력이 막히지 않습니다.
  - 시간 제한과 재시작: 요청마다 메인 스레드 쪽 시간 제한이 있습니다(데스크톱 `helper.timeoutMs` 기본 10 s, UIA 3 s). 넘거나 워커가 죽으면 그 워커를 버리고(`terminate`는 네이티브 호출 중이어도 바로 돌아옴) 다음 요청이 새 워커를 띄웁니다(연속 실패는 백오프). 데스크톱 워커가 예기치 않게 끝나면 지금처럼 `exited`로 킬스위치를 겁니다. UIA 실패·시간 초과는 "포커스 요소 없음"으로 읽고 gate가 글자 입력을 거부합니다(fail closed). 킬스위치는 걸지 않습니다. 누르고 아직 떼지 않은 키와 버튼은 메인 쪽이 기억했다가 새 워커로 뗍니다. `releaseAll`은 실패하지 않습니다.
  - DPI: 워커 스레드에서 `SetThreadDpiAwarenessContext(-4)`(Per-Monitor-V2)를 부르고, 실제로 그렇게 됐을 때만 `hello.dpiAwareness`가 `per_monitor_v2`입니다(아니면 드라이버가 거부). 서비스 프로세스 전체의 DPI 인식은 바꾸지 않습니다.
  - 단일 파일 번들: 플러그인은 minify한 파일 하나라 워커를 별도 모듈로 둘 수 없습니다. 워커는 자족적인 함수와 순수 도우미 함수를 `Function.prototype.toString`으로 문자열로 만들어 Blob URL로 띄웁니다. e2e가 빌드된 번들로 Windows에서 워커가 실제로 `hello`·`cursor.get`·`displays`에 답하는 것을 확인합니다.
  - 프로토콜: 두 엔진은 helper 프로토콜(op와 응답 모양, helper README 3장)을 함께 씁니다. FFI 워커는 JSON 줄 대신 `postMessage`로 주고받고 캡처 바이트를 base64 없이 넘깁니다. 그래서 TS 쪽 op 매핑과 눌린 입력 관리는 한 코드입니다.
  - 동작은 helper와 같습니다: `BitBlt(SRCCOPY|CAPTUREBLT)` 캡처와 GDI+ HighQualityBicubic 축소·PNG/JPEG 인코딩(GDI+ flat API), UWP 프레임의 CoreWindow 프로세스 보고(못 찾으면 exe 빈 값으로 거부), `TokenElevation`(못 읽으면 관리자 권한으로 봄), cloaked 표시, 입력 데스크톱 확인(`OpenInputDesktop` + `GetCursorPos`), 이름 있는 뮤텍스 `Local\own-open-code-computer-use`(두 번째 인스턴스는 `busy`), Ctrl+Alt+Shift+Q `MOD_NOREPEAT`(누르면 눌린 입력을 놓고 이벤트), `KEYEVENTF_UNICODE` 글자 입력(서로게이트 쌍, 줄바꿈은 Return), UIA 포커스 요소의 `IsPassword`·컨트롤 종류·프로세스(COM vtable 호출).
  - 대체 엔진 helper: C# 5를 Windows에 들어 있는 .NET Framework `csc.exe`(4.8)로 빌드합니다(`build.ps1` → `target\own-cu-helper.exe`, SDK·설치·서드파티 코드 없음). manifest(PerMonitorV2, asInvoker)와 `SetProcessDpiAwarenessContext(-4)`로 Per-Monitor-V2를 인식하고, own-vault처럼 stdio JSON lines로 말합니다(`hello` 확인, `rid`, 요청 순서대로 응답, `rid` 없는 이벤트 줄, 최소 env `SystemRoot`·`windir`, windowsHide, 16 MiB 줄 상한). 네트워크, 파일 쓰기, 저수준 입력 훅, 관리자 권한 요청이 없습니다.
  - 두 엔진 모두 정책 판단은 하지 않습니다. 정책은 모두 TS gate가 합니다.
  - 버린 안: trycua `cua-driver` + `own-cua-proxy` MCP(별도 설치, 도구 58개, 빠르게 바뀜, MCP가 Location마다 뜸, Windows 서비스가 MCP를 0개 등록하는 upstream 버그 anomalyco/opencode#50710). PowerShell `Add-Type` 브리지(시작 지연, DPI 인식 불안정, ExecutionPolicy·AMSI). `cua-perception`(AGPL-3.0)은 쓰지 않습니다.
- **플러그인**: `packages/own-computer-use`(`@own/computer-use`, id `own.computer-use`, **Effect** API, 플러그인 순서 6번 자리(맨 뒤, own-team이 없던 빌드에서는 다섯 번째 항목), launcher 관리 번들). 순수 TS core(입력 스키마, 좌표, 키, 정책, 프레임, 이미지 예산, lease, 킬스위치, 감사)와 `Driver` 인터페이스(프로세스 안 FFI 드라이버, helper 드라이버, 시험용 FakeDriver) 위에 도구, 실행 시점 gate, RPC, 훅을 얹습니다. 가드(`OWN_OPEN_CODE=1`, 앱 버전, options, Windows)가 실패하면 이유를 담은 `status`만 등록합니다. `status.driver`는 `windows`·`helper`·`fake`입니다.
- **도구**: `computer` 네임스페이스, Code Mode 기본(`screenshot`은 pinned), 권한 이름 `computer`. 입력과 출력은 plain JSON Schema로 등록합니다(출력 스키마가 있어야 Code Mode 코드가 `captureId`, 크기, 창 목록 같은 구조화 출력을 받습니다).
  - 관찰: `screenshot`, `zoom`, `cursor_position`, `list_windows`. 창: `focus_window`.
  - 입력: `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `mouse_move`, `left_mouse_down`, `left_mouse_up`, `scroll`, `type`, `key`, `hold_key`. 그 밖에 `wait`.
  - 매개변수 이름은 Anthropic `computer_toolset_20260801`과 같습니다. `@opencode/ai`에 provider 고유 computer 도구 변환이 없으므로 일반 함수 도구로 내고, Claude와 GPT 모두 이 이름에 익숙합니다.
  - 좌표는 그 세션의 최근 스크린숏 픽셀입니다. gate가 프레임으로 물리 좌표로 바꿉니다.
  - 오류 문구는 `[computer.<code>]`와 다음 행동 안내로 시작합니다(코드: `not_enabled`, `stopped`, `busy`, `app_not_allowed`, `app_denied`, `not_approved`, `elevated_target`, `password_field`, `no_target`, `target_changed`, `no_stop_chord`, `stale_screenshot`, `no_screenshot`, `out_of_bounds`, `desktop_unavailable`, `driver_unavailable`, `timeout`, `blocked_key`, `subagent`, T1의 `subagent_model`·`team_turn`, 2026-10-18의 `no_vision` 등). 코어는 번들의 `Tool.Error`를 메시지로 다시 감싸므로 코드는 메시지 안에 둡니다.
- **동의 모델**: 플러그인 도구는 코어 권한 ask를 부를 수 없습니다(`options.permission`은 카탈로그 필터 `whollyDisabled`에만 쓰임, `packages/core/src/tool.ts`). 그래서 겹으로 막습니다.
  1. 에이전트 전역 `{computer,*,deny}`(`ctx.agent.transform`): 기본으로 도구가 카탈로그에 없고 요청도 바뀌지 않습니다. 코어는 설정(`agents.*`)과 마크다운 에이전트를 모든 설정 플러그인 뒤의 내장 post 플러그인에서 넣으므로, setup 등록에 더해 이 Location의 `plugin.updated`마다 늦은 등록 하나를 다시 만들어 맨 뒤에 둡니다(`src/agents.ts`, T1.34, own-accounts `presets/agents.ts`와 같은 승인된 예외, surface `builtin-plugin-placement`·`plugin-updated-after-activation`). 그래서 T1부터 설정 에이전트도 deny를 받습니다.
  2. 세션별 켜기: own-accounts `session.approval.set{sessionID, mode, computerUse:"on"|"off"}`가 세션 규칙 `{computer,*,allow}`를 own 묶음 앞에 넣거나 뺍니다(읽고-고치고-쓰기, `modeOf`는 그대로). 켜고 끌 때 카탈로그 delta가 한 번 생기고 앞 prefix는 유지됩니다(§10.1 사실). `mode`가 필수라 `custom` 세션은 승인 모드를 먼저 골라야 합니다.
     - 자식(T1): 끝나지 않은 자식에는 own.computer `status`가 `policy.allowSubagents`를 보일 때만 allow를 씁니다. 코어는 새 자식을 만들 때 부모의 세션 규칙을 복사하므로(surface `session-child-inherits`), allow가 든 채 생긴 자식에서는 `allowSubagents`가 꺼져 있으면 own-accounts가 그 allow를 지웁니다(02 §9.2). 읽기 전용 역할(`explore`, `own-review`)은 own-accounts의 조이기만 하는 `evaluate` 훅이 `computer`도 deny로 되돌립니다(07 §2.4·§5.4).
  3. 실행 시점 gate: 호출마다 **세션** 규칙에서 `computer`에 맞는 마지막 규칙이 정확히 `{computer,*,allow}`인지 다시 봅니다. 나중에 붙는 config 규칙(`"*":"allow"`, `{"computer":"ask"}`)이 도구를 보이게 만들어도 동의로 치지 않고, 세션을 읽지 못하면 거부합니다(fail closed). 하위 에이전트 세션은 기본 거부(`policy.allowSubagents`)이고, 켜져 있어도 루트의 메인 모델(같은 provider와 모델 id, 07 `메인과 같게`)에서 도는 자식만 씁니다. 다른 계정·provider에 고정된 자식이나 더 가벼운 모델은 `subagent_model`로 거부합니다(T1.34).
     - 그림을 보는 모델(2026-10-18, 사용자 결정 "안 됨으로 두기"): 세션 모델의 `capabilities.input`(`ctx.model.list`)에 그림이 없으면 모든 컴퓨터 호출을 `no_vision`으로 거부합니다. 스크린숏을 보지 못하는 모델이 화면을 조작하게 두지 않으려는 것입니다. 화면을 글자로 바꿔 주는 대체 경로나 보조 그림 모델은 두지 않습니다. 모델 목록이 모르는 모델은 거부하지 않습니다. own-web은 그런 모델에서 켜기를 막고 이유를 보이며, 켜 둔 채 그런 모델로 바꾸면 알립니다(03 §4.4, 02 §3.3 "그림 입력과 도구").
     - 팀 모드(06, T1.34): own.team이 시작한 턴은 데스크톱을 조작하지 않습니다. 그 턴(마지막 `idle` 표시 뒤의 메시지들)의 어떤 메시지든 `metadata.source:"own.team"`이거나 `own.dispatch`·`own.team.update` 키를 가지면 `team_turn`으로 거부하고, 하위 에이전트는 루트의 최근 턴으로 봅니다. 턴의 시작이 마지막 압축 앞이면(긴 작업, 또는 upstream v2.4의 백그라운드 압축이 턴 중간에 끝난 경우) `ctx.session.messages`(코어 P-054)로 압축 앞 메시지를 최신 것부터 20개씩 읽어 그 턴의 `idle` 표시나 세션 시작까지 거슬러 봅니다. 압축 앞 메시지는 바뀌지 않으므로 답은 압축마다 한 번만 읽고 기억합니다(2026-11-24, 결정 CUU-2). 메시지를 읽지 못하거나 시작이 25쪽(500개)보다 멀면 거부합니다(fail closed). 세션 metadata(코어가 자식에게 복사하는 `own.team`)는 읽지 않으므로 팀 세션에서 사용자가 직접 시킨 턴은 그대로 됩니다. own.team은 `computerUse`를 켜거나 넘기지 않고, 권한을 쓴 뒤 부르는 `session.approval.set`에도 `computerUse`를 넣지 않으므로 있던 allow가 남습니다(06 §2.8).
  4. 앱 승인: 기본 `approval:"session"`은 세션을 켠 것을 거부 목록 밖 앱에 대한 동의로 봅니다(`policy.allowApps`가 비어 있지 않으면 그 앱만). `approval:"question"`은 코어 `question` 도구를 빌려 앱마다 "이 세션 동안 허용"을 묻습니다(문구는 한국어·영어를 함께 씀). 질문은 동작 잠금을 놓은 뒤 묻습니다. 그래서 사용자가 답하는 동안 다른 세션은 계속 쓰고, 코어의 질문처럼 시간 제한이 없습니다. 답한 뒤에는 대상 창부터 다시 확인합니다. 답하려고 이 앱을 누르면 이 앱이 앞으로 오기 때문입니다. 가짜 question 도구로 단위 시험만 거친 실험 모드입니다.
  - 켜는 UI는 세션 헤더 `⋯` > `이 세션에서 컴퓨터 사용…` 대화상자입니다. 켤 때 한 번 확인합니다(에이전트가 할 일, 멈추는 법, 늘 막히는 것, 스크린숏 전송과 보관, 카탈로그 문구). 끌 때는 묻지 않습니다(03 §4.4).
  - 휴대폰 게이트웨이는 `own.computer` RPC 중 `status`와 `killswitch.engage`만 `prompt`나 `switch` 범위 기기에 허용합니다(보고 멈추기만, 05 §13.4). 기기의 `session.approval.set{computerUse:"on"}`은 PC에서만 받습니다. 기기가 `computer`를 허용하는 규칙을 담아 세션을 만들거나(`POST /api/session`) 가져오는 것(`session/import`), 그런 규칙을 가진 세션을 포크하는 것(`POST /api/session/:id/fork`, 포크는 원본 규칙을 복사하므로 게이트웨이가 원본을 먼저 읽음), `approval:"question"`의 질문에 앱 허용 답(`OwnComputer.ALLOW_ANSWER`)을 보내는 것도 막습니다(own-remote `gateway/policy.ts`, 05 §13.4). 그래서 앱 승인도 PC에서만 합니다. 게이트웨이에 `own.team` 분기가 생긴 T1에도 이 `own.computer` 규칙은 그대로이고, 앱 기기(Android 앱, 다른 PC의 원격 PC 창, 08)도 같은 규칙을 지납니다.
- **정책**(`Policy.evaluate`): 다음을 거부합니다. 거부가 허용보다 앞섭니다.
  - 기본 거부 목록: 터미널·셸과 터미널이 있는 IDE(VS Code, Cursor, JetBrains 등. `allowTerminals`로만 풂), own-desktop·opencode·own-vault·own-cu-helper, 자기 도구 승인 단추가 있는 다른 에이전트 앱(Claude 데스크톱·Claude Code `claude`, ChatGPT·Codex 앱 `chatgpt`, `codex`, 사용자의 Codex 관리 앱 `codex.controlcenter`. 조작하면 에이전트가 스스로를 승인할 수 있으므로, 2026-11-24 결정 CUU-4), 시작 메뉴와 그 검색 상자(StartMenuExperienceHost·SearchHost, Windows 10의 SearchApp·SearchUI. 이름을 치고 Return을 누르면 실행되므로), UAC·자격 증명·보안 화면, regedit·mmc·taskmgr·msconfig, 비밀번호 관리자. 사용자 거부 목록(`policy.denyApps`).
  - UWP 앱(Windows 보안, 설정, 계산기 등)의 최상위 창은 `ApplicationFrameHost.exe`의 프레임입니다. helper는 그 프레임 안에서 다른 프로세스가 가진 자식 창(CoreWindow)의 프로세스를 앱으로 보고합니다. 그래서 거부·허용 목록과 세션 승인이 앱마다 따로 적용됩니다. 일시 중단되거나 최소화된 UWP 앱은 Windows가 CoreWindow를 떼어 두므로 앱을 알 수 없고 `exe`가 비어 거부됩니다(`focus_window`로 되살릴 수도 없음). `applicationframehost` 이름 자체도 기본 거부 목록에 있어 모든 UWP 앱을 한꺼번에 허용하는 일이 없습니다.
  - 창 단위: explorer의 `#32770` 대화상자(실행 대화상자, 시작 단추 오른쪽 클릭으로도 열림), 제목이 own-web인 창. 제목이 `own-open-code`이거나 `own-open-code` 뒤에 공백과 브라우저가 붙인 꼬리가 오는 창입니다(` - Google Chrome`, Firefox의 ` — Mozilla Firefox`, 탭이 여럿인 Edge의 ` and 2 more pages - …`).
  - 관리자 권한 창(UIPI가 입력을 버리므로). 대상 창이 없거나(활성화가 바뀌는 중) 글자 입력인데 포커스 요소를 모르면 `no_target`으로 거부합니다(fail closed).
  - 비밀번호 필드(UIA `IsPassword`)에는 이동 키(Tab, Return, Escape, 화살표, Home/End, Page Up/Down, shift와 함께)만 보냅니다. 붙여넣기(ctrl+v, shift+Insert, super+v)를 포함한 다른 키와 글자는 거부합니다.
  - 막힌 키: super+r, super+x(Win+X 메뉴), ctrl+alt+delete, 정지 조합, `policy.blockedChords`.
  - 키보드 동작(`type`, `key`, `hold_key`)은 처음에 한 번 확인한 뒤, 조합 하나, 글자 덩어리 하나, Tab·Return 하나를 보내기 전마다 앞에 있는 창(글자면 포커스 요소도)을 다시 확인합니다. 포커스를 옮길 수 있는 조합 뒤에는 100 ms 기다린 뒤 확인합니다. 바뀐 창이 정책에 걸리면 그 코드로(승인이 필요한 앱이면 `target_changed`) 나머지를 보내지 않고 끝냅니다. 그래서 `alt+Tab` 뒤 터미널에 치거나 Tab 뒤 비밀번호 칸에 치는 것이 한 호출 안에서 되지 않습니다.
  - 스크린숏 뒤에 새로 뜬 창(2026-11-24, 결정 CUU-3): 스크린숏마다 그때 화면에 있던 창 id와 앱 이름을 프레임에 적어 둡니다(캡처 직전에 읽으므로 그 사이에 뜬 창은 새 창으로 칩니다). 스크린숏 좌표로 겨눈 클릭·스크롤·끌기·버튼을 쥔 이동이 닿는 창이 그때 없던 창이고, 그 앱의 창도 그때 화면에 하나도 없었으면(알림, 다른 프로그램의 대화상자, 막 켜진 앱) 정책 검사 전에 `target_changed`로 거부하고 새 스크린숏을 찍게 합니다. 화면에 있던 앱의 메뉴와 대화상자는 통과합니다. 커서 위치 동작과 키보드(앞 창을 따로 다시 확인함)는 이 검사를 받지 않습니다.
  - 데스크톱은 한 번에 한 세션만 씁니다(lease, 120초 유휴 뒤 해제. 그 세션의 실행이 끝나면(`session.execution.succeeded|failed|interrupted`) 바로 해제하고, 그 세션이 누른 채 둔 버튼도 놓습니다. 2026-11-24, 결정 CUU-1). 드라이버 호출은 프로세스 전체에서 잠금 하나로 줄 세워 대상 확인과 입력 사이에 다른 호출이 끼지 않습니다.
- **킬스위치**: 물리 키 Ctrl+Alt+Shift+Q(데스크톱 워커나 helper의 `RegisterHotKey`. 눌린 입력을 놓은 뒤 이벤트를 냄. 워커는 스레드 메시지 큐를 50 ms마다와 요청마다 `PeekMessage`로 비움), RPC `killswitch.engage`(헤더 칩 `중지`, 설정 > 실험 `모두 중지`), `hello`까지 마친 데스크톱 워커나 helper가 `close`/`restart` 없이 끝날 때(충돌, 시간 초과 뒤 우리가 버리거나 죽인 경우 포함)가 켭니다. 켜지면 모든 동작이 `[computer.stopped]`이고 눌린 키와 버튼을 놓습니다. RPC `killswitch.reset`(설정 > 실험 `다시 허용`)으로만 풉니다. 세션별 켜기는 그대로 둡니다. 켜진 상태는 `OWN_HOME\state\computer-use-stop.json`에도 적고 reset이 지웁니다. 그래서 마지막 Location이 desktop을 놓아(유휴 정리, location reload) 새로 만들어지거나 서비스가 다시 시작해도 켜진 채입니다. 이 쓰기는 최선 노력입니다. 실패하면 지금 프로세스만 멈춘 채이고 뒤에 만드는 desktop은 모릅니다. 내용을 해석할 수 없는 파일(쓰다 끊긴 파일)은 켜진 것으로 봅니다.
  - 물리 키가 등록되지 않았으면(다른 프로그램이나 두 번째 서비스가 쥠) 입력 동작을 모두 `no_stop_chord`로 거부합니다. gate는 입력 전마다 드라이버에 `hello`를 다시 묻고(약 1 ms 이하), 그 `hello`가 등록을 다시 시도하므로 키가 풀리면 다음 동작부터 됩니다. `status.helper.killChord`로 보이고 설정 > 실험이 경고합니다. 관찰은 됩니다.
  - `left_mouse_down`으로 버튼을 쥔 세션의 `left_mouse_up`은 어떤 검사로도 막지 않습니다(놓기를 막으면 사용자의 마우스가 눌린 채로 남음). 그 세션의 표시만 지웁니다. 버튼을 쥐지 않은 세션의 `left_mouse_up`은 다른 입력처럼 동의, 하위 에이전트, lease, 정지 조합 검사를 거칩니다. 버튼을 쥔 동안의 `mouse_move`는 끌기이므로 놓일 창을 확인합니다. 세션을 지우면 그 세션이 쥔 버튼을 놓습니다.
  - 입력을 넣은 스레드나 프로세스가 사라져도 Windows는 그 입력을 놓지 않습니다. 그래서 Windows 드라이버가 누르고 아직 떼지 않은 키와 버튼을 기억하고, 다음 워커나 helper로 뗍니다(시간 초과·충돌·깨진 줄로 버리거나 죽인 경우). `helper.restart`는 동작 잠금을 기다린 뒤 입력을 놓고, 데스크톱 워커에는 `close`를(helper에는 stdin EOF를) 보내 스스로 놓게 합니다. 버리거나 죽이는 것은 그 뒤입니다.
- **화면**: 디스플레이 하나 전체를 캡처합니다. 기본 `standard`는 긴 변 1568 px·1.15 MP 이하, `high`는 2000 px. PNG 뒤 JPEG 85/75/60 사다리로 base64 4.5 MB 이하를 지켜 코어가 다시 줄이지 않습니다(`packages/core/src/image.ts`, 좌표 대응 유지). 커서는 이미지에 그리지 않고 따로 돌려줍니다. 프레임은 `captureId`와 디스플레이 layout 해시를 갖고, 해상도·배율·모니터 구성이 바뀌면 stale입니다.
- **이미지 예산(pruning)**: 세션 `context`/`compaction` 훅이 이 플러그인 이름의 스크린숏(`own-computer-use/cap_*`, `zoom_*`, 직접 결과와 Code Mode 결과 모두)만 배치로 짧은 문구로 바꿉니다. N장이면 오래된 `floor((N-keep)/batch)*batch`장을 바꾸므로 기본 keep 8·batch 7에서 요청에는 8–14장이 있고, prefix는 7장마다 한 번만 바뀝니다(prompt cache). 세션이 처음 쓴 (keep, batch)를 플러그인 저장소 `history/<sessionID>`에 영속화합니다(R8). 코어의 25 MiB→15 MiB 규칙(`model-request.ts:42-45,135-186`)보다 먼저 돕니다. 코어 규칙이 돌면 새 스크린숏마다 잘리는 자리가 바뀌고(prompt cache 손실) keep보다 적게 남으므로, 스크린숏과 zoom 한 장의 base64는 `maxBase64Bytes`와 20 MiB를 `keep + batch - 1`장으로 나눈 몫 중 작은 쪽으로 제한합니다(`Budget.imageLimit`, 기본값에서 약 1.43 MiB, 넘는 PNG는 JPEG 사다리로). 남는 5 MiB는 사용자가 붙인 이미지 몫입니다. 세션 DB에는 스크린숏이 base64로 남습니다(보관 정책은 후속).
- **RPC `own.computer`**(`@own/protocol/rpc-computer`, 플러그인이 `Portable.definition`으로 등록):
  - `status`(read): `available`, 이유(`unmanaged`·`skew`·`unsupported`·`invalid_options`), 빌드 id·버전, 드라이버(`windows`·`helper`·`fake`), 승인 방식, 앱 정책(`policy`), helper 상태(`driver: "windows"`면 데스크톱 워커의 상태), 킬스위치, lease 보유 세션, 세션별 허용 앱. 워커나 helper를 띄우지 않으므로 모니터 목록은 없습니다.
  - `killswitch.engage`(drive), `killswitch.reset`, `session.grants.get/set/revoke`, `helper.restart`(local), `audit.list`(read, 최신순, 최대 200).
  - 이벤트 `status`(상태가 바뀔 때마다 전체), `action`(동작 하나가 끝날 때: 세션, 도구, 앱, 결과, 코드, 시각. 인자는 없음). Location마다 플러그인 인스턴스가 같은 알림을 다시 내므로 클라이언트는 멱등하게 적용합니다.
  - own-web은 control location으로 부릅니다(`src/data/computer-rpc.ts`). 세션 켜기는 이 RPC가 아니라 own.accounts `session.approval.set`입니다.
- **감사**: `OWN_HOME\audit\computer-YYYY-MM.jsonl`, 호출마다 한 줄(`OwnComputer.AuditEntry`). 이미지, 입력 텍스트, 창 제목은 남기지 않습니다(텍스트는 길이만, 제목은 해시). `key`·`hold_key`는 글자 하나를 치는 키 입력을 개수로만 남기고 그 밖의 조합(`ctrl+s`, `Return`)만 순서대로 남깁니다. 숫자 키로 하나씩 누른 PIN이나 일회용 코드도 입력 텍스트이기 때문입니다. 텍스트 해시도 남기지 않습니다. 소금 없는 짧은 해시는 PIN이나 일회용 코드처럼 짧은 값을 모든 후보로 맞춰 보면 되찾을 수 있기 때문입니다. 잘못된 입력은 인자를 남기지 않습니다. 쓰기 실패는 도구를 실패시키지 않습니다.
- **싱글턴과 비용**: 같은 build id의 인스턴스는 globalThis 싱글턴(살아 있는 인스턴스 목록)으로 driver, 킬스위치, lease, 잠금, 프레임, 앱 승인을 나눕니다.
  - 옵션은 Location마다 config에서 오므로, 공유 데스크톱은 살아 있는 인스턴스의 옵션을 합쳐 씁니다. 앱 정책은 가장 엄한 쪽이 이깁니다: `denyApps`는 합치고, `allowTerminals`·`allowSubagents`·`approval:"session"`은 모든 인스턴스가 허용할 때만, 감사는 하나라도 켜면 켜고, 비어 있지 않은 `allowApps`는 교집합입니다(겹치는 앱이 없으면 모든 앱을 묻는 `question`). 그래서 이 플러그인을 다시 적은 프로젝트 config는 정책을 조일 수는 있어도 다른 Location의 세션에 대해 풀 수는 없습니다. Location이 닫히면 남은 인스턴스로 다시 계산합니다. 드라이버, helper와 나머지 옵션은 마지막 인스턴스의 값입니다(프로젝트 config는 이미 프로젝트 플러그인으로 서비스 안에서 코드를 실행할 수 있으므로, 믿을 수 없는 저장소는 `own open --untrusted`로 엽니다, §13.2).
  - 핫 리로드로 겹친 두 빌드는 킬스위치 하나를 나누고, 어느 쪽의 중지든 두 빌드가 쥔 입력을 모두 놓습니다. 중지 파일 쓰기는 최대 300 ms만 기다린 뒤 입력을 놓습니다. 플러그인 로드는 워커도 helper도 띄우지 않고, 첫 도구 호출 때 뜹니다(UI Automation 워커는 첫 포커스 조회 때). 데스크톱 워커나 helper가 잡는 이름 있는 뮤텍스 `Local\own-open-code-computer-use`가 개발·운영 서비스가 동시에 데스크톱을 조작하지 못하게 합니다.
  - 릴리스 번들(`packages/own-remote/script/bundle.ts plugins`, `minify: true`)은 FFI 드라이버를 넣은 뒤 327 KB입니다(그 전 299 KB, minify 전 약 575 KB). 아래 가져오기 시간은 299 KB 때 잰 것이고 다시 재지 않았습니다. 워커 코드는 번들 안의 문자열이라 첫 도구 호출 전에는 실행되지 않습니다. 새 Bun 프로세스에서 번들 하나를 `import()`하는 데 103–181 ms(5회, 중앙값 124 ms)였고, 번갈아 잰 own-telemetry 번들(233 KB)은 95–132 ms(중앙값 105 ms)였습니다(2026-10-01, 이 PC, 다른 작업으로 CPU 약 46 %). minify로 크기는 반이 됐지만 가져오는 시간은 거의 그대로입니다. 비용은 대부분 번들마다 가진 `effect` 사본의 평가라 다른 own 번들과 같은 크기입니다.
  - PF6(셸 시작 뒤 90초 입력 지연)는 이 플러그인을 넣고 다시 재지 않았습니다. 패키지 셸과 `perf-shell.ts`(05 §9.4)가 필요합니다. 다음 릴리스 bench에서 잽니다.
- **번들 경계(e2e로 확인)**: 릴리스 번들은 자기 `effect` 사본을 가집니다. Effect API 도구, RPC 핸들러, 훅, fork한 stream은 호스트에서 정상 동작하지만, 호스트는 번들 Effect 스키마의 검사(`Schema.Int` 등)를 실행하지 못합니다. 그래서 도구 입출력은 plain JSON Schema, RPC 정의는 `Portable.definition`입니다. 코어는 출력 스키마를 선언하지 않은 도구 결과의 `output`을 거부합니다(`core/src/tool/runtime.ts:46`).
- **UI**(03 §4.4, §5.7): 세션 헤더 칩(켜진 세션만: `컴퓨터 사용` → 동작 뒤 8초 `PC 조작 중 · <앱>` → `컴퓨터 사용 중지됨`, 옆에 `중지`), 세션 `⋯` 대화상자, 설정 > 실험 패널(상태, `모두 중지`/`다시 허용`, helper 다시 시작, 앱 정책, lease, 세션별 허용 앱, 최근 감사), 설정 > 플러그인의 버전·상태 줄, 사이드바 팀 보기의 `데스크톱 사용 중` 태그(lease를 쥔 세션이 팀 메인이나 담당이면, 03 §4.3, T1). 모두 로컬 서비스의 `status.available`일 때만 보입니다.
- **시험**: `packages/own-computer-use`의 `bun test test/unit`(FakeDriver, 같은 프로토콜을 말하는 가짜 helper, FFI 드라이버의 구조체·입력 레코드·GDI+ 인코더 인자 등 순수 도우미, 워커 소스 구성, 가짜 워커로 본 채널의 시간 초과·충돌·백오프·종료와 드라이버, gate, RPC, 훅), `bun test test/e2e`(own-accounts와 함께 소스로 서버를 띄우고, 다시 빌드된 번들로: 켜기 전에는 도구 없음, 스크린숏이 다음 모델 요청에 들어감, 킬스위치가 막음. Windows에서는 번들을 `driver: "windows"`로 한 번 더 띄워 워커가 번들 소스에서 시작해 `hello`·`cursor.get`·`displays`에 답하는지 확인), 선택 `OWN_CU_REAL=1 bun test test/real`(드라이버마다 한 번. helper 변형은 빌드해 둔 exe가 시작될 때만. fixture는 시스템 `powershell.exe`가 실행하는 WinForms 스크립트라 exe를 컴파일하지 않고, 입력은 그 창에만 보냄).
  - 2026-10-01 모니터 하나(3840x2160, 150%)에서 FFI 드라이버로 실제 데스크톱 시험 15개가 모두 통과했습니다(비밀번호 칸의 UIA `IsPassword`, gate의 `password_field` 거부 포함). helper 변형은 Code Integrity가 exe 시작을 막아(이벤트 3077·3033) 건너뛰었습니다. 측정값(FFI): 워커 시작+`hello` 23 ms(재시작 16 ms), `hello` 왕복 0.5 ms, 창 목록 3 ms, 1429x804 캡처 PNG 331 ms·JPEG 85 308 ms, 3840x2160 캡처 PNG 240 ms·JPEG 85 128 ms, 클릭 동작 30–42 ms, UIA 포커스 조회 첫 회 180 ms 뒤 19 ms(패키지 README). 같은 시험이 예전에 helper로 잰 값은 helper README §5.1입니다. 그때는 시험 14개가 C# fixture로 통과했습니다. own-web 쪽은 `src/computer/computer.test.ts`입니다.
- **알려진 한계**:
  - 대체 엔진 helper는 서명하지 않은 로컬 빌드입니다. Smart App Control이 켜진 PC에서는 막힐 수 있습니다(이 PC에서 새 빌드 9번 중 1번, 미리 빌드한 exe도 한 번). `driver: "helper"`를 쓰려면 코드 서명이 필요할 수 있고, helper 없이 빌드한 릴리스(build-desktop.ps1 3c단계 건너뜀)에서 `driver: "helper"`는 모든 동작이 `driver_unavailable`입니다. 기본 FFI 드라이버는 해당하지 않습니다.
  - 전경 `SendInput`은 실제 커서를 움직이고 사용자와 다툽니다. 사용자 개입 감지가 없고, 화면 표시기(helper `indicator` op)는 아직 gate가 켜지 않습니다. FFI 드라이버에는 표시기가 없습니다(op를 받고 아무것도 하지 않음).
  - FFI 드라이버는 정지 조합을 요청 사이에 알아챕니다(약 50 ms 안, 또는 지금 요청이 끝난 뒤). helper는 별도 UI 스레드에서 바로 처리했습니다.
  - FFI 데스크톱 워커가 네이티브 호출 안에서 멈추면 스레드를 죽일 수 없어 버립니다. 그 호출이 끝날 때까지 그 스레드가 뮤텍스와 정지 조합을 쥐므로 새 워커는 `busy`이고 정지 조합이 없어 입력이 거부됩니다. 서비스가 자연 종료하면 그 호출을 기다립니다(`process.exit`는 기다리지 않음).
  - FFI 드라이버의 창 목록은 `EnumWindows`가 아니라 `GetTopWindow`/`GetWindow`로 z-order를 걷습니다. 그래서 셸의 immersive 창도 나올 수 있지만 cloaked라 `Policy.visible`이 거릅니다.
  - 최소화된 원격 데스크톱 클라이언트 창, 잠금 화면, UAC에서는 `desktop_unavailable`입니다.
  - `key`로 보낸 글자는 한글 IME를 거칩니다(`type`은 `KEYEVENTF_UNICODE`라 거치지 않음).
  - 파일 탐색기 주소 표시줄에 친 글자로 프로그램이 실행될 수 있습니다. 탐색기 창 자체는 막지 않으므로 동의 대화상자에 적어 둡니다. 실행 대화상자는 키 조합과 창으로, 시작 메뉴와 검색은 기본 거부 목록으로 막습니다. 앱은 exe 이름, 창 클래스, own-web 제목으로만 거부하므로 명령을 실행하는 다른 길(브라우저 개발자 도구 콘솔, 편집기의 실행 메뉴)은 `policy.denyApps`로 더해야 합니다.
  - 키보드 재확인은 100 ms 기다린 뒤 하는 확인이지 잠금이 아닙니다. 그보다 늦게 앞으로 오는 창(느린 앱 실행, 늦은 팝업)은 그 호출의 나머지를 받을 수 있습니다.
  - 비밀번호 규칙은 키보드만 봅니다. 오른쪽 클릭 메뉴나 끌어 놓기로 비밀번호 칸에 붙여넣는 것은 막지 못합니다.
  - (T1.34에서 고침) config나 마크다운으로 정의한 에이전트는 코어가 이 플러그인의 setup 변환 뒤에 만듭니다. 이제 늦은 등록(동의 모델 1)이 그 에이전트에도 `{computer,*,deny}`를 붙입니다(e2e로 확인). 늦은 등록이 돌기 전의 짧은 틈에도 세션 스위치를 켜기 전이면 gate가 모든 호출을 `not_enabled`로 거부합니다.
  - 시간 초과로 버린 워커나 죽인 helper가 누른 입력은 다음 워커나 helper로 떼지만, 데스크톱이 입력을 받지 않는 동안에는 실패하고 다음 `releaseAll`에서 다시 시도합니다.
  - 4K 표준 스크린숏은 FFI 드라이버로 약 330 ms(helper 289–505 ms)이고 그중 GDI+ bicubic 축소가 약 160–200 ms라 두 엔진이 비슷합니다. 원본 해상도 캡처와 시작은 FFI가 빠릅니다(시작 약 20 ms, helper 재시작 125–270 ms, 새 helper 빌드 첫 실행 0.8–1.3 s).
  - 혼합 DPI·음수 원점 다중 모니터, UWP·Chromium·Electron 대상, 다른 앱의 한글 IME, 관리자 권한 창, 표시기의 캡처 제외는 아직 실측하지 않았습니다.
- **단계**:
  1. **1단계(완료, 2026-10-01)**: core, FakeDriver, 도구, gate, RPC, 단위 시험 → C# helper, WindowsDriver, 실제 데스크톱 시험 → own-accounts 세션 스위치, own-web 패널·토글·칩 → 번들·desktop 빌드·launcher(0.5.0, 새 번들 항목 삽입) → 같은 날 기본 엔진을 프로세스 안 FFI 드라이버로 바꿈(helper는 대체 엔진).
  2. **2단계(후속)**: UI Automation 앱 상태 도구(Codex식 `get_app_state{app, max_nodes}`, `ui_click{app, element_index}`, `set_value{app, element_index, value}`)와 앱별 백그라운드 전달(UIA 패턴, PostMessage). 사용자 개입 감지(주입 플래그를 무시하는 저수준 훅)와 표시기 구동(FFI 드라이버에는 표시기 창이 아직 없음), 캡처 축소를 GDI `HALFTONE` `StretchBlt`로 줄이기, 스크린숏 보관 정책, (helper를 다시 쓸 때) helper 코드 서명.
  3. **3단계(후속, 선택)**: `cua-driver` Driver 어댑터(사용자가 설치한 `cua-driver mcp`를 stdio MCP로 부름, 번들하지 않음). 앱별 "항상 허용" ask가 필요하면 플러그인의 `permission.assert`(upstream v2.0.32부터 플러그인에 열림, 6a7cedcbf1. 코어 패치가 필요 없음), 또는 `@opencode/ai`의 provider 고유 computer 도구(OpenAI `computer`, Anthropic `computer_toolset`).

---

## 11. SSH 원격

설계는 **`04-ssh-remote.md`가 기준**입니다. 이 절은 요약과, 데스크톱 셸·모바일과의 정렬(결정 D8)만 둡니다.
- 원격 호스트(Linux)마다 own 채널 service 하나를 원격의 `127.0.0.1`에만 띄웁니다. 에이전트, 셸·파일 도구, PTY는 원격에서 돌고, 원격 세션의 원본은 원격 DB입니다(04 §5, §6).
- SSH는 로컬 service 안의 플러그인 `own-remote`가 돌립니다. 호스트당 `ssh.exe` 하나가 `-L`(원격 API)과 `-R`(자격 증명 브로커)을 듭니다. 원격 끝점은 `127.0.0.1`이 아니라 호스트별 loopback 주소에 둡니다(04 §4, §7).
- 원격도 **로컬 계정을 그대로** 씁니다.
  - 로컬 브로커가 요청마다 인증 헤더를 짧은 lease로 줍니다.
  - refresh token과 vault는 원격에 가지 않습니다. 연결이 없으면 fail closed입니다(04 §8).
  - 이전 판의 "원격은 자기 vault, 로컬 비밀을 보내지 않음"은 이것으로 바뀌었습니다.
- ledger와 한도의 writer는 로컬 하나입니다. own-web은 서버 레지스트리로 로컬과 원격 세션을 한 사이드바에 모읍니다(04 §10, §12).
- **무엇이 어디서 도는가 (결정 D8)**

  | 일 | 위치 | 비고 |
  |---|---|---|
  | ssh.exe 터널, 설치, askpass 중계, 원격 세션 토큰 서명 | 로컬 service의 own-remote(프로세스 수명 런타임) | 창을 닫아도 터널이 삽니다 |
  | 자격 증명 브로커, lease | 로컬 service의 own-runtime | provider 비밀은 여기서만 헤더가 됩니다 |
  | 서버 레지스트리, 사이드바 통합, 폴더 선택, 호스트 키·비밀번호 프롬프트 UI | own-web(렌더러) | askpass 요청은 `own.remote` 이벤트로 받습니다 |
  | 원격 API 호출 | 렌더러 → `http://127.0.<k>.2:LP` | 토큰은 `own.remote.resolve`로 받아 렌더러가 직접 붙입니다. 데스크톱의 CORS는 main이 렌더러 session의 모든 응답을 `Access-Control-Allow-Origin: *`로 덮어써서 통과합니다(`packages/desktop/src/main/windows/security.ts:54-58`, `windows/headers.ts:10-20`). 원격 서버의 CORS 설정과 무관합니다. 웹 폴백은 원격 서버 기본 CORS의 `http://127.0.0.1:*` 허용으로 통과합니다(`packages/server/src/cors.ts:13-14`) |
  | 원격 세션의 브라우저 패인 attach | Electron main → 원격 plugin-browser | own-web이 원격 토큰을 register IPC로 넘깁니다. main은 메모리에만 둡니다(§10.1 "원격 세션 패인의 자격 증명") |
  | Electron main | **SSH 일을 하지 않음** | 아래 참고 |

- **SSH를 Electron main에서 돌리지 않는 이유** `[desktop-verdict §6]`
  - 터널이 창의 수명에 묶입니다.
  - upstream은 원격에 npm의 upstream CLI를 설치합니다(`packages/desktop/src/main/remote/cli.ts:71`).
  - upstream은 자격 증명을 서버마다 따로 저장하고, 자격 증명 브로커가 없습니다.
- **upstream 데스크톱의 Ssh/Wsl 레이어는 비활성입니다.**
  - 두 레이어는 `Ipc.layer`에 묶여 import됩니다(`packages/desktop/src/main/ipc.ts:28`).
  - own-web이 그 IPC를 부르지 않으면 저장 목록이 비어 아무것도 하지 않습니다(`ssh/service.ts:32`, `wsl/start.ts:75`). own-web은 SSH 저장 IPC를 부르지 않습니다.
  - WSL sidecar는 `0.0.0.0`에 바인딩하므로(`wsl/sidecar.ts:35`) 계속 쓰지 않습니다(`[gap]` 42는 나중).
- **로컬 비밀번호 누출 없음.** main의 Basic 주입은 로컬 서비스 origin과 정확히 같은 요청에만 붙습니다. 그래서 `127.0.<k>.2`로 가는 요청에는 붙지 않습니다(§6.1). 패인도 로컬 sidecar origin일 때만 `SidecarCredentials`를 쓰고, 원격이면 own-web이 준 원격 토큰을 씁니다(`browser-pane.ts:89-90,119-124`).
- **브라우저 패인**: 원격 세션의 패인은 원격 plugin-browser 터널로 나가므로 탭 트래픽이 원격 호스트에서 나가고, 원격 localhost dev 서버에 바로 붙을 수 있다고 봅니다 ⚠(05 §8.6, 04 §7.6, G-D5 원격 시나리오).
- **모바일(P8)**: 휴대폰은 원격 호스트에 직접 닿지 않습니다. PC의 게이트웨이를 거쳐 원격 세션을 보고 조작합니다(§6.4 4, 05 §12·§13.4). 원격 토큰은 기기에 가지 않습니다.

---

## 12. 플러그인 대 코어 패치 결정

### 12.1 판단 규칙
1. 플러그인 API, 설정, HTTP API로 가능하면 **패치하지 않습니다**.
2. 패치는 **파일당 30줄 이하**, 최근 30일 upstream 커밋 **5회 이하**인 파일에만 합니다. 예외는 ledger에 사유를 적고 upstream PR(또는 issue)을 먼저 올린 경우입니다.
3. 패치마다 `// OWN-PATCH(P-xxx) begin/end` 마커를 달고, 커밋은 `own-patch(P-xxx): …` 1개로 만듭니다. ledger(`own/ledger/core-patches.yaml`)에 기록합니다.
4. **예산**
   - 처음 계획은 데스크톱 모드(기본 제품) **0개**, 웹 폴백 전용 계획 패치 2개(P-001/P-002)였습니다.
   - 2026-10-11에 활성인 패치는 P-001, P-002, P-014–P-018 7개였고, 기본 제품도 P-014–P-018을 씁니다(§12.2). 지금(2026-10-22)은 22개입니다. P-019–P-033은 §12.2 표에 없고, ledger와 `own/FORK.md` §6.1 5번이 정본입니다.
   - 동시에 활성인 패치는 최대 6개입니다. P-018은 2026-10-11 사용자가 한도를 넘겨 승인한 예외(ledger `over_budget`·`exception_approval`)라 셈에서 빠집니다. 그 밖의 패치를 더 넣으려면 하나를 먼저 내립니다(`own/FORK.md` §6.1).
   - 데스크톱 셸의 vendor, 빌드 시 치환, deep import는 upstream 추적 파일을 고치지 않으므로 패치가 아닙니다. `vendored.yaml`과 `upstream-surface.json`으로 관리합니다(§4.1).
   - 브라우저 도구의 세션 권한(§10.1)은 upstream 세션 API로, auto-compaction 차등(R16)은 플러그인만으로 합니다.
5. ID는 ledger의 `P-0xx`가 정본이고 02·03도 이 ID를 씁니다. 02 §10의 원장 미등재 후보(`cand-*`)가 가리키는 패치는 "02 임시 이름" 열에 적습니다.

### 12.2 코어 패치 예산표

churn30 = 2026-08-27부터 2026-09-26까지 `upstream-v2`에서 해당 파일을 건드린 커밋 수(로컬에서 `git log upstream-v2 --since=2026-08-27 -- <file>`로 측정).

| ID | 02 임시 이름 | 상태 | 파일 | 이유 | 크기 | churn30 | upstream PR 후보 |
|---|---|---|---|---|---|---|---|
| **P-001** | – | **planned (웹 폴백 전용, P3에서 활성)** | `packages/cli/script/app-assets.ts:8` | 임베드할 웹 앱 루트를 `process.env.OPENCODE_WEB_APP ?? "app"`로 선택. 웹 폴백(`own open --browser`)에서 own-web을 same-origin으로 서빙해 pairing 쿠키 사용. **데스크톱 모드에는 필요 없음**(렌더러는 `oc://renderer`, §6.1) | 1–2줄 | 2 | **예** (포크와 커스텀 UI용 빌드 노브) |
| **P-002** | – | **planned (웹 폴백 전용)** | `packages/cli/src/app-assets.ts:22` | local 채널(소스 실행)에서 같은 선택 | 1–2줄 | 1 | **예** (P-001과 같은 PR) |
| P-003 | – | candidate (G1 실패 시) | `packages/util/src/global.ts:12` | 채널별 앱 루트(`own-open-code`)로 config/data/state/cache를 완전 격리. env 브리지(§5.2)로도 부족할 때 | 3–5줄 | 0 | 보류 (범용 `OPENCODE_APP_NAME` define이면 가능) |
| P-004 | – | candidate (G8 실패 시, **예외 승인 필요**) | `packages/ai/src/route/executor.ts`, `packages/schema/src/session-error.ts`, `packages/core/src/session/to-session-error.ts` | retry 이벤트와 SessionError에 `retryAfterMs`와 rate-limit 상세를 싣기. 지금은 `{type,message,status}`뿐. `to-session-error.ts`가 churn 6으로 규칙(≤5)을 넘으므로, 켤 때는 core 쪽 변경을 매핑 1–2줄로 줄이고 나머지를 `schema`(0)·`ai`(3) 쪽에 두거나 예외 승인을 받음 | 약 25줄 | 3 / 0 / **6** | 예 |
| P-005 | – | candidate (G7 실패 시, **예외 승인 필요**) | `packages/core/src/session/model-request.ts` | WS handshake **응답** 헤더를 훅으로 노출(`experimental.ws.opened`). Codex 한도를 WS 경로에서 읽기 위함 | 약 15줄 | **18 (hot)** | 예. 대안: in-band `codex.rate_limits`, 또는 해당 계정만 HTTP transport(증분 전송 손실) |
| P-006 | – | candidate (후속) | `packages/core/src/session/usage.ts` (+ schema) | 1h cache write 분리와 TTL 반영 비용 계산 | 약 20줄 | 2 | 예 |
| P-007 | – | rejected (재검토 조건: G2 실패, 또는 세션 밖 호출 지원이 필요할 때) | `packages/core/src/model-resolver.ts` | 요청별 credential 선택 훅. `generate.text` 같은 세션 밖 호출까지 덮는 **유일한** 방법(§8.3). 관련 upstream 이슈: 계정 전환이 서버 전역이라는 anomalyco/opencode#50556(2026-09-22) | 약 30줄 | **17** | 예 |
| P-008 | – | rejected | `packages/core/src/plugin/host.ts` | 플러그인 `session.compact/fork`, `update(metadata)` | – | **23** | – (프런트가 HTTP로 처리) |
| P-009 | – | rejected | `packages/core/src/plugin/provider/openai.ts` | ChatGPT OAuth 구현 export | – | 13 | – (own-accounts에서 재구현) |
| P-010 | – | rejected | `packages/core/src/credential.ts`, `packages/core/src/kv.ts` | DPAPI at-rest 암호화 레이어 | – | 2 / 1 | – (vault로 우회. 기본 모드에서 우리 비밀은 DB에 없음) |
| P-011 | `cand-cache-policy` | candidate (후속, **예외 승인 필요**) | `packages/core/src/session/model-request.ts` | 훅에서 요청 단위 `cache` 정책(TTL 포함) 지정. R9 1h 모드를 수동 hint 4개 없이 일반화 | 약 10줄 | **18 (hot)** | 예(upstream 제안 우선) |
| P-012 | `cand-refresh-lock` | candidate (대체 모드 사용 시) | `packages/core/src/integration.ts` | credential별 refresh 세마포어 | 약 15줄 | **10** | 예 |
| P-013 | `cand-generate-model` | candidate (후속) | `packages/core/src/session/generate.ts` | 세션 `generate`에 model 지정 | 약 10줄 | **6** | 예 |
| **P-014** | – | **active** (2026-09-28) | `packages/cli/src/bootstrap.ts`, `packages/cli/script/build.ts` | 혼자 쓴 `--version`/`-v`에 작은 컴파일 entry가 바로 답함. launcher가 서비스 시작 전마다 하는 버전 확인이 2.5초 걸리던 명령 런타임 초기화를 건너뜀 | 15 + 2줄 | 0 / 0 | 예 |
| **P-015** | – | **active** (2026-10-05, 결정 D1) | `packages/core/src/shell/select.ts` (+ 시험) | Windows에서 pwsh/powershell `-Command` 앞에 UTF-8 출력 설정을 붙임. 콘솔 없는 서비스의 PowerShell이 OEM 코드 페이지(CP949)로 써서 한글이 U+FFFD가 되던 문제 | 6줄 | 2 | 예(올리려면 사용자 승인) |
| **P-016** | – | **active** (2026-10-06, GW-P14. 2026-10-07 실측으로 밀도 확정·승인) | `packages/core/src/util/token.ts` (+ 시험) | `Token.estimate`가 한글을 0.65토큰, 그 밖의 CJK를 0.6토큰, 나머지를 글자/4로 셈. 한국어가 실제의 약 40%로 어림되어 압축이 늦던 문제 | 11줄 | 0 | 예(올리려면 사용자 승인) |
| **P-017** | – | **active** (2026-10-06, GW-P17A, **예외 승인 필요**) | `packages/core/src/session/compaction.ts` (+ 시험) | 같은 카탈로그 모델 id를 쓰는 다른 provider(own 계정 slot)의 측정값을 압축 추정의 기준으로 씀. 계정을 바꿀 때마다 기록 전체를 글자로 어림하던 문제 | 25줄 | **17** | 예(먼저 올려야 하는 예외, 사용자 승인) |
| **P-018** | – | **active** (2026-10-11, **한도 초과 예외, 사용자 승인**) | `packages/ai/src/route/client.ts`, `packages/ai/src/schema/options.ts`, `packages/core/src/provider.ts`, `packages/core/src/location-activity.ts`, `packages/core/src/session/execution.ts` (+ 시험 4개) | 파싱한 모델 이벤트 기준의 진전 감시: 진전 없음 5분, 도구 입력이 열린 동안 2분(열림 최대 10분·100만 자), Responses는 시도당 15분. 걸리면 재시도 가능한 read timeout으로 끊어 기존 재시도·이어 하기(timeout 최대 3회)가 돌게 함. provider·모델 설정 `progressTimeout`·`toolInputTimeout`. LocationActivity는 실행 중인 세션을 멈추지 않고, 그래도 inactivity로 끝나면 보이는 실패(`session.inactivity`)로 남김. chunk timeout을 끈 경로(compat slot)는 SSE 주석만 5분 온 본문을 끊음(`packages/ai/src/route/executor.ts`, 2026-11-27 RL31). keepalive만 오는 스트림이 60분 뒤 사용자 중지처럼 조용히 끝나던 문제(2026-10-11 사고) | 83 + 20 + 13 + 3 + 12줄 | 5 / **6** / **12** / 0 / 3 | 예(올리려면 사용자 승인) |

- **팀 모드(06)와 프리셋(07)이 쓰는 코어 패치는 0개입니다(T1에서 확인, check-ledger).** 다만 2026-10-28부터는 own 플러그인 모두가 P-037에 기댑니다. own-runtime이 control location을 core의 한 시간 정리에서 빼 두므로, 원격 팀의 control location도 한 시간 넘게 일하는 동안 내려가지 않습니다(04 §4.1, 결정 RH-13). 06의 스냅샷 재맞춤은 패치 후보로도 넣지 않고 화면 문구로 알립니다(06 §12.2). 둘이 기대는 upstream 동작은 `own/upstream-surface.json`의 `subagent-*`, `tool-*`, `agent-*`, `permission-evaluate-hook`, `hook-scope-filter`, `instruction-entry-rendering`, `session-child-inherits`, `service-session-http-api`, `team-*` 항목이 지킵니다(`own/FORK.md` §7). 07 PG3가 실패하면 마지막 대안으로 gpt.txt 위임 문장을 세션 설정으로 바꾸는 후보를 원장에 적습니다(07 §8.4).
- **P-001/P-002는 웹 폴백 전용입니다.** 웹 폴백은 결정 D1로 유지하므로 둘은 남깁니다. P-014–P-018은 기본 제품에도 쓰이고 각자 제거 조건(`remove_when`)이 ledger에 있습니다. 패치 없는 대안도 있습니다. P8 게이트웨이(05 §13.4)가 `app\<version>\web`을 같은 origin으로 서빙하고 API를 중계하는 방식입니다. 게이트웨이가 생기면 재검토합니다(§20, 05 §19 질문 20).
- **벤더 복사**(패치가 아니라 복사본). 출처 커밋과 해시는 `own/ledger/vendored.yaml`에 기록합니다.
  - own-web이 `packages/app`에서 가져오는 `virtualizer.tsx`, `observe-element-offset.ts`, `suggestions/machine.ts` 등
  - 성능 하네스 `packages/app/e2e/performance`의 픽스처(§6.6)
  - own-desktop의 `index.ts`, `desktop.ts`(vendor)와 `constants.ts`, `lifecycle/environment.ts`(치환)(§4.1)
  - own-remote의 SSH 모듈(04 §4.3)
- **생성 파일**: `bun.lock`은 ledger 예외입니다. merge할 때 theirs를 택하고 재생성합니다.

---

## 13. 보안 모델

**위협 모델의 전제.** 같은 사용자 권한으로 실행되는 코드(에이전트의 셸 도구 포함)는 결국 비밀에 접근할 수 **있습니다**. DPAPI CurrentUser도 같은 사용자라면 복호화할 수 있습니다. 목표는 다음 여덟 가지이고, 절대적인 격리는 주장하지 않습니다.
- (1) 저장 매체, 백업, DB 덤프에서 평문이 새지 않게 한다
- (2) 셸 도구 env로 비밀이 **자동 상속되지 않게** 한다
- (3) 로그, 이벤트, API 응답에 비밀이 섞이지 않게 한다
- (4) 다른 사용자와 LAN을 차단한다
- (5) 서드파티 플러그인(claude-auth)이 닿는 범위를 최소화한다
- (6) **프로젝트 단위 플러그인(= 프로세스 내 임의 코드 실행)**이 우리 인증 헤더를 받지 못하게, 승인 전에는 주입을 멈춘다(§13.2)
- (7) 렌더러, 브라우저 패인의 웹 페이지, (P8) 원격 기기가 서비스 비밀번호와 provider 비밀을 받지 못하게 한다(§13.3, §13.4). 셸 main은 서비스 비밀번호와 원격 세션 패인의 원격 서버 토큰만 메모리에 가진다(§10.1)
- (8) OS 통합(URL 스킴, 앱 id, userData, 업데이터)이 upstream 설치본과 섞이거나 그것을 가로채지 않게 한다(§13.3)

| 영역 | 규칙 |
|---|---|
| 네트워크 | 규칙은 다음과 같습니다.<br>- `hostname: 127.0.0.1` 고정. `0.0.0.0`과 LAN 노출 금지(Basic이 평문 HTTP이고, `fs.*`가 절대 경로를 받음)<br>- SSH 원격은 `ssh -L`과 `-R` 브로커로만. 원격 브로커 소켓은 0600이고 HMAC을 씀. 키는 arm으로 메모리에만 둠(04 §7.4, §8.3)<br>- 원격이 내용을 만드는 끝점은 `127.0.0.1`에 두지 않음(04 §7.3)<br>- (P8) 게이트웨이도 `127.0.0.1`에만 두고, 기기 경로는 `tailscale serve`로만 붙임(§6.4, 05 §13.3)<br>- Codex 최신 버전 확인(07 §4.5 CA)은 계정 끝점이 아닌 `GET https://registry.npmjs.org/@openai/codex/latest`로 나간다. ChatGPT 구독 계정이 있을 때 하루 한 번, `accept`와 고정 `user-agent`만 보내고(자격 증명·쿠키·계정·경로 없음) 답의 `version`만 읽는다. 서비스의 프록시 설정을 따르고, 설정 `Codex 최신 모델 자동 확인`을 끄면 보내지 않는다 |
| 서버 인증 | upstream의 Basic, pair 쿠키, 30일 토큰. pairing 코드는 1회용이고 5분짜리. 쿠키는 same-origin만 받으므로 CSRF에 강함. 데스크톱은 쿠키를 쓰지 않고 main이 Basic을 주입함(§6.1) |
| **비밀 저장** | **DPAPI CurrentUser + entropy `"own-open-code/v1/" + accountId`** 파일 vault(기본, `own-vault.exe`), §13.1. 평문 DB 저장은 Claude 구독 슬롯(서드파티 자체 동작)과 명시적으로 표시되는 대체 모드(02 §3.7)뿐. 사용자가 core의 키 UI로 넣는 upstream 검색 서비스 키(Exa 등)는 core의 credential 표에 평문이므로, Brave 키와 upstream 검색 서비스의 키(2026-10-23 SK)는 그 길을 쓰지 않고 vault의 기능 키(`websearch-<서비스>`)다(아래 웹 검색 행). linked Codex 계정은 이전 앱의 파일을 읽기만 함(§8.4) |
| 비밀 전달 | runtime vault client → 백엔드(기본 `own-vault.exe`): stdin/stdout JSON-lines. helper는 최소 env로 실행하고 인자로 비밀을 넘기지 않음 |
| 비밀 사용 | `model.request` 훅에서 **요청마다 헤더로만** 주입합니다. 넣지 않는 곳은 다음과 같습니다.<br>- provider/model overlay(`GET /api/provider`가 마스킹 없이 반환, `packages/server/src/handlers/provider.ts:12-29`)<br>- KV, DB, env, 로그, RPC 출력, 이벤트, 렌더러, 셸 IPC<br><br>UI에는 지문(`sk-…ab12`)과 해시 앞자리만 표시합니다. 예외는 SSH 원격의 lease(메모리에만, 짧은 수명, 04 §8.5)입니다 |
| env 위생 | launcher가 provider 키 env를 제거한 상태로 service를 띄움. 셸 도구 자식 프로세스가 env를 상속하므로 `echo $env:KEY`로 유출될 수 있음 `[research critique #19]`. env 정리는 launcher 한 곳에서만 합니다. own-desktop의 `own-env`는 스냅샷을 그대로 launcher에 넘기고 키를 지우거나 더하지 않습니다(05 §5.2) |
| 에이전트 접근 | 기본 권한은 shell `ask`입니다. 어느 승인 모드에서나(모드를 정하지 않은 세션, 하위 에이전트, 팀 영역 포함) 파일 도구의 read/write(`read`·`edit`)를 거절하는 보호 경로는 다음과 같습니다. 이것은 심층 방어이며, 셸로 우회할 수 있음을 전제합니다.<br>- own의 자리: `OWN_HOME\vault\`, `opencode-own.db*`, 등록 파일과 서비스 설정 파일, `%USERPROFILE%\.claude\.credentials.json`, linked codex source 디렉터리(`...\control-center\profiles\`). 승인 모드 묶음의 끝에 deny 규칙으로도 붙습니다(03 §18.8)<br>- 기본 목록(PP, 2026-11-07, own-accounts `src/protection/builtin.ts` 한 곳, 항목마다 이유): SSH·GPG 키, 다른 AI 도구의 로그인·계정 파일(`~/.claude.json*`, `~/.codex/auth.json`, Gemini CLI, Qwen Code, GitHub Copilot, Grok CLI, 다른 OpenCode. 스킬·`AGENTS.md`·설정 폴더는 빼고), 개발 도구 자격 증명(`~/.git-credentials`, gh, `.netrc`·`_netrc`, 홈 폴더의 `.npmrc`, `.pypirc`, Docker, AWS, Azure, kube, cargo, adb 키, 에뮬레이터 토큰), OS 자격 증명 저장소(Windows Credentials·Protect·Vault, macOS 키체인, GNOME 키링), 브라우저 프로필, 암호화폐 지갑, 셸 명령 기록. 서비스가 도는 사용자의 홈 폴더와 그 OS의 앱 데이터 폴더를 기준으로 놓습니다<br>- 사용자 목록: 설정 > 승인·권한 `에이전트가 못 여는 파일·폴더`. 서비스마다(SSH 호스트도 따로) own-accounts KV에 두고, 이 PC의 창에서만 바꿉니다(`local`)<br>기본 목록과 사용자 목록은 세션 규칙으로 쓰지 않고 own-accounts의 permission `evaluate` 훅이 모든 세션에 다음 도구 호출부터 적용합니다. 규칙·도구 목록·프롬프트가 바뀌지 않아 캐시가 그대로입니다. 같은 파일의 다른 표기(대소문자, 8.3 짧은 이름, 프로젝트 안의 링크·정션, `\\?\` 접두사, 관리 공유, NTFS 스트림)도 같은 자리로 읽고, 보호 폴더를 셸의 작업 폴더로 삼는 것(`cd`, `workdir`)도 거절합니다. 셸 명령의 글이 보호 경로를 직접 가리키면 `전체 허용`에서도 `ask`가 되고 그 카드에는 `항상 허용`이 없습니다. 이것은 최선 노력이라 변수·와일드카드·스크립트 파일·위 폴더 검색 같은 간접 참조와 사람이 없는 예약 확인 코드는 보지 못합니다(02 §9.2). 읽기 전용에서 Codex 방식이 직접 답하는 읽기도 파일 도구와 같은 `read` 규칙을 따릅니다(실제 경로까지 확인, 10 §3.10). |
| RPC | 서버 인증 뒤에 있음. RPC id는 `own.accounts`, `own.remote`, `own.team`(06, own-team이 나오면), `own.computer`, `own.import`(09, IMPORT부터) 다섯. 비밀을 받는 메서드는 `accounts.add.key`, `accounts.update{replaceKey}`, 기능 키의 `voice.key.set`, `websearch.key.set` 넷뿐이고 모두 `local`이다(02 §9.1). 파괴적 동작(계정 삭제, 플러그인 설치·제거, 프로젝트 플러그인 승인, takeover, ChatGPT 리셋권 쓰기 `quota.resetCredits.redeem.*`(`local`, 02 §7.1.1))은 UI 확인 대화상자 뒤에서만 호출 |
| upstream 연결 API | own-web은 `POST /api/credential/:id/activate`, `/api/integration/*/connect/*`, `POST /api/location/reload`를 부르지 않습니다(03 §16.3 lint).<br>**예외 하나**: MCP 인증 필요 서버의 로그인입니다(`[gap]` 14). 허용 조건은 다음과 같습니다.<br>- 호출은 `integration.oauth.connect`만<br>- `integrationID`는 `mcp.list` 응답에 있는 값만<br>- 형식이 `mcp_<16 hex>`인 것만(`packages/core/src/mcp/index.ts:170-176`)<br><br>MCP 통합은 provider와 id가 달라서 우리 slot이나 전역 active에 영향이 없습니다. `Credential.create`는 같은 integration 안에서만 다른 credential을 끕니다(`credential.ts:108-124`). key connect와 activate는 계속 금지입니다 |
| 웹 검색(2026-10-19) | 에이전트의 `websearch` 검색어는 사용자가 고른 검색 서비스 한 곳으로만 간다. `여러 서비스 함께`(`own-multi`, MS)를 고르면 거기서 체크한 서비스 모두에 같은 검색어가 가고, 서비스마다 아래와 같은 요청이며 새 호스트는 없다(03 §18.2). own-accounts가 직접 부르는 곳은 셋이다(02 §9.2 표).<br>- `own-chatgpt`: `POST https://chatgpt.com/backend-api/codex/responses`. 검색어와 그 ChatGPT 계정의 로그인<br>- `own-deepseek`: `POST https://api.deepseek.com/v1/tools/search`. 128자로 자른 검색어와 `ds` 계정 키(`Authorization`). 서버가 중국에 있고 입력이 학습에 쓰일 수 있어 기본이 되지 않는다<br>- `brave`: `GET https://api.search.brave.com/res/v1/web/search`. 400자로 자른 검색어(`q`)와 사용자의 Brave 키(`X-Subscription-Token`). 키는 own vault의 기능 키 `websearch-brave`(DPAPI, 음성 키와 같은 방식)이고 이 PC의 창에서 `websearch.key.set`(`local`)으로만 넣는다. core의 integration·credential 표에도, 환경 변수에도 두지 않는다<br>- `own-exa`·`own-firecrawl`·`own-parallel`·`own-tavily`·`own-tinyfish`(2026-10-23 SK): 사용자의 키로 core의 같은 서비스와 같은 주소에 같은 요청을 보낸다(Exa는 `exaApiKey` 질의 매개변수, Firecrawl·Parallel·Tavily는 `Authorization: Bearer`, TinyFish는 `X-API-Key`). 키는 Brave 키와 같은 방식(own vault `websearch-<서비스>`, `websearch.key.set` `local`)이다. own-web이 core의 key connect를 부르지 않는 규칙(위 행)은 그대로다<br>키와 검색어는 로그·원장·이벤트에 남지 않는다(Exa의 요청 주소에는 키가 있어 주소도 남기지 않는다). 키 없는 upstream의 Exa·Firecrawl·Parallel·Tavily·TinyFish 끝점은 core의 것이다 |
| 서드파티 | 명시적 설치와 동의, lockfile integrity pin, `--ignore-scripts`, 조정 env 금지, 훅 범위 계약(§9.3). 우리는 번들하거나 재배포하지 않음 |
| 프로젝트 플러그인 | Location별 allowlist, 미승인 시 주입 중지, `--untrusted` 모드(§13.2). 원격 호스트는 프로젝트 설정을 기본으로 끔(04 §5.6) |
| 데스크톱 셸 | §13.3 |
| 원격 기기(P8) | §13.4 |
| 로그 | 플러그인 로거가 비밀 패턴을 마스킹합니다.<br>- 기본 패턴: http-recorder 패턴(`packages/http-recorder/src/redaction/secrets.ts:3-11`: Bearer, `sk-`, `sk-ant-`, Google, AWS, GitHub, private key)<br>- 추가 패턴: **`xai-[A-Za-z0-9]{20,}`와 JWT `eyJ[\w-]+\.[\w-]+\.[\w-]+`**<br>- OAuth 토큰 엔드포인트 응답은 access/refresh/id token이 Bearer 헤더 밖 JSON 본문에 옵니다. own-accounts가 **로깅 전에** 필드 단위로 지웁니다.<br>- 이 패턴들은 G14 스캔에도 넣습니다. 셸 로그(electron-log)도 스캔 대상입니다 |
| 공유 | 전역 config에 `"share": "disabled"` (`packages/schema/src/config.ts:41`) |

### 13.1 비밀 저장소 결정: DPAPI 파일 vault

- **파일 형식과 위치**는 02 §2.4.5를 따릅니다: `vault\<accountId>.dpapi`(+`.prev`, `.lock`), DPAPI CurrentUser, `optionalEntropy = "own-open-code/v1/" + accountId`.
- **백엔드(기본)**: 작은 Rust helper `own-vault.exe`(`windows` crate, 약 150줄)가 stdio로 get/put/delete/list를 처리합니다(02 §2.4.5와 같음). runtime 싱글턴이 프로세스당 helper 하나를 장수 자식 프로세스로 두고(참조 카운트, §4), helper가 죽으면 다시 띄우고, 서버가 끝나면 stdin EOF로 함께 종료됩니다. helper 동작은 AC-P21로 검증합니다.
- **대안을 기각한 이유**
  - **Windows Credential Manager**: blob 크기 상한이 `CRED_MAX_CREDENTIAL_BLOB_SIZE`(5×512 = 2,560 bytes)입니다. ChatGPT OAuth 번들(access JWT + refresh + id token)은 이 크기를 넘을 수 있어 분할해야 합니다. Node 바인딩(keytar)은 보관(archived) 상태입니다.
  - **`bun:ffi`만 쓰는 안**: experimental이고, 플러그인이 Bun 런타임에 묶입니다(upstream에는 Node 런타임 경로도 있음). helper 검증(AC-P21)이 실패할 때만 재검토합니다.
  - **PowerShell `ProtectedData`만 쓰는 안**: 호출당 수백 ms가 걸리고, 실행 정책과 AMSI 변수가 있습니다.
- **이점**
  - 이전 프로젝트에 DPAPI 선례가 있어 포팅이 쉽습니다(`D:\#Projects\codex-multi-provider\scripts\manager_core\providers.py:176`, `runtime_admin.py:623,758`).
  - helper만 따로 테스트할 수 있습니다.
  - Linux(SSH 원격)에서는 같은 프로토콜로 backend만 바꾸면 됩니다.
- **파일 쓰기**: 임시 파일에 쓴 뒤 `MoveFileEx(MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)`로 교체합니다. refresh 경합은 runtime single-flight와 lease 파일로 직렬화합니다(02 F2–F4).

### 13.2 프로젝트 플러그인 = 프로세스 내 코드 실행

- **사실**
  - upstream은 모든 config 디렉터리 항목(프로젝트 `.opencode` 포함)의 `plugin/`, `plugins/`를 자동으로 발견합니다(`packages/core/src/config/plugin/source.ts:122-133`, `packages/core/src/plugin/source-directory.ts:7-33`). `.ts`/`.js` 파일과 하위 디렉터리가 모두 대상입니다.
  - 발견된 플러그인은 설정된 플러그인보다 **앞**에 놓입니다("Explicit config is applied last", `source.ts:158-159`). 즉 own-accounts보다 먼저 setup되고, 같은 서비스 프로세스 안에서 실행됩니다.
  - 그래서 클론한 저장소에 `.opencode/plugins/x.ts`가 있으면 그 프로젝트를 여는 것만으로 서비스 안에서 임의 코드가 돕니다. 이 코드는 unscoped `http.request` 훅을 등록해 **auth 이후의 Request**(우리가 넣은 Bearer / x-api-key 포함)를 받을 수 있고(`packages/core/src/session/model-request.ts:299-305`), `globalThis`의 runtime 싱글턴에도 닿을 수 있습니다.
  - 이 저장소 자체도 `.opencode/`(`plugins/`, `tool/` 포함)를 가지고 있습니다.
- **완화책**
  - (a) **Location별 allowlist, fail closed.** own-accounts는 각 Location에서 `ctx.plugin.list()`(`host.ts:419-421`; 항목은 `{id, source: builtin | package{target} | local{path} | sdk}`, `packages/schema/src/plugin.ts:10-43`)를 검사합니다. 허용: builtin, `app\<version>\plugins\` 아래의 own 플러그인과 앱에 든 claude-auth(`app\<version>\plugins\claude-auth`, 소스 실행이면 `own/.out/claude-auth`), Claude 상태 폴더 `thirdparty\claude-auth`, 그리고 `trust.json`에 `{location, source, sha256}`로 승인된 항목. 그 밖의 플러그인이 있으면 그 Location에서는 **인증 헤더를 주입하지 않고**(요청은 401로 보이게 실패), 경보 `untrusted_plugin`과 Location 상태 `blocked_by_plugin`을 냅니다. 사용자가 UI에서 승인하면 풀립니다. `plugin.updated` 이벤트마다 다시 검사합니다. 승인한 파일의 해시가 바뀌면 다시 막습니다.
  - (b) **`own open --untrusted`**: 서비스를 `OPENCODE_CONFIG_PROJECT_DISABLE=1`로 띄웁니다(`packages/cli/src/server-process.ts:110-112`). 프로젝트 config 전체가 꺼지는 서비스 전역 모드입니다(§5.3).
  - (c) **싱글턴에 raw 비밀 getter를 두지 않습니다.** 싱글턴은 `headersFor(providerID, kind, sessionID)`처럼 헤더를 만드는 함수만 노출하고, 복호화된 값과 vault 파이프는 클로저 안에 둡니다.
- **정직한 한계.** 위 조치는 **악의적인 in-process 플러그인을 막지 못합니다.** 그런 코드는 own-accounts보다 먼저 실행되고, `globalThis`와 모듈 로더를 조작하거나 헤더 함수를 직접 부를 수 있습니다. (a)는 "모르는 플러그인이 있는 동안 우리가 먼저 비밀을 흘려보내지 않는다"는 것까지만 보장합니다. 믿을 수 없는 저장소는 (b) 모드로 열어야 합니다. UI의 플러그인 화면은 이 한계를 문구로 알립니다.

### 13.3 데스크톱 셸 (결정 D1, D2)

| 영역 | 규칙과 근거 |
|---|---|
| 렌더러와 비밀번호 | 서비스 비밀번호는 main만 압니다(`SidecarCredentials`). 렌더러에는 `{url}`만 갑니다(`main/service/sidecar-credentials.ts:20-23`).<br>Basic을 붙이는 요청의 조건:<br>- 서비스 origin과 정확히 같음(`:26-31`)<br>- 렌더러의 top frame 요청<br>- web view, 임베드 페이지, 프레임 없는 요청은 제외(`main/windows/security.ts:34-55`)<br><br>그래서 own-web은 워커에서 API를 부르지 않습니다 |
| 렌더러 권한과 이동 | 렌더러 권한은 알림과 클립보드 쓰기만 허용됩니다(`security.ts:6-20`). 렌더러 밖으로의 이동과 새 창은 막고 외부 브라우저로 엽니다(`security.ts:22-32`) |
| 렌더러 CORS | main이 렌더러 session의 **모든** 응답에 `Access-Control-Allow-Origin: *`를 덮어씁니다(`security.ts:54-58`, `windows/headers.ts:10-20`). 렌더러가 닿는 모든 origin의 CORS가 렌더러에게는 열려 있는 셈입니다. 렌더러에는 own-web만 뜨고(`isRendererUrl`), 요청은 `credentials:"omit"`이므로 쿠키가 따라가지 않습니다. 이 동작은 upstream surface로 감시합니다(§16 계약 행) |
| 원격 토큰을 main이 가짐 | 원격 세션의 브라우저 패인 때문에 main이 own.remote 세션 토큰을 메모리에 가질 수 있습니다(attachment 수명 동안, 저장·로그 없음). main이 가지는 비밀은 로컬 서비스 비밀번호와 이 원격 서버 접근 토큰뿐이고, provider 비밀은 절대 가지지 않습니다(§10.1) |
| URL 스킴 | `opencode://`를 등록하지 않습니다. `lifecycle/environment.ts`를 치환하는 이유입니다. `protocols:[]`만으로는 런타임 등록을 막지 못합니다 `[desktop-build §4 risk 2]`. 검증은 G-D2입니다 |
| 앱 정체성 | 앱 id `dev.own.opencode.desktop`로 userData, 단일 인스턴스 락, AUMID를 분리합니다(`constants.ts` 치환). upstream 설치본의 "OpenCode"/"OpenCode Dev"와 섞이지 않습니다(G-D2) |
| 업데이트와 서명 | upstream 업데이터를 끕니다(`UPDATER_ENABLED=false`, `publish:null`). 서명이 없으므로 SmartScreen 경고가 뜹니다. 개인 사용 전제입니다(`own/FORK.md` §8.4). Electron 판은 upstream sync 때 함께 올립니다(보안 수정 반영) |
| 개발 빌드 CDP | 비패키지(dev) 셸은 `remote-debugging-port`를 엽니다. 기본값은 9222입니다(`main/lifecycle/configure.ts:26-27`).<br>- 위험: 같은 PC의 다른 프로세스가 인증된 렌더러를 조작할 수 있습니다.<br>- 규칙: dev 셸은 local 채널 서비스에만 붙이고, 운영 서비스·실계정으로 돌리지 않습니다.<br>- 패키지 빌드는 이 포트를 **기본으로 열지 않습니다.** 명령줄 스위치 `--remote-debugging-port`를 주면 패키지 exe도 엽니다(upstream `packages/desktop/scripts/bench-startup.ts:298`가 이렇게 씀). 같은 사용자라면 가능한 일이라 위협 모델(§13 전제)을 넘지 않습니다. 성능 게이트(§16.3)는 실계정이 없는 격리 홈에서만 이 스위치를 씁니다. |
| 개발 서버 노출 | upstream `bun dev`의 isolated server(`OPENCODE_DESKTOP_ISOLATED_SERVER=1`)는 쓰지 않습니다. 이 모드는 LAN 주소를 광고했습니다 `[desktop-build §4 risk 6]`. WSL sidecar도 `0.0.0.0`에 바인딩하므로 쓰지 않습니다(§11) |
| upstream 서비스 보호 | 셸은 `Service.ensure`를 부르지 않고 `service-own.json`만 봅니다. stock 셸은 버전이 다른 upstream 서비스를 stop할 수 있습니다(§4.1). 검증은 G-D1입니다 |
| 브라우저 패인 | 페이지는 신뢰하지 않는 데이터입니다. 파티션이 렌더러와 다르고 서비스 인증이 붙지 않습니다. `file://`은 로컬 워크스페이스 안만 허용됩니다(§10.1) |
| 온보딩 부작용 | `finishFirstLaunchOnboarding(true)`를 부르지 않습니다. 부르면 Documents에 폴더가 생깁니다(§4.1) |

### 13.4 원격 기기(모바일) 접근의 위협과 대응 (P8, 결정 D3)

위협 표 전체와 완화책의 수치(토큰 90일·유휴 30일, 폐기 반영 5초 이하, 속도 제한)는 05 §13.8이 기준입니다. 이 문서는 불변식과 그 확인 게이트만 둡니다.

| 위협 | 불변식 | 확인 |
|---|---|---|
| LAN에서 서비스·게이트웨이에 직접 접근 | 서비스는 127.0.0.1 전용이고 hostname 변경은 금지입니다(§5.4). 게이트웨이도 loopback에만 두고 `tailscale serve`로만 노출합니다. LAN·`0.0.0.0` 바인딩은 거절합니다 | MG1 |
| 공개 인터넷 노출 | 금지입니다(Tailscale Funnel, 포트 포워딩 포함) | MG1 |
| 기기 분실, 토큰 탈취 | 기기별 토큰, 해시만 저장, 기기 하나 즉시 폐기, 유휴 만료, 최소 범위(`terminal`·`admin` 기본 끔) | MG3, MG4 |
| 페어링 코드·QR 유출 | 코드는 1회용 5분. 페어링은 PC(데스크톱 또는 웹)에서만 시작하고, PC 쪽에서 확인 번호(SAS)를 보고 승인해야 등록됩니다(05 §13.5) | MG2 |
| 범위 우회 | 게이트웨이는 허용 목록 방식이고, upstream `/api/pair`·`/auth/*`·`/api/credential/*`·`/api/integration/*`와 `devices.*`·`gateway.*`를 항상 막습니다 | MG3 |
| 터널 계정(Tailscale) 탈취 | 기기 토큰이 따로 필요하므로 이중 방어입니다. tailnet ACL은 권고입니다 ⚠ | – |
| 모바일에서 셸·파일 쓰기로 권한 상승 | 기본 범위에서 뺍니다. 권한 dock의 한 번 허용은 가능합니다. "항상 허용" 저장을 기기에서 막을지는 03·05와 맞춥니다 ⚠ | MG3 |
| 서비스 비밀번호·원격(SSH) 토큰 노출 | 기기에 가지 않습니다. 게이트웨이가 서비스 안에서 넣습니다(§6.4 4–5) | MG5, MG8 |
| 푸시로 내용 유출 | payload에는 id와 종류만(선택적으로 세션 제목), Web Push는 페이로드 암호화(§6.5) | MG7 |
| upstream CORS가 `https://*.opencode.ai`를 허용함(`packages/server/src/cors.ts:3,18`) | 쿠키는 same-origin만 받고 Basic이 필요하므로 서비스는 영향이 없습니다. 게이트웨이 origin은 서비스 `cors` 목록에 넣지 않습니다(§6.4 5) | – |

---

## 14. 관측성: 한도·사용량 (own-accounts + own-telemetry)

### 14.1 수집원

| 수집원 | 플러그인 / 훅 | 얻는 것 | 주의 |
|---|---|---|---|
| step 완료 | own-accounts `ctx.event.subscribe` → `session.step.started/ended/failed`, `session.usage.recorded`, `session.model.selected`, `session.compaction.*`, `session.created` | 턴별 providerID/model, tokens{input(비캐시), output, reasoning, cache.read, cache.write}, cost | `packages/schema/src/session-event.ts:333-390,158-167`. Location 인스턴스마다 중복 수신되므로 이벤트 id로 dedupe |
| HTTP 응답 (own slot) | own-accounts `http.response`, unscoped, `own-*`만 | 성공과 429/4xx **헤더**: `x-codex-*`, `anthropic-ratelimit-*`, `x-ratelimit-*`, `retry-after`, (미확인) `anthropic-workspace-id`, `openai-organization`. 오류 응답은 본문 앞 2KB | status 분류보다 먼저 봄(`packages/ai/src/route/executor.ts:235-248`). **스트림 body는 건드리지 않음**(02 §7.2) |
| WS 프레임 (Codex) | own-accounts `experimental.ws.receive`, `own-codex-*`만 | in-band `codex.rate_limits`, 그리고 rate-limit 계열 `error`/`response.failed` 프레임(§14.3) | 부분 문자열로 먼저 거른 뒤에만 JSON 파싱. handshake **응답** 헤더는 훅에 노출되지 않음(→ P-005 후보) |
| HTTP 응답 (Claude 슬롯) | own-telemetry `http.response`, `{providerID:"anthropic"}`, claude-auth **뒤** | `anthropic-ratelimit-unified-*` | 성공 응답에도 옴(02 §8.5) |
| 공식 잔액/키 API (API 키만) | own-accounts leader poller(**기본 켬**, 계정마다 최소 15분, 사용자가 새로고침하면 2분. 최근 24시간 안에 쓴 계정이나 화면에 보이는 계정만 조회. 계정마다 끌 수 있음, 02 §7.2·03 §7.1) | DeepSeek 잔액, OpenRouter 키 credit/limit | 공식 엔드포인트만. 구독 계정은 폴링하지 않음(Codex `wham/usage`는 비공식이라 기본 off, Claude `api/oauth/usage` 금지) |

### 14.2 저장 스키마

02가 기준입니다. 여기서 따로 정의하지 않습니다.
- 한도: `LimitWindow`(02 §7.3). id 접두어는 kind 어휘(`codex.*`, `claude.*`, `anth.*`, `oai.*`, `ds.*`, `or.*`, `api.budget_month`). 최신 스냅샷은 `state\limits.json`, 변경은 `quota.updated` 이벤트(02 §7.4).
- 리셋권(RP 2026-10-26): ChatGPT 구독 계정의 리셋권 수 `Limit.ResetCredits`(02 §7.1.1)는 창이 아니다. 같은 `state\limits.json`의 `resetCredits`와 `quota.updated`의 `resetCredits`로 간다. leader가 이미 읽는 `wham/usage`에서 읽고, 쓰기는 사용자가 UI에서 확인한 뒤 `quota.resetCredits.redeem.execute`만 한다. 아무것도 저절로 쓰지 않는다. Claude 리셋권은 읽지도 쓰지도 않는다(02 §8.5).
- 사용량: `LedgerLine`(02 §7.5), `ledger\usage-YYYY-MM.jsonl`. 전환·경보·로그인·소진 이력은 `ledger\events-YYYY-MM.jsonl`. 원본 12개월 보존, 지난 달 gzip, 집계는 `rollup.json`.
- 쓰기는 runtime ledger writer 하나가 합니다(§4). 파생 지표(`hit`, 전환 penalty 실측, 복귀 hit, Codex 쿼터 가중치 회귀)는 02 §7.5–§7.6.

### 14.3 하드 소진 판정과 retry 정책

- **흐름.** runtime의 세션별 캡처 저장소 `lastResponse[sessionID] = {providerID, status, headers subset, bodyHead | frame 요약, at}`(TTL 30초, 02 §7.2)에 세 곳이 씁니다: own-accounts `http.response`, own-accounts `experimental.ws.receive`, own-telemetry `http.response`(`anthropic`). `retry` 훅은 이것을 읽어 판정합니다. retry 이벤트 자체에는 `{type, message, status}`뿐이고 헤더가 없기 때문입니다(`packages/plugin/src/promise/session.ts:127-136`).
- **Codex WS 경로가 주 경로입니다.** Codex slot은 `transport: websocket`이므로(`openai.ts:257-262`) primary 턴은 WS로 갑니다. 이 경로에서는 `http.*` 훅이 돌지 않고 `experimental.ws.*`만 돕니다(`model-request.ts:295-350`). handshake 응답 헤더도 노출되지 않습니다.
  - WS의 `error`/`response.failed` 프레임은 `providerFailure` → `classifyProviderFailure({message, status})`로 분류됩니다(`packages/ai/src/protocols/open-responses.ts:1372-1390,1456-1457`). QuotaExceeded(재시도 안 함, `packages/core/src/session/runner/retry.ts:30-58`)가 되려면 status가 429이고 메시지가 `usage limit` 등과 맞아야 합니다(`packages/ai/src/provider-error.ts:106,165-167`). 프레임에 status가 없거나 메시지가 다르면 RateLimit으로 분류되어 **최대 10회, 회당 retry-after 최대 15분** 재시도할 수 있습니다(`retry.ts:68-76,94-120`). claude-auth에서 막으려던 약 2.5시간 멈춤과 같은 문제가 구독의 주 사용 사례에서 생깁니다. 실제 프레임 형태는 미확인입니다(G8).
  - 그래서 own-accounts의 `ws.receive`는 `own-codex-*`에서 부분 문자열(`"codex.rate_limits"`, `"usage_limit"`, `"rate_limit"`, `"response.failed"`, `"type":"error"`)이 있는 프레임만 파싱해 `lastResponse`에 `{status?, code, resets_in_seconds?, rate_limits 스냅샷}`을 남깁니다. frame은 그대로 돌려줍니다.
  - WS handshake가 실패해 HTTP로 떨어지는 경우에는 `http.response`가 같은 저장소를 채웁니다(HTTP 훅은 WS fallback 경로도 감쌈, `model-request.ts:324-325`).
- **하드로 판정하는 경우** → `{retry:false}` (02 §5.2 kind별 표가 기준):
  - Codex: 429 + `usage_limit_reached`/"usage limit", `x-codex-rate-limit-reached-type` 헤더, WS 프레임의 같은 코드, 또는 최근 스냅샷 사용률 100% 이상
  - Claude 슬롯: unified status `rejected`, 또는 retry-after가 15분을 넘는 429
  - Anthropic API: `enforced_spend_limit_reached`, workspace 한도 400
  - OpenAI API: 429 `insufficient_quota`, 402. DeepSeek/OpenRouter: 402. xAI: 402/403 credits(미확인)
- **일시적인 경우**(`retry-after`가 짧은 429, 529, 5xx): core 기본값을 유지합니다.
- 턴이 끝나면 UI가 전환을 제안합니다(`switch.suggested`). 구독 계정은 수동 전환이고, API 키 계정은 사용자가 켜 둔 경우에만 자동 failover합니다(02 §5.9(g)).

### 14.4 경보
- 코드와 조건은 02 §7.7이 기준입니다(`flap`, `low_hit`, `return_miss`, `estimator_drift`, `native_trap`, `compact_advice`, `image_trim_soon`, `claude_slot_billing`, `secret_in_overlay`).
- 이 문서의 조건과 연결되는 코드도 02 §7.7에 정의되어 있습니다: `untrusted_plugin`(§13.2, Location 상태 `blocked_by_plugin`), `unpinned_session`(model 없는 세션 감지, §8.5), `guard_skew`(가드 1), `codex_source_stale`(linked Codex 원본이 갱신되지 않음, §8.4, `packages/own-protocol/src/alert.ts:26-27`), `compaction_threshold_mismatch`(R16), `toolset_changed`(02 D10).
- 이 판에서 02 §7.7에 더해 달라고 요청하는 것(§20 32): 프로젝트 config의 compaction 재정의 경보(R16), takeover 뒤의 `source_refreshed_concurrently` 분류(§8.4).
- 전환 확인 대화상자 임계값은 `policy.json.thresholds.confirm`(100k 토큰 / 쿼터 5% / $0.50, 03 §6.2)입니다.

### 14.5 건강 상태
RPC `own.accounts` `health`는 다음을 돌려줍니다: fork·플러그인·vault 백엔드 버전, 빌드 id, 가드 상태(`ok | skew | unmanaged`), Location별 플러그인 allowlist 상태, vault 접근 가능 여부, 레지스트리 revision, KV·ledger 크기, `opencode-own.db` 크기. DB 크기는 임계값을 넘으면 경고합니다. v2에서 event 테이블이 비대해지는지는 확인되지 않았습니다. `health`는 가드 1이 실패해도 등록되는 유일한 메서드입니다(02 §9.2).

---

## 15. RPC 계약 (02 §9가 기준)

메서드·이벤트·오류 목록과 JSON 형태는 **02 §9**를 따릅니다. 이 문서는 서버 쪽 배선 규칙만 정합니다.

- **RPC id는 `own.accounts`, `own.remote`, `own.team`, `own.computer`, `own.import` 다섯입니다.** `own.accounts`는 own-accounts만, `own.remote`는 own-remote만(04 §16), `own.team`은 own-team만(06 §2.7, T1부터), `own.computer`는 own-computer-use만(§10.2), `own.import`는 own-import만(09 §5, IMPORT부터) 등록합니다. `own.remote`의 메서드·이벤트·location 규칙은 04 §16, `own.team`의 것(메서드 33개, 이벤트 8개, 범위표 `OwnTeam` routing, 게이트웨이 분기)은 06 §2.7, `own.computer`의 것은 §10.2, `own.import`의 것(메서드 10개, 이벤트 3개, 범위표 `OwnImportRouting`, 게이트웨이 분기)은 09 §5가 기준입니다. own.import는 모든 Location에 등록하지만 상태는 프로세스에 하나이고, 이벤트는 control location 인스턴스(없으면 가장 오래된 인스턴스)만 냅니다. RPC는 rpcID마다 마지막 등록 하나만 응답하므로(`packages/core/src/rpc.ts:108-112`) 두 플러그인이 같은 id를 나눠 가질 수 없습니다. own-telemetry가 모은 데이터(Claude 슬롯 unified 창 등)는 own-accounts가 runtime 싱글턴의 저장소를 읽어 `quota.snapshot` 등으로 내보냅니다. 한도·사용량 조회도 모두 `own.accounts` 아래의 메서드(`quota.snapshot`, `accounts.usage`, `ledger.session`)입니다.
- **메서드 목록은 02 §9.2 그대로입니다.** 이 문서는 새 메서드를 정의하지 않습니다. 가드 상태는 `health`(§14.5)로, 관리 동작(가져오기, Claude 계정 추가·다시 로그인·빼기, 원격 사용)은 `plugin.claudeAuth.*`로 합니다. 프로젝트 플러그인 승인(§13.2)은 02 §9.2의 `plugin.trust.list` / `plugin.trust.approve.plan` → `plugin.trust.approve.execute{nonce}` / `plugin.trust.revoke`와 이벤트 `plugin.trust.changed`(02 §9.3)를 씁니다(control location).
- **location 규칙**
  - **세션 관련 호출**(`switch.*`, `session.binding`, `cache.*`, `ledger.session`)은 `location[directory]` = **그 세션에 저장된 `location.directory`**로 보냅니다. 플러그인 인스턴스, 카탈로그, 훅은 Location마다 따로 있고(`rpc.ts` 등록도 Location 단위), session runner는 세션의 location이 현재 location과 다르면 작업을 중단합니다(`packages/core/src/session/context.ts:124-125`).
  - **계정·한도·플러그인 관리 호출**(`health`, `accounts.*`, `quota.snapshot`, `plugin.*`, `policy.*`, `ratecards.*`, `presets.*`, `diagnostics.*`, `worktree.inspect`)만 control location으로 보냅니다. 세션 프리셋 메서드(`session.preset.*`, `session.ultra.set`)는 세션 호출입니다(02 §9.1). 상태가 프로세스 전역이므로 어느 location이 답해도 같지만, control location은 프로젝트가 하나도 열려 있지 않아도 존재하고 세션 작업을 끊지 않습니다.
  - location은 **항상 쿼리 파라미터**로, URL 인코딩해서 넘깁니다. 서버는 쿼리 → `x-opencode-directory` 헤더 → cwd 순으로 보고, 경로를 받은 그대로 씁니다(`packages/server/src/location.ts:39-47`). `%LOCALAPPDATA%` 경로에 한글 사용자 이름이 들어갈 수 있고, 드라이브 문자 대소문자가 다르면 Location이 중복되므로, own-web은 처음 한 번 `GET /api/location`으로 정규화한 경로를 받아 그 값만 씁니다(03 §16.3과 같음).
- **이벤트 중복 제거**: 02 §9.1을 따릅니다. 모든 이벤트에 `eventId`(ULID)와 `origin: "global" | "session"`을 붙이고, 전역 이벤트는 프로세스 leader 인스턴스만 보냅니다. 이 문서의 이전 판에 있던 단조 증가 `seq` 방식은 버립니다.
- **계정 상태 이름**: 02 §2.4.1의 enum(`ready | exhausted | auth_failed | needs_reauth | disabled | misconfigured | unverified | retired`)을 씁니다. `retired`는 `accounts.remove.execute`로 삭제한 계정입니다(slot은 남고 모델은 비활성, §8.1).
- 세션 목록의 계정 칩은 추가 호출 없이 만들 수 있습니다: `SessionInfo.model.providerID`와 `accounts.list` 캐시를 조합합니다. model이 없는 세션은 "기본값(미고정)" 칩입니다(§8.5).
- **Codex 가져오기 메서드**(`accounts.import.codex.{list,plan,execute}`)는 `@own/protocol`에 구현돼 있고 02 §9.2의 정식 목록에 들어 있습니다. T1 기준 `own.accounts` 메서드는 63개, 이벤트는 17개였고, EXT·속도·IMPORT(`estimate.request`, own-import가 loopback으로 부름)를 더해 메서드 69개, 이벤트 18개였고, NOTES(워크스페이스 노트 `notes.*`, 05 §8.8)를 더해 메서드 73개, 이벤트 19개였고, VOICE(음성 입력 `voice.*`, 02 §3.9)를 더해 메서드 77개였고, 원격 Claude(04 §8.11)의 `plugin.claudeAuth.{remote.ack,remote.set,fastAck}`를 더해 지금 메서드 80개, 이벤트 19개입니다(02 §9.2–§9.3, 07 §8.1의 프리셋 메서드 포함). 호출은 control location으로 보냅니다(`compaction.setSession`은 세션 메서드이므로 그 세션의 location).
- **셸 IPC는 서버 RPC가 아닙니다.** 데스크톱 preload의 `window.electron`과 MessagePort Effect RPC(태그 81개, 이벤트 10종 `[desktop-verdict §3]`)는 창·네이티브 기능 전용입니다. 여기에 계정·세션 로직을 넣지 않습니다(§3.2). P8 모바일은 같은 서버 RPC를 게이트웨이 경유로 부릅니다(§6.4). `own.remote`의 게이트웨이·기기·피드 메서드는 05 §16이 정합니다.

---

## 16. 테스트 전략

| 층 | 대상 | 방법 | Bun 필요 여부 |
|---|---|---|---|
| 순수 로직 단위 | 캐시 도메인 판정, 전환 planner와 추정기, TTL 판정, hint 배치기(R9 순서 규칙, 4개 채우기), 헤더·WS 프레임 파서(codex/anthropic unified/anthropic API/x-ratelimit), 하드 소진 분류기, JWT 클레임, device-code 상태 기계, 결정적 context 변환(해시 안정성), 비밀 마스킹 패턴 | 의존성 없는 모듈로 작성. `node --test --experimental-strip-types`(Node 22)와 `bun test` 양쪽에서 실행 | 아니오 |
| 플러그인 단위 | own-accounts와 own-telemetry의 훅 배선 | **가짜 PluginContext**: provider editor, `session.hook` 레지스트리(등록 순서 보존), 메모리 KV, `rpc.register`, `plugin.list`, 이벤트 주입기. fixture 이벤트로 훅을 실행하고 헤더와 결정을 단언 | 예 |
| 녹화 HTTP | provider 응답 헤더와 usage 매핑, 오류 분류 | `@opencode/http-recorder` 카세트(Effect HttpClient와 WS 지원, 비밀 스캐너 내장, `CI=true`면 카세트가 없을 때 실패). core의 녹화 러너(`packages/core/test/session-runner-recorded.test.ts`)를 본떠 own 테스트에서 core와 플러그인을 함께 부팅. 녹화는 테스트 계정으로만 하고, 커밋 전에 `secretFindings`와 우리 추가 패턴으로 검사 | 예 |
| 계약(surface) | upstream에서 우리가 의존하는 심볼 | `own/scripts/check-surface.mjs`(Node): 훅 이름과 이벤트 필드, Auth.none 조건 문자열, Identity 형식, openai 허용/거부 목록, cache-policy 상수(`BREAKPOINT_CAP`, openrouter 예외), 플러그인 자동 발견 디렉터리 이름, CSP 스크립트 id, RPC 경로, `database-path`/`service-config` 규칙, 업데이트 URL 형식, 벤더 원본 해시. 데스크톱 쪽(05 §4.7 표에 더해): 렌더러 응답 CORS 덮어쓰기(`desktop/src/main/windows/headers.ts:10-20`, `security.ts:54-58`), `oc://renderer` 핸들러에 SPA 폴백이 없음(`windows/protocol.ts:52-83`, §6.2 라우팅), 패인 endpoint 인증 선택(`browser-pane.ts:119-124`), `[browser.disconnected]` 문구(`plugin-browser/src/connection.ts:136-141`), compaction의 Location 단위 설정과 발견 규칙(`compaction.ts:654`, `config/discovery.ts:33-36`) | 아니오 |
| 가짜 provider E2E | 전환, 한도 UI, retry 정책 | `own/tools/fake-provider`(Node HTTP/WS): Responses와 Messages를 흉내 내고 usage, 캐시 토큰, 한도 헤더, 429, WS `error`/`response.failed` 프레임을 시나리오대로 응답. Playwright로 own-web 구동 | 예(빌드) |
| 데스크톱 셸 | own-desktop 빌드·패키징, 서비스 연결, OS 통합 격리 | `electron-vite build`와 `electron-builder --dir`로 만듭니다. PoC 방식으로 실행합니다: 격리된 test root, 프로토콜 등록 끔(`OPENCODE_DESKTOP_DISABLE_PROTOCOL_REGISTRATION=1`은 dev 전용, 패키지 빌드는 치환으로 막음). 게이트 G-D1–G-D6(§16.2). 렌더러 E2E는 패키지 exe를 격리 홈에서 `--remote-debugging-port`로 띄우고 CDP로 붙습니다(upstream `bench-startup.ts:298` 방식). dev 빌드는 `packages/app/e2e/performance/devex/desktop-startup.ts`처럼 `connectOverCDP`(`:216`) | 예 |
| 성능 | PF1–PF8(§6.6) | `packages/own-web/e2e/performance`: upstream `benchmark` 픽스처를 vendor하고 우리 예산 단언을 더함. 프로덕션 번들, 이 PC 기준. PF1·PF6은 `bench-startup.ts` 어댑터(§16.3). 결과는 `own/release/<version>/perf.json` | 예 |
| 원격(SSH) | 04 §20 | RG1–RG17(04 §20.3). fake 호스트와 실제 호스트 | 예 |
| 수동/실계정 | PoC 게이트 | 아래 게이트, 결과는 `own/docs`의 PoC 결과 문서에 기록 | 예 |

### 16.1 PoC 게이트

02의 AC-P 번호와의 대응을 "02" 열에 적습니다.

| 게이트 | 02 | 필수 여부 | 시나리오 | 통과 기준 | 실패 시 |
|---|---|---|---|---|---|
| G1 서비스와 격리 | – | must | own 채널 빌드로 `serve --service` 기동, upstream 설치본과 동시 실행. env 없는 raw exe로 서비스 spawn | `service-own.json`/`opencode-own.db`/포트 분리. 서로 재시작 없음. 업데이트 로그 `update check skipped`(사유 `disabled`, launcher 없이 떴으면 `policy-disabled`). env 브리지로 spawn된 서비스가 `OWN_OPEN_CODE=1`과 own config를 가짐. pwsh 셸 동작. Windows 서비스의 MCP 등록 수 확인(upstream anomalyco/opencode#50710: 서비스가 MCP를 0개 등록하는 버그). 가드 1(fail closed)·가드 2 동작 | P-003 |
| G2 인증 주입 | AC-P01, P02 | must | own provider(enabled, integration 없음)로 kind 4종 × HTTP/WS 경로, env에 `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`를 둔 상태 | `http.request`/`ws.handshake`에서 본 Authorization·x-api-key·chatgpt-account-id **해시**가 providerID마다 다르고 주입한 값과 일치. setup 등록 훅만으로 동작하고, 계정 추가 후 `provider.reload`만으로 새 slot 요청에 헤더가 붙음(훅 재등록 없음). `generate.text`에 own 모델을 넘기면 401(누수 없음)임을 기록 | 대체 경로(§8.3), 그다음 P-007 |
| G3 Codex 다계정 | AC-P20, P22 | must | device-code로 계정 2개. 병렬 세션 20턴(reasoning high) | 오류 0. 헤더 사용률 증가가 해당 계정에만. refresh 성공, 재사용 오류 0. title 모델이 같은 slot의 luna인지 기록 | 브라우저 PKCE 경로 |
| G4 캐시 동등성 | AC-P04–P07 | must | T1, T2, T3a, T4 `[research cache_design §5]` | T1: 2번째 step부터 `cache.read ≥ 0.9×직전 P`. T2: 다른 계정 ≤ 5%. T3a/T4: 5분 안에 복귀 시 return_hit ≥ 0.9, 직렬화 prefix 해시 일치. variant를 바꿔 복귀하면 경고가 뜨고 hit 하락이 측정됨(R14) | 규칙 수정 |
| G4b Anthropic 1h 모드 | AC-P16 | should (후속 1h 모드 진입 조건) | R9 배치(수동 4개, 4×1h와 1h/1h/1h/5m 두 변형), system 1 part·watermark 없음 경우 포함 | 모든 요청 HTTP 200(400 0건). `cache_creation.ephemeral_1h/5m_input_tokens` 분리가 배치와 일치. 6–30분 뒤 복귀 시 return_hit ≥ 0.9 | 1h 모드 비활성 유지 |
| G5 교차 provider 왕복 | AC-P31(일부) | must | Codex GPT → DeepSeek → Claude(API, adaptive thinking) → GPT → Claude, 그리고 OpenRouter Claude | canary 5개 회상, 400 0건, 서명 재생 확인. OpenRouter Claude에서 R15 hint가 있을 때 `cache.read > 0` | strip 규칙(R8), R15 문서화만 |
| G6 compaction | AC-P09, P10 | must | `POST /compact`(2.0.18), T7 수정판 | 동작함. 요약 요청의 `cache.read/P_older`와 `S_actual`을 측정해 추정기에 반영 | 추정 범위 확대 |
| G7 한도 수집 | AC-P15 | must | Codex(HTTP/WS), claude-auth 슬롯, API 키 | Codex 요청마다 사용률(WS 포함), unified 헤더, x-ratelimit 확보. 미확인 헤더 이름(§8.1) 캡처 | P-005 또는 HTTP transport |
| G8 retry 제어 | AC-P17a/b, P24 | must / should | 하드 소진 모사(fake-provider와 실계정): **Codex WS 경로**(`error`/`response.failed` 프레임), WS handshake 실패 → HTTP fallback 경로, HTTP 경로, Claude 슬롯 | 각 경로에서 `{retry:false}`로 턴이 30초 안에 종료(must). WS 프레임의 실제 형태와 core 분류(RateLimit/QuotaExceeded) 기록. retry 경로의 switchModel이 다음 attempt에 반영되고 도구 중복 실행 없음(should) | P-004 |
| G8b 훅 안의 switchModel | AC-P26 | must(예약 전환 prompt 적용 전) | (1) 같은 세션의 `prompt` 훅 안에서 `switchModel`, (2) `Compaction.Ended` 처리 중 `switchModel`, (3) model 없는 세션이 `session.created`에서 고정됨 | 바로 다음 step이 새 Ref로 실행. 교착 0, step 중복 0. 미고정 세션이 첫 step 전에 고정됨 | idle에서만 적용(02 §5.3 방법 1·3) |
| G9 claude-auth 공존 | AC-P23, P24 | must | 앱에 든 번들(2026-10-18 전: shim 설치, npm-cli.js 경로), 순서 [own.accounts, own.remote, own.team, heymaaz.claude-auth-v2, own.telemetry, own.computer-use, own.import, own.harness]. claude-auth 줄이 바뀌어도 own-remote 터널이 끊기지 않는지 확인 | `own-anth-*` 요청에 claude-code 헤더 없음, x-api-key 해시 존재, 비용이 $0 아님, unified 헤더 캡처, 확인 전 `anthropic` 비활성 | 슬롯 비활성 |
| G10 다운시프트 | – | should | 250k 세션을 작은 창 모델로 전환 | canary 회상 기준("too large 없음"은 기준이 아님) | R5 강제 |
| G11 웹 폴백 임베드 | – | must(웹 폴백 출시 때) | P-001/002 빌드, pairing, SSE 단절. 같은 own-web 빌드가 데스크톱 렌더러에서도 도는지. 세션 화면에서 새로 고침, 마크다운·shiki·diff 워커 사용 | 쿠키 로그인, CSP 위반 0(워커 포함, §6.1), 재동기화 뒤 누락 0. 웹은 path 라우트 새로 고침이 SPA 폴백으로 복원되고, 데스크톱은 메모리 라우터로 404 없음(§6.2) | 리버스 프록시 모드, 또는 게이트웨이 서빙(§12.2) |
| G12 한글 IME | – | must | 03의 IME 체크리스트. 데스크톱 렌더러와 웹 폴백 둘 다 | 조합 중 Enter/Tab/화살표/Esc 오동작 0. 입력 지연은 PF2 | composer 수정 |
| G13 병렬 | – | must | 계정 2 × 프로젝트 2 동시 실행 | `database is locked` 0 | 동시성 제한 |
| G14 비밀 위생 | AC-P03 | must | 자동 스캔. 원격 호스트 스캔은 04 | DB·KV·로그·`/api/provider`·셸 `Get-ChildItem env:`·RPC 이벤트·ledger, 그리고 데스크톱 셸 로그·userData·렌더러 저장소에 키 평문과 서비스 비밀번호 없음. 패턴: Bearer, `sk-`, `sk-ant-`, `xai-`, JWT(`eyJ…`), OAuth 토큰 엔드포인트 응답 필드 | 출시 차단 |
| G15 control location | – | should | 전용 빈 디렉터리로 관리 RPC, 한글 사용자 경로 | 무거운 watcher와 인덱싱 없음. 전역 MCP 기동 비용 기록. 정규화 경로로 Location 중복 0 | location 정책 수정 |
| G16 템플릿 캡처와 유효 limit | AC-P25, AC-P40 | must | 계정 생성 시 `editor.get(canonical)`에서 템플릿 캡처, 이후 models.dev refresh 강제. **프로젝트 compaction 재정의**: 임시 프로젝트에 `.opencode/opencode.json`으로 (a) `compaction.buffer: 50000`, (b) `compaction.auto: false`를 두고 DeepSeek slot 세션을 돌림. 같은 프로젝트를 `--untrusted`로도 돌림 | 비활성 provider의 모델도 캡처됨. 복제 모델과 내장 provider의 system 텍스트·tool 정의 해시가 같음(providerID 줄 제외). refresh 뒤에도 identity·system 해시 불변. 유효 `limit.input`(R16)을 바꿔도 system·tool 해시 불변. (a) 그 Location의 유효 `limit.input`이 `T + buffer`로 등록되고 auto compaction이 T(±10%)에서 일어남. (b) 경보와 UI 경고가 뜸. `--untrusted`에서는 전역 값만 적용됨 | 고정 카탈로그 JSON을 릴리스에 동봉. (a)(b) 실패 시 경보만 두고 문서화 |
| G17 품질 A/B | – | should | 실제 작업 5–10개를 Codex 앱과 fork에서 | 주관 평가 기록 | GPT용 system 주입 검토 |
| G18 프로젝트 플러그인 차단 | – | must | 임시 프로젝트에 `.opencode/plugins/x.ts`(unscoped `http.request`로 헤더를 기록) | 미승인 상태에서 그 Location의 own 요청에 인증 헤더 0, `untrusted_plugin` 경보. 승인 뒤 정상. 파일 수정 뒤 다시 차단. `--untrusted` 모드에서 로드 0 | 기본을 `--untrusted`로 |
| G19 Codex 가져오기 | AC-P39 | must(가져오기 사용 시) | 이전 앱 profile을 linked로 가져와 20턴, 이전 앱이 refresh한 뒤 계속, 이전 앱을 멈춰 토큰 만료, 같은 profile에 다른 계정 로그인, takeover 전환. **takeover 경합**: (i) plan과 execute 사이에 이전 앱이 refresh, (ii) execute 뒤 이전 앱이 그 프로필을 계속 돌려 refresh(가짜 Codex backend로 재사용 감지를 흉내) | linked: 원본 파일 해시·mtime 불변, 우리 쪽 토큰 엔드포인트 호출 0, 갱신된 토큰을 다시 읽어 이어짐, 만료 시 `codex_source_stale`와 요청 정지, 다른 계정이면 `account_mismatch`. takeover: plan에 "이전 앱에서 멈추기" 경고, execute 직후 강제 refresh 1회, vault 기록, 원본 불변, 이후 refresh 정상, 경고 `takeover_supersedes_source` 표시. (i) 재읽기 뒤 한 번 재시도로 성공. (ii) 우리 쪽 오류가 `source_refreshed_concurrently`로 분류되고 re-link 제안이 뜸. 실계정에서 재사용 감지가 계열 전체를 폐기하는지 기록 | 가져오기 끄고 새 로그인만, 또는 takeover 끄고 linked만 |

### 16.2 데스크톱 게이트 (G-D1–G-D6, `[desktop-verdict]`의 D1–D6)

상세 시나리오와 통과 기준은 05 §14.1(D1–D6)이 기준입니다. 아래는 이 문서의 불변식과 맞물리는 요약입니다. 셸 성능·크기 게이트 DP1–DP6은 05 §14.2에 있습니다.

| 게이트 | 필수 여부 | 시나리오 | 통과 기준 | 실패 시 |
|---|---|---|---|---|
| G-D1 upstream 서비스 보존 | must | upstream OpenCode 서비스(`service.json`, 다른 버전)가 떠 있는 상태에서 own-desktop 실행, 재연결, 종료. own 서비스가 없는 상태에서 실행 | `service.json` 불변, upstream 서비스 pid 유지. own-desktop은 `service-own.json`만 봄. 셸의 ensure 호출 0, 기동은 launcher 위임으로만 | 출시 차단. BackgroundService 교체를 다시 확인 |
| G-D2 OS 통합 격리 | must | 패키지 설치, 실행, 제거. upstream "OpenCode"/"OpenCode Dev"가 설치된 상태 | `HKCU\Software\Classes\opencode` 불변. userData, 단일 인스턴스 락, AUMID 충돌 없음. Documents에 폴더 생성 없음. `app-update.yml` 없음 | 출시 차단 |
| G-D3 창과 서비스 수명 분리 | must | 턴 도중 창 닫기, 셸 종료, 셸 크래시. 세션 실행 중 버전 교체가 필요한 상태에서 셸 실행 | 턴 계속. 다시 열면 붙음. 교체는 launcher가 거부하고 "own restart 필요" 배너가 뜸 | 설계 수정 |
| G-D4 알림 | should(알림 기능 전 must) | 설치 바로가기의 AUMID로 toast, 클릭하면 해당 세션으로 이동 | 알림 표시, 클릭 이동 | 창 안 알림만 |
| G-D5 브라우저 패인 | must(P5 브라우저 기능) | (1) 데스크톱에서 만든 세션: attach(v4), 탭 열기, 캡처, 네트워크 보기, 창 닫기와 재연결. (2) 같은 세션을 웹 폴백에서 이어 가며 도구 호출. (3) 웹 폴백에서 만든 세션을 데스크톱에서 열고 `이 세션에서 켜기`. (4) 원격(SSH) 세션: own-web이 `{url: 127.0.<k>.2:LP, username:"opencode", password:<원격 토큰>}`으로 등록, 토큰 재서명(`resolve`) 뒤 재등록, 토큰 만료를 넘기는 긴 attach | (1) 로컬 도구 왕복 성공, 파티션이 디스크에 남지 않음. (2) 호출은 `[browser.disconnected]`로 즉시 실패하고 own-web 배너가 뜸. 카탈로그 변화 0(`toolset_changed` 0). (3) 웹에서 만든 세션의 Code Mode 카탈로그에 `browser` 네임스페이스가 없음. 켜면 카탈로그 delta 1회, 앞 prefix 캐시 유지(`cache.read ≥ 0.9 × 직전 P`, G4 방식), 다른 저장 규칙 보존. (4) attach 성공, 원격 토큰이 셸 로그·userData에 없음(G14), 만료 뒤 재등록으로 복구. 트래픽이 원격 호스트에서 나가는지 기록 | 패인 없이 출시. 원격은 문서화만 |
| G-D6 셸↔렌더러 계약 | must | 셸 rpcHash와 `manifest.json` rpcHash를 일부러 어긋나게 해서 실행. 포인터 교체(`app\current.json`) 뒤 열린 창. 창 다시 로드(Ctrl+R 포함)와 창 복원 | 폴백 페이지와 이유 표시, 크래시 없음, 렌더러가 어긋난 계약으로 IPC를 부르지 않음. junction 교체 뒤 창이 다시 로드되고 lazy chunk 404 없음(§5.5). 다시 로드·복원한 창이 404 없이 같은 세션 라우트로 돌아옴(§6.2) | 렌더러를 셸 번들에서 서빙 |

- G-D1, G-D2는 릴리스마다 다시 봅니다(`own/FORK.md` §11).
- 검증 현황 `[desktop-verdict §8]`: 빌드, own 서비스 연결, main의 인증 주입, NSIS 생성은 PoC로 확인했습니다. browser pane attach(v4), 알림, WCO는 Electron 런타임에서 아직 확인하지 않았습니다.

### 16.3 성능 게이트 (PF1–PF8)

- PF1–PF8(§6.6)은 **릴리스 게이트**입니다. 실패하면 출시를 막습니다. 예외를 둘 때는 릴리스 기록(`own/release/<version>/perf.json`)에 사유를 남깁니다.
- 측정 시작 시점
  - P3 종료부터: own-web 프로덕션 번들에서 PF2–PF5, PF7을 잽니다(웹 폴백 또는 Vite preview).
  - P4 종료부터: 패키지 셸에서 PF1–PF8 전부를 잽니다.
- **패키지 셸 측정 방식.** upstream에 Windows 패키지 빌드용 시작 벤치가 이미 있습니다: `packages/desktop/scripts/bench-startup.ts`.
  - 격리 홈(`%APPDATA%`, XDG, DB, 서비스 등록 분리), 개발자 `OPENCODE_*`·`OTEL_*` 제거, warm/cold 서비스, `--compare`·`--runs`·`--warmup`, 화면 픽셀 기준 `screenPainted`/`screenSettled`, main marks를 줍니다(파일 머리 주석 1–30줄).
  - 패키지 exe를 `--remote-debugging-port`로 띄워(`:298`) CDP로 렌더러 mark를 읽습니다. 그래서 PF1–PF8 모두 **패키지 셸에서 이 CDP 방식으로** 잽니다.
  - 고칠 점: warm/cold 서비스를 번들 CLI 대신 격리 홈의 launcher(`own.cmd start`, `OWN_HOME`·`XDG_*` 재지정)로 띄우는 어댑터가 필요합니다(05 §9.4) ⚠. 렌더러 mark `own:sessions-visible`, `own:sessions-fresh`를 결과에 더합니다.
  - PF1은 이 어댑터의 결과, PF6은 같은 실행에서 시작 뒤 90초 동안의 Event Timing과 long task입니다.
  - (P4 구현) 어댑터 대신 `packages/own-desktop/scripts/perf-shell.ts`(05 §9.4)가 격리 홈에 등록한 서비스로 PF1(§6.6의 확정 정의), PF3(셸 안 스크롤), PF6, PF8을 잽니다. launcher 콜드 시작은 `gates.ts`(G-D1)입니다.
  - dev 빌드용으로는 `packages/app/e2e/performance/devex/desktop-startup.ts`(`bun dev:desktop` + `connectOverCDP`, `:170,216`)가 있습니다. 릴리스 게이트에는 쓰지 않습니다.
- 기계 의존 예산이므로 기준 기계와 조건을 결과에 함께 적습니다: 전원 모드, 빌드 id, 세션 fixture 크기.
- upstream 벤치 중 가져올 것: session-timeline(스트리밍·스크롤), session-tab-switch, home-session-index(목록), composer-history(입력), markdown lifetime(워커), provider-memory(힙)(`packages/app/e2e/performance/`). PF3의 판정은 이 벤치의 rAF 간격이 아니라 CDP trace의 표시 프레임입니다(§6.6).

### 16.4 원격 게이트

- RG1–RG17은 04 §20.3이 기준입니다.
- G14 비밀 위생에 원격 호스트 스캔을 더합니다(04).

### 16.5 원격 접근 게이트 (MG1–MG8, P8)

- MG1–MG8은 05 §14.3이 기준입니다: LAN 비노출(MG1), 페어링(MG2), 범위(MG3), 폐기(MG4), 원격 세션 경유(MG5), 오프라인·재연결(MG6), 푸시(MG7, M2), 비밀 위생(MG8).
- P8 종료 기준은 MG1–MG6과 MG8입니다(§17). MG7은 후속(05 M2)입니다.
- G14 비밀 위생의 스캔 대상에 `devices.json`, 피드, 게이트웨이 로그, push 구독 파일을 더합니다(MG8).

### 16.6 팀 모드·프리셋 게이트 (TG1–TG20, PG1–PG12)

- 팀 모드 게이트 TG1–TG20은 06 §11.3, 프리셋 게이트 PG1–PG12는 07 §8.4가 기준입니다. 단계별 종료 게이트는 07 §8.3의 합친 단계표 하나입니다.
- 자동 시험 위치: own-team `test/e2e/`(TG 시나리오, 가짜 LLM 지시문 하네스), own-accounts `test/presets/pg*.e2e.test.ts`(PG2·PG4·PG10·PG11, e2e-kit 프리셋 rig), own-accounts `test/pg3/`(PG3 A/B 실행기, `--fake`는 시험에서, `--real`은 사용자가 고를 때만), own-web `e2e/team`·`e2e/presets`(TG20, 375 px·키보드).
- 릴리스 스모크(`own/scripts/release-smoke.ts`)는 own.team `health` 왕복(TG1)과, 앱에 든 claude-auth의 기록(`own-bundle.json`의 빌드 id·hash)·로드 순서·확인 상태(`patched`, 동의·계정 없음)를 봅니다.
- 실계정이나 돈이 드는 확인(PG3 `--real`, PG11 실제 DeepSeek 예산, TG의 1주 사용)은 CI에 넣지 않고 사용자가 실행합니다.

### 16.7 가져오기 게이트 (IG1–IG13, IMPORT)

- 다른 도구의 대화 가져오기 게이트 IG1–IG13은 09 §7.4가 기준입니다.
- 자동 시험 위치: own-import `test/unit`(파서 IR 스냅숏 IG2, 경로 IG3, 저장 모양 IG7, 계획 IG9), `test/e2e/`(own-team 하네스로 실제 서버를 띄움: `i1.e2e.test.ts` IG1·IG3·IG10, `migrate.e2e.test.ts` IG7·IG9·IG10·IG12 자동 부분, `helper.e2e.test.ts` IG8), 선택 `test/perf/`(IG4·IG5, `bun run test:perf`), own-protocol `token.test.ts`(IG6), own-remote 게이트웨이 시험(IG11), own-web `bun run test:e2e:import`(화면, IG1 목록 비교). 시험은 모두 합성 fixture만 읽습니다.
- 릴리스 스모크는 `own.import`의 `health`만 부릅니다(이 PC의 Codex·Claude Code 저장소를 읽는 메서드는 부르지 않음).
- 실제 provider로 이어 가기(IG12의 실계정 부분)와 이 PC의 실제 저장소 확인(IG13)은 CI에 넣지 않고 사용자가 실행하거나 허락할 때만 합니다.

---

## 17. 로드맵

완성 범위(결정 D1–D8)의 단계와 종료 기준입니다. 기간은 1인 기준의 대략값입니다.
- 이전 판의 "Phase 3"(credential 풀, Anthropic 1h 모드, computer use 등)은 이 표의 **후속** 단계와 같습니다. 02·03이 "Phase 3"이라고 쓴 곳도 후속으로 읽습니다.
- 이전 판의 "Phase 2 MVP" 종료 기준은 P4 종료 기준에 들어 있습니다. 이 문서에서 "MVP"는 P4 종료 시점을 뜻합니다.

| 단계 | 기간 | 산출물 | 종료 기준 |
|---|---|---|---|
| **P0 기반** (완료) | – | 다음을 갖췄습니다.<br>- Bun 1.4.2, 기준 `bun run check`(심볼릭 링크 복구 뒤 통과)<br>- `own/` 골격: ledger, `check-ledger.mjs`, `check-surface.mjs`, `upstream-surface.json`<br>- own 채널 win-x64 빌드(`own/scripts/build-own.ps1`)<br>- launcher v0(env 브리지 포함)<br>- GitHub Actions 꺼짐(`own/FORK.md` §3) | 완료(2026-09-27) |
| **P1 기반 구현** (완료) | – | 다음을 구현했습니다.<br>- own-protocol: RPC `own.accounts`, 메서드 46개, 이벤트 13개. `accounts.import.codex.*` 포함<br>- own-runtime: vault client, codex source reader, ledger<br>- `own-vault.exe`<br>- `packages/own-accounts/test/e2e-kit` | 완료(커밋 `7aa8017d2a`) |
| **P2 계정 플러그인** (구현 완료, 실계정 게이트 남음) | 3–4주 | own-accounts:<br>- slot 등록·고정 템플릿·유효 limit(R16)<br>- 인증 주입(setup 훅), 세션 고정<br>- Codex device 로그인과 가져오기(linked/takeover, §8.4)<br>- 전환 상태 머신·추정기(02 §5·§6), R1–R8·R10–R16<br>- 한도 관측, plugin allowlist<br><br>그 밖에:<br>- own-telemetry, claude-auth shim, fake-provider<br>- 원격 이음매(04 §21의 2–4, 6, 7) | 게이트 G1–G19의 must가 통과했거나, 실패한 게이트마다 fallback을 결정하고 기록함. 패치 ledger 갱신 |
| **P3 own-web 코어 + 성능 하네스** (완료) | 4–5주 | own-web 코어:<br>- 데이터 층: 서버 목록 추상화, 정규화 store, SSE 합치기, 세션 목록 캐시<br>- 사이드바, 가상화 transcript, IME 우선 composer<br>- 모델@계정 전환기와 비용 대화상자, 한도·컨텍스트 미터(auto-compaction 임계값 표시)<br>- 계정 화면(Codex 가져오기 포함), 플러그인 화면, 프로젝트 플러그인 승인, auto-compaction 설정 화면<br><br>그 밖에:<br>- `OwnHost`(web)와 capability 게이트<br>- P-001/P-002 활성(웹 폴백)<br>- `e2e/performance` 이식과 예산 단언 | 다음을 모두 만족합니다.<br>- PF2–PF5, PF7 통과(프로덕션 번들)<br>- G11, G12 통과<br>- 결정 D6 설정이 UI에서 3클릭 안에 닿음(03 기준)<br>- 원격 이음매 04 §21-1(서버 목록 추상화) 반영 |
| **P4 데스크톱 셸 v0** (= 05 DS0–DS1) (구현 완료, dogfood·merge 남음) | 1–2주. 셸 3–5일 + 통합 | 셸과 설치:<br>- `packages/own-desktop`(§4.1, 05 §4)과 `own open` 연동(§5.3)<br>- `app\<ver>\web`, rpcHash, 설치(NSIS per-user)<br><br>`OwnHost`(desktop) capability(이름은 05 §6.2):<br>- `nativeDirectoryPicker`, `nativeFilePaths`<br>- `osNotifications`(AUMID), `openInApp`, `clipboardImage`<br>- `serviceControl`<br><br>데스크톱 메모리 라우터와 창 복원(§6.2), `bench-startup` 어댑터(§16.3) | 다음을 모두 만족합니다.<br>- G-D1–G-D4, G-D6 통과, 05 DP1–DP5 통과(DP6 should)<br>- PF1–PF8을 패키지 셸에서 통과<br>- **구 MVP 기준**<br>  (1) 세션 목록, 헤더, 턴 footer에 계정과 모델이 100% 표시(미고정 세션은 명시적 표시)<br>  (2) 전환 추정 오차가 ±25% 이내(Codex·Anthropic은 ±15% 목표)<br>  (3) G14 자동 스캔 통과<br>  (4) flap 시나리오에서 자동 전환 0회<br>  (5) 1주 dogfood 동안 세션 유실 0<br>  (6) upstream merge 1회를 ledger 검사와 함께 완료 |
| **P5 필수 기능 1–16 + 네이티브 브라우저** (브라우저는 05 DS2) (완료) | 8–10주 | `[gap]` 1–15와 33을 §17.1 순서로 만듭니다. 16(SSH)은 이음매만 넣습니다 | 다음을 모두 만족합니다.<br>- 기능별 수용 시험(03)<br>- G-D5 통과<br>- PF 회귀 없음<br>- 단축키·라벨 충돌 0(03) |
| **P6 SSH 원격 R0–R3** (R0–R1 구현 완료, 실제 호스트 게이트 남음) | 9–11주(04 §21) | Linux 산출물, own-remote(설치·터널·ensure·askpass), 자격 증명 브로커와 원격 own-accounts, own-web 멀티 서버, 재연결·drain·업데이트, 스킬 동기화, 이전 앱 호스트 가져오기 | 04 §20.3의 must 게이트 통과. 실제 호스트에서 1주 사용 |
| **P7 권장 기능 17–32** (완료) | 6–8주 | `[gap]` 17–32(§17.1) | 기능별 수용 시험, PF 회귀 없음 |
| **P8 원격 접근 (= 05 M1)** (구현 완료, 커밋 전) | 3–4주 | 05 §15 M1이 기준입니다:<br>- 게이트웨이(own-remote, loopback 리스너·기기 인증·범위·프록시·정적 서빙)<br>- `own.remote devices.*`·`gateway.*`와 페어링 UI(QR, 확인 번호)<br>- Tailscale serve 안내·감지<br>- PWA(설치, 오프라인 목록)<br>- 원격 서버 중계(`/srv/<hostId>`) | 05 MG1–MG6, MG8 통과(§16.5) |
| **P9 팀 모드와 프리셋 (T0–T3)** (T0 완료, T1 구현 완료(2.0.18-own.6), T1 사용자 확인 남음, T2 구현 완료(RC 2.0.18-own.7 빌드, T2.21·T2.25 열림), T3 wave 1–4 구현 완료(T3 종료 T3.20과 사용자 확인 T3.21 남음)) | 약 16.5–19주(07 §8.3) | 06·07의 합친 단계표(07 §8.3)가 기준입니다.<br>- **T0**(완료, 2.0.18-own.5): R8 고침과 새 대화 기본 모델(릴리스 ①), 하위 에이전트 관문(`평소대로`), `presets.json`·세션 바인딩, `opencode_models` 거르기, own-team의 선행 조건(06 §10.4). P2 남은 일과 함께 먼저 할 수 있음<br>- **T1**: own-team 패키지(켜기·끄기·되돌리기, 메인 요청·멈춤·보고·깨우기, 담당 대화 교체와 인계 문서, 영역 메인·프리셋, 팀 계정 바꾸기, 설정 `팀`, 팀 도구 8개), 프리셋 편집기·시작 틀·역할 에이전트·안내문·상한·울트라·종량제 동의, 세션 트리 기다리기와 팀 거르기, 컴퓨터 사용과 프리셋·팀의 경계(T1.34)<br>- **T2**(구현 완료, RC 2.0.18-own.7은 내지 않음): 받아들이기, 합치기, 결정 기록, Codex 메타데이터, 수리 알림. T2.21(`CODEX_LONG_CONTEXT` 지우기)은 사용자의 PG7 (나) 증거 전까지 막힘, T2.25는 사용자 확인<br>- **T3**(wave 1–4 구현 완료, 종료 빌드 2.0.18-own.7): 재구성, `.assets`, 공유 폴더, SSH 원격 팀, 원격 프리셋. 게이트 기록 `own/reports/team-t3-gates.md`(06 §11.3) | 단계마다 07 §8.3의 종료 게이트(TG·PG)와 1주 사용. T1: TG1·TG2·TG6–TG9·TG15·TG16·TG20(T1 범위), PG2 (나)–(사)·PG3·PG4·PG9·PG10·PG11. 코어 패치 0개(§12.2) |
| **P10 다른 도구의 대화 (IMPORT I1·I2, 09)** (I1·I2 구현 완료(`main`, IMPORT wave 1–6), 자동 종료 확인 IMP.26과 사용자 확인 IG12·IG13 남음) | 약 3주 | own-import(찾기·색인·읽기 전용 보기·검색, 옮기기 계획·보조 세션 요약·가져오기), own-protocol `own.import`와 `token.ts`, own.accounts `estimate.request`와 측정 제외, 게이트웨이 분기, own-web 화면(사이드바 줄, 프로젝트 `⋯`, 팔레트, 목록, 보기, `이어서 하기` 대화상자, 머리 표시, 설정 > 다른 도구), 런처·번들(데스크톱 번들 여섯) | 09 §7.4의 IG1–IG11 자동 시험, IG12의 fake provider 부분. IG12 실계정·IG13 실제 저장소는 사용자 확인 |
| **후속** | – | 다음을 뒤로 미룹니다.<br>- 05 M2(알림 피드, Web Push), M3(Capacitor 앱, FCM/APNs 중계)<br>- `[gap]` 34–42<br>- 도메인 내 credential 풀(senpi식: 불변 이름, rendezvous affinity, 첫 토큰 전 failover, cooldown 영속화. API 키 전용)<br>- Anthropic "떠나기 전 1h" 모드(R9, G4b), 쿼터 가중치 회귀<br>- computer use 2·3단계(UIA 앱 상태 도구, 사용자 개입 감지, cua-driver 어댑터, §10.2), 그 밖의 도구의 대화 가져오기(09 I3)<br>- P-001/002/004 upstream PR | 기능별 수용 시험, upstream PR 제출 |

### 17.0 진행 현황 (2026-09-28, 릴리스 `2.0.18-own.1`)

단계 이름 옆 괄호가 상태입니다. 종료 기준 중 남은 것은 아래와 같습니다. 릴리스 기록은 `own/release/2.0.18-own.1/`입니다.

| 단계 | 통과한 것 | 남은 종료 기준 |
|---|---|---|
| P2 | own-accounts·own-telemetry 단위·통합 테스트(가짜 provider, 계정 4개로 전환·캐시·한도·ledger·비밀 스캔) | 실계정 PoC 게이트: G2–G8(G4b should), 슬롯을 쓸 때 G9, G16, G19. 실계정이 필요합니다 |
| P3 | PF2–PF5, PF7(프로덕션 번들), G11(웹 폴백 `check:fallback`), G12(IME e2e) | – |
| P4 | G-D1–G-D6(P4–P5). 이 릴리스에서 패키지 셸로 다시 돌린 것: G-D1, G-D2, G-D3 a·f, G-D4, G-D6(`gates.ts --no-keys`, smoke skew·missing·launcher 재시작, 첫 프레임 어두움). PF6/PF8(P4 측정) | 구 MVP 기준 (2) 전환 추정 오차(실계정), (5) 1주 dogfood 세션 유실 0, (6) upstream merge 1회 |
| P5 | 03 수용 시험(e2e p5와 기능별 스위트), G-D5 | – |
| P6 | fake-SSH e2e(설치·터널·브로커·재연결·drain·업데이트), RG2 산출물 단계(교차 빌드, ELF·네이티브 검사) | 04 §20.3 must 게이트를 실제 호스트에서: RG1, RG3–RG7, RG9, RG10, RG13, RG16, RG17, 실제 Linux의 `--version`(RG2), 1주 사용 |
| P7 | 03 §19 수용 시험(e2e p7 14/14와 기능별 스위트), PF 회귀 없음(웹 번들) | – |
| P8 | MG1–MG6, MG8(loopback, 실제 서버, fake-SSH 호스트, 375 px 휴대폰 에뮬레이션). launcher 깨우기(MG9의 launcher 쪽)는 설치 레이아웃에서 확인 | 실제 휴대폰·Tailscale serve, MG9의 휴대폰 쪽, MG10(90분 유휴). 알림 피드의 SSH 세션 항목 |

- 이 릴리스에서 처음으로 **설치 레이아웃의 번들 플러그인을 컴파일된 `opencode.exe` 안에서** 돌렸고, 소스 실행에서는 드러나지 않던 결함 두 개를 고쳤습니다. (1) 번들마다 `effect` 사본이 따로 있어 호스트가 플러그인 RPC 스키마의 정수 검사를 통과시키지 못했습니다(`rpc.invalid_output`). 이제 `@own/protocol` `Portable.definition`(Standard Schema)으로 등록합니다. (2) 호스트는 플러그인을 junction을 푼 실제 경로로 보고하는데, allowlist는 `app\current` 경로로 비교해서 own 플러그인이 `blocked_by_plugin`이 되고 모든 요청에서 인증 헤더가 빠졌습니다. 이제 실제 경로로 비교합니다. 두 결함은 원격 호스트의 번들(own-accounts remote, own-remote agent)에도 해당했습니다.
- 성능: 릴리스 bench(`bun run bench --repeat 5`, 프로덕션 번들, `own/release/2.0.18-own.1/perf.json`)에서 PF1(웹)–PF5, PF7 게이트가 모두 통과했습니다. 다른 앱이 CPU를 62 %(평균 67 %) 쓰던 상태라 수치는 비관적입니다. 같은 날 더 바쁜 상태(82–95 %)의 실행에서는 PF3·PF4 long task가 한 번씩 넘었고, 원인은 기계 부하였습니다(`packages/own-web/ARCHITECTURE.md` §9). PF1 데스크톱·PF6·PF8은 P4 측정 이후 다시 재지 않았습니다.

### 17.1 기능 동등성 범위와 순서 (결정 D5)

- 화면, 문구, 단축키, 재사용할 session-ui export와 `packages/app` 모듈의 adapter 계획은 03이 기준입니다.
- 이 표는 **백엔드 출처**와 **01이 정하는 아키텍처 결정**만 적습니다.
- 번호는 `[gap]`의 번호입니다. 순서는 P5 안의 구현 순서입니다.

| 순서 | # | 기능 | 백엔드 출처 | 01의 결정·제약 |
|---|---|---|---|---|
| 1 | 4 | 작업 패널 배치(리뷰/파일/터미널/브라우저/계정 & 한도) | – | 다른 패널의 전제입니다. 먼저 정합니다(03) |
| 2 | 1 | 권한 dock(하위 에이전트 요청은 부모에 표시) | permission API, `session.permissions` | shell 기본값이 `ask`라서 없으면 턴이 멈춥니다(§13) |
| 3 | 2 | 질문·폼 dock(웹 검색 첫 사용 동의, MCP elicitation) | form API, 내장 `websearch`/`webfetch` | 동의는 서버 폼으로만 받습니다. 도구 목록은 바꾸지 않습니다(§10.1과 같은 이유) |
| 4 | 3 | 로컬 프로젝트 열기 | `fs.list`(control location, 절대 경로) | 데스크톱은 `nativeDirectoryPicker`. `#`이 든 경로는 인코딩합니다. 홈 디렉터리 location을 만들지 않습니다(G15) |
| 5 | 15, 33 | 브라우저 도구 결정과 네이티브 패인 | `opencode.browser` + 셸 호스트 | 세션 생성 때 `browserPane`이 없으면 `browser` deny를 새기고, 켜기는 세션별 명시적 동작(카탈로그 delta 1회)입니다(§10.1, 05 §8.7 안 D). G-D5 |
| 6 | 5 | 리뷰·diff 패널 | `vcs.diff`, `vcs.base`, `session.diff` | diff 계산·렌더는 워커와 lazy chunk로 합니다(PF5) |
| 7 | 6 | 통합 터미널 | PTY API + ticket(`packages/server/src/handlers/pty.ts:118-156`, `packages/core/src/pty/ticket.ts`, 클라이언트 `packages/client/src/solid/pty.ts`), `persistent-pty.*` | 데스크톱도 ticket 흐름을 씁니다(§6.1). `packages/client/src/pty-handoff.ts`는 서비스 재시작 사이의 persistent PTY 인계(prepare/complete)이지 ticket 인증이 아닙니다. 원격 세션은 04 §12.5. 모바일은 `terminal` 범위가 있을 때만(05 §13.5) |
| 8 | 7 | 메시지 되돌리기(revert)와 파일 복원 | `session.revert.stage/clear/commit` | 라벨은 `switch.undo`의 "되돌리기"와 겹치지 않게 03이 정합니다(예: `이 지점으로 복원`). revert 뒤 첫 요청은 prefix가 바뀌므로 cold point로 봅니다(R7) |
| 9 | 8 | 스레드별 승인 모드(읽기 전용/묻기/전체 허용), 저장된 규칙 보기·취소 | `session.create/update{permissions}`, `permission.saved.*` | **모드 전환은 도구 정의를 바꾸면 안 됩니다.** `edit`·`write`·`patch`·`shell`은 Code Mode가 아닌 직접 도구(`codemode:false`, 예: `packages/core/src/tool/plugin/edit.ts:123`, `shell.ts:192`)라서, `resource:"*"` deny는 요청 도구 정의에서 그 도구를 빼고(`packages/core/src/tool.ts:229-232,292-295`) 다음 요청을 cold로 만듭니다. 규칙: `읽기 전용`은 도구를 목록에 남기는 규칙(`resource:"**"` deny, 또는 `ask` + 자동 거절)으로 만듭니다. `"**"`도 모든 자원에 맞지만(`packages/core/src/util/wildcard.ts:3-14`) 전면 deny 판정은 `resource === "*"`만 봅니다(`tool.ts:292-295`). 03 §18.8이 이 방식을 택했습니다. 이 모양을 못 지키는 전환은 cold point로 보고 revert(8번)와 같이 추정치와 경고를 보입니다. agent 전환도 같은 효과가 있을 수 있습니다: agent 권한은 세션 권한 앞에 합쳐지므로(`packages/core/src/session/context.ts:129-134`), 두 agent가 전면 deny하는 도구가 다르면(예: 사용자 정의 agent의 `edit: deny`) 전환 때 도구 정의가 바뀝니다. 내장 plan agent는 `edit`를 `"*"`로 deny한 뒤 plan 디렉터리를 allow하므로(`packages/core/src/plugin/plan.ts:39-40`) 마지막 규칙이 deny가 아니어서 도구가 남습니다. build↔plan 전환의 도구 정의 해시가 같은지는 G4에서 확인합니다 ⚠. 자식 세션은 생성 때만 복사하므로, 모드를 바꾸면 실행 중인 자식도 PATCH합니다. OS 샌드박스는 없습니다(§1.2) |
| 10 | 9 | 대기열·steer 패널 | `session.inbox.*` | 라우터의 WAIT_SAFE가 만든 대기 항목을 보여 줍니다(§8.5). 기본 후속 동작은 03이 정합니다(upstream 기본은 `steer`) |
| 11 | 10 | 첨부 파이프라인 | `fs.write`(experimental)로 `paths.tmp`에 올림 | 데스크톱은 `nativeFilePaths`(로컬 서버 세션만, 05 §6.2)로 경로 첨부, 웹은 업로드. 이미지 정리는 02 D8(prefix)을 따릅니다 |
| 12 | 11 | 하위 에이전트(자식 세션) 화면 | session API | 자식 세션의 계정은 §8.5 규칙(02 Q10)을 따릅니다 |
| 13 | 12 | @ 멘션 데이터 | `fs.find`, `agent.list`, `skill.list`, `reference.list`, `mcp.resource.catalog` | Windows에서는 `fs.find`의 fff가 기본으로 꺼져 있습니다(`packages/cli/src/server-process.ts:121-124`). 순위·속도를 재 보고 launcher env `OPENCODE_DISABLE_FFF=0`으로 켤지 정합니다 ⚠ |
| 14 | 13 | 슬래시 명령 | `command.list`, `session.command` | 클라이언트 명령(`/compact`, `/fork` …)은 own-web에서 다시 만들고, 전환 관련은 라우터 RPC를 거칩니다 |
| 15 | 14 | MCP 관리(상태, 켜기/끄기, OAuth 로그인) | `mcp.*`, `integration.oauth.connect` | lint 예외는 MCP 통합 id(`mcp_<16 hex>`)만 허용합니다(§13 표). 서버 추가·고치기·지우기·연결 시험·다른 도구에서 가져오기·찾아서 설치(공식 MCP Registry, 이 PC에서 묻는다)와 껐다 켠 것의 유지는 own.accounts `mcp.*`다(SM 2026-10-24, 02 §9.2, 03 §18.14). 설정 파일은 쓰지 않는다 |
| – | 16 | SSH 원격 프로젝트 | `own.remote`(04) | P5에는 이음매만 넣습니다. 본체는 P6입니다 |

- **P7(17–32) 중 01이 정하는 것**
  - 18(git 쓰기): v2 VCS API는 읽기 전용입니다. 정해진 git 명령을 `shell.create`로 돌리고, 권한 dock을 거칩니다.
  - 19(워크트리): `worktree.*`와 `session.move`를 씁니다. 세션의 location이 바뀌므로 세션 RPC의 location 규칙(§15)을 따릅니다.
  - 23(백그라운드 작업): `session.background`, `shell.*`를 씁니다.
  - 24(Windows 셸 선택): `PATCH /api/experimental/config{shell}`을 씁니다. 에이전트 도구와 터미널의 셸이 같이 바뀝니다.
  - 26(스레드 노트): 모델에 보이는 노트는 뒤에 덧붙는 instruction entry만 씁니다. prefix 앞부분을 바꾸지 않기 위해서입니다(R8).
  - 27(고정·보관): v2에 보관 API가 없으므로 own metadata 네임스페이스를 씁니다. 포크하면 이 플래그를 지웁니다.
  - 32(단축키 정리): 03이 충돌을 정리합니다. 대상은 Ctrl+B(백그라운드 대 사이드바), Ctrl+., Ctrl+Shift+L입니다.
- **하지 않는 것(43–46)**
  - 세션 탭 줄, 셸 자동 업데이트와 딥 링크, 데스크톱 네이티브 메뉴
  - upstream 전역 계정 전환(`credential.activate`)과 내장 provider 연결 흐름
  - v2에 없는 기능(LSP 진단, 음성 입력, 예약 자동화)
  - 세션 공유 등

  모바일·QR 페어링은 43에서 빠져 P8·후속으로 옮겼습니다(결정 D3).

---

## 18. 리스크

1. **v2 계약 변동.** 전체 API가 experimental로 표시돼 있고(`packages/protocol/src/api.ts:190`), `promise/session.ts`에서도 kind 이름 변경 같은 파괴적 변경이 있었습니다 `[research]`. 대응: check-surface, 릴리스 marker 단위 merge, 버전 고정.
2. **Auth.none 경로의 안정성.** upstream이 조건을 바꾸면 인증이 조용히 전역 credential이나 env로 떨어질 수 있습니다. G2 자동 테스트를 sync마다 실행합니다. 대체는 02 §3.7.
3. **세션 밖 LLM 호출.** `generate.text` 계열은 우리 인증을 받지 못합니다(§8.3). upstream이 세션 기능을 이 경로로 옮기면(예: title) 조용히 401이 늘어납니다. check-surface가 `model.request` trigger 위치를 감시합니다.
4. **프로젝트 플러그인.** allowlist는 악의적 in-process 코드를 막지 못합니다(§13.2). 믿을 수 없는 저장소는 `--untrusted`로 엽니다.
5. **claude-auth-v2.** 1인 유지보수에 beta이고 provenance attestation이 없습니다. Anthropic 서버 측 차단(버전 문자열 등)으로 언제든 깨질 수 있습니다. 슬롯은 **없어도 제품이 완결**되도록 설계합니다.
6. **bun.lock.** merge할 때마다 재생성해야 하고, 그러려면 Bun이 필요합니다(1.4.4 설치됨, 2026-10-31; 1.4.2는 2026-09-27). upstream이 `packageManager`의 Bun 버전을 올리면 husky가 그 버전을 요구합니다(`own/FORK.md` §3).
7. **데이터 루트 공유.** data/state/cache 루트가 upstream 설치본과 공유되므로 로그와 기타 파일이 섞일 수 있습니다(DB는 분리됨).
8. **라이선스.** 우리 패키지는 MIT예요(사용자 결정 2026-11-26). 예외는 `own/THIRD-PARTY-NOTICES.md`.
9. **데스크톱 deep import와 치환의 drift.** `packages/desktop`은 안정 API가 아닙니다. 절대 경로 기반 `resolveId` 치환은 upstream이 파일 이름을 바꾸면 조용히 깨집니다. 대응은 셋입니다.
   - 매칭 안 된 치환 키가 있으면 `buildEnd`에서 빌드를 실패시킵니다.
   - vendor·치환·deep import 경로를 `upstream-surface.json`에 등록합니다.
   - sync 때 own-desktop 빌드를 돌립니다(`own/FORK.md` §4).
10. **셸·렌더러·서비스 버전 결합.** 렌더러는 `app\<version>\web`에서, 셸은 별도 설치에서 옵니다. 셸 IPC 계약이 바뀌면 렌더러가 깨질 수 있습니다. rpcHash와 폴백 페이지(§5.3 c, G-D6), 버전 스큐 배너(§5.3 d), junction 교체 뒤 창 다시 로드(§5.5 7)로 드러나게 합니다.
11. **Electron 툴체인.** 위험 요소는 다음과 같습니다.
    - electron-vite가 6.0.0-beta.1 베타입니다.
    - electron-builder는 `bun.lock` 감지가 필요합니다. 스크래치 디렉터리에서는 `npm ls`로 떨어졌습니다 `[desktop-build §2]`.
    - Electron 바이너리가 151MB입니다.
    - 서명이 없어 SmartScreen 경고가 뜹니다.
    - Windows toast에는 설치 바로가기의 AUMID가 필요합니다.
12. **성능 회귀.** upstream session-ui·client가 바뀌면 PF 예산이 조용히 깨질 수 있습니다. PF 게이트를 릴리스마다 돌리고, sync 뒤에도 PF2·PF3·PF4를 봅니다.
13. **linked Codex 원본 의존.** 이전 앱이 refresh를 멈추면 linked 계정도 멈춥니다. `codex_source_stale`로 드러내고 takeover를 제안합니다(§8.4). 이전 앱이 파일 형식을 바꾸면 읽기가 실패하고 `source_invalid`로 드러납니다.
14. **브라우저 도구의 세션별 정책의 대가.** (a) 데스크톱에서 만든 세션을 웹 폴백이나 휴대폰에서 이어 가면 카탈로그에 브라우저가 있지만 호출은 `[browser.disconnected]`로 실패하고, 그 문구는 모델에게 데스크톱을 기다리라고 합니다. own-web 배너로 사용자에게 알립니다. (b) 데스크톱 세션과 웹 세션은 카탈로그 Instructions가 달라 세션 사이 prefix 공유가 그 지점부터 줄어듭니다. 세션 안의 캐시에는 영향이 없습니다. (c) 켜기 delta가 앞 prefix를 유지한다는 것은 아직 측정 전입니다(G-D5). 모두 05 §8.7의 판단을 따릅니다(§10.1).
15. **원격 기기 노출(P8).** 게이트웨이는 새 공격면입니다. 허용 목록 범위, LAN 바인딩 금지, 기기 토큰과 터널의 이중 방어를 둡니다(§13.4, 05 §13.8). P8 전에는 만들지 않습니다.
16. **takeover 뒤 이전 앱의 refresh.** 이전 앱이 takeover한 프로필을 계속 돌리면 토큰 계열이 둘로 갈라지고, 재사용 감지 방식에 따라 우리 계정도 죽을 수 있습니다 ⚠. 선행 조건(이전 앱에서 멈춤), 직후 강제 refresh, `source_refreshed_concurrently` 분류로 줄입니다(§8.4, G19).
17. **프로젝트 config의 compaction 재정의.** 프로젝트 `.opencode/opencode.json`이 `compaction.auto:false`나 `buffer`를 두면 D6의 보수적 기준이 조용히 바뀌거나 꺼집니다. Location별 계산과 경보로 드러내고(R16), 믿을 수 없는 저장소는 `--untrusted`로 엽니다.

---

## 19. 근거 파일 색인 (로컬)

- 플러그인 API: `packages/plugin/src/promise/{plugin,session,provider,model,registration,adapter}.ts`, `packages/plugin/src/host.ts:17-43`, `packages/plugin/src/source.bun.ts`, `packages/plugin/src/source.node.ts`
- 플러그인 호스트와 로딩: `packages/core/src/plugin/{host,hooks,supervisor,internal,module,source-directory}.ts`, `packages/core/src/plugin.ts:100-140`, `packages/core/src/config/plugin/source.ts:110-170`
- 인증과 모델 해석: `packages/core/src/model-resolver.ts:355-459`, `packages/core/src/generate.ts`, `packages/core/src/session/runner/model.ts:83-107`, `packages/ai/src/route/{auth,auth-options}.ts`, `packages/ai/src/route/transport/http.ts:50-59`
- 요청과 훅: `packages/core/src/session/model-request.ts:200-360`, `packages/core/src/session/context.ts:85-135`, `packages/core/src/session/title.ts:120-135`
- 캐시 관련: `packages/core/src/plugin/identity.ts`, `packages/core/src/session/runner/to-llm-message.ts:153-248`, `packages/core/src/session/model-transport.ts:117,309-335`, `packages/ai/src/cache-policy.ts`, `packages/ai/src/effort-updates.ts`
- 오류와 재시도: `packages/core/src/session/runner/retry.ts`, `packages/ai/src/provider-error.ts:100-170`, `packages/ai/src/protocols/open-responses.ts:1372-1460`
- ChatGPT 배선: `packages/core/src/plugin/provider/openai.ts:13-25,254-316`
- 서비스와 채널: `packages/cli/src/{database-path,version,server-process}.ts`, `packages/cli/src/services/{service-config,updater,web-ui}.ts`, `packages/client/src/effect/service.ts`, `packages/client/src/service-contender.ts`, `packages/util/src/global.ts`
- 서버: `packages/server/src/location.ts:39-47`, `packages/core/src/rpc.ts:85-120`
- UI 임베드: `packages/cli/script/app-assets.ts:6-12`, `packages/cli/src/app-assets.ts:10-36`, `packages/cli/script/build.ts:151-158`
- 비밀 패턴: `packages/http-recorder/src/redaction/secrets.ts`
- 데스크톱 셸: `packages/desktop/package.json:26`, `packages/desktop/electron-builder.config.ts:92-107`, `packages/desktop/src/main/{index,desktop,constants,ipc}.ts`, `main/lifecycle/{configure,environment,index,onboarding}.ts`, `main/service/{background-service,desktop-cli,sidecar-credentials,sidecar-probe}.ts`, `main/ipc-handlers/app.ts:71`, `main/native/install-cli.ts`, `main/windows/{scheme,protocol,security,headers,early,index}.ts`, `main/native/menu.ts`, `main/ipc-handlers/events.ts`, `main/wsl/sidecar.ts`, `main/remote/cli.ts`, `src/renderer/desktop-app.tsx:32,73`, `src/preload/index.ts:24-29`, `packages/client/src/promise/service.ts:85-129`, `own/launcher/own.cmd:4`
- 브라우저: `packages/desktop/src/main/{browser-pane,browser-chromium}.ts`, `packages/app/src/runtime/platform/browser-pane.ts:3-9`, `packages/plugin-browser/src/{index,connection,tools,rpc}.ts`(도구 호출 실패 문구 `connection.ts:136-141`), `packages/core/src/plugin/internal.ts:89,213-216,271`, `packages/core/src/plugin/supervisor.ts:25-60`, `packages/core/src/config/plugin/source.ts:113-120`
- 도구 목록과 Code Mode 카탈로그: `packages/core/src/tool.ts:220-295`, `packages/core/src/codemode/{tool,instructions}.ts`, `packages/core/src/session/{context,instruction-state}.ts`, `packages/core/src/tool/plugin/{edit,write,patch,shell}.ts`(`codemode:false`), `packages/core/src/plugin/{agent,plan}.ts`, `packages/core/src/util/wildcard.ts`, `packages/core/src/session.ts:273-276`
- compaction: `packages/core/src/session/compaction.ts:38-44,187-233,290,385-393,654,866-883`, `packages/core/src/config/plugin/compaction.ts`, `packages/core/src/config/discovery.ts:33-36`, `packages/protocol/src/groups/config.ts:9-21`, `packages/core/src/variant.ts:45-72`
- Codex 가져오기: `packages/own-protocol/src/{credential,rpc,alert}.ts`, `packages/own-runtime/src/{codex-source,credentials}.ts`(takeover `credentials.ts:285-316`, 강제 refresh `refresh(…, {force})`)
- PTY ticket: `packages/server/src/handlers/{pty,persistent-pty}.ts`, `packages/core/src/pty/ticket.ts`, `packages/client/src/solid/pty.ts`, `packages/server/src/middleware/authorization.ts:81-84`. persistent PTY 인계는 `packages/client/src/pty-handoff.ts`
- 페어링·원격 기기: `packages/server/src/{pairing,auth,cors}.ts`, `packages/cli/src/commands/handlers/pair.ts`, `packages/app/src/settings/pairing/pairing.tsx`, `packages/app/src/servers/connect/scanner.tsx`
- MCP OAuth: `packages/core/src/mcp/index.ts:165-200`, `packages/app/src/providers/connect/mcp.ts:30-55`
- 웹 폴백 CSP: `packages/cli/src/services/web-ui.ts:7-70`
- 성능: `packages/app/e2e/performance/README.md`, `packages/app/e2e/performance/benchmark.ts`, `packages/app/e2e/performance/devex/desktop-startup.ts`, `packages/desktop/scripts/bench-startup.ts`, `[old] docs/design/{input-latency-67,electron-background-performance-65,input-and-runtime-performance-68,profile-launch-latency-66}.md`
- 사전 리서치: 세션 scratchpad의 `report.md`, `critique.md`, `cache_design.md`, `cache_verify.txt`, `cache.json`, `claudeauth.json`, `ocu.json`, `omo_summary.txt`
- 2026-09-27 연구: 같은 scratchpad의 `desktop_verdict.md`, `desktop_build.md`, `gap_final.md`, PoC 디렉터리 `own-desktop-poc`

---

## 20. 미확인/열린 질문

**검증이 필요한 사실**
1. **Codex 백엔드의 캐시 범위·TTL·lookback, 구독 한도에서 cached 토큰의 가중치.** 공식 문서가 없습니다. 측정값으로 교체합니다(T2, T5, 회귀, 02 Q1·Q2).
2. **훅 안의 `switchModel`.** prompt 훅과 `Compaction.Ended` 처리 중(G8b/AC-P26), retry 훅(G8 should/AC-P17b). 통과 전에는 idle에서만 전환합니다.
3. **Codex WS 오류 프레임의 실제 형태와 core 분류.** status 필드 유무, `usage_limit_reached` 메시지 문구, RateLimit/QuotaExceeded 중 무엇이 되는지(G8). §14.3의 `ws.receive` 저장소는 어느 쪽이든 동작하게 설계했습니다.
4. **헤더 이름.** `anthropic-workspace-id`, Anthropic organization 헤더, `openai-organization`/`openai-project`, xAI·OpenRouter·DeepSeek probe 응답은 로컬 소스로 확인하지 못했습니다(G2/G7/G9, 02 Q6).
5. **Anthropic 1h hint.** beta 헤더 없이 받아들여지는지, 기존 5m 항목을 다시 쓰는지(비용), tail을 1h로 둘지 5m로 둘지(G4b/AC-P16).
6. **OpenRouter Claude/Gemini의 수동 hint 효과**(R15, AC-P31).
7. **Bun 런타임에서 `.cmd` spawn 동작.** §9.2는 `node.exe + npm-cli.js`로 피해 가지만, Node 설치 레이아웃이 다르면(예: 패키지 관리자 설치) 대체 경로를 탑니다.
8. **Windows 서비스의 MCP 등록 버그**(anomalyco/opencode#50710)가 2.0.18 fork base에 남아 있는지(G1).
9. **control location의 비용.** control location(§15)은 프로젝트와 별개의 Location이라 전역 MCP 서버를 한 벌 더 띄울 수 있습니다. G15에서 기동 비용을 측정하고, 결과가 나쁘면 관리 RPC의 location 정책을 고칩니다.
10. **(v0.4) 검증이 더 필요한 것**
    - **R16: own-accounts가 Location의 유효 compaction 설정을 아는 방법.** (a) 코어와 같은 발견 규칙으로 문서를 직접 읽기, (b) `GET /api/config`를 runtime 내부 client로 조회하기 중 무엇으로 할지, config 변경을 어떻게 알지(§8.7 R16). 둘 다 코어 동작을 복제하거나 자기 서비스를 부르는 것이라 G16에서 정합니다. 결정 전까지는 02 §4.7.2의 `compaction_threshold_mismatch`(사후 탐지)만 확실합니다.
    - **R16: 프로젝트 `auto:false`일 때의 대체.** slot 기준을 `compaction.due` 클라이언트 경로로 지킬지(클라이언트가 붙어 있을 때만, overflow 복구 없음), 경고만 할지.
    - **takeover: OpenAI refresh token 재사용 감지의 범위.** 이미 회전된 refresh token을 이전 앱이 쓰면 계열 전체(우리 새 토큰 포함)가 폐기되는지(G19 실계정). `source_refreshed_concurrently` 판정 기간(초기값 24시간)도 측정 뒤 정합니다.
    - **원격 세션 패인: 토큰 만료와 긴 attach.** 이미 열린 attach 스트림이 원격 토큰 만료 뒤에도 유지되는지, 재등록이 `replaced`로 앞 attachment를 닫는지(G-D5 (4)).
    - **PF2의 이벤트→페인트 기준(33ms)**은 60Hz 가정의 초기값입니다. 기준 PC의 주사율과 Event Timing의 8ms 반올림을 반영해 첫 측정 뒤 정합니다.
    - **CLI를 번들하지 않은 NSIS 패키지.** `afterPack`을 덮어쓴 빌드를 아직 만들어 보지 않았습니다(§4.1, DS0).

**02·03과 맞춰야 할 부분 (이전 판에서 제안한 변경)**
11. **oai slot의 transport (AC-P04로 결정).** 이 문서는 upstream openai 기본값과 같게 websocket을 제안합니다(`openai.ts:260`, 동등성). 02 §3.6은 codex 외에는 transport를 적지 않아 HTTP이고, 한도 헤더를 매 응답에서 얻는 이점이 있습니다(02 §7.1). AC-P04에서 hit률 차이가 없으면 02 쪽(HTTP)을 따릅니다. 결정 전까지 §8.2 표의 값은 미정입니다.
12. **UI 표시.** 03에 "기본값(미고정)" 세션 칩과 [이 계정으로 고정] 동작, 프로젝트 플러그인 승인 화면을 추가해야 합니다.

**리뷰 지적 중 일부만 반영한 것**
13. **R13(title)**: 리뷰는 "Codex 필터가 mini 모델을 꺼서 title이 primary로 간다"고 했습니다. 로컬 소스로는 `Model.small`이 family `gpt-luna`를 먼저 찾고 `gpt-5.6-luna`는 필터를 통과하므로(`model.ts:256-268`, `openai.ts:23-25,282-291`), 템플릿에 luna가 있으면 title은 luna로 갑니다. primary로 가는 것은 luna가 없거나 호출이 실패할 때입니다(`title.ts:127-133`). 인용 위치(`context.ts:95-119`)와 구독 한도 영향은 반영했습니다. Codex 백엔드가 luna를 실제로 받는지는 G3에서 확인합니다.
14. **R9의 TTL 조합**: 리뷰 예시는 1h/1h/1h/5m이고, 02 §4.5는 4×1h입니다. 둘 다 순서 규칙을 만족하므로 4×1h를 기본으로 두고 두 변형을 G4b에서 비교합니다.

**사용자 결정이 필요한 것**
15. 구독 → 종량제 자동 전환 기본값(`ask`, 02 Q12), 비공식 `wham/usage` 폴링 허용 여부(02 Q8).
16. 믿을 수 없는 저장소를 여는 기본 모드: allowlist(기본) 대 항상 `--untrusted`.
17. (닫힘, T0–T1) 서브에이전트가 부모 세션의 계정을 상속하게 할 방법(02 Q10). 07 프리셋이 정했습니다: 처음 값은 `메인과 같게`(부모 Ref 상속), 다른 대상은 프리셋 역할로만 고르고 하위 에이전트 관문이 메인 계정과 허용 대상 밖을 막습니다(07 §5.4, 02 §5.11). 같은 회사의 다른 구독 계정은 대상이 될 수 없습니다(R4). 팀 모드(06)의 열린 질문도 없습니다(옛 06 Q1–Q4는 06 §12.2에서 정함).

**데스크톱·모바일·성능 (2026-09-27 추가)**
18. **렌더러 위치.** 이 문서는 `app\<version>\web`을 기본으로 둡니다. 서비스와 함께 교체되기 때문입니다. 대안은 셸 번들(단순, PoC 방식)입니다. G-D6이 불안정하면 셸 번들로 바꿉니다.
19. **own-web이 desktop 렌더러 api를 쓰는 방법.** 두 안이 있습니다.
    - 타입 전용 reference(own-web tsconfig에 `../desktop`)와 dynamic import
    - 3파일(`renderer/api.ts`, `ipc-client.ts`, `shared/ipc-transport.ts`) vendor

    03과 함께 정합니다.
20. **(닫힘, 2026-10-18) 트레이와 상주 모드.** 05 §7.3에 구현했습니다. 치환 없이 `windows-own.ts`의 창 `close`에서 마지막 앱 창을 숨기고, 기본값은 트레이로 숨기기입니다(사용자 요청). 이 문서의 이전 판에 있던 "`lifecycle/index.ts` 치환"은 05가 기각했습니다.
21. **lighthouse 포함 여부.** 브라우저 감사 기능과 설치 크기를 바꾸는 선택입니다.
22. **셸 설치와 업데이트.** `install.ps1`이 NSIS 설치까지 맡을지, 셸은 따로 설치할지 정해야 합니다. 서명(SmartScreen), 시작 메뉴 바로가기(AUMID, G-D4)도 같이 정합니다.
23. **웹 폴백의 P-001/P-002.** 결정 D1로 웹 폴백을 유지하므로 둘은 남깁니다. 게이트웨이(05 §13.4)가 생기면 패치 없는 서빙으로 바꿀지 다시 봅니다(05 §19 질문 20). 바꾸면 코어 패치는 0개가 됩니다.
24. **(닫힘, v0.4) 권한 규칙이 도구 정의를 바꾸는가.** 바꿉니다. `resource:"*"` deny인 도구는 스냅샷에서 빠집니다(`packages/core/src/tool.ts:229-232,292-295`). 그리고 agent 권한과 세션 권한이 그 스냅샷에 들어갑니다(`session/context.ts:129-134`). 다만 효과는 도구 종류에 따라 다릅니다.
    - 직접 도구(`codemode:false`: edit·write·patch·shell 등)는 요청 도구 정의에서 빠지므로 prefix가 바뀝니다. 승인 모드는 이것을 피하는 규칙 모양을 씁니다(§17.1 9번).
    - Code Mode 도구(브라우저 도구 등, `codemode:true`)는 요청 도구 정의가 아니라 세션별 카탈로그 Instructions에서 빠집니다. 바뀌면 delta가 뒤에 붙습니다(`codemode/tool.ts:61`, `session/instruction-state.ts:41-60`).
    - 그래서 `browser` deny는 "정의는 유지하고 호출만 막기"에 쓸 수 없고, 이전 판의 "설치 프로필"도 전제가 틀렸습니다. 브라우저 정책은 05 §8.7 안 D(세션 생성 때 새김)로 바꿨습니다(§10.1).
25. **(닫힘, v0.4) 원격 호스트의 브라우저 도구.** 설치 프로필이 없어졌으므로 상속할 것이 없습니다. 원격 세션도 만드는 own-web 호스트의 `browserPane`으로 생성 시점에 정합니다(§10.1).
26. **(닫힘, v0.4) 게이트웨이 위치·터널·토큰 수명.** 05 §13.3–§13.5가 정했습니다: own-remote가 own-runtime 프로세스 수명 런타임에 여는 loopback 리스너, `tailscale serve`(권장), 토큰 기본 90일·30일 유휴 만료. `tailscale serve` 구성의 실측과 사용자 결정(Tailscale 설치)은 05 §19 질문 15·29가 추적합니다.
27. **PF 예산 초기값.** PF5(gzip 400KB)와 PF7(100ms)은 측정 전 초기값입니다. PF1(1초)은 P4에서 정의를 확정하고(§6.6) 패키지 셸에서 쟀습니다: 셸 시작 → 목록 표시 warm p95 약 830–950ms, 중앙값 약 740ms, spawn 기준 중앙값 약 900ms(05 §9.1). 콜드 userData(캐시 없음, 서버 목록)는 셸 시작 기준 p95 약 950–1,050ms라 판정 밖이지만 경계에 있습니다. 첫 표시를 정하는 것은 GPU 프로세스(D3D11 장치 생성 약 320ms)와 첫 프레임 raster입니다(05 R-D13).
28. **R16의 한계.** 다음은 코어 패치 없이는 안 됩니다. 02가 요구사항을 정하면 §12에 후보 패치로 올립니다.
    - slot별 `keep`
    - 세션별 "더 늦게"와 "이 세션만 끄기"
29. **linked Codex와 SSH 브로커.** 브로커는 lease 전에 최소 남은 수명을 요구합니다(04 §8.5). linked 계정은 refresh할 수 없습니다. 이때 lease를 거부할지, 짧은 lease를 줄지 02·04와 정해야 합니다.
30. **Windows `fs.find`(fff).** 기본으로 꺼져 있습니다(`server-process.ts:121-124`). @멘션 순위를 재 본 뒤 launcher에서 켤지 정합니다(§17.1).
31. **Electron 셸 E2E 방식 (좁힘, v0.4).** 패키지 셸은 upstream `bench-startup.ts`처럼 `--remote-debugging-port`로 띄우고 CDP로 붙는 방식으로 정했습니다(§16.3). 남은 것은 launcher 기반 warm/cold 어댑터가 격리 홈에서 동작하는지(05 §19 질문 13)와, own-web 벤치를 CDP 연결 위에서 돌릴 때 upstream `benchmark` 픽스처(Playwright 페이지 기준)를 어떻게 붙일지입니다 ⚠.

**다른 문서가 맞춰야 할 계약**
32. **02**
    - (반영됨, 02 v0.3) §3.1 C3의 세 출처(vault, linked, takeover), `accounts.import.codex.{list,plan,execute}`(§9.2), 경보 `codex_source_stale`(§7.7), R16 필드(§4.7: `ctx_eff`, `accounts[].compaction`, `compaction.setSession`, `compaction.due`, `cache.state.compaction`), 플러그인 순서, takeover 직후 강제 refresh(§3.2a). 기기 토큰 정책은 05가 기준입니다.
    - (v0.4 새 요청) **D10을 05 §8.7 안 D로 바꿉니다.** "설치 단위 설정 하나로만"과 "세션 단위 permission으로 끄지 않는다"를 "세션 생성 때 `browserPane`이 없는 호스트면 `browser` deny를 새기고, 켜기는 세션별 명시적 동작(카탈로그 delta 1회)"으로 바꿉니다. 브라우저 도구는 Code Mode라 요청 도구 정의 hash가 아니라 카탈로그 Instructions가 바뀝니다. AC-P42의 "설치 단위 off/on 전환"과 §12 질문 25도 같이 고칩니다. "Browser is unavailable." 인용은 `[browser.disconnected]`(`connection.ts:136-141`)로 고칩니다.
    - (v0.4 새 요청) §4.7.2: 프로젝트 config의 `compaction.buffer`/`auto:false`를 사후 경보만이 아니라 Location별 유효 `limit.input` 계산(`buffer`가 있으면 `T + buffer`)과 사전 경고로 다룹니다(§8.7 R16). 경보 코드(예: `compaction_overridden_by_project`)를 §7.7에 더합니다.
    - (v0.4 새 요청) §3.2a takeover: `plan` 경고에 "이전 앱에서 이 프로필을 먼저 멈추기"를 더하고, takeover 뒤 일정 기간의 `refresh_token_reused`/`invalid_grant`를 reason `source_refreshed_concurrently`로 분류해 re-link를 제안합니다(§8.4).
33. **03**
    - `OwnHost`의 인터페이스와 capability 이름은 **05 §6.2**를 씁니다. 03 §16.7의 `has("fs.pickDirectory")` 식 어휘와 `browser.pane` 등은 05 이름(`nativeDirectoryPicker`, `browserPane` …)으로 맞춥니다. UI는 capability로 게이트합니다.
    - `src/host/desktop.ts`만 `@opencode/desktop`을 import할 수 있게 합니다.
    - §18.15의 브라우저 정책은 05 §8.7 안 D와 같습니다. 다만 두 곳을 고칩니다: 호스트 없는 호출의 결과는 `[browser.disconnected]`(`connection.ts:136-141`)이고, 켜기의 비용은 "캐시를 처음부터 다시 씀"이 아니라 "카탈로그 delta 한 번(앞 prefix 유지 예상)"입니다. 데스크톱 세션을 웹·모바일에서 이어 갈 때의 배너 문구가 필요합니다(§10.1).
    - §18.8 승인 모드의 `resource:"**"` 규칙 모양은 이 문서 §17.1 9번과 같습니다. 모양을 못 지키는 전환(agent 전환 등)의 cold 경고 문구가 필요합니다.
    - 성능 예산 수치는 이 문서 §6.6을 인용합니다. 특히 B3(입력 지연)의 정의를 PF2(처리 지연 p95 ≤ 16ms + 이벤트→페인트 p95 ≤ 33ms, own 리스너로 분모)로, B5의 판정을 PF3(CDP trace의 표시 프레임)로 맞춥니다. B7(350KB)과 PF5(400KB)의 차이는 03이 더 엄격한 쪽으로 두어도 됩니다.
    - 데스크톱 모드는 메모리(또는 해시) 라우터, 웹 폴백은 path 라우터입니다(§6.2). 워커는 같은 origin 파일로만 만듭니다(§6.1).
    - 세션 목록 캐시는 localStorage입니다(§6.3).
    - takeover 확인 대화상자에 "이전 앱에서 이 프로필을 멈췄습니다" 확인과 `source_refreshed_concurrently` 문구가 필요합니다(§8.4).
    - 프로젝트 config가 auto-compaction을 바꾸거나 끌 때의 경고 문구가 필요합니다(R16).
    - MCP OAuth lint 예외(§13 표)를 반영합니다.
    - auto-compaction 설정의 위치를 정합니다: provider/모델/계정 단위와 세션 재정의, 컨텍스트 미터의 임계값 표시.
    - `[gap]` 1–32의 라벨과 단축키 충돌을 정리합니다.
34. **04**
    - 데스크톱 main에서 SSH를 하지 않는다는 것을 명시합니다. upstream Ssh/Wsl 레이어는 비활성입니다(§11).
    - 렌더러가 원격 토큰을 직접 붙이는 경로를 반영합니다. 데스크톱의 CORS는 main의 응답 헤더 덮어쓰기(`windows/headers.ts:10-20`)로 통과하고, `cors.ts`는 웹 폴백에만 의미가 있습니다.
    - **§12.1: 원격 세션의 브라우저 패인을 위해 own-web이 원격 토큰을 셸 main에 넘기는 예외**를 더합니다(§10.1). 토큰 범위는 같고, own-web은 `tokenExpiresAt` 1시간 전·`epoch` 변경·패인 `suspended` 때 재등록합니다.
    - 모바일은 게이트웨이의 `/srv/<hostId>` 중계로만 원격 세션에 닿습니다(§6.4, 05 §13.4).
35. **05**
    - §4.3의 environment.ts 치환 설명은 "export 6개"라고 하지만 실제 export는 5개입니다(`installContextMenu`, `prepareApplicationEnvironment`, `preferApplicationEnvironment`, `prepareDesktop`, `loadProxyEnvironment`, `packages/desktop/src/main/lifecycle/environment.ts:12-49`).
    - §8.2의 원격 패인 등록 형태를 이 문서 §10.1의 계약(`username:"opencode"`, 토큰 재등록 조건)과 맞춥니다.
    - §6에 라우팅·창 bootstrap 계약(§6.2)을 더합니다.
    - §9.1의 입력 지연 측정을 PF2 정의(§6.6)와 맞춥니다. DP2의 "Event Timing p95 ≤ 16ms"는 분모가 없으므로 PF2의 처리 지연 정의로 바꿉니다.
    - §13.6의 피드 종류에 linked Codex의 `codex_source_stale`(05의 `auth.expired`에 포함되는지)을 명시할지 정합니다.
36. **표기.** 모든 문서에서 번호를 이렇게 구분합니다.
    - 사용자 결정: "결정 D1–D8"(05는 "U-D1–U-D8")
    - 데스크톱 게이트: "G-D1–G-D6"(05는 "D1–D6")
    - 성능 게이트: "PF1–PF8", 셸 게이트 "DP1–DP6", 원격 접근 게이트 "MG1–MG8"
    - 02의 결정성 규칙: "02 D1–D10"
