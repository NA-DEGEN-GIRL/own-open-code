// Live check of own-accounts' DeepSeek web search request (src/websearch/deepseek.ts) against the real Search API
// through the local forwarder (`/deepseek/v1/tools/search`, the DPAPI-sealed DeepSeek key): the answer's JSON shape,
// how long a search takes, and what the results look like for English and Korean queries. Each query is one billed
// request ($0.75 per 1,000). Prints no credential and no page text: the shape (field names, types, lengths), the
// timing, and each result's host and a short title for a quality note.
//
//   bun script/live/deepseek-search.ts [--query "..."]...   (default: one English, one Korean, one 128-char Korean)
import os from "node:os"
import path from "node:path"
import { DeepSeekSearch } from "../../../own-accounts/src/websearch/deepseek.js"
import { startForwarder } from "./forwarder.js"

const args = process.argv.slice(2)
const given = args.flatMap((arg, at) => (arg === "--query" && args[at + 1] ? [args[at + 1]!] : []))
const LONG =
  "윈도우 11에서 Bun으로 만든 로컬 서버를 백그라운드 서비스로 띄울 때 환경 변수에 든 API 키가 에이전트 셸 도구의 자식 프로세스로 새지 않게 막는 방법과 권장 설정, 관련 보안 문서와 실제 사례를 함께 알려 주세요. 가능하면 2026년 기준으로 정리해 주세요"
const queries =
  given.length > 0 ? given : ["Bun 1.4 release notes zstd compression", "한국은행 기준금리 2026년 10월 결정", LONG]

const forwarder = startForwarder(path.join(os.tmpdir(), "own-live-deepseek-search.jsonl"))
try {
  for (const query of queries) {
    const body = DeepSeekSearch.body(query)
    const started = performance.now()
    const response = await fetch(`${forwarder.url}/deepseek/v1/tools/search`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    const seconds = Math.round(performance.now() - started) / 1000
    const json: unknown = response.ok ? JSON.parse(text) : undefined
    const raw = isRecord(json) && Array.isArray(json.results) ? json.results.filter(isRecord) : []
    const mapped = DeepSeekSearch.results(DeepSeekSearch.read(text) ?? [])
    const scores = raw.map((item) => item.rerank_score).filter((value) => typeof value === "number")
    console.log(
      JSON.stringify({
        query: {
          characters: Array.from(body.query).length,
          utf8Bytes: Buffer.byteLength(body.query),
          korean: /[가-힣]/.test(query),
        },
        status: response.status,
        seconds,
        topLevel: isRecord(json)
          ? Object.fromEntries(Object.entries(json).map(([key, value]) => [key, kind(value)]))
          : undefined,
        results: raw.length,
        mapped: mapped.length,
        fields: [...new Set(raw.flatMap((item) => Object.keys(item)))].map((key) => ({
          key,
          types: [...new Set(raw.map((item) => kind(item[key])))],
          lengths: raw
            .flatMap((item) => (typeof item[key] === "string" ? [(item[key] as string).length] : []))
            .join(","),
        })),
        rerank: {
          values: scores.join(","),
          sortedDescending: scores.every((score, at) => at === 0 || scores[at - 1]! >= score),
        },
        authority: raw.map((item) => item.authority).join(","),
        dates: raw
          .map((item) =>
            typeof item.date === "string"
              ? Number.isFinite(Date.parse(item.date))
              : item.date === null
                ? "null"
                : kind(item.date),
          )
          .join(","),
        datesSample: raw.flatMap((item) => (typeof item.date === "string" ? [item.date] : [])).slice(0, 2),
        pages: mapped.map(
          (result) => `${URL.parse(result.url)?.hostname ?? "?"} | ${(result.title ?? "").slice(0, 50)}`,
        ),
        summaryKorean: raw.filter((item) => typeof item.summary === "string" && /[가-힣]/.test(item.summary)).length,
        ...(response.ok ? {} : { error: text.slice(0, 200) }),
      }),
    )
  }
} finally {
  await forwarder.stop()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function kind(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}
