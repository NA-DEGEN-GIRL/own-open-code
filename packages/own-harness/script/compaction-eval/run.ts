// The compaction evaluation (own/docs/11-compaction-prompt.md §4).
//
//   bun script/compaction-eval/run.ts summarize [sid…]   GPT and DeepSeek write checkpoints with every method
//   bun script/compaction-eval/run.ts chain [sid…]       three compactions in a row across providers (chain loss)
//   bun script/compaction-eval/run.ts claude [sid…]      parse Claude's replies (sum/<method>.claude.txt) the same way
//   bun script/compaction-eval/run.ts read [sid…]        GPT and DeepSeek answer the probes from each checkpoint
//   bun script/compaction-eval/run.ts packet [sid…]      blind grading files per session (grading-N.json, blind.json)
//   bun script/compaction-eval/run.ts report             the graders' verdicts (scores-N.json) and costs into RESULTS.md
//
// Methods: A = own checkpoint prompt with analysis, A0 = without analysis, B = OpenCode core prompt,
// C = Codex prompt, N = OpenAI server compaction (GPT only). Readers see the checkpoint in each method's own
// wrapper, alone ("sum") or after the user's earlier messages kept verbatim ("users").
import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { buildPrompt } from "../../../core/src/session/compaction.js"
import CODEX_PROMPT from "../../codex-data/compact-prompt.md" with { type: "text" }
import SUMMARY_PREFIX from "../../codex-data/compact-summary-prefix.md" with { type: "text" }
import { Checkpoint } from "../../src/checkpoint.js"
import { DATA_DIR, EVAL_DIR, tokens, type Flat, type Span } from "./common.js"
import { deepseek, gpt, type Message, type Reply } from "./providers.js"

const GPT_MODEL = process.env.OWN_EVAL_GPT ?? "gpt-6.1-sol"
/** Reasoning effort when GPT writes a checkpoint, and when it answers the questions. */
const GPT_EFFORT = process.env.OWN_EVAL_EFFORT ?? "medium"
const READ_EFFORT = process.env.OWN_EVAL_READ_EFFORT ?? "low"
const DS_MODEL = process.env.OWN_EVAL_DS ?? "deepseek-v4-pro"
/** The ChatGPT accounts readers use, e.g. OWN_EVAL_ACCOUNTS=03 when the other's token has expired. */
const ACCOUNTS = (process.env.OWN_EVAL_ACCOUNTS ?? "01,03").split(",")
const SYSTEM = "You are an expert software engineering agent working with a user on their projects."
const METHODS = ["A", "A0", "B", "C"] as const
type Method = (typeof METHODS)[number] | "N"
const READERS = ["gpt", "ds"] as const
const VARIANTS = ["sum", "users"] as const

const REPAIR: Readonly<Record<string, string>> = {
  A: Checkpoint.repair({ analysis: true }),
  A0: Checkpoint.repair(),
  B: "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template.",
}

/**
 * Chain loss (own/docs/11 §4.3): the span in three parts, compacted three times in a row, each time over the previous
 * checkpoint in the method's own form plus the next part, with the method's update prompt. Text methods hand over
 * between providers (GPT, DeepSeek, GPT); native compaction stays on GPT and alternates accounts.
 */
const CHAINS: ReadonlyArray<readonly [Method, ReadonlyArray<"gpt" | "ds">]> = [
  ["A", ["gpt", "ds", "gpt"]],
  ["B", ["gpt", "ds", "gpt"]],
  ["C", ["gpt", "ds", "gpt"]],
  ["N", ["gpt", "gpt", "gpt"]],
]

/**
 * The graders' verdicts (scores-N.json, one letter per answer in grading-N.json): C correct, P partial, M missing or
 * too vague, W wrong (contradicts the gold). U marks an UNKNOWN answer, which is never graded.
 */
const GRADE: Readonly<Record<string, number>> = { C: 1, P: 0.5, M: 0, W: 0, U: 0 }

async function load(sid: string) {
  return (await Bun.file(path.join(DATA_DIR, sid, "span.json")).json()) as Span
}

function promptOf(method: Method) {
  if (method === "A") return Checkpoint.prompt({ analysis: true })
  if (method === "A0") return Checkpoint.prompt()
  if (method === "B") return buildPrompt(false)
  return CODEX_PROMPT
}

/** The summary a reply yields, or why it is unusable. */
function extract(method: Method, reply: string): { readonly summary?: string; readonly error?: string } {
  if (method === "A" || method === "A0") {
    const parsed = Checkpoint.parse(reply)
    return parsed.ok ? { summary: parsed.checkpoint } : { error: `${parsed.reason}${parsed.missing ? `: ${parsed.missing.join(", ")}` : ""}` }
  }
  if (method === "B" && !/^## Objective/m.test(reply)) return { error: "template headings missing" }
  return reply.trim() === "" ? { error: "empty" } : { summary: reply.trim() }
}


function summarizeJobs(sid: string) {
  const models: ReadonlyArray<readonly ["gpt" | "ds", Method]> = [
    ...METHODS.map((method) => ["gpt", method] as const),
    ["gpt", "N"],
    ...METHODS.map((method) => ["ds", method] as const),
  ]
  // OWN_EVAL_ONLY=gpt|ds limits a run to one summarizer, so two runs can work side by side.
  const only = process.env.OWN_EVAL_ONLY
  return models.filter(([model]) => only === undefined || model === only).map(([model, method], index) => async () => {
    const out = path.join(DATA_DIR, sid, "sum", `${method}.${model}.json`)
    if (await Bun.file(out).exists()) return
    const span = await load(sid)
    const conversation: Array<Message> = [{ role: "system", content: SYSTEM }, ...span.messages.map((m) => ({ role: m.role, content: m.text }))]
    const account = index % 2 === 0 ? "01" : "03"
    const started = Date.now()
    const result = await compact(model, account, method, conversation, promptOf(method)).catch((error: unknown) => ({
      attempts: 0,
      reply: "",
      error: String(error).slice(0, 400),
    }))
    await mkdir(path.dirname(out), { recursive: true })
    await Bun.write(out, JSON.stringify({ sid, method, summarizer: model, ms: Date.now() - started, ...result }, null, 1))
    console.log(`${sid} ${method}.${model}: ${"error" in result && result.error ? `ERROR ${result.error}` : "ok"}`)
  })
}

/** One compaction as the harness asks for it: the method's prompt, then one repair request (P-025); N is native. */
async function compact(
  model: "gpt" | "ds",
  account: string,
  method: Method,
  conversation: ReadonlyArray<Message | Record<string, unknown>>,
  prompt: string,
): Promise<{ attempts: number; reply: string; summary?: string; encrypted?: string; error?: string; firstError?: string; usage?: Reply["usage"] }> {
  if (method === "N") {
    const reply = await gpt(account, GPT_MODEL, [...conversation, { type: "compaction_trigger" }], { effort: GPT_EFFORT })
    const item = reply.items.find((entry) => entry.type === "compaction")
    return { attempts: 1, reply: "", encrypted: item?.encrypted_content as string | undefined, usage: reply.usage, error: item ? undefined : "no compaction item" }
  }
  const call = (messages: ReadonlyArray<Message | Record<string, unknown>>) =>
    model === "gpt" ? gpt(account, GPT_MODEL, messages, { effort: GPT_EFFORT }) : deepseek(DS_MODEL, messages as ReadonlyArray<Message>)
  const first = await call([...conversation, { role: "user", content: prompt }])
  const extracted = extract(method, first.text)
  if (extracted.summary !== undefined || REPAIR[method] === undefined) return { attempts: 1, reply: first.text, ...extracted, usage: first.usage }
  const second = await call([
    ...conversation,
    { role: "user", content: prompt },
    { role: "assistant", content: first.text },
    { role: "user", content: REPAIR[method]! },
  ])
  return { attempts: 2, reply: second.text, ...extract(method, second.text), usage: sum(first.usage, second.usage), firstError: extracted.error }
}

function chainJobs(sid: string) {
  return CHAINS.map(([method, models]) => async () => {
    const name = models.map((model) => model[0]).join("")
    const out = path.join(DATA_DIR, sid, "chain", `${method}.${name}.json`)
    if (await Bun.file(out).exists()) return
    const span = await load(sid)
    const parts = thirds(span.messages)
    const started = Date.now()
    const steps: Array<Awaited<ReturnType<typeof compact>> & { model: string; account: string }> = []
    for (const [index, model] of models.entries()) {
      const previous = steps.at(-1)
      if (previous?.error) break
      const before = parts.slice(0, index).flat()
      const users = kept(before.filter((message) => message.role === "user").map((message) => message.text))
      const conversation = [
        { role: "system", content: SYSTEM },
        ...(previous ? rendered(method, previous, method === "B" ? [] : users, "users") : []),
        ...parts[index]!.map((message) => ({ role: message.role, content: message.text })),
      ]
      const account = index % 2 === 0 ? "01" : "03"
      const step = await compact(model, account, method, conversation, index === 0 ? promptOf(method) : updatePromptOf(method)).catch(
        (error: unknown) => ({ attempts: 0, reply: "", error: String(error).slice(0, 400) }),
      )
      steps.push({ ...step, model, account })
    }
    const last = steps.at(-1)!
    const error = steps.find((step) => step.error)?.error
    await mkdir(path.dirname(out), { recursive: true })
    await Bun.write(
      out,
      JSON.stringify(
        {
          sid,
          method,
          summarizer: name,
          ms: Date.now() - started,
          parts: parts.map((part) => part.length),
          ...(error ? { error } : { summary: last.summary, encrypted: last.encrypted }),
          steps: steps.map((step) => ({ model: step.model, account: step.account, attempts: step.attempts, chars: (step.summary ?? step.encrypted ?? "").length, usage: step.usage, error: step.error, firstError: step.firstError, summary: step.summary })),
        },
        null,
        1,
      ),
    )
    console.log(`${sid} chain ${method}.${name}: ${error ? `ERROR ${error}` : "ok"}`)
  })
}

function updatePromptOf(method: Method) {
  if (method === "A") return Checkpoint.prompt({ update: true })
  if (method === "A0") return Checkpoint.prompt({ update: true, analysis: false })
  if (method === "B") return buildPrompt(true)
  return CODEX_PROMPT
}

/** The span in three parts of about equal size, each later part starting at a user message. */
function thirds(messages: ReadonlyArray<Flat>) {
  const offsets = messages.map((_, index) => messages.slice(0, index).reduce((total, message) => total + message.text.length, 0))
  const total = messages.reduce((sum, message) => sum + message.text.length, 0)
  const starts = messages.flatMap((message, index) => (message.role === "user" && index > 0 ? [index] : []))
  const nearest = (target: number, after: number) =>
    starts
      .filter((index) => index > after)
      .reduce((best, index) => (Math.abs(offsets[index]! - target) < Math.abs(offsets[best]! - target) ? index : best))
  const first = nearest(total / 3, 0)
  const second = nearest((2 * total) / 3, first)
  return [messages.slice(0, first), messages.slice(first, second), messages.slice(second)]
}

/** The user's messages a harness keeps verbatim (Codex's rule): newest first within 20k tokens, in order. */
function kept(users: ReadonlyArray<string>) {
  return users.toReversed().reduce<{ readonly list: ReadonlyArray<string>; readonly left: number }>(
    (state, text) => (tokens(text) <= state.left ? { list: [text, ...state.list], left: state.left - tokens(text) } : { ...state, left: 0 }),
    { list: [], left: 20_000 },
  ).list
}

async function parseClaude(sid: string) {
  await Promise.all(
    METHODS.map(async (method) => {
      const raw = Bun.file(path.join(DATA_DIR, sid, "sum", `${method}.claude.txt`))
      if (!(await raw.exists())) return
      const reply = await raw.text()
      await Bun.write(
        path.join(DATA_DIR, sid, "sum", `${method}.claude.json`),
        JSON.stringify({ sid, method, summarizer: "claude", attempts: 1, reply, ...extract(method, reply) }, null, 1),
      )
      console.log(`${sid} ${method}.claude: ${extract(method, reply).error ?? "ok"}`)
    }),
  )
}

interface Probe {
  readonly id: string
  readonly category: string
  readonly question: string
  readonly answer: string
  readonly keys: ReadonlyArray<string>
  /** Where the fact sits in the span (early, middle, late) or "after" it (the true next step). */
  readonly where: string
}

/** What a reader sees: the method's own wrapper, after the user's earlier messages in the "users" variant. */
function rendered(method: Method, summary: { readonly summary?: string; readonly encrypted?: string }, users: ReadonlyArray<string>, variant: string) {
  const earlier = variant === "users" ? users : []
  if (method === "A" || method === "A0") return [{ role: "user", content: Checkpoint.render(summary.summary!, earlier) }]
  const before = earlier.map((text) => ({ role: "user", content: text }))
  if (method === "N") return [...before, { type: "compaction", encrypted_content: summary.encrypted }]
  if (method === "B")
    return [
      ...before,
      {
        role: "user",
        content: `<conversation-checkpoint>\nThe following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.\n\n<summary>\n${summary.summary}\n</summary>\n</conversation-checkpoint>`,
      },
    ]
  return [...before, { role: "user", content: `${SUMMARY_PREFIX}\n${summary.summary}` }]
}

function questions(probes: ReadonlyArray<Probe>) {
  return `Answer each question using only what you know from this conversation. If the answer is not available, answer exactly UNKNOWN. Do not guess. Reply with JSON only, an object mapping each id to its answer.\n\nQuestions:\n${probes.map((probe) => `- ${probe.id}: ${probe.question}`).join("\n")}`
}

async function readJobs(sid: string) {
  const dir = path.join(DATA_DIR, sid)
  const probes = (await Bun.file(path.join(dir, "probes.json")).json()) as Array<Probe>
  const span = await load(sid)
  const users = span.messages.filter((m) => m.role === "user").map((m) => m.text)
  const files = await Promise.all(
    ["sum", "chain"].map(async (folder) =>
      (await readdir(path.join(dir, folder)).catch(() => []))
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(dir, folder, name)),
    ),
  )
  const jobs = await Promise.all(
    files.flat().map(async (file) => {
      const summary = await Bun.file(file).json()
      if (summary.error || (summary.summary === undefined && summary.encrypted === undefined)) return []
      const method = summary.method as Method
      return READERS.filter((reader) => method !== "N" || reader === "gpt").flatMap((reader) =>
        VARIANTS.map((variant) => async () => {
          const out = path.join(dir, "read", `${method}.${summary.summarizer}.${reader}.${variant}.json`)
          if (await Bun.file(out).exists()) return
          const messages = [
            { role: "system", content: SYSTEM },
            ...rendered(method, summary, users, variant),
            { role: "user", content: questions(probes) },
          ]
          const reply: Reply | { error: string } = await (reader === "gpt"
            ? gpt(ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)]!, GPT_MODEL, messages, { effort: READ_EFFORT })
            : deepseek(DS_MODEL, messages as ReadonlyArray<Message>, 32_000)
          ).catch((error: unknown) => ({ error: String(error).slice(0, 400) }))
          await mkdir(path.dirname(out), { recursive: true })
          const answers = "text" in reply ? parseAnswers(reply.text) : undefined
          await Bun.write(out, JSON.stringify({ sid, method, summarizer: summary.summarizer, reader, variant, answers, ...( "error" in reply ? { error: reply.error } : { usage: reply.usage, raw: answers ? undefined : reply.text }) }, null, 1))
          console.log(`${sid} read ${method}.${summary.summarizer}.${reader}.${variant}: ${answers ? "ok" : "unparsed"}`)
        }),
      )
    }),
  )
  return jobs.flat()
}

/** The answers object; a reply cut off mid-object still yields its complete pairs. */
function parseAnswers(text: string): Record<string, string> | undefined {
  const match = /\{[\s\S]*\}/.exec(text)
  const whole = match ? json(match[0]) : undefined
  if (whole && typeof whole === "object") return whole as Record<string, string>
  const pairs = [...text.matchAll(/"(q\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(
    (pair) => [pair[1]!, String(json(`"${pair[2]}"`) ?? pair[2])] as const,
  )
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The graders' files (grading-N.json): each question's distinct answers in random order, blind to the configuration
 * that gave them. blind.json maps every configuration back to its answer's index (-1 for UNKNOWN, never graded).
 */
async function packet(sid: string) {
  const dir = path.join(DATA_DIR, sid)
  const probes = (await Bun.file(path.join(dir, "probes.json")).json()) as Array<Probe>
  const reads = (
    await Promise.all(
      (await readdir(path.join(dir, "read"))).map(async (name) => ({ config: name.replace(/\.json$/, ""), data: await Bun.file(path.join(dir, "read", name)).json() })),
    )
  ).filter((entry) => entry.data.answers)
  const items = probes.map((probe) => {
    const given = reads.map((entry) => {
      const answer = entry.data.answers[probe.id] ?? "UNKNOWN"
      return { config: entry.config, text: (typeof answer === "string" ? answer : JSON.stringify(answer)).trim() }
    })
    const distinct = [...new Set(given.map((entry) => entry.text).filter((text) => !/^unknown\.?$/i.test(text)))]
      .map((text) => ({ text, order: Math.random() }))
      .toSorted((a, b) => a.order - b.order)
      .map((entry) => entry.text)
    return { probe, given, distinct }
  })
  // One grader reads one part; a part holds whole questions and about 250 answers, so every answer to a question
  // is judged by the same grader.
  const parts = items.reduce<Array<Array<(typeof items)[number]>>>((chunks, item) => {
    const last = chunks.at(-1)
    if (last && last.reduce((total, entry) => total + entry.distinct.length, 0) + item.distinct.length <= 250) last.push(item)
    else chunks.push([item])
    return chunks
  }, [])
  await Promise.all(
    parts.map((part, index) =>
      Bun.write(
        path.join(dir, `grading-${index + 1}.json`),
        JSON.stringify({ sid, items: part.map((item) => ({ id: item.probe.id, question: item.probe.question, gold: item.probe.answer, answers: item.distinct })) }, null, 1),
      ),
    ),
  )
  await Bun.write(
    path.join(dir, "blind.json"),
    JSON.stringify(Object.fromEntries(items.map((item) => [item.probe.id, item.given.map((entry) => ({ config: entry.config, answer: item.distinct.indexOf(entry.text) }))])), null, 1),
  )
  console.log(`${sid}: ${reads.length} configurations, ${items.reduce((total, item) => total + item.distinct.length, 0)} distinct answers in ${parts.length} parts`)
}

async function report() {
  const rows: Array<{ sid: string; id: string; config: string; category: string; where: string; score: number; verdict: string }> = []
  const chains: Array<{ sid: string; method: string; summarizer: string; steps: ReadonlyArray<{ chars: number; attempts: number; error?: string }> }> = []
  const costs: Array<{ sid: string; method: string; summarizer: string; usage?: { input: number; cached: number; output: number }; chars: number; attempts: number; error?: string }> = []
  for (const sid of sids) {
    const dir = path.join(DATA_DIR, sid)
    const scored = (await readdir(dir)).filter((name) => /^scores-\d+\.json$/.test(name))
    if (scored.length > 0) {
      const verdicts = Object.assign(
        {},
        ...(await Promise.all(scored.map((name) => Bun.file(path.join(dir, name)).json()))),
      ) as Record<string, ReadonlyArray<string>>
      const blind = (await Bun.file(path.join(dir, "blind.json")).json()) as Record<string, ReadonlyArray<{ config: string; answer: number }>>
      const probes = (await Bun.file(path.join(dir, "probes.json")).json()) as Array<Probe>
      probes.forEach((probe) =>
        blind[probe.id]!.forEach((entry) => {
          const verdict = entry.answer < 0 ? "U" : (verdicts[probe.id]?.[entry.answer] ?? "M")
          rows.push({ sid, id: probe.id, config: entry.config, category: probe.category, where: probe.where, score: GRADE[verdict] ?? 0, verdict })
        }),
      )
    }
    for (const name of await readdir(path.join(dir, "sum"))) {
      if (!name.endsWith(".json")) continue
      const data = await Bun.file(path.join(dir, "sum", name)).json()
      costs.push({ sid, method: data.method, summarizer: data.summarizer, usage: data.usage, chars: (data.summary ?? data.encrypted ?? "").length, attempts: data.attempts, error: data.error })
    }
    for (const name of await readdir(path.join(dir, "chain")).catch(() => [])) {
      if (name.endsWith(".json")) chains.push({ sid, ...(await Bun.file(path.join(dir, "chain", name)).json()) })
    }
  }
  const part = (row: { config: string }) => {
    const [method = "", summarizer = "", reader = "", variant = ""] = row.config.split(".")
    return { method, summarizer, reader, variant }
  }
  // Summarizers compare only on sessions where Claude wrote every method, so a refused checkpoint does not skew a mean.
  const complete = sids.filter((sid) =>
    METHODS.every((method) => rows.some((row) => row.sid === sid && part(row).summarizer === "claude" && part(row).method === method)),
  )
  const fair = rows.filter((row) => complete.includes(row.sid))
  const lines = [
    "# Compaction eval results",
    "",
    `Sessions: ${sids.join(", ")}. Models: GPT ${GPT_MODEL} (writes at ${GPT_EFFORT}, reads at ${READ_EFFORT}), DeepSeek ${DS_MODEL}, Claude (subagent).`,
    "Score: C=1, P=0.5, M/W/UNKNOWN=0. wrong = share of answers contradicting the gold; unknown = share answered UNKNOWN.",
    "",
    "## By method and reader variant",
    table(groupMean(rows, (row) => `${part(row).method}.${part(row).variant}`)),
    `## By method and summarizer (summary only; sessions ${complete.join(", ")})`,
    table(groupMean(fair.filter((row) => part(row).variant === "sum"), (row) => `${part(row).method}.${part(row).summarizer}`)),
    "## By method and reader (summary only)",
    table(groupMean(rows.filter((row) => part(row).variant === "sum"), (row) => `${part(row).method}.${part(row).reader}`)),
    "## By method and session (summary only)",
    table(groupMean(rows.filter((row) => part(row).variant === "sum"), (row) => `${part(row).method}.${row.sid}`)),
    "## By method and question category (summary only)",
    table(groupMean(rows.filter((row) => part(row).variant === "sum"), (row) => `${part(row).method}.${row.category}`)),
    "## Chain loss: one compaction (gpt) vs three in a row (gdg = GPT, DeepSeek, GPT; ggg = GPT three times), by where the fact was",
    table(
      groupMean(
        rows.filter((row) => part(row).variant === "sum" && ["gpt", "gdg", "ggg"].includes(part(row).summarizer)),
        (row) => `${part(row).method}.${part(row).summarizer}.${row.where}`,
      ).toSorted((a, b) => a.name.localeCompare(b.name)),
    ),
    "## Paired differences (same session, question, summarizer, reader, variant; 95% interval over questions)",
    "| comparison | difference | interval | pairs |",
    "|---|---|---|---|",
    ...[
      ["A − A0 (analysis block)", "A0"],
      ["A − B (OpenCode prompt)", "B"],
      ["A − C (Codex prompt)", "C"],
    ].map(([label, other]) =>
      paired(rows, label!, (row) => (part(row).method === "A" && SINGLE.includes(part(row).summarizer) ? row.config.replace(/^A\./, `${other}.`) : undefined)),
    ),
    paired(rows, "A − N (native, GPT summarizer and reader)", (row) =>
      row.config.startsWith("A.gpt.gpt.") ? row.config.replace(/^A\./, "N.") : undefined,
    ),
    ...["A", "B", "C", "N"].map((method) =>
      paired(rows, `${method}: users kept − summary alone`, (row) =>
        part(row).method === method && part(row).variant === "users" && SINGLE.includes(part(row).summarizer) ? row.config.replace(/\.users$/, ".sum") : undefined,
      ),
    ),
    ...["A", "B", "C", "N"].flatMap((method) =>
      [undefined, "early"].map((where) =>
        paired(rows, `${method}: three compactions − one${where ? ` (${where} facts)` : ""}`, (row) =>
          part(row).method === method && ["gdg", "ggg"].includes(part(row).summarizer) && (where === undefined || row.where === where)
            ? row.config.replace(/\.(gdg|ggg)\./, ".gpt.")
            : undefined,
        ),
      ),
    ),
    "",
    "## Every configuration",
    table(groupMean(rows, (row) => row.config)),
    "## Checkpoint cost and size",
    "| sid | method | summarizer | input | cached | output | summary chars | attempts | error |",
    "|---|---|---|---|---|---|---|---|---|",
    ...costs
      .toSorted((a, b) => `${a.sid}${a.method}${a.summarizer}`.localeCompare(`${b.sid}${b.method}${b.summarizer}`))
      .map((c) => `| ${c.sid} | ${c.method} | ${c.summarizer} | ${c.usage?.input ?? ""} | ${c.usage?.cached ?? ""} | ${c.usage?.output ?? ""} | ${c.chars} | ${c.attempts} | ${c.error ?? ""} |`),
    "",
    "## Chain checkpoints (size after each step, attempts, errors)",
    "| sid | method | chain | step sizes | attempts | error |",
    "|---|---|---|---|---|---|",
    ...chains
      .toSorted((a, b) => `${a.sid}${a.method}`.localeCompare(`${b.sid}${b.method}`))
      .map((c) => `| ${c.sid} | ${c.method} | ${c.summarizer} | ${c.steps.map((step) => step.chars).join(" → ")} | ${c.steps.map((step) => step.attempts).join(" ")} | ${c.steps.find((step) => step.error)?.error ?? ""} |`),
  ]
  await Bun.write(path.join(EVAL_DIR, "RESULTS.md"), lines.join("\n"))
  console.log(lines.slice(0, 40).join("\n"))
}

/** Single compactions; gdg and ggg are chains. */
const SINGLE = ["gpt", "ds", "claude"]

/**
 * The mean score difference between each row picked as a base and its counterpart configuration on the same
 * question, with a 95% bootstrap interval that resamples questions (all pairs of one question move together).
 */
function paired<T extends { sid: string; id: string; config: string; score: number }>(
  rows: ReadonlyArray<T>,
  label: string,
  counterpart: (row: T) => string | undefined,
) {
  const index = new Map(rows.map((row) => [`${row.sid}|${row.id}|${row.config}`, row.score]))
  const diffs = rows.flatMap((row) => {
    const other = counterpart(row)
    const score = other === undefined ? undefined : index.get(`${row.sid}|${row.id}|${other}`)
    return score === undefined ? [] : [{ cluster: `${row.sid}|${row.id}`, diff: row.score - score }]
  })
  const clusters = [...Map.groupBy(diffs, (entry) => entry.cluster).values()]
  const seed = { value: 20261013 }
  const random = () => {
    seed.value = (seed.value * 1103515245 + 12345) % 2147483648
    return seed.value / 2147483648
  }
  const means = Array.from({ length: 2000 }, () => {
    const sample = clusters.map(() => clusters[Math.floor(random() * clusters.length)]!).flat()
    return sample.reduce((total, entry) => total + entry.diff, 0) / sample.length
  }).toSorted((a, b) => a - b)
  const mean = diffs.reduce((total, entry) => total + entry.diff, 0) / diffs.length
  const points = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`
  return `| ${label} | ${points(mean)} | ${points(means[50]!)} … ${points(means[1949]!)} | ${diffs.length} |`
}

function groupMean<T extends { score: number; verdict: string }>(rows: ReadonlyArray<T>, key: (row: T) => string) {
  const groups = rows.reduce<Map<string, Array<T>>>((map, row) => map.set(key(row), [...(map.get(key(row)) ?? []), row]), new Map())
  const share = (group: ReadonlyArray<T>, verdict: string) => group.filter((row) => row.verdict === verdict).length / group.length
  return [...groups.entries()]
    .map(([name, group]) => ({ name, mean: group.reduce((total, row) => total + row.score, 0) / group.length, wrong: share(group, "W"), unknown: share(group, "U"), n: group.length }))
    .toSorted((a, b) => b.mean - a.mean)
}

function table(groups: ReadonlyArray<{ name: string; mean: number; wrong: number; unknown: number; n: number }>) {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  return [
    "| configuration | score | wrong | unknown | n |",
    "|---|---|---|---|---|",
    ...groups.map((g) => `| ${g.name} | ${percent(g.mean)} | ${percent(g.wrong)} | ${percent(g.unknown)} | ${g.n} |`),
    "",
  ].join("\n")
}

function sum(a?: { input: number; cached: number; output: number }, b?: { input: number; cached: number; output: number }) {
  if (!a || !b) return a ?? b
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output }
}

async function pool(jobs: ReadonlyArray<() => Promise<void>>, size: number) {
  const queue = [...jobs]
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await job().catch((error) => console.error(String(error)))
    }),
  )
}

// Last, so every top-level constant above is initialized before a command runs.
const [command = "", ...args] = process.argv.slice(2)
const sids = args.length > 0 ? args : (await readdir(DATA_DIR)).filter((name) => name.startsWith("s"))

if (command === "summarize") await pool(sids.flatMap((sid) => summarizeJobs(sid)), 4)
else if (command === "chain") await pool(sids.flatMap((sid) => chainJobs(sid)), 4)
else if (command === "claude") await Promise.all(sids.map(parseClaude))
else if (command === "read") await pool((await Promise.all(sids.map(readJobs))).flat(), 6)
else if (command === "packet") await Promise.all(sids.map(packet))
else if (command === "report") await report()
else throw new Error("usage: run.ts summarize|chain|claude|read|packet|report [sid…]")
