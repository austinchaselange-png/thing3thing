import { describe, expect, it } from "vitest";
import { orderChanges, placeAt, STEP } from "./order";

const list = (...pairs: [string, number][]) => pairs.map(([id, value]) => ({ id, value }));

describe("placeAt", () => {
  it("moves items to a position in the original list", () => {
    expect(placeAt(["a", "b", "c", "d"], ["d"], 1)).toEqual(["a", "d", "b", "c"]);
    expect(placeAt(["a", "b", "c", "d"], ["a"], 3)).toEqual(["b", "c", "a", "d"]);
    expect(placeAt(["a", "b", "c", "d"], ["a", "c"], 4)).toEqual(["b", "d", "a", "c"]);
    expect(placeAt(["a", "b"], ["x"], 0)).toEqual(["x", "a", "b"]);
  });
});

describe("orderChanges", () => {
  it("fits a moved item between its neighbours and writes only that item", () => {
    const changes = orderChanges(list(["a", 10], ["c", 40], ["b", 20], ["d", 50]), new Set(["c"]));
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe("c");
    expect(changes[0].value).toBeGreaterThan(10);
    expect(changes[0].value).toBeLessThan(20);
  });

  it("handles the top and bottom of the list", () => {
    const top = orderChanges(list(["d", 50], ["a", 10], ["b", 20]), new Set(["d"]));
    expect(top[0].value).toBeLessThan(10);
    const bottom = orderChanges(list(["b", 20], ["c", 30], ["a", 10]), new Set(["a"]));
    expect(bottom[0].value).toBeGreaterThan(30);
  });

  it("spreads several moved items and keeps them in order", () => {
    const changes = orderChanges(list(["a", 0], ["x", 99], ["y", 98], ["b", 100]), new Set(["x", "y"]));
    const v = Object.fromEntries(changes.map((c) => [c.id, c.value]));
    expect(0 < v.x && v.x < v.y && v.y < 100).toBe(true);
  });

  it("renumbers when there is no room or the rest is unordered (Today's zeros)", () => {
    const tight = orderChanges(list(["a", 1], ["x", 9], ["b", 2]), new Set(["x"]));
    expect(tight.map((c) => c.id)).toContain("x");
    const zeros = orderChanges(list(["a", 0], ["b", 0], ["c", 0]), new Set(["c"]));
    const values = ["a", "b", "c"].map((id) => zeros.find((z) => z.id === id)?.value ?? 0);
    expect(values).toEqual([STEP, 2 * STEP, 3 * STEP]);
  });

  it("does nothing when nothing changed position", () => {
    expect(orderChanges(list(["a", 1], ["b", 2]), new Set())).toEqual([]);
  });
});
