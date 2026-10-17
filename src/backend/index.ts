import type { Backend } from "./Backend";
import { MockBackend } from "./mock";
import { mockSnapshot } from "./mockData";
import { TauriBackend } from "./tauri";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let instance: Backend | null = null;

export function getBackend(): Backend {
  // Browser preview only: `npm run dev` then open /?sample to load sample data.
  const sample = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("sample");
  instance ??= isTauri() ? new TauriBackend() : new MockBackend(sample ? { snapshot: () => mockSnapshot() } : {});
  return instance;
}

export function setBackendForTests(b: Backend) {
  instance = b;
}

export type { Backend };
