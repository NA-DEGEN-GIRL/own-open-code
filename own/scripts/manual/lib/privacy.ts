// What the manual's screenshots must never show (own/docs/manual/PLAN.md §4.4): this PC's user name, PC name, real
// home folder and the temp folders the demo lives in. The demo's paths are rewritten on screen only (text nodes and a
// few attributes; never an input's value, which the page would send), and every shot is checked before it is saved.
import os from "node:os"
import path from "node:path"

export interface Mapping {
  readonly from: string
  readonly to: string
}

/** A demo world's folders on disk (Windows paths). */
export interface WorldPaths {
  /** Where the demo's projects live: shown as `D:\demo`. */
  readonly demo?: string
  /** The server's HOME: shown as `C:\Users\demo`. */
  readonly home?: string
  /** The world's temp root: anything else under it is shown under the demo user's local app data. */
  readonly root?: string
  /** Extra pairs (a fake SSH host's home, …), applied first. */
  readonly extra?: ReadonlyArray<Mapping>
}

export const DEMO_HOME = "C:\\Users\\demo"
export const DEMO_PROJECTS = "D:\\demo"
export const DEMO_PC = "DEMO-PC"

/** Every spelling of each world path mapped to the same spelling of its demo path, longest first. */
export function mappings(world: WorldPaths): Mapping[] {
  const temp = os.tmpdir()
  const pairs: Mapping[] = [
    ...(world.demo ? [{ from: world.demo, to: DEMO_PROJECTS }] : []),
    ...(world.home ? [{ from: world.home, to: DEMO_HOME }] : []),
    ...(world.root ? [{ from: world.root, to: `${DEMO_HOME}\\AppData\\Local\\own-open-code` }] : []),
    { from: temp, to: `${DEMO_HOME}\\AppData\\Local\\Temp` },
    { from: os.homedir(), to: DEMO_HOME },
  ]
  const spelled = pairs.flatMap((pair) => spellings(pair.from).map((from, index) => ({ from, to: spellings(pair.to)[index]! })))
  const unique = new Map<string, string>()
  for (const pair of [...(world.extra ?? []), ...spelled]) if (!unique.has(pair.from)) unique.set(pair.from, pair.to)
  return [...unique.entries()]
    .map(([from, to]) => ({ from, to }))
    .toSorted((a, b) => b.from.length - a.from.length)
}

/** `C:\a\b`, `C:/a/b`, `c:\a\b`, `c:/a/b`, `/c/a/b`, `C:\\a\\b`, and their URL encodings. */
function spellings(windows: string) {
  const back = path.win32.normalize(windows)
  const forward = back.replaceAll("\\", "/")
  const lower = (text: string) => (/^[A-Z]:/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text)
  const bash = /^[A-Za-z]:/.test(forward) ? `/${forward[0]!.toLowerCase()}${forward.slice(2)}` : forward
  const plain = [back, forward, lower(back), lower(forward), bash, back.replaceAll("\\", "\\\\")]
  return [...plain, ...plain.slice(0, 4).map((text) => encodeURIComponent(text))]
}

/** The init script that rewrites `pairs` on screen (text nodes and `title`, `aria-label`, `placeholder`, `alt`). */
export function initScript(pairs: ReadonlyArray<Mapping>) {
  return `(() => {
  const pairs = ${JSON.stringify(pairs)};
  const lowered = pairs.map((pair) => ({ from: pair.from.toLowerCase(), to: pair.to }));
  const ATTRS = ["title", "aria-label", "placeholder", "alt", "data-tooltip"];
  const fix = (text) => {
    if (!text) return text;
    let out = text;
    for (const pair of pairs) if (out.includes(pair.from)) out = out.split(pair.from).join(pair.to);
    const low = out.toLowerCase();
    for (const pair of lowered) {
      let at = low.indexOf(pair.from);
      if (at < 0) continue;
      let next = "";
      let rest = out;
      while ((at = rest.toLowerCase().indexOf(pair.from)) >= 0) {
        next += rest.slice(0, at) + pair.to;
        rest = rest.slice(at + pair.from.length);
      }
      out = next + rest;
    }
    return out;
  };
  const visit = (node) => {
    if (node.nodeType === 3) {
      const next = fix(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== 1) return;
    for (const name of ATTRS) {
      const value = node.getAttribute(name);
      if (value === null) continue;
      const next = fix(value);
      if (next !== value) node.setAttribute(name, next);
    }
    const tag = node.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") return;
    for (const child of node.childNodes) visit(child);
  };
  window.__manualPrivacy = () => document.documentElement && visit(document.documentElement);
  const start = () => {
    window.__manualPrivacy();
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") visit(record.target);
        else if (record.type === "attributes") visit(record.target);
        else for (const node of record.addedNodes) visit(node);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();`
}

/** Patterns no shot may contain (checked in the page's text, attributes and input values). */
export function forbidden() {
  const user = os.userInfo().username
  const host = os.hostname()
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return [
    { name: "user name", source: `(?<![A-Za-z0-9])${escape(user)}(?![A-Za-z0-9])`, flags: "i" },
    // A short PC name is checked as a whole word in its own, lower and upper case only (`na` is part of many words).
    {
      name: "PC name",
      source: `(?<![A-Za-z0-9-])(?:${[...new Set([host, host.toLowerCase(), host.toUpperCase()])].map(escape).join("|")})(?![A-Za-z0-9-])`,
      flags: host.length <= 3 ? "" : "i",
    },
    { name: "home folder", source: "[\\\\/]Users[\\\\/](?!demo(?![A-Za-z0-9]))", flags: "i" },
    { name: "temp folder", source: "scratchpad|manual-demo|own-team-e2e|Temp[\\\\/]claude|D---Projects", flags: "i" },
    { name: "e-mail", source: "[A-Za-z0-9._%+-]+@(?!example\\.(?:com|test|invalid)\\b)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", flags: "" },
  ]
}

/** The page-side check: text, every attribute value and every input value; returns the problems found. */
export function checkScript(patterns: ReturnType<typeof forbidden>) {
  return `(() => {
  window.__manualPrivacy?.();
  const patterns = ${JSON.stringify(patterns)}.map((item) => ({ name: item.name, re: new RegExp(item.source, item.flags) }));
  const texts = [document.body ? document.body.innerText : ""];
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (attribute.name === "href" || attribute.name === "src" || attribute.name === "style" || attribute.name === "class") continue;
      texts.push(attribute.value);
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) texts.push(element.value);
  }
  const found = [];
  for (const text of texts)
    for (const pattern of patterns) {
      const match = pattern.re.exec(text);
      if (match) found.push(pattern.name + " " + JSON.stringify(match[0]) + " in …" + text.slice(Math.max(0, match.index - 30), match.index + 40).replace(/\\s+/g, " ") + "…");
    }
  return [...new Set(found)].slice(0, 10);
})()`
}
