// Old-app saved API keys linked by reference (02 §3.2b) in the "이전 앱에서 가져오기" flow, next to the Codex profiles,
// in Edge. The e2e backend has no old-app files (its `codexImportRoot` is not a codex-multi-provider layout), so the
// `accounts.import.*` methods are mocked in the page with fake values, like the Codex import (03 §16.5). Checked: rows
// and the read-only note, link → confirm (key hint, warning, name) → done, a duplicate blocks linking, keys-only old
// app, the linked card (connection line, no key replacement, removal keeps the file), in light and dark themes.
import { expect, test, type Page, type Route } from "@playwright/test"
import { watchErrors } from "./support"

type Handler = (input: Record<string, unknown>) => object | undefined

async function mock(page: Page, method: string, answer: object | Handler) {
  const escaped = method.replaceAll(".", "\\.")
  await page.route(new RegExp(`/api/rpc/own\\.accounts/${escaped}(\\?|$)`), async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as { input?: Record<string, unknown> }
    const result = typeof answer === "function" ? (answer as Handler)(body.input ?? {}) : answer
    if (result === undefined) return route.continue()
    return route.fulfill({ json: { output: result } })
  })
}

const NOTE =
  "연결만 할 수 있어요. 키는 이 앱에 복사하지 않고, 요청할 때 이전 앱 파일을 읽기만 해요. 이전 앱을 지우거나 키를 바꾸면 여기서도 바뀌어요."

const KEYS = {
  available: true,
  keys: [
    {
      providerRef: "legacy:deepseek",
      name: "DeepSeek",
      kind: "ds",
      baseURL: "https://api.deepseek.com",
      models: ["deepseek-flash"],
      keySaved: true,
      importable: true,
      importedAs: null,
    },
    {
      providerRef: "dpapi:6a1d4b2f-8e3c-4d9f-8b7a-1c2d3e4f5061",
      name: "Lab",
      kind: null,
      baseURL: "https://lab.example.test/v1",
      models: [],
      keySaved: true,
      importable: false,
      problem: "unsupported_provider",
      importedAs: null,
    },
  ],
}

const PROFILES = {
  available: true,
  sources: [
    {
      profileID: "02",
      alias: "work-pro",
      importable: true,
      identity: { emailMasked: "ki***@acme.com", plan: "pro" },
      importedAs: null,
    },
  ],
}

function linkedView(label: string) {
  return {
    id: "acc_legacy_ds",
    kind: "ds",
    label,
    shortLabel: "D",
    color: "teal",
    providerID: "own-ds-lgc1",
    billing: "prepaid",
    status: "ready",
    autoSwitch: true,
    thirdParty: false,
    readOnly: false,
    identity: { keyHint: "sk-…0001" },
    connection: {
      type: "key",
      method: "legacy-key-linked",
      legacyKey: { app: "codex-multi-provider", providerRef: "legacy:deepseek", name: "DeepSeek" },
    },
  }
}

function plan(duplicateOf: string | null = null) {
  return {
    nonce: "non_legacy_e2e",
    expiresAt: Date.now() + 120_000,
    providerRef: "legacy:deepseek",
    name: "DeepSeek",
    kind: "ds",
    label: "DeepSeek (이전 앱)",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-flash",
    keyHint: "sk-…0001",
    duplicateOf,
    warnings: ["linked_key_depends_on_source"],
  }
}

for (const scheme of ["light", "dark"] as const)
  test(`link the old app's DeepSeek key next to the Codex profiles (mocked RPC, ${scheme})`, async ({ page }) => {
    const errors = watchErrors(page)
    await page.emulateMedia({ colorScheme: scheme })
    const calls: { method: string; input: Record<string, unknown> }[] = []
    await mock(page, "accounts.import.codex.list", PROFILES)
    await mock(page, "accounts.import.keys.list", KEYS)
    await mock(page, "accounts.import.keys.plan", (input) => {
      calls.push({ method: "plan", input })
      return plan()
    })
    await mock(page, "accounts.import.keys.execute", (input) => {
      calls.push({ method: "execute", input })
      return {
        account: linkedView(String(input.label)),
        dryRun: false,
        keyHint: "sk-…0001",
        test: { ok: true, skipped: false, detected: {} },
      }
    })
    await page.goto("/accounts")
    await page.getByTestId("open-codex-import").click()
    const dialog = page.getByTestId("codex-import-dialog")
    await expect(dialog).toContainText("ChatGPT 로그인 1개를 찾았어요.")
    await expect(dialog.getByTestId("codex-list").locator("li")).toHaveCount(1)
    const keys = dialog.getByTestId("legacy-keys")
    await expect(keys).toContainText("이전 앱에 저장된 API 키 2개를 찾았어요.")
    await expect(keys.getByTestId("legacy-keys-note")).toHaveText(NOTE)
    const rows = keys.getByTestId("legacy-key-row")
    await expect(rows.nth(0)).toContainText("DeepSeek")
    await expect(rows.nth(0)).toContainText("https://api.deepseek.com · deepseek-flash")
    await expect(rows.nth(0).getByTestId("legacy-key-state")).toContainText("연결할 수 있음")
    await expect(rows.nth(1)).toContainText("이 앱이 지원하지 않는 API예요")
    await expect(rows.nth(1).getByTestId("legacy-key-link")).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath(`legacy-keys-list-${scheme}.png`) })

    await rows.nth(0).getByTestId("legacy-key-link").click()
    const confirm = dialog.getByTestId("legacy-key-confirm")
    await expect(confirm.getByTestId("legacy-key-title")).toHaveText("DeepSeek · 키 sk-…0001")
    await expect(confirm).toContainText("이전 앱에서 쓰던 모델: deepseek-flash")
    await expect(confirm).toContainText(
      "키는 이전 앱 파일을 읽기만 해요. 이전 앱을 지우거나 키를 바꾸면 여기서도 바뀌어요",
    )
    await expect(confirm.getByTestId("legacy-key-label")).toHaveValue("DeepSeek (이전 앱)")
    await page.screenshot({ path: test.info().outputPath(`legacy-keys-confirm-${scheme}.png`) })
    await confirm.getByTestId("legacy-key-execute").click()
    await expect(dialog.getByTestId("legacy-key-done")).toHaveText(
      '"DeepSeek (이전 앱)" 계정을 연결했어요 (키 sk-…0001). 실행 중인 대화는 바뀌지 않아요.',
    )
    expect(calls).toEqual([
      { method: "plan", input: { providerRef: "legacy:deepseek" } },
      {
        method: "execute",
        input: { nonce: "non_legacy_e2e", label: "DeepSeek (이전 앱)", color: expect.any(String) },
      },
    ])
    // The token-based theme: the confirm text is readable on the dialog background in both schemes.
    const colors = await dialog.evaluate((element) => {
      const style = getComputedStyle(element)
      return { color: style.color, background: getComputedStyle(element.closest("dialog") ?? element).backgroundColor }
    })
    expect(colors.color).not.toBe(colors.background)
    expect(errors.filter((error) => !/Failed to load resource|net::/.test(error))).toEqual([])
  })

test("a key another account already uses cannot be linked again (mocked RPC)", async ({ page }) => {
  await mock(page, "accounts.import.codex.list", { available: false, sources: [] })
  await mock(page, "accounts.import.keys.list", {
    available: true,
    keys: [{ ...KEYS.keys[0], importedAs: { accountID: "acc_existing_ds" } }],
  })
  await mock(page, "accounts.import.keys.plan", plan("acc_existing_ds"))
  await page.goto("/accounts")
  await page.getByTestId("open-codex-import").click()
  const dialog = page.getByTestId("codex-import-dialog")
  // Keys only: the Codex list, its mode choice and "다음" are not shown.
  await expect(dialog.getByTestId("codex-list")).toHaveCount(0)
  await expect(dialog.getByTestId("codex-next")).toHaveCount(0)
  const row = dialog.getByTestId("legacy-key-row").first()
  await expect(row).toContainText('이미 연결됨 → "acc_existing_ds"')
  await expect(row.getByTestId("legacy-key-link")).toHaveCount(0)
})

test("keys only: the add-account grid offers the old-app card, and a duplicate plan blocks linking (mocked)", async ({
  page,
}) => {
  await mock(page, "accounts.import.codex.list", { available: false, sources: [] })
  await mock(page, "accounts.import.keys.list", KEYS)
  await mock(page, "accounts.import.keys.plan", plan("acc_existing_ds"))
  await page.goto("/accounts/add")
  const dialog = page.getByTestId("add-account-dialog")
  await dialog.locator('[data-choice="codexImport"]').click()
  await dialog.getByTestId("legacy-key-row").first().getByTestId("legacy-key-link").click()
  const confirm = dialog.getByTestId("legacy-key-confirm")
  await expect(confirm.getByTestId("legacy-key-duplicate")).toContainText(
    '이미 같은 키를 쓰는 계정 "acc_existing_ds"가 있어 새로 연결하지 않아요.',
  )
  await expect(confirm.getByTestId("legacy-key-execute")).toBeDisabled()
  await expect(confirm.getByTestId("legacy-key-label")).toHaveCount(0)
})

test("a linked key account: connection line, no key replacement, removal keeps the old file (mocked)", async ({
  page,
}) => {
  await mock(page, "accounts.import.codex.list", { available: false, sources: [] })
  await mock(page, "accounts.import.keys.list", { available: false, keys: [] })
  await mock(page, "accounts.list", { revision: 998, accounts: [linkedView("DeepSeek (이전 앱)")] })
  await mock(page, "accounts.remove.plan", {
    nonce: "non_remove_e2e",
    expiresAt: Date.now() + 120_000,
    affectedSessions: [],
    willShredVault: false,
  })
  await page.goto("/accounts")
  const card = page.locator('[data-testid=account-card][data-account-id="acc_legacy_ds"]')
  await expect(card.getByTestId("legacy-key-connection")).toHaveText(
    "이전 앱 키 연결 · DeepSeek (읽기 전용 — 이전 앱에서 키를 바꾸면 여기서도 바뀌어요)",
  )
  await card.getByTestId("account-menu").click()
  await expect(page.getByRole("menuitem", { name: "키 교체" })).toHaveCount(0)
  await page.getByTestId("menu-remove").click()
  const remove = page.getByTestId("remove-dialog")
  await expect(remove.getByTestId("remove-keeps-legacy-key")).toHaveText(
    "이전 앱의 키 파일은 건드리지 않아요. 이 앱의 연결만 지워요.",
  )
  await expect(remove.getByTestId("remove-plan")).not.toContainText("이 PC에 저장된 키를 지워요")
})
