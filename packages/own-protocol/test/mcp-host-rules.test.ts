// MCP servers of this PC on an SSH host (04 §13 "MCP", MH): the analysis over real-world-shaped definitions (the shapes
// Claude Code, Codex, Cursor and the MCP Registry write), the translation to the host's definition and the hash.
import { describe, expect, test } from "bun:test"
import { McpHostRules } from "../src/mcp-host-rules"

const HOME = "C:\\Users\\demo"
const PROJECT = "D:\\work\\game"

const probe = (patch: Partial<McpHostRules.Probe> = {}): McpHostRules.Probe => ({
  at: 1,
  os: "linux",
  arch: "x64",
  home: "/home/build",
  runtimes: {
    node: { version: "v22.11.0" },
    npx: { version: "10.9.0" },
    uvx: { version: "uv 0.9.4" },
    docker: { version: "Docker version 27.3.1" },
  },
  containers: { docker: "ok" },
  binaries: {},
  ...patch,
})

function local(
  command: string,
  args: string[],
  extra: { env?: string[]; cwd?: string; name?: string } = {},
): McpHostRules.Source {
  return {
    key: `own:${extra.name ?? "s"}`,
    name: extra.name ?? "s",
    origin: "own",
    transport: {
      type: "local",
      command,
      args,
      env: extra.env ?? [],
      ...(extra.cwd ? { cwd: extra.cwd } : {}),
    },
  }
}

const analyze = (source: McpHostRules.Source, ...rest: [McpHostRules.Probe | undefined] | []) => {
  const p = rest.length === 0 ? probe() : rest[0]
  return McpHostRules.analyze(source, { home: HOME, project: PROJECT, ...(p ? { probe: p } : {}) })
}

const codes = (analysis: McpHostRules.Analysis) => analysis.reasons.map((reason) => reason.code)

describe("npx (npm packages)", () => {
  test("a plain npx server is ready, with its package and version", () => {
    const result = analyze(local("npx", ["-y", "@modelcontextprotocol/server-memory@2025.4.25"]))
    expect(result.result).toBe("ready")
    expect(result.runtime).toBe("npx")
    expect(result.package).toEqual({
      registry: "npm",
      name: "@modelcontextprotocol/server-memory",
      version: "2025.4.25",
    })
    expect(result.command).toBe("npx")
  })

  test("Windows' npx.cmd by its full path is still npx; the path is dropped", () => {
    const result = analyze(local("C:\\Program Files\\nodejs\\npx.cmd", ["-y", "mcp-server-time"]))
    expect(result.result).toBe("ready")
    expect(result.command).toBe("npx")
    expect(result.package).toEqual({ registry: "npm", name: "mcp-server-time" })
  })

  test("`cmd /c npx …` (Claude Code's Windows advice) is unwrapped", () => {
    const result = analyze(local("cmd", ["/c", "npx", "-y", "@upstash/context7-mcp@latest"]))
    expect(result.result).toBe("ready")
    expect(result.command).toBe("npx")
    expect(result.package?.name).toBe("@upstash/context7-mcp")
    expect(codes(result)).toContain("unwrapped")
    const host = McpHostRules.translate(local("cmd", ["/c", "npx", "-y", "@upstash/context7-mcp@latest"]), result)
    expect(host).toEqual({ type: "local", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], env: [] })
  })

  test("`npx -p pkg bin` and `--package=pkg` name the package, not the bin", () => {
    expect(analyze(local("npx", ["-y", "-p", "@scope/tools@1.2.0", "tools-mcp"])).package).toEqual({
      registry: "npm",
      name: "@scope/tools",
      version: "1.2.0",
    })
    expect(analyze(local("npx", ["--yes", "--package=docs-mcp", "docs"])).package?.name).toBe("docs-mcp")
  })

  test("a host without npx needs preparing", () => {
    const result = analyze(local("npx", ["-y", "mcp-server-time"]), probe({ runtimes: {} }))
    expect(result.result).toBe("prepare")
    expect(result.needs).toEqual(["npx"])
  })

  test("without a probe the runtime is unknown", () => {
    expect(analyze(local("npx", ["-y", "x"]), undefined).result).toBe("unknown")
  })

  test("the filesystem server's folders map to the host's home and project", () => {
    const source = local("npx", [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "C:\\Users\\demo\\projects",
      "D:\\work\\game\\docs",
    ])
    const result = analyze(source)
    expect(result.result).toBe("ready")
    expect(result.args.map((arg) => arg.kind)).toEqual(["plain", "plain", "home", "project"])
    expect(McpHostRules.translate(source, result)).toMatchObject({
      args: ["-y", "@modelcontextprotocol/server-filesystem", "~/projects", "./docs"],
    })
    expect(codes(result)).toContain("mapped")
  })

  test("a path elsewhere on this PC needs a host value; with it the server installs", () => {
    const source = local("npx", ["-y", "@modelcontextprotocol/server-filesystem", "E:\\shared\\assets"])
    const result = analyze(source)
    expect(result.result).toBe("assist")
    expect(result.reasons).toContainEqual({ code: "host_value", args: [2] })
    expect(McpHostRules.translate(source, result)).toBeUndefined()
    expect(McpHostRules.translate(source, result, { args: { 2: "/srv/assets" } })).toMatchObject({
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/assets"],
    })
  })

  test("`--root=C:\\Users\\demo\\notes` maps the value after `=`", () => {
    const source = local("npx", ["-y", "notes-mcp", "--root=C:\\Users\\demo\\notes"])
    const result = analyze(source)
    expect(result.args[2]).toEqual({ text: "--root=C:\\Users\\demo\\notes", kind: "home", host: "--root=~/notes" })
  })

  test("a localhost address in an argument means this PC: a host value", () => {
    const result = analyze(local("npx", ["-y", "mcp-remote", "http://localhost:3845/sse"]))
    expect(result.result).toBe("assist")
    expect(result.args[2]!.kind).toBe("host")
  })

  test("values: `${NAME}` references and secret names are secrets; each waits for the send step", () => {
    const result = analyze(
      local("npx", ["-y", "@example/github-mcp", "--api-key", "${API_KEY}"], {
        env: ["API_KEY", "MODE", "GITHUB_TOKEN"],
      }),
    )
    expect(result.result).toBe("ready")
    expect(result.values).toEqual([
      { name: "API_KEY", kind: "env", secret: true },
      { name: "MODE", kind: "env", secret: false },
      { name: "GITHUB_TOKEN", kind: "env", secret: true },
    ])
    expect(result.args[3]!.kind).toBe("reference")
    expect(result.reasons).toContainEqual({ code: "values", names: ["API_KEY", "MODE", "GITHUB_TOKEN"] })
  })
})

describe("uvx, uv, pipx (PyPI)", () => {
  test("uvx with a pinned version", () => {
    const result = analyze(local("uvx", ["mcp-server-fetch==2025.1.17"]))
    expect(result).toMatchObject({ result: "ready", runtime: "uvx", command: "uvx" })
    expect(result.package).toEqual({ registry: "pypi", name: "mcp-server-fetch", version: "2025.1.17" })
  })

  test("uvx --from git or a package with an extra", () => {
    expect(analyze(local("uvx", ["--from", "awslabs.aws-docs-mcp-server@latest", "aws-docs"])).package).toEqual({
      registry: "pypi",
      name: "awslabs.aws-docs-mcp-server",
      version: "latest",
    })
    expect(analyze(local("uvx", ["mcp-server-git[cli]"])).package?.name).toBe("mcp-server-git")
  })

  test("uvx on a host with uv alone runs as `uv tool run` (build-host's uv put no uvx on PATH)", () => {
    const source = local("uvx", ["mcp-server-fetch==2025.1.17"])
    const uvOnly = probe({ runtimes: { uv: { version: "uv 0.12.19" } } })
    const result = analyze(source, uvOnly)
    expect(result.result).toBe("ready")
    expect(McpHostRules.translate(source, result, { probe: uvOnly })).toEqual({
      type: "local",
      command: "uv",
      args: ["tool", "run", "mcp-server-fetch==2025.1.17"],
      env: [],
    })
  })

  test("uvx on a host without uv needs preparing", () => {
    const result = analyze(local("uvx", ["mcp-server-fetch"]), probe({ runtimes: { node: {}, npx: {} } }))
    expect(result.result).toBe("prepare")
    expect(result.needs).toEqual(["uvx"])
  })

  test("`uv tool run pkg` is a package; `uv run` of a project folder needs the AI", () => {
    expect(analyze(local("uv", ["tool", "run", "mcp-server-time"]), probe({ runtimes: { uv: {} } }))).toMatchObject({
      result: "ready",
      package: { registry: "pypi", name: "mcp-server-time" },
    })
    const project = analyze(
      local("uv", ["--directory", "C:\\tools\\weather", "run", "weather.py"]),
      probe({ runtimes: { uv: {} } }),
    )
    expect(project.result).toBe("assist")
    expect(codes(project)).toContain("uv_project")
    expect(codes(project)).toContain("host_value")
  })

  test("pipx run", () => {
    expect(analyze(local("pipx", ["run", "mcp-server-sqlite"]), probe({ runtimes: { pipx: {} } }))).toMatchObject({
      result: "ready",
      package: { registry: "pypi", name: "mcp-server-sqlite" },
    })
  })
})

describe("python and node scripts", () => {
  test("a python script of this PC must come along: AI help", () => {
    const result = analyze(local("python", ["C:\\Users\\demo\\mcp\\server.py"]), probe({ runtimes: { python: {} } }))
    expect(result.result).toBe("assist")
    expect(result.runtime).toBe("script")
    expect(result.reasons).toContainEqual({ code: "script", path: "C:\\Users\\demo\\mcp\\server.py" })
  })

  test("`python -m module` needs the module installed on the host: AI help", () => {
    const result = analyze(local("py", ["-m", "mcp_server_time"]), probe({ runtimes: { python: {} } }))
    expect(result.result).toBe("assist")
    expect(result.reasons).toContainEqual({ code: "python_module", module: "mcp_server_time" })
  })

  test("node with an absolute script path", () => {
    const result = analyze(local("node", ["E:\\mcp\\build\\index.js"]))
    expect(result.result).toBe("assist")
    expect(result.args[0]!.kind).toBe("host")
  })
})

describe("docker and podman (OCI)", () => {
  test("docker run with env names and an image tag", () => {
    const result = analyze(
      local(
        "docker",
        ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server:v0.20.1"],
        {
          env: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        },
      ),
    )
    expect(result.result).toBe("ready")
    expect(result.package).toEqual({ registry: "oci", name: "ghcr.io/github/github-mcp-server", version: "v0.20.1" })
  })

  test("docker without access (needs sudo) needs preparing, never sudo", () => {
    const result = analyze(
      local("docker", ["run", "-i", "--rm", "mcp/time"]),
      probe({ runtimes: { docker: { version: "Docker version 27" } }, containers: { docker: "denied" } }),
    )
    expect(result.result).toBe("prepare")
    expect(result.reasons).toContainEqual({ code: "container_denied", runtime: "docker" })
  })

  test("a Windows volume maps its host side", () => {
    const source = local("docker", [
      "run",
      "-i",
      "--rm",
      "-v",
      "C:\\Users\\demo\\data:/data",
      "mcp/filesystem",
      "/data",
    ])
    const result = analyze(source, probe({ runtimes: { docker: {} } }))
    expect(result.args[4]).toEqual({ text: "C:\\Users\\demo\\data:/data", kind: "home", host: "~/data:/data" })
    expect(McpHostRules.hostPath("~/data:/data", "/home/build")).toBe("/home/build/data:/data")
  })
})

describe("bun and deno", () => {
  test("bunx on a host without bun runs with the host's own bundled bun", () => {
    const own = probe({
      runtimes: {},
      ownBun: { command: "/home/build/.local/share/own-open-code/app/current/opencode" },
    })
    const source = local("bunx", ["tiny-mcp@1.0.0"])
    const result = analyze(source, own)
    expect(result.result).toBe("ready")
    expect(codes(result)).toContain("own_bun")
    expect(McpHostRules.translate(source, result, { probe: own })).toEqual({
      type: "local",
      command: "/home/build/.local/share/own-open-code/app/current/opencode",
      args: ["x", "tiny-mcp@1.0.0"],
      env: [],
      fixed: { BUN_BE_BUN: "1" },
    })
  })

  test("a bun script of this PC needs the AI (or a host path)", () => {
    const own = probe({ runtimes: {}, ownBun: { command: "/opt/own/opencode" } })
    const source = local("bun", ["C:\\work\\tiny-mcp.ts"])
    const result = analyze(source, own)
    expect(result.result).toBe("assist")
    expect(McpHostRules.translate(source, result, { probe: own, args: { 0: "/home/build/tiny-mcp.ts" } })).toEqual({
      type: "local",
      command: "/opt/own/opencode",
      args: ["/home/build/tiny-mcp.ts"],
      env: [],
      fixed: { BUN_BE_BUN: "1" },
    })
  })

  test("a host's own bun on PATH wins over the bundled one", () => {
    const both = probe({ runtimes: { bun: { version: "1.4.4" } }, ownBun: { command: "/opt/own/opencode" } })
    const source = local("bunx", ["tiny-mcp"])
    expect(McpHostRules.translate(source, analyze(source, both), { probe: both })).toMatchObject({
      command: "bunx",
      args: ["tiny-mcp"],
    })
  })

  test("deno run npm:/jsr:", () => {
    expect(
      analyze(local("deno", ["run", "-A", "npm:@example/mcp@2.0.0"]), probe({ runtimes: { deno: {} } })),
    ).toMatchObject({
      result: "ready",
      package: { registry: "npm", name: "@example/mcp", version: "2.0.0" },
    })
    expect(analyze(local("deno", ["run", "-A", "jsr:@std/mcp"]), probe({ runtimes: {} })).result).toBe("prepare")
  })
})

describe("this PC only", () => {
  test("an absolute Windows program", () => {
    const result = analyze(local("C:\\Tools\\my-mcp\\my-mcp.exe", ["--stdio"]))
    expect(result.result).toBe("pc-only")
    expect(result.reasons).toContainEqual({ code: "windows_program", command: "C:\\Tools\\my-mcp\\my-mcp.exe" })
    expect(McpHostRules.translate(local("C:\\Tools\\my-mcp\\my-mcp.exe", []), result)).toBeUndefined()
  })

  test("PowerShell and batch scripts", () => {
    expect(analyze(local("powershell", ["-File", "C:\\mcp\\run.ps1"])).result).toBe("pc-only")
    expect(analyze(local("run-mcp.bat", [])).result).toBe("pc-only")
  })

  test("a server that drives Windows itself", () => {
    const result = analyze(local("uvx", ["windows-mcp"]))
    expect(result.result).toBe("pc-only")
    expect(result.reasons).toContainEqual({ code: "windows_resource", name: "windows-mcp" })
  })

  test("a remote address on this PC's localhost", () => {
    const result = McpHostRules.analyze(
      {
        key: "own:fig",
        name: "figma",
        origin: "own",
        transport: { type: "remote", url: "http://127.0.0.1:3845/mcp", query: false, headers: [], oauth: false },
      },
      { home: HOME },
    )
    expect(result.result).toBe("pc-only")
  })
})

describe("remote addresses", () => {
  test("an address with headers is ready; its header values wait for the send step", () => {
    const source: McpHostRules.Source = {
      key: "own:ctx",
      name: "context7",
      origin: "own",
      transport: {
        type: "remote",
        url: "https://mcp.context7.com/mcp",
        query: true,
        headers: ["CONTEXT7_API_KEY", "Accept"],
        oauth: false,
      },
    }
    const result = McpHostRules.analyze(source, { home: HOME })
    expect(result.result).toBe("ready")
    expect(result.values).toEqual([
      { name: "CONTEXT7_API_KEY", kind: "header", secret: true },
      { name: "Accept", kind: "header", secret: false },
      { name: "URL", kind: "address", secret: true },
    ])
    expect(McpHostRules.translate(source, result)).toEqual({
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      query: true,
      headers: ["CONTEXT7_API_KEY", "Accept"],
      oauth: false,
    })
  })

  test("an OAuth server is noted (the sign-in happens on the host)", () => {
    const result = McpHostRules.analyze(
      {
        key: "file:linear",
        name: "linear",
        origin: "file",
        transport: { type: "remote", url: "https://mcp.linear.app/mcp", query: false, headers: [], oauth: true },
      },
      { home: HOME },
    )
    expect(result.result).toBe("ready")
    expect(codes(result)).toContain("oauth")
  })
})

describe("plain programs", () => {
  test("a program found on the host's PATH is ready, else the AI helps", () => {
    const source = local("github-mcp-server", ["stdio"], { env: ["GITHUB_PERSONAL_ACCESS_TOKEN"] })
    expect(analyze(source, probe({ binaries: { "github-mcp-server": true } })).result).toBe("ready")
    const missing = analyze(source, probe({ binaries: { "github-mcp-server": false } }))
    expect(missing.result).toBe("assist")
    expect(missing.binaries).toEqual(["github-mcp-server"])
    expect(analyze(source, undefined).binaries).toEqual(["github-mcp-server"])
  })

  test("a Windows working folder needs a host value", () => {
    const result = analyze(local("npx", ["-y", "x"], { cwd: "E:\\elsewhere" }))
    expect(result.result).toBe("assist")
    expect(codes(result)).toContain("cwd_host_value")
    const home = analyze(local("npx", ["-y", "x"], { cwd: "C:\\Users\\demo\\mcp" }))
    expect(McpHostRules.translate(local("npx", ["-y", "x"], { cwd: "C:\\Users\\demo\\mcp" }), home)).toMatchObject({
      cwd: "~/mcp",
    })
  })
})

describe("hash and host paths", () => {
  test("the hash names the definition, values by name only; any change shows", () => {
    const a = local("npx", ["-y", "a"], { env: ["B", "A"] })
    const b = local("npx", ["-y", "a"], { env: ["A", "B"] })
    expect(McpHostRules.hash(a)).toBe(McpHostRules.hash(b))
    expect(McpHostRules.hash(a)).toMatch(/^[0-9a-f]{16}$/)
    expect(McpHostRules.hash(local("npx", ["-y", "a@2"], { env: ["A", "B"] }))).not.toBe(McpHostRules.hash(a))
    expect(McpHostRules.hash({ ...a, name: "renamed" })).not.toBe(McpHostRules.hash(a))
  })

  test("`~` resolves against the host's home", () => {
    expect(McpHostRules.hostPath("~", "/home/u")).toBe("/home/u")
    expect(McpHostRules.hostPath("~/x/y", "/home/u/")).toBe("/home/u/x/y")
    expect(McpHostRules.hostPath("--root=~/notes", "/home/u")).toBe("--root=/home/u/notes")
    expect(McpHostRules.hostPath("a~b", "/home/u")).toBe("a~b")
  })
})

describe("the AI's brief", () => {
  test("a value that is not a secret may be set for the host in `fixed`; a secret comes from the PC (llm-router)", () => {
    const source = local("node", ["D:\projects\llm-router-mcp\bin\llm-router-mcp.js"], {
      env: ["LLM_ROUTER_MCP_STATE_DIR"],
      name: "llm-router",
    })
    const analysis = McpHostRules.analyze(source, { home: HOME, probe: probe() })
    expect(analysis.result).toBe("assist")
    expect(analysis.values).toEqual([{ name: "LLM_ROUTER_MCP_STATE_DIR", kind: "env", secret: false }])
    const input = { host: "build-host", source, analysis, probe: probe(), shown: "node …", tool: McpHostRules.TOOL }
    const ko = McpHostRules.brief({ ...input, locale: "ko" })
    expect(ko).toContain("LLM_ROUTER_MCP_STATE_DIR (비밀 아님: 이 호스트에 맞게 정해도 됨)")
    expect(ko).toContain("(command, args, cwd, fixed)")
    expect(ko).not.toContain("비밀 값은 사용자가 PC에서 따로 보내야")
    const en = McpHostRules.brief({ ...input, locale: "en" })
    expect(en).toContain("LLM_ROUTER_MCP_STATE_DIR (not a secret: may be set for this host)")
    const github = local("npx", ["-y", "@example/github-mcp"], { env: ["GITHUB_TOKEN"], name: "github" })
    const secret = McpHostRules.brief({
      ...input,
      locale: "ko",
      source: github,
      analysis: McpHostRules.analyze(github, { home: HOME, probe: probe() }),
    })
    expect(secret).toContain("GITHUB_TOKEN (비밀)")
    expect(secret).toContain("비밀 값은 사용자가 PC에서 따로 보내야 서버가 켜져요.")
  })
})
