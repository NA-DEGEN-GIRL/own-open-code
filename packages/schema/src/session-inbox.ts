export * as SessionInbox from "./session-inbox.js"

import { Schema } from "effect"
import { Location } from "./location.js"
import { Project } from "./project.js"
import { Attachment, Prompt } from "./prompt.js"
import { DateTimeUtcFromMillis, optional, RelativePath } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

export const Delivery = Schema.Literals(["steer", "queue"]).annotate({ identifier: "Session.Inbox.Delivery" })
export type Delivery = typeof Delivery.Type

export interface UserPayload extends Schema.Schema.Type<typeof UserPayload> {}
export const UserPayload = Schema.Struct({
  ...Prompt.fields,
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
}).annotate({ identifier: "Session.Inbox.UserPayload" })

/** A {@link UserPayload} whose files may stay on the server, for clients that opt into `experimental-media-uri`. */
export interface MediaUserPayload extends Schema.Schema.Type<typeof MediaUserPayload> {}
export const MediaUserPayload = Schema.Struct({
  ...UserPayload.fields,
  files: Schema.Array(Attachment).pipe(optional),
}).annotate({ identifier: "Session.Inbox.MediaUserPayload" })

export interface SyntheticPayload extends Schema.Schema.Type<typeof SyntheticPayload> {}
export const SyntheticPayload = Schema.Struct({
  text: Schema.String,
  description: Schema.String.pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  // OWN-PATCH(P-035) begin: the context reset a background job started before. While that reset waits or applies, the
  // notice is passive: it never promotes on its own and rides with the next promoted input. Cancelling or undoing the
  // reset drops it from the pending item, which is then an ordinary notice.
  beforeReset: SessionMessage.ID.pipe(optional),
  // The notice reports background work (a shell job, a subagent): a reset delivered ahead of it while it is pending
  // (a stop, an idle reset, a restart) ends the context that work belongs to, so the notice then precedes that reset.
  background: Schema.Boolean.pipe(optional),
  // OWN-PATCH(P-035) end
}).annotate({ identifier: "Session.Inbox.SyntheticPayload" })

export interface CompactionPayload extends Schema.Schema.Type<typeof CompactionPayload> {}
export const CompactionPayload = Schema.Struct({}).annotate({ identifier: "Session.Inbox.CompactionPayload" })

export interface MovePayload extends Schema.Schema.Type<typeof MovePayload> {}
export const MovePayload = Schema.Struct({
  location: Location.Ref,
  projectID: Project.ID,
  subpath: RelativePath.pipe(optional),
}).annotate({ identifier: "Session.Inbox.MovePayload" })

const UserItem = Schema.Struct({ type: Schema.tag("user"), payload: UserPayload, delivery: Delivery })
const SyntheticItem = Schema.Struct({ type: Schema.tag("synthetic"), payload: SyntheticPayload, delivery: Delivery })
const CompactionItem = Schema.Struct({
  type: Schema.tag("compaction"),
  payload: CompactionPayload,
  delivery: Delivery,
})
const MoveItem = Schema.Struct({ type: Schema.tag("move"), payload: MovePayload, delivery: Delivery })
// OWN-PATCH(P-035) begin: a context reset, admitted as a queued control item that delivers between turns
export interface ResetPayload extends Schema.Schema.Type<typeof ResetPayload> {}
export const ResetPayload = Schema.Struct({}).annotate({ identifier: "Session.Inbox.ResetPayload" })
const ResetItem = Schema.Struct({ type: Schema.tag("reset"), payload: ResetPayload, delivery: Delivery })

export const Item = Schema.Union([UserItem, SyntheticItem, CompactionItem, MoveItem, ResetItem]).pipe(
  // OWN-PATCH(P-035) end
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "Session.Inbox.Item" }),
)
export type Item = typeof Item.Type

const Enqueued = {
  id: SessionMessage.ID,
  sessionID: SessionID,
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}

export interface User extends Schema.Schema.Type<typeof User> {}
export const User = Schema.Struct({ ...Enqueued, ...UserItem.fields }).annotate({ identifier: "Session.Inbox.User" })

/** A {@link User} whose files may stay on the server, for clients that opt into `experimental-media-uri`. */
export interface MediaUser extends Schema.Schema.Type<typeof MediaUser> {}
export const MediaUser = Schema.Struct({ ...User.fields, payload: MediaUserPayload }).annotate({
  identifier: "Session.Inbox.MediaUser",
})

export interface Synthetic extends Schema.Schema.Type<typeof Synthetic> {}
export const Synthetic = Schema.Struct({ ...Enqueued, ...SyntheticItem.fields }).annotate({
  identifier: "Session.Inbox.Synthetic",
})

export interface Compaction extends Schema.Schema.Type<typeof Compaction> {}
export const Compaction = Schema.Struct({ ...Enqueued, ...CompactionItem.fields }).annotate({
  identifier: "Session.Inbox.Compaction",
})

export interface Move extends Schema.Schema.Type<typeof Move> {}
export const Move = Schema.Struct({ ...Enqueued, ...MoveItem.fields }).annotate({ identifier: "Session.Inbox.Move" })

// OWN-PATCH(P-035) begin
export interface Reset extends Schema.Schema.Type<typeof Reset> {}
export const Reset = Schema.Struct({ ...Enqueued, ...ResetItem.fields }).annotate({ identifier: "Session.Inbox.Reset" })

export const Info = Schema.Union([User, Synthetic, Compaction, Move, Reset]).pipe(
  // OWN-PATCH(P-035) end
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "Session.Inbox.Info" }),
)
export type Info = typeof Info.Type

/** {@link Info} with {@link MediaUser} for clients that opt into `experimental-media-uri`. */
// OWN-PATCH(P-035) begin
export const MediaInfo = Schema.Union([MediaUser, Synthetic, Compaction, Move, Reset]).pipe(
  // OWN-PATCH(P-035) end
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "Session.Inbox.MediaInfo" }),
)
export type MediaInfo = typeof MediaInfo.Type
