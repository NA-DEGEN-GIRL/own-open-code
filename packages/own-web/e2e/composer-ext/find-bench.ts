// `fs.find` on Windows: ripgrep index (the default, fff off: packages/cli/src/server-process.ts:121-124) against fff
// (`OPENCODE_DISABLE_FFF=0`), on a real large repository (this checkout by default). 01 §17.1 #12 asks to measure
// ranking and speed before deciding the launcher env. Read-only: the server only indexes the directory.
//
//   bun e2e/composer-ext/find-bench.ts [repo directory] [--repeat 5]
//
// Prints one JSON line per mode (cold first answer = index build, warm p50/max per query, top results) and a summary.
import path from "node:path"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"

const args = process.argv.slice(2)
const repeatAt = args.indexOf("--repeat")
const repeat = repeatAt >= 0 ? Number(args[repeatAt + 1]) || 5 : 5
const given = args.find((arg, index) => !arg.startsWith("--") && index !== repeatAt + 1)
// Forward slashes: the server normalizes them.
const directory = path.resolve(given ?? REPO_ROOT).replaceAll("\\", "/")
const QUERIES = [
  "router",
  "composer/index",
  "ime-enter",
  "search.ts",
  "session/prompt",
  "own-web/src/data",
  "pkgjson",
  "readme ko",
  "라우터",
]

const results = []
for (const mode of ["ripgrep", "fff"] as const) {
  const server = await startOpencodeServer({
    config: opencodeConfig({ providers: {} }),
    env: mode === "fff" ? { OPENCODE_DISABLE_FFF: "0" } : {},
  })
  const fail = (what: string, status: number) =>
    new Error(
      `${mode} ${what}: ${status}\n${server
        .logs()
        .split("\n")
        .filter((line) => line.includes("cause") || line.includes("level=ERROR"))
        .join("\n")
        .slice(0, 3_000)}`,
    )
  try {
    const find = async (query: string) => {
      const started = performance.now()
      const response = await server.request("GET", "/api/fs/find", {
        query: { "location[directory]": directory, query, limit: "20" },
        directory,
      })
      if (!response.ok) throw fail(query, response.status)
      const body = (await response.json()) as { data?: { path: string }[] }
      return { ms: performance.now() - started, paths: (body.data ?? []).map((entry) => entry.path) }
    }
    // Open the Location first (its own cost), so the first find measures the index build.
    const opened = await server.request("GET", "/api/location", {
      query: { "location[directory]": directory },
      directory,
    })
    if (!opened.ok) throw fail("location", opened.status)
    const cold = await find(QUERIES[0]!)
    const perQuery = []
    for (const query of QUERIES) {
      const times = []
      let paths: string[] = []
      for (let run = 0; run < repeat; run++) {
        const answer = await find(query)
        times.push(answer.ms)
        paths = answer.paths
      }
      times.sort((a, b) => a - b)
      perQuery.push({
        query,
        p50: round(times[Math.floor(times.length / 2)]!),
        max: round(times.at(-1)!),
        count: paths.length,
        top: paths.slice(0, 3),
      })
    }
    const medians = perQuery.map((item) => item.p50).toSorted((a, b) => a - b)
    const result = {
      mode,
      directory,
      coldFirstAnswerMs: round(cold.ms),
      warmP50Ms: medians[Math.floor(medians.length / 2)],
      warmMaxMs: Math.max(...perQuery.map((item) => item.max)),
      queries: perQuery,
    }
    results.push(result)
    console.log(`FIND_BENCH ${JSON.stringify(result)}`)
  } finally {
    await server.stop()
  }
}

console.log(
  `FIND_BENCH_SUMMARY ${JSON.stringify(
    results.map((result) => ({
      mode: result.mode,
      cold: result.coldFirstAnswerMs,
      warmP50: result.warmP50Ms,
      warmMax: result.warmMaxMs,
    })),
  )}`,
)

function round(value: number) {
  return Math.round(value * 10) / 10
}
