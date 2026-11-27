# Writing own extensions (own.ext/1)

An extension is one JSON manifest. own validates it with a JSON schema (`creator_inspect` topic `schema`), stores each version unchanged under `OWN_HOME\creator\ext\<id>\v<n>`, and applies the active version to every project unless the user limits it to project folders in Settings > 확장. Nothing in it runs as code inside the app.

## Steps

1. `creator_inspect` `overview` and `extensions`: what exists, which names are taken.
2. Write the manifest. Start from a template below; keep only the items you need.
3. `creator_manage` `{"action":"validate","extension":{...}}` until `problems` is empty.
4. `creator_manage` `create` (new id) or `update` (same id, new version). The user approves the change unless the conversation has full approval.
5. Use it: a fragment shows from the next message, a tool is callable in the next step, a rule applies to the next permission check.
6. If something is wrong: `update` with a fix, or `rollback` to an earlier version (`version`), or `disable`.

## Manifest

```json
{
  "format": "own.ext/1",
  "id": "my-extension",
  "title": "Short title",
  "description": "What it is for (optional)",
  "items": []
}
```

- `id`: lowercase letters, digits and `-`, 2 to 40 characters, starting with a letter.
- At most 24 items. Every item may have `when` to narrow where it applies: `{"harness": ["codex","pi","dsh","opencode","omo","claude-code"], "agent": ["build"], "model": ["anthropic/*", "gpt-6*"], "project": ["D:/work/app"]}`. A missing list matches everything; every given list must match.

## Item templates

Prompt fragment (text the model reads as session context; up to 4,000 characters, 12,000 per extension):

```json
{
  "type": "prompt.fragment",
  "id": "style",
  "text": "Answer in Korean. Keep commit messages in English.",
  "when": { "harness": ["codex"] }
}
```

Command tool (a tool `ext_<name>` that runs one command; `{{param}}` placeholders are quoted for the shell; the command goes through the normal shell approval):

```json
{
  "type": "tool.command",
  "name": "run_tests",
  "description": "Runs the project's tests for one file. Returns the exit code and the output.",
  "command": "bun test {{file}}",
  "params": { "file": { "type": "string", "description": "Test file path relative to the project" } },
  "timeoutSeconds": 300
}
```

- `shell`: `default` (Windows PowerShell on Windows, bash elsewhere), `powershell`, `bash`, `sh`.
- `cwd`: a folder inside the project, relative. `direct: true` makes it a direct tool (breaks the prompt cache of open conversations whenever it changes); the default is a Code Mode tool.
- Parameters: `string`, `number` or `boolean`, optional `enum`, `optional: true`.

Tool rule (deny and ask tighten; allow loosens and needs the user's approval in Settings):

```json
{
  "type": "tool.rule",
  "rules": [
    { "permission": "shell", "pattern": "git push*", "effect": "ask", "reason": "Pushes need a look first" },
    { "tool": "webfetch", "effect": "deny", "reason": "No web access in this project" }
  ]
}
```

- `permission` names a permission action (`shell`, `edit`, `read`, `webfetch`, `websearch`, `external_directory`, …) and `pattern` its resource (a command, a path, a URL; `*` matches anything).
- `tool` names a tool (any call, Code Mode's too); only `deny` and `ask`.

Retry policy (only fewer or shorter backoff retries; core retries at most 10 times, 2 s doubling to 10 s):

```json
{ "type": "retry", "maxRetries": 3, "maxDelaySeconds": 5, "when": { "model": ["deepseek/*"] } }
```

Compaction prompt addition (appended to own's compaction prompt; up to 2,000 characters):

```json
{ "type": "compaction.prompt", "text": "Keep every open TODO and the exact names of failing tests." }
```

## Cache rules

- Fragments, Code Mode tools and skills keep the prompt cache: their changes are appended after the conversation.
- A direct tool and a harness's 내 지시문 change the start of the request: open conversations lose their cache once.
- Prefer one extension per purpose, so the user can turn it off without losing the rest.

## Safety

- No credentials, tokens, secret variables or credential file paths anywhere.
- An extension cannot loosen own's own gates (`own_*`, `creator`, `tool_rule`, `computer`, `browser`) or use `*` in an allow rule.
- The model never approves allow rules; tell the user to approve them in Settings > 확장 if they want them.
