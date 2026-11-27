// Tab labels (03 §18.6 "탭 줄: `셸 이름 · 폴더` 탭들"): the shell's file name without extension and the last folder
// of the PTY's working directory. Same shell in the same folder gets a number from the second tab on.
import type { PtyInfo } from "./api"

/** `C:\Program Files\PowerShell\7\pwsh.exe` → `pwsh`, `/usr/bin/bash` → `bash`. */
export function shellName(command: string) {
  const file = command.split(/[\\/]/).filter(Boolean).at(-1) ?? command
  return file.replace(/\.(exe|cmd|bat|com)$/i, "") || command
}

/** Last path segment; a drive root keeps its letter (`D:\` → `D:`). */
export function folderName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

export interface TabLabel {
  readonly shell: string
  readonly folder: string
  /** 1-based among tabs with the same shell and folder; only shown from 2 on. */
  readonly n: number
}

export function tabLabels(ptys: readonly Pick<PtyInfo, "id" | "command" | "cwd">[]) {
  const seen = new Map<string, number>()
  return new Map(
    ptys.map((pty) => {
      const shell = shellName(pty.command)
      const folder = folderName(pty.cwd)
      const key = `${shell}\0${folder}`
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      return [pty.id, { shell, folder, n } satisfies TabLabel] as const
    }),
  )
}

/**
 * The code in `종료됨 (exit {code})`. A Windows exit code is a 32-bit DWORD, and the ones from 0x80000000 up are
 * NTSTATUS or HRESULT values written in hex (0xC0000005 is an access violation), so those show as `0xC0000005`; the
 * rest stay decimal. Core sends them unsigned (P-033); an older server sent them negative, which is the same code.
 */
export function exitCodeText(code: number) {
  const unsigned = code >>> 0
  return unsigned >= 0x80000000 ? `0x${unsigned.toString(16).toUpperCase()}` : String(code)
}
