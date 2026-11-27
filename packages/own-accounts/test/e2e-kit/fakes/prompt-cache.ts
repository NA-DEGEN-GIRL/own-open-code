import { estimateTokens, sha256, systemClock, type CacheUsage, type Clock } from "./shared"

export interface PromptCacheOptions {
  /** Granularity of cache hits in tokens (OpenAI/Codex: 128, DeepSeek: 64). Prefix mode only. */
  readonly blockTokens?: number
  /** Prompts (or breakpoint prefixes) shorter than this are never cached. */
  readonly minTokens?: number
  /** Lifetime of a prefix-mode entry after its last use. Breakpoint mode uses the block's `ttl`. */
  readonly ttlMs?: number
  readonly clock?: Clock
}

export interface CacheBlock {
  /** Serialized block content, excluding cache-control markers. */
  readonly text: string
  /** Set when the block carries a cache breakpoint. */
  readonly breakpoint?: "5m" | "1h"
}

export interface LookupOptions {
  /**
   * Store the prompt's prefixes (default true). Fakes look up with `write: false` first and write only
   * once the request is accepted, so rejected requests (401/429/injected errors) never warm the cache.
   */
  readonly write?: boolean
}

export interface BreakpointUsage extends CacheUsage {
  readonly written5m: number
  readonly written1h: number
}

const TTL_MS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const
const LOOKBACK_BLOCKS = 20

/**
 * Deterministic prompt-cache model keyed by (domain, exact prefix bytes).
 *
 * The domain is whatever the fake decides owns a cache (account, org or workspace, plus model), so
 * switching credentials across domains misses while byte-identical prefixes inside one domain hit.
 * Prefixes are chained hashes, so a lookup costs O(prompt length) however many blocks match.
 */
export class PromptCache {
  readonly blockTokens: number
  readonly minTokens: number
  readonly ttlMs: number
  private readonly clock: Clock
  private readonly entries = new Map<string, number>()

  constructor(options: PromptCacheOptions = {}) {
    this.blockTokens = options.blockTokens ?? 128
    this.minTokens = options.minTokens ?? 1024
    this.ttlMs = options.ttlMs ?? 10 * 60_000
    this.clock = options.clock ?? systemClock
  }

  /** Automatic prefix caching: the hit is the longest cached run of whole blocks from the start. */
  prefix(domain: string, prompt: string, options: LookupOptions = {}): CacheUsage {
    const now = this.clock.now()
    const size = this.blockTokens * 4
    const keys = chain(
      domain,
      Array.from({ length: Math.floor(prompt.length / size) }, (_, index) =>
        prompt.slice(index * size, (index + 1) * size),
      ),
    )
    const miss = keys.findIndex((key) => !this.alive(key, now))
    const hitTokens = (miss === -1 ? keys.length : miss) * this.blockTokens
    const promptTokens = estimateTokens(prompt)
    if (options.write !== false && promptTokens >= this.minTokens)
      keys.forEach((key) => this.entries.set(key, now + this.ttlMs))
    return {
      promptTokens,
      cachedTokens: hitTokens >= this.minTokens ? hitTokens : 0,
      writtenTokens: 0,
      promptHash: sha256(prompt),
    }
  }

  /**
   * Explicit breakpoint caching (Anthropic): each breakpoint looks back up to 20 block boundaries for
   * the longest cached prefix, then writes its own prefix with the breakpoint's TTL.
   */
  breakpoints(domain: string, blocks: readonly CacheBlock[], options: LookupOptions = {}): BreakpointUsage {
    const now = this.clock.now()
    const keys = chain(
      domain,
      blocks.map((block) => block.text),
    )
    const offsets: number[] = []
    blocks.forEach((block) => offsets.push((offsets.at(-1) ?? 0) + block.text.length))
    const tokensAt = (index: number) => (index < 0 ? 0 : Math.ceil(offsets[index] / 4))
    const points = blocks.flatMap((block, index) =>
      block.breakpoint !== undefined && tokensAt(index) >= this.minTokens ? [{ index, ttl: block.breakpoint }] : [],
    )
    const hit = Math.max(
      -1,
      ...points.map(
        (point) =>
          Array.from({ length: Math.min(LOOKBACK_BLOCKS, point.index + 1) }, (_, back) => point.index - back).find(
            (index) => this.alive(keys[index], now),
          ) ?? -1,
      ),
    )
    const cachedTokens = tokensAt(hit)
    const writes = points
      .filter((point) => point.index > hit)
      .map((point, position, pending) => ({
        ttl: point.ttl,
        tokens:
          tokensAt(point.index) - Math.max(cachedTokens, position === 0 ? 0 : tokensAt(pending[position - 1].index)),
      }))
    if (options.write !== false && hit >= 0) this.touch(keys[hit], now + TTL_MS["5m"])
    if (options.write !== false) points.forEach((point) => this.touch(keys[point.index], now + TTL_MS[point.ttl]))
    const written5m = writes.filter((write) => write.ttl === "5m").reduce((sum, write) => sum + write.tokens, 0)
    const written1h = writes.filter((write) => write.ttl === "1h").reduce((sum, write) => sum + write.tokens, 0)
    return {
      promptTokens: tokensAt(blocks.length - 1),
      cachedTokens,
      writtenTokens: written5m + written1h,
      written5m,
      written1h,
      promptHash: sha256(blocks.map((block) => block.text).join("\u0000")),
    }
  }

  clear() {
    this.entries.clear()
  }

  get size() {
    return this.entries.size
  }

  private alive(key: string, now: number) {
    const expires = this.entries.get(key)
    return expires !== undefined && expires > now
  }

  private touch(key: string, expires: number) {
    this.entries.set(key, Math.max(this.entries.get(key) ?? 0, expires))
  }
}

/** Chained prefix hashes: key[i] identifies (domain, parts[0..i]) exactly. */
function chain(domain: string, parts: readonly string[]) {
  const keys: string[] = []
  parts.forEach((part) => keys.push(sha256(`${keys.at(-1) ?? sha256(domain)}\u0000${part}`)))
  return keys
}
