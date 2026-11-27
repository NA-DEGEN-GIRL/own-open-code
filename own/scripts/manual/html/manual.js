// Client side of the single-file manual (inlined by own/scripts/manual/build-html.ts): theme toggle, table of
// contents drawer and scroll-spy, search over headings and text, and the image zoom. No network, no libraries.
;(() => {
  const root = document.documentElement
  const body = document.body
  const $ = (selector) => document.querySelector(selector)
  const narrow = window.matchMedia("(max-width: 1099px)")

  // --- Theme: dark unless the system asks for light; a choice made with the button is remembered when storage works.
  const THEME_KEY = "own-manual-theme"
  const storedTheme = () => {
    try {
      const value = localStorage.getItem(THEME_KEY)
      return value === "light" || value === "dark" ? value : null
    } catch {
      return null
    }
  }
  const themeButton = $("#theme-btn")
  const applyTheme = (theme) => {
    root.dataset.theme = theme
    const label = theme === "dark" ? "밝은 테마로 바꾸기" : "어두운 테마로 바꾸기"
    themeButton.setAttribute("aria-label", label)
    themeButton.title = label
  }
  applyTheme(root.dataset.theme === "light" ? "light" : "dark")
  themeButton.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark"
    applyTheme(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Storage can be blocked for file pages; the theme still changes for this visit.
    }
  })
  const lightQuery = window.matchMedia("(prefers-color-scheme: light)")
  lightQuery.addEventListener("change", (event) => {
    if (storedTheme() === null) applyTheme(event.matches ? "light" : "dark")
  })

  // --- Table of contents: a drawer below 1100px, chapters fold open around the place being read.
  const toc = $("#toc")
  const menuButton = $("#menu-btn")
  const backdrop = $("#backdrop")
  const setDrawer = (open) => {
    body.classList.toggle("toc-open", open)
    menuButton.setAttribute("aria-expanded", String(open))
    menuButton.setAttribute("aria-label", open ? "목차 닫기" : "목차 열기")
    backdrop.hidden = !open
    if (open) (toc.querySelector("a.active") ?? toc.querySelector("a"))?.focus({ preventScroll: true })
  }
  menuButton.addEventListener("click", () => setDrawer(!body.classList.contains("toc-open")))
  backdrop.addEventListener("click", () => setDrawer(false))
  narrow.addEventListener("change", () => setDrawer(false))

  const userOpened = new Set()
  const setChapterOpen = (item, open) => {
    item.classList.toggle("open", open)
    item.querySelector(".toc-toggle")?.setAttribute("aria-expanded", String(open))
  }
  toc.addEventListener("click", (event) => {
    const toggle = event.target.closest(".toc-toggle")
    if (toggle) {
      const item = toggle.closest(".toc-ch")
      const open = !item.classList.contains("open")
      setChapterOpen(item, open)
      if (open) userOpened.add(item)
      if (!open) userOpened.delete(item)
      return
    }
    if (event.target.closest("a") && narrow.matches) setDrawer(false)
  })

  // --- Scroll-spy: the last heading above the top bar is the one being read.
  const headings = Array.from(document.querySelectorAll("main h1[id], main h2[id], main h3[id]"))
  const tocLinks = new Map(Array.from(toc.querySelectorAll('a[href^="#"]')).map((link) => [link.hash.slice(1), link]))
  const toTop = $("#to-top")
  let activeLink = null
  let activeChapter = null
  const readingHeading = () => {
    const line = 96
    let low = 0
    let high = headings.length - 1
    let found = -1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (headings[middle].getBoundingClientRect().top <= line) {
        found = middle
        low = middle + 1
        continue
      }
      high = middle - 1
    }
    return found
  }
  const spy = () => {
    toTop.classList.toggle("show", window.scrollY > 900)
    const index = readingHeading()
    const link = (() => {
      for (let i = index; i >= 0; i--) {
        const candidate = tocLinks.get(headings[i].id)
        if (candidate) return candidate
      }
      return tocLinks.get("top") ?? null
    })()
    if (link === activeLink) return
    activeLink?.classList.remove("active")
    activeLink?.removeAttribute("aria-current")
    activeLink = link
    if (!link) return
    link.classList.add("active")
    link.setAttribute("aria-current", "location")
    const chapter = link.closest(".toc-ch")
    if (chapter !== activeChapter) {
      if (activeChapter && !userOpened.has(activeChapter)) setChapterOpen(activeChapter, false)
      if (chapter) setChapterOpen(chapter, true)
      activeChapter = chapter
    }
    const tocBox = toc.getBoundingClientRect()
    const linkBox = link.getBoundingClientRect()
    if (tocBox.height > 0 && (linkBox.top < tocBox.top + 48 || linkBox.bottom > tocBox.bottom - 48))
      toc.scrollTop += linkBox.top - tocBox.top - tocBox.height / 3
  }
  let spyQueued = false
  window.addEventListener(
    "scroll",
    () => {
      if (spyQueued) return
      spyQueued = true
      requestAnimationFrame(() => {
        spyQueued = false
        spy()
      })
    },
    { passive: true },
  )
  window.addEventListener("resize", spy)
  spy()
  toTop.addEventListener("click", () => {
    window.scrollTo({ top: 0 })
    $("#search").focus({ preventScroll: true })
  })

  // --- Search: built from the page itself on first use (heading → the blocks until the next heading).
  const input = $("#search")
  const results = $("#search-results")
  const searchBox = $(".search")
  const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  let index = null
  const buildIndex = () => {
    const entries = []
    for (const section of document.querySelectorAll("main > section")) {
      const chapter = (section.querySelector("h1")?.textContent ?? "").trim()
      let current = null
      for (const element of section.children) {
        if (/^H[1-3]$/.test(element.tagName) && element.id) {
          current = { id: element.id, chapter, title: element.textContent.trim(), nodes: [element], text: "" }
          entries.push(current)
          continue
        }
        if (!current || element.matches(".chapter-nav")) continue
        current.nodes.push(element)
        const alts = Array.from(element.querySelectorAll("img[alt]"), (image) => image.alt).join(" ")
        // innerText keeps table cells and list items apart (textContent would glue them together).
        current.text += ` ${element.innerText || element.textContent} ${alts}`
      }
    }
    for (const entry of entries) {
      entry.text = entry.text.replace(/\s+/g, " ").trim()
      entry.lower = entry.text.toLowerCase()
      entry.lowerTitle = entry.title.toLowerCase()
    }
    return entries
  }
  const count = (text, term) => {
    let total = 0
    for (let at = text.indexOf(term); at !== -1 && total < 10; at = text.indexOf(term, at + term.length)) total++
    return total
  }
  const parseQuery = (raw) => {
    const query = raw.trim().toLowerCase().replace(/\s+/g, " ")
    return { query, terms: query === "" ? [] : [...new Set(query.split(" "))] }
  }
  const find = (parsed) => {
    index ??= buildIndex()
    if (parsed.terms.length === 0) return []
    return index
      .filter((entry) => parsed.terms.every((term) => entry.lowerTitle.includes(term) || entry.lower.includes(term)))
      .map((entry, order) => {
        const phrase = (entry.lowerTitle.includes(parsed.query) ? 100 : 0) + (entry.lower.includes(parsed.query) ? 40 : 0)
        const terms = parsed.terms.reduce(
          (sum, term) => sum + (entry.lowerTitle.includes(term) ? 10 : 0) + count(entry.lower, term),
          0,
        )
        return { entry, order, score: phrase + terms }
      })
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, 40)
  }
  const highlight = (text, parsed) => {
    const words = (text.toLowerCase().includes(parsed.query) ? [parsed.query] : parsed.terms)
      .map((word) => escapeHtml(word))
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
    return escapeHtml(text).replace(new RegExp(words.join("|"), "gi"), (match) => `<mark>${match}</mark>`)
  }
  const snippet = (entry, parsed) => {
    const at = [parsed.query, ...parsed.terms].map((term) => entry.lower.indexOf(term)).find((position) => position >= 0)
    if (at === undefined) return entry.text.slice(0, 120)
    const start = Math.max(0, at - 40)
    const end = Math.min(entry.text.length, at + 100)
    return `${start > 0 ? "…" : ""}${entry.text.slice(start, end)}${end < entry.text.length ? "…" : ""}`
  }
  const showResults = (open) => {
    results.hidden = !open
    input.setAttribute("aria-expanded", String(open))
  }
  const render = () => {
    const parsed = parseQuery(input.value)
    if (parsed.terms.length === 0) {
      results.innerHTML = ""
      showResults(false)
      return
    }
    const found = find(parsed)
    const head = found.length
      ? `<p class="sr-count">${found.length === 40 ? "40곳 이상" : `${found.length}곳`}에서 찾았어요</p>`
      : `<p class="sr-count">‘${escapeHtml(input.value.trim())}’에 맞는 곳이 없어요. 낱말을 줄여 보세요.</p>`
    results.innerHTML =
      head +
      found
        .map(
          (hit) =>
            `<a class="sr-item" role="option" href="#${hit.entry.id}" data-id="${hit.entry.id}">` +
            `<span class="sr-chapter">${escapeHtml(hit.entry.chapter)}</span>` +
            `<span class="sr-title">${highlight(hit.entry.title, parsed)}</span>` +
            `<span class="sr-snippet">${highlight(snippet(hit.entry, parsed), parsed)}</span></a>`,
        )
        .join("")
    showResults(true)
  }
  let pending = 0
  input.addEventListener("input", () => {
    clearTimeout(pending)
    pending = setTimeout(render, 90)
  })
  input.addEventListener("focus", () => {
    if (input.value.trim() !== "") render()
  })

  let marks = []
  const clearMarks = () => {
    const parents = new Set()
    for (const mark of marks) {
      if (!mark.isConnected) continue
      parents.add(mark.parentNode)
      mark.replaceWith(document.createTextNode(mark.textContent))
    }
    for (const parent of parents) parent.normalize()
    marks = []
  }
  // The whole phrase if the section has it, else each word; a phrase split across elements (key caps such as
  // Ctrl+Alt+Shift+Q) falls back to its letter runs.
  const markIn = (entry, parsed) => {
    const phrase = entry.lower.includes(parsed.query) || entry.lowerTitle.includes(parsed.query)
    const attempts = [
      phrase ? [parsed.query] : parsed.terms,
      parsed.query.split(/[^\p{L}\p{N}]+/u).filter((piece) => piece.length >= 2),
    ]
    for (const words of attempts) {
      if (words.length === 0) continue
      const made = markWords(entry, words)
      if (made.length > 0) return made
    }
    return []
  }
  const markWords = (entry, words) => {
    const pattern = new RegExp(
      [...words]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join("|"),
      "gi",
    )
    const made = []
    for (const node of entry.nodes) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
        acceptNode: (text) =>
          text.parentElement?.closest("svg, script, style, mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      })
      const texts = []
      while (walker.nextNode()) texts.push(walker.currentNode)
      for (const text of texts) {
        const value = text.nodeValue ?? ""
        const matches = [...value.matchAll(pattern)]
        if (matches.length === 0) continue
        const fragment = document.createDocumentFragment()
        let last = 0
        for (const match of matches) {
          fragment.append(value.slice(last, match.index))
          const mark = document.createElement("mark")
          mark.className = "hit"
          mark.textContent = match[0]
          fragment.append(mark)
          made.push(mark)
          last = match.index + match[0].length
        }
        fragment.append(value.slice(last))
        text.replaceWith(fragment)
      }
    }
    return made
  }
  const goTo = (id) => {
    const parsed = parseQuery(input.value)
    const entry = (index ?? []).find((candidate) => candidate.id === id)
    const target = document.getElementById(id)
    showResults(false)
    clearMarks()
    if (narrow.matches) setDrawer(false)
    if (!target) return
    history.replaceState(null, "", `#${id}`)
    marks = entry && parsed.terms.length ? markIn(entry, parsed) : []
    target.scrollIntoView({ block: "start" })
    const first = marks.find((mark) => !target.contains(mark))
    if (first && first.getBoundingClientRect().bottom > window.innerHeight - 24) first.scrollIntoView({ block: "center" })
    marks[0]?.classList.add("current")
    target.setAttribute("tabindex", "-1")
    target.focus({ preventScroll: true })
  }
  results.addEventListener("click", (event) => {
    const item = event.target.closest(".sr-item")
    if (!item) return
    event.preventDefault()
    goTo(item.dataset.id)
  })
  const moveFocus = (step) => {
    const items = Array.from(results.querySelectorAll(".sr-item"))
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement)
    if (at === -1 && step < 0) return
    if (at === 0 && step < 0) return input.focus()
    items[Math.min(items.length - 1, Math.max(0, at + step))].focus()
  }
  searchBox.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveFocus(1)
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      moveFocus(-1)
    }
    if (event.key === "Enter" && event.target === input) {
      event.preventDefault()
      const first = results.querySelector(".sr-item")
      if (first) goTo(first.dataset.id)
    }
    if (event.key !== "Escape") return
    event.stopPropagation()
    if (!results.hidden) {
      showResults(false)
      input.focus()
      return
    }
    input.value = ""
    clearMarks()
    input.blur()
  })
  document.addEventListener("click", (event) => {
    if (!searchBox.contains(event.target)) showResults(false)
  })

  // --- Image zoom: fit to the screen first; click the picture for its full size.
  const lightbox = $("#lightbox")
  const lightboxImage = $("#lightbox-img")
  const lightboxCaption = $("#lightbox-caption")
  const sizeButton = $("#lightbox-size")
  const closeButton = $("#lightbox-close")
  let opener = null
  const setActual = (actual) => {
    lightbox.classList.toggle("actual", actual)
    sizeButton.textContent = actual ? "화면에 맞추기" : "원래 크기"
    sizeButton.setAttribute("aria-pressed", String(actual))
  }
  const openLightbox = (button) => {
    const image = button.querySelector("img")
    opener = button
    lightboxImage.src = image.currentSrc || image.src
    lightboxImage.alt = image.alt
    lightboxCaption.textContent = button.closest("figure")?.querySelector("figcaption")?.textContent ?? image.alt
    setActual(false)
    lightbox.hidden = false
    body.classList.add("no-scroll")
    closeButton.focus()
  }
  const closeLightbox = () => {
    if (lightbox.hidden) return
    lightbox.hidden = true
    body.classList.remove("no-scroll")
    lightboxImage.removeAttribute("src")
    opener?.focus({ preventScroll: true })
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".zoom")
    if (button) openLightbox(button)
  })
  sizeButton.addEventListener("click", () => setActual(!lightbox.classList.contains("actual")))
  closeButton.addEventListener("click", closeLightbox)
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightboxImage) return setActual(!lightbox.classList.contains("actual"))
    if (event.target.closest(".lightbox-bar")) return
    closeLightbox()
  })
  lightbox.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return
    const stops = [sizeButton, closeButton]
    const at = stops.indexOf(document.activeElement)
    event.preventDefault()
    stops[(at + (event.shiftKey ? stops.length - 1 : 1)) % stops.length].focus()
  })

  // --- Keyboard: `/` or Ctrl+K searches, Esc closes what is open.
  const typing = (element) => element instanceof HTMLElement && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName))
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!lightbox.hidden) return closeLightbox()
      if (body.classList.contains("toc-open")) {
        setDrawer(false)
        menuButton.focus()
        return
      }
      clearMarks()
      return
    }
    if (!lightbox.hidden) return
    const ctrlK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k"
    if (!ctrlK && (event.key !== "/" || typing(event.target))) return
    event.preventDefault()
    input.focus()
    input.select()
  })

  // Print every picture: images below the fold may not have been decoded yet.
  window.addEventListener("beforeprint", () => {
    for (const image of document.querySelectorAll("img[loading=lazy]")) image.loading = "eager"
  })
})()
