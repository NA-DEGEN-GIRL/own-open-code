// Static checks of a 원격 PC 전용 desktop build on this x64 PC (lib/client-build.ts), plus its signature inventory:
// own/scripts/pe-inventory.ts over the client folder (every PE with its sha256 and Authenticode status; own's builds are
// unsigned, FORK §8.2, so the inventory lists what Smart App Control will see as fresh hashes on the device).
//
//   bun own/scripts/client-check.ts --dir <out>\desktop-client-arm64 --version <ver> [--arch arm64] [--no-inventory]
//        [--no-installer]   (a build-desktop-client.ps1 -NoInstaller build: win-<arch>-unpacked only)
// Prints one line per check and a JSON report as the last line (also written to <dir>\client-check.json).
// Exit: 0 all passed, 1 a check failed, 64 usage error.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { inspectClientBuild } from "./lib/client-build"

const USAGE =
  "usage: bun own/scripts/client-check.ts --dir <desktop-client-arm64> --version <ver> [--arch arm64|x64] [--no-inventory] [--no-installer]"
const args = await Promise.try(
  () =>
    parseArgs({
      options: {
        dir: { type: "string" },
        version: { type: "string" },
        arch: { type: "string", default: "arm64" },
        "no-inventory": { type: "boolean", default: false },
        "no-installer": { type: "boolean", default: false },
      },
    }).values,
).catch((error: unknown) => {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  return process.exit(64)
})
if (!args.dir || !args.version || (args.arch !== "arm64" && args.arch !== "x64")) {
  console.error(USAGE)
  process.exit(64)
}
const dir = path.resolve(args.dir)
const result = inspectClientBuild({ dir, version: args.version, arch: args.arch, installer: !args["no-installer"] })
const checks = [...result.checks]
let inventory: unknown
if (!args["no-inventory"]) {
  const out = path.join(dir, "pe-inventory.json")
  const run = spawnSync(
    process.execPath,
    [path.join(import.meta.dir, "pe-inventory.ts"), "--root", dir, "--version", args.version, "--out", out],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  const report =
    run.status === 0 && fs.existsSync(out)
      ? (JSON.parse(fs.readFileSync(out, "utf8")) as {
          summary: { files: number; status: Record<string, number> }
          files: { path: string; status: string; machine?: string }[]
        })
      : undefined
  inventory = report ? { file: out, summary: report.summary } : { error: (run.stderr ?? "").slice(-400) }
  checks.push({
    name: "client: signature inventory written (installer, shell and natives listed with their Authenticode status)",
    ok:
      !!report &&
      report.files.some((file) => file.path.endsWith("own-desktop.exe")) &&
      (args["no-installer"] || report.files.some((file) => file.path.endsWith(".exe") && !file.path.includes("/"))),
    detail: report?.summary ?? inventory,
  })
}
for (const item of checks)
  console.log(
    `  ${item.ok ? "ok  " : "FAIL"} ${item.name}${item.detail === undefined ? "" : `  ${JSON.stringify(item.detail).slice(0, 300)}`}`,
  )
const passed = checks.every((item) => item.ok)
const report = {
  dir,
  version: args.version,
  arch: args.arch,
  installer: result.installer,
  images: result.images,
  inventory,
  checks: Object.fromEntries(checks.map((item) => [item.name, item.ok])),
  passed,
  checked_at: new Date().toISOString(),
}
fs.writeFileSync(path.join(dir, "client-check.json"), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ passed, checks: report.checks }))
process.exit(passed ? 0 : 1)
