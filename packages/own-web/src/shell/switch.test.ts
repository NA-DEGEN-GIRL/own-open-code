// The on/off switch (03 §4.2.2, P2-11): one component for the settings rows' switches, a 36×20 track inside a button
// that only a coarse pointer grows to 44×44 (`.own-target`). Solid components do not render under `bun test`; the
// browser e2e measures them (settings-layout.spec.ts, gateway), and the wiring is checked in the source here.
import { describe, expect, test } from "bun:test"
import path from "node:path"

const SRC = path.join(import.meta.dir, "..")
/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(path.join(SRC, file)).text()).replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")

const PLACES = [
  { file: "mcp/list.tsx", testid: 'testid="mcp-toggle"' },
  { file: "accounts/claude-slot.tsx", testid: 'testid="claude-remote-switch"' },
  { file: "computer/dialog.tsx", testid: 'testid="computer-switch"' },
  { file: "import/settings.tsx", testid: 'testid="settings-import-sidebar"' },
  { file: "settings/team.tsx", testid: "testid={props.testid}" },
] as const

describe("ToggleSwitch", () => {
  test("a switch button named by its label, focusable while busy, that ignores presses then", async () => {
    const source = await code("shell/switch.tsx")
    expect(source).toContain('role="switch"')
    expect(source).toContain("aria-checked={props.checked}")
    expect(source).toContain("aria-label={props.label}")
    // aria-disabled, never disabled: the switch keeps keyboard focus while a change is in flight.
    expect(source).toContain("aria-disabled={props.busy}")
    expect(source).not.toMatch(/\sdisabled=/)
    expect(source).toContain("if (!props.busy) props.onChange(!props.checked)")
    expect(source).toContain('class="own-switch own-target"')
    expect(source).toContain('import "./switch.css"')
  })

  test("the track and thumb keep the old tokens, and the focus ring goes round the track", async () => {
    const css = await Bun.file(path.join(SRC, "shell/switch.css")).text()
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    for (const token of [
      "--own-border-input",
      "--own-bg-subtle",
      "--own-accent",
      "--own-text-muted",
      "--own-on-accent",
    ])
      expect(css).toContain(`var(${token})`)
    expect(css).toMatch(/\.own-switch-track \{[^}]*width: 36px;[^}]*height: 20px;/)
    expect(css).toMatch(/\.own-switch:focus-visible \.own-switch-track \{[^}]*outline: 2px solid var\(--own-focus\)/)
    // The button is only the hit box: no colour of its own.
    expect(css).toMatch(/\.own-switch \{[^}]*background: transparent;/)
  })

  test("the five settings switches use it, keep their test ids, and carry no copy of the old markup", async () => {
    for (const place of PLACES) {
      const source = await code(place.file)
      expect({ file: place.file, imports: source.includes('import { ToggleSwitch } from "@/shell/switch"') }).toEqual({
        file: place.file,
        imports: true,
      })
      expect(source).toContain("<ToggleSwitch")
      expect(source).toContain(place.testid)
      expect(source).not.toContain('role="switch"')
      expect(source).not.toContain("group-aria-checked:translate-x-[18px]")
    }
    // 팀 설정 keeps its words on a gateway device, a wrapper round the switch.
    const team = await code("settings/team.tsx")
    expect(team).toContain('i18n.t(props.on ? "own.set.state.on" : "own.set.state.off")')
  })
})
