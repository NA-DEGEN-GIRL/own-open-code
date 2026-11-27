// Conversation memo (`대화 메모`, 03 §19.10, 01 §17.1 #26; the module's older name is "thread notes"). First-chunk
// exports: the intent and the layer (which lazy-loads the dialog). The editor itself (`ThreadNotes` in ./panel) is for
// lazy surfaces: the memo dialog and, once it exists, the session-info drawer's memo section (5.6). The workspace
// `노트` tab (project notes, ./workspace) is a separate feature.
export { NOTE_ENTRY, NOTE_KEY, NOTE_LIMIT, noteOf } from "./model"
export { OPEN_NOTES, openNotes, type OpenNotesDetail } from "./intents"
export { NotesLayer } from "./layer"
