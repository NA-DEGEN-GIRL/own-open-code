// `@` mention providers (03 §18.12): files (max 20) → agents → skills → references → MCP resources, in that order.
//
// Files: `GET /api/fs/find?query=&limit=20` in the session location. The server ranks (fuzzysort over its ripgrep or
// fff index), so the order is kept as is. On Windows fff is off by default (packages/cli/src/server-process.ts:121-124,
// packages/core/src/filesystem/search.ts:191) and the ripgrep index is rebuilt at most every 10 s, answering from the
// old index meanwhile (search.ts:25, 88-107): a file the agent just wrote can be missing for ~10 s. So the files the
// session changed in its last turn (`session.diff`, 18.5) that match the query are pinned on top, deduplicated.
// Requests: 80 ms debounce and never while composing (engine), one in flight (older ones aborted), answers cached
// per query for the server's refresh interval so Backspace is instant.
//
// Catalogs (agents, skills, references, MCP resources) come from the session-ui data layer's per-location stores
// (`data.location.*`), which the server's `agent.updated`, `skill.updated`, `reference.updated` and
// `mcp.resources.changed` events invalidate. They load the first time the list opens, not at startup (PF6).
import { createStore } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import { rank } from "./rank"
import { formatRange, splitRange } from "./range"
import type { MentionText } from "./strings"
import type { MentionChip, SelectEffect, SuggestContext, SuggestItem, SuggestProvider } from "./types"

export const FILE_LIMIT = 20
const GROUP_LIMIT = 8
/** Pinned "recently changed" files at most. */
const RECENT_LIMIT = 5
/** Same as the server index refresh (core filesystem/search.ts REFRESH_INTERVAL). */
const FIND_TTL_MS = 10_000
const FIND_CACHE = 64
/** A finished session's diff does not change; a running one is read again after this. */
const DIFF_TTL_MS = 10_000

/** The chip each mention item stands for. Items are created per search, so a WeakMap keeps no garbage. */
const chipOf = new WeakMap<SuggestItem, MentionChip>()

export function mentionItemChip(item: SuggestItem) {
  return chipOf.get(item)
}

function item(value: SuggestItem, chip: MentionChip) {
  chipOf.set(value, chip)
  return value
}

/** Choosing a mention removes the `@query` from the text and adds the chip. */
function selectChip(value: SuggestItem): SelectEffect | undefined {
  const chip = chipOf.get(value)
  return chip ? { text: "", chip } : undefined
}

export function createMentionProviders(text: MentionText): SuggestProvider[] {
  const recent = createRecentFiles()
  const found = new Map<string, { readonly at: number; readonly items: readonly SuggestItem[] }>()
  const warmed = new Set<string>()

  const fileItem = (path: string, directory: boolean, range: ReturnType<typeof splitRange>["range"], badge?: string) =>
    item(
      {
        id: `file:${path}${directory ? "/" : formatRange(range)}`,
        group: "files",
        label: directory ? `${path}/` : `${path}${formatRange(range)}`,
        icon: directory ? "▸" : "@",
        badge: badge ?? (directory ? text("own.mention.folder") : undefined),
      },
      directory ? { kind: "file", path, directory: true } : { kind: "file", path, range },
    )

  const files: SuggestProvider = {
    id: "files",
    trigger: "mention",
    limit: FILE_LIMIT,
    label: () => text("own.mention.group.files"),
    // Only for choosing the preselected row; files keep the server order.
    keys: (value) => [basename(value.label), value.label],
    prepare(context) {
      recent.load(context)
      // The first `fs.find` of a location builds the server index (ripgrep: ~2.7 s on this repository, see the
      // report); an empty query builds it and answers nothing, so it runs while the user types the first letters.
      const directory = context.directory
      const key = `${context.serverKey}
${directory}`
      if (!directory || warmed.has(key) || context.runtime.connection.status() !== "connected") return
      warmed.add(key)
      void context.runtime
        .client()
        .file.find({ location: { directory }, query: "", limit: 1 })
        .catch(() => warmed.delete(key))
    },
    pinned(query, context) {
      const split = splitRange(query)
      const paths = recent.list(context)
      if (!paths.length) return []
      return rank(paths, split.query, (path) => [basename(path), path], RECENT_LIMIT).map((path) =>
        fileItem(path, false, split.range, text("own.mention.recent")),
      )
    },
    async remote(query, context, signal) {
      const split = splitRange(query)
      const directory = context.directory
      if (!split.query.trim() || !directory) return []
      const find = async (text: string): Promise<readonly SuggestItem[]> => {
        const response = await context.runtime
          .client()
          .file.find({ location: { directory }, query: text, limit: FILE_LIMIT }, { signal })
        return response.data.map((entry) => {
          const path = entry.path.replaceAll("\\", "/").replace(/\/+$/, "")
          return fileItem(path, entry.type === "directory", undefined)
        })
      }
      const key = `${context.serverKey}\n${directory}\n${split.query}`
      const cached = found.get(key)
      const entries = cached && Date.now() - cached.at < FIND_TTL_MS ? cached.items : await find(split.query)
      if (entries !== cached?.items) remember(found, key, { at: Date.now(), items: entries })
      if (!split.range) return entries
      return entries.map((entry) => {
        const chip = chipOf.get(entry)
        return chip?.kind === "file" && !chip.directory ? fileItem(chip.path, false, split.range) : entry
      })
    },
    select: selectChip,
  }

  const agents: SuggestProvider = {
    id: "agents",
    trigger: "mention",
    limit: GROUP_LIMIT,
    label: () => text("own.mention.group.agents"),
    prepare: (context) => sync(context, (location) => context.runtime.data.location.agent.sync(location)),
    local: (context) =>
      (catalog(context, (location) => context.runtime.data.location.agent.list(location)) ?? [])
        // Subagents are what `@` hands work to; primary agents are chosen with `/agent` (upstream does the same).
        .filter((agent) => !agent.hidden && agent.mode !== "primary")
        .map((agent) =>
          item(
            {
              id: `agent:${agent.id}`,
              group: "agents",
              // The id is what prompts carry (`agents[].name`, upstream normalizeAgentList); the name is for people.
              label: `@${agent.id}`,
              detail: agent.description ?? (agent.name !== agent.id ? agent.name : undefined),
              icon: "◎",
            },
            { kind: "agent", name: agent.id },
          ),
        ),
    keys: (value) => [value.label.slice(1)],
    select: selectChip,
  }

  const skills: SuggestProvider = {
    id: "skills",
    trigger: "mention",
    limit: GROUP_LIMIT,
    label: () => text("own.mention.group.skills"),
    prepare: (context) => sync(context, (location) => context.runtime.data.location.skill.sync(location)),
    local: (context) =>
      (catalog(context, (location) => context.runtime.data.location.skill.list(location)) ?? []).map((skill) =>
        item(
          {
            id: `skill:${skill.id}`,
            group: "skills",
            label: `@${skill.id}`,
            detail: skill.description ?? (skill.name !== skill.id ? skill.name : undefined),
            icon: "✦",
          },
          { kind: "skill", id: skill.id, name: skill.name },
        ),
      ),
    keys: (value) => [value.label.slice(1)],
    select: selectChip,
  }

  const references: SuggestProvider = {
    id: "references",
    trigger: "mention",
    limit: GROUP_LIMIT,
    label: () => text("own.mention.group.references"),
    prepare: (context) => sync(context, (location) => context.runtime.data.location.reference.sync(location)),
    local: (context) =>
      (catalog(context, (location) => context.runtime.data.location.reference.list(location)) ?? [])
        .filter((reference) => !reference.hidden)
        .map((reference) =>
          item(
            {
              id: `reference:${reference.name}`,
              group: "references",
              label: `@${reference.name}`,
              detail:
                reference.description ??
                (reference.source.type === "git" ? reference.source.repository : reference.source.path),
              icon: "⌂",
            },
            { kind: "reference", name: reference.name, path: reference.path },
          ),
        ),
    keys: (value) => [value.label.slice(1)],
    select: selectChip,
  }

  const resources: SuggestProvider = {
    id: "resources",
    trigger: "mention",
    limit: GROUP_LIMIT,
    label: () => text("own.mention.group.resources"),
    prepare: (context) => sync(context, (location) => context.runtime.data.location.mcp.resource.sync(location)),
    local: (context) =>
      (catalog(context, (location) => context.runtime.data.location.mcp.resource.list(location)) ?? []).map(
        (resource) =>
          item(
            {
              id: `resource:${resource.server}:${resource.uri}`,
              group: "resources",
              label: resource.name,
              detail: `${resource.server} · ${resource.uri}`,
              icon: "⧉",
            },
            { kind: "resource", server: resource.server, uri: resource.uri, name: resource.name },
          ),
      ),
    keys: (value) => [value.label, value.detail ?? ""],
    select: selectChip,
  }

  return [files, agents, skills, references, resources]
}

type Location = { readonly directory: string }

function catalog<T>(context: SuggestContext, read: (location: Location) => T | undefined) {
  return context.directory ? read({ directory: context.directory }) : undefined
}

function sync(context: SuggestContext, load: (location: Location) => Promise<unknown>) {
  if (!context.directory || context.runtime.connection.status() !== "connected") return
  void load({ directory: context.directory }).catch((error: unknown) =>
    console.error("[own-web] mention catalog", error),
  )
}

function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > FIND_CACHE) cache.delete(cache.keys().next().value!)
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1)
}

/**
 * Files the session changed in its last turn (`GET /api/session/:id/diff`, `context: 0` so only hunks travel),
 * read once per list opening at most, again only after a turn (the session was running) or 10 s.
 */
function createRecentFiles() {
  const [state, setState] = createStore<{ bySession: Record<string, readonly string[] | undefined> }>({
    bySession: {},
  })
  const loaded = new Map<string, { readonly at: number; readonly running: boolean }>()
  return {
    list: (context: SuggestContext) => (context.sessionID ? (state.bySession[context.sessionID] ?? []) : []),
    load(context: SuggestContext) {
      const sessionID = context.sessionID
      const runtime: ServerRuntime = context.runtime
      if (!sessionID || runtime.connection.status() !== "connected") return
      const running = runtime.data.session.status(sessionID) === "running"
      const last = loaded.get(sessionID)
      if (last && !last.running && !running && Date.now() - last.at < DIFF_TTL_MS) return
      loaded.set(sessionID, { at: Date.now(), running })
      void runtime
        .client()
        .session.diff({ sessionID, context: 0 })
        .then((diffs) =>
          setState(
            "bySession",
            sessionID,
            diffs.filter((diff) => diff.status !== "deleted").map((diff) => diff.file.replaceAll("\\", "/")),
          ),
        )
        // A session without a finished turn has no diff yet (404/400): nothing to pin.
        .catch(() => undefined)
    },
  }
}
