import { create } from "zustand";
import { getBackend } from "./backend";
import { applyMutation } from "./lib/applyMutation";
import type { AppState, Issue, Mutation, Selection, Snapshot, Task, WriteError, WriteReport } from "./types";

export type Dialog =
  | { kind: "settings"; tab?: "account" | "sync" | "general" | "about" }
  | { kind: "quickFind" }
  | { kind: "conflict"; mutation: Mutation; error: WriteError }
  | { kind: "confirm"; title: string; body: string; mutation: Mutation; phrase: boolean }
  | { kind: "issue"; issue: Issue }
  | { kind: "writeOptIn" }
  | { kind: "destructiveOptIn" }
  | { kind: "move"; taskId: string }
  | { kind: "newList" }
  | { kind: "shortcuts" }
  | { kind: "prompt"; title: string; label: string; initial: string; confirmLabel: string; onSubmit: (value: string) => void };

/** One entry in a right-click menu. */
export type MenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      icon?: import("react").ReactNode;
      shortcut?: string;
      onSelect?: () => void;
      disabled?: boolean;
      /** Shown as a tooltip, e.g. why an item is disabled. */
      hint?: string;
      danger?: boolean;
      checked?: boolean;
      submenu?: MenuItem[];
    };

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** A picker popover opened from a menu, a row button or a shortcut. */
export interface PickerState {
  kind: "when" | "move" | "deadline" | "tags" | "heading";
  taskId: string | null;
  /** Several to-dos at once (multi-selection). Takes precedence over taskId. */
  taskIds?: string[];
  anchor: HTMLElement | null;
  /** For "heading": the project to add it to. */
  projectId?: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "success";
  action?: { label: string; run: () => void };
}

interface Pending {
  id: number;
  mutation: Mutation;
}

interface Store {
  app: AppState | null;
  loadError: string | null;
  /** Snapshot with in-flight edits applied optimistically. */
  view: Snapshot | null;
  pending: Pending[];
  selection: Selection;
  /** The focused row: last clicked, target of the keyboard. */
  selectedId: string | null;
  /** Every selected row, in click order. Contains selectedId when it is set. */
  selectedIds: string[];
  /** Where a Shift-click range starts. */
  anchorId: string | null;
  /** "Select" mode from the ••• menu: clicks toggle rows, the bulk bar stays up. */
  selectMode: boolean;
  editingId: string | null;
  /** Completed in this visit to the list; stay visible (checked) like Things. */
  recentlyCompleted: string[];
  tagFilter: string | null;
  dialog: Dialog | null;
  toasts: Toast[];
  menu: ContextMenuState | null;
  picker: PickerState | null;
  /** Opens a context menu at the pointer (or at an element for keyboard use). */
  openMenu(at: { clientX: number; clientY: number } | HTMLElement, items: MenuItem[]): void;
  closeMenu(): void;
  openPicker(p: PickerState | null): void;
  init(): Promise<void>;
  setApp(app: AppState): void;
  select(sel: Selection): void;
  selectTask(id: string | null): void;
  /** Ctrl-click: adds or removes one row. */
  toggleSelected(id: string): void;
  /** Replaces the multi-selection, e.g. Shift-click ranges or Ctrl+A. */
  setSelected(ids: string[], focus?: string | null): void;
  setSelectMode(on: boolean): void;
  edit(id: string | null): void;
  setTagFilter(id: string | null): void;
  openDialog(d: Dialog | null): void;
  toast(text: string, tone?: Toast["tone"], action?: Toast["action"]): void;
  dismissToast(id: number): void;
  apply(m: Mutation, opts?: { force?: boolean; quiet?: boolean }): Promise<WriteReport | null>;
  canWrite(): boolean;
}

let seq = 0;

function computeView(app: AppState | null, pending: Pending[]): Snapshot | null {
  if (!app) return null;
  let snap = app.snapshot;
  for (const p of pending) {
    try {
      snap = applyMutation(snap, p.mutation, { rev: snap.serverIndex }).snapshot;
    } catch {
      /* the backend will report the error */
    }
  }
  return snap;
}

export function isWriteError(e: unknown): e is WriteError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export const useStore = create<Store>((set, get) => ({
  app: null,
  loadError: null,
  view: null,
  pending: [],
  selection: { kind: "list", id: "today" },
  selectedId: null,
  selectedIds: [],
  anchorId: null,
  selectMode: false,
  editingId: null,
  recentlyCompleted: [],
  tagFilter: null,
  dialog: null,
  toasts: [],
  menu: null,
  picker: null,

  openMenu(at, items) {
    if (!items.length) return;
    let x: number;
    let y: number;
    if (at instanceof HTMLElement) {
      const r = at.getBoundingClientRect();
      x = r.left + Math.min(48, r.width / 2);
      y = r.top + Math.min(r.height, 28);
    } else {
      x = at.clientX;
      y = at.clientY;
    }
    set({ menu: { x, y, items } });
  },

  closeMenu() {
    set({ menu: null });
  },

  openPicker(picker) {
    set({ picker, menu: null });
  },

  async init() {
    const backend = getBackend();
    backend.subscribe((app) => get().setApp(app));
    try {
      get().setApp(await backend.getState());
    } catch (e) {
      set({ loadError: isWriteError(e) ? e.message : String(e) });
    }
  },

  setApp(app) {
    set((s) => ({ app, view: computeView(app, s.pending), loadError: null }));
  },

  select(selection) {
    set({ selection, selectedId: null, selectedIds: [], anchorId: null, selectMode: false, editingId: null, recentlyCompleted: [], tagFilter: null });
  },

  selectTask(id) {
    set((s) => ({ selectedId: id, selectedIds: id ? [id] : [], anchorId: id, editingId: s.editingId && s.editingId !== id ? null : s.editingId }));
  },

  toggleSelected(id) {
    set((s) => {
      const has = s.selectedIds.includes(id);
      const selectedIds = has ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id];
      return { selectedIds, selectedId: has ? (selectedIds.at(-1) ?? null) : id, anchorId: id, editingId: null };
    });
  },

  setSelected(ids, focus) {
    set((s) => ({ selectedIds: ids, selectedId: focus === undefined ? (ids.at(-1) ?? null) : focus, anchorId: s.anchorId ?? ids[0] ?? null, editingId: null }));
  },

  setSelectMode(selectMode) {
    set({ selectMode, editingId: null, ...(selectMode ? {} : { selectedIds: [], selectedId: null, anchorId: null }) });
  },

  edit(id) {
    set((s) => ({ editingId: id, selectedId: id ?? s.selectedId, selectedIds: id ? [id] : s.selectedIds, anchorId: id ?? s.anchorId, selectMode: id ? false : s.selectMode }));
  },

  setTagFilter(tagFilter) {
    set({ tagFilter });
  },

  openDialog(dialog) {
    set({ dialog });
  },

  toast(text, tone = "info", action) {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone, action }] }));
    setTimeout(() => get().dismissToast(id), tone === "error" ? 8000 : 4000);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  canWrite() {
    const app = get().app;
    return !!app && app.account.mode !== "signedOut" && app.canWrite;
  },

  async apply(mutation, opts = {}) {
    const { app } = get();
    if (!app) return null;
    if (app.policy.writes && !app.canWrite) {
      get().toast("This account uses a newer Things data format, so changes are turned off.", "info", { label: "Details…", run: () => get().openDialog({ kind: "settings", tab: "sync" }) });
      return null;
    }
    if (!app.policy.writes) {
      get().toast("Things 3 is read-only for this account.", "info", { label: "Enable writes…", run: () => get().openDialog({ kind: "writeOptIn" }) });
      return null;
    }
    const pending: Pending = { id: ++seq, mutation };
    if (mutation.type === "setStatus" && mutation.status !== "open") {
      set((s) => ({ recentlyCompleted: [...s.recentlyCompleted, mutation.id] }));
    }
    set((s) => {
      const list = [...s.pending, pending];
      return { pending: list, view: computeView(s.app, list) };
    });
    const done = () =>
      set((s) => {
        const list = s.pending.filter((p) => p.id !== pending.id);
        return { pending: list, view: computeView(s.app, list) };
      });
    try {
      const report = await getBackend().apply(mutation, { force: opts.force });
      done();
      if (report.reconciled) get().toast("The connection dropped, but Things 3 confirmed the change was saved.", "success");
      return report;
    } catch (e) {
      done();
      if (mutation.type === "setStatus") set((s) => ({ recentlyCompleted: s.recentlyCompleted.filter((id) => id !== mutation.id) }));
      handleWriteError(mutation, e);
      return null;
    }
  },
}));

function handleWriteError(mutation: Mutation, e: unknown) {
  const s = useStore.getState();
  if (!isWriteError(e)) {
    s.toast(String(e), "error");
    return;
  }
  switch (e.code) {
    case "conflict":
      s.openDialog({ kind: "conflict", mutation, error: e });
      break;
    case "readOnly":
      s.toast(e.message, "info", { label: "Enable writes…", run: () => s.openDialog({ kind: "writeOptIn" }) });
      break;
    case "destructiveDisabled":
      s.toast(e.message, "info", { label: "Settings…", run: () => s.openDialog({ kind: "settings", tab: "sync" }) });
      break;
    case "blocked":
    case "uncertain": {
      const issue = s.app?.issues.find((i) => i.id === e.journalId);
      s.toast(e.message, "error", issue ? { label: "Review", run: () => s.openDialog({ kind: "issue", issue }) } : undefined);
      break;
    }
    default:
      s.toast(e.message, "error");
  }
}

/** Convenience: current task by id from the optimistic view. */
export function useTask(id: string | null): Task | undefined {
  return useStore((s) => (id ? s.view?.tasks.find((t) => t.id === id) : undefined));
}

/** The selected to-dos, in list order where possible. */
export function selectedTasks(): Task[] {
  const s = useStore.getState();
  const byId = new Map((s.view?.tasks ?? []).map((t) => [t.id, t]));
  return s.selectedIds.map((id) => byId.get(id)).filter((t): t is Task => !!t);
}

/** True while several rows are selected or Select mode is on. */
export function useMulti(): boolean {
  return useStore((s) => s.selectMode || s.selectedIds.length > 1);
}
