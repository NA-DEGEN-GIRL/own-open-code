# 16. GitHub 연결 (여러 계정)

| 항목 | 값 |
|---|---|
| 문서 상태 | v0.4 (2026-11-02). v0.3까지는 브랜치 `github-plugin`(MVP, 검토 수정 GH-13–GH-36, 2.2.1-own.1에 들어감). v0.4는 브랜치 `github-remote`(main `2eef2fc386` 위): SSH 원격 호스트의 GitHub 도구와 git을 PC가 중계한다(§8, GH-37–GH-44), main에 합치지 않음. v0.5(같은 브랜치): 적대적 검토의 수정 GH-45–GH-52(GitHub 답의 확인, LFS batch, `service` 하나, 명령에 묶인 티켓, 호스트별 쓰기 허용, 중계 결과의 전체 가리기) |
| 목적 | Codex·Claude의 GitHub 연결처럼 대화에서 GitHub를 쓰되, own의 모든 에이전트 방식·팀 모드에서, 여러 GitHub 계정을 동시에 연결하고 프로젝트·팀 영역·대화마다 고른다 |
| 사용자 요청 | "개별 워크트리로 github 플러그인을 만들어주면 좋을듯. 혹은 이미 사용가능한게 있으려나? … 여러계정 연결도 가능해야하고" (2026-10-31) |
| 관련 문서 | 02(own.accounts, 보관함), 03 §18.14(MCP 서버), 06 §7.5(원격에 올리기), 10(하네스), 결정 로그 GH, 설명서 28장 |

---

## 0. 결정 (GH)

| 번호 | 결정 |
|---|---|
| GH-D1 | 새 플러그인을 만들지 않고 own.accounts의 모듈(`packages/own-accounts/src/github/`)로 만든다. 보관함, RPC 표와 권한 범위, `REMOTE_MANAGED`, MCP 클라이언트, 시험 키트가 이미 거기 있다. 런처·릴리스 번들·관리 설정은 바뀌지 않는다 |
| GH-D2 | 도구는 GitHub 공식 MCP 서버(`github/github-mcp-server`)의 도구를 그대로 쓴다. own은 그 앞에서 계정을 고르는 MCP 클라이언트이고, 도구를 core에 네이티브 도구(`github` 네임스페이스)로 등록한다. 계정마다 MCP 세션이 따로라서 대화마다 다른 계정이 가능하다 |
| GH-D3 | 기본 서버는 GitHub가 운영하는 서버(`https://api.githubcopilot.com/mcp/`, PAT를 `Authorization: Bearer`로)다. 내려받을 바이너리가 없다. GitHub Enterprise Server나 오프라인 선호는 이 PC의 `github-mcp-server stdio`를 계정마다 하나씩 돌린다(토큰은 그 프로세스의 환경 변수에만) |
| GH-D4 | 인증은 세분화 PAT 붙여 넣기를 기본으로 한다. 브라우저 로그인(device flow)은 사용자가 등록한 자기 OAuth 앱·GitHub 앱의 Client ID가 있을 때만 켠다. own은 다른 제품(GitHub CLI 등)의 Client ID를 쓰지 않는다 |
| GH-D5 | 계정은 기본적으로 읽기만 한다. 계정마다 `쓰기 허용`을 켜야 쓰기 도구가 보이고, 쓰기는 매번 승인을 묻는다(`github.write`, 모든 승인 모드, 모든 에이전트와 대화에서: §5.4). `항상 허용`은 GitHub가 허용하는 이름의 도구·저장소와 그 계정에만 저장되고, core가 그 규칙을 지금 갖고 있을 때만 통한다. 읽기만 하는 계정은 git push도 하지 않는다(단, 마음먹은 에이전트를 막는 단단한 경계는 아니다: §6.6) |
| GH-D6 | git 로그인은 사용자의 `~/.gitconfig`를 건드리지 않는다. own이 띄우는 git·gh 프로세스에만 `GIT_CONFIG_*` 환경 변수로 자격 증명 도우미를 넣고, 도우미는 그 명령 동안만 사는 서명된 티켓으로 127.0.0.1의 own에게 묻는다. 이 서비스의 git이 가진 바로 그 HTTP 전송과 git-lfs 프로그램만 답을 받는다. 그래서 이 PC의 git 로그인은 Windows에서만 넣는다(호출자를 확인할 수 있는 곳). 토큰은 파일·환경 변수·명령줄에 없고, 도구 결과에 나오면 가린다. SSH 호스트의 git은 §8의 중계를 쓴다 |
| GH-D7 | 계정 선택 순서: 대화(루트 대화) → 가장 깊은 프로젝트 폴더 → 연결된 git 워크트리(팀 영역)의 본 체크아웃 폴더 → 기본 계정. `off`는 거기서 멈춘다. SSH 호스트의 폴더·대화도 같은 순서로, 그 호스트의 선택 중에서 고른다(§8.3) |
| GH-D8 | SSH 원격 호스트의 GitHub 도구와 git은 PC가 중계한다(§8, GH-37). 토큰은 PC를 떠나지 않는다: 도구는 PC가 부르고, git은 PC가 요청에 로그인을 붙여 GitHub로 보낸다. 호스트에는 토큰도, 토큰을 담은 git 자격 증명 답도 가지 않는다 |
| GH-D9 | 코어 패치는 둘: P-046은 core 셸 훅(`create.before`)이 명령을 시작한 대화의 ID(GH-14)와 명령 자신의 ID(GH-27)를 받는다. P-047은 권한 훅(`evaluate`)이 그 동작의 저장된 `항상 허용` 목록을 받는다(GH-26). 그 밖에는 플러그인 seam만 쓴다 |

---

## 1. 조사: 이미 있는 것 (2026-10-31)

### 1.1 GitHub 공식 MCP 서버

- 저장소 `github/github-mcp-server`(MIT). 최신 v2.0.3(2026-10-21). 릴리스 자산: Windows x86_64/arm64/i386 zip, macOS·Linux tar.gz, `…_checksums.txt`. 바이너리는 GitHub artifact attestation(빌드 출처 증명)이 붙고, Docker 이미지 `ghcr.io/github/github-mcp-server`는 cosign 서명이다.
- **원격 서버**: `https://api.githubcopilot.com/mcp/`(데이터 거주 GHE.com은 `https://copilot-api.<sub>.ghe.com/mcp`). 경로 `/readonly`, `/x/<toolset>`, `/x/<toolset>/readonly`. 헤더 `X-MCP-Toolsets`, `X-MCP-Tools`, `X-MCP-Readonly`, `X-MCP-Lockdown`, `X-MCP-Insiders`. 인증은 호스트 앱의 OAuth(앱마다 GitHub App/OAuth App 등록 필요) 또는 `Authorization: Bearer <PAT>`. README: 원격 MCP를 지원하는 호스트는 PAT 방식으로 쓸 수 있다.
- **로컬 서버**: `github-mcp-server stdio`(한 프로세스에 자격 증명 하나: `GITHUB_PERSONAL_ACCESS_TOKEN`, OAuth, GitHub App 중 하나), `github-mcp-server http`(자격 증명 없음, 요청마다 클라이언트의 `Authorization`). 플래그 `--toolsets`, `--tools`, `--exclude-tools`, `--read-only`, `--gh-host`, `--lockdown-mode`, `--insiders`. 환경 변수 `GITHUB_TOOLSETS`, `GITHUB_READ_ONLY`, `GITHUB_HOST`(https만) 등. 동적 toolset은 v1.1.0에서 없어졌다.
- **toolset**: context, actions, code_quality, code_security, copilot, dependabot, discussions, gists, git, issues, labels, notifications, orgs, projects, pull_requests, repos, secret_protection, security_advisories, stargazers, users 등. 기본은 context, repos, issues, pull_requests, users. 모든 도구에 `readOnlyHint`가 붙고, `--read-only`는 쓰기 도구를 숨긴다. 클래식 `ghp_` 토큰은 범위(scope)에 따라 도구가 걸러진다.
- **여러 계정**: 서버 자체에는 없다. stdio는 프로세스당 한 계정, http·원격은 요청마다 토큰을 받으므로 클라이언트가 계정마다 세션을 나누면 된다(own이 하는 방식).

### 1.2 OpenCode의 GitHub 기능

- `opencode github install`/`run`: GitHub Actions에서 `/opencode`·`/oc` 댓글에 응답하는 에이전트. `opencode-agent` GitHub App을 설치하고, Actions OIDC 토큰을 opencode 서버에서 그 앱의 설치 토큰으로 바꾼다(`use_github_token: true`면 워크플로 토큰). 대화형 연결이 아니라 CI 기능이다.
- OpenCode 문서의 MCP 설정(`type: "remote"`, `headers`, `{env:VAR}`)으로 원격 GitHub MCP를 붙일 수는 있다. 다만 값이 설정 파일·환경 변수에 있고, 위치(Location)마다 계정 하나다. 문서는 GitHub MCP가 문맥을 많이 쓴다고 경고한다.
- 커뮤니티: npm `opencode-github`(gh로 PR 목록 보기, 읽기 전용), 릴리스 플러그인 등. 여러 GitHub 계정을 다루는 OpenCode 플러그인은 찾지 못했다.

### 1.3 gh CLI 여러 계정

- v2.40.0(2023-12)부터 호스트마다 여러 계정: `gh auth login`(device flow, gh 자체 OAuth 앱), `gh auth switch --hostname --user`, `gh auth status`, `gh auth token --user`. 토큰은 OS 자격 증명 저장소(없으면 `hosts.yml` 평문).
- `gh auth setup-git`은 `credential.https://<host>.helper`를 빈 값 다음 `!gh auth git-credential`로 쓴다. 이 도우미는 **활성 계정** 하나만 주며, 폴더·원격에 따른 자동 전환은 gh가 범위 밖이라고 밝혔다.
- `GH_TOKEN`/`GITHUB_TOKEN`(github.com·ghe.com), `GH_ENTERPRISE_TOKEN`·`GH_HOST`(GHES)가 저장된 로그인보다 우선한다.
- gh의 OAuth 앱 Client ID를 다른 도구가 쓰지 말라는 공개 규칙은 찾지 못했지만, GitHub는 사용자·앱·범위마다 토큰을 10개까지만 두고 오래된 것을 폐기한다. 남의 Client ID로 토큰을 만들면 사용자의 gh 로그인이 끊길 수 있다.

### 1.4 Codex와 Claude의 GitHub 연결

| | Codex(클라우드) | Claude |
|---|---|---|
| 연결 | "ChatGPT Codex Connector" GitHub App을 조직·저장소에 설치 | Claude.ai: 커넥터(읽기 전용: 파일·브랜치 내용). Claude Code 웹: Claude GitHub App 또는 `/web-setup`(로컬 `gh auth token`을 올림) |
| 닿는 저장소 | 앱이 설치되고 사용자가 접근할 수 있는 저장소(전부 또는 고른 것) | 앱 설치 저장소 또는 그 토큰이 닿는 저장소 |
| 할 수 있는 일 | 클라우드에 체크아웃, 결과로 PR 열기, PR에서 `@codex review` | Claude Code 웹: 클론, 브랜치 push(프록시가 브랜치 push만 허용), PR. Actions: `/install-github-app` |
| 인증 | GitHub App 설치 토큰 | 앱 또는 업로드한 gh 토큰. 자격 증명은 VM에 들어가지 않고 프록시가 바꿔 끼운다 |
| 여러 계정 | 한 번에 GitHub 사용자 하나 | claude.ai 계정당 GitHub 연결 하나 |
| 로컬 CLI | 로컬 git·gh(네트워크 승인 필요) | 로컬 git·gh |

정리: 두 제품 모두 "GitHub 앱 + 계정 하나"이고, 로컬에서는 사용자의 git·gh 로그인을 그대로 쓴다. own이 더하는 것은 **여러 계정과 위치별 선택**, **쓰기 승인**, **모든 에이전트 방식에서 같은 도구**, **git 로그인의 계정 고르기**다.

### 1.5 토큰과 device flow

- 세분화 PAT: 리소스 소유자 하나(사용자 또는 조직 하나), 저장소 전부/선택/공개만, 권한별 읽기·쓰기(Contents, Pull requests, Issues, Actions, Metadata, Workflows…). 기한은 조직 정책이 없으면 "없음"도 가능. 조직이 승인을 요구하면 승인 전까지 공개 자원만. 계정당 50개.
- device flow: OAuth 앱 설정에서 "Enable Device Flow"를 켠다. `POST /login/device/code` → `POST /login/oauth/access_token`(grant `urn:ietf:params:oauth:grant-type:device_code`). device flow에는 client secret이 필요 없다. 코드는 900초, `slow_down`이면 5초 더.
- GitHub App 사용자 토큰은 8시간(갱신 토큰 6개월)이고, device flow로 받은 토큰은 client secret 없이 갱신할 수 있다. OAuth 앱도 이제 만료 토큰을 고를 수 있다(`offline_access`).

---

## 2. 방식 고르기

| 방식 | 좋은 점 | 아쉬운 점 |
|---|---|---|
| A. core에 GitHub MCP 서버를 설정(own.accounts의 MCP 목록에 계정마다 하나) | 코드가 거의 없다 | 위치마다 서버가 따로라 대화별 계정이 안 된다. 계정이 둘이면 같은 도구가 두 벌 보인다. 쓰기 승인·읽기 전용을 계정별로 못 한다 |
| B. own이 REST로 GitHub 도구를 새로 만든다 | 계정 고르기·승인이 자유롭다 | 공식 서버의 수십 개 도구를 다시 만들고 따라가야 한다 |
| **C. 공식 MCP 서버 + own의 계정 고르기 MCP 클라이언트(선택)** | 공식 도구 그대로, 대화마다 계정, 읽기 전용·쓰기 승인, 토큰은 보관함에서 요청 때만 | own이 MCP 세션을 관리한다(세션 풀, 만료 재시작) |

C를 고른다(GH-D2). 도구 정의는 서버가 준 JSON Schema를 그대로 쓰고, core의 `github` 네임스페이스에 넣어 GitHub MCP 서버를 core에 직접 붙였을 때와 같은 이름(`github_get_file_contents` …, Code Mode에서는 `tools.github.*`)이 된다.

---

## 3. 계정과 선택

### 3.1 저장

- `OWN_HOME\github.json`(`Home.layout().github`): `{version: 1, accounts, default?, projects, sessions, settings, catalog?}`.
  - 계정: `id`(`gh_<ulid>`), 이름(`label`, 대소문자 무시 중복 금지), `site`(웹 주소, 기본 `https://github.com`), `login`, `name?`, `source`(`token`/`device`), `tokenKind`(접두사로: `github_pat_` 세분화, `ghp_` 클래식, `gho_` OAuth, `ghu_` GitHub 앱), `hint`(마지막 네 글자, 12자 이상일 때), `write`, `scopes?`(`X-OAuth-Scopes`), `expiresAt?`(`GitHub-Authentication-Token-Expiration` 또는 device 토큰의 만료), `addedAt`, `checkedAt?`, `problem?`(`token_invalid`, `token_expired`, `vault_missing`).
  - `projects`: `{directory, account: id | "off", host?}`. `sessions`: `{sessionID(루트), account, directory?, host?, at}`(최대 500개, 오래된 것부터 버림). `host`가 있으면 그 SSH 호스트(`OwnRemote.HostID`)의 폴더(그곳의 경로)·대화의 선택이고, 이 PC의 선택과 섞이지 않는다(§8.3).
  - `settings`: `server`(`{type: "remote", url}` 기본 `https://api.githubcopilot.com/mcp/` 또는 `{type: "local", command, args}`), `toolsets`(기본 context, repos, issues, pull_requests, actions), `git`(기본 켬), `clientID?`.
  - `catalog`: 마지막으로 읽은 도구 목록(이름, 설명, 입력 스키마, 읽기 도구인지(§5.2), 서버 이름과 버전, 읽은 설정의 키).
  - `allowed`: 사용자가 `항상 허용`한 쓰기의 own 쪽 기록 `{project(core의 프로젝트 ID), resource("<도구> <owner>/<repo>"), at}`(최대 1,000개). core가 저장한 규칙과 짝이고, 권한 훅이 읽는다(§5.4).
- 모든 Location의 인스턴스가 파일을 쓸 수 있어(거절된 토큰 표시, `항상 허용` 기록) 쓰기는 프로세스 전체에서 파일마다 하나의 뮤텍스로 줄을 선다.
- 토큰: 보관함 항목 `github-<id>` 하나(JSON `{token, refresh?, expiresAt?, refreshExpiresAt?}`). own-runtime `FeatureKeyID`에 `github-*`를 더하고 `Credentials.Service.githubSecret(id)`로만 읽는다.
- 파일·RPC 답·로그·이벤트에 토큰이 없다. `Redact`의 GitHub 패턴은 `github_pat_`도 가린다.

### 3.2 어느 계정을 쓰나

`GitHubResolve.resolve(file, {directory, root?})`:

1. 루트 대화의 선택(하위 에이전트는 부모의 루트를 따른다: 런타임 색인, 없으면 core 세션의 `parentID`).
2. `directory`를 담은 가장 깊은 프로젝트 선택.
3. `directory`가 연결된 git 워크트리면(가장 가까운 `.git`이 파일 `gitdir: …/worktrees/<이름>`이고 그 `commondir`이 `…/.git`) 본 체크아웃 폴더에 대해 2를 다시. 팀 영역(06 §3, `<home>\.worktrees\…`)은 이렇게 프로젝트를 따른다. git을 실행하지 않고 파일만 읽는다.
4. 기본 계정.

`off`를 만나면 거기서 멈추고 GitHub를 쓰지 않는다. 지워진 계정을 가리키는 선택은 없는 것으로 친다. 결과는 `InUse{account?, source: session|project|worktree|default|off|none, directory?}`로 화면의 표시가 된다.

### 3.3 기본 계정과 표시

- 처음 연결한 계정이 기본이 된다.
- 설정 > GitHub 맨 위 `지금 이 프로젝트` 줄이 화면의 프로젝트에서 쓰는 계정과 이유를 보인다(`github.view{directory}`).
- 모든 GitHub 도구 결과는 `GitHub account: <login> (<이름>)` 줄로 시작한다. 모델도 사용자도 어느 계정으로 했는지 안다. 결과 metadata에 `github{account, login, site, write}`.

---

## 4. 인증

### 4.1 토큰 붙여 넣기(기본)

`github.add.token{token, label?, site?, write?}` → `GET <api>/user`로 누구인지 묻고(401·403이면 `github_token_invalid`, 아무것도 저장하지 않음) → 보관함에 먼저, 그다음 파일. API 주소: github.com은 `https://api.github.com`, `<sub>.ghe.com`은 `https://api.<sub>.ghe.com`, 그 밖(GHES)은 `<site>/api/v3`. 다른 엔드포인트만 받은 시험 서비스는 github.com에 묻지 않는다(MCP 레지스트리와 같은 가드). `github.update{token}`은 같은 GitHub 사용자의 토큰만 받는다(`mismatch`).

### 4.2 브라우저 로그인(device flow)

`settings.clientID`(사용자가 등록한 OAuth 앱·GitHub 앱, Device Flow 켬)가 있을 때만. `github.device.start` → 코드와 확인 주소(own-web이 브라우저로 연다) → `github.device.status{nonce}`가 간격을 지켜 묻는다(`slow_down`이면 늘림, 15분 상한) → 토큰을 받으면 4.1과 같이 연결. 범위는 `repo read:org`(OAuth 앱; GitHub 앱은 범위를 무시). 갱신 토큰이 있으면 만료 1분 전부터 요청 때 갱신한다(client secret 없이, 동시에 한 번만).

### 4.3 비교

| | 세분화 PAT | 내 OAuth 앱 device flow | 내 GitHub 앱 device flow | gh 로그인 재사용 |
|---|---|---|---|---|
| 보안 | 저장소·권한을 고름. 기한 선택 | `repo` 범위면 모든 비공개 저장소에 넓은 권한 | 앱 권한 ∩ 설치 저장소, 8시간 토큰 | gh 토큰(`repo, read:org, gist`)을 복사해 공유 |
| UX | GitHub 페이지에서 만들고 붙여 넣기 | 앱 등록 한 번, 그다음 코드 입력만 | 앱 등록·설치 한 번 | 가장 쉽다 |
| 여러 계정 | 계정마다 토큰 | 계정마다 로그인 | 계정마다 로그인 | gh가 이미 여러 계정 |
| own 구현 | 됨 | 됨(Client ID 필요) | 됨(갱신 포함) | 안 함(§11) |

권장: 세분화 PAT. 편의를 원하면 GitHub 앱을 한 번 등록한다.

---

## 5. 도구

### 5.1 서버와 세션

- `GitHubMcp`(own.accounts): 계정마다 MCP 세션 하나, 프로세스 전체가 공유(`globalThis`), 10분 쓰지 않으면 닫는다. 키는 계정 ID·서버·사이트·toolset·읽기 전용 여부·토큰 해시(토큰 아님). 계정의 쓰기 허용·이름·토큰이 바뀌거나 계정을 지우면 그 계정의 세션만 닫고, 서버·toolset 설정이 바뀌면 모두 닫는다(GH-23).
- 사이트와 운영 서버 주소는 https만 받는다. http는 이 PC(`localhost`, `127.0.0.1`, `[::1]`, 시험의 가짜)만(GH-21).
- 운영 서버(Streamable HTTP): 요청마다 `Authorization: Bearer`, `X-MCP-Toolsets`, 읽기만 하는 계정은 `X-MCP-Readonly: true`. JSON과 이벤트 스트림 답, `mcp-session-id`, 404면 세션을 한 번 새로 연다. github.com 계정은 설정의 운영 서버로, `*.ghe.com` 계정은 그 사이트의 운영 서버로 간다. GHES 계정은 로컬 서버만 된다.
- 로컬 서버: `command args`(기본 `github-mcp-server stdio`)를 계정마다 하나 띄운다. 환경은 허용 목록뿐이다(GH-22): 프로그램이 뜨고 파일을 찾고 사용자의 프록시를 쓰는 데 필요한 것(`SystemRoot`, `PATH`, `TEMP`, `USERPROFILE`, `APPDATA`, `HTTPS_PROXY` 등, Claude 로그인 창(P-042)과 같은 목록)에 `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITHUB_TOOLSETS`, 읽기 전용이면 `GITHUB_READ_ONLY=1`, github.com이 아니면 `GITHUB_HOST`. 서비스의 다른 토큰·own·OpenCode 변수는 가지 않는다. Windows에서 `USERNAME`, `USERDOMAIN`, `LOGONSERVER`, `COMPUTERNAME`은 빈 값으로 준다(없으면 Bun·Node가 서비스 것을 다시 넣는다).

### 5.2 도구 목록

- 제어 Location의 인스턴스가 계정을 더할 때, 설정이 바뀔 때, 시작할 때 목록이 없거나 설정이 다르거나 24시간 지났으면 한 계정(선호 → 기본 → 첫 계정, 문제 없는 것)으로 `tools/list`를 읽어 `catalog`에 둔다. 쓰기 도구도 함께 읽는다(읽기 전용 헤더 없이).
- **읽기 도구**(GH-15, `GitHubReads.isRead`): 서버의 `readOnlyHint`만 믿지 않는다. (a) 그 서버 버전의 검토한 목록에 있거나(`github-mcp-server 2.0.3`: 91개 중 읽기 57개), (b) 서버가 `readOnlyHint: true`라고 하고 이름이 읽기처럼 생긴 것(`get_`·`list_`·`search_`로 시작하거나 `_get`·`_list`·`_read`로 끝나고, `create`·`update`·`delete`·`merge`·`mark`·`write` 같은 쓰기 낱말이 없음)만 읽기다. 나머지는 모두 쓰기라서 묻고, 읽기만 하는 계정의 위치에서는 보이지 않는다. 이 판정 전에 저장된 목록도 쓸 때 다시 판정한다.
- 각 Location은 `catalog`로 도구를 등록한다. 제어 Location, 계정 없음, 이 폴더에 쓸 계정이 없음(대화 선택이 이 폴더에서 계정을 고른 경우는 있음으로 침)이면 등록하지 않는다. 읽기 도구는 늘, 쓰기 도구는 이 폴더의 계정이나 이 폴더에서 고른 대화 계정 중 하나가 쓰기를 허용할 때만.
- `github.changed`(브로드캐스트)마다 다시 읽고, 바뀌면 `ctx.tool.reload()`와 로그 `github_tools_offered{location, read, write}`.
- 네임스페이스 `github`(설명: 이 대화·프로젝트의 계정으로, 쓰기는 묻는다). Code Mode 기본값 그대로라 GPT 계열 Code Mode에서도 `tools.github.*`로 쓴다. codex·pi·dsh·omo 하네스는 core의 파일·셸 도구만 바꾸므로 GitHub 도구가 모든 하네스에 보인다.

### 5.3 호출

1. 대화의 계정을 고른다(§3.2). 없으면 "No GitHub account is chosen…", `off`면 꺼짐을 알리는 도구 오류.
2. 계정에 문제가 있으면 그 문구로 오류.
3. 쓰기 도구(§5.2의 읽기가 아닌 모든 도구): 계정이 쓰기를 허용하지 않으면 오류(묻기 전에). 허용하면 `permission.assert{action: "github.write", resources: ["<도구> <owner>/<repo> as <login> (<계정 ID>)"], save, metadata{tool, account, login, site}}`. resource에 계정이 들어가므로 계정 A에서 준 `항상 허용`은 계정 B의 쓰기를 허용하지 않는다(GH-32). `save`는 `owner`·`repo`(그리고 login)가 GitHub가 허용하는 이름일 때만 같은 값이고(GH-16: 소유자는 영문·숫자·`-`·`_` 39자 이하, 영문·숫자로 시작, 저장소는 영문·숫자·`-`·`_`·`.` 100자 이하, `.`·`..` 아님), 아니거나 저장소가 없는 도구면 빈 목록이라 `이번만`만 된다. core는 저장된 resource를 패턴으로 읽으므로(`*`, `?`), 모델이 지어낸 `*/*`가 저장되면 모든 저장소의 쓰기가 허용됐을 것이다.
4. 토큰(갱신 포함)과 대상으로 `tools/call`. 401이면 계정을 `token_invalid`로 표시하고 알린다. 403은 그 저장소·toolset에 닿지 않는 토큰에도 오므로 먼저 `GET /user`로 다시 묻고, 거기서도 거절될 때만 표시한다(GH-20).
5. 결과의 텍스트(텍스트 부분, 텍스트 리소스, 링크)를 `GitHub account: …` 줄 뒤에. `isError`면 도구 오류. 오류와 결과 어디에도 토큰이 보이지 않게 `McpProbe.mask`로 자른다.

### 5.4 쓰기 승인

core의 기본 에이전트 규칙은 `{*: allow}`이고 own의 승인 모드 묶음은 편집·셸 등만 다룬다(03 §18.8). 그래서 `github.write`는 그대로면 묻지 않고 실행된다. 세 겹으로 막고(GH-13), 읽기 전용 역할은 아예 거부한다(4).

1. **에이전트 규칙**: own.accounts가 에이전트 변환으로 `github.write`를 허용하던 모든 에이전트 규칙 끝에 `{github.write, *, ask}`를 붙인다(이미 거부하는 에이전트는 그대로; 규칙 비교는 core의 와일드카드와 같은 방식, Windows에서는 대소문자 무시, GH-23). core는 사용자 설정·Markdown 에이전트를 모든 플러그인 다음에 켜지는 내장 플러그인(`ConfigAgentPlugin`, `Agent.Info.default`의 `{*: allow}`, 전역 설정의 `permission`을 뒤에 붙임)에서 더하므로, 이 변환을 이 Location의 `plugin.updated`마다 다시 등록해 마지막에 둔다(own-computer-use와 같은 방식).
2. **omo의 에이전트와 하위 대화**: own-omo는 하위 에이전트를 런타임이 뜬 뒤 등록하며 규칙 목록을 통째로 바꾸므로, 그 목록(`Agents.permissions`)에 같은 규칙을 직접 넣는다(`OwnGitHub.WRITE_ACTION`). 하위 대화를 만들 때 세션 규칙도 부모의 규칙과 omo의 거부 뒤에 `{github.write, *, ask}`로 끝난다(`host/client.ts`, GH-26).
3. **권한 훅**(조이기만, 읽기 전용 역할의 훅과 같은 방식): `permission` `evaluate`에서 `github.write`가 `allow`로 나오면, core가 지금 이 프로젝트에 저장해 둔 `항상 허용`(코어 패치 P-047이 훅에 주는 `saved`: 그 동작의 저장된 resource 목록)에 그 resource가 그대로 있을 때만 그대로 두고 아니면 `ask`로 바꾼다(GH-26). 에이전트나 대화 규칙이 모든 것을 허용해도(omo의 하위 대화는 v1의 `*: allow`를 세션 규칙으로 받는다, 다른 플러그인이 나중에 바꾼 에이전트) 묻는다. 사용자가 설정 > 승인·권한에서 `항상 허용`을 지우면 다음 쓰기부터 모든 대화에서 다시 묻는다. "그대로"는 같은 글자(Windows에서는 대소문자 무시, core와 같음)이고, 패턴으로 맞추지 않으며(`*`, `octo/*`, 끝의 ` *`), resource가 GitHub가 허용하는 이름의 도구·저장소·login·계정 ID로 읽혀야 한다(GH-31). own은 더 이상 자기 사본(`github.json`의 `allowed`)을 두지 않는다. 첫 검토 뒤의 사본은 allow-all 대화에서 core가 다시 묻지 않으므로 지워지지 않았다(검토 gw1: 지운 뒤에도 omo 하위 대화가 묻지 않고 썼다).

4. **읽기 전용 역할**(MR9-8, 2026-11-02 결정): 하위 에이전트 `explore`(찾기)와 `own-review`(리뷰)는 GitHub 쓰기를 묻지도 않고 거부한다. 읽기 전용 역할의 `evaluate` 훅(07 §2.4)이 거부 목록에 `github.write`를 더해, 들어온 `allow`·`ask`를 `deny`로 바꾸고 모델에 "읽기 전용이라 GitHub를 바꿀 수 없으니 할 변경을 보고하라"는 글을 준다. 저장된 `항상 허용`(3의 훅이 `allow`로 두는 것)도 이 거부를 풀지 못한다. GitHub 읽기는 권한을 묻지 않으므로 그대로 쓴다. 훅 셋(읽기 전용 역할, own-team, GitHub)은 어느 순서로 돌아도 조이기만 하고 서로의 결과를 잃지 않는다(MR9-2).

세션·프로젝트 규칙(`항상 허용`)은 에이전트 규칙 뒤에 오므로 이긴다(읽기 전용 역할의 거부는 예외: 훅이 마지막에 정한다). 승인 모드 묶음은 바꾸지 않는다(모드 읽기 `modeOf`가 그대로).

---

## 6. git 로그인

### 6.1 넣는 곳

- core의 셸(`shell` 훅 `create.before`; opencode·omo 하네스의 셸 도구, 사용자의 `!` 명령, 리뷰 탭의 git 동작). 코어 패치 P-046으로 대화가 시작한 명령은 그 대화의 ID를 가져오고, 그 대화(루트 대화)의 선택이 적용된다(`off`도). 대화 없는 명령은 그 폴더의 계정을 받되, 그 폴더 안팎의 대화(폴더를 모르는 선택은 core의 대화 위치로, 그것도 모르면 안으로 친다) 중 하나라도 다른 계정이나 `off`를 골랐고 그 선택이나 대화가 최근 7일 안에 있었으면 아무것도 넣지 않는다(GH-14, GH-33: 오래된 대화 하나가 리뷰 탭의 계정을 영영 막지 않게. P-046이 없을 때도 이렇게 닫힌 쪽으로).
- codex `exec_command`·pi `bash`·dsh 셸(`GitHubBridge.gitEnv(cwd, {sessionID, signal})`, 대화 선택도 적용), own-team의 `git push`·`git lfs push`(영역 폴더), `gh pr create`(`{gh: true}`로 `GH_TOKEN` 또는 `GH_ENTERPRISE_TOKEN`·`GH_HOST`: own이 직접 띄우는 gh에만; 에이전트 셸에는 넣지 않는다).

### 6.2 넣는 것

계정이 있고 `settings.git`이며 Windows일 때만(다른 곳에서는 호출자를 확인할 수 없어 git은 사용자의 로그인을 그대로 쓴다, GH-34; SSH 호스트는 §8.5의 다른 변수), 기존 `GIT_CONFIG_COUNT` 뒤에:

- `credential.<site>.helper=`(빈 값: 사용자의 Git Credential Manager 등 그 사이트의 도우미를 비움), `credential.<site>.helper=!f() { … curl … "$OWN_GITHUB_CREDENTIAL"; }; f`, `credential.<site>.useHttpPath=true`(요청마다 저장소 경로가 온다, GH-19);
- 읽기만 하는 계정이면 `url.github-account-is-read-only::.pushInsteadOf=<site>/`: 그 사이트로의 push가 git의 원격 도우미 형식(`<이름>::<주소>`)으로 바뀐다. git은 `git-remote-github-account-is-read-only`를 찾지 못해 그 이름을 담은 오류로 곧바로 멈추고, git-lfs는 `missing protocol`로 네트워크 전에 멈춘다. ssh는 시작하지 않는다(GH-17, MR9: 예전 `github-account-is-read-only://`는 git-lfs가 SSH 호스트로 읽어 ssh를 열두 번쯤 돌렸다);
- `OWN_GITHUB_CREDENTIAL=http://127.0.0.1:<port>/git/<티켓>`.

### 6.3 티켓과 수신기

- 티켓: `[티켓 ID, 폴더, 루트 대화?]`의 base64url과 프로세스마다 새 키의 HMAC-SHA256. 재시작하면 무효. 명령마다 새 티켓이고, 그 명령이 끝나면 끝난다(GH-19): 브리지 호출자는 프로세스가 끝나면 `signal`을 끊고(codex `exec_command`의 프로세스, pi·dsh의 명령, own-team의 push·`gh`), core 셸 명령은 그 `shell.exited`(또는 `shell.deleted`)로 끝난다(P-046이 훅에 주는 명령 ID, GH-27). 시간은 **처음 쓸 때부터** 잰다: core는 `create.before`(티켓)를 명령 승인을 묻기 전에 부르므로, 사용자가 늦게 승인한 명령이나 백그라운드로 옮긴 명령도 로그인한다(검토 gw1: 시간 제한 + 1분이 승인 전에 지나 git이 로그인 없이 돌았고, own의 빈 `credential.<site>.helper=` 때문에 사용자의 도우미도 없었다). 끝 신호가 있는 티켓은 신호까지, 명령 ID가 없는 core 셸 명령은 처음 쓴 뒤 시간 제한 + 1분(시간 제한이 없으면 1시간), 신호 없는 브리지 호출은 처음 쓴 뒤 1시간. 어떤 티켓도 만든 지 6시간을 넘지 않는다. 끝난 티켓은 403. 승인이 거절된 명령은 시작하지 않아 끝나지도 않으므로, 끝을 기다리는 명령이 1,000개를 넘으면 시작하지 않은(`shell.created`가 없는) 것 중 가장 오래되고 1분이 지난 것을 놓고 그 티켓을 끝낸다. 시작한 명령의 티켓은 몇 개든 그 명령이 끝날 때까지 둔다(PC와 SSH 호스트 같음, `GitHubCommands`, RL2-L4).
- 수신기는 프로세스에 하나(`Bun.serve` 127.0.0.1:0), POST만, `Origin` 헤더가 있으면(브라우저) 거절, 서명이 틀리거나 티켓이 끝났으면 403.
- **누가 묻나**(Windows, GH-19, `GitHubCaller`): TCP 표(`GetExtendedTcpTable`)로 연결의 상대 프로세스를 찾고, 프로세스 스냅숏으로 부모를 따라 올라가며 각 프로그램 경로와 명령줄(`NtQueryInformationProcess`)을 읽는다. 조상의 `git-remote-http(s).exe` 또는 `git-lfs.exe`가 이 서비스의 git이 가진 **바로 그 파일**이어야 답한다(GH-34: `git --exec-path`의 `git-remote-http.exe`·`git-remote-https.exe`·`git-lfs.exe`, Git for Windows의 `mingw64\bin\git-lfs.exe`와 2.56부터의 `ucrt64\bin\git-lfs.exe`(2.56이 git과 git-lfs를 `mingw64`에서 `ucrt64`로 옮겼고 `cmd\`에는 실행기만 남았다, GU-1), 서비스 PATH의 git-lfs; 경로 전체를 대소문자 무시로 비교하므로 같은 이름을 git 폴더 안 다른 곳이나 프로젝트에 복사해도 받지 못한다). 이 목록은 처음 로그인을 물을 때 읽어 두고, 목록이 낡았을 때만(목록이 비었거나 목록의 프로그램이 하나라도 없어졌을 때) 목록에 없는 `git-remote-http(s).exe`나 `git-lfs.exe`가 물으면 거절하기 전에 한 번 다시 읽는다(GU-2, GU-10): 서비스가 도는 중에 Git을 업데이트하면 프로그램 위치가 바뀌어(2.55 → 2.56), 읽어 둔 목록으로는 own을 다시 시작할 때까지 모든 git 로그인이 거절된다. Git for Windows 설치 프로그램은 설치 전에 이전 판을 지우므로(`install.iss`의 `CleanupWhenUpgrading`) 업데이트하면 목록의 `mingw64` 프로그램이 없어진다. 다시 읽기는 own을 다시 시작할 때처럼 서비스 PATH에서 git과 git-lfs를 새로 찾는다. 목록의 프로그램이 모두 그대로면 다시 읽지 않으므로, own이 도는 중에 PATH의 앞쪽 폴더에 넣은 git-lfs 사본이나 다른 설치의 git은 계속 거절되고 git을 띄우지도 않는다. curl처럼 git 프로그램이 아닌 호출자, 경로를 읽지 못한 호출자, 이미 믿는 호출자도 다시 읽지 않는다. SSH 호스트의 중계 스텁(Windows 호스트)도 같다. 그 위의 명령줄이 `git push`·`git send-pack`·`git-lfs push`·`git-lfs pre-push`면 push로 친다. git 명령줄은 하위 명령 앞의 옵션을 own이 아는 것만 읽고(`-c`, `-C`, `--git-dir`, `--attr-source <tree>`, `--shallow-file <file>` 같은 값 옵션과 값 없는 옵션), 모르는 옵션이 있거나 어디든 `push`·`send-pack` 낱말(`alias.up=push` 같은 별칭 값 포함)이 있으면 push로 친다(GH-28: 검토에서 `--attr-source HEAD push`가 `HEAD`를 하위 명령으로 읽혀 읽기 전용 계정으로 push했다). 부모 ID를 다른 프로세스가 물려받은 경우(부모가 자식보다 늦게 시작)는 거기서 멈춘다. 연결 상대의 주소를 얻지 못하거나 찾지 못하면 답하지 않는다. Windows가 아닌 곳에서는 누구에게도 답하지 않는다.

### 6.4 답 (저장소마다의 규칙)

요청 때 다시 계정을 고르고, 요청의 `protocol`·`host`가 계정 사이트와 같을 때만, 그리고:

1. `path`가 GitHub가 허용하는 이름의 저장소 하나(`<owner>/<repo>[.git]`, git-lfs의 `…/info/lfs…`)여야 한다(`no_repository`);
2. 이 서비스의 git의 HTTP 전송이나 git-lfs가 물어야 한다(`caller`, Windows만 확인할 수 있어 다른 곳에서는 늘 거절);
3. 읽기만 하는 계정은 push에 답하지 않는다(`read_only`: `pushUrl`을 직접 둔 원격처럼 `pushInsteadOf`를 지나는 push, LFS의 push).

통과하면 `username=<login>`, `password=<토큰>`. 아니면 404(git은 로그인 없이 계속). `get`만 묻고 `store`·`erase`는 무시. 답할 때마다 `github_git_login{account, host, repository, operation, caller}`, 거절하면 `github_git_login_refused{…, reason}` 한 줄을 남긴다(토큰 없음).

git은 Git for Windows의 셸로 도우미를 돌린다(그 안의 curl). Linux에서는 `/bin/sh`와 curl.

### 6.5 도구 결과의 토큰 가리기

모든 하네스의 모든 도구 결과(`tool` 훅 `execute.after`: 내용, 파일 부분의 `data:` URI, 구조화 출력, metadata, 오류 문구)에서 연결된 계정의 토큰, 갱신 토큰, git의 Basic 로그인 값(`base64(<login>:<토큰>)`)과 그 base64 형태(긴 base64 안에서 바이트 정렬 세 가지, 표준·URL 문자 모두)를 `McpProbe.masker`로 가린다(GH-18, GH-30). 토큰 목록은 1분마다, 그리고 계정·토큰이 바뀌거나 갱신될 때 다시 읽는다. 그 밖에(GH-30):

- `github.json`이나 보관함을 읽지 못하면 마지막으로 읽은 가리개를 그대로 쓴다(가리기는 닫힌 쪽으로). 한 계정의 토큰만 보관함에서 못 읽어도 그 계정의 이전 값은 계속 가린다.
- 바꾸거나 지운 토큰은 GitHub에서 아직 통할 수 있으므로 30일 동안 계속 가린다. 토큰은 남기지 않고 SHA-256만 `github.json`의 `retired`에 둔다(500개까지). 가리개는 GitHub 토큰 모양(`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`)의 낱말을 해시해 비교한다(그 base64 형태는 가리지 않는다).
- 도구 결과를 거치지 않고 모델에 가는 것을 위한 마지막 그물: 대화의 모든 모델 요청 훅(세션 `context`·`compaction`·`generate`·`title`)에서 보낼 메시지의 사용자·시스템·도구 부분의 글(백그라운드 명령의 완료 알림 `sessions.synthetic`, 사용자의 `!` 명령 출력, 사용자가 직접 적은 토큰, 계정을 잇기 전의 결과)을 같은 가리개로 가린다. 모델이 쓴 글은 건드리지 않고, 토큰이 있는 메시지만 바뀐다(그 밖의 요청은 그대로라 캐시도 그대로).
  - `generate`는 대화 전체를 싣는 한 번짜리 요청이다: 목표 검토(`/goal`), 캐시 데우기, own-team의 판단(팀 구성·재구성·무거운 폴더), 전환 화면의 인계, `POST /api/session/:id/generate`. Claude Agent 경로에서는 이 요청과 압축이 계정의 공유 `projects` 폴더에 갈래 대화 기록(transcript)으로 쓰이므로, 가리지 않으면 토큰이 디스크에 남는다(MR9 검토에서 찾음, 2026-11-02 고침). `title`은 첫 메시지로 제목을 짓는 요청이다.
  - 모든 대화 요청은 core의 `SessionModelRequest`(primary·compaction·generate·title)를 거치고 그 훅이 이 넷이다. 대화 기록을 싣지 않는 `ctx.generate.text`(세션 밖 생성, 호출한 쪽이 준 글만 보냄)에는 훅이 없어 가리지 않는다. own의 플러그인은 이것을 쓰지 않는다(2026-11-02 점검).

### 6.6 남는 위험

막지 못하는 것(GH-25, GH-29): PAT는 저장소·권한을 좁혀 만들기를 권한다.

- **읽기 전용은 단단한 경계가 아니다**(GH-29). own의 읽기 전용은 실수와 보통의 에이전트를 막는 장치다. 마음먹은 에이전트는 git이 받은 로그인을 빼내 쓸 수 있다: 아래의 `-c credential.helper=store`나 자기 `credential.helper`를 더하면 git이 fetch로 받은 토큰을 파일에 쓰게 할 수 있고(검토 gw1에서 확인), 그 토큰으로 push하거나 GitHub API를 부를 수 있다. 쓰기를 확실히 막아야 하면 GitHub에서 **쓰기 권한이 없는 토큰**(세분화 PAT의 `Contents: Read-only` 등)을 만들어 넣는다.

- git의 HTTP 전송 안에서 토큰을 빼내기: 에이전트가 자기 프록시와 `http.sslVerify=false`로 git의 요청을 가로채거나, `GIT_TRACE_REDACT=0 GIT_TRACE_CURL=1`로 헤더를 찍거나(결과의 Basic 값은 가려지지만 파일로 쓰면 남는다), `-c credential.helper=store`를 더해 git이 받은 로그인을 파일에 쓰게 할 수 있다.
- 명령이 끝나기 전의 티켓은 그 명령 안의 git이 쓸 수 있다. 오래 도는 core 셸 명령은 끝날 때까지(최대 6시간), own의 이벤트 구독이 끊겨 `shell.exited`를 놓치면 6시간까지.
- 이 서비스의 git 폴더에 있는 진짜 `git-remote-https.exe`·`git-lfs.exe`를 다른 방식으로 부르면 신뢰된다. 다른 git(포터블 git 등)은 답을 받지 못한다.
- 스트리밍 중인 셸 출력(codex의 실시간 출력 표시)은 가리기 전이다. 모델이 받는 최종 결과만 가린다. 도구의 입력(모델이 쓴 내용)은 가리지 않는다.
- SSH로 연결한 원격(`git@github.com:` 주소)은 사용자의 SSH 키를 쓴다(own의 계정과 무관).
- 이 PC가 Windows가 아니면 호출자를 확인할 수 없어 git 로그인을 넣지 않고 답하지도 않는다(GH-34; GitHub 도구와 own이 직접 띄우는 `gh`는 그대로). SSH 호스트의 남는 위험은 §8.8.

## 7. RPC (own.accounts, 10개, 모두 control, 모두 `REMOTE_MANAGED`)

| 메서드 | 범위 | 하는 일 |
|---|---|---|
| `github.view{directory?, sessionID?, host?}` | read | 계정·선택·설정·도구 목록, 보관함 상태, 그 폴더·대화의 `inUse`(`host`: 그 SSH 호스트의 폴더·대화, §8.3). 토큰 없음 |
| `github.add.token` | local | 토큰으로 연결 |
| `github.device.start` / `status` / `cancel` | local | 브라우저 로그인 |
| `github.update{id, label?, write?, token?}` | local | 이름, 쓰기 허용, 토큰 바꾸기 |
| `github.remove{id}` | local | 계정과 토큰과 그 계정을 가리키는 선택 |
| `github.bind{target: default|project|session, account: id|off|null}` | admin | 선택(null은 지움). `project`·`session`은 `host?`로 SSH 호스트의 폴더(그곳의 절대 경로)·대화를 고른다 |
| `github.settings.set` | local | 서버, toolset, git, Client ID |
| `github.test{id}` | local | 누구인지 다시 묻고 도구 목록을 다시 읽음 |

오류 `github_not_found`, `github_token_invalid{status?, mismatch?}`, `github_unavailable{reason, status?}`, `github_invalid{field}`, 그리고 `nonce_invalid`, `vault_unavailable`, `remote_managed`. 이벤트 `github.changed`(global). own.accounts 메서드는 GH 브랜치에서 131개(read 34, switch 15, admin 17, local 58, prompt 7), Claude Agent(02 §8.10)와 합친 병합 9회차의 판에서 142개(read 38, switch 17, admin 18, local 62, prompt 7)다. rpcHash는 바뀌지 않는다(own RPC는 데스크톱 IPC 해시 밖).

---

## 8. 원격(SSH) 호스트 (GH-37–GH-52, 2026-11-02)

SSH 원격 호스트(04)의 대화에서도 이 PC의 GitHub 계정으로 GitHub 도구와 git을 쓴다. **토큰은 PC를 떠나지 않는다.** 호스트의 own.accounts(`mode:"remote"`)는 GitHub 모듈 `GitHubRemote`를 등록하고, 도구 호출은 브로커 채널(04 §8)로, git은 egress 전달(04 §8.11)로 PC에 보낸다. 계정은 PC가 고르고, 토큰도 PC가 붙인다. 호스트의 `github.*` RPC는 이전처럼 `remote_managed`다(계정과 선택은 PC의 설정 화면에서 바꾼다).

### 8.1 방식 고르기 (GH-37)

v0.3의 §8은 "브로커 중계: 도구는 브로커로, git 로그인도 같은 터널로 PC의 수신기에 묻는다"였다. 이것을 그대로 하면 git의 자격 증명 답(`password=<토큰>`)이 호스트의 git 프로세스로 간다. 호스트의 에이전트는 §6.6처럼 `-c credential.helper=store` 한 줄로 그 답을 파일에 쓰게 할 수 있고, 그러면 토큰이 호스트에 남아 기한까지 어디서든 쓰인다. 그래서 git 쪽을 바꿨다.

| 안 | 요지 | 판단 |
|---|---|---|
| A. v0.3 원안: 도구는 브로커, git은 호스트의 도우미가 PC 수신기에 물어 토큰을 받는다 | 구현이 작다 | 기각: git 답에 토큰이 실려 호스트로 간다. "토큰은 PC를 떠나지 않는다"를 지키지 못한다 |
| B. 짧은 토큰 임대(GitHub 앱의 8시간 토큰) | 호스트가 직접 GitHub에 간다 | 기각: 토큰이 호스트 메모리에 있고, 세분화 PAT 사용자는 쓸 수 없다 |
| **C. 도구는 브로커, git은 PC가 로그인을 붙이는 HTTP 중계** | 호스트의 git·git-lfs가 GitHub 대신 호스트의 중계 입구(stub)로 가고, 입구가 egress 전달로 PC에 보내면 PC가 `Authorization: Basic`을 붙여 GitHub로 보낸다 | **채택**: 호스트에 토큰이 없다. push 판정이 HTTP 수준(`git-receive-pack`, LFS `upload`)이라 명령줄 추측(GH-28)보다 정확하고, 읽기만 하는 계정의 push를 PC가 막는다. 새 SSH 전달이 필요 없다(Claude 중계의 리스너에 경로 하나) |

C의 비용: clone·push의 데이터가 SSH 터널을 지난다(속도는 터널 대역폭). PC와 호스트가 연결돼 있어야 한다. git이 출력하는 원격 주소가 `http://127.0.0.1:<입구 포트>/github.com/…`로 보인다(`insteadOf`는 실행 중에만 바꾸므로 `git remote -v`는 그대로).

자격 증명 도우미 대신 입구가 "답하는 곳"이다: 도우미가 답할 값(토큰)이 호스트에 없으므로, 호스트의 git이 GitHub 대신 입구에 말하게 하고 입구가 호출자를 확인한다(§8.6). 입구 주소의 빈 도우미(`credential.<입구>.helper=`)는 사용자의 도우미가 입구에 무언가 답하지 않게 한다.

### 8.2 구성

```text
호스트 대화의 github_* 도구 ─▶ 원격 own.accounts(GitHubRemote) ─▶ 브로커 github.account / github.call ─(-R)─▶ PC LocalBroker
      ─▶ GitHubRelay(account·call) ─▶ GitHubTools.invoke(PC의 토큰, MCP 세션) ─▶ GitHub MCP 서버

호스트 셸의 git·git-lfs ─(insteadOf, 티켓 헤더)─▶ 호스트 git 중계 입구(GitHubRelayStub, 127.0.0.1:0, 티켓·호출자 확인)
      ─(x-own-github 증명, 장소 헤더)─▶ EgressStub ─(egress -R)─▶ PC egress 리스너 /github/… ─▶ GitHubRelay.gate
      ─(Authorization: Basic <login:token>)─▶ 계정의 사이트(github.com의 smart HTTP·LFS API)
```

- 새 브로커 메서드 `github.offer`, `github.account`, `github.call`과 push `github.changed`(04 §8.4 표). 정상 모드(같은 빌드)에서만 쓴다(04 §8.12).
- PC 쪽 코드: `src/github/relay.ts`(`GitHubRelay`: offer, account, call, gate), `src/broker/server.ts`(메서드와 push), `src/broker/egress.ts`(`/github/…` 경로, 증명 확인, 흐름 전달), `src/broker/host.ts`(연결). 호스트 쪽: `src/github/remote.ts`(`GitHubRemote`), `src/github/relay-stub.ts`(입구), `src/github/proc.ts`(Linux 호출자 확인), `src/remote/host.ts`·`client.ts`(브로커의 `github` API와 증명).

### 8.3 어느 계정인가

- 순서는 §3.2와 같다: 루트 대화 → 가장 깊은 프로젝트 폴더 → 연결된 워크트리(팀 영역)의 본 체크아웃 → 기본 계정. `off`는 거기서 멈춘다.
- 선택은 PC의 `github.json`에 `host`와 함께 둔다(`projects[].host`, `sessions[].host`). 호스트의 선택은 그 호스트의 폴더·대화에만 쓰이고, 이 PC의 선택이나 다른 호스트의 선택과 섞이지 않는다. 같은 경로·같은 대화 ID라도 호스트가 다르면 다른 것이다.
- 호스트의 폴더는 그곳의 경로다. POSIX 경로는 그대로(대소문자 구분, `/`) 비교하고, Windows 호스트(시험의 가짜 호스트)의 `C:\…` 경로는 Windows처럼 비교한다. `github.bind`는 호스트 폴더가 그곳의 절대 경로일 때만 받는다.
- 호스트는 요청마다 장소를 보낸다: 폴더, 그 폴더가 연결된 git 워크트리면 본 체크아웃(호스트가 자기 `.git` 파일에서 읽은 것, §3.2 3번), 루트 대화(호스트의 세션 트리로 찾은 것). PC는 호스트의 파일과 세션을 읽지 않는다.
- 기본 계정은 호스트에도 적용된다(PC와 같게). 한 호스트 전체에서 GitHub를 쓰지 않으려면 그 호스트의 `/` 폴더를 `off`로 고른다.
- 대화 없는 명령(리뷰 탭의 git 등): 그 호스트의 대화 선택 중 폴더 안팎의 것이 폴더의 계정과 다르고 7일 안에 골랐으면 git 로그인을 주지 않는다(GH-14, GH-33). PC는 호스트 세션의 마지막 활동을 모르므로 선택한 시각만 센다.
- 설정 > GitHub: 화면의 세션·프로젝트가 SSH 호스트의 것이면(`activePlace`) 페이지 위에 `원격 호스트 …의 프로젝트예요`가 보이고, `이 프로젝트의 계정`과 `이 프로젝트의 대화`가 그 호스트의 폴더·대화를 `host`와 함께 고른다. `지금 이 프로젝트`는 `github.view{directory, sessionID?, host}`로 읽는다. PC가 호스트의 `.git`을 읽지 못하므로 이 줄에는 워크트리 단계가 없다(호출 때는 호스트가 본 체크아웃을 보내므로 적용된다). 프로젝트 목록의 호스트 선택에는 `호스트 <id>` 태그가 붙는다.

### 8.4 도구

- **목록**: 호스트의 각 Location은 `github.offer{directory, main?}`로 PC가 그 폴더에 내놓을 도구(§5.2와 같은 판정, 그 호스트의 선택으로)와 `git`(계정이 있고 git 로그인이 켜짐)을 받는다. 정상 모드 세션이 설 때와 `github.changed` push 때 다시 묻고, 바뀌면 `ctx.tool.reload()`와 로그 `github_tools_offered{…, remote: true}`. PC에 닿지 못하면 마지막 목록을 그대로 둔다. 네임스페이스와 설명은 PC와 같다.
- **호출**: (1) `github.account{장소}`로 지금 계정을 묻는다(없음·`off`·문제는 PC와 같은 도구 오류). (2) 쓰기 도구면 계정이 쓰기를 허용하지 않을 때 묻기 전에 오류, 허용하면 **호스트의 대화에서** PC와 같은 `permission.assert`(resource `<도구> <owner>/<repo> as <login> (<계정 ID>)`, 같은 `save` 규칙)로 묻는다. 호스트에도 같은 에이전트 규칙(`{github.write, *, ask}`, `plugin.updated`마다 다시 등록)과 `evaluate` 훅(P-047의 `saved`에 그대로 있을 때만 `allow`)이 있다(`GitHubConnection.writeAsks`를 함께 쓴다). (3) `github.call{장소, tool, input, account}`. PC는 장소의 계정을 다시 고르고, 호스트가 물어본 계정과 다르면 `account_changed`로 실행하지 않는다(승인은 다른 계정을 덮지 않는다, GH-32). 그 장소가 내놓지 않는 도구(`unknown_tool`), 쓰기를 허용하지 않는 계정의 쓰기(`read_only`), 쓰기를 허용하지 않은 호스트의 쓰기(`host_read_only`, §8.11)도 실행하지 않는다. 그다음 PC의 호출과 같은 `GitHubTools.invoke`(토큰 갱신, MCP 세션, 그 계정 토큰 가리기, 거절된 토큰 표시)이고, 돌려보내기 전에 결과 글(오류 글도)을 PC 자신의 도구 결과와 같은 전체 가리개(`GitHubMask`: 연결한 모든 계정의 토큰·갱신 토큰·git Basic 로그인과 그 base64 형태, 30일 안에 지우거나 바꾼 토큰)로 가린다(GH-50). 가리개를 읽지 못하면(`github.json`) 결과를 보내지 않고 `failed`("호출은 됐지만 결과를 확인하지 못했다")다. 결과 글은 640 KiB(UTF-8)에서 자른다(브로커 프레임 1 MiB).
- 결과는 `GitHub account: <login> (<이름>)` 줄로 시작하고 metadata `github{…}`도 PC와 같다. PC의 로그에 `github_remote_tool{remote, tool, account, write}`(거절은 `github_remote_tool_refused{…, error}`).
- **승인의 신뢰**: 쓰기의 승인은 호스트의 core가 받는다. PC는 그 승인을 확인할 수 없고, 호스트의 셸 명령 승인을 믿는 것과 같은 정도로 믿는다. PC가 스스로 지키는 것은 계정의 `쓰기 허용`, 그 호스트의 쓰기 허용(§8.11), 그 장소가 내놓는 도구, 물어본 계정과 같은 계정이다.
- 호출의 취소(대화 중단)는 PC의 MCP 호출을 끊지 않는다(브로커 요청에 취소가 없다). 응답은 버려진다.

### 8.5 git

- **넣는 곳**: 호스트 core의 셸(`create.before`, P-046의 대화와 명령 ID), 호스트에서 다른 own 플러그인이 쓰는 브리지(`GitHubBridge.gitEnv`: 하네스의 셸, 호스트의 own-team push). 마지막 `github.offer`가 `git: false`면 묻지도 않는다(셸 명령마다 PC 왕복을 하지 않게).
- **넣는 것**: `github.account{장소}`가 계정과 `git: true`를 주면, 기존 `GIT_CONFIG_COUNT` 뒤에(`GitHubCredential.relayEnvironment`)
  - `url.<입구>/<사이트 호스트>/.insteadOf=<사이트>/`: git과 git-lfs가 그 사이트 대신 입구로 간다;
  - `http.<입구>/.extraHeader=X-Own-GitHub-Ticket: <티켓>`: 입구에만 가는 티켓(§6.3과 같은 키·시계·끝: 명령마다 새것, `shell.exited`로 끝, 처음 쓴 때부터, 6시간 상한). 티켓은 호스트를 떠나지 않는다;
  - `credential.<입구>/.helper=`(빈 값): 사용자의 도우미가 입구에 답하지 않게;
  - 읽기만 하는 계정이거나 PC가 그 호스트에 쓰기를 허용하지 않았으면(`github.account`의 `hostWrite: false`, §8.11) PC와 같은 `url.github-account-is-read-only::.pushInsteadOf=<사이트>/`.
- gh에는 아무것도 넣지 않는다(gh는 토큰이 있어야 한다). 호스트의 gh는 그 호스트의 로그인을 쓴다. 호스트에서 PR은 GitHub 도구(`create_pull_request`)로 만든다.
- **입구**(`GitHubRelayStub`, 호스트 프로세스에 하나): 경로 `/<사이트 호스트>/…`, 티켓(`x-own-github-ticket`)이 살아 있고(`GitHubCredential.redeem`), 연결의 상대가 이 서비스의 git 전송이나 git-lfs이고, Linux에서는 그 티켓이 그 명령의 것이어야(§8.6) 한다. 그다음 장소(티켓의 폴더와 루트 대화, 지금 읽은 본 체크아웃)를 `x-own-github-place`에, 증명을 `x-own-github`에 넣어 `EgressStub`으로 보낸다. 요청·응답 모두 흐르는 대로. 거절은 403 `ticket`(없음, 끝남, 다른 명령의 티켓)·`caller`, PC에 닿지 못하면 503 `unavailable`.
- **PC**(`Egress.Relay`의 `/github/…`, `GitHubRelay.gate`): 증명(04 §8.12), 장소, 속도·동시성, 그리고
  1. 경로가 저장소 하나(GitHub가 허용하는 이름)의 git smart HTTP(`info/refs?service=git-upload-pack|git-receive-pack`의 GET, `git-upload-pack`·`git-receive-pack`의 POST)나 Git LFS API(`info/lfs/objects/batch`의 POST, `info/lfs/locks…`)여야 한다. 그 밖(dumb HTTP, REST API, `..`)은 404 `bad_request`. `info/refs`의 `service`는 정확히 하나여야 하고(둘이면 GitHub가 다른 하나를 읽을 수 있다), GitHub로는 판정한 그 값 하나로 다시 만든 `?service=<값>`만 간다(GH-47). 잠금 목록의 질의(`path` 등)는 그대로 간다;
  2. LFS batch는 본문(1 MiB까지)을 먼저 읽어 `operation`을 본다. JSON 객체가 아니거나, 대소문자를 무시하면 `operation`인 키가 둘 이상이면(GitHub의 파서가 이름을 대소문자 없이 맞출 수 있다) 400 `bad_request`. GitHub로는 받은 바이트가 아니라 읽은 객체를 다시 쓴 본문이 가서, 같은 이름의 두 번째 키나 이스케이프한 이름이 GitHub에 닿지 않는다(GH-46). `download`가 아니면 push로 친다;
  3. push = `git-receive-pack`(광고 요청 포함), LFS `upload`, 잠금의 생성·확인·해제;
  4. git 로그인이 꺼졌거나, 계정이 없거나 `off`, 대화 없는 명령이 §8.3에 걸리면 `off`; 요청의 사이트가 계정의 사이트가 아니면 `site`; 계정에 문제가 있거나 토큰을 못 얻으면 `problem`; 읽기만 하는 계정의 push면 `read_only`; 쓰기를 허용하지 않은 호스트의 push면 `host_read_only`(§8.11)(모두 403);
  5. 통과하면 `Authorization: Basic base64(<login>:<토큰>)`을 붙여 계정 사이트의 같은 경로로 보낸다(github.com은 엔드포인트 설정의 주소). 요청 헤더는 `content-type`, `accept`, `git-protocol`, `content-encoding`, `user-agent`만 넘긴다. GitHub의 401은 403(`problem`)으로 바꾸고 `www-authenticate`를 지워, 호스트의 git이 비밀번호를 묻지 않는다. 리디렉트는 따라가지 않는다;
  6. **GitHub의 답 확인**(GH-45): 로그인이 답에 실려 호스트로 돌아가지 않게 한다. 확인할 값은 토큰, 그 base64 형태, `<login>:<토큰>`의 base64와 그 형태(`GitHubMask.loginForms`), 보낸 `Authorization` 값 그대로다. 그대로 찾고, JSON의 `\/`·`\uXXXX`와 URL의 `%XX`를 푼 글에서도 찾는다.
     - 넘기는 모든 응답 헤더(리디렉트의 `Location` 포함)에 있으면 502 `leak`;
     - Git LFS API의 답(batch, 잠금)과 상태 300 이상의 모든 답은 본문을 먼저 끝까지 읽는다(`GITHUB_CHECKED_ANSWER_MAX_BYTES` 1 MiB까지, 넘거나 120초 안에 오지 않으면 502 `unchecked`). LFS batch의 답에서는 어느 객체의 어느 동작이든 `header.Authorization`(이름은 대소문자 무시)이 보낸 로그인과 똑같으면 그 헤더를 지운다(그 서버는 요청의 로그인을 저장소 단계에 넘겨 준 것이다). 그 뒤에도 본문에 있으면 502 `leak`. 401도 이렇게 확인한 뒤 403이 된다;
     - 팩 흐름(`info/refs`, `git-upload-pack`, `git-receive-pack`의 2xx 본문)은 읽지 않고 흐르는 대로 넘긴다(clone·push가 클 수 있고, GitHub가 팩에 로그인을 넣는 경로가 없다);
     - 거절은 위쪽 요청을 끊고 PC의 로그에 `github_answer_refused{hostId, code, where: header|body|too_large|timeout, status}`만 남긴다(값은 적지 않는다).
- **읽기만 하는 계정의 push**: 호스트의 `pushInsteadOf`로 git과 git-lfs가 네트워크 전에 멈춘다(ssh 시작 없음, MR9). push 주소를 따로 둔 원격(`pushurl`은 `pushInsteadOf`를 건너뛰지만 `insteadOf`는 받는다)이나 에이전트가 그 변수를 지운 경우는 입구를 거쳐 PC가 403으로 거절한다. git은 `The requested URL returned error: 403`, git-lfs는 `Authorization error`로 바로 끝나고 다시 시도하지 않는다.
- LFS 객체 자체(다운로드·업로드)는 batch 답의 주소로 호스트가 GitHub의 저장소에 직접 간다. 그 주소의 인증은 batch 답이 준 짧은 객체별 값이다(계정 토큰이 아니다).
- **저장소 단계의 자격(파생 값)도 가릴까(검토, GH-45)**: 가리지 않는다. 그 값은 호스트의 git-lfs가 객체를 직접 올리고 받는 데 꼭 필요하고(지우면 LFS가 깨진다), 한 객체·한 동작·짧은 기한(`expires_in`)에 묶여 있어 계정 토큰이 닿는 범위(그 계정의 모든 저장소, API)보다 훨씬 좁다. 호스트가 그 객체를 이미 다루는 명령 안에서만 쓰인다. 그 값이 토큰 자체이거나 토큰·로그인의 어떤 형태를 담으면 6의 확인이 답 전체를 막는다(닫힌 쪽: 그때 LFS는 502로 멈춘다). 지우는 것은 보낸 로그인과 똑같은 `Authorization`뿐이다.
- **github.com의 실제 동작은 확인하지 않았다**: 실제 GitHub 토큰을 쓰지 않으므로, github.com의 LFS batch 답이 동작 헤더에 무엇을 넣는지(예: `Authorization: RemoteAuth <값>`, 그 값이 어떻게 만들어지는지, 토큰을 담는지)는 확인하지 않았다. 가짜 GitHub는 객체마다 토큰에서 파생한 `RemoteAuth lfs-…` 값을 주고(토큰을 담지 않음), 저장소는 그 값만 받는다. 실제 동작이 토큰을 담는 값이면 위 규칙으로 502가 되므로, 실제 호스트 시험(§8.9)에서 `git lfs push`·`pull`로 확인한다.

### 8.6 호출자 확인 (GH-39)

입구는 연결의 상대 프로세스를 확인한다. Windows 호스트(시험의 가짜 호스트)는 §6.3의 `GitHubCaller` 그대로, Linux는 `GitHubProc`(`/proc`)이다. 다른 운영체제의 호스트는 입구를 열지 않는다(git은 호스트의 로그인을 그대로 쓴다).

Linux에서 믿는 조건(모두):

1. `/proc/net/tcp`와 `tcp6`(IPv4 매핑 주소 포함)에서 그 연결의 클라이언트 쪽 줄(로컬 포트 = 클라이언트 포트, 원격 포트 = 입구 포트, 127.0.0.1, ESTABLISHED)을 찾고, 그 줄의 uid가 **서비스의 uid**다.
2. 그 소켓 inode(`socket:[N]`)를 가진 프로세스를 `/proc/<pid>/fd`에서 찾는다(같은 사용자의 것만 읽힌다).
3. 그 프로세스부터 부모를 따라 올라가며(`/proc/<pid>/stat`의 부모 ID와 시작 시각, 최대 24단계) 가장 가까운 `git-remote-http`·`git-remote-https`·`git-lfs`가 **이 서비스의 git의 바로 그 파일**이다: `/proc/<pid>/exe`(커널이 가리키는 실행 중인 파일)가 `git --exec-path`의 `git-remote-http`·`git-remote-https`·`git-lfs`, 서비스 PATH의 `git-lfs`의 실제 경로(`realpath`) 중 하나와 같다. 지워지거나 바뀐 파일(`… (deleted)`)은 아니다.
4. 그 위의 조상 중에 **이 서비스 프로세스**가 있다: 이 서비스가 띄운 명령(core의 셸 명령, 하네스의 셸, own-team의 git) 안에서 돈 프로그램이다. 사용자가 직접 연 터미널, 같은 사용자의 다른 서비스, 서비스가 다시 시작한 뒤 남은 고아 프로세스는 아니다.
5. 부모 ID를 더 늦게 시작한 프로세스가 물려받았으면(시작 시각이 자식보다 늦음) 거기서 멈춘다(그러면 4를 못 채운다).
6. **티켓은 그 명령의 것이다**(GH-48, MR12-3에서 고침): 사슬에서 부모가 이 서비스인 프로세스(그 명령의 맨 위 프로세스: 셸, 또는 서비스가 바로 띄운 git)가 **명령을 띄울 때 정해 둔 바로 그 프로세스**(`<pid>:<시작 시각>`)다. 티켓은 명령이 시작될 때 그 프로세스에 묶인다(`GitHubCredential.started`): core의 셸 명령은 훅이 받은 명령 ID(core P-046)로 core의 `shell.created`(P-046이 띄운 프로세스의 ID를 싣는다)를 찾아 `/proc/<pid>/stat`의 시작 시각과 함께 적고, 다른 own 플러그인(codex·pi·dsh 하네스의 셸, own-team의 `git push`·`git lfs push`·`gh pr create`)은 띄운 프로세스의 ID를 다리(`GitHubBridge`의 `pid`)로 알린다. 부모가 이 서비스가 아닌 프로세스나 읽을 수 없는 프로세스면 아무도 그 티켓을 쓰지 못한다. 입구는 티켓을 처음 쓸 때 그 이름이 아직 없으면 10초(`HOLDER_WAIT_MS`)까지 기다린다(`shell.created`가 이벤트 흐름으로 늦게 올 수 있다). 또 그 프로세스의 `/proc/<pid>/environ`에서 `GIT_CONFIG_VALUE_*` 중 `X-Own-GitHub-Ticket: `로 시작하는 값이 하나 이상 있고 모두 받은 티켓과 같아야 한다. 거절은 403 `ticket`, 로그 `github_git_relay_refused{reason: "command"}`.
   - 고친 이유: 처음에는 `environ`이 "서비스가 준 시작 환경"이라고 보고 처음 쓴 맨 위 프로세스를 고정했다. 그러나 `environ`은 그 프로세스가 마지막으로 `execve`한 환경이다. 다른 명령이 남의 티켓을 읽어 그 티켓을 넣은 환경으로 자기를 다시 실행(`exec`)하면 `environ` 확인을 통과하고, 원래 명령보다 먼저 쓰면 자기에게 고정됐다. 이제 고정은 시작할 때 정해지므로 먼저 써도 거절된다. 명령 자신의 `exec`(예: `bash -c "git push"`가 git으로 바뀜)는 ID와 시작 시각이 그대로라 영향이 없다.
   - 명령 ID가 없는 core 셸 명령(P-046 이전 방식)과 프로세스 ID를 알리지 않은 다리 호출은 예전처럼 처음 쓴 맨 위 프로세스를 고정한다.
7. **core의 프로세스 데몬 아래 셸 명령**(MR18): upstream v2.3부터 core는 셸 명령을 프로세스 데몬(`opencode-pty`, 서비스가 떼어 띄우고, 서비스가 끝나면 init이 물려받는다)으로 띄운다. 그래서 셸 명령의 부모는 서비스가 아니라 데몬이고, 서비스가 조상에 아예 없을 수도 있다. 그래서 4와 6의 "부모가 이 서비스인 프로세스" 대신 **이 서비스가 살아 있는 묶인 티켓의 명령으로 정해 둔 프로세스**(`GitHubCredential.named`, `<pid>:<시작 시각>`)가 사슬에서 가장 가까이 있으면 그것을 이 서비스의 명령으로 본다(4를 채운 것으로 본다). 정해 둔 이름은 부모가 이 서비스이거나 `opencode-pty`인 프로세스만 받는다(`GitHubProc.holder`). 입구는 caller 판정 전에 받은 티켓의 이름이 정해질 때까지 6과 같이 기다린다(`GitHubCredential.settle`). 6의 `environ` 확인과 묶기는 그대로라, 정해 둔 다른 명령이 남의 티켓을 들고 와도 403 `ticket`이고, 사용자 터미널이나 다른 서비스의 git은 정해 둔 이름도 아니고 이 서비스 아래도 아니라 403 `caller`다. 2.4.1-own.1 실호스트 C에서 데몬이 명령으로 잡혀 정당한 push·LFS가 `reason: "command"`로 거절된 것을 고쳤다.

**믿는 범위(고친 설명)**: v0.4의 "서비스의 셸이 띄운 git만"은 정확하지 않았다. 4는 "이 서비스가 띄운 어느 명령 안"을 뜻할 뿐이라, 6 전에는 한 명령의 티켓을 다른 명령(같은 서비스의 다른 셸 명령)이 쓸 수 있었다. 6으로 단위가 **명령 하나**가 되었다. 그래도 그 명령 안의 모든 것은 티켓을 물려받아 쓸 수 있다: 명령이 실행한 프로그램, git의 훅, git이 띄우는 자격 증명 도우미(`credential.helper`의 `!` 명령)와 그 자식, git-lfs가 띄우는 사용자 지정 전송 프로그램(`lfs.customtransfer.<이름>.path`)과 그 자식. 이것들이 이 서비스의 진짜 `git-remote-https`나 `git-lfs`를 띄워 다른 저장소에 요청하면 1–6을 모두 채운다. 그래서 믿는 것은 "승인된 그 명령"이지 "그 명령의 git 한 번"이 아니다. 범위는 계정 토큰이 닿는 저장소의 git smart HTTP와 LFS API이고, push는 PC의 판정(§8.5, §8.11)을 받는다.

Windows 호스트(시험의 가짜 호스트)의 `GitHubCaller`는 6을 하지 않는다(다른 프로세스의 환경을 읽지 않는다). own은 Windows SSH 호스트를 지원하지 않으므로 시험에서만 쓰인다.

push인지(로그용)는 §6.3과 같은 명령줄 판정을 `/proc/<pid>/cmdline`의 낱말로 한다. 판정의 주인은 PC의 HTTP 수준 판정이다(§8.5).

### 8.7 끊김과 버전

- 브로커가 끊겼으면: 도구 호출은 한 번 `brokerWaitMs`(기본 10초)까지 재연결을 기다린 뒤 "could not reach the PC's GitHub connection" 오류. 셸 명령은 기다리지 않고 변수를 넣지 않는다(git은 호스트의 로그인). 이미 변수를 받은 명령의 git은 입구에서 503.
- 다른 빌드 사이(drain 모드, 04 §5.7)에는 `github.*`를 부르지 않는다. 옛 PC는 이 메서드를 모르고 옛 호스트는 부르지 않는다. 그래서 같은 빌드로 업데이트한 뒤에 쓰인다.
- 호스트가 다시 arm되면(새 epoch) 증명의 카운터와 PC의 재사용 창이 함께 새로 시작한다.

### 8.8 남는 위험

- 토큰은 호스트에 없지만, **명령이 도는 동안**에는 그 명령과 그 안의 모든 것(§8.6의 믿는 범위)이 PC를 거쳐 그 계정으로 GitHub의 git 기능에 닿는다. 범위는 git smart HTTP와 LFS API, 그 계정 토큰이 닿는 저장소다. 읽기만 하는 계정의 push와 쓰기를 허용하지 않은 호스트의 push는 PC가 막는다.
- 같은 사용자는 `/proc/<pid>/environ`에서 실행 중인 다른 명령의 티켓을 읽을 수 있지만, 그 티켓은 명령이 시작될 때 그 명령의 맨 위 프로세스(ID와 시작 시각)에 묶여 있어, 읽은 티켓을 넣은 환경으로 자기를 다시 실행하고 먼저 써도 다른 명령에서는 거절된다(§8.6의 6). 시스템이 허용하면(`ptrace_scope`) 실행 중인 명령의 프로세스에 붙어 그 안에서 요청을 보내게 할 수는 있다. Windows의 같은 한계(§6.6)와 같다. 호스트의 root는 무엇이든 할 수 있다.
- GitHub의 답은 PC가 확인한 뒤 보낸다(§8.5의 6). 팩 흐름은 확인하지 않는다.
- 다른 PID 네임스페이스(컨테이너)나 `hidepid`로 프로세스가 보이지 않으면 호출자를 모른다: 믿지 않는다(닫힌 쪽).
- 쓰기의 승인은 호스트의 core가 받는다(§8.4). 호스트가 조작되면 승인 없이 쓰기를 부를 수 있다. 막는 것은 그 호스트의 쓰기 허용(§8.11), 계정의 `쓰기 허용`과 토큰의 권한이다. 새 호스트는 쓰기 허용이 없어 읽기만 한다. 믿을 수 없는 호스트는 쓰기를 허용하지 않고, `off`나 읽기만 하는 토큰의 계정으로 둔다.
- 기본 계정은 새 호스트에도 바로 적용된다(§8.3). 읽기는 바로 되고 쓰기는 허용한 뒤에만 된다.
- clone·push의 데이터가 SSH를 지나므로 큰 저장소는 느리다. PC가 꺼져 있으면 쓸 수 없다.

### 8.9 남은 일

- 실제 Linux 호스트에서의 시험은 real-host 단계 C의 마지막 항목들로 썼다(MR10-4, `packages/own-remote/test/real-host/c-team.test.ts`의 `GitHub on the host: …`). 가짜 GitHub는 이 PC에 두고(`git http-backend`로 진짜 bare 저장소를 받는다), 그 LFS 저장소 주소는 같은 번호의 `ssh -R`로 호스트에서 닿는다. 항목: 대화의 Code Mode 도구 호출, 쓰기를 허용한 호스트의 `git push`, 읽기만 허용한 호스트의 push 거절(`pushInsteadOf`와 명시한 push URL 둘 다), LFS 올리고 clone으로 받기, 다른 명령의 `/proc/<pid>/environ`에서 읽은 티켓과 서비스 밖 git의 거절(GH-48), 호스트 어디에도 토큰이 없음. 다음 릴리스의 실제 호스트 단계가 처음 돌린다(이번에는 실행하지 않음). 같은 push·LFS 왕복은 가짜 SSH 시험(`test/remote/e2e/github-relay.test.ts`)에서도 돈다.
- github.com의 LFS batch 답이 동작 헤더에 무엇을 넣는지(`RemoteAuth` 등, §8.5) 실제 계정으로 확인한다. 토큰을 담는 값이면 지금 규칙으로는 호스트의 LFS가 502로 멈춘다.
- 호스트의 `gh`, 도구 호출의 취소 전달, macOS 호스트(호출자 확인 없음).
- 설정 화면의 `지금 이 프로젝트`가 호스트의 워크트리 단계를 보이지 않는다(§8.3).

### 8.10 시험

- own-accounts `test/github/remote.test.ts`(21, 검토 수정 뒤): 호스트의 프로젝트·팀 영역(본 체크아웃)·대화 선택과 다른 호스트·이 PC와의 분리, `/`의 `off`, POSIX 경로가 아닌 폴더 거절, 대화 없는 명령의 7일 규칙; `github.offer`(읽기·쓰기·`git`)와 `github.call`(계정, `account_changed`, `unknown_tool`, `read_only`, 결과 자르기); git 중계 경로 판정(smart HTTP·LFS·잠금, push 판정, 거절할 경로)과 `gate`(Basic 로그인, `read_only`, `site`, `off`); 호스트 모듈(도구 목록, 읽기, 쓰기의 호스트 쪽 승인과 resource, `evaluate` 훅, 읽기 전용 계정의 쓰기, 끊김; 셸 변수와 티켓의 끝, 읽기 전용의 `pushInsteadOf`, 계정 없음·끊김·git 끔); **실제 git**이 입구와 PC 중계를 거쳐 가짜 GitHub에 그 계정으로 로그인하고 호스트 쪽에는 토큰이 없음, 읽기 전용 push가 바로 멈추고 push URL을 둔 push를 PC가 403으로 거절(ssh 없음), 쓰기 허용 뒤 push, **실제 git-lfs**의 업로드와 읽기 전용 거절(호스트의 `pushInsteadOf`, 그것을 지운 경우 PC의 403); 입구의 티켓·호출자 거절과 PC의 증명 거절(없음, 다른 키, 재사용, 다른 epoch, 다른 장소); Linux 호출자 확인(가짜 `/proc`: 믿는 경우, push, git-lfs, `tcp6`, curl, 복사한 프로그램, 지워진 프로그램, 다른 사용자, 서비스 밖, 부모 ID 재사용, 표에 없는 연결); 시작할 때 묶은 티켓(MR12-3, 가짜 `/proc`): 남의 티켓으로 자기를 다시 실행한 명령은 먼저 써도 거절, 원래 명령은 통과, `shell.created`보다 먼저 온 요청은 기다렸다가 통과, 서비스의 자식이 아닌 프로세스의 티켓은 아무도 못 씀, 다리로 알린 프로세스도 같음(고침을 되돌리면 실패). 검토 수정(GH-45–GH-50)은 시험이 하나씩 있고, 15개의 고침을 하나씩 되돌리면 각각 그 시험이 실패한다(`C:\t\gt1\mutate.ts`): LFS 동작의 `Authorization`이 로그인이면 지우고 저장소의 파생 값은 둠, 헤더·`Location`·401 본문의 로그인은 502 `leak`(헤더 확인과 본문 확인 따로), 다시 쓴 batch와 대소문자만 다른 `operation` 거절, `service` 하나와 다시 만든 질의, 명령의 환경과 첫 보유자 고정, 호스트 쓰기 허용(gate, call, offer, 호스트의 `pushInsteadOf`, 호스트가 묻기 전 거절), 중계 결과의 전체 가리기. 가짜 GitHub는 LFS batch에 `upload`·`download` 동작과 객체 저장소(`/_lfs/<oid>`, 파생 `RemoteAuth` 값)를 주고, `echo`(`actions`, `header`, `location`, `body401`)로 로그인을 되돌려 주는 서버를 흉내 낸다. 실제 git-lfs의 업로드가 저장소에 파생 값으로 올라간다.
- own-accounts `test/remote/e2e/github-relay.test.ts`(5, fake-SSH 하네스, 실제 서버 둘): PC에서 호스트 폴더의 계정을 고르고, 호스트의 대화가 `github_get_me`를 부르면 PC가 그 계정으로 실행; 계정이 쓰기를 허용해도 새 호스트에는 쓰기 도구가 없고, PC가 그 호스트를 허용하면 생김(GH-49); 쓰기는 호스트의 대화에서 묻고 답하기 전에는 GitHub에 아무것도 가지 않음; 호스트 셸의 git이 PC를 거쳐 로그인, 대화의 선택(읽기 전용 계정)이 git에도 적용되고 push는 바로 멈추며 push URL을 둔 push는 PC가 403; 호스트의 파일·로그, 모든 답, PC의 로그, 채팅 요청에 토큰 없음. 가짜 호스트의 서비스는 PATH 앞에 git을 둔다(`real-service.ts`의 `pathPrepend`).
- own-web `github/model.test.ts`: 호스트의 선택을 이 PC의 것과 따로 읽는다. 호스트의 쓰기 허용을 켜고 거두면 다른 호스트는 그대로다(GH-49).

### 8.11 호스트의 쓰기 허용 (GH-49)

새 SSH 호스트는 GitHub를 **읽기만** 한다. 계정이 쓰기를 허용해도, 이 PC의 사용자가 그 호스트의 쓰기를 허용하기 전에는 그 호스트에서 쓰기 도구와 git push가 되지 않는다. 호스트 하나를 믿는 일(그 호스트의 core가 받는 승인, §8.4)과 계정을 믿는 일을 나눈다.

- 저장: `github.json`의 `settings.writeHosts`(호스트 ID 목록, 없으면 빈 목록). 바꾸는 곳은 `github.settings.set{writeHosts}`(목록 전체, 같은 ID는 하나로, `local`: 이 PC의 창에서만). 바꾸면 `github.changed`로 호스트가 다시 묻는다. MCP 세션은 그대로 둔다.
- PC가 지키는 곳: `github.offer`는 허용하지 않은 호스트에 쓰기 도구를 내놓지 않는다. `github.call`은 그 호스트의 쓰기를 `host_read_only`로 실행하지 않는다. `gate`는 그 호스트의 push(`git-receive-pack`, LFS `upload`, 잠금 변경)를 403 `host_read_only`로 막는다. `github.account`는 `hostWrite`를 함께 준다.
- 호스트 쪽: `hostWrite: false`면 쓰기 호출이 묻기 전에 "The PC lets this SSH host only read on GitHub…" 오류로 끝나고(목록에 남은 옛 쓰기 도구라도), 셸의 git에는 읽기 전용 계정과 같은 `pushInsteadOf`를 넣어 push가 네트워크 전에 멈춘다.
- 설정 > GitHub: `SSH 호스트의 쓰기` 절(이 PC의 창에서만). 화면의 세션·프로젝트가 SSH 호스트의 것이면 `호스트 <이름>에서 GitHub 쓰기 허용` 스위치가 보이고, 허용한 호스트 목록(`쓰기를 허용한 호스트`, 각 줄에 `허용 거두기`)이 늘 보인다. 없으면 `쓰기를 허용한 호스트가 없어요. 모든 호스트가 읽기만 해요.`
- 호스트를 지워도 목록의 ID는 남는다(다시 추가한 호스트는 새 ID라 읽기만 한다).

---

## 9. own-web

- 설정 > 연결 > `GitHub`(`/settings/github`, 지연 청크 `github/settings.tsx`, 문자열 `github/strings.ts`): `지금 이 프로젝트`, 계정 목록과 동작, `계정 추가`(토큰/브라우저 로그인), `어디에 어떤 계정`(기본, 이 프로젝트, 프로젝트·팀 영역별, 이 프로젝트의 대화별), SSH 호스트의 쓰기(§8.11, 이 PC의 창에서만), 도구(개수, 다시 읽기, toolset, 서버), git 로그인, 브라우저 로그인 앱. 설명서 링크 `ch28`.
- 첫 청크에 더한 것: 메뉴 이름·힌트(ko·en), 경로, 지연 import 한 줄, 팔레트 검색어, 설명서 장 이름. PF5 409,034 B / 409,600 B(`merge-round8` `5c1983547f` 위로 옮긴 뒤 409,019 B, 검토 수정은 own-web을 바꾸지 않음; main을 합치고 두 번째 검토 수정 뒤 409,025 B, 바뀐 문구는 지연 청크).
- 토큰 입력은 password 칸이고 보내자마자 비운다.

---

## 10. 시험

- own-accounts `test/github/github.test.ts`(40, 두 번째 검토 수정 뒤): 가짜 GitHub(`test/e2e-kit/fakes/github.ts`: `/user`, `/api/v3/user`, device flow, MCP, git smart HTTP)로 토큰 연결·거절·중복 이름·다른 사용자 토큰·삭제, 토큰이 파일·답·로그에 없음, 선택 순서와 팀 영역 워크트리, 도구 목록·읽기 전용 위치·대화별 계정·쓰기 승인과 거절·토큰 가리기·거절된 토큰 표시, 에이전트 규칙, 자격 증명 수신기(티켓·위조·브라우저·다른 호스트·끔), **실제 git**(정리된 환경)으로 가짜 원격에 계정별 로그인과 사용자의 도우미보다 우선, 실제 `git worktree add`로 만든 영역의 브리지, device flow와 갱신. 검토 수정(GH-13–GH-23)마다 시험이 하나씩이고, 각 시험은 그 수정을 빼면 실패한다(한 번에 하나씩 되돌려 확인): `plugin.updated` 뒤 다시 등록되는 쓰기 규칙, 권한 훅과 `항상 허용` 기록·지움, core 와일드카드와의 일치(core의 `Wildcard.match`와 비교), 지어낸 저장소 이름의 저장 안 함, P-046의 대화·`off`·닫힌 쪽, 읽기만 하는 계정의 실제 `git push`(`pushInsteadOf`, 직접 둔 push URL)와 실제 `git lfs push`, 결과의 토큰 가리기, 명령과 함께 끝나는 티켓·저장소 경로·감사 로그, Windows의 호출자 확인(curl과 `git credential fill`은 거절, git과 git-lfs는 통과), 읽기 도구 판정, 로컬 서버의 허용 목록 환경, 계정별 세션 닫기와 403 재확인, https만, 프로세스 전체의 갱신. 두 번째 검토의 수정(GH-26–GH-34)도 하나씩 되돌려 시험이 실패함을 확인했다: 권한 훅이 core의 저장된 목록에 그대로 있는 resource만 허용으로 두기(패턴·다른 계정·지어낸 이름은 아님), 처음 쓸 때부터 재는 티켓과 명령이 끝나면 끝나는 로그인·6시간 상한(늦은 승인, 백그라운드로 옮긴 명령; 시계는 `setSystemTime`), git 명령줄의 push 판정(`--attr-source`, 모르는 옵션, 별칭 값)과 실제 `git --attr-source HEAD push`, 호출자 프로그램 경로의 정확한 비교와 주소 없는 연결, 최근 7일의 대화 선택과 폴더 없는 선택, 마지막 가리개·base64·`data:` URI·지운 토큰의 해시·모델에 가는 메시지.
- MR9 검토 뒤(2026-11-02): own-accounts `github.test.ts`의 "every kind of model request is masked"(`context`·`compaction`·`generate`·`title` 모두에서 사용자가 적은 토큰과 도구 결과의 토큰을 가림; 고침을 빼면 `generate`에서 실패)와 "the read-only roles', own-team's and the GitHub hook compose in any order"(세 훅의 여섯 순서 모두에서 조이기만: 읽기 전용 역할의 `github.write` 거부가 저장된 `항상 허용`과 own-team의 올림을 이김), `presets/readonly.test.ts`의 읽기 전용 역할 `github.write` 거부. own-team `test/e2e/claude-agent-github.e2e.test.ts`(3, 실제 서버, 가짜 claude와 가짜 GitHub): 영역에 계정을 고정한 Claude Agent 담당의 GitHub 쓰기가 묻고 승인 뒤 그 계정으로 한 번 실행되고, 영역의 셸이 그 계정의 git 로그인을 받으며 셸이 찍은 토큰은 가려지고, 사용자가 적은 토큰은 주 요청에서도 `POST /api/session/:id/generate`의 갈래 대화 기록에서도(도는 동안 15 ms마다 봄) Claude Agent 폴더의 어느 파일(공유 기록, 계정 폴더, 가짜 claude가 받은 것의 기록)에도 없다. 고침을 빼면 세 번째 시험이 실패한다.
- own-accounts `test/github/github-agents.e2e.test.ts`(3, 실제 upstream 서버): 사용자 설정 에이전트를 `default_agent`로 쓴 대화의 쓰기가 묻고(검토의 gv1 사례), `항상 허용`한 도구·저장소·계정은 다음 대화에서 묻지 않고, 세션 규칙이 모든 것을 허용하는 대화(omo의 하위 대화)도 묻고, 지어낸 `*/*`는 저장되지 않으며, 설정에서 지운 `항상 허용`은 기본 에이전트의 대화와 allow-all 대화 모두에서 다시 묻는다(검토 gw1의 `stale.e2e.test.ts` 사례).
- own-omo `test/unit/client.test.ts`: 하위 대화의 세션 규칙이 `{github.write, *, ask}`로 끝난다.
- core `test/permission-saved-hook.test.ts`(P-047): `evaluate` 훅이 그 동작의 저장된 resource를 지금 저장된 그대로 받는다.
- own-omo `test/unit/agents.test.ts`: omo 하위 에이전트의 규칙에서 `github.write`가 `ask`.
- core `test/shell-session-hook.test.ts`(P-046): `create.before`가 `metadata.sessionID`의 대화와 `Shell.create`가 돌려주는 명령 ID를 받는다.
- own-accounts `test/github/github.e2e.test.ts`(5, 실제 upstream 서버): 두 계정, 도구 목록, 프로젝트 계정으로 Code Mode 호출, 대화 선택, 쓰기는 승인 요청이 먼저이고 답하기 전에는 GitHub에 아무것도 가지 않음, 이벤트·OWN_HOME·채팅 요청에 토큰 없음.
- own-team `test/integrate/push.test.ts`: 영역의 계정이 있으면 `git push`가 브리지의 도우미로 로그인.
- own-accounts `test/github/real-server.test.ts`(선택: `OWN_GITHUB_MCP_BIN`): 내려받은 공식 `github-mcp-server` v2.0.3(Windows x86_64 zip, sha256 `f0e1b988…94e0`이 릴리스의 checksums 파일과 GitHub API의 자산 digest 모두와 같음; Authenticode 서명은 없음, Smart App Control은 막지 않음)을 own의 stdio 세션으로 띄워 `initialize`·`tools/list`: 읽기 표시, toolset, 읽기 전용 모드가 맞다. 가짜 세분화 토큰과 닫힌 포트의 프록시라 GitHub로 나가는 요청은 없다.
- own-web `e2e/tools/github.pw.ts`(Playwright, `test:e2e:tools`의 백엔드에 가짜 GitHub): 페이지가 `연결`에 있고, 토큰으로 두 계정 연결(태그, 토큰 칸 비움, 도구 개수), `이 프로젝트의 계정`과 `지금 이 프로젝트`, `쓰기 허용`, `지우기…`, 페이지·github.json·`github.view` 답에 토큰 없음, 휴대폰 폭에서 가로 넘침 없음.
- own-protocol `rpc.test.ts`(메서드·이벤트·범위 수), own-runtime `redact-named.test.ts`(`github_pat_`), own-web `github/model.test.ts`(호스트의 선택이 이 PC의 것과 따로인 것 포함, §8), 라우트·설명서 장 제목.
- SSH 호스트(§8)의 시험은 §8.10.

---

## 11. 남은 일

- 실제 GitHub(운영 MCP 서버)와는 시험하지 않았다(사용자 토큰을 쓰지 않음). 공식 프로그램은 `initialize`·`tools/list`까지만 확인했다(도구 호출은 GitHub로 나가므로 하지 않음). 운영 서버가 Copilot 구독 없는 PAT에도 열려 있는지는 README의 PAT 문구를 근거로 하며, 첫 사용 때 `확인`으로 본다. 안 되면 로컬 `github-mcp-server`로 바꾼다.
- 공식 `github-mcp-server` 바이너리를 own이 내려받거나 번들하지 않는다(내려받기 승인 필요). 로컬 서버는 사용자가 받은 경로를 적는다.
- gh 로그인 가져오기(`gh auth token --user`), 대화 헤더의 계정 표시(PF5 여유), 팀 영역 목록에서 바로 고르기(지금은 영역 폴더를 프로젝트로 고른다), 설명서 그림.
- SSH 원격 호스트(§8)의 남은 일: §8.9.
- `항상 허용`이 프로젝트 규칙으로 저장되면 그 프로젝트의 모든 대화에 적용된다(core 동작).
- 두 번째 검토 전에 저장된 `github.write` 규칙(`<도구> <owner>/<repo>`, 계정 없음)은 더 이상 맞지 않아 한 번 더 묻는다. 다시 `항상 허용`하면 계정이 든 규칙이 저장된다. 옛 규칙은 설정 > 승인·권한에서 지울 수 있다.
- §6.6의 남는 위험.
