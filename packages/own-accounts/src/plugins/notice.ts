export * as Notice from "./notice.js"

import { Hash } from "@own/runtime"

/**
 * The remote-use notice (04 §8.11.12), shown before the first `plugin.claudeAuth.remote.ack` in the screen's language;
 * own-web copies both texts. The local risk notice (03 §5.4.1) is informational since the plugin ships with the app
 * (02 §8.4, user decision 2026-10-18), so it has no hash here: nothing acknowledges it.
 */
export const REMOTE_TEXT = [
  "SSH 원격 호스트에서 Claude 구독 쓰기 — 약관 위험이 더 커집니다",
  "1. 켠 호스트의 요청은 이 PC로 돌아와 이 PC의 Claude 로그인으로 Anthropic에 보내집니다. 로그인 토큰과 갱신 토큰은 호스트로 가지 않습니다.",
  "2. Anthropic 약관은 구독 로그인으로 다른 곳의 요청을 중계하는 것을 허용하지 않습니다. 원격 사용은 이 위험을 더 키웁니다.",
  "3. 이 PC가 켜져 있고 호스트와 연결되어 있어야 합니다. 응답 도중 연결이 끊기면 그 응답은 거기서 끝납니다.",
  "4. 그 호스트에서 own-open-code로 일하는 에이전트와 하위 에이전트가 이 구독을 씁니다. 이 PC의 사용과 같은 5시간·주간 한도를 함께 씁니다.",
  "5. 원격 요청이 로그인 거절이나 토큰 갱신을 일으킬 수 있습니다. 이 토큰은 Claude Code와 함께 쓰므로 다시 로그인해야 할 수 있습니다.",
  "6. 호스트마다 켜고 끌 수 있습니다. 끄면 진행 중인 응답도 멈춥니다.",
  "위 내용을 이해했으며, 본인 책임으로 사용합니다.",
].join("\n")

/** {@link REMOTE_TEXT} in English: what an English screen shows and consents to (2026-11-26). */
export const REMOTE_TEXT_EN = [
  "Using the Claude subscription on SSH remote hosts: the terms risk gets bigger",
  "1. Requests of the hosts you turn on come back to this PC and go to Anthropic with this PC's Claude sign-in. The sign-in token and the refresh token never go to the host.",
  "2. Anthropic's terms do not allow relaying requests from elsewhere with a subscription sign-in. Remote use makes this risk bigger.",
  "3. This PC has to be on and connected to the host. If the connection drops during an answer, the answer ends there.",
  "4. Agents and subagents that work on that host with own-open-code use this subscription. They share the 5-hour and weekly limits with the use on this PC.",
  "5. Remote requests may lead to a refused sign-in or a token refresh. The token is shared with Claude Code, so you may have to sign in again.",
  "6. You can turn each host on and off. Turning it off also stops an answer in progress.",
  "I understand the above and use this at my own risk.",
].join("\n")

/** Hex SHA-256 of {@link REMOTE_TEXT}: the hash `plugin.claudeAuth.status.remote` names. */
export const REMOTE_HASH = Hash.sha256(REMOTE_TEXT)

/** The `noticeHash` values of a valid `ack:claudeRemote`: either language's text, the one the user was shown. */
export const REMOTE_HASHES: ReadonlyArray<string> = [REMOTE_HASH, Hash.sha256(REMOTE_TEXT_EN)]
