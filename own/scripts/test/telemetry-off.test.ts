// Telemetry stays off (decisions TLM, own/reports/telemetry-audit-2026-11-25.md). Pins what the audit turned off where no
// package test covers it, and fails when a new telemetry-looking path appears in shipped source, so an upstream sync or
// a new own feature is classified before it ships. The launcher's env switches are pinned in launcher.test.mjs, own-remote's
// in its unit tests (model.test.ts, scripts.test.ts), the web UI's links and pictures in own-web e2e transcript.spec.ts,
// upstream's exporter, updater, catalog, flag and crash-reporter seams in own/upstream-surface.json.
//
//   bun test ./telemetry-off.test.ts                      (from own/scripts/test)
//   OWN_TLM_BUILD=<own/.out/build/<ver>> bun test ./telemetry-off.test.ts   also scans a release build's bundles
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ClaudeIO } from "../../../packages/core/src/plugin/provider/claude-agent/claude/io"
import { ClaudeQuiet } from "../../../packages/own-accounts/src/claude-agent/quiet"

const REPO = path.resolve(import.meta.dir, "..", "..", "..")

/** Names that mark analytics, crash or error reporting, experiment fetches, update feeds and exporters. */
const MARKERS =
  "posthog|@sentry/|sentry\\.io|statsig|segment\\.(io|com)|mixpanel|amplitude\\.com|datadoghq|honeycomb\\.io|" +
  "googletagmanager|google-analytics|plausible\\.io|s2/favicons|event_logging|crashlytics|bugsnag|\\brollbar\\b|" +
  "logrocket|hotjar|fullstory|newrelic|opncd\\.ai|uploadToServer|electron-updater|setFeedURL|" +
  "OTEL_EXPORTER_OTLP_ENDPOINT|firebaselogging|datatransport"

/** Source that ships: the service (core and what it bundles), the desktop shell's main side, the UI, own's packages. */
const SHIPPED = [
  "packages/core/src",
  "packages/server/src",
  "packages/cli/src",
  "packages/util/src",
  "packages/protocol/src",
  "packages/plugin/src",
  "packages/plugin-browser/src",
  "packages/ai/src",
  "packages/schema/src",
  "packages/client/src",
  "packages/codemode/src",
  "packages/desktop/src/main",
  "packages/desktop/src/preload",
  "packages/gui-plugins/src",
  "packages/gui-extensions/src",
  "packages/session-ui/src",
  "packages/ui/src",
  "packages/own-accounts/src",
  "packages/own-android/src",
  "packages/own-computer-use/src",
  "packages/own-creator/src",
  "packages/own-desktop/src",
  "packages/own-harness/src",
  "packages/own-import/src",
  "packages/own-omo/src",
  "packages/own-protocol/src",
  "packages/own-remote/src",
  "packages/own-runtime/src",
  "packages/own-team/src",
  "packages/own-telemetry/src",
  "packages/own-web/src",
  "own/launcher",
]

/** Every file the scan may find, and why it is not telemetry or does not ship or stays off. */
const KNOWN: Record<string, string> = {
  "own/launcher/own.ps1": "removes OTEL_* from the service environment (the switch itself)",
  "packages/cli/src/index.ts":
    "upstream's OTLP exporter, only with OTEL_EXPORTER_OTLP_ENDPOINT set, which the launcher and start.sh remove (surface otlp-exporter-env)",
  "packages/util/src/observability.ts": "the same exporter (surface otlp-exporter-env)",
  "packages/core/src/plugin/mcp-codemode-defaults.ts": "a header for PostHog's MCP server when the user adds it, not telemetry",
  "packages/desktop/src/main/native/logging.ts":
    "crashReporter with uploadToServer: false, dumps stay on this PC (surface desktop-crash-reporter-local)",
  "packages/gui-plugins/src/updater/machine.ts":
    "upstream's updater plugin: own-desktop registers only the browser and explorer plugins (src/overrides/gui-plugins.ts)",
  "packages/gui-plugins/src/updater/main.ts": "the same updater plugin, not in own-desktop's build",
  "packages/gui-plugins/src/updater/platform.ts": "the same updater plugin, not in own-desktop's build",
  "packages/session-ui/src/components/markdown.tsx":
    "upstream's favicon lookup: own-web substitutes markdown.tsx at build time (vendor/session-ui/markdown.tsx)",
  "packages/own-remote/src/remote/scripts.ts": "start.sh removes OTEL_* on SSH hosts (the switch itself)",
  "packages/own-android/src/main/AndroidManifest.xml": "removes ML Kit's Data Transport backend (the switch itself)",
  "packages/own-accounts/src/mcp/fold.ts": "the same PostHog MCP server header as core's, not telemetry",
  "packages/own-omo/src/shim/posthog.ts": "omo's PostHog replaced by a no-op in the runtime bundle (script/resolve.ts)",
  "packages/own-omo/src/shim/stub.ts": "posthog-node replaced by a stub that throws if anything starts it",
}

function scan() {
  const result = Bun.spawnSync(
    ["git", "grep", "--untracked", "-l", "-i", "-E", MARKERS, "--", ...SHIPPED, ":!*.test.*", ":!**/test/**", ":!**/e2e/**"],
    { cwd: REPO },
  )
  // git grep: 0 = found, 1 = nothing found.
  expect([0, 1]).toContain(result.exitCode)
  return result.stdout.toString().split(/\r?\n/).filter(Boolean)
}

describe("telemetry stays off", () => {
  test("no new telemetry-looking path in shipped source", () => {
    const found = scan()
    const unknown = found.filter((file) => !(file in KNOWN))
    // A new hit: read it, decide (off, stripped or kept, own/reports/telemetry-audit-*.md), then list it in KNOWN.
    expect(unknown).toEqual([])
    // A listed file that no longer matches: remove its entry so the list stays the audit's.
    expect(Object.keys(KNOWN).filter((file) => !found.includes(file))).toEqual([])
  })

  test("own-web never asks Google for link favicons; remote pictures become links", () => {
    const markdown = fs.readFileSync(path.join(REPO, "packages/own-web/src/vendor/session-ui/markdown.tsx"), "utf8")
    const cache = fs.readFileSync(path.join(REPO, "packages/own-web/src/vendor/session-ui/markdown-cache.tsx"), "utf8")
    expect(markdown).not.toContain("google.com")
    expect(markdown).not.toContain('createElement("img")')
    expect(cache).toContain("node.replaceWith(remoteImageLink(node, src))")
  })

  test("every claude own starts gets the same telemetry switches, never the nonessential-traffic one", () => {
    // Core's route (P-042) and own-accounts' login window and update card are separate bundles with one list.
    expect({ ...ClaudeQuiet.FLAGS }).toEqual({ ...ClaudeIO.QUIET })
    expect(ClaudeQuiet.FLAGS).toMatchObject({ DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" })
    const env = ClaudeIO.allowed({
      PATH: "C:/bin",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
      DO_NOT_TRACK: "0",
    })
    expect(env).toMatchObject({ ...ClaudeIO.QUIET, DISABLE_AUTOUPDATER: "1", USERNAME: "", COMPUTERNAME: "" })
    expect(Object.keys(env).filter((name) => /^OTEL_|^CLAUDE_CODE_ENABLE_TELEMETRY$/.test(name))).toEqual([])
    // The update check, model bootstrap and quota probe of the route need Claude Code's nonessential traffic.
    expect("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" in env).toBe(false)
  })

  test("the config own writes keeps upstream's updater and sharing off", () => {
    const example = fs.readFileSync(path.join(REPO, "own/config/opencode.jsonc.example"), "utf8")
    expect(example).toMatch(/"update":\s*"disable"/)
    expect(example).toMatch(/"share":\s*"disabled"/)
    const launcher = fs.readFileSync(path.join(REPO, "own/launcher/own.ps1"), "utf8")
    expect(launcher).toContain("[ordered]@{ update = 'disable'; share = 'disabled';")
  })

  test("the APK: WebView metrics and Safe Browsing off, ML Kit's usage logging without a backend", () => {
    const manifest = fs.readFileSync(path.join(REPO, "packages/own-android/src/main/AndroidManifest.xml"), "utf8")
    expect(manifest).toMatch(/android\.webkit\.WebView\.MetricsOptOut"\s+android:value="true"/)
    expect(manifest).toMatch(/android\.webkit\.WebView\.EnableSafeBrowsing"\s+android:value="false"/)
    expect(manifest).toMatch(
      /backend:com\.google\.android\.datatransport\.cct\.CctBackendFactory"\s+tools:node="remove"/,
    )
  })

  // A release build's bundles (the builder sets OWN_TLM_BUILD): the web UI, the plugins and the desktop main bundle.
  test.skipIf(!process.env.OWN_TLM_BUILD)("a release build carries no telemetry endpoint", () => {
    const build = path.resolve(process.env.OWN_TLM_BUILD ?? "")
    const files = [
      ...fs.readdirSync(path.join(build, "web", "_assets")).map((name) => path.join(build, "web", "_assets", name)),
      ...fs
        .readdirSync(path.join(build, "plugins"))
        .map((name) => path.join(build, "plugins", name, "index.js"))
        .filter((file) => fs.existsSync(file)),
    ].filter((file) => /\.(js|css|html)$/.test(file))
    const endpoints = /s2\/favicons|posthog\.com|sentry\.io|statsig|segment\.io|googletagmanager|google-analytics|api\/event_logging/i
    expect(files.length).toBeGreaterThan(10)
    expect(files.filter((file) => endpoints.test(fs.readFileSync(file, "latin1"))).map((file) => path.relative(build, file))).toEqual([])
  }, 180_000)
})
