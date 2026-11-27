// Browser tool policy strings (01 §10.1, 05 §8.7, §8.10.5, 03 §8 "브라우저 없음"). Kept here until the integrator
// appends them to src/i18n (section "policy"). 03 §14 keys (`own.browser.onlyDesktop`, `own.browser.notAttached`) come
// from the shared catalog. This catalog is in the first chunk (notice.tsx): the server popover's lines, which only that
// lazy popover reads, are in panel.ts (PF5).
import { catalogText, useCatalogText } from "@/projects/text"

export const policyKo = {
  "own.policy.browser.newWeb":
    "이 창에서 만드는 대화에는 브라우저 도구가 없어요. 브라우저 도구는 데스크톱 앱에서 만든 대화에서 쓸 수 있어요.",
  "own.policy.browser.openInDesktop": "브라우저 도구는 데스크톱 앱에서 이 대화를 열어야 동작해요.",
  // A paired device (05 §8.10.5): the PC's desktop app holds the browser, so the tools follow it, not this window.
  "own.policy.browser.needDesktop": "PC의 데스크톱 앱이 켜져 있어야 에이전트가 브라우저를 쓸 수 있어요.",
  "own.policy.browser.startedWithout": "이 대화는 브라우저 도구 없이 시작했어요.",
  // What follows it on a paired device: the conversation's browser view offers ‘이 대화에서 켜기’.
  "own.policy.browser.enableInViewer": "대화의 ⋯ > 브라우저에서 켤 수 있어요.",
  // What follows it on the desktop, the same words the browser pane uses (browser/enable.ts `reason`).
  "own.policy.browser.canEnable":
    "브라우저 칸의 ‘이 대화에서 켜기’로 여기서 켤 수 있어요. 대화 앞부분 캐시는 유지돼요.",
  "own.policy.browser.cannot.custom":
    "승인 모드가 ‘사용자 지정’이라 이 대화에서는 켤 수 없어요. 필요하면 새 대화를 만드세요.",
  "own.policy.browser.cannot.unsupported":
    "서비스 버전이 낮아 이 대화에서는 켤 수 없어요. 필요하면 새 대화를 만드세요.",
  "own.policy.browser.cannot.scope":
    "이 연결에는 대화 규칙을 바꿀 권한이 없어 켤 수 없어요. 필요하면 새 대화를 만드세요.",
  "own.policy.browser.cannot.unavailable": "서비스가 답하지 않아 지금은 켤 수 없어요. 다시 연결되면 켤 수 있어요.",
  "own.policy.browser.cannot.elsewhere":
    "이 창에서는 이 대화의 규칙을 바꿀 수 없어 켤 수 없어요. 필요하면 새 대화를 만드세요.",
  "own.policy.browser.cannot.blocked": "다른 규칙이 이 대화의 브라우저 도구를 막고 있어요.",
  "own.policy.browser.why":
    "도구 목록은 대화를 만들 때 정해지고 대화 도중에는 바뀌지 않아요(대화 앞부분 캐시를 지키려고).",
} as const satisfies Record<string, string>

export type PolicyKey = keyof typeof policyKo

export const policyEn: Partial<Record<PolicyKey, string>> = {
  "own.policy.browser.newWeb":
    "Sessions created in this window have no browser tool. Use a session created in the desktop app for the browser tool.",
  "own.policy.browser.openInDesktop": "The browser tool works only when this session is open in the desktop app.",
  "own.policy.browser.needDesktop": "The agent can use the browser only while the desktop app is running on the PC.",
  "own.policy.browser.startedWithout": "This session started without the browser tool.",
  "own.policy.browser.enableInViewer": "Turn it on from ⋯ > Browser in this session.",
  "own.policy.browser.canEnable":
    "Turn it on here with ‘Turn on for this session’ in the browser pane. The cached start of the session stays.",
  "own.policy.browser.cannot.custom":
    "The approval mode is ‘Custom’, so it cannot be turned on here. Create a new session if you need it.",
  "own.policy.browser.cannot.unsupported":
    "The service is too old to turn it on here. Create a new session if you need it.",
  "own.policy.browser.cannot.scope":
    "This connection may not change the session's rules, so it cannot be turned on. Create a new session if you need it.",
  "own.policy.browser.cannot.unavailable":
    "The service is not answering, so it cannot be turned on now. Try again once connected.",
  "own.policy.browser.cannot.elsewhere":
    "This window cannot change this session's rules, so it cannot be turned on. Create a new session if you need it.",
  "own.policy.browser.cannot.blocked": "Another rule keeps the browser tools off in this session.",
  "own.policy.browser.why":
    "A session's tool list is set when it is created and does not change mid-session (keeps the prompt cache).",
}

export const policyText = catalogText(policyKo, policyEn)

export function usePolicyText() {
  return useCatalogText(policyText)
}
