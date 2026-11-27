// OWN-PATCH(P-049) begin
// Code Mode's fetch passes on only method, headers and body: Bun's own options (`proxy`, `unix`, `tls`) would send an
// approved URL through another host or to a local socket, past the webfetch rules. The options are read once into the
// value both the approval and the request use, so the card never shows less than what is sent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { Permission } from "@opencode/core/permission"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { permissionService } from "./lib/permission"

const context = {
  sessionID: Session.ID.make("ses_fetch_options"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_fetch_options"),
  id: Tool.CallID.make("call_fetch_options"),
  progress: () => Effect.void,
}

describe("Code Mode fetch options", () => {
  const hits: Array<string> = []
  const asked: Array<Permission.AssertInput> = []
  let target: ReturnType<typeof Bun.serve>
  let proxy: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    target = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/redir")
          return new Response(null, { status: 307, headers: { location: `${proxy.url.origin}/landed` } })
        hits.push(
          `target ${request.method} host=${request.headers.get("host") === target.url.host ? "same" : request.headers.get("host")} auth=${request.headers.get("authorization")} proxy-auth=${request.headers.get("proxy-authorization")}`,
        )
        return new Response("ok")
      },
    })
    proxy = Bun.serve({
      port: 0,
      fetch: (request) => (
        hits.push(
          `proxy ${request.method} ${new URL(request.url).pathname} auth=${request.headers.get("authorization")}`,
        ),
        new Response("proxied")
      ),
    })
  })
  afterAll(() => {
    target.stop(true)
    proxy.stop(true)
  })
  const run = async (code: string) => {
    hits.length = 0
    asked.length = 0
    const permission = permissionService({
      assert: (input) => Effect.sync(() => void asked.push(input)),
      assertNotDenied: (input) => Effect.sync(() => void asked.push(input)),
    })
    const result = await Effect.runPromise(
      CodeModeTool.create({ tools: new Map() }, (_, tool, input, ctx) => execute(tool, input, ctx), permission).execute(
        { code },
        context,
      ),
    )
    return { output: result.output.output, hits: [...hits], shown: asked.map((input) => input.metadata) }
  }
  const caught = (call: string) => `try { return await (await ${call}).text() } catch (e) { return e.message }`
  const url = () => `${target.url.origin}/a`

  test("a proxy option is refused before anything is asked or sent", async () => {
    const result = await run(caught(`fetch("${url()}", { proxy: "${proxy.url.origin}" })`))
    expect(result.output).toBe("fetch does not support the option proxy: only method, headers and body are allowed.")
    expect(result.hits).toEqual([])
    expect(result.shown).toEqual([])
  })

  test("unix and tls options are refused", async () => {
    const result = await run(
      caught(`fetch("${url()}", { method: "GET", unix: "/tmp/docker.sock", tls: { rejectUnauthorized: false } })`),
    )
    expect(result.output).toBe(
      "fetch does not support the option unix, tls: only method, headers and body are allowed.",
    )
    expect(result.hits).toEqual([])
  })

  test("method, headers and body still reach the server, and the approval names the headers and the body's size", async () => {
    const result = await run(
      `return await (await fetch("${url()}", { method: "post", headers: { Authorization: "x", "X-Trace": "1" }, body: "héllo" })).text()`,
    )
    expect(result.output).toBe("ok")
    expect(result.hits).toEqual(["target POST host=same auth=x proxy-auth=null"])
    expect(result.shown).toEqual([{ method: "POST", url: url(), headers: ["authorization", "x-trace"], bodyBytes: 6 }])
  })

  test("headers given as Headers or a Map are named on the card as they are sent", async () => {
    for (const headers of [`new Headers({ Authorization: "secret" })`, `new Map([["Authorization", "secret"]])`]) {
      const result = await run(`return (await fetch("${url()}", { headers: ${headers} })).text()`)
      expect(result.output).toBe("ok")
      expect(result.hits).toEqual(["target GET host=same auth=secret proxy-auth=null"])
      expect(result.shown).toEqual([{ method: "GET", url: url(), headers: ["authorization"] }])
    }
  })

  test("a method that is not a string is refused instead of shown as GET and sent as POST", async () => {
    const result = await run(caught(`fetch("${url()}", { method: ["POST"], body: "x" })`))
    expect(result.output).toBe("fetch's method must be a string.")
    expect(result.hits).toEqual([])
    expect(result.shown).toEqual([])
  })

  test("a forbidden method is refused", async () => {
    const result = await run(caught(`fetch("${url()}", { method: "connect" })`))
    expect(result.output).toBe("fetch does not support the method connect.")
    expect(result.hits).toEqual([])
  })

  test("a body that is not a string, bytes or URLSearchParams is refused instead of sent unshown", async () => {
    const result = await run(caught(`fetch("${url()}", { method: "POST", body: [1, 2, 3] })`))
    expect(result.output).toBe("fetch's body must be a string, a Uint8Array or URLSearchParams.")
    expect(result.hits).toEqual([])
    expect(result.shown).toEqual([])
  })

  test("headers the Headers constructor refuses are refused before the ask", async () => {
    const result = await run(
      caught(
        `fetch("${url()}", { method: "POST", headers: [["Authorization", "x"], { 0: "Cookie", 1: "c", length: 2 }] })`,
      ),
    )
    expect(result.output).toStartWith("fetch's headers are not valid:")
    expect(result.hits).toEqual([])
    expect(result.shown).toEqual([])
  })

  test("browser-forbidden request headers are dropped, so Host cannot route an approved URL to another site", async () => {
    const result = await run(
      `return (await fetch("${url()}", { headers: { Host: "evil.example", "Proxy-Authorization": "Basic x", "Transfer-Encoding": "chunked", "Sec-Fetch-Mode": "cors", "X-HTTP-Method-Override": "TRACE", "X-Ok": "1" } })).text()`,
    )
    expect(result.output).toBe("ok")
    expect(result.hits).toEqual(["target GET host=same auth=null proxy-auth=null"])
    expect(result.shown).toEqual([{ method: "GET", url: url(), headers: ["x-ok"] }])
  })

  test("a redirect hop's check shows the request sent there, without the credentials dropped for another origin", async () => {
    const result = await run(
      `return (await fetch("${target.url.origin}/redir", { method: "POST", headers: { Authorization: "s", "X-A": "1" }, body: "b" })).text()`,
    )
    expect(result.output).toBe("proxied")
    expect(result.hits).toEqual(["proxy POST /landed auth=null"])
    expect(result.shown).toEqual([
      { method: "POST", url: `${target.url.origin}/redir`, headers: ["authorization", "x-a"], bodyBytes: 1 },
      {
        method: "POST",
        url: `${proxy.url.origin}/landed`,
        headers: ["x-a"],
        bodyBytes: 1,
        redirectedFrom: `${target.url.origin}/redir`,
      },
    ])
  })

  test("options that are not their own enumerable keys never reach Bun's fetch", async () => {
    const result = await run(caught(`fetch("${url()}", Object.create({ proxy: "${proxy.url.origin}" }))`))
    expect(result.output).toBe("ok")
    expect(result.hits).toEqual(["target GET host=same auth=null proxy-auth=null"])
  })
})
// OWN-PATCH(P-049) end
