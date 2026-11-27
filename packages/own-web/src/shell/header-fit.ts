/**
 * The conversation header's give-way order (03 §4.4 머리줄 맞추기, MR7-17). The container queries in shell.css hide
 * what is least needed at fixed header widths; what is left gives way by the room it has, measured like
 * composer/limit-fit.ts. First the title shrinks to its floor, then the model in `모델 @ 계정` (switcher.css); after
 * that each step is kept only when the one before does not fit:
 *   1. `cache`: the running-on pill's cache text goes, as under 1100 px (the switcher and the 이 대화 card have it);
 *   2. `computer`: the computer-use chip folds to its icon and its `멈추기` to a mark (their names and tooltips keep
 *      the state and what they do);
 *   3. `team`: the team pill drops its first words (`팀 메인 · 영역 3개` → `영역 3개`, `영역: cl-perf · 담당` →
 *      `cl-perf · 담당`), the whole text kept in its name and tooltip;
 *   4. `approval`: the approval pill keeps its mark, as a header under 820 px always does;
 *   5. `harness`: the 에이전트 방식 pill keeps its icon (its name and tooltip say which; the conversation ⋯ opens its
 *      menu too);
 *   6. `git`: the Git chip goes, as under 640 px (the work panel's review tab has it);
 *   7. `title`: the title's floor drops from 7.5rem (9rem from a 1000 px header) to 5rem, as under 640 px;
 *   8. `title-min`: the title's floor drops to 3em, two Korean characters and the ellipsis (`장바…`);
 *   9. `stop`: the chip's Stop mark goes last, being the kill switch (the chip's dialog, 설정 > 컴퓨터 사용 and
 *      Ctrl+Alt+Shift+Q still stop it): only where nothing else is left to give, and only when that makes the account
 *      whole. Where even this step does not fit (a long user-renamed account), the kill switch stays and the account
 *      takes the ellipsis, its whole name in the pill's name and tooltip.
 * A team main with computer use on (its Git chip, its team pill) needs up to step 6 at 1366–1440 px with the sidebar
 * and the work panel open, where the cache text is already hidden, and with a long title up to step 7 or 8; with the
 * panel closed a computer-use chip at work (`PC 조작 중 · notepad`) beside a warm cache's text needs step 1.
 * A step fits when the account is whole (up to its own cap), the running-on pill is not clipped and nothing runs past
 * the header. Only a conversation's one-row header gives way: the new-conversation screen and the pages have few
 * items, and the phone's header has a second row. Each step is laid out and measured a frame after the header resized
 * or changed (composer/limit-fit.ts `watchFit`); the give-way attribute itself is not watched. After the fit, a title
 * or a `모델 @ 계정` that is still shortened gets its whole text as its tooltip (attributes are not watched either).
 */
import { cut, watchFit } from "@/composer/limit-fit"

export const GIVE_WAY = [
  "",
  "cache",
  "cache computer",
  "cache computer team",
  "cache computer team approval",
  "cache computer team approval harness",
  "cache computer team approval harness git",
  "cache computer team approval harness git title",
  "cache computer team approval harness git title title-min",
  "cache computer team approval harness git title title-min stop",
]

export function watchHeaderFit(header: HTMLElement) {
  const apply = (give: string) => {
    if (give) header.dataset.give = give
    else delete header.dataset.give
  }
  return watchFit(header, () => {
    const oneRow = header.dataset.route === "session" && getComputedStyle(header).flexWrap === "nowrap"
    apply(oneRow ? giveWay((give) => (apply(give), fits(header, give.endsWith("stop")))) : "")
    const title = header.querySelector<HTMLElement>('[data-testid="header-title"]')
    // `innerText`: a breadcrumb's crumbs are flex items, so its `›` comes out apart from the names beside it.
    if (title) tip(title, shortened(title) || crumbCut(title), title.innerText.replace(/\s+/g, " ").trim())
    const label = header.querySelector<HTMLElement>('.own-sw-pill [data-testid="running-on"]')
    if (label) {
      // A pill without an account is a warning, its tooltip on the button.
      const parts = [...label.querySelectorAll<HTMLElement>("[data-part]")]
      const account = parts.some((part) => part.dataset.part === "account")
      tip(label, account && parts.some(shortened), label.textContent ?? "")
    }
  })
}

/**
 * The first step that fits. Where none does, every step but the Stop mark's: dropping the kill switch is worth it
 * only when that makes the account whole, so a long custom account name shortens beside it instead.
 */
export function giveWay(fits: (give: string) => boolean) {
  return GIVE_WAY.find(fits) ?? GIVE_WAY.at(-2)!
}

/**
 * The account in `모델 @ 계정` is whole, the pill not clipped, and nothing runs past the header. For the Stop mark's step
 * (`strict`) whole means all of its text is shown: an account at its 14em cap still has an ellipsis, and the kill
 * switch is not traded for a name that stays cut.
 */
function fits(header: HTMLElement, strict = false) {
  if (header.scrollWidth > header.clientWidth) return false
  const pill = header.querySelector<HTMLElement>(".own-sw-pill")
  if (!pill) return true
  const account = pill.querySelector<HTMLElement>('[data-part="account"]')
  if (pill.scrollWidth > pill.clientWidth) return false
  if (!account) return true
  return strict ? !shortened(account) : !cut(account)
}

/** A breadcrumb's parent crumb can take the ellipsis while the h1 as a whole still fits its box. */
function crumbCut(title: HTMLElement) {
  return [...title.querySelectorAll<HTMLElement>(".own-sa-crumb")].some(shortened)
}

/** Its text is wider than its box: an ellipsis, a capped account included (`cut` leaves that one out). */
function shortened(node: HTMLElement) {
  const text = document.createRange()
  text.selectNodeContents(node)
  return text.getBoundingClientRect().width > node.getBoundingClientRect().width + 0.01
}

function tip(node: HTMLElement, show: boolean, text: string) {
  if (show) node.title = text
  else node.removeAttribute("title")
}
