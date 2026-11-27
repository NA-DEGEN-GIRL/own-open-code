// What the layout audit (audit.ts) reports that is a design choice, not a defect: each entry names the elements
// (`Element.closest`), the kinds it allows and why. Keep the reason specific; an entry that no run matched any more
// is printed at the end of the run (ui-audit.spec.ts), so stale ones can go.
import type { Allowed } from "./audit"

export const ALLOWED: ReadonlyArray<Allowed> = [
  // Names and paths of any length, shortened where a row or a pill keeps one line; the full text is in the title or
  // one click away.
  {
    kinds: ["ellipsis"],
    selector:
      '[data-testid="session-row"] [data-testid="model-name"], [data-testid="team-extra"], [data-testid="area-line"], [data-testid="area-preset"]',
    reason:
      "a sidebar row's second line (a conversation's model, a team area's folder, model and preset) gives way in the column's width; the area menu's 자세히 shows it whole",
  },
  {
    kinds: ["ellipsis"],
    selector: '[data-testid="header-title"]',
    reason: "the header's title shortens first as the header narrows (03 §4.4 header fit)",
  },
  {
    kinds: ["ellipsis"],
    selector:
      '[data-testid="composer-switcher-label"] [data-part="model"], [data-testid="composer-preset"] .own-cp-tool-label',
    reason:
      "the composer's two long labels (the model of model @ account once its limit is down to the ring alone, the account staying whole, UX 2026-10-26/27; the preset's name) shrink so its toolbar stays one line (2026-10-10 review); the switcher and the preset menu show them whole",
  },
  {
    kinds: ["ellipsis"],
    selector: '.own-sw-pill [data-testid="running-on"] [data-part="model"]',
    reason:
      "the running-on pill's model gives way before its account (UX 2026-10-26, switcher/pill.tsx; the header fit keeps the account whole, UX-H); GPT-6-era names such as GPT-5.6 Sol need a few pixels more than GPT-5.5 did at 1440 and 375 px; the pill's tooltip and the switcher show it whole",
  },
  {
    kinds: ["ellipsis"],
    selector: '[data-testid="path-tail"]',
    reason:
      "the default conversation folder's path on the project and server selectors loses its start, never the folder itself; the tooltip has it whole",
  },
  {
    kinds: ["ellipsis"],
    selector: '[data-testid="project-select-item"] .truncate',
    reason: "a project's folder path under its name, shortened to the picker's width",
  },
  {
    kinds: ["ellipsis"],
    selector:
      '[data-testid="settings-import-root"], [data-testid="settings-shell"] .own-mono, [data-testid="shell-option"] .own-mono, [data-testid="trust-location"] .own-mono, [data-testid="settings-default-folder-path"], [data-testid="settings-picker-now"], [data-testid="skills-import-row"] .own-sk-imp-path, [data-testid="settings-skills-row"] .own-mono',
    reason:
      "folder and program paths in 설정 (다른 도구의 대화, 셸·터미널, 플러그인, 기본 대화 폴더, 폴더 열기 시작 위치, 스킬) end in an ellipsis on a narrow page; the 일반 rows' and the skills' title has the whole path",
  },
  // Descriptions written as two lines.
  {
    kinds: ["ellipsis"],
    selector: ".own-sk-desc",
    reason: "a skill's description is clamped to two lines in the skill list",
  },
  {
    kinds: ["wrap"],
    selector: ".own-rq-option-desc",
    reason: "the explanation under each 에이전트 방식 and 승인 모드 choice takes two lines",
  },
  {
    kinds: ["wrap"],
    selector: '[data-testid="composer-variant-ultra"] .own-cp-menu-note',
    reason:
      "the effort menu's 울트라 row says in a sentence under it what the switch does or why it is greyed (UC-6, UC-8); the sentence wraps within the menu's note width like the choices' explanations, and a greyed row's title repeats the reason",
  },
  {
    kinds: ["wrap"],
    selector: '[data-testid="server-panel-browser"]',
    reason: "the server panel's browser tool fact is a sentence in the facts' value column",
  },
  {
    kinds: ["wrap"],
    selector: ".own-sw-why",
    reason:
      "a switcher account's reason line (why it is greyed, what it may cost) is a sentence on a line of its own under the row; on a phone it takes two lines",
  },
  {
    kinds: ["wrap"],
    selector: '[data-testid="settings-image-moved"]',
    reason:
      "컴퓨터 사용 (실험)'s pointer to 이미지 만들기 is a sentence link under the page; on a phone it takes two lines",
  },
  // Text the page shows as written.
  {
    kinds: ["wrap"],
    selector: '[data-testid="skill-detail-markdown"]',
    reason:
      "상세 보기's body is the skill's own Markdown rendered as prose (SK2-8): a link or inline code in a paragraph wraps with the running text",
  },
]
