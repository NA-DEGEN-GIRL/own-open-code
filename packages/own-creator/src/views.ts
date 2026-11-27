export * as Views from "./views.js"

import { Creator } from "@own/protocol/creator"
import type { CreatorStore } from "./store.js"

/** An extension as Settings and the inspect tool show it (17 §8.1). */
export function view(
  loaded: CreatorStore.Loaded,
  raw?: unknown,
  crashes: ReadonlyArray<Creator.Crash> = [],
  remote: Creator.View["remote"] = [],
): Creator.View {
  const extension = loaded.extension
  const fallback = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  const title = extension?.title ?? (typeof fallback.title === "string" ? fallback.title : loaded.entry.id)
  const description =
    extension?.description ?? (typeof fallback.description === "string" ? fallback.description : undefined)
  const effects = extension === undefined ? [] : Creator.effects(extension)
  return {
    id: loaded.entry.id,
    title,
    ...(description === undefined ? {} : { description }),
    status: loaded.status,
    kind: extension === undefined ? kindOf(fallback) : Creator.kindOf(extension),
    enabled: loaded.entry.enabled,
    active: loaded.entry.active,
    projects: loaded.entry.projects,
    loosenPending: effects.some((effect) => effect.loosens) && !loaded.entry.loosen.includes(loaded.entry.active),
    effects: effects.map((effect) => ({ ...effect })),
    problems: loaded.problems.map((problem) => ({ ...problem })),
    versions: loaded.entry.versions,
    history: loaded.entry.history.slice(-30),
    updatedAt: loaded.entry.updatedAt,
    trusted: loaded.entry.trusted,
    confirmed: loaded.entry.confirmed,
    crashes: crashes.map((crash) => ({ ...crash })),
    hostProjects: loaded.entry.hostProjects.map((item) => ({ ...item })),
    hosts: { mode: Creator.hostsOf(loaded.entry).mode, ids: [...Creator.hostsOf(loaded.entry).ids] },
    hostTrusted: loaded.entry.hostTrusted.map((item) => ({ ...item })),
    remote: [...remote],
  }
}

export function views(
  snapshot: CreatorStore.Snapshot,
  crashes: ReadonlyMap<string, ReadonlyArray<Creator.Crash>> = new Map(),
  remote: (loaded: CreatorStore.Loaded) => Creator.View["remote"] = () => [],
) {
  return snapshot.loaded.map((loaded) => view(loaded, undefined, crashes.get(loaded.entry.id) ?? [], remote(loaded)))
}

function kindOf(raw: Record<string, unknown>): Creator.Kind {
  return raw.kind === "mcp" || raw.kind === "plugin" ? raw.kind : "declarative"
}

const CACHE: Record<Creator.ItemEffect["cache"], string> = {
  keeps: "캐시 유지",
  breaks: "열린 대화의 캐시를 한 번 깸",
  new: "압축 요청에만",
  none: "요청 글 변화 없음",
}

const TYPE: Record<Creator.ItemType, string> = {
  "prompt.fragment": "지시문 조각",
  "tool.command": "명령 도구",
  "tool.rule": "도구 규칙",
  retry: "재시도 정책",
  "compaction.prompt": "압축 지시 추가",
  agent: "에이전트",
  command: "슬래시 명령",
  skill: "스킬",
  "harness.instructions": "내 지시문",
  "mcp.server": "MCP 서버",
  "plugin.code": "코드 플러그인",
}

/**
 * The approval card's lines (17 §7.2): what the action does, then one line per item with its cache effect, then the
 * warnings (allow rules waiting for Settings, direct tools).
 */
export function card(action: string, id: string, extension: Creator.Extension | undefined, version?: number) {
  const head = `확장 ${id} ${ACTION[action] ?? action}${version === undefined ? "" : ` (판 ${version})`}`
  if (extension === undefined) return [head]
  const effects = Creator.effects(extension)
  const items = effects.map((effect) => {
    const item = extension.items.find((entry) => Creator.itemName(entry) === effect.name && entry.type === effect.type)
    const direct =
      item?.type === "tool.command" || item?.type === "mcp.server"
        ? item.direct === true
          ? ", 직접 도구"
          : ", Code Mode"
        : ""
    return `· ${TYPE[effect.type]} ${effect.name}${direct} — ${CACHE[effect.cache]}`
  })
  const dependencies = extension.items.flatMap((item) =>
    item.type === "mcp.server" && Object.keys(item.dependencies ?? {}).length > 0
      ? [
          `· 의존성 설치(${item.name}): ${Object.entries(item.dependencies ?? {})
            .map(([name, version]) => `${name}@${version}`)
            .join(", ")} — 허용 목록, 설치 스크립트 없이`,
        ]
      : [],
  )
  const warnings = [
    ...(effects.some((effect) => effect.loosens) ? ["! allow 규칙은 설정 > 확장에서 사용자가 승인해야 켜져요"] : []),
    ...(effects.some((effect) => effect.cache === "breaks") ? ["! 열린 대화의 프롬프트 캐시가 한 번 깨져요"] : []),
    ...(effects.some((effect) => effect.code === "process")
      ? ["! 코드가 own의 WebAssembly 샌드박스(QuickJS)에서, 환경·프로세스·디스크 없이 돌아요. 프로젝트 파일과 선언한 호스트만 닿아요. 부를 때마다 승인 모드대로 묻고, 전체 허용에서도 판마다 처음 한 번은 물어요"]
      : []),
    ...(effects.some((effect) => effect.code === "service")
      ? ["! 코드가 서비스 프로세스 안에서 나(사용자)로 돌아요. 파일과 네트워크에 다 닿고 계정 토큰·키를 읽을 수 있어요. 단계 검사도 이 코드를 돌리니, 돌리기 전에 먼저 묻고, 설정 > 확장에서 이 판을 승인해야 켜져요"]
      : []),
  ]
  return [head, ...items, ...dependencies, ...warnings]
}

/**
 * The card shown before a C3 plugin is staged (17 §12.3): staging runs the plugin's own code, which in the service
 * means it runs as the user with full file and network access and can read account tokens and keys.
 */
export function runCard(id: string) {
  return [
    `확장 ${id}의 코드 플러그인을 실행해요 (단계 검사)`,
    "! 이 코드는 서비스 프로세스 안에서 나(사용자)로 돌아요",
    "! 내 파일과 네트워크에 다 닿고, 계정 토큰·키·자격 증명을 읽어 밖으로 보낼 수 있어요",
    "! own의 샌드박스가 없는 단계예요. 믿을 수 있는 코드일 때만 실행하세요",
  ]
}

const ACTION: Record<string, string> = {
  create: "만들기",
  update: "새 판으로 바꾸기",
  enable: "켜기",
  disable: "끄기",
  rollback: "되돌리기",
  remove: "지우기",
  scope: "적용 범위 바꾸기",
}
