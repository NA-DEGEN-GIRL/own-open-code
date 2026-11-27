// PathForms (01 §13 PP-V): the spellings of one path a protected pattern must see. Lexical Windows forms on made-up
// paths; real paths (a link, a junction, an 8.3 short name, a file not written yet) on a temp folder this test makes.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PathForms } from "../src/index.js"

const windows = process.platform === "win32"

describe("Windows spellings of one path", () => {
  const forms = (input: string) => PathForms.of(input, "win32")

  test("device prefixes, admin shares and stream suffixes read as the plain path", () => {
    for (const input of [
      "\\\\?\\C:\\Users\\me\\.ssh\\id",
      "\\\\.\\C:\\Users\\me\\.ssh\\id",
      "//?/C:/Users/me/.ssh/id",
      "\\\\localhost\\C$\\Users\\me\\.ssh\\id",
      "\\\\127.0.0.1\\c$\\Users\\me\\.ssh\\id",
      "\\\\[::1]\\C$\\Users\\me\\.ssh\\id",
      "\\\\?\\UNC\\localhost\\C$\\Users\\me\\.ssh\\id",
      "C:\\Users\\me\\.ssh::$INDEX_ALLOCATION\\id",
      "C:\\Users\\me\\.ssh\\id::$DATA",
      "C:\\Users\\me\\.ssh\\id:hidden:$DATA",
    ])
      expect([input, forms(input).map((form) => form.toLowerCase())]).toEqual([
        input,
        expect.arrayContaining(["c:/users/me/.ssh/id"]),
      ])
  })

  test("the path as given is kept, a plain path stays one form, another share is not a drive", () => {
    expect(forms("D:\\work\\a.ts")[0]).toBe("D:/work/a.ts")
    expect(forms("\\\\server\\share\\x")).not.toContainEqual(expect.stringMatching(/^[a-z]:/i))
  })
})

describe("POSIX", () => {
  test("a path without links is itself", () => {
    expect(PathForms.of("/home/me/.ssh/id", "linux")).toEqual(["/home/me/.ssh/id"])
  })
})

describe("real paths on this machine", () => {
  test("a link or junction into a folder, a short name, and a file not written yet", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-path-forms-")))
    try {
      const secret = path.join(root, "secret folder")
      await fs.mkdir(secret)
      await fs.writeFile(path.join(secret, "key.txt"), "x")
      const link = path.join(root, "link")
      await fs.symlink(secret, link, windows ? "junction" : "dir")
      const slash = (value: string) => value.replaceAll("\\", "/")

      expect(PathForms.of(path.join(link, "key.txt"))).toContain(slash(path.join(secret, "key.txt")))
      // A file about to be written: the real path of its folder, then its name.
      expect(PathForms.of(path.join(link, "new", "file.txt"))).toContain(slash(path.join(secret, "new", "file.txt")))

      if (!windows) return
      const short = shortName(secret)
      // A volume without 8.3 names has nothing more to show.
      if (short === undefined || short === secret) return
      expect(PathForms.of(path.join(short, "key.txt"))).toContain(slash(path.join(secret, "key.txt")))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

/** The 8.3 short form of an existing folder, or undefined. */
function shortName(absolute: string) {
  const ran = Bun.spawnSync([
    "powershell",
    "-NoProfile",
    "-Command",
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${absolute}').ShortPath`,
  ])
  const out = ran.stdout.toString().trim()
  return ran.exitCode === 0 && out !== "" ? out : undefined
}
