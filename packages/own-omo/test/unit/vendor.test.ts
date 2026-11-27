// The vendored oh-my-opencode (own/vendor/oh-my-opencode, 15 §7): its files are the pinned bytes, its pin is mirrored
// in the ledger, its license is the one recorded, own's patch applies to it exactly, and MODIFICATIONS.md names every
// change.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OmoPatch } from "../../script/patch"

const REPO = path.resolve(import.meta.dir, "..", "..", "..", "..")
const VENDOR = path.join(REPO, "own", "vendor", "oh-my-opencode")
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const pin = JSON.parse(fs.readFileSync(path.join(VENDOR, "pin.json"), "utf8")) as Record<string, unknown> & { tag: string }

describe("vendored oh-my-opencode", () => {
  test("every vendored file has its recorded hash, and nothing else is in src/", () => {
    const source = JSON.parse(fs.readFileSync(path.join(VENDOR, "source.json"), "utf8")) as Record<string, string>
    const files = (fs.readdirSync(path.join(VENDOR, "src"), { recursive: true, withFileTypes: true }) as fs.Dirent[])
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(path.join(VENDOR, "src"), path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
      .sort()
    expect(files).toEqual(Object.keys(source).sort())
    for (const [file, hash] of Object.entries(source)) expect(`${file} ${sha256(fs.readFileSync(path.join(VENDOR, "src", file)))}`).toBe(`${file} ${hash}`)
    expect(pin.files).toBe(files.length)
    // 1,805 files opened one by one: 0.5 s alone, but 34 s and 74 s were seen in the parallel tier while other suites
    // kept the disk and the CPU busy, past the tier's 30 s.
  }, 180_000)

  test("the pin is v5.1.50 and the ledger mirrors it; the license and notices are the recorded bytes", () => {
    expect(pin).toMatchObject({
      tag: "v5.1.50",
      tagObject: "fc005a310a54d1e161133d382321a593205741c0",
      commit: "d4d2204e075b17945d6899c6a6bc76e67ab7abea",
      version: "5.1.50",
      v1Api: "1.18.31",
    })
    expect(fs.readFileSync(path.join(REPO, "own", "ledger", "omo-pin.json"), "utf8")).toBe(
      fs.readFileSync(path.join(VENDOR, "pin.json"), "utf8"),
    )
    expect(sha256(fs.readFileSync(path.join(VENDOR, "LICENSE.md")))).toBe(pin.licenseSha256 as string)
    expect(sha256(fs.readFileSync(path.join(VENDOR, "THIRD-PARTY-NOTICES.md")))).toBe(pin.noticesSha256 as string)
    expect(fs.readFileSync(path.join(VENDOR, "LICENSE.md"), "utf8")).toContain("Sustainable Use License")
  })

  test("own's patch applies to the pristine files exactly, and MODIFICATIONS.md names each change", () => {
    const manifest = OmoPatch.read(path.join(VENDOR, "patches", `${pin.tag}.json`))
    expect(manifest.tag).toBe(pin.tag)
    expect([...new Set(manifest.files.map((entry) => entry.patch))]).toEqual([
      "OMO-P1",
      "OMO-P2",
      "OMO-P3",
      "OMO-P4",
      "OMO-P5",
      "OMO-P6",
      "OMO-P7",
      "OMO-P8",
      "OMO-P9",
    ])
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-omo-patch-"))
    try {
      for (const entry of manifest.files) {
        fs.mkdirSync(path.dirname(path.join(root, entry.file)), { recursive: true })
        fs.copyFileSync(path.join(VENDOR, "src", entry.file), path.join(root, entry.file))
      }
      OmoPatch.apply(manifest, root)
      for (const entry of manifest.files) {
        const patched = fs.readFileSync(path.join(root, entry.file), "utf8")
        expect(OmoPatch.sha256(patched)).toBe(entry.postSha256)
        expect(patched).toContain(`own-open-code (${entry.patch})`)
        expect(patched).toMatch(/OMO_OWN_(HOST|DATA_HOME|CACHE_HOME|CONFIG_DIR|STATE_HOME)/)
      }
      // OMO-P9: every project skill discovery returns early, and the project's opencode config is not read for
      // skill folders, unless the host turned project skills on.
      const loader = fs.readFileSync(
        path.join(root, "packages/skills-loader-core/src/features/opencode-skill-loader/loader.ts"),
        "utf8",
      )
      for (const name of ["discoverProjectClaudeSkills", "discoverOpencodeProjectSkills", "discoverProjectAgentsSkills"])
        expect(loader).toContain(
          `export async function ${name}(directory?: string, provenance?: SkillProvenance): Promise<LoadedSkill[]> {\n  if (ownProjectSkillsOff()) return []`,
        )
      expect(loader).toContain('process.env.OMO_OWN_HOST === "1" && process.env.OMO_OWN_PROJECT_SKILLS !== "1"')
      expect(
        fs.readFileSync(
          path.join(root, "packages/skills-loader-core/src/features/opencode-skill-loader/opencode-config-skills-reader.ts"),
          "utf8",
        ),
      ).toContain('process.env.OMO_OWN_HOST === "1" && process.env.OMO_OWN_PROJECT_SKILLS !== "1"')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
    const modifications = fs.readFileSync(path.join(VENDOR, "MODIFICATIONS.md"), "utf8")
    expect(modifications).toStartWith(
      "# Modifications\n\nThis is a modified copy of oh-my-opencode (SUL-1.0) by YeonGyu Kim; own-open-code changed it as listed below.",
    )
    for (const entry of manifest.files) {
      expect(modifications).toContain(entry.patch)
      expect(modifications).toContain(entry.file)
    }
  })

  // A tag whose LICENSE.md is not the pinned one, with the vendored tree around it so the rest of the run could go on:
  // own/scripts/omo-vendor.ts stops before it writes anything (no work folder files, `--out` and the ledger untouched).
  test("omo-vendor.ts refuses a changed LICENSE.md before it writes anything", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-omo-vendor-"))
    try {
      const clone = path.join(root, "clone")
      const out = path.join(root, "out")
      const work = path.join(root, "work")
      fs.cpSync(path.join(VENDOR, "src"), clone, { recursive: true })
      fs.copyFileSync(path.join(VENDOR, "THIRD-PARTY-NOTICES.md"), path.join(clone, "THIRD-PARTY-NOTICES.md"))
      fs.writeFileSync(path.join(clone, "LICENSE.md"), "Another license.\n")
      // No GIT_DIR or GIT_INDEX_FILE a hook may have set: git must use the temp clone.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
      for (const argv of [
        ["init", "-q"],
        ["add", "-A"],
        ["-c", "user.name=own", "-c", "user.email=own@example.invalid", "commit", "-q", "-m", "next"],
        ["tag", "v9.9.9"],
      ])
        expect(Bun.spawnSync(["git", "-C", clone, ...argv], { env }).exitCode).toBe(0)
      fs.mkdirSync(path.join(out, "src"), { recursive: true })
      fs.writeFileSync(path.join(out, "src", "kept.txt"), "kept\n")
      fs.mkdirSync(work)
      const ledger = fs.readFileSync(path.join(REPO, "own", "ledger", "omo-pin.json"), "utf8")
      const run = Bun.spawnSync(
        [process.execPath, path.join(REPO, "own", "scripts", "omo-vendor.ts"), "--from", clone, "--tag", "v9.9.9", "--out", out, "--work", work],
        { cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
      )
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr.toString()).toContain("LICENSE.md changed")
      expect(fs.readdirSync(work)).toEqual([])
      expect(fs.readdirSync(out, { recursive: true }).map((entry) => String(entry).replaceAll("\\", "/")).sort()).toEqual(["src", "src/kept.txt"])
      expect(fs.readFileSync(path.join(REPO, "own", "ledger", "omo-pin.json"), "utf8")).toBe(ledger)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test("a rebase onto the same tree reproduces the manifest; an edit that no longer applies is reported", () => {
    const manifest = OmoPatch.read(path.join(VENDOR, "patches", `${pin.tag}.json`))
    expect<unknown>(OmoPatch.rebase(manifest, path.join(VENDOR, "src"), pin.tag)).toEqual({ manifest, failed: [] })
    const broken = { ...manifest, files: [{ ...manifest.files[0]!, edits: [{ find: "not in the file", replace: "x" }] }] }
    expect(OmoPatch.rebase(broken, path.join(VENDOR, "src"), "vX").failed).toEqual([
      { file: manifest.files[0]!.file, patch: manifest.files[0]!.patch, reason: "edit 1 does not occur exactly once" },
    ])
  })
})
