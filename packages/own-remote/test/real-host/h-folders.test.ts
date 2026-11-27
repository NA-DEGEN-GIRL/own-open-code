// Real-host phase H (03 §5.1, §18.3, 04 §17.4; 2.2.6-own.16): the host's own default conversation folder and folder
// picker, through this run's release service (stack.ts) connected to the phase A host as in phase C. Opt-in:
// OWN_REAL_HOST=build-host (or lab; nothing heavy here).
//
// Everything this phase writes on the host lives in one temp root /tmp/own-<uid>-rh-folders-<rand>; afterAll removes it
// and puts the host service's folder back to its built-in default (z-cleanup removes a leftover root too). The built-in
// default is only read, never created: on the user's host it is the user's real chat folder. Checks:
//  - default: a host without the older default answers `~/own-chats` (or keeps `~/Documents/Own OpenCode` /
//    `~/Own OpenCode` where one exists), not created by reading it;
//  - custom: `conversationFolder.set` with a folder of the temp root, `ensure` creates it with a write check, a session
//    started there (as the new-conversation screen does) runs a turn through the broker and its shell works in it;
//    back to the default leaves the folder and the built-in default untouched;
//  - picker: `/` leaves out `lost+found` (the host's ext4 root) and counts it, opening `/lost+found` says no permission
//    with its owner root, a folder of the temp root without permissions is locked with the host user as owner,
//    `새 폴더` makes a Korean-named folder and refuses the same name again.
// Model traffic only to the fakes on this PC; no credential is real.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { lastUserText, type Responder } from "../../../own-accounts/test/e2e-kit"
import { ALIAS, enabled, evidence, hostSh, kv } from "./env.js"
import { MODEL, ensureCompat, startStack, until, type Stack } from "./stack.js"
import { OwnAccounts } from "@own/protocol"
import {
  accountsOutput,
  errorOf,
  local,
  remoteAccounts,
  remoteFetch,
  remoteSession,
  type Endpoint,
} from "./team-fixture.js"

const run = enabled ? describe : describe.skip

/**
 * The one line the user runs on the host (own/reports/ssh-new-chat-2026-11-22.md) to set the host's default
 * conversation folder without the app: the host service's registration file gives its address and password, the
 * control folder is own's (`~/.local/share/own-open-code/control`). Only python3's standard library.
 */
function setFolderCommand(folder: string) {
  const script = [
    "import json,os,base64,urllib.request as u",
    'r=json.load(open(os.path.expanduser("~/.local/state/opencode/service-own.json")))',
    'c=os.path.expanduser("~/.local/share/own-open-code/control")',
    `b=json.dumps({"input":{"path":${JSON.stringify(folder)}}}).encode()`,
    'a="Basic "+base64.b64encode(("opencode:"+r["password"]).encode()).decode()',
    'q=u.Request(r["url"]+"/api/rpc/own.accounts/conversationFolder.set?location%5Bdirectory%5D="+u.quote(c),b,{"content-type":"application/json","authorization":a})',
    "print(u.urlopen(q).read().decode())",
  ].join(";")
  return `python3 -c '${script}'`
}
const CLIENT = "real-host-h"
const PROMPT = "[folderless] 안녕하세요"
const ANSWER = "기본 대화 폴더에서 답했어요"

run(`real host ${ALIAS}: the host's default conversation folder and folder picker (phase H)`, () => {
  const state = {} as {
    stack: Stack
    hostId: string
    endpoint: Endpoint
    alpha: string
    /** The host's temp root and its user. */
    root: string
    user: string
    /** `~/own-chats` existed before the phase (it must look the same after). */
    chatsBefore: string
    results: Record<string, unknown>
  }
  state.results = {}

  const respond: Responder = (request) =>
    lastUserText(request).includes("[folderless]") ? { type: "text" as const, text: ANSWER } : undefined

  const host = async () => {
    const listed = await local(state.stack, "hosts.list", {})
    const found = listed.hosts.find((item) => item.id === state.hostId)
    if (!found) throw new Error(`host ${state.hostId} is not listed`)
    return found
  }
  const accounts = async <M extends OwnAccounts.MethodName>(method: M, input: unknown) =>
    accountsOutput(method, await remoteAccounts(state.endpoint, method, input))
  /** The refusal of a host own.accounts call: its error type and data. */
  const refusal = async (method: OwnAccounts.MethodName, input: unknown) => {
    const answer = await remoteAccounts(state.endpoint, method, input)
    expect(answer.status).toBeGreaterThanOrEqual(400)
    const error = errorOf(answer)
    return { type: error?.type, data: error?.data as Record<string, unknown> | undefined }
  }
  const chatsState = async () =>
    kv((await hostSh(`if [ -e "$HOME/own-chats" ]; then echo CHATS=present; else echo CHATS=absent; fi`)).stdout).get(
      "CHATS",
    ) ?? "unknown"

  beforeAll(async () => {
    state.stack = await startStack({ responder: respond })
    state.hostId = state.stack.hostId
    state.alpha = String((await ensureCompat(state.stack, "Alpha")).providerID)
    await local(state.stack, "connect", { hostId: state.hostId, clientId: CLIENT })
    await until(
      async () => {
        const view = await host()
        return view.stage === "ready" || view.paused ? view : undefined
      },
      240_000,
      500,
    )
    expect((await host()).stage).toBe("ready")
    const resolved = await local(state.stack, "resolve", { hostId: state.hostId })
    if (resolved.url === null) throw new Error(`host not ready: ${resolved.stage}`)
    state.endpoint = { url: resolved.url, token: resolved.token, controlDir: resolved.controlDir }
    const made = await hostSh(String.raw`set -eu
umask 022
root=$(mktemp -d "/tmp/own-$(id -u)-rh-folders-XXXXXXXX")
mkdir -p "$root/browse/open" "$root/browse/closed"
chmod 000 "$root/browse/closed"
echo "ROOT=$root"
echo "USER=$(id -un)"
`)
    const facts = kv(made.stdout)
    state.root = facts.get("ROOT") ?? ""
    state.user = facts.get("USER") ?? ""
    if (made.code !== 0 || !/^\/tmp\/own-\d+-rh-folders-[A-Za-z0-9]{8}$/.test(state.root))
      throw new Error(`host root: ${made.stdout} ${made.stderr}`)
    state.chatsBefore = await chatsState()
  }, 600_000)

  afterAll(async () => {
    if (state.endpoint) await remoteAccounts(state.endpoint, "conversationFolder.set", { path: null }).catch(() => {})
    if (state.root)
      await hostSh(`chmod -R u+rwx '${state.root}' 2>/dev/null; rm -rf '${state.root}'; echo DONE=1`).catch(() => {})
    evidence("h-folders.json", state.results)
    await state.stack?.stop()
  }, 120_000)

  test("the host's built-in default is ~/own-chats (or an older default that exists), only read", async () => {
    const view = await accounts("conversationFolder.get", {})
    state.results.builtin = view
    const home = kv((await hostSh(`echo "HOME=$HOME"`)).stdout).get("HOME") ?? ""
    expect(view.custom).toBe(false)
    expect([`${home}/own-chats`, `${home}/Documents/Own OpenCode`, `${home}/Own OpenCode`]).toContain(view.path)
    expect(view.defaultPath).toBe(view.path)
    // Reading it creates nothing.
    expect(await chatsState()).toBe(state.chatsBefore)
  })

  test("a custom folder on the host: set and ensure create it; a conversation there runs a turn and works in it", async () => {
    const chosen = `${state.root}/새 대화 폴더`
    const saved = await accounts("conversationFolder.set", { path: chosen })
    expect(saved).toMatchObject({ path: chosen, custom: true, exists: true })
    expect(await accounts("conversationFolder.ensure", {})).toMatchObject({ path: chosen, exists: true })
    const facts = kv(
      (
        await hostSh(
          `d='${chosen}'; [ -d "$d" ] && echo DIR=1; [ -w "$d" ] && echo WRITABLE=1; echo OWNER=$(stat -c %U "$d")`,
        )
      ).stdout,
    )
    expect([facts.get("DIR"), facts.get("WRITABLE"), facts.get("OWNER")]).toEqual(["1", "1", state.user])

    // What the new-conversation screen does after `ensure`: a session in the folder, then the first prompt.
    const sessionID = await remoteSession(state.endpoint, {
      directory: chosen,
      title: "폴더 없이 원격 대화",
      model: { providerID: state.alpha, id: MODEL },
    })
    const before = state.stack.chat.requests.length
    await remoteFetch(state.endpoint, "POST", `/api/session/${sessionID}/prompt`, {
      body: { text: PROMPT },
      directory: chosen,
    })
    await remoteFetch(state.endpoint, "POST", `/api/experimental/session/${sessionID}/wait`, { directory: chosen })
    expect(state.stack.chat.requests.length).toBeGreaterThan(before)
    const info = (await remoteFetch(state.endpoint, "GET", `/api/session/${sessionID}`, { directory: chosen }))
      .body as { data?: { location?: { directory?: string } }; location?: { directory?: string } }
    expect((info.data ?? info).location?.directory).toBe(chosen)
    const created = await remoteFetch(
      state.endpoint,
      "POST",
      `/api/shell?location%5Bdirectory%5D=${encodeURIComponent(chosen)}`,
      {
        body: { command: "pwd; touch from-the-agent", cwd: chosen, timeout: 60_000, metadata: { sessionID } },
        directory: chosen,
      },
    )
    expect(created.status).toBe(200)
    await until(
      async () =>
        kv((await hostSh(`[ -f '${chosen}/from-the-agent' ] && echo MADE=1 || echo MADE=0`)).stdout).get("MADE") ===
        "1",
      60_000,
      500,
    )
    state.results.custom = { chosen, sessionID }

    // Back to the default: nothing moves, the built-in default is not created.
    const reset = await accounts("conversationFolder.set", { path: null })
    expect(reset.custom).toBe(false)
    expect(kv((await hostSh(`[ -d '${chosen}' ] && echo KEPT=1`)).stdout).get("KEPT")).toBe("1")
    expect(await chatsState()).toBe(state.chatsBefore)
  }, 300_000)

  test("the report's one-line command on the host sets the folder through the host's own service", async () => {
    const chosen = `${state.root}/one-line`
    const ran = await hostSh(setFolderCommand(chosen))
    state.results.oneLine = { code: ran.code, stdout: ran.stdout.slice(0, 400) }
    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain(`"custom":true`)
    expect(await accounts("conversationFolder.get", {})).toMatchObject({ path: chosen, custom: true, exists: true })
    expect((await accounts("conversationFolder.set", { path: null })).custom).toBe(false)
  })

  test("~ and relative paths: ~ alone is refused as the home folder; a relative path is refused", async () => {
    expect((await refusal("conversationFolder.set", { path: "~" })).data).toMatchObject({ reason: "home" })
    expect((await refusal("conversationFolder.set", { path: "chats" })).data).toMatchObject({ reason: "relative" })
    expect((await accounts("conversationFolder.get", {})).custom).toBe(false)
  })

  test("the picker: / hides lost+found, /lost+found says no permission (root), a closed folder is locked", async () => {
    const root = await accounts("folderPicker.list", { path: "/" })
    const lostFound = kv((await hostSh(`[ -d /lost+found ] && echo LF=1 || echo LF=0`)).stdout).get("LF") === "1"
    state.results.root = { hidden: root.hidden, lostFound, names: root.entries.length }
    expect(root.entries.map((entry) => entry.name)).not.toContain("lost+found")
    expect(root.hidden).toBe(lostFound ? 1 : 0)
    if (lostFound)
      expect(await refusal("folderPicker.list", { path: "/lost+found" })).toEqual({
        type: "folder_list_unavailable",
        data: { reason: "denied", path: "/lost+found", owner: "root" },
      })
    const browse = await accounts("folderPicker.list", { path: `${state.root}/browse` })
    // The service answers in the directory's order; the pickers sort.
    expect(browse.entries.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "closed", locked: true, owner: state.user },
      { name: "open", locked: false },
    ])
    expect((await refusal("folderPicker.list", { path: `${state.root}/nowhere` })).data).toMatchObject({
      reason: "missing",
    })
  })

  test("새 폴더 on the host: a Korean name is made there; the same name again is refused as existing", async () => {
    const parent = `${state.root}/browse/open`
    const made = await accounts("folderPicker.create", { parent, name: " 새 프로젝트 " })
    expect(made).toEqual({ path: `${parent}/새 프로젝트` })
    expect(kv((await hostSh(`[ -d '${parent}/새 프로젝트' ] && echo DIR=1`)).stdout).get("DIR")).toBe("1")
    expect(await refusal("folderPicker.create", { parent, name: "새 프로젝트" })).toEqual({
      type: "folder_create_unavailable",
      data: { reason: "exists", path: `${parent}/새 프로젝트` },
    })
    expect((await refusal("folderPicker.create", { parent, name: "a/b" })).data).toMatchObject({ reason: "name" })
    expect(
      (await refusal("folderPicker.create", { parent: `${state.root}/browse/closed`, name: "x" })).data,
    ).toMatchObject({ reason: "denied" })
  })
})
