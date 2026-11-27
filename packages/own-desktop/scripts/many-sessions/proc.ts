// Process memory and CPU of the shell's and the service's process trees (proc-sample.ps1 in -Serve mode, one
// PowerShell for the whole run). Rows are grouped by role: Electron main, renderer, GPU, network/storage/other
// utility processes, the service and its children.
import path from "node:path"

export interface ProcRow {
  readonly pid: number
  readonly ppid: number
  readonly name: string
  readonly type: string
  readonly ws: number
  readonly privateWs: number | null
  readonly privateBytes: number
  readonly cpu100ns: number
  readonly role: string
}

export interface RoleTotals {
  readonly count: number
  /** MB */
  readonly ws: number
  readonly privateWs: number
  readonly privateBytes: number
  /** CPU seconds since process start */
  readonly cpuSeconds: number
}

export interface ProcSample {
  readonly at: number
  readonly roles: Record<string, RoleTotals>
  readonly rows: readonly ProcRow[]
}

const MB = 1024 * 1024
const round1 = (value: number) => Math.round(value * 10) / 10

export function startProcSampler() {
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dir, "proc-sample.ps1"),
      "-Serve",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true },
  )
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const buffer = { text: "" }
  const queue = { tail: Promise.resolve() as Promise<unknown> }
  const line = async () => {
    while (!buffer.text.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("proc-sample.ps1 ended")
      buffer.text += decoder.decode(chunk.value, { stream: true })
    }
    const index = buffer.text.indexOf("\n")
    const result = buffer.text.slice(0, index)
    buffer.text = buffer.text.slice(index + 1)
    return result
  }
  const run = async (groups: { readonly shell?: number; readonly service?: readonly number[] }) => {
    const roots = [groups.shell, ...(groups.service ?? [])].filter((pid): pid is number => typeof pid === "number")
    child.stdin.write(`${roots.join(",")}\n`)
    await child.stdin.flush()
    const text = (await line()).trim()
    const parsed = (text ? JSON.parse(text) : []) as Omit<ProcRow, "role">[] | Omit<ProcRow, "role">
    const raw = Array.isArray(parsed) ? parsed : [parsed]
    const service = new Set<number>()
    const mark = (pid: number) => {
      service.add(pid)
      raw.filter((row) => row.ppid === pid && !service.has(row.pid)).forEach((row) => mark(row.pid))
    }
    groups.service?.forEach(mark)
    const rows = raw.map((row) => ({ ...row, role: role(row, service, groups.service ?? []) }))
    const roles: Record<string, RoleTotals> = {}
    for (const row of rows) {
      const before = roles[row.role] ?? { count: 0, ws: 0, privateWs: 0, privateBytes: 0, cpuSeconds: 0 }
      roles[row.role] = {
        count: before.count + 1,
        ws: before.ws + row.ws / MB,
        privateWs: before.privateWs + (row.privateWs ?? 0) / MB,
        privateBytes: before.privateBytes + row.privateBytes / MB,
        cpuSeconds: before.cpuSeconds + row.cpu100ns / 1e7,
      }
    }
    const sorted = Object.entries(roles).toSorted((a, b) => b[1].privateBytes - a[1].privateBytes)
    return {
      at: Date.now(),
      roles: Object.fromEntries(
        sorted.map(([key, value]) => [
          key,
          {
            count: value.count,
            ws: round1(value.ws),
            privateWs: round1(value.privateWs),
            privateBytes: round1(value.privateBytes),
            cpuSeconds: round1(value.cpuSeconds),
          },
        ]),
      ),
      rows,
    }
  }
  return {
    /** One sample of the trees under the shell and the service roots (requests are served one at a time). */
    sample(groups: { readonly shell?: number; readonly service?: readonly number[] }): Promise<ProcSample> {
      const next = queue.tail.then(
        () => run(groups),
        () => run(groups),
      )
      queue.tail = next.catch(() => undefined)
      return next
    },
    stop: async () => {
      await Promise.resolve(child.stdin.end()).catch(() => undefined)
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
      if (!exited) child.kill()
    },
  }
}

function role(row: Omit<ProcRow, "role">, service: ReadonlySet<number>, roots: readonly number[]) {
  if (service.has(row.pid)) return roots.includes(row.pid) ? "service" : `service-child:${row.name}`
  const name = row.name.toLowerCase()
  if (name !== "electron.exe" && name !== "own-desktop.exe") return `shell-child:${row.name}`
  if (row.type === "main") return "electron-main"
  if (row.type === "gpu-process") return "gpu"
  if (row.type.startsWith("utility")) return row.type.replace("utility:", "utility-")
  return row.type
}

/** Sum over roles, optionally only those matching `filter`. */
export function totals(sample: ProcSample, filter: (role: string) => boolean = () => true) {
  const picked = Object.entries(sample.roles).filter(([role]) => filter(role))
  const sum = (key: keyof RoleTotals) => round1(picked.reduce((total, [, value]) => total + value[key], 0))
  return {
    count: sum("count"),
    ws: sum("ws"),
    privateWs: sum("privateWs"),
    privateBytes: sum("privateBytes"),
    cpuSeconds: sum("cpuSeconds"),
  }
}

export const isShell = (role: string) => !role.startsWith("service")
export const isService = (role: string) => role.startsWith("service")

/** CPU use per role between two samples, in % of one core (per pid, so processes that came or went do not count). */
export function cpuBetween(before: ProcSample, after: ProcSample): Record<string, number> {
  const seconds = (after.at - before.at) / 1000
  if (seconds <= 0) return {}
  const old = new Map(before.rows.map((row) => [row.pid, row.cpu100ns]))
  const byRole: Record<string, number> = {}
  for (const row of after.rows) {
    const start = old.get(row.pid)
    if (start === undefined) continue
    byRole[row.role] = (byRole[row.role] ?? 0) + (row.cpu100ns - start) / 1e7
  }
  const shares = Object.entries(byRole).map(([key, cpu]) => [key, round1((cpu / seconds) * 100)] as const)
  const total = round1(shares.reduce((sum, [, value]) => sum + value, 0))
  return { ...Object.fromEntries(shares), total }
}
