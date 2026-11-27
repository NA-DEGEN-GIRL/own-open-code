// The ffi-rs binding own's main bundle carries (out/main/chunks/ffi-rs.<binding>-<hash>.node, electron-builder.config.ts).
// The ffi-rs wrapper requires one binding package per platform and CPU; Rolldown bundles every one that bun installed,
// so the x64 shell carried the ia32 binding too, and a cross-built ARM64 client would carry this PC's x64 and ia32 ones.
// Only the target's binding (upstream's previewBinding of OPENCODE_TARGET) is bundled; the wrapper's requires of the
// others stay external and fail inside its try on a machine that never takes those branches. A target binding that is
// not installed fails the build: for a foreign architecture own/scripts/client-natives.ts unpacks the vetted one first.
import type { Plugin } from "vite"

const BINDING = /^@yuuang\/ffi-rs-/

export function ffiBinding(binding: string): Plugin {
  const target = `@yuuang/ffi-rs-${binding}`
  return {
    name: "own-desktop:ffi-binding",
    enforce: "pre",
    resolveId: {
      filter: { id: BINDING },
      async handler(source, importer, options) {
        if (source !== target) return { id: source, external: true }
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
        if (!resolved || resolved.external)
          this.error(
            `own-desktop:ffi-binding: ${target} is not installed beside ffi-rs (${importer}); ` +
              "for another architecture run own/scripts/client-natives.ts first",
          )
        return resolved
      },
    },
  }
}
