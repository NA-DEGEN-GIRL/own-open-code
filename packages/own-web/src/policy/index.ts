// Web-mode browser tool policy (01 §10.1, 05 §8.7 plan D, 01 §17.1 #5; owner: workspace).
// The server popover's line (`@/policy/panel`) is not exported here: the first chunk imports this index, and that
// module's words must stay out of it (PF5).
export {
  BROWSER_DENY,
  browserCreationRules,
  browserDisconnectedHint,
  browserPaneHeld,
  browserRemoved,
  browserToolState,
  isBrowserDisconnected,
  withBrowserPolicy,
  type BrowserHost,
  type BrowserToolState,
} from "./browser"
export {
  BrowserToolNotice,
  browserNoticeKey,
  enableReasonKey,
  startedWithoutDetail,
  useSessionBrowserTool,
} from "./notice"
export { policyEn, policyKo, policyText, usePolicyText, type PolicyKey } from "./strings"
