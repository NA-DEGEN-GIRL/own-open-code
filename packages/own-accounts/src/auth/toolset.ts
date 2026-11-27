export * as Toolset from "./toolset.js"

import type { SessionContext } from "@opencode/plugin/promise/session"
import { Hash } from "@own/runtime"

/**
 * What an own slot request sends ahead of its messages (02 §4.3 D10): the tool definitions (name, description, input
 * schema) and the system texts, hashed after own's shaping. Cache hints and tool order are not part of it, so only a
 * change of the bytes the model reads counts. Code Mode catalog changes never show here: they reach the request as
 * an instruction update message.
 */
export interface Fingerprint {
  readonly tools: string
  readonly system: string
}

export type Part = keyof Fingerprint

export function fingerprint(event: Pick<SessionContext, "tools" | "system">): Fingerprint {
  return {
    tools: Hash.stable(
      Object.fromEntries(
        Object.entries(event.tools).map(([name, tool]) => [name, { description: tool.description, input: tool.input }]),
      ),
    ),
    system: Hash.stable(event.system.map((part) => part.text)),
  }
}

/** The parts that differ, tools first. */
export function changed(previous: Fingerprint, next: Fingerprint): Part[] {
  return (["tools", "system"] as const).filter((part) => previous[part] !== next[part])
}
