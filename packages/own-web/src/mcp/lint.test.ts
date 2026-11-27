// The MCP OAuth lint exception exactly as 03 §16.3 states it (01 §17.1 #14):
// - only `src/mcp/oauth.ts` may call an integration connect route, and only `integration.oauth.connect`;
// - `connect.key` and `command.connect` stay forbidden everywhere, that file included;
// - the file re-reads `mcp.list`, requires `needs_auth` and the MCP integration id shape `mcp_<16 hex>`.
// src/boundaries.test.ts keeps the general rule; this file pins the exception's shape.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"

const SRC = path.join(import.meta.dir, "..")
const EXCEPTION = "mcp/oauth.ts"
const files = [...new Glob("**/*.{ts,tsx}").scanSync(SRC)]
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
const sources = await Promise.all(
  files.map(async (file) => ({ file, text: await Bun.file(path.join(SRC, file)).text() })),
)

function offenders(pattern: RegExp, allowed: (file: string) => boolean = () => false) {
  return sources.filter((entry) => !allowed(entry.file) && pattern.test(entry.text)).map((entry) => entry.file)
}

describe("MCP OAuth lint exception (03 §16.3)", () => {
  test("integration.oauth.connect (client or raw route) only in src/mcp/oauth.ts", () => {
    expect(
      offenders(/integration\s*\.\s*oauth\s*\.\s*connect\b|\/connect\/oauth\b/, (file) => file === EXCEPTION),
    ).toEqual([])
  })

  test("key and command connects are forbidden everywhere, the exception file included", () => {
    expect(
      offenders(
        /integration\s*\.\s*connect\s*\.\s*key\b|integration\s*\.\s*command\s*\.\s*connect\b|\/connect\/(key|command)\b/,
      ),
    ).toEqual([])
  })

  test("the rest of the attempt API (status, cancel, complete) stays in the exception file too", () => {
    expect(
      offenders(/integration\s*\.\s*oauth\s*\.\s*(status|cancel|complete)\b/, (file) => file === EXCEPTION),
    ).toEqual([])
  })

  test("the exception file re-reads mcp.list and checks needs_auth and the mcp_<16 hex> id before connecting", () => {
    const text = sources.find((entry) => entry.file === EXCEPTION)?.text ?? ""
    const connect = text.indexOf("integration.oauth.connect(")
    expect(connect).toBeGreaterThan(0)
    const before = text.slice(0, connect)
    expect(before).toContain("mcp.list(")
    expect(before).toContain('!== "needs_auth"')
    expect(before).toContain("MCP_INTEGRATION_ID.test(")
    expect(text).toContain("/^mcp_[0-9a-f]{16}$/")
  })
})
