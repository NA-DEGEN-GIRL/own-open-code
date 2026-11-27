// 팀 룸 tab of the work panel (06 §9.9, 2026-11-27), its own lazy chunk; three.js and the scene (./scene.ts) load only
// once the tab shows. On a conversation of a team (its main, an owner or a peer) it seats one character per area that
// is not finished, labelled `별칭 · 영역` (the area alone where the room is narrow), acting out the area's state
// (./model.ts). A click on a character or its label opens the owner conversation. The scene runs only while the tab
// shows, the window has focus and the page is visible; reduced motion draws still poses. Without WebGL, or after a
// lost context, the same labels show as a list.
import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useRouter } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import { roomSeats, type Seat, type SeatState } from "./model"
import type { Room } from "./scene"
import { roomText, type RoomKey } from "./strings"

const STATE_KEY: Readonly<Record<SeatState, RoomKey>> = {
  working: "own.team.room.state.working",
  idle: "own.team.room.state.idle",
  sleeping: "own.team.room.state.sleeping",
  waiting: "own.team.room.state.waiting",
  error: "own.team.room.state.error",
}

/** The mark above a head: `?` for the user's turn, `z` for a doze, `!` for a problem. */
const MARK: Readonly<Partial<Record<SeatState, string>>> = { waiting: "?", sleeping: "z", error: "!" }

export default function TeamRoomTab(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly visible: () => boolean
}) {
  const data = useData()
  const router = useRouter()
  const text = roomText.use()
  const runtime = () => data.get(props.serverKey())
  untrack(() => runtime()?.team.ensure())
  const entry = createMemo(() => {
    const current = runtime()
    const sessionID = props.sessionID()
    const place = sessionID ? current?.team.placeOf(sessionID) : undefined
    return place ? current?.team.team(place.teamID) : undefined
  })
  // Frozen while hidden, like the other tabs: a hidden room is off the minute timer.
  const now = createMemo<number>((last) => (props.visible() ? minuteNow() : last), Date.now())
  const seats = createMemo<Seat[]>(() => {
    const current = runtime()
    const team = entry()
    if (!current || !team) return []
    const session = current.data.session
    const waits = (sessionID: string) =>
      (session.permission.list(sessionID)?.length ?? 0) > 0 || (session.form.list(sessionID)?.length ?? 0) > 0
    return roomSeats({
      entry: team,
      running: (sessionID) => session.status(sessionID) === "running",
      asking: (sessionID) => session.family(sessionID).some(waits),
      now: now(),
    })
  })
  const reduced = createMediaQuery("(prefers-reduced-motion: reduce)")
  const [focused, setFocused] = createSignal(document.hasFocus())
  const [shown, setShown] = createSignal(document.visibilityState === "visible")
  const active = () => props.visible() && focused() && shown()
  /** `3d` while the scene draws; `flat` without WebGL; `lost` after the context was lost (a retry draws again). */
  const [mode, setMode] = createSignal<"3d" | "flat" | "lost">("3d")
  const [room, setRoom] = createSignal<Room>()
  const [anchors, setAnchors] = createSignal<ReadonlyMap<string, { readonly x: number; readonly y: number }>>(new Map())
  const [frames, setFrames] = createSignal(0)
  const [count, setCount] = createSignal(0)
  /** The tab has shown once: the scene's chunk is not fetched for a tab that never shows. */
  const [seen, setSeen] = createSignal(false)
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement>()
  const [box, setBox] = createSignal<HTMLDivElement>()

  const onFocus = () => setFocused(true)
  const onBlur = () => setFocused(false)
  const onVisibility = () => setShown(document.visibilityState === "visible")
  window.addEventListener("focus", onFocus)
  window.addEventListener("blur", onBlur)
  document.addEventListener("visibilitychange", onVisibility)
  onCleanup(() => {
    window.removeEventListener("focus", onFocus)
    window.removeEventListener("blur", onBlur)
    document.removeEventListener("visibilitychange", onVisibility)
  })
  createEffect(() => props.visible() && setSeen(true))

  // The scene loads on the canvas once the tab has shown and goes with it: `다시 그리기` after a lost context shows a
  // new canvas, which gets a new scene.
  createEffect(() => {
    const target = canvas()
    if (!target || !seen() || mode() !== "3d") return
    const still = untrack(reduced)
    const own: { made?: Room; gone: boolean } = { gone: false }
    void import("./scene").then((scene) => {
      if (own.gone) return
      own.made = build(() =>
        scene.createRoom(target, {
          reducedMotion: still,
          onLost: () => setMode("lost"),
          onFrame: setFrames,
        }),
      )
      if (!own.made) return setMode("flat")
      setRoom(own.made)
    }, report)
    onCleanup(() => {
      own.gone = true
      own.made?.dispose()
      setRoom(undefined)
    })
  })

  /** The label size the room was last framed for: a label that turns out larger or smaller frames the room again. */
  const framed = { width: 0, height: 0 }
  const place = (current: Room, element: HTMLDivElement) => {
    const label = labelSize(element)
    framed.width = label.width
    framed.height = label.height
    current.resize({ width: element.clientWidth, height: element.clientHeight }, label)
    setAnchors(current.anchors())
  }
  createEffect(() => {
    const current = room()
    const element = box()
    if (!current || !element) return
    place(current, element)
    // Framed in the next frame, not inside the observer's callback: moving the labels there can make the browser report
    // a ResizeObserver loop.
    const pending = { frame: 0 }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(pending.frame)
      pending.frame = requestAnimationFrame(() => place(current, element))
    })
    observer.observe(element)
    onCleanup(() => {
      observer.disconnect()
      cancelAnimationFrame(pending.frame)
    })
  })
  createEffect(() => {
    const current = room()
    if (!current) return
    current.update(seats())
    setCount(current.count())
    setAnchors(current.anchors())
  })
  // Labels show once the room has anchors; the first framing guessed their size, so it is measured and framed again.
  createEffect(() => {
    anchors()
    const current = room()
    const element = box()
    if (!current || !element) return
    const label = labelSize(element)
    if (Math.abs(label.width - framed.width) > 1 || Math.abs(label.height - framed.height) > 1) place(current, element)
  })
  createEffect(() => room()?.setActive(active()))

  const open = (seat: Seat) => {
    if (seat.sessionID) router.navigate({ name: "session", serverKey: props.serverKey(), sessionID: seat.sessionID })
  }
  const pick = (event: MouseEvent) => {
    const current = room()
    const target = canvas()
    if (!current || !target) return
    const rect = target.getBoundingClientRect()
    const areaID = current.pick(event.clientX - rect.left, event.clientY - rect.top)
    const seat = seats().find((item) => item.areaID === areaID)
    if (seat) open(seat)
  }
  const title = (seat: Seat) =>
    seat.sessionID
      ? text("own.team.room.open", { label: seat.label })
      : text("own.team.room.noOwner", { label: seat.label })

  return (
    <section
      class="@container relative flex h-full min-h-0 flex-col bg-own-bg"
      aria-label={text("own.team.room.label", { n: seats().length })}
      data-testid="team-room"
      data-mode={mode()}
      data-run={room() ? (reduced() ? "still" : active() ? "running" : "paused") : "none"}
      data-frames={frames()}
      data-characters={room() ? count() : 0}
    >
      <Show when={entry()} fallback={<p class="own-placeholder">{text("own.team.room.loading")}</p>}>
        <Show when={seats().length > 0} fallback={<p class="own-placeholder">{text("own.team.room.empty")}</p>}>
          <Show
            when={mode() === "3d"}
            fallback={
              <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                <p class="m-0 text-[12px] text-own-muted" role="status">
                  {text(mode() === "lost" ? "own.team.room.lost" : "own.team.room.flat")}
                </p>
                <Show when={mode() === "lost"}>
                  <button
                    type="button"
                    class="self-start rounded-md border border-own-border px-2 py-0.5 text-[12.5px] hover:bg-own-hover"
                    data-testid="team-room-retry"
                    onClick={() => setMode("3d")}
                  >
                    {text("own.team.room.retry")}
                  </button>
                </Show>
                <ul class="m-0 flex list-none flex-col gap-1 p-0" data-testid="team-room-list">
                  <For each={seats()}>
                    {(seat) => (
                      <li>
                        <button
                          type="button"
                          class="flex w-full items-center gap-2 rounded-md border border-own-border bg-own-raised px-2.5 py-1.5 text-left text-[13px] text-own-text hover:bg-own-hover disabled:opacity-70"
                          disabled={!seat.sessionID}
                          title={title(seat)}
                          data-testid="team-room-seat"
                          data-area-id={seat.areaID}
                          data-state={seat.state}
                          onClick={() => open(seat)}
                        >
                          <span class="min-w-0 flex-1 truncate">{seat.label}</span>
                          <span class="flex-none text-[11.5px]" classList={stateTone(seat.state)}>
                            {text(STATE_KEY[seat.state])}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            }
          >
            <div ref={setBox} class="relative min-h-0 flex-1 overflow-hidden">
              <canvas
                ref={(element) => {
                  setCanvas(element)
                  onCleanup(() => setCanvas(undefined))
                }}
                class="absolute inset-0 block h-full w-full cursor-pointer touch-manipulation"
                aria-hidden="true"
                data-testid="team-room-canvas"
                onClick={pick}
              />
              <For each={seats()}>
                {(seat) => (
                  <Show when={anchors().get(seat.areaID)}>
                    {(at) => (
                      <button
                        type="button"
                        class="absolute flex w-max max-w-[45%] -translate-x-1/2 -translate-y-full flex-col items-center rounded-md border border-own-border bg-own-raised px-1.5 py-0.5 text-center leading-tight text-own-text shadow-[var(--own-shadow-float)] hover:bg-own-hover disabled:cursor-default"
                        style={{ left: `${at().x}px`, top: `${at().y}px` }}
                        disabled={!seat.sessionID}
                        title={title(seat)}
                        aria-label={`${title(seat)} · ${text(STATE_KEY[seat.state])}`}
                        data-testid="team-room-seat"
                        data-area-id={seat.areaID}
                        data-state={seat.state}
                        onClick={() => open(seat)}
                      >
                        <Show when={MARK[seat.state]}>
                          {(mark) => (
                            <span
                              class="absolute -top-2 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full border border-own-border bg-own-raised px-1 text-[10.5px] font-semibold"
                              classList={stateTone(seat.state)}
                              data-testid="team-room-mark"
                            >
                              {mark()}
                            </span>
                          )}
                        </Show>
                        <Show when={seat.alias}>
                          <span
                            class="max-w-full truncate text-[12px] font-semibold @max-[20rem]:hidden"
                            data-testid="team-room-alias"
                          >
                            {seat.alias}
                          </span>
                        </Show>
                        <span
                          class="max-w-full truncate text-[11px]"
                          classList={{ "text-own-muted": !!seat.alias, "@max-[20rem]:text-own-text": !!seat.alias }}
                          data-testid="team-room-name"
                        >
                          {seat.name}
                        </span>
                      </button>
                    )}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </section>
  )
}

/** The largest label in the room (CSS pixels), or a two-line guess before any label shows. */
function labelSize(element: HTMLElement) {
  const labels = [...element.querySelectorAll<HTMLElement>('[data-testid="team-room-seat"]')]
  if (labels.length === 0) return { width: 72, height: 36 }
  return {
    width: Math.max(...labels.map((label) => label.offsetWidth)),
    height: Math.max(...labels.map((label) => label.offsetHeight)),
  }
}

/** The scene, or `undefined` where WebGL 2 cannot start (three.js throws while it makes the context). */
function build(make: () => Room) {
  try {
    return make()
  } catch (error) {
    console.warn("[own-web] team room: no WebGL", error)
    return undefined
  }
}

/** The state word's tone: status feedback for a problem or the user's turn, muted otherwise. */
function stateTone(state: SeatState) {
  return {
    "text-own-danger": state === "error",
    "text-own-warn": state === "waiting",
    "text-own-muted": state !== "error" && state !== "waiting",
  }
}

function report(error: unknown) {
  console.error("[own-web] team room", error)
}
