// Enable on an SSH host's service (06 §3.6 켜기의 순서, §4.11, §4.13; TG17 enable order): in remote mode an LFS
// repository is refused with `lfs_missing` while the bundled git-lfs is not on the host; with it, the enable op makes
// the bundled tool the repository's LFS filter (`lfs-remote`) before any area folder is made, and asks before it
// shares a folder (`protect-shared`, after the areas). A new area of a team with a shared folder gets `link-shared`
// right after its folder is made and recorded, and a new area of a repository whose filter went missing starts with
// `lfs-remote` again. Remote mode is this process's `Git.useTools` (`RemoteEnv.enter`) over a temp OWN_HOME with a stub
// git-lfs; HOME and XDG_CONFIG_HOME point at temp folders and GIT_CONFIG_NOSYSTEM hides this PC's system filter. Areas
// are code-only, so no checkout runs the stub as a filter. No ACL is applied (the shared record is written as the
// confirmed step would leave it). Fake plugin contexts, a manual clock, a fake own service on 127.0.0.1; fake values
// only.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Shared } from "../../src/assets/shared.js"
import { Controller } from "../../src/controller.js"
import { Lfs } from "../../src/git/lfs.js"
import type { Hub } from "../../src/hub.js"
import { Log } from "../../src/log.js"
import { RemoteEnv } from "../../src/remote/env.js"
import { RemoteLfs } from "../../src/remote/lfs.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { Services } from "../../src/services.js"
import { git, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { MODEL, World, buildId, call, context } from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"

const SLOW = 300_000
const WINDOWS = process.platform === "win32"
const VERSION = "3.8.0"
const STAR = Preset.ID.create()

const box = temp("own-team-t3-remote-")
const USER = path.join(box.root, "user")
const XDG = path.join(box.root, "xdg")
const SAVED = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
}

beforeAll(() => {
  write(USER, { ".gitconfig": "[user]\n\tname = global fixture\n" })
  write(XDG, { "git/config": "[core]\n\teditor = true\n" })
  process.env.HOME = USER
  process.env.XDG_CONFIG_HOME = XDG
  process.env.GIT_CONFIG_NOSYSTEM = "1"
})

afterAll(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  box.dispose()
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12345\n`

/** The judge's proposal: `assets/` is heavy, `weights/` shared, one new area. */
const PROPOSAL = JSON.stringify({
  version: 1,
  heavy: [{ dir: "assets", why: "큰 파일" }],
  shared: [{ dir: "weights", why: "읽기 전용 데이터" }],
  areas: [{ slug: "ui", name: "화면", create: { from: "main" } }],
})

let count = 0

/** A repository whose `assets/*.bin` are LFS pointers, with an ignored `weights/` folder in the home. */
function lfsRepo() {
  const home = init(path.join(box.root, `r${++count}`, "home"))
  write(home, {
    ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    ".gitignore": "weights/\n",
    "README.md": "# remote\n",
    "src/app.ts": "export const app = 1\n",
    "assets/model.bin": POINTER,
  })
  git(home, ["add", "-A"])
  git(home, ["commit", "-q", "-m", "lfs"])
  write(home, { "weights/model.pt": "weights\n" })
  return home
}

/** A temp OWN_HOME; with `tool`, a stub git-lfs in tools/git-lfs/<ver>/ and `current` pointing at that folder. */
function ownHome(input: { readonly tool: boolean }) {
  const home = path.join(box.root, `own${++count}`)
  fs.mkdirSync(home, { recursive: true })
  if (!input.tool) return home
  const dir = path.join(home, "tools", "git-lfs", VERSION)
  write(dir, { "git-lfs": `#!/bin/sh\necho "git-lfs/${VERSION} (GitHub; linux amd64; stub)"\n` })
  fs.chmodSync(path.join(dir, "git-lfs"), 0o755)
  if (WINDOWS) write(dir, { "git-lfs.cmd": `@echo git-lfs/${VERSION} (GitHub; windows amd64; stub)\r\n` })
  fs.symlinkSync(WINDOWS ? dir : VERSION, RemoteEnv.tools(home), WINDOWS ? "junction" : "dir")
  return home
}

/** The host's own service: conversations, session create, the judge's answer. */
class Backend {
  readonly service: FakeService = start()
  readonly sessions = new Map<string, { directory: string; model?: Model.Ref }>()

  constructor() {
    const routes = this.service.routes
    routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    routes.set("GET /api/session", (request) =>
      Response.json({
        data: [...this.sessions]
          .filter(([, stored]) => request.query.directory === undefined || stored.directory === request.query.directory)
          .map(([id, stored]) => view(id, stored)),
        cursor: {},
      }),
    )
    routes.set("POST /api/worktree/refresh", () => new Response(null, { status: 204 }))
    cleanups.push(() => this.service.stop())
  }

  add(id: string, directory: string, model?: Model.Ref) {
    const stored = { directory, ...(model === undefined ? {} : { model }) }
    this.sessions.set(id, stored)
    const at = `/api/session/${id}`
    const routes = this.service.routes
    routes.set(`GET ${at}`, () => Response.json({ data: view(id, stored) }))
    routes.set(`GET ${at}/inbox`, () => Response.json({ data: [] }))
    routes.set(`GET ${at}/message`, () => Response.json({ data: [], cursor: {} }))
    routes.set(`POST ${at}/generate`, () => Response.json({ data: { text: PROPOSAL } }))
  }
}

function view(id: string, stored: { readonly directory: string; readonly model?: Model.Ref }) {
  return {
    ...session({ id, directory: stored.directory, ...(stored.model ? { model: stored.model } : {}) }),
    time: { created: 1, updated: 2 },
  }
}

const Started = Schema.Struct({ opID: OwnTeam.OpID })

/** A controller of the host's service over `own`, in remote mode, with the plugin's RPC groups and fake features. */
function boot(own: string, home: string) {
  const backend = new Backend()
  const user = SessionID.create()
  backend.add(user, home, MODEL)
  const world = new World()
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: "openai" }],
  }))
  world.accounts.set("presets.list", () => ({ groups: [{ group: "codex", defaultModel: null, star: STAR }] }))
  const features: Partial<Services.Factories> = {
    safePoint: () => ({ check: async () => ({ ok: true }) }),
    main: () => ({
      create: async (input) => {
        backend.add(input.sessionID, input.directory, input.model)
        return { ok: true, sessionID: input.sessionID }
      },
      model: async () => MODEL,
    }),
    owner: (services) => ({
      create: async (made) => {
        const found = await services.registry.areas.get(made.teamID, made.areaID)
        if (!found) return Services.failure("not_found", "no area", { what: "area", id: made.areaID })
        const sessionID = SessionID.create()
        backend.add(sessionID, found.directory)
        await services.write(made.teamID, async () => {
          const current = await services.registry.areas.get(made.teamID, made.areaID)
          if (current)
            await services.registry.areas.put({ ...current, owner: { ...current.owner, sessionID, attached: true } })
        })
        return { ok: true, sessionID }
      },
      attach: async () => ({ ok: true }),
    }),
  }
  const leave = RemoteEnv.enter(own)
  const ctx: Plugin.Context = context(world, { directory: home }).ctx
  const controller = new Controller.Service({
    buildId: buildId("t3-remote"),
    home: own,
    log: Log.silent,
    clock: manual(),
    source: backend.service.source,
    features,
  })
  const detach = controller.attach({ ctx, directory: home, control: true, leader: () => true })
  const published: Hub.Outgoing[] = []
  controller.hub.subscribe((event) => published.push(event))
  controller.start()
  cleanups.push(async () => {
    detach()
    await controller.close()
    leave()
  })
  const services = controller.services
  const handlers = TeamRpc.create({ services, leader: () => true, log: Log.silent })
  // SAFETY (test): every handler takes its method's input and a call context; erased to call them by name.
  const registered = { definition: { methods: {} }, handlers, emitted: [], disposed: false } as never
  const rpc = (method: string, input: unknown) => call(registered, method, input)
  const settled = async (opID: string) => {
    const deadline = Date.now() + 240_000
    for (;;) {
      const op = await services.journal.find(opID)
      if (op && op.state !== "running") return op
      if (Date.now() > deadline) throw new Error(`op ${opID} still runs`)
      await Bun.sleep(25)
    }
  }
  return { backend, user, services, published, rpc, settled }
}

/** `git config --file <common dir>/config --get <key>`, or `null` when unset. */
function local(home: string, key: string) {
  const result = Bun.spawnSync(["git", "config", "--file", path.join(home, ".git", "config"), "--get", key], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

describe("enable on an SSH host (06 §3.6, §4.13)", () => {
  test(
    "without the bundled git-lfs an LFS repository answers lfs_missing and nothing is made",
    async () => {
      const home = lfsRepo()
      const h = boot(ownHome({ tool: false }), home)
      expect(await h.rpc("enable", { directory: home, sessionID: h.user })).toMatchObject({
        type: "lfs_missing",
        data: { tool: "git-lfs", version: null },
      })
      expect(await h.services.registry.teams.list()).toEqual([])
      expect(fs.existsSync(`${home}-team`)).toBe(false)
      expect(local(home, "filter.lfs.process")).toBeNull()
    },
    SLOW,
  )

  test(
    "lfs-remote runs before any worktree is made, the shared folder is asked after the areas, then new areas link it",
    async () => {
      const home = lfsRepo()
      const own = ownHome({ tool: true })
      const h = boot(own, home)
      const opID = Schema.decodeUnknownSync(Started)(await h.rpc("enable", { directory: home, sessionID: h.user })).opID
      const waiting = await h.settled(opID)
      expect(waiting.state).toBe("waiting")
      const kinds = waiting.steps.map((step) => step.kind)
      const lfs = kinds.indexOf(RemoteLfs.KIND)
      const made = kinds.indexOf("worktree-create")
      const asked = kinds.indexOf(Shared.KIND.protect)
      expect(lfs).toBeGreaterThan(0)
      expect(made).toBeGreaterThan(lfs)
      // One lfs-remote for the repository: the new area's own copy of it is left out.
      expect(kinds.filter((kind) => kind === RemoteLfs.KIND)).toHaveLength(1)
      expect(asked).toBeGreaterThan(made)
      expect(waiting.steps[asked]).toMatchObject({ mode: "confirm", state: "needs_confirm", args: { name: "weights" } })
      expect(waiting.steps[lfs]?.state).toBe("done")
      expect(local(home, "filter.lfs.process")).toBe(Lfs.filter(RemoteEnv.tools(own))["filter.lfs.process"])
      const team = (await h.services.registry.teams.list())[0]!
      expect(team.env.lfs).toBe("own")
      expect(
        h.published.filter((event) => event.name === "notice" && event.data.kind === "lfs.installed"),
      ).toHaveLength(1)
      const ui = (await h.services.registry.areas.list(team.id)).find((item) => item.id === "ar_ui")
      expect(ui).toMatchObject({ state: "active", shape: "code" })
      expect(git(ui!.directory, ["config", "--get", "filter.lfs.process"]).trim()).toBe(
        Lfs.filter(RemoteEnv.tools(own))["filter.lfs.process"],
      )

      // 두기: the folder is not shared and nothing about it is recorded.
      const step = waiting.steps[asked]!
      expect(
        await h.rpc("op.confirm", { opID, stepID: step.id, choice: "skip", nonce: step.confirm?.nonce }),
      ).toMatchObject({ op: { state: "done" } })
      expect((await h.services.registry.teams.get(team.id))?.shared).toEqual([])

      // A team with a shared folder (as the confirmed step records it; no ACL in this test): a new area links it
      // right after its folder is made and recorded, before its owner.
      const target = path.join(home, "weights")
      await h.services.write(team.id, async () => {
        const current = (await h.services.registry.teams.get(team.id))!
        await h.services.registry.teams.put({
          ...current,
          shared: [{ name: "weights", target, protect: Shared.PROTECT }],
        })
      })
      const reorg = Schema.decodeUnknownSync(Started)(
        await h.rpc("reorg.apply", {
          teamID: team.id,
          proposal: { version: 1, ops: [{ op: "new", slug: "docs", name: "문서" }] },
        }),
      ).opID
      const created = await h.settled(reorg)
      expect(created.state).toBe("done")
      expect(created.steps.map((item) => item.kind)).toEqual([
        "branch-create",
        "worktree-create",
        "area-record",
        Shared.KIND.link,
        "owner-create",
      ])
      expect(created.steps.every((item) => item.state === "done")).toBe(true)
      const docs = (await h.services.registry.areas.list(team.id)).find((item) => item.id === "ar_docs")!
      const stored = (await h.services.registry.teams.get(team.id))!
      expect(await Shared.inspect(docs.directory, stored.shared)).toEqual([{ name: "weights", state: "linked" }])
      expect(fs.readFileSync(path.join(docs.directory, "weights", "model.pt"), "utf8")).toBe("weights\n")

      // The filter went missing (someone unset it): the next new area starts with lfs-remote again.
      git(home, ["config", "--local", "--remove-section", "filter.lfs"])
      const planned = await h.services.features().areas.plan({
        team: stored,
        slug: "tools",
        name: "도구",
        by: "user",
      })
      if (!planned.ok) throw new Error(planned.message)
      expect(planned.steps[0]).toMatchObject({ kind: RemoteLfs.KIND, args: { directory: stored.home.directory } })
    },
    SLOW,
  )
})
