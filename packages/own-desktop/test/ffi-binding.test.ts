// build/ffi-binding.ts in a real Vite build of a wrapper shaped like ffi-rs's loader: only the target's binding is
// bundled, the others stay external requires, and a target binding that is not installed fails the build.
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { ffiBinding } from "../build/ffi-binding"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-ffi-binding-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), text)
}
const bindings = ["win32-x64-msvc", "win32-ia32-msvc", "win32-arm64-msvc"]
write(
  "node_modules/ffi-rs/index.js",
  bindings
    .map((binding) => `try { module.exports["${binding}"] = require("@yuuang/ffi-rs-${binding}") } catch {}`)
    .join("\n"),
)
write("node_modules/ffi-rs/package.json", JSON.stringify({ name: "ffi-rs", main: "index.js" }))
for (const binding of ["win32-x64-msvc", "win32-ia32-msvc"]) {
  write(`node_modules/@yuuang/ffi-rs-${binding}/index.js`, `module.exports = "binding ${binding} inside"`)
  write(
    `node_modules/@yuuang/ffi-rs-${binding}/package.json`,
    JSON.stringify({ name: `@yuuang/ffi-rs-${binding}`, main: "index.js" }),
  )
}
write("entry.js", `import ffi from "ffi-rs"\nexport default ffi`)

async function bundle(binding: string) {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [ffiBinding(binding)],
    build: {
      write: false,
      minify: false,
      lib: { entry: path.join(root, "entry.js"), formats: ["es"], fileName: "main" },
    },
  })
  const outputs = Array.isArray(result) ? result : [result]
  return outputs
    .flatMap((item) => ("output" in item ? item.output : []))
    .map((chunk) => ("code" in chunk ? chunk.code : ""))
    .join("\n")
}

test("only the target's binding is bundled; the others stay external requires", async () => {
  const code = await bundle("win32-x64-msvc")
  expect(code).toContain("binding win32-x64-msvc inside")
  expect(code).not.toContain("binding win32-ia32-msvc inside")
  expect(code).toContain("@yuuang/ffi-rs-win32-ia32-msvc")
  expect(code).toContain("@yuuang/ffi-rs-win32-arm64-msvc")
})

test("a target binding that is not installed fails the build", async () => {
  await expect(bundle("win32-arm64-msvc")).rejects.toThrow(/ffi-rs-win32-arm64-msvc is not installed beside ffi-rs/)
})
