// End to end on a real upstream server with own-accounts loaded (01 §13 "에이전트 접근", PP): under 전체 허용 an agent's
// file tools cannot read `~/.ssh/x` (the built-in list, placed in the service's home folder) nor a file in a folder the
// user adds through `protectedPaths.add` (an existing session follows from its next tool call, its rules untouched), a
// session without an own mode is protected too, and a shell command that names a protected path raises one card that
// says so, while another command runs unasked. Other spellings (a junction in the project, an 8.3 name, an NTFS stream,
// a device prefix, an admin share) reach nothing, and a shell cannot move into a protected folder. The service's home is a temp folder (`HOME` and `USERPROFILE`), the chat
// model a fake DeepSeek-dialect server; the protected files' contents never reach it. Every credential is fake.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  afterToolResult,
  deepseekProvider,
  lastUserText,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  toolError,
  toolParts,
  type FakeCodex,
  type FakeOpenAIChat,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000
const CHAT_KEY = "fake-protected-chat-key"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const SSH_SECRET = "pp-ssh-secret-7d1f"
const BACKUP_SECRET = "pp-backup-secret-2c9a"

const fixture: { codex?: FakeCodex; chat?: FakeOpenAIChat; rig?: PresetRig } = {}

beforeAll(async () => {
  fixture.codex = startFakeCodex()
  fixture.chat = startFakeOpenAIChat({ responder: reply, credentials: { [CHAT_KEY]: { domain: "chat-model" } } })
  fixture.rig = await startPresetRig({
    name: "protected",
    codex: fixture.codex,
    chatgpt: [],
    config: {
      providers: { [CHAT.providerID]: deepseekProvider(fixture.chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) },
    },
    models: [CHAT],
    userProfile: true,
  })
  const rig = fixture.rig
  await fs.mkdir(path.join(rig.server.paths.home, ".ssh"), { recursive: true })
  await fs.writeFile(path.join(rig.server.paths.home, ".ssh", "x"), SSH_SECRET)
  await fs.mkdir(backups(), { recursive: true })
  await fs.writeFile(path.join(backups(), "y.txt"), BACKUP_SECRET)
  // A link inside the project into ~/.ssh (a dotfiles checkout, or one an agent made).
  await fs.symlink(
    path.join(rig.server.paths.home, ".ssh"),
    path.join(rig.server.paths.workspace, "sshlink"),
    process.platform === "win32" ? "junction" : "dir",
  )
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop()])
}, 60_000)

describe("protected paths under 전체 허용 (PP)", () => {
  test(
    "~/.ssh/x and a user-listed folder cannot be read; the list reaches the session without rewriting its rules",
    async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: CHAT, title: "protected full" })
      await rig.call("session.approval.set", { sessionID: session.id, mode: "full" })
      const ssh = path.join(rig.server.paths.home, ".ssh", "x")
      const view = await rig.call("protectedPaths.get", {})
      expect(view.home).toBe(rig.server.paths.home)

      expect(await turn(session.id, `[read] ${ssh}`)).toEqual([])
      const denied = (await toolParts(rig.server, session.id, "read")).at(-1)
      expect(denied?.state.status).toBe("error")
      expect(toolError(denied!)).toContain("protected")

      // A plain file in the same folder's parent is read as usual (the mode is 전체 허용).
      const plain = path.join(path.dirname(backups()), "plain.txt")
      await fs.writeFile(plain, "pp-plain-text")
      expect(await turn(session.id, `[read] ${plain}`)).toEqual([])
      expect((await toolParts(rig.server, session.id, "read")).at(-1)?.state.status).toBe("completed")

      // The user's folder: readable before, protected from the next tool call after `추가`.
      const rules = (await rig.call("session.approval.get", { sessionID: session.id })).rules
      expect(await rig.call("protectedPaths.add", { path: backups() })).toMatchObject({
        user: [{ path: backups(), resolved: backups() }],
      })
      expect(await turn(session.id, `[read] ${path.join(backups(), "y.txt")}`)).toEqual([])
      const user = (await toolParts(rig.server, session.id, "read")).at(-1)
      expect(user?.state.status).toBe("error")
      expect(toolError(user!)).toContain("protected")
      expect((await rig.call("session.approval.get", { sessionID: session.id })).rules).toEqual(rules)
      expect((await rig.call("session.approval.get", { sessionID: session.id })).mode).toBe("full")

      const sent = required(fixture.chat)
        .requests.map((request) => request.body)
        .join("\n")
      expect(sent).not.toContain(SSH_SECRET)
      expect(sent).not.toContain(BACKUP_SECRET)
      expect(sent).toContain("pp-plain-text")
    },
    TURN_TIMEOUT,
  )

  test(
    "a shell command naming a protected path asks once with the path on the card; another command runs unasked",
    async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: CHAT, title: "protected shell" })
      await rig.call("session.approval.set", { sessionID: session.id, mode: "full" })
      const asked = await turn(session.id, `[shell] cat "${path.join(rig.server.paths.home, ".ssh", "x")}"`, "reject")
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ action: "shell" })
      expect(String(asked[0]?.message)).toContain("에이전트가 못 여는 파일·폴더")
      expect(String(asked[0]?.message)).toContain(path.join(rig.server.paths.home, ".ssh", "x"))

      expect(await turn(session.id, "[shell] echo pp-hello")).toEqual([])
      const ran = (await toolParts(rig.server, session.id, "shell")).at(-1)
      expect(ran?.state.status).toBe("completed")
      expect(JSON.stringify(ran?.state)).toContain("pp-hello")
      expect(
        required(fixture.chat)
          .requests.map((request) => request.body)
          .join("\n"),
      ).not.toContain(SSH_SECRET)
    },
    TURN_TIMEOUT,
  )

  test(
    "other spellings reach nothing: a junction in the project, an 8.3 name, a stream, a device prefix, an admin share",
    async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: CHAT, title: "protected spellings" })
      await rig.call("session.approval.set", { sessionID: session.id, mode: "full" })
      const ssh = path.join(rig.server.paths.home, ".ssh")
      const key = path.join(ssh, "x")
      const short = process.platform === "win32" ? shortName(ssh) : undefined
      const spellings = [
        "sshlink/x",
        ...(process.platform === "win32"
          ? [
              `${key}::$DATA`,
              `${ssh}::$INDEX_ALLOCATION\\x`,
              `\\\\?\\${key}`,
              `\\\\localhost\\${key[0]}$${key.slice(2)}`,
              ...(short === undefined ? [] : [path.join(short, "x")]),
            ]
          : []),
      ]
      for (const spelling of spellings) {
        expect(await turn(session.id, `[read] ${spelling}`)).toEqual([])
        const part = (await toolParts(rig.server, session.id, "read")).at(-1)
        expect([spelling, part?.state.status]).toEqual([spelling, "error"])
        expect(toolError(part!)).toContain("protected")
      }
      // A write through the short name or the junction does not land in ~/.ssh.
      const written = short === undefined ? "sshlink/authorized_keys" : path.join(short, "authorized_keys")
      expect(await turn(session.id, `[write] ${written}|pp-attacker-key`)).toEqual([])
      expect((await toolParts(rig.server, session.id, "write")).at(-1)?.state.status).toBe("error")
      expect(await fs.readdir(ssh)).toEqual(["x"])
      // A search through the junction leaves the file out.
      // The pattern is the secret's start, so the prompt never holds the secret itself.
      expect(await turn(session.id, "[grep] pp-ssh-secret|sshlink")).toEqual([])
      const searched = JSON.stringify((await toolParts(rig.server, session.id, "grep")).at(-1)?.state)
      expect(searched).toContain("left out")
      expect(searched).not.toContain(SSH_SECRET)
      expect(
        required(fixture.chat)
          .requests.map((request) => request.body)
          .join("\n"),
      ).not.toContain(SSH_SECRET)
    },
    TURN_TIMEOUT,
  )

  test(
    "a shell that moves into a protected folder is refused; one that moves to the home folder and names it asks",
    async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: CHAT, title: "protected cd" })
      await rig.call("session.approval.set", { sessionID: session.id, mode: "full" })
      expect(await turn(session.id, "[shell] cd ~/.ssh && cat x", "reject")).toEqual([])
      const refused = (await toolParts(rig.server, session.id, "shell")).at(-1)
      expect(refused?.state.status).toBe("error")
      expect(toolError(refused!)).toContain("protected")
      for (const command of ["cd ~ && cat .ssh/x", 'cat "$HOME"/.ssh/x']) {
        const asked = await turn(session.id, `[shell] ${command}`, "reject")
        expect([command, asked.filter((card) => card.action === "shell").map((card) => String(card.message))]).toEqual([
          command,
          [expect.stringContaining("에이전트가 못 여는 파일·폴더")],
        ])
      }
      // Printing a path is not opening it.
      expect(await turn(session.id, "[shell] echo remember ~/.ssh")).toEqual([])
      expect(
        required(fixture.chat)
          .requests.map((request) => request.body)
          .join("\n"),
      ).not.toContain(SSH_SECRET)
    },
    TURN_TIMEOUT,
  )

  test(
    "a session without an own approval mode (기본 규칙) is protected too",
    async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: CHAT, title: "protected default" })
      expect((await rig.call("session.approval.get", { sessionID: session.id })).mode).toBe("custom")
      expect(await turn(session.id, `[read] ${path.join(rig.server.paths.home, ".ssh", "x")}`)).toEqual([])
      expect((await toolParts(rig.server, session.id, "read")).at(-1)?.state.status).toBe("error")
    },
    TURN_TIMEOUT,
  )
})

test("no hook failed", () => {
  expect(required(fixture.rig).server.logs()).not.toMatch(/hook_failed/)
})

// ---------------------------------------------------------------------------------------------------------------

/** The folder the user adds: beside the temp home, outside the workspace. */
function backups() {
  return path.join(required(fixture.rig).server.paths.root, "wallet-backups")
}

/** One prompt; every card it raises is answered (`once` unless told). Returns the cards in order. */
async function turn(sessionID: string, text: string, decision: "once" | "reject" = "once") {
  const rig = required(fixture.rig)
  const seen = new Set(rig.events.events)
  const asked: Array<{ action: unknown; resources: unknown; message: unknown }> = []
  const state = { done: false }
  const answering = (async () => {
    while (!state.done) {
      const fresh = rig.events.events.filter(
        (event) => !seen.has(event) && event.type === "permission.asked" && event.data.sessionID === sessionID,
      )
      for (const event of fresh) {
        seen.add(event)
        asked.push({ action: event.data.action, resources: event.data.resources, message: event.data.message })
        await rig.server.call("POST", `/api/session/${sessionID}/permission/${String(event.data.id)}/reply`, {
          body: { decision },
        })
      }
      await Bun.sleep(100)
    }
  })()
  await rig.server.prompt(sessionID, text)
  await rig.server.waitIdle(sessionID).finally(() => {
    state.done = true
  })
  await answering
  return asked
}

/** The chat model: `[read] <path>` reads a file, `[shell] <command>` runs a command; a result gets text. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: "끝" }
  const text = lastUserText(request)
  if (text.startsWith("[read] "))
    return { type: "tool-call", name: "read", input: { path: text.slice("[read] ".length) } }
  if (text.startsWith("[write] ")) {
    const [file, content] = text.slice("[write] ".length).split("|")
    return { type: "tool-call", name: "write", input: { path: file, content } }
  }
  if (text.startsWith("[grep] ")) {
    const [pattern, searched] = text.slice("[grep] ".length).split("|")
    return { type: "tool-call", name: "grep", input: { pattern, path: searched } }
  }
  if (text.startsWith("[shell] "))
    return { type: "tool-call", name: "shell", input: { command: text.slice("[shell] ".length) } }
  return { type: "text", text: "답변" }
}

/** The 8.3 short form of an existing folder (Windows), or undefined. */
function shortName(absolute: string) {
  const ran = Bun.spawnSync([
    "powershell",
    "-NoProfile",
    "-Command",
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${absolute}').ShortPath`,
  ])
  const out = ran.stdout.toString().trim()
  return ran.exitCode === 0 && out !== "" && out.toLowerCase() !== absolute.toLowerCase() ? out : undefined
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
