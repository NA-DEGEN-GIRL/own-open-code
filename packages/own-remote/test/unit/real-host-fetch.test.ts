// RH-2: the real-host suites' remote requests (team-fixture.ts `remoteFetch`). A held answer such as
// `/api/experimental/session/<id>/wait` stays silent until the session is idle; Bun's fetch failed such a request after
// its hidden 5-minute idle timer with a bare `TimeoutError: The operation timed out.` (no stack, no request named).
// remoteFetch turns that timer off and keeps an explicit deadline, and a failure names the request.
import { afterAll, describe, expect, test } from "bun:test"
import { remoteFetch } from "../real-host/team-fixture.js"

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    await Bun.sleep(Number(url.searchParams.get("hold") ?? 0))
    return Response.json({ path: url.pathname, auth: request.headers.get("authorization") })
  },
})
const endpoint = { url: `http://127.0.0.1:${server.port}`, token: "t0ken", controlDir: "/tmp/control" }

afterAll(() => {
  void server.stop(true)
})

describe("real-host remoteFetch", () => {
  test("a held answer within the deadline arrives", async () => {
    const answer = await remoteFetch(endpoint, "POST", "/api/experimental/session/ses_1/wait?hold=300", {
      timeoutMs: 5_000,
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({
      path: "/api/experimental/session/ses_1/wait",
      auth: `Basic ${btoa("opencode:t0ken")}`,
    })
  })

  test("past the deadline the error names the request, the time it ran and the deadline", async () => {
    await expect(
      remoteFetch(endpoint, "POST", "/api/experimental/session/ses_2/wait?hold=5000", { timeoutMs: 200 }),
    ).rejects.toThrow(
      /^POST \/api\/experimental\/session\/ses_2\/wait\?hold=5000: TimeoutError: .+ after \d+s \(deadline 0\.2s\)$/,
    )
  })
})
