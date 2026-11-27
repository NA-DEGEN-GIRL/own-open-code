// Idea notes (`아이디어 노트`, 03 §4.4.1): global sticky notes for thoughts that belong to no project yet, kept on this
// PC's service (own.accounts `ideas.*`, 02 §9.2). Separate from the conversation memo (`대화 메모`, src/notes/panel)
// and the project notes (the workspace `노트` tab, src/notes/workspace). First-chunk exports: the layer the shell mounts
// once, the header button and the intent; the quick capture and the board are lazy chunks.
export { OPEN_IDEAS, openIdeas, type IdeasView } from "./intents"
export { IdeasButton, IdeasLayer } from "./layer"
