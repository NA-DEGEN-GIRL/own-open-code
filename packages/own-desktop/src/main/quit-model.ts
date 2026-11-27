// What the tray, the last window's X and the quit commands decide (05 §7.3), without Electron (test/tray-quit.test.ts).
// quit.ts does the Electron side. The shell's texts are Korean only, like its other dialogs (windows-own.ts).
import type { OwnCloseAction } from "../preload/own-api"
import { PRODUCT_NAME } from "../shared/identity"

/** A stored value as the close action; anything but `quit` is the default, 트레이로 숨기기. */
export function closeAction(value: unknown): OwnCloseAction {
  return value === "quit" ? "quit" : "tray"
}

/**
 * A window close (X, Alt+F4, WM_CLOSE): `hide` sends the last visible app window to the tray, everything else closes.
 * A close of an already hidden window is not the user's X (Windows Restart Manager, `taskkill` without /f), so it
 * closes, and with it the app. Remote PC and preview windows are not app windows (`main: false`) and always close.
 */
export function closeOutcome(input: {
  readonly action: OwnCloseAction
  readonly main: boolean
  readonly visible: boolean
  readonly otherVisibleMain: boolean
}): "hide" | "close" {
  if (input.action !== "tray" || !input.main || !input.visible) return "close"
  return input.otherVisibleMain ? "close" : "hide"
}

/**
 * Notification-area icon pixels for a display scale: 16 at 100 %, 20 at 125 %, 24 at 150 %, 28 at 175 %, 32 at 200 %.
 * Electron hands Windows the bitmap at its own size (NativeImage::GetHICON), so the image is made at exactly this size.
 */
export function trayIconSize(scaleFactor: number) {
  return Math.max(16, Math.round(16 * (Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1)))
}

/** The app icon file to scale down from (resources/icons): the smallest one at least `size` wide. */
export function trayIconSource(size: number) {
  if (size <= 32) return "32x32.png"
  if (size <= 64) return "64x64.png"
  return "icon.png"
}

/** Shown once, the first time the last window goes to the tray (a balloon, which Windows shows as a notification). */
export const TRAY_HINT =
  "창을 닫아도 트레이(작업 표시줄 오른쪽 알림 영역, 안 보이면 ^)에서 계속 돌아요. 끄려면 아이콘을 오른쪽 클릭해 완전 종료를 고르세요."

/** The icon's tooltip: the product, then the service state when it was read (`active` undefined: not counted). */
export function trayToolTip(state?: { readonly running: boolean; readonly active?: number }) {
  if (!state) return PRODUCT_NAME
  if (!state.running) return `${PRODUCT_NAME}\n서비스 꺼짐`
  if (state.active) return `${PRODUCT_NAME}\n서비스 실행 중 · 대화 ${state.active}개 진행 중`
  return `${PRODUCT_NAME}\n서비스 실행 중`
}

export type TrayAction = "open" | "quitApp" | "quitAll"

/** The icon's right-click menu. Windows menus show no secondary text, so the label carries 앱 종료's hint. */
export const TRAY_MENU: readonly (
  | { readonly label: string; readonly action: TrayAction }
  | { readonly separator: true }
)[] = [
  { label: "열기", action: "open" },
  { separator: true },
  { label: "앱 종료 (서비스는 계속 실행)", action: "quitApp" },
  { label: "완전 종료…", action: "quitAll" },
]

/** 원격 PC 전용 build (client-only.ts): no service here, so one plain quit. */
export const CLIENT_TRAY_MENU: typeof TRAY_MENU = [
  { label: "열기", action: "open" },
  { separator: true },
  { label: "종료", action: "quitApp" },
]

export type QuitChoice = "all" | "app" | "cancel"

export interface QuitPrompt {
  readonly type: "warning" | "info" | "error"
  readonly message: string
  readonly detail: string
  readonly buttons: readonly string[]
  /** One per button. */
  readonly choices: readonly QuitChoice[]
  /** 취소, also what Esc and the dialog's X answer. */
  readonly cancelId: number
}

/**
 * 완전 종료 (05 §7.3): `quit` when there is no service to stop, else the dialog. Only the installed release's service
 * of the own channel is stopped, through its launcher; a development service, a service of another version (a raw
 * exe, another install's) or a missing launcher keeps running and the dialog offers 앱만 종료.
 */
export function fullQuitPrompt(input: {
  readonly channel: "own" | "local"
  readonly running: boolean
  /** The launcher's path when it is missing. */
  readonly missingLauncher?: string
  readonly version?: string
  readonly installed?: string
  /** Running conversations (`GET /api/session/active`); undefined when they could not be counted. */
  readonly active?: number
  /** Remote access (OWN_HOME\gateway.json: the gateway or the app listener) is on. */
  readonly remote: boolean
}): { readonly kind: "quit" } | ({ readonly kind: "ask" } & QuitPrompt) {
  if (!input.running) return { kind: "quit" }
  const keep = (message: string, detail: string) =>
    ({
      kind: "ask",
      type: "info",
      message,
      detail: `${detail}\n앱만 끄고 서비스는 그대로 둬요.`,
      buttons: ["앱만 종료", "취소"],
      choices: ["app", "cancel"],
      cancelId: 1,
    }) as const
  if (input.channel === "local")
    return keep("개발 서비스는 끄지 않아요", "개발 채널에서는 서비스를 띄운 곳(bun dev/serve.ts)에서 멈추세요.")
  if (input.missingLauncher) return keep("서비스를 끌 수 없어요", `런처를 찾지 못했어요: ${input.missingLauncher}`)
  if (input.installed && input.version && input.installed !== input.version)
    return keep(
      "이 서비스는 끄지 않아요",
      `실행 중인 서비스(${input.version})가 설치된 버전(${input.installed})이 아니에요. 끄려면 PowerShell에서 own stop을 실행하세요.`,
    )
  const lines = [
    "앱과 이 PC의 백그라운드 서비스를 모두 꺼요.",
    ...(input.active === undefined
      ? ["· 실행 중인 대화가 있으면 멈춰요. 다음에 앱을 열면 이어서 돌지만 캐시는 새로 쌓여요."]
      : input.active > 0
        ? [`· 실행 중인 대화 ${input.active}개가 멈춰요. 다음에 앱을 열면 이어서 돌지만 캐시는 새로 쌓여요.`]
        : []),
    ...(input.remote ? ["· 휴대폰과 다른 PC의 연결이 끊겨요."] : []),
    "서비스는 두고 앱만 끄려면 [앱만 종료]를 누르세요.",
  ]
  return {
    kind: "ask",
    type: "warning",
    message: "완전 종료할까요?",
    detail: lines.join("\n"),
    buttons: ["완전 종료", "앱만 종료", "취소"],
    choices: ["all", "app", "cancel"],
    cancelId: 2,
  }
}

/** `own stop --force` failed: the stderr tail, and 앱만 종료 or 취소. */
export function stopFailedPrompt(detail: string): QuitPrompt {
  return {
    type: "error",
    message: "서비스를 끄지 못했어요",
    detail: `${detail}\n앱만 끄거나 취소할 수 있어요.`,
    buttons: ["앱만 종료", "취소"],
    choices: ["app", "cancel"],
    cancelId: 1,
  }
}
