// 설정 > 자동 압축 > 자리를 비운 사이 압축 (02 §4.7.7, CC 2026-10-24): the words of the opt-in and where it sits.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { CompactionCache } from "@own/protocol/compaction-cache"
import { idleCompactionEn, idleCompactionKo, idleCompactionText } from "./idle-compaction-strings"

const source = (file: string) => Bun.file(path.join(import.meta.dir, file)).text()

describe("자리를 비운 사이 압축", () => {
  test("Korean and English words; the numbers are the service's defaults", () => {
    for (const key of Object.keys(idleCompactionEn)) expect(Object.hasOwn(idleCompactionKo, key)).toBe(true)
    expect(idleCompactionKo["own.idle.title"]).toBe("자리를 비운 사이 압축")
    expect(
      idleCompactionText("ko", "own.idle.when", { tokens: "100,000", minutes: CompactionCache.IDLE.minIdleMinutes }),
    ).toBe("문맥이 100,000 토큰 이상이고 20분 넘게 아무 일이 없을 때만 해요. 대화마다 캐시 한 번에 한 번이에요.")
    // The break-even line is the design's table (own/reports/cached-compaction-2026-10.md §4.5).
    expect(idleCompactionKo["own.idle.breakEven"]).toContain("16%")
    expect(idleCompactionKo["own.idle.ttl.codexValue"]).toStartWith("안 함")
    expect(idleCompactionKo["own.idle.ttl.dsValue"]).toStartWith("안 함")
    // The away wait is the service's `policy.awayDetect.hiddenMinutes` (CC-16), not a client constant.
    expect(idleCompactionText("ko", "own.idle.present", { minutes: 15 })).toContain("마지막으로 만진 뒤 15분이 지나야")
    expect(idleCompactionKo["own.idle.presentOff"]).toContain("awayDetect")
  })

  test("off by default, on the 자동 압축 page, and written through policy.set", async () => {
    const section = await source("idle-compaction.tsx")
    expect(section).toContain('idle()?.enabled === true ? "on" : "off"')
    expect(section).toContain('patch: { compaction: { idle: { enabled: next === "on" } } }')
    expect(section).toContain('text("own.idle.present", { minutes: value().hiddenMinutes })')
    expect(await source("compaction.tsx")).toContain("<IdleCompactionSection />")
  })
})
