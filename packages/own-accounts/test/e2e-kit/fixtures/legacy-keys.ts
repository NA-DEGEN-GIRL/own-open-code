import fs from "node:fs/promises"
import path from "node:path"
import { Vault } from "@own/runtime"

/**
 * Fake copy of the old app's saved API keys (02 §3.2b) that own-accounts links by reference:
 *
 *   <root>\codex-multi-provider\profiles\provider.json                            {base_url, protocol, model}
 *   <root>\codex-multi-provider\profiles\deepseek.dpapi                            credential_ref legacy:deepseek
 *   <root>\codex-multi-provider\work\control-center\providers.json                 the manager's registry
 *   <root>\codex-multi-provider\work\control-center\credentials\<id>.dpapi         credential_ref dpapi:<id>
 *
 * own-accounts finds the app root two levels above its `codexImportRoot` (the control center), so tests pass
 * `controlCenter` as that option. The key files are sealed either with real DPAPI (CurrentUser, no entropy, exactly
 * the old app's format, for the real own-vault.exe) or with `Vault.fakeSeal` (for the memory vault). Keys are fake;
 * the real `D:\#Projects\codex-multi-provider\…` is never touched.
 */
export interface LegacyApp {
  /** `<root>\codex-multi-provider`. */
  readonly appRoot: string
  /** `<appRoot>\work\control-center`: the `codexImportRoot` option. */
  readonly controlCenter: string
}

export type Seal = "dpapi" | "fake"

export async function createLegacyApp(root: string): Promise<LegacyApp> {
  const appRoot = path.join(root, "codex-multi-provider")
  const controlCenter = path.join(appRoot, "work", "control-center")
  await fs.mkdir(path.join(appRoot, "profiles"), { recursive: true })
  await fs.mkdir(path.join(controlCenter, "credentials"), { recursive: true })
  return { appRoot, controlCenter }
}

/** The old app's first DeepSeek connection: `profiles\provider.json` and, with `key`, `profiles\deepseek.dpapi`. */
export async function writeLegacyDeepSeek(
  app: LegacyApp,
  input: {
    readonly key?: string
    readonly seal?: Seal
    readonly baseURL?: string
    readonly model?: string
  } = {},
) {
  await Bun.write(
    path.join(app.appRoot, "profiles", "provider.json"),
    JSON.stringify(
      {
        base_url: input.baseURL ?? "https://api.deepseek.com",
        protocol: "responses",
        model: input.model ?? "deepseek-flash",
      },
      null,
      2,
    ),
  )
  const file = path.join(app.appRoot, "profiles", "deepseek.dpapi")
  if (input.key !== undefined) await sealKey(file, input.key, input.seal ?? "fake")
  return file
}

/** Replaces a saved key the way the old app does (new blob, atomic replace) and moves the mtime forward. */
export async function replaceLegacyKey(file: string, key: string, seal: Seal = "fake") {
  const temp = `${file}.${process.pid}.tmp`
  await sealKey(temp, key, seal)
  await fs.rename(temp, file)
  const later = new Date(Date.now() + 60_000)
  await fs.utimes(file, later, later)
}

/** Writes one key file. `dpapi`: .NET ProtectedData (CurrentUser, `$null` entropy), the old app's exact format. */
export async function sealKey(file: string, key: string, seal: Seal) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  if (seal === "fake") return void (await fs.writeFile(file, Vault.fakeSeal(key)))
  const script =
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
    "$v=[Text.Encoding]::UTF8.GetBytes($env:OWN_FAKE_KEY); " +
    "[IO.File]::WriteAllBytes($env:OWN_FAKE_FILE,[Security.Cryptography.ProtectedData]::Protect($v,$null," +
    "[Security.Cryptography.DataProtectionScope]::CurrentUser))"
  // The fake key goes through the child's environment, never its command line.
  const run = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, OWN_FAKE_KEY: key, OWN_FAKE_FILE: file },
  })
  if (run.exitCode !== 0) throw new Error(`ProtectedData failed: ${run.stderr.toString()}`)
}

/** Whether this machine can write real DPAPI key files (Windows PowerShell with .NET ProtectedData). */
export function canSealDpapi() {
  if (process.platform !== "win32") return false
  const run = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "exit 0"])
  return run.exitCode === 0
}
