// Every test file that boots a real server sets its own default timeout (README "실행"): Bun's 5 s default is too
// short for real-server steps under load, a timed-out step makes Bun kill the servers its beforeAll started, and a
// preload or a shared module applies `setDefaultTimeout` to the first file of a run only (Bun 1.4.2).
import { expect, test } from "bun:test"
import path from "node:path"
import { Glob } from "bun"

test("every test file that boots a real server calls setDefaultTimeout", async () => {
  const root = path.join(import.meta.dir, "..")
  const files = await Array.fromAsync(new Glob("**/*.test.ts").scan({ cwd: root }))
  const texts = await Promise.all(
    files.map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })),
  )
  const missing = texts
    .filter((entry) => /\b(startOpencodeServer|startPresetRig|startFakeBench)\(/.test(entry.text))
    .filter((entry) => !/^setDefaultTimeout\(/m.test(entry.text))
    .map((entry) => entry.file.replaceAll("\\", "/"))
  expect(missing.toSorted()).toEqual([])
})
