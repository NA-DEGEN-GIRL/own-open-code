// Chat view (03 §4.5 "대화 보기"). First-chunk exports: the toggle store and the header menu. The settings page imports
// its section from `@/chat-view/setting`; the transcript chunk applies the toggles (transcript/view-filter.ts).
export { ChatViewMenu } from "./menu"
export {
  CHAT_META,
  CHAT_VIEW_KEY,
  OPT_IN,
  chatView,
  chatViewState,
  isChatOnly,
  isDefault,
  parseChatView,
  resetChatView,
  setChatMeta,
  toggleChatOnly,
  toggledChatOnly,
  viewOf,
  withMeta,
  type ChatMeta,
  type ChatView,
  type ChatViewState,
} from "./state"
