// SSH dialog requests (04 §17.4): a repeated `원격 폴더 열기` keeps the picker that is already open.
import { expect, test } from "bun:test"
import { closeRemoteDialog, openRemoteDialog, remoteDialog } from "./active"

test("a repeated picker request for the same host keeps the open picker; another host or dialog replaces it", () => {
  openRemoteDialog({ kind: "picker", hostId: "lab" })
  const first = remoteDialog()
  openRemoteDialog({ kind: "picker", hostId: "lab" })
  openRemoteDialog({ kind: "picker", hostId: "lab" })
  // Same object: the keyed dialog host does not remount the picker (its listing and typed path survive).
  expect(remoteDialog()).toBe(first!)

  openRemoteDialog({ kind: "picker", hostId: "nas" })
  expect(remoteDialog()).toEqual({ kind: "picker", hostId: "nas" })
  openRemoteDialog({ kind: "update", hostId: "nas" })
  expect(remoteDialog()).toEqual({ kind: "update", hostId: "nas" })
  closeRemoteDialog()
  expect(remoteDialog()).toBeUndefined()
})
