// Builds the user manual into ONE self-contained HTML page (own/docs/manual/PLAN.md §8).
//
//   bun own/scripts/manual/build-html.ts                  build and check; writes the page and README.md's chapter list
//   bun own/scripts/manual/build-html.ts --check          check only, write nothing
//   bun own/scripts/manual/build-html.ts --allow-missing  a missing picture becomes a dashed placeholder, not an error
//   bun own/scripts/manual/build-html.ts --strict         a Korean label not found in the app's strings fails the build
//   bun own/scripts/manual/build-html.ts --out <file>     write the page somewhere else
//
// Chapters are own/docs/manual/NN-*.md in file-name order (PLAN.md and README.md are not part of the page), rendered
// with Bun's built-in Markdown parser. Pictures (images/*.webp, also png/jpg/gif) become data: URIs, diagrams/*.svg are
// inlined, and so are the page's style and script (html/manual.css, html/manual.js): the file opens by double-click
// with no server and no network. Checks: every picture reference resolves and every picture is used, nothing on the
// page loads from the network, the page stays under 25 MB, no personal data (this PC's user and machine names, home and
// temp folders, real email addresses), and Korean `labels` match real strings of the app (own-web, own-desktop,
// Android). Problems fail the build; unused pictures, links to chapters not written yet and unknown labels warn.
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const args = parseArgs({
  options: {
    check: { type: "boolean" },
    "allow-missing": { type: "boolean" },
    strict: { type: "boolean" },
    out: { type: "string" },
  },
}).values

const REPO = path.resolve(import.meta.dir, "../../..")
const MANUAL = path.join(REPO, "own/docs/manual")
const OUT = path.resolve(args.out ?? path.join(MANUAL, "own-open-code-manual.html"))
const README = path.join(MANUAL, "README.md")
/** The release the manual describes (shown on the cover). */
const RELEASE = "2.0.24-own.1"
const TITLE = "own-open-code 사용 설명서"
const MAX_PAGE_BYTES = 25 * 1024 * 1024
const WARN_PICTURE_BYTES = 350 * 1024
const HANGUL = /[\uac00-\ud7a3]/
const PARTS = [
  { from: 0, title: "1부. 처음 10분" },
  { from: 6, title: "2부. 매일 쓰는 기능" },
  { from: 11, title: "3부. 중요한 기능 깊이 보기" },
  { from: 22, title: "4부. 원격·모바일" },
  { from: 26, title: "5부. 문제 해결" },
  { from: 28, title: "6부. 외부 서비스 연결" },
  { from: 29, title: "7부. own 넓히기" },
  { from: 90, title: "부록" },
]
const CALLOUTS = new Map([
  ["팁", "tip"],
  ["주의", "warn"],
  ["용어", "term"],
  ["참고", "note"],
])
const MODIFIER_KEYS = new Set(["Ctrl", "Alt", "Shift", "Win", "Cmd", "Meta", "Option", "Fn"])
const NAMED_KEYS = new Set([
  ...MODIFIER_KEYS,
  "Enter",
  "Esc",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "Del",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Up",
  "Down",
  "Left",
  "Right",
])
const MIME = new Map([
  [".webp", "image/webp"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
])

const ICONS = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  search:
    '<svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  sun: '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  chevron:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
}

interface Heading {
  readonly level: number
  readonly id: string
  readonly text: string
  readonly slug: string
}

interface Link {
  readonly href: string
  readonly title?: string
  readonly children: string
}

interface Chapter {
  readonly file: string
  readonly num: string
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly headings: Heading[]
  readonly links: Link[]
  readonly html: string
}

const errors: string[] = []
const warnings: string[] = []
const usedPictures = new Set<string>()
const labels: { file: string; label: string }[] = []
/** Chapter files linked to but not written yet → the chapters linking to them. */
const unwritten = new Map<string, Set<string>>()

const files = (await Array.fromAsync(new Bun.Glob("[0-9][0-9]-*.md").scan({ cwd: MANUAL }))).sort()
const sources = await Promise.all(files.map((file) => Bun.file(path.join(MANUAL, file)).text()))
const rendered = files.map((file, at) => renderChapter(file, sources[at]))
const cover = rendered.find((chapter) => chapter.num === "00")
const chapters = rendered.filter((chapter) => chapter.num !== "00")
const byFile = new Map(rendered.map((chapter) => [chapter.file, chapter]))

const page = buildPage()
for (const [target, from] of [...unwritten].sort())
  warnings.push(`${target} is not written yet; its links stay plain text (in ${[...from].join(", ")})`)
const pictureBytes = await checkPictures()
checkPage(page)
await checkPrivacy(page)
await checkLabels()
const readme = chapterIndex()
report(page, pictureBytes)

if (errors.length > 0) process.exit(1)
if (args.strict && warnings.some((warning) => warning.startsWith("label"))) process.exit(1)
if (!args.check) {
  await Bun.write(OUT, page)
  if (readme.changed) await Bun.write(README, readme.text)
  console.log(`wrote ${path.relative(REPO, OUT)}${readme.changed ? " and README.md's chapter list" : ""}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown → HTML

function renderChapter(file: string, source: string): Chapter {
  const num = file.slice(0, 2)
  const id = `ch${num}`
  const headings: Heading[] = []
  const links: Link[] = []
  const pictures: string[] = []
  const slugs = new Map<string, number>()
  const counters = [0, 0, 0, 0]
  // The chapter's one-line summary for the cover's chapter list, or its first paragraph when it has none.
  const state = { summary: "", lead: "" }

  // The cover's own table of contents is replaced by the sidebar.
  const markdown = source.replace(/<!-- toc:start -->[\s\S]*?<!-- toc:end -->/g, "")
  const body = Bun.markdown.render(markdown, {
    text: (value) => escapeHtml(value),
    heading: (children, meta) => {
      const level = Math.min(meta.level, 4)
      counters[level - 1] += 1
      counters.fill(0, level)
      const headingID = headingId(id, level, counters)
      const text = plainText(children)
      headings.push({ level: meta.level, id: headingID, text, slug: uniqueSlug(slugs, text) })
      return `<h${meta.level} id="${headingID}">${children}</h${meta.level}>\n`
    },
    paragraph: (children) => {
      const only = children.trim().match(/^\u0002(\d+)\u0003$/)
      if (only) return pictures[Number(only[1])]
      const summary = children.match(/^<strong>한 줄 요약[.:]?<\/strong>\s*[:：—–-]?\s*/)
      if (!summary) {
        state.lead ||= plainText(children)
        return `<p>${children}</p>\n`
      }
      const rest = children.slice(summary[0].length)
      state.summary ||= plainText(rest)
      return `<p class="summary"><span class="summary-label">한 줄 요약</span>${rest}</p>\n`
    },
    blockquote: (children) => {
      const inner = children.trim()
      if (inner.startsWith('<p class="summary">')) return `${inner}\n`
      const head = inner.match(/^<p><strong>([^<]+)<\/strong>\s*[:：—–]?\s*/)
      const kind = head ? CALLOUTS.get(head[1]) : undefined
      if (!head || !kind) return `<blockquote>\n${children}</blockquote>\n`
      const rest = inner.slice(head[0].length)
      return `<aside class="callout ${kind}"><p><span class="callout-label">${head[1]}</span>${rest}</aside>\n`
    },
    code: (children, meta) =>
      `<pre${meta?.language ? ` data-lang="${escapeAttr(meta.language)}"` : ""}><code>${children.replace(/\n$/, "")}</code></pre>\n`,
    codespan: (children) => inlineCode(file, children),
    list: (children, meta) => {
      if (!meta.ordered) return `<ul>\n${children}</ul>\n`
      return `<ol${meta.start !== undefined && meta.start !== 1 ? ` start="${meta.start}"` : ""}>\n${children}</ol>\n`
    },
    listItem: (children, meta) => {
      if (meta.checked === undefined) return `<li>${children}</li>\n`
      return `<li class="task"><input type="checkbox" disabled${meta.checked ? " checked" : ""}> ${children}</li>\n`
    },
    hr: () => "<hr>\n",
    table: (children) => `<div class="table-wrap"><table>\n${children}</table></div>\n`,
    thead: (children) => `<thead>\n${children}</thead>\n`,
    tbody: (children) => `<tbody>\n${children}</tbody>\n`,
    tr: (children) => `<tr>${children}</tr>\n`,
    th: (children, meta) => `<th${align(meta?.align)}>${children}</th>`,
    td: (children, meta) => `<td${align(meta?.align)}>${children}</td>`,
    // Raw HTML (inline SVG diagrams) also passes through `text` above; undo that escaping.
    html: (children) => decodeEntities(children),
    strong: (children) => `<strong>${children}</strong>`,
    emphasis: (children) => `<em>${children}</em>`,
    strikethrough: (children) => `<del>${children}</del>`,
    // Links are resolved once every chapter's headings are known; the text stays readable for plainText().
    link: (children, meta) => {
      links.push({ href: meta.href, title: meta.title, children })
      return `\u0004${links.length - 1}\u0005${children}\u0006`
    },
    image: (children, meta) => {
      pictures.push(picture(file, meta.src, plainText(children), meta.title))
      return `\u0002${pictures.length - 1}\u0003`
    },
  })
  // A picture inside a sentence, a list item or a table cell stays where it is.
  const html = body.replace(/\u0002(\d+)\u0003/g, (_, at: string) => pictures[Number(at)])
  const title = headings.find((heading) => heading.level === 1)?.text ?? file
  if (!headings.some((heading) => heading.level === 1)) errors.push(`${file}: no "# title" heading`)
  return { file, num, id, title, summary: state.summary || state.lead, headings, links, html }
}

function headingId(chapterID: string, level: number, counters: number[]) {
  if (level === 1) return counters[0] === 1 ? chapterID : `${chapterID}-t${counters[0]}`
  return [chapterID, ...counters.slice(1, level)].join("-")
}

/** GitHub-style anchor of a heading, so `chapter.md#anchor` links written for a Markdown viewer still work. */
function uniqueSlug(seen: Map<string, number>, text: string) {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-")
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

function align(value: string | undefined) {
  return value ? ` style="text-align:${value}"` : ""
}

/** `Ctrl+Shift+U` → keys, a Korean label → the app's label style, anything else → code. */
function inlineCode(file: string, escaped: string) {
  const raw = decodeEntities(escaped)
  if (HANGUL.test(raw)) {
    labels.push({ file, label: raw })
    return `<span class="ui">${escaped}</span>`
  }
  const keys = keyCombo(raw)
  if (keys) return `<span class="keys">${keys.map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join("+")}</span>`
  return `<code>${escaped}</code>`
}

function keyCombo(raw: string) {
  const parts = raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+")
  const key = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1)
  if (parts.some((part) => part === "") || !modifiers.every((part) => MODIFIER_KEYS.has(part))) return undefined
  const named = NAMED_KEYS.has(key) || /^F([1-9]|1[0-2])$/.test(key)
  // A lone character is code (`/`, `!`), not a key.
  if (named || (modifiers.length > 0 && [...key].length === 1)) return parts
  return undefined
}

function picture(file: string, src: string, alt: string, title: string | undefined) {
  const ref = decodeURIComponent(src).replace(/\\/g, "/")
  const caption = title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ""
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) {
    errors.push(`${file}: picture ${src} is not a local file (the page must not load anything from the network)`)
    return ""
  }
  const full = path.resolve(MANUAL, ref)
  if (!full.startsWith(MANUAL + path.sep)) {
    errors.push(`${file}: picture ${src} is outside own/docs/manual`)
    return ""
  }
  usedPictures.add(path.relative(MANUAL, full).replace(/\\/g, "/"))
  const ext = path.extname(full).toLowerCase()
  if (!existsSync(full)) {
    if (!args["allow-missing"]) errors.push(`${file}: picture ${ref} does not exist`)
    return `<figure class="missing"><div class="missing-shot">스크린숏 준비 중: ${escapeHtml(path.basename(ref))}</div>${caption}</figure>\n`
  }
  if (ext === ".svg") {
    const svg = readText(full)
      .replace(/<\?xml[\s\S]*?\?>/, "")
      .replace(/<!DOCTYPE[\s\S]*?>/i, "")
      .trim()
    return `<figure class="diagram" role="group" aria-label="${escapeAttr(alt)}">${svg}${caption}</figure>\n`
  }
  const mime = MIME.get(ext)
  if (!mime) {
    errors.push(`${file}: picture ${ref} has an unsupported type (use .webp)`)
    return ""
  }
  if (ext !== ".webp") warnings.push(`picture ${ref} is not WebP; it is embedded as it is (capture.ts writes WebP)`)
  const bytes = readBytes(full)
  const size = pictureSize(bytes, ext)
  // Screenshots are 2× except the full 1440×900 window shots (PLAN.md §5.1): show 2× ones at half their pixels.
  const scale = size && size.width === 1440 ? 1 : 2
  const width = size ? Math.round(size.width / scale) : undefined
  const height = size ? Math.round(size.height / scale) : undefined
  const tall = width !== undefined && height !== undefined && height > width * 1.25 && height > 700
  const dimensions = width && height ? ` width="${width}" height="${height}"` : ""
  return (
    `<figure class="shot${tall ? " tall" : ""}"><button type="button" class="zoom" title="눌러서 크게 보기">` +
    `<img src="data:${mime};base64,${bytes.toString("base64")}" alt="${escapeAttr(alt)}"${dimensions} loading="lazy" decoding="async">` +
    `</button>${caption}</figure>\n`
  )
}

function pictureSize(bytes: Buffer, ext: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (ext === ".webp" && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const chunk = ascii(12, 16)
    if (chunk === "VP8X")
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      }
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
    }
  }
  if (ext === ".png" && ascii(1, 4) === "PNG") return { width: view.getUint32(16), height: view.getUint32(20) }
  if (ext === ".gif" && ascii(0, 3) === "GIF") return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// The page

function buildPage() {
  const css = readText(path.join(import.meta.dir, "html/manual.css"))
  const script = readText(path.join(import.meta.dir, "html/manual.js")).replace(/<\/script/gi, "<\\/script")
  const sections = chapters.map((chapter, at) => {
    const previous = chapters[at - 1]
    const next = chapters[at + 1]
    const nav = [
      previous
        ? `<a class="prev" href="#${previous.id}"><small>이전 장</small>${escapeHtml(previous.title)}</a>`
        : "",
      next ? `<a class="next" href="#${next.id}"><small>다음 장</small>${escapeHtml(next.title)}</a>` : "",
    ].join("")
    return (
      `<section class="chapter" data-chapter="${chapter.num}" aria-labelledby="${chapter.id}">\n` +
      `${resolveLinks(chapter)}<nav class="chapter-nav" aria-label="장 이동">${nav}</nav>\n</section>\n`
    )
  })
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="description" content="own-open-code(${RELEASE}) 데스크톱 앱 사용 설명서. 인터넷 없이 열리는 한 파일이에요.">
<title>${TITLE}</title>
<script>(()=>{let t=null;try{t=localStorage.getItem("own-manual-theme")}catch{}if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t})()</script>
<style>
${css}
</style>
</head>
<body>
<a class="skip-link" href="#content">본문으로 건너뛰기</a>
<header class="topbar">
<button type="button" class="icon-btn" id="menu-btn" aria-controls="toc" aria-expanded="false" aria-label="목차 열기">${ICONS.menu}</button>
<a class="brand" href="#top"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">own-open-code</span><span class="brand-sub">사용 설명서</span></a>
<div class="search" role="search">
${ICONS.search}
<input id="search" type="search" placeholder="검색 ( / 또는 Ctrl+K )" autocomplete="off" spellcheck="false" aria-label="설명서 검색" aria-controls="search-results" aria-expanded="false">
<div id="search-results" class="search-results" role="listbox" aria-label="검색 결과" hidden></div>
</div>
<button type="button" class="icon-btn" id="theme-btn" aria-label="테마 바꾸기">${ICONS.sun}${ICONS.moon}</button>
</header>
<div class="layout">
<nav id="toc" class="toc" aria-label="목차">
${tocHtml()}
</nav>
<div id="backdrop" class="backdrop" hidden></div>
<main id="content">
${coverHtml()}
${sections.join("")}
</main>
</div>
<button type="button" id="to-top" class="to-top" aria-label="맨 위로">${ICONS.up}</button>
<div id="lightbox" class="lightbox" role="dialog" aria-modal="true" aria-label="그림 크게 보기" hidden>
<div class="lightbox-bar"><span id="lightbox-caption"></span><button type="button" id="lightbox-size" aria-pressed="false">원래 크기</button><button type="button" id="lightbox-close">닫기</button></div>
<div class="lightbox-stage"><img id="lightbox-img" alt=""></div>
</div>
<script>
${script}
</script>
</body>
</html>
`
}

function tocHtml() {
  const parts = PARTS.map((part, at) => {
    const until = PARTS[at + 1]?.from ?? Number.POSITIVE_INFINITY
    const items = chapters.filter((chapter) => Number(chapter.num) >= part.from && Number(chapter.num) < until)
    if (items.length === 0) return ""
    return `<p class="toc-part">${part.title}</p>\n<ol>\n${items.map(tocChapter).join("")}</ol>\n`
  })
  return `<a class="toc-cover" href="#top">처음: 표지와 읽는 법</a>\n${parts.join("")}`
}

function tocChapter(chapter: Chapter) {
  const sections = chapter.headings.filter((heading) => heading.level === 2)
  const rows = sections.map((section) => {
    const at = chapter.headings.indexOf(section)
    const end = chapter.headings.findIndex((heading, index) => index > at && heading.level <= 2)
    const children = chapter.headings
      .slice(at + 1, end === -1 ? undefined : end)
      .filter((heading) => heading.level === 3)
      .map((heading) => `<li><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
      .join("")
    return `<li><a href="#${section.id}">${escapeHtml(section.text)}</a>${children ? `<ol class="toc-sub3">${children}</ol>` : ""}</li>`
  })
  const toggle = rows.length
    ? `<button type="button" class="toc-toggle" aria-expanded="false" aria-label="${escapeAttr(chapter.title)}: 절 목록 펼치기">${ICONS.chevron}</button>`
    : ""
  return (
    `<li class="toc-ch"><div class="toc-row"><a class="toc-h1" href="#${chapter.id}">${escapeHtml(chapter.title)}</a>${toggle}</div>` +
    `${rows.length ? `<ol class="toc-sub">${rows.join("")}</ol>` : ""}</li>\n`
  )
}

function coverHtml() {
  const list = PARTS.map((part, at) => {
    const until = PARTS[at + 1]?.from ?? Number.POSITIVE_INFINITY
    const items = chapters.filter((chapter) => Number(chapter.num) >= part.from && Number(chapter.num) < until)
    if (items.length === 0) return ""
    const rows = items
      .map(
        (chapter) =>
          `<li><a href="#${chapter.id}">${escapeHtml(chapter.title)}</a>${chapter.summary ? `<p>${escapeHtml(chapter.summary)}</p>` : ""}</li>`,
      )
      .join("\n")
    return `<h3 class="part-title">${part.title}</h3>\n<ul class="chapter-list">\n${rows}\n</ul>`
  }).join("\n")
  const intro = cover ? resolveLinks(cover) : defaultIntro()
  return `<section class="cover" id="top">\n${intro}\n<h2>장 목록</h2>\n${list}\n</section>\n`
}

function defaultIntro() {
  return `<p class="eyebrow">사용 설명서 · ${RELEASE} 기준</p>
<h1>own-open-code</h1>
<p class="lede">대화 하나를 여러 회사·여러 계정의 AI가 이어서 쓰는 데스크톱 코딩 앱이에요. 계정을 바꾸기 전에 드는 비용을 먼저 보여 주고, 계정마다 남은 한도를 한곳에 모아 보여 줘요.</p>
<div class="cards">
<div class="card"><h2>처음이라면</h2><p>${chapterRef("01")}에서 이 앱이 무엇인지 보고, ${chapterRef("02")} 설치, ${chapterRef("03")} 첫 계정, ${chapterRef("04")} 첫 대화만 읽어도 바로 쓸 수 있어요.</p></div>
<div class="card"><h2>돈과 한도가 궁금하면</h2><p>${chapterRef("07")}에서 한도 보는 법을, ${chapterRef("11")}부터 ${chapterRef("13")}까지 계정 바꾸기와 압축을 깊이 다뤄요.</p></div>
<div class="card"><h2>막혔다면</h2><p>${chapterRef("26")} 증상별 해결부터 보세요. 낯선 낱말은 ${chapterRef("90", "용어 사전")}에 있어요.</p></div>
</div>
<aside class="callout note"><p><span class="callout-label">참고</span>화면의 계정, 대화, 폴더 경로(<code>D:\\demo\\space-game</code>)는 모두 가짜 데모 데이터예요. 숫자(한도 %, 금액)는 예시예요.</p></aside>
<h2>이 페이지 쓰는 법</h2>
<ul class="howto">
<li>왼쪽 목차에서 장을 고르면 그 장의 절이 펼쳐져요. 좁은 화면에서는 왼쪽 위 목차 단추로 열어요.</li>
<li>위의 검색 상자에 낱말을 넣으면 제목과 본문에서 찾아 줘요. <span class="keys"><kbd>/</kbd></span> 또는 <span class="keys"><kbd>Ctrl</kbd>+<kbd>K</kbd></span>로 바로 갈 수 있어요.</li>
<li>그림을 누르면 크게 보여요. 크게 본 그림을 한 번 더 누르면 원래 크기로, <span class="keys"><kbd>Esc</kbd></span>로 닫아요.</li>
<li>오른쪽 위 단추로 어둡게·밝게를 바꿔요. 처음에는 컴퓨터 설정을 따르고(밝게가 아니면 어둡게), 고른 것은 기억해요.</li>
<li>본문에서 <span class="ui">이렇게 생긴 글자</span>는 앱 화면에 보이는 단추·메뉴·문구 그대로예요.</li>
<li>인터넷 없이 열려요. 인쇄하면 밝은 색으로, 장마다 새 쪽에 나와요.</li>
</ul>`
}

function chapterRef(num: string, label?: string) {
  const chapter = chapters.find((candidate) => candidate.num === num)
  const text = label ?? `${Number(num)}장`
  return chapter ? `<a href="#${chapter.id}">${text}</a>` : text
}

/** Links between chapters become in-page anchors; links to chapters not written yet stay as plain text. */
function resolveLinks(chapter: Chapter) {
  return chapter.html.replace(/\u0004(\d+)\u0005[\s\S]*?\u0006/g, (_, at: string) => {
    const link = chapter.links[Number(at)]
    const title = link.title ? ` title="${escapeAttr(link.title)}"` : ""
    if (/^[a-z][a-z0-9+.-]*:/i.test(link.href))
      return `<a href="${escapeAttr(link.href)}"${title} target="_blank" rel="noopener noreferrer">${link.children}</a>`
    const hash = link.href.indexOf("#")
    const target = hash === -1 ? link.href : link.href.slice(0, hash)
    const fragment = hash === -1 ? "" : decodeURIComponent(link.href.slice(hash + 1))
    const into = target === "" ? chapter : byFile.get(path.posix.normalize(target))
    if (into) {
      const heading = fragment ? into.headings.find((candidate) => candidate.slug === fragment) : undefined
      if (fragment && !heading) warnings.push(`${chapter.file}: link ${link.href} names a heading that does not exist`)
      return `<a href="#${heading?.id ?? into.id}"${title}>${link.children}</a>`
    }
    if (/^\d\d-[^/]+\.md$/.test(target)) {
      unwritten.set(target, new Set([...(unwritten.get(target) ?? []), chapter.file]))
      return `<span class="xref-missing" title="이 장은 아직 준비 중이에요">${link.children}</span>`
    }
    const file = path.resolve(MANUAL, target)
    const shown = path.relative(REPO, file).replace(/\\/g, "/")
    if (!existsSync(file)) {
      warnings.push(`${chapter.file}: links to ${link.href}, which does not exist`)
      return link.children
    }
    // A design document of the repository: works when the page is opened from the checkout.
    return `<a class="doc-link" href="${escapeAttr(link.href)}" title="저장소의 문서: ${escapeAttr(shown)}" target="_blank" rel="noopener">${link.children}</a>`
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks

async function checkPictures() {
  const all = [
    ...(await Array.fromAsync(new Bun.Glob("images/*").scan({ cwd: MANUAL }))),
    ...(await Array.fromAsync(new Bun.Glob("diagrams/*.svg").scan({ cwd: MANUAL }))),
  ].map((file) => file.replace(/\\/g, "/"))
  const unused = all.filter((file) => !usedPictures.has(file)).sort()
  if (unused.length > 0) warnings.push(`pictures no chapter uses (${unused.length}): ${unused.join(", ")}`)
  const sizes = [...usedPictures].map((file) => ({ file, bytes: Bun.file(path.join(MANUAL, file)).size }))
  for (const big of sizes.filter((entry) => entry.bytes > WARN_PICTURE_BYTES))
    warnings.push(`picture ${big.file} is ${(big.bytes / 1024).toFixed(0)} KB (aim for ≤ 150 KB, warn above 350 KB)`)
  return sizes.reduce((sum, entry) => sum + entry.bytes, 0)
}

/** Nothing on the page may load from the network: only `<a href>` may point at http(s), and only as a link. */
function checkPage(html: string) {
  const text = withoutDataUris(html)
  for (const tag of text.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)) {
    for (const attribute of tag[2].matchAll(/([\w:-]+)\s*=\s*(["']?)\s*((?:https?:)?\/\/[^"'\s>]*)/gi)) {
      const name = attribute[1].toLowerCase()
      if (name === "xmlns" || name.startsWith("xmlns:")) continue
      if (tag[1].toLowerCase() === "a" && name === "href") continue
      errors.push(`the page loads ${attribute[3]} (<${tag[1]} ${name}>); everything must be inline`)
    }
  }
  for (const match of text.matchAll(/url\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]*)|@import\b/gi))
    errors.push(`the page's style loads ${match[1] ?? "@import"}; everything must be inline`)
  const bytes = Buffer.byteLength(html)
  if (bytes > MAX_PAGE_BYTES) errors.push(`the page is ${(bytes / 1024 / 1024).toFixed(1)} MB (limit 25 MB)`)
}

/** This PC's user and machine names, home and temp folders, and real email addresses must not be in the manual. */
async function checkPrivacy(html: string) {
  const user = os.userInfo().username
  const host = os.hostname()
  const rules: [RegExp, string][] = [
    [/[\\/]Users[\\/](?!demo(?![\w-]))/gi, "a home folder other than the demo's (C:\\Users\\demo)"],
    [/AppData/g, "an AppData folder"],
    [/scratchpad/gi, "a scratchpad folder"],
    [/\\Temp\\/gi, "a temp folder"],
    [/[\w.%+-]+@(?!example\.(?:com|test|org)\b)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi, "an email address"],
    ...(user.length >= 3 ? [[new RegExp(escapeRegExp(user), "gi"), "this PC's user name"] as [RegExp, string]] : []),
    ...(host.length >= 3 ? [[new RegExp(escapeRegExp(host), "gi"), "this PC's name"] as [RegExp, string]] : []),
  ]
  const diagrams = await Array.fromAsync(new Bun.Glob("diagrams/*.svg").scan({ cwd: MANUAL }))
  const texts = [
    ...files.map((file, at) => ({ name: file, text: sources[at] })),
    ...diagrams.map((file) => ({ name: file, text: readText(path.join(MANUAL, file)) })),
    { name: "README.md", text: existsSync(README) ? readText(README) : "" },
    // Base64 picture data can spell anything; the pictures were checked when they were taken.
    { name: path.basename(OUT), text: withoutDataUris(html) },
  ]
  for (const entry of texts) {
    for (const [pattern, what] of rules) {
      for (const match of entry.text.matchAll(pattern)) {
        const line = entry.text.slice(0, match.index).split("\n").length
        errors.push(`${entry.name}:${line}: contains ${what}`)
      }
    }
  }
}

/** Korean `labels` must be real strings of the app (PLAN.md §2.3, §8). */
async function checkLabels() {
  const allowFile = path.join(import.meta.dir, "labels-allow.txt")
  const allowed = new Set(
    (existsSync(allowFile) ? readText(allowFile) : "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  )
  const corpus = await appStrings()
  const templates = corpus
    .filter((text) => text.includes("…"))
    .map((text) => new RegExp(`^${text.split("…").map(escapeRegExp).join("[\\s\\S]*?")}$`))
  const seen = new Set<string>()
  for (const entry of labels) {
    const key = `${entry.file}\u0000${entry.label}`
    if (seen.has(key) || allowed.has(entry.label)) continue
    seen.add(key)
    const wanted = normalizeLabel(entry.label)
    const parts = wanted.split("…")
    const pattern = parts.length > 1 ? new RegExp(parts.map(escapeRegExp).join("[\\s\\S]*?")) : undefined
    const found = pattern
      ? corpus.some((text) => pattern.test(text))
      : corpus.some((text) => text.includes(wanted))
    if (found || templates.some((template) => template.test(wanted))) continue
    warnings.push(`label not found in the app's strings: ${entry.file}: \`${entry.label}\``)
  }
}

async function appStrings() {
  const roots = [
    ["packages/own-web/src", "**/*.{ts,tsx}"],
    ["packages/own-desktop/src", "**/*.{ts,tsx}"],
    // Limit window labels come from the router's parsers (`Unified`: `주간 · Fable`, `추가 사용량`).
    ["packages/own-protocol/src", "**/*.ts"],
    // omo (원본)'s notices and command refusal are written by own-omo (`omo: 남은 할 일을 이어서 해요`, own/docs/15).
    ["packages/own-omo/src", "**/*.ts"],
    // The image card's per-account reasons are written by own-accounts' image service (`구독(Codex)으로는 GIF를 …`).
    ["packages/own-accounts/src/image", "**/*.ts"],
  ]
  const code = await Promise.all(
    roots.map(async ([dir, pattern]) => {
      const names = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: path.join(REPO, dir) }))
      return names
        .filter((name) => !/\.test\.|(^|[\\/])(test|tests|__tests__)[\\/]/.test(name))
        .map((name) => readText(path.join(REPO, dir, name)))
    }),
  )
  const xml = path.join(REPO, "packages/own-android/src/main/res/values/strings.xml")
  const android = existsSync(xml) ? [...readText(xml).matchAll(/>([^<]+)</g)].map((match) => match[1]) : []
  return [...code.flat().flatMap(literals), ...android].filter((text) => HANGUL.test(text)).map(normalizeLabel)
}

/** String literals and JSX text of a source file, without comments. */
function literals(code: string) {
  const uncommented = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
  return [
    ...uncommented.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`|>([^<>{}\n]+)</g),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? "")
}

/** Placeholders (`{name}`, `${x}`, `%1$s`) and `…` match anything; Korean particle pairs like `(으)로` match either. */
function normalizeLabel(text: string) {
  return text
    .replace(/\$\{[^}]*\}/g, "…")
    .replace(/\{[A-Za-z_][\w.]*\}/g, "…")
    .replace(/%\d\$[sd]/g, "…")
    .replace(/\\n/g, " ")
    .replace(/\\(["'`\\])/g, "$1")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\.\.\./g, "…")
    .replace(/\(으\)로|으로/g, "로")
    .replace(/\(이\)가/g, "가")
    .replace(/\(을\)를/g, "를")
    .replace(/\(은\)는/g, "는")
    .replace(/\(와\)과/g, "과")
    .replace(/\s+/g, " ")
    .trim()
}

/** README.md's chapter list (between the chapters markers) follows the chapter files. */
function chapterIndex() {
  const current = existsSync(README) ? readText(README) : ""
  const list = PARTS.map((part, at) => {
    const until = PARTS[at + 1]?.from ?? Number.POSITIVE_INFINITY
    const items = rendered.filter((chapter) => Number(chapter.num) >= part.from && Number(chapter.num) < until)
    if (items.length === 0) return ""
    return `**${part.title}**\n\n${items.map((chapter) => `- [${chapter.title}](${chapter.file})`).join("\n")}\n`
  })
    .filter((block) => block !== "")
    .join("\n")
  const marked = /(<!-- chapters:start -->\r?\n)[\s\S]*?(<!-- chapters:end -->)/
  if (!marked.test(current)) {
    warnings.push("README.md has no <!-- chapters:start --> … <!-- chapters:end --> block to keep up to date")
    return { changed: false, text: current }
  }
  const text = current.replace(marked, (_, start: string, end: string) => `${start}\n${list}\n${end}`)
  if (args.check && text !== current) warnings.push("README.md's chapter list is out of date (run without --check)")
  return { changed: text !== current, text }
}

function report(html: string, pictureBytes: number) {
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
  console.log(
    `manual: ${chapters.length} chapters${cover ? " + cover" : ""}, ${usedPictures.size} pictures (${mb(pictureBytes)}), ` +
      `${new Set(labels.map((entry) => entry.label)).size} UI labels → ${path.relative(REPO, OUT)} (${mb(Buffer.byteLength(html))})`,
  )
  if (warnings.length > 0) console.log(`\nwarnings (${warnings.length}):\n${warnings.map((line) => `  - ${line}`).join("\n")}`)
  if (errors.length > 0) console.error(`\nerrors (${errors.length}):\n${errors.map((line) => `  - ${line}`).join("\n")}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers

// Pictures are read inside the (synchronous) Markdown callbacks, hence the synchronous reads.
function readText(file: string) {
  return readFileSync(file, "utf8")
}

function readBytes(file: string) {
  return readFileSync(file)
}

function withoutDataUris(html: string) {
  return html.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, "data:…")
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function escapeAttr(text: string) {
  return escapeHtml(text).replace(/"/g, "&quot;")
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function decodeEntities(html: string) {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

function plainText(html: string) {
  return decodeEntities(html.replace(/<[^>]*>/g, "").replace(/[\u0002\u0004]\d+[\u0003\u0005]|\u0006/g, ""))
    .replace(/\s+/g, " ")
    .trim()
}
