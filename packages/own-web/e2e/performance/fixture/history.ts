// Deterministic transcript fixtures for the performance harness (03 §20.1 PF3: 2,000 messages, 40% with tool
// cards). Messages use the public `SessionMessage.Info` encoding accepted by `POST /api/experimental/session/import`,
// so the real server stores and pages them exactly like a recorded session.
//
// Every message carries a plain-text marker (`OWNB-<tag>-<turn>-U|R`) that survives Markdown rendering. Benchmarks
// find content by marker text instead of by transcript DOM attributes, so the probes work with whatever row
// structure the transcript module renders.

export interface ModelRef {
  readonly id: string
  readonly providerID: string
}

export interface HistoryOptions {
  /** One or more letters; part of every marker and id. */
  readonly tag: string
  /** User/assistant exchanges; messages = 2 × turns. */
  readonly turns: number
  readonly model: ModelRef
  /** Fraction of all messages that carry at least one tool card (03: 0.4). */
  readonly toolShare?: number
  /** Creation time of the first message (ms since epoch). */
  readonly startMs?: number
}

export interface HistoryStats {
  readonly messages: number
  readonly userMessages: number
  readonly assistantMessages: number
  readonly messagesWithTools: number
  readonly toolCards: number
  readonly reasoningParts: number
  readonly codeBlocks: number
  readonly tables: number
  readonly bytes: number
}

export type EncodedMessage = Record<string, unknown> & { readonly id: string; readonly type: string }

const DEFAULT_START = Date.UTC(2026, 5, 1, 0, 0, 0)
const TURN_MS = 60_000

export function marker(tag: string, turn: number, role: "U" | "R") {
  return `OWNB-${tag}-${String(turn).padStart(4, "0")}-${role}`
}

/** Marker of the final assistant answer: visible means the session is scrolled to its end. */
export function lastMarker(tag: string, turns: number) {
  return marker(tag, turns - 1, "R")
}

/** Marker of the first user prompt: visible means the whole history was paged in and scrolled to the top. */
export function firstMarker(tag: string) {
  return marker(tag, 0, "U")
}

/** Ids in the server's own layout (`packages/schema/src/identifier.ts`): 12 hex of time·4096+n, then 14 chars. */
export function identifier(prefix: string, timestamp: number, counter: number, seed: string, descending = false) {
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const suffix = Array.from({ length: 14 }, (_, index) => {
    const code = seed.charCodeAt(index % seed.length) + index * 7 + counter * 13
    return chars[code % 62]
  }).join("")
  return `${prefix}_${time}${suffix}`
}

export function sessionID(tag: string, timestamp = DEFAULT_START) {
  return identifier("ses", timestamp, tag.charCodeAt(0), `bench${tag}`, true)
}

export function buildHistory(options: HistoryOptions) {
  const start = options.startMs ?? DEFAULT_START
  const toolShare = options.toolShare ?? 0.4
  // Tool cards live on assistant messages: share of all messages → share of assistant messages.
  const assistantToolShare = Math.min(1, toolShare * 2)
  const stats = {
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    messagesWithTools: 0,
    toolCards: 0,
    reasoningParts: 0,
    codeBlocks: 0,
    tables: 0,
    bytes: 0,
  }
  const messages = Array.from({ length: options.turns }, (_, turn) => {
    const created = start + turn * TURN_MS
    const withTools = spread(turn, assistantToolShare)
    const tools = withTools ? toolCards(options.tag, turn, created) : []
    const reasoning = turn % 5 === 2
    const markdown = answerMarkdown(options.tag, turn)
    stats.userMessages++
    stats.assistantMessages++
    stats.messagesWithTools += withTools ? 1 : 0
    stats.toolCards += tools.length
    stats.reasoningParts += reasoning ? 1 : 0
    stats.codeBlocks += markdown.codeBlocks
    stats.tables += markdown.tables
    const user: EncodedMessage = {
      id: identifier("msg", created, 1, `${options.tag}u${turn}`),
      type: "user",
      time: { created },
      text: userPrompt(options.tag, turn),
    }
    const assistant: EncodedMessage = {
      id: identifier("msg", created + 1_000, 2, `${options.tag}a${turn}`),
      type: "assistant",
      agent: "build",
      model: { id: options.model.id, providerID: options.model.providerID },
      content: [
        ...(reasoning
          ? [
              {
                type: "reasoning",
                text: `요청 범위를 확인하고 기존 구현과 테스트를 먼저 읽습니다. ${"제약 조건 분석 ".repeat(12)}`,
                time: { created: created + 1_100, completed: created + 1_900 },
              },
            ]
          : []),
        ...tools,
        { type: "text", text: markdown.text },
      ],
      finish: "stop",
      cost: 0.0123,
      tokens: { input: 1_800 + turn, output: 420, reasoning: reasoning ? 90 : 0, cache: { read: 1_500, write: 0 } },
      time: { created: created + 1_000, streamed: created + 20_000, completed: created + 21_000 },
    }
    return [user, assistant]
  }).flat()
  stats.messages = messages.length
  stats.bytes = Buffer.byteLength(JSON.stringify(messages))
  return { messages, stats: stats satisfies HistoryStats }
}

/** Evenly spreads `share` of the indexes (Bresenham), so any window of the history has the same mix. */
function spread(index: number, share: number) {
  return Math.floor((index + 1) * share) > Math.floor(index * share)
}

function userPrompt(tag: string, turn: number) {
  const asks = [
    "세션 목록 행이 스트리밍 중에도 흔들리지 않게 고쳐 주세요.",
    "결제 웹훅 재시도 정책을 검토하고 테스트를 추가해 주세요.",
    "계정 전환 뒤 캐시 적중률이 떨어지는 원인을 찾아 주세요.",
    "Refactor the request retry helper and keep the public API stable.",
  ]
  return `${asks[turn % asks.length]} (${marker(tag, turn, "U")})`
}

function answerMarkdown(tag: string, turn: number) {
  const table = turn % 3 === 0
  const code = turn % 4 === 0
  const text = [
    `## 검토 ${turn + 1}: 세션 렌더러`,
    "",
    `변경은 **행 identity를 유지**한 채 측정된 높이만 다시 맞춥니다. [Solid 문서](https://docs.solidjs.com/)와 \`measureElement(node)\` 호출을 참고했습니다. ${marker(tag, turn, "R")}`,
    "",
    ...(table
      ? [
          "| 항목 | 현재 동작 | 확인 방법 |",
          "| --- | --- | --- |",
          "| 스트리밍 | Markdown 블록을 이어 붙임 | 표시된 프레임 |",
          "| 위치 | 보이는 행을 기준으로 고정 | DOM 좌표 |",
          "| 도구 | 펼침 상태 유지 | keyed remount 탐침 |",
          "",
        ]
      : []),
    "> 긴 세션은 Markdown, 구문 강조, 도구 출력, 비동기 diff가 한 화면에 섞입니다.",
    "",
    ...(code
      ? [
          "```tsx",
          'import { For, createSignal } from "solid-js"',
          "",
          "type Row = { id: string; title: string; active: boolean }",
          "",
          "export function SessionList(props: { rows: Row[] }) {",
          "  const [selected, setSelected] = createSignal<string>()",
          "  return (",
          '    <section aria-label="Sessions">',
          "      <For each={props.rows}>{(row) => (",
          "        <button classList={{ active: row.active }} onClick={() => setSelected(row.id)}>{row.title}</button>",
          "      )}</For>",
          "    </section>",
          "  )",
          "}",
          "```",
          "",
        ]
      : [
          "- 보이는 행의 기준점을 유지합니다",
          "- 안정된 Markdown 노드를 교체하지 않습니다",
          "- 입력을 막지 않고 delta를 처리합니다",
          "",
        ]),
    `검증: \`bun typecheck\` 통과, 관련 테스트 ${(turn % 7) + 3}개 추가.`,
  ].join("\n")
  return { text, codeBlocks: code ? 1 : 0, tables: table ? 1 : 0 }
}

function toolCards(tag: string, turn: number, created: number) {
  const count = 1 + (turn % 3)
  const names = ["read", "grep", "bash", "edit"] as const
  return Array.from({ length: count }, (_, index) => {
    const name = names[(turn + index) % names.length]!
    const at = created + 2_000 + index * 1_000
    const path = `src/session/module-${(turn * 3 + index) % 97}.ts`
    const base = {
      type: "tool",
      id: `call_${tag}_${turn}_${index}`,
      name,
      time: { created: at, ran: at + 50, completed: at + 400 },
    }
    if (name === "read")
      return {
        ...base,
        state: { status: "completed", input: { path }, content: [{ type: "text", text: source(turn, index) }] },
      }
    if (name === "grep")
      return {
        ...base,
        state: {
          status: "completed",
          input: { pattern: "createMemo", path: "src" },
          content: [
            {
              type: "text",
              text: Array.from(
                { length: 12 },
                (_, line) => `src/session/module-${line}.ts:${line * 7 + 3}: createMemo(() =>`,
              ).join("\n"),
            },
          ],
        },
      }
    if (name === "bash")
      return {
        ...base,
        state: {
          status: "completed",
          input: { command: "bun test ./src/session", description: "세션 테스트 실행" },
          content: [
            {
              type: "text",
              text: [
                "bun test v1.4.2",
                ...Array.from(
                  { length: 10 },
                  (_, line) => `✓ session > timeline row ${line} keeps identity [${line + 1}.02ms]`,
                ),
                "",
                " 10 pass",
                " 0 fail",
              ].join("\n"),
            },
          ],
          metadata: { exit: 0 },
        },
      }
    return {
      ...base,
      state: {
        status: "completed",
        input: { path, oldString: "toUpperCase()", newString: "toLocaleUpperCase(props.locale)" },
        content: [{ type: "text", text: `Edited ${path}` }],
        metadata: {
          files: [
            {
              file: path,
              additions: 2,
              deletions: 1,
              status: "modified",
              patch: [
                `--- a/${path}`,
                `+++ b/${path}`,
                "@@ -10,4 +10,5 @@",
                " export function Title(props: { title: string; locale: string }) {",
                "-  return <h2>{props.title.toUpperCase()}</h2>",
                "+  const title = props.title.toLocaleUpperCase(props.locale)",
                "+  return <h2>{title}</h2>",
                " }",
              ].join("\n"),
            },
          ],
        },
      },
    }
  })
}

function source(turn: number, index: number) {
  return [
    'import { createMemo, For } from "solid-js"',
    "",
    "type Message = { id: string; role: 'user' | 'assistant'; text: string; tokens: { output: number } }",
    "",
    `export function MessageSummary${index}(props: { messages: Message[]; locale: string }) {`,
    `  const visible = createMemo(() => props.messages.filter((message) => message.text.trim()).slice(-${20 + (turn % 5)}))`,
    "  const total = createMemo(() => visible().reduce((sum, message) => sum + message.tokens.output, 0))",
    "  return (",
    `    <article data-session-index="${turn}">`,
    "      <header>{total().toLocaleString(props.locale)} output tokens</header>",
    "      <For each={visible()}>{(message) => <p data-role={message.role}>{message.text}</p>}</For>",
    "    </article>",
    "  )",
    "}",
  ].join("\n")
}

/**
 * Text for a streamed answer: `deltas` fragments of mixed Markdown (paragraphs, tables, fenced code) with a
 * `stream-<n>` marker every few fragments, `startMarker` in the first fragment and `doneMarker` in the last. With
 * `tag`, every section heading also carries a fixture marker of that tag (`OWNB-<tag>-9<nnn>-R`), so a probe finds
 * a streaming session's text anywhere in a long answer.
 */
export function streamFragments(deltas: number, startMarker: string, doneMarker: string, tag?: string) {
  const fragments = [
    " 스트리밍 응답은",
    " 프레임마다 한 번만",
    " 반영되어야 합니다",
    "**. <!-- stream-{n} -->\n\n",
    "| 항목 | 상태",
    " | 확인 |\n|",
    " --- | ---",
    " | --- |\n|",
    " markdown | 증분 |",
    " 표시 프레임 |\n\n",
    "```ts\nconst row = rows[index]",
    " ?? fallback\nconst title =",
    " row.title.toLocaleUpperCase(locale)\n",
    "// stream-{n}\n```\n\n",
    "### 단계 {section}\n\n계속해서 **굵은 분석",
  ]
  return Array.from({ length: deltas }, (_, index) => {
    if (index === 0) return `## 구현 계획 ${startMarker}\n\n스트리밍 **굵은 분석`
    if (index === deltas - 1) return `\n\n## 검증\n\n- 타입 검사: 통과\n- 스트리밍: 완료 ${doneMarker}\n`
    const section = Math.floor(index / fragments.length) + 1
    return fragments[(index - 1) % fragments.length]!.replaceAll("{n}", String(index)).replaceAll(
      "{section}",
      tag ? `${section} OWNB-${tag}-${9000 + (section % 1000)}-R` : String(section),
    )
  })
}
