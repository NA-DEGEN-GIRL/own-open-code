export * as CoreConfig from "./core-config.js"

import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Fsx } from "@own/runtime"
import { Approval, Compaction } from "@own/protocol"

/**
 * Core compaction settings in the own global config `%OPENCODE_CONFIG_DIR%\opencode.jsonc` (02 §4.7.2, §4.7.6):
 * `compaction.keep.tokens` (`K` of `T_floor`, reported as `cache.state.compaction.keepTokens`), `compaction.auto`,
 * `compaction.buffer` (own never sets it; the self-test warns when it is there), and the default `model`. Project
 * config files can override these per Location; own-accounts cannot see that (runtime alert
 * `compaction_threshold_mismatch` only).
 */

export interface Values {
  /** `null` when the file cannot be read (no config dir, unreadable, not JSONC). A missing key is core's default. */
  readonly keepTokens: number | null
  readonly auto: boolean | null
  /** `compaction.buffer` (or the old key `reserved`) when set: tokens, or a share such as `"20%"` (since v2.2.2). */
  readonly buffer: number | string | null
  /** `model` (`provider/model`) when the user named a default model there (07 §2.2 `pin()`). */
  readonly model: string | null
}

export const FILE_NAME = "opencode.jsonc"

export const UNKNOWN: Values = { keepTokens: null, auto: null, buffer: null, model: null }
export const DEFAULTS: Values = { keepTokens: Compaction.KEEP_TOKENS, auto: true, buffer: null, model: null }

export function file(configDir: string) {
  return path.join(configDir, FILE_NAME)
}

/** Reads the values; a missing file means core defaults (nothing configured there). */
export async function read(configDir: string | undefined): Promise<Values> {
  if (!configDir) return UNKNOWN
  const text = await Fsx.readText(file(configDir)).catch(() => null)
  if (text === null) return UNKNOWN
  if (text === undefined) return DEFAULTS
  return values(text)
}

/** The values of one config text. */
export function values(text: string): Values {
  const errors: ParseError[] = []
  const root: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || !isRecord(root)) return UNKNOWN
  const compaction = isRecord(root.compaction) ? root.compaction : {}
  const keep = isRecord(compaction.keep) ? compaction.keep.tokens : undefined
  const buffer = compaction.buffer ?? compaction.reserved
  return {
    keepTokens: typeof keep === "number" && keep >= 0 ? keep : Compaction.KEEP_TOKENS,
    auto: typeof compaction.auto === "boolean" ? compaction.auto : true,
    buffer: typeof buffer === "number" || typeof buffer === "string" ? buffer : null,
    model: typeof root.model === "string" && root.model.length > 0 ? root.model : null,
  }
}

/**
 * Sets `compaction.keep.tokens` (02 §4.7.6 (가), `policy.set{patch.compaction.keepTokens}`), keeping comments and
 * formatting. Core's config watcher reloads it. `undefined` when the text is not valid JSONC.
 */
export function withKeep(text: string | undefined, keepTokens: number) {
  const source = text ?? "{}\n"
  const errors: ParseError[] = []
  parse(source, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) return undefined
  const edits = modify(source, ["compaction", "keep", "tokens"], keepTokens, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" },
  })
  return applyEdits(source, edits)
}

/** Writes `keepTokens` into the config file atomically. */
export async function writeKeep(configDir: string, keepTokens: number) {
  const current = await Fsx.readText(file(configDir))
  const next = withKeep(current, keepTokens)
  if (next === undefined) return { ok: false as const, reason: "config_parse_failed" }
  if (next !== current) await Fsx.writeAtomic(file(configDir), next)
  return { ok: true as const }
}

/**
 * Core's `websearch` key (03 §18.2, `@opencode/schema/config/websearch`): `false`, or `{provider: "random" | id}`;
 * own's `own-multi` reads as `multi` (MS, its services are own's KV row). `undefined` when the text names none, is
 * not valid JSONC or holds a value core would not take.
 */
export function webSearchOf(text: string): Approval.WebSearchChoice | undefined {
  const errors: ParseError[] = []
  const root: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || !isRecord(root)) return undefined
  if (root.websearch === false) return { type: "off" }
  const provider = isRecord(root.websearch) ? root.websearch.provider : undefined
  if (provider === "random") return { type: "any" }
  if (provider === Approval.WEB_SEARCH_MULTI) return { type: "multi" }
  return typeof provider === "string" && provider.length > 0 ? { type: "service", id: provider } : undefined
}

/**
 * Writes core's `websearch` key for `choice` atomically, keeping comments and formatting; `default` removes it (own's
 * default applies again, 02 §9.2). Core's config watcher applies it. `config_parse_failed` when the file is not valid
 * JSONC (it is left as it is).
 */
export async function writeWebSearch(configDir: string, choice: Approval.WebSearchSetChoice) {
  const current = await Fsx.readText(file(configDir))
  if (current === undefined && choice.type === "default") return { ok: true as const }
  const source = current ?? "{}\n"
  const errors: ParseError[] = []
  parse(source, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) return { ok: false as const, reason: "config_parse_failed" }
  const value =
    choice.type === "default"
      ? undefined
      : choice.type === "off"
        ? false
        : {
            provider:
              choice.type === "any" ? "random" : choice.type === "multi" ? Approval.WEB_SEARCH_MULTI : choice.id,
          }
  const next = applyEdits(
    source,
    modify(source, ["websearch"], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" },
    }),
  )
  if (next !== current) await Fsx.writeAtomic(file(configDir), next)
  return { ok: true as const }
}

/**
 * Core's background compaction (upstream v2.3.1 `compaction.background`, on by default) stays off in own, as in every
 * release before v2.4.1 (decisions MR18-8): a background summary can start on a finished subagent conversation after its
 * account's budget ran out (PG11), and one never used still costs tokens. Writes `false` once when the existing file
 * names no `compaction.background`, keeping comments and formatting; a value the user wrote wins. No file, or one that
 * is not valid JSONC, is left alone.
 */
export async function ensureBackgroundOff(configDir: string) {
  const current = await Fsx.readText(file(configDir))
  if (current === undefined) return { changed: false }
  const errors: ParseError[] = []
  const root: unknown = parse(current, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || !isRecord(root)) return { changed: false }
  if (isRecord(root.compaction) && root.compaction.background !== undefined) return { changed: false }
  const next = applyEdits(
    current,
    modify(current, ["compaction", "background"], false, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: current.includes("\r\n") ? "\r\n" : "\n" },
    }),
  )
  await Fsx.writeAtomic(file(configDir), next)
  return { changed: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
