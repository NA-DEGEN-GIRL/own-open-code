/**
 * The team phase's fixtures and clients (06 §11.2 실제 호스트, §11.3 TG17): one temp root
 * `/tmp/own-<uid>-team-<rand>` on the approved host holding everything the phase makes there, and typed callers of the
 * remote service's own.team (through own-remote's tunnel) and of this PC's own.remote and own.accounts.
 *
 * The repositories are made on the host with plain git, because the host has no git-lfs until own uploads it (06 §4.13):
 *
 *   code   F1-like: `src/`, `docs/`, `-dash/`, root files, a bare `file://` origin, and a Makefile whose `typecheck`
 *          target (the team's code check, `make typecheck`, V10) sleeps for the seconds written in `<root>/slow`, so an
 *          integration can be kept running on the host.
 *   lfs    F2-like: `*.png`, `*.wav`, `*.bin` are LFS files, heavy folders `Assets/Textures`, `Assets/Audio`,
 *          `Content`. Without a filter on the host `git add` commits the pointer files as they are, and the objects go
 *          straight into the bare origin's `lfs/objects` (the store git-lfs's standalone transfer reads for a `file://`
 *          remote). The home is a clone, so its working files are pointers and its shared store starts empty.
 *
 * Fixture git runs with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` and local settings only; nothing
 * outside the temp root is written. `~/.gitconfig` is only hashed (TG17: unchanged).
 */
import { Option, Schema } from "effect"
import { OwnAccounts, OwnTeam } from "@own/protocol"
import { OwnRemote } from "../../src/protocol/rpc-remote.js"
import { GITCONFIG_SCRIPT, hostSh, kv, section } from "./env.js"
import type { Stack } from "./stack.js"

/** The heavy folders of the `lfs` repository (06 §3.4 `heavy`). */
export const HEAVY = ["Assets/Textures", "Assets/Audio", "Content"] as const

/** LFS files of the `lfs` repository and their sizes. In the code-only cone: the first two and the forced banner. */
export const LFS_FILES = {
  "src/icons/logo.png": 3_000,
  "-dash/icon.png": 1_500,
  "Assets/banner.png": 2_000,
  "Assets/Textures/rock.png": 50_000,
  "Assets/Textures/tree.png": 60_000,
  "Assets/Audio/music.wav": 40_000,
  "Content/map.bin": 30_000,
} as const

export const IN_CONE = ["src/icons/logo.png", "-dash/icon.png", "Assets/banner.png"] as const

/** How the pointer of an LFS file starts (git-lfs spec v1). */
export const POINTER = "version https://git-lfs.github.com/spec/v1"

export interface Repo {
  /** The main folder (a clone of `origin`). */
  readonly home: string
  /** The bare origin. */
  readonly origin: string
  readonly url: string
  readonly head: string
}

export interface Fixtures {
  readonly root: string
  readonly uid: string
  readonly code: Repo
  readonly lfs: Repo & { readonly objects: Readonly<Record<keyof typeof LFS_FILES, string>> }
  /** The file the code check's sleep reads (seconds). */
  readonly slow: string
}

/** `umask 077; mktemp -d /tmp/own-<uid>-team-XXXXXXXX` on the host, checked against that shape. */
export async function makeRoot() {
  const made = await hostSh(`umask 077 && mktemp -d "/tmp/own-$(id -u)-team-XXXXXXXX"`)
  const root = made.stdout.trim()
  if (made.code !== 0 || !/^\/tmp\/own-\d+-team-[A-Za-z0-9]{8}$/.test(root))
    throw new Error(`unexpected team root '${root}': ${made.stderr}`)
  return root
}

/** Both repositories under `root` (see the file header). */
export async function makeFixtures(root: string): Promise<Fixtures> {
  const made = await hostSh(fixtureScript(root), 300_000)
  const facts = kv(made.stdout)
  if (made.code !== 0 || facts.get("FIXTURES") !== "1")
    throw new Error(`fixture setup failed: ${made.stdout}\n${made.stderr}`)
  const objects = Object.fromEntries(
    made.stdout.split("\n").flatMap((line) => {
      const match = /^OBJ (\S+) ([0-9a-f]{64})$/.exec(line.trim())
      return match ? [[match[1]!, match[2]!] as const] : []
    }),
  ) as Record<keyof typeof LFS_FILES, string>
  const repo = (name: string, head: string): Repo => ({
    home: `${root}/${name}`,
    origin: `${root}/${name}-origin.git`,
    url: `file://${root}/${name}-origin.git`,
    head,
  })
  return {
    root,
    uid: facts.get("UID")!,
    code: repo("code", facts.get("CODE_HEAD")!),
    lfs: { ...repo("lfs", facts.get("LFS_HEAD")!), objects },
    slow: `${root}/slow`,
  }
}

/** Removes the team root: owner write back first (a protected shared folder, 06 §4.11), then `rm -rf`. */
export async function removeRoot(root: string) {
  if (!/^\/tmp\/own-\d+-team-[A-Za-z0-9]{8}$/.test(root)) throw new Error(`not a team root: ${root}`)
  const removed = await hostSh(
    `chmod -R u+w -- '${root}' 2>/dev/null; rm -rf -- '${root}'; [ -e '${root}' ] && echo LEFT=1 || echo LEFT=0`,
  )
  return kv(removed.stdout).get("LEFT") === "0"
}

/** sha256 of `~/.gitconfig` on the host (`ABSENT` without one). */
export async function gitconfig() {
  return (await hostSh(GITCONFIG_SCRIPT)).stdout.trim()
}

/** A POSIX script run on the host; `git` there never reads or writes the user's global or system config. */
export function hostGit(script: string) {
  return hostSh(
    `set -u\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0\n${script}`,
    180_000,
  )
}

function fixtureScript(root: string) {
  const sizes = Object.entries(LFS_FILES)
    .map(([file, bytes]) => `obj '${file}' ${bytes}`)
    .join("\n")
  return String.raw`set -eu
umask 077
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
root='${root}'
cd "$root"
mkdir -p .no-hooks
cfg() {
  git -C "$1" config user.name 'own-team real-host'
  git -C "$1" config user.email 'own-team@example.invalid'
  git -C "$1" config core.autocrlf false
  git -C "$1" config commit.gpgsign false
  git -C "$1" config tag.gpgsign false
  git -C "$1" config core.hooksPath "$root/.no-hooks"
  git -C "$1" config gc.auto 0
}
put() { mkdir -p "$(dirname -- "$1")"; printf '%s\n' "$2" > "$1"; }

# code: F1-like, the Makefile check sleeps for the seconds in $root/slow.
git init -q -b main code-seed && cfg code-seed
put code-seed/README.md '# code'
put code-seed/src/app/main.ts 'export const main = 1'
put code-seed/src/lib/util.ts 'export const util = 2'
put code-seed/docs/guide.md 'guide'
put code-seed/-dash/x.ts 'export {}'
printf 'typecheck:\n\t@sleep "$$(cat %s 2>/dev/null || echo 0)"\n\t@echo e2e check passed\n' "$root/slow" > code-seed/Makefile
echo 0 > "$root/slow"
git -C code-seed add -A && git -C code-seed commit -q -m code
git init -q --bare -b main code-origin.git
git -C code-seed push -q "file://$root/code-origin.git" main
git clone -q "file://$root/code-origin.git" code && cfg code
rm -rf code-seed

# lfs: F2-like, pointers committed as they are, objects in the origin's store.
git init -q -b main lfs-seed && cfg lfs-seed
printf '*.png filter=lfs diff=lfs merge=lfs -text\n*.wav filter=lfs diff=lfs merge=lfs -text\n*.bin filter=lfs diff=lfs merge=lfs -text\n' > lfs-seed/.gitattributes
put lfs-seed/README.md '# lfs'
put lfs-seed/src/app/main.ts 'export const main = 1'
put lfs-seed/docs/guide.md 'guide'
put lfs-seed/Assets/Scripts/player.cs 'class Player {}'
put lfs-seed/Assets/Textures.meta 'meta'
git init -q --bare -b main lfs-origin.git
obj() {
  head -c "$2" /dev/urandom > "$root/.blob"
  oid=$(sha256sum < "$root/.blob" | cut -d ' ' -f 1)
  dir="lfs-origin.git/lfs/objects/$(printf %s "$oid" | cut -c1-2)/$(printf %s "$oid" | cut -c3-4)"
  mkdir -p "$dir" && mv "$root/.blob" "$dir/$oid"
  mkdir -p "lfs-seed/$(dirname -- "$1")"
  printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %s\n' "$oid" "$2" > "lfs-seed/$1"
  echo "OBJ $1 $oid"
}
${sizes}
git -C lfs-seed add -A && git -C lfs-seed commit -q -m lfs
git -C lfs-seed push -q "file://$root/lfs-origin.git" main
git clone -q "file://$root/lfs-origin.git" lfs && cfg lfs
rm -rf lfs-seed

echo "UID=$(id -u)"
echo "CODE_HEAD=$(git -C code rev-parse HEAD)"
echo "LFS_HEAD=$(git -C lfs rev-parse HEAD)"
echo FIXTURES=1
`
}

/**
 * Git facts of the repository at `home` and of `areas` (read on the host with plain git): the local filter, the
 * worktrees and locks, the objects of the shared LFS store, and per area its status, cone, heavy folders on disk,
 * the sizes of the LFS files there and how many of them are still pointers.
 */
export async function lfsFacts(home: string, areas: ReadonlyArray<{ readonly directory: string }>) {
  const files = Object.keys(LFS_FILES)
  const script = [
    `home='${home}'`,
    `echo "FILTER=$(git -C "$home" config --local --get filter.lfs.process)"`,
    `echo "SMUDGE=$(git -C "$home" config --local --get filter.lfs.smudge)"`,
    `echo "REQUIRED=$(git -C "$home" config --local --get filter.lfs.required)"`,
    `echo "WORKTREES=$(git -C "$home" worktree list --porcelain | grep -c '^worktree ')"`,
    `echo "LOCKED=$(git -C "$home" worktree list --porcelain | grep -c '^locked')"`,
    `store="$(git -C "$home" rev-parse --path-format=absolute --git-common-dir)/lfs/objects"`,
    `echo "== objects"; [ -d "$store" ] && find "$store" -type f -printf '%f\\n'`,
    ...areas.flatMap((area, index) => [
      `dir='${area.directory}'`,
      `echo "== area ${index} status"; git -C "$dir" status --porcelain --untracked-files=all`,
      `echo "== area ${index} cone"; git -C "$dir" sparse-checkout list 2>/dev/null`,
      `echo "== area ${index} heavy"; for h in ${HEAVY.map((dir) => `'${dir}'`).join(" ")}; do [ -e "$dir/$h" ] && echo "$h"; done; true`,
      `echo "== area ${index} sizes"; for f in ${files.map((file) => `'${file}'`).join(" ")}; do [ -f "$dir/$f" ] && echo "$(stat -c %s "$dir/$f") $f"; done; true`,
      `echo "== area ${index} pointers"; for f in ${files.map((file) => `'${file}'`).join(" ")}; do [ -f "$dir/$f" ] && head -c 40 "$dir/$f" | grep -q '^version https://git-lfs' && echo "$f"; done; true`,
      `echo "== area ${index} end"`,
    ]),
  ].join("\n")
  const result = await hostGit(script)
  const facts = kv(result.stdout)
  return {
    filter: facts.get("FILTER") ?? "",
    smudge: facts.get("SMUDGE") ?? "",
    required: facts.get("REQUIRED") ?? "",
    worktrees: Number(facts.get("WORKTREES")),
    locked: Number(facts.get("LOCKED")),
    objects: section(result.stdout, "== objects"),
    areas: areas.map((area, index) => {
      const sizes = Object.fromEntries(
        section(result.stdout, `== area ${index} sizes`).map((line) => {
          const space = line.indexOf(" ")
          return [line.slice(space + 1), Number(line.slice(0, space))] as const
        }),
      )
      return {
        directory: area.directory,
        status: section(result.stdout, `== area ${index} status`).join("\n"),
        cone: section(result.stdout, `== area ${index} cone`),
        heavy: section(result.stdout, `== area ${index} heavy`),
        sizes,
        pointers: section(result.stdout, `== area ${index} pointers`).length,
      }
    }),
  }
}

/**
 * The LFS objects the tree of `ref` in `home` names (its pointer blobs) that the bare `origin`'s store lacks: what a push
 * without `git lfs push` would leave behind for every other clone (06 §4.13).
 */
export async function originMissing(home: string, origin: string, ref: string) {
  const checked =
    await hostGit(`cd '${home}' && git ls-tree -r '${ref}' | awk '{print $3}' | while read -r blob; do git cat-file -p "$blob" 2>/dev/null | sed -n 's/^oid sha256://p'; done | sort -u | while read -r oid; do
  f='${origin}/lfs/objects/'$(printf %s "$oid" | cut -c1-2)/$(printf %s "$oid" | cut -c3-4)/$oid
  [ -f "$f" ] || echo "MISSING $oid"
done; echo CHECKED=1`)
  if (!checked.stdout.includes("CHECKED=1")) throw new Error(`origin check failed: ${checked.stderr}`)
  return checked.stdout
    .split("\n")
    .flatMap((line) => (line.startsWith("MISSING ") ? [line.slice("MISSING ".length).trim()] : []))
}

// ---------------------------------------------------------------------------------------------------------------
// Callers

type TeamMethods = OwnTeam.Definition["methods"]
export type TeamInput<M extends OwnTeam.MethodName> = NonNullable<
  TeamMethods[M]["input"]["~standard"]["types"]
>["input"]
export type TeamOutput<M extends OwnTeam.MethodName> = NonNullable<
  TeamMethods[M]["output"]["~standard"]["types"]
>["output"]
type RemoteMethods = OwnRemote.Definition["methods"]
export type RemoteInput<M extends OwnRemote.MethodName> = NonNullable<
  RemoteMethods[M]["input"]["~standard"]["types"]
>["input"]
export type RemoteOutput<M extends OwnRemote.MethodName> = NonNullable<
  RemoteMethods[M]["output"]["~standard"]["types"]
>["output"]

/** The remote service through own-remote's tunnel (`resolve`): its URL, a short token and its control folder. */
export interface Endpoint {
  readonly url: string
  readonly token: string
  readonly controlDir: string
}

/** An HTTP answer: the status and the parsed JSON body (`undefined` when empty or not JSON). */
export interface Answer {
  readonly status: number
  readonly body: unknown
}

/** A declared RPC error's fields (`type`, `message`, `data`), when the body is one. */
export function errorOf(answer: Answer) {
  return Option.getOrUndefined(decodeError(answer.body))
}

const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    message: Schema.optional(Schema.String),
    data: Schema.optional(Schema.Unknown),
  }),
)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeOutput = Schema.decodeUnknownOption(Schema.Struct({ output: Schema.Unknown }))

/** How long a remote request may take by default: Bun's own idle limit, now as a whole-request deadline. */
export const REQUEST_MS = 300_000

/**
 * One request to the remote service: Basic auth with the tunnel token; RPC routes get the Location query.
 *
 * `timeoutMs` is the whole request's deadline. Bun's fetch also has a hidden 5-minute idle timer that fails a request
 * whose socket stays silent (`TimeoutError: The operation timed out.`, no stack): a held answer such as
 * `/api/experimental/session/<id>/wait` sends nothing until the session is idle, so a turn longer than 5 minutes
 * failed there with no hint of the request (RH-2). The timer is off here; the deadline is explicit, and a failure names
 * the request and how long it ran.
 */
export async function remoteFetch(
  endpoint: Endpoint,
  method: string,
  route: string,
  options: {
    readonly body?: unknown
    readonly directory?: string
    readonly base?: string
    readonly timeoutMs?: number
  } = {},
): Promise<Answer> {
  const url = new URL(route, options.base ?? endpoint.url)
  if (route.startsWith("/api/rpc/") && options.directory) url.searchParams.set("location[directory]", options.directory)
  const timeoutMs = options.timeoutMs ?? REQUEST_MS
  const started = Date.now()
  const failed = (error: unknown): never => {
    const seconds = Math.round((Date.now() - started) / 1000)
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw new Error(`${method} ${route}: ${reason} after ${seconds}s (deadline ${timeoutMs / 1000}s)`, {
      cause: error,
    })
  }
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${btoa(`opencode:${endpoint.token}`)}`,
      ...(options.directory ? { "x-opencode-directory": encodeURIComponent(options.directory) } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(timeoutMs),
    timeout: false,
  }).catch(failed)
  const text = await response.text().catch(failed)
  return { status: response.status, body: Option.getOrUndefined(decodeJson(text)) }
}

/** own.team of the remote service at its control folder (06 §2.7: every method goes there). */
export function remoteTeam(endpoint: () => Endpoint) {
  const raw = (method: OwnTeam.MethodName, input: unknown) =>
    remoteFetch(endpoint(), "POST", `/api/rpc/${OwnTeam.ID}/${method}`, {
      body: { input },
      directory: endpoint().controlDir,
    })
  const call = async <M extends OwnTeam.MethodName>(method: M, input: TeamInput<M>): Promise<TeamOutput<M>> => {
    const answer = await raw(method, input)
    const output = Option.getOrUndefined(decodeOutput(answer.body))?.output
    if (answer.status !== 200)
      throw new Error(`remote own.team ${method}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`)
    const checked = await OwnTeam.Definition.methods[method].output["~standard"].validate(output)
    if (checked.issues)
      throw new Error(`remote own.team ${method}: the output does not decode: ${JSON.stringify(checked.issues)}`)
    return checked.value
  }
  /** The op once its auto steps ended (`done`, `failed`, `cancelled`; with `waiting` also `waiting`). */
  const opEnd = async (opID: string, options: { readonly timeoutMs?: number; readonly waiting?: boolean } = {}) => {
    const ended = new Set<string>(["done", "failed", "cancelled", ...(options.waiting ? ["waiting"] : [])])
    const last: { op?: OwnTeam.Op } = {}
    const deadline = Date.now() + (options.timeoutMs ?? 240_000)
    for (;;) {
      const op = (await call("op.get", { opID: OwnTeam.OpID.make(opID) })).op
      last.op = op
      if (ended.has(op.state)) return op
      if (Date.now() > deadline) throw new Error(`op ${opID} did not end: ${op.state}; steps: ${steps(op)}`)
      await Bun.sleep(500)
    }
  }
  return { raw, call, opEnd }
}

/** `id:state (note)` of every step, for failure messages and evidence. */
export function steps(op: OwnTeam.Op) {
  return op.steps.map((step) => `${step.id}:${step.kind}:${step.state}${step.note ? ` (${step.note})` : ""}`).join(", ")
}

/** This PC's own.remote, decoded with its schema. */
export async function local<M extends OwnRemote.MethodName>(
  stack: Stack,
  method: M,
  input: RemoteInput<M>,
): Promise<RemoteOutput<M>> {
  const answer = await stack.localRaw(OwnRemote.ID, method, input)
  if (answer.status !== 200)
    throw new Error(`own.remote ${method}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`)
  const checked = await OwnRemote.Definition.methods[method].output["~standard"].validate(answer.body.output)
  if (checked.issues)
    throw new Error(`own.remote ${method}: the output does not decode: ${JSON.stringify(checked.issues)}`)
  return checked.value
}

type AccountsMethods = OwnAccounts.Definition["methods"]
export type AccountsOutput<M extends OwnAccounts.MethodName> = NonNullable<
  AccountsMethods[M]["output"]["~standard"]["types"]
>["output"]

/** An own.accounts method of the remote service (control folder). */
export function remoteAccounts(endpoint: Endpoint, method: OwnAccounts.MethodName, input: unknown) {
  return remoteFetch(endpoint, "POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
    body: { input },
    directory: endpoint.controlDir,
  })
}

/** The output of a 200 answer of own.accounts `method` (this PC's or the remote's), decoded with its schema. */
export async function accountsOutput<M extends OwnAccounts.MethodName>(
  method: M,
  answer: Answer,
): Promise<AccountsOutput<M>> {
  if (answer.status !== 200)
    throw new Error(`own.accounts ${method}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`)
  const output = Option.getOrUndefined(decodeOutput(answer.body))?.output
  const checked = await OwnAccounts.Definition.methods[method].output["~standard"].validate(output)
  if (checked.issues)
    throw new Error(`own.accounts ${method}: the output does not decode: ${JSON.stringify(checked.issues)}`)
  return checked.value
}

/** A session of the remote service in `directory` on `model` (`POST /api/session`, no prompt). */
export async function remoteSession(
  endpoint: Endpoint,
  input: {
    readonly directory: string
    readonly model: { readonly providerID: string; readonly id: string }
    readonly title: string
  },
) {
  const created = await remoteFetch(endpoint, "POST", "/api/session", {
    body: { title: input.title, model: input.model, location: { directory: input.directory } },
    directory: input.directory,
  })
  if (created.status !== 200) throw new Error(`session: HTTP ${created.status} ${JSON.stringify(created.body)}`)
  return Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))(created.body).data.id
}

// ---------------------------------------------------------------------------------------------------------------
// Gateway (05 §13, 08 §3.5): an app device paired through the JSON flow on the loopback listener

export interface Device {
  readonly deviceId: string
  readonly token: string
  post(route: string, body: unknown): Promise<Response>
}

/**
 * Pairs an app device with `scopes`: `devices.pair.start`, the JSON pairing page (`x-own-pairing` claim), the PC's
 * approval with the shown SAS, then `Authorization: Bearer <token>` (the same gateway Policy as a browser device).
 */
export async function pairApp(
  stack: Stack,
  gateway: string,
  input: { readonly name: string; readonly scopes: ReadonlyArray<OwnRemote.DeviceScope> },
): Promise<Device> {
  const started = await local(stack, "devices.pair.start", {
    name: input.name,
    scopes: [...input.scopes],
    servers: { mode: "all" },
    expiresDays: 1,
  })
  const opened = await fetch(started.url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (Linux; Android 15) OwnOpenCodeApp/1 (android)" },
  })
  if (opened.status !== 200) throw new Error(`pairing page: HTTP ${opened.status}`)
  const page = Schema.decodeUnknownSync(Schema.Struct({ claim: Schema.String, sas: Schema.String }))(
    await opened.json(),
  )
  await local(stack, "devices.pair.approve", { pairingId: started.pairingId, sas: page.sas })
  const claimed = await fetch(`${gateway}/own/pairing/claim`, {
    method: "POST",
    headers: { "x-own-pairing": page.claim, "content-type": "application/json" },
    body: "{}",
  })
  if (claimed.status !== 200) throw new Error(`pairing claim: HTTP ${claimed.status}`)
  const device = Schema.decodeUnknownSync(Schema.Struct({ deviceId: Schema.String, token: Schema.String }))(
    await claimed.json(),
  )
  return {
    ...device,
    post: (route, body) =>
      fetch(`${gateway}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  }
}
