// Texts own-web shows as own.team wrote them (03 §14.1, 2026-10-16): step notes (자세히, a failed step's reason), the
// reasons of refused and suggested items (`why`, and the reason a `reject`, `refuse`, `skip` … helper gets), notice
// texts (`notices.publish`), confirm texts (`prepare`), why a step waits (`report`) and the `message` of a helper's
// failure, which a step makes its note. They speak Korean 해요체 without spec references, like own-web's catalogs
// (packages/own-web/src/i18n/copy.test.ts). Read from the source: every such literal of `src` and the constants it
// names (`GONE`, `Settle.WAITS[why]`, also in another module), outside the model-facing tools (`src/tools`, whose
// results and descriptions only models read). A command stays (ALLOW). No literal of `src` outside the tools writes a
// particle marker such as `(을)를`: own-web resolves those only in its own catalogs, never in a text it shows as given.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import ts from "typescript"

const SRC = path.join(import.meta.dir, "..", "src")

/**
 * Notes that are a command or a tool's name, not a sentence; and the `git_too_old` message, which callers parse
 * (`/Git (\S+)/`) and word for the screen themselves (ops/enable.ts `versionNote`, reorg/plan.ts `reason`).
 */
const ALLOW: ReadonlySet<string> = new Set(["gh pr create", "Git {} is older than 2.40"])

/** Helpers whose string arguments end up on screen as a reason or a note. */
const CALLS: ReadonlySet<string> = new Set(["reject", "refuse", "refused", "invalid", "skip", "abandon", "report"])

const FORMAL = /[가-힣](니다|니까|십시오)(?=$|[\s.,:;!?…)"'’”\]])/
const ENGLISH = /[A-Za-z]{2,} [A-Za-z]{2,}/
const SPEC = /\(\d\d §|\bTI-\d|\bV\d+:|\bR4\b/
/** The two-form particles own-web's `applyJosa` resolves (packages/own-web/src/i18n/josa.ts). */
const MARKER = /\((?:으\)로|이\)가|을\)를|은\)는|과\)와|와\)과|이\)라)/

interface Found {
  readonly at: string
  readonly text: string
}

interface Module {
  readonly file: string
  readonly source: ts.SourceFile
  /** Top-level constants by name. */
  readonly constants: ReadonlyMap<string, ts.Expression>
  /** Names imported from another module of `src` (`import { Settle } from "./settle.js"`) → that module. */
  readonly imports: ReadonlyMap<string, string>
}

async function texts(): Promise<ReadonlyArray<Found>> {
  const modules = await sources()
  return [...modules.values()].filter((item) => !item.file.startsWith("tools/")).flatMap((item) => shown(item, modules))
}

/** Every string and template literal of `src` outside the tools. */
async function literals(): Promise<ReadonlyArray<Found>> {
  const out: Found[] = []
  const visit = (node: ts.Node, module: Module): void => {
    const words = ts.isExpression(node) ? literal(node) : undefined
    if (words !== undefined) {
      const line = module.source.getLineAndCharacterOfPosition(node.getStart(module.source)).line + 1
      out.push({ at: `${module.file}:${line}`, text: words })
    }
    ts.forEachChild(node, (child) => visit(child, module))
  }
  ;[...(await sources()).values()]
    .filter((item) => !item.file.startsWith("tools/"))
    .forEach((item) => visit(item.source, item))
  return out
}

async function sources() {
  const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC })].map((file) => file.replaceAll("\\", "/"))
  return new Map(
    await Promise.all(
      files.map(async (file) => [file, parse(file, await Bun.file(path.join(SRC, file)).text())] as const),
    ),
  )
}

function parse(file: string, text: string): Module {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  const constants = new Map<string, ts.Expression>()
  const imports = new Map<string, string>()
  source.statements.forEach((statement) => {
    if (ts.isVariableStatement(statement))
      statement.declarationList.declarations.forEach((declaration) => {
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          constants.set(declaration.name.text, declaration.initializer)
      })
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return
    const from = statement.moduleSpecifier.text
    const bindings = statement.importClause?.namedBindings
    if (!from.startsWith(".") || !bindings || !ts.isNamedImports(bindings)) return
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), from)).replace(/\.js$/, ".ts")
    bindings.elements.forEach((element) => imports.set(element.name.text, target))
  })
  return { file, source, constants, imports }
}

/** The user-visible literals of one module (constants of other modules they name are reported where they are). */
function shown(module: Module, modules: ReadonlyMap<string, Module>): ReadonlyArray<Found> {
  const out: Found[] = []
  const collect = (node: ts.Expression, where: Module, seen: ReadonlySet<string> = new Set()): void => {
    const follow = (part: ts.Expression) => collect(part, where, seen)
    const words = literal(node)
    if (words !== undefined) {
      const line = where.source.getLineAndCharacterOfPosition(node.getStart(where.source)).line + 1
      out.push({ at: `${where.file}:${line}`, text: words })
    }
    if (ts.isTemplateExpression(node)) return node.templateSpans.forEach((span) => follow(span.expression))
    if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse].forEach(follow)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      return follow(node.right)
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
      return follow(node.expression)
    if (ts.isElementAccessExpression(node)) return follow(node.expression)
    if (ts.isObjectLiteralExpression(node))
      return node.properties.forEach((property) => {
        if (ts.isPropertyAssignment(property)) follow(property.initializer)
      })
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return follow(node.body)
    const named = constant(node, where)
    if (!named || seen.has(named.key)) return
    collect(named.value, named.module, new Set([...seen, named.key]))
  }
  const constant = (node: ts.Expression, where: Module) => {
    if (ts.isIdentifier(node)) {
      const value = where.constants.get(node.text)
      return value && { key: `${where.file}:${node.text}`, value, module: where }
    }
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return undefined
    const target = modules.get(where.imports.get(node.expression.text) ?? "")
    const value = target?.constants.get(node.name.text)
    return target && value && { key: `${target.file}:${node.name.text}`, value, module: target }
  }
  const visit = (node: ts.Node, prepare: boolean): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const key = node.name.text
      if (
        key === "note" ||
        key === "why" ||
        key === "message" ||
        (key === "text" && (prepare || published(node, module.source)))
      )
        collect(node.initializer, module)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CALLS.has(node.expression.text))
      node.arguments.forEach((argument) => collect(argument, module))
    const inPrepare =
      prepare ||
      ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "prepare")
    ts.forEachChild(node, (child) => visit(child, inPrepare))
  }
  visit(module.source, false)
  return out
}

/** A string or template literal with `{}` for each substitution; `undefined` for anything else. */
function literal(node: ts.Expression) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("{}")
  return undefined
}

/** A `text` of the object `notices.publish({…})` gets. */
function published(node: ts.PropertyAssignment, source: ts.SourceFile) {
  const call = node.parent.parent
  return ts.isCallExpression(call) && call.expression.getText(source).endsWith("notices.publish")
}

describe("own.team's texts on screen (03 §14.1)", () => {
  test("are found", async () => {
    expect((await texts()).length).toBeGreaterThan(300)
  })

  test("speak 해요체: no 합니다체 sentence", async () => {
    const formal = (await texts()).filter((item) => FORMAL.test(item.text))
    expect(formal.map((item) => `${item.at} ${item.text}`)).toEqual([])
  })

  test("are Korean: no English sentence", async () => {
    const english = (await texts()).filter(
      (item) => !/[가-힣]/.test(item.text) && ENGLISH.test(item.text.replace(/\{\}/g, "")) && !ALLOW.has(item.text),
    )
    expect(english.map((item) => `${item.at} ${item.text}`)).toEqual([])
  })

  test("name no spec rule", async () => {
    const spec = (await texts()).filter((item) => SPEC.test(item.text))
    expect(spec.map((item) => `${item.at} ${item.text}`)).toEqual([])
  })

  test("pick their particles: no two-form marker such as (을)를", async () => {
    const marked = (await literals()).filter((item) => MARKER.test(item.text))
    expect(marked.map((item) => `${item.at} ${item.text}`)).toEqual([])
  })
})
