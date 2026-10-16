import { isTauri } from "../backend";

type Action = "close" | "minimize" | "toggleMaximize";

async function act(action: Action) {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "close") await w.close();
  else if (action === "minimize") await w.minimize();
  else await w.toggleMaximize();
}

/** macOS-style traffic lights drawn by the app (the window has no native frame). */
export function TrafficLights() {
  return (
    <div className="traffic">
      <button className="tl tl-close" aria-label="Close" onClick={() => void act("close")}>
        <svg viewBox="0 0 8 8">
          <path d="M2 2l4 4M6 2L2 6" />
        </svg>
      </button>
      <button className="tl tl-min" aria-label="Minimize" onClick={() => void act("minimize")}>
        <svg viewBox="0 0 8 8">
          <path d="M1.5 4h5" />
        </svg>
      </button>
      <button className="tl tl-max" aria-label="Maximize" onClick={() => void act("toggleMaximize")}>
        <svg viewBox="0 0 8 8">
          <path className="fill" d="M2 2h3.2L2 5.2z M6 6H2.8L6 2.8z" />
        </svg>
      </button>
    </div>
  );
}
