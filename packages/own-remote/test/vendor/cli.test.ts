// Vendored from packages/desktop/src/main/remote/cli.test.ts @ 00d179015f (MIT). See own/ledger/vendored.yaml
// own: reduced to what the partial copy keeps (quote, requireVersion, probeScript, verifyScript). Upstream runs the
// probe only on POSIX; here it runs in Git for Windows' shell with a `uname` shim (the fake-SSH harness setup).
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RemoteCli } from "../../src/vendor/remote/cli.js"
import * as Harness from "../harness/remote.js"

describe("RemoteCli (partial)", () => {
  test("quote and version validation", () => {
    expect(RemoteCli.quote("a'b")).toBe("'a'\\''b'")
    expect(RemoteCli.requireVersion("2.0.18-own.3")).toBe("2.0.18-own.3")
    expect(() => RemoteCli.requireVersion("local")).toThrow()
    expect(() => RemoteCli.requireVersion("1.0; rm -rf /")).toThrow()
  })

  const shell = Harness.available ? test : test.skip
  // Eight Git for Windows shells in a row: each start took 3-4 s on a busy PC (2.2.6-own.14 tier: 32 s alone, past
  // the unit tier's 30 s), so the test has its own cap.
  shell("the probe maps uname to upstream's targets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "own-remote-probe-"))
    try {
      const cases: Array<[string, string, string]> = [
        ["Linux", "x86_64", "linux-x64-baseline"],
        ["Linux", "aarch64", "linux-arm64"],
      ]
      for (const [system, machine, target] of cases) {
        fs.writeFileSync(path.join(dir, "uname"), `#!/bin/sh\ncase "\${1:-}" in -m) echo ${machine} ;; *) echo ${system} ;; esac\n`)
        const result = spawnSync(Harness.GIT_SH, ["-s"], {
          input: RemoteCli.probeScript,
          encoding: "utf8",
          env: { PATH: `${Harness.toPosix(dir)}:/usr/bin:/bin` },
          windowsHide: true,
        })
        expect(result.stdout.trim()).toBe(`OPENCODE_REMOTE_TARGET=${target}`)
      }
      // own: Git for Windows' shell is no host target. Its uname says MINGW64_NT under MSYSTEM MINGW64 and, in 2.56,
      // UCRT64 too (PortableGit 2.56.0.4, GU-12); MSYS2's own UCRT64 shell says UCRT64_NT.
      for (const system of ["MINGW64_NT", "UCRT64_NT"]) {
        const shim = `#!/bin/sh\ncase "\${1:-}" in -m) echo x86_64 ;; *) echo ${system} ;; esac\n`
        fs.writeFileSync(path.join(dir, "uname"), shim)
        const windows = spawnSync(Harness.GIT_SH, ["-s"], {
          input: RemoteCli.probeScript,
          encoding: "utf8",
          env: { PATH: `${Harness.toPosix(dir)}:/usr/bin:/bin` },
          windowsHide: true,
        })
        expect(`${system}: ${windows.status}`).toBe(`${system}: 2`)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
