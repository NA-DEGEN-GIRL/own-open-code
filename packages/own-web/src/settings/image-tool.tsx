// 설정 > 이미지 만들기 (decisions US5, IM, IS; lazy, `/settings/image`; a part of 컴퓨터 사용 (실험) until IS). One switch
// on this PC's service (`policy.imageGenerate`) and own's image tool's setting (`policy.image`, 02 §9.6) through
// `policy.get`/`policy.set`, so every window, device and SSH host agrees; the key chain and the subscription accounts
// as the tool would try them now come from `image.get` (labels, used-up marks, the tightest limit; never a key).
// - 모델: which models the API keys use (`auto`, the recommended default, lets the AI pick GPT Image 2.6 Flare or Sunburst per image).
// - 기본 품질, 기본 크기: what a call without its own uses.
// - OpenAI API 키 순서: reorder (위로/아래로), leave a key out, `다시 쓰기` forgets a used-up mark (`image.clear`), and
//   `OpenAI API 키 추가` opens the add-account dialog on the OpenAI key form (`/accounts/add/oai`). `API 키 쓰기` turns
//   every key off at once (IM-12): the chain then goes straight to the subscriptions. Each key and subscription keeps
//   its own switch, apart from the used-up marks.
// - Codex 구독으로 대신 만들기: on by default (decisions IM-3) with the one-line terms notice, and which accounts.
// Off by default as a whole: a listed tool changes every conversation's tool list and costs money per image. A phone or
// another PC shows the same page; `policy.set` (`admin`) decides whether it may change it there.
import { createResource, For, Show } from "solid-js"
import type { OwnImage } from "@own/protocol"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { errorMessage } from "@/accounts/errors"
import { createStatus, StatusLine } from "@/limits/kit"
import { loadPolicy, policyState, updatePolicy } from "@/limits/shared"
import { useRouter } from "@/routing/router"
import { useImageToolText, type ImageToolKey } from "./image-tool-strings"

const FAMILIES: ReadonlyArray<OwnImage.Family> = ["auto", "flare", "sunburst", "gpt-image-2"]
const QUALITIES: ReadonlyArray<OwnImage.Quality> = ["auto", "low", "medium", "high"]
const SIZES: ReadonlyArray<OwnImage.Size> = ["auto", "1024x1024", "1536x1024", "1024x1536"]

export default function ImageToolSettings() {
  const data = useData()
  const i18n = useI18n()
  const text = useImageToolText()
  const router = useRouter()
  const own = data.local().own
  void loadPolicy(own, true)
  const status = createStatus()
  const writable = () => own.rpc.allowed("policy.set")
  const enabled = () => policyState()?.policy.imageGenerate === true
  const setting = () => policyState()?.policy.image ?? {}
  const [view, { mutate, refetch }] = createResource(() => own.rpc.call("image.get", {}).catch(() => undefined))

  const save = (patch: { readonly imageGenerate?: boolean; readonly image?: OwnImage.Setting }, done?: string) => {
    status.clear()
    void own.rpc
      .call("policy.set", { patch })
      .then((output) => {
        updatePolicy(own, output.policy)
        if (patch.imageGenerate !== undefined) {
          if ((output.policy.imageGenerate === true) !== patch.imageGenerate)
            return status.error(text("own.imageTool.unknown"))
          return status.ok(text(patch.imageGenerate ? "own.imageTool.on" : "own.imageTool.off"))
        }
        void refetch()
        status.ok(done ?? text("own.imageTool.saved"))
      })
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }

  const keys = () => view()?.keys ?? []
  const move = (index: number, by: number) => {
    const order = keys().map((key) => key.accountID)
    const target = index + by
    if (target < 0 || target >= order.length) return
    const next = order.toSpliced(index, 1).toSpliced(target, 0, order[index]!)
    save({ image: { keyOrder: next } })
  }
  type Ids = NonNullable<OwnImage.Setting["keyOff"]>
  const toggleIn = (list: Ids | undefined, id: Ids[number], on: boolean): Ids => {
    const rest = (list ?? []).filter((item) => item !== id)
    return on ? rest : [...rest, id]
  }
  const clear = (accountID: string) => {
    void own.rpc
      .call("image.clear", { accountID })
      .then((next) => mutate(next))
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }
  const at = (ms: number) => new Date(ms).toLocaleString(i18n.locale() === "en" ? "en" : "ko", { dateStyle: "short", timeStyle: "short" })

  return (
    <div class="flex flex-col" data-testid="settings-image-tool">
      <Show when={policyState()} fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
        <section class="own-psec !mt-2 flex flex-col gap-2">
          <p class="m-0 text-[12.5px] text-own-muted">{text("own.imageTool.lead")}</p>
          <label class="flex items-center gap-2 text-[13.5px] font-semibold">
            <input
              type="checkbox"
              checked={enabled()}
              disabled={!writable()}
              onChange={(event) => save({ imageGenerate: event.currentTarget.checked })}
              data-testid="image-tool-toggle"
            />
            <span>{text("own.imageTool.toggle")}</span>
          </label>
          <Show when={!writable()}>
            <p class="m-0 text-[12px] text-own-muted">{text("own.imageTool.readOnly")}</p>
          </Show>
          <div class="flex flex-col gap-1 text-[12px] leading-[18px] text-own-muted">
            <p class="m-0">{text("own.imageTool.default")}</p>
            <p class="m-0">{text("own.imageTool.cost")}</p>
            <p class="m-0">{text("own.imageTool.shared")}</p>
          </div>
        </section>

        <section class="own-psec flex flex-col gap-2">
          <div class="own-psec-head">
            <h2>{text("own.imageTool.model")}</h2>
          </div>
          <div class="flex flex-col gap-1" role="radiogroup" data-testid="image-tool-family">
            <For each={FAMILIES}>
              {(family) => (
                <label class="flex items-center gap-2 text-[13px]">
                  <input
                    type="radio"
                    name="image-family"
                    checked={(setting().family ?? "auto") === family}
                    disabled={!writable()}
                    onChange={() => save({ image: { family } })}
                    data-testid={`image-family-${family}`}
                  />
                  <span>{text(`own.imageTool.family.${family}` as ImageToolKey)}</span>
                </label>
              )}
            </For>
          </div>
          <p class="m-0 text-[12px] text-own-muted">{text("own.imageTool.price")}</p>
          <div class="flex flex-wrap items-center gap-4 text-[13px]">
            <label class="flex items-center gap-2">
              <span>{text("own.imageTool.quality")}</span>
              <select
                class="own-input h-8 w-auto py-0"
                disabled={!writable()}
                value={setting().quality ?? "auto"}
                onChange={(event) => save({ image: { quality: event.currentTarget.value as OwnImage.Quality } })}
                data-testid="image-quality"
              >
                <For each={QUALITIES}>
                  {(quality) => (
                    <option value={quality}>
                      {quality === "auto" ? text("own.imageTool.auto") : text(`own.imageTool.quality.${quality}` as ImageToolKey)}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class="flex items-center gap-2">
              <span>{text("own.imageTool.size")}</span>
              <select
                class="own-input h-8 w-auto py-0"
                disabled={!writable()}
                value={setting().size ?? "auto"}
                onChange={(event) => save({ image: { size: event.currentTarget.value as OwnImage.Size } })}
                data-testid="image-size"
              >
                <For each={SIZES}>
                  {(size) => <option value={size}>{size === "auto" ? text("own.imageTool.auto") : size}</option>}
                </For>
              </select>
            </label>
          </div>
        </section>

        <section class="own-psec flex flex-col gap-2">
          <div class="own-psec-head">
            <h2>{text("own.imageTool.keys")}</h2>
          </div>
          <label class="flex items-center gap-2 text-[13px] font-semibold">
            <input
              type="checkbox"
              checked={setting().useKeys ?? true}
              disabled={!writable()}
              onChange={(event) => save({ image: { useKeys: event.currentTarget.checked } })}
              data-testid="image-use-keys"
            />
            <span>{text("own.imageTool.useKeys")}</span>
          </label>
          <p class="m-0 text-[12px] text-own-muted">{text("own.imageTool.useKeys.off")}</p>
          <p class="m-0 text-[12px] text-own-muted">{text("own.imageTool.keys.lead")}</p>
          <Show when={keys().length > 0} fallback={<p class="m-0 text-[12.5px]">{text("own.imageTool.keys.none")}</p>}>
            <ol
              class="m-0 flex flex-col gap-1 pl-5 text-[13px]"
              classList={{ "opacity-60": !(setting().useKeys ?? true) }}
              data-testid="image-keys"
            >
              <For each={keys()}>
                {(key, index) => (
                  <li class="flex flex-wrap items-center gap-2" data-testid="image-key">
                    <label class="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={key.on}
                        disabled={!writable()}
                        aria-label={text("own.imageTool.keys.use")}
                        onChange={(event) =>
                          save({ image: { keyOff: toggleIn(setting().keyOff, key.accountID, event.currentTarget.checked) } })
                        }
                      />
                      <span>{key.label}</span>
                    </label>
                    <Show when={!key.ready}>
                      <span class="text-own-muted">{text("own.imageTool.keys.notReady")}</span>
                    </Show>
                    <Show when={key.exhausted}>
                      {(mark) => (
                        <>
                          <span class="text-own-danger" data-testid="image-key-exhausted">
                            {text("own.imageTool.keys.exhausted", { code: mark().code, at: at(mark().at) })}
                          </span>
                          <button type="button" class="own-link" disabled={!writable()} onClick={() => clear(key.accountID)}>
                            {text("own.imageTool.keys.clear")}
                          </button>
                        </>
                      )}
                    </Show>
                    <button type="button" class="own-link" disabled={!writable() || index() === 0} onClick={() => move(index(), -1)}>
                      {text("own.imageTool.keys.up")}
                    </button>
                    <button
                      type="button"
                      class="own-link"
                      disabled={!writable() || index() === keys().length - 1}
                      onClick={() => move(index(), 1)}
                    >
                      {text("own.imageTool.keys.down")}
                    </button>
                  </li>
                )}
              </For>
            </ol>
          </Show>
          <div>
            <button
              type="button"
              class="own-btn"
              onClick={() => router.navigate({ name: "accountsAdd", kind: "oai" })}
              data-testid="image-add-key"
            >
              {text("own.imageTool.keys.add")}
            </button>
          </div>
        </section>

        <section class="own-psec flex flex-col gap-2" data-testid="image-codex">
          <label class="flex items-center gap-2 text-[13px] font-semibold">
            <input
              type="checkbox"
              checked={setting().codexFallback ?? true}
              disabled={!writable()}
              onChange={(event) => save({ image: { codexFallback: event.currentTarget.checked } })}
              data-testid="image-codex-fallback"
            />
            <span>{text("own.imageTool.codex")}</span>
          </label>
          <p class="m-0 text-[12px] text-own-muted">{text("own.imageTool.codex.lead")}</p>
          <p class="m-0 text-[12px] text-own-muted" data-testid="image-codex-terms">
            {text("own.imageTool.codex.terms")}
          </p>
          <Show when={(setting().codexFallback ?? true) && view()}>
            {(current) => (
              <Show
                when={current().codex.length > 0}
                fallback={<p class="m-0 text-[12.5px]">{text("own.imageTool.codex.none")}</p>}
              >
                <ul class="m-0 flex flex-col gap-1 pl-5 text-[13px]" data-testid="image-codex-accounts">
                  <For each={current().codex}>
                    {(account) => (
                      <li class="flex flex-wrap items-center gap-2">
                        <label class="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={account.on}
                            disabled={!writable()}
                            onChange={(event) =>
                              save({
                                image: {
                                  codexOff: toggleIn(setting().codexOff, account.accountID, event.currentTarget.checked),
                                },
                              })
                            }
                          />
                          <span>{account.label}</span>
                        </label>
                        <Show when={account.usedPercent !== undefined}>
                          <span class="text-own-muted">
                            {text("own.imageTool.codex.used", { percent: Math.round(account.usedPercent ?? 0) })}
                          </span>
                        </Show>
                        <Show when={account.exhausted}>
                          <span class="text-own-danger">{text("own.imageTool.codex.limited")}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Show>
        </section>
        <StatusLine status={status} testid="image-tool-status" />
      </Show>
    </div>
  )
}
