import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { bulkMove, bulkSchedule, bulkTrash } from "../actions";
import { drag, endDrag, reorderSidebar, startDrag, TASK_MIME } from "../dnd";
import { todayYmd } from "../lib/dates";
import { buildIndex, countFor, projectProgress, sidebarTree } from "../lib/lists";
import { useStore } from "../store";
import type { ListId, Selection, Task, When } from "../types";
import { AreaIcon, ChevronIcon, GearIcon, LIST_META, LockIcon, PlusIcon, ProgressPie, WarningIcon } from "./Icons";
import { areaMenu, listMenu, tagMenu, taskMenu } from "./menus";
import { Popover } from "./Pickers";
import { SidebarWidgets } from "./SidebarWidgets";

const LISTS: ListId[][] = [["inbox"], ["today", "upcoming", "anytime", "someday"], ["logbook", "trash"]];

function sameSel(a: Selection, b: Selection) {
  return a.kind === b.kind && a.id === b.id;
}

function dropAction(target: Selection): ((ts: Task[]) => void) | null {
  if (target.kind === "project") return (ts) => void bulkMove(ts.filter((t) => t.id !== target.id), { projectId: target.id });
  if (target.kind === "area") return (ts) => void bulkMove(ts, { areaId: target.id });
  if (target.kind !== "list") return null;
  const whenFor: Partial<Record<ListId, When>> = { today: { kind: "today" }, anytime: { kind: "anytime" }, someday: { kind: "someday" } };
  if (target.id === "inbox") return (ts) => void bulkMove(ts, { inbox: true });
  if (target.id === "trash") return (ts) => void bulkTrash(ts);
  const w = whenFor[target.id];
  return w ? (ts) => void bulkSchedule(ts, w) : null;
}

function menuFor(sel: Selection) {
  const v = useStore.getState().view;
  if (!v) return [];
  if (sel.kind === "list") return listMenu(sel.id);
  if (sel.kind === "area") {
    const a = v.areas.find((x) => x.id === sel.id);
    return a ? areaMenu(a) : [];
  }
  if (sel.kind === "tag") {
    const t = v.tags.find((x) => x.id === sel.id);
    return t ? tagMenu(t) : [];
  }
  const p = v.tasks.find((x) => x.id === sel.id);
  return p ? taskMenu(p) : [];
}

/** Sidebar drag: projects reorder among their siblings, areas among areas. */
interface Reorderable {
  kind: "project" | "area";
  /** Projects: the area they're in (null for loose projects). */
  areaId?: string | null;
  siblings: () => { id: string; index: number }[];
}

function NavItem({
  sel,
  icon,
  label,
  count,
  badge,
  strong,
  reorder,
  collapse,
}: {
  sel: Selection;
  icon: ReactNode;
  label: string;
  count?: number;
  badge?: number;
  strong?: boolean;
  reorder?: Reorderable;
  /** Areas: a chevron that hides their projects. */
  collapse?: { collapsed: boolean; toggle: () => void; hidden: number };
}) {
  const active = useStore((s) => sameSel(s.selection, sel));
  const [over, setOver] = useState(false);
  const [line, setLine] = useState<"above" | "below" | null>(null);
  const action = dropAction(sel);
  /** A project dragged onto a project, or an area onto an area: reorder instead of moving into it. */
  const reorderTarget = () => !!reorder && drag.kind === reorder.kind && !drag.ids.includes(sel.id);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (drag.kind === "plus") {
      endDrag();
      useStore.getState().select(sel);
      setTimeout(() => window.dispatchEvent(new Event("tings3:new-task")), 0);
      return;
    }
    if (reorder && reorderTarget()) {
      const ids = [...drag.ids];
      const where = line;
      setLine(null);
      endDrag();
      void (async () => {
        const v = useStore.getState().view;
        // A project dropped among another area's projects moves into that area first.
        if (reorder.kind === "project") {
          const moving = (v?.tasks ?? []).filter((t) => ids.includes(t.id) && (t.areaId ?? null) !== (reorder.areaId ?? null));
          if (moving.length) await bulkMove(moving, { areaId: reorder.areaId ?? null });
        }
        const sibs = reorder.siblings();
        const i = sibs.findIndex((s) => s.id === sel.id);
        const before = where === "below" ? (sibs[i + 1]?.id ?? null) : sel.id;
        const fresh = useStore.getState().view;
        const indexOf = (id: string) => fresh?.tasks.find((t) => t.id === id)?.index ?? fresh?.areas.find((a) => a.id === id)?.index ?? 0;
        const all = [...sibs.filter((s) => !ids.includes(s.id)), ...ids.map((id) => ({ id, index: indexOf(id) }))];
        await reorderSidebar(reorder.kind, ids, all, before);
      })();
      return;
    }
    setLine(null);
    const ids = e.dataTransfer.getData(TASK_MIME).split("\n").filter(Boolean);
    const byId = new Map((useStore.getState().view?.tasks ?? []).map((t) => [t.id, t]));
    const tasks = ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
    if (tasks.length && action) action(tasks);
  };
  return (
    <button
      className={`nav-item${active ? " active" : ""}${over ? " drop" : ""}${strong ? " strong" : ""}${line ? ` line-${line}` : ""}`}
      onClick={() => useStore.getState().select(sel)}
      onContextMenu={(e) => {
        e.preventDefault();
        useStore.getState().openMenu(e, menuFor(sel));
      }}
      draggable={!!reorder && useStore.getState().canWrite()}
      onDragStart={(e) => reorder && startDrag(reorder.kind, [sel.id], e, reorder.kind === "project" ? TASK_MIME : "application/x-tings3-area")}
      onDragEnd={() => {
        endDrag();
        setLine(null);
      }}
      onDragOver={(e) => {
        if (drag.kind === "plus") {
          // Magic Plus onto a list, project or area: start a new to-do there.
          if (sel.kind === "list" && (sel.id === "logbook" || sel.id === "trash")) return;
          if (sel.kind === "tag") return;
          e.preventDefault();
          setOver(true);
          return;
        }
        if (reorderTarget()) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setLine(e.clientY > r.top + r.height / 2 ? "below" : "above");
          return;
        }
        if (drag.kind === "area") return;
        if (action && e.dataTransfer.types.includes(TASK_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => {
        setOver(false);
        setLine(null);
      }}
      onDrop={onDrop}
      aria-current={active ? "page" : undefined}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {collapse && (
        <span
          className={`nav-collapse${collapse.collapsed ? " collapsed" : ""}`}
          role="button"
          tabIndex={-1}
          aria-label={collapse.collapsed ? `Show ${collapse.hidden} projects` : "Hide projects"}
          title={collapse.collapsed ? `Show ${collapse.hidden} project${collapse.hidden === 1 ? "" : "s"}` : "Hide projects"}
          onClick={(e) => {
            e.stopPropagation();
            collapse.toggle();
          }}
        >
          <ChevronIcon size={9} />
        </span>
      )}
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

function savedAt(ms: number) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function SyncIndicator() {
  const app = useStore((s) => s.app)!;
  const pending = useStore((s) => s.pending.length);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const { sync, account, issues } = app;
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
      {tone === "warn" ? (
        <WarningIcon size={12} />
      ) : (
        <span className={`status-dot ${tone}${sync.phase === "syncing" || pending ? " busy" : ""}`} aria-hidden="true" />
      )}
      <span className="status-text">{local ? (sync.lastSyncedAt ? `Saved ${savedAt(sync.lastSyncedAt)} · on this PC` : "Stored on this PC") : text}</span>
      {account.mode === "cloud" && !app.canWrite && (
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
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("tings3.collapsedAreas") ?? "[]");
    } catch {
      return [];
    }
  });
  const toggleArea = (id: string) =>
    setCollapsed((list) => {
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      try {
        localStorage.setItem("tings3.collapsedAreas", JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  const counts = useMemo(() => {
    const overdue = view.tasks.filter((t) => t.type === "task" && t.status === "open" && !t.trashed && t.deadline && t.deadline <= today && t.startDate && t.startDate <= today).length;
    return { inbox: countFor("inbox", view, ix, today), today: countFor("today", view, ix, today), overdue };
  }, [view, ix, today]);

  const project = (p: Task, _i: number, siblings: Task[]) => {
    const pr = projectProgress(p.id, view);
    return (
      <NavItem
        key={p.id}
        sel={{ kind: "project", id: p.id }}
        icon={<ProgressPie done={pr.done} total={pr.total} size={15} color="var(--c-project)" dashed={p.start === "someday" && !p.startDate} />}
        label={p.title || "Untitled Project"}
        reorder={{ kind: "project", areaId: p.areaId && view.areas.some((a) => a.id === p.areaId) ? p.areaId : null, siblings: () => siblings.map((s) => ({ id: s.id, index: s.index })) }}
      />
    );
  };
  const areaSiblings = () => tree.areas.map(({ area }) => ({ id: area.id, index: area.index }));

  return (
    <nav className="sidebar" aria-label="Lists">
      <div className="side-top" data-tauri-drag-region>
        <img className="brand-icon" src="/app-icon.png" alt="" data-tauri-drag-region />
        <span className="brand-name" data-tauri-drag-region>
          Things 3
        </span>
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
            <NavItem
              sel={{ kind: "area", id: area.id }}
              icon={<AreaIcon style={{ color: "var(--c-area)" }} />}
              label={area.title || "Untitled Area"}
              strong
              reorder={{ kind: "area", siblings: areaSiblings }}
              collapse={projects.length ? { collapsed: collapsed.includes(area.id), toggle: () => toggleArea(area.id), hidden: projects.length } : undefined}
            />
            {!collapsed.includes(area.id) && projects.map(project)}
          </div>
        ))}
        <SidebarWidgets snap={view} ix={ix} />
      </div>
      <div className="sidebar-foot">
        <div className="foot-row">
          <button className="settings-row" title="Settings (Ctrl+,)" onClick={() => openDialog({ kind: "settings" })}>
            <GearIcon size={16} /> Settings
          </button>
          <span className="grow" />
          <button className="new-list" title="New Project or Area" onClick={(e) => setMenuAnchor(e.currentTarget)}>
            <PlusIcon size={13} /> New List
          </button>
        </div>
        <SyncIndicator />
      </div>
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
