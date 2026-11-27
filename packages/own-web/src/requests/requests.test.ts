import { describe, expect, test } from "bun:test"
import type { FormInfo } from "@opencode/client"
import { createRoot } from "solid-js"
import { chosenRules, createModeChoice, modeLabel } from "./approval"
import { agentPath, alwaysScope, fetchDetail, filePreviews, folds, formFlavor, patchLines, PATCH_LINES, quoted } from "./describe"
import { activeFields, buildAnswer, initialDraft, problems, valueOf, type Draft } from "./form-model"
import { createMerger, describeRequest, rootOf, shouldNotify } from "./notify"
import { requestsKo, requestsText } from "./strings"

const text = (key: keyof typeof requestsKo, params?: Record<string, string | number>) => requestsText("ko", key, params)

describe("describe", () => {
  test("always-allow scope follows the request's save patterns", () => {
    expect(alwaysScope({ action: "shell", save: ["bun test *", "bun test *"] })).toEqual({
      kind: "shell",
      patterns: ["bun test *"],
    })
    expect(alwaysScope({ action: "edit", save: ["*"] })).toEqual({ kind: "all" })
    expect(alwaysScope({ action: "external_directory", save: ["C:/work/*"] })).toEqual({
      kind: "patterns",
      patterns: ["C:/work/*"],
    })
    // Without save patterns core answers "always" like "once" (permission.ts:295).
    expect(alwaysScope({ action: "question", save: undefined })).toEqual({ kind: "none" })
    expect(quoted(["bun test *", "git status *"])).toBe('"bun test *", "git status *"')
  })

  test("scope text matches the 03 §18.1 example", () => {
    expect(text("own.requests.always.shell", { patterns: quoted(["bun test*"]) })).toBe(
      '이 프로젝트에서 "bun test*" 명령은 다시 묻지 않아요',
    )
    expect(text("own.requests.always.all", { noun: text("own.requests.noun.edit") })).toBe(
      "이 프로젝트에서 파일 편집은 다시 묻지 않아요",
    )
    expect(text("own.requests.always.all", { noun: text("own.requests.noun.webfetch") })).toBe(
      "이 프로젝트에서 웹 페이지 가져오기는 다시 묻지 않아요",
    )
  })

  test("a Code Mode fetch's card names the headers it sends and the body's size (P-049)", () => {
    expect(
      fetchDetail({ metadata: { method: "POST", url: "https://x", headers: ["Authorization", 3], bodyBytes: 1200 } }),
    ).toEqual({ method: "POST", headers: ["Authorization"], bytes: 1200 })
    expect(fetchDetail({ metadata: { method: "GET", url: "https://x" } })).toBeUndefined()
    // Any other method is named even without headers or a body.
    expect(fetchDetail({ metadata: { method: "DELETE", url: "https://x" } })).toEqual({
      method: "DELETE",
      headers: [],
      bytes: undefined,
    })
    // The webfetch tool's own request (url, format, timeout) adds nothing.
    expect(fetchDetail({ metadata: { url: "https://x", format: "markdown" } })).toBeUndefined()
    expect(text("own.requests.fetchHeaders", { names: "Authorization, X-Trace" })).toBe(
      "보내는 헤더: Authorization, X-Trace",
    )
  })

  test("edit previews are validated once and bad entries dropped", () => {
    expect(
      filePreviews({
        metadata: {
          files: [
            { file: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified" },
            { patch: "no file" },
            "junk",
          ],
        },
      }),
    ).toEqual([{ file: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1 }])
    expect(filePreviews({ metadata: { files: "nope" } })).toEqual([])
    expect(filePreviews({})).toEqual([])
  })

  test("patch preview drops headers and caps the lines", () => {
    const patch = ["Index: a", "===", "--- a", "+++ b", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n")
    expect(patchLines(patch)).toEqual({ shown: ["@@ -1,2 +1,2 @@", " keep", "-old", "+new"], hidden: 0 })
    const long = ["@@ -1 +1 @@", ...Array.from({ length: PATCH_LINES + 5 }, (_, index) => `+${index}`)].join("\n")
    expect(patchLines(long).shown).toHaveLength(PATCH_LINES)
    expect(patchLines(long).hidden).toBe(6)
  })

  test("long commands fold", () => {
    expect(folds("bun test")).toBe(false)
    expect(folds("a\nb\nc\nd\ne")).toBe(true)
    expect(folds("x".repeat(400))).toBe(true)
  })

  test("agent path from the open session down to the asking subagent", () => {
    const sessions: Record<string, { parentID?: string; agent?: string; title?: string }> = {
      root: {},
      child: { parentID: "root", agent: "explore" },
      grandchild: { parentID: "child", title: "검색 (@general subagent)" },
    }
    const get = (id: string) => sessions[id]
    expect(agentPath("root", "root", get)).toEqual([])
    expect(agentPath("root", "child", get)).toEqual(["explore"])
    expect(agentPath("root", "grandchild", get)).toEqual(["explore", "검색 (@general subagent)"])
    expect(agentPath("child", "grandchild", get)).toEqual(["검색 (@general subagent)"])
  })
})

const question: FormInfo = {
  id: "frm_q",
  sessionID: "ses_1",
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg", id: "call" } },
  fields: [
    {
      key: "q0",
      title: "DB",
      description: "어떤 DB를 쓸까요?",
      type: "string",
      options: [
        { value: "SQLite", label: "SQLite" },
        { value: "Postgres", label: "Postgres" },
      ],
      custom: true,
    },
    {
      key: "q1",
      title: "기능",
      description: "무엇을 켤까요?",
      type: "multiselect",
      options: [
        { value: "A", label: "A" },
        { value: "B", label: "B" },
      ],
      custom: true,
    },
  ],
}

function withDraft(draft: Draft, patch: Partial<{ [K in keyof Draft]: Record<string, unknown> }>): Draft {
  return {
    values: { ...draft.values, ...(patch.values as Draft["values"]) },
    picked: { ...draft.picked, ...(patch.picked as Draft["picked"]) },
    custom: { ...draft.custom, ...(patch.custom as Draft["custom"]) },
    customOn: { ...draft.customOn, ...(patch.customOn as Draft["customOn"]) },
  }
}

describe("form model", () => {
  test("flavors by metadata kind", () => {
    expect(formFlavor(question)).toBe("question")
    expect(formFlavor({ metadata: { kind: "websearch.provider" } })).toBe("websearch")
    expect(formFlavor({ metadata: { kind: "mcp-elicitation", server: "linear" } })).toBe("mcp")
    expect(formFlavor({})).toBe("form")
  })

  test("question answers: picked option, custom text, multi with custom", () => {
    const empty = initialDraft(question)
    expect(buildAnswer(question, empty)).toEqual({})
    const answered = withDraft(empty, {
      values: { q0: "Postgres" },
      picked: { q1: ["B"] },
      custom: { q1: "  C  " },
      customOn: { q1: true },
    })
    expect(buildAnswer(question, answered)).toEqual({ q0: "Postgres", q1: ["B", "C"] })
    const custom = withDraft(answered, { customOn: { q0: true }, custom: { q0: "DuckDB" } })
    expect(valueOf(question.fields[0]!, custom)).toBe("DuckDB")
  })

  test("defaults fill the draft, unknown defaults become the custom answer", () => {
    const form: FormInfo = {
      ...question,
      fields: [
        { key: "a", type: "string", options: [{ value: "x", label: "X" }], custom: true, default: "y" },
        { key: "b", type: "boolean", default: true },
        { key: "c", type: "number", default: 3 },
        { key: "d", type: "multiselect", options: [{ value: "m", label: "M" }], default: ["m", "n"], custom: true },
      ],
    }
    const draft = initialDraft(form)
    expect(buildAnswer(form, draft)).toEqual({ a: "y", b: true, c: 3, d: ["m", "n"] })
  })

  test("when conditions, hidden fields and requirements", () => {
    const form: FormInfo = {
      id: "frm_mcp",
      sessionID: "global",
      title: "linear is requesting input",
      metadata: { kind: "mcp-elicitation", server: "linear", message: "Pick a team" },
      fields: [
        {
          key: "mode",
          type: "string",
          options: [
            { value: "new", label: "New" },
            { value: "old", label: "Old" },
          ],
          required: true,
        },
        { key: "name", type: "string", required: true, when: [{ key: "mode", op: "eq", value: "new" }], minLength: 2 },
        {
          key: "tags",
          type: "multiselect",
          options: [{ value: "t", label: "T" }],
          minItems: 1,
          when: [{ key: "mode", op: "neq", value: "new" }],
        },
        { key: "count", type: "integer", minimum: 1, maximum: 5 },
        { key: "secret", type: "string", hidden: true, default: "kept by the server" },
      ],
    }
    const draft = initialDraft(form)
    // Unanswered `mode`: both conditions are false, the hidden field never shows.
    expect(activeFields(form, draft).map((field) => field.key)).toEqual(["mode", "count"])
    expect(problems(form, draft)).toEqual({ mode: "required" })

    const fresh = withDraft(draft, { values: { mode: "new", name: "x", count: 9 } })
    expect(activeFields(form, fresh).map((field) => field.key)).toEqual(["mode", "name", "count"])
    expect(problems(form, fresh)).toEqual({ name: "length", count: "range" })

    const ok = withDraft(fresh, { values: { name: "팀 이름", count: 2.5 } })
    expect(problems(form, ok)).toEqual({ count: "integer" })
    const done = withDraft(ok, { values: { count: 2 } })
    expect(problems(form, done)).toEqual({})
    expect(buildAnswer(form, done)).toEqual({ mode: "new", name: "팀 이름", count: 2 })

    const old = withDraft(draft, { values: { mode: "old" } })
    expect(activeFields(form, old).map((field) => field.key)).toEqual(["mode", "tags", "count"])
    expect(problems(form, old)).toEqual({})
    expect(problems(form, withDraft(old, { picked: { tags: [] } }))).toEqual({})
  })

  test("external fields are confirmed by sending", () => {
    const form: FormInfo = {
      id: "frm_url",
      sessionID: "global",
      title: "x",
      metadata: { kind: "mcp-elicitation", server: "s" },
      fields: [{ key: "elicitation", type: "external", url: "https://example.test/auth" }],
    }
    expect(buildAnswer(form, initialDraft(form))).toEqual({ elicitation: true })
  })
})

describe("approval", () => {
  test("pill label per router state (03 §4.4, §5.1)", () => {
    expect(modeLabel({ status: "loading" })).toBeUndefined()
    expect(modeLabel({ status: "unavailable" })).toBe("default")
    expect(modeLabel({ status: "ready", mode: "full", rules: 5, children: 0 })).toBe("full")
    expect(modeLabel({ status: "ready", mode: "custom", rules: 0, children: 0 })).toBe("default")
    expect(modeLabel({ status: "ready", mode: "custom", rules: 3, children: 0 })).toBe("custom")
    // The browser plugin's attachment allow alone is still core's default.
    const attach = { action: "browser", resource: "*", effect: "allow" } as const
    expect(chosenRules([attach])).toBe(0)
    expect(chosenRules([{ action: "edit", resource: "**", effect: "ask" }, attach])).toBe(1)
  })

  test("full access needs one confirmation; the others apply at once", () => {
    createRoot((dispose) => {
      const applied: string[] = []
      const choice = createModeChoice((mode) => void applied.push(mode))
      choice.choose("read-only")
      expect(applied).toEqual(["read-only"])
      choice.choose("full")
      expect(choice.confirming()).toBe(true)
      expect(applied).toEqual(["read-only"])
      choice.cancel()
      expect(choice.confirming()).toBe(false)
      choice.choose("full")
      choice.confirm()
      expect(applied).toEqual(["read-only", "full"])
      expect(choice.confirming()).toBe(false)
      dispose()
    })
  })
})

describe("notifications", () => {
  test("only when the window is hidden or unfocused and the host can notify", () => {
    const base = { capability: "web" as const, available: true, hidden: false, focused: true }
    expect(shouldNotify(base)).toBe(false)
    expect(shouldNotify({ ...base, focused: false })).toBe(true)
    expect(shouldNotify({ ...base, hidden: true })).toBe(true)
    expect(shouldNotify({ ...base, hidden: true, capability: "none" })).toBe(false)
    expect(shouldNotify({ ...base, hidden: true, available: false })).toBe(false)
  })

  test("same session within 10 s merges", () => {
    let now = 1_000
    const merge = createMerger(10_000, () => now)
    expect(merge("local:ses_a")).toBe(true)
    now += 5_000
    expect(merge("local:ses_a")).toBe(false)
    expect(merge("local:ses_b")).toBe(true)
    now += 5_001
    expect(merge("local:ses_a")).toBe(true)
  })

  test("a subagent's request opens the top session", () => {
    const parents: Record<string, string | undefined> = { c2: "c1", c1: "root", root: undefined }
    expect(rootOf("c2", (id) => parents[id])).toBe("root")
    expect(rootOf("root", (id) => parents[id])).toBe("root")
    const loop: Record<string, string> = { a: "b", b: "a" }
    expect(["a", "b"]).toContain(rootOf("a", (id) => loop[id]))
  })

  test("body names what is asked", () => {
    const t = (key: Parameters<typeof requestsText>[1], params?: Record<string, string | number>) =>
      requestsText("ko", key, params)
    expect(describeRequest(t, { permission: { action: "shell" } })).toBe("셸 명령")
    expect(describeRequest(t, { permission: { action: "skill" } })).toBe("skill 요청")
    expect(describeRequest(t, { form: { metadata: { kind: "mcp-elicitation", server: "linear" } } })).toBe(
      'MCP 서버 "linear"의 요청',
    )
    expect(describeRequest(t, { form: { metadata: { kind: "question" } } })).toBe("질문")
  })
})

describe("strings", () => {
  test("English covers the Korean keys that carry words", () => {
    const missing = Object.keys(requestsKo).filter(
      (key) => requestsText("en", key as keyof typeof requestsKo) === requestsKo[key as keyof typeof requestsKo],
    )
    // Only symbol-only templates may fall back to Korean.
    expect(missing.filter((key) => /[가-힣]/.test(requestsKo[key as keyof typeof requestsKo]))).toEqual([])
  })
})
