// 설정 > 출력 상한 (03 §5.7.4, 02 §4.9): the page's logic without the DOM. The service keeps `policy.outputLimit`;
// absent means the default, core's own limit (`이 값을 넘기지 않기` 256,000), and choosing the default stores nothing.
import type { Policy } from "@own/protocol"
import { OutputLimit } from "@own/protocol/output-limit"
import { grouped, parseTokens } from "@/limits/format"

/** The setting the page shows: the stored one, or the default. */
export function shown(policy: Pick<Policy.File, "outputLimit"> | undefined): OutputLimit.Setting {
  return OutputLimit.resolve(policy?.outputLimit)
}

export function isDefault(setting: OutputLimit.Setting) {
  return setting.mode === OutputLimit.DEFAULT.mode && setting.maxTokens === OutputLimit.DEFAULT.maxTokens
}

/** The number typed (`256,000`, `256000`, `256k`), or `undefined` when it is no whole number in range. */
export function parseLimit(text: string) {
  const value = parseTokens(text)
  if (value === undefined || value < OutputLimit.MIN_TOKENS || value > OutputLimit.MAX_TOKENS) return undefined
  return value
}

/** `policy.set` patch of a choice: the default clears the stored setting (`null`). */
export function patchOf(setting: OutputLimit.Setting): Pick<Policy.Patch, "outputLimit"> {
  return { outputLimit: isDefault(setting) ? null : setting }
}

/**
 * Whether the service stored what was sent: a service older than the setting drops the unknown patch field and
 * answers its policy without it, which would read as the default.
 */
export function stored(sent: Pick<Policy.Patch, "outputLimit">, policy: Pick<Policy.File, "outputLimit">) {
  if (sent.outputLimit === null || sent.outputLimit === undefined) return policy.outputLimit === undefined
  return (
    policy.outputLimit?.mode === sent.outputLimit.mode && policy.outputLimit.maxTokens === sent.outputLimit.maxTokens
  )
}

/** The numbers the help text names, grouped like the field. */
export const NUMBERS = {
  claude: grouped(OutputLimit.CLAUDE_DEFAULT),
  ds: grouped(OutputLimit.DS_THINKING_OFF),
  min: grouped(OutputLimit.MIN_TOKENS),
  max: grouped(OutputLimit.MAX_TOKENS),
  cap: grouped(OutputLimit.CORE_CAP),
}
