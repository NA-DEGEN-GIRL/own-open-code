// Ports the heredoc extraction tests of codex-rs/apply-patch/src/invocation.rs (`assert_match` / `assert_not_match`).
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
import { describe, expect, test } from "bun:test"
import { ApplyPatch } from "../../../src/codex/apply-patch/index.js"

const PATCH = "*** Begin Patch\n*** Add File: foo\n+hi\n*** End Patch"

function heredocScript(prefix: string, suffix = "") {
  return `${prefix}apply_patch <<'PATCH'\n${PATCH}\nPATCH${suffix}`
}

function assertMatch(script: string, workdir: string | undefined) {
  const extracted = ApplyPatch.extractHeredocPatch(script)
  expect(extracted).toEqual(workdir === undefined ? { patch: PATCH } : { patch: PATCH, workdir })
  expect(ApplyPatch.parsePatch(extracted!.patch).hunks).toEqual([{ type: "add", path: "foo", contents: "hi\n" }])
}

function assertNotMatch(script: string) {
  expect(ApplyPatch.extractHeredocPatch(script)).toBeUndefined()
}

describe("invocation.rs heredoc extraction", () => {
  test("test_heredoc", () => assertMatch(heredocScript(""), undefined))
  test("test_heredoc_applypatch", () => assertMatch(`applypatch <<'PATCH'\n${PATCH}\nPATCH`, undefined))
  test("test_heredoc_with_leading_cd", () => assertMatch(heredocScript("cd foo && "), "foo"))
  test("test_cmd_heredoc_with_cd", () => assertMatch(heredocScript("cd foo && "), "foo"))
  test("test_cd_with_semicolon_is_ignored", () => assertNotMatch(heredocScript("cd foo; ")))
  test("test_cd_or_apply_patch_is_ignored", () => assertNotMatch(heredocScript("cd bar || ")))
  test("test_cd_pipe_apply_patch_is_ignored", () => assertNotMatch(heredocScript("cd bar | ")))
  test("test_cd_single_quoted_path_with_spaces", () => assertMatch(heredocScript("cd 'foo bar' && "), "foo bar"))
  test("test_cd_double_quoted_path_with_spaces", () => assertMatch(heredocScript('cd "foo bar" && '), "foo bar"))
  test("test_echo_and_apply_patch_is_ignored", () => assertNotMatch(heredocScript("echo foo && ")))
  test("test_apply_patch_with_arg_is_ignored", () => assertNotMatch(`apply_patch foo <<'PATCH'\n${PATCH}\nPATCH`))
  test("test_double_cd_then_apply_patch_is_ignored", () => assertNotMatch(heredocScript("cd foo && cd bar && ")))
  test("test_cd_two_args_is_ignored", () => assertNotMatch(heredocScript("cd foo bar && ")))
  test("test_cd_then_apply_patch_then_extra_is_ignored", () =>
    assertNotMatch(heredocScript("cd bar && ", " && echo done")))
  test("test_echo_then_cd_and_apply_patch_is_ignored", () => assertNotMatch(heredocScript("echo foo; cd bar && ")))

  test("other delimiter spellings and surrounding whitespace", () => {
    assertMatch(`apply_patch <<EOF\n${PATCH}\nEOF\n`, undefined)
    assertMatch(`apply_patch <<"EOF"\n${PATCH}\nEOF`, undefined)
    assertMatch(`\n  apply_patch<<'EOF'\n${PATCH}\n\nEOF\n\n`, undefined)
    assertMatch(`apply_patch <<-'EOF'\n${PATCH}\n\t\tEOF`, undefined)
  })

  test("a missing terminator, an empty body, or trailing text is not a match", () => {
    assertNotMatch(`apply_patch <<'EOF'\n${PATCH}\n`)
    assertNotMatch("apply_patch <<'EOF'\nEOF")
    assertNotMatch(`apply_patch <<'EOF'\n${PATCH}\nEOF\necho done`)
    assertNotMatch(`apply_patch <<'EOF' && echo done\n${PATCH}\nEOF`)
    assertNotMatch(`cd $HOME && apply_patch <<'EOF'\n${PATCH}\nEOF`)
    assertNotMatch(PATCH)
  })
})
