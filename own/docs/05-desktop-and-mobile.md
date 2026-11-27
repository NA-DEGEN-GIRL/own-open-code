# 05. 데스크톱 앱과 모바일 확장 설계

| 항목 | 값 |
|---|---|
| 문서 | `own/docs/05-desktop-and-mobile.md` |
| 상태 | 초안 v0.2 (2026-09-27). 결정 D1·D2·D3·D4·D8 반영. v0.2는 리뷰 반영판이다: 이름·게이트·계약을 01/02/03/04/FORK v0.3에 맞추고, 소스로 다시 확인한 사실을 고쳤다. **06 T3(2026-10-04)**: 13.5 `own.team` 범위표(재구성, 원격 `/srv`), 13.6 FeedKind `team.decision`과 그 출처. **upstream v2.0.24 sync(2026-10-08)**: upstream이 브라우저 패인·SSH·WSL·업데이터·pairing을 GUI 확장(`packages/gui-extensions`, f406d93a66)으로 옮긴 데 맞춰 셸의 확장 목록(브라우저 하나), 설치형 확장 거부, 브라우저 패인 연결(8.1·8.2), rpcHash 입력(5.5), Electron 44.4.5. **IMPORT(2026-10-09, 09)**: 13.4 게이트웨이의 `own.import` 분기, 13.5 `own.import` 범위표(Q2 결정: 보기 `read`, 옮기기 `prompt`, 찾을 곳 `local`, `/srv/<hostId>` 거부). **NOTES(2026-10-09)**: 8.8 워크스페이스 `노트` 탭을 PC 서비스(own-accounts `notes.*`)에 저장, 13.4 `notes.put` 본문 1 MiB, 13.5 노트 범위(읽기 `read`, 저장·삭제 `prompt`). **VOICE(2026-10-09, 02 §3.9)**: 4.3 `windows/security.ts` 치환(렌더러에 마이크, 오디오만), 7.8 마이크 권한(데스크톱·원격 PC 창·휴대폰 PWA·Android 앱), 13.4 `voice.transcribe`의 본문 한도와 `/srv/<hostId>` 거부. **팀 말로 시키기(V, 2026-10-09, 06 §2.9)**: 13.4 기기 프롬프트의 기기 표시 `own.device`(클라이언트 값 덮어쓰기, 본문 4 MiB). **SPLIT(2026-10-11, 03 §4.1.1)**: 창 하나에 분할 4개까지(7.2), 분할마다 브라우저(8.2·8.3), 여러 뷰를 함께 보이기와 뷰 포커스·분할 키 넘기기(8.5, `own:browser.view-focus`·`own:browser.view-key`, rpcHash 입력 `own-api.ts` 바뀜). **ZL(2026-10-18)**: 4.3 `windows/appearance.ts` 치환, 5.6 `window.own.zoom`(rpcHash 입력 `own-api.ts` 바뀜), 6.2 `window.zoom` 행, 7.1 창 버튼 왼쪽의 배율 표시, 7.9 화면 크기 기억. **upstream v2.2.1 sync(2026-10-30)**: GUI 확장이 GUI 플러그인이 됐다(`packages/gui-plugins`, IPC `Plugin*`, 4.3·8.1). 셸은 서비스 플러그인의 `./gui-experimental` 번들을 평가하지 않는다(8.1.1). upstream이 렌더러에 오디오만 마이크를 직접 주므로 `windows/security.ts` 치환을 없앴다(7.8). upstream NSIS include를 더는 끌어오지 않는다(4.5). 브라우저 패인의 `shortcut` 이벤트는 창의 키 입력으로 되살린다(8.1). Electron 44.9.1은 내려받기 승인을 기다린다(2026-10-31 받음). **Electron 44.10.2(2026-11-10, EL)**: 보안 수정 때문에 upstream(44.9.1)보다 앞서는 기록된 예외(4.1, 4.7, 11.1) |
| 기준 소스 | fork base upstream v2 `00d179015f` (루트 `package.json` 2.0.18) |
| 경로 표기 | 특별한 말이 없으면 저장소 루트 `D:\own-open-code` 기준 `path:줄`. `[old]`는 이전 앱 `D:\#Projects\codex-multi-provider` 기준 |
| 사전 조사 | `[verdict]` = 데스크톱 타당성 결론(세션 scratchpad `desktop_verdict.md`, 21건 소스 스팟체크 포함), `[build]` = 빌드·패키징 실측 기록(`desktop_build.md`), `[gap]` = v2 기능 격차 목록(`gap_final.md`). PoC 산출물은 scratchpad `own-desktop-poc\`(설정 2개와 `src/main/*`, 실제 `packages/own-desktop`의 출발점) |
| 관련 문서 | `01-architecture.md`(프로세스·보안·원장), `02-accounts-providers-cache.md`(RPC 계약의 **기준**), `03-ui-ux.md`(화면·문구·프런트 성능), `04-ssh-remote.md`(SSH 원격), `own/FORK.md`(포크 운영) |
| 표기 | **⚠** = 소스나 실측으로 확인하지 못한 가정. 뒤에 확인할 게이트를 적는다 |

**이름 규칙(01 머리말·§20 35번과 같다).**
- `결정 D1`–`D8` = 2026-09-27 사용자 결정. 이 문서가 다루는 것은 결정 D1(데스크톱 앱), D2(네이티브 브라우저), D3(모바일 확장성), D4의 셸 부분(성능), D8의 셸 정렬(SSH)이다.
- `G-D1`–`G-D6` = 데스크톱 게이트. 표의 기준은 01 §16.2이고 `[verdict] §6`의 D1–D6과 같다. 이 문서는 게이트마다 시나리오를 더할 뿐 새 게이트를 만들지 않는다(14.1).
- `PF1`–`PF8` = 성능 게이트. 예산 수치와 릴리스 판정은 01 §6.6·§16.3이 기준이다. 이 문서는 셸에서 재는 방법만 정한다(9장, 14.2).
- `SC1`–`SC5` = 셸에만 있는 점검(첫 픽셀, 설치 크기, 스트리밍 IPC, 초기 요청 수, 메모리 회귀). `MG1`–`MG10` = 원격 접근(모바일) 게이트. 이 두 묶음은 이 문서가 정한다.
- 목표 번호는 `DG-1`…`DG-5`, `DM-1`이다. 게이트 번호(`G-D*`)와 겹치지 않게 했다.
- 단계 `DS0`–`DS3`(셸)과 `M0`–`M3`(모바일)는 01 §17의 P2–P8과 후속 안의 하위 이정표다(15장). "Phase N" 표기는 쓰지 않는다.

**문서 간 우선순위.**
- 스키마·RPC 계약·저장 위치·범위표(`MethodScope`)는 02, 프로세스·보안·포크 경계·성능 예산 수치와 게이트·로드맵은 01, SSH는 04가 기준이다.
- 화면·문구는 03이 기준이다. 특히 `OwnHost` 인터페이스 모양과 capability 이름(03 §16.7), 단축키(03 §10), UI 재사용(vendor) 계획(03 §18), 프런트엔드 구현 규칙(03 §20.2)은 03을 따른다.
- 매니페스트 키, 원장(`vendored.yaml`) 형식, 빌드 순서는 FORK §7·§8이 기준이다.
- 이 문서는 데스크톱 셸(`packages/own-desktop`)의 구성·수명주기·네이티브 기능, `OwnHost`의 데스크톱 구현과 셸 쪽 계약(`window.own`), 브라우저 패인 통합, 셸에서 재는 성능, 원격 기기(모바일) 접근 구조를 정한다. 다른 문서와 어긋나거나 그 문서에 추가가 필요한 곳은 17장에 모았다.

---

## 0. 결정 요약

1. **제품은 Codex 앱·Claude 앱 같은 데스크톱 앱이다.** 새 패키지 `packages/own-desktop`(Electron 44.10.2, 제품명 `Own OpenCode`, appId `dev.own.opencode.desktop`)이 주 클라이언트이고, 렌더러는 own-web이다. 일반 브라우저 창(`own open --browser`)은 폴백으로 남긴다(결정 D1).
2. **upstream `packages/desktop`의 main 프로세스를 그대로 재사용하고 upstream 파일은 고치지 않는다(코어 패치 0개).** own 쪽 코드는 약 450줄과 설정 파일 2개다([verdict] §1).
   - vendor(복사) 3개: `src/main/index.ts`(32줄), `src/main/desktop.ts`(46줄), `src/preload/index.ts`(29줄). preload vendor는 **필수**다. upstream 설정의 preload 입력이 상대 경로라 own-desktop 쪽 파일이 있어야 빌드되고(`packages/desktop/electron.vite.config.ts:104`), 렌더러의 rpcHash 재검사와 시작 시각 전달이 여기에 기댄다(5.5, 5.6).
   - 빌드 시 치환 2개: `src/main/constants.ts`(22줄), `src/main/lifecycle/environment.ts`(77줄). v2.0.24부터 GUI 확장 호스트의 내장 목록과 관리자도 치환했고, v2.2.1에는 GUI 플러그인 호스트의 내장 목록(`packages/gui-plugins/src/main.ts`), 켜짐 상태(`src/main/plugin/manager.ts`), 번들 평가(`src/main/plugin/module.ts`)를 치환한다(4.3, 8.1).
   - layer 교체 2개: `BackgroundService`, `DesktopCli`.
3. **빠뜨리면 사고가 나는 세 가지**([verdict] §1, [build] §4).
   - (a) `BackgroundService`를 교체하지 않으면 upstream `service.json`을 대상으로 `Service.ensure`를 불러 사용자의 upstream OpenCode 서비스를 멈출 수 있다(`packages/desktop/src/main/service/background-service.ts:40-50`, `packages/client/src/promise/service.ts:85-94,127-128`). → G-D1.
   - (b) `environment.ts`를 치환하지 않으면 패키지 빌드가 `HKCU\Software\Classes\opencode`를 가로챈다(`lifecycle/environment.ts:39-40`). PoC에서 실제로 일어났다. → G-D2.
   - (c) `constants.ts`를 치환하지 않으면 userData, 단일 인스턴스 락, AUMID가 설치된 "OpenCode Dev"와 겹친다(`constants.ts:21-22`, `lifecycle/configure.ts:22,30,40`).
4. **서비스를 띄우는 것은 여전히 launcher뿐이다(01 §5.3 유지).** 셸은 `service-own.json`을 discover해서 붙고, 서비스가 없을 때만 `own.ps1 start`에 위임한다. `Service.ensure`는 절대 부르지 않는다. 서비스는 detached라서 창을 모두 닫거나 셸을 종료해도 턴은 계속된다(→ G-D3).
5. **렌더러는 `%LOCALAPPDATA%\own-open-code\app\<version>\web\`에서 서빙한다.** 서비스와 같은 버전 포인터(`app\current.json`) 교체로 함께 바뀐다(2.0.18-own.3부터 junction 없음, 01 §5.5). vendor한 `index.ts`가 upstream보다 먼저 `oc://` 핸들러를 등록한다(first-wins, `windows/protocol.ts:38-39`). 셸과 렌더러의 IPC 계약은 `rpcHash`(매니페스트 키 `desktop.rpc_hash`, FORK §8.3)로 묶는다. 시작 때 어긋나면 main이 셸 번들의 폴백 페이지를 띄우고, 셸이 뜬 뒤 UI만 바뀌어 다시 로드되면 렌더러가 preload의 해시로 다시 검사한다(→ G-D6, 5.5).
6. **렌더러는 서비스 비밀번호를 모른다.** main이 렌더러 top frame이 로컬 서비스 origin으로 보내는 요청에만 Basic 헤더를 넣는다(`windows/security.ts:42-53`, `service/sidecar-credentials.ts:20-29`). 데스크톱 모드에는 쿠키도 pairing도 없다.
7. **own-web은 `OwnHost` 인터페이스 하나로 셸 차이를 흡수한다.** 인터페이스 모양과 capability 이름은 **03 §16.7이 기준**이다. 이 문서는 데스크톱 구현(어느 capability를 어느 IPC로 채우는지)과 셸 쪽 계약(`window.own`)만 정한다(6장). UI는 `kind`가 아니라 capability로 게이트한다.
8. **네이티브 브라우저는 upstream의 브라우저 호스트를 그대로 쓴다(결정 D2).** v2.0.24부터 그 호스트는 upstream `browser` GUI 확장(`packages/gui-plugins/src/browser/*`, f406d93a66)이고 desktop main의 확장 호스트(`src/main/extension/*`)가 돌린다. WebContentsView, 탭별 CDP, 서버 터널 프록시가 그 안에 있고, 서버 쪽 `@opencode/plugin-browser`는 CLI에 내장돼 있다(`packages/core/src/plugin/internal.ts`). 셸이 시작하는 GUI 확장은 이것 하나뿐이고 설치형 확장은 어느 빌드에서도 받지 않는다(8.1). own-web의 패인 UI(03 §18.17)는 그대로이고, desktop host가 확장의 `browser.pane` Ipc에 맞춘다(6.2, 8.2). 연결은 `attach` version 4다(`gui-plugins/src/browser/pane.ts:284`). → G-D5.
9. **도구 목록 안정성(prompt cache)은 미결이다. P5 시작 전에 하나로 정해야 한다(17.1).** 01 §0-12·§10.1과 02 D10은 **설치 프로필**(웹 전용 설치는 처음부터 끔)을, 03 §18.15와 이 문서는 **세션 생성 때 권한 새김**(안 D)을 제안한다. 로컬 소스로 보면 두 안 모두 요청의 도구 정의(`definitions`에는 Code Mode 도구 대신 `execute` 하나만 들어감)를 바꾸지 않고, 카탈로그가 바뀌면 기존 세션 뒤에 **전체 카탈로그 교체 문구 하나가 덧붙을 뿐** 앞 prefix는 유지된다(8.7). 이 문서는 안 D를 권고하지만, 결정 전에는 어느 쪽도 구현하지 않는다.
10. **성능이 먼저다(결정 D4, 셸 부분).** 예산과 릴리스 게이트는 01 §6.6·§16.3의 PF1–PF8이다. 셸은 upstream의 빠른 시작 구조(첫 창을 main 번들보다 먼저, V8 code cache와 compile cache, 브라우저 호스트 지연 로드)를 그대로 두고, 우리가 더하는 코드는 첫 창 뒤로 미룬다. own-web의 초기 그래프는 한두 chunk로 묶는다(R-D12, 각 파일이 main 스레드 프로토콜 핸들러를 한 번씩 거치기 때문). 스트리밍은 Electron IPC를 거치지 않는다(렌더러 ↔ 서비스 직접). 셸 전용 점검은 SC1–SC5다(9장).
11. **패키징.** NSIS per-user oneClick, 서명 없음, 업데이터 없음(v2.0.24부터 업데이터는 upstream GUI 확장이고 셸의 확장 목록에 없다, 8.1. `publish:null`), 프로토콜 등록 없음. CLI를 번들하지 않고 launcher의 `app\<version>\opencode.exe`를 쓴다. 산출물 이름은 FORK §8.3의 `own-desktop-<ver>-win-x64.exe`, 출력 위치는 `own/.out` 아래다. 설치 파일은 약 130–150 MB로 추정한다(PoC는 CLI 포함 199.4 MB 실측, [build] §2).
12. **SSH는 04 설계 그대로다(결정 D8).** SSH는 로컬 서비스 안의 own-remote가 돌린다. upstream의 SSH·WSL은 v2.0.24부터 GUI 확장이고 셸의 확장 목록에 넣지 않으므로 셸 번들에 그 코드가 없다(8.1). 원격 세션의 브라우저 패인은 원격 서버의 plugin-browser에 붙으므로 트래픽이 원격 호스트에서 나간다(⚠ G-D5 확장).
13. **모바일은 나중 범위다(결정 D3).** 지금 넣는 것은 이음매뿐이다: 백엔드 우선 규칙(계정·전환·캐시·한도·SSH 세션 로직은 서비스/RPC에), capability 플래그, 반응형·터치 대응 UI, 알림 항목 형식(`FeedItem`, 03 §21.3).
14. **원격 접근은 서비스 안의 게이트웨이 + Tailscale serve를 권장한다.** 게이트웨이 리스너 코드는 own-runtime의 프로세스 수명 런타임(01 §6.4, 04 §4.1)에서 돌고, 관리 RPC(`gateway.*`, `devices.*`, `feed.*`, `push.*`)는 own-remote가 `own.remote`로 등록한다. 게이트웨이를 켠 동안 런타임은 스스로를 고정(pin)하고, launcher가 서비스를 띄운 뒤 control location을 깨운다. Location 수명과 런타임 수명의 관계는 아직 실측하지 않았다(⚠ 13.4, MG9·MG10). 기기 토큰을 검증하고 범위를 강제한 뒤 로컬 서비스와 원격(SSH) 서버로 프록시한다. 외부 노출은 `tailscale serve`(tailnet 한정 HTTPS)로만 한다. LAN 평문 노출과 공개 인터넷 노출(Funnel 등)은 금지다.
15. **기기 토큰.** upstream pairing의 1회용 5분 코드, `/auth/connect/<code>` 링크, QR 표시·스캔 코드를 재사용한다. 하지만 기기에 주는 토큰은 upstream의 30일 무상태 전권 토큰이 아니라 **기기별·범위별·즉시 폐기 가능**한 토큰이고, 해시만 저장한다. `own.accounts` 범위는 02 §9.1의 `OwnAccounts.MethodScope`에 그대로 대응시키고, `local` 메서드는 어떤 기기에도 주지 않는다(13.5).
16. **푸시는 서비스 쪽 알림 피드 위에 얹는다.** 피드는 내구 저장·기기별 커서를 가지고, 항목 형식은 03 §21.3의 `FeedItem`이다. PWA는 Web Push(VAPID, 페이로드 암호화)를 먼저 쓰고, 네이티브 앱의 FCM/APNs 중계는 그 다음이다. 알림에서 할 수 있는 동작은 "열기"뿐이다. 권한 승인이나 프롬프트 전송은 앱 안에서만 한다([old] `docs/design/workspace-notifications-40.md`).

---

## 1. 목표와 비목표

### 1.1 목표
- **DG-1** 설치형 Windows 데스크톱 앱. 실행하면 1초 안에 세션 목록이 보이고(캐시, PF1), 서비스가 없으면 launcher로 띄운 뒤 붙는다.
- **DG-2** 폴더 선택, 실제 경로 드래그, 클립보드 이미지, 에디터·탐색기로 열기, OS 알림, 창 테두리(WCO) 같은 네이티브 기능을 upstream main에서 공짜로 얻는다.
- **DG-3** 에이전트가 쓰는 앱 안 브라우저(탭, 스냅샷, 클릭, 네트워크·콘솔 관찰, 스크린숏)를 데스크톱에서 제공한다(결정 D2, [gap] #33을 must로 올림).
- **DG-4** upstream 설치본(OpenCode, OpenCode Dev)과 나란히 설치해도 서비스·레지스트리·userData가 서로 건드리지 않는다.
- **DG-5** upstream 동기화 비용을 낮게 유지한다. upstream 파일 수정 0, vendor·치환·deep import 목록은 원장과 check-surface로 감시한다.
- **DM-1** 나중에 휴대폰에서 PC의 세션(로컬과 SSH 원격 모두)을 보고 이어서 조작할 수 있게, 지금 구조가 그것을 막지 않는다.

### 1.2 비목표
- macOS·Linux 데스크톱 빌드. upstream 코드는 지원하지만 우리는 Windows만 빌드하고 시험한다.
- 셸 자동 업데이트, 딥 링크(`opencode://`, `own://`), 네이티브 메뉴, 데스크톱 SSH·WSL UI([gap] #43의 "데스크톱 네이티브 메뉴·자동 업데이트·딥 링크"는 계속 제외).
- upstream `packages/app` 렌더러를 데스크톱에서 쓰는 것. 셸은 own-web만 띄운다.
- 서비스를 셸이 직접 띄우거나 감독하는 것(01 §5.3).
- 모바일 앱 자체(PWA, Capacitor 래퍼). 이 문서는 구조와 계약만 정한다(13장).
- 서비스나 게이트웨이를 LAN에 평문으로 여는 것, 공개 인터넷에 여는 것.

---

## 2. 용어

| 용어 | 정의 |
|---|---|
| **셸(own-desktop)** | `packages/own-desktop`이 만드는 Electron 앱. main 프로세스(upstream 재사용), preload, 렌더러 창으로 이루어진다 |
| **main** | Electron 메인 프로세스. 창, IPC, 파일 대화상자, 알림 권한, 브라우저 호스트를 맡는다. 계정·세션 로직은 두지 않는다 |
| **렌더러** | `oc://renderer/index.html`에서 도는 own-web. 스킴과 호스트는 upstream 그대로다(`windows/scheme.ts:4-5`) |
| **폴백 페이지** | 셸 번들에 들어 있는 최소 페이지(`out/renderer`). `app\<version>\web`이 없거나 `rpcHash`가 어긋날 때만 뜬다 |
| **OwnHost** | own-web 안의 호스트 추상화. `web`/`desktop`/`mobile` 구현이 있고 `has(capability)`로 기능을 알린다. 모양은 03 §16.7, 데스크톱 구현은 6장 |
| **capability** | 호스트가 제공하는 네이티브 기능 하나(예: `browser.pane`, `fs.pickDirectory`). 이름은 03 §16.7의 `Capability` 목록이다. UI는 이것으로만 게이트한다 |
| **T0 호출** | 렌더러가 시작 직후 반드시 해야 하는 셸 호출(6.3) |
| **WCO** | Window Controls Overlay. 테두리 없는 창의 오른쪽 위에 OS가 그리는 최소화·최대화·닫기 버튼 영역 |
| **AUMID** | Windows AppUserModelID. toast 알림과 작업 표시줄 묶음의 앱 식별자. 우리 값은 appId와 같다 |
| **브라우저 호스트** | main이 세션마다 만드는 WebContentsView 탭 묶음과 CDP 드라이버. v2.0.24부터 upstream `browser` GUI 확장의 main 쪽(`packages/gui-plugins/src/browser/{main,pane,chromium}.ts`)이다 |
| **GUI 확장 호스트** | (v2.0.24, f406d93a66) desktop main의 `src/main/extension/*`. 내장 GUI 확장의 main 쪽을 돌리고 창에 Ipc(`PluginCall`·`PluginEvent`), embed(`PluginEmbed`·`PluginCapture`), 서버 목록(`PluginConfigure`)을 내준다. 셸은 내장 목록을 브라우저 하나로 바꾸고 설치형 확장을 막는다(8.1) |
| **attachment** | 브라우저 호스트와 서버 plugin-browser 사이의 연결 하나. `{sessionID, connectionID}`로 식별하고 `attach` version 4로 연다 |
| **rpcHash** | 셸 IPC 계약 파일들의 해시. 셸 빌드, own-web 빌드, `manifest.json`의 `desktop.rpc_hash`에 같은 값을 새겨 셸 ↔ 렌더러 스큐를 잡는다(5.5) |
| **게이트웨이** | (M1+) 서비스 프로세스 안, own-runtime 프로세스 수명 런타임에서 도는 loopback 리스너. 기기 인증, 범위 강제, 프록시, own-web 정적 서빙을 한다(13.4) |
| **기기(device)** | 페어링한 원격 클라이언트 하나(휴대폰 PWA, 태블릿, 다른 PC의 브라우저). id `dev_<ulid>` |
| **기기 토큰** | 게이트웨이가 기기에 준 256비트 난수 토큰. 서비스는 sha256 해시만 저장한다 |
| **범위(scope)** | 기기 토큰이 할 수 있는 일의 묶음(`read`, `prompt`, `switch`, `files`, `terminal`, `admin`). `own.accounts` 쪽은 02 `MethodScope`의 `read`/`drive`/`manage`에 대응하고 `local`은 줄 수 없다(13.5) |
| **알림 피드** | (M1) 서비스가 쌓는 내구 알림 목록. 항목은 03 §21.3의 `FeedItem`이다. 기기별 커서로 읽고, 푸시는 이 피드를 전달하는 수단일 뿐이다(13.6) |
| **tailnet** | Tailscale이 만드는 WireGuard 사설망. `tailscale serve`는 tailnet 안에만 HTTPS로 노출한다 |

---

## 3. 구성도

```text
Windows 11 사용자 세션 (단일 사용자)
│
├─ Own OpenCode (own-desktop, Electron 44.10.2)       설치: %LOCALAPPDATA%\Programs\own-desktop
│   ├─ main  = upstream packages/desktop/src/main 재사용 + own 치환 2개 + layer 교체 2개
│   │    창·WCO · IPC(Effect RPC over MessagePort) · 파일 대화상자 · 알림 권한 · 브라우저 호스트
│   │    BackgroundService(own): service-own.json discover → 없으면 powershell own.ps1 start (ensure 금지)
│   │    Basic 주입: 렌더러 top frame → 로컬 서비스 origin만
│   ├─ preload(vendor, 필수): window.electron {windowID, bootstrap, storageSnapshot, getPathForFile}
│   │                         + window.own {shell{rpcHash, version, startedAt, controlDir}, service{status, restart}}
│   ├─ 렌더러 oc://renderer/index.html  ← %LOCALAPPDATA%\own-open-code\app\<version>\web\ (own-web)
│   │    OwnHost(desktop) ─ REST/SSE ─▶ http://127.0.0.1:28538  (Authorization 없이 보냄, main이 넣음)
│   │                     ─ REST/SSE ─▶ http://127.0.<k>.2:<LP>  (SSH 원격, own-web이 토큰 헤더, 04 §12.1)
│   └─ 브라우저 패인 탭: WebContentsView · partition opencode-browser-<uuid>(메모리) · 프록시 = 서버 터널
│
├─ [폴백] msedge --app=http://127.0.0.1:28538/   own-web(P-001/P-002 임베드) + pairing 쿠키 (01 §6)
│
├─ opencode.exe service (own 채널, 127.0.0.1:28538)   ← launcher만 기동 (01 §5.3)
│   ├─ core · 내장 plugin-browser(opencode.browser): browser.* 도구 · attach v4 · 터널
│   ├─ own.accounts · own.remote · [own.team] · [claude-auth] · own.telemetry · own.computer-use   (04 §4.1 순서)
│   └─ [M1+] 게이트웨이 리스너 127.0.0.1:<G>  (own-runtime 프로세스 수명 런타임, 켠 동안 pin. RPC는 own.remote)
│            기기 토큰 검증 · 범위 강제 · /srv/<serverKey>/… 프록시 · own-web 정적 서빙 · 알림 피드
│
├─ [M1+] tailscaled ─ tailscale serve: https://<pc>.<tailnet>.ts.net ─▶ http://127.0.0.1:<G>
│            ▲ WireGuard (tailnet 안에서만)
│            └─ 휴대폰 PWA / 앱 (같은 own-web, OwnHost(mobile))
│
├─ own.cmd / own.ps1 (launcher): env 브리지 → env 정리 → service start → (M1+, 게이트웨이 켬) control location 깨우기
│                                → (own open) 데스크톱 실행
└─ ssh.exe 터널 (04, own-remote) ─▶ Linux 원격 service
```

- 포트 28538은 own 채널 기본값이다(`own/launcher/own.ps1` 머리말, `service-config.ts:34-38`의 규칙).
- 게이트웨이, tailscaled, 기기는 M1 이후에만 생긴다. MVP의 네트워크 표면은 01 §13 그대로 loopback뿐이다.

### 3.1 컴포넌트 책임

| 컴포넌트 | 책임 | 하지 않는 것 |
|---|---|---|
| own-desktop main | 창 수명주기, WCO, IPC, 네이티브 대화상자, OS 알림 권한, 브라우저 호스트, 서비스 discover·launcher 위임, 로컬 서비스 요청의 Basic 주입, 서비스 재시작 요청(launcher 실행), 앱 메뉴 비우기(7.7), 창 닫기 확인(7.2) | 서비스 기동·감독(`ensure`), 계정·전환·한도 로직, SSH, 비밀 보관, 스트리밍 중계, env 정리(launcher가 함) |
| preload(vendor, 필수) | `window.electron`(upstream 그대로), `window.own`(셸 상수와 서비스 제어 2개) | Node API 노출, 동기 IPC |
| 렌더러(own-web) | UI 전부, OwnHost, T0 호출, rpcHash 재검사, 패인 UI, 알림 규칙과 클릭 라우팅 | 비밀 보관, 셸 기능을 capability 없이 가정, 콘솔에 토큰 출력(셸이 콘솔을 로그 파일로 복사함, 6.4) |
| 서비스 + own 플러그인 | 세션·도구·PTY, 계정·전환·캐시·한도(own-accounts), SSH(own-remote), 브라우저 도구와 터널(plugin-browser), (M1+) 게이트웨이·기기·알림 피드(own-runtime 리스너 + `own.remote` RPC) | UI |
| launcher | 서비스 기동과 env 정리, `own open`으로 데스크톱 실행, 재시작(`--claude-config-dir` 포함, 5.7), (M1+) 서비스 기동 뒤 control location 깨우기 | 상주, 감독 |

### 3.2 어디서 무엇이 도는가 (백엔드 우선 규칙)

**규칙.** 기기와 무관한 로직은 전부 서비스(플러그인 RPC)에 둔다. 셸은 **그 기기에 묶인 기능**(창, OS 대화상자, 로컬 프로세스 제어, WebContentsView)만 한다. 이 규칙이 모바일 확장의 전제다(결정 D3). 셸 main에 비즈니스 로직이 들어가면 모바일에서 다시 만들어야 한다.

| 기능 | 서비스(백엔드) | 셸 main | 렌더러 |
|---|---|---|---|
| 계정·전환·캐시·한도·비용 추정 | own-accounts (02) | – | 표시·확인 대화상자 |
| 세션 실행, 도구, PTY | core | – | 표시 |
| SSH 원격 호스트 | own-remote (04) | 없음(upstream Ssh 비활성, 12장) | 멀티 서버 UI |
| 브라우저 도구 | plugin-browser: 도구 정의·권한·요청 큐·터널 | 탭·CDP·레이아웃 | 패인 UI |
| 폴더 고르기 | `fs.list`(모든 모드) | 네이티브 대화상자(로컬 서버만) | 선택기 |
| 알림 | (M1) 알림 피드, (M2) 푸시 | OS toast 표시 권한 | 규칙·클릭 라우팅 |
| 실행 중 시스템 절전 방지 | (권장) own-runtime이 턴 동안 보류(7.6, ⚠ 설계만) | 사용자 토글(upstream `prevent-display-sleep`) | 설정 |
| 서비스 재시작 | – (자기 자신을 다시 띄울 수 없음) | `powershell … own.ps1 restart [--force] [--claude-config-dir <dir>]` 실행 | 실행 중 세션 확인 대화상자 |
| 기기 페어링·폐기 | (M1) own-remote `devices.*` | – | QR 표시 |

---

## 4. own-desktop 패키지

### 4.1 레이아웃

```text
packages/own-desktop/                    name "own-desktop" (설치 폴더 이름이 됨), private
  package.json                           productName "Own OpenCode", main ./out/main/index.js, type module
  electron.vite.config.ts                upstream 설정 함수 호출 + 치환 플러그인 + 렌더러 교체 (4.4)
  electron-builder.config.ts             upstream 기본값 spread + 덮어쓰기 (4.5)
  resources/icons/*                      own 아이콘 (upstream copy-icons.ts 형식)
  src/main/
    index.ts                             vendor(upstream src/main/index.ts) + own-env, 렌더러 선등록, 앱 메뉴 비우기, probe 제거
    own-env.ts                           Electron이 env를 바꾸기 전의 process.env 스냅샷과 시작 시각 (5.2)
    desktop.ts                           vendor(upstream src/main/desktop.ts) + layer 교체 2개 + own IPC 등록 + 창 닫기 확인(7.2)
    service/background-service-own.ts    BackgroundService.Service 구현 (5.3)
    service/desktop-cli-own.ts           DesktopCli.Service 구현 (5.4)
    service/launcher.ts                  own.ps1 실행(start/restart), 종료 코드 해석 (5.3, 5.6)
    own-ipc.ts                           own:shell.info, own:service.* 핸들러 (5.6)
  src/overrides/constants.ts             치환: upstream src/main/constants.ts (4.3). 경로는 FORK §7 예시와 같다
  src/overrides/environment.ts           치환: upstream src/main/lifecycle/environment.ts (4.3)
  src/overrides/gui-plugins.ts           치환: upstream packages/gui-plugins/src/main.ts, 내장 GUI 플러그인 = 브라우저 하나 (4.3, 8.1)
  src/overrides/plugin-manager.ts        치환: upstream src/main/plugin/manager.ts, 내장만 켜짐 (4.3, 8.1)
  src/overrides/plugin-module.ts         치환: upstream src/main/plugin/module.ts, 서비스 플러그인의 GUI 번들을 평가하지 않음 (4.3, 8.1)
  src/main/own-browser.ts                브라우저 패인 다운로드의 사용자 쪽(8.4)과 창 닫기 확인(7.2)
  src/preload/index.ts                   vendor(upstream src/preload/index.ts, 필수) + window.own
  src/preload/own-api.ts                 window.own의 타입 계약. rpcHash 입력에 들어간다 (5.5)
  src/fallback/index.html                폴백 페이지 (5.5)
  test/                                  치환 검사, G-D1·G-D2·G-D6 자동 시험
```

- 런타임 `dependencies`는 upstream과 같다: `@zip.js/zip.js`, `electron-context-menu`, `electron-log`, `electron-updater`(v2.0.24부터 셸 번들의 어떤 코드도 import하지 않음, 8.1), `lighthouse`(브라우저 확장의 진단, 10.3) (`packages/desktop/package.json:27-33`).
- `devDependencies`는 upstream 판에 고정한다: `electron-vite 6.0.0-beta.1`, `electron-builder 26.15.7`, `app-builder-lib 26.15.7`, `vite 8.2.4`. `electron`만 기록된 예외로 `44.10.2`다(upstream은 `44.9.1`, 2026-11-10, 결정 EL-1). Chromium·V8·PDFium 보안 수정과 Node 24.22.2를 브라우저 패인(8)에 먼저 들이려고 앞서 쓰고, upstream이 44.10.2 이상을 고정하면 upstream 판으로 돌아간다(그때 `test/shell.test.ts`의 예외가 실패한다). 그리고 `@opencode/desktop`·`@own/web` `workspace:*`, node-pty optional 6개(`package.json:34-71`).
- 루트 `workspaces`가 `packages/*`를 자동으로 잡으므로 루트 `package.json`은 고치지 않는다(01 §4). `bun.lock`은 바뀐다(원장 예외, 01 §12.2).

### 4.2 upstream 재사용 방식

모든 upstream 경로는 `packages/desktop/` 기준이다. `@opencode/desktop`은 exports 맵이 없고 `main`만 있으므로(`package.json:26`) 소스 경로로 deep import할 수 있다. 안정된 API는 아니므로 check-surface로 감시한다(4.7).

| upstream 모듈 | 방식 | 이유·근거 |
|---|---|---|
| `src/main/windows/*`, `ipc.ts`, `ipc-handlers/*`, `files/*`, `storage/*`, `native/*`, `plugin/*`(v2.0.24에 `extension/*`, v2.1에 이름이 바뀜. `manager.ts`·`module.ts` 제외), `lifecycle/{configure,index,shutdown,onboarding,desktop-initialization,marks}.ts`, `service/{sidecar-credentials,background-service-state,shell-env}.ts`, `paths.ts` | **import(그대로)** | import할 때 부작용이 있는 파일은 `index.ts:15`와 `desktop.ts:36`뿐이다([verdict] §2). v2.0.24 전의 `browser-pane.ts`, `browser-chromium.ts`, `browser/*`, `updater/*`, `ssh/*`, `wsl/*`는 GUI 확장으로 옮겨져 없다 |
| `packages/gui-plugins/src/browser/{index,main}.ts`, `packages/plugin/src/gui/{host,main,builtin}.ts` | **import(상대 경로)** | 셸의 내장 목록(`src/overrides/gui-plugins.ts`)이 브라우저 플러그인의 정의와 main 진입을 가져온다. 패키지 exports에 `./browser`가 없어서 상대 경로다. 나머지 브라우저 모듈(`pane.ts`, `chromium.ts`, `network.ts`, `files.ts`, …)은 main 진입이 지연 로드한다(8.1) |
| `packages/gui-plugins/src/main.ts` | **치환** | 내장 GUI 플러그인 목록. 브라우저 하나만 둔다(4.3, 8.1) |
| `src/main/plugin/manager.ts` | **치환** | 내장만 켠다. 켜고 끄기를 어느 빌드에서도 저장하지 않는다(4.3, 8.1) |
| `src/main/plugin/module.ts` | **치환** | 서비스 플러그인의 `./gui-experimental` 번들을 main에서 평가하지 않는다(4.3, 8.1) |
| `src/main/index.ts` | **vendor** | 추가: `own-env` 스냅샷, 렌더러 프로토콜 선등록(5.5), Windows 앱 메뉴 비우기(7.7). 제거: `startSidecarProbe()`(`index.ts:25`). 나머지 순서(설정 → 락 → 스킴 → ready → 첫 창 → 자산 대기 → `import("./desktop")`, `index.ts:15-31`)는 그대로 둔다 |
| `src/main/desktop.ts` | **vendor** | `BackgroundService.layer`, `DesktopCli.layer`를 own 구현으로 바꾼다(`desktop.ts:38-39`). own IPC(5.6)와 창 닫기 확인(`will-prevent-unload`, 7.2)을 여기서 등록한다 |
| `src/main/constants.ts` | **치환** | own 이름·id, `CHANNEL=prod`(4.3) |
| `src/main/lifecycle/environment.ts` | **치환** | 프로토콜 등록 안 함, `XDG_STATE_HOME` 유지, env 플래그 주입 안 함(4.3) |
| `src/main/service/background-service.ts` | **layer 교체** | attach 우선, 없으면 launcher 위임(5.3) |
| `src/main/service/desktop-cli.ts` | **layer 교체** | 197 MB CLI 복사(`desktop-cli.ts:152-171`)를 없애고 `app\<version>\opencode.exe`를 가리킨다(5.4) |
| `src/main/service/sidecar-probe.ts` | 사용 안 함 | 소비자가 `index.ts:25`, `background-service.ts:53` 둘뿐이고 둘 다 우리 쪽에서 빠진다([verdict] §0 #16) |
| `packages/gui-extensions/src/{ssh,wsl,updater,pairing}/*` | 사용 안 함 | v2.0.24 전에는 `src/main/{ssh,wsl}/*`가 `Ipc.layer`에 고정돼 비활성으로 실렸다. 지금은 GUI 확장이고 셸의 내장 목록에 없으므로 번들에도 없다(8.1) |
| `src/main/lifecycle/onboarding.ts` | import, 호출 금지 | `finishFirstLaunchOnboarding(true)`를 부르면 `Documents\<기본 프로젝트>`를 만든다(`onboarding.ts:45`, [build] §2 run 1) |
| `src/preload/index.ts` | **vendor(필수)** | 이유 셋. (1) upstream 설정의 preload 입력이 상대 경로 `src/preload/index.ts`라(`electron.vite.config.ts:104`) own-desktop에서 빌드하면 own 쪽 파일을 찾는다. vendor하지 않으면 `base.preload`가 없는 파일을 가리킨다. (2) 렌더러의 rpcHash 재검사(5.5), (3) 03 §20.1 B1의 셸 시작 시각(`own:shell-start`), (4) 02 §9.1이 요구하는 `controlDir`이 `window.own.shell`에 기댄다. 약 47줄(5.6) |
| `src/renderer/ipc-client.ts`, `src/shared/ipc-transport.ts` | own-web desktop host가 deep import | 셸과 같은 커밋의 계약 코드를 쓴다(6.6). `renderer/api.ts`는 타입이 `@opencode/app` 전체를 끌어와 쓰지 않는다 |
| `src/renderer/window/zoom.ts` | 사용 안 함 | import하면 전역 처리기를 거는 모듈이다. 줌 키는 own-web이 직접 처리하고(03 §4.2.1) 배율은 셸이 이 PC에 하나로 저장한다(7.9) |
| `src/renderer/platform/*`, `desktop-app.tsx`, `index.tsx` 등 upstream 렌더러 | 사용 안 함 | `@opencode/app` 전체를 끌고 온다 |
| `electron.vite.config.ts` | 함수 import + 덮어쓰기 | 4.4 |
| `electron-builder.config.ts` | 기본 export spread + 덮어쓰기 | 4.5 |

### 4.3 빌드 시 치환

- **방식.** electron-vite의 main 빌드에 `enforce:"pre"` `resolveId` 플러그인을 넣고, **해석된 절대 경로**가 치환 대상이면 own 파일로 바꾼다(PoC `own-desktop-poc\electron.vite.config.ts`). import 문자열이 아니라 해석 결과를 비교하므로 상대 import 모양이 바뀌어도 잡힌다.
- **drift 검사.** 치환 표의 키가 빌드 중 한 번도 매칭되지 않으면 `buildEnd`에서 빌드를 실패시킨다. upstream이 파일 이름을 바꾸면 조용히 upstream 원본이 들어가는 것을 막기 위해서다([verdict] §8 위험 3).
- **export 호환.** 치환 파일은 upstream 파일의 export 이름과 타입을 모두 유지한다. typecheck(`bun check --no-script -b`, v2.2.1부터. 그 전 `tsgo -b`)가 upstream 소비자 쪽에서 이것을 확인한다.

**`src/overrides/constants.ts`** (upstream `constants.ts`와 같은 export. upstream이 f406d93a66에서 `UPDATER_ENABLED`를 지웠으므로 4개)

```ts
import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"
// upstream은 mac 메뉴(native/menu.ts)와 GUI 확장의 build 정보(extension/host.ts)에서 CHANNEL을 본다.
export const CHANNEL: Channel = "prod"
export const VERSION = app.getVersion()
export const APP_NAME = app.isPackaged ? "Own OpenCode" : "Own OpenCode Local"
export const APP_ID = app.isPackaged ? "dev.own.opencode.desktop" : "dev.own.opencode.desktop.local"
```

- 비패키지(dev) 빌드도 upstream "OpenCode Dev"(`ai.opencode.desktop.dev`, `constants.ts:22`)와 겹치지 않는 id를 쓴다. 설치된 own-desktop과도 락·userData가 나뉜다.

**`src/overrides/environment.ts`** (upstream `environment.ts`의 export 6개를 같은 이름으로)

| export | upstream 동작 | own 동작 |
|---|---|---|
| `installContextMenu` | `electron-context-menu` 지연 로드(`:12-15`) | 같음 |
| `prepareApplicationEnvironment` | 시스템 인증서, 프록시 env(`:17-20`) | 같음 |
| `preferApplicationEnvironment` | Windows에서 `XDG_STATE_HOME` 삭제, `OPENCODE_CLIENT=desktop`·실험 플래그 2개 주입(`:22-34`) | **아무것도 하지 않는다.** `XDG_STATE_HOME`은 launcher가 따르는 값이라(`own.ps1` `Get-OwnPaths`) 지우면 discover 경로가 launcher와 달라진다. 서비스 env는 launcher가 정하므로 main env에 플래그를 넣을 이유가 없다 |
| `prepareDesktop` | 패키지 빌드면 항상 `setAsDefaultProtocolClient("opencode")`(`:39-40`), 렌더러 등록(`:45`), 아이콘 | **프로토콜 등록을 하지 않는다.** 렌더러 등록 호출은 남기지만 이미 우리가 먼저 등록했으므로 no-op이다(first-wins, `protocol.ts:39`) |
| `loadProxyEnvironment` | loopback NO_PROXY 보강(`:49-77`) | 같음 |

- `electron-builder`의 `protocols: []`만으로는 런타임 등록을 막지 못한다([build] §4 위험 2). 치환이 유일한 방어이고 G-D2가 확인한다.

**`src/overrides/gui-plugins.ts`, `src/overrides/plugin-manager.ts`, `src/overrides/plugin-module.ts`** (v2.0.24, v2.2.1에 GUI 플러그인으로, 8.1)

| 치환 대상 | upstream 동작 | own 동작 |
|---|---|---|
| `packages/gui-plugins/src/main.ts` `builtins` | 내장 GUI 플러그인 15개(context, btw, debug, terminal, file, review, details, browser, pairing, updater, ssh, wsl, microsoft-office, sources, goal)를 `compose`. main 진입이 있는 것은 debug, browser, pairing, updater, ssh, wsl. 업데이터는 패키지 빌드면 켜진다(`updater/main.ts` `enabled = build.packaged`) | `compose({browser: {...browser, mainEntry}})` 하나. 업데이터·SSH·WSL·pairing 코드는 번들에 들어가지 않는다 |
| `src/main/plugin/manager.ts` `createManager` | 켜고 끄기를 desktop DB에 둔다. 내장은 늘 켜지고, 그 밖의 플러그인은 저장된 행이 없으면 켜진다 | 같은 멤버. 내장만 켜지고, `setEnabled`는 내장이면 `builtin`, 그 밖이면 `unavailable`로 거부한다(행을 쓰지 않음) |
| `src/main/plugin/module.ts` `evaluateMain` | 앱 자체 서버의 플러그인 중 `./gui-experimental` 번들을 내는 것을 나열해 **켜졌는지와 관계없이** main에서 평가한다(`require`로 `electron`·Node 내장 모듈에 닿음, `plugin/host.ts` `readPlugin`) | 아무것도 평가하지 않는다. 번들 코드가 돌기 전에 `PluginError("unavailable")`로 실패하고, 호스트는 그 플러그인을 실패로만 나열한다 |

- 세 키도 `buildEnd` 검사를 받는다. upstream이 파일을 옮기면 빌드가 멈춘다. `plugin/host.ts`가 세 모듈을 쓰는 자리는 surface `desktop-extension-host-builtins`가 본다.
- 시험: `packages/own-desktop/test/overrides.test.ts`(export 이름, 목록이 `["browser"]`, 관리자 거부, 번들을 평가하지 않음, upstream이 번들을 켜짐과 관계없이 평가함), `test/shell.test.ts`의 빌드 산출물 검사(`browser.pane`은 있고 `electron-updater`·`quitAndInstall`·SSH·WSL·pairing 문자열은 없음).

**`src/overrides/security.ts`** (VOICE, 2026-10-09, 7.8. v2.2.1에 없앰)

- v2.2부터 upstream `src/main/windows/security.ts`가 렌더러 창의 main frame에 **요청한 매체가 모두 `audio`인 `media`**를 직접 허락한다(요청 처리기 `details.mediaTypes`, 확인 처리기 `details.mediaType`, 렌더러 URL·같은 창 조건). own 치환본이 하던 일과 같고 main frame 조건이 더 있으므로 치환을 없앴다. 카메라·화면 캡처·`unknown`은 여전히 거부된다.
- 시험: `test/overrides.test.ts`가 upstream의 오디오만 허락과 치환 목록에 `security.ts`가 없음을 본다. upstream이 이 허락을 없애거나 넓히면 surface `desktop-renderer-permissions-substitute`가 알리고, 그때 치환을 되살린다. 원격 PC 창의 마이크(`remote-pcs/partition.ts`, `src/main/media-permission.ts`)는 그대로다.

**`src/overrides/ipc-files.ts`** (폴더 열기, 2026-10-10, 03 §18.3)

| 치환 대상 | upstream 동작 | own 동작 |
|---|---|---|
| `src/main/ipc-handlers/files.ts` `FilesOpenDirectoryPicker` | `DesktopFiles.openDirectoryPicker(options)`. `dialog.showOpenDialog`에 창을 주지 않으므로 폴더 선택 창에 소유 창이 없다. 창이 뜨는 동안(Windows에서 약 2.5초)과 뜬 뒤에도 앱 창이 클릭·Ctrl+O를 받아 창이 여러 개 열리고, 앱 창을 누르면 선택 창이 그 뒤로 숨는다 | 요청한 렌더러의 창(`BrowserWindow.fromWebContents`)을 소유 창으로 넘겨 **모달**로 연다(Windows가 소유 창을 막고 선택 창을 위에 둔다). 창마다 하나: 그 창의 선택 창이 열려 있거나 뜨는 중이면 새로 열지 않고 같은 답을 돌려준다. 제목·옵션·결과는 upstream `openDirectoryPicker`와 같다 |
| 같은 파일의 나머지 `Files*` 처리기 | | upstream 글 그대로(복사). upstream 모듈은 패키지 경로로 import |

- 코어 패치가 아니다(FORK §7 `substitute`, `vendored.yaml`). `main/ipc.ts`가 `./ipc-handlers/files`를 import하는 자리에서 바뀐다. upstream이 처리기를 바꾸면 surface `desktop-folder-dialog-owner`와 vendored drift가 알린다. upstream이 소유 창을 넘기게 되면 이 치환은 지운다.
- 렌더러 쪽 한 번만 열기(창마다 흐름 하나, 누른 순간부터 `여는 중…`)는 own-web `src/projects/opener.ts`가 맡는다. 이 치환은 그 밖의 호출(Claude 슬롯의 폴더 고르기 등)과 OS 수준의 모달을 맡는다.
- 시험: `test/overrides.test.ts`(export 이름, upstream은 여전히 소유 창 없이 엶, 치환본이 소유 창과 창별 대기 목록을 씀).

**`src/overrides/appearance.ts`** (화면 크기 기억, 2026-10-18, 7.9)

| 치환 대상 | upstream 동작 | own 동작 |
|---|---|---|
| `src/main/windows/appearance.ts` `wireZoom` | 새 창마다 `setZoomFactor(1)`. 시작할 때 넘겨받는 첫 창(early window)은 이미 커밋되어 Chromium이 복원한 배율로 그려져 있으므로 시작할 때마다 100%로 돌아간다. `zoom-changed`(Ctrl+휠)는 핀치 줌이 꺼져 있으면 1로, 켜져 있으면 그 창만 ±0.2 | `src/main/zoom.ts` `joinZoom`: 이 PC의 저장 배율을 바로, 그리고 최상위 프레임 커밋마다 적용한다(다를 때만). `zoom-changed`는 모든 창의 저장 배율을 한 단계 바꾼다(`stepWindowZoom`) |
| 같은 파일 `setZoomFactor`, `setPinchZoomEnabled` | 그 창만 배율을 바꾼다(0.2~10). 핀치 줌을 끄면 배율을 1로 | `setZoomFactor`는 저장 배율을 바꾼다(`setZoom`, upstream macOS 메뉴만 부름). `setPinchZoomEnabled`는 설정을 저장·알리고 배율은 그대로 둔다 |
| 나머지(`windowAppearance`, 배경색, 제목 줄, 전체 화면) | | upstream 글 그대로(복사). upstream 모듈은 패키지 경로로 import |

- 코어 패치가 아니다(FORK §7 `substitute`, `vendored.yaml`). import하는 곳은 `windows/index.ts` 하나다. upstream이 바꾸면 surface `desktop-zoom-events`·`desktop-zoom-wire`와 vendored drift가 알린다. upstream이 배율을 스스로 기억하게 되면 이 치환은 지운다.
- 시험: `test/overrides.test.ts`(export 이름 11개), `test/zoom.test.ts`(upstream은 여전히 1로 되돌림, 치환본은 합류와 한 단계), `scripts/zoom-level.ts`(7.9).

### 4.4 `electron.vite.config.ts`

```ts
import upstream from "../desktop/electron.vite.config.ts"
import { rpcHash } from "../../own/scripts/rpc-hash.mjs"   // 5.5. 소스 파일만으로 정해지는 순수 함수
// 치환 표: upstream 절대 경로(소문자, / 구분) → own 파일
const overrides = new Map([
  [norm("../desktop/src/main/constants.ts"), "./src/overrides/constants.ts"],
  [norm("../desktop/src/main/lifecycle/environment.ts"), "./src/overrides/environment.ts"],
])
export default defineConfig((env) => {
  const base = upstream(env)
  const hash = rpcHash({ expect: process.env.OWN_RPC_HASH })  // env 값이 있으면 다시 계산해 같은지 보고, 다르면 빌드 실패
  const shellConstants = {
    "import.meta.env.OWN_RPC_HASH": JSON.stringify(hash),
    "import.meta.env.OWN_SHELL_VERSION": JSON.stringify(process.env.OWN_VERSION ?? "0.0.0-local"),
  }
  return {
    ...base,
    main: {
      ...base.main,
      plugins: [ownOverrides(overrides /* resolveId + buildEnd 미사용 키 검사 */), ...(base.main.plugins ?? [])],
      define: { ...base.main.define, ...shellConstants },
      // main 입력은 upstream과 같은 상대 경로 src/main/index.ts(:66)라 own-desktop의 vendor 파일로 풀린다
    },
    // upstream preload 입력도 상대 경로 src/preload/index.ts(:104)다. vendor 파일이 반드시 있어야 한다(4.2)
    preload: { ...base.preload, define: shellConstants },
    // dev(serve)에서는 renderer를 두지 않는다. 두면 electron-vite가 자기 renderer dev 서버를 띄우고
    // ELECTRON_RENDERER_URL을 덮어써서(electron-vite 6.0.0-beta.1 dist/chunks/lib-uEZrJ__X.js:56-67)
    // own-web Vite 대신 폴백 페이지가 뜬다(11.2)
    renderer:
      env.command === "serve"
        ? undefined
        : { root: "src/fallback", build: { rolldownOptions: { input: { main: "src/fallback/index.html" } } } },
  }
})
```

- 렌더러 빌드에는 **폴백 페이지만** 넣는다. own-web 본체는 서비스 릴리스(`app\<ver>\web\`)로 간다(5.5). 그래서 셸 빌드에 own-web 빌드 시간과 크기가 들지 않는다.
- `OWN_RPC_HASH`는 5.5의 해시다. upstream이 이미 `OPENCODE_CHANNEL`을 빌드 때 새기는 방식(`electron.vite.config.ts:59-62`)과 같다. main과 preload 모두에 새긴다(preload가 `window.own.shell.rpcHash`로 내놓음).
- 채널 env(`OPENCODE_CHANNEL`)는 설정하지 않는다. 치환된 `constants.ts`가 그 값을 읽지 않는다.
- electron-vite는 `renderer` 설정이 없으면 dev 서버를 띄우지 않고 `ELECTRON_RENDERER_URL`도 건드리지 않는다(같은 파일 `if (rendererViteConfig)` 분기).

### 4.5 `electron-builder.config.ts`

```ts
import upstream from "../desktop/electron-builder.config.ts"
const base = upstream as Configuration
export default {
  ...base,
  appId: "dev.own.opencode.desktop",
  productName: "Own OpenCode",
  executableName: "own-desktop",              // 경로에 공백 없음 (⚠ Windows 반영 확인, DS0)
  artifactName: "own-desktop-${version}-${os}-${arch}.${ext}",   // FORK §8.3 installer 이름과 같게 (win, x64)
  directories: { ...base.directories, output: process.env.OWN_DESKTOP_OUT ?? "../../own/.out/desktop" },
                                              // upstream은 "dist"(:62). build-own.ps1은 own/.out 밖에 쓰지 않는다(FORK §8.2)
  extraMetadata: { ...base.extraMetadata, desktopName: "dev.own.opencode.desktop.desktop" },
  protocols: [],                              // opencode:// 를 선언하지 않음
  publish: null,                              // app-update.yml을 만들지 않음 → 업데이터가 볼 것이 없음
  extraResources: [],                         // CLI 번들 안 함 (upstream :92-98)
  afterPack: async () => {},                  // upstream :99-108은 번들 CLI가 없으면 빌드를 실패시킨다
  files: [...base.files!, "!out/renderer/**/*.map"],
  win: { ...base.win, target: ["nsis"] },     // portable 금지: 실행마다 약 200 MB 자가 해제 ([build] §3)
  nsis: { ...base.nsis },                     // oneClick, perMachine:false, installer.nsh(icacls) 유지
}
```

- 서명 훅(`electron-builder.config.ts:23-31`)은 `GITHUB_ACTIONS=true`일 때만 돈다. 우리 저장소는 Actions를 꺼 두었으므로(01 §17 P0, FORK §3) 로컬 빌드는 서명되지 않는다(10.2).
- Electron fuses는 upstream도 설정하지 않는다(`electron-builder.config.ts`에 fuse 항목 없음). 릴리스 빌드에서 켤지는 11.2의 CDP·inspect 문제와 함께 정한다(19장).
- 워크스페이스 안에서는 `bun.lock`이 감지되어 의존성 수집이 동작한다. 스크래치 디렉터리에서는 `npm ls`로 떨어져 실패했고 `npm_config_user_agent=bun/...`로 피했다([build] §2 5번). ⚠ 실제 워크스페이스에서 DS0에 확인한다.

### 4.6 정체성과 경로

| 항목 | 값 | 근거 |
|---|---|---|
| 제품명 / 창 제목 | `Own OpenCode` | 첫 창 제목은 렌더러가 제목을 정할 때까지 upstream 고정값 `"OpenCode"`다(`windows/early.ts:50`, 외관만의 문제) |
| appId = AUMID | `dev.own.opencode.desktop` (dev: `…desktop.local`) | `configure.ts:22` `app.setAppUserModelId(APP_ID)` |
| 실행 파일 | `%LOCALAPPDATA%\Programs\own-desktop\own-desktop.exe` | 설치 폴더는 package `name`에서 나온다([build] §1) |
| userData | `%APPDATA%\dev.own.opencode.desktop\` (창 상태, `drafts.sqlite` 등 upstream 저장소, localStorage, compile cache) | `configure.ts:30,36` |
| 단일 인스턴스 락 | userData 단위 | `configure.ts:39-43`. 두 번째 실행은 기존 창을 앞으로(`lifecycle/index.ts:69-76`) |
| 제거 GUID | appId에서 유도 → upstream 설치본과 나란히 설치 | [build] §1 |
| 업데이터 | 없음 | 셸의 GUI 확장 목록에 업데이터가 없음(4.3, 8.1), `publish:null`. 업데이트는 launcher의 `own install`(01 §5.5) |
| 프로토콜 | 없음 | 4.3 |
| 렌더러 원본 | `%LOCALAPPDATA%\own-open-code\app\<version>\web\` (없으면 셸의 폴백 페이지) | 5.5 |
| 서비스 | launcher가 띄운 own 서비스(`%USERPROFILE%\.local\state\opencode\service-own.json`) | 01 §5.1 |

### 4.7 원장과 check-surface

- `own/ledger/vendored.yaml`의 형식과 `kind`(`vendor | substitute | deep-import`)는 FORK §7이 이미 정했다. 이 문서는 own-desktop과 own-web desktop host의 항목 목록만 정한다.

| kind | dest | source(`packages/desktop/…`) |
|---|---|---|
| `vendor` | `packages/own-desktop/src/main/index.ts` | `src/main/index.ts` |
| `vendor` | `packages/own-desktop/src/main/desktop.ts` | `src/main/desktop.ts` |
| `vendor` | `packages/own-desktop/src/preload/index.ts` | `src/preload/index.ts` |
| `substitute` | `packages/own-desktop/src/overrides/constants.ts` | `src/main/constants.ts` |
| `substitute` | `packages/own-desktop/src/overrides/environment.ts` | `src/main/lifecycle/environment.ts` |
| `substitute` | `packages/own-desktop/src/overrides/gui-plugins.ts` | `packages/gui-plugins/src/main.ts` (v2.0.24, v2.2.1) |
| `substitute` | `packages/own-desktop/src/overrides/plugin-manager.ts` | `src/main/plugin/manager.ts` (v2.0.24, v2.2.1) |
| `substitute` | `packages/own-desktop/src/overrides/plugin-module.ts` | `src/main/plugin/module.ts` (v2.2.1) |
| `deep-import` | `packages/own-desktop`(main 번들) | `src/main/{windows,ipc-handlers,files,storage,native,plugin,lifecycle}/*`, `src/main/{ipc,paths}.ts`, `packages/gui-plugins/src/browser/{index,main}.ts`, `packages/plugin/src/gui/{host,main,builtin}.ts`(v2.2.1 전에는 `packages/gui-extensions/src/{browser/index,browser/main,sdk/main}.ts`, v2.0.24 전에는 `src/main/{browser,updater,ssh,wsl}/*`, `browser-pane.ts`, `browser-chromium.ts`), `src/main/service/{sidecar-credentials,background-service-state,shell-env}.ts`, 그리고 교체 대상 인터페이스를 읽으려고 import하는 `src/main/service/{background-service,desktop-cli}.ts` |
| `deep-import` | `packages/own-web/src/host/desktop.ts` | `src/renderer/ipc-client.ts`, `src/shared/ipc-transport.ts`(타입: `src/shared/ipc-contract.ts`, `src/shared/ipc-rpc*.ts`). 브라우저 확장의 Ipc(`packages/gui-plugins/src/browser/ipc.ts`)는 import하지 않고 이름으로 부른다(rpcHash 입력, surface `browser-pane-ipc`) |
| `substitute` | `packages/own-desktop/src/overrides/appearance.ts` | `src/main/windows/appearance.ts` (2026-10-18, 7.9) |

- 한 줄에 여러 파일을 적은 `deep-import` 항목을 파일마다 나눌지, 디렉터리 단위로 둘지는 FORK §7이 정한다. `check-surface`는 어느 쪽이든 원본 해시 drift를 본다.
- own-web의 패인 UI vendor(`packages/app/src/session/browser/*`)는 03 §18.17이 목록을 정한다.

```yaml
- dest: packages/own-desktop/src/overrides/environment.ts
  source: packages/desktop/src/main/lifecycle/environment.ts
  kind: substitute
  upstream_commit: 00d179015f
  source_sha256: "<복사 시점 해시>"
  local_changes: "setAsDefaultProtocolClient 제거, XDG_STATE_HOME 유지, OPENCODE_CLIENT/실험 플래그 주입 제거"
  license: MIT (upstream LICENSE)
```

- `own/upstream-surface.json`에 더할 항목(깨지면 무엇이 터지는지와 함께):

| id 제안 | 파일 | 기대 | 깨지면 |
|---|---|---|---|
| `desktop-entry-order` | `packages/desktop/src/main/index.ts` | `configureApplication` → 락 → `registerRendererScheme` → whenReady → `createEarlyWindow` → `import("./desktop")` | vendor한 index.ts 재검토 |
| `desktop-layers` | `src/main/desktop.ts` | provide 목록 5개(Ipc, BackgroundService, DesktopCli, DesktopInitialization, ApplicationLifecycle), `extensions.start`를 첫 창과 함께 fork(v2.0.24) | vendor 재검토 |
| `desktop-constants-exports` | `src/main/constants.ts` | `CHANNEL`, `VERSION`, `APP_NAME`, `APP_ID`(v2.0.24에 `UPDATER_ENABLED`가 빠짐) | 치환 파일 수정 |
| `desktop-environment-exports` | `src/main/lifecycle/environment.ts` | export 6개, `setAsDefaultProtocolClient` 위치 | 치환 파일 수정. **G-D2 재실행** |
| `desktop-protocol-first-wins` | `src/main/windows/protocol.ts:38-39` | `if (protocol.isProtocolHandled(rendererProtocol)) return` | 렌더러 위치 방식(5.5) 재설계 |
| `desktop-renderer-auth` | `src/main/windows/security.ts:42-53`, `service/sidecar-credentials.ts:26-29` | top frame + 렌더러 URL + 서비스 origin일 때만 Basic | 인증 방식 재검토(6.4) |
| `desktop-bg-service-iface` | `src/main/service/background-service.ts:10-13` | `{connection, reconnect}` | own layer 수정 |
| `desktop-cli-iface` | `src/main/service/desktop-cli.ts:16-26` | `Resolved{version, command, binary?, wslBuild?}`, `{resolve, install}` | own layer 수정 |
| `desktop-ipc-contract` | `src/shared/ipc-rpc.ts`, `src/shared/ipc-rpc/*.ts`, `src/shared/ipc-transport.ts`, `src/shared/ipc-contract.ts`, `src/shared/window-bootstrap.ts` | rpcHash 입력(5.5). 태그 81개 | rpcHash가 바뀜 → own-web·셸 재빌드 |
| `desktop-preload-input` | `packages/desktop/electron.vite.config.ts:104` | preload 입력이 상대 경로 `src/preload/index.ts` | own-desktop preload vendor 위치 재확인 |
| `desktop-renderer-chunking` | `packages/desktop/electron.vite.config.ts:31-52,137-139` | 초기 그래프를 한 chunk(`app`)로 묶는 `codeSplitting.groups` | own-web 빌드의 같은 규칙(R-D12) 재검토 |
| `desktop-app-menu` | `src/main/native/menu.ts:25,38` | Windows에서는 `createMenu`가 곧바로 돌아가고 `Menu.setApplicationMenu`를 부르는 곳이 이것뿐 | 7.7의 메뉴 비우기 재검토 |
| `browser-attach-v4` | `packages/gui-plugins/src/browser/pane.ts:284`(v2.0.24 전 `src/main/browser-pane.ts:244`), 짝 `browser-attach-v4-server`(`packages/plugin-browser/src/connection.ts`) | 양쪽 모두 version 4. register의 server id는 확장 호스트의 `serverEndpoints`로 풀림 | 패인 호환 재확인(G-D5) |
| `browser-pane-ipc` (v2.0.24, `browser-pane-target`을 대신함) | `packages/gui-plugins/src/browser/ipc.ts` | `browser.pane` Ipc: `register{binding, server, session, restore?}`, `load`, `command`, `inspect`, `highlight`, `close`, 이벤트 `event{binding, event}`(focus, preview, state, embed, inspect). rpcHash 입력 | desktop host 수정, rpcHash 재생성 |
| `browser-extension-definition` (v2.0.24) | `packages/gui-plugins/src/browser/index.ts` | `browser`, `browser.pane`을 provide하고 `uses`·`requires`가 없음 | 셸의 내장 목록(4.3) 재검토 |
| `browser-embed-child-view` (v2.0.24) | `src/main/extension/embeds.ts` | embed는 창 contentView의 자식 뷰, 렌더러 배치와 페이지 쪽 `show`가 모두 있어야 보임, capture는 보이는 뷰만 | own-browser.ts `hostWindow`, 8.5 재검토 |
| `desktop-extension-host-builtins`, `desktop-extension-server-endpoints`, `desktop-extension-ipc-guard` (v2.0.24) | `src/main/extension/host.ts`, `src/main/ipc-handlers/extensions.ts` | 내장 목록과 관리자를 쓰는 자리, server id → 끝점(Basic은 비밀번호나 sidecar origin), Extension IPC는 렌더러 URL의 앱 창만, 관리자는 패키지 빌드에서만 거부 | 치환(4.3)·8.1·8.2 재검토 |
| `browser-tools-registration` | `packages/plugin-browser/src/tools.ts:33-56`, `packages/core/src/tool.ts:229-259,292-295` | `permission:"browser"`, `codemode:true`, 설명 있는 namespace `browser`, 전면 deny면 스냅샷에서 빠짐, `definitions`에는 `execute`만 | 8.7 결정 재검토 |
| `codemode-catalog-instructions` | `packages/core/src/codemode/tool.ts:61`, `codemode/instructions.ts:32-124`, `codemode/catalog.ts:50`, `session/instruction-state.ts:41-60` | `execute` 설명 불변, 카탈로그 변경은 durable `InstructionsUpdated`로 덧붙음, 설명 있는 namespace가 생기거나 없어지면 전체 교체 문구 | 8.7 결정 재검토 |
| `location-eviction` | `packages/core/src/location-activity.ts:25-45,50-81` | 마지막 세션 durable 이벤트 뒤 60분이면 Location 해제 | 13.4 게이트웨이 수명 재검토 |
| `electron-toolchain` | `packages/desktop/package.json:49,53-55,58` | electron 44.9.1, electron-vite 6.0.0-beta.1, electron-builder 26.15.7, vite 8.2.4 | own-desktop devDeps 맞춤. electron은 예외로 own이 44.10.2(EL-1): upstream이 44.10.2 이상을 고정하면 맞추고 예외를 지운다 |

---

## 5. 서비스 수명주기와 연결

### 5.1 원칙

- **시작자는 launcher 하나다(01 §5.3).** 셸은 launcher의 클라이언트다. 서비스가 이미 있으면 붙고, 없으면 launcher에 부탁한다. 셸이 서비스를 직접 spawn하거나 `Service.ensure`로 교체하지 않는다.
- **셸이 꺼져도 서비스는 산다.** upstream도 종료 때 서비스를 멈추지 않는다([verdict] §4-4, `lifecycle/shutdown.ts`는 등록된 정리 작업만 돈다). 예외는 사용자가 고르는 `완전 종료`(7.3) 하나다: 셸이 묻고, launcher의 `own stop --force`로 이 PC의 서비스를 멈춘 뒤 끝난다. 이것도 launcher를 거친다(셸이 서비스 프로세스를 직접 멈추지 않는다).
- **개발 모드(`OWN_DESKTOP_CHANNEL=local`)에서는 아무것도 띄우지 않는다.** `service-local.json`만 찾고, 없으면 "개발 서비스를 먼저 띄우세요"를 보인다(11.2).

### 5.2 env 스냅샷 (`own-env.ts`)

- vendor한 `index.ts`의 **첫 import**다. ES 모듈 평가 순서상 upstream `configureApplication()`(`index.ts:15`)보다 먼저 돈다.
- 하는 일
  - `process.env`를 얕게 복사해 모듈 변수에 둔다. 그 뒤 Electron과 upstream이 바꾸는 값이 launcher로 새지 않게 하기 위해서다. 예: `OPENCODE_DISABLE_EMBEDDED_WEB_UI=true`(`configure.ts:19`), NO_PROXY 보강(`environment.ts:65-77`), 테스트 루트의 `XDG_*`(`configure.ts:56-59`).
  - 셸 시작 시각(`Date.now()`)을 기록한다. `own:shell.info`로 렌더러에 넘겨 03 §20.1 B1의 `own:shell-start` 기준점이 된다(5.6).
- **스냅샷 하나로 경로를 정한다.** 셸이 쓰는 경로는 모두 이 스냅샷에서 계산한다. launcher가 같은 스냅샷 env로 경로를 정하므로(`own.ps1` `Get-OwnPaths`) 둘이 어긋나지 않는다.
  - 등록 파일: `<스냅샷 XDG_STATE_HOME | 스냅샷 USERPROFILE\.local\state>\opencode\service-own.json`
  - `OWN_HOME`: `<스냅샷 OWN_HOME | 스냅샷 LOCALAPPDATA\own-open-code>`
  - `configureApplication()` 뒤의 `process.env`로 경로를 계산하지 않는다. 비패키지 빌드에서 `OPENCODE_DESKTOP_TEST_ROOT`가 있으면 `XDG_*`가 테스트 루트로 바뀌므로(`configure.ts:56-59`), 셸은 테스트 루트에서 등록 파일을 찾고 launcher는 원래 위치에 등록해 서로 못 찾는다.
  - 테스트 하네스(11.3)는 셸을 띄우기 전에 `XDG_*`와 `OWN_HOME`을 직접 env로 준다. 그러면 스냅샷과 테스트 루트가 같은 값을 가진다.
- **셸은 env를 정리하지 않는다.** 서비스 env를 정하는 것은 launcher의 `Set-OwnEnvironment`와 `Get-BridgeEnv`다. 셸은 스냅샷을 **그대로** launcher에 넘기고 스스로 키를 지우지 않는다. 더하는 키는 launcher 실행 표시 `OWN_LAUNCHER_CLIENT=desktop` 하나다(launcher가 읽고 자기 env에서 지우므로 서비스에는 닿지 않는다. 쓰임은 13.4 2번, 01 §5.3). launcher가 provider 키를 지운다(01 §5.3 1단계). 01 §4.1의 "own-env가 launcher와 같은 env 정리를 함"은 이 규칙으로 고친다(17장). 셸이 직접 띄우는 다른 프로세스는 사용자가 고른 에디터·탐색기(`FilesOpenPath`)뿐이고, 그것은 사용자의 원래 env를 받는 것이 맞다.

### 5.3 `BackgroundService(own)`

`BackgroundService.Service`의 `{connection, reconnect}`를 upstream `BackgroundServiceState.make`(`background-service-state.ts`)로 감싸 구현한다. 순서는 initial과 reconnect가 같다.

```text
connect(mode):
 1. file = <스냅샷 XDG_STATE_HOME | 스냅샷 USERPROFILE\.local\state>\opencode\service-own.json   (5.2)
           (OWN_DESKTOP_CHANNEL=local이면 service-local.json)
 2. Service.discover({ file })          ← version을 넘기지 않는다. ensure를 부르지 않는다.
      healthy면 → 8단계
 3. dev(local) 채널이면 → 실패("개발 서비스 없음") 후 3초 간격 재시도
 4. launcher 실행 (service/launcher.ts)
      spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
                               "-File", "<OWN_HOME>\bin\own.ps1", "start"])     ← OWN_HOME은 스냅샷에서(5.2)
      shell:false, windowsHide:true, env = 5.2 스냅샷, stdin = 닫힌 파이프(비대화형), 타임아웃 60초
      플래그는 own.cmd가 쓰는 것과 같다(own/launcher/own.cmd:4). own.cmd를 거치지 않는 이유:
      Node는 배치 파일 인자 처리 보안 수정 뒤 .cmd/.bat을 shell:true 없이 spawn하지 않는다(⚠ 외부 사실, Electron 44의 Node 판에서 DS0 확인).
      shell:true로 cmd.exe를 거치면 경로·인자 인용 문제가 다시 생긴다.
 5. 종료 코드 ≠ 0 → stderr 끝 4 KiB를 로그와 렌더러 오류 화면에 보인다(비밀 없음: launcher는 키 이름만 출력)
 6. 다시 discover (최대 10초, 250 ms 간격)
 7. 없으면 실패 → 렌더러는 "서비스를 시작하지 못했습니다" + [다시 시도] [로그 열기]
 8. auth가 basic이 아니면 실패(upstream :56과 같음)
 9. SidecarCredentials.set({ url: origin, password })   ← 렌더러에는 url만 간다(sidecar-credentials.ts:20-23)
10. 비동기(첫 창 뒤): 버전 스큐 검사(5.5)
```

- **비대화형이라 fail closed다.** `own start`는 버전이 다른 서비스가 떠 있고 세션이 돌면 대화형 확인을 요구하는데, stdin이 리다이렉트돼 있으면 거부한다(`own.ps1:283-290`, [verdict] §0 #20). 다만 셸은 2단계에서 healthy 서비스를 이미 채택하므로 4단계는 서비스가 **없을 때만** 돈다. 즉 셸은 어떤 경우에도 떠 있는 서비스를 교체하지 않는다.
- **`own start`가 하는 일은 launcher 그대로다**: env 브리지 기록, env 정리, `service start`(01 §5.3 0–2단계). pairing과 브라우저 열기(3–4단계)는 `own open`에만 있으므로 셸 경로에서는 생기지 않는다.
- **reconnect**는 렌더러가 연결 끊김을 알릴 때(`AppReconnectService`) 같은 순서로 돈다. 서비스가 재시작되며 포트가 같아도 password가 바뀔 수 있으므로 매번 등록 파일을 다시 읽는다.

### 5.4 `DesktopCli(own)`

| 필드 | 값 |
|---|---|
| `resolve.version` | `%LOCALAPPDATA%\own-open-code\app\<version>\manifest.json`의 `version` |
| `resolve.command` | `[<OWN_HOME>\app\<version>\opencode.exe]` |
| `resolve.binary` | 같은 경로 |
| `resolve.wslBuild` | 없음 |
| `install` | 항상 실패("지원하지 않음"). upstream도 macOS 전용이다(`desktop-cli.ts:37-38`) |

- upstream은 번들 CLI를 userData로 복사한다(`desktop-cli.ts:152-171`, 버전마다 약 197 MB, [build] §4 위험 9). 우리는 복사하지 않는다.
- 소비자는 BackgroundService(교체됨), `ipc-handlers/app.ts:31`, `ipc.ts:49`, `ssh/service.ts:81`, `wsl/start.ts:18-19`다. 뒤의 둘은 비활성 경로라 호출되지 않는다.

### 5.5 렌더러 위치와 버전 결합

**결정: 렌더러는 서비스 릴리스에 싣는다(`app\<ver>\web\`).** 셸 번들에는 폴백 페이지만 둔다.

- **이유.** UI와 서비스·플러그인 RPC(`own.accounts`, `own.remote`)는 한 몸으로 바뀐다. UI를 셸에 넣으면 `install.ps1`로 서비스를 올릴 때마다 셸도 다시 설치해야 하고, 둘이 어긋나면 02의 RPC 계약이 깨진다. 서비스와 같은 버전 포인터 교체(01 §5.5)로 UI를 바꾸면 이 문제가 없다.
- **등록 순서.** vendor한 `index.ts`의 `whenReady` 안, `createEarlyWindow()`(`index.ts:23`) 바로 앞에서:
  1. `<OWN_HOME>\app\<version>\manifest.json`을 동기로 읽는다(수 KB, 1 ms 미만).
  2. `manifest.desktop.rpc_hash === import.meta.env.OWN_RPC_HASH`이고 `app\<version>\web\index.html`이 있으면 `registerRendererRoot(<OWN_HOME>\app\<version>\web, 페이지 로드마다 포인터를 따라감)`. 키 이름은 FORK §8.3의 snake_case(`desktop.rpc_hash`)다.
  3. 아니면 `registerRendererProtocol(<셸>\out\renderer)`(폴백 페이지). 이유(`missing` | `skew`)는 첫 창 bootstrap 인자로 넘긴다.
  - upstream `early.ts:83`과 `environment.ts:45`의 등록은 first-wins 규칙으로 no-op이 된다(`protocol.ts:39`, [verdict] §0 #15).
  - upstream 서빙 함수를 그대로 쓰므로 경로 탈출 방지(`protocol.ts:53-65`)와 자산 서빙 추적(`rendererAssetsServed`, `index.ts:28`)이 유지된다. 우리 핸들러를 따로 만들면 이 추적이 끊겨 main 번들 로드가 항상 400 ms 상한까지 밀린다(`protocol.ts:25-36`). 그래서 핸들러는 새로 쓰지 않는다.
  - 루트: upstream 핸들러의 루트는 등록 때 한 번 정해진다(`protocol.ts:38-51`). own-desktop은 그 핸들러를 루트 함수를 받게 옮긴 사본(`src/main/renderer-protocol.ts`, vendored)을 먼저 등록하고, 설치된 UI면 페이지(HTML) 요청마다 `app\current.json`을 다시 읽어 루트를 옮긴다(예전 junction이 요청마다 하던 일. 자산 요청은 그 페이지의 루트). 셸이 떠 있는 동안 포인터가 바뀌면 다음 로드부터 새 UI 파일이 나온다. 이 경우는 아래 렌더러 재검사가 막는다. 폴백 페이지와 dev URL은 옮기지 않는다.
- **rpcHash.**
  - **입력**: `packages/desktop/src/shared/ipc-rpc.ts`, `src/shared/ipc-rpc/*.ts`, `src/shared/ipc-transport.ts`, `src/shared/ipc-contract.ts`, `src/shared/window-bootstrap.ts`, `packages/gui-plugins/src/browser/ipc.ts`(v2.0.24: own-web이 `PluginCall`로 부르는 브라우저 패인 Ipc. 확장을 시작하지 않던 셸과도 해시가 갈린다), `packages/own-desktop/src/preload/own-api.ts`. 경로 이름순으로 LF 정규화 내용을 이어 붙인 sha256의 앞 16자다. FORK §8.2의 "`shared/ipc-rpc*.ts` 해시"보다 넓다. own-web desktop host가 deep import하는 전송 코드(`ipc-transport.ts`)와 타입(`ipc-contract.ts`, `window-bootstrap.ts`), 그리고 `window.own` 계약이 바뀌어도 셸 ↔ 렌더러 계약이 깨지기 때문이다(17장 FORK 항목).
  - **계산 위치**: `own/scripts/rpc-hash.mjs`(Node, 입력 파일만으로 정해지는 순수 함수) 하나다. `build-own.ps1`이 **own-web 빌드 전에** 한 번 계산해 env `OWN_RPC_HASH`로 넘긴다. own-web 빌드(진입 모듈의 상수, 6.6)와 셸 빌드(main·preload 상수)는 각자 다시 계산해 env 값과 다르면 실패한다. `build-own.ps1`은 같은 값을 `manifest.json`의 `desktop.rpc_hash`에 쓴다. 그래서 빌드 순서(FORK §8.2의 2단계 own-web → 5단계 셸)와 상관없이 세 곳의 값이 같다.
- **렌더러 재검사(필수).** own-web의 진입 모듈은 desktop host를 import하기 **전에** `window.own.shell.rpcHash`(preload 상수)와 자기 빌드에 새긴 해시를 비교한다.
  - 다르면 desktop host를 불러오지 않으므로 upstream IPC를 한 번도 부르지 않는다. 대신 own-web이 폴백 페이지와 같은 문구의 불일치 화면을 직접 그린다.
  - `window.own`이 없으면(preload가 없는 셸, 있을 수 없는 조합) 같은 화면을 그린다.
  - main 쪽 검사(위 2단계)는 시작 때 한 번이다. 셸이 떠 있는 동안 `install.ps1`(own update·rollback)로 포인터가 바뀐 뒤 창이 다시 로드되면(아래 "UI 교체 중의 창") 새 UI가 옛 셸 아래에서 뜬다. 이 경우를 막는 것이 렌더러 재검사다.
  - main도 렌더러 top frame의 `did-start-navigation`(main frame, 같은 문서가 아님)마다 `manifest.json`을 비동기로 다시 읽어 불일치를 로그에 남긴다. 핸들러 루트를 바꿀 수 없으므로 차단은 하지 않는다.
- **폴백 페이지 문구.** `앱 셸과 화면 버전이 맞지 않아요` + 셸 버전·UI 버전 + [브라우저로 열기](`own open --browser`와 같은 경로) + [로그 폴더]. `missing`이면 `Own OpenCode가 설치되지 않았어요`와 설치 파일을 다시 실행하라는 안내. 03 §8의 "셸·렌더러 버전 불일치" 행과 같은 뜻이다(문구는 03이 기준).
  - **구현(두 화면).** 셸의 폴백 페이지(`src/fallback`)와 own-web의 불일치 화면(`src/host/mismatch.ts`, T0-0이 거부했을 때 앱 대신)이 같은 문구·버튼이다: 창 위쪽 끌기 띠(`-webkit-app-region: drag`, WCO 창이라 이것이 없으면 창을 옮길 수 없다), 셸·화면 버전(버전 · rpcHash), `own open --browser` 안내, [브라우저로 열기], [로그 폴더]. own-web 쪽만 [다시 확인](새로 고침: junction이 되돌아왔으면 맞는 UI가 뜬다)이 있다. 폴백 페이지는 main이 시작 때 고른 것이라 새로 고쳐도 같다.
  - 두 버튼은 upstream IPC가 아니라 `window.own.support`(5.6)로 부르고, **있을 때만** 보인다. 이 화면이 뜨는 것 자체가 셸과 계약이 다르다는 뜻이라, 그 셸에 `support`가 없을 수 있다. 없으면 명령 안내만 남는다.
- **UI 교체 중의 창.** `install.ps1`은 포인터(`app\current.json`)를 바꾸기 전에 서비스를 멈춘다(01 §5.5). 창은 연결 끊김을 보고, 재연결 뒤 `GET /api/info`의 version이 렌더러가 빌드된 버전과 다르면 초안을 저장하고 창을 다시 로드한다. 지연 chunk 로드가 실패해도(해시 이름 파일이 새 버전에 없음) 같은 방식으로 다시 로드를 제안한다.
  - 다시 로드는 top frame 이동이라 그 창의 브라우저 attachment가 모두 닫힌다(`gui-plugins/src/browser/pane.ts:130-131`, 확장 호스트도 그 창의 embed 배치와 구독을 지운다). 다시 로드된 own-web은 열린 세션의 패인을 다시 register한다(8.2).
  - 새 UI의 해시가 셸과 다르면 렌더러 재검사가 불일치 화면을 보인다. 사용자는 셸을 다시 설치해야 한다(01 §5.5 6단계).
- **버전 스큐 배너.** 등록 파일의 서비스 version과 `manifest.json` version이 다르면(사용자가 raw exe로 다른 버전을 띄운 경우 등) 01 §5.4 가드 2와 같은 전체 화면 배너를 쓴다: `관리되지 않는 서비스 인스턴스 — own restart 필요`.
- **무결성.** `app\<version>\web`은 사용자 쓰기 가능 위치다. 같은 사용자 권한 코드는 셸 실행 파일(`%LOCALAPPDATA%\Programs`)도 바꿀 수 있으므로 신뢰 경계는 같다(01 §13 전제). 시작 경로에서 파일 해시를 검사하지 않는다(시작 지연). ⚠ 첫 창 뒤에 `manifest.json` 파일 해시와 비교하는 선택 검사를 둘지는 19장.

### 5.6 셸 쪽 계약 (`window.own`, 필수)

own-web이 서비스 재시작을 요청할 수단이 브라우저 모드에는 없다. 데스크톱은 vendor한 preload로 이것을 해결한다. `window.own`은 03 §16.7 `OwnHost`의 데스크톱 구현이 쓰는 셸 쪽 계약이고, own-web의 다른 코드는 이것을 직접 부르지 않는다.

```ts
// packages/own-desktop/src/preload/own-api.ts (rpcHash 입력, 5.5)
export interface OwnShellApi {
  shell: {
    rpcHash: string
    version: string
    startedAt: Promise<number>     // 셸 main 시작 epoch ms (5.2)
    controlDir: Promise<string>    // <스냅샷 OWN_HOME>\control. 02 §9.1 control location (02 12장 Q41)
  }
  service: {
    status(): Promise<{ running: boolean; version?: string; registration?: string; managed: boolean }>
    restart(input: { force: boolean; claudeConfigDir?: string }): Promise<
      | { ok: true }
      | { ok: false; refused: "session_running" }                       // launcher 종료 코드 4(5.7)
      | { ok: false; refused: "launcher_failed"; detail: string }       // 그 밖의 비정상 종료. detail = stderr 끝 4 KiB
    >
  }
}

// vendor한 src/preload/index.ts에 추가 (upstream 29줄 + 약 18줄)
// 페이지가 돌기 전에 한 번 묻는다. 비동기 invoke라 첫 페인트를 막지 않는다(upstream storageSnapshot과 같은 방식, preload/index.ts:18-22)
const info: Promise<{ startedAt: number; controlDir: string }> = ipcRenderer.invoke("own:shell.info")
contextBridge.exposeInMainWorld("own", {
  shell: {
    rpcHash: import.meta.env.OWN_RPC_HASH,                              // 빌드 상수(4.4)
    version: import.meta.env.OWN_SHELL_VERSION,
    startedAt: info.then((i) => i.startedAt),
    controlDir: info.then((i) => i.controlDir),
  },
  service: {
    status: () => ipcRenderer.invoke("own:service.status"),
    restart: (input) =>
      ipcRenderer.invoke("own:service.restart", {
        force: input?.force === true,
        claudeConfigDir: typeof input?.claudeConfigDir === "string" ? input.claudeConfigDir : undefined,
      }),
  },
} satisfies OwnShellApi)
```

- **모양은 03 §16.7에 맞춘다.** `status`는 03의 `{running, version?, registration?}`에 `managed`(01 §5.4 가드 2의 판정)를 더했고, `restart`는 03의 `{ok, refused?:"session_running"}`에 `claudeConfigDir` 입력과 `launcher_failed`를 더했다. 더한 부분은 03 §16.7에 반영을 요청한다(17장).
- **own 추가(구현, 위 코드 블록 밖).** `shell.renderer`(렌더러 출처, 폴백 이유), `browser`(8.4 다운로드, 7.2 닫기 확인), `support?: { openLogs(): Promise<boolean>; openInBrowser(): Promise<{ok:true} | {ok:false; detail}> }`. `support`는 5.5 불일치 화면 전용이다: `own:support.open-logs`(셸 userData\logs를 탐색기로), `own:support.open-in-browser`(아래 `restart`와 같은 방식으로 `own.ps1 open --browser`, 타임아웃 60초, 개발 채널은 거부, 종료 코드 4는 "다른 버전 서비스가 세션 실행 중"으로 알린다). `app?: { quit(mode: "app" | "all"): Promise<boolean>; closeAction(); setCloseAction(action: "tray" | "quit") }`(7.3 트레이와 종료, 2026-10-18): `own:app.quit`(`app`은 셸만 끝냄, `all`은 셸의 대화상자를 거쳐 `own.ps1 stop --force` 뒤 끝냄, 아무것도 닫히지 않으면 `false`), `own:app.close-action`(`{action?}`, 주면 먼저 저장하고 지금 값을 답한다. 그 밖의 값은 `tray`). `zoom?: { get(); set(factor); step("in" | "out"); onChange(listener) }`는 이 PC의 화면 크기다(7.9). 이 두 추가로 rpcHash가 `0293c231be827873`에서 `cbc59aad55a8107b`로 바뀌었다(zoom만이면 `76aa201d8528458e`, app만이면 `b9c859afdda00146`). 받는 쪽은 모두 기능 감지로 부른다. 전체 모양은 `packages/own-desktop/src/preload/own-api.ts`(rpcHash 입력)가 기준이다.
- **`controlDir`.** 02 §9.1은 데스크톱에서 OwnHost가 control location 경로를 내주기를 요구한다(02 12장 Q41). 데스크톱 호스트는 `window.own.shell.controlDir`을 `server.connect()` 결과의 `controlDir`로 내놓는다. 웹 폴백은 launcher의 URL fragment(`#control=`)에서, 모바일은 게이트웨이의 서버 목록(13.4 `GET /own/servers`)에서 같은 필드를 채운다. 03 §16.7의 `connect()` 결과에 `controlDir?: string`을 더하기를 요청한다(17장).
- **main 쪽 검사**: `event.senderFrame`가 top frame이고 `isRendererUrl(senderFrame.url)`(`windows/scheme.ts:16-24`)일 때만 처리한다. 브라우저 패인 탭(다른 partition, preload 없음)에서는 이 채널이 보이지도 않는다.
- **`restart`**: 5.3 4단계와 같은 방식으로 `own.ps1 restart [--force] [--claude-config-dir <dir>]`를 실행한다(5.2 스냅샷 env, 닫힌 stdin, windowsHide, 타임아웃 90초).
  - `--force`는 렌더러가 `GET /api/session/active`로 실행 중 세션 목록을 보여 주고 사용자가 확인한 뒤에만 넘긴다. launcher는 실행 중 세션이 있는데 `--force`가 없고 stdin이 리다이렉트돼 있으면 거부한다(`own.ps1:283-290`). 지금은 이 거부가 다른 실패와 같은 종료 코드 1이라 구분할 수 없으므로, 전용 종료 코드 4를 더한다(5.7).
  - `claudeConfigDir`는 main이 다시 검사한다: 절대 경로, 제어 문자 없음, 1,024자 이하, 디렉터리가 있음. 인자는 배열로 넘기고 셸 문자열을 만들지 않는다.
- **`restart-service` 처리.** 02의 `clientAction:{type:"restart-service", configDir}`(`packages/own-protocol/src/switch.ts:57-61`, `plugin.claudeAuth.changeSource.execute`의 결과, `rpc.ts:625-629`)는 `host.server.restart({force:false, claudeConfigDir: configDir})`로 처리한다. 성공해서 다시 붙으면 own-web이 `plugin.claudeAuth.importSubscription`을 부른다(02 §8.7).
  - 왜 인자가 필요한가: launcher의 브리지 env는 `OPENCODE_CONFIG_DIR`, `OWN_OPEN_CODE`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_FREE_MODELS`, `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`(와 untrusted 플래그)만 쓰고(`own.ps1` `Get-BridgeEnv`), `Set-OwnEnvironment`는 `CLAUDE_`로 시작하는 변수를 모두 지운다(`$ProviderKeyPrefixes`). 그래서 인자 없이 재시작하면 `CLAUDE_CONFIG_DIR`이 서비스에 닿을 길이 없다. launcher 쪽 규칙은 5.7이다.
  - `service.control` capability가 없는 호스트(웹, 모바일)는 `PowerShell에서 다음 명령을 실행하세요` 안내와 `own restart --claude-config-dir "<dir>"` 복사 버튼을 보인다.
- 서비스가 재시작되면 SSE가 끊기고 5.3 reconnect가 새 password로 다시 붙는다. 브라우저 attachment는 `suspended`가 되었다가 다시 붙는다(8.2).

### 5.7 launcher 변경

| 명령 | 지금 | 바뀐 뒤 |
|---|---|---|
| `own open` | 서비스 기동 → pairing → `msedge --app` (`own.ps1:374-388`) | 서비스 기동 → own-desktop이 설치돼 있으면(`%LOCALAPPDATA%\Programs\own-desktop\own-desktop.exe`) 그것을 실행. pairing 링크를 만들지 않는다 |
| `own open --browser` | – | 지금의 `own open`(msedge 폴백, pairing 쿠키) |
| `own start`, `stop`, `status`, `pair` | – | 그대로. 셸이 `start`를, 완전 종료(7.3)에서 `stop --force`를 부른다 |
| `own restart` | `stop` + `start`(`own.ps1:501-505`) | `--claude-config-dir <dir>` 추가(아래). 셸이 부른다 |
| 실행 중 세션 거부 | `Confirm-Stop`이 `Stop-Own`으로 종료 코드 1(`own.ps1:283-290`). `restart`와, 다른 버전 서비스를 바꾸는 `start` 모두 | **종료 코드 4**로 구분. 셸은 이것을 `refused:"session_running"`으로 바꾼다(5.6). `start`에서 나오면 5.3의 "launcher가 교체를 거부" 화면(03 §8)이다 |
| (M1+) 게이트웨이 깨우기 | – | `start`·`restart`가 서비스 기동 뒤, 게이트웨이가 켜져 있으면 control location으로 `own.remote` `gateway.status`를 한 번 부른다(13.4). 셸이 부른 실행(`OWN_LAUNCHER_CLIENT=desktop`)은 부르지 않는다: 앱의 첫 control RPC가 게이트웨이를 띄운다(13.4 2번) |
| `own install`, `update`, `rollback`, `uninstall` | stub이었음 | 구현(launcher 0.3.0). 설치 파일이 payload로 `install --from … --move --no-prompt`, 제거기가 `uninstall [--remove-data]`를 부른다(10.4). `logon`만 stub |

- **`own restart --claude-config-dir <dir>`** (구현)
  - 값을 02 §8.7의 파일 `OWN_HOME\claude-auth.json` `{configDir, setAt}`에 저장한다. own.accounts(`plugin.claudeAuth.changeSource.execute`)가 쓰는 것과 같은 파일이라 저장 위치가 하나다(이전 초안의 `launcher.json` 제안은 버렸다). `--claude-config-dir default`는 파일을 지운다. 경로 검사는 셸과 같다(절대 경로, 제어 문자 없음, 1,024자 이하, 있는 디렉터리). 여기에 더해 own의 로그인 폴더(`OWN_HOME\claude-accounts`와 그 안, 경로로 또는 정션·심볼릭 링크를 따라가서, 대소문자 무시)는 서비스의 changeSource처럼 거절한다(02 §8.7 CS, 2026-10-23: `CLAUDE_CONFIG_DIR`로 넘기면 그 계정이 읽기 전용이 되어 다음 토큰 만료에 멈춘다. 8.3 짧은 이름은 풀지 않는다). 시작 때 `claude-auth.json`을 읽는 검사는 그대로다. 틀리면 아무것도 멈추지 않고 종료 코드 64. 값은 멈춤이 끝난 뒤에 쓴다: 세션 실행 중이라 거부되면(종료 코드 4) 아무것도 바뀌지 않는다.
  - `Get-BridgeEnv`는 이 파일의 값이 쓸 수 있으면 브리지 env에 `CLAUDE_CONFIG_DIR=<dir>`을 더한다. 서비스는 spawn할 때 서비스 설정의 `env`를 합치므로(01 §5.2, `service-config.ts:109`) 이 키만 서비스에 닿는다. 파일의 경로가 없어졌으면 넣지 않고 경고만 한다.
  - `Set-OwnEnvironment`의 `CLAUDE_*` 제거는 그대로다. launcher가 물려받은 env의 `CLAUDE_*`는 여전히 지우고, 예외는 이 파일에서 온 `CLAUDE_CONFIG_DIR` 하나뿐이다(02 §8.3 I8). `own env`는 값과 출처(`claude-auth.json`)를, `own status --json`은 `claude_config_dir`을 보여 준다.
  - 이후 `own start`·`restart`와 셸의 시작도 같은 값을 계속 쓴다. 한 번 바꾼 계정 소스가 다음 기동에서 사라지지 않게 하기 위해서다.
- **종료 코드 4**(구현): `Confirm-Stop`이 물을 수 없을 때(stdin 리다이렉트) 실행 중 세션을 이유로 거부하면 4로 끝난다(`stop`, `restart`, 다른 버전·모드 서비스를 바꾸는 `start`). 대화형에서 사용자가 `N`을 고르면 여전히 1이다. 도움말에 종료 코드 1·2·3·4·64를 적었다.
- **`own open --browser`**: 지금 `open`은 늘 브라우저로 여므로 플래그는 받기만 한다(도움말에 표시). 5.5의 [브라우저로 열기]가 이 형태로 부른다. `open`이 데스크톱을 띄우는 동작은 아직 없다.
- 셸이 이미 떠 있으면 두 번째 실행은 단일 인스턴스 규칙으로 기존 창을 앞으로 가져온다(`lifecycle/index.ts:69-76`).

---

## 6. 렌더러 계약: OwnHost

### 6.1 전송

- vendor한 preload가 upstream의 `window.electron = {windowID, bootstrap, storageSnapshot, getPathForFile}`(`src/preload/index.ts:24-29`)을 바꾸지 않고 내놓고, 그 옆에 `window.own`(5.6)을 더한다.
- 셸 기능 호출은 MessagePort 위의 Effect RPC다. main이 창마다 `MessageChannelMain`을 만들어 `did-finish-load` 때 포트를 넘긴다(`ipc.ts`). 태그는 v2.0.18에서 81개(`shared/ipc-rpc/*.ts`, AppRpcs 19 · Files 12 · Window 10 · Wsl 13 · Ssh 11 · Storage 8 · Updater 4 · Browser 2 · Events 1 · Menu 1)였다. v2.0.24(f406d93a66)에서 Wsl·Ssh·Updater·Browser 그룹이 빠지고 Extension 그룹(`PluginCall`, `PluginSubscribe`, `PluginEmbed`, `PluginCapture`, `PluginConfigure`, 관리자 호출 등 14개)이 생겼다. 합친 그룹은 `shared/ipc-rpc.ts`.
- 렌더러 쪽 클라이언트는 upstream `ipc-client.ts`다. own-web desktop host가 이것을 deep import한다(6.6). `api.ts`는 쓰지 않는다.

### 6.2 인터페이스 (기준: 03 §16.7)

**소유.** `OwnHost`의 TypeScript 모양(`has(capability)`, `server.connect/reconnect/status/restart`, `window.*`, `fs.*`, `browserPane` 등)과 `Capability` 이름 목록은 **03 §16.7 하나가 기준**이다. `src/host/`가 own-web 안에 있고 UI가 이것을 쓰기 때문이다. 이 문서는 인터페이스를 다시 정의하지 않는다. 01 §6.2의 capability 이름(`folderPicker`, `systemNotifications`, `windowChrome`, `keepAwake`, `push` 등)도 03 이름으로 바꾸기를 요청한다(17장).

**데스크톱 구현 대응.** 03 §16.7의 capability마다 데스크톱 호스트가 무엇으로 채우는지다.

| capability(03 §16.7) | desktop 구현 | web | mobile(나중) | 적용 범위 |
|---|---|---|---|---|
| `window.titlebarOverlay` | WCO 밴드. `WindowSetTitlebar`, `AppSetBackgroundColor` | – | – | 창 |
| `window.zoom` | `window.own.zoom`(5.6, 7.9). main이 이 PC의 배율 하나를 셸 설정 파일에 두고 모든 own-web 창에 적용·알리며, 창 버튼 overlay 높이도 맞춘다. upstream `WindowSetZoomFactor`는 쓰지 않는다(그 창만 바꾸고 저장·알림이 없다) | – | – | 이 PC의 모든 창 |
| `fs.pickDirectory` | `FilesOpenDirectoryPicker` | – | – | 서버 키 `local` 세션만 |
| `fs.dropPaths` | preload `getPathForFile`(`preload/index.ts:28`) | – | – | 서버 키 `local` 세션만 |
| `fs.openPath` | `FilesOpenPath`, `AppCheckAppExists`, `AppResolveAppPath` | – | – | 서버 키 `local` 세션만 |
| `fs.revealPath` | `FilesRevealPath` | – | – | 서버 키 `local` 세션만 |
| `clipboard.image` | `FilesReadClipboardImage` | – | – | 전부 |
| `notify.native` | 렌더러 HTML5 `Notification` + AUMID(7.4) | (Notification API로 대체) | (푸시, 13.6) | 전부 |
| `browser.pane` | upstream `browser` GUI 확장의 `browser.pane` Ipc(`PluginCall`·`PluginEvent`·`PluginAvailable`·`PluginSubscribe`, 끝점은 `PluginConfigure`, 탭 페이지는 `PluginEmbed`·`PluginCapture`, 8장). v2.0.24 전에는 `BrowserPane*` IPC | – | – | 전부(원격 세션은 8.6) |
| `service.control` | `window.own.service`(5.6) | – | – | 로컬 서비스 |
| `power.keepAwake` | 없음. v2.0.24에 upstream이 `AppSetKeepScreenActive`를 pairing GUI 확장으로 옮겼고 셸은 그 확장을 넣지 않는다(7.6, 8.1) | – | – | 기기 |
| `pair.device` | (M1) `own.remote` `devices.pair.*`(13.5) | (M1) 같음 | – | PC에서만 |

- **03에 더해 달라고 요청하는 capability**(17장): `fs.saveFile`(`FilesSaveFile`, 8.4의 `PC에 저장`과 내보내기), `window.multi`(여러 창, 7.2). 둘이 없는 호스트는 브라우저 다운로드와 창 하나로 떨어진다.
- 이 문서 v0.1에 있던 `touch`와 `offlineCatalog`는 capability가 아니다. 터치는 03대로 `(pointer: coarse)`로 보고, 세션 목록 캐시는 모든 모드가 가진다(01 §6.3).
- `server.connect()`의 `auth` 값은 03의 `"injected" | "cookie" | "basic"`을 쓴다. 게이트웨이를 거치는 모바일(M1)은 `"device"`가 더 필요하다(17장, 13.4).

**규칙.**
- UI 코드는 `host.kind === "desktop"`을 검사하지 않는다. `host.has("browser.pane")`처럼 capability만 본다. lint로 막는다(`kind` 비교는 `src/host/` 안에서만 허용, 03 §16.7).
- "서버 키 `local` 세션만" 표시된 capability는 **서버 키가 `local`인 세션**에서만 켠다. SSH 원격 세션의 파일을 로컬 탐색기로 열 수는 없다(04 §12.5).

### 6.3 T0 필수 호출

호출 이름은 03 §16.7의 것이다.

| 순서 | 호출 | 데스크톱 구현 | 빠뜨리면 |
|---|---|---|---|
| T0-0 | rpcHash 재검사(desktop host import 전) | `window.own.shell.rpcHash` ↔ own-web 빌드 상수(5.5) | 계약이 다른 셸에 IPC를 부른다 |
| T0-1 | `server.connect()` | `AppAwaitInitialization` → `{url}`(`shared/ipc-rpc/app.ts:12`) + `window.own.shell.controlDir`(5.6) | 서비스 URL과 control location을 모른다 |
| T0-2 | 저장된 세션 목록 캐시로 첫 화면 그리기 | 렌더러 IndexedDB(`oc://renderer` origin, 셸 userData 안. 01 §6.3이 기준) | 1초 예산(PF1) 위반 |
| T0-3 | `window.themeReady()` 첫 테마 페인트 직후 한 번 | `WindowThemeReady`(`ipc-rpc/window.ts`) | **두 번째 이후 창이 보이지 않는다**. 창은 `ready-to-show`와 theme ready가 모두 와야 `show()`된다(`windows/index.ts:157-172`) |
| T0-4 | `window.setTitlebar()`·`setBackgroundColor()` 첫 페인트와 테마 변경 때마다 | `WindowSetTitlebar{theme:{mode, scheme}}` + `AppSetBackgroundColor{color}` | WCO 버튼 색이 배경과 어긋나고, 다음 실행의 첫 창 배경이 틀린다(`windows/early.ts`가 저장된 배경색을 쓴다) |
| T0-5 | `openExternal(url)` 외부 링크마다 | `FilesOpenExternal`. http/https/mailto만 연다(`files/external-url.ts:3-8`) | 링크가 창 안에서 열리려다 막힌다(`windows/security.ts:22-32`) |
| T0-6 | 셸 시작 시각 mark | `window.own.shell.startedAt` → `performance.mark("own:shell-start", {startTime: startedAt − performance.timeOrigin})` | 03 §20.1 B1(= PF1)을 셸 프로세스 시작부터 잴 수 없다 |
| (선택) | 한국어 네이티브 문구 | `AppSetNativeTranslations` | 컨텍스트 메뉴 등이 영어 |
| (금지) | `AppFinishFirstLaunchOnboarding(true)` | – | `Documents\<기본 프로젝트>` 생성 |

- T0-1이 끝나기 전에도 T0-2와 T0-3은 할 수 있다. 서비스 준비를 기다리며 빈 창을 보이지 않는다.
- T0-2의 저장소: 01 §6.3은 IndexedDB를, 이 문서 v0.1은 localStorage를 적었다. IndexedDB로 맞춘다(03 §16.7 `storage`는 작은 설정용 localStorage 래퍼로 남는다). 첫 읽기는 진입 모듈이 host를 만들기 **전에** 시작하고(own-web `perf/prefetch.ts`), 데이터 층의 첫 `cache.read`가 그 결과를 받는다. PF1 측정(9.1)에서 목록이 첫 표시 프레임에 함께 들어왔으므로 localStorage 보조안은 두지 않는다(19장 23번 닫힘).
- 웹 구현: T0-0은 건너뜀, T0-1은 `location.origin`과 `auth:"cookie"`, T0-3·T0-4는 no-op(테마 preload 스크립트가 배경을 맞춘다), T0-5는 `window.open(url, "_blank", "noopener")`, T0-6은 `navigationStart` 기준.

### 6.4 인증 주입

| 모드 | 렌더러 origin | 로컬 서비스 | SSH 원격 서버 | 비고 |
|---|---|---|---|---|
| **데스크톱** | `oc://renderer` | 렌더러는 Authorization 없이 보낸다. main이 top frame + 렌더러 URL + 서비스 origin일 때만 Basic을 넣는다(`security.ts:42-53`, `sidecar-credentials.ts:26-29`) | own-web이 `own.remote.resolve`의 세션 토큰으로 Basic 헤더를 직접 붙인다(04 §12.1). main은 넣지 않는다: 주입 URL 패턴이 `127.0.0.1`·`localhost`뿐이고 origin도 서비스와 달라야 통과한다 | 쿠키 없음. main이 렌더러 session의 응답에 `Access-Control-Allow-Origin: *`(와 서버가 안 보냈으면 `Allow-Headers`, `Max-Age: 7200`)를 덮어쓴다(`windows/headers.ts:10-20`). 그래서 서버 `cors.ts:15`의 `oc://renderer` 허용은 데스크톱에서 쓰이지 않는다(01 §6.1) |
| 웹 폴백 | `http://127.0.0.1:28538` | pairing 쿠키(01 §6) | 같음(04 §12.1) | P-001/P-002 |
| 개발(데스크톱) | Vite origin(`ELECTRON_RENDERER_URL`) | main 주입. `isRendererUrl`이 dev origin을 허용(`scheme.ts:21-23`) | 같음 | 11.2 |
| 모바일(M1+) | 게이트웨이 origin | 기기 토큰 → 게이트웨이가 Basic으로 바꿔 전달 | 게이트웨이가 own-remote 서명 토큰을 넣음 | 기기는 서비스 비밀번호도 원격 토큰도 모른다(13.4) |

**데스크톱 규칙.**
- `baseUrl`은 절대 URL(`http://127.0.0.1:28538`)이다. `credentials:"omit"`, 사용자 정의 헤더 없는 GET으로 CORS 단순 요청을 유지한다(preflight 없음, `security.ts:35-37` 주석). 그래서 location은 헤더가 아니라 쿼리로 보낸다(01 §15와 같은 규칙).
- **API는 main document에서만 부른다.** Worker·SharedWorker·Service Worker의 요청은 frame이 없어 인증이 붙지 않는다(`security.ts:39-41` 주석). 마크다운·diff 워커는 API를 부르지 않는다.
- SSE는 `@opencode/client`의 fetch 스트리밍을 그대로 쓴다(인증 주입 대상).
- PTY WebSocket은 URL 패턴(`http://…`) 밖이라 주입되지 않으므로 upstream ticket 흐름을 쓴다(`packages/server/src/middleware/authorization.ts:81` 주석).
- 렌더러 메모리에 있는 비밀은 SSH 원격 세션 토큰뿐이다(04 §12.1과 같은 등급).
- **렌더러 CSP.** 데스크톱 렌더러는 IPC(MessagePort RPC)를 쓰고 main이 Basic을 넣어 주는 페이지다. 그런데 `oc://` 핸들러는 `Document-Policy` 헤더만 붙이고(`windows/protocol.ts:85-90`, `windows/headers.ts:1-2`) upstream 렌더러 `index.html`에도 CSP meta가 없다. 그래서 own-web `index.html`에 CSP meta를 둔다(데스크톱과 웹 폴백이 같은 빌드를 쓴다, 01 §6.1).
  - `script-src 'self' 'wasm-unsafe-eval' 'sha256-<oc-theme-preload-script 해시>'`: 서비스 WebUi CSP와 같은 규칙(`packages/cli/src/services/web-ui.ts:61-70`)
  - `connect-src 'self' http://127.0.0.1:* http://localhost:*` + 원격 호스트 끝점. CSP host-source는 IP 옥텟에 와일드카드를 쓸 수 없으므로 04 §7.3의 `k` 범위(1–250)대로 `http://127.0.<k>.2:*`를 빌드 때 나열한다 ⚠(meta 길이 약 6 KB, 19장).
  - `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`. 나머지 지시어는 WebUi CSP와 같게 둔다.
- **콘솔에 비밀을 쓰지 않는다.** upstream 로깅은 `spyRendererConsole:true`라서(`native/logging.ts:108`) 렌더러 콘솔 출력이 userData의 로그 파일로 복사된다. own-web은 원격 세션 토큰, `Authorization` 값, 기기 토큰, provider 오류 본문을 콘솔에 쓰지 않는다. G14 스캔을 셸 로그 폴더(userData `logs`)와 net-log까지 넓힌다(14.3 MG8, 17장 01 항목).

### 6.5 쓰지 않는 IPC

| IPC | 이유 |
|---|---|
| `Ssh*`(11개), `Wsl*`(13개), `Updater*`(4개) | v2.0.24에 IPC에서 빠져 GUI 확장이 됐고, 셸은 그 확장을 넣지 않는다(8.1). SSH는 04의 own-remote, WSL은 범위 밖(WSL sidecar는 `0.0.0.0`에 바인딩했다), 업데이트는 launcher |
| `PluginList`, `PluginEnable`/`Disable`/`Reload`, `PluginGuis`, `PluginMenubarItem(s)` | 플러그인 관리자, 창 쪽 번들, macOS 메뉴. own-web은 부르지 않고, 셸의 치환이 켜고 끄기를 어느 빌드에서도 거부하며(`builtin`·`unavailable`) 서비스 플러그인의 번들을 평가하지 않는다(8.1). v2.1에 설치형 압축 파일(`ExtensionInstall`/`Remove`/`Source`)은 upstream에서 없어졌다 |
| `AppConsumeInitialDeepLinks`, `DeepLinksOpened`, `MenuRunAction`, `MenuCommandTriggered` | 딥 링크·네이티브 메뉴 없음(Windows에서 upstream은 앱 메뉴를 만들지 않는다, `native/menu.ts:25`. 우리는 비운다, 7.7) |
| `StorageItems/Update/Clear`, `Drafts*` | own-web은 IndexedDB·localStorage로 충분하다([verdict] §3). 저장 실패에도 동작해야 한다(03 §16.7 `storage`) |
| `AppGetDefaultServerUrl`, `AppSetDefaultServerUrl` | 서버 목록은 own-web과 own-remote가 관리(04 §12) |
| `AppPairInfo`, `AppPairCode` | upstream LAN pairing. 기기 페어링은 13.5 |
| `AppIsFirstLaunchOnboardingPending`, `AppFinishFirstLaunchOnboarding` | 온보딩은 own-web이 자체로 한다. `true`로 부르면 Documents에 폴더가 생긴다 |

- lint: own-web에서 위 태그 이름과 `finishFirstLaunchOnboarding`을 부르는 코드를 막는다.

### 6.6 구현 위치

- `packages/own-web/src/host/{types,web,desktop,index}.ts`. `index.ts`는 `window.electron`이 있으면 `desktop.ts`를 **dynamic import**하고, 없으면 `web.ts`를 쓴다. 웹 번들 첫 chunk에 데스크톱 코드가 들어가지 않는다.
- `desktop.ts`는 `@opencode/desktop/src/renderer/ipc-client.ts`를 deep import한다(상대 경로, `api.ts`는 쓰지 않음). 브라우저 패인은 같은 클라이언트로 `PluginCall` 등을 부르는 어댑터(`browserPane`, 8.2)다. 타입 검사를 위해 own-web tsconfig에 `../app`, `../desktop` project reference를 더한다(타입 전용).
- **vendor하지 않는 이유.** 셸과 렌더러가 같은 커밋의 계약 코드로 빌드되어야 rpcHash가 의미를 가진다. 복사본은 바로 그 계약을 두 벌로 만든다. 그래도 `@opencode/app` 타입 참조가 부담이면 세 파일(약 11 KB)을 vendor하는 대안이 있다(19장). 원장 항목은 `deep-import`다(4.7).
- lint: `@opencode/desktop` import는 `src/host/desktop.ts`(와 그것이 import하는 `src/host/` 파일)에서만 허용한다. 01 §6.2와 03 §16.7이 이미 같은 예외를 둔다.
- rpcHash 상수(16자)는 own-web 진입 모듈에 둔다(5.5). desktop host chunk는 T0-0이 통과한 뒤에만 불러온다.

---

## 7. 창과 셸 UX

### 7.1 WCO 타이틀바

- 창은 테두리가 없고(`frame:false`, `titleBarStyle:"hidden"`), OS가 오른쪽 위에 창 버튼을 그린다(`windows/early.ts:54`, `appearance.ts:31-33`). 밴드 높이는 44 px × 확대 배율이다(`windows/defaults.ts:13,33`).
- own-web 셸 규칙
  - 맨 위 밴드는 CSS `env(titlebar-area-x | y | width | height)`로 잡고 `-webkit-app-region: drag`를 둔다. 버튼, 입력, 탭, 칩은 `no-drag`다.
  - 오른쪽 창 버튼 영역(`100vw - titlebar-area-x - titlebar-area-width`)에는 아무것도 두지 않는다. 03 §4.1의 오른쪽 패널 토글과 세션 헤더 버튼은 이 영역을 피한다.
  - 화면 크기가 100%가 아니면 창 버튼 바로 왼쪽 52px에 배율 표시(`110%`, 7.9, 03 §4.2.1)를 둔다. 밴드의 줄(세션 헤더, 작업 패널 머리줄, 설명서 막대)은 그 자리도 비운다(`--own-wco-right` = 창 버튼 + 52px).
  - 03 §4.1의 세션 헤더(52 px)를 데스크톱에서는 타이틀바 밴드와 겹쳐 쓴다(한 줄). 사이드바 머리(검색, 새 세션)도 같은 밴드에 둔다. 웹 모드는 밴드가 없다(`env()` 값이 없으면 0).
  - 밴드를 두 번 누르면 최대화된다(OS 기본). 드래그 영역은 IME 입력과 무관하다.
- 테마가 바뀌면 T0-4로 창 버튼 색과 배경색을 맞춘다.

### 7.2 창 수명주기

- **닫기 ≠ 턴 중지.** 마지막 앱 창의 X는 기본으로 창을 트레이로 숨기고 앱은 계속 돈다(7.3). `창을 닫으면: 앱 종료`를 고르면 upstream대로 창을 모두 닫을 때 앱이 끝난다(`lifecycle/index.ts:108-110`). 어느 쪽이든 서비스는 detached라 진행 중인 턴은 계속 돈다(5.1). 다음 실행 때 세션 목록과 결과가 그대로 보인다. → G-D3.
- **단, 브라우저 도구는 끊긴다.** 창이 닫히거나 다시 로드되면 그 창의 브라우저 attachment가 닫히고(`gui-plugins/src/browser/pane.ts:130-131`, `destroyed`와 top frame `did-start-navigation`), 에이전트의 진행 중 브라우저 동작은 `[browser.disconnected]` 오류가 된다(`plugin-browser/src/connection.ts:205`). 그래서 실행 중인 세션이 브라우저 탭을 가지고 있으면 창을 닫거나 다시 로드할 때 확인한다: `에이전트가 브라우저를 쓰는 중이에요. 창을 닫으면 브라우저 탭이 닫히고 브라우저 동작은 실패해요. 턴 자체는 계속돼요.`
- **닫기 확인의 구현.** upstream에는 닫기 확인이 없다(`windows/*`에 `will-prevent-unload` 처리 없음).
  - 렌더러: own-web은 "실행 중 세션이 이 창에서 브라우저 attachment를 가지고 있음"일 때만 `beforeunload` 처리기를 등록하고, 조건이 풀리면 바로 지운다. 처리기가 없으면 닫기·다시 로드는 확인 없이 진행된다(평소 비용 0).
  - main: vendor한 `desktop.ts`가 `browser-window-created`로 렌더러 창의 `webContents`에 `will-prevent-unload`를 붙인다. Electron은 `beforeunload`가 막으면 기본으로 **조용히** 닫기를 취소하므로, main이 `dialog.showMessageBoxSync(win, …)`로 위 문구와 [창 닫기] [취소]를 보이고, [창 닫기]면 `event.preventDefault()`로 unload를 진행시킨다(⚠ Electron 문서의 동작, G-D3에서 확인).
  - 경로별: 제목 줄의 닫기 버튼(WCO)과 `Alt+F4`는 창 `close` → `beforeunload`를 거친다. 트레이로 숨기는 닫기(7.3)는 `close`에서 멈추고 아무것도 unload하지 않으므로 이 확인을 거치지 않는다: 숨긴 창의 브라우저 탭과 턴은 그대로다. `Ctrl+W`, `Ctrl+R`은 앱 메뉴를 비우므로 더 이상 창을 닫거나 다시 로드하지 않는다(7.7). 앱 종료(`before-quit`)와 로그오프(`session-end`)는 확인하지 않는다. 로그오프를 대화상자가 막으면 안 되기 때문이다(⚠ `session-end` 때 `beforeunload`가 불리는지 G-D3에서 확인).
- **여러 창.** upstream은 여러 창과 창 목록 복원을 지원한다(`windows/registry.ts`, `lifecycle/index.ts:146-153`). own-web은 창 하나에 **분할 4개까지**(03 §4.1.1) 세션 여러 개를 연다(2026-10-10까지는 창 하나에 세션 하나). URL은 포커스 분할의 세션이다. 한 창 안에서 한 세션은 채팅 분할 하나에만 보인다. 같은 세션을 두 창에서 열면 브라우저 attachment는 나중 창이 가져가고 앞 창은 `replaced`가 된다(`connection.ts:59`, 8.2).
- **연결 수.** Chromium은 호스트당 HTTP/1.1 연결을 6개로 묶는다. 렌더러 창들은 같은 session(파티션)을 쓰므로 창마다 SSE 1개씩이 로컬 서비스 연결 한도를 나눠 쓴다. 창을 여럿 열면 일반 요청이 막힐 수 있다. **창은 3개까지 권장**하고 4번째부터 경고한다. 분할은 연결을 늘리지 않는다: 창 안의 분할들은 서버마다 하나인 이벤트 스트림(프레임마다 묶음, own-web `data/events.ts`)과 참조 카운트한 세션 구독을 나눠 쓴다. ⚠ 실제 한도와 영향은 PF3·PF4 측정 때 창 3개 조건으로 함께 잰다(14.2). SSH 원격 서버는 호스트(`127.0.<k>.2`)가 달라 한도를 따로 쓴다(04 §12.1).
- **로그오프·종료.** Windows는 로그오프 때 `before-quit` 없이 `session-end`를 보낸다. upstream이 처리하고(`windows/index.ts` register), `windows-own.ts`도 이때부터 모든 닫기를 그대로 통과시킨다(트레이로 숨기지 않는다, 7.3).

### 7.3 트레이와 종료 (구현, TQ 2026-10-18)

사용자 요청(2026-10-18): "프로그램을 완전히 끄는 메뉴가 없어요. 서버가 뒤에서 돌고 있으니, X를 누르면 알림 영역(시계 옆 작은 아이콘)으로 들어가고, 거기서 두 번 누르면 창이 다시 열리고, 오른쪽 클릭에 완전 종료가 있어야 해요. 앱 안에도 있어야 해요." 결정 기록은 `own/handoff/decisions-2026-10.md` "Tray and quit (TQ, 2026-10-18)"이다.

- **방식.** 이전 판의 (b)안 그대로다. `lifecycle/index.ts` 치환((a)안)은 하지 않는다. upstream 파일은 고치지 않는다.
  - `src/main/quit-model.ts`(Electron 없는 판단: 닫기 결과, 아이콘 크기, 툴팁, 메뉴, 완전 종료 대화상자 문구)와 `src/main/quit.ts`(트레이, 닫기 동작 저장, 종료 흐름, IPC 처리기). vendor한 `desktop.ts`가 첫 창 뒤(크래시 리포터와 같은 때) 트레이를 만들고 `will-quit`에 지운다. 창 닫기는 `windows-own.ts`의 `close` 처리기가 정한다.
- **X(마지막 창의 닫기).** `close` 처리기는 이 순서로 본다.
  1. `before-quit` 또는 `session-end`가 왔으면(앱 종료, 로그오프, Windows 종료) 그대로 닫는다. 트레이는 종료를 막지 않는다.
  2. 닫기 동작이 `tray`(기본)이고, 이 창이 upstream의 앱 창(`getMainWindows()`)이며, 지금 보이고, 다른 앱 창이 보이지 않으면 `preventDefault()` + `hide()`. 렌더러·턴·브라우저 탭은 그대로라 7.2의 닫기 확인을 묻지 않는다. 최소화된 창도 "보이는" 창이다.
  - **최소화한 창(MBR, 2026-11-21).** Windows에서 Electron은 최소화한 창을 `isVisible() === false`로 답하므로, 작업 표시줄의 `창 닫기`로 최소화한 마지막 창을 닫으면 앱이 끝났다. 이제 최소화한 창도 "보이는" 창으로 보고 트레이로 숨긴다. 최소화한 채 숨긴 창도 `isMinimized`가 참으로 남으므로 셸은 트레이로 보낸 창을 따로 기억한다(`quit.ts` `hiddenToTray(win)`).
  3. 그 밖(다른 앱 창이 보임, 동작이 `quit`, 원격 PC·모바일 미리보기 창)은 지금처럼 닫는다. 이미 숨겨진 창에 온 닫기(`WM_CLOSE`: Windows 다시 시작 관리자, `/f` 없는 `taskkill`)는 사용자의 X가 아니므로 닫고, 마지막 창이면 upstream의 `window-all-closed`가 앱을 끝낸다.
  - 처음 트레이로 숨길 때 한 번만 트레이 풍선(Windows 알림)을 띄운다: `창을 닫아도 트레이(작업 표시줄 오른쪽 알림 영역, 안 보이면 ^)에서 계속 돌아요. 끄려면 아이콘을 오른쪽 클릭해 완전 종료를 고르세요.` 조용한 시간(집중 지원)을 따른다. 띄웠다는 표시는 셸 설정 저장소(`userData\opencode.settings`의 `ownTrayHintShown`)에 둔다. 앱 안 안내가 아니라 OS 알림인 이유: 이때 창은 막 숨었다.
- **트레이 아이콘.** 앱 아이콘 PNG(`resources/icons`, 패키지에서는 `app.asar` 안)를 주 디스플레이 배율에 맞는 정확한 픽셀(100 % 16, 125 % 20, 150 % 24, 175 % 28, 200 % 32)로 줄여 쓴다. Electron은 ICO가 아닌 이미지를 그 크기 그대로 Windows에 넘기므로(`NativeImage::GetHICON`) Windows가 다시 늘리지 않는다. 배율이 바뀌면(`display-metrics-changed`) 다시 만든다.
  - 툴팁: `Own OpenCode` 다음 줄에 `서비스 실행 중`, `서비스 실행 중 · 대화 N개 진행 중`(`GET /api/session/active`), `서비스 꺼짐`. 아이콘에 마우스가 들어올 때와 오른쪽 클릭 때 읽는다(2초에 한 번까지, 상시 폴링 없음).
  - 클릭과 두 번 클릭 모두 마지막으로 포커스한 앱 창(없으면 다른 앱 창)을 보이고 포커스한다. 앱 창이 하나도 없으면(닫기 동작 `quit`에서 원격 PC 창만 남은 경우) 새 창을 만든다. Windows 앱은 한 번 클릭으로 여는 것이 관례이고, 두 번 클릭은 두 번째 누름이 이미 열린 창을 만날 뿐이다.
  - 앱이 트레이에 있을 때 시작 메뉴로 다시 실행하면(두 번째 인스턴스) 숨긴 창을 보인다(upstream `second-instance`가 마지막 포커스 창을 모를 때도).
- **오른쪽 클릭 메뉴.** Windows 메뉴는 보조 글을 보이지 않으므로 앱 종료의 뜻을 이름에 넣는다.

| 항목 | 동작 |
|---|---|
| `열기` | 위의 클릭과 같다 |
| (구분선) | |
| `앱 종료 (서비스는 계속 실행)` | 셸만 끝낸다(`app.quit()`). 묻지 않는다. 서비스는 휴대폰·다른 PC·SSH 중계와 실행 중인 대화를 계속 맡는다 |
| `완전 종료…` | 아래 대화상자를 먼저 보인다 |

  - `새 창`은 두지 않는다. own-web은 창 하나에 분할 4개로 세션을 여러 개 연다(`capabilities.multiWindow: false`, 7.2 "여러 창"·"연결 수").
  - 두 종료를 모두 둔다. X가 트레이로 가므로 "앱만 끄고 서비스는 남기기"(메모리를 비우되 휴대폰은 계속)가 메뉴에 없으면 그 동작을 할 길이 없다. 완전 종료 대화상자도 `앱만 종료`를 함께 보인다.
- **완전 종료.** 셸이 서비스의 자기 종료 경로로 멈춘다: `own.ps1 stop --force`(5.3과 같은 launcher 실행: 스냅샷 env, 닫힌 stdin, windowsHide, 타임아웃 60초) → launcher `Invoke-Stop` → 설치된 `opencode.exe service stop`(등록 파일의 pid만 멈춘다). 셸이 프로세스를 직접 죽이지 않는다.
  1. 등록 파일로 서비스를 찾는다(5.3 2단계). 없으면 묻지 않고 앱만 끝낸다.
  2. 대화상자(`완전 종료할까요?`, 버튼 `완전 종료` `앱만 종료` `취소`, 기본·Esc는 `취소`). 본문은 멈추는 것을 적는다: `앱과 이 PC의 백그라운드 서비스를 모두 꺼요.`, 실행 중인 대화가 있으면 `· 실행 중인 대화 N개가 멈춰요. 다음에 앱을 열면 이어서 돌지만 캐시는 새로 쌓여요.`(수를 못 읽으면 "있으면"), 원격 접근이 켜져 있으면(`OWN_HOME\gateway.json`의 게이트웨이나 앱 연결) `· 휴대폰과 다른 PC의 연결이 끊겨요.`, 끝에 `서비스는 두고 앱만 끄려면 [앱만 종료]를 누르세요.` 실행 중인 대화는 종료 중단 규칙대로 실행 claim이 남고 다음 시작 때 복구가 이어 돌린다(`opencode service stop`은 Windows에서 프로세스를 끝내므로 "프로세스 종료" 쪽이다. 둘 다 claim을 남긴다).
  3. `완전 종료`: 앱 창을 먼저 숨기고(셸이 끝난 것처럼 보이게), launcher 시작을 막은 뒤(`holdStarts`: 창들이 끊김을 보고 다시 붙으려 할 때 5.3 4단계가 서비스를 다시 켜지 않게) `stop --force`를 돌린다. 성공하면 `app.quit()`. 실패하면 막음을 풀고 창을 다시 보이고 `서비스를 끄지 못했어요` + stderr 끝 + [앱만 종료] [취소].
  - **이 앱이 끄지 않는 서비스.** 개발 채널(`service-local.json`), 설치된 버전이 아닌 서비스(raw exe, 다른 설치·다른 버전: 01 §5.4 가드 2의 판정과 같다), launcher가 없을 때는 대화상자가 그 이유와 `앱만 종료` `취소`만 보인다(`개발 서비스는 끄지 않아요`, `이 서비스는 끄지 않아요` … `끄려면 PowerShell에서 own stop을 실행하세요`, `서비스를 끌 수 없어요` + 경로).
  - 한 번에 하나만 돈다. 트레이와 앱 안에서 겹쳐 눌러도 같은 흐름이다.
- **앱 안(own-web, `capabilities.appQuit`).** `window.own.app`(5.6)으로 같은 두 종료와 닫기 동작을 부른다. 완전 종료의 대화상자는 셸의 것이다.
  - 사이드바 맨 아래 `이 PC · 연결됨` 팝오버 아래 줄: `앱 종료`, `완전 종료…`.
  - `설정` > `데스크톱 앱` 맨 위: `창을 닫으면` [`트레이로 숨기기`(기본) | `앱 종료`]와 `종료` 줄의 두 단추.
  - 명령 팔레트 묶음 `앱`: `앱 종료`(서비스는 계속 실행), `완전 종료…`(이 PC의 서비스도 끔).
  - `Ctrl+Q`(`app.quitAll`, 03 §10): 완전 종료 대화상자를 연다. 기본 단추가 `취소`이고 `앱만 종료`도 있어 잘못 눌러도 아무것도 멈추지 않는다. 키맵 검사에서 맥의 ⌘Q(OS 종료)는 이 id에만 허용한다. 터미널 안에서는 터미널의 키다.
- **자동 시작.** 바뀌지 않는다. 로그온 자동 시작은 없다(`own logon`은 stub, DS3).
- **메모리.** 숨긴 창은 렌더러가 살아 있어 알림은 계속 오지만 메모리를 쓴다(⚠ 크기는 SC5에서 잰다). 이 비용을 받아들여 기본값을 `트레이로 숨기기`로 했다(사용자 요청). 끄려면 `앱 종료`.
- **시험.** `test/tray-quit.test.ts`(판단과 문구, 메뉴 항목, launcher 명령, 배선), `scripts/tray-quit.ts`(개발 셸 `out/`을 임시 userData로 띄워 실제 트레이와 종료를 돌린다. 트레이 클릭은 셸의 알림 아이콘 호스트 창에 Windows가 보내는 메시지로 보내고 작업 표시줄은 건드리지 않는다. 오른쪽 클릭 메뉴는 마우스 자리에 뜨므로 돌리지 않는다. 서비스는 같은 프로세스의 대역이고 launcher는 저장소의 `own.ps1`과 가짜 `opencode.cmd`다).
  - 개발 셸 전용 시험 훅(`!app.isPackaged`): `OWN_DESKTOP_TEST_RUN=<pid>`이면 모든 창을 화면과 작업 표시줄 밖에 두고 그 프로세스가 사라지면 셸이 스스로 끝난다. 함께 `OWN_DESKTOP_TEST_ANSWER=<파일>`이면 완전 종료의 질문을 대화상자 대신 파일의 단추 이름으로 답하고 질문은 로그에 남긴다(Windows는 화면 밖 창의 대화상자도 모니터 안에 띄운다). 시험이 사용자 화면에 아무것도 띄우지 않기 위해서다.

### 7.4 알림

- **방식.** 렌더러의 HTML5 `Notification`을 쓴다. 권한은 렌더러 origin에만 허용된다(`windows/security.ts:6-19`의 `notifications`). Windows toast는 AUMID `dev.own.opencode.desktop`(`configure.ts:22`)로 묶인다.
- **바로가기 필요.** Windows 데스크톱 앱의 toast는 같은 AUMID를 가진 시작 메뉴 바로가기가 있어야 안정적으로 뜬다. NSIS 설치기가 만드는 바로가기에 appId가 AUMID로 들어가는지 ⚠(G-D4). 개발 빌드(바로가기 없음)는 OS 알림이 안 뜰 수 있고, 그때는 앱 안 toast만 쓴다.
- **언제.** 03 §9 표의 "OS 알림" 열을 따른다. 조건은 창이 포커스를 잃었거나 최소화·숨김일 때이고, 지금 보고 있는 세션의 사건은 OS 알림을 내지 않는다. 같은 세션의 같은 종류는 10초 안에 합친다.
- **클릭.** `notification.onclick` → `host.window.show()` + `focus()` → 라우트 `/srv/<serverKey>/s/<sessionID>`. 해당 창이 없으면 마지막 포커스 창에서 연다.
- **하지 않는 것.** toast에 `승인`, `보내기` 같은 동작 버튼을 두지 않는다. 알림은 세션을 여는 것까지만 한다. 이전 앱도 같은 원칙이었다([old] `docs/design/workspace-notifications-40.md`: "No toast action approves a request or submits a model prompt").
- **내용.** 03 §9 문구(세션 제목 + 사건). 모델 출력, 프롬프트, 경로, 비밀은 넣지 않는다.
- **셸이 꺼져 있을 때.** 창을 트레이로 숨긴 동안은 셸과 렌더러가 살아 있어 알림이 그대로 온다(7.3, 기본). `앱 종료`·`완전 종료` 뒤에는 알림이 없다(모바일 푸시 13.6이 채운다). 앱이 끝난 뒤 남은 toast를 누르면 무엇이 되는지 ⚠(G-D4 부가 항목).
- **toast activator(구현).** 셸은 ready 전에 `app.setToastActivatorCLSID`로 **고정 CLSID**를 준다(패키지 `{410CC5B4-2B31-47C3-BBEE-352837898B52}`, 비패키지 개발 셸은 따로 `{735A737E-1B82-4E37-BD34-29DA1E5FF76D}`, `src/shared/identity.ts`). 주지 않으면 Electron이 실행마다 무작위 CLSID를 만들고, 첫 toast 때 `HKCU\Software\Classes\CLSID\{…}`("Electron Notification Activator", LocalServer32 = exe)와 AUMID·CLSID를 담은 시작 메뉴 바로가기(없을 때)를 등록한다(G-D4에서 관찰). 고정 id라 키가 하나뿐이고 제거기가 지울 수 있다(10.4). 테스트 실행은 이 키의 LocalServer32를 기록했다가 자기가 바꿨으면 되돌린다(`scripts/run-kit.ts`).
- **턴 완료(구현).** own-web `src/shell/notifications.tsx`: 최상위 세션의 `session.execution.succeeded|failed` 때 창이 숨겨져 있으면(또는 다른 앱이 앞이고 그 세션이 화면에 없으면) `{세션 제목} — 응답 완료|응답 실패`, tag `own:turn:<serverKey>:<sessionID>`. 사용자가 멈춘 턴(`interrupted`)과 하위 에이전트 세션은 알리지 않는다.

### 7.5 네이티브 파일 기능

모두 **서버 키가 `local`인 세션**에만 쓴다(6.2).

| 기능 | IPC | own-web 쓰임 | 웹 폴백 |
|---|---|---|---|
| 폴더 선택 | `FilesOpenDirectoryPicker` | 로컬 프로젝트 열기([gap] #3). 고른 경로는 `GET /api/location`으로 정규화한 뒤 쓴다(03 §16.3) | 경로 입력 + `fs.list` 선택기(control location, 절대 경로) |
| 실제 경로 드래그 | `window.electron.getPathForFile` | 첨부를 경로로 보내기([gap] #10) | 파일 업로드 |
| 클립보드 이미지 | `FilesReadClipboardImage` | 쓰지 않음(2026-11-22에 `클립보드 이미지` 버튼을 뺐다). 셸에서도 `paste` 이벤트로 붙인다: `Ctrl+V`, 오른쪽 클릭 메뉴(`electron-context-menu`)의 `붙여넣기` | `paste` 이벤트 |
| 에디터로 열기 | `FilesOpenPath(path, app)`, `AppCheckAppExists`, `AppResolveAppPath` | [gap] #21. `vscode://` 링크는 쓸 수 없다: `FilesOpenExternal`은 http/https/mailto만 연다(`files/external-url.ts:3-8`) | `vscode://file/<path>:<line>` 링크 |
| 탐색기에서 보기 | `FilesRevealPath` | 파일 메뉴. 2026-11-21부터 own-web은 `explorer` 플러그인 Ipc(7.10)를 쓰고, 그것이 없는 이전 셸에서만 이것으로 간다 | 없음 |
| 저장 대화상자 | `FilesSaveFile`(capability `fs.saveFile`, 03에 추가 요청) | 내보내기, 브라우저 다운로드 "PC에 저장"(8.4) | 브라우저 다운로드 |

- SSH 원격 파일을 VS Code Remote로 여는 것(`vscode-remote://ssh-remote+<alias>/…`)은 위 제약 때문에 upstream IPC로 할 수 없다. own IPC 확장이 필요하다(19장).

### 7.6 절전 방지

- **v2.0.24(f406d93a66)**: upstream이 이 토글을 pairing GUI 확장(`packages/gui-extensions/src/pairing`, 저장소 `keepScreenActive`)으로 옮겼다. 셸은 pairing을 넣지 않으므로(8.1) 데스크톱 호스트의 `keepScreenAwake`는 없다. 아래는 그 전 upstream 구현(같은 `powerSaveBlocker` 방식)의 분석이고 결론(서비스 쪽 (a))은 그대로다.
- upstream의 `AppSetKeepScreenActive`는 `powerSaveBlocker.start("prevent-display-sleep")`다(`native/screen-activity.ts:14`). Electron 문서로는 이 모드가 화면과 **시스템을 모두** 깨어 있게 한다(⚠ 외부 사실). 그러니 "화면만 막는다"는 이 문서 v0.1의 설명은 틀렸다.
- 모자란 점은 모드가 아니라 **묶임**이다.
  - 사용자가 켜고 끄는 토글이고, 턴이 도는지와 무관하다(`screen-activity.ts:12-19`, 설정 저장소에 기억).
  - 셸 main이 살아 있을 때만 동작한다. 앱을 끝내면(7.2·7.3) 서비스의 턴은 계속 돌지만 보류는 풀린다.
  - 필요한 것은 "턴이 도는 동안 시스템 절전 막기"다([gap] #36, 01 §17.1의 34–42 묶음이라 나중 범위).
- 턴은 서비스에서 돌므로 백엔드 우선 규칙대로 서비스가 맡는 것이 맞다. 선택지(⚠ 설계만, 결정은 19장).
  - **(a) own-runtime의 Bun FFI(권장).** 실행 중 세션이 1개 이상인 동안 own-runtime이 `kernel32!SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)`를 부르고, 0개가 되면 `ES_CONTINUOUS`로 푼다. 이 상태는 **부른 스레드**에 붙으므로 수명이 긴 JS 스레드에서 불러야 한다. 새 프로세스와 프로토콜 변경이 없다. Bun FFI가 Windows에서 이 호출을 안정적으로 하는지는 확인하지 않았다 ⚠.
  - **(b) own-vault helper에 보류 명령 추가(기각 쪽).** helper는 서비스 수명 동안 도는 자식이 아니라 **참조 카운트가 0이 되면 끝나는** 프로세스다(`own/native/own-vault/README.md` §2 "수명"). 턴 동안 helper 참조를 하나 잡아 두는 방식은 가능하지만, helper는 README 머리말에서 자기를 "비밀 저장소 helper"(DPAPI로 계정 비밀을 `vault\`에 저장)로 정의하고 "하지 않는 일"(네트워크, 로깅, vault 밖 파일 접근, refresh)을 못 박았다. 전원 관리를 얹으면 이 범위가 넓어지고 wire 계약(`PROTOCOL` 번호)도 바뀐다. 비밀 helper에 무관한 일을 얹지 않는다.
  - **(c) 셸 main의 `powerSaveBlocker.start("prevent-app-suspension")`(보조).** 셸이 떠 있을 때만 된다. (a)가 안 될 때의 임시안이다.
- 원격 접근(M1)을 켜면 "원격 접근 중 절전 방지" 선택을 둔다. PC가 자면 기기에서 붙을 수 없다(13.7). 이것도 (a)와 같은 자리에서 한다.

### 7.7 단축키와 기본 메뉴

- **소스로 확인한 사실.** upstream의 `createMenu`는 macOS가 아니면 곧바로 돌아가고(`native/menu.ts:25`), `Menu.setApplicationMenu`를 부르는 곳은 그 함수 안 하나뿐이다(`menu.ts:38`, `src/main` 전체 검색). 그래서 패키지된 Windows 빌드에도 Electron **기본 앱 메뉴**가 그대로 남는다. 창이 테두리 없어 메뉴 막대는 보이지 않지만, 기본 메뉴의 역할 accelerator는 동작한다(Electron 문서 기준: `Ctrl+R` 다시 로드, `Ctrl+Shift+I` 개발자 도구, `Ctrl+W` 창 닫기, `Ctrl+M` 최소화, 확대·축소 ⚠ 외부 사실).
- **그대로 두면 생기는 문제.**
  - `Ctrl+W`는 창을 닫는다. v0.1처럼 닫기 확인을 구현하지 않으면 브라우저를 쓰는 중에도 확인 없이 닫히고, 03 §10이 데스크톱 `Ctrl+W`를 터미널 탭 닫기에 쓰는 것과도 부딪힌다.
  - `Ctrl+R`은 다시 로드라서 그 창의 브라우저 attachment를 모두 닫는다(`gui-plugins/src/browser/pane.ts:130-131`).
  - 확대 역할은 `setZoomFactor`/`updateTitlebar` 경로(`windows/appearance.ts:95-98`, `ipc-handlers/window.ts:27-32`)를 거치지 않아 WCO 밴드 높이가 배율과 어긋난다.
  - 패키지 빌드에서도 `Ctrl+Shift+I`로 개발자 도구가 열린다.
- **결정.** vendor한 `index.ts`의 `whenReady` 안(첫 창 앞)에서 Windows일 때 `Menu.setApplicationMenu(null)`을 부른다. 비패키지(dev) 빌드만 `Ctrl+Shift+I`(개발자 도구) 하나를 가진 최소 메뉴를 둔다. 복사·붙여넣기·실행 취소는 Windows에서 메뉴 역할 없이 Chromium이 처리한다고 보고, G-D3에서 composer로 확인한다 ⚠.
- **단축키는 03 §10이 기준이다.** 이 문서 v0.1의 "키맵 하나, 데스크톱에서도 `Ctrl+N`·`Ctrl+W`를 쓰지 않음"은 03 §10과 어긋나므로 버린다. 03은 데스크톱에서 `Ctrl+N`(새 세션)과 `Ctrl+W`(터미널 탭에 포커스가 있을 때만)를 받는다. 메뉴를 비우면 이 키들이 창 동작에 먹히지 않는다.
- **확대는 호스트 capability `window.zoom`이다(03 §10·§16.7).** 데스크톱 구현은 `window.own.zoom`(7.9)이다. main이 배율을 바꿀 때 창 버튼 overlay 높이도 배율에 맞춘다(치환한 `appearance.ts`의 `updateTitlebar`, `windows/defaults.ts:33`). upstream 렌더러의 `renderer/window/zoom.ts`는 가져오지 않는다(03 §4.2.1).
- 게이트: G-D3 시나리오에 `Ctrl+W`, `Ctrl+R`, `Alt+F4`, `Ctrl+Shift+I`(패키지)를 더한다(14.1).

---

### 7.8 마이크 (음성 입력, VOICE)

음성 입력(02 §3.9, 03 §4.6)은 own-web 페이지가 녹음하고 이 PC 서비스가 인식한다. 키는 서비스(vault)에만 있고 렌더러·휴대폰·다른 PC 창에는 가지 않는다. 그래서 각 호스트가 해 줄 일은 **페이지에 마이크(오디오만)를 허락하는 것** 하나다. 카메라·화면 캡처는 어디서도 허락하지 않는다.

| 호스트 | 허락하는 곳 | 방법 |
|---|---|---|
| 데스크톱 앱(own-desktop) | 렌더러 창의 own-web(`oc://renderer`, 개발 중에는 `ELECTRON_RENDERER_URL`의 origin) | v2.2부터 upstream `windows/security.ts`가 직접(main frame, 오디오만. 그 전에는 own 치환, 4.3). Electron은 요청을 묻지 않고 처리기가 바로 답하므로 앱 안 확인 창은 없다. Windows의 `설정 > 개인 정보 > 마이크 > 데스크톱 앱이 마이크에 접근하도록 허용`이 꺼져 있으면 녹음이 실패하고 own-web이 그 경로를 안내한다(`NotAllowedError`·`NotReadableError`) |
| 원격 PC 창(08 §4.1) | 그 PC의 app origin(`https://<pcKey>.ownpc.internal`, pin으로 붙은 partition)만 | `remote-pcs/partition.ts`의 요청·확인 처리기에 같은 판정(`audioOnlyRequest`/`audioOnlyCheck`)과 `sameOrigin(…, pcKey)`. 받아쓰기는 그 PC의 서비스가 그 PC의 음성 키로 한다 |
| 웹(브라우저), 휴대폰 PWA | 브라우저가 처음에 묻는다(사이트별) | 마이크는 보안 컨텍스트에서만 된다. PC의 웹 폴백은 loopback(`http://127.0.0.1`)이라 되고, 휴대폰은 `tailscale serve`의 HTTPS(13.4)라 된다. 거부하면 own-web이 주소창의 사이트 설정을 안내한다 |
| Android 앱(`packages/own-android`, 08 §4.2) | PC WebView의 app origin만 | 매니페스트 `RECORD_AUDIO`와 `MODIFY_AUDIO_SETTINGS`(WebView 오디오 캡처에 필요, 묻지 않는 권한). `PcActivity`의 `WebChromeClient.onPermissionRequest`가 `MicPermission.grantable`(origin이 `https://<app host>`이고 요청한 자원이 `RESOURCE_AUDIO_CAPTURE`뿐)일 때만 허락하고, 처음이면 Android 권한 창(`requestPermissions`)을 띄운 뒤 결과대로 `grant`/`deny`. 다른 자원(비디오, MIDI, 보호된 미디어)과 다른 origin, 막힌 화면(`blocked`)은 거부. 화면을 닫으면 기다리던 요청은 거부 |

- 녹음은 사용자가 마이크 단추나 `Ctrl+Alt+V`를 눌렀을 때만 시작한다(03 §4.6). own-web은 녹음을 메모리에만 두고, 보내거나 취소하면 버린다.
- 확인하지 못한 것 ⚠: 실제 Android 기기(WebView가 `onReceivedSslError`의 pin 통과 뒤에도 getUserMedia를 허락하는지)와 iOS Safari PWA(`audio/mp4` 녹음)는 이 PC에서 돌려 보지 못했다. 데스크톱은 빌드 산출물 검사와 단위 시험까지다.

### 7.9 화면 크기 기억 (ZL, 2026-10-18)

사용자 요청: `Ctrl`+`+`/`-`로 바꾼 크기를 기억하고, 100% 기준 배율을 어딘가에 보이고 거기서도 바꾸게 해 달라.

- **원인.** 2026-10-18 전에는 own-web의 `Ctrl+=`/`Ctrl+-`/`Ctrl+0`이 upstream `WindowSetZoomFactor`로 그 창에만 배율을 걸었다. Chromium은 배율을 호스트(`oc://renderer`)마다 자기 Preferences(`partition.per_host_zoom_levels`)에 남기지만, upstream `windows/appearance.ts`의 `wireZoom`이 새 창마다 `setZoomFactor(1)`을 불러, 시작할 때 넘겨받는 첫 창(이미 Chromium이 복원한 배율로 그려진 창)을 매번 100%로 되돌렸다. `Ctrl`+휠(`zoom-changed`)도 핀치 줌이 꺼져 있으면 100%로 되돌렸다. Electron 44.4.5에서 확인한 것: 첫 커밋 전의 `setZoomFactor`는 무시되고, 커밋 때 호스트 배율이 적용되며, 그 값은 같은 호스트의 모든 창이 나눠 쓰고 Preferences에 남는다.
- **범위.** 배율은 이 PC(Windows 사용자)에 하나이고 셸의 모든 own-web 창이 같이 쓴다. Chromium 배율이 원래 같은 origin의 창끼리 공유되므로 창마다 다르게 둘 수도 없다. 원격 PC 창과 모바일 미리보기 창(08 §4.1, §4.3)은 따르지 않는다: 다른 파티션이고 preload가 없으며, 미리보기는 휴대폰의 배율을 보여야 한다. 브라우저 패인의 페이지 확대도 따로다(8장).
- **저장.** 셸 설정 파일 `userData\opencode.settings`의 `ownZoomFactor`(창 목록·창 배경색과 같은 파일, upstream `getStore()`). 값이 바뀔 때만 쓴다. Chromium Preferences는 보조다: 셸이 모든 창의 배율을 같은 값으로 맞추므로 대개 같지만, 강제 종료 때 늦게 쓰이거나 지워질 수 있어 그것만 믿지 않는다.
- **단계.** Chrome의 단계 중 50~200%: 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200(`src/shared/zoom.ts`, main과 own-web 데스크톱 호스트가 같이 씀). 50% 아래는 글자를 읽기 어렵고, 창 버튼 밴드가 44 DIP 아래로 줄지 않아 CSS로 88px 넘게 차지한다. 200% 위는 1280px 창이 CSS 640px 폭(휴대폰 구간)이 된다. 03 11장의 200% 확대 규칙이 지원 범위의 끝이다. 범위 밖 값은 끝으로 자르고, 단계 사이 값(이전 빌드의 10% 단계, 예: 130%)은 그대로 두었다가 다음 단계로 간다. `Ctrl+0`은 100%다.
- **`Ctrl`+휠.** 한 눈금에 한 단계(위로 굴리면 크게)이고 키와 같이 저장된다. Chromium이 정밀 휠의 잔여를 눈금 단위로 모아 `zoom-changed`를 낸다. 페이지가 `Ctrl`+휠을 직접 쓰면(`preventDefault`) 창 배율은 바뀌지 않는다. own-web에는 지금 그런 곳이 없다.
- **main(`src/main/zoom.ts`).** `zoomFactor()`(저장값을 50~200%로 자른 것), `setZoom(factor)`(모든 창에 적용 → 각 창에 `own:zoom.changed` → 바뀌었으면 저장, 답은 적용한 값), `stepWindowZoom(direction)`. 창은 치환한 `appearance.ts`(4.3)의 `wireZoom`에서 합류한다. 합류할 때와 최상위 프레임 커밋(`did-navigate`)마다 저장값과 다르면 적용하고, 창 버튼 overlay 높이(`max(44, round(44·z))` DIP)와 upstream `WindowZoomChanged`를 갱신한다(`updateZoom`). 새 창은 첫 커밋 전 적용이 무시되므로 Chromium의 호스트 배율로 커밋하고, 커밋 확인이 차이를 고친다.
- **IPC(5.6, rpcHash 입력).** `own:zoom.get`, `own:zoom.set {factor}`, `own:zoom.step {direction: "in" | "out"}`(답은 적용한 배율), main → 렌더러 `own:zoom.changed`(set·step마다, 값이 그대로여도 보낸다: 200%에서 `Ctrl+=`). 렌더러의 최상위 프레임만 받는다(5.6 main 쪽 검사). main은 바뀐 값을 알린 뒤 요청에 답한다. own-web은 이 순서로 자기가 조용히 바꾼 변경을 구별한다(03 §4.2.1). own-web은 upstream `WindowSetZoomFactor`·`WindowGetZoomFactor`를 더 쓰지 않는다.
- **화면.** 03 §4.2.1: 100%가 아니면 창 버튼 왼쪽에 `110%`, 누르면 `−  110%  +  초기화(100%)`, 키·휠·다른 창의 변경 때 같은 말풍선을 잠깐 보인다. 설정 > 일반 `화면 크기`(03 §5.7).
- **웹·휴대폰.** 브라우저와 OS가 확대를 맡는다(브라우저의 `Ctrl+=`, 핀치, OS 글자 크기). own-web은 `host.window.zoom`이 없으면 키를 등록하지 않고 배율 표시와 설정 줄을 숨긴다. 키와 배율 표시(`shell/zoom.tsx`)는 `host.window.zoom`이 있을 때만 받는 따로 된 청크라 웹의 첫 청크에는 들어가지 않는다(2026-10-19 MR-2, PF5). 앱 루트에 CSS `zoom`을 거는 안은 버렸다: 브라우저 배율과 곱해지고, `getBoundingClientRect`·`vw`로 계산하는 팝오버 배치, 가상 목록 측정, 터미널 글자 칸 계산이 흐트러진다.
- **셸 재설치.** `own-api.ts`가 바뀌어 rpcHash가 `cbc59aad55a8107b`다(7.3 트레이와 종료의 `app`과 함께. 이 둘이 합쳐지기 전 zoom만의 값은 `76aa201d8528458e`). 이 own-web은 이 셸에서만 뜨고 이전 셸에서는 불일치 화면이 나온다(5.5).
- **시험.** `test/zoom.test.ts`(단계, 자르기, upstream 동작, IPC 보낸 쪽 검사), `test/overrides.test.ts`(치환 export), `scripts/zoom-level.ts`(빌드한 `out/`을 임시 userData로 실행. 사용자가 쓰는 PC라 입력은 CDP로만 하고, 창은 화면 밖(-32000)에 열고, 시작마다 프로세스 트리를 끝내며(시간 제한 5분), 끝에 이 패키지의 electron.exe가 남지 않았는지 본다): 처음 100%와 표시 없음, `Ctrl+=` 110%(devicePixelRatio, main 값, 창 버튼 왼쪽 표시, 헤더가 자리를 비움, 말풍선이 잠깐 뜨고 닫힘), 표시를 눌러 `+` 125%와 `Esc`, 설정 > 일반 `화면 크기`의 `−`(말풍선 없음), 설정 파일의 `ownZoomFactor`, 셸을 끝내고 다시 열면 첫 화면부터 110%와 밴드 높이, Chromium Preferences의 배율을 지워도 설정 파일로 125% 복원, 작업 패널 머리줄, `Ctrl+0`이 100%와 저장값 1. CDP로 보낸 `Ctrl`+휠은 Chromium이 `zoom-changed`로 넘기지 않아 기록만 한다. Electron `sendInputEvent`의 `Ctrl`+휠로는 `zoom-changed`(위 = `in`)를 확인했다 ⚠ 실제 마우스 눈금 하나가 한 단계인지는 이 PC에서 OS 입력으로 보지 않았다.

### 7.10 탐색기에서 열기 (OIE, 2026-11-21)

사용자 요청(03 §19.5a): 대화의 작업 폴더와 고른 파일을 탐색기로 열고, SSH 호스트의 것은 사용자가 정한 Windows 프로그램으로 연다. main이 하는 일과 그 규칙이다.

- **통로: own 내장 GUI 플러그인 `explorer`.** `src/overrides/gui-plugins.ts`가 upstream의 `browser`와 함께 own의 `explorer`를 내장 목록에 넣는다(원격 PC 전용 빌드에는 없다: 그 페이지는 부르지 않는다). main 진입점 `src/explorer/main.ts`가 Ipc `explorer`(`src/explorer/ipc.ts`)를 제공하고, own-web의 데스크톱 호스트가 upstream의 `PluginCall`로 이름으로 부른다(브라우저 패인과 같은 방식). **`window.own`과 `own-api.ts`는 그대로이고 rpcHash도 그대로다(`ce794c06d73401d9`).** 이 Ipc 파일은 rpcHash 입력이 아니다: 선택 기능이고 own-web이 없을 때를 처리하기 때문이다. 플러그인이 없는 이전 셸은 `unavailable`로 답하고, own-web은 이 PC의 경로면 upstream `FilesRevealPath`로 가고(전과 같은 동작) 그 밖에는 `데스크톱 앱이 이 화면보다 오래돼서…`라고 말한다. 처음 부른 것이 플러그인 시작보다 빠르면 `PluginSubscribe`로 시작을 부탁하고 3초까지 기다렸다 한 번 다시 부른다.
- **누가 부를 수 있나.** upstream의 플러그인 IPC 검사 그대로다: 렌더러(`oc://renderer`)를 보이는 앱 창의 최상위 페이지뿐이다. 브라우저 패인의 탭, 원격 PC 창, 모바일 미리보기 창은 preload가 없어 포트를 받지 못한다(`test/overrides.test.ts`). 서비스의 HTTP 경로, 에이전트 도구, CLI에는 이 기능이 없다. 사용자의 클릭만 own-web에서 부른다.
- **메서드.** `reveal {path}`, `launch {host, path}`, `program`, `pick`, `template {template}`, `clear`. 앞의 둘은 `{ok, reason?, detail?}`, 나머지는 `{program?, template}`을 답한다.
- **이 PC의 경로 (`reveal`).**
  1. main이 서비스에 열어 둔 폴더를 묻는다: `GET /api/project`의 각 프로젝트 폴더(`canonical`)와 `GET /api/worktree?projectID=`의 폴더들(대화가 도는 폴더가 모두 여기 적힌다. 관리되는 작업 폴더 포함). 읽기만 하는 공개 API 두 개이고 main이 가진 서비스 자격으로 부른다(렌더러는 그 자격을 모른다). 3초 안에 답이 없으면 `service`로 거절한다.
  2. 경로가 그 폴더들 중 하나이거나 그 안이 아니면 `outside`로 거절하고 아무것도 열지 않는다. 비교는 글자로 한다: `..`을 풀고, Windows에서는 대소문자와 `/`·`\`를 가리지 않는다. 드라이브나 공유로 시작하지 않는 경로, 장치 경로(`\\?\`, `\\.\`), NUL이 든 경로는 언제나 밖이다. 폴더 안의 링크가 밖을 가리켜도 안으로 친다(탐색기가 보여 줄 뿐이다).
  3. 없으면 `missing`. 폴더면 `shell.openPath`로 그 폴더를 열고, 그 밖(파일)이면 `shell.showItemInFolder`로 들어 있는 폴더를 열어 고른다. **파일은 열지 않는다.** 폴더인지는 여는 직전에 확인한다(확인과 열기 사이에 폴더가 파일로 바뀌는 경우까지 막지는 않는다. 끝에 `\`를 붙여도 Windows가 파일을 실행하는 것을 확인했다: OIE-9).
- **SSH 호스트의 경로 (`launch`).**
  - 프로그램과 실행 인자 틀은 셸 설정 파일 `userData\opencode.settings`의 `ownExplorerProgram` `{program?, template}`에 둔다(이 PC의 설정이다. 호스트 설정이 아니다). 틀의 기본값은 `--open {host} {path}`다(사용자의 `ssh-explorer.exe`가 받는 형식: 폴더는 서버 창에서 열고 파일은 들어 있는 폴더에서 고른다).
  - **프로그램은 main의 파일 대화상자(`pick`)로만 정한다.** 페이지는 실행할 파일 이름을 넘길 수 없다. 절대 경로의 `.exe`만 받는다(`.cmd`·`.bat`처럼 cmd.exe가 해석하는 것은 받지 않는다).
  - **틀 풀이(`src/shared/explorer.ts` `expandTemplate`).** 틀을 공백으로 낱말로 나눈다(큰따옴표 안의 공백은 한 낱말, `""`는 빈 낱말, 이스케이프 문자 없음: `\`는 경로 글자다). 낱말마다 `{host}`와 `{path}`를 값으로 바꾸고, **낱말 하나가 인자 하나**가 된다. 값은 넣은 뒤 다시 읽지 않으므로 원격 파일 이름에 공백, 따옴표, `&`, `%VAR%`, `{host}`가 있어도 인자를 늘리거나 다른 자리를 부를 수 없다. 낱말 안에 자리가 섞여 있어도(`sftp://{host}{path}`) 인자 하나다. 틀에는 `{path}`가 있어야 하고 `{host}`·`{path}` 말고 다른 `{이름}`은 받지 않으며 1,024자까지다.
  - **`{host}`.** own-web이 호스트 기록의 `target`에서 마지막 낱말을 보낸다: ssh config에서 고른 호스트는 별칭 그대로이고, 직접 입력한 호스트는 own-remote가 ssh에 넘기는 대상(`user@host`)이다. 그 앞에 적은 옵션(`-p`, `-J`, `-o …`)은 넘어가지 않는다. 포트가 기본이 아니거나 점프 호스트를 쓰면 ssh config 별칭으로 추가해야 프로그램도 같은 설정으로 연다(`ssh-explorer`는 별칭이나 `user@host`만 받는다). main은 own-remote의 대상 규칙(`[A-Za-z0-9_@.:[\]%-]`, 255자까지)에 맞고 `-`로 시작하지 않는 것만 받는다(`host`).
  - **`{path}`.** 호스트의 절대 경로다: `/`로 시작해야 하고 4,096자까지이며 NUL이 없어야 한다(`path`). `/`로 시작하므로 옵션으로 읽힐 수 없다.
  - **실행.** `child_process.spawn(program, args, {shell: false, detached: true, stdio: "ignore"})`이고 `unref()`한다. 셸을 거치지 않고, 기다리지 않고, 파이프를 잇지 않는다. 답은 `spawn`이나 `error` 사건에서 정한다. 프로그램 파일이 없으면 `program`, Windows가 거절하면(`UNKNOWN`: 스마트 앱 컨트롤 등, `EACCES`, `EPERM`) `blocked`, 그 밖은 `failed`이고 코드와 문구를 같이 보낸다. **한 번만 시도한다. 다른 방법으로 다시 시도하지 않고 보호 기능을 건드리지 않는다.**
- **남는 것.** upstream의 `FilesOpenPath(path, application)`과 `FilesRevealPath`는 전처럼 경로를 가리지 않는다(에디터에서 열기, 스킬 폴더 열기, 가져오기 화면이 쓴다). 이번 범위는 새 통로다(OIE-O).
- **시험(`test/explorer.test.ts`, 36개).** 틀 풀이(공백, 따옴표, `&`, `%VAR%`, `-`로 시작하는 값, 유니코드, Windows가 받지 않는 이름), 열어 둔 폴더 확인, 프로그램 파일 규칙, Electron과 서비스를 대역으로 바꾼 `reveal`·`launch`의 결정, 서비스 대역(127.0.0.1)에서 폴더 목록 읽기, 그리고 실제 시작 한 번: 이 시험의 Bun을 프로그램으로 숨겨 실행해 받은 인자를 파일에 적게 하고 그대로 왔는지 본다. **자동 시험은 탐색기 창을 열지 않고 사용자의 프로그램을 실행하지 않는다.**

## 8. 네이티브 브라우저 패인 (결정 D2)

### 8.1 구조

```text
own-web 패인 UI ─ host.browser (src/host/desktop.ts browserPane)
   │ PluginConfigure{servers}            ─▶ main GUI 확장 호스트 (desktop src/main/plugin/*)
   │ PluginCall{ipc:"browser.pane",        ─▶   └ 내장 확장 "browser" 하나 (own 치환 목록)
   │   register|load|command|close}                main 진입 browser/main.ts → 첫 register 때 pane.ts 로드
   │ PluginEmbed{id, layout} (탭 페이지마다) ─▶   탭 페이지 = WebContentsView embed (chromium.ts, CDP)
   │ PluginCapture{id}                   ─▶
   ◀ PluginEvent{ipc:"browser.pane", event{binding, state|focus|preview|embed|inspect}} · PluginAvailable
                                                                        │ Node HTTP(렌더러 풀과 분리)
                                                                        ▼
                                              서비스 plugin-browser RPC  rpc.experimental.browser.*
                                              attach{version:4} · state · command · result · tunnel.*
                                                                        ▲
에이전트 ── execute{ tools.browser.tabs.open(...) } ── Code Mode ── browser.* 도구(permission "browser")
```

- **v2.0.24(f406d93a66) 이전**에는 own-web이 `BrowserPane{register|layout|command|close}`·`BrowserPaneCapture`·`BrowserPaneEvent` IPC로 desktop main의 `browser-pane.ts`·`browser-chromium.ts`에 붙었다. upstream이 그 코드를 `packages/gui-extensions/src/browser`로 옮기고 IPC를 GUI 확장 호스트의 일반 호출로 바꿨다. own-web의 패인 UI와 `BrowserPanePlatform` 계약(`src/browser/types.ts`)은 그대로 두고, desktop host의 어댑터가 차이를 흡수한다(8.2).

- 역할 분담은 plugin-browser README가 정한 그대로다: "The server owns tools, invocation scope, and permissions; the desktop owns tabs, CDP, captured traffic, evaluations, and capture files."(`packages/plugin-browser/README.md`).
- 도구는 45개(탭, 미리 보기, 이동, 관찰, 입력, 파일, 진단, 성능, 메모리, lighthouse)이고, 원본은 `Browser.Operations`(`packages/plugin-browser/src/rpc.ts:154` 이하)다.
- 셸은 첫 창과 함께 확장 호스트를 시작하고(`desktop.ts` `extensions.start`, upstream과 같음) 브라우저 확장의 main 진입은 `browser.pane` Ipc를 provide만 한다. CDP 드라이버와 RPC 클라이언트(`pane.ts`)는 창이 처음 register할 때 지연 로드된다(`browser/main.ts`). 패인을 쓰지 않으면 시작 비용이 거의 없다.

#### 8.1.1 셸의 GUI 플러그인 목록 (v2.0.24, v2.2.1에 GUI 플러그인으로, 결정)

| upstream 내장 플러그인 | 셸에 넣는가 | 이유 |
|---|---|---|
| `browser` | **넣음(유일)** | 결정 D2의 네이티브 브라우저. 사용자의 핵심 요구 |
| `updater` | 뺌 | own은 자기 설치기와 `own install`로 올린다(01 §5.5). upstream 것은 패키지 빌드면 켜진다 |
| `ssh`, `wsl` | 뺌 | SSH는 서비스 안의 own-remote(04), WSL은 범위 밖 |
| `pairing` | 뺌 | 기기 페어링은 own 게이트웨이(13.5). 화면 켜짐 유지 저장소가 여기 있으므로 데스크톱 `keepScreenAwake`도 없다(7.6) |
| `context`, `btw`, `debug`, `terminal`, `file`, `review`, `details`, `microsoft-office`, `sources`, `goal` | 뺌 | upstream 렌더러(`packages/app`)의 창 전용 플러그인(debug는 main 진입도 있음). own-web이 대신한다 |

- **방식.** 플러그인 호스트(`src/main/plugin/host.ts`)가 import하는 내장 목록 `@opencode/gui-plugins/main`을 빌드 때 `src/overrides/gui-plugins.ts`(브라우저 하나를 `compose`)로 치환한다(4.3). 뺀 플러그인의 코드는 셸 번들에 들어가지 않는다(`electron-updater`도 import되지 않음). `test/shell.test.ts`가 빌드 산출물에서 확인한다.
- **서비스 플러그인의 GUI 번들은 돌리지 않는다.** v2.1부터 upstream은 설치형 압축 파일 대신, 앱 자체 서버(own에서는 이 PC의 서비스)의 플러그인 중 `./gui-experimental` 번들을 내는 것을 나열해 그 번들을 **main 프로세스에서 평가**하고 켜진 것을 실행한다. 평가는 켜졌는지와 관계없이 일어나고, 번들은 `electron`과 Node 내장 모듈에 닿는다. own 서비스는 로컬 플러그인을 서버 진입 파일 기준으로만 승인하므로(02 플러그인 신뢰), 셸은 `src/overrides/plugin-module.ts`로 평가를 막고(번들 코드가 한 줄도 돌기 전에 `unavailable`) `src/overrides/plugin-manager.ts`로 내장만 켠다. 켜고 끄기 요청(`PluginEnable`·`PluginDisable`)은 행을 쓰지 않고 거부된다. own-web은 `PluginGuis`를 부르지 않으므로 창 쪽 번들도 돌지 않는다.
- **누가 닿는가.** `Plugin*` IPC 처리기는 요청 webContents가 앱 창의 top webContents이고 렌더러 URL(`oc://renderer` 또는 dev URL)인지 확인한다(`ipc-handlers/plugins.ts`, surface `desktop-extension-ipc-guard`). 패인 탭(다른 partition, preload 없음)과 원격 PC·모바일 미리보기 창(preload 없음, sandbox, `remote-pcs/partition.ts` `pageWebPreferences`)은 IPC 포트를 받지 못하고, 받아도 렌더러 URL이 아니라 거부된다. 원격 PC 화면은 다른 PC의 own-web이므로 이 셸의 플러그인 호출에 닿을 수 없다(08 §3.4). v2.1부터 upstream은 패키지 빌드에서도 관리자 호출을 막지 않으므로 거부는 own 치환본이 맡는다.
- **플러그인 저장소.** 브라우저 플러그인의 main 저장소(탭 복원 `restore:<server>\n<session>`, 요소 ref 블록)는 셸 userData의 desktop DB에 있다. v2.0.24 전 `opencode.browser.dat` 행은 처음 읽을 때 옮겨 온다(`browser/restore.ts`).
- **페이지 단축키(v2.2).** 포커스를 가진 패인 페이지에서 앱·패인 단축키(`Ctrl+T`·`Ctrl+W`·`Ctrl+L`·`Ctrl+Tab`·`Ctrl+Shift+P` 등, upstream `browser/keys.ts` `pageShortcut`)를 누르면 페이지는 그 키를 받지 않고 main이 `shortcut` 이벤트로 창에 넘긴다. own-web의 데스크톱 어댑터는 그것을 창의 `keydown`으로 되살려 단축키 등록부가 받게 한다(분할 키 `own:browser.view-key`와 같은 길). `focused`(페이지가 키보드 포커스를 가짐)와 `page`(아이콘·배율)는 어댑터에서 멈춘다.

### 8.2 연결, 소유, 수명

- **register(v2.0.24).** own-web의 `BrowserPaneTarget{serverKey, sessionID, endpoint{url, username?, password?}, restore?}`(`src/browser/types.ts`)는 그대로이고, desktop host가 확장 호출로 바꾼다(`src/host/desktop.ts` `browserPane`).
  1. 확장이 아직 시작 중이면 첫 register가 `PluginSubscribe{ipc:"browser.pane"}`(main이 그 확장을 바로 시작함)를 보내고 `PluginAvailable`을 기다린다(최대 15초, 넘으면 `suspended`).
  2. 그 창이 지금까지 쓴 끝점 목록을 `PluginConfigure{servers:[{id:serverKey, url, username?, password?}]}`로 보낸다(바뀔 때만). main은 창마다 마지막 목록을 두고 server id를 끝점으로 푼다(`extension/host.ts` `server`).
  3. `PluginCall{ipc:"browser.pane", method:"register", input:{binding, server:serverKey, session, restore?}}`. 로컬 서버면 `endpoint`에 `username`·`password`를 모두 넣지 않는다(`username`만 있으면 거부, `pane.ts:69`, 03 §18.17). main이 그 url의 origin이 sidecar와 같을 때만 `SidecarCredentials`에서 Basic을 붙이고 `file://` 루트를 연다(`host.ts` `server`, `pane.ts:158`). 원격 서버면 own-web이 가진 세션 토큰을 `password`로 넘긴다(12장).
  - main이 이벤트 없이 거부한 경우는 어댑터가 닫힘 이벤트로 바꾼다: `unavailable`(확장이 돌지 않음)은 마지막 탭을 지닌 `suspended`, 그 밖의 register 실패(예: 세션이 서버에 아직 없음 → `registration.invalid`)는 `registration.closed`(own-web이 1초…30초 backoff로 재시도). main이 받아 둔 binding을 닫은 거부(`registration.closed`)는 main의 닫힘 이벤트가 정한다. 확장이 사라지면(`PluginAvailable{available:false}`, 개발 빌드의 다시 로드나 종료) main은 이벤트 없이 binding을 버리므로 어댑터가 `suspended`를 낸다.
  - **탭 페이지는 embed다.** main은 탭 페이지를 만들 때마다 `embed{tabID, embed}` 이벤트를 바로 보내고, 어댑터가 탭 → embed를 기억한다. 패인의 `setLayout({tabID, visible, bounds, background})`는 그 탭의 embed에 `PluginEmbed{id, layout}`으로 가고, 앞서 놓았던 다른 embed는 `PluginEmbed{id}`(배치 없음)로 숨긴다. 복원된 탭은 패인이 그 탭을 **보일 때** `load{binding, tabID}`로 페이지를 만든다(upstream과 같음).
  - 세션에서 턴이 시작되면(`session.execution.started`) own-web이 그 세션의 attachment를 깨운다(upstream 모델과 같음). 82bb5ff88a부터 plugin-browser는 붙은 데스크톱이 없으면 모든 에이전트에서 `browser`를 deny하고 attach 때 세션 권한에 allow를 넣으므로, 서버가 쉬는 동안 떼어 낸(`suspended`) 패인이 다시 붙어야 에이전트가 브라우저 도구를 다시 본다.
- **인증은 register 때 한 번 정해진다.** main은 attachment의 HttpClient에 `authorization` 헤더를 register 시점 값으로 고정한다(`pane.ts:141-153`). 그래서 다음 경우 own-web이 **패인을 닫고 다시 register**한다. 하지 않으면 attachment가 조용히 인증 실패로 끊긴다.
  - 원격 세션 토큰을 새로 받았을 때. 04 §12.1 토큰은 만료가 있고(기본 12시간, `tokenTtlHours`), `own.remote.resolve`가 남은 수명 1시간 미만이면 새로 서명해 준다(04 §16.2). own-web은 새 토큰을 받으면 그 서버의 열린 패인을 다시 register한다.
  - 원격 끝점이 바뀌었을 때(`resolve`의 `epoch`가 바뀜, 임시 포트로 옮김, 04 §7.3).
  - 로컬 서비스가 재시작되어 password가 바뀌었을 때. 로컬은 main이 `SidecarCredentials`를 register 때 읽으므로(`host.ts` `server`) 5.3 reconnect 뒤 다시 register해야 새 password가 쓰인다.
  - 창이 다시 로드됐을 때. top frame 이동은 그 창의 attachment를 모두 닫는다(`pane.ts:130-131`). 5.5의 강제 다시 로드도 여기에 든다. own-web은 시작할 때 열린 세션의 패인을 register한다.
  - 다시 register해도 탭 URL은 셸 저장소에서 복원된다(아래 "복원").
- **attach v4.** main은 서비스 이벤트를 먼저 구독하고 `server.connected`를 받은 뒤 `attach{sessionID, connectionID, version:4}`를 부른다(`pane.ts:282-286`). 서버는 세션 location이 자기 location과 같은지 확인하고, 같은 세션의 이전 attachment를 `replaced`로 닫고, `attached` 이벤트를 보낸다(`plugin-browser/src/connection.ts`). 이 이벤트가 준비 완료 신호다. 15초 안에 오지 않으면 등록을 포기한다(`pane.ts:313`).
- **이벤트 스트림은 서버마다 하나**(2026-10-20, P3). main은 서버(엔드포인트와 자격 증명)마다 `@opencode/client` 클라이언트 하나를 두고, 그 서버의 attachment들이 그 클라이언트의 이벤트 스트림 하나를 같이 쓴다(own-desktop `src/overrides/browser-clients.ts`, upstream `pane.ts`의 치환 `src/overrides/browser-pane.ts`, `own/ledger/vendored.yaml`). 늦게 붙은 attachment도 `server.connected`를 받는다. 스트림이 끊기면 모든 attachment가 끝났다가 다시 register되고, 다음 구독이 새 스트림을 연다. 마지막 attachment가 끝나면 스트림을 닫는다. 서비스가 재시작해 자격 증명이 바뀌면 새 클라이언트를 만들고 옛것은 버린다. 그 전에는 attachment마다 `/api/event` 연결을 열어서, own-web이 창에서 보인 세션마다 붙여 두는 탓에 세션 50개면 main의 서비스 연결이 100개였고 모든 이벤트를 attachment 수만큼 디코드했다(`own/reports/ui-perf-many-sessions-2026-10.md` 원인 3). 시험: `test/browser-clients.test.ts`, `scripts/split-panes.ts`.
- **소유 검사.** `Extension*` IPC 처리기는 요청을 보낸 webContents가 창의 top webContents이고 렌더러 URL인지 확인한다(`ipc-handlers/extensions.ts`, 8.1.1). 브라우저 확장은 binding의 창과 요청 창이 같은지 다시 보고(`pane.ts:349` `owned`), embed 호출도 그 창의 embed만 받는다(`extension/embeds.ts` `owned`). 패인 탭(다른 partition) 안의 페이지는 이 IPC에 닿을 수 없다.
- **세션당 하나.** plugin-browser는 세션마다 attachment 하나만 둔다. 다른 창이나 다른 클라이언트가 같은 세션에 붙으면 앞의 것은 `browser.pane.replaced`가 된다.
- **분할(03 §4.1.1).** own-web은 창의 분할들이 보이는 세션마다 attachment를 붙여 둔다(규칙상 브라우저 도구가 없는 세션은 빼고, `src/browser/attach.tsx`). 다른 세션의 브라우저 분할은 각자 자기 등록의 뷰를 보이므로 **함께 보인다**. 한 등록은 한 번에 탭 하나만 보이므로(뒤에 놓은 embed가 앞의 것을 숨김, own-web `host/desktop.ts` `apply`) 같은 세션을 두 분할에 보일 수 없다. 두 번째 분할은 `이 세션의 브라우저는 다른 분할에 열려 있어요 [여기로 옮기기]`를 보이고, 누르면 그 분할이 뷰를 가져간다(앞 분할의 패널은 내려 뷰를 숨기고, 새 분할은 다음 프레임에 배치를 보냄). 세션의 브라우저는 그 세션을 보이는 채팅 분할 옆에 열린다(에이전트가 쓰기 시작할 때, main의 `focus` 이벤트, `Ctrl+Shift+B`).
- **닫힘 이유.** `unsupported`(서버에 플러그인·메서드 없음, 렌더러는 재시도 중지), `replaced`, `suspended`(붙은 뒤 서버 RPC가 끊김, 또는 확장이 멈춤), `registration.closed`(`pane.ts:121-123,362`). own-web은 이유마다 문구를 보인다(03에 추가, 17장). `suspended`와 인증 실패는 위 재등록 규칙으로 다시 붙는다.
- **복원.** 탭 URL은 `(serverKey, sessionID)`마다 셸 저장소에 남고(`pane.ts` `publishState`, `browser/restore.ts`), 다음 attach 때 다시 연다. own-web이 register를 명시적으로 닫으면(`close`) 그 세션의 저장도 지운다(`pane.ts:332-335`). 다시 붙을 때는 own-web이 마지막 상태를 `restore`로 넘긴다. URL에 토큰이 들어갈 수 있으므로 저장 위치는 userData(사용자 전용)이고, `세션의 브라우저 탭 기록 지우기`를 설정에 둔다.

### 8.3 격리

| 항목 | 동작 | 근거 |
|---|---|---|
| 프로필 | attachment마다 `opencode-browser-<uuid>` partition. `persist:` 접두어가 없어 **메모리 전용**이다. 쿠키·로그인은 앱을 다시 켜면 사라지고 렌더러 session과 공유되지 않는다. 분할마다(세션마다) partition이 다르므로 한 분할의 로그인은 다른 분할에 없다(설명서에 적음) | `gui-plugins/src/browser/pane.ts:109` |
| 네트워크 | 이 PC 서비스의 세션: 패인 탭의 모든 요청이 서버 plugin-browser 터널로 나간다(`tunnel.open/read/write/close`, upstream 그대로). loopback도 우회하지 않는다. 즉 **`localhost`는 서버가 도는 기계의 localhost**다. SSH 호스트의 세션(SB, 8.6): loopback과 호스트의 이름만 호스트의 터널로, 나머지는 이 PC에서 바로 | `gui-plugins/src/browser/network.ts:17-47`, own-desktop `src/overrides/browser-network.ts`, `src/main/browser-route.ts` |
| WebRTC | 프록시를 거치지 않는 UDP 금지 | `gui-plugins/src/browser/network.ts:72` |
| 파일 URL | 같은 기계의 서비스일 때만, 그 세션 워크스페이스 안의 `file://`만 허용(하위 리소스 포함) | `gui-plugins/src/browser/pane.ts:114-120,158`, `policy.ts:32-45` |
| 웹 권한 | 카메라·마이크·위치·알림 등 모든 권한 요청과 확인을 거부, 화면 공유 거부 | `gui-plugins/src/browser/chromium.ts:270-273` |
| 팝업 | http/https/about:blank만, 같은 partition의 새 탭으로 | `gui-plugins/src/browser/chromium.ts:290-311` |
| 개발자 도구 | 탭에서 끔(CDP는 main이 `webContents.debugger`로 붙음) | `gui-plugins/src/browser/chromium.ts:115` |
| 포커스 | 에이전트의 이동이 사용자의 키보드 포커스를 가져가지 않음. 입력창 IME가 끊기지 않는다 | `gui-plugins/src/browser/chromium.ts:117-118` |
| 백그라운드 | 탭은 `backgroundThrottling:false`. 숨은 탭도 에이전트 동작을 위해 돈다 | `gui-plugins/src/browser/chromium.ts:116` |

- CDP는 탭마다 `webContents.debugger`로 붙는다. 원격 디버깅 포트(9222)는 패인과 무관하다. 셸이 **스스로** 포트를 여는 것은 비패키지 빌드뿐이다(`configure.ts:26-27`). 패키지 빌드도 실행한 쪽이 명령줄에 `--remote-debugging-port`나 `--inspect`를 주면 받는다(upstream 벤치가 그렇게 띄운다, `scripts/bench-startup.ts:298-299`). 11.2와 19장.

### 8.4 권한 프롬프트와 다운로드

- **에이전트 도구 권한.** 모든 브라우저 도구는 권한 이름 `browser`를 쓴다(`plugin-browser/src/tools.ts:49`). 묻기(`ask`)면 03의 권한 dock에 뜬다. 권한을 기다리는 동안 대상 탭이 바뀌면 실행하지 않는다("Browser target changed while permission was pending", `gui-plugins/src/browser/chromium.ts:476`).
- **웹 페이지 권한.** 8.3 표대로 모두 거부다. 사용자에게 묻지 않는다. 패인 상단에 `이 브라우저는 카메라·마이크·위치 권한을 주지 않습니다`를 한 번 보인다.
- **JavaScript 대화상자.** `alert/confirm/prompt`는 에이전트가 `browser.dialog`로 처리한다(`gui-plugins/src/browser/chromium.ts:388`). 패인은 대화상자가 열려 있다는 표시만 한다.
- **다운로드.** 사용자 다운로드 폴더가 아니라 `%TEMP%\opencode-browser-client-<uuid>\<fileId>\<이름>`(디렉터리 0700)에 저장되고 에이전트 파일 목록에 들어간다(`gui-plugins/src/browser/files.ts:10,24-61`, `chromium.ts:313-338`). 전송 상한은 5 MiB이고 넘으면 취소된다(`plugin-browser/src/rpc.ts`, `chromium.ts:326`).
  - own-web은 파일 목록에 `PC에 저장`을 둔다(셸의 `own:browser.save-download`가 저장 대화상자를 띄우고 임시 파일을 복사, `src/main/own-browser.ts`). 사용자 동작 없이 사용자 폴더에 쓰지 않는다. 셸은 각 세션의 `will-download`에 두 번째 listener를 달고, 탭 페이지 embed가 어느 창의 contentView 자식인지로 주인 창을 찾는다(surface `browser-download-temp`·`browser-embed-child-view`).
  - **임시 파일의 수명(소스 확인).** 임시 디렉터리는 탭 페이지마다 하나이고(`chromium.ts:165`, `files.ts:10`), 페이지를 버릴 때 통째로 지운다(`chromium.ts:541` → `files.ts:125` `rm(directory, {recursive:true, force:true})`). 탭을 닫을 때(`pane.ts:382` `closePage`)와 attachment를 닫을 때(`close`가 모든 페이지를 버림, `pane.ts:362-380`) 둘 다 지워진다. 창 닫기·다시 로드·`replaced`도 attachment 닫기이므로 같다.
  - 그래서 사용자가 받은 파일을 남기려면 **탭이나 창을 닫기 전에** `PC에 저장`해야 한다. own-web은 저장하지 않은 다운로드가 있는 탭을 닫을 때 `저장하지 않은 파일 {n}개가 지워집니다 [PC에 저장] [그냥 닫기]`를 보인다. 7.2의 창 닫기 확인에도 같은 조건을 더한다.
  - 셸이 비정상 종료하면 정리가 돌지 않아 `%TEMP%\opencode-browser-client-*`가 남는다. 다음 시작 때 지울지는 19장.

### 8.5 레이아웃과 z-order

- 패인 탭은 창 위의 네이티브 뷰(WebContentsView)라 **DOM보다 항상 위에** 그려진다. own-web의 팝오버·대화상자·명령 팔레트가 패인 영역과 겹치면 가려진다.
- 규칙: 겹치는 오버레이가 열리는 동안 `setLayout({visible:false})`로 탭을 숨기고, 그 자리에 정지 이미지(`capture(tabID) → Blob`)를 보인다. 오버레이가 닫히면 다시 보인다. v2.0.24부터 capture는 그 탭 embed의 `PluginCapture{id}`(JPEG)이고, main은 **보이는** embed만 찍으므로 숨기기 전에 찍는다(`extension/embeds.ts` `capture`).
- 레이아웃은 `{tabID, visible, bounds, background, radius}`다(own-web `src/browser/types.ts`). 자리 표시 요소를 `ResizeObserver`로 보고 rAF에 한 번만 보낸다(9.2 규칙). desktop host가 그 탭의 embed에 `PluginEmbed{id, layout}`(창 DIP × 확대 배율, RGBA 배경)으로 보낸다. main은 렌더러 배치와 페이지 쪽 `show`(보여 줄 문서가 있을 때)가 모두 있어야 뷰를 보인다.
- 패인 위치는 [gap] #4의 작업 패널 결정에서 시작해, ab31dc31dd부터 가운데 워크스페이스의 `브라우저` 탭, 2026-10-11부터 기본 보기(`나란히`)에서는 채팅 옆의 분할이다(03 §4.1.1). 브라우저 분할이 여럿이면 등록마다 자기 embed를 자기 자리에 놓으므로 뷰 여러 개가 함께 보인다(main은 embed마다 bounds를 따로 둠, `desktop/src/main/extension/embeds.ts`).
- **뷰 포커스(분할).** 네이티브 뷰 안의 클릭은 렌더러 DOM에 오지 않아 own-web이 어느 분할을 눌렀는지 모른다. own-desktop main이 알려 준다(`src/main/own-browser.ts` `wireBrowserViews`, `desktop.ts`에서 `wireBrowserDownloads` 다음에 건다). upstream 코드는 고치지 않는다(코어 패치 없음, gui-extensions 그대로):
  - `app.on("web-contents-created")`로 모든 webContents에 `focus`와 `before-input-event` listener를 단다. 그 webContents가 어느 창 contentView의 자식 `WebContentsView`(패인 탭 embed)일 때만 동작한다(렌더러 페이지 자신과 다른 창은 제외, 다운로드와 같은 찾기 `hostView`).
  - `focus`: 그 창 렌더러에 `own:browser.view-focus`로 뷰의 `getBounds()`(렌더러가 보낸 단위, 창 DIP × 확대 배율)를 보낸다. own-web은 마지막으로 놓은 자리의 가운데가 그 안에 드는 브라우저 패널의 분할로 포커스를 옮긴다(`BrowserPanePlatform.onViewFocus`).
  - `before-input-event`: `F6`, `Shift+F6`, `Ctrl+Alt+1`–`4`(다른 수식키 없이)만 페이지에 주지 않고 `own:browser.view-key{code, ctrl, alt, shift}`로 창에 넘긴다. own-web 데스크톱 호스트가 같은 키의 `keydown`을 창에 보내 단축키 처리기가 받는다(03 §10). 다른 키는 페이지 것이다. AltGr이 Ctrl+Alt인 Windows에서 AltGr+1–4로 글자를 치는 자판이면 그 네 키는 페이지에 가지 않는다(한국어 자판은 해당 없음).
  - preload의 `window.own.browser.onViewFocus`/`onViewKey`는 선택 멤버라 이전 셸에서는 없다(own-web은 있을 때만 씀). `src/preload/own-api.ts`가 rpcHash 입력이라 해시가 바뀐다(5.5, `scripts/rpc-hash.mjs --write`).
- **분할 구분선 끌기.** 끄는 동안 모든 브라우저 분할은 정지 이미지(`capture`) 뒤로 뷰를 숨기고, 놓으면 다시 보인다(03 §4.7.2).

### 8.6 SSH 원격 세션의 패인 (구현, SB 2026-11-21)

사용자 요청(2026-11-21, 2.2.6-own.14): SSH 호스트(주로 `build-host`)의 대화에서도 앱 안 브라우저가 PC와 휴대폰에서 돼야 한다. 에이전트나 사용자가 서버에서 띄운 개발 서버(`localhost:3000`, `127.0.0.1:5173`)를 `ssh -L` 없이 열어야 한다. 결정 기록은 decisions의 `SB`, 보고서는 `own/reports/ssh-browser-2026-11-21.md`다.

```text
데스크톱 창 own-web ── PluginConfigure{id:<hostId>, url:http://127.0.<k>.2:<LP>, username:opencode, password:<세션 토큰>}
   │                    PluginCall register{server:<hostId>, session}
   ▼
셸 main (browser-pane.ts) ── HTTP, own-remote의 -L 터널 하나 ──▶ 호스트의 원격 서비스 (core plugin-browser 그대로)
   │  attach v4 · state · command · result · /api/event                ├ 세션 권한에 `browser allow` (붙어 있는 동안)
   │  tunnel.open/read/write/close  ◀── loopback, 호스트 이름 ───────── └ tunnel.open = 호스트에서 net.connect
   │  그 밖의 대상: 이 PC에서 BrowserTunnel(net.connect)
   ▼
패인 탭 (attachment마다 메모리 전용 partition, 프록시 127.0.0.1:<임시> + 무작위 Basic)
```

- **붙이기.** own-web은 SSH 세션도 이 PC 세션처럼 붙인다(`browser/attach.tsx`). 끝점은 그 호스트의 터널 주소와, 창이 들고 있는 세션 토큰(04 §12.1의 `Authorization` holder)을 `password`로 넣은 것이다. main은 그 서버의 plugin-browser에 attach v4로 붙고(8.2와 같은 순서), 원격 서비스는 그 세션 권한 끝에 `browser allow`를 붙인다. 그래서 **서버에서 도는 에이전트의 카탈로그에 브라우저 도구가 생기고**, 도구 호출은 원격 서비스의 이벤트 스트림(`rpc.experimental.browser.control`)으로 main에 오고 main이 `command`·`result`로 답한다. 모두 own-remote가 이미 유지하는 SSH 연결의 `-L` 하나 위의 HTTP다(04 §7.3). 새 SSH 로그인도, 호스트에 새 포트도 없다.
- **원격 서비스는 바뀌지 않는다.** plugin-browser는 core의 내장 플러그인이라(`core/src/plugin/internal.ts`) 모든 원격 서비스에 이미 있다. 원격 `proto`도, 원격 서비스의 코드도 그대로라 **이 기능 때문에 호스트에 더할 것은 없다**. 다만 PC를 새 판으로 바꾸면 04 §5.7대로 판이 다른 호스트는 `incompatible`이 되므로, 릴리스마다 하는 호스트 업데이트(판 맞추기)는 그대로다. attach v4가 없는 서비스(아주 옛 판)는 `rpc.method_not_found`로 답하고 패인은 `unsupported` 문구를 보인다.
- **어느 연결이 호스트를 거치나(`browser-route.ts`).** 패인 탭은 upstream처럼 모든 요청을 attachment의 프록시로 보낸다(`proxyBypassRules:"<-loopback>"`: Chromium의 기본 loopback 우회를 빼서 loopback도 프록시로 온다). 프록시의 transport가 대상마다 고른다.

  | 대상 | 경로 |
  |---|---|
  | `localhost`, `*.localhost`, `127.0.0.0/8`(IPv4-mapped 포함), `::1`, `0.0.0.0` | 호스트: plugin-browser `tunnel.open`이 호스트에서 `net.connect` |
  | 호스트의 이름: ssh config 별칭, 직접 넣은 target의 host, 마지막 연결의 `ssh -G` destination(`hosts.detail`) | 호스트 |
  | 그 밖의 모든 것(인터넷, 사내 사이트, 이 PC의 이름) | 이 PC: main이 plugin-browser의 `BrowserTunnel`로 직접 연결 |

  호스트의 이름은 attachment를 만들 때 이 PC 서비스의 `own.remote` `hosts.list`·`hosts.detail`(사이드카 자격 증명)로 한 번 묻고, 3초 안에 답이 없으면 loopback만 호스트로 보낸다. 이 PC 서비스의 세션(`sameMachine`)은 upstream 규칙 그대로(모두 서비스로, 같은 PC라 결과도 같다).
- **기각한 안.**
  1. `ssh -D`(own-remote 터널에 SOCKS5): Windows OpenSSH에는 ControlMaster가 없어(04 §7.1) 살아 있는 연결에 forward를 더할 수 없다. 명령줄에 넣으면 SOCKS 리스너가 패인 사용과 관계없이 연결 내내 열려 있고, 인증이 없으며, 켜고 끄려면 터널을 다시 세워야 한다(인증 한 번 더, 프롬프트가 뜰 수 있음).
  2. 이 PC 안의 SOCKS 서버 + `direct-tcpip` 채널: 프로세스 안에 SSH 클라이언트(키 처리 포함)를 들이고 사용자 키로 **두 번째 로그인**을 하게 된다. ssh.exe로 이미 유지하는 연결을 쓰지 못한다.
  3. 호스트마다 Electron partition 하나 + SOCKS 프록시: upstream은 이미 attachment(세션)마다 메모리 전용 partition을 쓴다. 호스트 단위로 묶으면 그 호스트의 대화끼리 쿠키·로그인을 나누게 되어 지금보다 약하고, 이 PC 대화와 섞이지 않는다는 조건은 지금 구조로도 이미 만족한다.
  4. PAC 스크립트(loopback만 프록시로): Chromium은 PAC에도 암묵적 loopback 우회를 먼저 적용하므로 PAC만으로는 loopback을 프록시로 보낼 수 없다. 그래서 고정 프록시 + `<-loopback>`을 두고 고르기는 프록시 안에서 한다.
  5. 호스트 설정 "모든 연결을 서버로": 저장 필드, 설정 화면, 문서가 들고 지금 쓸 곳이 없어 넣지 않았다. 고르기가 함수 하나라(`throughHost`) 나중에 더하기 쉽다.
- **리스너와 남는 위험.** 프록시는 upstream 그대로 attachment마다 `127.0.0.1`의 임시 포트에 열리고, attachment가 끝나면(패인 닫기, 다른 창이 가져감, 쉬기, 호스트 연결 끊김) 닫힌다. 요청마다 무작위 Basic 자격 증명(`randomBytes(16)`·`(32)`, main 메모리에만)을 요구하므로, 그 포트가 열려 있는 동안 이 PC의 다른 프로세스가 연결은 할 수 있어도 쓸 수는 없다. 남는 위험은 같은 사용자로 도는 프로세스가 셸의 메모리나 Chromium에 손댈 수 있는 경우뿐이다(사용자 권한 전체와 같은 수준이라 따로 막지 않는다). 호스트 쪽: `tunnel.open`은 호스트의 아무 loopback 포트에나 닿는다. 원격 서비스(`127.0.0.1:RP`)는 Basic 없이 401이고, 원격 에이전트의 셸도 같은 곳에 닿으므로 새 위험이 아니다(04 §7.6).
- **끊김과 다시 연결.** SSH 연결이 끊기면 main의 이벤트 스트림과 RPC가 실패해 attachment가 닫히고(`suspended` 또는 `registration.closed`), 프록시도 닫힌다. 페이지는 버려지고 탭 목록은 own-web이 복원용으로 들고 있다(8.2). 호스트 런타임이 연결되지 않은 동안 패인은 페이지 자리에 `SSH 연결이 끊겼어요`(`… 다시 연결되면 탭을 다시 열어요.`; 한 번도 연결되지 않았으면 `SSH 서버에 아직 연결되지 않았어요`)를 보이고 뷰는 숨긴다. 호스트의 끝점이 다시 알려지면(`resolve`, 주소가 바뀌거나 토큰을 새로 받았을 때도) own-web이 그 호스트의 attachment를 다시 등록하고(8.2 재등록 규칙), 탭이 다시 열려 페이지를 새로 불러온다. 응답이 없는 연결(SSH keepalive가 끊김을 알기까지 터널은 최대 약 12초, own.15 전에는 약 60초; 04 §6.3 "죽은 링크") 동안 페이지가 무한히 기다리지 않게, 호스트로 가는 `tunnel.open`은 20초에 포기한다(`OPEN_TIMEOUT_MS`).
- **불러오지 못한 페이지.** upstream의 페이지 기계는 프록시의 빈 502와 Chromium의 오류 페이지를 `failed`(`loadError`)로 다룬다. own-web은 그때 뷰를 숨기고 그 자리에 `페이지를 열 수 없어요`와 이유를 보인다: SSH 대화에서 호스트로 간 주소면 `서버 {host}에서 {address}에 연결하지 못했어요. 그 서버에서 개발 서버가 켜져 있는지 확인한 뒤 새로 고침하세요.`, 그 밖에는 `{address}에 연결하지 못했어요. 주소와 인터넷 연결을 확인한 뒤 새로 고침하세요.`, 아래에 오류 코드와 `새로 고침`. 이 PC의 대화에도 같다.
- **원격 세션 토큰.** main 메모리에서 attachment 수명 동안만 쓰고 저장하지 않는다. 토큰을 새로 받거나(남은 수명 1시간 미만, 04 §16.2) 끝점이 바뀌면 위의 재등록이 돈다.
- 원격 서버에서는 `file://` 루트가 비어 있다(같은 기계가 아님, `server.sameMachine`).
- **캐시.** 8.7 규칙 7 그대로다: attach·detach가 step 경계를 넘을 때마다 그 세션 기록 뒤에 카탈로그 교체 문구 1건, 앞 prefix 유지. SSH 끊김과 다시 연결도 각각 1건씩 더할 수 있다. 이 판 전에 데스크톱에서 만든 SSH 세션(deny 없음)은 처음 붙을 때 1건이 더해지고 도구가 생긴다.
- **기기.** 휴대폰·다른 PC에서 보는 것은 8.10.8.
- **시험.** own-desktop `test/browser-route.test.ts`(고르기 규칙, 호스트 이름 조회, upstream 프록시 뒤의 고른 transport와 20초 포기), `test/remote-browser.test.ts`(호스트의 패인 스트림), own-remote `test/gateway/browser-hub.test.ts`·`browser.test.ts`, own-web `src/browser/wanted.test.ts`·`remote/*.test.ts`, 실제 호스트 단계 F(`packages/own-remote/test/real-host/f-browser.test.ts`: 호스트에서 띄운 임시 HTTP 서버를 PC 패인으로 열기, 이 PC의 `127.0.0.1` 페이지가 아니라 호스트의 것이 열리는지, 에이전트의 `tabs.open`·`snapshot`, 끊김과 다시 연결). 실측은 보고서에 있다.

### 8.7 웹 모드와 도구 목록 안정성 (결정: 안 D)

**상태(P5 구현 반영).** **안 D로 정했고 구현했다.** 01 §10.1(v0.4)이 안 D로 바뀌었고, own-web이 규칙 1·2를(`src/policy/browser.ts`, 세션 생성 어댑터), own.accounts가 규칙 3의 쓰기를(`session.approval.set{browserTool}` v0.5, 03 §16.3) 가진다. 03 §18.15도 이 규칙으로 맞췄다. 아래의 선택지 표와 비교는 결정 근거로 남긴다.

**사실(로컬 소스).**
- `opencode.browser`는 내장 pre 플러그인으로 항상 등록된다(`packages/core/src/plugin/internal.ts:89,216`, `plugin-browser/src/index.ts:6-13`). 도구는 attachment와 상관없이 등록되지만(`tools.ts:33-56`), **v2.0.24(82bb5ff88a)부터 카탈로그에는 붙은 데스크톱이 있을 때만 보인다**: 플러그인이 모든 에이전트 권한 끝에 `{browser, *, deny}`를 붙이고, attach가 그 세션 권한 끝에 `{browser, *, allow}`를 더했다가 release 때 뗀다(`connection.ts` `grant`). 붙어 있다가 끊긴 뒤의 호출은 `[browser.disconnected]`로 빨리 실패한다. 그 전(v2.0.18)에는 붙은 데스크톱이 없어도 카탈로그에 있었다.
- 브라우저 도구는 모두 `codemode:true`이고(`tools.ts:50`), **설명이 있는 namespace `browser`**에 들어간다(`tools.ts:35-39`).
- **요청의 도구 정의(`definitions`)에는 Code Mode 도구가 들어가지 않는다.** `Tool.snapshot`의 `definitions`는 direct 도구(`codemode:false`)와 `execute` 하나뿐이다(`packages/core/src/tool.ts:234-259`). `execute`의 설명은 불변이다("Invariant model-facing guidance; the changing tool catalog is delivered through Instructions", `codemode/tool.ts:61`). 그래서 브라우저 도구를 권한 deny로 빼든 플러그인 제거로 빼든 요청의 `tools` 부분은 같다.
- 바뀌는 것은 Code Mode **카탈로그**이고, 카탈로그는 세션 Instructions로 간다(`session/context.ts:146-156`, `CodeModeInstructions.make`는 `:149`). 세션 권한은 agent 권한 뒤에 합쳐져(`context.ts:130-134`) 스냅샷과 카탈로그를 함께 좁힌다. `resource:"*"` deny는 도구를 스냅샷에서 뺀다(`tool.ts:229-231,292-295`). 규칙은 마지막 매칭이 이긴다(`tool.ts:293`).
- **카탈로그 변경은 기존 기록 뒤에 덧붙는다.** 세션의 첫 Instructions는 기준선(initial)이고, 그 뒤 값이 바뀌면 렌더한 문구를 durable `InstructionsUpdated` 이벤트에 얼려 기록에 더한다(`session/instruction-state.ts:41-60`). 앞부분은 다시 쓰지 않으므로 **기존 세션은 cold가 되지 않고**, 바뀐 지점까지의 prefix가 유지된다.
- **덧붙는 문구는 작은 delta가 아니라 전체 카탈로그 교체다.** 설명 있는 namespace가 생기거나 없어지면, 또는 카탈로그의 완전/부분 여부가 바뀌면 `update()`는 교체 문구("This catalog supersedes the previous Code Mode tool catalog" + 전체 카탈로그)를 돌려준다(`codemode/instructions.ts:32-48`). `browser`가 바로 설명 있는 namespace다. 또 인라인 예산이 2,000 토큰이라(`codemode/catalog.ts:50`) 도구 45개가 들어가면 카탈로그가 부분으로 바뀔 가능성이 크고, 이것도 교체를 부른다 ⚠(실제 크기는 G-D5에서 잰다). 이 문서 v0.1의 "delta 한 번"은 틀렸다.
- 세션 생성과 수정 API가 `permissions`를 받는다(`packages/protocol/src/groups/session.ts:228,363`). 효과는 `allow | deny | ask`다(`packages/schema/src/permission.ts:55`). 자식 세션은 생성 때 부모 권한을 복사한다(`packages/core/src/session.ts:273`).

**다른 문서 전제와 소스의 차이.**
- 02 D10 "도구 하나를 켜고 끄면 그 뒤 모든 세션의 모든 slot이 한 번 cold가 된다", 02 D10의 UI 문구 "모든 세션의 다음 요청에서 캐시가 한 번 다시 쓰입니다": Code Mode 도구에는 맞지 않는다. 기존 세션마다 교체 문구 1건이 **덧붙는다**(비용은 그 문구의 쓰기 토큰).
- 02 D10 "세션 단위 permission으로 끄지 않는다. 세션마다 prefix가 달라진다": 달라지는 것은 **세션 사이** 공유(세션마다 다른 카탈로그 기준선)다. 한 세션 안의 prefix는 안 D에서도 흔들리지 않는다.
- 01 §16.2 G-D5 "창을 바꿔도 요청 tool 정의 해시 불변": 어느 안에서나 참이다(`definitions`에는 `execute`만). 두 안을 가르는 기준이 되지 못하므로, 판정은 "카탈로그 기준선과 `InstructionsUpdated` 건수"로 해야 한다(14.1).
- 03 §18.15의 확인 문구 "도구 목록이 바뀌어 다음 요청에서 캐시를 처음부터 다시 씁니다": 틀렸다. "다음 요청에 도구 목록 문구(약 {n} 토큰)가 한 번 더해집니다"가 맞다.

**선택지.**

| 안 | 방법 | 기존 세션 | 새 세션 | 판단 |
|---|---|---|---|---|
| A | 항상 켬 | 변화 없음 | 모두 브라우저 있음 | 웹·모바일로 만든 세션의 모델이 쓸 수 없는 도구를 보고 헛호출한다. 결정 D2의 "웹 모드에서는 처음부터 끔"을 만족하지 못한다 |
| B | **설치 프로필**(01 §10.1, 02 D10): 웹 전용 설치는 own 전역 config로 처음부터 끔(`-opencode.browser` 또는 permission `browser: deny`), 데스크톱을 설치하면 켬 | 프로필을 바꾸면 모든 세션의 다음 요청에 교체 문구 1건씩 | 한 설치 안에서 모두 같음 | 한 설치 안의 모든 세션 카탈로그가 같아 세션 사이 공유가 가장 크다. 데스크톱이 설치된 PC에서 웹 폴백·모바일로 만든 세션은 쓸 수 없는 도구를 본다(호출은 빨리 실패) |
| C | 전역 config를 클라이언트 모드마다 바꿈 | 모든 세션이 모드 전환마다 교체 문구 | – | 서비스가 하나라 데스크톱 세션에서도 사라진다. 기각 |
| **D** | **세션 생성 때 호스트 capability로 세션 권한 새김**(03 §18.15) | 변화 없음. 다른 모드에서 열어도 그대로 | 만든 호스트에 따라 다름 | 결정 D2 문구를 그대로 만족한다(웹·모바일에서 만든 세션은 처음부터 없음). 켜기는 그 세션에만 교체 문구 1건. 대가: 데스크톱·웹에서 만든 세션의 카탈로그 기준선이 달라 세션 사이 공유가 갈리고, 세션 권한을 읽고-고치고-쓰는 코드가 든다 |

**이 문서의 권고는 안 D다.** 이유는 셋이다. (1) 결정 D2의 문구("웹 모드에서는 처음부터 끔")를 설치 단위가 아니라 세션 단위로 만족한다. (2) 위 소스 사실로 B를 고른 비용 논거(세션 권한 → cold)가 약해졌다. (3) 모바일(결정 D3)로 만든 세션이 쓸 수 없는 도구를 보지 않는다. 세션 사이 공유가 줄어드는 대가는 데스크톱이 주 클라이언트라 작다고 본다.

**결정 전 규칙.** P3·P4에서는 어느 장치도 만들지 않는다: 세션 생성 어댑터에 브라우저 권한 규칙을 넣지 않고, 설치기·launcher에 브라우저 프로필 설정을 넣지 않는다. 그동안은 안 A처럼 동작한다(도구는 항상 있음, 패인이 없으면 호출 실패). B로 정해지면 아래 규칙, 14.1의 G-D5 시나리오, 16장 "브라우저 도구" 행을 설치 프로필로 바꿔 쓴다(바꿀 곳 목록은 17.1).

**규칙(안 D로 정해질 때).**
1. own-web의 세션 생성 어댑터는 `host.has("browser.pane")`이 거짓이면 `permissions`에 `{action:"browser", resource:"*", effect:"deny"}`를 넣는다. 참이면 아무것도 넣지 않는다(upstream 기본 동작을 따름).
   - **MBR(2026-11-20) 개정.** 기기(게이트웨이를 거친 휴대폰·다른 PC)는 PC의 데스크톱 앱이 돌고 있으면(`own.remote` `browser.status`) deny를 넣지 않는다. 그 대화의 패인은 데스크톱 창이 요청을 받아 붙인다(8.10.4, 8.10.5). 웹 폴백(`own open --browser`)과, 앱이 꺼져 있을 때의 기기는 그대로 deny다(`policy/browser.ts` `browserPaneHeld`).
2. 이미 있는 세션의 권한은 클라이언트 모드 때문에 **자동으로 바꾸지 않는다.** 데스크톱에서 만든 세션을 휴대폰에서 열어도 카탈로그는 그대로이고, 도구 호출은 `[browser.disconnected]`로 빨리 실패한다.
   - **v2.0.24(82bb5ff88a)부터.** plugin-browser가 모든 에이전트 끝에 `browser * deny`를 붙이고, attachment가 있는 동안만 세션 권한 끝에 `browser * allow`를 더했다가 뗀다. 그래서 (1) 데스크톱 세션도 붙은 데스크톱이 없으면 카탈로그에 브라우저가 없다(위 "빨리 실패"는 이제 "보이지 않음", workspace e2e `browser tool policy`가 확인). (2) 규칙 1의 deny가 있는 세션에 attach하면 뒤에 붙는 allow가 deny를 이겨 도구가 생긴다. own-web은 세션 정보(규칙)를 읽은 뒤, 제거되지 않은 세션에만 attach한다(`src/browser/attach.tsx`, `index.tsx`, 턴 시작 때 깨우기도 같음). (3) **처리함(v2.0.24 sync 리뷰).** own-accounts의 쓰기(`replace`, `withBrowserTool`, `withComputerUse`)는 attach allow를 지우지 않고, 읽기는 그것을 건너뛴다: `modeOf`는 own 묶음 뒤에 붙은 `{browser, *, allow}`를 빼고 모드를 읽으며, 끼워 넣는 규칙(컴퓨터 allow, 생성 deny)은 own 묶음과 attach allow 앞에 들어간다(`packages/own-accounts/src/switching/approval.ts` `BROWSER_ATTACH_ALLOW`). 그래서 attach된 데스크톱 세션도 승인 모드가 `custom`으로 바뀌지 않고, 컴퓨터 사용 스위치·브라우저 켜기·own-team 교체의 모드 승계가 그대로 된다. `browserTool:"off"`만 예외로 attach allow를 함께 지운다(남기면 deny 뒤에서 이김). own-web의 승인 알약은 attach allow 하나뿐인 세션을 `기본`으로 센다(`requests/approval.ts` `chosenRules`). 남는 것: 플러그인의 grant·release와 `session.approval.set`이 둘 다 읽고-고치고-쓰므로 거의 같은 순간이면 한쪽 쓰기가 다른 쪽을 덮을 수 있다(드묾, 고치지 않음).
3. 웹에서 만든 세션을 데스크톱에서 열면 패인 자리에 `이 대화는 브라우저 도구 없이 시작했어요. [이 대화에서 켜기]`를 보이고, 대화 위 안내도 같은 말을 한다(켤 수 있으면 여기서 켜고 캐시는 유지된다는 것, 아니면 이유, 03 §18.15 규칙 3). 누르면 라우터 `session.approval.set{sessionID, mode:<지금 모드>, browserTool:"on"}`으로 그 규칙만 뺀다(세션 규칙의 쓰기 주체는 라우터 하나, 03 §16.3. own-web은 `PATCH …{permissions}`를 부르지 않는다). 라우터는 다른 규칙("항상 허용"으로 저장된 것, 누가 일부러 넣은 `browser` deny 등)을 지우지 않게 **읽고-고치고-쓰고**, 끝나지 않은 자식에도 같이 쓰며, 결과의 `browserTool`로 쓴 뒤의 상태를 돌려준다. 지금 모드가 `custom`이면 부를 수 없으므로 패인과 대화 위 안내는 그 이유(`승인 모드가 ‘사용자 지정’이라 이 대화에서는 켤 수 없어요. 필요하면 새 대화를 만드세요.`)만 보인다. 패인의 주소 칸에 주소를 넣어도 같은 확인(`켜고 열기`)으로 가고, 켜진 뒤 그 주소를 새 탭으로 연다(03 §18.17 주소 칸, BA 2026-10-18). 켜지 않은 채로는 사용자가 직접 여는 탭도 없다: 탭 페이지는 attachment 안에서만 생기고 attach가 `browser allow`를 붙여 도구를 목록에 올리기 때문이다(위 2번). 결과는 그 세션 기록 뒤에 카탈로그 교체 문구 1건이 덧붙는 것이고, 앞 prefix는 유지된다. ⚠ 교체 문구의 크기와, 그 앞까지 `cache.read`가 유지되는지는 G-D5에서 01 G4 방식으로 잰다.
4. 승인 모드(03 §18.8)도 세션 `permissions`를 PATCH한다. 두 기능 모두 읽고-고치고-쓰기로 서로의 규칙을 보존한다.
5. 자식 세션은 생성 때 부모 규칙을 복사하므로 따로 처리할 것이 없다. 이미 있는 자식에는 3번이 전파되지 않는다(부모를 켠 뒤 새 자식부터).
6. TUI·`own run` 같은 다른 클라이언트가 만든 세션에는 규칙이 없다. v2.0.24부터는 붙은 데스크톱이 없으므로 카탈로그에 브라우저가 없다(2번의 v2.0.24 문단). 데스크톱 앱에서 그 세션을 열면 attach되어 도구가 생긴다(규칙 1의 deny가 없으므로).
7. **attach·detach의 캐시 비용(v2.0.24).** 도구가 attachment를 따라 보였다 사라지므로, step 경계를 사이에 두고 attach나 detach가 일어날 때마다 그 세션 기록 뒤에 Code Mode 카탈로그 교체 문구 1건(`InstructionsUpdated`)이 덧붙는다(앞 prefix는 유지). 위 안 D 비교의 "켜기는 그 세션에만 교체 문구 1건"은 이제 하한이다: 창 닫기·다시 열기, 서비스 재시작, 유휴 축출 뒤 깨우기마다 1건씩 더해질 수 있다. own-web은 보고 있는 세션과 턴이 시작된 세션만 붙이고(`attach.tsx`) 다른 세션을 일부러 떼지 않아 횟수를 줄인다. 실제 크기와 건수는 G-D5 재측정 항목이다 ⚠.
- [gap] #15("나중에 켜거나 끄면 prefix를 다시 쓴다")는 위 사실에 따라 "그 세션 기록 뒤에 카탈로그 교체 문구 1건이 덧붙고 앞 prefix는 유지된다"로 고친다(17장).

**팀 모드의 받아들이기(06, T2): 세션 도구 세트의 예외.** 위 2번("이미 있는 세션의 권한은 자동으로 바꾸지 않는다")은 클라이언트 모드 때문에 바꾸지 않는다는 뜻이다. 팀 모드가 진행 중 프로젝트를 받아들일 때는 사용자가 고른 명시적 동작(팀 모드 켜기, `팀에 넣기`)이 그 대화의 도구 세트를 바꾸는 유일한 예외이고, 같은 사실(Code Mode 카탈로그 갱신은 덧붙고 앞 prefix는 유지)에 기대 비용을 한 번으로 묶는다(02 §4.3 D10, 06 §2.8·§3.7).
- **켤 때·`팀에 넣기` 때는 0.** 그 폴더의 대화를 담당으로 등록만 하고 권한·지시 항목·프리셋·승인 모드를 쓰지 않는다. 그 대화는 사용자에게 이전과 똑같다.
- **첫 메인 요청 때 1.** own.team이 그 대화의 권한을 읽고-고치고-써서 팀 도구 allow(`team.owner`, `team.member`)만 더하고, 바로 own-accounts `session.approval.set{sessionID, mode:<지금 모드>}`를 다시 불러 승인 묶음과 보호 경로 deny를 맨 뒤에 둔다(3번과 같은 쓰기 규칙. `computerUse`는 넘기지 않으므로 그 대화의 컴퓨터 allow는 그대로). 지시 항목 `own.team.role`과 팀 문맥 바인딩도 이때 붙는다. 결과는 다음 step 경계의 지시 갱신 1건이다: `team`은 설명 있는 namespace라 위 사실대로 작은 delta가 아니라 카탈로그 교체 문구이고, 앞 prefix는 그대로다. 대화가 크더라도 바꾸지 않고 이어 쓴다.
- **빼기·되돌리기는 붙인 것만 뗀다.** `팀에서 빼기`나 켜기·`팀에 넣기` 되돌리기는 붙인 세션에 교체 문구 1건, 아직 붙지 않은 세션에는 0이다. 같은 회사의 다른 구독 계정을 쓰던 대화(R4 예외)는 팀 계정의 새 대화로 이어 가므로 옛 대화에는 아무것도 쓰지 않는다.
- 자식 세션은 5번과 같다(이미 있는 자식에는 전파하지 않음). 팀이 아닌 세션과 팀이 만든 메인·담당은 0이다(06 TG16, 브라우저 규칙과 같은 판정: 카탈로그 기준선과 `InstructionsUpdated` 건수).

### 8.8 UI 참고

- 패인 UI의 재사용 계획은 **03 §18.17이 기준**이다: upstream `packages/app/src/session/browser/pane.tsx`(384줄), `model.ts`, `connection.ts`, `attachments.ts`를 vendor하고 어댑터(`usePlatform().browserPane` → `host.browserPane`)를 붙인다. 이 문서 v0.1의 "import하지 않고 새로 쓴다"는 버린다. 01 §10.1의 "own-web은 패인 UI를 새로 만듭니다"도 같은 이유로 고치기를 요청한다(17장).
- 패인 구성: 탭 줄, 주소 칸(보고 있는 탭이 있으면 `command{navigate}`, 탭이 없으면 `command{tabs.open, url}`. 주소가 아닌 글은 Google 검색. 패인의 모든 상태에서 보이고, 열 수 없는 상태에서는 읽기 전용으로 이유를 한 줄로 보인다. 03 §18.17 주소 칸), 뒤로·앞으로·새로 고침, 에이전트 동작 표시, 닫힘 이유 배너, 파일(캡처·다운로드) 목록, (안 D일 때) `이 세션에서 켜기`(8.7).
- 문구와 배치, 네이티브 뷰 겹침 규칙은 03(§4.7.2, §18.17)이 기준이다. 8.5는 셸 쪽 동작만 적는다.
- (ab31dc31dd, 2026-09-29부터) 브라우저는 작업 패널의 탭이 아니라 가운데 워크스페이스의 `채팅 | 브라우저 | 노트` 탭이다(own-web `src/shell/workspace.tsx`). 작업 패널의 탭 머리 `●`(`src/browser/badge.tsx`, 03 §4.7)는 작업 패널이 브라우저 탭을 더 이상 나열하지 않아 보이지 않는다(아래 8.9).
- **`노트` 탭은 PC 서비스에 저장한다(NOTES, 2026-10-09).** 프로젝트 폴더가 정해진 워크스페이스의 노트는 브라우저 localStorage가 아니라 이 PC 서비스의 own-accounts `notes.*`(02 §9.2)에 둔다(own-web `src/notes/workspace-store.ts`, `workspace-transport.ts`). 그래서 데스크톱 앱, 게이트웨이를 거친 휴대폰(`/srv/local`), 이 PC에 연결한 다른 PC의 원격 PC 창(08 §4.1)이 같은 노트를 보고, 앱 데이터를 지워도 노트는 남는다. SSH 원격 프로젝트의 노트도 원격 호스트가 아니라 이 PC에 둔다(원격 서비스의 own-accounts는 `notes.*`에 `remote_managed`로 답한다).
  - **워크스페이스 키.** 이 PC의 프로젝트는 `local:<폴더>`, SSH 원격 프로젝트는 `ssh:<hostId>:<원격 폴더>`다(`@own/protocol/notes` `Notes.workspaceKey`). 폴더는 한 가지 표기로 맞춘다: Windows 경로(드라이브, `\\서버\공유`)는 `\`와 소문자, POSIX 경로는 대소문자 그대로이고, 겹친 구분자·`.`·`..`·끝 구분자를 정리한다. 데스크톱·휴대폰·다른 PC 창은 모두 서버 키(`local` 또는 호스트 id)와 서비스가 알려 주는 폴더로 키를 만들므로 같은 노트에 닿는다. 폴더를 아직 모르는 화면(프로젝트를 열지 않은 홈 등)은 키가 없어 이전처럼 이 브라우저에만 저장하고, 바닥줄이 `이 기기에만 저장`이라고 알린다.
  - **저장.** 마지막 입력 350 ms 뒤, 그리고 탭을 닫거나 페이지가 숨을 때 곧바로 `notes.put`을 보낸다. 저장마다 시작한 revision(`baseRev`)을 붙이고, 다른 기기가 먼저 저장했으면 덮어쓰지 않고 `다른 곳에서 노트가 바뀌었습니다 [새 내용 불러오기] [내 내용으로 저장]`을 보인다(지워졌으면 `다른 곳에서 이 노트를 지웠습니다 [내 내용 버리기] [내 내용으로 저장]`). 그동안 그 노트는 저장하지 않는다. 클라이언트 전송에는 keepalive가 없으므로, 보내지 못한 편집은 페이지가 숨을 때와 저장이 실패하는 동안 localStorage(`own.web.notes.unsent.<키>`)에 두었다가 다음 로드에서 보낸다(그사이 PC의 노트가 바뀌었으면 같은 충돌 안내). 상태 줄은 `PC에 저장됨`·`저장 중…`·`저장 실패 [다시 저장]`이다.
  - **다른 기기의 변경.** `rpc.own.accounts.notes.changed{workspace, id, rev}`(제목·내용 없음)를 받으면 목록과, 저장하지 않은 편집이 없는 열린 노트를 다시 읽는다. 재연결 뒤에도 같고, 기다리던 편집을 그때 보낸다.
  - **창마다 남는 것.** 어떤 노트를 탭으로 열었는지와 활성 탭만 창 배치로 localStorage(`own.web.notes.view.<창 키>.<워크스페이스 키>`)에 둔다. 탭을 닫아도 노트는 지워지지 않는다. 지우기는 `노트 삭제`(확인 뒤 `notes.remove`, 연결한 모든 기기에서 사라짐)다.
  - **이전 노트 옮기기(한 번).** 워크스페이스를 처음 열 때 PC에 그 워크스페이스의 노트가 없고 이 브라우저에 이전 노트(`own.web.notes.<이전 워크스페이스 키>`)가 있으면 id·제목·내용 그대로 올리고 `own.web.notes.migrated.<키>`에 표시한다. 이전 값은 지우지 않고 백업으로 둔다. PC에 이미 노트가 있으면 합치지 않는다: 다른 기기들이 보는 것은 PC의 노트이고, 합치면 다른 기기에서 지운 노트가 되살아나거나 양쪽에서 고친 노트가 둘이 될 수 있다. 이 브라우저의 노트는 백업으로 남는다. 옮기다 끊기면 다음 로드에서 빠진 노트만 이어 올린다. 서비스 한도(제목 200자, 내용 200,000자)를 넘는 노트는 옮기지 않고 그 수를 알린다.
  - **범위.** 게이트웨이 기기는 `read`로 목록과 노트를 읽고 `prompt`로 저장·삭제한다(13.5). `prompt`가 없는 기기의 노트 탭은 읽기 전용이다.

### 8.9 v2.0.24 확인 (2026-10-08)

- **자동.** own-desktop 단위 99개(내장 목록이 `["browser"]`, 관리자가 설치를 거부, 빌드 산출물에 업데이터·SSH·WSL·pairing 코드 없음, rpcHash 입력), own-web 단위 1270개(desktop host 어댑터: configure → register, binding별 이벤트, embed 배치·숨김·`load`, capture, 거부의 닫힘 이벤트 변환, 확장이 사라질 때 `suspended`), `check-surface` 216개 통과.
- **패키지 셸 G-D5(`scripts/browser-agent.ts`, 이 PC, win-unpacked, 가짜 provider).** 33개 중 32개 통과: attach 1초 안팎, 에이전트의 `tabs.open → snapshot → screenshot`(이미지 파일이 서비스로 돌아옴) → `find → click → wait`, 페이지 권한 거부, 뷰 크기·확대 배율·`채팅`으로 바꿀 때 숨김, 닫기 확인(취소·수락), 멈추고 직접 조작, 다운로드(에이전트 목록, 셸 TEMP, 패인 목록, `PC에 저장`, 저장 안 한 파일 닫기 경고, 탭과 함께 지움), 웹에서 만든 세션의 도구 없음, 다시 로드 뒤 탭 복원, 창을 닫아도 턴 유지, 로그에 비밀 없음, 기계 상태 그대로. 실패 1개는 위의 `●` 배지다(브라우저 GUI 확장과 무관, ab31dc31dd 이후).
- **사용자 화면 확인이 필요한 것.** 다음 릴리스 빌드(`2.0.24-own.1`)를 설치한 셸에서: 패인의 탭·주소창·뒤로·새로 고침을 직접 써 보기, 오버레이(명령 팔레트·메뉴)가 패인을 가릴 때 정지 이미지로 바뀌는지, 창을 옮기거나 크기를 바꿀 때 뷰가 따라오는지, `PC에 저장` 대화상자. 시험 하네스는 패키지 셸이라 설치된 셸과 같은 userData(`%APPDATA%\dev.own.opencode.desktop`)를 쓴다. 그래서 시험 뒤 설치된 앱이 시험 세션을 마지막 경로로 열 수 있다(`세션을 찾을 수 없음` 뒤 목록에서 다른 세션을 고르면 됨).

### 8.10 휴대폰·다른 PC에서 보는 패인 (MBR, 2026-11-20)

사용자 요청(2026-11-20): "모바일에서도 브라우저를 보게 해 주세요. 작업을 그때그때 확인해야 하는데 지금은 모바일에 브라우저가 아예 안 보여요." 결정 기록은 `own/handoff/decisions-2026-10.md` "The browser pane on a device (MBR, 2026-11-20)"이다. 계약(메시지, 한도, 프레임 머리)은 `@own/protocol/remote-browser`(`RemoteBrowser`)가 기준이고 이 절은 그 까닭과 규칙을 적는다.

#### 8.10.1 구조

```text
기기의 own-web(휴대폰 앱, 다른 PC의 원격 PC 창, 브라우저)        이 PC
 브라우저 보기(지연 chunk)                                  ┌ 서비스(own-remote 게이트웨이, 허브)
   │ WebSocket  /own/browser/local/<sessionID>             │   기기 인증 · 범위 `browser` · 세션 확인
   │  글: hello·view·ack·input·action →  ← ready·state·result·notice
   │  이진: ← JPEG 한 장(머리 16바이트 `OBF1`)              │
   └───────────── 기존 게이트웨이 연결(pin만 믿는 TLS) ─────┤
                                                           │ RPC own.remote browser.host.*  (`local`)
                                                           │   pull(긴 폴링) → {views, commands}
                                                           │   frame · state · result ←
                                                           └ 데스크톱 셸 main(own-desktop `remote-browser.ts`)
                                                               패인 탭의 CDP: Page.startScreencast / captureScreenshot,
                                                               Input.dispatch*, Emulation.*
        이벤트 rpc.own.remote.browser.pane.wanted(`local`) ─▶ 데스크톱 창의 own-web(`browser/attach.tsx`): 그 세션을 attach
```

- **새 포트는 없다.** 기기는 이미 쓰는 게이트웨이 리스너(브라우저용 28539, 앱용 28540)의 경로 하나를 더 쓴다. 셸은 서비스의 loopback API를 서비스 비밀번호로 부른다(패인이 원래 쓰던 길). 게이트웨이가 셸에 붙는 길은 만들지 않는다.
- **역할.** 패인은 그대로 데스크톱 셸의 것이다(8.1). 허브는 프레임과 입력을 건네기만 하고 페이지를 해석하지 않는다. 기기는 탭·CDP·파일·터널 어느 것에도 직접 닿지 않는다: `rpc.experimental.browser.*`는 게이트웨이가 지금처럼 막는다(13.4 `unknown_rpc`, 이벤트 거르기).
- **SSH 호스트의 대화도 대상이다(SB, 2.2.6-own.14).** 그 패인도 이 PC의 데스크톱 셸에 있다(8.6). 소켓 경로의 `<serverKey>`가 호스트 id가 된다(8.10.8). 이 판 전(MBR)에는 `local`만 받았다.

#### 8.10.2 권한 (기기 범위 `browser`)

- **새 기기 범위 `browser`**(13.5 표). `설정` > `휴대폰·다른 PC`의 기기 줄과 새 기기 연결 대화상자에 `브라우저` 칸으로 보인다. **기본은 꺼짐**이다: 이미 페어링한 기기는 범위 목록에 없으므로 꺼져 있고, 새 기기의 기본 범위(`DEFAULT_DEVICE_SCOPES`)에도 넣지 않는다. PC에서 사용자가 켜야 한다(`devices.update`는 `local`이라 기기가 스스로 켤 수 없다).
  - 까닭: 패인은 메모리 전용 프로필이지만(8.3) 그 안에서 로그인한 사이트의 화면이 PC 밖으로 나간다. 지금까지 기기가 보던 것(대화 글, 도구 결과의 스크린숏)보다 넓다.
- **보기**는 `read` + `browser`, **조작**(입력, 주소·탭, 대화상자 답)과 **붙여 달라는 요청**(아래 8.10.4)은 거기에 `prompt`가 더 있어야 한다. 조작은 에이전트에게 시키는 것과 같은 무게이고(`prompt` 기기는 이미 에이전트로 같은 일을 시킬 수 있다), 넘겨받기는 턴 중단(`prompt`)이기 때문이다. `browser`만 있고 `prompt`가 없는 기기는 이미 붙어 있는 패인을 보기만 한다.
- **강제하는 곳은 게이트웨이다.** 소켓 승격 때 기기 인증, 쿠키 요청의 같은 origin(13.5 CSRF), `browser` 범위, 서버 `local` 허용, 세션이 이 PC 서비스에 있는지를 본다. 입력·동작 메시지는 허브가 그 연결의 `control`(승격 때의 `prompt`)로 거른다. own-web의 표시는 편의일 뿐이다.
- **끊김.** 범위·서버를 바꾸거나 기기를 폐기하면 게이트웨이가 그 기기의 모든 연결을 닫는다(13.5, `#closeDevice`). 보기 소켓도 거기 등록되므로 닫히는 즉시 허브에서 빠지고 다음 pull의 `views`에서 사라져 셸이 캡처를 멈춘다(실측: 범위를 뺀 뒤 216 ms에 캡처와 에뮬레이션이 꺼짐). 만료(30일, 14일 미사용)는 프레임, 상태, 들어온 메시지마다 기기 기록으로 다시 본다(메모리, I/O 없음).
  - 닫는 코드(`RemoteBrowser.CLOSE`): `4401` 폐기, `4403` 범위·서버 변경 또는 만료(뷰어는 기기 정보를 다시 읽고, `browser`가 남아 있으면 다시 붙는다), `4400` 계약 위반(잘못된 메시지, 이진 메시지, 10초 안에 `hello` 없음), `4410` 게이트웨이가 닫히는 중, `1013` 뷰어가 너무 많음(기기당 4, 모두 16).
  - 승격 전의 거절(401, 403 `scope_denied`, 404 `browser_unavailable`·`session_not_found`, 426)은 브라우저의 `WebSocket`에 보이지 않으므로, own-web은 붙기 전에 자기 범위와 세션을 보고 화면을 정한다.
- **세션 범위.** `read` 기기는 허용된 서버의 모든 세션을 본다(13.5). 브라우저도 같다: 그 서버(`local` 또는 이 PC의 SSH 호스트)가 허용된 기기만, 그 서버에 있는 세션만(8.10.8).
- **`devices.json`.** 예전 빌드가 모르는 낱말이 `scopes`에 있으면 파일 전체를 못 읽어 기기가 모두 사라지므로, 새 범위는 `extraScopes`에 따로 적는다(`OwnRemote.EXTRA_DEVICE_SCOPES`). 예전 빌드로 되돌리면 그 범위만 없어진다(닫힌 쪽으로 실패).
- **감사.** 보기 소켓의 열림·닫힘은 감사 저널과 `own-remote.log`에 기기·세션 id로 남는다(`browser_view_opened`·`_closed`). 주소, 화면, 입력 내용은 남기지 않는다.

#### 8.10.3 프레임과 입력

- **무엇을 보내나.** 그 세션의 **포커스된 탭** 하나다. 탭을 고르면 포커스가 바뀌고(데스크톱 패인과 같은 포커스) 그 탭이 온다. 탭 목록, 주소, 뒤로·앞으로 가능 여부, 불러오는 중, 열린 JavaScript 대화상자, 지금 viewport는 `state`로 온다.
- **캡처(셸 main).** 탭 페이지의 CDP(`webContents.debugger`, upstream이 이미 붙여 둔 것)의 `Page.startScreencast`로 찍는다. 패인 탭은 창의 자식 뷰이고 `backgroundThrottling:false`라, 한 번이라도 화면에 나왔던 탭은 **창이 다른 대화를 보이거나 최소화·트레이에 숨겨져 있어도** 프레임이 온다(실측 8–10장/초).
  - **화면에 나온 적이 없는 탭**(사용자가 없는 동안 에이전트가 연 탭)은 표시 표면이 없어 screencast도 스크린숏도 아무것도 주지 않는다. 보이는 창에서는 스크린숏 한 번이 깨우지만, 숨기거나 최소화한 창에서는 셸이 그 탭의 뷰를 화면 밖의 캡처 창(테두리·작업 표시줄·포커스 없음)에 빌려주고, 앱 창이 다시 보이거나 보기가 끝나면 돌려준다(`remote-surface.ts`). 첫 로드가 2초 안에 끝나지 않은 탭도 같은 길로 빌려준다: 트레이에 숨은 창에서 처음 만든 탭은 Chromium이 숨었다고 알리지 않을 수 있다.
  - 기기가 보는 동안 그 페이지는 PC 창이 어떻든 `visibilityState: "visible"`로 돈다.
  - **커서 깜빡임.** 깜빡이는 글자 커서는 0.5초마다 그림을 바꿔 `REST_MS`보다 짧으므로, 포커스된 입력 칸은 쉬지 못하고 빠른 프레임만 받았다(약 12 KB/초). 보는 동안 그 페이지에 사용자 스타일 `caret-animation: manual`을 넣어 커서를 멈춘다(이동마다 다시 넣고, 보기가 끝나면 뺀다, `remote-caret.ts`). 실측: 쉬는 입력 칸 3초에 0장 0바이트, 마지막은 선명한 장.
- **적응.** 보는 쪽이 그린 프레임을 `ack`로 알리고, 셸은 앞 프레임이 확인될 때까지(최대 `ACK_TIMEOUT_MS` 2초) 다음 것을 보내지 않는다. 느린 연결은 저절로 초당 장수가 준다. 뷰어가 여럿이면 가장 먼저 그린 뷰어의 `ack`로 다음 프레임이 나가고, 허브가 세션마다 가장 새 프레임을 들고 있다가 늦은 뷰어가 앞 것을 확인하면(또는 새로 붙거나 다시 보이면) 그것을 준다. 느린 기기 하나가 다른 기기를 붙잡지 않고, 쉬는 페이지의 마지막 선명한 장도 빠뜨리지 않는다. 페이지가 바뀌는 동안은 빠른 프레임(긴 변 720 px, JPEG 55), `REST_MS`(450 ms) 동안 바뀌지 않으면 선명한 한 장(긴 변 1600 px까지, JPEG 80)을 보내고 다음 변화까지 쉰다. 보는 기기의 실제 픽셀보다 크게는 보내지 않는다(`frameScale`). `데이터 절약`(`quality:"low"`)은 긴 변 540 px, JPEG 45에 선명한 장 없음. 화면이 그대로면 아무것도 보내지 않는다.
- **보일 때만.** 보기 화면이 가려지거나(다른 화면, 앱이 뒤로 감, 화면 꺼짐: `visibilitychange`) 닫히면 `view{visible:false}` 또는 소켓 닫힘으로 알리고, 허브는 보이는 뷰어가 없는 세션을 `views`에서 뺀다. 셸은 pull이 15초 넘게 실패해도 모든 캡처와 에뮬레이션을 스스로 끈다.
- **입력.** 좌표는 프레임의 0–1 비율이다. 휴대폰은 `touch`(페이지가 진짜 터치를 받는다: 스크롤, 탭, 쓸기), PC 뷰어는 `mouse`·`wheel`. 글은 숨은 입력 칸의 변화를 `RemoteBrowser.typed`가 `compose`(조합 중인 글자, 페이지에 밑줄로 보임) · `text`(확정) · `key`(Backspace 등)로 바꾼다. 소프트 키보드는 키 코드를 주지 않으므로(모두 229) 칸의 글 차이로 보낸다. 셸은 `Input.dispatchTouchEvent`·`dispatchMouseEvent`·`dispatchKeyEvent`·`imeSetComposition`·`insertText`로 넣는다.
- **넘겨받기는 데스크톱과 같다.** 에이전트가 조작 중이면 `에이전트가 조작 중 · <동작>`과 `멈추고 직접 조작`을 보인다. 누르면 그 대화의 턴을 멈춘다(`prompt`). 휴대폰은 화면이 곧 입력면이라, **에이전트가 조작하는 동안에는 페이지 입력과 주소·탭 조작을 보내지 않는다**(지켜보다 닿은 손가락이 에이전트의 작업을 흔들지 않게). 데스크톱보다 한 단계 엄격한 점이다.
- **비밀번호 칸.** 데스크톱에서 직접 조작할 때와 같다: 따로 가리거나 막지 않고, 입력은 TLS 안에서 PC로 가 페이지에 들어간다. 허브와 셸은 입력 내용을 기록하지 않는다. 설명서의 주의(진짜 계정 비밀번호를 넣지 말 것, 19장)가 그대로 적용된다.
- **기기로 넘기지 않는 것.** 다운로드는 지금처럼 PC의 임시 폴더에만 남고(8.4) 기기에는 `PC에서 저장할 수 있어요` 알림만 간다. 파일 선택 창은 원격 조작 중에는 가로채 취소하고(`Page.setInterceptFileChooserDialog`, PC 화면에 주인 없는 대화상자가 뜨지 않게) 알림만 보낸다. 페이지의 권한 요청은 언제나 거부다(8.3). JavaScript 대화상자는 기기에서 `확인`·`취소`로 답할 수 있다(`prompt` 기기, 에이전트의 `browser.dialog`와 같은 동작).

#### 8.10.4 붙이기: 창이 보지 않는 세션의 패인

- **hosted는 pull로만 안다.** 허브는 셸이 pull에 실어 보내는 `hosted` 목록으로만 어느 세션이 붙어 있는지 안다. 그래서 셸은 붙은 세션이나 창 수가 바뀌면 기다리던 pull을 두고 곧바로 새 pull을 보낸다(허브는 앞의 것을 바로 답한다). 뷰어의 `attaching → ready`와 프롬프트 중계의 3초 기다림이 여기에 달려 있다. 볼 수 있는 기기가 하나도 없으면(`idle`) 셸은 15초마다 가볍게 묻고, 60초 동안 pull이 없으면 허브는 데스크톱이 없다고 본다.
- attachment는 여전히 데스크톱 창의 own-web만 만든다(8.2 "세션당 하나", 소유는 창). 허브가 필요할 때 `browser.pane.wanted{sessionID}`(`local` 이벤트)를 내고, 데스크톱 창의 `browser/attach.tsx`가 그 세션을 `attachable`(규칙을 알고, 8.7 규칙 1의 deny가 없음)이면 붙인다. 창이 시작하거나 다시 연결되면 `browser.pane.wanted`(메서드)로 지금 바라는 목록을 읽는다. 창은 하나다(`multiWindow:false`).
- 허브가 바라는 때: (1) `prompt`가 있는 기기가 붙지 않은 세션의 보기를 열었을 때, (2) **기기의 프롬프트를 중계하기 직전**(아래 8.10.5).
- 셸 main은 붙은 세션 목록을 pull마다 알린다(`hosted`). 데스크톱 앱이 없으면(`absent`) 기기는 `PC의 데스크톱 앱이 꺼져 있어요`를 본다. 앱이 트레이에 숨어 있는 것은 켜져 있는 것이다(7.3: 숨긴 창은 렌더러와 탭이 그대로).

#### 8.10.5 기기에서 만든 대화의 브라우저 도구 (8.7 규칙 1의 개정)

- **왜 없었나.** 8.7 안 D: own-web이 패인 없는 창에서 만든 세션에 `browser * deny`를 새겼다. 쓸 수 없는 도구를 모델이 보지 않게 하려는 것이었고, 그때는 기기에서 만든 대화의 패인을 붙여 줄 것이 없었다.
- **새 규칙(least surprise).** *브라우저 도구는 대화를 만든 기기가 아니라, 그 대화의 패인을 맡을 데스크톱 앱이 PC에서 돌고 있는지를 따른다.*
  1. 기기의 own-web은 새 대화를 만들 때 `browser.status`가 `desktop:true`이면 deny를 넣지 않는다. 모르거나 `false`면 지금처럼 넣는다.
  2. 게이트웨이는 기기의 프롬프트(`POST …/prompt`)를 중계하기 전에, 데스크톱 앱이 있고 그 세션이 아직 붙지 않았고 deny가 없으면(세션 규칙을 읽어 `whollyDisabled("browser")`와 같은 판정) 붙이기를 바라고 최대 3초 기다린다. 붙으면 그 step부터 도구가 목록에 있다. 못 붙으면 그대로 보낸다.
  3. 그래서 데스크톱에서 만든 대화를 휴대폰에서 이어 갈 때도, 휴대폰에서 만든 대화도, PC의 앱이 켜져 있으면 에이전트가 브라우저를 쓴다.
- **캐시.** 바뀌는 것은 없다: 도구는 attach를 따라 보이고(8.7 규칙 2, 7), attach·detach가 step 경계를 넘을 때마다 그 세션 기록 뒤에 카탈로그 교체 문구 1건이 덧붙으며 앞 prefix는 유지된다. 기기에서 만든 대화도 이제 데스크톱에서 만든 대화와 같은 비용 모델을 가진다. 만들 때 앱이 꺼져 있던 대화는 지금처럼 `브라우저 도구 없이 시작`이고, `이 대화에서 켜기`(8.7 규칙 3)로 켠다. **기기에서도 `prompt`면 켤 수 있다**: `session.approval.set{mode, browserTool:"on"}`의 범위를 `admin`에서 `prompt`로 내렸다(`OwnRouting.scopeOf`). 새 대화가 이미 같은 도구를 받으므로 옛 대화에만 더 엄격할 까닭이 없다. 끄기(`"off"`)와 컴퓨터 사용은 `admin` 그대로, 내 브라우저 사용 켜기는 `local` 그대로다.
- **에이전트의 능력은 늘지 않는다.** 같은 `browser.*` 도구, 같은 권한 이름 `browser`, 같은 승인 모드다. 기기 범위 `browser`는 **기기가 보고 조작하는 것**만 정하고, 에이전트의 도구와는 무관하다(범위 없는 기기의 대화도 2번을 받는다: 지금도 그 기기는 데스크톱이 붙여 둔 대화에서 에이전트에게 브라우저를 시킬 수 있다).

#### 8.10.6 휴대폰 크기로 보기

- `휴대폰 크기로 보기`를 켜면 셸이 그 탭에 보는 기기의 viewport(CSS px, 배율)를 에뮬레이션한다: `Emulation.setDeviceMetricsOverride{mobile:true}`, 터치, 모바일 사용자 에이전트. 에이전트가 만든 화면의 모바일 배치를 그 자리에서 본다. 에이전트의 도구도 그 크기로 본다(같은 탭이므로).
- 끄거나, 마지막 뷰어가 닫거나 가려지거나, 셸이 허브를 잃으면 셸이 에뮬레이션을 지운다. **PC 패인이 휴대폰 크기로 남지 않는다.** 탭 페이지를 다시 만들면(복원) 에뮬레이션은 원래 없다.
- `PC 크기`(기본)는 패인의 크기 그대로를 줄여 보이고, 두 손가락으로 확대·이동한다(보는 쪽에서만, 페이지에는 가지 않는다).

#### 8.10.7 시험과 실측

**실측(2026-11-21, 진짜 셸, 시험 userData, 30 fps로 바뀌는 페이지, 뷰어 390×800@3).** 마지막 실행 61/61 통과. CPU는 셸 main 프로세스 / 프로세스 트리, 한 코어의 %.

| 경우 | 장/초 | 평균 크기 | CPU |
|---|---|---|---|
| 화면에 보임 | 9.7 | 12.1 KB | 23.5 / 49.1 |
| 아무도 안 봄(기준) | – | – | 5.4 / 19.7 |
| 창이 다른 대화를 보임 | 8.9 | 12.1 KB | 25.7 / 43.5 |
| 창 최소화 | 7.9 | 12.4 KB | 21.1 / 39.8 |
| 트레이에 숨김 | 9.3 | 12.5 KB | 24.7 / 43.8 |
| 숨긴 창에서 처음 만든 탭(빌려줌) | 9.0 | 8.0 KB | 27.9 / 55.1 |

- 쉬는 페이지의 선명한 장 692×903 16.8 KB, 빠른 장 386×504 5.5 KB. 쉬는 동안은 0.
- 창이 보이지 않던 세션을 기기가 열 때 `attaching → ready`: 창 보임 114 ms, 최소화 1.2 s, 트레이 1.7 s.
- 기기 프롬프트 앞의 붙이기 기다림: 0–2.7 s(세 번 잼). 브라우저를 막은 대화는 16 ms에 중계.
- 범위를 뺀 뒤 소켓은 4403으로 닫히고 211 ms 뒤 PC 크기로 돌아옴.
- 보는 탭이 여럿 열려 있으면 앱 전체 CPU가 늘어난다(바뀌는 페이지 셋에 한 코어의 85–97 %, 아무것도 안 볼 때 약 20 %).

- 단위: `own-protocol/test/remote-browser.test.ts`(메시지 검사, 프레임 머리, 한글 조합, 프레임 크기), own-remote `test/gateway/browser-hub.test.ts`·`policy.test.ts`(허브, 범위).
- 게이트웨이: 범위 없음 → 거부, 보는 중 범위 철회·폐기 → 즉시 닫힘과 `views`에서 빠짐, 다른 서버·없는 세션 → 거부, `browser.host.*`는 기기에서 403.
- own-web Playwright(`e2e/mobile`, s23·fold8-cover·fold8-main): 가짜 프레임 원본(시험이 `browser.host.*`를 PC 권한으로 부른다)으로 열기, 입력 전송, 가려지면 멈춤, 휴대폰 크기 토글.
- 데스크톱: 시험용 userData의 셸과 시험 서비스에서 진짜 패인을 붙여 프레임(보이는 탭, 숨은 탭, 최소화한 창), 입력, 에뮬레이션과 그 해제.

#### 8.10.8 SSH 호스트의 대화 (SB, 2026-11-21)

- **경로.** `GET /own/browser/<hostId>/<sessionID>`(`RemoteBrowser.socketPath`). 게이트웨이는 `local`과 같은 검사(기기 인증, 쿠키의 같은 origin, `read`+`browser`, 그 서버가 기기에 허용됨)에 더해, `<hostId>`가 **이 PC의 레지스트리에 있는 호스트**인지 본다(`Policy.browserView{hosts}`). 아니면 404 `browser_unavailable`: 이 PC가 갖지 않은 서버의 대화는 열지 않는다. 호스트가 연결돼 있지 않으면 503 `host_unavailable`, 세션은 그 호스트의 서비스에 호스트 토큰으로 물어 있어야 한다(없으면 404 `session_not_found`).
- **허브의 이름.** 허브와 셸은 패인을 `RemoteBrowser.paneKey`로 부른다: 이 PC 세션은 세션 id 그대로, 호스트 세션은 `<hostId>/<sessionID>`. `views`·`commands`·`frame`·`state`와 `browser.pane.wanted`(이벤트, 메서드의 `hosts`)는 호스트를 선택적인 `serverKey`로 싣는다. 없는 것은 이 PC다. 그래서 이 판 전의 셸은 그대로 돌고(호스트 패인을 알리지 않으므로 그 뷰는 `attaching`에 머문다), 이 판 전의 허브는 `local`만 받는다.
- **붙이기와 프롬프트.** 허브가 호스트 세션을 바라면 데스크톱 창이 그 호스트 런타임에서 세션을 읽고(규칙 1·2 그대로) 붙인다. 호스트가 이 창에서 아직 연결되지 않았으면 붙이지 않고 다음 요청(5초마다)을 기다린다. 기기의 프롬프트가 호스트로 가기 전에도 8.10.5의 3초 기다림이 그 호스트의 패인에 대해 돈다(세션 규칙은 호스트에서 읽는다).
- **보기 화면.** own-web 뷰어는 대화의 서버 키로 소켓을 연다. 에이전트 동작 표시는 그 서버의 이벤트로 만든 추적기를 쓴다(`browser/remote/dock.tsx`가 기기가 보는 서버마다 하나).

---

## 9. 성능 (셸 쪽, 결정 D4)

**기준.** 예산 수치와 릴리스 게이트는 **01 §6.6(PF1–PF8)·§16.3**이 기준이고, 프런트엔드 구현 규칙과 측정 방법은 **03 §20**(예산 B1–B10, 규칙 R1–R11, 시험 PG1–PG8)이 기준이다. 이 장은 새 예산을 만들지 않는다. PF를 **패키지된 셸에서** 어떻게 재는지(01 §16.3: P4 종료부터 셸에서 PF1–PF8 전부)와, 셸에만 있는 점검 SC1–SC5를 정한다.

### 9.1 PF를 셸에서 재는 법, 셸 전용 점검

**PF1–PF8(기준 01 §6.6).** 수치는 01의 것을 그대로 쓴다.

| PF | 01의 예산(요약) | 셸에서 재는 법 | 셸 쪽 주의 |
|---|---|---|---|
| PF1 | 실행부터 1초 안에 세션 목록(캐시) | **판정(확정, P4 폴리시)**: 시작점 = `window.own.shell.startedAt`(셸 main 번들 첫 줄, T0-6) → 렌더러 mark `own:sessions-visible`, 웜 실행 p95 ≤ 1,000 ms. `own:sessions-visible`은 행이 들어온 뒤 rAF 2번이면서 **첫 contentful paint가 화면에 표시된 뒤**다(03 §20.3, own-web `perf/marks.ts`). rAF만으로는 렌더러가 프레임을 만든 시각일 뿐이라, GPU 프로세스가 아직 셰이더를 컴파일하는 동안 "보임"으로 찍혔다(실측: mark 360 ms, 실제 첫 표시 740 ms). 프로세스 spawn부터의 시간은 함께 기록하되 판정하지 않는다: 셸 코드가 돌기 전 Windows 프로세스 생성·검사가 들어가 한 실행에서 +600 ms까지 흔들렸다. 최신 목록 반영은 `own:sessions-fresh`로 기록(판정 없음). `packages/own-desktop/scripts/perf-shell.ts`(9.4): 웜 5–10회 + 콜드 3회, 첫 실행 버림, 세션 201개, 실행마다 부팅 분해(paint timing, long animation frame), `--trace`로 Chromium startup trace | 초기 요청 수(SC4), 5.5 `manifest.json` 동기 읽기, 첫 렌더 경로의 main 동기 호출(아래 R-D12, R-D13) |
| PF2 | 입력 지연 p95 ≤ 16 ms, 한글 IME 포함 | Event Timing, 유휴·스트리밍 중. 셸 안의 own-web에서 | preload·main이 입력 경로에 끼지 않음(R-D2, R-D10) |
| PF3 | 2,000 메시지 스크롤 60 fps | CDP trace, 창 1개와 창 3개(7.2) | 창 3개에서 연결 한도로 요청이 밀리지 않는지 함께 기록 |
| PF4 | 스트리밍 중 PF2·PF3 유지 | 같은 시나리오 + 스트리밍 | 스트리밍 IPC 0(SC3) |
| PF5 | 첫 번들 상한(01: gzip 400 KB ⚠) | own-web 빌드 산출물(셸과 무관) | 03 §20.1 B7(350 KB)과 수치가 다르다(17장) |
| PF6 | 시작 경합: 실행 뒤 90초 동안 50 ms 넘는 입력 이벤트 0 | Event Timing + long task, 셸 시작부터 | **창을 240초로 넓히자고 01에 요청**한다(9.3의 67 수치). 바뀌기 전까지는 90초로 판정하고 240초까지 기록한다 |
| PF7 | 캐시된 세션 전환 ≤ 100 ms ⚠ | upstream session-tab-switch 벤치 | – |
| PF8 | 숨은 창·유휴에 주기 타이머 0, CPU ≈ 0 | 창 숨김 10분, `app.getAppMetrics()` 1분 표본 | 브라우저 패인 탭은 예외(`backgroundThrottling:false`, 8.3) |

**셸 전용 점검 SC1–SC5(이 문서가 정함).** own-web이 아니라 셸 자체의 성질이라 PF에 없는 것만 둔다. 01이 원하면 PF 번호로 옮긴다(17장).

| 점검 | 필수 | 기준 | 측정 |
|---|---|---|---|
| **SC1** 첫 창 픽셀 | should | 실행 → `screenPainted` p95 ≤ 700 ms(서비스 떠 있음) ⚠ 초기값, DS0 기준선으로 조정 | `bench-startup.ts` 화면 샘플링 |
| **SC2** 크기 | must | 설치 파일 ≤ 150 MB(처음 목표. 서비스 payload를 넣은 뒤 `build-desktop.ps1`의 기준은 SSH 원격 묶음과 함께 ≤ 470 MB, 없이 ≤ 260 MB. 2026-10-31 Bun 1.4.4의 런타임이 29 MB 커져 400 → 470, MR8-27), 설치 후 ≤ 460 MB, 렌더러 소스맵 0 | 10.3 |
| **SC3** 스트리밍 IPC | must | 1,000 delta 스트리밍 동안 렌더러↔main IPC 메시지 증가 0 | IPC 카운터 |
| **SC4** 초기 요청 수 | must | 첫 페인트까지 `oc://renderer` 요청 수 ≤ 5(HTML, 진입 JS 1–2, CSS, 글꼴 1) ⚠ 초기값 | 프로토콜 핸들러 로그 또는 CDP Network |
| **SC5** 메모리 회귀 | should | 창 1개 유휴 10분, 패인 탭 5개에서 프로세스별 private bytes가 직전 릴리스 +20% 이내 | 성능 카운터 |

### 9.2 규칙

| # | 규칙 | 이유·근거 |
|---|---|---|
| R-D1 | **entry 모듈은 작게.** vendor한 `index.ts`에 더하는 것은 env 스냅샷, `manifest.json` 동기 읽기, 존재 확인, 프로토콜 등록뿐이다. 해시 계산, 네트워크, 무거운 import는 첫 창 뒤로 | upstream이 이 원칙으로 짜여 있다(`index.ts:11-14` 주석: ready 이벤트는 entry 모듈 평가가 끝나야 온다) |
| R-D2 | **preload는 최소.** electron 외 import 없음, 동기 IPC(`sendSync`) 없음, 50줄 이하 | 모든 창의 첫 페인트 전에 돈다. upstream은 storage 스냅샷도 비동기 invoke로 미리 요청한다(`preload/index.ts:18-22`) |
| R-D3 | **스트림은 IPC를 거치지 않는다.** 렌더러가 서비스에 직접 HTTP/SSE로 붙는다. IPC는 네이티브 기능에만. 스트리밍에 딸린 부수 알림(메타데이터)도 IPC로 보내지 않는다 | 이전 앱에서 IPC가 1,001건이던 것은 텍스트 중계가 아니라 스트리밍 텍스트마다 렌더러가 main에 보낸 **메타데이터 알림**이었다. 200 ms로 합쳐 2건이 됐고, 텍스트 스트림 자체는 건드리지 않았다([old] `electron-background-performance-65.md` 20–21, 47행) |
| R-D4 | **시작 직후를 비운다.** 버전 스큐 검사, 피드 조회, 파일 해시, 크래시 리포터·컨텍스트 메뉴(upstream이 500 ms 미룸, `desktop.ts:25-28`)는 첫 페인트 뒤, 유휴 콜백으로 | 이전 앱의 렌더러 probe는 시작 90초 동안 p95 749 ms, 90–240초에도 p95 228 ms였고 240초 뒤에야 51 ms로 내려왔다. 이 값은 렌더러 IPC 왕복이지 키 입력→페인트 지연이 아니다([old] `input-latency-67.md` 7–13행). 실제 입력 표본은 68이다: 첫 90초에 입력 처리 지연 최대 495 ms, 이벤트→페인트 최대 768 ms, long task 최대 1,307 ms(`input-and-runtime-performance-68.md` 9–13행). 그래서 경합 창은 90초가 아니라 240초로 본다 |
| R-D5 | **숨은 창은 쉰다.** 렌더러 창은 Chromium 기본 background throttling을 유지한다. 숨은 창은 타이머를 두지 않고 무효화만 모아 두었다가 보일 때 갱신한다 | [old] 65·68의 hidden 창 coalescing. 브라우저 패인 탭만 예외(8.3) |
| R-D6 | **무거운 것은 늦게.** 브라우저 호스트(upstream이 이미 지연 로드), lighthouse(감사 때만), own-web의 무거운 패널(03) | `ipc-handlers/events.ts:16-21` |
| R-D7 | **code cache를 살린다.** 스킴 권한 `codeCache:true`(`scheme.ts:37-38`)와 main compile cache(`configure.ts:36`)를 끄지 않는다. 렌더러는 asar가 아니라 디스크의 개별 파일로 서빙한다 | ⚠ 버전 교체(포인터, 예전 junction) 뒤 오래된 code cache가 쓰이지 않는지 PF1 측정 때 확인 |
| R-D8 | **연결 예산.** 창마다 서버마다 SSE 하나. 창은 3개까지 권장(7.2) | Chromium 호스트당 6연결 |
| R-D9 | **preflight를 만들지 않는다.** GET에 사용자 정의 헤더를 넣지 않는다. main이 `Access-Control-Max-Age: 7200`을 더해 preflight를 캐시한다 | `windows/headers.ts:15-18` |
| R-D10 | **main은 이벤트 구동.** 첫 창 뒤 main 스레드에서 동기 파일 I/O나 주기 타이머를 두지 않는다. 서비스 상태는 렌더러의 SSE 끊김 신호로만 다시 본다 | [old] 68: 주기적 진단 루프가 스스로 CPU를 썼다 |
| R-D11 | **레이아웃 IPC는 rAF에 한 번.** 패인 bounds는 `ResizeObserver` → rAF로 합쳐 보낸다 | 스크롤 중 IPC 폭주 방지 |
| R-D12 | **초기 그래프는 한두 chunk로, 첫 렌더가 기다리는 chunk는 페이지와 함께 요청.** own-web 프로덕션 빌드는 진입점에서 정적 import로 닿는 모듈을 모두 한 chunk(`boot`)로 묶는다. upstream 렌더러와 같은 `codeSplitting.groups` 방식(`inInitialGraph`로 판정, 우선순위 10)을 쓴다. 데스크톱 호스트(`src/host/desktop.ts`)와 upstream IPC 클라이언트는 dynamic chunk로 두되 `<link rel="modulepreload" data-own-desktop>`로 페이지와 함께 받는다: 받아서 컴파일만 하고, 실행은 T0-0 rpcHash 검사 뒤 import할 때다(5.5). IPC 클라이언트를 boot chunk에 넣으면 Rolldown이 그 최상위 코드(리스너, `DesktopEvents` 요청)를 chunk와 함께, 검사 전에, 웹에서도 실행한다. 웹 폴백은 약 4 KB(gzip)를 받고 실행하지 않는다(PF5는 따로 센다). 무거운 패널은 여전히 lazy chunk다(03 §20.2 R5). 첫 렌더 경로에서 main에 동기로 묻는 호출도 두지 않는다: `Notification.permission`은 main JS의 권한 확인 핸들러가 답하는데, 시작 때 main은 번들을 평가하는 중이라 첫 렌더가 약 100 ms 막혔다(capability는 API 유무로 정하고 권한은 보낼 때 본다). SC4가 초기 요청 수를 잰다 | 데스크톱에서 렌더러 파일은 하나하나 **main 스레드의 프로토콜 핸들러**를 거친다(`windows/protocol.ts:17-20,38-50`). upstream은 그래서 초기 그래프를 한 chunk로 묶었다: 자동 분할이면 약 50개 파일로 쪼개지고 "each file costs the renderer a main-thread request round trip … before first paint"(`packages/desktop/electron.vite.config.ts:31-36,137-139`). own-web도 `app\<version>\web`에서 같은 핸들러로 서빙되므로 같은 규칙이 필요하다. 웹 폴백에서도 요청 수가 줄어 손해가 없다. 실측(패키지 셸, PF1 웜 중앙값): 초기 31파일 → 2파일로 boot −50 ms, 데스크톱 chunk 두 개를 lazy 대신 modulepreload로 −130 ms |
| R-D13 | **raster는 CPU, 합성은 GPU.** 셸은 시작 전에 `--disable-gpu-rasterization`, `--num-raster-threads=4`를 붙인다(`own-shell.ts` `configureOwnApplication`, `raster.ts`). `OWN_DESKTOP_GPU_RASTER=1`이면 Chromium 기본(GPU raster)으로 돈다(비교용) | Electron 44는 실행 사이에 Skia 셰이더 캐시를 남기지 않는다(userData에 `GrShaderCache` 없음, 매 실행 `GrShaderCache::load` 전부 miss). 그래서 GPU raster면 매 실행 첫 프레임의 셰이더를 D3DCompile로 새로 만든다(약 250–300 ms, D3D11 장치 생성 324 ms 뒤). 실측(패키지 셸, 웜 3–5회): 첫 표시 p95 1,150 ms → 900 ms(spawn 기준). Skia Graphite(`--enable-features=SkiaGraphite`)는 더 느렸다(p95 1,377 ms). 대가는 빠른 스크롤: PF3 셸 측정(4,000 px/s fling, 240 Hz)에서 표시 프레임 p95 4.3–8.3 ms로 PF3 예산(16.7 ms) 안이지만, 누락 프레임 0.5–4.9 %와 체커보드 4–24프레임(/2,400)이 생긴다(GPU raster 0/0, 기본 raster 스레드 수면 5.8 %/21). 브라우저 패인 탭도 같은 설정을 쓴다. Electron이 셰이더 캐시를 남기게 되면(upstream 이슈 후보) 다시 잰다 |

### 9.3 이전 앱에서 온 교훈

| [old] 문서 | 관찰 | 우리 규칙 |
|---|---|---|
| `electron-background-performance-65.md` | 700 ms마다 모든 파일을 다시 읽고 파싱(61회 폴링에 488회 → 고친 뒤 8회). 스트리밍 텍스트마다 렌더러→main **메타데이터 알림**을 보내 1,000 delta에 1,001건 → 200 ms로 합쳐 2건(텍스트 스트림은 그대로). 상시 400 ms 갱신 타이머 | R-D3, R-D5, R-D10 |
| `profile-launch-latency-66.md` | 선택한 프로필이 18초 뒤에 보임. 13.2초가 준비 대기, 프로필마다 패키지 검증 2.6–3.6초 | R-D1(시작 경로에서 해시·검증 금지), 5.5의 무결성 검사 위치 |
| `input-latency-67.md` | 렌더러 probe(IPC 왕복, 키 입력→페인트 아님) 중앙값/p95: 첫 90초 171/749 ms, 90–240초 4/228 ms, 240초 뒤 5/51 ms. main이 전체 턴을 hydrate하고 렌더러가 또 hydrate | R-D4, 목록은 요약만(03 §20.2 R8), PF6 창을 240초로(9.1) |
| `input-and-runtime-performance-68.md` | 첫 90초의 실제 입력 표본: 입력 처리 지연 최대 495 ms, 이벤트→페인트 최대 768 ms, long task 최대 1,307 ms(30초 창당 256개 상한 표본). 진단 수집기 자체가 CPU를 씀 | R-D4, R-D10, PF2·PF6을 시작 직후에도 셸에서 잰다 |
| `workspace-notifications-40.md` | 알림 클릭이 엉뚱한 앱을 엶. toast 동작은 승인하지 않고 여는 것만 | 7.4 |

### 9.4 측정 도구

- **PF1·PF3·PF6·PF8 (구현, P4–P5)**: `packages/own-desktop/scripts/perf-shell.ts --out <build-desktop.ps1 출력>`. 격리 루트에서 서비스(소스 서버 + own.accounts, 가짜 키 1개, 세션 201개와 메시지 2,000개 세션)를 띄워 `service-own.json`으로 등록하고, win-unpacked exe를 CDP 포트와 함께 띄운다. PF1(웜·콜드, 부팅 분해), PF3(긴 세션 전체를 페이지해 온 뒤 4,000 px/s fling, 프레임 trace), PF6(240초 IME 입력), PF8(숨김 10분 trace와 CPU). `--only pf1[,pf3]`로 일부만, `--trace <file>`로 웜 1회를 Chromium startup trace(`--trace-startup`, JSON)로 남겨 스레드별 작업을 요약한다. launcher 콜드 시작(G-D1)은 `gates.ts`가 잰다. 아래 `bench-startup.ts` 어댑터 안은 이것으로 대신했다.
- **시작 벤치(upstream, 참고)**: `packages/desktop/scripts/bench-startup.ts`. 격리된 홈(`%APPDATA%`, XDG, DB, 서비스 등록 모두 분리)에서 개발자의 `OPENCODE_*`·`OTEL_*`를 지우고 실행하며, 화면 픽셀로 `screenPainted`와 `screenSettled`를 잰다(파일 머리 주석 1–30줄). `--exe`, `--compare`, `--runs`, `--warmup`을 그대로 쓴다.
  - 고칠 점: `warm` 모드는 번들 CLI로 서비스를 띄운다. own-desktop은 CLI를 번들하지 않으므로, 격리 홈에서 launcher(`own.ps1 start`, `OWN_HOME`·`XDG_*` 재지정)로 서비스를 띄우는 어댑터를 둔다. ⚠ DS1.
  - 벤치는 패키지 exe에 `--remote-debugging-port`와 `--inspect`를 붙여 띄운다(`bench-startup.ts:298-299`). 릴리스 빌드에서 fuse로 이것을 막기로 하면(19장) 벤치는 fuse를 켜지 않은 `--dir` 빌드로 돈다.
  - 우리 mark(`own:shell-start`, `own:sessions-visible`, `own:sessions-fresh`)를 CDP로 읽어 결과에 더한다.
- **프런트 벤치**: `packages/app/e2e/performance`(첫 이동, 세션 인덱스, 스트리밍 처리량·rAF 간격·long task, 대형 세션 검색, 메모리, composer 기록, 마크다운, 터미널). 03 §20.4가 own-web용 PG1–PG8로 옮긴다. 이 문서는 같은 벤치를 **Electron 안에서도** 돌리게 요구한다(01 §16.3의 P4 이후 조건). 비패키지 빌드의 CDP 포트나 Playwright `_electron`으로 붙는다. ⚠ 방식은 DS1에서 정한다(01 §20 31번).
- **입력 지연**: own-web이 Event Timing 관찰자를 둔다. 16 ms 이상 composer 키·조합 이벤트만 샘플하고, 키 값·텍스트·DOM은 기록하지 않는다(이전 앱 67과 같은 방식). 30초에 256개 상한.
- 결과는 릴리스마다 `own/release/<ver>/perf.json`에 남긴다. 판정은 01 §16.3의 PF 규칙을 따르고, SC는 같은 파일에 함께 적는다.

---

## 10. 패키징·서명·크기

### 10.1 빌드

순서와 명령은 FORK §8.2가 기준이다. 이 문서가 그 순서에 요구하는 것은 다음이다.

0. **(FORK §8.2 2단계 앞)** rpcHash 계산: `node own/scripts/rpc-hash.mjs` → env `OWN_RPC_HASH`(5.5). 입력 파일만으로 정해지므로 어느 단계에서 다시 계산해도 같다.
1. **(FORK 2단계)** own-web 빌드. 진입 모듈에 `OWN_RPC_HASH`를 새기고, 다시 계산한 값과 다르면 실패한다. 초기 그래프는 R-D12대로 묶는다. 산출물은 개별 파일, 소스맵 없음. 설치 때 `app\<ver>\web\`으로 간다.
2. **(FORK 5단계)** `bun run --cwd packages/own-desktop build`(electron-vite build). main·preload에 같은 해시를 새기고 다시 검사한다(4.4).
3. **(FORK 5단계)** `bunx electron-builder --win --config electron-builder.config.ts` → `own/.out/desktop/own-desktop-<ver>-win-x64.exe`와 `win-unpacked\`(4.5의 `artifactName`, `directories.output`).
4. `build-own.ps1`이 0단계 값을 `manifest.json`의 `desktop.rpc_hash`에 쓴다(FORK §8.3의 키). FORK §8.2의 "셸 빌드가 새긴 rpcHash(`shared/ipc-rpc*.ts` 해시)를 manifest에 기록"은 "0단계에서 계산한 값(입력은 5.5 목록)"으로 고치기를 요청한다(17장).
5. 셸의 `package.json` version은 own 릴리스 버전(`2.0.18-own.N`)으로 맞춘다(env `OWN_VERSION`, 4.4). ⚠ electron-builder가 prerelease 문자열을 Windows 파일 버전으로 어떻게 바꾸는지 DS0에서 확인한다.

- PoC 실측: electron-vite 빌드 2초(치환 설정), upstream 설정 그대로면 35초(렌더러 1,600개 파일 포함). NSIS 생성 성공([build] §2).

### 10.2 서명 없음과 SmartScreen

- 서명하지 않는다. upstream 서명 스크립트는 GitHub Actions에서만 돈다(`electron-builder.config.ts:23-31`).
- **SmartScreen.** 경고는 인터넷에서 받은 파일(Mark-of-the-Web)에 뜬다. 이 PC에서 직접 빌드하고 설치하면 MOTW가 없어 보통 경고가 없다. 다른 PC로 옮기거나 내려받으면 `Windows의 PC 보호` 창이 뜨고 `추가 정보 → 실행`으로 넘어가야 한다. ⚠ 로컬 빌드에서 경고가 없는지 DS0에서 확인한다.
- 첫 실행은 Defender 검사로 느릴 수 있다. bench는 첫 실행을 warmup으로 버린다(`bench-startup.ts` 주석).
- 나중 선택지: Azure Trusted Signing. 서명 주체와 비용은 사용자 결정(19장).

### 10.3 크기

| 구성 | 설치 파일 | 설치 후 | 근거 |
|---|---|---|---|
| PoC(CLI 번들 포함) | 199.4 MB (실측) | 642–644 MB (실측) | Electron 약 365 MB, `app.asar` 78.7 MB, CLI 196.5 MB([build] §2, [verdict] §5) |
| 권고안(CLI 번들 없음) | 약 130–150 MB (추정) | 약 447 MB (추정) | CLI를 빼고 `app\<version>`(`app\current.json`)을 씀 |
| 권고안 − lighthouse | ⚠ 미측정 | ⚠ 미측정 | asar의 대부분이 lighthouse와 그 의존성([build] §2) |

- 렌더러 소스맵(upstream 기준 55.3 MB)은 넣지 않는다(4.5 `files`).
- 점검 SC2: 설치 파일 ≤ 150 MB, 설치 후 ≤ 460 MB. lighthouse를 빼기로 하면 기준을 다시 잡는다.
- own-web(`app\<ver>\web`)의 크기는 PF5(01 §6.6)를 따른다. 셸 크기에는 들어가지 않는다.

### 10.4 설치, 업데이트, 제거

- **설치.** NSIS oneClick per-user(`perMachine:false`), 관리자 권한 없음. 시작 메뉴 바로가기(AUMID, 7.4). upstream `installer.nsh`의 icacls 부여(샌드박스용)를 유지한다([build] §1). v2.2부터 upstream include는 `customInit`(앱 id 이름의 설치 폴더로 옮김)·`customUnInstall`·`customCheckAppRunning`과 업데이터용 매크로를 정의해 own 매크로와 겹치므로 끌어오지 않고, icacls 줄만 own `customInstall`에 그대로 둔다(`test/shell.test.ts`가 둘을 맞춰 본다).
- **한 번에(구현, launcher 0.3.0; 0.4.0부터 junction 대신 버전 포인터와 설치 기록).** 설치 파일이 서비스 payload(`app\<ver>`, launcher)를 `resources\own-payload`로 싣는다(`build-desktop.ps1`이 `OWN_DESKTOP_PAYLOAD`로 넘김). `build\installer.nsh`의 `customInit`은 아무것도 풀기 전에 `own.ps1 install --preflight`로 세션이 도는 서비스를 멈춰야 하는지 묻고(종료 코드 4, 아니요면 그대로 끝), `customInstall`은 `own.ps1 install --from … --move --no-prompt`(해시 확인, DB 백업, `app\current.json` 교체와 `opencode.jsonc`의 own 플러그인 항목 갱신(이전 launcher의 junction은 링크만 지움), 직전 버전 유지, PATH, 새 서비스가 뜨지 않으면 되돌림)를 부른다. 설치 파일 쪽 실행 기록(명령, 쓴 PowerShell, 종료 코드)은 `%TEMP%\own-installer.log`(UTF-16)와 `OWN_HOME\install.log`에 남고, `/S`에서 서비스 부분이 실패하면 설치 파일이 launcher의 종료 코드로 끝난다. 서비스 부분은 앱 파일을 다 푼 뒤 마지막에 돌므로, `/S`로 실행한 쪽(창 프로그램이라 곧바로 돌아옴)은 `Start-Process -Wait`로 기다려야 한다. `customUnInit`은 서비스 제거(기본 예)와 데이터 삭제(기본 아니요)를 묻고 세션이 돌면 먼저 묻는다. `customUnInstall`이 `own.ps1 uninstall [--remove-data]`를 부른다. 새 설치 파일이 옛 제거기를 돌릴 때(`old-uninstaller.exe`, `/KEEP_APP_DATA`, `--updated`)는 아무것도 묻거나 지우지 않는다. 사용자 절차는 USER-GUIDE 2장·15장. 아래 두 항목은 그 앞의 셸 전용 설계다.
- **업데이트.** 셸 자동 업데이트는 없다. UI 변경은 서비스 릴리스(`app\<version>\web`)로 온다. 셸은 rpcHash가 바뀔 때만 다시 설치하면 된다. (구현 뒤: 새 버전의 설치 파일이 셸과 서비스를 함께 바꾼다.)
- **제거.** 설치기의 제거 프로그램. userData(`%APPDATA%\dev.own.opencode.desktop`)는 NSIS 기본 동작대로 남긴다(⚠ electron-builder `deleteAppDataOnUninstall` 기본값 확인). OWN_HOME과 서비스는 건드리지 않는다. (구현 뒤: 위의 질문대로 서비스와, 원하면 데이터와 userData도 지운다.)
  - 설치 폴더 밖에 Electron·Windows가 만든 것도 지운다(`packages/own-desktop/build/installer.nsh`의 `customUnInstall`. upstream `installer.nsh`는 v2.2부터 include하지 않음): toast activator 키 `HKCU\Software\Classes\CLSID\{410CC5B4-…}`(7.4), Electron이 만든 시작 메뉴 바로가기 `Own OpenCode.lnk`(설치기의 것은 electron-builder가 지운다), Windows 알림 설정 `HKCU\…\Notifications\Settings\dev.own.opencode.desktop`. 업데이트(`--updated`로 도는 옛 제거기)에서는 지우지 않는다. HKCU와 사용자 시작 메뉴만 건드린다. 빌드는 이 스크립트를 컴파일해 확인하고, 제거기 실행은 사람이 설치한 PC에서 확인한다 ⚠.
- **upstream과 공존.** appId, 설치 폴더, 제거 GUID, userData, AUMID가 모두 달라 나란히 설치된다. 서비스는 채널로 분리된다(01 §5.2). G-D1·G-D2가 확인한다.

---

## 11. 개발 흐름

### 11.1 Electron 바이너리

- 저장소 루트 `package.json`의 `trustedDependencies`에 `electron`이 있어(`package.json:150-155`) `bun install`의 postinstall이 바이너리를 받을 수 있지만, 이 PC에서는 `node_modules/electron/dist`가 없었다([build] §2).
- 받는 방법: electron 패키지의 bin `install-electron`(`bun.lock`의 `own-desktop/electron` = `electron@44.10.2` bin 항목, own-desktop `bun run electron:install`)을 own-desktop에서 실행한다. `@electron/get` 캐시(`ELECTRON_CACHE`, Windows 기본 `%LOCALAPPDATA%\electron\Cache`)를 쓴다.
- 크기와 시간: `electron-v44.4.3-win32-x64.zip` 150.9 MB, 이 네트워크에서 약 7분(체크섬 확인). 44.4.5는 2026-10-08에 약 17초, 44.9.1(`electron-v44.9.1-win32-x64.zip` 158,389,896 B, sha256 `41bd7900…ef91`, 공식 `SHASUMS256.txt`와 같음)은 2026-10-31에 약 14초였다(SYNC_LOG, MR8-23). 44.10.2(`electron-v44.10.2-win32-x64.zip` 158,203,656 B, sha256 `7af18e85…38f9`, electron 패키지의 `checksums.json`과 같음)는 2026-11-10에 풀기까지 약 1분이었다(EL-2). 캐시는 판마다 다른 폴더라 앞 판의 zip은 그대로 남는다. Windows ARM64 원격 PC 클라이언트의 `electron-v44.10.2-win32-arm64.zip`(156,502,112 B, sha256 `1fb2e416…880c`)은 `own/scripts/client-natives.ts --arch arm64 --fetch`가 `own\.out\cache\client-arm64`에 받아 같은 `checksums.json`으로 확인한다. PoC가 받은 zip이 scratchpad `electron-cache\`에 있으므로 캐시 폴더로 옮겨 재사용할 수 있다.
- electron-builder는 NSIS와 7zip을 `%LOCALAPPDATA%\electron-builder\Cache`에 받는다(약 15 MB, [build] §2).

### 11.2 dev 실행

```text
1. 개발 서비스(local 채널): 01 §5.4. DB opencode-local.db, 포트 49375(Windows 28895), 등록 service-local.json,
   OPENCODE_CONFIG_DIR=%USERPROFILE%\.config\own-open-code-dev
2. own-web Vite: bun run --cwd packages/own-web dev   (http://localhost:5173, own-web 자기 Vite 설정)
3. 셸:          OWN_DESKTOP_CHANNEL=local ELECTRON_RENDERER_URL=http://localhost:5173
                OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT=0
                bun run --cwd packages/own-desktop dev   (electron-vite dev: main·preload만 빌드·감시)
```

- 3단계가 동작하는 조건: own-desktop 설정이 `serve`에서 `renderer`를 두지 않아야 한다(4.4). 두면 electron-vite가 자기 renderer dev 서버를 띄우고 `ELECTRON_RENDERER_URL`을 그 주소로 **덮어쓴다**(electron-vite 6.0.0-beta.1 `dist/chunks/lib-uEZrJ__X.js:56-67`). 그러면 사용자가 준 own-web 주소가 사라지고 폴백 페이지가 뜬다. renderer가 없으면 electron-vite는 env를 건드리지 않고 Electron을 띄운다.
- upstream `bun dev`(`packages/desktop/scripts/dev.ts`)는 쓰지 않는다. `packages/app`를 빌드하고, CLI를 소스로 `0.0.0.0`에 띄운다(`background-service.ts:47`의 `--hostname 0.0.0.0`). 실제로 LAN 주소 `http://192.0.2.10:<port>`가 광고됐다([build] §4 위험 6). 01 §13의 LAN 금지와 충돌한다.
- `ELECTRON_RENDERER_URL`이면 렌더러가 Vite에서 로드되고(`scheme.ts:7-14`) `isRendererUrl`이 그 origin을 허용한다(`scheme.ts:21-23`). 인증 주입도 그 origin에 적용된다. 이때 main은 자산 서빙 대기를 건너뛴다(`index.ts:28`).
- **CDP 포트 경고.** 비패키지 빌드는 **기본으로** 원격 디버깅 포트를 연다. 기본값 9222(`configure.ts:26-27`). 같은 PC의 다른 프로세스가 인증된 UI를 조작할 수 있다. dev 스크립트는 `OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT=0`(임의 포트)으로 띄운다. ⚠ `0`이 임의 포트로 동작하는지 DS0에서 확인한다.
  - 패키지 빌드는 스스로 포트를 열지 않는다. 그러나 Electron fuse를 설정하지 않았으므로(upstream도 없음) 실행한 쪽이 명령줄로 `--remote-debugging-port`·`--inspect`를 주면 받는다. upstream 벤치가 바로 그렇게 쓴다(`scripts/bench-startup.ts:298-299`). 같은 사용자 코드만 exe를 그런 인자로 띄울 수 있으므로 01 §13의 전제(같은 사용자 = 같은 신뢰 경계) 안의 위험이다.
  - 선택: 릴리스 빌드에 fuse(`EnableNodeCliInspectArguments=false`, `RunAsNode=false`, `EnableNodeOptionsEnvironmentVariable=false`)를 켜고, 벤치는 fuse 없는 `--dir` 빌드로 돌린다. `--remote-debugging-port`는 fuse로 막히지 않는다고 보고 있다 ⚠(외부 사실). 결정은 19장.
- HMR: 렌더러는 Vite HMR(own-web 쪽), main·preload는 electron-vite의 재빌드와 재시작.

### 11.3 테스트 격리

- 비패키지 빌드는 `OPENCODE_DESKTOP_TEST_ROOT`로 userData·session·XDG 전부를 임시 루트로 돌린다(`configure.ts:45-60`). G-D1–G-D6 자동 시험과 bench는 이것과 launcher의 `OWN_HOME`·`OWN_CONFIG_DIR`·`XDG_*` 재지정(`own.ps1` 머리말)을 함께 쓴다.
- **XDG는 하네스가 직접 준다.** 테스트 루트의 `XDG_*`는 `configureApplication()` 안에서 설정되므로(`configure.ts:56-59`) 5.2의 env 스냅샷에는 들어가지 않는다. 셸과 launcher가 같은 등록 파일을 보게 하려면 하네스가 셸을 띄울 때 `XDG_STATE_HOME=<root>\state`, `XDG_DATA_HOME=<root>\data`, `XDG_CONFIG_HOME=<root>\config`, `OWN_HOME=<root>\own`을 env로 함께 준다. 그러면 테스트 루트 설정과 스냅샷이 같은 값을 가진다. 이것을 빠뜨리면 셸은 스냅샷(실제 사용자 경로)에서 등록 파일을 찾고, 시험은 서비스를 찾지 못하고 멈춘다.
- 패키지된 exe는 `USERPROFILE`을 바꿀 수 없다("Failed to get 'appData' path", [build] §2 run 3). 패키지 시험은 실제 사용자 경로를 쓰므로, 시험 전후로 `%APPDATA%\dev.own.opencode.desktop`과 `HKCU\Software\Classes\opencode`의 상태를 기록하고 비교한다(G-D2).
- 브라우저 패인 시험(G-D5)은 upstream의 네이티브 스모크 하네스를 참고해 자동화한다: `packages/desktop/test/browser-native.test.ts`, `test/browser/{native,server,targets,contract}.ts`. own 서비스·own-web 어댑터로 바꿀 부분만 새로 쓴다 ⚠(재사용 범위는 DS2에서 정함).

---

## 12. SSH 원격과 데스크톱 셸 (결정 D8)

04의 설계를 그대로 두고, 셸과의 경계만 정한다.

| 항목 | 어디서 | 설명 |
|---|---|---|
| ssh.exe 터널, askpass, 브로커, 원격 설치·ensure | 로컬 서비스의 own-remote(04 §4) | 셸이 꺼져도 서비스가 살아 있는 한 터널이 산다. 모바일(13장)도 같은 터널을 쓴다. 단, 터널이 사는 own-runtime 런타임은 참조 카운트가 0이 되고 30초 뒤 닫히고(04 §4.1, ⚠ RG1), 참조를 쥔 플러그인 인스턴스는 Location마다 있으며 Location은 유휴 60분 뒤 해제된다(`location-activity.ts:25-45,50-81`). 셸도 창도 없는 유휴 PC에서 터널이 계속 사는지는 13.4의 고정(pin) 규칙과 MG10으로 확인한다 |
| upstream 데스크톱 SSH(`src/main/ssh/*`) | 셸 main, **비활성** | own-web이 `Ssh*` IPC를 부르지 않는다(6.5). 저장된 호스트가 없으면 아무것도 하지 않는다 |
| 원격 서버 인증 | 렌더러(own-web) | `own.remote.resolve`의 토큰을 탭 메모리에 두고 Basic 헤더로 보낸다(04 §12.1). 데스크톱 렌더러 origin은 `oc://renderer`이고, main이 렌더러 session의 응답에 CORS 헤더를 덮어쓰므로 원격 서비스의 CORS 설정과 무관하게 통한다(`windows/headers.ts:10-20`, 01 §6.1). 웹 폴백(origin `http://127.0.0.1:<P>`)은 원격 서비스의 기본 CORS 허용(`packages/server/src/cors.ts:13-14`)으로 통한다 |
| 원격 폴더 선택 | 렌더러 + 원격 `fs.list` | 04 §12.4. 네이티브 폴더 대화상자는 로컬 서버에만 |
| 원격 세션의 브라우저 패인 | 셸 main → 원격 plugin-browser | 8.6. 트래픽은 원격 호스트에서 나감 |
| 원격 파일을 로컬 앱으로 열기 | 없음 | 04 §12.5처럼 숨긴다. VS Code Remote는 19장 |

- **셸 main에서 SSH를 돌리는 안은 기각한다**(04 §4.1 대안 표에 이미 반영됨). 이유 네 가지([verdict] §6):
  1. 터널이 창과 셸의 수명에 묶인다. 셸을 닫으면 원격 턴의 브로커 lease가 끊긴다.
  2. upstream 코드는 npm의 upstream CLI를 원격에 설치한다(`remote/cli.ts:71`).
  3. 자격 증명을 원격 서버마다 따로 저장한다(04 §0).
  4. 04의 자격 증명 브로커(로컬 vault → lease)가 서비스 안에 있어야 한다.
- 04 v0.3은 "deep import는 되지만 안정 API가 아니고 서비스(Bun) 안에서 돌아야 하므로 vendor"로 이미 고쳤다(04 §0-3, §4.3).
- **쿠키 논거의 범위.** 04 §7.3·§12.1의 "로컬 세션 쿠키가 원격 끝점으로 샌다"는 위험은 **웹 폴백에만** 해당한다. 데스크톱 렌더러는 쿠키를 쓰지 않는다. 그래도 호스트별 loopback 주소 분리는 유지한다. 웹 폴백이 남아 있고, CORS와 origin 분리 이유도 그대로이기 때문이다.
- **모바일에서 원격 세션.** 휴대폰은 PC 서비스의 게이트웨이를 거쳐 `/srv/<hostId>/…`로 원격 세션을 보고 조작한다(13.4). 휴대폰은 SSH 키, 원격 서비스 비밀번호, 세션 토큰 어느 것도 받지 않는다.

---

## 13. 모바일 확장성 (결정 D3)

모바일 앱 자체는 나중 범위다. 이 장은 지금 구조가 그것을 막지 않도록 원칙, 계약, 선택지를 정한다.

### 13.1 원칙

1. **백엔드 우선.** 계정·전환·캐시·한도·SSH 세션·알림 판정 로직은 모두 서비스와 RPC(`own.accounts`, `own.remote`)에 있다. 셸과 렌더러는 표시와 기기 기능만 한다(3.2). 새 기능을 설계할 때 "휴대폰에서도 되는가"를 먼저 묻는다. 셸 main에만 있는 로직은 코드 리뷰에서 막는다.
2. **같은 UI 코드.** 휴대폰도 own-web을 쓴다. 차이는 `OwnHost(mobile)`와 capability뿐이다(6.2).
3. **capability 게이트.** UI는 `kind`가 아니라 capability를 본다. 모바일에서 안 되는 것은 자리를 숨기거나 대안(`fs.list` 선택기, 파일 업로드)을 보인다.
4. **반응형·터치 대응.** 03 §4.2의 1100 px 미만 배치를 휴대폰 폭(360 px 이상)까지 내린다. `(pointer: coarse)`에서 클릭 대상 44 px, hover 전용 정보 금지, 가상 키보드(`visualViewport`)와 safe-area 대응, 한글 IME 규칙(03 §12)은 모바일 키보드에서도 같다. 상세는 03(17장).
5. **네트워크 표면은 늘리지 않는다.** 원격 접근은 켤 때만 생기고, loopback + 암호화 터널 밖으로 서비스가 나가지 않는다.

### 13.2 서비스가 내놓을 것, 기기에 남는 것

| 기능 | 서비스(모든 기기) | 데스크톱에만 |
|---|---|---|
| 세션 목록·대화·프롬프트·중단·권한 응답·질문 응답 | upstream HTTP/SSE | – |
| 계정·한도·전환·캐시 상태 | `own.accounts`(02 §9) | – |
| SSH 원격 세션 | own-remote + 게이트웨이 프록시 | – |
| 폴더 탐색 | `fs.list`(control location) | 네이티브 대화상자 |
| 파일 보기·diff | upstream `fs.*`, `vcs.*` | 로컬 앱으로 열기, 탐색기 |
| 첨부 | 업로드(`fs.write`, [gap] #10) | 실제 경로 드래그, 클립보드 이미지 |
| 알림 | (M1) 알림 피드 + (M2) 푸시 | OS toast |
| 브라우저 도구 | plugin-browser | 브라우저 호스트(WebContentsView) |
| 서비스 재시작 | – | `own.ps1 restart`(5.6) |
| 기기 페어링 관리 | own-remote `devices.*` (`local` 범위, PC에서만 호출) | QR 표시 |
| 터미널(PTY) | upstream PTY + ticket | – (모바일은 `terminal` 범위가 있을 때만) |

### 13.3 원격 접근 구조 선택지

| 안 | 방식 | 판단 |
|---|---|---|
| **A. Tailscale serve (권장)** | `tailscale serve --https=443 http://127.0.0.1:<G>`. tailnet 안의 기기만 `https://<pc>.<tailnet>.ts.net`으로 붙는다. TLS 인증서는 Tailscale이 발급하고, 전송은 WireGuard다 | 게이트웨이는 loopback에만 바인딩하므로 LAN에 아무것도 열리지 않는다. 휴대폰 앱과 PWA 모두 쉽다. 설치·로그인은 사용자 몫이다(이 PC에는 아직 설치돼 있지 않음, 2026-09-27 확인). serve가 붙이는 사용자 식별 헤더를 보조 확인으로 쓸 수 있다 ⚠ |
| B. WireGuard 직접 | PC에 WireGuard 인터페이스를 두고 게이트웨이를 그 주소(예: `10.8.0.1`)에 바인딩 | 전송은 암호화되지만 TLS가 없어 PWA 설치·Web Push 조건(보안 컨텍스트)을 채우지 못한다. 바인딩 주소가 진짜 터널 어댑터인지 검증해야 하고, Windows 방화벽 프롬프트가 뜬다. 고급 설정으로만 |
| C. 중계(relay) | 클라우드 중계(자체 또는 Cloudflare Tunnel 등)로 바깥에서 붙음 | 제3자가 TLS를 끝내 내용을 볼 수 있다. 쓰려면 기기와 게이트웨이 사이 종단간 암호화(예: Noise over WebSocket)를 따로 얹어야 한다. 나중 선택지 |
| D. LAN 평문 | 게이트웨이나 서비스를 `0.0.0.0`/LAN 주소에 HTTP로 | **금지.** upstream 모바일 pairing이 이 방식을 가정한다(`packages/app/src/settings/pairing/pairing.tsx:28-39`는 loopback이 아닌 URL을 골라 QR에 넣는다). Basic·토큰이 평문으로 흐른다 |
| E. 공개 인터넷(Tailscale Funnel, 포트 포워딩) | 누구나 URL로 접근 | **금지.** |
| F. SSH 역터널 | 휴대폰 SSH 앱으로 PC에 터널 | Windows sshd와 키 관리가 필요하고 PWA와 맞지 않는다. 기각 |

- **앱 연결(2026-10-01 사용자 결정, `08-app-access.md`).** Android 앱과 다른 PC의 데스크톱 앱은 게이트웨이의 두 번째 리스너(loopback, 자체 서명 TLS, 인증서 지문 고정)로 붙는다. 경로는 안 A를 TCP 그대로 넘기는 `tailscale serve --tcp`와, 사용자가 직접 거는 Windows portproxy + 공유기 포트 포워딩(DDNS)이다. 후자는 안 E(공개 인터넷)를 **앱 전용·지문 고정·브라우저 페어링 거부** 조건으로만 허용하는 것이고, 리스너 자체는 여전히 loopback이다(MG1 유지). 브라우저·PWA는 이 표의 안 A 그대로다.
- 게이트웨이는 LAN 주소(RFC 1918, 링크 로컬)와 `0.0.0.0`/`::` 바인딩 요청을 거절한다(`bind_rejected_lan`). 안 B의 터널 주소는 사용자가 명시적으로 적고, 게이트웨이가 그 주소의 어댑터 종류를 확인한다(⚠ 확인 API, MG1).

### 13.4 게이트웨이

**자리.** 리스너 코드는 own-runtime(라이브러리)에 있고, own-runtime의 프로세스 수명 `ManagedRuntime`(04 §4.1)에서 돈다. 04의 브로커 리스너와 같은 방식이다(01 §6.4). 관리 RPC(`gateway.*`, `devices.*`, `feed.*`, `push.*`)는 own-remote(로컬 모드)가 `own.remote`로 등록한다(04 §16.8). 그래서 **원격 접근을 쓰려면 own-remote가 설치돼 있어야 한다.** own-remote는 01 §0-7·§4의 기본 플러그인 순서에 들어 있고 P6(04 R0) 이후 항상 싣는다. 원격 호스트가 0개여도 로컬 모드로 뜬다. 02 §9.1의 "`own.remote`(04, 설치 시)"는 "P6 이후 항상"으로 읽기를 요청한다(17장).
- 따로 상주 프로세스를 두지 않는 이유는 04 §4.1의 companion 기각과 같다(두 번째 감독 대상, 인증할 서버 증가). 서비스가 멈추면 원격 접근도 멈추는 것은 받아들인다(모바일은 재시작할 수 없다, 13.2).
- 셸(Electron main)에 두지 않는 이유: 셸이 꺼져 있어도 휴대폰에서 붙어야 한다(백엔드 우선).

**수명 ⚠(실측 없음).** 서비스 프로세스가 살아 있다고 게이트웨이가 사는 것은 아니다.
- 플러그인 인스턴스는 Location마다 뜬다. 서비스가 막 시작하면 어떤 클라이언트가 부르기 전까지 Location이 하나도 없고, 01 G15는 홈 디렉터리 Location을 만들지 않게 한다.
- Location은 마지막 **세션** durable 이벤트 뒤 60분이면 해제된다(`packages/core/src/location-activity.ts:25-45,50-81`). control location에는 세션 이벤트가 없으므로 처음 본 뒤 60분이면 해제 대상이 된다. RPC 호출은 이 시계를 늘리지 않는다.
- own-runtime 런타임은 참조 카운트가 0이 되고 30초 뒤 닫힌다(04 §4.1, ⚠ RG1). 참조를 쥔 것은 Location의 플러그인 인스턴스다.
- 그래서 PC가 유휴이거나 방금 재시작됐고 데스크톱이 꺼져 있으면, 게이트웨이·피드 생산자·SSH 터널이 모두 없을 수 있다. "셸이 꺼져 있어도 휴대폰에서 붙어야 한다"와 "서비스가 재시작되면 게이트웨이도 다시 뜬다"(13.7)를 지키려면 아래 두 장치가 필요하다.

**고정(pin)과 깨우기.**
1. **런타임 고정.** 게이트웨이가 켜져 있는 동안 own-runtime은 게이트웨이용 참조 하나를 스스로 쥔다. 이 참조는 Location Scope와 무관하므로 Location이 모두 해제돼도 런타임, 게이트웨이 리스너, 피드 생산자, SSH 컨트롤러가 산다. `gateway.disable`이 참조를 놓는다.
2. **기동 깨우기.** 서비스가 새로 뜨면 아직 아무 Location도 없으므로 런타임도 없다. launcher의 `own start`·`restart`(와 로그온 작업 `own logon`)는 서비스 기동 뒤, 게이트웨이 설정이 켜져 있으면 control location으로 `own.remote` `gateway.status`를 한 번 부른다(5.7). 그러면 control location의 own-remote 인스턴스가 떠서 런타임을 만들고, 1번 고정이 걸린다. 그 부름은 control location의 플러그인을 모두 불러온 뒤에 답하므로 launcher는 300초까지 기다린다(2026-10-31, RH-50: 부하가 큰 PC에서 전의 60초를 넘겨 `게이트웨이는 앱이 처음 연결할 때 뜬다`고 알렸지만, 실제로는 불러오기가 끝나면 own-remote가 스스로 띄웠다). 게이트웨이 설정(켜짐 여부, 포트)은 파일에 있으므로(위치는 02 §2.3) launcher가 서비스 없이 읽을 수 있다.
   - **셸이 부른 실행은 깨우지 않는다.** 데스크톱 셸은 launcher가 끝날 때까지 기다리는데, `gateway.status`는 `gateway.start()`와 Tailscale 조회(최대 2번, 각 타임아웃 4초)가 끝나야 답한다. 그래서 셸이 부른 `start`·`restart`·`open --browser`(`OWN_LAUNCHER_CLIENT=desktop`, 01 §5.3)는 깨우기를 건너뛴다. 이때 게이트웨이를 띄우는 것은 앱의 첫 control RPC다: own-web 재동기화의 `own.accounts` `health`가 control location의 플러그인을 세우고, own-remote 설정이 게이트웨이를 스스로 띄운다(`packages/own-remote/src/gateway/index.ts` `acquire`). 한계: 셸이 서비스를 띄운 뒤 렌더러가 붙기 전에 앱이 닫히면, 다음 클라이언트가 control location을 부를 때까지 게이트웨이가 없다. CLI의 `own start`·`restart`는 지금처럼 깨운다.
3. **피드 생산자는 Location보다 오래 산다.** 피드는 기기가 없는 동안에도 쌓여야 한다. 그래서 피드 생산자는 플러그인 인스턴스의 버스 구독이 아니라, 고정된 런타임 안에서 **로컬 서비스의 `/api/event`를 loopback으로 구독**한다(등록 파일의 password로 Basic). `/api/event`는 서비스 전체 버스를 구독하는 스트림이라(`packages/server/src/handlers/event.ts`, `event-feed.ts`) Location과 무관하게 모든 세션 이벤트를 받는다 ⚠(location 필터 없음을 MG9에서 확인). 원격 호스트 사건은 04 §12.3의 원격 구독이 준다.
- 한계: 피드 항목 중 own-accounts가 만드는 것(`limit.exhausted`, `codex.stale` 등 `rpc.own.accounts.*` 이벤트)은 own-accounts 인스턴스가 있어야 생긴다. 유휴로 모든 Location이 해제되면 그동안의 계정 경보는 없다. own-accounts의 전역 poller 수명은 02가 정한다(17장).
- 시험: MG9(서비스 재시작, 데스크톱 없음 → 휴대폰 접속), MG10(60분 넘게 유휴 → 휴대폰 접속, 그동안의 턴 완료가 피드에 있음).

**하는 일.**
1. **기기 인증.** 요청의 기기 토큰(PWA: `HttpOnly; Secure; SameSite=Strict` 쿠키 `own_device`, 앱: `Authorization: Bearer`)을 sha256해서 `devices.json`과 비교한다. 폐기·만료면 401.
2. **범위 강제.** 요청을 허용 목록(메서드 + 경로 패턴 + RPC 메서드 이름)과 비교한다. 거부 목록 방식은 쓰지 않는다(13.5 표). RPC는 `@own/protocol`의 `OwnAccounts.MethodScope`(02 §9.1)와 `OwnRemote.MethodScope`(04 §16.7)를 그대로 import해 판정한다. 표를 게이트웨이에 따로 적지 않는다.
   - **컴퓨터 사용(01 §10.2)은 PC에서만 켠다.** 범위표와 별개로 게이트웨이가 본문을 보고 막는다(`packages/own-remote/src/gateway/policy.ts`). 기기가 끄는 쪽(`computerUse:"off"`)과 거부 규칙은 막지 않는다.
   - **컴퓨터 사용은 기기에서 보고 멈출 수만 있다.** `own.computer` RPC는 `status`와 `killswitch.engage`(`OwnComputer.MethodScope`의 `read`·`drive`)만 통과시키고(`COMPUTER_METHODS`), 둘 다 `prompt`나 `switch` 범위 기기에만 준다. 프롬프트를 보낼 수 있는 기기는 컴퓨터 사용이 켜진 세션의 에이전트를 움직일 수 있으므로 멈출 수도 있어야 하고, 읽기만 하는 기기에는 상태도 주지 않는다. own-web의 `computerAllowed`(`drive` ↔ `prompt` 또는 `switch`)와 같은 대응이다. 다시 허용(`killswitch.reset`), 세션별 앱 승인(`session.grants.*`), `helper.restart`, `audit.list`와 원격 호스트(`/srv/<hostId>`)로 가는 호출은 막고, `own.computer` 이벤트도 기기로 보내지 않는다(이벤트 거르기는 기기 범위를 보지 않음). 휴대폰 own-web은 아직 이 RPC를 부르지 않는다(`src/data/index.tsx`, 후속). 그 후속에서 상태는 주기적으로 묻고(이벤트가 걸러지므로), 읽기만 하는 기기에도 `killswitch.engage`를 줄지 정한다(멈추기만 하고 다시 허용은 PC에서만이라 위험은 작지만, 훔친 읽기 토큰으로 컴퓨터 사용을 계속 멈출 수 있다).
   - **팀 모드(06 §2.7, T1)에도 이 규칙은 그대로다.** 게이트웨이의 `own.team` 분기는 `OwnTeam` 범위표로 기기 범위를 보고 `local`(확인 단계, push, 설정 쓰기)을 막으며 `rpc.own.team.*` 이벤트를 통과시킨다. 그래도 `own.computer`는 위의 두 메서드뿐이고, 기기의 `computerUse:"on"`과 `computer`를 허용하는 규칙을 담은 세션 생성·가져오기·포크도 계속 PC에서만 받는다. own.team은 컴퓨터 사용을 켜거나 넘기지 않으므로(06 §2.6) 팀 경로로 이 규칙을 비켜 갈 길이 없다. 앱 기기(Android 앱 `kind:"app"`, 다른 PC의 원격 PC 창, 08)는 브라우저 리스너의 같은 Policy를 지나므로 같은 규칙을 받는다.
   - **다른 도구의 대화(09 §5.5, IMPORT).** `own.import` 분기도 범위표 `OwnImportRouting.MethodScope`로 판정하고 `local`(`sources.configure`)을 막으며, 표가 `read`로 선언한 `rpc.own.import.*` 이벤트만 통과시킨다. `/srv/<hostId>`의 `own.import`는 언제나 막는다(원격 호스트에는 own-import가 없음). 범위는 13.5 표다.
   - **본문 검사**가 필요한 것:
     - `accounts.update`에 `replaceKey`가 있으면 `local`(02 §9.1 ⚠). `own.remote` `connect`에 `hostKeyPrompt:true`가 있으면 `local`(04 §16.7).
     - 권한 응답 `POST /api/session/:id/permission/:requestID/reply`의 `decision`이 `"always"`면 거부(`packages/protocol/src/groups/permission.ts:117-123`, `Permission.Reply`는 `once|always|reject`, `packages/schema/src/permission.ts:41`).
     - `PATCH /api/session/:id`에 `permissions`가 있으면 `local`(세션 규칙은 `session.approval.set`으로만 씀).
     - `own.accounts` `session.approval.set`에 `computerUse:"on"`이 있으면 `local`(02 §9.2).
     - `own.accounts` `switch.estimate`·`switch.apply`·`switch.schedule`에 `teamOp`가 있거나 `session.preset.apply`에 `team` 키가 있으면(`null` 포함) `local`. 둘은 own.team만 넘기는 값이라(07 §5.4, §8.1, 02 §5.11 7번) 기기가 보내면 팀 세션을 같은 회사의 다른 구독으로 옮기거나 팀 R4 맥락을 지우고 넓힐 수 있다(2026-10-02 T1 리뷰 수정).
     - `POST /api/session`(`prompt`)의 `permissions`, `POST /api/experimental/session/import`(`admin`)의 `info.permissions`에 `computer`와 맞고(코어 와일드카드, 대소문자 무시) deny가 아닌 규칙이 있으면 `local`. 그래서 컴퓨터 사용이 켜진 세션을 휴대폰에서 `새 세션으로 인계`하면(원본 규칙을 그대로 복사, 03 §16.3) 거부된다. 인계는 PC에서 한다.
     - **기기의 새 세션 규칙(RL5-4, 2026-11-07).** 기기가 만드는 새 세션(`POST /api/session`)의 `permissions`는 없거나(`null`, `[]` 포함) 휴대폰 own-web이 붙이는 브라우저 deny(`{browser,*,deny}`)뿐이어야 한다. 승인 모드는 만든 뒤 `session.approval.set`으로 정하고(묻기·읽기 전용·전체 허용, `prompt`, 02 Q36), 에이전트는 `agent` 이름으로 고른다. 그 밖의 규칙(allow, ask, 다른 deny)은 기기 범위와 상관없이 `local`이다. 예외는 `새 세션으로 인계`다. 본문이 `metadata.own.seededFrom`으로 원본을 밝히면 게이트웨이가 같은 서버에서 그 세션을 먼저 읽고, `permissions`가 원본 규칙과 순서까지 똑같고 원본이 포크할 수 있는 세션(아래)일 때만 넘긴다(`Policy.handoffSource`·`Policy.handedOver`). 원본을 읽지 못하면 거부한다.
     - 폼 응답 `POST /api/session/:id/form/:formID/reply`(`prompt`)의 `answer`에 컴퓨터 사용 앱 허용 답(`OwnComputer.ALLOW_ANSWER`, 플러그인 질문의 "이 세션 동안 허용")이 값이나 목록 안에 있으면 `local`. `approval:"question"`의 앱 승인은 PC에서만 한다(01 §10.2). 다른 답(거부 포함)과 다른 질문의 답은 통과한다.
     - `POST /api/session/:id/fork`(`prompt`)는 본문이 아니라 원본 세션을 본다. 포크는 원본 규칙을 그대로 복사한 최상위 세션을 만들므로(코어 fork projection), 게이트웨이가 먼저 같은 서버에서 `GET /api/session/:id`로 원본을 읽고 그 `permissions`에 위와 같은 규칙이 있으면 `local`로 거부한다. 원본을 읽지 못해도(없는 세션, upstream 오류) 거부한다(fail closed).
     - `POST /api/experimental/fs/write`(`files`)는 본문이 아니라 쿼리의 `path`를 본다. upstream은 그 경로를 Location 밖이어도 그대로 쓰므로(`packages/core/src/filesystem.ts`), 게이트웨이가 먼저 같은 서버에서 `GET /api/info`로 임시 폴더(`paths.tmp`)를 읽고, `path`가 정확히 하나이며 그 폴더 안의 절대 경로일 때만 통과시킨다(own-web의 첨부 업로드와 git 입력 파일). 상대 경로, `..`, 점과 공백만인 경로 조각, Windows의 장치·UNC·루트 기준 경로와 드라이브 밖의 `:`(대체 데이터 스트림)는 `local`로 거부하고, 임시 폴더를 읽지 못해도 거부한다. 시작 프로그램, git 훅, 설정 파일처럼 코드를 실행하게 되는 곳에 쓰지 못하게 하려는 것이다.
     - 본문은 64 KiB까지만 읽고, 넘으면 거부한다. 예외는 `own.accounts`의 두 메서드다(`Policy.bodyLimit`). 둘 다 판정은 경로의 메서드 이름만 보므로 기기가 할 수 있는 일은 넓어지지 않고, 본문은 넘겨주기 위해 읽을 뿐이다.
       - `notes.put`: 워크스페이스 노트 하나가 통째로 오므로(내용 200,000자, 한글이면 JSON 약 600 KB, 02 §9.2) 1 MiB까지 읽는다(NOTES, `NOTES_BODY_LIMIT`).
       - `voice.transcribe`(02 §3.9): 녹음(base64)을 싣기 때문에 `VOICE_BODY_LIMIT`(녹음 한도 `Voice.MAX_AUDIO_BASE64` + 64 KiB, 약 5.4 MiB)까지 읽는다(VOICE, 범위 `prompt`).
     - **기기 표시(06 §2.9, 2026-10-09).** `POST /api/session/:id/prompt`(`prompt`)는 본문을 읽어(`PROMPT_BODY_LIMIT` 4 MiB. 첨부는 따로 올라가므로 큰 본문은 긴 붙여넣기뿐이다) `metadata["own.device"] = {scopes: <그 기기의 범위, 정렬>}`을 붙여 넘긴다(`Policy.stamp`). 클라이언트가 보낸 `own.device`는 덮어쓰고 다른 metadata는 그대로다. 이 PC와 `/srv/<hostId>` 모두 같다. JSON 객체가 아닌 본문은 그대로 넘기고 upstream이 거절한다. PC의 클라이언트는 게이트웨이를 거치지 않아 표시가 없다. own.team은 사용자가 말로 시킨 팀 동작의 계획을 허락할 때 이 표시를 보고, 그 기기가 같은 단추를 누를 수 있을 때만 허락으로 센다(`local` 동작은 기기 답으로 허락하지 않음). 상수와 스키마는 `OwnRemote.DEVICE_META`·`OwnRemote.DeviceStamp`다. `session.command`에는 metadata가 없어 표시를 붙이지 않는다(06 §2.9의 기록된 한계).
     - `own.accounts`의 `voice.*`(02 §3.9)는 `/srv/<hostId>`로 보내지 않는다(`remote`). 음성 키와 사용량은 이 PC의 것이고 녹음은 원격 호스트로 가지 않는다.
   - **이벤트 거르기**: 기기로 가는 SSE는 버퍼링 없이 흘리되, `local` 이벤트(`rpc.own.remote.host.prompt`, `rpc.own.remote.device.pairing.pending`, 04 §16.7)와 기기의 `servers` 밖 서버 이벤트는 프레임 단위로 뺀다. 프레임 경계(`\n\n`)까지만 모아 판정하므로 스트림 지연은 프레임 하나다.
3. **프록시.**
   - `/srv/local/api/*` → `http://127.0.0.1:28538/api/*`. 들어온 `Authorization`, `Cookie`, `Origin`, `Referer`를 지우고 서비스 Basic을 넣는다. 서비스 비밀번호는 등록 파일에서 읽는다(같은 사용자). `Origin`을 지우는 이유: 서비스 CORS는 게이트웨이 origin을 모르고(`cors.ts:11-26`), 인증은 게이트웨이가 이미 끝냈다.
   - `/srv/<hostId>/api/*` → own-remote가 가진 그 호스트의 `-L` 끝점(`http://127.0.<k>.2:<LP>`, 04 §7.3) + own-remote가 서명한 세션 토큰(04 §12.1). 호스트가 연결돼 있지 않으면 503과 `host.state`.
   - SSE는 버퍼링 없이 흘려보내고, WebSocket(PTY)은 업그레이드를 그대로 중계한다(ticket은 upstream 흐름).
4. **own-web 정적 서빙.** `/`에서 `app\<version>\web`을 서빙한다. CSP는 서비스 WebUi와 같은 규칙으로 붙인다(`packages/cli/src/services/web-ui.ts:61-70`). 그래서 기기 쪽에는 P-001/P-002가 필요 없다(19장).
5. **pairing 끝점.** `/auth/connect/<code>`(13.5).
6. **기기 정보 끝점.** `GET /own/device`(기기 인증) → `{deviceId, name, kind, scopes, servers, expiresAt, controlDir, pc}`. `pc`는 서비스를 실행하는 PC의 이름(`os.hostname()`)이다. 기기의 보기 전용 안내가 `<PC 이름>에서 확인하세요`로 그 PC를 부른다(06 §9.8, 2026-10-02 T1 리뷰 수정. 스펙 추가이고 T2 전에 사용자가 승인했다). **서버 목록 끝점.** `GET /own/servers`(기기 인증, `read`) → `[{serverKey, baseUrl:"/srv/<serverKey>", controlDir, state}]`. 기기가 볼 수 있는 `servers`만 준다. 모바일 호스트는 이것으로 04 §12의 서버 레지스트리를 채우고 `controlDir`(02 §9.1, 02 12장 Q41)을 얻는다. 로컬은 `OWN_HOME\control`, 원격 호스트는 own-remote가 아는 원격 `controlDir`(04 §16.2 `resolve`의 값, 게이트웨이가 프로세스 안에서 받음)이다. 토큰은 넣지 않는다.
7. **감사.** 기기별 요청 수, 마지막 접속 시각·IP를 5분 합계로 남긴다(`ops` 저널 방식, 04 §15). 요청 본문과 토큰은 남기지 않는다.

**항상 막는 경로(어떤 범위든).** `/api/pair`, `/auth/*`(upstream 것), `/api/credential/*`, `/api/integration/*`, `/api/location/reload`, `/api/config*` 쓰기, `POST /api/experimental/voice/session`(upstream 실시간 음성 세션. 서버에 저장된 OpenAI·xAI API 키로 만들어짐. own 음성 입력은 전용 키만 씀, 02 §3.9), upstream v2.2에서 생긴 경로(2026-10-30 sync, `packages/own-remote/src/gateway/policy.ts`): `POST /api/debug/heap-dump`(서비스 메모리의 모든 비밀이 담김), `GET /api/plugin/gui`(데스크톱 앱의 GUI 플러그인 번들), `GET /api/experimental/voice/models`, `GET /api/experimental/client-mcp`와 `POST /api/experimental/client-mcp/token`(MCP 서버는 서비스 권한으로 돎), `POST /api/experimental/generate/{text,image,decisions}`(세션 밖에서 서비스 자격 증명으로 모델 호출), `/api/experimental/automation` 여섯 경로(목록·만들기·보기·지우기·멈춤·다시 시작. upstream v2.4.0에서 v2.2의 `/api/experimental/schedule`을 대신함. 기기 없이 나중에 서비스에서 프롬프트·스크립트·셸 명령을 돌림, MR18), `POST /api/experimental/generate/video`와 `GET /api/experimental/generate/video/:id`(v2.4.0. 세션 밖에서 서비스 자격 증명으로 동영상), `GET /api/experimental/blob/:id`(v2.4.0 미디어 blob), `/api/experimental/machine` 네 경로(v2.4.0 다른 기계), `GET /api/experimental/usage/limits`(서비스 로그인의 요금제 사용량. own-web은 own.accounts로 보임), `/api/experimental/artifacts` 일곱 경로(upstream v2.2.4. 공급자의 페이지를 게이트웨이 출처에서 보여 줌, US5), `GET /api/experimental/job`(upstream v2.2.6. 모든 세션의 백그라운드 작업 목록, US6)과 `POST /api/experimental/job/:id/cancel`(v2.4.0), `GET /api/experimental/media/:hash`, `POST`·`DELETE /api/experimental/fs/watch`. 모두 own-web이 쓰지 않는다. 저장된 항상 허용 규칙을 바꾸는 `PATCH /api/permission/saved/:id`는 목록·삭제처럼 `admin` 범위다. `own.computer`의 `status`·`killswitch.engage` 밖의 모든 메서드, 그리고 `OwnAccounts.MethodScope`·`OwnRemote.MethodScope`가 `local`인 모든 메서드(02 §9.1: `accounts.add.*`, `accounts.update{replaceKey}`, `accounts.import.codex.*`, `plugin.claudeAuth.{ack,install.*,uninstall.*,changeSource.*,importSubscription}`, `plugin.trust.approve.*`. 04 §16.7: `resolve`, `respond`, `devices.*`, `gateway.*` 등). 원격 서버로 가는 `/srv/<hostId>/api/rpc/own.remote/agent.*`도 항상 막는다(04 §12.7). 특히 `/api/pair`를 막지 않으면 읽기 전용 기기가 upstream의 30일 전권 토큰을 받아 범위를 우회한다.
- v0.1은 `plugin.*` 전체를 막았지만, 02에서 `plugin.claudeAuth.status`와 `plugin.trust.list`는 `read`다. 범위표를 따른다.

**경로 접두어.** own-web 모바일 호스트는 서버마다 `baseUrl = https://<pc>.<tailnet>.ts.net/srv/<serverKey>`를 쓴다(04 §12 멀티 서버 레지스트리를 그대로, 04 §12.1이 접두어 허용을 반영함). ⚠ `@opencode/client`의 `OpenCode.make({baseUrl})`가 경로 접두어를 보존하는지 확인하지 못했다(MG5). 안 되면 서버마다 다른 포트를 `tailscale serve`에 더 여는 방식으로 바꾼다.
- 모바일 호스트의 `server.connect()`는 `auth:"device"`를 돌려준다(PWA는 쿠키, 앱은 Bearer). 03 §16.7의 `auth` 값에 `"device"`를 더하기를 요청한다(17장).

**앱 전용 리스너(08).** Android 앱과 다른 PC의 데스크톱 앱(`kind:"app"`)은 같은 게이트웨이의 두 번째 리스너(`127.0.0.1:28540`, 자체 서명 TLS, 지문 고정)로 붙는다. 같은 서버 코드라서 경로, 범위, 항상 막는 경로가 이 절과 같다. 리스너, 링크, 경로, `GET /own/routes`, `POST /own/device/revoke`의 계약은 08 §3이 기준이다.

### 13.5 기기 페어링과 토큰

**upstream pairing에서 확인한 것.**

| 항목 | upstream 동작 | 근거 |
|---|---|---|
| pairing 코드 | 16바이트 난수 base64url, 5분 TTL, 최대 1,000개, 1회용(`consume`이 즉시 무효화) | `packages/server/src/pairing.ts:7,22-31` |
| 교환 | `GET /auth/connect/:code`. 브라우저 탐색이면 30일 HttpOnly 쿠키 + 302, API 클라이언트면 `{token}` JSON | `packages/server/src/handlers/server.ts:28-51` |
| 세션 토큰 | `<만료초>.<HMAC-SHA256(key, 만료초)>`, `key = HMAC(password, "opencode-session-v1")`, 30일 | `packages/server/src/auth.ts:16,39-44,63-66` |
| 검증·폐기 | 만료가 미래면 모두 통과. 개별 폐기 없음. 비밀번호를 바꿔야 전부 무효 | `auth.ts:39,46-55` |
| 쿠키 이름 | 포트를 넣음(`opencode_session_<port>`) | `auth.ts:57-61` |
| QR 표시·스캔 | `uqr`의 `renderSVG`로 링크를 그림. 스캔은 `qr-scanner` | `packages/app/src/settings/pairing/pairing.tsx:9,119-148`, `packages/app/src/servers/connect/scanner.tsx:1` |
| 링크 모양 | `<origin>/auth/connect/<code>` | `packages/app/src/servers/connect/pairing.ts:15-22` |
| 주소 | 서버 info의 URL 중 loopback이 아닌 것(= LAN 바인딩 가정) | `pairing.tsx:28-39` |

- **그대로는 못 쓰는 이유.** 기기 식별이 없고(누가 붙어 있는지 모름), 범위가 없고(전권), 기기 하나만 끊을 수 없다(비밀번호 교체 = 데스크톱·웹·SSH 원격 토큰까지 전부 무효). 그리고 LAN 평문을 가정한다.
- **재사용하는 것.** 코드 모양과 수명(128비트, 5분, 1회용), 링크 경로 `/auth/connect/<code>`, QR 렌더러(`uqr`), 스캐너(`qr-scanner`, 네이티브 앱에서), 교환 응답 형태(`{token}`)를 따른다. 다만 이 끝점은 **게이트웨이**가 처리하고 upstream 서비스의 `/api/pair`는 쓰지 않는다.

**흐름.**

```text
PC(데스크톱 또는 웹)  설정 > 기기 > [새 기기 연결]  이름·범위·서버·만료 선택
  → own.remote devices.pair.start{name, scopes, servers, expiresDays}   (control location, 로컬 호출만)
  ← {pairingId, url: https://<pc>.<tailnet>.ts.net/auth/connect/<code>, expiresAt}
  → QR 표시 (코드는 5분, 1회용)
휴대폰 카메라 → 링크 열기 → 게이트웨이 GET /auth/connect/<code>
  → 게이트웨이: code 소비, 4자리 확인 번호(SAS) 생성, 기기에 "PC에서 승인을 기다립니다 · 확인 번호 4821"
  → 이벤트 device.pairing.pending{pairingId, sas, userAgent 요약, tailscaleUser?}
PC: "휴대폰(Safari)이 연결을 요청합니다 · 확인 번호 4821 [허용] [거부]"
  → devices.pair.approve{pairingId, sas}
  ← 기기: 토큰 발급(PWA는 Set-Cookie, 앱은 {token}) → 앱으로 이동
```

- **양쪽 확인.** 코드만으로는 기기를 등록하지 않는다. PC에서 확인 번호를 보고 허용해야 한다. QR이 어깨너머로 찍히거나 링크가 새도 PC 사용자가 모르는 기기는 등록되지 않는다. 승인 대기는 2분 뒤 만료된다.
- **저장.** `OWN_HOME\devices.json`: `{deviceId, name, kind:"pwa"|"app"|"browser", scopes[], servers[], tokenHash, createdAt, lastSeenAt, expiresAt, idleTimeoutDays, revokedAt?}`. 평문 토큰은 저장하지 않는다. 쓰기는 01의 원자적 파일 쓰기와 락을 따른다.
- **토큰.** 256비트 난수. 수명의 초기값은 01 §6.4대로 **30일, 14일 동안 쓰지 않으면 만료**이고 정책 값은 02가 정한다(02 `policy.remoteDevices` 제안, 01 §20 32번). v0.1의 90일/30일은 버린다. 앱은 Keychain/Keystore에, PWA는 HttpOnly 쿠키에만 둔다. localStorage에 두지 않는다.
- **CSRF.** PWA 쿠키는 `SameSite=Strict`이고, 상태를 바꾸는 요청은 `Origin`이 게이트웨이 origin과 같아야 한다.
- **폐기.** `devices.revoke{deviceId}`는 즉시 반영한다(게이트웨이 캐시 5초 이하). 그 기기의 열린 SSE와 WebSocket을 끊는다. `devices.revokeAll`도 둔다. upstream 서비스 비밀번호를 바꿀 필요가 없다.

**범위.** 기기 범위는 두 가지를 묶는다. (1) 플러그인 RPC는 `@own/protocol`의 범위표 `OwnAccounts.MethodScope`(02 §9.1)와 `OwnRemote.MethodScope`(04 §16.7)의 값(`read | drive | manage | local`)에 **그대로 대응**시킨다. 메서드 목록을 이 문서에 다시 적지 않는다. (2) upstream HTTP 경로는 이 문서가 정한다.

| 기기 범위 | 플러그인 RPC(`MethodScope` 값) | upstream HTTP | 기본(휴대폰) |
|---|---|---|---|
| `read` | `read` (예: `own.accounts`의 `health`, `accounts.list`, `quota.snapshot`, `session.binding`, `cache.state`, `switch.state`, `ledger.session`, `plugin.claudeAuth.status`, `plugin.trust.list`, 워크스페이스 노트 `notes.list`·`notes.get`(NOTES), 곁질문 `side.get`·`side.list`(03 §4.4.2). `own.remote`의 `hosts.list`, `catalog.get`, `feed.*`, `push.*`) | 세션·메시지 조회, 이벤트 스트림 | 예 |
| `prompt` | `prompt` (`own.accounts`의 `session.preset.raiseOnce`, 워크스페이스 노트 저장·삭제 `notes.put`·`notes.remove`(NOTES, 8.8), 받아쓰기 `voice.transcribe`(VOICE, 7.8), 곁질문 `side.ask`·`side.cancel`·`side.remove`(02 §9.7: 대화의 계정으로 모델을 부르므로 보내기와 같은 무게. 답 이벤트 `side.delta`·`side.ended`는 `own.accounts` 이벤트라 그 서버를 보는 기기에 간다)) | 프롬프트 전송, 중단, 대기열, 권한 응답(**`once`·`reject`만**, 아래), 질문·폼 응답(컴퓨터 사용 앱 허용 답 제외, 13.4), 압축(`POST /compact`)·문맥 비우기와 그 되돌리기(`POST …/reset`, `DELETE …/reset/:resetID`, 03 §18.18, RC 2026-10-24)·포크 | 예 |
| `switch` | `drive` (예: `switch.estimate`, `switch.apply`, `switch.schedule`, `switch.cancel`, `switch.undo`, `switch.waitReset`, `switch.setConfirmOverride`, `cache.setTtlMode`, `compaction.setSession`) | – | 예 |
| `files` | – | `fs.list`, 파일 내용·diff 조회, 첨부 업로드(서버 임시 폴더 안에만 쓰기, 13.4) | 아니오 |
| `terminal` | – | PTY, `session.shell`, `shell.*` | 아니오 |
| `browser` | – (`own.remote`의 `browser.status`는 `read`) | – . 게이트웨이의 보기 소켓 `/own/browser/local/<sessionID>`(8.10): 보기는 `read`와 함께, 조작은 `prompt`도 함께 | 아니오(PC에서 기기마다 켬, 8.10.2) |
| `admin` | `manage` (예: `own.accounts`의 `accounts.test`, `accounts.update`(`replaceKey` 없이), `accounts.remove.*`, `policy.set`, `ratecards.set`, `plugin.trust.revoke`, `diagnostics.selfTest`. `own.remote`의 `connect`(`hostKeyPrompt` 없이), `disconnect`, `drain.*`, `diagnostics`) | – | 아니오(기기에는 주지 않음을 권장) |
| (부여 불가) | `local` 전부 | 13.4 "항상 막는 경로" | – |

- **`switch`로 일어나는 압축(v2.0.24, 의도한 경계).** own.accounts가 압축을 서버에서 직접 넣으므로(02 §4.7.2, `ctx.session.compact`) `switch.apply`의 `compact-then-switch`·`switch-then-compact`와 `compaction.setSession`(더 일찍 압축)은 `prompt` 없이 `switch`만 가진 기기도 압축을 일으킬 수 있다. 받아들인 이유: 압축은 기록을 지우지 않고(모델 문맥만 요약으로 바뀜), 되돌리기가 걸린 세션에는 넣지 않으며(staged revert 보호), 휴대폰 기본은 `prompt`와 `switch`를 둘 다 가진다. 비용은 요약 요청 1회다. HTTP `POST /compact`는 그대로 `prompt`다(`own-protocol` 시험 `rpc.test.ts`가 두 메서드의 범위를 고정).
- `own.computer`는 이 표를 따르지 않고 13.4의 규칙을 따른다: `prompt`나 `switch`가 있으면 `status`와 `killswitch.engage`만.
- `own.team`(T1)은 자기 범위표 `OwnTeam`(06 §2.7)를 같은 낱말(`read`·`prompt`·`switch`·`admin`·`local`)로 따른다. 메인 멈춤은 `prompt`, 켜기·재구성·반영은 `admin`, 확인·push·설정 쓰기는 `local`이다. **T2 메서드**: `integration.get`·`decisions.list`는 `read`, `decisions.add`(결정 적기)는 `prompt`, `area.adopt`·`area.unadopt`·`area.integrate`·`integration.undo`는 `admin`, `integration.push.plan`·`integration.push.execute`는 `local`이다. 그래서 기기는 반영 카드와 결정 기록을 보고 결정을 적을 수 있고, `admin`을 받은 기기만 팀에 넣기·빼기·반영·되돌리기를 하며, 원격 저장소에 올리기와 확인 단계는 어떤 기기도 못 한다(own-web은 `<PC 이름>에서 확인하세요`를 보인다, 13.4의 `/own/device` `pc`). 이벤트 `rpc.own.team.integration.changed`도 다른 `rpc.own.team.*`처럼 `read`다.
- **`own.team` 범위표(T3까지).** 메서드는 T3에서 늘지 않았고 T3 동작은 이미 있던 메서드로 온다(06 §2.7). 그래서 기기에서 되는 것은 표가 정한다.

  | 범위 | `own.team` 메서드 | T3에서 기기로 되는 것 |
  |---|---|---|
  | `read` | `health`, `team.get`, `team.list`, `op.get`, `outbox.list`, `integration.get`, `decisions.list`, `settings.get`, `diagnostics` | 팀 보기, `끝낼 수 있음`(`team.get`의 `retirable`), 재구성·끝내기 카드, 보는 전용 확인 |
  | `prompt` | `team.pause`, `area.pause`, `outbox.cancel`, `area.rotate`, `main.rotate`, `area.paths`, `decisions.add` | – |
  | `switch` | `area.main`, `team.account`, `area.preset` | 원격 팀 영역의 `프리셋 바꾸기…`(그 호스트의 미러 목록, 07 §8.1) |
  | `admin` | `enable`, `disable`, `team.home`, `op.undo`, `area.adopt`, `area.unadopt`, `area.integrate`, `integration.undo`, `reorg.propose`, `reorg.apply` | 나누기·묶기·끝내기·변환·대화 옮기기, `팀 구성 다시 보기`, 재구성 되돌리기, `끝난 영역 정리하고 끄기`(`disable{cleanup}`) |
  | `local` | `op.confirm`, `integration.push.plan`, `integration.push.execute`, `settings.set` | 없음: 지우기·`.assets`·공유 폴더 보호 같은 확인은 PC에서만(`<PC 이름>에서 확인하세요`) |

  - **원격 서버(`/srv/<hostId>`, T3).** 원격 호스트의 `own.team`도 같은 표로 판정한다(04 §12.7): `local`은 403 `local`, 표에 없는 메서드는 403 `unknown`. 원격 호스트의 `own.computer`와 `own.remote`(그곳의 `agent.*`)는 언제나 막는다. 원격 팀 켜기에 필요한 git-lfs 올리기는 이 PC의 `own.remote hosts.tools.ensure`(04 §16.2)이고 범위는 `manage`(= 기기 `admin`)다.
  - 앱 기기(`kind:"app"`, 08)도 같은 표와 같은 피드를 받는다.
- **`own.import` 범위표(다른 도구의 대화, 09 §5.5).** 자기 범위표 `OwnImportRouting.MethodScope`(`@own/protocol/rpc-import-routing`)를 같은 낱말로 따르고, 게이트웨이는 그 표를 그대로 import해 판정한다(`packages/own-remote/src/gateway/policy.ts`). I1(IMPORT wave 1–5)에는 `health`만 `read`이고 나머지는 `local`이었다. 아래는 Q2 결정(2026-10-08)대로 보기 출력에 비밀 가리기가 들어간 뒤 IMPORT wave 6에 연 표다.

  | 범위 | `own.import` 메서드 | 기기로 되는 것 |
  |---|---|---|
  | `read` | `health`, `sources.list`, `sessions.list`, `sessions.read`, `sessions.search`, `jobs.list` | 사이드바의 `다른 도구의 대화 · 새 N개`, 목록, 읽기 전용 보기, 검색(내용은 `[redacted:<종류>]`로 가린 것), 진행 중인 가져오기 보기 |
  | `prompt` | `migrate.plan`, `migrate.execute`, `migrate.cancel` | `이어서 하기`(계획, 실행, 취소). 세션을 만들고 LLM 사용량을 쓰므로 메시지 보내기와 같은 무게다 |
  | `local` | `sources.configure` | 없음: 읽을 폴더(찾을 곳)는 PC의 창에서만 바꾼다. own-web은 기기 연결에서 설정 > 다른 도구와 목록의 `찾는 곳 설정` 링크를 숨긴다 |

  - **입력별 범위(IMPORT 리뷰 수정, 2026-10-09).** 게이트웨이는 메서드의 범위가 아니라 `OwnImportRouting.scopeOf(method, input)`로 판정한다. `scope:"all"`(own 프로젝트 밖까지 이 PC의 모든 대화: `모든 폴더`와 거기서 연 보기·검색·가져오기)과 `migrate.plan{redact:false}`(비밀을 남긴 가져오기)는 `local`이다. 그 밖의 `sessions.read`, `sessions.search{ref}`, `migrate.plan`은 요청한 `directory` 프로젝트의 대화에만 닿고, 밖의 대화는 `source_not_found`다(09 §5.2, §5.5). own-web은 기기 연결에서 `이 폴더 / 모든 폴더` 거르기를 숨기고 `비밀 가리기`를 끌 수 없게 둔다.
  - **보조 세션 표시.** 기기의 세션 생성·가져오기(`session-create`)와 고치기(`PATCH /api/session/:id`, `session-update`)가 metadata에 own.import의 보조 세션 표시(`own.import.helper: true`)를 담으면 403 `local`이다. own.import가 다음 시작 때 그런 세션을 지우므로(09 §4.4), 막지 않으면 `prompt` 기기가 `admin` 경로인 세션 지우기를 하게 된다. 가져온 대화의 출처 같은 다른 `own.import` 값은 통과한다(own-web의 고정·보관 표시가 metadata 전체를 다시 쓴다).

  - 이벤트 `rpc.own.import.index.changed`, `job.progress`, `job.finished`는 모두 `read`이고 대화 내용이 없어 본문을 거르지 않는다. 표가 선언하지 않은 이름은 버린다.
  - 표에 없는 메서드는 403 `unknown`, `local`은 403 `local`이다. **원격 서버(`/srv/<hostId>`)의 `own.import`는 언제나 막는다**(`remote`). v1의 own-import는 이 PC의 Codex·Claude Code 저장소만 읽고 SSH 호스트에 싣지 않는다(04 §4.1, 09 §7.1 I3).
  - 가져오기 자체(`POST /api/experimental/session/import`)는 own-import가 서비스 비밀번호로 loopback에서 부르므로 게이트웨이를 지나지 않는다. 기기가 그 경로를 직접 부르는 것은 기존 규칙(`admin`, `computer` 허용 규칙이면 `local`, 13.4)대로다.
- **`local`은 어떤 기기 범위로도 줄 수 없다.** 비밀을 받거나(키, 로그인), 로컬 경로를 읽거나(Codex 가져오기, 신뢰 승인, `~/.ssh/config`), 프로세스 안에 코드를 설치하거나(claude-auth), 서버 접근 토큰을 돌려주거나(`resolve`), 기기·게이트웨이 자체를 관리하기 때문이다(02 §9.1, 04 §16.7).
- v0.1과 달라진 점: `switch.estimate`는 PLANNED 상태를 만들고 비밀을 미리 읽는 상태 변경이라 `read`가 아니라 `switch`(= `drive`)다. `admin`은 02의 `manage`로 좁혔다. 계정 추가·가져오기·플러그인 설치는 `local`이라 `admin`으로도 안 된다.
- **권한 응답은 한 번만.** `prompt` 범위 기기는 권한 dock에서 `once`와 `reject`만 보낼 수 있다. `always`("항상 허용" 저장)는 게이트웨이가 본문을 보고 403 `scope_denied`로 거부한다(13.4). 01 §13.4의 "항상 허용 저장은 데스크톱에서만"을 이렇게 강제한다. own-web 모바일 UI는 이 버튼을 숨긴다.
- **기기에 묶인 메서드.** `feed.list`, `feed.ack`, `push.register`, `push.unregister`(04 §16.8, `read`)는 게이트웨이가 입력의 `deviceId`를 호출 기기의 것으로 덮어쓴다. 기기는 자기 커서와 자기 구독만 다룬다(04 §16.7의 ⚠를 이렇게 확정).
- 이벤트는 모두 `read`다. 예외(`host.prompt`, `device.pairing.pending`)는 13.4의 이벤트 거르기가 뺀다.
- `servers`는 기기가 볼 수 있는 서버 키 목록이다(`local`, `h-7k2m` …). 기본은 모두.

### 13.6 알림 피드와 푸시

**피드(M1, 01 P8).** 서비스 쪽에 내구 알림 목록을 둔다. 휴대폰이 오프라인이던 동안의 사건을 보이려면 푸시(M2)보다 먼저 필요하다(MG6, MG10). 푸시는 이 피드를 기기에 알리는 수단일 뿐이고, 원본은 피드다.

| 항목 | 내용 |
|---|---|
| 항목 | 03 §21.3의 `FeedItem`을 그대로 쓴다: `{id, kind, serverKey, sessionID?, title, body?, severity, at, action?}`. `kind`도 03의 어휘다: `turn.completed`, `input.required`(권한·질문·폼), `limit.exhausted`, `limit.reset`, `auth.expired`(`account.status`의 `needs_reauth`·`auth_failed`), `codex.stale`(경보 `codex_source_stale`, 결정 D7), `switch.applied`, `background.done`, `compaction.failed`, `remote.state`(원격 호스트 끊김 등). v0.1의 `permission.asked`·`question.asked`·`quota.*`·`host.disconnected`는 버린다 |
| 더해 달라고 요청하는 kind | `switch.suggested`(01 §6.5와 02 §9.1 푸시 후보에 있음), `billing.alert`(`claude_slot_billing`·`claude_extra_usage`, 02 §8.9). 03 §21.3에 더해지기 전에는 만들지 않는다(17장) |
| 만드는 곳 | own-runtime의 고정된 런타임 안의 **피드 생산자**(13.4 "고정과 깨우기" 3번). 로컬 서비스 `/api/event`를 loopback으로 구독해 세션 이벤트와 `rpc.own.accounts.*`·`rpc.own.remote.*` 이벤트를 `FeedItem`으로 바꾼다. 원격(SSH) 세션의 사건은 own-remote leader의 원격 `/api/event` 구독(04 §12.3)이 준다. 이 구독은 04 v0.3에서 생겼다(04 §24 27번, v0.2의 "own-remote는 원격 스트림을 구독하지 않는다"를 바꿈). RPC는 own-remote가 `own.remote`로 등록한다(04 §16.8). 03 §21.3이 열어 둔 "own-telemetry 또는 own.accounts `feed.*`"는 이것으로 정한다 |
| 저장 | `OWN_HOME\feed\feed-YYYY-MM.jsonl`, 30일·1만 개 상한. 기기별 커서 `devices.json`의 `feedCursor` |
| 읽기 | `own.remote` `feed.list{after, limit}`, `feed.ack{upTo}`(기기에 묶임, 13.5). 데스크톱의 벨 목록(03 §9, 지금은 로컬 50개)은 01 §6.5의 `NotificationFeed` 어댑터로 받고, M2부터 이 피드를 원본으로 쓸 수 있다 |
| 내용 규칙 | 모델 출력·프롬프트·경로·비밀을 넣지 않는다. `title`은 세션 제목(설정에서 끌 수 있음). `body`는 서버 쪽 피드에서 비운다(푸시 중계를 거치므로, 03 §21.3) |

- 이벤트 스트림(`/api/event`)은 휘발성이라(연결당 4096 프레임, 끊긴 동안 유실, `packages/server/src/event-feed.ts:8,64-68`) 기기가 오프라인이던 동안의 사건을 알 수 없다. 피드가 이것을 메운다.
- **FeedKind `team.decision`(06 T3, 06 §9.8).** 팀이 PC의 결정을 기다리거나 반영이 실패한 것을 기기에 알린다. `@own/protocol` `OwnRemote.FeedKind`에 더한 값이다(03 §21.3의 kind 목록에도 더함).

  | 항목 | 내용 |
  |---|---|
  | 계기와 세기 | `rpc.own.team.op.confirm`(확인 단계: 지우기, 큰 내려받기, `.assets`, 공유 폴더 보호, `반영하기 전에 묻기`) → `warn`. 상태 `failed`인 `rpc.own.team.integration.changed` → `danger`. `conflict`(담당이 먼저 풂, 06 §7.3), `done`과 그 밖의 상태는 항목이 아니다 |
  | 가리키는 곳 | 팀 메인 대화: 그 서버의 control location에서 `own.team team.list` → `team.get`으로 `main.sessionID`를 찾고, 제목은 그 세션 제목(120자까지). 찾지 못하면 `sessionID`·제목 없이 남긴다. 단계 문장, 파일 목록, nonce, manifest, 경로는 넣지 않는다(위 내용 규칙) |
  | 합치기 | 같은 팀·같은 세기는 사건이 올 때 10초 안이면 하나로 합친다(실패가 확인에 합쳐지지 않음) |
  | 출처 | 이 PC의 팀은 위 로컬 `/api/event` 구독. SSH 원격 팀은 **준비된 호스트마다 좁은 구독 하나**(04 §12.3): own-remote 터널의 끝점과 서명한 토큰을 프로세스 안에서 받아 `rpc.own.team.*`만 읽고, 끊기면 1–30초 backoff로 다시 붙고, 호스트가 `ready`를 벗어나면 끝낸다. 항목의 `serverKey`는 hostId라 그 호스트를 `servers`에 갖지 않은 기기의 `feed.list`와 `feed.item`에서 빠진다 |
  | 확인 | 호스트마다의 좁은 구독과 이 항목 모양은 06 §11.1 스펙 추가 (3)이고 2026-10-05에 사용자가 승인했다. own-web에는 아직 피드 화면이 없다(03 §21.3) |
- `stop()`은 로컬 구독과 그 backoff도 끝낸다(T3에서 고침: 전에는 빠른 stop → start가 로컬 구독 둘을 남길 수 있었다).

**푸시 전송(M2–M3).**
- **PWA: Web Push 먼저.** 서비스가 기기의 push 구독(endpoint + 공개키)으로 직접 보낸다. VAPID(RFC 8292)로 서명하고 페이로드는 RFC 8291로 암호화하므로 push 서비스(FCM, APNs 웹 푸시, Mozilla)는 내용을 읽지 못한다. 우리 중계 서버가 필요 없다. VAPID 개인키는 vault(`vault\push-vapid.dpapi`)에 둔다. ⚠ iOS는 홈 화면에 추가한 PWA에서만 Web Push를 받는다(외부 사실, 미검증).
- **네이티브 앱: FCM/APNs 중계(M3).** 서버 키가 필요하므로 작은 중계를 둔다. 중계에는 불투명 id와 `kind`만 보낸다(내용 없음). 기기는 푸시를 받으면 게이트웨이에서 피드를 읽는다.
- **푸시 페이로드.** `{feedId, kind, serverKey, sessionID}`와 선택적 제목. 알림을 누르면 앱이 열리고 해당 세션으로 간다. 알림 동작 버튼으로 승인하거나 보내지 않는다(7.4와 같은 원칙).
- 서비스 워커: 01 §6은 "서비스 워커는 MVP에서 쓰지 않는다"다. Web Push와 PWA 설치에는 서비스 워커가 필요하므로, **게이트웨이 origin에서만**, 앱 셸은 network-first + 버전 확인으로 둔다(17장). 로컬 웹 폴백 origin에는 두지 않는다.

### 13.7 오프라인과 재연결

- **목록은 기다리지 않는다.** 기기는 마지막 세션 목록 스냅샷(04 §12.3 catalog와 같은 모양, 기기 IndexedDB)을 먼저 보이고 `연결 끊김 · 12분 전 목록`으로 흐리게 표시한다.
- **재연결.** SSE는 `@opencode/client`의 재연결 루프를 쓴다(04 §12.2). 다시 붙으면 01 §6의 재동기화 목록을 다시 읽고, 피드 커서 이후 항목을 가져온다.
- **초안.** 입력 중인 초안은 기기에 저장한다. 끊긴 동안 `보내기`는 비활성이다. 다시 붙었을 때 자동으로 보내지 않는다(사용자가 모르는 사이 턴이 시작되지 않게).
- **PC가 잠들었거나 꺼짐.** tailnet에서 PC가 사라진다. 기기는 `PC에 연결할 수 없습니다(절전 또는 꺼짐)`을 보인다. Wake-on-LAN은 범위 밖이다. 원격 접근을 켠 동안 절전을 막을지는 선택(7.6).
- **서비스 재시작.** 게이트웨이는 서비스와 함께 멈춘다. 다시 뜨려면 launcher의 기동 깨우기(13.4)나, 셸이 띄운 서비스라면 앱의 첫 control RPC(13.4 2번)가 control location을 불러야 한다. launcher를 거치지 않은 재시작(예: raw exe)은 게이트웨이를 띄우지 않는다 ⚠(MG9). 기기 토큰은 파일에 해시로 남아 있으므로 다시 페어링할 필요가 없다.
- **모바일 네트워크.** SSE가 긴 유휴에 끊기지 않게 게이트웨이가 15초마다 주석 줄(keep-alive)을 보낸다. ⚠ 서비스 SSE 자체의 heartbeat 간격과 겹치는지 MG6에서 본다.

### 13.8 보안 위협

전제는 01 §13, 04 §15와 같다. 목표에 두 가지를 더한다: (10) 원격 기기는 필요한 범위만 가진다, (11) 기기 하나를 잃어도 그 기기만 끊으면 된다.

| 위협 | 완화 | 남는 위험 |
|---|---|---|
| 서비스·게이트웨이가 LAN에 평문으로 노출 | 게이트웨이는 loopback(또는 확인된 WireGuard 주소)만. LAN·`0.0.0.0` 바인딩 거절. 서비스는 127.0.0.1 그대로(01 §13). MG1 | 사용자가 Tailscale을 끄고 다른 도구로 포트를 여는 경우 |
| 휴대폰 분실·도난 | 기기별 폐기, 14일 유휴 만료(초기값, 02가 정함), 앱은 OS 잠금 + (선택) 생체 인증 뒤 토큰 사용, `admin`·`terminal` 기본 끔, "항상 허용" 저장 불가 | 폐기 전까지 `read`·`prompt`·`switch` 가능 |
| pairing 링크·QR 유출 | 1회용 5분, PC 쪽 확인 번호 승인 필수, 시도 속도 제한 | 사용자가 확인 번호를 보지 않고 허용 |
| 범위 우회(`/api/pair`로 전권 토큰 획득 등) | 허용 목록, 13.4의 항상 막는 경로, MG3 매트릭스 시험 | upstream이 새 경로를 더하면 허용 목록 밖이라 막힌다(기능 누락 쪽으로 실패) |
| tailnet 안의 다른 기기·사용자 | 기기 토큰 필수, (선택) serve 사용자 식별 헤더가 허용 목록에 있어야 함 ⚠ | tailnet 관리자 권한 탈취 |
| 같은 PC의 다른 프로세스가 게이트웨이에 직접 접속 | 기기 토큰 필수 | 같은 사용자 코드(01 §13 전제) |
| 원격(SSH) 서버로 가는 권한 | 기기는 원격 토큰을 받지 않고, `servers` 범위로 제한. 게이트웨이가 own-remote 토큰을 넣음 | 기기 범위 안에서는 원격 세션도 조작 가능 |
| 푸시 경로로 내용 유출 | 페이로드 암호화(Web Push), 중계에는 id만, 내용 없음 | 제목 표시를 켜면 잠금 화면에 세션 제목이 보임 |
| XSS(own-web) | 게이트웨이 origin CSP(web-ui와 같은 규칙), 데스크톱 렌더러는 own-web `index.html`의 CSP meta(6.4), 원격 transcript 정화(04 §15) | 로컬과 같은 등급. 데스크톱 렌더러의 XSS는 IPC와 main의 Basic 주입까지 닿으므로 CSP의 `script-src`가 핵심이다 |
| 토큰이 로그·URL에 남음 | 토큰은 쿠키·헤더로만, URL에 두지 않음(pairing 코드만 1회용으로 URL에), 로그는 `deviceId`만 | – |
| 서비스 비밀번호 노출 | 기기로 가지 않음. 게이트웨이가 서비스 안에서 넣음 | – |
| DoS | 기기별·IP별 속도 제한, SSE 동시 수 상한(기기당 서버마다 1) | – |

- **G14 확장**(01 §16.1): `devices.json`, 피드, 게이트웨이 로그·ops 저널, push 구독 파일에서 토큰·키 패턴을 스캔한다(MG8). 데스크톱 쪽으로는 셸 로그 폴더(userData, 렌더러 콘솔 복사본 포함, `native/logging.ts:108`)와 net-log를 더한다(6.4).

### 13.9 앱 형태 (미래)

| 단계 | 형태 | 비고 |
|---|---|---|
| M1 | 휴대폰 브라우저 + PWA 설치 | 게이트웨이가 서빙하는 own-web. `OwnHost(mobile)`은 `web` 구현에 게이트웨이 인증(`auth:"device"`), 서버 목록(`GET /own/servers`), 오프라인 목록(13.7)을 더한 것 |
| M2 | PWA + Web Push | 13.6 |
| M3(선택) | Capacitor 래퍼 | 같은 own-web 번들. Keychain/Keystore 토큰, FCM/APNs, 카메라 QR 스캔(`qr-scanner` 또는 네이티브). 스토어 배포 여부는 사용자 결정 |

---

## 14. 게이트

### 14.1 데스크톱 G-D1–G-D6 (기준: 01 §16.2)

게이트 이름, 필수 여부, 기본 통과 기준은 01 §16.2가 기준이다. 아래는 이 문서가 **더하는** 시나리오와 기준이다. 01 표와 다른 점은 17장 01 항목에 적었다.

| 게이트(01 필수 여부) | 이 문서가 더하는 시나리오 | 더하는 통과 기준 |
|---|---|---|
| **G-D1** upstream 서비스 보존(must) | upstream OpenCode(또는 OpenCode Dev) 서비스가 `service.json`으로 **다른 버전**으로 떠 있을 때 패키지된 own-desktop 설치·실행·종료. own 서비스가 없는 경우와 있는 경우 | `service.json`의 해시·mtime 불변, 셸 로그의 launcher 실행이 `powershell.exe … own.ps1 start` 한 번뿐 |
| **G-D2** OS 통합 격리(must) | 설치 → 첫 실행 → 종료 → 제거. 전후로 `HKCU\Software\Classes\opencode`, `…\own`, `Documents` 목록 기록 | 번들에 `setAsDefaultProtocolClient` 호출 0(문자열 검사), 번들에 `ai.opencode.desktop` 문자열 0 |
| **G-D3** 창과 서비스 수명 분리(must) | (a) fake-provider 60초 스트리밍 턴 중 모든 창 닫기, 1분 뒤 다시 실행. (b) 브라우저를 쓰는 세션에서 WCO 닫기, `Alt+F4`. (c) 패키지 빌드에서 `Ctrl+W`, `Ctrl+R`, `Ctrl+Shift+I`, 확대 키. (d) composer에서 `Ctrl+C/V/X/Z/A`. (e) `plugin.claudeAuth.changeSource.execute` → `host.server.restart({claudeConfigDir})` → `importSubscription`. (f) 실행 중 세션이 있을 때 `restart({force:false})` | (a) 턴 완료, 서비스 pid 동일, 재실행 뒤 결과 보임. (b) 7.2 확인 대화상자가 뜨고 [취소]면 창 유지. (c) 창 닫기·다시 로드·개발자 도구 0, 확대는 `window.zoom` 경로로만 되고 WCO 밴드 높이가 배율과 맞음. (d) 모두 동작(메뉴를 비운 뒤, 7.7). (e) 새 서비스 env에 `CLAUDE_CONFIG_DIR=<dir>`만 있고 다른 `CLAUDE_*` 없음, `importSubscription` 성공. (f) `{ok:false, refused:"session_running"}`, 서비스 pid 불변 |
| **G-D4** 알림(should, 알림 기능 전 must) | NSIS로 설치한 빌드. 창을 최소화하고 턴 완료·권한 요청 | 알림 센터에서 AUMID `dev.own.opencode.desktop`으로 묶임, toast에 승인 버튼 없음. (부가) 앱 종료 뒤 남은 toast 클릭 동작 기록 |
| **G-D5** 브라우저 패인(must, P5) | (a) 데스크톱 세션에서 `tools.browser.tabs.open` → `snapshot` → `click`. (b) 같은 세션을 두 번째 창에서 열기. (c) 서비스 재시작. (d) 창 다시 로드. (e) 다운로드가 있는 탭 닫기. (f) 도구 목록: 8.7 결정에 따른 시나리오(아래). (g) (should, 04 R1 = P6 이후) 원격 세션 패인, 토큰 재서명 뒤에도 탭 동작 | (a) `attached` 15초 이내. (b) 첫 창은 `replaced` 문구. (c)(d) own-web이 다시 register해 붙음(8.2). (e) 저장 안내가 뜨고, 닫은 뒤 그 탭의 `%TEMP%\opencode-browser-client-*` 없음. (f) 요청 `definitions` 해시는 모든 경우 불변(`execute`만 들어감, 8.7). (g) 트래픽이 원격 호스트에서 나감 |
| **G-D6** 셸↔렌더러 계약(must) | (a) 셸 N + UI N, (b) 셸 N + UI N+1(IPC 계약 변경), (c) `app\<version>\web` 없음, (d) **셸이 떠 있는 동안 `app\current.json`을 N+1로 바꾸고(own update·rollback과 같음) 창 다시 로드** | (a) 정상. (b)(c) 폴백 페이지와 이유. (d) own-web의 불일치 화면, upstream IPC 호출 0(T0-0), 크래시 없음. 모든 경우 `manifest.json`의 `desktop.rpc_hash`를 읽음 |

**G-D5 (f) 도구 목록 시나리오(8.7 결정 뒤 하나만 남긴다).**
- 안 D로 정해지면: 웹에서 만든 세션의 카탈로그 기준선에 `browser` namespace 없음. 데스크톱에서 `이 세션에서 켜기` 뒤 그 세션에 `InstructionsUpdated` 1건(전체 카탈로그 교체 문구)만 더해지고, 그 앞까지 `cache.read ≥ 0.9 × 직전 P`(01 G4 방식). 교체 문구의 토큰 수를 기록. 같은 세션을 데스크톱·웹·(M1) 휴대폰으로 번갈아 열어도 `InstructionsUpdated` 0건.
- 설치 프로필(안 B)로 정해지면: 01 §16.2 G-D5의 "프로필 전환 시에만 변화"를 "프로필 전환 때 세션마다 `InstructionsUpdated` 1건, 그 밖에는 0건"으로 판정한다.

### 14.2 PF를 셸에서, 셸 전용 점검

- PF1–PF8의 판정은 01 §16.3이다. 셸에서 재는 방법은 9.1 표이고, P4 종료부터 패키지 셸에서 모두 잰다(01 §16.3).
- SC1–SC5는 9.1 두 번째 표다. 결과는 `own/release/<ver>/perf.json`에 PF와 함께 적는다. must인 SC(SC2–SC4)가 실패하면 PF 실패와 같이 출시를 막는다.

### 14.3 원격 접근 MG1–MG10 (M1 = 01 P8부터)

| 게이트 | 필수 | 시나리오 | 통과 기준 |
|---|---|---|---|
| **MG1** LAN 비노출 | must | 게이트웨이 켬, 같은 LAN의 다른 기기에서 포트 스캔, `bind` 설정을 LAN 주소로 바꿔 봄 | 서비스·게이트웨이 리스너가 loopback(과 확인된 터널 주소)에만, LAN에서 연결 0, LAN 바인딩은 `bind_rejected_lan` |
| **MG2** 페어링 | must | 정상 페어링, 코드 재사용, 5분 뒤 사용, PC에서 거부, 확인 번호 불일치, 코드 무차별 대입 | 정상만 성공, 나머지 실패, 속도 제한 동작, 실패 시 기기 레코드 0 |
| **MG3** 범위 | must | 기기 범위마다(`read`만, `read+prompt+switch`, `admin`) `OwnAccounts.MethodScope`·`OwnRemote.MethodScope`의 모든 메서드, 13.4 "항상 막는 경로", PTY, `accounts.update{replaceKey}`, `connect{hostKeyPrompt:true}`, 권한 응답 `always`. 02 AC-P43과 같은 매트릭스 | 범위 밖과 `local`은 전부 403, 서비스 로그에 해당 요청 0(게이트웨이에서 멈춤), 기기 SSE에 `host.prompt`·`device.pairing.pending` 프레임 0 |
| **MG4** 폐기 | must | 기기가 SSE·PTY를 연 상태에서 `devices.revoke` | 5초 안에 모든 요청 401, 열린 스트림 끊김, 다른 기기·데스크톱 영향 0 |
| **MG5** 원격 세션 경유 | must(04 R1 = P6 이후) | 휴대폰에서 SSH 원격 세션 열기·프롬프트·전환 | 기기가 받은 응답·저장소에 원격 토큰·비밀번호 0, `/srv/<hostId>` 경로 접두어 동작, 04 RG13 기준 충족 |
| **MG6** 오프라인·재연결 | must | 비행기 모드 5분, 네트워크 전환(Wi-Fi ↔ LTE), 서비스 재시작 | 목록 캐시 표시, 재연결 뒤 재동기화, 그동안의 알림이 피드로 복구, 초안 보존, 자동 전송 0 |
| **MG7** 푸시 | must(M2) | 턴 완료·권한 요청, 앱 종료 상태 | 알림 도착, 페이로드에 내용 없음(설정대로 제목만), 클릭 시 해당 세션, 알림 동작으로 승인 불가 |
| **MG8** 비밀 위생 | must | 01 G14 스캔을 `devices.json`, 피드, 게이트웨이 로그, push 구독 파일, 셸 로그 폴더(렌더러 콘솔 복사본), net-log로 확장 | 평문 기기 토큰·서비스 비밀번호·원격 토큰 0 |
| **MG9** 데스크톱 없는 재시작 | must | 게이트웨이 켬, 데스크톱 셸을 끈 상태에서 `own restart`(launcher)와 로그온 작업 기동, 그리고 raw 재시작(launcher 없음)을 따로 | launcher 경로는 60초 안에 휴대폰이 붙음(깨우기, 13.4). raw 경로는 붙지 않는 것을 기록(⚠ 13.7). 피드 생산자가 `/api/event`로 모든 Location의 세션 이벤트를 받음 |
| **MG10** 긴 유휴 | must | 게이트웨이 켬, 데스크톱 끔, 모든 세션 유휴로 90분(Location 해제 시각 60분을 넘김). 그 사이 터미널의 `own run`으로 턴 하나 완료 | 90분 뒤 휴대폰이 붙음, 서비스 pid·게이트웨이 포트 불변, 그 턴의 `turn.completed`가 피드에 있음, 연결된 SSH 호스트 터널 유지(04 RG1과 함께) |

---

## 15. 단계

**기준은 01 §17(P0–P8, 후속)이다.** 아래 DS·M은 그 단계 안의 하위 이정표다. 01의 순서(P3 own-web 코어 → P4 셸 v0 → P5 필수 기능과 브라우저 패인 → P6 SSH → P7 → P8 모바일 기반)를 바꾸지 않는다.

| 하위 이정표 | 01 단계 | 기간(1인, 대략) | 내용 | 종료 기준 |
|---|---|---|---|---|
| **M0 이음매** | P2–P3에 분산 | – | capability 게이트(03 §16.7, P3 `OwnHost`(web)), `mobile` kind 자리, 03의 반응형·터치 규칙, 서버 목록의 baseUrl 추상화(경로 접두어 허용, 04 §21-1), `FeedItem` 형식(03 §21.3), own-runtime의 리스너 수명 규칙(13.4)을 04 브로커와 같은 코드로, "LAN 금지" 검사(G1에 포함) | 코드 리뷰 체크리스트 |
| (P3 안) 개발 셸 | P3 | 1–2일 | 11.2의 개발 셸 실행을 P3 안에서 먼저 쓴다. PoC(`own-desktop-poc\`)로 own-web을 Electron 안에서 띄워 IME·스크롤을 일찍 본다. 판정은 하지 않는다 | 없음(참고 측정) |
| **DS0 셸 v0** | P4 | 3–5일 | `packages/own-desktop` 생성(PoC에서 시작), 설정 2개, 치환 2개와 drift 검사, preload vendor와 `window.own`, BackgroundService·DesktopCli layer, `own-env`, 렌더러 위치(`app\<version>\web` + 폴백)와 rpcHash(`rpc-hash.mjs`), 앱 메뉴 비우기, `build-own.ps1` 단계, NSIS 무서명 빌드, `own open` 변경, 원장·check-surface 항목 | G-D1, G-D2, G-D6 통과, SC2 |
| **DS1 네이티브 기본** | P4 | 1–2주 | own-web `OwnHost`(desktop)와 T0, WCO 밴드, 폴더 선택·드래그·클립보드·에디터로 열기·탐색기, 알림 규칙과 클릭 라우팅, 서비스 재시작(`claudeConfigDir` 포함, launcher 종료 코드 4), 창 닫기 확인, bench 어댑터 | G-D3, G-D4 통과, **PF1–PF8을 패키지 셸에서 통과**(01 §16.3의 P4 조건), SC1·SC3–SC5 |
| **DS2 브라우저 패인** | P5 | 2–3주 | 03 §18.17의 패인 UI(vendor + 어댑터), 8.7 결정에 따른 도구 목록 장치 하나, 캡처 자리 표시, 파일 목록과 `PC에 저장`, 닫힘 이유 문구, 재등록 규칙(8.2). (P6 이후) 원격 세션 패인 | G-D5 통과 |
| **M1 원격 접근** | P8 | 3–4주 | 게이트웨이(리스너·고정·깨우기·인증·범위·프록시·정적 서빙), `devices.*`와 페어링 UI(QR, 확인 번호), Tailscale serve 안내·감지, PWA(설치, 오프라인 목록), 피드 생산자 | MG1–MG6, MG8–MG10 통과. 01 P8 종료 기준 |
| **DS3 선택** | 후속 | 1–2주 | ~~트레이·창 닫아도 상주(7.3)~~ 구현(2026-10-18), 턴 중 절전 방지(7.6, [gap] #36), 로그온 시작(`own logon`), 여러 창 다듬기, (결정되면) 서명 | 기능별 수용 시험 |
| **M2 푸시** | 후속 | 1–2주 | Web Push(VAPID in vault), 기기별 알림 설정 | MG7 통과 |
| **M3 네이티브 앱(선택)** | 후속 | – | Capacitor 래퍼, FCM/APNs 중계 | 사용자 결정 |

- **v0.1과의 차이.** v0.1은 "DS0을 Phase 2 시작과 함께, own-web MVP를 처음부터 셸 안에서"라고 01보다 셸을 앞당겼다. 01 §16.3은 PF2–PF5·PF7을 P3부터 웹 폴백·Vite preview에서 재고, P4부터 셸에서 전부 잰다. 결정 D4("첫 구현부터 성능")는 이것으로 지켜진다고 보고, 순서 변경 요청은 하지 않는다. 대신 P3 안에서 개발 셸을 참고 측정용으로 먼저 쓴다(위 표).
- **SSH와의 겹침.** DS2의 원격 세션 패인과 M1의 `/srv/<hostId>` 프록시는 04 R1(01 P6)이 끝나야 시험할 수 있다. P8은 P6·P7 뒤이므로 순서가 맞다.

---

## 16. 새 계약 요약

다른 문서와 구현이 맞춰야 하는 것만 모았다.

| 계약 | 내용 | 기준 절 |
|---|---|---|
| 셸 정체성 | 제품명 `Own OpenCode`, appId·AUMID `dev.own.opencode.desktop`(dev `…desktop.local`), 실행 파일 `%LOCALAPPDATA%\Programs\own-desktop\own-desktop.exe`, userData `%APPDATA%\dev.own.opencode.desktop` | 4.6 |
| 설치 레이아웃 추가 | `app\<ver>\web\`(own-web 정적 파일), `manifest.json`의 `desktop.rpc_hash`(FORK §8.3 키) | 5.5, 10.1 |
| rpcHash | 입력: `packages/desktop/src/shared/{ipc-rpc.ts, ipc-rpc/*.ts, ipc-transport.ts, ipc-contract.ts, window-bootstrap.ts}` + `packages/own-desktop/src/preload/own-api.ts`. 계산: `own/scripts/rpc-hash.mjs` 하나, own-web 빌드 전에. 새기는 곳: own-web 진입 모듈, 셸 main·preload, `desktop.rpc_hash` | 5.5, 10.1 |
| 서비스 연결 | 셸은 스냅샷 env로 정한 `service-own.json`을 discover → 없으면 `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <OWN_HOME>\bin\own.ps1 start`(`shell:false`). `ensure` 금지. 셸은 서비스를 교체하지 않음 | 5.2, 5.3 |
| launcher | `own open` = 데스크톱 실행(설치돼 있으면), `own open --browser` = msedge 폴백, `own restart --claude-config-dir <dir>`(또는 `default`로 지움. 값 저장, 브리지 env에 `CLAUDE_CONFIG_DIR`만 예외로), 실행 중 세션 거부 = 종료 코드 4, (M1+) 기동 뒤 게이트웨이 깨우기 | 5.7, 13.4 |
| `window.own`(preload vendor 필수) | `shell.{rpcHash, version, startedAt, controlDir}`, `service.status()` → `{running, version?, registration?, managed}`, `service.restart({force, claudeConfigDir?})` → `{ok:true}`, `{ok:false, refused:"session_running"}`, `{ok:false, refused:"launcher_failed", detail}` 중 하나. IPC 채널 `own:shell.info`, `own:service.*` | 5.6 |
| OwnHost | 모양과 capability 이름은 **03 §16.7이 기준**. 이 문서는 데스크톱 구현 대응표(6.2), T0 순서(T0-0 rpcHash 재검사, T0-6 `own:shell-start`), 추가 요청(`fs.saveFile`, `window.multi`, `auth:"device"`) | 6 |
| 데스크톱 인증·보안 | 렌더러는 Authorization·쿠키 없이 로컬 서비스 호출, API는 main document에서만, own-web `index.html` CSP meta, 콘솔에 비밀 출력 금지 | 6.4 |
| 앱 메뉴 | Windows 패키지 빌드는 `Menu.setApplicationMenu(null)`(dev는 개발자 도구 키만) | 7.7 |
| 브라우저 도구 목록 | **미결.** 안 D(세션 권한 새김) 권고, 설치 프로필(01/02)과 하나로 정할 때까지 어느 장치도 구현하지 않음 | 8.7, 17.1 |
| 패인 재등록 | 원격 토큰 재서명, `epoch` 변경, 로컬 서비스 재시작, 창 다시 로드 때 own-web이 다시 register | 8.2 |
| 게이트·점검 이름 | G-D1–G-D6(기준 01 §16.2, 이 문서는 시나리오 추가), PF1–PF8(기준 01 §6.6·§16.3), SC1–SC5, MG1–MG10(이 문서) | 9.1, 14 |
| (M1+) 기기 범위 | `read`↔`read`, `switch`↔`drive`, `admin`↔`manage`, `local`은 부여 불가(`OwnAccounts.MethodScope`, `OwnRemote.MethodScope`). `prompt`·`files`·`terminal`은 upstream HTTP. 권한 응답 `always` 거부. `feed.*`·`push.*`는 호출 기기에 묶음 | 13.5 |
| (M1+) 게이트웨이 수명 | 리스너는 own-runtime 프로세스 수명 런타임, 켠 동안 런타임 고정(pin), launcher 기동 깨우기, 피드 생산자는 loopback `/api/event` 구독 | 13.4 |
| (M1+) 게이트웨이 서버 목록 | `GET /own/servers`(기기 인증, `read`) → `[{serverKey, baseUrl, controlDir, state}]`. 모바일의 서버 레지스트리와 `controlDir`(02 12장 Q41)의 출처 | 13.4 |
| (M1+) `own.remote` 메서드·이벤트·오류 | 04 §16.8 표 그대로(이름과 범위는 04, 입력·출력·동작·저장은 이 문서) | 13.4–13.6 |
| (M1+) 피드 항목 | 03 §21.3 `FeedItem`, `kind` 어휘도 03. 추가 요청 `switch.suggested`, `billing.alert` | 13.6 |
| (M1+) 저장 파일 | `OWN_HOME\devices.json`, `OWN_HOME\feed\feed-YYYY-MM.jsonl`, `vault\push-vapid.dpapi`, push 구독 파일, 게이트웨이 설정(위치는 02 §2.3), launcher 설정(`claudeConfigDir`, 위치는 02 §2.3) | 5.7, 13.4–13.6 |

---

## 17. 다른 문서와 맞출 것

v0.3 판(01/02/03/04/FORK, 2026-09-27)을 기준으로 다시 썼다. 이미 반영된 항목(01 §4.1 표, §5.3 데스크톱 흐름, §6.1 데스크톱 행, §13.3, §16.2 게이트 표, 04 §0-3·§4.1·§12.1 등)은 뺐다. 각 항목에 이 문서의 결정과 상대 문서에서 바꿀 곳을 적는다.

### 17.1 하나로 정해야 하는 것: 브라우저 도구 목록 (결정 필요, P5 시작 전)

- **충돌.** 01 §0-12·§10.1·§16.2 G-D5·§20 24번, 02 D10(4.3)·AC-P42·§12 25번은 **설치 프로필**(웹 전용 설치는 own 전역 config로 처음부터 끔)을, 03 §18.15·§18.17과 이 문서 8.7은 **세션 생성 때 권한 새김(안 D)**을 정했다. 04 §24 37번은 이 차이 때문에 원격 managed config를 정하지 못하고 있다.
- **소스 증거(8.7).** Code Mode 도구는 요청 `definitions`에 들어가지 않고 `execute`만 들어간다(`packages/core/src/tool.ts:234-259`). 카탈로그 변경은 기준선 뒤 durable `InstructionsUpdated`로 덧붙어 기존 prefix를 유지한다(`session/instruction-state.ts:41-60`). 덧붙는 문구는 `browser`가 설명 있는 namespace라 전체 교체다(`codemode/instructions.ts:32-48`, `plugin-browser/src/tools.ts:35-39`). 그래서 "세션 권한이면 세션이 cold"와 "프로필 전환이면 모든 세션이 cold" 둘 다 사실과 다르다.
- **이 문서의 권고: 안 D.** 이유는 8.7. 결정 전에는 어느 장치도 만들지 않는다.
- **안 D로 정해지면 바꿀 곳.**
  - 01 §0-8의 "도구 목록 고정: 브라우저 도구는 설치 프로필로 정합니다", §0-12, §10.1 "도구 목록 고정 규칙" 전체, §6.2 표 `browserPane` 행의 "(설치 프로필 desktop)", §16.2 G-D5의 "프로필 전환" 시나리오와 "tool 정의 해시 불변" 기준(→ 14.1 G-D5 (f)), §20 24·25번.
  - 02 D10의 "설치 단위 설정 하나로만", "세션 단위 permission으로 끄지 않는다", "모든 세션이 한 번 cold", UI 문구 "모든 세션의 다음 요청에서 캐시가 한 번 다시 쓰입니다", AC-P42의 "브라우저 도구 설치 단위 off/on", §12 25번.
  - 03 §18.15의 확인 문구("캐시를 처음부터 다시 씁니다" → "다음 요청에 도구 목록 문구(약 {n} 토큰)가 한 번 더해집니다").
  - 04 §24 37번: 원격 managed config에 `-opencode.browser`를 넣지 않는다(04가 이미 이렇게 적음).
- **설치 프로필(안 B)로 정해지면 바꿀 곳.** 이 문서 0장 9번, 8.7 "규칙", 14.1 G-D5 (f), 16장 "브라우저 도구 목록" 행, 15장 DS2 내용을 설치 프로필로 바꾼다. 03 §18.15·§18.17의 "새 세션은 브라우저 도구 제외", `이 세션에서 켜기`를 뺀다. 02 D10의 "모든 세션이 cold"와 UI 문구는 안 D와 마찬가지로 "교체 문구 1건 덧붙음"으로 고친다(사실 오류라 어느 쪽이든 고친다).

### 17.2 01-architecture.md

| 01 위치 | 지금 | 이 문서의 결정 / 바꿀 내용 |
|---|---|---|
| 머리말 이름 규칙, §20 35번 | 게이트 `G-D1–G-D6`, 성능 `PF1–PF8` | 따른다. 이 문서의 목표는 `DG-*`, 셸 점검은 `SC1–SC5`, 원격 게이트는 `MG1–MG10` |
| §4.1 `main/index.ts` 행 | own-env가 "launcher와 같은 env 정리를 함" | **셸은 env를 정리하지 않는다**(5.2). "스냅샷만 뜨고 launcher에 그대로 넘김"으로 |
| §4.1 `preload/index.ts` 행, §6.2 `serviceControl` 행 | "그대로 사용. 필요해지면 vendor" | **vendor 필수**(4.2: 상대 입력 경로, rpcHash 재검사, 시작 시각) |
| §5.3 b2 | `powershell -NoProfile -File %LOCALAPPDATA%\own-open-code\bin\own.ps1 start` | `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <스냅샷 OWN_HOME>\bin\own.ps1 start`, `shell:false`, windowsHide(own.cmd:4와 같은 플래그, 5.3). 등록 파일 경로도 스냅샷 env로(5.2) |
| §5.3 c | "셸의 rpcHash ≠ manifest rpcHash → 배너(가드 2와 합침)" | rpcHash 불일치는 **폴백 페이지**(시작 때, main) 또는 own-web 불일치 화면(다시 로드 때, T0-0)이다. 배너는 서비스 버전 스큐에만 쓴다. 01 §16.2 G-D6("폴백 페이지와 경고")과도 맞춘다 |
| §5.5 6단계 | 셸 rpcHash가 새 manifest와 다르면 셸 재설치 안내 | 따른다. 셸이 떠 있으면 다시 로드 뒤 T0-0이 불일치 화면을 보인다(5.5) |
| §6.2 capability 표 | `folderPicker`, `nativeFilePaths`, `systemNotifications`, `openExternal`, `openInEditor`/`revealPath`, `clipboardImage`, `browserPane`, `serviceControl`, `windowChrome`, `keepAwake`, `push` | **03 §16.7 이름으로 바꾼다**: `fs.pickDirectory`, `fs.dropPaths`, `notify.native`, (capability 아님: `openExternal`), `fs.openPath`·`fs.revealPath`, `clipboard.image`, `browser.pane`, `service.control`, `window.titlebarOverlay`·`window.zoom`, `power.keepAwake`, (M2 제안) 푸시. §20 33번의 "03은 §6.2 이름을 그대로"는 반대로 "01이 03 §16.7 이름을 쓴다"로 |
| §6.2 `keepAwake` 행 | "화면 절전 방지만" | `prevent-display-sleep`은 시스템도 깨어 있게 한다(⚠ 외부 사실). 모자란 점은 사용자 토글이고 셸이 떠 있을 때만이라는 것(7.6) |
| §6.4 2번 | 게이트웨이는 own-runtime 싱글턴의 loopback 리스너 | 따른다. 더할 것: 켠 동안 런타임 고정(pin), launcher 기동 깨우기, Location 해제(60분)와 무관한 피드 생산자(13.4 ⚠). 관리 RPC는 `own.remote`(04 §16.8) |
| §6.4 3번 | 토큰 수명 30일/14일 ⚠, 02가 정함 | 따른다(13.5). v0.1의 90일/30일은 버렸다 |
| §6.5 | 알림 대상 목록, `NotificationFeed` 어댑터 | 항목 형식과 `kind`는 03 §21.3 `FeedItem`(13.6). 서버 쪽 피드는 own-runtime 피드 생산자 + `own.remote` `feed.*` |
| §6.6 PF5 / 03 §20.1 B7 | 01 gzip 400 KB, 03 350 KB | 01이 수치 기준이다. 03 B7을 01에 맞추거나 01 PF5를 350 KB로 내리거나 둘 중 하나로(이 문서는 PF5를 인용만 함) |
| §6.6 PF6 | 실행 뒤 **90초** 동안 50 ms 넘는 입력 이벤트 0 | 창을 **240초**로 넓히기를 요청한다. 이전 앱 67의 probe가 90–240초에도 p95 228 ms였다(9.2 R-D4, 9.3) |
| §6.6 "이전 앱 교훈" 첫 줄 | "스트리밍 delta마다 renderer→main IPC … 1,001개" | 방향(renderer→main)은 맞다. "텍스트가 아니라 **메타데이터 알림**, 텍스트 스트림은 그대로"를 더한다([old] 65 20–21행, 9.3) |
| §10.1 own-web 쪽 | "own-web은 패인 UI를 새로 만듭니다(참고 pane.tsx)" | 03 §18.17대로 **vendor + 어댑터**(8.8) |
| §10.1 도구 목록, §16.2 G-D5 | 설치 프로필 | 17.1 |
| §13.3 "개발 빌드 CDP" 행 | "패키지 빌드에는 이 포트가 없습니다" | "패키지 빌드는 **스스로** 열지 않는다. 명령줄 `--remote-debugging-port`·`--inspect`는 받는다(fuse 없음, 벤치가 씀)"로. fuse 결정은 19장 |
| §13.3 새 행 | – | **렌더러 CSP**: own-web `index.html` CSP meta(6.4). **렌더러 콘솔**: `spyRendererConsole:true`라 콘솔이 로그 파일로 복사됨, 비밀 출력 금지. **앱 메뉴**: Windows 패키지 빌드 `Menu.setApplicationMenu(null)`(7.7) |
| §13.4 "셸·파일 쓰기로 권한 상승" 행 | "항상 허용 저장은 데스크톱에서만 ⚠(03과 맞출 것)" | 게이트웨이가 권한 응답 본문 `decision:"always"`를 거부해 강제한다(13.4, 13.5). ⚠ 해제 |
| §16.1 G14 | 데스크톱 셸 로그·userData·렌더러 저장소 | net-log를 더한다(MG8) |
| §16.2 G-D3·G-D5·G-D6 | 01의 시나리오 | 14.1이 더하는 시나리오(메뉴 키, 닫기 확인, `claudeConfigDir` 재시작, 다시 로드 뒤 재등록, 다운로드 정리, 포인터 교체 뒤 다시 로드)를 넣거나 "05 §14.1 추가 시나리오 포함"으로 가리킨다 |
| §16.2 G-D4 | should(알림 기능 전 must) | 따른다(v0.1은 must라고 적었다) |
| §17 | P0–P8 | 따른다. DS·M은 하위 이정표(15장). P8 산출물에 "게이트웨이 고정·깨우기, 피드 생산자"를 더하기를 요청한다 |
| §20 20번 | 트레이는 `lifecycle/index.ts` 치환과 Tray 필요 | 치환 없이 된다: `windows-own.ts`의 창 `close` 처리기와 vendor한 `desktop.ts`의 트레이(7.3). 2026-10-18 구현, 기본은 트레이로 숨기기 |
| §20 24번 | "권한 규칙이 도구 정의를 바꾸는지 확인하지 않았습니다 ⚠" | 확인했다: `definitions`는 불변, 카탈로그 Instructions만 바뀐다(8.7) |

### 17.3 02-accounts-providers-cache.md

- **D10(4.3)**: 17.1. 사실 오류("모든 세션이 cold", UI 문구)는 결정과 상관없이 고친다.
- **§8.7, §9.1 "클라이언트와 셸의 경계"**: `[R-desktop] §3`의 서비스 재시작 참조를 **이 문서 5.6**으로 바꾼다. 계약은 `host.server.restart({force:false, claudeConfigDir: configDir})`이고, launcher는 `own restart --claude-config-dir <dir>`로 값을 저장해 브리지 env에 `CLAUDE_CONFIG_DIR`만 예외로 넣는다(5.7). 웹 폴백의 안내 명령도 이 형태다.
- **§9.1 `accounts.update{replaceKey}` ⚠**: 이 문서는 게이트웨이 본문 검사로 정한다(13.4). 키 교체를 별도 메서드로 나누면 본문 검사를 뺄 수 있으므로 02가 원하면 나눈다.
- **§9.1 범위 대응**: 기기 범위 `read`↔`read`, `switch`↔`drive`, `admin`↔`manage`, `local`은 부여 불가(13.5). AC-P43의 "`read`·`drive` 기기 토큰"은 이 대응으로 읽는다.
- **§9.1 `controlDir`(12장 Q41)**: 데스크톱은 `window.own.shell.controlDir` → `server.connect()`의 `controlDir`(5.6). 모바일은 게이트웨이 `GET /own/servers`(13.4). 02가 제안한 `gateway.status`는 `local`이라 기기가 부를 수 없다.
- **§9.1 푸시 후보**: 03 §21.3 `FeedItem`의 `kind`로 옮긴다(13.6). `switch.suggested`와 `billing.alert`는 03에 추가 요청.
- **머리말 플러그인 순서** `own.remote(04, 설치 시)`: 원격 접근이 own-remote에 기대므로 "P6 이후 항상"으로(13.4).
- **§2.3 저장 위치**: `devices.json`, `feed\`, `vault\push-vapid.dpapi`, push 구독 파일, 게이트웨이 설정(켜짐·포트), launcher 설정(`claudeConfigDir`, 제안 `OWN_HOME\launcher.json`)(M1+, 5.7).
- **기기 토큰 정책**: `policy.remoteDevices`(수명 30일, 유휴 14일 초기값)를 02가 정한다(01 §20 32번).
- **전역 poller 수명**: control location이 60분 뒤 해제되면 own-accounts의 전역 poller·경보가 멈출 수 있다(13.4 한계). 게이트웨이 고정과 같은 방식(own-runtime이 쥐는 참조)으로 둘지 02가 정한다.

### 17.4 03-ui-ux.md

- **§16.7 OwnHost(기준 유지)**: 이 문서는 03의 모양을 따른다. 더해 달라는 것:
  - capability `fs.saveFile`(`FilesSaveFile`), `window.multi`
  - `server.connect()` 결과에 `controlDir?: string`, `auth`에 `"device"`(M1 모바일)
  - `server.status()` 결과에 `managed: boolean`
  - `server.restart()` 입력에 `claudeConfigDir?: string`, 결과 `refused`에 `"launcher_failed"`(+ `detail`)
  - "`server.status/restart`는 … 없으면 capability `service.control`을 끈다": preload vendor가 필수라 데스크톱에서는 항상 있다
- **§18.15**: 17.1. 확인 문구는 어느 결정이든 고친다.
- **§18.17**: 이 문서는 03의 vendor 계획을 따른다(8.8). "게이트 D5" → "G-D5". 재등록 규칙(8.2)과 저장하지 않은 다운로드 닫기 안내(8.4) 문구가 필요하다.
- **§18.8 승인 모드**: 안 D로 정해지면 세션 `permissions` PATCH가 `browser` 규칙을 보존해야 한다(8.7 규칙 4).
- **§20.1 B1**: `own:shell-start`는 `window.own.shell.startedAt`으로 넘긴다(T0-6). **B7**: 01 PF5와 수치를 맞춘다(17.2).
- **§20.2 R10**: "own 확장 `window.own.service`만 더한다" → `window.own.shell`(상수와 `own:shell.info`)도. 이 문서에 R-D12(초기 그래프 한두 chunk)를 더했으니 R5와 함께 적는다.
- **§20.4, §16.5 데스크톱 시험**: "셸 쪽 성능 게이트 DP1–DP6은 05 §14.2" → "셸에서 재는 PF와 셸 점검 SC1–SC5는 05 §9.1·§14.2".
- **§21.3 FeedItem**: 서버 쪽 피드의 자리를 정했다: own-runtime 피드 생산자 + `own.remote` `feed.*`(13.6). `kind`에 `switch.suggested`, `billing.alert` 추가 요청.
- **§9·§14 문구**: 창 닫기 확인(7.2), 모바일 권한 dock에서 `항상 허용` 숨김(13.5), 셸·렌더러 불일치 화면을 own-web이 그리는 경우(5.5 T0-0).
- **§4.2.1 WCO, §10 단축키**: 따른다. 앱 메뉴를 비우므로(7.7) 데스크톱 `Ctrl+W`·`Ctrl+N`이 창 동작과 부딪히지 않는다.
- **§8 "셸·렌더러 버전 불일치" 행**: 다시 로드 경로(own-web이 그림)를 더한다.
- 게이트 이름 "게이트 D3/D4/D5"를 "G-D3/G-D4/G-D5"로.

### 17.5 04-ssh-remote.md

- **§16.7 ⚠ 두 개를 확정한다**: `feed.*`·`push.*`는 게이트웨이가 호출 기기의 `deviceId`에 묶는다. 이벤트 거르기(`host.prompt`, `device.pairing.pending`)와 본문 검사(`connect{hostKeyPrompt}`)를 게이트웨이가 한다(13.4).
- **§16.7 마지막 줄의 대응**: `drive` ↔ `prompt`·`switch`가 아니라 **`drive` ↔ `switch`**다. `prompt`는 upstream HTTP 범위다. `manage` ↔ `admin`, `local` ↔ 부여 불가(13.5). §24 38번을 닫는다. 39번(휴대폰의 `manage`로 `connect`·`disconnect`·`drain.*`)은 `admin` 기본 꺼짐으로 받아들인다.
- **§12.3 피드 항목 이름**: `turn.completed`, `permission.asked` → 03 §21.3 어휘(`turn.completed`, `input.required`, `remote.state` 등).
- **§4.1 런타임 수명(RG1 ⚠)**: "참조 카운트 0 + 30초면 닫는다"에 "게이트웨이가 켜져 있으면 own-runtime이 참조 하나를 쥔다(13.4)"를 더한다. RG1에 MG10(긴 유휴)을 함께 본다.
- **§24 37번**: 17.1의 결정을 따른다.
- **§7.6, §24 34번**: "05 D5 확장" → "G-D5 확장".

### 17.6 own/FORK.md

- **§7**: 형식과 `kind`는 그대로 따른다(이 문서 v0.1의 `kind` 제안은 철회). 바꿀 것: own-desktop `vendor`의 "필요하면 `preload/index.ts`" → **필수**. own-web에 `vendor` `renderer/window/zoom.ts`(03 §16.7) 추가. `deep-import` 목록은 4.7 표. surface 제안 표에 4.7의 새 항목(`desktop-preload-input`, `desktop-renderer-chunking`, `desktop-app-menu`, `browser-pane-auth-at-register`, `codemode-catalog-instructions`, `location-eviction`)을 더한다.
- **§8.2**: rpcHash를 **2단계(own-web 빌드) 앞에서** `own/scripts/rpc-hash.mjs`로 계산해 env로 넘긴다. 입력은 `shared/ipc-rpc*.ts`에 `ipc-transport.ts`, `ipc-contract.ts`, `window-bootstrap.ts`, `own-desktop/src/preload/own-api.ts`를 더한 목록(5.5). "셸 빌드가 새긴 rpcHash를 manifest에 기록"은 "0단계 값을 기록"으로. 셸 산출물은 `own/.out/desktop/own-desktop-<ver>-win-x64.exe`(4.5).
- **§8.3**: 키 `desktop.rpc_hash`와 `installer` 이름은 그대로 따른다(이 문서가 FORK에 맞췄다).
- **§11 체크리스트**: Electron 캐시 준비(11.1), 치환 drift 검사, rpcHash 세 곳 일치 확인.

### 17.7 [gap] 목록

- #15: "끄면 prefix를 다시 쓴다" → "그 세션 기록 뒤에 카탈로그 교체 문구 1건이 덧붙고 앞 prefix는 유지된다". 수단은 17.1의 결정.
- #33: must로 올림(DS2 = P5). "launcher나 own-remote 쪽 CDP 호스트"는 폐기, 셸 main의 브라우저 호스트를 쓴다.
- #36: 절전 방지는 7.6(후속), 창 닫아도 알림은 7.3·13.6.
- #43: "모바일·PWA·QR 페어링" 제외를 "나중 범위(M1 = P8, M2·M3 = 후속)"로.

---

## 18. 근거 파일 색인

**upstream (로컬 소스, `D:\own-open-code`)**
- 데스크톱 진입과 layer: `packages/desktop/src/main/{index,desktop,constants,paths,ipc}.ts`, `packages/desktop/package.json`
- 수명주기: `packages/desktop/src/main/lifecycle/{configure,environment,index,shutdown,onboarding}.ts`
- 창: `packages/desktop/src/main/windows/{early,index,protocol,scheme,security,headers,defaults,appearance,registry}.ts`
- 서비스: `packages/desktop/src/main/service/{background-service,desktop-cli,sidecar-credentials,sidecar-probe,pairing}.ts`, `packages/client/src/promise/service.ts:24-128`
- IPC: `packages/desktop/src/preload/index.ts`, `packages/desktop/src/shared/{ipc-rpc,ipc-transport,ipc-contract}.ts`, `packages/desktop/src/shared/ipc-rpc/*.ts`, `packages/desktop/src/main/ipc-handlers/{app,events}.ts`, `packages/desktop/src/renderer/{api,ipc-client}.ts`
- 브라우저 호스트(v2.0.24): `packages/gui-plugins/src/browser/{index,main,ipc,pane,chromium,network,policy,files,restore}.ts`(register·인증 `pane.ts:64-160`, close `:332-380`, 페이지 `chromium.ts:106-120,270-338`, 임시 파일 `files.ts:10,125`), GUI 확장 호스트 `packages/desktop/src/main/extension/{index,host,embeds,manager}.ts`, `ipc-handlers/extensions.ts`, `shared/ipc-rpc/extensions.ts`. 그 전: `packages/desktop/src/main/{browser-pane,browser-chromium}.ts`, `browser/*`, `packages/app/src/runtime/platform/browser-pane.ts`
- 브라우저 시험 하네스(참고): `packages/desktop/test/browser-native.test.ts`, `packages/desktop/test/browser/*`
- 브라우저 플러그인: `packages/plugin-browser/{README.md,src/index.ts,src/tools.ts,src/connection.ts,src/rpc.ts}`, `packages/core/src/plugin/internal.ts:89,216`
- 도구 카탈로그와 권한: `packages/core/src/tool.ts:220-295`(`definitions` `:234-259`), `packages/core/src/codemode/{tool,instructions,catalog}.ts`(`instructions.ts:32-124`, `catalog.ts:50`), `packages/core/src/session/{context,instruction-state,instruction-entry,history}.ts`(`instruction-state.ts:41-60`), `packages/core/src/session.ts:273`, `packages/core/src/config/plugin/source.ts:113-120`, `packages/protocol/src/groups/session.ts:220-230,355-365`, `packages/protocol/src/groups/permission.ts:117-123`, `packages/schema/src/permission.ts:41,55-66`
- Location 수명: `packages/core/src/location-activity.ts:25-81`
- 네이티브 기타: `packages/desktop/src/main/native/{menu,screen-activity,logging}.ts`(`menu.ts:25,38`, `screen-activity.ts:14`, `logging.ts:108`), `packages/desktop/src/main/windows/{appearance,headers}.ts`, `packages/desktop/src/main/ipc-handlers/window.ts:27-32`, `packages/desktop/src/main/files/external-url.ts`, `packages/desktop/src/main/wsl/sidecar.ts:35`, `packages/desktop/src/renderer/window/zoom.ts`
- 패키징: `packages/desktop/electron-builder.config.ts`, `packages/desktop/electron.vite.config.ts`(초기 그래프 `:31-52,137-139`, preload 입력 `:104`), `packages/desktop/scripts/{dev,bench-startup}.ts`(`bench-startup.ts:298-299`), 루트 `package.json:150-155`, electron-vite 6.0.0-beta.1 `node_modules/.bun/electron-vite@6.0.0-beta.1+…/node_modules/electron-vite/dist/chunks/lib-uEZrJ__X.js:56-67`
- 서버 인증·pairing·이벤트: `packages/server/src/{pairing,auth,cors,event-feed}.ts`, `packages/server/src/handlers/{server,event}.ts`, `packages/server/src/middleware/authorization.ts`, `packages/cli/src/services/web-ui.ts:61-70`, `packages/cli/src/services/service-config.ts:100-110`
- upstream 모바일 pairing UI(참고만): `packages/app/src/settings/pairing/pairing.tsx`, `packages/app/src/servers/connect/{pairing,scanner}.ts*`
- 성능 벤치: `packages/app/e2e/performance/README.md`와 하위 디렉터리
- own: `own/launcher/{own.cmd,own.ps1}`(`own.cmd:4`, `own.ps1` `Get-OwnPaths`·`$ProviderKeyPrefixes`·`Set-OwnEnvironment`·`Get-BridgeEnv`·`Confirm-Stop:283-290`·`restart:501-505`), `own/scripts/build-own.ps1`, `own/upstream-surface.json`, `own/ledger/vendored.yaml`, `own/native/own-vault/README.md`(머리말 "하지 않는 일", §2 "수명"), `packages/own-protocol/src/{switch.ts:57-62,rpc.ts:625-629}`

**사전 조사와 PoC (세션 scratchpad)**
- `desktop_verdict.md`(결론, 재사용 표, 계약, 수명주기, 크기, 스펙 변경 목록, 위험), `desktop_build.md`(명령·실측·위험), `gap_final.md`(기능 격차 1–46)
- `own-desktop-poc\electron.vite.config.ts`, `own-desktop-poc\electron-builder.config.ts`, `own-desktop-dist\own-opencode-win-x64.exe`(199.4 MB), `electron-cache\`(Electron zip)

**이전 앱 (`D:\#Projects\codex-multi-provider`)**
- `docs/design/{electron-background-performance-65,profile-launch-latency-66,input-latency-67,input-and-runtime-performance-68,workspace-notifications-40}.md`

**이 PC에서 확인한 것 (2026-09-27)**
- Tailscale, WireGuard 명령과 서비스 없음(`Get-Command tailscale`, `Get-Service Tailscale`, `Get-Command wg` 결과 없음)

---

## 19. 미확인/열린 질문

**검증이 필요한 사실**
1. **NSIS 바로가기의 AUMID.** electron-builder가 시작 메뉴 바로가기에 appId를 AUMID로 넣는지, 그래서 toast가 안정적으로 뜨는지. 앱 종료 뒤 남은 toast를 누르면 무엇이 되는지(프로토콜·COM 활성화기 없음). G-D4.
2. **브라우저 패인 attach와 WCO는 Electron 런타임에서 확인하지 않았다.** PoC가 검증한 것은 빌드, own 서비스 연결, 인증 주입, NSIS 생성뿐이다([verdict] §8-8). G-D4, G-D5, DS1.
3. **카탈로그 교체 문구의 크기와 캐시.** 브라우저 도구를 켰을 때 덧붙는 전체 카탈로그 교체 문구가 몇 토큰인지, 45개 도구로 카탈로그가 부분(partial)으로 바뀌는지, 그 앞까지 `cache.read`가 유지되는지(8.7). G-D5.
4. **upstream 기본 권한에서 `browser` 액션의 기본값**(묻기인지 허용인지). 데스크톱 세션에 아무 규칙도 새기지 않으므로 이 기본값을 그대로 받는다. DS2.
5. **앱 메뉴를 비운 뒤의 편집 키.** Windows에서 `Menu.setApplicationMenu(null)` 뒤에도 composer의 `Ctrl+C/V/X/Z/A`가 Chromium만으로 동작하는지, 그리고 비우기 전 Electron 기본 메뉴의 역할 accelerator가 실제로 동작하는지(둘 다 Electron 문서 기준 외부 사실, 7.7). G-D3.
6. **`OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT=0`이 임의 포트로 동작하는지.** 11.2. DS0.
7. **electron-builder 세부.** `executableName`이 Windows 실행 파일 이름에 반영되는지, prerelease 버전 문자열(`2.0.18-own.N`) 처리, `artifactName`의 `${version}` 치환, 워크스페이스 안에서 `bun.lock` 감지, 제거 때 userData 처리. DS0.
8. **SmartScreen.** 로컬 빌드·로컬 설치에서 경고가 없는지(MOTW 없음). DS0.
9. **렌더러 code cache.** 버전 포인터 교체(예전 junction 교체) 뒤 Chromium이 옛 code cache를 쓰지 않는지. PF1 측정 때.
10. **창 수와 연결 한도.** 창 3개 권장이 맞는지, 4개 이상에서 실제로 요청이 막히는지. PF3·PF4 측정 때.
11. **원격 세션 패인의 트래픽 경로.** 원격 plugin-browser 터널로 원격 호스트에서 나가는지, 토큰 재서명 뒤 재등록이 끊김 없이 되는지. G-D5 확장(P6 이후).
12. **(닫힘) bench-startup 어댑터.** 대신 `packages/own-desktop/scripts/perf-shell.ts`(9.4)가 격리 홈에 등록한 서비스로 PF1·PF3·PF6·PF8을 잰다. launcher 콜드 시작은 `gates.ts`(G-D1).
13. **`@opencode/client`의 경로 접두어 baseUrl**(`/srv/<serverKey>`). MG5.
14. **Tailscale serve의 사용자 식별 헤더**를 게이트웨이 보조 확인으로 쓸 수 있는지, 로컬 스푸핑을 어떻게 볼지. WireGuard 주소가 터널 어댑터인지 확인하는 Windows API. MG1.
15. **iOS PWA Web Push 조건**(홈 화면 추가 필요)과 Android 동작. MG7.
16. **서비스 SSE heartbeat 간격**과 게이트웨이 keep-alive의 관계, 모바일 망에서 긴 유휴 연결 유지. MG6.
17. **닫기 확인의 Electron 동작.** `beforeunload`가 막았을 때 `will-prevent-unload`에서 `dialog.showMessageBoxSync` 뒤 `preventDefault()`로 unload를 진행시키는 흐름, 로그오프(`session-end`) 때 `beforeunload`가 불려 로그오프를 막지 않는지(7.2). G-D3.
18. **Electron 44 안의 Node에서 `.cmd` spawn 제한.** 배치 파일을 `shell:false`로 띄우지 못한다는 Node 보안 수정이 이 판에 있는지. 있든 없든 `powershell.exe`를 직접 부르므로 설계는 같다(5.3). DS0.
19. **`prevent-display-sleep`이 시스템 절전도 막는지**(Electron 문서 기준, 7.6). 그리고 own-runtime에서 Bun FFI로 `SetThreadExecutionState`를 부르고 유지할 수 있는지(7.6 (a)).
20. **로컬 `/api/event`에 location 필터가 없는지.** 피드 생산자가 loopback 구독 하나로 모든 Location의 세션 이벤트를 받는다는 가정(`handlers/event.ts`, `event-feed.ts`, 13.4). MG9.
21. **Location 해제와 런타임 고정.** control location이 60분 뒤 해제될 때(`location-activity.ts`) own-runtime 고정 참조로 게이트웨이·터널이 실제로 사는지, 해제된 Location이 다음 RPC로 다시 뜰 때 중복 런타임이 생기지 않는지(13.4, 04 RG1). MG10.
22. **렌더러 CSP.** CSP host-source가 IP 옥텟 와일드카드를 허용하지 않아 `http://127.0.<k>.2:*` 250개를 나열하는 방식(meta 약 6 KB)이 파서·성능에 문제가 없는지, 웹 폴백에서 서비스 WebUi CSP 헤더와 겹칠 때 교집합으로 동작하는지(6.4).
23. **(닫힘) IndexedDB 첫 읽기 비용.** 진입 모듈에서 먼저 읽기 시작하면(6.3) 목록이 첫 표시 프레임에 함께 들어온다. 보조안은 두지 않는다.
24. **Electron fuse와 명령줄 디버그 인자.** `--remote-debugging-port`를 fuse로 막을 수 없다는 가정, `EnableNodeCliInspectArguments=false`가 `--inspect`를 막는지(11.2, 외부 사실).

**설계 판단이 필요한 것**
25. **브라우저 도구 목록(17.1, P5 전 필수).** 안 D(세션 권한 새김, 이 문서 권고)와 설치 프로필(01·02) 중 하나. 소스 증거는 8.7. 사용자 결정으로 정하고, 정해질 때까지 어느 장치도 구현하지 않는다.
26. **렌더러 위치.** `app\<version>\web`(권고, 서비스와 함께 교체)과 셸 번들(단순, PoC 방식) 중 무엇으로 할지. 이 문서는 전자를 권고했다(5.5).
27. **own-web의 desktop 계약 코드.** deep import(권고, 6.6)와 세 파일 vendor 중 무엇으로 할지.
28. **P-001/P-002 유지.** 브라우저 폴백을 위해 유지한다(지금). M1에서 게이트웨이가 own-web을 서빙하게 되면 로컬 브라우저 폴백도 게이트웨이의 loopback 리스너로 옮기고 P-001/P-002를 빼서 코어 패치를 0으로 만들 수 있다. 그 대가는 로컬 웹 폴백이 기기 페어링을 거쳐야 한다는 것이다.
29. **`app\<version>\web` 무결성 검사.** 첫 창 뒤 manifest 파일 해시와 비교하는 선택 검사를 둘지(5.5). 같은 사용자 경계라 보안 이득은 작고, 손상 감지 이득만 있다.
30. **절전 방지의 자리.** own-runtime의 Bun FFI(권고), own-vault helper 확장(비밀 helper의 범위를 넓히므로 기각 쪽), 셸 main의 `powerSaveBlocker`(셸이 떠 있을 때만) 중 무엇으로 할지(7.6). 후속 범위([gap] #36).
31. **(닫힘, 2026-10-18) 트레이 상주 방식.** 치환 없이 `windows-own.ts`의 `close`에서 마지막 앱 창을 숨긴다. 기본값은 `트레이로 숨기기`(사용자 요청), `설정 > 데스크톱 앱 > 창을 닫으면`에서 `앱 종료`로 바꾼다(7.3).
32. **own-accounts 전역 poller의 수명.** control location이 유휴 60분 뒤 해제되면 한도 poller와 계정 경보가 멈출 수 있다. 게이트웨이처럼 own-runtime이 쥐는 참조로 둘지 02와 정한다(13.4 한계, 17.3).
33. **VS Code Remote로 원격 파일 열기.** upstream `FilesOpenExternal`이 `vscode://`를 막으므로(`external-url.ts:3-8`) own IPC(`window.own.openInEditor`)를 더할지(7.5, [gap] #21). 더하면 `own-api.ts`가 바뀌어 rpcHash가 바뀐다.
34. **릴리스 빌드 fuse.** `EnableNodeCliInspectArguments`, `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`을 끌지. 끄면 벤치는 fuse 없는 `--dir` 빌드로 돈다(11.2, 9.4).
35. **비정상 종료 뒤 남은 브라우저 임시 파일.** 셸이 죽으면 `%TEMP%\opencode-browser-client-*`가 남는다(8.4). 다음 시작 때 첫 창 뒤에 지울지.
36. **launcher 설정 파일의 자리.** `claudeConfigDir`(5.7)과 게이트웨이 설정(13.4)을 둘 파일. 제안은 `OWN_HOME\launcher.json`이고 02 §2.3이 정한다.
37. **`accounts.update{replaceKey}`를 메서드로 나눌지.** 지금은 게이트웨이 본문 검사로 막는다(13.4). 나누면 본문 검사를 하나 줄인다(02와 정함).
38. **raw 재시작 뒤 게이트웨이.** launcher를 거치지 않고 서비스가 다시 뜨면 기동 깨우기가 없어 게이트웨이가 뜨지 않는다(13.7). 받아들일지, 첫 Location이 생길 때 own-remote가 게이트웨이 설정을 읽어 스스로 띄우게 할지(그래도 Location이 생기기 전까지는 없음).

**사용자 결정이 필요한 것**
39. **브라우저 도구 목록**(25번). 안 D(웹·모바일에서 만든 세션은 처음부터 브라우저 도구 없음, 세션마다 켜기) 또는 설치 프로필(웹 전용 설치만 처음부터 끔).
40. **lighthouse 포함 여부.** 브라우저 감사 기능과 설치 크기(asar 78.7 MB의 대부분)의 교환(10.3).
41. **셸 설치·업데이트를 `install.ps1`이 함께 맡을지**(5.7, 10.4).
42. **서명.** 무서명 유지 또는 Azure Trusted Signing 등 유료 서명(10.2).
43. **원격 접근 방식.** Tailscale serve(권고)를 쓸지. 쓰면 Tailscale 설치와 로그인(사용자 동작)이 필요하다. 이 PC에는 아직 없다.
44. **기기 기본 범위.** 휴대폰 기본을 `read + prompt + switch`로 둘지, `read`만으로 둘지. `terminal`과 `admin`을 기기에 허용할지(13.5).
45. **푸시 알림에 세션 제목을 넣을지.** 넣으면 잠금 화면에 보인다(13.6).
46. **모바일 앱 형태.** PWA로 충분한지, Capacitor 앱(스토어 배포 포함)까지 갈지(13.9).

**v0.2 리뷰에서 받아들이지 않았거나 일부만 받아들인 것**
47. **브라우저 도구 정책(리뷰 critical).** 리뷰는 "하나로 정하거나, 안 D를 유지하려면 설치 프로필 전제를 흔드는 소스 증거를 대라"였다. 이 문서는 안 D 권고를 유지하고 증거를 붙였지만(8.7), 01·02를 이 문서가 바꿀 수 없으므로 최종 선택은 25·39번의 결정으로 넘겼다. 결정 전 구현 금지 규칙으로 두 장치를 모두 만드는 일은 막았다.
48. **main 쪽 rpcHash 재검사(리뷰 대안).** 리뷰는 "preload 필수" 또는 "main이 top frame 이동마다 재검사" 중 하나를 제안했다. preload 필수를 택했다. main 재검사는 로그만 남긴다. 프로토콜 핸들러 루트를 등록 뒤 바꿀 수 없고(`protocol.ts:38-51`), 우리 핸들러를 따로 쓰면 자산 서빙 추적이 끊기기 때문이다(5.5).
49. **01 로드맵 순서 변경 요청(리뷰 대안).** 셸을 P3로 당기는 변경은 요청하지 않았다. P3 안에서 개발 셸로 참고 측정만 한다(15장).

---

## 20. 외부 도구 업데이트 (UPD, 2026-11-04)

사용자 요청(2026-11-04): "claude update같은경우도 own code에서 업데이트 가능한 항목이 있다면 추천해서 진행까지 가능하도록 하면 좋을듯." own이 이 PC에서 쓰지만 own 릴리스 밖에 있는(사용자가 설치하고 업데이트하는) 프로그램의 버전을 보이고, 기능이 요구하는 판보다 오래됐으면 추천하고, 공식 업데이트 명령이 있으면 사용자가 누를 때 실행한다. 화면은 `설정 > 업데이트`(고급 묶음, `/settings/updates`, lazy chunk), RPC는 own.accounts `tools.*`(02 §9.1), 계약은 `@own/protocol` `ToolUpdates`, 구현은 `packages/own-accounts/src/tool-updates/`. 결정은 decisions UPD.

### 20.1 대상: own이 런타임에 쓰는 외부 프로그램

| 구성 요소 | own이 찾는 법 | 버전 읽기 | 최신판 출처(공식, 자격 증명 없음) | own의 기준과 이유 | 업데이트 방법 |
|---|---|---|---|---|---|
| Claude Code(Claude Agent 경로, 02 §8.10) | core 공급자처럼 `OPENCODE_CLAUDE_PATH`, 없으면 PATH의 `claude`(`claude-agent/claude/io.ts`), 그것도 없으면 로그인 창이 쓰는 `%USERPROFILE%\.local\bin\claude.exe`(`claude/login.ts`). own은 설치하지 않는다 | `claude --version` → `2.1.282 (Claude Code)` | npm `@anthropic-ai/claude-code`의 `dist-tags.latest`(`registry.npmjs.org/-/package/…/dist-tags`) | **최소 2.1.248**(그보다 오래된 판은 `verbatimPrompts`를 무시해 사용자 글을 Claude 명령으로 읽을 수 있어 core가 막는다, `probe.ts` `MINIMUM_VERSION`). **권장 2.1.257**(문맥 크기 조회, `CONTEXT_DISCOVERY_VERSION`). **권장 2.1.301**(core가 쓰는 `@anthropic-ai/claude-agent-sdk` 0.3.301의 `manifest.json` 판. 그보다 오래된 판은 초기화 답에 `claude_code_version`이 없을 수 있다: 2.1.282가 그렇고, P-051이 없는 판에서는 모든 대화가 실패했다). own이 띄우는 claude는 `DISABLE_AUTOUPDATER=1`이라 스스로 업데이트하지 않는다 | 사용자 폴더 설치: `claude update`(공식, 실행 가능). `.cmd` 설치(npm): 터미널에서 직접. Program Files: 관리자 권한이라 직접 |
| Git(Git for Windows) | PATH의 `git`(own-team, core `git-executable.ts`) | `git --version` | GitHub `git-for-windows/git` releases/latest | **최소 2.40**(팀 모드: `merge-tree --write-tree`, `check-attr --source`, 06 §4.2). **권장 2.42**(코드 전용 작업 폴더: `sparse-checkout check-rules`) | `git update-git-for-windows`. 모든 사용자용 설치는 관리자 권한, 사용자용 설치도 콘솔에서 묻는 업데이터라 **직접 실행**(명령 복사) |
| git-lfs(이 PC) | PATH의 `git-lfs`, 없으면 Git 폴더(`cmd\`, `mingw64\bin\`, 2.56부터 `ucrt64\bin\`). Git 폴더는 `cmd\git.exe`, `bin\git.exe`, `mingw64\bin\git.exe`, `ucrt64\bin\git.exe` 어디서 찾은 git이든 같다(GU-1). 버전은 own-team처럼 `git lfs version` | `git-lfs/3.7.1 (…)` | GitHub `git-lfs/git-lfs` releases/latest | **권장 3.8.1**: SSH 호스트에 올리는 판(`own-remote/script/native.ts` `GIT_LFS`)과 같다. 3.8.1이 고친 CVE 4건 중 둘(서브모듈 URL 줄바꿈, `.lfsconfig`의 사용자 지정 전송 어댑터)은 팀 모드가 다른 사람의 저장소에서 git-lfs를 돌릴 때 닿는다(decisions LFS-1) | Git for Windows에 든 것이면 Git 업데이트를 따라간다(`bundled`). 따로 설치한 것은 공식 릴리스에서 직접 |
| GitHub CLI `gh` | PATH의 `gh`(own-team `integrate/push.ts`의 PR 만들기, 없으면 비교 페이지 URL) | `gh --version` | GitHub `cli/cli` releases/latest | 기준 없음(새 판만 알림) | `winget upgrade --id GitHub.cli -e`. MSI(Program Files)는 관리자 권한이라 직접 |
| ripgrep | PATH의 `rg`(core `ripgrep/binary.ts`와 dsh 검색이 먼저 씀) | `rg --version` | GitHub `BurntSushi/ripgrep` releases/latest | **권장 15.1.0**: PATH에 없을 때 core가 해시로 확인해 받는 판. PATH에 없으면 `own_copy`(own이 받은 사본, own 업데이트를 따라감)로 보이고 확인하지 않는다 | 설치 방법(winget, scoop …)을 모르므로 직접 |
| github-mcp-server | `설정 > GitHub`가 로컬 서버(`server.type: "local"`)일 때만 그 명령 | 마지막 도구 확인의 `serverInfo`(`github-mcp-server 2.0.3`), 없으면 `--version` | GitHub `github/github-mcp-server` releases/latest | 기준 없음. own이 읽기 도구를 하나씩 검토한 판은 2.0.3(`github/reads.ts`)이고, 다른 판은 도구 표시로 읽기·쓰기를 나눈다(화면에 적음) | 업데이터 없음: 공식 릴리스에서 직접 |
| 로컬 모델 서버 | 루프백(`127.0.0.1`, `localhost`, `[::1]`)의 `compat` 계정 | Ollama `GET /api/version`(2초, 헤더 없음). LM Studio·llama.cpp·vLLM은 버전을 내지 않아 `null` | 없음 | 버전만 보인다(범위 밖) | 각 프로그램에서 |
| SSH 호스트(04) | own.remote `hosts.list`의 `versions` | 호스트의 own `remoteRunning`과 이 PC의 `local`, `skew` | 이 PC의 own 릴리스 | 판이 다르면 호스트가 `incompatible`로 멈춘다 | own.remote의 호스트 업데이트(`update.plan`/`execute`, 04 §6.4)만. 그 업데이트가 own이 올린 git-lfs도 릴리스의 판(`HOST_GIT_LFS` 3.8.1)으로 바꾼다(`#refreshTools`). 다른 명령은 실행하지 않는다 |

**넣지 않은 것과 이유.** Codex CLI: own의 codex 방식은 own의 포트라 `codex`를 실행하지 않는다(`own/scripts/codex-sync.ts`의 npm 설치는 개발·골든 캡처용). Bun: 호스트 번들의 `opencode`에 들어 있다. OpenSSH(`System32\OpenSSH`), PowerShell, `tar`, `taskkill`, `netsh`: Windows 구성 요소라 Windows Update가 맡는다. Tailscale: 게이트웨이가 상태만 읽는다(13.4). 편집기, 사용자가 더한 MCP 서버: 사용자의 임의 명령. own-vault·own-cu-helper·Electron·호스트 번들: own 릴리스와 함께 온다.

기준 값은 `ToolUpdates.CLAUDE_CODE`·`HOST_GIT_LFS`·`RIPGREP_PIN`·`GITHUB_MCP_REVIEWED`에 있고, `packages/own-protocol/test/tool-updates.test.ts`가 원래 자리(core `probe.ts`·SDK `manifest.json`·`native.ts`·core `binary.ts`·`reads.ts`)와 같은지 본다.

이 PC에서 2026-11-04에 읽은 값(정보): Claude Code 2.1.282(`%USERPROFILE%\.local\bin\claude.exe`), Git 2.55.0.windows.3(Program Files), git-lfs 3.7.1(Git for Windows에 든 것), gh 2.101.0(Program Files), PATH에 ripgrep 없음(core의 15.1.0 사본), github-mcp-server 없음(호스팅 서버 사용), 로컬 모델 서버 없음.

### 20.2 버전 읽기와 새 버전 확인

- 버전은 `<프로그램> --version`(git-lfs는 `git lfs version`)을 셸 없이(`Bun.spawn`, 창 숨김, 15초) 실행해 읽는다. 환경은 시스템 변수 허용 목록만 넘긴다(`SystemRoot`, `PATH`, `TEMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `ProgramFiles*` …). `ANTHROPIC_*`, `CLAUDE_*`, `OPENCODE_*`, own 변수, 서비스 비밀번호, `USERNAME`·`COMPUTERNAME`은 넘기지 않는다. 읽은 판은 1분 기억하고 `지금 확인`과 업데이트 뒤에 다시 읽는다.
- 최신판은 npm 레지스트리 메타데이터와 GitHub releases API만 읽는다. 자격 증명·쿠키를 보내지 않는다(GitHub은 `Accept`, `X-GitHub-Api-Version`, `User-Agent: own-open-code`만). 찾은 구성 요소만, **하루에 한 번**(`CHECK_EVERY_MS`), `지금 확인`은 5분에 한 번까지(`REFRESH_MS`, GitHub 비인증 한도 시간당 60회를 넘지 않게) 읽는다. 결과는 `OWN_HOME\tool-updates.json`(`checkLatest`, `checkedAt`, `failed`, `latest{구성 요소: {version, at}}`)에 둔다. 읽기에 실패한 것은 마지막 답을 지키고 `failed`에 이름을 남긴다.
- **`새 버전 확인`**(기본 켬)을 끄면 아무 곳도 묻지 않고 최신판을 보이지 않는다. 기능 기준(`필요`, `업데이트 권장`)은 그대로 판정한다.
- 원격 서비스와, 시험 끝점을 받은 서비스(재정의가 하나라도 있는데 `npmRegistry`·`githubApi` 재정의가 없는 경우)는 읽지 않는다(07 §4.5 Codex 판 확인과 같은 규칙).

### 20.3 상태 규칙

`ToolUpdates.status`(순수 함수, 엄격한 기준부터): 프로그램이 없으면 `missing`(`설치 안 됨`), 버전을 못 읽으면 `unknown`(`확인 필요`), `minimum` 미만이면 `required`(`필요`, 기능이 막힘), `recommended` 미만이면 `recommended`(`업데이트 권장`, 걸린 기준 중 가장 엄격한 것의 이유 `why`와 그 판 `threshold`), 최신판보다 오래됐으면 `recommended`(`why: newer`), 아니면 `current`(`최신`). 판 비교는 점으로 나뉜 숫자를 차례로 보고(없는 자리는 0), Git for Windows의 `.windows.N`은 넷째 숫자, `-rc.1` 같은 사전 판은 그 판보다 오래된 것으로 본다. 최신판보다 새 판(사전 채널)은 `current`다.

### 20.4 업데이트: 확인 카드, 실행, 출력

- 단추는 `update.type: "run"`이고 상태가 `recommended`·`required`·`unknown`일 때만 보인다. 지금은 사용자 폴더의 Claude Code(`claude update`)만 그렇다.
- `tools.update.plan{component}`가 카드에 **정확한 명령**(`claude update`), 실행할 argv(실행 파일 경로 포함), **공식 출처**(Claude Code 설치 문서), 지금 판과 최신판을 돌려주고 5분짜리 nonce를 낸다. 계획은 아무것도 실행하지 않는다. `실행`을 눌러야 `tools.update.execute{nonce}`가 그 argv를 셸 없이 실행한다(nonce는 한 번만). 한 번에 하나(`tool_busy`, 실행 중인 작업의 `id`를 함께 준다).
- 출력은 stdout·stderr를 오는 대로 모아(최대 200,000자, 앞부분부터 버림) `tools.update.status{id, from}`로 이어 읽는다(화면은 400 ms마다, 받은 길이부터). 끝나면 그 구성 요소의 버전을 다시 읽어 `after`에 담고 `done`(종료 코드 0)이나 `failed`가 된다. 프로세스가 끝나고 버전을 다시 읽는 동안은 `running`에 `exitCode`가 채워진 상태이고 화면은 `실행이 끝났어요. 버전을 다시 읽는 중…`이다.
- **진행 표시(UCP 2026-11-08).** `claude update`(네이티브 설치)는 내려받는 동안 `Updating to 2.1.319...` 뒤로 아무것도 출력하지 않는다(2.1.282 → 2.1.319, 약 345 MB, 3분). 그래서 작업은 시작부터 걸린 시간 `elapsed`(서비스 시계, 끝나면 끝난 때까지)를 늘 싣고, Claude Code 작업이면 네이티브 설치의 판 폴더(업데이트 환경의 `USERPROFILE`, 없으면 `HOME` 아래 `.local\share\claude\versions`)를 1초마다 읽기만 해서 `download{version, bytes}`를 싣는다: 시작할 때 없던 `<판>.tmp.<pid>.<ms>.<n>` 파일 가운데 가장 큰 것의 이름 앞부분과 크기, 그 파일이 `<판>`으로 바뀐 뒤에는 완성된 파일의 크기. 앞서 실패한 실행이 남긴 임시 파일은 세지 않는다. 전체 크기는 믿을 출처가 없어 짐작하지 않는다. 화면은 `내려받는 중 · 128 MB · 1분 12초`(판 폴더가 없는 npm 설치는 `실행 중 · 45초`)와 `큰 업데이트는 몇 분 걸릴 수 있어요. 이 창을 닫아도 업데이트는 계속돼요. …`를 보이고, 끝나면 결과 아래에 `걸린 시간 3분 2초 · 내려받은 크기 345 MB`를 둔다.
- **창을 닫을 때.** 업데이트는 창이 아니라 서비스의 것이다. 카드를 닫아도 멈추지 않고 고아가 되지도 않는다(서비스가 끝까지 보고 버전을 다시 읽는다). 다시 열면 `tools.update.plan`이 `tool_busy{id}`로 답하고, 카드는 같은 구성 요소의 작업이면 `tools.update.status{id, from: 0}`로 처음부터 이어 보인다(`이미 실행 중인 업데이트예요. 이어서 보여 드려요: claude update`). 설정 목록의 그 줄 단추는 `진행 보기`가 된다. 대화의 한 줄에서 연 카드도 같다. 카드에서 멈추는 단추는 두지 않는다(반쯤 바꾼 설치를 남길 수 있는 중단을 화면에서 권하지 않는다).
- **오래 걸릴 때.** 10분(`ToolUpdates.SLOW_MS`)이 넘으면 카드가 `10분이 넘었어요. 내려받은 크기가 계속 늘고 있으면 조금 더 기다려 주세요. …`(크기를 모르면 네트워크 확인)를 보인다. 1시간(`ToolUpdates.TIMEOUT_MS`)이 넘으면 서비스가 멈추고 `timedOut`을 남겨 `failed`로 끝내며 카드는 `60분이 지나도 끝나지 않아 own이 멈췄어요. …`를 보인다. 조용히 멈추는 일은 없다. 이전의 10분 상한은 느린 회선(0.5 MB/s면 345 MB에 약 12분)의 정상 업데이트를 끊을 수 있어 없앴다.
- **SSH 호스트.** 이 카드는 이 PC의 프로그램만 다룬다(20.6: `tools.*`는 `local`). 호스트의 Claude Code는 이 화면에 없고 원격 서비스는 `remote_managed`로 답한다.
- **관리자 권한, 스마트 앱 컨트롤, UAC.** own은 관리자 권한이 필요한 설치 파일을 실행하지 않는다: Program Files·Windows 폴더의 프로그램은 `manual{why: "elevation"}`이고 화면은 그 사실과 직접 실행할 명령(복사)·공식 페이지를 보인다. 콘솔에서 묻는 업데이터(`interactive`), Git에 든 것(`bundled`), 업데이터가 없는 것(`no_updater`), `.cmd` 설치(`script`)도 같다. Windows가 프로그램 시작을 막으면(스마트 앱 컨트롤, 백신: `Bun.spawn`이 실패) 작업은 `blocked`로 끝나고 화면은 `Windows가 실행을 막았어요`와 공식 안내를 보인다. 다시 시도하거나 우회하지 않는다. 시스템·보안 설정은 바꾸지 않는다.
- 사용자가 누르지 않으면 아무것도 실행하지 않는다. 버전 읽기(`--version`)는 화면을 열 때 한다.

### 20.5 알림이 필요한 곳

- **Claude Agent 대화**: 입력창 위에 한 줄(`Claude Code 2.1.282: …`)이 뜬다. 조건은 대화의 모델이 `claude-agent` 공급자이고, 이 PC의 대화이며, Claude Code의 `why`가 경로 기준(`claude_verbatim`, `claude_context`, `claude_sdk`)일 때다. 새 판만 나온 것(`newer`)은 띄우지 않는다. `업데이트`는 같은 확인 카드를 열고, `닫기`는 그 창이 살아 있는 동안 숨긴다. 별도 lazy chunk이고 버전은 창마다 한 번 읽는다.
- 설정 목록의 `업데이트` 항목과 팔레트(`업데이트`, `버전`, `claude code` …)에서 찾을 수 있다. 설명서는 2.9.

### 20.6 범위와 위치, 기기

`tools.*` 다섯은 모두 `local`이고 위치 `control`이다(02 §9.1). 보기에도 이 PC의 프로그램 경로가 들어 있고, 업데이트는 이 PC에서 프로그램을 실행한다. 그래서 휴대폰·다른 PC 창(`auth: "device"`)에서는 설정 목록에 항목이 없다. 원격 서비스(04 §16.5)는 `remote_managed`로 답한다(SSH 호스트의 것은 20.1 마지막 줄).

### 20.7 시험

- `packages/own-protocol/test/tool-updates.test.ts`: 각 프로그램의 `--version` 줄과 릴리스 태그 파싱, 비교(Git for Windows 넷째 숫자, 사전 판), 상태 규칙, 기준 값이 원래 자리와 같은지, 범위·위치.
- `packages/own-accounts/test/tool-updates/tool-updates.test.ts`: 가짜 시스템(PATH, 파일, `--version` 답, 가짜 목록 끝점, 가짜 업데이터)으로 이 PC 모양(2.1.282 등)의 상태와 방법, 하루 한 번·5분·끔, 재정의만 있는 시험 끝점은 아무 데도 묻지 않음, 환경 허용 목록, 계획 → 실행 → 출력 이어 읽기 → 버전 다시 읽기, 실패·`blocked`, 수동 구성 요소에는 계획이 없음, 로컬 모델 서버, 걸린 시간과 내려받은 크기(남은 임시 파일은 세지 않음, 완성 파일 크기, 다시 연 카드가 같은 작업을 이어 봄), 판 폴더 없는 설치는 시간만, 1시간 전에는 멈추지 않고 1시간에 `timedOut`. 실제 업데이트나 설치 파일은 실행하지 않는다(실제 자식 프로세스는 출력만 하는 Bun 한 줄, 그리고 임시 홈에서 네이티브 업데이터처럼 커지는 임시 파일을 쓰고 이름을 바꾸는 `fake-claude.ts`).
- `packages/own-web/e2e/tool-updates.spec.ts`(Playwright, `tools.*`와 own.remote `hosts.list`·`update.plan`을 페이지에서 모의): 목록과 이유, 카드의 명령·출처, `실행` 전에는 실행 없음, 출력 이어 받기와 뒤 버전, `blocked`, 수동 단계, `새 버전 확인` 끔·`지금 확인`, SSH 호스트의 호스트 업데이트 카드(실행하지 않음), Claude Agent 대화의 한 줄, 실행 중 카드(`내려받는 중 · 128 MB · 1분 12초`, 닫고 `진행 보기`로 이어 보기, 10분 안내, 1시간 멈춤, 크기 없는 npm 설치와 실패의 종료 코드).
