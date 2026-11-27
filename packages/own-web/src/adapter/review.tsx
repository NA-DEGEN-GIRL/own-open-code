// The review tab's session-ui composition (03 §18.5, 4.7 `리뷰`): the work panel's lazy loader for the tab
// (`shell/work-panel.tsx` LOADERS.review). Only src/adapter may import @opencode/session-ui (03 §16.1), so the review
// module takes the session-ui components as arguments and this file supplies them. Same content as
// e2e/review/kit.tsx, which the review e2e harness mounts.
import { File } from "@opencode/session-ui/file"
import { SessionReviewEmptyChangesV2 } from "@opencode/session-ui/v2/session-review-empty-changes-v2"
import { SessionReviewFilePreviewV2 } from "@opencode/session-ui/v2/session-review-file-preview-v2"
import { SessionReviewV2 } from "@opencode/session-ui/v2/session-review-v2"
import { createReviewTab } from "@/review/panel"

export default createReviewTab({
  Frame: SessionReviewV2,
  Preview: SessionReviewFilePreviewV2,
  EmptyChanges: SessionReviewEmptyChangesV2,
  File,
})
