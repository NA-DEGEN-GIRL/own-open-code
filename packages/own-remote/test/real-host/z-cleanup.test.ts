// Real-host cleanup (run last, or alone to reset the host): stops every process our install started on the host,
// removes the 04 §5.3 install paths (with `tools/git-lfs`), /tmp/own-<uid> and /tmp/own-<uid>-* (the team suites'
// fixture roots too; other /tmp/own-* names are not ours and are left alone) and
// our stale /tmp/.bun-<uid>-* native modules (an install before TMPDIR was set extracted them there), and compares the listing with the one taken before the first suite ran. Directories shared with upstream opencode
// (~/.local/share/opencode, …) are removed whole only when the before listing shows they did not exist; otherwise only
// the own-channel files inside them are removed. `~/.gitconfig` must hash the same as before (06 TG17).
// Opt-in: OWN_REAL_HOST=dev-host (or lab). Local: the temp root is removed except the evidence folders (no secrets in
// them).
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { removeTree } from "../harness/remove.js"
import {
  ALIAS,
  CLEANUP_SCRIPT,
  EVIDENCE,
  ROOT,
  SNAPSHOT_SCRIPT,
  assertApproved,
  assertListingHost,
  enabled,
  evidence,
  hostSh,
  prepareSshFiles,
  section,
} from "./env.js"

const run = enabled ? describe : describe.skip

/** `== find <dir>` sections of a listing whose next line is ABSENT. */
function absent(listing: string) {
  const lines = listing.split(/\r?\n/)
  const result = new Set<string>()
  lines.forEach((line, index) => {
    const match = /^== find (.+)$/.exec(line)
    if (match && lines[index + 1] === "ABSENT") result.add(match[1]!.replace(/^\/home\/[^/]+/, "$HOME"))
  })
  return result
}

/** The `~/.gitconfig` hash the run started with: the before listing's, else the one c-team recorded. */
function gitconfigBefore(before: string) {
  const listed = section(before, "== gitconfig")[0]
  if (listed !== undefined) return listed
  const file = path.join(EVIDENCE, "c-gitconfig.json")
  if (!fs.existsSync(file)) return undefined
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { readonly before: string }).before
}

run(`real host ${ALIAS}: cleanup`, () => {
  test("stop our processes, remove our install, compare with the before listing", async () => {
    assertApproved()
    // Run alone (to reset the host after a failed run), the temp ssh config may be gone: rebuild it like a-transport.
    prepareSshFiles()
    const beforeFile = path.join(EVIDENCE, "before.txt")
    expect(fs.existsSync(beforeFile)).toBe(true)
    const before = fs.readFileSync(beforeFile, "utf8")
    await assertListingHost(before)
    const wasAbsent = absent(before)
    const shared = [
      "$HOME/.local/share/opencode",
      "$HOME/.local/state/opencode",
      "$HOME/.config/opencode",
      "$HOME/.cache/opencode",
    ]
    const script = CLEANUP_SCRIPT.replace(
      /^rm -rf "\$HOME\/\.local\/share\/opencode".*$/m,
      shared
        .map((dir) =>
          wasAbsent.has(dir)
            ? `rm -rf "${dir}"`
            : `rm -f "${dir}"/service-own.json "${dir}"/service-own.json.stale "${dir}"/opencode-own.db "${dir}"/opencode-own.db-wal "${dir}"/opencode-own.db-shm`,
        )
        .join("\n"),
    )
    const result = await hostSh(script)
    evidence("cleanup.txt", result.stdout + result.stderr)
    expect(result.stdout).toContain("CLEANUP_DONE=1")
    const after = await hostSh(SNAPSHOT_SCRIPT)
    evidence("after.txt", after.stdout)
    for (const dir of [
      "$HOME/.local/share/own-open-code",
      "$HOME/.config/own-open-code",
      "$HOME/.local/state/own-open-code",
      ...shared,
    ])
      if (wasAbsent.has(dir)) expect(absent(after.stdout).has(dir)).toBe(true)
    // Nothing of our /tmp namespace is left: /tmp/own-<uid> and /tmp/own-<uid>-* hold every fixture root of the suites
    // (team roots -team-<rand>, b/d's -rh-* projects) and the socket fallback, and the listing is checked whatever the
    // before listing had (a leftover of an interrupted run fails too). Other /tmp/own-* names are not ours: other work on the
    // shared host, possibly under the same account (so an owner check would not do). They are reported in
    // team-cleanup.json and never touched. A diff against before.txt would not do: a-transport
    // keeps the first before listing until the evidence is cleared, so a name made since then by other work would
    // fail it (RH-1).
    const ours = section(after.stdout, "== /tmp ours")
    expect(ours).toEqual(["none"])
    // Native modules a Bun run without TMPDIR left under /tmp (`/tmp/.bun-<uid>-*`) are gone too.
    expect(section(after.stdout, "== /tmp .bun-uid")).toEqual(["none"])
    expect(section(after.stdout, "== processes under our install")).toEqual(["none"])
    // ~/.gitconfig: read by git on the host, never written by own (06 §4.13, TG17).
    const gitconfig = { before: gitconfigBefore(before), after: section(after.stdout, "== gitconfig")[0] }
    evidence("team-cleanup.json", {
      gitconfig,
      tmpOwn: section(after.stdout, "== /tmp own-*"),
      tmpOthers: section(after.stdout, "== /tmp own-*").filter((entry) => entry !== "none" && !ours.includes(entry)),
      bunTmpBefore: section(before, "== /tmp .bun-uid"),
      bunTmpRemoved: Number(/BUN_TMP_REMOVED=(\d+)/.exec(result.stdout)?.[1] ?? 0),
      installRemoved: absent(after.stdout).has("$HOME/.local/share/own-open-code"),
    })
    // A before listing of an older suite version has no hash; then only c-team's record can tell (absent when run alone).
    if (gitconfig.before !== undefined) expect(gitconfig.after).toBe(gitconfig.before)
    // The XDG roots list the same entries as before (other programs of the user may add entries meanwhile: reported).
    const diff: Record<string, { added: string[]; removed: string[] }> = {}
    for (const header of before.split(/\r?\n/).filter((line) => line.startsWith("== ls "))) {
      const was = new Set(section(before, header))
      const now = new Set(section(after.stdout, header))
      diff[header] = {
        added: [...now].filter((entry) => !was.has(entry)),
        removed: [...was].filter((entry) => !now.has(entry)),
      }
      for (const entry of diff[header]!.added) expect(entry).not.toMatch(/own|opencode/i)
    }
    evidence("listing-diff.json", diff)
    // Local: no ssh.exe of ours is left (tunnels and helper forwards use the temp config).
    const left = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*own-real-host*' } | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout.trim()
    evidence("local-ssh-left.txt", left)
    expect(left).toBe("")
    // Every host's evidence folder stays (`evidence`, `evidence-<alias>`).
    for (const entry of fs.readdirSync(ROOT)) {
      if (entry === "evidence" || entry.startsWith("evidence-")) continue
      await removeTree(path.join(ROOT, entry))
    }
  }, 180_000)
})
