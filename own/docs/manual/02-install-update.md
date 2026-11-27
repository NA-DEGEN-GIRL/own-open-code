# 2. 설치·업데이트·되돌리기

**한 줄 요약**: 설치 파일을 **탐색기에서 두 번 누르면** 설치와 업데이트가 한 번에 끝나요. 문제가 생기면 PowerShell에서 `own rollback`으로 되돌려요.

이 장은 `2.0.24-own.1` 설치 파일을 기준으로 써요. 다른 버전도 순서는 같아요.

> **용어** 서비스: 화면 뒤에서 실제로 일하는 프로그램이에요. 식당으로 치면 **주방**이에요. 데스크톱 앱은 손님이 보는 **홀**이고, `own` 명령은 주방 불을 켜고 끄는 **스위치**예요. 홀(창)을 닫아도 주방(서비스)은 하던 요리(대화)를 계속해요.

> **용어** 에이전트: 대화만 하는 AI가 아니라, 내 프로젝트 폴더의 파일을 읽고 고치고 명령을 실행하는 **일꾼 AI**예요. 이 앱이 하는 일이 바로 에이전트를 돌리는 것이에요([1장](01-what-is-it.md)).

> **용어** PowerShell: Windows에 들어 있는 명령 창이에요. 시작 메뉴에서 "PowerShell"을 찾아 열고, 명령을 적은 뒤 `Enter`를 눌러요.

## 2.1 설치 파일 하나로 다 해요

설치 파일 이름은 `own-desktop-<version>-win-x64.exe`예요. 예를 들면 `own-desktop-2.0.24-own.1-win-x64.exe`예요.

이 파일 하나에 세 가지가 함께 들어 있어요.

| 들어 있는 것 | 하는 일 | 설치되는 곳 |
|---|---|---|
| 데스크톱 앱 **Own OpenCode** | 우리가 보는 창 | `%LOCALAPPDATA%\Programs\own-desktop\` |
| 서비스 | 에이전트가 실제로 일하는 곳 | `%LOCALAPPDATA%\own-open-code\` |
| `own` 명령 | 서비스를 켜고 끄는 명령 | 같은 폴더의 `bin\` (PATH에 자동 추가) |

- **관리자 권한이 필요 없어요.** 지금 Windows 사용자에게만 설치돼요.
- 묻는 창 없이 1분 안팎이면 끝나요.
- 설치 파일은 Claude에게 “새로 빌드해 줘”라고 하면 만들어 줘요. 파일은 보통 저장소의 `own\.out\build\<version>\desktop` 폴더에 생겨요. `<version>` 자리에는 버전 이름이 들어가요.
- **실행은 내가 직접 해요.** 이유는 바로 아래 2.2에 있어요.

> **참고** 원래 OpenCode가 이미 깔려 있어도 괜찮아요. 이 앱은 이름, 데이터 파일, 포트가 모두 달라서 나란히 둘 수 있어요.

## 2.2 꼭 탐색기에서 실행하세요

설치 파일은 **파일 탐색기에서 두 번 눌러** 실행해요. 시작 메뉴에서 새로 연 PowerShell 창에서 실행해도 괜찮아요.

**Claude 데스크톱 앱의 터미널이나 에이전트 안에서는 실행하지 마세요.**

<figure class="diagram">
<svg class="dg-wide" viewBox="0 0 720 272" role="img" aria-labelledby="d02-install-where" xmlns="http://www.w3.org/2000/svg" font-family="inherit" style="width:100%;height:auto;max-width:720px">
<title id="d02-install-where">설치 파일을 어디서 실행하느냐에 따라 달라지는 결과</title>
<text x="10" y="22" font-size="15" font-weight="700" fill="#2f9e5f">✓ 이렇게 해요</text>
<rect x="10" y="34" width="210" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="#2f9e5f" stroke-width="2"/>
<text x="115" y="64" font-size="14" text-anchor="middle" fill="currentColor">탐색기에서</text>
<text x="115" y="86" font-size="14" text-anchor="middle" fill="currentColor">설치 파일 두 번 누르기</text>
<line x1="224" y1="71" x2="243" y2="71" stroke="currentColor" stroke-opacity="0.7" stroke-width="2"/>
<polygon points="243,65 252,71 243,77" fill="currentColor" fill-opacity="0.7"/>
<rect x="255" y="34" width="210" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="#2f9e5f" stroke-width="2"/>
<text x="360" y="64" font-size="14" text-anchor="middle" fill="currentColor">진짜 사용자 폴더에 설치</text>
<text x="360" y="86" font-size="12" text-anchor="middle" fill="currentColor" style="font-family:Consolas,'Cascadia Mono',monospace">%LOCALAPPDATA%\own-open-code</text>
<line x1="469" y1="71" x2="488" y2="71" stroke="currentColor" stroke-opacity="0.7" stroke-width="2"/>
<polygon points="488,65 497,71 488,77" fill="currentColor" fill-opacity="0.7"/>
<rect x="500" y="34" width="210" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="#2f9e5f" stroke-width="2"/>
<text x="605" y="64" font-size="14" text-anchor="middle" fill="currentColor">시작 메뉴 앱과 own 명령이</text>
<text x="605" y="86" font-size="14" text-anchor="middle" fill="currentColor">서비스를 찾아요 ✓</text>
<text x="10" y="150" font-size="15" font-weight="700" fill="#d64545">✗ 이렇게 하지 마세요</text>
<rect x="10" y="162" width="210" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="#d64545" stroke-width="2"/>
<text x="115" y="192" font-size="14" text-anchor="middle" fill="currentColor">Claude 앱의</text>
<text x="115" y="214" font-size="14" text-anchor="middle" fill="currentColor">터미널·에이전트가 실행</text>
<line x1="224" y1="199" x2="243" y2="199" stroke="currentColor" stroke-opacity="0.7" stroke-width="2"/>
<polygon points="243,193 252,199 243,205" fill="currentColor" fill-opacity="0.7"/>
<rect x="255" y="162" width="210" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="#d64545" stroke-width="2"/>
<text x="360" y="192" font-size="14" text-anchor="middle" fill="currentColor">파일이 Claude 앱 전용</text>
<text x="360" y="214" font-size="14" text-anchor="middle" fill="currentColor">서랍으로 옮겨져요</text>
<line x1="469" y1="199" x2="488" y2="199" stroke="currentColor" stroke-opacity="0.7" stroke-width="2"/>
<polygon points="488,193 497,199 488,205" fill="currentColor" fill-opacity="0.7"/>
<rect x="500" y="162" width="210" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="#d64545" stroke-width="2"/>
<text x="605" y="192" font-size="14" text-anchor="middle" fill="currentColor">다른 프로그램은 못 봐요</text>
<text x="605" y="214" font-size="14" text-anchor="middle" fill="currentColor">“설치되지 않았어요” ✗</text>
<text x="10" y="262" font-size="13" fill="currentColor" fill-opacity="0.8">새 설치 파일은 아래 줄의 경우를 미리 알아채고, 아무것도 바꾸지 않고 멈춰요.</text>
</svg>
<svg class="dg-narrow" viewBox="0 0 320 500" role="img" aria-label="설치 파일을 어디서 실행하느냐에 따라 달라지는 결과" xmlns="http://www.w3.org/2000/svg" font-family="inherit" style="width:100%;height:auto;max-width:360px">
<defs><marker id="d02n-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" fill-opacity="0.7"/></marker></defs>
<text x="10" y="20" font-size="15" font-weight="700" fill="#2f9e5f">✓ 이렇게 해요</text>
<g fill="currentColor" fill-opacity="0.05" stroke="#2f9e5f" stroke-width="2">
<rect x="10" y="32" width="300" height="46" rx="10"/>
<rect x="10" y="100" width="300" height="60" rx="10"/>
<rect x="10" y="182" width="300" height="46" rx="10"/>
</g>
<g fill="currentColor" font-size="14" text-anchor="middle">
<text x="160" y="60">탐색기에서 설치 파일 두 번 누르기</text>
<text x="160" y="125">진짜 사용자 폴더에 설치</text>
<text x="160" y="146" font-size="12" style="font-family:Consolas,'Cascadia Mono',monospace">%LOCALAPPDATA%\own-open-code</text>
<text x="160" y="210">시작 메뉴 앱과 own 명령이 찾아요 ✓</text>
</g>
<text x="10" y="266" font-size="15" font-weight="700" fill="#d64545">✗ 이렇게 하지 마세요</text>
<g fill="currentColor" fill-opacity="0.05" stroke="#d64545" stroke-width="2">
<rect x="10" y="278" width="300" height="46" rx="10"/>
<rect x="10" y="346" width="300" height="46" rx="10"/>
<rect x="10" y="414" width="300" height="46" rx="10"/>
</g>
<g fill="currentColor" font-size="14" text-anchor="middle">
<text x="160" y="306">Claude 앱의 터미널·에이전트가 실행</text>
<text x="160" y="374">파일이 Claude 앱 전용 서랍으로</text>
<text x="160" y="442">“설치되지 않았어요” ✗</text>
</g>
<g stroke="currentColor" stroke-opacity="0.7" stroke-width="2" marker-end="url(#d02n-arrow)">
<line x1="160" y1="79" x2="160" y2="98"/><line x1="160" y1="161" x2="160" y2="180"/>
<line x1="160" y1="325" x2="160" y2="344"/><line x1="160" y1="393" x2="160" y2="412"/>
</g>
<text x="160" y="488" font-size="12" text-anchor="middle" fill="currentColor" fill-opacity="0.8">새 설치 파일은 이 경우를 알아채고 멈춰요</text>
</svg>
<figcaption>그림: 설치 파일을 어디서 실행하느냐에 따라 설치되는 곳이 달라져요. 실제 화면이 아니라 설명용 그림이에요.</figcaption>
</figure>

**왜 그럴까요?**

1. Claude 데스크톱 앱은 Windows가 **자기만의 서랍**을 주는 앱이에요.
2. 그 앱 안에서 실행된 프로그램이 `%LOCALAPPDATA%`에 파일을 쓰면, Windows가 그 파일을 Claude 앱 전용 서랍(`%LOCALAPPDATA%\Packages\Claude_…\LocalCache`)으로 옮겨요.
3. 그 서랍은 Claude 앱만 볼 수 있어요.
4. 그래서 시작 메뉴의 Own OpenCode는 서비스를 찾지 못하고 `Own OpenCode가 설치되지 않았어요`를 보여요.

**새 설치 파일은 미리 막아 줘요.** Claude 앱 안에서 실행되면 이런 창을 띄우고 아무것도 바꾸지 않고 끝나요.

> “이 설치 파일이 다른 앱(예: Claude 데스크톱 앱의 터미널이나 에이전트) 안에서 실행됐어요. … 아무것도 바꾸지 않고 끝내요. 탐색기에서 설치 파일을 두 번 눌러 실행하세요.”

이 창이 떴다면 아무 일도 일어나지 않은 거예요. 탐색기에서 다시 실행하면 돼요.

> **주의** “Claude야, 설치 파일 실행해 줘”라고 부탁하지 마세요. 빌드는 Claude가 하고, **설치 파일 실행은 언제나 내가** 해요.

## 2.3 “Windows의 PC 보호” 창이 뜨면

이 설치 파일에는 **디지털 서명이 없어요.** 그래서 경우에 따라 Windows가 경고해요.

| 경우 | 경고 |
|---|---|
| 이 PC에서 직접 빌드한 파일 | 보통 경고가 없어요 |
| 다른 PC에서 복사했거나 인터넷에서 받은 파일 | “Windows의 PC 보호”(SmartScreen) 창이 떠요 |

경고가 뜨면 이렇게 해요.

1. 파일을 어디서 받았는지 먼저 확인해요. 내가 빌드했거나 믿을 수 있는 곳에서 받은 파일이어야 해요.
2. “추가 정보”를 눌러요.
3. “실행”을 눌러요.

> **주의** 이 버튼은 **내가 직접** 눌러요. 출처를 모르는 파일이면 실행하지 마세요.

## 2.4 처음 실행하기

1. 설치가 끝나면 **Own OpenCode** 창이 저절로 열려요. 다음부터는 시작 메뉴에서 **Own OpenCode**를 열면 돼요.
2. 서비스가 꺼져 있으면 앱이 알아서 켜요. 그동안 `서비스를 시작하는 중이에요…`가 보여요.
   - 맨 처음 실행은 Windows Defender 검사 때문에 조금 느릴 수 있어요.
   - 처음 켤 때 설정 파일과 서비스 비밀번호를 알아서 만들어요. 따로 할 일은 없어요.
3. 첫 화면에 `첫 계정을 추가하세요`가 보이면 준비 끝이에요. 다음은 [3장 첫 계정 연결하기](03-first-account.md)예요.

**처음에 알아 두면 좋은 네 가지**

- **창을 닫아도 일은 계속돼요.** X를 누르면 앱은 트레이(작업 표시줄 오른쪽 알림 영역)로 들어가고, 에이전트가 하던 턴은 서비스에서 계속 돌아요. 트레이 아이콘을 누르면 창이 다시 열려요.
- **모두 끄려면** 트레이 아이콘을 오른쪽 클릭해 `완전 종료…`를 골라요. 무엇이 멈추는지 먼저 물어봐요([5.10](05-screen-tour-theme.md)). 서비스만 끄려면 PowerShell에서 `own stop`을 실행해도 돼요.
- **방화벽 허용 창이 떠도 허용할 필요 없어요.** 이 앱이 여는 연결은 모두 이 PC 안(`127.0.0.1`)에서만 열려요. 다른 PC나 인터넷에 스스로 문을 열지 않아요. 휴대폰 연결을 DDNS 방식으로 준비할 때만 내가 직접 포트를 열어요([24장](24-phone-other-pc.md)).
- **환경 변수에 넣어 둔 API 키는 쓰지 않아요.** 일부러 그렇게 만들었어요. 키는 앱 안에서 계정으로 추가해요(3장).

> **팁** 데스크톱 앱이 아니라 브라우저로 열고 싶으면 PowerShell에서 `own open --browser`를 실행해요. 다만 브라우저로 열면 앱 안 브라우저 패인, Windows 폴더 선택 창, 서비스 다시 시작 버튼이 없어요.

## 2.5 `own` 명령: 서비스 스위치

설치하면 `own` 명령이 생겨요. **설치 뒤에 새로 연 PowerShell 창**부터 쓸 수 있어요.

자주 쓰는 것만 모았어요.

| 명령 | 하는 일 |
|---|---|
| `own status` | 서비스가 켜져 있는지, 버전과 주소를 보여 줘요 |
| `own start` | 서비스를 켜요 |
| `own stop` | 서비스를 꺼요. 실행 중인 대화가 있으면 먼저 물어요 |
| `own restart` | 껐다가 다시 켜요 |
| `own open --browser` | 브라우저로 앱 화면을 열어요 |
| `own version` | `own` 명령과 서비스의 버전을 보여 줘요 |
| `own rollback` | 바로 전 버전으로 되돌려요(2.7) |
| `own restart --untrusted` | 믿을 수 없는 저장소를 열 때, 프로젝트 설정과 플러그인을 모두 끄고 다시 켜요 |

> **참고** 서비스는 반드시 `own` 명령(또는 데스크톱 앱)으로 켜요. `opencode.exe`를 직접 실행하지 마세요. `own`이 환경을 정리하고 설정을 맞춘 뒤 켜 주기 때문이에요.

## 2.6 업데이트하기

**새 버전의 설치 파일을 탐색기에서 실행하면 끝이에요.** 따로 지울 것도, 옮길 것도 없어요.

설치 파일은 이 순서로 일해요.

1. **실행 중인 대화가 있으면 먼저 물어요.** “Own OpenCode 서비스에서 대화가 실행 중이에요. … 지금 서비스를 멈추고 업데이트할까요?”
   - “아니요”를 누르면 **아무것도 바꾸지 않고** 끝나요. 턴이 끝난 뒤 다시 실행하면 돼요.
2. 열려 있는 앱 창을 닫고 새 앱으로 바꿔요.
3. 서비스를 멈춰요.
4. **대화 기록(세션 DB)을 자동으로 백업해요.** 최근 5개까지 남겨요.
5. 새 버전을 설치해요. **바로 전 버전은 되돌리기용으로 남겨 둬요.** 그보다 오래된 버전은 지워요.
6. 서비스를 새 버전으로 다시 켜요. 새 서비스가 뜨지 않으면 **알아서 전 버전으로 되돌리고** 알려 줘요.
7. 새 앱을 열어요.

**이런 경우도 있어요**

- **설치하는 도중에 대화가 시작되면** 한 번 더 물어요. 이때 “아니요”를 누르면 앱만 새 버전이 되고 서비스는 전 버전으로 남아요.
  - 그러면 앱이 `앱 셸과 화면 버전이 맞지 않아요`를 보일 수 있어요. 그동안은 `브라우저로 열기`로 쓰고, 대화가 끝난 뒤 설치 파일을 다시 실행해요.
- **같은 버전의 설치 파일을 다시 실행하면** 앱만 다시 설치하고 서비스는 그대로 둬요.
- SSH로 연결한 원격 호스트는 따로 `업데이트 필요`가 떠요. 호스트마다 업데이트해요([22장](22-ssh-remote.md)).
- 앱이 스스로 업데이트하지는 않아요. 새 기능은 언제나 새 설치 파일로 와요.
- **Claude 구독 플러그인도 앱과 함께 와요.** 앱에 들어 있어서 업데이트할 때마다 그 버전에 맞는 것으로 바뀌어요. 따로 받거나 설치하지 않아요([3장](03-first-account.md) 3.7).
  - 예전 버전에서 그 플러그인을 직접 설치해 썼다면, 업데이트가 설정을 앱에 든 플러그인으로 저절로 바꿔요. 업데이트가 끝나면 예전 설치 파일(`%LOCALAPPDATA%\own-open-code\thirdparty\claude-auth\`의 `node_modules` 등, 130 MB쯤)도 지워요.
  - Claude 계정 목록, 계정별 상태, 계정의 로그인 폴더, 연결한 로그인은 그대로예요. **다시 로그인하지 않아도 돼요.** 예전에 한 동의도 더는 필요 없어요.
  - 업데이트 직후 Claude 카드에 `앱에 든 Claude 구독 플러그인이 아직 쓰이지 않고 있어요. 서비스를 다시 시작하면 불러와져요.`가 보이면 `지금 다시 시작`을 눌러요.

> **주의** 업데이트를 위해 서비스를 멈추면 **진행 중인 턴은 중단돼요.** 다음에 켜질 때 이어서 실행되지만, 대화 앞부분 캐시는 식어요. 그래서 다음 요청이 조금 비쌀 수 있어요. 긴 작업이 끝난 뒤에 업데이트하세요.

> **용어** 캐시: 프로바이더가 같은 대화의 앞부분을 기억해 두는 것이에요. 기억이 남아 있으면(따뜻하면) 싸고, 오래 쉬면 식어요. 자세한 내용은 [11장](11-cache-switch-cost.md)에 있어요.

## 2.7 되돌리기: `own rollback`

새 버전에 문제가 있으면 PowerShell에서 되돌려요.

| 명령 | 하는 일 |
|---|---|
| `own rollback` | 바로 전 버전으로 돌아가요. 한 번 더 하면 다시 새 버전이에요 |
| `own rollback --to <version>` | 남아 있는 다른 버전으로 돌아가요 |
| `own rollback --restore-db` | 대화 기록까지 업데이트 전 백업으로 되돌려요 |

- 서비스가 켜져 있으면 멈추고 전 버전으로 다시 켜요. 실행 중인 대화가 있으면 먼저 물어요.
- 대화 기록은 **기본으로 그대로** 써요. 되돌리기 전에 지금 기록도 한 번 더 백업해요.
- 전 버전이 새 버전의 대화 기록을 열지 못해서 서비스가 뜨지 않을 때만 `--restore-db`를 써요.

> **주의** `own rollback --restore-db`를 쓰면 **업데이트 뒤에 만든 대화는 사라져요.** 사라지는 기록도 먼저 백업해 두지만, 꼭 필요할 때만 쓰세요.

> **참고** 데스크톱 앱은 되돌리지 않아요. 되돌린 뒤 앱이 `앱 셸과 화면 버전이 맞지 않아요`를 보이면, 그 버전의 설치 파일을 탐색기에서 실행해요.

> **참고** Claude 구독 플러그인이 앱에 들어오기 전의 버전으로 되돌리면, 그 버전에서는 Claude 구독 플러그인을 다시 설치해야 해요. 예전 설치 파일은 업데이트 때 지워졌기 때문이에요.

## 2.8 조용히 설치하기 (선택)

창 없이 설치하고 싶으면 **시작 메뉴에서 연** PowerShell에서 이렇게 해요.

```powershell
Start-Process -Wait .\own-desktop-2.0.24-own.1-win-x64.exe -ArgumentList '/S'
```

- **`-Wait`를 꼭 붙여요.** 설치 파일은 곧바로 돌아오고, 서비스 부분은 마지막에(보통 30초~1분 뒤) 설치되기 때문이에요.
- 결과는 종료 코드로 알 수 있어요. `(Start-Process -Wait -PassThru …).ExitCode`로 봐요.

| 종료 코드 | 뜻 |
|---|---|
| 0 | 성공 |
| 4 | 서비스에서 대화가 실행 중이라 바꾸지 않았어요 |
| 5 | Claude 앱 같은 다른 앱 안에서 실행되어 바꾸지 않았어요(2.2) |

- 기록은 `%TEMP%\own-installer.log`와 `%LOCALAPPDATA%\own-open-code\install.log`에 남아요.

## 2.9 외부 도구 업데이트

own은 이 PC에 **내가 따로 설치한 프로그램** 몇 가지를 써요. 이것들은 own 설치 파일로 바뀌지 않아요. `설정 > 업데이트`(고급 묶음)에서 버전을 보고 업데이트해요.

| 프로그램 | own이 쓰는 곳 | own이 보는 기준 |
|---|---|---|
| Claude Code | Claude Agent 계정의 대화([20장](20-account-kinds.md) 20.8) | 2.1.248보다 오래되면 대화가 막혀요(`필요`). 2.1.257보다 오래되면 문맥 크기를 몰라요. own이 맞춰 만든 2.1.301보다 오래되면 `업데이트 권장`이에요 |
| Git | 팀 모드, 작업 폴더, GitHub 로그인 | 2.40보다 오래되면 팀 모드를 못 켜요. 2.42보다 오래되면 큰 파일까지 다 받는 폴더를 만들어요 |
| git-lfs | 팀 모드의 큰 파일 | 3.8.1보다 오래되면 보안 문제(CVE 4건)가 남아 있어 `업데이트 권장`이에요 |
| GitHub CLI(`gh`) | 팀 모드의 PR 만들기(있을 때만) | 새 판이 나오면 알려 줘요 |
| ripgrep | 파일 찾기(PATH에 있을 때만) | PATH에 없으면 own이 받아 둔 15.1.0을 써요 |
| github-mcp-server | 설정 > GitHub에서 로컬 서버를 고른 경우만 | own이 읽기 도구를 확인한 판은 2.0.3이에요 |

**한 줄씩 읽는 법**

- `설치됨 …`과 `최신 …`, 그리고 상태가 보여요. `최신`, `업데이트 권장`(이유가 함께 나와요), `필요`(기능이 막혀요), `설치 안 됨`이에요.
- **`업데이트`** 단추는 own이 공식 명령을 실행할 수 있는 것에만 보여요. 지금은 내 사용자 폴더에 설치한 Claude Code(`claude update`)가 그래요.
  1. 누르면 확인 창이 떠요. **실행할 명령**(`claude update`), 실행 파일 위치, **공식 안내 페이지**가 보여요.
  2. `실행`을 눌러야만 실행해요. 출력이 창에 그대로 흘러나와요.
  3. 실행하는 동안 **걸린 시간**이 보여요. Claude Code는 새 판을 내려받는 동안 출력이 멈춰 있어서(예: `Updating to 2.1.319...`에서 몇 분) 멈춘 것처럼 보일 수 있어요. 그래서 내려받는 파일의 크기도 1초마다 보여 줘요. 예: `내려받는 중 · 128 MB · 1분 12초`. 이 크기가 늘고 있으면 잘 되고 있는 거예요. 전체 크기는 알 수 없어서 따로 보이지 않아요.
  4. 끝나면 버전을 다시 읽어 `끝났어요. 지금 버전: …`과 `걸린 시간 3분 2초 · 내려받은 크기 345 MB`를 보여 줘요. 실패하면 `실패했어요(종료 코드 …)`와 출력이 남아요.

**업데이트가 오래 걸릴 때**

- 큰 업데이트는 **몇 분** 걸릴 수 있어요. 2.1.282에서 2.1.319로 갈 때 약 345 MB를 받느라 3분쯤 걸렸어요.
- 창을 **닫아도 업데이트는 계속돼요**. own 서비스가 끝까지 지켜보고 버전을 다시 읽어요. 다시 보려면 `설정 > 업데이트`에서 그 줄의 **`진행 보기`**를 눌러요(대화의 한 줄에서 `업데이트`를 눌러도 같아요). `이미 실행 중인 업데이트예요. 이어서 보여 드려요`가 뜨고 처음부터 출력이 이어져요.
- 창에는 멈추는 단추가 없어요. 내려받다가 끊으면 설치가 어중간하게 남을 수 있어서예요.
- **10분**이 넘으면 창에 안내가 하나 더 떠요. 내려받은 크기가 계속 늘고 있으면 조금 더 기다려요. 크기가 그대로이거나(npm으로 설치한 Claude Code는 크기가 보이지 않아요) 출력이 오래 그대로면 네트워크를 확인해요.
- **60분**이 지나도 끝나지 않으면 own이 멈추고 `60분이 지나도 끝나지 않아 own이 멈췄어요. 출력을 확인하고 터미널에서 직접 실행해 보세요.`를 보여 줘요. 이때는 터미널에서 직접 `claude update`를 실행해 봐요.
- 업데이트 중에 own 서비스가 다시 시작되면 진행 상황은 사라져요(`own 서비스가 다시 시작돼서 진행 상황을 잃었어요`). 잠시 뒤 `지금 확인`을 눌러 버전을 확인해요.
- 단추가 없는 것은 **직접 할 방법**이 보여요. own이 대신 실행하지 않는 이유도 함께 나와요.
  - `관리자 권한이 필요해요`: Program Files에 모든 사용자용으로 설치된 것(Git for Windows, GitHub CLI)이에요. own은 관리자 권한으로 실행하지 않아요. 보이는 명령(`git update-git-for-windows`, `winget upgrade --id GitHub.cli -e`)을 **복사**해서 직접 터미널에서 실행해요.
  - `Git을 업데이트하면 같이 바뀌어요`: Git for Windows에 든 git-lfs예요. Git을 업데이트하면 돼요.
  - `스스로 업데이트하는 명령이 없어요`: `공식 안내`에서 새 판을 받아요.
- **`Windows가 실행을 막았어요`**가 뜨면 스마트 앱 컨트롤이나 백신이 막은 거예요. own은 이것을 우회하지 않아요. 공식 안내대로 직접 업데이트해요.

**새 버전 확인**

- 하루에 한 번 npm 레지스트리와 GitHub 릴리스에서 **최신 버전 번호만** 읽어요. 로그인 정보나 계정은 보내지 않아요.
- `새 버전 확인`을 `끔`으로 바꾸면 읽지 않아요. 그래도 설치된 버전과 기능 기준(`필요`, `업데이트 권장`)은 보여요.
- `지금 확인`은 바로 다시 읽어요(5분에 한 번까지).

**Claude Agent 대화에서**

- Claude Agent 계정으로 대화할 때 Claude Code가 기준보다 오래됐으면 입력창 위에 한 줄이 떠요. 예: “Claude Code 2.1.282: own의 Claude Agent가 맞춰 만든 Claude Code 2.1.301보다 오래됐어요. …”
- `업데이트`를 누르면 위와 같은 확인 창이 떠요. `닫기`를 누르면 이 창에서는 다시 보이지 않아요.

**SSH 호스트와 로컬 모델 서버**

- **SSH 호스트**는 own이 올린 것(own 원격 번들과 git-lfs 3.8.1)만 보여요. 호스트에 있는 Claude Code는 여기서 업데이트하지 않아요. 호스트에서 직접 `claude update`를 실행해요. 호스트의 own 판이 이 PC와 다르면 `필요`와 `호스트 업데이트`가 떠요. 이 단추는 [22장](22-ssh-remote.md)의 호스트 업데이트와 같아요. 호스트에서 다른 명령은 실행하지 않아요.
- **로컬 모델 서버**(Ollama 등)는 버전만 보여 줘요. 업데이트는 각 프로그램에서 해요.

> **참고** Codex CLI는 여기 없어요. own의 Codex 방식은 own이 만든 것이라 `codex` 프로그램을 실행하지 않아요.

> **주의** 휴대폰이나 다른 PC의 창에서는 이 페이지가 보이지 않아요. 프로그램 위치가 나오고, 업데이트가 이 PC에서 프로그램을 실행하기 때문이에요.

## 알아 두면 좋아요

- 설치하는 동안 1.5 GB 안팎의 여유 공간이 잠깐 필요해요. 설치 뒤에는 앱과 서비스 버전 두 개(지금 것, 전 것)가 남아요.
- 이 앱은 앱 자동 업데이트, `opencode://` 같은 링크 등록을 하지 않아요.
- 제거하는 방법과 데이터가 남는 곳은 [27장](27-data-logs-uninstall.md)에 있어요.

## 조심하세요

> **주의** 설치 파일은 **탐색기에서** 실행해요. Claude 앱의 터미널이나 에이전트 안에서 실행하면 설치되지 않아요(2.2).

> **주의** 방화벽, 사용자 계정 컨트롤(UAC), SmartScreen 같은 Windows 보안 창은 **내가 직접** 판단해요. 이 앱은 방화벽 허용이 필요 없어요.

> **주의** 업데이트하면 진행 중인 턴이 중단되고 캐시가 식어요. 긴 작업이 끝난 뒤에 하세요.

## 더 알아보기

- 증상별 해결(서비스가 안 뜸, “설치되지 않았어요”, 버전이 맞지 않음): [26장](26-troubleshooting.md)
- 데이터 위치, 로그, 제거: [27장](27-data-logs-uninstall.md)
- Claude에게 맡길 것과 직접 할 것: [부록 C](92-claude-and-you.md)
- 설계 문서: [01 구성·서비스](../01-architecture.md), [05 데스크톱 §10.4 설치·업데이트·제거](../05-desktop-and-mobile.md)
