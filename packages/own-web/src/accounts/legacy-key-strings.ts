// The old app's saved API keys on the accounts page (02 §3.2b, "이전 앱에서 가져오기"): the rows and the confirmation
// (legacy-key-import.tsx), the done line (codex-import.tsx), the account card's connection line and the remove dialog's
// note. Only the lazy accounts page reads them, so none of it is in the first chunk (PF5).
import { featureText } from "@/queue/text"

export const legacyKeyKo = {
  "own.legacyKey.title": "API 키",
  "own.legacyKey.found": "이전 앱에 저장된 API 키 {n}개를 찾았어요.",
  "own.legacyKey.note":
    "연결만 할 수 있어요. 키는 이 앱에 복사하지 않고, 요청할 때 이전 앱 파일을 읽기만 해요. 이전 앱을 지우거나 키를 바꾸면 여기서도 바뀌어요.",
  "own.legacyKey.link": "연결…",
  "own.legacyKey.linkable": "연결할 수 있음",
  "own.legacyKey.imported": '이미 연결됨 → "{account}"',
  "own.legacyKey.problem.not_found": "이전 앱에 저장된 키가 없어요",
  "own.legacyKey.problem.decrypt_failed": "이 Windows 사용자로는 키를 열 수 없어요",
  "own.legacyKey.problem.path_denied": "키 파일 위치를 읽을 수 없어요",
  "own.legacyKey.problem.invalid_key": "키 형식이 올바르지 않아요",
  "own.legacyKey.problem.unreadable": "키 파일을 읽을 수 없어요",
  "own.legacyKey.problem.unsupported_provider": "이 앱이 지원하지 않는 API예요",
  "own.legacyKey.problem.helper_outdated": "키 저장소 도구가 오래되었어요 — 앱을 업데이트하세요",
  "own.legacyKey.keyHint": "키 {hint}",
  "own.legacyKey.model": "이전 앱에서 쓰던 모델: {model}",
  "own.legacyKey.warn.linked_key_depends_on_source":
    "키는 이전 앱 파일을 읽기만 해요. 이전 앱을 지우거나 키를 바꾸면 여기서도 바뀌어요(이전 앱에서 키를 지우면 이 계정은 멈춰요).",
  "own.legacyKey.warn.model_not_in_template":
    "이전 앱에서 쓰던 모델이 이 앱의 모델 목록에 없어요. 이 앱의 모델 목록을 써요.",
  "own.legacyKey.duplicate": '이미 같은 키를 쓰는 계정 "{account}"(이)가 있어 새로 연결하지 않아요.',
  "own.legacyKey.connect": "연결하기",
  "own.legacyKey.done": '"{label}" 계정을 연결했어요 (키 {hint}). 실행 중인 대화는 바뀌지 않아요.',
  "own.legacyKey.conn": "이전 앱 키 연결 · {name} (읽기 전용 — 이전 앱에서 키를 바꾸면 여기서도 바뀌어요)",
  "own.legacyKey.removeKeepsSource": "이전 앱의 키 파일은 건드리지 않아요. 이 앱의 연결만 지워요.",
} as const satisfies Record<string, string>

export type LegacyKeyKey = keyof typeof legacyKeyKo

export const legacyKeyEn: Partial<Record<LegacyKeyKey, string>> = {
  "own.legacyKey.title": "API keys",
  "own.legacyKey.found": "Found {n} API keys saved in the old app.",
  "own.legacyKey.note":
    "Link only. The key is not copied into this app; each request reads the old app's file. If you remove the old app or change the key there, it changes here too.",
  "own.legacyKey.link": "Link…",
  "own.legacyKey.linkable": "Can be linked",
  "own.legacyKey.imported": 'Already linked → "{account}"',
  "own.legacyKey.problem.not_found": "The old app has no saved key",
  "own.legacyKey.problem.decrypt_failed": "This Windows user cannot open the key",
  "own.legacyKey.problem.path_denied": "The key file's location cannot be read",
  "own.legacyKey.problem.invalid_key": "The key is not in a valid format",
  "own.legacyKey.problem.unreadable": "The key file cannot be read",
  "own.legacyKey.problem.unsupported_provider": "This API is not supported by this app",
  "own.legacyKey.problem.helper_outdated": "The key store helper is outdated — update the app",
  "own.legacyKey.keyHint": "key {hint}",
  "own.legacyKey.model": "Model used in the old app: {model}",
  "own.legacyKey.warn.linked_key_depends_on_source":
    "The key is only read from the old app's file. If you remove the old app or change the key there, it changes here too (deleting the key there stops this account).",
  "own.legacyKey.warn.model_not_in_template":
    "The old app's model is not in this app's model list. This app's model list is used.",
  "own.legacyKey.duplicate": 'An account already uses this key ("{account}"); nothing new is linked.',
  "own.legacyKey.connect": "Link",
  "own.legacyKey.done": '"{label}" was linked (key {hint}). Running sessions are not changed.',
  "own.legacyKey.conn": "Old-app key link · {name} (read-only — changing the key in the old app changes it here too)",
  "own.legacyKey.removeKeepsSource": "The old app's key file is not touched; only this app's link is removed.",
}

export const legacyKeyText = featureText(legacyKeyKo, legacyKeyEn)
export const useLegacyKeyText = legacyKeyText.use
