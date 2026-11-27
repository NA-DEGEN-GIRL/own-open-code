// Route table (03 §3). Routes carry the server key from day one: `/srv/:serverKey/s/:sessionID`; `/s/:id` is the
// short form for the local server. Route names are identical in path (web) and memory (desktop) routing.
import type { ImportKind } from "@/data/import-rpc"
import { LOCAL, type ServerKey } from "@/data/servers"

export type SettingsSection =
  | "general"
  | "layout"
  | "policy"
  | "presets"
  | "team"
  | "compaction"
  | "output"
  | "approval"
  | "shell"
  | "voice"
  | "skills"
  | "mcp"
  | "plugins"
  | "creator"
  | "import"
  | "remote"
  | "shortcuts"
  | "server"
  | "desktop"
  | "devices"
  | "experimental"
  | "harness"
  | "websearch"
  | "image"
  | "browse"
  | "github"
  | "updates"

/**
 * The settings list in five groups (03 §5.7): 기본 / 모델·계정 / 에이전트 / 연결 / 고급. `accounts` marks the group that
 * starts with the `계정 →` link. Route ids never change with the grouping.
 */
export const SETTINGS_GROUPS = [
  { id: "basic", sections: ["general", "layout", "shortcuts", "voice", "desktop"] },
  // IS (2026-11-08): 이미지 만들기 after 웹 검색, the other tool models call on the user's accounts (was a part of 컴퓨터
  // 사용 (실험)).
  { id: "models", accounts: true, sections: ["presets", "policy", "compaction", "output", "websearch", "image"] },
  // SM (2026-10-24): 스킬 and MCP 서버 follow 승인·권한, where the tools agents use are set up.
  // BRW (2026-11-17): 내 브라우저 사용 (실험) after 컴퓨터 사용 (실험), the other way agents work outside the project.
  { id: "agent", sections: ["harness", "approval", "skills", "mcp", "team", "shell", "experimental", "browse"] },
  // GH (2026-10-31): GitHub accounts beside the other connections.
  { id: "connect", sections: ["devices", "remote", "github", "server"] },
  // UPD (2026-11-04): the outside programs own runs on this PC (Claude Code, Git …), last.
  // CRM (2026-11-04): 확장, what creator mode made, after 다른 도구의 대화.
  { id: "advanced", sections: ["plugins", "import", "creator", "updates"] },
] as const satisfies ReadonlyArray<{
  readonly id: string
  readonly accounts?: true
  readonly sections: ReadonlyArray<SettingsSection>
}>

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]["id"]

/** Every section once, in the list's order. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap((group) => group.sections)

/**
 * Settings 팀 opened on one team (06 §9.8): `/settings/team/<serverKey>[/<teamID>]`. Team ids are unique per server
 * only, so the server comes first. `openTeamSettings` (the summary card's auto-allow `[바꾸기]`, the project menu) leads
 * here through {@link teamSettingsRoute}.
 */
export interface SettingsTeamTarget {
  readonly serverKey: ServerKey
  readonly teamID?: string
}

/**
 * A conversation of another tool (09 §5.2 `SourceRef`): the kind and two path-free tokens, so a route never carries a
 * path of another tool's files.
 */
export interface ImportRef {
  readonly kind: ImportKind
  readonly rootID: string
  readonly id: string
}

export type Route =
  /**
   * The new-conversation screen without a project (03 §5.1): the conversation works in the server's 기본 대화 폴더.
   * `/` is this PC's (the phone tier shows the conversation list there, 4.2); `/srv/<serverKey>/new` names the server
   * (an SSH host, whose service decides its folder, or this PC from a phone's `새 대화`).
   */
  | { readonly name: "home"; readonly serverKey?: ServerKey }
  | { readonly name: "project"; readonly serverKey: ServerKey; readonly projectID: string }
  /**
   * 09 §6: the conversations other tools left for a project (`/srv/<serverKey>/p/<projectID>/import`), or one of them
   * read only (`…/import/<kind>/<rootID>/<id>`).
   */
  | { readonly name: "import"; readonly serverKey: ServerKey; readonly projectID: string; readonly ref?: ImportRef }
  | { readonly name: "session"; readonly serverKey: ServerKey; readonly sessionID: string }
  | { readonly name: "accounts" }
  /** `kind`: the dialog opens on that kind's key form (`/accounts/add/oai`, 이미지 만들기 도구's `OpenAI API 키 추가`). */
  | { readonly name: "accountsAdd"; readonly kind?: "oai" }
  | { readonly name: "limits" }
  /**
   * `/settings` itself is `list`: the section list on a narrow main column (03 §5.7 drill-down), the first section
   * beside the list otherwise. `/settings/<section>` opens that page at every width.
   */
  | {
      readonly name: "settings"
      readonly section: SettingsSection
      readonly team?: SettingsTeamTarget
      readonly list?: true
    }

export type RouteName = Route["name"]

/** Unknown paths resolve to home. `replace` is set when the path was an alias (e.g. `/s/:id`). */
export function parseRoute(path: string): { route: Route; replace?: string } {
  const parts = path.split(/[?#]/, 1)[0]!.split("/").filter(Boolean).map(safeDecode)
  const [first, second, third, fourth] = parts
  if (!first) return { route: { name: "home" } }
  if (first === "srv" && second && third === "s" && fourth && parts.length === 4)
    return { route: { name: "session", serverKey: second, sessionID: fourth } }
  if (first === "srv" && second && third === "new" && parts.length === 3)
    return { route: { name: "home", serverKey: second } }
  if (first === "srv" && second && third === "p" && fourth && parts.length === 4)
    return { route: { name: "project", serverKey: second, projectID: fourth } }
  if (first === "srv" && second && third === "p" && fourth && parts[4] === "import") {
    const list: Route = { name: "import", serverKey: second, projectID: fourth }
    if (parts.length === 5) return { route: list }
    const ref = parts.length === 8 ? importRef(parts[5], parts[6], parts[7]) : undefined
    return ref ? { route: { ...list, ref } } : { route: list, replace: routePath(list) }
  }
  if (first === "s" && second && parts.length === 2) {
    const route: Route = { name: "session", serverKey: LOCAL, sessionID: second }
    return { route, replace: routePath(route) }
  }
  if (first === "accounts" && parts.length === 1) return { route: { name: "accounts" } }
  if (first === "accounts" && second === "add" && parts.length === 2) return { route: { name: "accountsAdd" } }
  if (first === "accounts" && second === "add" && third === "oai" && parts.length === 3)
    return { route: { name: "accountsAdd", kind: "oai" } }
  if (first === "limits" && parts.length === 1) return { route: { name: "limits" } }
  if (first === "settings" && second === "team" && third && parts.length <= 4)
    return {
      route: { name: "settings", section: "team", team: { serverKey: third, ...(fourth ? { teamID: fourth } : {}) } },
    }
  if (first === "settings" && parts.length === 1) return { route: { name: "settings", section: "general", list: true } }
  if (first === "settings" && parts.length === 2) {
    const section = SETTINGS_SECTIONS.find((item) => item === second) ?? "general"
    return { route: { name: "settings", section }, replace: second === section ? undefined : `/settings/${section}` }
  }
  return { route: { name: "home" }, replace: "/" }
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "home":
      return route.serverKey ? `/srv/${encodeURIComponent(route.serverKey)}/new` : "/"
    case "project":
      return `/srv/${encodeURIComponent(route.serverKey)}/p/${encodeURIComponent(route.projectID)}`
    case "import": {
      const list = `/srv/${encodeURIComponent(route.serverKey)}/p/${encodeURIComponent(route.projectID)}/import`
      const ref = route.ref
      if (!ref) return list
      return `${list}/${ref.kind}/${encodeURIComponent(ref.rootID)}/${encodeURIComponent(ref.id)}`
    }
    case "session":
      return `/srv/${encodeURIComponent(route.serverKey)}/s/${encodeURIComponent(route.sessionID)}`
    case "accounts":
      return "/accounts"
    case "accountsAdd":
      return route.kind ? `/accounts/add/${route.kind}` : "/accounts/add"
    case "limits":
      return "/limits"
    case "settings": {
      if (route.list) return "/settings"
      const team = route.section === "team" ? route.team : undefined
      if (!team) return `/settings/${route.section}`
      const server = `/settings/team/${encodeURIComponent(team.serverKey)}`
      return team.teamID ? `${server}/${encodeURIComponent(team.teamID)}` : server
    }
  }
}

/** Where `openTeamSettings` leads: settings 팀 on the named team, on the local server unless another one is named. */
export function teamSettingsRoute(target: { readonly serverKey?: ServerKey; readonly teamID?: string }): Route {
  if (target.serverKey === undefined && target.teamID === undefined) return { name: "settings", section: "team" }
  const team = { serverKey: target.serverKey ?? LOCAL, ...(target.teamID ? { teamID: target.teamID } : {}) }
  return { name: "settings", section: "team", team }
}

/** The server a workspace route is on: a session's, a project's or a server's home; this PC for everything else. */
export function routeServer(route: Route): ServerKey {
  if (route.name === "session" || route.name === "project") return route.serverKey
  if (route.name === "home") return route.serverKey ?? LOCAL
  return LOCAL
}

/** Pages replace the session view in the main column; the session view stays mounted underneath (PF7, IME). */
export function isPage(route: Route) {
  return (
    route.name === "accounts" ||
    route.name === "accountsAdd" ||
    route.name === "limits" ||
    route.name === "settings" ||
    route.name === "import"
  )
}

// Mapped over the protocol's kinds, so a new kind does not typecheck until it is listed here.
const IMPORT_KINDS: { readonly [K in ImportKind]: true } = { codex: true, "claude-code": true }
/** `SourceRef` tokens (09 §5.2): no separator, so no path. */
const IMPORT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** A `SourceRef` from route parts; `undefined` unless every part is a token `sessions.list` could have given. */
function importRef(kind: string | undefined, rootID: string | undefined, id: string | undefined) {
  if (!kind || !rootID || !id || !Object.hasOwn(IMPORT_KINDS, kind)) return undefined
  if (rootID.length > 64 || id.length > 256 || !IMPORT_TOKEN.test(rootID) || !IMPORT_TOKEN.test(id)) return undefined
  // SAFETY: `kind` is a key of IMPORT_KINDS, which lists exactly the ImportKind literals.
  return { kind: kind as ImportKind, rootID, id }
}

function safeDecode(part: string) {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}
