// MR12-5: the real-host suites' `freeOnBoth` (env.ts) picks a port for a fake this PC serves and the host reaches by
// an `ssh -R` of the same number. A host whose listening ports could not be read made every port count as free there;
// now that fails, naming the helper ssh's own error. The ports it picks differ from one another.
import { describe, expect, test } from "bun:test"
import { freeOnBoth } from "../real-host/env.js"

describe("real-host freeOnBoth", () => {
  test("a host whose listening ports cannot be read fails with the ssh error", async () => {
    const failed = freeOnBoth(async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host x port 22: refused\n" }))
    await expect(failed).rejects.toThrow("ss on the host failed (exit 255): ssh: connect to host x port 22: refused")
  })

  test("its picks are free here, not listening on the host, and never the same twice", async () => {
    const listing = [
      "LISTEN 0 4096 127.0.0.1:41000 0.0.0.0:*",
      "LISTEN 0 4096 [::1]:41001 [::]:*",
      "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
    ].join("\n")
    const pick = await freeOnBoth(async () => ({ code: 0, stdout: listing, stderr: "" }))
    const picks = [await pick(), await pick(), await pick()]
    expect(new Set(picks).size).toBe(3)
    for (const port of picks) expect(port).toBeGreaterThanOrEqual(30_000)
  })
})
