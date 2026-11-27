# own-cu-helper

own-open-code computer use(`@own/computer-use`, 플러그인 `own.computer-use`)의 Windows helper입니다. 모니터·창 목록, 화면 캡처, `SendInput` 입력, UI Automation 포커스 조회를 stdin/stdout JSON-lines로 제공합니다.

**2026-10-01부터 이 helper는 기본 엔진이 아닙니다.** 기본은 플러그인 안에서 `bun:ffi`로 Win32를 직접 부르는 드라이버(`driver: "windows"`, 워커 스레드 둘)입니다. 서명 없는 이 exe는 Smart App Control이 켜진 PC에서 막힐 수 있고(4장), 따로 빌드·배포해야 하며, 시작에 125–270 ms가 들기 때문입니다. 이 helper는 플러그인 options에서 `driver: "helper"`를 고른 경우에만 쓰입니다. 그때 플러그인의 프로세스 싱글턴이 **첫 도구 호출 때** 이 helper를 장수 자식 프로세스 하나로 띄웁니다(플러그인 로드만으로는 띄우지 않음).

근거: 01 §10.2(결정), 패키지 `packages/own-computer-use/ARCHITECTURE.md`(계층·안전 순서·좌표 모델, 프로세스 안 드라이버).

**이 문서가 프로토콜 계약입니다.** TS 쪽 `packages/own-computer-use/src/driver/windows/protocol.ts`(스키마)와 `driver.ts`(op 매핑)가 이 문서를 따릅니다. 프로세스 안 드라이버의 데스크톱 워커(`src/driver/windows/ffi/desktop.ts`)도 같은 op와 응답 모양을 JSON 줄 대신 `postMessage`로 주고받습니다(`hello.name`은 `own-cu-ffi`, 캡처 `data`는 base64가 아니라 바이트). 바꿀 때는 `Program.Protocol`(`src/Program.cs`), 이 문서, `protocol.ts`의 `PROTOCOL`, 데스크톱 워커를 함께 고칩니다.

하지 않는 일: 네트워크, 파일 쓰기, 로깅(stdout은 응답·이벤트 전용, stderr는 쓰지 않음), 저수준 키보드·마우스 훅(`WH_KEYBOARD_LL`/`WH_MOUSE_LL` 없음, 사용자 입력을 읽지 않음), 관리자 권한 요청(`asInvoker`), 정책 판단(어떤 앱을 조작해도 되는지는 TS gate가 정합니다), 입력한 텍스트를 응답이나 오류 메시지에 되풀이하기.

---

## 1. 빌드와 산출물

```powershell
# 저장소 루트에서 (FORK.md §8.2, build-desktop.ps1 3c단계와 같은 명령)
powershell -NoProfile -ExecutionPolicy Bypass -File own/native/own-cu-helper/build.ps1
# → own/native/own-cu-helper/target/own-cu-helper.exe   (설치 시 app\<ver>\own-cu-helper.exe)

powershell -NoProfile -ExecutionPolicy Bypass -File own/native/own-cu-helper/build.ps1 -OutDir <폴더>   # 다른 곳에 빌드 (실제 데스크톱 시험)
```

- 컴파일러는 Windows에 들어 있는 .NET Framework 4.x `csc.exe`(4.8, C# 5)입니다. SDK나 설치가 필요 없습니다. `target\`은 저장소 `.gitignore`가 무시합니다.
- 옵션: `/target:winexe`(콘솔 창 없음), `/platform:x64`, `/optimize+`, `/warnaserror+`, `/codepage:65001`(소스는 BOM 없는 UTF-8, 표시기 문구가 한국어), `/noconfig`.
- 참조: `System`, `System.Core`, `System.Drawing`, `System.Windows.Forms`, `System.Web.Extensions`, `WPF\WindowsBase`, `WPF\UIAutomationTypes`, `WPF\UIAutomationClient`. 모두 Windows 구성 요소라 번들·재배포하지 않습니다. 서드파티 코드는 없습니다.
- `app.manifest`: Per-Monitor-V2 DPI 인식(`PerMonitorV2`, 예전 Windows용 `true/pm`), `asInvoker`, Windows 10/11 supportedOS. `Main`도 `SetProcessDpiAwarenessContext(-4)`를 부릅니다.
- csc 4.x에는 `/deterministic`이 없어 빌드할 때마다 바이트가 달라집니다(manifest의 artifact 해시도 매번 바뀜).
- 소스: `Program.cs`(루프·dispatch·hello), `Json.cs`(파서·writer·인자 검사), `Screens.cs`(모니터·캡처·데스크톱 확인), `TopWindows.cs`(창 정보·포커스), `Input.cs`(SendInput·누른 입력 추적), `Uia.cs`(포커스 요소), `Ui.cs`(UI 스레드·정지 조합·표시기), `Native.cs`(Win32 선언).

## 2. 실행

```text
own-cu-helper.exe              # stdin/stdout 프로토콜
own-cu-helper.exe --version    # "own-cu-helper 0.1.0 (protocol 1)" (stdout이 리디렉션됐을 때만 보임)
```

- **환경 변수가 필요 없습니다.** client는 `SystemRoot`와 `windir`만 넘기고 `windowsHide`로 띄웁니다.
- 수명: stdin EOF를 받으면 이 helper가 누른 키·버튼을 모두 놓고 종료 코드 `0`으로 끝납니다. 서버가 죽어도 파이프가 닫혀 같은 길로 끝납니다. stdout이 끊기면(`IOException`) 같은 정리를 하고 끝납니다.
- **데스크톱 뮤텍스** `Local\own-open-code-computer-use`: 한 사용자 세션에서 helper 하나만 데스크톱을 조작합니다(개발·운영 서비스가 같이 떠 있을 때). 시작할 때 못 잡으면 `hello`를 뺀 모든 요청이 `busy`이고, 요청마다 다시 잡아 봅니다.
- **정지 조합 `ctrl+alt+shift+q`**: `RegisterHotKey`(`MOD_NOREPEAT`)로 UI 스레드의 숨은 창에 등록합니다. 누르면 helper가 그 자리에서 누른 입력을 모두 놓고 `{"event":"kill_chord"}`를 보냅니다(TS 쪽이 kill switch를 겁니다). 다른 프로그램이 이미 등록했으면 `hello.killChord`가 `false`이고, 뮤텍스를 얻을 때와 `hello`를 받을 때마다 다시 등록해 봅니다. TS gate는 입력 동작 전마다 `hello`를 다시 묻고 `killChord`가 `true`가 아니면 입력을 거부합니다(`[computer.no_stop_chord]`, 물리적으로 멈출 길이 없으므로). `RegisterHotKey`는 주입된 입력과 실제 입력을 구별하지 못하므로 TS 정책이 이 조합의 주입을 막습니다. own-web의 `중지`(세션 헤더 칩)와 설정 > 실험의 `모두 중지`는 RPC `killswitch.engage`로 같은 kill switch를 겁니다. 그때는 TS가 떠 있는 helper에 `release.all`을 보냅니다.
- 스레드: 메인 스레드가 요청을 차례로 처리합니다. STA UI 스레드가 숨은 메시지 창(정지 조합, `WM_DISPLAYCHANGE`)과 표시기를 맡고, `window.focus`와 `indicator`는 그 스레드에서 실행됩니다. UI Automation 조회는 요청마다 별도 백그라운드 스레드에서 돕니다.

## 3. 와이어 프로토콜

### 3.1 framing

- 요청: stdin에 **UTF-8 JSON 객체 한 줄**(`\n` 종료, `\r\n` 허용). 빈 줄은 무시합니다. 1 MiB(문자)를 넘거나 JSON 객체가 아니면 `bad_request`이고, 그 응답에는 `rid`가 없습니다(client는 rid 없는 응답을 가장 오래된 요청의 것으로 봅니다).
- 응답: 요청마다 stdout에 JSON 객체 한 줄, **요청 순서대로**. 요청에 `rid`가 있으면 그대로 돌려줍니다.
- 이벤트: `rid` 없는 `{"event": …}` 줄이 응답 사이 아무 때나 나옵니다(3.4).
- stdout은 **ASCII만** 씁니다. 창 제목 같은 비ASCII 문자는 `\uXXXX`로 이스케이프합니다.
- 캡처 응답은 큰 한 줄입니다. client는 16 MiB(`protocol.ts` `MAX_LINE_BYTES`)를 넘는 줄을 받으면 helper를 죽입니다. 도구가 요청하는 크기(긴 변 ≤ 2000 px, base64 ≤ 4.5 MB)는 그보다 훨씬 작습니다.
- 모르는 필드는 무시합니다. 정수 필드에 소수·문자열을 주면 `bad_request`입니다.
- **좌표는 모두 물리 픽셀이고 가상 데스크톱 좌표입니다.** 주 모니터 왼쪽·위에 있는 모니터는 원점이 음수입니다.

### 3.2 공통 필드와 오류

| 요청 필드 | 뜻 |
|---|---|
| `op` | 필수. 3.3의 이름 |
| `rid` | 선택. 아무 JSON 값. 응답에 그대로 돌아옵니다. client는 단조 증가 정수를 씁니다 |

| `error` | 뜻 (TS `DriverError` reason) |
|---|---|
| `bad_request` | 필드가 없거나 형식·범위가 틀림 (`protocol`) |
| `unknown_op` | 모르는 op (`protocol`) |
| `busy` | 다른 helper가 데스크톱 뮤텍스를 쥐고 있음 (`unavailable`) |
| `desktop_unavailable` | 데스크톱이 입력을 받지 않음: 입력 desktop이 `Default`가 아니거나(잠금 화면, UAC, Ctrl+Alt+Del) `GetCursorPos`가 거부됨(이 세션을 보여 주는 원격 데스크톱 클라이언트 창이 최소화됨. 세션은 Active·잠금 해제 상태지만 렌더링과 입력이 멈춰 `GetCursorPos`·`BitBlt`가 액세스 거부로 실패합니다. 2026-10-01 실측) |
| `unknown_window` | 그런 창이 없음 |
| `failed` | 그 밖의 실패. `message`에 이유(Windows 오류 문구는 OS 언어) |

오류 응답: `{"ok":false,"rid":7,"error":"desktop_unavailable","message":"…"}`.

### 3.3 연산

입력을 보내거나 화면을 읽는 op(`capture`, `mouse.*`, `key`, `text`, `window.focus`, `focus.element`)는 먼저 데스크톱이 입력을 받는지 확인하고, 아니면 `desktop_unavailable`로 끝냅니다.

#### `hello` — 버전·상태 (client가 띄운 직후 한 번)

```json
→ {"op":"hello","rid":1}
← {"ok":true,"rid":1,"name":"own-cu-helper","version":"0.1.0","protocol":1,"dpiAwareness":"per_monitor_v2","interactive":true,"inputDesktop":true,"pid":45456,"killChord":true}
```

- `dpiAwareness`: 메인 스레드의 DPI 인식 컨텍스트(`per_monitor_v2`, `per_monitor`, `system`, `unaware`, `unknown`). client는 `per_monitor_v2`가 아니거나 `protocol`이 1이 아니면 helper를 거부합니다(좌표가 가상화되기 때문).
- `interactive`: 프로세스의 window station이 `WinSta0`(사용자 데스크톱에 닿음).
- `inputDesktop`: 지금 데스크톱이 입력을 받음(3.2 `desktop_unavailable`의 반대). 상태가 바뀔 수 있어 요청마다 다시 확인합니다.
- `killChord`: 정지 조합 등록에 성공했는지. 없으면 TS는 `false`로 봅니다.
- `hello`는 뮤텍스와 무관하게 언제나 답합니다. 뮤텍스가 비어 있으면 잡고, 잡고 있으면 정지 조합 등록을 다시 시도한 뒤 답합니다. 그래서 다른 helper나 프로그램이 조합을 놓으면 다음 `hello`부터 `killChord:true`입니다(2026-10-01 실제 helper 두 개로 확인: 첫 helper가 있는 동안 둘째는 `false`, 첫 helper가 끝난 뒤 둘째의 다음 `hello`는 `true`).

#### `displays` — 모니터

```json
→ {"op":"displays","rid":2}
← {"ok":true,"rid":2,"displays":[{"id":0,"primary":true,"bounds":{"x":0,"y":0,"width":3840,"height":2160},"scale":1.5,"name":"\\\\.\\DISPLAY1"}]}
```

- `id`는 0..n-1입니다. 주 모니터가 0이고, 나머지는 왼쪽→오른쪽, 위→아래 순입니다. 모델이 쓰는 `display` 인자입니다.
- `bounds`는 `GetMonitorInfo`의 모니터 사각형(물리 픽셀), `scale`은 `GetDpiForMonitor(MDT_EFFECTIVE_DPI)`/96입니다.

#### `capture` — 화면 캡처

```json
→ {"op":"capture","rid":3,"display":0,"width":1429,"height":804,"format":"png"}
→ {"op":"capture","rid":4,"display":0,"region":{"x":100,"y":200,"width":800,"height":600},"width":800,"height":600,"format":"jpeg","quality":85}
← {"ok":true,"rid":3,"mime":"image/png","data":"iVBORw0…","width":1429,"height":804,"cursor":{"x":1200,"y":640}}
```

| 필드 | 기본값 | 뜻 |
|---|---|---|
| `display` | 필수 | 모니터 `id` |
| `region` | 모니터 전체 | 가상 데스크톱 좌표의 물리 사각형. 모니터를 벗어나면 `failed` |
| `width`, `height` | 필수 | 출력 이미지 크기(1..16384). region과 다르면 HighQualityBicubic으로 줄입니다 |
| `format` | 필수 | `png` 또는 `jpeg` |
| `quality` | 85 | JPEG 품질 1..100 |

- 화면 DC에서 `BitBlt(SRCCOPY | CAPTUREBLT)`로 읽습니다(`CAPTUREBLT`는 layered 창 포함). `Graphics.CopyFromScreen`은 이 플래그 조합을 정의되지 않은 enum 값으로 거부하므로 쓰지 않습니다.
- 축소할 때 `WrapMode.TileFlipXY`를 써서 가장자리에 어두운 테두리가 번지지 않게 합니다. 비트맵은 24 bpp라 PNG는 RGB(colour type 2)입니다.
- 마우스 커서는 이미지에 그리지 않습니다. 커서가 그 모니터 위에 있으면 `cursor`(물리 좌표)로 따로 줍니다.
- `data`는 base64입니다. 크기 예산(JPEG 사다리)은 TS 쪽이 정합니다.

#### `cursor.get` — 커서 위치

```json
→ {"op":"cursor.get","rid":5}
← {"ok":true,"rid":5,"x":1200,"y":640}
```

#### `mouse.move` / `mouse.button` / `mouse.wheel`

```json
→ {"op":"mouse.move","rid":6,"x":1200,"y":640}
→ {"op":"mouse.button","rid":7,"button":"left","action":"down"}
→ {"op":"mouse.wheel","rid":8,"dx":0,"dy":-1}
← {"ok":true,"rid":8}
```

- `mouse.move`: `SetCursorPos`(정확한 물리 좌표, 반올림 없음).
- `mouse.button`: `button`은 `left`·`right`·`middle`, `action`은 `down`·`up`. 누른 버튼은 놓을 때까지 추적합니다.
- `mouse.wheel`: 노치 단위(−100..100). 양수 `dy`는 위로(사용자에게서 멀어지는 방향), 양수 `dx`는 오른쪽. 한 노치 = `WHEEL_DELTA` 120.
- `SendInput`이 넣은 이벤트 수가 모자라면 `failed`입니다. 관리자 권한 창이 포그라운드일 때 UIPI는 입력을 조용히 버리므로, 이 경우는 TS 정책이 미리 거부합니다(`elevated_target`).

#### `key` — 가상 키 하나 누르기/놓기

```json
→ {"op":"key","rid":9,"vk":65,"extended":false,"action":"down"}
← {"ok":true,"rid":9}
```

- `vk` 1..254, `extended`(기본 `false`)는 E0 접두 스캔 코드(화살표, Insert/Delete/Home/End/PgUp/PgDn, 숫자 키패드 Enter·나누기, Windows 키). 스캔 코드는 `MapVirtualKey(vk, MAPVK_VK_TO_VSC)`로 채웁니다.
- 누른 키는 놓을 때까지 추적합니다. 조합(ctrl+a 등)과 순서는 TS가 정합니다.

#### `text` — 유니코드 텍스트

```json
→ {"op":"text","rid":10,"text":"안녕 😀"}
← {"ok":true,"rid":10}
```

- UTF-16 단위마다 `KEYEVENTF_UNICODE`(VK_PACKET) down/up을 만들어 **`SendInput` 한 번**으로 보냅니다. 키보드 배열이나 한글 IME 조합과 무관하고, 중간에 사용자 입력이 끼어들지 않습니다. 서로게이트 쌍(이모지)은 두 단위로 나가고 받는 쪽이 합칩니다.
- 줄바꿈·탭은 TS가 실제 Enter·Tab 키로 바꿔 보내므로 여기로 오지 않습니다. TS는 32 코드 포인트씩 나눠 보냅니다(kill switch 확인 단위).

#### `window.at` / `window.foreground` — 창 하나

```json
→ {"op":"window.at","rid":11,"x":1200,"y":640}
← {"ok":true,"rid":11,"window":{"id":"0x1a2b","pid":4242,"exe":"notepad.exe","title":"메모 - Notepad","className":"Notepad","bounds":{"x":100,"y":100,"width":1200,"height":800},"displayId":0,"elevated":false,"minimized":false,"cloaked":false}}
→ {"op":"window.foreground","rid":12}
← {"ok":true,"rid":12,"window":null}
```

- `window.at`: `WindowFromPoint` → `GetAncestor(GA_ROOT)`. 숨은 창·비활성 창·클릭 통과 창은 건너뛰므로 그 점을 클릭했을 때 받는 창입니다.
- `window.foreground`: `GetForegroundWindow`. 없으면(포커스가 넘어가는 중, 입력을 받지 않는 데스크톱) `null`.
- helper 자신의 창(표시기, 숨은 메시지 창)은 `null`로 답합니다.

창 정보(`WindowInfo`, TS `Policy.WindowInfo`):

| 필드 | 뜻 |
|---|---|
| `id` | HWND 16진수(`0x…`). 모델의 `windowId` |
| `pid`, `exe` | 프로세스 id와 이미지 **파일 이름**(경로 없음, `QueryFullProcessImageName`). 프로세스를 열 수 없으면 `""`(정책이 항상 거부). 창 주인이 `ApplicationFrameHost.exe`(UWP 앱의 프레임)이면 `EnumChildWindows`로 주인 pid가 다른 첫 자식 창(앱의 CoreWindow)을 찾아 그 프로세스를 보고합니다. 찾지 못하면(일시 중단·최소화된 UWP 앱은 Windows가 CoreWindow를 떼어 둠) `exe`는 `""`, `elevated`는 `true`입니다 |
| `title`, `className` | 창 제목(최대 511자)과 클래스 이름 |
| `bounds` | DWM 확장 프레임 경계(보이지 않는 크기 조절 테두리 제외), 없으면 `GetWindowRect`. 최소화된 창은 Windows의 주차 위치 |
| `displayId` | 창이 걸친 모니터(`MonitorFromWindow`). 최소화된 창은 없음 |
| `elevated` | 프로세스 토큰의 `TokenElevation`. **토큰을 읽을 수 없으면 `true`**(fail closed) |
| `minimized`, `cloaked` | `IsIconic`, `DWMWA_CLOAKED`(다른 가상 데스크톱, 일시 중단된 UWP) |

#### `windows.list` — 최상위 창 목록

```json
→ {"op":"windows.list","rid":13}
← {"ok":true,"rid":13,"windows":[{…WindowInfo…}, …]}
```

`EnumWindows` 순서, 즉 **z-order 위에서부터**입니다. `IsWindowVisible`인 창만 넣고 helper 자신의 창은 뺍니다. 크기가 0인 창이나 cloaked 창도 그대로 넣습니다(걸러 내기는 TS `Policy.visible`).

#### `window.focus` — 포그라운드로

```json
→ {"op":"window.focus","rid":14,"id":"0x1a2b"}
← {"ok":true,"rid":14}
```

- 없는 창이면 `unknown_window`, 최소화돼 있으면 먼저 복원합니다.
- `SetForegroundWindow` 뒤 최대 200 ms 동안 결과를 확인합니다. Windows의 포커스 도용 방지로 거절되면 지금 포그라운드 스레드에 `AttachThreadInput`으로 붙어 한 번 더 시도합니다(UI 스레드에서 실행). 그래도 안 되면 `failed`("Windows kept another window in the foreground").

#### `focus.element` — 포커스된 UI 요소 (비밀번호 필드 규칙)

```json
→ {"op":"focus.element","rid":15}
← {"ok":true,"rid":15,"focus":{"pid":4242,"isPassword":false,"controlType":"Edit"}}
```

- UI Automation `AutomationElement.FocusedElement`의 `ProcessId`, `IsPassword`, `ControlType`(앞의 `ControlType.`을 뗀 이름). 포커스된 요소가 없으면 `null`.
- 다른 앱의 UIA provider가 멈출 수 있어 요청마다 백그라운드 스레드에서 돌리고, **3초** 안에 답이 없으면 `failed`입니다. 그러면 TS는 입력하지 않습니다(추측하지 않음).

#### `release.all` — 누른 입력 모두 놓기

```json
→ {"op":"release.all","rid":16}
← {"ok":true,"rid":16}
```

이 helper가 누르고 아직 놓지 않은 키·버튼을 모두 놓습니다. 실패하지 않습니다. stdin EOF와 정지 조합도 같은 일을 합니다.

#### `indicator` — "에이전트가 조작 중" 표시기

```json
→ {"op":"indicator","rid":17,"on":true,"text":"에이전트가 이 PC를 조작하고 있습니다"}
← {"ok":true,"rid":17}
```

주 모니터 위쪽 가운데의 작은 띠입니다. 클릭이 통과하고(`WS_EX_TRANSPARENT`), 활성화되지 않으며(`WS_EX_NOACTIVATE`), `WDA_EXCLUDEFROMCAPTURE`라 캡처에 찍히지 않습니다. `text`가 없으면 기본 한국어 문구(정지 조합 안내 포함)를 씁니다. `on:false`면 숨깁니다. client는 이미 떠 있는 helper에만 보냅니다(표시기를 위해 helper를 띄우지 않음). 2026-10-01 기준 TS gate는 아직 표시기를 켜지 않습니다(01 §10.2 2단계).

### 3.4 이벤트

| 줄 | 뜻 |
|---|---|
| `{"event":"kill_chord"}` | 사용자가 정지 조합을 눌렀음. helper는 이미 누른 입력을 놓았습니다 |
| `{"event":"display_changed"}` | `WM_DISPLAYCHANGE`(해상도·모니터 구성 변경). 프레임이 오래됐는지는 TS가 layout 해시로 다시 판단합니다 |

helper가 예기치 않게 끝나면 client가 그것을 `exited` 이벤트로 바꿔 kill switch를 겁니다(누른 입력의 상태를 알 수 없으므로).

## 4. 안전 메모

- 이 helper는 **무엇이든** 조작할 수 있는 저수준 도구입니다. 동의(세션 규칙), 앱 거부 목록, 관리자 권한 창·비밀번호 필드 거부, 막힌 키, lease, kill switch, 감사 로그는 모두 TS gate(`packages/own-computer-use/src/gate.ts`)에 있습니다. helper를 직접 쓰는 코드를 새로 만들지 않습니다.
- 사용자 입력을 관찰하지 않습니다. 정지 조합은 `RegisterHotKey` 하나뿐이고 사용자 개입 감지(저수준 훅)는 아직 없습니다.
- 서명하지 않은 로컬 빌드라 MOTW가 없어 SmartScreen 대상이 아닙니다. Defender는 새로 빌드한 exe를 첫 실행 때 검사합니다(아래 측정의 첫 실행 지연).
- **Smart App Control**: 이것이 켜진 PC에서는 Code Integrity가 서명 없는 새 빌드의 실행을 막을 수 있습니다(CodeIntegrity/Operational 이벤트 3077·3033, "did not meet the Enterprise signing level requirements"). 2026-10-01 이 PC(Smart App Control 켜짐)에서 새로 빌드한 exe 아홉 개 중 여덟 개는 실행됐고 마지막 하나가 막혔습니다. 같은 날 21:03에는 18:50에 빌드해 둔 `target\own-cu-helper.exe`를 실제 데스크톱 시험이 띄우려다 막혔습니다(이벤트 3077·3033, `uv_spawn`의 `EUNKNOWN`). 막히면 Bun의 `spawn`이 `EUNKNOWN`을 던지고, transport는 이것을 시작 실패(백오프 포함, `driver_unavailable`)로 처리하며 메시지에 Smart App Control 안내를 붙입니다. 보안 설정은 바꾸지 않습니다. 이 때문에 기본 엔진을 프로세스 안 FFI 드라이버로 바꿨습니다(01 §10.2). 이 helper를 쓰려면 Smart App Control이 켜진 PC에서는 코드 서명이 필요할 수 있습니다.

## 5. 검증

- 단위 시험(데스크톱 없음): `packages/own-computer-use`에서 `bun test test/unit`. transport·driver는 `test/fixtures/fake-helper.ts`(같은 프로토콜을 말하는 Bun 스크립트)로 시험합니다.
- 실제 데스크톱 시험(선택): `packages/own-computer-use`에서 `OWN_CU_REAL=1 bun test test/real`. 드라이버마다 한 번씩 돕니다. helper 변형은 빌드해 둔 `target\own-cu-helper.exe`(또는 `OWN_CU_HELPER_EXE`)가 있고 실제로 시작될 때만 돌며, 시험은 helper를 빌드하지 않습니다. fixture는 시스템 `powershell.exe`가 실행하는 WinForms 스크립트(`test/real/fixture/fixture.ps1`)라 exe를 컴파일하지 않습니다. 입력 전에 점 아래 창이나 포그라운드 창이 fixture인지 창 핸들로 확인하고, 끝나면 커서를 원래 자리로 돌리고 fixture와 helper를 닫습니다. 잠금 화면이나 최소화된 원격 데스크톱 창에서는 입력 시험이 분명한 메시지로 실패합니다.
- 아래 5.1의 수치는 예전 C# fixture(`Fixture.cs`, 지금은 지움)로 잰 것입니다.

### 5.1 2026-10-01 실측

환경: Windows 11 Pro 26200, 모니터 하나 3840x2160 배율 150%(`\\.\DISPLAY17`), 원격 데스크톱 세션(클라이언트 창이 보일 때). 실제 데스크톱 시험 14개 모두 통과.

| 항목 | 결과 |
|---|---|
| 시작 + `hello` | 새로 빌드한 exe의 첫 실행 768–1300 ms(Defender 검사), 그 뒤 재시작 125–270 ms, `hello` 왕복 < 1 ms |
| `windows.list` | 11–18 ms (창 29개) |
| 표준 스크린샷(1429x804 PNG, `displays`+`capture`) | 289–505 ms. 같은 크기 `capture`만 5회 중앙값 PNG 359 ms, JPEG 85 246 ms |
| 원본 해상도 캡처(3840x2160) | JPEG 85 180–238 ms, PNG 243–370 ms |
| 축소 없는 영역 캡처(800x600 PNG) | 31 ms |
| 그중 bicubic 축소(4K → 1429x804)만 | 140–165 ms (개선 후보: 화면 DC에서 바로 GDI `HALFTONE` `StretchBlt`) |
| 클릭 정확도 | 스크린샷 좌표 → 물리 좌표 매핑 오차 ≤ 1 px, fixture가 받은 점 = 보낸 점(오차 0, 허용 2 px) |
| 클릭 지연 | `Actions.click` 35–58 ms, 누름이 fixture에 도착하기까지 23–47 ms, gate를 거친 `left_click` 34 ms |
| 텍스트 | ASCII + 한글 + 이모지(피부색 수식 포함) 35자가 정확히 들어감, 215–247 ms |
| 그 밖 | ctrl+a·BackSpace, 휠 노치(세로 −120×3, 가로 +120×2), 버튼 클릭, `focus.element`(`Edit`, 비밀번호 아님), 거부 목록에 넣은 앱의 `type` 거부(`[computer.app_denied]`, 입력 없음) |

같은 날 시험을 바꾼 뒤 한 번 더 돌린 실행은 새로 빌드한 helper를 Smart App Control이 막아 시작하지 못했습니다(4장). 위 결과는 그 전 실행입니다.

원격 데스크톱 클라이언트 창을 최소화한 동안에는 세션이 Active·잠금 해제여도 `GetCursorPos`·`BitBlt`가 액세스 거부로 실패하고 포그라운드 창이 없습니다. 이 상태가 `desktop_unavailable`의 두 번째 경우이고, 실제 데스크톱 시험은 입력 시험을 분명한 메시지로 실패시킵니다.

## 6. 후속 (01 §10.2 단계)

- **UI Automation 앱 상태**: Codex식 도구(`get_app_state`, `ui_click`, `set_value`)를 위한 op(요소 트리 덤프, 요소 invoke, ValuePattern 설정)와 앱별 백그라운드 전달. 새 op를 더하면 `Program.Protocol`, 이 문서, `protocol.ts`의 `PROTOCOL`을 함께 올립니다.
- **사용자 개입 감지**: 주입 플래그(`LLKHF_INJECTED`/`LLMHF_INJECTED`)를 무시하는 저수준 훅으로 사용자의 실제 입력을 감지해 이벤트로 알리는 것. 넣으면 위 "하지 않는 일"의 저수준 훅 항목과 4장 안전 메모를 고칩니다. 훅 스레드가 멈추면 Windows가 훅을 떼므로(LowLevelHooksTimeout) 별도 스레드가 필요합니다.
- **캡처 비용**: 4K에서 bicubic 축소가 약 150 ms입니다. 화면 DC에서 바로 GDI `HALFTONE` `StretchBlt`로 줄이는 안을 실제 데스크톱 시험(색, 클릭 정확도)으로 확인한 뒤 바꿉니다.
- **서명**: 이 helper를 다시 기본으로 쓰려면 Smart App Control이 켜진 PC를 위해 코드 서명이 필요합니다(4장). 기본 엔진은 서명할 파일이 없는 프로세스 안 드라이버입니다.
