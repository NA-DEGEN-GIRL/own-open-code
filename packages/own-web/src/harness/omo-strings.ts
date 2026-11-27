// omo (원본)'s words (own/docs/15): its line in the 에이전트 방식 menu and Settings > 일반, and its note on the
// 설정 > 에이전트 방식 page. A service offers omo only while own-omo runs there, so these load lazily when one does
// (index.tsx, default-setting.tsx) and stay out of the first chunk (PF5). Its name is an src/i18n key.
import { featureText } from "@/queue/text"

export const omoKo = {
  "own.omo.desc":
    "oh-my-opencode(omo) 코드를 그대로 가져와 돌려요. Sisyphus가 계획하고 하위 에이전트에게 맡기며, 할 일이 남으면 이어서 해요. 메시지에 ulw를 넣으면 더 꼼꼼하게 해요.",
  "own.omo.page":
    "omo는 SUL-1.0 라이선스예요. 이 앱은 개인 용도로만 쓰고, 고친 곳은 MODIFICATIONS.md에 적어 두었어요. 지시문은 omo가 요청마다 만들어서 미리 보기가 없어요.",
  "own.omo.subagent":
    "omo는 task 도구로 맡겨요. 돌아오는 글은 omo가 만들어요(걸린 시간, 에이전트, 하위 에이전트의 답, 이어서 맡길 때 쓸 task_id). 이 앱은 아무것도 더하지 않아요.",
}

export type OmoKey = keyof typeof omoKo

export const omoEn: Partial<Record<OmoKey, string>> = {
  "own.omo.desc":
    "Runs oh-my-opencode (omo) as it is: Sisyphus plans, hands work to subagents and keeps going while todos remain. Add ulw to a message for extra care.",
  "own.omo.page":
    "omo is licensed under SUL-1.0. This app uses it for personal use only and lists its changes in MODIFICATIONS.md. omo builds its instructions per request, so there is no preview.",
  "own.omo.subagent":
    "omo hands work off with its task tool. omo writes what comes back (the time taken, the agent, the subagent's answer and the task_id to continue with). This app adds nothing.",
}

export const omoText = featureText(omoKo, omoEn)
