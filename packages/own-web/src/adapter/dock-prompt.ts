// session-ui's dock frame (03 §4.6 "session-ui `./dock-prompt`를 틀로 쓴다") for the request docks (src/requests). Only
// src/adapter may import @opencode/session-ui (03 §16.1); the request docks are lazy chunks, so this stays out of the
// first chunk.
export { DockPrompt } from "@opencode/session-ui/dock-prompt"
