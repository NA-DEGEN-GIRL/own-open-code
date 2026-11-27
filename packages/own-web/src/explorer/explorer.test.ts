// `탐색기에서 열기` / `탐색기에서 보기` (03 §19.5, 05 §7.10): what a click asks the host for, what a failure says, and
// where the entries may live. The host is a stand-in: nothing here opens a window.
import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_TEMPLATE as SHELL_TEMPLATE } from "../../../own-desktop/src/shared/explorer"
import type { ExplorerResult, HostExplorer, OwnHost } from "@/host/types"
import type { Router } from "@/routing/router"
import { registerRemoteStore } from "@/servers/active"
import type { RemoteStore } from "@/servers/store"
import type { ToastInput } from "@/switcher/toast"
import { createExplorerEntries, sshTarget } from "./actions"
import { explorerEntries, prepareExplorer } from "./index"
import { explorerEn, explorerKo } from "./strings"

const source = async (file: string) =>
  (await Bun.file(new URL(`../${file}`, import.meta.url)).text())
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

function world(answer: ExplorerResult = { ok: true }) {
  const calls: unknown[][] = []
  const toasts: ToastInput[] = []
  const opened: unknown[] = []
  const explorer: HostExplorer = {
    reveal: async (path) => {
      calls.push(["reveal", path])
      return answer
    },
    launch: async (input) => {
      calls.push(["launch", input.host, input.path])
      return answer
    },
    program: async () => ({ template: SHELL_TEMPLATE }),
    pickProgram: async () => ({ template: SHELL_TEMPLATE }),
    setTemplate: async (template) => ({ template }),
    clearProgram: async () => ({ template: SHELL_TEMPLATE }),
  }
  const entries = createExplorerEntries(explorer, { navigate: (to) => void opened.push(to) }, (input) =>
    toasts.push(input),
  )
  return { calls, toasts, opened, explorer, entries }
}

const hosts = (targets: Record<string, string>) =>
  registerRemoteStore({
    host: (id: string) => (targets[id] === undefined ? undefined : { id, target: targets[id] }),
  } as unknown as RemoteStore)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("{host}: what own gives ssh for the host", () => {
  test("an alias is the alias; a typed line gives its destination, the last word", () => {
    expect(sshTarget("devbox")).toBe("devbox")
    expect(sshTarget("dev@build.example")).toBe("dev@build.example")
    expect(sshTarget("  dev@box  ")).toBe("dev@box")
    expect(sshTarget("ssh -p 2222 dev@box")).toBe("dev@box")
    expect(sshTarget('ssh -p 2222 -i "~/keys/k" -J gateway dev@devbox')).toBe("dev@devbox")
    expect(sshTarget("-o Port=2200\tdev@box")).toBe("dev@box")
    expect(sshTarget("")).toBe("")
  })
})

describe("a click", () => {
  test("a folder or file of this PC goes to reveal as it is", async () => {
    const { entries, calls, toasts } = world()
    await entries.open({ ssh: false, serverKey: "local", path: "D:\\projects\\app" }, "ko")
    await entries.open({ ssh: false, serverKey: "local", path: "D:\\projects\\app\\src\\한글 파일.ts" }, "ko")
    expect(calls).toEqual([
      ["reveal", "D:\\projects\\app"],
      ["reveal", "D:\\projects\\app\\src\\한글 파일.ts"],
    ])
    expect(toasts).toEqual([])
  })

  test("one on an SSH host goes to launch with the host's SSH target and the remote path", async () => {
    cleanups.push(hosts({ "h-alias": "devbox", "h-typed": "ssh -p 2222 dev@box" }))
    const { entries, calls, toasts } = world()
    await entries.open({ ssh: true, serverKey: "h-alias", path: "/home/dev/my app" }, "ko")
    await entries.open({ ssh: true, serverKey: "h-typed", path: '/srv/a "b" & c.txt' }, "ko")
    expect(calls).toEqual([
      ["launch", "devbox", "/home/dev/my app"],
      ["launch", "dev@box", '/srv/a "b" & c.txt'],
    ])
    expect(toasts).toEqual([])
  })

  test("an SSH host the list does not know yet: nothing is asked, a toast says so", async () => {
    cleanups.push(hosts({}))
    const { entries, calls, toasts } = world()
    await entries.open({ ssh: true, serverKey: "h-gone", path: "/home/dev" }, "ko")
    expect(calls).toEqual([])
    expect(toasts).toEqual([{ message: explorerKo["own.explorer.fail.noHost"], tone: "danger" }])
  })

  test("no program chosen: an explanation with a button to the setting, not an error", async () => {
    cleanups.push(hosts({ h1: "devbox" }))
    const { entries, toasts, opened } = world({ ok: false, reason: "unconfigured" })
    await entries.open({ ssh: true, serverKey: "h1", path: "/home/dev/app" }, "ko")
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.message).toBe(explorerKo["own.explorer.fail.unconfigured"])
    expect(toasts[0]!.tone).toBe("neutral")
    expect(toasts[0]!.action?.label).toBe("설정 열기")
    toasts[0]!.action!.run()
    // 설정 > SSH 원격 호스트, where the program is chosen.
    expect(opened).toEqual([{ name: "settings", section: "remote" }])
  })

  test("a refused start names Smart App Control and the code, and offers nothing to get around it", async () => {
    cleanups.push(hosts({ h1: "devbox" }))
    const { entries, toasts, calls } = world({ ok: false, reason: "blocked", detail: "UNKNOWN: spawn UNKNOWN" })
    await entries.open({ ssh: true, serverKey: "h1", path: "/home/dev/app" }, "ko")
    expect(toasts[0]!.message).toContain("Windows가 프로그램 실행을 막았어요 (UNKNOWN: spawn UNKNOWN)")
    expect(toasts[0]!.message).toContain("스마트 앱 컨트롤")
    expect(toasts[0]!.tone).toBe("danger")
    expect(toasts[0]!.action).toBeUndefined()
    // One request: a refusal is never tried again another way.
    expect(calls).toHaveLength(1)
  })

  test("every failure has its own words in both languages; a missing program and a bad template lead to 설정", async () => {
    const reasons = [
      "outside",
      "missing",
      "service",
      "unconfigured",
      "program",
      "blocked",
      "failed",
      "host",
      "path",
      "template",
      "unavailable",
    ] as const
    for (const reason of reasons) {
      expect(explorerKo[`own.explorer.fail.${reason}`]).toBeTruthy()
      expect(explorerEn[`own.explorer.fail.${reason}`]).toBeTruthy()
      const { entries, toasts } = world({ ok: false, reason, detail: "D" })
      await entries.open({ ssh: false, serverKey: "local", path: "C:\\x" }, "ko")
      expect(toasts[0]!.message).not.toContain("{")
      expect(toasts[0]!.action !== undefined).toBe(["unconfigured", "program", "template"].includes(reason))
    }
    const outside = world({ ok: false, reason: "outside" })
    await outside.entries.open({ ssh: false, serverKey: "local", path: "C:\\Windows" }, "ko")
    expect(outside.toasts[0]!.message).toBe("앱에서 열어 둔 폴더 밖이라 열지 않았어요: C:\\Windows")
    await outside.entries.open({ ssh: false, serverKey: "local", path: "C:\\Windows" }, "en")
    expect(outside.toasts[1]!.message).toBe("Not opened: outside the folders this app has open: C:\\Windows")
  })

  test("a host call that throws is a toast too; open never rejects", async () => {
    const { entries, toasts, explorer } = world()
    Object.assign(explorer, { reveal: async () => Promise.reject(new Error("ipc closed")) })
    await entries.open({ ssh: false, serverKey: "local", path: "C:\\x" }, "ko")
    expect(toasts[0]!.message).toBe("열지 못했어요: ipc closed")
  })
})

describe("entries", () => {
  const local = { runtime: { kind: "local" as const }, serverKey: "local", directory: "D:\\projects\\app" }
  const remote = { runtime: { kind: "ssh" as const }, serverKey: "h1", directory: "/home/dev/app" }

  test("conversation ⋯ and project ⋯: 탐색기에서 열기 for the folder; none without a folder", async () => {
    cleanups.push(hosts({ h1: "devbox" }))
    const { entries, calls } = world()
    const session = entries.sessionItems(local.runtime, local.serverKey, local.directory, "ko")
    expect(session).toHaveLength(1)
    expect(session[0]).toMatchObject({ label: "탐색기에서 열기", testid: "session-menu-explorer" })
    expect(entries.projectItems(local.runtime, local.serverKey, local.directory, "en")[0]).toMatchObject({
      label: "Open in Explorer",
      testid: "project-menu-explorer",
    })
    expect(entries.sessionItems(local.runtime, local.serverKey, undefined, "ko")).toEqual([])
    // A project row whose server is not connected yet has no runtime.
    expect(entries.projectItems(undefined, local.serverKey, local.directory, "ko")).toEqual([])
    const item = entries.sessionItems(remote.runtime, remote.serverKey, remote.directory, "ko")[0]
    if (!item || typeof item === "string" || !("onSelect" in item)) throw new Error("no item")
    // An SSH conversation has the item too, whether or not a program is chosen.
    item.onSelect()
    await Bun.sleep(0)
    expect(calls).toEqual([["launch", "devbox", "/home/dev/app"]])
  })

  test("command palette: one command with the folder as its detail and both languages to search by", async () => {
    const { entries, calls } = world()
    const commands = entries.commands(local.runtime, local.serverKey, local.directory, "ko")
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      id: "explorer.open",
      group: "project",
      title: "탐색기에서 열기",
      detail: "D:\\projects\\app",
    })
    expect(commands[0]!.keywords).toContain("Open in Explorer")
    expect(commands[0]!.keywords).toContain("explorer")
    await commands[0]!.run()
    await Bun.sleep(0)
    expect(calls).toEqual([["reveal", "D:\\projects\\app"]])
    expect(entries.commands(local.runtime, local.serverKey, undefined, "ko")).toEqual([])
  })
})

describe("where it loads", () => {
  const router = { navigate: () => undefined } as unknown as Router

  test("a host without explorer (browser, phone, 원격 PC window) loads nothing: no entries, so no items", async () => {
    prepareExplorer({ explorer: undefined } as unknown as OwnHost, router)
    await Bun.sleep(20)
    expect(explorerEntries()).toBeUndefined()
  })

  test("the desktop app's host loads the entries once", async () => {
    const { explorer } = world()
    prepareExplorer({ explorer } as unknown as OwnHost, router)
    for (let attempt = 0; attempt < 100 && !explorerEntries(); attempt++) await Bun.sleep(10)
    const first = explorerEntries()
    expect(first).toBeDefined()
    prepareExplorer({ explorer } as unknown as OwnHost, router)
    await Bun.sleep(20)
    expect(explorerEntries()).toBe(first)
  })

  test("first-chunk modules import only the signal; the actions and strings stay lazy (PF5)", async () => {
    for (const file of [
      "shell/session-menu.tsx",
      "sidebar/project-menu.tsx",
      "shell/palette-commands.tsx",
      "shell/app-shell.tsx",
    ]) {
      const text = await source(file)
      expect(text).toContain('from "@/explorer"')
      expect(text).not.toMatch(/@\/explorer\/(actions|strings|settings)/)
    }
    const index = await source("explorer/index.ts")
    expect(index).toContain('import("./actions")')
    expect(index).not.toMatch(/from "\.\/(strings|settings)"/)
    expect(index).toMatch(/import type \{ ExplorerEntries \} from "\.\/actions"/)
  })

  test("the entries are where the spec puts them", async () => {
    expect(await source("shell/session-menu.tsx")).toContain(
      "...(explorerEntries()?.sessionItems(runtime, serverKey, context.directory, i18n.locale()) ?? []),",
    )
    expect(await source("sidebar/project-menu.tsx")).toContain(
      "explorerEntries()?.projectItems(runtime(), props.serverKey, props.directory, i18n.locale())",
    )
    expect(await source("shell/palette-commands.tsx")).toContain("explorerEntries()?.commands(")
    expect(await source("shell/app-shell.tsx")).toContain("onMount(() => prepareExplorer(host, router))")
    expect(await source("remote/settings.tsx")).toContain("<ExplorerSettings />")
  })

  test("the settings page's default is the desktop app's default, and it never names a program itself", async () => {
    const { DEFAULT_TEMPLATE } = await import("./settings")
    expect(DEFAULT_TEMPLATE).toBe(SHELL_TEMPLATE)
    const settings = await source("explorer/settings.tsx")
    expect(settings).toContain("props.explorer.pickProgram()")
    expect(settings).not.toMatch(/pickFile|files\?\.|setProgram/)
  })
})
