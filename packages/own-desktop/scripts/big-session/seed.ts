// Synthetic huge session for perf-big-session.ts: one session grown in place to 1 / 10 / 100 GB (or to a message
// count) straight into the service's SQLite file while the service is stopped.
//
// The rows are the service's own: a template turn (every row and part kind the generator uses, with placeholder text)
// is imported through `POST /api/experimental/session/import`, so the real encoder writes it; the generator reads
// those stored rows back, splits them at the placeholders and fills them from pre-escaped text pools, PNG screenshots
// and computed ids, times and markers. The template rows are deleted again before the first generated row. Generated
// rows of every kind are decoded with core's own row decoder before anything is written in bulk.
//
// Storage layout as an installed app writes it: `part_rows` and `media_blob` are off in a release, so every assistant
// step is one `session_message` row with its parts inline and every image is base64 inside the row.
//
// Shapes:
//   screens  a long computer-use / coding session: per turn one user prompt (2 % with a pasted screenshot), 0-6 tool
//            steps and a final answer. Tools: screenshot 30 % and click 10 % (each a 0.3-2 MB base64 PNG of
//            1280×800), read 20 % (2-50 KB), grep 10 % (1-20 KB), bash 15 % (1-50 KB), edit 10 % (input 0.2-4 KB +
//            patch 1-8 KB), write 5 % (input 2-60 KB). Text tool output never exceeds core's 50 KiB cap. Reasoning on
//            40 % of steps (0.3-3 KB), answers 0.8-6 KB of Markdown. A completed compaction (8-30 KB summary) every
//            ~180 assistant steps.
//   small    many short messages: per turn one user prompt (150-500 chars) and one answer (0.4-2 KB), 30 % of answers
//            with one small tool (0.3-3 KB). A compaction every ~500 messages.
//   text     `screens` without pictures: a long coding session that is tens of GB of text and millions of rows. Tools
//            read 30 %, grep 15 %, bash 30 %, edit 15 %, write 10 % with the same sizes; no prompt has a screenshot.
//
// Every user prompt carries `OWNB-<tag>-<nnnn>-U` and every final answer `OWNB-<tag>-<nnnn>-R` (at its start and its
// end), the fixture markers the perf probes look for. The probes' marker grammar has four turn digits, so the tag
// carries the rest: turn 123456 of session tag "B" is `OWNB-B12-3456-R`.
import { Database } from "bun:sqlite"
import { deflateSync } from "node:zlib"
import { identifier } from "../../../own-web/e2e/performance/fixture/history"
import type { OpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"

export type Shape = "screens" | "small" | "text"

export interface SeedState {
  readonly sessionID: string
  readonly tag: string
  readonly shape: Shape
  turn: number
  seq: number
  time: number
  stepsSinceCompaction: number
  rows: number
  bytes: number
  compactions: number
  images: number
  counts: Record<string, number>
}

/** Turn marker of `tag` with the probes' four-digit grammar (the tag carries the higher digits). */
export function marker(tag: string, turn: number, role: "U" | "R") {
  return `OWNB-${tag}${Math.floor(turn / 10_000)}-${String(turn % 10_000).padStart(4, "0")}-${role}`
}

/** The marker tag of `turn` (what the switch probe compares). */
export function markerTag(tag: string, turn: number) {
  return `${tag}${Math.floor(turn / 10_000)}`
}

const T0 = 1_111_111_110_000
// A valid base64 string the import accepts in place of a picture; found and replaced in the stored rows.
const IMAGE_SLOT = "T1dOQklHU0VTU0lPTlBMQUNFSE9MREVS"

/** The template turn, in the public `SessionMessage.Info` encoding (placeholders `@@X@@`, times from T0). */
function templateMessages(model: { id: string; providerID: string }) {
  const id = (n: number) => identifier("msg", T0 + n, n, `tmpl${n}`)
  const tool = (name: string, at: number, state: Record<string, unknown>) => ({
    type: "tool",
    id: "call_@@ID@@",
    name,
    time: { created: T0 + at, ran: T0 + at + 1, completed: T0 + at + 2 },
    state: { status: "completed", ...state },
  })
  const assistant = (n: number, finish: string, content: unknown[]) => ({
    id: id(n),
    type: "assistant",
    agent: "build",
    model,
    content,
    finish,
    cost: 0.0123,
    tokens: { input: 1800, output: 420, reasoning: 0, cache: { read: 1500, write: 0 } },
    time: { created: T0 + 3, streamed: T0 + 4, completed: T0 + 5 },
  })
  return [
    { id: id(1), type: "user", time: { created: T0 }, text: "@@A@@" },
    {
      id: id(2),
      type: "user",
      time: { created: T0 },
      text: "@@A@@",
      files: [{ data: IMAGE_SLOT, mime: "image/png", source: { type: "inline" }, name: "capture.png" }],
    },
    assistant(3, "tool-calls", [
      { type: "reasoning", text: "@@A@@", time: { created: T0 + 1, completed: T0 + 2 } },
      tool("read", 3, { input: { path: "@@A@@" }, content: [{ type: "text", text: "@@B@@" }] }),
      tool("grep", 3, { input: { pattern: "@@A@@", path: "src" }, content: [{ type: "text", text: "@@B@@" }] }),
      tool("bash", 3, {
        input: { command: "@@A@@", description: "테스트 실행" },
        content: [{ type: "text", text: "@@B@@" }],
        metadata: { exit: 0 },
      }),
      tool("edit", 3, {
        input: { path: "@@A@@", oldString: "@@B@@", newString: "@@C@@" },
        content: [{ type: "text", text: "Edited @@A@@" }],
        metadata: {
          files: [{ file: "@@A@@", additions: 4, deletions: 2, status: "modified", patch: "@@D@@" }],
        },
      }),
      tool("write", 3, {
        input: { path: "@@A@@", content: "@@B@@" },
        content: [{ type: "text", text: "Wrote @@A@@" }],
      }),
      tool("computer_screenshot", 3, {
        input: {},
        content: [
          { type: "text", text: "@@A@@" },
          { type: "file", uri: "data:image/png;base64,@@IMG@@", mime: "image/png", name: "screen.png" },
        ],
      }),
      tool("computer_click", 3, {
        input: { x: 640, y: 412, button: "left" },
        content: [
          { type: "text", text: "@@A@@" },
          { type: "file", uri: "data:image/png;base64,@@IMG@@", mime: "image/png", name: "screen.png" },
        ],
      }),
      { type: "text", text: "@@A@@" },
    ]),
    assistant(4, "stop", [{ type: "text", text: "@@A@@" }]),
    {
      id: id(5),
      type: "compaction",
      time: { created: T0 + 6 },
      status: "completed",
      reason: "auto",
      summary: "@@A@@",
    },
  ]
}

/** Imports the session with the template turn; the generator replaces those rows later. */
export async function importTemplateSession(
  service: OpencodeServer,
  input: {
    readonly info: Record<string, unknown>
    readonly id: string
    readonly title: string
    readonly directory: string
    readonly model: { id: string; providerID: string }
  },
) {
  const messages = templateMessages(input.model)
  const info: Record<string, unknown> = {
    ...input.info,
    id: input.id,
    title: input.title,
    model: input.model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: T0, updated: T0 + 10 },
  }
  delete info.revert
  delete info.parentID
  delete info.fork
  await service.call("POST", "/api/experimental/session/import", {
    body: { info, messages, location: { directory: input.directory } },
    directory: input.directory,
  })
  return messages.map((message) => message.id)
}

// ------------------------------------------------------------------------------------------------ templates

type Segment = string | { readonly token: string } | { readonly time: number }

function compile(text: string): Segment[] {
  const segments: Segment[] = []
  let last = 0
  for (const match of text.matchAll(/@@([A-Z]+)@@|11111111(\d{5})/g)) {
    if (match.index > last) segments.push(text.slice(last, match.index))
    segments.push(match[1] ? { token: match[1] } : { time: Number(match[2]) - 10_000 })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push(text.slice(last))
  return segments
}

function fill(segments: readonly Segment[], values: Readonly<Record<string, string>>, time: number) {
  let out = ""
  for (const segment of segments) {
    if (typeof segment === "string") out += segment
    else if ("token" in segment) {
      const value = values[segment.token]
      if (value === undefined) throw new Error(`no value for @@${segment.token}@@`)
      out += value
    } else out += String(time + segment.time)
  }
  return out
}

interface Templates {
  readonly user: Segment[]
  readonly userImage: Segment[]
  readonly stepEnvelope: Segment[]
  readonly finalEnvelope: Segment[]
  readonly compaction: Segment[]
  readonly parts: Record<string, Segment[]>
}

export interface RawTemplates {
  readonly user: string
  readonly userImage: string
  readonly step: string
  readonly final: string
  readonly compaction: string
}

/** The stored template rows as the service wrote them (read once, kept beside the database for later tiers). */
export function captureTemplates(file: string, sessionID: string, ids: readonly string[]): RawTemplates {
  const db = new Database(file, { readonly: true })
  const rows = db
    .query<{ id: string; data: string }, [string]>("select id, data from session_message where session_id = ?")
    .all(sessionID)
  db.close()
  const data = (id: string) => {
    const row = rows.find((item) => item.id === id)
    if (!row) throw new Error(`template row ${id} not stored`)
    return row.data
  }
  return {
    user: data(ids[0]!),
    userImage: data(ids[1]!),
    step: data(ids[2]!),
    final: data(ids[3]!),
    compaction: data(ids[4]!),
  }
}

/** Template rows split at their placeholders; an assistant row into its envelope and one template per part. */
export function compileTemplates(raw: RawTemplates): Templates {
  const envelope = (text: string) => {
    const parsed = JSON.parse(text) as { content: unknown[] }
    return { parts: parsed.content, envelope: JSON.stringify({ ...parsed, content: "@@CONTENT@@" }) }
  }
  const step = envelope(raw.step)
  const final = envelope(raw.final)
  const names = ["reasoning", "read", "grep", "bash", "edit", "write", "computer_screenshot", "computer_click", "text"]
  const parts = Object.fromEntries(
    step.parts.map((part, index) => [names[index]!, compile(JSON.stringify(part).replaceAll(IMAGE_SLOT, "@@IMG@@"))]),
  )
  return {
    user: compile(raw.user),
    userImage: compile(raw.userImage.replaceAll(IMAGE_SLOT, "@@IMG@@")),
    stepEnvelope: compile(step.envelope.replace('"@@CONTENT@@"', "[@@CONTENT@@]")),
    finalEnvelope: compile(final.envelope.replace('"@@CONTENT@@"', "[@@CONTENT@@]")),
    compaction: compile(raw.compaction),
    parts,
  }
}

// ------------------------------------------------------------------------------------------------ content pools

/** A deterministic PRNG (mulberry32). */
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** JSON-escaped lines joined by `\n` escapes; slices cut only at line starts, so an escape is never split. */
function pool(lines: readonly string[]) {
  const escaped = lines.map((line) => JSON.stringify(line).slice(1, -1) + "\\n")
  const charStarts = new Float64Array(escaped.length + 1)
  const byteStarts = new Float64Array(escaped.length + 1)
  escaped.forEach((line, index) => {
    charStarts[index + 1] = charStarts[index]! + line.length
    byteStarts[index + 1] = byteStarts[index]! + Buffer.byteLength(line)
  })
  const text = escaped.join("")
  let cursor = 0
  return {
    /** About `bytes` UTF-8 bytes of escaped text, continuing where the last take ended. */
    take(bytes: number) {
      if (byteStarts[escaped.length]! - byteStarts[cursor]! < bytes) cursor = 0
      const want = byteStarts[cursor]! + bytes
      let low = cursor + 1
      let high = escaped.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (byteStarts[middle]! < want) low = middle + 1
        else high = middle
      }
      const out = text.slice(charStarts[cursor]!, charStarts[low]!)
      cursor = low >= escaped.length ? 0 : low
      return out
    },
    bytes: byteStarts[escaped.length]!,
  }
}

function prosePool(rand: () => number) {
  const ko = [
    "세션 목록 행이 스트리밍 중에도 흔들리지 않게 측정된 높이만 다시 맞춥니다.",
    "결제 웹훅 재시도 정책을 검토했고 실패한 요청은 지수 백오프로 다시 보냅니다.",
    "계정 전환 뒤 캐시 적중률이 떨어지는 원인은 프롬프트 접두사가 바뀌기 때문입니다.",
    "화면의 버튼 위치를 다시 확인한 다음 클릭 좌표를 보정했습니다.",
    "브라우저에서 로그인 화면이 뜨는지 스크린샷으로 확인하고 다음 단계로 넘어갑니다.",
    "테스트가 통과했으며 타입 검사에서도 새 오류가 없습니다.",
    "긴 세션은 Markdown, 구문 강조, 도구 출력, 비동기 diff가 한 화면에 섞입니다.",
  ]
  const en = [
    "The retry helper keeps its public API stable while the backoff moves into one place.",
    "I checked the window bounds again and the dialog is now fully on screen.",
    "Next I will open the settings page and confirm the toggle state from a fresh screenshot.",
    "The failing case was an empty cursor on the first page; it now returns the newest messages.",
  ]
  const lines: string[] = []
  for (let index = 0; lines.join("").length < 3_000_000; index++) {
    const kind = rand()
    if (kind < 0.08) lines.push(`### 단계 ${index % 97}: ${en[index % en.length]!.slice(0, 40)}`)
    else if (kind < 0.25) lines.push(`- ${ko[index % ko.length]} (${index})`)
    else if (kind < 0.32) lines.push(`\`module-${index % 211}.ts\`에서 \`createMemo(() => rows())\` 호출을 줄였습니다.`)
    else if (kind < 0.36) lines.push("")
    else
      lines.push(
        `${ko[Math.floor(rand() * ko.length)]} ${en[Math.floor(rand() * en.length)]} ${ko[Math.floor(rand() * ko.length)]}`,
      )
  }
  return pool(lines)
}

function codePool(rand: () => number) {
  const lines: string[] = []
  for (let index = 0; lines.length < 140_000; index++) {
    const kind = rand()
    const n = index % 997
    if (kind < 0.35)
      lines.push(
        `  const visible${n} = createMemo(() => props.messages.filter((message) => message.text.trim()).slice(-${20 + (n % 13)}))`,
      )
    else if (kind < 0.55)
      lines.push(
        `2026-11-14T12:${String(n % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.${String(index % 1000).padStart(3, "0")}Z INFO  [session-${n % 31}] request id=req_${index.toString(36)} status=200 took=${(index * 7) % 900}ms`,
      )
    else if (kind < 0.7)
      lines.push(`src/session/module-${n}.ts:${(index * 7) % 400}:  return rows().map((row) => row.id)`)
    else if (kind < 0.8) lines.push(`✓ session > timeline row ${n} keeps identity [${(index % 97) / 10}ms]`)
    else if (kind < 0.9) lines.push(`export function Summary${n}(props: { items: Item[]; locale: string }) {`)
    else lines.push(`    <p data-role="assistant">{message.text}</p> // ${index}`)
  }
  return pool(lines)
}

// ------------------------------------------------------------------------------------------------ screenshots

/**
 * 1280×800 RGB PNGs of 0.3-2 MB base64: flat rows with bands of noise (the noise sets the size). Each is split into a
 * prefix whose length is a multiple of 3 (so its base64 concatenates) and a per-use tail: a `tEXt` chunk with a unique
 * id, then IEND. So every screenshot is a distinct data URI, like real captures (no shared decode cache).
 */
function screenshots(rand: () => number) {
  const width = 1280
  const height = 800
  const targets = [300_000, 500_000, 800_000, 1_000_000, 1_400_000, 2_000_000]
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, "latin1")
    Buffer.from(data).copy(out, 8)
    out.writeUInt32BE(Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const variants = targets.map((target) => {
    const noiseRows = Math.min(height, Math.round((target * 0.75) / (width * 3 + 1)))
    const raw = Buffer.alloc(height * (width * 3 + 1))
    for (let row = 0; row < height; row++) {
      const offset = row * (width * 3 + 1)
      const noisy = row % Math.max(1, Math.floor(height / noiseRows)) === 0
      for (let x = 0; x < width * 3; x++)
        raw[offset + 1 + x] = noisy ? Math.floor(rand() * 256) : row % 3 === 0 ? 0xf2 : 0xfa
    }
    const prefix = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 6 })),
    ])
    const padded = Buffer.concat([prefix, chunk("prVt", new Uint8Array((3 - ((prefix.length + 12) % 3)) % 3))])
    return padded.toString("base64")
  })
  const iend = chunk("IEND", new Uint8Array(0))
  let counter = 0
  return {
    next() {
      const prefix = variants[Math.floor(rand() * variants.length)]!
      const id = (counter++).toString(36).padStart(12, "0")
      const tail = Buffer.concat([chunk("tEXt", Buffer.from(`id\0${id}`, "latin1")), iend])
      return prefix + tail.toString("base64")
    },
  }
}

// ------------------------------------------------------------------------------------------------ generator

const SCREEN_TOOLS = [
  ["computer_screenshot", 30],
  ["computer_click", 10],
  ["read", 20],
  ["grep", 10],
  ["bash", 15],
  ["edit", 10],
  ["write", 5],
] as const
const TEXT_TOOLS = [
  ["read", 30],
  ["grep", 15],
  ["bash", 30],
  ["edit", 15],
  ["write", 10],
] as const

/**
 * Appends turns to `state.sessionID` in `file` until the file reaches `targetBytes` or the session `targetMessages`
 * rows. The service must be stopped. Commits about every 256 MB; ends with a TRUNCATE checkpoint.
 */
export function grow(input: {
  readonly file: string
  readonly state: SeedState
  readonly templates: Templates
  readonly targetBytes?: number
  readonly targetMessages?: number
  readonly log: (message: string) => void
  /** Core's row decoder (`decodeMessageRowSync`): rows of every kind are decoded with it before the bulk write. */
  readonly decode?: (row: unknown) => unknown
}) {
  const state = input.state
  const rand = random(0x5eed + state.rows)
  const prose = prosePool(random(11))
  const code = codePool(random(12))
  const shots = screenshots(random(13))
  const db = new Database(input.file)
  db.run("pragma journal_mode = wal")
  db.run("pragma synchronous = off")
  db.run("pragma cache_size = -262144")
  const insert = db.prepare(
    "insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)",
  )
  // The service may have appended rows since the last grow (a measured prompt): continue after them.
  const after = db
    .query<
      { seq: number | null; time: number | null },
      [string, string]
    >("select max(coalesce((select seq from event_sequence where aggregate_id = ?), 0), coalesce(max(seq), 0)) as seq, max(time_created) as time from session_message where session_id = ?")
    .get(state.sessionID, state.sessionID)
  state.seq = Math.max(state.seq, after?.seq ?? 0)
  state.time = Math.max(state.time, after?.time ?? 0)
  const pageSize = db.query<{ page_size: number }, []>("pragma page_size").get()!.page_size
  const fileBytes = () => db.query<{ page_count: number }, []>("pragma page_count").get()!.page_count * pageSize
  const t = input.templates
  const between = (low: number, high: number) => low + rand() * (high - low)
  const logUniform = (low: number, high: number) => Math.exp(between(Math.log(low), Math.log(high)))
  const pick = <T>(weights: readonly (readonly [T, number])[]) => {
    const total = weights.reduce((sum, item) => sum + item[1], 0)
    let roll = rand() * total
    for (const item of weights) {
      roll -= item[1]
      if (roll <= 0) return item[0]
    }
    return weights.at(-1)![0]
  }
  const count = (name: string) => (state.counts[name] = (state.counts[name] ?? 0) + 1)
  const callID = () => `${state.tag}${state.seq.toString(36)}_${Math.floor(rand() * 1e9).toString(36)}`
  // Verification collects rows; the bulk write inserts them as they are made.
  const collected: { type: string; data: string }[] = []
  const sink = { collect: false, sinceCommit: 0 }
  const row = (type: string, data: string, time: number) => {
    if (sink.collect) return void collected.push({ type, data })
    state.seq++
    insert.run(
      identifier("msg", time, state.seq % 4096, `${state.tag}${state.seq}`),
      state.sessionID,
      type,
      state.seq,
      time,
      time,
      data,
    )
    state.rows++
    state.bytes += data.length
    sink.sinceCommit += data.length
  }
  const small = state.shape === "small"
  // Text sizes (bytes) per tool: [low, high], log-uniform; `small` keeps every tool output short.
  const sizes = {
    read: small ? [300, 3_000] : [2_000, 50_000],
    grep: small ? [300, 3_000] : [1_000, 20_000],
    bash: small ? [300, 3_000] : [1_000, 50_000],
    write: [2_000, 60_000],
    edit: [200, 4_000],
    patch: [1_000, 8_000],
  } as const
  const sized = (name: keyof typeof sizes) => code.take(logUniform(sizes[name][0], sizes[name][1]))

  const toolPart = (name: string, time: number, turn: number) => {
    count(name)
    const head = `[${state.tag} ${turn}.${state.seq}] `
    const path = `src/session/module-${Math.floor(rand() * 400)}.ts`
    if (name === "read") return fill(t.parts.read!, { ID: callID(), A: path, B: head + sized("read") }, time)
    if (name === "grep") return fill(t.parts.grep!, { ID: callID(), A: "createMemo", B: head + sized("grep") }, time)
    if (name === "bash")
      return fill(t.parts.bash!, { ID: callID(), A: "bun test ./src/session", B: head + sized("bash") }, time)
    if (name === "edit")
      return fill(
        t.parts.edit!,
        {
          ID: callID(),
          A: path,
          B: sized("edit"),
          C: sized("edit"),
          D: `--- a/${path}\\n+++ b/${path}\\n@@ -10,4 +10,5 @@\\n` + sized("patch"),
        },
        time,
      )
    if (name === "write") return fill(t.parts.write!, { ID: callID(), A: path, B: head + sized("write") }, time)
    state.images++
    return fill(
      t.parts[name]!,
      { ID: callID(), A: `${head}Screenshot of the primary display (1280×800).`, IMG: shots.next() },
      time,
    )
  }

  const turnRows = () => {
    const turn = state.turn
    const user = marker(state.tag, turn, "U")
    const answer = marker(state.tag, turn, "R")
    const nextTime = () => (state.time += Math.round(between(1_500, 8_000)))
    const prompt = `${prose.take(small ? between(150, 500) : between(150, 900))} (${user})`
    const image = state.shape === "screens" && rand() < 0.02
    if (image) state.images++
    const userTime = nextTime()
    row("user", fill(image ? t.userImage : t.user, { A: prompt, IMG: image ? shots.next() : "" }, userTime), userTime)
    const steps = small
      ? 0
      : pick([
          [0, 15],
          [1, 30],
          [2, 25],
          [3, 15],
          [4, 7],
          [5, 5],
          [6, 3],
        ] as const)
    for (let step = 0; step < steps; step++) {
      const time = nextTime()
      const parts: string[] = []
      if (rand() < 0.4) parts.push(fill(t.parts.reasoning!, { A: prose.take(between(300, 3_000)) }, time))
      const tools = rand() < 0.8 ? 1 : 2
      for (let index = 0; index < tools; index++)
        parts.push(toolPart(pick(state.shape === "text" ? TEXT_TOOLS : SCREEN_TOOLS), time, turn))
      row("assistant", fill(t.stepEnvelope, { CONTENT: parts.join(",") }, time), time)
      state.stepsSinceCompaction++
    }
    const time = nextTime()
    const parts: string[] = []
    if (!small && rand() < 0.3) parts.push(fill(t.parts.reasoning!, { A: prose.take(between(300, 3_000)) }, time))
    if (small && rand() < 0.3)
      parts.push(
        toolPart(
          pick([
            ["read", 1],
            ["grep", 1],
            ["bash", 1],
          ] as const),
          time,
          turn,
        ),
      )
    const body = prose.take(small ? between(400, 2_000) : between(800, 6_000))
    parts.push(fill(t.parts.text!, { A: `## 결과 ${turn + 1} ${answer}\\n\\n${body}\\n검증 완료 ${answer}` }, time))
    row("assistant", fill(t.finalEnvelope, { CONTENT: parts.join(",") }, time), time)
    state.stepsSinceCompaction++
    if (state.stepsSinceCompaction >= (small ? 500 : 180)) {
      state.stepsSinceCompaction = 0
      state.compactions++
      const at = nextTime()
      row("compaction", fill(t.compaction, { A: prose.take(between(8_000, 30_000)) }, at), at)
    }
    state.turn++
  }

  if (input.decode) {
    // Rows of every kind through core's decoder (the same one every read uses) before the bulk write.
    const saved = structuredClone(state)
    sink.collect = true
    for (let index = 0; index < 400; index++) turnRows()
    sink.collect = false
    const kinds = new Set<string>()
    for (const sample of collected) {
      const message = input.decode({
        id: identifier("msg", 1, 1, "verify"),
        session_id: state.sessionID,
        type: sample.type,
        seq: 1,
        time_created: 1,
        time_updated: 1,
        data: JSON.parse(sample.data),
      }) as { type: string; content?: { type: string; name?: string }[]; files?: unknown[] }
      kinds.add(message.type + (message.files?.length ? "+image" : ""))
      message.content?.forEach((part) => kinds.add(`${part.type}${part.name ? `:${part.name}` : ""}`))
    }
    Object.assign(state, saved)
    input.log(`verify: ${collected.length} rows decode; kinds ${[...kinds].toSorted().join(", ")}`)
    collected.length = 0
  }

  const started = Date.now()
  const startBytes = state.bytes
  let lastLog = Date.now()
  const reached = () =>
    input.targetMessages !== undefined ? state.rows >= input.targetMessages : fileBytes() >= (input.targetBytes ?? 0)
  while (!reached()) {
    // One transaction per ~256 MB (or what is left to the target), so the WAL stays near that size.
    const budget =
      input.targetMessages !== undefined
        ? 256 * 1024 ** 2
        : Math.min(256 * 1024 ** 2, Math.max(1024 ** 2, (input.targetBytes ?? 0) - fileBytes()))
    sink.sinceCommit = 0
    db.transaction(() => {
      while (sink.sinceCommit < budget) {
        turnRows()
        if (input.targetMessages !== undefined && state.rows >= input.targetMessages) return
      }
    }).immediate()
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now()
      const seconds = (Date.now() - started) / 1000
      input.log(
        `grow: ${state.rows} rows, ${(state.bytes / 1024 ** 3).toFixed(2)} G chars of row data, file ${(fileBytes() / 1024 ** 3).toFixed(2)} GB, ${Math.round((state.bytes - startBytes) / 1024 ** 2 / Math.max(seconds, 0.001))} M chars/s`,
      )
    }
  }
  db.run(
    "insert into event_sequence (aggregate_id, seq) values (?, ?) on conflict(aggregate_id) do update set seq = max(seq, excluded.seq)",
    [state.sessionID, state.seq + 10],
  )
  // Newest in the sidebar (the bench opens it from its first 50 rows): the fillers are stamped when imported, after the
  // seeded timeline's start, so a session whose last turn is older would sit below them.
  db.run("update session_v2 set time_updated = ? where id = ?", [Math.max(state.time, Date.now()), state.sessionID])
  const checkpointStarted = Date.now()
  // With `synchronous = off` nothing was flushed: a FULL checkpoint syncs the file now, so the OS's backlog of
  // written-but-unflushed pages is paid here and not by the service's first open (a 100 GB grow left about 90 s of it).
  db.run("pragma synchronous = full")
  db.run("pragma wal_checkpoint(truncate)")
  const result = {
    seconds: Math.round((Date.now() - started) / 1000),
    checkpointMs: Date.now() - checkpointStarted,
    fileBytes: fileBytes(),
    charsPerS: Math.round((state.bytes - startBytes) / Math.max((Date.now() - started) / 1000, 0.001)),
  }
  db.close()
  return result
}

/** Deletes the imported template rows (the session keeps its row); the generator starts at seq 1. */
export function dropTemplateRows(file: string, sessionID: string) {
  const db = new Database(file)
  db.run("delete from session_message where session_id = ?", [sessionID])
  db.close()
}
