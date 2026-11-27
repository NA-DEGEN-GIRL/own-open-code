# own-import architecture (`@own/import`, plugin id and RPC id `own.import`)

Spec: `own/docs/09-session-import.md` (IM-D1–IM-D10, I1 찾기·보기 and I2 옮기기; 09 §9 the skills of other tools). Related: 01 §4 (plugin order:
own.import is the seventh and last entry, it has no hooks), 01 §6.6 (PF1/PF6: nothing at load), 02 §9 (RPC rules),
02 §9.2 `estimate.request` (own.accounts' part), 05 §13.4–13.5 (device scopes), 03 §5.9 (the screens).

## Role

Finds the conversations Codex (`$CODEX_HOME` or `~/.codex`) and Claude Code (`$CLAUDE_CONFIG_DIR` or `~/.claude`) left
for a project folder on this PC, shows them read only, and moves one into an own session on the user's request. The
other tools' folders are **read only** (IM-D2): own never writes, moves, deletes or locks a file there, never opens
their SQLite databases in place (only a private copy), never opens their login files (`auth.json`,
`.credentials.json`), and never starts `codex` or `claude`. Finding and viewing never use the network; conversation
content leaves the PC only when the user summarizes with the target model or continues an imported conversation.

## Layers

```
server.ts              source-run entry (`<repo>/packages/own-import` in a development config)
src/index.ts           options → guard 1 (OWN_OPEN_CODE=1, app version) → Singleton.acquire → ImportRpc.register;
                       the control instance forks the one activation cleanup of leftover helpers
src/build.ts           PLUGIN_ID, BUILD_ID / EXPECTED_APP_VERSION / PLUGIN_VERSION defines with dev fallbacks
src/options.ts         {home, buildId, channel, service: {url (loopback http only), password}, roots: {codex, claude}}
src/singleton.ts       the build's process state on globalThis (live instances, named slots, closed with the last one)
src/rpc.ts             service thread: the handlers every Location registers, the Worker client, the job, events
src/worker.ts          the Worker: index, viewer, searches and the full parse (one thread per process)
src/http.ts            self-HTTP to the own service (projects, sessions, import, log, messages, own.accounts RPCs)
src/sources/paths.ts   roots, the one allowlist function, Windows path matching, the only reads of a root
src/sources/codex.ts   Codex store: thread discovery (DB copy, else file scan), rollout lookup, streaming reader
src/sources/claude.ts  Claude Code store: project scan, 64 KiB lite reads, confirm pass, sub-agent files
src/index/snapshot.ts  Codex state DB: copy state_N.sqlite and its -wal to OWN_HOME/tmp, read the copy, remove it
src/index/scan.ts      project folders and membership, the index (full and quick refreshes), list pages, marks
src/index/cache.ts     memory cache by (path, size, mtime) and the content-free OWN_HOME/state/import-index.json
src/transcript/ir.ts   the common record model (Transcript.Info) both the viewer and the migration read
src/transcript/codex.ts, claude.ts, clean.ts   parsers into the IR; Claude Code harness text cleaning
src/transcript/brief.ts  the program's facts and the LLM-free checkpoint briefAt(x)
src/render/view.ts     read-only view pages (SessionMessage.Info), outline, .zst streaming and the 64 MiB LRU
src/search.ts          title search, Ctrl+F over one conversation, 내용까지 over a folder
src/render/store.ts    the stored shape (SessionTransfer.Data) of an import and of the hidden helper session
src/render/notice.ts   the fixed English import notice (the last message of an import)
src/migrate/fill.ts    zones and fill (pure, ratio only)
src/migrate/plan.ts    migrate.plan: sizing, mode rows, summarizer and R4, costs, location, warnings, nonce
src/migrate/helper.ts  the hidden helper session: import, compact once, watch, read, remove; leftover cleanup
src/migrate/execute.ts the one migration job: reading → summarizing → importing, cancel, jobs.list
src/skills/format.ts   skills (09 §9.3): what core reads of a SKILL.md, problems, notes, the one conversion, ids, keys, hash
src/skills/local.ts    skills Codex and Claude Code installed on this PC, found and read through Paths (purpose `skill`)
src/skills/git.ts      `URL로 설치`: the URL rules and git runs (blob-less clone, tree, checkout of named paths, ls-remote)
src/skills/remote.ts   previews (manifests only, nonce, temp clone) and the files of the chosen skills
src/skills/store.ts    own's own skill files: copies placed atomically, skill-imports.json, OWN_HOME/tmp/skill-*
src/skills/service.ts  the `skills.*` methods on the service thread
```

## Process state (`singleton.ts`)

A desktop bundle is one `index.js` that every Location evaluates again (and a hot reload once more), so module state
is never shared. What must be shared (the index, the Worker, plan nonces, the running job) lives in a process entry on
`globalThis` keyed by `own-open-code.import/<BUILD_ID>`: overlapping builds after a reload never share it. Plugin
instances hold the entry for their scope; the last one to leave closes it. Values live in named **slots**
(`Singleton.slot(name, create, close?)`), created synchronously on first use, so every evaluation of the bundle that
names a slot reaches the same value and two instances never both create it. `home` is the first instance's;
`options()` is the latest instance's, so a changed config applies to the next call. Acquiring is free: no file is read
and no Worker starts until the first `sources.list` or `sessions.list` (PF1/PF6). The slots in use: `worker` (the
`rpc.ts` host: live instances, Worker client, self-HTTP, job, cleanup state) and `plan.nonces`.

## RPC and the Worker (`rpc.ts`, `worker.ts`, 09 §5)

- **Registration.** Every Location registers `own.import` (`Portable.definition(OwnImport.Definition)`, like the other
  own plugins) over the same singleton. The **leader** publishes `index.changed`, `job.progress` and `job.finished`:
  the control Location's instance when it exists, else the oldest live one (02 §9.1). An instance is the control one
  when its directory is `Home.layout(home).control` (normalized string compare, no I/O at load).
- **Handlers never throw** (02 §9.4). `health` answers from memory (`{version, features, workerReady}` with the
  features `view`, `search` and `migrate`) and never starts the Worker. `sources.list`, `sources.configure`,
  `sessions.list`, `sessions.read` and `sessions.search` go to the Worker; the answer crossed a thread, so it is decoded
  once here with the method's output schema, and a failure becomes the method's declared error or `internal_error`.
  `sessions.list` keeps its 2 s while the Worker starts or scans: past 1.9 s it answers an empty `scanning` page itself
  and publishes `index.changed` for the folder once the Worker answers. `migrate.*` and `jobs.list` answer on the
  service thread.
- **The Worker** is one per process, started by the first forwarded call and unreferenced (it never keeps the service
  alive). Source runs start `worker.ts` next to `rpc.ts`; a release bundle carries the Worker's bundled source as the
  define `OWN_IMPORT_WORKER_SOURCE` and starts it from a Blob URL (own-computer-use's driver workers do the same), so
  the bundle stays one `index.js`. Messages: `hello` (OWN_HOME), `call` (a method or `source`, with the current plugin
  options), `cancel`, `reply` (the service thread's answer to the Worker's `ctx.worktree.list` question) and `close`
  (flush `import-index.json`, then end). An unexpected end fails the pending calls with `internal_error`, sets
  `workerReady` false and starts it again once; after a second end the methods answer `internal_error` until the
  service restarts.
- **`source`** is not an RPC method: the Worker's full parse of one conversation (Codex `history_base` prefix
  included, `basePartial` when it could not be read to its end), the folder's project and the earlier imports. The
  plan and the job read it; it stays unredacted because the plan and the stored shape redact it themselves. Its
  earlier imports are always read again (`sessions.read` reuses its marks for 5 s), so a plan right after an import
  offers 열기 / 새로 가져오기.
- **Scopes** come from `@own/protocol/rpc-import-routing` (`OwnImportRouting.MethodScope`, decided with Q2,
  2026-10-08): `health`, `sources.list`, `sessions.list`, `sessions.read`, `sessions.search` and `jobs.list` are
  `read`; `migrate.plan`, `migrate.execute` and `migrate.cancel` are `prompt`; `sources.configure` is `local`. One
  call's input can raise it (`OwnImportRouting.scopeOf`): `scope: "all"` (every conversation on the PC, the `모든 폴더`
  view and its reads and imports) and `migrate.plan{redact: false}` are `local`. Every method goes to the control
  location; every event is `read` with origin `global`. The phone gateway decides from the same functions and refuses
  every `own.import` call on `/srv/<hostId>` (own-remote `gateway/policy.ts`); it also refuses a device's session
  create, import or update whose metadata carries the helper marker (`own.import.helper`), which the activation
  cleanup would delete.
- **Reach** (09 §5.5): `sessions.read`, `sessions.search{ref}` and `migrate.plan` name the `directory` the list was
  opened for, and the conversation must be one of that project's (`Scan.Service.member`: one of its folders, or a
  sub-agent's parent's) unless the input says `scope: "all"`; one outside is `source_not_found`, as if unknown. A
  job's `source` read names no folder: its plan checked it.

## Roots and the allowlist (`sources/paths.ts`, 09 §2.1)

- **Roots.** Per kind: the plugin option `roots.<kind>` when given (even empty: tests always set it), else the
  environment variable, else the profile folder (`.codex`, `.claude`), plus the added roots of
  `OWN_HOME/state/import-sources.json` (`{schemaVersion: 1, extraRoots: [{kind, directory}]}`, read and written
  atomically through own-runtime `Store.JsonFile`; an unusable file adds nothing and is never rewritten). A root's
  `rootID` is `codex-<12 hex>` or `claude-<12 hex>` of sha256(kind, normalized folder): stable, never a path.
  `problem(root)` answers `missing`, `unreadable` or `path_denied` (relative, a network share, or a never-read folder
  such as `.claude\file-history`; `Paths.denied` without I/O). A denied root is listed but never scanned, and `check`
  refuses its files, whether it came from an option, the environment (`CODEX_HOME=\\server\share\…`) or a
  hand-edited `import-sources.json`. Each root's real path is resolved once per process (IG5).
- **`check(root, file, purpose)`** is the one allowlist function. `purpose` is `read` (conversation files), `copy`
  (only `state_N.sqlite` and its `-wal`, only for the snapshot) or `list` (folders). The path must lie below the root,
  match the kind's pattern for the purpose and not be on the never-open list; then its **real path** (junctions
  resolved) must lie below the root's real path and pass the same checks, so a junction can neither leave the root nor
  reach a never-open file under an allowed name. Anything else is `path_denied`; a path that does not exist is
  `missing`.
  - Codex read: `sessions\YYYY\MM\DD\rollout-*.jsonl[.zst]`, `archived_sessions\rollout-*`, `session_index.jsonl`.
    Never: `auth.json`, `config.toml`, `history.jsonl`, `thread_history_*`, `sqlite\`, `*-shm`, `*.lock`,
    `thread-writer-locks\`.
  - Claude Code read: `projects\<folder>\*.jsonl`, and in a conversation's folder `custom-title.json`,
    `tool-results\*` (opened only when the viewer asks) and `subagents\**\agent-*.jsonl` with `*.meta.json`. Never:
    `.credentials.json`, `sessions\`, `history.jsonl`, `file-history\`, `shell-snapshots\`, `projects\*\memory\`.
  - Anywhere: `auth.json`, `.credentials.json`, `*.key`, `*.pem`.
- **File operations** (`withFile`, `read`, `chunks`, `stat`, `list`, `folderExists`) are the only reads of a root;
  everything else in `src` goes through them (the hygiene test enforces it, with `index/snapshot.ts` as the one other
  module that touches files; own's own files under OWN_HOME go through `@own/runtime`). Files are opened read-only
  with `fs.promises.open(real, "r")`; Bun on Windows opens with read, write and delete sharing, and `withFile` closes
  the handle before it resolves, so no handle is held between calls. Measured with Bun 1.4.2 on this PC: a file own
  holds open can be deleted by another handle and its name is gone at once (`paths.test.ts`); reading through the
  handle still works until it closes. A `.zst` streamed through `chunks` keeps its handle for the length of the
  stream only (⚠IG1).
- **`Paths.observe`** gives tests every allowlist decision (`open`, `stat`, `list`, refused ones included); production
  has no listener.

## Windows paths (`norm`, `same`, `inside`, 09 §2.2)

`norm(p)` decodes `file://` URIs, turns `/` into `\`, strips `\\?\` (and maps `\\?\UNC\` to `\\`), collapses repeated
separators, resolves `.` and `..` (never above a drive root or a UNC share), drops a trailing separator except on a
drive root and applies NFC; the case is kept and `key(p)` lowers it for comparison. `same` and `inside` compare
`fs.realpathSync.native` results when both paths exist (junctions, `subst`, 8.3 names) and the normalized strings
otherwise; tests inject the realpath for `subst` (no drive is mapped on this PC). Claude Code's encoded folder names
(`D---Projects-own-open-code`) only pick candidates (`claudeCandidate`); membership is always the cwd recorded in
the file.

## Codex state DB snapshot (`index/snapshot.ts`, 09 §2.3)

`locate(root)` stats the highest-numbered `state_*.sqlite` (by number, not a fixed `_5`) and its `-wal`. `read` copies
both (never `-shm`) through `Paths.withFile(…, "copy")` into `OWN_HOME/tmp/import-<random>/`, copies again when
either file's size or mtime changed during the copy (at most 3 tries; a `-wal` that disappeared leaves no stale copy),
opens the copy with `bun:sqlite` `{readonly: true}`, checks the 09 §2.3 columns of `threads` and `thread_spawn_edges`,
reads both tables (statements finalized, the copy closed) and removes the folder before resolving. The copy holds
titles, so it never outlives the read. Any failure (no DB, a damaged copy, other columns, a DB that keeps changing)
answers `undefined` and the caller falls back to the file scan. The original is never opened by SQLite: opening a WAL
database in place, even read-only, creates or changes `-shm`/`-wal` beside it and takes a shared lock. The returned
stamp lets the index skip copying again while nothing changed.

## Transcript IR and parsers (`transcript/*`, 09 §2.4–§2.7)

Effect Schemas `Transcript.{Info, Source, Turn, Step, Checkpoint, Line, ChildRef, DropKind, Dropped, Usage}`. A turn is
one real message from the human and the steps until the next (`text`, view-only `reasoning-summary`, `tool` with
input, output, exit code, per-file `FileDiff.Info` and a child link, `note`). A checkpoint sits after the original
record (`{uuid}` or `{ordinal}`) inside a turn at `{turn, step}`, because tools compact mid-turn; its `kind` is
`foreign` (summary text) or `codex-remote` (encrypted). `dropped` counts what the parsers left out by kind. Parsers
decode foreign records once and build typed values; an `Info` crossing the Worker boundary is decoded once with
`Transcript.decode`. `repairTimes` makes turn and step times monotonic (a missing or backward time becomes the
previous + 1 ms). `contentHash(turns)` is sha256 over the normalized IR (sorted keys, no `undefined`, NFC, `\n` line
ends), so a source that only grew keeps the hash of its first turns. Later IR changes were additive (IMP.14).

- **Codex** (`sources/codex.ts`, `transcript/codex.ts`): threads from the DB copy (rollouts matched `.jsonl` →
  `.jsonl.zst` → `archived_sessions`; a row without a file is `missing`), else the file scan (date folders stat only,
  the first line up to 64 KiB for `session_meta`); a reverted thread's two files grouped by thread id (the one no
  other file names as `history_base`, else the newest); duplicates across roots removed by thread id. The reader
  streams `.jsonl` and `.zst` (`node:zlib` `createZstdDecompress`, never written to disk), skips lines over 32 MiB and
  a torn last line, and looks a file up once more when Codex compresses or restores it meanwhile. Turns come from
  `response_item`s (legacy and paginated), tool pairs by `call_id`, injected context filtered by
  `content_item_kinds` or the leading-tag list, local compactions as `foreign` checkpoints (summary without
  `SUMMARY_PREFIX`), remote ones as `codex-remote` with the kept user requests as `recent`.
- **Claude Code** (`sources/claude.ts`, `transcript/claude.ts`, `transcript/clean.ts`): top-level `<uuid>.jsonl` per
  project folder, lite read of the first and last 64 KiB (provisional membership) and a confirm pass that streams
  the whole file for the cwd keys without parsing JSON. The chain, title and first-prompt rules are ported from the
  Claude Agent SDK for Python (MIT); beyond it the walk follows `logicalParentUuid` across compactions, re-attaches
  parallel results from sibling branches, places `compact_boundary` checkpoints mid-turn and turns human
  `queued_command`s into turns. `clean.ts` removes the harness wrappers and the compact summary's harness phrases
  (counted as `boilerplateUnmatched` when a phrase is not found).

## Index and list (`index/scan.ts`, `index/cache.ts`, `http.ts`, 09 §2.2–§2.3, §2.8, §4.7)

- **Project folders** (IM-D3): the folders core recorded for the project (`project.list`'s canonical folder and
  sandboxes over self-HTTP, `ctx.worktree.list({projectID})` asked through the service thread) plus what
  `git worktree list --porcelain` reports in each of them (`Bun.spawn`, hidden window, timeout, read only), so two
  clones of one root commit and the linked worktrees of both count. `directory_unknown` when the input folder is not
  one of them.
- **Scanning**: nothing at load; the first list scans every root. Codex refreshes copy the DB again only when its or
  its `-wal`'s size or mtime changed, otherwise they list the recent date folders; Claude Code is re-listed by folder
  and file mtime. No file watchers. A list within 5 s of the last refresh reuses the index (warm list);
  `sources.configure` forces a full scan of the roots at once.
- **The list**: answers within 2 s (`scanning: true` with the rows found so far, then `index.changed`; the service
  thread answers the Worker's last answer to the same input when the Worker itself is late, and the imported marks
  past the budget are the list's last ones, so a slow Worker or session list never loops the screen through
  `index.changed`); the title query matches the title as shown (`Redact.named`); newest first,
  50 per page with an opaque cursor; `scope` `folder` or `all` (grouped by cwd, Claude Desktop `projects/ssh-*` only
  there as `otherComputer`); `include` sub-agents, `codex exec` runs and archived threads. **Imported marks** come
  from the project's root sessions (`GET /api/session?project=…`, archived ones included): `own.import` import
  metadata, helpers never counted, one import per `(sourceID, importedAt)` because core copies metadata into forks;
  `newTurns` once the source was fully parsed in this process and the planned prefix hash still matches. `fresh` =
  top-level, readable and not imported (the sidebar's `새 N개`).
- **Cache**: a memory map by `(path, size, mtimeMs)` holds titles and first prompts (the user's content stays in
  memory); `OWN_HOME/state/import-index.json` holds only path, size, mtime, kind, ids, normalized cwds, parent,
  sub-agent and exec flags, times and versions, written atomically. Never core KV or plugin storage.

## Viewer and search (`render/view.ts`, `search.ts`, 09 §3)

- `sessions.read` pages (20 turns by default) are `SessionMessage.Info` in their encoded form and create no session:
  user and assistant text, tool parts under v2 renderer names when the input fits (else the original name for
  `GenericTool`), diffs from Codex FileChange and Claude `structuredPatch`, reasoning summaries, notes as synthetic
  notices, the tool's compactions as completed `compaction` messages at their mid-turn place, `idle` per finished
  turn; `metadata["own.import.view"]` ties each message to its turn. The outline (turns, checkpoints, children,
  rolled-back and other-branch counts, `Token.estimate`) is built by the first full read.
- Size (IG4): a full parse keeps every turn in memory (tool output and images too) and crosses to the service thread,
  so past `Paths.PARSE_BYTES` (512 MiB decoded) it is `source_unreadable{too_large}`: a Claude Code file (its viewer
  and its import, decided from `stat` before reading) and a Codex rollout's import parse (`history_base` prefix
  included). The Codex viewer streams any size.
- Codex rollouts stream one turn at a time with in-memory turn offsets: a `.jsonl` page is read again from its offset,
  a `.zst` page is decoded from the start with the earlier lines skipped unparsed; the first page answers as soon as it
  is decoded while the outline keeps streaming until `outlineComplete`. Claude Code files are parsed whole and paged
  (a `<persisted-output>` preview replaced by its `tool-results` file on show). Decoded turns live in one LRU of
  64 MiB (⚠IG5); every read is cancellable.
- Search: titles and first prompts in memory (`sessions.list{query}`); Ctrl+F over one conversation, tool output
  included (`sessions.search{ref}`, one hit per turn); `내용까지` over a folder, user and model text only, at most 100
  hits within 5 s, `complete: false` plus a cursor that resumes. Snippets are at most 160 characters.
- **Redaction** (IG10, the precondition of the `read` device scope): view pages, search snippets and the list's titles
  and first prompts show secrets as `[redacted:<label>]` (`Redact.named`).

## Migration (`migrate/*`, `render/store.ts`, `transcript/brief.ts`, 09 §4)

- **Plan** (`migrate.plan`): sizes the Worker's full parse against the target's own window, never substituting the
  target (IG9, 07 R4). `r = (Z + E(V) + notice) / ceiling` decides alone; Z, one exchange `x`, the window, the
  ceiling, the remaining quota and the costs come from own.accounts `estimate.request` over self-HTTP, asked with
  `accounts.list` at own.accounts' control Location (`Home.layout().control`, 02 §9.1; the slot samples are the
  process's, so that answer covers every Location) (null costs and the catalog window when own.accounts is missing or
  fails). A target account own.accounts lists as unable to run (needs a login, misconfigured, disabled; not a used-up
  window) is `target_unavailable{account_not_ready}`, at plan and again at execute. Mode rows follow the 09 §4.3 table (`full` recommended
  when V fits and for a `codex-remote` boundary, else `summary` with `llm` when available, else `brief`). The
  summarizer follows core's precedence (a native session model compacts natively → `native_compaction`; else the
  hidden `compaction` agent's model read from the import Location's `/api/agent/compaction` → `summarizer_overridden`;
  else the target); a summarizer that is another subscription of the target's company is refused
  (`same_company_subscription`, one ChatGPT login's `codex` and `siwc` count once). Location default = the last cwd
  (the project root when gone) with its branch from `/api/vcs`; `store.full` defaults to true (Q3). The nonce lives
  10 minutes, single use, in the `plan.nonces` slot; it is the plan's only side effect.
- **Fill** (`fill.ts`): newest turns verbatim while they fit `C = ceiling − (Z + |checkpoint| + notice + x)`, a turn
  split by steps when the newest alone does not fit; no constant threshold anywhere.
- **Stored shape** (`store.ts`): `SessionTransfer.Data` that decodes with `@opencode/schema`: per model-visible turn
  `user`, one `assistant` per text step (display provider `codex-cli` / `claude-code`, never tokens, cost, provider
  state or reasoning), one user-role `synthetic` `<imported-tool-activity>` record per tool step and note (inputs up to
  16 KiB, each result up to 64 KiB), `idle`; turns the model does not see in the short shape; the boundary as a
  completed `compaction`; the notice last. Secrets become `[redacted:<label>]` with counts per label; the body budget
  is 32 MiB (`trimmedTurns`, `import_too_large`). Deterministic: the same transcript and options give byte-identical
  model-visible messages (IG7).
- **Brief** (`brief.ts`): changed files, the last 20 commands with exit codes, the last plan input, the stop point;
  `briefAt(x)` = the last cleaned foreign summary before x + the brief, `recent` = the user requests before x up to
  20k tokens as `[User]:` lines.
- **Job** (`execute.ts`): one per service (`job_busy`; a busy execute leaves the nonce valid). `reading` re-reads the
  source and compares the planned turns' `contentHash` (growth by appending is fine, any other change is
  `source_changed`); `summarizing` runs the helper only for an LLM summary; `importing` posts the final
  `SessionTransfer.Data` (`POST /api/experimental/session/import`, the chosen folder as the payload location). Events
  `job.progress` and `job.finished` carry no content. A cancel before the final import interrupts and removes the
  helper and leaves nothing; after it the answer is `{cancelled: false}`. Nothing is retried and no other account is
  asked (07 R4).
- **Helper** (`helper.ts`, IM-D7): imports the part before the tail as an archived session H (metadata
  `own.import = {v: 1, helper: true, jobID}`, model = the target), admits one manual compaction with
  `ctx.session.compact`, then watches H's compaction messages every second
  (`GET /api/session/:id/message?type=compaction&order=desc`) until a compaction H was not imported with completes or
  fails (no new compaction within 2 minutes of the admission counts as failed), reads
  `{summary, recent, model, cost, tokens}` and removes H with `ctx.session.remove` in every outcome. It watches
  messages because the service writes no durable session events unless `events.persist` is on, so the experimental
  session log never shows the end; the log-following path (`end: "log"`) is kept for the helper's unit tests. Failure
  causes map to `summary_failed{exhausted | needs_reauth | overflow | interrupted | other}`.
- **Activation cleanup** (`rpc.ts` `cleanup`, 09 §4.4): once per process, after the control Location's instance
  activated, every session whose metadata has `own.import.helper` is interrupted and removed (sparing a running
  job's). The service may still be starting, so a list it does not answer is asked again (10 tries, 3 s apart). A
  request core's recovery sent before that can still spend usage, which own.accounts records (⚠IG8).
- **own.accounts' side** (no code here): `estimate.request` (02 §9.2) and the exclusion of sessions marked
  `own.import` (imports and helpers) from Z and local-window measurement (`OwnImportRouting.marked`).

## Skills (`skills/*`, 09 §9)

- **Found skills** (`local.ts`): Codex `<root>\skills` (its `.system` too) and Claude Code `<root>\skills`, plus Claude
  Code plugin skills under `<root>\plugins\cache\<market>\<plugin>\<version>\skills` (installed) and
  `<root>\plugins\marketplaces\<market>\…\skills` (a marketplace's copy; an installed plugin's skill hides it).
  The roots are the conversation roots (`Paths.roots`); every listing, stat and read goes through `Paths` with the
  purpose `skill`, which allows only those areas and still never opens a never-open name. A skill is a folder with a
  `SKILL.md`; walks stop there. Links, secret-looking files (`.env`, `*.pem`, …), never-open names and size limits
  (500 files, 20 MiB) make a skill incompatible without reading those files. A list reads names, sizes, `SKILL.md` and
  `agents/openai.yaml`; only skills own-import copied are read whole (their hash against the record).
- **Format** (`format.ts`, pure): gray-matter 4.0.3 with core's colon retry (`packages/core/src/config/markdown.ts`),
  without gray-matter's content cache (it keeps a failed parse's empty result for the same text). The fields core reads
  (`name`, `description`, `metadata`, `disable-model-invocation`) pass; display and permission fields are notes;
  `hooks`, `context: fork`, `` !`…` `` in the body, `${CLAUDE_SKILL_DIR}`-style variables and `$ARGUMENTS` are problems.
  A Codex `agents/openai.yaml` with `policy.allow_implicit_invocation: false` converts: the copy's frontmatter gets
  `disable-model-invocation: true` first. The hash is sha256 over the sorted relative paths, sizes and bytes.
- **Copies** (`store.ts`, the one writer in `src/skills`): `<skillsDir>\<id>` (option `skillsDir`, else
  `%OPENCODE_CONFIG_DIR%\skills`; none = `skills_unconfigured`), staged in `OWN_HOME\tmp\skill-stage-*` and renamed
  into place; a replace moves the old folder aside and restores it on failure. `OWN_HOME\state\skill-imports.json`
  (own-runtime `Store.JsonFile`) holds one row per copy without content; a row whose folder is gone no longer counts.
  An existing folder is `skill_conflict`, replaceable only when a row owns it.
- **Git** (`git.ts`, `remote.ts`): only on `skills.preview`, `skills.install` and `skills.updates`. `https:` only
  (`http:` to a loopback host for the tests), no user info; credential helpers, prompts, LFS smudging and symlinks off,
  and Git for Windows' system-wide `core.autocrlf` and `core.fscache` too (CRLF copies; with fscache the checkout's
  lazy fetch is not seen and fails with `unable to read sha1 file`, reproduced on this PC);
  `protocol.allow=never` with https (and loopback http) allowed. The preview clones `--filter=blob:none --no-checkout
  --depth 1`, lists the tree, checks out only the manifests (`marketplace.json`, `plugin.json`, each `SKILL.md` and
  `agents/openai.yaml`) and keeps the clone under `OWN_HOME\tmp\skill-git-*` with a 10-minute nonce (slot
  `skills.nonces`); a server that ignores the filter is `no_partial_clone` and the clone is removed at once. The install
  checks out the chosen skills' files at the previewed commit and copies them; the clone goes with the nonce, on expiry
  or when the singleton closes. `skills.updates` asks `git ls-remote` for a git copy's ref.
- **Scopes**: `skills.list` is `read`; the other four are `local` (09 §9.6). The handlers run on the service thread
  (`rpc.ts` `skill`), never in the Worker; a throw becomes `internal_error` with a fixed log line (`skills_failed`).

## Privacy and logs (IG10)

Logs are one JSON line on stderr with a fixed message and counts (`guard_failed`, `worker_restarted`,
`worker_stopped`, `helpers_removed`, `helper_cleanup_failed`): never conversation content, a path or the service
password. `import-index.json` holds no content (a test greps it for fixture sentinel text). The DB copy never outlives
its read: `read` removes it, and the first scan of a process sweeps `OWN_HOME/tmp/import-*` folders older than
`Snapshot.STALE_MS` (10 min) that a terminated Worker or a killed service left. `Redact.named` hides pattern secrets
and the values of secret-named fields (JSON keys, assignments, keys at a line's start: `password=…`,
`"refresh_token": "…"`, `OPENAI_API_KEY=…`). The service password goes only into `Authorization` of loopback
requests.

## Release bundle (FORK §8.2)

`packages/own-remote/script/bundle.ts` builds own-import as the sixth desktop bundle (`DESKTOP_PLUGINS`, last) with the
three release defines; `IMPORT_WORKER` bundles `src/worker.ts` first (minified, same defines) and passes its text as
`OWN_IMPORT_WORKER_SOURCE`, so `plugins/own-import/index.js` is still one file. own-import is a build-id input
(`OWN_PACKAGES`). It is not in `REMOTE_PLUGINS`: an SSH host never carries it in v1. own.accounts trusts the bundle
(`plugins/inventory.ts` `OWN_PACKAGES`), the launcher manages it last (`own.ps1` `$ManagedPlugins`), and release-smoke
calls only `own.import health` (never a method that scans this PC's stores).

## Tests

Run from `packages/own-import` only: `bun typecheck`, `bun test test/unit` (also `bun run test:unit`), `bun run
test:e2e` (real servers booted from source, a 15-minute timeout per test), opt-in `bun run test:perf`
(`OWN_IMPORT_PERF=1`, an idle PC; results in `own/.out/import-perf/ig5-<time>.json`).

- `bunfig.toml` preloads `test/preload.ts`: `CODEX_HOME` and `CLAUDE_CONFIG_DIR` point at an empty temp folder and
  `OWN_HOME` at another, so a test that forgets its fixture roots can never reach the user's stores.
- **Fixtures are synthetic** (09 §7.3): `test/fixtures/make.ts` writes roots into a temp folder (JSONL with a torn last
  line, `.jsonl.zst`, rollout and Claude project paths, a WAL state DB with an un-checkpointed `-wal`, never-open
  sentinels holding `SENTINEL` and obviously fake keys); `test/fixtures/{codex,claude}.ts` build each format's cases
  from the documented formats. Nothing is copied from real files.
- `test/support/guard.ts` (IG1): lists every root (size and mtime) before and after, watches them with `fs.watch` and
  records the allowlist's reports; it fails on any create, rename, write, delete, a new `-wal`/`-shm`/`-journal`
  sibling, and on an open or stat of a never-open file.
- **Unit** (`test/unit`): `paths`, `snapshot`, `ir`, `hygiene` (no `codex`/`claude` launch, files touched only by
  `paths.ts` and `snapshot.ts`, and own's skill files only by `skills/store.ts`, loading reads nothing), `skill-format`,
  `skills` (fixture skill roots, IG1 guard), `skill-git` (`git http-backend` on 127.0.0.1, `test/support/git-server.ts`;
  180 s per test: every git run takes about a second on this PC), `codex-source`, `codex-transcript`, `claude-source`,
  `claude-transcript`, `clean` (IR snapshots per format and version family, IG2), `scan`, `membership`, `cache`,
  `http` (fake HTTP server), `view`, `search`, `brief`, `fill`, `store` (decodes with `@opencode/schema`, IG7),
  `notice`, `plan` (several windows, no constant threshold, R4, IG9), `helper` (log and message watch, failures,
  cancel, cleanup), `execute` (one job, source checks, cancel).
- **E2E** (`test/e2e`, own-team's real-server harness with `importer: true`: own-accounts and own-import from their
  package folders, roots from the fixtures, the server's `CODEX_HOME`/`CLAUDE_CONFIG_DIR` at empty temp folders, git
  repositories made with `git -c …` only): `i1.e2e.test.ts` (list, read and search through RPC, IG1 guard over the
  roots for the whole suite, IG3 with real repos, worktrees, two clones, a junction, Hangul and `#` folders and a gone
  folder, IG10 sentinels absent from OWN_HOME, `import-index.json` and the logs, the Worker restart),
  `migrate.e2e.test.ts` (plan, execute, cancel and jobs over the e2e-kit fakes per slot kind: IG7, IG9, IG10, the
  automated part of IG12, `source_changed`, `nonce_invalid`, `job_busy`), `helper.e2e.test.ts` (IG8: an archived
  helper's manual compaction, `agents.compaction.model` as summarizer, a kill during the compaction leaving no helper,
  a native summarizer refused).
- **Perf** (`test/perf/ig5.perf.test.ts`): 3,500 synthetic rollouts and 1,300 Claude Code files through the real
  server (first list within 2 s, cold index within 5 s, warm list within 300 ms, `health` p95 within 50 ms during the
  scan) and a ~1 GB-decompressed `.zst` in process (first page within 500 ms, outline completion and last-turn jump
  recorded, LRU within 64 MiB).
- own-web's screens have their own Edge suite (`packages/own-web`, `bun run test:e2e:import`).

## Status (IMPORT, 2026-10-09)

I2 (옮기기) is implemented and I1 (찾기·보기) is implemented with its end condition open (IMPORT waves 1–7 and the
review fixes): the IG5 cold full index (≤ 5 s) passed one run in three on a busy PC in wave 7 (three more after the
review fixes, on the same busy PC, all passed at 4.1–4.2 s), and the gate counts only an idle-PC run (`bun run
test:perf`) before I1 is done; if that goes over, the scan needs a cheaper cold path. Also open:
the user-run IG12 real-provider check and the IG13 check against this PC's real stores, and the ⚠ items of 09 §7.4
(IG1 delete sharing while a `.zst` streams, the IG4 throughput target, the IG5 outline and last-turn targets, the IG8
recovery race).
