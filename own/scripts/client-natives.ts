// The architecture-specific pieces of the 원격 PC 전용 desktop build (own/scripts/build-desktop-client.ps1,
// own/reports/win-arm64-2026-11-06.md) that this x64 PC's install does not have:
//   electron  electron-v<ver>-win32-<arch>.zip from Electron's GitHub release, the version own-desktop pins. Its sha256
//             must equal the one in the installed electron package's checksums.json (that package came through bun.lock's
//             integrity); unpacked once into the cache and handed to electron-builder as OWN_ELECTRON_DIST.
//   node-pty  @lydell/node-pty-win32-<arch>, the version bun.lock pins, from the npm registry. Its sha512 must equal
//             bun.lock's integrity; unpacked into packages/own-desktop/node_modules/@lydell/ for electron-builder to
//             pack (`--remove` takes it out again afterwards: bun never installs a foreign-arch optional package).
//   ffi-rs    @yuuang/ffi-rs-win32-<arch>-msvc, the binding the ffi-rs wrapper declares (the desktop's taskbar flash and
//             the browser pane's file verification), from the npm registry. Its sha512 must equal bun.lock's integrity
//             and one vetted before (VETTED below, decisions AF-1); unpacked beside the wrapper in bun's store, where
//             the main bundle resolves it into out/main/chunks, and removed again by `--remove`.
// All are cached under own/.out/cache/client-<arch> (re-verified on every use) and downloaded only when missing, so an
// offline release step runs from a warm cache. Nothing else is fetched; nothing is executed.
//
//   bun own/scripts/client-natives.ts --arch arm64 [--cache <dir>] [--offline]   prepare; prints JSON as the last line
//   bun own/scripts/client-natives.ts --arch arm64 --remove                     remove the unpacked node-pty folder
//   bun own/scripts/client-natives.ts --arch arm64 --fetch                      only download and verify into the cache
//                                                                            (an online step before an offline build)
// Exit: 0 done, 1 failed, 64 usage error.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { peMachine } from "./lib/pe"

const REPO = path.resolve(import.meta.dir, "..", "..")
const DESKTOP = path.join(REPO, "packages", "own-desktop")
/**
 * Foreign-arch ffi-rs bindings a person vetted before they ship (decisions AF-1: the registry metadata and signature,
 * the upstream CI run that built it, the PE's imports, strings and toolchain against the x64 sibling we already ship).
 * A new ffi-rs version stops the build here until it is vetted the same way and added.
 */
const VETTED: Readonly<Record<string, string>> = {
  "@yuuang/ffi-rs-win32-arm64-msvc@1.3.7":
    "sha512-ZfYzLV1w7Mhzh9XRScEMpw9oazIEiwO+0+TYHHRL882d5oD0Q99YikmRhdifsoHCCQefKmWF/4BXCeFkzg8NFA==",
}
const USAGE = "usage: bun own/scripts/client-natives.ts --arch arm64 [--cache <dir>] [--offline] [--fetch] [--remove]"

const args = await Promise.try(
  () =>
    parseArgs({
      options: {
        arch: { type: "string" },
        cache: { type: "string" },
        offline: { type: "boolean", default: false },
        remove: { type: "boolean", default: false },
        fetch: { type: "boolean", default: false },
      },
    }).values,
).catch((error: unknown) => {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  return process.exit(64)
})
if (args.arch !== "arm64" && args.arch !== "x64") {
  console.error(USAGE)
  process.exit(64)
}
const arch = args.arch
const ptyName = `@lydell/node-pty-win32-${arch}`
const ptyDir = path.join(DESKTOP, "node_modules", "@lydell", `node-pty-win32-${arch}`)
const ffiName = `@yuuang/ffi-rs-win32-${arch}-msvc`
/** The ffi-rs wrapper in bun's store (packages/desktop and gui-plugins share it); its bindings sit beside it. */
const ffiWrapper = fs.realpathSync(
  path.dirname(Bun.resolveSync("ffi-rs/package.json", path.join(REPO, "packages", "desktop"))),
)
const ffiDir = path.join(path.dirname(ffiWrapper), "@yuuang", `ffi-rs-win32-${arch}-msvc`)

const cache = path.resolve(args.cache ?? path.join(REPO, "own", ".out", "cache", `client-${arch}`))
/** Names the folders this script unpacked, one per line (kept outside them, so electron-builder never packs it). */
const unpackedMarker = path.join(cache, "node-pty-unpacked.txt")

if (args.remove) {
  // Only a real folder this script unpacked; a link bun made (this PC's own arch) stays.
  const ours = fs.existsSync(unpackedMarker)
    ? fs.readFileSync(unpackedMarker, "utf8").split(/\r?\n/).filter(Boolean)
    : []
  for (const dir of [ptyDir, ffiDir].filter((dir) => ours.includes(dir))) {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`removed ${dir}`)
  }
  fs.rmSync(unpackedMarker, { force: true })
  process.exit(0)
}

fs.mkdirSync(cache, { recursive: true })
const result = await prepare().catch((error: unknown) => {
  console.error(`client-natives: ${error instanceof Error ? error.message : String(error)}`)
  return process.exit(1)
})
console.log(JSON.stringify(result))

async function prepare() {
  const electron = await prepareElectron()
  const pty = await preparePty()
  const ffi = await prepareFfi()
  return { arch, cache, electron, pty, ffi }
}

async function prepareElectron() {
  const pkgDir = path.dirname(Bun.resolveSync("electron/package.json", DESKTOP))
  const version = (JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version: string })
    .version
  const zipName = `electron-v${version}-win32-${arch}.zip`
  const expected = (JSON.parse(fs.readFileSync(path.join(pkgDir, "checksums.json"), "utf8")) as Record<string, string>)[
    zipName
  ]
  if (!expected) throw new Error(`${zipName} is not in electron's checksums.json (${pkgDir})`)
  const zip = path.join(cache, zipName)
  await fetchVerified(
    zip,
    `https://github.com/electron/electron/releases/download/v${version}/${zipName}`,
    (bytes) => sha256(bytes) === expected,
    `sha256 ${expected} (electron ${version} checksums.json)`,
  )
  const dist = path.join(cache, `electron-v${version}-win32-${arch}`)
  const marker = path.join(dist, ".own-zip-sha256")
  if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== expected) {
    fs.rmSync(dist, { recursive: true, force: true })
    fs.mkdirSync(dist, { recursive: true })
    unpack(zip, dist)
    fs.writeFileSync(marker, expected)
  }
  const exe = path.join(dist, "electron.exe")
  const machine = peMachine(exe)
  if (machine !== arch) throw new Error(`${exe} is ${machine}, not ${arch}`)
  return { version, zip, sha256: expected, dist, machine }
}

async function preparePty() {
  const lock = fs.readFileSync(path.join(REPO, "bun.lock"), "utf8")
  const entry = new RegExp(
    `"${ptyName.replace("/", "\\/")}": \\["${ptyName.replace("/", "\\/")}@([^"]+)", "", \\{[^}]*\\}, "(sha512-[^"]+)"\\]`,
  ).exec(lock)
  if (!entry) throw new Error(`${ptyName} is not in bun.lock`)
  const version = entry[1]!
  const integrity = entry[2]!
  const file = path.join(cache, `node-pty-win32-${arch}-${version}.tgz`)
  await fetchVerified(
    file,
    `https://registry.npmjs.org/${ptyName}/-/node-pty-win32-${arch}-${version}.tgz`,
    (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}` === integrity,
    `${integrity} (bun.lock)`,
  )
  if (args.fetch) return { name: ptyName, version, integrity, file }
  const stat = fs.lstatSync(ptyDir, { throwIfNoEntry: false })
  if (stat?.isSymbolicLink()) throw new Error(`${ptyDir} is a link bun made: this PC already is ${arch}`)
  fs.rmSync(ptyDir, { recursive: true, force: true })
  const staging = fs.mkdtempSync(path.join(cache, "pty-"))
  try {
    unpack(file, staging)
    fs.cpSync(path.join(staging, "package"), ptyDir, { recursive: true })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  fs.writeFileSync(unpackedMarker, `${ptyDir}\n`)
  const natives = walk(ptyDir).filter((name) => /\.(node|dll|exe)$/i.test(name))
  const wrong = natives.map((name) => ({ name, machine: peMachine(name) })).filter((item) => item.machine !== arch)
  if (natives.length === 0 || wrong.length > 0)
    throw new Error(
      `${ptyName}: natives not all ${arch}: ${JSON.stringify(wrong.map((item) => [path.relative(ptyDir, item.name), item.machine]))}`,
    )
  return {
    name: ptyName,
    version,
    integrity,
    dir: ptyDir,
    natives: natives.map((name) => path.relative(ptyDir, name).replaceAll("\\", "/")),
  }
}

async function prepareFfi() {
  const version = (
    JSON.parse(fs.readFileSync(path.join(ffiWrapper, "package.json"), "utf8")) as {
      optionalDependencies?: Record<string, string>
    }
  ).optionalDependencies?.[ffiName]
  if (!version) throw new Error(`ffi-rs (${ffiWrapper}) declares no ${ffiName}`)
  // bun.lock may list it under the wrapper ("ffi-rs/@yuuang/…") when another dependant pins an older one at the top.
  const lock = fs.readFileSync(path.join(REPO, "bun.lock"), "utf8")
  const at = lock.indexOf(`["${ffiName}@${version}", "", {`)
  const integrity = at === -1 ? undefined : /^"[^"]+", "", \{[^}]*\}, "(sha512-[^"]+)"\]/.exec(lock.slice(at + 1))?.[1]
  if (!integrity) throw new Error(`${ffiName}@${version} is not in bun.lock`)
  if (VETTED[`${ffiName}@${version}`] !== integrity)
    throw new Error(
      `${ffiName}@${version} (${integrity}) has not been vetted: vet it as decisions AF-1 did, then add it to VETTED`,
    )
  const file = path.join(cache, `ffi-rs-win32-${arch}-msvc-${version}.tgz`)
  await fetchVerified(
    file,
    `https://registry.npmjs.org/${ffiName}/-/ffi-rs-win32-${arch}-msvc-${version}.tgz`,
    (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}` === integrity,
    `${integrity} (bun.lock, vetted)`,
  )
  if (args.fetch) return { name: ffiName, version, integrity, file }
  const stat = fs.lstatSync(ffiDir, { throwIfNoEntry: false })
  if (stat?.isSymbolicLink()) throw new Error(`${ffiDir} is a link bun made: this PC already is ${arch}`)
  fs.rmSync(ffiDir, { recursive: true, force: true })
  const staging = fs.mkdtempSync(path.join(cache, "ffi-"))
  try {
    unpack(file, staging)
    fs.cpSync(path.join(staging, "package"), ffiDir, { recursive: true })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  fs.appendFileSync(unpackedMarker, `${ffiDir}\n`)
  const addon = path.join(ffiDir, `ffi-rs.win32-${arch}-msvc.node`)
  const machine = fs.existsSync(addon) ? peMachine(addon) : "missing"
  if (machine !== arch) throw new Error(`${ffiName}: ${addon} is ${machine}, not ${arch}`)
  return { name: ffiName, version, integrity, dir: ffiDir, addon: path.basename(addon), machine }
}

/** The cached file when it verifies; else (online) a fresh download that must verify before it is kept. */
async function fetchVerified(file: string, url: string, verify: (bytes: Buffer) => boolean, what: string) {
  if (fs.existsSync(file) && verify(fs.readFileSync(file))) return
  if (args.offline)
    throw new Error(`${path.basename(file)} is missing or does not verify in ${cache}, and --offline was given`)
  console.error(`downloading ${url}`)
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!verify(bytes)) throw new Error(`${url} does not match ${what}; not kept`)
  fs.writeFileSync(`${file}.part`, bytes)
  fs.renameSync(`${file}.part`, file)
}

/** Windows' own bsdtar (System32\tar.exe) reads both .zip and .tgz. */
function unpack(archive: string, into: string) {
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  const run = spawnSync(tar, ["-xf", archive, "-C", into], { encoding: "utf8", windowsHide: true })
  if (run.status !== 0)
    throw new Error(`tar -xf ${archive}: ${run.status ?? run.error?.message} ${(run.stderr ?? "").slice(-400)}`)
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(file)
    return entry.isFile() ? [file] : []
  })
}
