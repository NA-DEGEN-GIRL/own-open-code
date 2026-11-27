// The per-change entries of the manual's 10.13 (own/docs/manual/10-conversation-tools.md, between
// `<!-- prompt-changes:start -->` and `<!-- prompt-changes:end -->`): one line per change own's 개선판 makes, with its
// anchor (`pc-<id>`, where 설정 > 에이전트 방식's `자세히` opens the manual), its title, the approval modes it is limited
// to and its reason, grouped by harness and by the models that get it. Everything comes from variant.ts through
// `prompt.preview` (the page's own source), so the manual cannot drift from what runs: test/unit/prompt-manual.test.ts
// fails on a stale block.
//
//   bun run prompt-manual            (from packages/own-harness) rewrite the block
//   bun run prompt-manual --check    exit 1 when the block is stale
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect } from "effect"
import { Prompts } from "../src/prompts.js"

export const MANUAL = path.join(import.meta.dir, "../../../own/docs/manual/10-conversation-tools.md")
const START = "<!-- prompt-changes:start -->"
const END = "<!-- prompt-changes:end -->"

/** A change's manual anchor: `codex.base.where` → `pc-codex-base-where` (own-web harness/prompt-compare.ts, the same rule). */
export function anchor(id: string) {
  return `pc-${id.replaceAll(".", "-")}`
}

/**
 * One model per Codex tier: Codex's catalog (no change applies), the lean tier, the fallback tier. The group headings
 * below and 10.13's table name these tiers' model families; test/unit/prompt-manual.test.ts holds them to
 * CodexVariant.lean.
 */
export const MODELS = {
  catalog: { providerID: "openai", modelID: "gpt-5.5" },
  lean: { providerID: "anthropic", modelID: "claude-opus-5-5" },
  fallback: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
} as const
const MODES: ReadonlyArray<OwnHarness.ApprovalMode> = ["full", "ask", "read-only"]
const MODE_NAME: Record<OwnHarness.ApprovalMode, string> = { full: "전체 허용", ask: "묻기", "read-only": "읽기 전용" }

/** Who gets a change: the harness, and for Codex the tier of models outside its catalog. */
export const GROUPS = [
  { harness: "codex", models: "all", title: "Codex 방식 · Codex 목록 밖의 모든 모델" },
  { harness: "codex", models: "lean", title: "Codex 방식 · Claude Opus 4.8 이후, Fable, Mythos" },
  { harness: "codex", models: "fallback", title: "Codex 방식 · 그 밖의 목록 밖 모델(Claude Sonnet, DeepSeek 등)" },
  { harness: "pi", models: "all", title: "Pi 방식 · 모든 모델" },
  { harness: "dsh", models: "all", title: "DeepSeek 방식 · 모든 모델" },
] as const

export interface Entry {
  readonly harness: OwnHarness.CustomHarnessID
  readonly models: "all" | "lean" | "fallback"
  readonly id: string
  readonly title: string
  readonly why: string
  /** The approval modes it is made in, when not all of them. */
  readonly modes?: ReadonlyArray<OwnHarness.ApprovalMode>
}

/**
 * Every change of every harness with a 개선판, in the page's order. A change that applies to none of the sampled
 * models, or in no approval mode, has no true place in the list: it fails here rather than land in a wrong group.
 */
export async function entries(): Promise<ReadonlyArray<Entry>> {
  const runs = async (harness: OwnHarness.CustomHarnessID, model: Prompts.Input["model"]) =>
    Promise.all(
      MODES.map((mode) =>
        Effect.runPromise(Prompts.preview(context(), { harness, prompt: "own", model, mode })).then((preview) => ({
          mode,
          preview,
        })),
      ),
    )
  const lean = await runs("codex", MODELS.lean)
  const fallback = await runs("codex", MODELS.fallback)
  const pi = await runs("pi", MODELS.fallback)
  const dsh = await runs("dsh", MODELS.fallback)
  const codex = fallback[0]!.preview.changes.map((change) => {
    const inLean = applying(lean, change.id)
    const inFallback = applying(fallback, change.id)
    if (inLean.length === 0 && inFallback.length === 0)
      throw new Error(
        `${change.id} applies to neither sampled Codex model (${MODELS.lean.modelID}, ${MODELS.fallback.modelID})`,
      )
    const models = inLean.length > 0 && inFallback.length > 0 ? "all" : inLean.length > 0 ? "lean" : "fallback"
    return entry("codex", models, change, [...new Set([...inLean, ...inFallback])])
  })
  const every = (harness: "pi" | "dsh", list: typeof pi) =>
    list[0]!.preview.changes.map((change) => entry(harness, "all", change, applying(list, change.id)))
  return [...codex, ...every("pi", pi), ...every("dsh", dsh)]
}

function applying(
  runs: ReadonlyArray<{ readonly mode: OwnHarness.ApprovalMode; readonly preview: OwnHarness.PromptPreview }>,
  id: string,
) {
  return runs
    .filter((run) => run.preview.changes.some((change) => change.id === id && change.applies))
    .map((run) => run.mode)
}

function entry(
  harness: OwnHarness.CustomHarnessID,
  models: Entry["models"],
  change: OwnHarness.PromptChange,
  modes: ReadonlyArray<OwnHarness.ApprovalMode>,
): Entry {
  if (modes.length === 0) throw new Error(`${change.id} applies in no approval mode`)
  return {
    harness,
    models,
    id: change.id,
    title: change.title,
    why: change.why,
    ...(modes.length === MODES.length ? {} : { modes: MODES.filter((mode) => modes.includes(mode)) }),
  }
}

/**
 * The block between the markers, as the manual has it. Each group's list is an HTML block: the anchor is the list
 * item's id (`li:target` in manual.css marks the one a link opened), which Markdown has no syntax for.
 */
export function block(list: ReadonlyArray<Entry>) {
  const groups = GROUPS.flatMap((group) => {
    const items = list
      .filter((item) => item.harness === group.harness && item.models === group.models)
      .map((item) => {
        const modes = item.modes ? ` (승인 모드 ${item.modes.map((mode) => MODE_NAME[mode]).join("·")}에서만)` : ""
        return `<li id="${anchor(item.id)}"><strong>${html(item.title)}</strong>${modes}: ${html(item.why)}</li>`
      })
    return items.length === 0 ? [] : [`**${group.title}**\n\n<ul class="pc-list">\n${items.join("\n")}\n</ul>`]
  })
  return [
    START,
    "<!-- 이 목록은 packages/own-harness에서 `bun run prompt-manual`이 variant.ts로 채워요. 손으로 고치지 마세요. -->",
    "",
    groups.join("\n\n"),
    "",
    END,
  ].join("\n")
}

/** The manual's text with the block replaced; `undefined` when it has no markers. */
export function rewrite(text: string, next: string) {
  const at = text.indexOf(START)
  const end = text.indexOf(END)
  if (at < 0 || end < at) return undefined
  return `${text.slice(0, at)}${next}${text.slice(end + END.length)}`
}

function html(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** What `prompt.preview` reads: no enabled model (the asked one is previewed), no tools or agents, no saved 내 지시문. */
export function context() {
  // SAFETY: preview reads only these members of the context (prompts.ts `Ctx`).
  return {
    model: { list: () => Effect.succeed({ data: [] }) },
    tool: { list: () => Effect.succeed([]) },
    agent: { list: () => Effect.succeed({ data: [] }) },
    storage: { get: () => Effect.succeed(undefined) },
    location: { directory: "C:\\work\\app" },
  } as unknown as Pick<Context, "model" | "tool" | "storage" | "location" | "agent">
}

if (import.meta.main) {
  const text = await Bun.file(MANUAL).text()
  const next = rewrite(text, block(await entries()))
  if (next === undefined) throw new Error(`${MANUAL} has no ${START} … ${END} block`)
  const check = process.argv.includes("--check")
  if (check && next !== text) {
    console.error("the manual's 10.13 change list is stale: run `bun run prompt-manual` in packages/own-harness")
    process.exit(1)
  }
  if (!check && next !== text) await Bun.write(MANUAL, next)
  console.log(next === text ? "the manual's 10.13 change list is up to date" : `wrote ${MANUAL}`)
}
