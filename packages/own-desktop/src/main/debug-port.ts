// The packaged shell's remote-debugging port for test runs (own-shell.ts configureOwnApplication): since v2.4 upstream's
// configureApplication removes every remote-debugging switch from a packaged release build.

/** The `--remote-debugging-port=<n>` a test run passed, when it is a port number. */
export function debuggingPort(argv: readonly string[]) {
  const flag = "--remote-debugging-port="
  const value = argv.findLast((arg) => arg.startsWith(flag))?.slice(flag.length)
  if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65535) return undefined
  return String(Number(value))
}
