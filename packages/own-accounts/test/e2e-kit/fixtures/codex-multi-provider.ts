import fs from "node:fs/promises"
import path from "node:path"
import type { ChatGPTTokens } from "./chatgpt-tokens"

/**
 * Fake copy of the old app's control-center layout that own-accounts imports Codex logins from:
 *
 *   <root>/state.json                           { profiles: [{ id, alias, auth_mode, home, ... }] }
 *   <root>/profiles/<id>/codex/auth.json         { auth_mode: "chatgpt", tokens: {...}, last_refresh }
 *
 * Tests point the importer at `root` instead of the real
 * `D:\#Projects\codex-multi-provider\work\control-center`, which must never be touched by tests.
 */
export interface LegacyProfileInput {
  readonly id?: string
  readonly alias: string
  readonly tokens: ChatGPTTokens
  readonly lastRefresh?: Date
}

export interface LegacyProfile {
  readonly id: string
  readonly alias: string
  readonly authPath: string
}

export async function writeCodexMultiProviderProfiles(root: string, profiles: readonly LegacyProfileInput[]) {
  const written = await Promise.all(
    profiles.map(async (profile) => {
      const id = profile.id ?? crypto.randomUUID()
      const authPath = path.join(root, "profiles", id, "codex", "auth.json")
      await fs.mkdir(path.dirname(authPath), { recursive: true })
      await writeAuth(authPath, profile.tokens, profile.lastRefresh ?? new Date())
      return { id, alias: profile.alias, authPath } satisfies LegacyProfile
    }),
  )
  await Bun.write(
    path.join(root, "state.json"),
    JSON.stringify(
      {
        version: 1,
        revision: 1,
        profiles: written.map((profile) => ({
          id: profile.id,
          alias: profile.alias,
          home: path.join(root, "profiles", profile.id),
          auth_mode: "chatgpt",
          status: "ready",
          login_state: "logged_in",
          created_at: new Date(0).toISOString(),
        })),
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  return written
}

/**
 * Simulates the old app refreshing a profile. By default `auth.json` is replaced through a temp file and rename.
 * The real Codex CLI truncates and rewrites the file in place (`codex-rs/login/src/auth/storage.rs`,
 * `OpenOptions::truncate(true)`), so a linked-mode reader can observe a torn file: `torn: true` leaves only the
 * first part of the new content, as a reader racing that write would see it. Write again to finish the refresh.
 */
export async function updateCodexMultiProviderAuth(
  profile: LegacyProfile,
  tokens: ChatGPTTokens,
  lastRefresh = new Date(),
  options: { readonly torn?: boolean } = {},
) {
  if (!options.torn) return writeAuth(profile.authPath, tokens, lastRefresh)
  const text = authJson(tokens, lastRefresh)
  await fs.writeFile(profile.authPath, text.slice(0, Math.floor(text.length / 2)))
}

export async function readCodexMultiProviderAuth(profile: LegacyProfile): Promise<unknown> {
  return Bun.file(profile.authPath).json()
}

async function writeAuth(authPath: string, tokens: ChatGPTTokens, lastRefresh: Date) {
  const temp = `${authPath}.${process.pid}.tmp`
  await Bun.write(temp, authJson(tokens, lastRefresh))
  await fs.rename(temp, authPath)
}

function authJson(tokens: ChatGPTTokens, lastRefresh: Date) {
  return JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: tokens.accountID,
      },
      last_refresh: lastRefresh.toISOString(),
    },
    null,
    2,
  )
}
