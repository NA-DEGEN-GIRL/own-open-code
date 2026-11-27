[English](BUILDING.md) | **한국어**

# own-open-code 빌드하기

설치 파일을 배포하지 않아서 직접 빌드해야 해요. 데스크톱 앱과 서비스, Linux 서버용 묶음, Windows ARM64 클라이언트, Android 앱까지 모두 Windows 11 x64 PC 한 대에서 빌드해요. macOS와 Linux에서는 빌드할 수 없어요.

처음 빌드는 10~25분쯤 걸리고, 아래 도구 말고도 디스크를 10GB쯤 써요.

## 필요한 것

| 도구 | 버전 | 어디에 쓰나요 |
|---|---|---|
| Windows | 11, x64 | 전부 |
| Git for Windows | 최근 것 | 저장소 받기. 빌드가 커밋도 읽어요 |
| Bun | `package.json`의 `packageManager`에 적힌 버전 그대로(지금 **1.4.4**) | 전부. 버전이 다르면 스크립트가 멈춰요 |
| Node.js | 22, npm 포함 | 데스크톱 앱 |
| Rust | stable 1.85 이상, `x86_64-pc-windows-msvc` | 키 보관 도우미(`own-vault`) |
| MSVC 빌드 도구 | Visual Studio Build Tools의 *C++를 사용한 데스크톱 개발* | Rust 도우미 링크 |
| 7-Zip | 아무 버전, 선택 | 설치 파일 내용을 한 번 더 검사 |
| JDK | 17 이상(21로 시험) | Android 앱에만 |
| Android SDK | `platforms;android-36`, `build-tools;37.0.0` | Android 앱에만 |

스크립트가 쓰는 Windows PowerShell 5.1과, 컴퓨터 사용 도우미를 만드는 .NET Framework 컴파일러는 Windows에 들어 있어요. 아래 명령은 PowerShell 5.1과 7에서 모두 돼요.

```powershell
winget install Git.Git OpenJS.NodeJS.22 Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
npm install -g bun@1.4.4
```

새 터미널을 열고 `git --version`, `node --version`, `bun --version`, `cargo --version`을 확인하세요.

## 소스 받기

**`#`이 없는 짧은 경로**를 쓰세요(Bun과 Vite가 `#`에서 깨져서 스크립트가 거절해요). 이름이 긴 파일이 있으니 Git이 긴 경로를 쓰게 해요.

```powershell
git clone -c core.longpaths=true https://github.com/NA-DEGEN-GIRL/own-open-code.git C:\src\own-open-code
cd C:\src\own-open-code
bun install --frozen-lockfile
```

ZIP으로 받지 말고 clone하세요. 빌드가 어느 커밋에서 만들었는지 기록해요. Bun이 다른 플랫폼 패키지를 건너뛰었다거나 설치 스크립트 몇 개를 막았다고 알리는데, 둘 다 괜찮아요.

**줄 끝**은 따로 설정하지 않아도 돼요. 저장소의 `.gitattributes`가 `core.autocrlf` 값과 상관없이 모든 파일을 저장된 그대로 꺼내요(Git for Windows 기본값 `true`일 때 소스 글을 비교하는 테스트가 깨지던 문제).

**심볼릭 링크.** 트리에 29개(아이콘과 타입 파일 하나) 있어요. Windows 개발자 모드가 꺼져 있으면 Git이 링크마다 대상 경로가 적힌 작은 텍스트 파일을 만들어요. 개발자 모드를 켜고 clone할 때 `-c core.symlinks=true`도 주거나, 보통으로 clone한 뒤 한 번 실행하세요.

```powershell
node own/scripts/link-copies.mjs
```

링크마다 대상 파일을 텍스트 파일 자리에 복사하고, Git이 그 사본을 건드리지 않게 표시해요(`--skip-worktree`). 링크가 바뀐 pull 뒤에는 다시 실행하세요.

## 데스크톱 앱

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1
```

명령줄 겸 서비스(`opencode.exe`), 플러그인, 웹 화면, 키 보관 도우미, Electron 셸, 설치 파일 하나를 만들어요. 새로 만든 `opencode.exe`를 임시 폴더에서 잠깐 확인하는 것 말고는 아무것도 설치하거나 실행하지 않아요.

| 옵션 | 하는 일 |
|---|---|
| `-Version 2.4.0-own.1` | 버전. `<루트 package.json 버전>-own.<번호>` 꼴이고 안 적으면 `…-own.0`이에요. 설치해 둔 앱을 업데이트할 때는 번호를 올려요 |
| `-Remote` | Linux 서버용 묶음도 만들어요(아래) |
| `-Client` | Windows ARM64 클라이언트도 만들어요(아래) |
| `-NoInstaller` | 풀린 앱만 만들어요 |
| `-SkipService` | 같은 버전으로 지난번에 만든 `opencode.exe`를 다시 써요 |

결과는 `own\.out\build\<버전>\`에 있어요.

| 경로 | 무엇인가요 |
|---|---|
| `desktop\own-desktop-<버전>-win-x64.exe` | 설치 파일. 앱과 서비스, `own` 명령이 들어 있어요 |
| `desktop\win-unpacked\` | 풀린 데스크톱 셸 |
| `cli-windows-x64\bin\opencode.exe` | 명령줄 겸 서비스 |
| `app\`, `bin\` | 설치되는 모양 그대로 |
| `manifest.json`, `desktop-build.json` | 버전, 해시, 크기, 거친 검사 |

### 설치, 업데이트, 제거

설치 파일은 **탐색기에서**, 또는 시작 메뉴에서 연 터미널에서 실행하세요. 지금 사용자에게만 설치되고 관리자 권한은 필요 없어요. 패키지로 설치된 데스크톱 앱 안의 터미널(에이전트의 터미널 같은 것)에서는 실행하지 마세요. Windows가 파일을 그 앱 전용 폴더로 돌려 버려요. 설치 파일이 이것을 알아채고 멈춰요.

업데이트는 새 설치 파일을 실행하면 돼요. 터미널의 `own rollback`으로 한 버전 되돌려요. 제거는 *설정 → 앱*에서 하고, 데이터는 직접 지울 때까지 남아요(`own uninstall --remove-data`는 둘 다 지워요).

| 어디 | 무엇 |
|---|---|
| `%LOCALAPPDATA%\Programs\own-desktop` | 데스크톱 앱 |
| `%LOCALAPPDATA%\own-open-code` | 서비스, 계정, 암호화한 키 보관함, 로그 |
| `%USERPROFILE%\.local\share\opencode\opencode-own.db` | 대화 |
| `%USERPROFILE%\.config\own-open-code` | 설정 |

### 명령줄과 서비스만

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-own.ps1
```

같은 버전의 결과 폴더를 먼저 지우니까 다른 스크립트보다 먼저 돌리세요.

## Linux 서버용 묶음

SSH 호스트를 쓰려면 필요해요. Windows에서 교차 빌드해서 설치 파일 안에 넣어요.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1 -Remote
```

결과는 `remote\linux-x64-baseline.tar.gz`, `remote\linux-arm64.tar.gz`와 `remote\tools`의 Git LFS예요. `bun.lock`에 고정한 Linux 네이티브 패키지, Bun의 Linux 런타임, 고정한 Git LFS 릴리스를 내려받고 모두 해시로 확인해요.

## Windows ARM64 클라이언트

own이 도는 다른 PC에 붙는 데스크톱 앱이에요. 자기 서비스는 없어요.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop-client.ps1
```

결과는 `desktop-client-arm64\own-desktop-client-<버전>-win-arm64.exe`예요. ARM64용 Electron, node-pty, ffi-rs를 내려받아 해시를 확인해요. 정적 검사는 통과하지만 ARM64 PC에서는 아직 돌려 보지 못했어요. `build-desktop.ps1` 다음에 돌리거나 그 스크립트의 `-Client`를 쓰세요.

## Android 앱

`JAVA_HOME`에 JDK를 정하고(또는 `%LOCALAPPDATA%\Programs\jdk-21`에 두고), `ANDROID_HOME`에 SDK를 정하세요(기본 `%LOCALAPPDATA%\Android\Sdk`). Android 명령줄 도구로는 이렇게 해요.

```powershell
sdkmanager "platforms;android-36" "build-tools;37.0.0"
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-android.ps1
```

결과는 `android\own-opencode-<버전>.apk`예요. 데스크톱 빌드가 같은 버전의 결과 폴더를 비우니까 그다음에 돌리세요.

**내 서명 키.** APK는 내 PC의 디버그 키로 서명돼요. 처음 빌드할 때 Gradle이 `%USERPROFILE%\.android\debug.keystore`에 만들어요(`ANDROID_USER_HOME`으로 옮길 수 있어요). 이 파일을 백업해 두세요. Android는 같은 키로 서명한 파일만 업데이트로 받고, 버전도 더 높아야 해요. APK를 휴대폰에 복사하거나 `adb install`로 설치해요.

## 개발용으로 돌리기

둘 다 임시 폴더에서 가짜 제공자와 함께 개발용 서비스를 띄워요. 계정이 필요 없고 설치해 둔 앱도 건드리지 않아요.

```powershell
bun run --cwd packages/own-web dev:service        # 웹 화면, http://localhost:5173
bun run --cwd packages/own-desktop electron:install
bun run --cwd packages/own-desktop dev            # 데스크톱 셸
```

검사는 루트에서 `bun run check`(린트와 타입), 패키지 안에서 `bun typecheck`와 `bun run test`예요. 루트에서 시험을 돌리면 안 돼요. 느린 시험은 하나씩만 돌도록 `C:\t\locks`에 잠금 파일을 두는데, `OWN_HEAVY_LOCK`으로 옮길 수 있어요. README의 그림은 `bun own/scripts/readme/capture.ts`로 다시 만들어요.

## 내려받는 것

| 언제 | 어디서 | 무엇 |
|---|---|---|
| `bun install` | npm | `bun.lock`의 패키지 |
| 데스크톱 빌드 | crates.io | `own/native/own-vault/Cargo.lock`의 크레이트 |
| 데스크톱 빌드 | npm | 해시로 고정한 `opencode-claude-auth-v2` |
| 데스크톱 빌드 | GitHub | Electron(약 150MB)과 electron-builder의 NSIS·서명 도구 |
| `-Remote` | npm, GitHub | Linux 네이티브 패키지, Bun 런타임, Git LFS |
| ARM64 클라이언트 | npm, GitHub | ARM64용 Electron, node-pty, ffi-rs |
| Android | Gradle, Google, Maven Central | Gradle과 앱 라이브러리 |

모두 도구의 캐시나 `own\.out`에 남아서 다시 써요. `-Remote`는 Bun의 Linux 런타임을 npm·GitHub의 것과 비교하기도 해요. `build-remote.ps1 -SkipRuntimeCheck`는 그 비교를 건너뛰어요.

## 자주 겪는 문제

### Windows가 빌드한 파일을 막아요

파일에 서명이 없어요. 다른 PC에서 온 파일이면 SmartScreen이 경고할 수 있어요. **스마트 앱 컨트롤**은 서명 없는 프로그램을 아예 막을 수 있어요. 그러면 빌드가 `spawn UNKNOWN`이나 *응용 프로그램 제어 정책에서 이 파일을 차단했습니다*로 멈추거나 설치한 앱이 켜지지 않아요. 이 프로젝트에는 그것을 피해 가는 방법이 없고, 이 앱 때문에 보호를 끄지도 마세요. 스마트 앱 컨트롤이 이미 꺼진 PC를 쓰거나, Windows가 믿는 인증서로 파일에 서명하는 길이 남아요. 서명하려면 `build-own.ps1`을 돌리고, `opencode.exe`에 서명한 뒤, `build-desktop.ps1 -SkipService`를 돌리세요. 빌드가 그 파일의 해시를 기록하기 때문이에요.

### `contains '#'`

저장소를 `#`이 없는 경로로 옮기세요.

### `Filename too long`

더 짧은 경로에 `-c core.longpaths=true`로 clone하세요.

### `bun … does not match packageManager`

메시지에 나온 버전을 설치하세요. `npm install -g bun@<버전>`이에요.

### `link.exe not found` 같은 Rust 오류

Visual Studio Build Tools의 C++ 구성 요소가 없어요. 설치하고 새 터미널을 여세요.

### `bun run check`가 `custom-elements.d.ts`에서 실패해요

Git for Windows가 OpenCode의 심볼릭 링크를 텍스트 파일로 만들었고, 그중 하나가 타입 파일이에요. `node own/scripts/link-copies.mjs`를 실행하세요([소스 받기](#소스-받기) 참고).

### 시험이 다른 `bash`를 써요

`C:\Windows\System32\bash.exe`는 WSL이에요. 빌드는 bash를 쓰지 않지만 SSH 시험에는 Git for Windows의 bash가 필요해요. Git Bash에서 돌리세요.

### `own-vault.exe`나 `opencode.exe`가 사용 중이에요

다른 체크아웃의 개발 실행이 잡고 있을 수 있어요. 닫거나 다른 `-Version`으로 빌드하세요.

### APK가 예전 것 위에 설치되지 않아요

다른 PC에서 서명했거나 버전이 더 높지 않아요. 예전 `debug.keystore`를 가져오거나, `-own.` 뒤의 번호를 올리거나, 앱을 먼저 지우세요(지우면 휴대폰을 다시 연결해야 해요).

### Electron이나 NSIS를 내려받지 못해요

`build-desktop.ps1 -ElectronCache <폴더>`에 `electron-v<버전>-win32-x64.zip`이 든 폴더를 주세요. 나머지는 프록시 뒤에 있다면 `HTTPS_PROXY`를 정하세요.
