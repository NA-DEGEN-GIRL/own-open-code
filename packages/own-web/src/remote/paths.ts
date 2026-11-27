// Remote folder names (04 §12.4): `fs.list` answers with paths relative to the location (the control directory), so
// the picker resolves them against the control location before naming them. Pure, unit-tested in paths.test.ts.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * `fs.list` entries are relative to the location (the control directory), not to the listed folder (04 §12.4):
 * resolve each against the control location, keep the direct children of `listed`, and name them by their last
 * segment. A child that is an ancestor of the control location (`.local` of the remote home) comes back as `../..`
 * and still gets its real name this way.
 */
export function folderNames(
  entries: readonly { readonly path: string; readonly type: string }[],
  control: string,
  listed: string,
) {
  const parent = segments(listed)
  const names = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== "directory") continue
    const absolute = resolveSegments(segments(control), entry.path)
    if (absolute.length !== parent.length + 1) continue
    if (!parent.every((part, index) => sameSegment(part, absolute[index]!, listed))) continue
    names.add(absolute.at(-1)!)
  }
  return [...names].sort(collator.compare)
}

function segments(path: string) {
  return path.split(/[\\/]+/).filter((part) => part && part !== ".")
}

function resolveSegments(base: readonly string[], relative: string) {
  const out = [...base]
  for (const part of relative.split(/[\\/]+/)) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out
}

/** Windows paths compare without case (drive letters differ between sources, 03 §16.3). */
function sameSegment(a: string, b: string, sample: string) {
  return /^[A-Za-z]:/.test(sample) || sample.includes("\\") ? a.toLowerCase() === b.toLowerCase() : a === b
}
