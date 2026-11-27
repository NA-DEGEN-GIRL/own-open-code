# Code extensions: MCP servers (C2) and code plugins (C3)

Use code only when no declarative item does the job (a fragment, a command tool, a rule, a retry or compaction item). Both kinds are staged before a version exists: every check must pass, or nothing is written and the active version stays.

## MCP server (`kind: "mcp"`)

For a tool that needs real code. The server runs inside own's WebAssembly JavaScript sandbox (QuickJS) in a process of its own: no environment, no process, no Bun or Node, no disk. The only way out is own's bridge, reachable through the `context` a tool's `run` is given: `context.files` (the project folder only) and `context.fetch` (only the hosts you declare in `hosts`). Every call asks the user's approval mode: 묻기 and 읽기 전용 ask every time, 전체 허용 asks once per version; a read-only role (explore, own-review) may not call one at all. Its tools are Code Mode tools: call them as `tools["creator-<id>-<name>"].<tool>({...})`.

```json
{
  "format": "own.ext/1",
  "id": "word-tools",
  "title": "Word tools",
  "kind": "mcp",
  "items": [
    {
      "type": "mcp.server",
      "name": "words",
      "files": {
        "server.ts": "import { serve } from \"./own-mcp\"\n\nserve({\n  name: \"words\",\n  tools: {\n    count_words: {\n      description: \"Counts the words of a text.\",\n      input: { type: \"object\", properties: { text: { type: \"string\" } }, required: [\"text\"] },\n      run: (args) => `words: ${String(args.text).split(\" \").filter(Boolean).length}`,\n    },\n  },\n})\n",
        "server.test.ts": "import { expect, test } from \"bun:test\"\n\ntest(\"sums\", () => expect(1 + 1).toBe(2))\n"
      },
      "smoke": [{ "tool": "count_words", "arguments": { "text": "a b" }, "expect": "words: 2" }]
    }
  ]
}
```

- `files`: up to 24 code/json/md files, lower-case `.ts`/`.js`/`.mts`/`.mjs` for code, relative `/` paths. `entry` (default `server.ts`) calls `serve` from own's `./own-mcp` (own writes that file; do not write it yourself, nor `tsconfig.json`, `package.json`, a `.npmrc`/`.yarnrc`/`bunfig.toml`/`.env`).
- A tool's `run(args, context)` answers a string, `{ text }`, `{ json }` or `{ error }`. `context.files.read/write/list/exists` reach files inside the project only (never `..`, absolute paths, junctions out, or credential folders like `.ssh`, `.git`, `.aws`); `context.fetch(url, init?)` reaches only the hosts you declare in `hosts`; `context.log(line)` writes to the extension's log in Settings > 확장; `context.deadline` is when the call's time is up.
- There is no Node, no Bun and no global `fetch` in the sandbox. The code may import only its own files, `./own-mcp`, and its `dependencies`; it may not name `process`, `Bun`, `require`, `globalThis`, `eval` or `Function`, use dynamic `import()`, `import.meta` or import attributes.
- `hosts`: the hosts `context.fetch` may reach (`api.example.com`, `127.0.0.1:8080`), each approved with the version. No wildcards; nothing reachable unless declared.
- `dependencies`: only own's allow-list (`zod`, `yaml`, `date-fns`, `dayjs`, `marked`, `diff`, `papaparse`, `semver`, `lodash-es`), exact versions only (no ranges). They install without install scripts and are bundled into the sandbox; the user always approves the install.
- Tests: files ending `.test.ts` run inside the sandbox (`import { test, expect, callTool } from "./own-mcp"`). `callTool(definition, name, args)` runs one tool in a test.
- `smoke`: calls the staging client makes as the model would; `expect` is text the answer must contain.
- `memoryMb` (default 512): the sandbox stops above it; `timeoutSeconds` (default 60) bounds one call.

Staging (all inside the sandbox): install → typecheck (an early lint) → bundle → tests → smoke. Read `checks` and `problems` in the result; fix and `update`.

## Code plugin (`kind: "plugin"`, off by default)

Only for request or compaction hooks no declarative item expresses. The user must turn code plugins on in Settings > 고급 > 확장 (you cannot), and must approve each version there before it loads. It applies to every project.

```json
{
  "format": "own.ext/1",
  "id": "pirate",
  "title": "Pirate replies",
  "kind": "plugin",
  "items": [
    {
      "type": "plugin.code",
      "hooks": ["context"],
      "files": {
        "plugin.ts": "import { definePlugin } from \"./own-plugin\"\n\nexport default definePlugin({\n  hooks: {\n    context: (request) => {\n      request.messages.push({ role: \"user\", content: [{ type: \"text\", text: \"Answer like a pirate.\" }] })\n    },\n  },\n})\n"
      }
    }
  ]
}
```

- `entry` (default `plugin.ts`) default-exports `definePlugin({ hooks })` from own's `./own-plugin`. Hooks: `context` (every model call: `system`, `messages`, `tools` names) and `compaction` (also `prompt`, own's compaction prompt). Edit the request in place; it is a copy without credentials or headers.
- The code may import only its own files and `./own-plugin` (relative imports need an explicit extension, e.g. `./own-plugin.ts`), and may not use `process`, `Bun`, `require`, `globalThis`, `fetch`, `eval`, `Function` or `setInterval`, nor `@ts-nocheck`/`@ts-ignore`/`@ts-expect-error`. It is typechecked against own's plugin API alone: no Node, Bun or browser APIs exist there. This is in-process code: once you approve it, it runs as you, with full file and network access, and can read your account tokens and keys. own asks before staging runs it, and you approve each version in Settings.
- Keep the prompt cache: add after the conversation, never change `system` or earlier messages, and give the same output for the same request (no counters, no time). Staging runs every hook twice on a fixed request and requires the same bytes; unless you declare `"cache": "breaks"`, it also requires the system prompt, the tools and every message before the last to stay byte for byte.
- A hook that throws or runs longer than 2 s stops the plugin in that project folder; the service goes on, and the user can turn it on again in Settings.

Staging: typecheck → tests → e2e on a fixed request → golden comparison.
