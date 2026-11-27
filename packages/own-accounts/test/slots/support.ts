// Test support of the slots and auth modules: a provider editor with the semantics of core's fold editor, catalog
// model builders, an in-memory `ctx.storage`, an RPC call context, and registry builders. Credentials are fake.

import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/promise/provider"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { Account, Kind, OwnID, type Credential, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import type { Schema } from "effect"
import type { RpcTypes } from "../../src/rpc/types.js"
import { Templates } from "../../src/slots/templates.js"

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] }

export interface EditorRecord {
  provider: Mutable<Provider.Info>
  models: ReadonlyMap<string, Model.Info>
}

/** A fold editor over plain records: `add` replaces, `update` edits (creating an empty record like core does). */
export function fakeEditor(
  seed: Readonly<
    Record<string, { readonly info?: Partial<Provider.Info>; readonly models?: ReadonlyArray<Model.Info> }>
  > = {},
) {
  const records = new Map<string, EditorRecord>(
    Object.entries(seed).map(([id, value]) => [
      id,
      {
        provider: { ...Provider.Info.empty(Provider.ID.make(id)), ...value.info } as Mutable<Provider.Info>,
        models: new Map((value.models ?? []).map((model) => [model.id, model])),
      },
    ]),
  )
  const record = (id: string) => {
    const existing = records.get(id)
    if (existing) return existing
    const created = { provider: Provider.Info.empty(Provider.ID.make(id)) as Mutable<Provider.Info>, models: new Map() }
    records.set(id, created)
    return created
  }
  const editor: ProviderEditor = {
    list: () => [...records.values()] as ProviderRecord[],
    get: (id) => records.get(id) as ProviderRecord | undefined,
    add: (input) => {
      records.set(input.info.id, {
        provider: structuredClone(input.info) as Mutable<Provider.Info>,
        models: new Map(input.models.map((model) => [model.id, model])),
      })
    },
    update: (id, update) => {
      // SAFETY: the record is a plain mutable copy, like core's `MutableInfo`.
      update(record(id).provider as never)
    },
    remove: (id) => {
      records.delete(id)
    },
    models: {
      set: (id, models) => {
        record(id).models = new Map(models.map((model) => [model.id, model]))
      },
      update: (id, modelID, update) => {
        const current = record(id).models.get(modelID)
        if (!current) return
        const copy = structuredClone(current)
        // SAFETY: the copy is a plain mutable model, like core's `MutableModelInfo`.
        update(copy as never)
        record(id).models = new Map([...record(id).models].map((entry) => (entry[0] === modelID ? [modelID, copy] : entry)))
      },
      remove: (id, modelID) => {
        const current = record(id)
        current.models = new Map([...current.models].filter((entry) => entry[0] !== modelID))
      },
    },
  }
  return { editor, records }
}

/** A catalog model as models.dev normalization produces it (fake values). */
export function catalogModel(providerID: string, id: string, extra: Partial<Model.Info> = {}): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id)),
    name: id.toUpperCase(),
    family: Model.Family.make(id.split("-").slice(0, 2).join("-")),
    cost: [price(1, 4)],
    limit: { context: 200_000, output: 32_000 },
    time: { released: 1_700_000_000_000 },
    ...extra,
  }
}

export function price(input: number, output: number): Model.Info["cost"][number] {
  return {
    input: Money.USDPerMillionTokens.make(input),
    output: Money.USDPerMillionTokens.make(output),
    cache: { read: Money.USDPerMillionTokens.make(input / 10), write: Money.USDPerMillionTokens.make(input) },
  }
}

/** `ctx.storage` over a Map, with the stored values exposed for assertions. */
export function memoryStorage() {
  const values = new Map<string, Schema.Json>()
  const storage: StorageDomain = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, structuredClone(value))
    },
    remove: async (key) => {
      values.delete(key)
    },
    scan: async (options) => ({
      entries: [...values]
        .filter((entry) => entry[0].startsWith(options.prefix))
        .map((entry) => ({ key: entry[0], value: entry[1] })),
    }),
  }
  return { storage, values }
}

export interface RpcFailure {
  readonly type: string
  readonly message: string
  readonly data?: unknown
}

/** The `{ signal, error }` context a handler receives; `error` returns a recognizable failure object. */
export function rpcContext<N extends RpcTypes.MethodName>(): RpcTypes.Context<N> {
  const context = {
    signal: new AbortController().signal,
    error: (type: string, message: string, data?: unknown) => ({ type, message, data, rpcError: true }),
  }
  // SAFETY: tests read the returned failure through `failure()`; the handler only calls `error(...)`.
  return context as unknown as RpcTypes.Context<N>
}

export function failure(value: unknown): RpcFailure | undefined {
  if (typeof value === "object" && value !== null && "rpcError" in value) return value as unknown as RpcFailure
  return undefined
}

export interface AccountSeed {
  readonly kind: Kind.Own
  readonly label: string
  readonly slug: string
  readonly identity?: Account.Identity
  readonly credential?: Credential.Ref
  readonly status?: Account.Status
  readonly transport?: "http" | "websocket"
  readonly baseURL?: string
  readonly retired?: boolean
}

/** A registry whose accounts use the bundled templates (the same data a first offline run registers). */
export async function registryWith(seeds: ReadonlyArray<AccountSeed>): Promise<Registry.File> {
  const kinds = [...new Set(seeds.map((seed) => seed.kind))].filter(
    (kind): kind is Templates.CatalogKind => kind !== "compat",
  )
  const templates = Object.fromEntries(
    await Promise.all(
      kinds.map(async (kind) => {
        const template = await Templates.bundled(kind)
        if (!template) throw new Error(`no bundled template for ${kind}`)
        return [`tpl_${kind}_test`, template] as const
      }),
    ),
  )
  const accounts = seeds.map((seed): Account.Info => {
    const providerID = Kind.ProviderID.from(seed.kind, seed.slug)
    return {
      id: Account.ID.make(`acc_${seed.slug}`),
      kind: seed.kind,
      label: seed.label,
      shortLabel: seed.label.slice(0, 1).toUpperCase(),
      color: "indigo",
      providerID,
      cacheDomain: OwnID.CacheDomainID.make(`cd_${seed.slug}`),
      quotaDomain: OwnID.QuotaDomainID.make(`qd_${seed.slug}`),
      billing: Kind.meta[seed.kind].billing,
      identity: seed.identity ?? {},
      autoSwitch: seed.kind !== "codex",
      status: seed.status ?? "ready",
      ...(seed.credential ? { credential: seed.credential } : {}),
    }
  })
  return {
    ...Store.emptyRegistry(),
    revision: 1,
    cacheDomains: Object.fromEntries(
      seeds.map((seed) => [`cd_${seed.slug}`, { kind: seed.kind, scope: "api_key" as const, poolingVerified: false }]),
    ),
    quotaDomains: Object.fromEntries(
      seeds.map((seed) => [`qd_${seed.slug}`, { kind: seed.kind, scope: "api_key" as const }]),
    ),
    accounts,
    slots: Object.fromEntries(
      seeds.map((seed) => [
        Kind.ProviderID.from(seed.kind, seed.slug),
        {
          kind: seed.kind,
          accounts: [Account.ID.make(`acc_${seed.slug}`)],
          pooling: "off" as const,
          modelTemplate: OwnID.TemplateID.make(`tpl_${seed.kind}_test`),
          ...(seed.transport ? { transport: seed.transport } : {}),
          ...(seed.baseURL ? { baseURL: seed.baseURL } : {}),
          ...(seed.retired ? { retired: true } : {}),
        },
      ]),
    ),
    modelTemplates: templates,
  }
}
