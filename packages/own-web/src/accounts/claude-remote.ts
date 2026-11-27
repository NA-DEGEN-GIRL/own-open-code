// The Claude card's `SSH 원격 호스트에서 쓰기` (04 §8.11.4.1, §8.11.12): which hosts it lists and how one host's switch
// goes. Switching on asks for the remote consent first (its own notice, `plugin.claudeAuth.remote.ack`), then
// `plugin.claudeAuth.remote.set`; switching off is the set alone. Every call is this PC's (`local` scope, control
// location): a remote service refuses them (`remote_managed`). The component is `ClaudeRemote` in claude-slot.tsx.
import type { Plugin } from "@own/protocol"
import type { HostView } from "@/data"
import type { OwnOutput, OwnRpc } from "@/data/rpc"
import type { Locale } from "@/i18n"
import { CLAUDE_PIN, remoteNoticeHash } from "./claude-notice"
import { errorData, errorType } from "./errors"

export interface RemoteRow {
  readonly hostId: string
  readonly name: string
  readonly enabled: boolean
  readonly state: Plugin.ClaudeRemoteState
  /** The host's own.remote `hosts.list` row (connection, the relay's last refusal); absent once forgotten. */
  readonly host: HostView | undefined
}

/**
 * Every host of this PC's `hosts.list` with its switch and verdict, then the hosts still switched on that the list no
 * longer has, so they can be switched off. The verdict is `plugin.claudeAuth.status.remote`'s (it lists the hosts
 * switched on and those whose broker listener is open), else the host row's `broker.claude`, else `off`.
 */
export function remoteRows(
  status: Plugin.ClaudeRemoteStatus,
  list:
    | { readonly order: readonly string[]; readonly hosts: Readonly<Record<string, HostView | undefined>> }
    | undefined,
): RemoteRow[] {
  const known = new Map(status.hosts.map((host) => [host.hostId, host]))
  const listed = (list?.order ?? []).flatMap((hostId) => {
    const host = list?.hosts[hostId]
    if (!host) return []
    const switched = known.get(hostId)
    return [
      {
        hostId,
        name: host.name,
        enabled: switched?.enabled ?? false,
        state: switched?.state ?? host.broker.claude?.state ?? "off",
        host,
      },
    ]
  })
  const gone = status.hosts
    .filter((host) => host.enabled && !list?.hosts[host.hostId])
    .map((host) => ({ hostId: host.hostId, name: host.hostId, enabled: true, state: host.state, host: undefined }))
  return [...listed, ...gone]
}

export type RemoteSwitch =
  | { readonly kind: "set"; readonly host: Plugin.ClaudeRemoteHost }
  /** The notice was closed without 동의하고 켜기: nothing was sent. */
  | { readonly kind: "declined" }
  /** This app's copy of the notice is not the one the service hashes (another build): nothing was sent. */
  | { readonly kind: "stale" }

/**
 * One host's switch. Switching on without a valid remote consent shows the notice first (`notice` resolves with the
 * user's answer), records the consent (the bundled plugin's pin and the hash of the notice in the language it was shown
 * in, `locale`), then switches.
 * A set answered with `ack_required{remote}` (the consent went stale meanwhile) asks the same way, once.
 */
export async function switchRemoteHost(input: {
  readonly call: OwnRpc["call"]
  readonly status: Pick<OwnOutput<"plugin.claudeAuth.status">, "version" | "remote" | "bundle"> | undefined
  readonly hostId: string
  readonly enabled: boolean
  readonly locale: Locale
  readonly notice: () => Promise<boolean>
}): Promise<RemoteSwitch> {
  const set = () => input.call("plugin.claudeAuth.remote.set", { hostId: input.hostId, enabled: input.enabled })
  const acknowledge = async () => {
    // The service acknowledges only its own notice, which it names by its Korean text: a different copy is refused, so
    // say so before asking.
    if (input.status?.remote && input.status.remote.noticeHash !== (await remoteNoticeHash())) return "stale"
    if (!(await input.notice())) return "declined"
    // The bundled plugin's pin (02 §8.2); a service before the bundle reports only the version.
    const bundle = input.status?.bundle
    const pin = bundle
      ? { version: bundle.version, integrity: bundle.integrity }
      : { version: input.status?.version ?? CLAUDE_PIN.version, integrity: CLAUDE_PIN.integrity }
    await input.call("plugin.claudeAuth.remote.ack", {
      ...pin,
      noticeHash: await remoteNoticeHash(input.locale),
    })
    return "acknowledged"
  }
  const afterNotice = async (): Promise<RemoteSwitch> => {
    const answer = await acknowledge()
    if (answer !== "acknowledged") return { kind: answer }
    return { kind: "set", host: await set() }
  }
  if (input.enabled && !input.status?.remote?.acknowledged?.valid) return afterNotice()
  const first = await set().then(
    (host) => ({ host }),
    (error: unknown) => {
      if (input.enabled && remoteConsentMissing(error)) return undefined
      throw error
    },
  )
  return first ? { kind: "set", host: first.host } : afterNotice()
}

function remoteConsentMissing(error: unknown) {
  return errorType(error) === "ack_required" && errorData<{ reason: string }>(error).reason === "remote"
}
