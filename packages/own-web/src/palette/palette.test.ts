import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_KEYMAP, type Keymap, type ShortcutID } from "@/keyboard/keymap"
import { auditKeymap, browserDefault, checkChord } from "./audit"
import { translate } from "@/i18n"
import { SECTION_WORDS } from "./builtin"
import { matchCandidate, matchTerm, parseQuery, prepare } from "./fuzzy"
import {
  effectiveKeymap,
  KEYMAP_STORAGE_KEY,
  keymapOverrides,
  mergeKeymap,
  onKeymapChange,
  parseOverrides,
  resetAllChords,
  resetChords,
  setChords,
} from "./keymap-store"
import { prepareEntries, rankRows, type Row } from "./rank"
import { createRebindableRegistry } from "./rebindable"
import { recentCommands, rememberCommand } from "./recent"
import { paletteSources, registerPaletteSource, type PaletteCommand, type PaletteGroup } from "./registry"
import { hasShortcutHandler, runShortcut } from "./run-shortcut"
import { paletteText } from "./strings"

afterEach(() => {
  resetAllChords()
  localStorage.clear()
})

const matches = (query: string, text: string) => !!matchCandidate(parseQuery(query), { title: prepare(text) })

describe("fuzzy search", () => {
  test("words match in order, anywhere in the text, case-insensitive", () => {
    expect(matches("nt", "New terminal")).toBe(true)
    expect(matches("term new", "New terminal")).toBe(true)
    expect(matches("gt", "Settings")).toBe(false)
    expect(matches("xyz", "New terminal")).toBe(false)
  })

  test("word starts and runs score higher than scattered letters", () => {
    const query = parseQuery("set")[0]!
    const start = matchTerm(query, prepare("Settings: General"))!
    const scattered = matchTerm(query, prepare("Session export tool"))!
    expect(start.score).toBeGreaterThan(scattered.score)
    expect(start.positions).toEqual([0, 1, 2])
  })

  test("Korean initial consonants find syllables (ㅌㅁㄴ → 터미널)", () => {
    expect(matches("ㅌㅁㄴ", "작업 패널: 터미널")).toBe(true)
    expect(matches("ㅅㅅ", "새 세션")).toBe(true)
    expect(matches("ㅌㅁㄴ", "터널")).toBe(false)
  })

  test("the syllable an IME is still composing keeps the target listed (03 §12 test 11)", () => {
    // Typing 새 세션: … 새 ㅅ → 새 세 → 새 셋 (final ㅅ, becomes the next initial) → 새 세셔 → 새 세션
    for (const step of ["새 ㅅ", "새 세", "새 셋", "새 세ㅅ", "새 세셔", "새 세션"])
      expect(matches(step, "새 세션")).toBe(true)
    // A composing double final: 닭 while typing 달걀 (ㄺ = ㄹ + the next initial ㄱ).
    expect(matches("닭", "달걀")).toBe(true)
    // Only the last syllable is treated as unfinished.
    expect(matches("셋 새", "새 세션")).toBe(false)
  })

  test("hidden keywords and details match with a lower weight than the title", () => {
    const candidate = { title: prepare("작업 패널: 터미널"), keywords: prepare("Work panel: Terminal · terminal") }
    const byKeyword = matchCandidate(parseQuery("terminal"), candidate)!
    const byTitle = matchCandidate(parseQuery("terminal"), { title: prepare("Terminal") })!
    expect(byKeyword.score).toBeGreaterThan(0)
    expect(byTitle.score).toBeGreaterThan(byKeyword.score)
    // Keyword hits are not highlighted in the title.
    expect(byKeyword.positions).toEqual([])
  })
})

function command(id: string, title: string, group: PaletteGroup, extra: Partial<PaletteCommand> = {}): PaletteCommand {
  return { id, title, group, run: () => undefined, ...extra }
}

const itemIDs = (rows: readonly Row[]) => rows.flatMap((row) => (row.kind === "item" ? [row.command.id] : []))
const headers = (rows: readonly Row[]) => rows.flatMap((row) => (row.kind === "header" ? [row.group] : []))

describe("ranking", () => {
  const commands = [
    command("theme:light", "테마: 밝게", "view", { keywords: ["Theme: Light"] }),
    command("panel.terminal", "작업 패널: 터미널", "panel", { keywords: ["Work panel: Terminal"] }),
    command("terminal.new", "새 터미널", "terminal", { keywords: ["New terminal"] }),
    command("switcher.open", "모델 @ 계정 전환…", "model"),
    ...Array.from({ length: 12 }, (_, index) => command(`session:local/s${index}`, `세션 ${index}`, "session")),
    command("session:local/term", "터미널 고치기", "session"),
  ]
  const entries = prepareEntries(commands)

  test("nothing typed: recent first, then the groups in order with headers; sessions capped", () => {
    const rows = rankRows(entries, "", { recent: ["terminal.new", "unknown", "session:local/s3"] })
    expect(headers(rows)).toEqual(["recent", "session", "model", "panel", "view"])
    const ids = itemIDs(rows)
    expect(ids[0]).toBe("terminal.new")
    // A recent command is not repeated in its own group; sessions are never in "recent".
    expect(ids.filter((id) => id === "terminal.new")).toHaveLength(1)
    expect(ids.filter((id) => id.startsWith("session:"))).toHaveLength(8)
  })

  test("a query gives one flat list by score, commands before equally good sessions, recent boosted", () => {
    const rows = rankRows(entries, "터미널", { recent: [] })
    expect(headers(rows)).toEqual([])
    const ids = itemIDs(rows)
    expect(ids.slice(0, 2)).toEqual(["terminal.new", "panel.terminal"])
    expect(ids).toContain("session:local/term")
    const boosted = itemIDs(rankRows(entries, "터미널", { recent: ["panel.terminal"] }))
    expect(boosted[0]).toBe("panel.terminal")
  })

  test("English keywords find Korean titles, initials work, duplicate ids keep the first", () => {
    expect(itemIDs(rankRows(entries, "new term", { recent: [] }))[0]).toBe("terminal.new")
    expect(itemIDs(rankRows(entries, "ㅁㄷ ㄱㅈ", { recent: [] }))).toEqual(["switcher.open"])
    const twice = prepareEntries([command("a", "하나", "view"), command("a", "둘", "view")])
    expect(twice.map((entry) => entry.command.title)).toEqual(["하나"])
  })
})

describe("shortcut audit (03 §10, [gap] 32)", () => {
  test("the default keymap passes: no issue and every upstream decision kept (Windows and macOS)", () => {
    for (const mac of [false, true]) {
      const audit = auditKeymap(DEFAULT_KEYMAP, { mac })
      expect(audit.issues).toEqual([])
      expect(audit.decisions.every((decision) => decision.kept)).toBe(true)
      expect(audit.decisions.map((decision) => decision.id)).toEqual([
        "sidebar",
        "switcher",
        "selection",
        "approval",
        "window",
        "newSession",
      ])
    }
  })

  test("chords the browser, the OS, the IME, zoom and text editing keep are refused", () => {
    const check = (id: ShortcutID, chord: string, options = {}) => checkChord(DEFAULT_KEYMAP, id, chord, options)?.kind
    expect(check("panel.toggle", "Mod+KeyW")).toBe("browser")
    expect(check("panel.toggle", "Mod+KeyQ", { mac: true })).toBe("browser")
    // Not the browser's on Windows: there it is 완전 종료's (05 §7.3).
    expect(check("panel.toggle", "Mod+KeyQ")).toBe("conflict")
    expect(check("panel.toggle", "Mod+Space")).toBe("ime")
    expect(check("panel.toggle", "Shift+Space")).toBe("ime")
    expect(check("panel.toggle", "Lang1")).toBe("ime")
    expect(check("panel.toggle", "Mod+Equal")).toBe("zoom")
    expect(check("zoom.in", "Mod+Equal")).toBeUndefined()
    expect(check("panel.toggle", "Mod+KeyC")).toBe("editing")
    expect(check("panel.toggle", "KeyA")).toBe("modifier")
    expect(check("panel.toggle", "Shift+KeyA")).toBe("modifier")
    expect(check("session.info", "F2")).toBeUndefined()
    expect(check("panel.toggle", "ControlLeft")).toBe("empty")
    expect(check("panel.toggle", "Mod+KeyJ", { win: true })).toBe("win")
  })

  test("keys focused surfaces handle: composer send/queue, Esc, terminal copy for ids live in terminals", () => {
    expect(checkChord(DEFAULT_KEYMAP, "session.info", "Mod+Enter")).toEqual({
      kind: "composer",
      where: "own.keys.where.composerQueue",
    })
    // 03 §4.6 보내는 키: Alt+Enter is the other delivery when Ctrl+Enter sends; reserved in both choices.
    expect(checkChord(DEFAULT_KEYMAP, "session.info", "Alt+Enter")).toEqual({
      kind: "composer",
      where: "own.keys.where.composerOther",
    })
    expect(checkChord(DEFAULT_KEYMAP, "session.info", "Alt+NumpadEnter")?.kind).toBe("composer")
    expect(checkChord(DEFAULT_KEYMAP, "session.info", "Escape")?.kind).toBe("composer")
    expect(checkChord(DEFAULT_KEYMAP, "palette.open", "Mod+Shift+KeyC")?.kind).toBe("composer")
    expect(checkChord(DEFAULT_KEYMAP, "session.info", "Mod+Shift+KeyC")).toBeUndefined()
  })

  test("another action's chord is a conflict in overlapping scopes only", () => {
    expect(checkChord(DEFAULT_KEYMAP, "panel.toggle", "Mod+KeyK")).toEqual({ kind: "conflict", other: "palette.open" })
    expect(checkChord(DEFAULT_KEYMAP, "composer.attach", "Mod+ArrowUp")).toEqual({
      kind: "conflict",
      other: "composer.queueEditFirst",
    })
    // An id may keep (or re-add) its own chord.
    expect(checkChord(DEFAULT_KEYMAP, "palette.open", "Mod+KeyK")).toBeUndefined()
  })

  test("a user keymap with a clash shows both sides and the decision it breaks", () => {
    const keymap = mergeKeymap(DEFAULT_KEYMAP, { "panel.toggle": ["Mod+KeyK"] })
    const audit = auditKeymap(keymap)
    expect(audit.issues.map((issue) => [issue.id, issue.problem])).toEqual([
      ["palette.open", { kind: "conflict", other: "panel.toggle" }],
      ["panel.toggle", { kind: "conflict", other: "palette.open" }],
    ])
    expect(audit.decisions.find((decision) => decision.id === "selection")?.kept).toBe(false)
  })

  test("browser defaults own-web takes over in a tab (03 open question 31)", () => {
    expect(browserDefault("Mod+KeyP")).toBe("own.keys.browser.print")
    expect(browserDefault("Shift+Mod+KeyR")).toBe("own.keys.browser.hardReload")
    expect(browserDefault("Mod+BracketLeft")).toBeUndefined()
    expect(browserDefault("Mod+BracketLeft", true)).toBe("own.keys.browser.back")
    expect(paletteText("ko", "own.keys.web", { action: paletteText("ko", "own.keys.browser.print") })).toContain("인쇄")
  })
})

describe("user keymap", () => {
  test("stored overrides are validated; defaults set back remove the override", () => {
    expect(
      parseOverrides({ "panel.toggle": ["Shift+Mod+KeyJ"], "no.such": ["Mod+KeyJ"], "sidebar.toggle": [1] }),
    ).toEqual({
      "panel.toggle": ["Mod+Shift+KeyJ"],
    })
    expect(parseOverrides("x")).toEqual({})
    setChords("panel.toggle", ["Mod+Shift+KeyJ"])
    expect(effectiveKeymap()["panel.toggle"].chords).toEqual(["Mod+Shift+KeyJ"])
    expect(JSON.parse(localStorage.getItem(KEYMAP_STORAGE_KEY) ?? "{}")).toEqual({ "panel.toggle": ["Mod+Shift+KeyJ"] })
    setChords("panel.toggle", ["Mod+Alt+KeyB"])
    expect(keymapOverrides()).toEqual({})
    expect(localStorage.getItem(KEYMAP_STORAGE_KEY)).toBeNull()
    setChords("sidebar.toggle", [])
    expect(effectiveKeymap()["sidebar.toggle"].chords).toEqual([])
    resetChords("sidebar.toggle")
    expect(effectiveKeymap()["sidebar.toggle"].chords).toEqual(["Mod+KeyB"])
  })

  test("the registry wrapper follows rebinding and keeps registration order", () => {
    const ran: string[] = []
    const registry = createRebindableRegistry({ mac: false })
    const release = registry.register("palette.open", () => void ran.push("first"))
    registry.register("palette.open", () => void ran.push("latest"))
    const press = (init: KeyboardEventInit) => registry.handle(new KeyboardEvent("keydown", { bubbles: true, ...init }))
    expect(press({ code: "KeyK", ctrlKey: true })).toBe("palette.open")
    setChords("palette.open", ["Mod+Shift+KeyP"])
    expect(registry.keymap["palette.open"].chords).toEqual(["Mod+Shift+KeyP"])
    expect(press({ code: "KeyK", ctrlKey: true })).toBeUndefined()
    expect(press({ code: "KeyP", ctrlKey: true, shiftKey: true })).toBe("palette.open")
    expect(ran).toEqual(["latest", "latest"])
    release()
    resetAllChords()
    expect(press({ code: "KeyK", ctrlKey: true })).toBe("palette.open")
    registry.dispose()
  })

  test("change listeners get the effective keymap", () => {
    const seen: Keymap[] = []
    const stop = onKeymapChange((keymap) => void seen.push(keymap))
    setChords("mcp.list", ["Mod+Alt+KeyM"])
    stop()
    setChords("mcp.list", ["Mod+Alt+KeyJ"])
    expect(seen.map((keymap) => keymap["mcp.list"].chords)).toEqual([["Mod+Alt+KeyM"]])
  })
})

describe("palette plumbing", () => {
  test("runShortcut runs the live handler of an id, as a key press outside any widget", () => {
    const registry = createRebindableRegistry({ mac: false })
    const ran: string[] = []
    registry.register("approval.menu", () => void ran.push("menu"))
    expect(hasShortcutHandler(registry, "approval.menu")).toBe(true)
    expect(hasShortcutHandler(registry, "session.find")).toBe(false)
    expect(runShortcut(registry, "approval.menu", false)).toBe(true)
    expect(runShortcut(registry, "session.find", false)).toBe(false)
    // Composer-only ids are not live outside the composer.
    registry.register("composer.attach", () => void ran.push("attach"))
    expect(runShortcut(registry, "composer.attach", false)).toBe(false)
    expect(ran).toEqual(["menu"])
    registry.dispose()
  })

  test("sources register and unregister", () => {
    const source = () => [command("x", "X", "view")]
    const remove = registerPaletteSource(source)
    expect(paletteSources()).toContain(source)
    remove()
    expect(paletteSources()).not.toContain(source)
  })

  test("recent commands: newest first, no sessions, capped", () => {
    rememberCommand("a")
    rememberCommand("session:local/x")
    rememberCommand("b")
    rememberCommand("a")
    expect(recentCommands()).toEqual(["a", "b"])
    for (let index = 0; index < 20; index++) rememberCommand(`c${index}`)
    expect(recentCommands()).toHaveLength(12)
  })
})

describe("settings pages by the words people type (03 §5.7)", () => {
  test("Korean words find the settings section", () => {
    const cases = [
      ["휴대폰", "devices"],
      ["QR", "devices"],
      ["컴퓨터 사용", "experimental"],
      // IS (2026-11-08): the image tool has a page of its own.
      ["이미지 만들기", "image"],
      ["이미지", "image"],
      ["그림", "image"],
      ["gpt-image", "image"],
      ["SSH", "remote"],
      ["가져오기", "import"],
      ["다크", "general"],
      ["서브에이전트", "presets"],
      ["하네스", "general"],
      ["에이전트 방식", "general"],
      ["서비스 상태", "server"],
      // 03 §18.2 (WM 2026-10-19): the web search page by any word for it, and by the services' names.
      ["검색", "websearch"],
      ["웹", "websearch"],
      ["인터넷", "websearch"],
      ["Parallel", "websearch"],
      ["Exa", "websearch"],
      ["ChatGPT", "websearch"],
      ["web search", "websearch"],
      // SP's DeepSeek and Brave, and MS's 여러 서비스 함께 (2026-10-19).
      ["DeepSeek", "websearch"],
      ["Brave", "websearch"],
      ["여러 서비스", "websearch"],
    ] as const
    for (const [query, section] of cases)
      expect(
        matchCandidate(parseQuery(query), {
          title: prepare(translate("ko", `own.settings.${section}`)),
          keywords: prepare(`settings ${SECTION_WORDS[section]}`),
        }),
        query,
      ).toBeTruthy()
    // The old home of the choice no longer claims it: 웹 검색 is not one of 승인·권한's words, nor 이미지 one of 컴퓨터
    // 사용's.
    expect(SECTION_WORDS.approval).not.toContain("웹")
    expect(SECTION_WORDS.experimental).not.toContain("이미지")
  })

  test("웹 검색 서비스 바꾸기 and 설정: 웹 검색 (03 §18.2, WM)", async () => {
    const page = paletteText("ko", "own.palette.cmd.settings", { section: translate("ko", "own.settings.websearch") })
    expect(page).toBe("설정: 웹 검색")
    expect(matches("웹 검색 설정", page)).toBe(true)
    const change = paletteText("ko", "own.palette.cmd.webSearch")
    expect(change).toBe("웹 검색 서비스 바꾸기")
    expect(paletteText("en", "own.palette.cmd.webSearch")).toBe("Change the web search service")
    for (const query of ["검색 서비스", "웹 검색 바꾸기", "parallel", "인터넷"])
      expect(
        matchCandidate(parseQuery(query), {
          title: prepare(change),
          keywords: prepare(`websearch settings ${SECTION_WORDS.websearch} 웹 검색 설정`),
        }),
        query,
      ).toBeTruthy()
    // The command opens the page; its keywords are the page's words.
    const source = await Bun.file(new URL("./builtin.ts", import.meta.url)).text()
    const command = source.slice(source.indexOf('id: "websearch.change"'), source.indexOf("const openSettings"))
    expect(command).toContain('...own("own.palette.cmd.webSearch")')
    expect(command).toContain('navigate({ name: "settings", section: "websearch" })')
    expect(command).toContain("SECTION_WORDS.websearch")
  })
})
