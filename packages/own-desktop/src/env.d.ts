// Build constants (electron.vite.config.ts `define`). OPENCODE_CHANNEL is upstream's; the substituted constants.ts
// no longer reads it, but upstream modules still type-check against it.
interface ImportMetaEnv {
  /** rpcHash of the shell <-> renderer IPC contract (05 §5.5). */
  readonly OWN_RPC_HASH: string
  /** own release version of the shell build (`OWN_VERSION`, 05 §4.4). */
  readonly OWN_SHELL_VERSION: string
  /** "1" in the 원격 PC 전용 build (OWN_DESKTOP_CLIENT_ONLY, src/main/client-only.ts); "" otherwise. */
  readonly OWN_CLIENT_ONLY?: string
  /** "1" in a development shell (`electron-vite dev`, src/main/own-env.ts `devShell`); "" in every build. */
  readonly OWN_DEV_SHELL?: string
  readonly OPENCODE_CHANNEL: string
  readonly OPENCODE_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
