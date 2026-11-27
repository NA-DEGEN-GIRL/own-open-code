// Settings > 팀 (06 §9.8, §0.3, §10.1, §12.2): the thresholds in MB / GB against the protocol defaults, the commands
// owners run without asking as the page lists them, the other-tool pattern list rules, 영역과 직접 일할 때 and 팀 지시문
// (2026-11-14),
// that the page has no conversation-size, summary or rotation fields (U6), that 반영하기 전에 묻기 and 결정 기록 take
// effect now (no 'later' tag since T2), that writes need the `local` scope a gateway device never holds, that it stays
// a lazy chunk, the section labels, the e2e scripts and the dev service's plugin slots. Team values are fixtures.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import type { OwnScope } from "@/data/rpc"
import { createTeamRpc } from "@/data/team-rpc"
import { en } from "@/i18n/en"
import { ko } from "@/i18n/ko"
import { parseRoute, SETTINGS_SECTIONS } from "@/routing/routes"
import { teamEn, teamKo } from "@/team/strings"
import {
  addPattern,
  areaRootOf,
  commandText,
  DIRECT_TELL,
  directTellOf,
  parseThreshold,
  PATTERN_LENGTH,
  PATTERN_LIMIT,
  READ_ONLY_GIT,
  thresholdText,
} from "./team"

const SRC = path.join(import.meta.dir, "..")
const PACKAGE = path.join(SRC, "..")
const page = () => Bun.file(path.join(SRC, "settings", "team.tsx")).text()

describe("confirm thresholds (06 §0.3: 500 MB download, 2 GB disk)", () => {
  test("the defaults show as 500 MB and 2 GB", () => {
    expect(thresholdText(OwnTeam.POLICY.askDownloadBytes, "MB")).toBe("500")
    expect(thresholdText(OwnTeam.POLICY.askDiskBytes, "GB")).toBe("2")
    expect(thresholdText(1.5 * 1024 ** 3, "GB")).toBe("1.5")
    expect(thresholdText(0, "MB")).toBe("0")
  })

  test("typed values become bytes; anything but a number of 0 or more is refused", () => {
    expect(parseThreshold("500", "MB")).toBe(OwnTeam.POLICY.askDownloadBytes)
    expect(parseThreshold(" 2 ", "GB")).toBe(OwnTeam.POLICY.askDiskBytes)
    expect(parseThreshold("1.5", "GB")).toBe(1.5 * 1024 ** 3)
    expect(parseThreshold("0", "MB")).toBe(0)
    for (const bad of ["", "-1", "abc", "1e3", "1,5", ".5", "Infinity", "9".repeat(30)])
      expect(parseThreshold(bad, "MB"), bad).toBeUndefined()
  })

  test("every parsed value passes the protocol's byte schema", () => {
    const valid = Schema.is(OwnTeam.Policy.fields.askDiskBytes)
    for (const typed of ["0", "0.01", "500", "2048", "1.25"]) expect(valid(parseThreshold(typed, "GB"))).toBe(true)
  })
})

describe("commands owners run without asking (06 §10.1)", () => {
  test("argv commands are joined, a word with spaces quoted; shell commands stay as written", () => {
    expect(commandText({ argv: ["bun", "run", "typecheck"] })).toBe("bun run typecheck")
    expect(commandText({ argv: ["node", "scripts/check.mjs", "--name", "two words"] })).toBe(
      'node scripts/check.mjs --name "two words"',
    )
    expect(commandText({ shell: "bun install && bun run build" })).toBe("bun install && bun run build")
  })

  test("read-only Git is the 10.1 list; auto-allow is on by default and has its off switch", async () => {
    expect([...READ_ONLY_GIT]).toEqual(["git status", "git diff", "git log", "git show", "git rev-parse"])
    expect(OwnTeam.POLICY.autoAllow).toBe(true)
    const source = await page()
    expect(source).toContain("policy: { autoAllow: on }")
    expect(source).toContain('"own.team.settings.autoAllowOff"')
  })
})

describe("other tools' path patterns", () => {
  test("added at the end, trimmed; empty, too long, duplicate and a full list are refused", () => {
    expect(addPattern([], "  /.other/worktrees/ ")).toEqual({ patterns: ["/.other/worktrees/"] })
    expect(addPattern(["/a/"], "/b/")).toEqual({ patterns: ["/a/", "/b/"] })
    expect(addPattern([], "   ")).toEqual({ problem: "empty" })
    expect(addPattern([], "x".repeat(PATTERN_LENGTH + 1))).toEqual({ problem: "long" })
    expect(addPattern(["/a/"], " /a/")).toEqual({ problem: "duplicate" })
    const full = Array.from({ length: PATTERN_LIMIT }, (_, index) => `/p${index}/`)
    expect(addPattern(full, "/one-more/")).toEqual({ problem: "full" })
  })

  test("the limits are the protocol's: an accepted list passes `SettingsPatch.patterns`", () => {
    const valid = Schema.is(OwnTeam.SettingsPatch)
    const almost = Array.from({ length: PATTERN_LIMIT - 1 }, (_, index) => `/p${index}/`)
    const added = addPattern(almost, "x".repeat(PATTERN_LENGTH))
    expect("patterns" in added && valid({ patterns: added.patterns })).toBe(true)
    expect(valid({ patterns: [...almost, "/a/", "/b/"] })).toBe(false)
    expect(valid({ patterns: ["x".repeat(PATTERN_LENGTH + 1)] })).toBe(false)
  })
})

describe("the page (06 §9.8)", () => {
  test("it edits every policy field and the patterns, and nothing about conversation size or summaries (U6)", async () => {
    const source = await page()
    // `maxAreas` is stored for older builds, not read (no area limit since 2026-11-14).
    for (const field of Object.keys(OwnTeam.Policy.fields).filter((key) => key !== "maxAreas"))
      expect(source, field).toContain(`policy.${field}`)
    expect(source).not.toContain("policy.maxAreas")
    expect(source).toContain("save({ patterns })")
    expect(source).not.toMatch(/compact|rotat|token|window|압축|교체/i)
    // The patch the page sends has no other keys: the protocol has none to send.
    expect(Object.keys(OwnTeam.SettingsPatch.fields).toSorted()).toEqual(["instructions", "patterns", "policy"])
    expect(Object.keys(OwnTeam.Policy.fields).toSorted()).toEqual([
      "askDiskBytes",
      "askDownloadBytes",
      "autoAllow",
      "commitDecisions",
      "directHold",
      "directTell",
      "maxAreas",
      "mergeLocal",
    ])
  })

  test("writes are local scope: the page reads `settings.get`, writes `settings.set` and hides controls without it", async () => {
    const source = await page()
    expect(OwnTeam.MethodScope["settings.get"]).toBe("read")
    expect(OwnTeam.MethodScope["settings.set"]).toBe("local")
    expect(source).toContain('rpc.call("settings.get"')
    expect(source).toContain('rpc.call("settings.set"')
    expect(source).toContain('rpc.allowed("settings.set")')
    // A device's notice names the service PC when the gateway gave its name (`/own/device` `pc`, 06 §9.8).
    expect(source).toContain('viewOnlyText(text, "settings", props.pc)')
  })

  test("반영하기 전에 묻기 and 결정 기록 take effect now: no 'later' tag, both switches write their policy field", async () => {
    const source = await page()
    expect(source).not.toContain("own.team.settings.later")
    expect(source).not.toMatch(/\bTag\b/)
    expect(source).toContain('policy: { mergeLocal: on ? "ask" : "auto" }')
    expect(source).toContain("policy: { commitDecisions: on }")
    // 06 §12.2: applying asks nothing and decision records stay out of the project unless these are switched on.
    expect([OwnTeam.POLICY.mergeLocal, OwnTeam.POLICY.commitDecisions]).toEqual(["auto", false])
  })

  test("no conversation size, summary or rotation fields, in the page or the words it shows (U6, 06 §6.1)", async () => {
    const source = await page()
    const keys = [...source.matchAll(/"(own\.team\.settings\.[\w.]+)"/g)].map((match) => match[1] ?? "")
    expect(keys.length).toBeGreaterThan(10)
    const ko = new Map<string, string>(Object.entries(teamKo))
    const en = new Map<string, string>(Object.entries(teamEn))
    for (const key of keys) {
      expect(ko.get(key), key).toBeTruthy()
      expect(`${ko.get(key)} ${en.get(key)}`, key).not.toMatch(
        /압축|교체|토큰|대화 크기|compact|rotat|token|window|size/i,
      )
    }
  })

  test("writes need the PC: a gateway device's client refuses `settings.set` and the page shows values only", async () => {
    const asked: string[] = []
    const client = () => {
      asked.push("client")
      throw new Error("a device's write never reaches the service")
    }
    const rpc = (scopes: readonly OwnScope[]) =>
      createTeamRpc({ client, control: async () => "C:/control", scopes: () => new Set(scopes) })
    for (const scopes of [["read"], ["read", "prompt", "switch", "admin"]] as const) {
      const device = rpc(scopes)
      expect(device.allowed("settings.get")).toBe(true)
      expect(device.allowed("settings.set")).toBe(false)
      await expect(device.call("settings.set", { teamID: "tm_0123456789ab", patch: {} })).rejects.toMatchObject({
        type: "own.scope_denied",
      })
    }
    expect(asked).toEqual([])
    expect(rpc(["read", "prompt", "switch", "admin", "local"]).allowed("settings.set")).toBe(true)
    // Every control takes the gate: the switches, two thresholds, the pattern list and 팀 지시문 (no area limit since
    // 2026-11-14); 직접 시킨 일을 메인에게 알리기 shows its value as words without it.
    const source = await page()
    expect(source.match(/writable=\{writable\(\)\}/g)?.length).toBe(8)
    expect(source).toContain('data-testid="settings-team-direct-tell"')
    expect(source.match(/<Show\s+when=\{writable\(\)\}/g)?.length).toBe(1)
  })

  test("영역과 직접 일할 때 (2026-11-14): first, with its feature; both rows write their policy field, absent reads on / 담당이 판단", async () => {
    const source = await page()
    expect(source).toContain('props.store.has("direct")')
    expect(source).toContain("policy: { directHold: on }")
    expect(source).toContain("policy: { directTell: value }")
    expect(source).toContain("current().policy.directHold !== false")
    // The group comes before every existing row; 반영하기 전에 묻기 stays with them (it governs every integration).
    const at = (needle: string) => source.indexOf(needle)
    expect(at("settings-team-direct-hold")).toBeLessThan(at("settings-team-area-root"))
    expect(at("settings-team-direct-tell")).toBeLessThan(at("settings-team-merge-ask"))
    expect(DIRECT_TELL).toEqual(OwnTeam.DirectTell.literals)
    expect(directTellOf({})).toBe("judge")
    expect(directTellOf({ directTell: "none" })).toBe("none")
    expect(directTellOf({ directTell: "always" })).toBe("always")
    // An open string: a value a later build writes reads as the default.
    expect(directTellOf({ directTell: "sometimes" })).toBe("judge")
    expect(Schema.is(OwnTeam.SettingsPatch)({ policy: { directHold: false, directTell: "none" } })).toBe(true)
    expect(Schema.is(OwnTeam.SettingsPatch)({ policy: { directTell: "sometimes" } })).toBe(false)
    expect(teamKo["own.team.settings.directGroup"]).toBe("영역과 직접 일할 때")
    expect(teamEn["own.team.settings.directGroup"]).toBe("When you work with an area yourself")
    expect(teamKo["own.team.settings.directHold"]).toBe("내가 영역에서 직접 일하면 메인은 기다리기")
    expect(DIRECT_TELL.map((value) => teamKo[`own.team.settings.directTell.${value}`])).toEqual([
      "내가 말할 때만",
      "담당이 판단",
      "항상",
    ])
    // The intro sends role changes to the area menu too; the area limit words are gone.
    expect(teamKo["own.team.settings.intro"]).toBe(
      "팀 모드가 켜진 프로젝트마다 정해요. 영역의 모델, 프리셋, 역할은 영역 메뉴(⋯)에서 바꿔요.",
    )
    expect(Object.keys(teamKo).filter((key) => key.includes("maxAreas"))).toEqual([])
  })

  test("고급 > 팀 지시문 (2026-11-14): last, with its feature, a lazy page in place of the rows, and its state", async () => {
    const source = await page()
    expect(source).toContain('lazy(() => import("./team-instructions"))')
    expect(source).not.toMatch(/^import[^;]*from\s+["']\.\/team-instructions["']/m)
    expect(source).toContain('props.store.has("instructions") && current().instructions')
    const at = (needle: string) => source.indexOf(needle)
    expect(at("settings-team-instructions-open")).toBeGreaterThan(at("save({ patterns })"))
    // A save of the blocks reads the settings again: they are not part of the team record `settings.set` answers.
    expect(source).toContain("if (patch.instructions) await refetch()")
    expect(teamKo["own.team.settings.instructions"]).toBe("팀 지시문")
    expect([
      teamKo["own.team.settings.instructions.standard"],
      teamKo["own.team.settings.instructions.custom"],
    ]).toEqual(["기본", "고쳐 씀"])
  })

  test("the pattern field stays at 64 and has no native limit, so the full and too-long messages show", async () => {
    const source = await page()
    expect(source).not.toContain("props.patterns.length < PATTERN_LIMIT")
    expect(source).not.toContain("maxLength={PATTERN_LENGTH}")
    expect(
      addPattern(
        Array.from({ length: PATTERN_LIMIT }, (_, index) => `p${index}`),
        "next",
      ),
    ).toEqual({
      problem: "full",
    })
    expect(addPattern([], "a".repeat(PATTERN_LENGTH + 1))).toEqual({ problem: "long" })
  })

  test("영역 폴더 위치 (06 §4.12, 2026-10-27): shown, never written; `.worktrees` is 프로젝트 안", async () => {
    expect(areaRootOf("D:/own-open-code/.worktrees")).toBe("inside")
    expect(areaRootOf("D:\\own-open-code\\.worktrees\\")).toBe("inside")
    expect(areaRootOf("/srv/game/.worktrees")).toBe("inside")
    expect(areaRootOf("D:/own-open-code-team")).toBe("beside")
    expect(areaRootOf("D:/own-team/own-open-code")).toBe("beside")
    for (const root of OwnTeam.AreaRoot.literals) {
      expect(teamKo[`own.team.settings.areaRoot.${root}`]).toBeTruthy()
      expect(teamEn[`own.team.settings.areaRoot.${root}`]).toBeTruthy()
    }
    const source = await page()
    expect(source).toContain('data-testid="settings-team-area-root"')
    // Nothing in the patch can move it (a team keeps the place it got when it was turned on).
    expect(Object.keys(OwnTeam.SettingsPatch.fields)).not.toContain("worktreeRoot")
  })

  test("its words come from the team catalog, in both languages", () => {
    const keys = Object.keys(teamKo).filter((key) => key.startsWith("own.team.settings."))
    expect(keys.length).toBeGreaterThan(10)
    const english = new Map(Object.entries(teamEn))
    for (const key of keys) expect(english.get(key), key).toBeTruthy()
    for (const key of [
      "own.set.state.on",
      "own.set.state.off",
      "own.set.teamThreshold.invalid",
      "own.set.teamPattern.long",
      "own.set.teamPattern.duplicate",
      "own.set.teamPattern.full",
    ] as const) {
      expect(ko[key], key).toBeTruthy()
      expect(en[key], key).toBeTruthy()
    }
  })
})

describe("section, lazy chunk, scripts and dev slot", () => {
  test("/settings/team is a section with ko/en labels; 프리셋 and the merged devices section stay", () => {
    expect(SETTINGS_SECTIONS).toContain("team")
    expect(SETTINGS_SECTIONS).toContain("presets")
    expect(SETTINGS_SECTIONS).toContain("devices")
    expect(parseRoute("/settings/team").route).toEqual({ name: "settings", section: "team" })
    expect(ko["own.settings.team"]).toBe("팀 모드")
    expect(en["own.settings.team"]).toBe("Team mode")
  })

  test("the settings index lazy-imports 프리셋 and 팀; nothing imports the team page statically", async () => {
    const index = await Bun.file(path.join(SRC, "settings", "index.tsx")).text()
    expect(index).toContain('lazy(() => import("./presets"))')
    expect(index).toContain('lazy(() => import("./team"))')
    const files = [...new Glob("**/*.{ts,tsx}").scanSync(SRC)]
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !/\.test\.tsx?$/.test(file))
    const statically = (file: string) => {
      const local = file.startsWith("settings/") ? "|\\./team" : ""
      return new RegExp(String.raw`^import[^;]*from\s+["'](@/settings/team${local})["']`, "m")
    }
    const offenders = await Promise.all(
      files.map(async (file) => (statically(file).test(await Bun.file(path.join(SRC, file)).text()) ? [file] : [])),
    )
    expect(offenders.flat()).toEqual([])
  })

  test("package.json runs the team and presets e2e suites", async () => {
    const manifest = (await Bun.file(path.join(PACKAGE, "package.json")).json()) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts["test:e2e:team"]).toBe("playwright test --config e2e/team/playwright.config.ts")
    expect(manifest.scripts["test:e2e:presets"]).toBe("playwright test --config e2e/presets/playwright.config.ts")
  })

  test("the dev service loads own-team in the third slot, after own-accounts and own-remote (06 §2.6)", async () => {
    const source = await Bun.file(path.join(PACKAGE, "dev", "service.ts")).text()
    const at = (name: string) => source.indexOf(`"packages/${name}"`)
    const order = ["own-accounts", "own-remote", "own-team", "own-telemetry"].map(at)
    expect(order.every((index) => index > 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    // own-computer-use, when the dev service loads it, stays last.
    const computer = at("own-computer-use")
    if (computer >= 0) expect(computer).toBeGreaterThan(at("own-telemetry"))
  })
})
