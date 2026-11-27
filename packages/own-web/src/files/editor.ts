// `에디터에서 열기` and `탐색기에서 보기` (03 §19.5, §16.7 capability table, 04 §12.5). Which one a file gets depends on
// the host and on the server the session runs on, never on `host.kind`:
//   - local server + `capabilities.openInApp` (desktop): the host opens the file in the chosen editor
//     (`host.files.openPath`) and reveals it in Explorer (`host.files.revealPath`);
//   - local server without it (web): a `vscode://file/<path>:<line>` link; no reveal. A paired device
//     (`auth: "device"`, 05 §13) gets neither: the path is on the PC, not on the phone;
//   - SSH server: `vscode://vscode-remote/ssh-remote+<alias><path>:<line>` when the host has an ssh config alias;
//     local actions are hidden (paths are remote paths);
//   - `explorer` (the desktop app's `host.explorer`, 05 §7.10): `탐색기에서 보기` on a local server (Explorer) and on
//     an SSH server (the user's SSH file explorer program; shown also before one is chosen, the click then says so).
import { createSignal } from "solid-js"
import type { ConnectionAuth, HostCapabilities } from "@/host/types"

export type EditorOpen =
  | { readonly kind: "app" }
  | { readonly kind: "url"; readonly url: (absolute: string, line?: number) => string }

export interface FileActionsAvailable {
  readonly open?: EditorOpen
  readonly reveal: boolean
}

export function fileActions(input: {
  readonly capabilities: HostCapabilities
  readonly server: "local" | "ssh"
  readonly auth?: ConnectionAuth
  readonly openPath: boolean
  readonly revealPath: boolean
  /** ssh config alias of the SSH host (`HostView.alias`); `null` when it was added by `user@host`. */
  readonly alias?: string | null
  /** The host opens Explorer or the SSH file explorer program (`host.explorer`, loaded). */
  readonly explorer?: boolean
}): FileActionsAvailable {
  if (input.server === "ssh") {
    const alias = input.alias
    return {
      open: alias ? { kind: "url", url: (path, line) => vscodeRemoteUrl(alias, path, line) } : undefined,
      reveal: input.explorer === true,
    }
  }
  if (input.capabilities.openInApp && input.openPath)
    return { open: { kind: "app" }, reveal: input.explorer === true || input.revealPath }
  if (input.auth === "device") return { reveal: false }
  return { open: { kind: "url", url: vscodeFileUrl }, reveal: false }
}

/** `vscode://file/C:/repo/src/a.ts:12` (VS Code's documented form; `/home/u/a.ts` keeps its leading slash). */
export function vscodeFileUrl(absolute: string, line?: number) {
  return `vscode://file${urlPath(absolute)}${line ? `:${line}` : ""}`
}

/** `vscode://vscode-remote/ssh-remote+devbox/home/u/repo/a.ts:12` (Remote - SSH). */
export function vscodeRemoteUrl(alias: string, absolute: string, line?: number) {
  return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(alias)}${urlPath(absolute)}${line ? `:${line}` : ""}`
}

function urlPath(absolute: string) {
  const path = absolute.replaceAll("\\", "/")
  const rooted = path.startsWith("/") ? path : `/${path}`
  // Each segment is encoded (`#`, `%`, spaces, Hangul); a drive letter keeps its colon.
  return rooted
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/")
}

const EDITOR_KEY = "own.web.files.editor"

/**
 * The desktop editor `에디터에서 열기` uses (03 §5.7 설정 > 데스크톱 "에디터 선택", 19.5): an app name the desktop host
 * resolves (`code`, `cursor`, `zed`, …) or a full path. Browser storage only (a per-window convenience); `code` when
 * nothing is stored or storage fails.
 */
export const editorPreference = (() => {
  const [value, setValue] = createSignal(readEditor())
  return {
    get: value,
    set(next: string) {
      const trimmed = next.trim() || "code"
      setValue(trimmed)
      try {
        localStorage.setItem(EDITOR_KEY, trimmed)
      } catch {}
    },
  }
})()

function readEditor() {
  try {
    return localStorage.getItem(EDITOR_KEY) || "code"
  } catch {
    return "code"
  }
}
