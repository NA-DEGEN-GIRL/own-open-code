// Parts of 설정 > MCP 서버 that the page and its add form share (03 §18.14, SM 2026-10-24): the line of a connection
// test and the words of a refused `mcp.*` call. Lazy chunks only.
import { Show } from "solid-js"
import { errorData, errorType } from "@/accounts/errors"
import { toolNames, type Check } from "./manage-model"
import { useMcpManageText, type McpManageKey } from "./manage-strings"

/** The tools of the last connection test, or why it failed (with the server's own words folded). */
export function CheckLine(props: {
  readonly check: Check | "testing" | undefined
  readonly time: (at: number) => string
}) {
  const text = useMcpManageText()
  const done = () => (props.check === "testing" ? undefined : props.check)
  return (
    <Show when={done()}>
      {(check) => (
        <Show
          when={check().ok}
          fallback={
            <div class="flex flex-col gap-0.5" data-testid="mcp-check" data-ok="false">
              <span class="text-own-danger">
                {text("own.mcpm.check.failed")}: {failureText(text, check())} ·{" "}
                {text("own.mcpm.checkedAt", { time: props.time(check().at) })}
              </span>
              <Show when={check().error}>
                <details>
                  <summary class="cursor-pointer select-none">{text("own.mcpm.errorText")}</summary>
                  <pre class="own-mono m-0 mt-1 max-h-40 overflow-auto rounded bg-own-subtle p-2 text-[11.5px] whitespace-pre-wrap break-all">
                    {check().error}
                  </pre>
                </details>
              </Show>
            </div>
          }
        >
          <span class="break-words" data-testid="mcp-check" data-ok="true" data-tools={check().tools.length}>
            {toolsText(text, check())} · {text("own.mcpm.checkedAt", { time: props.time(check().at) })}
          </span>
        </Show>
      )}
    </Show>
  )
}

type Text = ReturnType<typeof useMcpManageText>

function toolsText(text: Text, check: Check) {
  if (check.tools.length === 0) return text("own.mcpm.toolsNone")
  const names = toolNames(check)
  const shown = names.shown.join(", ")
  return text("own.mcpm.tools", {
    n: check.tools.length + (check.more ? "+" : ""),
    names: names.more > 0 ? text("own.mcpm.toolsMore", { names: shown, n: names.more }) : shown,
  })
}

export function failureText(text: Text, check: Check) {
  const failure = check.failure ?? "protocol"
  return text(`own.mcpm.failure.${failure}`, { status: check.status ?? "" })
}

const ERRORS = {
  mcp_name_taken: "own.mcpm.error.mcp_name_taken",
  mcp_secret_missing: "own.mcpm.error.mcp_secret_missing",
  mcp_invalid: "own.mcpm.error.mcp_invalid",
  mcp_not_found: "own.mcpm.error.mcp_not_found",
  vault_unavailable: "own.mcpm.error.vault_unavailable",
} as const satisfies Record<string, McpManageKey>

/** A refused `mcp.*` call in words: the declared reason, else the scope, else the message. */
export function errorText(text: Text, error: unknown, name: string) {
  const type = errorType(error)
  const key = type !== undefined && Object.hasOwn(ERRORS, type) ? ERRORS[type as keyof typeof ERRORS] : undefined
  if (key) return text(key, { name: errorData<{ name: string }>(error).name ?? name })
  if (type === "own.scope_denied") return text("own.mcpm.error.scope")
  return text("own.mcpm.error.other", { message: error instanceof Error ? error.message : String(error) })
}
