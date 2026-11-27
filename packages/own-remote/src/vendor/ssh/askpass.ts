// Vendored from packages/gui-plugins/src/ssh/askpass.ts @ dae4077a96 (v2.0.28, MIT). See own/ledger/vendored.yaml
// own: local changes are marked "own:" (04 §14.2): the helper is our own `opencode.exe` (its built-in askpass mode,
// packages/cli/src/index.ts:19-22), injected by the caller; every prompt is classified (`hostKey`, `confirm`,
// `passphrase`, `password`, `other`) and carries the host key fingerprint when there is one.
import { NodeSocketServer } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Predicate, Schema, Semaphore } from "effect"
import { Socket } from "effect/socket"
import { randomUUID } from "node:crypto"
import { Prompt } from "../../prompt.js"
import { SshFailure } from "./command.js"

const Request = Schema.fromJsonString(
  Schema.Struct({ token: Schema.String, text: Schema.String, confirm: Schema.Boolean }),
)

// own: the prompt the caller receives. Only the prompt text, never an answer.
export type AskpassPrompt = { id: string; text: string; confirm: boolean } & Prompt.Classified

export const createAskpass = Effect.fn("Ssh.askpass")(function* (input: {
  binary: string
  prompt: (prompt: AskpassPrompt) => Effect.Effect<void>
  clear: (id: string) => Effect.Effect<void>
}) {
  const token = randomUUID()
  const pending = new Map<string, Deferred.Deferred<string | null>>()
  const prompts = yield* Semaphore.make(1)
  const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(Effect.mapError(SshFailure.from))
  if (Predicate.isTagged(server.address, "UnixPathAddress")) return yield* Effect.fail(new SshFailure("connection"))

  const serving = yield* server
    .run((socket) =>
      Effect.gen(function* () {
        const request = yield* Deferred.make<string, SshFailure>()
        // A helper sends one newline-terminated request. Oversized input, later data, or a close fails it.
        const reader = yield* Effect.gen(function* () {
          const pull = yield* Socket.readerBytes(socket)
          // One streaming decoder, so a character split across reads decodes intact.
          const decoder = new TextDecoder()
          let buffer = ""
          while (!buffer.includes("\n")) {
            for (const chunk of yield* pull) buffer += decoder.decode(chunk, { stream: true })
            if (buffer.length > 16_384) return yield* new SshFailure("connection")
          }
          yield* Deferred.succeed(request, buffer.trim())
          yield* pull
          return yield* new SshFailure("connection")
        }).pipe(Effect.ensuring(Deferred.fail(request, new SshFailure("connection"))), Effect.forkScoped)
        const message = yield* Deferred.await(request).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Request)))
        if (message.token !== token) return

        // One scoped waiter per helper invocation. Disconnecting a helper or closing
        // the connection interrupts that waiter and advances the prompt semaphore.
        yield* prompts
          .withPermit(
            Effect.gen(function* () {
              const id = randomUUID()
              const response = yield* Deferred.make<string | null>()
              yield* Effect.acquireRelease(
                Effect.sync(() => pending.set(id, response)),
                () => Effect.sync(() => pending.delete(id)).pipe(Effect.andThen(input.clear(id))),
              )
              // own: classified prompt (04 §14.2).
              yield* input.prompt({
                id,
                text: message.text,
                confirm: message.confirm,
                ...Prompt.classify(message.text, message.confirm),
              })
              const value = yield* Deferred.await(response)
              const writer = yield* socket.writer
              // own: `null` cancels; the helper exits 1 and ssh treats the prompt as refused.
              yield* writer.write(JSON.stringify({ value }))
            }).pipe(Effect.scoped),
          )
          .pipe(Effect.raceFirst(Fiber.join(reader)))
      }).pipe(
        Effect.scoped,
        Effect.timeout("5 minutes"),
        // Helper cancellation, invalid credentials, and socket closure are local to
        // this request. Never log authentication payloads as error causes.
        Effect.ignore,
      ),
    )
    .pipe(Effect.mapError(SshFailure.from), Effect.forkScoped({ startImmediately: true }))

  return {
    env: {
      SSH_ASKPASS: input.binary,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || "opencode",
      OPENCODE_SSH_ASKPASS_PORT: String(server.address.port),
      OPENCODE_SSH_ASKPASS_TOKEN: token,
    },
    closed: Fiber.join(serving),
    respond: Effect.fn("Ssh.askpass.respond")(function* (id: string, value: string | null) {
      const response = pending.get(id)
      if (response) yield* Deferred.succeed(response, value)
    }),
  }
})
