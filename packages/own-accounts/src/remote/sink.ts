export * as Sink from "./sink.js"

import http from "node:http"
import type net from "node:net"
import { Broker } from "@own/protocol"

/**
 * The fail-closed sink (04 §8.6 step 5): a loopback listener of the remote service that reads and discards every
 * request body and answers `401`; WebSocket upgrades get the same 401. A request of an own slot without a credential
 * is redirected here, so neither an unauthenticated request nor a body that holds the conversation prefix ever reaches
 * a provider. Every answer carries `x-own-fail-closed: sink` (04 §8.11.4.6), so observers that do not know the sink's
 * address (own-telemetry) skip it too.
 *
 * SLM (2026-11-22): the request names why it came here (`x-own-fail-reason`, one of {@link Reason}, set by
 * own-accounts' `http.request` hook), and the answer is
 * `{"error":{"type":"own_broker_unavailable","code":<reason>,"message":<Korean line>}}`, so the conversation's error
 * card says what happened and what to do instead of the bare `own_broker_unavailable` it showed before. Only the
 * fixed line of a known code goes back, never anything of the request; an unknown or missing reason is `blocked`.
 */

/** The error type of every sink answer (own-web recognizes it, an older host answers it bare). */
export const TYPE = "own_broker_unavailable"

export const REASONS = {
  unavailable:
    "PC와 연결이 끊겨 이 모델을 부를 수 없어요. PC에서 앱이 켜져 있고 SSH 연결이 살아 있는지 확인한 뒤 다시 보내 주세요.",
  refused_account_not_remote:
    "이 계정은 이 SSH 서버에서 쓰지 않게 되어 있어요(계정의 원격 사용이 꺼져 있거나 이 호스트의 계정 범위 밖이에요). PC의 설정 > SSH 원격 호스트에서 범위를 바꾸거나 다른 모델을 고르세요.",
  refused_needs_reauth: "PC에서 이 계정에 다시 로그인해야 해요. PC의 계정 화면에서 [다시 로그인]을 누른 뒤 계속하세요.",
  refused_source_stale:
    "이전 앱이 로그인을 갱신하지 않았어요. 이전 앱에서 이 프로필을 한 번 실행하거나 PC의 계정 화면에서 [가져오기로 전환]을 누르세요.",
  refused_exhausted_blocked: "이 계정의 한도가 다 되어 PC가 이 요청을 막았어요. 다른 모델로 바꾸거나 한도가 풀린 뒤 계속하세요.",
  refused_rate_limited: "PC에 이 SSH 서버의 요청이 너무 많아 잠시 거절됐어요. 잠시 뒤 다시 보내 주세요.",
  refused_not_found: "PC에 이 계정이 없어요(지웠거나 바꿨어요). 다른 모델을 고르세요.",
  refused_vault_unavailable:
    "PC가 이 계정의 자격 증명을 읽지 못했어요. PC의 계정 화면에서 [연결 확인]을 누르거나 PC에서 앱을 다시 시작해 보세요.",
  blocked:
    "이 요청에 PC 계정의 자격 증명을 넣지 않아 보내지 않았어요. 이 폴더의 플러그인 신뢰 확인이 막았을 수 있어요(설정 > SSH 원격 호스트 > 프로젝트 설정).",
  claude_off: "PC에서 이 SSH 서버의 Claude 구독 사용이 꺼져 있어요. PC의 계정 화면 > Claude 구독 > SSH 원격 호스트에서 켜세요.",
  claude_host_scope: "이 SSH 서버의 계정 범위에 Claude 구독이 없어요. PC의 설정 > SSH 원격 호스트에서 범위를 바꾸세요.",
  claude_consent: "PC에서 SSH 원격 호스트의 Claude 구독 사용 동의가 필요해요. PC의 계정 화면 > Claude 구독에서 켜세요.",
  claude_not_ready:
    "PC의 Claude 구독이 아직 준비되지 않았어요(로그인이 만료됐거나 플러그인이 아직 뜨지 않았어요). PC의 계정 화면에서 로그인을 확인한 뒤 다시 보내 주세요.",
  claude_billing: "PC의 Anthropic 연결이 API 키라 SSH 서버에서 Claude 구독으로 쓰지 않아요.",
  claude_enabled: "PC에 연결되어 있지 않아 Claude 구독을 쓸 수 없어요. 연결이 돌아오면 다시 보내 주세요.",
  claude_conflict: "이 SSH 서버에 다른 Claude 로그인이나 claude-auth 플러그인이 있어 PC의 Claude 구독을 쓰지 않아요.",
  local_pc_old:
    "이 PC의 로컬 모델을 SSH 서버에서 쓰려면 PC 앱이 2.2.6-own.17 이상이어야 해요. PC 앱을 업데이트한 뒤 다시 보내 주세요.",
} as const

export type Reason = keyof typeof REASONS

function isReason(value: string | undefined): value is Reason {
  return value !== undefined && Object.hasOwn(REASONS, value)
}

/** The sink's answer body for a reason (an unknown one is `blocked`). */
export function body(reason: string | undefined) {
  const code = isReason(reason) ? reason : "blocked"
  return JSON.stringify({ error: { type: TYPE, code, message: REASONS[code] } })
}

export interface Sink {
  readonly url: string
  readonly wsURL: string
  /** Requests answered so far (tests, diagnostics). */
  hits(): number
  close(): Promise<void>
}

export async function start(): Promise<Sink> {
  let hits = 0
  const server = http.createServer((request, response) => {
    hits++
    const text = body(request.headers[Broker.FAIL_REASON_HEADER]?.toString())
    request.on("data", () => {})
    request.on("error", () => {})
    request.on("end", () => {
      response.writeHead(401, {
        "content-type": "application/json",
        connection: "close",
        [Broker.FAIL_CLOSED_HEADER]: "sink",
      })
      response.end(text)
    })
  })
  server.on("upgrade", (_request, socket: net.Socket) => {
    hits++
    socket.on("error", () => {})
    const text = body(undefined)
    socket.end(
      `HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\n${Broker.FAIL_CLOSED_HEADER}: sink\r\nconnection: close\r\n\r\n${text}`,
    )
  })
  server.on("clientError", (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject)
      resolve()
    })
  })
  server.unref()
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    wsURL: `ws://127.0.0.1:${port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
