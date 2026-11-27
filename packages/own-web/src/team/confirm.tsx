// Confirm dialogs of team mode (06 §9.7, §3.8, §8.5, §8.6), in the team chunk with the result cards.
// - `TeamConfirmDialog`: the destructive confirm of an op step in the shape of 03's danger dialog. Focus starts on
//   `두기`. It shows what happens in one sentence (the step's text), what is removed with each size and the total
//   (the list the nonce is bound to, `manifest`) and what stays: record names and conversations, and for an area
//   that was not applied `반영하지 않은 저장 지점 n개는 기록에 남습니다` (the count its step carries, `unapplied`).
//   `자세히` shows the full paths and the steps. A system change (making a shared folder read-only, 4.11; the
//   `.assets` folder, 4.10) goes through the same dialog and says what changes and how to undo it, the command only
//   under `자세히`. Several confirms of one op go together (`끝난 영역 3개 정리(7.5 GB)`). Each answer is
//   `op.confirm{opID, stepID, choice, nonce}`. A nonce lives 10 minutes: when it runs out, or the service refuses it,
//   the dialog reads the op again (`op.get`) and shows the step's new nonce, saying so when the list changed
//   meanwhile; nothing is answered with an old nonce. The TeamStore's newer `op.confirm` events win as well.
//   Downloads say `[받기] [나중에]` and the confirm before applying an area (`반영하기 전에 묻기`, 7.2) `[반영하기]`.
// - Only a PC window holds the `local` scope (06 §2.7). Every gateway device (phone browser or PWA, the Android app,
//   another PC's 원격 PC window, the 모바일 미리보기) sees the dialog read-only with `<PC 이름>에서 확인하세요`, the
//   PC the service runs on (`/own/device` `pc`), and no answer button.
// - `DisableDialog`: `팀 모드 끄기` (3.8). `그대로 두고 끄기`, and `끝난 영역 정리하고 끄기` once this build has it
//   (`health.features` `cleanup`, T3): its removals wait in the card above the team main, and the service turns the
//   team off once they are answered. Focus starts on `취소`.
// - `TeamDialog`: the frame every team dialog shares (also the upload dialog and 결정 적기).
import type { OwnTeam } from "@own/protocol/rpc-team"
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  onCleanup,
  onMount,
  Show,
  type JSX,
  type ParentProps,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useData, type ServerKey } from "@/data"
import { OwnRpcError } from "@/data/rpc"
import type { TeamRpc } from "@/data/team-rpc"
import { formatBytes } from "@/files/strings"
import { useI18n } from "@/i18n"
import { coming } from "@/limits/format"
import { joinPath, pathSep } from "@/projects/path"
import { showToast } from "@/switcher/toast"
import { failedNote, opDone } from "./enable"
import { errorText, stepLabel, viewOnlyText, type TeamText } from "./model"
import { useTeamText } from "./strings"
import "./team.css"

/** Step kinds whose confirm removes something (8.6); any confirm that lists files to remove is one too. */
const REMOVALS: ReadonlySet<string> = new Set(["retire-remove"])
/** Step kinds whose confirm is a download (4.6): `[받기] [나중에]`. */
const FETCHES: ReadonlySet<string> = new Set(["paths-add", "cone-add"])
/** The step that moves the project's main code when 반영하기 전에 묻기 is on (7.2 step 8): `[반영하기]`. */
const APPLIES: ReadonlySet<string> = new Set(["integrate-advance"])
/**
 * Step kinds whose confirm changes the system (9.7: what changes and how to undo it): a shared folder made read-only
 * (4.11) and the first `.assets` folder of the asset check (4.10, integrate step 7).
 */
const SYSTEM: Readonly<Record<string, "shared" | "assets">> = {
  "protect-shared": "shared",
  "integrate-assets": "assets",
}

/** A confirm that removes something: it goes through {@link TeamConfirmDialog}, never a button in place. */
export function isDestructive(confirm: Pick<OwnTeam.Confirm, "kind" | "files">) {
  return REMOVALS.has(confirm.kind) || (confirm.files?.length ?? 0) > 0
}

/** A confirm that changes the system: it goes through {@link TeamConfirmDialog} too, to say how to undo it. */
export function isSystem(confirm: Pick<OwnTeam.Confirm, "kind">) {
  return Object.hasOwn(SYSTEM, confirm.kind)
}

/** A confirm that fetches large files (`[받기] [나중에]`). */
export function isFetch(confirm: Pick<OwnTeam.Confirm, "kind">) {
  return FETCHES.has(confirm.kind)
}

/** The confirm before the project's main code moves (반영하기 전에 묻기): answered with `[반영하기]`. */
export function isApply(confirm: Pick<OwnTeam.Confirm, "kind">) {
  return APPLIES.has(confirm.kind)
}

/** What a confirm downloads, uses or removes: its own count, else the sum of its files. */
export function confirmBytes(confirm: Pick<OwnTeam.Confirm, "bytes" | "files">) {
  return confirm.bytes ?? (confirm.files ?? []).reduce((sum, file) => sum + file.bytes, 0)
}

export interface ConfirmButton {
  readonly choice: "skip" | "do"
  readonly label: string
  readonly tone?: "danger" | "primary"
}

/** What {@link TeamConfirmDialog} shows for its confirms. */
export interface ConfirmView {
  readonly title: string
  readonly danger: boolean
  /** The answers in order; the first one takes the focus. None on a gateway device, which can only close. */
  readonly buttons: readonly ConfirmButton[]
  /** What is removed, largest first: the short name, the full path (자세히) and the size. */
  /** `irreplaceable`: an ignored file or folder that cannot be made again (8.6 step 2), flagged in the list. */
  readonly files: readonly {
    readonly name: string
    readonly path: string
    readonly size: string
    readonly irreplaceable?: true
  }[]
  /** `지워지는 것 · 2.5 GB` above the list. */
  readonly removes?: string
  /** `남는 것`: record names and conversations (removals only). */
  readonly stays: boolean
  /** `반영하지 않은 저장 지점 n개는 기록에 남습니다` under 남는 것, for removed areas that were not applied (8.2). */
  readonly unapplied?: string
  /** `바뀌는 설정: …. 되돌리는 법: …` of each system change, and the command that undoes it (자세히 only). */
  readonly system: readonly { readonly line: string; readonly command?: string }[]
  readonly expired: boolean
  /** `14:20까지 고르세요`, or that the time ran out. */
  readonly expires: string
  /** `<PC 이름>에서 확인하세요` on a gateway device. */
  readonly viewOnly?: string
}

/** The dialog's content for one or several confirms of an op (06 §9.7, §9.8). Pure. */
export function confirmView(
  text: TeamText,
  confirms: readonly OwnTeam.Confirm[],
  options: {
    /** This connection holds the `local` scope (a PC window). */
    readonly local: boolean
    /** The PC the service runs on, as the gateway names it to a device. */
    readonly pc?: string
    readonly now: number
    readonly bytes: (bytes: number) => string
    /** A coming time as the screen words it (`@/limits/format` `coming`): the expiry. */
    readonly time: (at: number) => string
    /** The arguments of a confirm's step (the op's record): a removal's `unapplied`, a shared folder's `name`. */
    readonly args?: (confirm: OwnTeam.Confirm) => Readonly<Record<string, unknown>> | undefined
    /** How the service protects a shared folder (4.11): a deny entry on Windows, `chmod` on a Linux host. */
    readonly protect?: "acl" | "chmod"
    /** The team's main folder, where a shared folder's original is. */
    readonly home?: string
  },
): ConfirmView {
  const danger = confirms.some(isDestructive)
  const removals = confirms.filter(isDestructive)
  const fetching = !danger && confirms.length > 0 && confirms.every(isFetch)
  const applying = !danger && confirms.length > 0 && confirms.every(isApply)
  const files = confirms.flatMap((confirm) => confirm.files ?? []).toSorted((a, b) => b.bytes - a.bytes)
  const total = options.bytes(confirms.reduce((sum, confirm) => sum + confirmBytes(confirm), 0))
  const expiresAt = Math.min(...confirms.map((confirm) => confirm.expiresAt))
  const expired = options.now >= expiresAt
  // 8.2 끝내기: the save points the target lacks stay on the branch, which is never removed (TI-4).
  const unapplied = removals.reduce((sum, confirm) => sum + count(options.args?.(confirm)?.unapplied), 0)
  const doLabel = danger
    ? text("own.team.confirm.remove")
    : fetching
      ? text("own.team.confirm.fetch")
      : applying
        ? text("own.team.confirm.integrateDo")
        : text("own.team.confirm.do")
  return {
    title:
      removals.length > 1
        ? text("own.team.confirm.bulk", {
            n: removals.length,
            size: options.bytes(removals.reduce((sum, confirm) => sum + confirmBytes(confirm), 0)),
          })
        : text("own.team.confirm.title"),
    danger,
    buttons: options.local
      ? [
          { choice: "skip", label: text(fetching ? "own.team.confirm.later" : "own.team.confirm.keep") },
          { choice: "do", label: doLabel, tone: danger ? "danger" : "primary" },
        ]
      : [],
    files: files.map((file) => ({
      name: shortName(file.path),
      path: file.path,
      size: options.bytes(file.bytes),
      ...(file.irreplaceable === true ? { irreplaceable: true as const } : {}),
    })),
    ...(files.length > 0 ? { removes: `${text("own.team.confirm.removes")} · ${total}` } : {}),
    stays: danger,
    ...(unapplied > 0 ? { unapplied: text("own.team.confirm.unapplied", { n: unapplied }) } : {}),
    system: confirms.flatMap((confirm) => systemLines(text, confirm, options)),
    expired,
    expires: expired
      ? text("own.team.confirm.expired")
      : text("own.team.confirm.expires", { time: options.time(expiresAt) }),
    ...(options.local ? {} : { viewOnly: viewOnlyText(text, "confirm", options.pc) }),
  }
}

/**
 * What a system change sets and how to undo it (06 §9.7). A shared folder (4.11) becomes read-only: a deny entry for
 * this user on Windows (`icacls … /remove:d` undoes it), no write bits on a Linux host (`chmod -R u+w`). The asset
 * check's `.assets` folder (4.10) takes disk; it holds no user work, so removing it once team mode is off undoes it.
 */
function systemLines(
  text: TeamText,
  confirm: OwnTeam.Confirm,
  options: Pick<Parameters<typeof confirmView>[2], "args" | "protect" | "home" | "bytes">,
) {
  const kind = SYSTEM[confirm.kind]
  if (kind === "assets")
    return [
      {
        line: text("own.team.confirm.system", {
          setting: text("own.team.confirm.assets.setting", {
            folder: ".assets",
            size: options.bytes(confirmBytes(confirm)),
          }),
          undo: text("own.team.confirm.assets.undo"),
        }),
      },
    ]
  if (kind !== "shared") return []
  const name = options.args?.(confirm)?.name
  const folder = typeof name === "string" ? name : ""
  const chmod = options.protect === "chmod"
  const home = options.home
  const target = home ? joinPath(home, folder.replaceAll("/", pathSep(home))) : folder
  return [
    {
      line: text("own.team.confirm.system", {
        setting: text("own.team.confirm.shared.setting", { folder }),
        undo: text(chmod ? "own.team.confirm.shared.undoChmod" : "own.team.confirm.shared.undoAcl"),
      }),
      command: chmod ? `chmod -R u+w '${target}'` : `icacls "${target}" /remove:d "%USERNAME%"`,
    },
  ]
}

/** The arguments of a confirm's step, when `op` (the team's running or waiting op, `team.get`) is the confirm's op. */
export function stepArgs(op: Pick<OwnTeam.Op, "id" | "steps"> | null | undefined, confirm: OwnTeam.Confirm) {
  if (op?.id !== confirm.opID) return undefined
  return op.steps.find((step) => step.id === confirm.stepID)?.args
}

/** A non-negative count from a step's arguments; anything else counts as none. */
function count(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0
}

export interface Renewed {
  /** The confirms that still wait, each with the nonce the service holds now. */
  readonly confirms: OwnTeam.Confirm[]
  /** A step's list (`manifest`, 8.6) is not the one shown before. */
  readonly changed: boolean
}

/**
 * Reads each op of `shown` again (`op.get`, 8.5): a step that still needs its confirm comes back with its current
 * nonce and list; an answered, skipped or vanished one, or one of an op that no longer runs or waits, is dropped; one
 * whose op could not be read stays as shown.
 */
export async function renewConfirms(rpc: Pick<TeamRpc, "call">, shown: readonly OwnTeam.Confirm[]): Promise<Renewed> {
  // `null`: the op is gone; `undefined`: it could not be read now (the network), so what is shown stays.
  const ops = await Promise.all(
    [...new Set(shown.map((confirm) => confirm.opID))].map((opID) =>
      rpc.call("op.get", { opID }).then(
        (output) => ({ opID, op: output.op }),
        (error: unknown) => ({
          opID,
          op: error instanceof OwnRpcError && error.type === "not_found" ? null : undefined,
        }),
      ),
    ),
  )
  const confirms = shown.flatMap((confirm): OwnTeam.Confirm[] => {
    const op = ops.find((item) => item.opID === confirm.opID)?.op
    if (op === undefined) return [confirm]
    const step = op?.steps.find((item) => item.id === confirm.stepID)
    if (!op || !ACTIVE.has(op.state) || step?.state !== "needs_confirm" || !step.confirm) return []
    return [
      {
        teamID: op.teamID,
        opID: op.id,
        stepID: step.id,
        kind: step.kind,
        ...(confirm.areaID === undefined ? {} : { areaID: confirm.areaID }),
        ...step.confirm,
      },
    ]
  })
  const changed = confirms.some(
    (confirm) =>
      shown.find((item) => item.opID === confirm.opID && item.stepID === confirm.stepID)?.manifest !== confirm.manifest,
  )
  return { confirms, changed }
}

/** Op states in which a confirm can still be answered (own-team `Journal.ACTIVE`). */
const ACTIVE: ReadonlySet<OwnTeam.OpState> = new Set(["running", "waiting"])

export type Answered =
  /** `failed`: the notes of answered steps that failed (a folder another program holds, 8.6); the others went on. */
  | { readonly kind: "done"; readonly failed?: readonly string[] }
  /** Nothing more was answered: the nonce had run out or was refused, and these confirms wait again. */
  | ({ readonly kind: "renewed" } & Renewed)
  | { readonly kind: "refused"; readonly error: unknown }

/**
 * Answers the confirms one after another (a later step may depend on an earlier one; the first refusal stops the
 * rest). An expired nonce is never sent: the op is read again instead, as after a `nonce_invalid` answer.
 */
export async function answerConfirms(
  rpc: Pick<TeamRpc, "call">,
  confirms: readonly OwnTeam.Confirm[],
  choice: "do" | "skip",
  now = Date.now(),
): Promise<Answered> {
  if (confirms.some((confirm) => now >= confirm.expiresAt))
    return { kind: "renewed", ...(await renewConfirms(rpc, confirms)) }
  const failed: string[] = []
  for (const [index, confirm] of confirms.entries()) {
    const answered = await rpc
      .call("op.confirm", { opID: confirm.opID, stepID: confirm.stepID, choice, nonce: confirm.nonce })
      .then(
        (output) => ({ ok: true as const, op: output.op }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    if (answered.ok) {
      const step = answered.op.steps.find((item) => item.id === confirm.stepID)
      if (step?.state === "failed" && step.note) failed.push(step.note)
      continue
    }
    if (answered.error instanceof OwnRpcError && answered.error.type === "nonce_invalid")
      return { kind: "renewed", ...(await renewConfirms(rpc, confirms.slice(index))) }
    return { kind: "refused", error: answered.error }
  }
  return failed.length === 0 ? { kind: "done" } : { kind: "done", failed }
}

export function TeamConfirmDialog(props: {
  readonly serverKey: ServerKey
  /** One confirm, or several of one op answered together. */
  readonly confirms: readonly OwnTeam.Confirm[]
  /** The PC the service runs on, when known: a gateway device names it (06 §9.8). */
  readonly pc?: string
  readonly onClose: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useTeamText()
  const id = createUniqueId()
  const runtime = () => data.get(props.serverKey)
  const [working, setWorking] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [details, setDetails] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  /** What `op.get` said after a nonce ran out or was refused. */
  const [renewed, setRenewed] = createSignal<readonly OwnTeam.Confirm[]>()
  const [note, setNote] = createSignal<"refreshing" | "changed">()
  // Of the confirm it was opened with, the TeamStore's (`op.confirm` events) and `op.get`'s, the newest nonce wins.
  const confirms = createMemo(() =>
    props.confirms.flatMap((shown) => {
      const same = (item: OwnTeam.Confirm) => item.opID === shown.opID && item.stepID === shown.stepID
      const fresh = renewed()
      if (fresh && !fresh.some(same)) return []
      const pending = runtime()?.team.team(shown.teamID)?.pending.find(same)
      return [
        [pending, fresh?.find(same)].reduce<OwnTeam.Confirm>(
          (newest, item) => (item && item.expiresAt > newest.expiresAt ? item : newest),
          shown,
        ),
      ]
    }),
  )
  const local = () => runtime()?.team.rpc.allowed("op.confirm") === true
  const view = createMemo(() => {
    const team = runtime()?.team
    const first = confirms()[0]
    const entry = first ? team?.team(first.teamID) : undefined
    return confirmView(text, confirms(), {
      local: local(),
      pc: props.pc,
      now: now(),
      bytes: (bytes) => formatBytes(i18n.locale(), bytes),
      time: (at) => coming(i18n, now(), at),
      args: (confirm) => stepArgs(entry?.op, confirm),
      // A remote service runs on the SSH host (Linux, 4.13); this PC's service on Windows.
      protect: team?.state.health?.mode === "remote" ? "chmod" : "acl",
      ...(entry ? { home: entry.team.home.directory } : {}),
    })
  })
  const expiresAt = createMemo(() => Math.min(...confirms().map((confirm) => confirm.expiresAt)))

  // Answered or gone meanwhile (another window, the service): nothing is left to confirm here.
  createEffect(() => {
    if (confirms().length === 0) props.onClose()
  })
  // When the nonce runs out, read the op again for the new one (8.5); an unchanged time does not schedule again.
  createEffect(() => {
    const at = expiresAt()
    if (!local() || !Number.isFinite(at)) return
    const timer = setTimeout(
      () => {
        setNow(Date.now())
        void renew()
      },
      Math.max(0, at - Date.now()),
    )
    onCleanup(() => clearTimeout(timer))
  })

  async function renew() {
    const current = runtime()
    if (!current || working()) return
    setNote("refreshing")
    const result = await renewConfirms(current.team.rpc, confirms())
    setRenewed(result.confirms)
    setNow(Date.now())
    setNote(result.changed ? "changed" : undefined)
  }

  async function answer(choice: "do" | "skip") {
    const current = runtime()
    if (!current || working()) return
    setWorking(true)
    setFailure(undefined)
    const result = await answerConfirms(current.team.rpc, confirms(), choice)
    setWorking(false)
    setNow(Date.now())
    // A removal another program held failed alone; the others went on and its reason is told (8.6).
    if (result.kind === "done" && result.failed)
      showToast({ tone: "danger", message: text("own.team.confirm.stepFailed", { reason: result.failed.join(" · ") }) })
    if (result.kind === "done") return props.onClose()
    if (result.kind === "refused") return setFailure(errorText(text, result.error))
    setRenewed(result.confirms)
    setNote(result.changed ? "changed" : undefined)
    // The answer was not sent: say why, so the user answers the confirm again.
    setFailure(result.changed ? undefined : text("own.team.confirm.expired"))
  }

  return (
    <TeamDialog
      id={id}
      testid="team-confirm"
      danger={view().danger}
      busy={working}
      onClose={props.onClose}
      title={view().title}
      actions={
        <Show
          when={view().buttons.length > 0}
          fallback={
            <button type="button" class="own-team-btn" data-autofocus onClick={() => props.onClose()}>
              {text("own.team.action.close")}
            </button>
          }
        >
          {/* By position, so a re-read (new nonce, the clock) keeps the buttons and the keyboard focus in place. */}
          <Index each={view().buttons}>
            {(button, index) => (
              <button
                type="button"
                class="own-team-btn"
                data-autofocus={index === 0 ? "" : undefined}
                data-danger={button().tone === "danger" ? "" : undefined}
                data-primary={button().tone === "primary" ? "" : undefined}
                data-testid={button().choice === "skip" ? "team-confirm-keep" : "team-confirm-do"}
                disabled={working() || note() === "refreshing"}
                onClick={() => void answer(button().choice)}
              >
                {button().label}
              </button>
            )}
          </Index>
        </Show>
      }
    >
      <For each={confirms()}>
        {(confirm) => (
          <p class="own-team-dialog-body" data-testid="team-confirm-text">
            {confirm.text}
          </p>
        )}
      </For>
      <Show when={view().removes}>{(label) => <p class="own-team-dialog-label">{label()}</p>}</Show>
      <Show when={view().files.length > 0}>
        <ul class="own-team-files" data-testid="team-confirm-files">
          <For each={view().files}>
            {(file) => (
              <li
                class="own-team-file"
                title={file.path}
                data-irreplaceable={file.irreplaceable ? "" : undefined}
                data-testid={file.irreplaceable ? "team-confirm-irreplaceable" : undefined}
              >
                <span class="own-team-file-path">{details() ? file.path : file.name}</span>
                <Show when={file.irreplaceable}>
                  <span class="own-team-file-flag">{text("own.team.confirm.irreplaceable")}</span>
                </Show>
                <span class="own-team-file-size">{file.size}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={view().stays}>
        <p class="own-team-dialog-label">{text("own.team.confirm.stays")}</p>
        <p class="own-team-dialog-body">{text("own.team.confirm.staysRecords")}</p>
        <Show when={view().unapplied}>
          {(line) => (
            <p class="own-team-dialog-body" data-testid="team-confirm-unapplied">
              {line()}
            </p>
          )}
        </Show>
      </Show>
      <For each={view().system}>
        {(item) => (
          <p class="own-team-dialog-body" data-testid="team-confirm-system">
            {item.line}
          </p>
        )}
      </For>
      <ul class="own-team-notes">
        <Show
          when={note() === "refreshing"}
          fallback={
            <li data-tone={view().expired ? "warn" : undefined} data-testid="team-confirm-expires">
              {view().expires}
            </li>
          }
        >
          <li role="status">{text("own.team.confirm.refreshing")}</li>
        </Show>
        <Show when={note() === "changed"}>
          <li data-tone="warn" role="status" data-testid="team-confirm-changed">
            {text("own.team.confirm.changed")}
          </li>
        </Show>
        <Show when={view().viewOnly}>
          {(notice) => (
            <li data-tone="warn" role="status" data-testid="team-confirm-view-only">
              {notice()}
            </li>
          )}
        </Show>
        <Show when={failure()}>
          {(message) => (
            <li data-tone="danger" role="alert">
              {message()}
            </li>
          )}
        </Show>
      </ul>
      <button
        type="button"
        class="own-team-link own-team-details-toggle"
        aria-expanded={details()}
        data-testid="team-confirm-details"
        onClick={() => setDetails((open) => !open)}
      >
        {text("own.team.action.details")}
      </button>
      <Show when={details()}>
        <ul class="own-team-details" data-testid="team-confirm-steps">
          <For each={confirms()}>{(confirm) => <li>{stepLabel(text, confirm.kind)}</li>}</For>
          <For each={view().system.flatMap((item) => (item.command ? [item.command] : []))}>
            {(command) => <li>{text("own.team.confirm.command", { command })}</li>}
          </For>
        </ul>
      </Show>
    </TeamDialog>
  )
}

export function DisableDialog(props: {
  readonly serverKey: ServerKey
  readonly teamID: OwnTeam.TeamID
  readonly onClose: () => void
}) {
  const data = useData()
  const text = useTeamText()
  const id = createUniqueId()
  const runtime = () => data.get(props.serverKey)
  const [working, setWorking] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  async function disable(cleanup: boolean) {
    const current = runtime()
    if (!current || working()) return
    setWorking(true)
    setFailure(undefined)
    const started = await current.team.rpc
      .call("disable", { teamID: props.teamID, ...(cleanup ? { cleanup } : {}) })
      .then(
        (output) => ({ ok: true as const, opID: output.opID }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    setWorking(false)
    if (!started.ok) {
      setFailure(errorText(text, started.error))
      return
    }
    props.onClose()
    const done = await opDone(current.team, started.opID)
    const reason = done.state === "failed" ? await failedNote(current.team, started.opID) : undefined
    // 끝난 영역 정리하고 끄기 waits for its removals in the card above the team main; the team goes off after them.
    showToast(
      done.state === "failed"
        ? {
            tone: "danger",
            message: text("own.team.card.state.failed", { reason: reason ?? text("own.team.error.internalError") }),
          }
        : { message: text(done.state === "waiting" ? "own.team.disable.waiting" : "own.team.disable.done") },
    )
  }

  return (
    <TeamDialog
      id={id}
      testid="team-disable"
      busy={working}
      onClose={props.onClose}
      title={text("own.team.disable.title")}
      actions={
        <>
          <button
            type="button"
            class="own-team-btn"
            data-autofocus
            disabled={working()}
            onClick={() => props.onClose()}
          >
            {text("own.team.action.cancel")}
          </button>
          <button
            type="button"
            class="own-team-btn"
            data-primary
            data-testid="team-disable-keep"
            disabled={working()}
            onClick={() => void disable(false)}
          >
            {text("own.team.disable.keep")}
          </button>
          <Show when={runtime()?.team.has("cleanup")}>
            <button
              type="button"
              class="own-team-btn"
              data-danger
              data-testid="team-disable-cleanup"
              disabled={working()}
              onClick={() => void disable(true)}
            >
              {text("own.team.disable.cleanup")}
            </button>
          </Show>
        </>
      }
    >
      <p class="own-team-dialog-body">{text("own.team.disable.body")}</p>
      <Show when={failure()}>
        {(message) => (
          <p class="own-team-dialog-body" data-tone="danger" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </TeamDialog>
  )
}

/** What Tab moves between inside a team dialog. */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/**
 * The frame every team dialog shares (03's danger dialog): scrim, `alertdialog` (a form says `dialog`), focus on the
 * `data-autofocus` element, Tab kept inside, Escape and the scrim close it unless an answer is on its way, and focus
 * goes back to where it was.
 */
export function TeamDialog(
  props: ParentProps<{
    readonly id: string
    readonly title: string
    readonly testid: string
    readonly role?: "alertdialog" | "dialog"
    readonly danger?: boolean
    readonly busy: () => boolean
    readonly onClose: () => void
    readonly actions: JSX.Element
    /**
     * The dialog steps aside while another popover works for it (영역 만들기's model pick, 2026-10-26): it keeps its
     * place and state but is not seen, and Escape goes to that popover.
     */
    readonly hidden?: () => boolean
  }>,
) {
  let dialog: HTMLDivElement | undefined
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  onMount(() => dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus())
  onCleanup(() => returnTo?.isConnected && returnTo.focus())
  const away = () => props.hidden?.() === true
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || away()) return
    event.stopPropagation()
    if (!props.busy()) props.onClose()
  }
  document.addEventListener("keydown", escape, true)
  onCleanup(() => document.removeEventListener("keydown", escape, true))
  const trap = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !dialog) return
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    const wrap = event.shiftKey ? document.activeElement === first && last : document.activeElement === last && first
    if (!wrap) return
    event.preventDefault()
    wrap.focus()
  }
  return (
    <Portal>
      <div
        class="own-team-scrim"
        style={away() ? { visibility: "hidden" } : undefined}
        onClick={() => !props.busy() && props.onClose()}
      />
      <div
        ref={dialog}
        class="own-team-dialog"
        style={away() ? { visibility: "hidden" } : undefined}
        role={props.role ?? "alertdialog"}
        aria-modal="true"
        aria-labelledby={`${props.id}-title`}
        data-danger={props.danger ? "" : undefined}
        data-testid={props.testid}
        onKeyDown={trap}
      >
        <h2 id={`${props.id}-title`} class="own-team-dialog-title">
          {props.title}
        </h2>
        {props.children}
        <div class="own-team-dialog-actions">{props.actions}</div>
      </div>
    </Portal>
  )
}

/** The last segment of a path: folders show their short name, `자세히` the full path (06 §9.1). */
function shortName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  )
}
