// What dsh's `glob` and `grep` may show (own's P-031 for core's search tools): a search asks only for its pattern and
// root, so without this it would print lines of files a `read` denies (own's protected paths) or asks about (`.env`).
// Core's grep and glob check each file with core's `Permission.check`, which the plugin API does not offer; until it does
// (13 §5), the dsh search tools read the agent's and the session's rules and evaluate `read` as core's
// `Permission.evaluate` does (last matching rule, core's wildcard). Approvals the user saved are not seen, so a file
// allowed only by a saved "always allow" stays left out: stricter than core, never looser. own's protected paths
// beyond the session rules (built-in and the user's, 01 §13 PP) are applied by own-accounts' permission hook, which
// these local evaluations do not pass through: a search asks own.accounts for their patterns
// (`protectedPaths.patterns`) and leaves out what they match.
export * as DshReadable from "./readable.js"

import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Permission } from "@opencode/schema/permission"
import { Rpc } from "@opencode/schema/rpc"
import { Portable } from "@own/protocol/portable"
import { OwnAccounts } from "@own/protocol/rpc"
import { Effect } from "effect"

/** core/src/util/wildcard.ts `match`. */
export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  const spaced = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}( .*)?` : escaped
  return new RegExp(`^${spaced}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

/** core/src/permission.ts `evaluate`: the last rule matching the action and the resource, else ask. */
export function evaluate(action: string, resource: string, rules: ReadonlyArray<Permission.Rule>): Permission.Effect {
  return rules.findLast((rule) => match(action, rule.action) && match(resource, rule.resource))?.effect ?? "ask"
}

/** A path as a rule resource (core's `FileAccess.resolve`): relative to the Location with "/", else absolute. */
export function resource(absolute: string, directory: string) {
  const relative = path.relative(directory, absolute)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return absolute
  return relative.split(path.sep).join("/")
}

const PatternsOnly = Rpc.define({
  id: OwnAccounts.ID,
  methods: { "protectedPaths.patterns": OwnAccounts.Definition.methods["protectedPaths.patterns"] },
  events: {},
})
let portable: typeof PatternsOnly | undefined

/**
 * own.accounts' protected patterns in this Location (absolute, `/`, core's wildcard). None when own.accounts does not
 * answer (not loaded): the session rules still apply.
 */
export function protectedPatterns(ctx: Pick<Context, "rpc">) {
  return Effect.suspend(() =>
    ctx.rpc((portable ??= Portable.definition(PatternsOnly)))["protectedPaths.patterns"]({}),
  ).pipe(
    Effect.map((answer): ReadonlyArray<string> => answer.patterns),
    Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([])),
  )
}

/** The model's note for left-out matches, as core's grep writes it. */
export function leftOut(files: number) {
  return `(Matches in ${files} file(s) are left out: reading them is denied or needs the user's approval. Read such a file with the read tool to ask.)`
}
