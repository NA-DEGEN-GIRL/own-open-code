// Model calls for the compaction evaluation. Credentials are read from the user's existing logins only, in memory:
// ChatGPT access tokens from the codex-multi-provider profiles (read-only, never refreshed) and the DeepSeek key
// from that app's DPAPI file. Nothing here prints or stores a credential.
import { readFile } from "node:fs/promises"

const PROFILES =
  process.env.OWN_EVAL_PROFILES ?? "D:/#Projects/codex-multi-provider/work/control-center/profiles"
const CHATGPT: Readonly<Record<string, string>> = {
  "01": "00000000-0000-4000-8000-000000000001",
  "03": "00000000-0000-4000-8000-000000000003",
}
const DEEPSEEK_KEY_FILE = process.env.OWN_EVAL_DEEPSEEK_KEY ?? "D:/#Projects/codex-multi-provider/profiles/deepseek.dpapi"

export interface Usage {
  readonly input: number
  readonly cached: number
  readonly output: number
}

export interface Reply {
  readonly text: string
  readonly items: ReadonlyArray<Record<string, unknown>>
  readonly usage?: Usage
}

export type Message = { readonly role: "system" | "user" | "assistant"; readonly content: string }

async function chatgptAuth(alias: string) {
  const file = JSON.parse(await readFile(`${PROFILES}/${CHATGPT[alias]}/codex/auth.json`, "utf8"))
  return { token: String(file.tokens.access_token), account: String(file.tokens.account_id) }
}

/** Codex's ChatGPT backend (Responses, streamed). `extra` items go after the messages (e.g. a compaction trigger). */
export async function gpt(
  alias: string,
  model: string,
  messages: ReadonlyArray<Message | Record<string, unknown>>,
  options: { readonly effort?: string } = {},
): Promise<Reply> {
  const auth = await chatgptAuth(alias)
  const input = messages.map((message) =>
    "role" in message && typeof message.content === "string"
      ? {
          type: "message",
          role: message.role === "system" ? "developer" : message.role,
          content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }],
        }
      : message,
  )
  const body = {
    model,
    input,
    stream: true,
    store: false,
    reasoning: { effort: options.effort ?? "medium" },
  }
  return retry(async () => {
    const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "chatgpt-account-id": auth.account,
        originator: "codex_cli_rs",
        "x-codex-beta-features": "remote_compaction_v2",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new HttpError(response.status, (await response.text()).slice(0, 500))
    const items: Array<Record<string, unknown>> = []
    let usage: Usage | undefined
    let failure: string | undefined
    for (const line of (await response.text()).split("\n")) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "" || data === "[DONE]") continue
      const event = JSON.parse(data)
      if (event.type === "response.output_item.done") items.push(event.item)
      if (event.type === "response.completed") {
        const raw = event.response?.usage
        if (raw)
          usage = {
            input: raw.input_tokens ?? 0,
            cached: raw.input_tokens_details?.cached_tokens ?? 0,
            output: raw.output_tokens ?? 0,
          }
      }
      if (event.type === "response.failed" || event.type === "error") failure = JSON.stringify(event).slice(0, 500)
    }
    if (failure) throw new HttpError(0, failure)
    const text = items
      .filter((item) => item.type === "message")
      .flatMap((item) => (item.content as Array<{ text?: string }>).map((part) => part.text ?? ""))
      .join("")
    return { text, items, usage }
  })
}

let deepseekKey: Promise<string> | undefined

/** The DeepSeek key, decrypted in memory through Windows DPAPI (CurrentUser) and kept only in this process. */
function deepseekAuth() {
  deepseekKey ??= (async () => {
    const script = [
      "Add-Type -AssemblyName System.Security",
      "$b = [IO.File]::ReadAllBytes($env:OWN_EVAL_KEY_FILE)",
      "$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')",
      "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p).Trim([char]0).Trim())",
    ].join("; ")
    const run = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, OWN_EVAL_KEY_FILE: DEEPSEEK_KEY_FILE },
      stdout: "pipe",
      stderr: "pipe",
    })
    const key = run.stdout.toString().trim()
    if (!key.startsWith("sk-")) throw new Error("DeepSeek key could not be read")
    return key
  })()
  return deepseekKey
}

/** DeepSeek's OpenAI-compatible chat completions. */
export async function deepseek(model: string, messages: ReadonlyArray<Message>, maxTokens = 32_000): Promise<Reply> {
  const key = await deepseekAuth()
  return retry(async () => {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false }),
    })
    if (!response.ok) throw new HttpError(response.status, (await response.text()).slice(0, 500))
    const data = await response.json()
    const choice = data.choices?.[0]
    return {
      text: String(choice?.message?.content ?? ""),
      items: [{ finish: choice?.finish_reason, reasoning: choice?.message?.reasoning_content ? "present" : "none" }],
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        cached: data.usage?.prompt_cache_hit_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
    }
  })
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body}`)
  }
}

/** Retries rate limits, server errors and dropped streams with backoff (four attempts). */
async function retry<A>(work: () => Promise<A>): Promise<A> {
  const attempt = async (count: number): Promise<A> => {
    const result = await work().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (result.ok) return result.value
    const status = result.error instanceof HttpError ? result.error.status : 0
    if (count >= 4 || (status >= 400 && status < 500 && status !== 429)) throw result.error
    await Bun.sleep(2_000 * 2 ** count)
    return attempt(count + 1)
  }
  return attempt(1)
}
