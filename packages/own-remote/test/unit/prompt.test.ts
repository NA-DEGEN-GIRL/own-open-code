import { describe, expect, test } from "bun:test"
import { Prompt } from "../../src/prompt.js"

describe("askpass prompt classification (04 §14.2)", () => {
  test("the first-contact host key question is hostKey (not a hidden password field), with fingerprint and type", () => {
    const text =
      "The authenticity of host 'lab (192.0.2.10)' can't be established.\n" +
      "ED25519 key fingerprint is SHA256:Q2x3aW5kb3dzLWZha2UtZmluZ2VycHJpbnQ.\n" +
      "This key is not known by any other names.\n" +
      "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
    expect(Prompt.classify(text, false)).toEqual({
      kind: "hostKey",
      fingerprint: "SHA256:Q2x3aW5kb3dzLWZha2UtZmluZ2VycHJpbnQ",
      keyType: "ED25519",
    })
    expect(Prompt.classify("Are you sure you want to continue connecting (yes/no)? ", false).kind).toBe("hostKey")
  })

  test("confirm, passphrase, password, other", () => {
    expect(Prompt.classify("Allow use of key ~/.ssh/id_ed25519?", true).kind).toBe("confirm")
    expect(Prompt.classify("Enter passphrase for key 'C:\\Users\\u/.ssh/id_ed25519': ", false).kind).toBe("passphrase")
    expect(Prompt.classify("tester@lab's password: ", false).kind).toBe("password")
    expect(Prompt.classify("Verification code: ", false).kind).toBe("other")
  })

  test("hostKey and confirm take only the literal 'trust' and answer 'yes'; other kinds pass the value", () => {
    expect(Prompt.answer("hostKey", "trust")).toEqual({ ok: true, value: "yes" })
    expect(Prompt.answer("hostKey", "yes")).toEqual({ ok: false })
    expect(Prompt.answer("hostKey", "SHA256:abc")).toEqual({ ok: false })
    expect(Prompt.answer("confirm", "trust")).toEqual({ ok: true, value: "yes" })
    expect(Prompt.answer("password", "hunter2")).toEqual({ ok: true, value: "hunter2" })
    expect(Prompt.answer("hostKey", null)).toEqual({ ok: true, value: null })
  })
})
