import { useEffect, useState } from "react";
import { bulkDeadline, bulkDuplicate, bulkMove, bulkSchedule, bulkSetStatus, bulkTags, bulkTrash, commonTags, deletePermanently, pasteAsTodos } from "./actions";
import { getBackend } from "./backend";
import { ContextMenu } from "./components/ContextMenu";
import { ConfirmDialog, ConflictDialog, IssueBanner, IssueDialog, PromptDialog, QuickFind, ReadOnlyBanner, SettingsDialog, ShortcutsDialog, SyncErrorBanner, Toasts, WriteOptInDialog } from "./components/Dialogs";
import { ArrowRightIcon, CalendarIcon, ChevronIcon, CloudIcon, MoreIcon, PlusIcon, SearchIcon, TrashIcon, UndoIcon } from "./components/Icons";
import { bulkMenu, bulkMoreMenu, newItemsMenu, taskMenu } from "./components/menus";
import { ListView, selectionTitle } from "./components/ListView";
import { DeadlinePicker, MovePicker, Popover, TagPicker, WhenPicker } from "./components/Pickers";
import { Sidebar } from "./components/Sidebar";
import { TrafficLights } from "./components/WindowControls";
import { selectedTasks, useMulti, useStore, type PickerState } from "./store";
import type { ListId, Task } from "./types";

const LIST_KEYS: ListId[] = ["inbox", "today", "upcoming", "anytime", "someday", "logbook", "trash"];

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function visibleTaskIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".groups .task-row[data-task-id]")].map((el) => el.dataset.taskId!);
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
  // A picker acts on one to-do, or on every selected one.
  const pickerTasks: Task[] = view && picker ? (picker.taskIds ?? (picker.taskId ? [picker.taskId] : [])).map((id) => view.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t) : [];
  const pickerTask = pickerTasks[0];
  const sameDeadline = pickerTasks.every((t) => t.deadline === pickerTask?.deadline) ? (pickerTask?.deadline ?? null) : null;
  const pickerTags = commonTags(pickerTasks);

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
      // Shortcuts act on every selected to-do.
      const targets = selectedTasks();

      if (ctrl && key === "f") return (e.preventDefault(), s.openDialog({ kind: "quickFind" }));
      if (ctrl && key === ",") return (e.preventDefault(), s.openDialog({ kind: "settings" }));
      if (ctrl && (key === "/" || key === "?")) return (e.preventDefault(), s.openDialog({ kind: "shortcuts" }));
      if (ctrl && key === "n") return (e.preventDefault(), window.dispatchEvent(new Event("tings3:new-task")));
      if (e.key === "F5") return (e.preventDefault(), void getBackend().syncNow());
      if (ctrl && !e.shiftKey && /^[1-7]$/.test(e.key)) return (e.preventDefault(), s.select({ kind: "list", id: LIST_KEYS[Number(e.key) - 1] }));
      if (isTyping(e) || s.editingId) return;

      if (ctrl && key === "v" && !e.shiftKey) {
        const sel = s.selection;
        if (sel.kind === "list" && (sel.id === "logbook" || sel.id === "trash" || sel.id === "upcoming")) return;
        e.preventDefault();
        return void pasteAsTodos(sel);
      }
      if (ctrl && key === "a") {
        e.preventDefault();
        const ids = visibleTaskIds();
        if (ids.length) s.setSelected(ids, s.selectedId && ids.includes(s.selectedId) ? s.selectedId : ids[0]);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const ids = visibleTaskIds();
        if (!ids.length) return;
        const i = s.selectedId ? ids.indexOf(s.selectedId) : -1;
        const next = ids[i === -1 ? 0 : e.key === "ArrowDown" ? Math.min(i + 1, ids.length - 1) : Math.max(i - 1, 0)];
        if (e.shiftKey && s.anchorId && ids.includes(s.anchorId)) {
          const a = ids.indexOf(s.anchorId);
          const b = ids.indexOf(next);
          s.setSelected(ids.slice(Math.min(a, b), Math.max(a, b) + 1), next);
        } else if (s.selectMode) {
          useStore.setState({ selectedId: next });
        } else {
          s.selectTask(next);
        }
        return;
      }
      if (e.key === "Escape") return s.selectMode ? s.setSelectMode(false) : s.selectTask(null);
      if (s.selectMode && e.key === " " && task) return (e.preventDefault(), s.toggleSelected(task.id));
      if (targets.length > 1 || (s.selectMode && targets.length)) {
        const anchor = rowFor(s.selectedId) ?? rowFor(targets[0].id);
        const openMany = (kind: PickerState["kind"]) => {
          e.preventDefault();
          s.openPicker({ kind, taskId: targets[0].id, taskIds: targets.map((t) => t.id), anchor });
        };
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) return (e.preventDefault(), anchor && s.openMenu(anchor, bulkMenu(targets, anchor)));
        if (e.key === "Delete" || e.key === "Backspace") return (e.preventDefault(), void bulkTrash(targets));
        if (ctrl && key === "d") return (e.preventDefault(), void bulkDuplicate(targets));
        if (ctrl && key === "k") return (e.preventDefault(), void bulkSetStatus(targets, targets.some((t) => t.status === "open") ? "completed" : "open"));
        if (ctrl && !e.shiftKey && key === "t") return (e.preventDefault(), void bulkSchedule(targets, { kind: "today" }));
        if (ctrl && key === "e") return (e.preventDefault(), void bulkSchedule(targets, { kind: "evening" }));
        if (ctrl && key === "r") return (e.preventDefault(), void bulkSchedule(targets, { kind: "anytime" }));
        if (ctrl && key === "o") return (e.preventDefault(), void bulkSchedule(targets, { kind: "someday" }));
        if (ctrl && key === "s") return openMany("when");
        if (ctrl && e.shiftKey && key === "m") return openMany("move");
        if (ctrl && e.shiftKey && key === "d") return openMany("deadline");
        if (ctrl && e.shiftKey && key === "t") return openMany("tags");
        return;
      }
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
      if (e.key === "Delete" || e.key === "Backspace") return (e.preventDefault(), void bulkTrash([task]));
      if (ctrl && key === "d" && task.type === "task" && s.canWrite()) return (e.preventDefault(), void bulkDuplicate([task]));
      if (ctrl && key === "k") return (e.preventDefault(), void bulkSetStatus([task], task.status === "open" ? "completed" : "open"));
      if (ctrl && !e.shiftKey && key === "t") return (e.preventDefault(), void bulkSchedule([task], { kind: "today" }));
      if (ctrl && key === "e") return (e.preventDefault(), void bulkSchedule([task], { kind: "evening" }));
      if (ctrl && key === "r") return (e.preventDefault(), void bulkSchedule([task], { kind: "anytime" }));
      if (ctrl && key === "o") return (e.preventDefault(), void bulkSchedule([task], { kind: "someday" }));
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
        <h1>Things 3 couldn't start</h1>
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
        <SyncErrorBanner />
        <IssueBanner />
        <ReadOnlyBanner />
        {app.account.mode === "signedOut" ? <SignedOut /> : <ListView />}
        {app.account.mode !== "signedOut" && <AddBubble disabled={!writable} />}
        {app.account.mode !== "signedOut" && <SelectionBar />}
      </main>

      {picker?.kind === "when" && pickerTask && (
        <WhenPicker
          anchor={picker.anchor}
          task={pickerTasks.length === 1 ? pickerTask : undefined}
          onPick={(w, r) => void bulkSchedule(pickerTasks, w, r)}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === "move" && pickerTask && (
        <MovePicker anchor={picker.anchor} task={pickerTasks.find((t) => t.type === "task") ?? pickerTask} onPick={(t) => void bulkMove(pickerTasks, t)} onClose={() => setPicker(null)} />
      )}
      {picker?.kind === "deadline" && pickerTask && (
        <DeadlinePicker anchor={picker.anchor} value={sameDeadline} onPick={(d) => void bulkDeadline(pickerTasks, d)} onClose={() => setPicker(null)} />
      )}
      {picker?.kind === "tags" && pickerTask && (
        <TagPicker
          anchor={picker.anchor}
          value={pickerTags}
          onChange={(ids) => void bulkTags(pickerTasks, ids.filter((id) => !pickerTags.includes(id)), pickerTags.filter((id) => !ids.includes(id)))}
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

/** Things' bottom bar while several to-dos are selected: When, Move, Delete, •••. */
function SelectionBar() {
  const multi = useMulti();
  const count = useStore((s) => s.selectedIds.length);
  const writable = useStore((s) => !!s.app?.canWrite);
  const inTrash = useStore((s) => s.selection.kind === "list" && s.selection.id === "trash");
  if (!multi) return null;
  const tasks = () => selectedTasks();
  const open = (kind: PickerState["kind"]) => (e: React.MouseEvent<HTMLElement>) => {
    const ts = tasks();
    if (ts.length) useStore.getState().openPicker({ kind, taskId: ts[0].id, taskIds: ts.map((t) => t.id), anchor: e.currentTarget });
  };
  const none = count === 0;
  if (inTrash)
    return (
      <div className="selection-bar" role="toolbar" aria-label="Selected to-dos">
        <span className="sel-count">{none ? "Select to-dos" : `${count} selected`}</span>
        <button className="sb-btn" disabled={none || !writable} onClick={() => void bulkTrash(tasks(), false)}>
          <UndoIcon size={15} /> Put Back
        </button>
        <button className="sb-btn danger" disabled={none || !writable} onClick={() => deletePermanently(tasks())}>
          <TrashIcon size={15} /> Delete
        </button>
      </div>
    );
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected to-dos">
      <span className="sel-count">{none ? "Select to-dos" : `${count} selected`}</span>
      <button className="sb-btn" disabled={none || !writable} onClick={open("when")}>
        <CalendarIcon size={15} /> When
      </button>
      <button className="sb-btn" disabled={none || !writable} onClick={open("move")}>
        <ArrowRightIcon size={15} /> Move
      </button>
      <button className="sb-btn" disabled={none || !writable} onClick={() => void bulkTrash(tasks())}>
        <TrashIcon size={15} /> Delete
      </button>
      <button className="sb-btn icon" aria-label="More" disabled={none} onClick={(e) => useStore.getState().openMenu(e.currentTarget, bulkMoreMenu(tasks(), e.currentTarget))}>
        <MoreIcon size={16} />
      </button>
    </div>
  );
}

/** Floating “new” button in the bottom-left corner. Right-click for more. */
function AddBubble({ disabled }: { disabled: boolean }) {
  const selection = useStore((s) => s.selection);
  const multi = useMulti();
  const blocked = selection.kind === "list" && (selection.id === "logbook" || selection.id === "trash");
  if (multi) return null;
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
      <h1>Welcome to Things 3</h1>
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
