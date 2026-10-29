// Glanceable cards in the lower part of the sidebar: today's progress with a
// 7-day chart and streak, what's coming up, and tags.
import { useMemo, useState, type ReactNode } from "react";
import { relativeLabel, todayYmd, weekdayName } from "../lib/dates";
import { comingUp, countdown, progress, tagCounts, type UpcomingItem } from "../lib/insights";
import { belongsTo, type Index } from "../lib/lists";
import { useStore } from "../store";
import type { ListId, Selection, Snapshot } from "../types";
import { ChevronIcon, FlagIcon } from "./Icons";
import { tagMenu, taskMenu } from "./menus";

const COLLAPSE_KEY = "tings3.sidebar.collapsed";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function Section({ id, title, meta, children }: { id: string; title: string; meta?: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => !!loadCollapsed()[id]);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ ...loadCollapsed(), [id]: next }));
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <section className={`side-card${collapsed ? " collapsed" : ""}`} aria-label={title}>
      <button className="side-card-head" onClick={toggle} aria-expanded={!collapsed}>
        <span className="side-card-title">{title}</span>
        {meta && <span className="side-card-meta">{meta}</span>}
        <ChevronIcon size={10} className="side-card-chev" />
      </button>
      {!collapsed && <div className="side-card-body">{children}</div>}
    </section>
  );
}

function ProgressCard({ snap, ix, today }: { snap: Snapshot; ix: Index; today: string }) {
  const p = useMemo(() => progress(snap, ix, today), [snap, ix, today]);
  const total = p.doneToday + p.remaining;
  const pct = total ? Math.round((p.doneToday / total) * 100) : 0;
  const max = Math.max(1, ...p.week.map((d) => d.count));
  const summary = p.streak > 1 ? `${p.weekTotal} done this week · ${p.streak} days in a row` : `${p.weekTotal} done this week`;
  return (
    <Section id="progress" title="Today" meta={total ? `${p.doneToday} of ${total}` : undefined}>
      <div className="prog-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Today's progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="week-chart" aria-label="Completed to-dos, last 7 days">
        {p.week.map((d) => (
          <div key={d.date} className={`wk-col${d.date === today ? " today" : ""}`} title={`${relativeLabel(d.date, today)}: ${d.count} done`}>
            <span className="wk-bar">
              <span style={{ height: `${d.count ? Math.max(14, (d.count / max) * 100) : 0}%` }} />
            </span>
            <span className="wk-day">{weekdayName(d.date, true).slice(0, 2)}</span>
          </div>
        ))}
      </div>
      <div className="side-card-foot">{p.weekTotal || p.doneToday ? summary : "Complete a to-do to start a streak."}</div>
    </Section>
  );
}

function goTo(item: UpcomingItem, ix: Index, today: string) {
  const s = useStore.getState();
  const t = item.task;
  let sel: Selection;
  if (t.type === "project") sel = { kind: "project", id: t.id };
  else if (t.projectId) sel = { kind: "project", id: t.projectId };
  else {
    const list = (["today", "upcoming", "anytime", "someday", "inbox"] as ListId[]).find((l) => belongsTo(l, t, ix, today));
    sel = list ? { kind: "list", id: list } : t.areaId ? { kind: "area", id: t.areaId } : { kind: "list", id: "anytime" };
  }
  s.select(sel);
  if (t.type !== "project") s.selectTask(t.id);
}

function ComingUpCard({ snap, ix, today }: { snap: Snapshot; ix: Index; today: string }) {
  const items = useMemo(() => comingUp(snap, ix, today, 5), [snap, ix, today]);
  return (
    <Section id="upcoming" title="Coming Up" meta={items.length ? `${items.length} ${items.length === 1 ? "item" : "items"}` : undefined}>
      {items.length === 0 ? (
        <div className="side-empty">Nothing scheduled in the next two months.</div>
      ) : (
        <ul className="up-list">
          {items.map((it) => (
            <li key={`${it.task.id}-${it.kind}`}>
              <button
                className="up-row"
                onClick={() => goTo(it, ix, today)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  useStore.getState().openMenu(e, taskMenu(it.task));
                }} title={`${it.kind === "deadline" ? "Deadline" : "Starts"} ${relativeLabel(it.date, today)}`}>
                {it.kind === "deadline" ? <FlagIcon size={11} className="up-flag" /> : <span className="up-dot" />}
                <span className="up-title">{it.task.title || "Untitled"}</span>
                <span className={`up-days${it.days <= 0 ? " now" : it.days <= 7 ? " soon" : ""}`}>{countdown(it.days)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function TagsCard({ snap, ix }: { snap: Snapshot; ix: Index }) {
  const counts = useMemo(() => tagCounts(snap, ix), [snap, ix]);
  const active = useStore((s) => (s.selection.kind === "tag" ? s.selection.id : null));
  const tags = [...snap.tags].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.title.localeCompare(b.title));
  return (
    <Section id="tags" title="Tags" meta={tags.length ? String(tags.length) : undefined}>
      {tags.length === 0 ? (
        <div className="side-empty">Add tags to a to-do to filter by them here.</div>
      ) : (
        <div className="tag-cloud">
          {tags.map((t) => (
            <button
              key={t.id}
              className={`tag-pill${active === t.id ? " active" : ""}`}
              onClick={() => useStore.getState().select({ kind: "tag", id: t.id })}
              onContextMenu={(e) => {
                e.preventDefault();
                useStore.getState().openMenu(e, tagMenu(t));
              }}
            >
              {t.title}
              {!!counts.get(t.id) && <span>{counts.get(t.id)}</span>}
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

export function SidebarWidgets({ snap, ix }: { snap: Snapshot; ix: Index }) {
  const today = todayYmd();
  return (
    <div className="side-widgets">
      <ProgressCard snap={snap} ix={ix} today={today} />
      <ComingUpCard snap={snap} ix={ix} today={today} />
      <TagsCard snap={snap} ix={ix} />
    </div>
  );
}
