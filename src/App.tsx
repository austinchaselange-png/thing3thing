import { useEffect, useState } from "react";
import { moveTo, schedule, toggleComplete, trash } from "./actions";
import { getBackend } from "./backend";
import { ConfirmDialog, ConflictDialog, IssueBanner, IssueDialog, QuickFind, ReadOnlyBanner, SettingsDialog, Toasts, WriteOptInDialog } from "./components/Dialogs";
import { ArrowRightIcon, CalendarIcon, HeadingIcon, PlusIcon, SearchIcon, TrashIcon } from "./components/Icons";
import { ListView } from "./components/ListView";
import { DeadlinePicker, MovePicker, Popover, TagPicker, WhenPicker } from "./components/Pickers";
import { Sidebar } from "./components/Sidebar";
import { useStore } from "./store";
import type { ListId, Task } from "./types";

type KbPicker = { kind: "when" | "move" | "deadline" | "tags" | "heading"; taskId: string | null; anchor: HTMLElement | null } | null;

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
  const selectedId = useStore((s) => s.selectedId);
  const view = useStore((s) => s.view);
  const [picker, setPicker] = useState<KbPicker>(null);
  const selected: Task | undefined = selectedId ? view?.tasks.find((t) => t.id === selectedId) : undefined;
  const pickerTask = picker?.taskId ? view?.tasks.find((t) => t.id === picker.taskId) : undefined;

  useEffect(() => {
    void useStore.getState().init();
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("mica", !!app?.settings.mica && !!app?.platform.micaAvailable);
  }, [app?.settings.mica, app?.platform.micaAvailable]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.dialog || document.querySelector(".popover-layer")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const task = s.selectedId ? s.view?.tasks.find((t) => t.id === s.selectedId) : undefined;

      if (ctrl && key === "f") return (e.preventDefault(), s.openDialog({ kind: "quickFind" }));
      if (ctrl && key === ",") return (e.preventDefault(), s.openDialog({ kind: "settings" }));
      if (ctrl && key === "n") return (e.preventDefault(), window.dispatchEvent(new Event("cairn:new-task")));
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
      if (e.key === "Delete" || e.key === "Backspace") return (e.preventDefault(), void trash(task, !task.trashed));
      if (ctrl && key === "k") return (e.preventDefault(), void toggleComplete(task));
      if (ctrl && !e.shiftKey && key === "t") return (e.preventDefault(), void schedule(task, { kind: "today" }));
      if (ctrl && key === "e") return (e.preventDefault(), void schedule(task, { kind: "evening" }));
      if (ctrl && key === "r") return (e.preventDefault(), void schedule(task, { kind: "anytime" }));
      if (ctrl && key === "o") return (e.preventDefault(), void schedule(task, { kind: "someday" }));
      const open = (kind: NonNullable<KbPicker>["kind"]) => {
        e.preventDefault();
        setPicker({ kind, taskId: task.id, anchor: rowFor(task.id) });
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
        <h1>Cairn couldn't start</h1>
        <p className="error-text">{loadError}</p>
        <button className="btn primary" onClick={() => void useStore.getState().init()}>
          Try again
        </button>
      </div>
    );
  if (!app || !view)
    return (
      <div className="splash" aria-busy="true">
        <div className="spinner" />
        <p>Loading your to-dos…</p>
      </div>
    );

  const writable = app.policy.writes;
  const inProject = selection.kind === "project";

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <IssueBanner />
        <ReadOnlyBanner />
        {app.account.mode === "signedOut" ? <SignedOut /> : <ListView />}
        <footer className="toolbar" role="toolbar" aria-label="Actions">
          <button className="tool" title="New To-Do (Ctrl+N)" aria-label="New To-Do" disabled={!writable} onClick={() => window.dispatchEvent(new Event("cairn:new-task"))}>
            <PlusIcon />
          </button>
          {inProject && (
            <button className="tool" title="New Heading" aria-label="New Heading" disabled={!writable} onClick={(e) => setPicker({ kind: "heading", taskId: null, anchor: e.currentTarget })}>
              <HeadingIcon />
            </button>
          )}
          <button className="tool" title="When (Ctrl+S)" aria-label="When" disabled={!writable || !selected} onClick={(e) => selected && setPicker({ kind: "when", taskId: selected.id, anchor: e.currentTarget })}>
            <CalendarIcon />
          </button>
          <button className="tool" title="Move (Ctrl+Shift+M)" aria-label="Move" disabled={!writable || !selected} onClick={(e) => selected && setPicker({ kind: "move", taskId: selected.id, anchor: e.currentTarget })}>
            <ArrowRightIcon />
          </button>
          {selected?.trashed ? (
            <button className="tool text" disabled={!writable} onClick={() => void trash(selected, false)}>
              Restore
            </button>
          ) : (
            <button className="tool" title="Move to Trash (Delete)" aria-label="Move to Trash" disabled={!writable || !selected} onClick={() => selected && void trash(selected)}>
              <TrashIcon />
            </button>
          )}
          <span className="grow" />
          <button className="tool" title="Quick Find (Ctrl+F)" aria-label="Quick Find" onClick={() => useStore.getState().openDialog({ kind: "quickFind" })}>
            <SearchIcon />
          </button>
        </footer>
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
      {picker?.kind === "heading" && selection.kind === "project" && <NewHeading anchor={picker.anchor} projectId={selection.id} onClose={() => setPicker(null)} />}

      {dialog?.kind === "settings" && <SettingsDialog tab={dialog.tab} />}
      {dialog?.kind === "quickFind" && <QuickFind />}
      {dialog?.kind === "writeOptIn" && <WriteOptInDialog />}
      {dialog?.kind === "destructiveOptIn" && <WriteOptInDialog destructive />}
      {dialog?.kind === "conflict" && <ConflictDialog mutation={dialog.mutation} fields={dialog.error.fields ?? []} />}
      {dialog?.kind === "confirm" && <ConfirmDialog {...dialog} />}
      {dialog?.kind === "issue" && <IssueDialog issue={dialog.issue} />}
      <Toasts />
    </div>
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
      <h1>Welcome to Cairn</h1>
      <p>A Things-style task manager for Windows that syncs with Things on your iPhone through Things Cloud.</p>
      <div className="welcome-actions">
        <button className="btn primary" onClick={() => openDialog({ kind: "settings", tab: "account" })}>
          Connect Things Cloud
        </button>
        <button className="btn" onClick={() => void getBackend().useDemo()}>
          Explore with demo data
        </button>
      </div>
    </div>
  );
}
