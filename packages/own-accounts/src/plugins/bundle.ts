export * as ClaudeBundle from "./bundle.js"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Option, Schema } from "effect"
import { Plugin } from "@own/protocol"
import { Fsx } from "@own/runtime"
import type { Claude } from "./claude.js"

/**
 * The Claude subscription plugin as the app ships it (02 §8.2, user decision 2026-10-18 "넣고 항상 켜기"): the pinned
 * `opencode-claude-auth-v2`, installed from the committed lock, verified, patched (`own/vendor/claude-auth/patches`)
 * and bundled at build time (`own/scripts/claude-auth-bundle.ts`) into `app\<version>\plugins\claude-auth`, always in
 * the plugin list between own.team and own.telemetry. Nothing is downloaded, installed or patched at runtime.
 *
 * The folder's {@link RECORD_FILE} names the pin, the patch manifest's hash, the release build id and the sha256 of
 * every other file; {@link read} checks them, so the patch is `patched` by construction and `modified` once any file
 * differs (blocked like an integrity mismatch).
 *
 * The plugin's own state, the account list own writes ({@link ACCOUNTS_FILE}) and the per-account state and locks
 * (`claude-auth-state\`), lives outside the versioned folder in {@link stateDir} (`<OWN_HOME>\thirdparty\claude-auth`,
 * the folder of the former npm install), which own names to the loaded module (`ownUseStateDir`, `ClaudeWire`): an app
 * update keeps every login.
 */

export const DIR_NAME = "claude-auth"
export const RECORD_FILE = "own-bundle.json"
/**
 * The account list own writes for the patched plugin (`{version, default, accounts: [{key, configDir, label?,
 * readOnly?}]}`).
 */
export const ACCOUNTS_FILE = "claude-accounts.json"
/**
 * The list's version (CS): 2 since own decides `readOnly` for every login Claude Code uses. The patched plugin reads an
 * older or unknown one too, but then treats every folder own did not make as read only, until own rewrote it.
 */
export const LIST_VERSION = 2
/** The export the patched module carries (`OWN_MULTI_ACCOUNT = 1`), checked like the relay's other exports. */
export const MARKER = "OWN_MULTI_ACCOUNT"

/** The verified state of a bundle: `patched` while every file has its recorded hash, else `modified`. */
export type State = "patched" | "modified"

export interface Info extends Claude.Pin {
  readonly dir: string
  readonly patchSha256: string
  readonly buildId: string | null
  readonly state: State
}

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const Record = Schema.Struct({
  schema: Schema.Literal(1),
  package: Schema.Literal(Plugin.CLAUDE_AUTH_PACKAGE),
  version: Schema.String,
  integrity: Schema.String,
  patchSha256: Sha,
  buildId: Schema.NullOr(Schema.String),
  files: Schema.Record(Schema.String, Sha),
})
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(Record))

/** `<OWN_HOME>\thirdparty\claude-auth`: the account list and the per-account state (stable across app versions). */
export function stateDir(thirdparty: string) {
  return path.join(thirdparty, DIR_NAME)
}

/** The account list in `stateDir` is of {@link LIST_VERSION} (the leader of this version wrote it). */
export async function listCurrent(stateDir: string) {
  const text = await Fsx.readText(path.join(stateDir, ACCOUNTS_FILE)).catch(() => undefined)
  return Option.getOrUndefined(decodeList(text ?? ""))?.version === LIST_VERSION
}

const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ version: Schema.Finite })))

/** Where the app ships the plugin: `app\<version>\plugins\claude-auth` of the installed version. */
export function dir(app: string) {
  return path.join(app, "plugins", DIR_NAME)
}

/**
 * In an unbundled source run, the bundle script's default output `own/.out/claude-auth`, which a development config
 * loads (`bun own/scripts/claude-auth-bundle.ts --out own/.out/claude-auth`); `undefined` in a release bundle. Trusted
 * like the shipped folder, never taken for the shipped bundle itself.
 */
export function devDir(here = fileURLToPath(import.meta.url)) {
  if (!here.endsWith(".ts")) return undefined
  return path.resolve(path.dirname(here), "..", "..", "..", "..", "own", ".out", DIR_NAME)
}

/**
 * The bundle in `dir` with its verified state, or `undefined` when the folder has no readable record (not the app's
 * bundle: nothing there can be checked). A record whose package files differ in any byte is `modified`.
 */
export async function read(dir: string): Promise<Info | undefined> {
  const record = Option.getOrUndefined(
    decodeRecord((await Fsx.readText(path.join(dir, RECORD_FILE)).catch(() => undefined)) ?? ""),
  )
  if (!record) return undefined
  const entries = Object.entries(record.files)
  const hashes = await Promise.all(
    entries.map(([file]) =>
      fs.readFile(path.join(dir, ...file.split("/"))).then(
        (bytes) => sha256(bytes),
        () => undefined,
      ),
    ),
  )
  const intact =
    entries.length > 0 &&
    entries.every(([file, expected], index) => safe(file) && hashes[index] === expected) &&
    record.files[`node_modules/${Plugin.CLAUDE_AUTH_PACKAGE}/dist/index.js`] !== undefined
  return {
    dir,
    version: record.version,
    integrity: record.integrity,
    patchSha256: record.patchSha256,
    buildId: record.buildId,
    state: intact ? "patched" : "modified",
  }
}

/** A record path stays inside the bundle folder (`a/b.js`, never `..` or absolute). */
function safe(file: string) {
  return file !== "" && !path.isAbsolute(file) && !file.split("/").some((part) => part === ".." || part === "")
}

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}
