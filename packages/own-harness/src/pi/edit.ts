// Ports packages/coding-agent/src/core/tools/edit.ts: Pi's `edit` tool. One or more exact replacements, each matched
// against the original file (edit-diff.ts), with the file's BOM kept and the edits spliced into the original text, so
// untouched lines keep their own line endings (Pi 1.5.1, #8544). `prepareArguments` accepts the shapes models send
// besides Pi's schema (edits as a JSON string, one edit object, legacy top-level oldText/newText). The tool here plans
// the change first so own can show the diff in its approval card, then writes it.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiEdit from "./edit.js"

import { constants } from "node:fs"
import { access, readFile, writeFile } from "node:fs/promises"
import type { PiArgs } from "./args.js"
import { PiEditDiff } from "./edit-diff.js"

export const NAME = "edit"

export const DESCRIPTION =
  "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes."

export const SCHEMA: PiArgs.ObjectSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            description:
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
          },
          newText: { type: "string", description: "Replacement text for this targeted edit." },
        },
        required: ["oldText", "newText"],
      },
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    },
  },
  required: ["path", "edits"],
}

export interface Input {
  readonly path: string
  readonly edits: ReadonlyArray<PiEditDiff.Edit>
}

export interface Plan {
  /** The file as it was, BOM and line endings included. */
  readonly before: string
  /** What the edit writes. */
  readonly after: string
  /** LF-normalized content before and after, for the diff. */
  readonly baseContent: string
  readonly newContent: string
}

/** `prepareEditArguments`: the edit shapes models send that are not Pi's schema, folded into it. */
export function prepareArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") return input
  const args = input as Record<string, unknown>
  const edits = (() => {
    if (typeof args.edits === "string") {
      const parsed = parseJson(args.edits)
      if (Array.isArray(parsed)) return parsed
      if (isSingleEdit(parsed)) return [parsed]
      return args.edits
    }
    return isSingleEdit(args.edits) ? [args.edits] : args.edits
  })()
  const folded = edits === args.edits ? args : { ...args, edits }
  if (typeof folded.oldText !== "string" || typeof folded.newText !== "string") return folded
  const { oldText, newText, ...rest } = folded
  return { ...rest, edits: [...(Array.isArray(rest.edits) ? rest.edits : []), { oldText, newText }] }
}

/**
 * Reads the file and applies the edits in memory. Fails with Pi's texts: `Could not edit file: <path>. Error code:
 * ENOENT.` when the file cannot be read and written, and edit-diff's matching errors.
 */
export async function plan(input: Input, absolute: string): Promise<Plan> {
  if (input.edits.length === 0)
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.")
  await access(absolute, constants.R_OK | constants.W_OK).catch((error: unknown) => {
    const reason = error instanceof Error && "code" in error ? `Error code: ${String(error.code)}` : String(error)
    throw new Error(`Could not edit file: ${input.path}. ${reason}.`)
  })
  const before = (await readFile(absolute)).toString("utf-8")
  const split = PiEditDiff.splitBom(before)
  const normalized = PiEditDiff.normalizeToLF(split.text)
  const applied = PiEditDiff.applyEditsToNormalizedContent(normalized, input.edits, input.path)
  // Splice into the original text, so untouched lines keep their line endings. Without any CR the original is the
  // normalized text, and the normalized result is already final.
  return {
    before,
    after:
      split.bom +
      (split.text === normalized
        ? applied.newContent
        : PiEditDiff.applyReplacementsToOriginal(split.text, applied.replacements)),
    baseContent: applied.baseContent,
    newContent: applied.newContent,
  }
}

/**
 * Writes the planned content and answers Pi's result text, with the display diff and patch Pi's TUI shows. Both are
 * made before the write, so a diff that fails leaves the file as it was.
 */
export async function commit(input: Input, absolute: string, planned: Plan) {
  const diff = PiEditDiff.generateDiffString(planned.baseContent, planned.newContent)
  const patch = PiEditDiff.generateUnifiedPatch(input.path, planned.baseContent, planned.newContent)
  await writeFile(absolute, planned.after, "utf-8")
  return {
    text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.`,
    details: { diff: diff.diff, patch, firstChangedLine: diff.firstChangedLine },
  }
}

function isSingleEdit(value: unknown): value is PiEditDiff.Edit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const edit = value as Record<string, unknown>
  return typeof edit.oldText === "string" && typeof edit.newText === "string"
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
