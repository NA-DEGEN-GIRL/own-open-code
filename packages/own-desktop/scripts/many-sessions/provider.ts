// The paced fake OpenAI Responses provider (own-web e2e/performance/fixture/stream-provider.ts) in a process of its
// own, so tens of concurrent streams do not compete with the bench's CDP, trace and probe work for one JS thread.
// Prints `{"url": …, "baseURL": …}` on its first line; ends when stdin closes. Fake credentials only, loopback only.
import { startStreamProvider } from "../../../own-web/e2e/performance/fixture/stream-provider"

const provider = startStreamProvider({ models: (process.argv[2] ?? "gpt-5.5").split(",") })
console.log(JSON.stringify({ url: provider.url, baseURL: provider.baseURL }))
process.stdin.on("end", () => {
  provider.stop()
  process.exit(0)
})
process.stdin.on("data", () => undefined)
process.stdin.resume()
