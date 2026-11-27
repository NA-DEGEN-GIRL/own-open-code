export * as RequestKind from "./request-kind.js"

export const HEADER = "x-opencode-claude-agent-kind"
export const SESSION_HEADER = "x-opencode-session-id"
export const FORK_HEADER = "x-opencode-claude-agent-fork-source"
// OWN-PATCH(P-044) begin
// The parent of a subagent's conversation (the process pool lets a start its parked parent waits for go over the cap).
export const PARENT_HEADER = "x-opencode-claude-agent-parent"
// OWN-PATCH(P-044) end
