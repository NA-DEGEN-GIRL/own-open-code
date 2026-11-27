export * as VoiceRpc from "./voice.js"

import type { Deps } from "../deps.js"
import { VoiceInput } from "../voice/voice.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: VOICE (02 §3.9). Voice input settings, voice-only keys and recognition. Stateless apart from `voice.json` and
 * the vault, so it needs no module; it never touches the account registry (keys of model accounts are never used).
 */
export type Methods = "voice.get" | "voice.set" | "voice.key.set" | "voice.transcribe"

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  const voice = VoiceInput.create(deps)
  return {
    "voice.get": voice.get,
    "voice.set": voice.set,
    "voice.key.set": voice.setKey,
    "voice.transcribe": voice.transcribe,
  }
}
