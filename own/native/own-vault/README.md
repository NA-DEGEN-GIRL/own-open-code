# own-vault

own-open-code의 비밀 저장소 helper입니다. 계정 비밀(API 키, OAuth 토큰 묶음)을 Windows DPAPI(CurrentUser)로 암호화해 `OWN_HOME\vault\`에 파일 하나씩 저장합니다. `@own/runtime`의 vault client가 프로세스마다 이 helper를 장수 자식 프로세스 하나로 띄우고 stdin/stdout JSON-lines로 요청합니다.

근거: 01 §13.1(결정), 01 §5.1(설치 레이아웃), 02 §2.3·§2.4.5(파일·entropy·프로토콜), 02 §3.5 F1–F7(refresh·lease·persist-before-use·삭제), 02 AC-P21(검증 항목).

**이 문서가 wire 계약입니다.** TS client(`packages/own-runtime`)는 이 문서를 따릅니다. 바꿀 때는 `PROTOCOL` 번호(`src/lib.rs`)와 이 문서를 함께 고칩니다.

하지 않는 일: 네트워크, 로깅(stdout은 응답 전용, stderr는 시작 실패 때만), argv·env로 비밀 받기, vault 디렉터리 밖의 파일 쓰기, 토큰 refresh(HTTP는 TS 쪽). vault 밖 파일을 **읽는** 예외는 하나뿐입니다: `linked.get`이 이전 앱(codex-multi-provider)이 저장한 API 키 파일을 허용 목록 위치에서만 읽기 전용으로 복호화합니다(5.3, 02 §3.2b).

---

## 1. 빌드와 산출물

```powershell
# 저장소 루트에서 (FORK.md §8.2와 같은 명령)
cargo build --release --locked --manifest-path own/native/own-vault/Cargo.toml
# → own/native/own-vault/target/release/own-vault.exe   (설치 시 app\<ver>\own-vault.exe)

cargo test  --locked --manifest-path own/native/own-vault/Cargo.toml
cargo clippy --all-targets --locked --manifest-path own/native/own-vault/Cargo.toml
```

- Windows 전용입니다(다른 플랫폼은 `compile_error!`). 원격 Linux backend(01 §11)는 같은 프로토콜로 따로 만듭니다.
- 의존성: `windows` 0.62(`CryptProtectData`/`CryptUnprotectData`, `MoveFileExW`, `OpenProcess`), `serde`, `serde_json`. 라이선스 목록은 `THIRD_PARTY.md`.
- `build.rs`가 hybrid CRT로 링크합니다(VC runtime 정적, UCRT는 OS 구성요소). 그래서 `VCRUNTIME140.dll`(Visual C++ 재배포 패키지)이 없는 PC에서도 실행됩니다.
- 실행 파일은 약 330 KB이고, 시작은 수 ms입니다.

## 2. 실행

```text
own-vault.exe --home <OWN_HOME>      # vault 디렉터리 = <OWN_HOME>\vault
own-vault.exe --vault-dir <DIR>      # vault 디렉터리를 직접 지정 (테스트용)
own-vault.exe --version              # "own-vault 0.2.0 (protocol 1)"
```

- 플래그가 없으면 환경 변수 `OWN_HOME`을 봅니다. 그것도 없으면 종료 코드 2입니다. 운영(`%LOCALAPPDATA%\own-open-code`)과 개발(`…-dev`, 02 §2.3) vault가 섞이지 않게 기본값을 두지 않습니다.
- 경로는 절대 경로여야 합니다(아니면 종료 코드 2). 디렉터리가 없으면 만듭니다.
- 종료 코드: `0` stdin EOF로 정상 종료, `1` vault 디렉터리를 열 수 없음 또는 stdio 오류(stdout 파이프가 끊김 등), `2` 인자 오류.
- **환경 변수가 필요 없습니다.** 빈 env로도 DPAPI가 동작합니다(검증함). client는 `env: { SystemRoot }`만 넘기기를 권장합니다(01 §13 "최소 env").
- 수명: runtime 싱글턴이 프로세스당 하나를 띄우고, 참조 카운트가 0이 되면 stdin을 닫아 끝냅니다. 서버가 `TerminateProcess`로 죽어도 파이프가 닫혀 helper는 EOF를 받고 스스로 끝납니다. helper가 죽으면 client가 다시 띄웁니다. 상태는 전부 파일에 있으므로 재시작해도 잃는 것이 없습니다.
- 시작할 때 10분보다 오래된 `*.tmp`(죽은 writer의 잔여물, DPAPI blob이라 평문 아님)를 지웁니다.

## 3. 파일 레이아웃 (`OWN_HOME\vault\`)

| 파일 | 내용 | 쓰는 주체 |
|---|---|---|
| `<id>.dpapi` | 현재 비밀. raw DPAPI blob | helper `put` |
| `<id>.dpapi.prev` | 직전 비밀. `put{keepPrev:true}`가 교체 직전 값을 복사해 둠(F4) | helper `put` |
| `<id>.lock` | refresh lease `{"pid":…,"startedAt":…,"until":…}` 평문 JSON(비밀 아님, F3) | helper `lease.acquire`/`lease.release` |
| `.own-vault.mutex` | 모든 변경 작업을 프로세스 사이에서 직렬화하는 락 파일. 내용 없음, 지우지 않음 | helper |
| `<name>.<pid>.<n>.tmp` | 쓰는 중인 임시 파일 | helper |

- `<id>`는 계정 id입니다(`acc_<ulid>`, 02 §2.4.1). 허용 형식은 `[A-Za-z0-9_-]{1,128}`이고 DOS 장치 이름(`CON`, `NUL`, `COM1` 등)은 거부합니다. 경로 조작(`..`, `/`, `\`, `.`)은 형식 검사로 막힙니다.
- **`.lock`과 vault 파일은 helper를 거쳐서만 다룹니다.** TS가 직접 `open(path,"wx")`로 lease를 만들면 helper의 뮤텍스 밖에서 경합이 생깁니다(6장).

## 4. 암호화

- `CryptProtectData(plain, szDataDescr = NULL, pOptionalEntropy = entropy, flags = CRYPTPROTECT_UI_FORBIDDEN)`, 범위는 CurrentUser(`CRYPTPROTECT_LOCAL_MACHINE` 없음).
- **entropy = UTF-8 바이트 `"own-open-code/v1/" + <id>`**. 02 §2.4.5와 01 §13 표·§13.1이 모두 이 값입니다(12장 Q15는 `/` 쪽으로 정리됨). blob은 계정 id에 묶이므로 파일을 다른 id 이름으로 복사하면 `decrypt_failed`가 납니다.
- 파일 내용은 **헤더 없는 raw DPAPI blob**입니다. .NET `ProtectedData.Protect(bytes, entropy, CurrentUser)`와 바이트 형식이 같아서 서로 읽습니다(PowerShell 교차 읽기 테스트 있음, AC-P21).
- 평문은 `put`의 `value` 문자열을 UTF-8로 인코딩한 바이트입니다. 복호화 결과가 UTF-8이 아니면 `decrypt_failed`입니다.
- 복호화한 평문 버퍼와 요청 줄 버퍼는 사용 뒤 0으로 지웁니다(best-effort. 파이프 버퍼와 allocator 사본까지는 지우지 못함).

## 5. 와이어 프로토콜

### 5.1 framing

- 요청: stdin에 **UTF-8 JSON 객체 한 줄**(`\n` 종료, `\r\n` 허용). 빈 줄은 무시합니다(응답 없음).
- 응답: 요청마다 stdout에 **JSON 객체 한 줄**. **요청 순서대로** 하나씩 나옵니다. helper는 요청을 순차 처리합니다.
- 줄 길이 상한 2 MiB(넘으면 그 줄을 버리고 `bad_request`), `value` 상한 256 KiB(UTF-8 바이트).
- 모르는 필드는 무시합니다(전방 호환). boolean 필드는 `true`/`false`이거나 생략해야 합니다(`null`이면 `bad_request`).

### 5.2 공통 필드

| 요청 필드 | 뜻 |
|---|---|
| `op` | 필수. `hello` `get` `put` `delete` `list` `lease.acquire` `lease.release` `linked.get`(0.2.0부터) |
| `rid` | 선택. 아무 JSON 값. 응답에 그대로 `rid`로 돌아옵니다. 단조 증가 정수를 권장(7장) |

| 응답 필드 | 뜻 |
|---|---|
| `ok` | 항상 있음. `true`/`false` |
| `rid` | 요청에 `rid`가 있었으면 그대로 |
| `error` | `ok:false`일 때 오류 코드(5.4) |
| `message` | 선택. 사람이 읽는 설명. **비밀 값을 담지 않습니다**(잘못된 타입의 문자열 값도 되돌려 쓰지 않음) |

JSON 키 순서는 의미가 없습니다(현재 구현은 알파벳 순으로 냅니다).

### 5.3 연산

#### `hello` — 버전·상태 확인 (health의 `vaultBackend`, 02 §9)

```json
→ {"op":"hello","rid":1}
← {"ok":true,"rid":1,"name":"own-vault","version":"0.2.0","protocol":1,"pid":12345,"vaultDir":"C:\\Users\\me\\AppData\\Local\\own-open-code\\vault","ops":["hello","get","put","delete","list","lease.acquire","lease.release","linked.get"]}
```

`ops`(0.2.0부터)는 이 helper가 답하는 op 목록입니다. 없으면 0.1.0이고 `linked.get`이 없습니다(그 op는 `unknown_op`). 새 op는 추가만 했으므로 `protocol`은 1 그대로입니다.

client는 띄운 직후 한 번 보내 `protocol === 1`을 확인합니다. 응답이 오면 `vault: "ok"`, helper를 띄울 수 없거나 응답이 없으면 `vault: "unavailable"`(02 §9 `vault_unavailable`)입니다.

#### `get` — 비밀 읽기

```json
→ {"op":"get","rid":2,"id":"acc_01JAX3…"}
← {"ok":true,"rid":2,"value":"{\"v\":1,\"type\":\"oauth\",…,\"generation\":7}","generation":7}
```

- `value`는 **평문 JSON이 든 문자열**입니다(객체가 아님). client가 `JSON.parse`합니다. 형식은 02 §2.4.5(`{v,type:"oauth"|"key",…,generation}`)이지만 helper는 내용을 해석하지 않습니다.
- `generation`: `value`가 최상위 정수 필드 `generation`을 가진 JSON 객체면 그 값, 아니면 `null`.
- `"prev":true`면 `<id>.dpapi.prev`를 읽습니다(복구용, 6.4).
- 오류: `not_found`(`hasPrev` 포함), `decrypt_failed`(`hasPrev` 포함; 파일 손상, 다른 사용자·PC의 blob, 다른 id의 blob, UTF-8 아님), `invalid_id`, `io_error`.

```json
← {"ok":false,"error":"not_found","hasPrev":false}
← {"ok":false,"error":"decrypt_failed","hasPrev":true}
```

`get`은 뮤텍스를 잡지 않습니다. 모든 교체가 원자적이라 항상 완전한 옛 값이나 새 값을 봅니다.

#### `put` — 비밀 쓰기 (원자적 교체)

```json
→ {"op":"put","rid":3,"id":"acc_01JAX3…","value":"{\"v\":1,…,\"generation\":8}","keepPrev":true,"ifGeneration":7}
← {"ok":true,"rid":3,"generation":8}
```

| 필드 | 기본값 | 뜻 |
|---|---|---|
| `value` | 필수 | 저장할 평문 문자열(보통 `JSON.stringify(entry)`) |
| `keepPrev` | `false` | `true`면 교체 직전 값을 `.prev`로 남깁니다. `false`면 기존 `.prev`를 **건드리지 않습니다** |
| `ifGeneration` | 없음(무조건 쓰기) | 정수를 주면 compare-and-swap: 저장된 값의 `generation`이 이 값과 같을 때만 씁니다. `null`·생략은 무조건 쓰기 |

- 응답 `generation`은 새 `value`에서 읽은 값(없으면 `null`)입니다.
- 순서(뮤텍스 안): ① 새 blob을 temp에 쓰고 `FlushFileBuffers` ② `keepPrev`이고 현재 파일이 있으면 그 바이트를 temp에 쓰고 flush한 뒤 `MoveFileExW(→ .prev, REPLACE_EXISTING|WRITE_THROUGH)` ③ `MoveFileExW(temp → <id>.dpapi, REPLACE_EXISTING|WRITE_THROUGH)`. 어느 순간에 죽어도 `<id>.dpapi`는 완전한 옛 값이나 새 값이고, `.prev`는 완전한 blob입니다(강제 종료 테스트 있음).
- **응답 `ok:true`는 디스크에 내려갔다는 뜻입니다**(persist-before-use, F4). 새 토큰은 이 응답을 받은 뒤에 씁니다.
- 오류: `conflict`(`generation`: 실제 저장된 값, 파일이 없으면 `null`), `decrypt_failed`(`ifGeneration`을 줬는데 현재 값을 읽을 수 없음. 추측으로 덮어쓰지 않음), `busy`, `encrypt_failed`, `bad_request`(값 누락·크기 초과), `invalid_id`, `io_error`.

```json
← {"ok":false,"rid":3,"error":"conflict","generation":9}
```

#### `delete` — 삭제 (crypto-shred, F7)

```json
→ {"op":"delete","rid":4,"id":"acc_01JAX3…","shred":true}
← {"ok":true,"rid":4,"deleted":true}
```

- `<id>.dpapi`, `<id>.dpapi.prev`, 그 id의 잔여 temp(`<id>.dpapi.*.tmp`)를 지웁니다. `deleted`는 본 파일이나 `.prev`가 있었는지입니다. 없어도 `ok:true`(멱등).
- `shred:true`(기본 `false`)면 각 파일을 0으로 덮어쓰고 flush한 뒤 지웁니다. SSD의 wear leveling 때문에 best-effort이고, 남더라도 DPAPI blob입니다. 02 §9의 `accounts.remove.execute{mode:"delete"}`는 `shred:true`로 부릅니다.
- `<id>.lock`은 stale일 때만 함께 지웁니다. 살아 있는 lease는 남깁니다(진행 중인 refresh의 `put{ifGeneration}`이 `conflict`로 실패해 삭제된 계정을 되살리지 못합니다).

#### `list` — 비밀이 있는 계정 id

```json
→ {"op":"list"}
← {"ok":true,"ids":["acc_01JAX3…","acc_01JAX9…"]}
```

`<id>.dpapi`가 있는 id만, 정렬해서 돌려줍니다. `.prev`, `.lock`, temp, 뮤텍스 파일은 포함하지 않습니다. 레지스트리(`accounts.json`)와 대조해 고아 vault 항목을 찾는 데 씁니다.

#### `lease.acquire` — refresh lease 잡기 (F3)

```json
→ {"op":"lease.acquire","rid":5,"id":"acc_01JAX3…","pid":4242,"ttlMs":60000}
← {"ok":true,"rid":5,"acquired":true,"lease":{"pid":4242,"startedAt":1790000000000,"until":1790000060000}}
← {"ok":true,"rid":5,"acquired":false,"lease":{"pid":777,"startedAt":1789999990000,"until":1790000050000}}
← {"ok":true,"rid":5,"acquired":false,"lease":null}
```

| 필드 | 기본값 | 뜻 |
|---|---|---|
| `pid` | 필수 | **lease 소유 프로세스 = client(서버) 자신의 `process.pid`**. helper pid가 아닙니다. helper가 재시작되어도 lease가 유지되게 하기 위해서입니다 |
| `ttlMs` | `60000` | 1000..=600000. `until = startedAt + ttlMs` |

- 뮤텍스 안에서: 기존 `<id>.lock`을 읽어 **live면** `acquired:false`와 소유자(`lease`)를 돌려줍니다. **stale면** 지우고 새로 만듭니다. 새 파일은 temp에 쓴 뒤 `MoveFileExW`(REPLACE 없이)로 만들어 내용이 빈 lock 파일이 생기지 않습니다.
- **stale 판정**: `now >= until`, 또는 `pid` 프로세스가 없음(`OpenProcess`/`GetExitCodeProcess`), 또는 `until - startedAt > 600000`(비정상 값). 내용을 파싱할 수 없는 lock 파일은 mtime이 60초보다 오래됐을 때만 stale이고, 그 전에는 `acquired:false, lease:null`입니다.
- 재진입하지 않습니다. 같은 pid가 이미 잡은 lease에 다시 `acquire`하면 `acquired:false`와 자기 lease가 돌아옵니다(프로세스 안 중복은 runtime single-flight가 막아야 함, F2).
- `acquired:false`는 오류가 아닙니다. client가 기다렸다가 다시 시도합니다(6.3).
- 오류: `bad_request`(`pid` 누락·0, `ttlMs` 범위 밖), `busy`, `invalid_id`, `io_error`.

#### `lease.release` — lease 풀기

```json
→ {"op":"lease.release","rid":6,"id":"acc_01JAX3…","pid":4242,"startedAt":1790000000000}
← {"ok":true,"rid":6,"released":true}
```

파일의 `pid`와 `startedAt`이 둘 다 같을 때만 지웁니다. 만료되어 다른 프로세스가 가져간 lease를 실수로 풀지 않기 위해서입니다. 이미 없거나 소유자가 다르면 `released:false`(오류 아님).

#### `linked.get` — 이전 앱이 저장한 API 키 읽기 (읽기 전용, 0.2.0)

이전 앱(codex-multi-provider)이 저장한 API 키 파일 하나를 **메모리에서만** 복호화해 돌려줍니다. own-accounts의 "linked" 키 가져오기(02 §3.2b)가 요청 때 이 값을 씁니다. 파일은 쓰지도, 옮기지도, 복사하지도, 다시 암호화하지도 않습니다. vault에도 아무것도 남기지 않습니다.

```json
→ {"op":"linked.get","rid":7,"path":"D:\\#Projects\\codex-multi-provider\\profiles\\deepseek.dpapi"}
← {"ok":true,"rid":7,"value":"<키 평문>","size":262,"mtimeMs":1790000000000}
```

- 이전 앱의 형식: DPAPI CurrentUser, **optional entropy 없음**, `CRYPTPROTECT_UI_FORBIDDEN`, 헤더 없는 raw blob(이전 앱 `scripts\manager_core\providers.py` `_crypt_secret`). 평문은 키 문자열의 UTF-8 바이트입니다. 우리 vault 항목과 달리 entropy가 없으므로 이 blob을 `get`으로 읽으면 `decrypt_failed`이고, vault 항목을 `linked.get`으로 읽어도 `decrypt_failed`입니다.
- `size`는 blob 바이트 수, `mtimeMs`는 읽은 핸들의 마지막 쓰기 시각(Unix epoch ms)입니다. client는 이 두 값으로 캐시를 무효화합니다(파일이 바뀌면 다시 읽음).
- **허용 목록**(대소문자 무시, 먼저 경로 문자열만으로 검사):
  - `<drive>:\…\codex-multi-provider\profiles\<name>.dpapi` — 이전 앱의 `credential_ref` `legacy:deepseek`(`profiles\deepseek.dpapi`)
  - `<drive>:\…\codex-multi-provider\work\control-center\credentials\<name>.dpapi` — `credential_ref` `dpapi:<providerId>`
  - `<name>`은 `[A-Za-z0-9_-]{1,128}`이고 DOS 장치 이름이 아닙니다. 구분자는 `\`와 `/`를 모두 받습니다.
- 거부(`path_denied`): 상대 경로, `C:foo` 같은 드라이브 상대 경로, UNC·`\\?\`·`\\.\` 형식, 빈 구성 요소·`.`·`..`, 끝이 점이나 공백인 구성 요소(Windows가 몰래 지워 다른 이름과 같아짐), 예약 문자(`<>:"|?*`, 제어 문자. 그래서 ADS `…:stream`도 불가), 1024자 초과, 두 위치 밖의 모든 경로(vault 파일 포함).
- 파일 시스템 검사: `codex-multi-provider` 디렉터리부터 파일의 부모까지 각 디렉터리와 파일 자체가 reparse point(junction, symlink)가 아니어야 하고, 파일은 일반 파일이며 16 KiB 이하여야 합니다. 파일은 `FILE_FLAG_OPEN_REPARSE_POINT`로 열어 핸들에서 한 번 더 확인합니다(검사와 열기 사이의 교체 방지). 공유 모드는 읽기·쓰기·삭제를 모두 허용하므로 이전 앱은 언제든 파일을 교체할 수 있습니다.
- 허용 목록을 두는 이유: entropy 없는 DPAPI blob은 브라우저 등 다른 앱도 씁니다. 이 op가 임의 경로를 받으면 helper가 사용자의 모든 DPAPI blob을 푸는 도구가 됩니다.
- 오류: `path_denied`(`message`는 고정된 이유 문장. 값과 경로를 담지 않음), `not_found`(파일이나 디렉터리가 없음. `hasPrev` 없음), `decrypt_failed`(다른 사용자·PC의 blob, 손상, entropy가 있는 blob, UTF-8 아님), `io_error`, `bad_request`(`path` 누락).
- 뮤텍스를 잡지 않습니다(vault를 바꾸지 않음).

### 5.4 오류 코드

| `error` | 언제 | 추가 필드 | client 처리 |
|---|---|---|---|
| `bad_request` | JSON이 아님, 필드 누락·타입 오류, 줄·값 크기 초과, 범위 밖 인자 | `message` | 버그. 재시도하지 않음 |
| `unknown_op` | 모르는 `op` | `message` | 버전 불일치. `hello`의 `protocol` 확인 |
| `invalid_id` | id 형식 위반 | `message` | 버그 |
| `path_denied` | `linked.get`의 경로가 허용 목록 밖이거나 일반 파일이 아님(reparse point, 디렉터리, 16 KiB 초과) | `message`(고정 문장) | 가져오기 대상이 아님. 재시도하지 않음 |
| `not_found` | `get`·`linked.get` 대상 파일 없음 | `hasPrev`(`get`만) | `get`: 계정 상태 `needs_reauth` 또는 레지스트리 정리. `linked.get`: 이전 앱에서 키가 지워짐(`misconfigured`) |
| `decrypt_failed` | 복호화 실패(손상, 다른 사용자·PC, id 불일치, UTF-8 아님) | `hasPrev` | `hasPrev`면 6.4 복구 제안, 아니면 `needs_reauth` |
| `encrypt_failed` | `CryptProtectData` 실패(사용자 프로필 문제 등) | – | `vault_unavailable` |
| `conflict` | `put{ifGeneration}` 불일치 | `generation` | 다른 프로세스가 먼저 갱신함. 다시 `get` |
| `busy` | 다른 프로세스가 뮤텍스를 5초 넘게 쥠 | `message` | 잠시 뒤 재시도 |
| `io_error` | 그 밖의 파일 시스템 오류 | `message`(OS 오류 문구, 경로 없음) | 재시도 후 `vault_unavailable` |

## 6. 동시성과 복구

### 6.1 누가 무엇을 직렬화하나

- **프로세스 안**: runtime single-flight(F2)와 요청 순차 처리(helper 하나).
- **프로세스 사이**(옛·새 빌드 싱글턴 겹침, 금지된 두 번째 서버 등, 01 §4·02 §2.3): 모든 변경(`put`, `delete`, `lease.*`)은 `vault\.own-vault.mutex`를 **share mode 0으로 연 핸들**로 직렬화합니다. 다른 열기는 sharing violation으로 실패하고, helper는 최대 5초 기다린 뒤 `busy`를 냅니다. 핸들은 소유 프로세스가 죽으면 커널이 닫으므로 **이 뮤텍스는 stale이 될 수 없습니다.**
- 백신·인덱서가 파일을 잠깐 잡아서 생기는 sharing violation(`ERROR_ACCESS_DENIED`/`SHARING_VIOLATION`/`LOCK_VIOLATION`)은 읽기·교체·삭제에서 최대 2초 재시도합니다.

### 6.2 쓰기 원자성

temp → `FlushFileBuffers` → `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`(01 §13.1). `.prev`도 rename이 아니라 **복사 후 원자 교체**로 만들어 본 파일이 사라지는 순간이 없습니다.

### 6.3 refresh 절차 (02 §3.5 F1–F5를 이 프로토콜로)

```text
// runtime single-flight 안에서, accountId 하나당 한 번만 (F2)
cur = get{id}                                   // 캐시 미스 또는 만료 5분 전 (F1)
loop until deadline (~70s):
  r = lease.acquire{id, pid: process.pid, ttlMs: 60000}
  if r.acquired: break
  sleep(250ms..2s backoff)
  again = get{id}
  if again.generation > cur.generation: return again   // 다른 프로세스가 갱신함
lease = r.lease
try:
  fresh = get{id}                                // 잡은 뒤 다시 읽기 (F3)
  if fresh.generation != cur.generation: return fresh
  tokens = POST /oauth/token (refresh_token = fresh.refresh)   // HTTP는 TS
  next = {...fresh, access, refresh, idToken, expiresAt, obtainedAt: now, generation: fresh.generation + 1}
  put{id, value: JSON.stringify(next), keepPrev: true, ifGeneration: fresh.generation}   // F4: 쓰고 나서 쓴다
    - conflict  → 누군가 lease 밖에서 썼거나 계정이 삭제됨: get으로 다시 읽고 끝
    - 그 밖의 실패 → 받은 토큰을 쓸 수 없음: needs_reauth (F4)
  return next
finally:
  lease.release{id, pid: lease.pid, startedAt: lease.startedAt}
```

- `invalid_grant`, `refresh_token_reused`, "already used" → `needs_reauth`, 재시도 루프 없음(F5).
- 새 계정 추가(로그인 완료)는 `put{keepPrev:false}`, API 키 교체(`replaceKey`)는 `put{keepPrev:true}`를 권장합니다.

### 6.4 복구 (AC-P21 ".prev로 복구")

- `get`이 `decrypt_failed`/`not_found`이고 `hasPrev:true`면 `get{prev:true}`로 직전 값을 읽을 수 있습니다. 되살리려면 그 `value`를 `put`합니다.
- **자동으로 `.prev`를 쓰지 않습니다.** OAuth refresh token은 회전하므로 `.prev`의 refresh token은 이미 소비됐을 수 있고, 다시 쓰면 계열 전체가 폐기될 수 있습니다. API 키(`type:"key"`)는 안전하게 되살릴 수 있고, OAuth는 사용자 확인 뒤에만 되살리거나 재로그인을 권합니다.

## 7. TS client 구현 지침 (`@own/runtime`)

- 띄우기: `spawn(exePath, ["--home", ownHome], { stdio: ["pipe","pipe","pipe"], windowsHide: true, env: { SystemRoot: process.env.SystemRoot } })`. `exePath`는 `app\current\own-vault.exe`(개발 중에는 `own/native/own-vault/target/release/own-vault.exe`).
- 요청마다 `rid`를 단조 증가 정수로 붙이고, 응답을 FIFO 대기열과 `rid`로 맞춥니다. 모르는 `rid`는 버립니다.
- 타임아웃: 요청당 15초(뮤텍스 대기 5초 + 여유). 타임아웃이 나면 helper를 kill하고 대기 중인 요청을 모두 실패시킨 뒤 다시 띄웁니다(순서가 어긋난 응답을 믿지 않기 위해).
- `exit`/`error` 이벤트: 대기 중 요청을 실패시키고, 다음 요청 때 다시 띄웁니다. 연속 실패는 백오프하고 `vault: "unavailable"`로 보고합니다.
- stderr는 진단용으로만 읽습니다(정상 동작 중에는 비어 있음). 응답 줄, `value`, 요청 줄을 **로그에 남기지 않습니다**. 필요하면 SHA-256 앞 8자만(02 §2.4.5).
- 종료: 참조 카운트가 0이 되면 `stdin.end()`. 1초 안에 끝나지 않으면 kill.
- 비밀 캐시(02 §2.4.5)는 client 몫입니다. hot path는 캐시만 읽고, 미스 때만 `get`합니다.
- `linked.get`: client(`Vault.Client.linkedGet`)는 허용 목록을 먼저 검사해(`Vault.linkedPathProblem`) 밖의 경로는 요청하지 않고 `path_denied`로 답합니다. 값은 `LegacyKey.Reader`가 메모리에만 두고(경로 + `mtimeMs`·`size` 기준), 파일이 바뀌거나 TTL이 지나거나 401을 받으면 다시 요청합니다(02 §3.2b).

## 8. 자격 증명 종류와 helper

helper는 `value`의 의미를 모릅니다. 종류별 차이는 전부 client와 레지스트리의 몫입니다.

| 종류 | vault 항목 | 비고 |
|---|---|---|
| 우리가 로그인한 OAuth·API 키 | `<id>.dpapi`에 02 §2.4.5 형식 | 우리가 유일한 refresher |
| codex-multi-provider 가져오기 **takeover** | 가져올 때 한 번 `put`(원본 토큰을 우리 형식으로 옮겨 `generation:1`) | 이후 우리가 유일한 refresher. 원본은 superseded 표시(레지스트리·UI 몫) |
| codex-multi-provider 가져오기 **linked**(기본) | **없음** | 원본 `…\profiles\<id>\codex\auth.json`(평문 JSON)은 runtime이 읽기 전용으로 직접 읽습니다. helper는 이 파일을 읽지 않고, 원본을 쓰거나 refresh하지 않습니다 |
| codex-multi-provider **API 키 linked**(02 §3.2b) | **없음** | 이전 앱의 DPAPI 파일(`profiles\deepseek.dpapi`, `work\control-center\credentials\<id>.dpapi`)을 helper `linked.get`이 요청 때 메모리에서만 복호화합니다. 파일은 읽기만 합니다. 레지스트리에는 경로(참조)만 남습니다 |

## 9. 스펙과 다른 점 (이유)

1. **lease 파일 연산을 helper에 넣었습니다**(`lease.acquire`/`lease.release`). 02 §2.3 표는 `.lock`을 own-runtime이 `open(path,"wx")`로 쓴다고 적었습니다. 파일 형식(`{pid,startedAt,until}`)과 stale 규칙(F3)은 같습니다. 옮긴 이유: stale lease를 지우고 새로 만드는 동작이 두 프로세스에서 겹치면 서로의 lease를 지울 수 있는데, helper 뮤텍스 안에서 하면 이 경합이 없어집니다. 또 `pid` 생존 확인을 `OpenProcess`로 정확히 할 수 있습니다.
2. **새 파일 `vault\.own-vault.mutex`**(01 §5.1 레이아웃에 없음). 비밀 아님. 6.1의 프로세스 사이 뮤텍스입니다.
3. **추가 연산·필드**: `hello`, `rid`, `get{prev}`, `put{ifGeneration}`, 오류의 `hasPrev`, 오류 코드 `conflict`/`busy`/`bad_request`/`unknown_op`/`invalid_id`/`encrypt_failed`/`io_error`. 02 §2.4.5의 예시와 호환됩니다(`get` 응답 형태 동일).
4. **응답에 항상 `ok`가 있습니다.** 02 §2.4.5의 `list` 예시 `{ids:[…]}`는 `{"ok":true,"ids":[…]}`입니다. `put`은 `{"ok":true,"generation":…}`, `delete`는 `{"ok":true,"deleted":…}`입니다.
5. **`shred`의 기본값은 `false`**이고, `shred:true`는 0 덮어쓰기 + flush + 삭제입니다. 스펙 예시처럼 삭제 경로에서는 `shred:true`를 명시합니다.
6. **`keepPrev`는 rename이 아니라 복사**로 `.prev`를 만듭니다(본 파일이 사라지는 창을 없애기 위해).
7. **entropy 구분자는 `/`**(Q15). 01 §13·§13.1도 현재 `/`입니다.
8. **Windows 전용**. 원격 Linux backend는 후속(01 §11)입니다.
9. **`linked.get`(0.2.0)**: vault 밖 파일을 읽는 유일한 op입니다. 이전 앱의 키는 우리 entropy가 없는 DPAPI blob이라 runtime(TS)이 직접 풀 수 없고(01 §13.1: `bun:ffi`·PowerShell 금지), 복호화를 helper에 두되 허용 목록·읽기 전용으로 좁혔습니다. `hello.ops`도 이때 추가했습니다.

## 10. 테스트

`cargo test --locked`: 단위 33개(`src/`), 프로세스 수준 8개(`tests/process.rs`, 실제 파이프와 빈 env로 빌드된 exe를 띄움). 모두 가짜 비밀만 씁니다. `linked.get` 테스트는 임시 디렉터리에 `…\codex-multi-provider\profiles\` 모양을 만들어 가짜 키로 씁니다(실제 이전 앱 파일은 읽지 않음).

- DPAPI 왕복, 잘못된 entropy·쓰레기·빈 입력 거부, 빈 평문
- `put`/`get`/`list`/`delete` 왕복, 디스크의 blob에 평문이 없음, 문서의 entropy로 직접 복호화
- `keepPrev` 의미(`false`면 `.prev` 유지), 손상 파일 → `decrypt_failed`와 `hasPrev`, `.prev` 복구, id 바인딩(복사한 blob 거부), UTF-8 아닌 평문 거부
- `ifGeneration` CAS, 삭제 뒤 늦은 refresh 쓰기 거부, shred와 잔여 temp 삭제, stale lease 정리
- 뮤텍스를 쥔 동안 변경은 `busy`·읽기는 통과, 스레드 6개 × CAS 10회 무손실, 프로세스 2개 × CAS 15회 무손실
- lease: 획득·보유·소유자 검증 release, 만료·죽은 pid·파싱 불가(신선/오래됨) stale 규칙, 인자 범위, helper가 죽은 뒤 다른 helper의 인수
- 프로토콜: `rid` 되돌림, 순서, 빈 줄, `\r\n`, 잘못된 JSON·모르는 op·필드 누락·타입 오류 뒤에도 계속 처리, 오류 메시지에 값 미포함, 2 MiB 초과 줄
- 프로세스: EOF 정상 종료와 빈 stderr, 재시작 뒤 읽기, `put{keepPrev}` 연속 중 강제 종료 후 본 파일·`.prev` 모두 완전, 명령줄 계약(`--home`, `OWN_HOME`, 상대 경로·인자 오류 → 2)
- PowerShell `ProtectedData`와 양방향 교차 읽기(AC-P21)
- `linked.get`: 허용 목록(두 위치, 대소문자, `/`)과 거부 목록(상대·드라이브 상대·UNC·`\\?\`·`..`·`.`·빈 구성 요소·끝 점/공백·ADS·장치 이름·다른 앱·vault 경로·길이), entropy 없는 blob 왕복, 파일 바이트·mtime 불변과 옆에 임시 파일 없음, 없는 파일·디렉터리 → `not_found`, vault blob·쓰레기·UTF-8 아님 → `decrypt_failed`, 16 KiB 초과·디렉터리 → `path_denied`, junction으로 바꾼 `profiles` → `path_denied`, 프로토콜 왕복과 거부 응답에 값 없음, PowerShell `ProtectedData.Protect(v, $null, CurrentUser)`로 만든(이전 앱과 같은 형식) 키를 실제 exe가 읽고 파일은 그대로
