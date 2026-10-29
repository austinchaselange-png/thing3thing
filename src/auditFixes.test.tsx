// Smoke tests for the fixes from audits/full-audit-2026-10-29.md.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { bulkSetStatus } from "./actions";
import { App } from "./App";
import { setBackendForTests } from "./backend";
import { MockBackend } from "./backend/mock";
import { mockSnapshot } from "./backend/mockData";
import { friendlyTime } from "./lib/dates";
import { inverseOf, pinned } from "./lib/undo";
import { LINK_MAX } from "./links";
import { useStore } from "./store";
import type { Mutation } from "./types";

let backend: MockBackend;

beforeEach(() => {
  backend = new MockBackend({ latencyMs: 0, snapshot: () => mockSnapshot() });
  setBackendForTests(backend);
  useStore.setState({
    app: null,
    view: null,
    pending: [],
    dialog: null,
    toasts: [],
    menu: null,
    picker: null,
    selection: { kind: "list", id: "today" },
    selectedId: null,
    selectedIds: [],
    anchorId: null,
    selectMode: false,
    editingId: null,
    recentlyCompleted: [],
    undoStack: [],
    redoStack: [],
  });
});

const state = () => backend.getState();
const byTitle = async (title: string) => (await state()).snapshot.tasks.find((t) => t.title === title)!;

async function load() {
  await useStore.getState().init();
}

describe("undo", () => {
  it("pins undo to our own write, so later edits elsewhere count as a conflict", () => {
    const m: Mutation = { type: "setStatus", id: "a", baseRev: null, status: "open" };
    expect(pinned(m, 42)).toMatchObject({ baseRev: 41 });
    // Mutations without a revision (reorder) are left alone.
    const r: Mutation = { type: "reorder", key: "index", items: [] };
    expect(pinned(r, 42)).toBe(r);
  });

  it("undoing a completed project reopens its open to-dos too", async () => {
    const snap = mockSnapshot();
    const project = snap.tasks.find((t) => t.title === "Trip to Lisbon")!;
    const open = snap.tasks.filter((t) => t.projectId === project.id && t.status === "open" && !t.trashed);
    const back = inverseOf({ type: "setStatus", id: project.id, baseRev: null, status: "completed" }, snap)!;
    const ids = back.map((m) => ("id" in m ? m.id : ""));
    expect(ids[0]).toBe(project.id);
    for (const t of open) expect(ids).toContain(t.id);
  });

  it("keeps the step when undo can't be saved, so it can be tried again", async () => {
    await backend.setPolicy({ writes: true, destructive: false });
    await load();
    const t = await byTitle("Call the dentist to reschedule");
    await act(() => useStore.getState().apply({ type: "setStatus", id: t.id, baseRev: t.rev, status: "completed" }));
    expect(useStore.getState().undoStack).toHaveLength(1);
    // Writes off: the undo fails…
    await backend.setPolicy({ writes: false, destructive: false });
    await act(() => useStore.getState().undo());
    expect(useStore.getState().undoStack).toHaveLength(1);
    expect((await byTitle("Call the dentist to reschedule")).status).toBe("completed");
    // …and works once writes are back.
    await backend.setPolicy({ writes: true, destructive: false });
    await act(() => useStore.getState().undo());
    expect((await byTitle("Call the dentist to reschedule")).status).toBe("open");
    expect(useStore.getState().undoStack).toHaveLength(0);
    expect(useStore.getState().redoStack).toHaveLength(1);
  });

  it("the toast's Undo after a bulk Reopen puts the to-dos back to completed", async () => {
    await backend.setPolicy({ writes: true, destructive: false });
    await load();
    const a = await byTitle("Call the dentist to reschedule");
    const b = await byTitle("Go for a run");
    await act(() => bulkSetStatus([a, b], "completed"));
    const done = [await byTitle(a.title), await byTitle(b.title)];
    await act(() => bulkSetStatus(done, "open"));
    expect((await byTitle(a.title)).status).toBe("open");
    const toast = useStore.getState().toasts.find((x) => x.text.startsWith("Reopened"))!;
    await act(async () => {
      toast.action!.run();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((await byTitle(a.title)).status).toBe("completed");
    expect((await byTitle(b.title)).status).toBe("completed");
  });
});

describe("state updates", () => {
  it("a status-only update keeps the list's data objects", async () => {
    await load();
    const s = useStore.getState();
    const view = s.view;
    s.setApp({ ...s.app!, dataRev: 7, snapshot: { ...s.app!.snapshot } });
    const v1 = useStore.getState().view;
    useStore.getState().setApp({ ...useStore.getState().app!, dataRev: 7, snapshot: { ...s.app!.snapshot }, sync: { ...s.app!.sync, phase: "syncing" } });
    expect(useStore.getState().view).toBe(v1);
    expect(useStore.getState().app!.sync.phase).toBe("syncing");
    expect(v1).not.toBe(view);
  });
});

describe("things:/// links", () => {
  it("asks before adding many to-dos, and adds at most the limit", async () => {
    await backend.setPolicy({ writes: true, destructive: false });
    await load();
    const { handleLink } = await import("./links");
    const before = (await state()).snapshot.tasks.length;
    const titles = Array.from({ length: LINK_MAX + 20 }, (_, i) => `Linked ${i}`).join("\n");
    await act(() => handleLink(`things:///add?titles=${encodeURIComponent(titles)}`));
    expect((await state()).snapshot.tasks.length).toBe(before);
    const ask = useStore.getState().toasts.find((t) => t.action?.label === "Add them")!;
    expect(ask.text).toContain(`${LINK_MAX} to-dos`);
    await act(async () => {
      ask.action!.run();
      await waitFor(async () => expect((await state()).snapshot.tasks.length).toBe(before + LINK_MAX), { timeout: 10000 });
    });
  });

  it("adds a few to-dos right away", async () => {
    await backend.setPolicy({ writes: true, destructive: false });
    await load();
    const { handleLink } = await import("./links");
    await act(() => handleLink("things:///add?titles=One%0ATwo"));
    expect(await byTitle("One")).toBeTruthy();
    expect(await byTitle("Two")).toBeTruthy();
  });
});

describe("screens", () => {
  it("keeps a new to-do's text when it can't be saved", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    // Writes are off in the mock by default, so the save fails.
    await backend.setPolicy({ writes: true, destructive: false });
    await act(async () => window.dispatchEvent(new Event("tings3:new-task")));
    const input = await screen.findByRole("textbox", { name: "New to-do title" });
    await backend.setPolicy({ writes: false, destructive: false });
    await userEvent.type(input, "Buy stamps{Enter}");
    expect(screen.getByRole("textbox", { name: "New to-do title" })).toHaveValue("Buy stamps");
  });

  it("Trash has an Empty Trash button and no + button", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(screen.getByRole("button", { name: /^Trash/ }));
    expect(await screen.findByRole("button", { name: "Empty Trash" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New To-Do" })).toBeNull();
  });

  it("an area has one ••• menu with the list actions in it", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(within(screen.getByRole("navigation")).getByText("Personal"));
    expect(screen.queryByRole("button", { name: "List actions" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Area actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Select/ })).toBeInTheDocument();
  });

  it("Settings → Sync uses plain words", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await act(async () => useStore.getState().openDialog({ kind: "settings", tab: "sync" }));
    expect(screen.queryByText("History index")).toBeNull();
    expect(screen.queryByText("idle")).toBeNull();
  });
});

describe("friendlyTime", () => {
  it("says Today / Yesterday / a date", () => {
    const now = new Date(2026, 9, 29, 12, 0);
    expect(friendlyTime(new Date(2026, 9, 29, 7, 38).getTime(), now)).toMatch(/^Today, /);
    expect(friendlyTime(new Date(2026, 9, 28, 21, 2).getTime(), now)).toMatch(/^Yesterday, /);
    expect(friendlyTime(new Date(2026, 9, 20, 7, 38).getTime(), now)).toMatch(/Oct 20/);
  });
});
