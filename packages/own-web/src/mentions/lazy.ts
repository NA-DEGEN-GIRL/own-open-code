// Lazy chunk of the composer suggestions: providers (mentions + commands), the engine and the list UI. Loaded on the
// first `@` or `/` (and prefetched when idle), so the first bundle carries only the controller (03 §20.2 R5, PF5).
import type { Accessor } from "solid-js"
import type { CommandActions } from "@/commands/actions"
import { createCommandProviders } from "@/commands/providers"
import { commandText } from "@/commands/strings"
import type { Locale } from "@/i18n"
import { createSuggestEngine } from "./engine"
import { createMentionProviders } from "./providers"
import { mentionText } from "./strings"
import type { SuggestContext, SuggestProvider, Trigger } from "./types"

export { SuggestList } from "./popover"

export function createComposerEngine(input: {
  readonly locale: Accessor<Locale>
  readonly actions: CommandActions
  readonly providers?: readonly SuggestProvider[]
  readonly context: Accessor<SuggestContext | undefined>
  readonly trigger: Accessor<Trigger | undefined>
  readonly composing: Accessor<boolean>
}) {
  const providers = [
    ...createCommandProviders({
      text: (key, params) => commandText(input.locale(), key, params),
      actions: input.actions,
      locale: input.locale,
    }),
    ...createMentionProviders((key, params) => mentionText(input.locale(), key, params)),
    ...(input.providers ?? []),
  ]
  return createSuggestEngine({
    providers: () => providers,
    context: input.context,
    trigger: input.trigger,
    composing: input.composing,
  })
}
