export * as Probe from "./probe.js"

import { Option, Schema } from "effect"
import type { Account, Kind } from "@own/protocol"
import { Credentials } from "@own/runtime"
import type { Endpoints } from "../endpoints.js"

// Connection test of an API key (02 §3.3 table): a free or near-free call per kind that also reveals the provider
// domain where possible. Every call carries the key only in the kind's auth header (02 §4.1); nothing is logged.

const TIMEOUT_MS = 15_000

export type Result =
  | { readonly ok: true; readonly detected: Account.Detected; readonly latencyMs: number }
  | {
      readonly ok: false
      /** `unauthorized` = 401/403: the key itself is rejected. */
      readonly reason: "unauthorized" | "http_error" | "network_error" | "base_url_required"
      readonly status?: number
      readonly message: string
      readonly latencyMs: number
    }

export interface Input {
  readonly kind: Kind.Api
  /** Auth headers of the key (`Credentials.keyHeaders`), so a stored key can be probed through `headersFor`. */
  readonly headers: Readonly<Record<string, string>>
  readonly endpoints: Endpoints.Endpoints
  /** `compat` (required) or a user-specified base URL of another kind. */
  readonly baseURL?: string
  readonly signal?: AbortSignal
}

const XaiKey = Schema.Struct({ team_id: Schema.optionalKey(Schema.NullOr(Schema.String)) })
const decodeXai = Schema.decodeUnknownOption(Schema.fromJsonString(XaiKey))

/** Probes a key. Never throws. */
export async function run(input: Input): Promise<Result> {
  const started = performance.now()
  const latency = () => Math.round(performance.now() - started)
  const url = target(input)
  if (!url)
    return {
      ok: false,
      reason: "base_url_required",
      message: input.baseURL ? "invalid_base_url" : "base_url_required",
      latencyMs: latency(),
    }
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(url, {
    method: "GET",
    headers: {
      ...input.headers,
      ...(input.kind === "anth" ? { "anthropic-version": "2023-06-01" } : {}),
      accept: "application/json",
    },
    signal,
  }).catch(() => undefined)
  if (!response) return { ok: false, reason: "network_error", message: "network_error", latencyMs: latency() }
  const text = await response.text().catch(() => "")
  if (response.status === 401 || response.status === 403)
    return { ok: false, reason: "unauthorized", status: response.status, message: "unauthorized", latencyMs: latency() }
  if (!response.ok)
    return {
      ok: false,
      reason: "http_error",
      status: response.status,
      message: `http_${response.status}`,
      latencyMs: latency(),
    }
  return { ok: true, detected: detect(input.kind, response.headers, text), latencyMs: latency() }
}

/** Probes a key given in plain text (`accounts.add.key`, `replaceKey`). */
export function key(input: Omit<Input, "headers"> & { readonly key: string }) {
  return run({ ...input, headers: Credentials.keyHeaders(input.kind, input.key) })
}

/**
 * The probe URL of 02 §3.3, or `undefined` without a usable (http/https) base URL. The DeepSeek balance lives on the
 * API origin, outside `/v1`.
 */
export function target(input: Pick<Input, "kind" | "endpoints" | "baseURL">) {
  const base = (
    input.baseURL ?? (input.kind === "compat" ? undefined : input.endpoints.url[endpointOf(input.kind)])
  )?.replace(/\/+$/, "")
  if (!base || !URL.canParse(base) || !/^https?:$/.test(new URL(base).protocol)) return undefined
  if (input.kind === "anth") return `${base}/models?limit=1`
  if (input.kind === "ds") return `${new URL(base).origin}/user/balance`
  if (input.kind === "xai") return `${base}/api-key`
  if (input.kind === "or") return `${base}/key`
  return `${base}/models`
}

function endpointOf(kind: Exclude<Kind.Api, "compat">) {
  const names = { oai: "openai", anth: "anthropic", ds: "deepseek", xai: "xai", or: "openrouter" } as const
  return names[kind]
}

/** Domain identifiers the probe response reveals (02 §3.3 "도메인 식별", ⚠ header names unconfirmed). */
function detect(kind: Kind.Api, headers: Headers, text: string): Account.Detected {
  if (kind === "oai")
    return {
      organizationId: headers.get("openai-organization"),
      projectId: headers.get("openai-project"),
    }
  if (kind === "anth")
    return {
      organizationId: headers.get("anthropic-organization-id"),
      workspaceId: headers.get("anthropic-workspace-id"),
    }
  if (kind === "xai") return { teamId: Option.getOrUndefined(decodeXai(text))?.team_id ?? null }
  return {}
}
