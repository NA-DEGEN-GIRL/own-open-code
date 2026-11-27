// omo inside own's service (15 §4.7): starting the built runtime (OWN_OMO_RUNTIME or own/.out/omo) through own-omo's
// host, in a process of its own (test/isolation/run.ts), and running a `task` call's after hook leaves the process as
// it found it (no sort shim, no signal or error listeners), sends nothing over the network, starts no `opencode`
// process, and writes only under its own folder in OWN_HOME, omo's per-session state included (OMO-P6:
// `projects/<folder>-<hash>/run-continuation`, never the project's `.omo/`; OMO-P2: the agent-usage-reminder's record
// under `data/opencode/storage`, never OpenCode 1's `<XDG_DATA_HOME>/opencode/storage`): nothing in the project, the
// OpenCode config folder, OpenCode 1's data and cache folders, the system temp folder or the user's home caches. A
// missing skill folder leaves no notice in own's log.
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

test("the omo runtime starts without touching the process, the network or files outside its folders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-omo-isolation-"))
  // The run gets a home and a temp folder of its own: the user's home caches it watches are shared with the other test
  // files running in parallel, which created `~/.cache` and `~/.local/share` during the check in a fresh profile.
  const home = path.join(root, "user-home")
  const temp = path.join(root, "user-temp")
  fs.mkdirSync(home)
  fs.mkdirSync(temp)
  try {
    const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "..", "isolation", "run.ts"), root], {
      cwd: path.join(import.meta.dir, "..", ".."),
      env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(run.exitCode).toBe(0)
    const report = JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!) as {
      sortSame: boolean
      listenersBefore: Record<string, number>
      listenersAfter: Record<string, number>
      fetches: Array<string>
      spawns: Array<string>
      changed: Array<string>
      config: Array<string>
      workspace: Array<string>
      home: Array<string>
      xdg: Array<string>
      xdgData: Array<string>
      agents: Array<string>
      tools: Array<string>
      commands: Array<string>
    }
    expect(report.sortSame).toBe(true)
    expect(report.listenersAfter).toEqual(report.listenersBefore)
    expect(report.fetches).toEqual([])
    expect(report.spawns.filter((line) => /opencode/i.test(line))).toEqual([])
    expect(report.changed).toEqual([])
    expect(report.config).toEqual([])
    expect(report.xdgData).toEqual([])
    expect(report.xdg).toEqual([])
    expect(report.home.toSorted()).toEqual([
      "thirdparty/omo/data/opencode/storage/agent-usage-reminder/ses_unknown.json",
      "thirdparty/omo/logs/omo.log",
      expect.stringMatching(/^thirdparty\/omo\/projects\/workspace-[0-9a-f]{12}\/run-continuation\/ses_unknown\.json$/),
    ])
    expect(report.workspace).toEqual([])
    expect(report.agents).toEqual(["omo-explore", "omo-librarian", "omo-oracle", "omo-sisyphus-junior"])
    expect(report.tools).toEqual(["omo_background_cancel", "omo_background_output", "omo_call_omo_agent", "omo_task"])
    expect(report.commands).toEqual(["stop-continuation", "resume-continuation"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
