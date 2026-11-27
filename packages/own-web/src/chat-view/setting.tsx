// 설정 > 일반 > 대화 보기 (03 §5.7, §4.5): the header `보기` menu's choices as one settings block — a check box per kind
// of meta information, `대화만 보기` and `기본으로`. The settings page is a lazy chunk; this block is too.
import { For } from "solid-js"
import {
  CHAT_META,
  chatView,
  chatViewState,
  isChatOnly,
  isDefault,
  resetChatView,
  setChatMeta,
  toggleChatOnly,
} from "./state"
import { useChatViewText } from "./strings"

export function ChatViewSetting() {
  const text = useChatViewText()
  return (
    <section
      class="flex flex-col gap-2 border-b border-own-border py-3"
      aria-labelledby="settings-chat-view-title"
      data-testid="settings-chat-view"
    >
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div class="min-w-[220px] flex-1">
          <b id="settings-chat-view-title" class="block text-[13.5px] font-semibold">
            {text("own.chatView.title")}
          </b>
          <span class="text-[12px] text-own-muted">
            {text("own.chatView.note")} {text("own.chatView.scope")}
          </span>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            aria-pressed={isChatOnly(chatViewState())}
            data-testid="settings-chat-view-only"
            onClick={() => toggleChatOnly()}
          >
            {text(isChatOnly(chatViewState()) ? "own.chatView.chatOnlyOff" : "own.chatView.chatOnly")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            disabled={isDefault(chatViewState())}
            data-testid="settings-chat-view-reset"
            onClick={() => resetChatView()}
          >
            {text("own.chatView.reset")}
          </button>
        </div>
      </div>
      <div
        class="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2"
        role="group"
        aria-labelledby="settings-chat-view-title"
      >
        <For each={CHAT_META}>
          {(key) => (
            <label class="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                class="accent-[var(--own-accent)]"
                checked={chatView()[key]}
                data-testid={`settings-chat-view-${key}`}
                onChange={(event) => setChatMeta(key, event.currentTarget.checked)}
              />
              <span>{text(`own.chatView.meta.${key}`)}</span>
            </label>
          )}
        </For>
      </div>
    </section>
  )
}
