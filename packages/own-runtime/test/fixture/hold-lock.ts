// Takes a lease file lock in a separate process and holds it until killed. Prints "held" once it has the lock.
// Usage: bun hold-lock.ts <lock file> <ttl ms>

import { Lock } from "../../src/lock.js"

const file = process.argv[2] ?? ""
const ttlMs = Number(process.argv[3] ?? 60_000)
await Lock.acquire(file, { ttlMs })
process.stdout.write("held\n")
setInterval(() => undefined, 60_000)
