import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Host } from "./host.js"
import { provides } from "./runtime.js"
import { localSource } from "./source.js"
import { missingPackageTarget } from "./source.package.js"

let generation = Date.now()
// OWN-PATCH(P-056) begin: every Location prepares the same plugin files, and scanning a bundled plugin's imports costs
// ~40 ms per MB (0.4-0.6 s for own's release bundles), so a file's import list is kept while its text is unchanged.
const scans = new Map<string, { hash: number | bigint; imports: ReturnType<Bun.Transpiler["scan"]>["imports"] }>()
// OWN-PATCH(P-056) end

export async function prepareSource(entrypoint: string, track: (file: string, directory?: boolean) => void) {
  const root = fileURLToPath(entrypoint)
  const files = new Set<string>()
  const visit = (file: string, search = "") => {
    if (file !== root && file.split(path.sep).includes("node_modules")) return
    if (search) delete require.cache[file + search]
    if (files.has(file)) return
    files.add(file)
    // Bun exposes ESM here too. Delete known keys even when absent: rejected
    // evaluations are not enumerable, but deletion still invalidates them.
    delete require.cache[file]
    track(file)
    if (!/\.[cm]?[jt]sx?$/.test(file)) return
    // Scan dependencies only; the normal runtime loader still owns compilation,
    // package resolution, import attributes, and error reporting.
    // OWN-PATCH(P-056) begin
    const imports = (() => {
      try {
        const text = readFileSync(file, "utf8")
        const hash = Bun.hash(text)
        const scanned = scans.get(file)
        if (scanned?.hash === hash) return scanned.imports
        const found = new Bun.Transpiler({
          loader: file.endsWith("tsx") ? "tsx" : file.endsWith("jsx") ? "jsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js",
          target: "bun",
        }).scan(text).imports
        scans.set(file, { hash, imports: found })
        return found
      } catch {
        return []
      }
    })()
    // OWN-PATCH(P-056) end
    for (const item of imports) {
      const local =
        item.path.startsWith("./") || item.path.startsWith("../")
          ? new URL(item.path, pathToFileURL(file))
          : localSource(item.path, path.dirname(file))
      if (!local) {
        if (provides(item.path)) continue
        try {
          Bun.resolveSync(item.path, path.dirname(file))
        } catch {
          const target = missingPackageTarget(item.path, file)
          if (target) track(target, true)
        }
        continue
      }
      const requested = fileURLToPath(local)
      // Resolving a workspace symlink can erase its node_modules boundary.
      if (requested.split(path.sep).includes("node_modules")) continue
      try {
        visit(
          item.kind === "require-call"
            ? createRequire(file).resolve(requested)
            : Bun.resolveSync(requested, path.dirname(file)),
          local.search,
        )
      } catch {
        // A missing local dependency may appear on the next save. Leave its
        // actual failure (or optional fallback) to the native loader.
        track(path.dirname(requested), true)
      }
    }
  }
  visit(root)
  return { version: String(++generation), load: () => Host.load(entrypoint) }
}
