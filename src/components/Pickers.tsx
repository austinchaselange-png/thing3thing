import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { buildIndex, isLive, sidebarTree } from "../lib/lists";
import { addDays, monthGrid, monthName, parseYmd, relativeLabel, todayYmd } from "../lib/dates";
import { parseTime, parseWhenPhrase } from "../lib/quickParse";
import { useStore } from "../store";
import type { Task, When } from "../types";
import { AreaIcon, BellIcon, BoxIcon, ChevronIcon, HeadingIcon, InboxIcon, LayersIcon, MoonIcon, ProgressPie, StarIcon, TagIcon } from "./Icons";

export function Popover({ anchor, onClose, children, width = 260 }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 300;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = r ? r.bottom + 6 : vh / 3;
    if (top + h > vh - 8) top = Math.max(8, (r ? r.top : vh) - h - 6);
    let left = r ? r.left : vw / 2 - width / 2;
    left = Math.min(Math.max(8, left), vw - width - 8);
    setPos({ top, left });
  }, [anchor, width]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="popover-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="popover" style={{ top: pos.top, left: pos.left, width }} role="dialog">
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Calendar({ selected, onPick, min }: { selected: string | null; onPick: (d: string) => void; min?: string }) {
  const today = todayYmd();
  const initial = parseYmd(selected ?? today);
  const [cursor, setCursor] = useState({ y: initial.getFullYear(), m: initial.getMonth() });
  const days = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);
  const shift = (n: number) => setCursor(({ y, m }) => ({ y: m + n < 0 ? y - 1 : m + n > 11 ? y + 1 : y, m: (m + n + 12) % 12 }));
  return (
    <div className="calendar">
      <div className="calendar-head">
        <button className="icon-btn" onClick={() => shift(-1)} aria-label="Previous month">
          <ChevronIcon style={{ transform: "rotate(180deg)" }} />
        </button>
        <span>
          {monthName(cursor.m)} {cursor.y}
        </span>
        <button className="icon-btn" onClick={() => shift(1)} aria-label="Next month">
          <ChevronIcon />
        </button>
      </div>
      <div className="calendar-grid">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i} className="calendar-dow">
            {d}
          </span>
        ))}
        {days.map((d) => {
          const date = parseYmd(d);
          const outside = date.getMonth() !== cursor.m;
          const disabled = !!min && d < min;
          return (
            <button
              key={d}
              disabled={disabled}
              className={`calendar-day${outside ? " outside" : ""}${d === selected ? " selected" : ""}${d === today ? " today" : ""}`}
              onClick={() => onPick(d)}
              aria-label={d}
            >
              {d === today ? <StarIcon size={11} /> : date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function WhenPicker({
  anchor,
  task,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  task?: Pick<Task, "start" | "startDate" | "evening" | "reminder" | "type">;
  onPick: (when: When, reminder?: string | null) => void;
  onClose: () => void;
}) {
  const today = todayYmd();
  const [text, setText] = useState("");
  const [reminderOpen, setReminderOpen] = useState(!!task?.reminder);
  const [reminder, setReminder] = useState(task?.reminder ?? "09:00");
  const parsed = text ? parseWhenPhrase(text, today) : null;
  const finish = (w: When) => {
    const hasDate = w.kind === "today" || w.kind === "evening" || w.kind === "date";
    let r: string | null | undefined;
    if (reminderOpen && hasDate) r = parseTime(reminder) ?? reminder;
    else if (!reminderOpen && task?.reminder) r = null;
    onPick(w, r);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={250}>
      <div className="picker-title">When</div>
      <input
        className="picker-input"
        autoFocus
        placeholder="Type a date (e.g. “next fri”)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && parsed && finish(parsed)}
      />
      {text && (
        <div className="picker-hint">{parsed ? (parsed.kind === "date" ? relativeLabel(parsed.date, today) : parsed.kind) : "No match"}</div>
      )}
      <button className="menu-item" onClick={() => finish({ kind: "today" })}>
        <StarIcon style={{ color: "var(--c-today)" }} /> Today
      </button>
      <button className="menu-item" onClick={() => finish({ kind: "evening" })}>
        <MoonIcon style={{ color: "var(--c-evening)" }} /> This Evening
      </button>
      <Calendar selected={task?.startDate ?? null} onPick={(d) => finish({ kind: "date", date: d })} min={today} />
      <button className="menu-item" onClick={() => finish({ kind: "someday" })}>
        <BoxIcon style={{ color: "var(--c-someday)" }} /> Someday
      </button>
      {reminderOpen ? (
        <div className="reminder-row">
          <BellIcon />
          <input type="time" value={reminder} onChange={(e) => setReminder(e.target.value)} aria-label="Reminder time" />
          <button className="link-btn" onClick={() => setReminderOpen(false)}>
            Remove
          </button>
        </div>
      ) : (
        <button className="menu-item subtle" onClick={() => setReminderOpen(true)}>
          <BellIcon /> Add Reminder
        </button>
      )}
      {task && (task.startDate || task.start === "someday") && (
        <button className="picker-clear" onClick={() => finish({ kind: "anytime" })}>
          Clear
        </button>
      )}
    </Popover>
  );
}

export function DeadlinePicker({ anchor, value, onPick, onClose }: { anchor: HTMLElement | null; value: string | null; onPick: (d: string | null) => void; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={250}>
      <div className="picker-title">Deadline</div>
      <Calendar
        selected={value}
        onPick={(d) => {
          onPick(d);
          onClose();
        }}
      />
      <div className="quick-dates">
        {[0, 1, 7].map((n) => (
          <button key={n} className="chip" onClick={() => (onPick(addDays(todayYmd(), n)), onClose())}>
            {n === 0 ? "Today" : n === 1 ? "Tomorrow" : "In a week"}
          </button>
        ))}
      </div>
      {value && (
        <button className="picker-clear" onClick={() => (onPick(null), onClose())}>
          Clear Deadline
        </button>
      )}
    </Popover>
  );
}

export function TagPicker({ anchor, value, onChange, onClose }: { anchor: HTMLElement | null; value: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const tags = useStore((s) => s.view?.tags) ?? [];
  const apply = useStore((s) => s.apply);
  const [filter, setFilter] = useState("");
  const shown = tags.filter((t) => t.title.toLowerCase().includes(filter.toLowerCase()));
  const exact = tags.some((t) => t.title.toLowerCase() === filter.trim().toLowerCase());
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const create = async () => {
    const r = await apply({ type: "createTag", title: filter.trim() });
    if (r?.created[0]) onChange([...value, r.created[0]]);
    setFilter("");
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={230}>
      <div className="picker-title">Tags</div>
      <input
        className="picker-input"
        autoFocus
        placeholder="Filter or create tag"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (shown.length === 1) toggle(shown[0].id);
            else if (filter.trim() && !exact) void create();
          }
        }}
      />
      <div className="menu-scroll">
        {shown.map((t) => (
          <button key={t.id} className={`menu-item${value.includes(t.id) ? " checked" : ""}`} onClick={() => toggle(t.id)} role="menuitemcheckbox" aria-checked={value.includes(t.id)}>
            <TagIcon /> <span className="grow">{t.title}</span>
            {value.includes(t.id) && <span className="check">✓</span>}
          </button>
        ))}
        {filter.trim() && !exact && (
          <button className="menu-item subtle" onClick={() => void create()}>
            + New tag “{filter.trim()}”
          </button>
        )}
        {!shown.length && !filter && <div className="picker-hint">No tags yet</div>}
      </div>
    </Popover>
  );
}

export interface MoveTarget {
  areaId?: string | null;
  projectId?: string | null;
  headingId?: string | null;
  inbox?: boolean;
}

export function MovePicker({ anchor, task, onPick, onClose }: { anchor: HTMLElement | null; task: Task; onPick: (t: MoveTarget) => void; onClose: () => void }) {
  const view = useStore((s) => s.view)!;
  const ix = useMemo(() => buildIndex(view), [view]);
  const tree = useMemo(() => sidebarTree(view, ix), [view, ix]);
  const [filter, setFilter] = useState("");
  const f = filter.toLowerCase();
  const headings = (projectId: string) => view.tasks.filter((t) => t.type === "heading" && t.projectId === projectId && isLive(t, ix));
  const pick = (t: MoveTarget) => {
    onPick(t);
    onClose();
  };
  const isProject = task.type === "project";
  const projectRow = (p: Task) => {
    if (isProject) return null;
    const hs = headings(p.id);
    return (
      <div key={p.id}>
        {(!f || p.title.toLowerCase().includes(f)) && (
          <button className="menu-item indent" onClick={() => pick({ projectId: p.id })}>
            <ProgressPie done={0} total={1} size={14} color="var(--c-project)" /> {p.title || "Untitled Project"}
          </button>
        )}
        {hs
          .filter((h) => !f || h.title.toLowerCase().includes(f))
          .map((h) => (
            <button key={h.id} className="menu-item indent2" onClick={() => pick({ headingId: h.id })}>
              <HeadingIcon /> {h.title}
            </button>
          ))}
      </div>
    );
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={260}>
      <div className="picker-title">Move</div>
      <input className="picker-input" autoFocus placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="menu-scroll tall">
        {!isProject && !f && (
          <button className="menu-item" onClick={() => pick({ inbox: true })}>
            <InboxIcon style={{ color: "var(--c-inbox)" }} /> Inbox
          </button>
        )}
        {!f && (
          <button className="menu-item" onClick={() => pick({})}>
            <LayersIcon style={{ color: "var(--c-anytime)" }} /> No Project or Area
          </button>
        )}
        {tree.looseProjects.map(projectRow)}
        {tree.areas.map(({ area, projects }) => (
          <div key={area.id}>
            {(!f || area.title.toLowerCase().includes(f) || projects.some((p) => p.title.toLowerCase().includes(f))) && (
              <button className="menu-item" onClick={() => pick({ areaId: area.id })}>
                <AreaIcon /> {area.title}
              </button>
            )}
            {projects.map(projectRow)}
          </div>
        ))}
      </div>
    </Popover>
  );
}
