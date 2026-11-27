// 설정 > GitHub end to end (GH 2026-10-31; 16 §9), on backend.ts's server with a fake GitHub (own-accounts' e2e kit):
// - the page is in 연결 and says no account is connected yet;
// - `토큰으로` connects an account: GitHub is asked who the token is, the row shows the name, login, `기본`, `읽기만`,
//   the token kind and its last four characters, the token field is empty again, and the tool list GitHub's MCP server
//   gave shows its counts; a second account by token too;
// - `이 프로젝트의 계정` picks the second account: `지금 이 프로젝트` names it and why; `쓰기 허용` turns writes on;
// - `지우기…` asks and removes an account;
// - no token is on the page, in own's github.json or in a `github.view` answer.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

const TMP = process.env.OWN_WEB_TOOLS_E2E_TMP ?? ""
const state = JSON.parse(fs.readFileSync(path.join(TMP, "backend.json"), "utf8")) as {
  readonly control: string
  readonly ownHome: string
  readonly project: string
  readonly tokens: { readonly githubWork: string; readonly githubHome: string }
}
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(TMP, "shots", `${name}.png`), fullPage: true })

async function view(request: APIRequestContext) {
  const response = await request.post("/api/rpc/own.accounts/github.view", {
    data: { input: { directory: state.project } },
    params: { "location[directory]": state.control },
  })
  expect(response.status()).toBe(200)
  return (await response.text()) as string
}

async function connect(page: Page, label: string, token: string) {
  await page.getByTestId("github-add-label").fill(label)
  await page.getByTestId("github-add-token").fill(token)
  await page.getByTestId("github-add-connect").click()
  await expect(page.getByTestId("github-accounts")).toContainText(label)
  await expect(page.getByTestId("github-add-token")).toHaveValue("")
}

test("GitHub accounts: connect by token, choose per project, allow writes, remove; no token anywhere", async ({
  page,
  request,
}) => {
  await page.goto("/settings/github")
  await expect(page.getByTestId("settings-github-page")).toBeVisible()
  await expect(page.getByTestId("settings-github-page")).toContainText("아직 연결한 계정이 없어요")

  await connect(page, "회사", state.tokens.githubWork)
  const work = page.getByTestId("github-account").filter({ hasText: "회사" })
  await expect(work).toContainText("회사 (octo-work)")
  for (const tag of ["기본", "읽기만", "클래식 토큰", `…${state.tokens.githubWork.slice(-4)}`])
    await expect(work).toContainText(tag)
  await expect(page.getByTestId("github-tools")).toContainText("읽기 도구 3개 · 쓰기 도구 2개")
  await expect(page.getByTestId("github-in-use")).toContainText("회사 (octo-work) · 기본 계정")

  await connect(page, "개인", state.tokens.githubHome)
  const home = page.getByTestId("github-account").filter({ hasText: "개인" })
  await expect(home).toContainText("세분화 토큰")
  await expect(home).toContainText("기한 2027-01-31")

  // The project on screen uses the personal account.
  const projectChoice = page.getByTestId("github-project-choice")
  await projectChoice.selectOption({ label: "개인 (octo-home)" })
  await expect(page.getByTestId("github-in-use")).toContainText("개인 (octo-home) · 프로젝트 설정")
  await expect(page.getByTestId("github-projects")).toContainText("개인 (octo-home)")

  await home.getByTestId("github-write").click()
  await expect(home).toContainText("쓰기 허용")
  await shot(page, "github-settings")

  await work.getByTestId("github-remove").click()
  await page.getByTestId("github-remove-yes").click()
  await expect(page.getByTestId("github-accounts")).not.toContainText("회사")

  const html = await page.content()
  const file = await fs.promises.readFile(path.join(state.ownHome, "github.json"), "utf8")
  const answer = await view(request)
  for (const token of [state.tokens.githubWork, state.tokens.githubHome]) {
    expect(html).not.toContain(token)
    expect(file).not.toContain(token)
    expect(answer).not.toContain(token)
  }
  expect(file).toContain("octo-home")
})

test("a phone-wide window fits the page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto("/settings/github")
  await expect(page.getByTestId("settings-github-page")).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await shot(page, "github-settings-phone")
})
