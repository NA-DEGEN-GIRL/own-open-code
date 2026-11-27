#!/usr/bin/env bun
/**
 * Linux native inputs for the own-channel remote CLI build (RG2, 04 §5.2), without `bun install --os=* --cpu=*`.
 *
 * Upstream's build.ts cross-compiles every Linux target but only finds a target's native optional packages when they
 * are installed, and its install step rewrites bun.lock and relinks the whole shared store. Instead:
 *
 *   fetch    each package in NATIVE_PACKAGES is downloaded from the npm registry at the exact version bun.lock pins,
 *            checked against the lockfile's sha512 integrity and unpacked into `<dir>/node_modules/<name>`.
 *   link     a junction to that copy is placed exactly where Bun's isolated linker would put the optional dependency
 *            (next to each dependent in `node_modules/.bun/<pkg>@<ver>/node_modules/`, and in the node_modules of each
 *            workspace that lists it), so build.ts resolves it the normal way, export conditions included. NODE_PATH
 *            is not an option: Bun resolves NODE_PATH packages without the `bun` condition, which silently drops
 *            OpenTUI's `libopentui.so` from the executable.
 *   unlink   removes every junction that points into `<dir>`, and nothing else. build-remote.ps1 calls it in a
 *            `finally`, so node_modules ends up as it was.
 *   runtime  the Bun runtime that `Bun.build({ compile })` downloaded into Bun's install cache for a target is
 *            compared with the same binary from two official sources: the npm package `@oven/bun-<platform>`
 *            (registry integrity) and the GitHub release zip (release SHASUMS256.txt).
 *   lfs      the static git-lfs SSH hosts get (06 §4.13 동봉): each target's release archive of the pinned GIT_LFS
 *            release is downloaded (or reused, or taken from `--archive`), checked against the pinned sha256 before it
 *            is written or unpacked, and its `git-lfs` binary goes with the license into `<dir>/git-lfs/<ver>/<target>/`
 *            (`bundle.ts package --tools <dir>` ships it beside the target archives).
 *
 *   bun script/native.ts fetch   --dir <dir> --targets linux-x64-baseline,linux-arm64
 *   bun script/native.ts link    --dir <dir> --targets …
 *   bun script/native.ts unlink  --dir <dir> --targets …
 *   bun script/native.ts runtime --dir <dir> --targets … [--bun <version>] [--cache-dir <Bun install cache>]
 *   bun script/native.ts lfs     --dir <dir> --targets … [--archive <target>=<path>]… [--pin <file>]
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"

const REPO = path.resolve(import.meta.dir, "../../..")

/**
 * What build.ts needs per glibc target: the pty helper (`script/opencode-pty.ts`), the parcel watcher addon
 * (`parcelWatcherPlugin`), OpenTUI's `libopentui.so` and fff's `libfff_c.so` (`FFF_LIBC`). Bun's compile target
 * fixes `process.platform`/`process.arch`, so other platforms' branches are dropped and never resolved.
 */
export const NATIVE_PACKAGES = {
  "linux-x64-baseline": [
    "@opencode/pty-linux-x64-gnu",
    "@parcel/watcher-linux-x64-glibc",
    "@opentui/core-linux-x64",
    "@ff-labs/fff-bin-linux-x64-gnu",
  ],
  "linux-arm64": [
    "@opencode/pty-linux-arm64-gnu",
    "@parcel/watcher-linux-arm64-glibc",
    "@opentui/core-linux-arm64",
    "@ff-labs/fff-bin-linux-arm64-gnu",
  ],
} as const
export type Target = keyof typeof NATIVE_PACKAGES

/** Bun's names for the compile runtime of each target (npm `@oven/<name>`, release asset `<name>.zip`). */
export const RUNTIMES: Record<Target, string> = {
  "linux-x64-baseline": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-aarch64",
}

/** ELF `e_machine` of each target (EM_X86_64, EM_AARCH64). */
export const ELF_MACHINES = {
  "linux-x64-baseline": 0x3e,
  "linux-arm64": 0xb7,
} as const satisfies Record<Target, number>

export const REGISTRY = "https://registry.npmjs.org"
export const BUN_RELEASES = "https://github.com/oven-sh/bun/releases/download"

const TAR = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar"

export type Lock = {
  workspaces?: Record<string, Record<string, unknown>>
  packages?: Record<string, ReadonlyArray<unknown>>
}

export function parseLock(lockText: string) {
  return Bun.JSONC.parse(lockText) as Lock
}

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

export function integrityOf(data: Uint8Array) {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`
}

export function tarballUrl(name: string, version: string, registry = REGISTRY) {
  return `${registry}/${name}/-/${name.split("/").at(-1)}-${version}.tgz`
}

export interface Pinned {
  readonly name: string
  readonly version: string
  /** Subresource-integrity string from bun.lock (`sha512-<base64>`). */
  readonly integrity: string
}

/** The version and integrity bun.lock pins for `name` (the top-level `packages` entry of that key). */
export function pinned(lock: Lock, name: string): Pinned {
  const entry = lock.packages?.[name]
  if (!entry) throw new Error(`bun.lock has no package ${name}`)
  const [spec, registry, , integrity] = entry
  if (typeof spec !== "string" || !spec.startsWith(`${name}@`)) throw new Error(`bun.lock entry for ${name} is malformed`)
  if (registry !== "") throw new Error(`${name} is not from the default npm registry (${String(registry)})`)
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-"))
    throw new Error(`bun.lock has no sha512 integrity for ${name}`)
  return { name, version: spec.slice(name.length + 1), integrity }
}

export function namesFor(targets: ReadonlyArray<string>) {
  return targets.flatMap((target) => {
    if (!(target in NATIVE_PACKAGES)) throw new Error(`unsupported target ${target}`)
    return [...NATIVE_PACKAGES[target as Target]]
  })
}

function stagedDir(dir: string, name: string) {
  return path.join(dir, "node_modules", ...name.split("/"))
}

async function download(url: string, log?: (line: string) => void) {
  log?.(`GET ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export interface Fetched extends Pinned {
  readonly url: string
  readonly bytes: number
  readonly sha256: string
  /** The tarball was already in `<dir>/tarballs` (and verified again), not downloaded. */
  readonly cached: boolean
}

/**
 * Downloads (or reuses) each package tarball, verifies it against bun.lock and unpacks it fresh into
 * `<dir>/node_modules/<name>`. A tarball that does not match is never written or unpacked.
 */
export async function fetchNative(input: {
  readonly dir: string
  readonly names: ReadonlyArray<string>
  readonly lockText: string
  /** Tests only: another registry root. */
  readonly registry?: string
  readonly log?: (line: string) => void
}): Promise<Fetched[]> {
  const lock = parseLock(input.lockText)
  const tarballs = path.join(input.dir, "tarballs")
  fs.mkdirSync(tarballs, { recursive: true })
  const results: Fetched[] = []
  for (const name of input.names) {
    const pin = pinned(lock, name)
    const url = tarballUrl(name, pin.version, input.registry)
    const file = path.join(tarballs, `${name.replace("/", "+")}@${pin.version}.tgz`)
    const cached = fs.existsSync(file) && integrityOf(fs.readFileSync(file)) === pin.integrity
    if (!cached) {
      const data = await download(url, input.log)
      if (integrityOf(data) !== pin.integrity) throw new Error(`${name}@${pin.version}: integrity does not match bun.lock`)
      fs.writeFileSync(file, data)
    }
    const data = fs.readFileSync(file)
    const dest = stagedDir(input.dir, name)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    // npm tarballs keep everything under `package/`.
    execFileSync(TAR, ["-xzf", file, "-C", dest, "--strip-components=1"], { windowsHide: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8")) as { name?: string; version?: string }
    if (manifest.name !== name || manifest.version !== pin.version)
      throw new Error(`${file} unpacked as ${manifest.name}@${manifest.version}, expected ${name}@${pin.version}`)
    results.push({ ...pin, url, bytes: data.length, sha256: sha256(data), cached })
  }
  return results
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const

function lists(meta: unknown, name: string) {
  if (!meta || typeof meta !== "object") return false
  return DEPENDENCY_FIELDS.some((field) => {
    const deps = (meta as Record<string, unknown>)[field]
    return !!deps && typeof deps === "object" && name in deps
  })
}

/**
 * Where Bun's isolated linker puts `name`: `<ws>/node_modules/<name>` for each workspace that depends on it, and
 * `node_modules/.bun/<dependent>@<version>[+<peer hash>]/node_modules/<name>` for each installed dependent.
 */
export function linkSites(lockText: string, name: string, repo = REPO) {
  const lock = parseLock(lockText)
  const store = path.join(repo, "node_modules", ".bun")
  const storeDirs = fs.existsSync(store) ? fs.readdirSync(store) : []
  const workspaces = Object.entries(lock.workspaces ?? {})
    .filter(([dir, meta]) => dir !== "" && lists(meta, name) && fs.existsSync(path.join(repo, dir)))
    .map(([dir]) => path.join(repo, dir, "node_modules", ...name.split("/")))
  const dependents = Object.values(lock.packages ?? {}).flatMap((entry) => {
    const [spec, , meta] = entry
    if (typeof spec !== "string" || !lists(meta, name)) return []
    const at = spec.lastIndexOf("@")
    if (at <= 0) return []
    const prefix = `${spec.slice(0, at).replace("/", "+")}@${spec.slice(at + 1)}`
    return storeDirs
      .filter((entry) => entry === prefix || entry.startsWith(`${prefix}+`))
      .map((entry) => path.join(store, entry, "node_modules", ...name.split("/")))
  })
  return [...new Set([...workspaces, ...dependents])].sort()
}

function linkTarget(site: string) {
  const stat = fs.lstatSync(site, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (!stat.isSymbolicLink()) return "not-a-link"
  return path.resolve(path.dirname(site), fs.readlinkSync(site))
}

function inside(dir: string, file: string) {
  const relative = path.relative(dir, file)
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative)
}

export interface Linked {
  readonly name: string
  readonly site: string
  /** `created` by this call, `ours` (an earlier link into `<dir>`), or `present` (someone else's install; left). */
  readonly state: "created" | "ours" | "present"
}

/** Junctions from every link site of each package to its verified copy in `<dir>/node_modules`. */
export function linkNative(input: { readonly dir: string; readonly names: ReadonlyArray<string>; readonly lockText: string; readonly repo?: string }) {
  const staged = path.join(path.resolve(input.dir), "node_modules")
  return input.names.flatMap((name): Linked[] => {
    const target = stagedDir(path.resolve(input.dir), name)
    if (!fs.existsSync(path.join(target, "package.json"))) throw new Error(`${name} is not fetched into ${input.dir}`)
    const sites = linkSites(input.lockText, name, input.repo)
    if (sites.length === 0) throw new Error(`bun.lock names no dependent of ${name} that is installed here`)
    return sites.map((site) => {
      const existing = linkTarget(site)
      if (existing !== undefined && existing !== "not-a-link" && inside(staged, existing)) {
        if (path.resolve(existing) === target) return { name, site, state: "ours" }
        fs.unlinkSync(site)
      }
      if (existing !== undefined && (existing === "not-a-link" || !inside(staged, existing))) return { name, site, state: "present" }
      fs.mkdirSync(path.dirname(site), { recursive: true })
      fs.symlinkSync(target, site, "junction")
      return { name, site, state: "created" }
    })
  })
}

/** Removes every link site junction that points into `<dir>/node_modules`; returns the removed paths. */
export function unlinkNative(input: { readonly dir: string; readonly names: ReadonlyArray<string>; readonly lockText: string; readonly repo?: string }) {
  const staged = path.join(path.resolve(input.dir), "node_modules")
  return input.names.flatMap((name) =>
    linkSites(input.lockText, name, input.repo).filter((site) => {
      const existing = linkTarget(site)
      if (existing === undefined || existing === "not-a-link" || !inside(staged, existing)) return false
      fs.unlinkSync(site)
      return true
    }),
  )
}

/** Bun's install cache, where `Bun.build({ compile: { target } })` keeps the downloaded cross-compile runtimes. */
export function bunCacheDir() {
  if (process.env.BUN_INSTALL_CACHE_DIR) return process.env.BUN_INSTALL_CACHE_DIR
  return path.join(process.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun"), "install", "cache")
}

export interface RuntimeCheck {
  readonly target: Target
  readonly bun: string
  /** The runtime Bun used for the build: `<bun cache>/<runtime>-v<bun>`. */
  readonly cache: { readonly file: string; readonly bytes: number; readonly sha256: string }
  readonly npm: { readonly url: string; readonly integrity: string; readonly sha256: string }
  readonly github: { readonly url: string; readonly zipSha256: string; readonly sha256: string }
}

/** One member of a .tgz or .zip (bsdtar reads both), unpacked into a scratch directory that is removed again. */
function extractOne(archive: string, member: string, dest: string) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  try {
    execFileSync(TAR, ["-xf", archive, "-C", dest, member], { windowsHide: true })
    return fs.readFileSync(path.join(dest, ...member.split("/")))
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
}

/**
 * The cached runtime must be byte-identical to `package/bin/bun` of `@oven/<runtime>@<bun>` (registry integrity)
 * and to `<runtime>/bun` of the `bun-v<bun>` release zip (release SHASUMS256.txt). Downloads are kept in
 * `<dir>/runtime` and re-verified on the next run.
 */
export async function verifyRuntime(input: {
  readonly dir: string
  readonly target: Target
  readonly bun: string
  readonly cacheDir?: string
  readonly log?: (line: string) => void
}): Promise<RuntimeCheck> {
  const runtime = RUNTIMES[input.target]
  const cacheFile = path.join(input.cacheDir ?? bunCacheDir(), `${runtime}-v${input.bun}`)
  if (!fs.existsSync(cacheFile)) throw new Error(`no cached Bun runtime at ${cacheFile} (the build did not cross-compile)`)
  const cached = fs.readFileSync(cacheFile)
  const work = path.join(input.dir, "runtime")
  fs.mkdirSync(work, { recursive: true })

  const meta = (await (await fetch(`${REGISTRY}/@oven/${runtime}/${input.bun}`)).json()) as {
    dist?: { tarball?: string; integrity?: string }
  }
  const tarball = meta.dist?.tarball
  const integrity = meta.dist?.integrity
  if (!tarball || !integrity?.startsWith("sha512-")) throw new Error(`npm has no dist for @oven/${runtime}@${input.bun}`)
  const tgz = path.join(work, `${runtime}-${input.bun}.tgz`)
  if (!fs.existsSync(tgz) || integrityOf(fs.readFileSync(tgz)) !== integrity) {
    const data = await download(tarball, input.log)
    if (integrityOf(data) !== integrity) throw new Error(`@oven/${runtime}@${input.bun}: integrity mismatch`)
    fs.writeFileSync(tgz, data)
  }
  const npmBinary = extractOne(tgz, "package/bin/bun", path.join(work, `${runtime}-${input.bun}-npm`))

  const release = `${BUN_RELEASES}/bun-v${input.bun}`
  const sums = new TextDecoder().decode(await download(`${release}/SHASUMS256.txt`, input.log))
  const zipSha = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === `${runtime}.zip`)?.[0]
  if (!zipSha || !/^[0-9a-f]{64}$/.test(zipSha)) throw new Error(`SHASUMS256.txt of bun-v${input.bun} lists no ${runtime}.zip`)
  const zip = path.join(work, `${runtime}-${input.bun}.zip`)
  if (!fs.existsSync(zip) || sha256(fs.readFileSync(zip)) !== zipSha) {
    const data = await download(`${release}/${runtime}.zip`, input.log)
    if (sha256(data) !== zipSha) throw new Error(`${runtime}.zip does not match SHASUMS256.txt`)
    fs.writeFileSync(zip, data)
  }
  const githubBinary = extractOne(zip, `${runtime}/bun`, path.join(work, `${runtime}-${input.bun}-github`))

  const result: RuntimeCheck = {
    target: input.target,
    bun: input.bun,
    cache: { file: cacheFile, bytes: cached.length, sha256: sha256(cached) },
    npm: { url: tarball, integrity, sha256: sha256(npmBinary) },
    github: { url: `${release}/${runtime}.zip`, zipSha256: zipSha, sha256: sha256(githubBinary) },
  }
  if (result.npm.sha256 !== result.github.sha256)
    throw new Error(`${runtime} ${input.bun}: npm and GitHub release binaries differ`)
  if (result.cache.sha256 !== result.npm.sha256)
    throw new Error(`${cacheFile} is not the official ${runtime} ${input.bun} (sha256 ${result.cache.sha256})`)
  return result
}

export type LfsPin = {
  readonly version: string
  readonly targets: { readonly [target in Target]?: { readonly asset: string; readonly sha256: string } }
}

/**
 * The git-lfs SSH hosts get (06 §4.13): git-lfs's own static Linux build (`CGO_ENABLED=0 make release`), one pinned
 * release. `sha256` is the SHA-256 the release publishes for each archive (v3.8.1 of 2026-10-22, the fix of
 * CVE-2026-69260, CVE-2026-69261, CVE-2026-105802 and CVE-2026-105803: release notes, GitHub asset digests and
 * sha256sums.asc agree). A new version needs new pins and a new record in own/ledger/vendored.yaml.
 */
export const GIT_LFS = {
  version: "3.8.1",
  targets: {
    "linux-x64-baseline": {
      asset: "git-lfs-linux-amd64-v3.8.1.tar.gz",
      sha256: "e72cf723a4a660438862282e8aecf3885fc8123e88bfcad534cf6b941a354b75",
    },
    "linux-arm64": {
      asset: "git-lfs-linux-arm64-v3.8.1.tar.gz",
      sha256: "67895dd77b63329796bc5efdd47b57f218e1f7b98717ebaf936a8238dbcaec0f",
    },
  },
} as const satisfies LfsPin

export const GIT_LFS_RELEASES = "https://github.com/git-lfs/git-lfs/releases/download"

/**
 * LICENSE.md of git-lfs (repository root, v3.8.1, the same as v3.8.0). The Linux release archives carry no license
 * file (the release Makefile packs git-lfs, install.sh, README.md, CHANGELOG.md and man/), so `lfs` writes this beside
 * the binary.
 */
export const GIT_LFS_LICENSE = `MIT License

Copyright (c) 2014- GitHub, Inc. and Git LFS contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Portions of the subprocess and tools directories are copied from Go and are
under the following license:

Copyright (c) 2009,2010 The Go Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Note that Git LFS uses components from other Go modules, which are under
different licenses.  See those LICENSE files for details.
`

const PinAsset = Schema.Struct({
  asset: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
})
const decodePin = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
      targets: Schema.Struct({
        "linux-x64-baseline": Schema.optional(PinAsset),
        "linux-arm64": Schema.optional(PinAsset),
      }),
    }),
  ),
)

/** A pin file in place of GIT_LFS (tests: a fake release): a plain version, archive file names, SHA-256 hex. */
export function readPin(text: string): LfsPin {
  return decodePin(text)
}

export function lfsUrl(pin: LfsPin, asset: string, releases = GIT_LFS_RELEASES) {
  return `${releases}/v${pin.version}/${asset}`
}

/**
 * A git-lfs binary for `target`: ELF64 little-endian executable for the target machine without a program
 * interpreter (statically linked, so it runs on any glibc or musl host).
 */
export function checkLfsBinary(data: Buffer, target: Target, name = "git-lfs") {
  if (data.length < 64 || data.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${name}: not an ELF binary`)
  if (data[4] !== 2 || data[5] !== 1) throw new Error(`${name}: not ELF64 little-endian`)
  const type = data.readUInt16LE(16)
  if (type !== 2 && type !== 3) throw new Error(`${name}: ELF type ${type} is not an executable`)
  const machine = data.readUInt16LE(18)
  if (machine !== ELF_MACHINES[target])
    throw new Error(`${name}: ELF machine 0x${machine.toString(16)} is not ${target}`)
  const phoff = Number(data.readBigUInt64LE(32))
  const size = data.readUInt16LE(54)
  const count = data.readUInt16LE(56)
  if (phoff + size * count > data.length) throw new Error(`${name}: truncated program headers`)
  if (Array.from({ length: count }, (_, index) => phoff + index * size).some((at) => data.readUInt32LE(at) === 3))
    throw new Error(`${name}: dynamically linked (PT_INTERP); the static release build is required`)
}

export interface FetchedLfs {
  readonly target: Target
  readonly version: string
  readonly asset: string
  readonly url: string
  /** Where the archive came from this time: downloaded, the verified copy in `<dir>/git-lfs/archives`, or `--archive`. */
  readonly source: "download" | "cache" | "local"
  readonly archive: { readonly sha256: string; readonly bytes: number }
  /** `<dir>/git-lfs/<version>/<target>/git-lfs`; LICENSE.md is next to it. */
  readonly file: string
  readonly sha256: string
  readonly bytes: number
}

/**
 * Each target's git-lfs release archive, checked against the pin before it is written or unpacked, then its one
 * `git-lfs` member (`git-lfs-<version>/git-lfs`) checked with `checkLfsBinary` and written fresh with LICENSE.md into
 * `<dir>/git-lfs/<version>/<target>/`. Verified archives stay in `<dir>/git-lfs/archives` and are checked again on
 * reuse.
 */
export async function fetchLfs(input: {
  readonly dir: string
  readonly targets: ReadonlyArray<Target>
  readonly pin?: LfsPin
  /** Local copies of the release archives by target (e.g. downloaded by hand), checked like a download. */
  readonly archives?: { readonly [target in Target]?: string }
  /** Tests only: another release root. */
  readonly releases?: string
  readonly log?: (line: string) => void
}): Promise<FetchedLfs[]> {
  const pin = input.pin ?? GIT_LFS
  const archives = path.join(input.dir, "git-lfs", "archives")
  const results: FetchedLfs[] = []
  for (const target of input.targets) {
    const spec = pin.targets[target]
    if (!spec) throw new Error(`no git-lfs ${pin.version} pin for ${target}`)
    const url = lfsUrl(pin, spec.asset, input.releases)
    const file = path.join(archives, spec.asset)
    const local = input.archives?.[target]
    const cached = !local && fs.existsSync(file) && sha256(fs.readFileSync(file)) === spec.sha256
    if (!cached) {
      const data = local ? new Uint8Array(fs.readFileSync(local)) : await download(url, input.log)
      const actual = sha256(data)
      if (actual !== spec.sha256) throw new Error(`${local ?? url}: sha256 ${actual} is not the pinned ${spec.sha256}`)
      fs.mkdirSync(archives, { recursive: true })
      fs.writeFileSync(file, data)
    }
    const members = execFileSync(TAR, ["-tzf", file], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .filter((name) => /^(?:[^/]+\/)?git-lfs$/.test(name))
    if (members.length !== 1) throw new Error(`${spec.asset}: ${members.length} git-lfs binaries, expected one`)
    const binary = extractOne(file, members[0]!, path.join(input.dir, "git-lfs", `unpack-${target}`))
    checkLfsBinary(binary, target, `${spec.asset}: ${members[0]}`)
    const dest = path.join(input.dir, "git-lfs", pin.version, target)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, "git-lfs"), binary)
    fs.writeFileSync(path.join(dest, "LICENSE.md"), GIT_LFS_LICENSE)
    results.push({
      target,
      version: pin.version,
      asset: spec.asset,
      url,
      source: local ? "local" : cached ? "cache" : "download",
      archive: { sha256: spec.sha256, bytes: fs.statSync(file).size },
      file: path.join(dest, "git-lfs"),
      sha256: sha256(binary),
      bytes: binary.length,
    })
  }
  return results
}

function arg(args: string[], name: string) {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const dirArg = arg(args, "dir")
  const targets = (arg(args, "targets") ?? "").split(",").filter(Boolean)
  if (!dirArg || targets.length === 0) throw new Error("--dir and --targets required")
  // Absolute paths only: Bun on Windows fails `mkdirSync(<existing ..\..\dir>, { recursive: true })` with EEXIST.
  const dir = path.resolve(dirArg)
  const names = namesFor(targets)
  const lockText = fs.readFileSync(path.join(REPO, "bun.lock"), "utf8")
  const log = (line: string) => console.error(line)
  const result = await (async () => {
    if (command === "fetch") return fetchNative({ dir, names, lockText, log })
    if (command === "link") return linkNative({ dir, names, lockText })
    if (command === "unlink") return unlinkNative({ dir, names, lockText })
    if (command === "runtime") {
      const bun = arg(args, "bun") ?? Bun.version
      const cacheArg = arg(args, "cache-dir")
      const cacheDir = cacheArg ? path.resolve(cacheArg) : undefined
      const checks: RuntimeCheck[] = []
      for (const target of targets) checks.push(await verifyRuntime({ dir, target: target as Target, bun, cacheDir, log }))
      return checks
    }
    if (command === "lfs") {
      const pinFile = arg(args, "pin")
      const archives = Object.fromEntries(
        args.flatMap((value, index) => {
          if (value !== "--archive") return []
          const [target, file] = (args[index + 1] ?? "").split(/=(.*)/s)
          if (!target || !file || !(target in NATIVE_PACKAGES)) throw new Error("--archive <target>=<path>")
          return [[target, path.resolve(file)]]
        }),
      )
      return fetchLfs({
        dir,
        targets: targets as Target[],
        pin: pinFile ? readPin(fs.readFileSync(pinFile, "utf8")) : GIT_LFS,
        archives,
        log,
      })
    }
    throw new Error(`unknown command ${command}`)
  })()
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
}
