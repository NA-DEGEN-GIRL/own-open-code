export * as Notice from "./notice.js"

import type { OwnHarness } from "@own/protocol/rpc-harness"
import { Registry } from "./registry.js"

/** The tag that opens and closes the switch notice; a harness's request builder finds the notice by it. */
export const TAG = "harness_switch"

/**
 * The durable notice of a switch (10 §3.7), recorded once as a synthetic message. Its text depends only on the two
 * harnesses, so every request built from the history carries the same bytes.
 */
export function text(from: OwnHarness.HarnessID, to: OwnHarness.HarnessID) {
  const before = Registry.get(from).tools
  const target = Registry.get(to)
  const now = target.tools
  // A patch tool on both sides is renamed with the shell tool; one the new harness lacks keeps its name (pi).
  const renamed =
    before.patch !== undefined && now.patch !== undefined
      ? [
          `Earlier ${before.shell.name} and ${before.patch.name} calls are shown as ${now.shell.name} and ${now.patch.name}.`,
        ]
      : [
          `Earlier ${before.shell.name} calls are shown as ${now.shell.name}.`,
          ...(before.patch !== undefined
            ? [`Earlier ${before.patch.name} calls keep their name: the ${to} harness has no patch tool.`]
            : []),
        ]
  return [
    `<${TAG}>`,
    `This session now runs the ${to} harness (before: ${from}).`,
    ...renamed,
    ...(target.listed === undefined ? [] : [`The ${to} harness's tools: ${target.listed.join(", ")}.`]),
    "Use only the tools offered in this request; earlier calls to other tools are history.",
    `</${TAG}>`,
  ].join("\n")
}
