// The live tasks (run.ts, claude/run.ts): each step's outcome is decided by the workspace's own tests.
export const TASKS = {
  merge:
    "In this repository, create `src/intervals.ts` exporting `merge(intervals: Array<[number, number]>): Array<[number, number]>` " +
    "that merges overlapping or touching closed intervals and returns them sorted, without mutating the input. " +
    "Reject an interval whose start is greater than its end with a RangeError. Add `test/intervals.test.ts` (bun:test) " +
    "covering empty input, unsorted input, nested and touching intervals, negative numbers and the error. Run `bun test` and make it pass.",
  subtract:
    "Add `subtract(a: Array<[number, number]>, b: Array<[number, number]>): Array<[number, number]>` to `src/intervals.ts`: " +
    "the parts of the union of `a` not covered by the union of `b`, as closed intervals where an endpoint shared with `b` is removed " +
    "only when it is covered (treat values as integers: [1,5] minus [2,3] is [[1,1],[4,5]]). Add tests to the existing test file and run `bun test`.",
  cli:
    "Add `src/cli.ts`: it reads a JSON array of intervals from stdin and prints the merged intervals as JSON on stdout, " +
    "exiting with code 1 and a message on stderr for invalid input. Add `test/cli.test.ts` that spawns it with Bun.spawn " +
    "for a valid and an invalid input. Run `bun test` and make everything pass.",
  ping: "Reply with the single word ok. Do not use tools.",
  search:
    "Search the web: what is the latest stable release of the Bun JavaScript runtime? " +
    "Answer with the version number and the URL of the page you read it on.",
  catalog:
    "Rename this session to `catalog check`, then tell me which models available here have `deepseek` in their name " +
    "(provider id and model id). Use your tools for both; do not guess.",
  delegate:
    "Use a sub-agent for part of this work (your agent or sub-agent tool). Have the sub-agent create `src/stats.ts` exporting " +
    "`mean(xs: number[]): number` and `median(xs: number[]): number`, both throwing a RangeError on empty input, with " +
    "`test/stats.test.ts` (bun:test). While it works, write `README.md` that describes the module in two sentences yourself. " +
    "When the sub-agent is done, run `bun test`, make sure everything passes, and reply with what the sub-agent did.",
  explore:
    "Use the explore sub-agent (the `subagent` tool with agent `explore`) to list the files of this folder, including those " +
    "under `src/` and `test/`, and to read `src/lib.ts`. Do not list or read any file yourself. Reply with the file names " +
    "and the first line of `src/lib.ts` exactly as the sub-agent reported them.",
  computer:
    "Use the computer tools on a test desktop (an in-memory fake: no real screen; its screenshots are a test pattern). " +
    "First take a screenshot, then list the windows with the computer tools' list_windows, then left-click the centre of " +
    "the Notepad window using the bounds list_windows gives in that screenshot's pixels, then type exactly " +
    "`hello from the live test`, then press ctrl+s. Do not use the shell or files. Reply with the Notepad window's title, " +
    "the screenshot's width and height, and one sentence on what the screenshot image looks like.",
  bugfix:
    "The test suite of this repository fails. Find and fix the bugs in `src/` so that `bun test` passes. " +
    "Do not change anything under `test/`. When you are done, reply with one line per bug you fixed.",
  todos:
    "Use your todo list for this work. Write three todos: (1) create `src/clamp.ts` exporting " +
    "`clamp(x: number, lo: number, hi: number): number` that throws a RangeError when lo > hi, (2) add `test/clamp.test.ts` " +
    "(bun:test) covering a value below, inside and above the range and the error, (3) run `bun test` and make it pass. " +
    "In this reply do only the first todo, mark it completed, leave the other two pending, and end your reply.",
  pitools:
    "Use your tools for three steps, one at a time. (1) Call the read tool with exactly these arguments: " +
    '{"path": ["notes.cfg"]} (an array on purpose, to see the tool\'s error), then read notes.cfg normally. ' +
    "(2) With the edit tool, change `status = draft` to `status = final` in notes.cfg; change nothing else. " +
    "(3) Run exactly this bash command with timeout 10: " +
    "`(end=$((SECONDS+20)); n=0; while [ $SECONDS -lt $end ]; do n=$((n+1)); [ $((n % 500)) -eq 0 ] && echo tick; done) & sleep 0.5; echo started; exit 3` " +
    "Then reply with the exact error text step 1 returned and the last sentence of step 3's result.",
  review:
    "Review `src` and `test` for bugs and missing edge cases (for example integer overflow is not a concern, but empty and single " +
    "intervals are). Fix what you find, keep the tests passing (`bun test`), and reply with a short summary of what you changed.",
} as const
