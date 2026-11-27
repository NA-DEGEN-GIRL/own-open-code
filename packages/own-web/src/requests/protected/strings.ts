// 설정 > 승인·권한 `에이전트가 못 여는 파일·폴더` strings (01 §13, 03 §18.8, PP). Loaded with the lazy settings page only,
// so the first chunk does not carry them; the same rules as requests/strings.ts (Korean fallback, `{name}`, particles).
import { applyJosa, useI18n, type I18nParams, type Locale } from "@/i18n"

export const protectedKo = {
  "own.protected.title": "에이전트가 못 여는 파일·폴더",
  "own.protected.intro":
    "어느 승인 모드에서나 에이전트의 파일 도구는 여기 있는 파일·폴더를 읽거나 고치지 못해요. 셸 명령에 이 경로가 적혀 있으면 전체 허용이어도 먼저 물어요. 바꾸면 모든 대화에 다음 도구 호출부터 바로 적용돼요.",
  "own.protected.shellNote":
    "셸 명령은 경로가 그대로 적혀 있을 때만 알아봐요. 변수나 와일드카드로 만든 경로, 스크립트 파일 안의 경로, 위 폴더 전체를 훑는 명령은 막지 못해요.",
  "own.protected.server": "서버",
  "own.protected.thisPc": "이 PC",
  "own.protected.readOnly": "이 목록은 이 PC의 창에서만 바꿀 수 있어요.",
  "own.protected.unsupported": "이 서버는 아직 이 설정을 몰라요 · 앱을 업데이트하면 쓸 수 있어요",
  "own.protected.notConnected": "서버에 연결되지 않았어요",
  "own.protected.loading": "불러오는 중…",
  "own.protected.loadFailed": "목록을 불러오지 못했어요",
  "own.protected.user": "내가 더한 것",
  "own.protected.userEmpty": "아직 더한 것이 없어요",
  "own.protected.remove": "빼기",
  "own.protected.removeLabel": "{path} 빼기",
  "own.protected.removed": "{path}(을)를 뺐어요",
  "own.protected.removeFailed": "빼지 못했어요",
  "own.protected.path": "파일·폴더 경로",
  "own.protected.placeholder": "~/wallet-backups 또는 D:\\keys",
  "own.protected.add": "추가",
  "own.protected.addLabel": "{name} 추가",
  "own.protected.pickFolder": "폴더 고르기…",
  "own.protected.pickFile": "파일 고르기…",
  "own.protected.added": "{path}(을)를 더했어요. 모든 대화에 바로 적용돼요.",
  "own.protected.already": "이미 목록에 있어요",
  "own.protected.addFailed": "더하지 못했어요",
  "own.protected.problem.relative": "절대 경로나 ~로 시작하는 경로를 적어 주세요",
  "own.protected.problem.root": "드라이브나 맨 위 폴더 전체는 막을 수 없어요",
  "own.protected.problem.home": "홈 폴더 전체는 막을 수 없어요. 그 안의 폴더를 더해 주세요",
  "own.protected.problem.wildcard": "* 나 ? 없이 경로를 적어 주세요",
  "own.protected.problem.too_many": "더 넣을 수 없어요(최대 {max}개)",
  "own.protected.suggest": "홈 폴더에서 찾은 것",
  "own.protected.suggestNote": "이름이 민감해 보이는 것이에요. 앱이 저절로 더하지는 않아요.",
  "own.protected.folder": "폴더",
  "own.protected.file": "파일",
  "own.protected.builtIn": "기본으로 막는 것 {n}개",
  "own.protected.builtInNote": "앱이 정해 둔 목록이라 빼거나 바꿀 수 없어요.",
  "own.protected.group.own": "이 앱",
  "own.protected.group.keys": "SSH·GPG 키",
  "own.protected.group.ai": "다른 AI 도구",
  "own.protected.group.developer": "개발 도구 로그인",
  "own.protected.group.system": "운영체제 자격 증명",
  "own.protected.group.browser": "브라우저",
  "own.protected.group.wallet": "암호화폐 지갑",
  "own.protected.group.history": "명령 기록",
} as const

export type ProtectedKey = keyof typeof protectedKo

export const protectedEn: Partial<Record<ProtectedKey, string>> = {
  "own.protected.title": "Files and folders agents cannot open",
  "own.protected.intro":
    "In every approval mode the agent's file tools cannot read or change these files and folders. A shell command that names one of these paths asks first, even under Allow all. A change applies to every session from its next tool call.",
  "own.protected.shellNote":
    "Shell commands are checked only for paths written out as they are. Paths built from variables or wildcards, paths inside a script file and commands that search a whole folder above them are not stopped.",
  "own.protected.server": "Server",
  "own.protected.thisPc": "This PC",
  "own.protected.readOnly": "This list can be changed only in a window on this PC.",
  "own.protected.unsupported": "This server does not know this setting yet · update the app to use it",
  "own.protected.notConnected": "Not connected to the server",
  "own.protected.loading": "Loading…",
  "own.protected.loadFailed": "Could not load the list",
  "own.protected.user": "Added by you",
  "own.protected.userEmpty": "Nothing added yet",
  "own.protected.remove": "Remove",
  "own.protected.removeLabel": "Remove {path}",
  "own.protected.removed": "Removed {path}",
  "own.protected.removeFailed": "Could not remove it",
  "own.protected.path": "File or folder path",
  "own.protected.placeholder": "~/wallet-backups or D:\\keys",
  "own.protected.add": "Add",
  "own.protected.addLabel": "Add {name}",
  "own.protected.pickFolder": "Choose a folder…",
  "own.protected.pickFile": "Choose a file…",
  "own.protected.added": "Added {path}. It applies to every session now.",
  "own.protected.already": "It is on the list already",
  "own.protected.addFailed": "Could not add it",
  "own.protected.problem.relative": "Enter an absolute path or one that starts with ~",
  "own.protected.problem.root": "A whole drive or top folder cannot be protected",
  "own.protected.problem.home": "The whole home folder cannot be protected; add a folder inside it",
  "own.protected.problem.wildcard": "Enter the path without * or ?",
  "own.protected.problem.too_many": "No room for more (at most {max})",
  "own.protected.suggest": "Found in your home folder",
  "own.protected.suggestNote": "Their names look sensitive. The app never adds them by itself.",
  "own.protected.folder": "Folder",
  "own.protected.file": "File",
  "own.protected.builtIn": "{n} protected by default",
  "own.protected.builtInNote": "The app's own list; it cannot be removed or changed.",
  "own.protected.group.own": "This app",
  "own.protected.group.keys": "SSH and GPG keys",
  "own.protected.group.ai": "Other AI tools",
  "own.protected.group.developer": "Developer tool logins",
  "own.protected.group.system": "OS credential stores",
  "own.protected.group.browser": "Browsers",
  "own.protected.group.wallet": "Crypto wallets",
  "own.protected.group.history": "Command histories",
}

const catalogs: Record<Locale, Partial<Record<ProtectedKey, string>>> = { ko: protectedKo, en: protectedEn }

export function protectedText(locale: Locale, key: ProtectedKey, params?: I18nParams) {
  const template = catalogs[locale][key] ?? protectedKo[key]
  const filled = params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = params[name]
        return value === undefined ? match : String(value)
      })
    : template
  return locale === "ko" ? applyJosa(filled) : filled
}

export type ProtectedText = (key: ProtectedKey, params?: I18nParams) => string

export function useProtectedText(): ProtectedText {
  const i18n = useI18n()
  return (key, params) => protectedText(i18n.locale(), key, params)
}
