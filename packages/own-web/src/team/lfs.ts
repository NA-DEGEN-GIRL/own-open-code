// The large-file tool of an SSH host (06 §4.13), shared by `팀 모드 켜기` (enable.ts) and the reorganizations that make
// an area (`reorg.apply`: 새 영역, 나누기, 팀 구성 다시 보기). A remote own.team cannot reach SSH, so it answers
// `lfs_missing` until this PC's own.remote uploaded the release's pinned git-lfs (`hosts.tools.ensure`). Small and
// without UI, so the first chunk and the team chunk both take it.
import type { ServerKey, useData } from "@/data"
import { OwnRpcError } from "@/data/rpc"

/** The upload of the bundled large-file tool failed (06 §4.13); `cause` is own.remote's answer. */
export class LfsUploadFailed extends Error {
  constructor(override readonly cause: unknown) {
    super("the large-file tool could not be uploaded")
  }
}

/**
 * One call that may answer `lfs_missing`: then the tool is uploaded once (`ensure`, absent where no host can get it)
 * and the call runs once more; whatever the second answer is, it stands, never a loop. A failed upload rejects with
 * {@link LfsUploadFailed}.
 */
export async function withLfs<T>(call: () => Promise<T>, ensure: (() => Promise<unknown>) | undefined): Promise<T> {
  const first = await call().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  if (first.ok) return first.value
  if (!ensure || !(first.error instanceof OwnRpcError && first.error.type === "lfs_missing")) throw first.error
  await ensure().catch((error: unknown) => {
    throw new LfsUploadFailed(error)
  })
  return call()
}

/**
 * The upload for the server `serverKey`: an SSH host's server key is its host id (04 §16.2), and only this PC's
 * own.remote with the `manage` scope can upload there. `undefined` elsewhere.
 */
export function lfsUpload(data: ReturnType<typeof useData>, serverKey: ServerKey) {
  if (data.get(serverKey)?.kind !== "ssh" || !data.remote.allowed("hosts.tools.ensure")) return undefined
  return () => data.remote.call("hosts.tools.ensure", { hostId: serverKey, tool: "git-lfs" })
}
