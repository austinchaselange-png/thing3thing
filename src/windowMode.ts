// Which window this is. The main window shows everything; a project window
// (opened with "Open in New Window") runs the same UI locked to one project.
import { getBackend, isTauri } from "./backend";
import type { Task } from "./types";

const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : null;

/** The project this window is dedicated to, or null in the main window. */
export const projectWindowId: string | null = params?.get("window") === "project" ? params.get("id") || null : null;

export function isProjectWindow(): boolean {
  return projectWindowId !== null;
}

/** Opens a project in a window of its own (focuses it if already open). */
export async function openProjectWindow(project: Pick<Task, "id" | "title">) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_project_window", { id: project.id, title: project.title });
    return;
  }
  // Browser preview: a new tab with the same flags.
  const next = new URLSearchParams(location.search);
  next.set("window", "project");
  next.set("id", project.id);
  window.open(`${location.pathname}?${next}`, `project-${project.id}`, "width=760,height=680");
}

/** Brings the main window forward (from a project window). */
export function showMainWindow() {
  void getBackend()
    .showMainWindow()
    .catch(() => {});
}
