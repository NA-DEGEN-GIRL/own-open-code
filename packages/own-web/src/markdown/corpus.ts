// Answers for the incremental markdown tests (tail.test.ts, stream.test.tsx): every block kind the transcript renders,
// Korean prose, and the constructs whose meaning depends on what follows (setext headings, lazy list and quote lines,
// display math across a blank line, raw HTML that spans blocks, reference links).
export const CORPUS: Readonly<Record<string, string>> = {
  korean: [
    "## 구현 계획",
    "",
    "스트리밍 응답은 **프레임마다 한 번만** 반영되어야 합니다. 끝난 블록은 *다시 그리지 않고*, `마지막 블록`만 고칩니다.",
    "한 줄 더 이어지는 문단이에요.",
    "",
    "### 단계 1",
    "",
    "계속해서 **굵은 분석**과 [문서](https://example.com/docs)를 봐요. 경로 `src/markdown/tail.ts`도 있어요.",
    "",
  ].join("\n"),
  lists: [
    "1. 첫째 항목",
    "2. 둘째 항목은 길어서",
    "   다음 줄로 이어져요",
    "   - 안쪽 항목 하나",
    "   - 안쪽 항목 둘",
    "3. 셋째",
    "",
    "- 느슨한 목록",
    "",
    "- 빈 줄 뒤 항목",
    "",
    "  같은 항목의 둘째 문단",
    "",
    "* [ ] 할 일",
    "* [x] 끝난 일",
    "",
    "끝 문단.",
  ].join("\n"),
  tables: [
    "| 항목 | 상태 | 확인 |",
    "| --- | :---: | ---: |",
    "| markdown | 증분 | 표시 프레임 |",
    "| 한글 | **굵게** | `코드` |",
    "| 줄바꿈<br>있음 | 3 | 4 |",
    "",
    "표 다음 문단이에요.",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
  ].join("\n"),
  code: [
    "코드 앞 문단:",
    "",
    "```ts",
    "const row = rows[index] ?? fallback",
    "const title = row.title.toLocaleUpperCase(locale)",
    "// 한글 주석",
    "```",
    "",
    "~~~python title=x.py",
    "def f(x):",
    "    return x * 2",
    "~~~",
    "",
    "    indented code",
    "    second line",
    "",
    "- 목록 안 코드:",
    "",
    "  ```bash",
    "  bun run test",
    "  ```",
    "",
    "````md",
    "```nested```",
    "````",
    "",
    "```",
    "열린 채로 끝나는 코드",
  ].join("\n"),
  mixed: [
    "# 제목",
    "",
    "> 인용 첫 줄",
    "이어지는 게으른 줄",
    ">",
    "> - 인용 안 목록",
    "",
    "setext 제목",
    "===========",
    "",
    "둘째 setext",
    "---",
    "",
    "***",
    "",
    "수식 $a^2 + b^2 = c^2$ 와 \\(x_1\\), 그리고 $5 가격.",
    "",
    "$$",
    "\\int_0^1 x\\,dx",
    "",
    "= \\frac{1}{2}",
    "$$",
    "",
    "자동 링크 https://example.com/a/b 와 <https://example.org> 그리고 ses_0123456789ABCDEFGHIJKLMNOP 세션.",
    "",
    "<!-- stream-1 --> 주석 뒤 문단 ~~취소선~~.",
  ].join("\n"),
  html: [
    "<details>",
    "<summary>펼치기</summary>",
    "",
    "안쪽 **마크다운** 문단",
    "",
    "</details>",
    "",
    "바깥 문단 <b>굵게</b> 닫힘.",
  ].join("\n"),
  refs: ["참조 [링크][r]와 [또 하나][s].", "", "[r]: https://example.com/r", "[s]: https://example.com/s", "", "끝."].join(
    "\n",
  ),
}

/** The bench answer's sections (own-web e2e/performance/fixture/history.ts `streamFragments`), 6 of them. */
export const BENCH = [
  "## 구현 계획 OWNB-X-0000-R\n\n스트리밍 **굵은 분석",
  ...Array.from({ length: 6 * 15 }, (_, index) => {
    const fragments = [
      " 스트리밍 응답은",
      " 프레임마다 한 번만",
      " 반영되어야 합니다",
      "**. <!-- stream-{n} -->\n\n",
      "| 항목 | 상태",
      " | 확인 |\n|",
      " --- | ---",
      " | --- |\n|",
      " markdown | 증분 |",
      " 표시 프레임 |\n\n",
      "```ts\nconst row = rows[index]",
      " ?? fallback\nconst title =",
      " row.title.toLocaleUpperCase(locale)\n",
      "// stream-{n}\n```\n\n",
      "### 단계 {section}\n\n계속해서 **굵은 분석",
    ]
    return fragments[index % fragments.length]!.replaceAll("{n}", String(index + 1)).replaceAll(
      "{section}",
      String(Math.floor((index + 1) / fragments.length) + 1),
    )
  }),
  "\n\n## 검증\n\n- 타입 검사: 통과\n- 스트리밍: 완료 OWNB-Y-0000-R\n",
].join("")

/** Splits `text` into chunks of 1..max characters, the same for the same seed (a small LCG). */
export function chunks(text: string, seed: number, max = 12) {
  const out: string[] = []
  let state = seed
  for (let at = 0; at < text.length; ) {
    state = (state * 1103515245 + 12345) % 2147483648
    const size = 1 + (state % max)
    out.push(text.slice(at, at + size))
    at += size
  }
  return out
}
