
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnID } from "@own/protocol"
import { CodexSource, Fsx } from "@own/runtime"
import { promptEvent, type Controller } from "./controller.js"
import { Registry } from "./registry.js"
import { Bundle } from "./remote/bundle.js"
import { RemoteClient } from "./remote/client.js"
import { RemoteModel } from "./remote/model.js"
import { Scripts } from "./remote/scripts.js"
import { SshConfig } from "./ssh/config.js"
import { Failure } from "./ssh/failure.js"
import { minimalEnv, parseTarget, quote, shortArgs, type Target } from "./vendor/ssh/command.js"

/**
 * Two-step remote operations (04 §5.5, §6.4, §6.5, §6.7, §6.8, §19; plan → nonce → execute, 02 §9.2). Plans have no
 * side effects on the remote; executes run one host operation at a time (`host_busy`). Remote progress is journaled
 * in `<OWN_HOME>/ops/<opId>.json` on the remote and `OWN_HOME\remote\<hostId>\ops.jsonl` locally; a broken
 * connection is never answered by replaying a step (04 §6.4 "끊긴 응답은 재생하지 않는다").
 */

export const NONCE_TTL_MS = 2 * 60_000
export const DRAIN_CAP_MS = 30 * 60_000

export type Failed = { readonly ok: false; readonly error: string; readonly data: Record<string, unknown> }

class Nonces<T> {
  readonly #entries = new Map<string, { readonly payload: T; readonly expiresAt: number }>()

  issue(payload: T) {
    const now = Date.now()
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(key)
    const nonce = OwnID.Nonce.create()
    const expiresAt = now + NONCE_TTL_MS
    this.#entries.set(nonce, { payload, expiresAt })
    return { nonce, expiresAt }
  }

  consume(nonce: string) {
    const entry = this.#entries.get(nonce)
    this.#entries.delete(nonce)
    return entry && entry.expiresAt > Date.now() ? entry.payload : undefined
  }
}

interface PreparePlan {
  readonly hostId: string
  readonly bundle: Bundle.Located
}
interface UpdatePlan {
  readonly hostId: string
  readonly from: string | null
  readonly to: string
  readonly staged: boolean
  readonly bundle: Bundle.Located | undefined
}
interface DrainPlan {
  readonly hostId: string
}
interface ForgetPlan {
  readonly hostId: string
  readonly uninstall: boolean
}
interface OwnerPlan {
  readonly hostId: string
}
interface LegacyPlan {
  readonly aliases: ReadonlyArray<{ readonly alias: string; readonly autoConnect: boolean }>
}

export class Operations {
  readonly #controller: Controller
  readonly #prepare = new Nonces<PreparePlan>()
  readonly #update = new Nonces<UpdatePlan>()
  readonly #drain = new Nonces<DrainPlan>()
  readonly #forget = new Nonces<ForgetPlan>()
  readonly #owner = new Nonces<OwnerPlan>()
  readonly #legacy = new Nonces<LegacyPlan>()
  readonly legacyRoot: string

  constructor(controller: Controller) {
    this.#controller = controller
    this.legacyRoot = controller.input.options.legacyRoot ?? CodexSource.DEFAULT_CONTROL_CENTER
  }

  // -------------------------------------------------------------------------------------------------------------
  // helpers

  #target(hostId: string): Target {
    const record = this.#controller.record(hostId)!
    const target = parseTarget(record.target, { profile: path.dirname(this.#controller.sshDir) })
    return { host: target.host, args: ["-o", "StrictHostKeyChecking=yes", ...target.args] }
  }

  /** An askpass bridge whose prompts go to the host's last interactive client (or are refused without one). */
  async #session(hostId: string) {
    const host = this.#controller.host(hostId)!
    const owner = host.lastOwner
    const askpass = await this.#controller.runner.askpass({
      binary: this.#controller.askpassHelper,
      prompt: (prompt) => {
        if (!owner || prompt.kind === "hostKey") {
          void askpass.respond(prompt.id, null)
          return
        }
        const event = promptEvent(hostId, prompt, owner)
        this.#controller.routePrompt(prompt.id, {
          hostId,
          kind: prompt.kind,
          owner,
          respond: (value) => askpass.respond(prompt.id, value),
          event,
        })
        this.#controller.hub.emit({ name: "host.prompt", data: event })
      },
      clear: (id) => this.#controller.unroutePrompt(id),
    })
    return { env: { ...minimalEnv(), ...askpass.env }, askpass, close: () => askpass.close() }
  }

  async #run(
    hostId: string,
    stdin: string | Uint8Array,
    command = "sh -s",
    timeout = this.#controller.input.options.scriptTimeoutMs ?? 120_000,
  ) {
    const target = this.#target(hostId)
    const session = await this.#session(hostId)
    try {
      return await this.#controller.runner.run({
        args: [...shortArgs(target), target.host, this.#controller.remoteCommand(command)],
        env: session.env,
        stdin,
        timeout,
      })
    } finally {
      await session.close().catch(() => {})
    }
  }

  /** inspect for a plan: the cached report of the last connect, else a fresh one. */
  async #inspect(hostId: string): Promise<{ readonly ok: true; readonly inspect: RemoteModel.Inspect } | { readonly ok: false; readonly failure: Failure.Classified }> {
    const host = this.#controller.host(hostId)!
    if (host.inspect) return { ok: true, inspect: host.inspect }
    const session = await this.#session(hostId)
    try {
      const result = await this.#controller.inspect(hostId, this.#target(hostId), session.env)
      return result.ok ? { ok: true, inspect: result.inspect } : result
    } finally {
      await session.close().catch(() => {})
    }
  }

  async #journal(hostId: string, line: Record<string, unknown>) {
    const file = path.join(this.#controller.remoteDir, hostId, "ops.jsonl")
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Bounded (04 §15 "ops 저널 1 MiB 순환"): the file is rotated past 1 MiB.
    const size = (await fs.stat(file).catch(() => undefined))?.size ?? 0
    if (size > 1_048_576) await fs.rename(file, `${file}.1`).catch(() => {})
    await fs.appendFile(file, JSON.stringify({ at: Date.now(), ...line }) + "\n")
  }

  #failure(failure: Failure.Classified): Failed {
    switch (failure.error) {
      case "platform_unsupported":
        return { ok: false, error: "platform_unsupported", data: { os: failure.detail.split("/")[0] ?? "", arch: failure.detail.split("/")[1] ?? "" } }
      case "other_owner":
        return { ok: false, error: "other_owner", data: failure.detail ? { label: failure.detail } : {} }
      case "ops_pending": {
        const [opId = "", kind = ""] = failure.detail.split(",")[0]?.split(":") ?? []
        return { ok: false, error: "ops_pending", data: { opId, kind } }
      }
      case "ssh_missing":
        return { ok: false, error: "ssh_missing", data: { path: failure.detail } }
      default:
        return { ok: false, error: "remote_unreachable", data: { stage: failure.error } }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // prepare (04 §5.5)

  async preparePlan(hostId: string) {
    const host = this.#controller.host(hostId)
    if (!host) return { ok: false, error: "host_not_found", data: { hostId } } as Failed
    if (host.busy) return { ok: false, error: "host_busy", data: { hostId, opId: host.busy.opId } } as Failed
    const inspected = await this.#inspect(hostId)
    if (!inspected.ok) return this.#failure(inspected.failure)
    const inspect = inspected.inspect
    const record = this.#controller.record(hostId)!
    const paths =
      record.remote ??
      RemoteModel.remotePaths(
        inspect,
        record.shellEnv,
        record.installRoot,
        this.#controller.input.options.remoteTest?.root,
      )
    const located = await Bundle.locate(this.#controller.bundlesDir, inspect.target)
    if (!located.ok) return { ok: false, error: "bundle_missing", data: { target: inspect.target, path: located.path } } as Failed
    const needBytes = located.bundle.bytes * 3
    const freeBytes = inspect.freeKb === null ? null : inspect.freeKb * 1024
    if (freeBytes !== null && freeBytes < needBytes) return { ok: false, error: "disk_full", data: { needBytes, freeBytes } } as Failed
    const planned = this.#prepare.issue({ hostId, bundle: located.bundle })
    const version = this.#controller.version
    return {
      ok: true as const,
      output: {
        ...planned,
        platform: { target: inspect.target },
        install: {
          version,
          dir: `${paths.ownHome}/app/${version}`,
          bytes: located.bundle.bytes,
          needBytes,
          freeBytes,
        },
        existing: {
          running: inspect.running?.exeOk ? inspect.running.version : null,
          staged: [...inspect.installed],
          upstreamOpencode: inspect.upstreamOpencode,
        },
        hostIdentity: inspect.identity === "unavailable" ? null : inspect.identity,
        writes: [
          `${paths.ownHome}/…`,
          `${paths.configDir}/opencode.json`,
          `${paths.configDir}/service-own.json`,
          `${paths.upstreamConfigDir}/service-own.json`,
          ...(paths.socketDir.startsWith(`${paths.ownHome}/`) ? [] : [paths.socketDir]),
        ],
        root: false as const,
      },
    }
  }

  async prepareExecute(nonce: string) {
    const plan = this.#prepare.consume(nonce)
    if (!plan) return { ok: false, error: "nonce_invalid", data: {} } as Failed
    const opId = `op_${OwnID.ulid()}`
    if (!this.#controller.begin(plan.hostId, { opId, kind: "install" }))
      return { ok: false, error: "host_busy", data: { hostId: plan.hostId, opId: this.#controller.host(plan.hostId)?.busy?.opId ?? "" } } as Failed
    try {
      const result = await this.#install(plan.hostId, plan.bundle, true, opId)
      if (result.ok) {
        const host = this.#controller.host(plan.hostId)
        if (host?.inspect && !host.inspect.installed.includes(this.#controller.version))
          host.inspect = { ...host.inspect, installed: [...host.inspect.installed, this.#controller.version] }
      }
      return { ok: true as const, output: { ok: result.ok, steps: result.steps }, hostId: plan.hostId, reconnect: result.ok }
    } finally {
      this.#controller.end(plan.hostId)
    }
  }

  async #install(hostId: string, bundle: Bundle.Located, setCurrent: boolean, opId: string) {
    const record = this.#controller.record(hostId)!
    const paths = record.remote!
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = []
    this.#controller.setStage(hostId, { stage: "uploading", error: null, detail: "" })
    this.#controller.progress(hostId, "install", "upload", { opId })
    let data: Uint8Array
    try {
      data = await Bundle.read(bundle)
    } catch (error) {
      steps.push({ step: "read", ok: false, detail: String(error) })
      this.#controller.setStage(hostId, { stage: "failed", error: "install_failed", detail: "bundle hash mismatch" })
      return { ok: false, steps }
    }
    const script = Scripts.install({
      ownHome: paths.ownHome,
      version: this.#controller.version,
      sums: bundle.sums,
      setCurrent,
      socketDir: paths.socketDir.startsWith(`${paths.ownHome}/`) ? "" : paths.socketDir,
    })
    const result = await this.#run(hostId, data, `sh -c ${quote(script)}`, 15 * 60_000)
    if (!result.ok) {
      steps.push({ step: "upload", ok: false, detail: result.failure.message.slice(-300) })
      this.#controller.setStage(hostId, { stage: "failed", error: "install_failed", detail: "upload failed" })
      this.#controller.progress(hostId, "install", "upload", { opId, ok: false, error: "install_failed" })
      return { ok: false, steps }
    }
    const outcome = Scripts.parseResult(result.stdout, "OWN_INSTALL")
    const detail = Scripts.parseReport(result.stdout, "OWN_INSTALL").get("DETAIL")
    const done = Scripts.parseReport(result.stdout, "OWN_INSTALL").get("DONE") === "1"
    const ok = (outcome === "installed" || outcome === "present") && done
    steps.push({ step: "upload", ok: true }, { step: "verify", ok, ...(ok ? {} : { detail: `${outcome}${detail ? `: ${detail}` : ""}` }) })
    await this.#journal(hostId, { opId, kind: "install", version: this.#controller.version, outcome })
    if (!ok) {
      const error =
        outcome === "disk_full" ? "disk_full" : outcome === "noexec" ? "noexec" : outcome === "platform_mismatch" ? "platform_unsupported" : "install_failed"
      this.#controller.setStage(hostId, { stage: "failed", error, detail: detail ?? outcome ?? "" })
      this.#controller.progress(hostId, "install", "verify", { opId, ok: false, error })
      return { ok: false, steps }
    }
    this.#controller.progress(hostId, "install", "done", { opId, ok: true })
    this.#controller.setStage(hostId, { stage: "starting" })
    return { ok: true, steps }
  }

  // -------------------------------------------------------------------------------------------------------------
  // tools (06 §4.13): the release's pinned git-lfs on a host, upload only.

  /**
   * `hosts.tools.ensure`: under the host's operation lock, the tool goes up when the host lacks the release's version
   * ({@link placeTool}).
   */
  async toolsEnsure(hostId: string, tool: Bundle.ToolName) {
    const host = this.#controller.host(hostId)
    if (!host || !this.#controller.record(hostId))
      return { ok: false, error: "host_not_found", data: { hostId } } as Failed
    const opId = `op_${OwnID.ulid()}`
    if (!this.#controller.begin(hostId, { opId, kind: "tools" }))
      return { ok: false, error: "host_busy", data: { hostId, opId: host.busy?.opId ?? "" } } as Failed
    try {
      return await this.#placeTool(hostId, tool, opId, false)
    } finally {
      this.#controller.end(hostId)
    }
  }

  /**
   * After an update (LFS-3): each tool the host already has moves to the release's version, so a host that got
   * git-lfs 3.8.0 from an earlier release runs the pinned 3.8.1 once own is updated (`current` follows, and with it
   * the LFS filter own.team wrote and the service's PATH). A host that never needed the tool gets none, and a failure
   * leaves the old version in place and is only logged: the update itself is done.
   */
  async #refreshTools(hostId: string, opId: string) {
    const tool = "git-lfs" as const
    const placed = await this.#placeTool(hostId, tool, opId, true)
    if (placed.ok || placed.error === "tool_absent" || placed.error === "bundle_missing") return
    this.#controller.log.warn("tool_refresh_failed", { hostId, tool, error: placed.error, data: placed.data })
  }

  /**
   * The release's `tool` on the host, under the operation lock the caller holds: the local files are checked
   * against `remote\manifest.json` before anything reaches the host; then one short session looks on the host and a
   * second one uploads only when that version is not there yet. With `refresh`, a host that has no version of the tool
   * yet gets nothing (`tool_absent`). The host's `pathPrepend` gains `<OWN_HOME>/tools/<tool>/current` once, so the
   * service's shells (pre-push hooks) find the tool after the next restart ("설정 대기", 04 §6.4); own.team's own git
   * runs use the folder directly. `sent` is the number of bytes uploaded.
   */
  async #placeTool(hostId: string, tool: Bundle.ToolName, opId: string, refresh: boolean) {
    const host = this.#controller.host(hostId)!
    const record = this.#controller.record(hostId)!
    // Paths and platform come from the host's last inspect; a host never inspected has no install to add a tool to.
    const target = record.platform?.target
    if (!record.remote || !target)
      return { ok: false, error: "remote_unreachable", data: { stage: host.stage } } as Failed
    const located = await Bundle.locateTool(this.#controller.bundlesDir, tool, target)
    if (!located.ok) return { ok: false, error: "bundle_missing", data: { target, path: located.path } } as Failed
    const files = await Bundle.readTool(located.tool).catch(() => undefined)
    if (!files) return { ok: false, error: "bundle_missing", data: { target, path: located.tool.dir } } as Failed
    if (!files.ok)
      return {
        ok: false,
        error: "tool_hash_mismatch",
        data: { tool, expected: files.expected, actual: files.actual },
      } as Failed
    const params = {
      ownHome: record.remote.ownHome,
      tool,
      version: located.tool.version,
      binary: located.tool.binary,
      sums: files.sums,
    }
    const looked = await this.#tool(hostId, Scripts.tool({ ...params, files: [] }), "")
    if (!looked.ok) return looked
    const before = looked.report.get("CURRENT")
    if (refresh && looked.result === "missing" && before === undefined)
      return { ok: false, error: "tool_absent", data: { tool } } as Failed
    const needBytes = files.payload.length * 2
    const freeKb = Number(looked.report.get("FREE_KB") || Number.NaN)
    const freeBytes = Number.isFinite(freeKb) ? freeKb * 1024 : null
    const upload = looked.result === "missing"
    if (upload && freeBytes !== null && freeBytes < needBytes)
      return { ok: false, error: "disk_full", data: { needBytes, freeBytes } } as Failed
    const done = upload
      ? await this.#tool(hostId, Scripts.tool({ ...params, files: files.files }), files.payload)
      : looked
    if (!done.ok) return done
    await this.#journal(hostId, {
      opId,
      kind: "tools",
      tool,
      version: params.version,
      outcome: done.result,
      ...(refresh ? { refresh: true, from: before ?? null } : {}),
    })
    const state = (["present", "uploaded"] as const).find((value) => value === done.result)
    if (done.result === "disk_full")
      return { ok: false, error: "disk_full", data: { needBytes, freeBytes: freeBytes ?? 0 } } as Failed
    if (!state) {
      this.#controller.log.warn("tool_failed", {
        hostId,
        tool,
        result: done.result,
        detail: done.report.get("DETAIL"),
      })
      return { ok: false, error: done.result === "noexec" ? "noexec" : "install_failed", data: {} } as Failed
    }
    const dir = RemoteModel.toolDir(record.remote.ownHome, tool)
    const prepend = this.#controller.record(hostId)!.pathPrepend
    if (!prepend.includes(dir)) {
      const problem = RemoteModel.validatePathPrepend([...prepend, dir])
      if (problem !== undefined)
        return { ok: false, error: "input_invalid", data: { field: "pathPrepend", reason: problem } } as Failed
      await this.#controller.updateHost(hostId, { pathPrepend: [...prepend, dir] })
    }
    return {
      ok: true as const,
      output: { state, version: params.version },
      sent: upload ? files.payload.length : 0,
    }
  }

  /** One run of the tool script: its result line (`present`, `uploaded`, `missing` or a failure) and report. */
  async #tool(hostId: string, script: string, payload: string | Uint8Array) {
    const result = await this.#run(hostId, payload, `sh -c ${quote(script)}`, 10 * 60_000)
    if (!result.ok)
      return {
        ok: false,
        error: "remote_unreachable",
        data: { stage: Failure.classify(result.failure).error },
      } as Failed
    const report = Scripts.parseReport(result.stdout, "OWN_TOOL")
    const outcome = Scripts.parseResult(result.stdout, "OWN_TOOL") ?? "no_result"
    // `present` and `uploaded` count only with the closing DONE line (a cut connection is not a success).
    const claimed = outcome === "present" || outcome === "uploaded"
    return { ok: true as const, result: claimed && report.get("DONE") !== "1" ? "install_failed" : outcome, report }
  }

  // -------------------------------------------------------------------------------------------------------------
  // update (04 §6.4) and drain (04 §6.5)

  async updatePlan(hostId: string) {
    const host = this.#controller.host(hostId)
    if (!host) return { ok: false, error: "host_not_found", data: { hostId } } as Failed
    if (host.busy) return { ok: false, error: "host_busy", data: { hostId, opId: host.busy.opId } } as Failed
    const inspected = await this.#inspect(hostId)
    if (!inspected.ok) return this.#failure(inspected.failure)
    const inspect = inspected.inspect
    const to = this.#controller.version
    const from = host.remoteRunning ?? (inspect.running?.exeOk ? inspect.running.version : null)
    const staged = inspect.installed.includes(to)
    const located = staged ? undefined : await Bundle.locate(this.#controller.bundlesDir, inspect.target)
    if (located && !located.ok) return { ok: false, error: "bundle_missing", data: { target: inspect.target, path: located.path } } as Failed
    const endpoint = this.#controller.endpoint(hostId)
    const active = endpoint ? await RemoteClient.activeSessions(endpoint) : from === null ? [] : null
    const planned = this.#update.issue({ hostId, from, to, staged, bundle: located?.ok ? located.bundle : undefined })
    const bytes = located?.ok ? located.bundle.bytes : 0
    return {
      ok: true as const,
      output: {
        ...planned,
        from,
        to,
        staged,
        activeSessions: active,
        backup: { bytes: null },
        needBytes: bytes * 3,
        freeBytes: inspect.freeKb === null ? null : inspect.freeKb * 1024,
      },
    }
  }

  /** Starts the update in the background and returns its opId; progress arrives as `host.progress`. */
  updateExecute(nonce: string, drain: "wait" | "now") {
    const plan = this.#update.consume(nonce)
    if (!plan) return { ok: false, error: "nonce_invalid", data: {} } as Failed
    const opId = `op_${OwnID.ulid()}`
    if (!this.#controller.begin(plan.hostId, { opId, kind: "update" }))
      return { ok: false, error: "host_busy", data: { hostId: plan.hostId, opId: this.#controller.host(plan.hostId)?.busy?.opId ?? "" } } as Failed
    const done = this.#runUpdate(plan, opId, drain)
      .catch((error: unknown) => {
        this.#controller.log.error("update_crashed", { hostId: plan.hostId, opId, error })
        this.#controller.progress(plan.hostId, "update", "failed", { opId, ok: false, error: "internal" })
      })
      .finally(() => this.#controller.end(plan.hostId))
    this.#running.set(opId, done)
    void done.finally(() => this.#running.delete(opId))
    return { ok: true as const, output: { opId } }
  }

  readonly #running = new Map<string, Promise<void>>()

  /** Waits for a background operation (tests). */
  async wait(opId: string) {
    await this.#running.get(opId)
  }

  async #waitDrained(hostId: string, opId: string, op: "update" | "drain", mode: "wait" | "now") {
    if (mode === "now") return true
    this.#controller.setStage(hostId, { stage: "draining" })
    const deadline = Date.now() + (this.#controller.input.options.drainCapMs ?? DRAIN_CAP_MS)
    while (Date.now() < deadline) {
      const endpoint = this.#controller.endpoint(hostId)
      const active = endpoint ? await RemoteClient.activeSessions(endpoint) : null
      if (active !== null && active.length === 0) return true
      if (!endpoint) return true
      this.#controller.progress(hostId, op, "draining", { opId })
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    return false
  }

  async #ops(hostId: string, input: Omit<Scripts.OpsParams, "ownHome" | "stateDir" | "dataDir" | "configDir" | "upstreamConfigDir">) {
    const paths = this.#controller.record(hostId)!.remote!
    const result = await this.#run(
      hostId,
      Scripts.ops({
        ...input,
        ownHome: paths.ownHome,
        stateDir: paths.stateDir,
        dataDir: paths.dataDir,
        configDir: paths.configDir,
        upstreamConfigDir: paths.upstreamConfigDir,
      }),
    )
    if (!result.ok) return { ok: false as const, steps: new Map<string, string>(), report: new Map<string, string>() }
    const steps = new Map<string, string>()
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^OWN_OPS_STEP=([a-z]+):([a-z]+)$/.exec(line)
      if (match) steps.set(match[1]!, match[2]!)
    }
    return {
      ok: Scripts.parseResult(result.stdout, "OWN_OPS") === "done" || [...steps.values()].every((value) => value === "ok"),
      steps,
      report: Scripts.parseReport(result.stdout, "OWN_OPS"),
    }
  }

  async #runUpdate(plan: UpdatePlan, opId: string, drain: "wait" | "now") {
    const { hostId } = plan
    const journal = JSON.stringify({ opId, kind: "update", from: plan.from, to: plan.to, state: "running", startedAt: Date.now() })
    await this.#journal(hostId, { opId, kind: "update", from: plan.from, to: plan.to, step: "start" })
    this.#controller.setStage(hostId, { stage: "updating", error: null, detail: "" })
    // 1. stage (upload only; the running service is untouched, 04 §5.7)
    if (!plan.staged && plan.bundle) {
      this.#controller.progress(hostId, "update", "stage", { opId })
      const installed = await this.#install(hostId, plan.bundle, false, opId)
      if (!installed.ok) return this.#abandon(hostId, opId, "stage")
    }
    // 2. drain (04 §6.4 step 3)
    const drained = await this.#waitDrained(hostId, opId, "update", drain)
    if (!drained) return this.#abandon(hostId, opId, "drain_timeout")
    // 3. journal, stop, backup, switch (one session). The tunnel closes first so the keep part ends.
    await this.#controller.closeTunnel(hostId)
    this.#controller.setStage(hostId, { stage: "updating" })
    this.#controller.progress(hostId, "update", "stop", { opId })
    const switched = await this.#ops(hostId, {
      opId,
      kind: "update",
      ...(plan.from ? { from: plan.from } : {}),
      to: plan.to,
      journal,
      steps: ["journal", "stop", "backup", "switch"],
    })
    await this.#journal(hostId, { opId, step: "switch", result: Object.fromEntries(switched.steps) })
    if (!switched.ok) {
      // Stop or switch failed: put `current` back, mark the journal, start the old version again (04 §6.4 step 8).
      await this.#ops(hostId, { opId, kind: "update", ...(plan.from ? { from: plan.from } : {}), to: plan.to, journal, steps: ["rollback"] })
      this.#controller.progress(hostId, "update", "rollback", { opId, ok: false, error: "switch" })
      return this.#reconnect(hostId)
    }
    // 4. new tunnel + ensure starts the new version (its ensure carries the opId).
    this.#controller.progress(hostId, "update", "start", { opId })
    await this.#controller.connect(hostId, { opId, ...(this.#controller.host(hostId)?.lastOwner ? { clientId: this.#controller.host(hostId)!.lastOwner! } : { background: true }) })
    await this.#controller.settled(hostId)
    const host = this.#controller.host(hostId)!
    if (host.stage !== "ready" || host.remoteRunning !== plan.to) {
      await this.#controller.closeTunnel(hostId)
      await this.#ops(hostId, { opId, kind: "update", ...(plan.from ? { from: plan.from } : {}), to: plan.to, journal, steps: ["stop", "rollback"] })
      this.#controller.progress(hostId, "update", "rollback", { opId, ok: false, error: "start" })
      await this.#journal(hostId, { opId, step: "rollback" })
      return this.#reconnect(hostId)
    }
    // 5. done + GC (keep current and the previous version, 04 §6.4 step 9).
    await this.#ops(hostId, { opId, kind: "update", ...(plan.from ? { from: plan.from } : {}), to: plan.to, journal, steps: ["done", "gc"] })
    await this.#journal(hostId, { opId, step: "done" })
    // 6. a tool the host already has follows the release's pin (LFS-3).
    await this.#refreshTools(hostId, opId)
    this.#controller.progress(hostId, "update", "done", { opId, ok: true })
  }

  async #abandon(hostId: string, opId: string, step: string) {
    await this.#journal(hostId, { opId, step: "abandoned", reason: step })
    this.#controller.progress(hostId, "update", step, { opId, ok: false, error: step })
    const host = this.#controller.host(hostId)
    if (host?.live) this.#controller.setStage(hostId, { stage: "incompatible", paused: true, error: "version_skew" })
  }

  async #reconnect(hostId: string) {
    const owner = this.#controller.host(hostId)?.lastOwner
    await this.#controller.connect(hostId, owner ? { clientId: owner } : { background: true })
    await this.#controller.settled(hostId)
  }

  async drainPlan(hostId: string) {
    const host = this.#controller.host(hostId)
    if (!host) return { ok: false, error: "host_not_found", data: { hostId } } as Failed
    if (host.busy) return { ok: false, error: "host_busy", data: { hostId, opId: host.busy.opId } } as Failed
    if (!this.#controller.record(hostId)?.remote) return { ok: false, error: "remote_unreachable", data: { stage: host.stage } } as Failed
    const endpoint = this.#controller.endpoint(hostId)
    const active = endpoint ? await RemoteClient.activeSessions(endpoint) : null
    const planned = this.#drain.issue({ hostId })
    return { ok: true as const, output: { ...planned, activeSessions: active } }
  }

  drainExecute(nonce: string, mode: "wait" | "now") {
    const plan = this.#drain.consume(nonce)
    if (!plan) return { ok: false, error: "nonce_invalid", data: {} } as Failed
    const opId = `op_${OwnID.ulid()}`
    if (!this.#controller.begin(plan.hostId, { opId, kind: "drain" }))
      return { ok: false, error: "host_busy", data: { hostId: plan.hostId, opId: this.#controller.host(plan.hostId)?.busy?.opId ?? "" } } as Failed
    const run = async () => {
      const drained = await this.#waitDrained(plan.hostId, opId, "drain", mode)
      if (!drained) {
        this.#controller.progress(plan.hostId, "drain", "timeout", { opId, ok: false, error: "drain_timeout" })
        return
      }
      await this.#controller.closeTunnel(plan.hostId)
      const stopped = await this.#ops(plan.hostId, { opId, kind: "drain", steps: ["stop"] })
      await this.#journal(plan.hostId, { opId, kind: "drain", result: Object.fromEntries(stopped.steps) })
      this.#controller.setStage(plan.hostId, { stage: "disconnected", paused: true, error: null, detail: "" })
      this.#controller.progress(plan.hostId, "drain", "stop", { opId, ok: stopped.ok })
    }
    const done = run()
      .catch((error: unknown) => this.#controller.log.error("drain_crashed", { hostId: plan.hostId, error }))
      .finally(() => this.#controller.end(plan.hostId))
    this.#running.set(opId, done)
    void done.finally(() => this.#running.delete(opId))
    return { ok: true as const, output: { opId } }
  }

  // -------------------------------------------------------------------------------------------------------------
  // forget (04 §6.7)

  async forgetPlan(hostId: string, uninstall: boolean) {
    const host = this.#controller.host(hostId)
    const record = this.#controller.record(hostId)
    if (!host || !record) return { ok: false, error: "host_not_found", data: { hostId } } as Failed
    if (host.busy) return { ok: false, error: "host_busy", data: { hostId, opId: host.busy.opId } } as Failed
    const endpoint = this.#controller.endpoint(hostId)
    const active = uninstall && endpoint ? await RemoteClient.activeSessions(endpoint) : uninstall ? null : []
    const leases = await Fsx.readText(path.join(this.#controller.remoteDir, hostId, "leases.json")).catch(() => undefined)
    const leased = leases ? Object.keys(safeObject(leases)) : []
    const paths = record.remote
    const planned = this.#forget.issue({ hostId, uninstall })
    return {
      ok: true as const,
      output: {
        ...planned,
        activeSessions: active,
        removes:
          uninstall && paths
            ? [
                `${paths.ownHome}/app`,
                `${paths.ownHome}/tools`,
                `${paths.ownHome}/run`,
                `${paths.ownHome}/tmp`,
                `${paths.ownHome}/spool`,
                `${paths.ownHome}/accounts.json`,
                `${paths.configDir}/opencode.json`,
              ]
            : [],
        keeps: paths ? [`${paths.dataDir}/opencode-own.db`, `${paths.ownHome}/backup/`] : ["~/.local/share/opencode/opencode-own.db", "backup/"],
        leasedAccounts: leased,
      },
    }
  }

  async forgetExecute(nonce: string) {
    const plan = this.#forget.consume(nonce)
    if (!plan) return { ok: false, error: "nonce_invalid", data: {} } as Failed
    if (plan.uninstall && this.#controller.record(plan.hostId)?.remote) {
      const endpoint = this.#controller.endpoint(plan.hostId)
      const active = endpoint ? await RemoteClient.activeSessions(endpoint) : []
      if (active && active.length > 0) return { ok: false, error: "session_busy", data: { sessionIDs: active } } as Failed
      await this.#controller.closeTunnel(plan.hostId)
      const record = this.#controller.record(plan.hostId)!
      await this.#ops(plan.hostId, {
        opId: `op_${OwnID.ulid()}`,
        kind: "forget",
        steps: ["stop", "uninstall"],
        ...(record.remote!.socketDir.startsWith(`${record.remote!.ownHome}/`) ? {} : { socketDir: record.remote!.socketDir }),
      })
    }
    await this.#controller.removeHost(plan.hostId)
    return { ok: true as const, output: { ok: true } }
  }

  // -------------------------------------------------------------------------------------------------------------
  // owner takeover (04 §6.8)

  async ownerPlan(hostId: string) {
    const host = this.#controller.host(hostId)
    if (!host) return { ok: false, error: "host_not_found", data: { hostId } } as Failed
    const label = host.inspect?.ownerLabel ?? null
    const planned = this.#owner.issue({ hostId })
    return { ok: true as const, output: { ...planned, previous: label ? { label } : null } }
  }

  async ownerExecute(nonce: string) {
    const plan = this.#owner.consume(nonce)
    if (!plan) return { ok: false, error: "nonce_invalid", data: {} } as Failed
    const record = this.#controller.record(plan.hostId)
    const home = record?.remote?.ownHome ?? record?.installRoot
    if (!record || !home) return { ok: true as const, output: { ok: false } }
    const data = this.#controller.registry.snapshot()
    const owner = JSON.stringify({ installId: data.installId, hostId: plan.hostId, label: os.hostname() })
    const result = await this.#run(plan.hostId, Scripts.writeOwner(home, owner))
    const ok = result.ok && Scripts.parseResult(result.stdout, "OWN_OWNER") === "ok"
    if (ok) {
      const host = this.#controller.host(plan.hostId)
      if (host?.inspect) host.inspect = { ...host.inspect, owner: data.installId }
      this.#controller.setStage(plan.hostId, { stage: "disconnected", paused: true, error: null, detail: "" })
    }
    return { ok: true as const, output: { ok } }
  }

  // -------------------------------------------------------------------------------------------------------------
  // legacy (04 §19): aliases only, read only.

  async legacyPlan() {
    const profiles = path.join(this.legacyRoot, "profiles")
    const entries = await fs.readdir(profiles).catch(() => [] as string[])
    const bound = new Map<string, number>()
    const autoPrepare = new Set<string>()
    const deferred = new Set<string>()
    for (const entry of entries) {
      const text = await Fsx.readText(path.join(profiles, entry, "ssh-bindings.json")).catch(() => undefined)
      if (!text) continue
      const value = safeObject(text)
      const bindings = Array.isArray(value.bindings) ? value.bindings : []
      for (const binding of bindings) {
        const alias = typeof binding === "object" && binding && "alias" in binding ? String(binding.alias) : ""
        if (alias) bound.set(alias, (bound.get(alias) ?? 0) + 1)
      }
      for (const alias of stringList(value.auto_prepare_aliases)) autoPrepare.add(alias)
      const pending = new Set(stringList(value.pending_policy_hosts))
      for (const alias of stringList(value.deferred_policy_hosts)) if (pending.has(alias)) deferred.add(alias)
    }
    const blocks = await SshConfig.read(path.join(this.#controller.sshDir, "config")).catch(() => [])
    const aliases = SshConfig.aliases(blocks)
    const known = new Set(this.#controller.registry.snapshot().hosts.map((host) => host.alias).filter(Boolean))
    const candidates = new Set([...bound.keys(), ...autoPrepare])
    // Every config alias is listed (04 §19.1: il_01 "목록에만"); only bound ones are selected by default.
    const hosts = [...aliases]
      .sort((a, b) => Number(candidates.has(b.alias)) - Number(candidates.has(a.alias)))
      .map((info) => {
        const profiles_ = bound.get(info.alias) ?? 0
        // Two aliases on one Host line are one machine; keep the one the old app used (04 §19.1 dev-host).
        const duplicate = info.siblings.some((sibling) => (bound.get(sibling) ?? 0) > 0) && profiles_ === 0
        const exclude = known.has(info.alias)
          ? ("already_added" as const)
          : info.forwards === "yes"
            ? ("forward_conflict" as const)
            : duplicate
              ? ("duplicate_host_line" as const)
              : null
        return {
          alias: info.alias,
          selected: exclude === null && profiles_ > 0,
          autoConnect: profiles_ > 0,
          profiles: profiles_,
          deferredPolicy: deferred.has(info.alias),
          remoteFolders: [] as string[],
          exclude,
        }
      })
    const planned = this.#legacy.issue({
      aliases: hosts.filter((host) => host.exclude === null).map((host) => ({ alias: host.alias, autoConnect: host.autoConnect })),
    })
    return { ok: true as const, output: { ...planned, hosts, source: entries.length > 0 ? this.legacyRoot : null } }
  }

  async legacyExecute(nonce: string, aliases: ReadonlyArray<string>) {
    const plan = this.#legacy.consume(nonce)
    if (!plan) return { ok: false, error: "nonce_invalid", data: {} } as Failed
    const added: Registry.HostRecord[] = []
    for (const alias of aliases) {
      const entry = plan.aliases.find((item) => item.alias === alias)
      if (!entry) continue
      const result = await this.#controller.addHost({ alias })
      if (!result.ok) continue
      await this.#controller.updateHost(result.record.id, { autoConnect: entry.autoConnect })
      added.push(this.#controller.record(result.record.id)!)
    }
    return { ok: true as const, output: { added: added.map((record) => this.#controller.view(record.id)!) } }
  }
}

function safeObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
