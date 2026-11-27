// English text of the demo world (OWN_MANUAL_LANG=en): the README's English screenshots (own/scripts/readme/capture.ts).
// Only what those pictures show is here; everything else in the demo world stays Korean, as the manual has it.
import type { Script } from "./backend"

/** A script's English prompt key, answer and steps, by its Korean key. */
export const ENGLISH: Readonly<Record<string, Pick<Script, "key" | "answer"> & Partial<Script>>> = {
  "<worktree-chat": {
    key: "<worktree-chat",
    answer: "`Grid spawn` is done. Look at the change and tell me whether to merge it. `Wave spawn` is still working.",
  },
  "두 가지 방법을 각각": {
    key: "both ways",
    steps: `[tool worktree.start ${JSON.stringify({
      tasks: [
        { name: "spawn-grid", title: "Grid spawn", task: "Let enemies appear on empty grid cells" },
        { name: "spawn-waves", title: "Wave spawn", task: "Let enemies appear wave by wave" },
      ],
    })}]`,
    answer: "I started two conversations, each in its own worktree. I will compare them here when they are done.",
  },
  "빈 격자 칸에서": { key: "on empty grid cells", answer: "Enemies now only appear on cells that are not walls." },
  "물결 단위로": { key: "wave by wave", answer: "Enemies now come in three waves." },
  "A* 말고 다른 방법": {
    key: "instead of A*",
    answer: [
      "On a small map plain **BFS (breadth-first search)** is enough.",
      "",
      "- Every cell costs the same, so the result equals A*.",
      "- With many enemies a **flow field** spread once from the player is faster.",
    ].join("\n"),
  },
  "벽에 자꾸 부딪혀요": {
    key: "keep bumping into walls",
    answer: [
      "The enemies now walk around walls.",
      "",
      "- `src/enemy-ai.ts`: they used to step straight ahead, now they use **A\\* pathfinding**.",
      "- `wall` cells are never entered, and diagonal steps are off.",
      "",
      "Start the game again and check that enemies no longer stop in corners.",
    ].join("\n"),
  },
  "고친 부분을 짧게": {
    key: "in a few words",
    answer: [
      "Three things changed.",
      "",
      "1. Each turn an enemy works out the **shortest path** to the player again.",
      "2. It only takes the first step of that path, so it no longer walks on the spot.",
      "3. With no path at all (fully blocked) it waits where it is.",
      "",
      "```ts",
      "const path = grid.findPath(from, to, { avoid: 'wall' })",
      "```",
    ].join("\n"),
  },
  "맵 데이터를 정리": {
    key: "Clean up the map data",
    answer: "I merged three of the 40 maps that were mostly empty and folded repeated tile runs into one.",
  },
  "이 로그를 요약해 줘": {
    key: "Summarize this log",
    answer: [
      "I went through all 6,000 lines.",
      "",
      "- Every request ended with `status=ok`; nothing was retried.",
      "- Latency is spread evenly between 0 and 900 ms, with no outliers.",
      "- `worker=3` and `worker=5` were slightly busier.",
      "",
      "Nothing needs fixing right now.",
    ].join("\n"),
  },
  "레벨 에디터에서 타일": {
    key: "erasing a tile in the level editor",
    answer: [
      "Erasing a tile **pushed the same cell onto the undo history twice**.",
      "",
      "`eraseTile` in `src/game.ts` records once more after erasing. Recording it once fixes it.",
    ].join("\n"),
  },
  "HUD를 더 보기 좋게": {
    key: "make the HUD easier to read",
    answer: [
      "I would change the HUD like this.",
      "",
      "- Move the health bar to the top left and make its text a little larger.",
      "- Put the score at the top right, with the enemies left below it.",
      "- Give the text a thin outline so it stays readable on dark backgrounds.",
    ].join("\n"),
  },
  "효과음 파일 이름": {
    key: "sound effect file names",
    answer: "I will name the files `sfx-<action>.ogg` and keep every volume in one settings file.",
  },
  "시작 메뉴 문구": {
    key: "start menu wording",
    answer: "The start menu now has four short entries: `Start`, `Continue`, `Settings` and `Quit`.",
  },
  "결제 웹훅이 실패": {
    key: "payment webhook fails",
    answer: [
      "A failed payment webhook is now sent again after **1, 5 and 30 minutes**.",
      "",
      "After three failures it leaves an admin notice and stops. The event ID keeps an event from being handled twice.",
    ].join("\n"),
  },
  "바뀐 파일을 확인": {
    key: "which files changed",
    answer: "Only `src/enemy-ai.ts` changed. It is not committed yet.",
  },
  "적 스폰 위치": {
    key: "enemy spawn points",
    answer: "Enemies will only spawn on empty cells, so none starts inside a wall.",
  },
  "세 영역에 일을 나눠": {
    key: "Split this between the three areas",
    steps:
      "[dispatch ui Make the HUD text larger and move the health bar to the top left] [dispatch core Tidy up the enemy movement rules and report ready when done] [dispatch net Raise the lobby limit to 6 players]",
    answer: "Handed out: Interface takes the HUD, Game logic the movement rules, and Network the lobby.",
  },
  "체력 막대를 왼쪽 위로 옮겨 주세요": {
    key: "move the health bar to the top left",
    answer: "The HUD text is larger and the health bar is at the top left.",
  },
  "끝나면 반영 준비를 알려 주세요": {
    key: "report ready when done",
    steps:
      '[write src/rules.ts export const enemySpeed = 2\nexport const enemyAvoidsWalls = true\n] [shell git add -A && git commit -q -m "Tidy up the enemy movement rules"] [report ready The enemy movement rules are in src/rules.ts now]',
    answer: "The movement rules are in `src/rules.ts` now, and I reported ready.",
  },
  "로비 최대 인원을 6명으로": {
    key: "Raise the lobby limit to 6 players",
    answer: "The lobby takes up to 6 players now.",
  },
  "점수판 페이지를 열고": {
    key: "Open the scoreboard page",
    answer: "I opened the scoreboard and pressed New game. The game has started.",
  },
}

/** The demo world's other texts, by their Korean. */
export const WORDS: Readonly<Record<string, string>> = {
  // Conversation titles and prompts.
  "적 AI 길찾기 고치기": "Fix enemy pathfinding",
  "적 AI가 벽에 자꾸 부딪혀요. 길찾기를 고쳐 줄래요?": "The enemies keep bumping into walls. Can you fix their pathfinding?",
  "고친 부분을 짧게 설명해 줘": "Explain what you changed in a few words",
  "새 대화": "New conversation",
  "긴 로그 분석": "Long log analysis",
  "이 로그를 요약해 줘.": "Summarize this log.",
  "맵 데이터 정리": "Map data cleanup",
  "맵 데이터를 정리해 줘.": "Clean up the map data.",
  "레벨 에디터 버그": "Level editor bug",
  "레벨 에디터에서 타일을 지우면 실행 취소가 두 번 필요해요. 원인을 찾아 줘":
    "After erasing a tile in the level editor I have to undo twice. Find out why",
  "HUD 다듬기": "HUD polish",
  "HUD를 더 보기 좋게 다듬을 방법을 알려 줘": "How would you make the HUD easier to read?",
  "메뉴 문구 다듬기": "Menu wording",
  "시작 메뉴 문구를 짧게 다듬어 줘": "Shorten the start menu wording",
  "효과음 정리": "Sound effects",
  "효과음 파일 이름을 정리해 줘": "Tidy up the sound effect file names",
  "결제 웹훅 재시도": "Payment webhook retries",
  "결제 웹훅이 실패하면 다시 보내도록 고쳐 줘": "When the payment webhook fails, send it again",
  "스프라이트 내보내기": "Sprite export",
  "새 작업": "New task",
  "가게 정리": "Shop cleanup",
  "장바구니 속도": "Cart speed",
  "검색 정확도": "Search accuracy",
  "실험 아이디어": "Experiments",
  // Accounts and presets.
  "회사 Plus": "Work Plus",
  "개인 백업": "Personal backup",
  "가족 공유": "Side project",
  "회사 Max": "Work Max",
  "개인 Pro": "Personal Pro",
  "Claude 구독": "Claude subscription",
  "로컬 모델": "Local model",
  "가볍게 나눠 쓰기": "Light split",
  "리뷰는 Claude로": "Review with Claude",
  "DeepSeek 기본": "DeepSeek default",
  // The team's areas.
  화면: "Interface",
  "HUD와 메뉴 다듬기": "HUD and menu polish",
  "게임 로직": "Game logic",
  "적 AI와 규칙 정리": "Enemy AI and rules",
  네트워크: "Network",
  "로비와 매칭 안정화": "Lobby and matchmaking",
  "그림과 소리 파일(큰 파일)": "Pictures and sounds (large files)",
  "영역 3개를 만들어요.": "Creates 3 areas.",
  // Files.
  "// 적이 벽을 피해 플레이어에게 가는 가장 짧은 길(A* 탐색)": "// The shortest way to the player around the walls (A* search)",
  "// 적이 플레이어 쪽으로 한 칸씩 직진한다": "// The enemy steps straight towards the player",
  // The scoreboard page the browser pane opens.
  "우주 게임 점수판": "Space game scoreboard",
  순위: "Rank",
  이름: "Name",
  점수: "Score",
  별빛: "Starlight",
  혜성: "Comet",
  은하: "Galaxy",
  "게임 준비 중…": "Getting ready…",
  "게임 시작!": "Game on!",
  "새 게임": "New game",
  "점수 내려받기": "Download scores",
  "의 휴대폰": " phone",
}
