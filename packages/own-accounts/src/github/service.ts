export * as GitHubService from "./service.js"

import path from "node:path"
import { Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnGitHub, type OwnError } from "@own/protocol"
import type { Deps } from "../deps.js"
import { McpProbe } from "../mcp/probe.js"
import { Nonces } from "../nonces.js"
import { GitHubApi } from "./api.js"
import { GitHubMcp } from "./mcp.js"
import { GitHubReads } from "./reads.js"
import { GitHubResolve } from "./resolve.js"
import { GitHubStore } from "./store.js"

/**
 * The `github.*` methods of own.accounts (16, GH) on the control Location's instance, and what the tools and git's
 * logins of every instance share: an account's token (renewed when a device login's token expired), the MCP target
 * of an account and the tool list. Every change tells every Location (`github.changed`) and open pages (the
 * `github.changed` event). Logs name accounts by id and login, never a token.
 */

export type Failure = { readonly type: OwnError.Name; readonly message: string; readonly data: object }
export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure }

/** A browser login waits this long at most, whatever GitHub says. */
export const DEVICE_MAX_MS = 15 * 60_000

interface Device {
  readonly web: string
  readonly clientID: string
  readonly deviceCode: string
  readonly site: string
  readonly label?: string
  readonly write: boolean
  readonly expiresAt: number
  intervalMs: number
  nextPollAt: number
  state: OwnGitHub.DeviceState
  account?: OwnGitHub.ID
  message?: string
}

export function create(deps: Deps) {
  const store = GitHubStore.file(deps)
  const log = deps.log.child("github")
  const devices = new Nonces.Scope<Device>(deps.clock, { ttlMs: DEVICE_MAX_MS })
  const fail = (type: OwnError.Name, message: string, data: object = {}): Answer<never> => ({
    ok: false,
    error: { type, message, data },
  })

  function changed() {
    deps.runtime.broadcast.emit("github.changed", {})
    void deps.emitter.global("github.changed", {})
  }

  async function view(input: OwnGitHub.ViewInput = {}): Promise<OwnGitHub.View> {
    const file = await store.read()
    const vault = await deps.runtime.credentials
      .inspectFeatureKey(GitHubStore.vaultID(file.accounts[0]?.id ?? "probe"))
      .then((state) => (state.problem === "vault_unavailable" ? "unavailable" : "ok"))
      .catch(() => "unavailable" as const)
    const inUse = await inUseOf(file, input)
    const catalog = GitHubStore.catalogView(file.catalog)
    return {
      accounts: file.accounts.map(GitHubStore.account),
      ...(file.default === undefined ? {} : { default: file.default }),
      projects: file.projects,
      sessions: file.sessions,
      settings: file.settings,
      ...(catalog ? { catalog } : {}),
      vault,
      ...(inUse ? { inUse } : {}),
    }
  }

  /**
   * The account `input`'s folder and conversation use now. An SSH host's (16 §8): its choices only, the conversation as
   * given (this PC does not know the host's session tree) and no worktree step (this PC cannot read the host's files).
   */
  async function inUseOf(file: GitHubStore.File, input: OwnGitHub.ViewInput) {
    if (input.directory === undefined && input.sessionID === undefined) return undefined
    if (input.host !== undefined) {
      if (input.directory === undefined) return undefined
      const resolved = await GitHubResolve.resolve(file, {
        directory: input.directory,
        host: input.host,
        ...(input.sessionID === undefined ? {} : { root: input.sessionID }),
      })
      return resolved.inUse
    }
    const resolved = await GitHubResolve.resolve(file, {
      directory: input.directory ?? deps.location.directory,
      ...(input.sessionID === undefined ? {} : { root: await rootOf(deps, input.sessionID) }),
    })
    return resolved.inUse
  }

  /** Asks GitHub whose `token` is and stores the account (its token in the vault first, then the file). */
  async function connect(input: {
    readonly token: string
    readonly site: string
    readonly label?: string
    readonly write: boolean
    readonly source: OwnGitHub.Source
    readonly secret?: Omit<GitHubStore.Secret, "token">
  }): Promise<Answer<OwnGitHub.ID>> {
    const urls = GitHubApi.urls(deps, input.site)
    if (!urls) return fail("github_unavailable", "github.com is not asked from this service", { reason: "offline" })
    const asked = await GitHubApi.whoami(urls.api, input.token)
    if (!asked.ok) return failed(asked.failure)
    const file = await store.read()
    const label = input.label ?? uniqueLabel(file, asked.who.login)
    if (taken(file, label)) return fail("github_invalid", "another account has this name", { field: "label" })
    const id = OwnGitHub.ID.create()
    const stored = await GitHubStore.storeSecret(deps, id, { token: input.token, ...input.secret })
    if (!stored) return fail("vault_unavailable", "the vault did not store the token")
    const now = deps.clock.now()
    const entry: GitHubStore.Entry = {
      id,
      label,
      site: input.site,
      login: asked.who.login,
      ...(asked.who.name === undefined ? {} : { name: asked.who.name }),
      source: input.source,
      tokenKind: OwnGitHub.tokenKind(input.token),
      hint: OwnGitHub.hint(input.token),
      write: input.write,
      ...(asked.who.scopes === undefined ? {} : { scopes: asked.who.scopes }),
      ...(expiry(asked.who.expiresAt, input.secret?.expiresAt) === undefined
        ? {}
        : { expiresAt: expiry(asked.who.expiresAt, input.secret?.expiresAt) }),
      addedAt: now,
      checkedAt: now,
    }
    await store.update((current) => ({
      ...current,
      accounts: [...current.accounts, entry],
      // The first account becomes the default, so it works at once everywhere until the user chooses otherwise.
      default: current.default ?? (current.accounts.length === 0 ? id : undefined),
    }))
    log.info("github_account_added", { id, login: entry.login, site: entry.site, source: entry.source })
    changed()
    void refreshCatalog({ prefer: id }).catch((error: unknown) => log.warn("github_catalog_failed", { error }))
    return { ok: true, value: id }
  }

  async function addToken(input: OwnGitHub.AddTokenInput): Promise<Answer<OwnGitHub.View>> {
    const token = input.token.trim()
    const site = input.site ?? OwnGitHub.GITHUB_COM
    if (!secure(site)) return fail("github_invalid", "a GitHub site must be https", { field: "site" })
    const connected = await connect({
      token,
      site,
      ...(input.label === undefined ? {} : { label: input.label.trim() }),
      write: input.write ?? false,
      source: "token",
    })
    if (!connected.ok) return connected
    return { ok: true, value: await view() }
  }

  async function deviceStart(input: OwnGitHub.DeviceStartInput): Promise<Answer<OwnGitHub.DeviceStart>> {
    const file = await store.read()
    const clientID = file.settings.clientID
    if (!clientID)
      return fail("github_invalid", "a browser login needs your own app's client ID", { field: "client_id" })
    const site = input.site ?? OwnGitHub.GITHUB_COM
    if (!secure(site)) return fail("github_invalid", "a GitHub site must be https", { field: "site" })
    const urls = GitHubApi.urls(deps, site)
    if (!urls) return fail("github_unavailable", "github.com is not asked from this service", { reason: "offline" })
    const code = await GitHubApi.deviceCode(urls.web, clientID)
    if (!code.ok)
      return fail("github_unavailable", "GitHub did not start the login", {
        reason: code.failure.reason,
        ...(code.failure.status === undefined ? {} : { status: code.failure.status }),
      })
    const now = deps.clock.now()
    const expiresAt = now + Math.min(code.code.expiresInMs, DEVICE_MAX_MS)
    const issued = devices.issue({
      web: urls.web,
      clientID,
      deviceCode: code.code.deviceCode,
      site,
      ...(input.label === undefined ? {} : { label: input.label.trim() }),
      write: input.write ?? false,
      expiresAt,
      intervalMs: code.code.intervalMs,
      nextPollAt: now + code.code.intervalMs,
      state: "waiting",
    })
    log.info("github_device_started", { site })
    return {
      ok: true,
      value: {
        nonce: issued.nonce,
        userCode: code.code.userCode,
        verificationUri: code.code.verificationUri,
        expiresAt,
        intervalMs: code.code.intervalMs,
      },
    }
  }

  /** Polls GitHub when its interval passed; a token connects the account (once). */
  async function deviceStatus(nonce: string): Promise<Answer<OwnGitHub.DeviceStatus>> {
    const device = devices.peek(nonce)
    if (!device) return fail("nonce_invalid", "this login is unknown or over")
    const now = deps.clock.now()
    if (device.state === "waiting" && now >= device.expiresAt) device.state = "expired"
    if (device.state === "waiting" && now >= device.nextPollAt) {
      device.nextPollAt = now + device.intervalMs
      const polled = await GitHubApi.pollToken(device.web, device.clientID, device.deviceCode, now)
      if (polled.state === "slow_down") {
        device.intervalMs = polled.intervalMs
        device.nextPollAt = now + polled.intervalMs
      }
      if (polled.state === "expired" || polled.state === "denied") device.state = polled.state
      if (polled.state === "failed") {
        device.state = "failed"
        device.message = polled.message
      }
      if (polled.state === "token") {
        const connected = await connect({
          token: polled.token.token,
          site: device.site,
          ...(device.label === undefined ? {} : { label: device.label }),
          write: device.write,
          source: "device",
          secret: {
            ...(polled.token.refresh === undefined ? {} : { refresh: polled.token.refresh }),
            ...(polled.token.expiresAt === undefined ? {} : { expiresAt: polled.token.expiresAt }),
            ...(polled.token.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: polled.token.refreshExpiresAt }),
          },
        })
        if (connected.ok) {
          device.state = "done"
          device.account = connected.value
        }
        if (!connected.ok) {
          device.state = "failed"
          device.message = connected.error.message
        }
      }
    }
    return {
      ok: true,
      value: {
        state: device.state,
        ...(device.account === undefined ? {} : { account: device.account }),
        ...(device.message === undefined ? {} : { message: device.message }),
        ...(device.state === "done" ? { view: await view() } : {}),
      },
    }
  }

  async function deviceCancel(nonce: string): Promise<Answer<OwnGitHub.DeviceStatus>> {
    const device = devices.consume(nonce)
    if (!device) return fail("nonce_invalid", "this login is unknown or over")
    if (device.state === "waiting") device.state = "cancelled"
    return { ok: true, value: { state: device.state } }
  }

  async function update(input: OwnGitHub.UpdateInput): Promise<Answer<OwnGitHub.View>> {
    const file = await store.read()
    const entry = file.accounts.find((item) => item.id === input.id)
    if (!entry) return fail("github_not_found", "no such account", { id: input.id })
    const label = input.label?.trim()
    if (label !== undefined && taken(file, label, entry.id))
      return fail("github_invalid", "another account has this name", { field: "label" })
    const replaced = input.token === undefined ? undefined : await replaceToken(entry, input.token.trim())
    if (replaced && !replaced.ok) return replaced
    await store.update((current) => ({
      ...current,
      accounts: current.accounts.map((item) =>
        item.id !== entry.id
          ? item
          : {
              ...item,
              ...(label === undefined ? {} : { label }),
              ...(input.write === undefined ? {} : { write: input.write }),
              ...(replaced?.ok ? replaced.value : {}),
            },
      ),
    }))
    // Its sessions were opened read-only or with the old token: the next call opens one as it is now. Other accounts'
    // sessions stay open.
    await GitHubMcp.dropAll(GitHubMcp.ofAccount(entry.id))
    log.info("github_account_updated", {
      id: entry.id,
      ...(input.write === undefined ? {} : { write: input.write }),
      token: input.token !== undefined,
    })
    changed()
    return { ok: true, value: await view() }
  }

  /** A new token of the same GitHub user, checked first; the fields it changes. */
  async function replaceToken(entry: GitHubStore.Entry, token: string): Promise<Answer<Partial<GitHubStore.Entry>>> {
    const urls = GitHubApi.urls(deps, entry.site)
    if (!urls) return fail("github_unavailable", "github.com is not asked from this service", { reason: "offline" })
    const asked = await GitHubApi.whoami(urls.api, token)
    if (!asked.ok) return failed(asked.failure)
    if (asked.who.login.toLowerCase() !== entry.login.toLowerCase())
      return fail("github_token_invalid", "the token belongs to another GitHub user", { mismatch: true })
    const previous = await GitHubStore.secret(deps, entry.id)
    if (!(await GitHubStore.storeSecret(deps, entry.id, { token })))
      return fail("vault_unavailable", "the vault did not store the token")
    // The replaced token may still work at GitHub: tool results keep it masked for a while (GH-30).
    if (previous && previous.token !== token)
      await store.update((current) => ({
        ...current,
        retired: GitHubStore.withRetired(current.retired ?? [], previous, deps.clock.now()),
      }))
    return {
      ok: true,
      value: {
        tokenKind: OwnGitHub.tokenKind(token),
        hint: OwnGitHub.hint(token),
        source: "token",
        scopes: asked.who.scopes,
        expiresAt: asked.who.expiresAt,
        checkedAt: deps.clock.now(),
        problem: undefined,
      },
    }
  }

  async function remove(id: OwnGitHub.ID): Promise<Answer<OwnGitHub.View>> {
    const file = await store.read()
    if (!file.accounts.some((item) => item.id === id)) return fail("github_not_found", "no such account", { id })
    const previous = await GitHubStore.secret(deps, id)
    if (!(await GitHubStore.removeSecret(deps, id)))
      return fail("vault_unavailable", "the vault did not remove the token")
    // The removed token may still work at GitHub: tool results keep it masked for a while (GH-30).
    await store.update((current) => ({
      ...GitHubStore.withoutAccount(current, id),
      retired: GitHubStore.withRetired(current.retired ?? [], previous, deps.clock.now()),
    }))
    await GitHubMcp.dropAll(GitHubMcp.ofAccount(id))
    log.info("github_account_removed", { id })
    changed()
    return { ok: true, value: await view() }
  }

  async function bind(input: OwnGitHub.BindInput): Promise<Answer<OwnGitHub.View>> {
    const file = await store.read()
    if (input.account !== null && input.account !== "off" && !file.accounts.some((item) => item.id === input.account))
      return fail("github_invalid", "no such account", { field: "account" })
    const target = input.target
    if (target.type === "default" && input.account === "off")
      return fail("github_invalid", "the default is an account or none", { field: "account" })
    const host = target.type === "default" ? undefined : target.host
    // An SSH host's folders are paths there (16 §8), whatever this PC's platform reads as absolute.
    const absolute = (directory: string) =>
      host === undefined ? path.isAbsolute(directory) : GitHubStore.hostAbsolute(directory)
    if (target.type === "project" && !absolute(target.directory))
      return fail("github_invalid", "a project folder must be absolute", { field: "directory" })
    if (target.type === "session" && target.directory !== undefined && !absolute(target.directory))
      return fail("github_invalid", "a conversation's folder must be absolute", { field: "directory" })
    // A host conversation is named as given: its parent chain is the host's.
    const root = target.type === "session" && host === undefined ? await rootOf(deps, target.sessionID) : undefined
    await store.update((current) => {
      if (target.type === "default")
        return { ...current, default: input.account === null || input.account === "off" ? undefined : input.account }
      if (target.type === "project")
        return {
          ...current,
          projects: GitHubStore.withProject(current.projects, target.directory, input.account, host),
        }
      return {
        ...current,
        sessions: GitHubStore.withSession(
          current.sessions,
          {
            sessionID: root ?? target.sessionID,
            ...(target.directory === undefined ? {} : { directory: target.directory }),
            ...(host === undefined ? {} : { host }),
            at: deps.clock.now(),
          },
          input.account,
        ),
      }
    })
    log.info("github_bound", { target: target.type, account: input.account, ...(host === undefined ? {} : { host }) })
    changed()
    return { ok: true, value: await view() }
  }

  async function settings(input: OwnGitHub.SettingsInput): Promise<Answer<OwnGitHub.View>> {
    if (input.server?.type === "local" && !input.server.command.trim())
      return fail("github_invalid", "a local server needs its program", { field: "server" })
    if (input.server?.type === "remote" && !secure(input.server.url))
      return fail("github_invalid", "the server's address must be https", { field: "server" })
    const clientID = input.clientID === undefined ? undefined : input.clientID?.trim() || null
    if (clientID !== undefined && clientID !== null && !/^[A-Za-z0-9._-]{4,100}$/.test(clientID))
      return fail("github_invalid", "not a client ID", { field: "client_id" })
    const next = await store.update((current) => {
      // The SSH hosts that may write (GH-49): one entry each, the newest list as given.
      const writeHosts = input.writeHosts === undefined ? current.settings.writeHosts : [...new Set(input.writeHosts)]
      const merged: OwnGitHub.Settings = {
        server: input.server ?? current.settings.server,
        toolsets: input.toolsets ?? current.settings.toolsets,
        git: input.git ?? current.settings.git,
        ...(clientID === undefined
          ? current.settings.clientID === undefined
            ? {}
            : { clientID: current.settings.clientID }
          : clientID === null
            ? {}
            : { clientID }),
        ...(writeHosts === undefined || writeHosts.length === 0 ? {} : { writeHosts }),
      }
      return { ...current, settings: merged }
    })
    // Which hosts may write changes no MCP session (the PC checks it at each call).
    if (Object.keys(input).some((key) => key !== "writeHosts")) await GitHubMcp.dropAll()
    log.info("github_settings", {
      server: next.settings.server.type,
      toolsets: next.settings.toolsets,
      git: next.settings.git,
      clientID: next.settings.clientID !== undefined,
      writeHosts: next.settings.writeHosts ?? [],
    })
    changed()
    if (next.catalog?.key !== GitHubStore.catalogKey(next.settings))
      void refreshCatalog({}).catch((error: unknown) => log.warn("github_catalog_failed", { error }))
    return { ok: true, value: await view() }
  }

  /** Who the account's token is now, and GitHub's MCP server's tools read with it. */
  async function test(id: OwnGitHub.ID): Promise<Answer<OwnGitHub.Check>> {
    const file = await store.read()
    const entry = file.accounts.find((item) => item.id === id)
    if (!entry) return fail("github_not_found", "no such account", { id })
    const token = await tokenFor(deps, entry, file.settings)
    if (!token.ok && token.problem === "vault_missing")
      return fail("vault_unavailable", "the vault did not give the token")
    if (!token.ok) {
      const marked = await markChecked(entry.id, undefined, token.problem)
      return {
        ok: true,
        value: {
          at: deps.clock.now(),
          ok: false,
          ...(marked ? { account: GitHubStore.account(marked) } : {}),
          error: problemText(token.problem),
        },
      }
    }
    const urls = GitHubApi.urls(deps, entry.site)
    const asked = urls ? await GitHubApi.whoami(urls.api, token.token) : undefined
    const problem = asked && !asked.ok && asked.failure.type === "github_token_invalid" ? "token_invalid" : undefined
    const updated = await markChecked(entry.id, asked?.ok ? asked.who : undefined, problem)
    if (!asked?.ok)
      return {
        ok: true,
        value: {
          at: deps.clock.now(),
          ok: false,
          ...(updated ? { account: GitHubStore.account(updated) } : {}),
          error: asked ? whoFailure(asked.failure) : "github.com is not asked from this service",
        },
      }
    const catalog = await refreshCatalog({ prefer: entry.id }).catch((error: unknown) => ({
      error: McpProbe.mask(message(error), [token.token]),
    }))
    return {
      ok: true,
      value: {
        at: deps.clock.now(),
        ok: !("error" in catalog),
        ...(updated ? { account: GitHubStore.account(updated) } : {}),
        ...("error" in catalog ? { error: catalog.error } : { catalog: catalog.view }),
      },
    }
  }

  async function markChecked(id: string, who: GitHubApi.Who | undefined, problem: OwnGitHub.Problem | undefined) {
    const next = await store.update((current) => ({
      ...current,
      accounts: current.accounts.map((item) =>
        item.id !== id
          ? item
          : {
              ...item,
              checkedAt: deps.clock.now(),
              ...(who ? { login: who.login, scopes: who.scopes, expiresAt: who.expiresAt ?? item.expiresAt } : {}),
              problem,
            },
      ),
    }))
    changed()
    return next.accounts.find((item) => item.id === id)
  }

  /**
   * Reads GitHub's MCP server's tools with one account (the preferred one, else the default, else the first without a
   * problem) and keeps them in the file, so every Location registers them. Write tools are listed too: whether a
   * conversation may use them is decided per call.
   */
  async function refreshCatalog(input: { readonly prefer?: string }) {
    const file = await store.read()
    const candidates = [
      ...file.accounts.filter((item) => item.id === input.prefer),
      ...file.accounts.filter((item) => item.id === file.default),
      ...file.accounts,
    ].filter((item) => item.problem === undefined)
    const entry = candidates[0]
    if (!entry) throw new Error("no usable GitHub account")
    const target = await targetFor(deps, entry, file.settings, { readOnly: false })
    if (!target.ok) throw new Error(target.message)
    const session = await GitHubMcp.session(target.target)
    const listed = await session.list()
    const tools = listed.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input: tool.input,
      read: GitHubReads.isRead(tool.name, tool.readOnlyHint, session.server),
      ...(tool.title === undefined ? {} : { title: tool.title }),
    }))
    const catalog: GitHubStore.Catalog = {
      at: deps.clock.now(),
      key: GitHubStore.catalogKey(file.settings),
      ...(session.server === undefined ? {} : { server: session.server }),
      tools,
    }
    await store.update((current) => ({ ...current, catalog }))
    log.info("github_catalog", { tools: tools.length, write: tools.filter((tool) => !tool.read).length })
    changed()
    return { view: GitHubStore.catalogView(catalog)! }
  }

  function failed(failure: GitHubApi.Failure): Answer<never> {
    if (failure.type === "github_token_invalid")
      return fail("github_token_invalid", "GitHub refused the token", { status: failure.status })
    return fail("github_unavailable", "GitHub did not answer as expected", {
      reason: failure.reason,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    })
  }

  return {
    view,
    addToken,
    deviceStart,
    deviceStatus,
    deviceCancel,
    update,
    remove,
    bind,
    settings,
    test,
    refreshCatalog,
  }
}

export type Api = ReturnType<typeof create>

// ---------------------------------------------------------------------------------------------------------------
// Shared with the tools and git's logins

export type Token =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly problem: OwnGitHub.Problem }

/**
 * Renewals under way by account, so concurrent calls renew once (a refresh token is spent on use). One map for the
 * whole process: every Location's instance (modules are imported per Location) renews the same vault item.
 */
function renewing() {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<Token>> | undefined>
  const existing = holder[RENEWING]
  if (existing) return existing
  const created = new Map<string, Promise<Token>>()
  holder[RENEWING] = created
  return created
}

const RENEWING = Symbol.for("own-open-code.github-renewing")

/**
 * An account's token: the stored one, or for a device login whose token expired, a renewed one (the refresh token,
 * the user's client ID, no secret). A token GitHub refused or one past its expiry without a refresh answers its
 * problem.
 */
export async function tokenFor(
  deps: Pick<Deps, "runtime" | "endpoints" | "clock" | "log">,
  entry: GitHubStore.Entry,
  settings: OwnGitHub.Settings,
): Promise<Token> {
  const stored = await GitHubStore.secret(deps, entry.id)
  if (!stored) return { ok: false, problem: "vault_missing" }
  const now = deps.clock.now()
  // Renewed a minute early, so a call does not start with a token about to lapse.
  const expired = stored.expiresAt !== undefined && stored.expiresAt - 60_000 <= now
  if (!expired) return { ok: true, token: stored.token }
  if (!stored.refresh || !settings.clientID) return { ok: false, problem: "token_expired" }
  const running = renewing().get(entry.id)
  if (running) return running
  const renewal = renew(deps, entry, settings.clientID, stored.refresh).finally(() => renewing().delete(entry.id))
  renewing().set(entry.id, renewal)
  return renewal
}

async function renew(
  deps: Pick<Deps, "runtime" | "endpoints" | "clock" | "log">,
  entry: GitHubStore.Entry,
  clientID: string,
  refreshToken: string,
): Promise<Token> {
  const urls = GitHubApi.urls(deps, entry.site)
  if (!urls) return { ok: false, problem: "token_expired" }
  const polled = await GitHubApi.refresh(urls.web, clientID, refreshToken, deps.clock.now())
  if (polled.state !== "token") {
    deps.log.child("github").warn("github_renew_failed", { id: entry.id, state: polled.state })
    return { ok: false, problem: "token_expired" }
  }
  const stored = await GitHubStore.storeSecret(deps, entry.id, {
    token: polled.token.token,
    ...(polled.token.refresh === undefined ? {} : { refresh: polled.token.refresh }),
    ...(polled.token.expiresAt === undefined ? {} : { expiresAt: polled.token.expiresAt }),
    ...(polled.token.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: polled.token.refreshExpiresAt }),
  })
  if (!stored) return { ok: false, problem: "vault_missing" }
  deps.log.child("github").info("github_renewed", { id: entry.id })
  // Every instance's masker learns the new token (`register.ts`).
  deps.runtime.broadcast.emit("github.changed", {})
  return { ok: true, token: polled.token.token }
}

/** Where an account's MCP session goes: the hosted server for github.com and `*.ghe.com`, else a local program. */
export async function targetFor(
  deps: Pick<Deps, "runtime" | "endpoints" | "clock" | "log">,
  entry: GitHubStore.Entry,
  settings: OwnGitHub.Settings,
  options: { readonly readOnly: boolean },
): Promise<
  | { readonly ok: true; readonly target: GitHubMcp.Target; readonly token: string }
  | { readonly ok: false; readonly problem?: OwnGitHub.Problem; readonly message: string }
> {
  const token = await tokenFor(deps, entry, settings)
  if (!token.ok) return { ok: false, problem: token.problem, message: problemText(token.problem) }
  const urls = GitHubApi.urls(deps, entry.site)
  if (settings.server.type === "remote") {
    // GitHub's hosted server serves github.com and its data-residency sites only; a test's fake replaces github.com's.
    const hosted =
      new URL(entry.site).origin === OwnGitHub.GITHUB_COM
        ? settings.server.url === OwnGitHub.HOSTED
          ? urls?.hosted
          : settings.server.url
        : urls?.hosted
    if (!hosted)
      return {
        ok: false,
        message:
          "GitHub Enterprise Server 계정은 이 PC의 github-mcp-server로만 쓸 수 있어요 (설정 > GitHub > 도구 서버)",
      }
    return {
      ok: true,
      token: token.token,
      target: {
        account: entry.id,
        server: settings.server,
        url: hosted,
        site: entry.site,
        token: token.token,
        toolsets: settings.toolsets,
        readOnly: options.readOnly,
      },
    }
  }
  return {
    ok: true,
    token: token.token,
    target: {
      account: entry.id,
      server: settings.server,
      site: entry.site,
      token: token.token,
      toolsets: settings.toolsets,
      readOnly: options.readOnly,
    },
  }
}

/** https, or http to this PC only (a test's fake): a token never goes out in the clear (GH-21). */
export function secure(url: string) {
  const parsed = URL.parse(url)
  if (!parsed) return false
  if (parsed.protocol === "https:") return true
  return parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname.toLowerCase())
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export function problemText(problem: OwnGitHub.Problem) {
  if (problem === "vault_missing") return "보관함에서 이 GitHub 계정의 토큰을 읽지 못했어요"
  if (problem === "token_expired")
    return "이 GitHub 계정의 토큰 기한이 지났어요. 설정 > GitHub에서 새 토큰을 넣어 주세요"
  return "GitHub가 이 계정의 토큰을 받지 않아요. 설정 > GitHub에서 새 토큰을 넣어 주세요"
}

/** The root conversation of `sessionID`: the runtime's index, else core's session (a subagent's parent chain). */
export async function rootOf(deps: Pick<Deps, "runtime" | "ctx">, sessionID: string): Promise<string> {
  if (!isSessionID(sessionID)) return sessionID
  const known = deps.runtime.sessions.get(sessionID)?.parentID
  const parentID =
    known ??
    (await deps.ctx.session
      .get({ sessionID })
      .then((session) => session?.parentID ?? undefined)
      .catch(() => undefined))
  if (!parentID || parentID === sessionID) return sessionID
  return rootOf(deps, parentID)
}

function uniqueLabel(file: GitHubStore.File, login: string) {
  const base = login.slice(0, 36)
  if (!taken(file, base)) return base
  const free = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base} ${n}`).find((label) => !taken(file, label))
  return free ?? `${base} ${file.accounts.length + 1}`
}

function taken(file: GitHubStore.File, label: string, except?: string) {
  return file.accounts.some((item) => item.id !== except && item.label.toLowerCase() === label.toLowerCase())
}

function expiry(fromHeader: number | undefined, fromLogin: number | undefined) {
  return fromHeader ?? fromLogin
}

function whoFailure(failure: GitHubApi.Failure) {
  if (failure.type === "github_token_invalid") return `GitHub가 토큰을 받지 않았어요 (${failure.status})`
  if (failure.reason === "offline") return "GitHub에 연결하지 못했어요"
  return `GitHub가 ${failure.status ?? "예상하지 못한"} 답을 줬어요`
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const isSessionID = Schema.is(SessionID)
