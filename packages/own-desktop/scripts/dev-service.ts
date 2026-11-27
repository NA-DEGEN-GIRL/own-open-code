// Development service for the shell (05 §11.2): own-web's dev service (packages/own-web/dev/service.ts: the upstream
// server from source with own.accounts + own.telemetry, fake providers, seeded sessions, one temp root) plus the
// registration file the shell discovers, written into a temp XDG_STATE_HOME. Nothing here touches the user's real
// state directory: the shell is started with that XDG_STATE_HOME, so its env snapshot points at the same file.
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { startDevService, type DevServiceOptions } from "../../own-web/dev/service"

export interface RegisteredDevService {
  readonly service: Awaited<ReturnType<typeof startDevService>>
  /** The registration file (`service-local.json` for the dev shell, `service-own.json` for a packaged smoke run). */
  readonly registration: string
  readonly version: string
  readonly pid: number
  /** The dev service's OWN_HOME (plugin `home`): `<ownHome>\control` is the control location. */
  readonly ownHome: string
}

export async function startRegisteredDevService(
  options: DevServiceOptions & { readonly stateHome: string; readonly channel: "local" | "own" },
): Promise<RegisteredDevService> {
  const service = await startDevService(options)
  try {
    const registered = await registerService({
      url: service.server.url,
      authorization: service.server.authorization,
      password: service.password,
      stateHome: options.stateHome,
      channel: options.channel,
    })
    return { service, ...registered, ownHome: service.server.paths.ownHome }
  } catch (error) {
    await service.stop()
    throw error
  }
}

/**
 * Writes the registration the shell discovers for a running server, in the shape the CLI writes (packages/client
 * service.ts Info): discover() checks pid and version against /api/info. Only into the given temp state home.
 */
export async function registerService(input: {
  readonly url: string
  readonly authorization: string
  readonly password: string
  readonly stateHome: string
  readonly channel: "local" | "own"
}) {
  const response = await fetch(new URL("/api/info", input.url), { headers: { authorization: input.authorization } })
  const info = (await response.json()) as { version?: string; pid?: number }
  if (!response.ok || typeof info.pid !== "number" || typeof info.version !== "string")
    throw new Error(`dev service /api/info: ${response.status} ${JSON.stringify(info)}`)
  const registration = path.join(
    input.stateHome,
    "opencode",
    input.channel === "local" ? "service-local.json" : "service-own.json",
  )
  await mkdir(path.dirname(registration), { recursive: true })
  await writeFile(
    registration,
    JSON.stringify(
      {
        id: `own-desktop-dev-${process.pid}`,
        version: info.version,
        url: input.url,
        pid: info.pid,
        password: input.password,
      },
      null,
      2,
    ),
  )
  return { registration, version: info.version, pid: info.pid }
}
