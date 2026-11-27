// Web app manifest of the gateway origin (05 §13.9 M1). Dark by default like the app (03 §13.1): the splash and the
// status bar use the dark window background, so an installed app does not flash white before the theme preload runs.
export const MANIFEST = {
  name: "own-open-code",
  short_name: "own",
  description: "PC의 Own OpenCode 대화를 휴대폰에서 이어서 봐요",
  lang: "ko",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: "#080808",
  theme_color: "#080808",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  ],
} as const
