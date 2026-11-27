// The subagent role guide (07 §2.4, decisions PE): for each role its name and agent id, what it is for, what it may do
// (from `Preset.READ_ONLY_ROLES` and `Preset.NO_SHELL_ROLES`, the lists the permission hooks enforce), and, under a
// preset, where it runs now (`roles.ts` `roleRuns`): model @ account · effort and where that comes from. The editor's
// 자세히 and 설정 > 프리셋 show it with the runs; 설정 > 에이전트 방식 shows the roles alone. Lazy screens only.
import { Preset } from "@own/protocol/preset"
import { For, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { variantName } from "@/switcher/labels"
import { ROLE_PURPOSE, usePresetEffortText, type PresetEffortKey } from "./pe-strings"
import { accessOf, type RoleRun, type RunEffort, type RunSource } from "./roles"
import { useTargetText } from "./target-picker"
import "./presets.css"

const SOURCE: Readonly<Record<RunSource, PresetEffortKey>> = {
  main: "own.pe.source.main",
  role: "own.pe.source.role",
  fallback: "own.pe.source.fallback",
  single: "own.pe.source.single",
  "pool-default": "own.pe.source.poolDefault",
  "pool-main": "own.pe.source.poolMain",
}

/**
 * The roles with where each runs now (`runs`), or the roles alone. `off`: delegation is off, which the guide says
 * first. `title`: the preset the runs are for (설정 > 프리셋 names its ★ preset).
 */
export function RoleGuide(props: {
  readonly runs?: ReadonlyArray<RoleRun>
  readonly off?: boolean
  readonly title?: string
  readonly testid?: string
}) {
  const pe = usePresetEffortText()
  const i18n = useI18n()
  const names = useTargetText()
  const own = useData().local().own
  const rows = () =>
    props.runs ?? Preset.ROLES.map((role): RoleRun => ({ role, access: accessOf(role), named: true, source: "main" }))
  const account = (key: string) => (Preset.isLocal(key) ? names.group(key) : (own.state.accounts[key]?.label ?? key))
  const effort = (value: RunEffort) => {
    if (value.kind === "default") return pe("own.pe.effortDefault")
    if (value.kind === "level") return variantName(i18n, value.level)
    const fixed = pe("own.pe.effortFixed", { level: variantName(i18n, value.level) })
    return value.sent && value.sent !== value.level ? `${fixed} → ${variantName(i18n, value.sent)}` : fixed
  }
  const runsLine = (run: RoleRun) => {
    const ref = run.ref
    if (!ref || !run.account || !run.effort) return pe("own.pe.runsNoMain")
    return pe("own.pe.runs", {
      model: names.model(ref.providerID, ref.id),
      account: account(run.account),
      effort: effort(run.effort),
    })
  }
  return (
    <div class="flex flex-col" data-testid={props.testid ?? "preset-roles"}>
      <Show when={props.title}>
        <span class="own-pe-sub">{props.title}</span>
      </Show>
      <p class="own-pe-hint m-0">{props.off ? pe("own.pe.off") : pe("own.pe.rolesNote")}</p>
      <For each={rows()}>
        {(run) => (
          <div class="own-pe-role" data-role={run.role} data-testid="preset-role">
            <span class="own-pe-role-name">{names.role(run.role)}</span>
            <div class="own-pe-role-body">
              <span>
                {pe(ROLE_PURPOSE[run.role])} <code class="own-mono text-[11.5px] text-own-muted">{run.role}</code>
              </span>
              <span class="own-pe-sub" data-testid="preset-role-access" data-access={run.access}>
                {pe(`own.pe.access.${run.access}`)}
              </span>
              <Show when={props.runs}>
                <span data-testid="preset-role-runs" data-source={run.source}>
                  {runsLine(run)}
                </span>
                <span class="own-pe-sub">{pe(SOURCE[run.source])}</span>
                <Show when={!run.named && !props.off}>
                  <span class="own-pe-sub" data-testid="preset-role-unnamed">
                    {pe("own.pe.unnamed")}
                  </span>
                </Show>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
