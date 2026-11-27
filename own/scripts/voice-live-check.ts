// Voice input live check (02 §3.9): one recognition of a local audio file through this PC's own service, which sends
// it to the selected recognition service with the voice-only key it keeps in the vault. The script never sees a key:
// it calls the service's RPC `own.accounts` `voice.transcribe` on 127.0.0.1 like own-web does, and prints the
// transcript, the latency and the sizes. Run it yourself: a real recognition spends the voice key's paid minutes.
//
//   bun own/scripts/voice-live-check.ts --make-sample [--text "…"] [--culture ko-KR] [--out own/.out/voice/sample-ko.wav]
//       A Korean sample WAV (16 kHz, 16-bit, mono) from Windows' built-in speech synthesis (System.Speech through
//       Windows PowerShell 5.1; nothing is downloaded). Needs an installed voice of that culture (Korean: Microsoft
//       Heami, part of the Korean language pack); the error lists the installed voices otherwise.
//   bun own/scripts/voice-live-check.ts --file <audio> [--language ko|en|auto] [--hint "own-web, Composer"]
//       [--channel own] [--control DIR]
//       The check: `voice.get` (is voice input on, which service, is its key set — never the key), then
//       `voice.transcribe` with the file (wav, webm, ogg, mp3, m4a; at most 3 minutes and 4 MiB).
//   bun own/scripts/voice-live-check.ts --self-test
//       The same request against a fake service on 127.0.0.1 (no recognition service, no key, no cost).
//
// The service URL and password come from the service's registration file (`<XDG_STATE_HOME or ~/.local/state>/
// opencode/service-own.json`, read through @own/runtime ServiceTarget like own's plugins do). The password is used
// only as HTTP Basic to that loopback URL and is never printed: every line is checked for it before it is written.
// The audio is not stored by the service (02 §3.9); this script keeps nothing either.
// Exit: 0 transcribed (or sample made, self-test passed), 1 failed, 64 usage error.
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { Voice } from "../../packages/own-protocol/src/voice"
import { ServiceTarget } from "../../packages/own-runtime/src/index"

const REPO = path.resolve(import.meta.dir, "../..")
const USAGE =
  "usage: bun own/scripts/voice-live-check.ts (--make-sample [--text T] [--culture ko-KR] [--out FILE] | --file AUDIO [--language ko|en|auto] [--hint H] [--channel own] [--control DIR] | --self-test)"
const DEFAULT_TEXT = "안녕하세요. 음성 입력 시험입니다. 컴포저 입력창에 받아쓴 글이 커서 위치에 들어가는지 확인합니다."
const MEDIA_TYPES: Readonly<Record<string, Voice.MediaType>> = {
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
}

const args = parseArgs({
  options: {
    "make-sample": { type: "boolean" },
    "self-test": { type: "boolean" },
    file: { type: "string" },
    text: { type: "string" },
    culture: { type: "string" },
    out: { type: "string" },
    language: { type: "string" },
    hint: { type: "string" },
    channel: { type: "string" },
    control: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
}).values

if (import.meta.main) process.exit(await main())

async function main(): Promise<number> {
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  if (args["make-sample"]) return makeSample()
  if (args["self-test"]) return selfTest()
  if (!args.file) return usage("--file, --make-sample or --self-test is required")
  const language = args.language
  if (language !== undefined && !Voice.Language.literals.some((item) => item === language))
    return usage("--language must be ko, en or auto")
  const service = await new ServiceTarget.Service(ServiceTarget.registrationPath(args.channel ?? "own")).current()
  if (!service) {
    console.error("The own service is not running (no service-own.json registration). Start it with `own start`.")
    return 1
  }
  const control =
    args.control ??
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "own-open-code", "control")
  return check({ service, control, file: args.file, language: language as Voice.Language | undefined, hint: args.hint })
}

/** `voice.get`, then one `voice.transcribe` of `file`; prints what happened. */
async function check(input: {
  readonly service: ServiceTarget.Target
  readonly control: string
  readonly file: string
  readonly language?: Voice.Language
  readonly hint?: string
  readonly print?: (line: string) => void
}) {
  const print = guarded(input.service, input.print ?? ((line) => console.log(line)))
  const mediaType = MEDIA_TYPES[path.extname(input.file).toLowerCase()]
  if (!mediaType) {
    print(`Unsupported file type: ${path.extname(input.file) || "(none)"} (wav, webm, ogg, mp3, m4a)`)
    return 1
  }
  const bytes = new Uint8Array(await fs.readFile(input.file))
  if (bytes.byteLength > Voice.MAX_AUDIO_BYTES) {
    print(`The file is ${bytes.byteLength} bytes; voice input takes at most ${Voice.MAX_AUDIO_BYTES}.`)
    return 1
  }
  const durationMs = mediaType === "audio/wav" ? wavDurationMs(bytes) : undefined
  if (durationMs !== undefined && durationMs > Voice.MAX_SECONDS * 1000) {
    print(`The recording is ${(durationMs / 1000).toFixed(1)} s; voice input takes at most ${Voice.MAX_SECONDS} s.`)
    return 1
  }
  const rpc = async (method: string, body: unknown) => {
    const response = await fetch(
      new URL(
        `/api/rpc/own.accounts/${method}?${new URLSearchParams({ "location[directory]": input.control })}`,
        input.service.url,
      ),
      {
        method: "POST",
        headers: {
          authorization: input.service.authorization,
          "content-type": "application/json",
          "x-opencode-directory": encodeURIComponent(input.control),
        },
        body: JSON.stringify({ input: body }),
        signal: AbortSignal.timeout(120_000),
      },
    )
    const text = await response.text()
    const json: unknown = text ? JSON.parse(text) : undefined
    return { ok: response.ok, status: response.status, json }
  }

  const settings = await rpc("voice.get", {})
  if (!settings.ok) {
    print(`voice.get failed: HTTP ${settings.status} ${describe(settings.json)}`)
    return 1
  }
  const view = output(settings.json) as Partial<Voice.View>
  const provider = view.provider ?? "?"
  const key = view.keys?.find((item) => item.provider === provider)
  print(
    `Voice input: ${view.enabled ? "on" : "OFF"} · service ${provider} (${view.model ?? "?"}) · language ${input.language ?? view.language ?? "?"} · key ${key?.configured ? "set" : "MISSING"}`,
  )
  const audio = Buffer.from(bytes).toString("base64")
  print(
    `Audio: ${input.file} · ${mediaType} · ${bytes.byteLength} bytes (${audio.length} base64)${durationMs === undefined ? "" : ` · ${(durationMs / 1000).toFixed(2)} s`}`,
  )
  const started = performance.now()
  const answer = await rpc("voice.transcribe", {
    audio,
    mediaType,
    ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs) }),
    ...(input.language ? { language: input.language } : {}),
    ...(input.hint ? { hint: input.hint.slice(0, Voice.MAX_HINT_CHARS) } : {}),
  })
  const latency = Math.round(performance.now() - started)
  if (!answer.ok) {
    print(`voice.transcribe failed after ${latency} ms: HTTP ${answer.status} ${describe(answer.json)}`)
    return 1
  }
  const result = output(answer.json) as Partial<Voice.TranscribeResult>
  print(`Latency: ${latency} ms · counted ${result.seconds ?? "?"} s · ${result.provider ?? "?"} ${result.model ?? ""}`)
  print(`Transcript: ${result.text ?? ""}`)
  return 0
}

/** Prints nothing that holds the service credential (the header, its base64 or the password itself). */
function guarded(service: ServiceTarget.Target, print: (line: string) => void) {
  const encoded = service.authorization.replace(/^Basic\s+/i, "")
  const password = Buffer.from(encoded, "base64")
    .toString("utf8")
    .replace(/^opencode:/, "")
  const secrets = [service.authorization, encoded, password].filter((item) => item.length >= 8)
  return (line: string) => print(secrets.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), line))
}

function output(json: unknown) {
  return typeof json === "object" && json !== null && "output" in json ? json.output : undefined
}

/** An RPC error's `type` and `data` (02 §3.9 errors carry the service, the reason and the HTTP status only). */
function describe(json: unknown) {
  if (typeof json !== "object" || json === null) return ""
  const record = json as Record<string, unknown>
  return [record.type, record.data === undefined ? undefined : JSON.stringify(record.data)].filter(Boolean).join(" ")
}

/** Length of a PCM WAV from its `fmt ` byte rate and `data` size; undefined when the header is not plain RIFF. */
export function wavDurationMs(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined
  let byteRate: number | undefined
  for (let offset = 12; offset + 8 <= bytes.byteLength; ) {
    const size = view.getUint32(offset + 4, true)
    if (tag(offset) === "fmt " && offset + 16 <= bytes.byteLength) byteRate = view.getUint32(offset + 16, true)
    if (tag(offset) === "data")
      return byteRate ? (Math.min(size, bytes.byteLength - offset - 8) / byteRate) * 1000 : undefined
    offset += 8 + size + (size % 2)
  }
  return undefined
}

/** Windows' built-in speech synthesis to a 16 kHz mono WAV (Windows PowerShell 5.1 has System.Speech; pwsh does not). */
function makeSample() {
  const out = path.resolve(args.out ?? path.join(REPO, "own", ".out", "voice", "sample-ko.wav"))
  const culture = args.culture ?? "ko-KR"
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })",
    "$voice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq $env:OWN_TTS_CULTURE } | Select-Object -First 1",
    "if (-not $voice) { [Console]::Error.WriteLine('No ' + $env:OWN_TTS_CULTURE + ' voice. Installed: ' + (($voices | ForEach-Object { $_.VoiceInfo.Name + ' (' + $_.VoiceInfo.Culture.Name + ')' }) -join ', ')); exit 3 }",
    "$synth.SelectVoice($voice.VoiceInfo.Name)",
    "$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    "$synth.SetOutputToWaveFile($env:OWN_TTS_OUT, $format)",
    "$synth.Speak($env:OWN_TTS_TEXT)",
    "$synth.Dispose()",
    "Write-Output $voice.VoiceInfo.Name",
  ].join("; ")
  return fs.mkdir(path.dirname(out), { recursive: true }).then(async () => {
    if (process.platform !== "win32") {
      console.error("--make-sample needs Windows (System.Speech).")
      return 1
    }
    const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, OWN_TTS_TEXT: args.text ?? DEFAULT_TEXT, OWN_TTS_OUT: out, OWN_TTS_CULTURE: culture },
      encoding: "utf8",
      windowsHide: true,
    })
    if (run.status !== 0) {
      console.error(run.stderr.trim() || `powershell exited with ${run.status}`)
      return 1
    }
    const bytes = new Uint8Array(await fs.readFile(out))
    const duration = wavDurationMs(bytes)
    console.log(
      `Sample: ${out} · ${run.stdout.trim()} · ${bytes.byteLength} bytes${duration === undefined ? "" : ` · ${(duration / 1000).toFixed(2)} s`}`,
    )
    console.log(`Next: bun own/scripts/voice-live-check.ts --file "${out}"`)
    return 0
  })
}

/** The request path against a fake service: Basic auth, location, body shape, and no password in the output. */
async function selfTest() {
  const password = `fake-service-password-${crypto.randomUUID()}`
  const seen: { path: string; search: string; auth: string | null; body: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body: unknown = await request.json().catch(() => undefined)
      seen.push({ path: url.pathname, search: url.search, auth: request.headers.get("authorization"), body })
      if (request.headers.get("authorization") !== ServiceTarget.basic(password))
        return Response.json({ type: "unauthorized" }, { status: 401 })
      if (url.pathname === "/api/rpc/own.accounts/voice.get")
        return Response.json({
          output: {
            enabled: true,
            provider: "openai",
            language: "ko",
            keys: [{ provider: "openai", configured: true, keyHint: "sk-…FAKE" }],
            model: "gpt-transcribe",
            usage: [],
            limits: { maxSeconds: Voice.MAX_SECONDS, maxAudioBytes: Voice.MAX_AUDIO_BYTES, maxHintChars: 600 },
            vault: "ok",
          },
        })
      if (url.pathname === "/api/rpc/own.accounts/voice.transcribe")
        return Response.json({
          output: { text: `받아쓰기 시험 (${password})`, provider: "openai", model: "gpt-transcribe", seconds: 1 },
        })
      return Response.json({ type: "not_found" }, { status: 404 })
    },
  })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-voice-check-"))
  const file = path.join(dir, "silence.wav")
  await fs.writeFile(file, silentWav(16_000, 1_000))
  const lines: string[] = []
  try {
    const code = await check({
      service: { url: `http://127.0.0.1:${server.port}`, authorization: ServiceTarget.basic(password) },
      control: "C:\\own-home\\control",
      file,
      language: "ko",
      hint: "own-web, Composer",
      print: (line) => lines.push(line),
    })
    const transcribe = seen.find((item) => item.path === "/api/rpc/own.accounts/voice.transcribe")
    const sent = (transcribe?.body as { input?: Record<string, unknown> } | undefined)?.input ?? {}
    const failures = [
      code === 0 ? undefined : `exit ${code}`,
      seen.every((item) => item.auth === ServiceTarget.basic(password)) ? undefined : "Basic auth missing",
      transcribe?.search.includes("location%5Bdirectory%5D=") ? undefined : "location query missing",
      sent.mediaType === "audio/wav" && sent.durationMs === 1000 && sent.language === "ko" ? undefined : "input shape",
      typeof sent.audio === "string" && Buffer.from(sent.audio, "base64").byteLength === 44 + 32_000
        ? undefined
        : "audio bytes",
      lines.some((line) => line.includes(password)) ? "password printed" : undefined,
      lines.some((line) => line.startsWith("Transcript: 받아쓰기 시험")) ? undefined : "transcript not printed",
    ].filter(Boolean)
    for (const line of lines) console.log(`  | ${line}`)
    console.log(failures.length ? `self-test FAILED: ${failures.join(", ")}` : "self-test passed")
    return failures.length ? 1 : 0
  } finally {
    await server.stop(true)
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** A 16-bit mono PCM WAV of silence. */
function silentWav(rate: number, ms: number) {
  const data = Math.round((rate * ms) / 1000) * 2
  const buffer = Buffer.alloc(44 + data)
  buffer.write("RIFF", 0, "ascii")
  buffer.writeUInt32LE(36 + data, 4)
  buffer.write("WAVEfmt ", 8, "ascii")
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write("data", 36, "ascii")
  buffer.writeUInt32LE(data, 40)
  return buffer
}

function usage(message: string) {
  console.error(`${message}\n${USAGE}`)
  return 64
}
