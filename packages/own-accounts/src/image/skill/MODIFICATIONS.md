# Modifications

This folder is a modified copy of the `imagegen` skill bundled with OpenAI Codex (Apache License 2.0, `LICENSE.txt` in
this folder); own-open-code changed it as listed below.

- Upstream: https://github.com/openai/codex, `codex-rs/skills/src/assets/samples/imagegen` at commit
  `84aa75204ad604bcf498df180d128181c89b2f0b` (the newest commit touching that folder in the clone of 2026-11-03).
- Who and when: own-open-code (the OpenCode 2 fork this folder is part of), 2026-11-03 (decisions IM).
- What own ships: own-accounts registers `SKILL.md`, then `prompting.md` and `sample-prompts.md`, as one built-in
  skill `imagegen` (`/builtin/own/imagegen.md`, `src/image/skill.ts`). `LICENSE.txt` and this file are not part of the
  skill text; they stay next to it in the source and in every copy of it.

| File | Change |
| --- | --- |
| `SKILL.md` | Rewritten for own: the only path is own's `image_generate` tool (OpenAI API key accounts from own's vault, then a ChatGPT subscription when every key is used up). Codex's built-in `image_gen` tool, the `scripts/image_gen.py` CLI fallback, `OPENAI_API_KEY` in shells, `view_image`, `$CODEX_HOME` save paths and the CLI-only sections are gone. New: what to say when the tool is off or has no key (설정 > 이미지 만들기), the tool's arguments, own's save and edit rules (images by path, `path` for project files), and a model section filled from the user's setting (GPT Image 2.6 Flare or Sunburst per image, or a fixed model; since 2026-11-06 also the 2.6 `complexity` notes and argument, decisions IM-17; since 2026-11-08 the `Formats` section (`output_format` png, jpeg, webp and with 2.6 an animated gif and svg, `frame_count`, `frame_duration_ms`, what the model sees of a GIF or an SVG, costs, API keys only) and the `Markup edits` section (`markup`, how the layer is made), their argument lines, GIF and SVG in the description and "When to use", and "When not to use" narrowed to editing existing vector assets, hand-written simple shapes and video, decisions IM-21..IM-25; since 2026-11-09 the GIF frame sizes that fit each frame count and the SVG authoring model with its cost in the cost shown, decisions IM-32, IM-34). The intent, taxonomy, augmentation, schema and examples are kept, shortened where they named the CLI. |
| `prompting.md` | Was `references/prompting.md`. The two-mode intro, the CLI quality notes and the "fallback-only execution controls" section are replaced by the tool's own controls (`quality`, `size`, `background`; since 2026-11-08 also `output_format` and `markup`); links to other reference files now point at the parts of the same skill text. |
| `sample-prompts.md` | Was `references/sample-prompts.md`. The two-mode intro, the CLI model notes and the CLI wording are replaced by the tool's arguments; the recipes are unchanged. Since 2026-11-08 three own recipes: an SVG icon, an animated GIF loop and a markup-guided edit (the last after OpenAI's image generation guide example). A closing line names the source and this file. |
| `LICENSE.txt` | Unchanged (line endings LF). |

Not copied: `references/cli.md`, `references/image-api.md`, `references/codex-network.md`, `scripts/`, `agents/`,
`assets/` (CLI fallback, Codex app metadata and icons).
