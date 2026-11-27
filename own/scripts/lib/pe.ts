// The COFF machine of a PE image (own/scripts/pe-inventory.ts, client-natives.ts, client-check.ts): `MZ`, then at the
// DOS header's e_lfanew (0x3c) `PE\0\0` and the 2-byte Machine field. Read only; nothing is loaded or run.
import fs from "node:fs"

const MACHINES: Readonly<Record<number, string>> = { 0x8664: "x64", 0xaa64: "arm64", 0x014c: "x86", 0x01c4: "arm" }

/** `x64`, `arm64`, `x86`, `arm`, `unknown:0x…` for another machine, `not-pe` for a file without a whole PE header. */
export function peMachine(file: string) {
  const fd = fs.openSync(file, "r")
  try {
    const dos = Buffer.alloc(0x40)
    if (fs.readSync(fd, dos, 0, 0x40, 0) < 0x40 || dos.toString("latin1", 0, 2) !== "MZ") return "not-pe"
    const nt = Buffer.alloc(24)
    if (fs.readSync(fd, nt, 0, 24, dos.readUInt32LE(0x3c)) < 24 || nt.toString("latin1", 0, 4) !== "PE\0\0")
      return "not-pe"
    const machine = nt.readUInt16LE(4)
    return MACHINES[machine] ?? `unknown:0x${machine.toString(16)}`
  } finally {
    fs.closeSync(fd)
  }
}
