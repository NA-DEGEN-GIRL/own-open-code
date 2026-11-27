# 27. 데이터 위치·로그·백업·제거

**한 줄 요약**: 앱의 파일은 몇 개 폴더에 나뉘어 있어요. 문제를 알아볼 때는 **로그 폴더**를, 버전을 바꿀 때는 자동으로 생기는 **DB 백업**을 봐요. 제거할 때는 **원격(휴대폰·SSH 서버)부터 정리**한 뒤 Windows의 `설치된 앱`에서 지워요. 사용자 데이터는 따로 묻고, 처음 값은 **남기기**예요.

> **참고** 아래 경로의 `%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`, `%TEMP%`는 Windows가 사용자마다 정해 둔 폴더예요. 탐색기 주소 표시줄에 그대로 붙여 넣고 `Enter`를 누르면 그 폴더가 열려요.

## 27.1 어디에 무엇이 있나요

| 위치 | 들어 있는 것 |
|---|---|
| `%LOCALAPPDATA%\Programs\own-desktop\` | 데스크톱 앱(창) |
| `%APPDATA%\dev.own.opencode.desktop\` | 데스크톱 앱의 데이터: 창 상태, 세션 목록 캐시, 입력 중이던 글, 로그(`logs\`), 모바일 미리보기 기기 |
| `%LOCALAPPDATA%\own-open-code\` | 서비스 폴더. 아래 표 |
| `%USERPROFILE%\.config\own-open-code\` | 설정: `opencode.jsonc`(플러그인 목록, 기본 권한), `service-own.json`(포트, 서비스 비밀번호) |
| `%USERPROFILE%\.local\share\opencode\opencode-own.db` | **세션 DB**: 모든 대화 기록 |
| `%USERPROFILE%\Documents\Own OpenCode\` | **기본 대화 폴더**: 폴더를 고르지 않고 시작한 대화가 일하고 파일을 만드는 곳. 처음 쓸 때 생겨요. `설정` > `일반`에서 다른 폴더로 바꿀 수 있어요([4장](04-first-conversation.md)). 앱을 지워도 그대로 남아요 |
| `%TEMP%\own-installer.log` | 설치 파일과 제거 프로그램의 기록 |

서비스 폴더(`%LOCALAPPDATA%\own-open-code\`) 안

| 이름 | 내용 |
|---|---|
| `bin\` | `own` 명령 |
| `app\<버전>\` | 설치된 서비스(지금 버전과 바로 전 버전). 앱에 든 Claude 구독 플러그인(`plugins\claude-auth`)도 여기 있어요 |
| `accounts.json` | 계정 목록(이름, 종류, 색). 비밀 값은 없어요 |
| `vault\` | API 키와 로그인 토큰. Windows DPAPI로 암호화돼 지금 Windows 사용자만 풀 수 있어요 |
| `ledger\` | 사용량 기록. 토큰 수와 비용만 있고 대화 내용은 없어요 |
| `backup\` | 버전을 바꿀 때 만든 세션 DB 백업(최근 5개) |
| `thirdparty\claude-auth\` | Claude 계정 목록(`claude-accounts.json`)과 계정별 상태(`claude-auth-state\`) |
| `thirdparty\omo\` | omo (원본) 방식의 데이터, 캐시, 기록(`logs\omo.log`, 10 MB를 넘으면 `omo.log.1`로 옮기고 두 개까지 남겨요), 프로젝트별 이어서 하기 상태(`projects\` 아래 프로젝트마다 폴더 하나). 진짜 OpenCode·omo 설치 폴더와 프로젝트 폴더에는 쓰지 않아요 |
| `claude-accounts\` | 더한 Claude 계정의 로그인 폴더 |
| `remote\` | SSH 원격 호스트 상태 |
| `devices.json` | 연결한 휴대폰·다른 PC 목록 |
| `state\import-sources.json`, `state\import-index.json` | 다른 도구의 대화를 찾는 곳과 색인(대화 내용, 제목은 없어요, [21장](21-import-other-tools.md)) |
| `install.log` | 설치·업데이트 기록 |
| `logs\` | 계정 플러그인의 기록(`own-accounts.log`): 한도를 받았는지, 속도를 어떻게 판단했는지, Claude 로그인을 새로 고쳤는지(`claude_refresh_*`). 팀 모드의 기록(`own-team.log`): 팀 작업의 단계, 무엇을 얼마나 기다렸는지, 경고. omo (원본) 방식의 알림(`own-omo.log`) |

> **주의** `vault\`와 세션 DB를 남에게 보내거나 클라우드에 올리지 마세요. 세션 DB에는 대화 전체가 있고, Claude 구독 슬롯을 쓴다면 그 로그인 토큰이 **암호화 없이** 들어 있어요([20장](20-account-kinds.md)).

## 27.2 로그는 어디에 있나요

로그에는 비밀 값(키, 토큰, 비밀번호)을 남기지 않아요.

| 로그 | 위치 |
|---|---|
| 서비스(에이전트, 플러그인) | `%USERPROFILE%\.local\share\opencode\log\` |
| 계정·한도·속도(계정 플러그인) | `%LOCALAPPDATA%\own-open-code\logs\own-accounts.log`. 10 MB를 넘으면 `own-accounts.log.1`로 옮기고 새로 써요. 옮길 수 없을 때도 20 MB를 넘게 커지지 않아요. 토큰과 대화 내용은 적지 않아요 |
| 팀 모드(팀 플러그인) | `%LOCALAPPDATA%\own-open-code\logs\own-team.log`. 크기 규칙은 위와 같아요. 원격 호스트의 팀은 그 호스트의 `~/.local/share/own-open-code/logs/own-team.log`에 적어요. 요청·인계 메모·대화 내용은 적지 않아요 |
| omo (원본) 방식 | `%LOCALAPPDATA%\own-open-code\thirdparty\omo\logs\omo.log`. omo가 쓰는 기록이라 대화 내용 일부가 들어 있을 수 있어요. omo가 화면에 띄우려던 알림(`Todo Continuation`, `Ultrawork Mode Activated` 등)은 `%LOCALAPPDATA%\own-open-code\logs\own-omo.log`에 적어요(10 MB를 넘으면 `own-omo.log.1`로 옮겨요). 없는 스킬 폴더 알림은 문제가 아니라서 적지 않아요 |
| 데스크톱 앱 | `%APPDATA%\dev.own.opencode.desktop\logs\` (앱 오류 화면의 `로그 폴더` 단추로도 열려요) |
| `own` 명령 | PowerShell 화면에 바로 보여요. 앱이 서비스를 못 켜면 끝부분을 보여 줘요 |
| 설치·업데이트 | `%LOCALAPPDATA%\own-open-code\install.log`, `%TEMP%\own-installer.log` |
| SSH 호스트 | 호스트의 `~/.local/share/opencode/log/`. 호스트 상태의 `진단 복사`로 요약을 복사해요([22장](22-ssh-remote.md)) |

> **팁** 문제를 Claude에게 물어볼 때는 증상 문구, `own status` 결과, 해당 로그의 끝부분을 함께 보여 주면 빨라요([부록 C](92-claude-and-you.md)).

## 27.3 백업

- **새 버전을 설치할 때마다** 세션 DB를 `backup\`에 저절로 백업해요(최근 5개). `own rollback`을 할 때도 한 번 더 백업해요([2장](02-install-update.md)).
- 직접 백업하고 싶으면 **서비스를 끈 뒤**(`own stop`) 세션 DB 파일(`opencode-own.db`, 옆에 `-wal`, `-shm`이 있으면 함께)을 복사해 두세요. 켜진 채로 복사하면 깨진 사본이 될 수 있어요.
- 계정 키는 백업해도 **다른 PC나 다른 Windows 사용자에게서는 풀리지 않아요.** 새 PC에서는 계정을 다시 추가해요.

## 27.4 제거하기

### 1단계: 원격부터 정리해요

제거 프로그램은 이 PC 밖의 것을 지우지 못해요. 그래서 먼저 정리해요.

1. **휴대폰·다른 PC**: `설정` > `휴대폰·다른 PC`에서 `모든 기기 연결 끊기`, 그리고 게이트웨이 `끄기`. Tailscale 경로를 열어 두었다면 PowerShell에서 `tailscale serve --https=443 off`와 `tailscale serve --tcp=28540 off`로 꺼요. DDNS 경로를 썼다면 `되돌리는 명령`을 실행하고 공유기의 포트 전달 규칙을 지워요([24장](24-phone-other-pc.md)).
2. **SSH 원격 호스트**: 호스트마다 `⋯` → `목록에서 빼기…` → `원격 설치도 지우기`. 큰 파일 저장소로 팀 모드를 썼다면 **팀 모드를 먼저 끄고** 지워요([23장](23-remote-team.md)).
3. **Claude 구독**: 플러그인은 앱에 들어 있어서 앱과 함께 지워져요. 따로 뺄 것은 없어요. Claude 로그인까지 지우려면 `계정` 화면에서 더한 Claude 계정마다 카드 `⋯` → `계정 빼기…`를 하고 `로그인 폴더도 지우기`에 체크해요. 처음 연결한 계정(슬롯 카드)의 로그인은 Claude Code 자신의 것(`%USERPROFILE%\.claude`)이라 이 앱이 지우지 않아요. Claude Code에서 직접 정리해요. 세션 DB에 들어 있는 Claude 로그인 토큰은 2단계에서 "사용자 데이터도 삭제"를 고르면 세션 DB와 함께 지워져요.
4. **모바일 미리보기**: `설정` > `휴대폰·다른 PC`의 `모바일 미리보기`에서 `지우기`([25장](25-mobile-preview.md)).

### 2단계: Windows에서 제거해요

1. Windows `설정` > 앱 > 설치된 앱에서 **Own OpenCode**를 찾아 "제거"를 눌러요.
2. 제거 프로그램이 차례로 물어요.
   - “Own OpenCode 서비스도 제거할까요?” — "예"(처음 값): 서비스, `own` 명령, PATH 등록을 지워요. "아니요": 데스크톱 앱만 지워요.
   - “사용자 데이터도 삭제할까요? 되돌릴 수 없어요.” — "아니요"(처음 값): 데이터가 남아서, 다시 설치하면 그대로 쓰여요. "예": 아래 표의 것을 모두 지워요.
3. 서비스에서 대화가 실행 중이면 그 전에 먼저 물어요. "아니요"면 아무것도 지우지 않고 끝나요.

- 데스크톱 앱 부분(설치 폴더, 시작 메뉴 바로가기, 알림 등록)은 언제나 지워요.
- 데스크톱 앱 없이 서비스만 지우려면 PowerShell에서 `own uninstall`(데이터 남김) 또는 `own uninstall --remove-data`.

**"사용자 데이터 삭제"를 고르면 지우는 것**

| 지우는 것 | 내용 |
|---|---|
| `%LOCALAPPDATA%\own-open-code\` 전체 | 계정 목록, 암호화된 키, 사용량 기록, DB 백업, 원격 호스트 상태, 기기 목록 |
| `%USERPROFILE%\.config\own-open-code\` | 설정, 서비스 비밀번호 |
| `%USERPROFILE%\.local\share\opencode\opencode-own.db`(와 `-wal`, `-shm`) | 세션 DB. `opencode` 폴더 자체는 원래 OpenCode와 함께 쓰므로 지우지 않아요 |
| `%APPDATA%\dev.own.opencode.desktop\` | 데스크톱 앱 데이터(제거 프로그램에서 "예"일 때) |

### 3단계: 계정 쪽도 끊어요(선택)

- 이 앱을 지워도 각 회사에 만든 **API 키는 살아 있어요.** 더 쓰지 않을 키는 각 회사 콘솔에서 폐기하세요.
- ChatGPT·Sign in with ChatGPT 로그인은 ChatGPT 설정에서 이 앱의 연결을 해제할 수 있어요.
- 이전 앱에서 `연결`로 가져온 로그인 파일은 이 앱이 쓴 것이 아니라서 그대로 남아요.

## 조심하세요

> **주의** "사용자 데이터도 삭제"는 **되돌릴 수 없어요.** 대화 기록을 남기고 싶으면 "아니요"를 고르거나, 먼저 세션 DB를 백업하세요.

> **주의** 제거나 업데이트는 탐색기나 Windows 설정에서 **내가 직접** 해요. Claude 앱의 터미널이나 에이전트 안에서 실행하지 마세요([2장](02-install-update.md)).

> **주의** 휴대폰의 연결을 끊지 않고 PC에서 앱만 지우면, 나중에 다시 설치했을 때 예전 기기 목록이 되살아날 수 있어요(데이터를 남긴 경우). 잃어버린 기기가 있다면 꼭 `연결 끊기`부터 하세요.

## 더 알아보기

- 설치·업데이트·되돌리기: [2장](02-install-update.md)
- 증상별 해결: [26장](26-troubleshooting.md)
- 설계 문서: [05 데스크톱 §10.4 설치·업데이트·제거](../05-desktop-and-mobile.md), [사용 안내서 §2.5, §14, §15](../USER-GUIDE.md)
