import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { setBackendForTests } from "./backend";
import { MockBackend } from "./backend/mock";
import { mockSnapshot } from "./backend/mockData";
import { useStore } from "./store";
import type { Mutation, WriteError } from "./types";

function reset(backend: MockBackend) {
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
  });
}

/** A row's title in the list (the sidebar widgets can show the same text). */
const inList = (title: string) => within(screen.getByRole("listbox", { name: "To-dos" })).getByText(title);
const ctrlClick = (title: string) => fireEvent.click(inList(title), { ctrlKey: true, detail: 1 });
const shiftClick = (title: string) => fireEvent.click(inList(title), { shiftKey: true, detail: 1 });

const taskByTitle = async (backend: MockBackend, title: string) => (await backend.getState()).snapshot.tasks.find((t) => t.title === title)!;

describe("App", () => {
  let backend: MockBackend;
  beforeEach(() => {
    backend = new MockBackend({ latencyMs: 0, snapshot: () => mockSnapshot() });
    reset(backend);
  });

  it("shows Today with an evening section and completes a to-do in place", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByText("This Evening")).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /Complete “Call the dentist/ });
    await userEvent.click(box);
    // Stays visible (checked) until the user leaves the list, like Things.
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Mark “Call the dentist.*open/ })).toBeChecked());
    const snap = (await backend.getState()).snapshot;
    expect(snap.tasks.find((t) => t.title === "Call the dentist to reschedule")?.status).toBe("completed");
    await userEvent.click(screen.getByRole("button", { name: /Logbook/ }));
    expect(await screen.findByText("Call the dentist to reschedule")).toBeInTheDocument();
  });

  it("navigates to a project and shows its headings", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(within(screen.getByRole("navigation")).getByText("Trip to Lisbon"));
    expect(await screen.findByDisplayValue("Trip to Lisbon")).toBeInTheDocument();
    expect(screen.getByText("Packing")).toBeInTheDocument();
    expect(screen.getByText("Reserve apartment in Alfama")).toBeInTheDocument();
  });

  it("blocks edits in read-only mode and offers the opt-in", async () => {
    await backend.setPolicy({ writes: false, destructive: false });
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    expect(screen.getByRole("checkbox", { name: /Complete “Call the dentist/ })).toBeDisabled();
    await act(() => useStore.getState().apply({ type: "createArea", title: "X" }));
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Enable writes…" }));
    const dialog = await screen.findByRole("dialog", { name: /Allow Things 3 to change/ });
    const enable = within(dialog).getByRole("button", { name: "Enable writes" });
    expect(enable).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(enable);
    await waitFor(async () => expect((await backend.getState()).policy.writes).toBe(true));
  });

  it("routes conflicts to a dialog that can overwrite explicitly", async () => {
    const calls: { m: Mutation; force?: boolean }[] = [];
    const original = backend.apply.bind(backend);
    backend.apply = async (m: Mutation, opts?: { force?: boolean }) => {
      calls.push({ m, force: opts?.force });
      if (!opts?.force) throw { code: "conflict", message: "changed", entityId: "x", fields: ["title"] } satisfies WriteError;
      return original(m);
    };
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    const t = useStore.getState().view!.tasks.find((x) => x.title === "Water the plants")!;
    await act(() => useStore.getState().apply({ type: "updateTask", id: t.id, baseRev: t.rev, title: "Water the ferns" }));
    const dialog = await screen.findByRole("dialog", { name: "Changed on another device" });
    expect(within(dialog).getByText("title")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Use my change" }));
    await waitFor(() => expect(calls.at(-1)?.force).toBe(true));
    expect(await screen.findByText("Water the ferns")).toBeInTheDocument();
  });

  it("creates a to-do from natural language with Ctrl+N", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.keyboard("{Control>}n{/Control}");
    const input = await screen.findByRole("textbox", { name: "New to-do title" });
    await userEvent.type(input, "Buy stamps #errand{Enter}");
    await waitFor(() => expect(useStore.getState().view!.tasks.some((t) => t.title === "Buy stamps" && t.tagIds.includes("tagErrand") && t.startDate)).toBe(true));
  });

  it("goes read-only with an explanation when Things Cloud sends data it doesn't understand", async () => {
    const b = backend as unknown as { emit(p: object): void };
    b.emit({
      account: { mode: "cloud", email: "me@example.com" },
      canWrite: false,
      format: { newerKinds: [{ kind: "Task7", count: 12, unfamiliarFields: ["zz"] }], problems: ["Task7: zz", "Things Cloud schema 302 (Things 3 knows 301)"], serverSchema: 302, writesSupported: false },
    });
    render(<App />);
    expect(await screen.findByText(/doesn't fully understand yet, so changes are off/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Complete “Call the dentist/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Details…" }));
    expect(await screen.findByText(/Syncing from your iPhone keeps working/)).toBeInTheDocument();
    expect(screen.getByText("Task7: zz")).toBeInTheDocument();
    expect(screen.getByText(/schema 302/)).toBeInTheDocument();
  });

  it("shows a sync failure in the window with a way to retry", async () => {
    const b = backend as unknown as { emit(p: object): void };
    b.emit({ account: { mode: "cloud", email: "me@example.com" }, sync: { phase: "error", lastSyncedAt: null, lastError: "Things Cloud is unreachable", nextAttemptAt: null } });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sync stopped: Things Cloud is unreachable");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("right-click menu moves a to-do to the Trash, with Undo", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    fireEvent.contextMenu(screen.getByText("Water the plants"));
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Move to Trash/ }));
    await waitFor(() => expect(screen.queryByText("Water the plants")).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Water the plants")).toBeInTheDocument();
  });

  it("menus work from the keyboard and disable writes when read-only", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(screen.getByText("Call the dentist to reschedule"));
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Complete/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    await act(() => backend.setPolicy({ writes: false, destructive: false }));
    fireEvent.contextMenu(screen.getByText("Call the dentist to reschedule"));
    const ro = await screen.findByRole("menu");
    expect(within(ro).getByRole("menuitem", { name: /Move to Trash/ })).toHaveAttribute("aria-disabled", "true");
    expect(within(ro).getByRole("menuitem", { name: /Copy Title/ })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "New To-Do" })).toBeDisabled();
  });

  it("the blue button starts a new to-do and shows quick actions on the selected row", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    expect(screen.queryByRole("toolbar", { name: "Actions" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New To-Do" }));
    expect(await screen.findByRole("textbox", { name: "New to-do title" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByText("Call the dentist to reschedule"));
    expect(screen.getByRole("button", { name: "When" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to Trash" })).toBeInTheDocument();
  });

  it("Ctrl-click and Shift-click select several to-dos and complete them together", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(inList("Pick up dry cleaning"));
    ctrlClick("Go for a run");
    const bar = await screen.findByRole("toolbar", { name: "Selected to-dos" });
    expect(bar).toHaveTextContent("2 selected");
    // The + button gives way to the selection bar, like Things.
    expect(screen.queryByRole("button", { name: "New To-Do" })).not.toBeInTheDocument();

    shiftClick("Call the dentist to reschedule");
    expect(bar).toHaveTextContent("2 selected"); // range from the last Ctrl-click: run → dentist

    await userEvent.click(within(bar).getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent?.replace(/Ctrl.*$/, ""))).toEqual(["Mark as Completed", "Set Tags…", "Set Deadline…", "Duplicate", "Share…"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Mark as Completed/ }));
    await waitFor(async () => {
      expect((await taskByTitle(backend, "Go for a run")).status).toBe("completed");
      expect((await taskByTitle(backend, "Call the dentist to reschedule")).status).toBe("completed");
    });
    expect((await taskByTitle(backend, "Pick up dry cleaning")).status).toBe("open");
  });

  it("Set Tags on a selection adds the tag and keeps each to-do's other tags", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(inList("Review Q3 budget draft"));
    ctrlClick("Water the plants");
    fireEvent.contextMenu(inList("Water the plants"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("2 Selected")).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Set Tags/ }));
    const picker = await screen.findByRole("dialog");
    await userEvent.click(within(picker).getByRole("menuitemcheckbox", { name: /Errand/ }));
    await waitFor(async () => {
      expect((await taskByTitle(backend, "Review Q3 budget draft")).tagIds).toEqual(["tagImportant", "tagErrand"]);
      expect((await taskByTitle(backend, "Water the plants")).tagIds).toEqual(["tagHome", "tagErrand"]);
    });
  });

  it("Delete trashes the whole selection with one Undo", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(inList("Plan weekend hike"));
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}{Delete}");
    await waitFor(() => expect(screen.queryByText("Water the plants")).not.toBeInTheDocument());
    expect(screen.queryByText("Plan weekend hike")).not.toBeInTheDocument();
    expect(await screen.findByText("Moved 2 to-dos to the Trash")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Water the plants")).toBeInTheDocument();
    expect(screen.getByText("Plan weekend hike")).toBeInTheDocument();
  });

  it("in the Trash, Delete asks and then deletes for good instead of putting back", async () => {
    const t = useStore.getState;
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    // Put two to-dos in the Trash first.
    await userEvent.click(inList("Plan weekend hike"));
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}{Delete}");
    await waitFor(() => expect(screen.queryByText("Water the plants")).not.toBeInTheDocument());
    await userEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: /^Trash/ }));
    expect(await screen.findByRole("heading", { name: "Trash" })).toBeInTheDocument();
    await userEvent.click(inList("Water the plants"));
    await userEvent.keyboard("{Control>}a{/Control}{Delete}");
    const dialog = await screen.findByRole("dialog", { name: /Delete 3 to-dos permanently/ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(async () => expect((await backend.getState()).snapshot.tasks.some((x) => x.trashed)).toBe(false));
    expect((await backend.getState()).snapshot.tasks.some((x) => x.title === "Water the plants")).toBe(false);
    expect(t().view!.tasks.some((x) => x.title === "Plan weekend hike")).toBe(false);
    expect(await screen.findByText("Trash is empty")).toBeInTheDocument();
  });

  it("Put Back in the Trash restores the selection", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: /^Trash/ }));
    await userEvent.click(await screen.findByText("Old idea"));
    await userEvent.click(screen.getByRole("button", { name: "Put Back" }));
    await waitFor(async () => expect((await taskByTitle(backend, "Old idea")).trashed).toBe(false));
  });

  it("Select mode from the list ••• menu, with Done to leave it", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(screen.getByRole("button", { name: "List actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent?.replace(/Ctrl.*$/, ""))).toEqual(["Filter by Tag", "Select", "Paste", "Share…"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Select/ }));
    expect(screen.getByRole("toolbar", { name: "Selected to-dos" })).toHaveTextContent("Select to-dos");
    await userEvent.click(inList("Go for a run"));
    await userEvent.click(inList("Water the plants"));
    expect(screen.getByRole("toolbar", { name: "Selected to-dos" })).toHaveTextContent("2 selected");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("toolbar", { name: "Selected to-dos" })).not.toBeInTheDocument();
  });

  it("Someday to-dos get a dashed box", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(screen.getByRole("button", { name: /Someday/ }));
    expect(await screen.findByRole("checkbox", { name: /Complete “Learn to make sourdough/ })).toHaveClass("someday");
    await userEvent.click(within(screen.getByRole("navigation")).getAllByRole("button", { name: /^Today/ })[0]);
    expect(await screen.findByRole("checkbox", { name: /Complete “Go for a run/ })).not.toHaveClass("someday");
  });

  it("an open to-do on Today links to its project", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(inList("Compare flight prices"));
    await userEvent.click(inList("Compare flight prices")); // a second click opens it
    const link = await screen.findByRole("button", { name: /Trip to Lisbon.*Book/ });
    expect(link).toHaveTextContent("Book");
    await userEvent.click(link);
    expect(await screen.findByDisplayValue("Trip to Lisbon")).toBeInTheDocument();
    expect(useStore.getState().selectedId).toBe((await taskByTitle(backend, "Compare flight prices")).id);
  });

  it("the project ••• menu matches Things", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Today" });
    await userEvent.click(within(screen.getByRole("navigation")).getByText("Trip to Lisbon"));
    await userEvent.click(await screen.findByRole("button", { name: "Project actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Complete Project",
      "When",
      "Add Tags…",
      "Change Deadline…",
      "Repeat…",
      "Move…",
      "Duplicate",
      "Rename…",
      "Delete Project",
      "Share…",
    ]);
  });
});
