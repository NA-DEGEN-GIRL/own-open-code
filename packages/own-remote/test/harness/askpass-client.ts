#!/usr/bin/env bun
/**
 * Stand-in for `opencode.exe` in askpass mode when no built exe is available: the same wire protocol as
 * packages/cli/src/ssh-askpass.ts (one JSON line `{token, text, confirm}` to 127.0.0.1:OPENCODE_SSH_ASKPASS_PORT,
 * answer `{value}`; `null` → exit 1). The fake ssh runs `.ts` helpers through bun.
 */
import net from "node:net"

const port = Number(process.env.OPENCODE_SSH_ASKPASS_PORT)
const socket = net.connect({ host: "127.0.0.1", port })
let text = ""
socket.setEncoding("utf8")
socket.on("connect", () =>
  socket.write(
    JSON.stringify({
      token: process.env.OPENCODE_SSH_ASKPASS_TOKEN,
      text: process.argv.slice(2).join(" "),
      confirm: process.env.SSH_ASKPASS_PROMPT === "confirm",
    }) + "\n",
  ),
)
socket.on("data", (chunk: string) => {
  text += chunk
})
socket.on("close", () => {
  try {
    const value = (JSON.parse(text) as { value: string | null }).value
    if (value === null) process.exit(1)
    process.stdout.write(value + "\n")
    process.exit(0)
  } catch {
    process.exit(1)
  }
})
socket.on("error", () => process.exit(1))
