import type { ExperimentalSessionApi, SessionApi } from "@opencode/client/effect/api"
import type { GenerationOptionsFields, Message, SystemPart } from "@opencode/ai/effect"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { SessionError } from "@opencode/schema/session-error"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { Effect, JsonSchema, Types } from "effect"
import type { ModelHooks } from "./registration.js"

export interface SessionPrompt {
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  prompt: Types.DeepMutable<PromptInput.Prompt>
  metadata?: Record<string, unknown>
  delivery: SessionInbox.Delivery
}

/** Request overrides. Typed keys are generation settings; any other key is a provider option. */
export type SessionRequestOptions = Types.DeepMutable<GenerationOptionsFields> & Record<string, unknown>

/** A request message. `metadata` is the stored Session message's metadata, for reading only; it is not sent to the model. */
export type SessionRequestMessage = Message & { readonly metadata?: Record<string, unknown> }

export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly model: Model.Ref
  /**
   * The instructions part keeps each source's text in `metadata.experimental.instructions` as `{ key, text }`. It is
   * not updated when a hook edits `text`. Experimental.
   */
  system: Array<SystemPart>
  messages: Array<SessionRequestMessage>
  options: SessionRequestOptions
  // OWN-PATCH(P-032) begin
  /**
   * Primary and compaction requests: core's default `options.maxTokens` without its 256,000 cap, the model's output
   * limit fitted to the room the prompt leaves. A hook that applies another cap sends `min(outputCeiling, cap)`.
   */
  readonly outputCeiling?: number
  // OWN-PATCH(P-032) end
}

export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
}

export interface SessionCompactionResult {
  summary: string
  /** `native.messages`, when set, must be a provider replacement window; it replays instead of `summary`. */
  native?: SessionMessage.Native
  metadata?: Record<string, unknown>
  tokens?: TokenUsage.Info
}

export interface SessionCompaction extends SessionContext {
  /** Set to use this compaction and skip the model request. */
  result?: SessionCompactionResult
  // OWN-PATCH(P-025) begin
  /** Set to ask for the summary with this prompt in place of core's; the whole reply is the summary. */
  prompt?: string
  /**
   * With `prompt`: turns the reply into the stored summary, or rejects it (undefined). A rejected reply is answered once
   * with `repair` (default: ask again in the requested format); a second rejection fails the compaction.
   */
  accept?: (reply: string) => string | undefined
  repair?: string
  /** Merged into the checkpoint's metadata, which later requests see on the checkpoint message. */
  metadata?: Record<string, unknown>
  /**
   * Models asked in turn when this compaction fails (an error, a refusal, or a reply rejected twice); the compaction
   * hooks run again for each. A summary one of them writes records `fallback` in the checkpoint's metadata.
   */
  fallbackModels?: Array<Model.Ref>
  /**
   * The last resort when the compaction and every fallback model failed: a summary made without a model, or
   * undefined to let the compaction fail. Its checkpoint records `fallback` in the metadata too.
   */
  fallback?: (error: SessionError.Error) => SessionCompactionResult | undefined
  // OWN-PATCH(P-025) end
  // OWN-PATCH(P-034) begin
  /**
   * With `prompt`: send the whole history first, the next primary request plus the prompt, so the summary reads the
   * session's prompt cache. The hooks then run again on the whole history with `kept` and this set; clearing it there
   * keeps the older part, and `metadata.prefix.reason` set there says why. One attempt; a failure goes on to the older
   * part. Core records what became of it as `prefix: { request: "full" | "older", reason? }` in the checkpoint's
   * metadata, a stand-in's or a model-free summary's checkpoint included.
   */
  prefix?: "full"
  /** Set by core on that second run: the first message kept verbatim after the summary, which the prompt names. */
  readonly kept?: { readonly messageID: SessionMessage.ID }
  /**
   * Set to end this compaction before any request: it fails as cancelled (`aborted`) with this message, no fallback
   * model or `fallback` runs, and the history stays as it was.
   */
  cancel?: string
  // OWN-PATCH(P-034) end
}

export interface SessionGenerate extends SessionContext {
  // OWN-PATCH(P-061) begin
  /** A side question (`ctx.session.side`): a `generate` request that should look like the next primary one. */
  readonly side?: true
  // OWN-PATCH(P-061) end
}

export interface SessionTitle extends SessionRequest {
  /** Set to use this title and skip the model request. */
  result?: string
}

/**
 * Why a Session request is being made. Auxiliary requests share the Session's
 * hook identity but need to be told apart from the agent loop.
 */
export type SessionRequestKind = "primary" | "compaction" | "title" | "generate"

/**
 * Runs whenever a Session resolves the model for a request, before anything is built for it. `model` starts as the
 * Session's or agent's selection; change it to serve this request with another model from the same provider, including
 * models hidden from the picker. The Session keeps its selection, and the request and its records use the new model.
 * Router models such as GitHub Copilot's Auto use it. Experimental.
 */
export interface SessionModelResolve {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly kind: SessionRequestKind
  model: Model.Ref
}

export interface SessionModelRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  // OWN-PATCH(P-061) begin
  /** A side question (`ctx.session.side`): a `generate` request that should look like the next primary one. */
  readonly side?: true
  // OWN-PATCH(P-061) end
  baseURL?: string
  headers: Record<string, string>
}

export interface SessionHttpRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  // OWN-PATCH(P-061) begin
  /** A side question (`ctx.session.side`): a `generate` request that should look like the next primary one. */
  readonly side?: true
  // OWN-PATCH(P-061) end
  request: Request
}

export interface SessionHttpResponse {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  // OWN-PATCH(P-061) begin
  /** A side question (`ctx.session.side`): a `generate` request that should look like the next primary one. */
  readonly side?: true
  // OWN-PATCH(P-061) end
  readonly request: Request
  response: Response
}

/**
 * Connection a WebSocket-backed request opens or reuses. Runs once per model call before the
 * Session's socket is selected; changing `url` or `headers` reopens the socket. Experimental.
 */
export interface SessionWebSocketHandshake {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  url: string
  headers: Record<string, string>
}

/**
 * Outbound frame about to be written to the Session's socket, after the provider driver has built
 * it. Replacing `frame` sends the replacement verbatim; the driver still tracks state from the
 * provider's replies, so a rewrite that changes protocol meaning is on the plugin. Experimental.
 */
export interface SessionWebSocketSend {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  frame: string
}

/**
 * Inbound frame read from the Session's socket, before the provider driver observes it. Replacing
 * `frame` hands the replacement to the driver verbatim. Experimental.
 */
export interface SessionWebSocketReceive {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  frame: string
}

export type SessionRetryDecision = { retry: false } | { retry: true; delay: number }

export interface SessionRetry {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly error: SessionError.Error
  readonly attempt: number
  decision: SessionRetryDecision
}

/**
 * Background work still running for the idle Session or one of its descendants. `sessionID` is
 * the Session that owns the job: the idle Session itself, or a descendant such as a subagent child.
 */
export type SessionIdleBackground =
  | { readonly kind: "codemode"; readonly sessionID: Session.ID; readonly jobID: string }
  | {
      readonly kind: "shell"
      readonly sessionID: Session.ID
      readonly shellID: string
      readonly command: string
    }
  | {
      readonly kind: "subagent"
      readonly sessionID: Session.ID
      readonly childSessionID: Session.ID
      readonly agent: string
      readonly description: string
    }
  | {
      readonly kind: "image"
      readonly sessionID: Session.ID
      readonly path: string
      readonly model: string
    }
  | {
      readonly kind: "video"
      readonly sessionID: Session.ID
      readonly path: string
    }

/**
 * Runs when a Session finishes model work and has no pending input, just before it goes idle.
 * It does not run after interruption, failure, or control-only work such as a manual compaction.
 * Input admitted by the hook, such as a synthetic message, runs in the same execution instead
 * of the Session going idle.
 *
 * `background` lists work that is still running. When the Session's own shell or subagent finishes,
 * its notice wakes the Session and the hook runs again, so a plugin that waits for that work can
 * simply return. Work a descendant owns, such as a shell a subagent left running, wakes that
 * descendant instead, so it is listed for information only. Notices admitted with `resume: false`,
 * such as those recovered after a restart, wait for the next wake. Experimental.
 */
export interface SessionIdle {
  readonly sessionID: Session.ID
  readonly background: ReadonlyArray<SessionIdleBackground>
}

export interface SessionHooks {
  readonly fork: { readonly sessionID: Session.ID }
  readonly prompt: SessionPrompt
  readonly context: SessionContext
  readonly compaction: SessionCompaction
  readonly generate: SessionGenerate
  readonly title: SessionTitle
  readonly "experimental.model.resolve": SessionModelResolve
  readonly "model.request": SessionModelRequest
  readonly "http.request": SessionHttpRequest
  readonly "http.response": SessionHttpResponse
  readonly "experimental.ws.handshake": SessionWebSocketHandshake
  readonly "experimental.ws.send": SessionWebSocketSend
  readonly "experimental.ws.receive": SessionWebSocketReceive
  readonly retry: SessionRetry
  readonly "experimental.idle": SessionIdle
}

export type SessionDomain = Pick<
  SessionApi<unknown>,
  | "list"
  | "create"
  | "get"
  | "remove"
  | "switchAgent"
  | "switchModel"
  | "prompt"
  | "generate"
  | "command"
  | "compact"
  | "synthetic"
  | "interrupt"
  | "update"
  | "move"
  | "context"
> &
  Pick<ExperimentalSessionApi<unknown>, "wait" | "instructions"> & {
    readonly hook: ModelHooks<SessionHooks>
    // OWN-PATCH(P-054) begin
    /** One indexed page of a Session's messages, read like `GET /api/session/:id/message`. */
    readonly messages: (input: SessionMessagesInput) => Effect.Effect<ReadonlyArray<SessionMessage.Info>, unknown>
    // OWN-PATCH(P-054) end
    // OWN-PATCH(P-061) begin
    /**
     * One model call on the Session's history as the next primary request would carry it, then `turns`; streamed
     * through `onText`. Nothing is written to the Session: no input, message, step, usage or event.
     */
    readonly side: (input: SessionSideInput) => Effect.Effect<SessionSideResult, unknown>
    // OWN-PATCH(P-061) end
  }

// OWN-PATCH(P-061) begin
export interface SessionSideInput {
  readonly sessionID: Session.ID
  /** The side thread after the Session's history, oldest first; the last turn is the user's question. */
  readonly turns: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>
  /** `none` asks the provider for no tool call; omitted, the request offers the tools like a primary step. */
  readonly toolChoice?: "none"
  /** Each text delta as it arrives. */
  readonly onText?: (text: string) => void
}

export interface SessionSideResult {
  readonly text: string
  /** Why the answer ended; `tool-calls` when the model asked for a tool, which a side call never runs. */
  readonly finish: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other"
  readonly model: Model.Ref
  readonly tokens?: TokenUsage.Info
  /** What the provider said it charged, else the catalog price of `tokens`; USD. */
  readonly cost?: number
}
// OWN-PATCH(P-061) end

// OWN-PATCH(P-054) begin
export interface SessionMessagesInput {
  readonly sessionID: Session.ID
  readonly limit?: number
  /** Newest first when omitted. */
  readonly order?: "asc" | "desc"
  readonly type?: SessionMessage.Type
  /** Only messages after (`next`) or before (`previous`) this one in `order`. */
  readonly cursor?: { readonly id: SessionMessage.ID; readonly direction: "previous" | "next" }
}
// OWN-PATCH(P-054) end
