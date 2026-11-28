# 04. SSH 원격 프로젝트 설계

| 항목 | 값 |
|---|---|
| 문서 | `own/docs/04-ssh-remote.md` |
| 상태 | 초안 v0.3 (2026-09-27, 2차 리뷰 반영: 데스크톱 셸·모바일 정렬(결정 D1·D3·D8), linked Codex 계정의 lease(결정 D7), 원격 자동 압축·사용량(결정 D6, 02 v0.3), 01 단계 P0–P8). **06 T3(2026-10-04)**: 원격 팀(own-team 3번 자리, 4.1), 정적 git-lfs 동봉과 `hosts.tools.ensure`(5.2, 5.3, 16.2), 미러의 프리셋(9.2), 호스트마다 좁은 팀 구독과 `/srv/<hostId>`의 `own.team`(12.3, 12.7). 22장 끝 "T3 반영 현황". **IMPORT(2026-10-09, 09)**: own-import는 이 PC에만 싣고 원격 번들·managed config에는 넣지 않으며(4.1, 5.2, 5.6), `/srv/<hostId>`의 `own.import`는 거절한다(12.7). **원격 Claude(2026-10-09)**: Claude 구독 슬롯을 PC egress 중계로 원격에서 쓴다(8.11, 사용자 결정 8.11.16). 원격 순서에 own-telemetry 4번(4.1, 5.2). **여러 Claude 계정(2026-10-10)**: egress proof v2(MAC이 계정을 덮음, 8.11.0 3번), 미러의 `claude.accounts`, 계정마다 서명·귀속(8.11.18, 02 §8.7). **2026-10-11(리뷰 반영)**: 호스트가 새 트리를 첫 요청에 묶고 미러에 없는 계정은 거절, 미러의 `usable`, PC 중계는 `patched`일 때만 여러 계정(8.11.18). **2026-10-28(RH)**: control location은 프로세스가 사는 동안 내려가지 않는다(코어 패치 P-037, 4.1, 24장 6번). **2026-11-02(GH-37)**: 호스트의 GitHub 도구와 git을 PC가 중계(브로커의 `github.*`, egress 리스너의 `/github/…` 경로, 8.4·8.12, 16 §8) |
| 기준 소스 | fork base upstream v2 `00d179015f` (루트 `package.json` 2.0.18) |
| 경로 표기 | 특별한 말이 없으면 저장소 루트 `D:\own-open-code` 기준 `path:줄`. `[old]`는 이전 앱 `D:\#Projects\codex-multi-provider` 기준 |
| 관련 문서 | `01-architecture.md`(프로세스·보안·원장·단계), `02-accounts-providers-cache.md`(계정·캐시·한도·압축·RPC 계약의 **기준**), `03-ui-ux.md`(화면·문구), `05-desktop-and-mobile.md`(데스크톱 셸 own-desktop, 브라우저 패인, 게이트웨이·기기·피드의 **기준**), `own/FORK.md`(포크 운영) |
| 표기 | **⚠** = 소스나 실측으로 확인하지 못한 가정. 뒤에 확인할 게이트(RG*, 20장)를 적는다 |

**문서 간 우선순위.** 스키마·저장 파일·정책 수치·`own.accounts` RPC 계약은 02, 화면은 03, 프로세스·보안·포크 경계와 단계(P0–P8)는 01, 데스크톱 셸과 원격 기기 접근(게이트웨이·기기·피드)은 05가 기준이다. 이 문서는 SSH 원격의 전송, 원격 설치와 수명주기, 자격 증명 브로커, 집계 규칙, 그리고 `own.remote` RPC의 **유일한 메서드·이벤트·오류·범위 목록**(16장, 05의 M1+ 추가분 포함)을 정한다. 01·02·03·05와 어긋나거나 그 문서에 추가가 필요한 곳은 22장에 모았다. 지금의 01은 이 문서의 이전 22장 목록을 대부분 반영했다(22장 첫머리).

---

## 0. 결정 요약

**질문: "Codex 앱이나 Claude 앱처럼 SSH로 원격 프로젝트를 여는 것이 이미 되는가?"**
**답: 지금 코드로는 되지 않는다. 이 문서가 그것을 완성 범위로 설계한다(이음매는 01 §17의 P2·P3, 본체 R0–R3은 P6, 21장).**
- upstream v2의 SSH 원격은 Electron 데스크톱 앱에만 있다. SSH UI의 모든 진입점이 `platform.sshServers`를 확인하는데, 이 값을 주는 것은 upstream Electron renderer(`@opencode/app`)뿐이다(`packages/app/src/runtime/platform/platform.tsx:96-97`, `packages/desktop/src/renderer/platform/index.ts:81`, `packages/app/src/shell/commands/desktop.tsx:25-31`).
- 우리 주 클라이언트도 이제 Electron 데스크톱 앱 `packages/own-desktop`이다. 하지만 upstream main만 재사용하고 렌더러는 own-web이다(01 §4.1, 05 §0). own-web은 `@opencode/app`에 의존하지 않으므로(03 §16.1) upstream SSH UI가 딸려 오지 않고, main의 upstream `ssh/*` 레이어는 import되지만 부르는 쪽이 없어 비활성이다(05 §4.2, §12). 이 문서 이전의 01은 SSH를 후속(구 Phase 3) 예약으로만 두었다. 지금은 SSH가 완성 범위이고 01 §11은 이 문서를 가리킨다.
- upstream 방식은 provider 자격 증명을 **원격 서버마다 따로** 저장한다("Your OpenCode credentials will be stored on this server", `packages/app/src/providers/connect/remote.tsx:5-30`, `packages/app/src/runtime/i18n/en.ts:232-233`). "로컬 계정을 그대로 쓴다"는 요구와 맞지 않는다.
- 그래서 이 문서가 새 설계를 정한다. upstream의 SSH 부트스트랩·터널·askpass 코드는 대부분 재사용한다(4장).

**핵심 결정**
1. **원격 호스트마다(호스트, OS 사용자) own 채널 service 하나를 띄운다.** 계정마다 띄우지 않는다. 에이전트, 셸·파일 도구, PTY는 원격 호스트에서 돈다. 원격 세션의 원본은 원격 DB `opencode-own.db`다.
2. **SSH는 로컬 own service 안의 새 플러그인 `own-remote`(`@own/remote`, 플러그인 id `own.remote`)가 돌린다.** own-web(데스크톱 렌더러든 웹 폴백 탭이든)은 `ssh`를 띄우지 않고, launcher는 상주하지 않는다. **own-desktop의 Electron main에서도 돌리지 않는다**(터널이 창·셸 수명에 묶이고 브로커가 서비스 안에 있어야 하는 등, 4.1). 로컬 service는 detached라 창·탭을 닫거나 셸을 끝내도 터널이 산다(4장).
3. **upstream 데스크톱 SSH 코드는 vendor(복사)한다.** `@opencode/desktop`은 exports 맵이 없어 소스 경로 deep import는 된다(own-desktop이 그렇게 쓴다, 01 §4.1, 05 §4.2). 하지만 안정된 API가 아니고, SSH 코드는 Electron main이 아니라 로컬 서비스(Bun) 번들 안에서 돌아야 하므로 import하지 않고 순수 모듈(`ssh/command.ts`, `ssh/askpass.ts`, `ssh/controller.ts`, `remote/cli.ts`의 일부)을 `packages/own-remote/src/vendor/`로 복사해 `own/ledger/vendored.yaml`에 기록한다. target 파서는 로컬 명령 실행과 UNC 경로를 막도록 좁힌다(7.2). askpass helper는 우리 `opencode.exe`에 이미 들어 있는 CLI askpass 모드를 그대로 쓴다. **코어 패치는 필요 없다**(4.3).
4. **원격 설치는 업로드만 한다.** own 채널 Linux 바이너리(x64-baseline, arm64)와 우리 플러그인 번들을 로컬 `app\<ver>\remote\*.tar.gz`에서 SSH stdin으로 보낸다. npm이나 upstream URL에서 받지 않는다. 설치 위치는 `${XDG_DATA_HOME:-~/.local/share}/own-open-code/app/<version>/`이고 root가 필요 없다(5장).
5. **own-web의 라이브 연결은 버전이 정확히 같아야 한다.** 원격 실행 버전이 로컬과 다르면 `incompatible`로 두고, 업데이트는 **실행 중인 세션을 drain한 뒤에만** 한다. upstream `service start`는 버전이 다른 서비스를 그냥 교체한다(`packages/client/src/effect/service.ts:50-53,106-113`). 그래서 우리 ensure는 버전을 먼저 확인하고 다를 때는 `service start`를 부르지 않는다. 브로커는 빌드가 아니라 브로커 프로토콜 버전 `proto`로 호환을 판단한다. 그래서 로컬을 먼저 업데이트해도 원격에서 도는 턴은 drain이 끝날 때까지 계속 인증을 받는다(5.7, 6.4).
6. **터널은 호스트당 장수 `ssh.exe` 하나이고, 재연결은 인증 1회다.** `-L`은 원격 API용, `-R`은 로컬 자격 증명 브로커용이다. ensure는 이 터널 세션 안에서 돈다. Windows OpenSSH에는 ControlMaster가 없으므로 첫 연결의 inspect와 설치만 따로 인증한다(7장).
7. **원격이 내놓는 끝점은 `127.0.0.1`에 두지 않는다.** 원격 API 터널과 dev 서버 forward는 호스트마다 다른 loopback 주소(`127.0.<k>.2`, `127.0.<k>.3`)에 묶는다. 이 규칙은 클라이언트 모드와 관계없이 지킨다(7.3, 12.1, 15장).
   - 웹 폴백: 브라우저 쿠키는 포트를 가리지 않으므로, `127.0.0.1`에 두면 own-web의 로컬 pairing 쿠키가 원격이 제어하는 서버로 간다.
   - 데스크톱: 렌더러 origin은 `oc://renderer`이고 쿠키가 없다. main이 로컬 서비스 origin에만 Basic을 넣는다(05 §6.4). 그래도 로컬 서버 CORS가 `http://127.0.0.1:*` origin을 모두 허용하고(`packages/server/src/cors.ts:14`), 같은 PC에서 웹 폴백을 함께 쓸 수 있으므로 분리를 유지한다.
8. **자격 증명은 로컬 브로커가 요청마다 lease로 준다(8장).**
   - 원격 own-accounts는 `mode:"remote"`로 돌며, `model.request` 훅에서 인증 헤더를 로컬 브로커에서 받아 넣는다.
   - refresh token, id token, vault 파일은 원격에 가지 않는다. refresh single-flight는 로컬에만 있다.
   - API 키와 access token은 원격 **메모리에만**, lease 기간(기본 15분) 동안 둔다. 디스크, env, argv, 로그에는 두지 않는다. 브로커 키도 원격 디스크에 두지 않는다(8.3).
   - 브로커에 닿지 못하고 lease도 끝나면 **fail closed**다. 요청을 원격 loopback의 sink로 돌려 401로 끝내므로 요청 본문이 provider로 나가지 않는다. 짧은 끊김에는 제한된 유예 재시도를 준다(8.7).
   - **refresh는 자격 증명 출처별 규칙을 따른다**(02 §3.1 C3). vault·takeover 계정은 로컬 single-flight refresh 뒤 lease를 준다. **linked로 가져온 Codex 계정**(이전 앱이 유일한 refresher, 02 §3.2a)은 로컬에서도 token endpoint를 부르지 않으므로, 브로커는 원본 파일을 다시 읽기만 하고 남은 수명이 모자라거나 원격이 거절을 알린 토큰이 그대로면 lease를 `source_stale`로 거절한다(8.5, 8.8).
   - 이 결정은 이전 01 §11("로컬의 비밀을 원격으로 보내지 않는다")을 바꾼다. 이전 앱의 SSH 인증 프록시가 같은 방식(현재 access token과 account id만, refresh token은 보내지 않음)으로 이미 동작했다(8.1). 계정별·호스트별로 원격 사용을 끌 수 있다. Claude 구독 슬롯은 비밀이 Windows를 떠나지 않는 "로컬 egress 게이트웨이" 방식(8.1 안 C)으로 원격에서 쓴다(8.11). 다른 계정의 egress 방식은 R4 선택지로 남긴다.
   - **원격 프로젝트 설정은 기본으로 끈다**(`OPENCODE_CONFIG_PROJECT_DISABLE=1`). 원격 저장소의 `.opencode/plugins`가 원격 service 안에서 lease를 읽지 못하게 하기 위해서다. 호스트마다 켤 수 있다(5.6, 13장).
9. **계정 레지스트리는 원격에 비밀 없는 미러로만 둔다.** slot, 고정 모델 템플릿, policy, ratecards, 자동 압축 설정(계정·kind)이 같으므로 providerID(= 캐시 도메인), identity 정규화(D9), 헤더, 실효 문맥 한도 `ctx_eff`(02 §4.7)가 로컬과 같다. 에이전트가 어디서 도느냐는 캐시 도메인과 압축 기준을 바꾸지 않는다(9.2, 11장).
10. **ledger와 한도의 writer는 로컬 하나다.** 원격은 관측(LedgerLine, LimitWindow 관측, 경보, 인증 실패)을 bounded spool에 쌓았다가 브로커로 보낸다. core가 이벤트로 내지 않는 generate 사용량도 로컬과 같은 방법(응답 SSE 사본)으로 읽어 보낸다(02 §7.5). 로컬은 `eventId`와 호스트별 순번으로 중복을 거른다(10장).
11. **전환은 같은 상태 머신(02 §5)이 원격 세션이 있는 서버에서 돈다.** own-web은 원격 세션의 `switch.*`·`cache.state`·`session.binding`을 그 원격 서버의 `own.accounts` RPC로 부르고, 계정·한도 조회는 로컬 control location으로 부른다(12.6).
12. **own-web은 멀티 서버 레지스트리를 둔다.** 사이드바는 "이 PC"와 호스트별 그룹 → 프로젝트 → 세션이다. 원격 서버 인증은 로컬 own-remote가 원격 서비스 비밀번호로 직접 서명한 짧은 수명(기본 12시간) 세션 토큰이며, 렌더러가 헤더를 직접 붙인다. 원격 서비스 비밀번호는 렌더러에도 셸 main에도 주지 않는다(12장). 끊겼을 때 쓰는 목록(catalog)은 **own-remote leader가 연결된 호스트의 이벤트 스트림을 구독해** 유지하므로 창이 닫혀 있어도 갱신된다(12.3).
13. **RPC는 새 id `own.remote`를 둔다.** 호스트 관리·터널·설치·동기화는 계정 라우팅과 수명주기, 실패 범위가 달라 `own.accounts`에 넣지 않는다. `own.accounts`에는 원격 모드 필드와 오류 몇 개만 더한다. 05의 M1+ 게이트웨이·기기·피드 메서드도 `own.remote`에 들어가고, 모든 메서드에 원격 기기 범위를 붙인다(16장).
14. **로컬 종료 ≠ 원격 중지.** 원격 service는 detached라 계속 산다. 원격 중지는 "현재 턴이 끝나면 중지"(drain)로만 한다. 로컬이 꺼져 있으면 원격 에이전트는 lease가 끝날 때까지만 모델을 부를 수 있다(6.5).
15. **이전 앱의 SSH 호스트는 alias만 가져온다.** PID, 소켓, 락, revision, 원격 런타임은 가져오지 않고 건드리지도 않는다(19장).
16. **데스크톱 셸과 모바일에서의 자리.** Electron main은 SSH 일을 하지 않는다. main이 원격 서버에 붙는 경우는 원격 세션의 브라우저 패인 하나이고, 그 패인의 트래픽은 원격 plugin-browser 터널로 원격 호스트에서 나간다(7.6, 05 §8.6). 휴대폰(M1+)은 SSH 호스트에 직접 닿지 않고 PC 게이트웨이의 `/srv/<hostId>` 중계로 원격 세션을 보고 조작한다. SSH 키, 원격 서비스 비밀번호, 원격 세션 토큰은 기기에 가지 않는다(12.7, 05 §13.4).

---

## 1. 목표와 비목표

### 1.1 목표
- **G-R1** own-web에서 SSH 호스트를 추가하고 원격 폴더를 열어 세션을 만든다. 에이전트와 셸·파일 도구, PTY는 원격 호스트에서 돈다.
- **G-R2** 원격 세션도 같은 사이드바에 보인다(호스트 → 프로젝트 → 세션). 연결이 끊겨도 마지막 목록은 보인다.
- **G-R3** 원격 세션도 **로컬 계정**을 그대로 쓴다. 계정·provider 전환, 캐시 최적화 규칙(01 §8.7), 한도 표시, 전환 비용 추정이 로컬 세션과 같게 동작한다.
- **G-R4** 비밀의 원본과 refresh는 로컬에만 있다. 원본은 DPAPI vault이고, linked로 가져온 Codex 계정은 이전 앱의 로컬 `auth.json`(읽기만)이다. refresh는 vault·takeover 계정은 로컬 own-runtime, linked 계정은 이전 앱만 한다(02 §3.1 C3). 원격에는 짧은 lease만 가고, 연결이 없으면 fail closed다. Claude 구독 슬롯의 refresh는 이 PC의 claude-auth만 하고, 원격에는 lease도 가지 않는다(8.11).
- **G-R5** 끊김, 재연결, 버전 차이, 원격 업데이트, 로컬 종료를 이전 앱의 실패 사례(18장)를 반복하지 않게 다룬다.
- **G-R6** 한 호스트의 실패가 다른 호스트와 로컬 세션을 막지 않는다(local-first).
- **G-R7** Windows 11의 inbox OpenSSH(`ssh.exe`)만으로 동작한다. 추가 설치 없이, 원격에는 root 없이.
- **G-R8** 클라이언트 모드와 무관하다. 데스크톱 앱, 웹 폴백, 나중의 휴대폰(05 M1+)이 같은 서비스·RPC로 원격 세션을 다루고, 모드마다 다른 것은 인증을 붙이는 자리뿐이다(12.1, 12.7). 셸이나 창이 닫혀 있어도 터널, 브로커, catalog, 관측 집계는 서비스에서 계속 돈다(백엔드 우선, 01 §3.2).
- **G-R9** 원격 세션도 Claude 구독 슬롯을 쓴다. 요청은 이 PC의 egress 중계로 나가고, 토큰과 서드파티 코드는 이 PC를 떠나지 않는다(8.11).

### 1.2 비목표
- Windows·macOS 원격 호스트. upstream probe도 Linux·macOS만 받고 Windows는 exit 2다(`packages/desktop/src/main/remote/cli.ts:55-66`). 사용자의 현재 호스트는 모두 Linux로 보인다. 이전 앱이 lab, work_linux, build-host에 Linux 번들을 설치해 썼다(19장).
- 세션을 서버 사이에 옮기기(로컬 ↔ 원격, 호스트 ↔ 호스트).
- 원격 호스트에 root 권한 설치, systemd 시스템 서비스, sshd 설정 변경.
- 여러 로컬 PC가 한 원격 설치를 함께 관리하기(6.8).
- LAN이나 공인 네트워크에 원격 service 노출. 원격 service는 원격의 `127.0.0.1`에만 묶는다(01 §13).

---

## 2. 용어

| 용어 | 정의 |
|---|---|
| **호스트(host)** | 사용자가 추가한 SSH 대상 하나. 레코드 id `hostId`는 `h-<6–8자 [a-z0-9] 난수>`이고 바뀌지 않는다. alias를 id로 쓰지 않는 이유는 alias가 다른 기계를 가리키도록 바뀔 수 있기 때문이다([old] dev-host 퇴역, 19장) |
| **serverKey** | own-web 라우트와 ledger에서 서버를 가리키는 키. 로컬은 `local`, 원격은 `hostId`(03 §3의 `/srv/:serverKey/…`) |
| **alias / target** | alias는 `~/.ssh/config`의 `Host` 이름. target은 alias 대신 직접 적은 `user@host -p 22` 형태 문자열(upstream `parseTarget` 규칙, 7.2) |
| **host identity** | `sha256(/etc/machine-id ‖ \0 ‖ uid ‖ \0 ‖ $HOME)`. 같은 alias가 다른 기계를 가리키는지 판별한다([old] `scripts/manager_core/remote.py:57`) |
| **원격 service** | 원격 호스트에서 도는 fork 빌드(`OPENCODE_CHANNEL=own`) `opencode serve --service`. 원격 `127.0.0.1`에만 바인딩 |
| **터널** | 호스트당 장수 `ssh.exe` 프로세스 하나. `-L`(API, 호스트 loopback 주소)과 `-R`(브로커)을 함께 들고, 원격 쪽에서는 ensure를 실행한 뒤 keep으로 세션을 붙든다(7.1) |
| **브로커(broker)** | 로컬 own service 안에서 도는 좁은 인증 헤더 발급 엔드포인트. 원격 own-accounts만 쓴다(8장) |
| **lease** | 브로커가 준 인증 헤더와 상대 수명 `ttlMs`. 원격은 받은 시각에 자기 시계로 만료 시각을 계산한다(8.5). 원격 메모리에만 있다 |
| **epoch** | 터널이 새로 설 때마다 커지는 호스트별 번호. `max(직전 epoch + 1, 현재 Unix 초)`로 정하므로 로컬 OWN_HOME을 새로 만들어도 줄어들지 않는다. 브로커 키와 `-R` 소켓 경로가 epoch마다 바뀐다. 원격 `run/broker.current`에는 현재 epoch 번호만 적는다(비밀 아님) |
| **호스트 loopback 주소** | 호스트를 추가할 때 고정하는 번호 `k`(1–250)로 만드는 로컬 주소. 원격 API 터널은 `127.0.<k>.2`, dev 서버 forward는 `127.0.<k>.3`. `127.0.0.1`과 쿠키·origin을 나누기 위해서다(7.3) |
| **arm** | own-remote가 터널을 세운 뒤 원격 runtime에 브로커 끝점과 키를 넘기는 동작(`agent.broker.arm`, 8.3) |
| **미러(mirror)** | 원격 OWN_HOME의 `accounts.json`·`policy.json`·`ratecards.json` 사본. 비밀과 식별자(이메일, account id, 지문)를 뺀 "레지스트리 뷰"다(9.2) |
| **spool** | 원격이 로컬로 보낼 관측을 잠시 쌓는 bounded 파일(10.2) |
| **catalog** | 로컬이 보관하는 호스트별 프로젝트·세션 목록 스냅샷. 끊겼을 때 사이드바에 쓴다(12.3) |
| **drain** | 실행 중인 턴이 끝나기를 기다렸다가 원격 service를 멈추는 동작(6.4, 6.5) |
| **remote mode / agent mode** | 원격에서 도는 own-accounts(`mode:"remote"`)와 own-remote(`mode:"agent"`)의 동작 모드. 로컬은 각각 `mode:"local"` |
| **렌더러 / 웹 폴백** | 렌더러는 own-desktop 창 안의 own-web(origin `oc://renderer`, 05 §2). 웹 폴백은 `msedge --app`으로 연 own-web(origin `http://127.0.0.1:P`, pairing 쿠키, 01 §6.1). 이 문서에서 "own-web"은 둘 다를 뜻한다 |
| **main** | own-desktop의 Electron 메인 프로세스(upstream `packages/desktop/src/main` 재사용). SSH 일을 하지 않는다(4.1) |
| **linked / takeover** | 이전 앱(codex-multi-provider)의 Codex 로그인을 가져온 두 방식(02 §3.2a). linked는 원본 `auth.json`을 읽기만 하고 이전 앱이 유일한 refresher, takeover는 vault로 복사한 뒤 우리가 유일한 refresher |
| **게이트웨이 / 기기** | (M1+, 05 §13.4–13.5) 로컬 서비스 안의 loopback 리스너와, 거기에 페어링한 원격 클라이언트(휴대폰 등). 기기는 `/srv/<serverKey>` 경로로 로컬·원격 서버에 닿는다 |

---

## 3. 구성도

```text
Windows 11 (로컬, 사용자 세션)                                         Linux 호스트 (예: lab, 원격 OS 사용자 권한만)
┌───────────────────────────────────────────────────────────┐       ┌─────────────────────────────────────────────────┐
│ own-desktop 렌더러 = own-web (origin oc://renderer)        │       │ opencode (own 채널, linux-x64-baseline)          │
│   [폴백: msedge --app, origin http://127.0.0.1:P]          │       │   serve --service, 127.0.0.1:RP                 │
│   서버 "local"  : 데스크톱 = main이 Basic 주입, 쿠키 없음  │       │                                                 │
│                   폴백 = same-origin pairing 쿠키          │       │                                                 │
│   서버 "h-7k2m" : http://127.0.3.2:LP, Basic 세션 토큰 ─────┼─ -L ──┼─▶ core: 세션 · 도구 · PTY (여기서 실행)        │
│        (토큰은 렌더러 메모리에만. main은 넣지 않음)        │       │   plugins (원격 opencode.jsonc)                  │
│ own-desktop main: SSH 없음. 원격 세션 패인만 attach(7.6)   │       │   1) own.accounts  mode=remote                  │
│ opencode.exe  로컬 own service (127.0.0.1:P)               │       │        slot 등록 ← 미러(비밀 없음)               │
│   1) own.accounts mode=local                               │       │        model.request → 브로커 client ──┐         │
│        vault · refresh single-flight · ledger writer ·     │       │        관측 → spool → push ────────────┤         │
│        한도 저장소 · 전환 상태 머신                          │       │   2) own.remote    mode=agent (realpath, 상태)   │
│   2) own.remote mode=local                                 │       │   3) own.team mode=remote  4) own.telemetry     │
│        SSH 컨트롤러 · 부트스트랩 · askpass · 동기화 ·        │       │   opencode-own.db  ← 원격 세션의 원본           │
│        hosts.json · catalog                                │       │   ~/.local/share/own-open-code/run/ ◀──┘        │
│   3) [own.team] 4) [claude-auth] 5) telemetry 6) computer  │       │ broker-<epoch>.sock · egress-<epoch>.sock (0600)│
│   own-runtime 싱글턴: headersFor ·                         │       └──────────────────────┬─────────────┬────────────┘
│     브로커 서버(127.0.0.1:B_h) ◀───────────────────────────┼─ -R ── (broker 소켓 → B_h) ──┤             │ HTTPS/WSS 직접 (헤더는 lease에서)
│     · egress 중계(127.0.0.1:E_h) ◀─────────────────────────┼─ -R ── (egress 소켓 → E_h) ──┘             │
│   own-vault.exe (DPAPI)                                    │                                            ▼
│   ssh.exe (C:\Windows\System32\OpenSSH, 호스트당 터널 1개)   │       chatgpt.com · api.openai.com · api.anthropic.com
└───────────────────────────────────────────────────────────┘       api.deepseek.com · api.x.ai · openrouter.ai …
```
- 그림의 `127.0.3.2`는 호스트 loopback 주소의 예(`k=3`)다. 로컬 브로커 리스너(`127.0.0.1:B_h`)와 askpass 서버는 원격이 내용을 만드는 HTTP 끝점이 아니므로 `127.0.0.1`에 둔다(7.3).
- 로컬 서비스 쪽에는 그림에 없는 두 가지가 더 있다. own-remote leader가 `ready`인 호스트마다 `-L` 위로 원격 `/api/event`를 하나 구독한다(catalog·피드, 12.3). (M1+) 게이트웨이 리스너 `127.0.0.1:G`가 같은 프로세스 수명 런타임에 뜨고, 기기의 `/srv/<hostId>` 요청을 `127.0.<k>.2:LP`로 중계한다(12.7, 05 §3).
- api.anthropic.com의 Claude 구독 요청은 PC에서 나간다(8.11). 원격의 `egress-<epoch>.sock`이 두 번째 `-R`로 이 PC의 egress 중계(`127.0.0.1:E_h`)에 이어지고, 중계가 이 PC의 claude-auth로 서명해 보낸다. `own-anth-*`(API 키) 요청은 다른 provider처럼 호스트에서 직접 나간다. 웹 검색 서비스(02 §9.2)도 원격 서비스에 등록되고 호스트에서 직접 나간다: `own-chatgpt`는 chatgpt.com, `own-deepseek`은 api.deepseek.com(`/v1/tools/search`, 키는 lease). `brave`는 호스트에서 목록에 없다(키는 이 PC의 vault에만 있고 원격 서비스에는 vault가 없음).

### 3.1 컴포넌트 책임

| 컴포넌트 | 어디서 | 책임 | 하지 않는 것 |
|---|---|---|---|
| own-remote (`mode:"local"`) | 로컬 service | 호스트 레지스트리, SSH 프로세스(inspect/install/터널+ensure), askpass 중계와 프롬프트 분류, 버전 비교와 업데이트·drain 작업, 원격 세션 토큰 서명, 브로커 arm, 원격 이벤트 구독과 catalog 유지(leader, 12.3), 스킬·설정 동기화, RPC id `own.remote`. (M1+) 게이트웨이·기기·알림 피드(05 §13.4–13.6) | 비밀 읽기(브로커는 runtime 몫), ledger 쓰기, 세션 실행 |
| own-runtime 브로커 서버 | 로컬 service | 호스트별 loopback 리스너, 상호 인증, `headersFor` 호출, lease 발급, 관측 수신 → ledger writer·한도 저장소, 미러와 한도 push | SSH 프로세스 관리 |
| own-accounts (`mode:"local"`) | 로컬 service | 02 전부. 추가로 원격 관측의 검증 규칙과 계정 상태 판정(10.5, 10.6) | 원격 세션 전환 실행(원격 인스턴스 몫) |
| own-accounts (`mode:"remote"`) | 원격 service | 미러로 slot 등록, `model.request`에서 브로커 lease 주입, 관측 → spool, 원격 세션의 전환 상태 머신, 캐시 상태 KV, 원격 Location의 플러그인 allowlist | 계정 추가·삭제·수정, refresh, ledger 파일 쓰기, 잔액 poller, 전역 이벤트 발행 |
| own-remote (`mode:"agent"`) | 원격 service | `agent.realpath`, `agent.status`(미러·브로커·spool·버전), `agent.probe`(도구 env 확인), `agent.broker.arm`(키를 runtime에 넘기기만 함) | 네트워크 연결 시작, 키 보관(runtime 몫) |
| own-web | own-desktop 렌더러(`oc://renderer`) 또는 웹 폴백 탭(`http://127.0.0.1:P`). (M1+) 휴대폰 | 서버별 client·이벤트 스트림·데이터, 원격 서버 요청에 세션 토큰 헤더 붙이기(12.1), 사이드바 통합, 폴더 선택, 연결 상태 표시, askpass 대화상자 | SSH, 비밀 보관, 토큰 영속화, catalog 쓰기(12.3) |
| own-desktop main | Electron 메인 프로세스 | 로컬 서비스 origin 요청에만 Basic 주입(05 §6.4). 원격 세션의 브라우저 패인이면 그 원격 서버의 plugin-browser에 attach(7.6, 05 §8.6) | SSH, 터널, 원격 서버 인증 주입, 원격 토큰 저장. upstream `ssh/*`는 import되지만 비활성(05 §4.2) |
| 원격 opencode core | 원격 service | 세션 실행, 원격 DB 단독 writer, 도구, PTY | – |

### 3.2 연결 한 번의 순서 (요약)

```text
own-web  ── own.remote.connect{hostId, clientId} ──▶ own-remote(local)
own-remote: ① inspect (첫 연결·설치 확인 때만, ssh #1, sh -s)
                → 플랫폼·설치 버전·실행 중 서비스·host identity·디스크·셸 env와 경로·logind·/tmp 플래그
            ② [없거나 버전 다름] needs_install / incompatible → 사용자 plan 확인 → install (ssh #2, tar stdin)
            ③ 터널+ensure (ssh #3, 장수, sh -s)
                → -L 127.0.<k>.2:LP→127.0.0.1:RP, -R <소켓 디렉터리>/broker-<epoch>.sock→127.0.0.1:B_h
                → 세션 안에서 ensure: identity·owner 확인 → managed config → broker.current=epoch
                  → service start(버전 일치 시만, 로그인 셸 env) → 등록 정보 출력 → keep
            ④ GET /api/info 준비 대기 → 세션 토큰 서명(12.1) → agent.broker.arm{epoch, key, endpoint, proto}
            ⑤ agent.probe(첫 연결과 설정 변경 뒤) → host.state{ready} → own-web이 own.remote.resolve → {url, token, epoch, controlDir}
            ⑥ (leader) 원격 /api/event 구독 → 목록 조회 → catalog 통째 교체(epoch 증가) → catalog.changed (12.3)
원격 runtime: arm 수신 → 브로커 소켓 연결 → 상호 인증 → registry.get(미러 갱신) → spool 재전송
```
- 재연결은 ③④만이고 인증은 1회다(7.1). RP는 첫 설치 때 고정되므로(5.6) inspect 없이 `-L`을 미리 세울 수 있다. ensure가 보고한 RP가 저장값과 다르면 그때만 터널을 다시 세운다.

---

## 4. SSH를 어디서 돌리는가, upstream 코드 재사용

### 4.1 결정: 로컬 service 안의 플러그인 `own-remote`

| 후보 | 판단 |
|---|---|
| own-web(렌더러·웹 폴백 탭) | 불가. 렌더러는 프로세스를 띄우지 않고(Node API 없음, 05 §3.1), 웹 폴백 탭은 띄울 수 없다. 휴대폰(M1+)에도 같은 코드가 가야 한다 |
| **own-desktop Electron main** | **기각**(05 §12, 데스크톱 타당성 결론 `desktop_verdict.md` §6). 네 가지 이유다.<br>1. 터널이 창·셸 수명에 묶인다. 셸을 닫으면 원격 턴의 브로커 lease가 끊기고, 셸이 없는 웹 폴백·휴대폰에서는 SSH가 없다.<br>2. upstream main 코드는 npm의 upstream CLI를 원격에 설치한다(`packages/desktop/src/main/remote/cli.ts:71`, 5.5와 충돌).<br>3. upstream은 자격 증명을 원격 서버마다 따로 저장한다(0장).<br>4. 자격 증명 브로커(로컬 vault → lease)와 ledger writer가 서비스 안의 own-runtime에 있어야 한다(4.2). main에 두면 비밀이 셸 프로세스로 넘어온다(01 §13: main은 비밀을 보지 않음) |
| launcher(`own.ps1`) | 불가. 서비스를 띄우고 끝나며 감독자를 두지 않는다(01 §5.3) |
| 별도 상주 프로세스(companion) | 기각. 두 번째 감독 대상이 생기고, vault·refresh 조정을 프로세스 사이로 넓혀야 하며, own-web이 인증할 서버가 하나 더 생긴다 |
| **로컬 own service 안의 플러그인** | **채택.** service는 detached라 창·탭을 닫거나 셸을 끝내도 산다. 플러그인은 in-process라 `own-runtime`의 `headersFor`와 ledger writer를 그대로 쓴다. upstream 분석도 같은 자리를 권한다(desktop 컨트롤러는 Bun/Node + Effect에서 그대로 돈다). 데스크톱·웹 폴백·휴대폰이 같은 RPC로 쓴다 |

- **싱글턴, 프로세스 수명 런타임, leader.** 플러그인 인스턴스는 Location마다 뜨고, 각 인스턴스의 Effect Scope는 Location이 dispose될 때 닫힌다(01 §4). vendored 컨트롤러는 ssh 자식 프로세스를 **호출자의 Scope 안에서** 띄우므로(`controller.ts:44-45,145`) Location Scope에서 돌리면 Location을 닫을 때 터널이 죽는다. 그래서 다음과 같이 한다.
  - `own-runtime` 싱글턴(`globalThis[Symbol.for("own-open-code.runtime/<buildId>")]`)이 처음 필요할 때 **프로세스 수명 `ManagedRuntime`**을 하나 만든다. 층은 `NodeServices`(ChildProcessSpawner, FileSystem, Path)와 HttpClient다. SSH 컨트롤러, askpass 서버, 브로커 리스너는 모두 이 런타임의 Scope에서 돈다. Location Scope와 무관하다.
  - own-remote 플러그인 인스턴스는 RPC 핸들러와 이벤트 발행만 한다. 어느 인스턴스가 RPC를 받아도 싱글턴 컨트롤러에 위임한다. **leader**(control location 인스턴스가 있으면 그것, 02 §7.2 poller와 같은 규칙)는 이벤트 중복 발행을 막기 위한 개념이고, leader가 바뀌어도 ssh 프로세스는 그대로다.
  - 빌드가 바뀌어 옛 싱글턴과 새 싱글턴이 잠시 공존하면(01 §4) 컨트롤러가 둘 생길 수 있다. 컨트롤러는 `OWN_HOME\locks\remote-controller.lock`을 잡은 쪽만 돌고, 다른 쪽은 lock이 풀릴 때까지 대기한다(01의 파일 락 원칙과 같음).
  - 참조 카운트가 0이 되고 30초가 지나면 런타임을 닫아 터널을 끝낸다(원격 service는 멈추지 않는다). control location이 살아 있는 한 0이 되지 않는다고 보며, 실제로 그런지는 ⚠(RG1).
  - control location은 프로세스가 사는 동안 내려가지 않는다. core의 LocationActivity는 세션 이벤트가 없는 Location을 한 시간 뒤 정리하는데, 세션이 없는 control location도 부팅 61분 뒤 정리되어 터널과 브로커가 끊겼다(2026-10-28 실제 호스트 E, 결정 RH-9). 그래서 own-runtime이 `Runtime.acquire`에서 `OWN_HOME\control`을 core의 상주 목록(`LocationActivity.RESIDENT`, 코어 패치 P-037)에 넣는다. 로컬 service와 원격 service 모두 같다.
  - 로컬 service가 `TerminateProcess`로 죽으면 Windows는 자식 ssh.exe를 함께 죽이지 않는다. ssh.exe의 stdin 파이프가 닫히므로 원격 keep 스크립트가 EOF로 끝나고(7.4) ssh.exe도 스스로 끝난다. 다음 기동 때 `OWN_HOME\remote\<hostId>\tunnel.pid`(pid + 시작 시각 + 실행 파일 경로)와 **정확히** 같은 프로세스가 남아 있으면 정리한다([old] 89 exact process). 이것도 RG1에서 본다.
  - 빌드 id는 세 플러그인 번들(own-accounts, own-remote, own-telemetry)의 해시로 만든다(01 §4의 두 번들 규칙에 own-remote를 더함).
- **플러그인 API와 Effect 판.** own-remote는 own-accounts처럼 **Promise API** 플러그인이다. 호스트와 주고받는 값은 Promise와 JSON뿐이고 Effect 값을 경계 너머로 넘기지 않는다. vendored 코드가 쓰는 `effect`, `effect/unstable/process`, `@effect/platform-node`는 own-remote 번들에 들어가며, 판은 fork의 catalog 판(루트 `package.json`의 `effect` `4.0.0-rc.112`)과 **정확히** 같게 고정한다. check-surface가 두 판이 같은지 본다(4.4).
- **플러그인 순서(로컬)**: `[own.accounts, own.remote, own.team, heymaaz.claude-auth-v2(선택 슬롯), own.telemetry, own.computer-use, own.import, own.harness]`. own.team(06)이 나오기 전에는 3번이 빠지고, own.import(09)는 IMPORT부터 7번, own.harness(10)는 H0부터 맨 뒤 8번이다.
  - own-remote는 session 훅과 provider transform을 등록하지 않으므로, claude-auth 앞에 두어도 01 §4의 순서 조건(own-accounts는 claude-auth 앞, own-telemetry는 뒤)을 깨지 않는다.
  - 2번에 두는 이유: config가 바뀌면 **바뀐 위치 이후**의 플러그인만 다시 시작한다(`packages/core/src/plugin.ts:108-139`, 01 §9.2). claude-auth 줄이 바뀔 때(앱 업데이트, 2026-10-18 전에는 슬롯 설치·제거) own-remote가 재시작되면 모든 터널이 끊기므로 claude-auth보다 앞에 둔다.
  - `own-computer-use`(01 §10.2)는 6번 자리(맨 뒤)를 쓴다. own.team(06)이 나오기 전에는 다섯 번째 항목이다.
- **플러그인 순서(원격)**: `[own.accounts(mode=remote), own.remote(mode=agent), own.team(mode=remote), own.telemetry, own.harness]`. claude-auth는 싣지 않는다(8.11: Claude 구독은 PC가 중계한다). own-telemetry는 원격 Claude 세션의 긴 멈춤 방지와 extra-usage 경보를 위해 싣는다. own-computer-use와 own-import는 싣지 않는다. 이유는 그대로다: 원격 호스트에는 컴퓨터 사용이 없고(01 §10.2), v1의 own.import(09)는 이 PC의 Codex·Claude Code 저장소만 읽는다(원격 호스트의 own.import는 09 §7.1 I3). 게이트웨이는 `/srv/<hostId>`의 `own.import`를 언제나 막는다(12.7). own-harness(10)는 이 PC처럼 맨 뒤에 싣는다(10 §6.1, 요청 훅이 다른 own 플러그인 뒤에 돈다).
  - **T3(06 §4.13)**: own-team이 원격 managed config의 3번 자리(`{mode:"remote", home:<OWN_HOME>}`)에 들어간다. 원격 서비스(`OWN_REMOTE=1`)에서는 own-team이 전체로 뜨고(T1·T2에서는 `health`만) 그 호스트의 팀을 그 서버의 control location에서 돌린다. 릴리스 번들 목록은 `packages/own-remote/script/bundle.ts`의 `REMOTE_PLUGINS` = `[own-accounts, own-remote, own-team, own-telemetry]`이고 `build-remote.ps1`의 플러그인 단계와 release-smoke가 같은 목록을 본다(FORK §8.2). own-accounts의 `PluginConfig`는 이 줄들을 자기 순서로 읽는다. 원격에는 Claude 슬롯 shim이 없다(8.11).

### 4.2 브로커 서버를 own-runtime에 두는 이유
- 브로커는 인증 헤더를 내보내는 네트워크 표면이다. 헤더를 만드는 함수(`headersFor`, 01 §13.2(c)), 비밀 캐시, refresh single-flight, ledger writer, 한도 저장소가 모두 `own-runtime`에 있다(01 §3.1). 브로커는 이것들 위의 얇은 façade이므로 같은 라이브러리에 둔다.
- own-remote는 전송(ssh, 소켓 경로, epoch 키 생성과 arm)만 한다. 키는 runtime의 `brokerKeys[hostId] = {epoch, key}`에 등록하고, 브로커가 이것으로 검증한다. own-remote 코드는 provider 비밀 값을 보지 않는다. own-remote가 다루는 비밀은 자기가 만든 브로커 키와 원격 서비스 비밀번호(토큰 서명용, 12.1)뿐이고 둘 다 메모리에만 둔다.
- 싱글턴에 raw 비밀 getter를 두지 않는다는 01 §13.2(c)는 그대로다. 브로커는 `headersFor`의 결과(헤더)만 다룬다.

### 4.3 재사용 방식과 원장

`@opencode/desktop`은 `"private": true`, `"main": "./out/main/index.js"`이고 exports 맵이 없다(`packages/desktop/package.json:2-3,26`). exports 맵이 없으므로 소스 경로 deep import는 **된다**. own-desktop은 실제로 main 모듈 대부분을 그렇게 import한다(01 §4.1, 05 §4.2). 그래도 SSH 모듈은 import하지 않고 **순수 모듈을 복사(vendor)** 한다.
- 이 코드는 Electron main이 아니라 로컬 서비스(Bun) 안의 own-remote 번들에서 돈다(4.1). SSH 모듈 자체는 `electron`을 import하지 않으므로(`packages/desktop/src/main/ssh/command.ts:1-4`, `controller.ts:1-22`) import가 막히는 것은 아니다.
- 우리 변경(7.2 parser 축소, `ssh -G` probe 제거, 스테이지·`-R`·호스트 loopback 추가, 터널 안 ensure)이 커서 원본 함수를 그대로 부를 수 없다. 컨트롤러는 upstream `@opencode/app/ssh` 타입에 묶여 있고(`controller.ts:19`), own-remote는 `@own/protocol`의 `own.remote` 스키마를 쓴다.
- 안정된 API가 아니므로 어느 쪽이든 drift 감시가 필요하다. vendor는 `vendored.yaml`의 `source_sha256`으로, own-desktop의 deep import는 check-surface로 본다(4.4, 05 §4.7).
라이선스는 MIT(루트 `LICENSE`, `packages/desktop/package.json:6`)이므로 헤더를 유지한다.

| upstream 파일 | 방식 | 우리 쪽 | 변경 |
|---|---|---|---|
| `packages/desktop/src/main/ssh/command.ts` (256줄) | vendor | `packages/own-remote/src/vendor/ssh/command.ts` | `sshExecutable()`을 절대 경로 고정(14.1), `runSsh` env를 `extendEnv:false` + 최소 env로(14.4). `parseTarget`에서 `-F`, `-o proxycommand`, `-o identityagent` 제거, `-i`·`-o identityfile`은 `%USERPROFILE%\.ssh\` 아래 로컬 경로만(UNC·장치 경로·`%`·`$` 거부, 7.2). `ClearAllForwardings=yes`를 짧은 명령에 추가(7.2) |
| `packages/desktop/src/main/ssh/askpass.ts` (81줄) | vendor | `…/vendor/ssh/askpass.ts` | helper 경로 주입, 프롬프트 분류 추가(`hostKey`/`confirm`/`password`/`passphrase`/`other`, 14.2) |
| `packages/desktop/src/main/ssh/controller.ts` (365줄) | vendor 후 수정 | `…/vendor/ssh/controller.ts` | owner = own-web 클라이언트(탭·창)의 `clientId`(문자열, 6.3), **`ssh -G` destination probe 제거**(`controller.ts:119-131`, 7.5), `-L` 주소를 호스트 loopback으로, `-R` 추가, bootstrap을 터널 세션 안의 ensure로 교체(6.1), 저장 콜백 = `hosts.json`, 스테이지 추가(6.3), 부모 Scope = runtime의 프로세스 수명 런타임(4.1) |
| `packages/desktop/src/main/ssh/bootstrap.ts` (147줄) | **참고만**(새로 작성) | `packages/own-remote/src/ensure.ts` | 다운로드 경로 없음, `command -v opencode` 탐색 없음, 등록 파일은 `service-own.json`만, 버전이 다르면 `service start` 금지. `parseRegistration`의 "상태 URL과 같은 등록만 채택" 규칙(`bootstrap.ts:31-53`)은 유지. 등록 주소는 `127.0.0.1`과 `[::1]`만 받는다. upstream `connectionAddress`는 `0.0.0.0`과 `[::]`도 받으므로(`bootstrap.ts:59-68`) 따르지 않는다(6.1) |
| `packages/desktop/src/main/remote/cli.ts` (126줄) | vendor(일부) | `…/vendor/remote/cli.ts` | `quote`, `requireVersion`, `probeScript`만. `installScript`, `archiveUrl`, `latestBeta`, 다운로드·installer 분기는 가져오지 않는다 |
| (없음) | **새 코드** | `packages/own-remote/src/install.ts` | 다중 파일 번들(바이너리, 플러그인, manifest, `.verified`)을 디렉터리로 배치한다. upstream archive 분기는 npm tarball의 `package/bin/opencode` 하나만 옮기는 구조라(`cli.ts:85-95`, `mv "$stage/package/bin/opencode"`는 94행) 그대로 쓸 수 없다. `quote`, `requireVersion`, `verifyScript`의 판정 방식(`cli.ts:109-111`)만 따른다(5.5) |
| `packages/desktop/src/main/ssh/*.test.ts`, `remote/cli.test.ts` | vendor | `packages/own-remote/test/vendor/` | 우리 변경에 맞춰 수정 |
| `packages/cli/src/ssh-askpass.ts` + 진입 `packages/cli/src/index.ts:19-22` | **재사용(복사 없음)** | 우리 `opencode.exe` 자체가 helper | 없음. 이미 fork 빌드에 들어 있다 |
| `ssh/service.ts`, `ipc-handlers/ssh.ts`, `shared/ipc-rpc/ssh.ts`, `renderer/*` | 쓰지 않음 | – | Electron 전용(`app`, `WebContents`, electron-store, IPC). own-desktop main에는 `Ipc.layer`에 묶여 import되지만(`packages/desktop/src/main/ipc.ts:28`), 저장된 호스트가 없고(`ssh/service.ts:32`) own-web이 `Ssh*` IPC를 부르지 않으므로(lint, 05 §6.5) 아무것도 하지 않는다 |
| `packages/app/src/servers/ssh/types.ts` (`@opencode/app/ssh` export, `packages/app/package.json:13`) | 쓰지 않음 | `@own/protocol`의 `own.remote` 스키마 | `SshHttp.password`를 renderer에 주는 모델을 따르지 않는다(12.1). own-web에 `@opencode/app` 의존을 들이지 않는다(03 §16.1) |

- **`own/ledger/vendored.yaml` 항목 예**(FORK §7 형식)
```yaml
- dest: packages/own-remote/src/vendor/ssh/command.ts
  source: packages/desktop/src/main/ssh/command.ts
  upstream_commit: 00d179015f
  source_sha256: "<복사 시점 해시>"
  local_changes: "ssh.exe 절대 경로 고정, 최소 env, parseTarget에서 -F·proxycommand·identityagent 제거, -i/identityfile은 %USERPROFILE%\\.ssh 아래 로컬 경로만(UNC·장치 경로·%·$ 거부), 짧은 명령에 ClearAllForwardings"
  license: MIT (upstream LICENSE)
- dest: packages/own-remote/src/vendor/ssh/controller.ts
  source: packages/desktop/src/main/ssh/controller.ts
  upstream_commit: 00d179015f
  source_sha256: "<복사 시점 해시>"
  local_changes: "owner=clientId, ssh -G destination probe 제거, -L 호스트 loopback 주소, -R 브로커 forward, 터널 세션 안 ensure, hosts.json 저장, 스테이지 추가, 프로세스 수명 Scope"
  license: MIT (upstream LICENSE)
```
- **코어 패치**: 없다. 원격 모드도 기존 플러그인 훅(`model.request`, `http.request`, `http.response`, `experimental.ws.handshake`, `experimental.ws.receive`, `retry`, event 구독)과 기존 HTTP API(`/api/info`, `/api/session/active`, `/api/fs/list`)만 쓴다. 원격 세션 토큰은 upstream 형식대로 직접 서명하고, 형식이 바뀌면 pairing API(`/api/pair`, `/auth/connect/:code`)로 되돌린다(12.1).

### 4.4 `check-surface` 입력에 더할 upstream 표면

| 심볼 / 동작 | 파일 | 기대 값 | 깨지면 |
|---|---|---|---|
| askpass 모드 진입 | `packages/cli/src/index.ts:19-22`, `packages/cli/src/ssh-askpass.ts:1-40` | env `OPENCODE_SSH_ASKPASS_PORT`가 있으면 askpass 실행, 요청 `{token, text, confirm}` 한 줄 JSON. `confirm`은 `SSH_ASKPASS_PROMPT=confirm`일 때만 참(`ssh-askpass.ts:26`) | helper를 own-remote 번들의 별도 스크립트로. 분류 규칙(14.2) 점검 |
| 등록 파일 이름·스키마 | `packages/cli/src/services/service-config.ts:29-38`, `service-registration.ts:13-38` | 채널 `own` → `service-own.json`, `{url,password,version,pid}`, 0600 temp→rename | ensure 스크립트 파서 수정 |
| `Service.ensure`의 버전 불일치 교체 | `packages/client/src/effect/service.ts:50-53,106-113` | 버전이 다른 서비스를 stop 후 새로 띄움 | 바뀌어도 우리 규칙(버전 먼저 확인)은 유지 |
| pairing API | `packages/server/src/handlers/server.ts:27-50`, `packages/server/src/pairing.ts:7,22-28` | `POST /api/pair` → `{code, expires_in}`, `GET /auth/connect/:code`가 API 클라이언트에 `{token}` JSON | 12.1 토큰 발급 경로 |
| 세션 토큰 형식 | `packages/server/src/auth.ts:16,39-66` | `<expires초>.<base64url HMAC(key, expires)>`, `key = HMAC(password, "opencode-session-v1")`. 검증은 미래 만료면 모두 받음. 비밀번호 교체로 전부 무효 | own-remote의 직접 서명을 끄고 pairing API로(12.1). 15장 폐기 절차 |
| 세션 쿠키 이름과 범위 | `packages/server/src/auth.ts:57-60`, `middleware/authorization.ts:63-70` | 쿠키 이름에 포트를 넣음(`opencode_session_<P>`). 쿠키는 호스트 단위라 같은 호스트의 다른 포트에도 간다. 쿠키 인증은 same-origin 요청만 | 7.3 loopback 분리의 전제 재검토 |
| CORS 허용 목록 | `packages/server/src/cors.ts:11-20` | `http://127.0.0.1:*`, `http://localhost:*`, `oc://renderer`, tauri origin, `https://*.opencode.ai` 허용. **`http://127.0.<k>.2:*` 같은 다른 loopback 주소는 허용하지 않음** | 앞쪽이 깨지면 own-web의 원격 호출이 막힘. 뒤쪽이 깨지면 원격 끝점의 페이지가 로컬 API를 부를 수 있으므로 **출시 차단**(RG16) |
| 프로젝트 설정 끄기 | `packages/cli/src/server-process.ts:124-131`, `packages/core/src/config/discovery.ts:78-81`, `packages/core/src/config/plugin/instruction.ts:39` | `OPENCODE_CONFIG_PROJECT_DISABLE`이 참이면 프로젝트 쪽 `.opencode`·`.claude`·`.agents`·config 파일을 찾지 않고 저장소의 `AGENTS.md`도 읽지 않음. own 패치 P-058의 `OPENCODE_CONFIG_PROJECT_INSTRUCTIONS`가 참이면 `AGENTS.md` 탐색만 다시 켬 | 원격 기본값(5.6) 재설계, 세 상태(HPC 2026-11-20) |
| `http.request`·`experimental.ws.handshake` 재작성 | `packages/plugin/src/promise/session.ts:72-100,145-147` | 훅이 바꾼 `request`, `url`, `headers`가 전송에 쓰임 | 8.7 sink를 `model.request`의 baseURL 교체로 |
| `fs.list`의 경로 규칙 | `packages/protocol/src/groups/fs.ts:47-58` | 절대 경로나 location 기준 상대 경로를 받고, 항목 경로는 요청한 location 기준 상대 경로로 돌려줌 | 원격 폴더 선택기(12.4) |
| own-remote 번들의 `effect` 판 | 루트 `package.json`의 catalog `effect` | 번들 판과 같음 | 번들 다시 만들기(4.1) |
| `GET /api/session/active` | `packages/protocol/src/groups/session.ts:271` | 실행 중 세션 목록 | drain 판정(6.4) |
| retry 결정의 delay | `packages/plugin/src/promise/session.ts:127`, `packages/core/src/session/runner/retry.ts:78-120`, `packages/core/src/session/runner/step.ts:174-186` | 재시도 불가 오류(Authentication)에도 훅이 불리고 `{retry:true, delay}`로 바꿀 수 있음. 횟수는 schedule의 10회로 묶임 | 8.7 유예를 끄고 즉시 실패 |
| desktop SSH 원본 해시 | vendored.yaml의 `source` | drift 경고 | 수동 검토 |
| 데스크톱 main의 Basic 주입 조건 | `packages/desktop/src/main/service/sidecar-credentials.ts:26-29`, `packages/desktop/src/main/windows/security.ts:42-53` | URL 필터 `http://127.0.0.1/*`·`http://localhost/*`, 렌더러 top frame, **요청 origin이 로컬 서비스 origin과 정확히 같을 때만**. 그래서 `127.0.<k>.2`로 가는 원격 요청에는 로컬 비밀번호가 붙지 않는다 | 로컬 비밀번호가 원격 서버로 샐 수 있으므로 **출시 차단**. own-desktop 쪽 치환으로 막는다(05 §4.3) |
| 브라우저 패인의 loopback 경로 | `packages/desktop/src/main/browser/network.ts:44-46`, `browser-pane.ts:84,88-90` | 패인 partition의 모든 요청(loopback 포함)이 서버 plugin-browser 터널로 나감(`proxyBypassRules:"<-loopback>"`). partition은 attachment마다 메모리 전용. 파일 루트는 같은 기계일 때만 | 7.6의 "원격 세션 패인은 원격 localhost" 전제 재검토 |

---

## 5. 원격 부트스트랩

### 5.1 지원 플랫폼

| 대상 | 단계 | 근거 |
|---|---|---|
| `linux-x64-baseline` (glibc) | R1 | upstream probe가 Linux x64에는 baseline을 쓴다(`packages/desktop/src/main/remote/cli.ts:55-66`). AVX2가 없는 CPU도 받기 위해서다 |
| `linux-arm64` (glibc) | R1 | 같은 probe |
| `linux-x64-baseline-musl`, `linux-arm64-musl` | R3 | Alpine 등. upstream 빌드 대상에 있다(`packages/cli/script/build.ts:39-44`) |
| macOS, Windows | 비목표 | 1.2 |

### 5.2 산출물

- **빌드.** upstream 빌드 스크립트는 Linux 대상을 이미 갖고 있다(`packages/cli/script/build.ts:39-44,53-63`). 릴리스 때 `OPENCODE_CHANNEL=own`, `OPENCODE_VERSION=<로컬과 같은 버전>`으로 Linux 대상을 빌드한다.
  - (RG2, 계획 당시) **Windows에서 교차 빌드가 되는지 몰랐다.** 네이티브 선택 의존성(`@parcel/watcher-linux-*`, fff 네이티브 라이브러리, opentui, `build.ts:110,156-159`)이 Windows의 `bun install`로는 받아지지 않을 수 있다. 안 되면 Linux 빌드 호스트(예: build-host)에서 같은 커밋으로 빌드하고 해시를 manifest에 넣는다. WSL과 Docker는 이 PC에 없다(20.2).
  - RG2(Windows 교차 빌드) **산출물 단계 통과(2026-09-27, P7).** `own/scripts/build-remote.ps1`이 upstream `build.ts`를 고치지 않고 이 PC에서 `linux-x64-baseline`·`linux-arm64`를 교차 빌드한다. 네이티브 선택 의존성은 `packages/own-remote/script/native.ts`가 `bun.lock`에 고정된 버전을 npm에서 받아 sha512를 확인하고, 빌드 동안만 Bun 설치기가 둘 자리에 junction으로 연결한 뒤 되돌린다(`bun.lock`·`node_modules` 변화 0). Bun이 받은 Linux 런타임은 npm 패키지와 GitHub 릴리스 zip과 대조한다. 빌드의 `verify-binary` 단계가 ELF(64비트 LE, 기계, glibc 로더), 버전·own 채널 user agent, 네이티브 라이브러리 4개의 포함을 확인하고, fake-SSH 설치 흐름이 실제 tarball의 업로드·해제·`sha256sum -c`를 통과한다. 실제 Linux의 `--version`은 **첫 실제 호스트에서 통과(2026-09-28)**: `dev-host`(Ubuntu 24.04.5 x86_64, glibc 2.39)에 업로드 설치 후 `opencode v2.0.18-own.1`, `sha256sum -c` 통과(`packages/own-remote/test/real-host/`). Linux 빌드 호스트 절차는 대체 경로로 남긴다.
- **번들 형식.** `app\<ver>\remote\linux-x64-baseline.tar.gz`, `linux-arm64.tar.gz`. 안에는 다음만 둔다.
  - `opencode` (own 채널 Linux 바이너리)
  - `plugins/own-accounts/index.js`, `plugins/own-remote/index.js`, (T3) `plugins/own-team/index.js`, (8.11) `plugins/own-telemetry/index.js`, (10 §6.1) `plugins/own-harness/index.js`, (15 §1, 2026-10-29) `plugins/own-omo/{index.js, omo-runtime.js, LICENSE.md, THIRD-PARTY-NOTICES.md, MODIFICATIONS.md, skills/…}` (로컬과 **같은 파일**, JS라 플랫폼 무관)
  - `libexec/start.sh` (POSIX 기동 스크립트: provider 키 env 정리, 호스트 env 적용, `service start`, 6.1)
  - `manifest.json` (버전, 빌드 id, 브로커 `proto`, 각 파일 sha256)
  - own-vault, claude-auth 템플릿, own-computer-use, own-import는 넣지 않는다(own-harness와 own-omo는 넣는다, 10 §6.1, 15 §1). release-smoke가 대상마다 own-import가 없는지, own-omo 옆에 런타임과 세 고지 파일이 있는지, 서드파티 표식(`x-anthropic-billing-header`, billing salt)이 0인지 본다.
- **도구 파일(T3, 06 §4.13).** 고정 버전 정적 git-lfs(3.8.1, linux-amd64·arm64. 2026-10-30에 3.8.0에서 보안 수정판으로 올림)는 대상 압축 파일에 넣지 않고 그 옆 `app\<ver>\remote\tools\git-lfs\<ver>\<target>\{git-lfs, LICENSE.md}`에 따로 둔다. 그 저장소가 LFS를 쓸 때만 그 호스트에 올리기 때문이다(16.2 `hosts.tools.ensure`). 빌드는 공식 릴리스 압축 파일을 고정 sha256과 맞춘 뒤에만 풀고, 바이너리가 그 대상의 정적 ELF(PT_INTERP 없음)인지 보며, 공식 압축 파일에 없는 라이선스는 git-lfs 저장소의 `LICENSE.md`(MIT)를 옆에 둔다(`own-remote/script/native.ts` `GIT_LFS`, `build-remote.ps1` 2b단계). 원격 `remote\manifest.json`과 `remote_artifacts.json`에 `tools: {"git-lfs": {version, targets: {<target>: {file, sha256, bytes, files: {"git-lfs": "sha256:…", "LICENSE.md": "sha256:…"}}}}}`가 붙는다(`file`은 `remote\` 기준, `files`는 호스트 버전 폴더의 `sha256sum -c` 항목).
- **릴리스 manifest.** FORK §8.3에 `remote_artifacts: {"linux-x64-baseline": {"sha256": …, "bytes": …, "files": {…}}, …}`를 더한다(22장). T3부터 같은 객체에 위 `tools` 키가 있다(그래서 `build-desktop.ps1`은 대상 목록을 `remote_artifacts`의 키가 아니라 원격 manifest의 `targets`에서 읽는다).

### 5.3 원격 배치 레이아웃

- **모든 원격 경로는 inspect가 보고한 env로 계산한다.** 아래 그림은 XDG 변수가 없을 때의 기본값이다. 실제로는 서비스 env를 만드는 같은 셸 모드(6.1)에서 읽은 `HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`으로 절대 경로를 만든다. upstream 경로도 이 변수를 따르기 때문이다(`packages/util/src/global-roots.ts:5-8`).
  - 원격 OWN_HOME = `${XDG_DATA_HOME:-$HOME/.local/share}/own-open-code`(02 §2.3)
  - 원격 config 디렉터리 = `${XDG_CONFIG_HOME:-$HOME/.config}/own-open-code`, upstream 등록 파일 = `${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service-own.json`
  - managed config와 플러그인 옵션에는 이렇게 계산한 **절대 경로**만 쓴다. `~`는 셸 밖에서 펼쳐지지 않는다(5.6).

```text
~/.local/share/own-open-code/                 ← 원격 OWN_HOME (02 §2.3 "원격 Linux", XDG 기본값일 때)
  app/2.0.18-own.3/opencode                   ← 버전별 디렉터리 (0755 바이너리, 나머지 0700 디렉터리)
  app/2.0.18-own.3/plugins/own-accounts/index.js
  app/2.0.18-own.3/plugins/own-remote/index.js
  app/2.0.18-own.3/plugins/own-team/index.js  ← T3. 원격 팀(06 §4.13)
  app/2.0.18-own.3/plugins/own-telemetry/index.js ← 원격 Claude 세션의 긴 멈춤 방지·extra-usage 경보(8.11)
  app/2.0.18-own.3/plugins/own-harness/index.js ← 세션별 하네스(10 §6.1)
  app/2.0.18-own.3/plugins/own-omo/index.js     ← omo (원본) 하네스(15 §1). 옆에 omo-runtime.js, 고지 셋, skills/
  app/2.0.18-own.3/plugins/own-creator/index.js ← PC 확장의 읽기 전용 미러(17 §10). 옆에 quickjs/core, quickjs/variant(.wasm 하나, x64·arm64 같음)
  app/2.0.18-own.3/libexec/start.sh
  app/2.0.18-own.3/manifest.json
  app/2.0.18-own.3/.verified                  ← 설치 때 검증한 sha256 목록과 크기
  app/2.0.18-own.2/…                          ← 직전 버전(롤백용). 그 이전은 GC
  app/current -> 2.0.18-own.3                 ← symlink. config의 플러그인 경로가 이것을 가리킴
  accounts.json, policy.json, ratecards.json  ← 미러(9.2). own-accounts(remote)만 씀. 비밀 없음. 압축 설정(accounts[].compaction, policy.compaction) 포함
  presets.json                                ← T3. 미러한 이 PC의 프리셋(9.2, 07 §8.1 원격). 원격은 읽기만
  creator/                                    ← PC 확장 저장소의 읽기 전용 미러(9.3, 17 §10): store.json, ext/<id>/v<n>/(PC 판과 해시가 같은 파일), mirror.json(호스트 단계 검사 결과), logs/
  tools/git-lfs/3.8.1/{git-lfs, LICENSE.md, .verified}  ← T3. 그 호스트에 LFS 저장소가 있을 때만 올린 정적 git-lfs(16.2)
  tools/git-lfs/current -> 3.8.1              ← 원자적으로 바꾸는 symlink. 저장소 local 필터와 `pathPrepend`가 이것을 가리킴
  trust.json                                  ← 이 서버의 프로젝트 플러그인 승인(01 §13.2와 같은 형식)
  control/                                    ← 이 서버의 control location(빈 디렉터리)
  spool/obs-<streamId>.jsonl                  ← 관측 spool(10.2)
  run/                                        ← 0700
  run/broker.current                          ← 현재 epoch 번호 한 줄(비밀 아님). ensure만 temp→rename으로 씀. 지우지 않음
  run/broker-<epoch>.sock                     ← sshd가 만드는 -R 소켓(0600). 경로가 길면 짧은 디렉터리로(7.4)
  run/egress-<epoch>.sock                     ← 두 번째 -R 소켓(0600). Claude 구독 egress 중계(7.4, 8.11)
  run/owner.json                              ← 이 설치를 관리하는 로컬 {installId, hostId, label}(6.8)
  tmp/                                        ← 0700. 서비스 env의 TMPDIR(6.1). /tmp가 noexec여도 네이티브 모듈 추출이 되게
  ops/<opId>.json                             ← 업데이트·drain 작업 저널(6.4)
  backup/opencode-own.<ver>.<ts>.db           ← 업데이트 전 DB 백업
~/.config/own-open-code/opencode.jsonc        ← 원격 OPENCODE_CONFIG_DIR. managed 키만 우리가 씀(5.6)
~/.config/own-open-code/service-own.json      ← 서비스 설정 {hostname, port, password, env}
~/.config/opencode/service-own.json           ← env 브리지(같은 내용). upstream 설정 디렉터리에 쓰는 유일한 파일
~/.local/state/opencode/service-own.json      ← upstream 등록 파일 {url,password,version,pid} (0600)
~/.local/share/opencode/opencode-own.db       ← 원격 세션 DB(원본). data 루트는 "opencode"로 공유(01 §5.2)
```
- 브로커 키는 이 레이아웃 어디에도 없다. 키는 arm으로 원격 runtime 메모리에만 들어간다(8.3).
- root가 필요한 경로는 없다. `$HOME`이 noexec 마운트이면 `--version` 검증이 실패하므로 `noexec` 오류로 알리고, 호스트 설정 `installRoot`로 다른 사용자 쓰기 경로를 고르게 한다.
- Bun 컴파일 바이너리는 네이티브 모듈(parcel watcher, fff)을 TMPDIR에 풀어 로드한다. `/tmp`가 noexec이면 서비스가 뜨지 못하므로, 서비스 env의 `TMPDIR`을 항상 `<OWN_HOME>/tmp`로 둔다. inspect는 `/tmp`와 OWN_HOME의 마운트 플래그를 함께 보고한다 ⚠(RG3).
- upstream 설치본(`~/.opencode/…`, PATH의 `opencode`, `service.json`, `opencode.db`)은 읽지도 쓰지도 않는다. inspect는 존재 여부(불리언)만 보고한다(5.8).

### 5.4 inspect 스크립트

`ssh <공통 옵션> -o ClearAllForwardings=yes <alias> "sh -s"`에 stdin으로 넣는다. 첫 연결, 설치 전, 진단(`host_key`, forward 실패 등) 때만 돈다. 재연결에는 쓰지 않는다(7.1).
- **inspect 자체는 POSIX `sh`(비로그인)로 돈다.** Debian·Ubuntu의 `sh`는 dash라 `sh -l`은 `~/.profile`만 읽고, Ubuntu의 `~/.profile`은 `$BASH_VERSION`이 있을 때만 `.bashrc`를 읽는다. 그래서 `sh -l`의 PATH는 에이전트 도구가 보는 PATH와 다를 수 있다. 에이전트 셸 도구는 서비스 env를 물려받은 `$SHELL -c <cmd>`(비로그인·비대화형, `packages/core/src/shell/select.ts:164-169`, `packages/core/src/shell.ts:278`)이고, PTY는 `$SHELL -l`(`packages/core/src/pty.ts:167`)이다. 그래서 inspect는 셸 모드별 env를 따로 잰다(아래 `ENV_*`).
- **출력은 허용 목록의 `OWN_INSPECT_<KEY>=<value>` 줄만 쓴다.** 파서는 이 접두어가 없는 줄(프로필 스크립트의 echo 등)을 버리고, 같은 키는 마지막 값을 쓴다.
- 보고 항목: `V=1`, `OS`, `ARCH`, `TARGET`(probe 규칙, `cli.ts:55-66`), `LIBC`, `UID`, `SHELL`, `HOST_IDENTITY`, `FREE_KB`(OWN_HOME이 있는 파일 시스템, `df -Pk`), `INSTALLED`(설치된 버전 목록, `.verified`가 있는 것만), `CURRENT`, `RUNNING_VERSION`, `RUNNING_PID`, `RUNNING_PID_ALIVE`, `RUNNING_EXE_OK`(`/proc/<pid>/exe`가 우리 버전 디렉터리의 바이너리인지), `OWNER`(`run/owner.json`의 installId), `UPSTREAM_OPENCODE`(0/1), `SHA256_TOOL`(`sha256sum`/`shasum`/`openssl`/none), `TAR`(0/1), `OPS_PENDING`(끝나지 않은 작업 저널 id).
- 셸 env 항목: 세 모드 `sh -l`, `"$SHELL" -lc`, `"$SHELL" -lic` 각각에서 `HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `PATH`를 표식 사이로 출력한다(`ENV_SHL_*`, `ENV_LOGIN_*`, `ENV_INTERACTIVE_*`). 각 셸은 stdin `/dev/null`, `timeout 10`(있을 때), 표식 밖 출력 무시로 막는다. 대화형 셸이 멈추거나 오류를 내면 그 모드는 `unavailable`로 둔다. own-remote는 PATH 차이(예: `$SHELL -lic`에만 있는 `~/.nvm/…`)를 호스트 패널에 보이고 셸 모드 선택을 권한다(6.1).
- 호스트 환경 항목: `LINGER`(`loginctl show-user <uid> -p Linger`), `KILL_USER_PROCESSES`(logind 설정, 읽을 수 없으면 `unknown`), `TMP_FLAGS`, `OWN_HOME_FLAGS`(마운트 옵션의 `noexec` 여부), `SOCK_PATH_LEN`(7.4의 최장 소켓 경로 길이).
- 실행 중 서비스는 **우리 채널 등록 파일(`<XDG_STATE_HOME>/opencode/service-own.json`) 하나만** 읽는다. upstream처럼 `service*.json`을 glob하지 않는다(`bootstrap.ts:8-17`은 모든 채널을 읽는다). 등록 파일의 비밀번호는 inspect에서 출력하지 않고, ensure 단계에서만 한 번 읽는다(6.1).
- `host_identity`는 Python 없이 `printf '%s\0%s\0%s' "$(cat /etc/machine-id)" "$(id -u)" "$HOME" | sha256sum`로 만든다. 도구가 없으면 `unavailable`로 두고 경고만 한다.

### 5.5 설치 (업로드만)

1. **plan**(`own.remote.prepare.plan`, 16.2): inspect 결과로 대상 번들, 설치 경로, 필요 공간(번들 크기 × 3: 압축본 + 풀린 본 + 직전 버전), 여유 공간, 기존 설치, host identity를 보여 준다. 여유가 모자라면 여기서 `disk_full`로 멈춘다([old] `docs/design/new-profile-ssh-43.md:5,19` 약 300MB 여유 호스트에서 475MB 런타임 실패).
2. **execute**: 로컬 번들을 `ssh … "sh -c '<install script>'"`의 stdin으로 보낸다(upstream archive 전송 방식, `bootstrap.ts:111-135`). 원격에는 `sh`, `tar`, `mktemp`만 있으면 된다.
3. install 스크립트는 **새 코드**(`install.ts`, 4.3)다. upstream archive 분기의 골격(`umask 077`, `mktemp -d` 스테이지, `trap` 정리, `cli.ts:85-95`)만 따른다.
   - `umask 077`, 대상 디렉터리 옆에 `mktemp -d` 스테이지, `trap`으로 정리
   - `tar -xzf`, `manifest.json`의 sha256과 대조(`SHA256_TOOL`이 none이면 건너뛰고 `--version`과 크기만 확인, 경고)
   - `chmod 755 opencode`, `./opencode --version`이 기대 버전인지 확인(upstream `verifyScript`와 같은 판정, `cli.ts:109-111`)
   - `.verified` 작성 → `mv`로 `app/<ver>`에 원자적으로 배치
   - 처음 설치할 때 `run/`, `tmp/`(각 0700)과, 7.4의 짧은 소켓 디렉터리를 쓰는 호스트면 그 디렉터리도 만든다. 터널의 `-R` bind가 ensure보다 먼저 일어나기 때문이다
   - ENOSPC·EDQUOT는 `disk_full`, `--version` 실행 실패는 `noexec` 또는 `platform_mismatch`로 구분해 보고한다.
4. 같은 버전이 이미 `.verified`로 있으면 재설치하지 않는다(upstream `bootstrap.ts:94-96`와 같음).
5. **다운로드 경로는 없다.** own 채널 빌드는 npm에 없고, 원격이 외부에서 바이너리를 받게 하지 않는다(공급망 표면 축소).

### 5.6 env 브리지와 managed config

- **서비스 설정 두 파일**(`~/.config/own-open-code/service-own.json`, `~/.config/opencode/service-own.json`)은 로컬 01 §5.2와 같은 방식이다. 내용:
  ```json
  { "hostname": "127.0.0.1", "port": 31872,
    "env": { "OPENCODE_CONFIG_DIR": "/home/u/.config/own-open-code", "OWN_OPEN_CODE": "1", "OWN_REMOTE": "1",
             "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_FREE_MODELS": "1", "OPENCODE_CONFIG_PROJECT_DISABLE": "1",
             "TMPDIR": "/home/u/.local/share/own-open-code/tmp" } }
  ```
  - `password`는 우리가 쓰지 않는다. 첫 기동 때 upstream이 만들어 저장한다(`packages/cli/src/server-process.ts:78-84,132`). 이후 우리는 read-modify-write로 다른 키만 고치고 `password`를 보존한다.
  - `hostname`은 `127.0.0.1`로 쓴다. ensure는 매번 이 값이 `127.0.0.1`이나 `::1`인지 확인하고, 사용자가 바꿔 두었으면 서비스를 띄우지 않고 `service_not_loopback`으로 멈춘다(1.2).
  - **원격 service가 저장소에서 무엇을 읽는지는 호스트 설정 `projectConfig`의 세 상태로 정한다**(HPC, 2026-11-20). 서비스 env의 두 변수로 전한다.

    | `projectConfig` | 화면 이름 | `OPENCODE_CONFIG_PROJECT_DISABLE` | `OPENCODE_CONFIG_PROJECT_INSTRUCTIONS` | 원격 service가 저장소에서 읽는 것 |
    |---|---|---|---|---|
    | `disabled` | 끔 | `1` | 없음 | 없음. `AGENTS.md`도, 프로젝트 쪽 `.opencode`(플러그인·에이전트·명령·스킬)·`.claude`·`.agents`도, 프로젝트 config 파일(MCP, `instructions` 항목)도 읽지 않는다 |
    | `instructions` | 지시 파일만 (AGENTS.md) | `1` | `1` | 저장소의 `AGENTS.md`만. 대화 폴더에서 저장소 루트까지 올라가며 찾고(코어 지시 탐색), 그 아래 폴더의 것은 그 폴더의 파일을 읽을 때 더한다(코어 `read`, opencode·omo·claude-code 방식만). 코드와 프로젝트 config는 `disabled`와 똑같이 읽지 않는다 |
    | `trusted` | 켬 | 없음 | 없음 | 전부. 원격 `trust.json` allowlist(01 §13.2)만 적용한다 |

    - **기본값**: 새로 추가하는 호스트는 `instructions`다. 이미 등록된 호스트는 저장된 값(`disabled` 또는 `trusted`)을 그대로 쓴다. 자동으로 옮기지 않는다. 값을 바꾸면 "설정 대기(재시작 필요)"가 된다(6.4).
    - **왜 나누는가**: `disabled`와 `instructions`가 프로젝트 config를 끄는 것은 원격 저장소의 플러그인이 원격 service 안에서 lease를 가로채는 경로를 막기 위해서다(8.6, 15장). 지시 파일은 글이고 코드를 싣지 않는다. 2026-09-28 실제 호스트(RG17)에서 `OPENCODE_CONFIG_PROJECT_DISABLE=1`이 `AGENTS.md`까지 끄는 것을 확인했고, 그 때문에 기본값에서 어느 방식도 저장소의 `AGENTS.md`를 받지 못했다(`own/reports/host-project-config-2026-11-21.md`).
    - **코어 근거**: `packages/cli/src/server-process.ts:124-131`(`config.project`와 P-058의 `config.instructions`), `packages/server/src/routes.ts:136-147`(`Config.configured({project})`와 `InstructionDiscovery.configured({project: instructions ?? project})`가 따로 받는다), `packages/core/src/config/discovery.ts:78-81`(프로젝트 폴더 걷기를 건너뜀), `packages/core/src/instruction-discovery.ts:99`와 `packages/core/src/config/plugin/instruction.ts:39`(`AGENTS.md` 탐색), `packages/core/src/tool/plugin/read.ts`(P-059: 하위 폴더 `AGENTS.md` 주입도 같은 스위치를 따른다. 그 전에는 `disabled`에서도 들어갔다).
    - **버전이 어긋날 때 안전한 쪽으로**: `instructions`는 예전부터 있던 변수를 `1`로 둔 채 새 변수를 하나 더한다. 새 변수를 모르는 예전 원격 service는 `disabled`처럼 동작하고, `trusted`가 되는 일은 없다. 두 이름 모두 사용자 env로는 받지 않는다(`RemoteModel.validateEnv`가 거부하고 `serviceEnv`도 저장된 env에서 빼 버린다).
    - **프로젝트 스킬은 `trusted`에서만 읽는다**(HPC-3). 코어는 스킬 폴더를 플러그인·명령·에이전트와 같은 프로젝트 폴더 탐색으로 찾고, 스킬은 실행할 스크립트를 함께 싣는다. omo가 코어와 따로 하던 프로젝트 스킬 탐색도 같은 규칙을 따른다(OMO-P9, 15 §4).
    - **방식별 차이**: pi·codex·dsh 방식은 `trusted`에서도 하위 폴더 `AGENTS.md`를 받지 않는다. 코어 `read`가 아니라 자기 읽기 도구를 쓰기 때문이고, 원래 도구도 대화 폴더에서 위쪽만 본다(10 §3.3). `CLAUDE.md`는 어느 방식도 읽지 않는다.
    - **상태와 상관없이 읽는 것**: 호스트 자신의 전역 파일(`~/.config/own-open-code/AGENTS.md`·`skills`·`commands`·`agents`, `~/.claude/skills`, `~/.agents/skills`).
    - **검증**: RG17(20.3)이 실제 호스트에서 세 상태를 본다. own-harness e2e `project-states-*.test.ts`가 여섯 방식 × 세 상태를, own-accounts e2e `fake-ssh.test.ts`가 `instructions`에서 lease로 나간 요청과 로드되지 않은 저장소 플러그인을 본다.
  - 두 파일은 비밀번호를 담을 수 있으므로 ensure가 매번 `chmod 600`을 확인한다. 등록 파일은 upstream이 0600으로 쓴다(`service-registration.ts:38`).
  - **포트**는 첫 설치 때 정한다. 채널 기본 포트(`10000 + hash("own") % 50000`, `service-config.ts:34-38`)가 비어 있으면 그것, 아니면 20000–60000 중 빈 포트를 골라 고정한다. 한 호스트에 own 채널을 쓰는 OS 사용자가 둘이면 기본 포트가 겹치기 때문이다(`server-process.ts:146-159`의 "already in use by another process").
- **`~/.config/own-open-code/opencode.jsonc`**: 우리가 소유하는 키만 원자적으로 고치고 나머지와 주석은 보존한다(01 §9.2 4번과 같은 jsonc 편집).
  - `plugins`: `[{path: "<OWN_HOME>/app/current/plugins/own-accounts", options:{mode:"remote", home:"<OWN_HOME>"}}, {path: "<OWN_HOME>/app/current/plugins/own-remote", options:{mode:"agent"}}, {path: "<OWN_HOME>/app/current/plugins/own-team", options:{mode:"remote", home:"<OWN_HOME>"}}, {path: "<OWN_HOME>/app/current/plugins/own-telemetry", options:{home:"<OWN_HOME>"}}, {path: "<OWN_HOME>/app/current/plugins/own-harness"}, {path: "<OWN_HOME>/app/current/plugins/own-omo", options:{home:"<OWN_HOME>"}}, {path: "<OWN_HOME>/app/current/plugins/own-creator", options:{home:"<OWN_HOME>", mode:"remote"}}]`(셋째 줄은 T3, 06 §4.13. 넷째 줄은 8.11.14. 다섯째 줄은 10 §6.1, 옵션 없음. 여섯째 줄은 15 §1(2026-10-29): omo의 폴더와 기록이 그 OWN_HOME 아래. 일곱째 줄은 17 §10(2026-11-06): PC 확장의 읽기 전용 미러. own-remote의 `home`도 넣음, `RemoteModel.managedConfig`). own-computer-use와 own-import는 넣지 않는다. `<OWN_HOME>`은 5.3처럼 계산한 **절대 경로**다. 플러그인 옵션은 셸을 거치지 않으므로 `~`를 쓰면 글자 그대로 `~`가 된다(옵션은 `ctx.options`, 02 §2.3).
  - `"update": "disable"`, `"share": "disabled"`
  - 기본 권한: shell `ask`. fs read/write deny: `<OWN_HOME>/run/`, `<OWN_HOME>/spool/`, 두 `service-own.json`, 등록 파일, `opencode-own.db*`(01 §13 "에이전트 접근"과 같은 심층 방어, 셸로 우회 가능함을 전제). 이 규칙은 에이전트 도구에만 걸리고 같은 프로세스의 플러그인 코드에는 걸리지 않는다. 에이전트가 못 여는 파일·폴더의 기본 목록과 사용자 목록(01 §13 PP)도 호스트의 own-accounts가 호스트 사용자의 홈 폴더를 기준으로 놓고 호스트의 KV에 두며, 같은 `evaluate` 훅으로 적용한다(02 §9.2).
  - MCP, agent, 스킬 경로는 쓰지 않는다. 사용자가 원격에서 직접 추가한 값은 보존한다(13장).
  - 이 파일은 연결마다 통째로 다시 쓴다. 그래서 사용자가 그 호스트에 허용한 creator C3 코드 플러그인(17 §10.5)은 own-creator가 core가 그 뒤에 읽는 `opencode.jsonc`의 `plugins` 끝에 쓴다(없으면 만들고, `<OWN_HOME>/creator/ext/` 아래를 가리키는 항목만 고친다). own이 사용자의 `opencode.jsonc`를 고치는 유일한 경우다.
- **env 정리.** 서비스는 `{...process.env, ...env}`로 spawn되므로(`packages/client/src/service-contender.ts:17-22`) ensure가 `service start`를 부르는 프로세스의 env가 곧 서비스와 도구 자식 프로세스의 env다. 그래서 ensure는 기동 직전에 로컬 launcher와 같은 provider 키 env(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_*`, `CLAUDE_*`, `OPENCODE_CLAUDE_AUTH_*`)를 지운다. 셸 프로필에 키가 export되어 있어도 서비스와 도구가 상속하지 않게 하기 위해서다(01 §13 env 위생). 정리는 로그인 셸이 프로필을 다 읽은 **뒤**에 우리 POSIX 스크립트에서 한다(6.1 5번).
- **호스트별 env 재정의.** 호스트 설정 `shellEnv`(`"login"` 기본 / `"login-interactive"` / `"sh"`)와 `env`(키-값, provider 키 이름은 거부), `pathPrepend`(절대 경로 목록)를 둔다. inspect의 PATH 차이를 보고 사용자가 고른다(17.5).
  - **T3**: `hosts.tools.ensure`(16.2)가 git-lfs를 올리거나 이미 있음을 확인하면 `<OWN_HOME>/tools/git-lfs/current`를 `pathPrepend`에 한 번 더한다(`RemoteModel.validatePathPrepend`와 `controller.updateHost`를 거침). 담당 셸의 `git`과 pre-push 훅이 묶은 git-lfs를 찾게 하기 위해서다(06 §4.13). 서비스 env가 바뀌므로 그 호스트는 다음 서비스 시작까지 "설정 대기"다(6.4). own-team 자신의 git 실행은 기다리지 않고 바로 그 폴더를 PATH 앞에 둔다.

### 5.7 버전과 skew 정책

- **두 가지 조건을 나눈다.**
  - **own-web 라이브 연결**: 원격에서 실행 중인 버전 = 로컬에 설치된 버전(`app\current.json`, 예: `2.0.18-own.3`), 그리고 원격 빌드 id = 로컬 빌드 id. upstream도 정확한 일치를 요구한다(`bootstrap.ts:86-93`). 이유: own-web은 로컬 버전의 `@opencode/client`로 원격 API를 부른다. v2 API는 experimental이라(01 §18) 버전이 다르면 조용히 깨질 수 있다.
  - **브로커**: 빌드가 아니라 브로커 프로토콜 번호 `proto`(정수)로 판단한다. `proto`는 `hello`·`headers.get`·`observe.push`·`agent.broker.arm`의 모양과 미러 `schemaVersion`을 묶은 번호이고, 이 중 하나가 호환되지 않게 바뀔 때만 올린다. 로컬은 자기 `proto`와 **직전 `proto`** 를 받는다(직전 판용 어댑터를 한 릴리스 동안 둔다). `@own/protocol`의 스냅샷 테스트가 `proto`를 올리지 않은 채 모양만 바뀌는 것을 잡는다.
- **drain 모드.** 빌드는 다르지만 `proto`가 호환되는 원격은 브로커가 "drain 모드"로 받는다.
  - 제공: `headers.get`, `observe.push`, `ping`, 그리고 L→R `revoke`·`account.status`. 실행 중인 원격 턴이 lease를 계속 받아 **스스로 끝날 수 있게** 하는 최소 집합이다.
  - 제공하지 않음: `registry.get`(원격은 디스크의 마지막 미러를 그대로 쓴다), `mirror.changed`, `quota.updated`, `calibration.updated`. 그 사이 계정이 삭제되거나 막히면 `revoke`·`account.status`로 알린다.
  - 기간: 호스트가 `incompatible`인 동안, 최대 `skewDrainHours`(기본 24시간, 로컬이 새 버전으로 처음 뜬 시각부터). 넘으면 `skew`로 거절한다.
  - `observe.push` 항목은 항목마다 `schemaVersion`을 싣는다. 로컬이 읽을 수 있는 판이면 받고, 아니면 ack하지 않아 원격 spool에 남긴다. 원격을 업데이트하면 새 빌드가 옛 spool 줄을 읽어 다시 보낸다(spool 형식은 추가만 허용).
  - `proto`가 호환되지 않으면 곧바로 `skew`다. 이때 로컬 업데이트 흐름(01 §5.5 install.ps1, 앱 안 업데이트)은 **먼저** 연결된 호스트의 실행 중 세션(`GET /api/session/active`)을 확인하고, 있으면 "원격 턴이 끝난 뒤 업데이트 / 지금 업데이트(원격 턴은 lease가 끝나면 멈춤) / 취소"를 묻는다. 6.5 종료 대화상자와 같은 방식이다.
- **상태 구분**(이전 앱 77·82 교훈): `local`, `remoteRunning`, `remoteStaged[]`를 따로 보여 준다. "로컬을 업데이트했다"가 "원격이 업데이트됐다"는 뜻이 아니다.
- **자동 확인은 켜고 자동 적용은 끈다.** 연결할 때마다 비교하고, 다르면 `incompatible` + "업데이트 필요"로 둔다. 적용은 사용자가 `update.plan → execute`로 한다(6.4).
- **incompatible일 때 할 수 있는 것**: catalog 보기(12.3), 원격 `GET /api/session/active` 조회(drain 판정용, own-remote가 자기 HTTP client로 부름), 업데이트, drain·중지. own-web의 라이브 연결(세션 열기·프롬프트)은 막는다.
- 로컬을 새 버전으로 바꾸면(01 §5.5 install.ps1) 모든 호스트가 `incompatible`이 된다. 원격에서 돌던 턴은 drain 모드의 브로커로 계속 인증을 받아 끝까지 간다. 업데이트 번들은 로컬 `app\<new>\remote\`에 이미 있으므로, 원격에 미리 **스테이징만** 해 둘 수 있다(실행 중 서비스를 건드리지 않음). 적용은 drain 뒤다. 그래서 `update.execute{drain:"wait"}`는 인증 실패로 턴이 죽기를 기다리는 것이 아니라 턴이 정상으로 끝나기를 기다린다(RG11).

### 5.8 upstream 설치본과 공존

- 채널 `own`이라 등록 파일(`service-own.json`), 포트, DB(`opencode-own.db`)가 upstream과 분리된다(01 §5.2, `service-config.ts:29-38`, `packages/cli/src/database-path.ts:4-12`).
- upstream discover 스크립트는 `command -v opencode`를 먼저 보고(`cli.ts:26-40`), `service*.json`을 모두 읽는다(`bootstrap.ts:8-17`). 우리 inspect는 둘 다 하지 않는다. 그래서 원격의 upstream `opencode`가 "버전 차이"로 잘못 잡히지 않는다.
- data/state 루트(`~/.local/share/opencode`, `~/.local/state/opencode`)는 upstream과 공유된다. 로그가 섞일 수 있다(01 §18 리스크 7과 같음).
- 원격에 upstream `opencode`가 있으면 호스트 상태 패널에 "upstream opencode 감지(건드리지 않음)"만 보인다.

---

## 6. 원격 서비스 수명주기

### 6.1 ensure (시작)

ensure는 **터널 세션 안에서** 돈다(7.1). 원격 명령은 `sh -s`이고, own-remote가 stdin으로 ensure 본문과 그 뒤의 keep 부분(7.4)을 한 번에 쓴 다음 stdin을 열어 둔 채 더 쓰지 않는다. 원격 명령 문자열이 `sh -s` 하나뿐이라 사용자의 로그인 셸이 fish·zsh여도 따옴표 해석 차이가 없다. ensure 본문에는 비밀이 없다(브로커 키는 arm으로 따로 간다, 8.3). 순서:
1. **host identity 확인.** 스크립트에 들어 있는 기대 identity와 다르면 **아무것도 쓰지 않고** `host_identity_changed`를 보고하고 끝낸다. 재연결은 inspect 없이 오므로 여기서 먼저 막는다.
2. `run/owner.json`이 다른 로컬 installId면 멈추고 `other_owner`를 보고한다(6.8).
3. `ops/`에 끝나지 않은 작업이 있으면 멈추고 `ops_pending`을 보고한다(6.4 복구가 먼저). 단, 그 작업 자신이 부른 ensure(스크립트에 같은 `opId`가 들어 있음, 6.4 7번)는 계속한다.
4. 5.6의 두 서비스 설정 파일과 managed config를 고친다(내용이 같으면 쓰지 않음). 서비스 설정의 `hostname`이 loopback이 아니면 멈춘다(`service_not_loopback`).
5. **브로커 epoch 기록.** `run/`(0700)이 있는지 보고, `run/broker.current`를 이번 epoch로 temp→rename한다. 기존 값이 이번 epoch보다 크면 쓰지 않고 `stale_epoch`(기존 값 포함)로 끝낸다. own-remote는 그 값보다 큰 epoch로 한 번 다시 한다(로컬 시계가 크게 뒤로 간 경우). 이번 epoch보다 작은 `broker-<e>.sock` 잔재는 지운다. **이번 epoch의 소켓은 절대 지우지 않는다.** 이 세션의 `-R`이 이미 그 경로에 묶여 있기 때문이다.
6. **실행 중 판정.** 등록 파일(`service-own.json`)을 읽고 다음 셋을 모두 만족할 때만 "실행 중"이다: pid가 살아 있음, `/proc/<pid>/exe`가 우리 `app/<ver>/opencode`, 버전 필드가 그 `<ver>`. 세 번째 조건 `/api/info` 응답은 터널이 선 뒤 own-remote가 확인한다(8번).
   - 실행 중이고 버전이 같으면 → 그대로 쓴다.
   - 실행 중인데 버전이 다르면 → **`service start`를 부르지 않는다.** `version_skew`를 보고한다. 터널은 유지한다(drain 판정과 브로커 drain 모드에 필요, 5.7). upstream `Service.ensure`는 버전이 다른 서비스를 멈추고 새로 띄우기 때문이다(`service.ts:106-113`). 이 경로로 가면 원격 턴이 drain 없이 죽는다.
   - 등록 파일이 없거나 **낡았으면**(pid가 죽었거나, pid가 다른 실행 파일로 재사용됨) → 등록 파일을 `.stale`로 옮기고 기동한다. 낡은 등록을 `version_skew`로 보고하지 않는다. upstream `service start`는 응답 없는 등록 서비스를 probe 시간 초과 3회 뒤 종료시키므로(`client/effect/service.ts:80-90`), 재사용된 pid가 엉뚱하게 죽지 않도록 등록을 먼저 치운다.
   - **기동**: `"$SHELL" -lc 'exec /bin/sh <APP>/libexec/start.sh'`(호스트 설정 `shellEnv`가 `login-interactive`면 `-lic`, `sh`면 `/bin/sh -l`). 로그인 셸이 프로필(과 대화형이면 `.bashrc`)을 읽어 env를 만들고, 우리 `start.sh`가 provider 키 env를 지우고(5.6) 호스트 `env`·`pathPrepend`·`TMPDIR`을 적용한 뒤 `exec <APP>/opencode service start`한다. stdin은 `/dev/null`이다. 기동 자체에는 `timeout`을 걸지 않는다(서비스 기동을 도중에 죽일 수 있으므로). 대신 대화형 모드는 inspect가 `timeout`을 걸고 시험해 멈추지 않은 호스트에서만 고를 수 있다(5.4). 그래서 에이전트 셸 도구(`$SHELL -c`, 서비스 env 상속)가 보는 PATH가 사용자가 고른 셸 모드의 PATH와 같다. 서비스는 detached contender로 떠서 SSH 세션보다 오래 산다(`service-contender.ts:17-22,41`). 단, logind `KillUserProcesses=yes`이고 linger가 꺼진 호스트에서는 SSH 세션이 끝날 때 함께 죽는다(6.2).
7. 등록 파일을 upstream 표식(`OPENCODE_SSH_STATUS=`, `…REGISTRATION_BEGIN/END`, `bootstrap.ts:8-17`)과 같은 형식으로 stdout에 **한 번** 출력하고, `OWN_ENSURE=ready|version_skew|…` 줄로 끝낸다. own-remote는 비밀번호를 메모리에만 두고, 오류 문구에서는 upstream `commandFailureDetail`처럼 이 블록을 지운다(`command.ts:208-215`). 등록 URL의 호스트는 `127.0.0.1`과 `[::1]`만 받는다. upstream `connectionAddress`는 `0.0.0.0`과 `[::]`도 받지만(`bootstrap.ts:59-68`), 그것은 LAN에 열린 서비스라는 뜻이므로 `service_not_loopback`으로 멈춘다(1.2).
8. own-remote는 ensure 결과를 받은 뒤 `-L`로 `GET /api/info`를 100ms 간격으로 부른다(7.3). 등록 pid는 살아 있는데 30초 안에 응답이 없으면 **hung**으로 보고 `service_unresponsive`로 멈춘다. 자동으로 죽이지 않고 `recover.plan → execute`(16.2)로 사용자 확인을 받아 SIGTERM → 5초 → SIGKILL → 다시 ensure 한다.
9. **스모크 테스트.** 첫 연결과 셸 모드·env 설정을 바꾼 뒤에는 `agent.probe`(16.2)로 원격 service 프로세스에서 에이전트 셸 도구와 **같은 spawn 경로**(`ShellSelect.args`)로 `command -v git node python3 rg`와 `echo $PATH`를 실행해 보인다. SSH 접속과 목록 조회가 된다고 정상으로 보지 않는다([old] `docs/operations/ssh-host-onboarding.md:51`).

### 6.2 살아 있게 두기, 끊김 ≠ 중지

- 원격 service에는 idle timeout이 없다(`server-process.ts:165-169`). 등록 파일이 다른 서비스로 바뀌면 5초 안에 스스로 내려간다(`service-registration.ts:39-66`).
- **SSH가 끊겨도 원격 service는 계속 돈다.** 터널이 끊기면 own-remote는 로컬 ssh 프로세스만 정리한다(upstream도 같다, `controller.ts:92-97`, 문구 "Disconnected. The remote server is left running.", `packages/app/src/runtime/i18n/en.ts:29`).
  - **예외: logind `KillUserProcesses=yes`이고 linger가 꺼진 호스트.** ensure가 띄운 서비스는 그 SSH 세션의 scope에 들어가므로 세션이 끝날 때 함께 죽는다. 기본 Ubuntu·Debian은 `no`지만 배포판과 관리자 설정에 따라 다르다 ⚠(RG3). inspect가 `KILL_USER_PROCESSES`와 `LINGER`를 보고하면, 이 조합일 때 호스트 패널에 "SSH가 끊기면 원격 작업도 멈춥니다. 계속 돌게 하려면 관리자가 linger를 켜야 합니다"를 보이고, 연결은 허용한다. `systemd-run --user`는 linger 없이는 사용자 매니저가 함께 내려가므로 해법이 아니다.
- 원격 턴은 lease가 남은 동안 계속 모델을 부른다. lease가 끝나면 fail closed다(8.7).
- **idle 자동 중지는 두지 않는다**(R1–R3). 떠 있는 서비스의 비용은 작고, 빠른 재연결과 끊김 중 작업 지속이 더 중요하다. 필요하면 호스트 메뉴의 "현재 턴이 끝나면 중지"를 쓴다.
- 원격 재부팅 뒤 자동 기동(`systemd --user` + linger)은 R3 선택 기능이다. linger 활성화는 root가 필요하므로 사용자가 결정한다 ⚠.

### 6.3 연결 상태 머신과 재연결

- **스테이지**: upstream(`packages/app/src/servers/ssh/types.ts:9-20`)을 기준으로 다운로드를 빼고 own 전용을 더한다.
  `disconnected | connecting | authentication | checking | needs_install | uploading | starting | ready | incompatible | updating | draining | failed`, 그리고 `paused: boolean`.
- **오류 코드**: `input | ssh_missing | connection | auth | host_key | host_identity_changed | forwarding_disabled | forward_conflict | loopback_unavailable | platform_unsupported | noexec | disk_full | install_failed | service_failed | service_not_loopback | service_unresponsive | version_skew | other_owner | ops_pending | broker_failed`. `host_key`의 `detail`은 `unknown`(처음 보는 키) 또는 `changed`(바뀐 키)다.
- **pause 규칙**(자동 재시도 멈춤, upstream `controller.ts:208-222`를 따름): `input`, `ssh_missing`, `host_key`, `platform_unsupported`, `version_skew`, `other_owner`, `host_identity_changed`, `forwarding_disabled`, `loopback_unavailable`, `service_not_loopback`, `service_unresponsive`, ssh 자체 실패(종료 코드 255)의 메시지에 `Permission denied`, 또는 연속 5회 실패. pause된 호스트는 사용자가 [다시 연결]을 눌러야 움직인다.
  - **예외(2026-11-21, own.15): 살아 있던 터널이 스스로 끝난 뒤 10분 동안(`Liveness.DROP_RETRY_MS`)은 `connection` 실패가 5회를 넘어도 pause하지 않고 백오프 상한(30초)으로 계속 시도한다.** 죽은 링크를 12초 안에 알아채게 되면서 5회가 금방 차기 때문이다: 공유기 재시작, 지하철, 깨어난 뒤 와이파이가 붙기까지처럼 1-2분 네트워크가 없는 동안 호스트가 멈춰 버리면 안 된다. 10분이 지나면 원래대로 다음 실패에서 pause한다. `connection`이 아닌 실패(인증, 호스트 키 등)는 원래대로다.
  - 터널 시작(ensure) 실패는 `Failure.classifyStart`(`packages/own-remote/src/ssh/failure.ts`)가 나눈다. ssh가 255로 끝났을 때만 `host_key`·`auth`·`forwarding_disabled`·`loopback_unavailable` 문구를 본다. 원격 ensure 스크립트가 다른 코드로 끝나면(예: `mkdir: … Permission denied`로 1) pause하지 않는 `service_failed`이고, 시간 초과·중단·실행 실패는 pause하지 않는 `connection`이다. 둘 다 정리한 stderr 마지막 줄을 붙인다(2026-10-05, P2-27).
- **호스트 키 정책**(14.2): 호스트 추가 흐름과 호스트 메뉴의 `호스트 키 확인…`에서만 처음 보는 키를 UI에서 신뢰할 수 있다(`connect{hostKeyPrompt:true}`). 그 밖의 모든 연결(배경 재연결, 다시 연결, 업데이트·drain 작업)은 `-o StrictHostKeyChecking=yes`를 붙인다. 명령행 `-o`가 config 파일보다 먼저 적용되므로 사용자 config가 `ask`·`accept-new`·`no`여도 이 연결들은 모르는 키에서 멈추고 `host_key`(`unknown`)로 pause한다([old] `scripts/manager_core/remote.py:175-177`이 모든 SSH 명령에 쓴 정책과 같다).
- **백오프**: 1, 2, 5, 10, 30초(상한).
- **죽은 링크(2026-11-21, own.15, decisions DL).** 와이파이 바꾸기, PC 절전, 공유기·LTE 끊김은 FIN도 RST도 보내지 않는다. 그동안 터널의 ssh와 `-L` 안의 모든 연결(이벤트 스트림, 브라우저 칸의 터널, own-remote 자신의 호출)은 살아 있는 것처럼 보이고 아무것도 오지 않는다.
  - **첫째: ssh의 keepalive.** 터널만 `ServerAliveInterval=4`, `ServerAliveCountMax=2`를 sshArgs의 upstream 값(15초×3)보다 앞에 붙인다(ssh는 처음 얻은 값을 쓴다; 짧은 명령은 15초×3 그대로라 느린 링크의 업로드·설치가 잘리지 않는다). ssh는 서버에서 아무것도 받지 못한 채 4초가 지나면 묻고, 답 없는 질문이 2개인 채 다음 검사에 이르면 255로 끝난다(`Timeout, server … not responding.`). 그래서 완전히 조용한 링크는 **마지막으로 받은 바이트 뒤 12초**(`Liveness.SILENT_LIMIT_MS`)에 끝난다. 받은 바이트가 하나라도 있으면 시계가 다시 시작되므로 큰 전송이나 긴 모델 답이 이것을 굶기지 못하고, 올리는 쪽도 서버가 보내는 채널 window 조정만으로 충분하다. 실제 Win32-OpenSSH 9.5와 build-host 사이에 조용해지는 중계(ProxyCommand)를 두고 잰 값: 15초×3은 54.4·54.8초(own.14의 RG4 실측 59.5초), 4초×2는 11.5·11.7초. 살아 있지만 느린 링크: 왕복 6초의 빈 링크 90초, 16 KB/s와 4 KB/s 내려받기 90초, 16 KB/s 올리기 90초(왕복 1초 포함) 모두 끊기지 않았다. 한계: 12 KB/s(약 100 kbit/s) 이하로 계속 올리면 서버의 window 조정이 드물어져 끊길 수 있다(12 KB/s는 73초, 8 KB/s는 13초에 끊김; 15초×3은 4 KB/s도 견딤).
  - **우리 요청으로 살아 있음을 재지 않는 이유.** `-L` 안으로 보내는 heartbeat(`/api/info`나 keep 부분의 stdout 줄)는 같은 TCP 스트림에서 큰 전송 뒤에 줄을 선다. 느린 링크에서 서버 송신 버퍼(수 MB) 뒤에 선 답은 수십 초 늦을 수 있어, 10-15초 판정은 살아 있는 링크를 끊는다. "받은 바이트가 있었나"는 ssh만 안다.
  - **둘째: 깨어난 뒤 바로 확인.** 컨트롤러는 2초마다 시계를 본다(`Liveness.TICK_MS`). 한 틱이 예정보다 8초 넘게 늦으면 이 프로세스가 멈춰 있었던 것(절전, 최대 절전)이므로(`clock_gap`) 살아 있는 터널마다 `/api/info`를 4초 동안 묻고(`Liveness.reachable`, 401도 답으로 친다), 아무 답이 없으면 그 ssh를 끝내 보통의 재연결로 넘긴다(`link_silent`). 재시도를 기다리던 호스트는 바로 다시 시도하고 10분 창을 새로 받는다. 바쁜 이벤트 루프가 틱을 몇 초 늦게 돌린 것은 깨어남으로 치지 않고, 잘못 친 경우의 비용은 답이 오는 질문 하나다. Electron의 `powerMonitor`는 쓰지 않았다: 터널은 서비스 프로세스에 있고, 시계 틈이면 앱 없이도(트레이, 휴대폰만 쓸 때) 된다.
  - 끝난 뒤는 원래 흐름이다: `#onTunnelExit`가 `disconnected`와 백오프 재연결을 잡고(own-remote 로그 `tunnel_ended`, `cause: silent|closed`), 원격 서비스와 진행 중인 턴은 그대로 돈다(6.2). 화면은 대화 위에 `원격 대화는 호스트에 그대로 있어요. 다시 연결하는 중…`, 브라우저 칸에 `SSH 연결이 끊겼어요`(05 §8.6), 사이드바 호스트 줄에 `연결 끊김`·`연결 중…`이다.
  - **메시지와 이벤트.** 조용한 동안 보낸 프롬프트는 호스트에 닿지 않는다(링크가 아무것도 나르지 않음). ssh가 끝나면 그 요청이 실패하고, 낙관적으로 넣은 줄은 빠지며 글은 입력 칸으로 돌아온다(upstream data 계층, own-web composer). 다시 보내면 한 번만 들어간다. 요청이 호스트에 닿았는데 답만 잃었다면 그 메시지는 재연결 뒤의 재동기화(`server.connected`)로 화면에 오고 입력 칸에도 글이 남는다: 그때 다시 보내면 새 ID라 두 번이 된다(드문 경우, 지금은 막지 않음). 조용한 동안 호스트가 쓴 답은 재동기화로 한 번 보인다. own-web 원격 e2e(`e2e/remote/remote.pw.ts` "a silent link")가 이것을 확인한다.
  - **휴대폰 ↔ PC 게이트웨이 길**도 같은 문제가 있지만 바꾸지 않았다. 그 길의 이벤트 스트림은 upstream 클라이언트의 45초 idle watchdog(서버 heartbeat 15초), 화면으로 돌아왔을 때 20초 넘게 조용했으면 재동기화, `online` 이벤트로 이미 다시 붙는다. 더 빨리 알려면 몇 초마다 바이트가 오가야 해서 휴대폰의 LTE 무선을 계속 깨워 둔다(배터리). 휴대폰이 보는 SSH 호스트 대화는 PC 쪽 터널이 12초 안에 끝나므로 게이트웨이가 503 `host_unavailable`을 준다.
- **배경 시도에서 인증 프롬프트가 뜨면** 그 호스트를 pause하고 스테이지를 `authentication`으로 둔다. 사용자가 누를 때까지 묻지 않는다(upstream `controller.ts:103-107`). 노트북이 깨어날 때 프롬프트가 연달아 뜨는 것을 막는다.
- **대화형 시도의 소유자**는 own-web 클라이언트(웹 폴백의 탭, 데스크톱의 창)의 `clientId`다. 다른 탭·창은 "다른 창에서 인증 중"을 본다(upstream `controller.ts:58-68`).
  - `clientId`는 그 탭·창의 `sessionStorage`에 둔다. 새로 고침(F5) 뒤에도 같은 탭·창은 같은 소유자이고, 사용자가 자기 프롬프트에서 "다른 창에서 인증 중"을 보지 않는다. upstream의 소유자는 새로 고침에도 유지되는 webContents id다. 데스크톱 렌더러의 `sessionStorage`가 창마다 따로이고 새로 고침 뒤에도 남는지는 ⚠(RG13).
  - 휴대폰(M1+)은 프롬프트에 답할 수 없다(`respond`는 `local` 범위, 16.7). 휴대폰이 부른 배경 재연결이 프롬프트를 만나면 pause되고 PC에서 답해야 한다.
  - 탭이 닫힌 것은 heartbeat로 안다. 소유한 시도가 있는 동안 own-web은 10초마다 `own.remote.heartbeat{clientId}`를 보낸다. 30초 동안 오지 않으면 소유를 풀고 대기 중 프롬프트를 취소하며 호스트를 pause한다. heartbeat가 없어도 프롬프트는 5분 뒤 시간 초과로 끝난다(`askpass.ts:59`).
- **재연결은 "재동기화"이지 재시작이 아니다.** 원격 `/api/event`는 휘발성이다(연결당 4096 프레임, `packages/server/src/event-feed.ts:8`). own-web은 `server.connected`마다 01 §6의 재동기화 목록을 원격 서버에 다시 부른다.
- **시작 시**: 저장된 호스트는 pause 상태로 올라오고, `autoConnect:true`인 호스트만 배경에서 한 번 시도한다. upstream은 `autoConnect` 같은 설정 없이 저장된 호스트 중 끊긴 것을 **모두** 배경에서 시작한다(`packages/app/src/servers/ssh/restore-state.ts:9-16`). 우리는 인증 프롬프트와 원격 기동 비용을 호스트마다 고를 수 있게 이 플래그를 더한다. 로컬 세션 화면은 SSH를 기다리지 않는다(local-first, [old] `docs/design/local-first-profile-startup-56.md:8`).
- **호스트 격리**: 호스트마다 독립 fiber이고 전역 락이 없다. 한 호스트의 설치·업데이트·인증 대기가 다른 호스트를 막지 않는다([old] `docs/design/ssh-reconnect-82.md` 한 호스트 실패가 프로필 전체 게이트를 잡음).

### 6.4 원격 업데이트 (drain 포함)

`own.remote.update.plan{hostId}` → 확인 대화상자 → `update.execute{nonce, drain}`.

1. **plan**(부작용 없음): `from`, `to`, 원격 실행 중 세션(`GET /api/session/active`), 백업 크기, 필요 공간, 스테이징 여부, 1회용 nonce(2분, 02 §9.2 규칙).
2. **stage**: 새 번들 업로드(5.5). 실행 중 서비스와 무관하므로 즉시 해도 된다.
3. **drain**: `drain:"wait"`(기본)이면 active가 0이 될 때까지 기다린다. 상한은 30분이고 UI에 진행을 보인다. 상한에 닿으면 다시 묻는다(계속 기다리기 / 지금 중지 / 취소). `drain:"now"`는 실행 중 턴을 끊는다는 경고 뒤에만 허용한다.
   - 기다리는 동안 새 프롬프트가 들어오면 다시 active가 된다. UI는 그 호스트의 composer에 "업데이트 대기 중 — 보내면 업데이트가 미뤄집니다"를 보인다.
4. **작업 저널**: 원격 `ops/<opId>.json`에 `{opId, kind:"update", from, to, steps:[…], startedAt}`를 쓰고 단계마다 갱신한다. 로컬에도 `OWN_HOME\remote\<hostId>\ops.jsonl`에 같은 opId로 적는다.
5. **stop**: `app/<from>/opencode service stop`. Linux에서는 SIGTERM 뒤 약 5초에 SIGKILL이다(`service.ts:146-154`, 01 §5.6과 달리 finalizer가 돌 수 있다).
6. **백업**: 서비스가 멈춘 상태에서 `opencode-own.db`(+`-wal`, `-shm`)를 `backup/`에 복사한다. 원격 DB가 원격 세션의 원본이기 때문이다([old] MIGRATION: 원본이 원격 디스크에만 있었음).
7. **전환**: `app/current` symlink 교체 → 5.6 파일 갱신 → 터널을 새 epoch로 다시 세움(그 안의 ensure가 새 버전을 띄움, 6.1) → `GET /api/info`·원격 `health` 확인 → arm(8.3) → `agent.probe`.
8. **롤백**: 7이 실패하면 symlink와 DB를 되돌리고 `from`으로 다시 띄운다.
9. **GC**: 성공하면 `current`와 직전 버전만 남기고 나머지 버전 디렉터리를 지운다(upstream은 지우지 않는다, `bootstrap.ts:55-57`).
10. **도구 따라가기**(2026-10-31, LFS-3): 호스트에 이미 있는 묶음 도구(`<OWN_HOME>/tools/git-lfs/current`)가 새 릴리스의 고정 버전과 다르면 같은 작업 잠금 안에서 `hosts.tools.ensure`와 같은 방법으로 새 버전을 올리고 `current`를 옮긴다(살피기 한 세션, 올리기 한 세션). 도구 스크립트의 살피기가 `OWN_TOOL_CURRENT`로 지금 버전을 알려 준다. 도구가 없던 호스트에는 올리지 않고, 실패하면 옛 버전을 그대로 두고 로그(`tool_refresh_failed`)만 남긴다(업데이트 자체는 끝났다). 로컬 저널에는 `{kind:"tools", refresh:true, from, version, outcome}`이 남는다. own-team이 쓴 LFS 필터와 서비스 PATH는 `current`를 가리키므로 그대로 새 버전을 쓴다. 옛 버전 폴더는 남는다.
- **끊긴 응답은 재생하지 않는다**([old] 79). SSH가 중간에 끊기면 다시 연결했을 때 inspect의 `OPS_PENDING`과 저널 단계를 보고 **이어서 하거나 되돌린다**. "stop을 보냈는데 응답을 못 받았다"를 이유로 stop을 다시 보내지 않는다. 소켓이나 포트가 없다는 것도 종료의 증거로 쓰지 않고, 등록 파일의 pid와 `/proc/<pid>/exe`로 확인한다([old] 89 exact process).
- **설정 변경 ≠ 업데이트**([old] 77·87). managed config만 바뀐 경우(예: 권한 기본값)는 "설정 대기(재시작 필요)"로 표시하고, 다음 drain·업데이트 때 함께 적용한다. 설정 때문에 연결을 막지 않는다.

### 6.5 로컬 종료와 drain

- **기본: 원격은 그대로 둔다.** `own stop`/`own restart`/창 닫기는 원격 service를 멈추지 않는다.
- 로컬을 멈출 때 연결된 호스트에 실행 중 세션이 있으면 launcher와 UI가 묻는다.
  - `원격은 그대로 두기`(기본): "로컬이 꺼져 있는 동안 원격 에이전트는 lease가 끝날 때까지(최대 15분, 호스트 설정) 모델을 부를 수 있고, 그 뒤에는 멈춥니다."
  - `원격도 현재 턴이 끝나면 중지`: 호스트마다 drain 작업(6.4의 3·5단계만)을 돌리고, 로컬은 끝날 때까지 기다린다(상한 15분, 진행 표시). 상한에 닿으면 다시 묻는다.
  - `지금 원격 중지`: 실행 중 턴이 끊긴다는 경고 뒤 stop만.
- 호스트 메뉴에도 `현재 턴이 끝나면 중지`가 있다([old] 89 "SSH 작업 종료 후 설정 적용").
- 로컬을 멈추는 동안 원격에 가는 요청은 없다. 브로커가 사라지면 원격은 lease 만료 후 fail closed로 스스로 멈춘다.

### 6.6 크래시와 재부팅

- **로컬 재부팅**: 터널과 브로커가 사라진다. 원격은 6.5 기본과 같다. 로컬이 다시 뜨면 `autoConnect` 호스트가 배경에서 재연결한다.
- **원격 재부팅·크래시**: 원격 service가 없다. 다음 연결의 ensure가 다시 띄운다. 진행 중이던 턴은 upstream의 write-ahead claim으로 재개되고(`packages/server/src/process.ts:237-239`, 01 §5.6) provider 요청이 다시 나간다. UI는 그 세션에 `재개됨` 표시를 붙인다. SSH 끊김만으로는 원격이 재시작되지 않으므로 끊김이 요청 재전송을 일으키지는 않는다.
- **원격 DB 손상**: SQLite WAL이라 부분 쓰기에 강하다. 복구는 `backup/`과 6.4의 백업 규칙에 기댄다. JSONL 끝줄이 잘리는 이전 앱의 문제([old] `docs/operations/ssh-crash-history-recovery.md`)는 구조상 생기지 않는다.
- **spool 손상**: 마지막 줄이 잘렸으면 그 줄만 버린다(10.2).

### 6.7 호스트 제거(forget)

`own.remote.forget.plan{hostId, uninstall}` → `execute{nonce}`.
- 기본(`uninstall:false`): 로컬 레지스트리, catalog, ops 기록, 브로커 키를 지운다. 원격은 건드리지 않는다.
- `uninstall:true`: drain(6.4의 3단계) → stop → (T3) own.team이 적어 둔 저장소(`<OWN_HOME>/tools/git-lfs/repos`)마다 `filter.lfs.*`를 켜기 전 값으로 되돌림(`own_lfs_restore`, 지운 도구를 가리키는 필터가 남지 않게) → 원격 `app/`, `run/`, `tmp/`, `spool/`, (T3) `tools/`, 미러, 짧은 소켓 디렉터리(7.4) 삭제. **원격 DB와 `backup/`은 지우지 않는다**(세션 원본). 지우려면 사용자가 직접 하게 경로를 보여 준다.
  - **T3 주의**: `tools/`를 지우면 원격 팀이 저장소 local 설정에 쓴 git-lfs 필터(`required=true`, `tools/git-lfs/current`를 가리킴)가 그 저장소에 남아 그 저장소의 checkout·commit이 필터 오류로 멈춘다. 팀 끄기·빼기가 그 설정을 지우거나 `forget.plan`이 알리는 것은 아직 없다(06 §11.1 남은 일).
- 두 경우 모두: 이 호스트에 lease가 나갔던 계정 목록(`OWN_HOME\remote\<hostId>\leases.json`)을 보여 주고 "이 호스트를 더 믿지 않는다면 이 API 키들을 교체하세요"를 안내한다(15장).

### 6.8 다른 PC가 관리하는 설치

- `run/owner.json {installId, hostId, label}`의 installId는 로컬 OWN_HOME마다 한 번 만드는 난수다.
- 다른 installId가 있으면 `other_owner`로 멈춘다. 두 로컬이 같은 원격 service에 브로커를 번갈아 붙이면 arm이 서로를 덮고, 레지스트리 미러가 서로 다른 계정 목록으로 바뀌기 때문이다.
- 사용자가 [이 PC로 가져오기]를 누르면 owner를 바꾼다(다른 PC는 다음 연결에서 `other_owner`를 본다). 여러 PC의 공동 관리는 비목표다(1.2).

---

## 7. 터널

### 7.1 호스트당 ssh 프로세스 구성

| 단계 | 명령 | 수명 | 인증 |
|---|---|---|---|
| inspect | `ssh … -o ClearAllForwardings=yes <alias> "sh -s"` | 짧음 | 1회(첫 연결·설치 전·진단 때만) |
| install | `ssh … -o ClearAllForwardings=yes <alias> "sh -c '<install>'"` + tar stdin | 짧음 | 1회(설치할 때만) |
| 터널 + ensure | `ssh … -o ExitOnForwardFailure=yes -L 127.0.<k>.2:LP:127.0.0.1:RP -R <원격 끝점>:127.0.0.1:B_h <alias> "sh -s"` + stdin(ensure 본문 → keep) | 장수 | 1회 |
| 업데이트·drain의 stop 등 | `ssh … -o ClearAllForwardings=yes <alias> "sh -s"` | 짧음 | 1회(그 작업 때만) |
| realpath 등 보조 | 없음. 원격 own-remote(agent) RPC로 한다(12.4) | – | – |

- Windows OpenSSH에는 ControlMaster가 없으므로(upstream도 Windows에서는 쓰지 않는다, `controller.ts:90-97`) 따로 도는 ssh마다 인증한다. 그래서 ensure를 터널 세션 안에 넣는다. RP는 첫 설치 때 고정되고(5.6) `hosts.json`에 있으므로 `-L`을 ensure 전에 세울 수 있다. 첫 연결은 최대 3회(inspect, install, 터널), **재연결은 1회**다.
- 터널 세션의 순서: 인증 → `-L`·`-R` 수립(`ExitOnForwardFailure=yes`) → 원격 `sh -s`가 ensure 본문 실행(6.1)과 결과 출력 → keep(7.4). ensure 출력은 stdout으로 오고, own-remote는 `OWN_ENSURE=` 줄을 받은 뒤 `/api/info`를 부른다. ensure가 보고한 RP가 저장값과 다르면(사용자가 설정을 바꿈 등) 그때만 새 RP로 터널을 다시 세운다.
- `-R` 수립이 실패하면 곧바로 TCP 대체로 넘어가지 않는다. inspect로 원인(OWN_HOME이 없음, host identity 변경, 소켓 경로 길이, `AllowStreamLocalForwarding`)을 먼저 본다(7.4).
- 키가 암호 없는 파일이거나 ssh-agent가 키를 들고 있으면 프롬프트가 없다. 이 PC는 ssh-agent 서비스가 꺼져 있지만, 이전 앱이 `BatchMode=yes`로 lab·work_linux·build-host에 붙었으므로 그 세 호스트의 키는 프롬프트 없이 쓰인다(14.3).

### 7.2 공통 옵션

- upstream `sshArgs`(`command.ts:115-132`): `-T`, `ConnectTimeout=10`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`, `RemoteCommand=none`, `RequestTTY=no`, `PermitLocalCommand=no`. 터널은 그 앞에 `ServerAliveInterval=4`, `ServerAliveCountMax=2`를 붙인다(6.3 "죽은 링크", own.15).
- 우리가 더하는 것
  - 모든 ssh 명령(짧은 명령, `-G`, 터널)에 `ForwardAgent=no`, `ForwardX11=no`(SEC-2). 사용자 config의 `ForwardAgent yes`는 흔하다. 그대로 두면 터널 세션에서 시작한 원격 서비스가 `SSH_AUTH_SOCK`을 물려받고, 원격 에이전트 셸이 사용자의 키로 다른 서버(GitHub 등)에 인증할 수 있다. 명령행 값이 config 값보다 앞선다. 두 값을 `yes`로 둔 config로 `ssh -G`를 돌려 확인한다(`test/unit/ssh-args.test.ts`). target 파서는 `-o forwardagent`, `-o forwardx11`, `-X`, `-Y`를 받지 않는다. 다만 upstream 문법인 `-A`는 받고, `-A`는 명령행의 `ForwardAgent=no`보다 앞선다. 그래서 target 줄에 직접 적은 `-A`는 그 호스트에 대한 사용자의 켜기로 남는다.
  - 짧은 명령에만 `ClearAllForwardings=yes`. 사용자 config의 `LocalForward`(예: `lab-7676`)가 짧은 명령마다 포트를 잡으려다 실패하는 것을 막는다([old] `remote.py:175-177`도 inspect에 썼다). 터널에는 쓰지 않는다. 이 옵션은 명령행의 `-L/-R`까지 지우기 때문이다.
  - `StrictHostKeyChecking`: 호스트 추가 흐름과 `호스트 키 확인…`에서만 사용자 config 값을 따른다. 값이 없으면 OpenSSH 기본값(`ask`)이고, 처음 보는 키는 askpass로 지문을 보여 준다(14.2). 그 밖의 모든 연결에는 `StrictHostKeyChecking=yes`를 붙인다(6.3). `no`나 `accept-new`를 우리가 강제하지 않는다.
  - **느슨한 호스트 키 설정 경고.** 사용자 config의 그 호스트 값이 `StrictHostKeyChecking no`이거나 `UserKnownHostsFile /dev/null`이면 호스트 추가 때 경고하고, 그 호스트의 브로커 계정 범위 기본값을 `{mode:"only", ids:[]}`(아무 계정도 허용하지 않음)로 둔다. 사용자가 계정을 직접 고르면 풀린다. 이 호스트는 곧 비밀을 받을 곳이므로 중간자를 막는 장치가 꺼져 있으면 기본으로 비밀을 보내지 않는다. `UserKnownHostsFile /dev/null`이면 `StrictHostKeyChecking=yes`로는 배경 재연결을 할 수 없다는 것도 함께 알린다. 현재 config의 `build-host` 블록에 `StrictHostKeyChecking` 키가 있다(값은 읽지 않음, 19.1). 값이 `no`면 이 경고 대상이다 ⚠.
  - `BatchMode`는 쓰지 않는다. askpass로 프롬프트를 UI에 넘겨야 하기 때문이다. 대신 배경 시도가 프롬프트를 만나면 pause한다(6.3).
- **target 규칙**: alias(권장)나 upstream `parseTarget` 문법(`command.ts:45-111`)을 좁힌 직접 target. 목표는 **UI에 적은 한 줄이 로컬 명령을 실행하거나 로컬 자격 증명을 흘리게 두지 않는 것**이다. target은 `hosts.json`에 저장되어 배경 재연결마다 다시 실행되므로 한 번의 확인으로 끝나지 않는다.
  - `-F <configfile>`을 받지 않는다. 그렇게 고른 config 파일은 `ProxyCommand`, `KnownHostsCommand`(Win32-OpenSSH 9.5가 지원), `Match exec`로 로컬 명령을 실행할 수 있다. upstream은 받는다(`command.ts:98`).
  - `-o proxycommand`, `-o identityagent`를 받지 않는다. `-o` 허용 목록은 `hostname`, `user`, `port`, `identityfile`, `identitiesonly`, `proxyjump`, `connecttimeout`, `addressfamily`다.
  - `-i`와 `-o identityfile`은 정규화한 뒤 `%USERPROFILE%\.ssh\` 아래의 로컬 드라이브 경로만 받는다. `\\`나 `//`로 시작하는 UNC 경로, `\\?\`·`\\.\` 장치 경로, `%`·`$`(ssh의 토큰·env 펼침)를 거부한다. Windows에서 UNC 경로를 열면 SMB 인증이 일어나 NTLM 해시가 새기 때문이다.
  - `-J`(ProxyJump) 값은 host 문법 검사(`command.ts:106-109`의 정규식)를 통과한 `[user@]host[:port]` 목록만 받는다. 점프 호스트의 설정은 사용자 config에서 온다.
  - 개행·CR·NUL 거부(`command.ts:50`), 원격 명령 인자 거부는 upstream 그대로다.
  - 그 밖에 필요하면 사용자가 `~/.ssh/config`에 alias를 적는다. config는 사용자 소유이므로 거기의 `ProxyCommand` 등은 허용한다.
  - 파서 테스트(20.1): `-F x`, `-o ProxyCommand=…`, `-o IdentityAgent=…`, `-i \\host\share\k`, `-i //host/share/k`, `-i \\?\C:\k`, `-i %d/k`, `-o identityfile=$HOME/k`는 모두 `input` 오류.
- **alias 목록**은 upstream `sshHosts`(`command.ts:217-256`)처럼 config와 `Include`를 파일로만 읽는다. 와일드카드 Host는 목록에 넣지 않는다.

### 7.3 `-L` (원격 API)

- `-L 127.0.<k>.2:<LP>:127.0.0.1:<RP>`. RP는 등록 URL의 포트다(6.1). `k`는 호스트를 추가할 때 1–250에서 고른 번호이고 `hosts.json`에 고정한다.
- **왜 `127.0.0.1`이 아닌가.** 브라우저 쿠키는 포트를 가리지 않는다(upstream도 이 때문에 쿠키 이름에 포트를 넣는다, `packages/server/src/auth.ts:57-60`). own-web의 로컬 세션 쿠키 `opencode_session_<P>`(HttpOnly, SameSite=Lax, 30일)는 호스트 `127.0.0.1`의 **모든 포트**로 간다. 원격 끝점을 `127.0.0.1:<LP>`에 두면 다음이 가능해진다.
  - PTY WebSocket 업그레이드는 항상 쿠키를 싣는다. 원격 service나 RP를 가로챈 원격 프로세스가 쿠키를 받는다.
  - 받은 토큰을 `Authorization: Basic opencode:<token>`으로 로컬 `127.0.0.1:P/api/*`에 보내면, 세션 토큰은 비밀번호 자리에서도 받아들여지므로(`auth.ts:32-37`) 로컬 API 전체(셸 도구, PTY, 권한 승인)를 쓸 수 있다. 같은 origin 검사(`middleware/authorization.ts:63-70`)는 쿠키 경로만 막는다.
  - 원격 끝점이 `http://127.0.0.1:*` origin에서 JS를 내면 로컬 서버의 CORS가 그 origin을 허용한다(`packages/server/src/cors.ts:13-14`).
  - 그래서 원격이 내용을 만드는 끝점은 모두 **호스트 `127.0.0.1`·`localhost`가 아닌 loopback 주소**에 둔다. 쿠키는 호스트 `127.0.<k>.2`로 가지 않고, 로컬 CORS 허용 목록은 `127.0.0.1:*`·`localhost:*` 접두어만 받으므로 그 origin을 거절한다(4.4 check-surface). 호스트마다 `k`가 다르므로 한 호스트의 끝점이 다른 호스트 끝점과 origin·쿠키를 나누지도 않는다.
- **모드별 적용 범위.** 위 첫 두 항목(쿠키가 원격으로 감)은 **웹 폴백에만** 해당한다.
  - 데스크톱 렌더러는 origin이 `oc://renderer`이고 쿠키도 pairing도 쓰지 않는다. 로컬 서비스 인증은 main이 로컬 서비스 origin과 정확히 같은 요청에만 Basic을 넣는 방식이다(`packages/desktop/src/main/service/sidecar-credentials.ts:26-29`, `windows/security.ts:42-53`, 05 §6.4). 그래서 데스크톱에서 `127.0.<k>.2`로 가는 요청에는 로컬 자격 증명이 어떤 형태로도 붙지 않는다.
  - 그래도 **호스트별 loopback 주소는 모든 모드에서 유지한다.** 같은 PC에서 웹 폴백을 함께 쓸 수 있고(pairing 쿠키는 브라우저 프로필에 30일 남는다), 셋째 항목(CORS)은 모드와 무관하다. dev forward 페이지는 데스크톱에서도 시스템 브라우저로 열리므로(7.6) 그 페이지의 origin이 로컬 서버의 CORS 허용 목록에 들지 않아야 한다.
  - 데스크톱 main은 렌더러 session의 응답에 `Access-Control-Allow-Origin: *`를 더한다(`packages/desktop/src/main/windows/headers.ts:4-20`). 이것은 렌더러가 원격 서버를 부를 수 있게 하는 것이고, 원격 끝점 페이지가 로컬 API를 부르는 방향과는 무관하다. 브라우저 패인 탭은 다른 partition이라 이 헤더도, 렌더러의 인증도 받지 않는다(`browser-pane.ts:84`, 7.6).
  - Windows는 `127.0.0.0/8` 전체를 loopback으로 받고 Chromium은 이 대역을 신뢰할 수 있는 로컬 주소로 본다. 그래서 `127.0.0.1` 페이지에서 `127.0.<k>.2`를 불러도 사설망 접근 프롬프트가 없어야 한다 ⚠(RG16). 이 주소에 bind할 수 없으면 `127.0.0.1`로 물러나지 않고 `loopback_unavailable`로 멈춘다(fail closed).
- **LP는 호스트마다 고정한다.** 호스트를 추가할 때 20000–29999에서 **실제 bind 시험**으로 고른 포트를 `hosts.json`에 둔다. Windows의 제외 포트 범위(Hyper-V·WinNAT가 예약)에 들면 bind가 "사용 중"이 아니라 `EACCES`로 실패하므로, `EACCES`도 "사용 중"과 같이 취급해 다음 후보로 넘어간다. 연결 때 쓰이고 있거나 `EACCES`면 임시 포트를 쓰고 `host.state`로 알린다. upstream은 매번 `127.0.0.1:0`에서 고른다(`controller.ts:338-342`). 고정하면 own-web client를 다시 만드는 일이 줄어든다.
- 로컬 브로커 리스너(`127.0.0.1:B_h`)와 askpass 서버는 원격이 HTTP 응답을 만드는 끝점이 아니므로 `127.0.0.1`에 둔다. 브라우저가 브로커 포트로 HTTP 요청(쿠키 포함)을 보내면 첫 4바이트가 길이 상한(1 MiB)을 넘으므로 브로커는 즉시 닫고, **받은 바이트를 기록하지 않는다**(8.4).
- 준비 확인: `GET /api/info` 2초 timeout, 100ms 간격, 30초 상한(인증 프롬프트 중에는 연장, upstream `controller.ts:344-365`).

### 7.4 `-R` (브로커)

우선순위대로 시도한다. `ExitOnForwardFailure=yes`라 원격 쪽 bind가 거부되면 터널 자체가 실패한다. 실패하면 inspect로 원인을 본 뒤(7.1) 다음 방식으로 넘어간다. 어느 방식이든 끝점은 arm으로 원격 runtime에 알린다(8.3). 원격이 끝점을 스스로 찾지 않는다.
1. **스트림 소켓(기본)**: `-R <소켓 디렉터리>/broker-<epoch>.sock:127.0.0.1:<B_h>`.
   - 소켓 디렉터리는 기본 `<OWN_HOME>/run`(0700)이다. sshd가 소켓을 `StreamLocalBindMask`(기본 0177 → 0600)로 만든다. 같은 uid만 접근한다.
   - **경로 길이.** 유닉스 소켓 경로는 `sun_path` 108바이트(끝 NUL 포함) 안이어야 한다. `installRoot`를 바꿨거나 HOME이 깊으면 넘을 수 있다. inspect가 가장 긴 경로(epoch 10자리 가정)를 재서(`SOCK_PATH_LEN`) 100바이트를 넘으면 짧은 디렉터리를 쓴다. 먼저 `$HOME/.own-r/<OWN_HOME 해시 8자>/`, 그것도 길면 `/tmp/own-<uid>/<OWN_HOME 해시 8자>/`다. 해시를 넣는 이유는 같은 uid의 다른 설치(20.2 라이브 테스트)와 겹치지 않게 하기 위해서다.
   - `-R` bind는 원격 명령(ensure)보다 먼저 일어나므로 소켓 디렉터리는 터널 전에 있어야 한다. 기본 `run/`과 `$HOME/.own-r/…`는 install이 만든다(5.5). `/tmp` 아래 디렉터리는 원격 재부팅 때 사라질 수 있으므로, 그 모드에서 `-R` bind가 실패하면 own-remote가 짧은 명령으로 `mkdir -m 700 -p`를 한 뒤(인증 1회 추가) 터널을 다시 세운다.
   - 어느 디렉터리든 쓰기 전에 소유자가 자기 uid이고 모드가 0700이며 symlink가 아닌지 확인한다(ensure와 위 준비 명령). 조건이 맞지 않으면 쓰지 않고 TCP 대체로 간다.
   - 서버 쪽 `StreamLocalBindUnlink`는 기본 no라 옛 소켓 파일이 있으면 bind가 실패한다. 그래서 경로에 epoch를 넣는다. 새 epoch의 경로는 늘 새것이므로 잔재와 부딪히지 않는다. ensure는 **이번 epoch보다 작은** 소켓만 지운다(6.1 5번).
   - **egress forward(8.11)**: 같은 소켓 디렉터리에 `-R <소켓 디렉터리>/egress-<epoch>.sock:127.0.0.1:<E_h>`를 둔다. TCP 대체에서는 `-R 127.0.0.1:<egressTcpPort>:127.0.0.1:<E_h>`이고, 포트는 브로커 포트와 따로 저장한다. 이름 길이가 `broker-<epoch>.sock`과 같아 경로 길이 규칙은 그대로다. 정리 규칙(이번 epoch보다 작은 것만, keep은 자기 epoch)도 같다.
   - 조건: sshd `AllowStreamLocalForwarding`(기본 yes). RG4(2026-09-28 실제 호스트, OpenSSH_for_Windows_9.5p2 → OpenSSH 9.6p1): Win32-OpenSSH 클라이언트의 원격 streamlocal forward가 동작하고, sshd가 만든 소켓은 0600(0700 `run/` 안)이다.
2. **TCP 대체**: 로컬에서 원격 포트 N을 무작위로 골라(20000–60000) `-R 127.0.0.1:N:127.0.0.1:<B_h>`로 요청한다. 원격에서 N이 쓰이고 있으면 `ExitOnForwardFailure`로 터널이 끝나므로 다른 N으로 최대 3번 다시 한다(시도마다 인증 1회). 성공한 N은 `hosts.json`에 두고 다음 연결에 먼저 쓴다. 포트를 로컬이 정하므로 ssh stderr의 "Allocated port" 줄(INFO 수준이라 사용자 `LogLevel`이 `QUIET`·`ERROR`면 나오지 않음)을 읽을 필요가 없다. loopback TCP는 원격의 다른 사용자도 연결할 수 있으므로 상호 인증(8.3)이 유일한 방어다.
3. **stdio relay(최후, ⚠ RG4)**: `AllowTcpForwarding`이 막혀 있으면 `-L`도 안 되므로 SSH 원격 자체가 불가능하다(`forwarding_disabled`). 스트림 소켓만 막힌 경우를 위해, 터널 세션 명령을 "원격 유닉스 소켓 ↔ stdio" 중계로 돌리는 안을 둔다. 중계 프로그램은 우리 번들의 JS를 Bun 바이너리로 실행하는 방식(`BUN_BE_BUN=1`)을 검토한다. 확인 전에는 쓰지 않는다.

- **keep 부분**(ensure 본문 뒤에 이어지는 stdin 스크립트): upstream은 `sh -c 'exec cat >/dev/null'`로 세션을 붙들어 둔다(`command.ts:134-154`, 다중화된 `-N`이 먼저 끝나는 문제 회피). 우리 keep은 다음을 한다.
  - `trap`은 **자기 epoch의 파일만** 지운다: `rm -f <소켓 디렉터리>/broker-<epoch>.sock`. `run/broker.current`는 지우지 않는다. 이전 설계처럼 공용 파일(`run/broker.json`)을 지우면, 네트워크가 끊겨 오래 살아남은 옛 sshd 세션이 나중에 SIGHUP을 받을 때 **새 epoch의 파일**을 지우게 된다. `ServerAlive*`는 클라이언트 쪽 설정이고 sshd `ClientAliveInterval` 기본값은 0이며 TCP keepalive는 약 2시간이라, 옛 세션은 오래 남을 수 있다.
  - **옛 세션 스스로 끝내기**: 15초마다 `run/broker.current`를 읽어 자기 epoch가 아니면 trap을 거쳐 끝난다. stdin EOF(로컬 ssh.exe가 끝남)에도 끝난다. 비대화형 `sh`는 백그라운드 명령의 stdin을 `/dev/null`로 바꾸므로, `cat`으로 EOF를 기다릴 때는 먼저 `exec 3<&0`으로 stdin을 보존하고 `cat <&3 >/dev/null &`로 돌린다.
  - 원격 runtime은 arm으로 받은 epoch 중 **가장 높은 것**만 따르고, 이미 받은 epoch보다 낮은 arm은 거절한다(8.3). 그래서 옛 세션이 늦게 끝나든 일찍 끝나든 새 epoch 연결에는 영향이 없다.

### 7.5 config의 forward 감지

- 터널용 alias의 실제 설정에 `LocalForward`, `RemoteForward`, `DynamicForward`가 있으면 그 alias로는 터널을 만들지 않고 `forward_conflict`로 알린다. 그 forward도 터널 프로세스가 함께 잡으려 하고, `ExitOnForwardFailure=yes` 때문에 사용자의 수동 세션과 충돌하면 터널이 죽기 때문이다(`lab-7676`이 이 경우, 19장).
- **원칙: 호스트를 나열하거나 보여 주기만 하려고 명령을 실행하지 않는다.** `hosts.discover`와 `hosts.detail`은 config와 `Include`를 파일로만 읽는다([old] `remote.py:96`도 같은 원칙). upstream 컨트롤러가 연결마다 표시용으로 부르는 `ssh -G` destination probe(`controller.ts:119-131`)는 vendor할 때 지운다(4.3).
- **forward 감지는 연결 직전에만 `ssh -G <alias>`로 한다.** 사용자가 누른 연결이든 autoConnect 배경 연결이든, 곧 실행할 실제 ssh가 같은 config(`Match exec` 포함)를 어차피 평가하는 시점이다. 그래서 새 명령 실행 표면이 생기지 않는다. `ssh -G`는 접속하지 않고, 출력의 `localforward`·`remoteforward`·`dynamicforward` 줄이 Host 패턴·부정(`!`)·`Include`·첫 값 우선·`Match`를 ssh 자신의 규칙으로 푼 결과다. 설정 파서를 손으로 흉내 내지 않는다. 같은 출력의 `user`·`hostname`·`port`로 상태 패널의 `destination`을 메모리에 채운다.
- 표시용 파일 파서(`hosts.discover`의 `forwards` 표시)는 근사치다. 와일드카드 Host와 `Match`는 풀지 않고 "config에 forward가 있을 수 있음"만 표시한다. 사용자의 현재 config에는 `Match` 블록이 없다(2026-09-27, 구조만 확인).

### 7.6 요청형 dev 서버 forward

- 원격 dev 서버(예: `127.0.0.1:7676`)를 브라우저로 보려는 용도다. 사용자는 지금 `lab-7676` alias로 이 일을 한다.
- `own.remote.portForward.open{hostId, remotePort}` → 별도 `ssh -N -L 127.0.<k>.3:<임시>:127.0.0.1:<remotePort>` 프로세스. 원격 쪽 대상은 `127.0.0.1`의 정확한 포트만 받는다(exact allowlist, [old] 92). 목록·닫기 RPC가 있고, 로컬 종료 때 모두 닫는다. R3.
- dev 서버는 원격 프로젝트 코드(믿을 수 없음)가 내는 페이지다. 그래서 로컬 쪽 주소는 API 터널과도 다른 `127.0.<k>.3`이다(7.3과 같은 이유). own-web은 이 주소를 **own-web과 쿠키·session을 나누지 않는 곳**에서 연다.
  - 데스크톱: `host.openExternal`(05 §6.3 T0-5, 시스템 기본 브라우저)로 연다. 렌더러 창 안에서는 열지 않는다.
  - 웹 폴백: own-web이 전용 프로필(`msedge --app --user-data-dir=…`)로 떠 있으면 시스템 기본 브라우저로 열고, 같은 프로필을 쓰는 설정이면 URL 복사만 제공한다.
- **원격 세션의 브라우저 패인(데스크톱, 05 §8.6, 구현 SB 2026-11-21).** 원격 세션에서 여는 패인은 main이 그 원격 서버의 plugin-browser에 attach한다(7.3의 `-L` 하나 위의 HTTP: 새 SSH 로그인도, 호스트의 새 포트도 없음). 패인 탭의 요청 중 **loopback(`localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`)과 그 호스트의 이름(별칭, target의 host, `ssh -G` destination)만** 서버 쪽 터널로 나가고(`tunnel.open`이 호스트에서 `net.connect`), 나머지는 이 PC에서 바로 나간다(own-desktop `src/main/browser-route.ts`, `src/overrides/browser-network.ts`). 그래서 패인에서 `http://localhost:7676`을 열면 **원격 호스트의** dev 서버가 보이고, 이 절의 port forward도 사용자의 `ssh -L`도 필요 없다. 실제 호스트 단계 F가 확인한다(20.3). 원격 서비스와 `proto`는 바뀌지 않았다(plugin-browser는 core 내장).
  - 격리: 패인 탭은 attachment마다 메모리 전용 partition이다(`browser-pane.ts:84`). 렌더러 session의 쿠키·Basic 주입·CORS 헤더를 받지 않는다. 원격 서버에서는 `file://` 루트가 비어 있다(`browser-pane.ts:88-90`, 같은 기계가 아님).
  - 원격 세션 토큰: main은 attach에 쓸 토큰을 렌더러에게서 `endpoint.password`로 받아 attachment 수명 동안 메모리에만 둔다(05 §8.2, §8.6). 토큰이 main 메모리를 거치는 유일한 경우다.
  - 남는 표면: 원격 plugin-browser의 `tunnel.open`은 원격 호스트의 임의 loopback 포트에 닿는다. 원격 `127.0.0.1:RP`(원격 service)는 Basic 없이 401이고, TCP 대체 브로커 포트(7.4)는 첫 프레임이 `hello`가 아니면 닫는다(8.4). 새 위험은 아니다(원격 에이전트의 셸 도구도 같은 곳에 닿는다).
  - 도구 목록: 원격 세션도 05 §8.7의 규칙(세션 생성 때 호스트 capability로 `browser` 권한 새김, 8.10.5의 개정 포함)을 그대로 따른다. 원격 managed config(5.6)는 `-opencode.browser`를 넣지 않는다. 데스크톱 창이 원격 세션을 붙이는 동안 원격 서비스가 그 세션에 `browser allow`를 더하므로, **서버에서 도는 에이전트가 PC의 패인을 브라우저 도구로 쓴다**. 브라우저 패인을 맡을 데스크톱 앱이 없을 때 만든 원격 세션은 카탈로그에서 브라우저 도구가 빠진다.
  - 끊김: SSH가 끊기면 attachment와 그 프록시가 닫히고 패인은 `SSH 연결이 끊겼어요`를 보인다. 끝점이 다시 알려지면 own-web이 다시 붙이고 탭을 복원한다(05 §8.6).
  - 휴대폰·다른 PC: 그 패인을 게이트웨이의 `/own/browser/<hostId>/<sessionID>`로 본다(05 §8.10.8). 이 PC의 레지스트리에 없는 서버는 거절한다.
- 그래서 port forward(R3)는 웹 폴백과, 원격 dev 서버를 시스템 브라우저나 다른 도구로 봐야 할 때의 수단으로 남는다. 이 판(2.2.6-own.14)에도 `portForward.*`는 `not_supported`다.

---

## 8. 자격 증명 브로커

### 8.1 왜 브로커인가 (01 §11 변경)

이전 01 §11은 "원격은 자기 vault를 쓰고 로컬 비밀을 보내지 않는다"였다. 이것으로는 G-R3(같은 로컬 계정, 같은 전환·캐시·한도)을 채울 수 없다. 세 안을 비교했다.

| 안 | 요지 | 장점 | 단점 | 판단 |
|---|---|---|---|---|
| A. 원격 vault | 계정을 원격마다 다시 로그인 | 비밀이 한 번만 복사됨 | 계정이 다름(다른 slot → 다른 캐시 도메인 규칙, 한도 분산), refresh token이 원격 디스크에, ChatGPT refresh 계열 충돌 위험(02 C3) | 기각 |
| **B. 헤더 브로커 + lease** | 원격 `model.request`가 요청마다 로컬 브로커에서 인증 헤더를 받음 | 같은 계정·slot·템플릿. 모델 트래픽은 원격 → provider 직접(SSH는 작은 메시지만). 끊겨도 lease 동안 진행. 코어 패치 없음 | access token·API 키가 원격 **메모리**에 lease 동안 있음 | **채택(기본)** |
| C. 로컬 egress 게이트웨이 | 원격 요청을 `-R`로 로컬 프록시에 보내 로컬이 인증을 붙여 전송 | 비밀이 Windows를 떠나지 않음 | 모든 스트림(HTTP SSE, Codex WS)이 SSH를 지남. SSH가 끊기면 진행 중 스트림이 죽음. 로컬이 늘 켜져 있어야 함. HTTP·WS 프록시라는 큰 새 구성요소. 훅에서 baseURL을 바꾸는 것은 가능(`packages/core/src/session/model-request.ts:262-270`)하지만 native window가 있으면 위험(01 §8.2) | **Claude 구독 슬롯에 채택(8.11).** 다른 계정은 R4 선택지 |

- 사용자 요구가 "로컬 계정 그대로"이므로 B를 기본으로 하고 원격 사용을 끄는 스위치(8.9)를 둔다. 토큰을 원격에 둘 수 없는 Claude 구독 슬롯만 C로 중계한다(8.11).
- **선례.** 이전 앱의 SSH 인증 프록시가 B와 같은 방식으로 이미 쓰였다. 원격 app-server에 선택한 계정의 **현재 access token과 account id만** 넘기고 refresh token은 고르지도, 보내지도, 저장하지도 않았다. 원래 Codex 인스턴스가 갱신을 맡았고, 토큰이 없거나 만료가 가까우면 fail closed였다([old] `scripts/manager_core/proxy_auth.py:1-11`, `docs/operations/ssh-plugin-publication.md:70-74`). 만료까지 120초 미만인 토큰은 쓰지 않는다는 `minimum_validity` 규칙(`proxy_auth.py:60-91`)도 가져온다(8.5). 이 방식으로 lab, work_linux, build-host를 운영했다.
- 원격에서 provider로 가는 요청의 출발 IP는 원격 호스트다. 이것이 캐시나 계정 정책에 영향이 있는지는 ⚠(RG9). 캐시는 계정·org·prefix 단위로 알려져 있고 IP 단위라는 근거는 없다. Codex CLI를 서버에서 쓰는 것도 흔한 사용 방식이다.

### 8.2 구성

```text
원격 own-accounts(model.request) ─▶ runtime 브로커 client(arm으로 받은 K·끝점) ─▶ <소켓 디렉터리>/broker-<epoch>.sock
      ─(sshd -R)─▶ ssh.exe ─▶ 127.0.0.1:B_h (로컬 브로커 리스너, 호스트 h 전용)
      ─▶ own-runtime 브로커 서버 ─▶ headersFor(providerID, kind, sessionID) ─▶ 비밀 캐시 / own-vault.exe / refresh single-flight
```
- **리스너는 호스트마다 하나**다(`127.0.0.1:0`에서 받은 포트 `B_h`). 연결이 들어온 리스너로 호스트가 정해진다. 호스트 A의 키로 호스트 B의 forward를 쓸 수 없다.
- 로컬 Windows의 다른 프로세스도 `127.0.0.1:B_h`에 연결할 수 있다. 그래서 상호 인증이 필수다.
- 로컬 service의 HTTP API(`/api/*`)는 원격에 절대 열지 않는다. 그것을 `-R`로 열면 원격에서 로컬 Windows의 도구를 실행할 수 있게 된다.

### 8.3 상호 인증

- **키**: epoch마다 32바이트 난수 `K`. own-remote가 만들어 runtime의 `brokerKeys[hostId]`에 등록한다. 터널이 새로 서면 새 epoch와 새 K다.
- **키 전달(arm)은 파일을 거치지 않는다.** own-remote는 터널이 서고 `/api/info`가 응답하면 원격 control location으로 `own.remote` `agent.broker.arm{hostId, epoch, key, endpoint:{socket}|{tcpPort}, proto}`를 부른다(`-L` 위의 HTTP, 원격 서비스 Basic 인증). 원격 own-remote(agent)는 이 값을 원격 runtime의 브로커 client에 넘기고, client는 K를 **자기 클로저 안에만** 둔다(싱글턴 객체의 속성이나 디스크·env·로그에 두지 않음). 원격 service가 재시작되어 K를 잃으면, 터널은 살아 있는데 브로커 연결이 30초 넘게 오지 않는 것을 보고 own-remote가 `agent.status`를 부르고, `broker.state:"unarmed"`면 같은 epoch·같은 K로 다시 arm한다.
  - 이유: 키를 uid가 읽을 수 있는 파일(이전 설계의 `run/broker.json`)에 두면 원격 에이전트의 셸 도구가 `cat` 한 번으로 키를 읽어 브로커에 직접 헤더를 요청할 수 있다. fs deny 규칙(5.6)은 셸로 우회된다. 파일이 없으면 셸 도구는 소켓에 닿아도 인증을 통과하지 못한다.
  - 한계: 같은 프로세스에서 도는 플러그인 코드는 runtime의 헤더 요청 함수를 직접 부를 수 있다. 클로저는 이것을 막지 못한다. 이 경로는 원격 프로젝트 설정을 기본으로 꺼서(5.6) 막는다(15장).
  - RPC 등록부는 Location마다 따로 만들어지므로(`packages/core/src/rpc.ts:35-45,177`) 프로젝트 Location의 플러그인이 control location의 `own.remote` 핸들러를 가로챌 수 없다. upstream HTTP 요청 로그가 RPC 본문을 남기지 않는지는 ⚠(RG10).
  - arm은 epoch가 단조 증가할 때만 받는다. 같은 epoch의 재arm(재시작 복구)은 같은 K일 때만 받는다.
- **핸드셰이크**(HMAC-SHA256, 상수 시간 비교)
  1. 원격 → 로컬: `hello {proto, hostId, epoch, nonceR, version, buildId, mirrorSchemaVersion, streamId}`
  2. 로컬 → 원격: `challenge {nonceL, mac: HMAC(K, "own-broker/v1|L|"+hostId+"|"+epoch+"|"+nonceR+"|"+nonceL)}`. 원격은 로컬이 K를 안다는 것을 확인한다(TCP 대체 경로에서 가짜 리스너 방지).
  3. 원격 → 로컬: `auth {mac: HMAC(K, "own-broker/v1|R|"+hostId+"|"+epoch+"|"+nonceL+"|"+nonceR)}`. 로컬은 원격이 K를 안다는 것을 확인한다.
  4. 실패하면 연결을 닫고 호스트별로 1분에 5회까지만 받는다. 실패는 events ledger에 `remote.broker.auth_failed`로 남긴다.
- **호환 판단**(5.7): `proto`가 로컬 `proto`나 직전 `proto`가 아니면 `skew`로 거절한다. `proto`는 맞지만 `version`·`buildId`가 로컬과 다르면 **drain 모드**로 받는다(`headers.get`, `observe.push`, `ping`, `revoke`, `account.status`만, 최대 `skewDrainHours`). 둘 다 같으면 정상 모드다.
- 채널 기밀성은 SSH와 0600 소켓(또는 loopback)이 준다. 프레임마다 MAC을 붙이지는 않는다.

### 8.4 메시지

프레이밍: 4바이트 big-endian 길이 + UTF-8 JSON. 프레임 최대 1 MiB. 모든 요청에 `id`, 응답에 같은 `id`. 첫 프레임이 `hello`가 아니거나 길이가 상한을 넘으면 즉시 닫고, 받은 바이트는 기록하지 않는다(7.3의 브라우저 요청 대비).

| 방향 | 메시지 | 내용 |
|---|---|---|
| R→L | `registry.get {since}` | → `{registryRevision, policyRevision, ratecardsRevision, view}` (9.2). drain 모드에서는 `skew_drain` 오류 |
| R→L | `headers.get {providerID, kind, sessionID, directory, allowlist:"ok", invalidate?: authHash8}` | → `{headers, authHash8, ttlMs, generation}` 또는 `{error: "account_not_remote" \| "needs_reauth" \| "source_stale" \| "exhausted_blocked" \| "rate_limited" \| "not_found" \| "vault_unavailable", expiresInMs?}`. `source_stale`은 linked Codex 계정 전용이다(8.5). `expiresInMs`는 `source_stale`일 때만, 원본 토큰의 남은 수명(음수면 이미 만료) |
| R→L | `observe.push {streamId, fromSeq, items[]}` | → `{ackThrough}` (10.3). 한 번에 256개, 512 KiB 이하. 항목마다 `schemaVersion` |
| R→L | `ping {remoteNow}` | → `pong {localNow}`. 왕복 시간과 시계 차이 `clockSkewMs`를 잰다. 연결 직후 한 번, 이후 5분마다. 10.5의 시각 정규화와 호스트 경고에 쓴다 |
| L→R | `mirror.changed {registryRevision, policyRevision, ratecardsRevision}` | 원격이 `registry.get`으로 다시 받음 |
| L→R | `quota.updated {windows, dropped?}` | 로컬 한도 저장소의 변경(02 §7.4). 원격 추정기·전환 판단용. `dropped: [{accountID, id}]`는 로컬 저장소가 지운 창(지운 월 예산, `Limits.Store.drop`)이고 원격도 지운다(LV 2026-10-25). 그 밖에는 원격이 받은 창을 합치기만 한다. 이 필드를 모르는 호스트는 무시한다 |
| L→R | `calibration.updated {items:[{accountID, model, window, coefficients, r2, samples, fittedAt}]}` | 로컬 한도 보정 결과(02 §7.6). 원격 추정기가 로컬과 같은 보정 값을 쓰게 한다(11장). 연결 직후 전체, 이후 바뀔 때 |
| L→R | `account.status {accountID, status, reason?, scope?: "host"}` | needs_reauth, exhausted, disabled, retired, `auth_failed`(`reason:"codex_source_stale"`) 등. `scope:"host"`는 로컬 계정 상태는 그대로이고 **이 호스트의 lease만** 막혔다는 뜻이다(linked 계정, 8.5·8.8). 없으면 로컬 계정 상태 그대로다 |
| L→R | `revoke {providerID, generation?}` | 원격이 그 slot의 lease를 즉시 버림 |
| R→L | `github.offer {directory, main?}` | → `{tools, git}`: 그 호스트 폴더가 내놓을 GitHub 도구와 git 로그인 여부(8.12, 16 §8). 정상 모드에서만 |
| R→L | `github.account {directory, main?, root?}` | → `{account?, source, problem?, git}`: 그 폴더·대화가 지금 쓰는 계정(토큰 없음). 정상 모드에서만 |
| R→L | `github.call {directory, main?, root?, tool, input, account}` | → `{text, isError, account}` 또는 `{error, message}`: PC가 그 계정으로 GitHub MCP 도구를 부른 결과(토큰을 가리고 640 KiB까지). 정상 모드에서만 |
| R→L | `mcp.values {server}` | → `{sent, env, headers, search?, url?}`: 사용자가 PC에서 그 호스트의 MCP 서버(`server`, 호스트의 id)에 보낸 값(13.1). 그 호스트의 기록만, PC의 사본에서. 보낸 적이 없거나 거뒀으면 `sent:false`. 정상 모드에서만 |
| L→R | `mcp.changed {}` | PC가 그 호스트에 보내는 MCP 값이 바뀜(보냄·거둠). 호스트는 값을 버리고 다시 묻는다(13.1) |
| L→R | `github.changed {}` | PC의 GitHub 계정·선택·설정·도구 목록이 바뀜. 원격은 `github.offer`를 다시 묻는다(정상 모드 세션에만) |
| R→L | `claudeAgent.open {stream, kind, accountID, directory, op?, sessionID?, parentID?, side?}` | → `{opened:true}` 또는 `{refused, message}`: 호스트 대화의 claude 프로세스(`process`, PC 풀의 자리를 받은 뒤 답) 또는 기록·버전 호출(`call`) 하나를 PC에 연다(8.13, 02 §8.10.13). 정상 모드에서만 |
| R→L | `claudeAgent.start {stream, args, env}` | → `{ok}`: 그 프로세스를 SDK의 인자로 띄운다. PC가 인자·env를 다시 거른다 |
| R→L | `claudeAgent.write {stream, data?, end?}` | → `{ok}`: 스트림의 글(차례대로, 128 Ki자 이하)과 입력 끝 |
| R→L | `claudeAgent.close {stream}` | → `{ok}`: 스트림을 닫는다(기다리는 자리도 놓는다) |
| L→R | `claudeAgent.data {stream, data}` | 스트림의 글(claude의 출력, 호출의 답) |
| L→R | `claudeAgent.exit {stream, code, error?}` | 스트림이 끝남(claude의 종료 코드, 호출은 0 또는 1과 까닭) |

- `headers`에는 **인증 헤더만** 들어간다(02 §4.1 헤더 표에서 비밀이거나 계정 식별자인 것): codex `Authorization`, `chatgpt-account-id` / oai·ds·xai·or·compat `Authorization` / oai 선택 `OpenAI-Organization`, `OpenAI-Project` / anth `x-api-key`. `session-id`와 `originator`는 원격 훅이 로컬과 같은 코드로 붙인다.
- `directory`와 `allowlist`는 감사용이다. 로컬은 원격의 allowlist 판정을 검증할 수 없다(15장 한계).

### 8.5 lease 규칙

| 대상 | `ttlMs`(브로커가 계산) | 원격 보관 | 갱신 |
|---|---|---|---|
| Codex access token(vault·takeover) | `min(expiresAt − 5분, now + leaseSeconds) − now` | 메모리 Map `providerID → {headers, authHash8, deadline, generation}` | lease의 80% 시점에 배경에서 다시 요청. 브로커는 refresh가 없으면 **같은 값**을 준다 |
| Codex access token(linked) | 같은 식. `expiresAt`은 원본 `auth.json`의 JWT 만료(02 §3.2a) | 같음 | 같음. 이전 앱이 원본을 새로 쓰면 다음 요청에서 새 값을 준다. **우리는 refresh하지 않는다** |
| API 키 | `leaseSeconds × 1000` | 같음 | 같음 |
| refresh token, id token, vault 원문, linked 원본 파일 내용 | 보내지 않음 | – | – |

- **상대 수명.** 브로커는 절대 시각이 아니라 `ttlMs`를 보낸다. 원격은 응답을 **받은 시각**에 자기 단조 시계로 `deadline = 수신 시각 + ttlMs − 왕복 시간/2`를 계산한다. 원격 시계가 늦거나 빠르더라도 lease가 길어지거나 곧바로 낡지 않는다.
- **최소 유효 기간**(이전 앱 `minimum_validity`, 8.1). Codex 토큰의 남은 수명이 `5분 + 120초`보다 짧으면 곧 만료될 토큰을 원격에 보내지 않는다. 원격에서 401이 나게 하지 않기 위해서다. 그다음 동작은 **자격 증명 출처**(`accounts[].credential.type`, 02 §3.1 C3)로 나뉜다.
  - `vault`, `takeover-codex-source`: lease를 내기 **전에** 로컬 single-flight refresh를 먼저 돌린다(02 §3.5 F1–F4). refresh가 실패하면 lease를 내지 않고 `needs_reauth` 또는 `vault_unavailable`로 답한다. 예외로 Sign in with ChatGPT 토큰의 refresh를 token endpoint가 `earliest_refresh_at`으로 미뤄 두었으면 refresh하지 않고 현재 토큰을 위 식(`expiresAt − 5분`까지)으로 짧게 준다. 남은 것이 없으면 `vault_unavailable`이다(02 §3.2c).
  - `linked-codex-source`: **refresh하지 않는다. token endpoint 호출은 0이다**(02 §3.2a, §3.5 F9, 01 §8.4). 원본 파일을 다시 읽기만 한다. 로컬 요청과 같은 `CodexSource.Reader.usable()` 경로이고, `stat`은 최대 1초에 한 번, mtime이나 크기가 바뀌었을 때만 내용을 읽는다(`packages/own-runtime/src/codex-source.ts:256-378`). 원본 파일에는 절대 쓰지 않는다.
    - 다시 읽은 토큰의 남은 수명이 최소 유효 기간 이상이면 위 식으로 lease를 준다(이전 앱이 그 사이 갱신한 경우).
    - 그래도 짧거나 reader가 stale이면 lease를 내지 않고 `{error:"source_stale", expiresInMs}`로 답한다. 그리고 그 호스트에 `account.status{accountID, status:"auth_failed", reason:"codex_source_stale", scope:"host"}`를 push한다. 원격 전환 상태 머신은 그 계정을 이 호스트의 전환 후보에서 뺀다(02 §5.7).
    - 원본을 읽을 수 없거나 다른 로그인이 들어 있으면(reader invalid, `account_mismatch` 등, 02 §3.2a) 로컬 계정 상태가 먼저 바뀌므로(`misconfigured` 등) 그 상태를 `scope` 없이 모든 호스트에 push하고, lease는 같은 `source_stale`로 거절한다.
    - 로컬 계정 상태는 이것으로 바뀌지 않는다. 로컬은 02 §3.2a의 조건(만료 60초 여유, 로컬 401)으로만 `codex_source_stale`이 된다. 최소 유효 기간(7분)이 로컬 만료 여유(60초)보다 길어서, 만료 7분 전부터 1분 전까지는 로컬에서는 쓰이고 원격에서는 막힌다. 로컬 상태가 `auth_failed`가 되면 모든 호스트에 `scope` 없는 `account.status`를 보낸다(10.6).
    - **풀림.** 브로커는 `source_stale`을 알린 `(hostId, accountID)`를 메모리에 기억한다. 02 §3.2a의 leader 1분 `stat` 감시에 이 계정을 넣고, 원본이 바뀌어 최소 유효 기간을 넘는 토큰이 생기면 그 호스트에 `account.status{status:"ready", scope:"host"}`를 push한다. 원격은 다음 요청에서 새 lease를 받는다.
    - 원격 쪽 처리: `source_stale`은 8.7의 유예(브로커에 닿지 못할 때) 대상이 아니다. 원격 own-accounts는 헤더 없이 sink로 보내고(8.6 5번, 요청 본문이 provider로 나가지 않음) `retry` 훅은 `{retry:false}`, 세션 경보는 로컬과 같은 `codex_source_stale`이다. `needs_reauth`, `account_not_remote`, `exhausted_blocked`도 같다.
    - 경보·UI 문구는 02 §3.2a와 03의 것을 그대로 쓴다("이전 앱에서 이 프로필을 한 번 실행하세요" / `[가져오기로 전환(takeover)]` / `[다른 계정으로 전환]`). takeover로 바꾸면 그 계정은 첫째 줄 규칙을 따른다.
- `leaseSeconds`: 기본 900초. 호스트마다 60–14400초(4시간). 길수록 끊겨도 오래 돌지만 원격 메모리 노출이 길어진다. 설정 화면에 이 트레이드오프를 적는다. ChatGPT access token은 Codex 사용보다 넓은 범위(그 ChatGPT 계정의 다른 백엔드 API)에 쓰일 수 있다는 것도 함께 적는다(15장, 17.9 `own.remote.lease.help`).
- **헤더 값을 안정적으로 둔다.** WS 연결 affinity가 `url + sha256(정렬한 헤더)`라서 값이 바뀌면 WS가 다시 연결된다(02 D3, `packages/core/src/session/model-transport.ts:116-117`). 브로커는 refresh가 일어났을 때만 새 값을 준다.
- 원격은 lease를 디스크·KV·로그·env·argv에 남기지 않는다. 로그에는 `authHash8`만 쓴다(01 §8.3).
- `deadline` 30초 전부터는 쓰지 않고 새로 받는다(요청 도중 만료 방지).

### 8.6 원격 `model.request` 경로 (`mode:"remote"`)

1. providerID가 미러 레지스트리의 own slot이 아니면 아무것도 바꾸지 않는다(02 §4.1 필터 규칙 그대로).
2. 이 Location이 `blocked_by_plugin`이면 인증 헤더를 넣지 않는다(01 §13.2, 원격 `trust.json`). **이 게이트는 우리가 헤더를 넣는 것만 막는다.** 같은 프로세스의 프로젝트 플러그인이 runtime을 통해 헤더를 요청하거나 메모리의 lease를 읽는 것은 막지 못한다. 그래서 원격 기본값은 프로젝트 설정 자체를 끄는 것이고(5.6), 이 게이트는 사용자가 호스트를 `projectConfig:"trusted"`로 바꾼 뒤의 2차 방어다(15장).
3. lease가 유효하면 그것을 쓴다.
4. 아니면 `headers.get`(timeout 5초). 브로커가 끊겨 있으면 재연결을 최대 `brokerWaitSeconds`(기본 10초) 기다린다. 단, 이 세션에 이미 `brokerUnavailable` 표시가 있고 브로커가 여전히 끊겨 있으면 기다리지 않는다(8.7 유예 계산).
5. 그래도 없으면 **요청을 원격 loopback sink로 돌린다**. 훅은 절대 throw하지 않는다(01 §8.3 불변식). 브로커에 닿지 못한 경우에만 runtime에 `brokerUnavailable[sessionID] = at`을 남긴다(8.7 유예 대상). 브로커가 오류(`source_stale`, `needs_reauth`, `account_not_remote`, `exhausted_blocked` 등, 8.4)로 답한 경우는 `leaseRefused[sessionID] = {providerID, error}`를 남기고 유예 없이 끝낸다(8.5).
   - sink는 원격 own-accounts가 `127.0.0.1:0`에 여는 작은 HTTP 리스너다. 모든 요청 본문을 읽어 버리고 401로 답한다. WS handshake도 401로 거절한다. 2.2.6-own.17부터 본문은 `{"error":{"type":"own_broker_unavailable","code","message"}}`이고, `code`는 hook이 붙인 `x-own-fail-reason`(왜 sink로 왔는지), `message`는 그 고정 한국어 문장이다(8.14.5). 전에는 `{"error":"own_broker_unavailable"}`뿐이라 사용자에게 그 낱말만 보였다.
   - HTTP는 `http.request` 훅에서 이 세션·slot의 `request`를 sink URL로 바꾼 Request로 교체하고, Codex WS는 `experimental.ws.handshake` 훅에서 `url`을 sink로 바꾼다(`packages/plugin/src/promise/session.ts:72-100`). 두 훅 모두 코어 패치 없이 쓸 수 있다. 훅이 바꾼 Request는 전송에 그대로 쓰인다: HTTP는 실제 호스트에서(RG6, 2026-09-28: 유예 중 provider 요청 0), Codex WS는 fake-SSH 하네스에서(`packages/own-accounts/test/remote/e2e/linked-ws.test.ts`: handshake가 sink로 가서 backend 요청 0) 확인했다. WS를 실제 호스트에서 재지 않은 이유는 원격 Codex 끝점이 chatgpt.com이고 Bun의 WebSocket이 `HTTPS_PROXY`를 따르지 않아 새는 handshake를 호스트에서 막을 수 없기 때문이다. 안 되면 `model.request`에서 baseURL을 sink로 바꾼다(`packages/core/src/session/model-request.ts:262-270`).
   - 그래서 인증 없는 요청도, 대화 prefix가 든 요청 본문도 provider로 나가지 않는다. 이전 설계("헤더 없이 provider로 보내 401")는 수백 KB의 코드가 든 본문을 인증 없이 provider에 최대 10번 보냈다.
6. 로컬과 같은 코드로 `session-id`, `originator`(codex)를 붙이고(siwc의 `session-id`·`thread-id`·`x-client-request-id`는 로컬처럼 인증 hook이 붙인다, 02 §3.2c), 주입한 헤더의 `authHash8`을 `injected[sessionID][providerID]`에 남긴다(인증 swap 확인, 02 §4.2).
- 헤더 조립 함수는 로컬과 원격이 공유한다: `buildRequestHeaders(credentialHeaders, session)`. 차이는 `credentialHeaders`의 출처(로컬 `headersFor` / 원격 lease)뿐이다. 그래서 요청 바이트가 로컬 세션과 같은 규칙으로 만들어진다.

### 8.7 끊김: fail closed와 유예

- lease가 남아 있는 동안은 브로커가 없어도 요청이 나간다(짧은 끊김 흡수).
- lease도 없으면 8.6의 5번으로 요청이 sink에서 401로 끝난다(HTTP 401, Codex WS는 handshake 401). 원격 own-accounts의 `retry` 훅이 이것을 보고
  - 이 세션의 직전 attempt에 `brokerUnavailable` 표시가 있으면(응답 모양과 상관없이) 유예를 적용한다. WS 경로에서는 `http.response`가 돌지 않아 `lastResponse`가 비어 있을 수 있으므로(01 §14.3) 응답이 아니라 이 표시로 판정한다.
    - **유예는 마감 시각으로 센다.** 첫 실패 때 `graceDeadline = 첫 실패 시각 + failClosedGraceSeconds`를 정한다. 매 attempt의 delay는 `min(30초, (graceDeadline − now) / 남은 재시도 횟수)`이고, `now ≥ graceDeadline`이면 `{retry:false}`다. 8.6 4번의 브로커 대기(최대 15초)는 첫 attempt에만 걸리고 뒤 attempt는 기다리지 않으므로, 턴이 멈추기까지의 상한은 `failClosedGraceSeconds + 15초`다(기본 약 5분 15초). 이전 설계는 attempt마다 최대 15초 대기 + 30초 지연이 쌓여 약 7.5분이었다.
    - core는 Authentication 오류를 재시도 대상이 아니라고 보지만(`packages/core/src/session/runner/retry.ts:30-58`), 이 판단을 `retry` 플래그로 넘길 뿐 훅은 여전히 부른다. 훅이 결정을 `{retry:true, delay}`로 바꾸면 그대로 따른다(`retry.ts:96-120`, `packages/plugin/src/promise/session.ts:127`). 재시도는 출력이 시작되기 전에만 일어나고(`packages/core/src/session/runner/step.ts:174-186`), 401에는 출력이 없다.
    - 횟수는 core schedule의 10회로 묶인다(`retry.ts:78-91`). `failClosedGraceSeconds`가 커도 10회를 넘지 않는다.
  - 유예가 끝나면 `{retry:false}`와 세션 경보 `broker_unavailable`. 턴은 끝나고, 사용자가 연결 뒤 "계속"을 누른다.
- 유예 중 요청은 원격 호스트 밖으로 나가지 않는다(sink). 과금도, provider 쪽 401 누적도 없다.
- 유예 중 브로커가 돌아오면 다음 attempt가 정상 헤더로 나간다. 같은 턴 안의 재시도이므로 도구가 중복 실행되지 않는다(실패한 attempt는 출력이 없다).
- 호스트 설정 `failClosedGraceSeconds`(0–600, 기본 300)로 조절한다. 0이면 유예 없이 바로 끝낸다.

### 8.8 401과 refresh

- 원격이 **유효한 lease로** 401을 받으면(주입 hash = 응답 요청 hash) `headers.get{invalidate: authHash8}`를 한 번 보내고 `{retry:true, delay:0}`.
- 로컬 브로커의 처리는 자격 증명 출처로 나뉜다(8.5와 같은 구분).
  - **`vault`, `takeover-codex-source`**: 그 hash가 현재 값과 같을 때만 refresh를 요청한다. 로컬 single-flight와 lease 파일(02 §3.5 F2·F3)을 그대로 쓰므로, 로컬 세션과 여러 원격이 동시에 401을 받아도 refresh는 한 번이다.
  - **`linked-codex-source`**: **refresh하지 않는다**(02 §3.5 F9). 원본을 다시 읽는다(8.5와 같은 `usable()` 경로).
    - 다시 읽은 토큰의 hash가 `invalidate`의 hash와 다르면(이전 앱이 그 사이 갱신함) 새 값으로 lease를 준다.
    - 같으면 `{error:"source_stale", expiresInMs}`로 답하고, 그 호스트에 `account.status{status:"auth_failed", reason:"codex_source_stale", scope:"host"}`를 push하고, 그 slot의 lease를 `revoke`한다. 풀림은 8.5와 같다(원본의 hash가 바뀌면 `ready` push).
    - **원격의 invalidate만으로 로컬 reader를 거절 상태로 만들지 않는다.** 로컬 reader의 `reject()`(`packages/own-runtime/src/credentials.ts:168-182`)는 로컬 요청이 받은 401에만 쓴다. 원격 관측은 로컬보다 덜 믿기 때문이다(10.5). 거짓 invalidate가 로컬 세션까지 막지 못하고, 그 호스트만 막힌다. 로컬도 같은 토큰으로 401을 받으면 그때 로컬 상태가 `codex_source_stale`이 된다.
    - 호스트별 기억(`remoteRejected[hostId][accountID] = hash`)은 브로커 메모리에만 둔다. runtime reader를 바꿀 필요가 없다.
- 원격의 `invalidate`로 시작되는 refresh(vault·takeover)나 원본 재확인(linked)은 호스트·계정마다 5분에 한 번으로 묶는다. 거짓 401을 반복해 refresh를 계속 돌리게 하는 것(토큰 계열 소모, provider 제한)을 막기 위해서다. 묶인 동안에는 현재 값을 그대로 돌려주고(linked는 기억한 hash와 같으면 `source_stale`), 로컬이 직접 확인한다(10.6).
- refresh가 영구 실패하면(`invalid_grant` 등) 계정은 `needs_reauth`가 되고(02 F5), 브로커는 `account.status`와 `revoke`를 push한다. 사용자는 **로컬에서** 다시 로그인한다. 원격은 다음 요청부터 새 토큰을 받는다. linked 계정은 needs_reauth가 되지 않는다. 이전 앱에서 로그인을 갱신하거나 takeover로 바꾼다(02 §3.2a).
- 원격은 refresh를 절대 하지 않는다. refresh token을 갖고 있지 않다.

### 8.9 범위, 속도 제한, 감사, 폐기

- **계정별 원격 허용**: 계정 필드 `remote: "allow" | "deny"`(기본 `allow`, 02 §2.4.1에 추가 제안). `deny`인 계정은 브로커가 `account_not_remote`로 거절한다. 원격 세션의 모델 선택기에서도 빠진다.
- **호스트별 계정 범위**: `hosts[].accounts = {mode:"all"} | {mode:"only", ids:[…]}`. 신뢰가 낮은 호스트에는 구독 계정만 허용하는 식으로 쓴다. 호스트 키 확인이 꺼진 호스트(7.2)는 기본이 `{mode:"only", ids:[]}`다.
- **속도 제한**: 호스트당 `headers.get` 초당 30, 버스트 60. 넘으면 `rate_limited`(원격은 캐시된 lease를 쓰므로 정상 사용에서는 닿지 않는다).
- **감사**: 요청마다 쓰지 않는다(ledger 비대 방지, [old] 92). 호스트·계정별 5분 합계를 `ledger\events-YYYY-MM.jsonl`에 `remote.lease.issued {hostId, accountID, count, firstAt, lastAt}`로 남기고, `OWN_HOME\remote\<hostId>\leases.json`에 계정별 마지막 발급 시각을 둔다(6.7 안내용).
- **폐기**: 계정 삭제·비활성·키 교체·needs_reauth → `revoke` push. 호스트 제거 → 그 호스트의 K 폐기, 리스너 닫기. 원격이 이미 받은 lease는 원격 메모리에서 그 `deadline`까지 살아 있을 수 있다(15장 한계). API 키가 원격에 나갔다면 키 교체만이 확실한 폐기다.

### 8.10 하지 않는 것

- vault `get`을 원격에 여는 것. 원격은 헤더만 받는다.
- 원격에서 refresh, 로그인, 계정 추가, Codex 가져오기(`accounts.import.codex.*`는 로컬 파일을 읽으므로 `local` 범위, 02 §9.1).
- linked 계정의 refresh. 로컬에서도 원격 요청 때문에도 하지 않는다(8.5, 8.8). 원격 사용 때문에 이전 앱의 refresh token 계열을 회전시키면 이전 앱의 그 프로필이 깨진다(02 §3.1 C3).
- Claude 구독 토큰을 lease로 주거나 원격에 claude-auth를 싣는 것. Claude 구독은 PC egress 중계로만 쓴다(8.11).
- 원격에 Claude Code를 설치하거나 원격에서 Claude Code에 로그인하는 것. Claude Agent 경로의 claude는 PC에서 돈다(8.13).
- 세션 밖 LLM 호출(`generate.text`) 인증. 로컬과 같은 한계다(01 §8.3).

### 8.11 원격 Claude 구독 슬롯: PC egress 중계

이 절이 이전의 "원격에서 Claude 구독 슬롯은 비활성"을 바꿨다. 1.2의 그 비목표는 지웠고, 8.10의 "Claude 구독 슬롯 중계" 항목과 24장 19번은 이 절을 가리킨다.

| 항목 | 내용 |
|---|---|
| 상태 | 확정·결정 완료(2026-10-09, 사용자 결정은 8.11.16). 브랜치 `remote-claude`에서 구현했다. 구현에서 정한 세부는 8.11.17 |
| 기준 커밋 | `main` `34a2ac4724`. 이 절의 `path:줄`은 모두 이 커밋을 기준으로 읽어 확인했다 |
| 표기 | `CA/`는 `C:/Users/<user>/AppData/Local/own-open-code/thirdparty/claude-auth/node_modules/opencode-claude-auth-v2/dist/`이다. 설치된 서드파티 소스이며 읽기만 했다. 자격 증명 저장소는 열지 않았다 |
| 채택안 | 8.1의 안 C(로컬 egress 게이트웨이)를 Claude 구독 슬롯 하나에만 적용한다. 평가 3건이 모두 이 안을 골랐다 |

#### 8.11.0 결정 요약

1. **lease가 아니라 중계다.** 호스트의 `anthropic` 요청은 SSH 터널로 이 PC에 돌아온다. PC는 이미 로드된 claude-auth 인스턴스의 export 함수로 요청을 서명해 `https://api.anthropic.com`으로 보내고, 응답을 그대로 스트리밍해 돌려준다.
   - Claude access token, refresh token, `~/.claude` 파일 내용, 서드파티 코드는 Windows를 떠나지 않는다.
2. **전송은 호스트마다 두 번째 `-R`이다.** 경로는 `<소켓 디렉터리>/egress-<epoch>.sock`이고, TCP 대체 모드에서는 원격 loopback 포트다. 이 경로가 PC의 호스트 전용 리스너 `127.0.0.1:E_h`로 이어진다. 리스너는 HTTP/1.1이고 요청마다 연결 하나, 곧 SSH 채널 하나를 쓴다.
   - 브로커 채널은 쓰지 않는다. 브로커 채널은 1 MiB JSON 프레임, 요청/응답 전용이고 backpressure가 없다. 모르는 프레임이 오면 세션이 닫힌다(`packages/own-protocol/src/broker.ts:43,163-177`, `packages/own-accounts/src/broker/wire.ts:115-141`, `packages/own-accounts/src/broker/server.ts:404-409`).
3. **요청마다 MAC을 붙인다.** 호스트 프로세스의 hook이 헤더를 붙인다. 형식은 `x-own-egress: v2.<epoch>.<n>.<accountID>.<mac>`이고 `mac = HMAC-SHA256(K, "own-egress/v2|"+hostId+"|"+epoch+"|"+n+"|"+accountID)`이다(proof v2, 2026-10-10, 8.11.18). `accountID`는 그 대화가 묶인 PC의 Claude 계정이고, MAC이 그것까지 덮는다. v1(계정 없음)은 받지 않는다.
   - K는 기존 epoch 키다. 원격 클로저 안에만 있다(`packages/own-accounts/src/remote/client.ts:44-71`).
   - `n`은 epoch마다 1부터 단조 증가한다. PC는 1024칸 슬라이딩 창으로 재사용을 거절한다.
   - 브로커 프로토콜에는 새 메서드를 넣지 않는다. 옛 PC가 모르는 메서드를 받으면 세션을 닫기 때문이다(`server.ts:405-409`).
4. **호스트는 MAC만 붙이고 바이트를 그대로 넘긴다.** 원격 own-accounts는 `127.0.0.1:0`에 바이트 파이프 stub를 연다. `http.request` hook은 먼저 요청을 sink로 바꾸고, 중계할 수 있을 때만 마지막에 stub URL로 바꾼다. 중간에 예외가 나면 sink에 남는다.
   - `model.request`의 baseURL은 바꾸지 않는다. native compaction window가 있는 세션에서 baseURL이 바뀌면 core가 요청을 죽인다(`packages/core/src/session/model-request.ts:304-318`).
5. **신원은 PC에서 본문 수준으로 넣는다.** 같은 plugin 인스턴스의 `injectClaudeIdentity`(`CA/index.js:29-35`)를 파싱한 본문의 `system` 배열에 적용한다. core는 system part를 `{type,text,cache_control?}` 블록 하나씩으로 내린다(`packages/ai/src/protocols/anthropic-messages.ts:1050-1058`). 그래서 결과 바이트가 로컬 session hook이 넣었을 때와 같다.
6. **서명은 plugin의 local hook을 그대로 재현한다.** 순서는 다음과 같다.
   1. `prepareClaudeRequest(req, undefined, <계정 키>, {conversationID})`
   2. 첫 전송은 일반 `fetch`(core도 첫 전송을 재시도하지 않음)
   3. `finishClaudeResponse(prepared, res, <계정 키>, fetch)`

   계정 키는 proof가 이름 댄 Claude 계정의 키다(02 §8.7). 계정 하나로 도는 플러그인에서 슬롯 자신의 계정이면 `undefined`(그 플러그인의 계정)이고, 다른 계정이면 거절한다(8.11.18).

   토큰은 plugin이 자기 캐시에서 고른다(`CA/provider.js:77-92,102-153`). own 코드는 `connection.resolve`를 부르지 않고 토큰 값을 읽지 않는다. 그래서 02 F8의 "우리는 건드리지 않는다"가 글자 그대로 유지된다.
7. **호스트는 미러로 켠다.** `MirrorView.claude`라는 선택 필드를 더한다. PROTO는 1을 유지한다(T3 선례, `broker.ts:216-229`).
   - 호스트의 `plugins.claudeSlot()`는 미러 판정을 따른다. `claudeSlot()`에 기대는 다음 소비자가 함께 바뀐다: fold, R4·프리셋, 속도, ledger 귀속.
   - fold는 `anthropic`에 `activation:"enabled"`와 `cost:[]`를 둔다. 그러면 core가 연결 없이 `Auth.none`을 쓴다(`packages/core/src/model-resolver.ts:379-385`, `packages/core/src/provider.ts:393-405`).
8. **동의와 호스트별 켜기는 PC에만 기록한다.**
   - 별도 고지와 KV `ack:claudeRemote`를 둔다. 로컬 동의는 2026-10-18부터 없다(플러그인이 앱에 들어 있고 늘 켜짐, 02 §8.2·§8.4). 원격 사용만 PC마다 한 번 동의를 받는다.
   - `accounts.json`의 `claudeSlot.remoteHosts`가 호스트별 opt-in이다. 기본값은 비어 있고, 이 목록에 있는 호스트만 쓸 수 있다.
   - 호스트 계정 범위가 `only`인데 목록에 이 PC의 Claude 계정이 하나도 없으면 그 호스트에서는 계속 거절한다. 범위에 든 Claude 계정만 그 호스트에서 쓴다(8.11.18).
9. **한도의 기준은 PC 중계가 관측한 값이다.** 중계가 unified 헤더를 `origin=hostId`로 PC 한도 저장소에 올린다. 호스트에는 own-telemetry를 실어 긴 멈춤 방지(retry hook)와 extra-usage 경보를 세션 안에서 돌린다.
10. **PC의 첫 401은 PC 전역에서 한 번만 처리한다(D2).** 중계 401 회복을 single-flight로 묶고, 끝까지 401이면 그 호스트를 60초 동안 보류한다. Claude Code와 함께 쓰는 refresh token 계열이 중계 요청 때문에 연쇄 회전하는 것을 막기 위해서다.
11. **이것은 하지 않는다.**
    - Claude 토큰 lease
    - 호스트에 claude-auth 설치
    - 호스트의 refresh
    - `/v1/messages` 밖의 경로
    - 다른 provider의 중계

#### 8.11.1 목표와 비목표

**목표**
- **G-R9** 원격 세션도 Claude 구독 슬롯(`anthropic`, `acc_claude_slot`)을 쓴다. 쓸 수 있는 것은 다음과 같다.
  - 모델 선택
  - 스트리밍과 도구 호출
  - 압축과 제목
  - 하위 에이전트와 프리셋 대상
  - Fast
  - 한도 표시
- 원격 요청은 로컬 요청과 같은 바이트, 같은 IP, 같은 `x-stainless-*` 지문으로 나간다. `x-stainless-*`는 들어온 값이 없을 때만 plugin이 채우는데(`CA/provider.js:43-56`), 중계가 호스트에서 온 값을 버리므로 PC 값이 들어간다. `x-claude-code-session-id`도 PC 프로세스의 값이다(`CA/provider.js:8`).
- G-R4를 지킨다. refresh는 PC의 claude-auth 경로에서만 일어나고, 호스트에서 refresh할 수 있는 코드 경로는 없다.
- Claude 슬롯은 계속 자동 전환에 들어가지도, 나가지도 않는다(`packages/own-protocol/src/policy.ts:13-26` 미러 그대로).

**비목표**
- PC가 꺼져 있거나 터널이 없을 때 호스트에서 Claude를 쓰는 것. lease 같은 유예 토큰이 없다(8.11.8).
- 응답이 스트리밍되는 도중 SSH가 끊겼을 때 그 응답을 살리는 것.
- 원격 호스트 자신의 Claude 로그인을 쓰는 것. 그런 호스트는 충돌로 막는다(8.11.5).
- `/v1/messages/count_tokens`, files API 같은 다른 경로. 필요하면 허용 목록에 명시적으로 더한다.

#### 8.11.2 왜 이 방식인가

| 기준 | 안 C, PC egress 중계 (채택) | 안 L, Claude 토큰 lease + 호스트에서 서명 |
|---|---|---|
| 비밀 | 토큰과 서드파티 코드가 PC를 떠나지 않음 | 몇 시간 유효한 bearer가 호스트 메모리에 있음(plugin 기본 `expires_in` 36000초, `CA/credentials.js:167`) |
| 정책 | 02 §8.1, 5.2의 번들 제외, `own/vendor/claude-auth/README.md`의 규칙을 그대로 지킴 | 세 규칙을 모두 고쳐야 함 |
| 지문 | PC의 IP와 `win32` | 호스트의 IP와 `linux`, 두 곳에서 같은 토큰 사용 |
| refresh | PC의 기존 경로뿐 | core에 `resolve` 옵션과 single-flight 패치 필요(`packages/core/src/integration.ts:696-713`). 호스트의 401이 PC refresh를 부름 |
| 가용성 | PC가 켜져 있고 터널이 살아 있어야 함. SSH가 끊기면 진행 중 응답이 끊김 | lease 동안 PC 없이 동작. 스트림은 터널과 무관 |

**기각한 안 L.** 안 L은 짧은 끊김에 강하다는 장점이 있다. 그러나 다음 대가를 치러야 한다.
- 호스트 메모리에 몇 시간 유효한 Claude bearer를 둔다. 같은 프로세스의 신뢰 프로젝트 플러그인은 unscoped `http.request`로 이 헤더를 읽을 수 있다(`packages/core/src/plugin/hooks.ts:88-102`, 15장, RG17).
- plugin의 `dist/*.js`를 호스트로 복사하고, 신원 주입을 own 코드로 다시 만든다. 이것은 02 §8.1의 "번들·재배포 금지"와 "신원 위장 재구현 금지"를 정면으로 깨므로 규칙을 먼저 바꿔야 한다.
- 호스트의 401 하나가 PC에서 강제 refresh를 일으킨다. 이 refresh는 plugin의 파일 잠금 밖에서 돈다(`CA/credentials.js:791-822`). 그래서 Claude Code와 함께 쓰는 refresh token 계열을 소모한다.
- 호스트 쪽 지문이 달라져 약관 노출이 커진다.

평가 3건 모두 안 L에 치명적 결함을 매겼다. 안 C의 대가는 가용성 하나이고, 사용자가 이것을 받아들였다(8.11.16 D1).

#### 8.11.3 구성

```text
Linux 호스트 (원격 service, own.accounts·own.remote·own.team·own.telemetry)
  core: anthropic 요청 (activation enabled, 연결 없음 → Auth.none, 인증 헤더 없음)
    │ model.request (own-accounts): 경로 결정 relay | sink(+표시)
    │ http.request  (own-accounts): speed → ① sink 요청으로 먼저 교체 → ② relay면
    │               http://127.0.0.1:S/v1/messages?beta=true + x-own-egress: v2.<epoch>.<n>.<accountID>.<mac>
    ▼
  egress stub 127.0.0.1:S (바이트 파이프, 해석·서명 없음)
    │ Dial.system / Dial.placeholder
    ▼
  <소켓 디렉터리>/egress-<epoch>.sock (0600)  ─ sshd -R ─▶  ssh.exe (PC, 호스트당 터널 1개)
                                                                │
Windows PC (로컬 service)                                       ▼
  own-accounts 브로커 (호스트 h 전용 리스너 두 개)
    127.0.0.1:B_h  브로커 (프레임: lease·미러·관측, 기존)
    127.0.0.1:E_h  egress 중계 (Bun.serve, HTTP/1.1, connection: close)
       ③ 경로·MAC·카운터·속도·동시성·게이트·크기
       ④ injectClaudeIdentity(body.system)          ┐ 이미 로드된 claude-auth 인스턴스의 export
       ⑤ prepareClaudeRequest(req, undefined, key, …)    │ (CA/index.js, CA/provider.js; key = proof의 계정)
       ⑥ fetch → finishClaudeResponse(..., fetch)    ┘
       ⑦ unified 헤더 → PC 한도 저장소(origin=hostId), 감사 합계
    ▼
  https://api.anthropic.com  (PC의 IP, x-stainless-os=win32, PC 프로세스의 x-claude-code-session-id)
```

- 리스너가 호스트를 정한다. 기존 브로커 규칙과 같다(8.2, `server.ts:133-149`).
- 호스트 A의 MAC은 호스트 B의 리스너에서 통하지 않는다. MAC에 `hostId`가 들어 있고 K도 호스트마다 다르다.

#### 8.11.4 흐름

##### 8.11.4.1 켜기 (PC에서만)

1. 사용자가 PC의 Claude 카드에서 `SSH 원격 호스트에서 쓰기`를 연다(8.11.12).
2. 처음이면 원격 고지가 뜬다. 동의하면 `plugin.claudeAuth.remote.ack{version, integrity, noticeHash}`가 KV `ack:claudeRemote`를 쓴다.
   - 패턴은 `plugin.claudeAuth.ack`와 같다(`packages/own-accounts/src/plugins/plugins.ts:570-591`).
   - 그다음 `claudeSlot.changed{reason:"remote"}`를 낸다.
3. 호스트 스위치는 `plugin.claudeAuth.remote.set{hostId, enabled}`를 부른다. 이 호출은 `accounts.json`의 `claudeSlot.remoteHosts`를 고친다. 쓰는 쪽은 slots의 `mutate`이고(`packages/own-accounts/src/slots/slots.ts:769-775`), 그 결과로 `store.changed{accounts}`가 나간다.
   - 원격 동의가 유효하지 않으면 `ack_required{reason:"remote"}`를 돌려준다.
4. `BrokerHost`는 `store.changed`와 `claudeSlot.changed`를 구독한다. `claudeSlot.changed`는 오늘은 구독하지 않으므로(`packages/own-accounts/src/broker/host.ts:250-269`) 새로 더한다. 이벤트가 오면 `server.claudeChanged()`를 부른다.
   - 호스트마다 판정(8.11.4.3)을 다시 계산하고, 바뀌었으면 `mirror.changed`를 push한다.
   - `enabled`에서 벗어난 호스트는 진행 중인 egress 요청을 모두 abort한다.

##### 8.11.4.2 터널과 arm

1. own-remote `#tunnel`(`packages/own-remote/src/controller.ts:571-583`)이 `broker.listen(id)`를 부른다. 반환값은 `{port, egressPort?}`로 바뀐다.
   - egress 리스너를 띄우지 못하면 `egressPort`가 없다. 그 호스트에서는 Claude가 꺼진 채로 남는다.
2. `tunnelArgs`(`packages/own-remote/src/vendor/ssh/command.ts:212-239`)가 두 번째 `-R`를 만든다.
   - 소켓 모드: `-R <socketDir>/egress-<epoch>.sock:127.0.0.1:<E_h>`. 이름 길이가 `broker-<epoch>.sock`과 같으므로 `socketDir` 길이 검사(`packages/own-remote/src/remote/model.ts:159-167`)는 바뀌지 않는다.
   - TCP 모드: `-R 127.0.0.1:<egressTcpPort>:127.0.0.1:<E_h>`. `egressTcpPort`는 hosts.json에 저장하는 별도 무작위 포트다(`packages/own-remote/src/registry.ts:58-62`에 필드를 더함). `tcpPort+1`은 쓰지 않는다.
   - `ExitOnForwardFailure=yes`라 두 forward는 함께 성공하거나 함께 실패한다. 실패하면 기존 소켓→TCP 대체 경로를 탄다(`controller.ts:624-630`).
3. ensure가 이전 epoch의 `egress-*.sock`도 지운다(`packages/own-remote/src/remote/scripts.ts:559-566`). keep은 자기 epoch의 `egress-<epoch>.sock`을 함께 지운다(`scripts.ts:610-632`).
4. `arm`(`controller.ts:777-804`)이 `agent.broker.arm`에 `egress`를 더해 보낸다.
   - 원격 `agent.arm`(`packages/own-remote/src/agent.ts:69-99`)은 소켓이면 절대 경로인지 확인한 뒤 클라이언트에 넘긴다.
   - 클라이언트는 `Armed` 클로저에 `egress` 끝점과 MAC 카운터를 둔다(`client.ts:44-71`). `egress`가 바뀌면 `endpoint`가 바뀐 것처럼 다시 시작한다(`client.ts:120`).

##### 8.11.4.3 미러 판정과 호스트 등록

1. 판정 `ClaudeRemote.state`는 PC에서 호스트마다 계산한다. 위에서부터 처음 맞는 조건이 이긴다.

| 판정 | 조건 |
|---|---|
| `not_ready` | 서빙 인스턴스에서 `plugins.claudeSlot()`가 감지·확인 상태가 아님(2026-10-18 전에는 감지·동의)(`plugins.ts:182-191`), 또는 `anthropic` 활성 연결이 없음 |
| `billing` | 활성 연결이 `key` 또는 `env`임(`packages/own-accounts/src/plugins/claude.ts:95-100`) |
| `off` | `hostId`가 `remoteHosts`에 없음 |
| `consent` | `ack:claudeRemote`가 현재 pin(버전·integrity)이나 `REMOTE_HASH`와 맞지 않음. 판정 규칙은 `claude.ts:82-87`과 같음 |
| `host_scope` | 호스트 범위가 `only`이고 이 PC의 Claude 계정(`acc_claude_slot`과 추가한 계정, 02 §8.7)을 하나도 담지 않음. `Mirror.allowed`(`packages/own-accounts/src/broker/mirror.ts:31-34`)와 같은 규칙 |
| `enabled` | 그 밖의 경우 |

2. `registry.get`의 뷰에 `claude: {state, fast, display:{label, shortLabel, color}, accounts?:[{accountID, label, shortLabel, color, default}]}`가 붙는다. `accounts`는 호스트 범위가 허용하는 이 PC의 Claude 계정이고 표시 정보뿐이다(8.11.18).
   - PC에 슬롯이 감지되지 않았으면 필드 자체가 없다.
   - `fast`는 PC KV `ack:claudeFast`가 있는지다.
   - 이메일, 연결 label, 버전, integrity는 넣지 않는다.
   - `Backend.view(scope)`는 `view(hostId, scope)`로 바뀐다(`server.ts:428,435,500`, `broker/host.ts:209-224`).
3. 원격 미러는 `claude`를 `MirrorMeta.claude`에 저장하고 `same` 비교에 넣는다(`packages/own-accounts/src/remote/mirror.ts:140-147,175-184`). 원격이 다시 떠도 판정이 유지된다.
   - `display`는 미러한 `accounts.json`의 `claudeSlot`으로 쓴다. `remoteHosts`는 빼고 쓴다.
   - 값이 바뀌면 `claudeSlot.changed{reason:"remote"}`를 낸다.
4. 원격의 `plugins.claudeSlot()`는 `{detected: ok, acknowledged: ok, version: null, integrity: null}`을 돌려준다. `ok`는 다음 두 조건이 모두 맞을 때 참이다.
   - 미러의 `claude.state === "enabled"`
   - 그 Location에 충돌이 없음(8.11.5)
5. `setSlot`(`plugins.ts:206-217`)이 `slots.reload()`와 `presets.recheckAgents()`를 부른다. fold는 원격 모드에서 `anthropic.activation="enabled"`와 모든 `anthropic` 모델의 `cost=[]`를 둔다(`packages/own-accounts/src/slots/registration.ts:228-251`를 바꿈).
   - 비용 처리는 claude-auth fold(`CA/index.js:94-108`)와 같다.
   - core는 연결이 없으므로 `Auth.none`으로 해석한다. 그래서 인증 헤더가 붙지 않는다.

##### 8.11.4.4 요청 하나 (호스트)

1. core가 native Anthropic 요청을 만든다(`model-request.ts:261-296`). 호스트에는 claude-auth가 없으므로 session hook은 신원을 넣지 않는다.
2. `model.request`: hooks.ts의 기존 줄 뒤에 다음을 넣는다(`packages/own-accounts/src/hooks.ts:56-69`).

   ```ts
   if (remote && event.model.providerID === "anthropic")
     await hook.safe("model.request:claude", () => remote.claudeRoute(event, trust), undefined)
   ```

   `claudeRoute`가 하는 일은 다음과 같다.
   1. `event.headers`에서 `authorization`, `x-api-key`를 지운다.
   2. 경로를 정한다. 아래에서 처음 맞는 줄이 이긴다.

| 조건 | 경로 | 표시 |
|---|---|---|
| 미러 판정이 `enabled`가 아님 | sink | `refused{code: state}` |
| Location 충돌 | sink | `refused{code:"conflict"}` |
| Location trust가 `ok`가 아님. 판단은 auth.ts와 같음(`packages/own-accounts/src/auth/auth.ts:297-303`) | sink | `blocked` |
| egress 끝점이 없거나 브로커가 끊김. 첫 attempt만 `brokerWaitMs`까지 기다림(`packages/own-accounts/src/remote/host.ts:373-377`과 같은 규칙) | sink | `unavailable` |
| 그 밖 | relay | 없음 |

   예외가 나면 경로가 남지 않는다. 경로가 없으면 sink로 본다.
3. `http.request`(`hooks.ts:73-76`): 순서는 speed 다음이 remote다.
   1. `anthropic`이면 원본의 clone으로 만든 sink 요청을 먼저 `event.request`에 넣는다. 만드는 법은 `host.ts:493-501`과 같다.
   2. relay일 때만 마지막에 새 Request로 바꾼다.
      - URL: `http://127.0.0.1:S` + 원본 pathname·search
      - 헤더: 원본에서 `authorization`, `x-api-key`, `cookie`, `x-stainless-*`를 빼고 `x-own-egress`를 더함
      - body: 원본 그대로(`duplex:"half"`)

   중간에 예외가 나면 요청은 sink에 남는다. WS handshake는 `anthropic`이면 언제나 sink로 보낸다(`host.ts:503-506`).
4. core는 본문을 버퍼링해 stub로 보낸다(`model-request.ts:330-337`). stub는 연결마다 egress 끝점을 dial한다. 기존 `Dial.system` / `Dial.placeholder`를 재사용한다(`packages/own-accounts/src/remote/dial.ts:15-29`). 그다음 양방향으로 파이프하고, 반쪽 닫힘과 destroy를 양쪽으로 전한다.
   - 반쪽 닫힘(FIN)은 반쪽 닫힘으로 전한다. PC의 HTTP 중계는 요청이 끝난 연결의 FIN을 연결 끝으로 보고 upstream을 끊는다.
   - 끝내지 않고 닫힌 쪽(reset, 중단, 떠난 상대에 쓰기 실패)은 상대를 reset한다. 상대는 정상 끝이 아니라 실패를 본다.
   - stub는 MAC을 만들 수 없다. 그래서 같은 호스트의 다른 프로세스, 원격 브라우저 패인의 loopback 접근(7.6), 셸 도구가 stub에 닿아도 PC에서 401로 끝난다.

##### 8.11.4.5 PC 중계 (`packages/own-accounts/src/broker/egress.ts`, 새 파일)

`Bun.serve({hostname:"127.0.0.1", port:0, idleTimeout:30})`는 호스트마다 하나다. 검증이 끝나면 `server.timeout(req, 0)`을 건다(선례: `packages/own-remote/src/gateway/server.ts:553`).

요청은 다음 순서로 거른다. 앞 단계에서 실패하면 뒤 단계는 하지 않는다.

1. `POST`이고 pathname이 정확히 `/v1/messages`이며, query가 비었거나 정확히 `beta=true`여야 한다. 아니면 404/405 `bad_request`.
   - Host 헤더와 절대 형식 URL은 읽지 않는다. upstream origin은 상수다.
2. MAC 검사(proof v2).
   - 형식이 `v2.<epoch>.<n>.<accountID>.<mac>`이어야 한다. v1은 401 `mac`이다.
   - `epoch`가 현재 `host.key.epoch`와 같아야 한다.
   - `n`은 창 안에서 처음 보는 값이어야 한다.
   - MAC은 상수 시간으로 비교한다(`wire.ts:66-75`의 방식).
   - 실패하면 401 `mac`이다. 실패는 **egress 전용** 버킷(호스트당 분당 20회)에 센다. 넘으면 그 분 동안은 새 egress 요청을 읽지 않고 고정 401 `mac`(`connection: close`)으로 바로 답한다. 아무 검사도 하지 않는다(8.11.17).
   - 브로커 handshake 버킷(`server.ts:313-319`, 분당 5회)은 쓰지 않는다. 같은 버킷을 쓰면 egress 포트에 대한 공격이 브로커 재연결까지 막기 때문이다.
3. 호스트당 초당 10회(버스트 30)와 동시 16개 제한. 넘으면 429 `rate_limited` 또는 `busy`.
4. 판정이 `enabled`가 아니면 403 `<state>`. 60초 보류 중이면 403 `needs_reauth`. proof의 `accountID`가 이 PC의 Claude 계정이 아니거나 호스트 범위 밖이면 403 `host_scope`(다른 계정으로 바꿔 서명하지 않음, 8.11.18).
5. `content-length`가 32 MiB를 넘으면 413 `too_large`. 본문은 상한을 걸고 읽으며, 업로드가 120초를 넘으면 408 `bad_request`로 끊는다.
6. JSON 파싱. 실패하면 400 `bad_request`.
   - `body.system`을 정규화한다. 문자열이면 `[{type:"text",text}]`, 없으면 `[]`로 바꾼다. text가 아닌 블록이 있으면 400.
7. wire 로더(8.11.5)에서 함수를 받는다. 없으면 403 `not_ready`(detail `wire`).
8. 다음을 차례로 한다.
   1. `injectClaudeIdentity({model:{providerID:"anthropic"}, system: body.system})`
   2. `new Request("https://api.anthropic.com/v1/messages"+search, {method, headers: 허용목록(req.headers), body: JSON.stringify(body), signal: ctrl.signal})`
   3. `prepared = await prepareClaudeRequest(request, undefined, key, {conversationID: x-opencode-session-id})`. `key`는 proof 계정의 키다. 다른 계정인데 플러그인이 계정 하나로 돌면 403 `not_ready`. `credentials are unavailable`(그 계정의 로그인 없음 포함)로 throw하면 403 `not_ready`(detail `credentials`).

   요청 헤더 허용 목록은 `content-type`, `accept`, `anthropic-version`, `anthropic-beta`, `x-opencode-*`, `x-session-affinity`, `x-session-id`, `x-parent-session-id`다. core가 로컬에서도 보내는 헤더들이다(`model-request.ts:265-275`).
9. `initial = await fetch(prepared.clone())`. plugin이 `finishClaudeResponse`에서 `prepared`의 본문을 다시 읽으므로 사본을 보낸다. 연결 실패면 502 `upstream_unreachable`.
   - 첫 전송과 plugin의 재전송(`send`)은 Bun fetch의 기본 시간 제한을 끄고(`timeout:false`) 신호로만 끊는다(8.11.7).
   - `initial.status === 401`이면 PC 전역 single-flight 안에서 `finishClaudeResponse(prepared, initial, undefined, send)`를 부른다(D2). 그 밖이면 바로 부른다.
   - single-flight 차례가 왔을 때 그 호스트가 이미 보류 중이면(앞 요청의 회복이 실패) `finish`를 부르지 않고 403 `needs_reauth`로 답한다. 그래서 강제 refresh가 다시 일어나지 않는다.
   - 최종 응답이 401이면 그 호스트를 60초 보류한다.
10. `Unified.parse(final.headers, now, final.ok ? "header" : "error", accountID)`로 얻은 창을 `origin=hostId`로 `runtime.limits.upsert`하고 `limits.updated`를 broadcast한다(8.11.10). 창은 proof 계정의 것이다.
11. 응답 헤더를 정리한다.
    - 빼는 것: hop-by-hop 헤더, `content-length`, `content-encoding`, `set-cookie`
    - 더하는 것: `connection: close`, `x-own-egress: 1`

    본문은 track 스타일 래퍼로 감싸 흘린다(`gateway/server.ts:624-653`). 래퍼의 `cancel`은 `ctrl.abort()`도 부른다.
12. 감사: 5분 합계를 events ledger에 남긴다. 형식은 `remote.egress.claude{hostId, count, bytesIn, bytesOut, statuses, refusals}`다. 본문과 헤더 값은 남기지 않는다.

##### 8.11.4.6 응답 (호스트)

1. stub가 응답 바이트를 core로 보낸다. 도구 이름은 PC의 `transformResponseStream`이 이미 되돌려 놓았다(`CA/transforms.js:497-560`).
2. own-accounts `http.response`에서 `isSink`나 `x-own-egress-error` 응답이면 표시만 남기고 관측 모듈을 건너뛴다(`hooks.ts:110-117`를 넓힘).
   - 일반 응답에서는 speed가 served tier를 읽는다.
   - ledger 줄은 `accountID: acc_claude_slot`으로 만든다(`packages/own-accounts/src/telemetry/telemetry.ts:247-252`). 그 줄은 spool로 간다.
3. own-telemetry(호스트 4번 플러그인)는 `lastResponse`, 호스트 한도 창, extra-usage 경보를 처리한다(`packages/own-telemetry/src/observe.ts:55-85`).
   - `x-own-egress-error` 응답과 sink 응답은 건너뛴다. 이를 위해 sink는 `x-own-fail-closed: sink` 헤더를 더한다(`packages/own-accounts/src/remote/sink.ts:30`).

##### 8.11.4.7 버전 차이

| 조합 | 결과 |
|---|---|
| 새 PC + 옛 호스트 | 옛 arm 스키마는 `egress`를 무시하고(Effect Struct 기본 동작), 옛 미러 decode는 `claude`를 무시한다. 호스트의 `anthropic`은 비활성으로 남는다 |
| 옛 PC + 새 호스트 | arm에 `egress`가 없고 뷰에 `claude`가 없다. `detected:false`이므로 비활성이다 |
| drain 모드(5.7) | `registry.get`이 막혀 호스트는 `MirrorMeta.claude`를 그대로 쓴다. PC 중계가 요청마다 판정을 다시 보므로 상한은 PC가 정한다 |
| PC 롤백 중 원격 Claude 턴 | 새 arm에 `egress`가 없다. 다음 요청은 sink로 가고 유예 뒤 멈춘다 |

PROTO와 `MIRROR_SCHEMA_VERSION`은 그대로다(`broker.ts:36,46`).

#### 8.11.5 비밀

- **호스트에 가지 않는 것**
  - Claude access token과 refresh token
  - `~/.claude` 파일 내용
  - claude-auth 코드. REMOTE_PLUGINS에는 own-telemetry만 더하고, release-smoke가 표식 문자열을 검사한다(8.11.14).
  - K는 지금처럼 arm으로 원격 클로저에만 간다.
  - 호스트 쪽에 남는 egress 비밀은 요청마다 바뀌는 MAC 하나다. 일회성이고 epoch마다 바뀐다.
- **PC에서 own 코드는 토큰을 읽지 않는다**
  - 중계는 `connection.resolve`를 부르지 않는다. 게이트는 `connection.active`의 메타데이터만 본다(`plugins.ts:240-244`, `claude.ts:95-100`).
  - `prepareClaudeRequest`에는 `accessToken=undefined`를 넘긴다. 그래서 plugin이 자기 계정 캐시에서 토큰을 고르고(`CA/provider.js:80-85`), 토큰은 plugin 모듈 상태와 plugin이 만든 `Request` 헤더 안에만 있다.
  - 공유 인스턴스 진단은 `getActiveAccount() !== null`라는 null 검사 하나다. 반환값은 보관하지도, 들여다보지도 않는다. 시험이 이것을 확인한다.
- **같은 인스턴스를 쓴다**
  - 로더는 그 Location의 활성 claude-auth 항목 경로(`packages/own-accounts/src/plugins/inventory.ts:46-48,86-88`)에서 `Bun.resolveSync("opencode-claude-auth-v2", shimDir)`를 부른다. 그러면 core가 `server.js`에서 import한 것과 같은 `node_modules` 파일이 나온다.
  - Bun은 `node_modules` 모듈을 다시 불러오지 않는다(`packages/plugin/src/source.bun.ts:15`). 그래서 setup이 이미 계정을 채운 인스턴스를 그대로 쓴다.
  - 확인 방법은 `getActiveAccount() !== null`이다. `null`이면 경로 대소문자 차이 같은 이유로 두 번째 빈 인스턴스가 생겼거나, 자격 증명 파일이 없는 경우다. 어느 쪽이든 `not_ready`(`wire`)로 거절하고 빈 인스턴스로 대신 돌리지 않는다.
  - `prepareClaudeRequest`, `finishClaudeResponse`, `injectClaudeIdentity`, `getActiveAccount`가 함수가 아니면 `incompatible`이다.
  - 로더는 setup, refresh, authorize를 부르지 않는다.
- **upstream origin은 상수다** `https://api.anthropic.com`이다. 시험에서만 `options.broker.claudeUpstream`으로 바꾸며, loopback만 받는다. 호스트가 준 Host, 절대 URL, `beta=true` 밖의 query는 쓰지 않는다.
  - claude-auth의 rewrite가 host를 확인하지 않는다는 문제(02 §8.3 I5)가 원격 경로로 번지지 않게 하기 위해서다.
- **호스트의 Claude 로그인을 쓰지 않는다**
  - start.sh는 계속 `ANTHROPIC_*`, `CLAUDE_*`, `OPENCODE_CLAUDE_AUTH_*`를 지운다(`scripts.ts:641-656`).
  - 호스트 Location에 claude-auth가 보이거나(`Inventory.claude`, `inventory.ts:86-88`) 원격 DB에 `anthropic` 활성 연결이 있으면 **충돌**이다.
    - 그 Location은 `detected:false`, `anthropic` 비활성이 되고, `claude_remote_conflict` 경보를 낸다.
    - 그렇지 않으면 호스트 claude-auth의 hook이 우리보다 먼저 호스트 `~/.claude` 토큰으로 서명하고 PC가 본문을 한 번 더 바꾸게 된다(`CA/index.js:137-152`, `CA/provider.js:80-83`). 이것은 R4/U5 위반이다.
  - 호스트 쪽 `x-api-key`와 `authorization`은 `model.request`, `http.request`, PC 허용 목록에서 세 번 걸러진다. plugin도 `x-api-key`를 지운다(`CA/provider.js:57`).
- **남는 위험**
  - 같은 uid로 원격 service 메모리를 읽을 수 있는 프로세스는 터널이 살아 있는 동안 MAC을 만들 수 있다. lease와 같은 등급의 위험이다(15장).
  - 다음으로 묶인다: 경로 허용 목록, 고정 origin, 32 MiB 상한, 초당 10회, 동시 16개, 호스트별 스위치, 감사.
  - 토큰 자체는 얻을 수 없다.
- **기록**: 중계와 stub는 헤더 값, 본문, MAC, 카운터를 로그에 남기지 않는다. 오류 응답은 고정 코드만 돌려주고 요청 내용을 되돌려 보내지 않는다.

#### 8.11.6 refresh

- **호스트**: 할 수 있는 경로가 없다.
  - claude-auth, `anthropic` 연결, `~/.claude` 읽기, refresh token이 모두 없다.
  - 호스트는 `headers.get{invalidate}`도 보내지 않는다. Claude는 lease 경로를 쓰지 않는다(`auth.ts:284-286`은 own slot 전용).
- **PC**: refresh는 기존 경로 셋으로만 일어난다.
  1. **plugin `refreshIfNeeded`**: 만료 60초 이내에 돈다. 프로세스 안 single-flight와 파일 잠금을 쓰고, 다른 프로세스가 바꾼 파일을 채택한다(`CA/credentials.js:423-442`). 중계의 `prepareClaudeRequest`가 이 경로를 탄다.
  2. **core `resolve`**: 만료 5분 이내에 돈다(`packages/core/src/integration.ts:709-713`). PC 로컬 요청과 plugin 자기 hook만 이 경로를 부르고, 중계는 부르지 않는다.
  3. **`finishClaudeResponse`의 401 회복**(`CA/provider.js:118-127`): 먼저 파일을 다시 읽어 Claude Code가 바꾼 토큰을 채택한다. 그래도 같은 토큰이면 `forceRefreshActiveAccount`를 부르는데, 이 함수에는 잠금도 in-flight 묶음도 없다(`CA/credentials.js:791-822`). 그래서 중계 쪽에서 다음 두 가지를 더한다.
     - **PC 전역 single-flight(D2).** 첫 응답이 401인 중계 요청의 `finish`는 한 번에 하나만 돈다. 뒤에 기다린 요청은 앞 요청이 write-back한 파일을 `reloadCredentialsFromSource`로 채택하므로 네트워크 refresh를 다시 하지 않는다.
     - **호스트별 60초 보류.** 최종 401이면 그 호스트의 egress를 60초 동안 `needs_reauth`로 거절한다. 병렬 하위 에이전트가 강제 refresh를 연달아 일으키지 않게 하기 위해서다.
- **남는 경쟁**: PC 로컬 세션과 중계가 동시에 만료 근처에 닿으면 core `resolve`(잠금 없음)와 plugin 경로가 겹칠 수 있다. 이것은 오늘 로컬에도 있는 조건이고, 중계가 새로 만든 경쟁은 아니다.
- **CLI 대체**: plugin의 refresh가 끝내 실패하면 PC에서 `claude -p`가 돌 수 있다(`CA/credentials.js:317`, 고지 5번). 원격 사용도 이것을 일으킬 수 있으므로 원격 고지에 적는다.

#### 8.11.7 스트리밍과 취소

- **흐름 제어**: 요청마다 SSH 채널이 하나이고, 채널마다 SSH 자체 흐름 제어가 있다. PC는 `ReadableStream`의 pull로, stub는 `pipe`로 backpressure를 전한다.
  - Win32-OpenSSH에서 이것이 실제로 되는지는 RG18이 측정한다.
- **시간 제한**
  - core의 header·chunk 시간 제한(기본 300초, `packages/core/src/provider.ts:156,164-168`)이 호스트 쪽 상한이다.
  - 중계는 검증이 끝나면 `server.timeout(req, 0)`을 걸고, upstream `fetch`에는 시간 제한을 두지 않는다. 신호로만 끊는다.
- **사용자 중단**: 다음 순서로 Anthropic 요청까지 끊긴다.
  1. core가 HttpClient 요청을 abort한다.
  2. stub로 가는 TCP가 닫힌다.
  3. stub가 egress 소켓을 destroy하고, sshd가 채널을 닫는다.
  4. ssh.exe가 `E_h` 연결을 닫는다.
  5. Bun.serve의 `req.signal`이 abort되고 `ctrl.abort()`가 불린다.
  6. upstream `fetch`가 끊긴다. `finishClaudeResponse`의 재전송도 같은 `request.signal`을 쓰므로 함께 끊긴다(`CA/provider.js:90,98`).
  - `transformResponseStream`에는 `cancel`이 없다(`CA/transforms.js:497-560`). 그래서 래퍼의 `cancel`이 `ctrl.abort()`를 직접 부른다.
  - 남는 틈: `getCredentialsWithBackoff`의 최대 45초 대기는 신호를 받지 않는다(`CA/credentials.js:864-926`, 호출부 `{}`). 로컬과 같은 한계다.
- **터널 끊김(터널의 ServerAlive 4초×2, own.15 전에는 15초×3; 6.3 "죽은 링크")**
  - 모든 채널이 닫히고 PC가 upstream을 abort한다. 반쯤 열린 상태면 최대 약 12초(own.15 전에는 약 60초) 동안 생성이 계속될 수 있다.
  - 호스트 core는 출력이 시작된 뒤의 실패를 다시 보내지 않는다. 재시도는 `!recorded.outputStarted`일 때만이다(`packages/core/src/session/runner/step.ts:192-196`).
  - 그 단계는 실패로 기록되고 부분 출력은 남는다. 사용자는 다시 연결한 뒤 `계속`을 누른다.
- **업로드**: 호스트에서 PC로 본문을 한 번 올리고, PC가 Anthropic으로 다시 올린다. 첫 바이트까지 SSH 왕복 한 번이 더 든다.

#### 8.11.8 401·429·긴 문맥과 중계 거절

| 응답 | 어디서 | 호스트 처리(`retryBefore`, `host.ts:510-543`을 넓힘) |
|---|---|---|
| Anthropic 2xx/4xx/5xx(`x-own-egress: 1`) | upstream | 정상 분류다. own-accounts telemetry는 `anthropic`을 건너뛰고, own-telemetry가 긴 멈춤을 판단한다(`packages/own-telemetry/src/observe.ts:87-127`) |
| 최종 401(PC 회복 실패 뒤) | upstream | core는 인증 오류로 보고 재시도하지 않는다. 이후 60초 동안 요청은 `needs_reauth`로 거절된다 |
| 429 | upstream | `finishClaudeResponse`가 파일의 토큰이 바뀌었으면 한 번 다시 보낸다(`CA/provider.js:128-138`). 그 밖에는 core schedule을 따르고, `rejected`이거나 retry-after가 15분을 넘으면 own-telemetry가 `{retry:false}` |
| 긴 문맥 400/429 | upstream | `finishClaudeResponse`가 `context-1m`과 `interleaved-thinking` beta를 차례로 빼고 다시 보낸다(`CA/provider.js:139-149`). 제외 상태는 PC 프로세스 전역이고 모델이 바뀌면 초기화된다(`CA/betas.js:11-28`). 로컬과 같다 |
| `x-own-egress-error: mac`(401) | PC | 첫 번째는 즉시 다시(`delay:0`, epoch가 바뀌는 중일 수 있음). 두 번째부터는 `unavailable`과 같은 유예 |
| `off`, `host_scope`, `consent`, `not_ready`, `billing`, `needs_reauth`(403), `too_large`(413), `bad_request`(400/404/405) | PC | `{retry:false}`와 `claude_remote_refused` 경보(세션과 코드마다 한 번) |
| `busy`, `rate_limited`(429) | PC | `{retry:true, delay:2000}`. core의 10회 상한(`packages/core/src/session/runner/retry.ts`) 안에서 |
| `upstream_unreachable`(502) | PC | 정상 분류(출력 전 일시 오류) |
| sink 401 | 호스트 | 기존 유예(`host.ts:514-530`). 끝나면 `broker_unavailable` 경보(기존 문구 그대로) |

- 중계 거절은 호스트 `http.response`에서 `x-own-egress-error`를 보고 표시만 남긴다. own 관측 모듈과 own-telemetry는 그 응답을 provider 응답으로 세지 않는다.
- 이 표의 어떤 경우에도 호스트가 refresh를 요청하는 일은 없다.

#### 8.11.9 Fast

- 요청 쪽은 바뀌지 않는다. 호스트의 own-accounts speed가 egress로 바꾸기 **전에** 본문의 `speed:"fast"`와 `anthropic-beta`의 `fast-mode-2026-02-01`을 넣는다(`hooks.ts:73-76`, 02 §8.3 I5a).
  - 중계는 `anthropic-beta`를 그대로 넘기고, plugin은 들어온 beta를 자기 beta와 합친다(`CA/provider.js:31-37`).
- 제안: `SpeedOffers.target`은 `claudeSlot().detected`를 따르므로(`packages/own-accounts/src/speed/offers.ts:101-116`) 호스트에서도 Fast가 제안된다.
- 동의는 PC에만 기록한다.
  - 원격 `consented()`(`packages/own-accounts/src/speed/speed.ts:206-211`)는 미러의 `claude.fast`를 읽는다. 캐시하지 않는다.
  - 원격 `session.speed.set`은 동의가 없으면 KV에 쓰지 않는다(`speed.ts:411-416`). 대신 `speed_consent_required{recordOn:"local"}`로 거절한다.
  - own-web은 기존 Fast 동의 카드를 보이고, PC의 새 메서드 `plugin.claudeAuth.fastAck`(범위 `local`)를 부른다. 이 메서드가 PC KV `ack:claudeFast`를 쓰고 `claudeSlot.changed{reason:"fast"}`를 내면 `mirror.changed`가 따라 나간다. own-web은 그 뒤 원격 `session.speed.set`을 다시 부른다(최대 10초).
- served tier는 호스트 speed가 응답 사본에서 읽는다. 응답 본문은 tool 이름 말고는 바뀌지 않는다.

#### 8.11.10 텔레메트리와 한도

- **한도 창**
  - 기준 관측자는 PC 중계다. `Unified.parse`로 `claude.5h`, `claude.7d`, `claude.overage` 창을 만들고 PC 시계, `origin=hostId`로 올린다.
  - `limits.updated`가 나가면 다른 호스트에는 `quota.updated`가 가고, 출발 호스트에는 다시 보내지 않는다(`server.ts:270-275`).
  - `Unified`와 `ExtraUsage`는 own-telemetry의 순수 함수인데(`packages/own-telemetry/src/unified.ts`, `extra-usage.ts`), `@own/protocol`로 옮겨 own-accounts도 쓸 수 있게 한다.
- 호스트의 own-telemetry도 자기 runtime 한도에 같은 창을 올린다. 호스트 쪽 retry 판단과 표시용이다.
  - 호스트 spool은 `acc_claude_slot` 창을 빼고 보낸다(`host.ts:272`에 필터를 둠). 그렇지 않으면 PC가 그 항목 전체를 거절하고 `remote_observation_rejected`를 낸다(`packages/own-accounts/src/broker/observe.ts:118-132`).
  - PC는 호스트가 보고한 `anthropic` 창을 지금처럼 거절한다.
- **ledger**
  - 호스트 줄은 `accountID: acc_claude_slot`, 비용 없음으로 만들어져 spool로 간다.
  - PC `accountOf`(`observe.ts:77-80`)는 `anthropic`을 다음 두 조건이 맞을 때만 `acc_claude_slot`으로 바꾼다. 그 밖에는 `null`이다.
    - PC에 슬롯이 있다.
    - `hostId`가 `remoteHosts`에 있다.
  - `server = hostId`는 그대로다(`observe.ts:108-115`). 범위를 판정 전체가 아니라 `remoteHosts`로 잡은 이유는 spool이 늦게 도착하는 경우를 받기 위해서다.
- **소진**
  - own-telemetry는 소진 기록을 감싸지 않은 runtime ledger에 쓴다(`packages/own-telemetry/src/observe.ts:109-126`).
  - 그래서 원격 own-accounts가 `exhausted` broadcast(`providerID:"anthropic"`)를 구독해 `event{type:"exhaustion"}` 항목으로 spool에 넣는다. PC는 `event` 경로(`observe.ts:133-152`)로 events ledger에 남긴다.
- **extra-usage**: own-telemetry가 그 원격 세션에 `claude_extra_usage` 경보를 낸다(`packages/own-telemetry/src/observe.ts:76-84`).
- **보정과 합계**: Claude 슬롯의 사용량, 한도 막대, "사용 중" 목록에 원격 사용이 호스트별로 들어간다.

#### 8.11.11 프리셋·하위 에이전트·R4

- 호스트의 `claudeSlot().detected`가 미러를 따르므로 다음 소비자가 함께 맞춰진다. 로직은 바꾸지 않는다.
  - R4 멤버, 묶음, 구독 판정(`packages/own-accounts/src/presets/access.ts:106-123`)
  - 프리셋 inventory(`presets/resolve.ts:95,167`)
  - planner(`switching/planner.ts:207`)
  - title 필터
- `detected`가 참이 되는 때는 fold가 `anthropic`을 켤 때와 정확히 같다. 그래서 `anthropic`이 내장 provider로 잘못 보이는 U5 누수가 없다.
- 원격 메인이 Claude이면 하위 에이전트도 같은 중계를 쓴다. 호스트당 동시 16개 상한 안이고, 넘으면 `busy`로 짧게 다시 시도한다.
- 자동 전환 정책은 미러 그대로다. Claude 슬롯은 다른 회사와의 자동 전환에 들어가지도 나가지도 않는다(`policy.ts:13-26`). Claude 계정끼리는 `claudeToClaude`(02 §8.8, 2026-10-10)를 따른다.
- R4는 `acc_claude_slot`을 Anthropic 구독 하나로 센다(`access.ts:247`). 이 PC의 Claude 계정이 여럿이어도 트리·팀 하나는 언제나 Claude 계정 하나로 묶이므로(02 §8.7, 07 §5.4) 같다. 호스트 자신의 Claude 로그인은 충돌로 막으므로 두 번째 Anthropic 구독이 생기지 않는다.

#### 8.11.12 동의와 배지

- **원격 고지 `RemoteNotice.TEXT`**
  - `packages/own-accounts/src/plugins/notice.ts`에 `REMOTE_TEXT`와 `REMOTE_HASH`로 더한다. `TEXT`와 `HASH`(`notice.ts:10-24`)는 그대로다.
  - own-web은 지금처럼 문구를 복사해 쓴다(`notice.ts:8`).

  ```text
  SSH 원격 호스트에서 Claude 구독 쓰기 — 약관 위험이 더 커집니다
  1. 켠 호스트의 요청은 이 PC로 돌아와 이 PC의 Claude 로그인으로 Anthropic에 보내집니다. 로그인 토큰과 갱신 토큰은 호스트로 가지 않습니다.
  2. Anthropic 약관은 구독 로그인으로 다른 곳의 요청을 중계하는 것을 허용하지 않습니다. 원격 사용은 이 위험을 더 키웁니다.
  3. 이 PC가 켜져 있고 호스트와 연결되어 있어야 합니다. 응답 도중 연결이 끊기면 그 응답은 거기서 끝납니다.
  4. 그 호스트에서 own-open-code로 일하는 에이전트와 하위 에이전트가 이 구독을 씁니다. 이 PC의 사용과 같은 5시간·주간 한도를 함께 씁니다.
  5. 원격 요청이 로그인 거절이나 토큰 갱신을 일으킬 수 있습니다. 이 토큰은 Claude Code와 함께 쓰므로 다시 로그인해야 할 수 있습니다.
  6. 호스트마다 켜고 끌 수 있습니다. 끄면 진행 중인 응답도 멈춥니다.
  위 내용을 이해했으며, 본인 책임으로 사용합니다.
  ```

- **KV `ack:claudeRemote`** = `Plugin.ClaudeRemoteAck {acknowledgedAt, pluginVersion, integrity, noticeHash}`. own-accounts 네임스페이스이고, PC service에만 있다.
  - 유효 조건: 이 PC의 슬롯이 앱의 번들로 확인되었고(2026-10-18 전에는 로컬 `ack:claudeAuth`가 유효함), 세 값이 번들의 pin(`plugin.claudeAuth.status.bundle`)과 `REMOTE_HASH`와 같아야 한다.
  - 앱 업데이트로 plugin 버전이 바뀌면 원격 동의를 다시 묻는다.
- **호스트별 켜기**
  - 스위치는 호스트마다 하나이고 **슬롯 전체**(이 PC의 모든 Claude 구독 계정, 8.11.18)에 걸린다. `remote.set`은 계정을 이름 대지 않는다. 그래서 own-web은 이 칸을 첫째 계정 카드 안이 아니라 **모든 Claude 계정 카드 아래의 따로 된 블록**(`claude-remote-block`)에 둔다(2026-11-22, SLM). 설명은 "켠 호스트에서 이 PC의 모든 Claude 구독 계정으로 작업할 수 있어요…"이고, Claude Agent 계정과 로컬 모델은 스위치 없이 호스트 계정 범위로 정한다는 줄(`own.claude.remote.others`)을 붙인다. 호스트 쪽에서 PC를 거쳐 쓰는 종류를 한곳에서 보는 자리는 설정 > SSH 원격 호스트의 호스트 칸이다(`Claude 구독` 행, `로컬 모델` 행, 8.14.2).
  - `Registry.ClaudeSlot.remoteHosts: optional(Array(HostID))`(`packages/own-protocol/src/registry.ts:124-131`에 더함). 기본값은 없음이고, 없으면 거부다.
  - `remote.set{enabled:true}`는 원격 동의가 유효할 때만 받는다.
  - 호스트 id는 무작위 `h-xxxxxx`라 다시 쓰이지 않는다(`packages/own-remote/src/registry.ts:107`). 그래서 지운 호스트의 id가 남아도 해가 없다.
- **원격에서의 관리 메서드**: `plugin.claudeAuth.remote.ack`, `remote.set`, `fastAck`는 원격에서 `remote_managed`로 거절한다(`packages/own-accounts/src/rpc/register.ts:52-83`에 더함). 범위는 `local`, 위치는 `control`이다(`packages/own-protocol/src/rpc-routing.ts:77-84,127-135`에 더함).
- **배지**
  - Claude 행은 어디서나 고정 배지 `비공식/서드파티 플러그인 — 약관 위험`을 그대로 단다.
  - 원격 세션의 전환기와 세션 머리줄에서는 Claude 계정 칩 옆에 `PC 경유` 칩을 더한다.

#### 8.11.13 UI 문구

**더할 것.** 원격 문구는 own-web `src/remote/strings.ts`에, Claude 카드 문구는 `src/i18n/ko.ts`와 `en.ts`에 둔다.

| 키 | 한국어 |
|---|---|
| `own.claude.remote.title` | SSH 원격 호스트에서 쓰기 |
| `own.claude.remote.help` | 켠 호스트에서 이 PC의 모든 Claude 구독 계정으로 작업할 수 있어요. 요청은 이 PC를 거쳐 나가고, 로그인 토큰은 호스트로 가지 않아요. 이 PC가 켜져 있어야 해요. (2026-11-22에 "모든 Claude 구독 계정"으로 바꿈) |
| `own.claude.remote.others` | Claude Agent 계정과 로컬 모델은 따로 켜지 않아요. 호스트의 계정 범위에 들어 있으면 이 PC를 거쳐 써요(설정 > SSH 원격 호스트). |
| `own.claude.remote.notice.title` | 원격 호스트에서 Claude 구독 쓰기 |
| `own.claude.remote.notice.continue` | 동의하고 켜기 |
| `own.claude.remote.state.enabled` | 사용 중 |
| `own.claude.remote.state.off` | 꺼짐 |
| `own.claude.remote.state.hostScope` | 이 호스트의 계정 범위에 Claude 구독이 없습니다 |
| `own.claude.remote.state.consent` | 원격 사용 동의가 필요합니다 |
| `own.claude.remote.state.notReady` | 이 PC의 Claude 구독이 준비되지 않았습니다(플러그인·로그인) |
| `own.claude.remote.state.billing` | 이 PC의 Anthropic 연결이 API 키라 원격에서 쓰지 않습니다 |
| `own.claude.remote.state.disconnected` | 호스트와 연결되어 있지 않습니다 |
| `own.claude.remote.state.reauth` | Anthropic이 로그인을 거절했습니다. 이 PC에서 Claude Code에 다시 로그인하세요 |
| `own.remote.settings.claude` | Claude 구독 |
| `own.remote.settings.claudeHint` | PC의 Claude 카드에서 켜고 끕니다 |
| `own.remote.claudeSlot.badge` | PC 경유 |
| `own.remote.claudeSlot.badgeHelp` | 이 호스트의 Claude 요청은 이 PC를 거쳐 나갑니다 |
| `own.remote.claudeSlot.off` | PC에서 이 호스트의 Claude 구독이 꺼져 있습니다 — PC의 Claude 카드에서 켜세요 |
| `own.remote.claudeSlot.hostScope` | 이 호스트의 계정 범위에 Claude 구독이 없습니다 |
| `own.remote.claudeSlot.consent` | PC에서 원격 사용 동의가 필요합니다 |
| `own.remote.claudeSlot.notReady` | PC의 Claude 구독이 준비되지 않았습니다(플러그인·로그인) |
| `own.remote.claudeSlot.billing` | PC의 Anthropic 연결이 API 키라 원격에서 쓰지 않습니다 |
| `own.remote.claudeSlot.offline` | PC와 연결되면 쓸 수 있습니다 |
| `own.remote.claudeSlot.conflict` | 이 호스트에 다른 Claude 로그인이나 claude-auth 플러그인이 있어 쓰지 않습니다 |
| `own.remote.claudeSlot.fastLocal` | Fast 동의는 이 PC에 한 번 기록합니다 |

**경보 메시지.** 서비스 코드에 둔다. 새 코드는 `claude_remote_refused`(warning)와 `claude_remote_conflict`(warning)다.
- `refused/off`: `PC에서 이 호스트의 Claude 구독이 꺼져 있어 이번 턴을 멈췄습니다. PC의 Claude 카드에서 켜세요.`
- `refused/host_scope`: `이 호스트의 계정 범위에 Claude 구독이 없어 이번 턴을 멈췄습니다.`
- `refused/consent`: `PC에서 원격 사용 동의가 필요해 이번 턴을 멈췄습니다.`
- `refused/not_ready`: `PC의 Claude 구독이 준비되지 않아 이번 턴을 멈췄습니다. Claude Code와 같은 로그인이 만료됐으면 PC의 Claude Code에서 요청을 한 번 보내거나, PC의 계정 화면에서 [own 전용 로그인으로 바꾸기]를 누르세요. 다른 로그인이 만료됐으면 그 계정의 [다시 로그인]을 누르세요. 서비스가 막 시작했으면 잠시 뒤 다시 보내고, 계속되면 PC에서 서비스를 다시 시작하세요.` 호스트는 코드만 받아 까닭(만료된 로그인, 아직 준비 안 된 계정 목록이나 플러그인)을 모르므로 경우마다 할 일을 적는다(02 §8.7 CS, 2026-10-23).
- `refused/billing`: `PC의 Anthropic 연결이 API 키라 원격에서 Claude 구독을 쓰지 않습니다.`
- `refused/needs_reauth`: `Anthropic이 Claude 로그인을 거절했습니다. PC에서 Claude Code에 다시 로그인한 뒤 계속하세요.`
- `refused/too_large`: `요청이 너무 커서(32 MiB 초과) PC가 중계하지 않았습니다.`
- `conflict`: `이 호스트에 다른 Claude 로그인이나 claude-auth 플러그인이 있어 Claude 구독을 쓰지 않습니다.`
- PC에 닿지 못하는 경우는 기존 `broker_unavailable` 문구(`host.ts:527`)를 그대로 쓴다.

**지운 것**
- 17.9의 `own.remote.claudeSlot.unavailable`(원격 Claude 구독이 아직 안 된다는 옛 문구). 코드에는 없고 명세에만 있었다. 그 자리에 위 `own.remote.claudeSlot.*` 행들을 넣었다.

**표시 규칙**
- 원격 세션 전환기에서 Claude 묶음에 모델이 없을 때는 끝없는 `own.shell.loading` 대신 이유 행과 동작을 보인다(`packages/own-web/src/switcher/popover.tsx:857`). 이유는 PC `hosts.list`의 `broker.claude.state`에서 온다.
- `new-session`의 `serving`은 원격 서버이면 그 판정이 `enabled`일 때만 Claude를 고른다(`packages/own-web/src/switcher/new-session.ts:58-66`).

#### 8.11.14 번들·빌드·smoke

- `REMOTE_PLUGINS = ["own-accounts", "own-remote", "own-team", "own-telemetry"]`로 바꾼다(`packages/own-remote/script/bundle.ts:55-60`, 주석도 고침).
  - build id 입력(`OWN_PACKAGES`, `bundle.ts:32-41`)에는 이미 own-telemetry가 있다.
  - claude-auth는 어디에도 번들하지 않는다.
- `own/scripts/build-remote.ps1:242`의 `--packages`에 `own-telemetry`를 더한다. 주석 34·40줄도 고친다.
- `managedConfig`(`model.ts:302-330`)의 4번에 `{package: plugins/own-telemetry, options: {home}}`를 둔다. 주석 295-301의 "positions 1-3"은 "1-4"로 고친다.
  - own-telemetry의 가드는 `OWN_OPEN_CODE=1`(`model.ts:340`)과 같은 앱 버전을 요구한다(`packages/own-telemetry/src/index.ts:22-25`).
  - `serviceEnv`(`model.ts:337-350`)는 `NO_PROXY`/`no_proxy`에 `127.0.0.1,localhost`를 덧붙인다. 사용자 값이 있으면 합친다. 호스트의 사용자 프록시 env가 stub와 sink로 가는 loopback 호출을 가로채지 않게 하기 위해서다.
    - 호스트 설정 env에 값이 있으면 `serviceEnv`가 그 값에 덧붙인다. 없으면 config env에 넣지 않고, `libexec/start.sh`가 로그인 셸의 `NO_PROXY`(없으면 `no_proxy`)에 덧붙여 둘 다 export한다. config env에 넣으면 로그인 셸의 값이 사라지기 때문이다.
- `inspectRemote`(`bundle.ts:406-412`)는 바뀐 목록을 그대로 따른다. 대상 압축 파일마다 서드파티 표식이 **0**인지 보는 검사를 더한다.
  - 표식은 `x-anthropic-billing-header`와 `59cf53e54c78`이다(`CA/signing.js:2,44-52`). own 소스에는 둘 다 없다(grep 0건). `heymaaz.claude-auth-v2`는 own-accounts 번들에 상수로 있으므로 표식으로 쓰지 않는다.
- `packages/own-remote/script/bundle.test.ts`의 목록 기대값을 고치고 표식 검사 시험을 더한다.
- `own/scripts/release-smoke.ts:5-9,242-256`의 원격 검사 문구와 표식 검사를 고친다.
- 소켓 정리는 ensure와 keep 두 곳이고(8.11.4.2), inspect의 `SOCK_PATH_LEN`(`scripts.ts:180`)은 바뀌지 않는다.

#### 8.11.15 하지 않는 것

- Claude 토큰을 호스트에 lease하는 것. `HeadersGet`(`broker.ts:280-290`)은 own provider만 받는 그대로다.
- 호스트에 claude-auth나 그 일부를 싣는 것. 신원 위장 동작을 own 코드로 다시 만드는 것.
- 중계에서 `connection.resolve`를 부르는 것, 또는 토큰 값을 읽거나 기록하는 것.
- `/v1/messages` 밖의 경로, `anthropic` 밖의 provider 중계, WS 중계.
- PC가 꺼져 있을 때 쓸 유예 토큰.

#### 8.11.16 사용자 결정(2026-10-09)

세 가지 모두 사용자가 2026-10-09에 정했다.
- **D1 안 C의 대가를 받아들인다(채택).** 원격 Claude는 이 PC가 켜져 있고 터널이 살아 있을 때만 되고, SSH가 끊기면 진행 중인 응답이 끊긴다. 그 대신 토큰과 서드파티 코드가 Windows를 떠나지 않고, 요청이 로컬과 같은 IP와 지문으로 나가며, 02 §8.1과 F8을 고치지 않는다. 안 L(lease)은 기각했다(8.11.2).
- **D2 401 회복을 PC 전역 single-flight로 묶고, 최종 401이면 그 호스트를 60초 보류한다(포함).** 잠금 없는 `forceRefreshActiveAccount`를 병렬 하위 에이전트가 각자 부르면 refresh token 계열이 회전해 Claude Code까지 다시 로그인해야 할 수 있다. 비용은 뮤텍스 하나와 시험 하나다(8.11.6).
- **D3 MAC은 요청마다 바뀌는 카운터로 만들고, PC는 1024칸 창으로 재사용을 거절한다(포함).** epoch마다 고정된 MAC이면 신뢰 호스트의 프로젝트 플러그인이 본 값을 터널이 살아 있는 동안 재사용할 수 있다. 비용은 카운터 하나와 창 하나로, 고정 MAC과 거의 같다(8.11.0 3번, 8.11.4.5).

#### 8.11.17 구현 메모(2026-10-09)

명세와 다르거나 명세가 정하지 않은 구현 세부다.
- **실패 버킷을 넘은 연결**: `Bun.serve`는 읽지 않은 연결을 닫을 수 없다. 그래서 그 분 동안은 본문을 읽지도, MAC을 계산하지도 않고 고정 401 `mac`(`connection: close`)으로 답한다. upstream 호출은 0이고 브로커 handshake 버킷은 그대로다.
- **업로드 시간 초과**: 408 `bad_request`. 거절 코드 목록은 늘리지 않았다.
- **첫 전송은 사본**: `fetch(prepared.clone())`. plugin의 `finishClaudeResponse`가 `prepared`의 본문을 다시 읽는다(`CA/provider.js:103`).
- **시간 제한**: 첫 전송과 plugin 재전송은 `timeout:false`로 보낸다. 끊는 것은 요청 신호뿐이다.
- **보류 중 차례가 온 401 회복**: `finish`를 부르지 않고 403 `needs_reauth`로 답한다. D2의 "강제 refresh 한 번"을 지키기 위해서다.
- **중계 상태 알림**: 중계는 거절과 보류를 시작할 때만 브로커 상태를 알린다. 진행 중 요청 수는 `status`(`hosts.list`)가 읽을 때 센다. own-remote의 `broker.status` 이벤트는 `claude{state, lastError, holdUntil}`을 함께 싣는다(rpc-remote 추가 필드). own-web은 이 이벤트로 판정을 갱신한다.
- **브로커 보호**: 판정은 서빙 인스턴스의 사실을 한곳에서 읽는다. 그 읽기가 실패하면 "슬롯 없음"으로 보고 로그를 남긴다. Claude 판정 실패가 브로커의 lease를 막지 않게 하기 위해서다.
- **`remote.set` 켜기**: 원격 동의(`ack_required{remote}`)에 더해 claude-auth가 설치되어 있거나 감지되어야 한다(아니면 `plugin_not_installed`). 끄기는 언제나 된다. 마지막 호스트를 끄면 `remoteHosts` 키를 지운다.
- **`status.remote.hosts`**: `remoteHosts`의 호스트와 이 PC 브로커가 리스너를 연 호스트를 합친다. 브로커가 아직 모르는 호스트의 범위는 `all`로 보고 판정한다.
- **미러 동기화**: 원격 미러가 view를 받아 오는 동안 `mirror.changed`가 오면 끝난 뒤 한 번 더 받는다. 전에는 진행 중인 동기화에 합쳐져 바뀐 판정을 놓칠 수 있었다.
- **충돌 경보**: `claude_remote_conflict`는 PC 판정이 `enabled`인 호스트의 Location에서 충돌이 생길 때 한 번 낸다. 경로 결정에서 충돌로 sink에 간 턴도 같은 경보로 멈춘다.
- **NO_PROXY**: 8.11.14의 둘째 하위 항목처럼 `serviceEnv`와 `start.sh`가 나눠 맡는다.
- **TMPDIR**(같은 브랜치의 별도 수정): 설치의 버전 확인, `start.sh`, ops의 `service stop`이 own Bun 바이너리를 `TMPDIR=<OWN_HOME>/tmp`(0700, 먼저 만든다)로 돌린다. Bun이 `/tmp/.bun-<uid>-*.so`를 남기지 않게 하기 위해서다. 실제 호스트 정리 단계(z-cleanup)는 남은 `/tmp/.bun-<uid>-*` 중 우리 소유 파일을 지운다.

#### 8.11.18 여러 Claude 계정의 중계(2026-10-10, 02 §8.7, 가드 G5)

이 PC에 Claude 구독 계정이 여럿일 때(02 §8.7, 사용자 결정 C-D1–C-D3) 원격 대화도 계정을 고른다. 토큰은 여전히 PC를 떠나지 않는다.

- **미러**: `MirrorView.claude.accounts`가 호스트 범위가 허용하는 이 PC의 Claude 계정을 싣는다(`{accountID, label, shortLabel, color, default, usable?}`, 표시 정보뿐). `usable`(2026-10-11)은 PC가 지금 그 계정으로 서명할 수 있는지(로드된 플러그인이 그 로그인을 가짐)다. 폴더, 키, 이메일, uuid, 토큰은 싣지 않는다. `default`는 PC의 기본 계정이 범위 안이면 그것, 아니면 범위 안의 첫 계정이다. 옛 PC(필드 없음)는 슬롯 자신의 계정 하나로 본다. `MIRROR_SCHEMA_VERSION`과 PROTO는 그대로다(선택 필드).
- **호스트의 바인딩**: 원격 own-accounts의 claude 모듈이 PC와 같은 규칙(02 §8.7)으로 대화의 계정을 정한다. KV `claude:session:<root>`·`claude:team:<teamID>`는 호스트 DB에 있고, 계정 목록은 미러의 `accounts`다. 새 트리는 첫 요청 때 미러의 기본 계정으로 묶이고 그 뒤 PC의 기본이 바뀌어도 그대로다(2026-10-11). 묶인 계정이 미러에 없으면(호스트 범위에서 빠짐) 기본 계정으로 바꾸지 않고 거절한다(경보 `claude_account_refused`). 미러가 오기 전에는 아무것도 묶지 않는다. 스위처의 `plugin.claudeAuth.session.set`은 호스트에서도 된다(계정 추가·빼기·기본 계정·패치는 `remote_managed`). 그래서 호스트 새 대화의 스위처가 Claude 구독 계정을 고르면 own-web은 **이 PC의** `plugin.claudeAuth.default.set`을 부르고(02 §8.7 "마지막에 고른 계정"), 그 기본 계정이 미러로 호스트에 가 새 대화가 그 계정으로 묶인다(RS 2026-11-28; 전에는 호스트에 보내 `remote_managed`로 거절되고, 스위처가 까닭 없이 계정 화면으로 넘어갔다). 계정을 고르지 못하면 스위처는 알림에 까닭(`Claude 계정 {account}(으)로 바꾸지 못했어요: …`)을 보인 뒤 계정 화면으로 간다. Claude Agent 계정의 기본은 호스트 자신의 것이라 호스트에 보낸다(02 §8.10.13). 테스트: fake-SSH e2e `claude-relay.test.ts`의 PC 기본 계정 턴, 실제 호스트 D15.
- **proof v2**: 호스트의 `http.request` hook이 대화의 계정 id를 정하고, 브로커 클라이언트가 `x-own-egress: v2.<epoch>.<n>.<accountID>.<mac>`을 만든다(`mac`은 `"own-egress/v2|"+hostId+"|"+epoch+"|"+n+"|"+accountID`의 HMAC). 계정이 없으면 proof를 붙이지 않고 sink에 남는다.
- **PC 중계**: MAC이 맞으면(계정을 바꾼 proof는 401 `mac`) 그 계정이 이 PC의 Claude 계정이고 호스트 범위 안인지 본다(아니면 403 `host_scope`). 그 계정의 키로만 서명한다(`prepareClaudeRequest(…, key)`, `finishClaudeResponse(…, key)`). 기본 계정으로 바꾸는 일은 없다. 플러그인이 계정 하나로 돌면(패치 상태가 `patched`가 아니면 표지가 있어도 그렇다, 02 §8.2 2a) 슬롯 자신의 계정만 서명하고 다른 계정은 403 `not_ready`다. Claude Code 세션 id는 (계정, 호스트 대화 `x-opencode-session-id`)마다다(G7).
- **귀속**: 중계가 관측한 한도 창은 proof 계정의 것이다(`origin=hostId`). 호스트의 ledger 줄은 호스트 own-telemetry가 relay 요청의 proof 계정으로 귀속해 보내고(`RemoteHost.claudeSigner`), PC는 그 계정이 이 PC의 Claude 계정이면 그대로, 아니면 `acc_claude_slot`으로 받는다(`Observe.Sink.claude(hostId, accountID)`).
- **자동 전환(02 §8.8)**: 호스트에서도 같은 규칙으로 돈다. 호스트가 아는 한도는 자기가 본 응답의 창뿐이므로 모르는 계정은 뒤로 간다. 대상은 미러가 `usable: true`라고 한 계정뿐이다(필드가 없는 옛 PC면 옮기지 않음).
- 테스트: `packages/own-accounts/test/broker/egress-accounts.test.ts`(proof v2, 범위, 계정 하나 플러그인), `test/broker/mirror.test.ts`(accounts 필드), fake-SSH e2e `test/remote/e2e/claude-relay.test.ts`의 둘째 계정 턴.

---

### 8.12 GitHub 중계 (16 §8, GH-37–GH-44, 2026-11-02)

호스트의 GitHub 도구와 git은 PC의 GitHub 계정을 쓴다. 토큰은 PC를 떠나지 않는다. 자세한 설계는 16 §8이고, 이 절은 브로커와 터널 쪽만 적는다.

- **새 전달은 없다.** 도구 호출은 브로커 채널의 `github.*` 요청(8.4 표), git은 8.11의 egress 전달(`egress-<epoch>.sock`)과 PC의 egress 리스너를 그대로 쓴다. own-remote의 터널·arm은 바뀌지 않는다. 리스너가 경로로 나눈다: `/v1/messages`는 Claude, `/github/<사이트 호스트>/<owner>/<repo>…`는 git, `/local/<accountID>…`는 로컬 모델(8.14).
- **정상 모드에서만.** `github.*`는 `DRAIN_METHODS`에 없고, 호스트는 `ready.mode = normal`(같은 빌드)인 세션에서만 부른다. 옛 PC는 이 메서드를 모르므로(모르는 요청은 세션을 닫는다) 다른 빌드 사이에서는 GitHub가 없다. `github.changed` push도 정상 모드 세션에만 간다.
- **git 요청의 증명**: `x-own-github: v1.<epoch>.<n>.<mac>`, `mac = HMAC-SHA256(K, "own-github/v1|" + hostId|epoch|n|<메서드>|<경로와 쿼리>|<장소 헤더>)`. `n`은 Claude 증명과 같은 arm 카운터라 PC의 재사용 창(`EGRESS_REPLAY_WINDOW`) 하나가 둘을 덮는다. 장소 헤더 `x-own-github-place`는 `{directory, main?, root?}`의 base64url JSON이고 MAC이 덮는다. 실패는 Claude와 같은 호스트별 실패 버킷(분당 20)에 센다. 속도(초당 10, 버스트 30)도 같이 쓰고, 동시 요청(16)은 git 것을 따로 센다(Claude 판정이 바뀌어도 git 요청을 끊지 않는다).
- **호스트 쪽**: 원격 own-accounts가 프로세스에 하나 git 중계 입구(`GitHubRelayStub`, 호스트의 `127.0.0.1:0`)를 연다. 셸·브리지의 git은 `url.<입구>/<사이트 호스트>/.insteadOf=<사이트>/`와 명령마다의 티켓(`http.<입구>/.extraHeader`)을 받는다. 입구는 티켓과 호출자(Windows는 TCP 표, Linux는 `/proc`, 16 §8.6)를 확인한 뒤 증명을 붙여 `EgressStub`으로 보낸다. Windows와 Linux가 아닌 호스트는 입구를 열지 않는다.
- **PC 쪽**: 경로가 git의 smart HTTP나 Git LFS API인지, 장소의 계정과 사이트, 읽기만 하는 계정의 push(receive-pack, LFS upload, 잠금 변경)를 `GitHubRelay.gate`가 판정하고, 통과하면 PC가 `Authorization: Basic`을 붙여 계정의 사이트로 보낸다. 요청과 응답은 흐르는 대로 전달하고(clone·push가 크다), GitHub의 401은 403으로 바꿔 호스트의 git이 비밀번호를 묻지 않게 한다. 거절은 `x-own-github-error` 코드만 싣는다.
- **감사**: PC의 `own-accounts.log`에 `github_git_login{remote, host, repository, operation, account, caller:"relay"}`, 거절은 `github_git_login_refused{…, reason}`, 도구는 `github_remote_tool{remote, tool, account, write}`. 토큰·헤더 값·본문은 남기지 않는다.

### 8.13 Claude Agent 경로 중계 (02 §8.10.13, CAG-R1–CAG-R11, 2026-11-03)

호스트 대화의 Claude Agent 모델(`claude-agent/…`)은 이 PC의 `claude`로 돈다. 설계와 까닭은 02 §8.10.13이고, 이 절은 브로커 쪽만 적는다.

- **새 전달은 없다.** 브로커 채널 하나 위의 스트림이다(8.4 표의 `claudeAgent.*`). own-remote의 터널·arm은 바뀌지 않는다. egress 리스너도 쓰지 않는다.
- **정상 모드에서만.** `claudeAgent.*`는 `DRAIN_METHODS`에 없고, 호스트는 `ready.mode = normal`인 세션에서만 연다. 옛 PC는 이 메서드를 모르므로(모르는 요청은 세션을 닫는다) 다른 빌드끼리는 이 경로가 없다. 첫 요청은 브로커가 다시 붙기를 `brokerWaitMs`까지 기다린다.
- **스트림**: 호스트가 정한 id(64자 이하)로 연다. `process`는 프로세스 하나, `call`은 기록·버전 호출 하나(요청 JSON을 쓰고 끝내면 답 JSON이 data로 오고 exit 0, 실패는 exit 1과 까닭). 글은 차례대로 오간다: 브로커는 요청을 받은 순서로 처리하고, `claudeAgent.write`의 처리는 기다림 없이 바로 그 스트림에 넣는다. 한 프레임의 글은 128 Ki자 이하(1 MiB 프레임 안). 호스트마다 동시에 64개까지(`busy`).
- **기다림**: `process`의 `claudeAgent.open`은 PC 풀(02 §8.10.12)이 자리를 줄 때 답한다. 호스트는 30분까지 기다린다. 호스트가 그 사이 취소하면 `claudeAgent.close`가 PC의 기다림을 끝낸다. 자리를 받고 1분 안에 `start`가 없으면 PC가 자리를 돌려받는다.
- **세션과 함께 끝난다**: PC는 세션이 닫히면(끊김, 다른 세션이 대신함, 호스트 제거) 그 호스트의 스트림을 모두 닫는다. 다른 세션이 이미 대신한 옛 세션이 늦게 닫혀도 새 세션의 스트림은 그대로다. 호스트는 브로커 상태가 `connected`에서 벗어나는 순간 모든 스트림을 끝낸다(프로바이더가 바로 안다).
- **PC가 고르는 것**: 계정은 `accountID`(이 PC의 Claude Agent 계정이고 호스트 계정 범위 안, 아니면 `refused{account}`와 한국어 까닭), 작업 폴더는 `<OWN_HOME>\claude-agent\hosts\<hostId>\<sha256(directory) 앞 16자>`(호출의 `directory`가 비면 `hosts\<hostId>`), 실행 파일·인자·env·입력 거르기는 코어(P-052, 02 §8.10.13 "PC가 지키는 것").
- **미러**: `MirrorView.claudeAgent{accounts[{accountID, label, shortLabel, color, default, loggedIn}]}`(선택 필드, `MIRROR_SCHEMA_VERSION`과 PROTO는 그대로). 호스트 범위가 허용하는 계정이 없으면 필드가 없다. 호스트는 `MirrorMeta.claudeAgent`에 두고 같은지 비교에 넣어, 바뀌면 미러를 다시 쓰고(`store.changed{accounts}`) 프로바이더 fold가 다시 돈다.
- **감사**: PC의 `own-accounts.log`에 프로세스를 열 때 `claude_agent_process{hostId, account}`, 실패는 `claude_agent_open_failed`, 세션과 함께 닫힌 것은 `claude_agent_dropped`. 대화 내용·인자·env 값은 남기지 않는다.
- **비밀**: 호스트는 계정 폴더 경로, 토큰, 이메일, 조직을 받지 않는다(02 §8.10.13). e2e와 실제 호스트 시험이 호스트의 파일·로그·프로세스에서 토큰과 이메일을 찾는다.

### 8.14 PC의 로컬 모델 중계 (02 §3.3a, SLM, 2026-11-22)

사용자는 주로 SSH 호스트에서 일하고, 이 PC에서 도는 로컬 모델(`로컬 모델` 계정, 02 §3.3a)을 쓴다. 2.2.6-own.15까지 호스트 대화에서 그 모델에 `git init`을 보내면 턴이 0초 만에 `own_broker_unavailable`(sink의 401 본문 그대로)로 끝났다. 이 절이 그것을 고치고, 그 모델을 호스트에서 쓰게 한다.

#### 8.14.1 그때 무슨 일이 있었나

1. 미러(9.2)가 계정의 `compat`을 싣지 않았다. 그래서 호스트는 그 계정이 로컬 모델이고 키가 없다(`compat.local.keyless`)는 것을 몰랐다. 02 §3.3a 6번 "키 없는 로컬 모델은 broker 임대 없이 빈 헤더"는 호스트에서 한 번도 참이 아니었다.
2. 호스트의 `logins.headers`가 `headers.get`을 불렀고, PC 브로커는 로컬 경로(`logins.headers`의 `KEYLESS`)로 **빈 헤더의 lease**를 줬다.
3. `model.request`의 `afterModelRequest`는 own slot 요청에 자격 증명 헤더가 없으면 sink로 보낸다(8.6 5번, `Hash.auth(headers)`가 비었음). 표시는 `blocked`였다.
4. `retry`의 `retryBefore`는 sink에 간 `blocked`를 유예 없이 `{retry:false}`로 끝냈고 경보도 없었다. 그래서 0초, 입력 0·출력 0, 제목 `own_broker_unavailable`, 본문 `{"error":"own_broker_unavailable"}`이었다. 브로커 끊김(유예 최대 약 5분)이 아니라 "자격 증명 없음" 경로였다.
5. 키가 있는 로컬 모델이었어도 안 됐다. lease를 받은 요청은 계정 주소 `http://127.0.0.1:64644/v1`로 나가는데, 호스트에서 그 주소는 **호스트 자신**이다. 연결 거부로 끝나거나, 공유 호스트(`lab`)에서 다른 사용자의 프로세스가 그 포트에서 듣고 있으면 대화 prefix와 lease된 키가 그 프로세스로 간다.
6. 시험이 놓친 까닭: 실제 호스트 phase E는 `기타 OpenAI 호환` 계정(키 있음)의 주소를 **호스트의** `127.0.0.1:<F>`로 두고 시험 전용 `ssh -R`로 이 PC의 forwarder에 이었다(`e-live.test.ts`). stack.ts의 가짜 provider도 같다. fake-SSH 하네스에서는 "호스트"가 이 PC 위에서 돌아 loopback을 함께 쓰므로 키 있는 계정은 우연히 닿는다. 사용자가 만드는 계정(로컬 모델, 키 없음, PC loopback, `-R` 없음)을 호스트 대화에서 고르는 경로는 어디에도 없었다.

#### 8.14.2 결정

- **자동이다.** 호스트는 다음 계정의 요청을 **이 PC를 거쳐** 보낸다(`Broker.viaPc`, PC와 호스트가 같은 규칙).
  - `로컬 모델` 계정(`compat.local`), 주소가 무엇이든
  - 주소가 이 PC의 loopback(`127.0.0.0/8`, `localhost`, `[::1]`, `0.0.0.0`, IPv4 대응 loopback `[::ffff:127.…]`)인 `기타 OpenAI 호환` 계정(프록시, 로컬 모델에서 되돌린 계정)
  - 호스트별·계정별 스위치는 없다. 그 호스트에서 쓸 수 있는지는 기존 호스트 계정 범위(8.9)와 계정의 `remote`가 정한다. 범위 밖이거나 `deny`면 미러에서 `disabled`라 호스트 모델 목록에 없다.
  - 까닭: 로컬 모델은 "이 PC에서 닿는 서버"로 확인하고 추가한 계정이다. 호스트에서 그 주소로 바로 가면 loopback은 늘 틀리고, 집 안 주소는 호스트 위치에 따라 맞기도 틀리기도 한다. PC를 거치면 PC가 켜져 있는 한 늘 맞는다.
  - 집 안 네트워크 주소(`192.168…` 등)의 `기타 OpenAI 호환` 계정은 그대로(lease, 호스트가 직접 호출)다.
- **표시**: 호스트 대화의 전환기에서 그 계정 행에 `PC 경유` 칩(설명 `own.remote.localModel.badgeHelp`). 설정 > SSH 원격 호스트의 호스트 칸에 `로컬 모델` 행(`이 PC를 거쳐 써요`, 진행 중이면 `이 PC를 거쳐 쓰는 중 (n개 요청)`)과 설명.
- **대가(받아들임)**: 이 PC가 꺼져 있거나 SSH가 끊기면 그 대화는 답할 수 없다. 응답 도중 끊기면 그 응답은 거기서 끝나고 부분 출력이 남는다(8.11.7과 같다). PC를 거치지 않는 유예 경로는 없다.

#### 8.14.3 전송

```text
호스트 core ─▶ (own-accounts http.request: sink로 먼저, 중계면 마지막에) stub 127.0.0.1:S
  /local/<accountID><원래 경로와 query>  + x-own-local: v1.<epoch>.<n>.<accountID>.<mac>
  ─▶ egress-<epoch>.sock ─ sshd -R ─▶ ssh.exe ─▶ PC egress 리스너 127.0.0.1:E_h
  ─▶ 계정의 모델 서버(이 PC의 slot baseURL) + 키가 있으면 그 키
```

- **새 전달·새 리스너는 없다.** 8.11의 egress 전달과 PC의 egress 리스너, 호스트의 stub를 그대로 쓴다. 리스너는 경로로 나눈다: `/v1/messages`는 Claude, `/github/…`는 git, `/local/<accountID>…`는 로컬 모델. 네트워크에서 닿는 포트를 새로 열지 않는다. PC 쪽은 `127.0.0.1`, 호스트 쪽은 0600 소켓(TCP 대체 모드면 호스트 loopback)이다.
- **증명**: `x-own-local: v1.<epoch>.<n>.<accountID>.<mac>`, `mac = HMAC-SHA256(K, "own-local/v1|"+hostId+"|"+epoch+"|"+n+"|"+accountID+"|"+<메서드>+"|"+<경로와 query>)`. `n`은 Claude·git 증명과 같은 arm 카운터, PC의 재사용 창(1024)도 하나다. 실패는 같은 호스트별 실패 버킷(분당 20)에 센다. K는 서비스 메모리의 클로저에만 있으므로 공유 호스트의 다른 사용자(소켓 0600에 닿지도 못함)도, 같은 uid의 다른 프로세스(MAC을 만들 수 없음)도 이 PC의 모델을 쓸 수 없다. 남는 위험은 8.11.5와 같다(같은 uid로 서비스 메모리를 읽을 수 있는 프로세스).
- **PC가 정하는 것**(`BrokerHost.localModel`): 계정은 proof의 `accountID`이고 `Broker.viaPc`에 맞아야 한다(아니면 404 `not_found`). 호스트 범위 안이고 `disabled`가 아니어야 한다(403 `host_scope`). **보낼 곳은 이 PC의 slot baseURL뿐**이고, 경로는 그 baseURL의 경로(`/v1`) 아래여야 한다(404 `bad_request`). 호스트가 준 Host 헤더나 주소는 쓰지 않는다. 키는 PC의 `logins.headers`(로컬 대화와 같은 경로)에서 붙인다. 못 읽으면 403 `needs_key`. 메서드는 `POST`, `GET`만(405).
- **바이트**: 본문은 고치지 않는다. PC가 본문을 끝까지 받은 뒤(32 MiB, 업로드 120초, Claude 중계와 같은 상한) 길이(`content-length`)를 붙여 보낸다. 이 PC의 대화가 보내는 것과 같은 틀이다(호스트 stub와 중계가 흘려 보내면 `transfer-encoding: chunked`가 되어 실제 호스트 RG9에서 머리말이 달랐고, chunked 업로드를 받지 않는 로컬 서버도 있다). 헤더도 그대로다. 빼는 것은 hop-by-hop 헤더, `host`, `content-length`, 호스트의 `authorization`·`x-api-key`·`cookie`, `x-own-*`뿐이다. 그래서 모델 서버가 받는 요청은 이 PC의 대화가 보낼 요청과 같은 규칙으로 만들어지고(호스트가 만든다), prefix 캐시도 같다. `model.request`의 baseURL은 바꾸지 않는다(8.11.0 4번과 같은 까닭).
- **한도·동시성**: 속도(초당 10, 버스트 30)는 Claude·git과 같이 쓰고, 동시 요청(16)은 로컬 모델 것을 따로 센다.
- **시간 제한·스트리밍·취소**: 검사가 끝나면 `server.timeout(req, 0)`, 모델 서버 `fetch`는 시간 제한 없이 신호로만 끊는다. 답은 오는 대로 pull로 흘러간다(backpressure). 사용자 중단과 터널 끊김은 8.11.7의 순서로 모델 서버 요청까지 끊는다. 호스트 쪽 상한은 core의 header·chunk 시간 제한이다.
- **응답**: `x-own-local: 1`. 모델 서버의 답이므로 호스트의 own 관측(텔레메트리·한도·재시도 분류)은 이 PC의 대화처럼 돈다.
- **lease 없음**: 호스트는 이런 계정에 `headers.get`을 보내지 않는다. 키는 PC를 떠나지 않는다. 옛 호스트(이 절 전)는 여전히 lease를 받을 수 있어 그 동작은 그대로다(PC가 lease를 막지 않음, 8.14.6).
- **감사**: 5분 합계 `remote.egress.local{hostId, count, bytesIn, bytesOut, statuses, refusals}`(events ledger). 본문·헤더 값·증명은 남기지 않는다. `hosts.list`의 `broker.local{inflight, lastError}`가 진행 중 요청과 마지막 거절을 보인다.

#### 8.14.4 미러

- `MirrorView.localRelay: true`(선택 필드): 이 PC가 로컬 모델 요청을 중계한다. 호스트는 `MirrorMeta.localRelay`에 두어 다시 떠도 유지한다. 값이 바뀌면 미러를 다시 쓴다.
- 미러한 계정에 `compat`(서버 계열, 출력 한도, 그림·도구 능력, `local.format`)을 싣는다. `keyless`는 싣지 않는다(호스트는 로컬 모델의 키를 다루지 않는다). 그래서 호스트 등록이 PC와 같다(형식별 패키지, Ollama 규칙, `billing: "local"`). 비밀은 없다.
- `MIRROR_SCHEMA_VERSION`과 PROTO(1)는 그대로다.

#### 8.14.5 거절과 화면 (8.6 5번 sink 이유)

- **sink가 까닭을 말한다.** 호스트의 `http.request` hook이 sink로 보낼 때 `x-own-fail-reason: <code>`를 붙이고, sink는 `401 {"error":{"type":"own_broker_unavailable","code","message"}}`로 답한다. `message`는 고정 한국어 문장이고(요청 내용은 돌려주지 않음), 모르는 code는 `blocked`다(`Sink.REASONS`).

| code | 언제 | 문장(앞부분) | 재시도 |
|---|---|---|---|
| `unavailable` | 브로커에 닿지 못함(8.7) | PC와 연결이 끊겨 이 모델을 부를 수 없어요… | 유예 |
| `refused_account_not_remote` | 8.4 `account_not_remote` | 이 계정은 이 SSH 서버에서 쓰지 않게 되어 있어요… | 없음 |
| `refused_needs_reauth` | `needs_reauth` | PC에서 이 계정에 다시 로그인해야 해요… | 없음 |
| `refused_source_stale` | `source_stale` | 이전 앱이 로그인을 갱신하지 않았어요… | 없음 |
| `refused_exhausted_blocked` | `exhausted_blocked` | 이 계정의 한도가 다 되어… | 없음 |
| `refused_rate_limited` | `rate_limited` | PC에 이 SSH 서버의 요청이 너무 많아… | 없음 |
| `refused_not_found` | `not_found` | PC에 이 계정이 없어요… | 없음 |
| `refused_vault_unavailable` | `vault_unavailable` | PC가 이 계정의 자격 증명을 읽지 못했어요… | 없음 |
| `blocked` | 자격 증명을 넣지 않음(Location trust 등) | 이 요청에 PC 계정의 자격 증명을 넣지 않아… | 없음 |
| `claude_<판정>` | 8.11.4.4의 sink 행 | 8.11.13 문장(해요체) | 8.11.8 |
| `local_pc_old` | 미러에 `localRelay`가 없음(옛 PC) | 이 PC의 로컬 모델을 SSH 서버에서 쓰려면 PC 앱이 2.2.6-own.17 이상이어야 해요… | 없음 |

- **PC 중계의 거절**: `x-own-local-error: <code>`와 `{"error":{"type":"own_local_relay","code","message"}}`(`Egress.LOCAL_REFUSED`). `mac`은 한 번 바로 다시, 그다음은 유예. `busy`·`rate_limited`는 2초 뒤 다시. `upstream_unreachable`(502, PC가 모델 서버에 연결 못 함)은 core의 일반 분류(이 PC의 대화에서 연결이 안 될 때와 같음). 나머지(`not_found`, `host_scope`, `needs_key`, `bad_request`, `too_large`)는 `{retry:false}`.
- Claude 중계의 거절 본문도 `{"type":"error","error":{"type":"own_egress","code","message"}}`로 한국어 문장을 싣는다(`Egress.CLAUDE_REFUSED`). 전에는 `message`가 code 그대로라 카드 제목이 `off` 같은 낱말이었다. 재시도 판정은 계속 헤더로만 한다.
- **own-web**: 응답 본문의 `type`이 `own_broker_unavailable`·`own_local_relay`·`own_egress`인 오류 턴은 원문 JSON을 보이지 않는다(`응답 본문 보기` 없음). 카드 글은 본문의 `message`, 옛 호스트의 맨 `{"error":"own_broker_unavailable"}`이면 `own.failClosed.legacy`(서버 업데이트 안내)다. 카드 아래 단추: `다시 보내기`(`계속`을 보냄, 연결·한도처럼 지나가는 까닭), `다른 모델로 바꾸기`(전환기), `SSH 원격 호스트 설정`(범위·연결·프로젝트 설정), `계정 화면 열기`(로그인·키·Claude 스위치). 지연 청크 `transcript/fail-closed.tsx`.
- **전환기**: 호스트에서 쓸 수 없는 계정(범위 밖, `remote: deny`, `disabled`)은 지금처럼 목록에 없다(미러가 `disabled`로 보냄). 쓸 수 있는 로컬 모델에는 `PC 경유`가 붙는다.

#### 8.14.6 버전 차이

| 조합 | 결과 |
|---|---|
| 새 PC + 새 호스트 | 이 절대로 |
| 새 PC + 옛 호스트(2.2.6-own.16까지) | 옛 호스트는 `localRelay`를 무시하고 lease 경로를 탄다. 미러의 `compat`은 읽지만 `keyless`가 없으므로 키 없는 로컬 모델은 빈 lease → sink → 맨 `own_broker_unavailable`(전과 같음). PC의 own-web이 그 본문을 `own.failClosed.legacy`(호스트 업데이트 안내)로 보인다. 호스트를 업데이트하면 고쳐진다 |
| 옛 PC + 새 호스트 | 미러에 `localRelay`가 없다. 로컬 모델 요청은 sink `local_pc_old`(PC 앱 업데이트 안내) |
| drain 모드(5.7) | 호스트는 저장한 `MirrorMeta.localRelay`를 쓰고, PC 중계는 요청마다 계정·범위를 다시 본다 |

#### 8.14.7 하지 않는 것

- 호스트에 로컬 모델의 키를 lease하는 것(새 호스트는 묻지 않는다).
- 호스트가 정한 주소로 보내는 것. 보낼 곳은 PC의 slot baseURL뿐이다.
- WS 중계(로컬 모델 WebSocket은 sink).
- PC가 꺼져 있을 때 쓸 다른 길.
- 집 안 네트워크 주소의 `기타 OpenAI 호환` 계정 중계(그대로 직접).

#### 8.14.8 시험

- 단위: `packages/own-accounts/test/broker/egress-local.test.ts`(PC 중계: 바이트 그대로, PC 키, 거절과 한국어 문장, 스트리밍, 취소, 감사), `test/remote/local-route.test.ts`(호스트: 미러, lease 없음, sink 먼저·중계 마지막, trust, 범위, 끊김, `viaPc`, sink 문장), own-web `src/transcript/fail-closed.test.ts`.
- fake-SSH e2e: `test/remote/e2e/local-model-relay.test.ts`. 앱의 로컬 모델 폼과 같은 `accounts.add.key{options.local}`로 키 없는 계정과 키 있는 계정을 만들고, 호스트 대화가 PC 중계로 답을 받는다(키 없음, PC가 붙인 키, 다음 턴 캐시 적중, 중계 리스너의 유휴 시간 제한보다 긴 멈춤, 중단, 키가 호스트에 없음). `OWN_SLM_CODE_ROOT=<옛 체크아웃>`으로 돌리면 사용자의 오류를 그대로 재현한다(0초, `provider.auth`, 401, 본문 `{"error":"own_broker_unavailable"}`).
- 실제 호스트 phase G: `packages/own-remote/test/real-host/g-local-model.test.ts`(G1–G6, build-host만). 가짜 OpenAI 호환 서버는 이 PC의 무작위 시험 포트이고 어디로도 forward하지 않는다(64644는 쓰지 않는다). phase E의 로컬 대역도 같은 경로(로컬 모델 계정, PC 중계)로 바꿨다(`OWN_REAL_HOST_E_STANDIN_KIND=compat`이면 예전처럼).

### 8.15 호스트의 작업 폴더와 작업 폴더 대화 (06 §4.12a, §13, WH, 2026-11-24)

- 호스트 서비스의 own.team도 core의 `git` 작업 폴더 전략을 같은 id로 다시 등록하므로, 호스트 대화의 `새 작업 폴더`·core `worktree_create`·`worktree_start`가 만드는 작업 폴더는 `<호스트 프로젝트>/.worktrees/<이름>`이다(`.gitignore`와 `info/exclude` 줄도 호스트에서). 호스트 프로젝트의 config `worktree.directory`가 있으면 그것이 이긴다.
- 작업 폴더 대화(06 §13)는 호스트 안에서 시작하고 돌며 부모에게 알린다(자식은 호스트의 대화, 기록은 호스트 서비스의 KV). PC 화면의 작업 폴더 대화 줄은 `/srv/<hostId>`의 own.team `worktreeChat.list`를 읽는다.
- 호스트는 보통 원격 업데이트가 있어야 한다(`업데이트 필요`). `proto`는 그대로 1이다. 옛 호스트에서는 도구가 없고 줄도 보이지 않으며, 작업 폴더는 앱 데이터(core 기본값)에 생긴다.
- 시험: own-team e2e `test/e2e/remote-worktree.e2e.test.ts`(가짜 SSH, 호스트 서비스는 소스로 띄운 실제 서버와 own-team `remote`, 06 §13.8).

## 9. 원격 own-accounts와 레지스트리 미러

### 9.1 모드별 차이

| 기능 | `mode:"local"` (02 그대로) | `mode:"remote"` |
|---|---|---|
| slot 등록 | `accounts.json` | 미러 레지스트리 뷰(9.2). 템플릿이 같으므로 모델 정의가 바이트 단위로 같다(02 §2.4.2, D4) |
| 인증 헤더 | 비밀 캐시·vault, linked는 원본 reader | 브로커 lease(8.6). linked 계정도 같은 lease로 받는다(8.5) |
| refresh | single-flight + lease 파일(linked는 하지 않음, 02 §3.5 F9) | 하지 않음. `invalidate`만 |
| 자동 압축 기준(02 §4.7) | `accounts.json`·`policy.json`의 `compaction`으로 `Compaction.resolve` → 등록 모델의 `limit.input = ctx_eff` | **같은 함수와 같은 입력**(미러의 `accounts[].compaction`, `policy.compaction`, 9.2)으로 같은 `ctx_eff`. 세션 값 KV(`sess:<sid>:compaction.triggerTokens`)는 원격 DB에 있고, `compaction.due`는 원격 인스턴스가 원격 서버 이벤트 스트림에 낸다(02 §4.7.4–4.7.5) |
| `accounts.*` 변경 RPC, `plugin.claudeAuth.*`, `policy.set`, `ratecards.set` | 있음 | `remote_managed` 오류(16.5). 로컬에서 바꾸면 미러로 온다 |
| ledger | runtime writer가 파일에 씀 | spool → `observe.push`(10장). step·compaction·title·generate 줄을 로컬과 같은 코드로 만든다(10.1) |
| 한도 저장소 | `state\limits.json` | 메모리 미러(`quota.updated` push) + 관측 push |
| 한도 보정(02 §7.6) | 로컬 ledger로 적합 | 메모리 미러(`calibration.updated` push). 원격은 적합하지 않는다 |
| 전역 이벤트(`quota.updated`, `accounts.changed`, `account.status`, `plugin.*`) | leader가 발행 | **발행하지 않음**(own-web은 로컬에서 받는다). 예외는 호스트 자신의 것인 `mcp.changed` 하나(13.1, RL34 2026-11-28: 호스트의 MCP 목록이나 연결 시험 결과가 바뀌면 호스트 카드가 `mcp.host.view`를 다시 읽는다. 어느 Location에서 바뀌든(`AI에게 설치 맡기기`의 도구는 그 대화의 Location에서 돈다) 런타임 broadcast로 leader에게 가고 leader가 낸다. 전에는 이것도 버려져, 설치의 저장과 연결 시험 사이에 읽은 카드가 다시 열 때까지 `아직 호스트에서 연결 시험을 하지 않았어요`에 머물렀다) |
| 세션 이벤트(`binding.changed`, `cache.state`, `switch.*`, `ledger.step`, `compaction.due`, 세션 `alert`) | 발행 | 원격 서버 이벤트 스트림에 발행 |
| 곁질문(`side.*`, 02 §9.7, 2026-11-22) | 이 PC의 대화를 이 PC에서 묻는다 | 호스트의 대화를 **호스트에서** 묻는다(`REMOTE_MANAGED` 아님). 요청은 호스트 core가 그 대화의 기록으로 짓고 인증 헤더는 브로커 lease로 받는다. 곁질문 목록은 호스트 DB의 KV, `side.delta`·`side.ended`는 호스트 이벤트 스트림, ledger `side` 줄은 spool로 PC에 온다. `side.*`를 모르는 옛 호스트 서비스는 `rpc.method_not_found`이고 own-web이 업데이트하라는 말을 보인다. `proto`는 그대로 |
| 잔액 poller | leader | 끔 |
| 전환 상태 머신, 추정기, cache hint, D9, strip | 있음 | **같은 코드** |
| 프로젝트 플러그인 | 로컬 `trust.json` allowlist | 기본은 프로젝트 설정을 아예 읽지 않음(`projectConfig:"disabled"`, 5.6). 호스트를 `trusted`로 바꾸면 원격 `trust.json` allowlist(서버별 승인) |
| Claude 슬롯 | 선택 | 미러 판정 `claude.state`가 `enabled`이고 이 Location에 충돌이 없을 때만 활성(`activation:"enabled"`, `cost:[]`). 요청은 PC egress 중계(8.11). 그 밖에는 비활성 |
| GitHub(16) | `GitHubConnection`: 보관함의 토큰, MCP 세션, 이 PC의 자격 증명 수신기 | `GitHubRemote`: 같은 `github_*` 도구와 쓰기 승인, 셸·브리지의 git은 git 중계 입구로. 토큰 없음, 계정 선택과 호출은 PC(8.12, 16 §8). `github.*` RPC는 `remote_managed` 그대로 |
| `hideBuiltinProviders` | policy | 미러된 policy. 원격 env 키로 내장 provider가 조용히 과금되는 경로를 막는다 |
| 가드 1 | 버전 + `OWN_OPEN_CODE=1` | + `OWN_REMOTE=1`, 미러 존재, 미러 스키마 버전. 미러가 없으면 slot을 등록하지 않고 `health`만(01 §5.4와 같은 fail closed) |

### 9.2 미러 레지스트리 뷰

로컬 브로커가 `registry.get`으로 만드는 뷰다. **필요한 것만** 보낸다.
- 포함: `schemaVersion`, `revision`, `slots`(providerID, kind, accounts, pooling, modelTemplate, transport, defaultModel), `modelTemplates`, `accounts[]`의 `{id, kind, label, shortLabel, color, providerID, billing, status, autoSwitch, remote, compaction}`, `policy.json` 전체(`policy.compaction.byKind` 포함), `ratecards.json` 전체. 한도 보정 결과는 뷰에 넣지 않고 `calibration.updated`로 따로 보낸다(자주 바뀌고 계정 목록 revision과 무관하므로).
- **자동 압축(02 §4.7).** 원격 own-accounts는 slot을 등록할 때 로컬과 같은 `@own/protocol` 순수 함수 `Compaction.resolve`(02 §4.7.6)에 미러의 템플릿 창·`accounts[].compaction`·`policy.compaction`을 넣어 같은 `T_slot`과 `ctx_eff`를 얻고, 그 값을 등록 모델의 `limit.input`으로 쓴다(02 §4.7.2 (b)). 그래서 같은 계정의 원격 세션도 로컬 세션과 같은 기준에서 core가 자동 압축한다.
  - 로컬에서 압축 설정을 바꾸면(`accounts.update{compaction}`, `policy.set{patch.compaction}`) 레지스트리 revision이 올라가고 `mirror.changed` → `registry.get` → 원격 `provider.reload()`로 전파된다(02 §4.7.4의 재조정 경로를 원격까지 늘림).
  - kind 기본값은 코드 상수라 로컬과 원격의 빌드가 같아야 값이 같다. 정상 모드는 빌드가 같다(5.7). drain 모드의 원격은 디스크의 마지막 미러와 **자기 빌드의** 상수를 쓰므로 값이 다를 수 있다. 원격 세션만의 기준이 바뀌는 것이라 받아들인다.
  - 세션 값("이 세션만 더 일찍", `compaction.setSession`)과 그 KV, `compaction.due`는 원격 인스턴스 몫이다. 경로는 12.6.
  - `anthropic`(Claude 구독 슬롯)은 원격에서도 모델 자체의 압축 규칙(모델 한도, 큰 창은 85%)을 그대로 쓴다. 미러는 슬롯의 압축 설정을 따로 보내지 않는다.
- 제외: `identity`(emailMasked, chatgptAccountId, plan, fingerprint, keyHint, organizationId, workspaceId), `cacheDomains`/`quotaDomains`의 `externalId`, `claudeSlot`(대신 `claude{state, fast, display}`만 보낸다. 8.11.4.3), `budget`. 원격은 이 값들이 없어도 등록과 전환 판단을 할 수 있다(`chatgpt-account-id`는 lease 헤더로 온다).
- 이 계정의 원격 허용이 `deny`이거나 호스트 범위 밖이면 그 slot을 `enabled:false` 모델로 보낸다. slot을 빼지 않는 이유는 과거 턴의 귀속을 보존하기 위해서다(01 §8.1 retired 규칙과 같음).
- 원격은 뷰를 OWN_HOME의 `accounts.json`, `policy.json`, `ratecards.json`에 temp→rename으로 쓰고 `mirror: {from: installId, revision, fetchedAt}`를 붙인다. 원격이 브로커 없이 다시 떠도 slot 목록이 같게 유지되어, 모델이 사라지거나 세션 고정이 풀리지 않는다.
- 미러가 바뀌면 원격 own-accounts가 모든 Location에 `ctx.provider.reload()`를 알린다(02 §3.8과 같은 경로).
- **프리셋(T3, 07 §8.1 원격).** 뷰에 선택적 필드 셋이 더해졌다: `presets`(이 PC의 `presets.json` 그대로), `presetsRevision`(`policyRevision`처럼 내용 해시), `presetsBudget`(그 호스트가 쓸 수 있는 유료(종량제·선불, `retired`가 아니고 호스트 범위 안) 계정마다 `{exhausted}`. 예산 값과 ledger는 여전히 보내지 않음). `presets.json`을 읽지 못하면 셋을 빼고 레지스트리 미러는 막지 않는다(원격은 `평소대로`만). ledger를 읽지 못하면 그 계정은 `exhausted:true`다.
  - **푸시**: `mirror.changed`는 `presets.json`이 바뀔 때(`store.changed{presets}`), 월 예산이 있는 유료 계정의 ledger 줄(이 PC의 것이나 호스트의 `observe.push`)이 판정을 바꿀 때(호스트가 마지막으로 받은 판정 해시와 다를 때만), 1분마다의 점검(새 달)에서도 나간다. drain 세션은 그대로다.
  - **원격 쪽**: `presetsRevision`이 바뀌면 `presets.json`을 원자적으로 먼저 쓰고, 그 revision을 meta(`mirror.presetsRevision`)에 적은 `accounts.json`을 쓴 뒤 `store.changed{presets}`를 낸다. 같은 revision이면 쓰지 않는다. 예산만 바뀐 뷰는 메모리에만 둔다. 원격 store는 meta가 revision을 말할 때만 `presets.json`을 읽는다(옛 로컬 빌드의 뷰는 셋이 없으므로 `평소대로`만, 호스트에 남은 낡은 파일도 무시). 브로커의 lease는 예산으로 거절하지 않는다(예산은 하위 에이전트 대상만 막음, 07 §5.4).
  - PROTO와 `MIRROR_SCHEMA_VERSION`은 그대로다(모두 선택적 필드). 이 필드들은 06 §11.1 스펙 추가 (2)이고 2026-10-05에 사용자가 승인했다(브로커의 lease는 예산으로 거절하지 않는 선택지 (a)).

- **Codex 서버 행(10 §6.14, 2026-11-23, own.18).** 뷰에 선택 필드 `codexRows`(slug → 내용 해시)가 더해졌다. PC의 own-accounts가 받은 ChatGPT Codex 모델 목록 가운데 PC의 codex 하네스가 돌리는 서버 행(`CodexModels.HarnessRow`, 계정 정보 없음)이다. 행 하나가 수십 KB라 템플릿처럼 따로 받는다: 호스트는 갖지 않은 행만 `codexRow.get {slug}` → `{slug, hash, row|null}`로 받아 호스트의 `codex-meta.json`(공유 스냅샷의 `harness`, 모델 사실은 비워 둠)에 쓰고 `store.changed{codex-meta}`를 낸다. 그래서 호스트의 codex 하네스도 새 Codex 모델을 PC와 같은 행으로 돌리고, models.dev에 아직 없는 모델도 호스트의 codex slot에 등록된다(07 §4.4). 호스트는 모델 목록을 직접 받지 않는다. 같은 해시면 받지도 쓰지도 않고, `codexRows`가 없는 뷰(옛 PC)는 파일을 건드리지 않는다. `MirrorMeta.codexRows`에 쓴 행의 해시를 둔다. PROTO와 `MIRROR_SCHEMA_VERSION`은 그대로다. PC의 `codex-meta.json`이 바뀌면(`store.changed{codex-meta}`) `mirror.changed`가 나간다. 실서버 단계 B의 RG20.

### 9.3 creator 확장 미러 (17 §10, 2026-11-06)

PC의 creator 확장(17)은 브로커로 호스트에 간다. 레지스트리 뷰와 따로인 메서드다(바뀔 때 `provider.reload()`를 부르지 않게). 모두 normal 모드(같은 빌드)에서만 받는다(`github.*`와 같다). drain 세션은 `skew_drain`.

| 메서드·푸시 | 방향 | 뜻 |
|---|---|---|
| `creator.get {}` | R→L | 그 호스트에 가는 확장의 보기(`{view?: Creator.MirrorView}`). PC에 own-creator가 돌지 않으면 `view`가 없고, 호스트는 마지막 미러를 그대로 둔다 |
| `creator.file {id, n, path, offset}` | R→L | 그 호스트의 보기에 있는 판의 파일 조각(base64, ≤ 512 KiB, `{data, size, end}`). 보기에 없는 것은 `invalid` |
| `creator.report {revision, at, extensions[]}` | R→L | 호스트에서 확장마다 어떻게 됐는지. PC는 메모리에만 둔다 |
| `creator.changed {}` | L→R | PC 저장소가 바뀜(100 ms 묶음). 호스트가 다시 `creator.get` |

- 쓰는 메서드는 없다. 모르는 메서드는 요청 프레임이 아니므로 세션이 끝난다. 호스트의 own-creator는 받은 파일의 폴더 해시가 PC 판의 해시와 같을 때만 쓴다.
- own-accounts는 own-creator를 불러오지 않는다: PC에서는 own-creator가 own-runtime `CreatorBridge`에 원천(`view`, `file`)을 내놓고 브로커가 그것에 답한다. 호스트에서는 own-accounts(remote)가 세션을 링크로 내놓고 호스트의 own-creator가 그것으로 묻는다.
- `PROTO`와 `MIRROR_SCHEMA_VERSION`은 그대로다(새 메서드는 normal 모드에서만 쓰이고 옛 빌드는 drain이다).

---

## 10. 관측, ledger, 한도 집계

### 10.1 흐름

```text
원격 own-accounts
  step/usage 이벤트 → LedgerLine 생성(02 §7.5와 같은 코드, 요율은 미러 ratecards)
    · primary: session.step.ended/failed
    · compaction·title: session.usage.recorded{source} + 직전 model.request{kind}의 providerID
    · generate: model.request{kind:"generate"} → http.response의 response.clone() SSE에서 usage
                (usageSource "stream" | "estimate", purpose "warming" | null)
  http.response / ws.receive → LimitWindow 관측, lastResponse
  경보 판정(세션 경보), 인증 실패 관측
      │  item {seq, eventId, type, payload}
      ▼
  spool/obs-<streamId>.jsonl  ── observe.push(fromSeq) ──▶ 로컬 브로커
                                                          ├─ 검증(10.5) → runtime ledger writer (server=hostId)
                                                          ├─ 한도 저장소 병합(02 §7.4, observedAt 최신)
                                                          ├─ 계정 상태 판정(10.6)
                                                          └─ ack(ackThrough) ─▶ 원격이 spool 앞부분 삭제
```
- **core가 이벤트로 내지 않는 사용량도 원격에서 읽는다**(02 §7.5 "core가 기록하지 않는 사용량"). 원격 세션의 `/btw`, warming ping, 새 세션 인계 요약은 원격 service에서 돌고 로컬은 그 응답을 볼 수 없다. 그래서 원격 own-accounts가 로컬과 같은 코드(`own-runtime.pendingGenerate`, 응답 사본의 백그라운드 SSE 읽기, 02 §7.5 방법 1–5)로 generate 줄을 만들어 spool에 넣는다. 이 줄의 `server`는 hostId이고, `tokens:null` 추정 줄의 경보(`generate_usage_missing`)도 같은 규칙이다. compaction·title 줄은 step과 같이 이벤트에서 만든다.
- 이것이 빠지면 원격 세션 비용(`ledger.session.totals`)과 한도 보정(02 §7.6)에서 원격 generate 사용량이 사라진다. RG8에서 센다.
- Claude 구독 슬롯의 한도 창은 PC egress 중계가 직접 관측해 `origin=hostId`로 올린다. 호스트는 그 창을 spool로 보내지 않는다. ledger 줄은 spool로 보내고, PC가 허용 호스트일 때만 `acc_claude_slot`으로 귀속한다(8.11.10).

### 10.2 spool

- 원격 파일 `spool/obs-<streamId>.jsonl`. `streamId`는 원격 설치마다 한 번 만든 난수, `seq`는 그 안에서 단조 증가한다.
- 한도: 20 MiB, 10만 항목, 7일 중 먼저 닿는 것. 넘으면 **오래된 ledger 항목부터** 버리고 LimitWindow 관측은 id별 최신 하나만 남긴다(최신 값이 앞의 값을 대체하므로). 버린 범위는 `gap {fromSeq, toSeq, count}` 항목으로 남긴다.
- 브로커가 연결되어 있으면 즉시 보내고, 끊겨 있으면 쌓는다. 재연결하면 `ackThrough` 다음부터 순서대로 다시 보낸다.
- 파일 끝줄이 잘렸으면 그 줄만 버린다.
- spool은 이벤트 기록일 뿐 세션의 원본이 아니다. 잃어도 세션은 멀쩡하고, 사용량 합계에 "누락 구간"이 표시될 뿐이다.

### 10.3 중복 제거와 ack

- 로컬은 호스트별 `OWN_HOME\remote\<hostId>\observe-ack.json {streamId, ackThrough}`를 두고, 그 이하의 `seq`는 버린다. 로컬이 재시작해도 재전송이 중복 기록되지 않는다.
- 항목마다 `eventId`(ULID)도 있다. runtime ledger writer의 기존 멱등 처리(01 §4)가 두 번째 방어선이다.
- `gap` 항목을 받으면 `ledger\events-YYYY-MM.jsonl`에 `remote.spool.gap {hostId, count, from, to}`를 쓰고 경보 `remote_spool_overflow`를 낸다. `accounts.usage`의 해당 기간 행에 `incomplete:true`를 붙인다.

### 10.4 스키마 추가 (02에 제안, 22장)

- `LedgerLine.server: "local" | <hostId>`. 없으면 `"local"`로 읽는다(v1 호환).
- `LimitWindow.origin?: "local" | <hostId>`. 표시와 무결성 규칙(10.5)에 쓴다.
- `accounts.usage` 행과 `ledger.session` 입력에 `server`.
- events ledger 종류: `remote.connected`, `remote.disconnected`, `remote.updated`, `remote.drained`, `remote.lease.issued`(5분 합계), `remote.broker.auth_failed`, `remote.spool.gap`, `remote.observation.rejected`.

### 10.5 무결성 규칙

원격은 로컬보다 덜 믿는다. 원격이 거짓 관측을 보내도 로컬 세션과 계정이 망가지지 않게 한다.
- **시각 정규화가 먼저다.** 원격 항목의 시각은 원격 시계 값이다. 로컬은 `ping`으로 잰 `clockSkewMs`(8.4)를 빼서 로컬 시각으로 바꾼 뒤 검증한다. 원래 값은 `remoteAt`으로 함께 남긴다. `|clockSkewMs|`가 2분을 넘으면 호스트 경고 `remote_clock_skew`를 내고(호스트 패널에 "원격 시계가 N분 어긋나 있습니다"), 10분을 넘으면 정규화한 값도 믿지 않고 수신 시각을 쓴다.
- 모든 항목을 `@own/protocol` 스키마로 검증한다. 수치 범위(토큰 ≥ 0, `usedPercent` 0–100, 정규화 뒤 미래 시각은 `now + 5분`까지)를 벗어나면 버리고 `remote.observation.rejected`를 센다.
- 원격 관측이 만든 `exhausted`는 표시와 **원격 세션의** 전환 제안에만 쓴다. 로컬 세션의 **자동** 전환(API 키 failover, 02 §5.2)은 로컬 관측이나 로컬이 직접 확인한 오류로만 트리거한다. 원격 관측만 있으면 로컬 세션에는 "다른 호스트에서 소진 관측" 제안만 한다.
- 원격 관측은 계정 상태를 `needs_reauth`로 바꾸지 못한다. 인증 실패 관측이 오면 로컬이 직접 확인한다(10.6).
- ledger 줄의 `accountID`는 로컬이 `providerID`로 다시 계산한다. 원격이 적은 값은 믿지 않는다.

### 10.6 계정 상태 전파

- 원격이 `authFailure {providerID, authHash8, status}`를 보내면 로컬은 8.8 규칙으로 refresh를 시도하거나, API 키면 `accounts.test`와 같은 가벼운 확인을 한 번 한다. 결과만 로컬 상태 머신에 반영한다.
  - linked 계정이면 refresh도 로컬 상태 변경도 하지 않는다. 8.8의 linked 규칙(원본 재확인, hash가 같으면 그 호스트만 `scope:"host"` stale)만 적용한다.
- 로컬 상태가 바뀌면 `account.status` push → 원격 전환 상태 머신이 BLOCKED 등을 판단한다. linked 계정의 로컬 `codex_source_stale`과 그 풀림(`ready`)도 이 경로로 모든 호스트에 간다.
- `accounts.list`의 `lastUsedAt`, `sessions.running`은 원격 step·실행 관측을 포함한다. 03 사이드바 "사용 중 계정"(최근 24시간)에 원격 사용도 들어간다.

---

## 11. 계정·provider 전환의 의미

- **같은 상태 머신**: 원격 세션의 전환은 원격 own-accounts 인스턴스가 02 §5를 그대로 돈다. KV(`sess:<sid>:*`, 02 §2.4.6)는 원격 DB에 있다. own-web의 전환기·비용 대화상자·되돌리기는 로컬 세션과 같고, RPC만 원격 서버로 간다(12.6).
- **입력의 출처**

| 입력 | 원격 세션에서의 출처 |
|---|---|
| 레지스트리, 템플릿, policy, ratecards | 미러(9.2) |
| 한도 스냅샷(`LimitWindow`) | 로컬 push(`quota.updated`) + 원격 자신의 관측 |
| 한도 보정 결과(02 §7.6: 계정·모델별 계수, R², 표본 수) | 로컬 push(`calibration.updated`). 보정은 로컬 ledger(단일 writer)로만 적합하므로, 이 push가 없으면 원격 추정기는 보정 전 범위 규칙으로 떨어진다 |
| ledger 기반 이력(최근 step 사용량 등 추정기 입력) | 원격 세션 자신의 step은 원격 인스턴스가, 계정 전체 이력은 로컬 `accounts.usage` 조회로 |
| 계정 상태 | 로컬 push(`account.status`). linked 계정의 호스트 단위 stale(`scope:"host"`, 8.5)도 여기로 온다 |
| 자동 압축 기준(`T_slot`, `ctx_eff`) | 미러의 압축 설정으로 원격이 계산(9.2). 세션 값은 원격 KV |
| 캐시 상태, `lastResponse`, busy/idle, epoch, variant 기억(R14) | 원격 인스턴스 자신 |
| 전환 기록 | 원격 `switch.recorded` 이벤트 + 로컬 events ledger(관측 push) |

- **캐시 도메인은 실행 위치와 무관하다.** providerID(= slot), 고정 템플릿, identity 정규화(02 D9), 인증·세션 헤더가 로컬과 같기 때문이다. 원격 세션의 system prompt에는 원격 OS와 경로가 들어가지만, 캐시는 세션 prefix 단위이고 세션은 서버를 옮기지 않으므로 상관없다. 원격 세션의 hit률이 로컬과 같은지는 RG9로 잰다.
- **cold point, 압축 후 전환, 곁가지 포크**: own-web이 원격 서버에 `POST /api/session/:id/compact`·`fork`를 보낸다. 로컬과 같은 `clientAction` 순서다(02 §5.9).
  - 압축은 로컬과 같이 cold point다(02 §4.7.5). 작은 창으로 전환하기 전 압축(`compact-then-switch`, 경고 `target_compacts_soon`·`compaction_may_truncate`)도 원격 인스턴스가 미러로 계산한 대상의 실효 기준 `T_t`로 판단하므로 로컬 세션과 같은 결과가 나온다.
- **자동 전환**: 구독은 수동만, API 키는 하드 트리거만(01 §8.6)이 원격에서도 같다. 원격 세션의 하드 트리거는 원격 관측이어도 된다(그 세션이 직접 받은 오류이므로). 10.5의 제한은 **로컬** 세션의 자동 전환에만 걸린다.
- **서버 사이 전환은 없다.** "이 세션을 다른 호스트로 옮기기"는 비목표다(1.2). 원격 세션의 모델 선택기에는 그 호스트에 허용된 계정만 나온다(8.9).
- **needs_reauth·소진 뒤 복귀**: 로컬에서 다시 로그인하거나 리셋이 지나면 로컬 상태가 바뀌고 push되어, 원격 세션에도 02 §5.8 "원래 계정으로 돌아가기" 제안이 뜬다.

---

## 12. own-web 멀티 서버

### 12.1 서버 레지스트리와 인증

- own-web은 서버 목록을 가진다: `local`과 호스트마다 `{serverKey: hostId, url: "http://127.0.<k>.2:<LP>", token}`.
  - `local`의 인증은 모드마다 다르다(01 §6.1, 05 §6.4). 데스크톱은 렌더러가 Authorization 없이 보내고 main이 로컬 서비스 origin 요청에만 Basic을 넣는다. 쿠키는 없다. 웹 폴백은 same-origin pairing 쿠키다.
  - 원격 서버의 인증은 모든 모드에서 같다. 렌더러(또는 웹 폴백 탭)가 아래 세션 토큰을 헤더로 직접 붙인다. main은 원격 주소에 아무것도 넣지 않는다. 주입 URL 필터가 `http://127.0.0.1/*`·`http://localhost/*`이고, origin이 로컬 서비스와 정확히 같아야 하기 때문이다(`packages/desktop/src/main/windows/security.ts:42-53`, `service/sidecar-credentials.ts:26-29`, 4.4).
  - 서버 항목의 `baseUrl`은 경로 접두어를 허용하는 절대 URL로 다룬다. 휴대폰(M1+)은 `https://<pc>.<tailnet>.ts.net/srv/<serverKey>`를 쓰기 때문이다(12.7, 05 §13.4 "경로 접두어").
- **원격 서버 인증**
  - **토큰은 own-remote가 직접 서명한다.** 세션 토큰 형식은 `<만료초>.<HMAC>`이고 키는 서비스 비밀번호에서 나온다(`packages/server/src/auth.ts:39-45,63-66`). 검증은 미래 만료면 모두 받으므로(`auth.ts:47-56`) 비밀번호를 가진 own-remote가 짧은 만료로 직접 만들 수 있다. 기본 12시간(호스트 설정 `tokenTtlHours` 8–24)이고, `resolve`가 불릴 때 남은 수명이 1시간 미만이면 새로 서명한다. 원격 서버에는 pairing 요청을 보내지 않는다. check-surface가 형식을 지키고(4.4), 형식이 바뀌면 pairing API(`POST /api/pair` → `GET /auth/connect/<code>`를 `Accept: application/json`으로, `packages/server/src/handlers/server.ts:27-50`, 30일 토큰)로 되돌린다.
  - own-web은 `own.remote.resolve{hostId}`로 `{url, token, tokenExpiresAt, epoch, controlDir, home}`만 받는다. **원격 서비스 비밀번호는 렌더러에도 셸 main에도 주지 않는다.** upstream은 비밀번호를 모든 renderer에 준다(`packages/app/src/servers/ssh/types.ts:26-34`, `controller.ts:58-68,180`).
  - own-web은 토큰을 **렌더러(탭) 메모리에만** 둔다. localStorage, IndexedDB 세션 목록 캐시(01 §6.3), URL, 로그에 남기지 않는다. 헤더는 `Authorization: Basic base64("opencode:"+token)`이다(인증 미들웨어가 세션 토큰을 비밀번호 자리에서 받는다, `packages/server/src/auth.ts:32-37`). 예외는 원격 세션의 브라우저 패인을 attach할 때 main에 넘기는 것 하나다(7.6, 05 §8.2).
  - **CORS의 방향.** 요청의 origin을 허용해야 하는 쪽은 **원격 서버**다. 원격 서버는 같은 서버 코드라 기본 CORS가 두 모드의 origin을 모두 허용하므로 따로 설정할 것이 없다(`packages/server/src/cors.ts:11-20`).
    - 데스크톱: origin `oc://renderer`(`cors.ts:15`). main도 렌더러 session 응답에 `Access-Control-Allow-Origin: *`를 더한다(`packages/desktop/src/main/windows/headers.ts:4-20`).
    - 웹 폴백: origin `http://127.0.0.1:P`(`cors.ts:14`).
    - 반대 방향: 원격 끝점 자체는 `127.0.<k>.2`에 있다. 그 주소를 origin으로 하는 페이지가 생겨도 **로컬** 서버의 CORS는 그 origin을 허용하지 않는다(4.4). 웹 폴백의 로컬 쿠키도 그 호스트로 가지 않는다(7.3).
  - 원격 서버에는 쿠키를 쓰지 않는다. 쿠키 인증은 same-origin 요청만 받기 때문이다(`packages/server/src/middleware/authorization.ts:63-70`). `?auth_token=`도 쓰지 않는다(01 §6).
  - `own.remote.resolve`의 응답은 02 §9.1 "응답에 비밀을 넣지 않는다"의 **예외**다. provider 비밀이 아니라 서버 접근 토큰이고, own-web이 이미 로컬 서버에 대해 갖는 접근 권한(데스크톱은 main 주입, 웹 폴백은 쿠키)과 같은 신뢰 경계다(16.2). 그래서 `resolve`는 `local` 범위이고 게이트웨이를 거쳐 부를 수 없다(16.7). 휴대폰은 토큰을 받지 않고 게이트웨이가 대신 붙인다(12.7).
- **데이터 층**: 서버마다 `OpenCode.make({baseUrl, headers})` → `createClientConnection` → `createData`를 따로 만든다(03 §16.3, upstream 서버별 컨트롤러 `packages/app/src/runtime/server/runtime.tsx:35-70`). 이벤트 스트림도 서버마다 하나다. 호스트·포트가 달라 브라우저의 호스트당 6연결 제한에 서로 걸리지 않는다. 원격 서버 요청도 로컬과 같이 main document에서만 보낸다(워커에서 API를 부르지 않는 05 §6.4 규칙과 같은 코드 경로).
- **끝점 변경**: `host.state` 이벤트의 `epoch`가 바뀌면 `resolve`를 다시 부르고 client를 다시 만든다. 라우트와 초안, composer는 unmount하지 않는다(upstream `packages/desktop/src/renderer/ssh/connections.ts:6-27`와 같은 원칙).

### 12.2 연결 상태 표시와 재연결

- 사이드바 서버 줄과 세션 헤더에 상태를 보인다: `연결됨`, `연결 중…`, `인증 필요`, `업데이트 필요`, `연결 끊김`, `다른 PC가 관리 중` 등(17.9).
- 끊긴 서버의 세션을 열어 둔 경우: 라우트를 유지하고 overlay를 덮는다. 문구 `원격 세션은 호스트에 그대로 있습니다. 다시 연결하는 중…`. composer는 비활성(upstream `packages/app/src/servers/ssh/authentication.tsx:14-57`, `packages/app/src/composer/model.ts:37`).
- 원격 서버 이벤트 스트림의 재연결은 `@opencode/client`의 기존 루프를 쓴다(2초 connect timeout, 1초 지연, 45초 idle watchdog, `packages/client/src/solid/connection.ts:33-38,147-183`). 스트림이 끊기면 own-web은 `own.remote.resolve`를 3초 간격으로 부르고, 호스트가 `ready`가 되면 client를 다시 만든다(upstream `connections.ts:60-67`). pause된 호스트는 `url:null`을 돌려주므로 사용자가 누를 때까지 조용히 기다린다.

### 12.3 사이드바 통합과 catalog

- **그룹**: `이 PC` → 호스트들(추가 순서, 드래그로 정렬). 각 그룹 아래는 03 §4.3과 같은 프로젝트 → 세션 행이다. 계정 칩, 상태 기호, 하위 에이전트 규칙이 모두 같다.
- **목록 읽기는 SSH를 기다리지 않는다**([old] 84). 원격 서버가 연결되어 있지 않으면 catalog를 흐리게 보인다: 머리줄 `연결 끊김`, 목록 위 `저장해 둔 목록 · 12분 전`.
- **catalog**
  - 저장: `OWN_HOME\remote\<hostId>\catalog.json` `{epoch, fetchedAt, projects[], sessions[]}`. 상한 프로젝트 100개, 세션 500개, 2 MiB.
  - **쓰기는 로컬 own-remote leader만 한다**(v0.3에서 바꿈, 24장 27번). own-web이 쓰던 이전 설계(`catalog.put`)는 없앴다. 데스크톱 창이 닫혀 있어도, 웹 폴백 탭이 없어도, 휴대폰(M1+)이 오프라인 목록(05 §13.7)을 받을 수 있어야 하기 때문이다.
    - 호스트가 `ready`가 되면(3.2 ⑥) leader가 `-L` 위로 원격 `GET /api/event`를 **하나** 구독하고(세션 토큰은 own-remote가 서명한 것, 12.1), 목록(`GET /api/project`, `GET /api/session?parentID=null&limit=50&cursor…`, 03 §3)을 받아 **통째로 교체**(epoch 증가)한다. 지워진 세션이 남지 않는다(이전 앱의 stale 제목 문제, [old] `docs/design/ssh-sidebar-cache-84.md:20-25`).
    - 그 뒤에는 원격 이벤트 중 세션·프로젝트 생성·변경·삭제만 보고 2초 debounce로 바뀐 부분을 다시 받는다. 원격 `/api/event`는 서버 전체 스트림이라(`packages/server/src/event-feed.ts`, Bus 구독 하나) 호스트당 연결 하나로 모든 location을 본다. 끊기면(연결당 4096 프레임 상한 포함, `event-feed.ts:8`) 재구독 뒤 다시 통째로 교체한다.
    - 정상 모드(버전 일치, 5.7)에서만 구독한다. `incompatible`·drain 모드 호스트는 이벤트 스키마가 다를 수 있으므로 구독하지 않고, catalog는 마지막 스냅샷으로 남는다. drain 판정은 `GET /api/session/active` 조회로 한다(6.4).
    - 같은 구독이 (M2) 원격 세션의 알림 피드 항목(`turn.completed`, `permission.asked` 등, 05 §13.6)의 출처가 된다. 피드 항목 규칙(내용 없음, 제목만)은 05가 기준이다.
    - 비용: 호스트당 SSE 하나와 목록 조회. 스트리밍 텍스트 이벤트도 함께 오므로 leader는 필요한 이벤트 종류만 남기고 나머지는 파싱하지 않고 버린다 ⚠(RG12에서 CPU 측정).
  - 읽기: `own.remote.catalog.get{hostId}`와 이벤트 `catalog.changed{hostId, epoch}`. 제목, 갱신 시각, `model`(계정 칩용), 프로젝트 경로만 있고 메시지는 없다.
  - own-web은 라이브 연결 중에는 원격 서버에서 직접 목록을 받는다(catalog를 기다리지 않음). catalog는 끊겼을 때와 첫 화면(01 §6.3 세션 목록 캐시)에만 쓴다.
  - 세션 삭제는 연결된 상태에서만 원격 API로 한다. 보관·고정은 v2에 API가 없으므로(01 §17.1의 P7 27번) 그 세션이 있는 서버의 own metadata에 쓰는 같은 방식을 원격 서버에도 쓴다. 오프라인 tombstone은 필요 없다. 원격 DB가 원본이고, 연결 때 catalog를 교체하기 때문이다.
- **이 빌드의 구독 상태(T3).** 위 호스트당 catalog 구독은 아직 꺼져 있다(`hosts.list`의 `events.state:"off"`). 대신 게이트웨이의 피드 생산자(05 §13.6)가 **준비된 호스트마다 좁은 `/api/event` 구독 하나**를 둔다(06 §11.1 스펙 추가 (3), 2026-10-05 승인): own-remote 터널의 끝점과 서명한 토큰을 프로세스 안에서 받아(12.7) `rpc.own.team.*` 프레임만 파싱하고(다른 프레임은 파싱 전에 문자열 검사로 버림) FeedKind `team.decision` 항목을 만든다. 생산자가 시작할 때, 로컬 `rpc.own.remote.host.state`마다, 10초마다 `ready`인 호스트만 본다(준비되지 않은 호스트를 resolve하면 연결을 시작하므로). 끊기면 1초에서 30초까지 늘려 다시 붙고, 호스트가 `ready`를 벗어나거나 피드가 멈추면 끝낸다. 항목의 `serverKey`는 hostId다. 원격 세션의 다른 피드 항목(`turn.completed` 등)은 여전히 위 구독을 기다린다.
- **정렬·검색**: 호스트 안에서는 03과 같다. "최근" 보기(여러 서버를 합친 목록)는 catalog와 라이브 목록의 `updatedAt`으로 합친다.
- **세션 키**: 모든 곳에서 `(serverKey, sessionID)`. 드래프트, 열린 탭, 알림, 03 §3의 라우트 `/srv/<hostId>/s/<sessionID>`가 이 키를 쓴다.

### 12.4 원격 폴더 열기와 realpath

- 호스트 줄의 `폴더 열기…` → 원격 서버의 `GET /api/fs/list`로 탐색한다. upstream도 로컬이 아닌 서버는 서버 API로 고른다(`packages/app/src/workspaces/selection/policy.ts:4-7`). 경로를 직접 적을 수도 있다.
  - **`fs.list`는 location을 요구한다.** `location[directory]`가 필요하고, 항목 경로는 그 location 기준 상대 경로로 온다(`packages/protocol/src/groups/fs.ts:47-58`). 폴더 선택기는 **항상** `location[directory]=<원격 controlDir>`과 **절대** `path`로 부르고, 받은 상대 경로를 client에서 controlDir 기준으로 절대 경로로 바꾼다.
  - 원격 `$HOME`이나 탐색 중인 폴더를 location으로 쓰지 않는다. location으로 쓰면 그 디렉터리에 Location이 생겨 파일 감시와 플러그인 로드가 원격 홈 전체에 걸린다(01 G15가 막는 일). `홈으로`는 inspect가 보고한 `HOME` 절대 경로를 `path`로 넘길 뿐이다.
  - `controlDir`은 `resolve` 응답(ensure가 보고한 값)에서만 받는다. 02 §9.1의 "없으면 아무 location으로 `health`" 대체는 원격에서 쓰지 않는다(16.6).
- 고른 경로는 원격 own-remote(agent)의 `agent.realpath{path}`로 실제 경로로 바꾼다. 다르면 `심볼릭 링크 대신 실제 경로로 엽니다: <realpath>`를 보인다.
  - 이유: 이전 앱에서 symlink 경로로 등록한 프로젝트와 realpath로 기록된 세션 cwd가 어긋나 세션이 다른 프로젝트로 튀었다([old] `docs/design/ssh-worktree-project-grouping-96.md:21,93`). 항상 realpath를 `location[directory]`로 쓴다.
- 세션 생성은 원격 서버에 `POST /api/session?location[directory]=<realpath>`이고, 01 §8.5 고정 규칙대로 `model`을 항상 보낸다. 모델 기본값은 로컬 `policy.defaults`에서 그 호스트에 허용된 계정으로 고른다.
  - **호스트가 그 모델을 보일 때까지 기다린 뒤 만든다(MR11-1, 2026-11-03).** 기본값은 이 PC의 계정과 모델이지만, 호스트는 broker로 이 PC 레지스트리의 미러(9.2)가 도착해야 그 슬롯을 목록에 올린다. 연결 직후에는 broker가 아직 붙는 중일 수 있다(부하가 걸리면 수십 초). 그 사이에 만든 세션은 첫 프롬프트가 `Model unavailable: own-oai-…/gpt-6.1-terra`로 실패한 채 남았다. 그래서 입력창은 원격 서버에서 새 세션을 만들기 전에 그 폴더의 모델 목록을 읽고, 대상 모델이 없으면 `원격 호스트가 이 PC의 계정을 받는 중이에요. 받으면 보내요` 토스트를 띄우고 그 폴더의 `model.updated`로 목록이 채워질 때까지 기다린다(최대 120초, own-web `hostServes`. v2.4.1부터 호스트 서비스가 플러그인을 뒤에서 불러와 미러의 슬롯이 더 늦게 올라오므로 60초에서 늘림, MR18). 끝내 없으면 세션을 만들지 않고 입력을 되돌린 뒤 `원격 호스트에 이 모델이 아직 없어요. 연결을 확인하고 다시 보내 주세요`를 보인다. 이 PC 서버에서는 기다리지도 읽지도 않는다. 기다리는 동안 입력창은 읽기 전용이다(그 사이 쓴 글이 새 대화로 옮겨 갈 때 사라지지 않게). 기다리는 중에 사용자가 다른 화면으로 가면 기다림을 바로 끝내고 세션을 만들지 않는다. 새 대화로 다시 끌고 가지 않고, 쓴 글은 입력 기록(↑)과 그 화면의 초안에 남으며 `화면을 옮겨서 새 대화를 만들지 않았어요. 쓴 글은 입력 기록(↑)에 있어요`를 보인다(MR12-5). 떠났는지는 보낸 순간의 화면으로 판정하고(기본 대화 폴더를 만들기 전), 목록을 읽은 직후·마지막 확인 직후에도 다시 보므로 그 사이에 떠난 사용자도 새 대화로 가지 않는다(이 PC 서버도 같음, RL2-L3). 시험: own-web `switcher/new-session.test.ts`(화면을 떠나면 `left`), 원격 Playwright(호스트의 첫 미러를 broker 연결 20초 뒤로 미룸, own-accounts 시험용 `broker.mirrorDelayMs`; 기다리는 동안 입력창이 읽기 전용).
- 원격 서버의 `location[directory]`는 원격 `GET /api/location`의 정규화 값을 쓴다(03 §16.3 규칙과 같음).

### 12.5 세션 화면

- 세션 헤더 제목 옆에 서버 배지(`lab`)를 붙이고, hover로 `사용자@호스트:경로`를 보인다.
- 셸·파일 도구 결과, 파일 링크, diff는 **원격 경로**다. `로컬에서 열기` 같은 로컬 동작은 원격 서버에서 숨긴다. `탐색기에서 열기`와 `탐색기에서 보기`는 데스크톱 앱에서 보이고(2026-11-21), Windows 탐색기가 아니라 사용자가 고른 SSH 파일 탐색기 프로그램을 그 호스트와 원격 경로로 실행한다(17.10, 03 §19.5a, 05 §7.10). 브라우저·휴대폰·원격 PC 창에서는 전처럼 숨긴다.
- PTY: 원격 서버의 PTY WebSocket이 같은 `-L` 터널(`ws://127.0.<k>.2:<LP>`)로 간다(ticket 인증, `packages/server/src/middleware/authorization.ts:83`). 데스크톱도 ticket 흐름이다(WebSocket URL은 main 주입 대상이 아님, 05 §6.4). 웹 폴백에서 WebSocket 업그레이드는 늘 쿠키를 싣지만, 호스트가 `127.0.0.1`이 아니므로 로컬 pairing 쿠키는 실리지 않는다(7.3). 셸은 원격 login shell(`$SHELL -l`)이다.
- 데스크톱의 네이티브 폴더 선택, 실제 경로 드래그처럼 05 §6.2에서 "로컬 서버에만"인 capability도 원격 세션에서 끈다. 폴더 선택은 원격 `fs.list` 선택기(12.4)이고, 첨부는 업로드다.
- **큰 세션.** 이전 앱에서 턴 8개짜리 페이지가 52 MB, 전체 이력 읽기가 1.08 GB였다([old] 83). 우리에게 32 MiB 브리지 한도는 없지만, 느린 SSH 링크로 수십 MB를 받는 비용은 그대로다.
  - 원격 서버의 첫 메시지 페이지는 10개(로컬 03 §16.4는 30개), 이전 페이지도 10개씩이다.
  - 64 KiB를 넘는 도구 출력과 이미지 part는 자리 표시로 두고, 펼칠 때 받는다. `@opencode/client`가 서버별 페이지 크기와 part 지연 로드를 허용하는지는 ⚠(RG13). 안 되면 own-web 데이터 층에서 페이지 크기만 줄인다.
  - `session.export` 등 세션 전체 이력을 한 번에 읽는 호출은 원격 서버에 보내지 않는다. 원격 서버용 client 래퍼가 이 메서드를 노출하지 않고, lint 규칙이 원격 경로에서 직접 부르는 코드를 막는다.
- 브로커 경보가 있으면 세션 배너: `로컬 인증 브로커에 연결할 수 없어 모델을 부를 수 없습니다(안전하게 멈춤). 연결되면 자동으로 다시 시도합니다 — 남은 시간 4분`(8.7).

### 12.6 RPC·HTTP 라우팅 규칙

| 호출 | 원격 세션일 때 보내는 곳 |
|---|---|
| 세션 HTTP(`/api/session/*`, compact, fork, prompt, PTY, fs) | 그 원격 서버 |
| `own.accounts` 세션 메서드(`switch.*`, `session.binding`, `cache.*`, `compaction.setSession`) | 그 원격 서버, `location[directory]` = 세션의 원격 directory |
| 세션 이벤트 `compaction.due`(02 §4.7.4) | 그 원격 서버의 이벤트 스트림에서 온다. own-web은 **같은 원격 서버**에 `POST /api/session/:id/compact {id: inputID}`를 보낸다. 재연결 때는 원격 `cache.state.compaction.pendingDue`를 본다 |
| 압축 설정 변경(`accounts.update{compaction}`, `policy.set{patch.compaction}`)과 `dryRun` | **로컬** control location. 미러로 원격에 전파된다(9.2). `dryRun`의 `compactionImpact`는 로컬 세션만 센다 ⚠(24장) |
| `own.accounts` `ledger.session` | **로컬** control location, 입력 `{sessionID, server: hostId}`(10.4) |
| `own.accounts` 계정·한도 조회(`accounts.list`, `quota.snapshot`, `accounts.usage`), `policy.*`, `ratecards.*`, `plugin.claudeAuth.*` | **로컬** control location |
| `own.accounts` `health`, `diagnostics.selfTest` | 서버마다(가드 2를 서버별로 표시) |
| `own.accounts` `plugin.trust.*` | 그 서버의 control location(승인은 서버별) |
| `own.remote.*` 관리 메서드 | 로컬 control location |
| `own.remote` `agent.*` | 그 원격 서버 |

- own-web은 원격 서버의 `accounts.*` 변경 메서드를 부르지 않는다. 불러도 `remote_managed`다.
- 계정 칩은 원격 세션의 `SessionInfo.model.providerID` + **로컬** `accounts.list`로 만든다(01 §15와 같은 방식).
- 문맥 막대(03)의 분모와 기준 표시는 원격 세션이면 그 원격 서버의 `cache.state.compaction.{windowTokens, triggerTokens}`를 쓴다. 등록 모델의 `limit.input`(= `ctx_eff`)을 쓰지 않는 것은 로컬과 같다(02 §4.7.2).

### 12.7 휴대폰에서 원격 세션 (M1+, 05 §13)

- 휴대폰은 SSH 호스트에 직접 닿지 않는다. PC의 게이트웨이(05 §13.4)가 `/srv/<hostId>/api/*`를 own-remote가 가진 그 호스트의 `-L` 끝점(`http://127.0.<k>.2:<LP>`)으로 중계하고, own-remote가 서명한 세션 토큰(12.1)을 게이트웨이가 넣는다. 들어온 `Authorization`·`Cookie`·`Origin`·`Referer`는 지운다(05 §13.4).
- 휴대폰은 SSH 키, 원격 서비스 비밀번호, 원격 세션 토큰, 브로커 키 어느 것도 받지 않는다. `own.remote.resolve`는 `local` 범위라 게이트웨이를 거쳐 부를 수 없다(16.7).
- 게이트웨이는 own-remote에서 토큰과 끝점을 **프로세스 안 함수**로 받는다(같은 own-runtime 프로세스 수명 런타임, 4.1). RPC로 꺼내지 않는다.
- 호스트가 연결돼 있지 않으면 게이트웨이는 503과 `host.state`를 준다. 휴대폰은 catalog(12.3)를 먼저 보이고 흐리게 표시한다(05 §13.7).
- `/srv/<hostId>` 중계는 원격 서버의 `/api/rpc/own.remote/agent.*`를 **항상 막는다**(`agent.broker.arm`은 브로커 키를 싣고, `agent.probe`는 명령을 실행한다). 원격 서버의 `own.accounts` 메서드는 02 §9.1 `MethodScope`로, 세션 HTTP는 05 §13.5 범위로 거른다.
- 원격 호스트 연결·설치·프롬프트 응답은 PC에서만 한다. 휴대폰이 할 수 있는 호스트 동작은 16.7 표의 `read`·`drive`·`manage` 범위뿐이다.
- 원격 세션의 휴대폰 알림(M2)은 12.3의 원격 이벤트 구독이 만든 피드 항목에서 나온다. T3의 원격 팀 결정(`team.decision`)은 12.3의 좁은 팀 구독이 만든다(그 호스트를 `servers`에 가진 기기만 봄).
- **원격 팀(T3, 06 §2.7).** `/srv/<hostId>`의 `/api/rpc/own.team/<method>`는 이 PC와 같은 `OwnTeamRouting.MethodScope` 표로 거른다: `local`(확인 `op.confirm`, `integration.push.*`, `settings.set`)은 어떤 기기에도 403 `local`, 표에 없는 메서드는 403 `unknown`, 나머지는 기기 범위대로다. 이벤트 `rpc.own.team.*`는 선언된 것만 그 호스트의 스트림으로 지나간다. 원격 호스트의 `own.computer`는 언제나 거절한다(컴퓨터 사용은 이 PC에만). 앱 기기(08)도 같은 판정이다.
- **다른 도구의 대화(IMPORT, 09 §5.5).** `/srv/<hostId>`의 `/api/rpc/own.import/<method>`는 어떤 기기 범위로도 거절한다(`remote`). 원격 호스트에는 own-import가 없다(4.1). 이 PC(`/srv/local`)의 `own.import`는 05 §13.5 표대로다.

---

## 13. 스킬·설정 동기화

- **원칙**: 스킬, 플러그인, MCP는 원격에서 해석된다. 동기화는 명시적 동작(`own.remote.sync.plan → execute{nonce}`)이다. 자동으로 덮어쓰지 않는다.
- **대상 스킬 위치(원격)**: `~/.config/own-open-code/skills/<name>/`. upstream은 config 디렉터리 항목의 `skill/`, `skills/`를 스킬 원천으로 쓴다(`packages/core/src/config/plugin/skill.ts:84-87`). 원격 `OPENCODE_CONFIG_DIR`가 이 디렉터리이므로 따로 설정할 것이 없다.
- **원천(로컬)**: `%USERPROFILE%\.config\own-open-code\skills\*`. 선택적으로 호환 루트(`.claude/skills`, `.agents/skills`, `packages/core/src/config/plugin/compatibility.ts:41`)의 스킬도 고를 수 있다. **다른 도구에서 가져온 스킬**(09 §9, SKILLS 2026-10-10)도 이 폴더의 보통 항목(`skills\<id>\`, 복사본)이라 따로 다루지 않는다. 원본 기록 `OWN_HOME\state\skill-imports.json`은 이 PC에만 두고 원격으로 보내지 않는다. own.import는 원격 호스트에 없으므로 원격에서 가져오기·URL 설치는 하지 않는다.
- **절차**
  1. plan: 로컬 스킬마다 내용 해시(sha256, 디렉터리 트리 정렬), 원격 `.own-sync.json`(우리가 관리하는 항목 목록)과 비교해 `추가/갱신/그대로/이미 있음/충돌`을 만든다.
     - **원격 service가 읽는 모든 스킬 루트를 본다.** own config 디렉터리의 `skills/`만이 아니라 전역 호환 루트 `~/.claude/skills`, `~/.agents/skills`도 원격 service가 자동으로 읽는다(`packages/core/src/config/discovery.ts:28-31`, `packages/core/src/config/plugin/compatibility.ts:39-55`). 이전 앱은 관리 호스트에 네이티브 스킬을 `~/.agents/skills/{3d-assets,game-audio,game-vfx}`로 설치했다([old] `docs/operations/ssh-native-skills.md:16`). 호스트 `projectConfig`가 `trusted`면 프로젝트 쪽 `.claude/skills`, `.agents/skills`, `.opencode/skills`도 대상이다.
     - 원격 루트에 같은 이름·같은 내용이 이미 있으면 `이미 있음`(원격 네이티브)으로 보이고 보내지 않는다.
  2. 충돌: **어느 루트에서든** 원격에 같은 스킬 id가 있는데 우리 관리 목록에 없으면(사용자가 직접 만들었거나 이전 앱이 설치한 것) **덮어쓰지 않고 보내지도 않는다**. 같은 id가 두 루트에 있을 때 어느 쪽이 이기는지 upstream 규칙에 기대지 않기 위해서다. plan에 "원격의 `<루트>`에 같은 이름의 스킬이 있음"으로 보인다.
  3. Windows 전용 의심: `.ps1`, `.bat`, `.cmd`, `.exe`, 드라이브 문자 경로가 있으면 `Windows 전용일 수 있음` 표시를 붙이고 기본 선택을 끈다. 이전 앱의 Windows 전용 스킬 브리지([old] `docs/design/windows-skills-over-ssh-70.md:30,66`)는 옮기지 않는다.
  4. execute: tar로 묶어 SSH stdin으로 보내고, 원격에서 해시 확인 뒤 원자적으로 배치한다. `.own-sync.json`을 갱신한다.
  5. 삭제는 우리 관리 목록에 있는 항목만 한다.
- **creator 확장**(17 §10): 이 절의 동기화와 다르다. 명시적 동작 없이 브로커 미러(9.3)로 늘 따라간다. PC에서 만들고 승인한 것의 읽기 전용 사본이고, 사용자의 스킬·설정 폴더에는 쓰지 않는다(호스트 OWN_HOME의 `creator/`).
- **MCP**: 자동으로 동기화하지 않는다(로컬 MCP 설정에는 Windows 경로·명령이 많다). 대신 사용자가 서버마다 고르는 **`SSH 호스트에 설치`**가 있다(13.1, MH 2026-11-26). 예전의 R3 항목 "호스트 설정에서 원격 전용 MCP를 따로 추가"는 이것으로 닫는다.
### 13.1 MCP 서버를 호스트에 설치 (MH, 2026-11-26)

사용자 요청: "이 PC에서 더하거나 가져온 MCP 서버가 SSH 호스트 대화에는 없다. 서버에도 설치해 달라. 다 자동으로 안 되면 AI가 설치를 돕게." 화면은 03 §18.14 `SSH 호스트에서 쓰기`, 설명서 10.15·22.

- **무엇을 보나(분석).** 이 PC가 아는 모든 MCP 서버(own이 더하거나 가져온 것, 페이지 프로젝트의 설정 파일 서버, 꺼 둔 것도)를 호스트마다 판정한다(own-protocol `McpHostRules.analyze`, 순수 함수): 종류(원격 주소·명령), 명령이 필요로 하는 런타임(npx/node, uvx/uv, python, pipx, docker/podman, bun, deno, PATH의 프로그램, Windows 프로그램·스크립트), 패키지(npm·PyPI·OCI·jsr와 판), `cmd /c` 벗기기, 이 PC의 경로인 인자(홈 안은 `~/…`, 페이지 프로젝트 안은 상대 경로, 그 밖과 이 PC의 `localhost` 주소는 "호스트 값 필요"), 값(이름과 비밀 같은지만). 결과는 `바로 설치 가능`(`ready`), `호스트 준비 필요`(`prepare`: 런타임이 없음, docker를 sudo 없이 못 씀), `AI 도움 필요`(`assist`: 이 PC의 스크립트·uv 프로젝트·python 모듈, PATH에 없는 프로그램, 호스트 값이 필요한 인자), `이 PC 전용`(`pc-only`: Windows 프로그램·셸, Windows나 이 PC 화면을 다루는 서버, `localhost` 주소)과 이유 목록이다. 호스트를 아직 못 보면 `확인 필요`. uv만 있고 uvx가 PATH에 없는 호스트(build-host의 uv 0.12)는 `uv tool run`으로 바꾼다. bun이 없는 호스트는 own 서비스 프로그램을 bun으로 쓴다(`BUN_BE_BUN=1`).
- **호스트 확인(probe).** 호스트 서비스의 own.accounts `mcp.host.probe`가 **서비스 자신의 env**(MCP 서버가 뜨는 env)에서 읽는다: OS·아키텍처·홈, 런타임마다 `--version` 첫 줄, `docker info`/`podman info`가 sudo 없이 되는지, 물어본 프로그램이 PATH에 있는지, 서비스 프로그램이 bun으로 도는지. 읽기만 하고 sudo는 없다. 30초 캐시.
- **호스트의 목록.** 호스트의 own.accounts가 자기 `<OWN_HOME>/mcp.json`(PC와 같은 꼴, 모두 `global`, 서버마다 `pc:{key, hash, at}`)을 갖고 PC와 같은 접기(`McpServers.register`, `mcp.transform`)로 모든 Location에 넣는다. 저장은 `mcp.host.save`(번역된 정의, 값 없음, `~/…`는 호스트 홈의 절대 경로로), 지우기 `mcp.host.remove`, 연결 시험 `mcp.host.test`(호스트에서 띄움), 미리 받기 `mcp.host.prefetch`(npx 패키지는 `npm exec --yes --package=<pkg> -- true`로 npm 캐시에, uvx는 `uv tool install`로 사용자 공간에, 5분, 그 밖은 하지 않음). 보기는 `mcp.host.view`(그 파일의 경로 `file`도, MHC). 이 PC 서비스는 `mcp.host.*`에 `mcp_host_only`로 답한다. 호스트 대화가 쓰는 MCP 서버(Code Mode 목록 포함)는 이 파일에서 오고, 호스트의 OpenCode 설정 폴더(`~/.config/opencode` 등)의 설정 파일에는 없다. 그래서 호스트 카드가 `<host>에 설치한 MCP 서버는 own이 이 파일에 등록해요(OpenCode 설정 파일이 아니에요): <경로>`로 그 파일을 알린다(2.4.1-own.5에서 호스트의 AI가 `~/.config/opencode`만 보고 어디에 등록됐는지 찾지 못했다).
- **열린 대화와 새 대화(MHC 확인).** 저장·지우기·시험·값 보내기와 거두기 뒤 호스트의 모든 Location이 목록을 다시 읽고 바뀌었으면 core가 다시 접는다(`ctx.mcp.reload()`): 같은 프로세스의 runtime broadcast `mcp.changed`와 PC 브로커의 `mcp.changed` push 두 길이다. 그래서 설치 뒤 새 대화는 곧바로 그 서버의 도구를 받고, 열린 대화도 다음 요청부터 받는다. 서비스를 다시 시작할 필요는 없다(가짜 SSH e2e가 둘 다 끈 채로는 실패함을 확인했다).
- **연결 시험은 호스트가 띄우는 것 그대로(MHC, 2026-11-28).** `mcp.host.test`는 접기가 core에 주는 그 config(`McpFold.config`: 명령, 인자, 환경, 주소, 헤더)로 띄운다: PC가 보낸 값 가운데 호스트가 기다리는 이름만, 호스트에서 정한 값(`fixed`). 다른 점은 작업 폴더뿐이다(core는 대화 폴더, 시험은 호스트 사용자의 홈). 호스트가 PC에서 받을 값을 아직 못 받았으면 접기가 서버를 끄므로 시험도 띄우지 않고 `mcp_secret_missing{name}`으로 답하며 전에 남은 결과를 지운다. 2.4.1-own.5까지는 값 없이 그냥 띄웠다: 값이 없어도 뜨는 서버(`llm-router`, 상태 폴더에 기본값이 있음)는 `연결됐어요 · 도구 12개`를 남겼는데 정작 호스트에서는 꺼져 있었다(사용자 보고). `fixed`의 값에 있는 `~/…`도 저장할 때 호스트 홈의 절대 경로가 된다.
- **값(비밀).** 호스트 디스크에는 값을 쓰지 않는다. 사용자가 서버마다 `이 키를 <host>에 보내기`를 누를 때만(기본은 보내지 않음) PC가 그 값의 사본을 PC vault(`mcp-send-<id>`)에 두고 기록을 `OWN_HOME\mcp-hosts.json`(호스트·서버 id와 값 이름만)에 남긴다(`mcp.hosts.send`). 호스트의 서버는 브로커 `mcp.values`(8.4, 정상 모드만)로 자기 값만 받아 **서비스 메모리에만** 두고, 받기 전에는 꺼져 있다(PC의 값 없는 서버와 같은 규칙). `mcp.hosts.unsend`는 사본을 지우고 `mcp.changed` push로 호스트가 값을 버려 서버가 꺼진다. GitHub 호스트(16 §8)와 같은 틀이다: 허락은 PC에, 호스트는 PC에 묻는다. 다른 점은 MCP 서버 프로세스가 호스트에서 돌아 값을 env로 받는다는 것이다(그 서버가 도는 동안 같은 사용자와 root는 읽을 수 있다. 보내기 버튼 옆에 적는다).
- **같이 가기.** PC에서 정의를 고치거나 지워도 호스트는 그대로다. 행은 `PC와 다름`(정의 해시가 다름, 또는 own 서버의 값이 보낸 사본과 다름 `differs`)이나 `PC에 없음`을 보이고, `업데이트` 한 번이 정의를 다시 쓰고 전에 보낸 값을 다시 보낸다.
- **AI에게 설치 맡기기.** 확인 창이 첫 메시지를 보여 주고, `모델 고르고 시작…`을 누르면 창이 닫히고 그 호스트의 새 대화 화면으로 가서(전환기는 대화 창에 있어 설정 화면에서는 보이지 않는다) 그 화면의 `모델 @ 계정` 단추 곁에 그 대화의 "모델 @ 계정"을 고르는 전환기가 열린다(MHC, 2026-11-28: 예전에는 바로 지난 대화의 모델·계정으로 시작했다). 전환기는 고르기 모드(`openSwitcherToPick`, 팀 없이)로 그 호스트의 새 대화와 같은 규칙을 쓴다: 그 호스트에서 쓸 수 있는 계정만(호스트의 계정 범위 밖은 목록에 없음), Claude 구독이 그 호스트에서 꺼져 있으면 모델 칸에 그 이유와 고칠 곳, 쓸 수 없는 계정은 `고치기`. 그 호스트의 다음 새 대화 모델(지난번 것)이 골라져 있어 `이 모델로 시작`(Enter) 한 번이면 된다. 적용하면 그 호스트의 새 대화 모델로 정하고(새 대화 화면의 전환기와 같음, Claude 계정이면 그 계정을 기본으로) 그때서야 입력창이 설명을 받아 새 대화를 연다(그 호스트의 새 대화 폴더). 닫으면(Esc, 바깥 누름) 아무것도 시작하지 않고 빈 새 대화 화면에 남는다. 첫 메시지는 혼자 읽히는 설명(`McpHostRules.brief`: 값을 가린 정의, 분석, 호스트 확인 결과, 할 일, 하지 말 것)이고, 대화는 `metadata.own.mcpInstall`(PC 키·해시·이름·값 이름, 비밀 값 이름 `secrets`)과 규칙 `{own_mcp_install, *, allow}`로 만든다. 호스트의 모든 에이전트는 `{own_mcp_install, *, deny}`를 지녀 다른 대화의 도구 목록에는 없다(캐시 그대로). AI는 사용자 공간에 설치한 뒤 `own_mcp_install {command, args, cwd?, fixed?}`로 등록한다. 도구가 그 일의 이름·값 이름으로 호스트 목록에 쓰고 연결 시험을 돌려 결과를 돌려준다. 쓰기는 승인 모드를 따른다(`묻기` 물음, `읽기 전용` 거절).
- **호스트에서 정하는 값(MHC).** 비밀이 아닌 값(상태·캐시 폴더, 모드 등: `McpHostRules`가 비밀로 보지 않는 이름)은 AI가 `fixed`에 이 호스트에 맞는 값으로 넣을 수 있다. 그러면 그 이름은 호스트 목록의 `env`(PC에서 받을 값)에서 빠지고 `fixed`에 남아, 서버가 PC의 사본(대개 이 PC의 경로라 호스트에서 맞지 않음)을 기다리지 않는다. 비밀 값(이름이 비밀처럼 보이거나 PC의 분석이 비밀로 본 `secrets`)은 `fixed`에 넣을 수 없고(도구가 거절) PC에서 `이 키를 보내기`로만 간다. 설명서는 값마다 `(비밀)`과 `(비밀 아님: 이 호스트에 맞게 정해도 됨)`을 적는다. PC의 `업데이트`는 호스트가 정한 값을 그대로 둔다.
- **호스트 카드의 한 상태(MHC).** 설치된 서버의 줄은 이 PC의 분석이 아니라 호스트의 정의와 마지막 시험에서 한 상태를 낸다(own-web `hosts-model` `live`): 호스트가 PC에서 받을 값을 기다리면 `값을 보내기 전에는 호스트에서 꺼져 있어요: <이름>`만(시험 결과와 `호스트에서 연결 시험`은 숨김), 아니면 마지막 시험의 `연결됐어요 · 도구 N개`나 `연결 시험 실패: …`, 시험 전이면 `아직 호스트에서 연결 시험을 하지 않았어요.` `▾ 자세히`는 `호스트에서 실행`(호스트의 명령 줄)과 `이 PC의 정의`를 따로 보이고, 이유 목록에서 이 PC의 정의에 대한 것(이 PC의 경로·스크립트·런타임·값)은 뺀다(원격 주소·로그인만 남김). 값은 어디서 오는지 보인다: 호스트에서 정한 값은 `호스트에서 정함`과 그 값, PC에서 받을 값만 체크와 `이 키를 <host>에 보내기`. 기다리는 값이 모두 비밀이 아니면 `AI에게 설치 맡기기`가 다시 나와 호스트에 맞게 정하게 한다(PC의 경로를 보내지 않게). AI가 설치한 서버의 PC 정의가 바뀌어 `PC와 다름`이면 `업데이트`(PC 정의의 번역)로 호스트의 명령을 덮지 않고 `AI에게 설치 맡기기`를 낸다(정의가 그대로 바로 설치되는 서버만 `업데이트`).
- **범위.** 보기(`mcp.host.view`, `mcp.hosts.view`)는 `read`, 나머지(probe, save, remove, test, prefetch, send, unsend)는 `local`이다. 휴대폰·다른 PC는 호스트에 설치된 서버만 본다. MCP 변경이 원래 `local`이라 넓히지 않았다.
- **옛 호스트.** 다른 빌드의 호스트(`versions.skew`, `incompatible`, drain)나 `mcp.host.*`를 모르는 서비스(`rpc.method_not_found`)는 `호스트 최신 아님`이고 업데이트하라고 한다. `mcp.values`는 정상 모드에서만 쓰여 `PROTO`와 `MIRROR_SCHEMA_VERSION`은 그대로다.

- **권한·agent 설정**: 로컬 값을 옮기지 않는다. 원격 managed config의 기본값(5.6)만 쓴다. 필요하면 사용자가 원격 config에 직접 적는다(보존됨).
- **프로젝트 플러그인**: 원격 호스트는 복제한 저장소와 남의 저장소가 가장 많은 곳이다. 원격 프로젝트의 `.opencode/plugins`는 own-accounts **보다 먼저**, 원격 service 프로세스 안에서 로드된다(01 §13.2). 그 코드는 runtime 싱글턴을 통해 브로커에 헤더를 요청하거나 메모리의 lease를 읽을 수 있고, 그러면 API 키(교체 전까지 유효)와 ChatGPT access token이 나간다. allowlist 게이트(8.6 2번)는 우리가 헤더를 넣는 것만 막으므로 이것을 막지 못한다.
  - 그래서 **호스트 설정 `projectConfig`는 `trusted`가 아니면 프로젝트 config를 읽지 않는다.** 원격 service env에 `OPENCODE_CONFIG_PROJECT_DISABLE=1`을 넣어 프로젝트 쪽 설정·플러그인·MCP·에이전트·명령·스킬을 아예 읽지 않는다(5.6). 01 §13.2가 믿을 수 없는 저장소에 권하는 `--untrusted`의 원격판이다. 새 호스트의 기본값 `instructions`는 여기에 저장소의 `AGENTS.md`만 더 읽고(글만 읽고 코드는 싣지 않는다), `disabled`는 그것도 읽지 않는다(5.6의 표, HPC 2026-11-20).
  - 사용자가 그 호스트를 `"trusted"`로 바꾸면 프로젝트 설정을 읽고, 원격 own-accounts가 원격 `trust.json`으로 allowlist를 검사한다. 승인 전에는 그 Location에서 브로커 헤더를 넣지 않는다(8.6 2번). 승인 UI는 서버 선택이 붙은 03 §5.7.1이다. 이 설정은 호스트 상태 패널에 보이고(17.5), 바꾸면 재시작이 필요하다.
  - 대가: `trusted`가 아니면 원격 프로젝트의 `.opencode/agents`, 명령, 프로젝트 스킬, 프로젝트 MCP가 보이지 않는다. `disabled`에서는 저장소의 `AGENTS.md`도 모델 요청에 들어가지 않는다. 호스트 추가 흐름의 확인 카드와 호스트 설정이 세 상태가 각각 무엇을 읽는지 적고 [바꾸기…]를 둔다(17.3, 17.5).

---

## 14. Windows 클라이언트

### 14.1 ssh 실행 파일

- **`C:\Windows\System32\OpenSSH\ssh.exe`를 절대 경로로 고정한다.** 이 PC에서 `OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2`이고 PowerShell PATH의 첫 `ssh`다(2026-09-27 확인). upstream은 PATH에서 `ssh.exe`를 찾는다(`command.ts:113`).
- Git Bash의 MSYS `ssh`는 HOME, agent, 다중화 동작이 다르다. PATH 순서에 따라 이것이 잡히지 않게 고정한다.
- 없거나 8.4 미만(`SSH_ASKPASS_REQUIRE` 미지원)이면 `ssh_missing`과 설치 안내(선택적 기능 "OpenSSH Client")를 보인다. 설치는 사용자가 한다.
- 설정 > 원격 호스트에 경로 재정의 칸을 둔다(고급).

### 14.2 askpass

- ssh를 `SSH_ASKPASS=<helper>`, `SSH_ASKPASS_REQUIRE=force`, `DISPLAY`(없으면 `opencode`), `OPENCODE_SSH_ASKPASS_PORT`, `OPENCODE_SSH_ASKPASS_TOKEN`으로 띄운다(upstream `askpass.ts:68-74`).
- **helper = 설치된 버전의 `%LOCALAPPDATA%\own-open-code\app\<version>\opencode.exe`**(`app\current.json`, junction 없음). env에 포트가 있으면 askpass 모드로 돈다(`packages/cli/src/index.ts:19-22`, `packages/cli/src/ssh-askpass.ts:9-40`). inbox Win32-OpenSSH는 `SSH_ASKPASS`를 직접 실행하므로 셸 스크립트 wrapper를 쓸 수 없고 실제 exe여야 한다(upstream `controller.ts:82-89`).
  - 개발 모드(채널 `local`, 소스 실행)에서는 upstream처럼 `bun`으로 떨어지면 askpass가 깨진다(`packages/desktop/src/main/service/desktop-cli.ts:52-64`). 개발 때도 빌드된 exe를 helper로 지정한다.
- askpass 서버(로컬 TCP)는 `127.0.0.1:0`, UUID 토큰, 요청 한 줄 16 KiB 상한, 프롬프트 직렬화, 요청당 5분 timeout(`askpass.ts:15-59`). 응답 값은 로그와 이벤트에 남기지 않는다(`askpass.ts:60-62`).
- **프롬프트 분류.** 호스트 키 확인은 askpass의 `confirm`이 아니다. OpenSSH는 `SSH_ASKPASS_PROMPT=confirm`을 권한 확인 프롬프트(agent 키 사용 확인, FIDO 터치 등)에만 붙이고, 첫 연결의 호스트 키 질문("The authenticity of host … can't be established … (yes/no/[fingerprint])?")은 일반 입력으로 묻는다. 그래서 CLI askpass는 이것을 `confirm:false`로 보내고(`packages/cli/src/ssh-askpass.ts:26`), upstream 대화상자는 `confirm`일 때만 `yes`를 보내고 아니면 텍스트 칸을 보인다(`packages/app/src/servers/ssh/dialog.tsx:80-83`). 그대로 두면 중간자 여부를 판단할 질문이 가려진 비밀번호 칸으로 나온다. own-remote는 프롬프트 문구로 분류한다.
  - `hostKey`: 문구에 `authenticity of host`, `(yes/no/[fingerprint])`, `fingerprint is SHA256:` 중 하나가 있음. 지문(`SHA256:…`)과 키 종류를 뽑아 `host.prompt`에 싣는다.
  - `confirm`: `SSH_ASKPASS_PROMPT=confirm`(askpass 요청의 `confirm:true`).
  - `passphrase`: `Enter passphrase for key`. `password`: `password:`로 끝남. 그 밖은 `other`(키보드 대화형 OTP 등).
- UI: `password`·`passphrase`·`other`는 비밀 입력칸(`other`는 보이기 토글). `hostKey`는 **가리지 않은** 원문과 지문을 보이고 `신뢰하고 연결` / `취소` 버튼만 둔다. 입력칸이 없고 **기본 포커스는 취소**다. `신뢰하고 연결`을 눌렀을 때만 own-remote가 `yes`를 보낸다. `respond`로 들어온 임의 문자열은 `hostKey` 프롬프트의 답으로 쓰지 않는다. `confirm`도 같은 두 버튼이다(upstream `dialog.tsx:80-91,175-253`의 포커스 규칙).
- `hostKey` 프롬프트는 `connect{hostKeyPrompt:true}`(호스트 추가, `호스트 키 확인…`)에서만 나온다. 다른 연결은 `StrictHostKeyChecking=yes`라 이 질문 없이 `host_key`(`unknown`)로 멈춘다(6.3).
- 호스트 키가 바뀌었다(`REMOTE HOST IDENTIFICATION HAS CHANGED`)는 오류는 `host_key`(`changed`)로 pause하고, 우리가 `known_hosts`를 고치지 않는다. 사용자가 확인하고 직접 고치도록 경로와 명령을 보여 준다.

### 14.3 키와 agent

- 이 PC의 `ssh-agent` 서비스는 **Stopped, StartupType Disabled**다(2026-09-27 확인). 키 파일에 암호문구가 있으면 SSH 명령마다(첫 연결 최대 3회, 재연결 1회) 프롬프트가 뜬다.
- **lab, work_linux, build-host는 프롬프트 없이 붙을 것으로 본다(간접 확인).** 이전 앱은 모든 SSH 명령을 `BatchMode=yes`, `StrictHostKeyChecking=yes`로 돌렸고([old] `scripts/manager_core/remote.py:175-177`), agent가 꺼진 이 PC에서 세 호스트를 운영했다. 그러니 세 호스트의 키는 대화형 입력 없이 쓰이고, 호스트 키도 이미 `known_hosts`에 있다. 첫 연결에 호스트 키 질문도 없어야 한다. `aws_02`, `aws_03`, `il_01`은 이전 앱이 준비한 적이 없어 모른다 ⚠(RG5). 키 파일은 읽지 않았다.
- 권장(사용자가 직접): 관리자 PowerShell에서 ssh-agent를 자동 시작으로 바꾸고 `ssh-add`로 키를 올린다. 서비스 설정 변경은 시스템 설정이므로 own이 하지 않고 안내만 한다. own의 ssh는 agent를 원격으로 전달하지 않으므로(`ForwardAgent=no`, 7.2) agent를 켜도 원격 호스트가 그 키를 쓸 수 없다.
- Windows ssh-agent는 named pipe를 쓰므로 `SSH_AUTH_SOCK`을 넘길 필요가 없다 ⚠(RG5에서 확인).
- `IdentitiesOnly`, `IdentityFile`은 사용자 config를 따른다. own은 키를 만들거나 복사하지 않는다.

### 14.4 env와 경로

- ssh 자식 프로세스는 `extendEnv:false`로 최소 env만 준다: `SystemRoot`, `ProgramData`, `PATH`(System32 포함), `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `TEMP`, `TMP`, askpass 변수. 로컬 service env(`OPENCODE_*` 등)를 원격에 흘리지 않고, 사용자 config의 `SendEnv`가 가져갈 것을 줄인다.
  - `ProgramData`는 빼면 안 된다. Win32-OpenSSH 9.5는 이것으로 `__PROGRAMDATA__\ssh`(전역 ssh_config·known_hosts)를 풀고, 없으면 아무것도 출력하지 않고 255로 끝난다(`ssh -G`도 같다). 가짜 ssh 하네스로는 드러나지 않았고 첫 실제 호스트(2026-09-28)에서 확인했다.
- `known_hosts`, `config`는 `%USERPROFILE%\.ssh\` 기본값을 쓴다. 우리 전용 `UserKnownHostsFile`을 두지 않는다(사용자의 신뢰 기록을 하나로 유지).
- 원격에 보내는 스크립트는 LF로 만든다(CRLF가 섞이면 `sh`가 `$'\r'` 오류를 낸다).
- 사용자 이름에 한글이 있으면 `%USERPROFILE%` 경로의 config·키 처리에 문제가 있는지 ⚠. 이 PC의 사용자 경로는 ASCII다.
- Windows 방화벽: 모든 리스너가 loopback이므로 방화벽 프롬프트가 없어야 한다 ⚠(RG5).
- 절전·재개: 깨어나면 컨트롤러가 시계 틈으로 알고 터널마다 바로 묻는다(4초). 답이 없으면 끊고 배경 재연결한다. 그렇지 않아도 터널의 ServerAlive가 12초 안에 끊김을 안다(6.3 "죽은 링크"). 암호문구 프롬프트가 필요하면 pause한다(6.3).

---

## 15. 보안

**전제**(01 §13과 같음): 같은 사용자 권한의 코드는 결국 그 사용자의 비밀에 닿을 수 있다. 원격에서도 원격 OS 사용자와 원격 root는 lease를 볼 수 있다. 목표는 01 §13의 여섯 가지에 다음 셋을 더하는 것이다.
- (7) refresh token, vault 원문, linked 원본 파일은 원격에 가지 않는다. 원격 사용이 어떤 토큰 계열의 refresh도 일으키지 않는다(linked는 로컬에서도 refresh 없음, 8.5). Claude 구독 슬롯은 원격에 토큰이 가지 않는다. 원격 요청도 PC의 claude-auth 경로로만 refresh를 일으킬 수 있고, 중계는 401 회복을 PC 전역 single-flight와 호스트별 60초 보류로 묶는다(8.11.6).
- (8) 원격 노출은 lease 기간과 허용 계정으로 묶인다.
- (9) 원격이 로컬 Windows로 역으로 들어오는 통로가 없다(좁은 브로커 프로토콜만). 브라우저를 거치는 통로(로컬 세션 쿠키, 로컬 CORS)도 여기에 든다.

| 위협 | 완화 | 남는 위험 |
|---|---|---|
| 원격 호스트 장악(root, 같은 uid 악성 코드) | refresh token 없음, lease(기본 15분)만 메모리에, 곧 만료될 토큰은 보내지 않음(8.5), 계정별 `remote:"deny"`, 호스트별 계정 범위, 속도 제한, 감사 합계, 호스트 제거 시 키 교체 안내 | lease 동안 access token·API 키 사용 가능. API 키는 교체 전까지 유효. **ChatGPT access token은 Codex 사용보다 범위가 넓다**(그 ChatGPT 계정의 다른 백엔드 API에도 쓰일 수 있음). 믿기 어려운 호스트에는 구독 계정도 `deny`로 둔다 |
| **원격이 만든 내용이 로컬 own-web 세션을 훔침**(원격 dev 서버 = 믿을 수 없는 프로젝트 코드, 장악된 원격 service, RP를 가로챈 원격 프로세스) | 원격 API 터널과 dev forward를 `127.0.0.1`·`localhost`가 아닌 호스트별 loopback 주소(`127.0.<k>.2`, `127.0.<k>.3`)에 둠(7.3, 7.6). 그 origin의 페이지는 로컬 CORS가 거절(`cors.ts:13-14`, 4.4). `127.0.<k>.x`에 bind할 수 없으면 fail closed(`loopback_unavailable`). RG16.<br>- 웹 폴백: 로컬 pairing 쿠키는 호스트 `127.0.0.1`로만 가므로 PTY WebSocket 업그레이드와 dev 서버 탐색에 실리지 않음. dev forward는 own-web 브라우저 프로필 밖에서 염.<br>- 데스크톱: 렌더러는 쿠키가 없고, main은 로컬 서비스 origin에만 Basic을 넣음(4.4). dev forward는 `openExternal`로 시스템 브라우저에서, 원격 dev 서버는 원격 세션의 브라우저 패인(메모리 전용 partition, 렌더러 인증 없음)에서 봄(7.6) | 웹 폴백: 사용자가 직접 만든 `127.0.0.1` forward(예: `lab-7676`, 19.1)를 own-web과 같은 브라우저 프로필에서 열면 이 방어 밖이다. 데스크톱: upstream main의 주입 조건이 바뀌면 로컬 비밀번호가 원격으로 갈 수 있어 check-surface로 감시(4.4) |
| 원격의 다른 OS 사용자 | 원격 service는 Basic 비밀번호(등록 파일 0600), 브로커 소켓 0600 + 0700 디렉터리 + HMAC, TCP 대체도 HMAC, 브로커 키는 디스크·argv·env에 없음(arm으로 메모리에만, 8.3) | 원격 root |
| 에이전트 자신(원격 셸 도구)이 브로커 키를 얻어 헤더 요청 | 키가 파일에 없음(8.3), managed config의 fs deny(5.6), 속도 제한 | 같은 uid로 `/proc/<pid>/mem`을 읽을 수 있는 환경(ptrace 제한 없음)이면 service 메모리에서 lease를 읽을 수 있음 |
| 원격 셸 도구가 service에 `SIGUSR1`을 보내 힙 스냅샷을 쓰게 함(SEC-1). upstream `Heap.listen`(`packages/cli/src/heap.ts`)은 Windows가 아니면 이 신호를 받을 때 V8 힙 스냅샷을 로그 폴더에 쓴다. 그 파일에 arm된 브로커 키와 lease가 들어갈 수 있다 | own-remote agent 모드가 setup에서 `SIGUSR1` 리스너를 모두 지우고 빈 리스너 하나를 둔다. 리스너가 하나도 없으면 이 신호가 프로세스를 끝내기 때문이다. Location마다 setup이 다시 돌아도 리스너는 하나다. 디버그용 탈출구는 service env `OWN_REMOTE_ALLOW_HEAP_SIGNAL=1`이다. G14 원격 단계(아래)로 확인 | CLI 시작부터 첫 Location이 플러그인을 로드할 때까지는 upstream 핸들러가 남는다. 이때는 arm 전이라 브로커 키와 lease가 메모리에 없다. `/proc/<pid>/mem` 경로는 윗 행과 같다 |
| 원격 셸이 사용자의 ssh-agent나 X 서버를 씀(사용자 config의 `ForwardAgent yes`, SEC-2) | 모든 ssh 명령에 `-o ForwardAgent=no -o ForwardX11=no`(7.2). 명령행 값이 config 값보다 앞선다 | target 줄에 직접 적은 `-A`는 그 호스트의 켜기로 남는다(사용자가 고른 것) |
| 원격 프로젝트 플러그인(원격 service 안에서 own-accounts보다 먼저 로드)이 runtime을 통해 헤더를 요청하거나 lease Map을 읽음 | **원격 프로젝트 config는 `trusted`가 아니면 끔**(`OPENCODE_CONFIG_PROJECT_DISABLE=1`, 5.6, 13장. 새 호스트의 기본 `instructions`는 `AGENTS.md`만 더 읽고 저장소의 코드는 싣지 않는다). 사용자가 `trusted`로 바꾼 호스트에만 allowlist 게이트(8.6 2번). RG17 | allowlist 게이트는 우리 주입만 막는다. 같은 프로세스 코드의 브로커 호출과 메모리 읽기는 막지 못한다(01 §13 전제). `trusted` 호스트는 그 저장소들을 믿는다는 뜻이다 |
| 중간자, DNS·IP 재지정 | 사용자 `known_hosts`, 처음 보는 키는 호스트 추가·`호스트 키 확인…`에서만 신뢰(지문을 가리지 않고 보임, 입력칸 없음, 취소 기본), 배경·재연결은 `StrictHostKeyChecking=yes`(6.3, 14.2), `StrictHostKeyChecking no`·`UserKnownHostsFile /dev/null` 호스트는 경고 + 브로커 계정 기본 없음(7.2), host identity 비교(alias가 다른 기계를 가리키면 `host_identity_changed`로 pause, 재온보딩) | 사용자가 지문을 확인하지 않고 신뢰 |
| UI 입력으로 로컬 명령 실행·로컬 자격 증명 유출 | target 파서에서 `-F`, `proxycommand`, `identityagent` 제거. `-i`·`identityfile`은 `%USERPROFILE%\.ssh` 아래 로컬 경로만(UNC·장치 경로·`%`·`$` 거부, SMB 인증으로 NTLM 해시가 새는 것 방지). 개행·NUL 거부, 원격 명령 인자 거부(7.2). 파서 테스트(20.1) | `~/.ssh/config`의 ProxyCommand·`Match exec`는 사용자 소유라 허용 |
| 원격 → 로컬 권한 상승 | 로컬 HTTP API를 `-R`로 열지 않음. 브로커는 헤더 발급·관측 수신·미러 조회만. egress 중계(8.11)는 `POST /v1/messages` 하나를 고정 origin으로만 보내고, 요청마다 MAC·카운터, 속도·동시성·크기 상한, 호스트별 스위치, 감사가 있음. 관측은 검증 규칙(10.5) | 거짓 관측으로 표시 교란(자동 전환에는 영향 없음). 같은 uid가 service 메모리를 읽으면 터널이 살아 있는 동안 상한 안에서 구독을 쓸 수 있음(토큰은 얻지 못함) |
| 원격이 로컬의 linked 계정·이전 앱을 망가뜨림(거짓 401 반복) | linked 계정은 원격 요청 때문에 refresh하지 않음(token endpoint 호출 0), 원본 파일에 쓰지 않음. 원격 `invalidate`는 로컬 reader를 거절 상태로 만들지 않고 그 호스트만 `source_stale`로 막음. 호스트·계정마다 5분에 한 번(8.5, 8.8). RG7 | 그 호스트의 원격 세션은 이전 앱이 원본을 갱신할 때까지 그 계정을 못 씀 |
| 휴대폰(M1+)을 거친 원격 조작 | 게이트웨이 범위(05 §13.5)와 16.7의 `own.remote` 범위, `agent.*`와 `resolve` 차단, 원격 토큰은 게이트웨이가 넣음(12.7) | 기기 범위 안에서는 원격 세션도 조작 가능(05 §13.8) |
| 로컬의 다른 프로세스가 브로커 포트에 연결 | epoch 키 HMAC, 호스트별 리스너, 실패 속도 제한, 첫 프레임이 `hello`가 아니면 즉시 닫고 기록하지 않음 | 로컬 같은 사용자 코드(01 §13 전제) |
| 클라이언트 쪽 토큰 노출(렌더러·웹 폴백 탭·셸 main) | 원격 비밀번호를 주지 않고 짧은 세션 토큰(기본 12시간)만, 렌더러(탭) 메모리에만. 셸 main은 원격 세션 브라우저 패인의 attachment 수명 동안만 메모리에 둠(7.6). 원격 서버의 CORS가 own-web origin(데스크톱 `oc://renderer`, 웹 폴백 `http://127.0.0.1:P`)을 허용해서 쓰는 것이지, 원격 서버가 loopback만 허용하는 것은 아니다. upstream 기본 CORS는 `http://127.0.0.1:*`, `http://localhost:*`, `oc://renderer` 말고도 tauri origin, `https://*.opencode.ai`를 허용한다(`cors.ts:11-20`). 토큰 없이는 그 origin들도 원격 API를 쓸 수 없다. 휴대폰(M1+)은 토큰을 받지 않는다(12.7) | own-web XSS(로컬 접근 권한과 같은 등급). 원격 transcript의 내용(모델 출력, 도구 결과)은 로컬 세션과 같은 규칙으로 정화해 그린다 |
| 세션 토큰 유출 | 토큰 수명이 짧음(기본 12시간, 12.1). 원격 비밀번호를 바꾸면 모든 토큰이 무효(`auth.ts:39-40`). 호스트 메뉴 `원격 접근 토큰 모두 무효화` = drain → 서비스 설정의 password 교체 → 재시작 | 교체 전까지 최대 토큰 수명(pairing 대체 경로로 받은 토큰이면 30일) |
| 공급망 | 로컬 릴리스 번들만 업로드, manifest sha256 검증, 원격 다운로드 없음 | 원격에 해시 도구가 없으면 크기·버전만 확인 |
| 로그·오류 문구 누수 | 등록 블록 제거(`command.ts:208-215`), stderr tail 상한(`command.ts:182-205`: stdout 1 MiB, stderr 16 KiB), askpass 값 미기록, inspect 출력 허용 목록, 로그는 `authHash8`만 | – |
| env 누수 | 원격 기동 스크립트(`start.sh`)가 로그인 셸이 만든 env에서 provider 키를 지움, 로컬 ssh 최소 env, 비밀을 env로 넘기지 않음 | 사용자가 원격 셸에서 직접 export한 값은 셸 도구가 볼 수 있음 |
| DoS·연쇄 실패 | 호스트별 fiber·리스너, 전역 락 없음, 백오프·pause, spool 상한 | – |
| 오래 남은 상태 파일 비대 | 연결별 기록을 상태 파일에 쌓지 않음(ops 저널 1 MiB 순환, 감사는 5분 합계) | – |

- **G14 비밀 위생 확장**(01 §16.1): 원격 DB, 원격 KV, 원격 로그(RPC 본문의 arm 키 포함), 미러, spool, 원격 OWN_HOME 전체 파일, `ps -ef`, `/proc/<service pid>/environ`, 원격 셸 도구의 `env` 출력, 로컬 `hosts.json`·catalog·ops 저널에서 키 패턴과 브로커 키를 스캔한다. 원격 service에 `kill -USR1`을 보낸 뒤 원격 로그 폴더(`<XDG_DATA_HOME>/opencode/log`)에 새 `*.heapsnapshot`이 없고 service가 살아 있는지 본다(SEC-1). 이 단계는 opt-in 시험 `packages/own-remote/test/unit/heap-signal.test.ts`(`OWN_REAL_HOST=dev-host`)에 있다. 릴리스의 Linux CLI와 이 트리의 own-remote 묶음을 `/tmp/own-<uid>/heap-signal`에 올려 agent 모드로 `serve`를 두 번 돌린다. 기본은 스냅샷 0이고, `OWN_REMOTE_ALLOW_HEAP_SIGNAL=1`이면 스냅샷이 생긴다(시험이 실제로 신호를 보냈다는 대조군). 2026-10-05 `dev-host`(릴리스 `2.0.18-own.6`의 Linux CLI, Bun 1.4.2): 기본은 `agent.status` 200, 스냅샷 0, service 생존이었고, 탈출구는 스냅샷 1이었다. 끝난 뒤 `/tmp/own-*`와 남은 프로세스는 0이었다. 데스크톱이면 셸 userData(브라우저 패인 탭 복원 기록, 05 §8.2)·electron-log·렌더러 저장소(localStorage, IndexedDB)에 원격 세션 토큰이 없는지도 본다(RG10).
- **정직한 한계**: 브로커 방식은 "원격 호스트와 그 호스트에서 여는 저장소를 믿는다"를 전제로 한다. 믿을 수 없는 호스트에는 API 키 계정을 `deny`로 두거나, 그 호스트를 쓰지 않는다. 믿을 수 없는 저장소는 `projectConfig:"disabled"`(기본)인 호스트에서만 연다. 비밀이 절대 떠나면 안 되는 경우의 해법은 8.1의 안 C다. Claude 구독 슬롯은 이미 이 방식이다(8.11).

---

## 16. RPC

### 16.1 결정: 새 RPC id `own.remote`

- **선택지**: (a) `own.accounts`에 `remote.*` 메서드 추가, (b) 새 플러그인 `own.remote`가 새 id `own.remote`를 등록.
- **(b)를 택한 이유**
  - RPC id는 등록자가 하나다(마지막 등록만 응답, `packages/core/src/rpc.ts:108-112`). 02 §9.1은 `own.accounts`를 own-accounts만 등록하게 정했다. SSH 컨트롤러를 own-accounts에 넣지 않는 한 같은 id를 쓸 수 없다.
  - SSH 컨트롤러는 로컬에만 있어야 한다. own-accounts 번들은 원격에도 가므로, 컨트롤러가 거기 있으면 원격에도 실린다.
  - 실패 범위: SSH·설치·동기화 버그가 인증 주입과 전환에 번지지 않게 한다. 가드 1이 실패해도 own-remote는 `diagnostics`만 남기고 조용히 빠진다.
  - 이벤트 양: 설치 진행, 프롬프트, 연결 상태 이벤트가 `rpc.own.accounts.*`에 섞이지 않는다.
  - 순서: own-remote를 2번 자리에 두어 슬롯 설치 때 재시작을 피한다(4.1). 이것도 별도 플러그인이어야 가능하다.
- `own.accounts`에는 원격 모드 필드와 오류만 더한다(16.5). 02 §9.1의 "다른 RPC id는 두지 않는다"는 `own.accounts` + `own.remote` 두 개로 바뀌었다(02 §9.1 반영됨).
- 05의 M1+ 게이트웨이·기기·알림 피드 메서드도 `own.remote`에 둔다(16.8). 그 일을 하는 주체가 같은 own-remote(로컬 모드)이고, 게이트웨이 리스너가 브로커 리스너와 같은 프로세스 수명 런타임에서 돌기 때문이다(05 §13.4). 이 장이 `own.remote`의 메서드·이벤트·오류·범위의 **유일한 목록**이다(02 머리말).
- 정의는 `@own/protocol`의 `./rpc-remote` export에 둔다. 오류 선언 규칙은 02 §9.4와 같다(선언한 type만 400, 핸들러는 throw 금지).

### 16.2 `own.remote` 메서드

로컬 control location으로 부른다(`agent.*`만 원격 서버). 메서드마다의 원격 기기 범위는 16.7, M1+ 메서드는 16.8이다.

**조회**

`hosts.list` `{}` →
```json
{ "revision": 7,
  "hosts": [
    { "id":"h-7k2m9q","alias":"lab","name":"lab","target":"lab",
      "stage":"ready","paused":false,"error":null,"detail":"",
      "platform":{"os":"linux","arch":"x64","target":"linux-x64-baseline","libc":"glibc"},
      "hostIdentity":"sha256:1f3c…","identityChanged":false,
      "versions":{"local":"2.0.18-own.3","remoteRunning":"2.0.18-own.3","remoteStaged":["2.0.18-own.2"],"skew":false},
      "autoConnect":true,"loopback":"127.0.3.2","localPort":24817,"epoch":12,
      "accounts":{"mode":"all"},"leaseSeconds":900,"failClosedGraceSeconds":300,"tokenTtlHours":12,
      "projectConfig":"disabled","shellEnv":"login",
      "warnings":["path_differs_interactive"],
      "broker":{"state":"connected","mode":"normal","proto":1,"leasesActive":3,"lastPushAt":1790001234000,"spoolBacklog":0,"gaps":0,"clockSkewMs":420,"sourceStale":[]},
      "sessions":{"active":1},
      "events":{"state":"subscribed","catalogEpoch":31,"catalogFetchedAt":1790001230000},
      "pendingSettings":false,
      "owner":{"clientId":null},
      "upstreamOpencodeDetected":false } ] }
```
- `destination`(`user@host:port`)은 기본으로 비운다. 사용자가 상태 패널을 열 때 `hosts.detail{hostId}`로 받는다(7.5).
- `warnings`: `path_differs_interactive`(대화형 셸에만 있는 PATH), `kill_user_processes`(6.2), `loose_host_key`(7.2), `clock_skew`(10.5), `tmp_noexec`(5.3) 등. 값은 상태 패널에 설명과 함께 보인다.

`hosts.discover` `{}` → `{aliases:[{alias, known:boolean, forwards:"none"|"maybe"|"yes", wildcard:false}]}`. `~/.ssh/config`와 Include를 파일로만 읽는다. 명령을 실행하지 않는다(7.5).

`hosts.detail` `{hostId}` → `{destination:"user@host:port" | null, source:"connect"|"file", configKeys:[…], forwards:[…]}`. 마지막 연결 직전 `ssh -G` 결과가 있으면 그것(`source:"connect"`), 없으면 config 파일을 읽은 근사치(`source:"file"`)다. 이 호출은 명령을 실행하지 않는다. 값은 상태 패널에만 보이고 로그에 남기지 않는다.

`resolve` `{hostId}` → `{url, token, tokenExpiresAt, epoch, controlDir, home}` | `{url:null, stage}`. 12.1. `url`은 `http://127.0.<k>.2:<LP>`이다. `token`은 own-remote가 서명한 짧은 수명 토큰이고, 남은 수명이 1시간 미만이면 새로 서명해 준다. `controlDir`은 ensure가 보고한 원격 control location 절대 경로, `home`은 inspect가 보고한 원격 `HOME`이다(12.4, 16.6). **이 응답은 서버 접근 토큰을 담는다.** 로그·ledger·이벤트에 남기지 않는다.

`catalog.get` `{hostId}` → `{epoch, fetchedAt, projects[], sessions[]}`. 쓰기 메서드는 없다. catalog는 own-remote leader만 쓴다(12.3). v0.2의 `catalog.put`은 없앴다.
- `broker.sourceStale`(`hosts.list`): 이 호스트에서 `source_stale`로 막힌 linked 계정 id 목록(8.5). own-web은 원격 세션의 전환기에서 이 계정을 비활성으로 보인다(17.7). 로컬 `accounts.list`의 상태와 따로 본다.
- `events.state`(`hosts.list`): `"subscribed" | "off" | "reconnecting"`. leader의 원격 이벤트 구독 상태(12.3). `incompatible`·drain이면 `"off"`.

`portForward.list` `{hostId?}` → `{forwards:[{id, hostId, remotePort, localPort, openedAt}]}` (R3)

`diagnostics` `{hostId}` → `{stage, lastError, sshVersion, sshPath, agentRunning, forwardsInConfig, brokerMode:"socket"|"tcp", socketDir, clockSkewMs, shellEnv:{mode, pathLogin, pathInteractive, pathSh}, linger, killUserProcesses, tmpNoexec, probe, stderrTail}`. `stderrTail`은 등록 블록과 비밀 패턴을 지운 마지막 2 KiB. PATH 값은 상태 패널에만 보인다.

**연결**

`hosts.add` `{alias} | {target, name}` → `{host}`. 원격에 아무것도 하지 않는다. 호스트 loopback 번호 `k`와 LP를 이때 고른다(7.3).
`hosts.update` `{hostId, name?, autoConnect?, accounts?, leaseSeconds?, failClosedGraceSeconds?, tokenTtlHours?, localPort?, installRoot?, projectConfig?:"disabled"|"instructions"|"trusted", shellEnv?:"login"|"login-interactive"|"sh", env?, pathPrepend?}` → `{host, pendingSettings}`. `projectConfig`, `shellEnv`, `env`, `pathPrepend`는 원격 재시작이 필요하므로 "설정 대기"가 된다(6.4). `projectConfig:"trusted"`는 확인 대화상자(15장의 위험 문구) 뒤에만 보낸다. `pathPrepend`에는 `hosts.tools.ensure`도 한 줄을 더한다(아래 "도구", 5.6).
`connect` `{hostId, clientId, hostKeyPrompt?: boolean}` → `{stage}`. 진행은 이벤트. `needs_install`이면 `prepare.plan`으로 이어진다. `hostKeyPrompt:true`는 호스트 추가 흐름과 `호스트 키 확인…`에서만 보낸다. 없으면 `StrictHostKeyChecking=yes`다(6.3).
`respond` `{hostId, promptId, clientId, value: string | null}` → `{}`. `null`은 취소. 값은 기록하지 않는다. `hostKey`·`confirm` 프롬프트에는 `value:"trust"`만 받고, own-remote가 ssh에 `yes`를 보낸다(14.2).
`heartbeat` `{clientId}` → `{}`. 소유한 시도가 있는 동안 10초마다(6.3).
`cancel` `{hostId, clientId}` / `disconnect` `{hostId}` → `{stage}`. disconnect는 pause이고 원격 service는 멈추지 않는다.

**원격에 변경이 생기는 동작: 2단계(plan → nonce → execute)**(02 §9.2 규칙)

`prepare.plan` `{hostId}` →
```json
{ "nonce":"n_…","expiresAt":1790001600000,
  "platform":{"target":"linux-x64-baseline"},
  "install":{"version":"2.0.18-own.3","dir":"~/.local/share/own-open-code/app/2.0.18-own.3","bytes":41200000,"needBytes":123600000,"freeBytes":8120000000},
  "existing":{"running":null,"staged":[],"upstreamOpencode":true},
  "hostIdentity":"sha256:1f3c…",
  "writes":["~/.local/share/own-open-code/…","~/.config/own-open-code/opencode.jsonc","~/.config/own-open-code/service-own.json","~/.config/opencode/service-own.json"],
  "root":false }
```
`prepare.execute` `{nonce}` → `{ok, steps[]}` (진행은 `host.progress`)

`update.plan` `{hostId}` → `{nonce, expiresAt, from, to, staged:boolean, activeSessions:[sessionID] | null, backup:{bytes}, needBytes, freeBytes}`. `activeSessions:null`은 원격 조회 실패다(18장 87행)
`update.execute` `{nonce, drain:"wait"|"now"}` → `{opId}`
`drain.plan` `{hostId, action:"stop"}` → `{nonce, expiresAt, activeSessions:[sessionID]}` / `drain.execute` `{nonce, mode:"wait"|"now"}` → `{opId}`
`forget.plan` `{hostId, uninstall:boolean}` → `{nonce, expiresAt, activeSessions, removes:[…], keeps:["~/.local/share/opencode/opencode-own.db","backup/"], leasedAccounts:[accountID]}` / `forget.execute` `{nonce}` → `{ok}`. T3부터 `removes`에 `<OWN_HOME>/tools`가 있다(6.7).
`sync.plan` `{hostId, skills:[name]}` → `{nonce, expiresAt, items:[{name, action:"add"|"update"|"same"|"present"|"conflict", root?, windowsOnly:boolean, bytes}]}` / `sync.execute` `{nonce}` → `{ok, steps[]}`
`tokens.rotate.plan` `{hostId}` / `tokens.rotate.execute` `{nonce}` → 원격 비밀번호 교체(15장)
`owner.takeover.plan` `{hostId}` / `owner.takeover.execute` `{nonce}` (6.8)
`recover.plan` `{hostId}` → `{nonce, expiresAt, pid, exe, version, reason:"unresponsive"}` / `recover.execute` `{nonce}` → `{opId}`. 응답 없는 원격 service를 SIGTERM → 5초 → SIGKILL로 내리고 다시 ensure한다(6.1 8번). pid와 `/proc/<pid>/exe`가 plan 때와 같을 때만 신호를 보낸다
`legacy.plan` `{}` / `legacy.execute` `{nonce, aliases:[…]}` (19장)
`portForward.open` `{hostId, remotePort}` → `{id, url:"http://127.0.<k>.3:<port>"}` / `portForward.close` `{id}` (R3, 되돌릴 수 있어 1단계)

**도구(T3, own 추가, 06 §4.13)**

`hosts.tools.ensure` `{hostId, tool:"git-lfs"}` → `{state:"uploaded"|"present", version}`. 범위 `manage`(16.7. 기기의 관리 권한, own.team `enable`과 같음), control location. 이 릴리스의 고정 git-lfs를 그 호스트의 `<OWN_HOME>/tools/git-lfs/<version>/`에 올린다(업로드만, sudo 없음, 결정 4). 원격 own.team이 `lfs_missing`으로 답하면 원격은 SSH를 쓸 수 없으므로 own-web이 이 메서드를 이 PC에서 부르고 켜기를 한 번 다시 부른다. 1단계인 이유: 올리기만 하고 지우지 않으며, 같은 버전이면 아무것도 쓰지 않는다.
- **순서**: 호스트를 살핀 적이 있어야 한다(원격 경로와 플랫폼). 로컬 `app\<ver>\remote\tools\…` 파일을 `remote\manifest.json`의 `tools`(5.2)와 sha256·크기로 먼저 맞추고, 다르면 호스트에 닿지 않고 `tool_hash_mismatch{tool, expected, actual}`. 그다음 호스트 작업 잠금(작업 종류 `tools`, 다른 작업 중이면 `host_busy`) 안에서 SSH 세션 하나로 살핀다: 그 버전이 `.verified`로 있으면 `current`만 가리키고 `present`(보낸 바이트 0). 없으면 여유 공간이 올릴 크기의 두 배 이상인지 보고 둘째 세션(`sh -c '<script>'`, stdin에 `LICENSE.md` 다음 실행 파일)으로 올린다: 크기 확인 → `sha256sum -c`(없으면 `shasum`, 그다음 `openssl`) → `chmod 755` → `git-lfs version` → `.verified` → 스테이지를 `<ver>`로 옮김 → `ln -sfn` + `mv -fT`로 `current`를 원자적으로 바꾸고 `current`로 다시 `version`. 출력은 `OWN_TOOL_*` 줄뿐이다.
- **뒤처리**: `<OWN_HOME>/tools/git-lfs/current`를 호스트 `pathPrepend`에 한 번 더해 `pendingSettings:true`(다음 서비스 시작에 적용, 5.6). 실행마다 로컬 `OWN_HOME\remote\<hostId>\ops.jsonl`에 적는다.
- **오류**: `host_not_found`, `host_busy`, `remote_unreachable`(호스트를 살핀 적 없음 등), `bundle_missing`(이 설치에 도구 파일이 없음), `disk_full`(ENOSPC·EDQUOT 또는 여유 부족), `not_supported`, `tool_hash_mismatch`, 호스트 스크립트의 `noexec`(exit 126)와 `install_failed`(checksum·version·`platform_mismatch`·기타), `input_invalid`(호스트 `pathPrepend`에 도구 폴더를 더할 수 없음). T3 리뷰 수정(2026-10-05)에서 `noexec`·`install_failed`·`input_invalid`를 선언해 own-web이 저마다 쉬운 말로 보인다. 실패한 올리기는 아무것도 설치된 채로 남기지 않는다.
- 이 메서드는 06 §11.1 스펙 추가 (1)이고 2026-10-05에 사용자가 승인했다. 공식 git-lfs 압축 파일 내려받기와 동봉, 호스트의 own 폴더에만 두기는 2026-10-04 결정이다. 실제 내려받기는 사용자가 대화에서 확인하거나 `-GitLfsArchive`로 사본을 줄 때만 하며 2026-10-05 현재 받지 않았다(FORK §8.2 2b단계).

**원격 서버에서(`mode:"agent"`)**

`agent.realpath` `{path}` → `{realpath, isSymlink, exists}`
`agent.status` `{}` → `{version, buildId, proto, mirror:{revision, fetchedAt}, broker:{state:"unarmed"|"connecting"|"connected"|"drain"|"skew", epoch, leases:[{providerID, deadlineInMs}]}, spool:{backlog, bytes, gaps}, owner:{installId}}` (lease 값과 키는 넣지 않음)
`agent.broker.arm` `{hostId, epoch, key, endpoint:{socket:string}|{tcpPort:number}, proto}` → `{accepted:boolean, reason?:"stale_epoch"|"key_mismatch"|"proto"}`. own-remote(local)만 부른다(원격 service Basic 인증, `-L`). own-web도 같은 서버 토큰을 갖지만 신뢰 경계가 같고, own-web의 원격 client 래퍼는 이 메서드를 노출하지 않는다. **요청에 브로커 키가 있다.** 원격은 키를 runtime 브로커 client의 클로저에만 두고 로그·이벤트·응답에 남기지 않는다(8.3)
`agent.probe` `{commands?:[string]}` → `{shell, path, found:{[name]:boolean}, tmpdir, exitCode}`. 에이전트 셸 도구와 같은 spawn 경로로 실행한다(6.1 9번). 기본 명령 목록 밖의 임의 명령은 받지 않는다

### 16.3 이벤트(`rpc.own.remote.<name>`)

로컬 own-remote leader만 발행한다. 모든 이벤트에 `eventId`(ULID).

| 이름 | 데이터 |
|---|---|
| `hosts.changed` | `{eventId, revision}` |
| `host.state` | `{eventId, hostId, stage, paused, error?, detail?, epoch?, versions?}` |
| `host.prompt` | `{eventId, hostId, promptId, kind:"password"\|"passphrase"\|"hostKey"\|"confirm"\|"other", text, fingerprint?, keyType?, ownerClientId}`. 프롬프트 문구만, 답은 없음. `hostKey`는 문구 분류로 정한다(14.2). 다른 탭·창은 "다른 창에서 인증 중"을 보인다. 원격 기기 스트림에는 가지 않는다(16.7) |
| `host.progress` | `{eventId, hostId, opId?, op:"install"\|"update"\|"drain"\|"sync"\|"forget", step, ok?, error?}` |
| `catalog.changed` | `{eventId, hostId, epoch}`. leader가 catalog를 교체하거나 부분 갱신한 뒤(12.3) |
| `broker.status` | `{eventId, hostId, state:"connected"\|"disconnected"\|"auth_failed", leasesActive, spoolBacklog}` |

- M1+ 이벤트(`gateway.state`, `device.*`, `feed.item`)는 16.8, 원격 기기에 보이는 범위는 16.7이다.

### 16.4 오류 type

| type | 주로 내는 메서드 | `data` |
|---|---|---|
| `host_not_found` | 모두 | `{hostId}` |
| `host_busy` | 두 번째 작업(install 중 update 등) | `{hostId, opId}` |
| `ssh_missing` | `connect`, `*.plan` | `{path}` |
| `platform_unsupported` | `prepare.plan` | `{os, arch}` |
| `disk_full` | `prepare.*`, `update.*` | `{needBytes, freeBytes}` |
| `version_skew` | `connect` | `{local, remote}` |
| `host_identity_changed` | `connect` | `{previous, current}` |
| `forward_conflict` | `connect` | `{alias, kinds[]}` |
| `forwarding_disabled` | `connect` | `{}` |
| `loopback_unavailable` | `connect`, `portForward.open` | `{address}` |
| `host_key` | `connect` | `{reason:"unknown"\|"changed"}` |
| `service_not_loopback` | `connect` | `{hostname}` |
| `service_unresponsive` | `connect` | `{pid}` |
| `other_owner` | `connect`, `*.plan` | `{label?}` |
| `ops_pending` | `connect`, `*.plan` | `{opId, kind}` |
| `session_busy` | `forget.execute`(`uninstall:true`, 실행 중 세션이 있는데 drain 없이), `tokens.rotate.execute` | `{sessionIDs[]}` |
| `remote_unreachable` | `*.plan`(inspect 실패), (T3) `hosts.tools.ensure` | `{stage}` |
| `tool_hash_mismatch` | (T3) `hosts.tools.ensure`: 로컬 도구 파일이 원격 manifest의 고정 sha256과 다름. 호스트에 아무것도 보내지 않음 | `{tool, expected, actual}` |
| `noexec` | (T3) `hosts.tools.ensure`: 그 폴더에서 프로그램을 실행할 수 없음 | `{}` |
| `install_failed` | (T3) `hosts.tools.ensure`: 올린 파일의 checksum·version 확인 실패 | `{}` |
| `input_invalid` | 입력 검사(`hosts.update` 등), (T3) `hosts.tools.ensure`: 호스트 `pathPrepend`에 도구 폴더를 더할 수 없음 | `{field, reason}` |
| `nonce_invalid` | 모든 `*.execute` | `{}` |
| `internal_error` | 모두 | `{}` |

- M1+ 오류(`gateway_unavailable` 등 7개)는 16.8. 게이트웨이가 범위 밖 호출을 거절할 때의 `scope_denied`는 핸들러가 아니라 게이트웨이가 낸다(RPC 핸들러는 호출한 기기를 모른다, 02 §9.1).

### 16.5 `own.accounts` 변경 (02 §9에 제안)

- `health` 출력에 `mode: "local"|"remote"`, 원격이면 `broker: {state, epoch, lastSeenAt}`, `mirror: {revision, fetchedAt}`를 더한다. 원격이면 `claudeSlot: {state, conflict}`도 더한다(8.11.4.3).
- 새 오류 `remote_managed` `{method}`: `mode:"remote"`에서 `accounts.add.*`, `accounts.update`, `accounts.remove.*`, `accounts.test`, `policy.set`, `ratecards.set`, `plugin.claudeAuth.*`(`plugin.claudeAuth.remote.ack`, `plugin.claudeAuth.remote.set`, `plugin.claudeAuth.fastAck` 포함, 8.11.12)가 낸다.
- `ledger.session` 입력에 `server?`(기본 `"local"`). 로컬이 모든 서버의 ledger를 답한다.
- `accounts.usage` 행에 `server`, 그리고 `groupBy:"server"`.
- 경보 코드 추가(02 §7.7): `broker_unavailable`(세션, 원격), `remote_spool_overflow`(전역, 로컬), `remote_observation_rejected`(전역, 로컬), `remote_skew`(전역, 로컬), `remote_host_identity_changed`(전역, 로컬), `remote_clock_skew`(전역, 로컬, 10.5), `claude_remote_refused`(세션, 원격), `claude_remote_conflict`(세션, 원격).
- 계정 필드 `remote: "allow"|"deny"`와 `accounts.update{remote}`.

### 16.6 location 규칙

- 원격 서버의 control location은 원격 `<OWN_HOME>/control`(절대 경로)이다. 원격 `health`, `plugin.trust.*`, `agent.*`, 폴더 선택기의 `fs.list`(12.4)는 여기로 보낸다.
- own-web이 원격 control 경로를 얻는 방법은 `own.remote.resolve` 응답의 `controlDir`(ensure가 보고한 값) **하나뿐**이다. 02 §9.1의 "없으면 아무 location으로 `health`" 대체는 원격에서 쓰지 않는다. 아무 location으로 부르면 원격 홈 같은 곳에 Location이 생길 수 있기 때문이다(12.4). `controlDir`이 없으면(`resolve`가 `url:null`) 원격 RPC를 부르지 않는다. 휴대폰(M1+)은 `resolve`를 부를 수 없으므로 게이트웨이가 `/srv/<hostId>` 중계에서 같은 값을 쓴다(12.7).

### 16.7 원격 기기 범위 (`OwnRemote.MethodScope`)

02 §9.1의 `OwnAccounts.MethodScope`와 같은 어휘(`read | drive | manage | local`)와 같은 규칙을 `own.remote`에 둔다. `@own/protocol`이 `OwnRemote.MethodScope`(메서드 이름 → 범위)를 내보내고, 게이트웨이(05 §13.4)와 own-web이 같은 표를 쓴다. 새 메서드는 범위 없이 추가할 수 없다(타입으로 강제). RPC 핸들러는 호출한 기기를 모르므로 강제는 게이트웨이가 경로 `/api/rpc/own.remote/<method>`로 한다.

| 범위 | 메서드 | 원격 기기(게이트웨이 경유) |
|---|---|---|
| `read` | `hosts.list`, `catalog.get`, `portForward.list`, (M1+) `feed.list`, `feed.ack`, `push.register`, `push.unregister` | 모든 기기 토큰. `feed.*`·`push.*`는 게이트웨이가 호출 기기의 `deviceId`에 묶는다(자기 커서·자기 구독만) ⚠05와 확정 |
| `drive` | 없음. 원격 세션의 조작(프롬프트, 전환, 압축)은 그 원격 서버의 세션 HTTP와 `own.accounts` 세션 메서드이고 그쪽 범위표를 따른다(12.7) | – |
| `manage` | `connect`(`hostKeyPrompt` 없이), `disconnect`, `drain.plan`, `drain.execute`, `diagnostics`, (T3) `hosts.tools.ensure` | "관리" 권한 기기(기본 꺼짐). `connect`가 프롬프트를 만나면 pause되고 PC에서 답해야 한다(6.3). 본문에 `hostKeyPrompt:true`가 있으면 `local`이다(게이트웨이가 본문 검사, 02 §9.1 `accounts.update{replaceKey}`와 같은 방식 ⚠) |
| `local` | `hosts.discover`, `hosts.detail`, `hosts.add`, `hosts.update`, `resolve`, `respond`, `heartbeat`, `cancel`, `connect{hostKeyPrompt:true}`, `prepare.*`, `update.*`, `forget.*`, `sync.*`, `tokens.rotate.*`, `owner.takeover.*`, `recover.*`, `legacy.*`, `portForward.open`, `portForward.close`, (M1+) `gateway.*`, `devices.*` | **절대 안 됨.** PC의 데스크톱·웹 클라이언트(loopback)만 |
| (원격 서버) | `agent.realpath`, `agent.status`, `agent.broker.arm`, `agent.probe` | **절대 안 됨.** 로컬 own-remote만 부른다. 게이트웨이의 `/srv/<hostId>` 중계가 이 경로를 항상 막는다(12.7) |

- `local`인 이유: 서버 접근 토큰을 돌려주거나(`resolve`), 로컬 파일을 읽거나(`hosts.discover`는 `~/.ssh/config`, `legacy.*`는 이전 앱 파일), SSH 인증에 답하거나(`respond`, 호스트 키 신뢰), 원격에 설치·삭제·비밀번호 교체를 하거나, 로컬 리스너를 열거나(`portForward.open`), 기기와 게이트웨이 자체를 관리한다(05: `devices.*`·`gateway.*`는 PC에서만). `hosts.detail`은 `user@host:port`를 담는다.
- **이벤트.** `own.remote` 이벤트는 기본 `read`다. 예외로 `host.prompt`(프롬프트 원문과 지문, 답은 PC에서만)와 `device.pairing.pending`(확인 번호 SAS)은 `local`이라 게이트웨이가 기기로 가는 이벤트 스트림에서 뺀다. 게이트웨이가 SSE를 버퍼링 없이 흘리면서 이 두 종류의 프레임만 걸러야 한다 ⚠(05 §13.4와 확정). `feed.item`과 `host.state`·`catalog.changed`는 기기의 `servers` 범위(05 §13.5) 밖 hostId면 뺀다.
- 05 §13.5의 기기 범위(`read`, `prompt`, `switch`, `files`, `terminal`, `admin`)와 이 어휘의 대응(`drive` ↔ `prompt`·`switch`, `manage` ↔ `admin`, `local` ↔ 어떤 기기 범위로도 불가)은 05·02가 정한다 ⚠(24장).

### 16.8 M1+ 추가 (기준 05 §13.4–13.6)

게이트웨이, 기기 페어링, 알림 피드는 own-remote(로컬 모드, 4.1의 프로세스 수명 런타임)가 맡으므로 RPC id도 `own.remote`다. 이 문서는 이름과 범위만 정하고, 입력·출력 모양·동작·저장 파일(`OWN_HOME\devices.json`, `OWN_HOME\feed\feed-YYYY-MM.jsonl`, `vault\push-vapid.dpapi`, push 구독 파일)은 **05가 기준**이다. 정의는 이 문서의 나머지 메서드와 함께 `@own/protocol`의 `./rpc-remote`에 둔다. 단계는 01 §17의 P8(게이트웨이 기반, M1)과 후속(푸시, M2–M3)이다.

| 종류 | 이름 | 범위(16.7) | 05 |
|---|---|---|---|
| 메서드 | `gateway.status`, `gateway.configure.plan` → `gateway.configure.execute{nonce}`, `gateway.disable` | `local` | 13.3–13.4 |
| 메서드 | `devices.pair.start`, `devices.pair.approve`, `devices.pair.cancel`, `devices.list`, `devices.update`, `devices.revoke`, `devices.revokeAll` | `local` | 13.5 |
| 메서드 | `feed.list`, `feed.ack` | `read`(기기에 묶임) | 13.6 |
| 메서드 | `push.register`, `push.unregister` | `read`(기기에 묶임) ⚠ | 13.6 |
| 이벤트 | `gateway.state`, `device.paired`, `device.revoked`, `feed.item` | `read` | 13.4–13.6 |
| 이벤트 | `device.pairing.pending` | `local` | 13.5 |
| 오류 | `gateway_unavailable`, `tailscale_missing`, `bind_rejected_lan`, `pairing_expired`, `pairing_rejected`, `scope_denied`, `device_revoked` | – | 13 |

- 모든 이벤트에 `eventId`(ULID)를 붙이고 로컬 leader만 발행한다(16.3과 같음).
- 원격(SSH) 세션의 `feed.item`은 12.3의 원격 이벤트 구독에서 나온다. 로컬 세션의 항목은 05 §13.6대로 로컬 서비스 이벤트에서 나온다. T3의 FeedKind `team.decision`(팀의 확인 대기와 실패한 반영, 06 §9.8)은 이 PC의 팀이면 로컬 이벤트, 원격 팀이면 12.3의 호스트마다 좁은 팀 구독에서 나온다.
- 게이트웨이의 `/srv/<hostId>` 중계는 12.7, 기기가 원격 세션을 다룰 때의 위협은 15장과 05 §13.8이다.
- 앱 연결(08 §3.7)은 `gateway.configure.plan`의 `app`, `GatewayView.app`, `TailscaleView.lock`·`appServing`, `devices.pair.start` 출력의 `appLink`를 더한다. 범위는 위 표와 같다(`local`). 앱 기기는 `kind:"app"`이다.

---

## 17. UI 변경 (03에 반영할 것)

### 17.1 정보 구조
- 03 §3의 `설정 > 서버 연결`을 `설정 > 원격 호스트`로 넓히고, `실험 > 원격 서버(예정)`를 없앤다.
- 사이드바 맨 아래 `● 로컬 · 연결됨`은 "이 PC"의 상태로 남기고, 호스트 상태는 사이드바 그룹 머리줄에 둔다.

### 17.2 사이드바
```text
▾ 이 PC ●                                        +  ⋯
  폴더 열기…
  ▾ own-open-code (3)                            +  ⋯
     ● 계정 라우터 RPC 설계                   3분
       [● 개인 Pro] GPT-5.6 Sol
▾ lab ●                                           +  ⋯
  폴더 열기…
  ▾ ~/work/example-game (2)                      +  ⋯
     ○ 빌드 스크립트 정리                    1시간
       [● 회사 · prod] Claude Opus 5.5
▾ build-host ○ 연결 끊김                         ⋯
  다시 연결
  저장해 둔 목록 · 12분 전
▸ work_linux ⤓ 업데이트 필요                        ⋯
──────────────────────────────── (아래는 고정)
+ 원격 호스트 추가    + 다른 PC 추가
```
- 2026-11-26(SBL)부터 호스트는 이 PC, 다른 PC와 같은 서버 구역이다(03 §4.3): 같은 머리줄, 같은 자리의 첫 줄(`폴더 열기…`, 준비되지 않았으면 `다시 연결`·`인증하고 연결`·`호스트 키 확인…`·`설치…`·`업데이트…`·`이 PC로 가져오기`), 제 높이, 끌어서 순서 바꾸기. 상태 문구는 연결되지 않았을 때만 있고, `저장해 둔 목록 · 12분 전`은 머리줄이 아니라 목록 위 한 줄이다.
- 호스트 머리줄: 이름, 상태 기호, 상태 문구, `+`(준비된 호스트), `⋯`(폴더 열기, 다시 연결, 연결 끊기, 업데이트, 현재 턴이 끝나면 중지, 설정, 제거, 순서 항목).
- 호스트 프로젝트의 순서와 고정은 **그 호스트의 서비스**가 갖는다(own.accounts `projectList.*`, 02 §9.2). 원격 서비스는 전역 이벤트를 내지 않으므로 다른 창은 다시 연결할 때 읽는다. 이 메서드가 없는 이전 원격 서비스에서는 이 브라우저에만 두고, 호스트를 평소처럼 업데이트하면 한 번 넘긴다(`proto` 1 그대로).
- 끊긴 호스트의 세션 행은 흐리게, 클릭하면 "연결하면 열 수 있습니다 [다시 연결]".
- 상태 기호는 03 §7.6을 따르고, 호스트 전용으로 `⤓`(업데이트 필요)와 `!`(인증 필요)를 더한다.
- **폴더 없는 대화(2026-10-18, 03 §5.1).** 호스트 프로젝트의 새 대화 화면에서 선택기의 `폴더 없이 대화`를 고르면 `/srv/<hostId>/new`가 열리고, 대화는 그 호스트가 정한 기본 대화 폴더에서 일한다. 호스트의 own.accounts가 `conversationFolder.*`에 스스로 답한다(원격 관리 메서드가 아님, 02 §9.2). 그 대화들은 호스트 그룹 안의 `폴더 없는 대화` 묶음이다. 원격 폴더 선택기(17.4)는 호스트의 홈에서 시작한다(시작 위치 설정은 없다).
- **새 대화의 서버 고르기와 호스트의 새 대화 폴더(2026-11-22, SN, 2.2.6-own.16, 03 §5.1).** 새 대화 화면의 서버 단추에서 호스트를 고르면(호스트 구역의 `+`도 같고, 사이드바의 `새 대화`·Alt+N은 지금 보는 서버, 서버가 정해지지 않은 화면과 휴대폰의 `+ 새 대화`는 마지막에 고른 서버로 간다) 그 호스트의 폴더 없는 화면이 열린다. 연결이 끊겼을 뿐인 호스트는 그때 연결을 시작하고, 인증·호스트 키·설치·업데이트가 필요하면 겹침 화면(17.7)이 그 단계를 보인다.
  - **새 호스트의 기본값은 `~/own-chats`다.** 홈 바로 아래, 숨기지 않고, 소문자에 띄어쓰기가 없어 셸에서 그대로 친다. XDG에는 대화나 작업 폴더의 자리가 없고(`XDG_DOCUMENTS_DIR`는 데스크톱의 `~/Documents`라 서버에는 보통 없다), `~/.local/share`는 사람이 열어 보는 곳이 아니다. 비슷한 도구도 작업 폴더를 홈 바로 아래 짧은 이름으로 둔다. 2.2.6-own.15까지의 기본값(`~/Documents`가 있으면 `~/Documents/Own OpenCode`, 없으면 `~/Own OpenCode`)이 **이미 있는 호스트는 그것을 계속 쓴다**. 그 폴더의 대화는 그대로 `폴더 없는 대화`이고 아무것도 옮기지 않는다. 새 폴더로 옮기고 싶으면 호스트의 `새 대화 폴더`에서 고른다(그 전 폴더의 대화는 폴더 이름의 보통 프로젝트로 보인다, DF와 같음).
  - 설정 > SSH 원격 호스트 > 그 호스트(17.5)의 `새 대화 폴더`에서 보고 바꾼다. 값은 호스트 서비스의 KV에 있어 그 호스트에 붙는 모든 창과 기기가 같다. 절대 경로나 `~/…`를 받고, 호스트가 거르고(홈 자체·루트·own의 폴더 거절) 만들고 쓰기 확인을 한다. 그래서 이 화면은 호스트가 연결된 동안만 바꾼다. 예: `~/projects/own-chats`.
  - 이 값은 호스트의 own 서비스 데이터에 있다(원격 세션과 같은 데이터 루트). own은 대화 폴더와 그 안의 파일을 옮기거나 지우지 않는다.
  - 이전 원격 서비스는 `~/…`를 `relative`로 거절하고 Linux 기본값도 예전 것이다. 호스트를 이 판으로 업데이트하면(평소의 버전 맞추기, `proto` 1 그대로) 둘 다 된다.

### 17.3 호스트 추가 흐름
1. `원격 호스트 추가` → alias 목록(`hosts.discover`, 이미 추가된 것과 forward가 있는 것 표시) 또는 `직접 입력`(target).
2. `연결 확인` → `connect` → 필요하면 askpass 대화상자(17.6) → inspect.
3. 설치가 필요하면 설치 계획 카드(`prepare.plan`): 설치 위치, 크기, 여유 공간, "root 불필요", "upstream opencode는 건드리지 않음", 쓸 파일 목록. [설치하고 연결] / [취소].
4. 진행 표시(`host.progress`: 업로드 → 검증 → 설정 → 시작 → 터널 → 브로커 → 도구 확인).
5. 확인 카드: `agent.probe` 결과(찾은 도구, PATH), 셸 모드 권고(대화형 셸에만 있는 PATH가 있으면 "`.bashrc`의 PATH가 에이전트 도구에 보이지 않습니다: +`~/.nvm/…` [대화형 셸 설정 쓰기]"), 경고(`kill_user_processes`, `loose_host_key` 등), 프로젝트 설정의 현재 상태("프로젝트 설정: 지시 파일만 (AGENTS.md) [바꾸기…]")와 세 상태(끔 / 지시 파일만 / 켬)가 각각 무엇을 읽는지 적은 세 줄(`own.remote.projectConfig.off`·`instructions`·`on`, 현재 상태가 아닌 줄은 흐리게).
6. 완료 → `폴더 열기` 대화상자(17.4)로 이어진다.
7. 계정 범위와 lease는 기본값으로 두고(느슨한 호스트 키 설정이면 계정 없음, 7.2), "나중에 호스트 설정에서 바꿀 수 있습니다"를 보인다.

### 17.4 원격 폴더 선택기
- 호스트 서비스의 `folderPicker.list`로 탐색(2026-11-22, SN, 02 §9.2. 이전 서비스는 원격 `fs.list`, 항상 control location + 절대 경로, 12.4). 위쪽에 경로 입력(IME 규칙 적용, `~`·`~/…`는 호스트의 홈), 최근 폴더(catalog), 홈으로(`resolve`의 `home` 절대 경로로 이동할 뿐 location을 바꾸지 않음).
- 권한(03 §18.3과 같음): 호스트 사용자가 읽거나 들어갈 수 없는 폴더는 흐린 `🔒`와 툴팁 `읽을 권한이 없어요 (소유자: root)`. 그런 폴더를 열면 `이 폴더는 읽을 권한이 없어요 (소유자: root).`, 없으면 `이 경로에 폴더가 없어요: …`, 파일이면 `폴더가 아니에요 (파일이에요): …`. 예전에는 ext4 루트의 `/lost+found`(`drwx------ root root`)를 열면 `이 경로를 읽지 못했어요`만 나와 경로가 틀린 것처럼 보였다(사용자 보고 2026-11-22).
- 파일 시스템 루트나 마운트 지점의 `lost+found`는 목록에서 숨기고 상태 줄에 숨긴 수를 적는다. 경로를 입력하면 연다.
- `＋ 새 폴더`(2026-11-22, SN): 지금 보는 호스트 폴더 안에 호스트의 서비스가 만들고(`folderPicker.create`, 범위 `prompt`) 확인 카드를 연다. 한글 이름 가능. 같은 이름이 있으면 `같은 이름이 이미 있어요.`와 `그 폴더 열기`. 이전 원격 서비스와 `prompt` 범위가 없는 기기에는 없다. 휴대폰·다른 PC도 이 선택기가 열리는 곳에서는 같은 범위로 쓴다.
- 고르면 `agent.realpath` 결과를 보이고, 심볼릭 링크면 안내 문구.
- `이 폴더에서 새 세션` → 모델 @ 계정 기본값(그 호스트에 허용된 계정 중).

### 17.5 호스트 상태 패널 (`설정 > 원격 호스트 > lab`)
- 연결: 스테이지, 마지막 오류(정리된 문구), `사용자@호스트:포트`(열 때만 계산), 로컬 포트, epoch.
- 버전: 이 PC / 원격 실행 중 / 원격 스테이징. [업데이트…](drain 선택 포함).
- 브로커: 상태, 활성 lease 수(계정 이름만), 이 호스트에서 막힌 linked 계정(`source_stale`, 8.5), 마지막 관측 전송, spool 대기, 누락 구간.
- Claude 구독: `사용 중 / 꺼짐 / 계정 범위에 없음 / 동의 필요 / PC 준비 안 됨 / API 키 연결`, 진행 중 중계 수, 마지막 거절. 켜고 끄기는 PC의 Claude 카드에서 한다(8.11.12).
- 목록: 원격 이벤트 구독 상태와 catalog 갱신 시각(`hosts.list`의 `events`, 12.3).
- 계정 범위: 모두 / 선택한 계정만. lease 시간(슬라이더, 트레이드오프 문구), 끊김 유예 시간.
- 새 대화 폴더(2026-11-22, SN): 그 호스트의 기본 대화 폴더. 경로, `기본값` 표시, `바꾸기…`(경로 칸, 절대 경로나 `~/…`), `기본값으로`. 호스트 서비스에 바로 저장한다(재시작 필요 없음). 연결되지 않았으면 `호스트에 연결하면 보고 바꿀 수 있어요.`.
- 신뢰와 환경: **프로젝트 설정**(끔 / 지시 파일만 (AGENTS.md) / 켬. 새 호스트는 지시 파일만, 예전 호스트는 저장된 값. 아래에 세 상태가 읽는 것을 한 줄씩 적고, 켬으로 바꿀 때 위험 문구를 확인한다, 5.6, 15장), 셸 환경(로그인 / 로그인+대화형 / sh, PATH 차이 표시), 추가 env·PATH, 세션 토큰 수명. 바꾸면 "설정 대기(재시작 필요)".
- 경고: `warnings`(원격 시계 차이, KillUserProcesses, 느슨한 호스트 키 설정, /tmp noexec)를 설명과 함께.
- 동작: 다시 연결, 연결 끊기, 호스트 키 확인…, 현재 턴이 끝나면 중지, 응답 없는 서비스 복구(`recover`), 스킬 동기화, 원격 접근 토큰 모두 무효화, 이 PC로 가져오기(owner), 제거.
- 진단: `diagnostics` 결과 복사(비밀 없음).

### 17.6 프롬프트 대화상자
- 비밀번호·암호문구: 비밀 입력칸, 붙여넣기 허용, 값은 전송 뒤 즉시 지움. 그 밖의 입력(`other`)도 비밀 입력칸 + 보이기 토글.
- 호스트 키 확인(`hostKey`): 원문 프롬프트와 지문(`SHA256:…`)을 **가리지 않고** 크게, 키 종류, "처음 연결하는 호스트입니다. 지문이 서버 관리자가 알려 준 값과 같은지 확인하세요". 입력칸 없이 `신뢰하고 연결` / `취소`(기본 포커스). 호스트 추가와 `호스트 키 확인…`에서만 뜬다(14.2).
- agent·FIDO 확인(`confirm`): 원문과 `허용` / `취소`(기본 포커스).
- 다른 탭이 소유한 시도: `다른 창에서 인증 중입니다`와 [이 창에서 다시 시도].

### 17.7 세션 화면 상태 (03 §8 표에 추가)

| 상태 | 표시 |
|---|---|
| 원격 연결 끊김 | overlay `원격 세션은 호스트에 그대로 있습니다. 다시 연결하는 중…`, composer 비활성 |
| 원격 인증 필요 | overlay + [인증하고 연결] |
| 원격 업데이트 필요 | overlay `이 호스트의 own 버전이 달라 열 수 없습니다` + [업데이트…] |
| 브로커 없음(유예 중) | 세션 배너 `로컬 인증 브로커에 연결할 수 없어 모델을 부를 수 없습니다(안전하게 멈춤). 남은 시간 N분` |
| 브로커 없음(유예 끝) | 턴 오류 행 + [계속] |
| 원격 재개됨 | 세션 헤더 보조 줄 `원격 서비스가 다시 시작되어 이어서 실행했습니다(캐시 다시 쓰기)` |
| 원격에서 쓸 수 없는 계정 | 전환기 항목 비활성 `이 호스트에서 허용되지 않은 계정` |
| 원격 Claude 쓸 수 없음 | 전환기 Claude 행에 이유와 동작(`own.remote.claudeSlot.*`), 턴 중에는 `claude_remote_refused` 경보 |
| linked 계정이 이 호스트에서 막힘(`scope:"host"` stale, 8.5) | 전환기 항목 비활성 + 세션 배너 `own.remote.lease.sourceStale`. 동작은 02 §3.2a의 `[가져오기로 전환(takeover)]`, `[다른 계정으로 전환]` |

### 17.8 종료 대화상자 (6.5)
`원격 호스트에서 세션 2개가 실행 중입니다` + 세 선택지 + lease 설명 한 줄.

### 17.10 SSH 파일 탐색기 프로그램 (OIE, 2026-11-21)

`설정 > SSH 원격 호스트` 맨 아래의 `SSH 파일 탐색기` 칸이다. 데스크톱 앱에서만 보인다(`host.explorer`). **이 PC의 설정**이고 호스트마다 따로 두지 않는다: 값은 데스크톱 앱의 설정 파일에 있고(05 §7.10 `ownExplorerProgram`) 원격 서비스나 `hosts.json`에는 가지 않는다.

- `프로그램`: 고른 `.exe`의 경로, 없으면 `고르지 않았어요`. `프로그램 고르기…`는 데스크톱 앱의 파일 대화상자를 연다(화면에 경로를 적는 칸은 없다: 페이지가 실행할 파일을 정하지 못하게 한다). `지우기`는 프로그램만 지우고 실행 인자는 둔다.
- `실행 인자`: 틀이다. 기본값 `--open {host} {path}`. `Enter`나 칸을 떠날 때 저장하고, 쓸 수 없는 틀(`{path}`가 없음, 모르는 `{이름}`, 닫지 않은 따옴표)은 저장하지 않고 전 값으로 돌리며 토스트로 알린다. 기본값이 아니면 `기본값으로`가 보인다.
- `{host}`는 **own이 그 호스트에 ssh로 붙을 때 쓰는 대상**이다. ssh config에서 고른 호스트는 그 별칭(`hosts.json`의 `alias` = `target`)이고, 직접 입력한 호스트는 입력한 줄의 마지막 낱말(`parseTarget`의 `host`, 7.2: `user@host`)이다. own은 호스트의 포트·점프 호스트를 따로 저장하지 않는다: 직접 입력한 줄의 `-p`, `-J`, `-o …`는 그 줄 안에만 있고 `{host}`에 들어가지 않는다. 그러므로 기본 포트가 아니거나 점프 호스트를 쓰는 호스트는 **ssh config 별칭으로 추가**해야 외부 프로그램도 사용자의 `~/.ssh/config`로 같은 설정을 읽는다. `user@host:2222`처럼 적은 대상은 그대로(`user@host:2222`) 넘어간다.
- `{path}`는 호스트의 절대 경로다(대화의 작업 폴더, 파일 탭의 폴더나 파일).
- 사용자의 `ssh-explorer`(직접 만든 Windows 프로그램)가 기준 계약이다: `ssh-explorer.exe --open <host> <remote path>`, 인자는 정확히 둘. `<host>`는 ssh config 별칭이나 `user@host`(공백이 있거나 `-`로 시작하면 거절), `<remote path>`는 `/`로 시작하는 절대 경로다. 폴더는 서버 창에서 열고, 파일은 들어 있는 폴더를 열어 그 파일을 고른다(실행하거나 미리 보지 않는다). 없는 경로면 가장 가까운 있는 폴더를 연다. 이미 떠 있으면 그 창이 요청을 받아 앞으로 나온다.
- 문구는 own-web `src/explorer/strings.ts`(`own.explorer.*`, 따로 된 청크)에 있다.

### 17.9 문구 카탈로그 추가(03 §14)

| 키 | 한국어 |
|---|---|
| `own.remote.group.local` | 이 PC |
| `own.remote.state.ready` | 연결됨 |
| `own.remote.state.connecting` | 연결 중… |
| `own.remote.state.authentication` | 인증 필요 |
| `own.remote.state.incompatible` | 업데이트 필요 |
| `own.remote.state.disconnected` | 연결 끊김 |
| `own.remote.state.otherOwner` | 다른 PC가 관리 중 |
| `own.remote.state.draining` | 현재 턴이 끝나면 중지 |
| `own.remote.add` | 원격 호스트 추가 |
| `own.remote.openFolder` | 폴더 열기… |
| `own.remote.install.title` | 이 호스트에 own을 설치할까요? |
| `own.remote.install.noRoot` | 관리자(root) 권한이 필요 없습니다. 설치 위치: {dir} |
| `own.remote.install.upstream` | 이 호스트의 opencode 설치는 건드리지 않습니다 |
| `own.remote.overlay.disconnected` | 원격 세션은 호스트에 그대로 있습니다. 다시 연결하는 중… |
| `own.remote.broker.unavailable` | 로컬 인증 브로커에 연결할 수 없어 모델을 부를 수 없습니다(안전하게 멈춤). 남은 시간 {minutes}분 |
| `own.remote.lease.help` | 이 시간 동안은 이 PC와 연결이 끊겨도 원격 작업이 계속됩니다. 길수록 키가 원격 메모리에 오래 머뭅니다. ChatGPT 로그인 토큰은 Codex 말고도 그 ChatGPT 계정의 다른 기능에 쓰일 수 있으니, 믿는 호스트에만 허용하세요 |
| `own.remote.hostKey.title` | 처음 연결하는 호스트입니다 |
| `own.remote.hostKey.check` | 지문이 서버 관리자가 알려 준 값과 같은지 확인하세요: {fingerprint} |
| `own.remote.hostKey.unknown` | 호스트 키를 확인하지 않은 연결은 자동으로 하지 않습니다. [호스트 키 확인…] |
| `own.remote.hostKey.loose` | 이 호스트는 호스트 키 확인이 꺼져 있습니다. 계정을 직접 고르기 전에는 이 호스트에 계정을 보내지 않습니다 |
| `own.remote.projectConfig.off` | 끔: 저장소에서 아무것도 읽지 않습니다. AGENTS.md도, 프로젝트 설정(.opencode 플러그인·에이전트·명령·스킬, 프로젝트 opencode.json과 그 MCP)도 읽지 않습니다 |
| `own.remote.projectConfig.instructions` | 지시 파일만: 저장소의 AGENTS.md만 읽습니다. 대화 폴더에서 저장소 맨 위 폴더까지 찾고, 하위 폴더의 것은 그 안의 파일을 읽을 때 더합니다(OpenCode·omo·Claude 방식). 플러그인·MCP·에이전트·명령·스킬·프로젝트 opencode.json은 읽지 않아서 저장소의 코드는 실행되지 않습니다 |
| `own.remote.projectConfig.on` | 켬: AGENTS.md와 프로젝트 설정을 모두 읽습니다. 저장소의 플러그인과 MCP가 이 호스트에서 실행됩니다 |
| `own.remote.projectConfig.current` | 프로젝트 설정: {state} |
| `own.remote.projectConfig.change` | 바꾸기… |
| `own.remote.projectConfig.warn` | 프로젝트 설정을 켜면 이 호스트에서 여는 저장소의 플러그인이 원격 작업에 쓰이는 계정 키를 읽을 수 있습니다. 믿는 저장소만 여는 호스트에서만 켜세요 |
| `own.remote.shellEnv.differs` | 대화형 셸 설정(.bashrc)의 PATH가 에이전트 도구에 보이지 않습니다: {paths} |
| `own.remote.killUserProcesses` | 이 호스트는 SSH가 끊기면 원격 작업도 멈춥니다. 계속 돌게 하려면 관리자가 linger를 켜야 합니다 |
| `own.remote.clockSkew` | 원격 시계가 {minutes}분 어긋나 있습니다 |
| `own.remote.devForward.external` | 개발 서버는 이 창 밖의 브라우저에서 엽니다 |
| `own.remote.devForward.pane` | 이 세션의 브라우저 패인에서는 원격 호스트의 localhost를 포트 전달 없이 열 수 있습니다 |
| `own.remote.lease.sourceStale` | 이전 앱이 이 계정의 로그인을 아직 갱신하지 않아 이 호스트에서 쓸 수 없습니다. 이전 앱에서 이 프로필을 한 번 실행하거나 가져오기로 전환(takeover)하세요 |
| `own.remote.account.notAllowed` | 이 호스트에서 허용되지 않은 계정 |
| `own.remote.claudeSlot.badge` | PC 경유 |
| `own.remote.claudeSlot.badgeHelp` | 이 호스트의 Claude 요청은 이 PC를 거쳐 나갑니다 |
| `own.remote.claudeSlot.off` | PC에서 이 호스트의 Claude 구독이 꺼져 있습니다 — PC의 Claude 카드에서 켜세요 |
| `own.remote.claudeSlot.hostScope` | 이 호스트의 계정 범위에 Claude 구독이 없습니다 |
| `own.remote.claudeSlot.consent` | PC에서 원격 사용 동의가 필요합니다 |
| `own.remote.claudeSlot.notReady` | PC의 Claude 구독이 준비되지 않았습니다(플러그인·로그인) |
| `own.remote.claudeSlot.billing` | PC의 Anthropic 연결이 API 키라 원격에서 쓰지 않습니다 |
| `own.remote.claudeSlot.offline` | PC와 연결되면 쓸 수 있습니다 |
| `own.remote.claudeSlot.conflict` | 이 호스트에 다른 Claude 로그인이나 claude-auth 플러그인이 있어 쓰지 않습니다 |
| `own.remote.claudeSlot.fastLocal` | Fast 동의는 이 PC에 한 번 기록합니다 |
| `own.remote.quit.running` | 원격 호스트에서 세션 {count}개가 실행 중입니다 |
| `own.remote.quit.keep` | 원격은 그대로 두기 |
| `own.remote.quit.drain` | 원격도 현재 턴이 끝나면 중지 |
| `own.remote.quit.stopNow` | 지금 원격 중지(실행 중인 턴이 끊깁니다) |
| `own.remote.hostKey.trust` | 신뢰하고 연결 |
| `own.remote.elsewhere` | 다른 창에서 인증 중입니다 |
| `own.remote.symlink` | 심볼릭 링크 대신 실제 경로로 엽니다: {path} |
| `own.remote.forget.rotate` | 이 호스트를 더 믿지 않는다면 다음 API 키를 교체하세요 |

---

## 18. 이전 앱의 실패 모드와 대응

| 이전 앱 | 무엇이 깨졌나 | 이 설계의 대응 |
|---|---|---|
| 30 (`desktop-input-and-ssh-30.md:12`) | 가져오기가 auto-connect를 꺼 버림. pyenv 기본 Python 3.10만 보고 거절 | auto-connect 값을 그대로 가져온다(19장). 원격 Python·Node가 필요 없는 단일 바이너리 + `sh`/`tar`만. 셸마다 PATH가 다른 문제(비로그인 `sh`와 `.bashrc`의 nvm·pyenv)는 서비스 env를 사용자의 로그인 셸로 만들고, inspect가 셸 모드별 PATH 차이를 보이며, 연결 뒤 `agent.probe`로 도구가 실제로 보는 PATH를 확인해서 다룬다(5.4, 6.1) |
| 43 (`new-profile-ssh-43.md:5,19`) | 여유 약 300MB 호스트에서 475MB 런타임 설치가 일반 오류로 실패 | plan 단계의 공간 검사, `disk_full`·`noexec` 구분, 같은 버전 재사용(5.5) |
| 44 (`ssh-projects-and-delete-44.md:12-13`) | SSH 프로젝트가 한 프로필에만, 지운 작업이 되살아남 | 프로필이 없다(계정은 요청 단위 slot). 원격 DB가 원본, catalog는 연결마다 교체(12.3) |
| 55 (`ssh-selfheal-note-fork-usage-plugins-55.md:10,20`) | 정책 변경이 호스트를 영구 "pending"으로 막아 원격 목록이 사라짐 | 설정 변경은 연결을 막지 않고 "설정 대기"로만 표시(6.4) |
| 56 (`local-first-profile-startup-56.md:8,23`) | 원격 준비가 로컬 창을 막음 | local-first: 로컬 화면은 SSH를 기다리지 않음, 호스트별 배경 fiber(6.3) |
| 76 (`ssh-shared-records-and-note-images-76.md:7,11`) | 원격 작업이 목록엔 보이는데 `turn/start` 거절(읽기 전용 catalog) | 세션은 자기 서버에서만 실행. catalog는 표시 전용이고 열려면 라이브 연결 필요(12.3) |
| 77 (`ssh-updates-77.md`) | "Windows 업데이트 = 원격 업데이트"로 오해, 설정 변경이 업데이트처럼 취급 | 버전 셋을 따로 표시, 자동 확인만, 적용은 plan/execute(5.7, 6.4) |
| 79 (`ssh-reconnect-recovery-79.md`) | 새 helper 파일이 설정 변경으로 잡혀 리스너 재시작, 일부만 멈춤. 소켓 없음을 종료로 오판 | 작업 저널, 끊긴 stop 재생 금지, pid + `/proc/<pid>/exe`로 확인(6.4) |
| 82 (`ssh-reconnect-82.md:1,14,19`) | 한 호스트 실패가 프로필 전체를 막음, 기능 없음을 busy로 오판, 오래된 예약이 attach를 막음 | 호스트 격리, `incompatible`·`authentication`·`failed` 구분, 예약 없이 저널만(6.3) |
| 83 (`ssh-large-records-83.md:5-13`) | 52MB 턴 페이지가 32 MiB 브리지 한도를 넘어 전송이 죽고 재연결 반복, 전체 이력 1.08GB | 우리 브리지가 없으니 프레임 한도는 없지만, 느린 링크로 받는 양은 그대로다. 원격 서버는 첫 페이지 10개·이후 10개씩, 64 KiB 넘는 도구 출력과 이미지는 펼칠 때 받음, `session.export` 등 전체 이력 호출은 원격에 금지(12.5). 브로커 프레임 1 MiB, ensure 출력 상한 1 MiB. RG13에 큰 세션 사례 |
| 84 (`ssh-sidebar-cache-84.md:20-25`) | 보이지 않는 SSH 행을 지우지 않아 제목이 낡음 | catalog 통째 교체(epoch) |
| 87 (`ssh-settings-deferred-87.md:15-20`) | 옛 런타임에 idle 진단이 없어 무한 대기 | `GET /api/session/active`는 upstream 기본 API라 버전마다 있다. 조회가 실패하면 `update.plan`·`drain.plan`이 `activeSessions:null`을 돌려주고, UI는 "실행 중인 작업을 확인할 수 없음"을 보이며 `기다리기`(상한 있음)와 `지금 중지`만 준다. 무한 대기는 없다 |
| 89 (`profile-remote-drain-89.md:38-40`) | 전체 종료가 원격 리스너를 남겨 설정이 계속 미뤄짐 | 원격을 남기는 것이 기본이고 설계상 정상. 명시적 drain과 종료 대화상자(6.5) |
| 92 (`responsiveness-and-ssh-browser-92.md:10-11,117`) | `ssh_inventory` 15,051건으로 `state.json` 6.4MB, 상태 RPC 느림. 데스크톱 업데이트가 시작 명령 wrapper를 바꿔 SSH가 깨질 뻔 | 연결별 기록을 상태 파일에 쌓지 않음, 감사는 5분 합계, ops 저널 순환. 우리가 fork 전체를 소유하므로 wrapper 정규식이 없음 |
| 96 (`ssh-worktree-project-grouping-96.md:21,93`) | symlink로 등록한 프로젝트와 realpath 세션 cwd 불일치 | 항상 `agent.realpath` 결과로 연다(12.4) |
| 운영: 강제 재부팅 뒤 JSONL 끝줄 잘림 | 이력 수리 도구 필요 | 원격 세션 저장은 SQLite. spool 끝줄은 버림(6.6, 10.2) |
| 운영: dev-host 퇴역, alias가 새 하드웨어로 | host identity가 바뀜, 원본이 원격에만 | host identity 비교로 재온보딩, PID·소켓·락을 새 호스트에 복원하지 않음, 업데이트 전 원격 DB 백업(6.4) |
| 구조: 닫힌 앱 shim | 데스크톱 업데이트마다 정규식이 깨짐 | fork에서 직접 구현. shim 없음 |
| 70 Windows 스킬 브리지 | 역방향 HTTP 워커로 Windows 전용 스킬 실행 | 옮기지 않음. 스킬은 내용만 동기화하고 Windows 전용은 표시(13장) |
| 이 설계 고유: Windows에 ControlMaster 없음 | 명령마다 인증 | ensure를 터널 세션 안에 넣어 재연결 인증 1회(7.1), agent 권장(14.3), 배경 프롬프트는 pause |
| 이 설계 고유: 로컬이 꺼지면 원격 모델 호출 불가 | 원격 작업이 멈춤 | lease로 짧은 공백 흡수, 종료 대화상자로 미리 알림, lease 조절(8.5) |

---

## 19. 이전 앱 SSH 호스트 마이그레이션

### 19.1 현재 상태 (읽기 전용 확인, 2026-09-27)

- `~/.ssh/config`: Host 블록 7개. 값(HostName, User, IdentityFile 경로)은 읽지 않고 키 이름만 확인했다.

| alias | config 구조 | 이전 앱 | own으로 |
|---|---|---|---|
| `lab` | HostName, User, IdentityFile, IdentitiesOnly, ServerAlive | 8개 프로필 모두 binding | 가져오기 후보(기본 선택) |
| `work_linux` | HostName, User, IdentityFile | 8개 모두 binding | 후보(기본 선택) |
| `build-host` (한 Host 줄에 `dev-host`와 함께) | + IdentitiesOnly, StrictHostKeyChecking, ServerAlive | 8개 모두 binding | 후보(기본 선택). 앱이 쓴 이름은 `build-host` |
| `dev-host` | 위와 같은 Host 줄 | 퇴역한 Hyper-V VM의 이름 | 가져오지 않음(같은 기계를 두 번 등록하지 않음) |
| `aws_02`, `aws_03` | HostName, User, IdentityFile | 8개 중 6개 프로필의 `auto_prepare_aliases`에만, 준비된 적 없음 | 후보(기본 선택 해제) |
| `il_01` | HostName, User, IdentityFile | 쓰지 않음 | 목록에만 |
| `lab-7676` | + LocalForward, ExitOnForwardFailure | 수동 dev 서버 forward | 가져오지 않음. `forward_conflict` 대상이며 7.6 요청형 forward로 대신 |

- 근거: `[old] work/control-center/profiles/*/ssh-bindings.json`의 `bindings[].alias`와 `auto_prepare_aliases`(8개 프로필 확인).
- **이전 앱에 미뤄 둔 원격 설정이 남아 있다.** 8개 중 3개 프로필(`2b3c4d5e…`, `3c4d5e6f…`, `1a2b3c4d…`)의 `pending_policy_hosts`와 `deferred_policy_hosts`가 둘 다 `["work_linux","lab","build-host"]`다. 나머지 5개는 `pending_policy_hosts`가 비어 있다. 이전 앱이 세 호스트에 미룬 설정 적용과 원격 리스너를 아직 들고 있을 수 있다([old] 55·87·89). legacy plan은 호스트마다 이 상태를 보이고(19.2), 원격 정리 전에 이전 앱 쪽이 drain되었거나 멈췄는지 확인한다.
- **`lab-7676` 경고.** 이 alias의 `LocalForward`가 로컬 `127.0.0.1`이나 `localhost`에 묶여 있으면(bind 주소 값은 읽지 않음 ⚠), 그 dev 서버 페이지를 웹 폴백 own-web과 **같은 브라우저 프로필**에서 여는 순간 own-web의 로컬 pairing 쿠키가 원격 dev 서버로 간다(7.3과 같은 문제, 15장). 데스크톱 렌더러는 쿠키가 없어 이 경로가 없지만, 그 페이지는 로컬 서버 CORS 허용 origin(`http://127.0.0.1:*`)이 된다. own을 쓰기 시작하기 전에 다음 중 하나를 권한다(사용자가 직접 config를 고침).
  - `LocalForward`의 bind 주소를 `127.0.0.1`이 아닌 loopback으로 바꾼다(예: `LocalForward 127.0.9.3:7676 127.0.0.1:7676`, 번호는 own이 쓰지 않는 값).
  - 또는 7.6 요청형 forward(R3)를 쓴다. 데스크톱이면 원격 세션의 브라우저 패인에서 `localhost:7676`을 바로 연다(7.6, ⚠ 실측 전).
  - 또는 그 페이지를 웹 폴백 own-web과 다른 브라우저 프로필에서만 연다.
  - own-remote의 `hosts.discover`(파일 파서)가 bind 주소가 없거나 `127.0.0.1`·`localhost`인 사용자 `LocalForward`를 찾으면 호스트 추가 화면에서 이 경고를 한 번 보인다.

### 19.2 절차 (`own.remote.legacy.plan → execute`)

1. **읽는 것(읽기 전용)**: `ssh-bindings.json`의 alias와 auto_prepare 목록, 이전 앱 상태의 호스트 레코드에서 `{alias, autoConnect}`와 `host_identity`, 공유 프로젝트 레코드의 `remote-projects {hostId, remotePath, label}`(`[old] scripts/manager_core/shared_workspaces.py:82-116`). 이전 앱 파일에 쓰지 않는다.
2. **plan**: alias별로 `가져올 호스트`, `auto-connect`(이전 값 그대로, [old] 30), `원격 폴더 제안`(remotePath 목록), `이전 host identity`, **이전 앱의 미룬 설정 상태**(프로필별 `pending_policy_hosts`·`deferred_policy_hosts`에 들어 있는지)를 보인다. 들어 있으면 "이전 앱이 이 호스트에 미룬 작업이 있습니다. 이전 앱을 먼저 정리하세요"를 붙인다. own 설치와 경로가 겹치지 않으므로 가져오기 자체는 막지 않는다.
3. **execute**: 고른 alias마다 `hosts.add`만 한다. 원격에는 아무것도 하지 않는다. 원격 폴더 제안은 호스트의 "최근 폴더"에 넣는다(세션은 만들지 않음).
4. **첫 연결 때**: inspect의 host identity가 이전 값과 다르면 `host_identity_changed` 안내("이전 앱이 쓰던 기계와 다릅니다")를 한 번 보이고, 사용자가 확인하면 새 값으로 기록한다(dev-host → 새 하드웨어 경우).
5. **가져오지 않는 것**: revision, binding의 PID·소켓·락·`native-proxy` 기록, `remote_updates` 예약, 프로필별 자격 증명 파일, 원격 런타임. 새 호스트에 옛 프로세스 상태를 복원하지 않는다([old] MIGRATION 교훈).
6. **이전 앱의 원격 파일**(`~/.local/share/codex-control-center/…`, `/tmp/codex-control-<uid>/*.sock`)은 건드리지 않는다. 경로가 겹치지 않는다(우리는 `~/.local/share/own-open-code`, 짧은 소켓 디렉터리는 `/tmp/own-<uid>/…`). 정리는 R3의 별도 plan으로만 한다: 목록 표시 → 이전 앱이 로컬에서 꺼졌는지 확인 → **원격의 이전 앱 리스너가 drain되었거나 멈췄는지 확인**(미룬 설정이 있는 세 호스트는 특히, 위 19.1) → 사용자 확인. 리스너가 살아 있으면 정리를 거절한다.
7. **이전 세션**: Codex 스레드(원격 `~/.codex`, 이전 앱 catalog)는 가져오지 않는다. Codex 대화 이력 import는 01 §17의 **후속** 항목이다. 이전 앱의 Codex **로그인** 가져오기(linked/takeover)는 범위 안이지만 로컬 control-center 프로필만 대상이고(02 §3.2a), 원격 호스트의 `~/.codex/auth.json`이나 이전 앱의 원격 런타임은 대상이 아니다.
8. **스킬**: 이전 앱이 설치한 원격 네이티브 스킬(`~/.agents/skills/…`)은 원격 service가 호환 루트로 그대로 읽는다. 동기화는 이것을 `이미 있음`이나 `충돌`로 보이고 덮어쓰지 않는다(13장).

---

## 20. 테스트 계획

### 20.1 층

| 층 | 대상 | 방법 |
|---|---|---|
| 순수 로직 | target 파서(7.2의 거부 사례: `-F`, `ProxyCommand`, `IdentityAgent`, UNC·장치 경로, `%`·`$`, 개행·NUL), config alias·forward 표시 파서, `ssh -G` 출력 파서, askpass 프롬프트 분류(14.2), inspect·ensure 출력 파서(허용 목록, 노이즈 줄, 셸 모드별 env 표식), 등록 파일 선택(`service-own.json`만)과 실행 중 판정(6.1 6번), 버전·`proto` 비교, 백오프·pause 규칙, 브로커 프레이밍·HMAC 핸드셰이크·재생 방지·속도 제한·비`hello` 첫 프레임 거절, arm의 epoch 단조성, lease `ttlMs`·최소 유효 기간, 출처별 분기(vault·takeover는 refresh, linked는 재읽기와 `source_stale`, 호스트 단위 기억과 `ready` 풀림, 8.5·8.8), 유예 마감 계산(8.7), 미러 뷰 가림과 압축 설정 포함(원격 `Compaction.resolve` 결과 = 로컬, 9.2), `OwnRemote.MethodScope` 완전성(모든 메서드에 범위, 16.7), spool 상한·gap, ack 중복 제거, 시각 정규화와 관측 검증 규칙(10.5), 세션 토큰 서명(upstream `verifySession`과 교차 검증) | Node 22 `node --test`와 `bun test` 양쪽(01 §16) |
| vendored 테스트 | `ssh/{bootstrap,command,controller,askpass}.test.ts`, `remote/cli.test.ts` | upstream 테스트를 우리 변경에 맞춰 이식(4.3) |
| 플러그인 단위 | own-accounts `mode:"remote"`의 `model.request`·`retry`(유예, `source_stale`은 유예 없음), 원격에서 `accounts.*` → `remote_managed`, 전역 이벤트 미발행, 원격 generate·title·compaction 사용량 줄(10.1), 미러 압축 설정으로 등록한 `limit.input`, 원격 `compaction.due` 발행 | 01 §16의 가짜 PluginContext + 가짜 브로커 |
| 가짜 ssh | 컨트롤러 스테이지, 프롬프트 소유, pause, 재연결, 끊긴 업데이트 복구 | `ChildProcessSpawner` 모의(upstream 테스트 방식) + Windows용 가짜 `ssh.exe`(Node 스크립트: 종료 코드·stderr·지연 시나리오) |
| 실제 sshd 통합 | 20.3 게이트 | 20.2 환경 |
| 가짜 provider E2E | 원격 세션의 전환·한도·ledger 집계 | `own/tools/fake-provider`를 원격 쪽에서 실행하고 `compat` slot의 baseURL을 원격 loopback으로 둔다. codex·anth 경로는 테스트 빌드 전용 baseURL 재정의가 필요 ⚠ |

### 20.2 환경

- **이 PC에는 Docker와 WSL 배포판이 없다**(2026-09-27: `docker` 명령 없음, `wsl --status`가 WSL 미설치·비활성 안내). 선택지:
  - (a) WSL2 + Ubuntu 설치(사용자 동작, 가상화 필요) → WSL 안에 sshd(`localhost:2222`), 테스트 전용 사용자 두 명.
  - (b) 실제 호스트(예: `build-host`)에 **테스트 전용 OS 사용자**를 만들고(사용자 동작, root 필요) 그 계정으로만 시험. 사용자의 실제 서비스와 파일에 닿지 않는다.
  - (c) 원격 호스트의 Docker에서 sshd 컨테이너를 띄우고 `ssh -J`로 접근.
- 기본은 (b)로 시작하고, (a)가 준비되면 자동화한다. 이미지·스크립트는 `own/tools/remote-e2e/`(Dockerfile: debian-slim + openssh-server + Node 22 + fake-provider + 사용자 두 명).
- **라이브 opt-in 테스트**: `own/scripts/remote-live-test.ps1 -Host <alias>`. 원격 임시 루트(`~/.cache/own-open-code-test-<rand>`) 아래로 `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`을 돌리고(upstream 경로는 XDG env를 따른다, `packages/util/src/global-roots.ts:5-8`), 별도 포트와 브로커 epoch를 쓴다.
  - 원격 OWN_HOME, managed config의 플러그인 경로·옵션, `run/`, `owner.json`, spool, 미러는 모두 5.3처럼 **그 XDG 값에서** 계산하므로 함께 임시 루트로 간다. 짧은 소켓 디렉터리도 OWN_HOME 해시가 달라 실제 설치와 겹치지 않는다(7.4).
  - 테스트 스크립트는 시작 전에 계산된 경로 목록을 출력하고, 하나라도 실제 설치 경로(`~/.local/share/own-open-code` 등) 아래면 멈춘다.
  - 그러면 같은 own 채널 바이너리로도 DB·등록 파일·config·브로커 상태가 사용자의 실제 설치와 겹치지 않고, 실제 own·upstream 서비스를 재시작하지 않는다. 끝나면 임시 루트를 지운다([old] opt-in live test 관행).

### 20.3 게이트

| 게이트 | 필수 | 시나리오 | 통과 기준 | 실패 시 |
|---|---|---|---|---|
| RG1 플러그인 배치 | must | 로컬 순서 `[own.accounts, own.remote, own.team, claude-auth, own.telemetry, own.computer-use]`, 슬롯 설치·제거, Location 여러 개 열고 닫기, control location 외 모든 Location dispose, leader 교대, 로컬 service를 `TerminateProcess`로 강제 종료 | 슬롯 설치·제거, Location dispose, leader 교대 때 ssh.exe 재시작 0·중복 0. 강제 종료 뒤 60초 안에 고아 ssh.exe 0(stdin EOF로 스스로 끝남), 다음 기동의 정리 대상 0 | own-remote를 별도 프로세스로 |
| RG2 Linux 산출물 | must | own 채널 linux-x64-baseline·arm64 빌드(Windows 교차 또는 Linux 빌드 호스트) | 원격에서 `--version` = 로컬 버전, 채널 `own`(`service-own.json`, `opencode-own.db`). 2026-09-27: Windows 교차 빌드(`build-remote.ps1`)로 산출물·ELF 검사·해시·fake-SSH 설치 통과, 실제 Linux의 `--version`은 첫 호스트에서 확인(5.2) | Linux 빌드 호스트 절차 문서화 |
| RG3 설치·기동 | must | 빈 호스트, 여유 공간 부족, noexec HOME, **noexec `/tmp`**, upstream opencode가 PATH에 있는 호스트, 등록 파일은 있는데 pid가 죽음·pid 재사용, 응답 없는(hung) 같은 버전 서비스, `KillUserProcesses=yes`+linger 꺼짐, 서비스 설정 hostname을 `0.0.0.0`으로 바꿔 둠, `.bashrc`에만 nvm PATH가 있는 사용자 | 업로드 설치 성공, 부족·noexec는 전용 오류, `/tmp` noexec에서도 서비스 기동(TMPDIR), upstream 파일·서비스 변화 0, `service*.json` 중 우리 것만 읽음, 낡은 등록은 `version_skew`로 보고하지 않고 기동, hung은 `service_unresponsive` → `recover`로만 종료, KillUserProcesses 경고 표시, `service_not_loopback`, `agent.probe`가 셸 모드별로 기대한 PATH를 보고 | 스크립트 수정 |
| RG4 터널과 브로커 전송 | must | Win32-OpenSSH 9.5에서 `-L 127.0.<k>.2` + `-R` 스트림 소켓, 소켓 권한, 옛 소켓 잔재, 108바이트를 넘는 소켓 경로(`installRoot`), TCP 대체(원격 포트 충돌 포함), **FIN 없는 끊김**: 네트워크를 끊어(어댑터 비활성 또는 방화벽 차단) 터널을 죽이고 재연결한 뒤 옛 sshd 세션에 SIGHUP | 소켓 0600·다른 uid 접근 거부, 잔재 있어도 연결, 긴 경로는 짧은 디렉터리로, TCP 대체는 stderr 파싱 없이 동작, 옛 세션의 SIGHUP 뒤에도 **새 epoch 브로커 연결 유지**·새 소켓 존재, 옛 세션은 `broker.current` 확인으로 스스로 끝남 | TCP 대체를 기본으로, stdio relay 검토 |
| RG5 Windows 인증 | must | 암호문구 키(agent 없음/있음), 호스트 추가 때 처음 보는 호스트 키, 배경 재연결에서 처음 보는 키, 호스트 키 변경, 배경 재연결 중 프롬프트, 방화벽, `StrictHostKeyChecking no` 호스트 | 호스트 키 질문은 `hostKey`로 분류되어 지문이 가려지지 않고 입력칸이 없음(비밀번호 칸으로 나오면 실패), `신뢰하고 연결`을 누를 때만 `yes` 전송, 취소 기본 포커스, 배경의 모르는 키는 프롬프트 없이 `host_key`(`unknown`) pause, 변경 키는 pause, 프롬프트가 소유 탭에만(새로 고침 뒤에도 같은 탭), 방화벽 프롬프트 0, 느슨한 호스트는 경고 + 계정 없음 | UI·문서 보강 |
| RG6 브로커 fail closed | must | 턴 도중 터널 kill, lease 만료 전·후, 유예 끝, 브로커 복귀, 원격 시계를 ±10분 어긋나게 둠 | lease 만료 뒤 인증 헤더 있는 요청 0, **유예 중 원격 호스트 밖으로 나가는 provider 요청 0**(sink만, `http.request`·`ws.handshake` 재작성이 전송에 반영됨), 턴이 멈추기까지 `failClosedGraceSeconds + 15초` 이내, 복귀 시 같은 턴이 이어지고 도구 중복 실행 0, 시계가 어긋나도 lease 수명이 `leaseSeconds`와 같음 | 유예 끄기. 재작성이 안 되면 `model.request` baseURL 교체 |
| RG7 refresh 단일화 | must | (a) vault·takeover: Codex 토큰 만료 직전 로컬 세션 1 + 원격 호스트 2개 동시 요청, 원격 401 invalidate. (b) **linked**: 가짜 control-center(`packages/own-accounts/test/e2e-kit/fixtures/codex-multi-provider.ts`)의 linked 계정으로 원격 요청. 남은 수명 7분 미만 토큰, 원격 401 invalidate 반복(거짓 401 포함), 그 사이 가짜 이전 앱이 원본을 새 토큰으로 갱신 | (a) refresh HTTP 1회, `refresh_token_reused` 0, 원격에 refresh token 0. (b) **token endpoint 호출 0**, 원본 `auth.json`의 해시·mtime 변화 0(우리가 쓰지 않음), 짧은 토큰은 `source_stale`로 거절되고 원격 요청은 sink에서 끝남(provider로 나간 요청 0), 거짓 invalidate 뒤에도 로컬 세션은 계속 동작(로컬 reader 거절 0), 원본 갱신 뒤 1분 안에 그 호스트에 `ready` push와 새 lease | 브로커 직렬화 보강. linked는 원격 허용을 기본 `deny`로 |
| RG8 관측 집계 | must | 원격 턴 20개, 브로커 끊긴 채 10개 더, 로컬 재시작, spool 상한 초과, 원격 세션의 압축·제목 생성·generate(`/btw` 또는 warming) | 로컬 ledger 줄 수 = 원격 step 수 + compaction·title·generate 줄 수(gap 제외), 중복 0, `server` 필드, generate 줄의 `usageSource`, 한도 막대에 원격 관측 반영, gap 경보 | 스키마·ack 수정 |
| RG9 캐시·압축 동등성(원격) | must | 01 G4의 T1·T3a를 원격 세션에서, 같은 계정의 로컬 세션과 비교. 계정·kind 압축 설정을 바꾼 뒤 원격 세션을 기준 가까이 채움 | 원격 세션 둘째 step부터 `cache.read ≥ 0.9×직전 P`, 요청 헤더 집합이 로컬과 같음(인증 값 제외), identity part 해시 같음, 원격 등록 모델의 `limit.input` = 로컬 `ctx_eff`, 설정 변경이 `mirror.changed`로 원격에 반영되고 원격 자동 압축이 같은 기준에서 일어남, 원격 `compaction.due` → own-web이 같은 원격 서버에 `/compact` | 헤더·미러 점검 |
| RG10 비밀 위생(원격) | must | 15장 스캔 목록. arm 호출 전후의 원격 로그·OWN_HOME 전체 | 키·토큰 평문 0(원격 메모리 제외), 브로커 키가 원격 디스크·로그에 0 | 출시 차단 |
| RG11 skew·업데이트·drain | must | 로컬만 업데이트, **원격 턴이 진행 중일 때 로컬 업데이트**(install.ps1), 업데이트 도중 SSH 끊기, 롤백, `proto`가 바뀐 릴리스 | 버전 다르면 `service start` 호출 0, drain 전 stop 0, 로컬 업데이트 중·후에도 진행 중 원격 턴에 `broker_unavailable` 0(drain 모드), 턴이 정상 종료된 뒤 drain 완료, `proto` 비호환 릴리스는 install.ps1이 먼저 원격 세션을 묻음, 끊긴 뒤 저널로 이어가기·되돌리기, stop 재전송 0 | 절차 수정 |
| RG12 멀티 호스트·격리 | must | 호스트 3개 중 1개 인증 대기, 1개 설치 중. 모든 창을 닫은 채 원격 세션 생성·삭제(다른 클라이언트나 원격 TUI로), 원격 세션 2개 스트리밍 중 leader의 이벤트 구독 | 나머지 호스트와 로컬 세션 지연 0, 사이드바 catalog 표시, 창을 다시 열면 catalog에 생성·삭제가 반영됨(창 없이 갱신), 구독이 로컬 service CPU에 주는 부하가 측정 기준 이내 | 컨트롤러 구조 수정. 구독 비용이 크면 목록 주기 조회로 |
| RG13 own-web 멀티 서버 | must | **데스크톱과 웹 폴백 각각에서** 서버 2개 동시 스트리밍, 끝점 변경, 끊김 overlay, 원격 폴더 선택(symlink, 홈으로), 새로 고침(인증 프롬프트 중 포함), 데스크톱 창 2개, **큰 원격 세션**(도구 출력 수십 MB, 이미지 여러 장, 제한된 대역폭) | 라우트 유지, 초안 보존, 토큰이 localStorage·IndexedDB·URL에 없음, realpath로 세션 생성, `fs.list`가 control location으로만 불림(원격 홈에 Location 생성 0), 새로 고침 뒤 같은 탭·창이 프롬프트 소유 유지, 큰 세션 첫 화면 전송량이 페이지 상한 이내, 전체 이력 호출 0, 데스크톱에서 원격 요청이 `oc://renderer` origin으로 CORS 통과 | UI 수정 |
| RG14 무결성 | should | 거짓 관측(`exhausted`, 음수 토큰, 미래 시각) push | 로컬 세션 자동 전환 0, 거절 카운트 증가 | 규칙 보강 |
| RG15 마이그레이션 | should | 이전 앱 데이터로 legacy plan | alias 3개 기본 선택, aws 2개 해제, `lab-7676`·`dev-host` 제외, 미룬 설정이 있는 세 호스트 표시, 이전 앱 파일 변경 0 | 매핑 수정 |
| RG16 origin 격리 | must | 원격 API 터널, PTY WebSocket, dev forward를 가짜 원격 service와 가짜 dev 서버로 받아 요청 헤더 기록. dev forward 페이지(`127.0.<k>.3`)와 원격 끝점 페이지(`127.0.<k>.2`)에서 로컬 `http://127.0.0.1:P/api/*`를 fetch(쿠키 포함·Basic 토큰 포함), no-cors POST. **데스크톱**: 렌더러에서 원격 서버 호출, 원격 세션 브라우저 패인에서 원격 `localhost` dev 서버 열기 | 원격·forward 끝점으로 가는 어떤 요청에도 로컬 쿠키 `opencode_session_<P>` 0, **로컬 서비스 Basic 헤더 0**(데스크톱 main 주입이 원격 주소에 붙지 않음), 그 페이지의 로컬 API 호출은 CORS 거절이나 401, Edge·Electron에서 `127.0.0.1`·`oc://renderer` → `127.0.<k>.2` 호출에 사설망·로컬 네트워크 접근 프롬프트 0, Win32-OpenSSH `-L 127.0.<k>.2`가 bind됨, 패인 탭 요청에 렌더러 인증 0이고 트래픽이 원격 호스트에서 나감(05 D5 확장) | 출시 차단. bind가 안 되면 `loopback_unavailable` 유지(127.0.0.1로 물러나지 않음) |
| RG17 원격 프로젝트 플러그인 | must | 원격 임시 저장소에 `.opencode/plugins/x.ts`(unscoped `http.request`로 헤더 기록, runtime 싱글턴 탐색, 브로커에 헤더 요청)와 `AGENTS.md`·하위 폴더 `AGENTS.md`·프로젝트 스킬. `projectConfig` 세 상태(`instructions` 기본, `disabled`, `trusted`) | `instructions`(새 호스트 기본): 플러그인 로드 0, 헤더 노출 0, `untrusted_plugin` 경보 0, 요청은 lease 계정으로 200, `AGENTS.md`가 요청에 있고 프로젝트 스킬은 없다. `disabled`: 플러그인 로드 0, `AGENTS.md`도 없다. `trusted` + 미승인: 그 Location의 own 요청에 인증 헤더 0, `untrusted_plugin` 경보(01 G18과 같음), `AGENTS.md` 있음. 결과를 15장 문구와 대조 | 기본값 유지, `trusted` 전환 문구 강화 |
| RG18 원격 Claude 중계 | must | 실제 호스트 phase D 시나리오 D1–D13(`packages/own-remote/test/real-host/d-claude.test.ts`. 8.11.16의 사용자 결정 D1–D3과는 다른 번호): 두 번째 streamlocal -R 위 SSE·대용량 본문·취소·터널 끊김·MAC·401·429·Fast·하위 에이전트·TCP 모드 | 시나리오 D1–D13의 통과 기준 | TCP 모드 egress로, 그래도 안 되면 원격 Claude를 끈 채 출시 |
| RG19 SSH 대화의 브라우저 패인(SB) | must | 실제 호스트 단계 F(`f-browser.test.ts`): 쓰기 경로 아래(`/tmp/own-<uid>-rh-browser-*`)에 임시 HTTP 서버(`127.0.0.1`, 두 기기 모두 빈 포트), 진짜 셸의 SSH 대화 패인에서 `localhost:<포트>`, 이 PC만 가진 `127.0.0.1:<포트>` 페이지, 에이전트의 `tools.browser.tabs.open`·`snapshot`, `disconnect`와 `connect` | 호스트의 표시 문자열이 페이지에 보임(이 PC의 같은 포트는 거절), 이 PC 페이지 대신 `페이지를 열 수 없어요`(서버 이름 포함), 에이전트의 스냅샷에 표시 문자열, 끊긴 동안 `SSH 연결이 끊겼어요`, 다시 연결 뒤 페이지 다시 보임, 서버 프로세스와 임시 폴더 정리 | 출시 차단 |

**첫 실제 호스트 결과(2026-09-28, `dev-host` = Ubuntu 24.04.5 x86_64·glibc 2.39·OpenSSH 9.6p1, 클라이언트 OpenSSH_for_Windows_9.5p2, 릴리스 `2.0.18-own.1`).** opt-in 스위트 `packages/own-remote/test/real-host/`(`OWN_REAL_HOST=dev-host`)와 own-web `e2e/remote-real`. 모델 트래픽은 이 PC의 가짜 provider만(`ssh -R`로 호스트의 127.0.0.1에 노출), 원격 서비스의 `HTTPS_PROXY`는 이 PC의 sink로 두어 호스트 밖 https는 0건이었다. 끝나고 호스트 목록이 시작 전과 같음을 비교했다.
- 통과: RG1(서비스 `TerminateProcess` 뒤 ssh.exe 0.6초 안에 종료, 원격 keep 0, 다음 기동 정리 대상 0), RG2(`--version`), RG3(업로드 설치·실제 `service start`, `TMPDIR`에 네이티브 모듈, 죽은 pid·재사용 pid 등록은 `.stale`로 치우고 재사용된 프로그램은 죽이지 않음, hung → `service_unresponsive`로 멈추고 죽이지 않음, `0.0.0.0` → `service_not_loopback`, 셸 모드 `login-interactive`의 probe가 `.bashrc`에만 있는 PATH를 봄), RG4(스트림 소켓 0600, 옛 epoch 소켓 잔재, 원격 포트 충돌 뒤 TCP 대체, FIN 없는 끊김은 원격 sshd 세션을 SIGSTOP해 재현: 약 60초 뒤 새 epoch로 재연결, 옛 keep이 스스로 끝나고 나중의 SIGHUP 뒤에도 새 브로커 연결 유지), RG5(실제 문구의 `hostKey`·`passphrase` 분류와 지문 일치, 배경 시도의 모르는 키·바뀐 키 pause, 모든 리스너 loopback), RG6(lease 끝난 뒤 유예 45초에 47초로 멈춤·provider 요청 0, 유예 안 재연결로 같은 턴 완료, 시계 차이 약 -80ms 측정), RG9(원격 slot 한도 = 로컬 `ctx_eff`, 둘째 step부터 cache ≥ 0.99P, 헤더 이름 집합 같음), RG10(브로커 키·가짜 키·토큰이 원격 디스크·env·argv·ps·로그에 0), RG13·RG16(웹 폴백: 원격 폴더·세션·새로 고침, `127.0.1.2` 요청 81건에 쿠키 0·로컬 비밀번호 0, 그 origin에서 로컬 API 읽기는 CORS 거절), RG17(기본: 플러그인 로드 0·`AGENTS.md` 미포함, `trusted`+미승인: 로드되고 runtime 싱글턴 심벌은 보이지만 그 Location의 요청에 인증 0이고 호스트 밖으로 나가지 않음, `untrusted_plugin` 경고).
- 실제 호스트에서 재지 않은 것: noexec HOME·`/tmp`(허가된 경로에 noexec 마운트 없음), 디스크 부족, upstream opencode 공존(호스트에 없음), `KillUserProcesses=yes`+linger 꺼짐(이 호스트는 linger 켜짐), 108바이트 초과 소켓 경로(`~/.own-r`를 만들어야 함), 다른 uid 접근 거부(두 번째 사용자 필요), ±10분 시계 차이(root 필요), 비밀번호 프롬프트, RG7 (a)와 (b)의 원격 Codex 요청(원격 Codex 끝점이 chatgpt.com이고 Bun WebSocket이 `HTTPS_PROXY`를 따르지 않음: (b)는 fake-SSH에서 `linked-ws.test.ts`로 확인), RG8·RG11·RG12·RG14·RG15, 데스크톱(own-desktop)의 RG13·RG16, `recover.*`(R2, `not_supported`).
- 찾아 고친 것: ssh 자식 env에 `ProgramData`가 없으면 Win32-OpenSSH가 출력 없이 255로 끝남(14.4), own-web 새 세션 기본 모델이 계정이 사라진 own slot을 고름(`switcher/new-session.ts`).

**T3 실제 호스트 단계 `c-team`(06 T3.17, 2026-10-04–05).** opt-in 스위트에 `c-team.test.ts`(06 §11.3 TG17, 원격 TG2·TG3·TG4·TG11, 07 PG2 원격)와 `team-fixture.ts`가 더해졌다. 이 PC의 릴리스 서비스에서 터널로 호스트 서비스의 own.team을 부른다. 호스트에 만드는 것은 임시 루트 `/tmp/own-<uid>-team-<rand>` 하나(평범한 git으로 만든 F1 같은 코드 저장소와 F2 같은 LFS 저장소, bare `file://` 원격, 팀의 작업 폴더)와 5.3 설치 경로(`<OWN_HOME>/tools`의 git-lfs)뿐이고, `afterAll`이 루트를, `z-cleanup`이 설치를 지운다. 목록 스냅샷에 `~/.gitconfig`의 sha256(`== gitconfig`)이 더해져 전후가 같아야 한다. 기본 릴리스 버전은 T3 종료 빌드 `2.0.18-own.7`이다(`OWN_REAL_HOST_VERSION`, `OWN_REAL_HOST_RELEASE`). LFS 항목은 고정한 git-lfs(`tools.git-lfs`)가 든 릴리스가 있어야 하고, `OWN_REAL_HOST_TEAM_NO_LFS=1`이면 건너뛴다(개발 확인). 첫 실행은 git-lfs 없는 개발 릴리스(own.7 바이너리 + 이 트리의 플러그인 묶음)로 했다: `a-transport` 17·`b-stack` 15 pass, `c-team` 6 pass·5 skip(LFS 항목), `z-cleanup` 1 pass(`~/.gitconfig` 해시 같음, `/tmp/own-*` 0, 설치 경로 지움). 통과한 것: 원격 managed config의 own-team 3번, 도구 없는 LFS 저장소 켜기의 `lfs_missing`(영역 0, 필터 없음, TG17 순서), `[propose-reorg]`로 켠 코드 저장소 팀의 ff 반영과 올리기, 45초 검사 도중 ssh.exe 터널을 죽여도 호스트의 작업이 이어져 재연결 뒤 끝남, `/srv/<hostId>`의 읽기 전용 기기에서 `team.get` 200과 `op.confirm`·`integration.push.*`·`settings.set` 403(`local`), 07 PG2 원격(02 대상이 빠진 미러, `same_company_subscription`, 원격 `presets.set`의 `remote_managed`, 02 요청 0). LFS 항목(`hosts.tools.ensure`, own 필터로 켜기, 담당 셸 커밋의 포인터, TG4, TG11의 `push-lfs`)은 T3 종료 빌드로 T3.20이 돈다.

---

## 21. 단계

SSH 원격은 완성 범위에 들어간다(사용자 요구: Codex 앱·Claude 앱처럼 SSH 프로젝트가 당연히 되어야 함, 결정 D8). 단계 이름은 01 §17의 P0–P8을 따른다. **이음매는 P2·P3에** 넣고, 본체 R0–R3은 **P6**(P5 필수 기능 1–16과 네이티브 브라우저 뒤)에 한다. 이전 판의 "MVP(Phase 2)에 이음매, Phase 2 직후 R0–R3"을 이것으로 바꾼다. 이전 판의 "Phase 3"은 01의 **후속**이다.

**미리 넣을 이음매** — 나중에 크게 고치지 않기 위해서다. 넣는 단계는 01 §17 표와 같다.

| # | 이음매 | 단계 |
|---|---|---|
| 1 | own-web 데이터 층을 서버 목록 추상화로 만든다(`local` 하나만 있어도). 라우트의 serverKey는 03 §3에 이미 있다. `baseUrl`은 경로 접두어(`/srv/<serverKey>`)를 허용한다(12.1, 05 M0) | P3 |
| 2 | own-accounts의 자격 증명 백엔드를 인터페이스로 둔다: `vault` / `linked` / `broker`. `buildRequestHeaders`를 로컬·원격 공용으로. 출처별 refresh 분기(8.5)를 이 인터페이스에 둔다 | P2 |
| 3 | `LedgerLine.server`, `LimitWindow.origin` 필드를 v1에 optional로 넣는다 | P2 |
| 4 | 전역 이벤트 발행을 "leader이고 `mode:"local"`일 때만"으로 쓴다 | P2 |
| 5 | 플러그인 순서 2번 자리를 own-remote용으로 비워 둔다(설치기·`opencode.jsonc.example`, 01 §4) | P2 |
| 6 | 원격 기동 전제인 가드 1에 `OWN_REMOTE` 분기를 둔다 | P2 |
| 7 | own-accounts의 `retry` 훅과 `http.request`·`experimental.ws.handshake` 훅 등록 자리를 원격 sink(8.6)도 쓸 수 있게 둔다 | P2 |
| 8 | 압축 기준 계산을 `@own/protocol`의 `Compaction.resolve`(02 §4.7.6)로만 하고 입력을 레지스트리·policy 값으로 한정한다. 원격이 미러로 같은 값을 계산하는 전제다(9.2) | P2 |
| 9 | generate 사용량 읽기(02 §7.5)를 `mode`와 무관한 코드로 둔다(원격도 같은 코드, 10.1) | P2 |

- 01 §17의 P2 행은 지금 "04 §21의 2–4, 6, 7"만 적고 있다. 5는 01 §4가 이미 반영했고, 8·9는 02 v0.3의 P2 범위 안이다. 01 표 문구를 이 표에 맞추는 것은 22장.

**P6 안의 단계**(01 §17 "P6 SSH 원격 R0–R3", 9–11주)

| 단계 | 기간(1인, 대략) | 내용 | 종료 기준 |
|---|---|---|---|
| **R0 준비** | 1주 | Linux 산출물 빌드(RG2), 번들·manifest, `@own/protocol`의 `own.remote`(16.7 범위표 포함)와 브로커 스키마(`source_stale`, `account.status.scope`), vendoring과 ledger 항목, check-surface 항목(데스크톱 main 주입 조건 포함, 4.4) | RG2 통과, vendored.yaml·check-surface 갱신 |
| **R1 첫 원격 세션** | 4–5주 | own-remote(수동 연결·설치, 터널 세션 안 ensure, 호스트 loopback 주소, 로그인 셸 env와 `agent.probe`), askpass UI(프롬프트 분류, 호스트 키 정책), 브로커(스트림 소켓, arm, lease `ttlMs`, 출처별 refresh·linked `source_stale`, 상호 인증, `proto`), sink fail closed, own-accounts remote mode(미러 압축 설정 포함), 원격 프로젝트 설정 기본 끔, 미러, 관측 push(spool 없이 즉시 전송, generate 사용량 포함), 세션 토큰 직접 서명, own-web 멀티 서버(데스크톱·웹 폴백)·사이드바 그룹·폴더 선택·overlay·원격 페이지 크기. 이어서 원격 세션의 브라우저 패인(05 DS2 확장) | RG1, RG3–RG7, RG9, RG10, RG13, RG16, RG17 통과. 실제 호스트 1개(`lab`)에서 1주 사용 |
| **R2 견고성** | 2–3주 | 자동 재연결·autoConnect, 원격 이벤트 구독과 catalog(12.3), spool·ack·gap, skew 감지와 drain 모드·drain 업데이트·롤백·저널, install.ps1의 원격 세션 확인, 종료 대화상자, 멀티 호스트, 계정·호스트 범위, 토큰 무효화, `calibration.updated`, 시계 차이 경고, `recover` | RG8, RG11, RG12, RG14 통과 |
| **R3 동기화와 이전** | 2주 | 스킬 동기화, legacy import, 요청형 port forward, musl 대상, 이전 앱 원격 파일 정리 plan, ~~원격 MCP 설정~~(13.1 `SSH 호스트에 설치`로 닫음, MH 2026-11-26), `systemd --user`(선택) | RG15, 동기화 충돌 시나리오 통과 |
| **R4 선택** | – | 로컬 egress 게이트웨이(8.1 안 C, Claude 밖의 계정), macOS 원격, 여러 PC 공동 관리 | 기능별 결정(01의 후속) |

- **P6 뒤의 원격 관련 일.** 휴대폰에서 원격 세션(게이트웨이의 `/srv/<hostId>` 중계, 16.7 범위 강제, 12.7)은 01 P8(05 M1)이고 MG5가 종료 기준이다. 원격 세션의 푸시 알림(피드, 16.8)은 후속(05 M2)이다.

---

## 22. 다른 문서와 맞출 것

2026-09-27 v0.3 기준으로 다시 정리했다. 이전 판(v0.2) 목록 중 01·02·03·FORK가 이미 반영한 것은 "반영됨"으로만 남기고, 남은 것과 이번 판에서 새로 생긴 계약을 적는다.

**01-architecture.md**
- (반영됨) §0-19·§1.2(SSH 완성 범위, 04 기준), §3 구성도(own.remote 2번, 브로커, `-L/-R`), §4(패키지 표의 `own-remote`, 플러그인 순서, 빌드 id, `locks\remote-controller.lock`, 이음매 5), §5.1(`remote\…`, `app\<ver>\remote\*.tar.gz`), §5.5(install.ps1의 원격 확인), §6.1 원격 행(렌더러가 토큰을 직접 붙임, 쿠키 논거는 웹 폴백만), §10.2(computer-use 5번 자리), §11(D8 표, main은 SSH 없음, 모바일은 게이트웨이), §13 표(네트워크·비밀 사용·프로젝트 플러그인), §15(RPC id 둘), §16.4(RG1–RG17, G14 원격 스캔), §17(P6 = R0–R3).
- §8.4 "SSH 브로커와의 관계"의 ⚠와 §20 29번을 닫는다: linked 계정은 원본을 다시 읽기만 하고(token endpoint 0), 남은 수명이 `5분 + 120초` 미만이거나 원격이 거절을 알린 토큰이 그대로면 lease를 `source_stale`로 거절한다. 거절은 그 호스트에만 걸리고(`account.status.scope:"host"`) 로컬 계정 상태는 로컬 조건으로만 바뀐다(8.5, 8.8).
- §17 P2 행의 "04 §21의 2–4, 6, 7"을 21장 표에 맞춰 "2–9"로(5는 §4에 이미 있음, 8·9는 압축 계산과 generate 사용량의 모드 무관 코드).
- §10.1·§3 구성도·§20 25번: 브라우저 도구의 도구 목록 안정성은 05 §8.7(세션 생성 때 capability로 `browser` 권한 새김)을 따르고, 원격 managed config는 `-opencode.browser`를 넣지 않는다(7.6). 01의 "설치 프로필이 web이면 `-opencode.browser`" 문구와 05 §8.7이 다르므로 01·05가 하나로 정한다(24장).
- §11 표: "원격 이벤트 구독(catalog·원격 피드)" 행 추가. 위치는 로컬 service의 own-remote leader(12.3). 창이 닫혀 있어도 돈다.
- §6.4·§6.5: 원격 세션의 게이트웨이 중계 규칙(`agent.*`·`resolve` 차단, 토큰은 게이트웨이가 넣음)과 `own.remote` 범위표는 04 §12.7, §16.7을 가리킨다.

**02-accounts-providers-cache.md**
- (반영됨, 02 Q35) `remote` 계정 필드, `LedgerLine.server`, 원격 경보 6개, `remote_managed`, "원격은 vault 없음", RPC id 둘, `health.mode`, 보정 push.
- (04가 기준으로 남음, 02 Q35) §2.3 원격 OWN_HOME 내용, §2.4.3 `policy.remote`, §4.1 원격 `model.request` 경로(04 §8.6)와 `retry` 유예(04 §8.7), §9.1 control location 대체 규칙의 원격 예외(04 §16.6), `ledger.session{server}`, `accounts.usage{groupBy:"server"}`.
- §3.5의 lease 최소 유효 기간은 **출처별**이다: vault·takeover는 먼저 refresh, linked는 재읽기 뒤 `source_stale`(04 §8.5). §3.2a "원격 lease와의 관계"의 ⚠와 Q21·Q32를 닫는다. 새 브로커 오류 `source_stale`과 `account.status.scope:"host"`는 브로커 프로토콜(04 §8.4)이라 `own.accounts` RPC 목록은 바뀌지 않는다.
- Q33(미러에 압축 설정) → 04 §9.2에 반영: `accounts[].compaction`, `policy.compaction.byKind`, 원격 `Compaction.resolve`, `compaction.due`는 원격 서버가 냄. 02 §4.7.4 "재조정"에 "원격은 `mirror.changed`로"를 한 줄 더한다.
- Q34(원격 generate 사용량) → 04 §10.1에 반영.
- Q39(`own.remote` 범위표) → 04 §16.7(`OwnRemote.MethodScope`, 02와 같은 어휘). §9.1의 "같은 범위표를 `own.remote`에도 둘지는 04·05가 정한다"를 16.7을 가리키게 고친다.
- `accounts.update{compaction, dryRun}`의 `compactionImpact`가 원격 세션을 세지 않는 한계를 적는다(24장).

**03-ui-ux.md**
- (반영됨, 03 18.16) 사이드바 서버 그룹, 폴더 선택기, 세션 헤더 서버 배지, 상태 표, `own.remote.*` 문구, 설정 > 원격 호스트, 데이터 층 서버 목록, 페이지 크기.
- 이전 판의 "own-web 창은 전용 브라우저 프로필(`--user-data-dir`)로 띄우고 dev forward는 그 프로필 밖에서" 항목을 바꾼다. 데스크톱은 dev forward를 `openExternal`(시스템 브라우저)로 열고, 원격 dev 서버는 원격 세션의 브라우저 패인에서 포트 전달 없이 볼 수 있다(7.6, 05 §8.6). 전용 프로필 규칙은 웹 폴백에만 남는다(03 Q25와 같은 결론).
- 새 문구 `own.remote.devForward.pane`, `own.remote.lease.sourceStale`(17.9)과 세션 상태 행 "linked 계정이 이 호스트에서 막힘"(17.7).
- 문맥 막대: 원격 세션은 그 원격 서버의 `cache.state.compaction`을 쓴다(12.6). `compaction.due`는 같은 원격 서버로 `/compact`.
- 03 Q25의 "휴대폰이 원격 호스트 세션을 PC 서비스를 거쳐 보는 중계 경로"는 04 §12.7이 정했다.
- catalog는 own-remote가 쓰므로 own-web은 `catalog.put`을 부르지 않는다(12.3). own-web의 첫 화면 세션 목록 캐시(01 §6.3)는 그대로다.

**05-desktop-and-mobile.md**
- (반영함) 05 §17의 04 목록: 0-3·4.3의 import 문구, 4.1 대안 표의 "own-desktop main" 행과 기각 이유 넷, 7.3·12.1의 쿠키 논거 범위(웹 폴백만), 7.6 원격 세션 패인, 12.1 `baseUrl` 경로 접두어, 16장 M1+ 메서드·이벤트·오류(16.8), 원격 스트림 구독 재검토(12.3에서 구독으로 결정), 12.3 보관 API 정정.
- §13.5 표의 `host.list`는 `hosts.list`다. 같은 표의 `own.remote` 조회는 16.7의 `read` 행 전체(`hosts.list`, `catalog.get`, `portForward.list`, `feed.*`, `push.*`)로 맞춘다.
- §13.6 표 "만드는 곳"의 ⚠(04 §24-27)와 §19 24번을 닫는다: own-remote leader가 연결된 호스트의 `/api/event`를 구독한다(04 §12.3). `incompatible`·drain 호스트는 구독하지 않는다.
- §13.4 게이트웨이: `/srv/<hostId>`에서 `/api/rpc/own.remote/agent.*`를 항상 막는 경로에 더하고, `host.prompt`·`device.pairing.pending` 이벤트 프레임을 기기 스트림에서 거르는 규칙(16.7)을 정한다.
- §13.5 기기 범위와 02·04의 메서드 범위 어휘(`read/drive/manage/local`)의 대응을 정한다(24장).
- `push.register`·`push.unregister`가 기기에서 부르는 메서드(범위 `read`, 기기에 묶임)인지 확정한다(16.7 ⚠).

**FORK.md**
- (반영됨) §1 레이아웃(`packages/own-remote/`, `own/tools/remote-e2e/`), §7 vendor 종류와 own-remote 항목.
- 남은 것: `own/scripts/remote-live-test.ps1`(§1), vendored 항목의 `local_changes`에 parser 축소(`-F`·`proxycommand`·`identityagent` 제거, UNC 거부)와 `ssh -G` probe 제거(4.3), §8.2 Linux 대상 빌드 단계, §8.3 manifest `remote_artifacts`(5.2).
- check-surface 입력에 4.4의 두 행(데스크톱 main의 Basic 주입 조건, 브라우저 패인의 loopback 경로)을 더한다.

**T3 반영 현황(2026-10-04, 06 T3).** 06 부록 A의 04 항목(§4.1 원격 managed config의 own-team 3번과 `REMOTE_PLUGINS`, §5.2 정적 git-lfs, §16 `hosts.update{pathPrepend}`의 git-lfs 사용, 게이트웨이 `own.team` 분기)을 이 문서에 반영했다: 4.1 원격 순서, 5.2 도구 파일과 manifest `tools`, 5.3 레이아웃의 `presets.json`·`tools/git-lfs/`, 5.6 managed config의 플러그인 셋과 `pathPrepend`, 6.7 `forget`이 지우는 `tools/`와 남은 필터 문제, 9.2 미러의 프리셋, 12.3 이 빌드의 구독 상태와 좁은 팀 구독, 12.7 원격 팀의 범위, 16.2 `hosts.tools.ensure`, 16.4 `tool_hash_mismatch`, 16.7 `manage` 행, 16.8 `team.decision`의 출처. 다른 문서: 05 §13.5·§13.6, FORK §1·§8.2·§8.3·§10, USER-GUIDE 10.3, own-remote `ARCHITECTURE.md`. 실제 호스트 확인(TG17, 원격 TG2·TG3·TG4·TG11)은 06 T3.17이다.

---

## 23. 근거 파일 색인

**upstream (로컬 소스, `D:\own-open-code`)**
- SSH 데스크톱: `packages/desktop/src/main/ssh/{command,bootstrap,controller,askpass,service}.ts`, `packages/desktop/src/main/remote/cli.ts`, `packages/desktop/src/main/service/desktop-cli.ts:52-88`, `packages/desktop/package.json`
- askpass CLI: `packages/cli/src/index.ts:19-22`, `packages/cli/src/ssh-askpass.ts`(특히 `:26`의 `confirm` 판정)
- 서비스: `packages/client/src/effect/service.ts:50-154`, `packages/client/src/service-contender.ts:17-41`, `packages/cli/src/server-process.ts:55-184`(특히 `:110-112` 프로젝트 설정 끄기), `packages/cli/src/services/{service-config,service-registration}.ts`, `packages/cli/src/commands/handlers/service/{start,restart}.ts`, `packages/cli/script/build.ts:25-63`
- 서버 인증: `packages/server/src/{auth,pairing,cors}.ts`(쿠키 범위 `auth.ts:57-60`, 토큰 서명 `auth.ts:39-66`, CORS 허용 목록 `cors.ts:11-20`), `packages/server/src/handlers/server.ts:27-50`, `packages/server/src/middleware/authorization.ts:31-90`, `packages/server/src/event-feed.ts:8`
- API: `packages/protocol/src/groups/{session,fs,server}.ts`
- 플러그인·훅: `packages/core/src/session/model-request.ts:258-280`, `packages/core/src/session/runner/retry.ts:30-120`, `packages/core/src/session/runner/step.ts:174-186`, `packages/plugin/src/promise/session.ts:72-150`, `packages/core/src/rpc.ts:35-45,108-112,177`, `packages/core/src/plugin.ts:108-139`
- 셸과 PTY: `packages/core/src/shell/select.ts:164-169`, `packages/core/src/shell.ts:278`, `packages/core/src/pty.ts:167`
- 경로와 설정 탐색: `packages/util/src/global.ts:12`, `packages/util/src/global-roots.ts:5-8`, `packages/core/src/config/discovery.ts:25-80`
- 스킬: `packages/core/src/config/plugin/skill.ts:76-95`, `packages/core/src/config/plugin/compatibility.ts:36-56`
- app(참고만): `packages/app/src/servers/ssh/*`(특히 `dialog.tsx:80-91`, `restore-state.ts:9-16`), `packages/app/src/runtime/server/{registry,runtime,health,scope}.tsx`, `packages/app/src/workspaces/selection/policy.ts:4-7`, `packages/app/src/providers/connect/remote.tsx:5-30`, `packages/desktop/src/renderer/ssh/connections.ts`
- 데스크톱 셸 경계(own-desktop이 재사용하는 upstream main): `packages/desktop/src/main/service/sidecar-credentials.ts:20-30`(Basic은 로컬 서비스 origin에만), `packages/desktop/src/main/windows/security.ts:34-58`(주입 URL 필터와 top frame 조건), `packages/desktop/src/main/windows/headers.ts:4-20`(렌더러 session 응답의 CORS 헤더), `packages/desktop/src/main/windows/scheme.ts:4-24`(`oc://renderer`), `packages/desktop/src/main/ipc.ts:28`(Ssh 레이어가 `Ipc.layer`에 묶임), `packages/desktop/src/main/ssh/service.ts:32`, `packages/desktop/src/main/browser-pane.ts:84-97`(패인 partition, 같은 기계 판정), `packages/desktop/src/main/browser/network.ts:15-50`(패인 트래픽은 서버 터널, loopback 포함), `packages/desktop/src/main/remote/cli.ts:71`(upstream은 npm에서 CLI를 받음), `packages/server/src/event-feed.ts`(서버 전체 이벤트 스트림, 구독자당 4096)
- own(구현됨, `ba9ed4e9dd` 이후 작업 트리): `packages/own-runtime/src/codex-source.ts:236-378`(linked reader: stat 간격, 만료 여유 60초, `reject()`), `packages/own-runtime/src/credentials.ts:27-28,168-182,262-268`(`source_stale`, 401 처리, linked는 refresh 안 함), `packages/own-protocol/src/account.ts`(`Account.Status`), `packages/own-protocol/src/rpc.ts`(`account.status` 이벤트의 `reason`), `packages/own-protocol/src/alert.ts:27`(`codex_source_stale`), `packages/own-accounts/test/e2e-kit/fixtures/codex-multi-provider.ts`(RG7 (b)의 가짜 control-center)

**사전 조사 (세션 scratchpad `C:\Users\<user>\AppData\Local\Temp\claude\D---Projects-own-open-code\74c66f49-5311-4cce-aef8-61a4ee203508\scratchpad\`)**
- `desktop_verdict.md` §0 #7·#14·#17(Ssh 레이어 비활성, upstream은 npm CLI 설치), §6 "04" 항목(import 문구 정정, main에서 SSH 기각 이유 넷, 7.6 패인, 쿠키 논거 범위). 05가 이 결론을 기준 문서로 옮겼다

**이전 앱 (`D:\#Projects\codex-multi-provider`)**
- 설계: `docs/design/{desktop-input-and-ssh-30,new-profile-ssh-43,ssh-projects-and-delete-44,ssh-selfheal-note-fork-usage-plugins-55,local-first-profile-startup-56,windows-skills-over-ssh-70,ssh-shared-records-and-note-images-76,ssh-updates-77,ssh-reconnect-recovery-79,ssh-reconnect-82,ssh-large-records-83,ssh-sidebar-cache-84,ssh-settings-deferred-87,profile-remote-drain-89,responsiveness-and-ssh-browser-92,ssh-worktree-project-grouping-96}.md`
- 운영: `docs/operations/{ssh-host-onboarding,ssh-crash-history-recovery,ssh-native-skills,ssh-plugin-publication}.md`, `docs/MIGRATION.md`
- 코드: `scripts/manager_core/remote.py:57,96,155,175-177`, `scripts/manager_core/proxy_auth.py:1-11,60-91`, `scripts/manager_core/shared_workspaces.py:82-116`
- 데이터(읽기 전용, 구조만): `work/control-center/profiles/*/ssh-bindings.json`(`bindings[].alias`, `auto_prepare_aliases`, `pending_policy_hosts`, `deferred_policy_hosts`)

**이 PC에서 확인한 것 (2026-09-27, 값 없이 구조만)**
- `C:\Windows\System32\OpenSSH\ssh.exe` = OpenSSH_for_Windows_9.5p2, PATH의 첫 `ssh`
- `ssh-agent` 서비스: Stopped, Disabled
- `%USERPROFILE%\.ssh\config`: Host 블록 7개, `Match` 없음, forward는 `lab-7676`에만. `known_hosts` 33줄
- Docker 없음, WSL 배포판 없음

---

## 24. 미확인/열린 질문

**검증이 필요한 사실**
1. Windows에서 own 채널 Linux 바이너리를 교차 빌드할 수 있는가(네이티브 선택 의존성). RG2.
2. Win32-OpenSSH 9.5 클라이언트의 원격 streamlocal forward(`-R <원격 소켓>:host:port`). RG4.
3. Windows가 `127.0.<k>.2` 같은 `127.0.0.1` 밖의 loopback 주소 bind를 추가 설정 없이 허용하는가, Win32-OpenSSH `-L`이 그 주소에 bind하는가, Edge가 `127.0.0.1` 페이지에서 그 주소로 가는 fetch·WebSocket에 사설망·로컬 네트워크 접근 프롬프트를 띄우지 않는가. 안 되면 원격 연결은 `loopback_unavailable`로 멈춘다. RG16.
4. Codex access token 수명과, 같은 토큰을 서로 다른 IP(로컬·원격)에서 동시에 쓸 때의 제약. RG7, RG9.
5. `http.request` 훅이 교체한 Request와 `experimental.ws.handshake` 훅이 바꾼 `url`이 실제 전송에 쓰이는가(8.6 sink). 안 되면 `model.request`에서 baseURL을 바꾼다. RG6.
6. 모든 Location이 dispose되어 runtime 참조 카운트가 0이 되는 경우가 있는가. 프로세스 수명 런타임에서도 이 경우 터널을 닫는다. RG1. (2026-10-28: 있었다. 세션이 없는 control location을 core LocationActivity가 부팅 61분 뒤 정리했다. P-037로 control location을 상주시킨다, 결정 RH-9·RH-13.)
7. Windows ssh-agent가 named pipe로 `SSH_AUTH_SOCK` 없이 동작하는가. `aws_02`, `aws_03`, `il_01`의 키에 암호문구가 있는가(lab·work_linux·build-host는 이전 앱의 `BatchMode=yes` 운영으로 프롬프트 없음이 간접 확인됨, 14.3). RG5.
8. 원격 `GET /api/fs/list`와 `GET /api/location`이 symlink를 해석하는가. 해석하지 않으면 `agent.realpath`만 쓴다(설계는 이미 그렇게 함).
9. 원격 service의 SIGTERM 종료에서 Effect finalizer가 도는지, 진행 중 턴의 재개 동작이 Windows와 같은지. RG11.
10. `BUN_BE_BUN=1`로 컴파일된 바이너리가 번들 JS를 실행할 수 있는가(stdio relay 대체안). RG4 후속.
11. 원격 테스트 빌드에서 codex·anth slot의 baseURL을 fake-provider로 돌리는 방법(테스트 전용 재정의). 20.1.
12. 사용자 호스트의 logind `KillUserProcesses`와 linger 값, `/tmp` 마운트 플래그. inspect가 보고한다. RG3.
13. `OPENCODE_CONFIG_PROJECT_DISABLE=1`이 프로젝트의 `AGENTS.md` 같은 지시 파일 로드도 끄는가. 끈다면 원격 기본값의 사용성 비용이 커지므로 호스트 추가 문구를 고친다. RG17. **(닫힘, 2026-11-20)** 끈다. 그래서 지시 파일만 읽는 가운데 상태 `instructions`를 두고 새 호스트의 기본값으로 삼았다(5.6, HPC).
14. upstream 서버의 HTTP 요청 로그가 RPC 요청 본문(`agent.broker.arm`의 키)을 남기지 않는가. 남기면 arm을 본문 대신 브로커 소켓의 첫 프레임으로 옮긴다. RG10.
15. `@opencode/client`가 서버별 메시지 페이지 크기와 큰 part 지연 로드를 허용하는가(12.5). RG13.
16. `lab-7676`의 `LocalForward` bind 주소(값을 읽지 않았다). `127.0.0.1`이나 생략이면 19.1 경고 대상이다. `build-host` 블록의 `StrictHostKeyChecking` 값도 같다(7.2).
17. 이전 앱이 `pending_policy_hosts`·`deferred_policy_hosts`에 남긴 세 호스트의 원격 리스너가 지금도 떠 있는가(19.1). R3 정리 전에 확인한다.

**사용자 결정이 필요한 것**
18. **이전 01 §11 정책 변경 승인**: 원격 메모리에 lease로 access token·API 키를 보내는 것(8.1 안 B). 이전 앱의 SSH 인증 프록시가 같은 방식(현재 access token과 account id만, refresh token 없음, 만료가 가까우면 fail closed)으로 lab·work_linux·build-host에서 이미 쓰였다(8.1 선례). 반대하면 안 C(egress 게이트웨이)를 R1으로 당겨야 하고, 스트리밍이 SSH에 묶인다.
19. **(닫힘, 2026-10-09) 원격 Claude 구독**: 안 C(PC egress 중계)로 지원한다(8.11). 대가는 PC가 켜져 있고 터널이 살아 있어야 하며, SSH가 끊기면 진행 중 응답이 끊긴다는 것이다(사용자 결정 D1, 8.11.16).
20. **원격 프로젝트 설정 기본값**: `trusted`가 아니면 원격 저장소의 `.opencode` 플러그인·에이전트·명령·프로젝트 스킬·프로젝트 MCP가 보이지 않는다(13장). 믿는 저장소만 여는 호스트는 `trusted`로 켤 수 있다. **(닫힘, 2026-11-20, HPC)** 새 호스트의 기본값은 저장소의 `AGENTS.md`만 읽는 `instructions`다. 예전 기본값 `disabled`에서는 `AGENTS.md`도 읽지 않아, SSH 호스트에서 주로 일하는 사용자가 저장소 지시가 적용되지 않는 것을 뒤늦게 알았다. 이미 등록된 호스트는 저장된 값을 그대로 둔다.
21. 기본 `leaseSeconds`(900초)와 끊김 유예(300초). 로컬을 끈 뒤에도 원격 작업이 오래 돌기를 원하면 늘리고, 노출을 줄이려면 줄인다.
22. 호스트별 기본 계정 범위: "모든 계정"(제안) 대 "구독 계정만". ChatGPT access token의 범위가 Codex보다 넓다는 점(15장)을 감안한다.
23. 테스트 환경: WSL2 설치 또는 `build-host`에 테스트 전용 사용자 생성(둘 다 사용자 동작).
24. ssh-agent 활성화 여부(시스템 설정이라 사용자가 직접).
25. `lab-7676` forward를 바꿀지(19.1의 세 가지 중 하나, 사용자가 직접 config 수정).

**설계 판단을 남긴 것**
26. 원격 `own.remote` agent 모드: realpath·상태·probe·arm을 위해 원격에 두 번째 플러그인을 싣는다. SSH 명령으로 대신하면 Windows에서 인증이 한 번 더 들어 UI가 느려지므로 이쪽을 택했다.
27. **(v0.3에서 바꿈) catalog는 own-remote leader가 원격 이벤트 스트림을 구독해 쓴다**(12.3). v0.2는 "own-web이 쓰고 own-remote는 구독하지 않는다"였다. 데스크톱 창이 닫혀 있어도 휴대폰의 오프라인 목록(05 §13.7)과 원격 세션 알림 피드(05 §13.6, 05 §19 24번)가 갱신되어야 하므로 바꿨다. 대가는 호스트당 SSE 하나와 목록 조회, 그리고 own-remote가 원격 이벤트 스키마에 기대는 것이다. 정상 모드(버전 일치)에서만 구독해 스키마 차이를 피한다. 스트리밍 텍스트 이벤트까지 받는 비용은 RG12에서 재고, 크면 목록 주기 조회(예: 60초)로 바꾼다.
28. 브로커 호환은 빌드가 아니라 `proto` 버전과 drain 모드로 판단한다(5.7). 다른 안인 "로컬 업데이트 전에 항상 원격을 drain"은 로컬 업데이트를 원격 턴에 묶으므로, `proto`가 비호환인 릴리스에서 install.ps1이 묻는 확인으로만 쓴다. 대가는 직전 `proto` 어댑터를 한 릴리스 동안 유지하는 것이다.
29. 브로커 키는 파일 대신 arm RPC로 원격 메모리에만 준다(8.3). 원격 service가 재시작되면 own-remote가 다시 arm해야 하지만, 셸 도구가 키를 읽는 경로가 없어진다.
30. 세션 토큰은 pairing API 대신 own-remote가 직접 짧게 서명한다(12.1). upstream 토큰 형식에 기대므로 check-surface로 지키고, 깨지면 pairing으로 되돌린다.
31. **linked 계정의 원격 거절은 호스트 단위다**(8.5, 8.8). 원격 `invalidate`로 로컬 reader를 거절 상태로 만들지 않고(10.5의 "원격은 덜 믿는다"), 그 호스트만 `scope:"host"`로 막는다. 대가는 브로커의 호스트별 기억과 `account.status`의 `scope` 필드(브로커 `proto` 모양 변경)다. 다른 안 "로컬 reader도 거절"은 거짓 401 하나로 로컬 세션까지 멈출 수 있어 택하지 않았다.
32. **linked 계정의 최소 유효 기간(7분)이 로컬 만료 여유(60초)보다 길다.** 만료 7분 전부터 1분 전까지는 원격에서만 막힌다. 짧은 lease(예: 남은 수명 − 60초, 최소 2분)를 주는 안도 있었지만(01 §20 29번), 원격 401과 fail closed 유예를 부르는 쪽보다 미리 거절하는 쪽을 택했다. 이전 앱이 보통 만료 훨씬 전에 갱신한다면 이 구간은 드물다 ⚠(access token 수명과 이전 앱의 갱신 주기는 02 AC-P39에서 기록).

**v0.3에서 생긴 검증·조정 항목**
33. 데스크톱 렌더러의 `sessionStorage`가 창마다 따로이고 새로 고침 뒤에도 남는지(6.3의 프롬프트 소유자 `clientId`). RG13.
34. 원격 세션의 브라우저 패인이 원격 plugin-browser 터널로 원격 호스트의 `localhost`에 닿는지, 원격 세션 토큰으로 attach v4가 되는지(7.6, 05 §19 12번). RG16 데스크톱 항목, 05 D5 확장.
35. own-remote leader의 원격 `/api/event` 구독이 스트리밍 중인 원격 세션에서 로컬 service CPU에 주는 부하, 그리고 필요한 이벤트 종류만 싸게 걸러낼 수 있는지(12.3). RG12.
36. `accounts.update{compaction, dryRun}`의 `compactionImpact`는 로컬 인스턴스가 아는 세션만 센다(12.6). 원격 세션의 `truncates`를 보이려면 own-web이 열린 원격 세션의 `cache.state.compaction`을 받아 `Compaction.resolve`로 직접 계산하거나, 원격 own-accounts에 같은 `dryRun`을 부르는 길이 필요하다. 어느 쪽으로 할지 02·03과 정한다.
37. **브라우저 도구 끄는 방법의 01·05 차이**(7.6, 22장). 이 문서는 05 §8.7(세션 권한 새김)을 따라 원격 managed config에 `-opencode.browser`를 넣지 않는다. 01이 설치 프로필 방식(`-opencode.browser`)을 유지하면 원격 managed config도 로컬 설치 프로필을 따라야 한다(01 §20 25번).
38. **범위 어휘 대응.** 02·04의 메서드 범위(`read`, `drive`, `manage`, `local`)와 05 §13.5의 기기 범위(`read`, `prompt`, `switch`, `files`, `terminal`, `admin`)의 대응(16.7). 게이트웨이의 본문 검사(`connect{hostKeyPrompt}`, 02의 `accounts.update{replaceKey}`)와 이벤트 프레임 거르기(`host.prompt`, `device.pairing.pending`)를 05 §13.4가 받아들이는지. `push.register`·`push.unregister`의 범위(16.8 ⚠).
39. 휴대폰이 `manage` 범위로 `connect`·`disconnect`·`drain.*`를 부르게 할지(16.7). 이 문서는 기본 꺼짐인 `manage`에 두었다. 원격 설치·업데이트·호스트 추가는 `local`로 두었다.

**리뷰 반영 판단(v0.3)**
40. 2차 리뷰의 다섯 지적(02 v0.3 계약 반영, linked 계정의 lease, 데스크톱 셸 정렬, `own.remote` M1+ 목록과 범위, 01 단계 이름)은 모두 반영했고 거절한 것은 없다. 그중 두 곳은 리뷰 제안보다 좁혔다. linked 거절은 로컬 계정 상태를 바꾸지 않는 호스트 단위로 했고(31번), 이벤트 구독은 정상 모드 호스트에만 한다(27번).
