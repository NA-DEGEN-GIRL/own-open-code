// A team op that waits (RH-20, 06 §8.5, §9.3): the card's step, why it waits and since when, and its buttons 취소,
// 바로 진행, 명령 멈추고 진행 and 대화 열기; an integration undo that waits outside its op and its 되돌리기 취소 (RH-42,
// 06 §7.4). Only the lazy team cards read them, so none of it is in the first chunk (PF5).
import { featureText, type FeatureText } from "@/queue/text"

export const teamWaitKo = {
  "own.team.wait.step": "단계 {n}/{m}",
  "own.team.wait.since": "{n}분째",
  "own.team.wait.confirm": "확인을 기다려요",
  "own.team.wait.cancel": "취소",
  "own.team.wait.force": "바로 진행",
  "own.team.wait.stopShell": "명령 멈추고 진행",
  "own.team.wait.open": "대화 열기",
  "own.team.wait.shell": "실행 중인 명령: {command}",
  "own.team.wait.pty": "열린 터미널: {command}",
  "own.team.wait.cancelled": "작업을 취소했어요",
  "own.team.wait.forced": "기다리지 않고 진행해요",
  "own.team.wait.stopped": "명령을 멈추고 진행해요",
  "own.team.wait.long": "5분 넘게 기다리고 있어요",
  "own.team.wait.undo.dirty": "{folder}에서 아직 저장 지점에 넣지 않은 파일 {n}개와 겹쳐 되돌리기를 기다려요",
  "own.team.wait.undo.inUse": "{folder}에서 하던 일이 끝나면 되돌려요",
  "own.team.wait.undo.inProgress": "{folder}에서 하던 기록 정리가 끝나면 되돌려요",
  "own.team.wait.undo.outside": "팀 밖의 {folder} 폴더가 프로젝트 본 코드를 쓰고 있어 되돌리기를 기다려요",
  "own.team.wait.undoCancel": "되돌리기 취소",
  "own.team.wait.undoCancelled": "되돌리기를 취소했어요. 본 코드는 반영한 그대로예요",
} as const satisfies Record<string, string>

export type TeamWaitKey = keyof typeof teamWaitKo

export const teamWaitEn: Partial<Record<TeamWaitKey, string>> = {
  "own.team.wait.step": "Step {n}/{m}",
  "own.team.wait.since": "{n} min",
  "own.team.wait.confirm": "Waiting for your answer",
  "own.team.wait.cancel": "Cancel",
  "own.team.wait.force": "Go on now",
  "own.team.wait.stopShell": "Stop the command and go on",
  "own.team.wait.open": "Open the conversation",
  "own.team.wait.shell": "Running command: {command}",
  "own.team.wait.pty": "Open terminal: {command}",
  "own.team.wait.cancelled": "The operation was cancelled",
  "own.team.wait.forced": "Going on without waiting",
  "own.team.wait.stopped": "Stopping the command and going on",
  "own.team.wait.long": "Waiting for more than 5 minutes",
  "own.team.wait.undo.dirty": "Waiting to undo: {n} unsaved files in {folder} overlap",
  "own.team.wait.undo.inUse": "Undoes once the work in {folder} ends",
  "own.team.wait.undo.inProgress": "Undoes once the history cleanup in {folder} ends",
  "own.team.wait.undo.outside": "Waiting to undo: {folder}, outside the team, uses the project's main code",
  "own.team.wait.undoCancel": "Cancel undo",
  "own.team.wait.undoCancelled": "The undo was cancelled. The main code stays as applied",
}

export const teamWaitText = featureText(teamWaitKo, teamWaitEn)
export const useTeamWaitText = teamWaitText.use
export type TeamWaitText = FeatureText<TeamWaitKey>
