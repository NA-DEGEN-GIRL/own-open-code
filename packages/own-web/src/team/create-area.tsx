// 영역 만들기 (06 §9.4, 2026-10-26), in the team chunk: the user sets an area up by hand. One dialog for every entry
// point (the team view's `영역 만들기…` row, the project menu, the worktree picker's `새 영역`): 이름 (40), 역할 (200,
// with the role templates), the folder — `새 작업 폴더` with its 폴더·기록 이름 (V6, prefilled from the name, shown as
// `<worktreeRoot>/<slug>`, or as own.team's `area.create.check` names it: `<slug>-2` where a branch or a non-empty
// folder has the name, 2026-10-27) and 시작점 (프로젝트 본 코드 or a live area's work), or `있는 작업 폴더` (a folder the team left
// out, `team.external` `left`) — and, for a new folder only, 모델 (`팀과 같게`, or a pick through the switcher with the
// team's R4 filter, switcher/team-flow.ts `openSwitcherToPick`) and 에이전트 방식 (own.harness `list`; its default
// prompt). It sends the user's own `reorg.apply{teamID, proposal}` with the user-made mark (`withLfs` on an SSH
// host). A `busy` answer keeps the values and says to create it again once the team's other work ended; an
// `invalid_proposal` answer shows the reasons in the dialog. The result card above the team main follows as for any
// reorganization (its `동료 추가…` opens the new area's peer form).
// On an older own.team (a remote one with `reorg.new` but not `area-edit`, TeamStore `createForm` `basic`, 2026-10-27)
// the dialog keeps what that build makes of it, as its 새 영역 did: 이름, 역할 and a new folder (폴더·기록 이름 joined to
// the team's root, 시작점); its lead says why the model, 에이전트 방식, 있는 작업 폴더 and the mark are missing, and
// the proposal carries none of them.
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnHarnessRouting } from "@own/protocol/rpc-harness-routing"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createEffect, createMemo, createResource, createSignal, createUniqueId, For, Show, untrack } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { OwnRpcError } from "@/data/rpc"
import { useI18n } from "@/i18n"
import { isWindowsPath, joinPath } from "@/projects/path"
import { switcherControl } from "@/switcher/control"
import type { TargetRef } from "@/switcher/cost"
import { accountOf, modelName, variantName } from "@/switcher/labels"
import { showToast } from "@/switcher/toast"
import { TeamDialog } from "./confirm"
import { lfsUpload, withLfs } from "./lfs"
import { errorText } from "./model"
import { useTeamText, type TeamKey } from "./strings"
import { RoleTemplates } from "./templates"
import {
  adoptAreaProposal,
  createFolders,
  freeSlug,
  newAreaProposal,
  roleLeft,
  roleMax,
  shortPath,
  slugValid,
} from "./view-model"
import "./team.css"

export interface CreateAreaRequest {
  readonly serverKey: ServerKey
  readonly teamID: OwnTeam.TeamID
}

/** The longest area name (V12). */
const NAME_MAX = 40

const FIELD =
  "w-full rounded-md border border-own-border-input bg-own-bg px-2 py-1 text-[13px] text-own-text outline-offset-[-1px]"
const LABEL = "flex flex-col gap-1 text-[12.5px] text-own-muted"

export default function CreateAreaDialog(props: { readonly request: CreateAreaRequest; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const text = useTeamText()
  const id = createUniqueId()
  const runtime = () => data.get(props.request.serverKey)
  const entry = () => runtime()?.team.team(props.request.teamID)
  /** An older own.team, which would drop the area's model, 에이전트 방식 and mark: the dialog asks for none of them. */
  const basic = () => runtime()?.team.createForm() === "basic"
  /** Every slug the team has (finished areas keep theirs, and their record names). */
  const taken = () => (entry()?.order ?? []).map((areaID) => areaID.slice("ar_".length))
  const [name, setName] = createSignal("")
  const [role, setRole] = createSignal("")
  const [mode, setMode] = createSignal<"new" | "existing">("new")
  /** The folder and record name the user wrote; absent: it follows the name. */
  const [slug, setSlug] = createSignal<string>()
  const [from, setFrom] = createSignal("main")
  const [folder, setFolder] = createSignal<string>()
  /** The model the user picked; absent: 팀과 같게. */
  const [model, setModel] = createSignal<TargetRef>()
  const [harness, setHarness] = createSignal<OwnHarness.HarnessID>()
  const [busy, setBusy] = createSignal(false)
  const [problems, setProblems] = createSignal<readonly string[]>([])
  /** The switcher's open while it picks the model: the dialog steps aside meanwhile. */
  const [pickSeq, setPickSeq] = createSignal<number>()
  const picking = () => pickSeq() !== undefined && switcherControl.state.open?.seq === pickSeq()
  let pickButton: HTMLButtonElement | undefined

  const shownSlug = () => slug() ?? freeSlug(name(), taken())
  const slugProblem = (): TeamKey | undefined => {
    const value = shownSlug()
    if (!slugValid(value)) return "own.team.createArea.slugInvalid"
    return taken().includes(value) ? "own.team.createArea.slugTaken" : undefined
  }
  /**
   * The folder own.team gives the shown name now (`area.create.check`, 2026-10-27): V6 takes `<slug>-2` where a branch
   * or a non-empty folder has the name, which the team's slugs alone cannot tell. An answer for a name no longer shown
   * is dropped; without one (a failure, a service before it) the screen joins the name to the team's root.
   */
  const [checked, setChecked] = createSignal<{
    readonly asked: string
    readonly slug: string
    readonly directory: string
    readonly taken?: "area" | "branch" | "folder"
  }>()
  createEffect(() => {
    const current = runtime()
    const asked = shownSlug()
    // `area.create.check` came with `area-edit`: an older own.team does not know it.
    if (basic() || mode() !== "new" || slugProblem() !== undefined || !current?.team.rpc.allowed("area.create.check"))
      return
    void current.team.rpc
      .call("area.create.check", { teamID: props.request.teamID, slug: asked })
      .then((value) => {
        if (untrack(shownSlug) === asked) setChecked({ ...value, asked })
      })
      .catch(() => undefined)
  })
  const target = () => {
    const value = checked()
    return value?.asked === shownSlug() ? value : undefined
  }
  // own-team records Windows folders with forward slashes; the screen shows them as Windows writes them.
  const shown = (folder: string) => (isWindowsPath(folder) ? folder.replaceAll("/", "\\") : folder)
  const where = () => {
    const found = target()
    if (found) return shown(found.directory)
    const root = entry()?.team.worktreeRoot
    return root ? joinPath(shown(root), shownSlug()) : shownSlug()
  }
  const folders = createMemo(() => {
    const value = entry()
    return value ? createFolders(value) : []
  })
  const starts = createMemo(() => {
    const value = entry()
    if (!value) return []
    return value.order.flatMap((areaID) => {
      const area = value.areas[areaID]
      return area && area.state === "active" ? [{ slug: areaID.slice("ar_".length), name: area.name }] : []
    })
  })
  // A service without own.harness (or a device without the scope) offers no choice: the service's default applies.
  const [list] = createResource(
    () => !basic() && runtime(),
    async (current) =>
      current.harness.allowed("list") ? current.harness.call("list", {}).catch(() => undefined) : undefined,
  )
  const harnessName = (harnessID: OwnHarness.HarnessID) => i18n.t(`own.harness.name.${harnessID}`)
  const modelLabel = () => {
    const ref = model()
    const current = runtime()
    if (!ref || !current) return text("own.team.createArea.model.same")
    const directory = entry()?.team.home.directory
    const effort = ref.variant && ref.variant !== "default" ? ` · ${variantName(i18n, ref.variant)}` : ""
    const account = accountOf(current, ref.providerID)?.label
    return `${modelName(current, ref, directory)}${effort}${account ? ` @ ${account}` : ""}`
  }
  const left = () => roleLeft(role(), roleMax(runtime()?.team.has))
  const ready = () =>
    !busy() &&
    name().trim() !== "" &&
    left() >= 0 &&
    (mode() === "new" ? slugProblem() === undefined : folder() !== undefined)

  async function pickModel() {
    const current = runtime()
    if (!current) return
    // The switcher's team flow loads with its popover chunk.
    const { openSwitcherToPick } = await import("@/switcher/team-flow")
    const seq = openSwitcherToPick({
      serverKey: props.request.serverKey,
      teamID: props.request.teamID,
      ...(model() ? { current: model() } : {}),
      anchor: pickButton,
      onPick: (ref) => {
        setModel(ref ?? undefined)
        requestAnimationFrame(() => pickButton?.focus())
      },
    })
    setPickSeq(seq)
  }

  async function submit() {
    const current = runtime()
    if (!current || !entry() || !ready()) return
    setBusy(true)
    setProblems([])
    const chosen = harness()
    const prompt = list()?.defaultPrompt
    const proposal = basic()
      ? newAreaProposal(name(), role(), taken(), { slug: shownSlug(), from: from() })
      : mode() === "new"
        ? newAreaProposal(name(), role(), taken(), {
            slug: shownSlug(),
            from: from(),
            ...(model() ? { main: model() } : {}),
            ...(chosen && prompt ? { harness: { id: chosen, prompt } } : {}),
            userMade: true,
          })
        : adoptAreaProposal(name(), role(), folder()!, taken())
    try {
      await withLfs(
        () => current.team.rpc.call("reorg.apply", { teamID: props.request.teamID, proposal }),
        lfsUpload(data, props.request.serverKey),
      )
      showToast({ message: text("own.team.createArea.started", { name: name().trim() }) })
      props.onClose()
    } catch (error) {
      setProblems(problemsOf(error))
    } finally {
      setBusy(false)
    }
  }

  /** `busy`: wait for the team's other work; `invalid_proposal`: what own.team refused and why. */
  function problemsOf(error: unknown): readonly string[] {
    if (error instanceof OwnRpcError && error.type === "busy") return [text("own.team.createArea.busy")]
    if (error instanceof OwnRpcError && error.type === "invalid_proposal") {
      const reasons = rejectedOf(error.data)
      if (reasons.length > 0) return reasons.map((why) => text("own.team.createArea.rejected", { why }))
    }
    return [errorText(text, error)]
  }

  return (
    <TeamDialog
      id={id}
      testid="team-create-area"
      role="dialog"
      busy={busy}
      hidden={picking}
      onClose={props.onClose}
      title={text("own.team.createArea.title")}
      actions={
        <>
          <button type="button" class="own-team-btn" disabled={busy()} onClick={() => props.onClose()}>
            {text("own.team.action.cancel")}
          </button>
          <button
            type="button"
            class="own-team-btn"
            data-primary
            disabled={!ready()}
            data-testid="team-create-area-submit"
            onClick={() => void submit()}
          >
            {text("own.team.createArea.submit")}
          </button>
        </>
      }
    >
      <p class="own-team-dialog-body" data-testid="team-create-area-lead">
        {text(basic() ? "own.team.createArea.leadBasic" : "own.team.createArea.lead")}
      </p>
      <label class={LABEL}>
        {text("own.team.createArea.name")}
        <input
          class={FIELD}
          value={name()}
          maxLength={NAME_MAX}
          data-autofocus
          data-testid="team-create-area-name"
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label class={LABEL}>
        {text("own.team.createArea.role")}
        <textarea
          class={`${FIELD} min-h-[64px]`}
          value={role()}
          placeholder={text("own.team.createArea.rolePlaceholder")}
          aria-describedby={`${id}-role-left`}
          aria-invalid={left() < 0}
          data-testid="team-create-area-role"
          onInput={(event) => setRole(event.currentTarget.value)}
        />
      </label>
      <RoleTemplates text={text} onPick={(value) => setRole(value)} />
      <span
        id={`${id}-role-left`}
        class="text-[11.5px]"
        classList={{ "text-own-muted": left() >= 0, "text-own-danger": left() < 0 }}
        aria-live="polite"
        data-testid="team-create-area-role-left"
      >
        {left() < 0
          ? text("own.team.createArea.roleOver", { n: -left() })
          : text("own.team.createArea.roleLeft", { n: left() })}
      </span>
      <Show when={!basic()}>
        <fieldset class="m-0 flex flex-col gap-1 border-0 p-0" data-testid="team-create-area-folder">
          <legend class="mb-1 p-0 text-[12.5px] text-own-muted">{text("own.team.createArea.folder")}</legend>
          <label class="flex items-start gap-2 text-[13px]">
            <input
              type="radio"
              name={`${id}-folder`}
              checked={mode() === "new"}
              data-testid="team-create-area-mode-new"
              onChange={() => setMode("new")}
            />
            <span class="flex flex-col">
              <span>{text("own.team.createArea.folder.new")}</span>
              <span class="text-[11.5px] text-own-muted">{text("own.team.createArea.folder.newHint")}</span>
            </span>
          </label>
          <label class="flex items-start gap-2 text-[13px]">
            <input
              type="radio"
              name={`${id}-folder`}
              checked={mode() === "existing"}
              data-testid="team-create-area-mode-existing"
              onChange={() => setMode("existing")}
            />
            <span class="flex flex-col">
              <span>{text("own.team.createArea.folder.existing")}</span>
              <span class="text-[11.5px] text-own-muted">{text("own.team.createArea.folder.existingHint")}</span>
            </span>
          </label>
        </fieldset>
      </Show>
      <Show
        when={mode() === "new"}
        fallback={
          <Show
            when={folders().length > 0}
            fallback={<p class="own-team-dialog-body text-own-muted">{text("own.team.createArea.folder.none")}</p>}
          >
            <label class={LABEL}>
              {text("own.team.createArea.folder.existing")}
              <select
                class={FIELD}
                value={folder() ?? ""}
                data-testid="team-create-area-existing"
                onChange={(event) => setFolder(event.currentTarget.value || undefined)}
              >
                <option value="">—</option>
                <For each={folders()}>
                  {(directory) => (
                    <option value={directory}>{shortPath(directory, entry()?.team.home.directory ?? directory)}</option>
                  )}
                </For>
              </select>
            </label>
          </Show>
        }
      >
        <label class={LABEL}>
          {text("own.team.createArea.slug")}
          <input
            class={`${FIELD} font-mono`}
            value={shownSlug()}
            maxLength={32}
            spellcheck={false}
            autocomplete="off"
            aria-invalid={slugProblem() !== undefined}
            data-testid="team-create-area-slug"
            onInput={(event) => setSlug(event.currentTarget.value)}
          />
        </label>
        <span
          class="text-[11.5px]"
          classList={{ "text-own-muted": !slugProblem(), "text-own-danger": slugProblem() !== undefined }}
          data-testid="team-create-area-slug-note"
        >
          {text(slugProblem() ?? "own.team.createArea.slugHint")}
        </span>
        <span class="font-mono text-[11.5px] break-all text-own-muted" data-testid="team-create-area-where">
          {text("own.team.createArea.where", { path: where() })}
        </span>
        <Show when={target()?.taken}>
          {(taken) => (
            <span class="text-[11.5px] text-own-muted" data-testid="team-create-area-where-note">
              {text(`own.team.createArea.whereTaken.${taken()}`, { slug: target()?.slug ?? "" })}
            </span>
          )}
        </Show>
        <label class={LABEL}>
          {text("own.team.createArea.from")}
          <select
            class={FIELD}
            value={from()}
            data-testid="team-create-area-from"
            onChange={(event) => setFrom(event.currentTarget.value)}
          >
            <option value="main">{text("own.team.createArea.from.main")}</option>
            <For each={starts()}>
              {(start) => (
                <option value={start.slug}>{text("own.team.createArea.from.area", { area: start.name })}</option>
              )}
            </For>
          </select>
        </label>
        <Show when={!basic()}>
          <div class={LABEL}>
            {text("own.team.createArea.model")}
            <span class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-[13px] text-own-text" data-testid="team-create-area-model">
                {modelLabel()}
              </span>
              <button
                ref={pickButton}
                type="button"
                class="own-team-btn"
                data-testid="team-create-area-model-pick"
                onClick={() => void pickModel()}
              >
                {text("own.team.createArea.model.pick")}
              </button>
            </span>
          </div>
        </Show>
        <Show when={list()}>
          {(harnesses) => (
            <label class={LABEL}>
              {text("own.team.createArea.harness")}
              <select
                class={FIELD}
                value={harness() ?? ""}
                data-testid="team-create-area-harness"
                onChange={(event) =>
                  setHarness(harnesses().harnesses.find((item) => item === event.currentTarget.value))
                }
              >
                <option value="">
                  {text("own.team.createArea.harness.default", { name: harnessName(harnesses().default) })}
                </option>
                {/* Claude Agent 기본 only for a model picked on the Claude Agent route (02 §8.10). */}
                <For
                  each={harnesses().harnesses.filter(
                    (item) => item !== "claude-code" || model()?.providerID === OwnHarnessRouting.CLAUDE_AGENT,
                  )}
                >
                  {(item) => <option value={item}>{harnessName(item)}</option>}
                </For>
              </select>
            </label>
          )}
        </Show>
      </Show>
      <Show when={problems().length > 0}>
        <ul class="m-0 flex list-none flex-col gap-0.5 p-0" role="alert" data-testid="team-create-area-problems">
          <For each={problems()}>
            {(line) => (
              <li class="own-team-dialog-body" data-tone="danger">
                {line}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </TeamDialog>
  )
}

/** The reasons of an `invalid_proposal` answer (`{rejected: [{item, why}]}`); none when it holds no list. */
function rejectedOf(data: unknown): readonly string[] {
  if (typeof data !== "object" || data === null || !("rejected" in data) || !Array.isArray(data.rejected)) return []
  return data.rejected.flatMap((entry: unknown) =>
    typeof entry === "object" && entry !== null && "why" in entry && typeof entry.why === "string" ? [entry.why] : [],
  )
}
