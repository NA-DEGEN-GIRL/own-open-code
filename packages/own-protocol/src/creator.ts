export * as Creator from "./creator.js"

import { Effect, Schema } from "effect"
import { CUSTOM_HARNESSES, IDS } from "./rpc-harness-routing.js"

/**
 * own's extension format `own.ext/1` (17 §3): what creator mode writes and own.creator interprets. One extension is one
 * folder of immutable versions under `OWN_HOME\creator\ext\<id>\v<n>\`, each holding an `extension.json` this schema
 * decodes; `store.json` names the active version, whether the extension is on and the project folders it is limited
 * to (17 §4). A version that does not decode, or whose files changed after it was written, never activates.
 *
 * Every stage shares the format: C0 and C1 are `declarative` (items own interprets, no code runs in the service), C2
 * is `mcp` (generated MCP servers, each in its own process, 17 §11) and C3 `plugin` (one code plugin in the service,
 * off by default, 17 §12). Their code is part of the version folder, so the folder's hash covers it.
 */

export const FORMAT = "own.ext/1"

/** Sizes own enforces (17 §3.4); the fragment caps keep a session's instructions small and cheap to cache. */
export const LIMITS = {
  title: 80,
  description: 1_000,
  items: 24,
  /** One prompt fragment, in characters. */
  fragment: 4_000,
  /** All fragments of one extension. */
  fragments: 12_000,
  /** All fragments every extension adds to one session; the rest are left out, in store order, and reported. */
  sessionFragments: 24_000,
  command: 2_000,
  params: 8,
  paramValue: 2_000,
  rules: 32,
  compaction: 2_000,
  /** An agent's prompt, a command's template or a skill's body. */
  markdown: 20_000,
  harnessInstructions: 100_000,
  projects: 32,
  /** Versions kept per extension; the oldest unused ones go first. */
  versions: 50,
  /** A command tool's output the model reads, in characters (the end is kept). */
  output: 30_000,
  timeoutSeconds: 600,
  /** C2/C3: files of one code item, one file's characters and all of them. */
  files: 24,
  file: 200_000,
  filesTotal: 600_000,
  /** C2: servers in one extension, allow-listed dependencies of one server, smoke calls, fetch hosts of one server. */
  servers: 4,
  dependencies: 8,
  smoke: 8,
  hosts: 8,
  /** C2: one tool call's time and the server's memory. */
  callSeconds: 300,
  memoryMb: 2_048,
} as const

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const pattern = (regex: RegExp, max: number) => Schema.String.check(Schema.isPattern(regex), Schema.isMaxLength(max))

/** `my-extension`: a lowercase letter, then letters, digits and `-`, 2 to 40 characters. */
export const ID = pattern(/^[a-z][a-z0-9-]{1,39}$/, 40).annotate({ identifier: "Own.Creator.ID" })
export type ID = typeof ID.Type

/** A name glob: letters, digits, `.`, `_`, `-`, `/`, `:` and `*`. */
const Glob = pattern(/^[A-Za-z0-9._*/:-]{1,128}$/, 128)

/** An absolute project folder; own.creator also refuses roots, own's home and the config folder (17 §4.3). */
export const Folder = text(1_024).annotate({ identifier: "Own.Creator.Folder" })

/**
 * Where an item applies inside the extension's projects. Every given list must match; a missing one matches all.
 * `model` globs match `<provider>/<model>` or the model id alone, `agent` the agent id, `project` a folder and the
 * folders inside it.
 */
export const When = Schema.Struct({
  harness: Schema.optionalKey(Schema.Array(Schema.Literals(IDS)).check(Schema.isMaxLength(IDS.length))),
  agent: Schema.optionalKey(Schema.Array(Glob).check(Schema.isMaxLength(16))),
  model: Schema.optionalKey(Schema.Array(Glob).check(Schema.isMaxLength(16))),
  project: Schema.optionalKey(Schema.Array(Folder).check(Schema.isMaxLength(LIMITS.projects))),
}).annotate({ identifier: "Own.Creator.When" })
export type When = typeof When.Type

const Key = pattern(/^[a-z0-9][a-z0-9-]{0,31}$/, 32)

/** C1: text added to the session's instructions as an instruction entry, never to the system prompt (17 §5.1). */
export const Fragment = Schema.Struct({
  type: Schema.Literal("prompt.fragment"),
  id: Key,
  text: text(LIMITS.fragment),
  when: Schema.optionalKey(When),
}).annotate({ identifier: "Own.Creator.Fragment" })
export type Fragment = typeof Fragment.Type

export const ToolName = pattern(/^[a-z][a-z0-9_]{1,39}$/, 40)
const ParamName = pattern(/^[a-z][a-z0-9_]{0,31}$/, 32)

export const Param = Schema.Struct({
  type: Schema.Literals(["string", "number", "boolean"]),
  description: text(500),
  enum: Schema.optionalKey(Schema.Array(text(200)).check(Schema.isMinLength(1), Schema.isMaxLength(32))),
  optional: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "Own.Creator.Param" })
export type Param = typeof Param.Type

/**
 * C1: a tool that runs one command template (17 §5.2). `{{name}}` placeholders take the call's arguments, quoted for
 * the shell; the whole command goes through the harness's shell approval (`shell.authorize`). A Code Mode tool by
 * default; `direct: true` lists it among the request's tools, which breaks the prompt cache of open sessions whenever
 * it changes.
 */
export const CommandTool = Schema.Struct({
  type: Schema.Literal("tool.command"),
  name: ToolName,
  description: text(LIMITS.description),
  command: text(LIMITS.command),
  params: Schema.optionalKey(Schema.Record(ParamName, Param)),
  /** A folder inside the project, relative; the project folder when missing. */
  cwd: Schema.optionalKey(pattern(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).{1,256}$/, 256)),
  shell: Schema.optionalKey(Schema.Literals(["default", "powershell", "bash", "sh"])),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.timeoutSeconds })),
  ),
  direct: Schema.optionalKey(Schema.Boolean),
  when: Schema.optionalKey(When),
}).annotate({ identifier: "Own.Creator.CommandTool" })
export type CommandTool = typeof CommandTool.Type

/**
 * One allow or deny rule. `tool` matches tool names (any call, Code Mode's too); `permission` matches a permission
 * action (`shell`, `edit`, `webfetch`, …) with `pattern` against its resources (default `*`). `deny` and `ask` only
 * tighten; `allow` loosens and stays inactive until the user approves it in Settings (17 §5.3).
 */
export const Rule = Schema.Struct({
  tool: Schema.optionalKey(Glob),
  permission: Schema.optionalKey(Glob),
  pattern: Schema.optionalKey(text(512)),
  effect: Schema.Literals(["deny", "ask", "allow"]),
  reason: Schema.optionalKey(text(200)),
}).annotate({ identifier: "Own.Creator.Rule" })
export type Rule = typeof Rule.Type

export const ToolRule = Schema.Struct({
  type: Schema.Literal("tool.rule"),
  rules: Schema.Array(Rule).check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.rules)),
  when: Schema.optionalKey(When),
}).annotate({ identifier: "Own.Creator.ToolRule" })
export type ToolRule = typeof ToolRule.Type

/**
 * C1: fewer or shorter model retries (17 §5.4). Only backoff retries are touched; own's immediate retries (an account
 * switch, a refreshed login) are left alone. Core retries at most 10 times, 2 s doubling to 10 s.
 */
export const Retry = Schema.Struct({
  type: Schema.Literal("retry"),
  maxRetries: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
  maxDelaySeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 10 }))),
  when: Schema.optionalKey(When),
}).annotate({ identifier: "Own.Creator.Retry" })
export type Retry = typeof Retry.Type

/** C1: text added at the end of own's compaction prompt (17 §5.5, core P-025). */
export const CompactionPrompt = Schema.Struct({
  type: Schema.Literal("compaction.prompt"),
  text: text(LIMITS.compaction),
  when: Schema.optionalKey(When),
}).annotate({ identifier: "Own.Creator.CompactionPrompt" })
export type CompactionPrompt = typeof CompactionPrompt.Type

const Name = pattern(/^[a-z][a-z0-9-]{1,39}$/, 40)
const ModelRef = pattern(/^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._:/-]{1,128}$/, 193)

/** C0: an agent, as an agent markdown file says it (17 §6.2). Its permissions come from `tool.rule` items. */
export const AgentItem = Schema.Struct({
  type: Schema.Literal("agent"),
  name: Name,
  description: text(LIMITS.description),
  mode: Schema.Literals(["primary", "subagent", "all"]),
  prompt: text(LIMITS.markdown),
  model: Schema.optionalKey(ModelRef),
  hidden: Schema.optionalKey(Schema.Boolean),
  steps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
}).annotate({ identifier: "Own.Creator.AgentItem" })
export type AgentItem = typeof AgentItem.Type

/** C0: a slash command; `$ARGUMENTS` and `$1`…`$9` take what follows the command. */
export const CommandItem = Schema.Struct({
  type: Schema.Literal("command"),
  name: Name,
  description: Schema.optionalKey(text(LIMITS.description)),
  template: text(LIMITS.markdown),
}).annotate({ identifier: "Own.Creator.CommandItem" })
export type CommandItem = typeof CommandItem.Type

/** C0: a skill (`SKILL.md`'s description and body). */
export const SkillItem = Schema.Struct({
  type: Schema.Literal("skill"),
  name: pattern(/^[a-z][a-z0-9-]{1,63}$/, 64),
  description: text(1_024),
  content: text(LIMITS.markdown),
}).annotate({ identifier: "Own.Creator.SkillItem" })
export type SkillItem = typeof SkillItem.Type

/** C0: a harness's 내 지시문 (10 §3.11), saved through own.harness; one text per harness for every project. */
export const HarnessInstructions = Schema.Struct({
  type: Schema.Literal("harness.instructions"),
  harness: Schema.Literals(CUSTOM_HARNESSES),
  text: text(LIMITS.harnessInstructions),
}).annotate({ identifier: "Own.Creator.HarnessInstructions" })
export type HarnessInstructions = typeof HarnessInstructions.Type

/** A file of a code item: a relative path inside the version, `/`-separated, without `.` or `..` parts. */
export const FilePath = pattern(/^(?![/\\])(?![A-Za-z]:)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,128}$/, 128).annotate({
  identifier: "Own.Creator.FilePath",
})

const Files = Schema.Record(FilePath, Schema.String.check(Schema.isMaxLength(LIMITS.file)))

/** An npm package name (`zod`, `@scope/name`) and an exact version (no ranges: what installs is what was approved). */
const PackageName = pattern(/^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/, 200)
const PackageVersion = pattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 64)

/**
 * A host a C2 server may fetch from (17 §11.3): a lowercase name or address, optionally with a port (`api.example.com`,
 * `127.0.0.1:8080`, `[::1]:3000`). No wildcards: each host is named and approved with the version.
 */
export const FetchHost = pattern(
  /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/,
  260,
).annotate({ identifier: "Own.Creator.FetchHost" })

/** One call the staging smoke test makes as the model would (17 §11.4): the tool, its arguments, text to expect. */
export const SmokeCall = Schema.Struct({
  tool: pattern(/^[A-Za-z0-9_-]{1,64}$/, 64),
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  expect: Schema.optionalKey(text(500)),
}).annotate({ identifier: "Own.Creator.SmokeCall" })
export type SmokeCall = typeof SmokeCall.Type

/**
 * C2: a generated MCP server (17 §11). Its files are written into the version folder beside own's helper `own-mcp.ts`;
 * `entry` imports the helper and calls `serve`. It runs inside own's WebAssembly JavaScript sandbox (QuickJS) in a
 * process of its own: no environment, process, Bun or disk, only own's bridge (the project's files and the declared
 * `hosts`), and every call asks the approval mode (17 §11.5). Its tools are Code Mode tools unless `direct`. Before a
 * version is written the staging steps run (install and bundle, typecheck, tests and smoke in the sandbox); a failure
 * writes nothing and the previous version stays.
 */
export const McpServer = Schema.Struct({
  type: Schema.Literal("mcp.server"),
  name: pattern(/^[a-z][a-z0-9-]{1,23}$/, 24),
  description: Schema.optionalKey(text(LIMITS.description)),
  files: Files,
  /** The file the server starts from (default `server.ts`). */
  entry: Schema.optionalKey(FilePath),
  /** npm packages from own's allow-list at exact versions, installed and bundled before activation, no install scripts. */
  dependencies: Schema.optionalKey(Schema.Record(PackageName, PackageVersion)),
  /** Hosts the server's `context.fetch` may reach; the user approves them with the version (17 §11.5). */
  hosts: Schema.optionalKey(Schema.Array(FetchHost).check(Schema.isMaxLength(LIMITS.hosts))),
  smoke: Schema.optionalKey(Schema.Array(SmokeCall).check(Schema.isMaxLength(LIMITS.smoke))),
  timeoutSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.callSeconds }))),
  memoryMb: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: LIMITS.memoryMb }))),
  direct: Schema.optionalKey(Schema.Boolean),
  when: Schema.optionalKey(When),
}).annotate({ identifier: "Own.Creator.McpServer" })
export type McpServer = typeof McpServer.Type

/** The hooks a C3 plugin may add: the request (`context`) and compaction (17 §12.2). */
export const PLUGIN_HOOKS = ["context", "compaction"] as const
export type PluginHook = (typeof PLUGIN_HOOKS)[number]

/**
 * C3: a code plugin in the service process (17 §12), for request or compaction hooks no declarative item expresses.
 * Off by default (Settings > 확장's switch). `entry` default-exports `definePlugin({...})` from own's API file
 * `own-plugin.ts`; own's shim loads it with a filtered view (no credentials, no other domains). `cache: "keeps"` (the
 * default) makes staging require the cached prefix of a fixed request to stay byte for byte (the golden comparison).
 */
export const PluginCode = Schema.Struct({
  type: Schema.Literal("plugin.code"),
  files: Files,
  entry: Schema.optionalKey(FilePath),
  hooks: Schema.Array(Schema.Literals(PLUGIN_HOOKS)).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  cache: Schema.optionalKey(Schema.Literals(["keeps", "breaks"])),
}).annotate({ identifier: "Own.Creator.PluginCode" })
export type PluginCode = typeof PluginCode.Type

export const Item = Schema.Union([
  Fragment,
  CommandTool,
  ToolRule,
  Retry,
  CompactionPrompt,
  AgentItem,
  CommandItem,
  SkillItem,
  HarnessInstructions,
  McpServer,
  PluginCode,
]).annotate({ identifier: "Own.Creator.Item" })
export type Item = typeof Item.Type
export type ItemType = Item["type"]

export const ITEM_TYPES = [
  "prompt.fragment",
  "tool.command",
  "tool.rule",
  "retry",
  "compaction.prompt",
  "agent",
  "command",
  "skill",
  "harness.instructions",
  "mcp.server",
  "plugin.code",
] as const satisfies ReadonlyArray<ItemType>

/** `declarative` (C0, C1), `mcp` (C2: one or more `mcp.server` items) and `plugin` (C3: one `plugin.code` item). */
export const KINDS = ["declarative", "mcp", "plugin"] as const
export type Kind = (typeof KINDS)[number]

/** `extension.json` of one version. */
export const Extension = Schema.Struct({
  format: Schema.Literal(FORMAT),
  id: ID,
  title: text(LIMITS.title),
  description: Schema.optionalKey(text(LIMITS.description)),
  kind: Schema.optionalKey(Schema.Literals(KINDS)),
  items: Schema.Array(Item).check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.items)),
}).annotate({ identifier: "Own.Creator.Extension" })
export type Extension = typeof Extension.Type

/** A reason a version cannot activate, with the JSON path it is about. */
export interface Problem {
  readonly path: string
  readonly message: string
}

/**
 * What the schema cannot say: one target per rule, unique ids and names, the fragments' total, placeholders that name
 * parameters, and the reserved kinds. Cross-extension checks (a tool name another extension uses) are own.creator's.
 */
export function problems(extension: Extension): ReadonlyArray<Problem> {
  const found: Problem[] = []
  const add = (path: string, message: string) => void found.push({ path, message })
  kindProblems(extension).forEach((problem) => add(problem.path, problem.message))
  const seen = new Map<string, number>()
  extension.items.forEach((item, index) => {
    const at = `items[${index}]`
    const key = identity(item)
    if (key !== undefined) {
      const first = seen.get(key)
      if (first !== undefined) add(at, `duplicate ${key} (also items[${first}])`)
      seen.set(key, index)
    }
    if (item.type === "tool.rule")
      item.rules.forEach((rule, n) => {
        if ((rule.tool === undefined) === (rule.permission === undefined))
          add(`${at}.rules[${n}]`, "a rule names exactly one of tool and permission")
        if (rule.tool !== undefined && rule.pattern !== undefined)
          add(`${at}.rules[${n}]`, "pattern applies to permission rules only")
      })
    if (item.type === "mcp.server" || item.type === "plugin.code")
      fileProblems(item, at).forEach((problem) => add(problem.path, problem.message))
    if (item.type === "mcp.server" && Object.keys(item.dependencies ?? {}).length > LIMITS.dependencies)
      add(`${at}.dependencies`, `at most ${LIMITS.dependencies} dependencies`)
    if (item.type === "tool.command") {
      const params = new Set(Object.keys(item.params ?? {}))
      placeholders(item.command)
        .filter((name) => !params.has(name))
        .forEach((name) => add(`${at}.command`, `{{${name}}} names no parameter`))
      if (Object.keys(item.params ?? {}).length > LIMITS.params)
        add(`${at}.params`, `at most ${LIMITS.params} parameters`)
    }
  })
  const total = fragmentChars(extension)
  if (total > LIMITS.fragments) add("items", `fragments total ${total} characters, more than ${LIMITS.fragments}`)
  return found
}

/** Which items each kind holds: code items only in their kind, and a plugin is its one item alone. */
function kindProblems(extension: Extension): ReadonlyArray<Problem> {
  const kind = kindOf(extension)
  const servers = extension.items.filter((item) => item.type === "mcp.server").length
  const plugins = extension.items.filter((item) => item.type === "plugin.code").length
  if (kind === "declarative" && servers + plugins > 0)
    return [{ path: "kind", message: "mcp.server items need kind 'mcp' and plugin.code items kind 'plugin'" }]
  if (kind === "mcp") {
    if (plugins > 0) return [{ path: "kind", message: "plugin.code items need kind 'plugin'" }]
    if (servers === 0) return [{ path: "items", message: "an 'mcp' extension has at least one mcp.server item" }]
    if (servers > LIMITS.servers) return [{ path: "items", message: `at most ${LIMITS.servers} mcp.server items` }]
  }
  if (kind === "plugin" && (plugins !== 1 || extension.items.length !== 1))
    return [{ path: "items", message: "a 'plugin' extension has exactly one plugin.code item and nothing else" }]
  return []
}

/**
 * Files that configure an installer or a runtime (a registry, a preload script, secrets): no code item may hold one at
 * any depth (17 §11.6), compared case-insensitively by the file's own name.
 */
const CONFIG_FILES = /^(?:\.npmrc|\.yarnrc.*|bunfig\.toml|\.bunfig\.toml|\.env.*|\.pnpmfile\.c?js|\.pnpmrc)$/i

/**
 * Own's files in a code item's folder, which an extension may not write itself. A plugin's `server.ts` and `index.ts`
 * are own's too: the shim core loads (17 §12.2).
 */
export const OWN_FILES: ReadonlyArray<string> = [
  "own-mcp.ts",
  "own-plugin.ts",
  "tsconfig.json",
  "extension.json",
  "package.json",
  "bunfig.toml",
  "bun.lock",
]

/** The files of a code item: the entry among them, own's names and `node_modules` left alone, and the size caps. */
function fileProblems(item: McpServer | PluginCode, at: string): ReadonlyArray<Problem> {
  const names = Object.keys(item.files)
  const entry = entryOf(item)
  const total = Object.values(item.files).reduce((sum, file) => sum + file.length, 0)
  return [
    ...(names.length === 0 || names.length > LIMITS.files
      ? [{ path: `${at}.files`, message: `1 to ${LIMITS.files} files` }]
      : []),
    ...(total > LIMITS.filesTotal ? [{ path: `${at}.files`, message: `more than ${LIMITS.filesTotal} characters` }] : []),
    ...(names.includes(entry) ? [] : [{ path: `${at}.entry`, message: `'${entry}' is not one of the files` }]),
    ...(/\.[cm]?[jt]s$/.test(entry) ? [] : [{ path: `${at}.entry`, message: "the entry is a .ts or .js file" }]),
    ...names.flatMap((name) =>
      OWN_FILES.includes(name.toLowerCase()) ||
      name.toLowerCase().startsWith("node_modules/") ||
      (item.type === "plugin.code" && /^(?:server|index)\.[cm]?[jt]sx?$/i.test(name))
        ? [{ path: `${at}.files`, message: `'${name}' is own's file` }]
        : CONFIG_FILES.test(name.split("/").at(-1) ?? "")
          ? [{ path: `${at}.files`, message: `'${name}' configures an installer or runtime; code items may not hold one` }]
          : [],
    ),
  ]
}

/** The file a code item starts from: `entry`, else `server.ts` (C2) or `plugin.ts` (C3). */
export function entryOf(item: McpServer | PluginCode) {
  return item.entry ?? (item.type === "mcp.server" ? "server.ts" : "plugin.ts")
}

/** The extension's kind, `declarative` when missing. */
export function kindOf(extension: Pick<Extension, "kind">): Kind {
  return extension.kind ?? "declarative"
}

/** The `{{name}}` placeholders of a command template, in order, each once. */
export function placeholders(command: string) {
  return [...new Set([...command.matchAll(/\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g)].map((match) => match[1]!))]
}

export function fragmentChars(extension: Pick<Extension, "items">) {
  return extension.items.reduce((sum, item) => sum + (item.type === "prompt.fragment" ? item.text.length : 0), 0)
}

/** The id an item claims, for duplicates: fragments by id, tools, agents, commands and skills by name. */
export function identity(item: Item) {
  if (item.type === "prompt.fragment") return `fragment '${item.id}'`
  if (item.type === "tool.command") return `tool '${item.name}'`
  if (item.type === "agent") return `agent '${item.name}'`
  if (item.type === "command") return `command '${item.name}'`
  if (item.type === "skill") return `skill '${item.name}'`
  if (item.type === "harness.instructions") return `harness instructions '${item.harness}'`
  if (item.type === "mcp.server") return `server '${item.name}'`
  return undefined
}

/**
 * The MCP server name own registers a `mcp.server` item under: `creator-<id>-<name>`. Core names its tools
 * `<server>_<tool>` and asks that name as the permission, which an extension's allow rule can never loosen.
 */
export function serverName(id: string, name: string) {
  return `${SERVER_PREFIX}${id}-${name}`
}

/**
 * The start of every C2 tool's permission (`creator-<id>-<name>_<tool>`), apart from creator mode's own write action
 * `creator`: read-only roles are denied every C2 tool by it (07 §2.4, merge round 11 MR15).
 */
export const SERVER_PREFIX = "creator-"

/** The name a command tool is registered under: `ext_<name>`, apart from core's and the harnesses' tools. */
export function toolName(name: string) {
  return `ext_${name}`
}

/**
 * What one item does, for approval cards, the inspect tool and Settings (17 §7). `cache` says what it does to the
 * prompt cache of open sessions: `keeps` (appended after the conversation), `new` (only new requests of a new kind:
 * compaction), `breaks` (a direct tool changes the tool list), `none` (no request text).
 */
export interface ItemEffect {
  readonly type: ItemType
  readonly name: string
  readonly cache: "keeps" | "breaks" | "none" | "new"
  /** Code that runs: `process` (C2, own's sandbox in a process of its own) or `service` (C3, in the service). */
  readonly code?: "process" | "service"
  /** An allow rule: inactive until the user approves it. */
  readonly loosens: boolean
  /** Applies in every project whatever the extension's scope (C0 items own keeps one copy of). */
  readonly global: boolean
}

export function effects(extension: Pick<Extension, "items">): ReadonlyArray<ItemEffect> {
  return extension.items.map((item) => ({
    type: item.type,
    name: itemName(item),
    cache: cacheOf(item),
    loosens: item.type === "tool.rule" && item.rules.some((rule) => rule.effect === "allow"),
    global: item.type === "harness.instructions" || item.type === "plugin.code",
    ...(item.type === "mcp.server" ? { code: "process" as const } : {}),
    ...(item.type === "plugin.code" ? { code: "service" as const } : {}),
  }))
}

export function itemName(item: Item) {
  if (item.type === "prompt.fragment") return item.id
  if (item.type === "tool.command") return toolName(item.name)
  if (item.type === "tool.rule")
    return item.rules
      .map((rule) => `${rule.effect} ${rule.tool ?? `${rule.permission} ${rule.pattern ?? "*"}`}`)
      .join(", ")
  if (item.type === "retry")
    return [
      item.maxRetries === undefined ? [] : [`maxRetries ${item.maxRetries}`],
      item.maxDelaySeconds === undefined ? [] : [`maxDelay ${item.maxDelaySeconds}s`],
    ]
      .flat()
      .join(", ")
  if (item.type === "compaction.prompt") return `${item.text.length} chars`
  if (item.type === "harness.instructions") return item.harness
  if (item.type === "plugin.code") return item.hooks.join(", ")
  return item.name
}

function cacheOf(item: Item): ItemEffect["cache"] {
  if (item.type === "prompt.fragment") return "keeps"
  if (item.type === "tool.command") return item.direct === true ? "breaks" : "keeps"
  if (item.type === "compaction.prompt") return "new"
  // A skill's listing is an instruction update; a subagent is listed in the task tool's description.
  if (item.type === "skill") return "keeps"
  if (item.type === "agent") return item.mode === "primary" ? "none" : "breaks"
  if (item.type === "harness.instructions") return "breaks"
  if (item.type === "mcp.server") return item.direct === true ? "breaks" : "keeps"
  if (item.type === "plugin.code") return item.cache === "breaks" ? "breaks" : "keeps"
  return "none"
}

// ---- store views (17 §4) ----

export const VersionInfo = Schema.Struct({
  n: Schema.Int,
  /** sha256 of the version's files, recorded when it was written. */
  hash: Schema.String,
  createdAt: Schema.Number,
  by: Schema.Literals(["model", "user"]),
  note: Schema.optionalKey(Schema.String),
  /** C2/C3: the app version the version was staged against; a C3 version of another app version does not load. */
  app: Schema.optionalKey(Schema.String),
  /** C2/C3: the staging checks it passed, in order (17 §11.4, §12.3). */
  checks: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, ms: Schema.Number }))),
}).annotate({ identifier: "Own.Creator.VersionInfo" })
export type VersionInfo = typeof VersionInfo.Type

export const HistoryEntry = Schema.Struct({
  at: Schema.Number,
  action: Schema.Literals([
    "create",
    "update",
    "enable",
    "disable",
    "rollback",
    "scope",
    "approve",
    "revoke",
    "trust",
    "untrust",
    "hosts",
    "host_trust",
    "host_untrust",
  ]),
  version: Schema.optionalKey(Schema.Int),
  by: Schema.Literals(["model", "user"]),
  /** `host_trust`/`host_untrust`: the SSH host the approval is about (17 §10). */
  host: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Own.Creator.HistoryEntry" })
export type HistoryEntry = typeof HistoryEntry.Type

/** An SSH host's id (`OwnRemote.HostID`, 04): `h-` and 6–8 lowercase letters or digits. */
export const HostID = pattern(/^h-[a-z0-9]{6,8}$/, 10).annotate({ identifier: "Own.Creator.HostID" })

/**
 * Which SSH hosts an extension reaches (17 §10): every host (`all`, the default), only `ids` (`only`; empty = none), or
 * every host but `ids` (`except`). Only the PC changes it (Settings).
 */
export const Hosts = Schema.Struct({
  mode: Schema.Literals(["all", "only", "except"]),
  ids: Schema.Array(HostID).check(Schema.isMaxLength(64)),
}).annotate({ identifier: "Own.Creator.Hosts" })
export type Hosts = typeof Hosts.Type

/**
 * A project folder on an SSH host: a scope entry tagged with its host (17 §10). The folder is the host's path (POSIX on
 * a Linux host); the PC cannot see it, so the host checks it again before it applies.
 */
export const HostFolder = Schema.Struct({ host: HostID, directory: Folder }).annotate({
  identifier: "Own.Creator.HostFolder",
})
export type HostFolder = typeof HostFolder.Type

/** C3 on a host: the user's approval of version `n` for that one host, apart from the PC's own trust (17 §10). */
export const HostTrust = Schema.Struct({ host: HostID, n: Schema.Int }).annotate({ identifier: "Own.Creator.HostTrust" })
export type HostTrust = typeof HostTrust.Type

/**
 * One extension of `store.json`. `projects` (this PC's folders) and `hostProjects` (host folders) both empty means every
 * project everywhere it reaches; otherwise only the listed folders, each on its own machine.
 */
export const Entry = Schema.Struct({
  id: ID,
  active: Schema.Int,
  enabled: Schema.Boolean,
  projects: Schema.Array(Folder),
  /** Host folders of the scope (17 §10); empty with `projects` empty = every project. */
  hostProjects: Schema.Array(HostFolder).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** The SSH hosts the extension reaches; absent = every host (17 §10). */
  hosts: Schema.optionalKey(Hosts),
  /** C3: versions the user allowed on a host, per host (Settings only, 17 §10); never implied by `trusted`. */
  hostTrusted: Schema.Array(HostTrust).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Versions whose allow rules the user approved (Settings only, never a model tool). */
  loosen: Schema.Array(Schema.Int),
  /** C2: versions whose first tool call the user approved; until then full approval asks too (17 §11.5). */
  confirmed: Schema.Array(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** C3: versions the user approved to load in the service (Settings only, 17 §12.4). */
  trusted: Schema.Array(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  versions: Schema.Array(VersionInfo),
  history: Schema.Array(HistoryEntry),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: "Own.Creator.Entry" })
export type Entry = typeof Entry.Type

export const STORE_VERSION = 1

/** Store-wide switches (Settings only). `plugins`: C3 code plugins may be made and load (off by default). */
export const Settings = Schema.Struct({
  plugins: Schema.Boolean,
}).annotate({ identifier: "Own.Creator.Settings" })
export type Settings = typeof Settings.Type

export const StoreFile = Schema.Struct({
  version: Schema.Literal(STORE_VERSION),
  extensions: Schema.Array(Entry),
  settings: Schema.optionalKey(Settings),
}).annotate({ identifier: "Own.Creator.StoreFile" })
export type StoreFile = typeof StoreFile.Type

/** Why an active version does not apply now. */
/**
 * `pending`: a C3 version waiting for the user's approval; `outdated`: a C3 version staged for another app version;
 * `unavailable`: a C3 extension while the code plugin switch is off.
 */
export const Status = Schema.Literals([
  "active",
  "disabled",
  "invalid",
  "tampered",
  "missing",
  "unavailable",
  "pending",
  "outdated",
]).annotate({ identifier: "Own.Creator.Status" })
export type Status = typeof Status.Type

export const EffectView = Schema.Struct({
  type: Schema.Literals(ITEM_TYPES),
  name: Schema.String,
  cache: Schema.Literals(["keeps", "breaks", "none", "new"]),
  loosens: Schema.Boolean,
  global: Schema.Boolean,
  code: Schema.optionalKey(Schema.Literals(["process", "service"])),
})

/** A C3 hook that threw in one Location: the plugin stays off there until the user clears it (17 §12.6). */
export const Crash = Schema.Struct({
  directory: Schema.String,
  version: Schema.Int,
  at: Schema.Number,
  hook: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "Own.Creator.Crash" })
export type Crash = typeof Crash.Type

/** An extension as Settings and the inspect tool show it. */
export const View = Schema.Struct({
  id: ID,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  status: Status,
  kind: Schema.Literals(KINDS),
  enabled: Schema.Boolean,
  active: Schema.Int,
  projects: Schema.Array(Schema.String),
  /** The active version's allow rules wait for the user's approval. */
  loosenPending: Schema.Boolean,
  effects: Schema.Array(EffectView),
  problems: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
  versions: Schema.Array(VersionInfo),
  history: Schema.Array(HistoryEntry),
  updatedAt: Schema.Number,
  /** C3: versions the user approved; the active one must be among them to load. */
  trusted: Schema.Array(Schema.Int),
  /** C2: versions whose first call the user approved. */
  confirmed: Schema.Array(Schema.Int),
  /** C3: Locations where a hook threw and the plugin stopped there (17 §12.6). */
  crashes: Schema.Array(Crash),
  /** Host folders of the scope (17 §10). */
  hostProjects: Schema.Array(Schema.Struct({ host: Schema.String, directory: Schema.String })),
  /** The SSH hosts the extension reaches. */
  hosts: Schema.Struct({ mode: Schema.Literals(["all", "only", "except"]), ids: Schema.Array(Schema.String) }),
  /** C3: versions allowed per host. */
  hostTrusted: Schema.Array(Schema.Struct({ host: Schema.String, n: Schema.Int })),
  /** Per host this PC knows: whether the extension reaches it and what the host reported (17 §10). */
  remote: Schema.Array(
    Schema.Struct({
      host: Schema.String,
      reach: Schema.Literals(["sent", "excluded", "out_of_scope", "pc_only", "inactive"]),
      state: Schema.optionalKey(
        Schema.Struct({
          id: Schema.String,
          n: Schema.Int,
          status: Schema.String,
          problems: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
        }),
      ),
    }),
  ),
}).annotate({ identifier: "Own.Creator.View" })
export type View = typeof View.Type

// ---- SSH hosts (17 §10) ----

/** One file of a mirrored version: its path in the version folder (`/`-separated) and its size in bytes. */
export const MirrorFile = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Own.Creator.MirrorFile" })
export type MirrorFile = typeof MirrorFile.Type

/** Limits of what one host gets: files and bytes of one mirrored version, and one `creator.file` chunk. */
export const MIRROR_LIMITS = {
  files: 4_000,
  bytes: 64 * 1024 * 1024,
  /** Raw bytes of one chunk; base64 keeps it well under the broker's 1 MiB frame. */
  chunk: 512 * 1024,
} as const

/**
 * One extension as this PC mirrors it to one host (17 §10): its active version's record (the hash the host checks the
 * files against before anything applies) and file list, the host's folders of its scope (empty = every project
 * there), whether the PC user approved the version's allow rules, and for C3 whether the user allowed this version on
 * this host. Only extensions in force on the PC that reach the host are sent; C3 only with that host's allowance.
 */
export const MirrorEntry = Schema.Struct({
  id: ID,
  kind: Schema.Literals(KINDS),
  version: VersionInfo,
  files: Schema.Array(MirrorFile).check(Schema.isMaxLength(MIRROR_LIMITS.files)),
  projects: Schema.Array(Folder).check(Schema.isMaxLength(LIMITS.projects)),
  loosen: Schema.Boolean,
  hostTrusted: Schema.Boolean,
}).annotate({ identifier: "Own.Creator.MirrorEntry" })
export type MirrorEntry = typeof MirrorEntry.Type

/** What a host gets of this PC's store (`creator.get`); `revision` is a content hash of the rest. */
export const MirrorView = Schema.Struct({
  revision: Schema.String,
  /** The PC's code plugin switch (C3 loads on a host only while it is on, with that host's allowance). */
  plugins: Schema.Boolean,
  extensions: Schema.Array(MirrorEntry),
}).annotate({ identifier: "Own.Creator.MirrorView" })
export type MirrorView = typeof MirrorView.Type

/**
 * What an extension came to on a host: a store status, `checking` (its files are coming or its host staging runs) or
 * `failed` (its files did not hash as the PC's version, or its host staging failed).
 */
export const HostStatus = Schema.Literals([
  "active",
  "disabled",
  "invalid",
  "tampered",
  "missing",
  "unavailable",
  "pending",
  "outdated",
  "checking",
  "failed",
]).annotate({ identifier: "Own.Creator.HostStatus" })
export type HostStatus = typeof HostStatus.Type

/** A host trims its problems to these lengths (`mirror.ts`); the PC refuses longer ones (a report stays small). */
const ProblemSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(200)),
  message: Schema.String.check(Schema.isMaxLength(400)),
})

export const HostState = Schema.Struct({
  id: ID,
  n: Schema.Int,
  status: HostStatus,
  problems: Schema.Array(ProblemSchema).check(Schema.isMaxLength(8)),
}).annotate({ identifier: "Own.Creator.HostState" })
export type HostState = typeof HostState.Type

/** A host's account of the mirror it applied (`creator.report`): kept in the PC's memory, never in the PC's store. */
export const HostReport = Schema.Struct({
  revision: Schema.String.check(Schema.isMaxLength(128)),
  at: Schema.Number,
  extensions: Schema.Array(HostState).check(Schema.isMaxLength(256)),
}).annotate({ identifier: "Own.Creator.HostReport" })
export type HostReport = typeof HostReport.Type

/**
 * Whether an extension reaches a host, as the PC decides it: `sent` (in that host's mirror), `excluded` (the host
 * selection leaves the host out), `out_of_scope` (the scope names folders, none on that host), `pc_only` (C3 without
 * that host's allowance for the active version, or the code plugin switch is off), `inactive` (not in force on the PC).
 */
export const HostReach = Schema.Literals(["sent", "excluded", "out_of_scope", "pc_only", "inactive"]).annotate({
  identifier: "Own.Creator.HostReach",
})
export type HostReach = typeof HostReach.Type

/** One host's line of an extension's card (17 §10): the PC's decision and what the host reported. */
export const HostView = Schema.Struct({
  host: Schema.String,
  reach: HostReach,
  /** The host's last report for this extension, when it sent one. */
  state: Schema.optionalKey(HostState),
}).annotate({ identifier: "Own.Creator.HostView" })
export type HostView = typeof HostView.Type

/** The host selection an entry means (`all` when it has none). */
export function hostsOf(entry: Pick<Entry, "hosts">): Hosts {
  return entry.hosts ?? { mode: "all", ids: [] }
}

/** Whether the host selection reaches `host`. */
export function reaches(hosts: Hosts, host: string) {
  if (hosts.mode === "all") return true
  if (hosts.mode === "only") return hosts.ids.includes(host)
  return !hosts.ids.includes(host)
}
