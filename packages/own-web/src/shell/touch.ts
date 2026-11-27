// What a touch screen adds to the shell, one lazy chunk (app-shell.tsx): open menus that follow their button
// (./follow-anchor.ts) and the swipe gestures (./swipe.ts). PF5: the first chunk only holds the import.
import { followAnchors } from "./follow-anchor"
import { swipes } from "./swipe"

export function touchShell() {
  const stops = [followAnchors(), swipes()]
  return () => stops.forEach((stop) => stop())
}
