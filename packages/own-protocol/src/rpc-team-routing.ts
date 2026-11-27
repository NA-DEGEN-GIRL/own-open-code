export * as OwnTeamRouting from "./rpc-team-routing.js"

// Plain routing metadata of `own.team` (06 §2.7): own-web's first chunk and the phone gateway import these tables
// without evaluating the RPC schema graph, so this file has type-only imports.
import type { OwnTeam } from "./rpc-team.js"

type MethodName = OwnTeam.MethodName
type EventName = OwnTeam.EventName
type Scope = OwnTeam.Scope
type Location = OwnTeam.Location
type Origin = OwnTeam.Origin

export const ID = "own.team"

/**
 * Device scope a method needs (06 §2.7, §12.2): Main 멈춤 and the owner-conversation actions are `prompt`; enabling,
 * reorganizing and integrating are `admin`; confirms, push and settings writes are `local` (never a remote device).
 * Git 저장소로 만들기 (`project.gitInit*`, 3.0) is `local` too: it writes `.git`, a `.gitignore`, a commit of every file
 * and possibly a git identity into the user's own folder, like upstream `vcs.init`, which the gateway refuses.
 */
export const MethodScope: { readonly [M in MethodName]: Scope } = {
  health: "read",
  "team.get": "read",
  "team.list": "read",
  "op.get": "read",
  "outbox.list": "read",
  "integration.get": "read",
  "decisions.list": "read",
  "settings.get": "read",
  diagnostics: "read",
  "worktreeChat.list": "read",

  "team.pause": "prompt",
  "area.pause": "prompt",
  "op.cancel": "prompt",
  "outbox.cancel": "prompt",
  "integration.undo.cancel": "prompt",
  "area.rotate": "prompt",
  "main.rotate": "prompt",
  "area.paths": "prompt",
  "decisions.add": "prompt",

  "area.main": "switch",
  "area.preset": "switch",
  "team.account": "switch",

  enable: "admin",
  disable: "admin",
  "team.home": "admin",
  "op.undo": "admin",
  "op.force": "admin",
  "area.adopt": "admin",
  "area.unadopt": "admin",
  "area.edit": "admin",
  "area.seat": "admin",
  "area.create.check": "admin",
  "area.peer.add": "admin",
  "area.peer.edit": "admin",
  "area.peer.remove": "admin",
  "area.integrate": "admin",
  "integration.undo": "admin",
  "reorg.propose": "admin",
  "reorg.apply": "admin",

  "op.confirm": "local",
  "integration.push.plan": "local",
  "integration.push.execute": "local",
  "settings.set": "local",
  "project.gitInit.plan": "local",
  "project.gitInit": "local",
}

/** Every method goes to the control location so that no area Location is woken (06 §2.7). */
export const MethodLocation: { readonly [M in MethodName]: Location } = {
  health: "control",
  "team.get": "control",
  "team.list": "control",
  enable: "control",
  disable: "control",
  "team.home": "control",
  "team.pause": "control",
  "area.pause": "control",
  "op.get": "control",
  "op.confirm": "control",
  "op.undo": "control",
  "op.cancel": "control",
  "op.force": "control",
  "area.adopt": "control",
  "area.unadopt": "control",
  "outbox.list": "control",
  "outbox.cancel": "control",
  "area.rotate": "control",
  "area.seat": "control",
  "main.rotate": "control",
  "area.main": "control",
  "team.account": "control",
  "area.preset": "control",
  "area.paths": "control",
  "area.edit": "control",
  "area.create.check": "control",
  "area.peer.add": "control",
  "area.peer.edit": "control",
  "area.peer.remove": "control",
  "area.integrate": "control",
  "integration.get": "control",
  "integration.undo": "control",
  "integration.undo.cancel": "control",
  "integration.push.plan": "control",
  "integration.push.execute": "control",
  "reorg.propose": "control",
  "reorg.apply": "control",
  "decisions.list": "control",
  "decisions.add": "control",
  "settings.get": "control",
  "settings.set": "control",
  diagnostics: "control",
  "worktreeChat.list": "control",
  "project.gitInit.plan": "control",
  "project.gitInit": "control",
}

/** Only the leader publishes `rpc.own.team.*` events (06 §2.6, §2.7). */
export const EventOrigin: { readonly [E in EventName]: Origin } = {
  "team.changed": "global",
  "area.changed": "global",
  "outbox.changed": "global",
  "integration.changed": "global",
  "op.progress": "global",
  "op.done": "global",
  "op.confirm": "global",
  notice: "global",
  "worktreeChat.changed": "global",
}
