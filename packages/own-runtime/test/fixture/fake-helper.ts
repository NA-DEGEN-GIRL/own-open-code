// A stand-in for own-vault.exe speaking the same JSON-lines protocol, backed by Vault.Memory (no encryption).
// Flags let tests misbehave on purpose:
//   --protocol <n>    report this protocol version in `hello`
//   --hang <op>       never answer requests with this op
//   --exit <op>       exit with code 3 when a request with this op arrives
//   --no-rid          answer without echoing `rid`
//   --pid-file <path> write this process's pid to the file on start

import { writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { Vault } from "../../src/vault.js"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : (args[index + 1] ?? "")
}

const protocol = flag("--protocol")
const hang = flag("--hang")
const exit = flag("--exit")
const noRid = args.includes("--no-rid")
const pidFile = flag("--pid-file")
if (pidFile) writeFileSync(pidFile, String(process.pid))

const memory = Vault.memory()
const lines = createInterface({ input: process.stdin })

lines.on("line", (line) => {
  if (!line.trim()) return
  const request: Record<string, unknown> = JSON.parse(line)
  if (request.op === exit) process.exit(3)
  if (request.op === hang) return
  const response = memory.handle(request)
  if (request.op === "hello" && protocol !== undefined) response.protocol = Number(protocol)
  if (noRid) delete response.rid
  process.stdout.write(`${JSON.stringify(response)}\n`)
})
lines.on("close", () => process.exit(0))
