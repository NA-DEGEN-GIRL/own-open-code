// Every Korean text of the app has an English one: a key without it would show Korean on an English screen. The catalogs
// are read from the source (`"own.…": "…"` in any object), so one that is not exported or is assembled elsewhere counts
// too. Korean outside a catalog fails as well, except in the files below.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import ts from "typescript"
import { en } from "./en"
import { ko, type I18nKey } from "./ko"

const SRC = path.join(import.meta.dir, "..")
const KOREAN = /[가-힣]/

/** Keys whose Korean stays in English, with the reason. */
const KEPT: Readonly<Record<string, string>> = {
  "own.voice.set.ko": "the name of the Korean language",
  "own.reset.keywords": "search words of both languages",
}

/** Files with Korean outside the catalogs, with the reason. */
const OUTSIDE: Readonly<Record<string, string>> = {
  "accounts/claude-notice.ts": "both languages (the consent carries the hash of the one shown)",
  "accounts/claude-billing.ts": "source names in both languages",
  "adapter/ui-i18n.ts": "session-ui's Korean dictionary",
  "app-quit/index.tsx": "search words",
  "browser/remote/menu.ts": "both languages",
  "commands/catalog.ts": "Korean command names",
  "commands/providers.ts": "both languages",
  "explorer/actions.ts": "search words",
  "host/desktop.ts": "both languages",
  "host/mismatch.ts": "both languages",
  "host/types.ts": "an error's message for the log; the screen has its own words (host/mismatch.ts)",
  "i18n/josa.ts": "Korean particles",
  "ideas/layer.tsx": "search words",
  "limits/windows.ts": "the service's Korean names and their English",
  "markdown/corpus.ts": "test material",
  "mentions/testing.ts": "test material",
  "palette/builtin.ts": "search words",
  "pwa/manifest.ts": "the installed page's description, one language for every viewer",
  "queue/continue-action.ts": "both languages",
  "settings/claude-to-claude-notice.ts": "both languages",
  "settings/sections.tsx": "the name of the Korean language",
  "shell/palette-commands.tsx": "search words",
  "side/menu.ts": "both languages",
  "side/model.ts": "both languages",
  "sidebar/reorder.ts": "both languages",
  "team/title.ts": "the service's Korean titles and their English",
  "websearch/services.ts": "the service's Korean name and its English",
}

interface Found {
  readonly korean: Map<string, string>
  readonly english: Map<string, string>
  readonly outside: Set<string>
}

async function scan(): Promise<Found> {
  const found: Found = { korean: new Map(), english: new Map(), outside: new Set() }
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })]
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !/\.test\.|(^|\/)(testing|e2e)\//.test(file))
  for (const file of files) {
    const source = await Bun.file(path.join(SRC, file)).text()
    if (!KOREAN.test(source) && !source.includes('"own.')) continue
    const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind), file, found)
  }
  return found
}

function visit(node: ts.Node, file: string, found: Found): void {
  if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith("own.")) {
    const text = literal(node.initializer)
    if (text !== undefined) {
      const catalog = KOREAN.test(text) ? found.korean : found.english
      catalog.set(node.name.text, text)
      return
    }
  }
  const text = ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateLiteralToken(node) ? node.text : ""
  if (KOREAN.test(text)) found.outside.add(file)
  ts.forEachChild(node, (child) => visit(child, file, found))
}

function literal(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression)
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined
  const left = literal(node.left)
  const right = literal(node.right)
  return left === undefined || right === undefined ? undefined : left + right
}

/** `{name}` parameters; `${NAME}` is text (an environment variable's spelling). */
const params = (text: string) => [...text.matchAll(/(?<!\$)\{(\w+)\}/g)].map((match) => match[1]!)

describe("English (03 §14)", () => {
  test("every key of ko.ts is in en.ts", () => {
    const keys = (Object.keys(ko) as I18nKey[]).filter((key) => KOREAN.test(ko[key]))
    expect(keys.filter((key) => en[key] === undefined)).toEqual([])
  })

  test("every Korean text of every catalog has an English one, with no parameter of its own", async () => {
    const found = await scan()
    const keys = [...found.korean.keys()].filter((key) => !(key in KEPT))
    expect(keys.filter((key) => !found.english.has(key))).toEqual([])
    const unknown = keys.flatMap((key) =>
      params(found.english.get(key) ?? "").flatMap((name) =>
        params(found.korean.get(key)!).includes(name) ? [] : [`${key}: {${name}}`],
      ),
    )
    expect(unknown).toEqual([])
    expect(Object.keys(KEPT).filter((key) => !found.korean.has(key))).toEqual([])
  }, 60_000)

  test("no Korean outside the catalogs but in the listed files", async () => {
    const found = await scan()
    expect([...found.outside].filter((file) => !(file in OUTSIDE)).toSorted()).toEqual([])
    expect(Object.keys(OUTSIDE).filter((file) => !found.outside.has(file))).toEqual([])
  }, 60_000)
})
