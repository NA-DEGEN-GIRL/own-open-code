// The installed release (01 §5.1): OWN_HOME\app\current.json {schema, version, path, previous, updatedAt, launcher},
// written atomically by own.ps1 (Write-VersionPointer) on every install, update and rollback. The shell reads the
// version folder app\<version> next to the file (`path` is informational, so a moved OWN_HOME keeps working).
// Installs of launcher 0.3.0 and earlier have an app\current junction instead: only its target is read, from the link
// itself; it is never followed, because on some Windows 11 builds files under %LOCALAPPDATA% cannot be opened through
// a junction (attribute queries still succeed). Same rules as `Home.installed` in @own/runtime (the plugins' side);
// synchronous on purpose: the entry calls it before the first window (one small file and a few stats, R-D1).
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs"
import path from "node:path"

export interface InstalledApp {
  /** The version folder name (`2.0.18-own.3`); `current` for a plain app\current folder. */
  readonly version: string
  /** `OWN_HOME\app\<version>`. */
  readonly dir: string
  /** `pointer`: app\current.json; `junction`: an older launcher's app\current (its target); `folder`: a plain one. */
  readonly source: "pointer" | "junction" | "folder"
}

const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/

export function isVersionName(name: string) {
  return VERSION_NAME.test(name) && name !== "current" && !name.endsWith(".json")
}

export function pointerFile(ownHome: string) {
  return path.join(ownHome, "app", "current.json")
}

export function installedApp(ownHome: string): InstalledApp | undefined {
  const app = path.join(ownHome, "app")
  const version = pointerVersion(pointerFile(ownHome))
  if (version) {
    const dir = path.join(app, version)
    if (isFile(path.join(dir, "manifest.json"))) return { version, dir, source: "pointer" }
  }
  const legacy = path.join(app, "current")
  let link
  try {
    link = lstatSync(legacy)
  } catch {
    return undefined
  }
  if (link.isSymbolicLink()) {
    let target: string
    try {
      target = path.resolve(app, readlinkSync(legacy).replace(/^\\\\\?\\|^\\\?\?\\/, ""))
    } catch {
      return undefined
    }
    return isFile(path.join(target, "manifest.json"))
      ? { version: path.basename(target), dir: target, source: "junction" }
      : undefined
  }
  if (link.isDirectory() && isFile(path.join(legacy, "manifest.json")))
    return { version: "current", dir: legacy, source: "folder" }
  return undefined
}

function pointerVersion(file: string) {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""))
    if (typeof value !== "object" || value === null) return undefined
    const version = (value as Record<string, unknown>).version
    return typeof version === "string" && isVersionName(version) ? version : undefined
  } catch {
    return undefined
  }
}

function isFile(file: string) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}
