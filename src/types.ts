// Shapes shared with the Rust side (crates/things-sync/src/model.rs and
// src-tauri/src/commands.rs). Dates are "YYYY-MM-DD", times are epoch ms.

export type TaskType = "task" | "project" | "heading";
export type TaskStatus = "open" | "completed" | "canceled";
export type Start = "inbox" | "anytime" | "someday";

export interface Task {
  id: string;
  type: TaskType;
  title: string;
  notes: string;
  status: TaskStatus;
  start: Start;
  startDate: string | null;
  evening: boolean;
  deadline: string | null;
  reminder: string | null;
  reminderDate: string | null;
  areaId: string | null;
  projectId: string | null;
  headingId: string | null;
  tagIds: string[];
  trashed: boolean;
  index: number;
  todayIndex: number;
  createdAt: number | null;
  modifiedAt: number | null;
  completedAt: number | null;
  repeat: { templateId: string; summary: string } | null;
  rev: number;
}

export interface ChecklistItem {
  id: string;
  taskId: string;
  title: string;
  completed: boolean;
  index: number;
  rev: number;
}

export interface Area {
  id: string;
  title: string;
  index: number;
  rev: number;
}

export interface Tag {
  id: string;
  title: string;
  shortcut: string | null;
  parentId: string | null;
  index: number;
  rev: number;
}

export interface Snapshot {
  tasks: Task[];
  checklist: ChecklistItem[];
  areas: Area[];
  tags: Tag[];
  serverIndex: number;
}

export type When =
  | { kind: "inbox" }
  | { kind: "today" }
  | { kind: "evening" }
  | { kind: "anytime" }
  | { kind: "someday" }
  | { kind: "date"; date: string };

export interface RepeatSpec {
  unit: "day" | "week" | "month" | "year";
  interval?: number;
  weekdays?: number[];
  monthDay?: number | null;
}

export type Mutation =
  | {
      type: "createTask";
      title: string;
      notes?: string;
      when?: When | null;
      deadline?: string | null;
      areaId?: string | null;
      projectId?: string | null;
      headingId?: string | null;
      tagIds?: string[];
      checklist?: string[];
      kind?: TaskType;
      repeat?: RepeatSpec | null;
      reminder?: string | null;
    }
  | {
      type: "updateTask";
      id: string;
      baseRev: number | null;
      title?: string;
      notes?: string;
      deadline?: string | null;
      tagIds?: string[];
    }
  | { type: "schedule"; id: string; baseRev: number | null; when: When; reminder?: string | null }
  | { type: "move"; id: string; baseRev: number | null; areaId?: string | null; projectId?: string | null; headingId?: string | null }
  | { type: "setStatus"; id: string; baseRev: number | null; status: TaskStatus }
  | { type: "setTrashed"; id: string; baseRev: number | null; trashed: boolean }
  | { type: "addChecklistItem"; taskId: string; title: string }
  | { type: "updateChecklistItem"; id: string; baseRev: number | null; title?: string; completed?: boolean }
  | { type: "deleteChecklistItem"; id: string }
  | { type: "createArea"; title: string }
  | { type: "renameArea"; id: string; baseRev: number | null; title: string }
  | { type: "deleteArea"; id: string; confirm: string }
  | { type: "createTag"; title: string; parentId?: string | null }
  | { type: "renameTag"; id: string; baseRev: number | null; title: string }
  | { type: "deleteTag"; id: string; confirm: string }
  | { type: "stopRepeating"; id: string; confirm: string };

export const DESTRUCTIVE: Mutation["type"][] = ["deleteChecklistItem", "deleteArea", "deleteTag", "stopRepeating"];

export interface WriteReport {
  created: string[];
  summary: string;
  serverIndex: number;
  reconciled: boolean;
}

export type WriteErrorCode =
  | "readOnly"
  | "destructiveDisabled"
  | "blocked"
  | "conflict"
  | "notFound"
  | "invalid"
  | "confirmationRequired"
  | "sync"
  | "rejected"
  | "uncertain"
  | "storage"
  | "unsupportedFormat"
  | "noAccount";

export interface WriteError {
  code: WriteErrorCode;
  message: string;
  entityId?: string;
  fields?: string[];
  journalId?: number;
}

export interface Issue {
  id: number;
  createdAt: number;
  summary: string;
  status: "sending" | "uncertain" | "missing" | "committed" | "rejected" | "dismissed";
  detail: string | null;
  ancestor: number;
}

export interface WritePolicy {
  writes: boolean;
  destructive: boolean;
}

export type SyncPhase = "idle" | "syncing" | "error" | "offline" | "rateLimited" | "signedOut";

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncedAt: number | null;
  lastError: string | null;
  nextAttemptAt: number | null;
}

export interface Settings {
  quickEntryShortcut: string;
  closeToTray: boolean;
  launchAtLogin: boolean;
  notifications: boolean;
  pollSeconds: number;
  mica: boolean;
}

export interface Account {
  mode: "demo" | "cloud" | "signedOut";
  email: string | null;
}

export interface AppState {
  account: Account;
  snapshot: Snapshot;
  sync: SyncStatus;
  policy: WritePolicy;
  issues: Issue[];
  recentWrites: Issue[];
  settings: Settings;
  platform: { os: string; micaAvailable: boolean; version: string };
  /** Writes allowed now: policy permits them and no unvalidated data format is present. */
  canWrite: boolean;
  format: { newerKinds: { kind: string; count: number; unfamiliarFields: string[] }[] };
}

export type ListId = "inbox" | "today" | "upcoming" | "anytime" | "someday" | "logbook" | "trash";

export type Selection =
  | { kind: "list"; id: ListId }
  | { kind: "project"; id: string }
  | { kind: "area"; id: string }
  | { kind: "tag"; id: string };
