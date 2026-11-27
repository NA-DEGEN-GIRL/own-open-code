// A tiny fake repository of a real game repository's shape for the live team split (team-split.ts, design 8.4; rpg-fit-final 3.4):
// shared ledgers at the root, registries, seam files and stamped files, `AGENTS.md` with the owner's hand rules
// (`.worktree/<작업>` with the `WORKTREES.md` table, DEBUG only, registries and stamps only for the integrator), the
// code trees `src`, `server`, `scripts`, text studio folders, and binary asset folders: **H** folders hold at least
// `heavyMiB` (default 50) MiB of generated binary each, **h** folders a little. The binary bytes are generated here at
// run time and committed in the fixture repository only; nothing of it is kept in own-open-code.
//
// One work folder: no linked worktree. The branches are kept as the owner's repository has them: 72 folderless
// `codex/<task>-<YYYYMMDD>` branches (merged, so the alphabetically first ones are stale), four unmerged ones with real
// commits, one of them with a branch-only workshop folder `studio/dungeon-lab/` of 60+ MiB, ten `codex/r262-*` children
// of another, and an untracked delivery file plus ~50 loose untracked files in the home.
//
//   bun script/live/fixtures/rpg-skeleton.ts --out <dir> [--heavy-mib <n>]     builds it and prints the summary
//
// No model, no server: the builder runs by itself (it is how team-split.ts's fixture is checked without a model).
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const NAME = "rpg-skel"

/** The H folders (≥ `heavyMiB` of binary each) and the h folders (binary, a little). */
export const HEAVY = [
  "studio/cosmetics/candidates",
  "assets-src/rift-boss-a/minions",
  "assets-src/concepts",
  "public/assets/monsters",
  "public/assets/terrain",
  "public/assets/iso/atlas",
  "public/studio",
  "docs/handoffs/boss-art",
] as const
export const LIGHT = [
  "studio/imports",
  "studio/remaining-items",
  "assets-src/skill-icons",
  "public/assets/items",
  "public/assets/ui",
  "public/assets/npc",
  "public/assets/fx",
  "public/assets/portraits",
  "public/assets/weapons",
  "public/assets/armor",
  "public/assets/iso/enemies",
  "public/assets/iso/tiles",
] as const

export interface Built {
  readonly home: string
  readonly branches: number
  readonly heavyMiB: number
  readonly files: number
}

export function rpgSkeleton(base: string, options: { readonly heavyMiB?: number } = {}): Built {
  const heavyMiB = options.heavyMiB ?? 50
  const home = path.join(base, NAME)
  fs.mkdirSync(home, { recursive: true })
  const git = gitIn(home)
  git("init", "-q", "-b", "main")
  git("config", "user.name", NAME)
  git("config", "user.email", `${NAME}@example.test`)
  git("config", "core.autocrlf", "false")
  Object.entries(TEXT).forEach(([file, text]) => put(home, file, text))
  // Registries hold one row per subject, so two areas that both add a boss edit the same lines.
  HEAVY.forEach((folder, index) => binary(home, folder, heavyMiB * 1024 ** 2, index))
  LIGHT.forEach((folder, index) => binary(home, folder, 2 * 1024 ** 2, 100 + index))
  git("add", "-A")
  git("commit", "-qm", "rpg skeleton")
  // 72 folderless task branches, merged (they point at main's history): the first ones alphabetically are stale.
  const tasks = Array.from({ length: 72 }, (_, index) => `codex/${TASK_WORDS[index % TASK_WORDS.length]}-${index}-2026${String(1 + (index % 9)).padStart(2, "0")}${String(10 + (index % 18))}`)
  tasks.forEach((branch) => git("branch", branch))
  // Four unmerged branches with real commits; `codex/dungeon-lab-20261101` carries the branch-only workshop folder.
  const unmerged = [
    { branch: "codex/rift-boss-a-20261103", file: "src/game/data/rift/BossA.ts", text: "export const bossA = { id: \"rift-boss-a\", hp: 9000 }\n" },
    { branch: "codex/mud-shop-20261105", file: "src/chat/shop.ts", text: "export const shop = [] as string[]\n" },
    { branch: "codex/r262-items-20261106", file: "src/game/data/items.ts", text: `${TEXT["src/game/data/items.ts"]}export const r262 = 1\n` },
    { branch: "codex/dungeon-lab-20261101", file: "studio/dungeon-lab/README.md", text: "# dungeon lab (workshop, never merged)\n" },
  ]
  unmerged.forEach((item) => {
    git("checkout", "-q", "-b", item.branch, "main")
    put(home, item.file, item.text)
    if (item.branch.includes("dungeon-lab")) binary(home, "studio/dungeon-lab/bake", (heavyMiB + 10) * 1024 ** 2, 200)
    git("add", "-A")
    git("commit", "-qm", `${item.branch}: work`)
  })
  // Ten sub-branches of the r262 workshop.
  Array.from({ length: 10 }, (_, index) => `codex/r262-${index}-20261107`).forEach((branch) =>
    git("branch", branch, "codex/r262-items-20261106"),
  )
  git("checkout", "-q", "main")
  // Untracked: a delivery file in a workshop folder and loose files in the home.
  put(home, "studio/cosmetics/delivery-20261110.json", '{ "items": ["sand-crown"] }\n')
  Array.from({ length: 50 }, (_, index) => put(home, `.work/note-${index}.txt`, `loose ${index}\n`))
  const branches = git("branch", "--list").split("\n").filter((line) => line.trim() !== "").length
  const files = git("ls-files").split("\n").filter((line) => line !== "").length
  return { home, branches, heavyMiB, files }
}

function gitIn(cwd: string) {
  return (...argv: string[]) => {
    const run = Bun.spawnSync(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" })
    if (run.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${run.stderr.toString()}`)
    return run.stdout.toString()
  }
}

function put(home: string, file: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true })
  fs.writeFileSync(path.join(home, file), text)
}

/** `bytes` of incompressible binary in 4 MiB files (`.bin`), seeded per folder so a rebuild has other bytes. */
function binary(home: string, folder: string, bytes: number, seed: number) {
  const chunk = 4 * 1024 ** 2
  const count = Math.max(1, Math.ceil(bytes / chunk))
  Array.from({ length: count }, (_, index) => {
    const size = Math.min(chunk, bytes - index * chunk)
    const target = path.join(home, folder, `part-${seed}-${index}.bin`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, crypto.randomBytes(Math.max(size, 1)))
  })
}

const TASK_WORDS = ["arena", "boss", "chat", "drops", "event", "forge", "guild", "hud", "iso", "loot", "map", "npc"]

const REGISTRY = (name: string, rows: ReadonlyArray<string>) =>
  [`// Registry: one row per ${name}. Only the integrator edits it (AGENTS.md).`, `export const ${name}s = [`, ...rows.map((row) => `  "${row}",`), "]", ""].join("\n")

const TEXT: Readonly<Record<string, string>> = {
  "README.md": "# rpg-skel\n\nAn isometric action RPG with a MUD client. `npm run build` stamps, generates and builds.\n",
  "AGENTS.md": [
    "# Hand rules",
    "",
    "- Every task works in its own folder: `git worktree add .worktree/<작업> -b codex/<작업>-<YYYYMMDD>`, and a row in",
    "  `WORKTREES.md` (작업 · 폴더 · 브랜치 · 상태). Remove the row when the work is merged.",
    "- DEBUG까지만 — LIVE·push는 별도 승인.",
    "- Registries (`src/game/data/items.ts`, `enemies.ts`, `loot.ts`, `floors.ts`, `src/i18n/ui.en.ts`) and stamped",
    "  files (`src/game/assets/buildId.ts`, `assetStamp.ts`, `public/build.json`, `public/equip-data.json`,",
    "  `public/rift-boss-lab-core.js`, `docs/contracts/skill-animation/*`, `ops/asset-delivery/*`) are changed only by",
    "  the integrating session.",
    "- Seam files `src/game/systems/WorldEvents.ts` and `WorldBossScript.ts`: one task at a time.",
    "- Run `npm run typecheck` and `npm test` before you hand work back.",
    "",
  ].join("\n"),
  "HANDOFF.md": "# Handoff\n\n- 2026-11-10: rift boss A rules drafted; art pending.\n",
  "QUICK_NOTES.md": "# Quick notes\n\n- MUD shop needs sorting.\n",
  "WORKTREES.md": "| 작업 | 폴더 | 브랜치 | 상태 |\n|---|---|---|---|\n",
  "package.json":
    JSON.stringify(
      {
        name: "rpg-skel",
        private: true,
        type: "module",
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
          build: "node scripts/stamp-build.mjs && node scripts/build-links.mjs && tsc --noEmit && vite build",
        },
      },
      null,
      2,
    ) + "\n",
  "package-lock.json": '{ "name": "rpg-skel", "lockfileVersion": 3, "packages": {} }\n',
  "tsconfig.json": '{ "compilerOptions": { "strict": true, "module": "esnext", "target": "es2022" }, "include": ["src"] }\n',
  "vite.config.ts": 'export default { server: { watch: { ignored: ["**/.worktree/**"] } } }\n',
  "vitest.config.ts": 'export default { test: { include: ["src/**/*.test.ts", "server/**/*.test.ts"] } }\n',
  ".gitignore": [".worktree/", ".worktree-dev/", "dist*", ".env*", "server/data/", "node_modules/", ""].join("\n"),
  "src/main.ts": 'import { GameState } from "./game/state/GameState"\n\nexport const start = () => new GameState()\n',
  "src/game/data/items.ts": REGISTRY("item", ["iron-sword", "sand-crown-shard", "rift-key"]),
  "src/game/data/enemies.ts": REGISTRY("enemy", ["slime", "rift-minion"]),
  "src/game/data/loot.ts": REGISTRY("loot", ["slime:iron-sword", "rift-minion:rift-key"]),
  "src/game/data/floors.ts": REGISTRY("floor", ["f1", "f2", "rift-1"]),
  "src/game/data/types.ts": "export interface Boss { id: string; hp: number }\nexport interface Item { id: string }\n",
  "src/game/data/rift/index.ts": "export const rifts = [\"rift-1\"]\n",
  "src/game/data/ascent/index.ts": "export const ascent = []\n",
  "src/game/data/story/index.ts": "export const story = []\n",
  "src/game/data/skillForms/index.ts": "export const skillForms = []\n",
  "src/game/data/__tests__/registry.test.ts": 'import { items } from "../items"\n\ntest("items", () => expect(items.length).toBeGreaterThan(0))\n',
  "src/game/systems/WorldEvents.ts": "// Seam file: every world event registers here.\nexport const worldEvents: string[] = []\n",
  "src/game/systems/WorldBossScript.ts": "// Seam file: boss phases and their cues.\nexport const bossScripts: Record<string, string[]> = {}\n",
  "src/game/systems/__tests__/world.test.ts": 'import { worldEvents } from "../WorldEvents"\n\ntest("events", () => expect(worldEvents).toEqual([]))\n',
  "src/game/entities/IsoActor.ts": "export class IsoActor {}\n",
  "src/game/scenes/DungeonScene.ts": 'import { BaseGameScene } from "./BaseGameScene"\n\nexport class DungeonScene extends BaseGameScene {}\n',
  "src/game/scenes/BaseGameScene.ts": "export class BaseGameScene {}\n",
  "src/game/assets/preload.ts": "export const preload = [] as string[]\n",
  "src/game/assets/Atlas.ts": "export class Atlas {}\n",
  "src/game/assets/buildId.ts": "// stamped by scripts/stamp-build.mjs\nexport const buildId = \"20261110-1\"\n",
  "src/game/assets/assetStamp.ts": "// stamped by scripts/stamp-build.mjs\nexport const assetStamp = \"a1b2c3\"\n",
  "src/game/fx/index.ts": "export const fx = []\n",
  "src/game/render/index.ts": "export const render = () => undefined\n",
  "src/game/iso/index.ts": "export const iso = 1\n",
  "src/game/sim/index.ts": "export const sim = 1\n",
  "src/game/input/index.ts": "export const input = 1\n",
  "src/game/state/GameState.ts": "export class GameState { floor = \"f1\" }\n",
  "src/ui/Hud.ts": 'import { GameState } from "../game/state/GameState"\n\nexport const hud = (state: GameState) => state.floor\n',
  "src/net/client.ts": "export const connect = () => undefined\n",
  "src/chat/mud.ts": "// MUD client\nexport const mud = { shop: [] as string[] }\n",
  "src/shared/ids.ts": "export const id = (text: string) => text.toLowerCase()\n",
  "src/i18n/ui.en.ts": REGISTRY("label", ["shop.title", "boss.rift-a"]),
  "src/admin/index.ts": "export const admin = 1\n",
  "src/lab/index.ts": "export const lab = 1\n",
  "server/room.ts": "export const rooms = new Map<string, string>()\n",
  "server/accounts.ts": "export const accounts = []\n",
  "server/index.ts": 'import { rooms } from "./room"\n\nexport const serve = () => rooms\n',
  "server/protocol.ts": "export type Message = { kind: string }\n",
  "server/worldBossDirector.ts": 'import { bossScripts } from "../src/game/systems/WorldBossScript"\n\nexport const direct = () => bossScripts\n',
  "server/mudScene.ts": "export const mudScene = 1\n",
  "server/__tests__/director.test.ts": 'import { direct } from "../worldBossDirector"\n\ntest("director", () => expect(direct()).toEqual({}))\n',
  "scripts/smoke-boss.mjs": "console.log('smoke')\n",
  "scripts/check-registries.mjs": "console.log('check')\n",
  "scripts/build-links.mjs": "console.log('links')\n",
  "scripts/stamp-build.mjs": "console.log('stamp')\n",
  "scripts/import-studio-dungeon-lab.mjs": "// imports studio/dungeon-lab from its branch\nconsole.log('import')\n",
  "scripts/lib/fs.mjs": "export const read = () => ''\n",
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`studio/notes-${index}.md`, `# studio note ${index}\n`])),
  ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`studio/cosmetics/set-${index}.json`, `{ "set": ${index} }\n`])),
  "studio/cosmetics/review/README.md": "# review\n",
  "assets-src/manifest.json": '{ "families": ["rift-boss-a", "skill-icons", "concepts"] }\n',
  "assets-src/rift-boss-a/king/README.md": "# king\n",
  "assets-src/rift-boss-a/enrage/README.md": "# enrage\n",
  "assets-src/procedural/noise.json": '{ "seed": 7 }\n',
  ...Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`public/page-${index}.txt`, `page ${index}\n`])),
  "public/rift-boss-lab-core.js": "// generated\nexport const lab = 1\n",
  "public/equip-data.json": '{ "generated": true }\n',
  "public/build.json": '{ "build": "20261110-1" }\n',
  "public/assets/iso/LICENSE-tiles.txt": "CC-BY tiles\n",
  "public/assets/iso/LICENSE-enemies.txt": "CC-BY enemies\n",
  "public/assets/fonts-text/README.md": "# fonts\n",
  "public/assets/data-text/README.md": "# data\n",
  "public/world-event-fx/sand.json": '{ "fx": "sand" }\n',
  "public/fonts/subset-charset.json": '{ "chars": "가나다" }\n',
  "docs/handoffs/2026-11-01.md": "# handoff 1\n",
  "docs/handoffs/2026-11-05.md": "# handoff 2\n",
  "docs/handoffs/2026-11-09.md": "# handoff 3\n",
  ...Object.fromEntries(
    ["boss", "items", "mud", "map", "audio", "npc", "fx"].map((topic) => [`docs/handoffs/${topic}/README.md`, `# ${topic}\n`]),
  ),
  "docs/design/rift.md": "# rift design\n",
  "docs/deployments/2026-11-02.md": "# deploy\n",
  "docs/contracts/skill-animation/catalog.json": '{ "generated": true }\n',
  "docs/contracts/skill-animation/INDEX.md": "# generated index\n",
  "ops/asset-delivery/debug.json": '{ "target": "debug" }\n',
  "ops/asset-delivery/live.json": '{ "target": "live" }\n',
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string) => {
    const at = args.indexOf(`--${name}`)
    return at >= 0 ? args[at + 1] : undefined
  }
  const out = option("out")
  if (out === undefined) {
    console.log("usage: bun script/live/fixtures/rpg-skeleton.ts --out <dir> [--heavy-mib <n>]")
    process.exit(1)
  }
  const begun = Date.now()
  const built = rpgSkeleton(path.resolve(out), { heavyMiB: Number(option("heavy-mib") ?? "50") })
  console.log(JSON.stringify({ ...built, seconds: Math.round((Date.now() - begun) / 1000) }))
}
