export * as ProtectedPaths from "./protected-paths.js"

import { Schema } from "effect"

/**
 * 에이전트가 못 여는 파일·폴더 (01 §13 "에이전트 접근", 03 §18.8, 02 §9.2, PP 2026-11-07): files and folders an agent's
 * file tools may never read or change, in every approval mode and every conversation of a service, and whose direct
 * mention in a shell command asks first even under `전체 허용`. Each service (this PC, an SSH host) answers for
 * itself: its built-in list, placed in the home folder of the user it runs as, and the user's list kept in its
 * own-accounts KV. own-accounts' permission `evaluate` hook applies both from the next tool call of every session; the
 * session rules (the approval bundles) do not change.
 */

/** Longest path the service accepts. */
export const MAX_PATH = 1024
/** Most paths the user's list keeps. */
export const MAX_USER = 200

/**
 * What a built-in entry protects, for the settings page's headings: `own` this app's own secrets and settings, `keys`
 * SSH and GPG keys, `ai` other AI tools' logins, `developer` developer tools' credentials, `system` the OS credential
 * stores, `browser` browser profiles, `wallet` crypto wallets, `history` shell histories.
 */
export const Group = Schema.Literals([
  "own",
  "keys",
  "ai",
  "developer",
  "system",
  "browser",
  "wallet",
  "history",
]).annotate({ identifier: "Own.ProtectedPaths.Group" })
export type Group = typeof Group.Type

/** One built-in entry as the service places it on its machine. */
export const BuiltIn = Schema.Struct({
  id: Schema.String,
  group: Group,
  /** Where it is on the service's machine, `~` standing for its user's home folder where it lies under it. */
  paths: Schema.Array(Schema.String),
  /** One line (Korean): why an agent may not open it. */
  reason: Schema.String,
}).annotate({ identifier: "Own.ProtectedPaths.BuiltIn" })
export interface BuiltIn extends Schema.Schema.Type<typeof BuiltIn> {}

/** One path of the user's list. */
export const UserEntry = Schema.Struct({
  /** As the user added it (`~` kept). */
  path: Schema.String,
  /** Absolute on the service's machine; a folder covers everything inside it. */
  resolved: Schema.String,
}).annotate({ identifier: "Own.ProtectedPaths.UserEntry" })
export interface UserEntry extends Schema.Schema.Type<typeof UserEntry> {}

/** `protectedPaths.get` and every change's answer. */
export const View = Schema.Struct({
  /** The home folder `~` stands for on the service's machine. */
  home: Schema.String,
  builtIn: Schema.Array(BuiltIn),
  /** In the order added. */
  user: Schema.Array(UserEntry),
}).annotate({ identifier: "Own.ProtectedPaths.View" })
export interface View extends Schema.Schema.Type<typeof View> {}

/** `protectedPaths.add` / `protectedPaths.remove`: an absolute path or one starting with `~`. */
export const PathInput = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PATH)),
}).annotate({ identifier: "Own.ProtectedPaths.PathInput" })
export type PathInput = typeof PathInput.Type

/**
 * Why a path cannot be added (`protected_path_invalid`): `relative` neither absolute nor starting with `~`, `root` a
 * drive or filesystem root, `home` the home folder itself (every project under it would close), `wildcard` it holds
 * `*` or `?`, `too_many` the list holds {@link MAX_USER} paths already.
 */
export const Problem = Schema.Literals(["relative", "root", "home", "wildcard", "too_many"]).annotate({
  identifier: "Own.ProtectedPaths.Problem",
})
export type Problem = typeof Problem.Type

/** A name in the home folder that looks sensitive (`protectedPaths.suggest`); never added by itself. */
export const Suggestion = Schema.Struct({
  name: Schema.String,
  /** Absolute. */
  path: Schema.String,
  folder: Schema.Boolean,
}).annotate({ identifier: "Own.ProtectedPaths.Suggestion" })
export interface Suggestion extends Schema.Schema.Type<typeof Suggestion> {}

export const Suggestions = Schema.Struct({ items: Schema.Array(Suggestion) }).annotate({
  identifier: "Own.ProtectedPaths.Suggestions",
})
export interface Suggestions extends Schema.Schema.Type<typeof Suggestions> {}

/**
 * `protectedPaths.patterns` (in-process, own.harness's dsh searches): every pattern the `evaluate` hook denies `read`
 * and `edit` for, absolute with `/`, in core's wildcard (`*` any run, `?` one character).
 */
export const Patterns = Schema.Struct({ patterns: Schema.Array(Schema.String) }).annotate({
  identifier: "Own.ProtectedPaths.Patterns",
})
export interface Patterns extends Schema.Schema.Type<typeof Patterns> {}

/**
 * How the card text of a shell command that names a protected path begins (own-accounts' `evaluate` hook). own-web
 * leaves `항상 허용` off such a card: the hook asks again for every such command, so a saved allow (`cat *`) would
 * only let other commands of the same kind run unasked.
 */
export const SHELL_NOTE = "이 명령은 에이전트가 못 여는 파일·폴더"

export function isShellNote(message: string | undefined) {
  return message?.includes(SHELL_NOTE) === true
}
