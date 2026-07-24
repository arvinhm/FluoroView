import { useState } from "react";
import { MessageSquare, Reply, Trash2, Send } from "lucide-react";
import { useStore } from "../../lib/store";
import type { Roi } from "../../lib/types";
import { timeAgo } from "../../lib/format";

const AUTHOR_KEY = "fv.author";
function loadAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) || "You";
  } catch {
    return "You";
  }
}

export default function RoiComments({ roi }: { roi: Roi }) {
  const addComment = useStore((s) => s.addComment);
  const addReply = useStore((s) => s.addReply);
  const removeComment = useStore((s) => s.removeComment);
  const [author, setAuthor] = useState(loadAuthor);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");

  const setAuthorPersist = (v: string) => {
    setAuthor(v);
    try {
      localStorage.setItem(AUTHOR_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    addComment(roi.id, author.trim() || "Anonymous", t);
    setText("");
  };
  const submitReply = (pid: number) => {
    const t = replyText.trim();
    if (!t) return;
    addReply(roi.id, pid, author.trim() || "Anonymous", t);
    setReplyText("");
    setReplyTo(null);
  };

  const total = roi.comments.reduce((a, c) => a + 1 + c.replies.length, 0);

  return (
    <div className="border-t border-white/10 pt-4 lg:border-t-0 lg:pt-0">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cyan-300/80">
        <MessageSquare className="h-4 w-4" /> Comments &amp; annotations <span className="font-normal normal-case text-white/40">({total})</span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={author}
          onChange={(e) => setAuthorPersist(e.target.value)}
          placeholder="Your name"
          aria-label="Author name"
          className="w-32 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-white outline-none ring-1 ring-white/10 focus:ring-cyan-400/40"
        />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={`Add a note on ${roi.label}…`}
          aria-label="New annotation"
          className="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-1.5 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-cyan-400/40"
        />
        <button onClick={submit} disabled={!text.trim()} className="btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs disabled:opacity-50">
          <Send className="h-3.5 w-3.5" /> Post
        </button>
      </div>

      {roi.comments.length === 0 ? (
        <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-white/45 ring-1 ring-white/5">
          No comments yet. Type a note above and press <span className="text-white/70">Post</span> (or Enter) to start a thread on <span className="text-white/70">{roi.label}</span>. Comments are tied to this ROI and saved with the session.
        </p>
      ) : (
        <div className="space-y-2">
          {roi.comments.map((c) => (
            <div key={c.id} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
              <CommentHead author={c.author} ts={c.createdAt} onDelete={() => removeComment(roi.id, c.id)} />
              <p className="mt-1 whitespace-pre-wrap text-sm text-white/80">{c.text}</p>
              <button onClick={() => setReplyTo(replyTo === c.id ? null : c.id)} className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-white/45 transition hover:text-cyan-300">
                <Reply className="h-3 w-3" /> Reply
              </button>
              {c.replies.length > 0 && (
                <div className="mt-2 space-y-2 border-l border-white/10 pl-3">
                  {c.replies.map((rp) => (
                    <div key={rp.id}>
                      <CommentHead author={rp.author} ts={rp.createdAt} onDelete={() => removeComment(roi.id, rp.id)} />
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-white/75">{rp.text}</p>
                    </div>
                  ))}
                </div>
              )}
              {replyTo === c.id && (
                <div className="mt-2 flex gap-2">
                  <input
                    autoFocus
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitReply(c.id);
                    }}
                    placeholder="Reply…"
                    className="min-w-0 flex-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-cyan-400/40"
                  />
                  <button onClick={() => submitReply(c.id)} disabled={!replyText.trim()} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/80 disabled:opacity-50">
                    Reply
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentHead({ author, ts, onDelete }: { author: string; ts: number; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-br from-cyan-400 to-violet-500 text-[9px] font-bold text-ink-950">
        {(author.slice(0, 1) || "?").toUpperCase()}
      </span>
      <span className="text-xs font-semibold text-white/85">{author}</span>
      <span className="text-[10px] text-white/35">{timeAgo(ts)}</span>
      <button onClick={onDelete} className="ml-auto rounded p-0.5 text-white/30 transition hover:text-rose-300" aria-label="Delete annotation">
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
