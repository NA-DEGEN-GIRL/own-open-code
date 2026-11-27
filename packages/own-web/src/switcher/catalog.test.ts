// The switcher's model catalog (ML, 2026-10-22): on the new-conversation screen the default conversation folder does not
// exist until the first send, so its Location answers 404, and in service mode the default location (no folder) is the
// home directory, whose model list may answer 503 while its plugins start. The switcher showed `불러오는 중…` for every
// account. The server's own catalog now comes from the control location; a failure is said, not loaded forever. The
// recent strip keeps one chip per combination. Fake runtime, fake models.
import { describe, expect, test } from "bun:test"
import type { ServerRuntime } from "@/data"
import { switcherControl } from "./control"
import { catalog, catalogFailed, ensureCatalog } from "./labels"

const CONTROL = "C:\\own\\control"
const MISSING = "C:\\Users\\me\\Documents\\Own OpenCode"

type Answer = "ok" | "missing" | "unavailable"

let servers = 0

/** A server whose Locations answer as `answers` says, keyed by folder (`""`: the default location). */
function server(answers: Record<string, Answer>, control: () => Promise<string> = () => Promise.resolve(CONTROL)) {
  const lists = new Map<string, ReadonlyArray<{ providerID: string; id: string }>>()
  const asked: string[] = []
  const runtime = {
    key: `srv-catalog-${++servers}`,
    connection: { status: () => "connected" },
    control,
    data: {
      location: {
        model: {
          list: (ref?: { directory: string }) => lists.get(ref?.directory ?? ""),
          sync: async (ref?: { directory: string }) => {
            const directory = ref?.directory ?? ""
            asked.push(directory)
            const answer = answers[directory] ?? "missing"
            if (answer === "missing") throw new Error(`404 Location not found: ${directory}`)
            if (answer === "unavailable") throw new Error("503 Location plugins did not finish activating")
            lists.set(directory, [{ providerID: "own-codex-01", id: "gpt-6-astra" }])
          },
        },
      },
    },
  } as unknown as ServerRuntime
  return { runtime, asked, answers }
}

/** Lets every pending load settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("ensureCatalog", () => {
  test("a default conversation folder not created yet still lists the server's models", async () => {
    const fake = server({ [CONTROL]: "ok", "": "unavailable" })
    ensureCatalog(fake.runtime, MISSING, true)
    await settle()
    expect(catalog(fake.runtime, MISSING).map((model) => model.id)).toEqual(["gpt-6-astra"])
    expect(catalogFailed(fake.runtime)).toBe(false)
  })

  test("without a folder the server's catalog is read at the control location, never the default location", async () => {
    const fake = server({ [CONTROL]: "ok", "": "ok" })
    ensureCatalog(fake.runtime, undefined, true)
    await settle()
    expect(fake.asked).toEqual([CONTROL])
    expect(catalog(fake.runtime).map((model) => model.id)).toEqual(["gpt-6-astra"])
  })

  test("an unknown control location falls back to the default location", async () => {
    const fake = server({ "": "ok" }, () => Promise.reject(new Error("No control location yet")))
    ensureCatalog(fake.runtime, undefined, true)
    await settle()
    expect(fake.asked).toEqual([""])
    expect(catalog(fake.runtime).map((model) => model.id)).toEqual(["gpt-6-astra"])
  })

  test("a failed load is said and retried on the next call", async () => {
    const fake = server({ [CONTROL]: "unavailable" })
    ensureCatalog(fake.runtime, MISSING, true)
    await settle()
    expect(catalog(fake.runtime, MISSING)).toEqual([])
    expect(catalogFailed(fake.runtime)).toBe(true)

    fake.answers[CONTROL] = "ok"
    ensureCatalog(fake.runtime, MISSING, true)
    await settle()
    expect(catalog(fake.runtime, MISSING).map((model) => model.id)).toEqual(["gpt-6-astra"])
    expect(catalogFailed(fake.runtime)).toBe(false)
  })
})

describe("recent combinations", () => {
  test("the model's default effort is one chip whether stored as `default` or as none", () => {
    const providerID = "own-codex-recent"
    switcherControl.remember({ providerID, id: "gpt-6-astra" })
    switcherControl.remember({ providerID, id: "gpt-6-astra", variant: "default" })
    switcherControl.remember({ providerID, id: "gpt-6-astra", variant: "high" })
    expect(switcherControl.recent.list.filter((ref) => ref.providerID === providerID)).toEqual([
      { providerID, id: "gpt-6-astra", variant: "high" },
      { providerID, id: "gpt-6-astra", variant: "default" },
    ])
  })
})
