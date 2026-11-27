// Builds the omo runtime (own/docs/15 §2): `bun script/bundle.ts [--out <dir>]` (default `<repo>/own/.out/omo`, which
// source runs and the tests read; the release bundler passes `<app>/plugins/own-omo`).
//
// 1. The vendored oh-my-opencode sources (own/vendor/oh-my-opencode/src, SUL-1.0) are checked against source.json and
//    staged to `.omo-stage/` in this package (gitignored), so their npm imports resolve from this package's
//    node_modules.
// 2. own's patch for the pinned tag (patches/<tag>.json, OMO-P1…) is applied to the staged copy.
// 3. Bun.build bundles src/runtime-entry.ts with the staged sources into one minified ESM file, `omo-runtime.js`, with
//    the resolver of script/resolve.ts (own's shims for OpenCode 1's plugin and SDK packages, PostHog and sharp).
// 4. The output folder gets `omo-runtime.js` with a banner naming the license and the modifications, and the license,
//    notices and MODIFICATIONS.md, which travel with every copy (SUL-1.0: notices may not be removed).
//
// The build fails when a vendored file or a patch does not match, when the banner is missing, when the output names a
// PostHog host, or when it is larger than 6 MB.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { OmoPatch } from "./patch"
import { plugin } from "./resolve"

const PACKAGE = path.resolve(import.meta.dir, "..")
const REPO = path.resolve(PACKAGE, "..", "..")
const VENDOR = path.join(REPO, "own", "vendor", "oh-my-opencode")
const STAGE = path.join(PACKAGE, ".omo-stage")
const LIMIT = 6 * 1024 * 1024
export const NOTICES = ["LICENSE.md", "THIRD-PARTY-NOTICES.md", "MODIFICATIONS.md"]

// `--dev`: unminified with an inline source map, for debugging only (never a release input).
const dev = process.argv.includes("--dev")
const index = process.argv.indexOf("--out")
const out = path.resolve(index < 0 ? path.join(REPO, "own", ".out", "omo") : process.argv[index + 1]!)

const pin = JSON.parse(fs.readFileSync(path.join(VENDOR, "pin.json"), "utf8")) as { tag: string; version: string }
const source = JSON.parse(fs.readFileSync(path.join(VENDOR, "source.json"), "utf8")) as Record<string, string>

fs.rmSync(STAGE, { recursive: true, force: true })
for (const [file, hash] of Object.entries(source)) {
  const bytes = fs.readFileSync(path.join(VENDOR, "src", file))
  if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error(`vendored file changed: ${file}`)
  fs.mkdirSync(path.dirname(path.join(STAGE, file)), { recursive: true })
  fs.writeFileSync(path.join(STAGE, file), bytes)
}
const manifest = OmoPatch.read(path.join(VENDOR, "patches", `${pin.tag}.json`))
OmoPatch.apply(manifest, STAGE)

const banner = `// oh-my-opencode v${pin.version} (SUL-1.0), modified by own-open-code: see MODIFICATIONS.md`
const result = await Bun.build({
  entrypoints: [path.join(PACKAGE, "src", "runtime-entry.ts")],
  target: "bun",
  format: "esm",
  minify: !dev,
  ...(dev ? { sourcemap: "inline" as const } : {}),
  banner,
  loader: { ".md": "text" },
  plugins: [plugin(STAGE, { external: false })],
})
if (!result.success) throw new AggregateError(result.logs, "the omo runtime build failed")
const text = await result.outputs[0]!.text()
// Bun writes its `// @bun` pragma first; the banner is the next line.
if (!text.split("\n", 2).includes(banner)) throw new Error("the omo runtime lost its banner")
if (/posthog\.com/i.test(text)) throw new Error("the omo runtime names a PostHog host")
const bytes = Buffer.byteLength(text)
if (bytes > LIMIT && !dev) throw new Error(`the omo runtime is ${bytes} bytes, over ${LIMIT}`)

fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, "omo-runtime.js"), text)
NOTICES.forEach((file) => fs.copyFileSync(path.join(VENDOR, file), path.join(out, file)))
// omo's built-in skills read their SKILL.md when the runtime loads, from `skills/` next to it (shared-skills
// `sharedSkillsRootPath`).
fs.rmSync(path.join(out, "skills"), { recursive: true, force: true })
fs.cpSync(path.join(STAGE, "packages", "shared-skills", "skills"), path.join(out, "skills"), { recursive: true })
console.log(
  `${path.join(out, "omo-runtime.js")}: ${bytes} bytes (oh-my-opencode ${pin.tag}, ${Object.keys(source).length} files, ${manifest.files.length} patched)`,
)
