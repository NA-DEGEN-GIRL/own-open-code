// Real git for the GitHub connection's tests (16, GH): a scrubbed environment (a scratch HOME and global config, no
// system config, only git's own folders and System32 on PATH, no prompts) and a recorder of ssh starts.
import fs from "node:fs/promises"
import path from "node:path"

export function sshRecorder(marker: string) {
  return {
    env: { GIT_SSH_COMMAND: `echo started >> '${marker.replaceAll("\\", "/")}'; exit 255; :` },
    started: () => Bun.file(marker).exists(),
  }
}

export async function scrubbedGit(home: string) {
  await fs.mkdir(home, { recursive: true })
  await Bun.write(path.join(home, ".gitconfig"), "")
  const found = Bun.which("git")
  if (!found) throw new Error("git is not installed")
  // Git for Windows' folder: the one holding `mingw64`, or `ucrt64` from 2.56 (git may be found in `cmd`, `bin` or
  // `<that folder>\bin`).
  const prefixes = ["mingw64", "ucrt64"]
  const parts = path.resolve(found).split(path.sep)
  const at = parts.findLastIndex((part) => prefixes.includes(part.toLowerCase()))
  const install = at > 0 ? parts.slice(0, at).join(path.sep) : path.resolve(path.dirname(found), "..")
  const windows = process.platform === "win32"
  const system = windows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin"
  // `mingw64\bin` (`ucrt64\bin`) before `cmd`: `cmd` holds launchers (`git.exe`, `git-lfs.exe`) that start the real
  // program as one more process, and git starts git-lfs by PATH (LFS-T, below).
  const pathList = windows
    ? [
        ...prefixes.map((prefix) => path.join(install, prefix, "bin")),
        path.join(install, "cmd"),
        path.join(install, "usr", "bin"),
        system,
      ]
    : [path.dirname(found), system]
  const tmp = path.join(home, "tmp")
  await fs.mkdir(tmp, { recursive: true })
  const base: Record<string, string> = {
    PATH: pathList.join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    TEMP: tmp,
    TMP: tmp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    ...(windows ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
  }
  /** Runs `argv` (a program found on the scrubbed PATH) with the scrubbed environment and `extra`, `input` on stdin. */
  const exec = async (
    argv: string[],
    cwd: string,
    extra: Readonly<Record<string, string | undefined>>,
    input?: string,
  ) => {
    const env = Object.fromEntries(
      Object.entries({ ...base, ...extra }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    const program = Bun.which(argv[0]!, { PATH: base.PATH }) ?? argv[0]!
    const proc = Bun.spawn([program, ...argv.slice(1)], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: input === undefined ? "ignore" : new Blob([input]),
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  }
  return {
    home,
    exec,
    run: (args: string[], cwd: string, extra: Readonly<Record<string, string | undefined>>, input?: string) =>
      exec([found, ...args], cwd, extra, input),
    /**
     * A program as this git finds it on the scrubbed PATH. Ask it, not the test's own PATH: PortableGit 2.56 has no
     * `cmd\git-lfs.exe` launcher, so with only `cmd` on PATH `Bun.which("git-lfs")` finds nothing while git still
     * starts `ucrt64\bin\git-lfs.exe` (GU-12).
     */
    which: (name: string) => Bun.which(name, { PATH: base.PATH }),
  }
}

/**
 * A repository at `repo` with one LFS file committed (`data.bin`) and `origin` at `remote`, made with one git-lfs run
 * (the clean filter of `git add`) instead of four. `git lfs install --local` and `git lfs track` only write the
 * repository's config and `.gitattributes`, and the post-commit hook they install starts git-lfs once more; the tests
 * push with `git lfs push`, which needs no hook. Every git-lfs run starts a dozen git processes, and on this PC under
 * the user's apps' load a process start took from 50 ms to 9 s: the four runs alone used up most of a test's 60 s, the
 * test timed out in its first push, and its teardown then answered git-lfs's login with a 404 (`could not read
 * Username`) (LFS-T, decisions MR16).
 */
export async function lfsRepo(git: Awaited<ReturnType<typeof scrubbedGit>>, repo: string, remote: string) {
  await fs.mkdir(repo, { recursive: true })
  const run = async (args: string[]) => {
    const done = await git.run(args, repo, {})
    if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed (${done.code}): ${done.stderr}`)
  }
  await run(["init", "-q", "-b", "main"])
  // What `git lfs install --local` writes to the repository's config, without the hooks.
  await fs.appendFile(
    path.join(repo, ".git", "config"),
    '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n',
  )
  // What `git lfs track "*.bin"` writes.
  await Bun.write(path.join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n")
  await Bun.write(path.join(repo, "data.bin"), "large file\n")
  await run(["add", ".gitattributes", "data.bin"])
  await run(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "first"])
  await run(["remote", "add", "origin", remote])
}
