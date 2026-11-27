// 설정 > 확장, one extension's SSH hosts (17 §10): which hosts have it (the PC's decision and each host's report), the
// host selection (`hosts.set`: every host, only the chosen, every host but the chosen), the host folders of its scope
// (`scope.set` `hostProjects`, tagged with their host) and, for a code plugin or approved allow rules, the separate
// per-host allowance of the active version (`hostTrust.set`, CRM-33) under the risk text. Hosts only ever get read-only copies; every change here
// is this PC's. Host names come from own.remote's `hosts.list` when it answers, else the host id shows.
import { createResource, createSignal, For, Show } from "solid-js"
import { useData } from "@/data"
import type { CreatorInput, CreatorOutput } from "@/data/creator-rpc"
import { Tag, TextField } from "@/limits/kit"
import { hostFolderOk, hostStateKey, reachKey, withHost, type View } from "./model"
import { useCreatorText } from "./strings"

type List = CreatorOutput<"list">
type HostMethod = "hosts.set" | "scope.set" | "hostTrust.set"

export function ExtensionHosts(props: {
  readonly view: View
  readonly hosts: List["hosts"]
  readonly busy: boolean
  readonly editable: boolean
  readonly call: <M extends HostMethod>(method: M, input: CreatorInput<M>, done: string) => Promise<boolean>
}) {
  const text = useCreatorText()
  const data = useData()
  const [names] = createResource(() =>
    data.remote
      .call("hosts.list", {})
      .then((list) => new Map(list.hosts.map((host) => [host.id, host.name] as const)))
      .catch(() => new Map<string, string>()),
  )
  const name = (id: string) => names()?.get(id) ?? id
  const [folderHost, setFolderHost] = createSignal("")
  const [folder, setFolder] = createSignal("")
  const [folderProblem, setFolderProblem] = createSignal<string>()
  const title = () => props.view.title
  const known = () => [...new Set([...props.hosts.map((host) => host.id), ...props.view.hosts.ids])]
  const line = (host: string) => props.view.remote.find((item) => item.host === host)
  const chosen = (host: string) => props.view.hosts.ids.includes(host)
  const plugin = () => props.view.kind === "plugin"
  const loosens = () => props.view.effects.some((effect) => effect.loosens)
  const hostTrusted = (host: string) =>
    props.view.hostTrusted.some((item) => item.host === host && item.n === props.view.active)

  function addFolder() {
    const host = folderHost() || known()[0] || ""
    const value = folder().trim()
    if (!host || !hostFolderOk(value)) return setFolderProblem(text("own.ext.hosts.folder.absolute"))
    setFolderProblem(undefined)
    void props
      .call(
        "scope.set",
        {
          id: props.view.id,
          projects: [...props.view.projects],
          hostProjects: [
            ...props.view.hostProjects.filter((item) => !(item.host === host && item.directory === value)),
            { host, directory: value },
          ],
        },
        text("own.ext.done.scope", { title: title() }),
      )
      .then((done) => done && setFolder(""))
  }

  return (
    <div class="flex flex-col gap-1" data-testid="creator-extension-hosts">
      <span class="text-[12px] font-semibold text-own-muted">{text("own.ext.hosts")}</span>
      <span class="text-[12px] text-own-muted">{text("own.ext.hosts.lead")}</span>
      <Show when={props.editable}>
        <label class="flex items-center gap-2 text-[12.5px]">
          {text("own.ext.hosts.mode")}
          <select
            class="own-input"
            data-size="sm"
            value={props.view.hosts.mode}
            disabled={props.busy}
            data-testid="creator-extension-hosts-mode"
            onChange={(event) =>
              void props.call(
                "hosts.set",
                {
                  id: props.view.id,
                  hosts: { mode: event.currentTarget.value as View["hosts"]["mode"], ids: [...props.view.hosts.ids] },
                },
                text("own.ext.done.hosts", { title: title() }),
              )
            }
          >
            <option value="all">{text("own.ext.hosts.mode.all")}</option>
            <option value="only">{text("own.ext.hosts.mode.only")}</option>
            <option value="except">{text("own.ext.hosts.mode.except")}</option>
          </select>
        </label>
      </Show>
      <Show when={known().length > 0} fallback={<span class="text-[12.5px]">{text("own.ext.hosts.none")}</span>}>
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          <For each={known()}>
            {(host) => (
              <li
                class="flex flex-wrap items-center gap-2 text-[12.5px]"
                data-testid="creator-extension-host"
                data-host={host}
                data-reach={line(host)?.reach ?? "inactive"}
              >
                <Show when={props.editable && props.view.hosts.mode !== "all"}>
                  <input
                    type="checkbox"
                    checked={chosen(host)}
                    disabled={props.busy}
                    aria-label={text("own.ext.hosts.pick", { name: name(host) })}
                    data-testid="creator-extension-host-pick"
                    onChange={(event) =>
                      void props.call(
                        "hosts.set",
                        { id: props.view.id, hosts: withHost(props.view.hosts, host, event.currentTarget.checked) },
                        text("own.ext.done.hosts", { title: title() }),
                      )
                    }
                  />
                </Show>
                <b>{name(host)}</b>
                <span class="text-own-muted">
                  {text(
                    props.hosts.some((item) => item.id === host && item.connected)
                      ? "own.ext.hosts.connected"
                      : "own.ext.hosts.offline",
                  )}
                </span>
                <Tag tone={line(host)?.reach === "sent" ? "ok" : "plain"} testid="creator-extension-host-reach">
                  {text(reachKey(line(host)?.reach ?? "inactive"))}
                </Tag>
                <Show when={line(host) && hostStateKey(line(host)!)}>
                  {(state) => (
                    <span
                      data-testid="creator-extension-host-state"
                      classList={{
                        "text-own-danger": line(host)?.state?.status === "failed",
                        "text-own-warn": state().key === "own.ext.host.stale",
                      }}
                    >
                      {text(state().key, { status: state().status ?? "" })}
                    </span>
                  )}
                </Show>
                <Show when={line(host)?.state?.problems.length}>
                  <span class="text-own-muted">
                    {line(host)!
                      .state!.problems.map((problem) => problem.message)
                      .join("; ")}
                  </span>
                </Show>
                <Show when={props.editable && (plugin() || loosens())}>
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    disabled={props.busy}
                    data-testid="creator-extension-host-trust"
                    onClick={() =>
                      void props.call(
                        "hostTrust.set",
                        { id: props.view.id, host, version: props.view.active, trusted: !hostTrusted(host) },
                        text("own.ext.done.hostTrust", { title: title(), n: props.view.active }),
                      )
                    }
                  >
                    {text(hostTrusted(host) ? "own.ext.hostTrust.revoke" : "own.ext.hostTrust.allow", {
                      name: name(host),
                    })}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={plugin()}>
        <p class="m-0 text-[12.5px] text-own-warn" data-testid="creator-extension-host-trust-risk">
          {text("own.ext.hostTrust.risk")}
        </p>
      </Show>
      <Show when={!plugin() && loosens()}>
        <p class="m-0 text-[12.5px] text-own-warn" data-testid="creator-extension-host-loosen-risk">
          {text("own.ext.hostLoosen.risk")}
        </p>
      </Show>
      <Show when={props.view.hostProjects.length > 0}>
        <span class="text-[12px] font-semibold text-own-muted">{text("own.ext.hosts.folders")}</span>
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          <For each={props.view.hostProjects}>
            {(item) => (
              <li class="flex items-center gap-2" data-testid="creator-extension-host-project">
                <span class="text-[12px]">{name(item.host)}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-[12px]" title={item.directory}>
                  {item.directory}
                </span>
                <Show when={props.editable}>
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    disabled={props.busy}
                    onClick={() =>
                      void props.call(
                        "scope.set",
                        {
                          id: props.view.id,
                          projects: [...props.view.projects],
                          hostProjects: props.view.hostProjects.filter((other) => other !== item),
                        },
                        text("own.ext.done.scope", { title: title() }),
                      )
                    }
                  >
                    {text("own.ext.scope.remove")}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.editable && known().length > 0 && !props.view.effects.some((effect) => effect.global)}>
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex flex-col gap-1 text-[12px]">
            {text("own.ext.hosts.folder.host")}
            <select
              class="own-input"
              data-size="sm"
              value={folderHost() || known()[0]}
              data-testid="creator-extension-host-folder-host"
              onChange={(event) => setFolderHost(event.currentTarget.value)}
            >
              <For each={known()}>{(host) => <option value={host}>{name(host)}</option>}</For>
            </select>
          </label>
          <div class="min-w-[220px] flex-1">
            <TextField
              label={text("own.ext.hosts.folder")}
              value={folder()}
              onValue={setFolder}
              onEnter={addFolder}
              error={folderProblem()}
              spellcheck={false}
              autocomplete="off"
              testid="creator-extension-host-folder"
            />
          </div>
          <button
            type="button"
            class="own-btn"
            disabled={props.busy || !folder().trim()}
            data-testid="creator-extension-host-folder-add"
            onClick={addFolder}
          >
            {text("own.ext.hosts.folder.add")}
          </button>
        </div>
      </Show>
    </div>
  )
}
