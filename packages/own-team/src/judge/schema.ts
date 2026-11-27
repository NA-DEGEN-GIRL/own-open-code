export * as JudgeSchema from "./schema.js"

import { Option, Result, Schema, SchemaIssue } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"

/**
 * The judge's answer (06 §3.4): one JSON object of the 3.4 shape (`OwnTeam.Proposal`). V1 (3.5) is checked here: the
 * text must decode. Models wrap JSON in prose or code fences, so the object is cut out first, from the first `{` to
 * the last `}`. A failure lists the decode issues; they go back to the model with the one retry (3.4), and a second
 * failure leads to the rule-based proposal (`fallback.ts`). V2–V13 drop, fix or truncate items afterwards
 * (`validate.ts`), so the schema itself is lenient. A reorganization's answer (`reorg.propose`, 8.1) is the same shape
 * with `ops` ({@link REORG_EXAMPLE}).
 */

export type Parsed =
  | { readonly ok: true; readonly proposal: OwnTeam.Proposal }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> }

/** The 3.4 example the prompt shows (one line per field group, paths shortened). */
export const EXAMPLE = [
  '{ "version": 1, "target": "main",',
  '  "heavy": [{ "dir": "Assets/Textures", "why": "LFS 그림 9.2 GB" }],',
  '  "shared": [{ "dir": "datasets", "why": "읽기 전용 학습 데이터 40 GB" }],',
  '  "areas": [{ "slug": "inventory-ui", "name": "인벤토리 화면", "goal": "정렬 버그와 UI", "shape": "code",',
  '              "needs": ["Assets/Textures/UI"],',
  '              "adopt": { "worktree": "D:/work/game/.worktrees/x", "branch": "x", "owner": "ses_…" }, "create": null },',
  '            { "slug": "save-v3", "name": "세이브 v3", "goal": "세이브 형식 v3", "adopt": null, "create": { "from": "main" } }],',
  '  "leave": [{ "worktree": "D:/work/game/.worktrees/local-model", "why": "main과 같은 위치, 변경 없음" }],',
  '  "suggest": [{ "kind": "convert", "worktree": "D:/work/game/.worktrees/old-full", "why": "코드 전용이면 9 GB 절약" }],',
  '  "commands": { "setup": "bun install", "code": ["bun run typecheck"], "assets": [] },',
  '  "notes": "사용자에게 보일 한두 문장" }',
].join("\n")

/** The 8.2 shape the reorganization prompt shows (`reorg.propose`): actions on areas named by slug. */
export const REORG_EXAMPLE = [
  '{ "version": 1,',
  '  "ops": [{ "op": "split", "area": "inventory-ui", "slug": "inventory-sort", "name": "인벤토리 정렬", "goal": "정렬 버그만",',
  '            "why": "일이 둘로 갈라짐" },',
  '          { "op": "merge", "area": "save-v3", "from": "save-migrate", "why": "같은 일" },',
  '          { "op": "retire", "area": "old-idea", "why": "반영 끝남" },',
  '          { "op": "new", "slug": "docs", "name": "문서", "goal": "사용자 안내서", "from": "main" },',
  '          { "op": "rename", "area": "save-v3", "name": "세이브 v3" },',
  '          { "op": "convert", "area": "art-tools", "shape": "code", "why": "큰 파일 필요 없음" }],',
  '  "areas": [{ "slug": "cl-perf", "name": "성능 조정", "adopt": { "worktree": "D:/work/game/.worktrees/cl-perf" },',
  '              "create": null }],',
  '  "suggest": [{ "kind": "move", "area": "docs", "why": "문서 대화를 그 영역으로" }],',
  '  "notes": "사용자에게 보일 한두 문장" }',
].join("\n")

/** The growth judge's answer (06 §4.4): folders to leave out, chosen inside the candidates. */
export const HeavyAnswer = Schema.Struct({
  heavy: Schema.Array(Schema.Struct({ dir: Schema.String, why: optional(Schema.String) })),
})
export type HeavyAnswer = typeof HeavyAnswer.Type

const decodeHeavy = Schema.decodeUnknownOption(Schema.fromJsonString(HeavyAnswer))

/** The first JSON object in the growth judge's text, or `undefined` (the rule's candidates stand then). */
export function parseHeavy(text: string): HeavyAnswer | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < start) return undefined
  return Option.getOrUndefined(decodeHeavy(text.slice(start, end + 1)))
}

/** At most this many issues go back with the retry. */
const ISSUES = 8

const decode = Schema.decodeUnknownResult(Schema.fromJsonString(OwnTeam.Proposal))
const formatter = SchemaIssue.makeFormatterStandardSchemaV1()

/** V1: the first JSON object in `text`, decoded as a proposal. */
export function parse(text: string): Parsed {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < start) return { ok: false, errors: ["답에 JSON 객체가 없습니다"] }
  const decoded = decode(text.slice(start, end + 1), { errors: "all" })
  if (Result.isSuccess(decoded)) return { ok: true, proposal: decoded.success }
  return { ok: false, errors: issues(decoded.failure.issue) }
}

function issues(issue: SchemaIssue.Issue) {
  const listed = formatter(issue).issues.map((item) => {
    const at = (item.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".")
    return at === "" ? item.message : `${at}: ${item.message}`
  })
  return listed.length === 0 ? ["JSON이 3.4 모양이 아닙니다"] : listed.slice(0, ISSUES)
}
