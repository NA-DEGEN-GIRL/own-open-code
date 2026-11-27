// Runs a command with a ripgrep on PATH, so core's tests that search (P-031's verify among them) find `rg` through
// `which` instead of downloading ripgrep 15.1.0 (core src/ripgrep/binary.ts). Usage, from a package directory:
//
//   bun ../../own/scripts/test/with-rg.ts bun test test/tool-search.test.ts -t "leaves out lines"
//
// The rg is OWN_RG_DIR (a folder holding rg/rg.exe), else one already on PATH, else the copy VS Code bundles
// (`resources/app/node_modules.asar.unpacked/@vscode/ripgrep*/bin/<platform>/` under a system or user install). With
// none it stops and says so: nothing is downloaded. A leading `bun` runs as this process's own bun, as heavy.ts does.
import fs from "node:fs"
import path from "node:path"

const EXE = process.platform === "win32" ? "rg.exe" : "rg"

/** The folder of a ripgrep this PC already has, or undefined. */
export function rgDir(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (env.OWN_RG_DIR && fs.existsSync(path.join(env.OWN_RG_DIR, EXE))) return env.OWN_RG_DIR
  const found = Bun.which("rg", { PATH: env.PATH ?? "" })
  if (found) return path.dirname(found)
  const installs = [
    env.ProgramFiles && path.join(env.ProgramFiles, "Microsoft VS Code"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Microsoft VS Code"),
  ].filter((dir): dir is string => dir !== undefined && fs.existsSync(dir))
  // A system install keeps `resources` under a version folder (`<install>/<hash>/resources`), a user install directly.
  const roots = installs.flatMap((install) => [
    install,
    ...fs
      .readdirSync(install, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(install, entry.name)),
  ])
  return roots
    .map((root) => path.join(root, "resources", "app", "node_modules.asar.unpacked", "@vscode"))
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) =>
      fs
        .readdirSync(dir)
        .filter((name) => name.startsWith("ripgrep"))
        .flatMap((name) => {
          const bin = path.join(dir, name, "bin")
          if (!fs.existsSync(bin)) return []
          return [bin, ...fs.readdirSync(bin).map((platform) => path.join(bin, platform))]
        }),
    )
    .find((candidate) => fs.existsSync(path.join(candidate, EXE)))
}

if (import.meta.main) {
  const command = process.argv.slice(2)
  if (command.length === 0) {
    console.error("usage: bun own/scripts/test/with-rg.ts <command> [args...]")
    process.exit(2)
  }
  const dir = rgDir()
  if (dir === undefined) {
    console.error("with-rg: no ripgrep on this PC (OWN_RG_DIR, PATH or VS Code's); core would download 15.1.0")
    process.exit(3)
  }
  const child = Bun.spawn({
    cmd: command[0] === "bun" ? [process.execPath, ...command.slice(1)] : command,
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exit(await child.exited)
}
