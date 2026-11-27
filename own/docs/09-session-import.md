# 09. 다른 도구의 대화 가져오기 (Codex, Claude Code)

| 항목 | 값 |
|---|---|
| 문서 | `own/docs/09-session-import.md` |
| 상태 | v0.2 승인 (2026-10-08). **2026-10-25(SK2 머리말 언어)**: `---js` 같은 다른 언어 머리말은 읽지 않고 `형식이 맞지 않음`(9.12). `---yaml`·`---yml`은 core의 P-036처럼 YAML로 읽음(9.12, SK2-19). **2026-10-25(SK2 두 번째 리뷰)**: 머리말 별칭 폭탄의 한도와 예산, 본문의 모든 원격 그림 가리기, worker 파싱과 글 그대로 보이기, core가 싣는 스킬과 내용으로 맞추기(`skills.list{directory}` `loaded`), 통째로 링크인 계정 홈, 너무 큰 스킬의 한도, `확인 중…`, 링크 승인은 `local`, 계정과 폴더 이름(9.11, 브랜치 `skills-r3`). **2026-10-24(SK2)**: 스킬 가져오기의 찾은 곳 이름·codex-multi-provider 계정 홈(스킬만, state.json만)·같은 스킬 한 줄·검색과 거르기·링크 복사와 승인·거짓 `형식이 맞지 않음` 수정·상세 보기(9.10, 브랜치 `skills-dedup`). **2026-10-10(SKILLS)**: 다른 도구의 스킬 가져오기와 URL로 설치(9장, 브랜치 `skills-import`, `own.import`의 `skills.*` 다섯), 8.1의 비목표에서 스킬을 뺌. **I2 구현, I1 구현·끝 조건 열림 (2026-10-09, IMPORT 단계 wave 1–7과 리뷰 수정, `main`)**: I1 찾기·보기와 I2 옮기기(7.1)가 들어갔고, 기기 범위는 Q2 결정대로 열었다(5.5). I1의 끝 조건은 아직 열려 있다: IG5의 차가운 전체 색인(≤ 5초)이 wave 7에서 바쁜 PC로 세 번 중 한 번만 통과했고, 게이트가 판정에 쓰는 쉬는 PC 값이 없다(7.4). 리뷰 수정 뒤 같은 바쁜 PC(다른 앱 CPU 약 40%)에서 다시 잰 세 번은 모두 5초 안이었다(4,092–4,164 ms). 쉬는 PC에서 `bun run test:perf`로 다시 재어 5초 안이면 I1을 끝내고, 넘으면 색인을 고친다. 구현을 따라 바꾼 설계(구현이 이끈 변경): 5.5 표(I2 범위), 7.2 파일 표(설계 뒤 구현이 더한 파일), 4.4 2번(요약의 끝을 세션 로그가 아니라 보조 세션의 압축 메시지로 확인, IMPORT wave 5에 바꾸고 문서 맞춤 WP IMP.25에서 적음), 그리고 wave 1이 5.2 표보다 더한 계약 필드(`Summary`의 `versions`·`parent`·`archived`·`otherComputer`, `outline`의 `tokens`·`unknownRecords`·`base`, `sources.list` 뿌리의 `directory`·`added`, `SourceRef` 토큰 형식). 이 문서는 wave 1 통합 커밋(`ca3cf4ac1d`)에 들어갔다(IMP.04는 따로 된 커밋을 바랐다). 리뷰 수정(2026-10-09)에서 바꾼 곳: 2.8(파싱 상한과 `too_large`), 3과 5.2(`sessions.read`·`search`·`migrate.plan`이 폴더를 이름 짓고 그 프로젝트의 대화만 닿음), 4.5(처음 대상은 원래 도구의 구독 slot, 요약 모델이 다른 회사면 `cross_company`와 `Send.nowTo`), 4.6(사용량 부족 판정의 지금 범위), 5.3(발행 인스턴스), 5.5(입력별 범위와 보조 세션 표시), 5.6(slot Z는 프로세스 전체), 7.2, 7.4(IG4). IMPORT 자동 종료 확인은 2026-10-09에 했다(wave 7, 7.4의 `I1·I2 결과`, 게이트 보고서 [`own/reports/import-i1-i2-gates.md`](../reports/import-i1-i2-gates.md)). 남은 것은 쉬는 PC에서 다시 잴 IG5 차가운 색인(I1 끝 조건)과 사용자가 돌리는 IG12(실제 provider)·IG13(이 PC의 실제 저장소)이다. 사용자 요청(2026-10-08): 프로젝트 폴더에 Codex·Claude Code 같은 도구가 남긴 대화를 찾아 읽고, 필요하면 LLM 요약을 거쳐 own 대화로 옮겨 이어 간다. v0.2는 v0.1 리뷰 36건을 반영했다. 큰 줄기: 원본 SQLite는 제자리에서 열지 않고 사본을 연다(2.3). 요약은 이어 갈 계정이 하거나 LLM 없이 한다(07 R4, 4.5). 방식은 `그대로 이어가기`와 `요약해서 이어가기` 둘이다(4.3). 요약해도 최근 턴은 창이 허락하는 만큼 원문으로 남긴다(07 R8, 4.3). Codex 원격 압축은 프로그램 요약 checkpoint로 바꾸고 경계를 넘어 창을 채운다(4.1). 원본 checkpoint는 턴 중간 자리에 둔다(4.1). 다른 도구의 도구 기록은 user 역할의 과거 기록으로 넣는다(4.2). 가져온 세션은 own.accounts의 측정에서 뺀다(4.2). 전송 안내는 모든 방식에 보인다(4.5). v0.1 사본은 세션 scratchpad의 `session-import/09-v0.1-pre-review.md`다. 열린 질문 3개(8.2)는 2026-10-08에 이 문서의 처음 값대로 정했다 **2026-10-24(SM)**: 가져온 스킬 지우기 `skills.remove`(own-import의 사본만, `local`)와 설정 > 스킬(03 §19.6.1) 9.6·9.9, 다른 도구의 MCP 서버 가져오기는 own.accounts의 `mcp.import.*`(02 §9.2, 03 §18.14)로 9.9. **2026-10-26(SG)**: 가져올 스킬의 `쓰는 곳`(`이 프로젝트만`)은 복사하기 전에 own.accounts에 저장한다 9.4, 쓰는 곳과 스위치는 own.accounts의 것 9.6, 열린 문제 9.9. **2026-10-26(SG 리뷰)**: 바꾸기도 고른 쓰는 곳을 따르고 `모든 프로젝트`는 남은 쓰는 곳을 지움 9.4, 지운 폴더의 남은 쓰는 곳 9.6. |
| 기준 소스 | `D:\own-open-code` `main` `dae7b8e6b4`(v2.0.24 동기화 뒤). 원본 형식은 이 PC의 Codex 0.153.x(`~/.codex`)와 Claude Code 2.1.281–2.1.288(`~/.claude`)에서 확인했다. 키, 레코드 종류, 개수, 크기만 보았고 대화 내용은 읽거나 옮기지 않았다. Bun 1.4.2 실측 둘(리뷰): WAL DB를 읽기 전용으로 열 때 생기는 옆 파일(2.3), zstd 스트리밍의 메모리(2.5) |
| 사전 조사 | 2026-10-08 워크플로 조사 4건. `[R-codex]`: Codex 저장 형식, Codex의 `/import`(`codex-rs/external-agent-migration`). `[R-claude]`: Claude Code 저장 형식, Agent SDK 세션 파서(`claude-agent-sdk-python`, MIT). `[R-others]`: 그 밖의 도구 저장소. `[R-own]`: own v2의 가져오기·압축·계정 정책 접점. 스크래치 메모는 세션 scratchpad의 `session-import/`에 있다 |
| 관련 | 01 §4(플러그인 순서), §8.7(R4 summary 압축, R8 결정적 훅, R13 같은 slot). 02 §4.7(자동 압축), §5.10(구독 정책과 추천), §6(추정기), §9(RPC). 03 §5.1(입력창 `추천`), §20(성능). 05 §13.4–13.5(게이트웨이 범위). 06 §3.7·§6.2(프로그램 인계). 07 U1·U5·U6, §5.4(`Preset.allowed`) |
| 표기 | **⚠** = 소스나 실측으로 확인하지 못한 가정이다. 뒤에 게이트(IG*, 7.4)를 적는다. `IM-D*`는 이 문서의 결정이다. `07 R4`·`07 R8`은 07의 사용자 요구(같은 회사의 다른 구독을 함께 쓰지 않음, 문맥을 모델 능력보다 줄이지 않음)이고, `01 R4`·`01 R8`은 01 §8.7의 캐시 규칙이다 |

---

## 0. 사용자용 한 페이지

```text
▾ own-open-code
    리뷰 지적 고치기 · 2분 전
    설치기 정리 · 어제
    다른 도구의 대화 · 새 3개 ›     ← 이 폴더에서 Codex·Claude Code가 남긴, 아직 가져오지 않은 대화
```

1. **찾기.** 사이드바에서 폴더(프로젝트)를 펼치면, own이 그 폴더에서 Codex나 Claude Code로 나눈 대화가 있는지 이 PC 안에서만 찾는다. 아직 가져오지 않은 대화가 있으면 목록 끝에 `다른 도구의 대화 · 새 N개`가 보인다. 프로젝트 `⋯` 메뉴의 `다른 도구의 대화…`로는 언제나 열 수 있다.
2. **목록.** 줄마다 제목과 그 아래 첫 요청 한 줄, 도구(Codex / Claude Code), 마지막 활동, 원래 모델이 보이고, 줄 끝에 `열기`와 `이어서 하기`가 있다. 붙는 표시:
   - `가져옴`: 이미 own으로 옮긴 대화. 원본이 그 뒤로 길어졌으면 `원본에 새 턴 N개`
   - `진행 중일 수 있음`: 그 도구가 2분 안에 쓴 대화
   - `폴더 없음`: 원래 작업 폴더가 지워진 대화
   검색 상자는 제목을 찾고, `내용까지`를 켜면 사용자와 모델의 글도 찾는다(도구 출력은 찾지 않는다).
3. **읽기 전용으로 보기.** 하나를 열면 대화, 도구 호출(실행한 명령, 바꾼 파일), 그 도구가 압축한 자리가 보인다. 머리에 턴 수와 크기(토큰 추정)가 보인다. 원본 파일은 바꾸지 않는다. LLM을 부르지 않으므로 사용량도 들지 않는다. "그때 무슨 얘기를 했지"를 확인하는 데는 이것으로 충분하다.
4. **이어서 하기.** 목록 줄이나 보기의 `이어서 하기`를 누르거나, 사용자 메시지 옆의 `여기까지 이어서 하기`로 그 지점까지만 가져온다. 방식은 둘이다.

| 방식 | 하는 일 | 처음 값 |
|---|---|---|
| `그대로 이어가기` | 대화를 own 대화로 옮긴다. 모델은 원래 모델이 마지막에 보던 것을 본다: 그 도구가 압축했다면 그 요약과 그 뒤의 대화다. Codex의 암호화된 압축은 읽을 수 없으므로, 대신 창이 허락하는 만큼 그 앞의 대화를 원문으로 더 넣고 나머지는 프로그램이 뽑은 사실과 사용자 요청 목록으로 채운다. LLM 호출 없음 · 첫 메시지에 전체가 캐시 없이 전송 | 고른 모델의 창에 들어갈 때. Codex 원격 압축 대화는 언제나 |
| `요약해서 이어가기` | 창에 들어가는 만큼 최근 대화를 원문으로 두고, 들어가지 않는 앞부분만 요약한다. 요약 출처는 `이어 갈 모델로 요약`(비용 표시)이나 `LLM 없이`(무료: 그 도구의 요약 + 프로그램이 뽑은 사실 + 사용자 요청 목록) | 창에 들어가지 않을 때 |

   - 창에 들어가는 대화를 가볍게 시작하고 싶으면 `그대로` 가져온 뒤 `압축`을 누른다. 보통 대화와 같은 동작이다.
   - `자세히`의 `원래 대화 전체도 own에 저장`(처음 켬)은 모델이 보지 않는 앞부분도 own 대화에 남긴다. Claude Code는 30일 지난 기록을 지우므로 켜 두는 편이 낫다.

5. **계정과 모델.** 원래 도구와 같은 회사의 계정이 있으면 그 계정이 처음 값이고 `원래와 같은 회사`가 붙는다. 없으면 그 폴더의 새 대화와 같다(마지막에 쓴 모델, 없으면 묶음의 `새 대화 기본 모델`). 모델 고르기 옆에 `원래: <모델>`이 보인다. 남은 사용량이 가장 넉넉한 같은 종류 계정에 `추천`이 붙고, 요약할 사용량이 모자라면 `추천` 계정을 바로 고를 수 있는 대안으로 보인다. own이 대신 고르거나 계정을 돌리지는 않는다. 요약은 이어 갈 계정이 하거나 LLM 없이 한다.
6. **실행 전에 보이는 것.** 방식마다 비용(요약, 첫 요청, 이후 요청마다), "약 N 토큰이 <계정>으로 전송됩니다"(`그대로`는 "첫 메시지와 함께"), 원래 도구와 다른 회사면 `다른 회사`, 가져올 위치가 목록을 연 폴더와 다르면 그 위치와 브랜치.
7. **결과.** `가져오기`를 누르면 새 own 대화가 열리고, 머리에 `Codex에서 가져옴`이 붙는다(원본 보기, 가져온 정보). 거기서부터 평소처럼 이어 간다. 나중의 압축, 계정 전환, 프리셋도 보통 대화와 같다.

**지키는 것.**
- 다른 도구의 파일은 읽기만 한다. 쓰지도, 옮기지도, 지우지도, 잠그지도 않는다. 그 도구의 DB는 제자리에서 열지 않고 own 임시 폴더에 복사한 사본을 연다. 로그인 파일(`auth.json`, `.credentials.json`)은 열지 않는다.
- 찾기와 보기는 이 PC 안에서 끝난다. 대화 내용이 밖으로 나가는 때는 둘이다: `이어 갈 모델로 요약`을 고르면 실행할 때 요약할 부분이 그 계정(설정 `agents.compaction.model`이 요약 모델을 바꿨으면 그 모델, 계획에 보임)으로 가고, 가져온 대화를 이어 가면 첫 메시지부터 모델이 보는 부분이 그 계정으로 간다. 원래 도구와 다른 회사의 계정이면 다른 회사로 가는 것이다.
- 암호화된 추론, 다른 회사의 압축 상태, 그 도구의 시스템 프롬프트는 옮기지 않는다. 다른 모델에서는 쓸 수 없고 own의 규칙(01 R4·R8)과도 맞지 않는다.
- 비밀처럼 보이는 값(API 키, 토큰, 개인키)은 처음 값으로 `[redacted:<종류>]`(예: `[redacted:API key]`)로 가린다. 해시 조각은 넣지 않는다. 원본에는 그대로 남는다.

---

## 1. 결정

### 1.1 IM-D1–IM-D10

1. **IM-D1 v1 원본은 Codex와 Claude Code 둘이다.**
   - Codex의 뿌리: `$CODEX_HOME`, 없으면 `~/.codex`.
   - Claude Code의 뿌리: `$CLAUDE_CONFIG_DIR`, 없으면 `~/.claude`. CLI, VS Code, Desktop `Code`가 모두 같은 파일을 쓴다.
   - 그 밖의 폴더(예전 codex-multi-provider 앱의 프로필 홈 `<control-center>\profiles\<id>\codex` 등)는 설정의 `찾을 곳 더하기`로 손으로 더한다. 프로필 11개에 rollout이 모두 1개뿐이라 자동 발견은 I3이다. Claude Desktop 색인(제목, 보관 여부)도 I3이다.
   - 그 밖의 원본은 I3 이후다(1.3).
2. **IM-D2 읽기만 하고 이 PC 안에서만 한다.**
   - 원본에 아무것도 쓰지 않는다. 제목, 잠금, 압축 해제 파일, SQLite의 `-wal`·`-shm`도 포함이다.
   - 원본 SQLite는 제자리에서 열지 않는다(2.3). 읽기 전용으로 열어도 WAL DB는 옆에 `-shm`·`-wal`을 만들거나 고치고 공유 잠금을 잡는다.
   - `codex app-server`나 `claude` 같은 원본 도구 프로그램을 띄우지 않는다. Codex app-server는 시작할 때 저장소를 압축하고 형식을 옮기기(쓰기) 때문이다.
   - 찾기·보기·검색은 네트워크를 쓰지 않는다. 대화 내용은 own-telemetry, 진단, 로그로 나가지 않는다.
3. **IM-D3 폴더 단위로 보인다.** 목록은 한 own 프로젝트에 속한 대화다. 프로젝트의 작업 폴더는 core가 그 프로젝트 ID로 기록한 모든 폴더와, 그 폴더마다의 연결 작업 폴더(worktree), 그리고 그 하위 폴더다. 경로는 문자열을 정규화해 맞추고, 두 경로가 모두 있으면 실제 경로로 맞춘다(2.2). 원본 도구가 폴더 이름을 인코딩한 값을 되돌려 해석하지 않는다.
4. **IM-D4 core 패치 없이 upstream 공개 경로만 쓴다.** 코어 패치 ledger가 6/6이다(FORK.md §6). 가져오기는 `POST /api/experimental/session/import`(`SessionTransfer.import`)에 `SessionTransfer.Data`를 넘긴다. 이 경로는 메시지를 `session.created` 이벤트 하나의 commit 안에서 넣으므로 durable 로그가 최소로 유지된다(AGENTS.md V2 규칙). 요약은 core의 수동 압축(`POST /api/session/:id/compact`)이다. upstream이 바꿀 수 있는 실험 경로라서 `own/upstream-surface.json`에 항목을 둔다(7.2).
5. **IM-D5 모델이 보는 기록은 결정적이고 다른 회사의 상태를 담지 않는다.**
   - 넣지 않는 것: 암호화·서명된 추론, provider 상태, 원본 도구의 ID(`msg_…`, `toolu_…`, `call_…`), 가져온 시각, 계정.
   - 출처와 시각은 세션 metadata에만 둔다(01 R8).
   - 모델의 글은 assistant 메시지로 둔다. 다른 도구의 도구 호출과 결과는 "과거 기록"이라고 밝힌 user 역할 기록(synthetic 메시지의 `<imported-tool-activity>`)으로 옮긴다. own의 도구 호출(tool part)로 되살리지 않고, assistant 글 속에 넣지도 않는다(4.2).
6. **IM-D6 방식은 창 비율로만 판정한다(07 R8, U6).**
   - 모델이 볼 부분의 추정치를 대상 모델의 유효 ceiling과 비교한다. 들어가면 `그대로`, 아니면 `요약해서 이어가기`가 처음 값이다.
   - 요약해도 최근 턴은 창이 허락하는 만큼 원문으로 남기고, 들어가지 않는 앞부분만 요약한다. 요약 결과를 core의 `keep`(15k) 크기로 줄이지 않는다. `LLM 없이`도 같다.
   - 비용 때문에 두는 "N 토큰이 넘으면 요약" 같은 문턱은 없다.
   - 창에 들어가는 대화를 가볍게 시작하는 것은 가져온 뒤의 `압축`(사용자 동작)이다.
7. **IM-D7 요약은 core 압축으로 한다.** 숨긴 보조 세션에서 core `SessionCompaction`을 수동으로 한 번 돌려 요약을 얻는다(4.4). 그래서 템플릿, 예산, 재시도, 사용량 기록, 결과 모양이 own의 보통 압축과 같다. 결과는 요약형 checkpoint(`compaction` completed, `providerContext` 없음)이고, 어느 provider에서든 다시 읽힌다(01 R4). 그 뒤의 압축도 평소대로 일어난다. v1은 한 번에 요약한다. 조각으로 나눈 이어 요약은 측정(IG13) 뒤 I3에서 정한다.
8. **IM-D8 계정과 모델은 사용자가 고른다(07 R4, U1, U5).**
   - 처음 값: 원래 도구와 같은 회사의 계정, 없으면 그 폴더의 새 대화와 같다(4.5).
   - `추천`은 표시만 한다(03 §5.1, 02 §5.10). 고르는 것은 사용자다.
   - **요약은 이어 갈 계정이 한다.** 따로 고르는 요약 모델은 v1에 없다. 다른 계정으로 요약하고 싶으면 이어 갈 대상을 바꾼다. 같은 회사의 다른 구독 계정이 이 대화의 내용을 만들지 않는다(02 §5.10: 세션 하나에서 회사마다 구독 하나, 경고로 허용하는 길 없음). 설정 `agents.compaction.model`이 요약을 다른 모델로 돌리면, 그 모델을 계획에 보이고 같은 검사를 한다(4.5).
   - 자동 선택, 계정 돌리기, 한 번의 요약을 여러 계정에 나누기, 실패한 뒤 다른 계정으로 다시 시도하기는 없다.
9. **IM-D9 출처를 남기고 다시 가져오기를 알아본다.**
   - 세션 metadata `own.import`에 원본 도구, 원본 ID, 경로, 원본 시각, 내용 해시, 가져온 시각을 둔다.
   - 세션 ID는 보통 세션과 같다(4.7).
   - 이미 가져온 원본은 목록에 `가져옴`으로 보인다. 다시 가져오면 언제나 새 세션이다. 기존 own 세션에 새 턴을 덧붙이는 것은 공개 경로로 할 수 없어 하지 않는다(8.1).
10. **IM-D10 새 플러그인 `own.import`가 맡는다.** RPC id도 `own.import`다. 이유와 버린 대안은 5.1에 있다. own.accounts에는 두 가지만 더한다: 비용 추정 읽기 메서드 하나(`estimate.request`, 5.6), 그리고 가져온 세션을 측정(Z, 로컬 창)에서 빼는 것(4.2).

### 1.2 Codex `/import`에서 가져온 것과 다르게 한 것

Codex(0.128–0.130에서 이동 체계, 0.140에서 TUI `/import`)는 Claude Code와 Cursor의 세션을 가져온다(`[R-codex]`).

| Codex | own |
|---|---|
| 감지 → 항목 고르기 → 백그라운드 가져오기와 진행 알림 → 결과 요약 | 같은 순서: `sessions.list` → `migrate.plan` → `migrate.execute`와 `job.*` 이벤트(5.2) |
| 기본 범위는 파일 mtime 기준 최근 30일, 50개 | 폴더 단위 목록, 최근 순, 50개씩 `더 보기`. 나이로 자르지 않는다 |
| Claude 줄을 파일 순서대로 읽고 `user`/`assistant`만 쓴다 | `parentUuid` 사슬을 잎에서 거슬러 오르고, 병렬 호출의 결과를 다시 붙이고, 압축 경계를 턴 중간 자리까지 따르고, 사람이 대기열에 넣은 프롬프트(`queued_command`, origin `human`)도 넣는다(2.6) |
| 생각(thinking)은 버리고, 도구 호출은 `[external_agent_tool_call: name]` 텍스트로 바꾼다(입력 2,000자, 결과 4,000자로 자름) | 생각은 버린다. 도구 기록은 "과거 기록"이라고 밝힌 user 역할 기록으로 옮기고 assistant 글 속에 넣지 않는다. 모델이 보는 부분은 입력 16 KiB, 결과 64 KiB까지 원본 모델이 본 그대로이고, 그 밖의 턴은 한 줄 메모다(4.2) |
| 원본 모델을 버리고 지금 기본 모델을 쓴다 | 원래 모델은 provenance로 남긴다(assistant 메시지의 표시용 모델, metadata). 처음 값은 원래와 같은 회사의 계정이고, 이어 갈 모델은 사용자가 고른다(4.5) |
| 바이트/4로 가짜 토큰 수를 넣어 첫 후속 요청에서 자동 압축이 일어나게 한다 | 가짜 사용량을 넣지 않는다. 창에 들어가면 그대로 쓰고, 들어가지 않으면 최근 턴을 창이 허락하는 만큼 원문으로 두고 앞부분만 지금 요약한다(IM-D6·IM-D7) |
| 원장 파일(경로, sha256 → thread)로 같은 원본을 건너뛰고, 원본이 늘어나면 접미 부분만 덧붙인다 | 원장 대신 세션 metadata(`contentHash`)로 알아본다. 덧붙이기는 하지 않는다(IM-D9) |
| UI에만 보이는 `<EXTERNAL SESSION IMPORTED>` 표지 | 머리의 `…에서 가져옴` 표시는 metadata에서 만든다. 모델에게는 정해진 문장의 안내(system 메시지)를 준다(4.2) |

Claude Code에는 세션 가져오기가 없다. `/import`는 설정만 가져오고 `/export`는 평문이다(`[R-claude]`). 그래서 JSONL을 직접 읽는다. 알고리즘은 MIT인 Agent SDK(Python) `sessions.py`를 옮기고 출처를 적는다.

### 1.3 v1 밖의 원본

| 묶음 | 원본 | 메모 |
|---|---|---|
| I3 먼저 | OpenCode 계열: v1 JSON 저장소, `opencode*.db`의 v1 테이블, 다른 설치의 v2 DB, Kilo `kilo.db` | `V1Migration.transformSession`(`packages/core/src/database/v1-migration.bun.ts`)과 `importNextDatabase`의 읽기 패턴을 쓴다. `V1Migration.run`은 연 DB를 고쳐 쓰고 event 테이블을 비우므로 다른 도구의 DB에는 절대 쓰지 않는다. 원본 DB는 `bun:sqlite` `{readonly:true}`로도 제자리에서 열지 않는다. Codex DB와 같은 사본 읽기(2.3)만 쓴다: `*.db`와 그 `-wal`을 own 임시 폴더에 복사해 연다 |
| I3 먼저 | Gemini CLI | JSON과 JSONL(`$set`, `$rewindTo`) 둘 다. 프로젝트 id는 경로의 sha256이라 여러 정규화 형태로 후보 해시를 만든다 |
| I3 먼저 | Codex·Claude 보강 | codex-multi-provider 프로필 홈 자동 발견(`CodexSource`처럼 `state.json`에서 id를 읽되 `auth.json`은 열지 않는 함수), Claude Desktop 색인 `%APPDATA%\Claude\claude-code-sessions\**\local_*.json`(제목, 보관 여부), 정확한 실행 중 감지(2.5, 2.6) |
| I3 선택 | Grok Build | 이 PC에 실제 세션이 있는 유일한 다른 도구다. 작업 폴더는 `summary.json` `info.cwd`. `~/.grok/auth.json`은 열지 않는다 |
| 나중 | Qwen Code(Gemini 파서), Cline/Roo/옛 Kilo(공용 파서), Crush, Goose, Copilot CLI, Continue, Aider(요약만), Cursor(CLI 기록 먼저) | 커넥터 = 파서 + fixture. 옮기기 파이프라인은 바꾸지 않는다 |
| 하지 않음 | Windsurf(암호화된 protobuf), 지금의 Amp(서버에만 있음, 로그인 필요), VS Code Copilot Chat(가치 낮음) | 감지되면 "가져올 수 없음"과 이유를 보인다 |

---

## 2. 찾기, 색인, 읽기

### 2.1 읽는 파일 (허용 목록)

| 원본 | 뿌리 | 읽는 것 | 열지 않는 것 |
|---|---|---|---|
| Codex | `$CODEX_HOME` 또는 `%USERPROFILE%\.codex`. `찾을 곳 더하기`로 더한 폴더 | `sessions\YYYY\MM\DD\rollout-*.jsonl[.zst]`, `archived_sessions\rollout-*`, `state_*.sqlite`와 그 `-wal`(own 임시 폴더로 복사만, 2.3), `session_index.jsonl` | `auth.json`, `config.toml`, `history.jsonl`(I3 후보), `thread_history_1.sqlite`(내부 캐시), `sqlite\codex-dev.db`, `state_*.sqlite-shm`, `*.lock`, `thread-writer-locks\`(I3에서도 stat만, 2.5) |
| Claude Code | `$CLAUDE_CONFIG_DIR` 또는 `%USERPROFILE%\.claude`. 더한 폴더 | `projects\<dir>\<uuid>.jsonl`. 같은 이름 폴더의 `subagents\**\agent-*.jsonl`과 `*.meta.json`, `custom-title.json`. `tool-results\*`는 보기에서 열 때만 | `.credentials.json`, `sessions\`(I3 후보, 2.6), `history.jsonl`(I3 후보), `file-history\`, `shell-snapshots\`, `projects\*\memory\` |

- 허용 목록 검사는 한 함수에서 한다. 실제 경로(junction 해석 뒤)가 뿌리 밖이면 거부한다. 클라이언트는 경로가 아니라 `SourceRef`(5.2)만 넘긴다.
- 상대 경로, 네트워크 공유(`\\server\share`), 열지 않는 폴더인 뿌리는 `path_denied`다. 환경 변수(`CODEX_HOME`, `CLAUDE_CONFIG_DIR`)나 손으로 고친 `import-sources.json`에서 왔어도 같다. 목록(`sources.list`)에는 보이지만 색인은 그 뿌리를 읽지 않고, 허용 목록도 그 아래 파일을 거부한다.
- 같은 Codex thread의 파일이 여럿이면 2.5의 규칙으로 하나만 남긴다. 되돌림으로 파일이 둘이 된 경우와 여러 뿌리에 있는 경우다.
- 뿌리를 더하는 곳은 설정 > 다른 도구 > `찾을 곳 더하기`다(`sources.configure`, `local`). 저장은 `OWN_HOME/state/import-sources.json`. 예전 codex-multi-provider 프로필 홈도 여기서 더한다. 그 폴더의 `auth.json`은 열지 않는다.

### 2.2 폴더와 맞추기 (Windows 경로)

- **정규화** `norm(p)`:
  - 접두 처리: `\\?\` 제거, `\\?\UNC\` → `\\`
  - 구분자: `/` → `\`, 겹친 구분자 하나로, 끝의 `\` 제거(드라이브 루트 제외)
  - 유니코드 NFC, 비교할 때만 소문자로 바꾼다(NTFS 기본은 대소문자 무시)
  - `file://` URI는 디코드한다
  - Codex는 thread 3,217개 중 2,941개가 `\\?\C:\…` 형태다.
- **실제 경로.** 문자열만으로는 junction, `subst` 드라이브, 8.3 짧은 이름을 놓친다. 그래서 두 경로가 모두 있으면 `fs.realpathSync.native`로 바꿔 비교한다. 하나라도 없으면 정규화한 문자열로 비교한다.
- **속함.** 대화의 cwd가 프로젝트의 작업 폴더 중 하나와 같거나 그 아래면 그 프로젝트의 대화다. 작업 폴더는 다음을 합친 것이다.
  - core가 그 프로젝트 ID로 기록한 모든 폴더(sandboxes).
  - 그 폴더마다 돌린 `git worktree list`의 연결 작업 폴더(예: `.worktrees\cl-perf`).
  - 이 PC의 `D:\own-open-code`와 `D:\#Projects\own-open-code`는 root commit(`4b0ea68`)이 같아 core에서 한 프로젝트(같은 Project ID)다. 뒤의 clone에 worktree가 12개 있고, Claude에는 두 clone의 프로젝트 폴더가 다 있다. 한 clone에서 `git worktree list`를 돌려서는 다른 clone이 보이지 않으므로, 기록된 폴더마다 돌린다.
- **Codex cwd**: DB 사본(2.3)의 `threads.cwd`, 없으면 rollout 첫 줄 `session_meta.cwd`.
- **Claude cwd**: 레코드마다 `cwd`가 있고 대화 중에 바뀔 수 있다(로컬 23개 중 8개). 처음과 마지막 레코드의 cwd, `relocated.relocatedCwd`를 모아 하나라도 맞으면 속한다. lite 읽기로 정한 소속은 잠정이다(2.3).
- **가져올 위치**의 처음 값은 대화의 마지막 cwd다. 목록을 연 폴더와 다르면 대화상자가 그 위치와 브랜치를 보이고 `이 폴더에서 이어가기`로 바꿀 수 있다(6). 한 저장소의 연결 작업 폴더끼리는 브랜치가 다르므로, 말없이 다른 checkout에서 도구가 돌지 않게 하기 위해서다.
- **Claude 폴더 이름**은 영숫자가 아닌 글자를 모두 `-`로 바꾼다(`D:\#Projects\own-open-code` → `D---Projects-own-open-code`, 200자가 넘으면 해시를 붙임). 정보가 사라져 서로 다른 경로가 부딪칠 수 있다. 그래서 빨리 후보를 고르는 데만 쓰고, 언제나 파일의 cwd로 확인한다.
- **폴더가 없어진 대화**도 경로 문자열이 프로젝트 아래면 보인다(`폴더 없음`). 가져올 위치의 처음 값은 프로젝트 루트다.
- **`모든 폴더` 보기**: 폴더 이름을 바꾸거나 옮긴 프로젝트를 위해, cwd별로 묶은 모든 대화를 보이고 `이 폴더로 가져오기`로 위치를 바꿔 가져올 수 있다. Claude Desktop의 SSH 원격 세션(`projects\ssh-*`)은 cwd가 원격 경로라 여기서만 보이며, `다른 컴퓨터` 표시가 붙는다.

### 2.3 색인과 캐시

- **언제 만드나.** 플러그인을 불러올 때는 아무것도 하지 않는다(01 §6.6 PF1·PF6). own-web이 `sessions.list`나 `sources.list`를 처음 부를 때 만든다. 스캔과 파싱은 플러그인의 Worker 스레드에서 돌린다. 서비스 이벤트 루프가 다른 대화의 스트리밍과 RPC를 계속 처리하게 하기 위해서다(IG5).
- **Codex 빠른 길(DB 사본).**
  - **제자리에서 열지 않는 이유.** `state_5.sqlite`는 WAL DB다. 이 PC에는 아직 되써지지 않은 `-wal`(4.3 MB)과 `-shm`이 지금 있다. `bun:sqlite` `{readonly:true}`로 열어도 `-shm`·`-wal`이 없으면 만들고, 닫은 뒤에도 남긴다(Bun 1.4.2 실측). 읽기 연결은 공유 잠금을 잡고 `-shm` 색인을 고치며, 긴 읽기는 Codex의 WAL 되쓰기를 막는다. `immutable=1`은 쓰지 않지만 WAL을 무시해서 최근 thread가 빠진다.
  - **사본 읽기.**
    1. 번호가 가장 높은 `state_*.sqlite`를 고른다(접미 `_5`를 박아 두지 않는다).
    2. 그 파일과 `-wal`(`-shm`은 아님)을 own 임시 폴더(`OWN_HOME/tmp/import-<무작위>/`)에 한 번에 빨리 복사한다.
    3. 복사하는 동안 두 파일의 크기나 mtime이 바뀌었으면 다시 복사한다(3번까지).
    4. 사본을 읽기 전용으로 열어 열을 검사하고 `threads`를 읽는다.
    5. 닫은 뒤 임시 폴더를 지운다. 사본에는 제목 같은 사용자 내용이 있으므로 읽는 동안만 둔다.
  - 읽는 열: `id, rollout_path, cwd, source, thread_source, archived, title, name, model, model_provider, created_at_ms, updated_at_ms, cli_version, history_mode`. 하위 에이전트 관계는 `thread_spawn_edges`에서 읽는다.
  - 파일이 없거나, 복사가 실패하거나, 열이 다르면 파일 스캔으로 넘어간다.
  - rollout 경로는 `.jsonl`, `.jsonl.zst`, `archived_sessions` 순으로 찾는다. 로컬에서 thread 1,484개는 `.zst`로만 있고 441개는 파일이 없다. 파일이 없으면 오류가 아니라 `사용할 수 없음`이다.
- **Codex 파일 스캔.** 날짜 폴더를 stat만 하고, 캐시에 없는 파일의 첫 줄(최대 64 KiB, `.zst`는 앞부분만 풀기)에서 `session_meta`를 읽는다. 첫 줄은 기본 지시문을 품어 48 KB까지 커진다. thread id로 묶는 규칙은 2.5다.
- **Claude 스캔.**
  - `projects\*\`의 맨 위 `<uuid>.jsonl`만 본다(맨 위의 `agent-*.jsonl`, `*.superseded-*`, `*.orphaned-*`는 건너뜀).
  - 앞뒤 64 KiB만 읽는 lite 읽기(SDK `_read_session_lite`)로 cwd, 제목, 브랜치, 시작 시각, 버전, 마지막 모델을 얻는다. 사이드체인만 있는 파일은 건너뛴다.
  - lite로 정한 소속은 잠정이다. `relocated` 레코드나 바뀐 cwd가 앞뒤 64 KiB 밖에 있을 수 있기 때문이다. 첫 응답 뒤 Worker가 파일 전체를 JSON 파싱 없이 부분 문자열(`"cwd":"`, `"relocatedCwd":"`)로 훑어 cwd 집합을 확정한다. 소속이 바뀌면 `index.changed`를 낸다. 전체 파싱(보기, 계획)도 확정한다.
- **제목 순서.**
  - Codex: `session_index.jsonl`의 이름(마지막 항목이 이김) > `threads.name` > `threads.title` > 첫 실제 사용자 줄(120자)
  - Claude: `custom-title`(마지막) > `ai-title` > `last-prompt`나 옛 `summary` > 첫 의미 있는 사용자 줄(SDK `_extract_first_prompt_from_head`의 건너뛰기 규칙). Desktop 색인 제목은 I3이다.
- **첫 요청 줄.** 목록의 둘째 줄은 첫 실제 사용자 요청(120자)이다. Codex는 첫 줄 스캔에서, Claude는 lite 읽기에서 얻는다.
- **캐시.**
  - 메모리에서 `(path, size, mtimeMs)`를 키로 요약을 둔다.
  - 다시 켠 뒤 첫 목록을 빠르게 하려고 `OWN_HOME/state/import-index.json`에 내용이 아닌 필드만 저장한다: 경로, 크기, mtime, 종류, id, 정규화한 cwd, 부모, 하위 에이전트 여부, 시각, 원본 버전.
  - 제목, 첫 요청, 미리보기는 사용자 내용이라 메모리에만 둔다. core KV(평문)와 플러그인 storage도 쓰지 않는다.
- **증분.** Codex는 DB 파일과 `-wal`의 크기·mtime이 바뀌었을 때만 다시 복사하고, 그렇지 않으면 최근 날짜 폴더만 본다. Claude는 프로젝트 폴더와 파일의 mtime을 본다. 파일 감시는 걸지 않는다(로컬 Codex 저장소가 약 223 GB).
- **턴 수와 토큰 추정**은 목록에 보이지 않는다. 대화를 처음 열거나 계획할 때 전체를 파싱하며 계산하고, 보기의 머리와 대화상자에 보인다. 파일 크기는 도구 출력이 대부분이라 크기 표시로 쓰지 않는다. Codex DB의 `tokens_used`도 누적 과금 토큰이라 쓰지 않는다.

### 2.4 공통 기록 모델 (Transcript)

원본마다 파서는 하나의 모양을 만든다. 보기(3장)와 옮기기(4장)가 같은 것을 쓴다.

```ts
Transcript = {
  source: { kind: "codex" | "claude-code", id, rootID, path, versions[], app?, cwds[], branch?, title, firstPrompt?,
            models: { provider?, id }[], createdAt, updatedAt, bytes, parentID?, subagent, live }
  turns: Turn[]              // 사람이 보낸 실제 사용자 메시지 하나가 턴 하나다
  checkpoints: Checkpoint[]  // 원본 도구가 압축한 자리
  children: ChildRef[]       // 하위 에이전트 대화. 보기 전용 링크
  dropped: Record<DropKind, number>   // 버린 것의 종류별 개수(2.7)
  usage?: { input, output, cached }   // 표시용
}
Turn = { index, time, user: { text, images[], queued? }, steps: Step[], end: "completed" | "interrupted" | "error" | "open" }
Step = { type: "text", text }
     | { type: "reasoning-summary", text }                       // 보기 전용
     | { type: "tool", name, input, output?: { text, error, truncatedFrom? }, exit?, diff?, child? }
     | { type: "note", text }                                    // 한 줄 메모(작업 알림, 다른 에이전트의 인계)
Checkpoint = {
  at: { turn, step, source: { uuid } | { ordinal } }   // 원본 압축 레코드 바로 뒤. step = 그 턴에서 경계 앞의 step 수
  kind: "foreign" | "codex-remote"                    // foreign: 요약 글이 있음. codex-remote: 요약이 암호화됨
  summary?, recent: Line[], trigger?, preTokens?, postTokens?
}
Line = { role: "user" | "assistant" | "tool-call" | "tool-result", text }
```

- 원본 도구는 턴 중간에서 압축한다(2.5, 2.6). 그래서 checkpoint 자리는 턴이 아니라 원본 레코드(Claude uuid, Codex ordinal)와 `{turn, step}`이다.
- 파서는 경계에서 Effect Schema로 한 번 검증하고 타입이 있는 값을 안쪽으로 넘긴다(AGENTS.md).
- 시각이 없거나 거꾸로 가면 앞 시각 + 1 ms로 단조롭게 고친다.

### 2.5 Codex 읽기

- **봉투.** 줄마다 `{timestamp, type, payload, ordinal?}`다. 모르는 `type`과 필드는 건너뛰고 센다. `session_meta.cli_version`은 진단용으로 남긴다.
- **턴은 `response_item`으로 만든다.** legacy와 paginated 두 모드에 다 있기 때문이다.
  - `message`: user와 assistant(`phase` commentary/final_answer)
  - 도구: `function_call`/`_output`(인자는 JSON 문자열), `custom_tool_call`/`_output`(입력은 자유 텍스트, 예: `apply_patch` 본문), `web_search_call`, `local_shell_call`, `tool_search_*`. 호출과 결과는 `call_id`로 짝짓는다.
  - 보기의 풍부한 표시에는 paginated `event_msg/item_completed`(CommandExecution의 출력과 종료 코드, FileChange의 경로별 diff)를 쓰고, legacy는 `patch_apply_end`, `*_end` 이벤트를 쓴다.
- **주입된 문맥을 거른다.**
  - developer 메시지는 모두 버린다.
  - user 메시지에 `content_item_kinds`가 있으면 항목마다 거른다. `user.*`(글, 이미지 등)는 남기고 `agents_md.*`, `environments.*`, `plugins.*` 같은 주입 항목은 뺀다. 남은 항목이 없으면 메시지를 버린다. 메시지 단위로 `user.text`만 남기면 이미지가 든 사용자 메시지나 섞인 메시지를 잃는다.
  - 종류 표시가 없으면(옛 파일) 앞 태그 거부 목록으로 거른다: `<environment_context>`, `# AGENTS.md instructions`, `<user_instructions>`, `<recommended_plugins>`, `<skill>`, `<turn_aborted>`.
- **되돌림.** `thread_rolled_back{num_turns}`가 나오면 그때까지의 마지막 N개 사용자 턴을 뺀다.
- **rollout 파일과 thread.** thread를 되돌리면 Codex가 새 파일 `rollout-…-<threadId>_<rolloutId>.jsonl`을 쓰고(`rollout_file_name.rs`), 그 `history_base`가 옛 파일을 가리킬 수 있다. 그래서 한 thread에 파일이 둘일 수 있다.
  - DB 사본이 있으면 지금 파일은 `rollout_path`다.
  - 파일 스캔에서는 thread id로 묶고, 다른 파일이 `history_base`로 가리키지 않는 파일을 고른다. 그래도 여럿이면 가장 새 것을 고른다.
  - 그다음에 뿌리 사이의 중복을 thread id로 없앤다.
- **압축(`compacted`).**
  - **`replacement_history`가 담는 것**(Codex `compact.rs` `build_compacted_history`, `insert_initial_context_before_last_real_user_or_summary`): 마지막 실제 사용자 메시지 앞에 다시 넣은 시작 문맥(AGENTS.md, 환경), 남긴 실제 사용자 요청(20k 토큰까지, 잘릴 수 있음), 로컬 압축이면 `SUMMARY_PREFIX`로 시작하는 user 메시지인 요약 자체. assistant와 도구 턴은 없다. 그래서 own의 "최근 주고받기"와 같지 않다.
  - **`recent`**: `replacement_history`에서 요약 항목(`is_summary_message`)을 빼고, 다시 넣은 시작 문맥을 위의 주입 거르기로 뺀 사용자 요청들이다. 사용자 요청뿐이며 `[User]:` 줄로 적는다. 이어서 모델이 보는 부분은 `compacted` 레코드 뒤의 `response_item`들이다.
  - **자리**: 자동 압축은 턴 안에서도 일어난다. `at`은 그 레코드의 ordinal(없으면 줄 번호)과 그때의 `{turn, step}`이다.
  - **로컬 압축**(`message`가 비어 있지 않음): `kind: "foreign"`이고 `summary`는 `SUMMARY_PREFIX`를 뗀 본문이다.
  - **원격 압축**: 이 PC의 715개는 모두 OpenAI 원격 압축이다(`message` 비어 있음, 암호화된 `compaction` 항목). 요약은 쓸 수 없지만 `replacement_history`의 사용자 요청은 쓸 수 있다(로컬 271개, 모두 평문 `input_text`). 그래서 `kind: "codex-remote"` checkpoint를 만든다. `recent`는 위와 같고, `summary`는 옮길 때 프로그램 요약(`briefAt`, 4.4)으로 채운다. 암호화된 항목은 `dropped.remoteCompaction`으로 센다. 옮기기는 이 경계를 넘어 창을 채운다(4.1).
  - 파일은 덧붙이기만 하므로 압축 전의 원래 항목이 모두 남아 있다. 그래서 원격 압축이 있어도 전체 대화를 다시 만들 수 있다.
- **포크와 하위 에이전트.**
  - 두 번째 `session_meta`는 부모다. `subagent_history_start_ordinal` 앞의 항목은 물려받은 문맥이라 건너뛴다.
  - `history_base`는 다른 rollout의 앞부분을 가리킨다. 보기는 "앞부분은 <부모> 대화" 링크로 보이고, I2의 옮기기는 `end_byte_offset`까지 따라 읽는다(IG4).
  - 하위 에이전트 thread(로컬 thread 약 2,870개)는 목록에서 숨기고 부모 아래 자식으로 보인다.
- **추론.** `encrypted_content`는 버린다. `summary_text`는 보기 전용 `reasoning-summary`다.
- **모델.** 마지막 `turn_context.model` 또는 `token_usage_record.served_by`에서 읽고, provider는 `session_meta.model_provider`다.
- **zstd.** 스트리밍으로 푼다(`node:zlib` `createZstdDecompress`). Bun 1.4.2에서 풀린 418 MB를 RSS 약 21.5 MB를 더 써서 끝까지 읽었다(리뷰 실측). 압축 파일은 대화형 thread의 p90이 47–113 MB이고 가장 큰 것이 1.29 GB라, 풀면 수백 MB에서 GB가 된다. zstd는 중간부터 읽을 수 없으므로 보기는 앞에서부터 흘려 읽는다(2.8). 압축 전환 중 `NotFound`가 나면 한 번 다시 찾는다.
- **실행 중(`live`).**
  - v1: rollout의 mtime이 2분 안이면 `진행 중일 수 있음`이다.
  - I3의 정확한 신호: Codex는 쓰는 중인 thread를 `CODEX_HOME\thread-writer-locks\<threadId>.lock`으로 표시하고 OS 잠금으로 잡는다(`writer_lock.rs`). 이 파일이 있고 mtime이 최근이면 진행 중일 수 있다. stat만 하고 절대 잠금을 잡지 않는다. 잡으면 Codex가 "already has an active writer"로 실패한다. rollout 옆의 `*.lock` 파일은 이 신호가 아니다.

### 2.6 Claude Code 읽기

- **대화를 만드는 레코드**는 `user`, `assistant`, `system`(subtype `compact_boundary`)뿐이다. 나머지는 metadata다: `custom-title`, `ai-title`, `last-prompt`, `pr-link`, `cost-state`, `relocated`, `mode`, `queue-operation`, `file-history-*` 등.
- **사슬.** 레코드는 `parentUuid` DAG다. SDK `_build_conversation_chain`처럼 잎을 고른 뒤 루트까지 거슬러 오른다. 잎 고르기: 자식 없는 노드 → 가장 가까운 user/assistant, 사이드체인·팀·meta가 아닌 것, 파일에서 나중인 것. 편집이나 되감기로 버려진 갈래는 보기에서 `다른 갈래 N개`로만 보인다. `last-prompt.leafUuid`는 마지막 잎이 아니다(22개 중 1개만 맞음).
- **병렬 도구 결과.** 병렬 호출의 결과 일부는 형제 갈래에만 있다(로컬 사슬 위 `tool_use` 2,098개 중 86개). 사슬을 만든 뒤 `tool_use_id`로 다시 붙인다. 그래도 결과가 없으면 `interrupted before result was recorded` 오류 결과를 둔다.
- **나뉜 응답.** 응답 하나가 블록마다 레코드 하나로 나뉜다(1–8개, 같은 `message.id`와 같은 `usage`). 같은 `message.id`의 연속 레코드는 하나로 합친다. 사용량은 `message.id`마다 한 번만 센다.
- **압축.**
  - `compact_boundary`(`logicalParentUuid`, `compactMetadata{trigger, preTokens, postTokens, preservedSegment{anchorUuid, headUuid, tailUuid}}`)를 `kind: "foreign"` checkpoint로 바꾼다.
  - **자리.** 자동 압축은 턴 중간에서 일어난다. 이 PC의 자동 `compact_boundary` 12개가 모두 그랬다. 경계 앞의 마지막 메시지가 tool_result인 것이 8개, 사용자 요청인 것이 4개다. 12개 모두 요약 뒤 첫 메시지가 같은 턴을 이어 가는 assistant다. 그래서 `at`은 `{turn, step, source:{uuid}}`(경계 레코드의 uuid)다.
  - **`summary`**: `isCompactSummary` 레코드의 본문에서 Claude Code 하네스 문구를 뗀 것이다. 로컬 `isCompactSummary` 14개 모두에 다음 셋이 있다.
    - 첫 줄 "This session is being continued from a previous conversation…"
    - 끝의 "사용자에게 더 묻지 말고 이어 가라"는 지시(…continue … without asking the user any further questions…)
    - 원래 기록 `.jsonl` 경로를 가리키는 "read the full transcript at …" 줄
    - 남겨 두면 own의 모델이 스스로 움직이라는 지시와 `~/.claude` 아래 경로를 받는다. 모델이 그 경로를 읽으려 하면 외부 폴더 권한을 묻게 되고, 그 경로가 모델이 보는 글에 남는다.
    - 문구가 조금 바뀌어도 맞도록 핵심어로 찾고 fixture로 고정한다. 못 찾은 문구는 그대로 두고 진단 개수(`boilerplateUnmatched`)를 센다.
    - `LLM 없이`의 요약(4.4)도 같은 정리를 거친다.
  - **`recent`**: `preservedSegment`의 head..tail 메시지다. `preservedSegment`가 없는 옛 버전은 `recent`가 비어 있다.
  - 보기(전체 기록)는 `logicalParentUuid`를 따라 경계를 넘는다. 옮기기는 마지막 경계부터만 쓴다(4.1).
- **사람의 입력.**
  - user 문자열과 텍스트 블록에서 하네스 포장을 떼어 낸다: `<system-reminder>`, `<command-name|message|args>`, `<local-command-*>`, `ide_opened_file`/`ide_selection`.
  - `<task-notification>`은 한 줄 메모(`note` step)로 바꾼다.
  - `isMeta`인 user 레코드는 버린다.
  - `attachment` 중 `queued_command`(`commandMode: "prompt"`):
    - `origin.kind === "human"`(또는 `humanTurn`)이고 `isMeta`가 아니면 사용자 턴으로 넣는다(Codex가 놓치는 것).
    - 그 밖은 한 줄 메모다. 로컬 102개 중 2개가 `origin.kind: "peer"`·`isMeta: true`인 다른 에이전트의 인계였다.
    - 같은 프롬프트가 보통 user 레코드로도 남은 경우가 있다(로컬 1개). `source_uuid`나 글이 같은 user 레코드가 있으면 대기열 쪽을 버린다.
  - 다른 attachment는 버린다(`prompt_snapshot`은 Claude Code의 시스템 프롬프트를 품고 있다).
- **도구 결과.** 모델이 본 `message.content`만 쓴다. `<persisted-output>` 미리보기는 그대로 두고, 보기에서 `tool-results\<id>.txt`를 열 수 있게 한다. `toolUseResult`(stdout/stderr, `structuredPatch`, 원본 파일 전문)는 모델이 보지 않은 UI 데이터라 보기의 diff와 종료 코드에만 쓴다.
- **섞여 있는 합성 기록.** `message.model: "<synthetic>"`, `isApiErrorMessage`, `usageLimitNote`(API 오류, 한도 알림)는 버린다. `toolDenialKind`는 도구 오류로 남긴다. 모델이 그 일이 실행되지 않았음을 알아야 하기 때문이다.
- **생각.** `thinking`과 `redacted_thinking`은 늘 버린다. 서명은 만든 모델, 시스템 프롬프트, 도구, 앞 메시지에 묶이고, Sonnet·Haiku 5.5는 계정에도 묶인다. 로컬 생각 블록의 82%는 본문이 비어 있다. 본문이 있으면 보기 전용 `reasoning-summary`로 둔다. `tool_reference` 블록은 `[tool reference: <name>]`으로 바꾼다.
- **하위 에이전트.** 주 사슬만 쓴다. Agent 도구의 결과에 이미 부모가 본 보고가 있다. `subagents\agent-*.jsonl`은 `toolUseId`/`agentId`로 자식 링크를 만든다(보기 전용, 06의 자식 세션과 같은 생각).
- **실행 중.** v1은 파일 mtime 2분이다(2.5와 같다). I3의 정확한 신호: `sessions\<pid>.json`에 등록되고 그 pid가 아직 살아 있으면 `busy`든 `idle`이든 진행 중이다. 열려 있는 idle 세션도 Claude Code에서 이어 쓸 수 있기 때문이다.

### 2.7 버리는 것

| 무엇 | 이유 |
|---|---|
| Codex `reasoning.encrypted_content`, `agent_message`의 암호화 내용, 원격 `compaction` 항목(그 옆의 사용자 요청은 남김, 2.5) | OpenAI(와 계정)에 묶여 다른 slot에서 다시 쓸 수 없다. 01 R4: own은 모두 요약형 압축 |
| Claude `thinking`/`redacted_thinking`과 서명 | 모델·시스템·계정에 묶인다. Anthropic 문서가 다른 시스템에 다시 보낼 때 모두 빼라고 한다 |
| developer 메시지, 주입된 AGENTS.md·환경·플러그인 안내, Claude `prompt_snapshot`·attachment·하네스 포장, 압축 요약의 하네스 문구 | 원본 도구의 지시다. own의 지시 발견이 지금의 AGENTS.md를 첫 step에 따로 넣는다 |
| provider ID(`msg_`, `toolu_`, `call_`, `requestId`), `usage`, `token_count`/한도 스냅숏, `cost-state` | 모델이 볼 필요가 없다. 사용량 합계만 metadata에 표시용으로 둔다(4.2) |
| `file-history-*`, 체크포인트 백업, 셸 스냅숏 | 대화가 아니라 파일 상태다. 보기의 "만진 파일" 목록에만 쓴다 |
| 사이드체인, 하위 에이전트 기록 | 부모와 섞지 않는다. 자식 링크로만 보인다 |

### 2.8 견고성과 크기

- 한 줄 상한은 32 MiB다. 넘는 줄은 건너뛰고 `dropped.oversizedLine`으로 센다. 끝의 미완성 줄은 무시한다(원본 도구가 쓰는 중일 수 있다).
- 파일 하나의 오류는 그 대화만 `읽을 수 없음`(이유 포함)으로 만들고 목록은 계속된다. 모르는 레코드 종류가 있으면 보기에 `알 수 없는 형식 일부` 표시와 개수를 보인다.
- **언제나 스트리밍으로 읽는다.** 파일 전체를 메모리에 올리지 않는다. 풀린 내용을 디스크에 쓰지 않는다.
- **파싱 상한.** 전체 파싱(Claude Code 보기, 계획과 가져오기)은 모든 턴을 메모리에 들고(도구 출력과 이미지 포함) 서비스 스레드로 한 번 더 넘긴다. 그래서 풀린 바이트가 512 MiB(`Paths.PARSE_BYTES`)를 넘는 대화는 `source_unreadable{too_large}`다: Claude Code 파일은 읽기 전에 `stat` 크기로(보기와 가져오기 모두), Codex rollout은 가져오기 파싱에서(`history_base` 앞부분 포함) 판정한다. Codex 보기는 턴 단위로 흘려 읽으므로 크기 상한이 없다.
  - `.jsonl`: 보기는 턴 단위로 페이지를 나누고, 턴별 바이트 위치 색인(메모리)으로 원하는 페이지로 바로 간다.
  - `.zst`: 중간부터 읽을 수 없으므로 앞에서부터 흘려 읽는다. 첫 페이지는 나오는 대로 보인다. 개요(턴 목록, 턴·토큰 수)는 만들어지는 대로 흘려 보내고 취소할 수 있다. 풀린 턴 페이지는 메모리 LRU에 두고(상한 64 MiB ⚠IG5), 그 밖의 페이지로 가면 처음부터 다시 흘려 읽는다. 마지막 턴으로 뛰는 비용은 IG5에서 잰다.
- **파일 핸들.** 원본 파일은 공유 삭제를 허용해 연다(Windows `FILE_SHARE_DELETE`). `.jsonl`은 페이지마다 다시 열고 핸들을 들고 있지 않는다. 열린 핸들은 Codex의 "압축한 뒤 지우기"나 재개 때의 `.jsonl` 다시 만들기를 막을 수 있다. Windows는 열린 채 지운 파일을 닫힐 때까지 delete-pending으로 두기 때문이다. `.zst`를 흘려 읽는 동안에는 핸들이 열려 있으므로 IG1에서 확인한다 ⚠IG1.
- `sessions.list` 한 번은 2초 안에 답한다. 다 못 보았으면 `scanning: true`와 그때까지의 결과를 주고, 끝나면 `index.changed` 이벤트를 낸다.
- 버전 범위(`cli_version`, Claude `version`)를 provenance에 남긴다. 형식은 문서화되지 않았고 버전마다 바뀐다(Anthropic 문서가 "internal"이라고 적는다). 그래서 fixture를 버전별로 둔다(7.3).
- **가져오기 본문 크기.** 가져오기는 loopback JSON 본문 하나와 SQLite 트랜잭션 하나다. 메모리에는 IR, JSON, HTTP 디코드, 스키마 인코드로 몇 번씩 들어간다. 그래서 저장 모양(4.2)에 상한을 둔다.
  - 모델이 보는 부분: 도구 입력 16 KiB, 결과 하나에 64 KiB까지.
  - 모델이 보지 않는 턴: 한 줄 메모.
  - 본문 예산은 32 MiB다 ⚠IG5. 넘으면 계획이 `import_too_large`로 알리고, 모델이 보지 않는 가장 오래된 턴부터 저장에서 뺀다. 뺀 턴은 보기에는 남는다.

---

## 3. 읽기 전용 보기

- **데이터.** `sessions.read{ref, directory, scope?, from?, count?}`가 턴 페이지를 보기용 `SessionMessage.Info` 모양으로 준다(서버에 세션을 만들지 않는다). `directory`는 목록을 연 폴더이고, `ref`는 그 프로젝트의 대화여야 한다(5.5). `scope:"all"`이면 색인이 아는 어느 대화든 된다(`모든 폴더`, 이 PC의 창만).
  - 도구 호출은 원래 이름의 tool part로 준다. 입력 모양이 맞으면 v2 렌더러 이름(`shell`, `edit`, `patch`, `read`, `grep`, `webfetch` …)으로 바꾸고, 아니면 원래 이름 그대로 두어 `GenericTool`이 그린다. 보기는 모델에 보내지 않으므로 tool part를 써도 된다.
  - diff는 Codex FileChange와 Claude `structuredPatch`에서 온다. `reasoning-summary`는 reasoning part로 준다.
  - 함께 오는 개요: 턴 목록(사용자 첫 줄, 시각), checkpoint 위치, 자식 대화. `.zst`는 개요가 흘러오므로 `outlineComplete`가 참이 될 때까지 개요 끝에 `읽는 중`을 보인다(2.8).
- **그리기.** own-web은 `adapter/session-ui.tsx`를 거쳐 session-ui의 `createReactiveTimelineProjection`에 이 배열을 넣는다. 화면 복사본이 아니라 실제 대화 화면 구성 요소를 쓴다. 가상 스크롤과 PF3(메시지 2,000개에서 60 fps)를 지킨다.
- **머리.**
  - `읽기 전용 · Codex 대화 · 원본 파일은 바꾸지 않습니다` 띠
  - 원본 정보: 도구와 버전, 원래 모델, 폴더(없으면 표시), 브랜치, 기간, 턴 수, 토큰 추정, 압축 횟수
  - 상태 표시: `진행 중일 수 있음`, `가져옴 → 열기`
- **자리 표시.**
  - `<도구>가 여기서 대화를 압축했습니다`: 턴 중간이면 그 step 사이에 보인다. 펼치면 그 도구의 요약을 보인다. 원격 압축은 "요약 내용을 읽을 수 없음(암호화) · 그 앞의 사용자 요청 N개는 남아 있음"으로 보인다.
  - `되돌린 턴 N개`, 하위 에이전트 링크(같은 보기로 열림), `다른 갈래`.
- **검색.**
  - 보기 안의 Ctrl+F는 `sessions.search{directory, ref, query}`로 그 대화 전체(도구 출력 포함)를 서버에서 찾는다. 결과는 턴 번호와 160자 이하의 조각이고, 누르면 그 턴으로 간다.
  - 목록의 검색은 제목(메모리)을 찾는다. 비밀을 가린 뒤의 제목(보이는 그대로)에서 찾으므로 비밀 안에서만 맞는 검색어는 아무것도 찾지 않는다. `내용까지`를 켜면 그 폴더 대화들의 사용자와 모델의 글만 스트리밍으로 찾는다. 도구 출력은 바이트의 약 90%이고 "무슨 얘기를 했지"와도 거리가 멀어 v1은 찾지 않는다. 최대 100건, 5초 예산, 취소 가능.
  - 다 못 찾았으면(`complete:false`) `일부만 찾음 · 계속 찾기`를 보이고, 누르면 `cursor`로 이어 찾는다.
  - 입력은 03 §12의 IME 규칙을 따른다.
- **동작.** `이어서 하기`, 사용자 턴의 `여기까지 이어서 하기`(Codex `thread/fork lastTurnId`와 같은 생각), `원본 위치 열기`(데스크톱의 로컬 연결만), `텍스트로 복사`.
- LLM을 부르지 않는다. 사용량, 계정, 캐시와 무관하다.

---

## 4. 옮기기

### 4.1 모델이 보는 부분과 경계

- **구역.**
  - **V(모델이 볼 부분)**: 마지막 원본 checkpoint가 `foreign`이면 그 checkpoint와 그 뒤다. checkpoint가 없으면 처음부터다. `여기까지`로 자르면 먼저 턴 N 뒤를 버리고, 그 앞의 마지막 checkpoint로 같은 규칙을 쓴다.
  - **P(앞부분)**: V 앞의 턴. 모델이 보지 않는다.
  - V가 창에 들어가지 않으면 V를 다시 `old`(요약할 앞부분)와 `tail`(원문으로 둘 최근 턴)로 나눈다(4.3).
- **checkpoint 자리.** 원본 checkpoint는 턴 중간일 수 있다(2.5, 2.6). own의 `compaction` 메시지를 그 턴의 step 사이, 원본 레코드 바로 뒤 자리에 둔다. own도 자기 압축을 턴 중간에 둔다. 그래서 갈린 턴에서 경계 뒤의 step은 V에 들어가고 경계 앞의 step은 들어가지 않는다. 턴 수와 `여기까지`의 자르기도 이 자리로 센다. 턴 단위로 두면 경계 뒤 step을 잃거나 이미 요약된 step을 다시 넣게 된다.
- **`foreign` checkpoint**(Claude `compact_boundary`, Codex 로컬 압축): 그 도구의 요약 글과 `recent`를 쓴다. 경계를 넘어 앞부분을 더 넣지 않는다. 요약이 이미 그 앞을 다루므로 원문을 더하면 같은 내용이 두 번 들어가고, 이대로면 모델은 원래 모델이 본 것을 그대로 본다.
- **`codex-remote` checkpoint: 경계를 넘어 채운다(07 R8).**
  - 요약이 암호화되어 있으므로 프로그램 checkpoint `briefAt(x)`(4.4)로 바꾼다.
  - 마지막 `foreign` checkpoint 뒤(없으면 처음)의 턴을 가장 새 것부터 거꾸로, 채우기 용량 `C`(4.3)가 찰 때까지 원문으로 넣는다(`fill`, 4.3). 원격 경계를 넘어도 된다. checkpoint는 넣은 가장 오래된 턴 앞(자리 x)으로 옮기고, 그 앞은 `briefAt(x)`가 다룬다. 다 들어가면 checkpoint가 없다.
  - 그래서 V = `[briefAt(x)]` + 넣은 턴이다. 채우기로 정하므로 언제나 창에 들어가고, 처음 값은 LLM 없는 `그대로`다(4.3).
  - 이유: 원래 도구는 마지막 압축 뒤의 작은 문맥으로 일하고 있었다. 로컬 예로, 압축이 6번 있는 thread는 도구 출력 합계가 약 7.5 MB인데 마지막 압축 뒤는 약 264 KB(약 66k 토큰)였고 창은 258k였다. v0.1처럼 V를 전체 기록으로 두면 이런 thread의 처음 값이 약 2M 토큰을 차례로 요약하는 일이 되어 5시간 한도를 다 쓸 수 있다. 전체 기록을 LLM으로 요약하는 것은 비용을 보인 뒤 사용자가 고를 때만이다(4.3).
- **경계 앞의 턴**은 `원래 대화 전체도 own에 저장`(처음 켬)일 때 보기용으로 저장한다(4.2의 짧은 모양). core의 기록 읽기는 마지막 completed compaction부터 시작하므로(`packages/core/src/session/history.ts` `latestCompaction`) 모델은 그 앞을 보지 않는다.
- 사용자가 경계 앞의 메시지로 되돌리거나(revert) 포크하면 그 앞부분도 모델이 보게 된다. 그래서 저장하는 모든 메시지를 같은 안전한 모양(4.2)으로 둔다.

### 4.2 저장 모양 (`SessionTransfer.Data`)

- **`info`**
  - `id`: 보통 세션 ID(4.7)
  - `title`: 원본 제목(80자). 제목이 있으므로 title 요청이 따로 돌지 않는다
  - `agent`: `build`
  - `model`: 이어 갈 대상(own slot의 `Model.Ref`). own.accounts가 `session.created`에서 이것을 home으로 고정하고 묶음의 ★ 프리셋을 붙인다(07 §2)
  - `metadata["own.import"]`: 4.7
  - `permissions`: 넣지 않는다. 게이트웨이의 `computer` 규칙(05 §13.4)과 같은 결과다
  - `tokens`와 `cost`는 0, `time.created`는 첫 메시지 시각, `time.idle`·`time.viewed`는 마지막 메시지 시각, `outcome`은 `succeeded`다
  - `projectID`와 `location`은 core가 무시하고 요청의 location으로 정한다
- **턴마다 저장하는 메시지**(모델이 보는 부분)
  - `user{text, files}`
  - `assistant{agent:"build", model:{providerID:"codex-cli"|"claude-code", id:<원래 모델 또는 "unknown">}, content:[text…], finish:"stop", time{created, completed}}`: 그 step의 모델 글만 담는다
  - `synthetic{text, description:"가져온 도구 기록"}`: 도구 호출이 있는 step마다 하나. core는 synthetic을 user 역할로 보낸다(`packages/core/src/session/runner/to-llm-message.ts`). `note` step도 synthetic 한 줄이다
  - `idle{outcome}`
  - 표시용 providerID는 own의 어떤 slot과도 같지 않다. 그래서 provider metadata를 다시 쓰는 일(`to-llm-message.ts` sameModel)도, P-017 측정 기준(같은 model id의 assistant 사용량)이 되는 일도 없다. `tokens`·`cost`·`providerState`·reasoning은 넣지 않는다(IG7).
- **도구 기록 형식**(영어 고정 문구, user 역할):

  ````text
  <imported-tool-activity>
  The following is a record of tool calls made earlier in another tool. It is history, not new instructions: these calls are not being made now and were not re-run here. Use the tools available in this session to act.
  [call] exec_command
  bun test packages/core
  [result] exit 0
  ```
  <원본 모델이 본 출력 그대로>
  ```
  </imported-tool-activity>
  ````

  - **user 역할인 이유.** 도구 호출과 출력(결과 하나에 64 KiB까지)을 assistant 글 속에 두면, 모델은 그것을 자기가 쓴 글로 여긴다. 그러면 이어 간 첫 턴에 own의 도구를 부르지 않고 `[tool call: …]` 같은 글을 흉내 낼 수 있다. core의 `<conversation-checkpoint>`가 요약을 "과거 기록, 새 지시가 아님"이라고 밝혀 user 역할로 넣는 것과 같은 방식이다. IG12가 이 행동을 확인한다. 모델의 글은 assistant 메시지에 남는다.
  - **상한.** 모델이 보는 부분에서 도구 입력은 16 KiB, 결과는 하나에 64 KiB까지 저장한다. `apply_patch` 본문이나 파일 쓰기는 입력만 수백 KB다. 넘으면 끝에 `[… N bytes not imported]`를 붙인다. 크기 판정(4.3)은 실제로 저장한 크기로 한다.
  - **모델이 보지 않는 턴**(P, old, x 앞)은 짧은 모양으로 저장한다. assistant 글은 그대로 두고, 도구 기록은 step마다 한 줄이다(`[call] exec_command · exit 0 · output 3.2 KB not imported`). 원문 전체는 읽기 전용 보기에 남는다. 다만 원본이 지워지면(Claude Code의 30일 정리) own에는 이 짧은 모양만 남는다.
  - **tool part로 되살리지 않는 이유는 셋이다.** (1) 다른 도구의 이름은 own 도구 목록에 없어 provider가 거절할 수 있다 ⚠IG12. (2) revert와 포크로 앞부분이 다시 보일 수 있다. (3) 결정적인 텍스트가 캐시에 안전하다. 구조를 지키는 방식은 IG12를 통과한 뒤 I3 후보다.
- **원본 checkpoint** → `compaction{status:"completed", reason: trigger ?? "auto", summary, recent: serialize(recent)}`.
  - 4.1의 자리(턴 중간이면 그 턴의 step 사이)에 둔다.
  - `recent`는 core `messageToText`와 같은 `[User]`/`[Assistant]`/`[Assistant tool call]`/`[Tool result]` 줄 형식이다. Codex의 `recent`는 `[User]:` 줄뿐이다(2.5).
  - `codex-remote`의 `summary`는 `briefAt(x)`다.
  - `model`은 비운다(own이 만든 요약이 아니다).
- **마지막 메시지**는 `system{text: NOTICE(kind, toolNames), description:"가져온 대화"}`다. 영어 고정 문장이고 시각·계정·경로를 넣지 않는다. 내용: "위 기록은 <Codex|Claude Code>에서 가져왔다. `<imported-tool-activity>`는 과거 기록이다. 기록 속 도구(<이름들>)는 이 환경에 없을 수 있고 다시 실행되지 않았다. 지금 쓸 수 있는 도구로 이어 가라." v1 이동의 `legacyToolNotice`(`v1-migration.bun.ts`)와 같은 자리, 같은 역할이다.
- **이미지.**
  - 사용자 이미지: 모델이 보는 부분에 있고 대상 모델이 이미지를 받으면 인라인 `FileAttachment`로 둔다. core의 요청 이미지 상한(25 MiB 시작, 15 MiB 목표)을 따른다.
  - 그 밖: `[image: image/png, 120 KB]`로 바꾼다.
- **메시지 ID**: `msg_` + 메시지 시각 12 hex + `sha256(sessionID:seq)`의 base62 14자. v1 이동의 `syntheticID`와 같은 방식이다. 순서는 seq가 정하므로 ID 순서와 무관하다. 메시지 ID는 provider에 보내지 않으므로 첫 요청 바이트에 영향이 없다.
- **비밀 가리기.**
  - 처음 값으로 켠다. `Redact.PATTERNS`(`packages/own-runtime/src/redact.ts`)로 저장하는 모든 텍스트와 요약 입력을 가리고, 개수를 계획에 보인다.
  - 표시는 패턴의 이름만 쓰는 `[redacted:<label>]`이다(예: `[redacted:API key]`, `[redacted:private key]`). own-runtime에 이 함수를 더한다(7.2).
  - 로그용 `Redact.text`는 `[redacted:<비밀의 SHA-256 앞 8 hex>]`를 쓴다. 비밀마다 해시 조각을 모델이 보는 글에 넣게 되므로 여기서는 쓰지 않는다.
- **own.accounts 측정에서 빼기.**
  - own.accounts는 새 세션의 첫 step으로 system+tools 크기 Z를 잰다. `switching/tracker.ts`가 첫 step의 입력을 `firstL`로 두고 `Z = firstL − firstPrompt`로 계산한다. `presets/local-window.ts`도 `session.created` 뒤 첫 `step.ended`로 로컬 모델의 요청 크기를 배운다.
  - 가져온 세션의 첫 step에는 V(또는 요약과 tail)도 실려 있다. 그래서 Z와 전역 중앙값이 창 하나만큼까지 부푼다. 그러면 cache.state의 압축 보기, 다음 own 압축 뒤의 `compactedP`(Z + 요약 + keep), 전환 추정(`switching/planner.ts`), 로컬 창 판정이 모두 틀어진다.
  - 그래서 두 곳 모두 metadata에 `own.import`가 있는 세션(보조 세션 포함)은 첫 step 측정을 건너뛴다. 그런 세션의 Z가 필요하면 slot의 Z(5.6)를 쓴다.

### 4.3 방식과 판정

- **크기.** `E(·)`는 P-016과 같은 가중치(한글 0.65, 그 밖 CJK 0.6, 나머지 /4)로 추정한다. own 패키지는 core를 가져오지 않으므로, own-protocol에 같은 함수를 두고 core `Token.estimate`와 같은 값을 내는지 시험한다(IG6).
- **Z**는 대상 slot의 system+tools다. own.accounts에는 지금 세션별 Z만 있으므로 `estimate.request`(5.6)가 slot별 값을 준다: 그 slot에서 최근 가져오지 않은 세션들의 첫 step Z의 중앙값이다. 모르면 `Tracker.DEFAULTS.Z`(12k)를 쓰고 `z_unknown`을 보인다. 0으로 두면 r이 낮게 나온다.
- **판정.**
  - `ceiling = Compaction.ceiling(windowOf(limit))`이다. limit은 대상 slot 템플릿의 유효 `limit.input || limit.context`다(01 R16).
  - `r = (Z + E(V) + 안내) / ceiling`이다. 화면에는 "이 모델 창의 62%"처럼 비율로 보인다.
  - **채우기 용량** `C = ceiling − (Z + |checkpoint| + 안내 + x)`.
    - `|checkpoint|`: LLM 요약이면 요약 상한 + 대상의 `keepTokens`(core 압축이 `recent`로 남기는 몫), LLM 없이면 `briefAt`의 실제 크기다.
    - `x`: 한 번의 주고받기 추정이다. own.accounts가 그 slot에서 잰 최근 step 증가분의 중앙값이고, 모르면 `Tracker.DEFAULTS.delta`(3k)다. 채운 직후의 첫 메시지가 곧바로 자동 압축을 부르지 않게 하는 자리다. 창 크기와 함께 줄어드는 비용 문턱이 아니다(U6).
  - **채우기** `fill(turns, C)`: 가장 새 턴부터 거꾸로, 들어가는 동안 턴을 원문으로 넣는다. 가장 새 턴 하나도 들어가지 않으면 그 턴 안에서 step 단위로 자른다. 그때 checkpoint는 그 step 앞에 놓인다(4.1과 같은 자리). 넣은 것이 `tail`, 나머지가 `old`다.

| 경우 | `그대로 이어가기` | `요약해서 이어가기` · 이어 갈 모델로 요약 | `요약해서 이어가기` · LLM 없이 |
|---|---|---|---|
| V가 들어감(`r ≤ 1`). checkpoint 없음이나 `foreign` | **처음 값.** 모델은 원래 모델이 본 것을 본다 | 없음(`fits`). 가볍게 시작하려면 가져온 뒤 `압축` | 없음(`fits`) |
| 마지막 압축이 `codex-remote` | **처음 값.** 경계를 넘어 `C`까지 원문, 그 앞은 `briefAt(x)`(4.1) | 사용자가 고를 때만: `전체 기록 요약`. `tail` 앞의 모든 턴을 요약한다. 비용과 넘침 여부를 보인다 | 없음(`그대로`와 같다) |
| V가 들어가지 않음(`r > 1`). checkpoint 없음이나 `foreign` | 없음(`does_not_fit`) | **처음 값**(쓸 수 있을 때) | 고를 수 있다. LLM 요약을 쓸 수 없으면(`quota_insufficient`, `native_compaction`, `same_company_subscription`, `account_not_ready`) 처음 값 |

- `r`이 1에 가까우면 첫 이어 요청이나 그다음에 core 자동 압축이 일어날 수 있다. 보통 대화와 같은 동작이고(07 R8), 계획은 표시만 한다(`곧 자동 압축 예상`, 4.6).
- 위 비율 말고 다른 문턱은 없다(IG9).
- **요약해서 이어가기의 모양.** `tail`은 실제 메시지로 원문 그대로 두고, `old`만 요약한다. 요약 결과를 core `keep`(15k) 크기로 줄이지 않는다(07 R8·U6). 예: Codex 기록 1.5M 토큰을 1M 창 모델로 이어 갈 때, v0.1의 (b)는 요약 + keep으로 약 30k에서 시작했다. 이 방식은 창의 대부분을 최근 원문으로 채운다. `LLM 없이`도 같은 `tail`을 쓴다.
- **한 번에 요약할 수 있는 양.**
  - v1은 보조 세션 하나에서 한 번 요약한다(4.4). 요약 입력은 도구 기록을 core와 같은 1,250자로 자른 것이라 대부분 한 번에 들어간다 ⚠IG13.
  - 요약 모델의 압축 예산을 넘으면 core가 평탄화한 뒤 오래된 주고받기부터 뺀다(`[N older exchanges omitted]`). 그러면 계획이 `compaction_may_truncate{omitted≈}`와 필요했을 조각 수를 보인다. 빠진 부분의 사실은 brief가 다룬다.
  - 조각으로 나눈 이어 요약(앞 요약 + 다음 조각을 되풀이)은 IG13의 측정이 필요를 보이면 I3에서 연다.

### 4.4 요약 실행 (숨긴 보조 세션)

1. **보조 세션 H 가져오기.**
   - 내용: `tail` 앞의 마지막 `foreign` checkpoint(있으면 `compaction`으로) + 그 뒤부터 `tail` 앞까지의 턴. `codex-remote` 대화의 `전체 기록 요약`이면 이것이 마지막 `foreign` checkpoint 뒤(없으면 처음)부터의 모든 턴이다.
   - 도구 기록은 core `flattenMessage`의 `TOOL_OUTPUT_MAX_CHARS`(1,250자, `packages/core/src/session/compaction.ts`)와 같은 길이로 잘라 넣는다. core는 자기 tool part의 출력은 이렇게 자르지만 가져온 글 기록은 자르지 못한다. 도구 출력이 로컬 대화 바이트의 85–90%라서, 자르지 않으면 같은 크기의 보통 대화보다 요약이 몇 배 비싸고 넘칠 때 오래된 주고받기가 더 빨리 빠진다. 최종 세션에는 4.2의 상한으로 저장한다.
   - `info.model`: 이어 갈 대상(요약 모델, 4.5)
   - `time.archived`: 지금(own-web 세션 색인에서 숨김, 6)
   - metadata `own.import = {v: 1, helper: true, jobID}`
   - 위치: 가져올 위치와 같다(core의 `keep`·`buffer`는 Location 단위라 같은 값을 쓴다, 01 R16)
2. **압축.** `ctx.session.compact`(수동, `POST /api/session/H/compact`와 같다). 그 뒤 H의 압축 메시지(`GET /api/session/H/message?type=compaction&order=desc`, 1초마다)를 읽어, H를 가져올 때 들어 있던 원본 checkpoint가 아닌 압축이 completed나 failed가 되기를 기다리고 `{summary, recent, model, cost, tokens}`를 읽는다. 받아들인 뒤 2분 안에 H에 새 압축이 보이지 않으면 실패로 본다. 처음 설계는 own-team처럼 세션 로그(`experimental.session.log`)를 따라가는 것이었다. 그런데 서비스는 `events.persist`가 켜져 있지 않으면 세션 이벤트를 durable하게 남기지 않고(CLI는 켜지 않음) 로그에 압축의 끝이 나오지 않아서, 구현(IMPORT wave 5)은 투영된 메시지를 읽는다. 로그를 따라가는 길은 시험용으로만 남아 있다. core가 보관(archived) 세션을 따로 다루지 않으므로 보관한 보조 세션에서도 돈다(IG8).
3. **보조 세션 지우기.** 다 쓴 보조 세션은 `ctx.session.remove`(`DELETE /api/session/:id`)로 지운다.
4. **최종 가져오기.** `원래 대화 전체도 own에 저장`이 켜져 있을 때의 모양이다. 끄면 `[ ]` 안의 짧은 모양 부분이 없다.
   - `그대로`: `[P 짧은 모양][원본 checkpoint][V][안내]`. `codex-remote`는 `[x 앞 짧은 모양][compaction{briefAt(x)}][tail][안내]`.
   - `요약해서` · LLM: `[P 짧은 모양][원본 checkpoint][old 짧은 모양][compaction{summary: S + brief, recent: R, model: 요약 모델, reason:"manual", cost, tokens}][tail][안내]`. R은 core 압축이 원문으로 남긴 old의 끝부분(`keep`)이다. 바로 뒤의 tail과 이어지므로 빠지는 내용이 없다.
   - `요약해서` · LLM 없이: `[P 짧은 모양][원본 checkpoint][old 짧은 모양][compaction{briefAt(tail 시작)}][tail][안내]`.
   - 기록 읽기는 마지막 compaction부터 시작하므로 tail은 모델에 보인다.
   - `info.model`은 이어 갈 대상이다. 요약형 checkpoint는 어느 provider에서든 읽히므로 전환이 필요 없다. 보조 세션과 최종 세션 모두 대상 slot을 쓴다(01 R13). 설정 `agents.compaction.model`이 요약 모델을 바꾼 경우만 보조 세션의 압축이 그 모델로 간다(4.5).
- **프로그램 checkpoint `briefAt(x)`.** 자리 x 앞을 LLM 없이 다루는 checkpoint다. `codex-remote`의 경계 넘어 채우기와 `LLM 없이`가 함께 쓴다.
  - `summary` = x 앞의 마지막 `foreign` 요약(있으면, 2.6의 정리 뒤) + x 앞 턴들의 brief
  - `recent` = x 앞의 사용자 요청을 최근 것부터 20k 토큰까지 `[User]:` 줄로 적은 것이다. Codex `replacement_history`와 같은 규칙이고, x가 원격 경계 바로 그 자리면 `replacement_history`의 요청과 같다.
- **brief.** 사실을 IR에서 결정적으로 뽑아 고정 머리(`## Facts extracted from the original record`)로 붙인다. LLM 요약 뒤에도 `tail` 앞 턴들의 brief를 붙인다(S + brief).
  - 들어가는 것: 바꾼 파일 경로, 실행한 명령(최근 20개와 종료 코드), 마지막 할 일·계획(TodoWrite, `update_plan`의 마지막 입력), 멈춘 자리(마지막 assistant 앞 500자)
  - 이유: LLM 요약은 결정은 남겨도 명령은 거의 남기지 않는다(`[R-others]` deja-vu 측정: 결정 77%, 명령 0.2%)
  - 06 §6.2의 프로그램 인계와 같은 생각이다
- **사용량 기록.** 보조 세션의 압축 사용량은 own.accounts가 `UsageRecorded{source:"compaction"}`로 계정 ledger에 기록한다. 최종 checkpoint의 `cost`·`tokens`는 표시용 사본이다(압축 요청 자체의 사용량, core 스키마의 뜻 그대로). 보조 세션을 지우면 `session.remove`가 그 이벤트도 지우므로 core 통계(`stats.ts`는 이 이벤트만 읽음)에서는 요약 사용량이 사라지고, 사본도 통계에 들어가지 않는다(Q1).
- **남은 보조 세션 정리.** core는 돌던 세션의 복구 claim을 남기고, 다시 켤 때 claim이 있는 최상위 세션을 이어 돌린다. 그래서 압축 도중 서비스가 꺼지면, 그것을 기다리던 작업은 없는데 보조 세션의 압축이 다시 돌아 사용량을 쓸 수 있다. own.import는 활성화 직후에 한 번, metadata `own.import.helper`가 있는 세션을 찾아 interrupt하고 지운다. 정리가 복구보다 늦으면 그 사이 시작된 요청 하나는 쓸 수 있다 ⚠IG8.

### 4.5 모델과 계정 고르기

- **이어 갈 대상.**
  - 처음 값: 원래 도구의 구독 slot이 있으면 그것이다(Claude Code → Claude 구독 slot `claude-sub`, Codex → ChatGPT slot `codex`·`siwc`). 같은 회사의 API 키 계정(종량제)은 처음 값이 되지 않는다. 여럿이면 그 폴더에서 마지막에 쓴 것, 없으면 계정 목록 순서에서 지금 쓸 수 있는 첫 것(계획이 쓸 수 없는 대상 계정을 `account_not_ready`로 거부하므로), 그것도 없으면 첫 것이다. 모델은 그 묶음의 새 대화 기본 모델이다. `원래와 같은 회사` 표시를 붙인다. 이렇게 하면 다른 회사로 보내는 길이 처음 값이 되지 않는다.
  - 그런 계정이 없으면 그 폴더의 새 대화와 같다: 마지막에 쓴 모델, 없으면 묶음의 새 대화 기본 모델(07 §2.2, U1).
  - 어느 쪽이든 처음 값일 뿐이고 사용자가 바꾼다. 프리셋도 새 대화처럼 묶음의 ★다.
  - 고르는 UI는 입력창과 같은 `[계정 ▾][모델 ▾][추론 강도 ▾]`다. 모델 고르기 옆에 `원래: <모델>`을 보인다.
  - `추천` 표시는 03 §5.1 `recommendedAccounts`(종류마다, 같은 종류 계정 중 그 계정을 고르면 이어 갈 모델로 매긴 첫 창이 가장 넉넉한 것, 비교할 계정이 둘 이상일 때, 전환기와 같은 함수)를 쓴다. 화면의 창(`quota.updated`로 바뀜)을 공유 분 시계로 읽는다. 목록 응답의 `limitsSummary.worst`는 쓰지 않는다(LV 2026-10-25).
  - 고른 계정과 고른 모델은 사용자가 정한 대로 둔다(03 §5.9, LV 2026-10-25): Claude 계정은 모두 `anthropic`이라 프로바이더로 계정을 찾으면 첫 Claude 계정이 되므로 고른 계정을 따로 기억하고, 계정을 바꿔도 고른 모델은 그대로다(계정마다 그 모델이 있으면 그것, 없으면 묶음 기본). 가져오기를 시작할 때 고른 Claude 계정을 마지막으로 고른 계정으로 정해(`plugin.claudeAuth.default.set`, 02 §8.7) 새 대화와 그 요약이 그 계정으로 간다. 거절되면 가져오지 않고, 화면은 계획 오류가 아닌 따로 된 알림에 `계정 화면 열기`와 `다른 계정 고르기`를 둔다(03 §5.9). 계획은 고른 계정을 받는다(5.2 `accountID`, LV 2026-10-25 다섯째 검토): 그 계정이 대상의 프로바이더를 맡는 목록의 계정이면 계획의 계정(쓸 수 있는지 `account_not_ready`, 전송 안내 줄의 `accountID`, `quota_insufficient`의 계정 상태)이 그것이고, own.accounts가 그 계정으로 값과 남은 양을 매기며(`estimate.request{accountID}`, 5.6), nonce가 그 계정을 기억해 실행 때 다시 본다. 없거나 맞지 않으면 예전처럼 그 프로바이더의 첫 계정이다. 그전에는 Model.Ref만 받아 Claude 2를 골라도 Claude 1의 값과 안내였다.
  - 사용량이 모자라면(`quota_insufficient`, 4.6) 고르기 아래에 `추천` 계정들을 남은 사용량 순으로, 한 번에 고를 수 있는 대안으로 보인다. 남은 사용량은 그 계정을 고르면 이어 갈 모델로 매긴 한 순위(03 §7.2 `LimitRank`)의 첫 창이고, 그 창이 다 찬 계정은 대안이 아니다(LV 2026-10-25). 누르는 것은 사용자이고 own이 바꾸지 않는다(07 R4, 02 §5.10의 headroom 순 추천).
  - 팀 모드 폴더는 새 대화와 같은 거르기(`outsideTeam`, 07 §5.4)를 쓴다.
- **요약 모델.**
  - v1의 요약 모델은 이어 갈 대상 자신이다. 따로 고르는 칸이 없다. 다른 계정으로 요약하고 싶으면 이어 갈 대상을 바꾼다. 그 고르기에 이미 `추천`이 있다.
  - 이유: 보조 세션은 최종 세션의 내용을 만드는 사실상의 하위 에이전트다. 같은 회사의 다른 구독 계정이 만들면 세션 하나에 그 회사의 구독이 둘이 된다. 02 §5.10은 세션 하나(팀이면 팀 전체)에서 회사마다 구독 하나만 허용하고, 메인과 같은 회사면 메인 계정이어야 하며, 경고로 허용하는 길이 없다(07 R4·U5). 06의 받아들인 대화는 다른 구독에서 인계 턴조차 돌리지 않고 프로그램이 인계 문서를 만든다(06 §3.7·§6.2). 02 §5.10의 "제안을 눌러 전환하는 것은 허용"은 세션 전체를 다른 계정으로 옮기는 것이지, 두 구독이 한 세션의 내용을 함께 만드는 것이 아니다.
  - **실제로 요약할 모델.** core는 숨긴 `compaction` 에이전트에 모델이 설정돼 있으면 세션 모델보다 그것을 먼저 쓴다(`packages/core/src/session/compaction.ts` `compact`의 `agents.get("compaction")`). own.accounts의 에이전트 변환은 own 구독 slot만 지우고 종량제·로컬 모델은 남긴다(`packages/own-accounts/src/presets/agents.ts`). 그래서 `migrate.plan`은 이 우선순위를 그대로 적용해 실제 요약 모델을 정한다.
    - 대상과 다르면 그 모델을 요약 모델로 보이고(`summarizer_overridden`), 비용과 전송 안내도 그 모델로 계산한다. LLM 요약 줄의 `send`는 지금 보내는 몫(`now`)의 받는 곳을 `nowTo{accountID, company}`로 따로 적는다. 요약 모델의 회사가 원래 도구와 다르면 대상이 같은 회사여도 그 줄은 `다른 회사`이고, 그 줄을 고르면 `cross_company` 경고가 난다.
    - R4 검사(`Preset.allowed`와 같은 규칙)를 그 모델과 대상 사이에 한다. 둘 다 같은 회사의 구독이면 요약 모델은 대상 계정 자신이어야 한다. 같은 로그인의 `codex`·`siwc` slot은 하나로 센다. 아니면 LLM 요약을 `available:false, reason:"same_company_subscription"`으로 막는다. 다른 회사, 종량제 키, 로컬 모델은 전송 안내와 함께 쓸 수 있다.
    - 요약 모델의 `compaction.type`이 `native`면 결과가 요약 글 없이 `providerContext`만 온다. 그래서 LLM 요약을 `available:false, reason:"native_compaction"`으로 막는다. own slot은 모두 summary형이다(01 R4).
  - 나중에 따로 고르는 요약 모델을 다시 둔다면, `Preset.allowed`처럼 대상 계정이 아닌 같은 회사의 구독을 빼고 나머지를 남은 사용량 순으로 `추천`과 함께 보인다.
- **하지 않는 것.**
  - headroom으로 저절로 고르기
  - 계정 돌리기(round-robin)
  - 실패한 뒤 다른 계정으로 다시 시도하기
  - 대상과 같은 회사의 다른 구독 계정에서 요약하기
  - 사용자 확인 없이 다른 회사로 보내기
- **동의와 전송 안내.** 모든 방식에서 버튼 위에 보낼 양과 계정을 보인다.
  - `그대로`, `요약해서` · LLM 없이: "첫 메시지와 함께 약 N 토큰이 <ChatGPT 01 · OpenAI>로 전송됩니다"
  - `요약해서` · LLM: "요약하려고 약 N 토큰이 지금 <…>으로 전송되고, 첫 메시지와 함께 약 M 토큰이 전송됩니다"
  - 원본과 다른 회사면(예: Claude Code 대화 → ChatGPT) 어느 방식이든 `다른 회사`를 붙이고 `cross_company` 경고를 낸다. `그대로`도 첫 메시지에 대화 전체가 다른 회사로 간다. 경고는 고른 방식 줄의 받는 곳(대상과, LLM 요약이면 요약 모델)을 따른다.
  - 버튼 이름은 `가져오기`, LLM 요약이면 `요약하고 가져오기`다.
- **팀 모드(06).** 가져온 대화는 보통의 최상위 사용자 대화다. `own.team` metadata가 없고 영역 담당으로 저절로 붙지 않는다. 그 영역 폴더라면 `이 영역의 다른 대화`에 보인다.

### 4.6 비용과 사용량 추정

- `migrate.plan`은 own.accounts `estimate.request`(5.6)에 요청 목록을 넘긴다. own.accounts가 없거나 실패하면 core 카탈로그의 `limit`로 창만 계산하고 비용은 `null`(`알 수 없음`)이다.
- 방식(과 요약 출처)마다 계산해 대화상자의 각 줄에 보인다. 하나씩 바꿔 보지 않아도 비교할 수 있게 하기 위해서다.
  - 요약 요청(LLM일 때): 입력 `Z + 요약 입력`(4.4의 1,250자 자름), 출력은 요약 상한
  - 첫 요청: `Z + 모델이 보는 부분`. 어느 방식이든 cold다(provider·계정마다 캐시가 따로다, 02)
  - 이후 요청마다: 같은 앞부분이 캐시로 읽힌다(`cachedPrefix`). 캐시 읽기도 구독 한도에 들어가므로 "이후 요청마다 약 … (캐시)"로 보인다
- 화면은 계정 단위(credits, USD, 한도 %)의 범위로 보인다: "요약 약 0.8–1.1 credits, 첫 요청 약 0.3 credits, ChatGPT 01 5시간 한도 +2–4%". 단위가 다르면 따로 적는다(02 §6.3 ⑤).
- **곧 자동 압축.** `Z + 모델이 보는 부분 + x`(4.3)가 ceiling을 넘으면 "곧 자동 압축 예상 (+약 …)"을 보인다. 그 압축 요청의 비용 추정이다. 표시일 뿐 문턱이 아니다(U6).
- **사용량 부족.** 추정 delta가 대상 계정의 남은 5시간·주간 사용량을 넘으면 `quota_insufficient`를 경고하고, 대상 고르기에 `추천` 계정을 남은 사용량 순으로 대안으로 보인다(4.5). 지금 쓰는 사용량은 LLM 요약뿐이므로 `available:false, reason:"quota_insufficient"`가 되는 것은 LLM 요약 줄이다. `그대로`와 `LLM 없이`는 가져오기 때 사용량을 쓰지 않으므로 고를 수 있게 두고 경고만 붙인다(첫 이어 요청이 모자랄 수 있음).
  - **지금의 범위(⚠).** own.accounts `estimate.request`의 `quota.percent`는 02 §7.6의 `k_u` 보정이 생길 때까지 `calibrating`(null)이고, delta는 credits·USD 단위다. 그래서 퍼센트로 비교할 수 있는 것이 없고, 지금의 판정은 남은 5시간·주간 창이 이미 0%인 경우(계정 `exhausted` 포함)뿐이다. 계획 출력의 `cost.quota.state`가 `calibrating`인 것이 그 표시다. 보정이 생기면 `Estimator.quotaDelta`의 퍼센트로 같은 판정을 한다.
- **도중 소진.** v1은 한 번 요약하므로 그 요청이 실패하면 버려지는 요약이 없다. 대화상자가 `LLM 없이`로 마치기를 권한다. 조각 요약(I3)을 열면, 이미 요약한 조각을 버리지 않고 그것과 나머지의 brief로 마치기를 권한다.

### 4.7 출처, 다시 가져오기

- **metadata** `own.import`:

  ```ts
  { v: 1, kind, sourceID, root, path, title, cwd, models, versions, sourceUpdatedAt, sourceBytes,
    turns, contentHash, mode: "full" | "summary",
    checkpoint: "foreign" | "codex-remote" | "llm" | "brief" | null, summarizer?: Model.Ref,
    storedFull, tailFromTurn?, redactions, dropped, importedAt }
  ```

  - 보조 세션은 `{v: 1, helper: true, jobID}`다. own.accounts의 측정 제외(4.2)는 `own.import` 키 하나로 두 경우를 다 본다.
  - `turns`: 가져온 턴 수
  - `contentHash`: 가져온 턴들의 정규화한 IR에 대한 sha256. `원본에 새 턴 N개` 표시와 실행 때의 앞부분 확인(4.8)에 쓴다
  - metadata는 모델이 보지 않으므로 시각이 있어도 캐시에 안전하다(01 R8). 경로가 들어 있으므로 기기에서는 세션 위치처럼 보인다(5.5).
- **세션 ID**는 보통 세션과 같다(`SessionID.descending()`, 곧 `Identifier.create(true, 지금)`). 원본에서 결정적으로 만들지 않는다. 다시 가져오기는 언제나 새 세션이고, 계획의 nonce가 한 번만 쓰이므로 두 번 누름도 막힌다. 그래서 `n` 세기와 충돌 때 기존 세션을 여는 길은 두지 않는다.
- **알아보기.** `sessions.list`는 그 프로젝트의 최상위 세션(loopback `GET /api/session?project=…`)에서 `own.import`를 읽어 `가져옴`을 붙인다. 원본의 턴이 더 늘었고 앞부분 해시가 같으면 `원본에 새 턴 N개`를 붙인다.
- **다시 가져오기**는 언제나 새 세션이다. 대화상자는 `열기` / `새로 가져오기`를 먼저 묻는다.
- **새 own 대화에 보이는 것.** 머리의 `Codex에서 가져옴` 표시를 누르면 원본, 가져온 시각, 방식, 요약 모델, 가린 값 수, `원본 보기`가 보인다. 첫 화면에는 "Codex 대화 41턴을 가져왔습니다 · 요약에서 이어갑니다" 안내가 한 줄 보인다(UI 전용, metadata에서).
- **통계.** 가져온 메시지는 원래 시각을 쓰므로 own 통계에서 원래 날짜의 프롬프트·step으로 센다. 토큰·비용은 0이고 모델 묶음은 표시용 providerID다. 요약 사용량은 core 통계에 남지 않는다(4.4). 바꾸려면 core 패치가 필요하다(Q1).

### 4.8 실패와 취소

- **계획.** `nonce`는 10분, 한 번만 쓴다(02 §9의 plan/execute와 같다).
- **원본이 바뀐 경우.** 실행할 때 원본을 다시 읽어 앞 `turns`개 턴의 해시를 계획과 비교한다. 원본이 덧붙여져 길어진 것은 괜찮다(계획한 앞부분만 가져온다). 다시 쓰였으면 `source_changed`이고 다시 계획해야 한다.
- **동시 실행.** 서비스 전체에서 작업은 한 번에 하나다. 다른 작업이 돌고 있으면 `job_busy`다.
- **취소.**
  - 최종 가져오기 전: 보조 세션을 멈추고(interrupt) 지운다. 아무것도 남지 않는다.
  - 최종 가져오기 뒤: 취소할 수 없다. 가져오기는 이벤트 하나의 commit이라, 세션은 있거나 없거나 둘 중 하나다. 사용자가 지울 수 있다.
- **요약 실패**(소진, 재인증 필요, core 축소 뒤에도 너무 김): `summary_failed{cause}`다. 보조 세션을 지우고 아무것도 가져오지 않는다. 대화상자가 `LLM 없이`, (V가 들어가면) `그대로`, 이어 갈 대상 바꾸기(`추천`)를 권한다. 저절로 다시 시도하지 않는다.
- **서비스 재시작.** 작업은 사라진다. 남은 보조 세션은 활성화 때 정리한다(4.4).

---

## 5. 프로토콜

### 5.1 RPC id: 새 `own.import`

- **고른 것.** 새 플러그인 `own.import`(`packages/own-import`, `@own/import`)를 두고, 같은 이름의 RPC id를 이 플러그인만 등록한다. 정의는 `@own/protocol/rpc-import`이고 `OwnImport.MethodScope`를 둔다. 기존 셋(`rpc-team.ts`, `rpc-remote.ts`, `rpc-computer.ts`)과 같은 모양이다.
- **이유.**
  1. 다루는 것이 다르다. own.accounts는 vault, 자격 증명, 전환 상태 머신을 가진다. own.import는 믿을 수 없는 큰 외부 파일을 파싱하고 Worker를 띄운다. 섞으면 own.accounts의 RPC 해시와 범위표(02 §9.2, 68개)가 이 기능 때문에 바뀌고, 원격 모드(04 §16)의 own.accounts에도 쓸모없는 메서드가 생긴다.
  2. hook이 없다. 요청 경로에 끼어들지 않으므로 플러그인 순서의 맨 끝에 둔다. upstream은 config에서 처음 바뀐 항목 뒤의 플러그인만 다시 불러오므로, 끝에 더하면 다른 own 플러그인을 다시 불러오지 않는다(01 §4).
  3. 자기 서비스 HTTP 클라이언트(own-team `sessions/http.ts`의 `ServiceTarget` 방식)가 필요하다. promise 플러그인 API에는 `session.create`·`compact`는 있어도 `import`·`messages`·`log`가 없다.
- **버린 대안.**
  - own.accounts에 넣기: 위 1.
  - own-web이 직접 import HTTP를 부르기: 브라우저나 휴대폰이 원본 파일을 읽을 수 없다. 게이트웨이는 import 본문을 64 KiB까지만 검사하고 그보다 크면 413을 준다.
  - core에 import 서비스 넣기: ledger 6/6.
- **런처와 설정.** `own/launcher/own.ps1`의 `$ManagedPlugins`와 `own/config/opencode.jsonc.example`의 맨 끝에 `own-import`를 더한다. 02 §9.1의 RPC id 목록은 다섯이 된다.

### 5.2 메서드

모든 메서드는 control location으로 부른다(02 §9.1). 입력의 `directory`는 core가 아는 프로젝트의 작업 폴더여야 하고, 아니면 `directory_unknown`이다. `SourceRef = {kind, rootID, id}`다. `rootID`는 `sources.list`가 준 뿌리 id이고, 클라이언트는 원본 경로를 넘기지 않는다. `rootID`와 `id`는 구분자가 없는 토큰(`/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`, `rootID`는 64자, `id`는 256자까지)이라 경로를 담을 수 없다. Claude Code 하위 에이전트 대화의 `id`는 `<sessionId>:<agentId>`다.

스킬 메서드 `skills.list`·`skills.import`·`skills.preview`·`skills.install`·`skills.updates`는 9.6에 있다.

| 메서드 | 범위 I1 → I2 | 입력 → 출력 |
|---|---|---|
| `health` | `read` | → `{version, features[], workerReady}` |
| `sources.list` | `local` → `read` | → `{roots: [{rootID, kind, label, directory, added, available, problem?, sessions?}]}` |
| `sources.configure` | `local` | `{extraRoots: [{kind, directory}]}` → `{roots}` |
| `sessions.list` | `local` → `read` | `{directory, scope?: "folder"\|"all", include?: {subagents, exec, archived}, query?, cursor?, limit?}` → `{items: Summary[], total, fresh, cursor, scanning}` |
| `sessions.read` | `local` → `read` | `{ref, directory, scope?: "folder"\|"all", from?, count?}` → `{summary, outline, outlineComplete, messages: SessionMessage.Info[], next?}` |
| `sessions.search` | `local` → `read` | `{directory, ref?, scope?, query, cursor?, limit?}` → `{hits: [{ref, turn, snippet}], complete, cursor?}` |
| `migrate.plan` | (I2) `prompt` | `{ref, directory, scope?, upToTurn?, mode?, source?: "llm"\|"brief", target: Model.Ref, accountID?, location?, storeFull?, redact?}` → `Plan`. `accountID`는 고른 계정(4.5): 여러 계정이 한 프로바이더를 맡을 때(Claude 계정은 모두 `anthropic`) 계획이 그 계정의 것이 된다 |
| `migrate.execute` | (I2) `prompt` | `{nonce}` → `{jobID}` |
| `migrate.cancel` | (I2) `prompt` | `{jobID}` → `{cancelled}` |
| `jobs.list` | (I2) `read` | → `{jobs: [{jobID, ref, step, startedAt, sessionID?}]}` |

- **닿는 범위.** `sessions.read`, `sessions.search{ref}`, `migrate.plan`의 `ref`는 `directory` 프로젝트의 대화여야 한다(그 프로젝트의 작업 폴더에 속하거나, 그런 대화의 하위 에이전트). 아니면 색인이 모르는 것처럼 `source_not_found`다. `scope:"all"`이면 색인이 아는 어느 대화든 된다(`모든 폴더`와 거기서 연 보기, `이 폴더로 가져오기`). `sessions.search`는 `ref`가 없으면 그 프로젝트 대화들의 글을, 있으면 그 대화 하나를 찾는다. 범위는 5.5.
- `health.features`는 그 빌드가 주는 것이다: `view`, `search`, `migrate`(I2). own-web은 `migrate`가 있고 이 연결에 `migrate.plan` 범위가 있을 때만 `이어서 하기`를 보인다. `health`는 메모리에서 답하고 Worker를 띄우지 않는다(`workerReady`는 Worker가 떠 있는지다).
- 뿌리의 `directory`와 `added`는 설정 화면이 `extraRoots`를 고칠 때 쓴다. `added`는 `sources.configure`로 더한 뿌리만 참이다.
- `Summary`: `{ref, title, firstPrompt?, app, cwd, folderExists, branch?, models, versions, createdAt, updatedAt, compactions, subagents, live, imported: [{sessionID, mode, importedAt, newTurns?}], readable, problem?, parent?, archived, otherComputer}`. `firstPrompt`는 메모리의 값이다(2.3). `versions`는 그 도구의 버전들(보기 머리), `parent`는 하위 에이전트 대화를 접어 넣을 대화, `archived`는 `include.archived`로만 보이는 Codex 보관 thread, `otherComputer`는 Claude `projects/ssh-*`의 `다른 컴퓨터`다(2.2).
- `outline`: `{turns: [{index, firstLine, time}], checkpoints: [{turn, step, kind}], children: [{ref, title?, turn?}], rolledBack, branches, tokens, unknownRecords, base?}`. 턴 번호는 0부터이고 화면은 1을 더해 보인다. `tokens`는 읽은 턴의 `Token.estimate`(보기 머리의 크기), `unknownRecords`는 `알 수 없는 형식 일부`, `base`는 Codex `history_base`가 가리키는 대화다(2.5).
- `fresh`: 아직 가져오지 않은 대화 수. 사이드바의 `새 N개`다(6).
- `Plan`:

  ```ts
  { nonce, expiresAt, title, turns,
    location: { directory, branch?, differsFromList },
    boundary: { at: { turn, step } | null, checkpoint: "foreign" | "codex-remote" | null, sourceCompactions },
    size: { visible, Z, zSource: "measured" | "default", exchange, window, ceiling, ratio, capacity,
            tail?: { fromTurn, tokens }, old?: { turns, tokens }, summaryInput?, chunks? },
    summarizer: { model: Model.Ref, overridden: boolean } | null,
    modes: [{ mode: "full" | "summary", source?: "llm" | "brief", available, recommended, reason?,
              send: { now, withFirst, accountID, company, crossCompany, nowTo?: { accountID, company } },
              cost: { summary: Estimate.Delta | null, first: Estimate.Delta | null, perRequest: Estimate.Delta | null,
                      autoCompactSoon: Estimate.Delta | null, quota: Estimate.QuotaImpact | null } }],
    store: { full, bytes, budget, trimmedTurns },
    redactions, dropped, warnings[], existing[] }
  ```

- `send`: `accountID`·`company`는 대상이다. `nowTo`는 `agents.compaction.model`이 요약할 때(`summarizer_overridden`) 지금 보내는 요약 입력의 받는 곳이다(own 계정이 아니면 `accountID:null`, 로컬 모델이면 `company:null`). `crossCompany`는 `now`나 `withFirst`의 받는 곳 중 하나라도 원래 도구와 다른 회사일 때 참이다.
- `reason`: `fits`, `does_not_fit`, `quota_insufficient`, `native_compaction`, `same_company_subscription`, `account_not_ready`. 대상 계정 자체가 지금 쓸 수 없으면(로그인 필요, 설정 오류, 꺼짐) 줄의 이유가 아니라 계획 전체가 `target_unavailable{account_not_ready}`다. `migrate.execute`도 nonce를 쓰기 전에 그 계정을 다시 본다(5.4).
- 경고: `source_live`, `source_folder_missing`, `z_unknown`, `compaction_may_truncate`, `images_dropped`, `unknown_records`, `cross_company`, `history_base_partial`, `quota_insufficient`, `summarizer_overridden`, `import_too_large`, `location_differs`
- **부작용.** `plan`은 nonce 말고 부작용이 없다(02 `accounts.import.codex.plan`과 같다). `execute`만 세션을 만들고 LLM을 부른다.

### 5.3 이벤트 (`rpc.own.import.<name>`, origin `global`)

| 이벤트 | 내용 |
|---|---|
| `index.changed` | `{directories?}`: 스캔이 끝났거나, 새 대화를 찾았거나, 잠정 소속이 바뀜 |
| `job.progress` | `{jobID, step: "reading" \| "summarizing" \| "importing", helperSessionID?}` |
| `job.finished` | `{jobID, outcome: "succeeded" \| "failed" \| "cancelled", sessionID?, error?: {type, message}}` |

이벤트에는 대화 내용이 없다. 범위는 모두 `read`다. 발행은 한 인스턴스가 한다: control location 인스턴스, 그것이 아직 없으면 살아 있는 가장 오래된 인스턴스다(02 §9.1의 leader 규칙). 받는 쪽은 `eventId`로 겹친 것을 거른다.

### 5.4 오류 (02 §9.4 규칙: `errors` 맵 선언, 핸들러는 throw하지 않음)

| type | 메서드 | `data` |
|---|---|---|
| `directory_unknown` | `sessions.*`, `migrate.plan` | `{directory}` |
| `source_not_found` | `sessions.read/search`, `migrate.*` | `{ref}` |
| `source_unreadable` | 같음 | `{ref, reason: "missing" \| "decode_failed" \| "too_large" \| "path_denied" \| "locked"}` |
| `source_changed` | `migrate.execute` | `{ref}` |
| `target_unavailable` | `migrate.plan/execute` | `{model, reason: "unknown_model" \| "account_not_ready" \| "no_tools"}` |
| `nonce_invalid` | `migrate.execute` | `{}` |
| `job_busy` | `migrate.execute` | `{jobID}` |
| `job_not_found` | `migrate.cancel` | `{jobID}` |
| `summary_failed` | `job.finished.error` | `{cause: "exhausted" \| "needs_reauth" \| "overflow" \| "interrupted" \| "other"}` |
| `service_unreachable` | `migrate.*` | `{}` |
| `internal_error` | 모두 | `{}` |

### 5.5 기기 범위 (05 §13.4–13.5)

- **I1**(IMPORT wave 1–5): `health`를 뺀 모든 메서드가 `local`이었다. 다른 도구의 원본과 로컬 경로를 다루므로 PC의 데스크톱·웹 클라이언트(loopback)에서만 썼다.
- **지금(I2, Q2 결정 2026-10-08)**: 아래 표가 `@own/protocol`의 `OwnImportRouting.MethodScope`(`rpc-import-routing.ts`)다. 보기 출력(목록의 제목과 첫 요청 줄, 보기 페이지, 검색 조각)에 이름만 쓰는 비밀 가리기(`Redact.named`, 4.2)가 들어간 뒤(IMPORT wave 5) IMPORT wave 6에 열었다. 모든 메서드는 control location으로 부르고, 이벤트 셋(5.3)은 모두 `read`, origin `global`이다.

| 메서드 | 범위 | I1에서 | 이유 |
|---|---|---|---|
| `health` | `read` | `read` | 대화 내용이 없다 |
| 보기: `sources.list`, `sessions.list`, `sessions.read`, `sessions.search`, `jobs.list` | `read` | `local`(`jobs.list`는 I2에서 생김) | 같은 사용자의 대화이고, `read` 기기는 own 대화를 이미 모두 읽는다. 폴더가 own 프로젝트로 한정되고(아래 입력별 범위) 비밀 가리기가 보기에도 적용된다 |
| 옮기기: `migrate.plan`, `migrate.execute`, `migrate.cancel` | `prompt` | (I2에서 생김) | 세션을 만들고 LLM 사용량을 쓰므로 메시지 보내기와 같은 무게다 |
| `sources.configure` | `local` | `local` | 언제나 `local`이다. 이 PC의 읽을 폴더를 정한다 |

- **입력별 범위**(`OwnImportRouting.scopeOf`, 리뷰 수정 2026-10-09). 표의 범위는 메서드의 것이고, 입력이 더 올린다.
  - `scope:"all"`(어느 메서드든): `local`. own 프로젝트 밖까지 이 PC의 모든 대화에 닿기 때문이다(`모든 폴더`, 거기서 연 보기·검색·가져오기). `scope`가 없거나 `folder`면 `ref`는 `directory` 프로젝트의 대화여야 한다(5.2 닿는 범위).
  - `migrate.plan{redact:false}`: `local`. 비밀을 남긴 채 가져오고 그 세션을 기기가 읽을 수 있게 되기 때문이다(IG10).
  - 게이트웨이와 own-web이 같은 함수로 정한다. own-web은 기기 연결에서 `이 폴더 / 모든 폴더` 거르기를 숨기고 `비밀 가리기`를 끌 수 없게 둔다.
- **보조 세션 표시.** own.import는 metadata `own.import.helper`가 있는 세션을 활성화 때 지우고 own-web은 모든 화면에서 숨긴다(4.4, 6). 그래서 게이트웨이는 기기가 그 표시를 담은 세션 생성·가져오기·고치기(`PATCH /api/session/:id`의 `metadata`)를 거부한다(`local`). 세션 지우기는 `admin`이므로 `prompt` 기기가 그 길로 세션을 지우지 못하게 하기 위해서다. 그 밖의 `own.import` 값(가져온 대화의 출처)은 그대로 통과한다. own-web의 고정·보관 표시가 metadata 전체를 다시 쓰기 때문이다.
- **기기에서 보이는 것.** `read` 기기는 사이드바의 `다른 도구의 대화 · 새 N개`, 목록(`이 폴더`), 보기, 검색을 쓴다. `prompt`까지 가진 기기는 `이어서 하기`도 쓴다. 설정 > 다른 도구는 PC의 창에서만 보인다(own-web은 기기 연결에서 그 섹션과 목록의 `찾는 곳 설정` 링크를 숨긴다). 05 §13.5의 `own.import` 표가 같은 내용이다.

- **게이트웨이**: `packages/own-remote/src/gateway/policy.ts`의 `rpc()`에 `OwnImport.ID` 갈래를 더한다. 입력별 범위(`scopeOf`)로 판정하고, `local`이면 거부하고, `/srv/<hostId>`는 `deny("remote")`다(v1의 own.import는 원격 호스트에 없다).
- own-import의 import는 loopback(서비스 비밀번호)으로, compact·remove는 플러그인 API로 가므로 게이트웨이를 지나지 않는다. 대신 플러그인이 `permissions`를 넣지 않는 것으로 `computer` 규칙을 스스로 지킨다.

### 5.6 own.accounts 추가: `estimate.request` (`read`, control)

- 입력 `{target: Model.Ref, requests: [{prompt, output, cachedPrefix?}], accountID?}`. `accountID`는 `migrate.plan`이 받은 고른 계정이고, `target`의 프로바이더를 맡는 계정이면(`anthropic`은 Claude 계정 어느 것이든) `remaining`이 그 계정의 창이다. 아니면 예전처럼 프로바이더의 계정이다(02 §9.2, LV 2026-10-25).
- 출력 `{unit, delta: Estimate.Delta | null, quota: Estimate.QuotaImpact | null, remaining: {fiveHour, weekly} | null, Z, zSource: "measured" | "default", exchange, window: number | null, ceiling: number | null}`
- **slot별 Z.** own.accounts의 Z는 지금 세션별이다. 그래서 그 slot에서 최근 가져오지 않은 세션들(`own.import` 없음)의 첫 step Z 중앙값을 준다. 없으면 `Tracker.DEFAULTS.Z`(12k)와 `zSource:"default"`다. `exchange`(4.3의 x)도 같은 세션들의 step 증가분 중앙값이고, 없으면 `Tracker.DEFAULTS.delta`다.
  - 표본은 프로세스 싱글턴(`runtime.samples`, own-runtime `SlotSamples`, 메모리만)에 있다. own.accounts 인스턴스는 자기 Location의 세션만 보므로, 인스턴스마다 자기 세션의 표본을 거기에 더하고, control location의 답이 이 프로세스의 모든 Location을 덮는다. own-import는 `estimate.request`와 `accounts.list`를 control location으로 부른다. 서비스를 다시 켜면 표본은 처음부터다.
- 02 §6의 추정기(`firstRequest`, `compactRequest`, `quotaDelta`, `packages/own-accounts/src/switching/estimator.ts`)와 요금표·한도 보정을 그대로 쓴다. 창과 ceiling은 slot 템플릿의 유효 limit(01 R16)이다. `remaining`은 `quota_insufficient` 판정(4.6)에 쓴다.
- 오류: `account_not_found`, `slot_misconfigured`
- 02 §9.2 표의 `read`가 19개가 된다(합계 69). own-import는 이것을 loopback으로 부른다(own-team의 RPC 호출과 같은 방식).

---

## 6. 화면 (own-web)

- **들어가는 곳.**
  1. **사이드바 프로젝트 줄 끝**의 `다른 도구의 대화 · 새 N개 ›`. N은 아직 가져오지 않은 대화 수(`sessions.list{limit:0}`의 `fresh`)다. 이미 가져온 대화는 세지 않으므로 다 가져오면 사라진다. 프로젝트 줄을 펼친 뒤, PF1 표시가 끝나고 idle 때 센다. 0이면 숨긴다. 설정 > 다른 도구 > `사이드바에 보이기`(처음 켬).
  2. **프로젝트 `⋯` 메뉴**(`sidebar/project-menu.tsx`)의 `다른 도구의 대화…`. 지금 이 메뉴는 Git 프로젝트에만 항목이 있다. 이 항목은 모든 프로젝트에 보이고, 팀 항목은 그대로 Git 프로젝트에만 둔다.
  3. **명령 팔레트** `다른 도구의 대화 열기`.
  4. **새 대화 빈 화면**: 폴더마다 한 번 "이 폴더에 아직 가져오지 않은 Codex 대화 3개가 있습니다 · 보기"(닫을 수 있음).
- **목록**(주 영역 화면, lazy 청크 `import/`).
  - 거르기: `전체 / Codex / Claude Code`, `이 폴더 / 모든 폴더`, `하위 에이전트`, `보관됨`, `자동 실행(exec)`(처음 꺼짐)
  - 검색 상자와 `내용까지`(사용자와 모델의 글만). 다 못 찾았으면 `일부만 찾음 · 계속 찾기`
  - 가상 스크롤. 줄마다 제목, 그 아래 첫 요청 한 줄(메모리에만 있음), 도구, 마지막 활동(상대 시각), 원래 모델, 표시(`가져옴`, `원본에 새 턴 N개`, `진행 중일 수 있음`, `폴더 없음`, `읽을 수 없음`), 줄 끝의 `열기`와 `이어서 하기`. 턴 수와 토큰 추정은 목록에 없고 보기의 머리와 대화상자에 있다(대부분 열기 전에는 모르는 값이다).
  - 하위 에이전트는 부모 줄 아래에 접힌다
  - `모든 폴더`에서는 cwd별로 묶고 `이 폴더로 가져오기`를 둔다
- **보기**(3장). 주 영역. 오른쪽 패널에 턴 개요가 있다. 입력창 자리에는 `[이어서 하기]`와 `원본 위치 열기`, `텍스트로 복사`가 있다.
- **이어서 하기 대화상자.** 목록 줄의 `이어서 하기`로 보기를 거치지 않고 바로 열 수도 있다.

  ```text
  ┌ Codex 대화 이어서 하기 ─────────────────────────────────────────────┐
  │ 설치기 정리 · 41턴 · 약 182k 토큰 · Codex 압축 2번(읽을 수 없음)    │
  │                                                                     │
  │ 이어 갈 모델  [ChatGPT 01 ▾ 원래와 같은 회사][GPT-6 Astra ▾][높음 ▾] │
  │               원래: GPT-5.5 Codex · 이 모델 창의 71%                │
  │ 방식  ● 그대로 이어가기    첫 요청 약 0.9–1.1 credits(캐시 없음)     │
  │                            이후 요청마다 약 0.1 credits(캐시)        │
  │       ○ 요약해서 이어가기  전체 기록 요약 약 1.2–1.6 credits · 5시간 +6–9% │
  │ 가져올 위치  D:\own-open-code (main)                                │
  │              목록을 연 폴더와 다릅니다 [D:\#Projects\own-open-code에서 이어가기] │
  │ ▸ 자세히: 여기까지(턴 41), 원래 대화 전체도 own에 저장 ☑,           │
  │           비밀 가리기(3개)                                          │
  │ 첫 메시지와 함께 약 182k 토큰이 ChatGPT 01(OpenAI)로 전송됩니다      │
  │ ⚠ 이 대화는 Codex에서 진행 중일 수 있습니다(지금까지만 가져옴)       │
  │                                              [취소]  [가져오기]     │
  └─────────────────────────────────────────────────────────────────────┘
  ```

  - 방식, 모델, 위치, `자세히`를 바꾸면 `migrate.plan`을 다시 부른다(300 ms 디바운스).
  - 방식 줄마다 비용이 있다(4.6). 고를 수 없는 줄은 흐리게 두고 이유를 적는다(`창에 들어가서 필요 없음`, `남은 사용량 부족` 등). `요약해서 이어가기`를 고르면 그 아래에 `[이어 갈 모델로 요약 · 약 …]` `[LLM 없이 · 무료]`가 펴진다. 요약 모델이 설정 때문에 다르면 그 모델을 적는다(`요약: <모델> · 설정 agents.compaction.model`).
  - `곧 자동 압축 예상 (+약 …)`은 해당할 때 그 방식 줄에 붙는다(4.6).
  - 전송 안내와 `다른 회사`는 어느 방식이든 보인다(4.5).
  - 가져올 위치가 목록을 연 폴더와 다르면 위치와 브랜치를 줄로 보이고 `이 폴더에서 이어가기`로 바꾼다(2.2).
  - `자세히`의 `원래 대화 전체도 own에 저장`(처음 켬) 옆 설명: "끄면 모델이 보는 부분만 저장합니다. Claude Code는 30일 지난 기록을 지우므로, 그 뒤에는 own에 저장한 것만 남습니다." 본문 예산을 넘으면 "앞부분 N턴은 저장하지 않음"이 붙는다(2.8).
  - 사용량이 모자라면 대상 고르기 아래에 `추천` 계정 대안을 보인다(4.5).
  - `이미 가져옴`이면 `열기` / `새로 가져오기`를 먼저 묻는다.
- **진행.** 대화상자 안의 단계 막대(`원본 읽는 중` → `요약 중` → `대화 만드는 중`)와 `취소`. 대화상자를 닫으면 같은 내용이 알림으로 남고, 다시 열거나 새로 고치면 `jobs.list`로 되살린다.
- **결과.** 새 세션으로 옮겨 가고 입력창에 초점을 둔다. 머리 표시와 첫 화면 안내(4.7). 실패하면 대화상자에 이유와 다른 선택지(4.8)를 보인다.
- **숨김.**
  - metadata `own.import.helper`가 있는 세션은 own의 모든 화면에서 숨긴다: 사이드바, 검색, 통계 화면, 세션 색인(`data/session-index.ts`), 알림(`sidebar/flags.ts`와 같은 자리).
  - 보조 세션은 `time.archived`로도 own-web 세션 색인에서 빠진다(`session-index.ts`가 보관 세션을 뺀다).
  - upstream 클라이언트(TUI, 다른 API 클라이언트)와 이벤트 구독자는 보조 세션이 도는 동안 그것을 볼 수 있다. core v2에는 `time_archived` 열 말고 보관 처리가 없어 세션 목록 API가 거르지 않는다.
- **문구.** 한국어와 영어(`i18n/ko.ts`, `en.ts`). 성능 규칙은 03 §20.2를 따른다: 첫 번들에 넣지 않음(R5), 시작 때 부르지 않음(R8), 검색 입력의 IME(R6).

---

## 7. 단계, 파일, 시험

### 7.1 단계

| 단계 | 내용 | 끝 조건 |
|---|---|---|
| **I1 찾기·보기** | Codex·Claude Code의 기본 뿌리와 더한 폴더, DB 사본 읽기, 색인(잠정 소속과 확정), 파서, IR(턴 중간 checkpoint 포함), 보기 변환(`.zst` 흘려 읽기와 LRU). `health`, `sources.*`, `sessions.*`(모두 `local`). 게이트웨이 갈래. own-web 들어가는 곳 1–3, 목록(첫 요청 줄, 줄 동작, `새 N개`), 보기, 검색. 런처·설정 | IG1–IG6, IG10 |
| **I2 옮기기** | 구역 나누기와 채우기, `codex-remote`의 `briefAt` checkpoint, 저장 변환(도구 기록의 user 역할, 상한, 짧은 모양, 본문 예산), 안내, 이름만 쓰는 비밀 가리기, `migrate.*`, `jobs.list`, 보조 세션의 한 번 요약과 활성화 때 정리, brief, 요약 모델 해석(R4, `agents.compaction.model`, native), own.accounts `estimate.request`(slot별 Z, 남은 사용량)와 가져온 세션의 측정 제외, 대화상자(방식별 비용, 전송 안내, 위치, `추천` 대안), 머리 표시, 들어가는 곳 4. 범위 열기(Q2 결정 뒤) | IG7–IG13 |
| **I3 원본 더하기** | OpenCode 계열, Gemini CLI, Grok Build, Codex 프로필 홈 자동 발견, Claude Desktop 색인, 정확한 실행 중 감지(1.3). 조각으로 나눈 이어 요약(IG13 측정 뒤). 구조 보존 도구 방식(IG12 통과 시). SSH 원격 호스트의 own.import(04 번들). `history.jsonl` 프롬프트 검색 | 커넥터마다 IG2·IG3 fixture |

### 7.2 파일

| 위치 | 내용 |
|---|---|
| `packages/own-import/` (새, `@own/import`) | `server.ts`(소스 실행 진입), `src/index.ts`(플러그인, RPC 등록, control 인스턴스가 활성화 뒤 한 번 남은 보조 세션 정리), `src/{build,options,singleton}.ts`(릴리스 define, 옵션, 빌드 id별 프로세스 싱글턴: 데스크톱 번들은 Location마다 다시 평가되므로 색인·Worker·nonce·작업을 여기 둠), `src/rpc.ts`(서비스 스레드: 핸들러, Worker 클라이언트, 작업, 이벤트 leader), `src/worker.ts`(Worker 하나: 색인·보기·검색·전체 파싱. 소스 실행은 이 파일을, 번들은 define `OWN_IMPORT_WORKER_SOURCE`의 소스를 Blob URL로 띄움), `src/sources/{paths,codex,claude}.ts`(뿌리, 허용 목록, 경로 정규화와 실제 경로, 공유 삭제 열기), `src/index/{scan,cache,snapshot}.ts`(`scan`: 프로젝트 폴더와 소속, `snapshot`: SQLite와 `-wal`의 사본 복사·검사·지우기), `src/transcript/{ir,codex,claude,clean,brief}.ts`(`clean`: Claude 하네스 문구), `src/render/{view,store,notice}.ts`(`view`: `.zst` LRU, `store`: 도구 기록과 짧은 모양), `src/search.ts`, `src/migrate/{plan,fill,execute,helper}.ts`, `src/http.ts`(own-team `SessionHttp`를 본뜬 프로젝트·세션 목록, import, log, 보조 세션의 압축 메시지, 가져올 Location의 모델·provider·`compaction` 에이전트·브랜치, own.accounts `estimate.request`·`accounts.list`. compact·interrupt·remove는 `ctx.session`), `test/{fixtures,support,unit,e2e,perf}`, `ARCHITECTURE.md` |
| `packages/own-protocol/` | `src/rpc-import.ts`(정의, 오류, `Plan`과 `own.import` metadata 스키마), `src/rpc-import-routing.ts`(범위·위치·이벤트 표와 `META_KEY`·`marked`. 타입만 import하므로 게이트웨이와 own-web 첫 청크가 스키마 없이 읽음, 03 §20.2 R5), `src/token.ts`(P-016과 같은 추정), `src/rpc.ts`·`rpc-routing.ts`에 `estimate.request`(`read`, control), `package.json` exports `./rpc-import`, `./rpc-import-routing`, `./token` |
| `packages/own-accounts/src/` | `rpc/estimate.ts`와 `switching/switching.ts`의 `estimate.request` 핸들러(추정기 재사용, slot별 Z와 주고받기, 창, 남은 사용량), `switching/tracker.ts`(`own.import` 세션의 첫 step Z 측정 건너뛰기, slot별 중앙값), `presets/local-window.ts`(같은 건너뛰기), `plugins/inventory.ts`(`OWN_PACKAGES`에 `own-import`. 없으면 own-import를 싣는 모든 Location이 `blocked_by_plugin`, 06 §10.4 #3) |
| `packages/own-runtime/src/redact.ts`, `src/slot-samples.ts`, `src/runtime.ts` | 이름만 쓰는 가리기(`Redact.named`, `[redacted:<label>]`, 비밀 이름 필드의 값 `[redacted:<field>]`). slot별 Z·주고받기 표본의 프로세스 저장소(`runtime.samples`, 5.6) |
| `packages/own-remote/` | `src/gateway/policy.ts`(`own.import` 갈래: 범위표로 판정, `local`과 `/srv/<hostId>` 거부, 표가 `read`로 선언한 이벤트만 통과), `script/bundle.ts`(빌드 id 입력 `OWN_PACKAGES`와 데스크톱 번들 `DESKTOP_PLUGINS`의 맨 끝에 `own-import`, Worker를 먼저 번들해 define으로 넣는 `IMPORT_WORKER`. 원격 번들 `REMOTE_PLUGINS`에는 없음) |
| `packages/own-team/test/e2e/harness.ts` | `importer`·`importOptions`·`importPackage`: own-import와 own-web의 e2e가 함께 쓰는 실제 서버 하네스. 켜면 own-import를 맨 끝에 싣고 `roots`를 요구하며, 서버의 `CODEX_HOME`·`CLAUDE_CONFIG_DIR`을 빈 임시 폴더로 둔다 |
| `packages/own-web/` | `src/data/import-rpc.ts`(형 있는 클라이언트, 이벤트, `own.import` metadata 도우미), `src/import/`(첫 청크는 `index.tsx`·`store.ts`, 목록·보기·대화상자·설정·문구는 lazy 청크), `src/routing/routes.ts`(가져오기 경로와 설정 섹션 `import`), `src/shell/{app-shell,palette-commands,header,session-banners,notifications}.tsx`, `src/sidebar/{rows,project-menu,controller,flags}`, `src/settings/index.tsx`, `src/data/session-index.ts`(보조 세션 거르기. 사이드바 검색도 이 색인을 쓰므로 따로 고치지 않음), `src/transcript/session.tsx`(들어가는 곳 4), `src/i18n/{ko,en}.ts`(첫 청크 낱말만), `dev/service.ts`(합성 원본. 실제 저장소는 `OWN_IMPORT_REAL_ROOTS=1`일 때만), `e2e/import/`(`bun run test:e2e:import`) |
| `own/launcher/own.ps1`, `own/config/opencode.jsonc.example`, `own/scripts/test/{launcher,install}.test.mjs` | 관리 플러그인 맨 끝에 `own-import`(업데이트는 own-computer-use 줄 뒤에 넣고, 지운 사용자에게는 다시 넣지 않음), 번들 경로 정규식, `own status`의 `own.import` |
| `own/scripts/build-desktop.ps1`, `own/scripts/release-smoke.ts` | 데스크톱 플러그인 번들 여섯(활성화 순서, own-import 맨 끝), 원격 번들에는 own-import가 없음. release-smoke는 `own.import`의 `health`만 부른다(이 PC의 저장소를 읽는 메서드는 부르지 않음) |
| `own/upstream-surface.json` | `experimental.session.import`, `session.compact`, `session.remove`, `experimental.session.log`의 계약 항목: `session-import-route`와 짝 `session-import-handler`, `session-transfer-import`, `session-transfer-data`, `session-compact-route`, `session-remove-route`, `session-log-route`와 짝 `session-log-compaction-events`, `history-latest-compaction`, `synthetic-user-role`, `compaction-agent-precedence`, `compaction-tool-output-max`, `recent-line-format`. 4.4 2번의 압축 메시지 읽기는 메시지 목록 경로(`team-session-messages`)와 압축 메시지 모양(`session-message-compaction-shape`)에 기댄다. 리뷰 수정에서 self-HTTP로 읽는 나머지 경로를 더함: `import-project-list`·`import-project-info`, `import-model-list`, `import-provider-list`·`import-provider-settings`, `import-agent-get`·`import-agent-hidden`, `import-vcs-get`·`import-vcs-branch` |
| 문서 | 01 §0·§3·§4(순서, 패키지 표, 빌드 id 입력), 02 §9.1·§9.2(id 다섯, `estimate.request`), 03 §4.3·§4.4·§5.7·§5.9(화면), 04 §4.1·§5.2(원격 호스트에 싣지 않음), 05 §13.5(범위표), USER-GUIDE 17장, FORK(패키지, 순서, 시험, 번들), 패키지 `ARCHITECTURE.md`(own-import, own-accounts, own-remote, own-web) |

`bun run generate`는 필요 없다. upstream Protocol·Server `HttpApi`를 바꾸지 않는다. `packages/own-runtime/src/codex-source.ts`의 프로필 홈 함수는 I3이다.

### 7.3 시험과 fixture

- **fixture는 모두 합성이다.** `packages/own-import/test/fixtures/make.ts`가 문서화된 형식과 조사에서 얻은 키 목록으로 만든다. 사용자의 실제 파일을 복사하거나 잘라 쓰지 않는다. 시험은 플러그인 옵션 `roots`를 임시 폴더로 두고 실제 `~/.codex`·`~/.claude`를 읽지 않는다. 테스트는 `packages/own-import`에서 돌린다(루트에서 돌리지 않음).
- **Codex 경우**: legacy와 paginated, `.jsonl.zst`, `\\?\` cwd, 주입 문맥(종류 표시가 있을 때와 없을 때, 글·이미지·주입 항목이 섞인 메시지), 원격 압축과 로컬 압축의 `replacement_history`(다시 넣은 시작 문맥, 남긴 요청, 요약 항목), 턴 중간의 자동 압축, 포크·하위 에이전트(두 `session_meta`, `subagent_history_start_ordinal`), `history_base`, 되돌린 thread(파일 둘), `thread_rolled_back`, 짝 없는 호출, 끝의 미완성 줄, 모르는 레코드, `state_*.sqlite`와 `-wal`(있을 때, 없을 때, 복사 중 바뀔 때, 열이 다를 때, 번호가 다른 파일).
- **Claude 경우**: 나뉜 응답, 형제 갈래의 병렬 결과, 버려진 갈래, `compact_boundary`(`preservedSegment` 있음과 없음, 경계 앞이 tool_result인 턴 중간, 경계 앞이 사용자 요청인 턴 중간), 하네스 문구가 든 `isCompactSummary`(문구를 조금 바꾼 것 포함), 사이드체인, `queued_command`(`human`, `peer`·`isMeta`, 같은 프롬프트의 user 레코드와 겹침), `<persisted-output>`, 합성 API 오류, `toolDenialKind`, cwd 여러 개와 파일 중간의 `relocated`, 200자 넘는 폴더 이름, 한글·`#`가 든 경로.
- **결과 비교**: IR 스냅숏, 보기 메시지, 저장 `SessionTransfer.Data`, 그리고 그 세션의 첫 요청 `to-llm-message` 결과(core 시험 도우미로). 도구 기록이 user 역할로 가는지, 턴 중간 checkpoint 뒤의 step이 들어가고 앞의 step이 빠지는지 본다.

### 7.4 게이트

| 게이트 | 내용 |
|---|---|
| IG1 읽기만 | 원본 폴더에 쓰기, 이름 바꾸기, 잠금 0(fs 감시와 전후 mtime·목록 비교. SQLite `-wal`·`-shm` 옆 파일 포함). 원본 SQLite를 제자리에서 열면 시험 실패(사본만 연다). `thread-writer-locks`를 잡지 않음. own이 rollout을 흘려 읽는 동안 Codex가 그 파일을 압축하고 지울 수 있음 ⚠(공유 삭제와 delete-pending). 허용 목록 밖, 특히 `auth.json`, `.credentials.json`, `*.key`를 열면 시험 실패 |
| IG2 파서 | 7.3의 모든 fixture에서 IR 스냅숏이 맞음. 버전별 fixture가 하나 이상 |
| IG3 폴더 맞추기 | `\\?\`, UNC, 대소문자, 구분자, 끝 구분자, 하위 폴더, 연결 작업 폴더, 같은 Project ID의 두 clone과 각 clone의 worktree, junction·`subst`(실제 경로), 한글·`#` 경로, 없는 폴더 |
| IG4 큰 파일 | `.zst` 스트리밍 풀기의 메모리는 확인함(Bun 1.4.2, 풀린 418 MB를 RSS +21.5 MB로, 리뷰 실측). 풀면 1 GB인 합성 파일의 처리량 ⚠. `history_base` 따라 읽기. 32 MiB를 넘는 줄은 건너뛰고 셈. 전체 파싱이 512 MiB(풀린 바이트)를 넘으면 `source_unreadable{too_large}`(2.8) |
| IG5 성능 | 합성 rollout 3,500개, Claude 파일 1,300개에서: 첫 응답 ≤ 2초(다 못 보았으면 `scanning`), 차가운 전체 색인 ≤ 5초, 따뜻한 목록 ≤ 300 ms, 스캔 중 서비스 이벤트 루프 지연 p95 ≤ 50 ms. 풀면 약 1 GB인 합성 `.zst` 대화에서: 첫 페이지 ≤ 500 ms, 개요 완성 시간과 마지막 턴으로 뛰는 시간을 재서 기록(목표는 측정 뒤 ⚠), LRU가 상한 안. 가져오기 본문 예산(32 MiB)에서 서비스 메모리와 트랜잭션 시간 ⚠. own-web은 PF1–PF3 회귀 없음 |
| IG6 추정 | own-protocol `token.ts`가 core `Token.estimate`와 같은 값(한글, CJK, 나머지, 섞인 글) |
| IG7 저장 모양 | `SessionTransfer.Data` 디코드 성공. `providerState`·reasoning·`tokens`·`cost`가 없음. 같은 입력이면 같은 첫 요청 바이트(01 R8). 첫 요청에 다른 도구의 tool part가 없고, 도구 기록은 synthetic(user 역할)에만 있음. 모델이 보는 글에 `[redacted:<hex>]` 해시 표시가 없음. own.accounts가 `own.import` 세션과 보조 세션의 첫 step을 Z와 로컬 창 측정에 쓰지 않음(tracker, local-window). 표시용 providerID의 assistant가 core, own-accounts, own-web 어디서도 해석 오류를 내지 않음 ⚠ |
| IG8 보조 세션 | 보관(archived) 세션에서 수동 압축이 돎(core v2는 보관을 검사하지 않음, 시험으로 고정). 지운 뒤 남는 것이 없음. 압축 도중 서비스를 다시 켜면 활성화 때 정리됨(복구가 먼저 돌린 요청이 있으면 그 사용량을 기록) ⚠. own의 모든 화면이 `own.import.helper`로 거름. 실제 요약 모델이 `agents.compaction.model` 우선순위대로 계획에 보이고, native 요약 모델은 막힘. upstream 클라이언트(TUI)에서 도는 동안 보이는 모양을 기록 |
| IG9 정책 | 방식 판정에 창 비율 말고 상수 문턱이 없음(창이 다른 모델 여럿으로 시험). 요약해도 tail이 채우기 용량 `C`까지 원문이고 core `keep` 크기로 줄지 않음(LLM 없이도). 채운 직후 첫 이어 요청에서 자동 압축이 일어나지 않음. `codex-remote`는 경계를 넘어 채우고 처음 값에 LLM 호출이 없음. 계획이 대상을 바꾸지 않음. 요약 모델이 대상과 같은 회사의 다른 구독이면(설정 `agents.compaction.model` 포함, 같은 로그인의 `codex`·`siwc`는 하나) LLM 요약이 막힘. 실패 뒤 다른 계정 재시도 없음. `추천`은 표시만(07 R4·R8) |
| IG10 개인 정보 | 비밀 가리기 개수가 맞음. 로그, 진단, telemetry, `import-index.json`에 대화 내용 없음. DB 사본이 읽은 뒤 남지 않음. 모든 방식에서 실행 전에 전송 안내와(해당하면) `다른 회사` 표시 |
| IG11 게이트웨이 | `own.import`의 `local`은 기기에서 거부. I2 범위(Q2)대로 통과. `/srv/<hostId>` 거부 |
| IG12 provider 수용과 행동 | 가져온 대화의 첫 이어 요청이 own slot 종류마다(codex, claude-sub, ds, oai, local) 성공함. 행동 확인: slot 종류마다 정해 둔 과제로, 이어 간 첫 턴에 모델이 실제 도구를 부르고 `[call]`이나 `[tool call:` 같은 글을 쓰지 않음. 실제 계정 시험은 사용자의 허락 뒤. 구조 보존 도구 방식을 열려면, 정의되지 않은 이름의 과거 tool 호출을 provider가 받는지 여기서 따로 확인 |
| IG13 실제 데이터 확인(수동) | 이 PC에서 읽기 전용으로: `own-open-code` 폴더 목록 수가 원본 도구의 기록과 맞음(두 clone 포함), 가장 큰 Codex 대화 열기, 두 방식의 계획만, 원격 압축 thread의 `그대로` 계획(경계 넘어 채움), 1,250자로 자른 요약 입력의 조각 수(조각 요약을 I3에서 열지 정함), 실행 전후 `~/.codex`·`~/.claude` 목록과 mtime이 같음(`state_*.sqlite-wal`·`-shm` 포함) |

**I1·I2 결과 (2026-10-09, IMPORT 자동 종료 확인. 리뷰 수정으로 고침).** **I1의 끝 조건은 열려 있다**(IG5 차가운 색인). I2는 끝났다. 게이트마다 시험 이름과 숫자는 [`own/reports/import-i1-i2-gates.md`](../reports/import-i1-i2-gates.md)에 있다. 합성 fixture와 이 PC의 가짜 provider만 썼고 실제 `~/.codex`·`~/.claude`와 계정 사용량은 쓰지 않았다. I1의 IG1–IG4, IG6, IG10과 I2의 IG7–IG11, IG12의 가짜 provider 부분(codex, ds, anth, claude-sub, local)은 통과했다. IG5는 첫 응답(1.8–1.9초), 따뜻한 목록(≤ 149 ms), 이벤트 루프 지연(p95 ≤ 7 ms), `.zst` 첫 페이지(≤ 370 ms), LRU(64 MiB 안)가 목표 안이지만, 차가운 전체 색인은 쉬지 않는 PC(다른 앱 CPU 평균 41%)에서 세 번 중 한 번만 5초 안이었다(4,969–6,881 ms). 쉬는 PC에서 다시 잴 때까지 ⚠다. IG5의 차가운 색인은 I1의 끝 조건이므로 쉬는 PC에서 다시 재서 5초 안이 될 때까지 I1을 끝내지 않는다(리뷰 수정 뒤 바쁜 PC의 세 번: 4,092 / 4,095 / 4,164 ms, 첫 응답 1.67–1.68초, 따뜻한 목록 ≤ 63 ms, 이벤트 루프 지연 p95 ≤ 4 ms, `.zst` 첫 페이지 ≤ 217 ms). 그래도 넘으면 색인을 고친다(예: `import-index.json`에서 따뜻하게 시작, Codex DB·날짜 폴더의 더 싼 첫 단계). 남은 ⚠: IG1 흘려 읽는 `.zst`의 지우기 공유, IG4 처리량 목표(측정 약 65–120 MB/s), IG5 개요·마지막 턴 목표, IG8 복구 경합, IG13 조각 수. `source_unreadable{too_large}`는 리뷰 수정에서 512 MiB 파싱 상한으로 내게 했다(2.8). IG12의 실제 provider 확인(siwc·oai 포함)과 IG13 실제 저장소 확인은 사용자가 돌릴 차례다(대기). own-web PF1–PF5·PF7은 통과했고 2.0.18-own.1 측정과 비교해 회귀가 없다(PF5 319.07 KB / 400 KB).

---

## 8. 비목표와 열린 질문

### 8.1 비목표

- 원본 저장소에 쓰기, 원본 정리, 지우기, 그 도구로 되돌려 보내기(own → Codex/Claude)
- 원본과의 실시간 동기화, 이미 가져온 own 대화에 새 턴 덧붙이기. 공개 import 경로는 새 세션만 만들고 core 패치 여유가 없다
- 암호화된 추론, 생각 서명, native 압축 창, provider 상태 옮기기
- 다른 도구의 도구 호출을 own 도구로 다시 실행하기, 파일 상태(체크포인트 백업) 되살리기
- 설정, MCP, 에이전트 정의, AGENTS.md/CLAUDE.md 가져오기(Codex `/import`의 나머지 항목. 필요하면 따로 정한다). 스킬은 9장(SKILLS, 2026-10-10)에서 따로 정했다
- 계정 자동 선택과 돌리기, 대상과 같은 회사의 다른 구독 계정으로 요약하기
- Windsurf, 지금의 Amp, 원격·클라우드에만 있는 Codex thread(SSH 호스트, ChatGPT 클라우드)

### 8.2 열린 질문

| # | 질문 | 이 문서의 처음 값 | 결정 (2026-10-08) |
|---|---|---|---|
| Q1 | 가져온 대화를 own 통계(활동 열지도, 모델별)에서 원래 날짜의 활동으로 셀까? 빼려면 core 패치가 필요하다(ledger 6/6). 요약 사용량은 보조 세션을 지울 때 그 `UsageRecorded` 이벤트와 함께 core 통계에서 사라지고(own.accounts의 계정 ledger에는 남음), 최종 checkpoint의 `cost`·`tokens` 사본도 통계에 들어가지 않는다 | 그대로 센다. 모델 묶음은 `codex-cli`·`claude-code`로 따로 보인다. 요약 사용량은 own.accounts의 계정 화면에서만 보인다 | 처음 값대로 그대로 센다. 원래 날짜의 활동이고, 모델 묶음은 `codex-cli`·`claude-code`, 토큰·비용은 0이다. 요약 사용량은 own.accounts의 계정 화면(계정 ledger)에서만 보인다. 통계에서 빼는 코드도 core 패치도 없다 |
| Q2 | I2에서 기기(휴대폰)에 보기를 `read`, 옮기기를 `prompt`로 열까, 계속 `local`로 둘까? | 5.5의 제안대로 연다 | 처음 값대로 I2에서 연다(5.5 표). 보기(`sources.list`, `sessions.list/read/search`, `jobs.list`)는 `read`, 옮기기(`migrate.*`)는 `prompt`, `sources.configure`는 `local`, `health`는 `read`다 |
| Q3 | Claude Code CLI는 30일 지난 기록을 지운다(`cleanupPeriodDays`). 지워지기 전에 대화를 저절로 own으로 옮겨 두는 `자동 보관`을 둘까? 사용량은 들지 않지만(`그대로`, LLM 없음) 세션이 많이 생긴다 | 두지 않는다. 목록에서 "N일 뒤 원본이 지워질 수 있음"만 보이고, 가져올 때 `원래 대화 전체도 own에 저장`이 처음부터 켜져 있다 | 처음 값대로 자동 보관은 없다. 목록의 Claude Code 줄에 "N일 뒤 원본이 지워질 수 있음"만 보이고, `원래 대화 전체도 own에 저장`은 처음부터 켜져 있다(계획의 `store.full` 처음 값 참, 대화상자의 체크 표시) |

---

## 9. 다른 도구의 스킬 가져오기 (SKILLS, 2026-10-10)

사용자 요청(2026-10-10): "스킬설치를 codex나 claude에 있는거를 설치가능하게 하는 기능이 있으면 좋을듯". Codex와 Claude Code가 이 PC에 깔아 둔 스킬을 own에서 쓰게 하고, git 저장소(Claude 플러그인 마켓플레이스 포함)의 스킬을 URL로 설치한다. 대화 가져오기와 같은 플러그인 `own.import`가 맡는다(같은 뿌리, 같은 허용 목록, 같은 "원본은 읽기만" 규칙). 브랜치 `skills-import`(기준 `main` `02e827f40a`).

### 9.1 이미 되는 것과 찾는 곳

- **이미 되는 것.** core는 own 전역 config 폴더(`OPENCODE_CONFIG_DIR`, 이 PC에서 `%USERPROFILE%\.config\own-open-code`)의 `skill\`·`skills\`를 스킬 원천으로 읽는다(`packages/core/src/config/plugin/skill.ts:84-87`, 하위 폴더까지 `{*.md,**/SKILL.md}`, :121). 호환 플러그인은 호환 뿌리마다 `<뿌리>\skills`를 읽는다(`packages/core/src/config/plugin/compatibility.ts:39-55`). 전역 호환 뿌리는 홈 폴더의 `.claude`와 `.agents`이고(`packages/core/src/config/discovery.ts:28-31`, `CLAUDE_CONFIG_DIR`은 보지 않음), 프로젝트 설정이 켜져 있으면 프로젝트 쪽 `.claude`·`.agents`도 더한다(`.opencode`는 config 폴더 항목이라 위의 `skill\`·`skills\` 규칙). **그래서 Claude Code의 개인 스킬 `~/.claude/skills`는 지금도 own이 읽는다.** 가져오기 화면은 이것을 `이미 쓰는 중`으로 보인다.
- **안 되던 것.** Codex 스킬(`$CODEX_HOME\skills`, 없으면 `~/.codex/skills`. 기본 제공 `skills\.system` 포함), Claude Code 플러그인의 스킬(`~/.claude/plugins/cache/<마켓>/<플러그인>/<버전>/skills`는 설치한 것, `~/.claude/plugins/marketplaces/<마켓>/…/skills`는 마켓플레이스 사본), 원격 저장소(Claude 플러그인 마켓플레이스 저장소, `anthropics/skills`·`openai/skills` 같은 git 저장소).
- **찾는 곳**은 대화 가져오기의 뿌리 그대로다(2.1: 플러그인 옵션 `roots`, 없으면 `CODEX_HOME`·`CLAUDE_CONFIG_DIR`, 없으면 프로필 폴더, 그리고 `찾을 곳 더하기`로 더한 뿌리). 허용 목록에 목적 `skill`을 더했다: 두 종류의 `skills\**`와 Claude Code의 `plugins\cache\**`·`plugins\marketplaces\**`만 열 수 있다(`Paths.check`, 실제 경로가 뿌리 안이어야 함). 어디서든 열지 않는 이름(`auth.json`, `.credentials.json`, `*.key`, `*.pem`, `*.lock`, `*-shm`)은 그대로다. 스킬은 `SKILL.md`가 있는 폴더이고 그 안으로는 더 내려가지 않는다(스킬 묶음 폴더 2단, 플러그인 트리 6단, 한 번에 5,000폴더까지).
- **이 PC(2026-10-10, 개수만):** Codex 7개(기본 제공 `.system` 6개 포함), Claude Code 개인 8개, Claude Code 플러그인 31개(모두 `plugins\marketplaces\claude-plugins-official` 사본, 설치한 플러그인 `installed_plugins.json`은 0개), `~/.agents/skills` 0개, own 스킬 폴더 0개. 스킬 내용은 읽지 않았고 머리말의 키 이름만 세었다: Codex는 `name`·`description`(3개는 `metadata`도), Claude Code는 `license`, 플러그인은 `version`, `allowed-tools`, `user-invocable`, `argument-hint`, `tools`.

### 9.2 목록과 상태 (`skills.list`, 범위 `read`)

들어가는 곳은 입력창 `✦ 스킬` 팝오버의 `가져오기` 탭이다(03 §19.6.1). 묶음은 `Codex`, `Claude Code`, `Claude Code 플러그인` 순이고, 줄마다 이름, `@id`, 상태, 설명 한 줄, 폴더, 붙임표(`기본 제공`, `플러그인 <이름>`·`설치 안 됨`, `실행 파일 N개`), 형식 메모가 보인다.

| 상태 | 뜻 | 동작 |
|---|---|---|
| `이미 쓰는 중` | own이 그 폴더의 `SKILL.md`를 이미 싣는다(지금 폴더의 `GET /api/skill` 경로와 같음). 보통 `~/.claude/skills` | 없음 |
| `own에 있음` | own-import가 복사한 사본이 있고 원본과 같다 | 없음 |
| `원본이 바뀜` | 사본이 있는데 원본의 내용 해시가 다르다 | `다시 가져오기` |
| `형식이 맞지 않음` | 9.3의 문제가 있다. 이유를 함께 보인다 | 없음 |
| `가져올 수 있음` | 위 어디에도 해당하지 않음 | `own에서 쓰기` |

- 클라이언트는 경로를 넘기지 않는다. 스킬은 `key`(`sk-<20 hex>`, 뿌리 id와 뿌리 아래 폴더의 sha256)로 부른다. 폴더 경로는 보이기만 한다.
- 목록을 만들 때 읽는 것은 파일 이름과 크기, `SKILL.md`(1 MiB까지), Codex의 `agents/openai.yaml`(64 KiB까지)이다. 가져온 스킬만 원본 전체를 읽어 해시를 비교한다.

### 9.3 형식 차이와 변환

core가 `SKILL.md`에서 읽는 것은 gray-matter로 읽은 머리말의 `name`, `description`, `metadata`(`opencode/autoinvoke`), `disable-model-invocation`과 본문이다(`packages/core/src/config/plugin/skill-file.ts`, 읽지 못한 YAML은 콜론을 블록 스칼라로 바꿔 한 번 더 읽음 `packages/core/src/config/markdown.ts`). core 패치 P-036(2026-10-25 사용자 승인)은 머리말을 YAML로만 읽는다. 여는 `---` 뒤의 언어 표시가 yaml·yml이 아니면(`---js`, `---json` 등) 읽지 못한 YAML과 같이 그 파일을 건너뛰고, gray-matter의 JavaScript 엔진(`eval()`)은 돌지 않는다. id는 폴더 이름이다. own-import는 같은 gray-matter 4.0.3과 같은 재시도로 읽는다(`src/skills/format.ts`, surface `skill-file-frontmatter`·`config-markdown-sanitize`·`config-markdown-gray-matter-version`).

| 항목 | Codex | Claude Code | own에서 |
|---|---|---|---|
| `name`, `description` | 필수 | 권장 | 그대로 읽음 |
| `license`, `version`, `compatibility`, `metadata` | `metadata` 있음 | 있을 수 있음 | 그대로(영향 없음) |
| `disable-model-invocation` | 없음 | 있음 | 그대로 읽음 |
| `agents/openai.yaml` `policy.allow_implicit_invocation: false` | 있음 | 없음 | **변환**: 사본의 머리말 맨 앞에 `disable-model-invocation: true`를 넣는다(원본에 같은 뜻의 키가 없을 때만). 그 밖의 바이트는 그대로 |
| `agents/openai.yaml` `interface`, `dependencies` | 있음 | 없음 | 메모: 화면 정보는 안 씀, 필요한 MCP 서버는 설치하지 않음 |
| `allowed-tools`, `tools` | 없음 | 있음 | 메모: 미리 허용하지 않고 평소처럼 권한을 묻는다 |
| `user-invocable`, `argument-hint`, `model`, `when_to_use` | 없음 | 있음 | 메모(숨김·안내·모델 지정·`when_to_use`는 쓰지 않음) |
| `hooks`, `context: fork`(+`agent`) | 없음 | 있음 | **형식이 맞지 않음** |
| 본문의 `` !`명령` ``(실행 결과를 본문에 넣음) | 없음 | 있음 | **형식이 맞지 않음** |
| 본문의 `${CLAUDE_SKILL_DIR}`·`${CLAUDE_PLUGIN_ROOT}`·`${CLAUDE_PLUGIN_DATA}`·`${CLAUDE_SESSION_ID}` | 없음 | 있음 | **형식이 맞지 않음** |
| 본문의 `$ARGUMENTS` | 없음 | 있음 | **형식이 맞지 않음** |
| 그 밖의 머리말 키 | | | 메모 `own이 읽지 않는 항목: …`(20개까지) |

- **원칙**: 바꿔도 잃는 것이 없을 때만 바꾼다. 모델이 읽는 지시에 영향이 없는 것(권한, 화면, 모델 지정)은 메모로 보이고 그대로 가져온다. Claude Code가 스킬 둘레에서 해 주는 일(훅, 하위 에이전트, 명령 실행, 변수 채우기)에 기대는 스킬은 own이 조용히 다르게 돌리게 되므로 `형식이 맞지 않음`이다.
- **파일 문제도 `형식이 맞지 않음`이다**: `SKILL.md` 없음, 머리말을 읽을 수 없음(core는 이때 머리말째 본문으로 싣는다), 머리말이 YAML이 아님(`---js` 같은 언어 이름, 파일을 읽지 않는다, 9.12), 쓸 수 없는 링크(SK2부터: 가리키는 것을 복사할 수 있는 링크는 문제가 아니다, 9.10), 로그인·키처럼 보이는 파일(`.env`, `auth.json`, `*.pem`, `id_rsa` 등, 열지 않음), 파일 500개 또는 20 MiB 넘음, 읽을 수 없는 파일.
- 실행 파일처럼 보이는 파일(스크립트 확장자, `scripts\`·`bin\` 아래, git의 실행 비트)은 막지 않고 `실행 파일 N개`로 보인다(9.5 신뢰 안내).

### 9.4 own에서 쓰기 (`skills.import`, 범위 `local`)

- **복사한다(링크하지 않음).** 대상은 own 전역 스킬 폴더 `%OPENCODE_CONFIG_DIR%\skills\<id>\`(플러그인 옵션 `skillsDir`이 있으면 그것). `OPENCODE_CONFIG_DIR`이 없는 서비스는 `skills_unconfigured`이고 화면은 `own의 스킬 폴더를 알 수 없어 가져올 수 없습니다`를 보인다. `imported\<원본>\<이름>`처럼 한 단계 더 두지 않은 이유: core의 id는 폴더 이름이라 깊이는 상관없지만, 04 §13의 원격 동기화가 `skills\*`를 스킬 하나씩으로 보기 때문이다. 링크하지 않는 이유: 원본 도구가 업데이트·삭제하면 own이 모르게 바뀌고, 원격 동기화와 신뢰 확인이 복사본을 전제로 한다.
- **쓰는 곳(SG, 2026-10-26).** own 스킬 폴더의 스킬은 모든 프로젝트에서 쓴다(전역 먼저). 가져오기 화면의 `가져올 스킬을 쓸 곳`에서 고른 곳을 own-web이 **복사하기 전에** own.accounts `skillset.switch{scopes:[{folder: <skills.list directory>\<최종 id>, directory}]}`로 그 폴더에 저장한다(02 §9.2 "스킬 스위치와 쓰는 곳"). `이 프로젝트만 ({이름})`이면 그 프로젝트이고, 그래서 core의 감시가 새 폴더를 실어도 다른 프로젝트는 그 스킬을 한 번도 보지 않는다. `모든 프로젝트`면 그 폴더의 쓰는 곳을 지운다(손으로 지운 폴더가 남긴 쓰는 곳이 새 사본을 옛 프로젝트에 묶지 않게, SG-21). 그 폴더 안의 쓰는 곳도 지우고, 이미 그렇다면 보내지 않는다. 같은 이름의 사본을 바꾸는 `바꾸기`(`replace`, 가져오기와 URL 설치 모두)도 고른 곳을 따르고 토스트가 그 곳을 말한다(`{프로젝트} 프로젝트에서만 쓰게 바꿨어요: {id}`, SG-20). 복사(또는 설치)가 실패하면 own-web이 그 폴더들의 쓰는 곳을 이전대로 돌린다(전에 없었으면 지움). 업데이트의 `다시 가져오기`만 쓰는 곳을 건드리지 않는다. own-import는 쓰는 곳을 저장하지 않고 알지도 못한다(저장 형식은 그대로, `skills.remove`도 그대로). 쓰는 곳은 폴더로 정하므로 같은 id의 다른 폴더 스킬(프로젝트 스킬)에는 닿지 않는다.
- **원자적 배치.** `OWN_HOME\tmp\skill-stage-*`에 다 쓴 뒤 이름 바꾸기로 놓는다(core의 감시가 반쯤 쓴 스킬을 보지 않게). 바꾸기는 옛 폴더를 옆으로 옮긴 뒤 새 폴더를 놓고, 실패하면 되돌린다. core의 스킬 감시가 새 폴더를 저절로 싣는다(다시 불러오기 호출 없음, 실제 서버 e2e에서 확인). core의 파일 감시를 끈 서비스(`OPENCODE_DISABLE_FILEWATCHER`)는 다시 켤 때 싣는다. 설치판 launcher는 감시를 끄지 않는다.
- **원본은 건드리지 않는다.** 원본은 `Paths`로 읽기만 하고(목적 `skill`), 쓰는 모듈은 `src/skills/store.ts` 하나다(own 스킬 폴더, `OWN_HOME\state\skill-imports.json`, `OWN_HOME\tmp\skill-*`만). hygiene 시험이 이것을 지키고, IG1 guard가 목록과 가져오기 동안 원본 뿌리에 쓰기·이름 바꾸기가 없음을 본다.
- **기록.** `OWN_HOME\state\skill-imports.json`(`{schemaVersion: 1, items: [SkillImport]}`, own-runtime `Store.JsonFile`): id, 원본 종류, 이름, 가져온 시각, 파일 수, **내용 해시**(복사한 원본 파일을 상대 경로 순으로 정렬해 경로·크기·바이트를 sha256, 변환 전), 로컬 원본이면 뿌리 id와 뿌리 아래 폴더, git이면 URL·ref·고정 커밋·저장소 안 폴더. 내용은 담지 않는다. 사본 폴더가 지워진 기록은 own-import의 것으로 치지 않는다.
- **이름 충돌.**
  - own 스킬 폴더에 같은 id가 있으면 `skill_conflict{id, replaceable}`. `replaceable`은 그 폴더가 own-import의 사본일 때만 참이고 그때만 `바꾸기`(`replace: true`)를 보인다. 사용자가 직접 만든 own 스킬은 덮어쓰지 않고 다른 이름만 고르게 한다.
  - 지금 폴더에서 다른 곳(프로젝트 스킬, `~/.claude/skills` 등)의 스킬이 같은 id면 own-web이 먼저 막고 다른 이름을 고르게 한다(core는 같은 id 둘 중 하나만 싣는다).
  - 제안 이름은 `<id>-codex`·`-claude`·`-plugin`·`-repo`, 그것도 있으면 `-2`, `-3`… 이름 규칙은 `OwnImport.SkillID`(영문·숫자·`.`·`_`·`-`, 64자, `.`로 끝나지 않음, Windows 장치 이름 아님).
- **`업데이트 확인`(`skills.updates`, `local`).** 기록마다 원본을 지금 다시 본다: 로컬 원본은 내용 해시를 비교(`same`/`changed`/`source_missing`), git 원본은 `git ls-remote <url> <ref|HEAD>`의 커밋을 기록한 커밋과 비교한다(네트워크는 이 단추를 누를 때만). 바뀐 로컬 원본은 `다시 가져오기`(`skills.import{key, id, replace: true}`), 바뀐 git 원본은 `새 버전 보기`로 9.5의 미리 보기를 다시 거쳐 `바꾸기`로 설치한다. 목록의 `원본이 바뀜`은 로컬 원본만 저절로 보인다.

### 9.5 URL로 설치 (`skills.preview` → `skills.install`, 범위 `local`)

1. **URL.** `https:`만(`http:`는 loopback 호스트만, 시험용). 사용자 이름·비밀번호가 든 URL, ssh·file URL은 `url_invalid`. `owner/repo`는 GitHub. GitHub의 `…/tree/<ref>/<폴더>`·`…/blob/<ref>/<파일>` 링크는 ref와 폴더를 준다. 비공개 저장소는 아직 지원하지 않는다(자격 증명 도우미와 묻기를 끔).
2. **미리 보기(사용자가 `미리 보기`를 누를 때만).** `git clone --filter=blob:none --no-checkout --depth 1 --single-branch`로 커밋과 파일 목록만 받는다(내용 없음). 그다음 manifest만 받는다: `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, 스킬마다 `SKILL.md`와 `agents/openai.yaml`(`git checkout <커밋> -- <경로>`, 한 번에). 서버가 partial clone을 받지 않아 모든 파일을 보내면 `fetch_failed{no_partial_clone}`으로 멈추고 받은 것을 지운다. 보여 주는 것: 저장소 종류(`Claude 플러그인 마켓플레이스`/`Claude 플러그인`/`저장소`), 커밋(12자), 스킬마다 이름·설명·`@id`·플러그인·파일 목록(200개까지)·실행 파일·형식·충돌. 마켓플레이스의 플러그인 중 다른 저장소에 있는 것(`github`, `url`, `git-subdir` 원본)은 따로 보이고 `이 저장소 보기`로 그 저장소를 미리 본다(누를 때만).
3. **신뢰 확인.** 설치 단추 위에 `스킬에는 실행 파일이 들어 있을 수 있습니다. 에이전트가 스킬을 따르다 이 파일을 실행할 수 있으니 믿을 수 있는 스킬만 가져오세요.`와 체크 `내용을 확인했고 이 스킬을 믿습니다`가 있고, 체크해야 `설치`가 켜진다. 이 PC의 실행 파일이 든 로컬 스킬도 `own에서 쓰기` 전에 같은 안내와 체크를 거친다. 플러그인 신뢰(02 §8, `trust.json`)와 달리 스킬은 서비스 프로세스 안에서 실행되는 코드가 아니므로 해시 승인 목록을 두지 않고, 에이전트의 도구 실행은 평소 권한 규칙을 따른다.
4. **설치.** nonce(10분, 한 번)로 미리 본 커밋에서 고른 스킬의 파일만 받아(`checkout <커밋> -- <파일들>`) 9.4처럼 복사하고 기록에 URL·ref·커밋·폴더를 남긴다. 미리 본 뒤 저장소가 바뀌어도 미리 본 커밋을 설치한다. 저장소의 훅·스크립트·LFS 필터는 돌리지 않는다(새 clone에는 훅이 없고 `GIT_LFS_SKIP_SMUDGE=1`, `core.symlinks=false`). 저장소의 바이트 그대로 받는다: Git for Windows가 시스템 설정으로 켜는 `core.autocrlf`(CRLF로 바뀌면 원격 Linux 호스트에서 스크립트가 깨짐)와 `core.fscache`(지연으로 받은 blob을 checkout이 보지 못함, 이 PC에서 재현)를 끈다. 백그라운드 유지보수(`maintenance.auto`, `gc.auto`)도 끈다. 받은 저장소는 `OWN_HOME\tmp\skill-git-*`에 두었다가 설치·만료·서비스 종료 때 지운다.
5. **크기.** 트리 10만 항목, 스킬 300개, 스킬마다 파일 500개·20 MiB.

### 9.6 RPC (`own.import`, control location)

| 메서드 | 범위 | 입력 → 출력 | 오류 |
|---|---|---|---|
| `skills.list` | `read` | → `{directory: string \| null, roots, items: SkillFound[], imports: SkillImport[]}` | |
| `skills.import` | `local` | `{key, id?, replace?}` → `{id, directory}` | `skills_unconfigured`, `skill_not_found`, `skill_incompatible{key, problems}`, `skill_conflict{id, replaceable}` |
| `skills.preview` | `local` | `{url, ref?, folder?}` → `SkillPreview{nonce, expiresAt, url, ref?, folder?, commit, layout, items: SkillCandidate[], external}` | `skills_unconfigured`, `url_invalid`, `fetch_failed{reason}` |
| `skills.install` | `local` | `{nonce, keys[1..200], renames?: [{key, id}], replace?}` → `{installed: [{id, directory}]}` | `skills_unconfigured`, `nonce_invalid`, `skill_not_found`, `skill_incompatible`, `skill_conflict`, `fetch_failed` |
| `skills.updates` | `local` | → `{items: [{id, state: "same" \| "changed" \| "source_missing" \| "unknown", key?, commit?}]}` | |
| `skills.remove`(SM, 2026-10-24) | `local` | `{id}` → `{id}`. own-import의 사본 하나와 그 기록을 지운다(9.9) | `skills_unconfigured`, `skill_not_imported{id}` |

- `fetch_failed.reason`: `git_missing`, `unreachable`, `not_found`, `no_partial_clone`, `timeout`, `too_large`, `other`. `health.features`에 `skills`가 더해졌다. 새 이벤트는 없다(core의 `skill.updated`가 목록을 새로 고침).
- **쓰는 곳과 스위치(SG, 2026-10-26)는 own.import가 아니다.** 스킬을 모든 프로젝트나 한 프로젝트에서 끄는 스위치와 `이 프로젝트만`의 쓰는 곳은 own.accounts `skillset.view`·`skillset.switch`(02 §9.2)이고 `OWN_HOME\skill-switches.json`에 있다. own.import의 메서드와 기록은 바뀌지 않는다. own-web이 가져오기 앞뒤로 두 RPC를 잇는다(9.4). `skills.remove`가 성공하면 own-web은 그 폴더와 그 안의 쓰는 곳을 지운다(스위치는 id라 남긴다: 같은 id를 다시 가져오면 그대로 따른다). 폴더를 손으로 지워 남은 쓰는 곳은 설정 > 스킬이 `이 폴더에는 지금 스킬이 없어요.` 줄로 보이고 `설정 지우기`로 지운다(03 §19.6.1, SG-21).
- **기기 범위.** 목록은 `read`(이 PC 스킬의 이름·설명·폴더)이고, 복사·미리 보기·설치·업데이트 확인은 이 PC의 스킬 폴더를 바꾸거나 네트워크를 쓰므로 `local`이다. 휴대폰(`read`·`prompt`)은 목록만 보고 화면은 `가져오기와 설치는 이 PC의 창에서만 할 수 있습니다`를 보인다. 게이트웨이는 기존 `own.import` 갈래가 같은 표(`OwnImportRouting.MethodScope`)로 판정하고 `/srv/<hostId>`는 막는다(5.5).
- `bun run generate`는 필요 없다(upstream Protocol·Server `HttpApi`를 바꾸지 않음).

### 9.7 SSH 원격 호스트

- own.import는 원격 호스트에 없다(5.5, 04 §4.1). 가져오기·설치는 이 PC에서만 하고, 원격 서버의 스킬 팝오버에는 `가져오기` 탭이 없다.
- 가져온 스킬은 own 전역 스킬 폴더의 보통 항목(`skills\<id>\`)이므로 04 §13의 스킬 동기화(R3, 아직 `not_supported`)가 원천 `%USERPROFILE%\.config\own-open-code\skills\*`로 그대로 다룬다. 원격 대상은 `~/.config/own-open-code/skills/<id>/`이고, 04 §13의 규칙(원격 service가 읽는 모든 스킬 루트를 보고 같은 id가 관리 목록 밖에 있으면 보내지 않음, Windows 전용 의심 표시)이 가져온 스킬에도 같다. `skill-imports.json`(원본 기록)은 이 PC에만 있고 원격으로 가지 않는다.

### 9.8 파일과 시험

| 위치 | 내용 |
|---|---|
| `packages/own-protocol/src/rpc-import.ts`, `rpc-import-routing.ts` | 스킬 스키마(`SkillOrigin`, `SkillKey`, `SkillID`, `SkillProblem`, `SkillNote`, `SkillFormat`, `SkillFound`, `SkillImport`, `SkillRepo`, `SkillCandidate`, `SkillPreview`, `FetchProblem`, `SkillUpdate`), 오류 여섯, 메서드 다섯, `health.features`의 `skills`, 범위·위치 표 |
| `packages/own-import/src/sources/paths.ts`, `src/options.ts` | 허용 목록 목적 `skill`, `neverName`, 옵션 `skillsDir` |
| `packages/own-import/src/skills/` | `format.ts`(형식 판정·변환·id·key·해시, 순수), `local.ts`(이 PC의 스킬 찾기·읽기, `Paths`로만), `git.ts`(URL 규칙, git 실행), `remote.ts`(미리 보기·nonce·설치할 파일), `store.ts`(own 파일: 배치, 기록, 임시 폴더), `service.ts`(메서드) |
| `packages/own-import/src/rpc.ts` | 서비스 스레드의 핸들러 다섯(Worker를 거치지 않음), 미리 보기 nonce 슬롯 `skills.nonces` |
| `packages/own-web/src/skills/` | `panel.tsx`(`목록`/`가져오기` 탭), `import.tsx`(lazy 청크: 목록·충돌·신뢰·업데이트·URL 설치), `import-model.ts`(순수 판정), `strings.ts`, `skills.css` |
| `own/upstream-surface.json` | `skills-config-dir-sources`, `skill-file-frontmatter`, `config-markdown-sanitize`, `config-markdown-gray-matter-version`, `compat-skill-roots`, `compat-skill-roots-home` |

- 시험(모두 합성 fixture, 실제 `~/.codex`·`~/.claude`·네트워크 없음): own-import `test/unit/skill-format.test.ts`(형식 표, 변환, id, 해시), `test/unit/skills.test.ts`(임시 폴더의 가짜 Codex·Claude Code 뿌리: 묶음과 상태, 비밀·링크·큰 스킬, IG1 guard, 복사·변환·충돌·바꾸기·업데이트), `test/unit/skill-git.test.ts`(127.0.0.1의 `git http-backend` 서버: URL 규칙, 미리 보기가 manifest 말고는 받지 않음을 partial clone의 빠진 객체로 확인, 고정 커밋 설치, nonce 한 번, 업데이트 확인, partial clone을 안 받는 서버·없는 저장소·https 아닌 URL 거절), `test/unit/hygiene.test.ts`(파일을 만지는 모듈), `test/e2e/skills.e2e.test.ts`(실제 서버, 파일 감시 켬: RPC로 목록·가져오기, core의 `GET /api/skill`에 사본이 `autoinvoke: false`로 실림, RPC의 `skill_conflict`, 원본 뿌리 IG1). own-protocol `test/rpc-import.test.ts`(메서드·오류·범위 표, id·key 규칙). own-web `src/skills/import.test.ts`(상태, 묶음, 이름 제안과 충돌, 업데이트 목록, 모든 문제·메모·이유의 문구, 범위). own-web 개발 서비스(`bun run dev:service`)의 합성 뿌리에도 스킬 다섯(Codex 둘, Claude Code 하나, 플러그인 둘)을 둔다.
- 시험 preload는 `OPENCODE_CONFIG_DIR`도 빈 임시 폴더로 둔다. git 시험은 git 프로세스가 많아 시험마다 180초 한도를 둔다(이 PC에서 git 한 번에 약 1초).

### 9.9 열린 문제

- 비공개 저장소(자격 증명), ssh URL, 커밋 SHA를 ref로 주기, 마켓플레이스 JSON URL을 바로 주기(지금은 저장소 URL만)는 아직 없다.
- Claude Code 플러그인의 나머지(명령, 에이전트, 훅, MCP)와 Codex의 `dependencies`(MCP 서버)는 가져오지 않는다. Codex `config.toml`의 `[mcp_servers]`, Claude Code `.claude.json`의 `mcpServers`, 프로젝트의 `.mcp.json`은 SM(2026-10-24)부터 설정 > MCP 서버의 `다른 도구에서 가져오기…`가 가져온다. 값을 vault에 넣어야 하므로 own-import가 아니라 own.accounts의 `mcp.import.*`다(02 §9.2 "MCP 서버"). own-import의 허용 목록은 그대로라 `config.toml`을 열지 않는다.
- 목록은 열 때마다 뿌리를 다시 훑는다(캐시 없음). 이 PC 크기(스킬 46개)에서는 문제없지만, 마켓플레이스 사본이 매우 크면 5,000폴더 상한에서 잘린다.
- 스킬마다 켜고 끄기(SG, 2026-10-26): core에는 스킬 스위치가 없어 own.accounts가 각 프로젝트 Location의 `skill.transform`으로 꺼진 스킬을 뺀다(02 §9.2). own-import의 화면은 `가져올 스킬을 쓸 곳`만 더했다. 남은 것: Codex·Pi·DeepSeek 방식의 스킬 블록은 요청 앞부분이라 켜고 끄면 그 대화의 다음 요청에서 캐시를 처음부터 다시 쓴다(캐시를 지키는 스킬 블록은 사용자가 정할 선택지). core는 플러그인의 다시 접기를 Location 없는 `skill.updated`로 알리므로 own-web이 스위치를 바꾼 뒤 그 프로젝트의 목록을 스스로 다시 읽고, `skillset.changed`마다 그 창이 읽은 모든 프로젝트의 스킬 목록을 낡은 것으로 표시한다(SG-18).
- 가져온 스킬은 설정 > 스킬의 `지우기…`로 지운다(SM, 2026-10-24): own.import `skills.remove{id}` → `{id}`(`local`, 오류 `skills_unconfigured`, `skill_not_imported{id}`). own-import의 기록에 있는 사본만, own 스킬 폴더에서 `OWN_HOME/tmp`의 작업 폴더로 옮긴 뒤 지우고(core의 감시가 한 번에 빠짐을 봄) 기록에서도 뺀다. 원본과 own-import가 만들지 않은 폴더(사용자가 넣은 스킬, 프로젝트의 스킬)는 지우지 않는다. 사용자가 폴더를 지우면 기록에서도 빠지는 것은 그대로다.
- 실제 앱 화면(Playwright)과 실제 GitHub 저장소로는 확인하지 않았다. 단위 시험과 127.0.0.1 git 서버까지만 했다. SK2(2026-10-24)부터 설정 > 스킬의 가져오기 화면은 e2e `e2e/tools/skills-import.pw.ts`가 Edge로 본다.
- SK2에서 남긴 것: git 저장소의 링크(mode 120000)는 여전히 `links`다(저장소 안을 가리키는 것만 풀어 복사하는 안은 남김). 뿌리의 `skills` 자체가 뿌리 밖을 가리키면(`skillsTarget`) 보이기만 하고 읽지 않는다. 동기화 폴더의 계정 이름은 그 폴더 이름의 `<account>`(또는 `<org>`)가 own Claude 계정의 `accountUuid`와 같을 때만 붙는다(이 PC의 실제 폴더 이름 형식은 보지 않았다). 링크 대상의 확인과 열기 사이 바꿔치기는 막지 않는다. 대표 사본을 사용자가 고르는 단추는 없다(한 줄의 사본은 내용이 같다).

### 9.10 찾은 곳 이름, 같은 스킬 하나로, 링크, 상세 보기 (SK2, 2026-10-24)

사용자 요청(2026-10-24): "codex에서 쓰는 스킬의 경우 형식이 안맞다고 하는데 해결방법이 없는지 알아내고", "스킬 가져오기할때 지금 어떤거에서 이게 가져오려는건지도 너무 헷갈림. 왜냐면 multi-codex 뭐 그런앱에서 계정별로 해놔가지고 스킬이 중복돼서 보이고", "스킬 저기서 검색기능도 있으면 좋을것같고", "중복된 스킬은 그냥 동일한거는 하나만 대표적으로 보여주면 좋을듯", "스킬 상세보기누르면 스킬 상세하게 볼수있게". 브랜치 `skills-dedup`(기준 `settings-mcp-skills` `7951ec4fd5`). 결정은 decisions-2026-10의 SK2다.

**찾는 곳(9.1에 더함).**

- **codex-multi-provider 계정 홈.** 스킬 목록만 `<control-center>\state.json`을 읽어 계정마다 `<control-center>\profiles\<id>\codex`를 Codex 뿌리로 더한다(`origin: "profile"`, `account{app, id, alias}`). 읽는 파일은 `state.json` 하나다(own-runtime `CodexSource.profileHomes`: 16 MiB까지, id는 `PROFILE_ID` 규칙, 파일의 `home` 칸은 쓰지 않고 id로 만든다). `auth.json`은 열지도 stat하지도 않는다. control center는 플러그인 옵션 `controlCenter`(문자열, `null`이면 끔)이고, 없으면 `CodexSource.DEFAULT_CONTROL_CENTER`를 쓰되 Codex 뿌리가 기본일 때(옵션 `roots.codex` 없음)만 쓴다. 그래서 시험과 소스 실행은 이 PC의 control center에 닿지 않는다(시험 fixture는 `controlCenter: null`). 대화 가져오기의 뿌리 색인은 바뀌지 않는다(자동 찾기는 여전히 I3, 1.3). `찾을 곳 더하기`로 더한 뿌리가 계정 홈이면 그 자리를 지키고 `account`만 붙는다.
- **같이 쓰는 스킬 폴더.** 뿌리의 `skills`가 다른 뿌리의 `skills`와 같은 실제 폴더(junction·링크)면 그 뿌리의 스킬은 한 번만 훑고 `sharedWith: <그 뿌리 id>`로 알린다. 다른 곳을 가리키면 `skillsTarget`(보이기만 하고 읽지 않는다). 그전에는 그런 junction이 `path_denied`로 막혀 조용히 아무것도 보이지 않았다.
- **건너뛰는 폴더.** 스킬 묶음 폴더 중 `.trash`, `.staging`(지운 스킬과 설치 중인 스킬)은 스킬로 보지 않는다.
- **Claude 앱의 동기화 폴더.** Claude Code 뿌리의 `skills\synced\<org>_<account>\` 아래 스킬은 `synced{folder, org, account}`를 단다. own-web은 own의 Claude 계정 중 `accountUuid`가 같은 계정의 이름으로 부른다(02 §8.7, `Account.View.claude.accountUuid`). 같은 계정이 없으면 `Claude Code · 동기화된 계정 <id 앞 8자>`다.

**찾은 곳의 이름(own-web `rootLabel`, `sourceOf`).** 종류마다 처음 기본 뿌리(`default`·`env`·`option`)는 `Codex (기본 폴더)`, `Claude Code (기본)`이다. 계정 홈은 `Codex · 계정 <별칭>`(별칭이 없으면 `Codex · 계정 <id>`)이다. 더한 뿌리와 두 번째 기본 뿌리는 `Codex · 폴더 <폴더 이름>`이고, `.codex`·`codex`·`.claude` 같은 이름이면 부모 이름을 앞에 붙인다(`Codex · 폴더 backup\.codex`). 동기화 폴더는 `Claude Code · 계정 <own Claude 계정 이름>`, 플러그인은 `Claude Code 플러그인 · <마켓>`이다. 순서는 기본 Codex, 다른 Codex 폴더, 더한 Codex, 계정 홈(id 순), Claude Code, 동기화 계정, 플러그인이다. 서버의 `Root.label`은 예전 클라이언트를 위해 그대로 둔다.

**새 필드(`SkillFound`, 모두 선택).** `relative`(뿌리 아래 폴더), `real`(링크를 푼 실제 폴더), `modifiedAt`(파일 중 가장 늦은 수정 시각), `version`(머리말 `version`, 없으면 `metadata.version`), `hash`(9.4의 내용 해시, 링크는 가리키는 파일로 계산), `links`(아래), `synced`. 해시는 같은 id(대소문자 무시)가 두 번 이상 보이거나 가져온 기록이 있는 스킬만 계산한다(목록이 모든 파일을 읽지 않게). `skills.list{hashes: true}`는 모두 계산한다(설정 > 스킬의 상세 보기가 내용으로 찾은 곳을 맞출 때). 한 실제 폴더는 한 번만 읽는다. 9.2의 "목록은 SKILL.md만 읽는다"는 이만큼 바뀌었다.

**같은 스킬은 한 줄로(own-web `mergeFound`).**

| 단계 | 기준 | 화면 |
|---|---|---|
| 한 곳 | 같은 실제 폴더(`real`) | 링크로 닿은 다른 길은 그 곳의 `링크로 같은 폴더` |
| 한 줄 | 원본 종류(`origin`) + id + 내용 해시 | `N곳에서 찾음 ▸`(펼치면 곳마다 이름·폴더·`수정 날짜`·`버전`, 대표 사본에 `대표`) |
| 다른 줄 | 같은 종류·id에 다른 해시(또는 해시 없음) | 줄마다 `내용이 다름`(경고 색)과 `버전`·`수정 날짜` |

- **대표**(가져오고 보이는 사본)는 이미 쓰는 곳, own-import가 가져온 곳, 곳 순서(기본 홈이 먼저), 기본 제공이 아닌 것, 얕은 폴더, 늦게 고친 것 순으로 고른다.
- **상태.** 그 줄의 한 곳이라도 core가 싣는 폴더면(`SKILL.md` 경로가 목록 경로나 실제 경로와 같음) `이미 쓰는 중`이다. 다른 종류의 줄이라도 같은 id·같은 해시인 곳을 core가 싣고 있으면 `이미 쓰는 중 (<그 곳 이름>)`이다(예: `~/.claude/skills`의 pdf와 같은 Codex pdf). 단추가 없으니 `pdf-codex` 같은 두 번째 사본이 생기지 않는다. own-import 기록의 해시와 같으면 `이 앱에 있음`, 기록의 원본이 바뀌면 `원본이 바뀜`, 바깥 링크가 승인을 기다리면 `링크 확인 필요`다. 같은 id에 다른 내용은 예전처럼 이름을 바꿔 가져온다.
- **검색과 거르기.** 검색 칸 `스킬 검색`은 낱말마다 이름·id·설명·곳 이름·폴더 중 하나에 있어야 맞는다(앞의 `@`는 뗀다). 칩 `전체`·`가져올 수 있음`·`이미 있음`(이미 쓰는 중·이 앱에 있음·원본이 바뀜)·`내용이 다름`·`형식이 맞지 않음`과 고르기 `모든 곳`/곳마다가 있다. 기본 제공(Codex `.system`)은 `기본 제공도 보기`를 켜야 보이고, 꺼져 있으면 `기본 제공 N개 숨김`을 보인다.
- **머리.** `찾아본 곳`에 뿌리마다 이름과 줄 수(전체 경로는 툴팁), 문제(`폴더 없음`, `읽을 수 없음`, `열지 않는 곳`), `<이름>의 스킬 폴더를 같이 써요`, `스킬 폴더가 다른 곳을 가리켜요: <폴더>`를 보인다. `찾을 곳 더하기`(`sources.configure`가 되는 창에서만)는 설정 > 다른 도구로 간다(팝오버는 닫는다).

**형식이 맞지 않던 원인(9.3에 더함).**

- **링크(심볼릭 링크·junction).** 링크는 만들지 않고 가리키는 것을 복사한다. 스킬 폴더 자체가 링크인 것과 스킬 안의 링크가 같은 규칙이다. 대상은 실제 경로로 판정하고, 승인 전에는 대상의 목록도 내용도 읽지 않는다(stat 한 번).

| 대상 | 상태 | 동작 |
|---|---|---|
| 같은 뿌리의 스킬 영역, 다른 뿌리의 스킬 영역(`inside`) | `copy` | 바로 복사한다. 메모 `링크는 가리키는 파일을 복사해요` |
| core가 스킬을 싣는 폴더: `<home>\.agents\skills`, `<home>\.claude\skills`, own 스킬 폴더(`known`, home은 core의 `Global.Path.home`) | `copy` | 바로 복사한다. 실제 폴더를 core가 싣고 있으면 `이미 쓰는 중` |
| 그 밖의 로컬 드라이브(`outside`) | `approve` | 줄에 `링크 → <대상>`과 체크 `이 폴더의 파일을 복사해서 가져오기`를 보인다. 체크하면 그 `linkKey`로 목록을 다시 읽어(설명·실행 파일·형식·해시) 신뢰 확인이 실제 파일을 본다 |
| 없음(`broken`), 자기 위나 자기 자신(`cycle`), 장치와 그 밖의 파일(`special`), 네트워크(`network`, UNC는 실제 경로를 풀기 전에 거절), 열지 않는 곳(`denied`: 뿌리의 스킬 영역 밖 파일, OWN_HOME, `.ssh`·`.gnupg`·`.aws`·`.azure`·`.kube`·`.docker`, Windows 폴더, 열지 않는 이름, 비밀처럼 보이는 파일) | `refused` | 문제 `links`(`쓸 수 없는 링크(심볼릭 링크·junction)가 있음`)와 이유를 보인다 |

  - `linkKey`는 `lk-`와 sha256(뿌리 id, 스킬 폴더, 링크 위치, 대상 실제 경로)의 앞 20 hex다. 클라이언트는 경로를 넘기지 않는다(2.1). 대상이 바뀌면 키가 달라져 승인이 풀린다.
  - 허용 목록(`Paths.check`)은 목적 `skill`에서 뿌리 밖의 실제 경로를 스킬의 `reach`(아는 폴더, 모든 뿌리의 스킬 영역, 승인한 대상) 안이고, 막는 폴더·뿌리의 스킬 영역 밖·열지 않는 이름이 아닐 때만 연다. 링크 위치(어휘 경로)는 여전히 스킬 영역 안이어야 한다.
  - 링크를 따라간 파일도 500개·20 MiB·깊이 8 한도에 든다. 확인과 열기 사이의 링크 바꿔치기는 따로 막지 않는다(AGENTS의 추측성 경쟁 규칙). 가져오기 때 다시 풀고 키를 맞춘다.
  - git 설치(9.5)의 링크(mode 120000)는 여전히 `links`다(9.9).
- **거짓 `형식이 맞지 않음`.** `.env.example`·`.env.sample`·`.env.template`은 비밀 파일이 아니다(`.env`와 다른 `.env.*`는 그대로 막는다). 스킬 안의 `*.lock`(`uv.lock`, `Cargo.lock`)은 목적 `skill`에서 읽고 복사한다(다른 목적에서는 여전히 열지 않는다). `node_modules`·`.venv`·`__pycache__`·`.git`은 세지도 복사하지도 않는다(메모 `node_modules·.venv 같은 폴더는 빼고 복사해요`). 본문 검사(`` !`…` ``, `${CLAUDE_…}`, `$ARGUMENTS`)는 코드 펜스(백틱 셋이나 물결 셋) 안을 보지 않는다(예시일 뿐이다). 다만 `!`로 여는 펜스는 Claude Code가 실행하므로 `dynamic_context`다.
- **Codex 스킬의 Claude Code 문법.** Codex는 `` !`…` ``·`$ARGUMENTS`·`${CLAUDE_…}`·`hooks`·`context: fork`를 실행하지 않고 글로 둔다. own도 같으므로 Codex 스킬에서는 문제가 아니라 메모 `claude_only`(`Claude Code 전용 문법(…)은 Codex처럼 글 그대로 둬요`)다.

**가져오기(9.4에 더함).** `skills.import{key, approvedLinks?}`는 늘 새로 훑어 링크를 다시 푼다. 승인하지 않은 바깥 링크가 있으면 `skill_links{key, linkKeys, reason: "unapproved"}`, 승인한 대상이 바뀌었으면 `reason: "changed"`다(화면 `링크가 가리키는 곳이 바뀌었어요. 다시 확인하고 승인해요.`). 기록(`SkillImport.links`)에 승인한 바깥 링크의 `{relative, target, linkKey}`를 남기고, `skills.updates`는 그 키로 다시 승인해 읽는다(대상이 옮겨졌으면 `unknown`). 사본에는 링크가 없고 평범한 파일과 폴더만 있다.

**상세 보기(`skills.detail`, 범위 `read`).** 입력은 셋 중 하나다. `{key, approvedLinks?}`는 찾은 스킬, `{copy: id}`는 own-import의 사본(own 스킬 폴더에서 읽음), `{directory, loaded: id}`는 그 프로젝트에서 core가 싣는 스킬이다. 마지막 것은 own-import가 자기 서비스의 `GET /api/skill`로 경로를 받아 그 폴더만 다른 도구의 스킬처럼 읽는다(링크는 아는 곳까지만 따라가고, 열지 않는 이름과 비밀 파일은 열지 않는다). 출력 `SkillDetail`은 이름, 설명, 읽은 폴더, 머리말 키 전부(파일 순서, 값은 글: 목록은 `, `로 잇고 그 밖은 JSON, 50개·2,000자까지), 본문(256 KiB까지, `truncated`), 파일과 크기(500개까지), 파일 수와 바이트, 해시, 형식, 링크, 사본이면 `{record, source: same|changed|source_missing|unknown}`이다(git 원본은 네트워크를 쓰지 않으므로 `unknown`). 오류는 `skill_not_found`, `skills_unconfigured`다. core의 기본 제공 스킬(`/builtin/…`)은 폴더가 없어 own-web이 core가 준 본문으로만 보인다.

| 메서드 | 범위 | 입력 → 출력 | 오류 |
|---|---|---|---|
| `skills.list` | `read` | `{approvedLinks?: LinkKey[≤200], hashes?}` → 9.6과 같다(필드가 더해짐) | |
| `skills.import` | `local` | `{key, id?, replace?, approvedLinks?}` → `{id, directory}` | 9.6의 넷과 `skill_links{key, linkKeys, reason}` |
| `skills.detail` | `read` | `{key, approvedLinks?}` \| `{copy}` \| `{directory, loaded}` → `SkillDetail` | `skill_not_found`, `skills_unconfigured` |

- `Root`에 `origin`, `account`, `sharedWith`, `skillsTarget`이 더해졌다(모두 선택, `sources.list`의 답은 그대로다). `bun run generate`는 필요 없다.

**파일과 시험.** own-runtime `codex-source.ts`(`profileHomes`). own-import `sources/paths.ts`(`profile` 뿌리, `skillRoots`, `controlCenter`, `reach`·`whole` 뿌리, `classifyLink`, 목적 `skill`의 lock 파일), `skills/local.ts`(링크 따라가기, 건너뛰는 폴더, 새 필드, `loaded`), `skills/format.ts`(코드 펜스, `claude_only`, `version`, `frontmatter`, `withNotes`), `skills/service.ts`(`detail`, `skill_links`, 해시, `sharedWith`), `skills/store.ts`(`readCopy`), `http.ts`(`GET /api/skill`). own-web `skills/import-model.ts`(이름, `mergeFound`, 검색·거르기·묶음, `lookedIn`), `import.tsx`, `detail.tsx`·`detail-render.ts`(lazy 청크), `settings.tsx`. 시험은 own-runtime `codex-source.test.ts`(state.json만), own-import `skill-links.test.ts`(안쪽 junction·파일 링크·아는 폴더·바깥 승인과 바뀐 대상·비밀과 OWN_HOME·끊김과 고리·네트워크·한도), `skill-sources.test.ts`(설계 fixture: pdf 넷, `.system`, 계정 셋과 junction 공유, 동기화 폴더, `.trash`/`.staging`, 거짓 형식 셋), `skills.test.ts`(상세 보기 셋), `skill-format.test.ts`(펜스, Codex, 버전, 머리말), own-protocol `rpc-import.test.ts`, own-accounts `claude/accounts.test.ts`(uuid), own-web `import-merge.test.ts`, e2e `e2e/tools/skills-import.pw.ts`(Edge: 이름·중복·검색·상세 보기의 위험한 본문·링크 승인·설정의 상세 보기·팔레트와 팝오버 링크·375 px)다.

### 9.11 두 번째 리뷰 수정 (SK2, 2026-10-25)

브랜치 `skills-r3`(기준 `settings-mcp-skills` `0ad7f0635b`)에서 SK2 두 번째 검증의 지적 열 개를 고쳤다. 결정은 decisions-2026-10의 SK2-14부터다.

- **머리말의 YAML 별칭.** gray-matter의 js-yaml(core와 같다)에는 별칭 한도가 없지만 읽기는 선형이다. 별칭은 앵커 값을 가리킬 뿐이다. 문제는 값을 글로 쓸 때다. 9단계 별칭 폭탄은 JSON으로 펼치다 메모리가 바닥났다(8단계는 462바이트로 68초, 1.9 GB). 이제 `상세 보기`의 머리말(`SkillFormat.frontmatter`)은 값마다 먼저 펼친 크기를 잰다. 이때 같은 객체는 메모로 한 번만 센다. 별칭으로 1만 개를 넘거나 고리(`&a [*a]`)면 값 대신 `omitted: "aliases"`다. 그 밖의 값은 2,000자에서 멈추는 쓰개가 쓰고, 넘으면 `…`로 끝난다. 한 번의 호출은 250 ms와 64 KiB를 넘지 않는다. 넘은 뒤의 키는 `omitted: "budget"`이다. 형식 검사(`analyze`)는 값을 펼치지 않으므로 그대로다. 화면은 `YAML 별칭(*)이 너무 많이 펼쳐져서 보여 주지 않아요`, `머리말이 너무 커서 여기부터는 보여 주지 않아요`다. 이 일은 own-import의 서비스 스레드에서 돈다.
- **원격 그림.** 본문의 모든 원격 그림(http·https·`//`)을 따로 그림 요소로 바꾼다. 대상은 `<img>`, `srcset`만 있는 그림(첫 후보), 모든 요소의 `background`, 비디오 `poster`, SVG `image`·`use`·`feImage`의 `href`·`xlink:href`, 이미지 단추의 `src`, `style`의 `url()`이다. 바꾸기는 DOMParser의 문서에서 한다(아무것도 싣지 않는다). 그 뒤 DOMPurify가 남긴 요소에서 `a[href]`·`img[src]` 말고는 무엇을 싣는 속성(`background`, `poster`, `src`, `srcset`, `href`, `xlink:href`, `data`, `cite`, `ping`, `style` 등)도 모두 지운다. 그래서 `원격 그림 N개를 가렸어요`가 이것을 모두 세고, `원격 그림 보기` 전에는 어떤 주소에도 요청이 가지 않는다. 보기를 누르면 그림으로 싣고 referrer를 보내지 않는다(`referrerpolicy="no-referrer"`). e2e가 로컬 탐침 호스트로 요청 수와 Referer를 센다.
- **본문 파싱.** marked는 이제 주 스레드에서 돌지 않는다. 상세 보기마다 따로 worker(`skills/detail.worker.ts`)를 띄우고 worker가 준비된 뒤 3초가 지나면 끝낸다(chunk를 싣는 시간은 20초까지 따로 기다린다). 실패(`> ` × 5,000의 스택 넘침)나 시간 초과(`*a ` × 6,000, 전에는 Edge를 8초 멈췄다)면 본문을 `pre`에 글 그대로 보이고 `본문을 꾸며 보여 줄 수 없어 글 그대로 보여요`를 붙인다. 정화가 던져도 같다. 상세 보기가 비는 일은 없다. 꾸미는 동안은 `본문을 꾸미는 중…`이다.
- **core가 싣는 스킬을 내용으로 맞추기.** `skills.list{directory}`는 그 프로젝트에서 core가 싣는 스킬(`GET /api/skill`)을 본다. 대상은 own 스킬 폴더(손으로 넣은 것), `~/.agents/skills`, 프로젝트의 스킬 같이 뿌리가 아닌 곳이다. 그중 찾은 스킬과 파일 모양(이름과 크기)이 같은 것만 읽어 해시한다(기본 제공과 낱 파일 스킬은 뺀다). 해시는 폴더의 실제 경로를 키로 둔다. 파일 모양, 가장 늦은 수정 시각, 승인 대기가 그대로면 다시 읽지 않는다. 답의 `loaded: [{id, path, hash}]`가 그 해시다. 같은 모양의 찾은 스킬도 해시를 받는다. own-web은 같은 id·같은 해시면 `이미 쓰는 중 (전역)`이나 `(프로젝트)`로 보인다. 다른 id·같은 해시면 `이미 쓰는 중`과 `같은 내용이 <id>로 이미 있어요`다. 둘 다 `이 앱에서 쓰기`가 없다. 그래서 `-codex` 같은 두 번째 사본이 생기지 않는다. own-import 기록과 해시가 같지만 id가 다르면 `이 앱에 있음`에 같은 문구가 붙는다.
- **통째로 링크인 계정 홈.** codex-multi-provider 계정의 codex 홈 자체가 `~/.codex`로 가는 junction이면 두 뿌리의 실제 폴더가 같다. 이때 링크가 아닌 뿌리(없으면 먼저 나온 뿌리)가 주인이고, 다른 뿌리는 `sharedWith`로 그 뿌리를 가리키며 다시 훑지 않는다(`sharing`이 뿌리의 실제 경로도 비교한다).
- **너무 큰 스킬.** `SKILL.md`가 1 MiB를 넘거나 읽을 수 없으면 더는 `no_skill_md`를 붙이지 않는다. `too_large`(또는 `unreadable`)만 붙인다. `SkillFormat.large{skillMd?, files?, bytes?, deep?}`가 넘은 한도와 잰 값을 알린다. 로컬 걷기는 501개에서 멈추므로 `files`는 아래 한계다. git 미리 보기는 참 개수다. 화면은 `SKILL.md가 너무 큼(<크기>, 1 MiB까지)`, `파일이 500개 넘음`, `파일이 너무 큼(<크기>, 20 MiB까지)`, `폴더가 너무 깊음(8단계까지)`이다. `large`가 없는 예전 답이면 예전 문구다. 상세 보기는 `SkillDetail.skillMd{state: missing|too_large|unreadable, size?}`로 `SKILL.md가 너무 커서 보여 줄 수 없어요(<크기>)` 등을 보인다. 500개를 넘으면 `파일 500개 넘음`과 `앞의 500개만 보여요`다. 사본과 낱 파일 스킬의 상세 보기에도 같은 1 MiB 한도를 둔다.
- **core 목록이 오기 전.** 가져오기 화면의 `loaded`가 아직 없으면(core가 그 프로젝트의 스킬을 답하기 전, 또는 답하지 못하면) 모든 줄이 `확인 중…`이고 `이 앱에서 쓰기`는 꺼진 채 보인다. 툴팁은 `이 앱이 쓰는 스킬을 불러오는 중이에요. 다 불러오면 가져올 수 있어요.`다. `가져올 수 있음` 거르기에도 들지 않는다.
- **링크 승인은 이 PC만.** `scopeOf`는 `skills.list`·`skills.detail`에 비어 있지 않은 `approvedLinks`가 있으면 `local`이다. 그래서 게이트웨이(own-remote)가 `read` 기기의 승인을 403으로 거절한다. 승인이 없는 목록과 상세 보기는 그대로 `read`다.
- **찾은 곳 이름.** 계정은 `Codex · 계정 <별칭>`(별칭이 없으면 `Codex · 계정 <id>`), 더한 폴더는 `Codex · 폴더 <이름>`, Claude Code도 `Claude Code · 폴더 <이름>`, 동기화 계정은 `Claude Code · 계정 <own 계정 이름>`이다. 별칭과 폴더 이름이 같아도 이름이 겹치지 않는다(9.10의 이름을 바꾼다).

| 메서드 | 바뀐 것 |
|---|---|
| `skills.list` | 입력 `directory?`(그 프로젝트의 core 스킬과 비교), 출력 `loaded?`. `approvedLinks`가 있으면 범위 `local` |
| `skills.detail` | 출력 `frontmatter[].omitted?`(`aliases`·`budget`), `skillMd?`. `approvedLinks`가 있으면 범위 `local` |
| `skills.preview` | 후보의 `format.large`(참 파일 수, `SKILL.md` 크기) |

**파일과 시험.** own-import `skills/format.ts`(`aliased`, 쓰개, 예산), `skills/local.ts`(`skillMd`의 상태, `large`, 깊이), `skills/service.ts`(`loadedTwins`, 해시 캐시, `sharing`, `shape`), `skills/remote.ts`. own-protocol `rpc-import.ts`, `rpc-import-routing.ts`(`scopeOf`). own-web `skills/detail-render.ts`(그림 바꾸기, 속성 지우기, worker 파싱), `skills/detail.worker.ts`, `detail.tsx`, `import-model.ts`(`checking`, `twins`, `sameAs`, 이름), `import.tsx`, `panel.tsx`, `settings.tsx`. 시험은 own-import `skill-format.test.ts`(8·9단계 폭탄, 고리, 긴 값, 예산), `skills.test.ts`(9단계 폭탄의 상세 보기, 1 MiB 넘는 `SKILL.md`, 파일 501개), `skill-sources.test.ts`(통째로 링크인 계정 홈, core 스킬의 해시와 캐시), own-protocol `rpc-import.test.ts`, own-remote `gateway/policy.test.ts`, own-web `import-merge.test.ts`(이름, `확인 중`, 같은 내용), e2e `e2e/tools/skills-import.pw.ts`다. e2e는 탐침 호스트로 그림 요청 0개와 referrer 없는 요청을 보고, 두 본문이 글 그대로 보이고 주 스레드가 2초 넘게 멈추지 않음을 보고, 손으로 넣은 같은 내용을 보고, 짧은 창(1280×480)에서 팔레트 요청을 본다. 짧은 창에서는 가져오기 자리가 처음에 보이지 않아야 한다.

### 9.12 머리말은 YAML만 (SK2, 2026-10-25)

gray-matter 4.0.3은 여는 `---` 줄의 나머지를 머리말의 언어로 읽는다. `---js`·`---javascript`(대소문자 무관)면 기본 엔진이 머리말을 `eval`로 실행하고, `---coffee`·`---cson`도 CoffeeScript 엔진이 등록되면 실행한다. own-import는 스킬을 쓰기로 고르기 전에 읽는다. `skills.list`(다른 도구의 폴더, Claude Code 마켓플레이스 사본), `skills.detail`(core가 싣는 스킬도), 아직 설치하지 않은 저장소의 `skills.preview`가 그렇다. 그래서 그런 `SKILL.md` 하나로 서비스 프로세스에서 코드가 돌 수 있었다(심각, 8d8c7960f3까지).

- **규칙.** 여는 `---` 뒤에 `yaml`·`yml`(대소문자 무관)이 아닌 낱말이 있으면 그 스킬은 `형식이 맞지 않음`이고 이유는 `frontmatter_language`(`머리말이 YAML이 아님(---js 같은 다른 언어)`)다. gray-matter와 같은 순서로 판단한다. BOM을 빼고, 맨 앞의 `---`(네 번째 글자가 `-`가 아님), 첫 `\n`까지의 나머지를 다듬는다. 그래서 `--- js`, `---JS`, CRLF, `---` 뒤의 홀로 CR도 걸린다. `---yaml`·`---YAML`·`---yml`·`--- Yml`은 gray-matter가 YAML 엔진으로 읽으므로 받는다. core의 `ConfigMarkdown.parse` 패치(P-036, 브랜치 `core-frontmatter`)가 gray-matter의 `file.language`로 쓰는 규칙과 같다(SK2-19, 2026-10-25에 맞춤). `---json`, `---yamljs`, `---toml` 같은 다른 낱말은 모두 막는다. 이런 파일은 gray-matter에 넘기지 않는다. `---yaml`로 여는 스킬을 바꿔 가져올 때는 여는 줄을 그대로 두고 그 아래에 `disable-model-invocation: true`를 넣는다. 이름은 폴더 이름이고, 상세 보기의 머리말은 비어 있으며 본문 자리에 파일을 글 그대로 보인다(언제나처럼 worker와 정화를 거친다).
- **두 번째 벽.** gray-matter를 부를 때마다 `javascript`·`js`·`coffee`·`coffeescript`·`cson` 엔진을 예외를 던지는 것으로 바꿔 넘긴다. 첫 규칙을 지나는 경우가 생겨도 실행되지 않고 읽지 못한 머리말이 된다.
- **찾아본 곳.** own 패키지(own-import, own-accounts, own-harness, own-team, own-web 빌드 스크립트, `own/scripts`)에서 gray-matter나 다른 머리말 파서를 쓰는 곳은 `skills/format.ts`의 `parse` 하나다(`agents/openai.yaml`도 이 함수로 읽는다). upstream의 `packages/plugins/figma`는 함께 배포하는 자기 스킬만 읽는다.
- **열림: core.** core의 `ConfigMarkdown.parse`(`packages/core/src/config/markdown.ts`)도 기본 엔진으로 `matter(content, {})`를 부른다. core는 `~/.claude/skills`, `~/.agents/skills`, 프로젝트의 `.claude`·`.agents`·`.opencode` 스킬·에이전트·명령, 설정의 URL 스킬 원본을 이 함수로 읽는다. 그래서 그런 곳에 놓인 `---js` 파일은 core에서 실행된다. own-import는 이제 그런 스킬을 가져오지 않지만 core가 직접 읽는 곳은 막지 못한다. 고치려면 core 패치가 필요하고 사용자 승인을 기다린다(엔진 맵과 언어 거절을 `parse`에 넣는 작은 패치).

**파일과 시험.** own-import `skills/format.ts`(`language`, `ENGINES`), own-protocol `rpc-import.ts`(`SkillProblem`의 `frontmatter_language`), own-web `skills/import-strings.ts`. 시험은 own-import `skill-format.test.ts`(막는 언어 열다섯 꼴과 표시 파일 없음, 받는 YAML 여섯 꼴과 바꿔 가져오기), `skills.test.ts`(Codex·Claude Code·마켓플레이스 사본·core가 싣는 폴더와 단일 파일의 목록·상세 보기·가져오기), `skill-git.test.ts`(127.0.0.1의 `git http-backend` 저장소 미리 보기와 설치 거절)다. 세 시험 모두 `8d8c7960f3`에서는 표시 파일이 생겨 실패한다.
