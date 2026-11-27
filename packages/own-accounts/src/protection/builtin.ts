export * as ProtectedBuiltIn from "./builtin.js"

import path from "node:path"
import type { ProtectedPaths } from "@own/protocol"

/**
 * The built-in protected paths (01 §13 "에이전트 접근", PP 2026-11-07): what an agent's file tools may never read or
 * change on any service, in any approval mode, besides own's own places (`SessionApproval.ownPlaces`, Claude Code's
 * `.credentials.json` among them) and the user's list. Each entry is placed on the service's machine, relative to the home folder of the user the service runs as
 * (an SSH host places them in its own home). The reasons are shown on 설정 > 승인·권한 as they are written here.
 *
 * Deliberately left out: folders agents legitimately read for instructions and skills (`~/.claude/skills`,
 * `~/.claude/CLAUDE.md`, `~/.codex/skills`, `~/.codex/AGENTS.md`, `~/.gemini/settings.json`), `~/.gitconfig` and the
 * rest of a tool's state folder. Only the files that hold a login, a key or account data are listed.
 */

/** A base folder of the service's machine an entry is placed under. */
export type Base =
  /** The user's home folder (`os.homedir()`). */
  | "home"
  /** Windows `%APPDATA%` (else `~\AppData\Roaming`). */
  | "roaming"
  /** Windows `%LOCALAPPDATA%` (else `~\AppData\Local`). */
  | "local"
  /** macOS `~/Library/Application Support`. */
  | "library"
  /** Linux `$XDG_CONFIG_HOME` (else `~/.config`). */
  | "config"
  /** `$CODEX_HOME` (else `~/.codex`). */
  | "codex"

type Os = "win32" | "darwin" | "linux"

/** `folder`: it and everything inside; `file`: that file only; `prefix`: every name that starts with it. */
type Shape = "folder" | "file" | "prefix"

interface Place {
  readonly base: Base
  /** Relative to the base, with `/`. */
  readonly path: string
  readonly shape: Shape
  /** Where it exists; absent: every OS. */
  readonly os?: ReadonlyArray<Os>
}

interface Entry {
  readonly id: string
  readonly group: ProtectedPaths.Group
  readonly reason: string
  readonly places: ReadonlyArray<Place>
}

const home = (relative: string, shape: Shape = "folder", os?: ReadonlyArray<Os>): Place => ({
  base: "home",
  path: relative,
  shape,
  ...(os ? { os } : {}),
})
const win = (base: "roaming" | "local" | "home", relative: string, shape: Shape = "folder"): Place => ({
  base,
  path: relative,
  shape,
  os: ["win32"],
})
const mac = (relative: string, shape: Shape = "folder"): Place => ({
  base: "library",
  path: relative,
  shape,
  os: ["darwin"],
})
const linux = (relative: string, shape: Shape = "folder"): Place => ({
  base: "config",
  path: relative,
  shape,
  os: ["linux"],
})
const POSIX: ReadonlyArray<Os> = ["darwin", "linux"]

export const ENTRIES: ReadonlyArray<Entry> = [
  // SSH and GPG keys.
  { id: "ssh", group: "keys", reason: "SSH 개인 키와 접속하는 서버 목록이 있어요", places: [home(".ssh")] },
  {
    id: "gnupg",
    group: "keys",
    reason: "GPG 개인 키가 있어요",
    places: [home(".gnupg"), win("roaming", "gnupg")],
  },

  // Other AI tools: only the files that hold a login, an API key or account data.
  {
    id: "claude-json",
    group: "ai",
    reason: "Claude Code의 계정 정보와 MCP 서버 설정이에요(키가 들어 있을 수 있어요). 백업·임시 파일도 같아요",
    places: [home(".claude.json", "prefix"), home(".claude/backups")],
  },
  {
    id: "codex-auth",
    group: "ai",
    reason: "Codex의 ChatGPT 로그인 토큰이에요",
    places: [{ base: "codex", path: "auth.json", shape: "file" }],
  },
  {
    id: "gemini",
    group: "ai",
    reason: "Gemini CLI의 Google 로그인과 MCP 토큰, API 키예요",
    places: [
      home(".gemini/oauth_creds.json", "file"),
      home(".gemini/google_accounts.json", "file"),
      home(".gemini/gemini-credentials.json", "file"),
      home(".gemini/mcp-oauth-tokens", "prefix"),
      home(".gemini/.env", "file"),
    ],
  },
  {
    id: "qwen",
    group: "ai",
    reason: "Qwen Code의 로그인 토큰이에요",
    places: [home(".qwen/oauth_creds.json", "file")],
  },
  {
    id: "copilot",
    group: "ai",
    reason: "GitHub Copilot의 로그인 토큰과 MCP 서버 설정이에요",
    places: [
      home(".copilot/config.json", "file"),
      home(".copilot/mcp-config.json", "file"),
      home(".config/github-copilot"),
      win("local", "github-copilot"),
    ],
  },
  { id: "grok", group: "ai", reason: "Grok CLI의 xAI API 키예요", places: [home(".grok/user-settings.json", "file")] },
  {
    id: "opencode",
    group: "ai",
    reason: "다른 OpenCode 설치의 로그인과 API 키예요",
    places: [home(".local/share/opencode/auth.json", "file"), home(".local/share/opencode/mcp-auth.json", "file")],
  },

  // Developer tools' credentials.
  {
    id: "git-credentials",
    group: "developer",
    reason: "git이 저장해 둔 비밀번호와 토큰이에요",
    places: [home(".git-credentials", "file"), home(".config/git/credentials", "file")],
  },
  {
    id: "gh",
    group: "developer",
    reason: "GitHub CLI(gh)의 로그인 토큰이에요",
    places: [home(".config/gh/hosts.yml", "file"), win("roaming", "GitHub CLI/hosts.yml", "file")],
  },
  {
    id: "netrc",
    group: "developer",
    reason: "서버에 접속하는 아이디와 비밀번호예요",
    places: [home(".netrc", "file"), home("_netrc", "file")],
  },
  {
    id: "npmrc",
    group: "developer",
    reason: "npm 레지스트리 토큰이 들어 있을 수 있어요(홈 폴더의 것만, 프로젝트의 것은 아니에요)",
    places: [home(".npmrc", "file")],
  },
  { id: "pypirc", group: "developer", reason: "PyPI 업로드 토큰이에요", places: [home(".pypirc", "file")] },
  {
    id: "docker",
    group: "developer",
    reason: "Docker 레지스트리 로그인이에요",
    places: [home(".docker/config.json", "file")],
  },
  {
    id: "aws",
    group: "developer",
    reason: "AWS 접근 키와 SSO 로그인 토큰이에요",
    places: [home(".aws/credentials", "file"), home(".aws/sso/cache")],
  },
  { id: "azure", group: "developer", reason: "Azure CLI의 로그인 토큰이에요", places: [home(".azure")] },
  {
    id: "kube",
    group: "developer",
    reason: "Kubernetes 클러스터에 접속하는 인증서와 토큰이에요",
    places: [home(".kube/config", "file")],
  },
  {
    id: "cargo",
    group: "developer",
    reason: "crates.io 업로드 토큰이에요",
    places: [home(".cargo/credentials", "prefix")],
  },
  {
    id: "adb",
    group: "developer",
    reason: "Android 기기에 붙는 adb 개인 키예요",
    places: [home(".android/adbkey", "prefix")],
  },
  {
    id: "emulator",
    group: "developer",
    reason: "Android 에뮬레이터 콘솔 토큰이에요",
    places: [home(".emulator_console_auth_token", "file")],
  },

  // The OS credential stores.
  {
    id: "windows-credentials",
    group: "system",
    reason: "Windows 자격 증명 관리자의 저장소와 그것을 푸는 키(DPAPI)예요",
    places: [
      win("roaming", "Microsoft/Credentials"),
      win("local", "Microsoft/Credentials"),
      win("roaming", "Microsoft/Protect"),
      win("roaming", "Microsoft/Vault"),
      win("local", "Microsoft/Vault"),
    ],
  },
  {
    id: "keychain",
    group: "system",
    reason: "macOS 키체인이에요",
    places: [home("Library/Keychains", "folder", ["darwin"])],
  },
  {
    id: "keyring",
    group: "system",
    reason: "GNOME 키링이에요",
    places: [home(".local/share/keyrings", "folder", ["linux"])],
  },

  // Browser profiles: saved passwords, cookies (logged-in sessions) and wallet extensions.
  {
    id: "chrome",
    group: "browser",
    reason: "Chrome의 저장된 비밀번호·쿠키·로그인과 지갑 확장이 있어요",
    places: [win("local", "Google/Chrome/User Data"), mac("Google/Chrome"), linux("google-chrome")],
  },
  {
    id: "edge",
    group: "browser",
    reason: "Edge의 저장된 비밀번호·쿠키·로그인과 지갑 확장이 있어요",
    places: [win("local", "Microsoft/Edge/User Data"), mac("Microsoft Edge"), linux("microsoft-edge")],
  },
  {
    id: "brave",
    group: "browser",
    reason: "Brave의 저장된 비밀번호·쿠키·로그인과 지갑이 있어요",
    places: [
      win("local", "BraveSoftware/Brave-Browser/User Data"),
      mac("BraveSoftware/Brave-Browser"),
      linux("BraveSoftware/Brave-Browser"),
    ],
  },
  {
    id: "firefox",
    group: "browser",
    reason: "Firefox의 저장된 비밀번호·쿠키·로그인이 있어요",
    places: [
      win("roaming", "Mozilla/Firefox/Profiles"),
      mac("Firefox/Profiles"),
      home(".mozilla/firefox", "folder", ["linux"]),
    ],
  },
  {
    id: "whale",
    group: "browser",
    reason: "네이버 웨일의 저장된 비밀번호·쿠키·로그인이 있어요",
    places: [win("local", "Naver/Naver Whale/User Data")],
  },
  {
    id: "chromium",
    group: "browser",
    reason: "Chromium·Vivaldi·Opera의 저장된 비밀번호·쿠키·로그인이 있어요",
    places: [
      win("local", "Chromium/User Data"),
      win("local", "Vivaldi/User Data"),
      win("roaming", "Opera Software"),
      mac("Chromium"),
      mac("Vivaldi"),
      mac("com.operasoftware.Opera"),
      linux("chromium"),
      linux("vivaldi"),
      linux("opera"),
    ],
  },

  // Crypto wallets' own folders (browser wallet extensions live in the profiles above).
  {
    id: "bitcoin",
    group: "wallet",
    reason: "Bitcoin Core 지갑이에요",
    places: [win("roaming", "Bitcoin"), mac("Bitcoin"), home(".bitcoin", "folder", ["linux"])],
  },
  {
    id: "electrum",
    group: "wallet",
    reason: "Electrum 지갑이에요",
    places: [win("roaming", "Electrum"), home(".electrum", "folder", POSIX)],
  },
  {
    id: "exodus",
    group: "wallet",
    reason: "Exodus 지갑이에요",
    places: [win("roaming", "Exodus"), mac("Exodus"), linux("Exodus")],
  },
  {
    id: "ethereum",
    group: "wallet",
    reason: "Ethereum 지갑 키 파일(keystore)이에요",
    places: [
      win("roaming", "Ethereum/keystore"),
      home("Library/Ethereum/keystore", "folder", ["darwin"]),
      home(".ethereum/keystore", "folder", ["linux"]),
    ],
  },
  {
    id: "atomic",
    group: "wallet",
    reason: "Atomic Wallet 지갑이에요",
    places: [win("roaming", "atomic"), mac("atomic"), linux("atomic")],
  },
  {
    id: "ledger",
    group: "wallet",
    reason: "Ledger Live의 계정 정보예요",
    places: [win("roaming", "Ledger Live"), mac("Ledger Live"), linux("Ledger Live")],
  },
  {
    id: "trezor",
    group: "wallet",
    reason: "Trezor Suite의 계정 정보예요",
    places: [win("roaming", "@trezor/suite-desktop"), mac("@trezor/suite-desktop"), linux("@trezor/suite-desktop")],
  },
  {
    id: "litecoin",
    group: "wallet",
    reason: "Litecoin Core 지갑이에요",
    places: [win("roaming", "Litecoin"), mac("Litecoin"), home(".litecoin", "folder", ["linux"])],
  },
  {
    id: "monero",
    group: "wallet",
    reason: "Monero 지갑이에요",
    places: [win("home", "Documents/Monero"), home("Monero", "folder", POSIX), home(".bitmonero", "folder", POSIX)],
  },
  {
    id: "wasabi",
    group: "wallet",
    reason: "Wasabi 지갑이에요",
    places: [win("roaming", "WalletWasabi"), home(".walletwasabi", "folder", POSIX)],
  },
  { id: "solana", group: "wallet", reason: "Solana CLI 지갑 키(id.json)예요", places: [home(".config/solana")] },

  // Shell histories: a password or token typed or pasted into a command stays there.
  {
    id: "history",
    group: "history",
    reason: "셸 명령 기록이에요. 입력하거나 붙여 넣은 비밀번호·토큰이 남아 있을 수 있어요",
    places: [
      home(".bash_history", "file"),
      home(".zsh_history", "file"),
      win("roaming", "Microsoft/Windows/PowerShell/PSReadLine"),
      home(".local/share/powershell/PSReadLine", "folder", POSIX),
    ],
  },
]

/** Where the bases are on the service's machine. */
export interface Bases {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/** A built-in entry placed on this machine: its display paths and its patterns (core's wildcard, `/`). */
export interface Placed {
  readonly id: string
  readonly group: ProtectedPaths.Group
  readonly reason: string
  /** Absolute, with the machine's separators. */
  readonly paths: ReadonlyArray<string>
  readonly patterns: ReadonlyArray<string>
}

/** {@link ENTRIES} placed on the service's machine; entries with no place on its OS are left out. */
export function place(bases: Bases): ReadonlyArray<Placed> {
  const os = bases.platform === "win32" || bases.platform === "darwin" ? bases.platform : "linux"
  const join = bases.platform === "win32" ? path.win32 : path.posix
  return ENTRIES.flatMap((entry) => {
    const places = entry.places.filter((item) => item.os === undefined || item.os.includes(os))
    if (places.length === 0) return []
    const absolute = places.map((item) => ({ item, at: join.join(folder(item.base, bases), item.path) }))
    return [
      {
        id: entry.id,
        group: entry.group,
        reason: entry.reason,
        paths: absolute.map((entry) => entry.at),
        patterns: absolute.flatMap((entry) => patterns(entry.at, entry.item.shape)),
      },
    ]
  })
}

/** Patterns of a place: a folder and everything in it, one file, or every name starting with it. */
export function patterns(absolute: string, shape: Shape): ReadonlyArray<string> {
  const slashed = absolute.replaceAll("\\", "/")
  if (shape === "file") return [slashed]
  if (shape === "prefix") return [`${slashed}*`]
  return [slashed, `${slashed}/**`]
}

/** A base folder on the service's machine. */
export function folder(name: Base, bases: Bases) {
  const join = bases.platform === "win32" ? path.win32 : path.posix
  const env = (key: string) => {
    const value = bases.env[key]
    return value && join.isAbsolute(value) ? value : undefined
  }
  if (name === "home") return bases.home
  if (name === "roaming") return env("APPDATA") ?? join.join(bases.home, "AppData", "Roaming")
  if (name === "local") return env("LOCALAPPDATA") ?? join.join(bases.home, "AppData", "Local")
  if (name === "library") return join.join(bases.home, "Library", "Application Support")
  if (name === "config") return env("XDG_CONFIG_HOME") ?? join.join(bases.home, ".config")
  return env("CODEX_HOME") ?? join.join(bases.home, ".codex")
}
