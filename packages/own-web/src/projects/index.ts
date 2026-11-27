// Project open module (03 §18.3, 01 §17.1 #3, owner: workspace). Public surface for the shell, sidebar, new-session
// screen and palette. The picker itself (`./picker`) is a lazy chunk loaded by `ProjectOpenerLayer`.
export { activeDirectory, followWorkspaceRoute } from "./active"
export { preloadProjectPicker, ProjectOpenerLayer } from "./layer"
export { OpenFolderButton } from "./open-button"
export { ProjectSelect } from "./select"
export {
  createProjectOpener,
  openProject,
  projectOpenerBusy,
  registerProjectOpener,
  type OpenerBusy,
  type PickerRequest,
  type PickOptions,
  type ProjectOpener,
} from "./opener"
export { checkProject, controlOf, listFolders, resolveProject, type ProjectCheck, type ResolvedProject } from "./fs"
export { mergeRecent, openedFolders, rememberFolder, useRecentProjects, type RecentProject } from "./recent"
export {
  baseName,
  crumbs,
  isAbsolutePath,
  joinPath,
  normalizeInput,
  parentPath,
  rootOf,
  rootsOf,
  samePath,
  tooBroad,
  trimSep,
} from "./path"
export { projectsEn, projectsKo, projectsText, useProjectsText, type ProjectsKey } from "./strings"
