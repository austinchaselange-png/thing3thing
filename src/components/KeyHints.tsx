// Hold Ctrl to see the most useful shortcuts, like holding ⌘ in Things for Mac.
import { useEffect, useState } from "react";

const HINTS: [string, string][] = [
  ["Ctrl N", "New to-do"],
  ["Space", "New to-do below"],
  ["Ctrl K", "Complete"],
  ["Ctrl T", "Today"],
  ["Ctrl E", "This Evening"],
  ["Ctrl S", "When…"],
  ["Ctrl ⇧ D", "Deadline…"],
  ["Ctrl ⇧ T", "Tags…"],
  ["Ctrl ⇧ M", "Move…"],
  ["Ctrl ↑ ↓", "Move up / down"],
  ["Ctrl D", "Duplicate"],
  ["Ctrl Z", "Undo"],
  ["Ctrl F", "Quick Find"],
  ["Ctrl 1…7", "Inbox … Trash"],
  ["Alt + key", "Tag shortcut"],
  ["Ctrl /", "All shortcuts"],
];

export function KeyHints() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const cancel = () => {
      window.clearTimeout(timer);
      timer = undefined;
      setShown(false);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Control" && !e.repeat && !e.shiftKey && !e.altKey) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setShown(true), 700);
      } else if (e.key !== "Control") {
        cancel();
      }
    };
    const up = (e: KeyboardEvent) => e.key === "Control" && cancel();
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("pointerdown", cancel, true);
    return () => {
      cancel();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointerdown", cancel, true);
    };
  }, []);
  if (!shown) return null;
  return (
    <div className="key-hints" role="tooltip" aria-label="Keyboard shortcuts">
      {HINTS.map(([k, label]) => (
        <div key={k} className="kh-row">
          <kbd>{k}</kbd>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
