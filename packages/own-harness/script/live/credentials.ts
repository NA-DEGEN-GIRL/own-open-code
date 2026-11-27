// Real credentials for the live harness test, read from the user's existing logins only and kept in this process:
// ChatGPT access tokens from the codex-multi-provider profiles (read-only, never refreshed), the DeepSeek key from
// that app's DPAPI file, and the Anthropic and OpenAI API keys the user typed into set-key.ps1 (DPAPI, this Windows
// user only).
// Nothing here prints, logs or stores a credential; the forwarder adds them to requests.
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"

const PROFILES = process.env.OWN_LIVE_PROFILES ?? "D:/#Projects/codex-multi-provider/work/control-center/profiles"
const CHATGPT: Readonly<Record<string, string>> = {
  "01": "00000000-0000-4000-8000-000000000001",
  "03": "00000000-0000-4000-8000-000000000003",
}
const DEEPSEEK_KEY_FILE = process.env.OWN_LIVE_DEEPSEEK_KEY ?? "D:/#Projects/codex-multi-provider/profiles/deepseek.dpapi"
/** The Anthropic API key the user stored with set-key.ps1 (DPAPI, this Windows user only). */
const ANTHROPIC_KEY_FILE =
  process.env.OWN_LIVE_ANTHROPIC_KEY ?? `${process.env.LOCALAPPDATA ?? ""}/own-live-test/anthropic.dpapi`

/** The OpenAI API key the user stored with `set-key.ps1 -Provider openai` (live image tests, decisions IM-28). */
const OPENAI_KEY_FILE = process.env.OWN_LIVE_OPENAI_KEY ?? `${process.env.LOCALAPPDATA ?? ""}/own-live-test/openai.dpapi`

export const CHATGPT_ALIASES = Object.keys(CHATGPT)

/** The account's access token and id, read again on every call so a refresh by the other app is picked up. */
export async function chatgpt(alias: string) {
  const id = CHATGPT[alias]
  if (id === undefined) throw new Error(`unknown ChatGPT alias ${alias}`)
  const file = JSON.parse(await readFile(`${PROFILES}/${id}/codex/auth.json`, "utf8"))
  const token = String(file.tokens.access_token)
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString())
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now() + 60_000)
    throw new Error(`ChatGPT ${alias}: the access token expired; the codex-multi-provider app has to refresh it`)
  return { token, account: String(file.tokens.account_id) }
}

let deepseekKey: Promise<string> | undefined
let anthropicKey: Promise<string> | undefined
let openaiKey: Promise<string> | undefined

/** The DeepSeek key, decrypted in memory through Windows DPAPI (CurrentUser). */
export function deepseek() {
  deepseekKey ??= unseal(DEEPSEEK_KEY_FILE, "sk-", "DeepSeek key could not be read")
  return deepseekKey
}

/** The Anthropic API key from set-key.ps1, decrypted in memory the same way. */
export function anthropic() {
  anthropicKey ??= unseal(
    ANTHROPIC_KEY_FILE,
    "sk-ant-",
    "No Anthropic key: run script/live/set-key.ps1 (it asks for the key and stores it sealed)",
  )
  return anthropicKey
}

/** The OpenAI API key from `set-key.ps1 -Provider openai`, decrypted in memory the same way. */
export function openai() {
  openaiKey ??= unseal(
    OPENAI_KEY_FILE,
    "sk-",
    "No OpenAI key: run script/live/set-key.ps1 -Provider openai (it asks for the key and stores it sealed)",
  )
  return openaiKey
}

/** Whether set-key.ps1 has stored an OpenAI key, and where it looks. */
export function hasOpenai() {
  return existsSync(OPENAI_KEY_FILE)
}
export const OPENAI_KEY_PATH = OPENAI_KEY_FILE

/** Whether set-key.ps1 has stored an Anthropic key (the runner then adds the Anthropic provider). */
export function hasAnthropic() {
  return existsSync(ANTHROPIC_KEY_FILE)
}

async function unseal(file: string, prefix: string, missing: string) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$b = [IO.File]::ReadAllBytes($env:OWN_LIVE_KEY_FILE)",
    "$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p).Trim([char]0).Trim())",
  ].join("; ")
  const run = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, OWN_LIVE_KEY_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  })
  const key = run.stdout.toString().trim()
  if (!key.startsWith(prefix)) throw new Error(missing)
  return key
}
