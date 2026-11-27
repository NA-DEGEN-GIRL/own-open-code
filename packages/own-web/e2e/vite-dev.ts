// Vite dev for the e2e backends and dev/serve.ts (`bun run dev:service`, the integration walkthrough): the package's
// vite.config.ts on 127.0.0.1 with a dependency cache of its own, every own-web module transformed first, and a dev
// port that answers only once the backend calls `ready()`.
import path from "node:path"
import { Glob } from "bun"
import { createServer, type ServerOptions } from "vite"

const PACKAGE = path.join(import.meta.dir, "..")

export async function startViteDev(server: ServerOptions & { readonly port: number }) {
  const gate = { open: false }
  const dev = await createServer({
    configFile: path.join(PACKAGE, "vite.config.ts"),
    root: PACKAGE,
    // One dependency cache per dev port, so two running backends never share one: the first server after a lockfile
    // or config change deletes and rebuilds `deps/` (21 s on 2026-10-16), and every suite on that cache loses it.
    cacheDir: path.join(PACKAGE, "node_modules/.vite-e2e", String(server.port)),
    server: { strictPort: true, host: "127.0.0.1", ...server },
    logLevel: "warn",
    plugins: [
      {
        name: "own-e2e-ready-gate",
        // Playwright's webServer check takes any status below 404 as ready, and its runner then loads the specs,
        // which read the backend's state file at once: answer 503 until the backend has written it (2026-10-16, an
        // empty backend.json read while the shared backend still started its preview server).
        configureServer: (vite) => {
          vite.middlewares.use((_request, response, next) => {
            if (gate.open) return next()
            response.statusCode = 503
            response.end()
          })
        },
      },
    ],
  })
  await dev.listen()
  // A cold server transforms on request: under load a lazy chunk outlasted the 20 s expect timeout (p5 "4 work panel",
  // 2026-10-14). Transforming every module first moves that cost before the port answers (about 12 s on a quiet PC).
  // warmupRequest transforms in-process, so the gate does not hold it back.
  const files = await Array.fromAsync(new Glob("src/**/*.{ts,tsx}").scan({ cwd: PACKAGE }))
  await Promise.all(
    files
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !/\.(test|d)\.tsx?$|\/e2e\/|\/vite\.ts$/.test(file))
      .map((file) => dev.warmupRequest(`/${file}`)),
  )
  return Object.assign(dev, {
    /** Opens the dev port; the backend calls it right after writing its state file. */
    ready: () => {
      gate.open = true
    },
  })
}
