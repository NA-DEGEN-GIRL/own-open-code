// Reset and clock texts of every limit surface (03 §7.2, LV 2026-10-24) in the user's zone, Asia/Seoul, across a
// weekday wrap: within 24 hours relative, within 6 days on another weekday the weekday and the clock, otherwise the
// date; never a bare weekday that could be today's next week; one clock style folded, unfolded and on hover.
// Intl formatters keep the zone they were made in, so under another zone this file runs itself again in a Bun of its
// own started with TZ=Asia/Seoul.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Unified } from "@own/protocol"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { offerBadge } from "@/composer/speed"
import { createI18n } from "@/i18n"
import { confirmView } from "@/team/confirm"
import { areaStatus, noticeText, type TeamText } from "@/team/model"
import { teamText } from "@/team/strings"
import { windowsTitle } from "./display"
import { absolute, coming, resetText, resetTitle, when } from "./format"
import { foldedParts, resetLong } from "./summary-model"

const SEOUL = process.env.TZ === "Asia/Seoul"
const ko = createI18n("ko")
const en = createI18n("en")
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Saturday 2026-10-24 23:30 in Seoul (UTC+9, no daylight saving). */
const NOW = Date.UTC(2026, 9, 24, 14, 30)
/** A Seoul wall-clock time as an instant. */
const seoul = (month: number, day: number, hour: number, minute = 0) => Date.UTC(2026, month - 1, day, hour - 9, minute)

test.skipIf(SEOUL)("runs under TZ=Asia/Seoul", () => {
  const run = Bun.spawnSync(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "../ui/test/solid-jsx.ts",
      import.meta.path,
    ],
    {
      cwd: path.join(import.meta.dir, "..", ".."),
      env: { ...process.env, TZ: "Asia/Seoul" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = `${run.stdout.toString()}${run.stderr.toString()}`
  expect(output).toMatch(/\b[1-9]\d* pass\b/)
  expect(output).toContain(" 0 fail")
  expect(run.exitCode).toBe(0)
})

describe.skipIf(!SEOUL)("reset texts in Asia/Seoul", () => {
  test("the zone is Seoul's", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Asia/Seoul")
    expect(new Date(NOW).getDay()).toBe(6)
  })

  test("within 24 hours relative, also past midnight; the unfolded clock names the new day", () => {
    expect(resetText(ko, NOW, NOW + 42 * MIN)).toBe("42분 후 리셋")
    expect(resetLong(ko, NOW, NOW + 42 * MIN)).toBe("42분 후 리셋 (일 오전 12:12)")
    expect(resetText(ko, NOW, seoul(10, 25, 0, 30))).toBe("1시간 후 리셋")
    expect(resetText(ko, NOW, seoul(10, 25, 23, 0))).toBe("23시간 30분 후 리셋")
    expect(resetLong(ko, NOW, seoul(10, 25, 23, 0))).toBe("23시간 30분 후 리셋 (일 오후 11:00)")
    expect(resetLong(ko, NOW, NOW + 10 * MIN)).toBe("10분 후 리셋 (오후 11:40)")
  })

  test("within 6 days on another weekday: the weekday and the clock", () => {
    expect(resetText(ko, NOW, seoul(10, 26, 9))).toBe("월 오전 9:00 리셋")
    expect(resetLong(ko, NOW, seoul(10, 26, 9))).toBe("1일 9시간 후 리셋 (월 오전 9:00)")
    expect(resetText(ko, NOW, seoul(10, 30, 9))).toBe("금 오전 9:00 리셋")
    // Exactly 6 days on, Friday night.
    expect(resetText(ko, NOW, NOW + 6 * DAY)).toBe("금 오후 11:30 리셋")
    expect(resetText(en, NOW, seoul(10, 26, 9))).toBe("resets Mon 9:00 AM")
  })

  test("later, or on today's weekday a week on: the date, never a bare weekday", () => {
    // Saturday a week on: `토 오전 9:00` would read as today.
    expect(resetText(ko, NOW, seoul(10, 31, 9))).toBe("10월 31일 오전 9:00 리셋")
    expect(resetText(ko, NOW, NOW + 6 * DAY + MIN)).toBe("10월 30일 오후 11:31 리셋")
    expect(resetText(ko, NOW, seoul(11, 1, 9))).toBe("11월 1일 오전 9:00 리셋")
    expect(resetLong(ko, NOW, seoul(11, 1, 9))).toBe("7일 9시간 후 리셋 (11월 1일 오전 9:00)")
    expect(when(ko, NOW, seoul(11, 1, 9))).toBe("11월 1일 오전 9:00")
    expect(resetText(en, NOW, seoul(11, 1, 9))).toBe("resets Nov 1 9:00 AM")
  })

  test("hover texts use the same clock: the reset and the observation", () => {
    expect(resetTitle(ko, seoul(10, 26, 9))).toBe("2026-10-26 (월) 오전 9:00 리셋")
    expect(absolute(ko, NOW - MIN)).toBe("2026-10-24 (토) 오후 11:29")
    expect(resetTitle(en, seoul(10, 26, 14, 5))).toBe("resets 2026-10-26 (Mon) 2:05 PM")
  })

  test("every other coming time on screen reads the same way: the wait chip, the team, expiries, a speed's rest", () => {
    const team: TeamText = (key, params) => teamText.text("ko", key, params)
    const time = (at: number) => coming(ko, NOW, at)
    const monday = seoul(10, 26, 9)
    // 42 minutes on is Sunday: relative. Monday 09:00: the weekday. Saturday a week on: the date, never `토`.
    expect([NOW + 42 * MIN, monday, seoul(10, 31, 9)].map(time)).toEqual([
      "42분 후",
      "월 오전 9:00",
      "10월 31일 오전 9:00",
    ])
    expect(coming(en, NOW, monday)).toBe("Mon 9:00 AM")
    expect(coming(en, NOW, NOW + 42 * MIN)).toBe("42m from now")
    // The 리셋까지 대기 chip (switcher/pending-chip.tsx, own.wait.persistentNote) and a scheduled switch's deadline.
    expect(ko.t("own.wait.persistentNote", { time: time(monday), message: "계속" })).toBe(
      '월 오전 9:00에 "계속" 메시지를 보내 이어서 실행해요 (대화에 남음)',
    )
    expect(ko.t("own.composer.scheduledCompaction", { to: "B", deadline: time(NOW + 30 * MIN) })).toBe(
      "예약됨: 다음 압축 직후 B로 전환 · 30분 후까지 압축이 없으면 다시 묻기",
    )
    // The team's 한도 대기 (team/model.ts own.team.status.waitingQuotaUntil) and its held updates.
    const waiting = { state: "active", status: { kind: "waiting-quota", until: monday } } as Parameters<
      typeof areaStatus
    >[1]
    expect(areaStatus(team, waiting, 0, NOW, time).word).toBe("한도 대기 · 월 오전 9:00에 풀림")
    expect(noticeText(team, { kind: "wake.limited", text: "x", data: { until: seoul(10, 31, 9) } }, { time })).toBe(
      "팀 소식이 한 시간에 12번을 넘어 10월 31일 오전 9:00까지 모아 둬요",
    )
    // A choice's expiry and a speed's rest.
    const confirm = { kind: "paths-add", stepID: "s", opID: "op", nonce: "n", text: "x", expiresAt: monday } as unknown
    expect(
      confirmView(team, [confirm as OwnTeam.Confirm], { local: true, now: NOW, bytes: String, time }).expires,
    ).toBe("월 오전 9:00까지 고르세요")
    expect(
      offerBadge(
        ko,
        { choice: "fast", status: "cooldown", until: NOW + 42 * MIN, wire: "speed", basis: "catalog" } as Parameters<
          typeof offerBadge
        >[1],
        NOW,
      ),
    ).toBe("Fast · 42분 후까지 쉼")
  })

  test("folded, unfolded and hover of a real answer agree (anthropics/claude-code#12829's weekly reset)", () => {
    // Monday 2025-12-01 10:00 in Seoul; the weekly reset 1764615600 is Tuesday 04:00 there, 18 hours on.
    const at = Date.UTC(2025, 11, 1, 1, 0)
    const windows = Unified.parse(
      new Headers({
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.018416969696969696",
        "anthropic-ratelimit-unified-5h-reset": "1764554400",
        "anthropic-ratelimit-unified-7d-utilization": "0.7370692663445869",
        "anthropic-ratelimit-unified-7d-reset": "1764615600",
      }),
      at - MIN,
    )
    expect(foldedParts(ko, windows, at, 1).map((part) => part.text)).toEqual(["주간 남음 26%", "18시간 후 리셋"])
    expect(resetLong(ko, at, 1764615600_000)).toBe("18시간 후 리셋 (화 오전 4:00)")
    expect(resetTitle(ko, 1764615600_000)).toBe("2025-12-02 (화) 오전 4:00 리셋")
    // Two days earlier the same reset is past 24 hours: the weekday and the clock in every folded place.
    const before = at - 2 * DAY
    expect(foldedParts(ko, windows, before, 1).map((part) => part.text)).toEqual(["주간 남음 26%", "화 오전 4:00 리셋"])
    expect(windowsTitle(ko, windows, before)).toContain("주간 남음 26% · 화 오전 4:00 리셋")
  })
})
