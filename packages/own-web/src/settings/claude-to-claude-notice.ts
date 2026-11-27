// The one-time notice of CAG-5 (02 §8.8, 2026-10-31): the service turned a stored automatic switch between this PC's
// Claude accounts off once (every settings change since 2026-10-11 had stored `자동`), and the app says so once, with
// where to turn it back on. Shown by the first window that reads the policy; `policy.set{noticed}` keeps every other
// window and device from showing it again. Its own lazy chunk, loaded only while the notice is pending (PF5).
import type { OwnRpc } from "@/data/rpc"
import { storedLocale, type Locale } from "@/i18n"
import { showToast } from "@/switcher/toast"

/** 해요체, with the way back: 설정 > 전환 정책 > Claude 계정 사이. */
export const NOTICE: Readonly<Record<Locale, string>> = {
  ko: "Claude 계정 사이 자동 전환을 껐어요. 한도가 차도 다른 Claude 계정으로 저절로 옮기지 않아요. 다시 켜려면 설정 > 전환 정책 > Claude 계정 사이에서 '자동'을 고르세요.",
  en: "Automatic switching between Claude accounts is off now. A reached limit no longer moves a conversation to another Claude account by itself. To turn it on again, choose 'Auto' under Settings > Auto switching > Between Claude accounts.",
}

export async function notify(rpc: OwnRpc) {
  // Marked first: a window that cannot write it (a phone without `admin`) does not show it either, so it never repeats.
  const marked = await rpc.call("policy.set", { patch: { noticed: "claudeToClaudeOff" } }).then(
    () => true,
    () => false,
  )
  if (marked) showToast({ message: NOTICE[storedLocale()], duration: 20_000 })
}
