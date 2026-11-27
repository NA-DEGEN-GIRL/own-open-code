// Account presentation rules (03 §5.4, §4.7.1, §5.8.4 summary line), the Claude notice copies (5.4.1 (a), and the
// remote-use one of 04 §8.11.12), the card's pinned template update (07 §4.4 `템플릿 갱신 있음 [갱신]`) and the
// card's SSH host switches (04 §8.11.12: notice → `remote.ack` → `remote.set`, against a fake RPC).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { Account, Limit, Plugin } from "@own/protocol"
import type { HostView } from "@/data"
import { OwnRpcError, type OwnRpc } from "@/data/rpc"
import { createI18n, translate } from "@/i18n"
import { claudeSlotText } from "./claude-slot-strings"
import {
  firstPlanLogin,
  isSharingCode,
  LOGIN_ERRORS,
  loginMethods,
  offersConsent,
  START_ERRORS,
  USAGE_LIMIT_CODE,
  USAGE_URL,
} from "./chatgpt-plan"
import {
  CLAUDE_PIN,
  NOTICE_ITEMS,
  NOTICE_TITLE,
  REMOTE_NOTICE_TEXT,
  remoteNotice,
  remoteNoticeHash,
  riskNotice,
} from "./claude-notice"
import { remoteRows, switchRemoteHost } from "./claude-remote"
import { cardLead, statusText, statusTone } from "./account-card"
import { errorMessage } from "./errors"
import {
  compactionSummary,
  compactionSummaryText,
  defaultLabel,
  identityParts,
  inUse,
  isCodexStale,
  KIND_ORDER,
  nextColor,
  pageSections,
  panelGroups,
  providerIcon,
  refreshCatalogInput,
  shortID,
  templateUpdate,
  TUNABLE_KINDS,
  typeTag,
} from "./model"

const i18n = createI18n("ko")
const NOW = Date.parse("2026-09-27T00:00:00Z")

function account(patch: Omit<Partial<Account.View>, "id"> & { id: string; kind: Account.View["kind"] }): Account.View {
  return {
    label: patch.id,
    shortLabel: "A",
    color: "indigo",
    providerID: `own-${patch.kind}-abcd` as Account.View["providerID"],
    billing: "metered",
    status: "ready",
    autoSwitch: false,
    thirdParty: false,
    readOnly: false,
    connection: { type: "key", method: "api-key" },
    ...patch,
    id: patch.id as Account.View["id"],
  } as Account.View
}

describe("grouping and order (4.7.1, 5.4)", () => {
  test("panel: the session's account first, then accounts in use, groups follow their best account", () => {
    const list = [
      account({ id: "a", kind: "oai" }),
      account({ id: "b", kind: "codex", billing: "subscription", sessions: { running: 1, total: 3 } }),
      account({ id: "c", kind: "ds" }),
      account({ id: "d", kind: "oai", lastUsedAt: NOW - 60_000 }),
    ]
    const groups = panelGroups(list, "c", NOW)
    expect(groups.map((group) => group.kind)).toEqual(["ds", "codex", "oai"])
    expect(groups.find((group) => group.kind === "oai")?.ids.map(String)).toEqual(["d", "a"])
  })

  test("page sections follow the provider order", () => {
    const list = [
      account({ id: "x", kind: "compat" }),
      account({ id: "y", kind: "anth" }),
      account({ id: "z", kind: "anth" }),
    ]
    expect(pageSections(list).map((section) => [section.kind, section.ids.map(String)])).toEqual([
      ["anth", ["y", "z"]],
      ["compat", ["x"]],
    ])
  })

  test("Sign in with ChatGPT accounts get their own section right after the Codex-style ChatGPT ones", () => {
    const list = [
      account({ id: "o", kind: "oai" }),
      account({ id: "s", kind: "siwc", billing: "subscription" }),
      account({ id: "c", kind: "codex", billing: "subscription" }),
    ]
    expect(pageSections(list).map((section) => section.kind)).toEqual(["codex", "siwc", "oai"])
    expect(KIND_ORDER.indexOf("siwc")).toBe(KIND_ORDER.indexOf("codex") + 1)
    expect(TUNABLE_KINDS).toContain("siwc")
    expect(providerIcon("siwc")).toBe("openai")
  })

  test("in use: running, or a step within 24 hours", () => {
    expect(inUse({ sessions: { running: 1, total: 1 }, lastUsedAt: null }, NOW)).toBe(true)
    expect(inUse({ lastUsedAt: NOW - 23 * 3_600_000 }, NOW)).toBe(true)
    expect(inUse({ lastUsedAt: NOW - 25 * 3_600_000 }, NOW)).toBe(false)
  })
})

describe("labels (5.4 display principles)", () => {
  test("type badge: subscription / API / unofficial", () => {
    expect(typeTag({ thirdParty: false, billing: "subscription" })).toBe("subscription")
    expect(typeTag({ thirdParty: false, billing: "prepaid" })).toBe("api")
    expect(typeTag({ thirdParty: true, billing: "subscription" })).toBe("unofficial")
  })

  test("identity lines use masked email, key hint and shortened ids only", () => {
    expect(
      identityParts(i18n, {
        billing: "subscription",
        thirdParty: false,
        identity: { plan: "pro", emailMasked: "pe***@gmail.com" },
      }),
    ).toEqual(["Pro", "pe***@gmail.com"])
    expect(
      identityParts(i18n, {
        billing: "metered",
        thirdParty: false,
        identity: { organizationId: "org-9f2c3a7Qa", workspaceId: "wrkspc_01J9abc3kd", keyHint: "sk-ant-…9fQ2" },
      }),
    ).toEqual(["조직 org-…7Qa", "워크스페이스 wrkspc_…3kd", "키 sk-ant-…9fQ2"])
    expect(shortID("org-abcdefghijk7Qa")).toBe("org-…7Qa")
  })

  test("default names and colors", () => {
    expect(defaultLabel("Anthropic", [])).toBe("Anthropic 1")
    expect(defaultLabel("Anthropic", ["Anthropic 1", "Anthropic 3"])).toBe("Anthropic 2")
    expect(nextColor(["indigo", "teal"])).toBe("amber")
  })

  test("a linked codex login is stale when the router reports auth_failed", () => {
    const linked = { type: "oauth", method: "codex-linked" } as const
    expect(isCodexStale({ status: "auth_failed", connection: linked })).toBe(true)
    expect(isCodexStale({ status: "ready", connection: linked })).toBe(false)
    expect(isCodexStale({ status: "auth_failed", connection: { type: "oauth", method: "chatgpt-device" } })).toBe(false)
  })

  test("a ready account with an exhausted window reads 한도 소진 · 5시간, not 정상", () => {
    // SAFETY: a `quota.snapshot` window as the card reads it.
    const windows = [
      {
        id: "codex.primary",
        accountID: "chatgpt-03",
        providerID: "own-codex-03",
        scope: "account",
        kind: "rolling_quota",
        label: "5시간",
        usedPercent: 100,
        resetAt: NOW + 3_600_000,
        status: "exhausted",
        confidence: "live",
        source: "header",
        observedAt: NOW,
      },
    ] as unknown as Limit.Window[]
    const spent = account({ id: "chatgpt-03", kind: "codex", limitsSummary: { worst: null } })
    expect(statusText(i18n, spent, cardLead(spent, windows, NOW))).toBe("한도 소진 · 5시간")
    expect(statusTone(spent, cardLead(spent, windows, NOW))).toBe("danger")
    const fine = account({ id: "chatgpt-01", kind: "codex", limitsSummary: { worst: null } })
    expect(statusText(i18n, fine, cardLead(fine, [], NOW))).toBe("정상")
    expect(statusTone(fine, cardLead(fine, [], NOW))).toBe("ok")
  })
})

describe("auto-compaction summary line (5.8.4)", () => {
  test("catalog providers display the model limit as core's ceiling, 85% since its 15% reserve (US-1)", () => {
    expect(compactionSummaryText(i18n, compactionSummary("codex", null, undefined))).toBe(
      "자동 압축: 모델 한도 · 창의 85%",
    )
  })

  test("compat uses the model limit too (07 §6.2 #2), which keeps 90% of its window (07 §6.1 R8)", () => {
    expect(compactionSummaryText(i18n, compactionSummary("compat", null, undefined))).toBe(
      "자동 압축: 모델 한도 · 창의 90%",
    )
  })

  test("DeepSeek uses the model limit without an additional cap", () => {
    expect(compactionSummaryText(i18n, compactionSummary("ds", null, undefined))).toBe(
      "자동 압축: 모델 한도 · 창의 85%",
    )
  })

  test("a percentage past the kind's ceiling reads as the ceiling, one below it as set", () => {
    expect(compactionSummary("oai", { triggerPercent: 88 }, undefined).percent).toBe(85)
    expect(compactionSummary("compat", { triggerPercent: 88 }, undefined).percent).toBe(88)
    expect(compactionSummary("oai", { triggerPercent: 84 }, undefined).percent).toBe(84)
  })

  test("a user kind layer and an account setting win in order", () => {
    expect(compactionSummary("ds", null, { ds: { triggerPercent: 70 } })).toMatchObject({
      source: "own.compact.source.kind",
      percent: 70,
      cap: null,
    })
    expect(
      compactionSummary("ds", { triggerPercent: 40, maxTriggerTokens: null }, { ds: { triggerPercent: 70 } }),
    ).toMatchObject({
      source: "own.compact.source.account",
      percent: 40,
      cap: null,
      reserve: 0,
    })
  })

  test("the Claude slot is always the v2 default", () => {
    expect(compactionSummary("claude-sub", { triggerPercent: 40 }, undefined)).toMatchObject({
      source: "own.compact.source.v2",
      percent: 85,
    })
  })
})

describe("pinned template update (07 §4.4)", () => {
  const update = { detectedAt: "2026-10-01T09:00:00.000Z", fields: ["name", "variants"] }
  const codex = account({ id: "acc_chatgpt01", kind: "codex", billing: "subscription", templateUpdate: update })

  test("템플릿 갱신 있음 shows on this PC only: hidden on a phone or another PC's window, and without a change", () => {
    expect(templateUpdate(codex, true)).toEqual(update)
    expect(templateUpdate(codex, false)).toBeUndefined()
    expect(templateUpdate(account({ id: "acc_chatgpt02", kind: "codex" }), true)).toBeUndefined()
  })

  test("[갱신] is accounts.update{refreshCatalog} for the account, nothing else", () => {
    expect(refreshCatalogInput(codex)).toEqual({ accountID: codex.id, refreshCatalog: true })
  })

  test("the card offers [갱신] only where accounts.update may be called, and says how it went", async () => {
    const source = (await Bun.file(path.join(import.meta.dir, "account-card.tsx")).text())
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/^\s*\/\/.*$/gm, "")
    expect(source).toContain('templateUpdate(item(), own.rpc.allowed("accounts.update"))')
    expect(source).toContain('.call("accounts.update", refreshCatalogInput(item))')
    for (const key of [
      "own.acct.templateUpdate.done",
      "own.acct.templateUpdate.failed",
      "own.acct.templateUpdate.apply",
    ])
      expect(source).toContain(`"${key}"`)
  })

  test("the words, in Korean and English", () => {
    expect(translate("ko", "own.acct.templateUpdate")).toBe("템플릿 갱신 있음")
    expect(translate("ko", "own.acct.templateUpdate.apply")).toBe("갱신")
    expect(translate("en", "own.acct.templateUpdate")).toBe("Template update available")
    expect(translate("en", "own.acct.templateUpdate.note")).not.toBe(translate("ko", "own.acct.templateUpdate.note"))
  })
})

describe("Claude risk notice (5.4.1 (a))", () => {
  /** Where each line of `text` sits in the router's notice.ts from `from` on (source literals escape backslashes). */
  const positions = (source: string, text: string, from: number) =>
    text.split("\n").map((line) => source.indexOf(line.replaceAll("\\", "\\\\"), from))

  test("the local notice is information only: the router hashes no copy of it (02 §8.2, 2026-10-18)", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../../own-accounts/src/plugins/notice.ts")).text()
    expect(source).not.toContain(NOTICE_TITLE)
    expect(NOTICE_ITEMS.length).toBeGreaterThan(0)
  })

  test("the remote-use notice is the router's REMOTE_TEXT, line by line (04 §8.11.12)", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../../own-accounts/src/plugins/notice.ts")).text()
    const start = source.indexOf("export const REMOTE_TEXT")
    expect(start).toBeGreaterThan(0)
    // Its lines after the REMOTE_TEXT declaration, in order.
    const remote = positions(source, REMOTE_NOTICE_TEXT, start)
    expect(remote.every((position) => position > start)).toBe(true)
    expect(remote).toEqual(remote.toSorted((a, b) => a - b))
    expect(REMOTE_NOTICE_TEXT.split("\n")).toHaveLength(8)
    expect(await remoteNoticeHash()).toMatch(/^[0-9a-f]{64}$/)
  })

  test("the English remote-use notice is the router's REMOTE_TEXT_EN, line by line, with a hash of its own", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../../own-accounts/src/plugins/notice.ts")).text()
    const start = source.indexOf("export const REMOTE_TEXT_EN")
    expect(start).toBeGreaterThan(0)
    const english = positions(source, remoteNotice("en").text, start)
    expect(english.every((position) => position > start)).toBe(true)
    expect(english).toEqual(english.toSorted((a, b) => a - b))
    expect(remoteNotice("en").text.split("\n")).toHaveLength(8)
    expect(await remoteNoticeHash("en")).not.toBe(await remoteNoticeHash("ko"))
    // The risk notice says the same ten things in both languages.
    expect(riskNotice("en").items).toHaveLength(riskNotice("ko").items.length)
  })
})

describe("Claude on SSH hosts: the card's switches (04 §8.11.12)", () => {
  const AT = "2026-10-09T00:00:00.000Z"
  const BUNDLE = { version: "0.4.0-beta.9", integrity: "sha512-bundle", patchSha256: "a".repeat(64), buildId: null }

  /** A fake `own.rpc.call` of this PC: answers `remote.ack` and `remote.set`, the sets in the order given. */
  function fakePc(sets: ReadonlyArray<"ok" | "consent"> = ["ok"]) {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = []
    const answers = [...sets]
    const call = async (method: string, input: Record<string, unknown>) => {
      calls.push({ method, input })
      if (method === "plugin.claudeAuth.remote.ack") return { acknowledgedAt: AT }
      if (method !== "plugin.claudeAuth.remote.set") throw new Error(`unexpected ${method}`)
      if (answers.shift() === "consent")
        throw new OwnRpcError("ack_required", "remote consent missing", { reason: "remote" })
      return { hostId: input.hostId, enabled: input.enabled, state: input.enabled ? "enabled" : "off" }
    }
    // SAFETY: answers shaped like the two methods' outputs; the flow calls nothing else.
    return { calls, call: call as unknown as OwnRpc["call"] }
  }

  async function status(acknowledged: boolean, noticeHash?: string) {
    return {
      version: "0.4.0-beta.9",
      bundle: BUNDLE,
      remote: {
        acknowledged: acknowledged ? { at: AT, valid: true } : null,
        noticeHash: noticeHash ?? (await remoteNoticeHash()),
        hosts: [],
      },
    }
  }

  test("the first switch on shows the notice, then remote.ack with the bundle's pin and the notice hash, then remote.set", async () => {
    const pc = fakePc()
    let shown = 0
    const result = await switchRemoteHost({
      locale: "ko",
      call: pc.call,
      status: await status(false),
      hostId: "h-devbox1",
      enabled: true,
      notice: async () => {
        shown++
        // The notice comes before anything is sent.
        expect(pc.calls).toEqual([])
        return true
      },
    })
    expect(shown).toBe(1)
    expect(pc.calls.map((entry) => entry.method)).toEqual([
      "plugin.claudeAuth.remote.ack",
      "plugin.claudeAuth.remote.set",
    ])
    expect(pc.calls[0]!.input).toEqual({
      version: BUNDLE.version,
      integrity: BUNDLE.integrity,
      noticeHash: await remoteNoticeHash(),
    })
    expect(pc.calls[1]!.input).toEqual({ hostId: "h-devbox1", enabled: true })
    expect(result).toEqual({ kind: "set", host: { hostId: "h-devbox1", enabled: true, state: "enabled" } })
  })

  test("on an English screen the consent carries the hash of the English notice; the service is still known by the Korean one", async () => {
    const pc = fakePc()
    const result = await switchRemoteHost({
      locale: "en",
      call: pc.call,
      status: await status(false),
      hostId: "h-devbox1",
      enabled: true,
      notice: async () => true,
    })
    expect(pc.calls[0]!.input.noticeHash).toBe(await remoteNoticeHash("en"))
    expect(result.kind).toBe("set")
  })

  test("a service before the bundle (no `bundle` in its status) gets the app's pinned integrity", async () => {
    const pc = fakePc()
    await switchRemoteHost({
      locale: "ko",
      call: pc.call,
      status: { ...(await status(false)), bundle: undefined },
      hostId: "h-devbox1",
      enabled: true,
      notice: async () => true,
    })
    expect(pc.calls[0]!.input).toMatchObject({ version: "0.4.0-beta.9", integrity: CLAUDE_PIN.integrity })
  })

  test("closing the notice sends nothing", async () => {
    const pc = fakePc()
    const result = await switchRemoteHost({
      locale: "ko",
      call: pc.call,
      status: await status(false),
      hostId: "h-devbox1",
      enabled: true,
      notice: async () => false,
    })
    expect(result).toEqual({ kind: "declined" })
    expect(pc.calls).toEqual([])
  })

  test("a set answered with ack_required{remote} asks once, then acknowledges and sets again", async () => {
    const pc = fakePc(["consent", "ok"])
    let shown = 0
    const result = await switchRemoteHost({
      locale: "ko",
      call: pc.call,
      status: await status(true),
      hostId: "h-devbox1",
      enabled: true,
      notice: async () => {
        shown++
        return true
      },
    })
    expect(shown).toBe(1)
    expect(pc.calls.map((entry) => entry.method)).toEqual([
      "plugin.claudeAuth.remote.set",
      "plugin.claudeAuth.remote.ack",
      "plugin.claudeAuth.remote.set",
    ])
    expect(result.kind).toBe("set")
  })

  test("switching off never asks, consent or not", async () => {
    const pc = fakePc()
    const result = await switchRemoteHost({
      locale: "ko",
      call: pc.call,
      status: await status(false),
      hostId: "h-devbox1",
      enabled: false,
      notice: async () => {
        throw new Error("the notice is not for switching off")
      },
    })
    expect(pc.calls).toEqual([
      { method: "plugin.claudeAuth.remote.set", input: { hostId: "h-devbox1", enabled: false } },
    ])
    expect(result).toEqual({ kind: "set", host: { hostId: "h-devbox1", enabled: false, state: "off" } })
  })

  test("a notice copy the service does not hash is not shown and nothing is sent", async () => {
    const pc = fakePc()
    const result = await switchRemoteHost({
      locale: "ko",
      call: pc.call,
      status: await status(false, "0".repeat(64)),
      hostId: "h-devbox1",
      enabled: true,
      notice: async () => {
        throw new Error("a stale notice is not shown")
      },
    })
    expect(result).toEqual({ kind: "stale" })
    expect(pc.calls).toEqual([])
  })

  test("rows: every listed host by name with its switch and verdict, then switched-on hosts the list lost", () => {
    const host = (id: string, name: string, claude?: Plugin.ClaudeRemoteState) =>
      // SAFETY: only the fields the rows read; the rest of a `hosts.list` row does not matter here.
      ({
        id,
        name,
        broker: {
          state: "connected",
          ...(claude ? { claude: { state: claude, inflight: 0, lastError: null, holdUntil: null } } : {}),
        },
      }) as unknown as HostView
    const rows = remoteRows(
      {
        acknowledged: { at: AT, valid: true },
        noticeHash: "",
        hosts: [
          { hostId: "h-devbox1", enabled: true, state: "enabled" },
          { hostId: "h-gone001", enabled: true, state: "enabled" },
          { hostId: "h-gone002", enabled: false, state: "off" },
        ],
      },
      {
        order: ["h-devbox1", "h-build01", "h-other01"],
        hosts: {
          "h-devbox1": host("h-devbox1", "devbox"),
          "h-build01": host("h-build01", "build", "host_scope"),
          "h-other01": host("h-other01", "other"),
        },
      },
    )
    expect(rows.map((row) => [row.hostId, row.name, row.enabled, row.state])).toEqual([
      ["h-devbox1", "devbox", true, "enabled"],
      ["h-build01", "build", false, "host_scope"],
      ["h-other01", "other", false, "off"],
      ["h-gone001", "h-gone001", true, "enabled"],
    ])
  })

  test("the card shows the section on this PC's status only, and switches only where remote.set may be called", async () => {
    const source = (await Bun.file(path.join(import.meta.dir, "claude-slot.tsx")).text())
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/^\s*\/\/.*$/gm, "")
    expect(source).toContain("<Show when={claude()?.remote}>")
    expect(source).toContain('own.rpc.allowed("plugin.claudeAuth.remote.set")')
    expect(source).toContain("switchRemoteHost({")
    expect(source).toContain('st("own.claude.remote.notice.continue")')
    expect(source).toContain("{notice().check}")
    // SLM: the switches are the whole slot's (every Claude account of this PC), so they come after all the accounts'
    // cards in a block of their own, never inside account 1's card.
    const slotCard = source.indexOf('data-testid="claude-slot-card"')
    const slotCardEnd = source.indexOf("</article>", slotCard)
    const added = source.indexOf("<For each={added()}>")
    const block = source.indexOf('data-testid="claude-remote-block"')
    expect(slotCard).toBeGreaterThan(0)
    expect(added).toBeGreaterThan(slotCardEnd)
    expect(block).toBeGreaterThan(added)
    expect(source.slice(slotCard, slotCardEnd)).not.toContain("<ClaudeRemote")
    expect(claudeSlotText.text("ko", "own.claude.remote.help")).toContain("이 PC의 모든 Claude 구독 계정")
    // The unofficial badge stays on the slot's rows and on the notice.
    expect(source.match(/own\.accounts\.type\.unofficial/g)?.length).toBeGreaterThanOrEqual(3)
    expect(source).toContain('i18n.t("own.claude.badge")')
  })

  test("the words, in Korean and English", () => {
    expect(claudeSlotText.text("ko", "own.claude.remote.title")).toBe("SSH 원격 호스트에서 쓰기")
    expect(claudeSlotText.text("ko", "own.claude.remote.notice.continue")).toBe("동의하고 켜기")
    expect(translate("ko", "own.claude.remote.state.reauth")).toBe(
      "Anthropic이 로그인을 거절했어요. 이 PC에서 Claude Code에 다시 로그인하세요",
    )
    for (const key of [
      "own.claude.remote.title",
      "own.claude.remote.help",
      "own.claude.remote.others",
      "own.claude.remote.notice.title",
      "own.claude.remote.notice.continue",
    ] as const)
      expect(claudeSlotText.text("en", key)).not.toBe(claudeSlotText.text("ko", key))
    for (const key of [
      "own.claude.remote.state.enabled",
      "own.claude.remote.state.off",
      "own.claude.remote.state.hostScope",
      "own.claude.remote.state.consent",
      "own.claude.remote.state.notReady",
      "own.claude.remote.state.billing",
      "own.claude.remote.state.disconnected",
      "own.claude.remote.state.reauth",
    ] as const)
      expect(translate("en", key)).not.toBe(translate("ko", key))
  })
})

describe("Sign in with ChatGPT (5.4, 02 §3.2c)", () => {
  test("a failed connection test names the token-sharing code, not a rejected key", () => {
    const probe = (data: Record<string, unknown>) =>
      errorMessage(i18n, new OwnRpcError("probe_failed", "probe_failed", data))
    const code = "subscription_sharing_user_not_eligible"
    expect(isSharingCode(code)).toBe(true)
    expect(probe({ status: 403, message: code })).toBe(i18n.t("own.acct.err.probe", { reason: code }))
    expect(probe({ status: 429, message: USAGE_LIMIT_CODE })).toBe(i18n.t("own.chatgpt.usageLimit"))
    // API keys and statuses without a code keep the key sentence.
    expect(isSharingCode("http_403")).toBe(false)
    expect(probe({ status: 403, message: "http_403" })).toBe(i18n.t("own.accounts.testFail", { status: 403 }))
  })

  test("a new login offers all three methods; a re-login keeps its account's kind", () => {
    expect(loginMethods(undefined)).toEqual(["device", "browser", "siwc"])
    expect(loginMethods("codex")).toEqual(["device", "browser"])
    expect(loginMethods("siwc")).toEqual(["siwc"])
  })

  test("login errors with their own notice, in Korean and English", () => {
    for (const error of ["token_sharing_not_granted", "client_mismatch", "id_token_invalid", "identity_missing"])
      expect(LOGIN_ERRORS[error]).toBeDefined()
    expect(LOGIN_ERRORS.account_mismatch).toBeUndefined()
    for (const key of [...Object.values(LOGIN_ERRORS), ...Object.values(START_ERRORS)])
      expect(translate("en", key)).not.toBe(translate("ko", key))
    expect(translate("ko", "own.chatgpt.siwc")).toBe("Sign in with ChatGPT")
    expect(translate("en", "own.chatgpt.siwc")).toBe("Sign in with ChatGPT")
  })

  test("consent is offered only after a Sign in with ChatGPT attempt ended without plan use", () => {
    expect(offersConsent("siwc", "token_sharing_not_granted")).toBe(true)
    expect(offersConsent("siwc", "authorization_denied")).toBe(true)
    expect(offersConsent("browser", "authorization_denied")).toBe(false)
    expect(offersConsent("siwc", "client_mismatch")).toBe(false)
    expect(offersConsent(undefined, undefined)).toBe(false)
  })

  test("the connected notice shows once per browser; a blocked storage cannot remember, so it shows", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    expect(firstPlanLogin(storage)).toBe(true)
    expect(firstPlanLogin(storage)).toBe(false)
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked")
      },
      setItem: () => undefined,
    }
    expect(firstPlanLogin(blocked)).toBe(true)
  })

  test("the usage page and the usage-limit code match the router, and the banner's inline copy", async () => {
    const root = path.join(import.meta.dir, "../../..")
    const sharing = await Bun.file(path.join(root, "own-accounts/src/credentials/sharing.ts")).text()
    expect(sharing).toContain(`USAGE_URL = "${USAGE_URL}"`)
    const classify = await Bun.file(path.join(root, "own-accounts/src/telemetry/classify.ts")).text()
    expect(classify).toContain(`{ code: "${USAGE_LIMIT_CODE}", outcome: "hard" }`)
    const banners = await Bun.file(path.join(import.meta.dir, "../shell/session-banners.tsx")).text()
    expect(banners).toContain(`"${USAGE_LIMIT_CODE}"`)
  })
})
