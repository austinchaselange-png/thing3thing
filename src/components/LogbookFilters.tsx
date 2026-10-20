// Search and filters above the Logbook: text search, period, status, type,
// project/area, a summary of what's shown, and "copy as text".
import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { copyText } from "../actions";
import { relativeLabel, todayYmd } from "../lib/dates";
import { EMPTY_LOGBOOK_FILTER, isLogbookFiltered, logbookStats, periodRange, type LogbookFilter, type LogPeriod } from "../lib/lists";
import type { Group } from "../lib/lists";
import type { Snapshot } from "../types";
import { ClipboardIcon, CloseIcon, SearchIcon } from "./Icons";

/** Kept for the session, so the Logbook comes back the way you left it. */
export const useLogbookFilter = create<{ filter: LogbookFilter; set(patch: Partial<LogbookFilter>): void; reset(): void }>((set) => ({
  filter: EMPTY_LOGBOOK_FILTER,
  set: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
  reset: () => set({ filter: EMPTY_LOGBOOK_FILTER }),
}));

const PERIODS: [LogPeriod, string][] = [
  ["all", "Any Time"],
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["week", "This Week"],
  ["lastWeek", "Last Week"],
  ["7d", "Last 7 Days"],
  ["30d", "Last 30 Days"],
  ["month", "This Month"],
  ["year", "This Year"],
  ["custom", "Custom Range…"],
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function LogbookFilters({ view, shown, total }: { view: Snapshot; shown: Group[]; total: number }) {
  const filter = useLogbookFilter((s) => s.filter);
  const set = useLogbookFilter((s) => s.set);
  const reset = useLogbookFilter((s) => s.reset);
  const searchRef = useRef<HTMLInputElement>(null);
  const today = todayYmd();
  const filtered = isLogbookFiltered(filter);
  const items = useMemo(() => shown.flatMap((g) => g.tasks), [shown]);
  const stats = useMemo(() => logbookStats(items), [items]);

  // Projects and areas that actually have logged items, for the picker.
  const containers = useMemo(() => {
    const projectIds = new Set<string>();
    const areaIds = new Set<string>();
    const byId = new Map(view.tasks.map((t) => [t.id, t]));
    for (const t of view.tasks) {
      if (t.trashed || t.status === "open" || t.type === "heading") continue;
      if (t.projectId) projectIds.add(t.projectId);
      if (t.type === "project") projectIds.add(t.id);
      const area = t.areaId ?? (t.projectId ? byId.get(t.projectId)?.areaId : null);
      if (area) areaIds.add(area);
    }
    return {
      areas: view.areas.filter((a) => areaIds.has(a.id)).sort((a, b) => a.title.localeCompare(b.title)),
      projects: [...projectIds].map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p && p.type === "project").sort((a, b) => a.title.localeCompare(b.title)),
    };
  }, [view]);

  // Ctrl+Shift+F jumps to the Logbook search (Ctrl+F stays Quick Find).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopImmediatePropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const range = periodRange(filter, today);
  const rangeText = range.from && range.to ? (range.from === range.to ? relativeLabel(range.from, today) : `${relativeLabel(range.from, today)} – ${relativeLabel(range.to, today)}`) : range.from ? `since ${relativeLabel(range.from, today)}` : range.to ? `until ${relativeLabel(range.to, today)}` : null;

  const copy = () => {
    const lines: string[] = [];
    const title = `Logbook${rangeText ? ` · ${rangeText}` : ""}${filter.query.trim() ? ` · “${filter.query.trim()}”` : ""}`;
    lines.push(title, "");
    const byId = new Map(view.tasks.map((t) => [t.id, t]));
    for (const g of shown) {
      lines.push(g.title ?? "");
      for (const t of g.tasks) {
        const where = t.projectId ? byId.get(t.projectId)?.title : null;
        lines.push(`${t.status === "canceled" ? "✕" : "✓"} ${t.title || "New To-Do"}${t.type === "project" ? " (project)" : ""}${where ? ` — ${where}` : ""}`);
      }
      lines.push("");
    }
    void copyText(lines.join("\n").trim(), `Copied ${plural(items.length, "item")}`);
  };

  return (
    <div className="logbook-filters" role="search" aria-label="Search and filter the Logbook">
      <div className="lf-row">
        <label className="lf-search">
          <SearchIcon size={13} />
          <input
            ref={searchRef}
            value={filter.query}
            placeholder="Search the Logbook"
            aria-label="Search the Logbook"
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filter.query) {
                e.stopPropagation();
                set({ query: "" });
              }
            }}
          />
          {filter.query && (
            <button className="lf-clear" aria-label="Clear search" onClick={() => set({ query: "" })}>
              <CloseIcon size={10} />
            </button>
          )}
        </label>
      </div>
      <div className="lf-row lf-controls">
        <select className="lf-select" value={filter.period} aria-label="When completed" onChange={(e) => set({ period: e.target.value as LogPeriod })}>
          {PERIODS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {filter.period === "custom" && (
          <span className="lf-range">
            <input type="date" aria-label="From" value={filter.from ?? ""} max={today} onChange={(e) => set({ from: e.target.value || null })} />
            <span>–</span>
            <input type="date" aria-label="To" value={filter.to ?? ""} max={today} onChange={(e) => set({ to: e.target.value || null })} />
          </span>
        )}
        <div className="lf-seg" role="radiogroup" aria-label="Status">
          {(
            [
              ["all", "All"],
              ["completed", "Completed"],
              ["canceled", "Canceled"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} role="radio" aria-checked={filter.status === v} className={filter.status === v ? "on" : ""} onClick={() => set({ status: v })}>
              {l}
            </button>
          ))}
        </div>
        <select className="lf-select" value={filter.kind} aria-label="Type" onChange={(e) => set({ kind: e.target.value as LogbookFilter["kind"] })}>
          <option value="all">To-Dos & Projects</option>
          <option value="task">To-Dos</option>
          <option value="project">Projects</option>
        </select>
        {(containers.areas.length > 0 || containers.projects.length > 0) && (
          <select className="lf-select lf-container" value={filter.container ?? ""} aria-label="Project or area" onChange={(e) => set({ container: e.target.value || null })}>
            <option value="">All Projects & Areas</option>
            {containers.areas.length > 0 && (
              <optgroup label="Areas">
                {containers.areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title || "Untitled Area"}
                  </option>
                ))}
              </optgroup>
            )}
            {containers.projects.length > 0 && (
              <optgroup label="Projects">
                {containers.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || "Untitled Project"}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        )}
      </div>
      <div className="lf-summary" aria-live="polite">
        <span className="grow">
          {items.length === 0 ? (
            filtered ? (
              "Nothing matches these filters."
            ) : (
              "Nothing logged yet."
            )
          ) : (
            <>
              <b>{plural(stats.completed, "to-do")}</b> completed
              {stats.canceled > 0 && <> · {stats.canceled} canceled</>}
              {stats.projects > 0 && <> · {plural(stats.projects, "project")}</>}
              {stats.days > 1 && <> · over {plural(stats.days, "day")}</>}
              {rangeText && <> · {rangeText}</>}
              {filtered && total !== items.length && <span className="lf-of"> (of {total})</span>}
              {stats.best && stats.days > 2 && (
                <span className="lf-best">
                  {" "}
                  · best day {relativeLabel(stats.best.day, today)} ({stats.best.count})
                </span>
              )}
            </>
          )}
        </span>
        {items.length > 0 && (
          <button className="lf-action" onClick={copy} title="Copy what's shown as a text list">
            <ClipboardIcon size={13} /> Copy
          </button>
        )}
        {filtered && (
          <button className="lf-action" onClick={reset}>
            Clear Filters
          </button>
        )}
      </div>
    </div>
  );
}
