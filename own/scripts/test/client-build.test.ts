// lib/client-build.ts and lib/pe.ts on a synthetic client folder (PE headers with chosen machines, a small app.asar):
// what passes, and each way a cross-built ARM64 client can come out wrong. Run from own/scripts/test:
// `bun test ./client-build.test.ts`.
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { inspectClientBuild } from "../lib/client-build"
import { peMachine } from "../lib/pe"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-client-build-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const MACHINE = { x64: 0x8664, arm64: 0xaa64, x86: 0x014c } as const
const VERSION = "2.2.5-own.9"

function pe(machine: keyof typeof MACHINE) {
  const bytes = Buffer.alloc(0x200)
  bytes.write("MZ", 0, "latin1")
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write("PE\0\0", 0x80, "latin1")
  bytes.writeUInt16LE(MACHINE[machine], 0x84)
  return bytes
}

/** An asar with the given files (header pickle: 4, size, size-4, string length; data after it). */
function asar(files: Record<string, string>) {
  const tree: { files: Record<string, unknown> } = { files: {} }
  const chunks: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const parts = name.split("/")
    let node = tree
    for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} }) as typeof tree
    const data = Buffer.from(text)
    node.files[parts.at(-1)!] = { size: data.length, offset: String(offset) }
    chunks.push(data)
    offset += data.length
  }
  const json = Buffer.from(JSON.stringify(tree))
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4)
  json.copy(padded)
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(padded.length + 8, 4)
  head.writeUInt32LE(padded.length + 4, 8)
  head.writeUInt32LE(json.length, 12)
  return Buffer.concat([head, padded, ...chunks])
}

function client(
  name: string,
  change: {
    machine?: keyof typeof MACHINE
    page?: string
    main?: string
    pty?: string[]
    ffi?: string[]
    payload?: boolean
    installer?: boolean
  } = {},
) {
  const dir = path.join(root, name)
  const unpacked = path.join(dir, "win-arm64-unpacked")
  const write = (file: string, bytes: Buffer | string) => {
    fs.mkdirSync(path.dirname(path.join(unpacked, file)), { recursive: true })
    fs.writeFileSync(path.join(unpacked, file), bytes)
  }
  write("own-desktop.exe", pe(change.machine ?? "arm64"))
  write("ffmpeg.dll", pe("arm64"))
  write("resources/elevate.exe", pe("x86"))
  const pty = change.pty ?? ["node-pty-win32-arm64"]
  for (const pkg of pty)
    write(
      `resources/app.asar.unpacked/node_modules/@lydell/${pkg}/prebuilds/conpty.node`,
      pe(pkg.endsWith("x64") ? "x64" : "arm64"),
    )
  for (const binding of change.ffi ?? ["win32-arm64-msvc"])
    write(
      `resources/app.asar.unpacked/out/main/chunks/ffi-rs.${binding}-Ab1-cD2_.node`,
      pe(binding.includes("arm64") ? "arm64" : binding.includes("ia32") ? "x86" : "x64"),
    )
  const files: Record<string, string> = {
    "out/renderer/index.html": change.page ?? '<main data-testid="own-client"></main>',
    "out/main/desktop-1.js": change.main ?? "fail(`원격 PC 전용 빌드라 이 PC의 서비스를 쓰지 않아요`)",
    "package.json": "{}",
  }
  for (const pkg of pty) files[`node_modules/@lydell/${pkg}/package.json`] = "{}"
  write("resources/app.asar", asar(files))
  if (change.payload) write("resources/own-payload/app/manifest.json", "{}")
  if (change.installer !== false)
    fs.writeFileSync(path.join(dir, `own-desktop-client-${VERSION}-win-arm64.exe`), pe("x86"))
  return inspectClientBuild({ dir, version: VERSION, arch: "arm64", sevenZip: false, installer: change.installer })
}

const failed = (result: ReturnType<typeof client>) => result.checks.filter((item) => !item.ok).map((item) => item.name)

test("pe: machine from the COFF header", () => {
  const file = path.join(root, "one.dll")
  fs.writeFileSync(file, pe("arm64"))
  expect(peMachine(file)).toBe("arm64")
  fs.writeFileSync(file, "MZ not a pe")
  expect(peMachine(file)).toBe("not-pe")
})

test("a good ARM64 client passes; elevate.exe may stay x86", () => {
  const result = client("good")
  expect(failed(result)).toEqual([])
  expect(result.images.find((image) => image.path === "resources/elevate.exe")?.machine).toBe("x86")
})

test("an x64 shell (the cached x64 Electron packaged) fails", () => {
  expect(failed(client("x64-shell", { machine: "x64" }))).toEqual([
    "client: own-desktop.exe is arm64",
    "client: every PE image in the shell is arm64 (elevate.exe x86 allowed)",
  ])
})

test("the full shell's fallback page or main without the switch fails", () => {
  expect(failed(client("fallback", { page: '<section data-testid="own-fallback"></section>' }))).toEqual([
    "client: the renderer is the remote-client page",
  ])
  expect(failed(client("no-switch", { main: "discover()" }))).toEqual([
    "client: main carries the client switch (no service discovery)",
  ])
})

test("an x64 node-pty next to the ARM64 one, or a payload, fails", () => {
  expect(failed(client("both-pty", { pty: ["node-pty-win32-arm64", "node-pty-win32-x64"] }))).toEqual([
    "client: every PE image in the shell is arm64 (elevate.exe x86 allowed)",
    "client: native addons present and arm64",
    "client: node-pty prebuild for win32-arm64 only",
  ])
  expect(failed(client("payload", { payload: true }))).toEqual(["client: no updater, no payload, no app-update.yml"])
})

test("the ARM64 ffi-rs binding must be there, alone", () => {
  expect(failed(client("no-ffi", { ffi: [] }))).toEqual(["client: ffi-rs binding for win32-arm64 only"])
  expect(failed(client("x64-ffi", { ffi: ["win32-arm64-msvc", "win32-x64-msvc", "win32-ia32-msvc"] }))).toEqual([
    "client: every PE image in the shell is arm64 (elevate.exe x86 allowed)",
    "client: native addons present and arm64",
    "client: ffi-rs binding for win32-arm64 only",
  ])
})

test("a -NoInstaller build passes without the installer only when none was asked", () => {
  expect(failed(client("no-installer", { installer: false }))).toEqual([])
  const dir = path.join(root, "no-installer")
  expect(failed(inspectClientBuild({ dir, version: VERSION, arch: "arm64", sevenZip: false }))).toEqual([
    "client: installer and own-desktop.exe exist",
  ])
})
