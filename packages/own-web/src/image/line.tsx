// 이미지 만들기 (02 §9.6, decisions IM): the line under an `image_generate` card, lazy (only rows with such a call load
// it). It reads the tool's result card (`metadata.ownImage`, `OwnImage.CardData`):
// - done: the model, the account (OpenAI API 키 or ChatGPT 구독), the cost, the saved path and the image, and every
//   account tried or skipped before, with why;
// - running: which account it is asking now;
// - unavailable: no account can make images now (every key and subscription off, used up, at its limit or failing,
//   IM-13), each with its reason, and `이미지 설정 열기` (설정 > 이미지 만들기, IS) and
//   `OpenAI API 키 추가` (the add-account dialog on the OpenAI key form).
// A GIF shows animated and an SVG as a picture, both from the card's `preview` and only ever in an `<img>` (IM-23,
// ./preview.ts); the line names the format, a format other than asked, a GIF frame size own lowered (IM-32) and an
// SVG's authoring tokens with their cost when priced (IM-34).
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import type { OwnImage } from "@own/protocol"
import { catalogText, useCatalogText } from "@/projects/text"
import { useRouter } from "@/routing/router"
import { imageSrc } from "./object-url"
import { omitted, shown } from "./preview"
import "./image.css"

const ko = {
  "own.image.line.done": "{model} · {via} {account}",
  "own.image.line.key": "OpenAI API 키",
  "own.image.line.codex": "ChatGPT 구독",
  "own.image.line.cost": "· ${cost}",
  "own.image.line.plan": "· 구독 한도에서 차감",
  "own.image.line.saved": "저장한 곳: {path}",
  "own.image.line.running": "{account}로 만드는 중이에요…",
  "own.image.line.before": "먼저 시도한 계정",
  "own.image.line.skipped": "건너뜀",
  "own.image.line.failed": "실패",
  "own.image.line.need":
    "지금 이미지를 만들 수 있는 계정이 없어요. 계정을 켜거나 OpenAI API 키를 추가한 뒤 다시 요청해 주세요.",
  "own.image.line.why": "계정마다 이유",
  "own.image.line.addKey": "OpenAI API 키 추가",
  "own.image.line.settings": "이미지 설정 열기",
  "own.image.line.open": "크게 보기",
  "own.image.line.close": "닫기",
  "own.image.line.gif": "GIF 애니메이션 · {frames}프레임",
  "own.image.line.gifPlain": "GIF 애니메이션",
  "own.image.line.svg": "SVG (벡터)",
  "own.image.line.asked": "요청한 형식 {asked} · 받은 형식 {format}",
  "own.image.line.svgAuthor": "SVG 작성 {model}: 입력 {input} · 출력 {output} 토큰 (위 비용에 들어 있지 않아요)",
  "own.image.line.svgAuthorPaid": "SVG 작성 {model}: 입력 {input} · 출력 {output} 토큰 · ${cost} (위 비용에 들어 있어요)",
  "own.image.line.resized": "프레임 크기 {to} (요청한 {from}보다 줄였어요)",
} as const satisfies Record<string, string>

const en: Record<keyof typeof ko, string> = {
  "own.image.line.done": "{model} · {via} {account}",
  "own.image.line.key": "OpenAI API key",
  "own.image.line.codex": "ChatGPT subscription",
  "own.image.line.cost": "· ${cost}",
  "own.image.line.plan": "· counts against the plan's limits",
  "own.image.line.saved": "Saved to {path}",
  "own.image.line.running": "Making it with {account}…",
  "own.image.line.before": "Tried first",
  "own.image.line.skipped": "skipped",
  "own.image.line.failed": "failed",
  "own.image.line.need": "No account can make images right now. Switch an account on or add an OpenAI API key, then ask again.",
  "own.image.line.why": "Why, per account",
  "own.image.line.addKey": "Add an OpenAI API key",
  "own.image.line.settings": "Open image settings",
  "own.image.line.open": "View larger",
  "own.image.line.close": "Close",
  "own.image.line.gif": "Animated GIF · {frames} frames",
  "own.image.line.gifPlain": "Animated GIF",
  "own.image.line.svg": "SVG (vector)",
  "own.image.line.asked": "Asked for {asked} · got {format}",
  "own.image.line.svgAuthor": "SVG authoring {model}: {input} input · {output} output tokens (not in the cost above)",
  "own.image.line.svgAuthorPaid": "SVG authoring {model}: {input} input · {output} output tokens · ${cost} (in the cost above)",
  "own.image.line.resized": "Frame size {to} (lowered from {from})",
}

const lineText = catalogText(ko, en)

export type Card = Omit<OwnImage.CardData, "status"> & { readonly status: OwnImage.CardData["status"] | "running" }

export interface ImagePart {
  readonly card?: Card
  /** The result's image (`data:` URI of its file part). */
  readonly image?: string
  /** Reads the image from the whole message when the transcript page left its bytes out ({@link omitted}). */
  readonly read?: () => Promise<string | undefined>
  /**
   * The part's place (server, session, message, part): images read are kept by it, since the parts are made anew
   * whenever the transcript changes. A call id alone is not unique: local models number their calls (`call_0`).
   */
  readonly id?: string
}

const reads = new Map<string, Promise<string | undefined>>()
const READS_KEPT = 8

/**
 * `read()` once per part while it stays among the last {@link READS_KEPT} read. A failed or empty read is forgotten,
 * so the next mount asks again (a transient error, a read racing the message's durable write).
 */
function readOnce(key: string | undefined, read: () => Promise<string | undefined>) {
  if (key === undefined) return read().catch(() => undefined)
  const known =
    reads.get(key) ??
    read().then(
      (image) => {
        if (image === undefined) reads.delete(key)
        return image
      },
      () => {
        reads.delete(key)
        return undefined
      },
    )
  reads.delete(key)
  reads.set(key, known)
  if (reads.size > READS_KEPT) reads.delete(reads.keys().next().value!)
  return known
}

export default function ImageLine(props: { readonly parts: readonly ImagePart[]; readonly onSizeChange?: () => void }) {
  const text = useCatalogText(lineText)
  const router = useRouter()
  createEffect(on(() => props.parts.map((part) => part.card?.status).join(), () => props.onSizeChange?.(), { defer: true }))
  return (
    <For each={props.parts.filter((part) => part.card)}>
      {(part) => {
        const card = () => part.card!
        const earlier = () => card().steps.filter((step) => step.outcome !== "used")
        // A plain signal, not a resource: a pending resource would suspend the row's boundary and hide the whole line
        // (status, model, cost, buttons) until the message arrives.
        const [read, setRead] = createSignal<string>()
        createEffect(() => {
          const reader = part.read
          if (card().status === "done" && omitted(part.image) && reader) void readOnce(part.id, reader).then(setRead)
        })
        return (
          <div class="own-img-line" data-testid="image-line" data-status={card().status}>
            <Show when={card().status === "running"}>
              <span>{text("own.image.line.running", { account: card().account ?? "" })}</span>
            </Show>
            <Show when={card().status === "done"}>
              <span data-testid="image-line-done">
                {text("own.image.line.done", {
                  model: card().model ?? "",
                  via: text(card().route === "codex" ? "own.image.line.codex" : "own.image.line.key"),
                  account: card().account ?? "",
                })}{" "}
                {card().costUSD === undefined
                  ? card().route === "codex"
                    ? text("own.image.line.plan")
                    : ""
                  : text("own.image.line.cost", { cost: (card().costUSD ?? 0).toFixed(4) })}
              </span>
              <Show when={card().path}>
                {(file) => <span class="own-img-path">{text("own.image.line.saved", { path: file() })}</span>}
              </Show>
              <Show when={card().format === "gif" || card().format === "svg" || card().asked || card().resized}>
                <span class="own-img-format" data-testid="image-line-format">
                  {[
                    card().format === "gif"
                      ? card().frames === undefined
                        ? text("own.image.line.gifPlain")
                        : text("own.image.line.gif", { frames: String(card().frames) })
                      : card().format === "svg"
                        ? text("own.image.line.svg")
                        : "",
                    card().resized ? text("own.image.line.resized", card().resized) : "",
                    card().asked
                      ? text("own.image.line.asked", {
                          asked: (card().asked ?? "").toUpperCase(),
                          format: (card().format ?? "").toUpperCase(),
                        })
                      : "",
                  ]
                    .filter((item) => item.length > 0)
                    .join(" · ")}
                </span>
              </Show>
              <Show when={card().svgAuthor}>
                {(author) => (
                  <span class="own-img-path">
                    {text(author().costUSD === undefined ? "own.image.line.svgAuthor" : "own.image.line.svgAuthorPaid", {
                      model: author().model,
                      input: String(author().input),
                      output: String(author().output),
                      cost: (author().costUSD ?? 0).toFixed(4),
                    })}
                  </span>
                )}
              </Show>
              <Show when={shown(part) ?? shown({ ...part, image: read() })}>
                {(uri) => (
                  <ImageView
                    uri={uri()}
                    format={card().format}
                    alt={card().path ?? ""}
                    onLoad={() => props.onSizeChange?.()}
                  />
                )}
              </Show>
            </Show>
            <Show when={card().status === "unavailable"}>
              <span class="own-img-need" data-testid="image-line-need">
                {text("own.image.line.need")}
              </span>
              <span class="own-img-actions">
                <button
                  type="button"
                  data-testid="image-line-settings"
                  onClick={() => router.navigate({ name: "settings", section: "image" })}
                >
                  {text("own.image.line.settings")}
                </button>
                <button
                  type="button"
                  data-testid="image-line-add-key"
                  onClick={() => router.navigate({ name: "accountsAdd", kind: "oai" })}
                >
                  {text("own.image.line.addKey")}
                </button>
              </span>
            </Show>
            {/* What was tried first, folded under a made image (MUX: the image stays the card's first sight on a phone);
                open when no account could make it, where the reasons are the answer. */}
            <Show when={earlier().length > 0}>
              <details
                class="own-img-steps"
                open={card().status === "unavailable"}
                onToggle={() => props.onSizeChange?.()}
              >
                <summary>
                  {text(card().status === "unavailable" ? "own.image.line.why" : "own.image.line.before")} (
                  {earlier().length})
                </summary>
                <ul data-testid="image-line-steps">
                  <For each={earlier()}>
                    {(step) => (
                      <li>
                        {step.accountID === ""
                          ? step.label
                          : `${step.label} (${text(step.route === "codex" ? "own.image.line.codex" : "own.image.line.key")})`}
                        : {text(step.outcome === "skipped" ? "own.image.line.skipped" : "own.image.line.failed")}
                        {step.why ? ` · ${step.why}` : ""}
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
          </div>
        )
      }}
    </For>
  )
}

/**
 * The made image, tap to see it whole (MUX 2026-11-06): on a phone the card's 320 px picture is small. The dialog fills
 * the screen with the image at its own size within it; a tap, Esc or the app's back button closes it.
 */
function ImageView(props: {
  readonly uri: string
  readonly format: OwnImage.Format | undefined
  readonly alt: string
  readonly onLoad: () => void
}) {
  const text = useCatalogText(lineText)
  // A `blob:` URL, not the `data:` URI: Chromium keeps every `data:` URI an image loaded (./object-url.ts).
  const src = createMemo(() => imageSrc(props.uri) ?? props.uri)
  let dialog: HTMLDialogElement | undefined
  const close = () => dialog?.close()
  return (
    <>
      <button
        type="button"
        class="own-img-open"
        aria-label={text("own.image.line.open")}
        title={text("own.image.line.open")}
        data-testid="image-line-open"
        onClick={() => dialog?.showModal()}
      >
        <img src={src()} alt={props.alt} data-format={props.format} onLoad={() => props.onLoad()} />
      </button>
      <dialog
        ref={dialog}
        class="own-img-view"
        aria-label={text("own.image.line.open")}
        data-testid="image-line-view"
        onClick={close}
        onKeyDown={(event) => {
          // Synthetic Escape (the Android app's back, src/host/app-bridge.ts) does not close a dialog by itself.
          if (event.key === "Escape") close()
        }}
      >
        <img src={src()} alt={props.alt} data-format={props.format} />
        <button type="button" class="own-img-close" data-testid="image-line-close" onClick={close}>
          {text("own.image.line.close")}
        </button>
      </dialog>
    </>
  )
}
