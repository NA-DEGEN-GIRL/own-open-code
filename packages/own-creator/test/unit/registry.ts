// A fake npm registry with one package (`yaml` 9.9.9, own's allow-list): a test's C2 dependency installs from it, so no
// test reaches the real registry.
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export interface FakeRegistry {
  readonly url: string
  readonly requests: string[]
  stop(): Promise<void>
}

/** `yaml@9.9.9`: `parse(text)` answers `parsed:<text>`; it has types, no install scripts run. */
export async function startRegistry(): Promise<FakeRegistry> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "own-creator-registry-"))
  const pkg = path.join(work, "package")
  await fs.mkdir(pkg, { recursive: true })
  await fs.writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "yaml",
      version: "9.9.9",
      type: "module",
      main: "index.js",
      types: "index.d.ts",
      // Never run: staging installs with --ignore-scripts.
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('POSTINSTALL_RAN','1')\"" },
    }),
  )
  await fs.writeFile(path.join(pkg, "index.js"), "export function parse(text) { return `parsed:${text}` }\n")
  await fs.writeFile(path.join(pkg, "index.d.ts"), "export declare function parse(text: string): string\n")
  const tarball = path.join(work, "yaml-9.9.9.tgz")
  // Windows' own bsdtar (Git's GNU tar on PATH reads "C:" as a remote host).
  const tool = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"
  const tar = Bun.spawnSync([tool, "-czf", tarball, "-C", work, "package"])
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`)
  const bytes = await fs.readFile(tarball)
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  const shasum = createHash("sha1").update(bytes).digest("hex")
  const requests: string[] = []
  const port = { value: 0 }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request): Response {
      const url = new URL(request.url)
      requests.push(url.pathname)
      const base = `http://127.0.0.1:${port.value}`
      if (url.pathname === "/yaml")
        return Response.json({
          name: "yaml",
          "dist-tags": { latest: "9.9.9" },
          versions: {
            "9.9.9": {
              name: "yaml",
              version: "9.9.9",
              main: "index.js",
              types: "index.d.ts",
              scripts: { postinstall: "node -e 1" },
              dist: { tarball: `${base}/yaml/-/yaml-9.9.9.tgz`, integrity, shasum },
            },
          },
        })
      if (url.pathname === "/yaml/-/yaml-9.9.9.tgz") return new Response(bytes)
      return new Response("not found", { status: 404 })
    },
  })
  port.value = server.port ?? 0
  return {
    url: `http://127.0.0.1:${port.value}/`,
    requests,
    stop: async () => {
      await server.stop(true)
      await fs.rm(work, { recursive: true, force: true })
    },
  }
}
