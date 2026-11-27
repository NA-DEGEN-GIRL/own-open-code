// 설정 > 자동 압축 > 압축 실패 시 대체 모델 (own/docs/11 §3, P2-13): a service that cannot set them (no own.harness, or
// one from before this setting) says so in a muted line instead of the raw RPC error; another failure keeps its
// message and offers `다시 시도`. Solid components do not render under `bun test`: settings-layout.spec.ts shows the
// line against a real service without own.harness, and the wiring is checked in the source here.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { compactionEn, compactionKo, compactionText } from "./compaction-strings"

const code = async (file: string) =>
  (await Bun.file(path.join(import.meta.dir, file)).text())
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

describe("압축 실패 시 대체 모델 on a service that cannot set them", () => {
  test("Korean and English words", () => {
    expect(Object.keys(compactionEn).toSorted()).toEqual(Object.keys(compactionKo).toSorted())
    expect(compactionText.text("ko", "own.compact.fallback.unavailable")).toBe(
      "이 서비스에서는 대체 모델을 정할 수 없어요.",
    )
    expect(compactionText.text("ko", "own.compact.fallback.retry")).toBe("다시 시도")
    expect(compactionText.text("en", "own.compact.fallback.unavailable")).toBe(
      "This service cannot set fallback models.",
    )
  })

  test("rpc.unavailable and rpc.method_not_found are the note; anything else keeps its message and offers 다시 시도", async () => {
    const source = await code("compaction-fallback.tsx")
    expect(source).toContain(
      'if (type === "rpc.unavailable" || type === "rpc.method_not_found") return setProblem("unavailable")',
    )
    expect(source).toContain("status.error(errorMessage(i18n, error))")
    expect(source).toContain('text("own.compact.fallback.unavailable")')
    expect(source).toContain('<Show when={problem() === "failed"}>')
    expect(source).toContain("onClick={() => void load()}")
    // The strings are a lazy module of the settings page, not the shared catalogs (PF5).
    expect(source).toContain('import { useCompactionText } from "./compaction-strings"')
  })
})
