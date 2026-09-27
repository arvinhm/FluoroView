import { project } from "../api/client";
import { useStudio } from "./store";

const SAVE_DELAY_MS = 800;

/**
 * Save each scan's channel display to its project shortly after the user changes it. Displays that
 * were never edited are not saved, so auto-contrast keeps working on first open.
 */
export function persistDisplays(): () => void {
  const timers = new Map<string, number>();
  const unsubscribe = useStudio.subscribe((s, prev) => {
    for (const id of Object.keys(s.display)) {
      if (s.display[id] === prev.display[id] || !s.displayEdited[id]) continue;
      window.clearTimeout(timers.get(id));
      timers.set(id, window.setTimeout(() => {
        timers.delete(id);
        const list = useStudio.getState().display[id];
        if (!list) return;
        project.saveDisplay(id, list.map(({ visible, color, lo, hi, gamma, touched }) => ({ visible, color, lo, hi, gamma, touched })))
          .catch((e: Error) => useStudio.getState().setNotice(`Could not save the display settings: ${e.message}`));
      }, SAVE_DELAY_MS));
    }
  });
  return () => {
    unsubscribe();
    timers.forEach((t) => window.clearTimeout(t));
  };
}
