# own-android

Own OpenCode Android 앱(`dev.own.opencode.android`). 페어링한 PC의 own-web을 WebView로 연다. 계약과 보안 모델은
[`own/docs/08-app-access.md`](../../own/docs/08-app-access.md)(§3 계약, §4.2 Android)가 기준이다.

- Java만(Kotlin·AppCompat·Capacitor 없음), 프레임워크 `Activity`와 위젯. minSdk 29, target/compileSdk 36.
- 의존성: `androidx.webkit`(WebView 프록시 지정), `play-services-code-scanner`(카메라 권한 없는 QR 스캔).
  시험 전용: JUnit 4, `org.json`(JVM에는 android.jar의 빈 껍데기만 있어서).

## 구성

| 파일 | 역할 |
|---|---|
| `PairingLink` | `ownpc://pair?v=1&k=&p=&c=&n=&r=` 해석·검증(§3.3). 코드 `c`는 로그·`toString`에 넣지 않는다 |
| `Route`, `AppHost`, `Pins` | route(`host:port`, `[v6]:port`), `<pcKey>.ownpc.internal`, SPKI SHA-256 pin(base64url 43자) |
| `RouteProxy` | 앱 안의 CONNECT 프록시 `127.0.0.1:<임의>`. `CONNECT <pcKey>.ownpc.internal:443`만 받아 그 PC의 route로 TCP를 잇는다(마지막 성공 route 먼저, 각 3초). 그 밖은 403, route가 모두 실패하면 502 |
| `PinnedHttps` | 네이티브 HTTPS(페어링, `/own/routes`). 프록시 경유, pin만 믿는 TrustManager, 정확한 app host만 받는 HostnameVerifier |
| `PairingFlow` | `/auth/connect/<code>` → 확인 번호 → `/own/pairing` 폴링 → `/own/pairing/claim`(§3.5). `hold`/`release`로 화면 밖에서는 묻지 않고, 네트워크 실패는 단계의 창(`Timing`)까지 다시 시도 |
| `PairingSession` | 진행 중인 페어링 하나. `OwnApp`이 id로 들고 있어 화면이 다시 만들어지거나 화면 밖에 있어도 이어진다. 화면은 붙었다 떨어지며 마지막 상태를 다시 받는다 |
| `DeviceApi` | `POST /own/device/revoke`(§3.6a). PC를 지울 때 먼저 부르고(약 5초, 실패는 무시) 쿠키와 기록을 지운다 |
| `PcRecord`, `PcStore` | PC 기록(SharedPreferences JSON). 토큰은 없다 |
| `Cookies`, `DeviceCookies` | `own_device` 쿠키(HttpOnly, Secure, SameSite=Strict). 토큰은 WebView 쿠키 저장소에만 있다 |
| `MainActivity` | PC 목록, PC 추가(QR/링크), 길게 눌러 지우기, `ownpc://pair` 링크 받기 |
| `PairingActivity` | 확인 번호 화면. 저장된 PC와 같은 `pcKey`에 다른 pin인 링크는 요청 전에 거부(`PairingLink.conflictsWith`, §3.5) |
| `MicPermission` | 음성 입력(02 §3.9)의 마이크 판정: app origin(`https://<app host>`)이고 요청 자원이 `RESOURCE_AUDIO_CAPTURE`뿐일 때만. `PcActivity.onPermissionRequest`가 쓰고, 처음에는 `RECORD_AUDIO` 권한 창을 띄운다(05 §7.8) |
| `PcActivity` | WebView. `ownpc.internal`에는 신뢰 앵커가 없어(`res/xml/network_security_config.xml`) 모든 인증서가 `onReceivedSslError`로 오고, host와 pin이 맞을 때만 진행, 앱 origin 밖은 외부 브라우저, `/own/routes`로 route 갱신(§3.6) |

`android.*`를 쓰지 않는 클래스(`PairingLink`, `Route`, `AppHost`, `Pins`, `RouteProxy`, `PinnedHttps`, `PairingFlow`, `PairingSession`,
`DeviceApi`, `PcRecord`, `Cookies`, `Json`, `MicPermission`)는 `src/test/java`의 JVM 시험이 직접 돈다. 시험용 TLS 키는 `src/test/resources`의
자체 서명 인증서이고, 기대 pin은 openssl로 따로 계산한 값이다.

## 빌드

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-android.ps1 [-Version 2.0.18-own.4]
```

- `-Version`을 빼면 루트 `package.json` 버전에 `-own.0`을 붙인다(`build-desktop.ps1`과 같음).
- 릴리스에서는 `build-desktop.ps1`을 먼저, 이 스크립트를 같은 `-Version`으로 나중에 돌린다. 데스크톱 빌드의 CLI 단계
  (`build-own.ps1`, upstream `build.ts`)가 `own\.out\build\<Version>`을 먼저 지우므로, 먼저 만든 APK는 사라진다.

- `gradlew testDebugUnitTest assembleDebug`(Gradle 9.8.0 wrapper, AGP 9.4.1, JDK 17+)를 돌리고 APK를
  `own\.out\build\<Version>\android\own-opencode-<Version>.apk`로 복사한 뒤 sha256, 서명자, 시험 수를 보인다.
- 서명은 이 PC의 debug 키(`%USERPROFILE%\.android\debug.keystore`). 업데이트는 같은 키로 빌드해야 설치된다.
- versionCode는 버전에서 나온다(`a*10^7 + b*10^5 + c*10^3 + k`, `build.gradle.kts`). `2.2.6-own.7`까지는 1이었다.
- debug 변형이지만 `debuggable=false`로 빌드한다. 사이드로드용 APK가 debuggable이면 adb `run-as`로 쿠키 저장소
  (기기 토큰)를 읽을 수 있고 WebView 원격 디버깅이 켜진다.
- 직접 돌릴 때: `JAVA_HOME`, `ANDROID_HOME`을 잡고 이 폴더에서 `.\gradlew.bat testDebugUnitTest assembleDebug`.

## 보안 메모

- 믿는 것은 페어링 링크의 pin 하나다. CA, Tailscale, DDNS는 믿지 않는다(§2). WebView는 앱 프록시만 쓰고(직접 연결
  없음), 프록시는 알려진 app host가 아니면 거절하므로 페이지가 인터넷이나 LAN에 직접 닿지 않는다.
- 토큰·claim·페어링 링크 전체는 로그에 남기지 않는다. `addJavascriptInterface` 없음, 파일·content 접근 끔,
  혼합 콘텐츠 금지, 새 창 금지, 백업·기기 이전 제외, 평문 통신 금지.
- 로컬 프록시는 같은 휴대폰의 다른 앱도 붙을 수 있는 `127.0.0.1` 포트다. 그래도 얻는 것은 PC의 앱 리스너까지 가는
  TCP뿐이고(직접 경로로는 원래 열려 있다), TLS와 기기 토큰이 없으면 아무것도 못 한다.
- PC 목록에서 지우면 먼저 PC에 `POST /own/device/revoke`로 이 기기를 폐기하고(pin 검사, 약 5초), 이 휴대폰의
  기록·쿠키·웹 저장소를 지운다. PC에 닿지 않았으면 PC의 기기 목록에서 따로 폐기해야 토큰이 무효가 된다.
