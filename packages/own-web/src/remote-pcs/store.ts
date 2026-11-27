// The window's 원격 PC list (08 §4.1) over `host.remotePcs`: the shell's list once, then every change it pushes
// (added, removed, state, window opened or closed). Nothing polls: the shell checks each PC once per run and again
// whenever that PC's window loads.
import { createSignal } from "solid-js"
import type { HostRemotePcs, RemotePc } from "@/host/types"

export interface RemotePcStore {
  readonly api: HostRemotePcs
  readonly pcs: () => readonly RemotePc[]
  /** The first list (or a change) arrived. */
  readonly loaded: () => boolean
  open(pcKey: string): void
  remove(pcKey: string): Promise<boolean>
  dispose(): void
}

export function createRemotePcStore(api: HostRemotePcs): RemotePcStore {
  const [pcs, setPcs] = createSignal<readonly RemotePc[]>([])
  const [loaded, setLoaded] = createSignal(false)
  // A change pushed while the first list is on its way is newer than that list.
  let changes = 0
  const off = api.onChange((next) => {
    changes++
    setPcs(next)
    setLoaded(true)
  })
  void api
    .list()
    .then((list) => {
      if (changes === 0) setPcs(list)
    })
    .catch(() => undefined)
    .finally(() => setLoaded(true))
  return {
    api,
    pcs,
    loaded,
    open: (pcKey) => void api.open(pcKey).catch(() => undefined),
    remove: (pcKey) => api.remove(pcKey).catch(() => false),
    dispose: off,
  }
}
