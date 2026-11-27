// Shell ↔ UI mismatch screen (05 §5.5, 03 §8): what it shows and which actions a shell of another contract offers.
import { afterEach, describe, expect, test } from "bun:test"
import type { OwnOpenInBrowserResult, OwnShellApi } from "../../../own-desktop/src/preload/own-api"
import { MISMATCH_TEXT, showShellMismatch } from "./mismatch"
import { ShellMismatchError } from "./types"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function shell(support?: {
  openLogs?: () => Promise<boolean>
  openInBrowser?: () => Promise<OwnOpenInBrowserResult>
}): OwnShellApi {
  return {
    shell: {
      rpcHash: "1111111111111111",
      version: "2.0.18-own.1",
      startedAt: Promise.resolve(0),
      controlDir: Promise.resolve("C:\\own\\control"),
      renderer: Promise.resolve({ source: "installed", root: "W", uiVersion: "2.0.18-own.2" }),
    },
    service: { status: async () => ({ running: true, managed: true }), restart: async () => ({ ok: true }) },
    ...(support ? { support: support as OwnShellApi["support"] } : {}),
  }
}

afterEach(() => {
  document.body.innerHTML = ""
})

function mount(own: OwnShellApi | undefined, error = new ShellMismatchError(own?.shell.rpcHash, "2222222222222222")) {
  const root = document.createElement("div")
  root.textContent = "loading"
  document.body.append(root)
  showShellMismatch(root, error, own)
  const button = (action: string) => root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
  return { root, button, status: () => root.querySelector('[role="status"]')?.textContent ?? "" }
}

describe("mismatch screen (05 §5.5)", () => {
  test("replaces the page: title, both versions, the command, a drag band for the frameless window", async () => {
    const view = mount(shell({ openLogs: async () => true, openInBrowser: async () => ({ ok: true }) }))
    await flush()
    const text = view.root.textContent ?? ""
    expect(text).not.toContain("loading")
    expect(text).toContain(MISMATCH_TEXT.title)
    expect(text).toContain("2.0.18-own.1 · 1111111111111111")
    expect(text).toContain("2.0.18-own.2 · 2222222222222222")
    expect(text).toContain("own open --browser")
    const band = view.root.querySelector<HTMLElement>('[data-testid="shell-mismatch-drag"]')
    expect(band?.getAttribute("style")).toContain("-webkit-app-region: drag")
  })

  test("with support: [브라우저로 열기] runs own open --browser and reports; [로그 폴더] opens the logs", async () => {
    let logs = 0
    let resolve: (value: OwnOpenInBrowserResult) => void = () => {}
    const view = mount(
      shell({
        openLogs: async () => {
          logs++
          return true
        },
        openInBrowser: () => new Promise((done) => (resolve = done)),
      }),
    )
    view.button("logs")?.click()
    await flush()
    expect(logs).toBe(1)
    expect(view.status()).toBe("")
    view.button("browser")?.click()
    expect(view.status()).toBe(MISMATCH_TEXT.opening)
    expect(view.button("browser")?.disabled).toBe(true)
    resolve({ ok: false, detail: "런처가 오류로 끝났어요(종료 코드 4)" })
    await flush()
    expect(view.status()).toBe(`${MISMATCH_TEXT.browserFailed} 런처가 오류로 끝났어요(종료 코드 4)`)
    expect(view.button("browser")?.disabled).toBe(false)
  })

  test("a shell without support (another contract): only [다시 확인] and the command", () => {
    const view = mount(shell())
    expect(view.button("retry")).not.toBeNull()
    expect(view.button("browser")).toBeNull()
    expect(view.button("logs")).toBeNull()
  })

  test("no window.own at all: says so, versions show what is known", () => {
    const view = mount(undefined, new ShellMismatchError(undefined, "2222222222222222"))
    const text = view.root.textContent ?? ""
    expect(text).toContain(MISMATCH_TEXT.noShell)
    expect(text).toContain("? · 2222222222222222")
    expect(view.button("browser")).toBeNull()
  })

  test("a log folder that did not open is reported", async () => {
    const view = mount(shell({ openLogs: async () => false }))
    view.button("logs")?.click()
    await flush()
    expect(view.status()).toBe(MISMATCH_TEXT.logsFailed)
  })
})
