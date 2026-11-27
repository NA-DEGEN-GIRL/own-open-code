# own e2e test kit

upstream OpenCode v2 서버를 소스에서 그대로 띄우고, 실제 provider 대신 로컬 가짜 서버(fake)로 요청을 받아 기록하는 테스트 도구입니다. 이후 단계(own-accounts 주입·전환, 한도 수집, retry 정책, Codex 로그인 가져오기, own-web E2E)가 이 키트 위에서 테스트를 씁니다.

- 비밀 위생: 테스트는 가짜 자격 증명만 씁니다. fake는 `authorization`, `x-api-key` 같은 헤더 값을 `hashSecret(value)`(`sha256:` + 12 hex)로 바꿔 기록하고, harness는 개발자 셸의 `OPENCODE_*`와 `*_API_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD` 변수를 자식 서버에 넘기지 않습니다.
- 실제 `D:\#Projects\codex-multi-provider\...` 프로필은 테스트가 절대 읽지 않습니다. 같은 모양의 가짜 프로필을 임시 디렉터리에 만들어 씁니다(아래 "Codex 로그인 가져오기").

## 실행

```powershell
cd D:\own-open-code\packages\own-accounts   # '#'가 들어간 경로에서 실행하지 않음(Bun/Vite 경로 문제)
bun test test/e2e-kit                        # fakes.test.ts(빠름) + smoke.test.ts(서버 부팅)
bun run typecheck
```

- 저장소 루트에서는 테스트가 돌지 않습니다(루트 `bunfig.toml`의 가드).
- 서버 부팅은 따뜻한 캐시에서 약 10초, 처음(트랜스파일 캐시가 빌 때)에는 약 30초입니다. CPU가 바쁘면 몇 배 걸리므로 harness는 부팅 단계마다 기본 170초까지 기다립니다(`startupTimeoutMs`). 모든 시험이 체크아웃마다 하나인 Bun 트랜스파일 캐시(`<저장소>\node_modules\.cache\own-e2e-bun-transpiler`, `E2E_TRANSPILER_CACHE`)를 같이 씁니다. `TEMP`를 옮기는 own-web 시험과 `remote/e2e`의 원격 서비스도 같은 캐시를 씁니다(`BUN_RUNTIME_TRANSPILER_CACHE_PATH`로 바꿀 수 있음). 예전 위치 `%TEMP%\own-e2e-bun-transpiler-cache`와, `TEMP`를 옮기는 own-web 시험의 임시 폴더 안에 있는 같은 이름의 폴더는 더 쓰지 않으므로 지워도 됩니다.
- 실서버를 띄우는 시험 파일은 import 바로 뒤에서 `setDefaultTimeout(60_000)`을 부릅니다. Bun 기본 5초는 부하가 있으면 실서버 단계(새 Location의 첫 RPC, `server.stop()`)에 모자랍니다. 한 단계가 시간을 넘기면 Bun이 `beforeAll`이 띄운 서버를 죽이고, 그 파일의 나머지 시험도 실패합니다. preload나 공용 모듈에 두면 한 번 실행의 첫 파일에만 적용되고 `bunfig.toml`의 `[test] timeout`은 무시되므로(Bun 1.4.2) 파일마다 씁니다. 그 대신 이 파일들에서 멈춘 단계는 5초가 아니라 60초 뒤에 실패합니다. 빠뜨린 파일은 `timeouts.test.ts`가 찾습니다.
- `OWN_E2E_LOGS=1`: 서버 로그를 테스트 stderr로 흘립니다. `OWN_E2E_KEEP=1`: 끝난 뒤 임시 루트를 지우지 않습니다.

## 구성

| 파일 | 내용 |
|---|---|
| `fakes/fake-server.ts` | 공용 `Bun.serve` 래퍼: 기록, 응답 큐, `waitForRequests`, WebSocket 훅, `delayed-listen`의 listener 닫기·다시 열기 |
| `fakes/prompt-cache.ts` | 결정적 prompt cache 모형. (domain, prefix 바이트) 단위. 자동 prefix 모드와 Anthropic breakpoint 모드 |
| `fakes/openai-responses.ts` | OpenAI Responses (`POST /v1/responses` SSE, `GET /v1/models`, `x-ratelimit-*`) |
| `fakes/codex.ts` | ChatGPT Codex backend (`/backend-api/codex/responses` SSE + WebSocket, `x-codex-*` 헤더, `codex.rate_limits`·`codex.response.metadata` 프레임, `GET /backend-api/wham/usage`(`requests`에 남기지 않고 `usagePolls`에 셈. `setResetCredits`를 주면 `rate_limit_reset_credits`를 싣는다), 리셋권 `GET /backend-api/wham/rate-limit-reset-credits`(`resetCreditReads`)와 `POST …/consume`(`consumes`에 본문·헤더를 남김. `redeem_request_id`마다 한 번만 쓰고 다시 오면 `already_redeemed`, `scriptConsume`으로 `reset`·`nothing_to_reset`·`no_credit`·500(`error`)·늦은 답(`delayMs`), 02 §7.1.1), `modelList`를 주면 `GET /backend-api/codex/models`(묻는 `client_version`이 보는 행만, 버전마다 etag·304. `requests`에 남기지 않고 `modelListReads`에 셈, 07 §4.5 CA), `POST /oauth/token` refresh). 한도·속도 응답은 실제 백엔드 모양(2026-10-18 실측: `service_tier`는 `auto` 다음 `default`, `weeklyOnly`는 주간 창 하나뿐인 요금제) |
| `fakes/anthropic.ts` | Anthropic Messages (`POST /v1/messages` SSE, `cache_control` breakpoint, `anthropic-ratelimit-*`, 구독 `anthropic-ratelimit-unified-*`) |
| `fakes/openai-chat.ts` | OpenAI 호환 chat, DeepSeek 방언 (`POST /v1/chat/completions` SSE, `prompt_cache_hit_tokens`, `GET /user/balance`) |
| `harness/opencode-server.ts` | upstream 서버를 자식 프로세스로 부팅하는 harness와 HTTP 클라이언트 |
| `harness/config.ts` | fake를 가리키는 `providers.<id>` config 조각과 `opencodeConfig()` |
| `harness/events.ts` | `recordServerEvents(server)`: `GET /api/event`(SSE) 기록기. `server.connected`를 받은 뒤 돌려주므로 그다음 동작의 이벤트를 놓치지 않습니다. `own(name)`, `waitFor(match)`, `text()`(비밀 검사용 원문) |
| `fakes/chatgpt-auth.ts` | ChatGPT OAuth issuer(device code, 브라우저 PKCE, `/oauth/token`). 아래 "추가" 절 |
| `fakes/transcription.ts` | 음성 입력(02 §3.9)의 받아쓰기 서비스: OpenAI `POST /v1/audio/transcriptions`(multipart, JSON 답)와 Deepgram `POST /v1/listen`(오디오 본문). 키는 `hashSecret`으로, 오디오는 크기만 기록. 답 큐(글자·상태 코드·지연). own-accounts 옵션 `endpoints.openai`에 `openaiBaseURL`, `endpoints.deepgram`에 `deepgramBaseURL` |
| `fakes/search-services.ts` | 내 키로 쓰는 웹 검색 서비스(02 §9.2 SK)의 가짜 다섯: Exa·Firecrawl·Parallel·TinyFish의 MCP(`POST …/mcp`, JSON-RPC `tools/call`, Exa·Firecrawl은 이벤트 스트림, 나머지는 JSON)와 Tavily `POST /search`. core가 키를 두는 자리에 맞는 키가 없으면 401. TinyFish는 실제 서버처럼(v2.0.32 core, 86755e1cea) MCP 세션 안에서만 검색에 답한다: `initialize`가 `Mcp-Session-Id`를 주고, 그 세션으로 `notifications/initialized`를 보내야 `tools/call`이 400이 아니다. 키는 `hashSecret`으로만 기록하고(세션 단계는 `step`, `searchesOf`가 검색만 고른다), 서비스마다의 페이지와 모두가 찾는 `SHARED_PAGE`로 답. `next(service, reply)`로 다음 검색 답 하나를, `next(service, reply, step)`로 TinyFish 세션 단계의 답 하나를 바꾼다. own-accounts 옵션 `endpoints`에 `endpoints`(다섯 주소)를 넣는다. 쓰는 곳: `test/websearch/keyed*.ts`, own-web `e2e/websearch/backend.ts` |
| `fakes/chatgpt-sharing.ts` | Sign in with ChatGPT(토큰 공유) issuer(client 등록, `/api/accounts/oauth/{token,revoke}`, 실제 RSA 키의 JWKS). 아래 "추가" 절 |
| `fixtures/chatgpt-tokens.ts` | 서명 없는 가짜 ChatGPT JWT(id/access)와 refresh token |
| `fixtures/codex-multi-provider.ts` | 옛 앱 control-center 프로필 레이아웃(`state.json`, `profiles/<id>/codex/auth.json`) 생성·갱신 |
| `fixtures/legacy-keys.ts` | 옛 앱이 저장한 API 키 레이아웃(`<tmp>\codex-multi-provider\profiles\{provider.json,deepseek.dpapi}`, `work\control-center\{providers.json,credentials\<id>.dpapi}`). 키 파일은 실제 DPAPI(`seal:"dpapi"`, PowerShell `ProtectedData`, entropy 없음 = 옛 앱 형식, 실제 `own-vault.exe`용) 또는 `Vault.fakeSeal`(`seal:"fake"`, 메모리 vault용). `controlCenter`를 `codexImportRoot`로 넘깁니다(02 §3.2b) |
| `fixtures/catalog-variants/README.md` | 카탈로그 변형(07 PG5·PG6): 번들 models.dev 카탈로그에 편집(추가·바꾸기·이름 변경·삭제)을 얹어 `OPENCODE_MODELS_PATH`로 시작하는 법. 코드는 `index.ts`의 `bundledCatalog`, `catalogVariant`, `GPT_61_SOL` |
| `fakes.test.ts` | fake 단위 테스트(서버 없이) |
| `ledger-alerts.test.ts` | `ledgerAlerts`(ledger 경보 줄 읽기) 단위 테스트: 서버가 쓰는 중인 마지막 줄은 건너뛰고, 다 쓴 줄이 깨졌으면 실패 |
| `timeouts.test.ts` | 실서버를 띄우는 시험 파일(`startOpencodeServer`·`startPresetRig`·`startFakeBench` 호출)마다 `setDefaultTimeout`이 있는지 검사 |
| `smoke.test.ts` | 서버 부팅 → prompt 기록 → `POST /api/session/:id/model`로 전환 → 다음 요청 반영 확인. 그리고 Codex(WS)·Anthropic·DeepSeek fake가 native 패키지와 통신하는지 확인 |

모든 공개 API는 `index.ts`에서 다시 내보냅니다.

## 빠른 예

```ts
import { opencodeConfig, openAIResponsesProvider, startFakeOpenAIResponses, startOpencodeServer } from "./e2e-kit"

const fake = startFakeOpenAIResponses({ cache: { minTokens: 0, blockTokens: 32 } })
await using server = await startOpencodeServer({
  config: opencodeConfig({
    providers: { "fake-a": openAIResponsesProvider(fake, { apiKey: "fake-key-a", models: ["m"] }) },
  }),
})
await server.waitForModels([{ providerID: "fake-a", id: "m" }])
const session = await server.createSession({ model: { providerID: "fake-a", id: "m" } })
fake.enqueue({ type: "text", text: "hello" })
await server.prompt(session.id, "hi")
await server.waitIdle(session.id)
const [request] = await fake.waitForRequests(1)
request.cache?.cachedTokens // 첫 요청이라 0
await fake.stop()
```

## Fake provider

### 공통 (`FakeOptions`)

- `port`(기본 0 = 빈 포트), `hostname`(기본 `127.0.0.1`).
- `clock`: `manualClock()`을 넘기면 TTL, 한도 창, 토큰 만료를 테스트가 움직입니다(`clock.advance(ms)`).
- `cache`: `PromptCacheOptions` 덮어쓰기. 기본값은 실제에 가깝게 잡혀 있습니다(OpenAI·Codex 128토큰 단위, 최소 1024 / DeepSeek 64단위, 최소 64 / Anthropic 최소 1024). 짧은 테스트 프롬프트로 적중을 보려면 `minTokens: 0`과 작은 `blockTokens`를 넘깁니다.
- `credentials`: `{ "<키>": { domain: "org-1" } }`. 주면 모르는 키는 401이고, 같은 domain의 키끼리 캐시와 한도를 공유합니다(같은 org·workspace 모사, AC-P05/P33/P35). 안 주면 비어 있지 않은 아무 키나 받고 키마다 domain은 `hashSecret(키)`입니다.
- `responder(request)`: 큐가 비었을 때 부르는 동적 응답기. `undefined`를 돌려주면 기본 응답(`"ok"` 텍스트).

### 응답 스크립트 (`Reply`)

`fake.enqueue(...replies)`로 모델 요청마다 하나씩(FIFO) 소비됩니다.

| `type` | 동작 |
|---|---|
| `text` | 텍스트 스트림. `outputTokens`, `headers`(응답 헤더 추가), `delayMs`(첫 바이트 전 대기, 세션을 busy로 붙잡을 때), `eventDelayMs`(이벤트 사이 대기), `deltas`(텍스트를 이 수만큼의 delta로 나눔, 기본 1) |
| `tool-call` | 도구 호출 하나(`name`, `input`, 선택 `id`). 같은 pacing 옵션 |
| `error` | 상태 코드와 JSON 본문(`status`, `body`, `headers`). 캐시를 데우지 않음 |
| `stream-error` | 스트림을 시작한 뒤 오류 이벤트로 끝냄(Responses: `response.failed`, Anthropic: `event: error`, chat: `data: {"error":…}`, Codex WS: `response.failed` 프레임) |

#### 연결 실패 (`WireFault`, P1-9b)

연결이나 중간 proxy가 응답을 망가뜨리는 경우입니다. dsh `llm-mock-server`의 실패 목록을 다시 구현했습니다. `codex`(SSE와 WebSocket), `openai-responses`, `openai-chat` fake가 흉내 냅니다. 망가뜨릴 정상 응답(`text` 또는 `tool-call`)은 `reply`에 넣습니다. "delta"는 텍스트 delta와 도구 인자 delta입니다. 그래서 `tool-call` 응답에 `after: 1`을 주면 도구 호출 delta 바로 뒤에서 끊깁니다.

| `type` | 동작 |
|---|---|
| `reset` | 응답 헤더 전에 연결이 끊김(HTTP: `ECONNRESET`). WebSocket은 프레임 하나 없이 소켓이 끊김(close 1006). 캐시를 데우지 않음 |
| `drop` | `reply`를 `after`번째 delta까지 보낸 뒤 연결을 끊음(`after: 0` = 첫 delta 전). WebSocket은 close 프레임 없이 끊음(1006). 끊기 전에는 고정 50ms(`RESET_SETTLE_MS`)를 기다림. `until`(Promise를 돌려주는 함수)을 주면 그 Promise가 끝날 때까지 기다림(실패해도 끊음). 보낸 앞부분이 클라이언트에 닿았는지가 중요한 시험에 씀(예: `switching/wire-failures.e2e.test.ts`의 도구 호출 delta 뒤 끊기 시험은 core가 그 호출의 `session.tool.input.started`를 낸 뒤에 끊음) |
| `eof` | `reply`에서 끝 이벤트만 빼고 정상으로 닫음(Responses: `response.completed`, chat: `finish_reason` chunk와 `[DONE]`). WebSocket은 close 1000 |
| `malformed` | `after`번째 delta 뒤의 이벤트를 반으로 잘라 JSON이 아니게 보내고, 나머지는 그대로 보냄 |
| `ws-close` | Codex WebSocket 전용. `after`번째 delta까지 보낸 뒤 close 프레임(`code`, 기본 1011)을 보냄. HTTP fake는 501 |
| `delayed-listen` | listener를 닫고(이 요청과 열린 연결 모두 끊김) `ms` 뒤 같은 포트에서 다시 엶. 그사이 연결은 거부됨(`ConnectionRefused`) |

- 기록에는 `fault`가 남습니다. 응답 헤더를 보내지 않은 `reset`·`delayed-listen`은 `status`가 0입니다.
- Anthropic fake는 동작을 바꾸지 않고 모든 연결 실패에 501 `not_supported_error`로 답합니다.
- 멈춤(stall)은 없습니다. core의 WebSocket idle timeout이 일부러 30분이라서 시험이 끝나지 않기 때문입니다. 시드 고정 무작위 순서도 없습니다. 시험은 응답을 순서대로 넣습니다.
- core가 받는 오류(실서버 시험 `test/switching/wire-failures.e2e.test.ts`로 확인): 연결 실패·끊김·WebSocket close는 `provider.transport`, 끝 이벤트 없는 HTTP 스트림은 `provider.invalid-output`(incomplete stream)입니다. 둘 다 core가 재시도하고, 출력이 시작된 뒤면 이어 쓰기(continuation)로 갑니다. JSON이 아닌 이벤트는 `provider.invalid-output`이지만 core가 재시도하지 않아 그 턴이 오류로 끝납니다. own-accounts의 판정(`Classify`)은 앞의 것이 `transient`, 뒤의 둘이 `unknown`입니다. 어느 쪽도 전환 계기가 아니므로 소진·전환 제안이 생기지 않습니다. Codex WebSocket slot은 `delayed-listen` 뒤 재연결이 거부되면 그 재시도를 HTTP SSE로 보냅니다.

### 기록 (`RecordedRequest`)

`fake.requests`에 도착 순서대로 모든 요청(거절된 것 포함)이 쌓입니다: `transport`(`http`|`websocket`), `method`(WS 프레임은 `"WS"`, 핸드셰이크는 `GET`/101), `path`(쿼리 포함), `headers`(소문자, 비밀은 해시), `identity`(fake가 판단한 캐시·한도 domain), `body`(원문. `content-encoding: zstd`·`gzip` 본문은 실제 ChatGPT route처럼 풀어서 남기고, 풀 수 없는 본문에는 400으로 답함), `bodyHash`, `json`, `wireBytes`(압축된 본문일 때만, 전송된 바이트 수), `model`, `cache`(`promptTokens`, `cachedTokens`, `writtenTokens`, `promptHash`), `status`, `responseHeaders`, `fault`(연결 실패 응답일 때만).

- `hashSecret("Bearer <key>")`가 기록된 `authorization` 값입니다. `identity`는 키 자체의 해시(`hashSecret("<key>")`) 또는 `credentials`의 domain, Codex는 `codex:<accountID>`입니다.
- `waitForRequests(n, { filter, timeoutMs })`로 비동기 도착을 기다립니다. `reset()`은 기록과 큐만 비우고 캐시는 둡니다(`cache.clear()`로 비움).

### 캐시 모형

- 토큰 수는 `ceil(문자 수 / 4)`로 추정합니다. 실제 토크나이저가 아니므로 **비율과 적중 여부**를 단언하고, 정확한 토큰 수는 단언하지 않습니다.
- 키는 `(domain + "|" + model, prefix 바이트)`입니다. 다른 계정(domain)이나 다른 모델은 적중하지 않습니다.
- Responses·Codex는 `tools`, `instructions`, `input` 항목 순서로 직렬화한 문자열의 prefix를, chat은 `tools`와 `messages`를 비교합니다. 바이트가 하나라도 다르면 그 블록부터 miss입니다.
- Anthropic은 `cache_control`이 붙은 블록에서만 씁니다(5m/1h TTL, breakpoint마다 20블록 lookback). breakpoint 5개 이상, 또는 5m 뒤의 1h는 API처럼 400입니다(AC-P16).
- 요청이 거절되면(401/429/`error` 응답) 캐시에 쓰지 않습니다.
- **알아 둘 사실**: 같은 계정이라도 providerID가 바뀌면 upstream Identity 플러그인이 `instructions`에 `- Provider ID: …`를 넣으므로 그 지점부터 prefix가 갈라집니다(스모크에서 같은 Codex 계정의 http→ws providerID 전환이 6748토큰 중 3888만 적중). 01 §8.1의 "provider = 캐시 도메인" 근거가 그대로 재현됩니다.

### Codex (`startFakeCodex`)

- `login({ accountID, plan?, email? })` → `ChatGPTTokens`(`accessToken`, `refreshToken`, `idToken`, `accountID`, `expiresAt`). 가짜 JWT의 클레임 모양은 실제와 같습니다(`https://api.openai.com/auth.chatgpt_account_id` 등).
- 요청은 `Authorization: Bearer <access>`와 `chatgpt-account-id`가 필요합니다(없으면 400, 불일치 403, 만료·폐기 401). `models`로 허용 모델을 제한할 수 있습니다.
- 한도: 요청마다 `usagePerRequest`(기본 primary 1, secondary 0.1 퍼센트포인트)를 더하고 `x-codex-primary-used-percent`, `-window-minutes`(300), `-reset-at`(epoch 초), `-reset-after-seconds`, `secondary-*`(10080), `x-codex-credits-*`를 돌려줍니다. `setUsage(accountID, { primary: 99 })`로 소진 직전을 만들고, 100%면 429 `{"error":{"type":"usage_limit_reached","resets_in_seconds":…}}`와 `x-codex-rate-limit-reached-type`을 냅니다. 창은 `clock`으로 리셋됩니다.
- WebSocket: `websocketURL`로 `response.create` 프레임을 받으면 `codex.rate_limits` 프레임 다음에 Responses 이벤트 프레임을 보냅니다. 소진 시 `{"type":"error","status":429,"error":{…}}` 프레임입니다. config에서 `transport: "websocket"`이면 upstream이 이 경로를 씁니다.
- OAuth: `tokenURL`(`POST /oauth/token`, form 또는 JSON, `grant_type=refresh_token`)과 같은 동작의 `refresh(rt)`. 한 번 쓴 refresh token을 다시 쓰면 401 `refresh_token_reused`이고, 기본으로 그 token family 전체가 폐기됩니다(`revokeFamilyOnReuse`). `refreshCount(accountID)`로 단일 refresher(AC-P20)를 단언합니다. `/oauth/token` 요청 본문의 토큰 값도 기록에서는 해시로 바뀝니다.
- `events(body)`: HTTP 요청에 Responses 이벤트를 그대로 흘려 답합니다. 이벤트를 돌려주면 사용량을 더하고 한도 헤더를 붙인 뒤 그 이벤트를 SSE로 보내고(큐의 답은 쓰지 않음), `undefined`면 평소대로 답합니다. 대본 답(`Reply`)으로 만들 수 없는 hosted `web_search_call` 항목을 own의 ChatGPT 웹 검색 시험(`test/websearch/`)이 이것으로 보냅니다.
- ⚠ 추정 모양: `usage_limit_reached` 본문, WS 오류 프레임, `refresh_token_reused` 오류 본문은 공개 소스 기반 근사입니다. G7/G8 실계정 캡처로 확인되면 여기서 맞춥니다.

### Anthropic (`startFakeAnthropic`)

- 인증: `x-api-key` 또는 `Authorization: Bearer`(구독 OAuth). `anthropic-version` 헤더와 `max_tokens`가 없으면 400.
- usage: `message_start`/`message_delta`에 `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_{5m,1h}_input_tokens`.
- 표준 한도 헤더 `anthropic-ratelimit-{requests,input-tokens,output-tokens,tokens}-{limit,remaining,reset}`(RFC3339). `setUnified(domain, {...})`로 구독 슬롯의 `anthropic-ratelimit-unified-*`를 붙이고, `status: "rejected"`면 429 `rate_limit_error`.

### DeepSeek 방언 chat (`startFakeOpenAIChat`)

- usage: `prompt_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `prompt_tokens_details.cached_tokens`(64토큰 단위).
- `GET /user/balance` → `{is_available, balance_infos:[…]}`. `setBalance(domain, { available, currency, total })`.
- `native`: 로컬 서버의 고유 엔드포인트(`"POST /api/show"`, `"GET /api/version"`, `"GET /props"` 등)를 요청 JSON 본문의 함수로 답합니다. compat 서버 읽기(02 §3.3) 시험이 Ollama·llama.cpp인 척할 때 씁니다.

## Harness (`startOpencodeServer`)

- 실행: `bun --config=packages/cli/bunfig.toml packages/cli/src/index.ts serve --stdio --port 0`. CLI가 TUI 모듈을 import하므로 CLI의 Solid JSX preload가 든 bunfig를 지정합니다. `--stdio`는 준비되면 stdout에 `{"url":…}`를 한 줄 쓰고, **stdin이 닫히면 스스로 종료**합니다.
- 격리: 임시 루트 아래에 `HOME`/`OPENCODE_TEST_HOME`, `OPENCODE_CONFIG_DIR`(여기에 `opencode.jsonc`를 씀), `XDG_{DATA,STATE,CACHE,CONFIG}_HOME`, `OPENCODE_DB`, `LOCALAPPDATA`/`APPDATA`(플러그인 기본 `OWN_HOME`이 실제 경로가 되지 않게), 작업 디렉터리 `workspace`(세션 Location, 자식 cwd)를 둡니다. `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_FILEWATCHER`, 그리고 기본으로 `OPENCODE_DISABLE_PROJECT_CONFIG`를 켭니다(임시 디렉터리에서 위로 올라가면 개발자의 실제 홈에 닿기 때문). 프로젝트 config·`.opencode/plugins`가 필요한 테스트(G18)는 `projectConfig: true`와 `workspaceFiles`를 씁니다.
- 인증: 서버 비밀번호를 무작위로 만들어 `OPENCODE_PASSWORD`로 넘기고, 요청마다 `Authorization: Basic opencode:<password>`와 `x-opencode-directory: <workspace>`를 붙입니다.
- 준비: ready 줄 → `GET /api/info` 200까지 기다립니다. 두 단계 모두 `startupTimeoutMs`(기본 170초)까지 기다립니다. 모델 목록 첫 스냅샷은 플러그인 정착보다 먼저 올 수 있으므로 `waitForModels(refs)`를 먼저 부릅니다.
- 편의 메서드: `createSession({ model, title, directory })`(제목을 주면 title 생성 요청이 나가지 않아 기록이 primary 요청만 남습니다), `prompt(id, text, { delivery })`, `switchModel(id, ref)`(`POST /api/session/:id/model`), `waitIdle(id)`(`POST /api/experimental/session/:id/wait`), `messages(id)`(최신이 먼저), `models()`, 그리고 임의 호출용 `request()`/`call()`. `logs()`는 서버 stdout·stderr(`OPENCODE_PRINT_LOGS=1`)입니다.
- 종료(`stop()` 또는 `await using`): stdin을 닫아 정상 종료를 기다리고, 10초 안에 안 끝나면 Windows에서는 `taskkill /T /F`로 프로세스 트리를 끝냅니다. 그다음 임시 루트를 재시도하며 지웁니다(SQLite 파일 잠금 대비). `root`를 넘겨 같은 DB로 재시작할 수 있고, 이때 루트는 지우지 않습니다.
- 카탈로그: `models`에 models.dev 카탈로그 파일(`api.json` 모양)을 주면 번들 스냅샷 대신 그것으로 시작합니다(`OPENCODE_MODELS_PATH`). core는 이 파일을 처음 필요할 때 한 번 읽고, 모델 받기가 꺼져 있으므로 다시 읽지 않습니다. 카탈로그를 바꾸는 시험은 다른 파일을 쓰고 같은 `root`로 서버를 다시 띄웁니다(아래 프리셋 rig의 `restart`). 변형을 만드는 법은 `fixtures/catalog-variants/README.md`입니다.

## 이후 단계에서 쓰는 법

### own-accounts·own-telemetry 플러그인 올리기

```ts
const buildId = "e2e-my-test" // 두 플러그인이 같은 runtime 싱글턴을 쓰도록 같은 값
const server = await startOpencodeServer({
  env: { OWN_OPEN_CODE: "1" }, // 가드 1(01 §5.4). 없으면 own-accounts는 health만 등록한다
  // 함수로 넘기면 임시 경로를 참조할 수 있다
  config: (paths) =>
    opencodeConfig({
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId,
            vault: "memory", // 테스트 전용: 암호화 없는 메모리 vault
            endpoints: { codex: codex.baseURL, oauthIssuer: codex.url, openai: responses.baseURL, anthropic: anthropic.baseURL, deepseek: chat.baseURL },
            codexImportRoot: legacyRoot, // 가짜 control-center (실제 옛 앱 프로필 금지)
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome, buildId } },
      ],
      providers: {},
    }),
})
```

- config의 `plugins` 항목은 **디렉터리** 절대 경로만 받습니다(파일 경로는 경고 후 무시, `core/src/config/plugin/source.ts`). 이름 없는 디렉터리 플러그인은 package.json exports가 아니라 그 디렉터리의 `server.*` 또는 `index.*`를 서버 진입점으로 찾습니다(`plugin/src/host.ts`). 패키지 루트의 `server.ts`가 `src/index.ts`를 다시 내보내므로 `packages/own-accounts`(02 §8.2의 개발 설정)와 `packages/own-accounts/src` 둘 다 됩니다. `plugins` 순서가 훅 등록 순서입니다.
- `OWN_HOME`은 반드시 플러그인 옵션 `home`으로 임시 디렉터리를 줍니다(`paths.ownHome`, harness가 빈 디렉터리로 만들어 둠). 자식의 `LOCALAPPDATA`도 임시 경로라서 옵션을 빠뜨려도 실제 `%LOCALAPPDATA%own-open-code`에는 닿지 않습니다.
- 옵션 전체는 `packages/own-accounts/src/options.ts`, endpoint 기본값은 `src/endpoints.ts`에 있습니다. `endpoints`로 덮은 provider URL은 slot의 정적 `settings.baseURL`에도 들어가고, `oauthIssuer`는 device code·PKCE·`/oauth/token` 루트입니다. 운영 기본값은 실제 endpoint입니다.
- 플러그인을 올리는 예는 `packages/own-accounts/test/plugin.test.ts`에 있습니다(가드 통과/실패 두 서버).
- 인증 주입(G2/AC-P01)은 기록된 `headers.authorization`/`x-api-key`를 `hashSecret(...)`과 비교하고, 계정 간 혼입이 없음을 `identity`로 확인합니다.

### Codex 로그인 가져오기 (linked / takeover)

```ts
const codex = startFakeCodex()
const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-legacy-"))
const [profile] = await writeCodexMultiProviderProfiles(root, [
  { alias: "work", tokens: codex.login({ accountID: "acct-1" }) },
])
// own-accounts에 control-center 경로로 root를 넘겨 가져오기 실행
```

- **linked**: own-accounts는 원본을 쓰지 않고 스스로 refresh하지 않아야 합니다. 옛 앱의 refresh를 흉내 내려면 `const next = codex.refresh(oldRefreshToken)` 후 `updateCodexMultiProviderAuth(profile, next.tokens)`를 부릅니다(temp→rename). 실제 Codex CLI는 `auth.json`을 제자리에서 truncate 후 다시 씁니다(`codex-rs/login/src/auth/storage.rs`). 그래서 읽는 쪽이 반쯤 쓴 파일을 볼 수 있습니다. 이 경우는 네 번째 인자 `{ torn: true }`로 흉내 내고, 그다음 한 번 더 정상으로 씁니다(linked reader는 그동안 마지막 정상 토큰을 씁니다). 단언: 다음 요청의 `authorization`이 새 access token 해시로 바뀜, `codex.requests`에 own 쪽 `/oauth/token` 호출이 0건, 원본 `auth.json` 바이트가 own에 의해 바뀌지 않음. 401 뒤 재읽기는 `clock.advance`로 토큰을 만료시켜 확인합니다(`accessTokenTtlMs`).
- **takeover**: own이 vault로 토큰을 복사하고 단일 refresher가 됩니다. own이 `tokenURL`로 refresh하면 `refreshCount`가 1 오르고, 이후 옛 프로필의 refresh token으로 `codex.refresh(...)`를 부르면 `refresh_token_reused`가 되고 family가 폐기됩니다. UI가 경고할 "옛 앱 프로필 재로그인 필요" 상태가 이것입니다.

### 옛 앱이 저장한 API 키 연결 (linked 전용, 02 §3.2b)

```ts
const app = await createLegacyApp(root)                       // <root>\codex-multi-provider\…
const file = await writeLegacyDeepSeek(app, { key: "sk-fake-…", seal: "dpapi" }) // 실제 exe면 "dpapi", 메모리 vault면 "fake"
// own-accounts 옵션: codexImportRoot: app.controlCenter, vault: { exePath: <own-vault.exe> } 또는 "memory"
await replaceLegacyKey(file, "sk-fake-next-…", "dpapi")      // 옛 앱의 키 교체(원자 교체 + mtime 이동)
```

- own-accounts는 이 파일을 읽기만 합니다. 단언: 요청의 `authorization`이 `hashSecret("Bearer <키>")`, 교체 뒤 다음 요청이 새 키, 삭제 뒤에도 파일 바이트 불변, `OWN_HOME`·로그·RPC 출력·이벤트에 키 없음. 예: `test/credentials/legacy-import.test.ts`(메모리), `legacy-import.e2e.test.ts`(실제 exe, PowerShell이 없거나 exe가 빌드되지 않았으면 건너뜀).
- 키는 가짜만 씁니다. PowerShell에는 환경 변수로 넘기고 명령줄에 두지 않습니다.

### 한도·retry·전환 시나리오

- 소진: `codex.setUsage("acct-1", { primary: 100 })` → 다음 요청 429(HTTP) 또는 오류 프레임(WS). 리셋: `clock.advance(5 * 60 * 60_000)`.
- busy 세션(AC-P26 steer/queue): `fake.enqueue({ type: "text", text: "…", delayMs: 3000 })`로 턴을 붙잡고 그사이 `prompt`/`switchModel`을 보냅니다.
- 캐시 동등성(G4): 두 요청의 `cache.promptHash`와 `cachedTokens / promptTokens`를 비교합니다. 같은 org 풀링은 `credentials`의 같은 domain으로 모사합니다.
- 교차 provider(G5): 스모크 두 번째 테스트처럼 한 세션에서 `switchModel`을 이어 가며 각 fake의 `body`에 이전 턴이 재생되는지 봅니다.
- 연결 실패(P1-9b): `fake.enqueue({ type: "drop", reply: { type: "text", text: "…", deltas: 2 }, after: 1 }, { type: "text", text: "다음 답" })`. 예는 `test/switching/wire-failures.e2e.test.ts`입니다. own slot 네 개(Codex WebSocket, Codex SSE, `oai`, `ds`)에서 실패마다 같은 slot이 다음 응답으로 턴을 끝내는지, 소진·전환 제안이 없는지, 도구 호출 delta 뒤에서 끊겨도 도구가 한 번만 실행되는지 확인합니다. core 재시도 간격(2초부터) 때문에 약 2분 걸립니다.

## 알려진 한계

- 토큰 수는 추정치입니다. usage 숫자의 절대값은 단언하지 마십시오.
- thinking 서명 재생 검증, `encrypted_content`의 org 검사, compaction endpoint(`/responses/compact`)는 아직 없습니다. 필요한 단계에서 `fake-server.ts`의 `handle`에 경로를 더합니다.
- Anthropic `?beta=true` 쿼리는 무시하고 받습니다. OpenRouter·xAI 전용 fake는 없고, 필요하면 `openai-chat`/`openai-responses`를 기반으로 추가합니다.

## 추가: ChatGPT OAuth issuer (`startFakeChatGPTAuth`, CREDENTIALS 단계)

`fakes/chatgpt-auth.ts`. 위 "알려진 한계"의 device-code 항목은 이 fake로 채웠습니다.

- `startFakeChatGPTAuth({ codex })`: `auth.openai.com` 흉내. own-accounts 옵션 `endpoints.oauthIssuer`에 `auth.url`을 줍니다. 토큰은 넘긴 fake Codex의 `login()`으로 만들고 refresh는 `codex.refresh()`로 넘기므로, 여기서 로그인한 토큰이 그 Codex fake에서 그대로 통하고 `codex.refreshCount`에도 잡힙니다.
- device code: `POST /api/accounts/deviceauth/usercode {client_id}` → `{device_auth_id, user_code, interval}`(기본 interval `"1"`). `POST /api/accounts/deviceauth/token`은 사용자가 끝내기 전까지 403, `auth.approve(userCode, account)` 뒤 200 `{authorization_code, code_verifier}`, `auth.deny(userCode)` 뒤 400. `auth.userCodes`에 발급 순서대로 쌓입니다.
- 브라우저 PKCE: `auth.authorize(authorizeURL, account)`가 브라우저 역할을 해서 콜백 URL(`redirect_uri?code=…&state=…`)을 돌려줍니다. 테스트는 그 URL을 `fetch`해서 own-accounts의 콜백 서버를 부릅니다.
- `POST /oauth/token`: `authorization_code`(device는 서버가 준 verifier, 브라우저는 S256 challenge 검사, `redirect_uri` 일치, 코드 1회용)와 `refresh_token`(Codex fake와 같은 회전·재사용 규칙). `client_id`는 upstream 값 `app_EMoamEEZ73f0CkXaXp7hrann`이어야 합니다(`CHATGPT_CLIENT_ID`). `exchangeCount()`는 코드 교환 횟수입니다.
- 기록에서 code, verifier, refresh token, device id, user code는 `hashSecret`로 바뀝니다.
- 사용 예: `test/credentials/chatgpt.test.ts`(device·browser 로그인, refresher), `test/credentials/codex-import.test.ts`(takeover의 강제 refresh), `test/credentials/import.e2e.test.ts`(실서버).
- `issued`: `/oauth/token`이 내준 토큰 묶음(교환·refresh) 전부. 서버 로그·RPC 출력·이벤트·`OWN_HOME`에 비밀이 없는지 검사할 때 씁니다.

## 추가: Sign in with ChatGPT issuer (`startFakeChatGPTSharing`, 02 §3.2c)

`fakes/chatgpt-sharing.ts`. own-accounts 옵션 `endpoints.oauthIssuer`에 `sharing.url`을 줍니다. ID token의 `iss`가 이 origin이므로 검증이 실제처럼 통과합니다.

- `sharing.authorize(authorizeURL, { sub, email, plan? }, options?)`: 브라우저 역할. authorize 파라미터(`ext_agent_host_id`, `nonce`, `state`, S256, `resource`, sharing scope)를 검사하고, `client_id=dynamic_agent_client`면 새 client(`oaiapp_…`)를 등록해 콜백 URL(`code`, `state`, `client_id`, `scope`)을 돌려줍니다. `options.clientID`(다른 id, `null`이면 생략), `grantSharing:false`(scope에서 `chatgpt.tokens.use.direct` 뺌), `error`(사용자가 거절. `errorNamesClient:true`면 거절 콜백에도 등록된 `client_id`를 붙임). 받은 쿼리는 `authorizations`, 등록된 id는 `clients`에 쌓입니다.
- `POST /api/accounts/oauth/token`: `resource=https://api.openai.com/v1`이 없으면 400 `invalid_target`, 등록되지 않은 client는 401 `invalid_client`. `authorization_code`는 client·redirect·PKCE를 검사하고 nonce가 든 서명된 ID token을 줍니다. `refresh_token`은 회전하고, 쓴 토큰을 다시 쓰면 400 `refresh_token_reused`로 계열을 끝냅니다. 옵션 `earliestRefreshAt(now)`, `omitRefreshScope`, `accessTtlMs`, `refreshIdToken(user)`(refresh 응답에 돌려준 사용자의 새 ID token을 실음. 다른 사용자를 돌려주면 identity 검사 시험). `refreshCount(clientID)`, `expire(clientID)`(이후 `invalid_grant`), `failToken(n, status)`.
- `POST /api/accounts/oauth/revoke`: 기록(`revocations`, 토큰은 해시)하고 그 계열을 끝냅니다. `failRevoke(n)`이면 n번 503.
- `GET /.well-known/jwks.json`: 2048비트 RSA 공개 키. `failJwks(n)`이면 n번 503. `signIDToken(claims, { forged? })`로 검증 행렬용 토큰을 만듭니다(`forged`는 key set에 없는 키).
- OpenAI Responses fake의 `sharingModels`를 주면 `GET /v1/models`가 `{models:[…]}` 모양(그대로, 깨진 항목 포함 가능)을 돌려줍니다. `sharingError(code, { stream? })`는 코드별 상태(`SHARING_ERROR_STATUS`)의 오류 응답 또는 `response.failed` 스트림입니다.
- 사용 예: `test/credentials/sharing.test.ts`, `test/credentials/siwc.test.ts`, `test/credentials/sharing.e2e.test.ts`(실서버).

## 통합 E2E (`test/integration/e2e.test.ts`)

두 플러그인을 패키지 디렉터리로 올리고 opencode config에는 provider를 하나도 두지 않습니다. provider는 전부 own.accounts RPC로 만듭니다(`oai` 키 2개, device 로그인 codex 1개, linked 가져오기 codex 1개). 한 세션이 `switch.estimate`/`switch.apply`로 Alpha → Bravo → Alpha → Device → Linked로 옮겨 가며 요청마다 그 계정의 자격 증명, Alpha 복귀의 캐시 적중, `quota.snapshot`, `ledger.session`(`coldExpected` 포함), 이벤트 스트림의 `flap` 경보, 비밀 비노출(로그·RPC 출력·이벤트·`OWN_HOME` 파일)을 확인합니다. 전역 메서드는 control location(`<OWN_HOME>/control`, 테스트가 만듦)으로, 세션 메서드는 작업 디렉터리로 보냅니다(02 §9.1). 그래서 own.accounts 인스턴스 두 개(leader = control)가 runtime 하나를 나눠 씁니다.

## 프리셋 rig (`startPresetRig`, 07 §8.4)

`index.ts`의 `startPresetRig(options)`. own-accounts를 패키지 디렉터리로 실제 서버에 올리고 프리셋 시험에 필요한 것을 미리 깝니다. 자격 증명은 모두 가짜이고 실제 옛 앱 프로필과 이 PC의 `.codex`는 읽지 않습니다.

- **연결한 ChatGPT 계정**: `chatgpt: [{id, tokens}]`마다 가짜 codex-multi-provider 프로필(`writeCodexMultiProviderProfiles`)을 만들고 `accounts.json`에 linked `codex` 계정(slug `pg<id>`, 라벨 `ChatGPT <id>`)으로 넣습니다. 모두 넘긴 가짜 Codex backend 하나(`codex`)에서 답합니다.
- **`siwc` 계정**: `siwc: [{slug, login}]`는 레지스트리에만 둡니다. `login`이 `{of: "<id>"}`면 그 연결 계정과 같은 ChatGPT 로그인, 문자열이면 다른 로그인입니다. R4(07 §5.4)가 로그인을 읽을 뿐 이 계정으로는 요청을 보내지 않습니다.
- **서비스 등록 파일**: `own.preset` 안내문 항목을 쓰는 writer가 읽는 `service-local.json`(`ServiceTarget.registrationPath("local")`, 서버의 `XDG_STATE_HOME` 아래)을 서버 URL과 비밀번호로 씁니다(06 §2.6 자기 HTTP).
- **RPC 위치**: 기본으로 `rig.rpc(method, input)`·`rig.call(...)`은 모두 작업 디렉터리 Location으로 갑니다. 그 Location의 own.accounts 인스턴스가 하나뿐이라 `presets.json`을 쓰는 runtime leader이기도 합니다. `control: true`면 control Location(`<OWN_HOME>\control`)도 띄우고 클라이언트처럼 나눠 보냅니다(`OwnAccounts.MethodLocation`: 전역 메서드는 control, 세션 메서드는 작업 디렉터리, 02 §9.1). 그때는 control 인스턴스가 leader이고, 고정 템플릿 diff를 쓰고 Codex 메타데이터를 받는 곳도 그 인스턴스입니다(07 §4.4, §4.5). 카탈로그 변화나 메타데이터를 보는 시험(PG5, PG6)은 `control: true`를 씁니다.
- **카탈로그와 Codex 메타데이터**: `catalog`(`bundledCatalog()`와 `catalogVariant(base, edits)`로 만든 변형, `OPENCODE_MODELS_PATH`)로 시작하고, `codexMeta`(스냅샷)를 `OWN_HOME\codex-meta.json`에 미리 둡니다(전에 받아 둔 것처럼). 가짜 Codex backend에는 모델 목록이 없어서 시작할 때의 받기는 404로 실패하고 저장된 값이 남습니다(07 §4.5 "실패하면 마지막 값"). `codexMetaFixture()`는 `test/slots/fixture/codex-models.json`(07 부록 A의 새 번들 모양)을 받아 둔 스냅샷으로 돌려줍니다. `GPT_61_SOL`은 번들 카탈로그에 없는 gpt-6.1-sol을 더하는 편집입니다.
- **`setCodexMeta(snapshot)`**: 실행 중인 서비스 옆에서 다른 프로세스처럼(임시 파일 → 이름 바꾸기) `codex-meta.json`을 씁니다. 서비스의 저장소 감시가 받아 provider를 다시 접습니다. `undefined`면 지웁니다.
- **`restart({catalog?, codexMeta?, models?})`**: 서버를 멈추고 같은 임시 루트(DB, OWN_HOME, ledger, 세션)로 다시 띄웁니다. 카탈로그 파일은 한 프로세스에 한 번만 읽히므로 카탈로그 변화는 재시작으로 흉내 냅니다. 재시작 뒤 `rig.server`·`rig.events`는 새 서버의 것이고 서비스 등록 파일도 새 비밀번호로 다시 씁니다. 메모리 vault의 API 키는 재시작으로 사라지므로 API 키 계정은 `accounts.update{replaceKey}`로 다시 넣습니다. 수리 알림은 "모델 사건마다 한 번"을 프로세스 메모리로 기억하므로 재시작은 아직 없어진 모델을 한 번 더 알립니다(T2.17 결정). 시험은 재시작마다 사라진 모델을 바꿔 셉니다.
- 그 밖: `events`(세션보다 먼저 구독한 이벤트 기록), `kv(key)`(own-accounts plugin storage 값), `alerts(code)`(`OWN_HOME/ledger`의 경보 줄, 재시작을 넘어 누적. 서버가 쓰는 중인 마지막 줄은 건너뜀. rig 밖에서는 `ledgerAlerts(home, code)`), `accounts`(ChatGPT id나 `siwc` slug → `{id, providerID}`), `endpoints`·`config`(DeepSeek 같은 다른 endpoint와 opencode config 덧붙이기).
- **`plugins`, `watchConfig`**: `plugins`는 own-accounts 뒤에 올릴 로컬 플러그인 디렉터리입니다. `WEBSEARCH_FIXTURE_PLUGIN`(`fixtures/websearch-plugin`)은 네트워크 없이 답하는 검색 서비스 `fake-search`를 더합니다(실제 서비스 목록은 그대로 있으니 시험이 이것을 고릅니다). `fake-search`에는 같은 id의 integration과 키 방식이 있어 시험이 가짜 키를 넣고 `websearch.get`의 `keys`를 볼 수 있습니다. 옵션 `parallel: true`면 core의 키 없는 `parallel`도 같은 id·이름의 메모리 답으로 바꿉니다(질의에 `[empty]`가 있으면 결과 0개, upstream #54311의 모양). 그래서 키 없는 무료 서비스의 카드와 안내를 네트워크 없이 볼 수 있습니다(own-web `e2e/websearch`). `watchConfig: true`는 harness가 끈 core 파일 감시를 다시 켜서, 설치된 서비스처럼 전역 `opencode.jsonc` 쓰기(`websearch.set` 등)가 바로 다시 읽히게 합니다. 쓰는 곳: `test/switching/approval-switch.e2e.test.ts`, `test/websearch/services.e2e.test.ts`(`chatgpt: []`, 가짜 chat의 `native`로 DeepSeek Search API를, `endpoints.brave`로 가짜 Brave를 둠), own-web `e2e/websearch/backend.ts`.
- 쓰는 곳: `test/presets/pg2.e2e.test.ts`, `pg4.e2e.test.ts`, `pg5.e2e.test.ts`(카탈로그 변형과 재시작, `control`), `pg6.e2e.test.ts`(메타데이터 전후의 압축 기준, `control`), `pg10.e2e.test.ts`, `pg11.e2e.test.ts`, 그리고 PG3 실행기 `test/pg3/`(`delegation-ab.ts --fake`, `bun test test/pg3`).
