// One ranking for every surface and for the server (03 §7.2, LV 2026-10-24): the sidebar and composer glance, the
// switcher row, the cards, the 계정·한도 tab, the dashboard, the ultra line and the team view lead with the same window,
// from own-protocol's `LimitRank` (./windows `ranked`), and own-accounts names the account's state (the card's tag, its
// words) with the same first window. The fixtures are own-protocol's test/limit-leads.ts, which own-protocol and
// own-accounts check too: the cases where surfaces, or the server and the screen, used to disagree. The browser e2e
// (accounts-limits.spec.ts) renders the surfaces with the same set.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { LEADS, LEADS_AT, window } from "../../../own-protocol/test/limit-leads"
import { cardLead, statusText, statusTone } from "@/accounts/account-card"
import { createI18n } from "@/i18n"
import { windowValue } from "./display"
import { foldedParts } from "./summary-model"
import { ranked, tighter, tightest } from "./windows"

const i18n = createI18n("ko")

describe("the leading window", () => {
  for (const fixture of LEADS)
    test(fixture.name, () => {
      const first = tightest(fixture.windows, LEADS_AT, fixture.model)
      expect(first?.id).toBe(fixture.lead)
      expect(windowValue(i18n, first!)).toBe(fixture.value)
      // The glance draws `ranked(...)`'s first ones; the summary line and the switcher row name the same first.
      expect(ranked(fixture.windows, LEADS_AT, fixture.model)[0]?.id).toBe(fixture.lead)
      expect(foldedParts(i18n, fixture.windows, LEADS_AT, 1, undefined, fixture.model)[0]).toMatchObject({
        key: fixture.lead,
        text: `${first!.label} ${fixture.value}`,
      })
    })

  test("the dashboard's line ranks the accounts' leads in the same order", () => {
    const leads = LEADS.filter((fixture) => fixture.model === undefined).map(
      (fixture) => tightest(fixture.windows, LEADS_AT)!,
    )
    expect(leads.toSorted(tighter).map((item) => item.id)).toEqual([
      "ds.balance",
      "claude.5h",
      "codex.primary",
      "claude.7d",
      "claude.7d",
      "claude.7d",
      "ds.balance",
    ])
  })

  test("the card's state names the lead of the same ranking: 주의 by its bar, 한도 소진 when used up", () => {
    // `limitsSummary.worst` as own-accounts' `Views.summary` builds it from the lead (own-accounts unified.test.ts).
    const card = (
      worst: {
        id: string
        label?: string
        usedPercent: number | null
        status: "ok" | "warning" | "exhausted"
      } | null,
    ) =>
      ({
        id: "acc_a",
        kind: "oai",
        status: "ready",
        connection: { type: "key", method: "key" },
        limitsSummary: { worst },
      }) as unknown as Parameters<typeof statusTone>[0]
    const state = (worst: Parameters<typeof card>[0], windows?: Parameters<typeof cardLead>[1]) => {
      const lead = cardLead(card(worst), windows, LEADS_AT)
      return [statusTone(card(worst), lead), statusText(i18n, card(worst), lead)]
    }
    // A week at 80 % beside a 5 hours past its threshold at 50 %: the week leads, and its bar warns.
    const week = [
      window({ id: "claude.5h", label: "5시간", usedPercent: 50, status: "warning" }),
      window({ id: "claude.7d", label: "주간", usedPercent: 80 }),
    ]
    expect(state(null, week)).toEqual(["warn", "주의 · 주간 남음 20%"])
    expect(state(null, [window({ id: "claude.7d", label: "주간", usedPercent: 60 })])).toEqual(["ok", "정상"])
    expect(state(null, [window({ id: "claude.5h", label: "5시간", status: "exhausted" })])).toEqual([
      "danger",
      "한도 소진 · 5시간",
    ])
    // The screen's windows decide once loaded, whatever the list said when it was read (a spend sends no
    // `accounts.changed`); the list's state stands in only before they are.
    expect(state({ id: "claude.7d", usedPercent: 60, status: "ok" }, week)[0]).toBe("warn")
    expect(state({ id: "claude.7d", usedPercent: 80, status: "ok" }, [])).toEqual(["ok", "정상"])
    expect(state({ id: "claude.7d", usedPercent: 80, status: "ok" })[0]).toBe("warn")
    expect(state({ id: "claude.5h", usedPercent: null, status: "exhausted" })[0]).toBe("danger")
    // Before the snapshot the list names the window by the label it carries, and an older service's list (no label)
    // leaves the state word alone (the fifth review: `주의 ·  남음 16%`).
    expect(state({ id: "claude.5h", label: "5시간", usedPercent: 84, status: "ok" })).toEqual([
      "warn",
      "주의 · 5시간 남음 16%",
    ])
    expect(state({ id: "claude.5h", usedPercent: 84, status: "ok" })).toEqual(["warn", "주의"])
    expect(state({ id: "claude.5h", label: "5시간", usedPercent: null, status: "exhausted" })).toEqual([
      "danger",
      "한도 소진 · 5시간",
    ])
    expect(state({ id: "claude.5h", usedPercent: null, status: "exhausted" })).toEqual(["danger", "한도 소진"])
  })
})

describe("wiring: every surface and the server lead through the one ranking", () => {
  /** Source without comments, so names in comments are not taken for code. */
  const code = async (file: string) =>
    (await Bun.file(path.join(import.meta.dir, "..", file)).text())
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/^\s*\/\/.*$/gm, "")

  test("each surface calls it with its model, and none sorts windows of its own", async () => {
    const uses: Record<string, readonly string[]> = {
      "limits/windows.ts": ["LimitRank.ranked(windows, now, model)"],
      "limits/glance.tsx": ["ranked(props.windows ?? [], props.now(), props.model)"],
      "limits/summary-line.tsx": [
        "foldedParts(i18n, props.windows ?? [], props.now(), props.max ?? 2, undefined, props.model)",
      ],
      "limits/summary.tsx": ["model={props.model}"],
      "composer/binding-button.tsx": ["<LimitGlance", "model={props.view?.ref?.id}"],
      "sidebar/accounts-in-use.tsx": ["<LimitGlance", "tightest("],
      "sidebar/controller.ts": ["tightest(accounts.state.quota[account.id] ?? [], minuteNow(), model(sessionID)?.id)"],
      "switcher/popover.tsx": [
        "<LimitSummaryLine",
        "model={props.model}",
        "model={modelOf(item)}",
        "unusable(selected, own.state.quota[selected.id], modelOf(selected))",
        // Every group's 추천 on the whole list, whichever row is selected (review 5, finding 1).
        "recommendedAccounts(accounts(), own.state.quota, now(), modelOf, hasTurns())",
        // One rule for every row, and selecting a row chooses what it ranked with (review 3, finding 2), from the
        // picked model, which the cursor never changes (review 4, finding 2).
        "rowModel(state.picked, models(item), own.state.groupDefaults[item.kind])",
        "rowSelection(state.picked, accountID, models(next), own.state.groupDefaults[next.kind])",
      ],
      "switcher/picker.ts": [
        "LimitRank.ranked(quota[account.id] ?? [], now, model(account))",
        "groupAccounts(accounts).flatMap((group) => recommendedAccount(group.accounts, quota, now, model) ?? [])",
      ],
      // The import dialog's 추천 and headroom alternatives, with the model picking an account would choose, on the
      // minute clock (review 4, finding 5).
      "import/dialog.tsx": [
        "recommendedAccounts(listed().shown, own.state.quota, minuteNow(), runs)",
        "headroomRanked(listed().shown, account(), own.state.quota, minuteNow(), runs)",
      ],
      "import/model.ts": ["LimitRank.ranked(quota[account.id] ?? [], now, model(account))"],
      "limits/panel-tab.tsx": ["<AccountLimits", "model={model()}"],
      // The tag reads the screen's windows on the minute clock; the list's state only until they are loaded.
      "accounts/account-card.tsx": [
        "<AccountLimits",
        "tightest(windows, now)",
        "cardLead(item, own.state.quota[props.id] ?? (own.state.quotaLoaded ? [] : undefined), minuteNow())",
      ],
      "accounts/claude-slot.tsx": ["<AccountLimits"],
      "accounts/claude-accounts.tsx": ["<AccountLimits"],
      "limits/index.tsx": ["<AccountLimits", "tightest(", "tighter(a.item, b.item)"],
      "composer/preset-button.tsx": ["tightest(own().state.quota[accountID] ?? [], minuteNow(), ref()?.id)"],
    }
    for (const [file, needles] of Object.entries(uses)) {
      const source = await code(file)
      for (const needle of needles) expect(`${file}: ${source.includes(needle)}`).toBe(`${file}: true`)
      expect(`${file}: ${/percent \?\? 0\) -|usedPercent \?\? 0\) -|STATUS_RANK/.test(source)}`).toBe(`${file}: false`)
      // Every lead and badge ranks on the minute clock, never on a time that stands still while the screen is open
      // (review 5, finding 5: the ultra line and the team view's usage read `Date.now()`).
      const frozen = /(tightest|ranked|recommendedAccounts?|headroomRanked|cardLead|foldedParts)\([^\n]*Date\.now\(\)/
      expect(`${file}: ${frozen.test(source)}`).toBe(`${file}: false`)
    }
    // 추천 never filters the list by the selected row's kind (review 5, finding 1).
    expect(await code("switcher/popover.tsx")).not.toMatch(/recommendedAccount\(\s*accounts\(\)\.filter/)
  })

  test("the speed menus' rest counts down on the minute clock (review 4, finding 5)", async () => {
    const button = await code("composer/speed-button.tsx")
    expect(button).toContain("offerNote(i18n, item.offer, minuteNow())")
    expect(button).toContain("offerBadge(i18n, item.offer, minuteNow())")
    const switcher = await code("switcher/popover.tsx")
    expect(switcher).toContain("const now = minuteNow")
    expect(switcher).toContain("offerNote(i18n, item.offer, now())")
    expect(switcher).toContain("offerBadge(i18n, item.offer, now())")
    for (const source of [button, switcher]) expect(/offer(Note|Badge)\(i18n, item\.offer\)/.test(source)).toBe(false)
  })

  test("moving between accounts never changes the picked model: only open, a model, an effort or a target set it", async () => {
    const source = await code("switcher/popover.tsx")
    const body = (name: string) => source.slice(source.indexOf(`function ${name}(`)).split("\n  }\n")[0]!
    for (const name of ["selectAccount", "selectSame"])
      expect(`${name}: ${body(name).includes("picked:")}`).toBe(`${name}: false`)
    for (const name of ["selectModel", "selectVariant", "selectTarget"]) expect(body(name)).toContain("picked")
    expect(source).not.toContain("picked()")
  })

  test("the server's account state is the same ranking's first window, never a sort of its own", async () => {
    const views = await code(path.join("..", "..", "own-accounts", "src", "slots", "views.ts"))
    expect(views).toContain("LimitRank.ranked(windows, now)[0]")
    expect(/STATUS_RANK|usedPercent \?\? -1\)|toSorted\(/.test(views)).toBe(false)
  })
})
