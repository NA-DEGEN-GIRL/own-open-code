// 원격 PC in own-web (08 §4.1): other PCs' own-web, each in its own pinned shell window. Public surface for the shell
// and the sidebar; the dialogs (add with the confirmation number, remove) are the lazy `./dialogs` chunk.
//
// Wiring:
// - shell: `<RemotePcLayer />` once (creates the store in hosts with `capabilities.remotePcs`).
// - sidebar: a section per PC (sidebar/sections.tsx) and `다른 PC` 추가 at its bottom.
export { closeRemotePcDialog, openRemotePcDialog, remotePcDialog, remotePcStore, type RemotePcDialog } from "./active"
export { RemotePcLayer } from "./layer"
export { createRemotePcStore, type RemotePcStore } from "./store"
export { remotePcEn, remotePcKo, remotePcText, useRemotePcText, type RemotePcKey } from "./strings"
