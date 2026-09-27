import { useStudio } from "../state/store";
import { applySession } from "./actions";

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Asked when a session is opened onto an image that already has regions or notes. */
export function SessionPrompt() {
  const prompt = useStudio((s) => s.sessionPrompt);
  const setPrompt = useStudio((s) => s.setSessionPrompt);
  if (!prompt) return null;
  const name = prompt.path.split("/").pop();
  const { existing, incoming } = prompt;
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && setPrompt(null)}>
      <div className="dialog prompt" role="alertdialog" aria-label="Open session">
        <div className="dialog-h">Open {name}</div>
        <p className="prompt-body">
          This image already has {count(existing.regions, "region")} and {count(existing.notes, "note")}. The session
          has {count(incoming.regions, "region")} and {count(incoming.notes, "note")}.
        </p>
        <p className="prompt-body muted">
          Replace restores the session exactly; the current work is saved first as a backup in FluoroView's data
          folder. Merge adds the session's regions and notes to the current ones.
        </p>
        <div className="dialog-f">
          <button className="btn" onClick={() => setPrompt(null)}>Cancel</button>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => void applySession(prompt.dsId, prompt.path, "merge")}>
            Merge
          </button>
          <button className="btn primary" style={{ marginLeft: 0 }}
            onClick={() => void applySession(prompt.dsId, prompt.path, "replace")}>Replace</button>
        </div>
      </div>
    </div>
  );
}
