// Git module (03 §19.2 Git actions, §19.15 branch/status chip). First-chunk-safe exports only: the chip. The Git
// actions (commands, runner, confirmation dock) belong to the review tab's lazy chunk (src/review/panel.tsx imports
// `./actions` and `./state` directly), never to this entry.
export { GitStatusChip } from "./chip"
export { gitEn, gitKo, gitText, type GitKey } from "./strings"
export { gitRequest, requestGitAction, takeGitRequest, type GitRequest, type GitRequestAction } from "./request"
