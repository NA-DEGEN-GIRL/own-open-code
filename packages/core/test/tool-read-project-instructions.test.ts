// OWN-PATCH(P-059) begin
// The read tool's nested AGENTS.md injection follows project instruction discovery: off injects nothing, on injects
// the folders between the file and the Location.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Image } from "@opencode/core/image"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { Environment } from "@opencode/core/environment/index"
import { Flag } from "@opencode/core/flag"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { Session } from "@opencode/core/session"
import { Skill } from "@opencode/core/skill"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Tool } from "@opencode/core/tool"
import { tempLocationLayer } from "./fixture/location"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { executeTool, registerToolPlugin } from "./lib/tool"

const readToolNode = makeLocationNode({
  name: "test/read-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    Tool.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    InstructionDiscovery.node,
    Skill.node,
    FSUtil.node,
    Environment.node,
    Location.node,
    Config.node,
    Flag.node,
  ],
})

const config = Config.testLayer()
const imageLayer = AppNodeBuilder.build(Image.node, [Config.node.replace(config)])

const layer = (project: boolean) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      Location.node,
      FSUtil.node,
      FileAccess.node,
      Environment.node,
      Flag.node,
      readToolNode,
      Tool.node,
      PluginHooks.node,
      SessionInstructions.node,
      InstructionDiscovery.node,
      Skill.node,
      Global.node,
      Image.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Location.node.replace(tempLocationLayer),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      Config.node.replace(config),
      Image.node.replace(imageLayer),
      InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project })),
    ],
  )

// Reads `sub/deep/file.txt` in a fresh session and returns the synthetic messages the read left behind.
const readNested = Effect.gen(function* () {
  const location = yield* Location.Service
  const dir = location.directory
  yield* Effect.promise(() => fs.mkdir(path.resolve(dir, "sub", "deep"), { recursive: true }))
  yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "AGENTS.md"), "sub-instructions"))
  yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "deep", "file.txt"), "file content"))
  const session = yield* Session.Service
  const registry = yield* Tool.Service
  const store = yield* SessionStore.Service
  const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id
  const read = yield* executeTool(registry, {
    sessionID,
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_nested"),
    call: { type: "tool-call", id: "call-nested", name: "read", input: { path: "sub/deep/file.txt" } },
  })
  expect(read.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("file content") })
  return (yield* store.context(sessionID)).filter((message) => message.type === "synthetic")
})

describe("ReadTool nested instructions follow project instruction discovery", () => {
  testEffect(layer(false)).live("off: a read below a folder with AGENTS.md injects nothing", () =>
    Effect.gen(function* () {
      expect(yield* readNested).toEqual([])
    }),
  )

  testEffect(layer(true)).live("on: the folder's AGENTS.md is injected", () =>
    Effect.gen(function* () {
      const injected = yield* readNested
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toContain("sub-instructions")
    }),
  )
})
// OWN-PATCH(P-059) end
