// How the vendored oh-my-opencode sources resolve when they are bundled (script/bundle.ts) or when the vendor script
// computes the files the runtime entry needs (own/scripts/omo-vendor.ts). Both use this one resolver, so the vendored
// closure is exactly what the bundle reads.
//
// - `@omo/<path>` is `<root>/packages/omo-opencode/src/<path>` and `@omo-root/<path>` is `<root>/<path>` (the runtime
//   entry's own aliases).
// - `@oh-my-opencode/<pkg>[/<sub>]` follows that package's `exports`, `#<name>` the importing package's `imports`.
// - `@opencode-ai/plugin` (and `/tool`) is own's shim: v1's `tool()` returns its definition, `tool.schema` is zod.
// - `@opencode-ai/sdk[/…]`, `posthog-node` and `sharp` are a stub that throws when used: own-omo hands omo its own client
//   (src/host/client.ts), omo's telemetry is off and its image tools are not registered.
// - `signal-exit` (proper-lockfile's) is a no-op: it would listen to every signal of the host process when it loads.
// - omo's `shared/posthog.ts` (not vendored) is own's no-op telemetry module, so no PostHog client or host is in the bundle.
// - Any other bare import is an npm package: `external` leaves it out (closure mode), else Bun resolves it from this
//   package's node_modules.
import fs from "node:fs"
import path from "node:path"
import type { BunPlugin } from "bun"

const SHIM = path.join(import.meta.dir, "..", "src", "shim")

export const SHIMS = {
  plugin: path.join(SHIM, "opencode-ai-plugin.ts"),
  stub: path.join(SHIM, "stub.ts"),
  posthog: path.join(SHIM, "posthog.ts"),
  signalExit: path.join(SHIM, "signal-exit.cjs"),
}

/** Modules the bundle replaces with own's shims (see the header). */
export const ALIASES: Readonly<Record<string, string>> = {
  "@opencode-ai/plugin": SHIMS.plugin,
  "@opencode-ai/plugin/tool": SHIMS.plugin,
  "@opencode-ai/sdk": SHIMS.stub,
  "@opencode-ai/sdk/v2": SHIMS.stub,
  "@opencode-ai/sdk/v2/client": SHIMS.stub,
  "posthog-node": SHIMS.stub,
  sharp: SHIMS.stub,
  "signal-exit": SHIMS.signalExit,
}

/** omo's telemetry module, which own replaces with a no-op. */
export const POSTHOG_MODULE = "packages/omo-opencode/src/shared/posthog"

export function plugin(
  root: string,
  options: { readonly external: boolean; readonly seen?: Set<string>; readonly loaded?: Set<string> },
): BunPlugin {
  const packages = new Map(
    fs
      .readdirSync(path.join(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, "packages", entry.name, "package.json")))
      .map((entry) => {
        const dir = path.join(root, "packages", entry.name)
        const json = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson
        return [json.name, { dir, json }] as const
      }),
  )
  // Compared without the extension: the module is not vendored, since the bundle never reads it.
  const posthog = path.resolve(root, POSTHOG_MODULE).toLowerCase()
  return {
    name: "own-omo-resolve",
    setup(build) {
      // Every module the build reads (Bun's metafile leaves out modules that only re-export): the vendored closure.
      if (options.loaded !== undefined) {
        const loaded = options.loaded
        build.onLoad({ filter: /.*/ }, (args) => {
          loaded.add(args.path)
          return undefined
        })
      }
      build.onResolve({ filter: /^@omo\// }, (args) => ({
        path: required(path.join(root, "packages/omo-opencode/src", args.path.slice("@omo/".length)), args.path),
      }))
      build.onResolve({ filter: /^@omo-root\// }, (args) => ({
        path: required(path.join(root, args.path.slice("@omo-root/".length)), args.path),
      }))
      build.onResolve({ filter: /^@oh-my-opencode\// }, (args) => {
        const [scope, name, ...rest] = args.path.split("/")
        const pkg = packages.get(`${scope}/${name}`)
        if (pkg === undefined) throw new Error(`omo package not vendored: ${args.path} (from ${args.importer})`)
        const target = exported(pkg.json.exports, rest.length === 0 ? "." : `./${rest.join("/")}`)
        if (target === undefined) throw new Error(`omo export not found: ${args.path} (from ${args.importer})`)
        return { path: required(path.join(pkg.dir, target), args.path) }
      })
      build.onResolve({ filter: /^#/ }, (args) => {
        const owner = owningPackage(args.importer)
        const target = owner === undefined ? undefined : exported(owner.json.imports, args.path)
        if (owner === undefined || target === undefined)
          throw new Error(`omo import not found: ${args.path} (from ${args.importer})`)
        return { path: required(path.join(owner.dir, target), args.path) }
      })
      build.onResolve({ filter: /(^|\/)posthog$/ }, (args) => {
        if (!args.path.startsWith(".")) return undefined
        const target = path.resolve(path.dirname(args.importer), args.path).toLowerCase()
        return target === posthog ? { path: SHIMS.posthog } : undefined
      })
      build.onResolve({ filter: /^[^./#]/ }, (args) => {
        // Windows absolute paths and `node:`/`bun:` built-ins are Bun's.
        if (/^[A-Za-z]:[\\/]/.test(args.path) || /^(node|bun):/.test(args.path)) return undefined
        const alias = ALIASES[args.path]
        if (alias !== undefined) return { path: alias }
        if (!options.external) return undefined
        options.seen?.add(packageName(args.path))
        return { path: args.path, external: true }
      })
    },
  }

  function owningPackage(importer: string) {
    for (let dir = path.dirname(importer); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const json = path.join(dir, "package.json")
      if (fs.existsSync(json)) return { dir, json: JSON.parse(fs.readFileSync(json, "utf8")) as PackageJson }
    }
    return undefined
  }
}

type Target = string | { readonly import?: string; readonly default?: string; readonly types?: string } | undefined

interface PackageJson {
  readonly name: string
  readonly exports?: Readonly<Record<string, Target>>
  readonly imports?: Readonly<Record<string, Target>>
}

/** A subpath of an `exports` or `imports` map, with `*` patterns. */
function exported(map: Readonly<Record<string, Target>> | undefined, key: string) {
  if (map === undefined) return undefined
  const pick = (target: Target) => (typeof target === "string" ? target : (target?.import ?? target?.default))
  if (key in map) return pick(map[key])
  for (const [pattern, target] of Object.entries(map)) {
    const star = pattern.indexOf("*")
    if (star < 0) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (!key.startsWith(prefix) || !key.endsWith(suffix) || key.length < prefix.length + suffix.length) continue
    return pick(target)?.replace("*", key.slice(prefix.length, key.length - suffix.length))
  }
  return undefined
}

/** The file a TypeScript import names: as written, with an extension, or a directory's index. */
export function file(candidate: string) {
  return [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.js`,
    `${candidate}.mjs`,
    path.join(candidate, "index.ts"),
    path.join(candidate, "index.js"),
  ].find((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile())
}

function required(candidate: string, specifier: string) {
  const found = file(candidate)
  if (found === undefined) throw new Error(`omo module not found: ${specifier} (${candidate})`)
  return found
}

function packageName(specifier: string) {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}
