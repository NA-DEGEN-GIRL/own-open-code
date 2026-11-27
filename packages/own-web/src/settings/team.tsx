// Settings > 팀 (06 §9.8, §0.3, §10.1, §12.2; 03 §5.7), lazy. One team at a time: the team the route names
// (`openTeamSettings` from the summary card's auto-allow `[바꾸기]` and the project menu, routing/routes.ts), else the
// team of the folder on screen, else the first team that is on; a picker when the server has more than one. Rows:
// first 영역과 직접 일할 때 (2026-11-14, feature `direct`): 내가 영역에서 직접 일하면 메인은 기다리기 (`directHold`, on
// by default) and 직접 시킨 일을 메인에게 알리기 (`directTell`: 내가 말할 때만 / 담당이 판단 / 항상); then
// 반영하기 전에 묻기 (`mergeLocal`: on, applying an area waits for a confirm, 7.2), the commands owners
// run without asking (06 §10.1) with the switch that turns them off, the confirm thresholds (500 MB download, 2 GB
// disk), 결정 기록을 프로젝트에 남기기 (`commitDecisions`: on, the main keeps a copy of each record in the project, 6.6)
// and the extra path patterns of other tools' work folders. Every row takes effect at once. 영역 폴더 위치 (2026-10-27,
// 06 §4.12) only shows where the team keeps its area folders: it is chosen when team mode is turned on. Area mains and presets are
// chosen per area (10.1) and presets are made in settings 프리셋 (07 §7.1). There is nothing about conversation size or
// summaries (U6, 06 §6.1). Last, under 고급, 팀 지시문 (feature `instructions`) opens settings/team-instructions.tsx
// (lazy) in place of the rows. The area limit row went with the limit (2026-11-14).
// Reads `settings.get` again whenever the team's `rev` moves; writes `settings.set` (`local` scope): a gateway device
// sees the values and the view-only notice instead of the controls.
import type { OwnTeam } from "@own/protocol/rpc-team"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  Match,
  on,
  Show,
  Suspense,
  Switch,
  untrack,
} from "solid-js"
import { LOCAL, useData, type TeamInput, type TeamStore } from "@/data"
import { useI18n } from "@/i18n"
import { createStatus, Notice, Segmented, StatusLine, TextField } from "@/limits/kit"
import { ManualLink } from "@/manual/link"
import { activeDirectory } from "@/projects/active"
import { baseName } from "@/projects/path"
import { useRouter } from "@/routing/router"
import { teamSettingsRoute, type SettingsTeamTarget } from "@/routing/routes"
import { ToggleSwitch } from "@/shell/switch"
import { errorText, viewOnlyText } from "@/team/model"
import { useTeamText } from "@/team/strings"
import { Setting } from "./sections"

const TeamInstructions = lazy(() => import("./team-instructions"))

/** `OwnTeam.DirectTell`: who tells the main about work the user asked an area for directly (2026-11-14). */
export const DIRECT_TELL = ["none", "judge", "always"] as const
export type DirectTell = (typeof DIRECT_TELL)[number]

/**
 * The effective `directTell` of a stored policy, as own.team reads it: absent or any other value is `judge` (the
 * stored field is an open string, so a later value never makes a team unreadable).
 */
export function directTellOf(policy: Pick<OwnTeam.Policy, "directTell">): DirectTell {
  const value = policy.directTell
  return value === "none" || value === "always" ? value : "judge"
}

/** The thresholds' units: binary, like the defaults (`OwnTeam.POLICY`: 500 MiB, 2 GiB). */
export const UNITS = { MB: 1024 ** 2, GB: 1024 ** 3 } as const
export type Unit = keyof typeof UNITS

/** Read-only Git commands that never ask (06 §10.1); own.team's permission hook allows exactly these subcommands. */
export const READ_ONLY_GIT = ["git status", "git diff", "git log", "git show", "git rev-parse"] as const

/** `OwnTeam.SettingsPatch.patterns`: at most 64, each 1–256 characters. */
export const PATTERN_LIMIT = 64
export const PATTERN_LENGTH = 256

/** A threshold in the field's unit: whole when exact, else at most two decimals. */
export function thresholdText(bytes: number, unit: Unit) {
  return String(Math.round((bytes / UNITS[unit]) * 100) / 100)
}

/** The bytes of a typed threshold: a number of 0 or more (decimals allowed), else `undefined`. */
export function parseThreshold(text: string, unit: Unit) {
  const value = text.trim()
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined
  const bytes = Math.round(Number(value) * UNITS[unit])
  return Number.isSafeInteger(bytes) ? bytes : undefined
}

/** A team command as one line: `{argv}` joined (a word with spaces quoted), `{shell}` as written. */
export function commandText(command: OwnTeam.Command) {
  if ("shell" in command) return command.shell
  return command.argv.map((word) => (/\s/.test(word) ? JSON.stringify(word) : word)).join(" ")
}

/**
 * Where the team keeps its area folders (06 §4.12, 2026-10-27): `<main folder>/.worktrees` is 프로젝트 안, any other
 * place (`<name>-team`, `<drive>:/own-team/<repository>`) beside the project.
 */
export function areaRootOf(worktreeRoot: string): OwnTeam.AreaRoot {
  return baseName(worktreeRoot.replace(/[\\/]+$/, "")) === ".worktrees" ? "inside" : "beside"
}

/** A recorded folder as the OS writes it: own-team keeps drive-letter folders with forward slashes. */
function displayPath(directory: string) {
  return /^[A-Za-z]:/.test(directory) ? directory.replaceAll("/", "\\") : directory
}

export type PatternProblem = "empty" | "long" | "duplicate" | "full"

/** The pattern list with `value` added at the end, or why it cannot be added. */
export function addPattern(
  list: readonly string[],
  value: string,
): { readonly patterns: string[] } | { readonly problem: PatternProblem } {
  const pattern = value.trim()
  if (!pattern) return { problem: "empty" }
  if (pattern.length > PATTERN_LENGTH) return { problem: "long" }
  if (list.includes(pattern)) return { problem: "duplicate" }
  if (list.length >= PATTERN_LIMIT) return { problem: "full" }
  return { patterns: [...list, pattern] }
}

export default function TeamSettings(props: { readonly target?: SettingsTeamTarget }) {
  const data = useData()
  const i18n = useI18n()
  const text = useTeamText()
  const router = useRouter()
  const serverKey = () => props.target?.serverKey ?? LOCAL
  const runtime = () => data.get(serverKey())
  const store = () => runtime()?.team
  createEffect(() => {
    const current = store()
    if (current) untrack(() => current.ensure())
  })
  /** Teams that are on, in `team.list` order. */
  const teams = createMemo(() => {
    const current = store()
    if (!current) return []
    return current.state.list.flatMap((item) => {
      const entry = current.state.teams[item.id]
      return entry ? [entry] : []
    })
  })
  const selected = createMemo(() => {
    const named = props.target?.teamID
    const list = teams()
    const current = runtime()
    const directory = current ? activeDirectory(current, router.route()) : undefined
    const here = directory ? current?.team.teamOfDirectory(directory) : undefined
    return list.find((entry) => entry.team.id === named) ?? list.find((entry) => entry === here) ?? list[0]
  })
  const choose = (teamID: string) =>
    router.navigate(teamSettingsRoute({ serverKey: serverKey(), teamID }), { replace: true })

  return (
    <div class="flex flex-col" data-testid="settings-team">
      <p class="m-0 text-[13px] leading-5 text-own-muted">{text("own.team.settings.intro")}</p>
      <Switch fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
        <Match when={!store()}>
          <p class="own-placeholder px-0">{text("own.team.error.unavailable")}</p>
        </Match>
        <Match when={store()?.state.load === "missing" || store()?.state.load === "unmanaged"}>
          <p class="own-placeholder px-0">{text("own.team.error.unavailable")}</p>
        </Match>
        <Match when={store()?.state.load === "unavailable"}>
          <p class="own-placeholder px-0">{text("own.team.error.network")}</p>
        </Match>
        <Match when={store()?.state.load === "ready" && !store()?.has("settings")}>
          <p class="own-placeholder px-0">{text("own.team.error.unsupported")}</p>
        </Match>
        <Match when={store()?.state.load === "ready" && teams().length === 0}>
          <p class="own-placeholder px-0" data-testid="settings-team-none">
            {text("own.team.settings.none")}
          </p>
          <p class="m-0 text-[12.5px] text-own-muted">{i18n.t("own.set.team.noneHow")}</p>
          <ManualLink place="teamEnable" label="own.discover.manual.team" class="mt-1 self-start" />
        </Match>
        <Match when={store()?.state.load === "ready" && store()}>
          {(current) => (
            <>
              <Setting title={text("own.team.settings.project")}>
                <Show
                  when={teams().length > 1}
                  fallback={
                    <span
                      class="text-[13px]"
                      title={selected()?.team.home.directory}
                      data-testid="settings-team-project"
                    >
                      {baseName(selected()?.team.home.directory ?? "")}
                    </span>
                  }
                >
                  <Segmented
                    label={text("own.team.settings.project")}
                    value={selected()?.team.id ?? ""}
                    options={teams().map((entry) => ({
                      value: entry.team.id,
                      label: baseName(entry.team.home.directory),
                    }))}
                    onChange={choose}
                    testid="settings-team-project"
                  />
                </Show>
              </Setting>
              {/* Its own boundary: the first read of another team keeps the project picker on screen. */}
              <Suspense fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
                <Show when={selected()?.team.id} keyed>
                  {(teamID) => <TeamForm store={current()} teamID={teamID} pc={runtime()?.entry()?.pc} />}
                </Show>
              </Suspense>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

function TeamForm(props: {
  readonly store: TeamStore
  readonly teamID: OwnTeam.TeamID
  /** The PC the service runs on, as the gateway names it to a device (06 §9.8). */
  readonly pc?: string
}) {
  const i18n = useI18n()
  const text = useTeamText()
  const status = createStatus()
  const [busy, setBusy] = createSignal(false)
  const [instructions, setInstructions] = createSignal(false)
  const [settings, { mutate, refetch }] = createResource(
    () => props.store.team(props.teamID)?.team.rev,
    () => props.store.rpc.call("settings.get", { teamID: props.teamID }),
  )
  const writable = () => props.store.rpc.allowed("settings.set")

  /**
   * `settings.set`; the answer's team is what the page shows until the next read. 팀 지시문 live outside the team
   * record, so a save of them reads the settings again.
   */
  async function save(patch: TeamInput<"settings.set">["patch"]) {
    status.clear()
    setBusy(true)
    const saved = await props.store.rpc.call("settings.set", { teamID: props.teamID, patch }).then(
      async (output) => {
        mutate(
          (before) =>
            before && {
              ...before,
              policy: output.team.policy,
              commands: output.team.commands,
              patterns: output.team.patterns,
            },
        )
        if (patch.instructions) await refetch()
        status.ok(text("own.team.settings.saved"))
        return true
      },
      (error: unknown) => {
        status.error(text("own.team.settings.saveFailed", { reason: errorText(text, error) }))
        return false
      },
    )
    setBusy(false)
    return saved
  }

  return (
    <Switch fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
      <Match when={settings.error}>
        {(error) => (
          <p class="own-placeholder px-0" role="alert">
            {errorText(text, error())}
          </p>
        )}
      </Match>
      <Match when={settings.latest}>
        {(current) => (
          <div class="flex flex-col" data-testid="settings-team-form">
            <Show when={!writable()}>
              <div class="mt-2">
                <Notice testid="settings-team-view-only">{viewOnlyText(text, "settings", props.pc)}</Notice>
              </div>
            </Show>
            <Show when={instructions() && current().instructions}>
              {(view) => (
                <Suspense fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
                  <TeamInstructions
                    view={view()}
                    writable={writable()}
                    busy={busy()}
                    onSave={save}
                    onClose={() => setInstructions(false)}
                  />
                </Suspense>
              )}
            </Show>
            <Show when={!(instructions() && current().instructions)}>
              <Show when={props.store.has("direct")}>
                <section class="mt-3 flex flex-col" data-testid="settings-team-direct">
                  <h3 class="m-0 text-[12.5px] font-semibold text-own-muted">
                    {text("own.team.settings.directGroup")}
                  </h3>
                  <Setting title={text("own.team.settings.directHold")} note={text("own.team.settings.directHoldHint")}>
                    <Toggle
                      label={text("own.team.settings.directHold")}
                      on={current().policy.directHold !== false}
                      writable={writable()}
                      busy={busy()}
                      onChange={(on) => void save({ policy: { directHold: on } })}
                      testid="settings-team-direct-hold"
                    />
                  </Setting>
                  <Setting title={text("own.team.settings.directTell")} note={text("own.team.settings.directTellHint")}>
                    <Show
                      when={writable()}
                      fallback={
                        <span class="text-[13px]" data-testid="settings-team-direct-tell">
                          {text(`own.team.settings.directTell.${directTellOf(current().policy)}`)}
                        </span>
                      }
                    >
                      <Segmented
                        label={text("own.team.settings.directTell")}
                        value={directTellOf(current().policy)}
                        options={DIRECT_TELL.map((value) => ({
                          value,
                          label: text(`own.team.settings.directTell.${value}`),
                        }))}
                        onChange={(value) => {
                          if (!busy()) void save({ policy: { directTell: value } })
                        }}
                        testid="settings-team-direct-tell"
                      />
                    </Show>
                  </Setting>
                </section>
                <div class="mt-3" />
              </Show>
              <Show when={props.store.team(props.teamID)?.team.worktreeRoot}>
                {(root) => (
                  <Setting title={text("own.team.settings.areaRoot")} note={text("own.team.settings.areaRootHint")}>
                    <span class="flex min-w-0 flex-col items-end text-right" data-testid="settings-team-area-root">
                      <span class="text-[13px]">{text(`own.team.settings.areaRoot.${areaRootOf(root())}`)}</span>
                      <span class="max-w-[320px] font-mono text-[11.5px] break-all text-own-muted">
                        {displayPath(root())}
                      </span>
                    </span>
                  </Setting>
                )}
              </Show>
              <Setting title={text("own.team.settings.mergeAsk")} note={text("own.team.settings.mergeAskHint")}>
                <Toggle
                  label={text("own.team.settings.mergeAsk")}
                  on={current().policy.mergeLocal === "ask"}
                  writable={writable()}
                  busy={busy()}
                  onChange={(on) => void save({ policy: { mergeLocal: on ? "ask" : "auto" } })}
                  testid="settings-team-merge-ask"
                />
              </Setting>

              <div class="border-b border-own-border py-3" data-testid="settings-team-commands">
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <div class="min-w-[220px] flex-1">
                    <b class="block text-[13.5px] font-semibold">{text("own.team.settings.autoAllow")}</b>
                    <span class="text-[12px] text-own-muted">{text("own.team.settings.autoAllowHint")}</span>
                  </div>
                  <Toggle
                    label={text("own.team.settings.autoAllow")}
                    on={current().policy.autoAllow}
                    writable={writable()}
                    busy={busy()}
                    onChange={(on) => void save({ policy: { autoAllow: on } })}
                    testid="settings-team-auto-allow"
                  />
                </div>
                <Show when={!current().policy.autoAllow}>
                  <p class="m-0 mt-2 text-[12.5px] text-own-warn" data-testid="settings-team-auto-allow-off">
                    {text("own.team.settings.autoAllowOff")}
                  </p>
                </Show>
                <dl
                  class="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]"
                  classList={{ "opacity-60": !current().policy.autoAllow }}
                >
                  <dt class="text-own-muted">{text("own.team.settings.commands.setup")}</dt>
                  <dd class="m-0 min-w-0 break-all font-mono">
                    <Show when={current().commands.setup} fallback={text("own.team.settings.commands.none")}>
                      {(setup) => commandText(setup())}
                    </Show>
                  </dd>
                  <dt class="text-own-muted">{text("own.team.settings.commands.code")}</dt>
                  <dd class="m-0 min-w-0 break-all font-mono">
                    <Show when={current().commands.code.length} fallback={text("own.team.settings.commands.none")}>
                      <For each={current().commands.code}>
                        {(command) => <span class="block">{commandText(command)}</span>}
                      </For>
                    </Show>
                  </dd>
                  <dt class="text-own-muted">{text("own.team.settings.readOnlyGit")}</dt>
                  <dd class="m-0 min-w-0 break-all font-mono">{READ_ONLY_GIT.join(", ")}</dd>
                </dl>
              </div>

              <ThresholdRow
                title={text("own.team.settings.askDownload")}
                bytes={current().policy.askDownloadBytes}
                unit="MB"
                writable={writable()}
                onSave={(bytes) => save({ policy: { askDownloadBytes: bytes } })}
                testid="settings-team-ask-download"
              />
              <ThresholdRow
                title={text("own.team.settings.askDisk")}
                bytes={current().policy.askDiskBytes}
                unit="GB"
                writable={writable()}
                onSave={(bytes) => save({ policy: { askDiskBytes: bytes } })}
                testid="settings-team-ask-disk"
              />
              <Setting
                title={text("own.team.settings.commitDecisions")}
                note={text("own.team.settings.commitDecisionsHint")}
              >
                <Toggle
                  label={text("own.team.settings.commitDecisions")}
                  on={current().policy.commitDecisions}
                  writable={writable()}
                  busy={busy()}
                  onChange={(on) => void save({ policy: { commitDecisions: on } })}
                  testid="settings-team-commit-decisions"
                />
              </Setting>
              <PatternList
                patterns={current().patterns}
                writable={writable()}
                busy={busy()}
                onSave={(patterns) => save({ patterns })}
              />
              <Show when={props.store.has("instructions") && current().instructions}>
                {(view) => (
                  <section class="mt-3 flex flex-col" data-testid="settings-team-advanced">
                    <h3 class="m-0 text-[12.5px] font-semibold text-own-muted">{text("own.team.settings.advanced")}</h3>
                    <button
                      type="button"
                      class="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 border-0 border-b border-own-border bg-transparent px-0 py-3 text-left text-own-text hover:bg-own-hover"
                      data-testid="settings-team-instructions-open"
                      onClick={() => setInstructions(true)}
                    >
                      <span class="min-w-[220px] flex-1">
                        <b class="block text-[13.5px] font-semibold">{text("own.team.settings.instructions")}</b>
                        <span class="text-[12px] text-own-muted">{text("own.team.settings.instructionsHint")}</span>
                      </span>
                      <span class="text-[12.5px] text-own-muted" data-testid="settings-team-instructions-state">
                        {text(
                          ROLE_KEYS.some((role) => view()[role].custom !== undefined)
                            ? "own.team.settings.instructions.custom"
                            : "own.team.settings.instructions.standard",
                        )}{" "}
                        ›
                      </span>
                    </button>
                  </section>
                )}
              </Show>
            </Show>
            <div class="mt-2">
              <StatusLine status={status} testid="settings-team-status" />
            </div>
          </div>
        )}
      </Match>
    </Switch>
  )
}

/** The roles 팀 지시문 has a block for. */
const ROLE_KEYS = ["main", "owner", "peer"] as const

/** A switch (`role="switch"`); on a gateway device the state as words instead. */
function Toggle(props: {
  readonly label: string
  readonly on: boolean
  readonly writable: boolean
  readonly busy: boolean
  readonly onChange: (on: boolean) => void
  readonly testid: string
}) {
  const i18n = useI18n()
  return (
    <Show
      when={props.writable}
      fallback={
        <span class="text-[13px]" data-testid={props.testid}>
          {i18n.t(props.on ? "own.set.state.on" : "own.set.state.off")}
        </span>
      }
    >
      <ToggleSwitch
        checked={props.on}
        label={props.label}
        busy={props.busy}
        testid={props.testid}
        onChange={props.onChange}
      />
    </Show>
  )
}

/** A confirm threshold (06 §0.3, §4.6): saved on Enter or when the field loses focus, if it changed and is valid. */
function ThresholdRow(props: {
  readonly title: string
  readonly bytes: number
  readonly unit: Unit
  readonly writable: boolean
  readonly onSave: (bytes: number) => Promise<boolean>
  readonly testid: string
}) {
  const i18n = useI18n()
  const [draft, setDraft] = createSignal(thresholdText(props.bytes, props.unit))
  // A new stored value (this field's save, another client's change) replaces the draft; a save of another row or a
  // re-read that keeps the value does not, so typing in this field is never undone.
  const stored = createMemo(() => props.bytes)
  createEffect(on(stored, (bytes) => setDraft(thresholdText(bytes, props.unit)), { defer: true }))
  const invalid = () => parseThreshold(draft(), props.unit) === undefined
  const commit = () => {
    const bytes = parseThreshold(draft(), props.unit)
    if (bytes === undefined || bytes === props.bytes) return
    void props.onSave(bytes)
  }
  return (
    <Setting title={props.title}>
      <Show
        when={props.writable}
        fallback={
          <span class="text-[13px]" data-testid={props.testid}>
            {thresholdText(props.bytes, props.unit)} {props.unit}
          </span>
        }
      >
        <span class="flex items-start gap-2">
          <TextField
            label={props.title}
            hideLabel
            value={draft()}
            onValue={setDraft}
            onEnter={commit}
            onBlur={commit}
            inputMode="decimal"
            class="w-24 text-right"
            error={invalid() ? i18n.t("own.set.teamThreshold.invalid") : undefined}
            testid={props.testid}
          />
          <span class="pt-1.5 text-[13px] text-own-muted">{props.unit}</span>
        </span>
      </Show>
    </Setting>
  )
}

/** The team's extra path patterns of other tools' work folders (06 §3.2); the built-in ones are not listed. */
function PatternList(props: {
  readonly patterns: readonly string[]
  readonly writable: boolean
  readonly busy: boolean
  readonly onSave: (patterns: string[]) => Promise<boolean>
}) {
  const i18n = useI18n()
  const text = useTeamText()
  const [draft, setDraft] = createSignal("")
  const [problem, setProblem] = createSignal<PatternProblem>()
  const add = async () => {
    if (props.busy) return
    const result = addPattern(props.patterns, draft())
    if ("problem" in result) {
      setProblem(result.problem === "empty" ? undefined : result.problem)
      return
    }
    if (await props.onSave(result.patterns)) setDraft("")
  }
  const problemText = () => {
    const current = problem()
    if (current === "long") return i18n.t("own.set.teamPattern.long", { n: PATTERN_LENGTH })
    if (current === "duplicate") return i18n.t("own.set.teamPattern.duplicate")
    if (current === "full") return i18n.t("own.set.teamPattern.full", { n: PATTERN_LIMIT })
    return undefined
  }
  return (
    <div class="border-b border-own-border py-3" data-testid="settings-team-patterns">
      <b class="block text-[13.5px] font-semibold">{text("own.team.settings.patterns")}</b>
      <span class="text-[12px] text-own-muted">{text("own.team.settings.patternsHint")}</span>
      <ul class="m-0 mt-2 flex list-none flex-col gap-1 p-0">
        <For
          each={props.patterns}
          fallback={<li class="text-[12.5px] text-own-muted">{text("own.team.settings.commands.none")}</li>}
        >
          {(pattern) => (
            <li class="flex items-center gap-2 text-[12.5px]" data-testid="settings-team-pattern">
              <span class="min-w-0 flex-1 break-all font-mono">{pattern}</span>
              <Show when={props.writable}>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  aria-disabled={props.busy}
                  onClick={() => {
                    if (!props.busy) void props.onSave(props.patterns.filter((item) => item !== pattern))
                  }}
                >
                  {text("own.team.settings.patternRemove")}
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.writable}>
        <div class="mt-2 flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <TextField
              label={text("own.team.settings.patternAdd")}
              hideLabel
              value={draft()}
              onValue={(value) => {
                setDraft(value)
                setProblem(undefined)
              }}
              onEnter={() => void add()}
              error={problemText()}
              testid="settings-team-pattern-input"
            />
          </div>
          <button
            type="button"
            class="own-btn"
            disabled={!draft().trim()}
            aria-disabled={props.busy}
            data-testid="settings-team-pattern-add"
            onClick={() => void add()}
          >
            {text("own.team.settings.patternAdd")}
          </button>
        </div>
      </Show>
    </div>
  )
}
