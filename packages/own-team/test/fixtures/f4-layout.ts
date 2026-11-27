/**
 * F4 (06 §11.2): a temp repository laid out like this user's own-open-code on 2026-10-01 (06 §0.5), plus the TG10
 * extras. Folder and branch names are the real ones; paths sit under a temp root instead of `D:\`.
 *
 *   #Projects/own-open-code                       main worktree on `computer-use`, a `#` path
 *     .claude/worktrees/computer-use-login-features-67022a, -70d892     Claude Code worktrees (nested)
 *   #Projects/codex-multi-provider/…/codex/worktrees/c39b/own-open-code   the codex app's worktree, detached at main
 *   own-open-code                                    the home: a linked worktree on `main`, ignored `node_modules/`
 *     .worktrees/cl-cu         own-computer-use: 5 commits not in main, 9 uncommitted files, a session 30 minutes ago
 *     .worktrees/cl-perf       cl-integration: 10 commits, a session in a subfolder 3 days ago
 *     .worktrees/cl-siwc       siwc-login: 6 commits, upstream = local main, a session 20 days ago
 *     .worktrees/computer-use  computer-use-dev = main, clean, a session 30 days ago
 *     .worktrees/local-model   local-model-dev = main, clean, no session
 *
 * TG10 extras: `own-detached` (detached with 2 commits no branch has, a merge in progress), `#Projects/own-hash`
 * (a `#` path candidate), `own-locked` (locked by the user), `own-gone` (its folder deleted, so prunable), two stash
 * entries (from the home and from cl-siwc), an independent clone `other-clone`, and root sessions including one whose
 * folder is gone. Unique commits are empty commits: only history matters here. TG10's conversations (the account,
 * model and preset of each root session), an own.accounts fake and the service's session routes are at the end.
 */
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Account, Preset } from "@own/protocol"
import { Identity } from "../../src/git/identity.js"
import type { FakeService } from "../support/service.js"
import { viewIdentity } from "../support/views.js"
import { git, init, write } from "./repo.js"

/** "Now" for activity: sessions are dated relative to it. */
export const F4_NOW = Date.UTC(2026, 9, 1, 12)

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export const F4_NESTED = {
  "cl-cu": { branch: "own-computer-use", commits: 5 },
  "cl-perf": { branch: "cl-integration", commits: 10 },
  "cl-siwc": { branch: "siwc-login", commits: 6 },
  "computer-use": { branch: "computer-use-dev", commits: 0 },
  "local-model": { branch: "local-model-dev", commits: 0 },
} as const

export type Nested = keyof typeof F4_NESTED

export const F4_CLAUDE = {
  "computer-use-login-features-67022a": "claude/remote-access-mobile-android-3f02fe",
  "computer-use-login-features-70d892": "claude/computer-use-login-features-70d892",
} as const

export interface F4Session {
  readonly id: string
  readonly directory: string
  readonly updated: number
}

export interface F4 {
  readonly root: string
  readonly commonDir: string
  readonly base: string
  readonly primary: string
  readonly home: string
  readonly claude: readonly string[]
  readonly codex: string
  readonly nested: Readonly<Record<Nested, string>>
  readonly detached: string
  readonly hash: string
  readonly locked: string
  readonly gone: string
  readonly otherClone: string
  /** Root sessions, by name. */
  readonly sessions: {
    readonly home: F4Session
    readonly primary: F4Session
    readonly claude: F4Session
    readonly cu: F4Session
    readonly perf: F4Session
    readonly siwc: F4Session
    readonly computerUse: F4Session
    readonly orphan: F4Session
    readonly other: F4Session
  }
}

export function f4(root: string): F4 {
  const programming = path.join(root, "#Projects")
  const primary = init(path.join(programming, "own-open-code"))
  write(primary, {
    ".gitignore": "node_modules\n.worktrees\n",
    "README.md": "# own-open-code\n",
    "package.json": '{ "name": "own-open-code" }\n',
    "packages/own-web/src/index.ts": "export const web = 1\n",
    "packages/own-team/src/index.ts": "export const team = 1\n",
    "own/docs/06-team-worktrees.md": "# 06\n",
  })
  git(primary, ["add", "-A"])
  git(primary, ["commit", "-q", "-m", "seed"])
  const base = git(primary, ["rev-parse", "HEAD"]).trim()
  fs.appendFileSync(path.join(primary, ".git", "info", "exclude"), ".claude/worktrees/\n")
  git(primary, ["switch", "-q", "-c", "computer-use"])
  const add = (args: readonly string[]) => git(primary, ["worktree", "add", "-q", ...args])

  const home = path.join(root, "own-open-code")
  add([home, "main"])
  write(home, { "node_modules/pkg/index.js": "x".repeat(1_000), "node_modules/pkg/data.bin": "y".repeat(5_000) })

  const area = (name: Nested) => {
    const directory = path.join(home, ".worktrees", name)
    add(["-b", F4_NESTED[name].branch, directory, base])
    for (let index = 0; index < F4_NESTED[name].commits; index++)
      git(directory, ["commit", "-q", "--allow-empty", "-m", `${name} ${index + 1}`])
    return directory
  }
  const nested = {
    "cl-cu": area("cl-cu"),
    "cl-perf": area("cl-perf"),
    "cl-siwc": area("cl-siwc"),
    "computer-use": area("computer-use"),
    "local-model": area("local-model"),
  }

  // cl-cu: 3 modified (unstaged), 2 added (staged), 4 untracked = 9 files not in a commit.
  write(nested["cl-cu"], {
    "README.md": "# changed\n",
    "package.json": "{}\n",
    "packages/own-web/src/index.ts": "export const web = 2\n",
    "packages/own-computer-use/src/a.ts": "a\n",
    "packages/own-computer-use/src/b.ts": "b\n",
    "notes/1.md": "1\n",
    "notes/2.md": "2\n",
    "notes/3.md": "3\n",
    "notes/4.md": "4\n",
  })
  git(nested["cl-cu"], ["add", "packages/own-computer-use"])
  // An upstream without a remote: `branch.<b>.remote = .` tracks a local branch.
  git(primary, ["config", "branch.siwc-login.remote", "."])
  git(primary, ["config", "branch.siwc-login.merge", "refs/heads/main"])

  const claude = Object.entries(F4_CLAUDE).map(([name, branch]) => {
    const directory = path.join(primary, ".claude", "worktrees", name)
    add(["-b", branch, directory, base])
    return directory
  })
  const codex = path.join(
    programming,
    "codex-multi-provider",
    "work",
    "control-center",
    "profiles",
    "1a2b3c4d-7545-4d0e-a934-20fe8364ab06",
    "codex",
    "worktrees",
    "c39b",
    "own-open-code",
  )
  add(["--detach", codex, base])

  const detached = path.join(root, "own-detached")
  add(["--detach", detached, base])
  git(detached, ["commit", "-q", "--allow-empty", "-m", "detached 1"])
  git(detached, ["commit", "-q", "--allow-empty", "-m", "detached 2"])
  git(detached, ["merge", "-q", "--no-ff", "--no-commit", "cl-integration"])
  const hash = path.join(programming, "own-hash")
  add(["-b", "hash-work", hash, base])
  const locked = path.join(root, "own-locked")
  add(["-b", "user-locked", locked, base])
  git(primary, ["worktree", "lock", "--reason", "kept by the user", locked])
  const gone = path.join(root, "own-gone")
  add(["-b", "gone-work", gone, base])
  fs.rmSync(gone, { recursive: true, force: true })

  // Stash entries: stash@{1} from the home (`On main: …`), stash@{0} from cl-siwc (`WIP on siwc-login: …`).
  write(home, { "README.md": "# home wip\n" })
  git(home, ["stash", "push", "-q", "-m", "home wip"])
  write(nested["cl-siwc"], { "README.md": "# siwc wip\n" })
  git(nested["cl-siwc"], ["stash", "push", "-q"])

  const otherClone = path.join(root, "other-clone")
  git(root, ["clone", "-q", primary, otherClone])

  const session = (id: string, directory: string, age: number) => ({ id, directory, updated: F4_NOW - age })
  return {
    root,
    commonDir: path.join(primary, ".git"),
    base,
    primary,
    home,
    claude,
    codex,
    nested,
    detached,
    hash,
    locked,
    gone,
    otherClone,
    sessions: {
      home: session("ses_home", home, HOUR),
      primary: session("ses_primary", primary, 2 * DAY),
      claude: session("ses_claude", path.join(claude[0], "packages"), HOUR),
      cu: session("ses_cu", nested["cl-cu"], 30 * 60 * 1000),
      // In a subfolder: the longest prefix is cl-perf, not the home around it.
      perf: session("ses_perf", path.join(nested["cl-perf"], "packages", "own-web"), 3 * DAY),
      siwc: session("ses_siwc", nested["cl-siwc"], 20 * DAY),
      computerUse: session("ses_computer_use", nested["computer-use"], 30 * DAY),
      orphan: session("ses_orphan", path.join(root, "deleted-folder"), DAY),
      other: session("ses_other", otherClone, DAY),
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// TG10 conversations (06 §3.7, §10.1, §11.3; 07 §5.4): the account, model and preset of each F4 root session, an
// own.accounts fake over them and the own service's session routes. Every value is fake.

/** The two ChatGPT logins: ChatGPT 01 is the team's, ChatGPT 02 another subscription of the same company. */
export const F4_LOGINS = { one: "login-chatgpt-01", two: "login-chatgpt-02" } as const

function view(input: {
  readonly id: string
  readonly kind: Account.View["kind"]
  readonly label: string
  readonly providerID: string
  readonly identity?: Account.View["identity"]
}) {
  return Schema.decodeUnknownSync(Account.View)({
    shortLabel: input.label.slice(-2),
    color: "indigo",
    billing: "subscription",
    status: "ready",
    autoSwitch: false,
    thirdParty: false,
    readOnly: false,
    connection: { type: "oauth" },
    ...input,
  })
}

/**
 * ChatGPT 01 (`codex`, the team main's), ChatGPT 02 (`codex`, another login), the `siwc` account of ChatGPT 01's login
 * (one subscription with it) and the Claude slot. Identities are what own-accounts' `Views.account` lists.
 */
export const F4_ACCOUNTS: ReadonlyArray<Account.View> = [
  view({
    id: "acc_chatgpt01",
    kind: "codex",
    label: "ChatGPT 01",
    providerID: "own-codex-01",
    identity: viewIdentity("codex", F4_LOGINS.one),
  }),
  view({
    id: "acc_chatgpt02",
    kind: "codex",
    label: "ChatGPT 02",
    providerID: "own-codex-02",
    identity: viewIdentity("codex", F4_LOGINS.two),
  }),
  view({
    id: "acc_siwc01",
    kind: "siwc",
    label: "ChatGPT 01 앱",
    providerID: "own-siwc-01",
    identity: viewIdentity("siwc", F4_LOGINS.one),
  }),
  view({ id: "acc_claude_slot", kind: "claude-sub", label: "Claude", providerID: "anthropic" }),
]

const ref = Schema.decodeUnknownSync(Model.Ref)

/** The main Refs F4's conversations run on. */
export const F4_REFS = {
  /** ChatGPT 01: the team main's account. */
  team: ref({ id: "gpt-6-astra", providerID: "own-codex-01", variant: "high" }),
  /** ChatGPT 02: another subscription of the team main's company (06 §10.1 R4). */
  other: ref({ id: "gpt-6-astra", providerID: "own-codex-02", variant: "high" }),
  /** The `siwc` account of ChatGPT 01's login: one subscription with the team's. */
  siwc: ref({ id: "gpt-6-sol", providerID: "own-siwc-01", variant: "medium" }),
  claude: ref({ id: "claude-opus-5", providerID: "anthropic" }),
} as const

function info(input: Pick<Preset.Info, "name" | "group" | "workers">): Preset.Info {
  return { id: Preset.ID.create(), delegation: "model", caps: Preset.CAPS, ultraCaps: null, revision: 1, ...input }
}

/** The ChatGPT group's ★ (`꼼꼼히`) and a preset that is not ★ (`다른 회사 리뷰`: review on the Claude slot, 10.1). */
export const F4_PRESETS = {
  star: info({ name: "꼼꼼히", group: "codex", workers: { mode: "same", roles: {} } }),
  review: info({
    name: "다른 회사 리뷰",
    group: "codex",
    workers: {
      mode: "by-role",
      roles: {
        "own-review": {
          targets: [{ pin: { account: Account.ID.make("acc_claude_slot"), model: Model.ID.make("claude-opus-5") } }],
          effort: "inherit",
        },
      },
    },
  }),
} as const

export interface F4Conversation extends F4Session {
  readonly model: Model.Ref
  /** The preset bound to it; absent: its group's ★ is in force (07 §5.1). */
  readonly presetID?: Preset.ID
}

/**
 * TG10's conversations: the home's and every outside folder's on ChatGPT 01; cl-cu on ChatGPT 01 with the non-★
 * `다른 회사 리뷰`; cl-perf on ChatGPT 02 (the R4 exception); cl-siwc on the siwc account of ChatGPT 01's login
 * (kept); computer-use on the Claude slot (kept).
 */
export function f4Conversations(repo: F4): ReadonlyArray<F4Conversation> {
  const sessions = repo.sessions
  return [
    { ...sessions.home, model: F4_REFS.team },
    { ...sessions.primary, model: F4_REFS.team },
    { ...sessions.claude, model: F4_REFS.team },
    { ...sessions.cu, model: F4_REFS.team, presetID: F4_PRESETS.review.id },
    { ...sessions.perf, model: F4_REFS.other },
    { ...sessions.siwc, model: F4_REFS.siwc },
    { ...sessions.computerUse, model: F4_REFS.claude },
    { ...sessions.orphan, model: F4_REFS.team },
    { ...sessions.other, model: F4_REFS.team },
  ]
}

interface Binding {
  readonly presetID: Preset.ID
  readonly group: Preset.Group
  readonly team?: Preset.Team
}

const Call = Schema.Struct({ sessionID: Schema.String })
const ApplyCall = Schema.Struct({
  sessionID: Schema.String,
  presetID: Schema.String,
  team: Schema.optional(Schema.NullOr(Preset.Team)),
})
const SetCall = Schema.Struct({ sessionID: Schema.String, mode: Schema.String })

/**
 * own.accounts over F4's accounts and presets, as its RPC answers (07 §8.1): `accounts.list`, `presets.list` (the
 * ChatGPT group's ★), `session.preset.get` (the binding, else the group's ★ in force), `session.preset.apply` judged
 * with `Preset.allowed` like the service, `session.approval.get` / `set` and `policy.get`. `models` holds each
 * session's main Ref; a test adds the sessions it makes.
 */
export function f4Accounts(answers: Map<string, (input: unknown) => unknown>, models: Map<string, Model.Ref>) {
  const bindings = new Map<string, Binding>()
  const modes = new Map<string, string>()
  const presets = [F4_PRESETS.star, F4_PRESETS.review]
  const lookup: Preset.Lookup = (accountID) => F4_ACCOUNTS.find((item) => item.id === accountID)
  const accountOf = (sessionID: string) => {
    const model = models.get(sessionID)
    return model && F4_ACCOUNTS.find((item) => item.providerID === model.providerID)
  }
  const star = (group: Preset.Group) => (group === "codex" ? F4_PRESETS.star.id : Preset.builtinID(group))
  const presetOf = (presetID: string) =>
    presets.find((item) => item.id === presetID) ??
    (Preset.isBuiltin(presetID)
      ? Preset.builtin(Schema.decodeUnknownSync(Preset.Group)(presetID.slice("builtin:".length)))
      : undefined)
  answers.set("accounts.list", () => ({ revision: 1, accounts: F4_ACCOUNTS }))
  answers.set("presets.list", () => ({
    groups: (["codex", "siwc", "claude-sub"] as const).map((group) => ({
      group,
      defaultModel: null,
      star: star(group),
      presets: [Preset.builtin(group), ...presets.filter((item) => item.group === group)].map((item) => ({
        ...item,
        status: "ok",
      })),
    })),
  }))
  answers.set("policy.get", () => ({ policy: { defaults: { byKind: {} } } }))
  answers.set("session.preset.get", (input) => {
    const sessionID = Schema.decodeUnknownSync(Call)(input).sessionID
    const group = accountOf(sessionID)?.kind
    const binding = bindings.get(sessionID)
    return {
      binding: binding ? { ...binding, revision: 1, appliedAt: 1, entryHash: null } : null,
      preset:
        group === undefined ? null : (presetOf(binding?.group === group ? binding.presetID : star(group)) ?? null),
      resolution: null,
      caps: Preset.CAPS,
      counts: { running: 0, message: 0, session: 0 },
      spend: 0,
    }
  })
  answers.set("session.preset.apply", (input) => {
    const call = Schema.decodeUnknownSync(ApplyCall)(input)
    const chosen = presetOf(call.presetID)
    if (!chosen) throw { type: "preset_not_found", message: "preset_not_found", data: { presetID: call.presetID } }
    const account = accountOf(call.sessionID)
    if (chosen.group !== account?.kind)
      throw { type: "preset_wrong_group", message: "preset_wrong_group", data: { group: account?.kind } }
    const team = call.team === undefined ? bindings.get(call.sessionID)?.team : (call.team ?? undefined)
    const verdict = Preset.allowed(chosen, account.id, lookup, team)
    if (!verdict.ok)
      throw {
        type: "same_company_subscription",
        message: "same_company_subscription",
        data: { accountID: verdict.accountID },
      }
    bindings.set(call.sessionID, { presetID: chosen.id, group: chosen.group, ...(team ? { team } : {}) })
    return { binding: {}, resolution: null, entry: "unchanged", dryRun: false }
  })
  answers.set("session.approval.get", (input) => ({
    mode: modes.get(Schema.decodeUnknownSync(Call)(input).sessionID) ?? "ask",
    rules: [],
    children: { open: 0 },
  }))
  answers.set("session.approval.set", (input) => {
    const call = Schema.decodeUnknownSync(SetCall)(input)
    modes.set(call.sessionID, call.mode)
    return { mode: call.mode, patched: [call.sessionID] }
  })
  return { bindings, modes }
}

export interface F4Stored extends F4Session {
  directory: string
  readonly model?: Model.Ref
  readonly projectID: string
  metadata: Record<string, unknown>
  /** Messages in the conversation (`session.messages`). */
  messages: number
  /** The newest seq of its log (its `log.synced` mark). */
  seq: number
  readonly entries: Map<string, unknown>
}

const Metadata = Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.Unknown) })
const Entry = Schema.Struct({ value: Schema.Unknown })
const Prompt = Schema.Struct({ prompt: Schema.String })

/**
 * The own service's session routes over F4's conversations (06 §2.6 self-HTTP): list (project, root, folder), get,
 * metadata PATCH, messages, inbox, the log's `log.synced` mark, instruction entries, the judge's `generate`, active
 * sessions and `worktree.refresh`. `answer` is the judge.
 */
export class F4Service {
  readonly sessions = new Map<string, F4Stored>()
  readonly prompts: string[] = []
  readonly refreshes: unknown[] = []
  answer: (prompt: string) => Response | string = () => '{"version":1}'

  constructor(readonly service: FakeService) {
    service.routes.set("GET /api/session", (request) => {
      const rows = [...this.sessions.values()]
        .filter(
          (item) => request.query.directory === undefined || Identity.same(item.directory, request.query.directory),
        )
        .filter((item) => request.query.project === undefined || item.projectID === request.query.project)
        .toSorted((a, b) => b.updated - a.updated)
        .slice(0, Number(request.query.limit ?? 100))
      return Response.json({ data: rows.map(sessionView), cursor: {} })
    })
    service.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    service.routes.set("POST /api/worktree/refresh", (request) => {
      this.refreshes.push(request.body)
      return new Response(null, { status: 204 })
    })
  }

  add(input: {
    readonly id: string
    readonly directory: string
    readonly updated: number
    readonly model?: Model.Ref
  }) {
    const stored: F4Stored = { projectID: "prj_test", metadata: {}, messages: 0, seq: 41, entries: new Map(), ...input }
    this.sessions.set(stored.id, stored)
    const at = `/api/session/${stored.id}`
    const entries = `/api/experimental/session/${stored.id}/instructions/entries`
    const routes = this.service.routes
    routes.set(`GET ${at}`, () => Response.json({ data: sessionView(stored) }))
    routes.set(`PATCH ${at}`, (request) => {
      stored.metadata = { ...Schema.decodeUnknownSync(Metadata)(request.body).metadata }
      return new Response(null, { status: 204 })
    })
    routes.set(`GET ${at}/message`, () =>
      Response.json({
        data: Array.from({ length: stored.messages }, (_, index) => ({ id: `msg_${index}` })),
        cursor: {},
      }),
    )
    routes.set(`GET ${at}/inbox`, () => Response.json({ data: [] }))
    routes.set(
      `GET /api/experimental/session/${stored.id}/log`,
      () =>
        new Response(`data: ${JSON.stringify({ type: "log.synced", aggregateID: stored.id, seq: stored.seq })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    routes.set(`GET ${entries}`, () =>
      Response.json({ data: [...stored.entries].map(([key, value]) => ({ key, value })) }),
    )
    for (const key of ["own.team.role", "own.team.handoff", "own.team.main.role"]) {
      routes.set(`PUT ${entries}/${key}`, (request) => {
        stored.entries.set(key, Schema.decodeUnknownSync(Entry)(request.body).value)
        return new Response(null, { status: 204 })
      })
      routes.set(`DELETE ${entries}/${key}`, () => {
        stored.entries.delete(key)
        return new Response(null, { status: 204 })
      })
    }
    routes.set(`POST ${at}/generate`, (request) => {
      this.prompts.push(Schema.decodeUnknownSync(Prompt)(request.body).prompt)
      const answer = this.answer(this.prompts.at(-1) ?? "")
      return answer instanceof Response ? answer : Response.json({ data: { text: answer } })
    })
    return stored
  }
}

function sessionView(item: F4Stored) {
  return {
    id: item.id,
    projectID: item.projectID,
    location: { directory: item.directory },
    time: { created: 1, updated: item.updated },
    metadata: item.metadata,
    ...(item.model === undefined ? {} : { model: item.model }),
  }
}
