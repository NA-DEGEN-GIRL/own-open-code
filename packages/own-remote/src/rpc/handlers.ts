export * as Handlers from "./handlers.js"

import path from "node:path"
import type { RpcCallContext, RpcHandlers } from "@opencode/plugin/promise/rpc"
import { Agent } from "../agent.js"
import type { Controller } from "../controller.js"
import { BrowserHub } from "../gateway/browser-hub.js"
import type { Gateway } from "../gateway/gateway.js"
import type { Operations } from "../operations.js"
import { OwnRemote } from "../protocol/rpc-remote.js"
import { Registry } from "../registry.js"
import { RemoteModel } from "../remote/model.js"
import { SshConfig } from "../ssh/config.js"
import { Fsx } from "@own/runtime"

type Definition = OwnRemote.Definition
type MethodName = OwnRemote.MethodName
type Context<N extends MethodName> = RpcCallContext<Definition["methods"][N]>

/**
 * Returns a declared error of the method, never throws (02 §9.4). An error type the method does not declare is
 * reported as `remote_unreachable` when declared, else `internal_error`, so a handler can never produce a 500.
 */
function fail<N extends MethodName>(
  method: N,
  context: Context<N>,
  failed: { readonly error: string; readonly data?: Record<string, unknown> },
) {
  const declared = new Set(Object.keys(OwnRemote.Definition.methods[method].errors ?? {}))
  const type = declared.has(failed.error) ? failed.error : declared.has("remote_unreachable") ? "remote_unreachable" : "internal_error"
  const data =
    type === failed.error ? (failed.data ?? {}) : type === "remote_unreachable" ? { stage: failed.error } : {}
  // SAFETY: `type` is one of the method's declared error names (checked above) and `data` follows its schema.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return (context.error as unknown as (type: string, message: string, data: unknown) => never)(type, failed.error, data)
}

function notSupported<N extends MethodName>(method: N, context: Context<N>, feature: string) {
  return fail(method, context, { error: "not_supported", data: { feature } })
}

export interface Local {
  readonly controller: Controller
  readonly operations: Operations
  readonly ready: Promise<void>
  /** M1 gateway (05 §13.4): `gateway.*`, `devices.*`, `feed.*`. */
  readonly gateway: Gateway
}

/** Handlers of the local service (`mode:"local"`). `agent.*` answer `not_supported` here. */
export function local(slot: Local): RpcHandlers<Definition> {
  const { controller, operations, gateway } = slot
  const host = <N extends MethodName>(method: N, context: Context<N>, hostId: string) => {
    if (controller.record(hostId) && controller.host(hostId)) return undefined
    return fail(method, context, { error: "host_not_found", data: { hostId } })
  }
  const ready = () => slot.ready
  return {
    "hosts.list": async () => {
      await ready()
      return controller.list()
    },
    "hosts.discover": async () => {
      await ready()
      const blocks = await SshConfig.read(path.join(controller.sshDir, "config")).catch(() => [])
      const known = new Set(controller.registry.snapshot().hosts.map((item) => item.alias).filter(Boolean))
      return {
        aliases: SshConfig.aliases(blocks).map((info) => ({
          alias: info.alias,
          known: known.has(info.alias),
          forwards: info.forwards,
          wildcard: false,
          looseHostKey: info.looseHostKey,
          localhostForward: info.localhostForward,
        })),
      }
    },
    "hosts.detail": async (input, context) => {
      await ready()
      const missing = host("hosts.detail", context, input.hostId)
      if (missing) return missing
      const state = controller.host(input.hostId)!
      const record = controller.record(input.hostId)!
      if (state.resolved)
        return {
          destination: state.resolved.destination,
          source: "connect" as const,
          configKeys: [...state.resolved.keys],
          forwards: [...state.resolved.forwards],
        }
      const blocks = await SshConfig.read(path.join(controller.sshDir, "config")).catch(() => [])
      const detail = SshConfig.detail(blocks, record.alias ?? record.target)
      return { destination: detail.destination, source: "file" as const, configKeys: detail.configKeys, forwards: detail.forwards }
    },
    resolve: async (input, context) => {
      await ready()
      const resolved = await controller.resolve(input.hostId)
      if (!resolved) return fail("resolve", context, { error: "host_not_found", data: { hostId: input.hostId } })
      return resolved
    },
    "catalog.get": async (input, context) => {
      await ready()
      const missing = host("catalog.get", context, input.hostId)
      if (missing) return missing
      const text = await Fsx.readText(path.join(controller.remoteDir, input.hostId, "catalog.json")).catch(() => undefined)
      if (text) {
        try {
          const value = JSON.parse(text) as { epoch?: number; fetchedAt?: number; projects?: unknown[]; sessions?: unknown[] }
          if (Array.isArray(value.projects) && Array.isArray(value.sessions))
            return {
              epoch: typeof value.epoch === "number" ? value.epoch : 0,
              fetchedAt: typeof value.fetchedAt === "number" ? value.fetchedAt : null,
              // SAFETY: written by the leader in this shape (04 §12.3); decoded again by the RPC output schema.
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              projects: value.projects as never,
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              sessions: value.sessions as never,
            }
        } catch {
          // fall through to the empty catalog
        }
      }
      return { epoch: 0, fetchedAt: null, projects: [], sessions: [] }
    },
    "portForward.list": async () => ({ forwards: [] }),
    diagnostics: async (input, context) => {
      await ready()
      const missing = host("diagnostics", context, input.hostId)
      if (missing) return missing
      const state = controller.host(input.hostId)!
      const record = controller.record(input.hostId)!
      const inspect = state.inspect
      return {
        stage: state.stage,
        lastError: state.error,
        sshVersion: null,
        sshPath: controller.sshCommand.join(" "),
        agentRunning: null,
        forwardsInConfig: state.resolved ? (state.resolved.forwardKinds.length > 0 ? ("yes" as const) : ("none" as const)) : ("maybe" as const),
        brokerMode: record.broker.mode,
        socketDir: record.remote?.socketDir ?? null,
        clockSkewMs: controller.broker()?.status(input.hostId).clockSkewMs ?? null,
        shellEnv: {
          mode: record.shellEnv,
          pathLogin: inspect?.env.LOGIN.PATH ?? null,
          pathInteractive: inspect?.env.INTERACTIVE.PATH ?? null,
          pathSh: inspect?.env.SHL.PATH ?? null,
        },
        linger: inspect?.linger ?? null,
        killUserProcesses: inspect?.killUserProcesses ?? null,
        tmpNoexec: inspect ? inspect.tmpFlags === "noexec" : null,
        probe: state.probe ?? null,
        stderrTail: state.stderrTail,
      }
    },

    "hosts.add": async (input, context) => {
      await ready()
      const result = await controller.addHost(input)
      if (!result.ok)
        return result.reason === "input"
          ? fail("hosts.add", context, { error: "input_invalid", data: { field: "alias" in input ? "alias" : "target", reason: "target" } })
          : fail("hosts.add", context, { error: "loopback_unavailable", data: { address: result.address } })
      return { host: controller.view(result.record.id)! }
    },
    "hosts.update": async (input, context) => {
      await ready()
      const missing = host("hosts.update", context, input.hostId)
      if (missing) return missing
      const { hostId, ...patch } = input
      if (patch.env) {
        const problem = RemoteModel.validateEnv(patch.env)
        if (problem) return fail("hosts.update", context, { error: "input_invalid", data: { field: "env", reason: problem } })
      }
      if (patch.pathPrepend) {
        const problem = RemoteModel.validatePathPrepend(patch.pathPrepend)
        if (problem !== undefined)
          return fail("hosts.update", context, { error: "input_invalid", data: { field: "pathPrepend", reason: problem } })
      }
      if (patch.installRoot && !patch.installRoot.startsWith("/"))
        return fail("hosts.update", context, { error: "input_invalid", data: { field: "installRoot", reason: "absolute path" } })
      const changes: Partial<Registry.HostRecord> = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.autoConnect !== undefined ? { autoConnect: patch.autoConnect } : {}),
        ...(patch.accounts !== undefined ? { accounts: patch.accounts } : {}),
        ...(patch.leaseSeconds !== undefined ? { leaseSeconds: patch.leaseSeconds } : {}),
        ...(patch.failClosedGraceSeconds !== undefined ? { failClosedGraceSeconds: patch.failClosedGraceSeconds } : {}),
        ...(patch.tokenTtlHours !== undefined ? { tokenTtlHours: patch.tokenTtlHours } : {}),
        ...(patch.localPort !== undefined ? { localPort: patch.localPort } : {}),
        ...(patch.installRoot !== undefined ? { installRoot: patch.installRoot } : {}),
        ...(patch.projectConfig !== undefined ? { projectConfig: patch.projectConfig } : {}),
        ...(patch.shellEnv !== undefined ? { shellEnv: patch.shellEnv } : {}),
        ...(patch.env !== undefined ? { env: patch.env } : {}),
        ...(patch.pathPrepend !== undefined ? { pathPrepend: patch.pathPrepend } : {}),
      }
      const record = await controller.updateHost(hostId, changes)
      return { host: controller.view(hostId)!, pendingSettings: record?.pendingSettings ?? false }
    },
    connect: async (input, context) => {
      await ready()
      const missing = host("connect", context, input.hostId)
      if (missing) return missing
      const state = controller.host(input.hostId)!
      if (state.busy) return fail("connect", context, { error: "host_busy", data: { hostId: input.hostId, opId: state.busy.opId } })
      const stage = await controller.connect(input.hostId, {
        clientId: input.clientId,
        ...(input.hostKeyPrompt ? { hostKeyPrompt: true } : {}),
      })
      return { stage }
    },
    respond: async (input, context) => {
      await ready()
      const missing = host("respond", context, input.hostId)
      if (missing) return missing
      const result = await controller.respond(input.hostId, input.promptId, input.clientId, input.value)
      if (!result.ok) return fail("respond", context, { error: "input_invalid", data: { field: "value", reason: result.reason } })
      return {}
    },
    heartbeat: async (input) => {
      controller.heartbeat(input.clientId, input.replay === true)
      return {}
    },
    cancel: async (input, context) => {
      await ready()
      const missing = host("cancel", context, input.hostId)
      if (missing) return missing
      return { stage: await controller.cancel(input.hostId, input.clientId) }
    },
    disconnect: async (input, context) => {
      await ready()
      const missing = host("disconnect", context, input.hostId)
      if (missing) return missing
      return { stage: await controller.disconnect(input.hostId) }
    },

    "prepare.plan": async (input, context) => {
      await ready()
      const result = await operations.preparePlan(input.hostId)
      return result.ok ? result.output : fail("prepare.plan", context, result)
    },
    "prepare.execute": async (input, context) => {
      await ready()
      const result = await operations.prepareExecute(input.nonce)
      if (!result.ok) return fail("prepare.execute", context, result)
      if (result.reconnect) {
        // Continue the connection that stopped at needs_install (04 §3.2 ②→③), for the same client.
        const owner = controller.host(result.hostId)?.lastOwner
        void controller.connect(result.hostId, owner ? { clientId: owner } : { background: true })
      }
      return result.output
    },
    "update.plan": async (input, context) => {
      await ready()
      const result = await operations.updatePlan(input.hostId)
      return result.ok ? result.output : fail("update.plan", context, result)
    },
    "update.execute": async (input, context) => {
      await ready()
      const result = operations.updateExecute(input.nonce, input.drain)
      return result.ok ? result.output : fail("update.execute", context, result)
    },
    "drain.plan": async (input, context) => {
      await ready()
      const result = await operations.drainPlan(input.hostId)
      return result.ok ? result.output : fail("drain.plan", context, result)
    },
    "drain.execute": async (input, context) => {
      await ready()
      const result = operations.drainExecute(input.nonce, input.mode)
      return result.ok ? result.output : fail("drain.execute", context, result)
    },
    "forget.plan": async (input, context) => {
      await ready()
      const result = await operations.forgetPlan(input.hostId, input.uninstall)
      return result.ok ? result.output : fail("forget.plan", context, result)
    },
    "forget.execute": async (input, context) => {
      await ready()
      const result = await operations.forgetExecute(input.nonce)
      return result.ok ? result.output : fail("forget.execute", context, result)
    },
    "owner.takeover.plan": async (input, context) => {
      await ready()
      const result = await operations.ownerPlan(input.hostId)
      return result.ok ? result.output : fail("owner.takeover.plan", context, result)
    },
    "owner.takeover.execute": async (input, context) => {
      await ready()
      const result = await operations.ownerExecute(input.nonce)
      return result.ok ? result.output : fail("owner.takeover.execute", context, result)
    },
    "legacy.plan": async () => {
      await ready()
      return (await operations.legacyPlan()).output
    },
    "legacy.execute": async (input, context) => {
      await ready()
      const result = await operations.legacyExecute(input.nonce, input.aliases)
      return result.ok ? result.output : fail("legacy.execute", context, result)
    },

    // The git-lfs upload (06 §4.13). Failures without a declared type (unreachable host, missing bundle files, noexec)
    // answer internal_error with the failure's name as the message.
    "hosts.tools.ensure": async (input, context) => {
      await ready()
      const result = await operations.toolsEnsure(input.hostId, input.tool)
      return result.ok ? result.output : fail("hosts.tools.ensure", context, result)
    },

    // Later phases (04 §21): R2 recover and token rotation, R3 sync and port forwards.
    "sync.plan": async (_input, context) => notSupported("sync.plan", context, "sync"),
    "sync.execute": async (_input, context) => notSupported("sync.execute", context, "sync"),
    "tokens.rotate.plan": async (_input, context) => notSupported("tokens.rotate.plan", context, "tokens.rotate"),
    "tokens.rotate.execute": async (_input, context) => notSupported("tokens.rotate.execute", context, "tokens.rotate"),
    "recover.plan": async (_input, context) => notSupported("recover.plan", context, "recover"),
    "recover.execute": async (_input, context) => notSupported("recover.execute", context, "recover"),
    "portForward.open": async (_input, context) => notSupported("portForward.open", context, "portForward"),
    "portForward.close": async (_input, context) => notSupported("portForward.close", context, "portForward"),

    // M1 gateway and devices (05 §13.4–13.6). The gateway refuses all of these from a device (`local`).
    "gateway.status": async () => gateway.status(),
    "gateway.configure.plan": async (input, context) => {
      const result = await gateway.plan(input)
      return result.ok ? result.value : fail("gateway.configure.plan", context, result)
    },
    "gateway.configure.execute": async (input, context) => {
      const result = await gateway.execute(input.nonce)
      return result.ok ? result.value : fail("gateway.configure.execute", context, result)
    },
    "gateway.disable": async () => gateway.disable(),
    "devices.pair.start": async (input, context) => {
      const result = await gateway.pairStart(input)
      if (!result.ok) return fail("devices.pair.start", context, result)
      return { ...result.value, pairingId: result.value.pairingId as OwnRemote.PairingID }
    },
    "devices.pair.approve": async (input, context) => {
      const result = gateway.approve(input.pairingId, input.sas)
      if (!result.ok) return fail("devices.pair.approve", context, result)
      return {
        pairingId: result.value.pairingId as OwnRemote.PairingID,
        deviceId: result.value.deviceId as OwnRemote.DeviceID,
        expiresAt: result.value.expiresAt,
      }
    },
    "devices.pair.cancel": async (input) => {
      gateway.cancel(input.pairingId)
      return {}
    },
    "devices.list": async () => gateway.list(),
    "devices.update": async (input, context) => {
      const result = await gateway.update(input)
      return result.ok ? result.value : fail("devices.update", context, result)
    },
    "devices.revoke": async (input, context) => {
      const result = await gateway.revoke(input.deviceId)
      return result.ok ? result.value : fail("devices.revoke", context, result)
    },
    "devices.revokeAll": async () => gateway.revokeAll(),
    // Bound to the caller: from a device the gateway put its own id in `deviceId`; from the PC it is absent.
    "feed.list": async (input) =>
      gateway.feed.list({
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      }),
    "feed.ack": async (input, context) => {
      if (input.deviceId === undefined) return {}
      const acknowledged = await gateway.feed.ack(input.deviceId, input.upTo)
      return acknowledged ? {} : fail("feed.ack", context, { error: "device_not_found", data: { deviceId: input.deviceId } })
    },
    // The browser pane on a device (05 §8.10). `browser.host.*` and `browser.pane.wanted` are the desktop app's
    // (`local`); the hub lives with the gateway and works whether or not a listener is open.
    "browser.status": async () => ({ desktop: gateway.browser.desktop() }),
    "browser.pane.wanted": async () => {
      const wanted = gateway.browser.wanted().map(BrowserHub.named)
      return {
        sessionIDs: wanted.flatMap((pane) => (pane.serverKey === undefined ? [pane.sessionID] : [])),
        hosts: wanted.flatMap((pane) =>
          pane.serverKey === undefined ? [] : [{ serverKey: pane.serverKey, sessionID: pane.sessionID }],
        ),
      }
    },
    // A long poll (up to 30 s): the hub answers early when something waits, and a newer pull of the same shell ends
    // this one. Nothing on the way here has a deadline (the service's HTTP server keeps a silent request open).
    "browser.host.pull": async (input, context) => gateway.browser.pull(input, context.signal),
    "browser.host.frame": async (input, context) => {
      const result = await gateway.browser.frame(input)
      if (!result.ok)
        return fail("browser.host.frame", context, { error: "input_invalid", data: { field: result.field, reason: result.reason } })
      return { viewers: result.viewers, acked: result.acked }
    },
    "browser.host.state": async (input) => {
      gateway.browser.state(input)
      return {}
    },
    "browser.host.result": async (input) => {
      gateway.browser.result(input)
      return {}
    },
    "push.register": async (_input, context) => notSupported("push.register", context, "push"),
    "push.unregister": async (_input, context) => notSupported("push.unregister", context, "push"),

    "agent.realpath": async (_input, context) => notSupported("agent.realpath", context, "agent"),
    "agent.status": async (_input, context) => notSupported("agent.status", context, "agent"),
    "agent.broker.arm": async (_input, context) => notSupported("agent.broker.arm", context, "agent"),
    "agent.probe": async (_input, context) => notSupported("agent.probe", context, "agent"),
  }
}

/** Handlers of the remote service (`mode:"agent"`), registered with {@link OwnRemote.AgentDefinition}. */
export function agent(context: Agent.Context): RpcHandlers<typeof OwnRemote.AgentDefinition> {
  return {
    "agent.realpath": async (input) => Agent.realpath(input),
    "agent.status": async () => Agent.status(context),
    "agent.broker.arm": async (input) => Agent.arm(context, input),
    "agent.probe": async (input, call) => {
      const result = await Agent.probe(context, input)
      if (!result.ok)
        return (call.error as unknown as (type: string, message: string, data: unknown) => never)(
          "input_invalid",
          "input_invalid",
          { field: "commands", reason: "not allowed" },
        )
      return result.output
    },
  }
}
