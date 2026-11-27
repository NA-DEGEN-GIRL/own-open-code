import { describe, expect, test } from "bun:test"
import { Build } from "../../src/build.js"
import { Options } from "../../src/options.js"

describe("options", () => {
  test("decoding nothing yields every documented default", () => {
    const defaults: Options.Info = {
      driver: "windows",
      helper: { timeoutMs: 10_000 },
      image: { tier: "standard", maxBase64Bytes: 4_500_000, format: "auto" },
      history: { keep: 8, batch: 7 },
      policy: { allowApps: [], denyApps: [], allowTerminals: false, allowSubagents: false, blockedChords: [] },
      approval: "session",
      codemode: true,
      returnScreenshot: "never",
      audit: true,
      leaseIdleSeconds: 120,
    }
    expect(Options.decode(undefined)).toEqual(defaults)
    expect(Options.decode({})).toEqual(defaults)
    expect(Options.decode({ image: undefined, policy: undefined })).toEqual(defaults)
  })

  test("partial nested objects keep the other defaults", () => {
    const options = Options.decode({
      home: "D:\\own",
      driver: "fake",
      image: { tier: "high" },
      history: { keep: 4 },
      policy: { allowApps: ["chrome.exe"] },
      helper: { command: ["bun", "fake-helper.ts"] },
    })
    expect(options.home).toBe("D:\\own")
    expect(options.driver).toBe("fake")
    expect(options.image).toEqual({ tier: "high", maxBase64Bytes: 4_500_000, format: "auto" })
    expect(options.history).toEqual({ keep: 4, batch: 7 })
    expect(options.policy.allowApps).toEqual(["chrome.exe"])
    expect(options.policy.allowTerminals).toBe(false)
    expect(options.helper).toEqual({ command: ["bun", "fake-helper.ts"], timeoutMs: 10_000 })
  })

  test("the driver is the in-process one by default; the helper exe and the fake desktop are opt-in", () => {
    expect(Options.decode({}).driver).toBe("windows")
    expect(Options.decode({ driver: "helper" }).driver).toBe("helper")
    expect(Options.decode({ driver: "fake" }).driver).toBe("fake")
  })

  test.each([
    { driver: "cua" },
    { image: { tier: "max" } },
    { image: { maxBase64Bytes: 5_500_000 } },
    { history: { keep: 0 } },
    { history: { batch: 33 } },
    { helper: { timeoutMs: 10 } },
    { helper: { command: [] } },
    { approval: "always" },
    { leaseIdleSeconds: 1 },
    { policy: { allowApps: "chrome" } },
  ])("rejects %j", (input) => {
    expect(() => Options.decode(input)).toThrow()
  })

  test("build constants fall back to development values outside a release bundle", () => {
    expect(Build.PLUGIN_ID).toBe("own.computer-use")
    expect(Build.BUILD_ID).toBe("dev")
    expect(Build.EXPECTED_APP_VERSION).toBe("local")
    expect(Build.PLUGIN_VERSION).toBe("0.0.0-dev")
  })
})
