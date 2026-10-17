import { act, render, screen, waitFor, within } from "@testing-library/react";
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
  useStore.setState({ app: null, view: null, pending: [], dialog: null, toasts: [], selection: { kind: "list", id: "today" }, selectedId: null, editingId: null, recentlyCompleted: [] });
}

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
    const dialog = await screen.findByRole("dialog", { name: /Allow Tings 3 to change/ });
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

  it("goes read-only with an explanation when the account uses a newer data format", async () => {
    const b = backend as unknown as { emit(p: object): void };
    b.emit({ account: { mode: "cloud", email: "me@example.com" }, canWrite: false, format: { newerKinds: [{ kind: "Task7", count: 12, unfamiliarFields: ["zz"] }] } });
    render(<App />);
    expect(await screen.findByText(/newer Things data format \(Task7\)/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Complete “Call the dentist/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Details…" }));
    expect(await screen.findByText(/Task7 \(12\)/)).toBeInTheDocument();
    expect(screen.getByText(/Task7: zz/)).toBeInTheDocument();
  });
});
