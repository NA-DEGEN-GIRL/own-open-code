// OWN-PATCH(P-050) begin
import type { BunPlugin } from "bun"

/**
 * effect 4.0.6's platform-node loads node:http through `createRequire(typeof __filename === "string" ? __filename :
 * import.meta.url)` (`dist/internal/http.js`). Bun inlines `__filename` as the source file's path on the build machine,
 * so a Linux binary compiled on Windows (own's SSH-host bundles) held `createRequire("D:\…\http.js")`, which Linux
 * refuses as not absolute: the service died at start. `import.meta.url` is the module's own URL in every compiled binary
 * and the require only loads node builtins. A build fails if the file no longer has that text.
 */
export const OWN_FILENAME_REQUIRE = 'typeof __filename === "string" ? __filename : import.meta.url'

export const ownFilenamePlugin: BunPlugin = {
  name: "own-filename-require",
  setup(build) {
    build.onLoad({ filter: /@effect[/\\]platform-node[/\\]dist[/\\]internal[/\\]http\.js$/ }, async (args) => {
      const text = await Bun.file(args.path).text()
      if (!text.includes(OWN_FILENAME_REQUIRE))
        throw new Error(
          `own P-050: ${args.path} no longer has createRequire(${OWN_FILENAME_REQUIRE}); review the patch`,
        )
      return { contents: text.replace(OWN_FILENAME_REQUIRE, "import.meta.url"), loader: "js" }
    })
  },
}
// OWN-PATCH(P-050) end
