// Reference composition of the review tab = the content of src/adapter/review.tsx (wiring request: the integrator
// copies this file there, and `LOADERS.review` in shell/work-panel.tsx becomes `() => import("@/adapter/review")`).
// Only src/adapter may import @opencode/session-ui (03 §16.1); the e2e harness mounts this exact module.
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
