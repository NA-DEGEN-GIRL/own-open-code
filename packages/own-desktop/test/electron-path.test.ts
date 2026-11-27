import { expect, test } from "bun:test"
import path from "node:path"
import { electronExe } from "../scripts/electron-path"

test("the development shell runs the Electron own-desktop pins", async () => {
  const own = await Bun.file(path.join(import.meta.dir, "../package.json")).json()
  const electron = await Bun.file(path.join(path.dirname(electronExe()), "../package.json")).json()
  expect(electron.version).toBe(own.devDependencies.electron)
})
