// Ports packages/coding-agent/src/core/tools/write.ts: Pi's `write` tool, which creates or overwrites a file and its
// parent directories and answers `Successfully wrote to <path>` with the path as the model wrote it.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiWrite from "./write.js"

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PiArgs } from "./args.js"

export const NAME = "write"

export const DESCRIPTION =
  "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories."

export const SCHEMA: PiArgs.ObjectSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to write (relative or absolute)" },
    content: { type: "string", description: "Content to write to the file" },
  },
  required: ["path", "content"],
}

export interface Input {
  readonly path: string
  readonly content: string
}

export async function execute(input: Input, absolute: string) {
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, input.content, "utf-8")
  return `Successfully wrote to ${input.path}`
}
