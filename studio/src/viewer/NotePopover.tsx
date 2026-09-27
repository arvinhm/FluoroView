import { Pencil, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DatasetInfo } from "../api/types";
import { fmtDateTime } from "../lib/format";
import {
  author, cancelNote, deleteNote, editNote, replyToNote, saveNote, select, setAuthor, useProject,
} from "../state/project";
import type { Bounds } from "./overlay";

const POP_W = 288;
const MARGIN = 10;

export function NotePopover({ ds, at, bounds }: { ds: DatasetInfo; at: { x: number; y: number }; bounds: Bounds }) {
  const draft = useProject((s) => s.noteDraft);
  const selection = useProject((s) => s.selection);
  const notes = useProject((s) => s.scans[ds.id]?.notes);
  const note = selection?.kind === "note" ? notes?.find((n) => n.id === selection.id) : undefined;
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(140);
  const [text, setText] = useState("");
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(author() ?? "");

  useEffect(() => {
    setEditing(false);
    setReply("");
  }, [note?.id]);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight;
    if (h && h !== height) setHeight(h);
  });

  if (!draft && !note) return null;
  const left = at.x + 18 + POP_W <= bounds.w - MARGIN ? at.x + 18 : Math.max(MARGIN, at.x - 18 - POP_W);
  const top = Math.max(MARGIN, Math.min(at.y - 18, bounds.h - height - MARGIN));
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const keys = (e: React.KeyboardEvent, submit: () => void, cancel: () => void) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      cancel();
    }
  };

  if (draft) {
    const save = () => {
      setAuthor(name);
      if (text.trim()) void saveNote(ds.id, text).then(() => setText(""));
    };
    return (
      <div ref={ref} className="note-pop viewer-ui" style={{ transform: `translate(${left}px, ${top}px)` }}
        onPointerDown={stop} onDoubleClick={stop}>
        <textarea className="note-text" autoFocus rows={3} placeholder="Write a note…" value={text} aria-label="Note text"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => keys(e, save, cancelNote)} />
        <div className="note-f">
          <input className="note-author" placeholder="Your name (optional)" value={name} aria-label="Your name"
            onChange={(e) => setName(e.target.value)} onBlur={() => setAuthor(name)} onKeyDown={stop} />
          <button className="btn" onClick={cancelNote}>Cancel</button>
          <button className="btn primary" disabled={!text.trim()} onClick={save}>Add</button>
        </div>
      </div>
    );
  }

  const n = note!;
  const index = (notes ?? []).indexOf(n) + 1;
  const sendReply = () => {
    setAuthor(name);
    if (reply.trim()) void replyToNote(ds.id, n.id, reply).then(() => setReply(""));
  };
  return (
    <div ref={ref} className="note-pop viewer-ui" style={{ transform: `translate(${left}px, ${top}px)` }}
      onPointerDown={stop} onDoubleClick={stop}>
      <div className="note-h">
        <span className="note-num">{index}</span>
        <span className="note-meta">{n.author ?? "Note"} · {fmtDateTime(n.created)}</span>
        <span className="note-act">
          <button className="ib" title="Edit" onClick={() => setEditing(true)}><Pencil /></button>
          <button className="ib" title="Delete note (⌫)" onClick={() => void deleteNote(ds.id, n.id)}><Trash2 /></button>
          <button className="ib" title="Close (Esc)" onClick={() => select(null)}><X /></button>
        </span>
      </div>
      {editing ? (
        <textarea className="note-text" autoFocus rows={3} defaultValue={n.text} aria-label="Note text"
          onKeyDown={(e) => keys(e, () => {
            const value = (e.target as HTMLTextAreaElement).value;
            setEditing(false);
            if (value.trim() && value !== n.text) void editNote(ds.id, n.id, { text: value });
          }, () => setEditing(false))} />
      ) : (
        <p className="note-body">{n.text}</p>
      )}
      {n.replies.map((r) => (
        <div key={r.id} className="note-reply">
          <span className="note-meta">{r.author ?? "Reply"} · {fmtDateTime(r.created)}</span>
          <p className="note-body">{r.text}</p>
        </div>
      ))}
      <input className="input note-reply-input" placeholder="Reply…" value={reply} aria-label="Reply"
        onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => keys(e, sendReply, () => setReply(""))} />
    </div>
  );
}
