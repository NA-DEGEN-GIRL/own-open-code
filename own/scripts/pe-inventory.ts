// PE inventory of a release (P1-15, own/reports/external-repos-2026-10-05.md: Smart App Control readiness). Every PE
// image the release ships is found by content, not by extension: `MZ`, then at the DOS header's e_lfanew (0x3c) the
// `PE\0\0` signature and a whole 20-byte COFF header. Links and junctions are not followed. Each PE gets its path, size,
// sha256, COFF machine (x64, arm64, x86: the Windows ARM64 client build, own/reports/win-arm64-2026-11-06.md) and
// Authenticode status and signer. One Get-AuthenticodeSignature call in one Windows PowerShell process reads
// the whole list. Read only: nothing is signed, unblocked or allowed. The inventory shows which fresh unsigned hashes a
// release brings (own's PEs are unsigned, FORK §8.2), and release-smoke's Code Integrity check shows whether one was
// blocked. The approach follows dsh's apps/desktop/scripts/windows-runtime-signature.mjs (MIT); no code is taken from it.
//
//   bun own/scripts/pe-inventory.ts [--root <dir>] [--version <ver>] [--out <file>]
//   bun own/scripts/pe-inventory.ts --self-test          # synthetic headers in a temp folder, checked
// --root defaults to the newest build under own/.out/build. A build folder (one with app\manifest.json) is read in its
// shipped parts: app\ (installed as app\<ver>\), desktop\ (the shell's win-unpacked\ and the installer) and, when built,
// desktop-client-arm64\ (the Windows ARM64 client). Any other root is read whole. The inventory is written to --out, else to own/release/<version>/pe-inventory.json (the version is
// --version, else the build manifest's). With neither, it is only printed as the last line.
// Exit: 0 done (self-test: passed), 1 failed, 64 usage error.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { peMachine } from "./lib/pe"

const REPO = path.resolve(import.meta.dir, "..", "..")
const USAGE = "usage: bun own/scripts/pe-inventory.ts [--root <dir>] [--version <ver>] [--out <file>] | --self-test"
/** Get-AuthenticodeSignature over the JSON path list on stdin; UTF-8 JSON on the raw stdout, in the input's order. */
const SIGNATURES = [
  "$ErrorActionPreference = 'Stop'",
  "$paths = [string[]]([IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false)).ReadToEnd() | ConvertFrom-Json)",
  "$rows = @(Get-AuthenticodeSignature -LiteralPath $paths | ForEach-Object { @{ status = $_.Status.ToString(); signer = $_.SignerCertificate.Subject } })",
  "$bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $rows -Compress))",
  "[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
].join("\n")

// An unknown or incomplete option is a usage error.
const args = await Promise.try(
  () =>
    parseArgs({
      options: {
        root: { type: "string" },
        version: { type: "string" },
        out: { type: "string" },
        "self-test": { type: "boolean", default: false },
      },
    }).values,
).catch((error: unknown) => {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  return process.exit(64)
})

const code = await (args["self-test"] ? selfTest() : run()).catch((error: unknown) => {
  console.error(`pe-inventory: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
process.exit(code)

async function run() {
  const report = await inventory(path.resolve(args.root ?? newestBuild()), args.version)
  for (const file of report.files) console.log(`  ${file.status.padEnd(22)} ${file.path}`)
  console.log(
    `${report.summary.files} PE files, ${report.summary.bytes} bytes: ${Object.entries(report.summary.status)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ")}`,
  )
  const out = args.out
    ? path.resolve(args.out)
    : report.version
      ? path.join(REPO, "own", "release", report.version, "pe-inventory.json")
      : undefined
  if (!out) {
    console.log("not written: no release version (pass --version or --out)")
    console.log(JSON.stringify(report))
    return 0
  }
  await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`inventory: ${out}`)
  return 0
}

/** The inventory of `root`: a build in its shipped parts, any other folder whole. */
async function inventory(root: string, version: string | undefined) {
  const manifest = path.join(root, "app", "manifest.json")
  const build = fs.existsSync(manifest)
  const parts = build
    ? ["app", "desktop", "desktop-client-arm64"].filter((part) => fs.existsSync(path.join(root, part)))
    : ["."]
  const images = parts
    .flatMap((part) => walk(path.join(root, part)))
    .filter(isPE)
    .sort()
  const signed = signatures(images)
  const files = await Promise.all(
    images.map(async (file, index) => ({
      path: path.relative(root, file).replaceAll("\\", "/"),
      bytes: Bun.file(file).size,
      sha256: await sha256(file),
      machine: peMachine(file),
      status: signed[index]!.status,
      signer: signed[index]!.signer,
    })),
  )
  const shown = path.relative(REPO, root)
  return {
    version:
      version ??
      (build
        ? (JSON.parse(fs.readFileSync(manifest, "utf8").replace(/^\uFEFF/, "")) as { version: string }).version
        : null),
    root: shown.startsWith("..") || path.isAbsolute(shown) ? root : shown.replaceAll("\\", "/"),
    scanned: parts,
    created_at: new Date().toISOString(),
    summary: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      status: files.reduce<Record<string, number>>(
        (counts, file) => ({ ...counts, [file.status]: (counts[file.status] ?? 0) + 1 }),
        {},
      ),
    },
    files,
  }
}

/** Regular files under `dir`. Directory entries come from lstat, so links and junctions are neither files nor folders. */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(file)
    return entry.isFile() ? [file] : []
  })
}

/** `MZ`, and at the DOS header's e_lfanew the `PE\0\0` signature followed by a whole COFF file header (20 bytes). */
function isPE(file: string) {
  const fd = fs.openSync(file, "r")
  try {
    const dos = Buffer.alloc(0x40)
    if (fs.readSync(fd, dos, 0, 0x40, 0) < 0x40 || dos.toString("latin1", 0, 2) !== "MZ") return false
    const nt = Buffer.alloc(24)
    return fs.readSync(fd, nt, 0, 24, dos.readUInt32LE(0x3c)) === 24 && nt.toString("latin1", 0, 4) === "PE\0\0"
  } finally {
    fs.closeSync(fd)
  }
}

async function sha256(file: string) {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}

/**
 * Authenticode status (`Valid`, `NotSigned`, `HashMismatch`, …) and signer subject of every file, in order. Paths go in
 * and results come out as UTF-8 JSON on the raw standard streams, so non-ASCII paths and subjects survive the console
 * code page. Windows PowerShell started from a PowerShell 7 session inherits 7's PSModulePath and then cannot load its
 * own Microsoft.PowerShell.Security, so the variable is left out and it uses its default module path.
 */
function signatures(files: string[]) {
  if (files.length === 0) return []
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", SIGNATURES], {
    input: JSON.stringify(files),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH")),
  })
  if (result.status !== 0)
    throw new Error(
      `Get-AuthenticodeSignature failed (${result.status ?? result.error?.message}): ${(result.stderr ?? "").trim().slice(-600)}`,
    )
  const rows = JSON.parse(result.stdout) as { status: string; signer: string | null }[]
  if (rows.length !== files.length)
    throw new Error(`Get-AuthenticodeSignature answered ${rows.length} of ${files.length} files`)
  return rows
}

function newestBuild() {
  const root = path.join(REPO, "own", ".out", "build")
  const dirs = fs
    .readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, "app", "manifest.json")))
    .map((name) => ({ name, at: fs.statSync(path.join(root, name, "app", "manifest.json")).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  if (!dirs[0]) throw new Error(`no build with app\\manifest.json under ${root} (build-desktop.ps1 first)`)
  return path.join(root, dirs[0].name)
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Synthetic headers in a temp folder: PEs without an extension and under a non-ASCII name with wildcard characters,
 * a 16-bit NE stub, an e_lfanew past the end, a signature without a whole COFF header, a short file and a junction to
 * a folder of PEs. A copy of the system's catalog-signed cmd.exe joins the same batch, so one call shows the unsigned
 * synthetic PEs (`NotSigned`, or `UnknownError` for a header Windows cannot parse) and `Valid` with a signer in order.
 */
async function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "own-pe-inventory-"))
  const header = (offset: number, signature: string, size = 0x200) => {
    const bytes = Buffer.alloc(size)
    bytes.write("MZ", 0, "latin1")
    bytes.writeUInt32LE(offset, 0x3c)
    if (offset < size) bytes.write(signature, offset, "latin1")
    return bytes
  }
  const pes = {
    tool: header(0x80, "PE\0\0\x64\x86"),
    "nested/addon.node": header(0x40, "PE\0\0"),
    "한글 [1].dll": header(0xe8, "PE\0\0"),
  }
  const others = {
    "dos.exe": header(0x80, "NE"),
    "far.exe": header(0x1000, "PE\0\0"),
    "cut.exe": header(0x1f0, "PE\0\0"),
    "short.exe": Buffer.from("MZ"),
    "readme.txt": Buffer.from("not an image\n"),
  }
  for (const [name, bytes] of Object.entries({ ...pes, ...others })) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), bytes)
  }
  fs.symlinkSync(path.join(dir, "nested"), path.join(dir, "linked"), "junction")
  const comspec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
  fs.mkdirSync(path.join(dir, "system"))
  fs.copyFileSync(comspec, path.join(dir, "system", "cmd.exe"))

  const report = await inventory(dir, "0.0.0-selftest").finally(() => fs.rmSync(dir, { recursive: true, force: true }))
  const byPath = new Map(report.files.map((file) => [file.path, file]))
  const synthetic = Object.entries(pes)
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    [
      "PEs found by content (no extension needed); NE stub, far or cut header, short and text files and the junction left out",
      report.files.map((file) => file.path).join(",") === [...Object.keys(pes), "system/cmd.exe"].sort().join(","),
    ],
    [
      "size and sha256 of each synthetic PE",
      synthetic.every(
        ([name, bytes]) =>
          byPath.get(name)?.bytes === bytes.length &&
          byPath.get(name)?.sha256 === createHash("sha256").update(bytes).digest("hex"),
      ),
    ],
    [
      "machine from the COFF header: x64 for the AMD64 header, arm64 or x64 for the system's cmd.exe",
      byPath.get("tool")?.machine === "x64" &&
        ["x64", "arm64"].includes(byPath.get("system/cmd.exe")?.machine ?? "") &&
        byPath.get("nested/addon.node")?.machine === "unknown:0x0",
    ],
    [
      "one batch: the synthetic PEs not Valid, without a signer",
      synthetic.every(([name]) => byPath.get(name)?.status !== "Valid" && byPath.get(name)?.signer === null),
    ],
    [
      "one batch: the copied cmd.exe Valid, signed by Microsoft",
      byPath.get("system/cmd.exe")?.status === "Valid" && !!byPath.get("system/cmd.exe")?.signer?.includes("Microsoft"),
    ],
    [
      "summary counts and the version given",
      report.version === "0.0.0-selftest" &&
        report.summary.files === 4 &&
        report.summary.status.Valid === 1 &&
        Object.values(report.summary.status).reduce((total, count) => total + count, 0) === 4,
    ],
  ]
  for (const [name, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`)
  const passed = checks.every((check) => check[1])
  if (!passed) console.log(JSON.stringify(report.files))
  console.log(passed ? "self-test ok" : "self-test FAILED")
  return passed ? 0 : 1
}
