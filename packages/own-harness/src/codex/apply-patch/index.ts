// The Codex apply_patch engine: codex-rs/apply-patch/src/{parser,streaming_parser,seek_sequence,file_update,text_file,
// lib,invocation}.rs ported to TypeScript with Codex's exact parse rules, matching, line endings, and texts.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
export * as ApplyPatch from "./index.js"

export { ApplyPatchError, applyPatch, derivePatch, summaryText, type DerivedChange, type Summary } from "./apply.js"
export { extractHeredocPatch } from "./invocation.js"
export { describeIoError, nodeFs, type PatchFs } from "./io.js"
export {
  PatchParseError,
  StreamingPatchParser,
  hunkPath,
  parsePatch,
  type Hunk,
  type Patch,
  type UpdateFileChunk,
} from "./parser.js"
