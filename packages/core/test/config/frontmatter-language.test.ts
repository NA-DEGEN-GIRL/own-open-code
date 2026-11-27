// OWN-PATCH(P-036) begin
import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { ConfigMarkdown } from "@opencode/core/config/markdown"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { offlineModels } from "../fixture/models"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// tempGlobalLayer with a temporary home too: the Claude and Agents compatibility roots are the home's `.claude`
// and `.agents`, which must never be this PC's.
const globalLayer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) =>
      Global.layerWith({
        home: path.join(tmp.path, "home"),
        data: path.join(tmp.path, "data"),
        cache: path.join(tmp.path, "cache"),
        config: path.join(tmp.path, "config"),
        state: path.join(tmp.path, "state"),
        tmp: path.join(tmp.path, "tmp"),
        bin: path.join(tmp.path, "cache", "bin"),
        log: path.join(tmp.path, "data", "log"),
        repos: path.join(tmp.path, "data", "repos"),
      }),
    ),
  ),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node, Global.node]),
    [Global.node.replace(globalLayer), offlineModels],
  ),
)

// gray-matter's default `javascript` engine evaluates a `---js` block with eval() in the server process.
const script = (marker: string) => `---js\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n---\nBody`

describe("ConfigMarkdown frontmatter languages", () => {
  test("refuses every frontmatter language but YAML without running it, like malformed YAML", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "ran")
    for (const input of [
      script(marker),
      script(marker).replace("---js", "---javascript"),
      "---coffee\ndescription: 'x'\n---\nBody",
      '---json\n{"description": "x"}\n---\nBody',
      "---toml\ndescription = 'x'\n---\nBody",
    ]) {
      expect(() => ConfigMarkdown.parse(input)).toThrow()
      expect(ConfigMarkdown.parseOption(input)).toBeUndefined()
    }
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(ConfigMarkdown.parse("---yaml\ndescription: x\n---\nBody").data).toEqual({ description: "x" })
    expect(ConfigMarkdown.parse("---YML\ndescription: x\n---\nBody").data).toEqual({ description: "x" })
    expect(ConfigMarkdown.parse("").data).toEqual({})
  })

  it.live("loads no skill, agent or command whose frontmatter is a script, from any root", () =>
    Effect.gen(function* () {
      const global = yield* Global.Service
      const project = (yield* tmpdirScoped()).path
      const markers = path.join(project, "markers")
      const files = {
        [path.join(project, ".opencode", "skills", "scripted-opencode", "SKILL.md")]: "opencode-skill",
        [path.join(project, ".claude", "skills", "scripted-claude", "SKILL.md")]: "claude-skill",
        [path.join(project, ".agents", "skills", "scripted-agents", "SKILL.md")]: "agents-skill",
        [path.join(global.home, ".claude", "skills", "scripted-home", "SKILL.md")]: "home-skill",
        [path.join(global.home, ".agents", "skills", "scripted-home-agents", "SKILL.md")]: "home-agents-skill",
        [path.join(global.config, "skills", "scripted-global", "SKILL.md")]: "global-skill",
        [path.join(project, ".opencode", "agents", "scripted.md")]: "agent",
        [path.join(project, ".opencode", "commands", "scripted.md")]: "command",
      }
      yield* Effect.promise(async () => {
        await fs.mkdir(markers)
        for (const [file, name] of Object.entries(files)) {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, script(path.join(markers, name)))
        }
        await fs.mkdir(path.join(project, ".opencode", "skills", "plain"), { recursive: true })
        await fs.writeFile(
          path.join(project, ".opencode", "skills", "plain", "SKILL.md"),
          "---\nname: plain\ndescription: Plain\n---\nBody",
        )
        await fs.writeFile(path.join(project, ".opencode", "agents", "plain.md"), "---\ndescription: Plain\n---\nBody")
        await fs.writeFile(
          path.join(project, ".opencode", "commands", "plain.md"),
          "---\ndescription: Plain\n---\nBody",
        )
      })

      const loaded = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        const skills = yield* Skill.Service
        const agents = yield* Agent.Service
        const commands = yield* Command.Service
        return {
          skills: (yield* skills.list())
            .map((skill) => skill.id)
            .filter((id) => id === "plain" || id.startsWith("scripted")),
          plainAgent: yield* agents.get(Agent.ID.make("plain")),
          scriptedAgent: yield* agents.get(Agent.ID.make("scripted")),
          plainCommand: yield* commands.get("plain"),
          scriptedCommand: yield* commands.get("scripted"),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
      )

      expect(yield* Effect.promise(() => fs.readdir(markers))).toEqual([])
      expect(loaded.skills).toEqual([Skill.ID.make("plain")])
      expect(loaded.plainAgent).toBeDefined()
      expect(loaded.scriptedAgent).toBeUndefined()
      expect(loaded.plainCommand).toBeDefined()
      expect(loaded.scriptedCommand).toBeUndefined()
    }),
  )
})
// OWN-PATCH(P-036) end
