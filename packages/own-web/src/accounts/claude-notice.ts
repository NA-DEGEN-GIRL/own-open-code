// The Claude subscription risk notice (03 §5.4.1(a)), shown as information: the plugin ships with the app and is always
// on (02 §8.2, user decision 2026-10-18), so nothing is acknowledged. The remote-use notice below is
// `packages/own-accounts/src/plugins/notice.ts` REMOTE_TEXT (04 §8.11.12), still acknowledged per PC:
// `plugin.claudeAuth.remote.ack` only accepts the SHA-256 of that text in Korean or English (REMOTE_TEXT_EN), so the UI
// shows the lines of its language verbatim and hashes the same string. TODO(protocol): export REMOTE_TEXT/REMOTE_HASH from @own/protocol so the copies cannot drift.
import { Plugin } from "@own/protocol/plugin"
import type { Locale } from "@/i18n"

export const NOTICE_TITLE = "비공식/서드파티 플러그인 — 약관 위험"

export const NOTICE_ITEMS = [
  "1. Anthropic 약관은 서드파티 앱이 Claude 구독 로그인(OAuth)을 쓰는 것을 허용하지 않습니다. 계정이 제한되거나 정지될 수 있습니다.",
  "2. 이 플러그인은 요청을 Claude Code가 보낸 것처럼 표시합니다. own-open-code는 이 동작을 만들거나 수정하지 않습니다.",
  '3. Anthropic은 2026-04-04부터 Claude Code 밖(서드파티 도구)에서 쓰는 구독 사용을 구독 한도가 아니라 추가 사용량(종량제, 지금 이름은 사용량 크레딧)으로 청구한다고 알렸습니다. 추가 사용량이 꺼져 있거나 모자라면 요청이 거절됩니다. 이 앱은 요청마다 어느 쪽으로 청구됐는지 알 수 없어 이 슬롯의 비용을 "알 수 없음"으로 표시합니다. claude.ai › 설정 › 사용량에서 확인하세요.',
  "4. 구독 로그인 토큰은 OpenCode 데이터베이스에 평문으로 저장됩니다. 플러그인의 설계이며 own-open-code가 바꿀 수 없습니다.",
  "5. 토큰 갱신이 실패하면 플러그인이 Claude Code(claude -p, Haiku 모델)를 실행해 토큰을 새로 받습니다. 이 요청도 사용량에서 차감됩니다.",
  "6. 계정이 Claude Code의 로그인 폴더(%USERPROFILE%\\.claude, 또는 계정 소스로 정한 폴더)를 쓰면 이 앱은 그 로그인을 읽기만 하고 새로 고치지 않습니다. 그래서 Claude Code가 쉬고 있으면 토큰이 만료될 때마다(몇 시간마다) 멈춥니다. 이 앱 전용 로그인으로 바꾸면 이 앱이 직접 새로 고칩니다.",
  "7. own-open-code는 이 플러그인을 조금 고친 판(Claude Code 로그인 폴더 여러 개를 계정 여러 개로 쓰고, 대화마다 정한 계정으로만 요청을 보내며, 한 계정이 다른 계정의 토큰을 빌려 쓰지 않음)을 앱에 넣어 함께 배포하고 늘 켜 둡니다. Claude 계정을 연결하기 전에는 아무 요청도 보내지 않습니다.",
  "8. 한 PC에서 Claude 구독 계정 여러 개를 함께 쓰고 한도가 차면 다른 계정으로 자동으로 바꾸는 것은 Anthropic이 쉽게 알아챌 수 있고, 한도를 피하는 행위로 보여 약관 위반이 될 수 있습니다. 여러 계정이 함께 제한되거나 정지될 수 있습니다.",
  "9. 새로 추가하는 계정은 이 앱 전용 로그인 폴더를 쓰고, 그 로그인은 이 앱이 새로 고칩니다. Claude Code의 로그인 폴더를 함께 쓰면 갱신이 겹쳐 한쪽 로그인이 풀리기 때문입니다. 계정을 바꾸면 캐시는 처음부터 다시 쌓입니다.",
  "10. 공식적인 방법은 Anthropic API 키입니다.",
] as const

const NOTICE_ITEMS_EN = [
  "1. Anthropic's terms do not allow third-party apps to use a Claude subscription sign-in (OAuth). Your account may be limited or suspended.",
  "2. This plugin marks requests as if Claude Code had sent them. own-open-code neither created this behavior nor changes it.",
  "3. Anthropic announced that since 2026-04-04 subscription use outside Claude Code (third-party tools) is billed as extra usage (pay as you go, now called usage credits) instead of counting against the subscription's limits. If extra usage is off or runs out, requests are refused. This app cannot tell for a request how it was billed, so it shows the cost of this slot as \"unknown\". Check claude.ai > Settings > Usage.",
  "4. The subscription sign-in token is stored in plain text in the OpenCode database. That is how the plugin is designed, and own-open-code cannot change it.",
  "5. If a token refresh fails, the plugin runs Claude Code (claude -p, the Haiku model) to get a new token. That request counts against your usage too.",
  "6. While an account uses Claude Code's sign-in folder (%USERPROFILE%\\.claude, or the folder set as the account source), this app only reads that sign-in and does not refresh it. So while Claude Code is idle the account stops each time the token expires (every few hours). With a sign-in of this app's own, this app refreshes it itself.",
  "7. own-open-code ships a slightly changed version of this plugin inside the app and keeps it on: it uses several Claude Code sign-in folders as several accounts, sends requests only with the account chosen for the conversation, and no account borrows another one's token. It sends nothing until you connect a Claude account.",
  "8. Using several Claude subscription accounts on one PC and switching automatically when a limit is reached is easy for Anthropic to notice, looks like getting around the limits, and may break the terms. Several accounts may be limited or suspended together.",
  "9. Accounts you add use a sign-in folder of this app's own, and this app refreshes that sign-in: sharing Claude Code's sign-in folder makes refreshes collide and signs one side out. After switching accounts the cache is built up again from the start.",
  "10. The official way is an Anthropic API key.",
] as const

/** The risk notice in `locale`. */
export function riskNotice(locale: Locale) {
  if (locale === "ko") return { title: NOTICE_TITLE, items: NOTICE_ITEMS }
  return { title: "Unofficial, third-party plugin: terms risk", items: NOTICE_ITEMS_EN }
}

// The remote-use notice (04 §8.11.12), `REMOTE_TEXT` of the router's notice file, shown before the first
// `plugin.claudeAuth.remote.ack`.
export const REMOTE_NOTICE_TITLE = "SSH 원격 호스트에서 Claude 구독 쓰기 — 약관 위험이 더 커집니다"

export const REMOTE_NOTICE_ITEMS = [
  "1. 켠 호스트의 요청은 이 PC로 돌아와 이 PC의 Claude 로그인으로 Anthropic에 보내집니다. 로그인 토큰과 갱신 토큰은 호스트로 가지 않습니다.",
  "2. Anthropic 약관은 구독 로그인으로 다른 곳의 요청을 중계하는 것을 허용하지 않습니다. 원격 사용은 이 위험을 더 키웁니다.",
  "3. 이 PC가 켜져 있고 호스트와 연결되어 있어야 합니다. 응답 도중 연결이 끊기면 그 응답은 거기서 끝납니다.",
  "4. 그 호스트에서 own-open-code로 일하는 에이전트와 하위 에이전트가 이 구독을 씁니다. 이 PC의 사용과 같은 5시간·주간 한도를 함께 씁니다.",
  "5. 원격 요청이 로그인 거절이나 토큰 갱신을 일으킬 수 있습니다. 이 토큰은 Claude Code와 함께 쓰므로 다시 로그인해야 할 수 있습니다.",
  "6. 호스트마다 켜고 끌 수 있습니다. 끄면 진행 중인 응답도 멈춥니다.",
] as const

export const REMOTE_NOTICE_CHECK = "위 내용을 이해했으며, 본인 책임으로 사용합니다."

export const REMOTE_NOTICE_TEXT = [REMOTE_NOTICE_TITLE, ...REMOTE_NOTICE_ITEMS, REMOTE_NOTICE_CHECK].join("\n")

const REMOTE_NOTICE_EN = {
  title: "Using the Claude subscription on SSH remote hosts: the terms risk gets bigger",
  items: [
    "1. Requests of the hosts you turn on come back to this PC and go to Anthropic with this PC's Claude sign-in. The sign-in token and the refresh token never go to the host.",
    "2. Anthropic's terms do not allow relaying requests from elsewhere with a subscription sign-in. Remote use makes this risk bigger.",
    "3. This PC has to be on and connected to the host. If the connection drops during an answer, the answer ends there.",
    "4. Agents and subagents that work on that host with own-open-code use this subscription. They share the 5-hour and weekly limits with the use on this PC.",
    "5. Remote requests may lead to a refused sign-in or a token refresh. The token is shared with Claude Code, so you may have to sign in again.",
    "6. You can turn each host on and off. Turning it off also stops an answer in progress.",
  ],
  check: "I understand the above and use this at my own risk.",
} as const

/** The remote-use notice in `locale`, with the text whose hash a consent carries. */
export function remoteNotice(locale: Locale) {
  if (locale === "ko")
    return {
      title: REMOTE_NOTICE_TITLE,
      items: REMOTE_NOTICE_ITEMS,
      check: REMOTE_NOTICE_CHECK,
      text: REMOTE_NOTICE_TEXT,
    }
  const en = REMOTE_NOTICE_EN
  return { ...en, text: [en.title, ...en.items, en.check].join("\n") }
}

/**
 * Hex SHA-256 of the remote-use notice in `locale`, the `noticeHash` of `plugin.claudeAuth.remote.ack`. The Korean one
 * is the service's `REMOTE_HASH` (`plugin.claudeAuth.status.remote.noticeHash`).
 */
export async function remoteNoticeHash(locale: Locale = "ko") {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(remoteNotice(locale).text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The pinned claude-auth release the app bundles (`own/vendor/claude-auth/package-lock.json`, 02 §8.1), for a service
 * whose status has no `bundle` yet (before 2026-10-18). The remote consent names the bundle's pin; the router refuses a
 * mismatch (`ack_required{stale}`).
 */
export const CLAUDE_PIN = {
  package: Plugin.CLAUDE_AUTH_PACKAGE,
  version: "0.4.0-beta.5",
  integrity: "sha512-dVA2AY58JxrZP3QqetevB3yebwQLVoMGyBFrPbJPDdCgJ94UEzQpK9/5Jk0Ibeyeom5mWD/HInaJgfX9O5MljA==",
} as const
