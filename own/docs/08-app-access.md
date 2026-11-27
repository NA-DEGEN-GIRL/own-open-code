# 08. 앱 연결: 다른 PC의 데스크톱 앱과 Android 앱

| 항목 | 값 |
|---|---|
| 문서 | `own/docs/08-app-access.md` |
| 상태 | v0.1 (2026-10-01). 사용자 결정: 다른 PC는 데스크톱 앱의 "원격 PC", Android는 네이티브 APK, 연결 경로는 Tailscale과 DDNS 둘 다, Tailscale control plane도 믿지 않는 구성. 2026-10-02: 데스크톱 앱의 모바일 미리보기(§4.3) |
| 관련 | `05-desktop-and-mobile.md` 13장(게이트웨이, 페어링, 범위, M1). 이 문서는 13장을 바꾸지 않고 **앱 전용 리스너**를 더한다 |

## 1. 요약

- 브라우저·PWA 경로(05 §13, M1)는 그대로다: 게이트웨이 `http://127.0.0.1:28539` + `tailscale serve --https=443`. 이 경로는 Tailscale이 발급한 인증서와 tailnet 구성원 관리(control plane)를 믿는다. 설정 화면은 Tailnet Lock 상태를 보이고 켜기를 권한다.
- **앱 경로**(이 문서): 게이트웨이가 `127.0.0.1:28540`에 **자체 서명 TLS** 리스너를 하나 더 연다. 앱(Android APK, 다른 PC의 own 데스크톱 앱)은 페어링 QR/링크로 받은 **공개키 지문(pin)**만 믿는다. CA도, Tailscale도, DDNS 업체도 믿지 않는다.
- 앱 리스너까지 닿는 길(route)은 두 가지이고 둘 다 TCP를 그대로 넘긴다(TLS는 앱과 게이트웨이 사이에서만 풀린다).
  - **tailnet**: `tailscale serve --bg --tcp=28540 tcp://localhost:28540` (raw TCP, Tailscale이 TLS를 풀지 않음)
  - **direct(DDNS)**: Windows `netsh interface portproxy`가 `0.0.0.0:28541` → `127.0.0.1:28540`, 방화벽 허용 규칙, 공유기 포트 포워딩 `28541` → 이 PC. 세 가지 모두 사용자가 직접 한다(관리자 권한). 앱 프로세스는 loopback 밖에 바인딩하지 않는다(MG1 유지).
- 기기 인증·범위·폐기·피드는 05 §13 그대로다. 앱 기기는 `kind:"app"`. 팀 모드의 `own.team` 범위표(`/srv/<hostId>`의 원격 팀 포함, 05 §13.5)와 피드의 `team.decision` 항목(05 §13.6)도 브라우저 기기와 똑같이 앱 기기에 적용된다(06 T3).

## 2. 위협 모델에서 달라지는 것

| 공격자 | 브라우저 경로(M1) | 앱 경로(이 문서) |
|---|---|---|
| Tailscale control plane 침해(가짜 노드 삽입, 키 바꿔치기, ts.net 인증서 발급) | 기기 쿠키와 대화 내용이 새어 나갈 수 있음. Tailnet Lock으로 완화 | 공격자는 pin과 맞는 TLS를 만들 수 없음 → 연결 거부. 노드를 넣어도 기기 토큰과 PC의 확인 번호 승인 없이는 아무것도 못 함 |
| DDNS 업체·DNS 침해, 공용 CA 오발급 | 해당 없음 | 앱은 `<pcKey>.ownpc.internal` 이름만 쓰고(공용 CA가 발급할 수 없는 예약 TLD) pin만 믿음 → 거부 |
| 인터넷 스캐너(direct 경로) | 해당 없음 | 공개 포트 하나. 인증 전 표면은 TLS + 정적 own-web + 페어링(128비트 코드, 속도 제한, PC 승인). 브라우저 페어링은 이 리스너에서 거부 |
| 휴대폰 분실 | 05 §13.8 | 같음(기기별 폐기) |

- 남는 위험: 페어링 순간 QR/링크가 바뀌치기되면(악성 코드가 PC 화면을 조작) pin도 공격자 것이 될 수 있다. PC 화면을 믿는 것이 전제다(05 §13.8과 같음).
- 모바일 미리보기(§4.3)의 기기 토큰은 이 PC userData의 미리보기 partition 쿠키 저장소에 있다(DPAPI). userData 사본을 가져간 사람은 이 토큰을 tailnet이나 direct route로도 쓸 수 있다. 게이트웨이는 앱 연결을 모두 loopback에서 받으므로 어느 route로 왔는지 구별하지 못한다. 완화책은 짧은 기본 만료(7일)와 쉬운 폐기(미리보기 `지우기`, 설정 > 기기 `폐기`)다.
- 앱 리스너가 보는 접속 주소는 모두 `127.0.0.1`이다(direct는 portproxy, tailnet은 `tailscale serve --tcp`). 그래서 이 리스너의 감사 기록(5분 집계)과 페어링 기록의 주소는 의미가 없고, IP별 속도 제한은 사실상 전체 제한이 된다(페어링 시도는 원래 드묾). 앱 리스너는 브라우저 리스너와 다른 속도 제한 카운터를 쓴다. 그래서 인터넷 스캐너가 앱 리스너를 막아도 브라우저 페어링은 막히지 않는다.

## 3. 계약

### 3.1 식별자

| 이름 | 형식 | 설명 |
|---|---|---|
| `pcKey` | `[a-z2-7]{12}` | 게이트웨이마다 한 번 만드는 고정 id. 앱 쪽 origin 이름의 라벨 |
| app host | `<pcKey>.ownpc.internal` | 앱이 페이지와 API에 쓰는 이름. 실제 DNS에는 없다. 앱의 로컬 CONNECT 프록시가 route로 바꾼다 |
| app origin | `https://<pcKey>.ownpc.internal` | 포트 생략(443). 쿠키·IndexedDB·localStorage가 route와 무관하게 유지된다 |
| `pin` | base64url(패딩 없음, 43자) of SHA-256(인증서의 SubjectPublicKeyInfo DER) | 키 고정. 인증서를 다시 발급해도 키가 같으면 그대로 |
| route | `host:port` (`pc.tail1234.ts.net:28540`, `myhome.ddns.net:28541`, IPv6는 `[addr]:port`) | 앱이 TCP로 붙는 곳. 순서 = 선호(tailnet 먼저) |

### 3.2 인증서

- ECDSA P-256 자체 서명, `CN=own-open-code <pcKey>`, SAN `DNS:<pcKey>.ownpc.internal`, 유효 10년, serverAuth.
- 개인키와 인증서는 vault 항목 `gateway-app-tls`(DPAPI)에 `{"version":1,"pcKey","keyPem","certPem","createdAt"}`로 둔다. vault를 쓸 수 없으면 앱 리스너는 `vault_unavailable`로 뜨지 않는다.

### 3.3 페어링 링크 (QR 내용)

```text
ownpc://pair?v=1&k=<pcKey>&p=<pin>&c=<code>&n=<PC 이름(URL 인코딩)>&r=<route>&r=<route>
```

- `c`는 05 §13.5의 1회용 코드(5분)다. `r`은 1개 이상. route가 없으면 PC 설정 화면이 링크를 만들지 않는다(같은 PC 시험용 `127.0.0.1:28540`은 개발 빌드에서만).
- **루프백 링크(모바일 미리보기 전용).** `devices.pair.start{appRoute:"loopback"}`은 route 하나, 앱 리스너가 실제로 듣는 `<bind>:<앱 포트>`(IPv6는 `[addr]:port`)만 담은 링크를 만든다. 앱 리스너가 꺼져 있으면 `null`이다. 이 링크는 로컬 RPC(모든 `devices.*`처럼 `local`)로 받은 own-web이 데스크톱 셸에 IPC로만 넘긴다(§4.3). 화면, 복사, QR, `/own/routes`, 게이트웨이 view 어디에도 이 route는 나오지 않는다. 기본값(`configured`)의 링크는 그대로다.
- 앱은 `v`가 1이 아니거나 `k`·`p`·`c` 형식이 틀리면 거부한다.

### 3.4 앱의 네트워크 구성 (Android, 데스크톱 공통)

1. 앱 프로세스 안에 **로컬 CONNECT 프록시**(`127.0.0.1:<임의>`)를 둔다. `CONNECT <pcKey>.ownpc.internal:443`만 받고, 그 PC의 route를 차례로 TCP 연결(각 3초 제한, 마지막 성공 route 먼저)한 뒤 바이트를 그대로 잇는다. 다른 호스트는 403.
2. WebView/BrowserWindow는 이 프록시만 쓰고(`https://<pcKey>.ownpc.internal/`을 연다), 인증서 검사는 **pin만**으로 한다.
   - Android: `onReceivedSslError`에서 host가 맞고 pin이 같을 때만 `proceed()`. 앱의 `network_security_config.xml`은 `ownpc.internal`(하위 도메인 포함)의 신뢰 앵커를 비워 둔다. 그래서 시스템·사용자 CA가 발급한 인증서도 이 이름에서는 검증을 통과하지 못하고 모두 이 콜백으로 온다(AA1). 공용 CA는 `.internal` 인증서를 발급할 수도 없다.
   - Electron: 그 PC 전용 partition(`persist:ownpc-<pcKey>`)에 `setCertificateVerifyProc`를 걸어 모든 인증서를 pin으로 판정한다.
3. 네이티브 HTTP(페어링, route 갱신)도 같은 프록시와 pin 검사를 쓴다.
4. User-Agent에 ` OwnOpenCodeApp/1 (android)` 또는 ` OwnOpenCodeApp/1 (desktop)`을 붙인다. own-web은 이것으로 서비스 워커를 건너뛰고, 기기 인증이 끊겼을 때 "앱에서 다시 연결" 문구를 보인다.
5. Electron 원격 PC 창에는 own preload를 붙이지 않는다(원격 페이지가 로컬 IPC를 부를 수 없게). WebRTC는 `disable_non_proxied_udp`로 프록시 밖 UDP를 쓰지 않는다(이 PC의 주소가 원격 페이지에 보이지 않게). 다운로드는 앱 origin(blob 포함)에서 온 것만, PC 이름이 적힌 저장 대화상자를 거쳐 저장하고, 그 밖은 취소한다.

### 3.5 페어링 흐름 (앱, 네이티브)

기존 게이트웨이 끝점을 앱 리스너에서 그대로 쓴다(05 §13.5, `x-own-pairing` 헤더 방식).

```text
앱: 링크 해석 → GET https://<pcKey>.ownpc.internal/auth/connect/<code>   (Accept: application/json)
  ← 200 {claim, sas, name, expiresAt}        // 410 pairing_expired, 429 rate_limited
앱: "PC 화면의 확인 번호가 <sas>이면 PC에서 허용하세요" 표시
앱: 1초마다 GET /own/pairing  (x-own-pairing: <claim>)
  ← {state:"pending"|"approved"|"rejected"|"expired"|"cancelled"|...}
approved → POST /own/pairing/claim (x-own-pairing: <claim>, body {})
  ← 200 {deviceId, token, expiresAt}
앱: 쿠키 own_device=<token> 을 app origin에 설정(HttpOnly, Secure, SameSite=Strict, 만료=expiresAt)
    PC 기록 {pcKey, name, pin, routes, deviceId, expiresAt} 저장(토큰은 쿠키 저장소에만)
```

- **저장된 PC의 키를 바꾸는 링크는 거부한다.** 앱은 링크를 해석한 직후, 요청을 보내기 전에 저장된 PC를 찾는다. 같은 `pcKey`가 다른 `pin`으로 저장되어 있으면 페어링하지 않는다(Android `pair_key_changed`, 데스크톱 `key_changed`). 저장된 기록, 쿠키, partition은 그대로다. 게이트웨이는 새 키를 만들 때 언제나 새 `pcKey`도 만든다(own-remote `tls.ts`). 그래서 같은 `pcKey`에 다른 `pin`은 위조되었거나 손상된 링크다. 같은 `pin`이면 다시 페어링할 수 있다(만료 뒤 등). 키가 정말 바뀌었다면 사용자가 그 PC를 먼저 지운다. 데스크톱은 기록을 저장하기 직전에 한 번 더 본다: 그사이 같은 PC의 새 링크가 이 페어링을 멈췄거나 다른 `pin`의 기록이 생겼으면 저장하지 않고 이 페어링의 partition을 비운다(겹친 두 페어링이 서로의 기록을 덮지 않게).
- **이름이 같은 다른 PC.** 위 거부로 막히지 않는 것은 새 `pcKey`에 저장된 PC와 같은 이름을 단 링크다(`ownpc://pair`는 아무 웹 페이지나 열 수 있고 이름은 보낸 쪽이 정한다). Android 확인 화면은 링크의 `pcKey`와 `pin` 앞 8자를 보이고, 다른 앱에서 온 링크가 목록의 다른 PC와 이름이 같으면(대소문자 무시) 경고 문구로 확인을 받는다(`PairingLink.sameNameAs`, `pair_confirm_same_name`).
- 앱 리스너는 **브라우저식 페어링을 거부**한다: `Accept: application/json` 없는 `/auth/connect/…`는 403 안내 페이지, 쿠키 claim은 403.
- 앱 리스너 앞에는 `tailscale serve --https`가 없다(TCP 그대로). 그래서 `tailscale-user-login` 헤더는 클라이언트가 보낸 값이고, 앱 리스너는 이것을 쓰지 않는다. 앱 페어링의 `tailscaleUser`는 항상 null이다.
- 토큰은 앱이 직접 들고 있지 않는다. 필요하면(route 갱신) 쿠키 저장소에서 읽어 `Authorization: Bearer`로 보낸다.
- **앱이 화면 밖에 있을 때(2026-11-19, pair-background).** 같은 휴대폰의 원격 데스크톱 앱으로 PC의 `허용`을 누르면 우리 앱은 백그라운드가 되고, 데이터 절약 모드나 백그라운드 데이터 제한이 켜진 휴대폰은 그 앱의 네트워크를 끊는다. 이전 앱은 연속 5번 실패(약 8초)에 `pair_unreachable`로 끝났다. 이제는:
  - 화면이 멈추면(`onStop`) 폴링을 멈추고, 돌아오면(`onStart`) 바로 한 번 묻는다. 멈춘 동안 실패한 요청은 세지 않는다. 화면 분할처럼 두 앱이 함께 보이면 계속 묻는다.
  - 네트워크 실패(연결 안 됨, 429, 5xx)는 그 단계의 창이 끝날 때까지 다시 시도한다: 승인은 시작부터 2분 15초, claim은 승인을 본 때부터 2분 15초(게이트웨이의 2분에 여유), 전체 5분이 상한이다. 창이 지나도 실패하면 `pair_connection_lost`(데이터 절약 모드·백그라운드 데이터·`앱을 화면에 띄워 두세요` 안내). 3번 연속 실패하면 확인 번호 아래에 같은 안내를 보이고 계속 시도한다. claim도 같은 규칙으로 다시 보낸다. 서버가 claim을 받았는데 응답만 잃었다면 다시 보낸 claim은 410(`pair_expired`)이 되고 PC 기기 목록에는 기기가 남는다(그 기기는 PC에서 폐기).
  - 처음 `/auth/connect`(일회용 코드)는 화면 밖에서 실패했을 때만 돌아와서 다시 보낸다. 화면에서 실패하면 바로 `pair_unreachable`이다.
  - 페어링은 Activity가 아니라 앱(`OwnApp`의 `PairingSession`, id를 saved state에)에 있다. 화면이 다시 만들어져도 그대로 이어진다. `취소`, 뒤로, 화면이 끝나면 멈춘다. 메모리에만 있으므로(claim은 디스크에 쓰지 않음) 프로세스가 끝나면 사라지고, 다시 만들어진 화면은 `pair_interrupted`를 보인다(이미 쓴 코드를 다시 보내지 않는다).

### 3.6 route 갱신

`GET /own/routes` (기기 인증, 범위 무관) → `{pcKey, pin, name, routes: ["host:port", …]}`. 앱은 연결할 때마다 받아 저장된 route를 바꾼다(DDNS 주소·포트를 바꿔도 다시 페어링하지 않게). `pin`이 저장값과 다르면 아무것도 바꾸지 않고 다시 연결이 필요하다고 보인다. 같은 `pcKey`에 다른 `pin`의 링크는 3.5에 따라 거부되므로, 키가 정말 바뀐 PC는 새 `pcKey`의 링크로 새로 추가하고 이전 항목은 지운다.

### 3.6a 앱에서 PC 지우기

`POST /own/device/revoke` (기기 인증; 쿠키라면 같은 origin) → `{deviceId, revoked:true}`. PC의 `폐기`와 같다(열린 연결 끊김, `device.revoked` 이벤트). 앱은 PC를 목록에서 지울 때 먼저 이것을 부르고(닿지 않으면 그냥 지운다), 쿠키와 기록을 지운다.

### 3.7 게이트웨이 설정과 RPC (own.remote, 모두 `local`)

- `gateway.json`에 `app: {enabled, port, directHost, directPort}`(기본 꺼짐, 28540, null, 28541)를 더한다.
- `gateway.configure.plan` 입력에 `app?: {enabled, port?, directHost?, directPort?}`. 검증: 포트는 서로·게이트웨이 포트와 달라야 함, `directHost`는 DNS 이름 또는 IP(스킴·경로 없음).
- `GatewayView.app`: `{enabled, state, problem, port, pcKey, pin, routes:[{kind:"tailnet"|"direct", address, ready}], tailnetCommand, direct:{host, port, portproxy, setupCommands, removeCommands}}`.
- `TailscaleView.lock`: `"on" | "off" | null`(`tailscale lock status --json`의 `Enabled`, 읽지 못하면 null). `TailscaleView.appServing`: `tailscale serve status --json`의 `TCP.<port>.TCPForward`가 앱 포트를 가리키는지.
- `devices.pair.start` 출력에 `appLink?: string | null`(앱 리스너가 꺼졌거나 route가 없으면 null). 입력 `appRoute?: "configured" | "loopback"`(기본 `configured`, §3.3 루프백 링크).
- 페어링 User-Agent에 `OwnPreview/<n>`이 있으면 기기 요약은 `Own 모바일 미리보기 · Windows`다(`OwnOpenCodeApp/1 (android)`보다 먼저 본다).
- 감지는 읽기만 한다: `tailscale status/serve status/lock status --json`, `netsh interface portproxy show v4tov4`. 설치·설정·방화벽 변경은 하지 않는다.

### 3.8 PC 쪽 명령 (설정 화면이 보여 주고, 사용자가 실행)

```powershell
# tailnet 경로 (일반 PowerShell)
tailscale serve --bg --tcp=28540 tcp://localhost:28540
# direct(DDNS) 경로 (관리자 PowerShell)
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=28541 connectaddress=127.0.0.1 connectport=28540
New-NetFirewallRule -DisplayName "Own OpenCode app access (TCP 28541)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 28541 -Profile Private
# 공유기: 외부 TCP 28541 → 이 PC의 내부 IP:28541
```

방화벽 규칙은 개인 네트워크 프로필에만 걸린다. 공유기 뒤의 집 네트워크가 Windows에서 `공용`이면 `개인`으로 바꿔야 연결된다. 공용 Wi-Fi에서는 포트가 열리지 않는다.

되돌리기: `tailscale serve --tcp=28540 off`, `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=28541`, `Remove-NetFirewallRule -DisplayName "Own OpenCode app access (TCP 28541)"`.

## 4. 클라이언트

### 4.1 다른 PC의 데스크톱 앱 ("원격 PC")

- 사이드바에 PC마다 서버 구역 머리줄 하나(2026-11-26 SBL 전에는 `다른 PC` 묶음 안의 줄. 03 §4.3)와 맨 아래 고정된 줄의 `다른 PC 추가`(링크 붙여넣기). 이 PC, SSH 호스트와 함께 끌어서 순서를 바꾼다. 확인 번호 대화상자 → PC에서 허용 → 목록에 추가.
- 항목을 열면 그 PC 전용 창이 뜬다. 창은 **원격 PC의 own-web**을 그대로 보인다. 그래서 두 PC의 버전이 달라도 화면과 서비스가 어긋나지 않는다(로컬 own-web에서 원격 서비스의 RPC를 부르면 rpc 해시가 다를 때 깨진다).
- 원격 창에서는 브라우저 패인, 네이티브 폴더 선택, 서비스 재시작 같은 데스크톱 전용 기능이 없다(모바일 호스트와 같은 capability).
- 한국어만 있는 문구: 다른 PC 창 제목(`<이름> — 다른 PC`, 2026-10-16 용어), 연결 문제 페이지와 다운로드 저장 대화상자 제목(own-desktop `remote-pcs/service.ts`), 앱 리스너가 브라우저에 주는 안내 페이지(own-remote `APP_ONLY_PAGE`). 영어는 후속이다.
- 권장 권한 프리셋 "다른 PC": 읽기, 프롬프트, 전환, 파일. 터미널은 이 PC에서 아무 명령이나 실행할 수 있어 기본으로 켜지 않는다. 사용자가 직접 고르면 위험 범위 경고가 보인다. 파일 범위의 쓰기는 서비스 임시 폴더 안(첨부 업로드)으로만 통과하므로(05 §13.4) 이 범위로 시작 프로그램이나 설정 파일을 쓸 수는 없다.

### 4.1a 원격 PC 전용 빌드 (Windows ARM64, 2026-11-06)

- 서비스 없이 다른 PC에만 붙는 데스크톱 앱이다. `own/scripts/build-desktop-client.ps1`(또는 `build-desktop.ps1 -Client`)이 이 x64 PC에서 `own-desktop-client-<ver>-win-arm64.exe`를 만든다. 서비스 payload는 없다.
- 셸은 같고 빌드 상수 `OWN_DESKTOP_CLIENT_ONLY=1`만 다르다(`src/main/client-only.ts`). 서비스를 찾지도 띄우지도 않는다. own-web 대신 원격 PC 화면(`src/client`)을 보인다. 이 화면은 PC 목록, 링크 붙여넣기, 확인 번호, 열기, 목록에서 빼기를 한다. 4.1의 `window.own.remotePcs`를 그대로 쓰므로 rpcHash는 그대로다. 트레이 메뉴는 `열기`, `종료`다.
- 원격 창과 pin, 프록시, partition은 4.1과 같다. 화면은 원격 PC의 own-web이다.
- 조사, 빌드 검사, 기기 시험 방법: `own/reports/win-arm64-2026-11-06.md`.

### 4.2 Android 앱

- `packages/own-android` (Java, minSdk 29). 화면: PC 목록, PC 추가(QR 스캔 또는 링크 붙여넣기, `ownpc://` 링크로 열기), 확인 번호, PC 화면(WebView).
- 서명: 이 PC의 debug 키(`%USERPROFILE%\.android\debug.keystore`). 업데이트하려면 같은 키로 빌드해야 한다.
- versionCode(2026-11-19): 버전 `<a>.<b>.<c>-own.<k>`에서 `a*10^7 + b*10^5 + c*10^3 + k`(`2.2.6-own.8` → 20206008). `2.2.6-own.7`까지는 모두 1이었다. 릴리스마다 커지므로 업데이트가 언제나 이전 APK 위에 깔리고, PC 기록(SharedPreferences)과 기기 쿠키(WebView 쿠키 저장소)는 그대로 남는다.
- 알림: 이번 범위에는 없다(앱이 열려 있을 때 화면 안 표시만). 꺼진 상태 알림은 FCM 중계가 필요해 다음 단계. WebView에는 웹 알림 API가 없어 설정 > 일반의 `OS 알림` 줄도 보이지 않는다.
- **PC 화면의 앱 동작(MUX 2026-11-06).**
  - 뒤로: 먼저 `window.ownApp.back()`(own-web, 03 §4.2.2)으로 페이지가 맨 위의 시트·메뉴·대화상자를 닫게 하고, 닫을 것이 없으면 WebView 기록으로, 기록도 없으면 PC 목록으로 간다. Android 13+에서는 페이지가 떠 있는 동안 `OnBackInvokedCallback`을 늘 등록한다(예측 뒤로 애니메이션 대신 시트부터 닫기). 메시지 화면(연결 실패, 보안 경고)에서는 시스템 뒤로다.
  - 시스템 막대: `window.ownApp.theme()`의 배경색과 밝기로 상태 표시줄·내비게이션 막대(Android 15의 edge-to-edge에서는 패딩한 root 배경)를 칠하고 아이콘 밝기를 맞춘다. 페이지 로드, 경로 바뀜, 재개, 재개 중 1.5초마다 읽고 바뀌었을 때만 칠한다(설정에서 테마를 바꿔도 따라감). bridge가 없는 이전 own-web이면 앱 색 그대로다. 파싱은 `SystemBars`(JVM 시험 `SystemBarsTest`).
  - 다크 모드: 테마의 `android:isLightTheme`를 `@bool/system_light`(낮 true, `values-night` false)로 두어, targetSdk 33+의 WebView `prefers-color-scheme`가 휴대폰의 다크 모드를 따른다(own-web `시스템 설정 따름`). 앱 자신의 화면(PC 목록, 연결)은 그대로 어둡다.
  - 연결 확인 화면의 `취소`·`연결`은 화면 아래쪽의 넓은 버튼(56dp)이고 `연결`은 채운 색이다.
  - 키보드: Android 10–14는 `adjustResize`, 15+는 `EdgeToEdge`가 IME inset만큼 root를 줄인다. 입력창은 키보드 바로 위에 있다(에뮬레이터 Android 15 확인).
  - 재개: WebView의 `onResume`/`onPause`로 페이지 visibility가 바뀌고, own-web 클라이언트 연결의 page lifecycle이 다시 붙는다(03 §16.3).
  - 뒤로는 페이지가 500ms 안에 답하지 않으면(불러오는 중이거나 멈춘 페이지) 답 없이 기록 뒤로나 PC 목록으로 간다(MUX-16, G7에서 첫 로드가 멈춘 채 뒤로가 아무 일도 하지 않았다).
  - 메시지 화면(`PC에 연결할 수 없어요` 등)의 `목록으로`·`다시 시도`는 연결 확인 화면처럼 넓은 56dp 버튼이다(MUX-16).
  - 실제 휴대폰 확인(MUX-16, LG G7 Android 10): 페어링, 목록, 대화, 시트, 승인(묻기·전체 허용 확인), 하드웨어 뒤로(시트 → 목록 → PC 목록), 키보드, SSH 호스트 목록과 폴더 고르기·첫 메시지, PC의 앱 리스너가 멈췄다 돌아올 때의 재연결(화면이 켜져 있으면 2초 안, 잠든 동안은 Android가 네트워크를 막아 화면을 켤 때), 느린 망(왕복 300ms, 2Mbit/s: 첫 화면 DOMContentLoaded 약 11초, 3.7MB; 자산은 immutable 캐시라 다음부터 다시 받지 않음).
  - 파일·이미지 선택은 `FileChooserParams.createIntent()`(여러 개 허용) 그대로다. 다른 앱에서 `공유`로 글이나 그림을 보내는 것은 아직 없다(다음 단계).
- **시험 설치(MUX).** `-PownTestInstall=1`로 빌드하면 applicationId `dev.own.opencode.android.debug`, 이름 `Own 시험`, debuggable(WebView 원격 디버깅으로 시험 데이터만 본다)이다. 사용자의 앱 옆에 따로 깔리고 데이터도 따로다. `own/scripts/build-android.ps1`은 이 값을 넘기지 않는다(릴리스 APK는 그대로 `dev.own.opencode.android`, debuggable 아님).

### 4.3 모바일 미리보기 (이 PC의 데스크톱 앱)

Android 앱이 받는 이 PC의 own-web을 이 PC의 데스크톱 앱 창 하나로 본다. 같은 앱 리스너, 같은 pin 검사, 같은 기기 토큰 경로와 User-Agent를 쓰므로, 휴대폰 없이 앱 화면(휴대폰 폭, 터치, 앱 모드 문구)을 확인할 수 있다. 설치할 것이 없고 loopback만 쓰므로 방화벽 창도 뜨지 않는다.

- **만들기.** 설정 > 기기 > `모바일 미리보기` > `미리보기 기기 만들기`. 게이트웨이와 앱 연결이 켜져 있어야 한다(꺼져 있으면 이유를 보인다).
  - 권한은 Android 앱 기본값(읽기, 프롬프트, 전환)이고 터미널은 없다. 바꾸려면 기기 목록의 `권한 바꾸기`를 쓴다. 만료는 7일(기본) 또는 30일, 이름은 `모바일 미리보기 (이 PC)`다.
  - own-web은 루프백 링크(§3.3)를 받아 셸(`window.own.mobilePreview.pair`)에만 넘긴다. 링크는 화면 상태에 들어가지 않는다.
  - 셸이 §3.5 흐름으로 페어링하고, 이 PC 화면에 보통의 `기기 연결 요청`(`Own 모바일 미리보기 · Windows`, 확인 번호)이 뜬다. **사용자가 `허용`해야** 연결된다. 자동 승인은 없다.
  - 기기 목록에서 이 기기에는 `이 PC 미리보기` 표시가 붙는다.
- **상태.** `확인 중`, `연결됨`, `연결할 수 없음`, `다시 만들기 필요`(폐기, 만료, 인증서 변경). 저장된 `pcKey`·`pin`이 지금 `gateway.status().app`과 다르면 `다시 만들기`(지운 뒤 새로 만들기)를 권한다.
- **셸 쪽 구성**(own-desktop `remote-pcs/preview.ts`, `partition.ts`, `emulation.ts`).
  - partition `persist:ownpreview-<pcKey>-<pin 해시>`. 같은 PC를 원격 PC로도 추가했더라도 쿠키·저장소·토큰이 섞이지 않는다. 기록은 `<userData>\mobile-preview.json` `{pcKey, pin, route, deviceId, expiresAt, addedAt, preset, orientation}`이고 토큰은 없다(쿠키 저장소에만).
  - 미리보기 전용 CONNECT 프록시는 이 PC의 `pcKey`를 저장된 loopback route로만 잇는다. 다른 `pcKey`(저장된 원격 PC 포함), loopback이 아닌 route, 그 밖의 호스트는 모두 403이다. 셸은 링크가 loopback route 하나(`127.x.x.x` 또는 `[::1]`)일 때만 받는다.
  - `열기`는 `gateway.status().app.port`를 넘긴다. 앱 포트를 바꾸면 저장된 route의 포트도 따라간다.
  - 창은 preload 없음, sandbox, context isolation(원격 PC 창과 같은 규칙, §3.4 5). 크기는 기기 화면 크기로 고정하고, 화면에 안 들어가면 그림만 줄인다(페이지는 원래 크기로 배치).
  - 메뉴: `기기`(작은 휴대폰 360×740, Pixel 412×868, Galaxy 384×790, 폴더블 673×790, 태블릿 800×1220, `회전` Ctrl+Shift+O, `키보드` Ctrl+K), `보기`(`뒤로` Alt+←, `새로 고침` F5, 시스템/라이트/다크, `개발자 도구` F12), `미리보기`(`미리보기 기기 지우기…`). 크기 값은 시스템 막대를 뺀 대략값이다.
  - 휴대폰 모양은 창의 프로세스 내 debugger(CDP, 원격 디버깅 포트 없음)로 첫 로드 전에 건다: `Emulation.setDeviceMetricsOverride`(mobile, 방향), `setTouchEmulationEnabled`(5점, `(pointer: coarse)`·`(hover: none)`이 맞음), `setEmitTouchEventsForMouse`, `setUserAgentOverride`(`…Android 15; Pixel 8; wv)… Chrome/<셸의 Chromium> Mobile Safari/537.36 OwnOpenCodeApp/1 (android) OwnPreview/1`, UA-CH mobile, Android), `setEmulatedMedia`(테마). Electron 44는 문서를 한 번도 로드하지 않은 창에 device metrics를 보내면 main 프로세스가 죽으므로 `about:blank`을 먼저 연다. 이 설정은 새로 고침과 다른 사이트로의 이동에도 유지된다(숨긴 창으로 확인).
  - 키보드는 Android의 `adjustResize`처럼 화면을 그대로 두고 페이지 높이만 줄인다(세로 약 40 %, 가로 약 55 %). safe-area inset은 앱의 EdgeToEdge처럼 0이다.
  - Electron 문서는 개발자 도구를 열면 이 debugger가 떨어진다고 적고 있다. 떨어지면 그동안은 휴대폰 모양이 풀리고, 개발자 도구를 닫을 때 다시 건다. 개발자 도구는 보이는 창이 필요해 자동으로 확인하지 않았다 ⚠.
- **폐기.** 설정 > 기기의 `폐기`나 `모두 폐기`(열린 연결이 끊기고 창에는 앱 문구가 보인다), 미리보기의 `지우기`(`POST /own/device/revoke` 뒤 partition을 비우고 표시, 기록 삭제. 원격 PC 제거와 같은 경로), 만료.
- **한계.** Java 화면(PC 목록, 페어링, QR, 오류 표시)은 없고, 엔진은 Android WebView가 아니라 데스크톱 앱의 Chromium이며 글꼴은 Windows 글꼴이다. 이것까지 보려면 Android Emulator에 APK를 설치한다. 선택 도구 `own/scripts/android-emulator.ps1`은 기본으로 준비 상태를 확인하고 사용자가 실행할 명령(SDK `emulator`와 시스템 이미지, AVD, `emulator -accel-check`, 필요할 때만 관리자 권한의 Windows 하이퍼바이저 플랫폼)을 출력만 한다. 이미 실행 중인 에뮬레이터(`ro.kernel.qemu=1`, 휴대폰은 거부)가 있을 때만 `-Install`이 빌드된 APK를 설치하고, `-PairLink`가 `adb reverse tcp:<앱 포트>`를 건 뒤 Android용 링크(`127.0.0.1:<앱 포트>` route를 덧붙임)를 앱에서 연다. 이 PC에 방화벽 규칙이나 설정을 더하지 않는다. 앱은 PC가 주는 route 목록이 비어 있지 않으면 그것으로 바꾸므로, Tailscale·DDNS route가 설정된 PC에서는 첫 갱신 뒤 에뮬레이터가 loopback route를 잃는다 ⚠. 실제 기기 확인은 휴대폰으로 한다.
- **한국어만 있는 문구**: 미리보기 창 제목, 메뉴, 지우기 확인, 연결 문제 페이지. 설정 화면은 한국어와 영어.
- **자동 확인.** 미리보기 창은 `own-desktop.exe` 안에 있고, 컴퓨터 사용은 이 앱을 조작하지 않는다. 그래서 같은 화면을 own-web e2e AA-M(`e2e/gateway/gateway.pw.ts`)이 확인한다: Playwright `devices["Pixel 7"]`와 미리보기 User-Agent, 앱 프록시, 네이티브 페어링으로 받은 쿠키.

## 5. 시험

| 게이트 | 내용 |
|---|---|
| AA1 pin | 다른 키의 인증서, 유효한 공용 인증서(시험 CA), 이름이 다른 인증서 → 앱·데스크톱 모두 연결 거부, 쿠키 미전송. Android는 `ownpc.internal`에 신뢰 앵커가 없다(`network_security_config.xml`) |
| AA2 리스너 | 앱 리스너는 loopback만, Host는 `<pcKey>.ownpc.internal`(과 loopback 시험용)만, 브라우저식 페어링 403 |
| AA3 페어링 | 네이티브 흐름 정상, 확인 번호 거부, 만료, 재사용 → 05 MG2와 같은 결과. 저장된 PC와 같은 `pcKey`·다른 `pin`의 링크 → 요청 전에 거부, 기록·쿠키 그대로(`PairingLinkTest`, own-desktop `remote-pcs.test.ts`). 앱 리스너의 `tailscale-user-login` 헤더 무시(`app.test.ts`) |
| AA4 route | route 순서·실패 넘김, `/own/routes` 갱신, pin 불일치 시 갱신 안 함 |
| AA5 원격 PC 창 | preload 없음, 외부 링크는 사용자 입력 직후에만 기본 브라우저(데스크톱: 그 창에서 누른 뒤 5초 안, Android: `hasGesture`. 원격 페이지가 스스로 연 링크는 버림), 원격 페이지에서 `window.electron` 없음, WebRTC는 프록시 밖 UDP 없음(`disable_non_proxied_udp`), 다운로드는 앱 origin에서만, 저장 대화상자를 거쳐서 |
| AA6 실제 기기 | 사용자: 휴대폰 LTE로 tailnet·direct 각각 접속, 폐기 즉시 끊김 |
| AA7 모바일 미리보기 | 루프백 링크는 route 하나(`<bind>:<앱 포트>`)뿐이고 기본 링크·`/own/routes`·게이트웨이 view에 없음, 미리보기 기기는 PC의 `허용` 뒤에만 `kind:"app"`·`Own 모바일 미리보기 · Windows`로 연결, 폐기하면 열린 연결 0(own-remote `app.test.ts`). 링크는 loopback route 하나만, partition·기록은 원격 PC와 따로, 토큰 없는 기록, 미리보기 프록시는 이 PC의 `pcKey`와 loopback route만, CDP 값(own-desktop `mobile-preview.test.ts`). 링크가 화면 상태에 들어가지 않음(own-web `preview.test.ts`). Pixel 7에서 모바일 호스트, `(pointer: coarse)`, 서비스 워커 없음, 412 px에서 가로 스크롤 없음, 44 px 터치 대상, 프롬프트 전송, 폐기 뒤 앱 문구(own-web e2e AA-M). 숨긴 Electron 창에서 innerWidth = 프리셋 폭, coarse, 터치 5점, 다른 사이트로 이동한 뒤에도 유지 |
