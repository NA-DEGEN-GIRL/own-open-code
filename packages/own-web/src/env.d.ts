/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev server only (vite.config.ts `define`): control location from OWN_WEB_CONTROL_DIR, "" when unset. */
  readonly OWN_DEV_CONTROL_DIR: string
  /** The user manual page of this build (src/manual/vite.ts), "" when the build has none. */
  readonly OWN_MANUAL_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
