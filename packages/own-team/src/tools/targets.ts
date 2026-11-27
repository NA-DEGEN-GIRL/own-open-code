export * as Targets from "./targets.js"

import { Model } from "@opencode/schema/model"
import { type Estimate, type OwnTeam, Preset } from "@own/protocol"
import { NeedPaths } from "../assets/need-paths.js"
import { IntegrateOp } from "../integrate/op.js"
import { OpWords } from "../ops/words.js"
import type { Services } from "../services.js"
import { MainSession } from "../sessions/main.js"

/**
 * What a voice action names, found once when it is planned (06 §2.9 대상 찾기): a plan binds what was found and never
 * looks it up again when it runs. Every lookup answers a target or a sentence for the model, never an exception.
 */

/** `provider/model` or `provider/model#variant` (own-accounts' subagent `model` format). */
const REF = /^[^/#]+\/[^#]+(?:#[^#]+)?$/

/** A model the user named; `undefined` when it is not `provider/model[#variant]` (checked first: `parse` throws). */
export function ref(value: string): Model.Ref | undefined {
  return REF.test(value.trim()) ? Model.Ref.parse(value.trim()) : undefined
}

/** `provider/model#variant`, as the user and the model write it. */
export function refText(value: Model.Ref) {
  return `${value.providerID}/${value.id}${value.variant === undefined || value.variant === "default" ? "" : `#${value.variant}`}`
}

/** The models the team uses now: the team main's, then each active area's own area main. */
export async function inUse(services: Services.Context, team: OwnTeam.Team) {
  const [main, areas] = await Promise.all([
    services.features().main.model(team.id),
    services.registry.areas.list(team.id),
  ])
  const refs = [
    ...(main === undefined ? [] : [main]),
    ...areas.flatMap((area) => (area.state !== "retired" && area.main ? [area.main.model] : [])),
  ]
  return [...new Set(refs.map(refText))]
}

/** The cost line of a switch estimate (the 02 dialog's `now` option, else the first one available). */
export function cost(estimate: Estimate.Result) {
  const option =
    estimate.options.find((item) => item.strategy === "now" && item.available) ??
    estimate.options.find((item) => item.available)
  const delta = option?.delta
  if (!delta) return "바꿀 때 드는 비용은 미리 셀 수 없습니다."
  const amount = delta.lo === delta.hi ? number(delta.lo) : `${number(delta.lo)}~${number(delta.hi)}`
  return `바꿀 때 예상 비용: +${amount} ${UNIT[delta.unit]}.`
}

const UNIT: { readonly [K in Estimate.Unit]: string } = {
  credits: "크레딧",
  USD: "USD",
  percent: "%(구독 한도)",
}

function number(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** An op's kind as the result cards title it (`OpWords.of`). */
export const opWord = OpWords.of

/** ` (120 MB, 파일 3개)` of a step confirm, or nothing; never its nonce. */
export function size(confirm: Pick<OwnTeam.Confirm, "bytes" | "files">) {
  const parts = [
    ...(confirm.bytes === undefined ? [] : [NeedPaths.size(confirm.bytes)]),
    ...(confirm.files === undefined ? [] : [`파일 ${confirm.files.length}개`]),
  ]
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`
}

export type Found<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly text: string }

/**
 * A preset by id or name (case ignored) among the presets of `model`'s group (the area main's: another group's preset
 * would be `preset_wrong_group`), with whether it is heavy (`Preset.heavy`: a paid target or active delegation).
 */
export async function preset(
  services: Services.Context,
  input: { readonly model: Model.Ref | undefined; readonly name: string },
): Promise<Found<{ readonly preset: Preset.Info; readonly heavy: boolean }>> {
  const group = input.model === undefined ? undefined : await MainSession.group(services, input.model)
  const [listed, accounts] = await Promise.all([
    services.accounts.presetsList(group === undefined ? {} : { group }),
    services.accounts.accountsList(),
  ])
  if (!listed.ok) return { ok: false, text: `프리셋 목록을 읽지 못했습니다: ${listed.message}` }
  const presets = listed.value.groups
    .filter((row) => group === undefined || row.group === group)
    .flatMap((row): ReadonlyArray<Preset.Info> => row.presets ?? [Preset.builtin(row.group)])
  const wanted = input.name.trim().toLowerCase()
  const byID = presets.filter((item) => item.id === input.name.trim())
  const matched = byID.length > 0 ? byID : presets.filter((item) => item.name.toLowerCase() === wanted)
  const names = presets.map((item) => `"${item.name}"(${item.id})`).join(", ")
  const found = matched[0]
  if (!found) return { ok: false, text: `그런 프리셋이 없습니다. 고를 수 있는 프리셋: ${names || "없음"}` }
  if (matched.length > 1)
    return {
      ok: false,
      text: `이름이 같은 프리셋이 여럿입니다. id로 고르세요: ${matched.map((item) => `"${item.name}"(${item.id})`).join(", ")}`,
    }
  const views = accounts.ok ? accounts.value.accounts : []
  const heavy = Preset.heavy(found, (accountID) => views.find((account) => account.id === accountID))
  return { ok: true, value: { preset: found, heavy } }
}

/**
 * A root conversation of the team's project the user named: its `ses_` id (or the start of one, as `team_status`
 * shows it), else its title (`session.list{search}`). Several matches answer the candidates (title, id and folder), and
 * nothing is chosen.
 */
export async function session(
  services: Services.Context,
  team: OwnTeam.Team,
  name: string,
): Promise<Found<{ readonly id: string; readonly title: string; readonly directory: string }>> {
  const wanted = name.trim()
  const byID = wanted.startsWith("ses_")
  const exact = byID
    ? await services.http.session.get({ sessionID: wanted, directory: team.home.directory })
    : undefined
  const listed = exact?.ok
    ? { ok: true as const, value: { data: [exact.value] } }
    : await services.http.session.list({
        project: team.projectID,
        parentID: null,
        order: "desc",
        limit: 200,
        ...(byID ? {} : { search: wanted }),
      })
  if (!listed.ok) return { ok: false, text: `대화 목록을 읽지 못했습니다: ${listed.message}` }
  const sessions = listed.value.data.filter((item) => item.parentID === undefined && item.projectID === team.projectID)
  const matched = byID
    ? sessions.filter((item) => item.id.startsWith(wanted))
    : sessions.filter((item) => (item.title ?? "").toLowerCase().includes(wanted.toLowerCase()))
  const title = (item: (typeof sessions)[number]) => (item.title ?? "제목 없음").replace(/\s+/g, " ").slice(0, 60)
  const found = matched[0]
  if (!found) return { ok: false, text: `이 프로젝트에서 그런 대화를 찾지 못했습니다: "${wanted}"` }
  if (matched.length > 1)
    return {
      ok: false,
      text: `맞는 대화가 여럿입니다. 하나를 id로 고르세요: ${matched
        .slice(0, 8)
        .map((item) => `"${title(item)}"(${item.id}, ${item.location.directory})`)
        .join(", ")}`,
    }
  return { ok: true, value: { id: found.id, title: title(found), directory: found.location.directory } }
}

/** The newest integration of the team (or of one area) that is done and moved the target. */
export async function integrated(services: Services.Context, teamID: OwnTeam.TeamID, areaID?: OwnTeam.AreaID) {
  return (await IntegrateOp.list(services, teamID)).findLast(
    (item) => item.state === "done" && item.advanced !== undefined && (areaID === undefined || item.areaID === areaID),
  )
}

/** The team's integration undos that wait outside their op (`Integration.undoing`, 7.4), of `areaID` when given. */
export async function undoing(services: Services.Context, teamID: OwnTeam.TeamID, areaID?: OwnTeam.AreaID) {
  return (await IntegrateOp.list(services, teamID)).filter(
    (item) => item.state === "done" && item.undoing !== undefined && (areaID === undefined || item.areaID === areaID),
  )
}

/** `work`, or `undefined` once `ms` passed on the services' clock (the work goes on). */
export async function bounded<T>(services: Services.Base, work: Promise<T>, ms: number): Promise<T | undefined> {
  const waited = Promise.withResolvers<undefined>()
  const cancel = services.clock.schedule(ms, () => waited.resolve(undefined))
  const result = await Promise.race([work, waited.promise])
  cancel()
  return result
}
