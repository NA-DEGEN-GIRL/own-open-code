// P-034's golden check for the harness e2e tests: a full-prefix compaction request is the previous primary request with
// only the newer messages and the checkpoint prompt after it, so a prefix cache reads all of the previous request.
import { expect } from "bun:test"
import path from "node:path"
import { REPO_ROOT } from "../../../own-accounts/test/e2e-kit"
import { Checkpoint } from "../../src/checkpoint.js"

/**
 * The plugins of a harness e2e server: `fixtures/cache-verdict` first, which writes own-accounts' warm verdict into
 * every compaction (own-harness asks for the whole history only on that verdict, CC-16), then own-harness.
 */
export const HARNESS_PLUGINS = [
  { package: path.join(import.meta.dir, "fixtures/cache-verdict"), options: {} },
  { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
]

/** The title of a session the verdict fixture leaves alone: own-harness then has no verdict. */
export const NO_VERDICT = "no verdict"

/** The compaction sets its own output room (P-034 `fullPrefix`); output limits are not part of a prompt cache key. */
const OUTPUT_KEYS = new Set(["max_tokens", "max_completion_tokens", "max_output_tokens"])

/**
 * Every top-level field but the list and the output limit is the same, byte for byte, and the previous request's
 * list (`messages` on Chat, `input` on Responses) is a strict prefix of the compaction's.
 */
export function expectFullPrefix(
  previous: Readonly<Record<string, unknown>>,
  compaction: Readonly<Record<string, unknown>>,
  list: "messages" | "input",
) {
  const rest = (body: Readonly<Record<string, unknown>>) =>
    JSON.stringify(Object.entries(body).filter(([key]) => key !== list && !OUTPUT_KEYS.has(key)))
  expect(rest(compaction)).toBe(rest(previous))
  const before = previous[list] as ReadonlyArray<unknown>
  const after = compaction[list] as ReadonlyArray<unknown>
  // At least the reply to the previous request and the prompt follow it.
  expect(after.length).toBeGreaterThanOrEqual(before.length + 2)
  expect(after.slice(0, before.length).map((item) => JSON.stringify(item))).toEqual(
    before.map((item) => JSON.stringify(item)),
  )
}

/** The prompt of a full-prefix compaction that keeps the latest exchange (a question and its one-message answer). */
export function keptPrompt(question: string) {
  return Checkpoint.prompt({ kept: { quote: question, cut: false, count: 2, fromEnd: 1, repeats: 1 } })
}
