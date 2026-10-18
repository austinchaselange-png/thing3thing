// Drag-and-drop ordering. Things stores order as integers (`ix`, and `ti` for
// Today). After a drop we keep everyone else's value and fit the moved items
// between their new neighbours; only when there is no room do we renumber the
// whole list. Only changed values are returned, so a drop usually writes just
// the items that moved.

export const STEP = 1024;

export interface Ordered {
  id: string;
  value: number;
}

/**
 * New values for `desired` (the full list in its new order, with current
 * values) where the ids in `moved` were just placed. Returns only changes.
 */
export function orderChanges(desired: Ordered[], moved: Set<string>): Ordered[] {
  const n = desired.length;
  if (!n) return [];
  const out = desired.map((d) => d.value);
  const fixed = desired.map((d, i) => (moved.has(d.id) ? -1 : i)).filter((i) => i >= 0);

  // The items that stayed put must still be in strictly increasing order.
  const sorted = fixed.every((i, k) => k === 0 || desired[fixed[k - 1]].value < desired[i].value);
  if (!sorted || !fixed.length) return renumber(desired);

  let i = 0;
  while (i < n) {
    if (!moved.has(desired[i].id)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && moved.has(desired[j].id)) j++;
    const k = j - i; // run of moved items [i, j)
    const prev = i > 0 ? desired[i - 1].value : null;
    const next = j < n ? desired[j].value : null;
    const lo = prev ?? (next as number) - (k + 1) * STEP;
    const hi = next ?? (prev as number) + (k + 1) * STEP;
    if (hi - lo <= k) return renumber(desired);
    for (let m = 0; m < k; m++) out[i + m] = lo + Math.floor(((hi - lo) * (m + 1)) / (k + 1));
    i = j;
  }
  return desired.filter((d, idx) => out[idx] !== d.value).map((d) => ({ id: d.id, value: out[desired.indexOf(d)] }));
}

/** Evenly spaced values, keeping the list's current lowest value as the start. */
function renumber(desired: Ordered[]): Ordered[] {
  const start = Math.min(...desired.map((d) => d.value), 0);
  return desired.map((d, i) => ({ id: d.id, value: start + (i + 1) * STEP })).filter((d, i) => d.value !== desired[i].value);
}

/** `ids` taken out of `list` and inserted at `index` (an index into the original list). */
export function placeAt(list: string[], ids: string[], index: number): string[] {
  const set = new Set(ids);
  const before = list.slice(0, index).filter((id) => !set.has(id));
  const after = list.slice(index).filter((id) => !set.has(id));
  return [...before, ...ids, ...after];
}
