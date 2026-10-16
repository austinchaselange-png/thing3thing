import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { moveTo, schedule, trash } from "../actions";
import { todayYmd } from "../lib/dates";
import { buildIndex, countFor, projectProgress, sidebarTree } from "../lib/lists";
import { useStore } from "../store";
import type { ListId, Selection, Task, When } from "../types";
import { AreaIcon, CloudIcon, GearIcon, LaptopIcon, LIST_META, LockIcon, PlusIcon, ProgressPie, WarningIcon } from "./Icons";
import { Popover } from "./Pickers";
import { TrafficLights } from "./WindowControls";

const LISTS: ListId[][] = [["inbox"], ["today", "upcoming", "anytime", "someday"], ["logbook", "trash"]];

function sameSel(a: Selection, b: Selection) {
  return a.kind === b.kind && a.id === b.id;
}

function dropAction(target: Selection): ((t: Task) => void) | null {
  if (target.kind === "project") return (t) => void moveTo(t, { projectId: target.id });
  if (target.kind === "area") return (t) => void moveTo(t, { areaId: target.id });
  if (target.kind !== "list") return null;
  const whenFor: Partial<Record<ListId, When>> = { today: { kind: "today" }, anytime: { kind: "anytime" }, someday: { kind: "someday" } };
  if (target.id === "inbox") return (t) => void moveTo(t, { inbox: true });
  if (target.id === "trash") return (t) => void trash(t);
  const w = whenFor[target.id];
  return w ? (t) => void schedule(t, w) : null;
}

function NavItem({ sel, icon, label, count, badge, strong }: { sel: Selection; icon: ReactNode; label: string; count?: number; badge?: number; strong?: boolean }) {
  const active = useStore((s) => sameSel(s.selection, sel));
  const [over, setOver] = useState(false);
  const action = dropAction(sel);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const id = e.dataTransfer.getData("application/x-cairn-task");
    const t = useStore.getState().view?.tasks.find((x) => x.id === id);
    if (t && action) action(t);
  };
  return (
    <button
      className={`nav-item${active ? " active" : ""}${over ? " drop" : ""}${strong ? " strong" : ""}`}
      onClick={() => useStore.getState().select(sel)}
      onDragOver={(e) => {
        if (action && e.dataTransfer.types.includes("application/x-cairn-task")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      aria-current={active ? "page" : undefined}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {!!badge && <span className="nav-badge">{badge}</span>}
      {!!count && <span className="nav-count">{count}</span>}
    </button>
  );
}

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function SyncIndicator() {
  const app = useStore((s) => s.app)!;
  const pending = useStore((s) => s.pending.length);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const { sync, account, policy, issues } = app;
  let text: string;
  let tone = "ok";
  if (account.mode === "signedOut") {
    text = "Not connected";
    tone = "muted";
  } else if (issues.length) {
    text = "Change needs review";
    tone = "warn";
  } else if (pending) {
    text = "Saving…";
  } else if (sync.phase === "syncing") {
    text = "Syncing…";
  } else if (sync.phase === "error" || sync.phase === "offline" || sync.phase === "rateLimited") {
    text = sync.phase === "offline" ? "Offline" : sync.phase === "rateLimited" ? "Paused (rate limited)" : "Sync error";
    tone = "warn";
  } else {
    text = sync.lastSyncedAt ? `Synced ${ago(sync.lastSyncedAt)}` : "Not synced yet";
  }
  const local = account.mode === "demo" && tone === "ok" && !pending;
  const open = () => {
    const s = useStore.getState();
    if (issues[0]) s.openDialog({ kind: "issue", issue: issues[0] });
    else s.openDialog({ kind: "settings", tab: "sync" });
  };
  return (
    <button className={`sync-indicator ${tone}`} onClick={open} title={sync.lastError ?? text}>
      {tone === "warn" ? <WarningIcon size={13} /> : local ? <LaptopIcon size={13} /> : <CloudIcon size={13} className={sync.phase === "syncing" || pending ? "spin-soft" : ""} />}
      <span>{local ? "Stored on this PC" : text}</span>
      {account.mode === "cloud" && !policy.writes && (
        <span className="ro-badge" title="Read-only: writes to Things Cloud are turned off">
          <LockIcon size={11} /> Read-only
        </span>
      )}
    </button>
  );
}

export function Sidebar() {
  const view = useStore((s) => s.view)!;
  const openDialog = useStore((s) => s.openDialog);
  const ix = useMemo(() => buildIndex(view), [view]);
  const tree = useMemo(() => sidebarTree(view, ix), [view, ix]);
  const today = todayYmd();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const counts = useMemo(() => {
    const overdue = view.tasks.filter((t) => t.type === "task" && t.status === "open" && !t.trashed && t.deadline && t.deadline <= today && t.startDate && t.startDate <= today).length;
    return { inbox: countFor("inbox", view, ix, today), today: countFor("today", view, ix, today), overdue };
  }, [view, ix, today]);

  const project = (p: Task) => {
    const pr = projectProgress(p.id, view);
    return (
      <NavItem
        key={p.id}
        sel={{ kind: "project", id: p.id }}
        icon={<ProgressPie done={pr.done} total={pr.total} size={15} color="var(--c-project)" />}
        label={p.title || "Untitled Project"}
      />
    );
  };

  return (
    <nav className="sidebar" aria-label="Lists">
      <div className="side-top" data-tauri-drag-region>
        <TrafficLights />
      </div>
      <div className="sidebar-scroll">
        {LISTS.map((group, i) => (
          <div className="nav-group" key={i}>
            {group.map((id) => {
              const m = LIST_META[id];
              return (
                <NavItem
                  key={id}
                  sel={{ kind: "list", id }}
                  icon={<m.Icon style={{ color: m.color }} />}
                  label={m.title}
                  count={id === "inbox" ? counts.inbox : id === "today" ? counts.today : undefined}
                  badge={id === "today" ? counts.overdue : undefined}
                />
              );
            })}
          </div>
        ))}
        {tree.looseProjects.length > 0 && <div className="nav-group">{tree.looseProjects.map(project)}</div>}
        {tree.areas.map(({ area, projects }) => (
          <div className="nav-group" key={area.id}>
            <NavItem sel={{ kind: "area", id: area.id }} icon={<AreaIcon style={{ color: "var(--c-area)" }} />} label={area.title || "Untitled Area"} strong />
            {projects.map(project)}
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <button className="new-list" onClick={(e) => setMenuAnchor(e.currentTarget)}>
          <PlusIcon size={14} /> New List
        </button>
        <span className="grow" />
        <button className="icon-btn" aria-label="Settings" title="Settings (Ctrl+,)" onClick={() => openDialog({ kind: "settings" })}>
          <GearIcon />
        </button>
      </div>
      <SyncIndicator />
      {menuAnchor && (
        <Popover anchor={menuAnchor} onClose={() => setMenuAnchor(null)} width={240}>
          <NewListMenu onDone={() => setMenuAnchor(null)} />
        </Popover>
      )}
    </nav>
  );
}

function NewListMenu({ onDone }: { onDone: () => void }) {
  const apply = useStore((s) => s.apply);
  const [mode, setMode] = useState<"project" | "area" | null>(null);
  const [title, setTitle] = useState("");
  const create = async () => {
    if (!title.trim()) return;
    const r =
      mode === "project"
        ? await apply({ type: "createTask", kind: "project", title, when: { kind: "anytime" } })
        : await apply({ type: "createArea", title });
    onDone();
    if (r?.created[0]) useStore.getState().select({ kind: mode === "project" ? "project" : "area", id: r.created[0] });
  };
  if (!mode)
    return (
      <>
        <button className="menu-item stacked" onClick={() => setMode("project")}>
          <ProgressPie done={0} total={1} color="var(--c-project)" />
          <span>
            <strong>New Project</strong>
            <small>Define a goal, then work towards it one to-do at a time.</small>
          </span>
        </button>
        <button className="menu-item stacked" onClick={() => setMode("area")}>
          <AreaIcon style={{ color: "var(--c-area)" }} />
          <span>
            <strong>New Area</strong>
            <small>Group projects and to-dos for an area of responsibility.</small>
          </span>
        </button>
      </>
    );
  return (
    <div className="new-list-form">
      <div className="picker-title">{mode === "project" ? "New Project" : "New Area"}</div>
      <input className="picker-input" autoFocus value={title} placeholder="Name" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
      <button className="btn primary" onClick={() => void create()} disabled={!title.trim()}>
        Create
      </button>
    </div>
  );
}
