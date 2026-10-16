import type { Backend } from "./Backend";
import { MockBackend } from "./mock";
import { TauriBackend } from "./tauri";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let instance: Backend | null = null;

export function getBackend(): Backend {
  instance ??= isTauri() ? new TauriBackend() : new MockBackend();
  return instance;
}

export function setBackendForTests(b: Backend) {
  instance = b;
}

export type { Backend };
