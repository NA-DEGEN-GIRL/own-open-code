// What one composer send does (03 §4.6, §5.1, §6.5, 02 §5.3 method 3, 07 §4.3). Pure: the component gathers the
// state, this decides, the component performs it. Unit-tested as a table.
import type { Preset } from "@own/protocol/preset"
import { createRoot, createSignal } from "solid-js"
import type { TargetRef } from "@/switcher/cost"

/** `실행 중 보내기 동작` (settings > general, 03 §4.6): upstream's default `followUpBehavior: "steer"`. */
export type FollowUp = "steer" | "queue"
export type Delivery = "steer" | "queue"

export type SendPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "blocked"
      readonly reason: "offline" | "child" | "scope" | "loading" | "noTarget" | "noDirectory" | "locked"
    }
  /** `!` shell mode: `session.shell`, the agent does not wake (19.9). */
  | { readonly kind: "shell"; readonly command: string; readonly create: boolean }
  /** A compact-then-switch is running: keep the message on the client until `switch.recorded` (03 §6.5). */
  | { readonly kind: "hold" }
  /**
   * 07 §4.3: the session's main model or its effort level is gone, so the prompt would fail. Nothing is sent and the
   * draft stays; the switcher opens on the suggestion ({@link goneTarget}). Nothing switches by itself.
   */
  | ({ readonly kind: "switch" } & MainGone)
  | {
      readonly kind: "prompt"
      /** Omitted for an idle session (the message starts a turn). */
      readonly delivery?: Delivery
      /** Idle session with a WAIT_SAFE switch: apply it first, then prompt (02 §5.3 method 3). */
      readonly applyPending?: boolean
      /** Home route: create the session first (03 §5.1). */
      readonly create: boolean
      /**
       * Queued only because a context reset waits (it would steer or start a turn otherwise): sent with
       * {@link RESET_HELD}, so a cancel of that reset steers it into the running turn (03 §18.18).
       */
      readonly held?: boolean
    }

export interface SendInput {
  readonly text: string
  /** The other-delivery key: Ctrl/⌘+Enter, or Alt+Enter when `보내는 키` is Ctrl+Enter (03 §4.6). */
  readonly modifier: boolean
  readonly connected: boolean
  /** `undefined` on the home route. */
  readonly session?: {
    readonly busy: boolean
    readonly child: boolean
    /** `switch.state` name. */
    readonly switchState?: string
    /** `session.preset.get` `main` (07 §4.3): the main model or its effort level is gone. */
    readonly main?: MainGone
    /**
     * A context reset waits (03 §18.18): every follow-up queues behind it, idle or busy, and core delivers it after the
     * reset (a pending reset is a barrier, 11 §7.2), so it starts the new context.
     */
    readonly resetPending?: boolean
  }
  /**
   * Home route: whether the new session has a model and a directory. `loading`: no model yet because the accounts, the
   * group defaults or the model catalog have not answered (`newSessionLoading`), so the send is not "add your first
   * account" (RL5-1).
   */
  readonly newSession?: "ready" | "loading" | "noTarget" | "noDirectory"
  readonly followUp: FollowUp
  readonly shellMode: boolean
  /** `prompt` scope (02 §9.1): gateway devices may lack it. */
  readonly canPrompt: boolean
  /** A previous send is still creating the session or setting its approval mode (03 §5.1 "전송 버튼을 잠근다"). */
  readonly locked?: boolean
  /** The draft has attachments ready (18.10): a prompt may go without text. Shell commands ignore them. */
  readonly attachments?: boolean
}

export function planSend(input: SendInput): SendPlan {
  const shell = input.shellMode || input.text.startsWith("!")
  const body = shell && !input.shellMode ? input.text.slice(1) : input.text
  if (!body.trim() && (shell || !input.attachments)) return { kind: "none" }
  if (!input.connected) return { kind: "blocked", reason: "offline" }
  if (input.locked) return { kind: "blocked", reason: "locked" }
  if (!input.canPrompt) return { kind: "blocked", reason: "scope" }
  const session = input.session
  if (!session) {
    if (input.newSession === "loading") return { kind: "blocked", reason: "loading" }
    if (input.newSession === "noTarget") return { kind: "blocked", reason: "noTarget" }
    if (input.newSession === "noDirectory") return { kind: "blocked", reason: "noDirectory" }
    if (shell) return { kind: "shell", command: body.trim(), create: true }
    return { kind: "prompt", create: true }
  }
  if (session.child) return { kind: "blocked", reason: "child" }
  if (shell) return { kind: "shell", command: body.trim(), create: false }
  if (session.switchState === "COMPACTING") return { kind: "hold" }
  // A switch waiting to apply with this send already leaves the gone main (02 §5.3 method 3).
  if (session.main && session.switchState !== "WAIT_SAFE") return { kind: "switch", ...session.main }
  if (session.resetPending)
    return {
      kind: "prompt",
      delivery: "queue",
      create: false,
      applyPending: !session.busy && session.switchState === "WAIT_SAFE",
      held:
        !session.busy ||
        (session.switchState !== "WAIT_SAFE" && busyDelivery(input.followUp, input.modifier) === "steer"),
    }
  if (!session.busy) return { kind: "prompt", create: false, applyPending: session.switchState === "WAIT_SAFE" }
  // A pending switch waits for the turn to end; the router turns follow-ups into `queue` anyway (02 §5.3).
  if (session.switchState === "WAIT_SAFE") return { kind: "prompt", delivery: "queue", create: false }
  return { kind: "prompt", delivery: busyDelivery(input.followUp, input.modifier), create: false }
}

/**
 * The prompt metadata key of a message the composer queued only because a context reset waited (`held`): when that
 * reset is cancelled, own-web steers the message (context-reset `released`), as it would have gone without the reset.
 */
export const RESET_HELD = "own.resetHeld"

/** `session.preset.get` `main` (07 §4.3): what is gone, and the switch the service suggests. */
export type MainGone = NonNullable<Preset.SessionView["main"]>

/**
 * Where the switcher opens for a gone main (07 §4.3, 02 switch flow): the suggested model (a successor, or the same
 * model at the refitted effort level) on the session's account. `undefined` without a suggestion: the switcher opens
 * on the current main and the user picks.
 */
export function goneTarget(current: TargetRef | null | undefined, gone: MainGone): TargetRef | undefined {
  const suggestion = gone.suggestion
  if (!current || !suggestion) return undefined
  return {
    providerID: current.providerID,
    id: suggestion.id,
    ...(suggestion.variant === undefined ? {} : { variant: suggestion.variant }),
  }
}

/** The send key follows the setting, the other-delivery key does the other one (03 §4.6, §10). */
export function busyDelivery(followUp: FollowUp, modifier: boolean): Delivery {
  if (!modifier) return followUp
  return followUp === "steer" ? "queue" : "steer"
}

const FOLLOW_UP_KEY = "own.web.composer.followUp"

/**
 * The `실행 중 보내기 동작` preference. The settings page (owner: settings) writes it with `setFollowUp`; kept per
 * viewer in localStorage (a missing or blocked storage means the default).
 */
export const followUp = createRoot(() => {
  const [value, setValue] = createSignal<FollowUp>(readFollowUp())
  return {
    value,
    set(next: FollowUp) {
      setValue(next)
      try {
        localStorage.setItem(FOLLOW_UP_KEY, next)
      } catch {}
    },
  }
})

function readFollowUp(): FollowUp {
  try {
    return localStorage.getItem(FOLLOW_UP_KEY) === "queue" ? "queue" : "steer"
  } catch {
    return "steer"
  }
}
