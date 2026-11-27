// Two-step host operations (04 §6.4–6.8, 02 §9.2 plan → nonce → execute): update (with drain choice), "현재 턴이
// 끝나면 중지", forget (with the API keys to rotate), and taking the host over from another PC. Each dialog asks for
// the plan when it opens, shows it, and executes only on the user's confirmation.
import { createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { OwnRpcError, useData } from "@/data"
import { Dialog, Notice, Segmented, Spinner } from "@/limits/kit"
import type { RemoteStore } from "@/servers"
import { bytes, progressLabel } from "./add-host"
import { useRemoteText } from "./strings"

type Kind = "update" | "drain" | "forget" | "takeover"

export function OperationDialog(props: {
  readonly store: RemoteStore
  readonly hostId: string
  readonly kind: Kind
  readonly onClose: () => void
}) {
  const text = useRemoteText()
  const data = useData()
  const store = props.store
  const name = () => store.state.hosts[props.hostId]?.name ?? props.hostId
  const [drain, setDrain] = createSignal<"wait" | "now">("wait")
  const [uninstall, setUninstall] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [started, setStarted] = createSignal<string>()

  const [update] = createResource(
    () => props.kind === "update",
    () => store.call("update.plan", { hostId: props.hostId }),
  )
  const [drainPlan] = createResource(
    () => props.kind === "drain",
    () => store.call("drain.plan", { hostId: props.hostId, action: "stop" }),
  )
  const [forget, { refetch: replanForget }] = createResource(
    () => (props.kind === "forget" ? { uninstall: uninstall() } : false),
    (input) => store.call("forget.plan", { hostId: props.hostId, uninstall: input.uninstall }),
  )
  const [takeover] = createResource(
    () => props.kind === "takeover",
    () => store.call("owner.takeover.plan", { hostId: props.hostId }),
  )
  const planError = () => update.error ?? drainPlan.error ?? forget.error ?? takeover.error
  const planning = () => update.loading || drainPlan.loading || forget.loading || takeover.loading

  const title = () => {
    switch (props.kind) {
      case "update":
        return text("own.remote.update.title", { host: name() })
      case "drain":
        return text("own.remote.drain.title", { host: name() })
      case "forget":
        return text("own.remote.forget.title", { host: name() })
      case "takeover":
        return text("own.remote.takeover.title")
    }
  }

  async function execute() {
    if (busy()) return
    setBusy(true)
    setFailure(undefined)
    try {
      switch (props.kind) {
        case "update": {
          const plan = update()
          if (!plan) return
          const result = await store.call("update.execute", { nonce: plan.nonce, drain: drain() })
          setStarted(result.opId)
          return
        }
        case "drain": {
          const plan = drainPlan()
          if (!plan) return
          const result = await store.call("drain.execute", { nonce: plan.nonce, mode: drain() })
          setStarted(result.opId)
          return
        }
        case "forget": {
          const plan = forget()
          if (!plan) return
          const result = await store.call("forget.execute", { nonce: plan.nonce })
          if (result.ok) {
            store.forgotten(props.hostId)
            props.onClose()
          }
          return
        }
        case "takeover": {
          const plan = takeover()
          if (!plan) return
          await store.call("owner.takeover.execute", { nonce: plan.nonce })
          await store.connect(props.hostId).catch(() => undefined)
          props.onClose()
          return
        }
      }
    } catch (error) {
      setFailure(error instanceof OwnRpcError ? error.type : error instanceof Error ? error.message : String(error))
      if (props.kind === "forget") void replanForget()
    } finally {
      setBusy(false)
    }
  }

  const progress = () =>
    (store.state.progress[props.hostId] ?? []).filter((item) => (started() ? item.opId === started() : false))
  const accountName = (id: string) => data.local().own.state.accounts[id]?.label ?? id

  return (
    <Dialog open title={title()} onClose={props.onClose} testid={`remote-op-${props.kind}`}>
      <div class="flex flex-col gap-3 text-[13px]">
        <Show when={planning()}>
          <p class="m-0 flex items-center gap-2">
            <Spinner /> {text("own.remote.op.planning")}
          </p>
        </Show>
        <Show when={planError()}>
          {(error) => (
            <Notice tone="danger" testid="remote-op-error">
              {text("own.remote.op.failed", {
                reason: error() instanceof OwnRpcError ? (error() as OwnRpcError).type : String(error()),
              })}
            </Notice>
          )}
        </Show>
        <Switch>
          <Match when={props.kind === "update" && update()}>
            {(plan) => (
              <>
                <p class="m-0 font-medium" data-testid="remote-update-versions">
                  {text("own.remote.update.versions", { from: plan().from ?? "—", to: plan().to })}
                </p>
                <p class="m-0 text-own-muted">
                  {plan().activeSessions === null
                    ? text("own.remote.update.unknownActive")
                    : text("own.remote.update.active", { count: plan().activeSessions!.length })}
                </p>
                <p class="m-0 text-own-muted">
                  {text("own.remote.update.backup")}
                  <Show when={plan().backup.bytes !== null}> ({bytes(plan().backup.bytes!)})</Show>
                </p>
                <DrainChoice value={drain()} onChange={setDrain} kind="update" />
              </>
            )}
          </Match>
          <Match when={props.kind === "drain" && drainPlan()}>
            {(plan) => (
              <>
                <p class="m-0">{text("own.remote.drain.body")}</p>
                <p class="m-0 text-own-muted">
                  {plan().activeSessions === null
                    ? text("own.remote.update.unknownActive")
                    : text("own.remote.update.active", { count: plan().activeSessions!.length })}
                </p>
                <DrainChoice value={drain()} onChange={setDrain} kind="drain" />
              </>
            )}
          </Match>
          <Match when={props.kind === "forget" && forget()}>
            {(plan) => (
              <>
                <p class="m-0">{text("own.remote.forget.local")}</p>
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={uninstall()}
                    data-testid="remote-forget-uninstall"
                    onChange={(event) => setUninstall(event.currentTarget.checked)}
                  />
                  {text("own.remote.forget.uninstall")}
                </label>
                <Show when={uninstall()}>
                  <div class="grid grid-cols-2 gap-2 text-[12px]">
                    <div>
                      <p class="m-0 text-own-muted">{text("own.remote.forget.removes")}</p>
                      <ul class="own-mono m-0 list-none p-0">
                        <For each={plan().removes}>{(item) => <li>{item}</li>}</For>
                      </ul>
                    </div>
                    <div>
                      <p class="m-0 text-own-muted">{text("own.remote.forget.keeps")}</p>
                      <ul class="own-mono m-0 list-none p-0">
                        <For each={plan().keeps}>{(item) => <li>{item}</li>}</For>
                      </ul>
                    </div>
                  </div>
                </Show>
                <Show when={plan().leasedAccounts.length}>
                  <Notice tone="warn" testid="remote-forget-rotate">
                    <p class="m-0">{text("own.remote.forget.rotate")}</p>
                    <ul class="m-0 mt-1 list-disc pl-5">
                      <For each={plan().leasedAccounts}>{(id) => <li>{accountName(id)}</li>}</For>
                    </ul>
                  </Notice>
                </Show>
              </>
            )}
          </Match>
          <Match when={props.kind === "takeover" && takeover()}>
            {(plan) => (
              <>
                <p class="m-0">{text("own.remote.takeover.body")}</p>
                <Show when={plan().previous?.label}>
                  {(label) => (
                    <p class="m-0 text-own-muted">{text("own.remote.takeover.previous", { label: label() })}</p>
                  )}
                </Show>
              </>
            )}
          </Match>
        </Switch>
        <Show when={started()}>
          <Notice tone="ok" testid="remote-op-started">
            <p class="m-0">{text("own.remote.update.started")}</p>
            <ul class="m-0 mt-1 list-none p-0 text-[12px]">
              <For each={progress()}>
                {(item) => (
                  <li>
                    {item.ok === false ? "✗" : "·"} {progressLabel(text, item.step)}
                  </li>
                )}
              </For>
            </ul>
          </Notice>
        </Show>
        <Show when={failure()}>
          <Notice tone="danger" testid="remote-op-failure">
            {text("own.remote.op.failed", { reason: failure()! })}
          </Notice>
        </Show>
        <div class="flex justify-end gap-2">
          <button type="button" class="own-btn own-target" onClick={props.onClose}>
            {started() ? text("own.remote.op.close") : text("own.remote.op.cancel")}
          </button>
          <Show when={!started()}>
            <button
              type="button"
              class="own-btn own-target"
              data-variant={props.kind === "forget" ? "danger" : "primary"}
              data-testid="remote-op-confirm"
              disabled={busy() || planning() || !!planError()}
              onClick={() => void execute()}
            >
              {props.kind === "update"
                ? text("own.remote.update.start")
                : props.kind === "drain"
                  ? text("own.remote.drain.start")
                  : props.kind === "forget"
                    ? text("own.remote.forget.confirm")
                    : text("own.remote.takeover.confirm")}
            </button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

function DrainChoice(props: {
  readonly value: "wait" | "now"
  readonly onChange: (value: "wait" | "now") => void
  readonly kind: "update" | "drain"
}) {
  const text = useRemoteText()
  return (
    <Segmented
      label={props.kind === "update" ? text("own.remote.update.start") : text("own.remote.drain.start")}
      value={props.value}
      options={[
        {
          value: "wait",
          label: props.kind === "update" ? text("own.remote.update.wait") : text("own.remote.quit.drain"),
        },
        {
          value: "now",
          label: props.kind === "update" ? text("own.remote.update.now") : text("own.remote.quit.stopNow"),
        },
      ]}
      onChange={props.onChange}
      testid="remote-drain-choice"
    />
  )
}
