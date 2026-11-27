// G-D1 stand-in for a user's upstream OpenCode service of another version (05 §14.1): a separate process that answers
// `GET /api/info` like `opencode serve` ({version, pid}, Basic auth) and registers itself the way the upstream CLI
// does, as `<XDG_STATE_HOME>\opencode\service.json` — only ever under the temp XDG_STATE_HOME it is given. It counts
// every request it receives, so a run can prove the shell never discovered, "ensured", stopped or replaced it.
//
//   bun scripts/fake-upstream-service.ts --state <temp XDG_STATE_HOME> --version 1.14.0
//
// Prints one JSON line when ready: {url, pid, registration, password}. GET /__count (no auth) reports
// {requests, paths}; stdin EOF or "stop" ends it (the registration file stays, as upstream leaves it on a crash).
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

const args = parseArgs({ options: { state: { type: "string" }, version: { type: "string", default: "1.14.0" } } }).values
if (!args.state) throw new Error("--state <temp XDG_STATE_HOME> is required")
const password = randomBytes(18).toString("base64url")
const expected = `Basic ${btoa(`opencode:${password}`)}`
const seen: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/__count") return Response.json({ requests: seen.length, paths: seen.slice(-20) })
    seen.push(`${request.method} ${url.pathname}`)
    if (request.headers.get("authorization") !== expected) return new Response("unauthorized", { status: 401 })
    if (url.pathname === "/api/info") return Response.json({ version: args.version, pid: process.pid })
    return Response.json({ error: "not found" }, { status: 404 })
  },
})
const registration = path.join(args.state, "opencode", "service.json")
mkdirSync(path.dirname(registration), { recursive: true })
writeFileSync(
  registration,
  JSON.stringify(
    {
      id: `fake-upstream-${process.pid}`,
      version: args.version,
      url: `http://127.0.0.1:${server.port}`,
      pid: process.pid,
      password,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}`, pid: process.pid, registration }))
const stop = () => {
  server.stop(true)
  process.exit(0)
}
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("stop")) stop()
})
process.stdin.on("end", stop)
process.stdin.resume()
