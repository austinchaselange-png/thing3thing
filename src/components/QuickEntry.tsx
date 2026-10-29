import { useEffect, useRef, useState } from "react";
import { getBackend } from "../backend";
import { relativeLabel, todayYmd } from "../lib/dates";
import { parseQuickEntry } from "../lib/quickParse";
import { isWriteError } from "../store";
import type { AppState, When } from "../types";
import { BellIcon, BoxIcon, CalendarIcon, FlagIcon, InboxIcon, LockIcon, MoonIcon, StarIcon, TagIcon } from "./Icons";

function whenText(w: When | null, today: string) {
  if (!w) return { icon: <InboxIcon size={12} style={{ color: "var(--c-inbox)" }} />, text: "Inbox" };
  switch (w.kind) {
    case "today":
      return { icon: <StarIcon size={12} style={{ color: "var(--c-today)" }} />, text: "Today" };
    case "evening":
      return { icon: <MoonIcon size={12} style={{ color: "var(--c-evening)" }} />, text: "This Evening" };
    case "someday":
      return { icon: <BoxIcon size={12} style={{ color: "var(--c-someday)" }} />, text: "Someday" };
    case "anytime":
      return { icon: <InboxIcon size={12} />, text: "Anytime" };
    case "inbox":
      return { icon: <InboxIcon size={12} style={{ color: "var(--c-inbox)" }} />, text: "Inbox" };
    case "date":
      return { icon: <CalendarIcon size={12} style={{ color: "var(--c-upcoming)" }} />, text: relativeLabel(w.date, today) };
  }
}

/** The small always-on-top window opened by the global shortcut. */
export function QuickEntryApp() {
  const backend = getBackend();
  const [app, setApp] = useState<AppState | null>(null);
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const today = todayYmd();

  useEffect(() => {
    void backend.getState().then(setApp);
    const un = backend.subscribe(setApp);
    const focus = () => {
      setError(null);
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("focus", focus);
    focus();
    return () => {
      un();
      window.removeEventListener("focus", focus);
    };
  }, [backend]);

  const tags = app?.snapshot.tags ?? [];
  const parsed = parseQuickEntry(text, tags, today);
  const writable = !!app?.canWrite && app.account.mode !== "signedOut";

  /** Hides the window. The draft stays (like clicking away) unless it was just saved. */
  const hide = (clear = false) => {
    if (clear) {
      setText("");
      setNotes("");
    }
    setError(null);
    void backend.hideQuickEntry();
  };

  const save = async () => {
    if (!parsed.title || saving) return;
    setSaving(true);
    try {
      await backend.apply({ type: "createTask", title: parsed.title, notes, when: parsed.when, deadline: parsed.deadline, reminder: parsed.reminder, tagIds: parsed.tagIds });
      hide(true);
    } catch (e) {
      setError(isWriteError(e) ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const w = whenText(parsed.when, today);
  return (
    <div
      className="quick-entry-card"
      onKeyDown={(e) => {
        // Escape hides and keeps the draft; Shift+Escape throws it away.
        if (e.key === "Escape") hide(e.shiftKey);
        if (e.key === "Enter" && (e.ctrlKey || (e.target as HTMLElement).tagName === "INPUT")) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="qe-row">
        <span className="checkbox" aria-hidden="true" />
        <input ref={inputRef} className="qe-title" placeholder="New To-Do" value={text} onChange={(e) => setText(e.target.value)} aria-label="New to-do" disabled={!writable} />
      </div>
      <textarea className="qe-notes" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} disabled={!writable} />
      <div className="qe-foot">
        <span className="chip">
          {w.icon} {w.text}
          {parsed.reminder && (
            <>
              {" "}
              · <BellIcon size={11} /> {parsed.reminder}
            </>
          )}
        </span>
        {parsed.deadline && (
          <span className="chip deadline-chip">
            <FlagIcon size={11} /> {relativeLabel(parsed.deadline, today)}
          </span>
        )}
        {parsed.tagIds.map((id) => (
          <span key={id} className="chip">
            <TagIcon size={11} /> {tags.find((t) => t.id === id)?.title}
          </span>
        ))}
        {parsed.unknownTags.map((n) => (
          <span key={n} className="chip warn" title="No tag with this name">
            #{n}?
          </span>
        ))}
        <span className="grow" />
        {!writable ? (
          <span className="qe-ro">
            <LockIcon size={11} /> Read-only
          </span>
        ) : (
          <button className="btn primary small" disabled={!parsed.title || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {error && <div className="qe-error">{error}</div>}
    </div>
  );
}
