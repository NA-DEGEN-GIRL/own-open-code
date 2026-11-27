// 설정 > GitHub's plain rules (16, GH): names, the account in use with where its choice came from, row tags, choices
// read from and written to a select, and error words.
import { describe, expect, test } from "bun:test"
import type { OwnGitHub } from "@own/protocol"
import {
  accountName,
  accountTags,
  choiceOf,
  choiceValue,
  errorText,
  hostWrites,
  inUseText,
  projectChoiceAt,
  sessionChoice,
  writeHostsWith,
} from "./model"
import { githubText, type GitHubKey } from "./strings"

const text = (key: GitHubKey, params?: Readonly<Record<string, string | number>>) => githubText("ko", key, params)

const WORK = "gh_00000000000000000000000AAA" as OwnGitHub.ID
const HOME = "gh_00000000000000000000000BBB" as OwnGitHub.ID

const account = (id: OwnGitHub.ID, overrides: Partial<OwnGitHub.Account> = {}): OwnGitHub.Account => ({
  id,
  label: id === WORK ? "회사" : "개인",
  site: "https://github.com",
  login: id === WORK ? "octo-work" : "octo-home",
  source: "token",
  tokenKind: "fine-grained",
  hint: "…Ab12",
  write: false,
  addedAt: 0,
  ...overrides,
})

const view = (overrides: Partial<OwnGitHub.View> = {}): OwnGitHub.View => ({
  accounts: [account(WORK), account(HOME, { write: true, tokenKind: "classic" })],
  default: WORK,
  projects: [{ directory: "D:\\work\\game", account: HOME }],
  sessions: [],
  settings: { server: { type: "remote", url: "https://api.githubcopilot.com/mcp/" }, toolsets: [], git: true },
  vault: "ok",
  ...overrides,
})

describe("GitHub settings model", () => {
  test("an account reads as its name and login, with the site when it is not github.com", () => {
    expect(accountName(account(WORK))).toBe("회사 (octo-work)")
    expect(accountName(account(WORK, { site: "https://ghe.example.com" }))).toBe("회사 (octo-work · ghe.example.com)")
  })

  test("the indicator names the account in use and where its choice came from", () => {
    expect(inUseText(view({ inUse: { account: HOME, source: "project", directory: "D:\\work\\game" } }), text)).toBe(
      "개인 (octo-home) · 프로젝트 설정",
    )
    expect(inUseText(view({ inUse: { account: WORK, source: "default" } }), text)).toBe("회사 (octo-work) · 기본 계정")
    expect(inUseText(view({ inUse: { account: HOME, source: "worktree" } }), text)).toContain("본 저장소")
    expect(inUseText(view({ inUse: { source: "off" } }), text)).toBe("이 프로젝트에서는 GitHub를 꺼 뒀어요")
    expect(inUseText(view({ inUse: { source: "none" } }), text)).toBe("쓰는 GitHub 계정이 없어요")
  })

  test("row tags: default, writes, token kind, the last four characters and the expiry", () => {
    expect(accountTags(account(WORK, { expiresAt: Date.parse("2027-01-31T00:00:00Z") }), view(), text)).toEqual([
      "기본",
      "읽기만",
      "세분화 토큰",
      "…Ab12",
      "기한 2027-01-31",
    ])
    expect(accountTags(account(HOME, { write: true, tokenKind: "classic", hint: "" }), view(), text)).toEqual([
      "쓰기 허용",
      "클래식 토큰",
    ])
  })

  test("a select's value and the choice it writes; a project's own choice only", () => {
    expect(choiceValue(undefined)).toBe("")
    expect(choiceValue("off")).toBe("off")
    expect(choiceOf("")).toBeNull()
    expect(choiceOf(WORK)).toBe(WORK)
    expect(projectChoiceAt(view(), "d:\\Work\\game")).toBe(HOME)
    expect(projectChoiceAt(view(), "D:\\work\\game\\src")).toBeUndefined()
  })

  test("an SSH host's folders and conversations are its own choices, apart from this PC's (16 §8)", () => {
    const remote = view({
      projects: [
        { directory: "/home/u/work", account: HOME, host: "h-ab12cd" },
        { directory: "/home/u/work", account: "off", host: "h-ef34gh" },
      ],
      sessions: [
        { sessionID: "ses_one", account: HOME, host: "h-ab12cd", at: 0 },
        { sessionID: "ses_one", account: WORK, at: 0 },
      ],
    })
    expect(projectChoiceAt(remote, "/home/u/work", "h-ab12cd")).toBe(HOME)
    expect(projectChoiceAt(remote, "/home/u/work", "h-ef34gh")).toBe("off")
    expect(projectChoiceAt(remote, "/home/u/work")).toBeUndefined()
    expect(sessionChoice(remote, "ses_one", "h-ab12cd")).toBe(HOME)
    expect(sessionChoice(remote, "ses_one")).toBe(WORK)
    expect(text("own.gh.host", { host: "devbox" })).toContain("devbox")
  })

  test("an SSH host reads only until it is allowed to write; allowing and taking it back keeps the other hosts (GH-49)", () => {
    const fresh = view()
    expect(hostWrites(fresh, "h-ab12cd")).toBe(false)
    expect(writeHostsWith(fresh, "h-ab12cd", true)).toEqual(["h-ab12cd"])
    const allowed = view({ settings: { ...fresh.settings, writeHosts: ["h-ef34gh", "h-ab12cd"] } })
    expect(hostWrites(allowed, "h-ab12cd")).toBe(true)
    expect(writeHostsWith(allowed, "h-ab12cd", false)).toEqual(["h-ef34gh"])
    expect(writeHostsWith(allowed, "h-ab12cd", true)).toEqual(["h-ef34gh", "h-ab12cd"])
    expect(text("own.gh.hostWrite.label", { host: "devbox" })).toContain("devbox")
  })

  test("errors in plain words, another user's token named as such", () => {
    expect(errorText("github_token_invalid", { status: 401 }, "x", text)).toBe(
      "GitHub가 토큰을 받지 않았어요. 토큰을 다시 확인해 주세요.",
    )
    expect(errorText("github_token_invalid", { mismatch: true }, "x", text)).toBe("다른 GitHub 사용자의 토큰이에요.")
    expect(errorText("github_invalid", { field: "label" }, "x", text)).toBe("같은 이름의 계정이 있어요.")
    expect(errorText(undefined, undefined, "boom", text)).toBe("바꾸지 못했어요: boom")
  })
})
