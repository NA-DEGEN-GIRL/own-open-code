// The large-file tool of an SSH host (06 §4.13) for every own.team call that may need it: `enable` and `reorg.apply`
// (새 영역, 나누기, 팀 구성 다시 보기). One upload, one more try, never a loop; a failed upload is its own error, worded
// with own.remote's reason. Fakes only.
import { describe, expect, test } from "bun:test"
import { OwnRpcError } from "@/data/rpc"
import { LfsUploadFailed, withLfs } from "./lfs"
import { errorText, type TeamText } from "./model"
import { teamText } from "./strings"

const ko: TeamText = (key, params) => teamText.text("ko", key, params)
const missing = () => new OwnRpcError("lfs_missing", "the repository uses Git LFS", { tool: "git-lfs", version: null })

describe("withLfs (06 §4.13)", () => {
  test("lfs_missing: the tool goes up once and the call runs once more", async () => {
    const calls: string[] = []
    const answers: Array<() => unknown> = [
      () => {
        throw missing()
      },
      () => ({ opID: "op_01JB0000000000000000000001" }),
    ]
    const result = await withLfs(
      async () => {
        calls.push("reorg.apply")
        return answers[calls.filter((call) => call === "reorg.apply").length - 1]!()
      },
      async () => {
        calls.push("hosts.tools.ensure")
      },
    )
    expect(result).toEqual({ opID: "op_01JB0000000000000000000001" })
    expect(calls).toEqual(["reorg.apply", "hosts.tools.ensure", "reorg.apply"])
  })

  test("the second answer stands, even lfs_missing again: no loop", async () => {
    const calls: string[] = []
    const failed = withLfs(
      async () => {
        calls.push("reorg.apply")
        throw missing()
      },
      async () => {
        calls.push("hosts.tools.ensure")
      },
    )
    await expect(failed).rejects.toMatchObject({ type: "lfs_missing" })
    expect(calls).toEqual(["reorg.apply", "hosts.tools.ensure", "reorg.apply"])
  })

  test("a failed upload is LfsUploadFailed with own.remote's reason; other errors and no upload pass as they are", async () => {
    const failed = await withLfs(
      async () => {
        throw missing()
      },
      async () => {
        throw new OwnRpcError("noexec", "noexec", {})
      },
    ).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(LfsUploadFailed)
    expect(errorText(ko, failed)).toBe(
      "원격 호스트에 큰 파일 도구를 준비하지 못했어요: 원격 호스트의 그 폴더에서는 프로그램을 실행할 수 없어요",
    )
    const busy = new OwnRpcError("busy", "busy", {})
    await expect(
      withLfs(
        async () => {
          throw busy
        },
        async () => {},
      ),
    ).rejects.toBe(busy)
    // This PC's service, or a connection that may not upload: lfs_missing is the answer.
    await expect(
      withLfs(async () => {
        throw missing()
      }, undefined),
    ).rejects.toMatchObject({ type: "lfs_missing" })
  })

  test("every error hosts.tools.ensure declares has plain words", () => {
    for (const type of ["noexec", "install_failed", "input_invalid", "tool_hash_mismatch", "disk_full"]) {
      const text = errorText(ko, new OwnRpcError(type, "m", {}))
      expect({ type, text }).not.toEqual({ type, text: ko("own.team.error.internalError") })
    }
  })
})
