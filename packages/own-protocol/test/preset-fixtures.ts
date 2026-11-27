// Fake accounts and a catalog modelled on the 2026-10-01 models.dev snapshot (07 Appendix A) for the preset logic
// tests. Account ids, logins and fingerprints are made up; no real credentials.

import { Schema } from "effect"
import { Account, Preset } from "../src/index.js"
import { templateModel } from "./fixtures.js"

const DAY = 86_400_000
export const SEP_22 = Date.UTC(2026, 8, 22)
const at = (month: number, day: number, year = 2026) => Date.UTC(year, month - 1, day)

/** ChatGPT logins as the registry records them (`sha256:` form of `chatgpt_account_id:sub`). */
export const LOGIN_01 = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
export const LOGIN_02 = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
export const LOGIN_03 = "sha256:3333333333333333333333333333333333333333333333333333333333333333"

export const CHATGPT_01 = Account.ID.make("acc_chatgpt01")
export const CHATGPT_02 = Account.ID.make("acc_chatgpt02")
export const CHATGPT_03 = Account.ID.make("acc_chatgpt03")
/** Sign in with ChatGPT on ChatGPT 01's login: the same subscription as ChatGPT 01. */
export const SIWC_01 = Account.ID.make("acc_siwc01")
/** Sign in with ChatGPT on ChatGPT 02's login. */
export const SIWC_02 = Account.ID.make("acc_siwc02")
/** Sign in with ChatGPT before its login was recorded: a subscription of its own (fail closed). */
export const SIWC_UNKNOWN = Account.ID.make("acc_siwcunknown")
export const OPENAI_KEY = Account.ID.make("acc_openaikey")
export const DEEPSEEK = Account.ID.make("acc_deepseek")
export const CLAUDE = Account.ID.claudeSlot

export const members: ReadonlyArray<Preset.Member> = [
  // A codex account's fingerprint is its login (the guard formula); only newer builds also record `login`.
  { id: CHATGPT_01, kind: "codex", billing: "subscription", identity: { fingerprint: LOGIN_01 } },
  { id: CHATGPT_02, kind: "codex", billing: "subscription", identity: { fingerprint: LOGIN_02, login: LOGIN_02 } },
  { id: CHATGPT_03, kind: "codex", billing: "subscription", identity: { fingerprint: LOGIN_03 } },
  // A siwc fingerprint uses the issued client id, so it never equals a codex fingerprint.
  { id: SIWC_01, kind: "siwc", billing: "subscription", identity: { fingerprint: "sha256:c1", login: LOGIN_01 } },
  { id: SIWC_02, kind: "siwc", billing: "subscription", identity: { fingerprint: "sha256:c2", login: LOGIN_02 } },
  { id: SIWC_UNKNOWN, kind: "siwc", billing: "subscription", identity: { fingerprint: LOGIN_01 } },
  { id: OPENAI_KEY, kind: "oai", billing: "metered" },
  { id: DEEPSEEK, kind: "ds", billing: "prepaid" },
  { id: CLAUDE, kind: "claude-sub", billing: "subscription" },
]
export const lookup: Preset.Lookup = (id) => members.find((member) => member.id === id)

/** A pinned target; `main` and `lighter` are the relative ones. */
export function target(value: string, model = "model-x"): Preset.Target {
  if (value === "main" || value === "lighter") return { rel: value }
  return Schema.decodeUnknownSync(Preset.Target)({ pin: { account: value, model } })
}

export const SAVED = Preset.ID.make("pr_01JB0000000000000000000000")

/** A preset of `group` whose roles have the given targets (accounts are pinned, `main`/`lighter` are relative). */
export function preset(
  group: Preset.Group,
  roles: Partial<Record<Preset.Role, ReadonlyArray<string>>>,
  single?: string,
): Preset.Info {
  return Schema.decodeUnknownSync(Preset.Info)({
    ...Preset.builtin(group),
    id: SAVED,
    name: "x",
    workers: {
      mode: single ? "single" : "by-role",
      ...(single ? { single: target(single) } : {}),
      roles: Object.fromEntries(
        Object.entries(roles).map(([role, targets]) => [
          role,
          { targets: (targets ?? []).map((value) => target(value)), effort: "inherit" },
        ]),
      ),
    },
  })
}

export function team(accounts: ReadonlyArray<string>, pinned: ReadonlyArray<string> = []): Preset.Team {
  return Schema.decodeUnknownSync(Preset.Team)({
    teamID: "tm_3f9a0c1b2d4e",
    role: "owner",
    accounts,
    pinned: pinned.map((value) => target(value)),
  })
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

/** A catalog model (`Model.Info` fields that `Preset.candidates` reads). */
export function model(
  id: string,
  input: { family: string; released: number; price?: number; variants?: ReadonlyArray<string>; tools?: boolean },
) {
  return {
    ...templateModel,
    id,
    modelID: id,
    family: input.family,
    variants: (input.variants ?? EFFORTS).map((effort) => ({ id: effort })),
    time: { released: input.released },
    capabilities: { ...templateModel.capabilities, tools: input.tools ?? true },
    cost:
      input.price === undefined ? [] : [{ input: input.price, output: input.price * 5, cache: { read: 0, write: 0 } }],
  }
}

/** The `openai` catalog (07 Appendix A): Sol and Luna came out the same day, after Astra; 6.1 Sol on 09-29. */
export const OPENAI = [
  model("gpt-5.5", { family: "gpt", released: at(4, 23), price: 5, variants: ["low", "medium", "high", "xhigh"] }),
  model("gpt-5.6-sol", { family: "gpt-sol", released: at(7, 9), price: 4, variants: [...EFFORTS, "ultra"] }),
  model("gpt-5.6-terra", { family: "gpt-terra", released: at(7, 9), price: 2, variants: [...EFFORTS, "ultra"] }),
  model("gpt-5.6-luna", { family: "gpt-luna", released: at(7, 9), price: 0.2 }),
  model("gpt-6-astra", { family: "gpt-astra", released: at(9, 4), price: 10, variants: [...EFFORTS, "ultra"] }),
  model("gpt-6-sol", { family: "gpt-sol", released: SEP_22, price: 2, variants: [...EFFORTS, "ultra"] }),
  model("gpt-6-luna", { family: "gpt-luna", released: SEP_22, price: 0.1 }),
  model("gpt-6.1-sol", { family: "gpt-sol", released: at(9, 29), price: 2, variants: [...EFFORTS, "ultra"] }),
]

/** The `anthropic` catalog: Opus 5.5 is the newest strong model, Haiku 4.5 the cheapest family. */
export const ANTHROPIC = [
  model("claude-haiku-4-5", { family: "claude-haiku", released: at(10, 15, 2025), price: 1 }),
  model("claude-haiku-4-5-20251001", { family: "claude-haiku", released: at(10, 15, 2025), price: 1 }),
  model("claude-sonnet-5-5", { family: "claude-sonnet", released: at(9, 28), price: 2 }),
  model("claude-opus-5", { family: "claude-opus", released: at(7, 24), price: 5 }),
  model("claude-opus-5-5", { family: "claude-opus", released: SEP_22, price: 4 }),
  model("claude-fable-5-1", { family: "claude-fable", released: at(9, 1), price: 10 }),
]

/** The `deepseek` catalog: three levels only (low, high, max). */
export const DEEPSEEK_MODELS = [
  model("deepseek-v4-pro", {
    family: "deepseek-thinking",
    released: at(8, 12),
    price: 0.435,
    variants: ["low", "high", "max"],
  }),
  model("deepseek-flash", {
    family: "deepseek-flash",
    released: at(9, 10),
    price: 0.15,
    variants: ["low", "high", "max"],
  }),
]

/** A newer model of a family that has no tools: never a subagent target, so never a lighter pair. */
export const TOOLLESS = model("gpt-6-pico", { family: "gpt-pico", released: SEP_22 + DAY, price: 0.01, tools: false })

/** A model pool entry: `model` on `account` (none = the main account), with optional fields. */
export function entry(
  key: string,
  model: string,
  account?: string,
  extra: Readonly<Record<string, unknown>> = {},
): Preset.PoolEntry {
  return Schema.decodeUnknownSync(Preset.PoolEntry)({
    key,
    model,
    ...(account === undefined ? {} : { account }),
    ...extra,
  })
}

/** A model pool preset of `group` (stored with mode `same`, as `presets.set` writes it). */
export function pooled(group: Preset.Group, entries: ReadonlyArray<Preset.PoolEntry>): Preset.Info {
  return Schema.decodeUnknownSync(Preset.Info)({
    ...Preset.builtin(group),
    id: SAVED,
    name: "pool",
    workers: { mode: "same", roles: {}, pool: entries },
    delegation: "when-useful",
  })
}
