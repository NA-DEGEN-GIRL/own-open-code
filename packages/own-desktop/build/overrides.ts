// Build-time substitution of upstream main modules (05 §4.3, FORK §7 kind "substitute"). The key is the resolved
// absolute upstream path, not the import string, so any specifier that lands on the file is swapped (`../constants`,
// `./constants`, a package path). A key that never matched fails the build in buildEnd: an upstream rename or move
// must not silently bring the original (protocol claim, upstream identity) back.
import path from "node:path"
import type { Plugin } from "vite"

export function normalizeId(id: string) {
  return path.normalize(id.split("?")[0]!).toLowerCase()
}

// electron-vite deep-clones configs and rejects non-plain objects, so the plugin carries only functions and literals.
export function ownOverrides(map: Readonly<Record<string, string>>): Plugin & { readonly matched: () => string[] } {
  const targets = new Map(Object.entries(map).map(([from, to]) => [normalizeId(from), to]))
  const names = [...targets.keys()].map((key) => path.basename(key).replace(/\.[cm]?[jt]sx?$/, ""))
  const hits = new Set<string>()
  return {
    name: "own-desktop:overrides",
    enforce: "pre",
    matched: () => [...hits],
    resolveId: {
      // Only specifiers that can name a key reach the handler (Rolldown hook filter).
      filter: { id: new RegExp(names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")) },
      async handler(source, importer, options) {
        if (!importer) return
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
        if (!resolved) return
        const key = normalizeId(resolved.id)
        const target = targets.get(key)
        if (!target || normalizeId(importer) === normalizeId(target)) return
        hits.add(key)
        return target
      },
    },
    buildEnd(error) {
      if (error) return
      const missed = [...targets.keys()].filter((key) => !hits.has(key))
      if (missed.length)
        this.error(`own-desktop:overrides: no import resolved to ${missed.join(", ")} (upstream moved or renamed?)`)
    },
  }
}
