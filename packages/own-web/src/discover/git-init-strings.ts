// Strings of the `Git 저장소로 만들기` dialog (03 §4.3.1, 06 §3.0), loaded with the dialog chunk. Git words are the
// subject here (the team catalog keeps them out of team mode's own copy), each with a plain word first: `저장 지점(커밋)`.
// Keys use the `own.gitInit.*` namespace and can move verbatim into src/i18n/ko.ts / en.ts.
import { featureText } from "@/queue/text"

export const gitInitKo = {
  "own.gitInit.title": "Git 저장소로 만들기",
  "own.gitInit.folder": "폴더",
  "own.gitInit.what":
    "이 폴더 안에 .git 폴더를 만들고 기본 브랜치를 {branch}(으)로 정해요. 폴더 안의 파일은 바꾸지 않아요.",
  "own.gitInit.why": "팀 모드와 작업 폴더는 Git 저장소와 첫 저장 지점(커밋)이 있어야 쓸 수 있어요.",
  "own.gitInit.unborn":
    "이 폴더는 이미 Git 저장소이지만 저장 지점(커밋)이 아직 없어요. 첫 커밋을 만들면 팀 모드와 작업 폴더를 쓸 수 있어요.",
  "own.gitInit.loading": "폴더를 살펴보는 중…",
  "own.gitInit.commit": "첫 저장 지점(커밋) 만들기",
  "own.gitInit.commitAbout": "지금 있는 파일을 첫 커밋으로 저장해요. 아래 목록을 보고 고르세요.",
  "own.gitInit.commitOff":
    "커밋 없이 만들면 팀 모드와 작업 폴더는 아직 쓸 수 없어요. 팀 모드를 켜려 할 때 첫 커밋을 만들자고 다시 물어요.",
  "own.gitInit.gitignore": "제안한 .gitignore 만들기 (빌드 결과·캐시·로그·비밀 파일·OS 파일 빼기)",
  "own.gitInit.gitignoreShow": "제안 내용 보기",
  "own.gitInit.gitignoreLeaves": "제안한 .gitignore가 파일 {n}개({size})를 빼요.",
  "own.gitInit.gitignoreLeavesCount": "제안한 .gitignore가 파일 {n}개를 빼요.",
  "own.gitInit.gitignoreRequired": "제안 없이는 파일이 너무 많아 .gitignore를 끌 수 없어요.",
  "own.gitInit.gitignoreExists": "이 폴더의 .gitignore를 그대로 써요.",
  "own.gitInit.summary": "커밋할 파일 {n}개, {size}",
  "own.gitInit.largest": "가장 큰 파일",
  "own.gitInit.flagged": "큰 파일·바이너리 파일 {n}개는 기본으로 빼요",
  "own.gitInit.flaggedAbout":
    "Git은 큰 파일과 바이너리 파일을 담기에 알맞지 않아요(저장소가 커지고 느려져요). 빼도 폴더에는 그대로 남아요. 저장소에 꼭 넣어야 하면 Git LFS를 쓰는 것이 좋아요.",
  "own.gitInit.flaggedMore": "그 밖의 {n}개도 빼요.",
  "own.gitInit.binary": "바이너리",
  "own.gitInit.large": "큰 파일",
  "own.gitInit.ignored": ".gitignore로 빠짐",
  "own.gitInit.nested": "안에 있는 Git 저장소 {n}개는 커밋하지 않아요: {paths}",
  "own.gitInit.tooMany":
    "새 파일이 {n}개로 너무 많아요({limit}개까지). 저장소만 만든 뒤 .gitignore를 손보고 직접 커밋하세요.",
  "own.gitInit.identity": "커밋할 사람",
  "own.gitInit.identityAbout": "Git에 이름과 이메일이 없어요. 적은 값은 이 저장소의 설정에만 저장해요.",
  "own.gitInit.identityName": "이름",
  "own.gitInit.identityEmail": "이메일",
  "own.gitInit.identityUses": "작성자: {name} <{email}>",
  "own.gitInit.confirm": "Git 저장소로 만들기",
  "own.gitInit.confirmCommit": "만들고 첫 커밋하기",
  "own.gitInit.confirmFirst": "첫 커밋하기",
  "own.gitInit.working": "만드는 중…",
  "own.gitInit.cancel": "취소",
  "own.gitInit.close": "닫기",
  "own.gitInit.retry": "다시 살피기",
  "own.gitInit.done": "Git 저장소가 되었어요. 브랜치 {branch}.",
  "own.gitInit.doneCommit": "Git 저장소가 되었어요. 브랜치 {branch}, 첫 커밋 {commit} (파일 {n}개, {size}).",
  "own.gitInit.doneExcluded": "커밋에서 뺀 {n}개는 폴더에 그대로 있어요.",
  "own.gitInit.doneNext": "이제 팀 모드와 작업 폴더를 쓸 수 있어요.",
  "own.gitInit.doneNoCommit": "팀 모드와 작업 폴더는 첫 커밋을 만든 뒤에 쓸 수 있어요.",
  "own.gitInit.enableTeam": "팀 모드 켜기…",
  "own.gitInit.refused.exists": "이 폴더는 이미 Git 저장소예요.",
  "own.gitInit.refused.inside": "이 폴더는 다른 Git 저장소 안에 있어요: {parent}. 그 저장소를 프로젝트로 여세요.",
  "own.gitInit.refused.system": "시스템 폴더나 홈 폴더는 Git 저장소로 만들지 않아요.",
  "own.gitInit.refused.busy": "이 폴더를 이미 만드는 중이에요.",
  "own.gitInit.refused.tooMany":
    "새 파일이 너무 많아 첫 커밋을 여기서 만들 수 없어요. 저장소만 만든 뒤 직접 커밋하세요.",
  "own.gitInit.openParent": "상위 저장소에서 새 대화",
  "own.gitInit.identityMissing": "커밋할 이름과 이메일을 적어 주세요.",
  "own.gitInit.gitTooOld": "Git {version}(은)는 너무 오래되었어요. {minimum} 이상이 필요해요.",
  "own.gitInit.gitMissing": "이 컴퓨터에 Git이 설치되어 있지 않아요.",
  "own.gitInit.gitFailed": "Git이 실패해서 이번에 만든 것은 되돌렸어요: {message}",
  "own.gitInit.notFound": "폴더를 찾을 수 없어요.",
  "own.gitInit.failed": "만들지 못했어요: {reason}",
} as const satisfies Record<string, string>

export type GitInitKey = keyof typeof gitInitKo

export const gitInitEn: Record<GitInitKey, string> = {
  "own.gitInit.title": "Make it a Git repository",
  "own.gitInit.folder": "Folder",
  "own.gitInit.what":
    "Creates a .git folder inside this folder with {branch} as the default branch. The files in the folder are not changed.",
  "own.gitInit.why": "Team mode and work folders (worktrees) need a Git repository with a first save point (commit).",
  "own.gitInit.unborn":
    "This folder is a Git repository already, but it has no save point (commit) yet. Make the first commit to use team mode and work folders.",
  "own.gitInit.loading": "Looking over the folder…",
  "own.gitInit.commit": "Make the first save point (commit)",
  "own.gitInit.commitAbout": "Saves the files there now as the first commit. Check the lists below.",
  "own.gitInit.commitOff":
    "Without a commit, team mode and work folders cannot start yet. Turning on team mode asks for the first commit again.",
  "own.gitInit.gitignore": "Create the proposed .gitignore (leaves out build output, caches, logs, secrets, OS files)",
  "own.gitInit.gitignoreShow": "Show the proposal",
  "own.gitInit.gitignoreLeaves": "The proposed .gitignore leaves out {n} files ({size}).",
  "own.gitInit.gitignoreLeavesCount": "The proposed .gitignore leaves out {n} files.",
  "own.gitInit.gitignoreRequired": "Without the proposal there are too many files, so the .gitignore stays on.",
  "own.gitInit.gitignoreExists": "The folder's own .gitignore is used as it is.",
  "own.gitInit.summary": "{n} files to commit, {size}",
  "own.gitInit.largest": "Largest files",
  "own.gitInit.flagged": "{n} large or binary files are left out unless you pick them",
  "own.gitInit.flaggedAbout":
    "Git is not made for large and binary files (the repository grows and slows down). Left out, they stay in the folder. If they must be in the repository, Git LFS is the better way.",
  "own.gitInit.flaggedMore": "{n} more are left out too.",
  "own.gitInit.binary": "binary",
  "own.gitInit.large": "large",
  "own.gitInit.ignored": "left out by .gitignore",
  "own.gitInit.nested": "{n} Git repositories inside are not committed: {paths}",
  "own.gitInit.tooMany":
    "There are {n} new files, too many (up to {limit}). Make the repository only, then adjust .gitignore and commit yourself.",
  "own.gitInit.identity": "Who commits",
  "own.gitInit.identityAbout":
    "Git has no name and email here. What you type is saved in this repository's settings only.",
  "own.gitInit.identityName": "Name",
  "own.gitInit.identityEmail": "Email",
  "own.gitInit.identityUses": "Author: {name} <{email}>",
  "own.gitInit.confirm": "Make it a Git repository",
  "own.gitInit.confirmCommit": "Make it and commit",
  "own.gitInit.confirmFirst": "Make the first commit",
  "own.gitInit.working": "Working…",
  "own.gitInit.cancel": "Cancel",
  "own.gitInit.close": "Close",
  "own.gitInit.retry": "Look again",
  "own.gitInit.done": "It is a Git repository now, on branch {branch}.",
  "own.gitInit.doneCommit":
    "It is a Git repository now, on branch {branch}, first commit {commit} ({n} files, {size}).",
  "own.gitInit.doneExcluded": "The {n} left out of the commit are still in the folder.",
  "own.gitInit.doneNext": "Team mode and work folders (worktrees) can be used now.",
  "own.gitInit.doneNoCommit": "Team mode and work folders can be used once the first commit is made.",
  "own.gitInit.enableTeam": "Turn on team mode…",
  "own.gitInit.refused.exists": "This folder is a Git repository already.",
  "own.gitInit.refused.inside": "This folder is inside another Git repository: {parent}. Open that one as the project.",
  "own.gitInit.refused.system": "A system folder or the home folder is never made a Git repository.",
  "own.gitInit.refused.busy": "This folder is being made a repository already.",
  "own.gitInit.refused.tooMany":
    "There are too many new files to make the first commit here. Make the repository only, then commit yourself.",
  "own.gitInit.openParent": "New session in that repository",
  "own.gitInit.identityMissing": "Type the name and email to commit with.",
  "own.gitInit.gitTooOld": "Git {version} is too old. {minimum} or later is needed.",
  "own.gitInit.gitMissing": "Git is not installed on that computer.",
  "own.gitInit.gitFailed": "Git failed, and what this made was taken back: {message}",
  "own.gitInit.notFound": "The folder was not found.",
  "own.gitInit.failed": "Could not make it: {reason}",
}

export const gitInitText = featureText(gitInitKo, gitInitEn)
export const useGitInitText = gitInitText.use
