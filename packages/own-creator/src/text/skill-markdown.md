# Agents, commands, skills and 내 지시문 as extensions

Creator mode writes these as items of an `own.ext/1` extension (see the skill `own-creator-extensions` for the manifest and the steps). own keeps every version, so a rollback is one call, and they follow the extension's project folders.

Agent (an agent markdown file's description and body; permissions come from `tool.rule` items with `"when": {"agent": ["<name>"]}`):

```json
{
  "type": "agent",
  "name": "reviewer",
  "description": "Reviews the current diff for bugs before a commit",
  "mode": "subagent",
  "prompt": "You review diffs. List concrete bugs with file and line. Do not edit files."
}
```

- `mode`: `primary` (the user picks it), `subagent` (other agents call it; listed in the task tool, which breaks the prompt cache of open conversations once), `all`.
- Optional: `model` (`provider/model`), `hidden`, `steps` (1–200). Names of existing agents are refused.

Slash command (`$ARGUMENTS` is what follows the command, `$1`…`$9` its words):

```json
{
  "type": "command",
  "name": "changelog",
  "description": "Draft a changelog entry",
  "template": "Write a changelog entry for: $ARGUMENTS"
}
```

Skill (a `SKILL.md`: the description says when to load it, the content is the body):

```json
{
  "type": "skill",
  "name": "release-notes",
  "description": "Use when the user asks for release notes of this repository",
  "content": "# Release notes\n\n1. Read the commits since the last tag.\n2. Group them by type."
}
```

A harness's 내 지시문 (the editable part of the codex, pi or dsh prompt; one text per harness for every project, so the extension cannot be limited to folders; it changes the start of the request, so open conversations on `custom` lose their cache once):

```json
{ "type": "harness.instructions", "harness": "codex", "text": "You are a careful coding agent…" }
```

- own keeps the text the user had before and puts it back when the extension is turned off, removed or rolled back to a version without it.
- Sessions use it only with the prompt variant `내 지시문` (`custom`), chosen in the conversation header or Settings > 에이전트 방식.
