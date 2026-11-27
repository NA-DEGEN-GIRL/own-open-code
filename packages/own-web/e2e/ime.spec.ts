// 03 §12 automated IME checks in Edge: the three event orders (A1, A2, B) as dispatched DOM events, plus a real
// Chromium composition through CDP `Input.imeSetComposition`. Each must send exactly once and leave the box empty;
// the commitOnly search box must apply only on the Enter after the commit.
import { expect, test, type Page } from "@playwright/test"

type ImeLog = { sent: string[]; applied: string[]; events: string[] }

async function open(page: Page) {
  await page.goto("/e2e/ime-harness.html")
  await page.waitForFunction(() => "__ime" in window)
}

const log = (page: Page) => page.evaluate(() => (window as unknown as { __ime: ImeLog }).__ime)

/** Dispatches the given steps on an element; keydown/keyup carry `keyCode` and `isComposing` like a real IME. */
async function replay(page: Page, selector: string, value: string, steps: string[]) {
  await page.evaluate(
    ({ selector, value, steps }) => {
      const element = document.querySelector(selector) as HTMLTextAreaElement | HTMLInputElement
      element.focus()
      const key = (type: string, keyName: string, keyCode: number, isComposing: boolean) => {
        const event = new KeyboardEvent(type, {
          key: keyName,
          code: "Enter",
          isComposing,
          bubbles: true,
          cancelable: true,
        })
        Object.defineProperty(event, "keyCode", { get: () => keyCode })
        element.dispatchEvent(event)
      }
      for (const step of steps) {
        if (step === "start")
          element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }))
        if (step === "input") {
          element.value = value
          element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, isComposing: true }))
        }
        if (step === "end")
          element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: value }))
        if (step === "enter229composing") key("keydown", "Process", 229, true)
        if (step === "enter229") key("keydown", "Enter", 229, false)
        if (step === "enter") key("keydown", "Enter", 13, false)
        if (step === "keyup") key("keyup", "Enter", 13, false)
      }
    },
    { selector, value, steps },
  )
}

test.describe("composer IME rules (03 §12 rule 8)", () => {
  const orders = {
    "A1 Chromium: 229 while composing → compositionend → Enter 13": [
      "start",
      "input",
      "enter229composing",
      "end",
      "enter",
      "keyup",
    ],
    "A2 Chromium: 229 while composing → compositionend, no second keydown": [
      "start",
      "input",
      "enter229composing",
      "end",
      "keyup",
    ],
    "B Safari: compositionend → Enter 229 not composing": ["start", "input", "end", "enter229", "keyup"],
  }
  for (const [name, steps] of Object.entries(orders)) {
    test(`${name}: exactly one send and an empty box`, async ({ page }) => {
      await open(page)
      await replay(page, "#composer", "안녕", steps)
      await expect.poll(async () => (await log(page)).sent).toEqual(["안녕"])
      await expect(page.locator("#composer")).toHaveValue("")
      await page.waitForTimeout(150)
      expect((await log(page)).sent).toEqual(["안녕"])
    })
  }

  test("real Chromium composition via CDP: Enter during composition sends the committed text once", async ({
    page,
  }) => {
    await open(page)
    const cdp = await page.context().newCDPSession(page)
    await page.locator("#composer").focus()
    await cdp.send("Input.imeSetComposition", { text: "안", selectionStart: 1, selectionEnd: 1 })
    await cdp.send("Input.imeSetComposition", { text: "안녕", selectionStart: 2, selectionEnd: 2 })
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    })
    await cdp.send("Input.insertText", { text: "안녕" })
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
    await expect.poll(async () => (await log(page)).sent).toEqual(["안녕"])
    await expect(page.locator("#composer")).toHaveValue("")
    console.log(
      `CDP event order: ${(await log(page)).events.filter((event) => event.startsWith("composer")).join(" → ")}`,
    )
  })

  test("Shift+Enter during composition is a newline, not a send", async ({ page }) => {
    await open(page)
    await page.locator("#composer").focus()
    await page.keyboard.type("abc")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("def")
    await expect(page.locator("#composer")).toHaveValue("abc\ndef")
    expect((await log(page)).sent).toEqual([])
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await log(page)).sent).toEqual(["abc\ndef"])
  })
})

test.describe("switcher/palette search (rule 8 exception)", () => {
  for (const [name, steps] of Object.entries({
    A1: ["start", "input", "enter229composing", "end", "enter", "keyup"],
    A2: ["start", "input", "enter229composing", "end", "keyup"],
    B: ["start", "input", "end", "enter229", "keyup"],
  })) {
    test(`${name}: the committing Enter only commits; the next Enter applies once`, async ({ page }) => {
      await open(page)
      await replay(page, "#search", "결제", steps)
      await page.waitForTimeout(120)
      expect((await log(page)).applied).toEqual([])
      await page.keyboard.press("Enter")
      await expect.poll(async () => (await log(page)).applied).toEqual(["결제"])
    })
  }
})
