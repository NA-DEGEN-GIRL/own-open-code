// Files module (03 §19.4 파일 트리·파일 탭·빠른 열기·뷰어, §19.5 에디터에서 열기·탐색기에서 보기). First-chunk-safe
// exports only (the intents: a few hundred bytes, no side effects beyond two signals). The tab itself is the lazy chunk
// `src/adapter/files.tsx` → `./panel` (session-ui + pierre), never imported from here. Lazy modules that need more
// import by path: `@/files/actions` (`createFileActions`: 에디터에서 열기 / 탐색기에서 보기 for the review header),
// `@/files/editor` (`editorPreference` for 설정 > 데스크톱), `@/files/strings`.
export {
  FILE_INTENT,
  openFile,
  pendingFile,
  QUICK_OPEN_INTENT,
  quickOpenRequests,
  requestQuickOpen,
  type OpenFileRequest,
  type QuickOpenRequest,
} from "./intents"
