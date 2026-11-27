// Server entry for the development config `{ "package": "<repo>/packages/own-remote" }` (04 §4.1): a directory
// plugin resolves `<dir>/server` or `<dir>/index` (plugin/src/host.ts), not package.json exports.
export { default } from "./src/index.js"
