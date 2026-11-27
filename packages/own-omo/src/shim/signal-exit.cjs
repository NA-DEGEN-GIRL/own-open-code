// own's stand-in for `signal-exit` 3 inside the omo runtime bundle (script/resolve.ts). The real module registers
// listeners for every catchable signal on the host process when it loads (proper-lockfile requires it, for omo's skill
// MCP grant store, which own does not run). own's service owns its process: no omo code listens to its signals.
function onExit() {
  return function remove() {}
}
onExit.load = function load() {}
onExit.unload = function unload() {}
onExit.signals = function signals() {
  return []
}
module.exports = onExit
