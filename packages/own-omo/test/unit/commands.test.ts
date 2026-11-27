// omo's commands in own (15 §3.4): `/stop-continuation` runs omo's hook and sends omo's template; own's
// `/resume-continuation` runs omo's hook only (OMO-P8 clears the stop there), sends nothing and lets an idle session
// continue; outside an omo session both fail with the `omo (원본)` message, and in own.team's sessions
// `/resume-continuation` fails with the team message (15 §3.10). The command hook here stands in for omo's.
import { describe, expect, test } from "bun:test"
import type { CommandDefinition } from "@opencode/plugin/effect/command"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Exit } from "effect"
import { Commands } from "../../src/host/commands.js"

function registered(omo: boolean, team = false) {
  const commands = new Map<string, CommandDefinition>()
  const prompts: Array<Record<string, unknown>> = []
  const hooked: Array<string> = []
  const resumed: Array<string> = []
  // SAFETY: the fake implements the command registration and the prompt Commands.register uses.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const ctx = {
    command: {
      transform: (callback: (editor: { add: (command: CommandDefinition) => void }) => void) =>
        Effect.sync(() => callback({ add: (command) => void commands.set(command.name, command) })),
      reload: () => Effect.void,
    },
    session: { prompt: (input: Record<string, unknown>) => Effect.sync(() => void prompts.push(input)) },
  } as unknown as Pick<Context, "command" | "session">
  Effect.runSync(
    Effect.scoped(
      Commands.register(ctx, {
        commands: { "stop-continuation": { description: "Stop all continuation mechanisms", template: "Stop. $ARGUMENTS" } },
        hooks: { "command.execute.before": async (input) => void hooked.push(input.command) },
        isOmo: async () => omo,
        isTeam: async () => team,
        resumed: (sessionID) => void resumed.push(sessionID),
      }),
    ),
  )
  const run = (name: string) =>
    Effect.runPromiseExit(
      commands.get(name)!.execute({ sessionID: "ses_1" as never, prompt: { text: "" }, delivery: "steer" }),
    )
  return { commands, prompts, hooked, resumed, run }
}

describe("Commands (15 §3.4)", () => {
  test("/resume-continuation runs omo's hook only and lets the session continue; /stop-continuation sends its template", async () => {
    const omo = registered(true)
    expect([...omo.commands.keys()]).toEqual(["stop-continuation", Commands.RESUME])
    expect(omo.commands.get(Commands.RESUME)!.description).toBe(Commands.RESUME_DESCRIPTION)
    expect(Exit.isSuccess(await omo.run(Commands.RESUME))).toBe(true)
    expect(omo.hooked).toEqual(["resume-continuation"])
    expect(omo.resumed).toEqual(["ses_1"])
    expect(omo.prompts).toEqual([])
    expect(Exit.isSuccess(await omo.run("stop-continuation"))).toBe(true)
    expect(omo.hooked).toEqual(["resume-continuation", "stop-continuation"])
    expect(omo.prompts).toEqual([{ sessionID: "ses_1", text: "Stop. ", delivery: "steer" }])
  })

  test("outside an omo session both fail with the omo (원본) message", async () => {
    const other = registered(false)
    for (const name of ["stop-continuation", Commands.RESUME]) {
      const exit = await other.run(name)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("omo (원본) 세션에서만 써요.")
    }
    expect(other.hooked).toEqual([])
    expect(other.resumed).toEqual([])
    expect(other.prompts).toEqual([])
  })

  test("in own.team's sessions /resume-continuation fails with the team message and runs nothing", async () => {
    const team = registered(true, true)
    const exit = await team.run(Commands.RESUME)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(Commands.TEAM)
    expect(team.hooked).toEqual([])
    expect(team.resumed).toEqual([])
    expect(Exit.isSuccess(await team.run("stop-continuation"))).toBe(true)
    expect(team.hooked).toEqual(["stop-continuation"])
  })
})
