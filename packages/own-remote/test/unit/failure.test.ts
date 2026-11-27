import { describe, expect, test } from "bun:test"
import { Failure } from "../../src/ssh/failure.js"
import { SshFailure } from "../../src/vendor/ssh/command.js"

describe("tunnel start failures (04 §6.3, §7.1)", () => {
  test("a remote command's Permission denied with exit 1 is not auth and does not pause", () => {
    const classified = Failure.classifyStart({
      ok: false,
      reason: "exited",
      code: 1,
      stderr: "mkdir: cannot create directory: Permission denied\n",
    })
    expect(classified).toEqual({
      error: "service_failed",
      detail: "exited (1): mkdir: cannot create directory: Permission denied",
      pause: false,
    })
  })

  test("ssh's own Permission denied with exit 255 is auth and pauses", () => {
    expect(
      Failure.classifyStart({ ok: false, reason: "exited", code: 255, stderr: "tester@lab: Permission denied (publickey).\r\n" }),
    ).toMatchObject({ error: "auth", pause: true })
  })

  test("host key, forwarding and loopback texts apply only to exit 255", () => {
    const changed = "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\r\nHost key verification failed.\r\n"
    const prohibited = "channel 2: open failed: administratively prohibited: open failed\r\n"
    const listen = "bind [127.0.0.1]:41000: Address already in use\r\ncannot listen to port: 41000\r\n"
    expect(Failure.classifyStart({ ok: false, reason: "exited", code: 255, stderr: changed })).toEqual({
      error: "host_key",
      detail: "changed",
      pause: true,
    })
    expect(Failure.classifyStart({ ok: false, reason: "exited", code: 255, stderr: prohibited })).toMatchObject({
      error: "forwarding_disabled",
      pause: true,
    })
    expect(Failure.classifyStart({ ok: false, reason: "exited", code: 255, stderr: listen })).toMatchObject({
      error: "loopback_unavailable",
      pause: true,
    })
    for (const stderr of [changed, prohibited, listen])
      expect(Failure.classifyStart({ ok: false, reason: "exited", code: 2, stderr })).toMatchObject({
        error: "service_failed",
        pause: false,
      })
  })

  test("timeouts, aborts, spawn failures and signal exits retry as connection failures", () => {
    expect(
      Failure.classifyStart({ ok: false, reason: "timeout", code: null, stderr: "tester@lab: Permission denied (publickey).\r\n" }),
    ).toEqual({ error: "connection", detail: "timeout: tester@lab: Permission denied (publickey).", pause: false })
    expect(Failure.classifyStart({ ok: false, reason: "aborted", code: null, stderr: "" })).toEqual({
      error: "connection",
      detail: "aborted",
      pause: false,
    })
    expect(Failure.classifyStart({ ok: false, reason: "spawn", code: null, stderr: "no ssh command" })).toEqual({
      error: "connection",
      detail: "spawn: no ssh command",
      pause: false,
    })
    expect(Failure.classifyStart({ ok: false, reason: "exited", code: null, stderr: "" })).toEqual({
      error: "connection",
      detail: "exited (null)",
      pause: false,
    })
  })

  test("an ssh exit 255 without stderr stays a retrying connection failure", () => {
    expect(Failure.classifyStart({ ok: false, reason: "exited", code: 255, stderr: "" })).toEqual({
      error: "connection",
      detail: "ssh exited (255)",
      pause: false,
    })
  })

  test("the detail carries the last line of the scrubbed stderr", () => {
    const stderr = [
      "Warning: Permanently added 'lab' (ED25519) to the list of known hosts.",
      "OPENCODE_SSH_REGISTRATION_BEGIN",
      '{"url":"http://127.0.0.1:4096","password":"fixture-secret"}',
      "OPENCODE_SSH_REGISTRATION_END",
      'ensure: bad registration {"password":"fixture-secret"}',
      "",
    ].join("\n")
    const classified = Failure.classifyStart({ ok: false, reason: "exited", code: 3, stderr })
    expect(classified).toMatchObject({ error: "service_failed", pause: false })
    expect(classified.detail).toStartWith("exited (3): ensure: bad registration")
    expect(classified.detail).not.toContain("fixture-secret")
    expect(classified.detail.length).toBeLessThanOrEqual("exited (3): ".length + 300)
  })
})

describe("runner failures (classify) keep their behaviour", () => {
  test("ssh missing, input, auth and connection", () => {
    expect(Failure.classify(new SshFailure("ssh-missing", "ssh not found"))).toEqual({
      error: "ssh_missing",
      detail: "ssh not found",
      pause: true,
    })
    expect(Failure.classify(new SshFailure("connection", "Error: spawn ssh ENOENT"))).toMatchObject({
      error: "ssh_missing",
      pause: true,
    })
    expect(Failure.classify(new SshFailure("input"))).toEqual({ error: "input", detail: "", pause: true })
    expect(Failure.classify(new SshFailure("connection", "tester@lab: Permission denied (publickey)."))).toMatchObject({
      error: "auth",
      pause: true,
    })
    expect(Failure.classify(new SshFailure("connection", "ssh: connect to host lab port 22: Connection timed out"))).toEqual({
      error: "connection",
      detail: "ssh: connect to host lab port 22: Connection timed out",
      pause: false,
    })
  })
})
