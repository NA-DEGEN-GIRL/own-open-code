// 설정 > 일반 `기본 대화 폴더` (03 §5.1) and `폴더 열기 시작 위치` (03 §18.3), lazy with the settings page. Both live on
// this PC's service (own.accounts `conversationFolder.*`, `folderPicker.*`), so every window and device agrees; the
// rows show this PC's service, also on a phone (through the gateway) or another PC's window. `바꾸기…` opens the native
// folder dialog where this window has one (the desktop app on this PC), else a path box. A connection without the
// `admin` scope shows the values read-only; an older service without the methods says so. The logic is
// projects/folder-settings-state.ts. 설정 > SSH 원격 호스트 > <호스트> shows the folder row of that host's own service
// (`host`, 2.2.6-own.16): the host keeps its folder itself, the path box takes `~/…`, and there is no start row (the
// host's picker starts at its home).
import { Show } from "solid-js"
import { LOCAL, useData, type ServerRuntime } from "@/data"
import { useHost } from "@/host"
import { Segmented, StatusLine, Tag, TextField } from "@/limits/kit"
import { Setting } from "@/settings/sections"
import { folderSettingsState, type FolderRow } from "./folder-settings-state"
import { useRecentProjects } from "./recent"
import { useFolderSettingsText } from "./folder-settings-strings"

export function FolderSettings(props: { readonly runtime?: ServerRuntime; readonly host?: boolean }) {
  const data = useData()
  const host = useHost()
  const text = useFolderSettingsText()
  const runtime = props.runtime ?? data.local()
  const recent = useRecentProjects(() => runtime)
  // 16.7: the native dialog shows this PC's folders, so only this PC's service may take its answer.
  const pickDirectory = host.files?.pickDirectory
  const native = runtime.key === LOCAL && host.capabilities.nativeDirectoryPicker && !!pickDirectory
  const state = folderSettingsState({
    runtime,
    recent,
    text,
    pick: native && pickDirectory ? (options) => pickDirectory(options) : undefined,
    host: props.host,
  })
  void state.store.load()

  const editor = (row: FolderRow) => (
    <Show when={state.editing()?.row === row ? state.editing() : undefined}>
      {(current) => (
        <div class="flex w-full flex-wrap items-end gap-2">
          <div class="min-w-[240px] flex-1">
            <TextField
              label={text("own.project.folderSetting.path")}
              value={current().value}
              onValue={(value) => state.setEditing({ row, value })}
              onEnter={() => void state.submit()}
              spellcheck={false}
              autocomplete="off"
              testid={`settings-${row}-input`}
            />
          </div>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            disabled={state.busy()}
            data-testid={`settings-${row}-save`}
            onClick={() => void state.submit()}
          >
            {text("own.project.folderSetting.save")}
          </button>
          <button type="button" class="own-btn" disabled={state.busy()} onClick={() => state.setEditing(undefined)}>
            {text("own.project.folderSetting.cancel")}
          </button>
        </div>
      )}
    </Show>
  )

  const actions = (row: FolderRow, resettable: () => boolean) => (
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        class="own-btn"
        disabled={state.busy()}
        data-testid={`settings-${row}-change`}
        onClick={() => void state.change(row)}
      >
        {text("own.project.folderSetting.change")}
      </button>
      <button
        type="button"
        class="own-btn"
        disabled={state.busy() || !resettable()}
        data-testid={`settings-${row}-reset`}
        onClick={() => void state.reset(row)}
      >
        {text("own.project.folderSetting.reset")}
      </button>
    </div>
  )

  return (
    <Show
      when={state.store.view()}
      fallback={
        <Show when={state.store.unsupported()}>
          <Setting
            title={text("own.project.folderSetting.title")}
            note={text(
              props.host ? "own.project.folderSetting.hostUnavailable" : "own.project.folderSetting.unavailable",
            )}
            children={null}
          />
        </Show>
      }
    >
      {(view) => (
        <>
          <Setting
            title={text("own.project.folderSetting.title")}
            note={
              state.editable()
                ? text(props.host ? "own.project.folderSetting.hostNote" : "own.project.folderSetting.note")
                : `${text(props.host ? "own.project.folderSetting.hostNote" : "own.project.folderSetting.note")} ${text("own.project.folderSetting.readOnly")}`
            }
          >
            <div class="flex w-full flex-col gap-2" data-testid="settings-default-folder">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  class="min-w-0 truncate font-mono text-[12.5px]"
                  title={view().path}
                  data-testid="settings-default-folder-path"
                >
                  {view().path}
                </span>
                <Show when={!view().custom}>
                  <Tag tone="plain" testid="settings-default-folder-default">
                    {text("own.project.folderSetting.default")}
                  </Tag>
                </Show>
              </div>
              <Show when={!view().exists}>
                <span class="text-[12px] text-own-muted">{text("own.project.folderSetting.notYet")}</span>
              </Show>
              <Show when={state.editable()}>{actions("folder", () => view().custom)}</Show>
              {editor("folder")}
              <StatusLine status={state.status.folder} testid="settings-folder-status" />
            </div>
          </Setting>
          <Show when={!props.host}>
            <Setting title={text("own.project.startSetting.title")} note={text("own.project.startSetting.note")}>
              <div class="flex w-full flex-col gap-2" data-testid="settings-picker-start">
                <Segmented
                  label={text("own.project.startSetting.title")}
                  value={state.store.picker()?.start ? "custom" : "recent"}
                  options={(["recent", "custom"] as const).map((value) => ({
                    value,
                    label: text(`own.project.startSetting.${value}`),
                    disabled: !state.editable() || state.busy(),
                  }))}
                  onChange={(value) => void (value === "recent" ? state.reset("start") : state.change("start"))}
                  testid="settings-picker-mode"
                />
                <Show when={state.start()}>
                  {(path) => (
                    <span
                      class="min-w-0 truncate text-[12px] text-own-muted"
                      title={path()}
                      data-testid="settings-picker-now"
                    >
                      {text(
                        !state.store.picker()?.start && path() === state.store.picker()?.home
                          ? "own.project.startSetting.home"
                          : "own.project.startSetting.now",
                        { path: path() },
                      )}
                    </span>
                  )}
                </Show>
                <Show when={state.editable() && state.store.picker()?.start}>{actions("start", () => true)}</Show>
                {editor("start")}
                <StatusLine status={state.status.start} testid="settings-start-status" />
              </div>
            </Setting>
          </Show>
        </>
      )}
    </Show>
  )
}
