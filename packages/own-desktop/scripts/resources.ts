// Prepares resources/ before a build (05 §4.1 "resources/icons/*"): the window and installer icons, in upstream
// copy-icons.ts layout. own has no icon set yet, so upstream's dev set is copied (top-level files only: the
// android/ios folders are not used on Windows). resources/icons is generated, not committed.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"

const here = path.resolve(import.meta.dir, "..")
const source = path.resolve(here, "../desktop/icons/dev")
const target = path.join(here, "resources", "icons")

if (!existsSync(source)) throw new Error(`upstream icons not found: ${source}`)
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
let copied = 0
for (const name of readdirSync(source)) {
  const file = path.join(source, name)
  if (!statSync(file).isFile()) continue
  cpSync(file, path.join(target, name))
  copied++
}
console.log(`own-desktop: ${copied} icons ${path.relative(here, source)} -> ${path.relative(here, target)}`)
