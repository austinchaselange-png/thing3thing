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

/** Mutations that undo `m`, or null when it can't be undone. createTask is handled after the write. */
export function inverseOf(m: Mutation, snap: Snapshot): Mutation[] | null {
  const task = (id: string) => snap.tasks.find((t) => t.id === id);
  switch (m.type) {
    case "setStatus": {
      const t = task(m.id);
      return t ? [{ type: "setStatus", id: t.id, baseRev: null, status: t.status }] : null;
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
      if (m.title !== undefined) back.title = t.title || "Untitled";
      if (m.notes !== undefined) back.notes = t.notes;
      if (m.deadline !== undefined) back.deadline = t.deadline;
      if (m.tagIds !== undefined) back.tagIds = t.tagIds;
      return [back];
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
