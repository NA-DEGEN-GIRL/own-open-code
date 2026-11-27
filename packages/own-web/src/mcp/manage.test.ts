// 설정 > MCP 서버's management (03 §18.14, SM 2026-10-24): the rules are own-protocol's, a config file's servers by
// name only, where a row comes from (a phone's summary too), the form (its own scope kept on an edit, kept values left
// out, Code Mode, its checks), `JSON 붙여넣기`, the form of an MCP Registry entry, the persistent switch on this PC,
// and the page's sources keeping values out of the screen.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { ConfigEntry } from "@opencode/client"
import { Schema } from "effect"
import { McpRules, OwnMcp } from "@own/protocol"
import {
  codeModes,
  commandLine,
  elsewhere,
  emptyForm,
  ENV_NAME,
  exceptionTag,
  fileServers,
  fileTransport,
  formOf,
  globalRows,
  globalSwitch,
  HEADER_NAME,
  MAX_VALUE,
  NAME_PATTERN,
  parseServerJson,
  problems,
  registryForm,
  saveInput,
  scopeChoices,
  sourceOf,
  suggestName,
  summaryOf,
  toolNames,
  transportInput,
  withOwnErrors,
  type Form,
  type Override,
  type Server,
} from "./manage-model"
import { mcpManageEn, mcpManageKo } from "./manage-strings"
import { keeps } from "./store"

const ID = "mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6Y" as OwnMcp.ID
const PROJECT = "D:\\work\\game"

const document = (servers: Record<string, unknown>, file?: string): ConfigEntry =>
  ({ type: "document", ...(file ? { path: file } : {}), info: { mcp: { servers } } }) as ConfigEntry

const local = (overrides: Partial<Server> = {}): Server => ({
  id: ID,
  name: "github",
  scope: { type: "global" },
  transport: {
    type: "local",
    command: "npx",
    args: ["-y", "@example/github mcp"],
    env: [{ name: "GITHUB_TOKEN", hint: "…9fQ2" }, { name: "MODE" }],
  },
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
})

describe("rules", () => {
  test("the name, variable and header rules, the value limit and free names are own-protocol's McpRules", () => {
    expect(NAME_PATTERN).toBe(OwnMcp.NAME_PATTERN)
    expect(ENV_NAME).toBe(OwnMcp.ENV_NAME)
    expect(HEADER_NAME).toBe(OwnMcp.HEADER_NAME)
    expect(MAX_VALUE).toBe(OwnMcp.MAX_VALUE)
    expect(suggestName).toBe(McpRules.suggestName)
  })
})

describe("listed servers", () => {
  test("a config file's servers by name only: the last document wins, values never show", () => {
    const files = fileServers([
      document(
        { docs: { type: "remote", url: "https://old.example.test/mcp" } },
        "C:/Users/demo/.config/opencode.jsonc",
      ),
      document(
        {
          docs: { type: "remote", url: "https://docs.example.test/mcp?key=sk-secret-value", headers: { "X-Key": "v" } },
          files: {
            type: "local",
            command: ["node", "server.js", "--root", "C:/My Files"],
            environment: { TOKEN: "t" },
          },
        },
        "D:/work/game/opencode.json",
      ),
    ])
    expect(files).toEqual([
      {
        name: "docs",
        path: "D:/work/game/opencode.json",
        type: "remote",
        summary: "https://docs.example.test/mcp?key=••••",
        env: [],
        headers: ["X-Key"],
      },
      {
        name: "files",
        path: "D:/work/game/opencode.json",
        type: "local",
        summary: 'node server.js --root "C:/My Files"',
        env: ["TOKEN"],
        headers: [],
      },
    ])
    expect(JSON.stringify(files)).not.toContain("sk-secret-value")
    // A config file's server can be tested as it is (its values come from the config, never typed again).
    expect(
      fileTransport(
        [document({ files: { type: "local", command: ["node", "s.js"], environment: { A: "1" } } })],
        "files",
      ),
    ).toEqual({
      type: "local",
      command: "node",
      args: ["s.js"],
      env: [{ name: "A", value: "1" }],
    })
  })

  test("a config file's arguments and address show every value own would keep in the vault as ••••", () => {
    const token = "ghp_fakeOwnMcpToken0000000000Wx9z"
    const files = fileServers([
      document({
        gh: {
          type: "local",
          command: ["docker", "run", "-i", "--rm", "-e", `GITHUB_TOKEN=${token}`, "ghcr.io/github/github-mcp-server"],
        },
        bridge: {
          type: "local",
          command: [
            "npx",
            "mcp-remote",
            "https://x.example.test/mcp",
            "--header",
            "Authorization: Bearer fake-1",
            "--api-key",
            "k-2",
          ],
        },
        keyed: { type: "remote", url: `https://u:p@x.example.test/s/${token}/mcp?a=1&b=2` },
        plain: { type: "remote", url: "not a url" },
      }),
    ])
    expect(files.map((server) => server.summary)).toEqual([
      "docker run -i --rm -e GITHUB_TOKEN=•••• ghcr.io/github/github-mcp-server",
      'npx mcp-remote https://x.example.test/mcp --header "Authorization: Bearer ••••" --api-key ••••',
      "https://••••@x.example.test/s/••••/mcp?a=••••&b=••••",
      "not a url",
    ])
    for (const value of [token, "fake-1", "k-2", "u:p"]) expect(JSON.stringify(files)).not.toContain(value)
  })

  test("SM-25: two-argument headers, JSON arguments, `${VAR:-default}` and base64 path keys show as ••••", () => {
    const files = fileServers([
      document({
        proxy: {
          type: "local",
          command: [
            "uvx",
            "mcp-proxy",
            "--headers",
            "Authorization",
            "Bearer FAKE-VALUE-0001",
            "https://x.example.test/mcp",
          ],
        },
        json: { type: "local", command: ["npx", "srv", "--config", '{"apiKey":"FAKE-VALUE-0002","region":"eu"}'] },
        fallback: {
          type: "local",
          command: ["npx", "srv", "--api-key", "${API_KEY:-FAKE-VALUE-0003}", "${REGION:-eu}"],
        },
        b64: { type: "remote", url: "https://x.example.test/mcp/RkFLRS1WQUxVRS0wMDA0LWZha2U+Lw==" },
      }),
    ])
    expect(files.map((server) => server.summary)).toEqual([
      'uvx mcp-proxy --headers Authorization "Bearer ••••" https://x.example.test/mcp',
      'npx srv --config "{\\"apiKey\\":\\"••••\\",\\"region\\":\\"eu\\"}"',
      "npx srv --api-key ${API_KEY:-••••} ${REGION:-eu}",
      "https://x.example.test/mcp/••••",
    ])
    expect(JSON.stringify(files)).not.toContain("FAKE-VALUE")
    expect(JSON.stringify(files)).not.toContain("RkFLRS1WQUxVRS0wMDA0LWZha2U")
  })

  test("own's servers show own.accounts' masked error text, never core's; others keep theirs", () => {
    const rows = [
      { name: "keyed", status: "failed" as const, error: "bad token ghp_fake", codemode: true },
      { name: "quiet", status: "failed" as const, error: "bad token ghp_fake", codemode: true },
      { name: "docs", status: "failed" as const, error: "a config file's server", codemode: true },
    ]
    expect(
      withOwnErrors(rows, { names: ["keyed", "quiet"], errors: { keyed: "bad token ••••" } }).map((row) => row.error),
    ).toEqual(["bad token ••••", undefined, "a config file's server"])
    // Before own's servers are known, no error text shows.
    expect(withOwnErrors(rows, { names: "all" }).map((row) => row.error)).toEqual([undefined, undefined, undefined])
  })

  test("own's server wins over a config file's of the same name where its scope reaches", () => {
    const files = fileServers([document({ github: { type: "local", command: ["gh"] } })])
    const mine = local({ scope: { type: "project", directory: PROJECT } })
    expect(sourceOf("github", [mine], files, `${PROJECT}\\src`).type).toBe("own")
    expect(sourceOf("github", [mine], files, "D:\\work\\other").type).toBe("file")
    expect(sourceOf("browser", [mine], files, PROJECT).type).toBe("other")
    expect(elsewhere([mine, local({ name: "all" })], "D:\\work\\other").map((server) => server.name)).toEqual([
      "github",
    ])
  })

  test("a phone's summary: own's server by name still wins, without the config file's definition", () => {
    const files = fileServers([document({ github: { type: "local", command: ["gh", "--stdio"] } })])
    const summary = { name: "github", scope: { type: "project" as const, directory: PROJECT }, from: "codex" as const }
    const source = sourceOf("github", [summary], files, `${PROJECT}/src`)
    expect(source).toEqual({ type: "own", server: summary })
    expect(
      codeModes([summary, local({ name: "x", transport: { ...local().transport, codemode: false } })], PROJECT),
    ).toEqual({
      x: false,
    })
  })

  test("a row's definition: the command line, or the address with `?…` when its query is in the vault", () => {
    expect(summaryOf(local())).toBe('npx -y "@example/github mcp"')
    expect(
      summaryOf(
        local({
          transport: { type: "remote", url: "https://x.example.test/mcp", query: true, headers: [], oauth: true },
        }),
      ),
    ).toBe("https://x.example.test/mcp?…")
    expect(
      summaryOf(
        local({
          transport: {
            type: "remote",
            url: "https://x.example.test/s/••••/mcp",
            query: false,
            hidden: true,
            headers: [],
            oauth: true,
          },
        }),
      ),
    ).toBe("https://x.example.test/s/••••/mcp")
    expect(commandLine("C:/Program Files/x.exe", ["", 'a"b'])).toBe('"C:/Program Files/x.exe" "" "a\\"b"')
    expect(toolNames({ at: 0, ok: true, tools: ["a", "b", "c"].map((name) => ({ name })), more: true }, 2)).toEqual({
      shown: ["a", "b"],
      more: 2,
    })
  })
})

describe("the form", () => {
  test("a saved server's form names its values with hints and keeps them when left empty", () => {
    const form = formOf(local())
    expect(form.env).toEqual([
      { key: 0, name: "GITHUB_TOKEN", value: "", stored: { hint: "…9fQ2" } },
      { key: 1, name: "MODE", value: "", stored: {} },
    ])
    expect(problems(form)).toEqual([])
    const edited: Form = { ...form, env: [form.env[0]!, { key: 2, name: "EXTRA", value: "x" }] }
    expect(saveInput(edited)).toEqual({
      id: ID,
      name: "github",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: "npx",
        args: ["-y", "@example/github mcp"],
        env: [{ name: "GITHUB_TOKEN" }, { name: "EXTRA", value: "x" }],
      },
    })
  })

  test("an edit keeps the server's own project, whatever project the page shows; the picker changes it", () => {
    const game = local({ scope: { type: "project", directory: PROJECT } })
    const form = formOf(game)
    // The page shows another project (or none): the server stays in its own.
    expect(saveInput(form).scope).toEqual({ type: "project", directory: PROJECT })
    expect(scopeChoices(form, game.scope, "D:\\work\\other")).toEqual([
      { type: "global" },
      { type: "project", directory: PROJECT },
      { type: "project", directory: "D:\\work\\other" },
    ])
    expect(scopeChoices(form, game.scope, "d:/work/game")).toEqual([
      { type: "global" },
      { type: "project", directory: PROJECT },
    ])
    expect(scopeChoices(emptyForm(), undefined, undefined)).toEqual([{ type: "global" }])
    expect(saveInput({ ...form, scope: { type: "global" } }).scope).toEqual({ type: "global" })
  })

  test("Code Mode: default leaves it to core, on and off are sent", () => {
    const form = formOf(local({ transport: { ...local().transport, codemode: false } }))
    expect(form.codemode).toBe("off")
    expect(transportInput(form)).toMatchObject({ codemode: false })
    expect(transportInput({ ...form, codemode: "on" })).toMatchObject({ codemode: true })
    expect(transportInput({ ...form, codemode: "default" })).not.toHaveProperty("codemode")
  })

  test("checks names, commands, addresses, duplicates and values without a stored one", () => {
    const blank = emptyForm()
    expect(problems(blank)).toEqual(["name", "command"])
    expect(problems({ ...blank, name: "ok", command: "node", args: "--token\n${TOKEN}" })).toEqual(["reference"])
    // A reference with a default needs no environment value (SM-25).
    expect(problems({ ...blank, name: "ok", command: "node", args: "--region\n${REGION:-eu}" })).toEqual([])
    expect(
      problems({
        ...blank,
        name: "ok",
        command: "node",
        args: "--token\n${TOKEN}",
        env: [{ key: 1, name: "TOKEN", value: "t" }],
      }),
    ).toEqual([])
    expect(
      problems({
        ...blank,
        name: "ok",
        command: "node",
        env: [
          { key: 1, name: "1BAD", value: "x" },
          { key: 2, name: "A", value: "" },
          { key: 3, name: "A", value: "y" },
        ],
      }),
    ).toEqual(["envName", "envDuplicate", "envValue"])
    const remote: Form = { ...blank, name: "web", type: "remote", url: "ftp://x" }
    expect(problems(remote)).toEqual(["url"])
    expect(problems({ ...remote, url: "", storedURL: "https://x.example.test/mcp?…" })).toEqual([])
    expect(
      problems({
        ...remote,
        url: "https://x.example.test/mcp",
        headers: [
          { key: 1, name: "X-Key", value: "a" },
          { key: 2, name: "x-key", value: "b" },
        ],
      }),
    ).toEqual(["headerDuplicate"])
  })

  test("an edit of a URL server with a hidden query keeps the address unless a new one is typed", () => {
    const server = local({
      transport: { type: "remote", url: "https://x.example.test/mcp", query: true, headers: [], oauth: false },
    })
    const form = formOf(server)
    expect(form).toMatchObject({ type: "remote", url: "", storedURL: "https://x.example.test/mcp?…", oauth: false })
    expect(saveInput(form).transport).toEqual({ type: "remote", headers: [], oauth: false })
    const hidden = formOf(
      local({
        transport: {
          type: "remote",
          url: "https://x.example.test/s/••••/mcp",
          query: false,
          hidden: true,
          headers: [],
          oauth: true,
        },
      }),
    )
    expect(hidden).toMatchObject({ url: "", storedURL: "https://x.example.test/s/••••/mcp" })
  })
})

describe("찾아서 설치 (MCP Registry)", () => {
  const entry: OwnMcp.RegistryEntry = {
    name: "io.github.example/github",
    version: "1.4.0",
    publisher: "io.github.example",
    status: "active",
    suggested: "github",
    options: [
      {
        type: "package",
        registryType: "npm",
        identifier: "@example/github-mcp",
        version: "1.4.0",
        command: "npx",
        args: ["-y", "@example/github-mcp@1.4.0", "--api-key", "${API_KEY}", "{repo}"],
        env: [
          { name: "API_KEY", required: true, secret: true, description: "Your key" },
          { name: "GITHUB_HOST", required: false, secret: false, value: "github.com" },
          { name: "LOG_LEVEL", required: false, secret: false },
        ],
        fill: ["repo"],
      },
      {
        type: "remote",
        transport: "streamable-http",
        url: "https://mcp.example.test/{tenant}/mcp",
        headers: [{ name: "Authorization", required: true, secret: true, template: "Bearer {api_key}" }],
        variables: [{ name: "tenant", required: true, secret: false }],
        fill: ["tenant"],
      },
    ],
  }

  test("a package fills the command form; parts to fill and missing values keep it from being saved", () => {
    const form = registryForm(entry, entry.options[0]!)
    expect(form).toMatchObject({
      name: "github",
      scope: { type: "global" },
      type: "local",
      command: "npx",
      args: "-y\n@example/github-mcp@1.4.0\n--api-key\n${API_KEY}\n{repo}",
      fill: ["repo"],
      registry: { name: "io.github.example/github", version: "1.4.0" },
    })
    expect(form.env.map((row) => [row.name, row.value, !!row.optional, !!row.plain])).toEqual([
      ["API_KEY", "", false, false],
      ["GITHUB_HOST", "github.com", true, true],
      ["LOG_LEVEL", "", true, true],
    ])
    expect(problems(form)).toEqual(["fill", "envValue"])
    const filled: Form = {
      ...form,
      args: form.args.replace("{repo}", "example/game"),
      env: form.env.map((row) => (row.name === "API_KEY" ? { ...row, value: "k" } : row)),
    }
    expect(problems(filled)).toEqual([])
    // The optional value nobody filled in is left out; the registry entry goes with a new server.
    expect(saveInput(filled)).toMatchObject({
      registry: { name: "io.github.example/github", version: "1.4.0" },
      transport: {
        env: [
          { name: "API_KEY", value: "k" },
          { name: "GITHUB_HOST", value: "github.com" },
        ],
      },
    })
  })

  test("an entry without a version still gives a form that saves", () => {
    const form = registryForm({ ...entry, version: "" }, entry.options[1]!)
    expect(form.registry).toEqual({ name: "io.github.example/github" })
    const input = saveInput({ ...form, url: "https://mcp.example.test/acme/mcp", headers: [] })
    expect(input.registry).toEqual({ name: "io.github.example/github" })
    expect(Schema.decodeUnknownSync(OwnMcp.SaveInput)(input)).toMatchObject({
      registry: { name: "io.github.example/github" },
    })
  })

  test("a remote fills the address form with its `{parts}` and header forms", () => {
    const form = registryForm(entry, entry.options[1]!)
    expect(form).toMatchObject({ type: "remote", url: "https://mcp.example.test/{tenant}/mcp", fill: ["tenant"] })
    expect(form.headers[0]).toMatchObject({ name: "Authorization", value: "", template: "Bearer {api_key}" })
    expect(problems(form)).toEqual(["fill", "headerValue"])
  })
})

describe("JSON 붙여넣기", () => {
  test("Claude Code's and Cursor's mcpServers, the inner part alone, one entry and OpenCode's form", () => {
    const wrapped = parseServerJson(
      JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "t" } } },
      }),
    )
    expect(wrapped).toEqual({
      ok: true,
      servers: [
        {
          name: "github",
          form: {
            type: "local",
            command: "npx",
            args: "-y\ngh-mcp",
            cwd: "",
            url: "",
            oauth: true,
            env: [["GITHUB_TOKEN", "t"]],
            headers: [],
          },
        },
      ],
    })
    const inner = parseServerJson(
      '"web": { "url": "https://w.example.test/mcp", "headers": { "Authorization": "Bearer x" } },',
    )
    expect(inner.ok && inner.servers[0]).toMatchObject({
      name: "web",
      form: { type: "remote", url: "https://w.example.test/mcp", headers: [["Authorization", "Bearer x"]] },
    })
    const single = parseServerJson('{ "command": "uvx", "args": ["tool"] }')
    expect(single.ok && single.servers[0]).toMatchObject({ form: { type: "local", command: "uvx", args: "tool" } })
    expect(single.ok && single.servers[0]?.name).toBeUndefined()
    const opencode = parseServerJson(
      JSON.stringify({
        mcp: { servers: { fs: { type: "local", command: ["node", "fs.js"], environment: { ROOT: "/" } } } },
      }),
    )
    expect(opencode.ok && opencode.servers[0]).toMatchObject({
      name: "fs",
      form: { command: "node", args: "fs.js", env: [["ROOT", "/"]] },
    })
    expect(parseServerJson('{"mcpServers":{"old":{"type":"sse","url":"https://o.example.test/sse"}}}')).toEqual({
      ok: false,
      reason: "sse",
    })
    expect(parseServerJson("not json")).toEqual({ ok: false, reason: "json" })
    expect(parseServerJson('{"theme":"dark"}')).toEqual({ ok: false, reason: "empty" })
  })

  test("a pasted name is made valid and free", () => {
    expect(suggestName("my tools!", ["my-tools"])).toBe("my-tools-2")
    expect(suggestName(undefined, [])).toBe("server")
    expect(NAME_PATTERN.test(suggestName("@scope/pkg", []))).toBe(true)
  })
})

describe("switches global first (SG 2026-10-26)", () => {
  const SITE = "D:\\work\\site"
  const overrides: Override[] = [
    { name: "github", enabled: false },
    { directory: PROJECT, name: "github", enabled: true },
    // Inherits PROJECT's on: no tag of its own.
    { directory: `${PROJECT}\\sub`, name: "github", enabled: true },
    { directory: SITE, name: "docs", enabled: false },
    // Off where it is off anyway (the global switch): a repeat, never a tag of its own.
    { directory: SITE, name: "github", enabled: false },
  ]

  test("a project's tag: off here, on only here, off in every project; 되돌리기 deletes the deciding switch", () => {
    expect(exceptionTag(overrides, "github", PROJECT)).toEqual({ kind: "onlyHere", directory: PROJECT })
    expect(exceptionTag(overrides, "github", `${PROJECT}\\sub\\deeper`)).toEqual({
      kind: "onlyHere",
      directory: PROJECT,
    })
    expect(exceptionTag(overrides, "github", SITE)).toEqual({ kind: "offAll" })
    expect(exceptionTag(overrides, "github", "D:\\elsewhere")).toEqual({ kind: "offAll" })
    expect(exceptionTag(overrides, "docs", SITE)).toEqual({ kind: "offHere", directory: SITE })
    expect(exceptionTag(overrides, "docs", PROJECT)).toBeUndefined()
    expect(exceptionTag(overrides, "files", PROJECT)).toBeUndefined()
    // Off in the project again under its on: the deeper off decides.
    expect(
      exceptionTag(
        [...overrides, { directory: `${PROJECT}\\sub`, name: "docs", enabled: false }],
        "docs",
        `${PROJECT}\\sub`,
      ),
    ).toEqual({ kind: "offHere", directory: `${PROJECT}\\sub` })
  })

  test("모든 프로젝트: own's global servers with the global switch and the projects that differ", () => {
    const rows = globalRows(
      [local(), local({ name: "game", scope: { type: "project", directory: PROJECT } }), local({ name: "docs" })],
      overrides,
    )
    expect(rows.map((row) => [row.server.name, row.off, row.exceptions])).toEqual([
      ["github", true, { off: [], only: [PROJECT] }],
      ["docs", false, { off: [SITE], only: [] }],
    ])
    expect(globalSwitch(overrides, "github")).toBe(false)
    expect(globalSwitch(overrides, "docs")).toBeNull()
  })
})

describe("switch and strings", () => {
  test("the list's switch is kept on this PC's service only (own.accounts mcp.enable)", () => {
    const rpc = (allowed: boolean) => ({ allowed: () => allowed }) as never
    expect(keeps({ kind: "local", rpc: rpc(true) })).toBe(true)
    expect(keeps({ kind: "ssh", rpc: rpc(true) })).toBe(false)
    expect(keeps({ kind: "local", rpc: rpc(false) })).toBe(false)
  })

  test("every failure, problem, note, source and error has Korean and English text", () => {
    const keys = [
      ...OwnMcp.Failure.literals.map((value) => `own.mcpm.failure.${value}`),
      ...OwnMcp.Note.literals.map((value) => `own.mcpm.import.note.${value}`),
      ...OwnMcp.Problem.literals.map((value) => `own.mcpm.import.problem.${value}`),
      ...OwnMcp.Source.literals.map((value) => `own.mcpm.import.source.${value}`),
      ...OwnMcp.From.literals.map((value) => `own.mcpm.from.${value}`),
      ...OwnMcp.RegistryProblem.literals.map((value) => `own.mcpm.reg.problem.${value}`),
      ...["offline", "status", "invalid", "disabled"].map((value) => `own.mcpm.reg.failed.${value}`),
      ...["fill", "reference"].map((value) => `own.mcpm.editor.problem.${value}`),
      ...["default", "on", "off"].map((value) => `own.mcpm.editor.codemode.${value}`),
      ...["found", "missing", "unreadable", "invalid"].map((value) => `own.mcpm.import.file.${value}`),
      ...["mcp_name_taken", "mcp_secret_missing", "mcp_invalid", "mcp_not_found", "vault_unavailable"].map(
        (value) => `own.mcpm.error.${value}`,
      ),
    ] as (keyof typeof mcpManageKo)[]
    expect(keys.filter((key) => !mcpManageKo[key] || !mcpManageEn[key])).toEqual([])
  })

  test("value fields are password fields that never get a stored value back", async () => {
    const editor = await Bun.file(path.join(import.meta.dir, "editor.tsx")).text()
    // Only a value the MCP Registry says is not secret shows as text.
    expect(editor).toContain('type={row().plain ? "text" : "password"}')
    expect(editor).toContain('autocomplete="new-password"')
    // The pasted JSON (which may hold values) leaves its box once the form has it.
    expect(editor).toContain('setPasted("")')
    const settings = await Bun.file(path.join(import.meta.dir, "settings.tsx")).text()
    expect(settings).not.toMatch(/console\.(log|error)\([^)]*transport/)
  })

  test("every button that opens a dialog says so (aria-haspopup), so the layout audit opens it", async () => {
    const opens = async (file: string, ids: ReadonlyArray<string>) => {
      const source = await Bun.file(path.join(import.meta.dir, file)).text()
      return ids.filter((id) => {
        const at = source.indexOf(`data-testid="${id}"`)
        return at < 0 || !source.slice(source.lastIndexOf("<button", at), at).includes('aria-haspopup="dialog"')
      })
    }
    expect(
      await opens("settings.tsx", ["mcp-add", "mcp-import-open", "mcp-registry-find", "mcp-edit", "mcp-remove"]),
    ).toEqual([])
    expect(await opens("registry.tsx", ["mcp-registry-use"])).toEqual([])
    expect(await opens("../skills/settings.tsx", ["settings-skills-detail", "settings-skills-remove"])).toEqual([])
  })

  test("the page and the Ctrl+; dialog share one empty line", () => {
    expect(Object.keys(mcpManageKo)).not.toContain("own.mcpm.empty")
  })
})
