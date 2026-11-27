// McpSecrets (03 §18.14, SM-15, SM-22): the values hiding in a server's arguments and address, found alike by
// own.accounts (moved into the vault as `${NAME}`) and own-web (a config file's server shown with `••••`). Fake values.
import { describe, expect, test } from "bun:test"
import { McpDsn, McpJson, McpRules, McpSecrets } from "../src/index.js"

const GHP = "ghp_fakeOwnMcpToken0000000000Wx9z"
const BEARER = "fakeBearerValue0000aaaa1111bbbb"
const KEY = "sk-fake0000aaaa1111bbbb2222"
/** 20 characters, no known prefix: a key only by its place. */
const PLAIN_TOKEN = "FAKE0VALUE0001xYz9Qa"
/** Fake base64 with `+` and `=` padding, and with `+` inside and no padding. */
const B64 = "RkFLRS1WQUxVRS0wMDAxLWZha2U+Lw=="
const B64_PLUS = "RkFLRS1WQUxVRS0+MDAwMi1mYWtlLXZhbHVl"

const lifted = (args: string[], command = "npx") => McpSecrets.lift(command, args, {})

describe("McpSecrets.lift", () => {
  test("environment pairs: after -e/--env always, elsewhere when the name looks secret", () => {
    const docker = lifted(
      ["run", "-i", "--rm", "-e", `GITHUB_PERSONAL_ACCESS_TOKEN=${GHP}`, "-e", "PLAIN", "ghcr.io/github/github-mcp-server"],
      "docker",
    )
    expect(docker.args).toEqual([
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN}",
      "-e",
      "PLAIN",
      "ghcr.io/github/github-mcp-server",
    ])
    expect(docker.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: GHP })
    expect(lifted(["--env", "REGION=eu", "--env=API_KEY=k-1"]).args).toEqual(["--env", "REGION=${REGION}", "--env=API_KEY=${API_KEY}"])
    const bare = lifted([`OPENAI_API_KEY=${BEARER}`, "MODE=ro", "TOKEN_FILE=/run/token", "DATABASE_URL=postgres://u:pw@db/app"])
    expect(bare.args).toEqual([
      "OPENAI_API_KEY=${OPENAI_API_KEY}",
      "MODE=ro",
      "TOKEN_FILE=/run/token",
      "DATABASE_URL=postgres://${URL_USERINFO}@db/app",
    ])
    expect(bare.env).toEqual({ OPENAI_API_KEY: BEARER, URL_USERINFO: "u:pw" })
  })

  test("header arguments: after --header/-H, and any `Name: value` whose name looks secret; the scheme stays", () => {
    expect(
      lifted([
        "mcp-remote",
        "https://x.example.test/mcp",
        "--header",
        `Authorization: Bearer ${BEARER}`,
        "-H",
        `Authorization:Bearer ${GHP}`,
        `--header=X-Team: own ${KEY}`,
        `x-api-key: ${BEARER}`,
        "Cookie: session=abc",
        "Content-Type: application/json",
        "C:/work",
      ]).args,
    ).toEqual([
      "mcp-remote",
      "https://x.example.test/mcp",
      "--header",
      "Authorization: Bearer ${AUTHORIZATION}",
      "-H",
      "Authorization:Bearer ${AUTHORIZATION_2}",
      "--header=X-Team: own ${SECRET}",
      "x-api-key: ${AUTHORIZATION}",
      "Cookie: ${COOKIE}",
      "Content-Type: application/json",
      "C:/work",
    ])
  })

  test("addresses in arguments: user info, key-like path segments and every query value", () => {
    const result = lifted([
      "mcp-remote",
      `https://x.example.test/s/${BEARER}/mcp?api_key=${KEY}&mode=ro&flag`,
      "postgresql://admin:secret1@db.example.test:5432/app",
      "https://plain.example.test/v1/mcp",
    ])
    expect(result.args).toEqual([
      "mcp-remote",
      "https://x.example.test/s/${URL_KEY}/mcp?api_key=${URL_API_KEY}&mode=${URL_MODE}&flag",
      "postgresql://${URL_USERINFO}@db.example.test:5432/app",
      "https://plain.example.test/v1/mcp",
    ])
    expect(result.env).toEqual({ URL_KEY: BEARER, URL_API_KEY: KEY, URL_MODE: "ro", URL_USERINFO: "admin:secret1" })
    // Every value comes back exactly as written when the server starts.
    expect(result.args.map((arg) => McpRules.expand(arg, result.env))).toEqual([
      "mcp-remote",
      `https://x.example.test/s/${BEARER}/mcp?api_key=${KEY}&mode=ro&flag`,
      "postgresql://admin:secret1@db.example.test:5432/app",
      "https://plain.example.test/v1/mcp",
    ])
  })

  test("value flags in any spelling; short flags only for a known tool", () => {
    expect(
      lifted(["--access-token", "a-1", "--apiKey", "b-2", "--oauth2Bearer", "c-3", "--authtoken", "d-4", "-token", "e-5"]).args,
    ).toEqual(["--access-token", "${ACCESS_TOKEN}", "--apiKey", "${API_KEY}", "--oauth2Bearer", "${OAUTH2_BEARER}", "--authtoken", "${AUTHTOKEN}", "-token", "${TOKEN}"])
    expect(lifted(["--token", "-abcdef1234", "--max-tokens", "100", "--no-auth", "x"]).args).toEqual([
      "--token",
      "${TOKEN}",
      "--max-tokens",
      "100",
      "--no-auth",
      "x",
    ])
    // `-t` is a transport here and `-k` an option of an unknown tool: they stay.
    expect(lifted(["gitea-mcp", "-t", "stdio", "-k", BEARER]).args).toEqual(["gitea-mcp", "-t", "stdio", "-k", BEARER])
    expect(lifted(["-y", "vercel@latest", "-t", BEARER]).args).toEqual(["-y", "vercel@latest", "-t", "${TOKEN}"])
    expect(McpSecrets.lift("C:\\Python\\Scripts\\openai.exe", ["-k", BEARER], {}).args).toEqual(["-k", "${API_KEY}"])
  })

  test("a known key inside a longer argument: only that part moves", () => {
    // SM-27: `key=…;mode=ro` is a connection string of two parts, so its secret part moves under its own name.
    const result = lifted([`--config=key=${GHP};mode=ro`, `token:${KEY}`, `prefix-${GHP}`])
    expect(result.args).toEqual(["--config=key=${KEY};mode=ro", "token:${TOKEN}", "prefix-${KEY}"])
    expect(lifted(["sk-learn-tools-mcp", "mask-ghp_", "xghp_fakeOwnMcpToken0000000000Wx9z"]).moved).toBe(false)
  })

  test("SM-25: mcp-proxy's two-argument header form moves the value of a secret-looking name", () => {
    const result = lifted(
      ["mcp-proxy", "--headers", "Authorization", `Bearer ${BEARER}`, "-H", "X-Api-Key", PLAIN_TOKEN, "-H", "Accept", "application/json", "https://h.example.test/mcp"],
      "uvx",
    )
    expect(result.args).toEqual([
      "mcp-proxy",
      "--headers",
      "Authorization",
      "Bearer ${AUTHORIZATION}",
      "-H",
      "X-Api-Key",
      "${X_API_KEY}",
      "-H",
      "Accept",
      "application/json",
      "https://h.example.test/mcp",
    ])
    expect(result.env).toEqual({ AUTHORIZATION: BEARER, X_API_KEY: PLAIN_TOKEN })
    // A flag after the name is no value, and the next argument is read as usual.
    expect(lifted(["--headers", "Authorization", "--verbose", "Authorization: Bearer x"]).args).toEqual([
      "--headers",
      "Authorization",
      "--verbose",
      "Authorization: Bearer ${AUTHORIZATION}",
    ])
    expect(McpSecrets.maskArgs("mcp-proxy", ["--headers", "Authorization", `Bearer ${BEARER}`])).toEqual([
      "--headers",
      "Authorization",
      "Bearer ••••",
    ])
  })

  test("SM-25: a JSON object argument moves the texts of secret-looking fields and stays JSON", () => {
    const tricky = 'Fa"ke\\Value0000'
    const result = lifted([
      "--config",
      JSON.stringify({ apiKey: PLAIN_TOKEN, region: "eu", nested: { headers: { Authorization: `Bearer ${BEARER}` } } }),
      `--settings=${JSON.stringify({ password: tricky, port: 8080, tags: ["a"] })}`,
      `{"token": "${GHP}", "note": "plain"}`,
      '{"apiKey": ""}',
      "{not json",
    ])
    expect(result.args).toEqual([
      "--config",
      '{"apiKey":"${API_KEY}","region":"eu","nested":{"headers":{"Authorization":"Bearer ${AUTHORIZATION}"}}}',
      '--settings={"password":"${PASSWORD}","port":8080,"tags":["a"]}',
      // SM-26: rewritten in place, the spacing as written.
      '{"token": "${TOKEN}", "note": "plain"}',
      '{"apiKey": ""}',
      "{not json",
    ])
    // Put back, every argument is the same JSON as written.
    const back = result.args.map((arg) => McpRules.expand(arg, result.env))
    expect(JSON.parse(back[1]!)).toEqual({ apiKey: PLAIN_TOKEN, region: "eu", nested: { headers: { Authorization: `Bearer ${BEARER}` } } })
    expect(JSON.parse(back[2]!.slice("--settings=".length))).toEqual({ password: tricky, port: 8080, tags: ["a"] })
    expect(JSON.parse(back[3]!)).toEqual({ token: GHP, note: "plain" })
    expect(McpSecrets.maskArgs("npx", ["--config", `{"apiKey":"${PLAIN_TOKEN}","region":"eu"}`])).toEqual([
      "--config",
      '{"apiKey":"••••","region":"eu"}',
    ])
    // Lifting again changes nothing.
    expect(McpSecrets.lift("npx", result.args, result.env)).toEqual({ ...result, moved: false })
  })

  test("SM-25: `${VAR:-default}` and `${VAR}literal`: literal parts and value defaults move, the server gets them back", () => {
    const result = McpSecrets.lift(
      "npx",
      [
        "--api-key",
        `\${API_KEY:-${PLAIN_TOKEN}}`,
        "--token",
        `\${PREFIX}${BEARER}`,
        `SECRET_TOKEN=\${T:-${KEY}}`,
        "--password",
        "${STORED:-unused-default}",
        "--region",
        "${REGION:-eu}",
        `--note=\${N:-${GHP}}`,
        `--other=\${PREFIX}-${GHP}`,
      ],
      { PREFIX: "pre-", STORED: "stored-value" },
    )
    expect(result.args).toEqual([
      "--api-key",
      "${API_KEY}",
      "--token",
      "${PREFIX}${TOKEN}",
      "SECRET_TOKEN=${T}",
      "--password",
      "${STORED}",
      "--region",
      "${REGION:-eu}",
      "--note=${N}",
      "--other=${PREFIX}-${N}",
    ])
    expect(result.env).toEqual({ PREFIX: "pre-", STORED: "stored-value", API_KEY: PLAIN_TOKEN, TOKEN: BEARER, T: KEY, N: GHP })
    expect(result.args.map((arg) => McpRules.expand(arg, result.env))).toEqual([
      "--api-key",
      PLAIN_TOKEN,
      "--token",
      `pre-${BEARER}`,
      `SECRET_TOKEN=${KEY}`,
      "--password",
      "stored-value",
      "--region",
      "eu",
      `--note=${GHP}`,
      `--other=pre--${GHP}`,
    ])
    expect(McpSecrets.lift("npx", result.args, result.env)).toEqual({ ...result, moved: false })
    expect(McpSecrets.maskArgs("npx", ["--api-key", `\${API_KEY:-${PLAIN_TOKEN}}`, "--token", `\${PREFIX}${BEARER}`, "${REGION:-eu}"])).toEqual([
      "--api-key",
      "${API_KEY:-••••}",
      "--token",
      "${PREFIX}••••",
      "${REGION:-eu}",
    ])
  })

  test("SM-25: known keys beside `${VAR}` move too: pairs, headers, query values and user info", () => {
    const result = lifted([
      `MODE=\${M}-${GHP}`,
      `X-Team: \${T} ${KEY}`,
      `https://\${USER}:${BEARER}@h.example.test/mcp?k=\${K}&key=pre\${K}post`,
    ])
    expect(result.args).toEqual([
      "MODE=${M}-${SECRET}",
      "X-Team: ${T} ${SECRET_2}",
      "https://${USER}${URL_USERINFO}@h.example.test/mcp?k=${K}&key=${URL_KEY}${K}${URL_KEY_2}",
    ])
    expect(result.env).toEqual({ SECRET: GHP, SECRET_2: KEY, URL_USERINFO: `:${BEARER}`, URL_KEY: "pre", URL_KEY_2: "post" })
  })

  test("SM-25: base64 path segments (`+`, `=` padding), also beside `${VAR}` and as a default", () => {
    const result = lifted([
      `https://h.example.test/mcp/${B64}`,
      `https://h.example.test/mcp/${B64_PLUS}/x`,
      `https://h.example.test/\${TENANT}/${B64}`,
      `https://h.example.test/mcp/\${K:-${B64}}`,
      `https://h.example.test/mcp/\${K2:-dGhp/${B64}}/tools`,
      `https://h.example.test/mcp/\${K3:-${PLAIN_TOKEN}}`,
      "https://h.example.test/mcp/c++/v1.2.3+build/a=b",
    ])
    expect(result.args).toEqual([
      "https://h.example.test/mcp/${URL_KEY}",
      "https://h.example.test/mcp/${URL_KEY_2}/x",
      "https://h.example.test/${TENANT}/${URL_KEY}",
      "https://h.example.test/mcp/${URL_KEY}",
      "https://h.example.test/mcp/${K2}/tools",
      "https://h.example.test/mcp/${K3}",
      "https://h.example.test/mcp/c++/v1.2.3+build/a=b",
    ])
    expect(result.env).toEqual({ URL_KEY: B64, URL_KEY_2: B64_PLUS, K2: `dGhp/${B64}`, K3: PLAIN_TOKEN })
  })

  test("lifting again changes nothing: references stay, an equal value keeps its name", () => {
    const once = McpSecrets.lift("npx", ["--token", GHP, "-e", `API_KEY=${BEARER}`, `https://h.example.test/mcp?k=${BEARER}`], {
      GITHUB_TOKEN: GHP,
    })
    expect(once.args).toEqual(["--token", "${GITHUB_TOKEN}", "-e", "API_KEY=${API_KEY}", "https://h.example.test/mcp?k=${API_KEY}"])
    const twice = McpSecrets.lift("npx", once.args, once.env)
    expect(twice).toEqual({ ...once, moved: false })
  })
})

describe("McpSecrets display", () => {
  test("maskArgs shows what lift moves as ••••", () => {
    expect(
      McpSecrets.maskArgs("docker", [
        "run",
        "-e",
        `GITHUB_TOKEN=${GHP}`,
        "--header",
        `Authorization: Bearer ${BEARER}`,
        `https://h.example.test/mcp?key=${KEY}`,
        "--api-key",
        KEY,
        "--port",
        "8080",
      ]),
    ).toEqual([
      "run",
      "-e",
      "GITHUB_TOKEN=••••",
      "--header",
      "Authorization: Bearer ••••",
      "https://h.example.test/mcp?key=••••",
      "--api-key",
      "••••",
      "--port",
      "8080",
    ])
  })

  test("maskAddress: user info, key-like segments, known keys and query values", () => {
    expect(McpSecrets.maskAddress(`https://u:p@h.example.test/s/${BEARER}/mcp?key=abc&x#frag`)).toBe(
      "https://••••@h.example.test/s/••••/mcp?key=••••&x",
    )
    expect(McpSecrets.maskAddress("https://h.example.test/mcp")).toBe("https://h.example.test/mcp")
  })

  test("secretName", () => {
    for (const name of ["Authorization", "x-api-key", "Cookie", "GITHUB_TOKEN", "apiKey", "DB_PASSWORD", "X-Notes-Key"])
      expect(McpSecrets.secretName(name)).toBe(true)
    for (const name of ["Content-Type", "MODE", "TOKEN_FILE", "API_KEY_PATH", "AUTHOR", "TOKENIZER_MODEL"])
      expect(McpSecrets.secretName(name)).toBe(false)
  })
})

describe("McpSecrets.address", () => {
  test("a plain address: hidden with user info or a key-like segment, its `?` part apart", () => {
    expect(McpSecrets.address("https://mcp.example.test/v1/mcp?k=1")).toEqual({
      base: "https://mcp.example.test/v1/mcp",
      search: "?k=1",
      hidden: false,
      shown: "https://mcp.example.test/v1/mcp",
    })
    expect(McpSecrets.address("https://user:pw@mcp.example.test/mcp").shown).toBe("https://••••@mcp.example.test/mcp")
    expect(McpSecrets.address(`https://mcp.example.test/s/${BEARER}/mcp`).shown).toBe("https://mcp.example.test/s/••••/mcp")
  })

  test("a written address (`${VAR}`): user info, literal keys beside a variable and key-like defaults are ••••", () => {
    const cases = [
      [`https://user:hunter2pass@h.example.test/${BEARER}/mcp`, "https://user:hunter2pass@h.example.test/${X}/mcp", "https://••••@h.example.test/${X}/mcp"],
      [`https://h.example.test/${BEARER}/${GHP}/mcp`, `https://h.example.test/\${X}/${GHP}/mcp`, "https://h.example.test/${X}/••••/mcp"],
      [`https://h.example.test/${GHP}/mcp`, `https://h.example.test/\${UNSET:-${GHP}}/mcp`, "https://h.example.test/${UNSET:-••••}/mcp"],
      ["https://h.example.test/eu/mcp", "https://h.example.test/${REGION:-eu}/mcp?k=${K}", "https://h.example.test/${REGION:-eu}/mcp"],
    ] as const
    for (const [url, written, shown] of cases) {
      const address = McpSecrets.address(url, written)
      expect(address).toMatchObject({ hidden: true, shown })
      for (const value of ["hunter2pass", GHP, BEARER]) expect(address.shown).not.toContain(value)
    }
  })
})

describe("SM-26", () => {
  const V = "FAKE-VALUE-0001-Zq8wXc"
  const V2 = "FAKE-VALUE-0002-Rt5yHn"
  /** Lifted, then put back: the arguments as written, byte for byte. */
  const roundTrip = (args: string[], env: Record<string, string> = {}) => {
    const result = McpSecrets.lift("npx", args, env)
    expect(result.args.map((arg) => McpRules.expand(arg, result.env))).toEqual(args.map((arg) => McpRules.expand(arg, env)))
    return result
  }

  test("a JSON argument is rewritten in place: digits, spacing, a top-level array and leading spacing stay", () => {
    const result = roundTrip([
      "--config",
      `{"apiKey":"${V}","id":12345678901234567890,"ratio":1.50e+3}`,
      "--pretty",
      `{\n  "apiKey": "${V2}",\n  "region": "eu"\n}`,
      "--servers",
      ` [{"token":"${V}"}, {"url":"https://h.example.test/mcp?k=${V2}"}]`,
      `--keys={"apiKeys":["${V}","${V2}"]}`,
    ])
    expect(result.args).toEqual([
      "--config",
      '{"apiKey":"${API_KEY}","id":12345678901234567890,"ratio":1.50e+3}',
      "--pretty",
      '{\n  "apiKey": "${API_KEY_2}",\n  "region": "eu"\n}',
      "--servers",
      ' [{"token":"${API_KEY}"}, {"url":"https://h.example.test/mcp?k=${API_KEY_2}"}]',
      '--keys={"apiKeys":["${API_KEY}","${API_KEY_2}"]}',
    ])
    expect(result.env).toEqual({ API_KEY: V, API_KEY_2: V2 })
    expect(McpSecrets.maskArgs("npx", ["--config", `{"apiKey":"${V}","id":12345678901234567890}`, `[{"token":"${V}"}]`])).toEqual([
      "--config",
      '{"apiKey":"••••","id":12345678901234567890}',
      '[{"token":"••••"}]',
    ])
    // Not JSON (a trailing comma, text after it), or no string moved: the argument as written.
    expect(lifted(['{"token":"x",}', '{"token":"x"} tail', '{"region": "eu", "n": 1.0}']).moved).toBe(false)
  })

  test("a JSON value is stored as itself and written back as JSON, a quote and a backslash too", () => {
    const tricky = `${V}-"quoted"\\tail`
    const nested = JSON.stringify({ inner: JSON.stringify({ password: tricky }) })
    const result = roundTrip([
      "--config",
      JSON.stringify({ password: tricky, note: "a \"plain\" note" }),
      `SETTINGS=${JSON.stringify({ token: tricky })}`,
      "--nested",
      nested,
    ])
    expect(result.env).toEqual({ PASSWORD: tricky })
    expect(result.args).toEqual([
      "--config",
      '{"password":"${PASSWORD}","note":"a \\"plain\\" note"}',
      'SETTINGS={"token":"${PASSWORD}"}',
      "--nested",
      JSON.stringify({ inner: JSON.stringify({ password: "${PASSWORD}" }) }),
    ])
    expect(JSON.parse(JSON.parse(McpRules.expand(nested, {})).inner)).toEqual({ password: tricky })
    // Outside JSON, and inside JSON where no reference is, nothing is escaped or changed.
    expect(McpRules.expand('--x=${P} {"a":"x\\/y"}', { P: '"' })).toBe('--x=" {"a":"x\\/y"}')
    expect(McpRules.expand('{"a":"${P}","b":"x\\/y"}', { P: 'say "hi"' })).toBe('{"a":"say \\"hi\\"","b":"x\\/y"}')
  })

  test("two defaults of one name keep their own values; a given value of that name still wins", () => {
    const result = roundTrip(["--api-key", `\${K:-${V}}`, "--token", `\${K:-${V2}}`, "--again", `\${K:-${V}}`])
    expect(result.args).toEqual(["--api-key", "${K}", "--token", "${K_2}", "--again", "${K}"])
    expect(result.env).toEqual({ K: V, K_2: V2 })
    // A value this lift moved first is no given value: the default keeps its own.
    expect(roundTrip(["--api-key", V, `--other=\${API_KEY:-${V2}}`]).args).toEqual(["--api-key", "${API_KEY}", "--other=${API_KEY_2}"])
    const given = McpSecrets.lift("npx", ["--api-key", `\${K:-${V}}`, "--token", `\${K:-${V2}}`], { K: "stored" })
    expect(given.args).toEqual(["--api-key", "${K}", "--token", "${K}"])
    expect(given.env).toEqual({ K: "stored" })
  })

  test("base64 path keys: a raw `/` inside, percent-encoded `%2F` `%2B` `%3D`", () => {
    /** Fake base64 of 32 and 16 bytes with a `/` inside; of 28 bytes with a `/` put in; the same percent-encoded. */
    const SPLIT_32 = "RkFLRS1WQUxVRS0wMDI5LWs/eS1mYWtlLWtleS0zMmI="
    const SPLIT_16 = "RkFLRS0/QUxVRS0wMDI4eA=="
    const PUT_IN = "RkFLRS1WQUxVRS0w/MDA5LWZha2Uta2V5LXg+eQ=="
    const ENCODED = "RkFLRS1WQUxVRS0w%2FMDA5LWZha2Uta2V5LXg%2BeQ%3D%3D"
    // SM-27: a piece of 22 without `+` is no longer a key by its length alone (see "SM-27" below).
    const keys = [SPLIT_32, SPLIT_16, PUT_IN, ENCODED, `MDA5LWZha2Uta2V5LXg%2BeQ%3D%3D`]
    const urls = keys.map((key) => `https://h.example.test/mcp/${key}/sse`)
    const result = roundTrip(["mcp-remote", ...urls])
    expect(result.args).toEqual([
      "mcp-remote",
      ...keys.map((_, at) => `https://h.example.test/mcp/\${URL_KEY${at === 0 ? "" : `_${at + 1}`}}/sse`),
    ])
    expect(Object.values(result.env)).toEqual(keys)
    for (const url of urls) {
      expect(McpSecrets.address(url)).toMatchObject({ hidden: true, shown: "https://h.example.test/mcp/••••/sse" })
      expect(McpSecrets.maskAddress(url)).toBe("https://h.example.test/mcp/••••/sse")
    }
    expect(McpSecrets.pathKeys(`/mcp/${PUT_IN}/sse`)).toEqual([PUT_IN])
    expect(McpSecrets.pathKeys(`/mcp/${ENCODED}`)).toEqual([ENCODED])
  })

  test("ordinary paths stay: words, versions, names with digits and percent-encoded folders", () => {
    const paths = [
      "/api/v1/servers/2025/mcp",
      "/server-filesystem-2025/mcp",
      "/repos/MyOrg/Server2025/tools",
      "/Users/Profile/Data2024",
      "/v1/Ab12/Cd34/sse",
      "/repos%2Fmy-org%2Fserver-filesystem-2025",
      "/files/My%20Project%202025/notes",
      "/mcp/c++/v1.2.3+build/a=b",
      "/mcp/ABCDEFGHIJKLMNOPQRSTUV",
    ]
    for (const path of paths) {
      const url = `https://h.example.test${path}`
      expect(McpSecrets.pathKeys(path)).toEqual([])
      expect(McpSecrets.address(url)).toMatchObject({ hidden: false, shown: url })
      expect(lifted(["mcp-remote", url]).moved).toBe(false)
    }
  })

  test("secretName takes plural keys; secretValue finds addresses, connection strings and keys", () => {
    for (const name of ["apiKeys", "API_KEYS", "SIGNING_KEYS"]) expect(McpSecrets.secretName(name)).toBe(true)
    for (const name of ["KEYS_FILE", "SSH_KEYS_DIR"]) expect(McpSecrets.secretName(name)).toBe(false)
    for (const value of [
      "postgres://fakeuser:FAKE-VALUE-0009-pw@db.test/x",
      "https://hooks.example.test/services/T0000/B0000/FAKEVALUE0051abcdefghijklmn",
      "https://api.example.test/v1",
      "Server=db.test;User Id=fake;Password=FAKE-VALUE-0013-cs;",
      "Account Key=FAKE-VALUE-0015-ak",
      PLAIN_TOKEN.repeat(2),
    ])
      expect(McpSecrets.secretValue(value)).toBe(true)
    for (const value of ["us-east-1", "C:\\work\\own-data", "application/json", "Server=db.test;Database=app", "a;b"])
      expect(McpSecrets.secretValue(value)).toBe(false)
    expect(McpSecrets.connectionSecrets("Server=db.test;User ID=fake;Password=FAKE-VALUE-0013-cs;pwd= ;AccountKey=a=b==")).toEqual([
      "FAKE-VALUE-0013-cs",
      "a=b==",
    ])
  })
})

describe("SM-27", () => {
  /** Lifted, then put back: the arguments as written, byte for byte. */
  const roundTrip = (args: string[], env: Record<string, string> = {}) => {
    const result = McpSecrets.lift("npx", args, env)
    expect(result.args.map((arg) => McpRules.expand(arg, result.env))).toEqual(args.map((arg) => McpRules.expand(arg, env)))
    return result
  }

  test("names of a key's length stay in a path; a split key with `=` padding or a `+` is still one", () => {
    // Ordinary paths whose pieces together have a base64 key's length (22) with both cases and a digit.
    const ordinary: Array<[string, string]> = [
      ["https://gitmcp.io/PaddlePaddle/Paddle2ONNX", "/PaddlePaddle/Paddle2ONNX"],
      ["https://h.example.test/JohnSmith42/MyRepo2024", "/JohnSmith42/MyRepo2024"],
      ["https://h.example.test/Tenant01/Workspace2025", "/Tenant01/Workspace2025"],
      ["https://h.example.test/MyGroup1%2FMyProject2024", "/MyGroup1%2FMyProject2024"],
      ["file:///Users/JaneDoe42/Projects2025", "/Users/JaneDoe42/Projects2025"],
      ["https://h.example.test/mcp/MyProjectDashboard2025/sse", "/mcp/MyProjectDashboard2025/sse"],
      ["https://h.example.test/v1/Ab3/Cd4/Ef5/Gh6/Ij7", "/v1/Ab3/Cd4/Ef5/Gh6/Ij7"],
    ]
    for (const [url, path] of ordinary) {
      expect(McpSecrets.pathKeys(path)).toEqual([])
      expect(McpSecrets.maskAddress(url)).toBe(url)
      expect(lifted(["mcp-remote", url]).moved).toBe(false)
      expect(McpSecrets.maskArgs("npx", ["mcp-remote", url])).toEqual(["mcp-remote", url])
      if (url.startsWith("https:")) expect(McpSecrets.address(url)).toMatchObject({ hidden: false, shown: url })
    }
    /** Fake base64 of 24 bytes (32 characters, unpadded) with a `+` inside and a raw `/`; and the same without `+`. */
    const PLUS = "RkFLRS1WQU+VRS0wMDI3/WtleTI0Yi4u"
    const NO_PLUS = "RkFLRS1WQUxVRS0wMDI3/WtleTI0Yi4u"
    const SPLIT_32 = "RkFLRS1WQUxVRS0wMDI5LWs/eS1mYWtlLWtleS0zMmI="
    const result = roundTrip(["mcp-remote", `https://h.example.test/mcp/${PLUS}/sse`, `https://h.example.test/mcp/${SPLIT_32}/sse`])
    expect(result.args).toEqual(["mcp-remote", "https://h.example.test/mcp/${URL_KEY}/sse", "https://h.example.test/mcp/${URL_KEY_2}/sse"])
    expect(result.env).toEqual({ URL_KEY: PLUS, URL_KEY_2: SPLIT_32 })
    expect(McpSecrets.address(`https://h.example.test/mcp/${PLUS}/sse`).shown).toBe("https://h.example.test/mcp/••••/sse")
    // Missed by design: an unpadded split key without `+`, and one piece of 22 (a 16-byte key, or a compact id) below
    // the 24 of a random token; names look the same.
    expect(McpSecrets.pathKeys(`/mcp/${NO_PLUS}/sse`)).toEqual([])
    expect(McpSecrets.pathKeys("/mcp/Ab3dEf7hIj1kLm5nOp9qRs/sse")).toEqual([])
    // Beside a key-like piece a name does not join it: only the key is hidden.
    const KEYLIKE = "MDA5LWZha2Uta2V5LXg+eQ=="
    expect(McpSecrets.pathKeys(`/PaddlePaddle/${KEYLIKE}`)).toEqual([KEYLIKE])
    expect(McpSecrets.maskAddress(`https://h.example.test/MyWorkspace2025/${KEYLIKE}`)).toBe(
      "https://h.example.test/MyWorkspace2025/••••",
    )
  })

  test("DSN forms without `scheme://` in arguments: only the password moves; the rest stays as written", () => {
    const args = [
      "jdbc:postgresql://db.example.test:5432/app?user=fake&password=FAKE-VALUE-0061-jdbc",
      "--dsn",
      "fake:FAKE-VALUE-0062-go@tcp(db.example.test:3306)/app?parseTime=true",
      "host=db.example.test port=5432 user=fake password='FAKE VALUE\\'0063'",
      "fake/FAKE-VALUE-0064-ora@db.example.test:1521/XEPDB1",
      "jdbc:oracle:thin:fake/FAKE-VALUE-0065@//db.example.test:1521/svc",
      '--connection=Server=db.example.test;User Id=fake;Password="FAKE;VALUE""0066";Encrypt=true',
      "jdbc:sqlserver://db.example.test:1433;databaseName=app;user=fake;password=FAKE-VALUE-0067",
      "--storage",
      "BlobEndpoint=https://acct.blob.example.test/;SharedAccessSignature=sv=2022-11-02&ss=b&sp=rl&sig=FAKE%2BVALUE0068sig%3D",
    ]
    const result = roundTrip(args)
    expect(result.args).toEqual([
      // A JDBC address is an address: every query value moves, as in any address argument (SM-22).
      "jdbc:postgresql://db.example.test:5432/app?user=${URL_USER}&password=${URL_PASSWORD}",
      "--dsn",
      "fake:${PASSWORD}@tcp(db.example.test:3306)/app?parseTime=true",
      "host=db.example.test port=5432 user=fake password='${PASSWORD_2}'",
      "fake/${PASSWORD_3}@db.example.test:1521/XEPDB1",
      "jdbc:oracle:thin:fake/${PASSWORD_4}@//db.example.test:1521/svc",
      '--connection=Server=db.example.test;User Id=fake;Password="${PASSWORD_5}";Encrypt=true',
      "jdbc:sqlserver://db.example.test:1433;databaseName=app;user=fake;password=${PASSWORD_6}",
      "--storage",
      "BlobEndpoint=https://acct.blob.example.test/;SharedAccessSignature=sv=2022-11-02&ss=b&sp=rl&sig=${SIG}",
    ])
    // SM-28: a quoted value is stored as the driver reads it and quoted again when it is put back (SM-27 stored it as
    // written between its quotes).
    expect(result.env).toEqual({
      URL_USER: "fake",
      URL_PASSWORD: "FAKE-VALUE-0061-jdbc",
      PASSWORD: "FAKE-VALUE-0062-go",
      PASSWORD_2: "FAKE VALUE'0063",
      PASSWORD_3: "FAKE-VALUE-0064-ora",
      PASSWORD_4: "FAKE-VALUE-0065",
      PASSWORD_5: 'FAKE;VALUE"0066',
      PASSWORD_6: "FAKE-VALUE-0067",
      SIG: "FAKE%2BVALUE0068sig%3D",
    })
    expect(McpSecrets.maskArgs("npx", args.slice(1, 8))).toEqual([
      "--dsn",
      "fake:••••@tcp(db.example.test:3306)/app?parseTime=true",
      "host=db.example.test port=5432 user=fake password='••••'",
      "fake/••••@db.example.test:1521/XEPDB1",
      "jdbc:oracle:thin:fake/••••@//db.example.test:1521/svc",
      '--connection=Server=db.example.test;User Id=fake;Password="••••";Encrypt=true',
      "jdbc:sqlserver://db.example.test:1433;databaseName=app;user=fake;password=••••",
    ])
    expect(McpSecrets.lift("npx", result.args, result.env)).toEqual({ ...result, moved: false })
    // Look-alikes that are no DSN, and connection strings without a secret part, stay.
    const others = [
      "owner/repo@v1.2.3",
      "image:tag@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "git@github.com:owner/repo.git",
      "C:\\work@/x",
      "Server=db.example.test;Database=app",
      "host=db.example.test dbname=app",
    ]
    expect(lifted(others).moved).toBe(false)
  })

  test('connectionSecrets: DSN forms, a quoted `Password="a;b"`, Azure\'s `sig`, JDBC properties', () => {
    const cases: Array<[string, string[]]> = [
      ["fake:FAKE-VALUE-0062-go@tcp(db.example.test:3306)/app", ["FAKE-VALUE-0062-go"]],
      ["fake:FAKE@VALUE:0069@unix(/tmp/mysql.sock)/app", ["FAKE@VALUE:0069"]],
      ["host=db.example.test dbname=app user=fake password=FAKE-VALUE-0063", ["FAKE-VALUE-0063"]],
      ["host=db password='FAKE \\'VALUE\\' 0070'", ["FAKE \\'VALUE\\' 0070", "FAKE 'VALUE' 0070"]],
      ["fake/FAKE-VALUE-0064-ora@db.example.test:1521/XEPDB1", ["FAKE-VALUE-0064-ora"]],
      ["fake/FAKE-VALUE-0064-ora@//db.example.test/XEPDB1", ["FAKE-VALUE-0064-ora"]],
      ['Server=db;User Id=fake;Password="FAKE;VALUE""0066";', ['FAKE;VALUE""0066', 'FAKE;VALUE"0066']],
      ["Server=db;Password='FAKE;VALUE-0071'", ["FAKE;VALUE-0071"]],
      ["Driver={ODBC Driver 18};Server=db;PWD={FAKE;VALUE}}0072}", ["FAKE;VALUE}}0072", "FAKE;VALUE}0072"]],
      [
        "BlobEndpoint=https://acct.blob.example.test/;SharedAccessSignature=sv=2022-11-02&ss=b&sig=FAKE%2BVALUE0068sig%3D",
        ["FAKE%2BVALUE0068sig%3D"],
      ],
      ["jdbc:sqlserver://db.example.test:1433;databaseName=app;user=fake;password=FAKE-VALUE-0067", ["FAKE-VALUE-0067"]],
      ["jdbc:jtds:sqlserver://db.example.test:1433/app;user=fake;password=FAKE-VALUE-0073", ["FAKE-VALUE-0073"]],
      // An address's query is the masker's own rule (every value); an unclosed quote is no connection string.
      ["jdbc:postgresql://db.example.test:5432/app?user=fake&password=FAKE-VALUE-0061-jdbc", []],
      ["Server=db.example.test;Database=app", []],
      ['Server=db;Password="FAKE-VALUE-0074', []],
      ["owner/repo@v1.2.3", []],
    ]
    for (const [value, secrets] of cases) expect([value, McpSecrets.connectionSecrets(value)]).toEqual([value, secrets])
    for (const [value] of cases.slice(0, 13)) expect([value, McpSecrets.secretValue(value)]).toEqual([value, true])
    for (const value of ["Server=db.example.test;Database=app", "owner/repo@v1.2.3", "host=db dbname=app"])
      expect(McpSecrets.secretValue(value)).toBe(false)
  })

  test("a lifted default never takes a name another reference reads otherwise; a bare `${K}` keeps its meaning", () => {
    const V = "FAKE-VALUE-0081-Zq8wXc"
    const V2 = "FAKE-VALUE-0082-Rt5yHn"
    // `--mode ${K:-plain}` stays as written (no value's place, not key-like): K stays unset, so it is still `plain`.
    const plain = roundTrip(["--token", `\${K:-${V}}`, "--mode", "${K:-plain}"])
    expect(plain.args).toEqual(["--token", "${K_2}", "--mode", "${K:-plain}"])
    expect(plain.env).toEqual({ K_2: V })
    expect(McpRules.expand("${K:-plain}", plain.env)).toBe("plain")
    // A bare `${K}` elsewhere still reads the environment value K, unset here.
    expect(roundTrip(["--token", `\${K:-${V}}`, "--note", "pre-${K}"]).args).toEqual(["--token", "${K_2}", "--note", "pre-${K}"])
    // A free name is none the arguments already read: `${K_2}` makes it K_3; a moved value skips `${API_KEY}`.
    expect(roundTrip(["--token", `\${K:-${V}}`, "--mode", "${K:-plain}", "--x", "${K_2}"]).args).toEqual([
      "--token",
      "${K_3}",
      "--mode",
      "${K:-plain}",
      "--x",
      "${K_2}",
    ])
    expect(roundTrip(["--api-key", V, "--other", "${API_KEY}"]).args).toEqual(["--api-key", "${API_KEY_2}", "--other", "${API_KEY}"])
    // The same default elsewhere shares the name; a given K still wins over every default.
    expect(roundTrip(["--token", `\${K:-${V}}`, `--again=\${K:-${V}}`, "--mode", "${K:-plain}"]).args).toEqual([
      "--token",
      "${K_2}",
      "--again=${K_2}",
      "--mode",
      "${K:-plain}",
    ])
    const given = roundTrip(["--token", `\${K:-${V}}`, "--api-key", `\${K:-${V2}}`, "--mode", "${K:-plain}"], { K: "stored" })
    expect(given.args).toEqual(["--token", "${K}", "--api-key", "${K}", "--mode", "${K:-plain}"])
    expect(given.env).toEqual({ K: "stored" })
  })

  test("a rewritten JSON string keeps its escape style; McpJson writes Python's `\\uXXXX` form", () => {
    const written = String.raw`{"endpoint":"https:\/\/h.example.test\/caf\u00e9?key=FAKE0083","note":"caf\u00e9"}`
    const upper = String.raw`{"url":"https:\/\/h.example.test\/\u00C9t\u00E9?k=FAKE0084"}`
    const result = roundTrip([written, upper])
    expect(result.args).toEqual([
      '{"endpoint":"https:\\/\\/h.example.test\\/caf\\u00e9?key=${URL_KEY}","note":"caf\\u00e9"}',
      '{"url":"https:\\/\\/h.example.test\\/\\u00C9t\\u00E9?k=${URL_K}"}',
    ])
    // Shown, the mask stays readable, not `\u2022`. (Plain strings here: Bun writes a raw template's `é` as `\u00E9`.)
    expect(McpSecrets.maskArgs("npx", [written])).toEqual([
      '{"endpoint":"https:\\/\\/h.example.test\\/café?key=••••","note":"caf\\u00e9"}',
    ])
    expect(McpJson.encode("a/é😀", '"\\u00e9"')).toBe('"a/\\u00e9\\ud83d\\ude00"')
    expect(McpJson.encode("a/é", '"x\\/y"')).toBe('"a\\/é"')
    // `\\u00e9` is a backslash and `u00e9`, no escape of `é`.
    expect(McpJson.encode("é", '"\\\\u00e9"')).toBe('"é"')
    expect(McpJson.encode("é", '"\\u00E9"')).toBe('"\\u00E9"')
    expect(McpJson.escape('café "x"', true)).toBe('caf\\u00e9 \\"x\\"')
  })
})

describe("SM-28", () => {
  /** Lifted, then put back: the arguments as written, byte for byte. */
  const roundTrip = (args: string[], env: Record<string, string> = {}) => {
    const result = McpSecrets.lift("npx", args, env)
    expect(result.args.map((arg) => McpRules.expand(arg, result.env))).toEqual(args.map((arg) => McpRules.expand(arg, env)))
    return result
  }
  /** Fake random keys: small letters and digits, capitals and digits, both cases, base64url; a GUID and a hex id. */
  const RANDOM_KEYS = [
    "fakek3jx9qmz7tw2vb8nr4hy6cp1ds5g",
    "FAKEK3JX9QMZ7TW2VB8NR4HY6CP1DS5G",
    "FakeQz8wXk3Rt5yHn7Lm2Pk9Vb4Ns6J",
    "fake-Qz8w_Xk3Rt5yHn7Lm2Pk9Vb4Ns6Jd1Gh0Cf",
    "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "0123456789abcdef0123456789abcdef",
  ]

  test("one path piece of 24 or more that reads as a name stays; random keys, GUIDs and hex ids are hidden", () => {
    // Real repositories, workspaces and models whose name is one long piece with a letter and a digit.
    const names = [
      "https://gitmcp.io/amusi/CVPR2024-Papers-with-Code",
      "https://gitmcp.io/scutan90/DeepLearning-500-questions",
      "https://gitmcp.io/rasbt/python-machine-learning-book-3rd-edition",
      "https://dev.azure.com/Contoso/Q4PlanningWorkspace2025Final/_git/app",
      "https://gitlab.com/my-group/backend-services-2024-migration",
      "https://mcp.example.test/workspaces/MarketingAnalytics2025Team/mcp",
      "https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct",
      "file:///workspaces/MarketingAnalytics2025Team",
    ]
    for (const url of names) {
      expect([url, McpSecrets.pathKeys(new URL(url).pathname)]).toEqual([url, []])
      expect(McpSecrets.maskAddress(url)).toBe(url)
      expect(McpSecrets.maskArgs("npx", ["mcp-remote", url])).toEqual(["mcp-remote", url])
      expect(lifted(["mcp-remote", url]).moved).toBe(false)
      if (url.startsWith("https:")) expect(McpSecrets.address(url)).toMatchObject({ hidden: false, shown: url })
    }
    // Beside a `${NAME}` too, and as a value under a plain name (a model id is no key).
    expect(lifted(["https://h.example.test/${TENANT}/MarketingAnalytics2025Team/mcp"]).moved).toBe(false)
    for (const value of ["claude-3-5-sonnet-20241022", "Meta-Llama-3-8B-Instruct", "Q4PlanningWorkspace2025Final"])
      expect([value, McpSecrets.secretValue(value)]).toEqual([value, false])

    const urls = RANDOM_KEYS.map((key) => `https://hooks.example.test/hook/${key}`)
    const result = roundTrip(["mcp-remote", ...urls])
    expect(Object.values(result.env)).toEqual(RANDOM_KEYS)
    for (const url of urls) {
      expect(McpSecrets.maskAddress(url)).toBe("https://hooks.example.test/hook/••••")
      expect(McpSecrets.address(url)).toMatchObject({ hidden: true, shown: "https://hooks.example.test/hook/••••" })
    }
    for (const key of RANDOM_KEYS) expect([key, McpSecrets.secretValue(key)]).toEqual([key, true])
  })

  test("a GUID or 24 hex digits beside a word-like prefix or suffix is a key, though its letters read as words", () => {
    // Fake keys in real shapes (Databricks, `token_`, Shopify, `api-`, Mailgun, HubSpot, `key_`, Mailchimp, Twilio)
    // whose hex letters spell words, so only the hex run tells them from a name.
    const HEX = "deadbeef0facade1decade2deadbeef3"
    const GUID = "deadbeef-0fad-4ace-bead-0decade0face"
    const keys = [
      `dapi${HEX}`,
      `token_${HEX}added4be`,
      `shppa_${HEX}`,
      `shpat_${HEX}`,
      "api-facade0decade1deadbeef23",
      `key-${HEX}`,
      `pat-na1-${GUID}`,
      `key_${GUID}`,
      `${HEX}-us21`,
      `SK${HEX}`,
    ]
    const urls = keys.map((key) => `https://hooks.example.test/hook/${key}`)
    for (const [at, url] of urls.entries()) {
      expect(McpSecrets.pathKeys(new URL(url).pathname)).toEqual([keys[at]])
      expect(McpSecrets.maskAddress(url)).toBe("https://hooks.example.test/hook/••••")
      expect(McpSecrets.address(url)).toMatchObject({ hidden: true, shown: "https://hooks.example.test/hook/••••" })
      expect([keys[at], McpSecrets.secretValue(keys[at]!)]).toEqual([keys[at], true])
    }
    const result = roundTrip(["mcp-remote", ...urls])
    expect(Object.values(result.env)).toEqual(keys)
    for (const arg of result.args) expect(arg).not.toMatch(/deadbeef|facade/)
  })

  test("Go MySQL and Oracle need their real address shapes; an Oracle SID may hold digits", () => {
    const lookalikes = [
      "scope:read@org/repo",
      "feature:flag@origin/main",
      "uvx:mcp-server@git/main",
      "pkg:github/org/repo@main/sub/path",
      "localhost:8080@main/path",
      "owner/repo@main:443",
      "org/repo@host:8080/path",
    ]
    expect(lifted(lookalikes)).toEqual({ command: "npx", args: lookalikes, env: {}, moved: false })
    expect(McpSecrets.maskArgs("npx", lookalikes)).toEqual(lookalikes)
    for (const value of lookalikes)
      expect([value, McpSecrets.connectionSecrets(value), McpSecrets.secretValue(value)]).toEqual([value, [], false])
    const dsns = [
      "fake:FAKE-VALUE-0091@tcp(db.example.test:3306)/app",
      "fake:FAKE-VALUE-0092@unix(/tmp/mysql.sock)/app",
      "fake:FAKE-VALUE-0093@tcp/app",
      "fake:FAKE-VALUE-0094@/app",
      "jdbc:oracle:thin:fake/FAKE-VALUE-0095@db.example.test:1521:ORCL19",
      "fake/FAKE-VALUE-0096@db.example.test:1521:XE21",
      "fake/FAKE-VALUE-0097@db.example.test:2484/svc",
      "fake/FAKE-VALUE-0098@//db.example.test:8080/svc",
      "jdbc:oracle:thin:fake/FAKE-VALUE-0099@db.example.test:49161/XE",
    ]
    const result = roundTrip(dsns)
    expect(Object.values(result.env)).toEqual(dsns.map((_, at) => `FAKE-VALUE-00${91 + at}`))
    for (const arg of [...result.args, ...McpSecrets.maskArgs("npx", dsns)]) expect(arg).not.toContain("FAKE-VALUE")
    expect(McpSecrets.connectionSecrets("fake/FAKE-VALUE-0096@db.example.test:1521:ORCL19")).toEqual(["FAKE-VALUE-0096"])
  })

  test("a quoted password is stored as the driver reads it and quoted again when the server starts", () => {
    const args = [
      'Server=db.example.test;Password="FAKE""VALUE-0101";User ID=fake',
      "Driver={ODBC Driver 18};Pwd={FAKE}}VALUE-0102};Server=db.example.test",
      "host=db.example.test password='FAKE\\'VALUE\\\\0103'",
      "--connection=Data Source=db;Password='FAKE''VALUE-0104'",
      "jdbc:sqlserver://db.example.test:1433;user=fake;password={FAKE;}}VALUE-0105}",
      '--config={"cs":"Server=db;Password=\\"FAKE\\"\\"VALUE-0106\\""}',
    ]
    const result = roundTrip(args)
    expect(result.args).toEqual([
      'Server=db.example.test;Password="${PASSWORD}";User ID=fake',
      "Driver={ODBC Driver 18};Pwd={${PWD}};Server=db.example.test",
      "host=db.example.test password='${PASSWORD_2}'",
      "--connection=Data Source=db;Password='${PASSWORD_3}'",
      "jdbc:sqlserver://db.example.test:1433;user=fake;password={${PASSWORD_4}}",
      '--config={"cs":"Server=db;Password=\\"${PASSWORD_5}\\""}',
    ])
    expect(result.env).toEqual({
      PASSWORD: 'FAKE"VALUE-0101',
      PWD: "FAKE}VALUE-0102",
      PASSWORD_2: "FAKE'VALUE\\0103",
      PASSWORD_3: "FAKE'VALUE-0104",
      PASSWORD_4: "FAKE;}VALUE-0105",
      PASSWORD_5: 'FAKE"VALUE-0106',
    })
    expect(McpSecrets.lift("npx", result.args, result.env)).toEqual({ ...result, moved: false })
    expect(McpSecrets.maskArgs("npx", args.slice(0, 3))).toEqual([
      'Server=db.example.test;Password="••••";User ID=fake',
      "Driver={ODBC Driver 18};Pwd={••••};Server=db.example.test",
      "host=db.example.test password='••••'",
    ])
    // A reference a person put in quotes reads the value itself too; outside quotes a value goes in as it is.
    expect(McpRules.expand('Server=db;Password="${P}"', { P: 'a"b' })).toBe('Server=db;Password="a""b"')
    expect(McpRules.expand("Server=db;Pwd={${P}}", { P: "a}b" })).toBe("Server=db;Pwd={a}}b}")
    expect(McpRules.expand("host=db password='${P}'", { P: "a'b\\c" })).toBe("host=db password='a\\'b\\\\c'")
    expect(McpRules.expand("--pw=${P} Server=${P}", { P: 'a"b' })).toBe('--pw=a"b Server=a"b')
    expect(McpDsn.read(McpDsn.write('a"b${P}"', '"'), '"')).toBe('a"b${P}"')
  })

  test("a JSON field moved whole comes back as the same JSON value, not always in its escapes", () => {
    const written = '{"apiKey":"FAKE-VALUE-0107-caf\\u00e9\\/x","note":"caf\\u00e9"}'
    const result = lifted([written])
    expect(result.args).toEqual(['{"apiKey":"${API_KEY}","note":"caf\\u00e9"}'])
    const back = McpRules.expand(result.args[0]!, result.env)
    expect(JSON.parse(back)).toEqual(JSON.parse(written))
    expect(back).toBe('{"apiKey":"FAKE-VALUE-0107-café/x","note":"caf\\u00e9"}')
  })
})
