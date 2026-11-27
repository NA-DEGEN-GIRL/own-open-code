export * as KillSwitch from "./killswitch.js"

import { readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Clock, Effect, Option, Result, Schema } from "effect"
import { ComputerError } from "./errors.js"

/**
 * The global stop. Engaged by the physical stop chord (helper RegisterHotKey), the Stop button (RPC) or the helper
 * exiting; while engaged every action fails with `[computer.stopped]` and actions in progress stop at their next step.
 * Only an explicit RPC reset clears it — never a tool, a timer or a helper restart. The engaged state is also kept in
 * a file (`load`/`save`), so neither a new desktop (the last Location released it) nor a service restart clears it,
 * and every build in the process shares one switch per file (`shared`), so a hot reload cannot split it.
 */
export const Reason = Schema.Literals(["user_chord", "rpc", "helper_exit"])
export type Reason = typeof Reason.Type

export type State =
  | { readonly engaged: false }
  | { readonly engaged: true; readonly reason: Reason; readonly at: number }

export const initial: State = { engaged: false }

/** Engaging an engaged switch keeps the first reason and time. */
export function engage(state: State, reason: Reason, at: number): State {
  return state.engaged ? state : { engaged: true, reason, at }
}

export interface KillSwitch {
  readonly state: Effect.Effect<State>
  readonly engage: (reason: Reason) => Effect.Effect<void>
  readonly reset: Effect.Effect<void>
  /** Fails with `stopped` while engaged; called before every input step. */
  readonly check: Effect.Effect<void, ComputerError>
}

/** A switch of its own that starts as `start` (the saved state, see `load`). */
export const make = (start: State = initial) => Effect.sync(() => over({ state: start }))

/**
 * The switch of `file` that every build in this process shares while one of its desktops is open. After a hot reload
 * the old and the new build each keep a desktop, and a Stop pressed in either one must stop both. Each build bundles its
 * own `effect`, so they share only plain data on `globalThis`: the state, and one `stopped` callback per desktop that
 * lets go of that desktop's held input and tells its clients. Starts engaged when the saved state (`load`) or another
 * build is engaged. `others` calls the other desktops' callbacks after an engage. `release` hands the switch back; the
 * last release drops the shared state, and the file carries an engaged one to the next desktop. Synchronous: a desktop
 * is created synchronously.
 */
export function shared(file: string, stopped: () => void) {
  const cells = globalThis as unknown as Record<symbol, Shared | undefined>
  const key = Symbol.for(`own-open-code.computer-use/kill-switch/${path.resolve(file)}`)
  const cell = (cells[key] ??= { state: initial, desktops: new Set() })
  cell.desktops.add(stopped)
  const saved = load(file)
  if (saved.engaged && !cell.state.engaged) cell.state = saved
  return {
    killSwitch: over(cell),
    others: () => {
      for (const desktop of cell.desktops) if (desktop !== stopped) desktop()
    },
    release: () => {
      cell.desktops.delete(stopped)
      if (cell.desktops.size === 0 && cells[key] === cell) delete cells[key]
    },
  }
}

interface Cell {
  state: State
}

interface Shared extends Cell {
  /** The `stopped` callback of every open desktop sharing the switch. */
  readonly desktops: Set<() => void>
}

function over(cell: Cell): KillSwitch {
  return {
    state: Effect.sync(() => cell.state),
    engage: (reason) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          cell.state = engage(cell.state, reason, now)
        }),
      ),
    reset: Effect.sync(() => {
      cell.state = initial
    }),
    check: Effect.suspend(() => (cell.state.engaged ? Effect.fail(new ComputerError("stopped")) : Effect.void)),
  }
}

const decodeEngaged = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ engaged: Schema.Literal(true), reason: Reason, at: Schema.Finite })),
)

/**
 * The saved state of `file`: none (the normal case) is disengaged. Only engaged states are ever written, so a file
 * that exists but cannot be read (locked by a scanner, no access) or does not decode (a write cut short) still counts
 * as engaged. Synchronous: a desktop is created synchronously.
 */
export function load(file: string): State {
  const text = Result.try({
    try: () => readFileSync(file, "utf8"),
    catch: (error) => (error as NodeJS.ErrnoException).code,
  })
  if (Result.isFailure(text) && text.failure === "ENOENT") return initial
  const engaged = (): State => ({ engaged: true, reason: "rpc", at: Date.now() })
  if (Result.isFailure(text)) return engaged()
  return Option.getOrElse(decodeEngaged(text.success), engaged)
}

/**
 * Writes an engaged state to `file` and removes it on reset. Best effort: a failed write leaves the running switch as
 * it is, only a later desktop or process would not see it.
 */
export const save = (file: string, state: State) =>
  Effect.tryPromise(async () => {
    if (!state.engaged) return rm(file, { force: true })
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(state), "utf8")
  }).pipe(Effect.ignore)
