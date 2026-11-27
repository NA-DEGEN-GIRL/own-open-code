// 설정 > 자동 압축 > 자리를 비운 사이 압축 (02 §4.7.7, 03 §5.8.4, CC 2026-10-24): the opt-in, off by default, on this
// PC's service (`policy.compaction.idle` through `policy.get`/`policy.set`), with each provider's cache lifetime and
// the break-even explanation. own-accounts decides at fire time (switching/idle-compaction.ts); this only shows and
// switches the setting. A connection without `policy.set` shows it read-only.
import { CompactionCache } from "@own/protocol/compaction-cache"
import { For, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { errorMessage } from "@/accounts/errors"
import { grouped } from "@/limits/format"
import { createStatus, Segmented, StatusLine } from "@/limits/kit"
import { policyState, updatePolicy } from "@/limits/shared"
import { useIdleCompactionText, type IdleCompactionKey } from "./idle-compaction-strings"

type Mode = "off" | "on"

const TTL_ROWS: ReadonlyArray<readonly [IdleCompactionKey, IdleCompactionKey]> = [
  ["own.idle.ttl.oai", "own.idle.ttl.oaiValue"],
  ["own.idle.ttl.anth", "own.idle.ttl.anthValue"],
  ["own.idle.ttl.codex", "own.idle.ttl.codexValue"],
  ["own.idle.ttl.ds", "own.idle.ttl.dsValue"],
  ["own.idle.ttl.others", "own.idle.ttl.othersValue"],
]

export function IdleCompactionSection() {
  const i18n = useI18n()
  const text = useIdleCompactionText()
  const own = useData().local().own
  const status = createStatus()
  const idle = () => policyState()?.policy.compaction?.idle
  /** `policy.awayDetect`: how long after the last report from a screen showing the conversation it counts as away. */
  const away = () => policyState()?.policy.awayDetect
  const mode = (): Mode => (idle()?.enabled === true ? "on" : "off")
  const writable = () => own.rpc.allowed("policy.set")
  const numbers = () => ({
    tokens: grouped(idle()?.minTokens ?? CompactionCache.IDLE.minTokens),
    minutes: idle()?.minIdleMinutes ?? CompactionCache.IDLE.minIdleMinutes,
  })

  const pick = (next: Mode) => {
    if (next === mode()) return
    status.clear()
    void own.rpc
      .call("policy.set", { patch: { compaction: { idle: { enabled: next === "on" } } } })
      .then((output) => {
        updatePolicy(own, output.policy)
        status.ok(text("own.idle.saved"))
      })
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }

  return (
    <section class="own-psec" data-testid="idle-compaction-settings">
      <div class="own-psec-head flex-wrap">
        <h2>{text("own.idle.title")}</h2>
        <div class="ml-auto">
          <Segmented<Mode>
            label={text("own.idle.title")}
            value={mode()}
            options={[
              { value: "off", label: text("own.idle.off"), disabled: !writable() },
              { value: "on", label: text("own.idle.on"), disabled: !writable() },
            ]}
            onChange={pick}
            testid="idle-compaction-mode"
          />
        </div>
      </div>
      <div class="flex flex-col gap-2 text-[13px] leading-[19px]">
        <p class="m-0">{text("own.idle.lead")}</p>
        <p class="m-0 text-own-muted">{text("own.idle.when", numbers())}</p>
        <Show when={away()}>
          {(value) => (
            <p class="m-0 text-own-muted" data-testid="idle-compaction-present">
              {value().enabled
                ? text("own.idle.present", { minutes: value().hiddenMinutes })
                : text("own.idle.presentOff")}
            </p>
          )}
        </Show>
        <p class="m-0 text-own-muted">{text("own.idle.skip")}</p>
        <h3 class="m-0 mt-1 text-[13px] font-semibold">{text("own.idle.ttlTitle")}</h3>
        <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1" data-testid="idle-compaction-ttl">
          <For each={TTL_ROWS}>
            {([name, value]) => (
              <>
                <dt class="text-own-muted">{text(name)}</dt>
                <dd class="m-0">{text(value)}</dd>
              </>
            )}
          </For>
        </dl>
        <p class="m-0 text-[12px] text-own-muted">{text("own.idle.ttl.anthNote", numbers())}</p>
        <p class="m-0 text-[12px] text-own-muted">{text("own.idle.clock")}</p>
        <p class="m-0" data-testid="idle-compaction-break-even">
          {text("own.idle.breakEven")}
        </p>
        <p class="m-0 text-own-muted">{text("own.idle.cost")}</p>
        <Show when={!writable()}>
          <p class="m-0 text-own-muted">{text("own.idle.readOnly")}</p>
        </Show>
      </div>
      <StatusLine status={status} testid="idle-compaction-status" />
    </section>
  )
}
