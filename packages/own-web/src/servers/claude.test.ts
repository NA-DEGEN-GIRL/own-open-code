// The Claude subscription slot on SSH hosts (04 §8.11.13): the verdict own-web reads from this PC's `hosts.list` row
// and the host's `health.claudeSlot`, the switcher's reason row for each verdict (and the models with `PC 경유` when
// `enabled`), the words of the Claude card and of 설정 > 원격 호스트, and the strings. Solid components do not render
// under `bun test`, so the switcher's and the header's wiring is checked in their source. Every host is made up.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { Plugin } from "@own/protocol"
import type { HostView } from "@/data"
import { en } from "@/i18n/en"
import { ko } from "@/i18n/ko"
import { remoteEn, remoteKo, remoteText } from "@/remote/strings"
import { claudeEmpty, claudeHostState, claudeVerdict, viaPc, type ClaudeVerdict } from "./claude"
import { serversEn, serversKo, serversText } from "./strings"

type Broker = HostView["broker"]["state"]

function host(broker: Broker, claude?: Plugin.ClaudeRemoteState, relay: Partial<Relay> = {}) {
  // SAFETY: only the broker view the helpers read; the rest of a `hosts.list` row does not matter here.
  return {
    broker: {
      state: broker,
      ...(claude ? { claude: { state: claude, inflight: 0, lastError: null, holdUntil: null, ...relay } } : {}),
    },
  } as unknown as HostView
}

interface Relay {
  readonly lastError: string | null
  readonly holdUntil: number | null
}

const NOW = Date.parse("2026-10-09T12:00:00Z")
const health = (state: Plugin.ClaudeRemoteState | null, conflict = false) => ({ state, conflict })

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(path.join(import.meta.dir, file)).text())
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

describe("the verdict of a host (04 §8.11.4.3)", () => {
  test("the PC's verdict from hosts.list, every state as it is", () => {
    for (const state of ["not_ready", "billing", "off", "consent", "host_scope", "enabled"] as const)
      expect(claudeVerdict(host("connected", state), health(null))).toBe(state)
  })

  test("a host with its own Claude login is a conflict, whatever the PC says", () => {
    expect(claudeVerdict(host("connected", "enabled"), health("enabled", true))).toBe("conflict")
  })

  test("enabled while the host's broker is not connected to this PC is offline; other verdicts stay", () => {
    expect(claudeVerdict(host("disconnected", "enabled"), health("enabled"))).toBe("offline")
    expect(claudeVerdict(host("auth_failed", "enabled"), undefined)).toBe("offline")
    expect(claudeVerdict(host("disconnected", "off"), undefined)).toBe("off")
  })

  test("without this PC's row the host's mirrored verdict decides; with nothing known it is offline", () => {
    expect(claudeVerdict(undefined, health("enabled"))).toBe("enabled")
    expect(claudeVerdict(undefined, health("consent"))).toBe("consent")
    expect(claudeVerdict(undefined, health(null))).toBe("offline")
    expect(claudeVerdict(undefined, undefined)).toBe("offline")
  })

  test("a connected host without a relay view: this PC has no slot", () => {
    expect(claudeVerdict(host("connected"), health(null))).toBe("not_ready")
    expect(claudeVerdict(host("unarmed"), health(null))).toBe("offline")
  })
})

describe("the switcher on a remote session (04 §8.11.13 표시 규칙)", () => {
  const reasons: ReadonlyArray<[ClaudeVerdict, string, "accounts" | "host"]> = [
    ["off", "PC에서 이 호스트의 Claude 구독이 꺼져 있어요 — PC의 Claude 카드에서 켜세요", "accounts"],
    ["consent", "PC에서 원격 사용 동의가 필요해요", "accounts"],
    ["not_ready", "PC의 Claude 구독이 준비되지 않았어요(플러그인·로그인)", "accounts"],
    ["billing", "PC의 Anthropic 연결이 API 키라 원격에서 쓰지 않아요", "accounts"],
    ["host_scope", "이 호스트의 계정 범위에 Claude 구독이 없어요", "host"],
    ["offline", "PC와 연결되면 쓸 수 있어요", "host"],
    ["conflict", "이 호스트에 다른 Claude 로그인이나 claude-auth 플러그인이 있어 쓰지 않아요", "host"],
  ]

  test("an empty Claude group shows the reason of each verdict and where to fix it, never an endless loading", () => {
    for (const [verdict, text, fix] of reasons) {
      const reason = claudeEmpty(verdict, "claude-sub", 0)
      expect(reason?.fix).toBe(fix)
      expect(reason && remoteText("ko", reason.key)).toBe(text)
      expect(viaPc(verdict, "claude-sub")).toBe(false)
    }
  })

  test("enabled: the Claude models show with `PC 경유`; no reason row while they load", () => {
    expect(claudeEmpty("enabled", "claude-sub", 3)).toBeUndefined()
    expect(claudeEmpty("enabled", "claude-sub", 0)).toBeUndefined()
    expect(viaPc("enabled", "claude-sub")).toBe(true)
    expect(serversText("ko", "own.remote.claudeSlot.badge")).toBe("PC 경유")
    expect(serversText("ko", "own.remote.claudeSlot.badgeHelp")).toBe("이 호스트의 Claude 요청은 이 PC를 거쳐 나가요")
  })

  test("other accounts, models already listed, and this PC are left alone", () => {
    expect(claudeEmpty("off", "codex", 0)).toBeUndefined()
    expect(claudeEmpty("off", "claude-sub", 2)).toBeUndefined()
    expect(claudeEmpty(undefined, "claude-sub", 0)).toBeUndefined()
    expect(viaPc(undefined, "claude-sub")).toBe(false)
    expect(viaPc("enabled", "anth")).toBe(false)
  })

  test("the popover puts the reason row in the empty models column and the chip on the Claude account", async () => {
    const source = await code("../switcher/popover.tsx")
    expect(source).toContain("claudeEmpty(claude(), account()?.kind, models(account()).length)")
    // The reason row is the models list's fallback, before the loading line (and a failed catalog's line, ML).
    const list = source.indexOf("each={modelList()}")
    const reason = source.indexOf('data-testid="switcher-claude-reason"')
    expect(list).toBeGreaterThan(0)
    expect(reason).toBeGreaterThan(list)
    expect(source.slice(list, reason)).toContain("when={claudeBlocked()}")
    expect(source.slice(list, reason)).toContain('<p class="own-sw-empty">{i18n.t("own.shell.loading")}</p>')
    expect(source).toContain("remoteText(reason().key)")
    expect(source).toContain('router.navigate({ name: "accounts" })')
    expect(source).toContain('router.navigate({ name: "settings", section: "remote" })')
    // 04 §8.14: a local model of this PC on an SSH host goes through the PC too.
    expect(source).toContain('viaPc={viaPc(claude(), item.kind) || (runtime.kind === "ssh" && isLocal(item))}')
    expect(source).toContain('remoteText("own.remote.localModel.badgeHelp")')
    expect(source).toContain('servers("own.remote.claudeSlot.badge")')
    // The verdict changes without an own.remote event: read the hosts' broker views on every open on a host.
    expect(source).toContain('if (runtime.kind === "ssh") void remoteStore()?.refreshBroker()')
  })

  test("the session header's pill carries the same chip", async () => {
    const source = await code("../switcher/pill.tsx")
    expect(source).toContain("viaPc(serverClaude(runtime()), account()?.kind)")
    expect(source).toContain('data-testid="running-on-via-pc"')
  })
})

describe("one host's word on the Claude card and in 설정 > 원격 호스트", () => {
  test("each verdict, then connection and Anthropic's hold for a switched-on host", () => {
    expect(claudeHostState("off", host("connected", "off"), NOW)).toBe("off")
    expect(claudeHostState("host_scope", host("connected", "host_scope"), NOW)).toBe("hostScope")
    expect(claudeHostState("consent", undefined, NOW)).toBe("consent")
    expect(claudeHostState("not_ready", undefined, NOW)).toBe("notReady")
    expect(claudeHostState("billing", undefined, NOW)).toBe("billing")
    expect(claudeHostState("enabled", host("connected", "enabled"), NOW)).toBe("enabled")
    expect(claudeHostState("enabled", host("disconnected", "enabled"), NOW)).toBe("disconnected")
    expect(claudeHostState("enabled", undefined, NOW)).toBe("disconnected")
    const held = host("connected", "enabled", { lastError: "needs_reauth", holdUntil: NOW + 30_000 })
    expect(claudeHostState("enabled", held, NOW)).toBe("reauth")
    const over = host("connected", "enabled", { lastError: "needs_reauth", holdUntil: NOW - 1 })
    expect(claudeHostState("enabled", over, NOW)).toBe("enabled")
  })

  test("the host panel names the state with the hint that it is switched on the Claude card", async () => {
    const source = await code("../remote/settings.tsx")
    expect(source).toContain('<Row label={text("own.remote.settings.claude")}>')
    expect(source).toContain('text("own.remote.settings.claudeHint")')
    expect(source).toContain("claudeHostState(relay().state, view(), minuteNow())")
    expect(remoteText("ko", "own.remote.settings.claude")).toBe("Claude 구독")
    expect(remoteText("ko", "own.remote.settings.claudeHint")).toBe("PC의 Claude 카드에서 켜고 꺼요")
  })
})

describe("strings (04 §8.11.13)", () => {
  test("every own.remote key of the table, in Korean and English", () => {
    const remote = [
      "own.remote.settings.claude",
      "own.remote.settings.claudeHint",
      "own.remote.claudeSlot.off",
      "own.remote.claudeSlot.hostScope",
      "own.remote.claudeSlot.consent",
      "own.remote.claudeSlot.notReady",
      "own.remote.claudeSlot.billing",
      "own.remote.claudeSlot.offline",
      "own.remote.claudeSlot.conflict",
    ] as const
    for (const key of remote) expect(remoteEn[key]).toBeDefined()
    for (const key of remote) expect(remoteEn[key]).not.toBe(remoteKo[key])
    const first = [
      "own.remote.claudeSlot.badge",
      "own.remote.claudeSlot.badgeHelp",
      "own.remote.claudeSlot.fastLocal",
    ] as const
    for (const key of first) expect(serversEn[key]).toBeDefined()
    for (const key of first) expect(serversEn[key]).not.toBe(serversKo[key])
    expect(serversText("ko", "own.remote.claudeSlot.fastLocal")).toBe("Fast 동의는 이 PC에 한 번 기록해요")
  })

  test("`own.remote.claudeSlot.unavailable` is gone from every catalog", () => {
    for (const catalog of [ko, en, remoteKo, remoteEn, serversKo, serversEn])
      expect(Object.keys(catalog).filter((key) => key.endsWith("claudeSlot.unavailable"))).toEqual([])
  })
})
