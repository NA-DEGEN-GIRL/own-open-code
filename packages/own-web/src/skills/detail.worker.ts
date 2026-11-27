// `상세 보기`'s markdown parse (SK2, 2026-10-25; 03 §19.6.1), off the main thread: a skill's SKILL.md is another tool's
// or a repository's text, and marked's lexer can take seconds (`*a ` × 6,000 held Edge for 8 s) or overflow the stack
// (`> ` × 5,000) on hostile input. The page asks once per body, waits a few seconds and ends the worker otherwise
// (./detail-render, counted from the `ready` message). Text in, HTML out: nothing here touches the DOM, the API or the network.
import { createMarkdownBase } from "@opencode/ui/context/marked-base"

export type SkillParseRequest = { readonly id: number; readonly markdown: string }
export type SkillParseResponse =
  | { readonly id: number; readonly html: string }
  | { readonly id: number; readonly error: string }

const parser = createMarkdownBase()
// The page counts the parse's time from here: loading this chunk is not part of it.
self.postMessage({ ready: true })

self.onmessage = (event: MessageEvent<SkillParseRequest>) => {
  const request = event.data
  // A stack overflow in marked's recursion is an answer here (the page shows the text as it is), not a crash.
  try {
    self.postMessage({
      id: request.id,
      html: parser.parse(request.markdown, { async: false }),
    } satisfies SkillParseResponse)
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.name : "error",
    } satisfies SkillParseResponse)
  }
}
