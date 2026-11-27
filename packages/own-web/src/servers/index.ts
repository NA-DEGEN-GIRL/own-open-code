// SSH remote servers in own-web (04 §12, §17; 03 §4.3, §4.4, §18.16). Public surface for the shell, sidebar, header,
// limits and settings; the dialogs (add host, prompts, remote folder picker, update/drain/forget) are the lazy
// `@/remote` chunk.
//
// Wiring:
// - shell: `<RemoteLayer />` once; `<RemoteSessionOverlay serverKey />` inside the session view.
// - sidebar: the server sections (sidebar/sections.tsx) in the order of `./order.ts`.
// - header: `<ServerBadge serverKey sessionID />` next to the title.
// - usage/ledger rows: `<ServerTag serverKey={serverOfSession(data, sessionID)} />`.
// - settings > 원격 호스트: `@/remote/settings` (lazy).
export {
  newChatHost,
  closeRemoteDialog,
  openRemoteDialog,
  registerRemoteStore,
  remoteDialog,
  remoteStore,
  type RemoteDialog,
} from "./active"
export { ServerBadge, ServerTag, serverOfSession } from "./badge"
export { localFileActions, serverCapabilities } from "./capabilities"
export { remoteClientId } from "./client-id"
export { RemoteLayer } from "./layer"
export { RemoteSessionOverlay } from "./overlay"
export { selectHostPanel, selectedHostPanel } from "./panel"
export { hasRemoteHosts } from "./order"
export {
  accountAllowed,
  catalogList,
  destinationHost,
  hostStatus,
  newerList,
  overlayKind,
  type HostStatus,
  type HostStatusKey,
  type LiveStatus,
  type OverlayKind,
} from "./state"
export { createRemoteStore, type HostEndpoint, type PromptData, type RemoteState, type RemoteStore } from "./store"
export { serversEn, serversKo, serversText, useServersText, type ServersKey } from "./strings"
