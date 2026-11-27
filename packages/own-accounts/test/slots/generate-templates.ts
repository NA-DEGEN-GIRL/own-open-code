// Regenerates the bundled fallback templates `src/slots/templates/<kind>.json` (02 §3.6a rule 3) from the catalog the
// fork base ships (`packages/core/src/models-dev/snapshot.txt`, loaded by the upstream server with model fetching
// disabled). The kind rules are the same `Templates.fromCatalog` a live account uses, so a bundled template differs
// from a captured one only in `source` and `capturedAt`.
//
//   cd packages/own-accounts && bun test/slots/generate-templates.ts && bunx prettier --write src/slots/templates
//
// Pass kinds (e.g. `… generate-templates.ts siwc`) to regenerate only those files.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import { Templates } from "../../src/slots/templates.js"
import { opencodeConfig, startOpencodeServer } from "../e2e-kit"

const OUTPUT = path.join(import.meta.dir, "../../src/slots/templates")
const KINDS =
  process.argv.length > 2
    ? Templates.CATALOG_KINDS.filter((kind) => process.argv.includes(kind))
    : Templates.CATALOG_KINDS
const decodeDump = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Array(Model.Info)))

const work = await fs.mkdtemp(path.join(os.tmpdir(), "own-templates-"))
const out = path.join(work, "catalog.json")
const server = await startOpencodeServer({
  config: opencodeConfig({
    providers: {},
    plugins: [{ package: path.join(import.meta.dir, "fixture/template-dump"), options: { out } }],
  }),
})
try {
  await server.models()
  await until(() => Bun.file(out).exists(), 30_000)
  const dump = decodeDump(await Bun.file(out).json())
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  for (const kind of KINDS) {
    const built = Templates.fromCatalog(kind, dump[Templates.SOURCE[kind]] ?? [], capturedAt)
    if (!built.ok) throw new Error(`${kind}: ${built.reason}`)
    const template = { ...built.template, source: "bundled" }
    await Bun.write(path.join(OUTPUT, `${kind}.json`), `${JSON.stringify(template, null, 2)}\n`)
    console.log(
      `${kind}: ${template.models.length} models${built.dropped.length ? `, dropped ${built.dropped.length} unpriced` : ""}`,
    )
  }
} finally {
  await server.stop()
  await fs.rm(work, { recursive: true, force: true })
}

async function until(probe: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error("the template dump plugin wrote nothing")
    await Bun.sleep(100)
  }
}
