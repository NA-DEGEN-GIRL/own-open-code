// Real-host cleanup (run first and last in a chain, or alone to reset the host), decisions RL35: removes only the test
// roots the runs recorded (`runs.json` in the evidence folder and the current `run.json`), each `$HOME/own-realhost-test/
// r<8 hex>` with this run's marker, and stops only processes whose executable lies inside such a root. Every check runs
// before anything is removed: the host account, the roots' shape (cleanupTargets), then a read-only precheck on the
// host (a directory of ours, not a link, the run's marker, no link in its path). A real install's paths
// (`~/.local/share/own-open-code`, `~/.config/opencode`, …), /tmp and the user's processes are never named; the guard
// (isolate.ts `phase`) fingerprints them before and after this phase like every other.
// Opt-in: OWN_REAL_HOST=build-host (or lab). Local: the temp root is removed except the evidence folders.
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { removeTree } from "../harness/remove.js"
import {
  ALIAS,
  ROOT,
  assertApproved,
  evidence,
  hostSh,
  kv,
  prepareSshFiles,
  readHostRun,
  readRuns,
  writeRuns,
} from "./env.js"
import { checkPrecheck, cleanupScript, cleanupTargets, phase, precheckScript, requireInRoots } from "./isolate.js"

phase("z-cleanup", `real host ${ALIAS}: cleanup of the runs' test roots`, () => {
  test("remove only the recorded test roots, checked on the host before anything is removed", async () => {
    assertApproved()
    // Run alone (to reset the host after a failed run), the temp ssh config may be gone: rebuild it like a-transport.
    prepareSshFiles()
    const facts = kv((await hostSh(`echo "HOME=$HOME"; echo "HOST=$(id -un)@$(hostname)"`)).stdout)
    const current = readHostRun()
    const recorded = readRuns()
    // Every check before the first removal: the shape of every root and the host account it was made on.
    const targets = cleanupTargets(
      [...recorded, ...(current ? [current] : [])],
      facts.get("HOST") ?? "",
      facts.get("HOME") ?? "",
    )
    const precheck = await hostSh(precheckScript(targets))
    evidence("z-precheck.txt", precheck.stdout)
    expect(precheck.code).toBe(0)
    const present = checkPrecheck(precheck.stdout, targets)
    // Only now anything is removed, and only the roots that passed.
    const result =
      present.length > 0 ? await hostSh(cleanupScript(present)) : { code: 0, stdout: "CLEANUP_DONE=1\n", stderr: "" }
    evidence("cleanup.txt", result.stdout + result.stderr)
    expect(result.stdout).toContain("CLEANUP_DONE=1")
    const removed = [...result.stdout.matchAll(/^REMOVED=(.*)$/gm)].map((match) => match[1])
    expect(removed).toEqual(present.map((run) => run.root))
    for (const line of result.stdout.split(/\r?\n/).filter((entry) => entry.startsWith("STOPPED=")))
      expect(line).toMatch(/^STOPPED=\d+$/)
    // Afterwards: every recorded root is gone and no process runs from one; then the record is cleared.
    const after = await hostSh(precheckScript(targets))
    expect(checkPrecheck(after.stdout, targets)).toEqual([])
    const roots = targets.map((run) => requireInRoots(run.root, [run.root]))
    const left = await hostSh(
      String.raw`for d in /proc/[0-9]*; do e=$(readlink "$d/exe" 2>/dev/null) || continue; echo "$e"; done`,
    )
    const running = left.stdout.split(/\r?\n/).filter((exe) => roots.some((root) => exe.startsWith(`${root}/`)))
    expect(running).toEqual([])
    writeRuns([])
    // Older chains' /tmp/own-<uid>-* fixture roots are not recorded by any run: reported, never touched.
    const legacy = await hostSh(String.raw`ls -A1 /tmp 2>/dev/null | grep -cE "^own-$(id -u)(-|$)" || true`)
    evidence("z-cleanup.json", {
      targets: targets.map((run) => run.runId),
      removed: removed.length,
      legacyTmpRoots: Number(legacy.stdout.trim() || 0),
    })
    // Local: no ssh.exe of ours is left (tunnels and helper forwards use the temp config).
    const local = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*own-real-host*' } | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout.trim()
    evidence("local-ssh-left.txt", local)
    expect(local).toBe("")
    // Every host's evidence folder stays (`evidence`, `evidence-<alias>`), and the temp ssh config with its read-only
    // known_hosts copy, which the guard's fingerprint after this phase still needs; run.json and the known_hosts of the
    // code under test go with the rest.
    for (const entry of fs.readdirSync(ROOT)) {
      if (
        entry === "evidence" ||
        entry.startsWith("evidence-") ||
        entry === "dot-ssh" ||
        entry === "known_hosts.user-copy"
      )
        continue
      await removeTree(path.join(ROOT, entry))
    }
  }, 300_000)
})
