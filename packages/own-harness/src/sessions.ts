export * as Sessions from "./sessions.js"

import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Permission } from "@opencode/schema/permission"
import type { SessionID } from "@opencode/schema/session-id"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect } from "effect"
import { Gate } from "./gate.js"
import { Notice } from "./notice.js"

type Ctx = Pick<Context, "session">

/**
 * Session binding (10 §3.2): the harness and its prompt variant (§3.9) live in session metadata (`own.harness`). A new
 * top-level session that names none gets the configured defaults, or `claude-code` when it is created on the Claude
 * Agent provider; a child that names none gets its parent's (core copies the parent's metadata unless the creator
 * supplies its own, so this covers children created with other metadata).
 */
export const stamp = (
  ctx: Ctx,
  created: {
    readonly sessionID: SessionID
    readonly parentID?: SessionID
    readonly metadata?: Record<string, unknown>
    /** The model the session was created with (`session.created` carries it when the creator chose one). */
    readonly model?: { readonly providerID: string }
  },
  fallback: OwnHarness.HarnessID,
  fallbackPrompt: OwnHarness.PromptID,
) =>
  Effect.gen(function* () {
    const named = OwnHarness.bound(created.metadata)
    // A creator that names the harness (own-web's composer, a client) still needs that harness's tool gate.
    if (named !== undefined) {
      const info = yield* read(ctx, created.sessionID)
      const gated = Gate.rules(info?.permissions, named)
      if (info === undefined || JSON.stringify(gated) === JSON.stringify(info.permissions ?? [])) return
      return yield* write(ctx, created.sessionID, info, named, OwnHarness.promptOf(info.metadata))
    }
    const parent = created.parentID === undefined ? undefined : (yield* read(ctx, created.parentID))?.metadata
    const harness =
      created.parentID !== undefined
        ? OwnHarness.harnessOf(parent)
        : created.model?.providerID === OwnHarness.CLAUDE_AGENT
          ? "claude-code"
          : fallback
    const prompt = created.parentID === undefined ? fallbackPrompt : OwnHarness.promptOf(parent)
    const info = yield* read(ctx, created.sessionID)
    if (info === undefined || OwnHarness.bound(info.metadata) !== undefined) return
    yield* write(ctx, created.sessionID, info, harness, prompt)
  })

/**
 * Puts a bound session's tool gate back after a write of its rules lost it (`session.permissions`, index.ts). Every
 * rule writer reads, merges and writes the whole list, so two writers at once can drop each other's rules: the
 * composer's `session.approval.set` right after `session.create` raced {@link stamp} and the conversation ran with no
 * Codex tool at all (2026-11-19, live 내 브라우저 사용 run). Writes only when the gate is missing, so a mode change
 * that kept it is never written again. `true` when it wrote.
 */
export const heal = (ctx: Ctx, sessionID: SessionID, here: string) =>
  Effect.gen(function* () {
    const info = yield* ctx.session.get({ sessionID }).pipe(Effect.orElseSucceed(() => undefined))
    // Every Location sees the event: only the session's own writes, so one write is enough.
    if (info === undefined || !samePath(info.location.directory, here)) return false
    const harness = OwnHarness.bound(info.metadata)
    if (harness === undefined || Gate.holds(info.permissions, harness)) return false
    yield* ctx.session.update({ sessionID, permissions: Gate.rules(info.permissions, harness) }).pipe(Effect.orDie)
    return true
  })

function samePath(a: string, b: string) {
  const norm = (value: string) => path.resolve(value).toLowerCase()
  return process.platform === "win32" ? norm(a) === norm(b) : path.resolve(a) === path.resolve(b)
}

export type Switched =
  | { readonly _tag: "not_found" }
  | { readonly _tag: "busy" }
  | { readonly _tag: "done"; readonly binding: OwnHarness.Binding; readonly previous: OwnHarness.HarnessID }

/**
 * Binds the session to `harness` and a prompt variant between runs (10 §3.7, §3.9). A change of harness records one
 * durable notice that is delivered before the next prompt (`resume: false`: it starts no run of its own); a change of
 * variant only rewrites the key, since the next request carries the other base prompt anyway. Naming what a session
 * already runs implicitly only writes the key. `prompt` left out keeps the session's variant.
 */
export const set = (
  ctx: Ctx,
  sessionID: SessionID,
  harness: OwnHarness.HarnessID,
  prompt: OwnHarness.PromptID | undefined,
  busy: boolean,
) =>
  Effect.gen(function* () {
    const info = yield* read(ctx, sessionID)
    if (info === undefined) return { _tag: "not_found" } satisfies Switched
    if (busy) return { _tag: "busy" } satisfies Switched
    const previous = OwnHarness.harnessOf(info.metadata)
    const current = OwnHarness.promptOf(info.metadata)
    const binding = { sessionID, harness, explicit: true, prompt: prompt ?? current }
    if (previous === harness && binding.prompt === current && OwnHarness.bound(info.metadata) !== undefined)
      return { _tag: "done", binding, previous } satisfies Switched
    yield* write(ctx, sessionID, info, harness, binding.prompt)
    if (previous !== harness)
      yield* ctx.session
        .synthetic({
          sessionID,
          text: Notice.text(previous, harness),
          description: `Harness: ${previous} → ${harness}`,
          metadata: { [OwnHarness.META_KEY]: { switch: { from: previous, to: harness } } },
          delivery: "steer",
          resume: false,
        })
        .pipe(Effect.orDie)
    return { _tag: "done", binding, previous } satisfies Switched
  })

export const get = (ctx: Ctx, sessionID: SessionID) =>
  Effect.map(read(ctx, sessionID), (info) =>
    info === undefined
      ? undefined
      : {
          sessionID,
          harness: OwnHarness.harnessOf(info.metadata),
          explicit: OwnHarness.bound(info.metadata) !== undefined,
          prompt: OwnHarness.promptOf(info.metadata),
        },
  )

const read = (ctx: Ctx, sessionID: SessionID) =>
  ctx.session.get({ sessionID }).pipe(
    Effect.map((info) => ({ metadata: info.metadata, permissions: info.permissions })),
    Effect.orElseSucceed(() => undefined),
  )

/**
 * Read-merge-write of the binding and the session's tool gate (its harness's allow rule, `Gate.rules`): `session.update`
 * replaces the whole metadata and rule list, and other plugins keep their own keys and rules there.
 */
const write = (
  ctx: Ctx,
  sessionID: SessionID,
  info: { readonly metadata?: Record<string, unknown>; readonly permissions?: ReadonlyArray<Permission.Rule> },
  harness: OwnHarness.HarnessID,
  prompt: OwnHarness.PromptID,
) =>
  ctx.session
    .update({
      sessionID,
      metadata: { ...info.metadata, [OwnHarness.META_KEY]: OwnHarness.value(harness, prompt) },
      permissions: Gate.rules(info.permissions, harness),
    })
    .pipe(Effect.orDie)
