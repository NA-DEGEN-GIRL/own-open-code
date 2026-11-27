// 기본 대화 폴더 (03 §5.1) on a real upstream server with own-accounts loaded from its package: the built-in default
// follows the service's home (here the harness's temp home, never the real Documents), is created only by `ensure`, a
// session can start in it right away, and the user's choice is stored by the service, so it survives a restart. Fake
// credentials only; the server binds 127.0.0.1 and everything lives in its temp root.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { opencodeConfig } from "../e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer, type OpencodeServer } from "../e2e-kit/harness/opencode-server"
import { removeTree } from "../e2e-kit/harness/remove"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000

const fixture: { server?: OpencodeServer; root?: string } = {}

/** Both boots share one temp root (the database and the home folder), removed after the file. */
function boot(root: string) {
  return startOpencodeServer({
    root,
    // Guard 1 (01 §14.5): without the launcher's marker own-accounts registers `health` only.
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) =>
      opencodeConfig({
        providers: {},
        plugins: [
          {
            package: path.join(REPO_ROOT, "packages/own-accounts"),
            options: { home: paths.ownHome, buildId: `conversation-folder-e2e-${process.pid}`, vault: "memory" },
          },
        ],
      }),
  })
}

function server() {
  if (!fixture.server) throw new Error("server not started")
  return fixture.server
}

async function rpc(method: string, input: unknown) {
  const current = server()
  const control = path.join(current.paths.ownHome, "control")
  await fs.mkdir(control, { recursive: true })
  const response = await current.request("POST", `/api/rpc/own.accounts/${method}`, {
    body: { input },
    query: { "location[directory]": control },
    directory: control,
  })
  const body = (await response.json()) as Record<string, unknown>
  return { status: response.status, body }
}

async function output(method: string, input: unknown) {
  const result = await rpc(method, input)
  if (result.status !== 200) throw new Error(`${method}: ${result.status} ${JSON.stringify(result.body)}`)
  return result.body.output as { path: string; defaultPath: string; custom: boolean; exists: boolean }
}

beforeAll(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-folder-"))
  fixture.server = await boot(fixture.root)
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.server?.stop()
  if (fixture.root) await removeTree(fixture.root)
}, 60_000)

describe("default conversation folder on a real service", () => {
  test("the built-in default is under the service's home and appears only on first use", async () => {
    const home = server().paths.home
    const expected = path.join(home, "Documents", "Own OpenCode")
    expect(await output("conversationFolder.get", {})).toEqual({
      path: expected,
      defaultPath: expected,
      custom: false,
      exists: false,
    })
    expect(await fs.stat(expected).catch(() => undefined)).toBeUndefined()
    expect(await output("conversationFolder.ensure", {})).toMatchObject({ path: expected, exists: true })
    expect((await fs.stat(expected)).isDirectory()).toBe(true)
    // A conversation starts in it like in any folder: no Git repository needed.
    const session = await server().createSession({ title: "폴더 없이", directory: expected })
    const info = (await server().call("GET", `/api/session/${session.id}`)) as Record<string, unknown>
    const record = (info.data ?? info) as { location?: { directory?: string } }
    expect(record.location?.directory?.toLowerCase()).toBe(expected.toLowerCase())
  })

  test(
    "the user's folders are stored by the service and survive a restart; reset goes back",
    async () => {
      const chosen = path.join(server().paths.root, "chats")
      expect(await output("conversationFolder.set", { path: chosen })).toMatchObject({
        path: chosen,
        custom: true,
        exists: true,
      })
      // 03 §18.3 폴더 열기 시작 위치, kept beside it.
      const projects = path.join(server().paths.root, "workspace")
      expect((await rpc("folderPicker.set", { start: projects })).body.output).toMatchObject({ start: projects })
      const refused = await rpc("conversationFolder.set", { path: "relative" })
      expect(refused.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(refused.body)).toContain("conversation_folder_unavailable")

      const root = server().paths.root
      await server().stop()
      fixture.server = await boot(root)
      expect(await output("conversationFolder.get", {})).toMatchObject({ path: chosen, custom: true, exists: true })
      expect((await rpc("folderPicker.get", {})).body.output).toEqual({ start: projects, home: server().paths.home })

      const reset = await output("conversationFolder.set", { path: null })
      expect(reset).toMatchObject({ custom: false, path: path.join(server().paths.home, "Documents", "Own OpenCode") })
    },
    BOOT_TIMEOUT,
  )
})
