import { Schema } from "effect"
import { statics } from "@opencode/schema/schema"
import { ulid } from "./id.js"

/** Stable account id: `acc_<ulid>`, or the synthetic `acc_claude_slot` (02 §2.1). */
export const AccountID = Schema.String.check(Schema.isPattern(/^acc_[0-9A-Za-z_]+$/)).pipe(
  Schema.brand("Own.AccountID"),
  Schema.annotate({ identifier: "Own.Account.ID" }),
  statics((schema) => ({
    create: () => schema.make("acc_" + ulid()),
    claudeSlot: schema.make("acc_claude_slot"),
  })),
)
export type AccountID = typeof AccountID.Type
