// Scans over a session's whole loaded history (background jobs, MCP servers and search services used) rerun whenever
// the list changes: once per page while paging up a long session, over every loaded message through the store's
// proxies. A message that can no longer change (anything but an assistant step still running) answers the same each
// time, so its answer is kept by the message object (the store keeps one object per message).
import type { SessionMessageInfo } from "@opencode/client"

export function perSettledMessage<T>(read: (message: SessionMessageInfo) => T) {
  const kept = new WeakMap<SessionMessageInfo, T>()
  return (message: SessionMessageInfo) => {
    if (kept.has(message)) return kept.get(message)!
    const value = read(message)
    if (message.type !== "assistant" || message.time.completed !== undefined) kept.set(message, value)
    return value
  }
}
