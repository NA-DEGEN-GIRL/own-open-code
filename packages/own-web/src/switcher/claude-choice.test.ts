// RS (2026-11-28): the switcher of a new SSH-host conversation chose a Claude subscription account with the host's
// `plugin.claudeAuth.default.set`, which a host answers `remote_managed`, and jumped to the accounts page without a
// word. The default is chosen on this PC; a refusal names its reason.
import { describe, expect, test } from "bun:test"
import type { OwnRpc } from "@/data/rpc"
import { OwnRpcError } from "@/data/rpc"
import { defaultRpc, refusalReason } from "./claude-choice"

const rpc = (name: string) => ({ name }) as unknown as OwnRpc

describe("the Claude account a new conversation starts on", () => {
  const server = rpc("host")
  const local = rpc("pc")

  test("a Claude subscription account is chosen on this PC, also for a host conversation", () => {
    expect(defaultRpc({ kind: "claude-sub", host: true, server, local })).toBe(local)
    expect(defaultRpc({ kind: "claude-sub", host: false, server, local })).toBe(server)
  })

  test("a Claude Agent account is chosen where the conversation runs (a host keeps its own default)", () => {
    expect(defaultRpc({ kind: "claude-agent", host: true, server, local })).toBe(server)
  })

  test("a refusal says why in words, an unknown one by its code", () => {
    expect(refusalReason(new OwnRpcError("account_not_found", "x"), "ko")).toBe(
      "이 계정이 목록에 없어요. 계정 화면에서 확인하세요",
    )
    expect(refusalReason(new Error("offline"), "ko")).toBe("서비스에 연결하지 못했어요. 잠시 뒤 다시 해 보세요")
    expect(refusalReason(new OwnRpcError("remote_managed", "x"), "en")).toBe("remote_managed")
  })
})
