import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { Home, Runtime, Vault } from "@own/runtime"
import { BrokerHost } from "./broker/host.js"
import { Build } from "./build.js"
import { Clock } from "./clock.js"
import type { Deps } from "./deps.js"
import { Emitter } from "./emitter.js"
import { Endpoints } from "./endpoints.js"
import { Events } from "./events.js"
import { Guard } from "./health/guard.js"
import { Hooks } from "./hooks.js"
import { Location } from "./location.js"
import { Logger } from "./logger.js"
import { GitHubConnection } from "./github/register.js"
import { GitHubRemote } from "./github/remote.js"
import { ImageTool } from "./image/tool.js"
import { Browse } from "./browse/browse.js"
import { CoreConfig } from "./slots/core-config.js"
import { McpHostService } from "./mcp/host.js"
import { McpHostTool } from "./mcp/host-tool.js"
import { McpServers } from "./mcp/register.js"
import { Modules } from "./modules.js"
import { Options } from "./options.js"
import { RemoteHost } from "./remote/host.js"
import { RemoteMirror } from "./remote/mirror.js"
import { NoVault } from "./remote/novault.js"
import { Register } from "./rpc/register.js"
import { BraveSearch } from "./websearch/brave.js"
import { ChatGPTSearch } from "./websearch/chatgpt.js"
import { DeepSeekSearch } from "./websearch/deepseek.js"
import { KeyedSearch } from "./websearch/keyed.js"
import { MultiSearch } from "./websearch/multi.js"

/**
 * own-accounts (01 §4, §8; 02). One instance per Location; process-wide state lives in the `@own/runtime`
 * singleton. Setup order matters (02 §3.8): guard → runtime → modules start (registry in memory) → transforms and
 * hooks (once, unscoped) → RPC `own.accounts` → event loop → background self-check. Cleanup runs in reverse and
 * releases this instance's runtime reference last.
 *
 * Two modes (04 §9.1): `local` (this PC: vault, and the credential broker SSH hosts reach through their tunnels) and
 * `remote` (inside a remote service: no vault, the registry is a mirror, credentials are broker leases, observations
 * go back to the local ledger).
 */
export default Plugin.define({
  id: Build.PLUGIN_ID,
  setup: async (ctx) => {
    const begin = performance.now()
    const options = Options.decode(ctx.options)
    const buildId = options.buildId ?? Build.BUILD_ID
    const mode = options.mode ?? "local"
    const guard = Guard.check({ appVersion: ctx.app.version, env: process.env, mode })
    if (guard.guard !== "ok") {
      // Fail closed (01 §5.4): no slots and no hooks, so an unmanaged instance has no own models at all. It writes
      // nothing under OWN_HOME either, so its one line goes to stderr only.
      Logger.create({ level: options.logLevel, scope: Build.PLUGIN_ID }).error("guard_failed", {
        guard: guard.guard,
        reason: guard.reason,
      })
      await Register.registerDegraded(ctx, { guard, buildId, mode })
      return
    }

    const layout = Home.layout(Home.resolve({ home: options.home }))
    // 02 §7.2: the service's stderr is read by nobody once it runs, so the lines also go to OWN_HOME\logs.
    const log = Logger.create({
      level: options.logLevel,
      scope: Build.PLUGIN_ID,
      file: path.join(layout.logs, "own-accounts.log"),
    })
    const control = Location.same(ctx.location.directory, layout.control)
    // Remote guard 1 (04 §9.1): only a mirror of this schema version is loaded as the registry; anything else is set
    // aside, so no slot exists until the local broker sent a view.
    if (mode === "remote") await RemoteMirror.prepare(layout.accounts)
    const runtime = await Runtime.acquire({
      buildId,
      home: options.home,
      vault: mode === "remote" ? { transport: NoVault.transport } : vaultOption(options.vault),
      preferLeader: control,
      secretCacheSeconds: options.secretCacheSeconds,
      ratecardsSeed: options.ratecardsSeed,
    })
    const stack = new AsyncDisposableStack()
    stack.defer(() => runtime.release())

    const start = async () => {
      const remote =
        mode === "remote"
          ? await RemoteHost.acquire({ buildId, version: ctx.app.version, runtime, options, log })
          : undefined
      if (remote) stack.defer(() => remote.release())
      const emitter = new Emitter.Publisher({
        isLeader: () => runtime.isLeader(),
        log: log.child("emitter"),
        remote: remote !== undefined,
      })
      stack.defer(() => emitter.unbind())
      const deps: Deps.Deps = {
        ctx,
        runtime: remote ? remote.wrap(runtime) : runtime,
        options,
        endpoints: Endpoints.resolve(options.endpoints),
        log,
        clock: Clock.system,
        emitter,
        places: new Events.Places(),
        configDir: process.env.OPENCODE_CONFIG_DIR || undefined,
        location: { directory: ctx.location.directory, control },
        ...(remote ? { remote: remote.api } : {}),
      }
      // Core's background compaction stays off on this PC unless the user set it (CoreConfig.ensureBackgroundOff,
      // decisions MR18-8); once per service, on the control Location. A host's own-remote config sets it itself.
      if (!remote && control && deps.configDir)
        await CoreConfig.ensureBackgroundOff(deps.configDir).catch((error: unknown) =>
          log.warn("core_config_background_unwritable", { error }),
        )
      const modules = Modules.create(deps)
      await Modules.start(modules, log)
      stack.defer(() => Modules.stop(modules, log))
      // The credential broker (04 §8) on this PC; a remote service instead serves its broker client (arm).
      if (remote) stack.defer(remote.attach(deps, modules))
      else stack.defer(BrokerHost.attach(deps, modules))
      await Hooks.register(deps, modules)
      // The skill switches and scopes (03 §19.6.1, SG): their fold's first registration, after the setup's other skill
      // transform; the module registers it again after each local `plugin.updated`. This PC only.
      await modules.skillset.register()
      // The web search services (02 §9.2): their own folds, after core's config fold that holds the user's choice.
      // Only ChatGPT may become the default; DeepSeek, Brave and the keyed variants of core's keyless services (SK)
      // answer only when chosen; `여러 서비스` (MS) is listed only while chosen and asks the others.
      stack.defer(await ChatGPTSearch.register(deps, modules))
      stack.defer(await DeepSeekSearch.register(deps, modules))
      stack.defer(await BraveSearch.register(deps))
      stack.defer(await KeyedSearch.register(deps))
      stack.defer(await MultiSearch.register(deps, modules))
      // Core's image tool only when the user turned it on (decisions US5), after core's tool fold.
      stack.defer(await ImageTool.register(deps, modules))
      // The MCP servers own added and the list's kept switches (03 §18.14, SM): after core's config fold. On an SSH host
      // the servers installed from the PC (04 §13 "MCP", MH), their values from the PC over the broker, the install
      // tool of `AI에게 설치 맡기기`, and open pages told when the PC changed what it sends.
      if (!remote) stack.defer(await McpServers.register(deps))
      const install = remote ? await McpHostTool.register(deps, remote.api.mcp) : undefined
      if (remote) {
        stack.defer(await McpServers.register(deps, McpHostService.source(remote.api.mcp)))
        if (control) stack.defer(remote.api.mcp.on(() => void emitter.global("mcp.changed", {})))
      }
      if (install) stack.defer(install.stop)
      // The GitHub connection (16, GH): the `github_*` tools, git's logins and the bridge to own-team. On an SSH host the
      // same tools and git through this PC (16 §8): no token there.
      const github = remote
        ? await GitHubRemote.register(deps, remote.api.github)
        : await GitHubConnection.register(deps)
      stack.defer(github.stop)
      // 내 브라우저 사용 (BRW): the `browse` MCP server on this PC while it is on, the agent-wide deny that keeps its tools
      // out until a conversation turns them on, and the approval modes for each call (every service).
      const browse = await Browse.register(deps)
      stack.defer(browse.stop)
      await Register.register(deps, modules)
      stack.defer(
        Events.start(deps, modules, [
          { name: "github", onEvent: github.onEvent },
          { name: "browse", onEvent: browse.onEvent },
          ...(install ? [{ name: "mcp-install", onEvent: install.onEvent }] : []),
        ]),
      )
      void modules.health.check().catch((error: unknown) => log.error("self_check_failed", { error }))
    }
    await start().catch(async (error: unknown) => {
      log.error("setup_failed", { error })
      await stack.disposeAsync()
      throw error
    })
    log.info("ready", {
      buildId,
      mode,
      location: ctx.location.directory,
      control,
      leader: runtime.isLeader(),
      setupMs: Math.round(performance.now() - begin),
    })
    return () => stack.disposeAsync()
  },
})

function vaultOption(option: Options.VaultOption | undefined): Runtime.VaultOption {
  if (option === "memory") return { transport: Vault.memory() }
  return option ?? {}
}
