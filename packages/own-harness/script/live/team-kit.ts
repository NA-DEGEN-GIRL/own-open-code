// Shared parts of the live team-mode runs (team.ts, team-talk.ts): a source server with own.accounts, own.team and
// own.harness through own-team's e2e harness (`startTeamServer`), whose seeded accounts carry fake credentials and
// point at the live forwarder. The forwarder puts in the real credentials and forwards to the official endpoints only:
// ChatGPT 01, the Anthropic key from set-key.ps1, DeepSeek. Any other ChatGPT account is refused (one subscription per
// company and team, 07 §5.4). Permission asks are answered (git-destructive ones rejected), confirms done, questions
// cancelled, and each is logged.
//
// With `local` (team-seat.ts) the team runs on the user's local model server alone (02 §3.3a): no forwarder is started
// and no stored key is read. The seeded cloud accounts keep the e2e harness's local fakes and are never used; a local
// model account is added without a key behind a recording proxy on 127.0.0.1, and the server's environment is cut down
// to what Windows and the tools need, with a profile folder of the run's own.
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnTeam } from "@own/protocol/rpc-team"
import { REPO_ROOT } from "../../../own-accounts/test/e2e-kit"
import {
  CHATGPT,
  SLOT,
  active,
  opEnd,
  startTeamFakes,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "../../../own-team/test/e2e/harness.ts"

export const ROUND_TIMEOUT = 50 * 60_000
/** What a dismissed question tells the asker (core's question tool: with a message the model goes on). */
const AWAY =
  "The user is away and cannot answer now. Choose what you would recommend, say so in your report, and go on."

export const MODELS = {
  gpt: { providerID: SLOT["01"], id: "gpt-6-astra", variant: "high" },
  claude: { providerID: SLOT.anthropic, id: "claude-opus-5-5", variant: "high" },
  deepseek: { providerID: SLOT.deepseek, id: "deepseek-v4-pro", variant: "high" },
} as const
export type ModelKey = keyof typeof MODELS

/** git commands the run refuses when an owner or the main asks (06: the guard asks even in full approval). */
const DESTRUCTIVE =
  /\bgit\b[^\n]*\b(push|reset\s+--hard|clean|restore|stash|worktree|branch\s+-D|checkout\s+(--|-f|\.))/

type Area = OwnTeam.AreaView

export async function startLiveTeam(options: {
  readonly name: string
  readonly out: string
  readonly keep: boolean
  readonly fixture: (base: string) => string
  /** The user's local model server instead of the cloud accounts: `url` is its OpenAI-compatible root (`.../v1`). */
  readonly local?: { readonly url: string; readonly model: string }
  /**
   * Every permission ask rejected and the server's environment cut down ({@link localEnv}), as a local run has them:
   * the direct cases on a cloud model (2026-11-17, L12 on ChatGPT 01). Always on with `local`.
   */
  readonly strict?: boolean
}) {
  const log: Array<Record<string, unknown>> = []
  const note = (entry: Record<string, unknown>) => {
    const line = { at: new Date().toISOString(), ...entry }
    log.push(line)
    console.log(JSON.stringify(line))
  }
  fs.mkdirSync(options.out, { recursive: true })
  const strict = options.local !== undefined || options.strict === true
  const forwarder = options.local ? undefined : await cloudForwarder(options.out)
  const proxy = options.local ? localProxy(options.local.url, options.out) : undefined
  const fakes = startTeamFakes()
  const team = await startTeamServer({
    name: options.name,
    project: options.fixture,
    fakes,
    codexTransport: "http",
    keepTemp: options.keep,
    ...(forwarder
      ? {
          accountsOptions: {
            endpoints: {
              codex: `${forwarder.url}/chatgpt-team`,
              anthropic: `${forwarder.url}/anthropic/v1`,
              deepseek: `${forwarder.url}/deepseek/v1`,
              // Never a real call with the fake credentials: token refresh, usage and the rest stay on the fakes.
              oauthIssuer: fakes.codex.url,
              chatgpt: `${fakes.codex.url}/backend-api`,
              openai: `${fakes.codex.url}/v1`,
              xai: `${fakes.codex.url}/v1`,
              openrouter: `${fakes.codex.url}/v1`,
              deepgram: fakes.codex.url,
            },
          },
        }
      : {}),
    ...(strict ? { env: localEnv(options.out) } : {}),
    plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
  })
  const local = proxy && options.local ? await localAccount(team, proxy.url, options.local.model) : undefined
  note({ step: "server", root: team.root, project: team.project })
  const stopWatch = watch(team, note, strict)

  const areasOf = async (teamID: OwnTeam.TeamID) => {
    const view = await team.team("team.get", { directory: team.project! })
    return view.areas.filter((area) => area.teamID === teamID && area.state === "active")
  }
  const areaOf = async (teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID) => {
    const area = (await areasOf(teamID)).find((item) => item.id === areaID)
    if (!area) throw new Error(`area ${areaID} is gone`)
    return area
  }
  const busy = async (area: Area) => area.owner.sessionID !== null && (await active(team)).has(area.owner.sessionID)

  const history = async (sessionID: string, directory: string) => {
    const pages: Array<Record<string, unknown>> = []
    const next = async (cursor: string | undefined): Promise<void> => {
      const page = (await team.server.call("GET", `/api/session/${sessionID}/message`, {
        query: cursor === undefined ? { limit: "200", order: "asc" } : { limit: "200", cursor },
        directory,
      })) as { data: Array<Record<string, unknown>>; cursor: { next?: string } }
      pages.push(...page.data)
      if (page.data.length > 0 && page.cursor.next !== undefined) await next(page.cursor.next)
    }
    await next(undefined)
    return pages
  }

  return {
    team,
    /** The local model's account and model (`local` only). */
    local,
    note,
    areasOf,
    areaOf,
    busy,
    history,

    /** The text of a conversation's last answer. */
    async answer(sessionID: string, directory: string) {
      const last = (await history(sessionID, directory)).findLast((message) => message.type === "assistant")
      return ((last?.content as Array<Record<string, unknown>> | undefined) ?? [])
        .filter((part) => part.type === "text")
        .map((part) => String(part.text))
        .join("\n")
    },

    /**
     * Pins an area to `model` and `harness`: `area.main` with `now` (an account change switches the owner in place),
     * then the owner's harness and full approval. A new owner conversation would start in own.harness' default
     * otherwise.
     */
    async pin(teamID: OwnTeam.TeamID, area: Area, model: (typeof MODELS)[ModelKey], harness: OwnHarness.HarnessID) {
      await until(async () => !(await busy(area)), `${area.name}: the owner never went idle`, ROUND_TIMEOUT)
      const set = await team.team("area.main", { teamID, areaID: area.id, model, now: true })
      if (set.opID) await opEnd(team, set.opID, { timeoutMs: 10 * 60_000 })
      const current = await areaOf(teamID, area.id)
      const owner = current.owner.sessionID
      if (owner === null) throw new Error(`${area.name}: no owner conversation`)
      const bound = await team.rpc(OwnHarness.ID, "session.set", { sessionID: owner, harness }, current.directory)
      await team.accounts("session.approval.set", { sessionID: owner, mode: "full" }, current.directory)
      note({
        step: "pin",
        area: current.name,
        owner,
        model: `${model.providerID}/${model.id}`,
        harness,
        bound: bound.status,
      })
    },

    async compact(teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID) {
      const area = await areaOf(teamID, areaID)
      const owner = area.owner.sessionID
      if (owner === null) return
      await until(async () => !(await busy(area)), `${area.name}: the owner never went idle`, ROUND_TIMEOUT)
      await team.server.call("POST", `/api/session/${owner}/compact`, { body: {}, directory: area.directory })
      await team.server.waitIdle(owner)
      note({ step: "compact", area: area.name, owner })
    },

    /** Waits until `done` holds for the areas with the main idle, noting each status change; false after the timeout. */
    async round(
      teamID: OwnTeam.TeamID,
      mainID: string,
      name: string,
      done: (areas: ReadonlyArray<Area>) => boolean,
      timeoutMs = ROUND_TIMEOUT,
    ) {
      const begun = Date.now()
      const seen = new Map<string, string>()
      while (Date.now() - begun < timeoutMs) {
        const areas = await areasOf(teamID)
        for (const area of areas) {
          const status = `${area.status.kind}: ${area.status.text}`.slice(0, 160)
          if (seen.get(area.id) !== status) note({ step: name, area: area.name, status })
          seen.set(area.id, status)
        }
        if (done(areas) && !(await active(team)).has(mainID)) {
          note({ step: name, done: true, minutes: Math.round((Date.now() - begun) / 60_000) })
          return true
        }
        await Bun.sleep(10_000)
      }
      note({ step: name, done: false, timeout: true })
      return false
    },

    /** A conversation's harness, the models its answers came from, tool calls, sub-agents and compactions. */
    async conversation(sessionID: string, directory: string) {
      const info = (await team.server.call("GET", `/api/session/${sessionID}`, { directory })) as {
        data: { metadata?: Record<string, unknown> }
      }
      const messages = await history(sessionID, directory)
      const models = messages.flatMap((message) => {
        const model = message.model as { id?: string } | undefined
        return message.type === "assistant" && model?.id ? [model.id] : []
      })
      const tools: Record<string, number> = {}
      messages.forEach((message) =>
        ((message.content as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((part) => part.type === "tool")
          .forEach((part) => (tools[String(part.name)] = (tools[String(part.name)] ?? 0) + 1)),
      )
      const children = (await team.server.call("GET", "/api/session", {
        query: { parentID: sessionID, limit: "50" },
        directory,
      })) as { data: Array<{ id: string }> }
      fs.writeFileSync(path.join(options.out, `${sessionID}.json`), JSON.stringify(messages, null, 2))
      return {
        sessionID,
        harness: OwnHarness.harnessOf(info.data.metadata),
        models: models.filter((model, index) => model !== models[index - 1]),
        tools,
        children: children.data.length,
        compactions: messages.filter((message) => message.type === "compaction").length,
      }
    },

    async stop(started: number) {
      stopWatch()
      fs.writeFileSync(path.join(options.out, "log.json"), JSON.stringify(log, null, 2))
      note({ step: "end", minutes: Math.round((Date.now() - started) / 60_000) })
      await team.stop()
      await fakes.stop()
      await forwarder?.stop()
      await proxy?.stop()
    },
    log,
  }
}

/** The cloud runs' credential forwarder; the modules that read stored credentials load only here. */
export async function cloudForwarder(out: string) {
  const { hasAnthropic } = await import("./credentials.js")
  if (!hasAnthropic()) throw new Error("No Anthropic key: run script/live/set-key.ps1 first")
  const { startForwarder } = await import("./forwarder.js")
  // The seeded ChatGPT accounts' fake ids: 01 is the real login 01; the others are refused.
  return startForwarder(path.join(out, "forwarder.jsonl"), { [CHATGPT["01"].accountID]: "01" })
}

/** What a local run's server keeps of this process's environment besides what the e2e harness sets itself. */
const LOCAL_ENV = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "TEMP",
  "TMP",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
])
/** Variables the e2e harness sets for the server (`childEnv`): removing one here would remove the harness's value. */
const HARNESS_ENV = /^(HOME|LOCALAPPDATA|APPDATA|CODEX_HOME|OWN_OPEN_CODE)$|^(OPENCODE_|XDG_|GIT_CONFIG_|BUN_RUNTIME_)/i

/**
 * The server's environment for a local run: every inherited variable outside {@link LOCAL_ENV} is removed, and the
 * profile is a folder of the run's own, so no tool call of a model reads this PC's user folder through a variable.
 */
export function localEnv(out: string): Record<string, string | undefined> {
  const profile = path.join(out, "profile")
  fs.mkdirSync(profile, { recursive: true })
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
  return {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => !LOCAL_ENV.has(key.toUpperCase()) && !HARNESS_ENV.test(key))
        .map((key) => [key, undefined]),
    ),
    [pathKey]: systemPath(process.env[pathKey] ?? ""),
    USERPROFILE: profile,
    USERNAME: "own-live",
    // libuv's Windows spawn puts these back from this process when a child's environment lacks them, so they are set
    // here: HOMEPATH named this PC's user folder in a model's env listing (2026-11-16, L16).
    HOMEDRIVE: path.parse(profile).root.replace(/\\$/, ""),
    HOMEPATH: profile.slice(path.parse(profile).root.length - 1),
    USERDOMAIN: "own-live",
    LOGONSERVER: "\\\\own-live",
  }
}

/**
 * The PATH entries under Windows and the program folders, plus Bun's own: a user folder entry named this PC's user
 * and led a model to the installed app (`Get-Command own` found `%LOCALAPPDATA%\own-open-code\bin`, 2026-11-16 L12),
 * and an agent session's own entries name its profile folder.
 */
function systemPath(value: string) {
  const roots = [process.env.SYSTEMROOT, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]]
    .filter((root): root is string => root !== undefined && root !== "")
    .map((root) => path.resolve(root).toLowerCase() + path.sep)
  const bun = path.dirname(process.execPath)
  const kept = value
    .split(path.delimiter)
    .filter((entry) => entry !== "" && roots.some((root) => (path.resolve(entry) + path.sep).toLowerCase().startsWith(root)))
  return [...new Set([bun, ...kept])].join(path.delimiter)
}

/**
 * A recording proxy on 127.0.0.1 in front of the local model server (it takes no key): `local.jsonl` gets one line per
 * request (conversation, model, level, tool count, status, seconds, tokens) and `local-bodies.jsonl` each chat
 * request's body, which is where a run reads what a conversation's model was really sent.
 */
function localProxy(target: string, out: string) {
  const origin = new URL(target)
  const count = { requests: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.text() : undefined
      const index = ++count.requests
      // Core names the conversation of every model request (`x-opencode-session-id`).
      const session = request.headers.get("x-opencode-session-id") ?? undefined
      const json: Record<string, unknown> =
        body !== undefined && url.pathname.endsWith("/chat/completions") ? JSON.parse(body) : {}
      if (json.messages !== undefined)
        fs.appendFileSync(
          path.join(out, "local-bodies.jsonl"),
          JSON.stringify({ index, at: Date.now(), session, body: json }) + "\n",
        )
      const headers = new Headers(request.headers)
      headers.delete("host")
      const started = Date.now()
      const upstream = await fetch(new URL(url.pathname + url.search, origin.origin), {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: request.signal,
      })
      const entry = {
        index,
        at: started,
        session,
        path: url.pathname,
        model: json.model,
        effort: json.reasoning_effort,
        tools: Array.isArray(json.tools) ? json.tools.length : 0,
        messages: Array.isArray(json.messages) ? json.messages.length : 0,
        authorization: request.headers.has("authorization"),
        status: upstream.status,
      }
      const record = (more: Record<string, unknown>) =>
        fs.appendFileSync(path.join(out, "local.jsonl"), JSON.stringify({ ...entry, ...more }) + "\n")
      if (!upstream.body) {
        record({})
        return new Response(null, { status: upstream.status, headers: upstream.headers })
      }
      const [client, mine] = upstream.body.tee()
      // The request's signal can end this copy's read as the client's copy completes: keep what arrived until then.
      const got = { text: "" }
      const decoder = new TextDecoder()
      void mine
        .pipeTo(new WritableStream({ write: (chunk) => void (got.text += decoder.decode(chunk, { stream: true })) }))
        .catch(() => undefined)
        .then(() =>
          record({
            seconds: (Date.now() - started) / 1000,
            closedEarly: json.stream === true && !got.text.includes("[DONE]"),
            promptTokens: Number([...got.text.matchAll(/"prompt_tokens":\s*(\d+)/g)].at(-1)?.[1] ?? 0),
            completionTokens: Number([...got.text.matchAll(/"completion_tokens":\s*(\d+)/g)].at(-1)?.[1] ?? 0),
          }),
        )
      return new Response(client, { status: upstream.status, headers: upstream.headers })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}${origin.pathname.replace(/\/+$/, "")}`,
    stop: () => server.stop(true),
  }
}

/**
 * The local model account of a local run (02 §3.3a), added without a key as the account screen does: what the server
 * says of `model` (window, reasoning levels), then the account and its model at the `high` level when the server names
 * one, else the first it names.
 */
async function localAccount(team: TeamServer, baseURL: string, model: string) {
  const found = await team.accounts("accounts.local.detect", { baseURL, format: "chat" })
  const listed = (found.models as Array<Record<string, unknown>>).find((item) => item.id === model)
  if (!listed) throw new Error(`the local server does not serve ${model}`)
  const added = await team.accounts("accounts.add.key", {
    kind: "compat",
    label: "Live local",
    options: {
      baseURL,
      local: { format: "chat" },
      models: [{ id: model, contextLimit: Number(listed.context ?? 131_072), outputLimit: 32_000 }],
    },
  })
  const account = added.account as Record<string, unknown>
  const providerID = String(account.providerID)
  await team.server.waitForModels([{ providerID, id: model }], 120_000)
  const levels = await waitValue(async () => {
    const mine = (await team.server.models()).find((item) => item.providerID === providerID && item.id === model)
    const variants = Array.isArray(mine?.variants)
      ? mine.variants.map((item) => String((item as Record<string, unknown>).id))
      : []
    return variants.length > 0 ? variants : undefined
  }, `${model}: the server's reasoning levels never registered`)
  return {
    accountID: String(account.id),
    levels,
    model: { providerID, id: model, variant: levels.includes("high") ? "high" : levels[0]! },
  }
}

/** A fixture repository at `<base>/<name>` holding `files`, on `main` with one commit. */
export function gitFixture(base: string, name: string, files: Readonly<Record<string, string>>) {
  const home = path.join(base, name)
  Object.entries(files).forEach(([file, text]) => {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true })
    fs.writeFileSync(path.join(home, file), text)
  })
  const git = (...argv: string[]) => {
    const run = Bun.spawnSync(["git", ...argv], { cwd: home, stdout: "pipe", stderr: "pipe" })
    if (run.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${run.stderr.toString()}`)
  }
  git("init", "-q", "-b", "main")
  git("config", "user.name", name)
  git("config", "user.email", `${name}@example.test`)
  git("add", "-A")
  git("commit", "-qm", `${name}: plan`)
  return home
}

/** `bun test` in a folder: the pass and fail counts and the output. */
export function bunTest(cwd: string) {
  const run = Bun.spawnSync(["bun", "test"], { cwd, stdout: "pipe", stderr: "pipe" })
  const output = run.stdout.toString() + run.stderr.toString()
  return {
    pass: Number(/(\d+) pass/.exec(output)?.[1] ?? 0),
    fail: Number(/(\d+) fail/.exec(output)?.[1] ?? 0),
    skip: Number(/(\d+) skip/.exec(output)?.[1] ?? 0),
    output,
  }
}

/**
 * Every 3 s: pending permission asks of the team's folders (git-destructive ones rejected, the rest once), confirms of
 * the team's ops (do), and questions (cancelled: nobody answers in these runs). Each one is noted. `strict` runs keep
 * every conversation on full approval, where the only asks left are own's protected paths: those are all rejected
 * (2026-11-16 L16: an approved ask let an owner read the test server's config and its password).
 */
function watch(server: TeamServer, note: (entry: Record<string, unknown>) => void, strict: boolean) {
  const state = { stopped: false }
  const tick = async () => {
    const view = await server.team("team.get", { directory: server.project! }).catch(() => undefined)
    const folders = [server.project!, ...(view?.areas ?? []).map((area) => area.directory)]
    for (const directory of folders) {
      const asked = (await server.server
        .call("GET", "/api/permission/request", { directory })
        .catch(() => ({ data: [] }))) as {
        data: Array<{ id: string; sessionID: string; action: string; resources: string[] }>
      }
      for (const request of asked.data) {
        const decision = strict || DESTRUCTIVE.test(request.resources.join("\n")) ? "reject" : "once"
        await server.server
          .call("POST", `/api/session/${request.sessionID}/permission/${request.id}/reply`, { body: { decision } })
          .catch(() => undefined)
        note({ step: "permission", action: request.action, resources: request.resources.slice(0, 3), decision })
      }
      const forms = (await server.server.call("GET", "/api/form", { directory }).catch(() => ({ data: [] }))) as {
        data: Array<{ id: string; sessionID: string }>
      }
      for (const form of forms.data) {
        // Since upstream v2.4 a dismissal without a message ends the asking step; with one the model goes on.
        await server.server.request("DELETE", `/api/session/${form.sessionID}/form/${form.id}`, {
          directory,
          query: { message: AWAY },
        })
        note({ step: "form", sessionID: form.sessionID, form: JSON.stringify(form).slice(0, 300) })
      }
    }
    for (const confirm of view?.pending ?? []) {
      const answered = await server.rpc(OwnTeam.ID, "op.confirm", {
        opID: confirm.opID,
        stepID: confirm.stepID,
        choice: "do",
        nonce: confirm.nonce,
      })
      note({ step: "confirm", kind: confirm.kind, text: confirm.text.slice(0, 200), status: answered.status })
    }
  }
  const loop = async () => {
    while (!state.stopped) {
      await tick().catch((error: unknown) => note({ step: "watch", error: String(error) }))
      await Bun.sleep(3_000)
    }
  }
  void loop()
  return () => void (state.stopped = true)
}

export type LiveTeam = Awaited<ReturnType<typeof startLiveTeam>>

/**
 * The user's turn: `text` to a conversation, then its answer once it went idle (noted as `name`). Prompts run in the
 * conversation's own folder; the team main's is the project.
 */
export async function say(live: LiveTeam, sessionID: string, directory: string, name: string, text: string) {
  await live.team.server.prompt(sessionID, text)
  await idle(live, sessionID, Date.now() + ROUND_TIMEOUT)
  const answer = await live.answer(sessionID, directory)
  live.note({ step: name, answer: answer.slice(0, 1500) })
  return answer
}

/**
 * `waitIdle`, asked again when Bun's fetch gives up on the open wait (its 5-minute idle limit: a team main making
 * areas on the fake rpg repository ran 6 minutes, team-split B2 2026-11-16), until `deadline`.
 */
async function idle(live: LiveTeam, sessionID: string, deadline: number): Promise<void> {
  const done = await live.team.server.waitIdle(sessionID).then(
    () => true,
    (error: unknown) => {
      if (Date.now() > deadline || !/timed out/i.test(String(error))) throw error
      return false
    },
  )
  if (!done) await idle(live, sessionID, deadline)
}

/**
 * Since 2026-10-16 `enable` makes no area from the goal alone (06 §3.4, TC-D1/TC-D2): own-web puts the goal into the
 * team main's composer as a discussion draft (own-web `own.team.enable.draft`, copied here), the user sends it, the
 * main shows a split, and creates the areas once the user agrees. A proposal that ends an area answers a plan first and
 * runs after the user's next message (06 §2.9 V-f), hence the second yes. Returns the active areas.
 */
export async function settleSplit(
  live: LiveTeam,
  teamID: OwnTeam.TeamID,
  mainID: string,
  goal: string,
  agree = "좋아요, 그 안대로 영역을 만들어 주세요.",
) {
  const project = live.team.project!
  await say(
    live,
    mainID,
    project,
    "split-discuss",
    `${goal}\n\n이 일을 팀에서 어떻게 나눌지 먼저 같이 정하자. 나누는 안을 보여 줘.`,
  )
  await say(live, mainID, project, "split-agree", agree)
  if ((await live.areasOf(teamID)).length === 0) await say(live, mainID, project, "split-yes", "네, 진행해 주세요.")
  await live.round(teamID, mainID, "split-wait", (areas) => areas.length > 0, 15 * 60_000)
  const areas = await live.areasOf(teamID)
  live.note({ step: "split", areas: areas.map((area) => ({ name: area.name, branch: area.branch })) })
  return areas
}

/**
 * A conversation's team tool calls, oldest first: each `team_<name>` call, also those inside Code Mode's `execute`
 * (`tools.team.<name>(…)`, one entry per call in the code), with the part's whole state as text (input and result).
 * `call` is that one call's own input: the input of a `team_<name>` part, or the code from that `tools.team.<name>(` to
 * the next one in an `execute` (several calls of one `execute` share its state).
 */
export async function teamToolCalls(live: LiveTeam, sessionID: string, directory: string) {
  const parts = (await live.history(sessionID, directory)).flatMap((message) =>
    ((message.content as Array<Record<string, unknown>> | undefined) ?? []).filter((part) => part.type === "tool"),
  )
  return parts.flatMap((part) => {
    const state = JSON.stringify(part.state ?? {})
    const name = String(part.name)
    const input = JSON.stringify((part.state as { input?: unknown } | undefined)?.input ?? "")
    if (name.startsWith("team_")) return [{ tool: name, state, call: input }]
    if (name !== "execute") return []
    const matches = [...input.matchAll(/tools\.team\.(\w+)\(/g)]
    return matches.map((match, index) => ({
      tool: `team_${match[1]}`,
      state,
      call: input.slice(match.index, matches[index + 1]?.index ?? input.length),
    }))
  })
}

/** Waits until no conversation of the server ran for `quietMs`; false after `timeoutMs`. */
export async function settled(live: LiveTeam, quietMs: number, timeoutMs: number) {
  const begun = Date.now()
  const mark = { since: 0 }
  while (Date.now() - begun < timeoutMs) {
    const busy = (await active(live.team)).size > 0
    mark.since = busy ? 0 : mark.since || Date.now()
    if (mark.since !== 0 && Date.now() - mark.since >= quietMs) return true
    await Bun.sleep(3_000)
  }
  return false
}
