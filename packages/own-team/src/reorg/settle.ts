export * as Settle from "./settle.js"

import type { OwnTeam } from "@own/protocol"
import type { Hub } from "../hub.js"
import type { Steps } from "../ops/steps.js"
import { Wait } from "../ops/wait.js"
import type { Services } from "../services.js"
import { SafePoint } from "../sessions/safe-point.js"

/**
 * Waiting inside a reorganization step (06 §8.3 TI-9, §8.4): a user's action waits for its areas' safe points and
 * says why on the card, looking again after every core event about a folder and every {@link RECHECK_MS}, since own's
 * work on a folder and a git operation end without an event. RH-20: the wait is `Wait.until` (`why: safe-point`), so
 * the step records why and since when, `op.cancel` ends it, and commands left running in the folder can be stopped
 * (`op.force{stop-shell}`) or gone past (`op.force`); nothing else can be gone past ({@link reason}, RH-32).
 */

/** How often a wait looks again without an event. */
export const RECHECK_MS = Wait.RECHECK_MS

/** Core events after which a folder may have reached its safe point (8.4). */
export const FOLDER_EVENTS = ["session.execution.", "session.inbox.", "permission.", "form.", "shell.", "pty."]

/** Why a user's step waits, by the failed 8.4 check (shown on the card). */
export const WAITS: Readonly<Record<Services.SafeWhy, string>> = {
  session: "영역에서 대화가 일하는 중이라 기다려요",
  inbox: "대기열에 멈춘 요청이 있어 기다려요",
  permission: "승인을 기다리는 대화가 있어 기다려요",
  own: "이 영역의 다른 작업이 끝나기를 기다려요",
  git: "진행 중인 Git 작업이 끝나기를 기다려요",
  form: "답을 기다리는 질문이 있어 기다려요",
  shell: "실행 중인 명령이 끝나기를 기다려요",
  pty: "열린 터미널이 닫히기를 기다려요",
}

/**
 * What a safe-point wait offers until a check reports why it waits (RH-41): 취소 only. 바로 진행 goes on past what
 * holds the folder, which is safe only when a check named commands or terminals left running ({@link reason}); before
 * that, or while the check fails, nobody knows that no conversation works there.
 */
export const START: ReadonlyArray<OwnTeam.WaitAction> = ["cancel"]

/** How much of a command a reason quotes. */
const COMMAND = 60

/**
 * The step's wait for a safe point that failed (RH-20): the check, the text (after `prefix`, which names the area),
 * the conversations, and the commands or terminals that hold the folder. Only those offer 명령 멈추고 진행 and 바로 진행
 * (RH-32): nobody works in a folder that only commands left running hold, while going on past a working conversation,
 * a pending permission or question, queued input or a half-done git operation would act under real work. The other
 * waits offer 취소.
 */
export function reason(prefix: string, safe: Extract<Services.Safe, { readonly ok: false }>): Wait.Reason {
  const shells = safe.shells ?? []
  const named = shells.length === 0 ? "" : `: ${shells.map((shell) => `'${clip(shell.command)}'`).join(", ")}`
  return {
    detail: safe.why,
    text: `${prefix}${WAITS[safe.why]}${named}`,
    ...(safe.sessionIDs.length === 0 ? {} : { sessionIDs: safe.sessionIDs }),
    ...(shells.length === 0 ? { actions: ["cancel"] } : { shells, actions: ["cancel", "force", "stop-shell"] }),
  }
}

/**
 * Resolves with the first answer `check` gives (`Wait.until`, `why: safe-point`), asking now, after every event
 * `wakes` accepts (a folder event by default) and every {@link RECHECK_MS}; `report` says why the step waits now.
 * `undefined` when the step's signal aborts (the op resumes later, or the user cancelled it). `force` is what 바로 진행
 * answers when commands left running hold the folder.
 */
export function until<T>(
  input: Steps.Input,
  check: (report: (reason: Wait.Reason) => void) => Promise<T | undefined>,
  options: {
    readonly wakes?: (event: Hub.Incoming) => boolean
    readonly force?: () => Promise<T>
  } = {},
): Promise<T | undefined> {
  const services = input.services
  return Wait.until(input, {
    why: "safe-point",
    text: "영역이 쉬기를 기다려요",
    actions: START,
    wakes: options.wakes ?? ((event) => FOLDER_EVENTS.some((prefix) => event.type.startsWith(prefix))),
    check: (report) => check(report),
    force: {
      ...(options.force === undefined ? {} : { answer: options.force }),
      stopShell: async (shells) => {
        await SafePoint.stop(services, "", shells)
      },
    },
  })
}

function clip(text: string) {
  const flat = Array.from(text.replace(/\s+/g, " ").trim())
  return flat.length <= COMMAND ? flat.join("") : `${flat.slice(0, COMMAND - 1).join("")}…`
}
