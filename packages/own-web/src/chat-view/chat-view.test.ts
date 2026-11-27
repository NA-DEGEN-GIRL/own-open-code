// Chat view (03 §4.5 "대화 보기"): the toggle store (every item shown by default, `대화만 보기` and back, `기본으로`,
// bad stored values), its persistence per viewer, and where the choices are offered (header menu, 설정 > 일반, the
// palette and the `view.chatOnly` shortcut). What each toggle changes in the transcript is in transcript.test.ts.
import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { DEFAULT_KEYMAP } from "@/keyboard/keymap"
import { auditKeymap } from "@/palette/audit"
import {
  CHAT_META,
  CHAT_VIEW_KEY,
  OPT_IN,
  chatView,
  chatViewState,
  isChatOnly,
  isDefault,
  parseChatView,
  resetChatView,
  setChatMeta,
  toggleChatOnly,
  toggledChatOnly,
  viewOf,
  withMeta,
} from "."
import { chatViewEn, chatViewKo } from "./strings"

const SRC = path.join(import.meta.dir, "..")
const source = (file: string) => Bun.file(path.join(SRC, file)).text()

afterEach(() => resetChatView())

describe("chat view state", () => {
  test("everything is shown by default but 날짜·시각; stored values are read leniently", () => {
    expect(viewOf(parseChatView(null))).toEqual(
      Object.fromEntries(CHAT_META.map((key) => [key, !OPT_IN.includes(key)])) as never,
    )
    expect(OPT_IN).toEqual(["clock"])
    expect(parseChatView("{not json")).toEqual({ hidden: [] })
    expect(parseChatView(JSON.stringify({ hidden: ["usage", "nope", "speed"] }))).toEqual({
      hidden: ["usage", "speed"],
    })
    expect(parseChatView(JSON.stringify({ hidden: "usage" }))).toEqual({ hidden: [] })
    expect(parseChatView(JSON.stringify({ hidden: [], before: ["time"] }))).toEqual({ hidden: [], before: ["time"] })
    // An opt-in item is stored as shown, never as hidden; one in the wrong list is dropped.
    expect(parseChatView(JSON.stringify({ hidden: ["clock", "usage"], shown: ["clock", "usage"] }))).toEqual({
      hidden: ["usage"],
      shown: ["clock"],
    })
    expect(parseChatView(JSON.stringify({ hidden: [], shown: "clock" }))).toEqual({ hidden: [] })
  })

  test("날짜·시각 (UC 2026-10-18) is off until turned on, next to 걸린 시간; 기본으로 turns it off again", () => {
    expect(CHAT_META.indexOf("clock")).toBe(CHAT_META.indexOf("time") + 1)
    const on = withMeta({ hidden: [] }, "clock", true)
    expect(on).toEqual({ hidden: [], shown: ["clock"] })
    expect(viewOf(on).clock).toBe(true)
    expect(viewOf(on).time).toBe(true)
    expect(isDefault(on)).toBe(false)
    // Either can be on alone.
    const clockOnly = withMeta(on, "time", false)
    expect(viewOf(clockOnly)).toMatchObject({ time: false, clock: true })
    expect(withMeta(clockOnly, "clock", false)).toEqual({ hidden: ["time"] })
    // 대화만 보기 turns it off too, and back on after.
    const only = toggledChatOnly(clockOnly)
    expect(isChatOnly(only)).toBe(true)
    expect(viewOf(only).clock).toBe(false)
    expect(toggledChatOnly(only)).toEqual({ hidden: ["time"], shown: ["clock"] })
    setChatMeta("clock", true)
    expect(JSON.parse(localStorage.getItem(CHAT_VIEW_KEY) ?? "null")).toEqual({ hidden: [], shown: ["clock"] })
    resetChatView()
    expect(chatView().clock).toBe(false)
    expect(chatViewKo["own.chatView.meta.time"]).toBe("걸린 시간")
    expect(chatViewKo["own.chatView.meta.clock"]).toBe("날짜·시각")
  })

  test("one item at a time, in the canonical order", () => {
    const state = withMeta(withMeta({ hidden: [] }, "time", false), "usage", false)
    expect(state.hidden).toEqual(["usage", "time"])
    expect(viewOf(state).time).toBe(false)
    expect(viewOf(state).model).toBe(true)
    expect(withMeta(state, "time", true).hidden).toEqual(["usage"])
  })

  test("대화만 보기 hides everything and brings back what was hidden before", () => {
    const custom = withMeta({ hidden: [] }, "thinking", false)
    const only = toggledChatOnly(custom)
    expect(isChatOnly(only)).toBe(true)
    expect(Object.values(viewOf(only)).some(Boolean)).toBe(false)
    expect(toggledChatOnly(only)).toEqual({ hidden: ["thinking"] })
    // Everything hidden by hand (or nothing remembered): off shows everything.
    expect(toggledChatOnly({ hidden: [...CHAT_META] })).toEqual({ hidden: [] })
    expect(toggledChatOnly({ hidden: [...CHAT_META], before: [...CHAT_META] })).toEqual({ hidden: [] })
    expect(isDefault(toggledChatOnly(toggledChatOnly({ hidden: [] })))).toBe(true)
  })

  test("the store is reactive state saved per viewer in localStorage", () => {
    setChatMeta("usage", false)
    expect(chatView().usage).toBe(false)
    expect(JSON.parse(localStorage.getItem(CHAT_VIEW_KEY) ?? "null")).toEqual({ hidden: ["usage"] })
    toggleChatOnly()
    expect(isChatOnly(chatViewState())).toBe(true)
    toggleChatOnly()
    expect(chatViewState().hidden).toEqual(["usage"])
    resetChatView()
    expect(isDefault(chatViewState())).toBe(true)
    expect(JSON.parse(localStorage.getItem(CHAT_VIEW_KEY) ?? "null")).toEqual({ hidden: [] })
  })

  test("every item has Korean and English words", () => {
    for (const key of CHAT_META) {
      expect(chatViewKo[`own.chatView.meta.${key}`]).toBeTruthy()
      expect(chatViewEn[`own.chatView.meta.${key}`]).toBeTruthy()
    }
  })
})

describe("where the chat view is offered", () => {
  test("the session header has the 보기 menu with check items, 대화만 보기 and 기본으로", async () => {
    const header = await source("shell/header.tsx")
    expect(header).toContain("<ChatViewMenu />")
    const menu = await source("chat-view/menu.tsx")
    expect(menu).toContain('role="menuitemcheckbox"')
    expect(menu).toContain("aria-checked={chatView()[key]}")
    expect(menu).toContain("toggleChatOnly()")
    expect(menu).toContain("resetChatView()")
    // Phone: the button sits on the header's first line next to `⋯`.
    expect(await source("styles/shell.css")).toContain('.own-header > [data-testid="chat-view-menu"]')
  })

  test("설정 > 일반 has the same choices", async () => {
    const settings = await source("settings/sections.tsx")
    expect(settings).toContain("<ChatViewSetting />")
    const setting = await source("chat-view/setting.tsx")
    expect(setting).toContain('type="checkbox"')
    expect(setting).toContain("setChatMeta(key, event.currentTarget.checked)")
  })

  test("Ctrl+Alt+R toggles 대화만 보기 (palette entry through the shortcut list) and passes the keymap audit", async () => {
    expect(DEFAULT_KEYMAP["view.chatOnly"]).toEqual({ chords: ["Mod+Alt+KeyR"], scope: "global" })
    for (const mac of [false, true])
      expect(auditKeymap(DEFAULT_KEYMAP, { mac }).issues.filter((issue) => issue.id === "view.chatOnly")).toEqual([])
    expect(await source("shell/shortcuts.tsx")).toContain('useShortcut("view.chatOnly", () => toggleChatOnly())')
    expect(await source("palette/builtin.ts")).toContain('"view.chatOnly": "view"')
    expect(await source("i18n/ko.ts")).toContain('"own.set.sc.view.chatOnly"')
    expect(await source("i18n/en.ts")).toContain('"own.set.sc.view.chatOnly"')
  })
})
