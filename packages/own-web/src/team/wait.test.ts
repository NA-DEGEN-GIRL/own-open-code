// The wait of a running team op on its card (RH-20, 06 §8.9, §9.3): the step n/m, the wait's text and its minutes from
// `since`, the commands that hold the folder, the buttons the wait offers that this device may call (the one that goes
// on first), 대화 열기, and an op that waits only for confirms offering 취소. Fixtures go through the protocol's schema;
// the strings come from the lazy catalog (not the first chunk, PF5).
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import type { OpProgress } from "./store"
import { waitView } from "./wait"
import { teamWaitText } from "./wait-strings"

const NOW = 1_800_000_000_000
const decodeOp = Schema.decodeUnknownSync(OwnTeam.Op)
const all = () => true

function op(fields: Record<string, unknown> = {}, first: Record<string, unknown> = {}) {
  return decodeOp({
    id: "op_01JB0000000000000000000000",
    teamID: "tm_0123456789ab",
    kind: "rotate",
    by: "main",
    state: "running",
    areaID: "ar_api",
    createdAt: NOW - 17 * 60_000,
    steps: [
      {
        id: "s1",
        kind: "rotate.begin",
        args: {},
        mode: "auto",
        state: "pending",
        startedAt: NOW - 17 * 60_000,
        ...first,
      },
      { id: "s2", kind: "rotate.handoff", args: {}, mode: "auto", state: "pending" },
    ],
    ...fields,
  })
}

const WAIT = Schema.decodeUnknownSync(OwnTeam.StepWait)({
  why: "safe-point",
  detail: "shell",
  text: "api: 실행 중인 명령이 끝나기를 기다려요: 'bun run dev'",
  since: NOW - 17 * 60_000,
  sessionIDs: ["ses_owner000000000000000000001"],
  shells: [{ id: "sh_1", command: "bun run dev", kind: "shell" }],
  actions: ["cancel", "force", "stop-shell"],
})

describe("a running op's wait (RH-20)", () => {
  test("the step, the text, the minutes, the commands and the buttons the wait offers, going on first", () => {
    const view = waitView({ op: op({}, { wait: WAIT }), allowed: all, now: NOW })
    expect(view).toEqual({
      n: 1,
      m: 2,
      text: WAIT.text,
      minutes: 17,
      shells: WAIT.shells ?? [],
      actions: [
        { action: "stop-shell", key: "own.team.wait.stopShell" },
        { action: "force", key: "own.team.wait.force" },
        { action: "cancel", key: "own.team.wait.cancel" },
      ],
      sessionID: "ses_owner000000000000000000001",
    })
    // A device without `admin` (op.force) keeps 취소 only.
    expect(
      waitView({ op: op({}, { wait: WAIT }), allowed: (action) => action === "cancel", now: NOW })?.actions,
    ).toEqual([{ action: "cancel", key: "own.team.wait.cancel" }])
  })

  test("op.progress wins over the record; a step that ended or does not wait shows nothing", () => {
    const live: OpProgress = {
      teamID: "tm_0123456789ab",
      steps: { s1: { state: "pending", text: "x", wait: { ...WAIT, text: "새 이유", actions: ["cancel"] } } },
    }
    expect(waitView({ op: op({}, { wait: WAIT }), live, allowed: all, now: NOW })).toMatchObject({
      text: "새 이유",
      actions: [{ action: "cancel" }],
    })
    const ended = { teamID: "tm_0123456789ab", steps: { s1: { state: "done" as const, text: "끝" } } }
    expect(waitView({ op: op({}, { wait: WAIT }), live: ended, allowed: all, now: NOW })).toBeUndefined()
    expect(waitView({ op: op(), allowed: all, now: NOW })).toBeUndefined()
  })

  test("an op that waits only for confirms offers 취소", () => {
    const waiting = op({ state: "waiting" }, { mode: "confirm", state: "needs_confirm" })
    expect(waitView({ op: waiting, allowed: all, now: NOW })).toEqual({
      n: 1,
      m: 2,
      shells: [],
      actions: [{ action: "cancel", key: "own.team.wait.cancel" }],
    })
  })

  test("the strings say it in 해요체 and live in the lazy catalog", () => {
    expect(teamWaitText.text("ko", "own.team.wait.step", { n: 1, m: 5 })).toBe("단계 1/5")
    expect(teamWaitText.text("ko", "own.team.wait.since", { n: 17 })).toBe("17분째")
    expect(teamWaitText.text("ko", "own.team.wait.cancelled")).toBe("작업을 취소했어요")
    expect(teamWaitText.text("en", "own.team.wait.stopShell")).toBe("Stop the command and go on")
    // Only the lazy card imports them: nothing in src/team/strings.ts or the first chunk's modules.
    const store = fs.readFileSync(path.join(import.meta.dir, "store.ts"), "utf8")
    expect(store).not.toContain("wait-strings")
  })
})
