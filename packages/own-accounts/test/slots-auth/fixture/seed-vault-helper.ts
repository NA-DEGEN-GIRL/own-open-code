// Stand-in for own-vault.exe in E2E tests: the helper's JSON-lines protocol over an unencrypted in-memory vault,
// seeded from the JSON file given as the first argument (`{ "<accountId>": "<plaintext vault item JSON>" }`). The
// seed holds fake credentials only. Nothing is ever written to stdout except protocol responses.

import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { Vault } from "@own/runtime"

const memory = Vault.memory()
const seed: Record<string, string> = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"))
for (const [id, value] of Object.entries(seed)) memory.plant(id, value)

const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  if (!line.trim()) return
  process.stdout.write(`${JSON.stringify(memory.handle(JSON.parse(line)))}\n`)
})
lines.on("close", () => process.exit(0))
