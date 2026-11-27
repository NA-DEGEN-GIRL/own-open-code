// The e2e's shared boot limit, in a file that imports nothing: release.e2e.test.ts and integrate.e2e.test.ts load the
// harness lazily (on the real host only their git procedure runs, without node_modules) but give their beforeAll the
// same limit, and test/real-host/run.sh copies this file with them.

/**
 * A boot and an enable (beforeAll): 33-46 s and 47-175 s alone on a loaded PC (2026-10-29); three files booting at
 * once (`--parallel=3`) passed 240 s. Only a hung boot waits this long.
 */
export const BOOT_TIMEOUT = 480_000
