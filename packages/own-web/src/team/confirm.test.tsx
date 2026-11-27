// Team dialogs (06 §9.7, §9.8, §8.5, §8.6, §6.6; TG20 T2 part): the confirm dialog's content over the real view model,
// the real typed own.team client for scopes and a fake transport; fixtures go through the protocol's schemas. Covered:
// the focus starts on 두기 (나중에 for downloads), the removal list largest first with its sizes and the total, bundled
// removals, 받기 / 반영하기 / 하기, the time running out; every gateway host (phone browser or PWA, Android app,
// another PC's 원격 PC window, 모바일 미리보기) shows `<PC 이름>에서 확인하세요` with the service PC's name (the
// generic words without it, never "this PC") and no answer button; an expired or refused nonce is never answered
// again but read anew with `op.get`, and a changed list says so. Then 결정 적기: the record it writes, its limits and
// the list of records. The dialogs render only in the browser (own-web e2e), so the frame is checked in its source.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { OwnRpcError, type OwnScope } from "@/data/rpc"
import { createTeamRpc, type TeamMethod, type TeamRpc } from "@/data/team-rpc"
import { formatBytes } from "@/files/strings"
import { createI18n } from "@/i18n"
import { coming } from "@/limits/format"
import { answerConfirms, confirmView, renewConfirms } from "./confirm"
import { BODY_LIMIT, decisionDraft, decisionRows, TITLE_LIMIT } from "./decide"
import { errorText, type TeamText } from "./model"
import { teamText } from "./strings"

const TEAM = "tm_0123456789ab"
const OP = "op_01JB0000000000000000000000"
const NONCE = "n".repeat(43)
const NONCE2 = "m".repeat(43)
const NOW = 1_800_000_000_000
const LATER = NOW + 600_000
const AREA_DIR = "D:/own-open-code-team/cl-perf"

const ko: TeamText = (key, params) => teamText.text("ko", key, params)
const en: TeamText = (key, params) => teamText.text("en", key, params)
const bytes = (value: number) => formatBytes("ko", value)
/** The screen's coming-time words (`@/limits/format` `coming`) at the test's clock. */
const time = (at: number) => coming(createI18n("ko"), NOW, at)
const decodeConfirm = Schema.decodeUnknownSync(OwnTeam.Confirm)
const decodeOp = Schema.decodeUnknownSync(OwnTeam.Op)
const decodeDecision = Schema.decodeUnknownSync(OwnTeam.DecisionRecord)

function confirm(fields: Record<string, unknown> = {}) {
  return decodeConfirm({
    teamID: TEAM,
    opID: OP,
    stepID: "s1",
    kind: "retire-remove",
    nonce: NONCE,
    expiresAt: LATER,
    text: "server text",
    ...fields,
  })
}

const files = [
  { path: `${AREA_DIR}/dist`, bytes: 100_000_000 },
  { path: `${AREA_DIR}/node_modules`, bytes: 2_400_000_000 },
]
const removal = confirm({ files, manifest: "sha256:list-1" })

/** The step of an op that still waits for its confirm, as `op.get` returns it. */
function waitingStep(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    kind: "retire-remove",
    args: {},
    mode: "confirm",
    state: "needs_confirm",
    confirm: {
      nonce: NONCE2,
      expiresAt: LATER + 600_000,
      text: "server text",
      files,
      manifest: "sha256:list-1",
      ...fields,
    },
  }
}

function op(steps: ReadonlyArray<Record<string, unknown>>) {
  return decodeOp({ id: OP, teamID: TEAM, kind: "retire", by: "user", state: "waiting", createdAt: 1, steps })
}

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

function device(scopes: ReadonlySet<OwnScope>) {
  return createTeamRpc({
    client: () => {
      throw new Error("a device's answer never reaches the service")
    },
    control: async () => "C:/control",
    scopes: () => scopes,
  })
}

const SOURCE = path.join(import.meta.dir, "confirm.tsx")

describe("confirm dialog (06 §9.7, §8.6)", () => {
  test("a removal: focus on 두기, what is removed largest first with each size and the total, what stays", () => {
    const view = confirmView(ko, [removal], { local: true, now: NOW, bytes, time })
    expect(view.title).toBe("확인이 필요해요")
    expect(view.danger).toBe(true)
    // The first answer takes the focus: 두기 keeps everything.
    expect(view.buttons).toEqual([
      { choice: "skip", label: "두기" },
      { choice: "do", label: "지우기", tone: "danger" },
    ])
    expect(view.files).toEqual([
      { name: "node_modules", path: `${AREA_DIR}/node_modules`, size: bytes(2_400_000_000) },
      { name: "dist", path: `${AREA_DIR}/dist`, size: bytes(100_000_000) },
    ])
    expect(view.removes).toBe(`지워지는 것 · ${bytes(2_500_000_000)}`)
    expect(view.stays).toBe(true)
    expect(view.expired).toBe(false)
    // Ten minutes on: the coming time reads relative, never a bare clock that may be tomorrow (LV).
    expect(view.expires).toBe("10분 후까지 고르세요")
    expect(view.viewOnly).toBeUndefined()
  })

  test("finished areas go together: `끝난 영역 3개 정리(7.5 GB)`; a confirm's own byte count wins", () => {
    const three = ["s1", "s2", "s3"].map((stepID) => confirm({ stepID, bytes: 2_500_000_000, files }))
    expect(confirmView(ko, three, { local: true, now: NOW, bytes, time }).title).toBe(
      `끝난 영역 3개 정리(${bytes(7_500_000_000)})`,
    )
  })

  test("downloads say 나중에 / 받기, applying an area 두기 / 반영하기, anything else 두기 / 하기", () => {
    const answers = (item: OwnTeam.Confirm) =>
      confirmView(ko, [item], { local: true, now: NOW, bytes, time }).buttons.map((button) => [button.label, button.tone])
    expect(answers(confirm({ kind: "paths-add", bytes: 2_100_000_000 }))).toEqual([
      ["나중에", undefined],
      ["받기", "primary"],
    ])
    expect(answers(confirm({ kind: "integrate-advance" }))).toEqual([
      ["두기", undefined],
      ["반영하기", "primary"],
    ])
    expect(answers(confirm({ kind: "cone-set" }))).toEqual([
      ["두기", undefined],
      ["하기", "primary"],
    ])
    const fetch = confirmView(ko, [confirm({ kind: "paths-add", bytes: 1 })], { local: true, now: NOW, bytes, time })
    expect([fetch.danger, fetch.stays, fetch.removes, fetch.files]).toEqual([false, false, undefined, []])
  })

  test("when the time runs out the dialog says so", () => {
    const view = confirmView(ko, [removal], { local: true, now: LATER, bytes, time })
    expect(view.expired).toBe(true)
    expect(view.expires).toBe("확인 시간이 지났어요. 다시 하세요")
  })

  test("the frame: focus on the first answer, Tab kept inside, Escape and the scrim close, a danger dialog", async () => {
    const source = await Bun.file(SOURCE).text()
    expect(source).toContain('data-autofocus={index === 0 ? "" : undefined}')
    // A device has no answer: its only button, 닫기, takes the focus.
    expect(source).toMatch(/fallback=\{\s*<button type="button" class="own-team-btn" data-autofocus/)
    expect(source).toContain('role={props.role ?? "alertdialog"}')
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain('event.key !== "Escape"')
    expect(source).toContain('event.key !== "Tab"')
    expect(source).toMatch(/const FOCUSABLE =\s*'button:not\(\[disabled\]\), input:not\(\[disabled\]\), textarea/)
  })
})

describe("gateway devices see the dialog read-only (06 §9.8)", () => {
  /** Every host that reaches the service through the gateway: none ever holds `local` (05 §13.5). */
  const HOSTS: ReadonlyArray<{ readonly host: string; readonly scopes: readonly OwnScope[] }> = [
    { host: "phone browser or PWA", scopes: ["read", "prompt"] },
    { host: "Android app", scopes: ["read", "prompt", "switch"] },
    { host: "another PC's 원격 PC window", scopes: ["read", "prompt", "switch", "admin"] },
    { host: "모바일 미리보기", scopes: ["read"] },
  ]

  for (const item of HOSTS)
    test(`${item.host}: \`<PC 이름>에서 확인하세요\` with the service PC's name and no answer button`, async () => {
      const rpc = device(new Set(item.scopes))
      const local = rpc.allowed("op.confirm")
      expect(local).toBe(false)
      const named = confirmView(ko, [removal], { local, pc: "DESKTOP-OWN", now: NOW, bytes, time })
      expect(named.buttons).toEqual([])
      expect(named.viewOnly).toBe("DESKTOP-OWN에서 확인하세요")
      expect(confirmView(en, [removal], { local, pc: "DESKTOP-OWN", now: NOW, bytes, time }).viewOnly).toBe(
        "Confirm on DESKTOP-OWN",
      )
      // An older gateway that does not name the PC: the PC in words.
      const unnamed = confirmView(ko, [removal], { local, now: NOW, bytes, time })
      expect(unnamed.viewOnly).toBe("서비스를 실행하는 PC에서 확인하세요")
      expect(JSON.stringify([named, unnamed])).not.toMatch(/이 PC|this PC/)
      // The list is still there to read.
      expect(named.files).toHaveLength(2)
      await expect(
        rpc.call("op.confirm", { opID: OP, stepID: "s1", choice: "do", nonce: NONCE }),
      ).rejects.toMatchObject({ type: "own.scope_denied" })
    })

  test("a PC window answers", () => {
    const rpc = device(new Set<OwnScope>(["read", "prompt", "switch", "admin", "local"]))
    const view = confirmView(ko, [removal], { local: rpc.allowed("op.confirm"), pc: "DESKTOP-OWN", now: NOW, bytes, time })
    expect(view.buttons).toHaveLength(2)
    expect(view.viewOnly).toBeUndefined()
  })
})

describe("an expired or refused nonce (06 §8.5)", () => {
  test("a nonce that ran out is never sent: op.get brings the step's new one", async () => {
    const fake = transport({ "op.get": () => ({ op: op([waitingStep("s1")]) }) })
    const result = await answerConfirms(
      fake.rpc,
      [confirm({ files, manifest: "sha256:list-1", expiresAt: NOW })],
      "do",
      NOW,
    )
    expect(fake.calls).toEqual([{ method: "op.get", input: { opID: OP } }])
    expect(result).toMatchObject({ kind: "renewed", changed: false })
    if (result.kind !== "renewed") throw new Error("expected the confirm again")
    expect(result.confirms).toHaveLength(1)
    expect(result.confirms[0]).toMatchObject({ teamID: TEAM, opID: OP, stepID: "s1", nonce: NONCE2 })
    // What comes back is a confirm the dialog can answer.
    expect(Schema.is(OwnTeam.Confirm)(result.confirms[0])).toBe(true)
  })

  test("a refused nonce: the op is read again, and a list that changed meanwhile says so", async () => {
    const fake = transport({
      "op.confirm": () => new OwnRpcError("nonce_invalid", "expired"),
      "op.get": () => ({
        op: op([
          waitingStep("s1", { files: [...files, { path: `${AREA_DIR}/.cache`, bytes: 5 }], manifest: "sha256:list-2" }),
        ]),
      }),
    })
    const result = await answerConfirms(fake.rpc, [removal], "do", NOW)
    expect(fake.calls.map((call) => call.method)).toEqual(["op.confirm", "op.get"])
    expect(fake.calls[0]?.input).toEqual({ opID: OP, stepID: "s1", choice: "do", nonce: NONCE })
    expect(result).toMatchObject({ kind: "renewed", changed: true })
    if (result.kind !== "renewed") throw new Error("expected the confirm again")
    expect(confirmView(ko, result.confirms, { local: true, now: NOW, bytes, time }).files).toHaveLength(3)
  })

  test("several confirms answer in order with their own nonces; the first refusal stops the rest", async () => {
    const second = confirm({ stepID: "s2", nonce: NONCE2, files, manifest: "sha256:list-1" })
    const fine = transport({ "op.confirm": () => ({ op: op([]) }) })
    expect(await answerConfirms(fine.rpc, [removal, second], "skip", NOW)).toEqual({ kind: "done" })
    expect(fine.calls.map((call) => call.input)).toEqual([
      { opID: OP, stepID: "s1", choice: "skip", nonce: NONCE },
      { opID: OP, stepID: "s2", choice: "skip", nonce: NONCE2 },
    ])
    // The second nonce is refused: only it is read again, the first was answered.
    const partly = transport({
      "op.confirm": (input) =>
        (input as { stepID: string }).stepID === "s2" ? new OwnRpcError("nonce_invalid", "expired") : { op: op([]) },
      "op.get": () => ({ op: op([{ ...waitingStep("s1"), state: "done" }, waitingStep("s2")]) }),
    })
    const renewed = await answerConfirms(partly.rpc, [removal, second], "do", NOW)
    expect(renewed.kind === "renewed" && renewed.confirms.map((item) => item.stepID)).toEqual(["s2"])
    const off = transport({ "op.confirm": () => new OwnRpcError("team_off", "off", { teamID: TEAM }) })
    const refused = await answerConfirms(off.rpc, [removal, second], "do", NOW)
    expect(off.calls).toHaveLength(1)
    expect(refused.kind === "refused" && errorText(ko, refused.error)).toBe("팀 모드가 꺼져 있어요")
  })

  test("a step answered elsewhere, or an op that is gone, leaves nothing to confirm; a failed read keeps it", async () => {
    const answered = transport({ "op.get": () => ({ op: op([{ ...waitingStep("s1"), state: "skipped" }]) }) })
    expect(await renewConfirms(answered.rpc, [removal])).toEqual({ confirms: [], changed: false })
    const gone = transport({ "op.get": () => new OwnRpcError("not_found", "op", { what: "op", id: OP }) })
    expect(await renewConfirms(gone.rpc, [removal])).toEqual({ confirms: [], changed: false })
    // A read that fails on the way keeps what is shown: the user answers it again later.
    const offline = transport({ "op.get": () => new Error("network") })
    expect(await renewConfirms(offline.rpc, [removal])).toEqual({ confirms: [removal], changed: false })
  })
})

describe("a bundle where one removal fails, and files that cannot be made again (06 §8.6)", () => {
  test("every confirm is answered; a step that failed comes back as its note, and the rest went on", async () => {
    const second = confirm({ stepID: "s2", nonce: NONCE2, files, manifest: "sha256:list-1" })
    const note = "다른 프로그램이 폴더를 쓰고 있어요. 그 프로그램을 닫은 뒤 다시 시도하세요"
    const fake = transport({
      "op.confirm": (input) => {
        const stepID = (input as { readonly stepID: string }).stepID
        return {
          op: decodeOp({
            id: OP,
            teamID: TEAM,
            kind: "disable",
            by: "user",
            state: stepID === "s1" ? "waiting" : "failed",
            createdAt: 1,
            steps: [
              { id: "s1", kind: "retire-remove", args: {}, mode: "confirm", state: "failed", note },
              {
                id: "s2",
                kind: "retire-remove",
                args: {},
                mode: "confirm",
                state: stepID === "s1" ? "needs_confirm" : "done",
                ...(stepID === "s1" ? { confirm: { nonce: NONCE2, expiresAt: LATER, text: "x" } } : {}),
              },
            ],
          }),
        }
      },
    })
    expect(await answerConfirms(fake.rpc, [removal, second], "do", NOW)).toEqual({ kind: "done", failed: [note] })
    expect(fake.calls.map((call) => (call.input as { readonly stepID: string }).stepID)).toEqual(["s1", "s2"])
    expect(ko("own.team.confirm.stepFailed", { reason: note })).toBe(`끝나지 않은 단계가 있어요: ${note}`)
  })

  test("a confirm of an op that ended (failed, done) is never shown again", async () => {
    const ended = transport({
      "op.get": () => ({ op: { ...op([waitingStep("s1")]), state: "failed" } }),
    })
    expect(await renewConfirms(ended.rpc, [removal])).toEqual({ confirms: [], changed: false })
  })

  test("an ignored file that cannot be made again is flagged in the removal list", () => {
    const lost = confirm({
      files: [
        { path: `${AREA_DIR}/data`, bytes: 2_000_000_000, irreplaceable: true },
        { path: `${AREA_DIR}/node_modules`, bytes: 400_000_000 },
      ],
      manifest: "sha256:list-3",
    })
    const view = confirmView(ko, [lost], { local: true, now: NOW, bytes, time })
    expect(view.files).toEqual([
      { name: "data", path: `${AREA_DIR}/data`, size: bytes(2_000_000_000), irreplaceable: true },
      { name: "node_modules", path: `${AREA_DIR}/node_modules`, size: bytes(400_000_000) },
    ])
    expect(ko("own.team.confirm.irreplaceable")).toBe("다시 만들 수 없음")
  })

  test("the 남는 것 line comes from the removal step's unapplied count", () => {
    const view = confirmView(ko, [removal], {
      local: true,
      now: NOW,
      bytes,
      time,
      args: () => ({ areaID: "ar_cl-perf", unapplied: 2 }),
    })
    expect(view.unapplied).toBe("반영하지 않은 저장 지점 2개는 기록에 남아요")
  })
})

describe("결정 적기 (06 §6.6)", () => {
  const add = Schema.is(OwnTeam.Definition.methods["decisions.add"].input)

  test("the record is trimmed; an empty title or a part that is too long cannot be saved", () => {
    expect(decisionDraft("  결제 화면은 서버에서 그린다 ", "\n이유: 첫 화면이 빨라야 한다\n")).toEqual({
      title: "결제 화면은 서버에서 그린다",
      body: "이유: 첫 화면이 빨라야 한다",
    })
    expect(decisionDraft("   ", "body")).toBeUndefined()
    expect(decisionDraft("x".repeat(TITLE_LIMIT), "")).toEqual({ title: "x".repeat(TITLE_LIMIT), body: "" })
    expect(decisionDraft("x".repeat(TITLE_LIMIT + 1), "")).toBeUndefined()
    expect(decisionDraft("title", "y".repeat(BODY_LIMIT + 1))).toBeUndefined()
  })

  test("the limits are the protocol's: what the dialog sends passes `decisions.add`", () => {
    const draft = decisionDraft("x".repeat(TITLE_LIMIT), "y".repeat(BODY_LIMIT))
    expect(draft && add({ teamID: TEAM, ...draft })).toBe(true)
    expect(add({ teamID: TEAM, title: "x".repeat(TITLE_LIMIT + 1), body: "" })).toBe(false)
    expect(add({ teamID: TEAM, title: "t", body: "y".repeat(BODY_LIMIT + 1) })).toBe(false)
    expect(add({ teamID: TEAM, title: "", body: "" })).toBe(false)
    expect(OwnTeam.MethodScope["decisions.add"]).toBe("prompt")
  })

  test("the records so far, newest first, with who wrote them", () => {
    const record = (number: number, source: string) =>
      decodeDecision({
        number,
        title: `결정 ${number}`,
        file: `decisions/000${number}-d.md`,
        at: number,
        source,
        areas: [],
      })
    expect(decisionRows(ko, [record(1, "user"), record(3, "main"), record(2, "user")])).toEqual([
      { number: 3, title: "3. 결정 3", source: "메인이 적음" },
      { number: 2, title: "2. 결정 2", source: "사용자가 적음" },
      { number: 1, title: "1. 결정 1", source: "사용자가 적음" },
    ])
  })

  test("a form in the shared frame: focus on the title, `decisions.add` through the team client", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "decide.tsx")).text()
    expect(source).toContain('role="dialog"')
    expect(source).toMatch(/<TextField[\s\S]*?data-autofocus[\s\S]*?\/>/)
    expect(source).toContain('team.rpc.call("decisions.add", { teamID: props.teamID, ...value })')
    expect(source).toContain('rpc.call("decisions.list", { teamID: props.teamID })')
    expect(source).toContain('rpc.allowed("decisions.add")')
  })
})
