// Notes that show formatted (Markdown) until clicked, then edit as text with
// a small formatting bar. Used by the to-do editor and project headers.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getBackend } from "../backend";
import { continueList, Markdown, prefixLines, toggleCheckLine, wrapSelection, type EditResult } from "../lib/markdown";
import { handleLink } from "../links";
import { useStore } from "../store";

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function openNoteLink(url: string) {
  if (url.startsWith("things:")) return void handleLink(url);
  if (/^(https?:\/\/|mailto:)/.test(url)) return void getBackend().openUrl(url).catch(() => useStore.getState().toast("Couldn't open the link.", "error"));
}

const TOOLS: { label: string; title: string; run: (v: string, s: number, e: number) => EditResult; className?: string }[] = [
  { label: "B", title: "Bold (Ctrl+B)", run: (v, s, e) => wrapSelection(v, s, e, "**"), className: "b" },
  { label: "I", title: "Italic (Ctrl+I)", run: (v, s, e) => wrapSelection(v, s, e, "*"), className: "i" },
  { label: "S", title: "Strikethrough (Ctrl+Shift+X)", run: (v, s, e) => wrapSelection(v, s, e, "~~"), className: "s" },
  { label: "H", title: "Heading", run: (v, s, e) => prefixLines(v, s, e, "## ") },
  { label: "•", title: "Bulleted list", run: (v, s, e) => prefixLines(v, s, e, "- ") },
  { label: "1.", title: "Numbered list", run: (v, s, e) => prefixLines(v, s, e, "1. ") },
  { label: "☐", title: "Checklist in notes", run: (v, s, e) => prefixLines(v, s, e, "- [ ] ") },
  { label: "</>", title: "Code (Ctrl+E)", run: (v, s, e) => wrapSelection(v, s, e, "`", "code") },
  {
    label: "Link",
    title: "Link (Ctrl+L)",
    run: (v, s, e) => {
      const sel = v.slice(s, e) || "link";
      const ins = `[${sel}](https://)`;
      const at = s + ins.length - 1; // caret inside the parentheses, after https://
      return { value: v.slice(0, s) + ins + v.slice(e), start: at, end: at };
    },
  },
];

export function NotesField({
  value,
  onChange,
  onCommit,
  readOnly,
  className,
  placeholder = "Notes",
  label = "Notes",
}: {
  value: string;
  onChange: (v: string) => void;
  /** Save now (blur, or a checkbox clicked in the formatted view). */
  onCommit: (v: string) => void;
  readOnly?: boolean;
  className?: string;
  placeholder?: string;
  label?: string;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingSel = useRef<[number, number] | null>(null);
  const pointerDown = useRef(false);
  const showText = !readOnly && (editing || !value.trim());

  useLayoutEffect(() => {
    autosize(ref.current);
    if (pendingSel.current && ref.current) {
      ref.current.setSelectionRange(...pendingSel.current);
      pendingSel.current = null;
    }
  });

  useEffect(() => {
    if (editing && ref.current && document.activeElement !== ref.current) {
      ref.current.focus();
      const end = ref.current.value.length;
      ref.current.setSelectionRange(end, end);
    }
  }, [editing]);

  const apply = (r: EditResult) => {
    pendingSel.current = [r.start, r.end];
    onChange(r.value);
  };
  const tool = (run: (v: string, s: number, e: number) => EditResult) => {
    const el = ref.current;
    if (!el) return;
    apply(run(el.value, el.selectionStart, el.selectionEnd));
  };

  if (!showText) {
    if (!value.trim()) return null;
    return (
      <div
        className={`notes-rendered md ${className ?? ""}`}
        tabIndex={readOnly ? undefined : 0}
        role={readOnly ? undefined : "button"}
        aria-label={readOnly ? label : `${label} — click to edit`}
        // Tabbing in starts editing; with the mouse, the click decides (links and
        // checkboxes inside shouldn't switch to the text).
        onMouseDown={() => (pointerDown.current = true)}
        onFocus={(e) => {
          const byPointer = pointerDown.current;
          pointerDown.current = false;
          if (!readOnly && !byPointer && e.target === e.currentTarget) setEditing(true);
        }}
        onClick={(e) => {
          pointerDown.current = false;
          if (readOnly || (e.target as HTMLElement).closest("a, button")) return;
          // Let the user select text without switching to editing.
          if (window.getSelection()?.toString()) return;
          setEditing(true);
        }}
      >
        <Markdown text={value} onLink={openNoteLink} onToggle={readOnly ? undefined : (line) => onCommit(toggleCheckLine(value, line))} />
      </div>
    );
  }

  return (
    <div className={`notes-edit ${className ?? ""}`}>
      <textarea
        ref={ref}
        className="notes-input"
        placeholder={placeholder}
        value={value}
        rows={1}
        aria-label={label}
        onFocus={() => setEditing(true)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          // Clicking the format bar keeps editing.
          if ((e.relatedTarget as HTMLElement | null)?.closest(".notes-tools")) return;
          setEditing(false);
          onCommit(e.target.value);
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          const ctrl = e.ctrlKey || e.metaKey;
          const k = e.key.toLowerCase();
          if (ctrl && !e.shiftKey && k === "b") return (e.preventDefault(), e.stopPropagation(), tool(TOOLS[0].run));
          if (ctrl && !e.shiftKey && k === "i") return (e.preventDefault(), e.stopPropagation(), tool(TOOLS[1].run));
          if (ctrl && e.shiftKey && k === "x") return (e.preventDefault(), e.stopPropagation(), tool(TOOLS[2].run));
          if (ctrl && !e.shiftKey && k === "e") return (e.preventDefault(), e.stopPropagation(), tool(TOOLS[7].run));
          if (ctrl && !e.shiftKey && k === "l") return (e.preventDefault(), e.stopPropagation(), tool(TOOLS[8].run));
          if (e.key === "Enter" && !e.shiftKey && !ctrl && el.selectionStart === el.selectionEnd) {
            const r = continueList(el.value, el.selectionStart);
            if (r) {
              e.preventDefault();
              apply(r);
            }
          }
        }}
      />
      {editing && (
        <div className="notes-tools" role="toolbar" aria-label="Formatting">
          {TOOLS.map((t) => (
            <button key={t.title} type="button" className={`nt-btn ${t.className ?? ""}`} title={t.title} aria-label={t.title} onMouseDown={(e) => e.preventDefault()} onClick={() => tool(t.run)}>
              {t.label}
            </button>
          ))}
          <span className="nt-hint">Markdown · shows formatted when you click away</span>
        </div>
      )}
    </div>
  );
}
