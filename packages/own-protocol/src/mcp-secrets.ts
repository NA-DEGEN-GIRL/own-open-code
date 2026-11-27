export * as McpSecrets from "./mcp-secrets.js"

import { McpDsn } from "./mcp-dsn.js"
import { encode, strings } from "./mcp-json.js"
import { ENV_NAME, HEADER_NAME, REFERENCE } from "./mcp-rules.js"

/**
 * Values that hide in a server's definition (03 §18.14, SM-4, SM-15, SM-22, SM-25), found the same way by own.accounts
 * (the import, `mcp.save` and `mcp.test`, which move them into the vault) and own-web (a config file's server, shown
 * with them as `••••`). Plain code, no schemas, so the page reads it without the RPC graph. An argument's values are:
 * - the argument after a flag that takes one (`--token`, `--api-key`, `--accessToken`, Go's `-token`; not switches
 *   such as `--no-auth`), or after a known tool's short flag (`vercel -t`, `openai -k` …, {@link TOOLS}), and the part
 *   after `=` of `--token=…`;
 * - environment pairs: `KEY=VALUE` after `-e`/`--env` (docker, podman) or in `--env=KEY=VALUE`, and any `KEY=VALUE`
 *   whose KEY looks secret ({@link secretName});
 * - headers: `Name: value` after `--header`/`-H`, or anywhere when the name looks secret (`Authorization`,
 *   `x-api-key`, `Cookie`, …), and mcp-proxy's two-argument `--headers Name value` when the name looks secret; the
 *   scheme word of `Bearer <token>` stays;
 * - a JSON argument (`--config {"apiKey": …}`, `--config={…}`, a bare `{…}` or `[…]`): the text of every field whose
 *   name looks secret, rewritten in place (`McpJson`, every other token as written) and stored as the text itself;
 *   `McpRules.expand` writes it back as JSON (SM-26);
 * - in an address (`scheme://…`, `jdbc:postgresql://…` too): the user info, key-like path segments ({@link pathKeys}),
 *   every query value and the secret `;name=value` properties after its host or path (`jdbc:sqlserver://…;password=…`);
 * - a connection string of two or more parts ({@link connectionSecrets}: `Server=…;Password=…`, libpq's
 *   `host=… password=…`, Go MySQL's `user:pass@tcp(…)/db`, Oracle's `user/pass@host:1521/svc`): only its secret parts,
 *   a quoted one as the driver reads it (`Password="a""b"` stores `a"b`; `McpRules.expand` quotes it again, SM-28);
 * - a known kind of key ({@link KEY_FORMS}) anywhere in an argument: only that part.
 * Beside `${NAME}` references a value keeps them and its literal parts move (`--token ${PREFIX}abc` →
 * `${PREFIX}${TOKEN}`), and a `${NAME:-default}` whose default is a value (any default where a value stands, a
 * key-like one elsewhere) becomes `${NAME}` with the default stored as NAME (none when NAME already has a value, which
 * then always wins; another default of the same name gets its own, `NAME_2`). A stored name is never one that a
 * reference left as written reads otherwise (`${K}`, `${K:-plain}`: SM-27). `lift` stores each as an environment
 * value and leaves `${NAME}` (`McpRules.REFERENCE`, put back in when the server starts); {@link maskArgs} shows it as
 * `••••`. An address of a remote server is split by {@link address}.
 */

/** Known kinds of keys (OpenAI and others, GitHub, GitLab, Slack, AWS, Google, Hugging Face, npm, PyPI). */
const KEY_FORMS = String.raw`(?:sk|pk|rk)[-_](?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{16,}|hf_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{16,}`
const PREFIX = new RegExp(`^(?:${KEY_FORMS})$`)
/** The same forms inside a longer text (`Bearer ghp_…`, `prefix-ghp_…`), not in the middle of a word. */
const EMBEDDED = new RegExp(`(?<![A-Za-z0-9])(?:${KEY_FORMS})(?![A-Za-z0-9_-])`, "g")

/**
 * A token that may be a key: letters and digits mixed, with `_`, `-` and base64's `+` and `=` padding, no dots (not a
 * version or a host). {@link RANDOM_MIN} characters alone, and then a key unless it reads as a name ({@link keyPiece});
 * {@link DEFAULT_MIN} as the default of `${VAR:-default}`, which its place already marks as a value.
 */
const RANDOM = /^(?=[^=]*[0-9])(?=[^=]*[A-Za-z])[A-Za-z0-9_+-]+={0,2}$/
const RANDOM_MIN = 24
const DEFAULT_MIN = 20
/**
 * A GUID or a run of 24 or more hex digits, anywhere in a piece: random by how it is made, so always a key (SM-28), a
 * word-like prefix or suffix beside it too (`dapi…`, `shpat_…`, `token_…`, `pat-na1-<GUID>`, `<hex>-us21`), whose
 * letters would otherwise read as words.
 */
const HEX_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,}/i
/**
 * The letter pairs of English words, by first letter (`abcd…` is `ab`, `ac`, `ad` …): the 261 pairs that make 99% of
 * the pairs in English prose (counted over the documentation comments of TypeScript 5.8's `lib.*.d.ts`, SM-28). About
 * 39% of random pairs are among them, and nearly all of a name's.
 */
const PAIRS = new Set(
  (
    "abcdgilmnprstuvy baeijlosuy cacehiklorstuy dabdeinorsu eabcdefgilmnopqrstvwxy faefilnorsu gaehilnrtu haeiort " +
    "iabcdefglmnoprstvxz jae kef labdeilorstuy mabdeilmopsu nacdegilnopstuv oabcdfiklmnoprstuvwz paeiloprstu qu " +
    "racdefgiklmnorstuvwy sacefhiopstuvy tacehilmoprstuy uabcdeflmnprst vaegio waehiors xcpt ypst zei"
  )
    .split(" ")
    .flatMap((entry) => [...entry.slice(1)].map((second) => entry[0] + second)),
)
/** {@link named} wants this share of a piece's letter pairs to be English ones. */
const SPOKEN = 0.75

/**
 * Standard base64 (`+`, `/`, `=` padding), the alphabet of a key that a raw `/` cuts across path segments (SM-26);
 * {@link KEY_BASE64} also wants both cases and a digit, as a random key has.
 */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const KEY_BASE64 = /^(?=[^=]*[0-9])(?=[^=]*[a-z])(?=[^=]*[A-Z])[A-Za-z0-9+/]+={0,2}$/
/** Base64 lengths of 16-, 24-, 30- (an AWS secret key), 32-, 48- and 64-byte keys, padded and not. */
const KEY_LENGTHS = new Set([22, 24, 32, 40, 43, 44, 64, 86, 88])
/** The longest key a raw `/` is followed through, and the most pieces a key of a key's length is put together from. */
const JOINED_MAX = 256
const SPLIT_MAX = 4
/** A plain word as a path piece (`mcp`, `Users`, `SSE`): never part of a key cut by `/`. */
const WORD = /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)$/
/**
 * The words of a name in camel case: a capital and small letters, capitals, digits (`Paddle`, `ONNX`, `2025`);
 * {@link randomLooking} wants those of three or more to make less than {@link WORDY} of a key's letters and digits.
 */
const TOKENS = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g
const WORDY = 0.6
/** A path's `/` and percent-encoded `%2F` outside `${…}`, kept as written (the capture) when it is put together. */
const SEPARATOR = /(\/|%2[Ff])(?![^{]*\})/

/**
 * `scheme://authority/path?query#fragment`, by its parts as written (nothing decoded or normalized); a scheme of
 * several words (`jdbc:postgresql://`, SM-27) too.
 */
const URL_PARTS = /^([A-Za-z][A-Za-z0-9+.-]*(?::[A-Za-z][A-Za-z0-9+.-]*)*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/

const HEADER_FLAG = /^(?:--headers?|-H)$/
const ENV_FLAG = /^(?:-e|--env)$/
const PAIR = /^([A-Za-z_][A-Za-z0-9_]{0,127})=([\s\S]+)$/
const HEADER = /^([!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}):([ \t]*)([\s\S]+)$/
const SCHEME = /^((?:bearer|basic|token|digest)[ \t]+)([\s\S]+)$/i

/** First words of a flag that switch something rather than take a value: `--no-auth`, `--use-key`. */
const SWITCHES = new Set(["no", "disable", "enable", "skip", "use", "with", "without", "allow"])
/** A flag's last word that names a value, or how such a word ends (`--authtoken`, `--apikey`). */
const VALUE_WORDS = new Set(["key", "pwd", "pass", "auth", "authorization", "bearer", "credential", "credentials", "pat"])
const VALUE_ENDS = ["token", "secret", "password", "passwd", "apikey"]
/** A name's words that make it secret (`GITHUB_TOKEN`, `x-api-key`, `DB_PASSWORD`, `Cookie`). */
const SECRET_WORDS = new Set([
  ...VALUE_WORDS,
  "cookie",
  "session",
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "tokens",
  "secrets",
  "keys",
])
/** A last word that names where or what a secret is, not the secret: `TOKEN_FILE`, `API_KEY_PATH`, `AUTH_URL`. */
const NOT_SECRET_ENDS = new Set(["file", "path", "dir", "url", "uri", "host", "port", "id", "name", "mode", "type"])

/**
 * Short flags that take a value for the tools that are known to use them; elsewhere `-t`, `-k` and the like mean
 * other things (`gitea-mcp -t stdio`, `curl -k`), so they stay. A tool is known when the command or an earlier
 * argument names it (`npx -y vercel@latest -t …`). The value's stored name is given.
 */
const TOOLS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  vercel: { "-t": "TOKEN" },
  glab: { "-t": "TOKEN" },
  openai: { "-k": "API_KEY" },
  "redis-cli": { "-a": "PASSWORD" },
  mongosh: { "-p": "PASSWORD" },
  sshpass: { "-p": "PASSWORD" },
  curl: { "-u": "CREDENTIALS" },
}

/** Whether an argument looks like a key by itself (a known prefix). */
export function keyLike(text: string) {
  return PREFIX.test(text)
}

/**
 * Whether a part of an address, or a value under a plain name, looks like a key: a known prefix, or a token of
 * {@link RANDOM_MIN} or more characters ({@link keyPiece}; base64 too, its percent-encoded `%2B` and `%3D` read as `+`
 * and `=`, SM-26).
 */
export function addressKeyLike(text: string) {
  return PREFIX.test(text) || keyPiece(keyChars(text))
}

/**
 * A token of {@link RANDOM_MIN} or more characters with a letter and a digit is a key unless it reads as a name (SM-28):
 * one that holds a GUID or a hex id ({@link HEX_ID}, `key_<GUID>` and `SK<hex>` too) always is one, as is a text that
 * reads as random ({@link randomLooking}) or not as words ({@link named}). So `CVPR2024-Papers-with-Code`,
 * `Q4PlanningWorkspace2025Final`, `Meta-Llama-3-8B-Instruct` and `claude-3-5-sonnet-20241022` are names; a random key
 * of one case or both (`k3jx9qmz…`, `Zq8wXc3R…`) is a key. A name made mostly of short capitals
 * (`aws-sdk-js-v3-client-s3-2024`) may read as a key, and is then hidden: the safe side.
 */
function keyPiece(text: string) {
  return randomLike(text, RANDOM_MIN) && (HEX_ID.test(text) || randomLooking(text) || !named(text))
}

/**
 * Whether a text reads as words (SM-28): its letters stand mostly in words of two or more (camel-case words and runs of
 * capitals or small letters; digits do not count), and at least {@link SPOKEN} of those words' letter pairs are English
 * ones ({@link PAIRS}). Random letters seldom are: one or two random keys of 24 characters in a hundred, fewer when
 * longer (SM-28 measured it; with {@link randomLooking} a key of both cases is missed about once in five hundred).
 */
function named(text: string) {
  const words = (text.match(TOKENS) ?? []).filter((token) => !/^[0-9]/.test(token)).map((word) => word.toLowerCase())
  const pairs = words.flatMap((word) => Array.from({ length: word.length - 1 }, (_, at) => word.slice(at, at + 2)))
  return (
    pairs.length > 0 &&
    pairs.length * 2 >= words.join("").length &&
    pairs.filter((pair) => PAIRS.has(pair)).length >= pairs.length * SPOKEN
  )
}

/**
 * Whether a stored value under a plain name may still hold a secret (SM-26): a key ({@link addressKeyLike}), any
 * address (`DATABASE_URL=postgres://user:pw@…`, a webhook whose last segment is its key, a DSN with the key as user
 * info, `jdbc:postgresql://…?password=…`; what of it is secret is the masker's to say), or a connection string with a
 * secret part ({@link connectionSecrets}).
 */
export function secretValue(value: string) {
  return addressKeyLike(value) || URL_PARTS.test(value) || connectionSecrets(value).length > 0
}

/**
 * The secret parts of a connection string, as written and, when quoting changes them, as read (SM-26, SM-27):
 * - `Name=value;…` (every part so, quoted values as one): the values of names that look secret ({@link secretName}:
 *   `Password=`, `pwd=`, `AccountKey=`, `key=`), the inside of `Password="a;b"`, and of Azure's
 *   `SharedAccessSignature=sv=…&sig=…` the `sig`;
 * - libpq's `host=… password=…` (every word so): the values of secret names, the inside of `password='a b'`;
 * - Go MySQL's `user:pass@tcp(host)/db` and Oracle's `user/pass@host:1521/svc`: the password;
 * - an address's `;name=value` properties after its host or path (`jdbc:sqlserver://h:1433;password=…`).
 * Else none. Other parts (`Server=`, `User=`, the host, the user) are no secret.
 */
export function connectionSecrets(value: string): string[] {
  const address = URL_PARTS.exec(value)
  const pieces = address
    ? [hostOf(address[2]!), address[3]!].flatMap((text) => properties(text) ?? [])
    : (connection(value, 1) ?? [])
  return pieces.flatMap((piece) =>
    piece.kind === "secret" ? [piece.text, ...(piece.read === piece.text ? [] : [piece.read])] : [],
  )
}

/**
 * The parts of an address's path (between the host and `?`) that hold a key, as written: key-like segments and the
 * runs of segments a raw or encoded `/` cut out of one base64 key ({@link keyed}).
 */
export function pathKeys(path: string) {
  return pathGroups(path).flatMap((group) => (group.key ? [group.text] : []))
}

/**
 * Whether an environment name or a header name looks like it holds a secret: one of its words (split at `_`, `-`, `.`
 * and camel case) is `token`, `secret`, `key`, `password`, `auth`, `authorization`, `cookie` and the like, or ends
 * in `token`/`secret`/`password`/`apikey`, unless its last word says where the secret is (`TOKEN_FILE`, `KEY_PATH`).
 */
export function secretName(name: string) {
  const parts = words(name)
  const last = parts.at(-1)
  if (last === undefined || NOT_SECRET_ENDS.has(last)) return false
  return parts.some((part) => SECRET_WORDS.has(part) || VALUE_ENDS.some((end) => part.endsWith(end)))
}

export interface Lifted {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** The environment values, the moved ones added (an equal value already stored is reused under its name). */
  readonly env: Readonly<Record<string, string>>
  /** Something was moved out of the arguments. */
  readonly moved: boolean
}

/** Moves the values of a command's arguments into its environment values, the arguments keeping `${NAME}`. */
export function lift(command: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>>): Lifted {
  const values: Record<string, string> = { ...env }
  const state = { moved: false }
  const kept = unlifted(command, args)
  const put = (value: string, base: string) => {
    state.moved = true
    const same = Object.entries(values).find((entry) => entry[1] === value)?.[0]
    if (same !== undefined) return "${" + same + "}"
    // Not a name that a reference left as written reads otherwise (`${K}`, `${K:-plain}`, SM-27): it would read this.
    const name = free(
      base,
      (name) => Object.hasOwn(values, name) || kept.some((ref) => ref.name === name && ref.fallback !== value),
    )
    values[name] = value
    return "${" + name + "}"
  }
  // A default beside a given value of its name is never used, so only the reference stays. A name this lift stored
  // (another default, a moved value) is no given value: this default keeps its own under a free name (`K_2`, SM-26).
  const fallback = (name: string, value: string) => {
    if (!Object.hasOwn(env, name)) return put(value, name)
    state.moved = true
    return "${" + name + "}"
  }
  const lifted = scrubArgs(command, args, { value: put, fallback })
  return { command, args: lifted, env: values, moved: state.moved }
}

/**
 * The references of a command and its arguments that a lift leaves as written (SM-27): every `${NAME}` and
 * `${NAME:-default}` but the defaults it moves, which a dry run of the same rules finds.
 */
function unlifted(command: string, args: ReadonlyArray<string>) {
  const moved: Array<{ name: string; fallback: string }> = []
  scrubArgs(command, args, {
    value: () => "",
    fallback: (name, fallback) => {
      moved.push({ name, fallback })
      return ""
    },
  })
  return [command, ...args]
    .flatMap((text) => [...text.matchAll(REFERENCE)])
    .map((match) => ({ name: match[1]!, fallback: match[2] }))
    .filter((ref) => {
      const at = moved.findIndex((item) => item.name === ref.name && item.fallback === ref.fallback)
      if (at >= 0) moved.splice(at, 1)
      return at < 0
    })
}

/** A command's arguments as a page may show them: every value {@link lift} would move is `••••`. */
export function maskArgs(command: string, args: ReadonlyArray<string>) {
  return scrubArgs(command, args, MASKING)
}

/**
 * An address as a page may show it: the user info, key-like path segments, known keys and every query value as
 * `••••` (`https://••••@host/s/••••/mcp?key=••••`), the `#` part left out.
 */
export function maskAddress(value: string) {
  const parts = URL_PARTS.exec(value)
  if (!parts) return embedded(value, MASKING)
  const query = parts[4] ? `?${parts[4].slice(1).split("&").map(maskParam).join("&")}` : ""
  return `${shownBase(`${parts[1]}${parts[2]}${parts[3]}`)}${query}`
}

export interface Address {
  /** The address before `?` (no `#` part), as the server is called. */
  readonly base: string
  /** The part from `?`, `?` included, or "". */
  readonly search: string
  /** A part of `base` holds a value: `base` goes into the vault and {@link Address.shown} is what files and answers keep. */
  readonly hidden: boolean
  readonly shown: string
}

/**
 * An address split for storing: its `?` part (always a value), and whether a part before it holds one (user info, a
 * key-like path segment, a known key). `written` is the address as another tool wrote it with `${VAR}` parts (Claude
 * Code): then the address is hidden and shown as written up to `?`, the variables named, its user info, key-like
 * segments and known keys as `••••`, and a `${VAR:-default}` whose default looks like a key as `${VAR:-••••}`.
 */
export function address(value: string, written?: string): Address {
  const url = new URL(value)
  const search = url.search
  url.search = ""
  url.hash = ""
  const base = url.href
  const named = written?.split(/[?#]/)[0]
  if (named !== undefined && named.includes("${")) return { base, search, hidden: true, shown: shownBase(named) }
  const shown = shownBase(base)
  return { base, search, hidden: shown !== base, shown }
}

const MASK = "••••"

interface Store {
  /** What a value becomes: `${NAME}` with the value stored ({@link lift}) or `••••` ({@link maskArgs}). */
  readonly value: (value: string, base: string) => string
  /** What `${NAME:-default}` whose default is a value becomes: `${NAME}` with the default stored, or `${NAME:-••••}`. */
  readonly fallback: (name: string, value: string) => string
  /** The texts are only shown: a rewritten JSON string keeps `••••` readable, not as `\u2022`. */
  readonly shown?: boolean
}

const MASKING: Store = { value: () => MASK, fallback: (name) => "${" + name + ":-" + MASK + "}", shown: true }

/** The arguments with every value replaced by what `store` gives for it (a `${NAME}` or `••••`). */
function scrubArgs(command: string, args: ReadonlyArray<string>, store: Store) {
  return args.map((arg, index) => {
    const previous = args[index - 1]
    if (previous === undefined) return plain(arg, store)
    const short = toolFlag([command, ...args.slice(0, index - 1)], previous)
    if (valueFlag(previous) || short !== undefined)
      return isValue(arg) ? whole(arg, store, short ?? nameOf(previous)) : arg
    if (HEADER_FLAG.test(previous)) return header(arg, store, true) ?? scrub(arg, store)
    // mcp-proxy's two-argument form `--headers Name value`: the value of a secret-looking bare name.
    const flag = args[index - 2]
    if (flag !== undefined && HEADER_FLAG.test(flag) && HEADER_NAME.test(previous) && secretName(previous) && isValue(arg))
      return schemed(arg, store, headerName(previous))
    if (ENV_FLAG.test(previous)) return pair(arg, store, true) ?? scrub(arg, store)
    return plain(arg, store)
  })
}

/** An argument read alone: `--flag=value`, `KEY=VALUE`, `Name: value`, else its JSON, address and known keys. */
function plain(arg: string, store: Store) {
  const flag = /^(--?[A-Za-z][A-Za-z0-9_-]*)=([\s\S]+)$/.exec(arg)
  if (!flag) return pair(arg, store, false) ?? header(arg, store, false) ?? scrub(arg, store)
  const name = flag[1]!
  const value = flag[2]!
  if (valueFlag(name)) return `${name}=${whole(value, store, nameOf(name))}`
  if (HEADER_FLAG.test(name)) return `${name}=${header(value, store, true) ?? scrub(value, store)}`
  if (ENV_FLAG.test(name)) return `${name}=${pair(value, store, true) ?? scrub(value, store)}`
  return `${name}=${scrub(value, store)}`
}

/** A value that is not another flag (`--verbose`, `-v`), nothing, or `-` (standard input). */
function isValue(arg: string) {
  return arg !== "" && arg !== "-" && !/^--[A-Za-z]/.test(arg) && !/^-[A-Za-z]$/.test(arg)
}

/** A long (or Go-style `-token`) flag that takes a value; a single letter only for a known tool ({@link TOOLS}). */
function valueFlag(flag: string) {
  const match = /^--?([A-Za-z][A-Za-z0-9_-]+)$/.exec(flag)
  if (!match) return false
  const parts = words(match[1]!)
  const last = parts.at(-1)
  if (last === undefined || SWITCHES.has(parts[0]!)) return false
  return VALUE_WORDS.has(last) || VALUE_ENDS.some((end) => last.endsWith(end))
}

/** The stored name of a known tool's short flag, when one of `before` names that tool. */
function toolFlag(before: ReadonlyArray<string>, flag: string) {
  if (!/^-[A-Za-z]$/.test(flag)) return undefined
  return before.flatMap((word) => {
    const name = toolName(word)
    const found = Object.hasOwn(TOOLS, name) ? TOOLS[name]![flag] : undefined
    return found === undefined ? [] : [found]
  })[0]
}

/** `C:\bin\redis-cli.exe` → `redis-cli`, `vercel@latest` → `vercel`, `openai==1.2` → `openai`. */
function toolName(word: string) {
  const file = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1)
  return file
    .replace(/(?<=.)[@=]{1,2}[^@=]*$/, "")
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase()
}

/**
 * `KEY=VALUE`: the value is stored after `-e`/`--env` (`always`) or when KEY looks secret; else the whole text may be a
 * connection string that starts so (`host=db password=…`, `Server=db;Password=…`, SM-27), or the value is scrubbed.
 */
function pair(text: string, store: Store, always: boolean) {
  const match = PAIR.exec(text)
  if (!match) return undefined
  const key = match[1]!
  const value = match[2]!
  if (always || secretName(key)) return `${key}=${whole(value, store, key)}`
  return dsn(text, store) ?? `${key}=${scrub(value, store)}`
}

/** `Name: value` with a secret-looking name (or any name after `--header`): its value stored, a scheme word kept. */
function header(text: string, store: Store, flagged: boolean) {
  const match = HEADER.exec(text)
  if (!match || match[3]!.startsWith("//")) return undefined
  const name = match[1]!
  if (!secretName(name)) return flagged ? `${name}:${match[2]}${scrub(match[3]!, store)}` : undefined
  return `${name}:${match[2]}${schemed(match[3]!, store, headerName(name))}`
}

/** A value with the scheme word of `Bearer <token>` kept (a header's, a JSON field's). */
function schemed(value: string, store: Store, base: string) {
  const scheme = SCHEME.exec(value)
  return scheme ? `${scheme[1]}${whole(scheme[2]!, store, base)}` : whole(value, store, base)
}

/**
 * A text that is a value as a whole (after `--token`, of a secret `KEY=`, a secret header's): stored; beside `${NAME}`
 * references, each literal part that holds a letter or digit and each reference's default.
 */
function whole(text: string, store: Store, base: string) {
  if (text.search(REFERENCE) === -1) return store.value(text, base)
  return around(
    text,
    (part) => (/[A-Za-z0-9]/.test(part) ? store.value(part, base) : part),
    (match) => (match[2] ? store.fallback(match[1]!, match[2]) : match[0]),
  )
}

/**
 * A JSON argument's secret fields, an address's values (user info, key-like segments, query values, secret
 * `;name=value` properties), a connection string's secret parts, else known keys anywhere in the text.
 */
function scrub(text: string, store: Store): string {
  const object = json(text, store)
  if (object !== undefined) return object
  const parts = URL_PARTS.exec(text)
  if (!parts) return dsn(text, store) ?? embedded(text, store)
  const authority = parts[2]!
  const at = authority.lastIndexOf("@")
  const user = authority.slice(0, Math.max(at, 0))
  const userinfo = at < 0 ? "" : `${user === "" ? "" : whole(user, store, "URL_USERINFO")}@`
  const host = withProperties(hostOf(authority), store, (head) => embedded(head, store))
  const pathText = withProperties(parts[3]!, store, (head) => path(head, store))
  const query = parts[4] ? `?${parts[4].slice(1).split("&").map((param) => queryParam(param, store)).join("&")}` : ""
  return `${parts[1]}${userinfo}${host}${pathText}${query}${embedded(parts[5] ?? "", store)}`
}

/** An address's authority after its user info. */
function hostOf(authority: string) {
  return authority.slice(authority.lastIndexOf("@") + 1)
}

/**
 * The `;name=value` properties after an address's host or path (JDBC's `jdbc:sqlserver://h:1433;password=…`,
 * `jdbc:jtds:sqlserver://h/db;password=…`): read as a connection string from the first `;`, when it has a secret.
 */
function properties(text: string) {
  const semicolon = text.indexOf(";")
  return semicolon < 0 ? undefined : connection(text.slice(semicolon + 1), 1, "properties")
}

/** The host or path with the secrets of its {@link properties} given to `store`, the part before them to `head`. */
function withProperties(text: string, store: Store, head: (text: string) => string) {
  const pieces = properties(text)
  if (pieces === undefined) return head(text)
  return `${head(text.slice(0, text.indexOf(";")))};${written(pieces, store)}`
}

/** A connection string of two or more parts with a secret ({@link connection}): its secret parts given to `store`. */
function dsn(text: string, store: Store) {
  const pieces = connection(text, 2)
  return pieces === undefined ? undefined : written(pieces, store)
}

/**
 * A connection string's pieces put together: a secret given to `store` (a quoted one as the driver reads it, and what
 * `store` gives quoted again in its place, SM-28), another value scrubbed.
 */
function written(pieces: ReadonlyArray<Piece>, store: Store) {
  return pieces
    .map((piece) => {
      if (piece.kind !== "secret") return piece.kind === "value" ? scrub(piece.text, store) : piece.text
      if (piece.quote === undefined) return whole(piece.text, store, piece.name)
      return McpDsn.write(whole(piece.read, store, piece.name), piece.quote)
    })
    .join("")
}

function queryParam(param: string, store: Store) {
  const equals = param.indexOf("=")
  const value = equals < 0 ? "" : param.slice(equals + 1)
  if (value === "") return embedded(param, store)
  const key = param.slice(0, equals)
  return `${key}=${whole(value, store, urlName(key))}`
}

/** An address's path with each key in it ({@link pathGroups}) given to `store`, every other piece as written. */
function path(text: string, store: Store) {
  return pathGroups(text)
    .map((group) => group.separator + (group.key ? store.value(group.text, "URL_KEY") : pathSegment(group.text, store)))
    .join("")
}

/**
 * A path split at `/` and `%2F` (outside `${…}`), each piece with the separator before it, and the pieces of one key
 * ({@link keyed}) put back together into one.
 */
function pathGroups(text: string) {
  const parts = text.split(SEPARATOR)
  const pieces = parts.filter((_, at) => at % 2 === 0)
  const key = keyed(pieces)
  return pieces.reduce<Array<{ separator: string; text: string; key: boolean }>>((groups, piece, at) => {
    const separator = at === 0 ? "" : parts[at * 2 - 1]!
    const last = groups.at(-1)
    if (key[at] && last?.key) return [...groups.slice(0, -1), { ...last, text: last.text + separator + piece }]
    return [...groups, { separator, text: piece, key: key[at]! }]
  }, [])
}

/**
 * Which pieces of a path hold a key (SM-26, narrowed in SM-27 and SM-28): a key-like piece ({@link addressKeyLike}: a
 * known prefix, a GUID, or 24 or more characters that do not read as a name), with the
 * base64 pieces of both cases beside it that a raw `/` cut off (`RkFL…0w/MDA5…eQ==`), each of which reads as random
 * ({@link randomLooking}); and up to {@link SPLIT_MAX} pieces that together are base64 of a key's length
 * ({@link KEY_LENGTHS}) with both cases and a digit, its `=` padding or a `+` (no name has them), and read as random.
 * A piece with a `${NAME}` reference or a plain word (`mcp`, `Users`, `SSE`) never joins one, nor does an id of one
 * case beside a key (Slack's `T0000/B0000`). So ordinary paths stay as they are: `/api/v1/servers/2025/mcp`, and
 * names of a key's length (`PaddlePaddle/Paddle2ONNX`, `MyProjectDashboard2025`). A key of 22, 32, 40, 43, 64 or 86
 * characters without a `+` that a `/` cuts is missed: rare in a path, and missing it is better than hiding a name.
 */
function keyed(pieces: ReadonlyArray<string>) {
  const plain = pieces.map((piece) => (piece.includes("${") ? undefined : keyChars(piece)))
  const joins = plain.map((piece) => piece !== undefined && piece !== "" && !WORD.test(piece))
  const random = plain.map(
    (piece, at) =>
      piece !== undefined && joins[at] && /[a-z]/.test(piece) && /[A-Z]/.test(piece) && randomLooking(piece),
  )
  const text = (from: number, to: number) => plain.slice(from, to + 1).join("/")
  const fits = (from: number, to: number) => {
    const joined = text(from, to)
    return joined.length <= JOINED_MAX && BASE64.test(joined)
  }
  const widen = (from: number, to: number): readonly [number, number] => {
    if (random[from - 1] && fits(from - 1, to)) return widen(from - 1, to)
    if (random[to + 1] && fits(from, to + 1)) return widen(from, to + 1)
    return [from, to]
  }
  const beside = plain.flatMap((piece, at) =>
    piece !== undefined && addressKeyLike(piece) ? [widen(at, at)] : [],
  )
  const sized = plain.flatMap((_, from) =>
    plain.slice(from, from + SPLIT_MAX).flatMap((_, offset): Array<readonly [number, number]> => {
      const to = from + offset
      const joined = text(from, to)
      return joins.slice(from, to + 1).every(Boolean) &&
        KEY_LENGTHS.has(joined.length) &&
        KEY_BASE64.test(joined) &&
        /\+|=$/.test(joined) &&
        randomLooking(joined)
        ? [[from, to]]
        : []
    }),
  )
  const runs = [...beside, ...sized]
  return pieces.map((_, at) => runs.some((run) => run[0] <= at && at <= run[1]))
}

/**
 * Whether a key's text reads as random, not as a name (SM-27): its camel-case words and digit groups of three or more
 * (`Paddle`, `Dashboard`, `ONNX`, `2025`) make less than {@link WORDY} of its letters and digits, and the kind of
 * character (capital, small letter, digit) changes at least every other character, as in random base64.
 */
function randomLooking(text: string) {
  const chars = text.replace(/[^A-Za-z0-9]/g, "")
  const words = (chars.match(TOKENS) ?? []).filter((word) => word.length >= 3).join("").length
  const kinds = [...chars].map((char) => (/[A-Z]/.test(char) ? 0 : /[a-z]/.test(char) ? 1 : 2))
  const changes = kinds.filter((kind, at) => at > 0 && kind !== kinds[at - 1]).length
  return words < chars.length * WORDY && changes * 2 >= chars.length - 1
}

/**
 * A path piece that holds no key by itself: beside `${NAME}` its key-like literal parts, a key-like default (each
 * `/` part of it, as the default fills the path) and known keys.
 */
function pathSegment(segment: string, store: Store) {
  return around(
    segment,
    (part) => (addressKeyLike(part) ? store.value(part, "URL_KEY") : keys(part, store)),
    (match) => keyDefault(match, store, true),
  )
}

/** A key's percent-encoded `+` and `=` (`%2B`, `%3D`) as the characters themselves. */
function keyChars(text: string) {
  return text.replace(/%2[Bb]/g, "+").replace(/%3[Dd]/g, "=")
}

/** Known keys anywhere in a text but inside its `${NAME}` references, and a reference's default that looks like a key. */
function embedded(text: string, store: Store) {
  return around(
    text,
    (part) => keys(part, store),
    (match) => keyDefault(match, store, false),
  )
}

function keys(text: string, store: Store) {
  return text.replace(EMBEDDED, (key) => store.value(key, "SECRET"))
}

/** `${NAME:-default}` whose default looks like a key: a known key in it, or a random-looking token of 20 or more. */
function keyDefault(match: RegExpMatchArray, store: Store, path: boolean) {
  const fallback = match[2]
  if (!fallback) return match[0]
  const key =
    fallback.search(EMBEDDED) !== -1 ||
    (path ? fallback.split("/") : [fallback]).some((part) => randomLike(part, DEFAULT_MIN))
  return key ? store.fallback(match[1]!, fallback) : match[0]
}

/** `text` with `literal` applied to the parts between its `${NAME}` references and `reference` to each of them. */
function around(text: string, literal: (part: string) => string, reference: (match: RegExpMatchArray) => string) {
  const matches = [...text.matchAll(REFERENCE)]
  const ends = [0, ...matches.map((match) => match.index! + match[0].length)]
  return (
    matches.map((match, index) => literal(text.slice(ends[index], match.index)) + reference(match)).join("") +
    literal(text.slice(ends.at(-1)))
  )
}

/**
 * A JSON argument (`--config {"apiKey": …}`, a top-level array too): the text of each field whose name looks secret is
 * a value (the scheme word of `Bearer <token>` kept; an array's items under the array's name, `{"apiKeys": […]}`),
 * every other text is scrubbed. A changed string is written again in its place in its own escape style (`McpJson`,
 * `\/` and `\u00e9` kept, SM-27) and every other token stays as written, a number's digits too (SM-26). A value is
 * stored as the text itself; `McpRules.expand` writes it back as JSON, so a `"` or `\` in it gives the same JSON.
 */
function json(text: string, store: Store) {
  const found = strings(text)
  if (found === undefined) return undefined
  return found.reduceRight((out, item) => {
    if (item.key || item.value === "") return out
    const value =
      item.field !== undefined && secretName(item.field)
        ? schemed(item.value, store, nameOf(item.field))
        : scrub(item.value, store)
    if (value === item.value) return out
    const encoded = encode(value, text.slice(item.start, item.end), !store.shown)
    return out.slice(0, item.start) + encoded + out.slice(item.end)
  }, text)
}

/**
 * An address before `?` as files and answers show it: user info, key-like segments and known keys as `••••`, and in a
 * written form a `${VAR:-default}` whose default looks like a key as `${VAR:-••••}`.
 */
function shownBase(text: string) {
  const parts = URL_PARTS.exec(text)
  if (!parts) return embedded(text, MASKING)
  const authority = parts[2]!
  const host = withProperties(hostOf(authority), MASKING, (head) => embedded(head, MASKING))
  const pathText = withProperties(parts[3]!, MASKING, (head) => path(head, MASKING))
  return `${parts[1]}${authority.includes("@") ? `${MASK}@` : ""}${host}${pathText}`
}

function maskParam(param: string) {
  const equals = param.indexOf("=")
  return equals < 0 ? embedded(param, MASKING) : `${param.slice(0, equals)}=${MASK}`
}

function randomLike(text: string, min: number) {
  return text.length >= min && RANDOM.test(text)
}

/** A name's words: split at `_`, `-`, `.`, spaces (a connection string's `User ID`) and camel case, lower case. */
function words(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .split(/[-_.\s]+/)
    .filter((part) => part !== "")
    .map((part) => part.toLowerCase())
}

/** `--api-key`, `--apiKey`, a JSON field `apiKey` → `API_KEY`; a name that gives no valid name becomes `SECRET`. */
function nameOf(flag: string) {
  return envName(words(flag).join("_"), "SECRET")
}

/** `X-API-Key` → `X_API_KEY`. */
function headerName(name: string) {
  return envName(name, "HEADER")
}

/**
 * A query parameter's value: `api_key` → `URL_API_KEY`. Stored values reach the server as environment variables, so the
 * prefix keeps `?debug=1` from setting the `DEBUG` a program reads for itself.
 */
function urlName(key: string) {
  return envName(`URL_${key}`, "URL_VALUE")
}

function envName(text: string, fallback: string) {
  const name = text
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
  return ENV_NAME.test(name) ? name : fallback
}

function free(base: string, taken: (name: string) => boolean) {
  const pick = (index: number): string => {
    const name = index === 1 ? base : `${base}_${index}`
    return taken(name) ? pick(index + 1) : name
  }
  return pick(1)
}

// ---------------------------------------------------------------------------------------------------------------
// Connection strings (SM-26, SM-27, SM-28; read by `McpDsn`)

/**
 * A connection string's text: kept, another value, or a secret (stored as `name`; `read`: as the driver reads it;
 * `quote`: how a quoted one is written, `McpDsn.write`).
 */
type Piece =
  | { readonly kind: "text" | "value"; readonly text: string }
  | {
      readonly kind: "secret"
      readonly text: string
      readonly name: string
      readonly read: string
      readonly quote?: McpDsn.Quote
    }

/**
 * A connection string's pieces, when it is one with a secret ({@link connectionSecrets}): `Name=value;…` of at least
 * `min` parts, libpq of at least `min` names, Go MySQL or Oracle; an address's `properties` only the first form.
 */
function connection(text: string, min: number, only?: "properties") {
  const forms =
    only === undefined
      ? [McpDsn.parts(text, min), McpDsn.libpq(text, min), McpDsn.oracle(text), McpDsn.goMysql(text)]
      : [McpDsn.parts(text, min)]
  return forms
    .map((found) => found?.flatMap((piece) => (piece.kind === "text" ? [piece] : valuePieces(piece))))
    .find((pieces) => pieces?.some((piece) => piece.kind === "secret"))
}

/**
 * A part's value: a secret under a secret-looking name (Go MySQL's and Oracle's password is `PASSWORD`), of a query
 * (`sv=…&sig=…`, Azure's `SharedAccessSignature`) its `sig` and secret-looking names' values, else a value to scrub;
 * nothing when it is empty.
 */
function valuePieces(piece: Extract<McpDsn.Piece, { kind: "value" }>): Piece[] {
  if (piece.text === "") return []
  if (secretName(piece.name))
    return [
      {
        kind: "secret",
        text: piece.text,
        name: nameOf(piece.name),
        read: piece.read,
        ...(piece.quote === undefined ? {} : { quote: piece.quote }),
      },
    ]
  const params = piece.text.split("&")
  const query = params.length > 1 && params.every((param) => /^[A-Za-z0-9_.-]+=/.test(param))
  if (!query || !params.some((param) => /^sig=/i.test(param))) return [{ kind: "value", text: piece.text }]
  return params.flatMap((param, at): Piece[] => {
    const equals = param.indexOf("=")
    const key = param.slice(0, equals)
    const head: Piece = { kind: "text", text: `${at === 0 ? "" : "&"}${key}=` }
    const text = param.slice(equals + 1)
    if (text === "") return [head]
    if (key.toLowerCase() === "sig" || secretName(key))
      return [head, { kind: "secret", text, name: nameOf(key), read: text }]
    return [head, { kind: "value", text }]
  })
}
