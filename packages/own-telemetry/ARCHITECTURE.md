# own-telemetry architecture (`@own/telemetry`, plugin id `own.telemetry`)

Specs: 01 §3.1, §4, §14; 02 §4.1 (hook table), §7.1–§7.2, §7.7 (`claude_extra_usage`), §8.5, §8.8.

## Role

The only observer that must run **after** claude-auth: configured plugin order is
`[own.accounts, heymaaz.claude-auth-v2, own.telemetry]` (02 §8.2), and same-named hooks run in registration order,
so this plugin sees the final `anthropic` responses that claude-auth produced. It observes `anthropic` only (the
third-party Claude subscription slot), never changes a request, registers no RPC, and writes only to the shared
`@own/runtime` singleton. own-accounts (the only `own.accounts` RPC registrant) turns that data into events.

## Files (owner: TELEMETRY-PLUGIN agent, except `server.ts`/`src/index.ts`/`src/build.ts`/`src/options.ts` = LEAD)

| Path                 | Contents                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.ts`          | Dev entry for `"<repo>/packages/own-telemetry"`                                                                                                                                                                    |
| `src/index.ts`       | `Plugin.define`: options, guard 1 (skip everything when unmanaged/skewed), `Runtime.acquire` (same `buildId` and `home` as own-accounts), hooks scoped `{ providerID: "anthropic" }`, cleanup releases the runtime |
| `src/build.ts`       | Build constants shared in value with own-accounts (`BUILD_ID`, `EXPECTED_APP_VERSION`, …), `PROVIDER_ID`, `CLAUDE_ACCOUNT_ID`                                                                                      |
| `src/options.ts`     | `home`, `buildId`, `logLevel`                                                                                                                                                                                      |
| `src/observe.ts`     | `Observe.Api`: `onHttpResponse` (unified windows, `lastResponse`, extra-usage alert), `onRetry` (long-stall cut, exhaustion record)                                                                                |
| `src/unified.ts`     | Re-export of `Unified` from `@own/protocol` (`parse(headers, observedAt, source?) → Limit.Window[]`: `claude.5h`, `claude.7d`, `claude.overage`; `status`, `statusOf`). Shared with the own-accounts egress relay (04 §8.11.10) |
| `src/extra-usage.ts` | Re-export of `ExtraUsage` from `@own/protocol` (`PHRASES`, `detect(bodyHead)`)                                                                                                                                      |
| `test/**`            | Unit tests with a real runtime (memory vault): `observe.test.ts`, `telemetry.test.ts`                                                                                                                              |

## Hooks (setup, once, scoped `{ providerID: "anthropic" }`, never throw)

| Hook                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session `http.response` | Read-only. `Unified.parse` → `runtime.limits.upsert(windows)` → if any significant change, `runtime.broadcast.emit("limits.updated", { windows })`. `runtime.lastResponse.record(sessionID, …)` (headers subset; status ≥ 400: first 2 KB of `response.clone().text()`). A status ≥ 400 whose body head matches `ExtraUsage.detect` → `broadcast.emit("alert", { code: "claude_extra_usage", severity: "danger", sessionID, accountID: "acc_claude_slot", message })`. Never consume `response.body`. |
| session `retry`         | Long-stall prevention (8.8): last unified status `rejected`, or 429 with retry-after > 15 min → `event.decision = { retry: false }`, `runtime.limits.exhaust({ accountID: "acc_claude_slot", windowId, until, class: "hard" })`, `runtime.ledger.event({ eid, type: "exhausted", … })`, `broadcast.emit("exhausted", …)`. Never chooses a switch target (own-accounts does, 5.9(g), 5.10).                                                                                                            |

## Contracts with own-accounts

- Shared runtime: same `buildId` (release: stamped; source: `"dev"`; tests: plugin option on both) and same `home`.
- Data flows only through `runtime.limits`, `runtime.ledger`, `runtime.lastResponse` and `runtime.broadcast`
  topics `limits.updated`, `exhausted`, `alert` (see `@own/runtime` `Broadcast.Topics`). own-accounts' telemetry
  module listens and emits `quota.updated`, `account.status`, `alert`.
- Ledger step lines for `anthropic` sessions are written by own-accounts from the event stream (02 §7.5), not here.
- Not yet here: usage of `anthropic` `generate` requests (02 §7.5 step 6) needs a runtime channel to own-accounts
  (a broadcast topic or a line written with the session epochs); until then those requests are not in the ledger.
- Secrets: this plugin never reads the vault; the Claude OAuth token belongs to claude-auth (F8). Log only redacted
  fields (`Redact.record`).
