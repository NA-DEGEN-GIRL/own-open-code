// Capabilities per server (03 §16.7, 05 §6.2, 04 §12.5): the host's capabilities that act on this PC's files are
// "local server sessions only". For an SSH server they are off: folders come from the remote picker (04 §12.4),
// attachments are uploads, and "open locally" / "reveal" actions are hidden because paths are remote paths.
import type { ServerRuntime } from "@/data"
import type { HostCapabilities } from "@/host"

export const LOCAL_ONLY = [
  "nativeDirectoryPicker",
  "nativeFilePaths",
  "openInApp",
] as const satisfies readonly (keyof HostCapabilities)[]

export function serverCapabilities(
  host: HostCapabilities,
  runtime: Pick<ServerRuntime, "kind"> | undefined,
): HostCapabilities {
  if (!runtime || runtime.kind === "local") return host
  return { ...host, nativeDirectoryPicker: false, nativeFilePaths: false, openInApp: false }
}

/** Local file actions (open in an app, reveal in Explorer) apply to this server's paths. */
export function localFileActions(host: HostCapabilities, runtime: Pick<ServerRuntime, "kind"> | undefined) {
  return serverCapabilities(host, runtime).openInApp
}
