export * as Skills from "./skills.js"

import os from "node:os"
import type { SkillEditor } from "@opencode/plugin/promise/skill"
import type { Logger } from "./logger.js"

/** Core's built-in skills (`packages/core/src/plugin/skill.ts`): one about OpenCode itself, one that files an issue. */
const OPENCODE = "opencode"
const REPORT = "report"

/** The sentence appended to the `report` skill (decision D5, option d). */
const PRIVATE_FORK =
  "This OpenCode is own-open-code, a private fork, so this rule overrides the publishing steps above: never file an issue at `anomalyco/opencode`, publish only to a repository the user names (`gh issue create --repo <owner/name>`), and otherwise give the user the title and body."

export interface Input {
  /**
   * `OPENCODE_CONFIG_DIR` as read at registration: this service's own global config directory, on this PC (the
   * development channel has its own) or on a remote host (04 §9). Unset = the `opencode` section is skipped.
   */
  readonly configDir: string | undefined
  readonly log: Logger.Logger
}

/**
 * The `skill.transform` fold (external-repos-2026-10-05 P0-1). It edits core's two built-in skills:
 * - `opencode` teaches the upstream global config `~/.config/opencode` (`opencode.md` "CLI" and "OpenCode
 *   configuration"), which own never writes (02 §3.8): an agent that followed it would edit a separately installed
 *   upstream OpenCode. The fold appends an own section that points every such path at {@link Input.configDir}.
 * - `report` lists the configured plugin paths, which sit under the user's home directory, and publishes with
 *   `gh issue create` in whatever repository is current (SEC-5). The fold writes the home directory as `~` and appends
 *   one sentence that keeps issues off upstream (decision D5, option d).
 * - Content only: the names and descriptions stay as they are, so the session's skill list (its instruction baseline)
 *   does not change and no session gets a skills delta (`packages/core/src/skill/instructions.ts`).
 * - Core rebuilds the skills from scratch for every fold, so each edit is applied exactly once per fold.
 */
export function transform(editor: SkillEditor, input: Input) {
  opencode(editor, input)
  report(editor, input.log)
}

function opencode(editor: SkillEditor, input: Input) {
  const configDir = input.configDir
  if (configDir === undefined) {
    input.log.debug("skill_section_skipped", { skill: OPENCODE, reason: "config_dir_unset" })
    return
  }
  if (!editor.get(OPENCODE)) {
    input.log.debug("skill_missing", { skill: OPENCODE })
    return
  }
  editor.update(OPENCODE, (skill) => {
    skill.content = `${skill.content}\n\n${section(configDir)}`
  })
}

function report(editor: SkillEditor, log: Logger.Logger) {
  if (!editor.get(REPORT)) {
    log.debug("skill_missing", { skill: REPORT })
    return
  }
  editor.update(REPORT, (skill) => {
    skill.content = `${scrubHome(skill.content, os.homedir())}\n\n${PRIVATE_FORK}`
  })
}

/** The section appended to the `opencode` skill (own-written, about 700 characters). */
function section(configDir: string) {
  return [
    "## own-open-code",
    "",
    "This OpenCode is own-open-code, a private fork. These rules take precedence over the paths above.",
    "",
    `- The global configuration directory is \`${configDir}\` (\`OPENCODE_CONFIG_DIR\` of this service; the development channel and remote hosts have their own). \`opencode.jsonc\`, \`cli.json\` and the global \`AGENTS.md\` live there.`,
    "- Every `~/.config/opencode` or `$XDG_CONFIG_HOME/opencode` path in this skill means that directory.",
    "- Never create or edit files under `~/.config/opencode`: they belong to a separately installed upstream OpenCode.",
    "- Do not edit the own plugin entries (`own-*`) in the `plugins` list of `opencode.jsonc`.",
    "- Accounts, presets and the approval mode belong in the own app settings, not in configuration files.",
  ].join("\n")
}

/**
 * `content` with every path that starts at `home` starting at `~` instead. Windows paths compare case-insensitively and
 * appear with either separator (the launcher writes plugin entries with `/`), so the match ignores both; on POSIX that
 * can only hide more. The match must end the home directory's last name, so `C:\Users\dev2` is left alone.
 */
function scrubHome(content: string, home: string) {
  const names = home.split(/[\\/]/)
  // An unset or root home directory hides nothing, and its pattern would match almost anywhere.
  if (names.every((name) => name === "")) return content
  const pattern = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]")
  return content.replace(new RegExp(`${pattern}(?![\\p{L}\\p{N}_.-])`, "giu"), "~")
}
