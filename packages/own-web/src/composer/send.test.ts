// What a send does (03 §4.6, §5.1, §6.5, 02 §5.3, 07 §4.3): delivery by the setting and the other-delivery key in
// both `보내는 키` choices (with their key names and storage), the pending-switch queue rule, holding during a
// compact-then-switch, `!` shell, new sessions, every blocked reason, and the gate of a gone main model or effort
// level, which opens the switcher on the service's suggestion instead of sending.
import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { busyDelivery, goneTarget, planSend, type MainGone, type SendInput } from "./send"
import { parseSendKey, SEND_KEY_STORAGE, SEND_KEYS, sendKey, sendKeyLabels } from "./send-key"

const base: SendInput = {
  text: "타입 오류도 같이 고쳐줘",
  modifier: false,
  connected: true,
  session: { busy: false, child: false },
  followUp: "steer",
  shellMode: false,
  canPrompt: true,
}

describe("planSend", () => {
  test("an idle session starts a turn (no delivery)", () => {
    expect(planSend(base)).toEqual({ kind: "prompt", create: false, applyPending: false })
  })

  test("while running: Enter follows the setting, Ctrl+Enter does the other (03 §4.6, §10)", () => {
    const busy = { ...base, session: { busy: true, child: false } }
    expect(planSend(busy)).toMatchObject({ kind: "prompt", delivery: "steer" })
    expect(planSend({ ...busy, modifier: true })).toMatchObject({ kind: "prompt", delivery: "queue" })
    expect(planSend({ ...busy, followUp: "queue" })).toMatchObject({ kind: "prompt", delivery: "queue" })
    expect(planSend({ ...busy, followUp: "queue", modifier: true })).toMatchObject({
      kind: "prompt",
      delivery: "steer",
    })
  })

  test("a pending switch on a running session queues every follow-up (02 §5.3 method 3)", () => {
    const pending = { ...base, session: { busy: true, child: false, switchState: "WAIT_SAFE" } }
    expect(planSend(pending)).toMatchObject({ kind: "prompt", delivery: "queue" })
    expect(planSend({ ...pending, modifier: true })).toMatchObject({ kind: "prompt", delivery: "queue" })
  })

  test("a waiting context reset queues every follow-up behind it, idle or busy (03 §18.18)", () => {
    const pending = { ...base, session: { busy: true, child: false, resetPending: true } }
    // `held`: queued only because of the reset (it would steer or start a turn), so a cancel of the reset steers it.
    expect(planSend(pending)).toEqual({
      kind: "prompt",
      delivery: "queue",
      create: false,
      applyPending: false,
      held: true,
    })
    expect(planSend({ ...pending, modifier: true })).toMatchObject({ kind: "prompt", delivery: "queue", held: false })
    expect(planSend({ ...pending, followUp: "queue" })).toMatchObject({ delivery: "queue", held: false })
    expect(planSend({ ...pending, followUp: "queue", modifier: true })).toMatchObject({ delivery: "queue", held: true })
    // A pending switch queues a busy follow-up anyway.
    expect(planSend({ ...pending, session: { ...pending.session, switchState: "WAIT_SAFE" } })).toMatchObject({
      delivery: "queue",
      held: false,
    })
    const idle = { ...pending, session: { ...pending.session, busy: false } }
    expect(planSend(idle)).toEqual({
      kind: "prompt",
      delivery: "queue",
      create: false,
      applyPending: false,
      held: true,
    })
    expect(planSend({ ...idle, session: { ...idle.session, switchState: "WAIT_SAFE" } })).toEqual({
      kind: "prompt",
      delivery: "queue",
      create: false,
      applyPending: true,
      held: true,
    })
  })

  test("an idle session with a pending switch applies it before prompting", () => {
    const idle = { ...base, session: { busy: false, child: false, switchState: "WAIT_SAFE" } }
    expect(planSend(idle)).toEqual({ kind: "prompt", create: false, applyPending: true })
  })

  test("a compact-then-switch holds messages on the client (03 §6.5)", () => {
    expect(planSend({ ...base, session: { busy: true, child: false, switchState: "COMPACTING" } })).toEqual({
      kind: "hold",
    })
  })

  test("`!` or shell mode runs a shell command, even during a compaction", () => {
    expect(planSend({ ...base, text: "!bun test" })).toEqual({ kind: "shell", command: "bun test", create: false })
    expect(planSend({ ...base, text: "ls -la", shellMode: true })).toEqual({
      kind: "shell",
      command: "ls -la",
      create: false,
    })
    expect(
      planSend({ ...base, text: "!git status", session: { busy: true, child: false, switchState: "COMPACTING" } }),
    ).toMatchObject({ kind: "shell" })
    expect(planSend({ ...base, text: "!   " })).toEqual({ kind: "none" })
  })

  test("the home route creates a session when it knows the model and the folder (03 §5.1)", () => {
    const home = { ...base, session: undefined }
    expect(planSend({ ...home, newSession: "ready" })).toEqual({ kind: "prompt", create: true })
    expect(planSend({ ...home, newSession: "ready", text: "!pwd" })).toEqual({
      kind: "shell",
      command: "pwd",
      create: true,
    })
    expect(planSend({ ...home, newSession: "noTarget" })).toEqual({ kind: "blocked", reason: "noTarget" })
    expect(planSend({ ...home, newSession: "noDirectory" })).toEqual({ kind: "blocked", reason: "noDirectory" })
  })

  test("the home route before its accounts and defaults answered says it is loading, not 'add an account' (RL5-1)", () => {
    const home = { ...base, session: undefined }
    expect(planSend({ ...home, newSession: "loading" })).toEqual({ kind: "blocked", reason: "loading" })
    expect(planSend({ ...home, newSession: "loading", text: "!pwd" })).toEqual({ kind: "blocked", reason: "loading" })
    expect(planSend({ ...home, newSession: "loading", connected: false })).toEqual({ kind: "blocked", reason: "offline" })
  })

  test("blocked: offline keeps the draft, child sessions are driven by the parent, devices without prompt", () => {
    expect(planSend({ ...base, connected: false })).toEqual({ kind: "blocked", reason: "offline" })
    expect(planSend({ ...base, session: { busy: false, child: true } })).toEqual({ kind: "blocked", reason: "child" })
    expect(planSend({ ...base, canPrompt: false })).toEqual({ kind: "blocked", reason: "scope" })
    expect(planSend({ ...base, locked: true })).toEqual({ kind: "blocked", reason: "locked" })
  })

  test("blank text is nothing, whatever the state", () => {
    expect(planSend({ ...base, text: "  \n", connected: false })).toEqual({ kind: "none" })
  })

  test("attachments alone may be sent as a prompt (18.10), never as a shell command", () => {
    expect(planSend({ ...base, text: "", attachments: true })).toEqual({
      kind: "prompt",
      create: false,
      applyPending: false,
    })
    expect(planSend({ ...base, text: "", attachments: true, session: undefined, newSession: "ready" })).toEqual({
      kind: "prompt",
      create: true,
    })
    expect(planSend({ ...base, text: "", attachments: true, shellMode: true })).toEqual({ kind: "none" })
    expect(planSend({ ...base, text: "", attachments: true, connected: false })).toEqual({
      kind: "blocked",
      reason: "offline",
    })
  })

  test("a gone main model or effort level opens the switcher flow instead of sending (07 §4.3)", () => {
    const model: MainGone = { missing: "model", suggestion: { id: Model.ID.make("gpt-5.6-sol") } }
    const variant: MainGone = {
      missing: "variant",
      suggestion: { id: Model.ID.make("gpt-5.6-sol"), variant: Model.VariantID.make("max") },
    }
    const idle = { busy: false, child: false }
    expect(planSend({ ...base, session: { ...idle, main: model } })).toEqual({ kind: "switch", ...model })
    expect(planSend({ ...base, session: { busy: true, child: false, main: variant } })).toEqual({
      kind: "switch",
      ...variant,
    })
    // Without a suggestion the switcher opens on the current main and the user picks.
    expect(planSend({ ...base, session: { ...idle, main: { missing: "model" } } })).toEqual({
      kind: "switch",
      missing: "model",
    })
    // A shell command uses no model; a child is driven by its parent; a running compact-then-switch holds.
    expect(planSend({ ...base, text: "!git status", session: { ...idle, main: model } })).toMatchObject({
      kind: "shell",
    })
    expect(planSend({ ...base, session: { busy: false, child: true, main: model } })).toEqual({
      kind: "blocked",
      reason: "child",
    })
    expect(planSend({ ...base, session: { ...idle, switchState: "COMPACTING", main: model } })).toEqual({
      kind: "hold",
    })
    // A switch the user already chose applies first and leaves the gone main.
    expect(planSend({ ...base, session: { ...idle, switchState: "WAIT_SAFE", main: model } })).toEqual({
      kind: "prompt",
      create: false,
      applyPending: true,
    })
  })

  test("the switcher opens on the suggestion on the session's account, or on the current main without one", () => {
    const current = { providerID: "own-codex-aaaa", id: "gpt-5.5", variant: "xhigh" }
    expect(goneTarget(current, { missing: "model", suggestion: { id: Model.ID.make("gpt-5.6-sol") } })).toEqual({
      providerID: "own-codex-aaaa",
      id: "gpt-5.6-sol",
    })
    expect(
      goneTarget(current, {
        missing: "variant",
        suggestion: { id: Model.ID.make("gpt-5.5"), variant: Model.VariantID.make("max") },
      }),
    ).toEqual({ providerID: "own-codex-aaaa", id: "gpt-5.5", variant: "max" })
    expect(goneTarget(current, { missing: "model" })).toBeUndefined()
    expect(goneTarget(undefined, { missing: "model", suggestion: { id: Model.ID.make("gpt-5.6-sol") } })).toBe(
      undefined,
    )
  })

  test("busyDelivery", () => {
    expect(busyDelivery("steer", false)).toBe("steer")
    expect(busyDelivery("steer", true)).toBe("queue")
    expect(busyDelivery("queue", false)).toBe("queue")
    expect(busyDelivery("queue", true)).toBe("steer")
  })
})

describe("보내는 키 (03 §4.6, EM 2026-10-18)", () => {
  test("the other-delivery key flips the setting in both choices (Ctrl+Enter, or Alt+Enter when Ctrl+Enter sends)", () => {
    // The key mapping lives in the IME machine; a send arrives here as `modifier` either way.
    const busy = { ...base, session: { busy: true, child: false } }
    for (const followUp of ["steer", "queue"] as const) {
      expect(planSend({ ...busy, followUp })).toMatchObject({ delivery: followUp })
      expect(planSend({ ...busy, followUp, modifier: true })).toMatchObject({
        delivery: followUp === "steer" ? "queue" : "steer",
      })
    }
    // An idle session ignores the modifier: Ctrl+Enter or Alt+Enter just starts the turn.
    expect(planSend({ ...base, modifier: true })).toEqual({ kind: "prompt", create: false, applyPending: false })
  })

  test("key names per choice: send, other delivery and new line (⌘ on macOS)", () => {
    expect(sendKeyLabels("enter", false)).toEqual({ send: "Enter", other: "Ctrl+Enter", newline: "Shift+Enter" })
    expect(sendKeyLabels("modEnter", false)).toEqual({ send: "Ctrl+Enter", other: "Alt+Enter", newline: "Enter" })
    expect(sendKeyLabels("enter", true)).toEqual({ send: "Enter", other: "⌘+Enter", newline: "Shift+Enter" })
    expect(sendKeyLabels("modEnter", true)).toEqual({ send: "⌘+Enter", other: "Alt+Enter", newline: "Enter" })
  })

  test("stored per viewer, only on a change; unknown values are the default; other windows follow", () => {
    // Ctrl+Enter is the default (EM-10); the first key's values are not read (written while Enter was the default).
    expect(SEND_KEYS[0]).toBe("modEnter")
    expect(SEND_KEY_STORAGE).toBe("own.web.composer.sendKey.v2")
    expect(parseSendKey("enter")).toBe("enter")
    expect(parseSendKey("modEnter")).toBe("modEnter")
    expect(parseSendKey("ctrl")).toBe("modEnter")
    expect(parseSendKey(null)).toBe("modEnter")
    expect(sendKey.value()).toBe("modEnter")
    // Picking the current choice (설정's radio, the menu) stores nothing, so the device keeps following the default.
    sendKey.set("modEnter")
    expect(localStorage.getItem(SEND_KEY_STORAGE)).toBeNull()
    sendKey.set("enter")
    expect(sendKey.value()).toBe("enter")
    expect(localStorage.getItem(SEND_KEY_STORAGE)).toBe("enter")
    window.dispatchEvent(new StorageEvent("storage", { key: SEND_KEY_STORAGE, newValue: "modEnter" }))
    expect(sendKey.value()).toBe("modEnter")
    window.dispatchEvent(new StorageEvent("storage", { key: SEND_KEY_STORAGE, newValue: "enter" }))
    expect(sendKey.value()).toBe("enter")
    window.dispatchEvent(new StorageEvent("storage", { key: "own.web.composer.sendKey", newValue: "modEnter" }))
    window.dispatchEvent(new StorageEvent("storage", { key: "own.web.composer.followUp", newValue: "queue" }))
    expect(sendKey.value()).toBe("enter")
    // A cleared store is the default again.
    window.dispatchEvent(new StorageEvent("storage", { key: SEND_KEY_STORAGE, newValue: null }))
    expect(sendKey.value()).toBe("modEnter")
    sendKey.set("enter")
    sendKey.set("modEnter")
    expect(localStorage.getItem(SEND_KEY_STORAGE)).toBe("modEnter")
  })
})
