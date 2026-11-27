# 빠른 시작 (Own OpenCode 2.0.18-own.3)

자세한 내용은 [USER-GUIDE.md](USER-GUIDE.md)에 있습니다. 여기에는 처음 쓰는 데 필요한 것만 적었습니다.

## 1. 설치 (1분)

1. `D:\own-open-code\own\.out\build\2.0.18-own.3\desktop\own-desktop-2.0.18-own.3-win-x64.exe`를 실행합니다.
   - 관리자 권한과 묻는 창 없이 현재 사용자에게 설치됩니다.
   - 서명하지 않은 파일이라 경고가 뜨면 `추가 정보` → `실행`을 누릅니다.
2. 시작 메뉴에서 **Own OpenCode**를 엽니다. 처음 열면 서비스가 자동으로 시작됩니다.

업데이트는 새 설치 파일을 실행하면 됩니다. 세션이 도는 중이면 먼저 묻고, 문제가 생기면 PowerShell에서 `own rollback`으로 되돌립니다.

**설치 파일은 탐색기에서 두 번 눌러 실행합니다.** Claude 데스크톱 앱의 터미널이나 에이전트가 실행하면 서비스가 그 앱 전용 폴더(`%LOCALAPPDATA%\Packages\Claude_…\LocalCache`)에만 설치되어, 앱이 **"Own OpenCode가 설치되지 않았어요"**를 보입니다. `own.2`를 그렇게 설치했다면 `own.3` 설치 파일을 탐색기에서 실행하면 됩니다(USER-GUIDE 2.7). `own.3`은 Claude 앱 안에서 실행되면 아무것도 바꾸지 않고 알려 줍니다.

조용히 설치할 때는 끝날 때까지 기다립니다: `Start-Process -Wait .\own-desktop-2.0.18-own.3-win-x64.exe -ArgumentList '/S'`(서비스 부분은 마지막에 돕니다. 기록은 `%TEMP%\own-installer.log`).

## 2. 처음 5분

1. **계정 추가**: 사이드바 아래 계정 아이콘 → `계정 추가`.
   - API 키(OpenAI, Anthropic, DeepSeek, xAI, OpenRouter, 기타 호환): 키를 붙여 넣고 `연결 테스트 후 추가`.
   - ChatGPT 구독: `코드로 로그인` → 화면의 코드를 https://auth.openai.com/codex/device 에 입력.
   - 이전 앱(codex-multi-provider)의 로그인: `이전 앱에서 가져오기` → **연결**(권장, 이전 앱은 그대로) 또는 **인수**(이전 앱을 그만 쓸 때).
   - 이전 앱에 저장된 API 키(DeepSeek 등): `이전 앱에서 가져오기` → `API 키` → `연결…`(키는 복사하지 않고 이전 앱 파일을 읽기만 함).
2. **폴더 열기**: `Ctrl+O` → 폴더 선택 → `이 폴더에서 새 세션`.
3. **모델과 계정 고르기**: 입력창의 `모델 @ 계정` 칩(`Ctrl+.`).
4. 메시지를 보냅니다. 명령 실행 같은 승인 요청은 입력창 위에 뜹니다. 버튼을 누르거나, `Ctrl+Shift+Enter`로 이동한 뒤 `Enter`(허용)·`Esc`(거절).

## 3. 알아 둘 것 5가지

1. **계정을 바꾸면 캐시가 사라집니다.** 새 계정은 대화 전체를 다시 읽습니다. 긴 세션에서 바꿀 때 뜨는 대화상자에서는 보통 `압축 후 전환`이 가장 쌉니다.
2. **한도**: 오른쪽 `계정·한도` 탭(`Ctrl+Shift+U`)에서 봅니다. `실측`은 서버가 알려 준 값이고, `추정`·`보정 중`은 앱이 계산한 값입니다.
3. **자동 압축**: DeepSeek·xAI 같은 모델은 더 일찍 압축하도록 기본값이 잡혀 있습니다. 입력창의 문맥 미터 → `자동 압축 설정`에서 바꿉니다.
4. **창을 닫아도 작업은 계속됩니다.** 서비스를 멈추려면 PowerShell에서 `own stop`.
5. **테마**: 어두운 테마가 기본입니다. `설정 > 일반 > 테마`에서 바꿉니다.

## 4. 자주 쓰는 단축키

| 동작 | 키 |
|---|---|
| 명령 팔레트 (모든 기능 검색, 한글 초성 가능) | `Ctrl+K` |
| 모델 @ 계정 전환 | `Ctrl+.` |
| 새 세션 / 폴더 열기 | `Alt+N` / `Ctrl+O` |
| 리뷰 / 파일 / 터미널 | `Ctrl+Shift+R` / `Ctrl+\` / `` Ctrl+` `` |
| 파일 빠른 열기 / 세션 안 찾기 | `Ctrl+P` / `Ctrl+F` |
| 실행 중단 | `Esc` 두 번 |
| 단축키 전체 보기 | `Ctrl+/` |

## 5. SSH 원격 호스트 (3단계)

1. 사이드바 `+ 원격 호스트 추가` → `~/.ssh/config`의 호스트 선택 → `연결 확인`.
2. 처음이면 호스트 키 지문이 보입니다. 맞을 때만 `신뢰하고 연결` → `설치하고 연결`(root 권한 불필요, 사용자 홈에만 설치).
3. `폴더 열기` → 원격 경로 → `이 폴더에서 새 세션`. 계정 키는 호스트에 남지 않습니다.

## 6. 휴대폰·다른 PC에서 쓰기 (선택)

**앱으로 (Android 앱, 다른 PC의 데스크톱 앱, 권장)**: 앱은 이 PC 인증서의 지문만 믿습니다.

1. `설정 > 기기` → 게이트웨이 `켜기` → `앱 연결` → `앱 연결 켜기`.
2. 경로 하나 이상: Tailscale(화면의 `tailscale serve --tcp …` 한 줄) 또는 DDNS(도메인 입력 → 화면의 두 줄을 관리자 PowerShell에서 → 공유기에서 외부 28541 포트 포워딩).
3. `새 기기 연결` → `Android 앱`(앱에서 QR 스캔) 또는 `다른 PC`(링크를 다른 PC의 `원격 PC 추가`에 붙여 넣기) → 양쪽 확인 번호가 같으면 PC에서 `허용`.

APK는 `own\.out\build\<버전>\android\`에 있습니다(설치: USER-GUIDE 11.5).

**브라우저로**: PC와 휴대폰에 Tailscale → `설정 > 기기` → 게이트웨이 `켜기` → 화면의 `tailscale serve …` 명령 → `새 기기 연결` → `브라우저` → QR. 이 경로는 Tailscale 서버를 믿으므로 Tailnet Lock을 켜 두세요(USER-GUIDE 11.6).

## 7. 문제가 생기면

| 증상 | 할 일 |
|---|---|
| 서비스가 안 뜸 | PowerShell에서 `own status` → `own start`. 업데이트 직후라면 `own rollback` |
| "Own OpenCode가 설치되지 않았어요" | `own status`의 `installed`를 봅니다. 비어 있거나 `own.2` 이하면 `own.3` 설치 파일을 실행 |
| "앱 셸과 화면 버전이 맞지 않습니다" | 같은 버전의 설치 파일을 다시 실행 |
| 방화벽 허용 창 | 모두 `127.0.0.1`만 쓰므로 허용하지 않아도 됩니다 |
| 이전 앱 연결 계정이 "이전 앱 갱신 대기" | 이전 앱에서 그 프로필을 한 번 열기. 자주 생기면 계정 `⋯` → `이 앱으로 인수…` |

로그: 서비스 `%USERPROFILE%\.local\share\opencode\log\`, 데스크톱 앱 `%APPDATA%\dev.own.opencode.desktop\logs\`.

## 8. Claude에게 맡길 수 있는 것 / 직접 해야 하는 것

**Claude에게 요청하면 바로 실행하는 것** (저장소 `D:\own-open-code`에서)

| 요청 예 | Claude가 실행하는 것 |
|---|---|
| "새로 빌드해 줘" | `powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1 -Version 2.0.18-own.N -Remote` (약 10분, 결과는 `own\.out\build\<버전>\`) |
| "테스트 전부 돌려 줘" | own-* 패키지 typecheck·단위 테스트, own-web e2e(설치된 Edge), `check-ledger`·`check-surface` |
| "성능 재 줘" | `packages/own-web`에서 `bun run bench --repeat 5` (다른 앱을 닫은 상태가 정확합니다) |
| "upstream 최신으로 맞춰 줘" | `own/FORK.md`의 동기화 절차(미러 갱신 → merge → 검사 → 빌드) |
| "dev-host에서 SSH 검증해 줘" | 실제 호스트 게이트 검증(사용자 홈에만 설치, 끝나면 정리) |
| 버그 수정, 기능 추가, 문서 수정 | 코드 수정 → 테스트 → commit·push |

**직접 해야 하는 것**

- 설치 파일 실행(설치·업데이트). **탐색기에서 직접** 실행해야 합니다. Claude 앱 안에서 실행하면 파일 가상화 때문에 설치가 Claude 전용 폴더로 들어갑니다.
- 실제 API 키 입력, ChatGPT 로그인, 이전 앱 로그인 가져오기, Claude 구독 계정 연결과 Claude Code 로그인(플러그인은 앱에 들어 있어 따로 설치하지 않습니다). 실제 자격증명은 Claude가 대신 입력하지 않습니다.
- Windows 보안 창(방화벽, UAC, SmartScreen) 응답, Tailscale 설치와 `tailscale serve` 실행.
- (선택) 다른 PC에 배포할 때 코드 서명.
