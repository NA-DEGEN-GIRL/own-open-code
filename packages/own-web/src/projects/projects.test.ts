import { beforeEach, describe, expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { listFolders, resolveProject } from "./fs"
import {
  baseName,
  crumbs,
  filterNames,
  folderNames,
  isAbsolutePath,
  joinPath,
  normalizeInput,
  parentPath,
  rootOf,
  rootsOf,
  samePath,
  tooBroad,
  trimSep,
} from "./path"
import { mergeRecent, openedFolders, rememberFolder } from "./recent"
import { projectsText } from "./strings"

describe("paths (03 §18.3)", () => {
  test("input is cleaned: quotes, bare drive, separators, trailing slash", () => {
    expect(normalizeInput('  "D:\\work\\my app\\"  ')).toBe("D:\\work\\my app")
    expect(normalizeInput("d:")).toBe("D:\\")
    expect(normalizeInput("d:/work//app/")).toBe("D:\\work\\app")
    expect(normalizeInput("/home/me//proj/")).toBe("/home/me/proj")
    expect(normalizeInput("\\\\server\\share\\dir\\")).toBe("\\\\server\\share\\dir")
    expect(normalizeInput("src")).toBe("src")
    expect(normalizeInput("   ")).toBe("")
  })

  test("roots, parents and names on Windows, POSIX and UNC paths", () => {
    expect(trimSep("C:")).toBe("C:\\")
    expect(trimSep("C:\\")).toBe("C:\\")
    expect(trimSep("/")).toBe("/")
    expect(rootOf("c:\\a\\b")).toBe("C:\\")
    expect(rootOf("/usr/lib")).toBe("/")
    expect(rootOf("\\\\srv\\share\\x")).toBe("\\\\srv\\share")
    expect(rootOf("relative\\x")).toBeUndefined()
    expect(parentPath("C:\\a")).toBe("C:\\")
    expect(parentPath("C:\\")).toBeUndefined()
    expect(parentPath("/a")).toBe("/")
    expect(parentPath("/")).toBeUndefined()
    expect(parentPath("\\\\srv\\share\\x")).toBe("\\\\srv\\share")
    expect(parentPath("\\\\srv\\share")).toBeUndefined()
    expect(baseName("..\\..\\work\\#1 앱\\")).toBe("#1 앱")
    expect(baseName("D:\\x\\")).toBe("x")
    expect(baseName("C:\\")).toBe("C:\\")
    expect(joinPath("C:\\", "a")).toBe("C:\\a")
    expect(joinPath("/home/me", "a")).toBe("/home/me/a")
    expect(isAbsolutePath("D:\\x")).toBe(true)
    expect(isAbsolutePath("D:")).toBe(true)
    expect(isAbsolutePath("x\\y")).toBe(false)
  })

  test("crumbs carry the absolute path each step opens", () => {
    expect(crumbs("D:\\work\\#1 앱")).toEqual([
      { label: "D:\\", path: "D:\\" },
      { label: "work", path: "D:\\work" },
      { label: "#1 앱", path: "D:\\work\\#1 앱" },
    ])
    expect(crumbs("/home/me").map((item) => item.path)).toEqual(["/", "/home", "/home/me"])
    expect(crumbs("relative")).toEqual([])
  })

  test("Windows paths compare without case or separator differences, POSIX paths exactly", () => {
    expect(samePath("c:\\Work\\App\\", "C:/work/app")).toBe(true)
    expect(samePath("/home/Me", "/home/me")).toBe(false)
    expect(rootsOf(["d:\\a", "D:\\b", "/x", "C:\\c"])).toEqual(["D:\\", "/", "C:\\"])
  })

  test("drive roots, home folders and the control location never become a project (01 G15)", () => {
    expect(tooBroad("D:\\")).toBe("root")
    expect(tooBroad("/")).toBe("root")
    expect(tooBroad("C:\\Users\\나데브")).toBe("home")
    expect(tooBroad("c:/users/me/")).toBe("home")
    expect(tooBroad("/home/me")).toBe("home")
    expect(tooBroad("/Users/me")).toBe("home")
    expect(tooBroad("C:\\Users\\me\\proj")).toBeUndefined()
    expect(tooBroad("C:\\ctl\\", "c:\\CTL")).toBe("control")
  })

  test("fs.list entries become sorted folder names; filters put prefix matches first", () => {
    const names = folderNames([
      { path: "..\\x\\src\\", type: "directory" },
      { path: "..\\x\\app10\\", type: "directory" },
      { path: "..\\x\\app9\\", type: "directory" },
      { path: "..\\x\\README.md", type: "file" },
    ])
    expect(names).toEqual(["app9", "app10", "src"])
    expect(filterNames(["mysrc", "src", "docs"], "SR")).toEqual(["src", "mysrc"])
    expect(filterNames(["a"], "")).toEqual(["a"])
  })
})

describe("recent projects", () => {
  beforeEach(() => localStorage.clear())

  test("one row per folder, newest first, opened folders merged in", () => {
    const rows = mergeRecent(
      {
        order: ["s3", "s2", "s1"],
        sessions: {
          s3: { id: "s3", created: 1, updated: 30, projectID: "p1", directory: "D:\\work\\app" },
          s2: { id: "s2", created: 1, updated: 20, projectID: "p1", directory: "d:/WORK/app" },
          s1: { id: "s1", created: 1, updated: 10, projectID: "p2", directory: "D:\\other" },
        },
        projects: { p1: { id: "p1", name: "App", directory: "D:\\work\\app" } },
      },
      [
        { directory: "D:\\work\\APP", at: 99 },
        { directory: "E:\\fresh", projectID: "p9", at: 25 },
      ],
    )
    expect(rows.map((row) => [row.name, row.directory, row.at])).toEqual([
      ["App", "D:\\work\\app", 30],
      ["fresh", "E:\\fresh", 25],
      ["other", "D:\\other", 10],
    ])
  })

  test("remembered folders are per server, deduplicated, newest first", () => {
    rememberFolder("local", { directory: "D:\\a", projectID: "pa" }, 1)
    rememberFolder("local", { directory: "D:\\b" }, 2)
    rememberFolder("local", { directory: "d:\\A" }, 3)
    rememberFolder("ssh-1", { directory: "/srv/x" }, 4)
    expect(openedFolders("local").map((item) => [item.directory, item.at])).toEqual([
      ["d:\\A", 3],
      ["D:\\b", 2],
    ])
    expect(openedFolders("ssh-1")).toHaveLength(1)
    localStorage.setItem("own.web.projects.opened.local", "{broken")
    expect(openedFolders("local")).toEqual([])
  })
})

describe("server calls", () => {
  test("paths with #, %, spaces and Hangul travel only as encoded query parameters (FORK.md Windows # path)", async () => {
    const seen: URL[] = []
    const client = OpenCode.make({
      baseUrl: "http://127.0.0.1:9",
      fetch: Object.assign(
        async (input: URL | RequestInfo) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          seen.push(url)
          const body = url.pathname.endsWith("/fs/list")
            ? { location: { directory: "C:\\ctl" }, data: [{ path: "..\\x\\#2 폴더\\", type: "directory" }] }
            : {
                directory: "D:\\work\\#1 앱 100%",
                project: { id: "prj_1", directory: "D:\\work", canonical: "D:\\work" },
              }
          return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
        },
        { preconnect: () => {} },
      ),
    })
    const folder = "D:\\work\\#1 앱 100%"
    expect(await listFolders(client, "C:\\제어 #ctl", folder)).toEqual(["#2 폴더"])
    expect(await resolveProject(client, folder)).toEqual({ directory: folder, projectID: "prj_1" })

    const [list, location] = seen
    expect(list!.pathname).toBe("/api/fs/list")
    expect(list!.hash).toBe("")
    expect(list!.searchParams.get("path")).toBe(folder)
    expect(list!.searchParams.get("location[directory]")).toBe("C:\\제어 #ctl")
    expect(list!.search).not.toContain("#")
    expect(list!.search).toContain("%231")
    expect(location!.pathname).toBe("/api/location")
    expect(location!.searchParams.get("location[directory]")).toBe(folder)
    expect(location!.search).not.toContain("#")
  })
})

describe("strings", () => {
  test("Korean particles follow the filled value; English falls back to Korean for missing keys", () => {
    expect(projectsText("ko", "own.project.noMatch", { query: "앱" })).toBe('"앱"과 맞는 폴더가 없어요')
    expect(projectsText("ko", "own.project.noMatch", { query: "src" })).toContain('"src"')
    expect(projectsText("en", "own.project.count", { n: 3 })).toBe("3 folders")
  })
})
