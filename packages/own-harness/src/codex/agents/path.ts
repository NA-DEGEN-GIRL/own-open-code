// Ports Codex's `AgentPath` (codex-rs/protocol/src/agent_path.rs): canonical task names such as `/root` and
// `/root/researcher/worker`, child joins and relative/absolute reference resolution, with Codex's error texts.
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as AgentPath from "./path.js"

export const ROOT = "/root"
const MORPHEUS = "/morpheus"
const ROOT_SEGMENT = "root"

export type Result = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string }

export function isRoot(path: string) {
  return path === ROOT
}

/** The last segment; `root` for `/root`. */
export function name(path: string) {
  if (isRoot(path)) return ROOT_SEGMENT
  return path.split("/").at(-1) || ROOT_SEGMENT
}

/** The parent path (`rsplit_once('/')`), or undefined for `/root`. */
export function parent(path: string) {
  const at = path.lastIndexOf("/")
  if (at <= 0) return undefined
  const candidate = path.slice(0, at)
  return validateAbsolute(candidate) === undefined ? candidate : undefined
}

/** `AgentPath::join`: the canonical path of a child named `agentName`. */
export function join(base: string, agentName: string): Result {
  const invalid = validateName(agentName)
  if (invalid !== undefined) return { ok: false, error: invalid }
  return fromString(`${base}/${agentName}`)
}

/** `AgentPath::resolve`: `/root`, an absolute path, or a path relative to `current`. */
export function resolve(current: string, reference: string): Result {
  if (reference === "") return { ok: false, error: "agent path must not be empty" }
  if (reference === ROOT) return { ok: true, path: ROOT }
  if (reference.startsWith("/")) return fromString(reference)
  if (reference.endsWith("/")) return { ok: false, error: "relative agent path must not end with `/`" }
  const invalid = reference
    .split("/")
    .map(validateName)
    .find((error) => error !== undefined)
  if (invalid !== undefined) return { ok: false, error: invalid }
  return fromString(`${current}/${reference}`)
}

export function fromString(path: string): Result {
  const invalid = validateAbsolute(path)
  return invalid === undefined ? { ok: true, path } : { ok: false, error: invalid }
}

function validateName(agentName: string) {
  if (agentName === "") return "agent_name must not be empty"
  if (agentName === ROOT_SEGMENT) return "agent_name `root` is reserved"
  if (agentName === "." || agentName === "..") return `agent_name \`${agentName}\` is reserved`
  if (agentName.includes("/")) return "agent_name must not contain `/`"
  if (!/^[a-z0-9_]*$/.test(agentName)) return "agent_name must use only lowercase letters, digits, and underscores"
  return undefined
}

function validateAbsolute(path: string) {
  if (path === MORPHEUS) return undefined
  if (!path.startsWith("/")) return "absolute agent paths must start with `/root` or be `/morpheus`"
  const stripped = path.slice(1)
  const segments = stripped.split("/")
  if (segments[0] !== ROOT_SEGMENT) return "absolute agent paths must start with `/root` or be `/morpheus`"
  if (stripped.endsWith("/")) return "absolute agent path must not end with `/`"
  return segments
    .slice(1)
    .map(validateName)
    .find((error) => error !== undefined)
}
