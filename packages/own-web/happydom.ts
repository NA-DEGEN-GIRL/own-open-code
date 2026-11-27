import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { plugin } from "bun"

// Bun transpiles TSX against the tsconfig `jsxImportSource`, but `solid-js/jsx-runtime` has no runtime
// exports because Solid's compiler normally replaces JSX. Tests run without that compiler, so compile
// JSX against Solid's hyperscript runtime instead.
const transpiler = new Bun.Transpiler({
  loader: "tsx",
  trimUnusedImports: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "solid-js/h" } },
})

plugin({
  name: "solid-jsx-runtime",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => ({
      contents: transpiler.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})

// After the plugin: under Bun 1.4.4 a plugin registered once happy-dom's globals are in place loads no file, and every
// `.tsx` import fails with `Export named 'jsxDEV' not found in module '…solid-js/dist/solid.js'` (2026-10-31).
GlobalRegistrator.register()

// English is loaded on demand in the app (src/i18n); the tests read it at once.
await (await import("./src/i18n")).loadEnglish()
