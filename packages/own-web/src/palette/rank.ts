// What the palette lists (pure, unit tested): with nothing typed, recently used commands, the newest sessions, then
// every command by group with a header row; with a query, one flat list by match score (group shown per row).
import { matchCandidate, parseQuery, prepare, type Candidate } from "./fuzzy"
import { PALETTE_GROUPS, type PaletteCommand, type PaletteGroup } from "./registry"

export interface Entry {
  readonly command: PaletteCommand
  readonly candidate: Candidate
  /** Position in the source order (ties keep it). */
  readonly order: number
}

export type Row =
  | { readonly kind: "header"; readonly group: PaletteGroup }
  | { readonly kind: "item"; readonly command: PaletteCommand; readonly positions: readonly number[] }

export interface RankOptions {
  /** Recently run command ids, newest first. */
  readonly recent: readonly string[]
  /** Items in the recent group when nothing is typed. */
  readonly recentLimit?: number
  /** Sessions when nothing is typed (all of them are searchable). */
  readonly sessionLimit?: number
  /** Rows of a search (a longer list is not read; the virtual list keeps any size cheap anyway). */
  readonly resultLimit?: number
}

const RECENT_BOOST = 4
/**
 * Sessions are many and their titles are free text: a command whose words match comes first unless a session title is
 * clearly the better match (starts with the words where the command only contains them).
 */
const SESSION_BIAS = -12

/** Prepared once per open (titles, keywords, details); duplicate ids keep the first. */
export function prepareEntries(commands: readonly PaletteCommand[]): Entry[] {
  const seen = new Set<string>()
  return commands.flatMap((command, order) => {
    if (seen.has(command.id)) return []
    seen.add(command.id)
    const candidate: Candidate = {
      title: prepare(command.title),
      keywords: command.keywords?.length ? prepare(command.keywords.join(" · ")) : undefined,
      detail: command.detail ? prepare(command.detail) : undefined,
    }
    return [{ command, candidate, order }]
  })
}

export function rankRows(entries: readonly Entry[], query: string, options: RankOptions): Row[] {
  const terms = parseQuery(query)
  if (!terms.length) return browse(entries, options)
  const recent = new Map(options.recent.map((id, index) => [id, index]))
  const scored = entries.flatMap((entry) => {
    const match = matchCandidate(terms, entry.candidate)
    if (!match) return []
    const boost = recent.has(entry.command.id) ? RECENT_BOOST : 0
    const bias = entry.command.group === "session" ? SESSION_BIAS : 0
    return [{ entry, positions: match.positions, score: match.score + boost + bias }]
  })
  return scored
    .sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)
    .slice(0, options.resultLimit ?? 200)
    .map((item) => ({ kind: "item", command: item.entry.command, positions: item.positions }))
}

function browse(entries: readonly Entry[], options: RankOptions): Row[] {
  const byID = new Map(entries.map((entry) => [entry.command.id, entry]))
  const recent = options.recent
    .flatMap((id) => {
      const entry = byID.get(id)
      return entry && entry.command.group !== "session" ? [entry] : []
    })
    .slice(0, options.recentLimit ?? 5)
  const shown = new Set(recent.map((entry) => entry.command.id))
  const groups = new Map<PaletteGroup, Entry[]>()
  for (const entry of entries) {
    if (shown.has(entry.command.id)) continue
    const list = groups.get(entry.command.group)
    if (list) list.push(entry)
    else groups.set(entry.command.group, [entry])
  }
  const section = (group: PaletteGroup, list: readonly Entry[]): Row[] =>
    list.length
      ? [
          { kind: "header", group },
          ...list.map((entry): Row => ({ kind: "item", command: entry.command, positions: [] })),
        ]
      : []
  return [
    ...section("recent", recent),
    ...PALETTE_GROUPS.filter((group) => group !== "recent").flatMap((group) => {
      const list = groups.get(group) ?? []
      return section(group, group === "session" ? list.slice(0, options.sessionLimit ?? 8) : list)
    }),
  ]
}
