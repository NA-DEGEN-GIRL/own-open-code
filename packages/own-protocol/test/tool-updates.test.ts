// 설정 > 업데이트 contract (05 §20, UPD): version parsing and comparison of the programs' `--version` lines and release
// tags, the status rules, the thresholds kept equal to their sources (core's Claude Agent probe, the Claude Agent SDK's
// manifest, own-remote's git-lfs pin, core's ripgrep pin, own-accounts' reviewed github-mcp-server) and the methods'
// routing (this PC's windows only, refused by a remote service).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { OwnAccounts, ToolUpdates } from "../src/index.js"

const ROOT = path.join(import.meta.dir, "..", "..", "..")
const read = (file: string) => Bun.file(path.join(ROOT, file)).text()

describe("ToolUpdates.parse", () => {
  test("reads each program's --version line and the release tags", () => {
    const text = (line: string) => ToolUpdates.parse(line)?.text
    expect(text("2.1.282 (Claude Code)")).toBe("2.1.282")
    expect(text("git version 2.55.0.windows.3")).toBe("2.55.0.windows.3")
    expect(ToolUpdates.parse("git version 2.55.0.windows.3")?.parts).toEqual([2, 55, 0, 3])
    expect(text("git-lfs/3.7.1 (GitHub; windows amd64; go 1.25.1; git b84b3384)")).toBe("3.7.1")
    expect(text("gh version 2.101.0 (2026-09-15)\nhttps://github.com/cli/cli/releases/tag/v2.101.0")).toBe("2.101.0")
    expect(text("ripgrep 15.1.0 (rev 1a2b3c)\n\nfeatures:+pcre2")).toBe("15.1.0")
    expect(text("github-mcp-server 2.0.3")).toBe("2.0.3")
    expect(text("v2.56.0.windows.1")).toBe("2.56.0.windows.1")
    expect(text("v3.8.1")).toBe("3.8.1")
    expect(ToolUpdates.parse("2.2.0-rc.1")).toEqual({ parts: [2, 2, 0], pre: "rc.1", text: "2.2.0-rc.1" })
  })

  test("a line without a dotted number is no version", () => {
    expect(ToolUpdates.parse("command not found")).toBeUndefined()
    expect(ToolUpdates.parse("version 7")).toBeUndefined()
    expect(ToolUpdates.parse("")).toBeUndefined()
  })
})

describe("ToolUpdates.compare", () => {
  const order = (a: string, b: string) => Math.sign(ToolUpdates.compare(ToolUpdates.parse(a)!, ToolUpdates.parse(b)!))

  test("compares number by number, missing numbers as 0", () => {
    expect(order("2.1.282", "2.1.301")).toBe(-1)
    expect(order("2.1.301", "2.1.282")).toBe(1)
    expect(order("2.1.9", "2.1.10")).toBe(-1)
    expect(order("2.40", "2.40.0")).toBe(0)
    expect(order("2.42", "2.41.9")).toBe(1)
    expect(order("3.7.1", "3.8.1")).toBe(-1)
  })

  test("Git for Windows' .windows.N counts after the release numbers", () => {
    expect(order("2.55.0.windows.3", "2.55.0.windows.1")).toBe(1)
    expect(order("2.55.0.windows.3", "2.56.0.windows.1")).toBe(-1)
    expect(order("2.55.0.windows.1", "2.55.0")).toBe(1)
  })

  test("a pre-release is older than its release", () => {
    expect(order("2.2.0-rc.1", "2.2.0")).toBe(-1)
    expect(order("2.2.0", "2.2.0-rc.1")).toBe(1)
    expect(order("2.2.0-rc.1", "2.2.0-rc.2")).toBe(-1)
    expect(order("2.2.0-rc.1", "2.2.0-rc.1")).toBe(0)
  })

  test("older is false when either side does not parse", () => {
    expect(ToolUpdates.older("2.1.282", "2.1.301")).toBe(true)
    expect(ToolUpdates.older("2.1.301", "2.1.301")).toBe(false)
    expect(ToolUpdates.older("unknown", "2.1.301")).toBe(false)
  })
})

describe("ToolUpdates.status", () => {
  const claude = (installed: string | null, latest: string | null = null, found = true) =>
    ToolUpdates.status({ found, installed, latest, thresholds: ToolUpdates.THRESHOLDS["claude-code"] })

  test("not found is missing, an unreadable version unknown", () => {
    expect(claude(null, "2.1.320", false)).toEqual({ status: "missing", why: "not_installed" })
    expect(claude(null)).toEqual({ status: "unknown", why: "unreadable" })
    expect(claude("garbled")).toEqual({ status: "unknown", why: "unreadable" })
  })

  test("Claude Code: below 2.1.248 blocks Claude Agent, below 2.1.257 and below the SDK's version are recommended", () => {
    expect(claude("2.1.200", "2.1.320")).toEqual({ status: "required", why: "claude_verbatim" })
    expect(claude("2.1.250", "2.1.320")).toEqual({ status: "recommended", why: "claude_context" })
    // The user's install on 2026-11-04: newer than the context version, older than the SDK's.
    expect(claude("2.1.282", "2.1.320")).toEqual({ status: "recommended", why: "claude_sdk" })
    expect(claude("2.1.301", "2.1.320")).toEqual({ status: "recommended", why: "newer" })
    expect(claude("2.1.320", "2.1.320")).toEqual({ status: "current" })
    // A newer one than the registry's (a pre-release channel) is current; no latest read is current too.
    expect(claude("2.1.330", "2.1.320")).toEqual({ status: "current" })
    expect(claude("2.1.301")).toEqual({ status: "current" })
  })

  test("Git: below 2.40 team mode refuses it, below 2.42 it makes full worktrees", () => {
    const git = (installed: string, latest: string | null = null) =>
      ToolUpdates.status({ found: true, installed, latest, thresholds: ToolUpdates.THRESHOLDS.git })
    expect(git("2.39.2.windows.1")).toEqual({ status: "required", why: "git_team" })
    expect(git("2.41.0.windows.1")).toEqual({ status: "recommended", why: "git_sparse" })
    expect(git("2.55.0.windows.3", "v2.55.0.windows.3")).toEqual({ status: "current" })
    expect(git("2.55.0.windows.3", "v2.56.0.windows.1")).toEqual({ status: "recommended", why: "newer" })
  })

  test("git-lfs below the hosts' pin has CVEs own's team mode can meet; gh has no threshold", () => {
    const lfs = ToolUpdates.status({
      found: true,
      installed: "3.7.1",
      latest: "v3.8.1",
      thresholds: ToolUpdates.THRESHOLDS["git-lfs"],
    })
    expect(lfs).toEqual({ status: "recommended", why: "lfs_security" })
    const gh = ToolUpdates.status({ found: true, installed: "2.101.0", latest: "v2.101.0", thresholds: [] })
    expect(gh).toEqual({ status: "current" })
  })
})

describe("ToolUpdates thresholds follow their sources", () => {
  test("Claude Code's minimum and context version are core's Claude Agent probe's", async () => {
    const probe = await read("packages/core/src/plugin/provider/claude-agent/claude/probe.ts")
    expect(/const MINIMUM_VERSION = "([^"]+)"/.exec(probe)?.[1]).toBe(ToolUpdates.CLAUDE_CODE.minimum)
    expect(/const CONTEXT_DISCOVERY_VERSION = "([^"]+)"/.exec(probe)?.[1]).toBe(ToolUpdates.CLAUDE_CODE.context)
  })

  test("the SDK's version is the Claude Code version in the manifest of the SDK core depends on", async () => {
    const core = await Bun.file(path.join(ROOT, "packages/core/package.json")).json()
    const pinned = core.devDependencies?.["@anthropic-ai/claude-agent-sdk"] ?? core.peerDependencies?.["@anthropic-ai/claude-agent-sdk"]
    const sdk = Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", path.join(ROOT, "packages/core"))
    expect((await Bun.file(sdk).json()).version).toBe(pinned)
    const manifest = await Bun.file(path.join(path.dirname(sdk), "manifest.json")).json()
    expect(manifest.version).toBe(ToolUpdates.CLAUDE_CODE.sdk)
  })

  test("git-lfs is the pin own uploads to SSH hosts, ripgrep core's download, github-mcp-server own's reviewed one", async () => {
    const native = await read("packages/own-remote/script/native.ts")
    expect(/export const GIT_LFS = \{\s*version: "([^"]+)"/.exec(native)?.[1]).toBe(ToolUpdates.HOST_GIT_LFS)
    const rg = await read("packages/core/src/ripgrep/binary.ts")
    expect(/const VERSION = "([^"]+)"/.exec(rg)?.[1]).toBe(ToolUpdates.RIPGREP_PIN)
    const reads = await read("packages/own-accounts/src/github/reads.ts")
    expect(reads).toContain(`"github-mcp-server ${ToolUpdates.GITHUB_MCP_REVIEWED}": [`)
  })

  test("every component has its thresholds and a release listing", () => {
    expect(Object.keys(ToolUpdates.THRESHOLDS).sort()).toEqual([...ToolUpdates.Component.literals].sort())
    expect(Object.keys(ToolUpdates.LATEST).sort()).toEqual([...ToolUpdates.Component.literals].sort())
    for (const thresholds of Object.values(ToolUpdates.THRESHOLDS))
      for (const threshold of thresholds) expect(ToolUpdates.parse(threshold.version)).toBeDefined()
  })
})

describe("tools.* methods", () => {
  const METHODS = [
    "tools.view",
    "tools.settings.set",
    "tools.update.plan",
    "tools.update.execute",
    "tools.update.status",
  ] as const

  test("are this PC's windows' alone, at the control Location, and a remote service refuses them", () => {
    for (const method of METHODS) {
      expect(OwnAccounts.MethodScope[method]).toBe("local")
      expect(OwnAccounts.MethodLocation[method]).toBe("control")
      expect(Object.keys(OwnAccounts.Definition.methods[method].errors)).toContain("remote_managed")
    }
  })

  test("the plan carries the exact command and its source; the file defaults to checks on", () => {
    const plan = OwnAccounts.Definition.methods["tools.update.plan"].output
    const decoded = Schema.decodeUnknownSync(plan)({
      nonce: "n".repeat(16),
      expiresAt: 1,
      component: "claude-code",
      command: "claude update",
      argv: ["C:\\Users\\me\\.local\\bin\\claude.exe", "update"],
      source: "https://docs.claude.com/en/docs/claude-code/setup",
      installed: "2.1.282",
      latest: "2.1.320",
    })
    expect(decoded.command).toBe("claude update")
    expect(ToolUpdates.defaults).toEqual({ version: 1, checkLatest: true, latest: {} })
    expect(Schema.decodeUnknownOption(ToolUpdates.PlanInput)({ component: "codex" })._tag).toBe("None")
  })
})
