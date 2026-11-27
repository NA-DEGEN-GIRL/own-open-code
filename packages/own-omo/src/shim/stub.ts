// own's stand-in inside the omo runtime bundle (script/resolve.ts) for `@opencode-ai/sdk` (OpenCode 1's HTTP client:
// own-omo hands omo its own client, src/host/client.ts), `posthog-node` (omo's telemetry, which own turns off) and
// `sharp` (image conversion for omo's look_at tool, which own does not register). Using any of them throws.
function unavailable(name: string): never {
  throw new Error(`${name} is not available in own-omo`)
}

export function createOpencodeClient(): never {
  return unavailable("@opencode-ai/sdk createOpencodeClient")
}

export function createOpencode(): never {
  return unavailable("@opencode-ai/sdk createOpencode")
}

export class OpencodeClient {
  constructor() {
    unavailable("@opencode-ai/sdk OpencodeClient")
  }
}

export class PostHog {
  constructor() {
    unavailable("posthog-node")
  }
}

export default function sharp(): never {
  return unavailable("sharp")
}
