export * as Events from "./events.js"

import type { OwnRemote } from "./protocol/rpc-remote.js"

/**
 * Controller notifications. The process-lifetime controller has one listener per plugin instance; only the leader
 * instance republishes them as `rpc.own.remote.<name>` (04 §16.3), each with a fresh `eventId`.
 */
export type Event =
  | { readonly name: "hosts.changed"; readonly data: { readonly revision: number } }
  | {
      readonly name: "host.state"
      readonly data: {
        readonly hostId: string
        readonly stage: OwnRemote.Stage
        readonly paused: boolean
        readonly error?: OwnRemote.HostError | null
        readonly detail?: string
        readonly epoch?: number
        readonly versions?: {
          readonly local: string
          readonly remoteRunning: string | null
          readonly remoteStaged: ReadonlyArray<string>
          readonly skew: boolean
        }
      }
    }
  | {
      readonly name: "host.prompt"
      readonly data: {
        readonly hostId: string
        readonly promptId: string
        readonly kind: OwnRemote.PromptKind
        readonly text: string
        readonly fingerprint?: string
        readonly keyType?: string
        readonly ownerClientId: string | null
      }
    }
  | {
      readonly name: "host.progress"
      readonly data: {
        readonly hostId: string
        readonly opId?: string
        readonly op: "install" | "update" | "drain" | "sync" | "forget"
        readonly step: string
        readonly ok?: boolean
        readonly error?: string
      }
    }
  | { readonly name: "catalog.changed"; readonly data: { readonly hostId: string; readonly epoch: number } }
  | {
      readonly name: "broker.status"
      readonly data: {
        readonly hostId: string
        readonly state: "connected" | "disconnected" | "auth_failed"
        readonly leasesActive: number
        readonly spoolBacklog: number
        readonly claude?: {
          readonly state: "not_ready" | "billing" | "off" | "consent" | "host_scope" | "enabled"
          readonly lastError: string | null
          readonly holdUntil: number | null
        }
      }
    }
  // M1: the gateway (05 §13.4–13.6), published by the leader like the controller's events.
  | {
      readonly name: "gateway.state"
      readonly data: {
        readonly enabled: boolean
        readonly state: OwnRemote.GatewayState
        readonly problem: string | null
        readonly port: number | null
        readonly url: string | null
      }
    }
  | {
      readonly name: "device.pairing.pending"
      readonly data: {
        readonly pairingId: string
        readonly name: string
        readonly sas: string
        readonly userAgent: string | null
        readonly tailscaleUser: string | null
        readonly expiresAt: number
      }
    }
  | {
      readonly name: "device.pairing.ended"
      readonly data: { readonly pairingId: string; readonly reason: "claimed" | "cancelled" | "rejected" | "expired" }
    }
  | { readonly name: "device.paired"; readonly data: { readonly deviceId: string; readonly name: string } }
  | { readonly name: "device.revoked"; readonly data: { readonly deviceId: string } }
  | { readonly name: "feed.item"; readonly data: { readonly item: OwnRemote.FeedItem } }
  // The browser pane on a device (05 §8.10.4): the gateway's hub asks the desktop window to attach a session's pane.
  // `serverKey`: the SSH host of the session (05 §8.10.8); absent for this PC's service.
  | { readonly name: "browser.pane.wanted"; readonly data: { readonly serverKey?: string; readonly sessionID: string } }

export type Listener = (event: Event) => void

export class Hub {
  readonly #listeners = new Set<Listener>()

  subscribe(listener: Listener) {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  emit(event: Event) {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // A listener never breaks the controller.
      }
    }
  }
}
