// Integration card and upload flow (06 §7, §7.4, §7.5, §9.7, §9.8; TG20 T2 part) over the real view model, the real
// typed own.team client for scopes and a fake transport. Fixtures go through the protocol's schemas. Covered: each
// state as 9.7 words it (progress `검사 1/2`; done with 되돌리기 / 원격 저장소에 올리기… / 자세히 and the left-out
// save points; waiting with the overlapping paths only in 자세히; stopped work; failure with 로그 보기; conflict;
// undone), the hand-over of an undo to the main, an undo that waits with 되돌리기 취소 (RH-42), buttons only where the build has the feature and the connection the
// scope (a gateway device sees where to upload instead), the upload's plan -> confirm -> execute{nonce} with renewed
// nonces, its toasts, no git words in the default copy, and that the screens stay lazy.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { OwnRpcError, type OwnScope } from "@/data/rpc"
import { createTeamRpc, type TeamMethod, type TeamRpc } from "@/data/team-rpc"
import { createI18n } from "@/i18n"
import { formatDuration } from "@/transcript/format"
import {
  executePush,
  integrationCan,
  integrationView,
  planPush,
  pushOutcome,
  uploadElsewhere,
  type IntegrationInput,
  type IntegrationView,
  type PushPlan,
} from "./integrate-model"
import type { TeamText } from "./model"
import { teamText } from "./strings"
import { teamWaitText } from "./wait-strings"

const SRC = path.join(import.meta.dir, "..")
const TEAM = "tm_0123456789ab"
const AREA = "ar_inventory-ui"
const IG = Schema.decodeUnknownSync(OwnTeam.IntegrationID)("ig_01JB0000000000000000000000")
const OP = Schema.decodeUnknownSync(OwnTeam.OpID)("op_01JB0000000000000000000000")
const HOME = "D:/own-open-code"
const B = `9f8e7d6${"0".repeat(33)}`
const C = `4c3b2a1${"1".repeat(33)}`
const K = `a1b2c3d${"2".repeat(33)}`
const NONCE = "n".repeat(43)
const NONCE2 = "m".repeat(43)
const NOW = 1_800_000_000_000

const ko: TeamText = (key, params) => teamText.text("ko", key, params)
const i18n = createI18n("ko")
const decodeIntegration = Schema.decodeUnknownSync(OwnTeam.Integration)
const decodeOp = Schema.decodeUnknownSync(OwnTeam.Op)

function integration(fields: Record<string, unknown> = {}) {
  return decodeIntegration({
    id: IG,
    teamID: TEAM,
    areaID: AREA,
    state: "running",
    target: "main",
    source: C,
    verify: {},
    createdAt: 1,
    ...fields,
  })
}

const applied = {
  state: "done",
  base: B,
  candidate: K,
  how: "merge",
  verify: { code: { ok: true, ms: 134_000 }, assets: "skipped" },
  advanced: { how: "ff-in-worktree", at: 2, directory: HOME },
}

/** The names the card resolves from the stores: the main folder by its 9.1 name, other folders by their short name. */
const names: IntegrationInput["names"] = {
  area: "인벤토리 화면",
  folder: (directory) =>
    directory === HOME ? ko("own.team.homeFolder", { name: "own-open-code" }) : (directory.split("/").at(-1) ?? ""),
  duration: (ms) => formatDuration(i18n, ms),
}

/** A PC window of a build with every T2 feature. */
const ALL = new Set<OwnScope>(["read", "prompt", "switch", "admin", "local"])

function access(
  scopes: ReadonlySet<OwnScope> = ALL,
  features: readonly OwnTeam.Feature[] = ["integrate", "push", "undo-cancel"],
) {
  return {
    has: (feature: OwnTeam.Feature) => features.includes(feature),
    rpc: createTeamRpc({
      client: () => {
        throw new Error("the card's permissions never reach the network")
      },
      control: async () => "C:/control",
      scopes: () => scopes,
    }),
  }
}

function view(fields: Record<string, unknown>, input: Partial<IntegrationInput> = {}): IntegrationView {
  return integrationView(ko, {
    integration: integration(fields),
    names,
    can: integrationCan(access(), true),
    waitText: (key, params) => teamWaitText.text("ko", key, params),
    ...input,
  })
}

const labels = (shown: IntegrationView) => shown.buttons.map((button) => button.label)
const kinds = (shown: IntegrationView) => shown.buttons.map((button) => button.action.kind)
/** What the card shows before 자세히. */
const copy = (shown: IntegrationView) => [shown.headline, ...shown.lines.map((line) => line.text), ...labels(shown)]

describe("integration card (06 §9.7)", () => {
  test("진행: the area and the check running now, `검사 1/2`", () => {
    expect(view({ checks: { current: 1, total: 2 } }).headline).toBe("인벤토리 화면 반영하는 중 · 검사 1/2")
    const plain = view({})
    expect(plain.headline).toBe("인벤토리 화면 반영하는 중")
    expect(plain.buttons).toEqual([])
    expect(plain.tone).toBeUndefined()
  })

  test("끝: 되돌리기, 원격 저장소에 올리기…, 검토 요청 올리기… and the left-out save points; 자세히 says what was checked", () => {
    const done = view({ ...applied, newerSkipped: 2 })
    expect(done.headline).toBe("인벤토리 화면 작업을 프로젝트 본 코드에 반영했어요")
    expect(done.lines).toEqual([{ text: "그 뒤 저장 지점 2개는 넣지 않았어요" }])
    expect(labels(done)).toEqual(["되돌리기", "원격 저장소에 올리기…", "검토 요청 올리기…"])
    expect(done.buttons.map((button) => button.action)).toEqual([
      { kind: "undo" },
      { kind: "push", pr: false },
      { kind: "push", pr: true },
    ])
    expect(done.details).toEqual([
      "검증한 것: 후보 a1b2c3d(프로젝트 본 코드 9f8e7d6 + 인벤토리 화면 4c3b2a1)",
      "코드 검사 통과 2분 14초",
      "큰 파일 검사는 건너뜀",
      "기록 이름: main",
    ])
    expect(view({ ...applied, newerSkipped: 0 }).lines).toEqual([])
  })

  test("후보 없이 반영: the subjects going in show while it runs and when it is done; all of them in 자세히 (7.1)", () => {
    const subjects = ["넷째 변경", "셋째 변경", "둘째 변경", "첫 변경"]
    const line = {
      text: "반영 준비 알림 없이 넣는 저장 지점 4개: 넷째 변경 · 셋째 변경 · 둘째 변경 …",
      tone: "muted" as const,
    }
    expect(view({ subjects }).lines).toEqual([line])
    const done = view({ ...applied, subjects })
    expect(done.lines).toEqual([line])
    expect(done.details).toEqual(expect.arrayContaining(subjects))
    expect(view({ subjects: ["한 변경"] }).lines).toEqual([
      { text: "반영 준비 알림 없이 넣는 저장 지점 1개: 한 변경", tone: "muted" },
    ])
  })

  test("이미 들어 있음: no candidate was made, so nothing to undo or upload", () => {
    const already = view({ state: "done", verify: {} })
    expect(already.headline).toBe("인벤토리 화면 작업은 이미 프로젝트 본 코드에 들어 있어요")
    expect(already.buttons).toEqual([])
  })

  test("uploaded: the remote is named, and a review request's page opens in the browser", () => {
    const url = "https://example.test/own/compare/main...inventory-ui"
    const pushed = view({ ...applied, pushed: { at: 3, remote: "origin", ref: "main", pr: url } })
    expect(pushed.lines).toEqual([{ text: "인벤토리 화면 작업을 원격 저장소 origin에 올렸어요" }])
    expect(pushed.buttons.map((button) => button.action)).toEqual([{ kind: "undo" }, { kind: "pr-page", url }])
    expect(labels(pushed)).toContain("검토 요청 열기")
    // Uploaded without a review request: the review request can still go up.
    const plain = view({ ...applied, pushed: { at: 3, remote: "origin", ref: "main" } })
    expect(plain.buttons.map((button) => button.action)).toEqual([{ kind: "undo" }, { kind: "push", pr: true }])
  })

  test("기다림: overlapping changes in the main folder, `[다시 반영]`; the paths only in 자세히", () => {
    const waiting = view({
      state: "waiting",
      base: B,
      candidate: K,
      verify: { code: { ok: true, ms: 134_000 } },
      waiting: { why: "dirty", directory: HOME, paths: ["src/inventory/sort.ts", "src/inventory/list.ts"] },
    })
    expect(waiting.headline).toBe("인벤토리 화면 반영하는 중")
    expect(waiting.tone).toBe("warn")
    expect(waiting.lines).toEqual([
      {
        text: "메인 폴더(own-open-code)에서 아직 저장 지점에 넣지 않은 파일 2개와 겹쳐요. 그 변경을 저장 지점에 넣거나 되돌린 뒤 '다시 반영'을 누르세요",
        tone: "warn",
      },
    ])
    expect(waiting.buttons).toEqual([{ label: "다시 반영", action: { kind: "retry" } }])
    expect(waiting.details).toEqual(expect.arrayContaining([HOME, "src/inventory/sort.ts", "src/inventory/list.ts"]))
    expect(copy(waiting).join("\n")).not.toContain("sort.ts")
  })

  test("기다림: stopped work in the main folder, another folder at work, a folder outside the team", () => {
    const line = (why: string, directory: string) =>
      view({ state: "waiting", waiting: { why, directory } }).lines[0]?.text
    expect(line("in-progress", HOME)).toBe("메인 폴더(own-open-code)에서 하던 기록 정리가 끝나면 반영해요")
    expect(line("in-use", "D:/own-open-code-team/cl-perf")).toBe("cl-perf에서 하던 일이 끝나면 반영해요")
    expect(line("outside", "D:/clones/other-clone")).toBe(
      "팀 밖의 other-clone 폴더가 프로젝트 본 코드를 쓰고 있어 기다려요",
    )
  })

  test("실패: the check that failed, `[로그 보기]` with its output; 자세히 names the command", () => {
    const failed = view({
      state: "failed",
      failure: "verify",
      base: B,
      candidate: K,
      verify: { code: { ok: false, ms: 9_000, failed: "bun run typecheck", log: "error TS2322: …" } },
    })
    expect(failed.headline).toBe("검사가 실패해서 반영하지 않았어요")
    expect(failed.tone).toBe("danger")
    expect(failed.buttons).toEqual([{ label: "로그 보기", action: { kind: "log" } }])
    expect(failed.log).toBe("error TS2322: …")
    expect(failed.details).toContain("코드 검사 실패: bun run typecheck")
    // The project's main code kept moving: apply again later. No log, no button for it.
    expect(kinds(view({ state: "failed", failure: "moved" }))).toEqual(["retry"])
    expect(view({ state: "failed" }).headline).toBe("반영하지 못했어요")
    expect(
      view({
        state: "failed",
        failure: "assets",
        verify: { assets: { ok: false, ms: 4_000, failed: "bun run check", log: "missing asset" } },
      }).headline,
    ).toBe("큰 파일 검사가 실패해서 반영하지 않았어요")
    // 두기 on making `.assets` the first time (4.10): no check ran, so the card does not say one failed.
    expect(view({ state: "failed", failure: "assets" }).headline).toBe(
      "큰 파일 검사 폴더를 만들지 않아 반영하지 않았어요",
    )
  })

  test("충돌: the owner sorts it out; how many files overlap, which ones in 자세히", () => {
    const conflict = view({ state: "conflict", conflicts: ["src/inventory/sort.ts", "Assets/ui.prefab"] })
    expect(conflict.headline).toBe("프로젝트 본 코드의 새 변경과 겹쳐서 담당에게 정리를 맡겼어요")
    expect(conflict.lines).toEqual([{ text: "겹친 파일 2개" }])
    expect(conflict.details).toEqual(expect.arrayContaining(["src/inventory/sort.ts", "Assets/ui.prefab"]))
    expect(conflict.buttons).toEqual([])
  })

  test("되돌림 and the undo the main has to take over once the project's main code moved on (7.4)", () => {
    expect(view({ ...applied, state: "undone", undone: { at: 5, opID: OP } }).headline).toBe(
      "인벤토리 화면 반영을 되돌렸어요",
    )
    const delegated = view(applied, { delegated: true })
    expect(delegated.buttons[0]).toEqual({ label: "메인에게 되돌리기 맡기기", action: { kind: "undo-main" } })
    expect(kinds(delegated)).not.toContain("undo")
    expect(delegated.lines).toContainEqual({
      text: "그 뒤 프로젝트 본 코드가 더 바뀌어 바로 되돌릴 수 없어요",
      tone: "muted",
    })
    // Without the prompt scope (or the team main), nothing is offered in its place.
    expect(kinds(view(applied, { delegated: true, can: integrationCan(access(), false) }))).toEqual(["push", "push"])
  })

  test("RH-42: an undo that waits says why and offers only 되돌리기 취소; the folder and paths are in 자세히", () => {
    const undoing = { since: 3, by: "user", why: "dirty", directory: HOME, paths: ["src/inventory/sort.ts"] }
    const waiting = view({ ...applied, undoing })
    expect(waiting.headline).toBe("인벤토리 화면 작업을 프로젝트 본 코드에 반영했어요")
    expect(waiting.tone).toBe("warn")
    expect(waiting.lines[0]).toEqual({
      text: "메인 폴더(own-open-code)에서 아직 저장 지점에 넣지 않은 파일 1개와 겹쳐 되돌리기를 기다려요",
      tone: "warn",
    })
    expect(waiting.buttons[0]).toEqual({ label: "되돌리기 취소", action: { kind: "undo-cancel" } })
    expect(kinds(waiting)).not.toContain("undo")
    expect(waiting.details).toEqual(expect.arrayContaining([HOME, "src/inventory/sort.ts"]))
    expect(copy(waiting).join(" ")).not.toContain("sort.ts")
    const line = (why: string, directory: string) =>
      view({ ...applied, undoing: { since: 3, by: "user", why, directory } }).lines[0]?.text
    expect(line("in-use", HOME)).toBe("메인 폴더(own-open-code)에서 하던 일이 끝나면 되돌려요")
    expect(line("in-progress", HOME)).toBe("메인 폴더(own-open-code)에서 하던 기록 정리가 끝나면 되돌려요")
    expect(line("outside", "D:/clones/other-clone")).toBe(
      "팀 밖의 other-clone 폴더가 프로젝트 본 코드를 쓰고 있어 되돌리기를 기다려요",
    )
    // A build without the feature, or a device without `prompt`, offers no button.
    const can = (scopes: readonly OwnScope[], features?: readonly OwnTeam.Feature[]) =>
      integrationCan(access(new Set(scopes), features), true)
    expect(kinds(view({ ...applied, undoing }, { can: can(["read", "prompt", "admin"], ["integrate"]) }))).toEqual([])
    expect(kinds(view({ ...applied, undoing }, { can: can(["read"]) }))).toEqual([])
    expect(teamWaitText.text("en", "own.team.wait.undoCancel")).toBe("Cancel undo")
  })

  test("buttons need the build's feature and the connection's scope (06 §2.7)", () => {
    const can = (scopes: readonly OwnScope[], features?: readonly OwnTeam.Feature[]) =>
      integrationCan(access(new Set(scopes), features), true)
    expect(kinds(view(applied, { can: can(["read", "prompt", "admin", "local"], ["integrate"]) }))).toEqual(["undo"])
    expect(kinds(view(applied, { can: can(["read", "prompt", "admin", "local"], []) }))).toEqual([])
    expect(
      kinds(view({ state: "waiting", waiting: { why: "dirty", directory: HOME } }, { can: can(["read"]) })),
    ).toEqual([])
  })

  test("a gateway device sees where to upload instead of the buttons (06 §9.8)", () => {
    // Phone browser or PWA, the Android app, another PC's 원격 PC window and the 모바일 미리보기 never hold `local`.
    const device = access(new Set<OwnScope>(["read", "prompt", "switch", "admin"]))
    const elsewhere = uploadElsewhere(ko, device, "DESKTOP-OWN")
    expect(elsewhere).toBe("DESKTOP-OWN에서 확인하세요")
    expect(uploadElsewhere(ko, device)).toBe("서비스를 실행하는 PC에서 확인하세요")
    expect(uploadElsewhere(ko, access())).toBeUndefined()
    expect(uploadElsewhere(ko, access(new Set<OwnScope>(["read"]), ["integrate"]))).toBeUndefined()
    const shown = view(applied, { can: integrationCan(device, true), ...(elsewhere ? { viewOnly: elsewhere } : {}) })
    expect(kinds(shown)).toEqual(["undo"])
    expect(shown.lines).toContainEqual({ text: "DESKTOP-OWN에서 확인하세요", tone: "muted" })
    expect(copy(shown).join("\n")).not.toMatch(/이 PC|this PC/)
  })

  test("the default copy has no git words, shas or paths (06 §9.1)", () => {
    const words = [
      "worktree",
      "branch",
      "commit",
      "merge",
      "rebase",
      "push",
      "HEAD",
      "checkout",
      "커밋",
      "브랜치",
      "머지",
    ]
    const shown = [
      view({ checks: { current: 1, total: 2 } }),
      view({ ...applied, newerSkipped: 1 }),
      view({ ...applied, pushed: { at: 3, remote: "origin", ref: "main", pr: "https://example.test/pr/1" } }),
      view({ state: "waiting", waiting: { why: "dirty", directory: HOME, paths: ["src/a.ts"] } }),
      view({ state: "failed", failure: "rewritten" }),
      view({ state: "conflict", conflicts: ["src/a.ts"] }),
      view(applied, { delegated: true }),
    ]
    for (const item of shown) {
      const text = copy(item).join("\n")
      for (const word of words) expect(text.toLowerCase(), word).not.toContain(word.toLowerCase())
      expect(text).not.toMatch(/[0-9a-f]{7,}|src\/|\bmain\b/)
    }
  })
})

describe("upload (06 §7.5)", () => {
  function transport(answers: Partial<Record<TeamMethod, (input: unknown) => unknown>>) {
    const calls: Array<{ method: TeamMethod; input: unknown }> = []
    const rpc: Pick<TeamRpc, "call"> = {
      async call(method, input) {
        calls.push({ method, input })
        const value = await answers[method]?.(input)
        if (value instanceof Error) throw value
        // SAFETY: each test answers a method with that method's output shape.
        return value as never
      },
    }
    return { rpc, calls }
  }

  const decodePlan = Schema.decodeUnknownSync(OwnTeam.Definition.methods["integration.push.plan"].output)
  const planned = (nonce: string, expiresAt = NOW + 600_000) =>
    decodePlan({
      nonce,
      expiresAt,
      remote: "origin",
      ref: "main",
      commands: ["git lfs push origin main", "git push origin main"],
    })

  test("plan -> confirm -> execute{nonce}: the nonce the dialog showed, nothing before the confirm", async () => {
    const fake = transport({
      "integration.push.plan": () => planned(NONCE),
      "integration.push.execute": () => ({ opID: OP }),
    })
    const plan = await planPush(fake.rpc, IG, false)
    expect(plan).toMatchObject({ integrationID: IG, pr: false, nonce: NONCE, remote: "origin", ref: "main" })
    expect(fake.calls).toEqual([{ method: "integration.push.plan", input: { integrationID: IG } }])
    expect(await executePush(fake.rpc, plan, NOW)).toEqual({ kind: "started", opID: OP })
    expect(fake.calls.at(-1)).toEqual({ method: "integration.push.execute", input: { nonce: NONCE } })
    await planPush(fake.rpc, IG, true)
    expect(fake.calls.at(-1)).toEqual({ method: "integration.push.plan", input: { integrationID: IG, pr: true } })
  })

  test("an expired nonce is never sent: a new plan comes back to confirm again", async () => {
    const fake = transport({
      "integration.push.plan": () => planned(NONCE2, NOW + 1_200_000),
      "integration.push.execute": () => ({ opID: OP }),
    })
    const old: PushPlan = { ...planned(NONCE, NOW), integrationID: IG, pr: true }
    const renewed = await executePush(fake.rpc, old, NOW)
    expect(renewed).toMatchObject({ kind: "renewed", plan: { nonce: NONCE2, pr: true, integrationID: IG } })
    expect(fake.calls.map((call) => call.method)).toEqual(["integration.push.plan"])
    expect(fake.calls[0]?.input).toEqual({ integrationID: IG, pr: true })
    if (renewed.kind !== "renewed") throw new Error("expected a new plan")
    expect(await executePush(fake.rpc, renewed.plan, NOW)).toEqual({ kind: "started", opID: OP })
    expect(fake.calls.at(-1)).toEqual({ method: "integration.push.execute", input: { nonce: NONCE2 } })
  })

  test("a refused nonce runs nothing and brings a new plan; other refusals go to the dialog", async () => {
    const refusing = transport({
      "integration.push.plan": () => planned(NONCE2),
      "integration.push.execute": () => new OwnRpcError("nonce_invalid", "expired"),
    })
    const plan: PushPlan = { ...planned(NONCE), integrationID: IG, pr: false }
    expect(await executePush(refusing.rpc, plan, NOW)).toMatchObject({ kind: "renewed", plan: { nonce: NONCE2 } })
    expect(refusing.calls.map((call) => call.method)).toEqual(["integration.push.execute", "integration.push.plan"])
    const rejected = transport({
      "integration.push.execute": () =>
        new OwnRpcError("remote_rejected", "rejected", { remote: "origin", message: "denied" }),
    })
    await expect(executePush(rejected.rpc, plan, NOW)).rejects.toMatchObject({ type: "remote_rejected" })
  })

  test("uploading needs the PC: a device's client refuses the plan without asking the service", async () => {
    const asked: string[] = []
    const rpc = createTeamRpc({
      client: () => {
        asked.push("client")
        throw new Error("a device's upload never reaches the service")
      },
      control: async () => "C:/control",
      scopes: () => new Set<OwnScope>(["read", "prompt", "switch", "admin"]),
    })
    await expect(planPush(rpc, IG, false)).rejects.toMatchObject({ type: "own.scope_denied" })
    expect(asked).toEqual([])
  })

  test("the toast when the upload op ends: uploaded, review request, large files first, a sign-in, or why", () => {
    const op = (state: string, steps: ReadonlyArray<Record<string, unknown>> = []) =>
      decodeOp({ id: OP, teamID: TEAM, kind: "integrate", by: "user", state, createdAt: 1, steps })
    const step = (kind: string, note?: string) => ({
      id: kind,
      kind,
      args: {},
      mode: "auto",
      state: "failed",
      ...(note ? { note } : {}),
    })
    expect(pushOutcome(ko, { pr: false, remote: "origin" }, op("done"))).toEqual({
      message: "원격 저장소 origin에 올렸어요",
    })
    expect(pushOutcome(ko, { pr: true, remote: "origin" }, op("done"))).toEqual({ message: "검토 요청을 올렸어요" })
    expect(pushOutcome(ko, { pr: false, remote: "origin" }, op("failed", [step("push-lfs")]))).toEqual({
      tone: "danger",
      message: "큰 파일을 먼저 올리지 못해 올리지 않았어요",
    })
    const prompt = "fatal: could not read Username for 'https://example.test': terminal prompts disabled"
    expect(pushOutcome(ko, { pr: false, remote: "origin" }, op("failed", [step("push", prompt)])).message).toBe(
      "원격 저장소에 로그인이 필요해요. 터미널에서 한 번 로그인해 주세요",
    )
    // The push step's rule (own.team integrate/push.ts) also counts an HTTP 401/403 as a sign-in.
    const refused = "fatal: unable to access 'https://example.test/x.git/': The requested URL returned error: 403"
    expect(pushOutcome(ko, { pr: false, remote: "origin" }, op("failed", [step("push", refused)])).message).toBe(
      "원격 저장소에 로그인이 필요해요. 터미널에서 한 번 로그인해 주세요",
    )
    expect(pushOutcome(ko, { pr: false, remote: "origin" }, op("failed", [step("push", "hook declined")]))).toEqual({
      tone: "danger",
      message: "올리지 못했어요: hook declined",
    })
    expect(pushOutcome(ko, { pr: false, remote: "origin" }, undefined).message).toBe(
      "올리지 못했어요: 팀 모드에서 오류가 났어요",
    )
  })
})

describe("the screens (06 §9.8, PF5)", () => {
  const sources = () =>
    [...new Glob("**/*.{ts,tsx}").scanSync(SRC)]
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !/\.test\.tsx?$/.test(file))

  test("the card and 결정 적기 load lazily: nothing outside the team chunk imports them statically", async () => {
    const statically = /^import\s+(?!type\b)[^;]*from\s+["']@\/team\/(integrate|integrate-model|decide)["']/m
    const offenders = await Promise.all(
      sources()
        .filter((file) => !file.startsWith("team/"))
        .map(async (file) => (statically.test(await Bun.file(path.join(SRC, file)).text()) ? [file] : [])),
    )
    expect(offenders.flat()).toEqual([])
    // `lazy(() => import(…))` needs a default export.
    for (const file of ["team/integrate.tsx", "team/decide.tsx"])
      expect(await Bun.file(path.join(SRC, file)).text(), file).toMatch(/^export default function \w+/m)
  })

  test("they talk to own.team through its typed client only, and hold no copy of their own", async () => {
    for (const file of ["team/integrate.tsx", "team/integrate-model.ts", "team/decide.tsx", "team/confirm.tsx"]) {
      const source = await Bun.file(path.join(SRC, file)).text()
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      expect(code.match(/[\uAC00-\uD7A3]+/g) ?? [], file).toEqual([])
      expect(code, file).not.toMatch(/client\(\)\.rpc|own\.accounts/)
      // Every call names an own.team method (src/data/team-rpc.ts); none goes to another plugin.
      const methods = [...code.matchAll(/\.call\(\s*"([\w.]+)"/g)].map((match) => match[1] ?? "")
      expect(methods.length, file).toBeGreaterThan(0)
      expect(
        methods.filter((method) => !Object.hasOwn(OwnTeam.MethodScope, method)),
        file,
      ).toEqual([])
    }
  })
})
