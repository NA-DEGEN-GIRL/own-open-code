// OWN-PATCH(P-047) begin
// The permission hook's `evaluate` names the project's saved approvals of the asked action as they are saved now, so a
// plugin can tell an allow a saved rule gives (`항상 허용`) from one the agent's or the session's rules give.
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { SessionStore } from "@opencode/core/session/store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, PermissionSaved.node, Agent.node, PluginHooks.node, Permission.node]),
    [Location.node.replace(current)],
  ),
)

it.effect("evaluate names the saved approvals of the asked action, as saved now", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: Session.ID.make("ses_saved"),
        project_id: Project.ID.global,
        slug: "saved",
        directory: "/project",
        title: "saved",
        version: "test",
        agent: Agent.ID.make("test"),
      })
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      }),
    )
    const seen: Array<ReadonlyArray<string> | undefined> = []
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("permission", "evaluate", (event) => Effect.sync(() => void seen.push(event.saved)))
    const saved = yield* PermissionSaved.Service
    yield* saved.add({ projectID: Project.ID.global, action: "github.write", resources: ["a octo/hello", "b octo/x"] })
    yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })
    const service = yield* Permission.Service
    const ask = (resources: string[]) =>
      service.ask({ sessionID: Session.ID.make("ses_saved"), action: "github.write", resources })
    // The agent's `*` allows it either way; the hook sees which saved approvals exist for the action.
    expect(yield* ask(["a octo/other"])).toMatchObject({ effect: "allow" })
    expect(seen.at(-1)?.toSorted()).toEqual(["a octo/hello", "b octo/x"])
    const [first] = (yield* saved.list({ projectID: Project.ID.global })).filter((item) => item.resource === "a octo/hello")
    yield* saved.remove(first!.id)
    yield* ask(["a octo/hello"])
    expect(seen.at(-1)).toEqual(["b octo/x"])
  }),
)
// OWN-PATCH(P-047) end
