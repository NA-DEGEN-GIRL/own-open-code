export * as FakeIO from "./fake-io"

import type { ClaudeIO } from "@opencode/core/plugin/provider/claude-agent/claude/io"
import type { FakeClaude } from "./fake-claude"

export const EXECUTABLE = "/fake/bin/claude"

export function make(input: {
  readonly claude: FakeClaude.Fake
  readonly env?: Record<string, string | undefined>
}): ClaudeIO.Interface {
  return {
    spawn: input.claude.spawn,
    which: () => EXECUTABLE,
    env: () => input.env ?? {},
    sessionExists: async () => true,
    // OWN-PATCH(P-045) begin
    // own's IO names a folder by its account folder and directory; the fake keeps upstream's folder path.
    fork: (sessionID, messageID, folder) => input.claude.fork(sessionID, messageID, folder?.configDir),
    remove: (sessionID, folder) => input.claude.remove(sessionID, folder?.configDir),
    // OWN-PATCH(P-045) end
  }
}
