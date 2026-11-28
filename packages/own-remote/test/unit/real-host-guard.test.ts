// The real-host gates' guard and cleanup scoping (isolate.ts, decisions RL35). The 2.4.1-own.6 chain's opening
// cleanup removed the user's real host install: it named the real install's paths and ran before its listing check.
// Now z-cleanup removes only recorded run roots after a precheck, and every phase compares a fingerprint of the user's
// side before and after it.
import { describe, expect, test } from "bun:test"
import { TEST_BASE, assertRunShape, runPrelude, type HostRun } from "../real-host/env.js"
import {
  USER_PATHS,
  checkPrecheck,
  cleanupScript,
  cleanupTargets,
  compareFingerprints,
  fingerprintScript,
  parseFingerprint,
  precheckScript,
  requireInRoots,
  type Fingerprint,
} from "../real-host/isolate.js"

const HOME = "/home/na"
const HOST = "na@server"
const run = (runId = "r0a1b2c3d", extra: Partial<HostRun> = {}): HostRun => ({
  runId,
  home: HOME,
  host: HOST,
  root: `${HOME}/${TEST_BASE}/${runId}`,
  port: 41_234,
  created: "2026-11-28T00:00:00.000Z",
  ...extra,
})

describe("cleanup scoping", () => {
  test("only roots of the suite's shape under HOME/own-realhost-test are targets", () => {
    expect(cleanupTargets([run(), run("r11112222"), run()], HOST, HOME).map((entry) => entry.root)).toEqual([
      `${HOME}/${TEST_BASE}/r0a1b2c3d`,
      `${HOME}/${TEST_BASE}/r11112222`,
    ])
    for (const root of [
      `${HOME}/.local/share/own-open-code`,
      `${HOME}/.config/opencode`,
      `${HOME}/${TEST_BASE}`,
      `${HOME}/${TEST_BASE}/r0a1b2c3d/..`,
      `${HOME}/own-chats`,
      "/tmp/own-1000",
    ])
      expect(() => cleanupTargets([run("r0a1b2c3d", { root })], HOST, HOME)).toThrow()
    expect(() => cleanupTargets([run("../../.config")], HOST, HOME)).toThrow()
    expect(() => cleanupTargets([run("r0a1b2c3d", { home: "/home/na/../root" })], HOST, HOME)).toThrow()
  })

  test("a run recorded on another host account is refused before anything is removed", () => {
    expect(() => cleanupTargets([run()], "dev@lab", HOME)).toThrow("was made on na@server, not on dev@lab")
    expect(() => cleanupTargets([run()], HOST, "/home/other")).toThrow("names HOME /home/na, not /home/other")
  })

  test("a path outside the run's test root is refused", () => {
    const roots = [run().root]
    expect(requireInRoots(`${run().root}/data/own-open-code`, roots)).toBe(`${run().root}/data/own-open-code`)
    for (const path of [
      `${HOME}/.local/share/own-open-code`,
      `${run().root}-x`,
      `${run().root}/../r11112222`,
      "relative/path",
    ])
      expect(() => requireInRoots(path, roots)).toThrow()
  })

  test("the cleanup script names only the recorded roots, never a real install's path", () => {
    const script = cleanupScript([run(), run("r11112222")])
    const removed = [...script.matchAll(/^r='([^']*)'$/gm)].map((match) => match[1])
    expect(removed).toEqual([run().root, run("r11112222").root])
    expect(script.match(/rm -rf/g)?.length).toBe(2)
    expect(script).toContain(`rm -rf "$r"`)
    for (const entry of USER_PATHS) {
      expect(script).not.toContain(`$HOME/${entry}`)
      expect(script).not.toContain(`${HOME}/${entry}`)
    }
    expect(script).not.toContain("/tmp")
    expect(script).not.toContain("\\${")
    // Processes are stopped only when their executable lies inside the root being removed.
    expect(script).toContain(`case "$e" in "$1"/*)`)
    expect(() => cleanupScript([run("r0a1b2c3d", { root: `${HOME}/.local/share/own-open-code` })])).toThrow()
  })

  test("the precheck refuses a root that is a link, foreign, unmarked or resolves elsewhere; absent ones drop out", () => {
    const targets = [run(), run("r11112222")]
    const facts = (lines: string[]) => [...lines, "== end"].join("\n")
    const good = [`== root ${run().root}`, "STATE=dir", "OWNER=ours", "MARKER=r0a1b2c3d", `PHYS=${run().root}`]
    const gone = [`== root ${run("r11112222").root}`, "STATE=absent"]
    expect(checkPrecheck(facts([...good, ...gone]), targets)).toEqual([run()])
    for (const change of [
      ["STATE=link"],
      ["OWNER=other"],
      ["MARKER=r99999999"],
      ["MARKER="],
      [`PHYS=${HOME}/.local/share/own-open-code`],
    ]) {
      const key = change[0]!.split("=")[0]!
      const lines = good.map((line) => (line.startsWith(`${key}=`) ? change[0]! : line))
      expect(() => checkPrecheck(facts([...lines, ...gone]), targets)).toThrow("refusing to remove")
    }
    expect(() => checkPrecheck(facts(good), targets)).toThrow("did not report")
    expect(() => checkPrecheck([...good, ...gone].join("\n"), targets)).toThrow("did not run to its end")
    expect(precheckScript(targets)).not.toContain("rm ")
  })
})

describe("guard", () => {
  const tree = (detail: string, top: string[] = ["aaaa", "bbbb"]) => ({ state: "tree" as const, detail, top })
  const print = (paths: Fingerprint["paths"], processes: Fingerprint["processes"] = []): Fingerprint => ({
    host: HOST,
    paths,
    processes,
  })
  const service = {
    pid: 4242,
    start: "1000",
    own: true,
    exe: `${HOME}/.local/share/own-open-code/app/2.4.1-own.5/opencode`,
  }

  test("a changed user path fails the phase when no real service of the user runs", () => {
    const before = print({ [`${HOME}/.config/opencode`]: tree("h1 3") })
    expect(compareFingerprints(before, before).problems).toEqual([])
    const changed = compareFingerprints(before, print({ [`${HOME}/.config/opencode`]: tree("h2 4") }))
    expect(changed.problems).toEqual([`${HOME}/.config/opencode: contents changed (h1 3 → h2 4)`])
    const removed = compareFingerprints(
      before,
      print({ [`${HOME}/.config/opencode`]: { state: "absent", detail: "", top: [] } }),
    )
    expect(removed.problems).toEqual([`${HOME}/.config/opencode: tree → absent`])
    const added = compareFingerprints(
      print({ [`${HOME}/own-chats`]: { state: "absent", detail: "", top: [] } }),
      print({ [`${HOME}/own-chats`]: tree("h 1") }),
    )
    expect(added.problems).toEqual([`${HOME}/own-chats: absent → tree`])
  })

  test("a user service that ended during the phase fails it; one that started is only reported", () => {
    const paths = { [`${HOME}/.local/share/own-open-code`]: tree("h1 9") }
    expect(compareFingerprints(print(paths, [service]), print(paths)).problems).toEqual([
      `user process 4242 (${service.exe}) ended during the phase`,
    ])
    // The same pid again with another start time is another process: the user's service was replaced.
    expect(
      compareFingerprints(print(paths, [service]), print(paths, [{ ...service, start: "2000" }])).problems,
    ).toHaveLength(1)
    const started = compareFingerprints(print(paths), print(paths, [service]))
    expect(started.problems).toEqual([])
    expect(started.notes).toEqual([`user process 4242 (${service.exe}) started during the phase`])
    // Other processes of the account (shells, an editor) come and go without failing a phase.
    const shell = { pid: 77, start: "5", own: false, exe: "/usr/bin/bash" }
    expect(compareFingerprints(print(paths, [shell]), print(paths)).problems).toEqual([])
  })

  test("while the user's service runs its own writes are notes, but a removed entry still fails", () => {
    const before = print({ [`${HOME}/.local/share/opencode`]: tree("h1 9") }, [service])
    const written = compareFingerprints(
      before,
      print({ [`${HOME}/.local/share/opencode`]: tree("h2 10", ["aaaa", "bbbb", "cccc"]) }, [service]),
    )
    expect(written.problems).toEqual([])
    expect(written.userService).toBe(true)
    expect(written.notes).toHaveLength(1)
    const removed = compareFingerprints(
      before,
      print({ [`${HOME}/.local/share/opencode`]: tree("h3 8", ["aaaa"]) }, [service]),
    )
    expect(removed.problems).toEqual([`${HOME}/.local/share/opencode: 1 direct entry removed`])
  })

  test("another host fails; the fingerprint parses its own output", () => {
    expect(compareFingerprints(print({}), { ...print({}), host: "dev@lab" }).problems).toEqual([
      "the host changed: na@server → dev@lab",
    ])
    const parsed = parseFingerprint(
      [
        "== host",
        HOST,
        `== path ${HOME}/.config/opencode`,
        "TREE abc 3",
        "TOP 1111",
        `== path ${HOME}/own-chats`,
        "ABSENT",
        `== path ${HOME}/.own-r`,
        "LINK /elsewhere",
        "== processes",
        `PROC 4242 1000 1 ${service.exe}`,
        "PROC 77 5 0 /usr/bin/bash",
        "== end",
      ].join("\n"),
    )
    expect(parsed).toEqual({
      host: HOST,
      paths: {
        [`${HOME}/.config/opencode`]: { state: "tree", detail: "abc 3", top: ["1111"] },
        [`${HOME}/own-chats`]: { state: "absent", detail: "", top: [] },
        [`${HOME}/.own-r`]: { state: "link", detail: "/elsewhere", top: [] },
      },
      processes: [service, { pid: 77, start: "5", own: false, exe: "/usr/bin/bash" }],
    })
    expect(() => parseFingerprint("== host\nna@server\n")).toThrow("did not run to its end")
  })

  test("the fingerprint only reads: no write, removal or signal, and every user path is in it", () => {
    for (const script of [fingerprintScript(undefined), fingerprintScript(run())]) {
      for (const verb of ["rm ", "mv ", "kill", "chmod", "mkdir", "touch", " > ", ">>", "tee "])
        expect(script).not.toContain(verb)
      for (const entry of USER_PATHS) expect(script).toContain(`"$HOME/${entry}"`)
      expect(script).not.toContain("\\${")
    }
    // With a run, the run's own processes (executable in the root, or the root in their environment) are left out.
    expect(fingerprintScript(run())).toContain(`root='${run().root}'`)
  })

  test("the run prelude signals only processes inside the root and keeps the root's XDG values", () => {
    const prelude = runPrelude(assertRunShape(run()))
    expect(prelude).toContain(`OWN_RH_ROOT='${run().root}'`)
    expect(prelude).toContain(`XDG_STATE_HOME="$OWN_RH_ROOT/state"`)
    expect(prelude).toContain(`case "$rh_e" in "$OWN_RH_ROOT"/*) kill "$rh_sig" "$rh_p"`)
    expect(prelude).toContain(`grep -qxF "XDG_STATE_HOME=$OWN_RH_ROOT/state"`)
  })
})
