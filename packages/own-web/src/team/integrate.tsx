// Integration card and upload dialog (06 §7, §9.7, §7.5), lazy in the team chunk (a screen outside src/team imports it
// with `lazy(() => import("@/team/integrate"))`). The card follows one integration: `integration.get`, again on every
// `integration.changed` of it and on its op's progress. `integrate-model.ts` words it: progress with `검사 1/2`, done
// with `[되돌리기] [원격 저장소에 올리기…] [검토 요청 올리기…] [자세히]`, waiting `[다시 반영]`, failure `[로그 보기]`,
// conflict, undone. `다시 반영` (`area.integrate`) may start another integration, which the card then follows. When
// `integration.undo` answers that the project's main code moved on (`conflict`, 7.4), the card offers
// `메인에게 되돌리기 맡기기`, a prompt to the team main. An undo that waits for the folder that has the project's main
// code checked out says why and offers `되돌리기 취소` (`integration.undo.cancel`, RH-42). When 반영하기 전에 묻기 is on, the op's confirm (7.2 step 8)
// waits in the card and opens the confirm dialog, as does the first `.assets` confirm, which a later op of the same
// integration asks (4.10), so the card follows the integration's state, not its first op's end. Uploading (7.5) is `integration.push.plan` -> the upload dialog
// (remote; record name and commands under 자세히; focus on 취소) -> `integration.push.execute{nonce}`, then a toast when
// its op ends. Uploads and confirms need the PC (`local`): a gateway device sees `<PC 이름>에서 확인하세요` instead.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createMemo, createResource, createSignal, createUniqueId, For, Index, onCleanup, Show } from "solid-js"
import { useData, type ServerKey, type ServerRuntime } from "@/data"
import { OwnRpcError } from "@/data/rpc"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { coming } from "@/limits/format"
import { baseName, samePath } from "@/projects/path"
import { useRouter } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import { showToast } from "@/switcher/toast"
import { formatDuration } from "@/transcript/format"
import { isApply, TeamConfirmDialog, TeamDialog } from "./confirm"
import { failed, opDone } from "./enable"
import {
  executePush,
  integrationCan,
  integrationView,
  planPush,
  pushOutcome,
  uploadElsewhere,
  type IntegrationAction,
  type IntegrationNames,
  type PushPlan,
} from "./integrate-model"
import { errorText, viewOnlyText } from "./model"
import { useTeamText } from "./strings"
import { useTeamWaitText } from "./wait-strings"
import "./team.css"

export default function IntegrationCard(props: {
  readonly serverKey: ServerKey
  readonly integrationID: OwnTeam.IntegrationID
  /** The op that runs it (`area.integrate`'s answer): its progress refreshes the card, its confirm waits in it. */
  readonly opID?: OwnTeam.OpID
  /** A card that can be put away (`닫기`). */
  readonly onClose?: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const host = useHost()
  const router = useRouter()
  const text = useTeamText()
  const waitText = useTeamWaitText()
  const id = createUniqueId()
  const runtime = () => data.get(props.serverKey)
  const team = () => runtime()?.team
  const [current, setCurrent] = createSignal({ integrationID: props.integrationID, opID: props.opID })
  const [read, { refetch }] = createResource(
    () => current().integrationID,
    (integrationID) =>
      team()
        ?.rpc.call("integration.get", { integrationID })
        .then(
          (output) => ({ integration: output.integration }),
          (error: unknown) => ({ error }),
        ),
  )
  const stops = [
    team()?.on("integration.changed", (event) => {
      if (event.data.integrationID === current().integrationID) void refetch()
    }),
    team()?.on("op.progress", (event) => {
      if (event.data.opID === current().opID) void refetch()
    }),
    team()?.on("op.done", (event) => {
      if (event.data.opID === current().opID) void refetch()
    }),
  ]
  onCleanup(() => stops.forEach((stop) => stop?.()))

  const integration = () => {
    const value = read.latest
    return value && "integration" in value ? value.integration : undefined
  }
  const entry = () => {
    const value = integration()
    return value ? team()?.team(value.teamID) : undefined
  }
  const areaName = () => {
    const value = integration()
    if (!value) return ""
    return entry()?.areas[value.areaID]?.name ?? value.areaID.replace(/^ar_/, "")
  }
  const names = (): IntegrationNames => ({
    area: areaName(),
    folder: (directory) => {
      const home = entry()?.team.home.directory
      return home && samePath(home, directory)
        ? text("own.team.homeFolder", { name: baseName(directory) })
        : baseName(directory)
    },
    duration: (ms) => formatDuration(i18n, ms),
  })
  /** The PC the service runs on, as the gateway names it to a device (06 §9.8). */
  const pc = () => runtime()?.entry()?.pc
  const local = () => team()?.rpc.allowed("op.confirm") === true
  const [delegated, setDelegated] = createSignal(false)
  const view = createMemo(() => {
    const value = integration()
    const store = team()
    if (!value || !store) return undefined
    const elsewhere = uploadElsewhere(text, store, pc())
    return integrationView(text, {
      integration: value,
      names: names(),
      can: integrationCan(store, entry() !== undefined && runtime()?.rpc.can("prompt") === true),
      waitText,
      delegated: delegated(),
      ...(elsewhere ? { viewOnly: elsewhere } : {}),
    })
  })
  // The first `.assets` creation (4.10) is asked in a later op of the same running integration: it waits here too.
  const confirms = () => {
    const opID = current().opID
    const value = integration()
    if (!value) return []
    return (
      team()
        ?.team(value.teamID)
        ?.pending.filter(
          (confirm) =>
            confirm.opID === opID ||
            (value.state === "running" && confirm.kind === "integrate-assets" && confirm.areaID === value.areaID),
        ) ?? []
    )
  }
  const [working, setWorking] = createSignal(false)
  const [details, setDetails] = createSignal(false)
  const [log, setLog] = createSignal(false)
  const [plan, setPlan] = createSignal<PushPlan>()
  const [confirming, setConfirming] = createSignal(false)

  /** Runs a team call with the card's buttons held; a failure says why. */
  async function act(call: (live: ServerRuntime, value: OwnTeam.Integration) => Promise<unknown>) {
    const live = runtime()
    const value = integration()
    if (!live || !value || working()) return
    setWorking(true)
    await call(live, value).catch((error: unknown) => failed(i18n.locale(), error))
    setWorking(false)
  }

  function run(action: IntegrationAction) {
    switch (action.kind) {
      case "log":
        return setLog((open) => !open)
      case "pr-page":
        return host.openExternal(action.url)
      case "retry":
        return void act(async (live, value) => {
          const started = await live.team.rpc.call("area.integrate", { teamID: value.teamID, areaID: value.areaID })
          const same = started.integrationID === current().integrationID
          setDelegated(false)
          setCurrent({ integrationID: started.integrationID, opID: started.opID })
          if (same) void refetch()
        })
      case "undo":
        return void act(async (live, value) => {
          const refused = await live.team.rpc.call("integration.undo", { integrationID: value.id }).then(
            () => undefined,
            (error: unknown) => ({ error }),
          )
          if (!refused) return
          // 7.4: the project's main code moved past what was applied, so only the main can undo it now.
          if (refused.error instanceof OwnRpcError && refused.error.type === "conflict") return setDelegated(true)
          await failed(i18n.locale(), refused.error)
        })
      case "undo-cancel":
        return void act(async (live, value) => {
          await live.team.rpc.call("integration.undo.cancel", { integrationID: value.id })
          showToast({ message: waitText("own.team.wait.undoCancelled") })
          void refetch()
        })
      case "undo-main":
        return void act(async (live) => {
          const main = entry()?.team.main.sessionID
          if (!main) return
          await live.data.session.prompt({
            sessionID: main,
            text: text("own.team.integrate.undoMainPrompt", { area: areaName() }),
          })
          router.navigate({ name: "session", serverKey: props.serverKey, sessionID: main })
        })
      case "push":
        return void act(async (live, value) => setPlan(await planPush(live.team.rpc, value.id, action.pr)))
    }
  }

  /** The upload started: say so, then how its op ended (7.5). */
  async function uploading(opID: OwnTeam.OpID, shown: PushPlan) {
    const store = team()
    if (!store) return
    showToast({ message: text("own.team.push.running") })
    await opDone(store, opID)
    const op = await store.rpc.call("op.get", { opID }).then(
      (output) => output.op,
      () => undefined,
    )
    showToast(pushOutcome(text, shown, op))
    void refetch()
  }

  return (
    <Show
      when={view()}
      fallback={
        <Show when={read.latest && "error" in read.latest ? read.latest.error : undefined}>
          {(error) => (
            <p class="own-team-card own-team-muted" role="alert" data-testid="team-integration-error">
              {errorText(text, error())}
            </p>
          )}
        </Show>
      }
    >
      {(shown) => (
        <section
          class="own-team-card"
          aria-labelledby={`${id}-title`}
          data-testid="team-integration"
          data-state={integration()?.state}
        >
          <h3 id={`${id}-title`} class="own-team-card-title" data-testid="team-integration-title">
            {shown().headline}
          </h3>
          <Show when={shown().lines.length > 0}>
            <ul class="own-team-card-lines">
              <For each={shown().lines}>
                {(line) => (
                  <li class="own-team-card-line" data-tone={line.tone} data-testid="team-integration-line">
                    {line.text}
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={confirms().length > 0}>
            <ul class="own-team-confirms" data-testid="team-integration-confirms">
              <li class="own-team-confirm">
                <span class="own-team-confirm-text">{confirms()[0]?.text}</span>
                <Show
                  when={local()}
                  fallback={<span class="own-team-muted">{viewOnlyText(text, "confirm", pc())}</span>}
                >
                  <span class="own-team-confirm-buttons">
                    <button
                      type="button"
                      class="own-team-btn"
                      data-primary
                      aria-haspopup="dialog"
                      data-testid="team-integration-confirm"
                      onClick={() => setConfirming(true)}
                    >
                      {/* The first-creation confirm of `.assets` changes the system: `확인하기…`, not `반영하기`. */}
                      {text(confirms().every(isApply) ? "own.team.confirm.integrateDo" : "own.team.confirm.open")}
                    </button>
                  </span>
                </Show>
              </li>
            </ul>
          </Show>
          <Show when={log() ? shown().log : undefined}>
            {(output) => (
              <pre
                class="own-mono m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-own-border bg-own-subtle p-2.5 text-[11.5px] leading-[18px]"
                tabindex="0"
                aria-label={text("own.team.action.log")}
                data-testid="team-integration-log"
              >
                {output()}
              </pre>
            )}
          </Show>
          <Show when={details()}>
            <ul class="own-team-details" data-testid="team-integration-details">
              <For each={shown().details}>{(line) => <li>{line}</li>}</For>
            </ul>
          </Show>
          <div class="own-team-card-actions">
            {/* By position, so a refreshed card keeps its buttons and the keyboard focus in place. */}
            <Index each={shown().buttons}>
              {(button, index) => (
                <button
                  type="button"
                  class="own-team-btn"
                  data-primary={index === 0 && button().action.kind === "retry" ? "" : undefined}
                  aria-expanded={button().action.kind === "log" ? log() : undefined}
                  aria-haspopup={button().action.kind === "push" ? "dialog" : undefined}
                  data-testid={`team-integration-${testid(button().action)}`}
                  disabled={working()}
                  onClick={() => run(button().action)}
                >
                  {button().label}
                </button>
              )}
            </Index>
            <button
              type="button"
              class="own-team-btn"
              aria-expanded={details()}
              data-testid="team-integration-details-toggle"
              onClick={() => setDetails((open) => !open)}
            >
              {text("own.team.action.details")}
            </button>
            <Show when={props.onClose}>
              {(close) => (
                <button
                  type="button"
                  class="own-team-btn"
                  data-testid="team-integration-close"
                  onClick={() => close()()}
                >
                  {text("own.team.action.close")}
                </button>
              )}
            </Show>
          </div>
          <Show when={plan()}>
            {(shownPlan) => (
              <PushDialog
                serverKey={props.serverKey}
                plan={shownPlan()}
                onClose={() => setPlan(undefined)}
                onStarted={(opID, started) => void uploading(opID, started)}
              />
            )}
          </Show>
          <Show when={confirming() && confirms().length > 0}>
            <TeamConfirmDialog
              serverKey={props.serverKey}
              confirms={confirms()}
              pc={pc()}
              onClose={() => setConfirming(false)}
            />
          </Show>
        </section>
      )}
    </Show>
  )
}

/**
 * 원격 저장소에 올리기 / 검토 요청 올리기 (7.5): the remote, and under 자세히 the record name and the commands that
 * will run. Focus starts on 취소. An expired or refused nonce runs nothing: the dialog shows the new plan to confirm.
 */
export function PushDialog(props: {
  readonly serverKey: ServerKey
  readonly plan: PushPlan
  readonly onClose: () => void
  /** The upload op started with the plan that was confirmed. */
  readonly onStarted: (opID: OwnTeam.OpID, plan: PushPlan) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useTeamText()
  const id = createUniqueId()
  const runtime = () => data.get(props.serverKey)
  const [plan, setPlan] = createSignal(props.plan)
  const [working, setWorking] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [details, setDetails] = createSignal(false)

  async function upload() {
    const current = runtime()
    if (!current || working()) return
    setWorking(true)
    setFailure(undefined)
    const shown = plan()
    const started = await executePush(current.team.rpc, shown).then(
      (value) => value,
      (error: unknown) => {
        setFailure(errorText(text, error))
        return undefined
      },
    )
    setWorking(false)
    if (!started) return
    if (started.kind === "renewed") {
      setPlan(started.plan)
      setFailure(text("own.team.confirm.expired"))
      return
    }
    props.onClose()
    props.onStarted(started.opID, shown)
  }

  return (
    <TeamDialog
      id={id}
      testid="team-push"
      busy={working}
      onClose={props.onClose}
      title={text(plan().pr ? "own.team.push.prTitle" : "own.team.push.title")}
      actions={
        <>
          <button
            type="button"
            class="own-team-btn"
            data-autofocus
            data-testid="team-push-cancel"
            disabled={working()}
            onClick={() => props.onClose()}
          >
            {text("own.team.action.cancel")}
          </button>
          <button
            type="button"
            class="own-team-btn"
            data-primary
            data-testid="team-push-do"
            disabled={working()}
            onClick={() => void upload()}
          >
            {text(plan().pr ? "own.team.push.prDo" : "own.team.push.do")}
          </button>
        </>
      }
    >
      <p class="own-team-dialog-body" data-testid="team-push-remote">
        {text("own.team.push.remote", { remote: plan().remote })}
      </p>
      <ul class="own-team-notes">
        <li>{text("own.team.confirm.expires", { time: coming(i18n, minuteNow(), plan().expiresAt) })}</li>
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
        data-testid="team-push-details"
        onClick={() => setDetails((open) => !open)}
      >
        {text("own.team.action.details")}
      </button>
      <Show when={details()}>
        <ul class="own-team-details" data-testid="team-push-commands">
          <li>{text("own.team.push.record", { name: plan().ref })}</li>
          <li>{text("own.team.push.commands")}</li>
          <For each={plan().commands}>{(command) => <li class="own-mono">{command}</li>}</For>
        </ul>
      </Show>
    </TeamDialog>
  )
}

function testid(action: IntegrationAction) {
  if (action.kind === "push") return action.pr ? "push-pr" : "push"
  return action.kind
}
