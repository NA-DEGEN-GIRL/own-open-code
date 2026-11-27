#!/usr/bin/env bun
// OWN-PATCH(P-014) begin
import { OPENCODE_VERSION } from "./version"

// The desktop launcher checks the binary before starting a service. A version query
// must not initialize command schemas, logging, config, or the updater first.
const args = process.argv.slice(2)
if (!process.env.OPENCODE_SSH_ASKPASS_PORT && args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  console.log(OPENCODE_VERSION)
  process.exit(0)
}
await import("./index")
// OWN-PATCH(P-014) end
