export * as SlotSamples from "./slot-samples.js"

/** Samples kept per slot and kind: the most recent ones. */
export const KEEP = 20

/** What one slot keeps: first-step Z and step δ (one exchange) samples. */
export type Kind = "Z" | "delta"

/**
 * First-step Z and step δ samples of each slot's recent root sessions that own.import did not write (09 §5.6),
 * keyed by providerID and shared by every own.accounts instance of one build. Each instance sees only its own
 * Location's events, while `estimate.request` is asked at the control Location (02 §9.1): so every instance adds the
 * samples of its sessions here, and the answer covers the whole slot in this process. Memory only: after a restart a
 * slot starts from the defaults again.
 */
export class Store {
  readonly #slots = new Map<string, Record<Kind, number[]>>()

  /** Adds one sample, dropping the oldest past {@link KEEP}. */
  add(providerID: string, kind: Kind, value: number) {
    const found = this.#slots.get(providerID) ?? { Z: [], delta: [] }
    this.#slots.set(providerID, found)
    found[kind].push(value)
    if (found[kind].length > KEEP) found[kind].shift()
  }

  /** The slot's samples of `kind`, oldest first. */
  get(providerID: string, kind: Kind): ReadonlyArray<number> {
    return this.#slots.get(providerID)?.[kind] ?? []
  }
}
