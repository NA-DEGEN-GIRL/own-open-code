// Request dock stack (lazy chunk, 03 §18.1–18.2): one request large, the rest folded into `다른 요청 n개`. Order is
// the model's (permissions, then questions/forms, the open session before its subagents). Each request view is keyed
// by the request id, so a reason or answer being typed survives other requests arriving (IME rule 5).
import type { FormWithLocation } from "@opencode/client/solid"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { actionKind, mcpInfo, subjects } from "./describe"
import { FormDock } from "./form-dock"
import type { RequestItem, RequestModel } from "./model"
import { PermissionDock } from "./permission-dock"
import { useRequestsText } from "./strings"
import { createWebSearchRequest } from "./vendor/websearch"
import { WebSearchDock } from "./websearch-dock"
import "./requests.css"

export default function RequestDockView(props: {
  readonly model: RequestModel
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const text = useRequestsText()
  const [expanded, setExpanded] = createSignal(false)
  let root: HTMLElement | undefined
  const runtime = () => data.get(props.serverKey())

  // One web search flow per open session (upstream keeps it in the session request model): answering "choose"
  // removes the first form before core asks the second, and the flow must not be torn down in between.
  const websearchForm = createMemo((): FormWithLocation | undefined => {
    const current = props.model.current()
    if (current?.kind === "form" && current.flavor === "websearch") return current.form
    const first = props.model.items().find((item) => item.kind === "form" && item.flavor === "websearch")
    return first?.kind === "form" ? first.form : undefined
  })
  // Declared before the model: its resource fetches synchronously when a form is already pending.
  const directoryOf = () => websearchForm()?.location?.directory ?? props.model.directory() ?? ""
  const ws = createWebSearchRequest({
    owner: props.sessionID,
    connected: props.model.connected,
    request: websearchForm,
    providers: async () => {
      const current = runtime()
      if (!current) return []
      const result = await current.client().websearch.providers({ location: { directory: directoryOf() } })
      return result.data.map((provider) => ({ value: provider.id, label: provider.name }))
    },
    reply: async (input) => {
      await runtime()?.data.session.form.reply(input, websearchForm()?.location)
    },
    events: { listen: (handler) => runtime()?.bus.listen(handler) ?? (() => undefined) },
  })

  // While a web search answer is in flight its form stays on screen (same key: no remount), even after core removed it.
  const sendingKey = () => (ws.sending() ? `f:${ws.request()?.id}` : undefined)
  const key = createMemo(() => sendingKey() ?? props.model.current()?.key)
  const item = (key: string) => props.model.items().find((entry) => entry.key === key)

  function done(hadFocus: boolean) {
    setExpanded(false)
    if (!hadFocus) return
    // Keyboard flow: the next request takes focus, or the composer when none is left.
    nextFrame(() => {
      // The section is gone (detached, children and all) once nothing is left.
      const next = root?.isConnected ? root.querySelector<HTMLElement>("[data-own-dock-focus]") : null
      ;(next ?? document.getElementById("own-composer-input"))?.focus()
    })
  }

  return (
    <Show when={key()}>
      <section
        ref={root}
        class="own-rq"
        role="region"
        aria-label={text("own.requests.dock")}
        data-testid="request-dock"
        data-count={props.model.items().length}
      >
        <Show when={props.model.others().length > 0}>
          <div class="own-rq-more">
            <button
              type="button"
              class="own-rq-more-toggle"
              aria-expanded={expanded()}
              data-testid="request-more"
              onClick={() => setExpanded((value) => !value)}
            >
              <span aria-hidden="true">{expanded() ? "▾" : "▸"}</span>
              {expanded()
                ? text("own.requests.moreHide")
                : text("own.requests.more", { n: props.model.others().length })}
            </button>
            <Show when={expanded()}>
              <ul class="own-rq-more-list">
                <For each={props.model.others()}>
                  {(other) => (
                    <li>
                      <button
                        type="button"
                        class="own-rq-more-row"
                        data-testid="request-more-row"
                        onClick={() => {
                          props.model.show(other.key)
                          setExpanded(false)
                        }}
                      >
                        <span
                          class="own-rq-mark"
                          data-kind={other.kind === "permission" ? "permission" : "question"}
                          aria-hidden="true"
                        >
                          ?
                        </span>
                        <span class="own-rq-ellipsis">
                          <Summary item={other} />
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </Show>
        <Show when={key()} keyed>
          {(current) => (
            <Switch>
              <Match when={current === sendingKey() || isWebSearch(item(current))}>
                <WebSearchDock
                  ws={ws}
                  model={props.model}
                  origin={item(current)?.origin ?? { sessionID: props.sessionID() ?? "", agents: [] }}
                  serverKey={props.serverKey()}
                  onDone={done}
                />
              </Match>
              <Match when={item(current)?.kind === "permission" && item(current)}>
                {(entry) => (
                  <PermissionDock
                    item={entry() as Extract<RequestItem, { kind: "permission" }>}
                    model={props.model}
                    serverKey={props.serverKey()}
                    onDone={done}
                  />
                )}
              </Match>
              <Match when={item(current)?.kind === "form" && item(current)}>
                {(entry) => (
                  <FormDock
                    item={entry() as Extract<RequestItem, { kind: "form" }>}
                    model={props.model}
                    serverKey={props.serverKey()}
                    onDone={done}
                  />
                )}
              </Match>
            </Switch>
          )}
        </Show>
      </section>
    </Show>
  )
}

function isWebSearch(item: RequestItem | undefined) {
  return item?.kind === "form" && item.flavor === "websearch"
}

/** One line per folded request: what it is, and whose. */
function Summary(props: { readonly item: RequestItem }) {
  const i18n = useI18n()
  const text = useRequestsText()
  const what = () => {
    const item = props.item
    if (item.kind === "permission") {
      const kind = actionKind(item.request.action)
      const title =
        kind === "other"
          ? text("own.requests.title.other", { action: item.request.action })
          : text(`own.requests.title.${kind}`)
      const subject = subjects(item.request)[0]
      return subject ? `${title} · ${subject}` : title
    }
    if (item.flavor === "websearch") return i18n.t("own.websearch.title")
    if (item.flavor === "mcp") return text("own.requests.form.mcp", { server: mcpInfo(item.form).server })
    if (item.flavor === "question") return text("own.requests.form.question")
    return item.form.title
  }
  const whose = () =>
    props.item.origin.agents.length
      ? ` — ${i18n.t("own.perm.fromChild", { agent: props.item.origin.agents.join(" › ") })}`
      : ""
  return (
    <>
      {what()}
      {whose()}
    </>
  )
}
