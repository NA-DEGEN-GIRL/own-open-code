// 설정 > 승인·권한 `에이전트가 못 여는 파일·폴더` (01 §13, 03 §18.8, PP), lazy with the settings page. One server at a
// time (its own list, placed in its own home folder); the picker shows when more than one is attached, like 셸·터미널.
// The user's list with `빼기`, a path box with `추가` (`~` allowed), the desktop's file and folder dialogs for this PC's
// service, the home folder's sensitive-looking names with `추가`, and the built-in list with its reasons, read-only.
// Phones and other PCs see it read-only (`local` scope). The logic is state.ts.
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { LOCAL, useData, type ServerKey } from "@/data"
import { useHost } from "@/host"
import { Notice, Segmented, StatusLine, Tag, TextField } from "@/limits/kit"
import { grouped, protectedState } from "./state"
import { useProtectedText } from "./strings"

export function ProtectedPathsSection() {
  const data = useData()
  const host = useHost()
  const text = useProtectedText()
  const [serverKey, setServerKey] = createSignal<ServerKey>(LOCAL)
  const runtime = () => data.get(serverKey()) ?? data.local()
  const connected = () => runtime().connection.status() === "connected"
  const state = createMemo(() => protectedState(runtime(), text))
  createEffect(() => {
    const current = state()
    if (!connected()) return
    untrack(() => void current.load())
    onCleanup(current.follow())
  })
  // 16.7: the native dialogs show this PC's files, so only this PC's service takes their answer.
  const local = () => runtime().key === LOCAL
  const pickDirectory = () =>
    local() && host.capabilities.nativeDirectoryPicker ? host.files?.pickDirectory : undefined
  const pickFile = () => (local() && host.capabilities.nativeFilePaths ? host.files?.pickFile : undefined)
  const pick = async (
    choose: ((options?: { readonly defaultPath?: string }) => Promise<string | null>) | undefined,
  ) => {
    if (!choose) return
    const picked = await choose({ defaultPath: state().view()?.home }).catch(() => null)
    if (picked) await state().add(picked)
  }

  return (
    <section class="own-as-section" aria-labelledby="own-as-protected" data-testid="protected-paths">
      <h2 id="own-as-protected">{text("own.protected.title")}</h2>
      <p class="own-rq-note">{text("own.protected.intro")}</p>
      <Show when={data.servers.list().length > 1}>
        <div class="flex flex-wrap items-center gap-2 text-[12.5px]">
          <span class="text-own-muted">{text("own.protected.server")}</span>
          <Segmented
            label={text("own.protected.server")}
            value={serverKey()}
            options={data.servers.list().map((entry) => ({
              value: entry.key,
              label: entry.key === LOCAL ? text("own.protected.thisPc") : entry.label,
            }))}
            onChange={(key) => setServerKey(key)}
            testid="protected-server"
          />
        </div>
      </Show>
      <Show when={connected()} fallback={<p class="own-rq-note">{text("own.protected.notConnected")}</p>}>
        <Show
          when={state().failure() !== "unsupported"}
          fallback={<p class="own-rq-note">{text("own.protected.unsupported")}</p>}
        >
          <Show
            when={state().view()}
            fallback={
              <p class={state().failure() ? "own-rq-problem" : "own-rq-note"}>
                {text(state().failure() ? "own.protected.loadFailed" : "own.protected.loading")}
              </p>
            }
          >
            {(view) => (
              <>
                <Show when={!state().editable()}>
                  <Notice tone="info" testid="protected-readonly">
                    {text("own.protected.readOnly")}
                  </Notice>
                </Show>
                <h3 class="own-as-sub">{text("own.protected.user")}</h3>
                <Show
                  when={view().user.length > 0}
                  fallback={
                    <p class="own-rq-note" data-testid="protected-user-empty">
                      {text("own.protected.userEmpty")}
                    </p>
                  }
                >
                  <ul class="own-as-rules" data-testid="protected-user">
                    <For each={view().user}>
                      {(entry) => (
                        <li class="own-as-path" data-testid="protected-user-row">
                          <span class="own-as-mono" title={entry.resolved}>
                            {entry.path}
                            <Show when={entry.path !== entry.resolved}>
                              <span class="own-as-resolved">{entry.resolved}</span>
                            </Show>
                          </span>
                          <Show when={state().editable()}>
                            <button
                              type="button"
                              class="own-rq-btn"
                              data-variant="ghost"
                              disabled={state().busy()}
                              aria-label={text("own.protected.removeLabel", { path: entry.path })}
                              data-testid="protected-user-remove"
                              onClick={() => void state().remove(entry.path)}
                            >
                              {text("own.protected.remove")}
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={state().editable()}>
                  <div class="flex w-full flex-wrap items-end gap-2">
                    <div class="min-w-[220px] flex-1">
                      <TextField
                        label={text("own.protected.path")}
                        value={state().draft()}
                        placeholder={text("own.protected.placeholder")}
                        onValue={(value) => state().setDraft(value)}
                        onEnter={() => void state().add(state().draft())}
                        spellcheck={false}
                        autocomplete="off"
                        testid="protected-input"
                      />
                    </div>
                    <button
                      type="button"
                      class="own-rq-btn"
                      data-variant="primary"
                      disabled={state().busy() || state().draft().trim() === ""}
                      data-testid="protected-add"
                      onClick={() => void state().add(state().draft())}
                    >
                      {text("own.protected.add")}
                    </button>
                    <Show when={pickDirectory()}>
                      {(choose) => (
                        <button
                          type="button"
                          class="own-rq-btn"
                          disabled={state().busy()}
                          data-testid="protected-pick-folder"
                          onClick={() => void pick(choose())}
                        >
                          {text("own.protected.pickFolder")}
                        </button>
                      )}
                    </Show>
                    <Show when={pickFile()}>
                      {(choose) => (
                        <button
                          type="button"
                          class="own-rq-btn"
                          disabled={state().busy()}
                          data-testid="protected-pick-file"
                          onClick={() => void pick(choose())}
                        >
                          {text("own.protected.pickFile")}
                        </button>
                      )}
                    </Show>
                  </div>
                </Show>
                <StatusLine status={state().status} testid="protected-status" />
                <Show when={state().editable() && state().suggestions().length > 0}>
                  <h3 class="own-as-sub">{text("own.protected.suggest")}</h3>
                  <p class="own-rq-note">{text("own.protected.suggestNote")}</p>
                  <ul class="own-as-rules" data-testid="protected-suggestions">
                    <For each={state().suggestions()}>
                      {(item) => (
                        <li class="own-as-path" data-testid="protected-suggestion">
                          <span class="own-as-mono" title={item.path}>
                            {item.name}{" "}
                            <Tag tone="plain">{text(item.folder ? "own.protected.folder" : "own.protected.file")}</Tag>
                          </span>
                          <button
                            type="button"
                            class="own-rq-btn"
                            disabled={state().busy()}
                            aria-label={text("own.protected.addLabel", { name: item.name })}
                            data-testid="protected-suggestion-add"
                            onClick={() => void state().add(item.path)}
                          >
                            {text("own.protected.add")}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <details class="own-as-builtin" data-testid="protected-builtin">
                  <summary>{text("own.protected.builtIn", { n: view().builtIn.length })}</summary>
                  <p class="own-rq-note">{text("own.protected.builtInNote")}</p>
                  <For each={grouped(view())}>
                    {(group) => (
                      <div class="own-as-group" data-group={group.group}>
                        <h4>{text(`own.protected.group.${group.group}`)}</h4>
                        <ul class="own-as-rules">
                          <For each={group.entries}>
                            {(entry) => (
                              <li class="own-as-builtin-row" data-testid="protected-builtin-row" data-id={entry.id}>
                                <span class="own-as-mono">{entry.paths.join("\n")}</span>
                                <span class="text-own-muted">{entry.reason}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    )}
                  </For>
                </details>
                <p class="own-rq-note">{text("own.protected.shellNote")}</p>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </section>
  )
}
