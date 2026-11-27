import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.each(["--version", "-v"])(
  "%s prints the version without initializing CLI state",
  async (flag) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "own-bootstrap-"))
    try {
      const child = Bun.spawn(
        [process.execPath, path.resolve(import.meta.dir, "../../../packages/cli/src/bootstrap.ts"), flag],
        {
          cwd: root,
          env: {
            ...process.env,
            OPENCODE_SSH_ASKPASS_PORT: undefined,
            OPENCODE_CONFIG_DIR: path.join(root, "config"),
            OPENCODE_TEST_HOME: root,
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_STATE_HOME: path.join(root, "state"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            // Bun 1.4 writes its transpiler cache under XDG_CACHE_HOME; that is the runtime, not CLI state.
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).toBe(0)
      expect(stdout.trim()).toBe("local")
      expect(stderr).toBe("")
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)
