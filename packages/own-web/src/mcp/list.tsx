// The MCP server list (03 §18.14) shared by 설정 > MCP and the Ctrl+; dialog: name, status, on/off, `로그인…` for
// `needs_auth`, the server's error folded, and the cache note of each server kind. Lazy chunks only (uses the kit).
// SG (2026-10-26): with the kept switches each row says what decides it here (`이 프로젝트에서 끔`, `이 프로젝트에서만
// 켬`, `모든 프로젝트에서 꺼 둠`) and own's servers kept for one project `이 프로젝트만`; a project's own decision has
// `되돌리기` (the switch at its folder deleted).
import { For, Show, type JSX } from "solid-js"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Spinner, Tag, type TagTone } from "@/limits/kit"
import { ToggleSwitch } from "@/shell/switch"
import { exceptionTag, type Override } from "./manage-model"
import { summarize, switchedOn, type McpRow, type McpStatus } from "./model"
import type { McpServers } from "./store"
import { useMcpListText } from "./list-strings"

/** The kept switches the rows' tags read, and who may delete one (`되돌리기`). */
export interface McpSwitches {
  readonly overrides: () => ReadonlyArray<Override> | undefined
  /** own's server of this name is kept for this project only (`이 프로젝트만`). */
  readonly projectOnly: (name: string) => boolean
  readonly canReset: () => boolean
}

const TONE: Record<McpStatus, TagTone> = {
  connected: "ok",
  pending: "soft",
  disabled: "plain",
  failed: "danger",
  needs_auth: "warn",
}

export function McpServerList(props: {
  readonly mcp: McpServers
  /** 설정 > MCP 서버 (SM): more about each row: where it comes from, its definition and tools, its actions. */
  readonly details?: (row: McpRow) => JSX.Element
  /** Replaces the empty line (the settings page's empty state with its buttons). */
  readonly empty?: JSX.Element
  /** The folder is not known yet (a page that just opened): the loading line, not "no project is open". */
  readonly pending?: boolean
  /** The kept switches (SG): each row's tag and `되돌리기`. */
  readonly switches?: McpSwitches
}) {
  const i18n = useI18n()
  const text = useMcpListText()
  const state = () => props.mcp.state
  const summary = () => summarize(props.mcp.rows())
  return (
    <div class="flex flex-col gap-3" data-testid="mcp-list">
      <Show
        when={props.mcp.directory()}
        fallback={
          props.pending ? (
            <p class="m-0 text-[12.5px] text-own-muted" data-testid="mcp-pending">
              {text("own.mcp.loading")}
            </p>
          ) : (
            <Notice>{text("own.mcp.noProject")}</Notice>
          )
        }
      >
        <Show when={state().error}>
          <Notice tone="danger" testid="mcp-load-failed">
            <p class="m-0">{text("own.mcp.loadFailed")}</p>
            <p class="own-mono m-0 mt-1 text-[12px] break-all text-own-muted">{state().error}</p>
            <button type="button" class="own-btn mt-2" data-size="sm" onClick={() => props.mcp.refresh()}>
              {text("own.mcp.retry")}
            </button>
          </Notice>
        </Show>
        <Show
          when={props.mcp.loaded()}
          fallback={
            <Show when={!state().error}>
              <p class="m-0 text-[12.5px] text-own-muted">{text("own.mcp.loading")}</p>
            </Show>
          }
        >
          <Show
            when={props.mcp.rows().length}
            fallback={
              props.empty ?? (
                <p class="m-0 text-[12.5px] text-own-muted" data-testid="mcp-empty">
                  {text("own.mcp.empty")}
                </p>
              )
            }
          >
            <p class="m-0 text-[12px] text-own-faint" data-testid="mcp-count">
              {text("own.mcp.count", { connected: summary().connected, total: summary().total })}
            </p>
            <p class="m-0 text-[12px] text-own-muted">{i18n.t("own.mcp.toggleCache")}</p>
            <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
              <For each={props.mcp.rows()}>
                {(row) => <McpServerRow row={row} mcp={props.mcp} details={props.details} switches={props.switches} />}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
      <SignInDialog mcp={props.mcp} />
    </div>
  )
}

function McpServerRow(props: {
  readonly row: McpRow
  readonly mcp: McpServers
  readonly details?: (row: McpRow) => JSX.Element
  readonly switches?: McpSwitches
}) {
  const i18n = useI18n()
  const text = useMcpListText()
  const busy = () => !!props.mcp.state.busy[props.row.name]
  const tag = () => {
    const overrides = props.switches?.overrides()
    return overrides === undefined ? undefined : exceptionTag(overrides, props.row.name, props.mcp.directory())
  }
  const on = () => switchedOn(props.row.status)
  const failure = () => props.mcp.state.failure[props.row.name]
  const locked = () => busy() || props.row.status === "pending"
  return (
    <li
      class="flex flex-col gap-1.5 px-3 py-2.5"
      data-testid="mcp-row"
      data-name={props.row.name}
      data-status={props.row.status}
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="own-mono min-w-0 flex-1 truncate text-[13px]" title={props.row.name}>
          {props.row.name}
        </span>
        <Show when={!props.row.codemode}>
          <Tag tone="dashed" testid="mcp-direct">
            {text("own.mcp.direct")}
          </Tag>
        </Show>
        <Show when={props.switches?.projectOnly(props.row.name)}>
          <Tag tone="soft" testid="mcp-project-only">
            {text("own.mcp.tag.here")}
          </Tag>
        </Show>
        <Show when={tag()}>
          {(current) => (
            <>
              <Tag tone={current().kind === "onlyHere" ? "ok" : "warn"} testid="mcp-tag">
                <span data-kind={current().kind}>{text(`own.mcp.tag.${current().kind}`)}</span>
              </Tag>
              <Show when={current().kind !== "offAll" && props.switches?.canReset()}>
                <button
                  type="button"
                  class="own-btn own-target"
                  data-size="sm"
                  aria-label={text("own.mcp.revertLabel", { name: props.row.name })}
                  disabled={busy()}
                  data-testid="mcp-revert"
                  onClick={() => props.mcp.reset(props.row.name, current().directory)}
                >
                  {text("own.mcp.revert")}
                </button>
              </Show>
            </>
          )}
        </Show>
        <Tag tone={TONE[props.row.status]} testid="mcp-status">
          <Show when={props.row.status === "pending" || busy()}>
            <Spinner />{" "}
          </Show>
          {i18n.t(`own.mcp.status.${props.row.status}`)}
        </Tag>
        <Show when={props.row.status === "needs_auth"}>
          <button
            type="button"
            class="own-btn own-target"
            data-size="sm"
            data-testid="mcp-login"
            disabled={props.mcp.state.signIn?.server === props.row.name && props.mcp.state.signIn?.phase === "starting"}
            onClick={() => props.mcp.signIn(props.row.name)}
          >
            {i18n.t("own.mcp.login")}
          </button>
        </Show>
        <ToggleSwitch
          checked={on()}
          label={text("own.mcp.toggleLabel", { name: props.row.name })}
          busy={locked()}
          testid="mcp-toggle"
          onChange={(checked) => props.mcp.setEnabled(props.row.name, checked)}
        />
      </div>
      <Show when={!props.row.codemode}>
        <p class="m-0 text-[12px] text-own-warn">{i18n.t("own.mcp.toggleCacheDirect")}</p>
      </Show>
      <Show when={props.row.error && (props.row.status === "failed" || props.row.status === "needs_auth")}>
        <details class="text-[12px] text-own-muted" data-testid="mcp-error">
          <summary class="cursor-pointer select-none">{text("own.mcp.errorDetails")}</summary>
          <pre class="own-mono m-0 mt-1 max-h-40 overflow-auto rounded bg-own-subtle p-2 text-[11.5px] whitespace-pre-wrap break-all">
            {props.row.error}
          </pre>
        </details>
      </Show>
      <Show when={failure()}>
        {(message) => (
          <p class="m-0 text-[12px] text-own-danger" role="alert">
            {text("own.mcp.toggleFailed", { name: props.row.name, message: message() })}
          </p>
        )}
      </Show>
      {props.details?.(props.row)}
    </li>
  )
}

function SignInDialog(props: { readonly mcp: McpServers }) {
  const text = useMcpListText()
  const i18n = useI18n()
  const signIn = () => props.mcp.state.signIn
  return (
    <Dialog
      open={signIn() !== undefined}
      title={text("own.mcp.signIn.title", { name: signIn()?.server ?? "" })}
      onClose={() => props.mcp.closeSignIn()}
      testid="mcp-signin"
      footer={
        <>
          <Show when={signIn()?.phase === "waiting"}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-testid="mcp-signin-check"
              onClick={() => props.mcp.checkSignIn()}
            >
              {text("own.mcp.signIn.check")}
            </button>
          </Show>
          <Show when={signIn()?.phase === "failed" || signIn()?.phase === "expired"}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              onClick={() => {
                const server = signIn()?.server
                if (server) props.mcp.signIn(server)
              }}
            >
              {text("own.mcp.signIn.retry")}
            </button>
          </Show>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant={signIn()?.phase === "done" ? "primary" : undefined}
            onClick={() => props.mcp.closeSignIn()}
          >
            {signIn()?.phase === "done" ? i18n.t("own.kit.close") : text("own.mcp.cancel")}
          </button>
        </>
      }
    >
      <Show when={signIn()}>
        {(state) => (
          <div class="flex flex-col gap-2" data-testid="mcp-signin-body" data-phase={state().phase}>
            <Show when={state().phase === "starting"}>
              <p class="m-0">
                <Spinner /> {text("own.mcp.signIn.starting")}
              </p>
            </Show>
            <Show when={state().phase === "waiting"}>
              <p class="m-0" role="status">
                <Spinner /> {text("own.mcp.signIn.waiting")}
              </p>
              <Show when={state().url}>
                {(url) => (
                  <a
                    class="text-[12.5px] text-own-accent-text underline"
                    href={url()}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="mcp-signin-link"
                  >
                    {text("own.mcp.signIn.link")}
                  </a>
                )}
              </Show>
            </Show>
            <Show when={state().phase === "done"}>
              <Notice tone="ok" testid="mcp-signin-done">
                {text("own.mcp.signIn.done", { name: state().server })}
              </Notice>
            </Show>
            <Show when={state().phase === "expired"}>
              <Notice tone="warn">{text("own.mcp.signIn.expired")}</Notice>
            </Show>
            <Show when={state().phase === "failed"}>
              <Notice tone="danger" testid="mcp-signin-failed">
                {state().refused
                  ? text(`own.mcp.signIn.refused.${state().refused!}`)
                  : text("own.mcp.signIn.failed", { message: state().message ?? "" })}
              </Notice>
            </Show>
          </div>
        )}
      </Show>
    </Dialog>
  )
}
