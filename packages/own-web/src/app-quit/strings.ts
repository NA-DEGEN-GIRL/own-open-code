// Strings of 앱 종료 / 완전 종료 and the window's X (05 §7.3, 03 §5.7 설정 > 데스크톱 앱). Kept next to the module; the
// keys can move verbatim into src/i18n/ko.ts / en.ts (section "app-quit"). The tray menu and 완전 종료's dialog are the
// shell's own (own-desktop quit-model.ts). The settings rows' own strings are lazy with the settings screen
// (settings-strings.ts, PF5).
import { featureText } from "@/queue/text"

export const appQuitKo = {
  "own.quit.app": "앱 종료",
  "own.quit.app.hint": "앱만 꺼요. 서비스는 계속 돌아서 실행 중인 대화와 휴대폰·다른 PC 연결은 그대로예요.",
  "own.quit.all": "완전 종료…",
  "own.quit.app.detail": "서비스는 계속 실행",
  "own.quit.all.detail": "이 PC의 서비스도 끔",
  "own.quit.all.hint": "앱과 이 PC의 서비스를 함께 꺼요. 무엇이 멈추는지 먼저 물어봐요.",
} as const satisfies Record<string, string>

export type AppQuitKey = keyof typeof appQuitKo

export const appQuitEn: Partial<Record<AppQuitKey, string>> = {
  "own.quit.app": "Quit app",
  "own.quit.app.hint":
    "Closes the app only. The service keeps running, so running conversations and phone or other-PC connections stay.",
  "own.quit.all": "Quit completely…",
  "own.quit.app.detail": "the service keeps running",
  "own.quit.all.detail": "stops this PC's service too",
  "own.quit.all.hint": "Closes the app and this PC's service. Asks first what stops.",
}

export const appQuitText = featureText(appQuitKo, appQuitEn)
export const useAppQuitText = appQuitText.use
