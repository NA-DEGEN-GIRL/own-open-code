// Files tab e2e backend (03 §19.4, §19.5): the real server from source with a fake OpenAI Responses provider, a git
// workspace with code, Markdown (a relative image and link), a mermaid source, a PNG, a PDF, a binary, a 6 MB log,
// a folder of 3,000 files, a Korean file name and a file outside the workspace; one session whose model writes files
// through the real `write` tool when a prompt says `FILES_WRITE:<path>`. Then Vite dev serves own-web (proxy with
// server-side Basic auth, like e2e/review/backend.ts). Fake credentials only, 127.0.0.1 only; the temp root is removed
// on exit. The state file is `<tmp>/own-web-files-e2e/backend.json`.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { startViteDev } from "../vite-dev"
import { opencodeConfig, openAIResponsesProvider } from "../../../own-accounts/test/e2e-kit/harness/config"
import { startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../../own-accounts/test/e2e-kit/harness/remove"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import type { RecordedRequest, Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"

export const FILES_DEV_PORT = Number(process.env.OWN_WEB_FILES_E2E_PORT ?? 5617)
export const FILES_STATE_FILE = path.join(os.tmpdir(), "own-web-files-e2e", "backend.json")

// Not a "gpt-" id: core swaps write/edit for the patch tool on GPT models (core/src/tool/plugin/patch.ts).
const MODEL = { providerID: "fake-files", id: "files-model" }
const FAKE_KEY = "sk-proj-ownWebFilesFakeKey0000000000000001"
const MANY = 3_000

// Playwright may end this process without the graceful stop on Windows: remove roots earlier runs left behind.
for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true }))
  if (entry.isDirectory() && /^own-web-files-(?!e2e$)/.test(entry.name))
    await fs.rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true }).catch(() => undefined)
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-web-files-")))
const workspace = path.join(root, "workspace")
const outside = path.join(root, "outside.txt")
await seedWorkspace(workspace)
await Bun.write(outside, "밖에 있는 파일\n")

const responses = startFakeOpenAIResponses({ models: [MODEL.id], responder: reply })
const server = await startOpencodeServer({
  root,
  env: { OWN_OPEN_CODE: "1" },
  config: opencodeConfig({
    providers: { [MODEL.providerID]: openAIResponsesProvider(responses, { apiKey: FAKE_KEY, models: [MODEL.id] }) },
    model: `${MODEL.providerID}/${MODEL.id}`,
  }),
})
await server.waitForModels([MODEL])

const created = (await server.call("POST", "/api/session", {
  body: {
    title: "파일 세션",
    model: MODEL,
    location: { directory: workspace },
    permissions: [{ action: "edit", resource: "*", effect: "allow" }],
  },
  directory: workspace,
})) as { data: { id: string } }
const session = created.data.id

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, { OWN_WEB_API_URL: server.url, OWN_WEB_API_PASSWORD: password })
const dev = await startViteDev({ port: FILES_DEV_PORT })

const state = { dev: `http://127.0.0.1:${FILES_DEV_PORT}`, workspace, outside, session, many: MANY }
await fs.mkdir(path.dirname(FILES_STATE_FILE), { recursive: true })
await Bun.write(FILES_STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_FILES_E2E_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await server.stop()
  await responses.stop()
  await fs.rm(FILES_STATE_FILE, { force: true })
  await removeTree(root).catch(() => undefined)
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

/**
 * `FILES_WRITE:<path>` in the user text makes the model call the real `write` tool for that path; the follow-up
 * request (its last input item is the tool result) and every other request get a short text answer.
 */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "파일 세션" }
  const input = (request.json as { input?: unknown[] } | undefined)?.input ?? []
  const last = input.at(-1) as { type?: string } | undefined
  if (last?.type === "function_call_output" || last?.type === "custom_tool_call_output") return { type: "text", text: "파일을 썼습니다." }
  const target = /FILES_WRITE:([\w./-]+)/.exec(JSON.stringify(last ?? ""))?.[1]
  if (!target) return { type: "text", text: "알겠습니다." }
  return {
    type: "tool-call",
    name: "write",
    input: {
      path: target,
      content: `// ${target}: written by the files e2e turn\nexport const written = ${JSON.stringify(target)}\n`,
    },
  }
}

async function seedWorkspace(directory: string) {
  const write = (file: string, content: string | Uint8Array) => Bun.write(path.join(directory, file), content)
  const router = Array.from({ length: 60 }, (_, index) => `export const route${index} = ${index}\n`).join("")
  await write(
    "README.md",
    [
      "# 파일 e2e",
      "",
      "문서 미리보기 시험입니다. [라우터](src/router.ts)와 [다이어그램](docs/diagram.mmd)을 여세요.",
      "",
      "![로고](assets/logo.png)",
      "",
    ].join("\n"),
  )
  await write("src/router.ts", router)
  await write("src/util.ts", "export const util = 1\nexport const twice = util * 2\nexport const third = 3\n")
  await write("docs/diagram.mmd", "flowchart LR\n  A[트리] --> B[탭]\n  B --> C[뷰어]\n")
  await write("docs/guide.md", "# 가이드\n\n[위로](../README.md)\n")
  await write("docs/manual.pdf", pdf("Files e2e PDF"))
  await write("assets/logo.png", png(40, 30))
  await write("data.bin", new Uint8Array([0, 1, 2, 3, 0, 255, 0, 7]))
  await write("big.log", `${"log line with some text to fill the file quickly\n".repeat(130_000)}`)
  await write("문서/한글 메모.md", "# 한글 메모\n\n한글 파일 이름 시험\n")
  await Promise.all(
    Array.from({ length: MANY }, (_, index) =>
      write(`many/file-${String(index).padStart(4, "0")}.txt`, `file ${index}\n`),
    ),
  )
  await git(directory, ["init", "--initial-branch=main"])
  await git(directory, ["config", "user.name", "own files e2e"])
  await git(directory, ["config", "user.email", "files-e2e@example.test"])
  await git(directory, ["add", "-A"])
  await git(directory, ["commit", "-q", "-m", "base"])
}

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
}

/** A one-page PDF with one line of Helvetica text. */
function pdf(text: string) {
  const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  const offsets: number[] = []
  const body = objects.reduce((out, object, index) => {
    offsets.push(out.length)
    return `${out}${index + 1} 0 obj\n${object}\nendobj\n`
  }, "%PDF-1.4\n")
  const xref = body.length
  const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  return `${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

/** A width × height RGB gradient PNG. */
function png(width: number, height: number) {
  const rows = Array.from({ length: height }, (_, y) => [
    0,
    ...Array.from({ length: width }, (_, x) => [
      Math.round((x / width) * 255),
      Math.round((y / height) * 255),
      160,
    ]).flat(),
  ]).flat()
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8)
  const chunks = [
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Uint8Array.from(rows))),
    chunk("IEND", new Uint8Array()),
  ]
  return concat([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks])
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function crc32(bytes: Uint8Array) {
  const crc = bytes.reduce((value, byte) => {
    const next = value ^ byte
    return Array.from({ length: 8 }).reduce<number>((acc) => (acc & 1 ? 0xedb88320 ^ (acc >>> 1) : acc >>> 1), next)
  }, 0xffffffff)
  return (crc ^ 0xffffffff) >>> 0
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  parts.reduce((offset, part) => {
    out.set(part, offset)
    return offset + part.length
  }, 0)
  return out
}
