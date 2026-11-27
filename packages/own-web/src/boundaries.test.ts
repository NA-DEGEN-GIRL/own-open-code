// Import and API boundaries that 03 §16.3 / 05 §6.2 / 05 §6.5 ask lint to enforce. Kept as a test so it runs with
// `bun run test` without adding lint plugins to the repository.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"

const SRC = import.meta.dir
const files = [...new Glob("**/*.{ts,tsx}").scanSync(SRC)]
  .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
  .map((file) => ({ file: file.replaceAll("\\", "/"), text: "" }))
for (const entry of files) entry.text = await Bun.file(path.join(SRC, entry.file)).text()

function offenders(pattern: RegExp, allowed: (file: string) => boolean = () => false) {
  return files.filter((entry) => !allowed(entry.file) && pattern.test(entry.text)).map((entry) => entry.file)
}

describe("boundaries", () => {
  test("@opencode/desktop only from src/host/desktop.ts (05 §6.6)", () => {
    expect(offenders(/from\s+["']@opencode\/desktop/, (file) => file === "host/desktop.ts")).toEqual([])
  })

  test("@opencode/session-ui only through src/adapter (03 §16.1)", () => {
    expect(offenders(/from\s+["']@opencode\/session-ui/, (file) => file.startsWith("adapter/"))).toEqual([])
  })

  test("@opencode/client runtime imports only in src/data (types are fine anywhere)", () => {
    expect(
      offenders(/import\s+(?!type\b)[^;]*from\s+["']@opencode\/client/, (file) => file.startsWith("data/")),
    ).toEqual([])
  })

  test("the own.accounts RPC id is known only by src/data (03 §16.3)", () => {
    expect(offenders(/["']own\.accounts["']|rpc\.call\(\s*\{/, (file) => file.startsWith("data/"))).toEqual([])
  })

  test("the own.team id (RPC id and session metadata key) is known only by src/data (06 §9.8)", () => {
    // Screens read the metadata key as `TEAM_META.session` and call through the TeamStore (`runtime.team`).
    expect(offenders(/["']own\.team["']/, (file) => file.startsWith("data/"))).toEqual([])
  })

  test("the own.import id (RPC id, event prefix and session metadata key) is known only by src/data (09 §5.1, §6)", () => {
    // Screens call through `runtime.imports` and read metadata with IMPORT_META, isImportHelper and importOrigin.
    expect(offenders(/["'`](?:rpc\.)?own\.import\b/, (file) => file.startsWith("data/"))).toEqual([])
  })

  test("the own.creator id (RPC id and event name) is known only by src/data (17 §8)", () => {
    // The 확장 page calls through `creatorRpcOf(runtime)` and reads events with `creatorChanged`.
    expect(offenders(/["'`](?:rpc\.)?own\.creator\b/, (file) => file.startsWith("data/"))).toEqual([])
  })

  test("src/data imports the own RPC definitions as types only, so no schema graph is in the first chunk (03 §20.2 R5)", () => {
    // The routing tables (`*-routing`) are plain data; the definitions evaluate Effect schemas. `[^"'`]` keeps a match
    // inside one import statement.
    const definition =
      /import\s+(?!type\b)[^"'`]*from\s+["']@own\/protocol\/(?:rpc(?:-import|-team|-remote|-computer|-creator)?|creator)["']/
    expect(offenders(definition, (file) => !file.startsWith("data/"))).toEqual([])
  })

  test("host kind is compared only inside src/host (03 §16.7)", () => {
    expect(offenders(/\.kind\s*[!=]==\s*["'](web|desktop|mobile)["']/, (file) => file.startsWith("host/"))).toEqual([])
  })

  test("forbidden server calls (03 §16.3): credential activate, integration connect, location reload, pairing", () => {
    expect(offenders(/credential\.activate|\/api\/credential\/[^"'`]*\/activate/)).toEqual([])
    // 03 §16.3 / 01 §17.1 #14: the one exception is the MCP sign-in in src/mcp/oauth.ts, and there only the OAuth
    // connect (src/mcp/lint.test.ts pins the exception's details). The client's real calls are
    // `integration.oauth.connect`, `integration.connect.key` and `integration.command.connect`.
    expect(
      offenders(/integration\s*\.\s*oauth\s*\.\s*connect\b|\/connect\/oauth\b/, (file) => file === "mcp/oauth.ts"),
    ).toEqual([])
    expect(
      offenders(
        /integration\s*\.\s*connect\s*\.\s*key\b|integration\s*\.\s*(key|command)\s*\.\s*connect\b|\/connect\/(key|command)\b/,
      ),
    ).toEqual([])
    expect(offenders(/\/api\/integration\/[^"'`]*\/connect/, (file) => file === "mcp/oauth.ts")).toEqual([])
    expect(offenders(/(?<!window\.)location\.reload\(|\/api\/location\/reload/)).toEqual([])
    expect(offenders(/\/api\/pair\b|\.server\.pair\(/)).toEqual([])
    expect(offenders(/auth_token/)).toEqual([])
  })

  test("session permissions are written only by the router (session.approval.set)", () => {
    expect(offenders(/session\.update\(\s*\{[^}]*permissions/s)).toEqual([])
  })

  test("unused desktop IPC stays unused (05 §6.5)", () => {
    expect(offenders(/sshServers|wslServers|api\.updater|finishFirstLaunchOnboarding/)).toEqual([])
  })
})
