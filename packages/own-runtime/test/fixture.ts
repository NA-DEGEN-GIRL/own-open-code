// Shared test fixtures. Every credential here is fake: unsigned JWTs and random strings.

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { Account } from "@own/protocol"

export async function tmpdir(prefix = "own-runtime-test-") {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await removeTree(directory)
    },
  }
}

/** The errors Node's `fs.rm` retries: on Windows a file another process holds for a moment answers one of them. */
const RETRIED: ReadonlySet<string> = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])

/**
 * `fs.rm(target, {recursive, force})` with the retries Node's `maxRetries`/`retryDelay` give. Bun accepts those options
 * but does not retry (1.4.2 on Windows fails an `EBUSY` within a millisecond), so a test teardown that relied on them
 * failed whenever the indexer or Defender held a file the test had just written.
 */
export async function removeTree(target: string, attempts = 20, delayMs = 100): Promise<void> {
  const failure = await fs.rm(target, { recursive: true, force: true }).then(
    () => undefined,
    (error: NodeJS.ErrnoException) => error,
  )
  if (failure === undefined) return
  if (attempts <= 1 || !RETRIED.has(failure.code ?? "")) throw failure
  await Bun.sleep(delayMs)
  return removeTree(target, attempts - 1, delayMs)
}

/** A controllable clock. */
export function clock(start = Date.UTC(2026, 8, 27, 3, 0, 0)) {
  const state = { now: start }
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms
    },
    set: (ms: number) => {
      state.now = ms
    },
  }
}

export const AUTH_CLAIM = "https://api.openai.com/auth"
export const PROFILE_CLAIM = "https://api.openai.com/profile"

/** Unsigned JWT with the structure of a real one. Only its claims can be read. */
export function fakeJwt(claims: Readonly<Record<string, unknown>>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.${Buffer.from("fake-signature").toString("base64url")}`
}

export interface FakeChatgpt {
  readonly accountId: string
  readonly sub: string
  readonly email: string
  readonly plan: string
}

export const ACCOUNT_A: FakeChatgpt = {
  accountId: "11111111-1111-4111-8111-111111111111",
  sub: "auth0|fake-user-a",
  email: "alice@example.test",
  plan: "plus",
}

export const ACCOUNT_B: FakeChatgpt = {
  accountId: "22222222-2222-4222-8222-222222222222",
  sub: "auth0|fake-user-b",
  email: "bob@example.test",
  plan: "pro",
}

/** A fake ChatGPT token family whose access token expires at `expiresAt` (epoch ms). */
export function chatgptTokens(account: FakeChatgpt, expiresAt: number) {
  const auth = { chatgpt_account_id: account.accountId, chatgpt_plan_type: account.plan, chatgpt_user_id: account.sub }
  const nonce = randomBytes(6).toString("hex")
  return {
    idToken: fakeJwt({
      sub: account.sub,
      email: account.email,
      [AUTH_CLAIM]: auth,
      exp: Math.floor(expiresAt / 1000),
      jti: nonce,
    }),
    accessToken: fakeJwt({
      sub: account.sub,
      [AUTH_CLAIM]: auth,
      [PROFILE_CLAIM]: { email: account.email },
      exp: Math.floor(expiresAt / 1000),
      jti: nonce,
    }),
    refreshToken: `rt_fake_${randomBytes(12).toString("hex")}`,
    accountId: account.accountId,
  }
}

export type Tokens = ReturnType<typeof chatgptTokens>

export const SHARING_ISSUER = "https://auth.openai.com"
export const SHARING_CLIENT = "oaiapp_fake0123456789"
export const SHARING_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
]

/**
 * A fake Sign in with ChatGPT token family issued to `clientId`: an id token with the OIDC claims and an access token
 * that, like the real one, carries no ChatGPT account id or plan.
 */
export function sharingTokens(account: FakeChatgpt, expiresAt: number, clientId = SHARING_CLIENT) {
  const jti = randomBytes(6).toString("hex")
  const exp = Math.floor(expiresAt / 1000)
  return {
    idToken: fakeJwt({
      iss: SHARING_ISSUER,
      aud: clientId,
      sub: account.sub,
      email: account.email,
      nonce: "fake-nonce",
      iat: exp - 3600,
      exp,
    }),
    accessToken: fakeJwt({
      iss: SHARING_ISSUER,
      aud: ["https://api.openai.com/v1"],
      sub: account.sub,
      client_id: clientId,
      [AUTH_CLAIM]: { per_user_salt: "fake", encrypted_auth_metadata: "fake" },
      exp,
      jti,
    }),
    refreshToken: `rt_fake_${randomBytes(12).toString("hex")}`,
  }
}

/** Writes an old-app `auth.json` the way a careful writer would (temp + rename). */
export async function writeAuth(authPath: string, tokens: Tokens, lastRefresh = "2026-09-26T10:11:12.123456789Z") {
  await fs.mkdir(path.dirname(authPath), { recursive: true })
  const temp = `${authPath}.${process.pid}.tmp`
  await fs.writeFile(
    temp,
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: tokens.idToken,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          account_id: tokens.accountId,
        },
        last_refresh: lastRefresh,
      },
      null,
      2,
    ),
  )
  await fs.rename(temp, authPath)
}

/** A fake control center with the given profiles; returns their `auth.json` paths. */
export async function controlCenter(
  root: string,
  profiles: ReadonlyArray<{ readonly id: string; readonly alias: string | null; readonly tokens?: Tokens }>,
) {
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, "state.json"),
    `﻿${JSON.stringify({
      version: 1,
      profiles: profiles.map((profile) => ({
        id: profile.id,
        alias: profile.alias,
        home: path.join(root, "profiles", profile.id),
        auth_mode: "chatgpt",
        login_state: "logged_in",
      })),
    })}`,
  )
  const paths = profiles.map((profile) => path.join(root, "profiles", profile.id, "codex", "auth.json"))
  await Promise.all(
    profiles.map((profile, index) => (profile.tokens ? writeAuth(paths[index], profile.tokens) : undefined)),
  )
  return paths
}

export const CODEX_ID = Account.ID.make("acc_01JAX3ABCDEFGHJKMNPQRSTVWX")
export const ANTH_ID = Account.ID.make("acc_01JAX9ABCDEFGHJKMNPQRSTVWX")
export const OAI_ID = Account.ID.make("acc_01JAXAABCDEFGHJKMNPQRSTVWX")
export const SIWC_ID = Account.ID.make("acc_01JAXBABCDEFGHJKMNPQRSTVWX")

const IDENTITY = {
  codex: { chatgptAccountId: ACCOUNT_A.accountId },
  siwc: { emailMasked: "al***@example.test" },
  anth: { keyHint: "sk-…fake" },
  oai: { keyHint: "sk-…fake" },
}

/** A registry account record; `patch` overrides fields. */
export function account(kind: "codex" | "siwc" | "anth" | "oai", patch: Partial<Account.Info> = {}): Account.Info {
  const base = {
    codex: { id: CODEX_ID, providerID: "own-codex-7k2m", cacheDomain: "cd_7k2m", quotaDomain: "qd_7k2m" },
    siwc: { id: SIWC_ID, providerID: "own-siwc-r4t6", cacheDomain: "cd_r4t6", quotaDomain: "qd_r4t6" },
    anth: { id: ANTH_ID, providerID: "own-anth-w3p8", cacheDomain: "cd_w3p8", quotaDomain: "qd_w3p8" },
    oai: { id: OAI_ID, providerID: "own-oai-q9x1", cacheDomain: "cd_q9x1", quotaDomain: "qd_q9x1" },
  }[kind]
  return Schema.decodeUnknownSync(Account.Info)({
    ...base,
    kind,
    label: kind,
    shortLabel: kind.slice(0, 1),
    color: "violet",
    billing: kind === "codex" || kind === "siwc" ? "subscription" : "metered",
    identity: IDENTITY[kind],
    autoSwitch: false,
    status: "ready",
    ...patch,
  })
}

/** Resolves after all currently queued timers and microtasks. */
export function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
