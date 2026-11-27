// script/native.ts against a temp "repository" and a loopback registry: lockfile pins and integrity, the link sites of
// Bun's isolated layout, junctions in and out, and a tampered tarball refused. git-lfs (06 §4.13): the pinned release
// and its ledger record, and `lfs` against a fake release archive (script/fixtures/git-lfs-fake.tar.gz: a fake static
// x64 ELF in git-lfs's release layout, made here when absent) served from loopback or given as a local copy: the pin
// is checked before anything is written, the binary and license land per target, the machine and static checks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  fetchLfs,
  fetchNative,
  GIT_LFS,
  GIT_LFS_LICENSE,
  integrityOf,
  type LfsPin,
  lfsUrl,
  linkNative,
  linkSites,
  NATIVE_PACKAGES,
  parseLock,
  pinned,
  readPin,
  tarballUrl,
  type Target,
  unlinkNative,
} from "./native.js"

const TAR = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar"
const NAME = "@x/native-linux"
const FIXTURE = path.join(import.meta.dir, "fixtures", "git-lfs-fake.tar.gz")
const LFS_PATH = `/v${GIT_LFS.version}/git-lfs-fake.tar.gz`

let root: string
let repo: string
let tgz: Uint8Array<ArrayBuffer>
let lockText: string
let served: Uint8Array<ArrayBuffer>
let server: ReturnType<typeof Bun.serve>
let lfsArchive: Uint8Array<ArrayBuffer>
let servedLfs: Uint8Array<ArrayBuffer>
let lfsRequests = 0
let lfsPin: LfsPin

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

/** ELF64 little-endian executable for `machine` with one program header: PT_LOAD (1, static) or PT_INTERP (3). */
function fakeElf(machine: number, segment: 1 | 3 = 1) {
  const header = Buffer.alloc(64 + 56)
  header.writeUInt32BE(0x7f454c46, 0)
  header[4] = 2
  header[5] = 1
  header[6] = 1
  header.writeUInt16LE(2, 16)
  header.writeUInt16LE(machine, 18)
  header.writeUInt32LE(1, 20)
  header.writeBigUInt64LE(64n, 32)
  header.writeUInt16LE(56, 54)
  header.writeUInt16LE(1, 56)
  header.writeUInt32LE(segment, 64)
  return Buffer.concat([header, Buffer.from("fake git-lfs for own-remote tests, not a program\n")])
}

/** An archive in git-lfs's Linux release layout: `git-lfs-<ver>/{git-lfs, install.sh, README.md, CHANGELOG.md, man/}`. */
function fakeRelease(file: string, binary?: Buffer) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "own-lfs-fixture-"))
  const top = path.join(stage, `git-lfs-${GIT_LFS.version}`)
  fs.mkdirSync(path.join(top, "man", "man1"), { recursive: true })
  if (binary) fs.writeFileSync(path.join(top, "git-lfs"), binary)
  fs.writeFileSync(path.join(top, "install.sh"), "#!/usr/bin/env bash\nexit 1\n")
  fs.writeFileSync(path.join(top, "README.md"), "# fake git-lfs release for own-remote tests\n")
  fs.writeFileSync(path.join(top, "CHANGELOG.md"), "# none\n")
  fs.writeFileSync(path.join(top, "man", "man1", "git-lfs.1"), ".TH GIT-LFS 1\n")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(TAR, ["-czf", file, "-C", stage, `git-lfs-${GIT_LFS.version}`], { windowsHide: true })
  fs.rmSync(stage, { recursive: true, force: true })
  return new Uint8Array(fs.readFileSync(file))
}

/** A pin of a fake archive for `targets`. */
function fakePin(archive: Uint8Array, targets: ReadonlyArray<Target> = ["linux-x64-baseline", "linux-arm64"]): LfsPin {
  const spec = { asset: "git-lfs-fake.tar.gz", sha256: sha256(archive) }
  return { version: GIT_LFS.version, targets: Object.fromEntries(targets.map((target) => [target, spec])) }
}

function lock(integrity: string) {
  // bun.lock is JSONC: trailing commas included on purpose.
  return `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root", },
    "packages/ws": { "name": "ws", "devDependencies": { "${NAME}": "1.0.0", }, },
    "packages/other": { "name": "other", "dependencies": { "left-pad": "1.0.0", }, },
  },
  "packages": {
    "@x/dep": ["@x/dep@2.0.0", "", { "optionalDependencies": { "${NAME}": "1.0.0", }, }, "sha512-AAAA"],
    "${NAME}": ["${NAME}@1.0.0", "", { "os": "linux", "cpu": "x64", }, "${integrity}"],
    "left-pad": ["left-pad@1.0.0", "", {}, "sha512-BBBB"],
  },
}
`
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "own-native-test-"))
  repo = path.join(root, "repo")
  const pkg = path.join(root, "pkg", "package")
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: NAME, version: "1.0.0", main: "lib.so" }))
  fs.writeFileSync(path.join(pkg, "lib.so"), "not really a library")
  const file = path.join(root, "pkg.tgz")
  execFileSync(TAR, ["-czf", file, "-C", path.join(root, "pkg"), "package"], { windowsHide: true })
  tgz = new Uint8Array(fs.readFileSync(file))
  served = tgz
  lfsArchive = fs.existsSync(FIXTURE) ? new Uint8Array(fs.readFileSync(FIXTURE)) : fakeRelease(FIXTURE, fakeElf(0x3e))
  servedLfs = lfsArchive
  lfsPin = fakePin(lfsArchive)
  lockText = lock(integrityOf(tgz))
  for (const dir of [
    path.join(repo, "packages", "ws"),
    path.join(repo, "packages", "other"),
    path.join(repo, "node_modules", ".bun", "@x+dep@2.0.0+abc123", "node_modules", "@x", "dep"),
    path.join(repo, "node_modules", ".bun", "@x+dep@1.0.0", "node_modules", "@x", "dep"),
  ])
    fs.mkdirSync(dir, { recursive: true })
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname === `/${NAME}/-/native-linux-1.0.0.tgz`) return new Response(served)
      if (pathname !== LFS_PATH) return new Response("no", { status: 404 })
      lfsRequests++
      return new Response(servedLfs)
    },
  })
})

afterAll(() => {
  server?.stop(true)
  fs.rmSync(root, { recursive: true, force: true })
})

describe("native packages", () => {
  test("pins come from bun.lock, from the default registry only", () => {
    expect(pinned(parseLock(lockText), NAME)).toEqual({ name: NAME, version: "1.0.0", integrity: integrityOf(tgz) })
    expect(() => pinned(parseLock(lockText), "@x/missing")).toThrow("no package")
    const git = lockText.replace(`["${NAME}@1.0.0", ""`, `["${NAME}@1.0.0", "github:x/y"`)
    expect(() => pinned(parseLock(git), NAME)).toThrow("default npm registry")
    expect(tarballUrl("@opentui/core-linux-x64", "0.5.12")).toBe(
      "https://registry.npmjs.org/@opentui/core-linux-x64/-/core-linux-x64-0.5.12.tgz",
    )
  })

  test("link sites follow Bun's isolated layout: depending workspaces and every installed dependent", () => {
    expect(linkSites(lockText, NAME, repo)).toEqual(
      [
        path.join(repo, "node_modules", ".bun", "@x+dep@2.0.0+abc123", "node_modules", "@x", "native-linux"),
        path.join(repo, "packages", "ws", "node_modules", "@x", "native-linux"),
      ].sort(),
    )
  })

  test("fetch verifies the tarball, unpacks it, and reuses the verified copy", async () => {
    const dir = path.join(root, "native")
    const registry = `http://127.0.0.1:${server.port}`
    const first = await fetchNative({ dir, names: [NAME], lockText, registry })
    expect(first).toMatchObject([{ name: NAME, version: "1.0.0", bytes: tgz.length, cached: false }])
    expect(fs.readFileSync(path.join(dir, "node_modules", "@x", "native-linux", "lib.so"), "utf8")).toBe("not really a library")
    const second = await fetchNative({ dir, names: [NAME], lockText, registry })
    expect(second[0]!.cached).toBe(true)
  })

  test("a tarball that does not match bun.lock is refused and never written", async () => {
    const dir = path.join(root, "native-tampered")
    served = new Uint8Array([...tgz.slice(0, -1), tgz[tgz.length - 1]! ^ 0xff])
    try {
      await expect(fetchNative({ dir, names: [NAME], lockText, registry: `http://127.0.0.1:${server.port}` })).rejects.toThrow(
        "integrity does not match bun.lock",
      )
    } finally {
      served = tgz
    }
    expect(fs.readdirSync(path.join(dir, "tarballs"))).toEqual([])
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false)
  })

  test("link creates junctions to the verified copy, leaves other installs alone, and unlink removes only its own", () => {
    const dir = path.join(root, "native")
    const staged = path.join(dir, "node_modules", "@x", "native-linux")
    // Someone else's install at one site: never replaced or removed.
    const theirs = path.join(repo, "packages", "ws", "node_modules", "@x", "native-linux")
    fs.mkdirSync(theirs, { recursive: true })
    fs.writeFileSync(path.join(theirs, "package.json"), "{}")
    const store = path.join(repo, "node_modules", ".bun", "@x+dep@2.0.0+abc123", "node_modules", "@x", "native-linux")

    expect(linkNative({ dir, names: [NAME], lockText, repo })).toEqual([
      { name: NAME, site: store, state: "created" },
      { name: NAME, site: theirs, state: "present" },
    ])
    expect(fs.realpathSync(store)).toBe(fs.realpathSync(staged))
    expect(fs.readFileSync(path.join(store, "lib.so"), "utf8")).toBe("not really a library")
    expect(linkNative({ dir, names: [NAME], lockText, repo }).map((item) => item.state)).toEqual(["ours", "present"])

    expect(unlinkNative({ dir, names: [NAME], lockText, repo })).toEqual([store])
    expect(fs.existsSync(store)).toBe(false)
    expect(fs.existsSync(path.join(staged, "lib.so"))).toBe(true)
    expect(fs.readFileSync(path.join(theirs, "package.json"), "utf8")).toBe("{}")
    expect(unlinkNative({ dir, names: [NAME], lockText, repo })).toEqual([])
  })

  test("link refuses a package that was not fetched", () => {
    expect(() => linkNative({ dir: path.join(root, "empty"), names: [NAME], lockText, repo })).toThrow("not fetched")
  })
})

describe("git-lfs", () => {
  const registry = () => `http://127.0.0.1:${server.port}`

  test("GIT_LFS pins the official static release for both targets, and the ledger records it", () => {
    expect(readPin(JSON.stringify(GIT_LFS))).toEqual(GIT_LFS)
    expect(Object.keys(GIT_LFS.targets).sort()).toEqual(Object.keys(NATIVE_PACKAGES).sort())
    expect(GIT_LFS.targets["linux-x64-baseline"].asset).toBe(`git-lfs-linux-amd64-v${GIT_LFS.version}.tar.gz`)
    expect(GIT_LFS.targets["linux-arm64"].asset).toBe(`git-lfs-linux-arm64-v${GIT_LFS.version}.tar.gz`)
    expect(lfsUrl(GIT_LFS, GIT_LFS.targets["linux-arm64"].asset)).toBe(
      `https://github.com/git-lfs/git-lfs/releases/download/v${GIT_LFS.version}/git-lfs-linux-arm64-v${GIT_LFS.version}.tar.gz`,
    )
    expect(GIT_LFS_LICENSE).toStartWith("MIT License\n\nCopyright (c) 2014- GitHub, Inc. and Git LFS contributors\n")
    // own/ledger/vendored.yaml keeps the third-party record (source URL, version, both sha256, MIT) in step.
    const ledger = fs.readFileSync(path.resolve(import.meta.dir, "../../../own/ledger/vendored.yaml"), "utf8")
    for (const text of [
      `https://github.com/git-lfs/git-lfs/releases/tag/v${GIT_LFS.version}`,
      ...Object.values(GIT_LFS.targets).flatMap((spec) => [spec.asset, spec.sha256]),
    ])
      expect(ledger).toContain(text)
  })

  test("a pin file is checked: plain version, archive file names, SHA-256 hex", () => {
    const good = { version: "3.8.0", targets: { "linux-arm64": { asset: "a.tar.gz", sha256: "a".repeat(64) } } }
    expect(readPin(JSON.stringify(good))).toEqual(good)
    for (const bad of [
      { ...good, version: "../3.8.0" },
      { ...good, targets: { "linux-arm64": { asset: "../a.tar.gz", sha256: "a".repeat(64) } } },
      { ...good, targets: { "linux-arm64": { asset: "a.tar.gz", sha256: "A".repeat(64) } } },
      { ...good, targets: { "linux-arm64": { asset: "a.tar.gz", sha256: "a".repeat(63) } } },
    ])
      expect(() => readPin(JSON.stringify(bad))).toThrow()
  })

  test("fetch checks the pin, puts git-lfs and its license under <dir>/git-lfs/<ver>/<target>/, and reuses the verified archive", async () => {
    const dir = path.join(root, "lfs")
    const first = await fetchLfs({ dir, targets: ["linux-x64-baseline"], pin: lfsPin, releases: registry() })
    const dest = path.join(dir, "git-lfs", GIT_LFS.version, "linux-x64-baseline")
    expect(first).toEqual([
      {
        target: "linux-x64-baseline",
        version: GIT_LFS.version,
        asset: "git-lfs-fake.tar.gz",
        url: `${registry()}${LFS_PATH}`,
        source: "download",
        archive: { sha256: sha256(lfsArchive), bytes: lfsArchive.length },
        file: path.join(dest, "git-lfs"),
        sha256: sha256(fakeElf(0x3e)),
        bytes: fakeElf(0x3e).length,
      },
    ])
    expect(fs.readdirSync(dest).sort()).toEqual(["LICENSE.md", "git-lfs"])
    expect(fs.readFileSync(path.join(dest, "git-lfs"))).toEqual(fakeElf(0x3e))
    expect(fs.readFileSync(path.join(dest, "LICENSE.md"), "utf8")).toBe(GIT_LFS_LICENSE)
    const requests = lfsRequests
    const second = await fetchLfs({ dir, targets: ["linux-x64-baseline"], pin: lfsPin, releases: registry() })
    expect(second[0]!.source).toBe("cache")
    expect(lfsRequests).toBe(requests)
  }, 30_000)

  test("a download that does not match the pin is refused before anything is written or unpacked", async () => {
    const dir = path.join(root, "lfs-tampered")
    servedLfs = new Uint8Array([...lfsArchive.slice(0, -1), lfsArchive[lfsArchive.length - 1]! ^ 0xff])
    try {
      await expect(
        fetchLfs({ dir, targets: ["linux-x64-baseline"], pin: lfsPin, releases: registry() }),
      ).rejects.toThrow(`is not the pinned ${sha256(lfsArchive)}`)
    } finally {
      servedLfs = lfsArchive
    }
    expect(fs.existsSync(path.join(dir, "git-lfs"))).toBe(false)
    // The real pins never match the fake archive either.
    await expect(
      fetchLfs({ dir, targets: ["linux-arm64"], archives: { "linux-arm64": FIXTURE }, releases: registry() }),
    ).rejects.toThrow(`is not the pinned ${GIT_LFS.targets["linux-arm64"].sha256}`)
    expect(fs.existsSync(path.join(dir, "git-lfs"))).toBe(false)
  }, 30_000)

  test("a local copy is checked like a download; another machine, a dynamic build or no binary is refused", async () => {
    const dir = path.join(root, "lfs-local")
    const local = await fetchLfs({
      dir,
      targets: ["linux-x64-baseline"],
      pin: lfsPin,
      archives: { "linux-x64-baseline": FIXTURE },
    })
    expect(local.map((item) => item.source)).toEqual(["local"])
    await expect(
      fetchLfs({ dir, targets: ["linux-arm64"], pin: lfsPin, archives: { "linux-arm64": FIXTURE } }),
    ).rejects.toThrow("ELF machine 0x3e is not linux-arm64")
    expect(fs.existsSync(path.join(dir, "git-lfs", GIT_LFS.version, "linux-arm64"))).toBe(false)
    const dynamic = path.join(root, "git-lfs-dynamic.tar.gz")
    const dynamicPin = fakePin(fakeRelease(dynamic, fakeElf(0x3e, 3)))
    await expect(
      fetchLfs({ dir, targets: ["linux-x64-baseline"], pin: dynamicPin, archives: { "linux-x64-baseline": dynamic } }),
    ).rejects.toThrow("dynamically linked")
    const empty = path.join(root, "git-lfs-empty.tar.gz")
    const emptyPin = fakePin(fakeRelease(empty))
    await expect(
      fetchLfs({ dir, targets: ["linux-x64-baseline"], pin: emptyPin, archives: { "linux-x64-baseline": empty } }),
    ).rejects.toThrow("0 git-lfs binaries")
  }, 30_000)

  test("the lfs command (build-remote.ps1 step 2b) with a test pin file and a local archive", () => {
    const dir = path.join(root, "lfs-cli")
    const pinFile = path.join(root, "lfs-pin.json")
    fs.writeFileSync(pinFile, JSON.stringify(fakePin(lfsArchive, ["linux-x64-baseline"])))
    const run = Bun.spawnSync(
      [
        "bun",
        path.join(import.meta.dir, "native.ts"),
        "lfs",
        "--dir",
        dir,
        "--targets",
        "linux-x64-baseline",
        "--pin",
        pinFile,
        "--archive",
        `linux-x64-baseline=${FIXTURE}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout.toString())).toMatchObject([
      { target: "linux-x64-baseline", version: GIT_LFS.version, source: "local", sha256: sha256(fakeElf(0x3e)) },
    ])
    expect(fs.readdirSync(path.join(dir, "git-lfs", GIT_LFS.version, "linux-x64-baseline")).sort()).toEqual([
      "LICENSE.md",
      "git-lfs",
    ])
  }, 60_000)
})
