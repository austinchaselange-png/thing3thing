// Right-click menus. One menu is open at a time (store.menu). Supports
// keyboard navigation, nested submenus, disabled items with reasons, shortcut
// hints, and stays inside the window.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore, type MenuItem } from "../store";
import { ChevronIcon } from "./Icons";

type Entry = Exclude<MenuItem, { separator: true }>;

const isEntry = (i: MenuItem): i is Entry => !i.separator;
const enabled = (i: MenuItem) => isEntry(i) && !i.disabled;

function MenuPanel({
  items,
  x,
  y,
  depth,
  altX,
  onClose,
  onBack,
  autoFocusFirst,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  depth: number;
  /** For submenus: the parent row's left edge, used to flip left near the screen edge. */
  altX?: number;
  onClose: () => void;
  onBack?: () => void;
  autoFocusFirst: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  const [active, setActive] = useState<number>(autoFocusFirst ? items.findIndex(enabled) : -1);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subFocus, setSubFocus] = useState(false);
  const hoverTimer = useRef<number | undefined>(undefined);

  // Keep the menu on screen; submenus flip to the left when needed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + w > vw - 6) left = altX !== undefined ? Math.max(6, altX - w) : Math.max(6, vw - w - 6);
    if (top + h > vh - 6) top = Math.max(6, vh - h - 6);
    setPos({ left, top, ready: true });
  }, [x, y, altX]);

  // The top menu takes focus; a submenu only when entered with the keyboard.
  useEffect(() => {
    if (depth === 0) ref.current?.focus({ preventScroll: true });
  }, [depth]);

  // Keyboard entered this (sub)menu: highlight the first usable item.
  useEffect(() => {
    if (!autoFocusFirst) return;
    setActive((a) => (a >= 0 ? a : items.findIndex(enabled)));
    ref.current?.focus({ preventScroll: true });
  }, [autoFocusFirst, items]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const choose = (i: number) => {
    const item = items[i];
    if (!isEntry(item) || item.disabled) return;
    if (item.submenu) {
      setOpenSub(i);
      setSubFocus(true);
      return;
    }
    onClose();
    item.onSelect?.();
  };

  const move = (dir: 1 | -1) => {
    if (!items.some(enabled)) return;
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (enabled(items[i])) break;
    }
    setActive(i);
    setOpenSub(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (subFocus) return; // the open submenu handles keys
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setActive(items.findIndex(enabled));
        break;
      case "End":
        e.preventDefault();
        setActive(items.length - 1 - [...items].reverse().findIndex(enabled));
        break;
      case "ArrowRight": {
        e.preventDefault();
        const item = items[active];
        if (item && isEntry(item) && item.submenu && !item.disabled) {
          setOpenSub(active);
          setSubFocus(true);
        }
        break;
      }
      case "ArrowLeft":
        e.preventDefault();
        onBack?.();
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (active >= 0) choose(active);
        break;
      case "Escape":
        e.preventDefault();
        if (onBack) onBack();
        else onClose();
        break;
      case "Tab":
        e.preventDefault();
        move(e.shiftKey ? -1 : 1);
        break;
    }
  };

  const sub = openSub !== null ? items[openSub] : null;
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const subRect = openSub !== null ? rowRefs.current[openSub]?.getBoundingClientRect() : undefined;

  return (
    <>
      <div
        ref={ref}
        className={`ctx-menu${pos.ready ? " ready" : ""}`}
        style={{ left: pos.left, top: pos.top }}
        role="menu"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, i) =>
          !isEntry(item) ? (
            <div key={`sep${i}`} className="ctx-sep" role="separator" />
          ) : (
            <button
              key={`${item.label}${i}`}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              className={`ctx-item${i === active ? " active" : ""}${item.danger ? " danger" : ""}`}
              role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={item.checked}
              aria-disabled={item.disabled || undefined}
              aria-haspopup={item.submenu ? "menu" : undefined}
              aria-expanded={item.submenu ? openSub === i : undefined}
              title={item.hint}
              tabIndex={-1}
              onMouseEnter={() => {
                setActive(i);
                window.clearTimeout(hoverTimer.current);
                hoverTimer.current = window.setTimeout(() => {
                  setOpenSub(item.submenu && !item.disabled ? i : null);
                  setSubFocus(false);
                }, item.submenu ? 120 : 200);
              }}
              onClick={() => choose(i)}
            >
              <span className="ctx-icon">{item.checked ? "✓" : item.icon}</span>
              <span className="ctx-label">{item.label}</span>
              {item.shortcut && <kbd className="ctx-kbd">{item.shortcut}</kbd>}
              {item.submenu && <ChevronIcon size={10} className="ctx-chev" />}
            </button>
          ),
        )}
      </div>
      {sub && isEntry(sub) && sub.submenu && subRect && (
        <MenuPanel
          key={openSub}
          items={sub.submenu}
          x={subRect.right + 2}
          altX={subRect.left - 2}
          y={subRect.top - 5}
          depth={depth + 1}
          onClose={onClose}
          autoFocusFirst={subFocus}
          onBack={() => {
            setOpenSub(null);
            setSubFocus(false);
            ref.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const close = useStore((s) => s.closeMenu);

  useEffect(() => {
    if (!menu) return;
    const onScroll = (e: Event) => {
      if (!(e.target as HTMLElement)?.closest?.(".ctx-menu")) close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  if (!menu) return null;
  return createPortal(
    <div
      className="ctx-layer"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onContextMenu={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <MenuPanel key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} depth={0} onClose={close} autoFocusFirst={false} />
    </div>,
    document.body,
  );
}
