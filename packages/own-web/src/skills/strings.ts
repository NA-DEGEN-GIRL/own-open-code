// Skills strings (03 §19.6, the import view 03 §19.6.1), `own.skills.*`, ready to move into ko.ts/en.ts (section
// "skills"). The `@` group name and chip kind stay with src/mentions (`own.mention.group.skills`,
// `own.mention.kind.skill`).
import { featureText } from "@/history/text"

export const skillsKo = {
  "own.skills.title": "스킬",
  "own.skills.open": "스킬 목록",
  "own.skills.search": "스킬 검색",
  "own.skills.loading": "스킬을 불러오는 중…",
  "own.skills.failed": "스킬 목록을 가져오지 못했어요",
  "own.skills.retry": "다시 시도",
  "own.skills.empty": "이 폴더에서 쓸 수 있는 스킬이 없어요",
  "own.skills.noMatch": "일치하는 스킬이 없어요",
  "own.skills.more": "검색어로 좁히면 나머지 {n}개도 보여요",
  "own.skills.source.project": "프로젝트",
  "own.skills.source.global": "전역",
  "own.skills.source.builtin": "기본 제공",
  "own.skills.auto": "스스로 불러옴",
  "own.skills.autoHint": "에이전트가 필요할 때 스스로 불러올 수 있어요",
  "own.skills.addChip": "칩으로 추가",
  "own.skills.run": "바로 실행",
  "own.skills.chipHint": "칩은 다음 메시지와 함께 가요.",
  "own.skills.runHint": "바로 실행은 스킬 내용을 대화 끝에 더하고 에이전트를 시작해요. 앞부분 캐시는 그대로예요.",
  "own.skills.busy": "실행 중에는 칩으로 추가하세요",
  "own.skills.noSession": "대화를 연 뒤에 바로 실행할 수 있어요",
  "own.skills.keys": "Enter 칩으로 추가 · Ctrl+Enter 바로 실행 · Esc 닫기",
  "own.skills.added": "스킬 칩을 넣었어요: {name}",
  "own.skills.started": "스킬을 불러왔어요: {name}",
  "own.skills.runFailed": "스킬을 실행하지 못했어요: {name}",
  "own.skills.tab.list": "목록",
  "own.skills.tab.import": "가져오기",
} as const satisfies Record<string, string>

export type SkillsKey = keyof typeof skillsKo

export const skillsEn: Partial<Record<SkillsKey, string>> = {
  "own.skills.title": "Skills",
  "own.skills.open": "Skills",
  "own.skills.search": "Search skills",
  "own.skills.loading": "Loading skills…",
  "own.skills.failed": "Could not load the skills",
  "own.skills.retry": "Retry",
  "own.skills.empty": "No skills are available in this folder",
  "own.skills.noMatch": "No matching skills",
  "own.skills.more": "Narrow the search to see {n} more",
  "own.skills.source.project": "Project",
  "own.skills.source.global": "Global",
  "own.skills.source.builtin": "Built in",
  "own.skills.auto": "Loads itself",
  "own.skills.autoHint": "The agent may load it by itself when needed",
  "own.skills.addChip": "Add as chip",
  "own.skills.run": "Run now",
  "own.skills.chipHint": "A chip goes with your next message.",
  "own.skills.runHint":
    "Run now appends the skill to the end of the conversation and starts the agent. The cached prefix is kept.",
  "own.skills.busy": "While the session runs, add it as a chip",
  "own.skills.noSession": "Open a session to run a skill now",
  "own.skills.keys": "Enter add as chip · Ctrl+Enter run now · Esc close",
  "own.skills.added": "Skill chip added: {name}",
  "own.skills.started": "Skill loaded: {name}",
  "own.skills.runFailed": "Could not run the skill: {name}",
  "own.skills.tab.list": "List",
  "own.skills.tab.import": "Import",
}

const catalog = featureText(skillsKo, skillsEn)
export const skillsText = catalog.text
export const useSkillsText = catalog.use
