// The skills import's design fixture for the tools e2e (SK2, 2026-10-24; 09 §9.2), made-up skills in the suite's fake
// home only. Codex's default home: `pdf` and `backup\pdf` (the same), `.system\skill-creator` and `.system\imagegen`,
// `_common\brand` with the junction `brand-link` onto it, the junction `3d-assets` onto a folder outside the roots,
// `hostile` (a SKILL.md with a script, an event handler and a remote image), and `.trash`/`.staging` folders. A fake
// codex-multi-provider control center (state.json, a sentinel auth.json per account): account 01 `work` with the same
// `pdf` and `skill-creator`, 02 `side` with another `pdf` (version 2.0.0), 03 whose `skills` is a junction onto the
// default home's. Claude Code's personal `pdf` (the same, core loads it) and a Claude app synced folder.
// SK2 (2026-10-25), the round-2 review's cases: `pictures` (every way a body can ask for a remote picture, all at the
// suite's probe host), `stars` and `quotes` (bodies that held marked for seconds or overflowed its stack),
// `translate-tool` and `glossary` (the same content as skills own's skills folder holds by hand, see `ownSkills`).
import fsp from "node:fs/promises"
import path from "node:path"
import { claudeSkill, codexSkill, skillFolder, skillMd } from "../../../own-import/test/fixtures/skills"

export const PDF = {
  "SKILL.md": skillMd("pdf", "PDF 파일을 읽고 채웁니다"),
  "scripts/fill.py": "print('pdf')\n",
}

export const HOSTILE = [
  "# 위험한 본문",
  "",
  "<script>window.__skillHacked = 1</script>",
  "",
  '<img src="x" onerror="window.__skillHacked = 2">',
  "",
  "![로고](https://example.invalid/logo.png)",
  "",
  "[문서](https://example.invalid/docs)",
  "",
  "```bash",
  "echo $ARGUMENTS",
  "```",
  "",
].join("\n")

/** A body that asks for a remote picture in every way HTML has (SK2 2026-10-25), all at `probe`. */
export const pictures = (probe: string) =>
  [
    "# 그림 시험",
    "",
    `![로고](${probe}/img.png)`,
    "",
    `<table background="${probe}/table-bg.png"><tr><td background="${probe}/cell-bg.png">칸</td></tr></table>`,
    "",
    `<p><img srcset="${probe}/srcset.png 1x" alt="여러 크기"></p>`,
    "",
    `<video poster="${probe}/poster.png"></video>`,
    "",
    `<svg><image href="${probe}/svg-image.png"></image><use xlink:href="${probe}/svg-use.svg#a"></use></svg>`,
    "",
    `<div style="background-image: url('${probe}/style.png')">스타일</div>`,
    "",
  ].join("\n")

/** How many remote pictures {@link pictures} asks for. */
export const PICTURES = 8

export const TRANSLATE = { "SKILL.md": skillMd("translate", "글을 번역합니다"), "glossary.md": "용어\n" }
export const GLOSSARY = { "SKILL.md": skillMd("glossary", "용어집을 지킵니다") }

/**
 * Skills own's skills folder holds by hand (no root, no record): core loads them, so a found copy of the same content
 * is `이미 쓰는 중` (`glossary`, the same id) or says its id here (`translate-tool` = `translate`).
 */
export async function ownSkills(skillsDir: string) {
  await skillFolder(path.join(skillsDir, "translate"), TRANSLATE)
  await skillFolder(path.join(skillsDir, "glossary"), GLOSSARY)
}

export async function skillsWorld(home: string, codex: string, claude: string, probe: string) {
  const center = path.join(home, "control-center")
  const elsewhere = path.join(home, "elsewhere")
  const profiles = ["01", "02", "03"].map((id) => path.join(center, "profiles", id, "codex"))
  await skillFolder(path.join(codex, "skills", "pdf"), PDF)
  await skillFolder(path.join(codex, "skills", "backup", "pdf"), PDF)
  await codexSkill(codex, "skill-creator", { system: true })
  await codexSkill(codex, "imagegen", { system: true, yaml: "policy:\n  allow_implicit_invocation: false\n" })
  await skillFolder(path.join(codex, "skills", ".trash", "old-notes"), { "SKILL.md": skillMd("old-notes", "지운 스킬") })
  await skillFolder(path.join(codex, "skills", ".staging", "half"), { "SKILL.md": skillMd("half", "설치 중") })
  const brand = await skillFolder(path.join(codex, "skills", "_common", "brand"), {
    "SKILL.md": skillMd("brand", "브랜드 규칙을 지킵니다"),
  })
  await fsp.symlink(brand, path.join(codex, "skills", "brand-link"), "junction")
  const assets = await skillFolder(path.join(elsewhere, "3d-assets"), {
    "SKILL.md": skillMd("3d-assets", "3D 에셋을 만듭니다"),
    "models/cube.obj": "v 0 0 0\n",
  })
  await fsp.symlink(assets, path.join(codex, "skills", "3d-assets"), "junction")
  await skillFolder(path.join(codex, "skills", "hostile"), {
    "SKILL.md": skillMd("hostile", "본문을 안전하게 보여 줘야 하는 스킬", "version: 0.9.1\nallowed-tools: Read, Grep\n", HOSTILE),
  })
  await skillFolder(path.join(codex, "skills", "pictures"), {
    "SKILL.md": skillMd("pictures", "원격 그림을 묻는 본문", "", pictures(probe)),
  })
  await skillFolder(path.join(codex, "skills", "stars"), {
    "SKILL.md": skillMd("stars", "강조 기호가 끝없는 본문", "", `${"*a ".repeat(6_000)}\n`),
  })
  await skillFolder(path.join(codex, "skills", "quotes"), {
    "SKILL.md": skillMd("quotes", "인용이 끝없이 겹친 본문", "", `${"> ".repeat(5_000)}끝\n`),
  })
  await skillFolder(path.join(codex, "skills", "translate-tool"), TRANSLATE)
  await skillFolder(path.join(codex, "skills", "glossary"), GLOSSARY)
  await fsp.mkdir(center, { recursive: true })
  await Bun.write(
    path.join(center, "state.json"),
    JSON.stringify({
      version: 1,
      profiles: [
        { id: "01", alias: "work", auth_mode: "chatgpt" },
        { id: "02", alias: "side", auth_mode: "chatgpt" },
        { id: "03", alias: null, auth_mode: "chatgpt" },
      ],
    }),
  )
  // Never read: the homes come from state.json alone.
  await Promise.all(profiles.map((profile) => Bun.write(path.join(profile, "auth.json"), '{"sentinel":"fake"}\n')))
  await skillFolder(path.join(profiles[0]!, "skills", "pdf"), PDF)
  await codexSkill(profiles[0]!, "skill-creator", { system: true })
  await skillFolder(path.join(profiles[1]!, "skills", "pdf"), {
    "SKILL.md": skillMd("pdf", "PDF 파일을 읽고 채웁니다 (새 판)", "version: 2.0.0\n"),
    "scripts/fill.py": "print('pdf 2')\n",
  })
  await fsp.symlink(path.join(codex, "skills"), path.join(profiles[2]!, "skills"), "junction")
  await skillFolder(path.join(claude, "skills", "pdf"), PDF)
  await claudeSkill(claude, path.join("synced", "org-1_acct-1", "docx"), {
    "SKILL.md": skillMd("docx", "Word 문서를 만듭니다"),
  })
  return { controlCenter: center, elsewhere }
}
