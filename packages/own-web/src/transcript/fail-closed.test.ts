// SLM: a turn own stopped on an SSH host (the host's sink, this PC's relays) shows its Korean line and what to do,
// never the raw JSON; an older host's bare `own_broker_unavailable` gets the update line.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { failClosed, failClosedText } from "./fail-closed"

const sink = (code: string, message: string) =>
  JSON.stringify({ error: { type: "own_broker_unavailable", code, message } })

describe("fail-closed turns (04 §8.6, §8.11.8, §8.14)", () => {
  test("the user's error on an older host: the update line, another model and the host settings", () => {
    const info = failClosed('{"error":"own_broker_unavailable"}')
    expect(info).toEqual({ code: "legacy", text: undefined, actions: ["switch", "hosts"] })
    expect(failClosedText.text("ko", "own.failClosed.legacy")).toContain("이 PC의 로컬 모델이라면 이 SSH 서버에서 바로 쓸 수 없어요")
    expect(failClosedText.text("ko", "own.failClosed.legacy")).not.toContain("own_broker_unavailable")
  })

  test("each answer names its line and its way out", () => {
    expect(failClosed(sink("unavailable", "PC와 연결이 끊겨 이 모델을 부를 수 없어요."))).toEqual({
      code: "unavailable",
      text: "PC와 연결이 끊겨 이 모델을 부를 수 없어요.",
      actions: ["retry", "switch", "hosts"],
    })
    expect(failClosed(sink("local_pc_old", "PC 앱을 업데이트하세요."))?.actions).toEqual(["switch"])
    expect(failClosed(sink("refused_account_not_remote", "x"))?.actions).toEqual(["switch", "hosts"])
    expect(failClosed(sink("refused_needs_reauth", "x"))?.actions).toEqual(["switch", "accounts"])
    expect(failClosed(sink("claude_off", "x"))?.actions).toEqual(["switch", "accounts"])
    const local = JSON.stringify({ error: { type: "own_local_relay", code: "upstream_unreachable", message: "모델 서버" } })
    expect(failClosed(local)).toEqual({ code: "upstream_unreachable", text: "모델 서버", actions: ["retry", "switch"] })
    expect(failClosed(JSON.stringify({ error: { type: "own_local_relay", code: "host_scope", message: "범위" } }))?.actions).toEqual([
      "switch",
      "hosts",
    ])
    // The Claude relay's answers before SLM carried only the code as the message.
    expect(failClosed(JSON.stringify({ type: "error", error: { type: "own_egress", message: "off" } }))).toEqual({
      code: "off",
      text: undefined,
      actions: ["switch", "accounts"],
    })
  })

  test("any other body is not own's", () => {
    expect(failClosed(undefined)).toBeUndefined()
    expect(failClosed("")).toBeUndefined()
    expect(failClosed("<html>bad gateway</html>")).toBeUndefined()
    expect(failClosed('{"error":{"type":"invalid_request_error","message":"own_broker_unavailable"}}')).toBeUndefined()
    expect(failClosed('{"error":"rate_limited"}')).toBeUndefined()
  })

  test("the transcript hands such a turn to the lazy row and never shows its raw body", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "session.tsx")).text()
    expect(source).toContain('const FailClosedRow = lazy(() => import("./fail-closed"))')
    expect(source).toContain("failed && !ownStop() ? responseBody(")
    for (const key of ["own.failClosed.switch", "own.failClosed.hosts", "own.failClosed.accounts", "own.failClosed.retry"] as const)
      expect(failClosedText.text("en", key)).not.toBe(failClosedText.text("ko", key))
  })
})
