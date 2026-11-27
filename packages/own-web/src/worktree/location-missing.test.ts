// 03 §8 세션 폴더 없음: only the server's typed 404 marks a session folder missing, per server and folder.
import { describe, expect, test } from "bun:test"
import type { ServerRuntime } from "@/data"
import { locationMissing, missingChoice, noteLocationError } from "./location-missing"

// The promise client throws declared errors as `Error` objects carrying the body's `_tag` (generated `declared`).
const notFound = (directory: string) =>
  Object.assign(new Error(`Location not found: ${directory}`), {
    _tag: "LocationNotFoundError",
    location: { directory },
  })

/** The runtime part `noteLocationError` uses; records which folders' reads were dropped. */
function runtime(key: string) {
  const dropped: string[] = []
  // SAFETY: noteLocationError reads `key` and calls `data.location.invalidate` only.
  const value = {
    key,
    data: { location: { invalidate: (ref: { directory: string }) => dropped.push(ref.directory) } },
  } as unknown as Pick<ServerRuntime, "key" | "data">
  return { value, dropped }
}

describe("missing session folder (03 §8)", () => {
  test("the typed 404 marks the folder of that server; other failures do not", () => {
    const local = runtime("local")
    expect(noteLocationError(local.value, "C:/work/gone", new Error("offline"))).toBe(false)
    expect(noteLocationError(local.value, "C:/work/gone", { _tag: "SessionNotFoundError" })).toBe(false)
    expect(locationMissing("local", "C:/work/gone")).toBe(false)
    expect(local.dropped).toEqual([])

    expect(noteLocationError(local.value, "C:/work/gone", notFound("C:/work/gone"))).toBe(true)
    expect(locationMissing("local", "C:/work/gone")).toBe(true)
    // The next check asks the server again instead of a cached success.
    expect(local.dropped).toEqual(["C:/work/gone"])
    expect(locationMissing("lab", "C:/work/gone")).toBe(false)
    expect(locationMissing("local", "C:/work/other")).toBe(false)
  })

  test("the wording follows what this connection can do: a folder, a work location, or nothing", () => {
    // SAFETY: missingChoice reads `kind`, `rpc.can`, and the session and project rows canMoveSession looks at.
    const connection = (input: { kind: string; scopes: string[]; git: boolean }) =>
      ({
        kind: input.kind,
        rpc: { can: (scope: string) => input.scopes.includes(scope) },
        data: {
          session: { get: () => ({ projectID: "prj_1" }) },
          project: { get: () => ({ canonical: "C:/work", vcs: input.git ? "git" : undefined }) },
        },
        sessions: { state: { sessions: {}, projects: {} } },
      }) as unknown as ServerRuntime
    expect(missingChoice(connection({ kind: "local", scopes: ["local", "prompt"], git: true }), "ses_1")).toBe("folder")
    expect(missingChoice(connection({ kind: "ssh", scopes: ["local", "prompt"], git: true }), "ses_1")).toBe("worktree")
    expect(missingChoice(connection({ kind: "gateway", scopes: ["prompt"], git: true }), "ses_1")).toBe("worktree")
    expect(missingChoice(connection({ kind: "gateway", scopes: ["prompt"], git: false }), "ses_1")).toBe("none")
    expect(missingChoice(connection({ kind: "gateway", scopes: [], git: true }), "ses_1")).toBe("none")
  })

  test("nothing is marked without a folder", () => {
    expect(noteLocationError(runtime("local").value, undefined, notFound("C:/x"))).toBe(false)
    expect(locationMissing("local", undefined)).toBe(false)
  })
})
