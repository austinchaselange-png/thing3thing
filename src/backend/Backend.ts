import type { AppState, Mutation, Settings, WritePolicy, WriteReport } from "../types";

/**
 * Everything the UI needs from the app. Implemented by the Tauri bridge
 * (desktop app) and by MockBackend (browser preview and tests).
 * Methods reject with a `WriteError`-shaped object on failure.
 */
export interface Backend {
  readonly kind: "tauri" | "mock";
  getState(): Promise<AppState>;
  /** Called with a fresh state after every change (sync, write, settings). */
  subscribe(listener: (s: AppState) => void): () => void;
  apply(m: Mutation, opts?: { force?: boolean }): Promise<WriteReport>;
  syncNow(): Promise<void>;
  connect(email: string, password: string): Promise<void>;
  disconnect(forgetCache: boolean): Promise<void>;
  useDemo(): Promise<void>;
  setPolicy(p: WritePolicy): Promise<void>;
  dismissIssue(id: number): Promise<void>;
  reapplyIssue(id: number): Promise<WriteReport>;
  updateSettings(s: Partial<Settings>): Promise<void>;
  /** Demo only: pretend another device edited something. */
  simulateRemoteEdit(): Promise<string>;
  hideQuickEntry(): Promise<void>;
  showMainWindow(): Promise<void>;
}
