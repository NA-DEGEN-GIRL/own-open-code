// `상세 보기` of a skill (SK2, 2026-10-24; 03 §19.6.1), its own lazy chunk: the SKILL.md frontmatter (every key), the
// body rendered as untrusted markdown (./detail-render: no scripts, remote images held back until asked), the files
// with sizes, every place it was found, the content hash and, for own-import's copy, where it came from and whether
// that source changed. Read only: own.import `skills.detail` (`read`) for another tool's skill (by key), own-import's
// copy or a skill core loads in a project; core's built-in skills have no folder, their text comes from core.
// 2026-10-25: the body is parsed in a worker with a time limit and shown as its text when that fails (never a blank
// detail); a value the service did not write out (YAML aliases, its budget) and a SKILL.md too large say so.
import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { formatSize } from "@/attachments/model"
import type { ServerRuntime } from "@/data"
import type { ImportOutput } from "@/data/import-rpc"
import { parseSkillBody, sanitizeSkillBody, type RenderedBody } from "./detail-render"
import { useSkillsImportText } from "./import-strings"

export type Detail = ImportOutput<"skills.detail">

/** own-import counts a skill's files up to one past this (`SkillFormat.MAX_FILES`): more is "over 500". */
const MAX_FILES = 500

/** What to show: a found skill (its approved links followed), own-import's copy, a loaded one, or a built-in one. */
export type DetailRequest =
  | { readonly kind: "found"; readonly key: string; readonly approvedLinks: ReadonlyArray<string> }
  | { readonly kind: "copy"; readonly id: string }
  | { readonly kind: "loaded"; readonly directory: string; readonly id: string }
  | {
      readonly kind: "builtin"
      readonly name: string
      readonly description?: string
      readonly body: string
      readonly path: string
    }

/** One place the skill was found, as the caller labels it. */
export interface DetailPlace {
  readonly label: string
  readonly path: string
  readonly modifiedAt?: number
  readonly version?: string
  /** The copy the row shows and imports. */
  readonly main?: boolean
  /** The same folder through a link. */
  readonly alias?: boolean
}

export interface SkillDetailProps {
  readonly runtime: ServerRuntime
  readonly request: DetailRequest
  /** The places, once the detail (its hash) is known. */
  readonly places: (detail: Detail | undefined) => ReadonlyArray<DetailPlace>
}

export default function SkillDetail(props: SkillDetailProps) {
  const text = useSkillsImportText()
  const [images, setImages] = createSignal(false)
  const [detail] = createResource(
    () => props.request,
    async (request): Promise<Detail> => {
      if (request.kind === "builtin")
        return {
          name: request.name,
          ...(request.description ? { description: request.description } : {}),
          directory: request.path,
          frontmatter: [],
          body: request.body,
          truncated: false,
          files: [],
          fileCount: 0,
          bytes: 0,
        }
      const rpc = props.runtime.imports
      if (request.kind === "copy") return rpc.call("skills.detail", { copy: request.id })
      if (request.kind === "loaded") return rpc.call("skills.detail", { directory: request.directory, loaded: request.id })
      return rpc.call("skills.detail", {
        key: request.key,
        ...(request.approvedLinks.length ? { approvedLinks: [...request.approvedLinks] } : {}),
      })
    },
  )
  const [parsed] = createResource(
    () => detail.latest?.body || undefined,
    (value) => parseSkillBody(value),
  )
  /** The body rendered, or as its text (`raw`) when the parse failed, ran too long or the sanitizer threw. */
  const body = createMemo((): RenderedBody | { readonly raw: string } | undefined => {
    const value = detail.latest?.body
    const result = parsed.latest
    if (!value || parsed.loading || result === undefined) return undefined
    if ("raw" in result) return { raw: value }
    // Untrusted HTML: whatever goes wrong while making it safe, the text still shows.
    try {
      return sanitizeSkillBody(result.html, { remoteImages: images(), image: text("own.skills.detail.image") })
    } catch {
      return { raw: value }
    }
  })
  const unread = () => {
    const state = detail.latest?.skillMd
    if (state === undefined) return undefined
    if (state.state === "too_large")
      return text("own.skills.detail.skillMd.too_large", { size: formatSize(state.size ?? 0) })
    return text(`own.skills.detail.skillMd.${state.state}`)
  }
  const places = createMemo(() => props.places(detail.latest))
  const date = (at: number) => new Date(at).toLocaleDateString()
  return (
    <section class="own-sk-detail" data-testid="skill-detail" aria-live="polite">
      <Show
        when={detail.latest}
        fallback={
          <p class="own-sk-state" data-tone={detail.error ? "danger" : undefined}>
            {text(detail.error ? "own.skills.detail.failed" : "own.skills.detail.loading")}
          </p>
        }
      >
        {(shown) => (
          <>
            <header class="own-sk-detail-head">
              <span class="own-sk-name" data-testid="skill-detail-name">
                {shown().name}
              </span>
              <Show when={shown().description}>
                <span class="own-sk-detail-desc">{shown().description}</span>
              </Show>
              <code class="own-sk-imp-path" title={shown().directory}>
                {shown().directory}
              </code>
            </header>
            <Show when={props.request.kind === "builtin"}>
              <p class="own-sk-imp-note">{text("own.skills.detail.builtin")}</p>
            </Show>
            <Show when={places().length}>
              <Part title={text("own.skills.detail.found")} testid="skill-detail-places">
                <ul class="own-sk-detail-list">
                  <For each={places()}>
                    {(place) => (
                      <li>
                        <span class="own-sk-line">
                          <span>{place.label}</span>
                          <Show when={place.main}>
                            <span class="own-sk-tag">{text("own.skills.import.placeMain")}</span>
                          </Show>
                          <Show when={place.alias}>
                            <span class="own-sk-tag">{text("own.skills.import.placeAlias")}</span>
                          </Show>
                          <Show when={place.version}>
                            {(version) => <span class="own-sk-detail-meta">{text("own.skills.import.version", { version: version() })}</span>}
                          </Show>
                          <Show when={place.modifiedAt}>
                            {(at) => <span class="own-sk-detail-meta">{text("own.skills.import.modified", { date: date(at()) })}</span>}
                          </Show>
                        </span>
                        <code class="own-sk-detail-path" title={place.path}>
                          {place.path}
                        </code>
                      </li>
                    )}
                  </For>
                </ul>
              </Part>
            </Show>
            <Show when={shown().imported}>
              {(imported) => (
                <Part title={text("own.skills.detail.imported")} testid="skill-detail-imported">
                  <span class="own-sk-line">
                    <span
                      class="own-sk-tag"
                      data-tone={imported().source === "changed" ? "warn" : undefined}
                      data-testid="skill-detail-source"
                    >
                      {text(`own.skills.detail.source.${imported().source}`)}
                    </span>
                    <span class="own-sk-detail-meta">
                      {text("own.skills.detail.importedAt", { date: date(imported().record.importedAt) })}
                    </span>
                  </span>
                  <code class="own-sk-detail-path" title={imported().record.source ?? imported().record.url}>
                    {imported().record.source ?? imported().record.url ?? imported().record.id}
                  </code>
                </Part>
              )}
            </Show>
            <Part title={text("own.skills.detail.frontmatter")} testid="skill-detail-frontmatter">
              <Show
                when={shown().frontmatter.length}
                fallback={
                  <p class="own-sk-imp-note" data-testid="skill-detail-unread">
                    {unread() ?? text("own.skills.detail.noFrontmatter")}
                  </p>
                }
              >
                <dl class="own-sk-detail-front">
                  <For each={shown().frontmatter}>
                    {(entry) => (
                      <>
                        <dt>{entry.key}</dt>
                        <Show when={entry.omitted} fallback={<dd>{entry.value}</dd>}>
                          {(omitted) => (
                            <dd class="own-sk-imp-note" data-omitted={omitted()}>
                              {text(`own.skills.detail.omitted.${omitted()}`)}
                            </dd>
                          )}
                        </Show>
                      </>
                    )}
                  </For>
                </dl>
              </Show>
            </Part>
            <Part title={text("own.skills.detail.body")} testid="skill-detail-body">
              <Show
                when={shown().body ? body() : undefined}
                fallback={
                  <p class="own-sk-imp-note">
                    {shown().body
                      ? text("own.skills.detail.rendering")
                      : unread()
                        ? text("own.skills.detail.noBodyRead")
                        : text("own.skills.detail.noBody")}
                  </p>
                }
              >
                {(view) => (
                  <Show
                    when={"html" in view() ? (view() as RenderedBody) : undefined}
                    fallback={
                      <>
                        <p class="own-sk-imp-note" data-testid="skill-detail-raw-note">
                          {text("own.skills.detail.raw")}
                        </p>
                        <pre class="own-sk-detail-raw" data-testid="skill-detail-raw">
                          {shown().body}
                        </pre>
                      </>
                    }
                  >
                    {(rendered) => (
                      <>
                        <Show when={rendered().hidden && !images()}>
                          <span class="own-sk-line">
                            <span class="own-sk-imp-note">
                              {text("own.skills.detail.remoteImages", { n: rendered().hidden })}
                            </span>
                            <button
                              type="button"
                              class="own-sk-link"
                              data-testid="skill-detail-images"
                              onClick={() => setImages(true)}
                            >
                              {text("own.skills.detail.showImages")}
                            </button>
                          </span>
                        </Show>
                        {/* Sanitized in ./detail-render: no script, style, frame, form or event attribute survives. */}
                        <div
                          class="own-sk-detail-body"
                          data-testid="skill-detail-markdown"
                          innerHTML={rendered().html}
                        />
                        <Show when={shown().truncated}>
                          <p class="own-sk-imp-note">{text("own.skills.detail.truncated")}</p>
                        </Show>
                      </>
                    )}
                  </Show>
                )}
              </Show>
            </Part>
            <Show when={props.request.kind !== "builtin"}>
              <Part
                title={
                  shown().fileCount > MAX_FILES
                    ? text("own.skills.detail.filesMany", { n: MAX_FILES })
                    : text("own.skills.detail.files", { n: shown().fileCount, size: formatSize(shown().bytes) })
                }
                testid="skill-detail-files"
              >
                <ul class="own-sk-detail-list own-sk-detail-files">
                  <For each={shown().files}>
                    {(file) => (
                      <li>
                        <code class="own-sk-detail-path" title={file.relative}>
                          {file.relative}
                        </code>
                        <span class="own-sk-detail-meta">{formatSize(file.size)}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={shown().fileCount > shown().files.length}>
                  <p class="own-sk-imp-note">
                    {shown().fileCount > MAX_FILES
                      ? text("own.skills.detail.firstFiles", { n: shown().files.length })
                      : text("own.skills.detail.moreFiles", { n: shown().fileCount - shown().files.length })}
                  </p>
                </Show>
              </Part>
              <Part title={text("own.skills.detail.hash")} testid="skill-detail-hash">
                <Show when={shown().hash} fallback={<p class="own-sk-imp-note">{text("own.skills.detail.noHash")}</p>}>
                  {(hash) => <code class="own-sk-detail-hash">{hash()}</code>}
                </Show>
              </Part>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}

function Part(props: { readonly title: string; readonly testid: string; readonly children: JSX.Element }) {
  return (
    <div class="own-sk-detail-part" data-testid={props.testid}>
      <h4 class="own-sk-imp-group-title">{props.title}</h4>
      {props.children}
    </div>
  )
}
