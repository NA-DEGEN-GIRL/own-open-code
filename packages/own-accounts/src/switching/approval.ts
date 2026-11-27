export * as SessionApproval from "./approval.js"

import path from "node:path"
import type { Permission } from "@opencode/schema/permission"
import { Credentials } from "@own/runtime"
import { Approval, OwnBrowse, Preset, type Registry } from "@own/protocol"

/**
 * Approval-mode rule bundles (v0.4, 02 §9.2 `session.approval.*`, 03 §18.8). own-accounts builds them so own-web never
 * learns the protected paths (03 P10), and is the only writer of the session rules it manages:
 *
 * - Tools stay listed in every mode: no rule uses `resource: "*"` (core drops a tool only for a `"*"` deny,
 *   `core/src/tool.ts:292-295`) and no rule uses a wildcard action (`Tool.snapshot` looks at the last rule whose
 *   action matches, so a trailing wildcard allow would undo someone else's `"*"` deny). The cached prefix is kept.
 * - Session rules are evaluated after the agent's and the last matching rule wins, so the protected-path denies come
 *   last in every mode; otherwise `full`'s allows (or `ask`) would lift them.
 * - Writes are read-merge-write: only rules of the own bundles are replaced, everything else keeps its order.
 */

const MODES = Approval.SetMode.literals

/**
 * Resources every mode `**`-matches, per action. `read-only` and `ask` ask before a web request, `webfetch` (which Code
 * Mode's `fetch` asks too, decisions MR10-3) and `websearch` (MR11): after a prompt injection a fetched URL or a search
 * query can carry the conversation's data out, so only `full` lets the model reach the web unasked. A user's `항상 허용`
 * is a saved project rule, which core reads after every session rule.
 */
const CORE: Readonly<Record<Approval.SetMode, ReadonlyArray<Permission.Rule>>> = {
  "read-only": [
    { action: "edit", resource: "**", effect: "deny" },
    { action: "shell", resource: "**", effect: "deny" },
    { action: "webfetch", resource: "**", effect: "ask" },
    { action: "websearch", resource: "**", effect: "ask" },
  ],
  ask: [
    { action: "edit", resource: "**", effect: "ask" },
    { action: "shell", resource: "**", effect: "ask" },
    { action: "webfetch", resource: "**", effect: "ask" },
    { action: "websearch", resource: "**", effect: "ask" },
  ],
  full: [
    { action: "edit", resource: "**", effect: "allow" },
    { action: "shell", resource: "**", effect: "allow" },
    { action: "webfetch", resource: "**", effect: "allow" },
    { action: "websearch", resource: "**", effect: "allow" },
  ],
}

/** The permissions of a web request: the `webfetch` tool and Code Mode's `fetch` share the first. */
export const WEB_ACTIONS: ReadonlyArray<string> = ["webfetch", "websearch"]

/**
 * Former bundles, newest first: before MR11 (no `websearch` rule in any mode) and before MR10-3 (`read-only` and `ask`
 * without `webfetch` either). A session written then still reads as its mode ({@link modeOf}), and own-accounts'
 * `evaluate` hook asks for the web requests of a former `read-only` or `ask` bundle ({@link legacyWeb}); its rules are
 * never rewritten behind the user's back (the next mode change writes the current bundle). A former `full` bundle
 * needs no hook: the agent's rules allow web search there as before.
 */
const BEFORE_WEBSEARCH = without(CORE, "websearch", MODES)
const LEGACY = [BEFORE_WEBSEARCH, without(BEFORE_WEBSEARCH, "webfetch", ["read-only", "ask"])]

/** Actions a protected path is denied for (the file tools; shell can bypass, 01 §13 "심층 방어"). */
const PROTECTED_ACTIONS = ["read", "edit"] as const

export interface ProtectedInput {
  /** OWN_HOME. */
  readonly home: string
  /** `%OPENCODE_CONFIG_DIR%` (own global config and service files). */
  readonly configDir?: string
  /** `%USERPROFILE%`. */
  readonly userHome: string
  /** `CLAUDE_CONFIG_DIR` when the Claude slot uses another account source. */
  readonly claudeConfigDir?: string
  /**
   * The service database, as a name prefix: `OPENCODE_DB` when the service was given one, else every `opencode*` file
   * of core's data folder (the channel's `opencode-own.db` with its `-wal` and `-shm`).
   */
  readonly database?: string
  /** Accounts whose credential reads an old-app profile (linked or taken over). */
  readonly registry: Registry.File
}

/** A process's {@link ProtectedInput}: OWN_HOME, the user's home, and the folders its environment names. */
export function protectedInput(input: {
  readonly home: string
  readonly userHome: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly registry: Registry.File
}): ProtectedInput {
  return {
    home: input.home,
    configDir: input.env.OPENCODE_CONFIG_DIR || undefined,
    userHome: input.userHome,
    claudeConfigDir: input.env.CLAUDE_CONFIG_DIR || undefined,
    database: database(input.env, input.userHome),
    registry: input.registry,
  }
}

/**
 * Where the service database is, the way core's CLI places it (`packages/cli/src/database-path.ts` under
 * `packages/util/src/global-roots.ts`'s data folder). The installed app sets no `OPENCODE_DB`, and until 2026-11-16 that
 * left the database out of the protected places: a model read it by shell in two live team runs.
 */
function database(env: Readonly<Record<string, string | undefined>>, userHome: string) {
  if (env.OPENCODE_DB === ":memory:") return undefined
  const data = path.join(env.XDG_DATA_HOME || path.join(userHome, ".local", "share"), "opencode")
  // Core's default name depends on the channel (`opencode.db`, `opencode-own.db`): the prefix covers each of them.
  return env.OPENCODE_DB ? path.resolve(data, env.OPENCODE_DB) : path.join(data, "opencode")
}

/**
 * Resource patterns denied in every mode (01 §13 "에이전트 접근"): the vault, the registry files, the service config,
 * the database, Claude Code's credentials and the old app's profile directories. Forward slashes, as core compares
 * (`core/src/util/wildcard.ts`). This list is the protected tail of every bundle; the wider list of protected paths
 * (built-in and the user's, `protection/`) is applied by own-accounts' `evaluate` hook and never written as rules.
 */
export function protectedPaths(input: ProtectedInput): ReadonlyArray<string> {
  return [...new Set(ownPlaces(input).flatMap((place) => place.patterns))]
}

/** Which of own's protected places a pattern belongs to (the settings page names each with its reason). */
export type OwnPlace = "vault" | "files" | "config" | "database" | "claude" | "claude-config" | "profiles"

/** {@link protectedPaths} by place, in the same order. */
export function ownPlaces(
  input: ProtectedInput,
): ReadonlyArray<{ readonly place: OwnPlace; readonly patterns: ReadonlyArray<string> }> {
  const profiles = input.registry.accounts.flatMap((account) => {
    const credential = Credentials.credentialOf(account)
    if (credential.type === "vault") return []
    // A linked old-app key (02 §3.2b): `<app>\profiles` or `<app>\work\control-center\credentials`.
    if (credential.type === "linked-legacy-key") return [path.dirname(credential.source.path)]
    // `<control-center>\profiles\<id>\codex\auth.json` → `<control-center>\profiles`
    return [path.dirname(path.dirname(path.dirname(credential.source.authPath)))]
  })
  const places: ReadonlyArray<readonly [OwnPlace, ReadonlyArray<string>]> = [
    ["vault", [path.join(input.home, "vault", "**")]],
    ["files", [path.join(input.home, "*.json")]],
    ["config", input.configDir ? [path.join(input.configDir, "*.json*")] : []],
    ["database", input.database ? [`${input.database}*`] : []],
    ["claude", [path.join(input.userHome, ".claude", ".credentials.json")]],
    ["claude-config", input.claudeConfigDir ? [path.join(input.claudeConfigDir, ".credentials.json")] : []],
    ["profiles", [...new Set(profiles)].map((directory) => path.join(directory, "**"))],
  ]
  return places
    .filter((entry) => entry[1].length > 0)
    .map((entry) => ({ place: entry[0], patterns: entry[1].map((pattern) => pattern.replaceAll("\\", "/")) }))
}

/** The rules own-accounts writes for a mode: the mode's rules, then the protected-path denies. */
export function bundle(mode: Approval.SetMode, paths: ReadonlyArray<string>): ReadonlyArray<Permission.Rule> {
  return [...CORE[mode], ...denies(paths)]
}

/**
 * The browser plugin's attachment grant (upstream 82bb5ff88a, `packages/plugin-browser/src/connection.ts` `grant`):
 * every agent carries `{browser, *, deny}` from the plugin, and while a desktop is attached the plugin appends this
 * allow at the very end of the session's rules (after the own bundle) and removes the first copy on release. Every
 * attach (window reload, service restart, wake) appends it again, so `modeOf` and the inserts step over trailing
 * copies; `replace` keeps it where it is.
 */
export const BROWSER_ATTACH_ALLOW: Permission.Rule = { action: "browser", resource: "*", effect: "allow" }

/**
 * The mode the session's rules end with, or `custom` (no own bundle, or someone changed it). Trailing rules for an
 * action no bundle decides are not part of the reading: the browser plugin appends {@link BROWSER_ATTACH_ALLOW} after
 * the own bundle on every attachment, and own.harness appends its tool gate (`{own_harness_codex, *, allow}`) on a
 * harness switch. They cannot change what the bundle decides; a later rule that matches one of its actions can.
 */
export function modeOf(rules: ReadonlyArray<Permission.Rule>, paths: ReadonlyArray<string>): Approval.Mode {
  const mode = readMode(rules, paths, CORE)
  if (mode !== "custom") return mode
  return LEGACY.map((bundles) => readMode(rules, paths, bundles)).find((item) => item !== "custom") ?? "custom"
}

/**
 * Whether the rules end with a former `read-only` or `ask` bundle ({@link LEGACY}), whose session should ask for a web
 * request as the current bundle would: core may then allow it by the agent's rules, and own-accounts' `evaluate` hook
 * turns that into `ask`.
 */
export function legacyWeb(rules: ReadonlyArray<Permission.Rule>, paths: ReadonlyArray<string>) {
  if (readMode(rules, paths, CORE) !== "custom") return false
  const mode = modeOf(rules, paths)
  return mode === "read-only" || mode === "ask"
}

/**
 * Whether the agent's own rules (a config's `permission`, which core adds to every agent, and the agent's definition)
 * deny `action` on `resource`: the last of their rules that matches is a `deny`. A read-only role's own
 * `Preset.ROLE_WEB_ASK` rules do not count: own adds them after a config's rules (MR10-3), and they must not lift the
 * user's deny. The user's own `ask` rules count: a config's `ask` after its deny asks (decisions RL2-L2). own's bundles
 * are session rules, which core reads after these, so a `전체 허용` allow overrode a user's deny of `websearch` or
 * `webfetch` (MR12-5); the `evaluate` hook keeps it.
 */
export function agentDenies(
  action: string,
  resource: string,
  rules: ReadonlyArray<Permission.Rule>,
  agent: string | undefined,
) {
  const last = rules.findLast(
    (rule) =>
      !Preset.roleWebAsk(agent, rule) && savedCovers(action, [rule.action]) && savedCovers(resource, [rule.resource]),
  )
  return last?.effect === "deny"
}

/**
 * Whether a saved project approval (`항상 허용`, the resources P-047 hands the `evaluate` hook) covers `resource`, by
 * core's resource wildcard (`core/src/util/wildcard.ts`: `\` read as `/`, a trailing ` *` also matching nothing). Core
 * reads saved approvals after every session rule, so the current bundle's `ask` gives way to them as well.
 */
export function savedCovers(resource: string, saved: ReadonlyArray<string>) {
  const value = resource.replaceAll("\\", "/")
  return saved.some((pattern) => {
    const escaped = pattern
      .replaceAll("\\", "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    const source = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}( .*)?` : escaped
    return new RegExp(`^${source}$`, process.platform === "win32" ? "si" : "s").test(value)
  })
}

function readMode(
  rules: ReadonlyArray<Permission.Rule>,
  paths: ReadonlyArray<string>,
  bundles: Readonly<Record<Approval.SetMode, ReadonlyArray<Permission.Rule>>>,
): Approval.Mode {
  const read = decided(rules)
  const tail = protectedTail(read, paths)
  if (tail === undefined) return "custom"
  const head = read.slice(0, read.length - tail)
  return (
    MODES.find((mode) => sameRules(head.slice(Math.max(0, head.length - bundles[mode].length)), bundles[mode])) ??
    "custom"
  )
}

/** The rules up to the last one an own bundle's action decides; later ones (browser, harness gates) do not count. */
function decided(rules: ReadonlyArray<Permission.Rule>) {
  return rules.slice(0, rules.findLastIndex(decides) + 1)
}

/**
 * How many rules at the end of `rules` are a protected tail: the current list's denies, or the denies of a list an
 * earlier write placed (`{read, P, deny}` then `{edit, P, deny}` per absolute pattern P): linking an account, a moved
 * config folder or database, or an older build changes {@link protectedPaths}, and the session keeps its mode (it is
 * not rewritten; the `evaluate` hook protects the current list in every session, PP-4). Undefined when there is none
 * (an empty current list needs none).
 */
function protectedTail(rules: ReadonlyArray<Permission.Rule>, paths: ReadonlyArray<string>) {
  const current = denies(paths)
  if (current.length > 0 && rules.length >= current.length && sameRules(rules.slice(-current.length), current))
    return current.length
  const run = rules.length - ownRun(rules)
  if (run > 0) return run
  return current.length === 0 ? 0 : undefined
}

/**
 * Where an earlier own tail at the end of `rules` starts (`rules.length` when there is none): the last deny pair for
 * own's vault in the trailing run of deny pairs, when every pair from there names one of own's places. A deny pair the
 * user added after it, or a run without the vault, keeps the rules `custom`.
 */
function ownRun(rules: ReadonlyArray<Permission.Rule>) {
  const from = pairsFrom(rules, rules.length)
  const start = rules.findLastIndex(
    (rule, index) => index >= from && (index - from) % 2 === 0 && rule.resource.endsWith("/vault/**"),
  )
  if (start < 0) return rules.length
  return rules.slice(start).every((rule) => OWN_PLACE.test(rule.resource)) ? start : rules.length
}

/** The shapes of own's places in {@link ownPlaces}: the vault, `*.json` files, the database, logins, old profiles. */
const OWN_PLACE = /\/vault\/\*\*$|\/\*\.json\*?$|\/\.credentials\.json$|\/profiles\/\*\*$|[^/*]\*$/

/** Where the run of protected deny pairs that ends at `end` starts. */
function pairsFrom(rules: ReadonlyArray<Permission.Rule>, end: number): number {
  return end >= 2 && isDenyPair(rules[end - 2], rules[end - 1]) ? pairsFrom(rules, end - 2) : end
}

function isDenyPair(read: Permission.Rule | undefined, edit: Permission.Rule | undefined) {
  return (
    read !== undefined &&
    edit !== undefined &&
    read.action === "read" &&
    edit.action === "edit" &&
    read.effect === "deny" &&
    edit.effect === "deny" &&
    read.resource === edit.resource &&
    /^(?:[A-Za-z]:)?\//.test(read.resource)
  )
}

/**
 * The protected tail of an earlier list at the end of `rules` that read as a mode: a mode change replaces it with the
 * current one (a custom set keeps its rules).
 */
function staleTail(rules: ReadonlyArray<Permission.Rule>, paths: ReadonlyArray<string>) {
  const read = decided(rules)
  const tail = protectedTail(read, paths)
  if (!tail || modeOf(rules, paths) === "custom") return []
  return read.slice(read.length - tail)
}

/** Read-merge-write: drops every rule of any own bundle (mode rules and protected denies), appends `mode`'s bundle. */
export function replace(
  rules: ReadonlyArray<Permission.Rule>,
  mode: Approval.SetMode,
  paths: ReadonlyArray<string>,
): Permission.Rule[] {
  const own = [...MODES.flatMap((item) => CORE[item]), ...denies(paths), ...staleTail(rules, paths)]
  return [...rules.filter((rule) => !own.some((item) => sameRule(item, rule))), ...bundle(mode, paths)]
}

/**
 * The browser tools' creation deny (03 §18.15 rule 1): own-web writes it when a window without a browser pane creates
 * the session (own-web `policy/browser.ts`). It is not part of any mode bundle.
 */
export const BROWSER_DENY: Permission.Rule = { action: "browser", resource: "*", effect: "deny" }

/**
 * `session.approval.set{browserTool}` (03 §18.15 rule 3, v0.5), read-merge-write like the modes:
 * - `on` removes exactly the creation deny; any other rule stays (a deny someone wrote on purpose keeps the tools off).
 * - `off` puts the creation deny right before the own bundle at the end, i.e. after every other rule that matches
 *   `browser` (core looks only at the last matching rule, `core/src/tool.ts:292-295`). No own bundle rule matches
 *   `browser`, so the protected-path denies stay last and `modeOf` still reads the mode. It also drops every
 *   {@link BROWSER_ATTACH_ALLOW}, which would otherwise come after the deny and win; after a later `on` the tools come
 *   back with the next attachment (the plugin's release then finds nothing to remove).
 */
export function withBrowserTool(
  rules: ReadonlyArray<Permission.Rule>,
  tool: Approval.BrowserTool,
  paths: ReadonlyArray<string>,
): Permission.Rule[] {
  const rest = rules.filter((rule) => !sameRule(rule, BROWSER_DENY))
  if (tool === "on") return rest
  return beforeOwnTail(
    rest.filter((rule) => !sameRule(rule, BROWSER_ATTACH_ALLOW)),
    BROWSER_DENY,
    paths,
  )
}

/** Core's `whollyDisabled("browser", rules)`: the last rule whose action matches `browser` is a `"*"` deny → off. */
export function browserToolOf(rules: ReadonlyArray<Permission.Rule>): Approval.BrowserTool {
  const last = rules.findLast((rule) => actionMatches("browser", rule.action))
  return last?.resource === "*" && last.effect === "deny" ? "off" : "on"
}

/**
 * The computer-use consent rule (own.computer-use, 01 §10.2): every agent carries an agent-wide `{computer, *, deny}`
 * from the plugin, and this session rule lists the tools again. The plugin re-checks it on every call and accepts only
 * this exact rule as the last one matching `computer`.
 */
export const COMPUTER_ALLOW: Permission.Rule = { action: "computer", resource: "*", effect: "allow" }

/**
 * `session.approval.set{computerUse}`, read-merge-write like the browser switch: `on` puts the allow right before the
 * own bundle at the end, so it is the last rule matching `computer` while the protected-path denies stay last and
 * `modeOf` still reads the mode; `off` removes it. Other rules matching `computer` are never removed.
 */
export function withComputerUse(
  rules: ReadonlyArray<Permission.Rule>,
  use: Approval.ComputerUse,
  paths: ReadonlyArray<string>,
): Permission.Rule[] {
  const rest = rules.filter((rule) => !sameRule(rule, COMPUTER_ALLOW))
  if (use === "off") return rest
  return beforeOwnTail(rest, COMPUTER_ALLOW, paths)
}

/** `on` only when the last rule whose action matches `computer` is exactly {@link COMPUTER_ALLOW} (fail closed). */
export function computerUseOf(rules: ReadonlyArray<Permission.Rule>): Approval.ComputerUse {
  const last = rules.findLast((rule) => actionMatches("computer", rule.action))
  return last !== undefined && sameRule(last, COMPUTER_ALLOW) ? "on" : "off"
}

/**
 * Whether the rules hold {@link COMPUTER_ALLOW} anywhere. Core copies the parent's session rules into every child it
 * creates (`packages/core/src/session.ts:276`), so a child of a session with computer use on starts with it; while
 * own.computer-use's `policy.allowSubagents` is off switching removes it (`withComputerUse(rules, "off")`), so the
 * child does not list the computer tools.
 */
export function hasComputerAllow(rules: ReadonlyArray<Permission.Rule>) {
  return rules.some((rule) => sameRule(rule, COMPUTER_ALLOW))
}

/**
 * The 내 브라우저 사용 session rule (`OwnBrowse.ALLOW`, decisions BRW): every agent carries `OwnBrowse.DENY` from
 * own-accounts' browse module, and this rule lists the `browse_*` tools again for one conversation. The approval mode
 * still decides each call (`Browse.decide`).
 */
export const BROWSE_ALLOW: Permission.Rule = { ...OwnBrowse.ALLOW }

/**
 * `session.approval.set{browse}`, read-merge-write like computer use: `on` puts {@link BROWSE_ALLOW} right before the
 * own bundle, so it comes after the agent-wide deny while the protected-path denies stay last and `modeOf` still reads
 * the mode; `off` removes it. Rules someone else wrote for single browse tools are never removed.
 */
export function withBrowse(
  rules: ReadonlyArray<Permission.Rule>,
  use: Approval.Browse,
  paths: ReadonlyArray<string>,
): Permission.Rule[] {
  const rest = rules.filter((rule) => !sameRule(rule, BROWSE_ALLOW))
  if (use === "off") return rest
  return beforeOwnTail(rest, BROWSE_ALLOW, paths)
}

/** `on` only when the last rule whose action is exactly `browse_*` is {@link BROWSE_ALLOW} (fail closed). */
export function browseOf(rules: ReadonlyArray<Permission.Rule>): Approval.Browse {
  const last = rules.findLast((rule) => rule.action === OwnBrowse.ACTIONS)
  return last !== undefined && sameRule(last, BROWSE_ALLOW) ? "on" : "off"
}

/**
 * `rule` inserted before the trailing own bundle rules (mode rules and protected denies) of `rules`, and before the
 * browser plugin's attachment allows among or after them.
 */
function beforeOwnTail(rules: ReadonlyArray<Permission.Rule>, rule: Permission.Rule, paths: ReadonlyArray<string>) {
  const own = [
    ...MODES.flatMap((item) => CORE[item]),
    ...denies(paths),
    ...staleTail(rules, paths),
    BROWSER_ATTACH_ALLOW,
  ]
  const cut = rules.findLastIndex((item) => !own.some((other) => sameRule(other, item))) + 1
  return [...rules.slice(0, cut), { ...rule }, ...rules.slice(cut)]
}

/** Core's wildcard for actions (`core/src/util/wildcard.ts`): `*` any run, `?` one character, case-insensitive. */
function actionMatches(action: string, pattern: string) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${source}$`, "si").test(action)
}

function denies(paths: ReadonlyArray<string>): ReadonlyArray<Permission.Rule> {
  return paths.flatMap((resource) => PROTECTED_ACTIONS.map((action) => ({ action, resource, effect: "deny" as const })))
}

/** The actions own's bundles and protected denies decide; a wildcard action (core's `*`/`?`) may match them. */
const DECIDED = new Set<string>([
  ...MODES.flatMap((mode) => CORE[mode].map((rule) => rule.action)),
  ...PROTECTED_ACTIONS,
])

function decides(rule: Permission.Rule) {
  return DECIDED.has(rule.action) || /[*?]/.test(rule.action)
}

/** The bundles with `action`'s rule taken out of the given modes. */
function without(
  bundles: Readonly<Record<Approval.SetMode, ReadonlyArray<Permission.Rule>>>,
  action: string,
  modes: ReadonlyArray<Approval.SetMode>,
) {
  // SAFETY: the entries are built from MODES, every set mode exactly once.
  return Object.fromEntries(
    MODES.map((mode) => [
      mode,
      modes.includes(mode) ? bundles[mode].filter((rule) => rule.action !== action) : bundles[mode],
    ]),
  ) as Record<Approval.SetMode, ReadonlyArray<Permission.Rule>>
}

function sameRule(a: Permission.Rule, b: Permission.Rule) {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect
}

function sameRules(a: ReadonlyArray<Permission.Rule>, b: ReadonlyArray<Permission.Rule>) {
  return (
    a.length === b.length &&
    a.every((rule, index) => {
      const other = b[index]
      return other !== undefined && sameRule(rule, other)
    })
  )
}
