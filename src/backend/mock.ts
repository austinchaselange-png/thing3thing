import type { AppState, Mutation, Settings, Snapshot, WriteError, WritePolicy, WriteReport } from "../types";
import { DESTRUCTIVE } from "../types";
import { applyMutation, MutationError } from "../lib/applyMutation";
import type { Backend } from "./Backend";

const SETTINGS_KEY = "tings3.mock.settings";

function loadSettings(): Settings {
  const defaults: Settings = { quickEntryShortcut: "Ctrl+Alt+Space", closeToTray: true, launchAtLogin: false, notifications: true, pollSeconds: 30, mica: false };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return defaults;
  }
}

export function emptySnapshot(): Snapshot {
  return { tasks: [], checklist: [], areas: [], tags: [], serverIndex: 0 };
}

/** In-memory backend for the browser preview and tests. Starts empty unless a snapshot is given.
 * Writes are always allowed (nothing leaves the browser). */
export class MockBackend implements Backend {
  readonly kind = "mock" as const;
  private state: AppState;
  private listeners = new Set<(s: AppState) => void>();
  private latency: number;

  private initial: () => Snapshot;

  constructor(opts: { latencyMs?: number; snapshot?: () => Snapshot } = {}) {
    this.initial = opts.snapshot ?? emptySnapshot;
    this.latency = opts.latencyMs ?? 120;
    this.state = {
      account: { mode: "demo", email: null },
      snapshot: this.initial(),
      sync: { phase: "idle", lastSyncedAt: Date.now(), lastError: null, nextAttemptAt: null },
      policy: { writes: true, destructive: true },
      issues: [],
      recentWrites: [],
      settings: loadSettings(),
      platform: { os: "browser", micaAvailable: false, version: "dev" },
      canWrite: true,
      format: { newerKinds: [], writesSupported: true },
    };
  }

  private wait() {
    return new Promise((r) => setTimeout(r, this.latency));
  }

  private emit(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  async getState() {
    return this.state;
  }

  subscribe(listener: (s: AppState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async apply(m: Mutation, _opts?: { force?: boolean }): Promise<WriteReport> {
    await this.wait();
    if (!this.state.policy.writes) throw { code: "readOnly", message: "Writing is turned off." } satisfies WriteError;
    if (DESTRUCTIVE.includes(m.type) && !this.state.policy.destructive)
      throw { code: "destructiveDisabled", message: "Permanent deletions are turned off." } satisfies WriteError;
    try {
      const r = applyMutation(this.state.snapshot, m);
      this.emit({ snapshot: r.snapshot, sync: { ...this.state.sync, lastSyncedAt: Date.now() } });
      return { created: r.created, summary: m.type, serverIndex: r.snapshot.serverIndex, reconciled: false };
    } catch (e) {
      if (e instanceof MutationError) throw { code: e.code, message: e.message } satisfies WriteError;
      throw e;
    }
  }

  async syncNow() {
    this.emit({ sync: { ...this.state.sync, phase: "syncing" } });
    await this.wait();
    this.emit({ sync: { phase: "idle", lastSyncedAt: Date.now(), lastError: null, nextAttemptAt: null } });
  }

  async connect() {
    await this.wait();
    throw { code: "invalid", message: "The browser preview cannot connect to Things Cloud. Run the desktop app." } satisfies WriteError;
  }

  async disconnect() {}

  async useDemo() {
    this.emit({ snapshot: this.initial(), account: { mode: "demo", email: null } });
  }

  async setPolicy(p: WritePolicy) {
    this.emit({ policy: { writes: p.writes, destructive: p.writes && p.destructive }, canWrite: p.writes });
  }

  async dismissIssue(id: number) {
    this.emit({ issues: this.state.issues.filter((i) => i.id !== id) });
  }

  async reapplyIssue(): Promise<WriteReport> {
    throw { code: "notFound", message: "No such change." } satisfies WriteError;
  }

  async updateSettings(s: Partial<Settings>) {
    const settings = { ...this.state.settings, ...s };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable */
    }
    this.emit({ settings });
  }

  async simulateRemoteEdit() {
    const t = this.state.snapshot.tasks.find((x) => x.status === "open" && !x.trashed && x.type === "task");
    if (!t) return "Nothing to edit";
    const tasks = this.state.snapshot.tasks.map((x) => (x.id === t.id ? { ...x, title: `${x.title} (edited on iPhone)`, rev: x.rev + 100 } : x));
    this.emit({ snapshot: { ...this.state.snapshot, tasks, serverIndex: this.state.snapshot.serverIndex + 1 } });
    return t.title;
  }

  async hideQuickEntry() {}
  async showMainWindow() {}
}
