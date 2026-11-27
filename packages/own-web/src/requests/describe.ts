// What a permission request is about (03 §18.1 머리줄): the action family, the command/file/URL it names, the edit
// previews core attaches, and the scope an "항상 허용" would save (the request's `save` patterns, which core stores
// per project through `PermissionSaved.add`, packages/core/src/permission.ts:295-302). Pure, shared by the dock (lazy
// chunk) and the OS notification text (first chunk).
import type { FormInfo, PermissionRequest } from "@opencode/client"

/** `question` tool, web search consent (`websearch.provider`), MCP elicitation, or any other server form. */
export type Flavor = "question" | "websearch" | "mcp" | "form"

export function formFlavor(form: Pick<FormInfo, "metadata">): Flavor {
  const kind = form.metadata?.kind
  if (kind === "question") return "question"
  if (kind === "websearch.provider") return "websearch"
  if (kind === "mcp-elicitation") return "mcp"
  return "form"
}

/** Metadata strings core puts on MCP elicitation forms (packages/core/src/mcp/index.ts:237-266). */
export function mcpInfo(form: Pick<FormInfo, "metadata">) {
  const server = form.metadata?.server
  const message = form.metadata?.message
  return {
    server: typeof server === "string" ? server : "",
    message: typeof message === "string" ? message : "",
  }
}

/** `creator` is creator mode's change of an extension (17 §7.2): its resources are the card's lines. */
export type ActionKind = "shell" | "edit" | "read" | "webfetch" | "websearch" | "external_directory" | "creator" | "other"

const KINDS: ReadonlySet<string> = new Set(["shell", "edit", "read", "webfetch", "websearch", "external_directory", "creator"])

export function actionKind(action: string): ActionKind {
  return KINDS.has(action) ? (action as ActionKind) : "other"
}

/** `metadata.files` of edit/write/patch requests (core `FileDiff.Info`, packages/schema/src/file-diff.ts). */
export interface FilePreview {
  readonly file: string
  readonly patch: string
  readonly additions: number
  readonly deletions: number
}

/** Validates the untyped request metadata once, here (edit, write and patch put `{files: FileDiff.Info[]}` there). */
export function filePreviews(request: Pick<PermissionRequest, "metadata">): FilePreview[] {
  const files = request.metadata?.files
  if (!Array.isArray(files)) return []
  return files.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return []
    const file = "file" in item && typeof item.file === "string" ? item.file : undefined
    if (!file) return []
    return [
      {
        file,
        patch: "patch" in item && typeof item.patch === "string" ? item.patch : "",
        additions: "additions" in item && typeof item.additions === "number" ? item.additions : 0,
        deletions: "deletions" in item && typeof item.deletions === "number" ? item.deletions : 0,
      },
    ]
  })
}

export type AlwaysScope =
  | { readonly kind: "none" }
  /** `save: ["*"]` (edit, webfetch, websearch, …): every request of the action in this project. */
  | { readonly kind: "all" }
  | { readonly kind: "shell"; readonly patterns: readonly string[] }
  | { readonly kind: "patterns"; readonly patterns: readonly string[] }

/** What "항상 허용" saves. Without `save` patterns core treats "always" as "once" (permission.ts:295). */
export function alwaysScope(request: Pick<PermissionRequest, "action" | "save">): AlwaysScope {
  const patterns = [...new Set(request.save ?? [])]
  if (!patterns.length) return { kind: "none" }
  if (patterns.includes("*")) return { kind: "all" }
  if (request.action === "shell") return { kind: "shell", patterns }
  return { kind: "patterns", patterns }
}

/** `"bun test *", "git status *"` */
export function quoted(patterns: readonly string[]) {
  return patterns.map((pattern) => `"${pattern}"`).join(", ")
}

/** Commands, paths, URLs or queries the request names; shell requests carry one resource per parsed command. */
export function subjects(request: Pick<PermissionRequest, "resources">) {
  return request.resources.filter((resource) => resource !== "*")
}

/** What a Code Mode `fetch` sends besides its URL: the method, the header names and the body's size (core
 * `CodeModeFetch.display`, P-049). Undefined for a plain GET without headers or body and for the webfetch tool; any
 * other method is shown even alone. */
export function fetchDetail(request: Pick<PermissionRequest, "metadata">) {
  const meta = request.metadata
  const headers = Array.isArray(meta?.headers)
    ? meta.headers.filter((name: unknown): name is string => typeof name === "string")
    : []
  const bytes = typeof meta?.bodyBytes === "number" ? meta.bodyBytes : undefined
  const method = typeof meta?.method === "string" ? meta.method : "GET"
  // A method other than GET is shown even alone: a bare DELETE changes things a GET does not.
  if (headers.length === 0 && bytes === undefined && method === "GET") return undefined
  return { method, headers, bytes }
}

/** Long commands fold (03 §18.1 "여러 줄이면 접기"). */
export const FOLD_LINES = 4
export const FOLD_CHARS = 320

export function folds(text: string) {
  return text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES
}

/** Diff previews render at most this many patch lines (the rest is summarized, R2/R4: no diff engine here). */
export const PATCH_LINES = 400

export function patchLines(patch: string) {
  const lines = patch.replace(/\n$/, "").split("\n")
  // Drop the `Index:`/`===` banner and `---`/`+++` headers; hunks and their lines stay.
  const start = lines.findIndex((line) => line.startsWith("@@"))
  const body = start >= 0 ? lines.slice(start) : lines
  return { shown: body.slice(0, PATCH_LINES), hidden: Math.max(0, body.length - PATCH_LINES) }
}

/** Agents from the open session down to the session that asked; empty when the open session asked itself. */
export function agentPath(
  openID: string,
  requesterID: string,
  get: (
    sessionID: string,
  ) => { readonly parentID?: string; readonly agent?: string; readonly title?: string } | undefined,
) {
  const agents: string[] = []
  const seen = new Set<string>()
  for (let id: string | undefined = requesterID; id && id !== openID && !seen.has(id); ) {
    seen.add(id)
    const info = get(id)
    agents.unshift(info?.agent ?? info?.title ?? id)
    id = info?.parentID
  }
  return agents
}
