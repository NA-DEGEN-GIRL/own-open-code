// McpRules (03 §18.14, SM): the plain rules own.accounts and own-web share: a free name for a found or pasted
// server, the masked hint, and the `${NAME}` references to a server's stored environment values.
import { describe, expect, test } from "bun:test"
import { McpRules, OwnMcp } from "../src/index.js"

describe("McpRules", () => {
  test("a free name: invalid characters become `-`, taken names (any case) get -2, -3 …", () => {
    expect(McpRules.suggestName("my tools!", [])).toBe("my-tools")
    expect(McpRules.suggestName("github", ["GitHub", "github-2"])).toBe("github-3")
    expect(McpRules.suggestName(undefined, [])).toBe("server")
    expect(McpRules.suggestName("---", ["server"])).toBe("server-2")
    expect(OwnMcp.NAME_PATTERN.test(McpRules.suggestName("io.github.user/very long name ".repeat(5), []))).toBe(true)
  })

  test("a hint shows the last four characters of long values only", () => {
    expect(McpRules.hint("ghp_fakeOwnMcpToken0000000000Wx9z")).toBe("…Wx9z")
    expect(McpRules.hint("short")).toBeUndefined()
    expect(OwnMcp.hint).toBe(McpRules.hint)
  })

  test("`${NAME}` references: names, and only stored names are put in", () => {
    expect(McpRules.references("--token=${GITHUB_TOKEN} ${OTHER} $PLAIN ${1BAD}")).toEqual(["GITHUB_TOKEN", "OTHER"])
    expect(McpRules.expand("--token=${GITHUB_TOKEN} ${OTHER}", { GITHUB_TOKEN: "t$&1" })).toBe("--token=t$&1 ${OTHER}")
  })

  test("SM-25: `${NAME:-default}` is the stored value, else its default, and needs no stored value", () => {
    expect(McpRules.references("--region=${REGION:-eu} ${TOKEN} ${EMPTY:-}")).toEqual(["TOKEN"])
    expect(McpRules.expand("--region=${REGION:-eu} --mode=${MODE:-ro} ${EMPTY:-}x", { MODE: "rw$&" })).toBe(
      "--region=eu --mode=rw$& x",
    )
    expect(McpRules.expand("${UNSET}", {})).toBe("${UNSET}")
  })
})
