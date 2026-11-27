// Which host 설정 > 원격 호스트 shows first (04 §17.5): set by the sidebar's `호스트 상태`, read by the lazy page.
import { createRoot, createSignal } from "solid-js"

const [selected, setSelected] = createRoot(() => createSignal<string>())

export const selectedHostPanel = selected

export function selectHostPanel(hostId: string | undefined) {
  setSelected(hostId)
}
