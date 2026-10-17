import { useEffect, useState } from "react";
import { duplicate, moveTo, schedule, toggleComplete, trash } from "./actions";
import { getBackend } from "./backend";
import { ContextMenu } from "./components/ContextMenu";
import { ConfirmDialog, ConflictDialog, IssueBanner, IssueDialog, PromptDialog, QuickFind, ReadOnlyBanner, SettingsDialog, ShortcutsDialog, Toasts, WriteOptInDialog } from "./components/Dialogs";
import { ChevronIcon, CloudIcon, PlusIcon, SearchIcon } from "./components/Icons";
import { newItemsMenu, taskMenu } from "./components/menus";
import { ListView, selectionTitle } from "./components/ListView";
import { DeadlinePicker, MovePicker, Popover, TagPicker, WhenPicker } from "./components/Pickers";
import { Sidebar } from "./components/Sidebar";
import { TrafficLights } from "./components/WindowControls";
import { useStore, type PickerState } from "./store";
import type { ListId } from "./types";

const LIST_KEYS: ListId[] = ["inbox", "today", "upcoming", "anytime", "someday", "logbook", "trash"];

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function visibleTaskIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".groups [data-task-id]")].map((el) => el.dataset.taskId!);
}

function rowFor(id: string | null): HTMLElement | null {
  return id ? document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`) : null;
}

export function App() {
  const app = useStore((s) => s.app);
  const loadError = useStore((s) => s.loadError);
  const dialog = useStore((s) => s.dialog);
  const selection = useStore((s) => s.selection);
  const view = useStore((s) => s.view);
  const picker = useStore((s) => s.picker);
  const setPicker = useStore((s) => s.openPicker);
  const [scrolled, setScrolled] = useState(false);
  const pickerTask = picker?.taskId ? view?.tasks.find((t) => t.id === picker.taskId) : undefined;

  useEffect(() => {
    void useStore.getState().init();
  }, []);

  useEffect(() => setScrolled(false), [selection]);

  useEffect(() => {
    document.documentElement.classList.toggle("mica", !!app?.settings.mica && !!app?.platform.micaAvailable);
  }, [app?.settings.mica, app?.platform.micaAvailable]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.dialog || s.menu || document.querySelector(".popover-layer")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const task = s.selectedId ? s.view?.tasks.find((t) => t.id === s.selectedId) : undefined;

      if (ctrl && key === "f") return (e.preventDefault(), s.openDialog({ kind: "quickFind" }));
      if (ctrl && key === ",") return (e.preventDefault(), s.openDialog({ kind: "settings" }));
      if (ctrl && (key === "/" || key === "?")) return (e.preventDefault(), s.openDialog({ kind: "shortcuts" }));
      if (ctrl && key === "n") return (e.preventDefault(), window.dispatchEvent(new Event("tings3:new-task")));
      if (e.key === "F5") return (e.preventDefault(), void getBackend().syncNow());
      if (ctrl && !e.shiftKey && /^[1-7]$/.test(e.key)) return (e.preventDefault(), s.select({ kind: "list", id: LIST_KEYS[Number(e.key) - 1] }));
      if (isTyping(e) || s.editingId) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const ids = visibleTaskIds();
        if (!ids.length) return;
        const i = s.selectedId ? ids.indexOf(s.selectedId) : -1;
        const next = e.key === "ArrowDown" ? Math.min(i + 1, ids.length - 1) : Math.max(i - 1, 0);
        s.selectTask(ids[i === -1 ? 0 : next]);
        return;
      }
      if (e.key === "Escape") return s.selectTask(null);
      if (!task) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (task.type === "project") s.select({ kind: "project", id: task.id });
        else s.edit(task.id);
        return;
      }
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const row = rowFor(task.id);
        if (row) s.openMenu(row, taskMenu(task));
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") return (e.preventDefault(), void trash(task, !task.trashed));
      if (ctrl && key === "d" && task.type === "task" && s.canWrite()) return (e.preventDefault(), void duplicate(task));
      if (ctrl && key === "k") return (e.preventDefault(), void toggleComplete(task));
      if (ctrl && !e.shiftKey && key === "t") return (e.preventDefault(), void schedule(task, { kind: "today" }));
      if (ctrl && key === "e") return (e.preventDefault(), void schedule(task, { kind: "evening" }));
      if (ctrl && key === "r") return (e.preventDefault(), void schedule(task, { kind: "anytime" }));
      if (ctrl && key === "o") return (e.preventDefault(), void schedule(task, { kind: "someday" }));
      const open = (kind: PickerState["kind"]) => {
        e.preventDefault();
        s.openPicker({ kind, taskId: task.id, anchor: rowFor(task.id) });
      };
      if (ctrl && key === "s") return open("when");
      if (ctrl && e.shiftKey && key === "m") return open("move");
      if (ctrl && e.shiftKey && key === "d") return open("deadline");
      if (ctrl && e.shiftKey && key === "t") return open("tags");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loadError)
    return (
      <div className="splash">
        <div className="splash-top" data-tauri-drag-region>
          <TrafficLights />
        </div>
        <h1>Tings 3 couldn't start</h1>
        <p className="error-text">{loadError}</p>
        <button className="btn primary" onClick={() => void useStore.getState().init()}>
          Try again
        </button>
      </div>
    );
  if (!app || !view)
    return (
      <div className="splash" aria-busy="true">
        <div className="splash-top" data-tauri-drag-region>
          <TrafficLights />
        </div>
        <div className="spinner" />
        <p>Loading your to-dos…</p>
      </div>
    );

  const writable = app.canWrite;

  return (
    <div className="app">
      <Sidebar />
      <main className="main" onScrollCapture={(e) => (e.target as HTMLElement).classList?.contains("list-view") && setScrolled((e.target as HTMLElement).scrollTop > 44)}>
        <header className={`topbar${scrolled ? " scrolled" : ""}`} data-tauri-drag-region>
          <span className="tb-title" data-tauri-drag-region>
            {app.account.mode !== "signedOut" && selectionTitle(selection, view)}
          </span>
          <span className="grow" data-tauri-drag-region />
          <button className="search-field" onClick={() => useStore.getState().openDialog({ kind: "quickFind" })} aria-label="Quick Find">
            <SearchIcon size={13} />
            <span className="grow">Quick Find</span>
            <kbd>Ctrl F</kbd>
          </button>
          <TrafficLights />
        </header>
        <IssueBanner />
        <ReadOnlyBanner />
        {app.account.mode === "signedOut" ? <SignedOut /> : <ListView />}
        {app.account.mode !== "signedOut" && <AddBubble disabled={!writable} />}
      </main>

      {picker?.kind === "when" && pickerTask && (
        <WhenPicker anchor={picker.anchor} task={pickerTask} onPick={(w, r) => void schedule(pickerTask, w, r)} onClose={() => setPicker(null)} />
      )}
      {picker?.kind === "move" && pickerTask && <MovePicker anchor={picker.anchor} task={pickerTask} onPick={(t) => void moveTo(pickerTask, t)} onClose={() => setPicker(null)} />}
      {picker?.kind === "deadline" && pickerTask && (
        <DeadlinePicker
          anchor={picker.anchor}
          value={pickerTask.deadline}
          onPick={(d) => void useStore.getState().apply({ type: "updateTask", id: pickerTask.id, baseRev: pickerTask.rev, deadline: d })}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === "tags" && pickerTask && (
        <TagPicker
          anchor={picker.anchor}
          value={pickerTask.tagIds}
          onChange={(ids) => void useStore.getState().apply({ type: "updateTask", id: pickerTask.id, baseRev: pickerTask.rev, tagIds: ids })}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === "heading" && (picker.projectId ?? (selection.kind === "project" ? selection.id : null)) && (
        <NewHeading anchor={picker.anchor} projectId={(picker.projectId ?? (selection.kind === "project" ? selection.id : ""))!} onClose={() => setPicker(null)} />
      )}

      {dialog?.kind === "settings" && <SettingsDialog tab={dialog.tab} />}
      {dialog?.kind === "quickFind" && <QuickFind />}
      {dialog?.kind === "writeOptIn" && <WriteOptInDialog />}
      {dialog?.kind === "destructiveOptIn" && <WriteOptInDialog destructive />}
      {dialog?.kind === "conflict" && <ConflictDialog mutation={dialog.mutation} fields={dialog.error.fields ?? []} />}
      {dialog?.kind === "confirm" && <ConfirmDialog {...dialog} />}
      {dialog?.kind === "issue" && <IssueDialog issue={dialog.issue} />}
      {dialog?.kind === "prompt" && <PromptDialog {...dialog} />}
      {dialog?.kind === "shortcuts" && <ShortcutsDialog />}
      <ContextMenu />
      <Toasts />
    </div>
  );
}

/** Floating “new” button in the bottom-left corner. Right-click for more. */
function AddBubble({ disabled }: { disabled: boolean }) {
  const selection = useStore((s) => s.selection);
  const blocked = selection.kind === "list" && (selection.id === "logbook" || selection.id === "trash");
  return (
    <button
      className="add-bubble"
      aria-label="New To-Do"
      title={disabled ? "Read-only" : blocked ? "Pick a list to add to-dos" : "New To-Do (Ctrl+N) — right-click for more"}
      disabled={disabled || blocked}
      onClick={() => window.dispatchEvent(new Event("tings3:new-task"))}
      onContextMenu={(e) => {
        e.preventDefault();
        useStore.getState().openMenu(e, newItemsMenu(selection));
      }}
    >
      <PlusIcon size={20} />
    </button>
  );
}

function NewHeading({ anchor, projectId, onClose }: { anchor: HTMLElement | null; projectId: string; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const create = () => {
    if (title.trim()) void useStore.getState().apply({ type: "createTask", kind: "heading", projectId, title });
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={240}>
      <div className="picker-title">New Heading</div>
      <input className="picker-input" autoFocus value={title} placeholder="Heading" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
    </Popover>
  );
}

function SignedOut() {
  const openDialog = useStore((s) => s.openDialog);
  return (
    <div className="welcome">
      <img className="welcome-icon" src="/app-icon.png" alt="" />
      <h1>Welcome to Tings 3</h1>
      <p className="lead">A calm, Things-style task manager for Windows. Keep your to-dos on this PC, or sync them with Things on your iPhone.</p>
      <div className="card choice-list">
        <button className="choice" onClick={() => openDialog({ kind: "settings", tab: "account" })}>
          <span className="choice-ic" style={{ color: "var(--accent)" }}>
            <CloudIcon size={18} />
          </span>
          <span className="grow">
            <b>Connect Things Cloud</b>
            <span>Sync with Things on your iPhone. Starts read-only.</span>
          </span>
          <ChevronIcon size={13} className="choice-go" />
        </button>
        <button className="choice" onClick={() => void getBackend().useDemo()}>
          <span className="choice-ic" style={{ color: "var(--c-logbook)" }}>
            <PlusIcon size={18} />
          </span>
          <span className="grow">
            <b>Start fresh on this PC</b>
            <span>An empty list stored only on this computer.</span>
          </span>
          <ChevronIcon size={13} className="choice-go" />
        </button>
      </div>
    </div>
  );
}
