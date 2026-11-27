;(function () {
  // Inlined into index.html as the only inline script (id "oc-theme-preload-script"), whose hash the CSP allows.
  // Same storage keys as @opencode/ui ThemeProvider so the first paint matches what the provider applies next.
  var get = function (key) {
    try {
      return localStorage.getItem(key)
    } catch (e) {
      return null
    }
  }
  var themeId = get("opencode-theme-id") || "oc-2"
  // own: dark is the default (src/shell/theme-default.ts seeds the same before the provider starts), so only a
  // stored light or system choice paints anything else.
  var scheme = get("opencode-color-scheme")
  var dark = scheme !== "light"
  if (scheme === "system") dark = matchMedia("(prefers-color-scheme: dark)").matches
  var mode = dark ? "dark" : "light"
  var root = document.documentElement
  root.dataset.theme = themeId
  root.dataset.colorScheme = mode
  // --own-bg-subtle (03 §13.1) of the default theme (v2 bg-deep): the window background before the first paint, no
  // white flash and no shade step when the theme applies (src/shell/theme-default.ts WINDOW_BACKGROUND).
  root.style.backgroundColor = dark ? "#080808" : "#fafafa"
  var meta = document.querySelector("meta[name='theme-color']")
  if (meta) meta.setAttribute("content", dark ? "#080808" : "#fafafa")
  if (themeId === "oc-2") return
  var css = get("opencode-theme-css-" + mode)
  if (!css) return
  var style = document.createElement("style")
  style.id = "oc-theme-preload"
  style.textContent =
    ":root{color-scheme:" + mode + ";--text-mix-blend-mode:" + (dark ? "plus-lighter" : "multiply") + ";" + css + "}"
  document.head.appendChild(style)
})()
