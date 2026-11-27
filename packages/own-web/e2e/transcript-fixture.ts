// Transcript fixtures (03 §20.4 PF3/PF4/PF7): synthetic sessions shaped like real ones. The large session has
// 2,000 messages, 40 % of them tool steps (upstream's timeline fixture has 400), plus account switches, a variant
// change, an undone switch (A→B→A, must draw nothing) and compactions. Ledger lines price every step like the router.
import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client/promise"
import type { Ledger } from "@own/protocol"

export const DIRECTORY = "D:\\work\\own-fixture"
export const BASE_TIME = 1_790_000_000_000
export const ACCOUNT_A = {
  id: "acc_personal",
  providerID: "own-codex-a1b2",
  label: "개인 Pro",
  color: "indigo",
} as const
export const ACCOUNT_B = { id: "acc_work", providerID: "own-oai-c3d4", label: "회사 · prod", color: "teal" } as const
export const MODEL_A = { providerID: ACCOUNT_A.providerID, id: "gpt-5.6-sol", variant: "high" }
export const MODEL_B = { providerID: ACCOUNT_B.providerID, id: "gpt-5.5" }
/**
 * Three Claude subscription accounts on the one `anthropic` provider (02 §8.7): AC-01 is the slot's own
 * (`acc_claude_slot`), AC-02 and AC-03 the plugin's. All fake; the ids only look like the bug report's.
 */
export const CLAUDE_ACCOUNTS = [
  { id: "acc_claude_slot", label: "AC-01", color: "rose" },
  { id: "acc_01M57GC3FAKE", label: "AC-02", color: "amber" },
  { id: "acc_01M57GR3FAKE", label: "AC-03", color: "teal" },
] as const
export const MODEL_CLAUDE = { providerID: "anthropic", id: "claude-haiku-5-5" }
export const MODEL_SONNET = { providerID: "anthropic", id: "claude-sonnet-5-5" }

export interface FixtureSession {
  readonly id: string
  readonly title: string
  readonly messages: SessionMessageInfo[]
  readonly lines: Ledger.Line[]
}

const MARKDOWN = [
  "라우터 RPC의 `switch.estimate`는 머물 때 대비 추가분(Δ)을 돌려줍니다. 아래처럼 호출합니다.",
  "",
  "```ts",
  'const estimate = await own.rpc.call("switch.estimate", { sessionID, target })',
  "for (const option of estimate.options) console.log(option.strategy, option.delta)",
  "```",
  "",
  "- 캐시 재작성 토큰은 항상 보입니다.",
  "- credits에는 `≈`와 **추정**을 붙입니다.",
].join("\n")

/**
 * `turns` turns of five messages: user, two tool steps (read + shell: the 40 % tool cards), a markdown answer and a
 * short closing step. Every `switchEvery` turns an account switch replaces the closing step; every `compactEvery`
 * turns a compaction does.
 */
export function buildSession(input: {
  readonly id: string
  readonly title: string
  readonly turns: number
  readonly switchEvery?: number
  readonly compactEvery?: number
}): FixtureSession {
  const messages: SessionMessageInfo[] = []
  const lines: Ledger.Line[] = []
  let n = 0
  let time = BASE_TIME
  let model: { providerID: string; id: string; variant?: string } = MODEL_A
  let context = 12_000
  let cold = true
  const id = () => `msg_${input.id.slice(4)}_${String(n++).padStart(6, "0")}`
  const tick = (ms: number) => (time += ms)

  const step = (content: SessionMessageAssistant["content"], turn: number, first: boolean) => {
    const messageID = id()
    const created = tick(400)
    // The first step after a switch or compaction reads little from the cache (a "캐시 재작성" footer tag).
    const cacheRead = Math.round(context * (first && cold ? 0.3 : first ? 0.9 : 0.95))
    if (first) cold = false
    const inputTokens = context - cacheRead
    const tokens = {
      input: inputTokens,
      output: 180 + (turn % 7) * 40,
      reasoning: 60,
      cache: { read: cacheRead, write: 0 },
    }
    const codex = model.providerID === ACCOUNT_A.providerID
    const completed = tick(900 + (turn % 5) * 150)
    const cost = codex ? 0 : (inputTokens * 1.25 + cacheRead * 0.125 + (tokens.output + tokens.reasoning) * 10) / 1e6
    messages.push({
      id: messageID,
      type: "assistant",
      agent: "build",
      model,
      content,
      tokens,
      cost,
      finish: "stop",
      // The response body ends before the step settles (core's `session.step.streamed`), so the footer has a speed.
      time: { created, streamed: completed - 120, completed },
    } as SessionMessageAssistant)
    lines.push(ledgerLine(input.id, messageID, model, tokens, codex, time))
    context += 250
  }

  for (let turn = 0; turn < input.turns; turn++) {
    const switching = !!input.switchEvery && turn > 0 && turn % input.switchEvery === 0
    const compacting = !!input.compactEvery && turn > 0 && turn % input.compactEvery === 0 && !switching
    messages.push({
      id: id(),
      type: "user",
      text: `${turn + 1}번째 요청: 계정 라우터의 전환 비용 추정을 확인하고 테스트를 돌려 주세요.`,
      time: { created: tick(5_000) },
    })
    step(
      [
        tool(
          `call_${turn}_r`,
          "read",
          { filePath: "packages/own-accounts/src/switching/planner.ts" },
          "export function plan() {}\n".repeat(8),
          time,
        ),
      ],
      turn,
      true,
    )
    step(
      [tool(`call_${turn}_s`, "shell", { command: "bun test --filter router" }, "12 pass\n0 fail\n", time)],
      turn,
      false,
    )
    step([{ type: "text", text: `${MARKDOWN}\n\n(${turn + 1})` }], turn, false)
    if (switching) {
      const previous = model
      model = model.providerID === ACCOUNT_A.providerID ? MODEL_B : MODEL_A
      messages.push({ id: id(), type: "model-switched", model, previous, time: { created: tick(200) } })
      cold = true
      continue
    }
    if (compacting) {
      messages.push({
        id: id(),
        type: "compaction",
        status: "completed",
        reason: "auto",
        model,
        summary: "## 요약\n\n지금까지의 대화를 요약했습니다.",
        tokens: { input: context, output: 2_000, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: tick(300) },
      } as SessionMessageInfo)
      context = 14_000
      cold = true
      continue
    }
    step([{ type: "text", text: "완료했습니다." }], turn, false)
  }
  return { id: input.id, title: input.title, messages, lines }
}

/** A 2×2 PNG (four colors) as the image tool's result file. */
const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=="

/**
 * 이미지 만들기 (02 §9.6, MUX 2026-11-06): one `image_generate` call that made a picture on the second account after the
 * first was skipped, so its line has the image (tap to see it whole) and a folded `먼저 시도한 계정 (1)`.
 */
export function buildImageSession(id: string): FixtureSession {
  const session = buildSession({ id, title: "이미지 만들기", turns: 1 })
  const at = session.messages.at(-1)!.time.created
  session.messages.push(
    {
      id: `msg_${id.slice(4)}_900001`,
      type: "user",
      text: "우주선 아이콘을 그려 줘",
      // A pasted picture: drawn from a blob: URL, not this data: URI (src/image/object-url.ts, core P-057).
      files: [
        { data: IMAGE.slice(IMAGE.indexOf(",") + 1), mime: "image/png", source: { type: "inline" }, name: "sketch.png" },
      ],
      time: { created: at + 1_000 },
    },
    {
      id: `msg_${id.slice(4)}_900002`,
      type: "assistant",
      agent: "build",
      model: MODEL_A,
      content: [
        {
          type: "tool",
          id: "call_image_1",
          name: "image_generate",
          state: {
            status: "completed",
            input: { prompt: "a small spaceship icon" },
            content: [
              { type: "text", text: "이미지를 만들었어요." },
              { type: "file", uri: IMAGE, mime: "image/png", name: "spaceship.png" },
            ],
            metadata: {
              ownImage: {
                status: "done",
                model: "gpt-image-2",
                route: "key",
                account: "회사 · prod",
                costUSD: 0.0421,
                path: "D:\\work\\own-fixture\\.own\\images\\2026-11-06\\spaceship-icon-very-long-file-name-for-a-phone.png",
                steps: [
                  { route: "key", accountID: "acc_personal", label: "개인 Pro", outcome: "skipped", why: "한도에 닿았어요" },
                  { route: "key", accountID: "acc_work", label: "회사 · prod", outcome: "used" },
                ],
              },
            },
          },
          time: { created: at + 1_200, ran: at + 1_250, completed: at + 4_000 },
        },
      ],
      tokens: { input: 1_000, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      finish: "stop",
      time: { created: at + 1_100, streamed: at + 4_000, completed: at + 4_100 },
    } as SessionMessageAssistant,
  )
  return session
}

/** A 1×1 two-frame looping GIF (red, then blue, 100 ms each), base64. */
const GIF = "R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw=="
/** An SVG that would run a script and an `onload` if it were ever put into the page as markup (it must not be). */
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" onload="window.__svgRan = 1">' +
  '<script>window.__svgRan = 1</script><circle cx="32" cy="32" r="24" fill="#3b82f6"/></svg>'

/**
 * 이미지 만들기 in GIF and SVG (decisions IM-23): an animated GIF whose file part is only its first frame and whose card
 * `preview` is the whole loop, and an SVG with a script that the card shows as an image only.
 */
export function buildImageFormatSession(id: string): FixtureSession {
  const session = buildSession({ id, title: "GIF와 SVG", turns: 1 })
  const at = session.messages.at(-1)!.time.created
  const call = (
    n: number,
    name: string,
    format: "gif" | "svg",
    extra: Record<string, unknown>,
    content: Array<{ type: "file"; uri: string; mime: string; name: string }>,
  ) => ({
    type: "tool" as const,
    id: `call_image_${n}`,
    name: "image_generate",
    state: {
      status: "completed" as const,
      input: { prompt: `a ${format}`, output_format: format },
      content: [{ type: "text" as const, text: "이미지를 만들었어요." }, ...content],
      metadata: {
        ownImage: {
          status: "done",
          model: "gpt-image-2.6-flare",
          route: "key",
          account: "회사 · prod",
          costUSD: 0.0123,
          path: `D:\\work\\own-fixture\\.own\\images\\${name}`,
          format,
          ...extra,
          steps: [{ route: "key", accountID: "acc_work", label: "회사 · prod", outcome: "used" }],
        },
      },
    },
    time: { created: at + 1_200 + n, ran: at + 1_250 + n, completed: at + 4_000 + n },
  })
  session.messages.push(
    { id: `msg_${id.slice(4)}_900001`, type: "user", text: "GIF와 SVG를 만들어 줘", time: { created: at + 1_000 } },
    {
      id: `msg_${id.slice(4)}_900002`,
      type: "assistant",
      agent: "build",
      model: MODEL_A,
      content: [
        call(1, "wave.gif", "gif", { frames: 2, resized: { from: "1024x1024", to: "960x960" }, preview: `data:image/gif;base64,${GIF}` }, [
          { type: "file", uri: IMAGE, mime: "image/png", name: "wave-frame1.png" },
        ]),
        call(
          2,
          "logo.svg",
          "svg",
          {
            preview: `data:image/svg+xml;base64,${btoa(SVG)}`,
            svgAuthor: { model: "gpt-6-luna", input: 1200, output: 800, costUSD: 0.00052 },
          },
          [],
        ),
      ],
      tokens: { input: 1_000, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      finish: "stop",
      time: { created: at + 1_100, streamed: at + 4_000, completed: at + 4_100 },
    } as unknown as SessionMessageAssistant,
  )
  return session
}

/** A short session with a variant change and an undone switch (A→B→A without a step: draws nothing). */
export function buildMarkerSession(id: string): FixtureSession {
  const session = buildSession({ id, title: "전환 표시", turns: 3 })
  const at = session.messages.at(-1)!.time.created
  const variant = { ...MODEL_A, variant: "low" }
  session.messages.push(
    {
      id: `msg_${id.slice(4)}_900001`,
      type: "model-switched",
      model: MODEL_B,
      previous: MODEL_A,
      time: { created: at + 1 },
    },
    {
      id: `msg_${id.slice(4)}_900002`,
      type: "model-switched",
      model: MODEL_A,
      previous: MODEL_B,
      time: { created: at + 2 },
    },
    {
      id: `msg_${id.slice(4)}_900003`,
      type: "model-switched",
      model: variant,
      previous: MODEL_A,
      time: { created: at + 3 },
    },
  )
  return session
}

/**
 * 압축 내용 (UC 2026-10-18): three compactions in one short session. The first is own's checkpoint (the user's own
 * messages put back, recent messages kept) that own made while the user was away from the whole conversation, read
 * from the cache (CC 2026-10-24), the second a provider-native one (an encrypted item only), the third a summary a
 * stand-in model wrote after the main's failed; it is the current one.
 */
export function buildCompactionSession(id: string): FixtureSession {
  const session = buildSession({ id, title: "압축 기록", turns: 7, compactEvery: 2 })
  const first = session.messages.findIndex((message) => message.type === "compaction")
  const native = session.messages.findIndex((message, index) => index > first && message.type === "compaction")
  const last = session.messages.findLastIndex((message) => message.type === "compaction")
  const patch = (index: number, change: Record<string, unknown>) => {
    // SAFETY: fixture compaction messages in the wire shape (completed, with the fields core sets).
    session.messages[index] = { ...session.messages[index], ...change } as SessionMessageInfo
  }
  patch(first, {
    summary: "## 목표\n\n계정 라우터의 전환 비용 추정을 확인한다.\n\n## 한 일\n\n- planner.ts를 읽었다.",
    metadata: {
      // Kept text as checkpoints before upstream v2.1 stored it (later ones keep only `keepID`).
      recent: "<recent-context>\n사용자: 3번째 요청\n</recent-context>",
      "own.harness.codex.userMessages": ["1번째 요청: 계정 라우터…", "2번째 요청: 계정 라우터…"],
      "own.harness.compaction.format": "checkpoint-v1",
      prefix: { request: "full" },
      "own.compaction.cache": { prefix: "full", reason: "warm", ageMs: 1_770_000, ttlMs: 1_800_000 },
      "own.compaction.trigger": "idle",
    },
    tokens: { input: 1_000, output: 2_000, reasoning: 0, cache: { read: 99_000, write: 0 } },
  })
  patch(native, {
    summary: "",
    model: MODEL_B,
    native: {
      messages: [
        { role: "assistant", content: [{ type: "compaction", provider: "openai", encrypted: "gAAAAB".repeat(400) }] },
      ],
    },
  })
  patch(last, {
    summary: "## 목표\n\n전환 비용 추정을 마무리한다.",
    metadata: {
      fallback: {
        failed: `${ACCOUNT_A.providerID}/gpt-5.6-sol`,
        reason: "timeout",
        model: `${ACCOUNT_B.providerID}/gpt-5.5`,
      },
    },
  })
  return session
}

/**
 * SL 2026-10-26, the bug of the day: one conversation switched Claude accounts between turns, AC-03 → AC-01 → AC-02
 * (`claude_rebound reason:user`). Each turn's one step ran cold on its new account (cache 0 %). Then a compaction AC-02
 * signed, and a turn whose first step ran on AC-02 and whose next step an auto switch moved to AC-03. The ledger names
 * each step's and the compaction's account; the conversation is bound to AC-03 now (the harness's `session.binding`).
 */
export function buildClaudeSession(id: string): FixtureSession {
  const messages: SessionMessageInfo[] = []
  const lines: Ledger.Line[] = []
  const [one, two, three] = CLAUDE_ACCOUNTS
  let n = 0
  let time = BASE_TIME
  const next = () => `msg_${id.slice(4)}_${String(n++).padStart(6, "0")}`
  const tick = (ms: number) => (time += ms)
  const step = (accountID: string, text: string, cache: { read: number; write: number }) => {
    const messageID = next()
    const created = tick(400)
    const completed = tick(2_000)
    const tokens = { input: 1_800, output: 240, reasoning: 0, cache }
    messages.push({
      id: messageID,
      type: "assistant",
      agent: "build",
      model: MODEL_CLAUDE,
      content: [{ type: "text", text }],
      tokens,
      cost: 0,
      finish: "stop",
      time: { created, streamed: completed - 100, completed },
    } as SessionMessageAssistant)
    lines.push(claudeLine(ledgerLine(id, messageID, MODEL_CLAUDE, tokens, false, time), accountID))
  }
  const user = (text: string) => messages.push({ id: next(), type: "user", text, time: { created: tick(5_000) } })
  const cold = { read: 0, write: 50_000 }
  user("1번째 요청: 스위처의 계정 표시를 확인해 주세요.")
  step(three.id, "AC-03에서 답했어요.", cold)
  user("2번째 요청: 같은 내용을 다른 계정으로 확인해 주세요.")
  step(one.id, "AC-01에서 답했어요.", cold)
  user("3번째 요청: 한 번 더 다른 계정으로요.")
  step(two.id, "AC-02에서 답했어요.", cold)
  const compaction = next()
  const summarized = { input: 1_000, output: 900, reasoning: 0, cache: { read: 52_000, write: 0 } }
  messages.push({
    id: compaction,
    type: "compaction",
    status: "completed",
    reason: "manual",
    model: MODEL_CLAUDE,
    summary: "## 요약\n\n세 계정에서 같은 내용을 확인했어요.",
    tokens: summarized,
    time: { created: tick(1_000) },
  } as SessionMessageInfo)
  lines.push(claudeLine(ledgerLine(id, compaction, MODEL_CLAUDE, summarized, false, time), two.id, "compaction"))
  user("4번째 요청: 압축한 뒤에 이어서 해 주세요.")
  // After the compaction the same account rewrites its cache; the auto switch's retry then starts AC-03's.
  step(two.id, "AC-02에서 시작했어요.", { read: 0, write: 12_000 })
  step(three.id, "한도 때문에 AC-03에서 이어서 끝냈어요.", { read: 0, write: 12_500 })
  return { id, title: "Claude 계정 셋", messages, lines }
}

type FixtureRef = { readonly providerID: string; readonly id: string; readonly variant?: string }

/**
 * A conversation of turns that each ran one step on a model and an account (`step`: the ledger line names it, a Claude
 * line the Claude account that signed it), with model switches between them (`switch`, as core records them).
 */
export function buildSignedSession(
  id: string,
  title: string,
  parts: ReadonlyArray<readonly ["step", FixtureRef, string] | readonly ["switch", FixtureRef, FixtureRef]>,
): FixtureSession {
  const messages: SessionMessageInfo[] = []
  const lines: Ledger.Line[] = []
  let n = 0
  let time = BASE_TIME
  const next = () => `msg_${id.slice(4)}_${String(n++).padStart(6, "0")}`
  const tick = (ms: number) => (time += ms)
  for (const part of parts) {
    if (part[0] === "switch") {
      messages.push({
        id: next(),
        type: "model-switched",
        model: part[2],
        previous: part[1],
        time: { created: tick(300) },
      })
      continue
    }
    const [, model, accountID] = part
    messages.push({ id: next(), type: "user", text: "이어서 답해 주세요.", time: { created: tick(5_000) } })
    const messageID = next()
    const created = tick(400)
    const completed = tick(2_000)
    const tokens = { input: 1_800, output: 240, reasoning: 0, cache: { read: 0, write: 20_000 } }
    messages.push({
      id: messageID,
      type: "assistant",
      agent: "build",
      model,
      content: [{ type: "text", text: "답했어요." }],
      tokens,
      cost: 0,
      finish: "stop",
      time: { created, streamed: completed - 100, completed },
    } as SessionMessageAssistant)
    const codex = model.providerID === ACCOUNT_A.providerID
    const line = ledgerLine(id, messageID, model, tokens, codex, time)
    lines.push(codex ? line : claudeLine(line, accountID))
  }
  return { id, title, messages, lines }
}

/**
 * SL-8, the switch markers of Claude conversations: the marker named the provider's first Claude account (AC-01) on
 * both sides. `ses_switch`: a turn on AC-03, a switch to ChatGPT (개인 Pro) and a turn there; the harness then switches
 * it back to Claude live, where it is bound to AC-03. `ses_switch_model`: a turn on AC-02, a Claude model switch, a turn
 * on AC-02 again, a second model switch and a turn that ran on AC-03 (the tree had moved there too).
 */
export function buildSwitchSessions(): FixtureSession[] {
  const [, two, three] = CLAUDE_ACCOUNTS
  return [
    buildSignedSession("ses_switch", "Claude에서 ChatGPT로", [
      ["step", MODEL_CLAUDE, three.id],
      ["switch", MODEL_CLAUDE, MODEL_A],
      ["step", MODEL_A, ACCOUNT_A.id],
    ]),
    buildSignedSession("ses_switch_model", "Claude 모델 전환", [
      ["step", MODEL_CLAUDE, two.id],
      ["switch", MODEL_CLAUDE, MODEL_SONNET],
      ["step", MODEL_SONNET, two.id],
      ["switch", MODEL_SONNET, MODEL_CLAUDE],
      ["step", MODEL_CLAUDE, three.id],
    ]),
  ]
}

/** A line the router writes for the Claude slot: signed by `accountID` (G4), no price (02 §5.4.1(d)). */
function claudeLine(line: Ledger.Line, accountID: string, kind: "primary" | "compaction" = "primary") {
  // SAFETY: the fixture line with the slot's fields (branded ids are plain strings at runtime).
  return { ...line, accountID, kind, cost: null, costUSDOpenCode: 0 } as unknown as Ledger.Line
}

function tool(
  callID: string,
  name: string,
  args: Record<string, string>,
  output: string,
  time: number,
): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: callID,
    name,
    state: { status: "completed", input: args, content: [{ type: "text", text: output }], metadata: {} },
    time: { created: time, ran: time + 50, completed: time + 300 },
  }
}

function ledgerLine(
  sessionID: string,
  messageID: string,
  model: { providerID: string; id: string; variant?: string },
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  codex: boolean,
  ts: number,
): Ledger.Line {
  const cost = codex
    ? {
        unit: "credits" as const,
        amount: (tokens.input * 0.9 + tokens.cache.read * 0.09 + tokens.output * 7) / 1e4,
        source: "ratecard" as const,
      }
    : {
        unit: "USD" as const,
        amount: (tokens.input * 1.25 + tokens.cache.read * 0.125 + (tokens.output + tokens.reasoning) * 10) / 1e6,
        source: "opencode" as const,
      }
  // SAFETY: fixture data in the shape of the schema's decoded type (branded ids are plain strings at runtime).
  return {
    v: 1,
    ts,
    sessionID,
    messageID,
    kind: "primary",
    accountID: codex ? ACCOUNT_A.id : ACCOUNT_B.id,
    providerID: model.providerID,
    modelID: model.id,
    variant: model.variant ?? null,
    credentialRef: null,
    transport: null,
    switchEpoch: 0,
    compactionEpoch: 0,
    tokens: {
      input: tokens.input,
      cacheRead: tokens.cache.read,
      cacheWrite: tokens.cache.write,
      cacheWrite1h: null,
      output: tokens.output,
      reasoning: tokens.reasoning,
    },
    P: tokens.input + tokens.cache.read,
    hit: tokens.cache.read / (tokens.input + tokens.cache.read),
    cost,
    costUSDOpenCode: codex ? 0 : cost.amount,
    coldExpected: null,
  } as unknown as Ledger.Line
}
