// Team screens (06 §9, TG20; 07 §7.4) in the installed Microsoft Edge against backend.ts: the real server from source
// with own-accounts, own-team and own-computer-use (fake desktop), fake model providers driven by own-team's directive
// responder, and own-web through Vite dev on a PC port and a gateway-device port.
//
//   bun run test:e2e:team            (from packages/own-web)
//
// Three projects on the one backend, in this order (one worker): `t1` is team.spec.ts (T1's screens), `t2` the T2 specs
// (t2-*.spec.ts: 팀에 넣기 / 빼기, 반영하기, settings 팀, 결정 적기, 새 영역) and `t3` the T3 specs (t3-*.spec.ts:
// reorganizing, removal and system-change confirms, 끝난 영역 정리하고 끄기, a remote host's large-file tool and its
// mirrored presets), each in a project of its own in the backend. team.spec.ts reads the first project of the list and
// expects no other team on, so it runs first; each T2 and T3 spec turns its team off again when it ends.
//
// Own ports (5761, 5762) and temp directory, so it runs next to the other suites. The main e2e/playwright.config.ts
// ignores this folder; the specs also skip themselves without this backend.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_TEAM_E2E_PORT ?? 5761)
const tmp = process.env.OWN_WEB_TEAM_E2E_TMP ?? path.join(os.tmpdir(), "own-web-team")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: tests read the backend state file under this temp directory.
process.env.OWN_WEB_TEAM_E2E_TMP = tmp
process.env.OWN_WEB_TEAM_E2E_PORT = String(port)

export default defineConfig({
  testDir: ".",
  projects: [
    { name: "t1", testMatch: /team\.spec\.ts$/ },
    { name: "t2", testMatch: /t2-[a-z]+\.spec\.ts$/ },
    { name: "t3", testMatch: /t3-[a-z]+\.spec\.ts$/ },
  ],
  outputDir: path.join(tmp, "results"),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/team/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    // RH-51: the backend boots every listed conversation's folder Location before its port answers. At 100 % CPU from
    // other work its boot took 7 min before those and they 4 min more (2026-10-31); 300 s ran out once before (RH-49).
    timeout: 1_200_000,
    reuseExistingServer: !!process.env.OWN_WEB_TEAM_E2E_REUSE,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_TEAM_E2E_PORT: String(port), OWN_WEB_TEAM_E2E_TMP: tmp, TEMP: tmp, TMP: tmp },
  },
  use: {
    channel: "msedge",
    headless: true,
    baseURL: `http://127.0.0.1:${port}`,
    locale: "ko-KR",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
})
