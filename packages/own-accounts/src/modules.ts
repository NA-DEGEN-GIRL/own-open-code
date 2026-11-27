export * as Modules from "./modules.js"

import { Auth } from "./auth/auth.js"
import { ClaudeAgent } from "./claude-agent/agent.js"
import { ClaudeAccounts } from "./claude/accounts.js"
import { Logins } from "./credentials/logins.js"
import type { Deps } from "./deps.js"
import { Health } from "./health/health.js"
import type { Logger } from "./logger.js"
import type { Module } from "./module.js"
import { Plugins } from "./plugins/plugins.js"
import { Presets } from "./presets/presets.js"
import { Protection } from "./protection/protection.js"
import { SkillsetRegister } from "./skillset/register.js"
import { CodexMeta } from "./slots/codex-meta.js"
import { Slots } from "./slots/slots.js"
import { SideQuestions } from "./side/side.js"
import { SessionSpeed } from "./speed/speed.js"
import { Switching } from "./switching/switching.js"
import { Telemetry } from "./telemetry/telemetry.js"

/** Every module of one plugin instance. Modules reach each other only through these APIs. */
export interface All {
  readonly slots: Slots.Api
  /** Codex model metadata: the fetch and the in-memory snapshot (07 §4.5). */
  readonly codexMeta: CodexMeta.Api
  readonly logins: Logins.Api
  readonly plugins: Plugins.Api
  /** Several Claude subscription accounts: list, per-conversation binding, login and removal (02 §8.7). */
  readonly claude: ClaudeAccounts.Api
  /** The Claude Agent route: its account, provider fold, limits and login (02 §8.10). */
  readonly claudeAgent: ClaudeAgent.Api
  readonly telemetry: Telemetry.Api
  readonly switching: Switching.Api
  readonly auth: Auth.Api
  readonly health: Health.Api
  readonly presets: Presets.Api
  /** A root session's speed (Fast, Ultrafast) and its request edits (02 §4.8). */
  readonly speed: SessionSpeed.Api
  /** The skill switches and scopes folded into this Location's skills (03 §19.6.1, SG). This PC only. */
  readonly skillset: SkillsetRegister.Api
  /** 에이전트가 못 여는 파일·폴더 (01 §13, PP): the protected paths and the permission hook that applies them. */
  readonly protection: Protection.Api
  /** 곁질문 (02 §9.7): side questions about a conversation, kept out of it. */
  readonly side: SideQuestions.Api
}

export type Name = keyof All

export type Factories = { readonly [K in Name]: (deps: Deps, peers: Module.Peers) => All[K] }

export const FACTORIES: Factories = {
  slots: Slots.create,
  codexMeta: CodexMeta.create,
  logins: Logins.create,
  plugins: Plugins.create,
  claude: ClaudeAccounts.create,
  claudeAgent: ClaudeAgent.create,
  telemetry: Telemetry.create,
  switching: Switching.create,
  auth: Auth.create,
  health: Health.create,
  presets: Presets.create,
  speed: SessionSpeed.create,
  skillset: SkillsetRegister.create,
  protection: (deps, peers) => Protection.create(deps, peers),
  side: SideQuestions.create,
}

/**
 * `start` order; `stop` runs in reverse. Slots first: the registry must be in memory before any fold or hook runs
 * (02 §3.8). The Codex metadata snapshot next, before anything reads it (the first fold, the ChatGPT group default).
 * Plugins before telemetry/switching so trust and Claude slot state exist when the first event arrives.
 */
export const ORDER: ReadonlyArray<Name> = [
  "slots",
  "codexMeta",
  "presets",
  "logins",
  "plugins",
  "claude",
  "claudeAgent",
  "telemetry",
  "switching",
  "auth",
  "speed",
  "skillset",
  "protection",
  "side",
  "health",
]

/** Event dispatch order (`onEvent`): ledger and cache state first, then the state machine that reads them. */
export const EVENT_ORDER: ReadonlyArray<Name> = [
  "telemetry",
  "switching",
  "plugins",
  "claude",
  "slots",
  "codexMeta",
  "logins",
  "auth",
  "speed",
  "health",
  "presets",
  "skillset",
  "claudeAgent",
  "protection",
  "side",
]

/** Creates every module. `overrides` replace factories, e.g. a fake peer in a module's unit test. */
export function create(deps: Deps, overrides: Partial<Factories> = {}): All {
  const factories = { ...FACTORIES, ...overrides }
  const peers: Module.Peers = () => modules
  const modules: All = {
    slots: factories.slots(deps, peers),
    codexMeta: factories.codexMeta(deps, peers),
    logins: factories.logins(deps, peers),
    plugins: factories.plugins(deps, peers),
    claude: factories.claude(deps, peers),
    claudeAgent: factories.claudeAgent(deps, peers),
    telemetry: factories.telemetry(deps, peers),
    switching: factories.switching(deps, peers),
    auth: factories.auth(deps, peers),
    health: factories.health(deps, peers),
    presets: factories.presets(deps, peers),
    speed: factories.speed(deps, peers),
    skillset: factories.skillset(deps, peers),
    protection: factories.protection(deps, peers),
    side: factories.side(deps, peers),
  }
  return modules
}

/** Starts modules in {@link ORDER}; on failure stops the ones already started and rethrows. */
export async function start(modules: All, log: Logger.Logger) {
  const started: Name[] = []
  for (const name of ORDER) {
    await modules[name].start().catch(async (error: unknown) => {
      log.error("module_start_failed", { module: name, error })
      await stop(modules, log, started)
      throw error
    })
    started.push(name)
  }
}

/** Stops modules in reverse {@link ORDER} (or the given started subset). Never throws. */
export async function stop(modules: All, log: Logger.Logger, names: ReadonlyArray<Name> = ORDER) {
  for (const name of [...names].reverse())
    await modules[name].stop().catch((error: unknown) => log.error("module_stop_failed", { module: name, error }))
}
