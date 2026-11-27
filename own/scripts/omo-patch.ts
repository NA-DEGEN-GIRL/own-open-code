// own's patch of the vendored oh-my-opencode sources (own/docs/15 §7, own/vendor/oh-my-opencode/MODIFICATIONS.md):
//
//   bun own/scripts/omo-patch.ts make <pristine dir> <edited dir> <out.json> [--tag <tag>]
//     The manifest that turns the pristine tree into the edited one (only files of the edited tree are compared). Ids
//     (OMO-P1…) are kept by file from an existing <out.json>; a new file gets `OMO-P?` to fill in. The script checks
//     that the edits reproduce the edited files.
//   bun own/scripts/omo-patch.ts apply <manifest.json> <dir>
//     Applies a manifest in place (every pre and post hash checked; script/bundle.ts does this on its staged copy).
//   bun own/scripts/omo-patch.ts rebase --from <tag> --to <tag>
//     After `omo-vendor.ts` vendored the new tag: applies patches/<from>.json to the vendored src/ in a temporary copy
//     and writes patches/<to>.json with the new hashes. Edits that no longer apply are listed and the run fails; make
//     those files again from an edited copy.
//
// Pristine and edited dirs are laid out like the vendored `src/` (`packages/<pkg>/…`). Only the named files are read
// and only the manifest is written.
import fs from "node:fs"
import path from "node:path"
import { OmoPatch } from "../../packages/own-omo/script/patch"

const VENDOR = path.resolve(import.meta.dir, "..", "vendor", "oh-my-opencode")
const [command, ...rest] = process.argv.slice(2)

if (command === "make") {
  const [pristine, edited, out] = rest.filter((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--tag")
  const tag = flag("--tag") ?? JSON.parse(fs.readFileSync(path.join(VENDOR, "pin.json"), "utf8")).tag
  if (!pristine || !edited || !out) usage()
  const ids = new Map(
    fs.existsSync(out) ? OmoPatch.read(out).files.map((entry) => [entry.file, entry.patch] as const) : [],
  )
  const manifest = OmoPatch.make({ pristine, edited, tag, ids })
  OmoPatch.write(out, manifest)
  const unnamed = manifest.files.filter((entry) => entry.patch === "OMO-P?").map((entry) => entry.file)
  console.log(`${out}: ${manifest.files.length} files, ${manifest.files.reduce((sum, entry) => sum + entry.edits.length, 0)} edits`)
  if (unnamed.length > 0) console.log(`name these in ${out} (OMO-P?): ${unnamed.join(", ")}`)
} else if (command === "apply") {
  const [manifest, dir] = rest
  if (!manifest || !dir) usage()
  OmoPatch.apply(OmoPatch.read(manifest), dir)
  console.log(`${dir}: ${OmoPatch.read(manifest).files.length} files patched`)
} else if (command === "rebase") {
  const from = flag("--from")
  const to = flag("--to")
  if (!from || !to) usage()
  const pin = JSON.parse(fs.readFileSync(path.join(VENDOR, "pin.json"), "utf8")) as { tag: string }
  if (pin.tag !== to) throw new Error(`the vendored tree is ${pin.tag}; run omo-vendor.ts --tag ${to} first`)
  const result = OmoPatch.rebase(OmoPatch.read(path.join(VENDOR, "patches", `${from}.json`)), path.join(VENDOR, "src"), to)
  OmoPatch.write(path.join(VENDOR, "patches", `${to}.json`), result.manifest)
  result.failed.forEach((entry) => console.error(`${entry.patch} ${entry.file}: ${entry.reason}`))
  console.log(`patches/${to}.json: ${result.manifest.files.length} files rebased, ${result.failed.length} failed`)
  if (result.failed.length > 0) process.exit(1)
} else usage()

function flag(name: string) {
  const index = rest.indexOf(name)
  return index < 0 ? undefined : rest[index + 1]
}

function usage(): never {
  console.error(
    [
      "usage: bun own/scripts/omo-patch.ts make <pristine dir> <edited dir> <out.json> [--tag <tag>]",
      "       bun own/scripts/omo-patch.ts apply <manifest.json> <dir>",
      "       bun own/scripts/omo-patch.ts rebase --from <tag> --to <tag>",
    ].join("\n"),
  )
  process.exit(2)
}
