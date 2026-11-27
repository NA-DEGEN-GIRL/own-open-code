# 카탈로그 변형 (07 §8.4 PG5, PG6)

실제 서버가 어떤 models.dev 카탈로그로 시작할지를 정하는 시험 도구입니다. 변형은 파일로 두지 않고 시험마다 코드로 만듭니다. 바탕은 소스 서버가 번들한 카탈로그(`packages/core/src/models-dev/snapshot.txt`, 수 MB)이고, 그 위에 편집 몇 개를 차례로 얹습니다. 번들 템플릿(`src/slots/templates/*.json`)이 같은 카탈로그에서 생성되므로(`test/slots/generate-templates.ts`), 편집이 없는 변형은 어떤 고정 템플릿도 바꾸지 않습니다. 시험이 보는 변화는 편집한 것뿐입니다.

## 쓰는 법

```ts
import { GPT_61_SOL, bundledCatalog, catalogVariant, startPresetRig } from "../e2e-kit"

const base = await bundledCatalog() // openai, anthropic, deepseek만(한 프로세스에 한 번 읽음)
const rig = await startPresetRig({ ..., catalog: catalogVariant(base, [GPT_61_SOL]), control: true })
// 카탈로그가 바뀌는 순간: 같은 임시 루트로 다시 띄운다
await rig.restart({ catalog: catalogVariant(base, [GPT_61_SOL, { provider: "openai", remove: "gpt-6-luna" }]) })
```

- `startPresetRig({catalog})`와 `rig.restart({catalog})`는 변형을 `<임시 루트>\models-catalog.json`에 쓰고 `OPENCODE_MODELS_PATH`로 넘깁니다(`startOpencodeServer({models})`). core는 이 파일을 처음 필요할 때 한 번 읽고 캐시하며, 시험 서버는 모델 받기가 꺼져 있어(`OPENCODE_DISABLE_MODELS_FETCH`) 5분 갱신도 없습니다. 그래서 운영에서 `models-dev.refreshed`로 오는 변화를 시험에서는 재시작으로 흉내 냅니다. 재시작한 서버도 처음 접기에서 새 카탈로그를 보고, control Location이 고정 템플릿 diff를 써서(07 §4.4) 모든 Location이 다시 접습니다. 그 뒤 수리 알림의 있는지 확인이 돕니다(07 §4.3 (가)).
- 파일에 없는 provider는 서버에 없습니다. 기본 셋(`CATALOG_PROVIDERS`)은 own의 종류가 템플릿을 베끼는 `openai`(codex, siwc, oai), `anthropic`(anth), `deepseek`(ds)입니다.
- 편집은 있는 모델을 가리켜야 합니다. 없으면 그 자리에서 실패하므로, 업스트림 동기화로 번들 카탈로그에서 모델이 빠지면 시험이 먼저 알려 줍니다.

## 편집 (`CatalogEdit`)

| 편집 | 뜻 | 흉내 내는 카탈로그 변화 |
|---|---|---|
| `{provider, add, from, set?}` | `from`을 베껴 id `add`로 더하고 `set`을 덮음 | 새 모델 출시(같은 계열의 새 최신, 새 계열) |
| `{provider, change, set}` | 모델의 필드를 바꿈 | `status: "deprecated"`(core가 목록에서 조용히 뺌, `core/src/plugin/models-dev.ts`), `capabilities.reasoning.effort` 값 삭제(variant 삭제. models.dev v2, `set`을 모델에서 계산하는 함수로 줌), 한도·가격 변경 |
| `{provider, rename, to}` | 다른 필드는 그대로 두고 id만 바꿈(같은 계열·출시일) | 이름 변경. 옛 id의 삭제와 새 id의 추가로 보임 |
| `{provider, remove}` | 모델을 뺌 | 사라짐 |

- `experimental.modes`의 `fast`·`pro`도 함께 베껴지므로 core는 `-fast` 짝을 함께 만들거나 뺍니다. 고정 템플릿 표시(`addedAt`, `upstream: "missing"`)는 짝마다 붙습니다.
- `GPT_61_SOL`: 10-01 models.dev에 들어온 gpt-6.1-sol(07 §4.1, 부록 A). gpt-6-sol을 베끼고(계열 `gpt-sol`, 입력 922k, $2/M) 출시일만 09-29로 바꿉니다. 번들 카탈로그와 템플릿에는 없습니다.

## Codex 메타데이터

카탈로그와 따로, Codex 메타데이터(07 §4.5)는 `OWN_HOME\codex-meta.json`입니다. `startPresetRig({codexMeta})`와 `rig.restart({codexMeta})`는 재시작 전에, `rig.setCodexMeta(snapshot)`는 실행 중에(다른 프로세스가 쓰듯이 → 저장소 감시) 씁니다. `codexMetaFixture()`는 `test/slots/fixture/codex-models.json`(부록 A의 새 번들 모양: gpt-6.1-sol 우선순위 1·최대 872k, gpt-5.5 272k와 10-14 은퇴)을 받아 둔 `backend` 스냅샷으로 돌려줍니다. 가짜 Codex backend는 모델 목록을 주지 않으므로(404) 서비스의 받기는 실패하고 저장된 스냅샷이 남습니다.

## 쓰는 시험

| 시험 | 변형 |
|---|---|
| `test/presets/pg5.e2e.test.ts` (PG5) | 번들 그대로 → 추가(`GPT_61_SOL`, 새 가장 싼 계열 `gpt-6-nano`) + 메타데이터의 새 우선순위 1위와 은퇴 날짜 → 고정 대상 `deprecated`(gpt-5.6-terra)와 가벼운 짝 모델 삭제(gpt-6-luna) → 이름 변경(gpt-6-astra → gpt-6-astra-1001) → effort 단계 삭제(gpt-6-sol의 `xhigh`). 각 단계는 재시작 하나 |
| `test/presets/pg6.e2e.test.ts` (PG6) | `GPT_61_SOL` 하나. 메타데이터는 실행 중에 도착(`setCodexMeta`) |
