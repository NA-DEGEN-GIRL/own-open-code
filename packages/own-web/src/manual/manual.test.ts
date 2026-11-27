// In-app user manual (03 §4.3.1): the build step that ships own/docs/manual/own-open-code-manual.html inside own-web
// (scripts beside the page for the gateway's and the WebUi's same-origin CSP, a hashed name for the WebUi's one-year
// cache), the chapter links against the real manual's anchors, and the entry points' wiring (Solid components do not
// render under `bun test`; e2e renders them).
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { MANUAL, manualHref, type ManualPlace } from "./index"
import { SECTION_CHAPTERS } from "./link"
import { manual, splitManual } from "./vite"

const SOURCE = path.join(import.meta.dir, "../../../../own/docs/manual/own-open-code-manual.html")

describe("build step", () => {
  test("inline scripts move to files beside the page, in order; scripts with src stay", () => {
    const page = splitManual(
      '<html><head><script>let a = 1</script></head><body><script src="x.js"></script><p>본문</p><script type="text/javascript">b()</script></body></html>',
    )
    expect(page.name).toMatch(/^manual-[0-9a-f]{12}\.html$/)
    const hash = page.name.slice("manual-".length, -".html".length)
    expect(page.scripts).toEqual([
      { name: `manual-${hash}-0.js`, code: "let a = 1" },
      { name: `manual-${hash}-1.js`, code: "b()" },
    ])
    expect(page.html).toBe(
      `<html><head><script src="manual-${hash}-0.js"></script></head><body><script src="x.js"></script><p>본문</p><script type="text/javascript" src="manual-${hash}-1.js"></script></body></html>`,
    )
    // Another manual gets another name (the WebUi caches `_assets/` for a year).
    expect(splitManual("<p>2</p>").name).not.toBe(splitManual("<p>1</p>").name)
  })

  test("the real manual leaves no inline script behind", () => {
    if (!existsSync(SOURCE)) return
    const page = splitManual(readFileSync(SOURCE, "utf8"))
    expect(page.scripts.length).toBeGreaterThan(0)
    expect(page.html).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/)
  })

  test("the page's path reaches the app: `_assets/` in a build, the dev route when serving, empty without the file", () => {
    const define = (plugin: ReturnType<typeof manual>, command: "build" | "serve") => {
      const hook = plugin.config as (
        config: object,
        env: { command: "build" | "serve"; mode: string },
      ) => {
        define: Record<string, string>
      }
      return JSON.parse(hook({}, { command, mode: "production" }).define["import.meta.env.OWN_MANUAL_URL"]!) as string
    }
    if (existsSync(SOURCE)) {
      expect(define(manual(SOURCE), "build")).toMatch(/^\/_assets\/manual-[0-9a-f]{12}\.html$/)
      expect(define(manual(SOURCE), "serve")).toBe("/__own-manual/manual.html")
    }
    expect(define(manual(path.join(import.meta.dir, "missing.html")), "build")).toBe("")
  })
})

/**
 * The section each place means, as its heading reads without the number. Anchors are positions (`ch17-16` is the 16th
 * section of chapter 17), so a section inserted before a linked one moves the link to its neighbour.
 */
const TITLES = {
  screen: "① 사이드바",
  desktop: "확대·축소(화면 크기)",
  settings: "설정 화면과 일반 설정",
  approval: "승인 모드와 안전장치",
  websearch: "웹 검색 서비스",
  plugins: "프로젝트 플러그인과 믿을 수 없는 저장소",
  shell: "터미널",
  palette: "명령 팔레트",
  voice: "음성 입력: 말로 입력하기",
  image: "이미지 만들기: 그림 만들기와 고치기",
  skills: "스킬: 고르기와 다른 도구에서 가져오기",
  harness: "에이전트 방식: Codex·Pi·DeepSeek·OpenCode",
  prompts: "지시문 보기·고치기·되돌리기",
  mcp: "MCP 서버: 외부 도구 더하기·가져오기·찾아서 설치",
  policy: "자동 전환: API 키 계정끼리만",
  compaction: "자동 압축",
  output: "출력 상한 페이지",
  presets: "프리셋: 하위 에이전트를 어디서, 얼마나",
  team: "팀 모드",
  teamEnable: "팀 모드 켜기",
  teamSettings: "팀 설정",
  experimental: "컴퓨터 사용",
  layout: "앱 안 브라우저와 분할 화면",
  import: "다른 도구의 대화: Codex·Claude Code에서 가져오기",
  remote: "SSH 원격 프로젝트",
  github: "GitHub 연결: 여러 계정",
  creator: "확장 만들기: creator 모드",
  devices: "휴대폰·다른 PC에서 쓰기",
  server: "설치·서비스",
  shortcuts: "단축키",
  updates: "외부 도구 업데이트",
} satisfies Record<Exclude<ManualPlace, "top">, string>

describe("chapters", () => {
  test("every chapter the app links to is a heading of the manual with the title of the section it means", () => {
    if (!existsSync(SOURCE)) return
    const html = readFileSync(SOURCE, "utf8")
    const anchors = new Map(Object.entries(MANUAL))
    for (const [place, title] of Object.entries(TITLES)) {
      const anchor = anchors.get(place)
      const heading = new RegExp(`<h([1-6])[^>]*\\bid="${anchor}"[^>]*>([\\s\\S]*?)</h\\1>`).exec(html)?.[2]
      // "10.15 MCP 서버: …", "8. 승인 …", "부록 B. 단축키", or no number; markup such as <span class="ui"> dropped.
      const text = heading
        ?.replaceAll(/<[^>]+>/g, "")
        .replace(/^(?:부록 [A-Z]\.|\d+(?:\.\d+)*\.?)\s+/, "")
        .trim()
      expect(text, `${place} (#${anchor})`).toBe(title)
    }
    for (const chapter of Object.values(SECTION_CHAPTERS)) expect(MANUAL[chapter.place]).toBeTruthy()
  })

  test("a chapter is the page's anchor; the start is the page itself", () => {
    expect(manualHref("/_assets/manual-0123456789ab.html", "teamEnable")).toBe(
      "/_assets/manual-0123456789ab.html#ch17-3",
    )
    expect(manualHref("/_assets/manual-0123456789ab.html")).toBe("/_assets/manual-0123456789ab.html")
  })
})

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(path.join(import.meta.dir, "..", file)).text())
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

describe("entry points (03 §4.3.1)", () => {
  test("header `?`, the settings list and its chapter links, the palette, the hints, one viewer in the shell", async () => {
    expect(await code("discover/settings-button.tsx")).toContain('data-testid="header-manual"')
    const settings = await code("settings/index.tsx")
    expect(settings).toContain('data-testid="settings-manual-link"')
    expect(settings).toContain("<SettingsManualLink section={props.section} />")
    const palette = await code("shell/palette-commands.tsx")
    expect(palette).toContain("id: `manual.${entry.place}`")
    for (const word of ['"설명서"', '"도움말"', '"manual"', '"help"']) expect(palette).toContain(word)
    const hints = await code("discover/hints.tsx")
    expect(hints).toContain('openManual("teamEnable")')
    expect(await code("shell/app-shell.tsx")).toContain("<ManualLayer />")
    expect(await Bun.file(path.join(import.meta.dir, "../../vite.config.ts")).text()).toContain("manual(),")
  })

  test("the viewer is a same-origin frame in the app, never another program", async () => {
    const viewer = await code("manual/viewer.tsx")
    expect(viewer).toContain("<iframe")
    expect(viewer).toContain("dialog.showModal()")
    expect(viewer).not.toContain("openExternal")
    expect((await code("manual/viewer.tsx")).match(/[가-힣]+/g) ?? []).toEqual([])
    expect((await code("manual/link.tsx")).match(/[가-힣]+/g) ?? []).toEqual([])
  })
})
