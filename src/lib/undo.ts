// Undo/Redo, like Things' Ctrl+Z. Before a change is sent we record the
// mutations that would put things back, computed from the current snapshot.
// Changes made together (a bulk edit, a drag that moves and reorders) are
// grouped into one step (see actionSeq in store.ts). Permanent deletions can't be undone.
import type { Mutation, Snapshot, Task, When } from "../types";
import { todayYmd } from "./dates";

export interface UndoStep {
  /** The user action (key press, click, drop) that made it. */
  at: number;
  undo: Mutation[];
  redo: Mutation[];
}

/** Things' When choice for a task's current schedule. */
function whenOf(t: Task): When {
  if (t.start === "inbox") return { kind: "inbox" };
  if (t.startDate && t.startDate <= todayYmd()) return t.evening ? { kind: "evening" } : { kind: "today" };
  if (t.startDate) return { kind: "date", date: t.startDate };
  return t.start === "someday" ? { kind: "someday" } : { kind: "anytime" };
}

/**
 * Pins a recorded mutation to the revision our own write produced, so the
 * conflict check catches anything changed after it (e.g. on the iPhone).
 * `serverIndex` is the history head after our write; our entry sits just below it.
 */
export function pinned(m: Mutation, serverIndex: number): Mutation {
  return "baseRev" in m ? ({ ...m, baseRev: Math.max(0, serverIndex - 1) } as Mutation) : m;
}

/** Mutations that undo `m`, or null when it can't be undone. createTask is handled after the write. */
export function inverseOf(m: Mutation, snap: Snapshot): Mutation[] | null {
  const task = (id: string) => snap.tasks.find((t) => t.id === id);
  switch (m.type) {
    case "setStatus": {
      const t = task(m.id);
      if (!t) return null;
      const back: Mutation[] = [{ type: "setStatus", id: t.id, baseRev: null, status: t.status }];
      // Finishing a project also finishes its open headings and to-dos; reopen those too.
      if (t.type === "project" && t.status === "open" && m.status !== "open") {
        const headings = new Set(snap.tasks.filter((c) => c.type === "heading" && c.projectId === t.id).map((c) => c.id));
        for (const c of snap.tasks) {
          const inside = c.projectId === t.id || (!!c.headingId && headings.has(c.headingId));
          if (inside && c.id !== t.id && c.status === "open" && !c.trashed) back.push({ type: "setStatus", id: c.id, baseRev: null, status: "open" });
        }
      }
      return back;
    }
    case "setTrashed": {
      const t = task(m.id);
      return t ? [{ type: "setTrashed", id: t.id, baseRev: null, trashed: t.trashed }] : null;
    }
    case "schedule": {
      const t = task(m.id);
      return t ? [{ type: "schedule", id: t.id, baseRev: null, when: whenOf(t), reminder: t.reminder }] : null;
    }
    case "move": {
      const t = task(m.id);
      if (!t) return null;
      const back: Mutation[] = [
        { type: "move", id: t.id, baseRev: null, areaId: t.headingId || t.projectId ? null : t.areaId, projectId: t.headingId ? null : t.projectId, headingId: t.headingId },
      ];
      // Moving out of the Inbox also schedules it; send it back there.
      if (t.start === "inbox") back.push({ type: "schedule", id: t.id, baseRev: null, when: { kind: "inbox" } });
      return back;
    }
    case "updateTask": {
      const t = task(m.id);
      if (!t) return null;
      const back: Extract<Mutation, { type: "updateTask" }> = { type: "updateTask", id: t.id, baseRev: null };
      // Titles can't be empty, so a to-do that had none keeps its new title.
      if (m.title !== undefined && t.title.trim()) back.title = t.title;
      if (m.notes !== undefined) back.notes = t.notes;
      if (m.deadline !== undefined) back.deadline = t.deadline;
      if (m.tagIds !== undefined) back.tagIds = t.tagIds;
      return Object.keys(back).length > 3 ? [back] : null;
    }
    case "reorder": {
      const items = m.items
        .map((it) => {
          const t = task(it.id);
          if (t) return { id: it.id, value: t[m.key] };
          const a = snap.areas.find((x) => x.id === it.id);
          return a ? { id: it.id, value: a.index } : null;
        })
        .filter((x): x is { id: string; value: number } => !!x);
      return items.length ? [{ type: "reorder", key: m.key, items }] : null;
    }
    case "updateChecklistItem": {
      const c = snap.checklist.find((x) => x.id === m.id);
      if (!c) return null;
      return [{ type: "updateChecklistItem", id: c.id, baseRev: null, title: m.title !== undefined ? c.title : undefined, completed: m.completed !== undefined ? c.completed : undefined }];
    }
    case "renameArea": {
      const a = snap.areas.find((x) => x.id === m.id);
      return a ? [{ type: "renameArea", id: a.id, baseRev: null, title: a.title }] : null;
    }
    case "renameTag": {
      const t = snap.tags.find((x) => x.id === m.id);
      return t ? [{ type: "renameTag", id: t.id, baseRev: null, title: t.title }] : null;
    }
    default:
      return null;
  }
}
