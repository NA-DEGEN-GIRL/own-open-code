// First-run hints on the new-session screen, above the composer (03 §4.3.1): where team mode, worktrees and settings are,
// in three short lines, until `안내 닫기` (remembered per browser profile; the palette's `처음 안내 다시 보기` brings them
// back). On a project that is not a Git repository a fourth line says why team mode and worktrees are missing there,
// with `Git 저장소로 만들기…` where this connection may (06 §3.0); in the 기본 대화 폴더 (03 §5.1) why it stays a plain
// folder, with `프로젝트 폴더 열기…`.
// Where the build has the user manual, the team line links its chapter and a last line opens it.
// Lines for what this connection cannot do are left out (model.ts).
import { createMemo, Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { chordLabel, DEFAULT_KEYMAP } from "@/keyboard"
import { useRouter } from "@/routing/router"
import { manualBase, openManual } from "@/manual"
import { Icon } from "@/shell/icons"
import { newSessionTarget } from "@/sidebar/target"
import { isDefaultFolder } from "@/projects/default-folder"
import { baseName } from "@/projects/path"
import { notGitAction } from "./menus"
import { hintsClosed, notGitNote, setHintsClosed } from "./model"
import { useDiscoverText } from "./strings"

export function DiscoverHints(props: { readonly serverKey: () => ServerKey }) {
  const data = useData()
  const host = useHost()
  const router = useRouter()
  const text = useDiscoverText()
  const i18n = useI18n()
  const runtime = () => data.get(props.serverKey())
  /** The project of the new-session screen, when one is chosen. */
  const project = createMemo(() => {
    const route = router.route()
    const current = runtime()
    if (!current) return undefined
    const target = newSessionTarget()
    const projectID =
      route.name === "project" ? route.projectID : target?.serverKey === current.key ? target.projectID : undefined
    if (!projectID) return undefined
    const directory = current.sessions.state.projects[projectID]?.directory ?? target?.directory
    return { projectID, directory }
  })
  const notGit = createMemo(() => {
    const current = runtime()
    const place = project()
    return current && place && notGitNote(current, place) ? place : undefined
  })
  /** `Git 저장소로 만들기…`, or `프로젝트 폴더 열기…` in the 기본 대화 폴더 (menus.ts). */
  const action = createMemo(() => {
    const current = runtime()
    const place = notGit()
    if (!current || !place) return undefined
    return notGitAction({
      runtime: current,
      serverKey: props.serverKey(),
      locale: i18n.locale(),
      place,
      testid: "discover-hints",
    })
  })
  const shared = () => {
    const current = runtime()
    return !!current && isDefaultFolder(current, notGit()?.directory)
  }
  const team = () => runtime()?.team.state.load !== "missing"
  const worktree = () => runtime()?.rpc.can("prompt") ?? false

  return (
    <Show when={!hintsClosed()}>
      <aside
        class="mx-auto mb-3 w-[calc(100%-2rem)] max-w-[var(--own-content-max)] flex-none rounded-lg border border-own-border bg-own-subtle px-4 py-3 text-[12.5px] text-own-muted"
        aria-label={text("own.discover.hints.title")}
        data-testid="discover-hints"
      >
        <div class="mb-1.5 flex items-center gap-2">
          <p class="m-0 flex-1 font-semibold text-own-text">{text("own.discover.hints.title")}</p>
          <button
            type="button"
            class="own-icon-button own-target size-6 [&_svg]:size-3.5"
            aria-label={text("own.discover.hints.close")}
            title={text("own.discover.hints.close")}
            data-testid="discover-hints-close"
            onClick={() => setHintsClosed(true)}
          >
            <Icon name="x" />
          </button>
        </div>
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          <Show when={notGit()}>
            {(place) => (
              <li class="text-own-text" data-testid="discover-hints-not-git">
                {shared()
                  ? text("own.discover.hints.defaultFolder")
                  : text("own.discover.hints.notGit", {
                      project: baseName(place().directory ?? "") || place().projectID,
                    })}
                <Show when={action()}>
                  {(item) => (
                    <>
                      {" "}
                      <button
                        type="button"
                        class="m-0 inline border-0 bg-transparent p-0 text-own-accent-text underline-offset-2 hover:underline"
                        data-testid={item().testid}
                        onClick={() => item().onSelect()}
                      >
                        {item().label}
                      </button>
                    </>
                  )}
                </Show>
              </li>
            )}
          </Show>
          <Show when={team()}>
            <li data-testid="discover-hints-team">
              {text("own.discover.hints.team")}{" "}
              <Show when={manualBase()}>
                <button
                  type="button"
                  class="m-0 inline border-0 bg-transparent p-0 text-own-accent-text underline-offset-2 hover:underline"
                  data-testid="discover-hints-team-manual"
                  onClick={() => openManual("teamEnable")}
                >
                  {text("own.discover.hints.teamChapter")}
                </button>
              </Show>
            </li>
          </Show>
          <Show when={worktree()}>
            <li data-testid="discover-hints-worktree">{text("own.discover.hints.worktree")}</li>
          </Show>
          {/* A touch screen (MUX): where the buttons are, not the keys of a keyboard it does not have. */}
          <li data-testid="discover-hints-settings">
            {host.capabilities.touch
              ? text("own.discover.hints.settingsTouch")
              : text("own.discover.hints.settings", {
                  keys: chordLabel(DEFAULT_KEYMAP["settings.open"].chords[0]),
                  palette: chordLabel(DEFAULT_KEYMAP["palette.open"].chords[0]),
                })}
          </li>
          <Show when={manualBase()}>
            <li data-testid="discover-hints-manual">
              <button
                type="button"
                class="m-0 inline border-0 bg-transparent p-0 text-left text-inherit underline-offset-2 hover:text-own-text hover:underline"
                onClick={() => openManual()}
              >
                {text("own.discover.hints.manual")}
              </button>
            </li>
          </Show>
        </ul>
      </aside>
    </Show>
  )
}
