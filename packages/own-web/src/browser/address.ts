// The address field's rule (03 §18.17): what typed text opens. Its own module so the device viewer (remote/, 05 §8.10)
// reuses it without the desktop pane's chunk; index.tsx re-exports `normalizeAddress`.
/** Where text that is not an address goes: Google, like upstream's own address field (gui-extensions address.ts). */
const SEARCH = "https://www.google.com/search?q="

/**
 * Address bar input → what the pane opens (http, https, about:blank), or undefined for text it does not open: another
 * scheme (`file:`, `javascript:`, a drive path such as `C:\…`, which would otherwise go to the search engine) or a
 * broken `http(s)://` URL. Text that names a host opens as an address: https, or http for this machine's names
 * (`localhost`, `127.x`, `[::1]`). Any other text, and text with spaces, is a web search. The same rule as upstream's
 * `resolveAddress` (v2.0.28), except that a dotted name must end in a letter label or be an IPv4 address ("3.14" is a
 * search) and other schemes are refused here instead of by main.
 */
export function normalizeAddress(value: string) {
  const input = value.trim()
  if (!input) return undefined
  if (/^about:blank$/i.test(input)) return "about:blank"
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return /^https?:/i.test(input) && webURL(input) ? input : undefined
  if (/\s/.test(input)) return search(input)
  // `localhost:5173` and `my-server:8080` are a host and its port, not a scheme.
  if (/^[a-z][a-z\d+.-]*:(?!\d)/i.test(input)) return undefined
  const host = input.split(/[/?#]/, 1)[0]!
  const url = `${/^((?:[a-z\d-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host) ? "http" : "https"}://${input}`
  return namesHost(host) && webURL(url) ? url : search(input)
}

function search(input: string) {
  return `${SEARCH}${encodeURIComponent(input)}`
}

/** `localhost`, an IPv6 literal, anything with a port, or a dotted name that ends in a letter label or is IPv4. */
function namesHost(host: string) {
  if (/:\d+$/.test(host) || /^(localhost|\[[\da-f:.]+\])$/i.test(host)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return /^[^.]+(\.[^.]+)+$/.test(host) && /[^\d]/.test(host.slice(host.lastIndexOf(".") + 1))
}

/** An http(s) URL main opens: it parses, and carries no user name or password (main refuses those). */
function webURL(input: string) {
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  return /^https?:$/.test(url.protocol) && !url.username && !url.password
}
