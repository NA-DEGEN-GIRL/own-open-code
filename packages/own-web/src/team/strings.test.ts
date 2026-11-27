// own.team catalog (06 §9.1, §9.8, TG20 wording part): every key has English with the same placeholders; the default
// copy of both languages has no git word, no `{target}` / `{branch}` placeholder, `Git` only as the program's name and
// never "this PC"; Korean particles resolve. Then the view models (team/model.ts) word status, main and preset lines,
// the worst case, steps, notices, errors and the view-only notice as 06 §9.4, §10.3 and 07 §7.4 write them. T3: the
// reorganization, review, retire and system-change copy, the labels of every T3 step kind, and the sidebar's team
// strings under the same git-word rule.
import { describe, expect, test } from "bun:test"
import { Preset } from "@own/protocol/preset"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { OwnRpcError } from "@/data/rpc"
import { sidebarEn, sidebarKo } from "@/sidebar/strings"
import { createI18n } from "@/i18n"
import { coming } from "@/limits/format"
import {
  areaStatus,
  errorText,
  mainLine,
  noticeText,
  presetLine,
  stepLabel,
  viewOnlyText,
  worstCase,
  type TeamText,
} from "./model"
import { starterPhrases, starterShown } from "./starter"
import { teamEn, teamKo, teamText, type TeamKey } from "./strings"

/** 06 §9.1, word for word. */
const FORBIDDEN = [
  "worktree",
  "branch",
  "브랜치",
  "commit",
  "커밋",
  "merge",
  "머지",
  "rebase",
  "stash",
  "sparse",
  "LFS",
  "HEAD",
  "checkout",
  "push",
  "PR",
  "캐시",
  "환경 변수",
  "의존성",
  "보류",
]
/** The English of the Korean ones, the home word 9.1 drops, and "this PC" (a device names the service PC). */
const ALSO = ["cache", "environment variable", "dependenc", "홈 폴더", "이 PC", "this PC"]

const catalogs = [
  ["ko", teamKo],
  ["en", teamEn],
] as const

const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).toSorted()

/** Upper-case ASCII words match as whole words with their case; other ASCII words anywhere, any case. */
function hits(text: string, word: string) {
  if (/^[A-Z]+$/.test(word)) return new RegExp(`\\b${word}\\b`).test(text)
  if (/^[a-z ]+$/.test(word)) return text.toLowerCase().includes(word)
  return text.includes(word)
}

const ko: TeamText = (key, values) => teamText.text("ko", key, values)
const en: TeamText = (key, values) => teamText.text("en", key, values)
/** The screen's coming-time words (`@/limits/format` `coming`) at `now`. */
const timeOf = (locale: "ko" | "en", now: number) => (at: number) => coming(createI18n(locale), now, at)

/**
 * The 2026-10-16 copy rules (03 §14.1, the ui-ux glossary): one word per concept and 해요체 sentences. The team track
 * converts the team catalog, so `src/i18n/copy.test.ts` of the ui-ux branch lists `team/strings.ts` in FILES_LATER
 * until both land; these are the same rules for this catalog, plus the team's own words (the area's 모델, never
 * 영역 메인 or `메인:`; 쉬는 중 for idle).
 */
const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/세션(?! ?ID)/, "대화 (세션 only in 세션 ID)"],
  [/채팅/, "대화"],
  [/워크트리/, "작업 폴더"],
  [/허락/, "승인 / 허용"],
  [/컨텍스트/, "문맥"],
  [/유휴/, "쉬는 중"],
  [/프로바이더|(?<![-\w])provider/i, "회사"],
  [/하네스/, "에이전트 방식"],
  [/폐기/, "연결 끊기"],
  [/영역 메인|메인:|메인 바꾸기|메인 모델/, "모델 (the area's account·model·effort)"],
  [/대기 중/, "쉬는 중 (idle) — 대기 중 is queued only, and the team has no queued status word"],
]

describe("own.team catalog", () => {
  test("Korean copy uses the glossary (03 §14.1, 2026-10-16)", () => {
    const words = (text: string) => text.replace(/\{\w+\}/g, "")
    const offending = Object.entries(teamKo).flatMap(([key, text]) =>
      BANNED.flatMap(([pattern, instead]) => (pattern.test(words(text)) ? [`${key} → ${text}   [${instead}]`] : [])),
    )
    expect(offending).toEqual([])
  })

  test("Korean copy speaks 해요체: no 합니다체 sentence (03 §14.1, 2026-10-16)", () => {
    const formal = /[가-힣](니다|니까|십시오)(?=$|[\s.,:;!?…)"'’”\](])/
    expect(Object.entries(teamKo).flatMap(([key, text]) => (formal.test(text) ? [`${key} → ${text}`] : []))).toEqual([])
  })

  test("every key is own.team.*, has English and the same placeholders", () => {
    for (const [key, value] of Object.entries(teamKo)) {
      expect(key.startsWith("own.team."), key).toBe(true)
      const english = (teamEn as Record<string, string | undefined>)[key]
      expect(english, key).toBeDefined()
      expect(params(english!), key).toEqual(params(value))
    }
    expect(Object.keys(teamEn).toSorted()).toEqual(Object.keys(teamKo).toSorted())
  })

  for (const [locale, catalog] of catalogs)
    test(`${locale}: no forbidden word, no {target} or {branch}, Git only as a name, never this PC`, () => {
      for (const [key, value] of Object.entries(catalog)) {
        for (const word of [...FORBIDDEN, ...ALSO]) expect(hits(value, word), `${key}: ${word}`).toBe(false)
        expect(
          params(value).filter((name) => name === "target" || name === "branch"),
          key,
        ).toEqual([])
        for (const match of value.matchAll(/git/gi)) {
          const before = value[match.index - 1] ?? " "
          const after = value[match.index + 3] ?? " "
          expect(`${match[0]}|${/\p{L}/u.test(before)}|${/\p{L}/u.test(after)}`, key).toBe("Git|false|false")
        }
      }
    })

  test("the forbidden-word check itself catches what it should", () => {
    expect(hits("작업 폴더의 브랜치", "브랜치")).toBe(true)
    expect(hits("Open a PR", "PR")).toBe(true)
    expect(hits("PRESET", "PR")).toBe(false)
    expect(hits("Pushed to remote", "push")).toBe(true)
    expect(hits("the HEAD moved", "HEAD")).toBe(true)
  })

  test("area messages name who sent them, with the particle the label takes (06 §5.8)", () => {
    expect(ko("own.team.sent.area", { area: "세이브 v3" })).toBe("'세이브 v3' 담당이 보냄")
    expect(ko("own.team.sent.peer", { area: "세이브 v3", label: "리뷰어" })).toBe("'세이브 v3' 동료 리뷰어가 보냄")
    expect(ko("own.team.sent.peer", { area: "세이브 v3", label: "검토팀" })).toBe("'세이브 v3' 동료 검토팀이 보냄")
    expect(ko("own.team.sent.areaReply", { area: "세이브 v3" })).toBe("'세이브 v3' 담당의 답")
    expect(ko("own.team.sent.notes", { n: 2 })).toBe("쪽지 2개 함께 옴")
    expect(ko("own.team.outbox.from.areaPeer", { area: "세이브 v3", label: "리뷰어" })).toBe("세이브 v3 동료 리뷰어")
    expect([
      ko("own.team.outbox.kind.ask"),
      ko("own.team.outbox.kind.reply"),
      ko("own.team.outbox.kind.notice"),
    ]).toEqual(["물음", "답", "안내"])
    expect(ko("own.team.status.waiting", { n: 3 })).toBe("요청 3개 기다림")
  })

  test("Korean particles follow the filled names", () => {
    expect(ko("own.team.card.allAreas", { main: "GPT-6 Astra · high", preset: "평소대로" })).toBe(
      "모든 영역이 팀 메인(GPT-6 Astra · high)과 '평소대로'를 써요",
    )
    expect(
      ko("own.team.notice.presetRepair", {
        preset: "다른 회사 리뷰",
        account: "ChatGPT 03",
        area: "cl-perf",
        roles: "리뷰",
      }),
    ).toBe("'다른 회사 리뷰'가 ChatGPT 03을 써서 cl-perf 리뷰를 cl-perf 모델로 돌려요")
    expect(ko("own.team.account.move", { areas: 3, account: "ChatGPT 02" })).toBe(
      "팀 전체(메인과 영역 3개)를 ChatGPT 02로",
    )
    expect(ko("own.team.card.r4", { area: "cl-perf", account: "ChatGPT 02", team: "ChatGPT 01" })).toBe(
      "cl-perf 대화는 ChatGPT 02를 써요. 메인이 일을 맡길 때 ChatGPT 01로 새 대화에서 이어 가요",
    )
    // 내가 정한 영역's toast (2026-10-26): the catalog writes the `(을)를` marker, which this resolves after the quote;
    // a fixed `을(를)` would stay on the screen as it is (2026-10-27 review).
    expect(ko("own.team.userMade.on", { area: "몬스터 에셋" })).toBe("'몬스터 에셋'을 내가 정한 영역으로 표시했어요")
    expect(ko("own.team.userMade.on", { area: "시뮬레이션 보스" })).toBe(
      "'시뮬레이션 보스'를 내가 정한 영역으로 표시했어요",
    )
  })
})

const NOW = Date.UTC(2026, 9, 2, 5, 0)

function area(fields: {
  kind?: OwnTeam.StatusKind
  until?: number
  paused?: OwnTeam.Paused
  state?: OwnTeam.AreaView["state"]
  why?: OwnTeam.BrokenReason
}): Pick<OwnTeam.AreaView, "state" | "broken" | "status" | "paused"> {
  return {
    state: fields.state ?? "active",
    broken: fields.why ? { why: fields.why, at: NOW } : undefined,
    status: { kind: fields.kind ?? "idle", at: NOW, text: "", until: fields.until },
    paused: fields.paused ?? false,
  }
}

describe("status words (06 §9.4)", () => {
  test("each status with its time", () => {
    expect(areaStatus(ko, area({}), 0, NOW)).toEqual({ word: "쉬는 중", tone: "idle", waiting: undefined })
    expect(areaStatus(ko, area({ kind: "busy" }), 0, NOW).word).toBe("작업 중")
    expect(areaStatus(ko, area({ kind: "asking" }), 0, NOW)).toMatchObject({ word: "답을 기다림", tone: "attention" })
    expect(areaStatus(ko, area({ kind: "blocked" }), 0, NOW).word).toBe("막힘")
    expect(areaStatus(ko, area({ kind: "ready" }), 0, NOW)).toMatchObject({ word: "반영 준비됨", tone: "ready" })
    expect(areaStatus(ko, area({ kind: "failed" }), 0, NOW)).toMatchObject({ word: "실패", tone: "error" })
    expect(areaStatus(ko, area({ kind: "preparing" }), 0, NOW).word).toBe("준비 중")
    expect(areaStatus(ko, area({ kind: "preparing", until: NOW + 4 * 60_000 + 1 }), 0, NOW).word).toBe(
      "준비 중(설치 약 5분)",
    )
    const reset = NOW + 3_600_000
    // A coming time in the reset style (LV): relative within a day, never a bare clock that may be tomorrow.
    expect(areaStatus(ko, area({ kind: "waiting-quota", until: reset }), 0, NOW, timeOf("ko", NOW))).toEqual({
      word: "한도 대기 · 1시간 후에 풀림",
      tone: "waiting",
      waiting: undefined,
    })
    expect(areaStatus(ko, area({ kind: "waiting-quota" }), 0, NOW).word).toBe("한도 대기")
  })

  test("Main 멈춤 counts the requests it holds back; otherwise waiting requests ride beside the word", () => {
    expect(areaStatus(ko, area({ kind: "busy", paused: "user" }), 2, NOW)).toEqual({
      word: "메인 멈춤 · 요청 2개 기다림",
      tone: "paused",
    })
    expect(areaStatus(ko, area({ paused: "all" }), 0, NOW).word).toBe("메인 멈춤")
    expect(areaStatus(ko, area({ kind: "busy" }), 1, NOW)).toEqual({
      word: "작업 중",
      tone: "working",
      waiting: "요청 1개 기다림",
    })
  })

  test("a stopped or finished area says so before anything else", () => {
    expect(areaStatus(ko, area({ state: "broken", why: "missing", paused: "user" }), 3, NOW).word).toBe("찾을 수 없음")
    expect(areaStatus(ko, area({ kind: "broken", why: "identity" }), 0, NOW)).toEqual({
      word: "멈춤(폴더 정보 불일치)",
      tone: "error",
    })
    expect(areaStatus(ko, area({ state: "retired" }), 0, NOW).word).toBe("끝낸 영역")
    expect(areaStatus(ko, area({ state: "retiring" }), 0, NOW).word).toBe("끝내는 중")
    expect(
      areaStatus(en, area({ kind: "waiting-quota", until: NOW + 90 * 60_000 }), 0, NOW, timeOf("en", NOW)).word,
    ).toBe("Waiting for limits · resets 1 h 30 min from now")
  })
})

describe("main and preset lines (06 §9.1, 07 §7.4)", () => {
  const team = { model: "GPT-6 Astra", effort: "high", account: "개인 Pro" }

  test("팀과 같게, with the team main where the line names it", () => {
    expect(mainLine(ko, undefined)).toBe("모델: 팀과 같게")
    expect(mainLine(ko, undefined, team)).toBe("모델: 팀과 같게(GPT-6 Astra · high @ 개인 Pro)")
    expect(mainLine(en, undefined, team)).toBe("Model: same as team (GPT-6 Astra · high @ 개인 Pro)")
  })

  test("an area main of its own, the effort left out for the default", () => {
    expect(mainLine(ko, { model: "GPT-5.6 Sol", effort: "xhigh", account: "ChatGPT 01" }, team)).toBe(
      "모델: GPT-5.6 Sol · xhigh @ ChatGPT 01",
    )
    expect(mainLine(ko, { model: "Claude Opus 5.5", account: "Claude 구독" })).toBe(
      "모델: Claude Opus 5.5 @ Claude 구독",
    )
    expect(mainLine(ko, { model: "qwen3" })).toBe("모델: qwen3")
  })

  test("preset lines", () => {
    expect(presetLine(ko, "다른 회사 리뷰")).toBe("프리셋: 다른 회사 리뷰")
    expect(presetLine(ko, "평소대로", true)).toBe("프리셋 평소대로")
  })
})

describe("worst case (06 §10.3, 07 §7.4)", () => {
  const usual = Preset.builtin("codex")
  const active: Preset.Info = { ...usual, id: Preset.ID.create(), name: "적극적으로", delegation: "active" }
  const paid: Preset.Info = {
    ...usual,
    id: Preset.ID.create(),
    name: "API 리뷰",
    workers: {
      mode: "by-role",
      // SAFETY: test ids; the brands of AccountID and Model.ID are not checked here.
      roles: {
        "own-review": {
          targets: [{ pin: { account: "acc_api" as never, model: "gpt-x" as never } }],
          effort: "inherit",
        },
      },
    },
  }
  const own: Preset.Info = { ...usual, id: Preset.ID.create(), name: "크게", ultraCaps: "large" }
  const lookup = (id: string) => [active, paid, own].find((preset) => preset.id === id)

  test("four areas on an active preset share the team account's limits", () => {
    const result = worstCase(ko, Array(4).fill({ presetID: active.id }), lookup, "recommended", {
      shared: "ChatGPT 01",
    })
    expect(result).toEqual({
      areas: 4,
      subagents: 12,
      total: 16,
      heavy: true,
      line: "영역 4개 × (담당 1 + 하위 에이전트 동시 3) = 최대 16개 동시 실행 · ChatGPT 01 한도를 함께 써요",
    })
  })

  test("ultra areas count with the ultra caps: four on 추천 are 36", () => {
    const result = worstCase(ko, Array(4).fill({ presetID: usual.id, ultra: true }), lookup, "recommended")
    expect(result?.line).toBe("영역 4개 × (담당 1 + 하위 에이전트 동시 8) = 최대 36개 동시 실행")
    expect(result?.heavy).toBe(true)
    // A preset's own ultra caps win over the global level.
    expect(worstCase(ko, [{ presetID: own.id, ultra: true }], lookup, "save")?.subagents).toBe(64)
  })

  test("areas with different caps add up", () => {
    const areas = [
      { presetID: usual.id, ultra: true },
      { presetID: usual.id, ultra: true },
      { presetID: active.id },
      { presetID: "pr_unknown" },
    ]
    expect(worstCase(ko, areas, lookup, "recommended")?.line).toBe(
      "영역 4개 · 담당 4 + 하위 에이전트 동시 22 = 최대 26개 동시 실행",
    )
    expect(worstCase(en, areas, lookup, "recommended", { shared: "ChatGPT 01" })?.line).toBe(
      "4 areas · 4 owners + 22 subagents at once = up to 26 running at once · They share the limits of ChatGPT 01",
    )
  })

  test("heavy only for active delegation, a paid pinned target or ultra; no areas, no line", () => {
    expect(worstCase(ko, [{ presetID: usual.id }], lookup, "recommended")?.heavy).toBe(false)
    expect(worstCase(ko, [{ presetID: paid.id }], lookup, "recommended")?.heavy).toBe(false)
    const metered = (account: string) => account === "acc_api"
    expect(worstCase(ko, [{ presetID: paid.id }], lookup, "recommended", { metered })?.heavy).toBe(true)
    expect(worstCase(ko, [], lookup, "recommended")).toBeUndefined()
  })
})

describe("steps, notices, errors and the view-only notice", () => {
  test("steps in plain words; unknown kinds as they are", () => {
    expect(stepLabel(ko, "worktree-create")).toBe("작업 폴더 만들기")
    expect(stepLabel(ko, "session-adopt")).toBe("기존 대화를 담당으로 등록")
    expect(stepLabel(ko, "feature-x")).toBe("feature-x")
  })

  test("notices from their data and the area's name; the service text when a value is missing", () => {
    expect(
      noticeText(
        ko,
        {
          kind: "preset.repair",
          text: "server",
          data: { preset: "다른 회사 리뷰", account: "ChatGPT 03", roles: "리뷰" },
        },
        { area: "cl-perf" },
      ),
    ).toBe("'다른 회사 리뷰'가 ChatGPT 03을 써서 cl-perf 리뷰를 cl-perf 모델로 돌려요")
    expect(
      noticeText(ko, { kind: "area.broken", text: "server", data: { why: "identity" } }, { area: "cl-perf" }),
    ).toBe("'cl-perf' 폴더의 정보가 맞지 않아 멈췄어요")
    expect(noticeText(ko, { kind: "area.broken", text: "server" }, { area: "cl-perf" })).toBe(
      "'cl-perf' 영역이 멈췄어요",
    )
    expect(
      noticeText(ko, { kind: "paths.added", text: "server text", data: { n: 1 } }, { area: "인벤토리 화면" }),
    ).toBe("server text")
    expect(noticeText(ko, { kind: "drift.repaired", text: "server" })).toBe(
      "담당이 받지 않은 폴더에 파일을 만들어서 그 폴더를 이 영역에 들였어요",
    )
    // 4.11: a shared-folder link was not made because something else is at its path.
    expect(
      noticeText(
        ko,
        { kind: "link.blocked", text: "server", data: { area: "화면", dir: "data", why: "folder" } },
        { area: "화면" },
      ),
    ).toBe("'화면': 'data' 자리에 다른 폴더나 파일이 있어 공유 폴더를 연결하지 않았어요")
    const until = Date.UTC(2026, 9, 2, 5, 30)
    expect(
      noticeText(ko, { kind: "wake.limited", text: "server", data: { until } }, { time: timeOf("ko", until - 42 * 60_000) }),
    ).toBe("팀 소식이 한 시간에 12번을 넘어 42분 후까지 모아 둬요")
  })

  test("errors in plain words", () => {
    expect(errorText(ko, new OwnRpcError("dirty", "m", { directory: "D:/x", count: 4, paths: [] }))).toBe(
      "아직 저장 지점에 넣지 않은 변경 4개가 있어요",
    )
    expect(errorText(ko, new OwnRpcError("path_forbidden", "m", { path: "D:/#a", why: "hash" }))).toBe(
      "경로에 #이 있는 폴더는 쓸 수 없어요: D:/#a",
    )
    expect(errorText(ko, new OwnRpcError("git_too_old", "m", { version: "2.39.1", minimum: "2.40" }))).toBe(
      "Git 2.39.1은 너무 오래됐어요. Git 2.40 이상이 필요해요",
    )
    expect(errorText(ko, new OwnRpcError("own.scope_denied", "m"))).toBe("이 기기에서는 할 수 없어요")
    expect(errorText(ko, new OwnRpcError("rpc.unavailable", "m"))).toBe("이 서비스에는 팀 모드가 없어요")
    expect(errorText(ko, new OwnRpcError("rpc.internal", "m"))).toBe("팀 모드에서 오류가 났어요")
    expect(errorText(ko, new TypeError("Failed to fetch"))).toBe("서비스에 닿지 못했어요")
  })

  test("a gateway device names the service PC, never this PC", () => {
    expect(viewOnlyText(ko, "confirm", "DESKTOP-OWN")).toBe("DESKTOP-OWN에서 확인하세요")
    expect(viewOnlyText(ko, "settings", "DESKTOP-OWN")).toBe("DESKTOP-OWN에서 바꾸세요")
    expect(viewOnlyText(ko, "confirm")).toBe("서비스를 실행하는 PC에서 확인하세요")
    expect(viewOnlyText(en, "confirm", "DESKTOP-OWN")).toBe("Confirm on DESKTOP-OWN")
    for (const text of [viewOnlyText(ko, "settings"), viewOnlyText(en, "settings")]) {
      expect(text).not.toContain("이 PC")
      expect(text).not.toContain("this PC")
    }
  })
})

describe("T2 copy (06 §0.4, §6.6, §7, §8.2, §8.8, §9.7)", () => {
  const home = ko("own.team.homeFolder", { name: "own-open-code" })

  test("the T2 groups are in both catalogs; the checks above cover their words and placeholders", () => {
    for (const prefix of [
      "own.team.integrate.",
      "own.team.push.",
      "own.team.decide.",
      "own.team.adopt.",
      "own.team.unadopt.",
    ]) {
      const group = Object.keys(teamKo).filter((key) => key.startsWith(prefix))
      expect(group.length, prefix).toBeGreaterThan(0)
      expect(
        group.filter((key) => !Object.hasOwn(teamEn, key)),
        prefix,
      ).toEqual([])
    }
  })

  test("integration cards word 9.7: progress, done, waiting, stopped work, failure and conflict", () => {
    expect(
      `${ko("own.team.integrate.running", { area: "인벤토리 화면" })} · ${ko("own.team.integrate.checks", { n: 1, total: 2 })}`,
    ).toBe("인벤토리 화면 반영하는 중 · 검사 1/2")
    expect(ko("own.team.card.integrated", { area: "인벤토리 화면" })).toBe(
      "인벤토리 화면 작업을 프로젝트 본 코드에 반영했어요",
    )
    expect(ko("own.team.integrate.waiting.dirty", { folder: home, n: 2 })).toBe(
      "메인 폴더(own-open-code)에서 아직 저장 지점에 넣지 않은 파일 2개와 겹쳐요. 그 변경을 저장 지점에 넣거나 되돌린 뒤 '다시 반영'을 누르세요",
    )
    expect(ko("own.team.action.retryIntegrate")).toBe("다시 반영")
    expect(ko("own.team.integrate.waiting.inProgress", { folder: home })).toBe(
      "메인 폴더(own-open-code)에서 하던 기록 정리가 끝나면 반영해요",
    )
    expect(ko("own.team.integrate.failed.verify")).toBe("검사가 실패해서 반영하지 않았어요")
    expect(ko("own.team.action.log")).toBe("로그 보기")
    expect(ko("own.team.integrate.conflict")).toBe("프로젝트 본 코드의 새 변경과 겹쳐서 담당에게 정리를 맡겼어요")
    expect(ko("own.team.integrate.details.assetsSkipped")).toBe("큰 파일 검사는 건너뜀")
  })

  test("the heavy line of the enable card (0.4)", () => {
    expect(ko("own.team.card.heavy", { n: 3, size: "14.7 GB" })).toBe(
      "큰 파일 폴더 3개(14.7 GB)는 영역 폴더에 받지 않아요.",
    )
  })

  test("the upload flow and 결정 적기", () => {
    expect([ko("own.team.push.action"), ko("own.team.push.prAction")]).toEqual([
      "원격 저장소에 올리기…",
      "검토 요청 올리기…",
    ])
    expect(ko("own.team.push.done", { remote: "origin" })).toBe("원격 저장소 origin에 올렸어요")
    expect(ko("own.team.push.login")).toBe("원격 저장소에 로그인이 필요해요. 터미널에서 한 번 로그인해 주세요")
    expect(ko("own.team.decide.title")).toBe(ko("own.team.menu.decide"))
    expect(ko("own.team.decide.done", { n: 4 })).toBe("결정 기록 4번을 적었어요")
    expect(en("own.team.decide.done", { n: 4 })).toBe("Saved decision record 4")
  })

  test("the T2 notices from their data; the service text when a value is missing", () => {
    expect(noticeText(ko, { kind: "folder.followed", text: "server" }, { area: "cl-cu" })).toBe(
      "'cl-cu' 폴더가 옮겨져 따라갔어요",
    )
    expect(
      noticeText(
        ko,
        { kind: "integration.waiting", text: "server", data: { why: "outside", folder: "own-open-code" } },
        { area: "인벤토리 화면" },
      ),
    ).toBe("'인벤토리 화면' 반영을 기다려요. own-open-code 폴더의 일이 끝나면 다시 반영하세요")
    expect(noticeText(ko, { kind: "integration.waiting", text: "server" }, { area: "인벤토리 화면" })).toBe("server")
    expect(noticeText(ko, { kind: "undo.kept", text: "server" })).toBe("되돌리는 사이에 생긴 저장 지점을 지켜 뒀어요")
  })

  test("T2 steps in plain words", () => {
    expect(stepLabel(ko, "integrate-verify")).toBe("코드 검사")
    expect(stepLabel(ko, "reconcile-move")).toBe("옮겨진 폴더 따라가기")
    expect(stepLabel(en, "push-pr")).toBe("Open a review request")
  })
})

describe("T3 copy (06 §8.1, §8.2, §8.6, §8.8, §9.4, §9.7, §4.13)", () => {
  test("the T3 groups are in both catalogs; the checks above cover their words and placeholders", () => {
    for (const prefix of [
      "own.team.reorg.",
      "own.team.split.",
      "own.team.merge.",
      "own.team.convert.",
      "own.team.move.",
      "own.team.retire.",
      "own.team.review.",
      "own.team.suggest.",
      "own.team.confirm.shared.",
      "own.team.confirm.assets.",
    ]) {
      const group = Object.keys(teamKo).filter((key) => key.startsWith(prefix))
      expect(group.length, prefix).toBeGreaterThan(0)
      expect(
        group.filter((key) => !Object.hasOwn(teamEn, key)),
        prefix,
      ).toEqual([])
    }
  })

  test("the area menu's T3 items read as 06 writes them; T1 keys stay in use", () => {
    expect(
      [
        "own.team.areaMenu.split",
        "own.team.areaMenu.merge",
        "own.team.areaMenu.retire",
        "own.team.areaMenu.convert",
        "own.team.areaMenu.move",
      ].map((key) => ko(key as TeamKey)),
    ).toEqual(["나누기…", "영역 묶기…", "영역 끝내기…", "파일 모양 바꾸기", "대화 옮기기…"])
    expect([
      ko("own.team.areaMenu.rename"),
      ko("own.team.areaMenu.integrate"),
      ko("own.team.areaMenu.unadopt"),
    ]).toEqual(["이름 바꾸기", "이 영역 반영하기", "팀에서 빼기"])
    expect([ko("own.team.action.retire"), ko("own.team.action.ignore"), ko("own.team.action.finish")]).toEqual([
      "끝내기…",
      "무시",
      "끝내기",
    ])
    expect(ko("own.team.menu.review")).toBe("팀 구성 다시 보기…")
    expect(ko("own.team.disable.cleanup")).toBe("끝난 영역 정리하고 끄기")
  })

  test("the removal dialog: bundled title, unapplied save points, a system change and how to undo it", () => {
    expect(ko("own.team.confirm.bulk", { n: 3, size: "7.5 GB" })).toBe("끝난 영역 3개 정리(7.5 GB)")
    expect(ko("own.team.confirm.unapplied", { n: 2 })).toBe("반영하지 않은 저장 지점 2개는 기록에 남아요")
    expect(
      ko("own.team.confirm.system", {
        setting: ko("own.team.confirm.shared.setting", { folder: "weights" }),
        undo: ko("own.team.confirm.shared.undoAcl"),
      }),
    ).toBe(
      "바뀌는 설정: 'weights' 폴더를 읽기 전용으로 바꿈(쓰기와 지우기를 막고 읽기는 그대로). 되돌리는 법: 그 폴더의 속성 > 보안 > 고급에서 이 사용자의 거부 항목을 지워요",
    )
  })

  test("the retire signal and suggestion, a missing folder and the remote tool", () => {
    expect(ko("own.team.status.retirable")).toBe("끝낼 수 있음")
    expect(
      ko("own.team.card.suggest.retire", { area: "로그인", why: ko("own.team.suggest.retirable", { n: 7 }) }),
    ).toBe("제안: '로그인' 영역을 끝낼 수 있어요(모두 반영됨, 7일 동안 변경 없음)")
    expect(ko("own.team.status.broken.missing")).toBe("찾을 수 없음")
    expect(ko("own.team.retire.missing")).toBe("폴더를 찾을 수 없어 지울 것이 없어요. 기록 이름과 대화는 남아요")
    expect(ko("own.team.notice.lfsInstalled")).toBe("원격 호스트에 큰 파일 도구를 준비했어요")
    expect(ko("own.team.error.lfsMissing")).toBe("이 저장소에 필요한 큰 파일 도구가 없어요")
    expect(ko("own.team.enable.lfsFailed", { reason: ko("own.team.error.diskFull") })).toBe(
      "원격 호스트에 큰 파일 도구를 준비하지 못했어요: 원격 호스트의 디스크가 가득 찼어요",
    )
  })

  test("every T3 step kind has plain words, convert-to-full included", () => {
    const kinds = [
      // reorg/retire.ts, reorg/remove.ts
      "retire.keep",
      "retire.check",
      "retire.outbox",
      "retire.archive",
      "retire.mark",
      "retire-remove",
      // reorg/split.ts, reorg/merge.ts, git/wip.ts
      "split-begin",
      "split-handoff",
      "merge-begin",
      "merge-into",
      "merge-handoff",
      "merge-attach",
      "outbox-migrate",
      "merge-archive",
      "merge-retire",
      "merge-undo",
      "merge-undo-area",
      "wip-commit",
      // reorg/convert.ts, reorg/rehome.ts
      "convert-to-code",
      "convert-to-full",
      "session-move",
      // assets/shared.ts, the remote tool, the asset check
      "link-shared",
      "protect-shared",
      "lfs-remote",
      "integrate-assets",
      "keep-ref",
      "hold-ref",
      // ops/disable.ts (끝난 영역 정리하고 끄기), ops/undo.ts (the enable's shared folders)
      "disable.cleanup",
      "undo.shared",
      // the T3 review: the user's 끝내기 waiting, a conversion's ask, a WIP commit's undo, the LFS filter put back
      "retire.begin",
      "convert-confirm",
      "wip-undo",
      "lfs-restore",
    ]
    for (const kind of kinds) {
      for (const text of [ko, en]) {
        const label = stepLabel(text, kind)
        expect(label, kind).not.toBe(kind)
        expect(label, kind).not.toMatch(/\{\w+\}/)
      }
    }
    expect(stepLabel(ko, "convert-to-full")).toBe("전체 폴더로 바꾸기")
    expect(stepLabel(en, "protect-shared")).toBe("Make the shared folder read-only")
  })

  test("every step of 담당 대화 바꾸기 has plain words (06 §6.8)", () => {
    const words: ReadonlyArray<readonly [string, string, string]> = [
      ["seat.wait", "담당이 쉴 때 기다리기", "Wait until the owner is idle"],
      ["seat.requeue", "아직 시작 안 한 요청 거둬 두기", "Take back the requests it has not started"],
      ["seat.claim", "고른 대화에 담당 역할 붙이기", "Give the chosen conversation the owner role"],
      ["seat.settle", "옛 담당이 받은 물음 정리", "Close the questions the old owner was asked"],
      ["seat.swap", "고른 대화를 담당으로 두기", "Make the chosen conversation the owner"],
      ["seat.release", "옛 대화에서 담당 역할 떼기", "Take the owner role off the old conversation"],
    ]
    for (const [kind, korean, english] of words) {
      expect(stepLabel(ko, kind), kind).toBe(korean)
      expect(stepLabel(en, kind), kind).toBe(english)
    }
  })

  test("the sidebar's team strings hold no git word either", () => {
    for (const [locale, catalog] of [
      ["ko", sidebarKo],
      ["en", sidebarEn],
    ] as const)
      for (const [key, value] of Object.entries(catalog)) {
        if (!key.startsWith("own.sidebar.team.") || value === undefined) continue
        for (const word of FORBIDDEN) expect(hits(value, word), `${locale} ${key}: ${word}`).toBe(false)
      }
    expect(sidebarKo["own.sidebar.team.finish"]).toBe("{area} 영역 끝내기")
  })
})

describe("team-mode convenience copy (2026-10-16)", () => {
  test("labels that open a dialog end with …; the wait words name the area", () => {
    expect(ko("own.team.enable")).toBe("팀 모드 켜기…")
    expect(ko("own.team.menu.review")).toBe("팀 구성 다시 보기…")
    expect(ko("own.team.review.waits", { line: "x", area: "화면" })).toStartWith("x · '화면'에서 일하는 중이에요.")
    expect(ko("own.team.review.pausedWaits", { line: "x", area: "화면" })).toStartWith(
      "x · '화면'은 메인 멈춤 중이에요.",
    )
    expect(ko("own.team.review.apply", { n: 2 })).toBe("고른 2개 적용")
  })

  test("the empty team main's phrases: two with no area, five with the first area's name", () => {
    expect(starterPhrases(ko, { areas: [] })).toEqual([
      "하려는 일을 팀에서 어떻게 나눌지 먼저 같이 정하자. 하려는 일: ",
      "팀 상태 알려 줘.",
    ])
    const phrases = starterPhrases(ko, { areas: ["화면", "서버"] })
    expect(phrases).toHaveLength(5)
    expect(phrases[3]).toBe("'화면' 영역을 둘로 나누고 싶어. 어떻게 나눌지 먼저 보여 줘.")
    expect(phrases[4]).toBe("'화면' 영역은 내가 직접 할게. 잠깐 멈춰 줘.")
  })

  test("the phrases show over an empty composer or their own phrase, never over the enable draft or typed text", () => {
    const phrase = "팀 상태 알려 줘."
    expect(starterShown("", undefined)).toBe(true)
    expect(starterShown("  ", undefined)).toBe(true)
    expect(starterShown(phrase, phrase)).toBe(true)
    // Right after 팀 모드 켜기 with a goal: the discussion draft is not the starter's (review, 2026-10-16).
    expect(starterShown("로비 만들기\n\n이 일을 팀에서 어떻게 나눌지 먼저 같이 정하자.", undefined)).toBe(false)
    expect(starterShown(`${phrase} 그리고 화면도`, phrase)).toBe(false)
  })
})
