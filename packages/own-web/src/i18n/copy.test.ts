// Korean UI copy rules (03 §14, 2026-10-16): one word per concept (the glossary) and 해요체 sentences. Every Korean
// catalog is checked: `ko` here plus each `*Ko` export of the feature catalogs (`**/*strings.ts`) and the turn
// notifier's. A value that must keep a word names its key in ALLOW with the reason. The Claude risk notice
// (accounts/claude-notice.ts) is not a catalog: its text is hashed for the ack and stays as the router has it.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { remoteKo } from "@/remote/strings"
import { serversKo } from "@/servers/strings"
import { ko } from "./ko"

const SRC = path.join(import.meta.dir, "..")

async function catalogs() {
  const files = [
    ...new Bun.Glob("**/*strings.ts").scanSync({ cwd: SRC }),
    "shell/notifications.tsx",
  ].map((file) => file.replaceAll("\\", "/"))
  const loaded = await Promise.all(
    files
      .filter((file) => !file.includes(".test."))
      .map(async (file) => {
        const module: Record<string, unknown> = await import(path.join(SRC, file))
        return Object.entries(module).flatMap(([name, value]) =>
          name.endsWith("Ko") && value && typeof value === "object"
            ? Object.entries(value).flatMap(([key, text]) => (typeof text === "string" ? [{ file, key, text }] : []))
            : [],
        )
      }),
  )
  return [...Object.entries(ko).map(([key, text]) => ({ file: "i18n/ko.ts", key, text })), ...loaded.flat()]
}

/** Placeholders (`{provider}`) are names in code, not words on screen. */
const words = (text: string) => text.replace(/\{\w+\}/g, "")

const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/세션(?! ?ID)/, "대화 (세션 only in 세션 ID)"],
  [/채팅/, "대화"],
  [/워크트리/, "작업 폴더"],
  [/허락/, "승인 / 허용"],
  [/컨텍스트/, "문맥"],
  [/유휴/, "쉬는 중"],
  [/프로바이더|(?<![-\w])provider/i, "회사 / 모델 회사"],
  [/라우터/, "계정 관리 / 이 앱"],
  [/\bdock\b/, "칸"],
  [/폐기/, "연결 끊기"],
  [/받아쓰기/, "음성 입력"],
  [/하네스/, "에이전트 방식"],
  [/설정 > (실험|기기|서버 연결|원격 호스트|다른 도구(?!의)|전환 정책|레이아웃|팀(?! 모드))/, "the 2026-10-16 settings names"],
  [/\b(lease|epoch|ledger|endpoint|prefix|catalog|DPAPI|trusted|untrusted)\b/i, "a plain word"],
  [/own (restart|open|start)/, "명령 보기 (command text only behind it)"],
  [/\(\d\d §/, "no spec references on screen"],
  [/(?<![\w@/-])own\.[a-z]+/, "no plugin ids outside the plugins page"],
  [/모두 (한 곳으로|메인과 같게)/, "메인과 같은 모델로 / 다른 모델 하나로 (the ① choices, UC 2026-10-18)"],
]

/** Values that must keep a banned word, with the reason. */
const ALLOW: Readonly<Record<string, string>> = {
  "own.set.pluginAccounts": "the plugins page names plugin ids",
  "own.set.pluginTelemetry": "the plugins page names plugin ids",
}

describe("Korean UI copy (03 §14)", () => {
  test("uses the glossary", async () => {
    const offending = (await catalogs()).flatMap((entry) =>
      BANNED.flatMap(([pattern, instead]) =>
        pattern.test(words(entry.text)) && !(entry.key in ALLOW)
          ? [`${entry.file} ${entry.key} → ${entry.text}   [${instead}]`]
          : [],
      ),
    )
    expect(offending).toEqual([])
  })

  test("speaks 해요체: no 합니다체 sentence anywhere", async () => {
    const formal = /[가-힣](니다|니까|십시오)(?=$|[\s.,:;!?…)"'’”\]])/
    const offending = (await catalogs()).flatMap((entry) =>
      formal.test(entry.text) ? [`${entry.file} ${entry.key} → ${entry.text}`] : [],
    )
    expect(offending).toEqual([])
  })

  test("every allowed exception still exists", async () => {
    const keys = new Set((await catalogs()).map((entry) => entry.key))
    expect(Object.keys(ALLOW).filter((key) => !keys.has(key))).toEqual([])
  })
})

describe("quoted labels (03 §14.1)", () => {
  test("the SSH page's empty state quotes the add button as the button reads (remote/settings.tsx `＋ <label>`)", () => {
    expect(remoteKo["own.remote.settings.empty"]).toContain(`[＋ ${serversKo["own.remote.add"]}]`)
  })
})
