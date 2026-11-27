import { describe, expect, test } from "bun:test"
import { Redact } from "../src/index.js"
import { fakeJwt } from "./fixture.js"

// Obviously fake, key-shaped strings: each one matches exactly one pattern.
const jwt = fakeJwt({ sub: "fake" })
const privateKey = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEfakeFAKEfake0000fakeFAKEfake0000",
  "fakeFAKEfake0000fakeFAKEfake0000fake",
  "-----END RSA PRIVATE KEY-----",
].join("\n")
const CASES = [
  { label: "bearer token", secret: `Bearer fake${"0".repeat(20)}`, shown: "Bearer [redacted:bearer token]" },
  { label: "Anthropic API key", secret: `sk-ant-api03-fake${"0".repeat(20)}` },
  { label: "API key", secret: `sk-proj-fake${"0".repeat(20)}` },
  { label: "xAI API key", secret: `xai-fake${"0".repeat(20)}` },
  { label: "JWT", secret: jwt },
  { label: "Google API key", secret: `AIzafake${"0".repeat(20)}` },
  { label: "AWS access key", secret: "AKIAFAKEFAKEFAKEFAKE" },
  { label: "GitHub token", secret: `ghp_fake${"0".repeat(20)}` },
  { label: "private key", secret: privateKey },
]
/** A fine-grained personal access token (16 §4, GH): the GitHub pattern takes it too. */
const FINE_GRAINED = `github_pat_11FAKE${"0".repeat(20)}`
const MIXED = CASES.map((item) => `${item.label}: ${item.secret}`).join("\n")
const HASH_MARKER = /\[redacted:[0-9a-f]{8}\]/

describe("Redact.named", () => {
  test("each pattern writes only its label, never a hash fragment", () => {
    expect(CASES.map((item) => item.label)).toEqual(Redact.PATTERNS.map((item) => item.label))
    CASES.forEach((item) => {
      const result = Redact.named(`before ${item.secret} after`)
      expect(result).toEqual({
        text: `before ${item.shown ?? `[redacted:${item.label}]`} after`,
        count: 1,
        labels: { [item.label]: 1 },
      })
      expect(result.text).not.toMatch(HASH_MARKER)
    })
    // The log form keeps its hash markers.
    expect(Redact.text(CASES[2].secret)).toBe(Redact.marker(CASES[2].secret))
    expect(Redact.named(`token ${FINE_GRAINED}`)).toEqual({
      text: "token [redacted:GitHub token]",
      count: 1,
      labels: { "GitHub token": 1 },
    })
  })

  test("text without secrets is returned as is", () => {
    expect(Redact.named("usage_limit_reached after 3 retries")).toEqual({
      text: "usage_limit_reached after 3 retries",
      count: 0,
      labels: {},
    })
    expect(Redact.named("")).toEqual({ text: "", count: 0, labels: {} })
  })

  test("overlapping matches take the first pattern and count once", () => {
    expect(Redact.named(`key=${CASES[1].secret}`)).toEqual({
      text: "key=[redacted:Anthropic API key]",
      count: 1,
      labels: { "Anthropic API key": 1 },
    })
    expect(Redact.named(`Authorization: Bearer ${CASES[1].secret}`)).toEqual({
      text: "Authorization: Bearer [redacted:bearer token]",
      count: 1,
      labels: { "bearer token": 1 },
    })
    expect(Redact.named(`authorization: bearer ${jwt}`)).toEqual({
      text: "authorization: bearer [redacted:bearer token]",
      count: 1,
      labels: { "bearer token": 1 },
    })
    // Keys inside a private key block are taken by earlier patterns first; the block then replaces their markers.
    const wrapped = [
      "-----BEGIN PRIVATE KEY-----",
      CASES[5].secret,
      `comment ${CASES[2].secret}`,
      "-----END PRIVATE KEY-----",
    ].join("\n")
    expect(Redact.named(`a\n${wrapped}\nb`)).toEqual({
      text: "a\n[redacted:private key]\nb",
      count: 1,
      labels: { "private key": 1 },
    })
    expect(Redact.named(`${CASES[2].secret},${CASES[3].secret}`)).toEqual({
      text: "[redacted:API key],[redacted:xAI API key]",
      count: 2,
      labels: { "API key": 1, "xAI API key": 1 },
    })
  })

  test("a multi-line private key becomes one marker and the text around it stays", () => {
    const openssh = privateKey.replaceAll("RSA", "OPENSSH")
    expect(Redact.named(`id_rsa:\n${privateKey}\nthen\n${openssh}\nend`)).toEqual({
      text: "id_rsa:\n[redacted:private key]\nthen\n[redacted:private key]\nend",
      count: 2,
      labels: { "private key": 2 },
    })
    expect(Redact.named(`pem:\r\n${privateKey.replaceAll("\n", "\r\n")}\r\ndone`).text).toBe(
      "pem:\r\n[redacted:private key]\r\ndone",
    )
    // A key cut off by a truncated tool output is hidden to the end of the text.
    expect(Redact.named(`cat key.pem\n${privateKey.split("\n").slice(0, 2).join("\n")}`)).toEqual({
      text: "cat key.pem\n[redacted:private key]",
      count: 1,
      labels: { "private key": 1 },
    })
  })

  test("named over named text changes nothing", () => {
    const once = Redact.named(MIXED)
    expect(once.count).toBe(CASES.length)
    expect(once.text).not.toMatch(HASH_MARKER)
    CASES.forEach((item) => expect(once.text).not.toContain(item.secret))
    expect(Redact.named(once.text)).toEqual({ text: once.text, count: 0, labels: {} })
    // Markers already in the input, of either form, are left alone and not counted.
    expect(Redact.named("[redacted:1a2b3c4d] [redacted:API key]")).toEqual({
      text: "[redacted:1a2b3c4d] [redacted:API key]",
      count: 0,
      labels: {},
    })
  })

  test("counts markers per label in pattern order", () => {
    const input = [
      `aws ${CASES[6].secret}`,
      `jwt ${jwt}`,
      `one ${CASES[2].secret}`,
      `two sk-fake${"1".repeat(20)}`,
      `Authorization: Bearer ${"f".repeat(24)}`,
      "already [redacted:API key]",
    ].join("\n")
    const result = Redact.named(input)
    expect(result.labels).toEqual({ "bearer token": 1, "API key": 2, JWT: 1, "AWS access key": 1 })
    expect(Object.keys(result.labels)).toEqual(["bearer token", "API key", "JWT", "AWS access key"])
    expect(result.count).toBe(5)
    expect(result.text.split("[redacted:").length - 1).toBe(6)
    expect(Redact.named(MIXED).labels).toEqual(Object.fromEntries(CASES.map((item) => [item.label, 1])))
  })
})

describe("Redact.named: secret-named fields (09 §4.2, IG10)", () => {
  // Opaque values no pattern takes: only the field name says they are secrets.
  const OPAQUE = "fixture-opaque-value-0001"

  test("JSON, assignments and keys at a line's start hide the value by the field's name", () => {
    const cases: ReadonlyArray<readonly [string, string, Record<string, number>]> = [
      [
        `{"refresh_token": "${OPAQUE}", "expires_in": 3600}`,
        `{"refresh_token": "[redacted:refresh_token]", "expires_in": 3600}`,
        { refresh_token: 1 },
      ],
      [`{'Password': '${OPAQUE}'}`, `{'Password': '[redacted:password]'}`, { password: 1 }],
      [
        `{"tokens": {"access": "${OPAQUE}", "refresh": "${OPAQUE}"}}`,
        `{"tokens": {"access": "[redacted:access]", "refresh": "[redacted:refresh]"}}`,
        { access: 1, refresh: 1 },
      ],
      [`password=${OPAQUE}`, "password=[redacted:password]", { password: 1 }],
      [
        `OPENAI_API_KEY=${OPAQUE}\nPATH=/usr/bin`,
        "OPENAI_API_KEY=[redacted:openai_api_key]\nPATH=/usr/bin",
        { openai_api_key: 1 },
      ],
      [`export GITHUB_TOKEN="${OPAQUE}"`, `export GITHUB_TOKEN="[redacted:github_token]"`, { github_token: 1 }],
      [
        `spring.datasource.password = ${OPAQUE}`,
        "spring.datasource.password = [redacted:spring.datasource.password]",
        { "spring.datasource.password": 1 },
      ],
      [
        `curl "https://x.test/cb?code=1&token=${OPAQUE}&state=2"`,
        `curl "https://x.test/cb?code=1&token=[redacted:token]&state=2"`,
        { token: 1 },
      ],
      [`tool --password=${OPAQUE} --verbose`, "tool --password=[redacted:password] --verbose", { password: 1 }],
      [
        `client_secret: ${OPAQUE}\nclient_id: app`,
        "client_secret: [redacted:client_secret]\nclient_id: app",
        { client_secret: 1 },
      ],
      [`  - api_key: "${OPAQUE}"`, `  - api_key: "[redacted:api_key]"`, { api_key: 1 }],
      [`Authorization: Basic ${OPAQUE}`, "Authorization: [redacted:authorization]", { authorization: 1 }],
      [`Cookie: sid=${OPAQUE}`, "Cookie: [redacted:cookie]", { cookie: 1 }],
    ]
    for (const [input, text, labels] of cases) {
      const count = Object.values(labels).reduce((sum, value) => sum + value, 0)
      expect({ input, result: Redact.named(input) }).toEqual({ input, result: { text, count, labels } })
      expect(Redact.named(text)).toEqual({ text, count: 0, labels: {} })
    }
  })

  test("a pattern's marker, a reference, a call, a comparison and other names stay as they are", () => {
    const kept = [
      "Authorization: Bearer [redacted:bearer token]",
      "token: ${{ secrets.GITHUB_TOKEN }}",
      "password=$DB_PASSWORD",
      "const token = getToken()",
      "if token == expected:",
      "max_token=4096",
      "MAX_TOKENS=4096",
      "access: public",
      "refresh=30s",
      "tokens: 1200 in, 300 out",
      "The password must be strong",
      'monkey: "banana"',
    ]
    for (const input of kept)
      expect({ input, result: Redact.named(input) }).toEqual({ input, result: { text: input, count: 0, labels: {} } })
    // A patterned secret under a secret-named field keeps the pattern's label.
    expect(Redact.named(`api_key=sk-proj-fake${"0".repeat(20)}`)).toEqual({
      text: "api_key=[redacted:API key]",
      count: 1,
      labels: { "API key": 1 },
    })
  })
})
