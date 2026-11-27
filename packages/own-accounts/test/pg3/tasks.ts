// The ten PG3 tasks (07 §8.4) and the small project they are about. Every task is read-only (the runner also sets the
// session's approval mode to `read-only`) and never asks for subagents, so `요청할 때만` must stay at zero calls.
// Six tasks split into independent parts (where `도움될 때` and `적극적으로` should delegate), four do not. Prompts are
// ASCII without quotes or backslashes: they appear verbatim in the JSON request bodies the fake models search.

import fs from "node:fs/promises"
import path from "node:path"

export interface Task {
  readonly id: string
  readonly prompt: string
  /** Whether the work splits into independent parts, so delegating can save time or improve quality. */
  readonly splittable: boolean
  /**
   * How many parts a delegating model hands out (the fake models of `--fake` do exactly this; 0 when not splittable).
   * t09's eight parts pass `적극적으로`'s per-message cap (12) but not `도움될 때`'s (6), so the decline path runs.
   */
  readonly parts: number
}

export const TASKS: ReadonlyArray<Task> = [
  {
    id: "t01",
    prompt:
      "Review src/inventory.ts, src/billing.ts and src/shipping.ts for bugs. The three files are independent of each other. Report each bug with its file and line, and do not edit any file.",
    splittable: true,
    parts: 3,
  },
  {
    id: "t02",
    prompt:
      "For each of src/inventory.ts, src/billing.ts and src/auth.ts, explain in two sentences what it exports and who would call it. Do not edit any file.",
    splittable: true,
    parts: 3,
  },
  {
    id: "t03",
    prompt: "What does applyDiscount(100, 0.15) in src/billing.ts return? Answer with the number only.",
    splittable: false,
    parts: 0,
  },
  {
    id: "t04",
    prompt: "Which file defines MAX_WEIGHT_KG, and what is its value?",
    splittable: false,
    parts: 0,
  },
  {
    id: "t05",
    prompt:
      "For every exported function in src/, say whether a test in test/ covers it, and propose one missing test case per uncovered function. Do not write any file.",
    splittable: true,
    parts: 4,
  },
  {
    id: "t06",
    prompt: "Suggest a clearer name for the function calc in src/shipping.ts. Answer in one line.",
    splittable: false,
    parts: 0,
  },
  {
    id: "t07",
    prompt:
      "Answer three independent questions: (a) how src/auth.ts compares passwords, (b) what src/inventory.ts does when stock would go below zero, (c) which currencies src/billing.ts supports. Do not edit any file.",
    splittable: true,
    parts: 3,
  },
  {
    id: "t08",
    prompt: "Summarize README.md in two sentences.",
    splittable: false,
    parts: 0,
  },
  {
    id: "t09",
    prompt:
      "Audit each of the eight files listed in README.md separately for naming and style problems, with one short list per file. Do not edit any file.",
    splittable: true,
    parts: 8,
  },
  {
    id: "t10",
    prompt:
      "Plan a refactor that moves the weight and price checks shared by src/billing.ts and src/shipping.ts into a new module. Look at both call sites first, then give the plan as numbered steps. Do not edit any file.",
    splittable: true,
    parts: 2,
  },
]

/**
 * PG13 (07 §8.4 모델 묶음 A/B): the ten tasks and two that name a kind of model in plain words, the way a user asks a
 * main to pick from its pool: a review by another company's model and a quick, light skim. Both split (the main hands
 * one or two parts to a pool model) and neither needs a model that costs money.
 */
export const POOL_TASKS: ReadonlyArray<Task> = [
  ...TASKS,
  {
    id: "t11",
    prompt:
      "Get a second opinion from a model of another company: review src/billing.ts for bugs and report each with its line. Do not edit any file.",
    splittable: true,
    parts: 1,
  },
  {
    id: "t12",
    prompt:
      "Skim src/inventory.ts and src/shipping.ts lightly and list the exported names of each, one line per file. Do not edit any file.",
    splittable: true,
    parts: 2,
  },
]

/** The project the tasks talk about: eight files with a few planted bugs. No secrets. */
export const FIXTURE: Readonly<Record<string, string>> = {
  "README.md": [
    "# pg3-shop",
    "",
    "A tiny shop backend used by the PG3 delegation test. Files:",
    "",
    "- README.md, package.json",
    "- src/inventory.ts, src/billing.ts, src/shipping.ts, src/auth.ts",
    "- test/billing.test.ts, test/inventory.test.ts",
    "",
  ].join("\n"),
  "package.json": JSON.stringify({ name: "pg3-shop", private: true, type: "module" }, null, 2) + "\n",
  "src/inventory.ts": [
    "const stock = new Map<string, number>()",
    "",
    "export function add(item: string, count: number) {",
    "  stock.set(item, (stock.get(item) ?? 0) + count)",
    "}",
    "",
    "export function reserve(item: string, count: number) {",
    "  const left = (stock.get(item) ?? 0) - count",
    "  // Bug: a reservation may take the stock below zero.",
    "  if (left >= -1) stock.set(item, left)",
    "  return left",
    "}",
    "",
  ].join("\n"),
  "src/billing.ts": [
    'export const CURRENCIES = ["USD", "EUR", "KRW"]',
    "",
    "export function applyDiscount(price: number, rate: number) {",
    "  return price - price * rate",
    "}",
    "",
    "export function toCents(amount: number) {",
    "  // Bug: negative amounts round the wrong way.",
    "  return Math.floor(amount * 100)",
    "}",
    "",
    "export function checkPrice(price: number) {",
    "  return price > 0 && price < 1_000_000",
    "}",
    "",
  ].join("\n"),
  "src/shipping.ts": [
    "export const MAX_WEIGHT_KG = 30",
    "",
    "export function calc(weightKg: number) {",
    "  // Bug: exactly MAX_WEIGHT_KG is refused.",
    "  if (weightKg <= 0 || weightKg >= MAX_WEIGHT_KG) return undefined",
    "  return 5 + weightKg * 1.5",
    "}",
    "",
    "export function checkWeight(weightKg: number) {",
    "  return weightKg > 0 && weightKg <= MAX_WEIGHT_KG",
    "}",
    "",
  ].join("\n"),
  "src/auth.ts": [
    "const users = new Map<string, string>()",
    "",
    "export function register(name: string, password: string) {",
    "  users.set(name, password)",
    "}",
    "",
    "export function login(name: string, password: string) {",
    "  // Plain comparison of stored plain text.",
    "  return users.get(name) === password",
    "}",
    "",
  ].join("\n"),
  "test/billing.test.ts": [
    'import { expect, test } from "bun:test"',
    'import { applyDiscount } from "../src/billing"',
    "",
    'test("discount", () => {',
    "  expect(applyDiscount(100, 0.15)).toBe(85)",
    "})",
    "",
  ].join("\n"),
  "test/inventory.test.ts": [
    'import { expect, test } from "bun:test"',
    'import { add, reserve } from "../src/inventory"',
    "",
    'test("reserve", () => {',
    '  add("pen", 2)',
    '  expect(reserve("pen", 1)).toBe(1)',
    "})",
    "",
  ].join("\n"),
}

/** Writes {@link FIXTURE} into `dir` (created when missing). */
export async function writeFixture(dir: string) {
  await Promise.all(
    Object.entries(FIXTURE).map(async ([name, text]) => {
      const file = path.join(dir, name)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, text)
    }),
  )
}
