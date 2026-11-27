export * as Protection from "./protection.js"

import os from "node:os"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import { Kv, ProtectedPaths } from "@own/protocol"
import { PathForms } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { SessionApproval } from "../switching/approval.js"
import { ProtectedBuiltIn } from "./builtin.js"
import { ProtectedMatch } from "./match.js"
import { ShellReference } from "./shell.js"
import { ProtectedUser } from "./user.js"

/**
 * Owner: 에이전트가 못 여는 파일·폴더 (01 §13 "에이전트 접근", 03 §18.8, PP 2026-11-07). One list per service: own's own
 * places (the vault, the registry and service files, the database, Claude Code's and the old app's logins), the
 * built-in entries (`builtin.ts`) and the user's list (`user.ts`, the KV row `protectedPaths`).
 *
 * - Applied by own-accounts' permission `evaluate` hook ({@link Api.evaluate}) to every session of the service, in
 *   every approval mode (`기본 규칙` and custom sets included), from the next tool call: `read` and `edit` of a
 *   protected path are denied, which also keeps them out of grep and glob results (core P-031), Codex's and Pi's
 *   direct reads, image views and Claude Agent's tools (they all ask core); a folder outside the Location a tool
 *   reaches (`external_directory`: a file tool's folder, a shell's working folder, a `cd` target) is denied inside one;
 *   a shell command that names one asks, under `전체 허용` too. Every spelling of a path is matched (`PathForms`: 8.3
 *   names, links and junctions, device prefixes, admin shares, NTFS streams; PP-10). Nothing in the session rules changes: no rewrite of any session and no change to the tool list or
 *   the prompt, so no cached prefix moves. The approval bundles still end with own's own places
 *   (`SessionApproval.protectedPaths`), as before.
 * - Each Location's instance keeps the user's list in memory; a change is written to the KV and broadcast
 *   (`protectedPaths.changed`) so every instance takes it before its next evaluation.
 */

export interface Config {
  /** The home folder of the user the service runs as. */
  readonly home: () => string
  readonly env: () => Readonly<Record<string, string | undefined>>
  readonly platform: NodeJS.Platform
}

export function defaults(): Config {
  return { home: () => os.homedir(), env: () => process.env, platform: process.platform }
}

export type AddResult =
  | { readonly ok: true; readonly view: ProtectedPaths.View; readonly changed: boolean }
  | { readonly ok: false; readonly reason: ProtectedPaths.Problem; readonly path: string }

export interface Api extends Module.Lifecycle {
  view(): ProtectedPaths.View
  add(input: string): Promise<AddResult>
  remove(input: string): Promise<{ readonly view: ProtectedPaths.View; readonly changed: boolean }>
  suggest(): Promise<ProtectedPaths.Suggestions>
  /** Every protected pattern (own's, built-in, the user's), for searches that filter results themselves. */
  patterns(): ReadonlyArray<string>
  /**
   * The permission `evaluate` hook's part (tighten only): `read`/`edit` of a protected path and `external_directory`
   * into a protected folder → `deny`; a `shell` command naming one → `ask` with the path on the card. A deny is never
   * lifted.
   */
  evaluate(event: PermissionEvaluation): void
}

const OWN_REASONS: Readonly<Record<SessionApproval.OwnPlace, string>> = {
  vault: "own의 계정 키 보관함이에요. API 키와 로그인 토큰이 들어 있어요",
  files: "own의 계정 목록·설정 파일과 계정 로그인 폴더예요(그 아래 JSON 파일 모두)",
  config: "서비스 비밀번호와 전역 설정 파일이에요",
  database: "모든 대화 기록이 든 세션 DB예요",
  claude: "Claude Code의 로그인 토큰이에요",
  "claude-config": "Claude 구독이 쓰는 Claude Code 폴더의 로그인 토큰이에요",
  profiles: "이전 앱 프로필의 로그인이에요",
}

export function create(deps: Deps, peers: Module.Peers, config: Config = defaults()): Api {
  const log = deps.log.child("protection")
  const platform = config.platform
  const state: { user: ReadonlyArray<string>; off?: () => void; queue: Promise<unknown> } = {
    user: [],
    queue: Promise.resolve(),
  }
  const builtIn = (() => {
    const placed: { value?: ReadonlyArray<ProtectedBuiltIn.Placed> } = {}
    return () => (placed.value ??= ProtectedBuiltIn.place({ platform, home: config.home(), env: config.env() }))
  })()
  const ownInput = () =>
    SessionApproval.protectedInput({
      home: deps.runtime.layout.root,
      userHome: config.home(),
      env: config.env(),
      registry: peers().slots.snapshot(),
    })
  const own = () => SessionApproval.ownPlaces(ownInput())
  const resolved = () =>
    state.user.flatMap((entry) => {
      const item = ProtectedUser.resolve(entry, config.home(), platform)
      return item.ok ? [{ path: entry, resolved: item.resolved }] : []
    })
  const label = (pattern: string) =>
    ProtectedMatch.display(pattern.replace(/\/\*\*$/, "").replace(/\*$/, ""), config.home(), platform)

  const moves = callFolders()

  // The compiled list, rebuilt when the registry (own's places) or the user's list changed.
  const memo: { registry?: unknown; user?: ReadonlyArray<string>; value?: Compiled } = {}
  const compiled = (): Compiled => {
    const registry = peers().slots.snapshot()
    if (memo.value && memo.registry === registry && memo.user === state.user) return memo.value
    const labeled = [
      ...own().flatMap((place) => place.patterns.map((pattern) => ({ pattern, label: label(pattern) }))),
      ...builtIn().flatMap((entry) => entry.patterns.map((pattern) => ({ pattern, label: label(pattern) }))),
      ...resolved().flatMap((entry) =>
        ProtectedBuiltIn.patterns(entry.resolved, "folder").map((pattern) => ({ pattern, label: entry.path })),
      ),
    ]
    const value = {
      patterns: [...new Set(labeled.map((item) => item.pattern))],
      matcher: ProtectedMatch.matcher(labeled, platform),
    }
    Object.assign(memo, { registry, user: state.user, value })
    return value
  }

  const view = (): ProtectedPaths.View => {
    const home = config.home()
    return {
      home,
      builtIn: [
        ...own().map((place) => ({
          id: `own-${place.place}`,
          group: "own" as const,
          paths: place.patterns.map(label),
          reason: OWN_REASONS[place.place],
        })),
        ...builtIn().map((entry) => ({
          id: entry.id,
          group: entry.group,
          paths: entry.paths.map((item) => ProtectedMatch.display(item, home, platform)),
          reason: entry.reason,
        })),
      ],
      user: resolved(),
    }
  }

  /** Writes run one at a time, each reading the KV row again (another instance may have written it). */
  const serial = <T>(work: () => Promise<T>) => {
    const run = state.queue.then(work)
    state.queue = run.catch(() => undefined)
    return run
  }
  const stored = async () => ProtectedUser.read(await deps.ctx.storage.get(Kv.protectedPaths))
  const save = async (paths: ReadonlyArray<string>) => {
    await deps.ctx.storage.set(Kv.protectedPaths, { paths: [...paths] })
    state.user = paths
    deps.runtime.broadcast.emit("protectedPaths.changed", { paths })
  }
  const sameAs = (entry: string, absolute: string) => {
    const item = ProtectedUser.resolve(entry, config.home(), platform)
    return item.ok && ProtectedUser.same(item.resolved, absolute, platform)
  }

  return {
    start: async () => {
      // An unreadable KV must not stop the plugin: the built-in list and own's places still apply.
      state.user = await stored().catch((error: unknown) => {
        log.error("protected_paths_unreadable", { error })
        return []
      })
      state.off = deps.runtime.broadcast.on("protectedPaths.changed", (payload) => {
        state.user = payload.paths
      })
    },
    stop: async () => {
      state.off?.()
    },
    view,
    add: (input) =>
      serial(async () => {
        const item = ProtectedUser.resolve(input, config.home(), platform)
        if (!item.ok) return { ok: false as const, reason: item.reason, path: input }
        const current = await stored()
        if (current.some((entry) => sameAs(entry, item.resolved))) {
          state.user = current
          return { ok: true as const, view: view(), changed: false }
        }
        if (current.length >= ProtectedPaths.MAX_USER)
          return { ok: false as const, reason: "too_many" as const, path: input }
        await save([...current, item.path])
        log.info("protected_path_added", { count: current.length + 1 })
        return { ok: true as const, view: view(), changed: true }
      }),
    remove: (input) =>
      serial(async () => {
        const current = await stored()
        const item = ProtectedUser.resolve(input, config.home(), platform)
        const next = current.filter(
          (entry) => entry.trim() !== input.trim() && !(item.ok && sameAs(entry, item.resolved)),
        )
        if (next.length === current.length) {
          state.user = current
          return { view: view(), changed: false }
        }
        await save(next)
        log.info("protected_path_removed", { count: next.length })
        return { view: view(), changed: true }
      }),
    suggest: async () => {
      const matcher = compiled().matcher
      return { items: await ProtectedUser.suggest(config.home(), (absolute) => matcher.find(absolute) !== undefined) }
    },
    patterns: () => compiled().patterns,
    evaluate: (event) => {
      if (event.effect === "deny" || !CHECKED.has(event.action)) return
      const matcher = compiled().matcher
      const protects = (absolute: string) =>
        PathForms.of(absolute, platform)
          .map(matcher.find)
          .find((label) => label !== undefined)
      if (event.action !== "shell") {
        // core asks `external_directory` with `<folder>/*` for each folder outside the Location a tool reaches: a file
        // tool's folder, a shell's working folder and its `cd` targets.
        const folders = event.action === "external_directory"
        const absolutes = event.resources.map((resource) =>
          ProtectedMatch.absolute(
            folders ? resource.replace(/[\\/]\*$/, "") : resource,
            deps.location.directory,
            platform,
          ),
        )
        const hit = absolutes.map(protects).find((label) => label !== undefined)
        if (hit === undefined) {
          if (folders) moves.note(event, absolutes)
          return
        }
        event.effect = "deny"
        event.message = `${hit} is protected on this machine: own keeps every agent's file tools and shell working folders out of it in every approval mode. Do not try to reach it another way; if the task needs it, tell the user.`
        return
      }
      const bases = { platform, home: config.home(), env: config.env() }
      const places = {
        platform,
        home: bases.home,
        ...(platform === "win32"
          ? { roaming: ProtectedBuiltIn.folder("roaming", bases), local: ProtectedBuiltIn.folder("local", bases) }
          : {}),
        directories: [
          deps.location.directory,
          ...moves.get(event),
          ...(event.resources.some(ShellReference.homeChange) ? [bases.home] : []),
        ],
      }
      const found = event.resources
        .map((resource) => ShellReference.find(resource, places, protects))
        .find((item) => item !== undefined)
      if (found === undefined) return
      event.effect = "ask"
      const note = `${ProtectedPaths.SHELL_NOTE}(${found.label})를 가리켜요: ${found.path}. 내용을 읽거나 바꾸거나 밖으로 보낼 수 있으니 명령을 확인하고 답하세요.`
      event.message = event.message === undefined ? note : `${note}\n${event.message}`
    },
  }
}

/** The actions the hook reads: file tools, the folders a tool reaches outside the Location, shell commands. */
const CHECKED = new Set(["read", "edit", "external_directory", "shell"])

/**
 * The folders each tool call's `external_directory` ask reached (its working folder, its `cd` targets), for the same
 * call's `shell` ask that follows: core moves them out of the command text, and a relative path in the command is
 * read from them. The latest 64 calls are kept.
 */
function callFolders() {
  const calls = new Map<string, ReadonlyArray<string>>()
  const key = (event: PermissionEvaluation) =>
    event.source && `${event.sessionID} ${event.source.messageID} ${event.source.id}`
  return {
    note: (event: PermissionEvaluation, folders: ReadonlyArray<string>) => {
      const id = key(event)
      if (id === undefined) return
      calls.delete(id)
      calls.set(id, folders)
      const oldest = calls.size > 64 ? calls.keys().next().value : undefined
      if (oldest !== undefined) calls.delete(oldest)
    },
    get: (event: PermissionEvaluation) => {
      const id = key(event)
      return (id === undefined ? undefined : calls.get(id)) ?? []
    },
  }
}

interface Compiled {
  readonly patterns: ReadonlyArray<string>
  readonly matcher: ProtectedMatch.Matcher
}
