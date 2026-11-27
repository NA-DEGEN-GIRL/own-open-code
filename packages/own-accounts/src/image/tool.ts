export * as ImageTool from "./tool.js"

import fs from "node:fs/promises"
import path from "node:path"
import type { SkillEditor } from "@opencode/plugin/promise/skill"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import { Tool } from "@opencode/schema/tool"
import { OwnID, OwnImage, Policy } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import type { Modules } from "../modules.js"
import { ImageFormat } from "./format.js"
import { ImageService } from "./service.js"
import prompting from "./skill/prompting.md" with { type: "text" }
import samples from "./skill/sample-prompts.md" with { type: "text" }
import skillText from "./skill/SKILL.md" with { type: "text" }

/**
 * own's image tool and the `imagegen` skill (02 §9.6, 설명서 10.17 이미지 만들기, decisions IM).
 * - While `policy.imageGenerate` is on (설정 > 이미지 만들기, off by default since US5), own
 *   lists its own `image_generate` and never core's `generate_image` (`experimental_image_generate` before v2.4.0): core's tool asks the provider
 *   through core's image client, which carries no own-slot credential (own injects them per session request, and
 *   stateless generation has no such hook), and it cannot fall back from key to key or to a subscription. Off, neither
 *   is listed, as before.
 * - The tool takes `model` only when the family lets the conversation's model choose (`auto`: GPT Image 2.6 Flare or
 *   Sunburst); a fixed family takes none, and a model outside the family is refused (a retired 2.5 id too, IM-16).
 * - `complexity` (IM-17) is offered only while every model of the family takes it (the 2.6 families) and forwarded only
 *   to such a model; the Codex fallback never gets it. So are `output_format` (png, jpeg, webp; with 2.6 also an animated
 *   gif and svg: IM-21) and `markup` (a transparent PNG annotation layer over the first image: IM-22); anything but a
 *   plain PNG is for API keys only. A GIF's fixed size is lowered to the largest frame that fits OpenAI's sheet for the
 *   frame count (IM-32); an SVG always names its author model and is priced with it (IM-33, IM-34).
 * - The saved file, its extension, the file part and the card follow the real bytes (IM-23): a GIF reaches the model as
 *   its first frame and the card as the animation; an SVG never reaches the model as an image and the card shows it
 *   only as an `<img>`.
 * - The image comes back into the conversation (the result's file part, like a read image) and is saved under
 *   `<OWN_HOME>\images\<session>\` or, with `path`, at the project path the user asked for (asked like an edit).
 * - The result card's data (`metadata.ownImage`, `OwnImage.CardData`) names the model, the account, the cost and every
 *   account tried or skipped; own-web draws it under the tool card with the buttons to add a key and to open the
 *   settings when no key could make the image.
 * - The skill `imagegen` (adapted from Codex's, `skill/MODIFICATIONS.md`) is listed always, as own's built-in skill
 *   (`/builtin/own/imagegen.md`), with a model section that follows the user's family; it tells the model what to say
 *   while the tool is off.
 * Re-folded when `policy.json` changes, here and through the remote mirror. Returns the unsubscribe.
 */

export const NAME = OwnImage.TOOL
export const SKILL_ID = "imagegen"
export const SKILL_PATH = "/builtin/own/imagegen.md"
/** Input images above this size are refused (OpenAI takes up to 50 MB; 20 MiB as core's tool). */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024

export async function register(deps: Deps, modules: Modules.All) {
  const log = deps.log.child("image-tool")
  const hook = Hooks.guard(log)
  const service = ImageService.create(deps, modules)
  const state = { enabled: Policy.imageGenerate(deps.runtime.policy.cached()), family: family(deps) }
  await deps.ctx.tool.transform((editor) =>
    hook.sync("tool.transform:image", () => fold(editor, state.enabled, state.family, (input, context) => run(deps, service, input, context))),
  )
  await deps.ctx.skill.transform((editor) => hook.sync("skill.transform:imagegen", () => addSkill(editor, state.family)))
  const refresh = async () => {
    const policy = await deps.runtime.policy.read()
    const enabled = Policy.imageGenerate(policy)
    const next = OwnImage.resolve(policy?.image).family
    if (enabled === state.enabled && next === state.family) return
    const skill = next !== state.family
    state.enabled = enabled
    state.family = next
    await deps.ctx.tool.reload()
    if (skill) await deps.ctx.skill.reload()
  }
  return deps.runtime.broadcast.on("store.changed", (payload) => {
    if (payload.store !== "policy") return
    void refresh().catch((error: unknown) => log.error("image_tool_reload_failed", { error }))
  })
}

function family(deps: Deps) {
  return OwnImage.resolve(deps.runtime.policy.cached()?.image).family
}

/** The tool fold: core's image and video tools never; own's image tool while the setting is on. */
export function fold(editor: ToolEditor, enabled: boolean, family: OwnImage.Family, execute: Execute) {
  editor.remove(Policy.IMAGE_GENERATE_TOOL)
  // Core's video tool (v2.4.0) has no own counterpart: it would spend on any connected provider's video model unasked.
  editor.remove(Policy.VIDEO_GENERATE_TOOL)
  // Core's automations (v2.4.0) schedule work own-web cannot show (Policy.AUTOMATION_TOOLS).
  for (const id of Policy.AUTOMATION_TOOLS) editor.remove(id)
  if (!enabled) return
  // A direct tool, never one of Code Mode's (as core's image tool): one call is one paid image, and its result carries
  // the image itself.
  editor.add({ name: NAME, description: description(family), input: inputSchema(family), options: { codemode: false }, execute })
}

type Execute = (input: unknown, context: ToolContext) => Promise<Tool.Result>

export function description(family: OwnImage.Family) {
  const models = OwnImage.models(family)
  return [
    "Generates a new image, or edits existing ones, with the user's OpenAI API key accounts (own keeps the keys; never ask for one).",
    "Only call this when the user asks you to create or edit an image. If an image would help but the user didn't ask, ask first.",
    "Each call makes one image and costs money or subscription usage. For several images, call once per image. Don't repeat a call unless the user asks.",
    OwnImage.chooses(family)
      ? `Choose \`model\` per image: ${OwnImage.FLARE} (default; fast everyday generation) or ${OwnImage.SUNBURST} (precise edits, exact text, compositing, high-fidelity finals). Load the imagegen skill for guidance.`
      : `The user fixed the model to ${models[0]}; this tool takes no model.`,
    ...(complexity(family)
      ? ["Optional `complexity` (low|medium|high) sets how much the model plans before rendering: low for focused edits, high for dense text and complex layouts; omit for the model's default."]
      : []),
    `Optional \`output_format\` (${OwnImage.familyFormats(family).join("|")}; default png).${
      gif(family)
        ? " gif makes a short animated loop (frame_count, frame_duration_ms; all frames share one sheet, so each frame is at most 960x960 for 2-9 frames, 816x816 for 10-12 and 720x720 for 13-16, and a larger size is lowered to that); svg makes static vector art (icons, logos, simple illustrations) from the prompt alone, without images."
        : ""
    } Anything but png needs an OpenAI API key: a ChatGPT subscription makes PNG only.`,
    ...(markup(family)
      ? ["Optional `markup`: the path of a transparent PNG exactly the size of images[0] with circles, arrows or sketches marking where to change it; say in the prompt what to change there."]
      : []),
    "The result shows the image, the saved path, the model, the account and the cost. Pass `path` to save it into the project.",
  ].join("\n")
}

export function inputSchema(family: OwnImage.Family) {
  return {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1, description: "The full spec: what to create, or for edits what to change and what must stay." },
      ...(OwnImage.chooses(family)
        ? {
            model: {
              type: "string",
              enum: [...OwnImage.models(family)],
              description: `${OwnImage.FLARE} (default) for everyday images; ${OwnImage.SUNBURST} for precise edits and high-fidelity work.`,
            },
          }
        : {}),
      images: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        maxItems: 8,
        description: "Paths of images to edit or use as references, in order (attached images' paths, earlier results' paths, project files).",
      },
      path: { type: "string", description: "Where to save the image in the project; the extension follows the real format. Omit for a preview." },
      quality: { type: "string", enum: ["low", "medium", "high", "auto"], description: "Omit to use the user's default." },
      size: {
        type: "string",
        enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
        description: gif(family)
          ? "Omit to use the user's default. For a gif it is each frame's shape: the frames share one sheet, so the tool lowers it to the largest frame of that shape that fits frame_count (square: 960x960 for 2-9 frames, 816x816 for 10-12, 720x720 for 13-16)."
          : "Omit to use the user's default.",
      },
      background: { type: "string", enum: ["transparent", "opaque", "auto"], description: "transparent for cutouts (png or webp only); otherwise omit." },
      output_format: {
        type: "string",
        enum: [...OwnImage.familyFormats(family)],
        description: gif(family)
          ? "png (default), jpeg or webp; gif for a short animated loop; svg for static vector art (no images). Anything but png needs an OpenAI API key."
          : "png (default), jpeg or webp. Anything but png needs an OpenAI API key.",
      },
      ...(gif(family)
        ? {
            frame_count: {
              type: "integer",
              minimum: OwnImage.GIF_FRAMES.min,
              maximum: OwnImage.GIF_FRAMES.max,
              description: `GIF only: frames in the loop (default ${OwnImage.GIF_FRAMES.default}). All frames share one sheet: 2-8 frames an 8-cell sheet, 9 a 3x3 sheet (both up to 960x960 frames), 10-16 a 4x3 or 4x4 sheet with smaller frames.`,
            },
            frame_duration_ms: {
              type: "integer",
              minimum: OwnImage.GIF_FRAME_MS.min,
              maximum: OwnImage.GIF_FRAME_MS.max,
              description: `GIF only: milliseconds per frame (default ${OwnImage.GIF_FRAME_MS.default}).`,
            },
          }
        : {}),
      ...(markup(family)
        ? {
            markup: {
              type: "string",
              minLength: 1,
              description:
                "Edits only: path of a transparent PNG annotation layer exactly the size of images[0] (marks over transparent pixels, not flattened onto the image).",
            },
          }
        : {}),
      ...(complexity(family)
        ? {
            complexity: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Planning depth before rendering: low for focused edits, high for dense text or complex layouts. Omit for the model's default.",
            },
          }
        : {}),
    },
    required: ["prompt"],
    additionalProperties: false,
  } as const
}

/** Whether the tool offers `complexity`: every model the family allows takes it (IM-17). */
function complexity(family: OwnImage.Family) {
  return OwnImage.models(family).every(OwnImage.takesComplexity)
}

/** Whether the tool offers GIF (and SVG): every model the family allows makes them (IM-21). */
function gif(family: OwnImage.Family) {
  return OwnImage.familyFormats(family).includes("gif")
}

/** Whether the tool offers `markup`: every model the family allows takes it (IM-22). */
function markup(family: OwnImage.Family) {
  return OwnImage.models(family).every(OwnImage.takesMarkup)
}

/** The `imagegen` skill as own lists it: the adapted SKILL.md with the family's model section, then its references. */
export function addSkill(editor: SkillEditor, family: OwnImage.Family) {
  const body = skillText.replace(/^---[\s\S]*?---\n/, "").replace("{{MODEL_SECTION}}", modelSection(family))
  editor.add(
    Skill.Info.make({
      id: Skill.ID.make(SKILL_ID),
      name: Skill.Name.make(SKILL_ID),
      description: skillDescription(family),
      path: AbsolutePath.make(SKILL_PATH),
      content: [body.trim(), prompting.trim(), samples.trim()].join("\n\n---\n\n"),
    }),
  )
}

/** The skill's one line; GIF and SVG only where the family makes them (IM-21). */
export function skillDescription(family: OwnImage.Family) {
  return gif(family)
    ? "Generate or edit images (photos, illustrations, textures, sprites, mockups, transparent cutouts, short animated GIF loops, new SVG icons and logos) with own's image_generate tool. Use when the user wants a new image, a change to an existing image, or variants from references. Not for editing existing SVG/vector or code-native assets."
    : "Generate or edit raster images (photos, illustrations, textures, sprites, mockups, transparent cutouts) with own's image_generate tool. Use when the user wants a new image, a change to an existing image, or variants from references. Not for SVG/vector/code-native assets."
}

export function modelSection(family: OwnImage.Family) {
  if (OwnImage.chooses(family))
    return [
      "### Choosing the model",
      "",
      "The user lets you choose the model for each image (`model`):",
      `- \`${OwnImage.FLARE}\` (default): the fastest. Use it for everyday generation: drafts, illustrations, icons, simple scenes, quick variants, and most single images.`,
      `- \`${OwnImage.SUNBURST}\`: the most capable for generation and editing. Use it for precise edits that must keep faces, products, logos or layout intact, multi-image compositing, exact or dense in-image text (posters, infographics, labelled diagrams), and premium high-fidelity finals the user says matter. It is slower.`,
      "- Both cost the same per token; the difference is speed and fidelity. When unsure, use Flare; move to Sunburst when a Flare result missed exactly what Sunburst is for.",
      "- Say in one short line which model you used and why.",
      "",
      COMPLEXITY_TEXT,
      "",
      FORMATS_TEXT,
      "",
      MARKUP_TEXT,
    ].join("\n")
  const model = OwnImage.defaultModel(family)
  return [
    "### Model",
    "",
    `The user fixed the model to \`${model}\` in settings, so the tool takes no \`model\`. If they ask for another model, tell them it is chosen in 설정 > 이미지 만들기 > 모델 (API 키).`,
    ...(family === "gpt-image-2"
      ? [
          "",
          "`gpt-image-2` does not make transparent backgrounds; for a cutout, tell the user a GPT Image 2.6 model is needed.",
          "",
          "### Formats",
          "",
          "`output_format` takes `png` (the default), `jpeg` or `webp`; anything but png needs an OpenAI API key (a ChatGPT subscription makes PNG only). Animated GIFs, SVG output and markup edits need a GPT Image 2.6 model: if the user asks for one, tell them the model is chosen in 설정 > 이미지 만들기 > 모델 (API 키).",
        ]
      : ["", COMPLEXITY_TEXT, "", FORMATS_TEXT, "", MARKUP_TEXT]),
  ].join("\n")
}

const COMPLEXITY_TEXT = [
  "### Complexity",
  "",
  "GPT Image 2.6 plans an image before rendering it; `complexity` sets how much, apart from `quality`:",
  "- `low` for focused edits that change one thing (a background swap, a recolor, removing an object) and quick drafts;",
  "- `medium` for ordinary scenes and illustrations;",
  "- `high` for dense or exact text, infographics, labelled diagrams, many subjects or complex layouts.",
  "- Omit it to use the model's default (OpenAI: `high`). It costs the same per token, but more planning can take longer.",
].join("\n")

const FORMATS_TEXT = [
  "### Formats",
  "",
  "`output_format` picks the file. Leave it unset (`png`) for an ordinary image.",
  "- `jpeg`: a photo without transparency, smaller and a little faster; `webp`: small, and keeps transparency.",
  "- `gif`: a short animated loop of 2-16 frames (`frame_count`, OpenAI's default 9) at 20-2000 ms each (`frame_duration_ms`, default 200). Use it for simple loops: a waving or blinking character, a reaction sticker, a spinner, a pulsing icon, a small sprite cycle. Describe the subject, the motion and the loop in the prompt (the last frame returns to the first pose for a seamless loop) and keep the camera fixed. Pass still images in `images` to guide it. No transparent background. You see only its first frame; the user sees the animation.",
  "  - Sizes: `size` is each frame's shape. OpenAI renders every frame on one sheet of at most 3840 px a side and 8,294,400 pixels (2-8 frames on a 4x2 sheet, 9 on 3x3, 10-12 on 4x3, 13-16 on 4x4), so the tool lowers a fixed size to the largest frame of that shape that fits and says so: square 960x960 for 2-9 frames, 816x816 for 10-12, 720x720 for 13-16; landscape 1200x800, 1152x768, 1008x672, 864x576 (portrait the same turned). `auto` lets OpenAI pick.",
  "  - Frame count: up to 9 frames (OpenAI's default) keep the full 960x960 frame; more frames mean smaller frames. A GIF costs more than a still (a 3-frame 960x960 loop at low quality cost about 1.5 times a 1024x1024 PNG). Use 3-9 frames for most loops and more only for smooth motion that needs it.",
  `- \`svg\`: static vector art with editable paths, shapes and colors: an icon, a logo or mark, a simple flat illustration. From the prompt alone (no \`images\`, no \`markup\`). OpenAI renders a reference image (\`quality\` and \`complexity\` apply to it) and an authoring model writes the SVG; the result has no scripts, external resources or embedded raster images. The tool asks OpenAI for \`${OwnImage.SVG_AUTHOR}\` as the authoring model; the cost shown covers the reference image and the authoring tokens. You are not shown the SVG as an image: read the saved file for its source. A simple shape, or an icon that must match an existing set, is better written by hand.`,
  "- Anything but `png` needs one of the user's OpenAI API keys with GPT Image 2.6; a ChatGPT subscription makes PNG only, so when every key is used up the tool says no account can make it. OpenAI may also refuse GIF or SVG for a key whose project has no access to them yet: relay the refusal, do not retry in a loop.",
].join("\n")

const MARKUP_TEXT = [
  "### Markup edits",
  "",
  "To show where an edit goes, pass `markup`: the path of a PNG annotation layer for `images[0]` (the edit target; later images stay references).",
  "- The layer is exactly the size of `images[0]` and transparent except for the marks: a circle around the object, an arrow, a rough sketch of a new shape. Never flatten the marks onto the image itself; the tool refuses a PNG without transparency or of another size.",
  "- The user may give you the layer. Otherwise you can draw it yourself with the tools you have, for example a short script that creates a transparent PNG of the image's width and height and draws a red circle where the change goes.",
  "- Say in the prompt what to do at the marks and that they must not appear in the result (`recolor the vase inside the red circle ...; remove the red circle`), and what must stay unchanged.",
  "- Markup is for GPT Image 2.6 edits with an OpenAI API key only (a ChatGPT subscription cannot do it). It costs the same as any other edit.",
].join("\n")

interface Input {
  readonly prompt: string
  readonly model?: string
  readonly images?: ReadonlyArray<string>
  readonly path?: string
  readonly quality?: OwnImage.Quality
  readonly size?: OwnImage.Size
  readonly background?: "transparent" | "opaque" | "auto"
  readonly complexity?: OwnImage.Complexity
  readonly output_format?: OwnImage.Format
  readonly frame_count?: number
  readonly frame_duration_ms?: number
  readonly markup?: string
}

/** One call: checks, the chain, the file, the ledger line and the result card. */
export async function run(deps: Deps, service: ImageService.Api, raw: unknown, context: ToolContext): Promise<Tool.Result> {
  const input = raw as Input
  const resolved = service.setting()
  const allowed = OwnImage.models(resolved.family)
  if (input.model !== undefined && !allowed.includes(input.model))
    throw new Tool.Error({
      message: OwnImage.chooses(resolved.family)
        ? `Model "${input.model}" is not available here. Use ${allowed.join(" or ")}, or omit model.`
        : `The user fixed the image model to ${allowed[0]}; omit model.`,
    })
  const model = input.model ?? OwnImage.defaultModel(resolved.family)
  check(input, model)
  // Nothing can make it: the card with each source's reason, no approval asked and no request sent (IM-13). The chain
  // run below sends nothing then, since every source is skipped. A placeholder layer stands for `markup` (not read yet):
  // only its presence decides which sources could answer.
  const needs = {
    ...(input.output_format ? { format: input.output_format } : {}),
    ...(input.markup ? { markup: { bytes: new Uint8Array(0), name: input.markup } } : {}),
  }
  if (!(await service.available(needs))) {
    const dry = await service.generate({ sessionID: context.sessionID, prompt: input.prompt, images: [], signal: context.signal, ...needs })
    return unavailable(dry.steps, ImageService.keyOnly(needs))
  }
  const images = await Promise.all((input.images ?? []).map((source) => readImage(deps, source, context)))
  const markup = input.markup === undefined ? undefined : await readMarkup(deps, input.markup, images[0]!, context)
  const asked = input.output_format ?? "png"
  // A GIF's frames share one sheet within OpenAI's size limits: a fixed size becomes the largest frame of its shape that
  // fits the frame count (IM-32), said in the result and the card.
  const size = input.size ?? resolved.size
  const sent = asked === "gif" ? OwnImage.gifSize(size, input.frame_count ?? OwnImage.GIF_FRAMES.default) : size
  // Asked like an edit of the file it will be: the extension follows the format asked for (and the real one, below).
  const target =
    input.path === undefined ? undefined : await projectTarget(deps, withExtension(input.path, OwnImage.EXTENSION[asked]), context)
  await deps.ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    action: NAME,
    resources: [model],
    save: ["*"],
    metadata: { model, prompt: input.prompt },
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })
  const outcome = await service.generate({
    sessionID: context.sessionID,
    prompt: input.prompt,
    model,
    ...(input.quality ? { quality: input.quality } : {}),
    size: sent,
    ...(input.background ? { background: input.background } : {}),
    ...(input.complexity && OwnImage.takesComplexity(model) ? { complexity: input.complexity } : {}),
    ...(input.output_format ? { format: input.output_format } : {}),
    ...(input.frame_count === undefined ? {} : { frames: input.frame_count }),
    ...(input.frame_duration_ms === undefined ? {} : { frameMs: input.frame_duration_ms }),
    ...(markup ? { markup } : {}),
    images,
    signal: context.signal,
    progress: (steps, trying) =>
      void context
        .progress({
          [OwnImage.CARD_KEY]: { status: "running", account: trying.label, route: trying.route, steps } satisfies Card,
        })
        .catch(() => undefined),
  })
  deps.log.info("image_call", {
    outcome: outcome.type,
    steps: outcome.steps.length,
    ...(input.output_format ? { format: input.output_format } : {}),
    ...(outcome.type === "done" ? { route: outcome.route, model: outcome.model, providerID: outcome.account.providerID } : {}),
    ...(outcome.type === "refused" ? { status: outcome.status, code: outcome.code } : {}),
  })
  if (outcome.type === "unavailable") return unavailable(outcome.steps, ImageService.keyOnly(needs))
  if (outcome.type === "refused")
    throw new Tool.Error({
      message: `The image request was refused (${outcome.code ?? `HTTP ${outcome.status}`}). ${stepsText(outcome.steps)}`,
      metadata: { [OwnImage.CARD_KEY]: { status: "failed", steps: outcome.steps } satisfies Card },
    })
  // The ledger line first: the image is paid for even if saving it fails. An API key's tokens and USD, a subscription's
  // none (it counts against the plan's limits).
  await service
    .record(outcome, context.sessionID)
    .catch((error: unknown) => deps.log.warn("image_ledger_failed", { error }))
  // The bytes decide the extension, the MIME and the card, whatever was asked or declared (IM-23).
  const format = ImageFormat.sniff(outcome.bytes) ?? declared(outcome.format)
  const file = target
    ? withExtension(target, OwnImage.EXTENSION[format])
    : path.join(deps.runtime.layout.root, "images", context.sessionID, `image_${OwnID.ulid(deps.clock.now())}${OwnImage.EXTENSION[format]}`)
  // Another format than asked lands on another project file: that one is asked too.
  if (target && file !== target) await projectTarget(deps, file, context)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, outcome.bytes)
  const animation = format === "gif" ? ImageFormat.gifFrames(outcome.bytes) : undefined
  const card: Card = {
    status: "done",
    model: outcome.model,
    route: outcome.route,
    account: outcome.account.label,
    ...(outcome.costUSD === undefined ? {} : { costUSD: outcome.costUSD }),
    path: file,
    format,
    ...(format === asked ? {} : { asked }),
    ...(animation ? { frames: animation.frames } : {}),
    ...(sent === size ? {} : { resized: { from: size, to: sent } }),
    ...(format === "gif" || format === "svg" ? { preview: dataURI(outcome.bytes, OwnImage.MIME[format]) } : {}),
    ...(outcome.svgUsage ? { svgAuthor: outcome.svgUsage } : {}),
    steps: outcome.steps,
  }
  const via =
    outcome.route === "key"
      ? `OpenAI API key "${outcome.account.label}"`
      : `ChatGPT subscription "${outcome.account.label}" (Codex's model; counts against that plan's limits)`
  const cost = outcome.costUSD === undefined ? "" : `, cost $${outcome.costUSD.toFixed(4)}`
  // What the conversation's model is shown (IM-23): a raster image as it is; a GIF as its first frame only (a still
  // every model reading images takes, where some refuse an animation, and a refused image fails every later request);
  // an SVG not at all (no model takes SVG as an image): it is text the model may read from the file.
  const shown =
    format === "svg"
      ? undefined
      : format === "gif"
        ? animation && { bytes: animation.first, mime: OwnImage.MIME.gif, name: `${path.parse(file).name}-frame1.gif` }
        : { bytes: outcome.bytes, mime: OwnImage.MIME[format], name: path.basename(file) }
  return {
    content: [
      {
        type: "text",
        text: [
          `Image saved: ${file}`,
          `Model ${outcome.model} via ${via}${cost}.`,
          format === asked ? "" : `Asked for ${asked} but the image came back as ${format}; tell the user.`,
          format !== "gif"
            ? ""
            : animation
              ? `Animated GIF, ${animation.frames} frames; the image below is its first frame only. The user sees the animation in the card.`
              : "Animated GIF; its frames could not be read, so it is not shown to you. The user sees it in the card.",
          sent === size
            ? ""
            : `Frames are ${sent}: ${size} frames do not fit ${input.frame_count ?? OwnImage.GIF_FRAMES.default} frames on OpenAI's GIF sheet (all frames on one image of at most ${OwnImage.SHEET_LIMITS.maxEdge} px a side and ${OwnImage.SHEET_LIMITS.maxPixels.toLocaleString("en-US")} pixels), so the largest frame of that shape that fits was used.`,
          format === "svg"
            ? `SVG, ${outcome.bytes.length} bytes of static vector markup. It is not shown to you as an image; read the file if you need its source. The user sees it in the card.`
            : "",
          outcome.svgUsage
            ? `SVG authoring by ${outcome.svgUsage.model || "OpenAI's authoring model"}: ${outcome.svgUsage.input} input and ${outcome.svgUsage.output} output tokens${
                outcome.svgUsage.costUSD === undefined
                  ? ", billed at that model's rates and not in the cost above."
                  : ` ($${outcome.svgUsage.costUSD.toFixed(4)}, included in the cost above).`
              }`
            : "",
          skippedText(outcome.steps),
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      },
      ...(shown ? [{ type: "file" as const, uri: dataURI(shown.bytes, shown.mime), mime: shown.mime, name: shown.name }] : []),
    ],
    metadata: { [OwnImage.CARD_KEY]: card },
  }
}

/** The arguments' own rules, before anything is read, asked or sent (IM-21, IM-22). */
function check(input: Input, model: string) {
  const format = input.output_format
  const fail = (message: string) => {
    throw new Tool.Error({ message })
  }
  if (format !== undefined && !OwnImage.formats(model).includes(format))
    fail(`output_format "${format}" is not available with ${model}. Use ${OwnImage.formats(model).join(", ")}.`)
  if ((input.frame_count !== undefined || input.frame_duration_ms !== undefined) && format !== "gif")
    fail("frame_count and frame_duration_ms are for output_format gif only.")
  if (input.frame_count !== undefined && !within(input.frame_count, OwnImage.GIF_FRAMES))
    fail(`frame_count must be a whole number from ${OwnImage.GIF_FRAMES.min} to ${OwnImage.GIF_FRAMES.max}.`)
  if (input.frame_duration_ms !== undefined && !within(input.frame_duration_ms, OwnImage.GIF_FRAME_MS))
    fail(`frame_duration_ms must be a whole number from ${OwnImage.GIF_FRAME_MS.min} to ${OwnImage.GIF_FRAME_MS.max}.`)
  if (format === "svg" && (input.images?.length ?? 0) > 0)
    fail("An SVG is made from the prompt alone: OpenAI's edit endpoint makes no SVG. Omit images, or ask for png or webp.")
  if (input.background === "transparent" && format !== undefined && format !== "png" && format !== "webp")
    fail("A transparent background needs output_format png or webp.")
  if (input.markup === undefined) return
  if (!OwnImage.takesMarkup(model)) fail(`markup needs a GPT Image 2.6 model, not ${model}.`)
  if ((input.images?.length ?? 0) === 0) fail("markup marks images[0]: pass the image to change first in images.")
}

function within(value: number, range: { readonly min: number; readonly max: number }) {
  return Number.isInteger(value) && value >= range.min && value <= range.max
}

/** OpenAI's declared `output_format`, for bytes own does not recognize (they always should be one it does). */
function declared(format: string): OwnImage.Format {
  if (format === "jpg") return "jpeg"
  return OwnImage.FORMATS.find((item) => item === format) ?? "png"
}

function withExtension(file: string, extension: string) {
  return file.slice(0, file.length - path.extname(file).length) + extension
}

function dataURI(bytes: Uint8Array, mime: string) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

type Card = Omit<OwnImage.CardData, "status"> & { readonly status: OwnImage.CardData["status"] | "running" }

function unavailable(steps: ReadonlyArray<OwnImage.Step>, keyOnly: string | undefined): Tool.Result {
  const card: Card = { status: "unavailable", steps }
  return {
    content: [
      "No image was made: no account can make images right now (every OpenAI API key and ChatGPT subscription is switched off, used up, at its limit or failing).",
      stepsText(steps),
      keyOnly === undefined
        ? ""
        : "This request (a format other than png, or markup) needs an OpenAI API key with GPT Image 2.6; a ChatGPT subscription makes PNG only. Say so, and that a plain PNG could still come from a subscription if the user wants one.",
      "Tell the user plainly in their language and stop (in Korean, 해요체), for example: 지금 이미지를 만들 수 있는 계정이 없어요. 아래 카드에 계정마다 이유가 있어요. 설정 > 이미지 만들기에서 계정을 켜거나 OpenAI API 키를 추가한 뒤 다시 요청해 주세요.",
      "Do not retry and do not try another way to make the image until the user says something changed.",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
    metadata: { [OwnImage.CARD_KEY]: card },
  }
}

function stepsText(steps: ReadonlyArray<OwnImage.Step>) {
  if (steps.length === 0) return ""
  return `Tried: ${steps.map((step) => `${step.label} (${step.route === "key" ? "API key" : "subscription"}): ${step.outcome}${step.why ? `, ${step.why}` : ""}`).join("; ")}.`
}

function skippedText(steps: ReadonlyArray<OwnImage.Step>) {
  const earlier = steps.filter((step) => step.outcome !== "used")
  return earlier.length === 0 ? "" : stepsText(earlier)
}

/** An input image by path (relative to the Location), read once its read is allowed: a PNG, JPEG or WebP. */
async function readImage(deps: Deps, source: string, context: ToolContext) {
  const read = await readFile(deps, source, context)
  const format = ImageFormat.sniff(read.bytes)
  // A GIF or an SVG is not an edit input OpenAI takes (an SVG is not raster at all).
  if (format !== "png" && format !== "jpeg" && format !== "webp")
    throw new Tool.Error({ message: `${source} is not a PNG, JPEG or WebP image.` })
  return { bytes: read.bytes, mime: OwnImage.MIME[format], name: read.name }
}

/**
 * The annotation layer of a markup edit (IM-22), read like an input image, then checked before anything is paid for:
 * a PNG that can hold transparent pixels (not flattened onto the image), exactly the size of the first image (a JPEG
 * or WebP may be stored turned, so its swapped size passes too; OpenAI compares after orientation) and at most
 * {@link OwnImage.MARKUP_MAX_PIXELS} pixels each.
 */
async function readMarkup(deps: Deps, source: string, first: { readonly bytes: Uint8Array; readonly mime: string }, context: ToolContext) {
  const read = await readFile(deps, source, context)
  const fail = (message: string) => new Tool.Error({ message: `markup ${source}: ${message}` })
  if (ImageFormat.sniff(read.bytes) !== "png") throw fail("the annotation layer must be a PNG.")
  if (!ImageFormat.pngAlpha(read.bytes))
    throw fail("the PNG has no transparency. Draw the marks on a transparent layer the size of the image, not on the image itself.")
  const layer = ImageFormat.dimensions(read.bytes)
  const image = ImageFormat.dimensions(first.bytes)
  if (!layer || !image) return { bytes: read.bytes, name: read.name }
  const pixels = (size: { readonly width: number; readonly height: number }) => size.width * size.height
  if (pixels(layer) > OwnImage.MARKUP_MAX_PIXELS || pixels(image) > OwnImage.MARKUP_MAX_PIXELS)
    throw fail(`the image and the layer may have at most ${OwnImage.MARKUP_MAX_PIXELS} pixels each.`)
  const same = layer.width === image.width && layer.height === image.height
  const turned = first.mime !== "image/png" && layer.width === image.height && layer.height === image.width
  if (!same && !turned)
    throw fail(`the layer is ${layer.width}x${layer.height} but images[0] is ${image.width}x${image.height}; they must be the same size.`)
  return { bytes: read.bytes, name: read.name }
}

/** A file by path, once its read is allowed, up to {@link MAX_INPUT_BYTES}. */
async function readFile(deps: Deps, source: string, context: ToolContext) {
  const absolute = path.resolve(deps.location.directory, source)
  await deps.ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    action: "read",
    resources: [resourceOf(deps, absolute)],
    save: [],
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })
  const stat = await fs.stat(absolute).catch(() => undefined)
  if (!stat?.isFile()) throw new Tool.Error({ message: `File not found: ${source}` })
  if (stat.size > MAX_INPUT_BYTES) throw new Tool.Error({ message: `${source} is larger than 20 MiB.` })
  return { bytes: new Uint8Array(await Bun.file(absolute).arrayBuffer()), name: path.basename(absolute) }
}

/** The project path an image is saved to, asked like an edit of that file. */
async function projectTarget(deps: Deps, requested: string, context: ToolContext) {
  const absolute = path.resolve(deps.location.directory, requested)
  await deps.ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    action: "edit",
    resources: [resourceOf(deps, absolute)],
    save: ["*"],
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })
  return absolute
}

/** A rule resource: relative to the Location with "/" inside it, else the absolute path (as core's file tools). */
function resourceOf(deps: Deps, absolute: string) {
  const relative = path.relative(deps.location.directory, absolute)
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : absolute
}
