// The shell's start under each build constant (decisions RL5-2, RL5-3), run for real with Electron stubbed in a
// process of its own (test/helpers/shell-start.ts): the 원격 PC 전용 build registers no service-restart and no
// open-in-browser IPC, and only a development shell loads or trusts a renderer from ELECTRON_RENDERER_URL.
import { describe, expect, test } from "bun:test"
import path from "node:path"

interface Start {
  readonly channels: string[]
  readonly rendererUrl: string | null
  readonly trusted: boolean
  readonly loaded: string[]
}

const ATTACKER = "http://127.0.0.1:9/"

function start(env: Record<string, string>): Start {
  const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "helpers/shell-start.ts")], {
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env, OWN_CLIENT_ONLY: "", OWN_DEV_SHELL: "", ...env },
  })
  const out = run.stdout.toString().trim().split(/\r?\n/).at(-1) ?? ""
  if (run.exitCode !== 0) throw new Error(`shell-start exited ${run.exitCode}: ${run.stderr.toString().slice(-2000)}`)
  return JSON.parse(out) as Start
}

// The first import transpiles upstream's main modules: tens of seconds on a cold transpiler cache.
const TIMEOUT = 180_000

describe("IPC of each build", () => {
  test(
    "the full shell keeps service restart and open in browser",
    () => {
      const channels = start({}).channels
      expect(channels).toContain("own:service.restart")
      expect(channels).toContain("own:support.open-in-browser")
      expect(channels).toContain("own:support.open-logs")
    },
    TIMEOUT,
  )
  test(
    "the client build registers neither; its remote-PC, zoom and quit channels stay",
    () => {
      const channels = start({ OWN_CLIENT_ONLY: "1" }).channels
      expect(channels).not.toContain("own:service.restart")
      expect(channels).not.toContain("own:support.open-in-browser")
      for (const kept of ["own:shell.info", "own:remote-pcs.list", "own:zoom.get", "own:app.quit"])
        expect(channels).toContain(kept)
    },
    TIMEOUT,
  )
})

describe("ELECTRON_RENDERER_URL", () => {
  for (const client of ["", "1"])
    test(
      `a build ignores it (${client ? "client" : "full"} build): oc://renderer loads, the URL's origin is not trusted`,
      () => {
        const result = start({ OWN_CLIENT_ONLY: client, ELECTRON_RENDERER_URL: ATTACKER })
        expect(result.rendererUrl).toBeNull()
        expect(result.trusted).toBe(false)
        expect(result.loaded).toEqual(["oc://renderer/index.html"])
      },
      TIMEOUT,
    )
  test(
    "a development shell (electron-vite dev) still loads own-web's dev server",
    () => {
      const result = start({ OWN_DEV_SHELL: "1", ELECTRON_RENDERER_URL: ATTACKER })
      expect(result.rendererUrl).toBe(ATTACKER)
      expect(result.trusted).toBe(true)
      expect(result.loaded).toEqual([`${ATTACKER}index.html`])
    },
    TIMEOUT,
  )
  test("the constant is set only under electron-vite dev", async () => {
    const config = await Bun.file(path.join(import.meta.dir, "../electron.vite.config.ts")).text()
    expect(config).toContain('"import.meta.env.OWN_DEV_SHELL": JSON.stringify(command === "serve" ? "1" : "")')
  })
})
