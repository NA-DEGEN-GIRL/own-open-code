export * as Client from "./client.js"

import { createHmac, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { Broker } from "@own/protocol"
import type { Contract } from "../broker/contract.js"
import { Wire } from "../broker/wire.js"
import type { Logger } from "../logger.js"
import type { Dial } from "./dial.js"

/**
 * The remote broker client (04 §8.3): what `agent.broker.arm` hands the epoch key to. It keeps the key only inside a
 * closure (no property, file, env or log), accepts an arm only for a higher epoch or the same epoch with the same key
 * (a re-arm after a service restart), and keeps one authenticated stream to the local broker, reconnecting while
 * armed. Requests are `req`/`res` frames with numeric ids; pushes go to `onPush`.
 *
 * 04 §8.11.4.2: an arm may also name the PC's Claude egress relay (`egress`). The same closure then counts the
 * per-request proofs (`x-own-egress: v1.<epoch>.<n>.<mac>`, D3): `n` starts at 1 with each arm, so the PC, which starts
 * its replay window over on every `setKey`, accepts it; the key still never leaves the closure.
 *
 * 16 §8 (GH-37): the git relay's proofs (`x-own-github`) count on the same counter, so the PC's one replay window
 * covers both.
 */

export type State = Contract.RemoteStatus["state"]

export interface Options {
  readonly version: string
  readonly buildId: string
  readonly streamId: () => string
  readonly dial: Dial.Dial
  readonly log: Logger.Logger
  readonly onReady: (ready: Broker.Ready) => void
  readonly onPush: (push: Broker.Push) => void
  readonly onState: (state: State) => void
}

export type Reply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string }

/** Backoff between connection attempts while armed. */
export const RETRY_MS: ReadonlyArray<number> = [250, 500, 1_000, 2_000, 5_000]
export const HANDSHAKE_TIMEOUT_MS = 10_000

const decodeChallenge = Schema.decodeUnknownOption(Broker.Challenge)
const decodeReady = Schema.decodeUnknownOption(Broker.Ready)
const decodeReject = Schema.decodeUnknownOption(Broker.Reject)
const decodeResponse = Schema.decodeUnknownOption(Broker.Response)
const decodePush = Schema.decodeUnknownOption(Broker.Push)

/** One arm: the key lives only in this closure. `stop` zeroes it. */
interface Armed {
  readonly hostId: string
  readonly epoch: number
  readonly endpoint: Contract.Endpoint
  readonly egress: Contract.Endpoint | undefined
  readonly proto: number
  same(key: Uint8Array): boolean
  mac(side: "L" | "R", input: Wire.MacInput): string
  /** The next egress proof header value (counter + 1) for a request of the Claude account `accountID` (v2). */
  proof(accountID: string): string
  /** The next git relay proof (counter + 1) over a request's method, path and query, and place header (16 §8). */
  githubProof(input: { readonly method: string; readonly path: string; readonly place: string }): string
  /** The next local model relay proof (counter + 1) over the account, method, path and query (04 §8.14). */
  localProof(input: { readonly accountID: string; readonly method: string; readonly path: string }): string
  stop(): void
  stopped(): boolean
}

function arming(input: Contract.ArmInput): Armed {
  const key = new Uint8Array(input.key)
  let stopped = false
  let counter = 0
  return {
    hostId: input.hostId,
    epoch: input.epoch,
    endpoint: input.endpoint,
    egress: input.egress,
    proto: input.proto,
    same: (other) => other.length === key.length && timingSafeEqual(Buffer.from(key), Buffer.from(other)),
    mac: (side, macInput) => Wire.mac(key, side, macInput),
    proof: (accountID) => {
      counter++
      const mac = createHmac("sha256", key)
        .update(Broker.egressMacInput({ hostId: input.hostId, epoch: input.epoch, n: counter, accountID }))
        .digest("hex")
      return Broker.egressHeader({ epoch: input.epoch, n: counter, accountID, mac })
    },
    githubProof: (request) => {
      counter++
      const mac = createHmac("sha256", key)
        .update(Broker.githubMacInput({ hostId: input.hostId, epoch: input.epoch, n: counter, ...request }))
        .digest("hex")
      return Broker.githubHeader({ epoch: input.epoch, n: counter, mac })
    },
    localProof: (request) => {
      counter++
      const mac = createHmac("sha256", key)
        .update(Broker.localMacInput({ hostId: input.hostId, epoch: input.epoch, n: counter, ...request }))
        .digest("hex")
      return Broker.localHeader({ epoch: input.epoch, n: counter, accountID: request.accountID, mac })
    },
    stop: () => {
      stopped = true
      key.fill(0)
    },
    stopped: () => stopped,
  }
}

export class BrokerClient {
  readonly #options: Options
  #armed: Armed | undefined
  #state: State = "unarmed"
  #channel: Wire.Channel | undefined
  #ready: Broker.Ready | undefined
  readonly #pending = new Map<number, (reply: Reply) => void>()
  readonly #waiters = new Set<() => void>()
  #next = 1
  #kick: (() => void) | undefined
  #closed = false
  lastSeenAt: number | null = null

  constructor(options: Options) {
    this.#options = options
  }

  get state() {
    return this.#state
  }

  get epoch() {
    return this.#armed?.epoch ?? null
  }

  get hostId() {
    return this.#armed?.hostId
  }

  /** The PC's Claude egress relay as the current arm names it (04 §8.11.4.2); none before an arm or from an older PC. */
  get egress() {
    const armed = this.#armed
    return armed && !armed.stopped() ? armed.egress : undefined
  }

  /** The next `x-own-egress` proof of the current arm, or none without an egress endpoint. */
  egressProof(accountID: string) {
    const armed = this.#armed
    return armed && !armed.stopped() && armed.egress ? armed.proof(accountID) : undefined
  }

  /**
   * The next `x-own-github` proof of the current arm for a git request (16 §8), or none without an egress endpoint or
   * before a normal-mode session (the PC's git relay is this build's).
   */
  githubProof(input: { readonly method: string; readonly path: string; readonly place: string }) {
    const armed = this.#armed
    if (!armed || armed.stopped() || !armed.egress || this.#state !== "connected") return undefined
    return armed.githubProof(input)
  }

  /**
   * The next `x-own-local` proof of the current arm for a local model request (04 §8.14), or none without an egress
   * endpoint. A drain-mode session counts too: the PC's mirrored `localRelay` already says it relays them.
   */
  localProof(input: { readonly accountID: string; readonly method: string; readonly path: string }) {
    const armed = this.#armed
    return armed && !armed.stopped() && armed.egress ? armed.localProof(input) : undefined
  }

  /** The last `ready` of the current connection (mode, settings, `from`). */
  get ready() {
    return this.#channel ? this.#ready : undefined
  }

  connected() {
    return this.#channel !== undefined && (this.#state === "connected" || this.#state === "drain")
  }

  /** `agent.broker.arm` (04 §8.3). The caller zeroes its own copy of the key afterwards. */
  arm(input: Contract.ArmInput): Contract.ArmResult {
    if (this.#closed) return { accepted: false, reason: "stale_epoch" }
    if (!Broker.SUPPORTED_PROTOS.includes(input.proto)) return { accepted: false, reason: "proto" }
    if (input.key.length !== Broker.KEY_BYTES) return { accepted: false, reason: "key_mismatch" }
    const current = this.#armed
    if (current && input.epoch < current.epoch) return { accepted: false, reason: "stale_epoch" }
    if (current && input.epoch === current.epoch) {
      if (!current.same(input.key)) return { accepted: false, reason: "key_mismatch" }
      // Another broker or egress forward of the same epoch (a new tunnel): start over, counters included.
      if (
        JSON.stringify(current.endpoint) !== JSON.stringify(input.endpoint) ||
        JSON.stringify(current.egress ?? null) !== JSON.stringify(input.egress ?? null)
      )
        this.#start(arming(input))
      else if (!this.connected()) this.#kick?.()
      return { accepted: true }
    }
    this.#start(arming(input))
    this.#options.log.info("armed", { hostId: input.hostId, epoch: input.epoch, via: "socket" in input.endpoint ? "socket" : "tcp" })
    return { accepted: true }
  }

  /** Resolves `true` once connected (normal or drain), `false` after `timeoutMs`. */
  waitConnected(timeoutMs: number) {
    if (this.connected()) return Promise.resolve(true)
    if (timeoutMs <= 0 || !this.#armed) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.#waiters.delete(done)
        resolve(this.connected())
      }
      const timer = setTimeout(done, timeoutMs)
      this.#waiters.add(done)
    })
  }

  request(method: Broker.Method, params: unknown, timeoutMs: number): Promise<Reply> {
    const channel = this.#channel
    if (!channel || !this.connected()) return Promise.resolve({ ok: false, error: "unavailable" })
    const id = this.#next++
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve({ ok: false, error: "timeout" })
      }, timeoutMs)
      this.#pending.set(id, (reply) => {
        clearTimeout(timer)
        this.#pending.delete(id)
        resolve(reply)
      })
      if (!channel.send({ type: "req", id, method, params } satisfies Broker.Request)) {
        this.#pending.get(id)?.({ ok: false, error: "unavailable" })
      }
    })
  }

  close() {
    this.#closed = true
    this.#armed?.stop()
    this.#armed = undefined
    this.#channel?.close("closed")
    this.#setState("unarmed")
  }

  #start(armed: Armed) {
    this.#armed?.stop()
    this.#armed = armed
    this.#channel?.close("rearmed")
    void this.#run(armed)
  }

  async #run(armed: Armed) {
    let attempt = 0
    while (this.#armed === armed && !armed.stopped()) {
      this.#setState("connecting")
      const outcome = await this.#once(armed).catch((error: unknown) => {
        this.#options.log.debug("connect_failed", { error })
        return "failed" as const
      })
      if (this.#armed !== armed || armed.stopped()) return
      if (outcome === "skew") this.#setState("skew")
      attempt = outcome === "was_ready" ? 0 : attempt + 1
      const delay = outcome === "skew" ? 60_000 : RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        this.#kick = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.#kick = undefined
    }
  }

  async #once(armed: Armed): Promise<"failed" | "skew" | "was_ready"> {
    const socket = await this.#options.dial(armed.endpoint)
    const channel = new Wire.Channel(socket)
    if (this.#armed !== armed) {
      channel.close("rearmed")
      return "failed"
    }
    const nonceR = Wire.nonce()
    channel.send({
      type: "hello",
      proto: armed.proto,
      hostId: armed.hostId,
      epoch: armed.epoch,
      nonceR,
      version: this.#options.version,
      buildId: this.#options.buildId,
      mirrorSchemaVersion: Broker.MIRROR_SCHEMA_VERSION,
      streamId: this.#options.streamId(),
    } satisfies Broker.Hello)
    const first = await channel.next(HANDSHAKE_TIMEOUT_MS)
    const challenge = Option.getOrUndefined(decodeChallenge(first))
    if (!challenge) {
      channel.close("no_challenge")
      return Option.getOrUndefined(decodeReject(first))?.reason === "skew" ? "skew" : "failed"
    }
    const input = { hostId: armed.hostId, epoch: armed.epoch, nonceR, nonceL: challenge.nonceL }
    // The local side proves it knows K first (no fake listener behind the TCP fallback gets our proof, 04 §8.3).
    if (!Wire.equal(challenge.mac, armed.mac("L", input))) {
      this.#options.log.warn("local_mac_mismatch", { hostId: armed.hostId, epoch: armed.epoch })
      channel.close("local_mac")
      return "failed"
    }
    channel.send({ type: "auth", mac: armed.mac("R", input) } satisfies Broker.Auth)
    const answer = await channel.next(HANDSHAKE_TIMEOUT_MS)
    const ready = Option.getOrUndefined(decodeReady(answer))
    if (!ready) {
      channel.close("no_ready")
      return Option.getOrUndefined(decodeReject(answer))?.reason === "skew" ? "skew" : "failed"
    }
    if (this.#armed !== armed) {
      channel.close("rearmed")
      return "failed"
    }
    this.#channel = channel
    this.#ready = ready
    this.lastSeenAt = Date.now()
    const closed = new Promise<void>((resolve) => channel.onClose(() => resolve()))
    channel.onFrame((frame) => this.#frame(frame))
    this.#setState(ready.mode === "drain" ? "drain" : "connected")
    this.#options.log.info("connected", { hostId: armed.hostId, epoch: armed.epoch, mode: ready.mode })
    for (const waiter of [...this.#waiters]) waiter()
    try {
      this.#options.onReady(ready)
    } catch (error) {
      this.#options.log.warn("on_ready_failed", { error })
    }
    await closed
    if (this.#channel === channel) this.#channel = undefined
    for (const resolve of [...this.#pending.values()]) resolve({ ok: false, error: "unavailable" })
    this.#options.log.info("disconnected", { hostId: armed.hostId, epoch: armed.epoch })
    if (this.#armed === armed) this.#setState("connecting")
    return "was_ready"
  }

  #frame(frame: unknown) {
    this.lastSeenAt = Date.now()
    const response = Option.getOrUndefined(decodeResponse(frame))
    if (response) {
      const resolve = this.#pending.get(response.id)
      if (!resolve) return
      resolve(response.ok ? { ok: true, result: response.result } : { ok: false, error: response.error ?? "invalid" })
      return
    }
    const push = Option.getOrUndefined(decodePush(frame))
    if (!push) return
    try {
      this.#options.onPush(push)
    } catch (error) {
      this.#options.log.warn("on_push_failed", { event: push.event, error })
    }
  }

  #setState(state: State) {
    if (this.#state === state) return
    this.#state = state
    this.#options.onState(state)
  }
}
