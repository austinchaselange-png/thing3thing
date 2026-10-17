import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isTauri } from "./backend";
import { initTheme } from "./lib/theme";
import { useStore } from "./store";
import "./styles/app.css";

initTheme();
// Dim the traffic lights while the window is in the background, like macOS.
window.addEventListener("blur", () => document.body.classList.add("inactive"));
window.addEventListener("focus", () => document.body.classList.remove("inactive"));

// Menu/tray actions from the Rust side arrive as events.
if (isTauri()) {
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen("tings3:new-task", () => window.dispatchEvent(new Event("tings3:new-task")));
    void listen("tings3:quick-find", () => useStore.getState().openDialog({ kind: "quickFind" }));
    void listen("tings3:settings", () => useStore.getState().openDialog({ kind: "settings" }));
    void listen<{ taskId: string }>("tings3:show-task", (e) => {
      const s = useStore.getState();
      s.select({ kind: "list", id: "today" });
      s.selectTask(e.payload.taskId);
    });
  });
  // Native-feeling: no browser context menu or reload shortcuts in production.
  if (!import.meta.env.DEV) {
    window.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLElement;
      if (!(t.tagName === "INPUT" || t.tagName === "TEXTAREA")) e.preventDefault();
    });
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
