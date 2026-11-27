// MCP management module (03 §18.14, 01 §17.1 #14; owner: workspace). Only the first-chunk mount points and pure helpers
// are exported here; the settings page, the Ctrl+; dialog and the server panel are lazy chunks (`./settings`,
// `./dialog`, `./server-panel`), and the OAuth exception lives in `./oauth` and nowhere else (lint.test.ts).
export { McpAuthBanner } from "./banner"
export { McpLayer, openMcpList, ServerStatusPopover } from "./layer"
export { summarize, type McpRow, type McpStatus, type McpSummary } from "./model"
export type { McpServers, McpState, SignInState } from "./store"
export { mcpEn, mcpKo, mcpText, useMcpText, type McpKey } from "./strings"
