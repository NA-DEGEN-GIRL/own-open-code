// Static checks of a 원격 PC 전용 desktop build (own/scripts/build-desktop-client.ps1, own/reports/win-arm64-2026-11-06.md)
// that run on this x64 PC: nothing is installed or started, the ARM64 code is only read. Used by
// own/scripts/client-check.ts (standalone, and by build-desktop-client.ps1) and own/scripts/release-smoke.ts (when the
// build has a desktop-client-<arch> folder).
//   - layout: the installer own-desktop-client-<version>-win-<arch>.exe and win-<arch>-unpacked\own-desktop.exe
//   - PE machine: every PE image under win-<arch>-unpacked is <arch>, except electron-builder's elevate.exe (x86 in the
//     x64 build too, run only to elevate a per-machine install, which own never does); the NSIS stub is x86 by design
//   - app.asar: the remote-client page as the renderer, the client switch compiled into main, the <arch> node-pty
//     prebuild and no other, no updater; no own-payload, no app-update.yml (G-D2's checks of the full shell)
//   - the main bundle's ffi-rs binding (out/main/chunks, unpacked): the <arch> one and no other
//     (packages/own-desktop/build/ffi-binding.ts; client-natives.ts unpacks the vetted ARM64 one)
//   - the installer's archive (with 7-Zip when present): app-<arch>.7z and no payload
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { peMachine } from "./pe"

export interface ClientCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail?: unknown
}

/** Files electron-builder adds whose machine is not the app's (see above). */
export const FOREIGN_ALLOWED: Readonly<Record<string, string>> = { "resources/elevate.exe": "x86" }
/** The client installer stays far below the full one (no service payload): ~111 MiB for ARM64 Electron 44. */
export const CLIENT_INSTALLER_BUDGET = 160 * 1024 * 1024

export function clientFolder(build: string, arch: string) {
  return path.join(build, `desktop-client-${arch}`)
}

export function inspectClientBuild(input: {
  readonly dir: string
  readonly version: string
  readonly arch: "arm64" | "x64"
  /** 7-Zip for the installer listing; default: found in Program Files; `false` skips it (synthetic tests). */
  readonly sevenZip?: string | false
  /** `false` for a build-desktop-client.ps1 -NoInstaller build: only win-<arch>-unpacked is required. */
  readonly installer?: boolean
}) {
  const checks: ClientCheck[] = []
  const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail })
  const installer = path.join(input.dir, `own-desktop-client-${input.version}-win-${input.arch}.exe`)
  const unpacked = path.join(input.dir, input.arch === "x64" ? "win-unpacked" : `win-${input.arch}-unpacked`)
  const exe = path.join(unpacked, "own-desktop.exe")
  const withInstaller = input.installer !== false
  check(
    withInstaller
      ? "client: installer and own-desktop.exe exist"
      : "client: own-desktop.exe exists (no installer asked)",
    (!withInstaller || fs.existsSync(installer)) && fs.existsSync(exe),
    withInstaller ? { installer, exe } : { exe },
  )
  if (!fs.existsSync(exe)) return { checks, installer, unpacked, images: [] }

  const images = walk(unpacked)
    .map((file) => ({ path: path.relative(unpacked, file).replaceAll("\\", "/"), machine: peMachine(file) }))
    .filter((image) => image.machine !== "not-pe")
  check(`client: own-desktop.exe is ${input.arch}`, peMachine(exe) === input.arch, peMachine(exe))
  const foreign = images.filter(
    (image) => image.machine !== input.arch && FOREIGN_ALLOWED[image.path] !== image.machine,
  )
  check(
    `client: every PE image in the shell is ${input.arch} (elevate.exe x86 allowed)`,
    images.length > 0 && foreign.length === 0,
    foreign,
  )
  const natives = images.filter((image) => /\.node$/i.test(image.path))
  check(
    `client: native addons present and ${input.arch}`,
    natives.length > 0 && natives.every((image) => image.machine === input.arch),
    natives,
  )
  const ffi = natives.filter((image) => path.basename(image.path).startsWith("ffi-rs."))
  check(
    `client: ffi-rs binding for win32-${input.arch} only`,
    ffi.length === 1 &&
      ffi[0]!.path.startsWith("resources/app.asar.unpacked/out/main/chunks/") &&
      path.basename(ffi[0]!.path).startsWith(`ffi-rs.win32-${input.arch}-msvc-`),
    ffi,
  )
  if (fs.existsSync(installer)) {
    const bytes = fs.statSync(installer).size
    check(`client: installer <= ${CLIENT_INSTALLER_BUDGET / 1024 / 1024} MiB`, bytes <= CLIENT_INSTALLER_BUDGET, bytes)
    check(
      "client: installer stub is NSIS x86 (runs on ARM64 Windows by emulation)",
      peMachine(installer) === "x86",
      peMachine(installer),
    )
  }

  const resources = path.join(unpacked, "resources")
  const asar = path.join(resources, "app.asar")
  const entries = asarEntries(asar)
  const names = new Set(entries.keys())
  const page = asarText(asar, entries, "out/renderer/index.html") ?? ""
  check(
    "client: the renderer is the remote-client page",
    page.includes('data-testid="own-client"') && !page.includes('data-testid="own-fallback"'),
  )
  const main = [...names]
    .filter((name) => /^out\/main\/.*\.js$/.test(name))
    .map((name) => asarText(asar, entries, name) ?? "")
  check(
    "client: main carries the client switch (no service discovery)",
    main.some((text) => text.includes("원격 PC 전용 빌드라 이 PC의 서비스를 쓰지 않아요")),
  )
  check(
    "client: no protocol claim, no upstream app id in main (G-D2)",
    main.length > 0 &&
      main.every((text) => !text.includes("setAsDefaultProtocolClient") && !text.includes("ai.opencode.desktop")),
  )
  const ptyPackages = [
    ...new Set([...names].map((name) => /node_modules\/@lydell\/(node-pty-[^/]+)\//.exec(name)?.[1]).filter(Boolean)),
  ]
  check(
    `client: node-pty prebuild for win32-${input.arch} only`,
    ptyPackages.join(",") === `node-pty-win32-${input.arch}`,
    ptyPackages,
  )
  check(
    "client: no updater, no payload, no app-update.yml",
    ![...names].some((name) => name.includes("node_modules/electron-updater/")) &&
      !fs.existsSync(path.join(resources, "own-payload")) &&
      !fs.existsSync(path.join(resources, "app-update.yml")),
  )

  const sevenZip = input.sevenZip === undefined ? findSevenZip() : input.sevenZip || undefined
  if (sevenZip && fs.existsSync(installer)) {
    const listing = spawnSync(sevenZip, ["l", "-ba", installer], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    const text = listing.stdout ?? ""
    check(
      `client: installer holds app-${input.arch}.7z and no payload`,
      listing.status === 0 &&
        text.includes(`app-${input.arch}.7z`) &&
        !text.includes("own-payload") &&
        !text.includes("own-preflight.ps1"),
      listing.status,
    )
  } else check("client: installer listing skipped (no 7-Zip)", true, "skipped")
  return { checks, installer, unpacked, images }
}

/** Files of an app.asar (header: pickle sizes, then a JSON tree; data after the header pickle). */
function asarEntries(file: string) {
  const fd = fs.openSync(file, "r")
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerPickle = head.readUInt32LE(4)
    const json = Buffer.alloc(head.readUInt32LE(12))
    fs.readSync(fd, json, 0, json.length, 16)
    type Node = { files?: Record<string, Node>; offset?: string; size?: number; unpacked?: boolean }
    const entries = new Map<string, { offset: number; size: number; unpacked: boolean }>()
    const visit = (node: Node, prefix: string) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const full = prefix ? `${prefix}/${name}` : name
        if (child.files) visit(child, full)
        else
          entries.set(full, {
            offset: 8 + headerPickle + Number(child.offset ?? 0),
            size: child.size ?? 0,
            unpacked: !!child.unpacked,
          })
      }
    }
    visit(JSON.parse(json.toString("utf8")) as Node, "")
    return entries
  } finally {
    fs.closeSync(fd)
  }
}

function asarText(file: string, entries: ReturnType<typeof asarEntries>, name: string) {
  const entry = entries.get(name)
  if (!entry || entry.unpacked) return undefined
  const fd = fs.openSync(file, "r")
  try {
    const bytes = Buffer.alloc(entry.size)
    fs.readSync(fd, bytes, 0, entry.size, entry.offset)
    return bytes.toString("utf8")
  } finally {
    fs.closeSync(fd)
  }
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(file)
    return entry.isFile() ? [file] : []
  })
}

function findSevenZip() {
  const roots = [process.env.ProgramFiles, process.env.ProgramW6432, process.env["ProgramFiles(x86)"]].filter(
    Boolean,
  ) as string[]
  return roots.map((root) => path.join(root, "7-Zip", "7z.exe")).find((file) => fs.existsSync(file))
}
