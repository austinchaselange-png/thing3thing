// TypeScript mirror of crates/things-sync/src/mutation.rs, used by the mock
// backend and to show edits optimistically while a write is in flight. The
// Rust side remains authoritative: its snapshot replaces this result.
import type { ChecklistItem, Mutation, Snapshot, Task, When } from "../types";
import { todayYmd } from "./dates";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function localId(): string {
  let s = "";
  for (let i = 0; i < 22; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export class MutationError extends Error {
  constructor(
    public code: "notFound" | "invalid" | "confirmationRequired",
    message: string,
  ) {
    super(message);
  }
}

export function resolveWhen(when: When, today: string): Pick<Task, "start" | "startDate" | "evening"> {
  switch (when.kind) {
    case "inbox":
      return { start: "inbox", startDate: null, evening: false };
    case "today":
      return { start: "anytime", startDate: today, evening: false };
    case "evening":
      return { start: "anytime", startDate: today, evening: true };
    case "anytime":
      return { start: "anytime", startDate: null, evening: false };
    case "someday":
      return { start: "someday", startDate: null, evening: false };
    case "date":
      return when.date <= today ? { start: "anytime", startDate: today, evening: false } : { start: "someday", startDate: when.date, evening: false };
  }
}

export interface Applied {
  snapshot: Snapshot;
  created: string[];
}

/** Applies a mutation to a snapshot copy. Throws MutationError on invalid input. */
export function applyMutation(snap: Snapshot, m: Mutation, opts: { today?: string; now?: number; rev?: number } = {}): Applied {
  const today = opts.today ?? todayYmd();
  const now = opts.now ?? Date.now();
  const rev = opts.rev ?? snap.serverIndex + 1;
  const tasks = new Map(snap.tasks.map((t) => [t.id, t]));
  let checklist = [...snap.checklist];
  let areas = [...snap.areas];
  let tags = [...snap.tags];
  const created: string[] = [];

  const get = (id: string) => {
    const t = tasks.get(id);
    if (!t) throw new MutationError("notFound", "This item no longer exists.");
    return t;
  };
  const put = (t: Task, patch: Partial<Task>) => tasks.set(t.id, { ...t, ...patch, modifiedAt: now, rev });
  const minIndex = (pred: (t: Task) => boolean) => {
    const values = [...tasks.values()].filter((t) => t.status === "open" && !t.trashed && pred(t)).map((t) => t.index);
    return values.length ? Math.max(1, Math.min(...values) - 1) : 1;
  };

  switch (m.type) {
    case "createTask": {
      if (!m.title.trim()) throw new MutationError("invalid", "Title must not be empty.");
      const kind = m.kind ?? "task";
      const id = localId();
      let projectId = kind === "heading" ? m.projectId ?? null : m.headingId ? (tasks.get(m.headingId)?.projectId ?? null) : (m.projectId ?? null);
      if (kind === "heading" && !projectId) throw new MutationError("invalid", "A heading needs a project.");
      if (kind === "project") projectId = null;
      const headingId = kind === "task" ? (m.headingId ?? null) : null;
      const areaId = kind === "task" && (headingId || projectId) ? null : (m.areaId ?? null);
      const inContainer = !!(projectId || headingId || areaId);
      const when = kind === "heading" ? { kind: "anytime" as const } : (m.when ?? (inContainer || kind === "project" ? { kind: "anytime" as const } : { kind: "inbox" as const }));
      const sched = resolveWhen(when, today);
      if (kind === "project" && sched.start === "inbox") sched.start = "anytime";
      if (m.reminder && !sched.startDate) throw new MutationError("invalid", "A reminder needs a date.");
      const task: Task = {
        id,
        type: kind,
        title: m.title.trim(),
        notes: m.notes ?? "",
        status: "open",
        ...sched,
        deadline: m.deadline ?? null,
        reminder: m.reminder ?? null,
        reminderDate: m.reminder ? sched.startDate : null,
        areaId,
        projectId,
        headingId,
        tagIds: m.tagIds ?? [],
        trashed: false,
        index: minIndex((t) => t.type === kind && t.projectId === projectId && t.headingId === headingId),
        todayIndex: 0,
        createdAt: now,
        modifiedAt: null,
        completedAt: null,
        repeat: m.repeat ? { templateId: localId(), summary: "Repeating" } : null,
        rev,
      };
      tasks.set(id, task);
      created.push(id);
      (m.checklist ?? []).filter((l) => l.trim()).forEach((title, i) => {
        const cid = localId();
        checklist.push({ id: cid, taskId: id, title: title.trim(), completed: false, index: i, rev });
        created.push(cid);
      });
      break;
    }
    case "updateTask": {
      const t = get(m.id);
      const patch: Partial<Task> = {};
      if (m.title !== undefined) {
        if (!m.title.trim()) throw new MutationError("invalid", "Title must not be empty.");
        patch.title = m.title.trim();
      }
      if (m.notes !== undefined) patch.notes = m.notes;
      if (m.deadline !== undefined) patch.deadline = m.deadline;
      if (m.tagIds !== undefined) patch.tagIds = m.tagIds;
      put(t, patch);
      break;
    }
    case "schedule": {
      const t = get(m.id);
      if (t.type === "heading") throw new MutationError("invalid", "Headings cannot be scheduled.");
      const sched = resolveWhen(m.when, today);
      if (t.type === "project" && sched.start === "inbox") sched.start = "anytime";
      if (sched.start === "inbox" && (t.projectId || t.headingId || t.areaId))
        throw new MutationError("invalid", "Move the item out of its project or area before sending it to the Inbox.");
      const patch: Partial<Task> = { ...sched };
      if (m.reminder !== undefined) {
        if (m.reminder && !sched.startDate) throw new MutationError("invalid", "A reminder needs a date.");
        patch.reminder = m.reminder;
        patch.reminderDate = m.reminder ? sched.startDate : null;
      } else if (!sched.startDate) {
        patch.reminder = null;
        patch.reminderDate = null;
      }
      put(t, patch);
      break;
    }
    case "move": {
      const t = get(m.id);
      const count = [m.areaId, m.projectId, m.headingId].filter(Boolean).length;
      if (count > 1) throw new MutationError("invalid", "Choose one destination.");
      if (t.type === "heading") throw new MutationError("invalid", "Headings cannot be moved between projects.");
      if (t.type === "project" && (m.projectId || m.headingId)) throw new MutationError("invalid", "Projects can only be moved into areas.");
      if (m.projectId === t.id) throw new MutationError("invalid", "An item cannot contain itself.");
      const projectId = m.headingId ? (get(m.headingId).projectId ?? null) : (m.projectId ?? null);
      put(t, {
        areaId: m.areaId ?? null,
        projectId,
        headingId: m.headingId ?? null,
        start: count === 1 && t.start === "inbox" ? "anytime" : t.start,
      });
      break;
    }
    case "setStatus": {
      const t = get(m.id);
      put(t, { status: m.status, completedAt: m.status === "open" ? null : now });
      if (t.type === "project" && m.status !== "open") {
        for (const c of tasks.values()) {
          if (c.projectId === t.id && c.id !== t.id && c.status === "open" && !c.trashed) put(c, { status: m.status, completedAt: now });
        }
      }
      break;
    }
    case "setTrashed":
      put(get(m.id), { trashed: m.trashed });
      break;
    case "addChecklistItem": {
      const t = get(m.taskId);
      if (!m.title.trim()) throw new MutationError("invalid", "Checklist item must not be empty.");
      const existing = checklist.filter((c) => c.taskId === t.id);
      const id = localId();
      checklist.push({ id, taskId: t.id, title: m.title.trim(), completed: false, index: existing.length ? Math.max(...existing.map((c) => c.index)) + 1 : 0, rev });
      created.push(id);
      break;
    }
    case "updateChecklistItem": {
      const found = checklist.find((c) => c.id === m.id);
      if (!found) throw new MutationError("notFound", "Checklist item no longer exists.");
      checklist = checklist.map((c): ChecklistItem => (c.id === m.id ? { ...c, title: m.title?.trim() ?? c.title, completed: m.completed ?? c.completed, rev } : c));
      break;
    }
    case "deleteChecklistItem":
      checklist = checklist.filter((c) => c.id !== m.id);
      break;
    case "createArea": {
      if (!m.title.trim()) throw new MutationError("invalid", "Area name must not be empty.");
      const id = localId();
      areas.push({ id, title: m.title.trim(), index: 0, rev });
      created.push(id);
      break;
    }
    case "renameArea":
      areas = areas.map((a) => (a.id === m.id ? { ...a, title: m.title.trim(), rev } : a));
      break;
    case "deleteArea": {
      if (m.confirm !== "DELETE") throw new MutationError("confirmationRequired", "Type DELETE to confirm.");
      const n = [...tasks.values()].filter((t) => t.areaId === m.id && !t.trashed).length;
      if (n) throw new MutationError("invalid", `This area still contains ${n} item(s). Move them or put them in the Trash first.`);
      areas = areas.filter((a) => a.id !== m.id);
      break;
    }
    case "createTag": {
      if (!m.title.trim()) throw new MutationError("invalid", "Tag name must not be empty.");
      const id = localId();
      tags.push({ id, title: m.title.trim(), shortcut: null, parentId: m.parentId ?? null, index: -1237, rev });
      created.push(id);
      break;
    }
    case "renameTag":
      tags = tags.map((t) => (t.id === m.id ? { ...t, title: m.title.trim(), rev } : t));
      break;
    case "deleteTag":
      if (m.confirm !== "DELETE") throw new MutationError("confirmationRequired", "Type DELETE to confirm.");
      tags = tags.filter((t) => t.id !== m.id);
      break;
    case "stopRepeating": {
      if (m.confirm !== "DELETE") throw new MutationError("confirmationRequired", "Type DELETE to confirm.");
      put(get(m.id), { repeat: null });
      break;
    }
  }
  return { snapshot: { tasks: [...tasks.values()], checklist, areas, tags, serverIndex: rev }, created };
}
