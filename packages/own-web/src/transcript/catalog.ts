// Provider and model display names of a session's location, in the shape session-ui rows expect
// (`DataProvider` `provider`), plus the lookups the footer and markers use. Loaded once per location and connection.
import type { ModelInfo, ProviderInfo } from "@opencode/client/promise"
import { createEffect, createMemo, type Accessor } from "solid-js"
import type { TranscriptRuntime } from "./context"

export interface ProviderCatalog {
  readonly all: Map<string, { name: string; models: Record<string, { name: string }> }>
  readonly default: Record<string, string>
  readonly connected: string[]
}

export function createCatalog(input: {
  readonly runtime: TranscriptRuntime
  readonly directory: Accessor<string | undefined>
  readonly connected: Accessor<boolean>
}) {
  const location = input.runtime.data.location
  const ref = () => {
    const directory = input.directory()
    return directory ? { directory } : undefined
  }
  createEffect(() => {
    const current = ref()
    if (!current || !input.connected()) return
    void Promise.all([location.provider.sync(current), location.model.sync(current)]).catch(() => undefined)
  })
  const catalog = createMemo(() => {
    const current = ref()
    return buildCatalog(current && location.provider.list(current), current && location.model.list(current))
  })
  return {
    ui: catalog,
    modelName: (providerID: string, modelID: string) => catalog().all.get(providerID)?.models[modelID]?.name ?? modelID,
    providerName: (providerID: string) => catalog().all.get(providerID)?.name ?? providerID,
  }
}

export type Catalog = ReturnType<typeof createCatalog>

export function buildCatalog(providers?: readonly ProviderInfo[], models?: readonly ModelInfo[]): ProviderCatalog {
  const all = new Map<string, { name: string; models: Record<string, { name: string }> }>(
    (providers ?? []).map((provider) => [provider.id, { name: provider.name, models: {} }]),
  )
  const byProvider = Map.groupBy(models ?? [], (model) => model.providerID)
  byProvider.forEach((list, providerID) => {
    const entry = all.get(providerID) ?? { name: providerID, models: {} }
    all.set(providerID, {
      name: entry.name,
      models: Object.fromEntries(list.map((model) => [model.id, { name: model.name }])),
    })
  })
  return { all, default: {}, connected: [] }
}
