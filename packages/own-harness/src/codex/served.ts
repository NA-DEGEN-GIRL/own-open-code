// The served catalog (10 §6.14): the model rows a ChatGPT account's Codex model list gave own.accounts that this
// harness can run (`CodexModels.HarnessRow`), asked of own.accounts in this process (`codexModels.rows`) before each
// Codex request is built, so a model the backend lists runs with its own row without waiting for a Codex sync. The
// revision makes an unchanged answer carry no rows. Without own.accounts (a test server) or on a remote service, which
// fetches no list, the bundled catalog stays.
export * as Served from "./served.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Rpc } from "@opencode/schema/rpc"
import { Portable } from "@own/protocol/portable"
import { OwnAccounts } from "@own/protocol/rpc"
import { Effect } from "effect"
import { Catalog } from "./catalog.js"

const RowsOnly = Rpc.define({
  id: OwnAccounts.ID,
  methods: { "codexModels.rows": OwnAccounts.Definition.methods["codexModels.rows"] },
  events: {},
})
let portable: typeof RowsOnly | undefined

/** The revision held, so an unchanged answer carries no rows. */
function have() {
  const revision = Catalog.revision()
  return revision === undefined ? {} : { have: revision }
}

/** Brings the served catalog up to own.accounts' rows; keeps what it has when own.accounts does not answer. */
export function refresh(ctx: Pick<Context, "rpc">) {
  return Effect.suspend(() =>
    ctx.rpc((portable ??= Portable.definition(RowsOnly)))["codexModels.rows"](have()),
  ).pipe(
    Effect.map((answer) => {
      if (answer.rows !== undefined) Catalog.serve(answer.revision, answer.rows)
    }),
    Effect.catchCause(() => Effect.void),
  )
}
