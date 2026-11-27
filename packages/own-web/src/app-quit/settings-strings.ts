// Strings of 설정 > 데스크톱 앱's `창을 닫으면` and `종료` rows (05 §7.3, 03 §5.7), lazy with the settings screen so they
// stay out of the first chunk (PF5). The quit buttons and the palette's quit commands keep theirs in strings.ts.
import { featureText } from "@/queue/text"

export const quitSettingsKo = {
  "own.quit.title": "종료",
  "own.quit.note":
    "앱 종료는 앱만 끄고, 완전 종료는 이 PC의 서비스도 꺼요. 트레이 아이콘을 오른쪽 클릭해도 같은 메뉴가 있어요.",
  "own.quit.close": "창을 닫으면",
  "own.quit.close.note":
    "트레이로 숨기면 앱은 작업 표시줄 오른쪽 알림 영역에서 계속 돌아요(안 보이면 ^를 누르세요). 아이콘을 누르면 창이 다시 열려요.",
  "own.quit.close.tray": "트레이로 숨기기",
  "own.quit.close.quit": "앱 종료",
} as const satisfies Record<string, string>

export type QuitSettingsKey = keyof typeof quitSettingsKo

export const quitSettingsEn: Partial<Record<QuitSettingsKey, string>> = {
  "own.quit.title": "Quit",
  "own.quit.note":
    "Quit app closes the app only; Quit completely also stops this PC's service. The tray icon's right-click menu has both.",
  "own.quit.close": "Closing the window",
  "own.quit.close.note":
    "Hidden in the tray, the app keeps running in the notification area at the right of the taskbar (behind ^ when hidden). Click the icon to open the window again.",
  "own.quit.close.tray": "Hide in the tray",
  "own.quit.close.quit": "Quit app",
}

export const quitSettingsText = featureText(quitSettingsKo, quitSettingsEn)
export const useQuitSettingsText = quitSettingsText.use
