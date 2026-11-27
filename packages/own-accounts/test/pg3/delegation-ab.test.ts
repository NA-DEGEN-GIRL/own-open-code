// The PG3 delegation A/B runner (07 §8.4) in `--fake` mode: the plan, the Codex-wording swap, the measuring and the
// verdicts as pure functions, then a slice of the matrix end to end on a real upstream server with own-accounts and
// three scripted backends (e2e-kit). The scripted models follow whatever delegation instruction reaches them, so every
// verdict passes exactly when the runner wires the modes and both wordings into the requests and reads the results
// back. Real mode is never run here: it would talk to this PC's installed service and spend real quota. Fake
// credentials only; the servers bind 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Account, Preset } from "@own/protocol"
import {
  ACTIVE_EXTRA,
  STAND_IN,
  advice,
  cells,
  client,
  codexVariant,
  execute,
  measure,
  measurePool,
  MODES,
  parseArgs,
  pickMains,
  plan,
  POOL_SHORT,
  poolFixture,
  poolVariant,
  poolVerdicts,
  readCodexWording,
  report,
  startFakeBench,
  verdicts,
  WORDINGS,
  writeResults,
  type AccountLike,
  type FakeBench,
  type Main,
  type Row,
} from "./delegation-ab"
import { FIXTURE, POOL_TASKS, TASKS } from "./tasks"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const MATRIX_TIMEOUT = 600_000

const MAIN: Main = {
  key: "gpt",
  label: "ChatGPT 01",
  accountID: "acc_pg01",
  group: "codex",
  ref: { providerID: "own-codex-pg01", id: "gpt-6-sol" },
}

describe("tasks", () => {
  test("ten read-only tasks, six of them splittable, none asking for subagents", () => {
    expect(TASKS.map((task) => task.id)).toEqual(["t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10"])
    expect(TASKS.filter((task) => task.splittable)).toHaveLength(6)
    for (const task of TASKS) {
      expect(task.parts > 0).toBe(task.splittable)
      expect(task.prompt).toMatch(/^[\x20-\x7e]+$/)
      expect(task.prompt).not.toMatch(/["\\]/)
      expect(task.prompt.toLowerCase()).not.toMatch(/subagent|sub-agent|delegat|in parallel/)
    }
    // t09 passes `도움될 때`'s per-message cap (6) but not `적극적으로`'s (12).
    expect(TASKS.find((task) => task.id === "t09")?.parts).toBeGreaterThan(Preset.CAPS.perMessage)
  })

  test("the fixture holds the eight files its README lists", () => {
    const listed = FIXTURE["README.md"]?.match(/[\w/]+(?:\.\w+)*\.(?:md|json|ts)/g) ?? []
    expect(listed.toSorted()).toEqual(Object.keys(FIXTURE).toSorted())
    expect(Object.keys(FIXTURE)).toHaveLength(8)
  })
})

describe("plan and options", () => {
  test("모델 기본 runs once per task, the other modes once per wording", () => {
    const runs = plan({ mains: [MAIN], modes: MODES, wordings: WORDINGS, tasks: TASKS, repeat: 1 })
    expect(runs).toHaveLength(TASKS.length * (1 + 3 * 2))
    expect(runs.filter((run) => run.mode === "model").every((run) => run.wording === "none")).toBe(true)
    expect(
      plan({
        mains: [MAIN, { ...MAIN, key: "claude" }],
        modes: ["active"],
        wordings: ["ours"],
        tasks: TASKS,
        repeat: 3,
      }),
    ).toHaveLength(60)
  })

  test("arguments: one of --fake or --real, known options and values only", () => {
    expect(parseArgs(["--fake"]).problems).toEqual([])
    expect(parseArgs(["--fake", "--real"]).problems).toContain("pass exactly one of --fake and --real")
    expect(parseArgs([]).problems).toContain("pass exactly one of --fake and --real")
    expect(parseArgs(["--fake", "--wat"]).problems).toContain("unknown option --wat")
    expect(parseArgs(["--fake", "--modes", "active,bogus"]).problems).toContain("unknown value bogus")
    const args = parseArgs(["--real", "--models", "gpt", "--tasks", "t03,t09", "--deepseek-model", "deepseek-v4-pro"])
    expect(args).toMatchObject({ real: true, yes: false, models: ["gpt"], concurrency: 1 })
    expect(args.tasks.map((task) => task.id)).toEqual(["t03", "t09"])
    expect(args.choice.deepseek.model).toBe("deepseek-v4-pro")
  })
})

const CLAUDE = Account.ID.claudeSlot
const KEY = Account.ID.make("acc_pg13key")
const DS = Account.ID.make("acc_pg13ds")

describe("PG13 model pool variant (07 §11)", () => {
  test("--pool: the twelve pool tasks at 도움될 때, both wordings; the two new tasks split and need no paid model", () => {
    const args = parseArgs(["--fake", "--pool"])
    expect(args.problems).toEqual([])
    expect(args).toMatchObject({ pool: true, modes: ["when-useful"], wordings: ["ours", "codex"] })
    expect(args.tasks.map((task) => task.id)).toEqual(POOL_TASKS.map((task) => task.id))
    expect(POOL_TASKS.slice(-2).map((task) => [task.id, task.splittable])).toEqual([
      ["t11", true],
      ["t12", true],
    ])
    for (const task of POOL_TASKS) expect(task.prompt).toMatch(/^[\x20-\x7e]+$/)
    expect(parseArgs(["--fake", "--pool", "--tasks", "t11"]).tasks.map((task) => task.id)).toEqual(["t11"])
    expect(parseArgs(["--fake"]).pool).toBe(false)
    const runs = plan({ mains: [MAIN], modes: args.modes, wordings: args.wordings, tasks: args.tasks, repeat: 1 })
    expect(runs).toHaveLength(12 * 2)
  })

  test("the short wording swaps only the pool header", () => {
    const ours = [
      "Session delegation instruction, set by the user for this session. Follow it like AGENTS.md instructions.",
      "Delegation mode: when useful.",
      "",
      "Subagent models. The user chose the models below for subagents in this session, so naming one as `model` is the user's explicit request.",
      "- gpt-6-luna: GPT-6 Luna, OpenAI, on your own account and limits.",
      "Compared with you: lighter: gpt-6-luna.",
    ].join("\n")
    const short = poolVariant(ours).split("\n")
    expect(short[3]).toBe(POOL_SHORT)
    expect(short.filter((line, index) => line !== ours.split("\n")[index])).toEqual([POOL_SHORT])
  })

  test("the pool fixture: the main account's lightest, each company's strongest subscription, a verified local, DeepSeek", () => {
    const card = { at: 1 }
    const candidate = (key: string, extra: Partial<Preset.PoolCandidate>): Preset.PoolCandidate => ({
      key,
      model: Schema.decodeUnknownSync(Model.ID)(key),
      card,
      ...extra,
    })
    const offer: Preset.PoolOffer = {
      candidates: [
        candidate("gpt-6-sol", { runs: "main", price: 2 }),
        candidate("gpt-6-luna", { runs: "main", price: 0.1 }),
        candidate("claude-opus-5-5", { runs: "subscription", company: "anthropic", price: 4, account: CLAUDE }),
        candidate("claude-haiku-4-5", { runs: "subscription", company: "anthropic", price: 1, account: CLAUDE }),
        candidate("qwen", { runs: "local", account: "local:ollama", card: { windowVerified: false } }),
        candidate("llama", { runs: "local", account: "local:ollama", card: { windowVerified: true } }),
        candidate("gpt-6-sol-api", { runs: "paid", company: "openai", price: 2, account: KEY }),
        candidate("deepseek-flash", { runs: "paid", company: "deepseek", price: 0.15, account: DS }),
      ],
      recommended: [],
    }
    expect(poolFixture(offer).map((item) => item.key)).toEqual([
      "gpt-6-luna",
      "claude-opus-5-5",
      "llama",
      "deepseek-flash",
    ])
  })

  test("measuring the model values: pool names, values outside the pool, recovery, paid picks and agent keys", () => {
    const keys = ["gpt-6-luna", "deepseek-flash"]
    const tool = (input: Record<string, unknown>, error?: string) => ({
      type: "tool",
      name: "subagent",
      state: { input, status: error ? "error" : "completed", ...(error ? { error: { message: error } } : {}) },
    })
    const declined = `Unknown agent: ${Preset.rejection({ reason: "model", models: ["gpt-6-luna", "deepseek-flash"] })}`
    const messages = [
      {
        content: [
          tool({ agent: "general", model: "made-up" }, declined),
          tool({ agent: "general", model: "gpt-6-luna" }),
          tool({ agent: "deepseek-flash" }),
          tool({ agent: "general", model: "deepseek-flash" }),
          tool({ agent: "general", model: "review" }),
        ],
      },
    ]
    expect(measurePool(messages, keys, ["deepseek-flash"])).toEqual({
      named: 4,
      inPool: 2,
      outside: 1,
      paidPicks: 1,
      agentKeys: 1,
      recovered: true,
    })
    expect(measurePool([{ content: [tool({ agent: "general" })] }], keys, []).recovered).toBeNull()
  })

  test("PG13 verdicts: ≤ 10% outside with recovery, no paid pick, no error; the pool-name share is recorded", () => {
    const base: Row = {
      model: "gpt",
      mode: "when-useful",
      wording: "ours",
      task: "t01",
      splittable: true,
      repeat: 1,
      sessionID: "ses_x",
      entry: "ours",
      ms: 1,
      error: null,
      calls: 10,
      completed: 10,
      declined: 0,
      capped: 0,
      continued: null,
      pool: { named: 10, inPool: 9, outside: 1, paidPicks: 0, agentKeys: 0, recovered: true },
    }
    const passed = poolVerdicts([base])
    expect(passed.map((verdict) => [verdict.gate, verdict.result])).toEqual([
      ["PG13 (1) 묶음 이름", "recorded"],
      ["PG13 (2) 묶음 밖", "pass"],
      ["PG13 (3) 돈 드는 항목", "pass"],
      ["PG13 (4) 세션 오류", "pass"],
    ])
    const failed = poolVerdicts([
      { ...base, pool: { named: 4, inPool: 2, outside: 2, paidPicks: 1, agentKeys: 0, recovered: false } },
    ])
    expect(failed.map((verdict) => verdict.result)).toEqual(["recorded", "fail", "fail", "pass"])
    // The PG3 advice ignores PG13's rows.
    expect(advice(failed)).toEqual(["GPT with our wording did not run; nothing to decide."])
  })
})

describe("Codex wording", () => {
  test("reads the two sentences from Codex's Rust source", () => {
    const source = [
      'const OTHER: &str = "x";',
      'const EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT: &str = "Only on request, \\"explicitly\\".";',
      'const PROACTIVE_MULTI_AGENT_MODE_TEXT: &str = "Proactive.\\n\\nSplit the work.";',
    ].join("\n")
    expect(readCodexWording(source)).toEqual({
      explicit: 'Only on request, "explicitly".',
      proactive: "Proactive.\n\nSplit the work.",
    })
    expect(readCodexWording('const PROACTIVE_MULTI_AGENT_MODE_TEXT: &str = "x";')).toBeUndefined()
  })

  test("the swap replaces only the delegation sentence: header, cards and caps stay", () => {
    const ours = (delegation: "on-request" | "when-useful" | "active") =>
      Preset.renderGuidance({ delegation, ultra: false, caps: Preset.CAPS, cards: {} })?.text ?? ""
    expect(ACTIVE_EXTRA).not.toBe("")
    expect(ours("active")).toContain(ACTIVE_EXTRA)
    expect(ours("when-useful")).not.toContain(ACTIVE_EXTRA)
    for (const mode of ["on-request", "when-useful", "active"] as const) {
      const text = ours(mode)
      const swapped = codexVariant(text, mode, STAND_IN)
      const [header] = text.split("\n")
      const caps = text.split("\n").at(-1) ?? ""
      expect(swapped.startsWith(`${header}\n`)).toBe(true)
      expect(swapped.endsWith(caps)).toBe(true)
      expect(swapped).not.toContain("Delegation mode:")
      expect(swapped).toContain(mode === "on-request" ? STAND_IN.explicit : STAND_IN.proactive)
      expect(swapped.includes(ACTIVE_EXTRA)).toBe(mode === "active")
    }
  })
})

describe("measuring and verdicts", () => {
  const tool = (status: string, error?: string) => ({
    type: "tool",
    name: "subagent",
    state: { status, input: {}, ...(error ? { error: { message: error } } : {}) },
  })
  const cap = `Unknown agent: ${Preset.rejection({ reason: "caps", cap: "perMessage", max: 6 })}`
  const model = `Unknown agent: ${Preset.rejection({ reason: "model", roles: [] })}`

  test("counts calls, completions, gate declines and what came after the last cap", () => {
    const messages = [
      { type: "assistant", content: [{ type: "text", text: "Let me split this." }, tool("completed")] },
      { type: "assistant", content: [tool("error", model)] },
      { type: "assistant", content: [tool("error", cap)] },
      { type: "assistant", content: [{ type: "text", text: "Going on myself." }] },
    ]
    expect(measure(messages)).toEqual({ calls: 3, completed: 1, declined: 2, capped: 1, continued: true })
    expect(measure([{ type: "assistant", content: [tool("error", cap)] }]).continued).toBe(false)
    expect(measure([{ type: "assistant", content: [tool("error", "Unknown agent: nope")] }])).toMatchObject({
      calls: 1,
      declined: 0,
      continued: null,
    })
    expect(measure([])).toEqual({ calls: 0, completed: 0, declined: 0, capped: 0, continued: null })
  })

  test("PG3 criteria and the fallback advice", () => {
    const row = (input: Partial<Row> & Pick<Row, "model" | "mode" | "wording" | "task" | "splittable">): Row => ({
      repeat: 1,
      sessionID: "ses_x",
      entry: input.wording === "none" ? "none" : input.wording,
      calls: 0,
      completed: 0,
      declined: 0,
      capped: 0,
      continued: null,
      ms: 1,
      error: null,
      ...input,
    })
    const rows: Row[] = [
      row({ model: "gpt", mode: "model", wording: "none", task: "t01", splittable: true, calls: 1 }),
      row({ model: "claude", mode: "model", wording: "none", task: "t01", splittable: true, calls: 2 }),
      row({ model: "gpt", mode: "on-request", wording: "ours", task: "t01", splittable: true }),
      row({ model: "gpt", mode: "when-useful", wording: "ours", task: "t01", splittable: true }),
      row({ model: "gpt", mode: "when-useful", wording: "ours", task: "t03", splittable: false }),
      row({
        model: "gpt",
        mode: "when-useful",
        wording: "codex",
        task: "t01",
        splittable: true,
        calls: 7,
        capped: 1,
        continued: true,
      }),
      row({ model: "gpt", mode: "active", wording: "codex", task: "t01", splittable: true, error: "timeout" }),
    ]
    const judged = verdicts(cells(rows), 0.5)
    const find = (gate: string, model: string, wording: string) =>
      judged.find((item) => item.gate === gate && item.model === model && item.wording === wording)?.result
    expect(find("모델 기본", "gpt", "none")).toBe("fail")
    expect(find("모델 기본", "claude", "none")).toBe("recorded")
    expect(find("요청할 때만", "gpt", "ours")).toBe("pass")
    expect(find("도움될 때", "gpt", "ours")).toBe("fail")
    expect(find("도움될 때", "gpt", "codex")).toBe("pass")
    expect(find("적극적으로", "gpt", "codex")).toBe("not run")
    expect(find("상한 거절 뒤", "gpt", "codex")).toBe("pass")
    expect(find("상한 거절 뒤", "gpt", "ours")).toBe("not run")
    expect(advice(judged)).toEqual([
      "GPT missed our wording (도움될 때) but follows Codex's: fallback ① (07 §8.4), use Codex's sentences.",
    ])
  })
})

describe("real mode account choice", () => {
  const account = (id: string, kind: string, status = "ready"): AccountLike => ({
    id,
    kind,
    label: `label ${id}`,
    providerID: `own-${kind}-${id}`,
    status,
  })

  test("prefers ChatGPT, the Claude slot and a DeepSeek key; skips what is not ready or missing", () => {
    const accounts = [
      account("c1", "codex", "exhausted"),
      account("c2", "codex"),
      account("a1", "anth"),
      { ...account("acc_claude_slot", "claude-sub"), providerID: "anthropic" },
    ]
    const picked = pickMains(accounts, ["gpt", "claude", "deepseek"])
    expect(picked.missing).toEqual(["deepseek"])
    expect(picked.mains.map((main) => [main.key, main.accountID, main.group, main.ref.id])).toEqual([
      ["gpt", "c2", "codex", "gpt-6-sol"],
      ["claude", "acc_claude_slot", "claude-sub", "claude-opus-5-5"],
    ])
    const named = pickMains([...accounts, account("d1", "ds")], ["claude", "deepseek"], {
      claude: { account: "label a1" },
      deepseek: { model: "deepseek-v4-pro" },
    })
    expect(named.mains.map((main) => [main.accountID, main.ref.providerID, main.ref.id])).toEqual([
      ["a1", "own-anth-a1", "claude-opus-5-5"],
      ["d1", "own-ds-d1", "deepseek-v4-pro"],
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------

const fixture: { fake?: FakeBench } = {}

beforeAll(async () => {
  fixture.fake = await startFakeBench()
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.fake?.stop()
}, 60_000)

describe("PG3 on fakes (a slice of the matrix: t01 splittable, t04 not, t09 over a cap)", () => {
  test(
    "every mode and both wordings reach the three models; the verdicts pass; results are written without secrets",
    async () => {
      const fake = required(fixture.fake)
      const tasks = TASKS.filter((task) => ["t01", "t04", "t09"].includes(task.id))
      const runs = plan({ mains: fake.bench.mains, modes: MODES, wordings: WORDINGS, tasks, repeat: 1 })
      const rows = await execute(fake.bench, runs, {
        concurrency: 8,
        timeoutMs: 120_000,
        codex: STAND_IN,
        stamp: "test",
      })

      expect(rows).toHaveLength(3 * 7 * 3)
      expect(rows.filter((item) => item.error !== null)).toEqual([])
      for (const item of rows) expect(item.entry).toBe(item.mode === "model" ? "none" : item.wording)
      const pick = (model: string, mode: string, wording: string, task: string) =>
        required(
          rows.find(
            (item) => item.model === model && item.mode === mode && item.wording === wording && item.task === task,
          ),
        )
      // GPT keeps to "only on request" without an entry; Claude decides by itself; DeepSeek does not delegate.
      expect(pick("gpt", "model", "none", "t01").calls).toBe(0)
      expect(pick("claude", "model", "none", "t01")).toMatchObject({ calls: 3, completed: 3 })
      expect(pick("deepseek", "model", "none", "t01").calls).toBe(0)
      for (const model of ["gpt", "claude", "deepseek"])
        for (const wording of WORDINGS) {
          expect(pick(model, "on-request", wording, "t01").calls).toBe(0)
          expect(pick(model, "when-useful", wording, "t01")).toMatchObject({ calls: 3, completed: 3, declined: 0 })
          expect(pick(model, "when-useful", wording, "t04").calls).toBe(0)
          // Eight parts: `도움될 때` stops at six per message, `적극적으로` allows twelve.
          expect(pick(model, "when-useful", wording, "t09")).toMatchObject({
            calls: 7,
            completed: 6,
            capped: 1,
            continued: true,
          })
          expect(pick(model, "active", wording, "t09")).toMatchObject({ calls: 8, completed: 8, declined: 0 })
        }

      // Both wordings went out to every backend.
      const bodies = fake.requests().map((request) => request.body)
      expect(bodies.some((body) => body.includes(STAND_IN.proactive))).toBe(true)
      expect(bodies.some((body) => body.includes(STAND_IN.explicit))).toBe(true)
      expect(bodies.some((body) => body.includes("Delegation mode: active"))).toBe(true)
      expect(bodies.some((body) => body.includes("Delegation mode: on request"))).toBe(true)

      // The temporary presets are gone.
      const api = client(fake.bench.service)
      const listed = JSON.stringify(await api.rpc("presets.list", {}, fake.bench.control))
      expect(listed).not.toContain("PG3 ")

      const result = report(
        {
          mode: "fake",
          date: "2026-10-02T00:00:00.000Z",
          mains: fake.bench.mains.map((item) => ({
            key: item.key,
            label: item.label,
            group: item.group,
            model: `${item.ref.providerID}/${item.ref.id}`,
          })),
          tasks: tasks.map((task) => task.id),
          codexWording: "stand-in sentences (--fake)",
          minShare: 0.5,
        },
        rows,
      )
      expect(result.verdicts.filter((verdict) => verdict.result === "fail")).toEqual([])
      expect(result.verdicts.filter((verdict) => verdict.result === "pass").length).toBeGreaterThan(0)
      expect(result.advice).toEqual(["GPT follows our wording: keep it (07 §3.3)."])

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-pg3-results-"))
      const files = await writeResults(dir, result)
      const texts = await Promise.all([Bun.file(files.md).text(), Bun.file(files.json).text()])
      expect(texts[0]).toContain("## 판정 (07 §8.4 PG3)")
      for (const text of texts) {
        expect(text).not.toContain("sk-ant-fake-pg3")
        expect(text).not.toContain("sk-fake-pg3")
        expect(text).not.toContain(fake.bench.service.authorization)
      }
      await fs.rm(dir, { recursive: true, force: true })
    },
    MATRIX_TIMEOUT,
  )
})

describe("PG13 on fakes (07 §11: t02 with a decline, t04 not split, t11 review, t12 skim; GPT, both wordings)", () => {
  test(
    "the pool reaches the main, the scripted picks are measured, no paid pick, the temporary pool preset is gone",
    async () => {
      const fake = required(fixture.fake)
      const tasks = POOL_TASKS.filter((task) => ["t02", "t04", "t11", "t12"].includes(task.id))
      const mains = fake.bench.mains.filter((main) => main.key === "gpt")
      const runs = plan({ mains, modes: ["when-useful"], wordings: WORDINGS, tasks, repeat: 1 })
      const rows = await execute(fake.bench, runs, { concurrency: 4, timeoutMs: 120_000, stamp: "pg13", pool: true })
      expect(rows.filter((item) => item.error !== null)).toEqual([])
      for (const item of rows) expect(item.entry).toBe(item.wording)
      const pick = (wording: string, task: string) =>
        required(rows.find((item) => item.wording === wording && item.task === task))
      for (const wording of WORDINGS) {
        // t02: a made-up name is declined, then the main names a pool model.
        expect(pick(wording, "t02").pool).toMatchObject({ outside: 1, recovered: true, paidPicks: 0 })
        expect(pick(wording, "t04").calls).toBe(0)
        expect(pick(wording, "t11").pool).toMatchObject({ named: 1, inPool: 1, outside: 0, paidPicks: 0 })
        expect(pick(wording, "t12").pool?.inPool).toBeGreaterThan(0)
      }
      const bodies = fake.requests().map((request) => request.body)
      expect(bodies.some((body) => body.includes("Subagent models. The user chose the models below"))).toBe(true)
      expect(bodies.some((body) => body.includes(POOL_SHORT))).toBe(true)
      const result = report(
        {
          mode: "fake",
          date: "2026-10-09T00:00:00.000Z",
          mains: mains.map((item) => ({
            key: item.key,
            label: item.label,
            group: item.group,
            model: `${item.ref.providerID}/${item.ref.id}`,
          })),
          tasks: tasks.map((task) => task.id),
          codexWording: "PG13 short header (--fake)",
          minShare: 0.5,
        },
        rows,
      )
      const pg13 = result.verdicts.filter((verdict) => verdict.gate.startsWith("PG13"))
      expect(pg13.length).toBe(8)
      // The slice is small on purpose: its one scripted decline is 1 of 7 named calls, over the 10% bar, so (2) fails
      // while the recovery after it is counted; no paid pick and no error.
      for (const wording of WORDINGS)
        expect(
          pg13.filter((verdict) => verdict.wording === wording).map((verdict) => [verdict.result, verdict.detail]),
        ).toEqual([
          ["recorded", "6/7 named call(s) with a pool name; 0 pool name(s) as agent"],
          ["fail", "1/7 outside the pool (≤ 10%); 1/1 recovered after a decline"],
          ["pass", "0 paid pick(s) on tasks that need none"],
          ["pass", "0 error(s) in 4 run(s)"],
        ])
      const listed = JSON.stringify(await client(fake.bench.service).rpc("presets.list", {}, fake.bench.control))
      expect(listed).not.toContain("PG13 pool")
    },
    MATRIX_TIMEOUT,
  )
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("PG3 fixture was not started")
  return value
}
