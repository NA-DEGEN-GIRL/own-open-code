// The real-host suites' before listing (env.ts) names the account and machine it was taken on (`== host`), and
// a-transport and z-cleanup refuse a listing of another machine: z-cleanup removes whole the directories it shows
// absent, so build-host's listing read on lab could remove folders lab's user has. Listings of older suite versions
// name no host and are accepted.
import { describe, expect, test } from "bun:test"
import { SNAPSHOT_SCRIPT, assertListingHost } from "../real-host/env.js"

const listing = (host?: string) =>
  [...(host === undefined ? [] : ["== host", host]), "== gitconfig", "ABSENT", "== ls /home/dev/.config", "git"].join("\n")
const reads = (stdout: string, code = 0) => async () => ({ code, stdout, stderr: code === 0 ? "" : "ssh: refused\n" })

describe("real-host before listing host", () => {
  test("the snapshot starts with the host section", () => {
    expect(SNAPSHOT_SCRIPT.split("\n")[1]).toBe(`echo "== host"; echo "$(id -un)@$(hostname)"`)
  })

  test("a listing of the same host passes", async () => {
    await assertListingHost(listing("dev@lab-box"), reads("dev@lab-box\n"))
  })

  test("a listing of another host fails before anything is removed", async () => {
    await expect(assertListingHost(listing("me@server"), reads("dev@lab-box\n"))).rejects.toThrow(
      "was taken on me@server, not on dev@lab-box",
    )
  })

  test("a host whose name cannot be read fails", async () => {
    await expect(assertListingHost(listing("dev@lab-box"), reads("", 255))).rejects.toThrow(
      "reading the host's name failed (exit 255): ssh: refused",
    )
  })

  test("a listing without a host section is accepted without asking the host", async () => {
    await assertListingHost(listing(), () => Promise.reject(new Error("not asked")))
  })
})
