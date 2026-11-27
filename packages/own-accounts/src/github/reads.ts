export * as GitHubReads from "./reads.js"

/**
 * Which of GitHub's MCP server's tools count as reads (16 §5.3, GH-15): a read runs at once and is offered where only
 * read-only accounts apply; anything else is a write, which asks and is hidden there. The server's `readOnlyHint`
 * alone is not enough (a wrong or changed hint would run a write unasked): a tool counts as a read when the server
 * marks it read-only and its name reads as one ({@link readName}), or when it is on the reviewed list of that server
 * version ({@link REVIEWED}).
 */

/**
 * The reads of each reviewed server version (its `serverInfo` as `<name> <version>`): github-mcp-server 2.0.3's 91
 * tools were read one by one (GH-15); these 57 only read, the other 34 write.
 */
export const REVIEWED: Readonly<Record<string, ReadonlyArray<string>>> = {
  "github-mcp-server 2.0.3": [
    "actions_get",
    "actions_list",
    "custom_properties_read",
    "get_code_quality_finding",
    "get_code_scanning_alert",
    "get_commit",
    "get_dependabot_alert",
    "get_discussion",
    "get_discussion_comments",
    "get_file_contents",
    "get_gist",
    "get_global_security_advisory",
    "get_job_logs",
    "get_label",
    "get_latest_release",
    "get_me",
    "get_notification_details",
    "get_release_by_tag",
    "get_repository_tree",
    "get_secret_scanning_alert",
    "get_tag",
    "get_team_members",
    "get_teams",
    "issue_read",
    "list_branches",
    "list_code_scanning_alerts",
    "list_commits",
    "list_dependabot_alerts",
    "list_discussion_categories",
    "list_discussions",
    "list_gists",
    "list_global_security_advisories",
    "list_issue_fields",
    "list_issue_types",
    "list_issues",
    "list_label",
    "list_notifications",
    "list_org_repository_security_advisories",
    "list_pull_requests",
    "list_releases",
    "list_repository_collaborators",
    "list_repository_security_advisories",
    "list_secret_scanning_alerts",
    "list_starred_repositories",
    "list_tags",
    "projects_get",
    "projects_list",
    "pull_request_read",
    "repository_ruleset_read",
    "search_code",
    "search_commits",
    "search_issues",
    "search_orgs",
    "search_pull_requests",
    "search_repositories",
    "search_users",
    "ui_get",
  ],
}

/** Words of a tool name that make it a write whatever else it says (`mark_all_notifications_read`). */
const WRITE_WORDS = new Set([
  "add",
  "assign",
  "cancel",
  "create",
  "delete",
  "dismiss",
  "edit",
  "fork",
  "manage",
  "mark",
  "merge",
  "push",
  "remove",
  "rerun",
  "run",
  "set",
  "star",
  "submit",
  "trigger",
  "unstar",
  "update",
  "write",
])

/** A name that reads as a read: `get_…`, `list_…`, `search_…`, or `…_get`, `…_list`, `…_read`, and no write word. */
export function readName(name: string) {
  const words = name.toLowerCase().split(/[_-]+/)
  if (words.some((word) => WRITE_WORDS.has(word))) return false
  const first = words[0]
  const last = words.at(-1)
  return first === "get" || first === "list" || first === "search" || last === "get" || last === "list" || last === "read"
}

/** Whether a tool counts as a read: reviewed for this server version, or marked read-only with a read's name. */
export function isRead(name: string, readOnlyHint: boolean, server: string | undefined) {
  if (server !== undefined && REVIEWED[server]?.includes(name)) return true
  return readOnlyHint && readName(name)
}
