import { useEffect, useState } from "react";
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

function useMaximized(): boolean {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const sync = async () => {
        if (alive) setMax(await w.isMaximized());
      };
      await sync();
      off = await w.onResized(() => void sync());
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return max;
}

/**
 * Windows-style caption buttons (minimize, maximize/restore, close) for the
 * top-right corner. The window has no native frame, so the app draws them,
 * following the Segoe Fluent caption glyphs.
 */
export function CaptionButtons() {
  const maximized = useMaximized();
  return (
    <div className="caption" role="group" aria-label="Window">
      <button className="cap" aria-label="Minimize" title="Minimize" onClick={() => void act("minimize")}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button className="cap" aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore Down" : "Maximize"} onClick={() => void act("toggleMaximize")}>
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5V1.2c0-.4.3-.7.7-.7h5.6c.4 0 .7.3.7.7v5.6c0 .4-.3.7-.7.7H7.5" />
            <rect x="0.5" y="2.5" width="7" height="7" rx="0.7" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" rx="0.8" />
          </svg>
        )}
      </button>
      <button className="cap cap-close" aria-label="Close" title="Close" onClick={() => void act("close")}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
