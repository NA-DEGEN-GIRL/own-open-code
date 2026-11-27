// One-shot trailing debounce for event-driven refreshes (03 §20.2 R3: side surfaces update at most a few times per
// second while a turn streams; R9: no periodic timers). `cancel` runs on cleanup.
export function debounce(run: () => void, ms: number) {
  const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const cancel = () => {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
  }
  const schedule = () => {
    cancel()
    state.timer = setTimeout(() => {
      state.timer = undefined
      run()
    }, ms)
  }
  return { schedule, cancel }
}
