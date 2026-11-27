---
name: "imagegen"
description: "Generate or edit images when the task benefits from AI-created visuals such as photos, illustrations, textures, sprites, mockups, transparent-background cutouts and, with GPT Image 2.6, short animated GIF loops and new SVG vector art. Use when the user wants a brand-new image, a change to an existing image, or variants from references. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
---

# Image Generation Skill (own)

Generates or edits images for the current task or project (website assets, game assets, UI mockups, product mockups, wireframes, logo exploration, photorealistic images, infographics).

## own's image tool

There is one way to make images here: own's `image_generate` tool.

- It makes one image per call through the user's OpenAI API key accounts, which own keeps in its vault. Never ask the user for a key, never put a key in a shell command or file, and never write scripts that call an image API yourself.
- When every API key is used up, own may make the image through one of the user's ChatGPT subscriptions instead. That path uses the subscription's own model (shown in the result), not the one you chose.
- Each call returns the saved file's path, the model, the account it used and its cost. The image itself is part of the result, so you can see it: a GIF as its first frame only, an SVG not at all (read the saved file for its source). The user sees the whole result in the card.

If `image_generate` is not in your tool list, the user has not turned it on. Do not try another way. Tell the user, in the language they use (in Korean: 해요체), how to turn it on, for example:

> 이미지를 만들려면 설정 > 이미지 만들기에서 `모델에 이미지 만들기 도구 주기`를 켜 주세요. OpenAI API 키가 없으면 같은 곳의 `OpenAI API 키 추가`로 넣을 수 있어요.

If the tool answers that no account can make images right now (every API key and subscription is switched off, used up, at its limit or failing), relay that plainly and stop, for example:

> 지금 이미지를 만들 수 있는 계정이 없어요. 카드에 계정마다 이유가 있어요. 설정 > 이미지 만들기에서 계정을 켜거나 OpenAI API 키를 추가한 뒤 다시 요청해 주세요.

Do not retry, and do not try another way to make the image, until the user says something changed.

{{MODEL_SECTION}}

### Arguments

- `prompt` (required): the full spec (see the prompt schema below).
- `images`: paths of images to edit or to use as references, in order. Attached images have a file path in the message; images you made earlier have the path the tool returned. Relative paths are from the project folder. Up to 8.
- `path`: where to save the result, when the image is for the project. The extension follows the real format. Without it, the image is saved in own's image folder and stays in the conversation.
- `quality`: `low`, `medium`, `high` or `auto`. Leave it unset to use the user's default; use `low` only for quick drafts the user asked for.
- `size`: `1024x1024`, `1536x1024`, `1024x1536` or `auto`. Leave it unset unless the use needs a shape.
- `background`: `transparent` for cutouts and transparent assets, otherwise leave it unset.
- `complexity` (only when the tool lists it, GPT Image 2.6): `low`, `medium` or `high` planning before rendering, apart from `quality`. See the complexity notes above; leave it unset when unsure.
- `output_format`: `png` (the default), `jpeg` or `webp`, and where the tool lists them `gif` and `svg` (see Formats above). Leave it unset for an ordinary image.
- `frame_count`, `frame_duration_ms` (GIF only): the loop's frames (2-16, OpenAI's default 9) and milliseconds per frame (20-2000, default 200). For a GIF, `size` is each frame's shape and the tool lowers it to fit the frame count (at most 960x960 for 2-9 frames; see Formats above).
- `markup` (only when the tool lists it): the path of a transparent PNG annotation layer for an edit of `images[0]` (see Markup edits above).

Every call costs money or subscription usage. Make one call per requested image or variant, do not repeat a call unless the user asks, and do not make extra variants on your own.

### Saving

- Preview or brainstorming: the result in the conversation is enough; the file stays in own's image folder.
- For the project: pass `path` (for example `public/hero.png`), or copy the saved file into the project afterwards. Never leave a project asset only in own's image folder.
- Do not overwrite an existing asset unless the user asked for a replacement; otherwise use a sibling name such as `hero-v2.png` or `item-icon-edited.png`.
- Always report the final saved path(s) and the prompt you used.

### Edits

- Pass the image to change in `images` and say in the prompt what changes and what must stay (`change only X; keep Y unchanged`).
- For several inputs, name each by index and role in the prompt (`Image 1: edit target; Image 2: style reference`).
- If an image the user means has no path you can use, ask them to attach it again.

## When to use
- Generate a new image (concept art, product shot, cover, website hero)
- Generate a new image using one or more reference images for style, composition, or mood
- Edit an existing image (lighting or weather changes, background replacement, object removal, compositing, transparent background)
- Produce several assets or variants for one task (one call each)
- Make a short animated loop (`output_format: "gif"`) or new vector art such as an icon or logo (`output_format: "svg"`), where the tool lists them

## When not to use
- Extending or matching an existing SVG/vector icon set, logo system, or illustration library inside the repo: edit those files directly
- Creating simple shapes, diagrams, wireframes, or icons that are cheaper and exact when written directly in SVG, HTML/CSS, or canvas
- Video, long animations or many-scene stories: a GIF here is a short loop of 2-16 frames
- Making a small project-local asset edit when the source file already exists in an editable native format
- Any task where the user clearly wants deterministic code-native output instead of a generated bitmap

## Decision tree

1. **Intent:** a new image or an edit of an existing one?
   - The user wants to modify an existing image while keeping parts of it: **edit**.
   - Images given only as references for style, composition, mood, or subject: **generate** with references.
   - No images: **generate**.
2. **How many:** one asset, or several assets/variants (one call each, distinct prompts for distinct assets).
3. **Where it goes:** preview only, or into the project (`path`, or copy afterwards).

Assume the user wants a new image unless they clearly ask to change an existing one.

## Workflow
1. Decide the intent (generate or edit), the number of calls, and preview vs project.
2. Collect inputs: prompt(s), exact text (verbatim), constraints and avoid items, input images with their roles.
3. If the user asked for a photo, illustration, sprite, product image, banner, or other raster asset, use `image_generate` instead of SVG/HTML/CSS placeholders. For a new icon, logo or simple illustration the user wants as editable vectors, use `output_format: "svg"` where the tool lists it. For icons, logos, or UI graphics that should match existing repo-native vector assets, edit those directly instead.
4. Shape the prompt by specificity: normalize a detailed prompt without adding requirements; add tasteful detail to a generic one only when it materially helps.
5. Choose the model (see above) and call `image_generate`.
6. Look at the result: subject, style, composition, text accuracy, invariants and avoid items.
7. Iterate with one targeted change at a time, only as far as the user wants.
8. For project work, make sure the final file is in the project and update the code that uses it.
9. Report the saved path(s), the prompt, the model and the cost the result named.

## Prompt augmentation

Reformat user prompts into a structured, production-oriented spec. Make the user's goal clearer and more actionable, but do not blindly add detail. Use only the lines that help.

Allowed augmentations:
- composition or framing hints
- polish level or intended-use hints
- practical layout guidance
- reasonable scene concreteness that supports the stated request

Not allowed augmentations:
- extra characters or objects that are not implied by the request
- brand names, slogans, palettes, or narrative beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

## Use-case taxonomy (exact slugs)

Generate:
- photorealistic-natural — candid/editorial lifestyle scenes with real texture and natural lighting.
- product-mockup — product/packaging shots, catalog imagery, merch concepts.
- ui-mockup — app/web interface mockups and wireframes; specify the desired fidelity.
- infographic-diagram — diagrams/infographics with structured layout and text.
- scientific-educational — classroom explainers, scientific diagrams, and learning visuals with required labels and accuracy constraints.
- ads-marketing — campaign concepts and ad creatives with audience, brand position, scene, and exact tagline/copy.
- productivity-visual — slide, chart, workflow, and data-heavy business visuals.
- logo-brand — logo/mark exploration, vector-friendly.
- illustration-story — comics, children’s book art, narrative scenes.
- stylized-concept — style-driven concept art, 3D/stylized renders.
- historical-scene — period-accurate/world-knowledge scenes.

Edit:
- text-localization — translate/replace in-image text, preserve layout.
- identity-preserve — try-on, person-in-scene; lock face/body/pose.
- precise-object-edit — remove/replace a specific element (including interior swaps).
- lighting-weather — time-of-day/season/atmosphere changes only.
- background-extraction — transparent background / clean cutout (`background: "transparent"`).
- style-transfer — apply reference style while changing subject/scene.
- compositing — multi-image insert/merge with matched lighting/perspective.
- sketch-to-render — drawing/line art to photoreal render.

## Prompt schema

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

- Keep it short; add only details that materially improve the prompt.
- For edits, list invariants explicitly (`change only X; keep Y unchanged`).
- If a critical detail is missing and blocks success, ask; otherwise proceed.

## Examples

### Generation (hero image)
```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy if needed
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

### Edit (invariants)
```text
Use case: precise-object-edit
Asset type: product photo background replacement
Primary request: replace only the background with a warm sunset gradient
Constraints: change only the background; keep the product and its edges unchanged; no text; no watermark
```
