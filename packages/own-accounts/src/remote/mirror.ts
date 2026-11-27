export * as RemoteMirror from "./mirror.js"

import fs from "node:fs/promises"
import { Option, Schema } from "effect"
import { Broker, CodexModels, type Account, type Registry } from "@own/protocol"
import { Fsx, type Runtime } from "@own/runtime"
import type { Logger } from "../logger.js"
import { CodexMeta } from "../slots/codex-meta.js"
import type { Client } from "./client.js"

/**
 * The registry mirror of a remote service (04 §9.2): `registry.get` (+ `template.get` for templates it does not hold
 * by hash), written to the remote OWN_HOME's `accounts.json`, `policy.json`, `ratecards.json` (temp → rename) with
 * `mirror: {schemaVersion, from, revisions, fetchedAt, templates}`, then `store.changed` so every Location reloads its
 * providers. The slot list survives a restart without a broker, so models and session pins never vanish.
 * Host-scoped statuses (a linked account `source_stale` on this host, 04 §8.5) are applied on top of the view.
 *
 * T3 (07 §8.1 원격): the view's `presets.json` is written too when its revision changed (`mirror.presetsRevision`),
 * then `store.changed{presets}`; the presets store reads the file only while the stored mirror names a revision, so a
 * view without presets from an older local build leaves each group's `평소대로` only, while one from a current build
 * that could not read its file keeps the presets the host has ({@link kept}). The money state of paid accounts
 * (`presetsBudget`) stays in memory with the last view: a restart without the broker has none, and the presets gate
 * then refuses every paid target until a view arrives.
 *
 * 04 §8.11.4.3: the view's `claude` (the PC's verdict for this host, its Fast consent, the slot's display) is stored in
 * `mirror.claude` and compared like the revisions, so a restarted host keeps it until the next view; the display is
 * written as this file's `claudeSlot`. A change broadcasts `claudeSlot.changed{remote}`, so every Location re-judges its
 * Claude slot and reloads its providers.
 *
 * 10 §6.14: the view's served Codex rows (`codexRows`, by content hash) are fetched with `codexRow.get` when not held
 * and written to this host's `codex-meta.json` as the shared snapshot's `harness` (no model facts: the host's windows
 * stay its own), then `store.changed{codex-meta}`, so the host's codex harness runs new Codex models from the PC's
 * rows. A view without `codexRows` (an older PC) leaves the file alone.
 */

const decodeMeta = Schema.decodeUnknownOption(Broker.MirrorMeta)
const decodeView = Schema.decodeUnknownOption(Broker.MirrorView)
const decodeTemplate = Schema.decodeUnknownOption(Broker.TemplateResult)
const decodeCodexRow = Schema.decodeUnknownOption(Broker.CodexRowResult)

/** The `mirror` field of an `accounts.json`, if it is a mirror of a readable schema. */
export function metaOf(file: unknown): Broker.MirrorMeta | undefined {
  if (typeof file !== "object" || file === null || !("mirror" in file)) return undefined
  const meta = Option.getOrUndefined(decodeMeta(file.mirror))
  return meta && meta.schemaVersion === Broker.MIRROR_SCHEMA_VERSION ? meta : undefined
}

/**
 * Guard of the remote mode (04 §9.1 "미러 스키마 버전"): an `accounts.json` that is not a mirror of this schema version
 * is moved aside before the modules load it, so no slot is registered from it (fail closed until the broker sends a
 * view). Returns what it did.
 */
export async function prepare(file: string): Promise<"none" | "ok" | "moved"> {
  const text = await Fsx.readText(file).catch(() => undefined)
  if (text === undefined) return "none"
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  if (metaOf(value)) return "ok"
  await fs.rename(file, `${file}.not-mirror-${Date.now()}`).catch(() => undefined)
  return "moved"
}

export class Mirror {
  readonly #runtime: Runtime.Handle
  readonly #log: Logger.Logger
  readonly #now: () => number
  readonly #overrides = new Map<string, Account.Status>()
  #last:
    | {
        readonly view: Broker.MirrorView
        readonly from: string
        readonly templates: Registry.File["modelTemplates"]
        /** The presets revision this host keeps ({@link kept}). */
        readonly presetsRevision: number | undefined
      }
    | undefined
  #syncing: Promise<boolean> | undefined
  /** Another sync was asked for while one ran. */
  #again = false

  constructor(input: { readonly runtime: Runtime.Handle; readonly log: Logger.Logger; readonly now: () => number }) {
    this.#runtime = input.runtime
    this.#log = input.log
    this.#now = input.now
  }

  /** `{revision, fetchedAt}` of the stored mirror (`agent.status`, `health`). */
  async meta() {
    const cached = this.#runtime.registry.cached() ?? (await this.#runtime.registry.read().catch(() => undefined))
    return metaOf(cached)
  }

  /**
   * Fetches the view and writes it when it changed. Concurrent calls share one run; a call that arrives while a fetch
   * is under way runs it once more afterwards, so a `mirror.changed` pushed mid-fetch is never lost (the running fetch
   * may have read the view before the change).
   */
  sync(client: Client.BrokerClient, from: string) {
    if (this.#syncing) {
      this.#again = true
      return this.#syncing
    }
    const run = async (): Promise<boolean> => {
      this.#again = false
      const ok = await this.#sync(client, from)
      return this.#again ? run() : ok
    }
    this.#syncing = run().finally(() => {
      this.#syncing = undefined
    })
    return this.#syncing
  }

  /** Host-scoped status (`account.status{scope:"host"}`): `undefined` clears it. Rewrites the stored mirror. */
  async override(accountID: string, status: Account.Status | undefined) {
    if (status === undefined || status === "ready") this.#overrides.delete(accountID)
    else this.#overrides.set(accountID, status)
    await this.#rewrite()
  }

  overridden(accountID: string) {
    return this.#overrides.get(accountID)
  }

  /** `presetsBudget` of the last view this process fetched; `undefined` before one, or from an older local build. */
  presetsBudget() {
    return this.#last?.view.presetsBudget
  }

  /**
   * The PC's Claude verdict for this host (04 §8.11.4.3): the last view's, else the stored mirror's (a restart without
   * the broker, drain mode); `undefined` from an older PC or when the PC has no slot.
   */
  claude(): Broker.ClaudeRemote | undefined {
    if (this.#last) return this.#last.view.claude
    return metaOf(this.#runtime.registry.cached())?.claude
  }

  /** The PC's Claude Agent accounts this host may use (02 §8.10.13): the last view's, else the stored mirror's. */
  claudeAgent(): Broker.ClaudeAgentRemote | undefined {
    if (this.#last) return this.#last.view.claudeAgent
    return metaOf(this.#runtime.registry.cached())?.claudeAgent
  }

  /**
   * 04 §8.14: whether the PC relays this host's local model requests (the last view's, else the stored mirror's);
   * `false` from an older PC.
   */
  localRelay() {
    if (this.#last) return this.#last.view.localRelay === true
    return metaOf(this.#runtime.registry.cached())?.localRelay === true
  }

  async #sync(client: Client.BrokerClient, from: string) {
    const current = await this.meta()
    const reply = await client.request("registry.get", { since: current?.registryRevision ?? null }, 15_000)
    if (!reply.ok) {
      this.#log.warn("mirror_fetch_failed", { error: reply.error })
      return false
    }
    const view = Option.getOrUndefined(decodeView(reply.result))
    if (!view) {
      this.#log.warn("mirror_invalid")
      return false
    }
    const stored = this.#runtime.registry.cached() ?? (await this.#runtime.registry.read().catch(() => undefined))
    const templates: Record<string, Registry.ModelTemplate> = {}
    for (const [id, hash] of Object.entries(view.templates)) {
      const have = current?.templates?.[id] === hash ? stored?.modelTemplates[id as keyof Registry.File["modelTemplates"]] : undefined
      if (have) {
        templates[id] = have
        continue
      }
      const fetched = await client.request("template.get", { id }, 15_000)
      const result = fetched.ok ? Option.getOrUndefined(decodeTemplate(fetched.result)) : undefined
      if (!result?.template) {
        this.#log.warn("mirror_template_failed", { id })
        return false
      }
      templates[id] = result.template
    }
    const codex = await this.#codexRows(client, view, current)
    if (codex === false) return false
    const presetsRevision = kept(view, current)
    if (view.presets === undefined && presetsRevision !== undefined)
      this.#log.warn("mirror_presets_kept", { revision: presetsRevision })
    this.#last = { view, from, templates: templates as Registry.File["modelTemplates"], presetsRevision }
    // A change of the money state alone writes nothing: it lives in `#last`.
    const same =
      current !== undefined &&
      current.registryRevision === view.registryRevision &&
      current.policyRevision === view.policyRevision &&
      current.ratecardsRevision === view.ratecardsRevision &&
      current.presetsRevision === presetsRevision &&
      JSON.stringify(current.templates ?? {}) === JSON.stringify(view.templates) &&
      JSON.stringify(current.claude ?? null) === JSON.stringify(view.claude ?? null) &&
      JSON.stringify(current.claudeAgent ?? null) === JSON.stringify(view.claudeAgent ?? null) &&
      JSON.stringify(current.codexRows ?? null) === JSON.stringify(view.codexRows ?? null) &&
      // A PC that starts relaying local models also starts mirroring `compat`: write its registry again (SLM).
      (current.localRelay ?? false) === (view.localRelay ?? false) &&
      this.#overrides.size === 0
    if (same) return true
    await this.#write({
      policy: current?.policyRevision !== view.policyRevision,
      ratecards: current?.ratecardsRevision !== view.ratecardsRevision,
      presets: current?.presetsRevision !== presetsRevision,
    })
    this.#log.info("mirror_written", {
      revision: view.registryRevision,
      presets: presetsRevision ?? null,
      claude: view.claude?.state ?? null,
    })
    if (JSON.stringify(current?.claude ?? null) !== JSON.stringify(view.claude ?? null))
      this.#runtime.broadcast.emit("claudeSlot.changed", { reason: "remote" })
    return true
  }

  /**
   * The view's served Codex rows (10 §6.14): the held ones by hash from this host's `codex-meta.json`, the others with
   * `codexRow.get`, written back when the set changed. `true` when there was nothing to do or it was written, `false`
   * when a row could not be fetched (the whole sync then fails and runs again on the next `mirror.changed`).
   */
  async #codexRows(client: Client.BrokerClient, view: Broker.MirrorView, current: Broker.MirrorMeta | undefined) {
    if (view.codexRows === undefined) return true
    if (JSON.stringify(current?.codexRows ?? null) === JSON.stringify(view.codexRows)) return true
    const store = CodexMeta.file(this.#runtime.layout)
    const stored = await store.read().catch(() => undefined)
    const held = new Map((stored?.kinds.codex?.harness ?? []).map((row) => [row.slug, row] as const))
    const rows: Array<CodexModels.HarnessRow> = []
    for (const [slug, hash] of Object.entries(view.codexRows)) {
      const have = held.get(slug)
      if (have && current?.codexRows?.[slug] === hash) {
        rows.push(have)
        continue
      }
      const fetched = await client.request("codexRow.get", { slug }, 15_000)
      const result = fetched.ok ? Option.getOrUndefined(decodeCodexRow(fetched.result)) : undefined
      if (!result?.row) {
        this.#log.warn("mirror_codex_row_failed", { slug })
        return false
      }
      rows.push(result.row)
    }
    await store.update((file) => ({
      ...file,
      kinds: {
        ...file.kinds,
        codex: {
          source: "backend",
          fetchedAt: this.#now(),
          rows: CodexModels.ROWS,
          models: file.kinds.codex?.models ?? [],
          harness: rows,
        },
      },
    }))
    this.#runtime.broadcast.emit("store.changed", { store: "codex-meta", origin: "local" })
    this.#log.info("mirror_codex_rows_written", { rows: rows.length })
    return true
  }

  async #rewrite() {
    if (!this.#last) {
      // No view this run yet: apply the overrides to the stored mirror.
      const stored = await this.#runtime.registry.read().catch(() => undefined)
      const meta = metaOf(stored)
      if (!stored || !meta) return
      await this.#runtime.registry.write(this.#apply(stored, stored.accounts))
      this.#runtime.broadcast.emit("store.changed", { store: "accounts", origin: "local" })
      return
    }
    await this.#write({ policy: false, ratecards: false, presets: false })
  }

  async #write(changed: { readonly policy: boolean; readonly ratecards: boolean; readonly presets: boolean }) {
    const last = this.#last
    if (!last) return
    const view = last.view
    const meta: Broker.MirrorMeta = {
      schemaVersion: Broker.MIRROR_SCHEMA_VERSION,
      from: last.from,
      registryRevision: view.registryRevision,
      policyRevision: view.policyRevision,
      ratecardsRevision: view.ratecardsRevision,
      fetchedAt: this.#now(),
      templates: view.templates,
      ...(last.presetsRevision === undefined ? {} : { presetsRevision: last.presetsRevision }),
      ...(view.claude ? { claude: view.claude } : {}),
      ...(view.claudeAgent ? { claudeAgent: view.claudeAgent } : {}),
      ...(view.codexRows ? { codexRows: view.codexRows } : {}),
      ...(view.localRelay ? { localRelay: view.localRelay } : {}),
    }
    const registry: Registry.File = {
      ...last.view.registry,
      modelTemplates: last.templates,
      ...(view.claude ? { claudeSlot: { accountID: "acc_claude_slot", ...view.claude.display } } : {}),
    }
    // `mirror` is not part of `Registry.File`; the store keeps unknown fields (`Preserve`).
    const file = { ...this.#apply(registry, registry.accounts), mirror: meta } as Registry.File
    // Whole-file replacements (temp → rename): unlike `JsonFile.write` they do not read the current file or its seed
    // first, so a missing or unreadable seed (`app/<version>/templates/…`) cannot stop the mirror.
    if (changed.policy) {
      await Fsx.writeAtomic(this.#runtime.policy.file, `${JSON.stringify(last.view.policy, null, 2)}\n`)
      await this.#runtime.policy.read().catch(() => undefined)
      this.#runtime.broadcast.emit("store.changed", { store: "policy", origin: "local" })
    }
    if (changed.ratecards) {
      await Fsx.writeAtomic(this.#runtime.ratecards.file, `${JSON.stringify(last.view.ratecards, null, 2)}\n`)
      await this.#runtime.ratecards.read().catch(() => undefined)
      this.#runtime.broadcast.emit("store.changed", { store: "ratecards", origin: "local" })
    }
    // Before the meta that names its revision: a crash in between leaves the old revision, so the next sync writes the
    // file again.
    if (changed.presets && view.presets) {
      await Fsx.writeAtomic(this.#runtime.presets.file, `${JSON.stringify(view.presets, null, 2)}\n`)
      await this.#runtime.presets.read().catch(() => undefined)
    }
    const written = await this.#runtime.registry.write(file)
    this.#runtime.broadcast.emit("store.changed", { store: "accounts", origin: "local", revision: written.revision })
    // After the meta: the presets store goes by the stored mirror's revision (none = `평소대로` only).
    if (changed.presets) this.#runtime.broadcast.emit("store.changed", { store: "presets", origin: "local" })
  }

  #apply(registry: Registry.File, accounts: ReadonlyArray<Account.Info>): Registry.File {
    if (this.#overrides.size === 0) return registry
    return {
      ...registry,
      accounts: accounts.map((account) => {
        const status = this.#overrides.get(account.id)
        return status && account.status !== "retired" && account.status !== "disabled" ? { ...account, status } : account
      }),
    }
  }
}

/**
 * The presets revision a host keeps after a view (07 §8.1 원격): the view's. A view of a local build that mirrors
 * presets (it sends `presetsBudget`) but carries none could not read this PC's `presets.json` this time: the host keeps
 * the presets it has, so a passing read error never resets a binding. A view with neither comes from an older local
 * build: no presets.
 */
function kept(view: Broker.MirrorView, current: Broker.MirrorMeta | undefined) {
  if (view.presets !== undefined) return view.presetsRevision
  return view.presetsBudget === undefined ? undefined : current?.presetsRevision
}
