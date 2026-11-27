// Attachment strings (03 §18.10). 03 §14 keys (`own.attach.tooLarge`, `imageCost`, `uploading`, `noImageModel`) come
// from the shared catalog; these are the rest, `own.attachments.*`, ready to move into ko.ts/en.ts ("attachments").
import { featureText } from "@/queue/text"

export const attachmentsKo = {
  "own.attachments.add": "파일 첨부",
  "own.attachments.addHint": "파일 첨부 ({keys})",
  "own.attachments.remove": "{name} 첨부 빼기",
  "own.attachments.preview": "{name} 미리보기",
  "own.attachments.close": "닫기",
  "own.attachments.drop": "여기에 놓으면 첨부해요",
  "own.attachments.failed": "{name}(을)를 올리지 못했어요",
  "own.attachments.readFailed": "{name}(을)를 읽지 못했어요",
  "own.attachments.duplicate": "이미 첨부한 파일이에요",
  "own.attachments.waiting": "첨부를 올리는 중이에요. 끝나면 보낼 수 있어요",
  "own.attachments.list": "첨부 {n}개",
  "own.attachments.path": "경로",
  "own.attachments.kind.image": "이미지",
  "own.attachments.kind.pdf": "PDF",
  "own.attachments.kind.text": "텍스트",
  "own.attachments.kind.file": "파일",
  "own.attachments.route.inline": "대화에 함께 보냄",
  "own.attachments.route.path": "이 PC의 파일 경로로 보냄",
  "own.attachments.route.upload": "서버 임시 폴더에 올려 경로로 보냄",
  "own.attachments.cancelUpload": "올리기 취소",
} as const satisfies Record<string, string>

export type AttachmentsKey = keyof typeof attachmentsKo

export const attachmentsEn: Partial<Record<AttachmentsKey, string>> = {
  "own.attachments.add": "Attach files",
  "own.attachments.addHint": "Attach files ({keys})",
  "own.attachments.remove": "Remove {name}",
  "own.attachments.preview": "Preview {name}",
  "own.attachments.close": "Close",
  "own.attachments.drop": "Drop to attach",
  "own.attachments.failed": "Could not upload {name}",
  "own.attachments.readFailed": "Could not read {name}",
  "own.attachments.duplicate": "Already attached",
  "own.attachments.waiting": "Attachments are still uploading. You can send when they finish",
  "own.attachments.list": "{n} attachments",
  "own.attachments.path": "Path",
  "own.attachments.kind.image": "Image",
  "own.attachments.kind.pdf": "PDF",
  "own.attachments.kind.text": "Text",
  "own.attachments.kind.file": "File",
  "own.attachments.route.inline": "Sent with the message",
  "own.attachments.route.path": "Sent as this PC's file path",
  "own.attachments.route.upload": "Uploaded to the server's temp folder, sent as a path",
  "own.attachments.cancelUpload": "Cancel upload",
}

export const attachmentsText = featureText(attachmentsKo, attachmentsEn)
export const useAttachmentsText = attachmentsText.use
