// Split panes of one window (03 §4.1.1, 05 §7.2): a small tree of at most 4 leaves and 2 split levels. A chat leaf
// shows one workspace route (a session, or the new-session screen of home or a project); a browser leaf shows the
// browser of the chat leaf it follows, or of a session it is pinned to. The focused leaf's chat route is the URL, so
// the header, the work panel and the per-project layout follow the focused pane (context.tsx).
// The reducer is pure (unit tested); `createPaneLayout` keeps the state per window and device in browser storage
// (`own.web.panes.<windowKey>`, never synced), with the device default mode (`나란히` or `탭으로 보기`) beside it.
import { createSignal, onCleanup } from "solid-js"

export type PaneView = "chat" | "browser" | "notes"
export type PaneMode = "split" | "tabs"
export type PaneDir = "row" | "column"

/** The workspace routes a chat pane can show (03 §3: everything but pages). */
export type PaneRoute =
  /** The new-conversation screen without a project; `serverKey` only for another server than this PC (routes.ts). */
  | { readonly name: "home"; readonly serverKey?: string }
  | { readonly name: "project"; readonly serverKey: string; readonly projectID: string }
  | { readonly name: "session"; readonly serverKey: string; readonly sessionID: string }

export interface PaneSession {
  readonly serverKey: string
  readonly sessionID: string
}

export interface PaneLeaf {
  readonly kind: "leaf"
  readonly id: string
  readonly view: PaneView
  /** chat: what it shows. */
  readonly route?: PaneRoute
  /** browser, notes: the chat leaf whose session (or project) it follows. */
  readonly follows?: string
  /** browser: a session it stays on, whatever the chat leaf shows. */
  readonly pinned?: PaneSession
}

export interface PaneSplit {
  readonly kind: "split"
  readonly dir: PaneDir
  /** Fractions of the split's size, one per child, summing to 1. */
  readonly sizes: readonly number[]
  readonly children: readonly PaneNode[]
}

export type PaneNode = PaneLeaf | PaneSplit

export interface PaneState {
  readonly tree: PaneNode
  readonly focused: string
  /** This window's choice; `undefined` follows the device default (설정 > 레이아웃 > 워크스페이스 보기). */
  readonly mode?: PaneMode
}

/** Session rows carry `{serverKey, sessionID}` as this type when dragged from the sidebar onto a pane. */
export const SESSION_DRAG_TYPE = "application/x-own-session"
/** A pane's bar dragged onto another pane carries the pane id as this type. */
export const PANE_DRAG_TYPE = "application/x-own-pane"

export const MAX_LEAVES = 4
export const MAX_DEPTH = 2
/** Below these widths a pane is not usable; a tree that does not fit falls back to tabs (03 §4.1.1). */
export const PANE_MIN: Readonly<Record<PaneView, number>> = { chat: 420, browser: 360, notes: 280 }
/** Height a pane of a column split keeps at least. */
export const PANE_MIN_HEIGHT = 220
const MIN_FRACTION = 0.1

export type SplitRefusal = "limit" | "depth" | "missing"

export function initialPanes(route: PaneRoute = { name: "home" }): PaneState {
  return { tree: { kind: "leaf", id: "p1", view: "chat", route }, focused: "p1" }
}

export function leavesOf(node: PaneNode): PaneLeaf[] {
  return node.kind === "leaf" ? [node] : node.children.flatMap(leavesOf)
}

export function findLeaf(state: PaneState, id: string) {
  return leavesOf(state.tree).find((leaf) => leaf.id === id)
}

/** The chat leaf a leaf belongs to: itself, the one it follows, or the first chat leaf when it follows nothing. */
export function chatOf(state: PaneState, id: string): PaneLeaf | undefined {
  const leaves = leavesOf(state.tree)
  const leaf = leaves.find((item) => item.id === id)
  if (leaf?.view === "chat") return leaf
  const followed = leaf?.follows ? leaves.find((item) => item.id === leaf.follows && item.view === "chat") : undefined
  return followed ?? leaves.find((item) => item.view === "chat")
}

/** The chat leaf whose route is the URL. */
export function focusedChat(state: PaneState) {
  return chatOf(state, state.focused)
}

export function sessionOfRoute(route: PaneRoute | undefined): PaneSession | undefined {
  return route?.name === "session" ? { serverKey: route.serverKey, sessionID: route.sessionID } : undefined
}

export function sameSession(a: PaneSession | undefined, b: PaneSession | undefined) {
  return !!a && !!b && a.serverKey === b.serverKey && a.sessionID === b.sessionID
}

export function sameRoute(a: PaneRoute | undefined, b: PaneRoute | undefined) {
  return routeKey(a) === routeKey(b)
}

function routeKey(route: PaneRoute | undefined) {
  if (!route) return ""
  if (route.name === "home") return route.serverKey ? `h\u0000${route.serverKey}` : "home"
  if (route.name === "project") return `p\u0000${route.serverKey}\u0000${route.projectID}`
  return `s\u0000${route.serverKey}\u0000${route.sessionID}`
}

/** The session a browser leaf shows: its pinned one, else the session of the chat leaf it follows. */
export function browserTarget(state: PaneState, leaf: PaneLeaf): PaneSession | undefined {
  if (leaf.pinned) return leaf.pinned
  const chat = leaf.follows ? findLeaf(state, leaf.follows) : undefined
  return chat?.view === "chat" ? sessionOfRoute(chat.route) : undefined
}

/** The browser leaf that follows a chat leaf (one at most). */
export function browserOf(state: PaneState, chatID: string) {
  return leavesOf(state.tree).find((leaf) => leaf.view === "browser" && leaf.follows === chatID && !leaf.pinned)
}

/** The chat leaf showing a session, if any (one session is shown by one chat pane). */
export function chatShowing(state: PaneState, session: PaneSession) {
  return leavesOf(state.tree).find((leaf) => leaf.view === "chat" && sameSession(sessionOfRoute(leaf.route), session))
}

export function focusPane(state: PaneState, id: string): PaneState {
  if (state.focused === id || !findLeaf(state, id)) return state
  return { ...state, focused: id }
}

/**
 * The route changed (sidebar, history, a link): the chat pane already showing that session gets the focus; otherwise
 * the focused chat pane shows the route.
 */
export function openRoute(state: PaneState, route: PaneRoute): PaneState {
  const session = sessionOfRoute(route)
  const showing = session ? chatShowing(state, session) : undefined
  if (showing) return focusPane(state, showing.id)
  const chat = focusedChat(state)
  if (!chat) return initialPanes(route)
  if (sameRoute(chat.route, route)) return state
  return { ...state, tree: mapLeaves(state.tree, (leaf) => (leaf.id === chat.id ? { ...leaf, route } : leaf)) }
}

/**
 * `분할해서 열기` (Ctrl+click on a row, the row menu, a drop on a pane edge): the route in a new chat pane beside
 * `target` (default: the focused chat pane). A session that is already in a pane only gets that pane focused.
 */
export function openBeside(
  state: PaneState,
  route: PaneRoute,
  options: { readonly dir?: PaneDir; readonly before?: boolean; readonly target?: string } = {},
): { readonly state: PaneState; readonly refused?: SplitRefusal } {
  const session = sessionOfRoute(route)
  const showing = session ? chatShowing(state, session) : undefined
  if (showing) return { state: focusPane(state, showing.id) }
  const target = options.target ?? state.focused
  const result = splitPane(state, target, options.dir ?? "row", { view: "chat", route }, { before: options.before })
  if (!result.id) return { state, refused: result.refused }
  return { state: { ...result.state, focused: result.id } }
}

/**
 * Inserts a new leaf beside `target`: as a sibling when the parent splits the same way, otherwise by wrapping the
 * target in a new split (refused beyond MAX_DEPTH levels). `share` is the part of the target's space the new leaf gets.
 * A chat pane and the browser pane that follows it move as one group: a new chat pane goes beside the pair (split
 * right: after its browser; split down: below both), so each session keeps its browser next to it.
 */
export function splitPane(
  state: PaneState,
  target: string,
  dir: PaneDir,
  input: Omit<PaneLeaf, "kind" | "id">,
  options: { readonly before?: boolean; readonly share?: number } = {},
): { readonly state: PaneState; readonly id?: string; readonly refused?: SplitRefusal } {
  if (!findLeaf(state, target)) return { state, refused: "missing" }
  if (leavesOf(state.tree).length >= MAX_LEAVES) return { state, refused: "limit" }
  return insertLeaf(state, target, dir, { kind: "leaf", id: nextID(state.tree), ...input }, options)
}

/**
 * Moves a pane (its bar dragged onto another pane, 03 §4.1.1): onto an edge, it leaves its place and goes beside
 * `target` that way; onto the middle, the two panes trade places. The tree's shape rules still hold (refused otherwise).
 */
export function movePane(
  state: PaneState,
  id: string,
  target: string,
  place: { readonly dir: PaneDir; readonly before: boolean } | "swap",
): { readonly state: PaneState; readonly refused?: SplitRefusal } {
  const moving = findLeaf(state, id)
  const other = findLeaf(state, target)
  if (!moving || !other || id === target) return { state, refused: "missing" }
  if (place === "swap")
    return {
      state: {
        ...state,
        tree: mapLeaves(state.tree, (leaf) => (leaf.id === id ? other : leaf.id === target ? moving : leaf)),
      },
    }
  const removed = removeLeaf(state.tree, id)
  if (!removed) return { state, refused: "missing" }
  const result = insertLeaf({ ...state, tree: normalize(removed) }, target, place.dir, moving, {
    before: place.before,
  })
  return result.refused ? { state, refused: result.refused } : { state: { ...result.state, focused: id } }
}

function insertLeaf(
  state: PaneState,
  target: string,
  dir: PaneDir,
  leaf: PaneLeaf,
  options: { readonly before?: boolean; readonly share?: number },
): { readonly state: PaneState; readonly id?: string; readonly refused?: SplitRefusal } {
  const targetLeaf = findLeaf(state, target)
  if (!targetLeaf) return { state, refused: "missing" }
  const id = leaf.id
  const share = clamp(options.share ?? 0.5, MIN_FRACTION, 1 - MIN_FRACTION)
  // The browser pane beside a chat pane, when a new chat pane is placed (not when the browser itself is opened).
  const partner = targetLeaf.view === "chat" && leaf.view === "chat" ? browserOf(state, target)?.id : undefined
  const wrap = (node: PaneNode): PaneSplit => ({
    kind: "split",
    dir,
    sizes: options.before ? [share, 1 - share] : [1 - share, share],
    children: options.before ? [leaf, node] : [node, leaf],
  })
  const insert = (node: PaneNode, depth: number): PaneNode | SplitRefusal | undefined => {
    if (node.kind === "leaf") {
      if (node.id !== target) return undefined
      return depth >= MAX_DEPTH ? "depth" : wrap(node)
    }
    const ids = node.children.map((child) => (child.kind === "leaf" ? child.id : undefined))
    const group = !!partner && node.children.length === 2 && ids.includes(target) && ids.includes(partner)
    // The pair split the other way: the new pane goes beside the whole pair (only the root pair has room for it).
    if (group && node.dir !== dir && depth === 0) return wrap(node)
    // A pair one level down, split the other way: the new pane goes beside it in this split.
    const pairIndex = node.children.findIndex(
      (child) =>
        !!partner &&
        child.kind === "split" &&
        child.children.length === 2 &&
        child.children.every((item) => item.kind === "leaf" && (item.id === target || item.id === partner)),
    )
    if (pairIndex >= 0 && node.dir === dir) {
      const size = node.sizes[pairIndex] ?? 0
      const at = options.before ? pairIndex : pairIndex + 1
      const sizes = [...node.sizes]
      sizes[pairIndex] = size * (1 - share)
      sizes.splice(at, 0, size * share)
      const children = [...node.children]
      children.splice(at, 0, leaf)
      return { ...node, children, sizes }
    }
    const index = ids.indexOf(target)
    if (index >= 0 && node.dir === dir) {
      const partnerIndex = partner ? ids.indexOf(partner) : -1
      const members = partnerIndex === index + 1 || partnerIndex === index - 1 ? [index, partnerIndex] : [index]
      const first = Math.min(...members)
      const last = Math.max(...members)
      const at = options.before ? first : last + 1
      const taken = members.reduce((sum, member) => sum + (node.sizes[member] ?? 0) * share, 0)
      const sizes = node.sizes.map((size, member) => (members.includes(member) ? size * (1 - share) : size))
      const children = [...node.children]
      children.splice(at, 0, leaf)
      sizes.splice(at, 0, taken)
      return { ...node, children, sizes }
    }
    for (const [position, child] of node.children.entries()) {
      const next = insert(child, depth + 1)
      if (next === undefined) continue
      if (typeof next === "string") return next
      const children = [...node.children]
      children[position] = next
      return { ...node, children }
    }
    return undefined
  }
  const tree = insert(state.tree, 0)
  if (tree === undefined) return { state, refused: "missing" }
  if (typeof tree === "string") return { state, refused: tree }
  return { state: { ...state, tree: normalize(tree) }, id }
}

/**
 * Closes a leaf: its space goes to the neighbour, single-child splits collapse, and the browser and notes panes that
 * follow a closed chat pane close with it. The last chat pane stays (closing it does nothing).
 */
export function closePane(state: PaneState, id: string): PaneState {
  const leaves = leavesOf(state.tree)
  const leaf = leaves.find((item) => item.id === id)
  if (!leaf) return state
  const chats = leaves.filter((item) => item.view === "chat")
  if (leaf.view === "chat" && chats.length <= 1) return state
  const closing = new Set([
    id,
    ...(leaf.view === "chat"
      ? leaves.filter((item) => item.follows === id && !item.pinned).map((item) => item.id)
      : []),
  ])
  // Who inherits the focus: the neighbour that receives the space (its chat pane), else the first chat pane.
  const heir = neighbourOf(state.tree, id)
  const removed = [...closing].reduce<PaneNode | undefined>((node, gone) => node && removeLeaf(node, gone), state.tree)
  if (!removed) return state
  const tree = normalize(removed)
  const rest = leavesOf(tree)
  const next = { ...state, tree }
  if (!closing.has(state.focused)) return next
  const candidate = heir && rest.find((item) => item.id === heir) ? heir : rest[0]?.id
  const focus = candidate ? chatOf(next, candidate)?.id : undefined
  return { ...next, focused: focus ?? rest[0]!.id }
}

/** Opens the focused chat pane's browser beside it, or closes it (Ctrl+Shift+B, the 브라우저 button). */
export function toggleBrowser(state: PaneState, chatID: string) {
  const open = browserOf(state, chatID)
  if (open) return { state: closePane(state, open.id) }
  return ensureBrowser(state, chatID)
}

/** The chat pane's browser pane, opened beside it when there is none (the agent started using the browser). */
export function ensureBrowser(
  state: PaneState,
  chatID: string,
): { readonly state: PaneState; readonly id?: string; readonly refused?: SplitRefusal } {
  const open = browserOf(state, chatID)
  if (open) return { state, id: open.id }
  return splitPane(state, chatID, "row", { view: "browser", follows: chatID }, { share: 0.45 })
}

/** Browser pane: stay on the session it shows now, or follow its chat pane again. */
export function pinBrowser(state: PaneState, id: string, pinned: boolean): PaneState {
  const leaf = findLeaf(state, id)
  if (!leaf || leaf.view !== "browser") return state
  const target = browserTarget(state, leaf)
  if (pinned && !target) return state
  return {
    ...state,
    tree: mapLeaves(state.tree, (item) => {
      if (item.id !== id) return item
      if (pinned) return { ...item, pinned: target }
      const chat = chatOf(state, item.follows ?? "") ?? focusedChat(state)
      return { kind: "leaf", id: item.id, view: "browser", follows: chat?.id }
    }),
  }
}

/** New sizes of the split at `path` (child indices from the root), clamped and normalized. */
export function resizeSplit(state: PaneState, path: readonly number[], sizes: readonly number[]): PaneState {
  const apply = (node: PaneNode, depth: number): PaneNode => {
    if (node.kind === "leaf") return node
    if (depth === path.length) {
      if (sizes.length !== node.children.length) return node
      return { ...node, sizes: normalizeSizes(sizes) }
    }
    const index = path[depth]!
    const child = node.children[index]
    if (!child) return node
    const children = [...node.children]
    children[index] = apply(child, depth + 1)
    return { ...node, children }
  }
  return { ...state, tree: apply(state.tree, 0) }
}

/** Moves the boundary between children `index` and `index + 1` of the split at `path` by `delta` (a fraction). */
export function moveDivider(state: PaneState, path: readonly number[], index: number, delta: number): PaneState {
  const split = nodeAt(state.tree, path)
  if (!split || split.kind !== "split") return state
  const sizes = [...split.sizes]
  const a = sizes[index]
  const b = sizes[index + 1]
  if (a === undefined || b === undefined) return state
  const moved = clamp(delta, MIN_FRACTION - a, b - MIN_FRACTION)
  sizes[index] = a + moved
  sizes[index + 1] = b - moved
  return resizeSplit(state, path, sizes)
}

export function nodeAt(node: PaneNode, path: readonly number[]): PaneNode | undefined {
  return path.reduce<PaneNode | undefined>(
    (current, index) => (current?.kind === "split" ? current.children[index] : undefined),
    node,
  )
}

/** Width the tree needs: rows add up, columns take the widest child. Views `shown` filters out count as absent. */
export function minWidth(node: PaneNode, shown: (view: PaneView) => boolean = () => true): number {
  if (node.kind === "leaf") return shown(node.view) ? PANE_MIN[node.view] : 0
  const widths = node.children.map((child) => minWidth(child, shown))
  return node.dir === "row" ? widths.reduce((sum, width) => sum + width, 0) : Math.max(0, ...widths)
}

/** Height the tree needs (columns add up). */
export function minHeight(node: PaneNode, shown: (view: PaneView) => boolean = () => true): number {
  if (node.kind === "leaf") return shown(node.view) ? PANE_MIN_HEIGHT : 0
  const heights = node.children.map((child) => minHeight(child, shown))
  return node.dir === "column" ? heights.reduce((sum, height) => sum + height, 0) : Math.max(0, ...heights)
}

/** The tree without the leaves `shown` rejects (a web window drops browser panes), normalized. */
export function visibleTree(node: PaneNode, shown: (view: PaneView) => boolean): PaneNode | undefined {
  if (node.kind === "leaf") return shown(node.view) ? node : undefined
  const kept = node.children.flatMap((child, index) => {
    const next = visibleTree(child, shown)
    return next ? [{ node: next, size: node.sizes[index] ?? 0 }] : []
  })
  if (!kept.length) return undefined
  return normalize({
    ...node,
    children: kept.map((item) => item.node),
    sizes: normalizeSizes(kept.map((item) => item.size)),
  })
}

export interface PaneRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DividerRect extends PaneRect {
  /** Path of the split the divider belongs to and the child before it. */
  readonly path: readonly number[]
  readonly index: number
  readonly dir: PaneDir
  /** The split's own size along `dir`, as a fraction of the pane area (dragging converts pixels with it). */
  readonly extent: number
}

/** Each leaf's rectangle and each divider's line, as fractions of the pane area (flat layout, no re-parenting). */
export function layoutRects(node: PaneNode) {
  const leaves = new Map<string, PaneRect>()
  const dividers: DividerRect[] = []
  const walk = (current: PaneNode, rect: PaneRect, path: readonly number[]) => {
    if (current.kind === "leaf") return void leaves.set(current.id, rect)
    let offset = 0
    current.children.forEach((child, index) => {
      const size = current.sizes[index] ?? 1 / current.children.length
      const part =
        current.dir === "row"
          ? { x: rect.x + rect.width * offset, y: rect.y, width: rect.width * size, height: rect.height }
          : { x: rect.x, y: rect.y + rect.height * offset, width: rect.width, height: rect.height * size }
      walk(child, part, [...path, index])
      offset += size
      if (index < current.children.length - 1)
        dividers.push(
          current.dir === "row"
            ? {
                x: part.x + part.width,
                y: rect.y,
                width: 0,
                height: rect.height,
                path,
                index,
                dir: "row",
                extent: rect.width,
              }
            : {
                x: rect.x,
                y: part.y + part.height,
                width: rect.width,
                height: 0,
                path,
                index,
                dir: "column",
                extent: rect.height,
              },
        )
    })
  }
  walk(node, { x: 0, y: 0, width: 1, height: 1 }, [])
  return { leaves, dividers }
}

/** Collapses single-child splits and folds a child split that runs the same way into its parent. */
export function normalize(node: PaneNode): PaneNode {
  if (node.kind === "leaf") return node
  const parts = node.children.flatMap((child, index) => {
    const size = node.sizes[index] ?? 1 / node.children.length
    const next = normalize(child)
    if (next.kind === "split" && next.dir === node.dir)
      return next.children.map((grand, at) => ({ node: grand, size: size * (next.sizes[at] ?? 0) }))
    return [{ node: next, size }]
  })
  if (parts.length === 1) return parts[0]!.node
  return {
    kind: "split",
    dir: node.dir,
    sizes: normalizeSizes(parts.map((part) => part.size)),
    children: parts.map((part) => part.node),
  }
}

/** A stored state, checked like `load()` elsewhere: anything unexpected gives `undefined` (start fresh). */
export function parsePanes(value: unknown): PaneState | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as { tree?: unknown; focused?: unknown; mode?: unknown }
  const ids = new Set<string>()
  const tree = parseNode(raw.tree, 0, ids)
  if (!tree) return undefined
  const leaves = leavesOf(tree)
  if (leaves.length > MAX_LEAVES || !leaves.some((leaf) => leaf.view === "chat")) return undefined
  const chats = new Set(leaves.filter((leaf) => leaf.view === "chat").map((leaf) => leaf.id))
  // Followers of a pane that is gone follow the first chat pane.
  const first = [...chats][0]
  const fixed = normalize(
    mapLeaves(tree, (leaf) =>
      leaf.view !== "chat" && !leaf.pinned && (!leaf.follows || !chats.has(leaf.follows))
        ? { ...leaf, follows: first }
        : leaf,
    ),
  )
  const focused = typeof raw.focused === "string" && ids.has(raw.focused) ? raw.focused : first!
  const mode = raw.mode === "split" || raw.mode === "tabs" ? raw.mode : undefined
  return { tree: fixed, focused, ...(mode ? { mode } : {}) }
}

function parseNode(value: unknown, depth: number, ids: Set<string>): PaneNode | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  if (raw.kind === "leaf") {
    const id = raw.id
    const view = raw.view
    if (typeof id !== "string" || !/^p\d{1,4}$/.test(id) || ids.has(id)) return undefined
    if (view !== "chat" && view !== "browser" && view !== "notes") return undefined
    ids.add(id)
    if (view === "chat") return { kind: "leaf", id, view, route: parseRoute(raw.route) ?? { name: "home" } }
    const pinned = view === "browser" ? parseSession(raw.pinned) : undefined
    return {
      kind: "leaf",
      id,
      view,
      ...(typeof raw.follows === "string" ? { follows: raw.follows } : {}),
      ...(pinned ? { pinned } : {}),
    }
  }
  if (raw.kind !== "split" || depth >= MAX_DEPTH) return undefined
  if (raw.dir !== "row" && raw.dir !== "column") return undefined
  if (!Array.isArray(raw.children) || !Array.isArray(raw.sizes) || raw.children.length < 2) return undefined
  if (raw.sizes.length !== raw.children.length) return undefined
  if (!raw.sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)) return undefined
  const children: PaneNode[] = []
  for (const child of raw.children) {
    const node = parseNode(child, depth + 1, ids)
    if (!node) return undefined
    children.push(node)
  }
  return { kind: "split", dir: raw.dir, sizes: normalizeSizes(raw.sizes as number[]), children }
}

function parseRoute(value: unknown): PaneRoute | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  if (raw.name === "home")
    return typeof raw.serverKey === "string" && raw.serverKey
      ? { name: "home", serverKey: raw.serverKey }
      : { name: "home" }
  if (raw.name === "project" && typeof raw.serverKey === "string" && typeof raw.projectID === "string")
    return { name: "project", serverKey: raw.serverKey, projectID: raw.projectID }
  const session = raw.name === "session" ? parseSession(raw) : undefined
  return session ? { name: "session", ...session } : undefined
}

function parseSession(value: unknown): PaneSession | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  return typeof raw.serverKey === "string" && typeof raw.sessionID === "string" && raw.sessionID
    ? { serverKey: raw.serverKey, sessionID: raw.sessionID }
    : undefined
}

function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === "leaf") return fn(node)
  return { ...node, children: node.children.map((child) => mapLeaves(child, fn)) }
}

function removeLeaf(node: PaneNode, id: string): PaneNode | undefined {
  if (node.kind === "leaf") return node.id === id ? undefined : node
  const index = node.children.findIndex((child) => child.kind === "leaf" && child.id === id)
  if (index >= 0) {
    const sizes = [...node.sizes]
    const freed = sizes[index] ?? 0
    // The neighbour before it gets the space (after it for the first child).
    const heir = index > 0 ? index - 1 : 1
    if (sizes[heir] !== undefined) sizes[heir] = sizes[heir]! + freed
    sizes.splice(index, 1)
    const children = node.children.filter((_, at) => at !== index)
    if (!children.length) return undefined
    return { ...node, children, sizes }
  }
  const children = node.children.map((child) => removeLeaf(child, id))
  const kept = children.flatMap((child, at) => (child ? [{ child, size: node.sizes[at] ?? 0 }] : []))
  if (!kept.length) return undefined
  return { ...node, children: kept.map((item) => item.child), sizes: normalizeSizes(kept.map((item) => item.size)) }
}

/** The leaf that receives a closing leaf's space (first leaf of the neighbour subtree). */
function neighbourOf(node: PaneNode, id: string): string | undefined {
  if (node.kind === "leaf") return undefined
  const index = node.children.findIndex((child) => child.kind === "leaf" && child.id === id)
  if (index >= 0) {
    const heir = node.children[index > 0 ? index - 1 : 1]
    return heir ? leavesOf(heir)[0]?.id : undefined
  }
  for (const child of node.children) {
    const found = neighbourOf(child, id)
    if (found) return found
  }
  return undefined
}

function nextID(node: PaneNode) {
  const used = leavesOf(node).map((leaf) => Number(leaf.id.slice(1)))
  return `p${Math.max(0, ...used) + 1}`
}

function normalizeSizes(sizes: readonly number[]) {
  const clamped = sizes.map((size) => (Number.isFinite(size) ? Math.max(MIN_FRACTION, size) : MIN_FRACTION))
  const total = clamped.reduce((sum, size) => sum + size, 0)
  return clamped.map((size) => size / total)
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

const DEFAULT_KEY = "own.web.panes.default"

/**
 * The window's panes and the device's default mode, saved while the window lives (writes coalesced; pagehide
 * flushes). Storage failures fall back to one chat pane and `나란히`.
 */
export function createPaneLayout(windowKey: string) {
  const key = `own.web.panes.${windowKey}`
  const [state, setState] = createSignal<PaneState>(load(key) ?? initialPanes())
  const [device, setDevice] = createSignal<PaneMode>(loadDefault())
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  const flush = () => {
    clearTimeout(timer)
    if (!dirty) return
    dirty = false
    try {
      localStorage.setItem(key, JSON.stringify(state()))
    } catch {}
  }
  window.addEventListener("pagehide", flush)
  onCleanup(() => {
    flush()
    window.removeEventListener("pagehide", flush)
  })
  const update = (fn: (current: PaneState) => PaneState) => {
    const next = fn(state())
    if (next === state()) return
    setState(next)
    dirty = true
    clearTimeout(timer)
    timer = setTimeout(flush, 300)
  }
  return {
    state,
    /** The saved mode of this window (or the device default). Narrow widths may still show tabs (context.tsx). */
    mode: () => state().mode ?? device(),
    deviceMode: device,
    update,
    /** Quick switch (tab strip button, palette): this window only. */
    setWindowMode: (mode: PaneMode) => update((current) => ({ ...current, mode })),
    /** 설정 > 레이아웃: the device default; this window follows it again. */
    setDeviceMode(mode: PaneMode) {
      setDevice(mode)
      try {
        localStorage.setItem(DEFAULT_KEY, mode)
      } catch {}
      update((current) => (current.mode === undefined ? current : { tree: current.tree, focused: current.focused }))
    },
    flush,
  }
}

export type PaneLayoutStore = ReturnType<typeof createPaneLayout>

function load(key: string) {
  try {
    return parsePanes(JSON.parse(localStorage.getItem(key) ?? "null"))
  } catch {
    return undefined
  }
}

function loadDefault(): PaneMode {
  try {
    return localStorage.getItem(DEFAULT_KEY) === "tabs" ? "tabs" : "split"
  } catch {
    return "split"
  }
}
