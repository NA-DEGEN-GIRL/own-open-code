import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { removeTree } from "./remove.js"

/**
 * A git server on 127.0.0.1 for the `URL로 설치` tests (09 §9.5): `git http-backend` (smart HTTP, protocol v2) behind
 * `Bun.serve`, serving bare repositories under one temp folder. No real network. `filter: false` serves a repository
 * that refuses partial clone, like a server that would send every file. Each repository's fetches are counted, and
 * every request is logged, so a test can tell what was downloaded when.
 */

export interface Server extends AsyncDisposable {
  readonly origin: string
  /** Bare repository `<name>.git` built from `files`; returns its URL. Later calls with the same name push a commit. */
  repo(name: string, files: Readonly<Record<string, string>>, options?: { readonly filter?: boolean }): Promise<string>
  /** `POST …/git-upload-pack` requests per repository name. */
  readonly fetches: Map<string, number>
  readonly root: string
  close(): Promise<void>
}

/** git with a fixture identity, for building the served repositories. */
export async function git(args: ReadonlyArray<string>, cwd?: string) {
  const child = Bun.spawn(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: isolated(),
    windowsHide: true,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}

/** The environment of the fixtures' git and of `git http-backend`: never a prompt. */
export function isolated() {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" }
}

export async function serve(): Promise<Server> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-import-git-"))
  const fetches = new Map<string, number>()
  const backend = path.join(
    (await git(["--exec-path"])).trim(),
    process.platform === "win32" ? "git-http-backend.exe" : "git-http-backend",
  )
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const name = url.pathname.split("/")[1]?.replace(/\.git$/, "") ?? ""
      if (request.method === "POST" && url.pathname.endsWith("/git-upload-pack"))
        fetches.set(name, (fetches.get(name) ?? 0) + 1)
      const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : undefined
      const child = Bun.spawn([backend], {
        stdin: body ?? "ignore",
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
        env: {
          ...isolated(),
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          ...(body === undefined ? {} : { CONTENT_LENGTH: String(body.length) }),
          HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
          GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
          REMOTE_ADDR: "127.0.0.1",
        },
      })
      const output = Buffer.from(await new Response(child.stdout).arrayBuffer())
      await child.exited
      // CGI: header lines, an empty line, the body. git ends its header lines with CRLF; accept LF too.
      const text = output.toString("latin1")
      const end = /\r?\n\r?\n/.exec(text)
      if (end === null) return new Response("bad gateway", { status: 502 })
      const fields = text
        .slice(0, end.index)
        .split(/\r?\n/)
        .flatMap((line) => {
          const index = line.indexOf(":")
          return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1).trim()] as const] : []
        })
      const status = fields.find((field) => field[0].toLowerCase() === "status")
      return new Response(output.subarray(end.index + end[0].length), {
        status: status === undefined ? 200 : Number.parseInt(status[1], 10),
        headers: fields.filter((field) => field[0].toLowerCase() !== "status").map((field) => [field[0], field[1]]),
      })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const close = async () => {
    server.stop(true)
    await removeTree(root)
  }
  return {
    origin,
    fetches,
    root,
    async repo(name, files, options = {}) {
      const bare = path.join(root, `${name}.git`)
      const work = path.join(root, `${name}.work`)
      const fresh = !(await fs.stat(bare).then(
        () => true,
        () => false,
      ))
      if (fresh) {
        await git(["init", "--bare", "-b", "main", bare])
        await git(["init", "-b", "main", work])
        await git(["config", "uploadpack.allowFilter", options.filter === false ? "false" : "true"], bare)
        await git(["config", "uploadpack.allowAnySHA1InWant", "true"], bare)
        await git(["config", "core.symlinks", "true"], work)
      }
      for (const [file, text] of Object.entries(files)) {
        const target = path.join(work, ...file.split("/"))
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, text)
      }
      await git(["add", "-A"], work)
      await git(["commit", "-q", "-m", fresh ? "first" : "next"], work)
      await git(["push", "-q", bare, "main"], work)
      return `${origin}/${name}.git`
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}
