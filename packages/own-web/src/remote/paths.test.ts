import { describe, expect, test } from "bun:test"
import { folderNames } from "./paths"

describe("remote folder names (04 §12.4: fs.list paths are relative to the control location)", () => {
  const control = "/home/me/.local/share/own-open-code/control"

  test("children of the listed folder, including an ancestor of the control location", () => {
    const entries = [
      { path: "../../../", type: "directory" },
      { path: "../../../../.config/", type: "directory" },
      { path: "../../../../work/", type: "directory" },
      { path: "../../../../notes.txt", type: "file" },
    ]
    expect(folderNames(entries, control, "/home/me")).toEqual([".config", ".local", "work"])
  })

  test("Windows separators from a Windows server resolve the same way", () => {
    const entries = [
      { path: "..\\..\\..\\..\\work\\", type: "directory" },
      { path: "..\\..\\..\\", type: "directory" },
    ]
    expect(folderNames(entries, control, "/home/me")).toEqual([".local", "work"])
    expect(
      folderNames([{ path: "..\\..\\Projects\\", type: "directory" }], "C:\\Users\\Me\\own\\control", "c:\\users\\me"),
    ).toEqual(["Projects"])
  })

  test("entries outside the listed folder are dropped", () => {
    const entries = [
      { path: "../../../../work/app/", type: "directory" },
      { path: "../", type: "directory" },
    ]
    expect(folderNames(entries, control, "/home/me")).toEqual([])
  })
})
