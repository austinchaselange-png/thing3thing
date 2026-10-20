import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { continueList, hasFormatting, Markdown, parseBlocks, prefixLines, toggleCheckLine, wrapSelection } from "./markdown";

describe("markdown notes", () => {
  it("parses blocks", () => {
    const src = "# Plan\nFirst line\nsecond line\n\n- a\n- b\n\n1. one\n2. two\n\n- [ ] open\n- [x] done\n\n> quoted\n\n```\nlet x = 1;\n```\n---\ntail";
    const kinds = parseBlocks(src).map((b) => b.kind);
    expect(kinds).toEqual(["heading", "paragraph", "list", "list", "list", "quote", "code", "rule", "paragraph"]);
    const checks = parseBlocks(src)[4];
    expect(checks.kind === "list" && checks.items.map((i) => i.check)).toEqual([false, true]);
  });

  it("renders inline formatting and links without HTML", () => {
    const onLink = vi.fn();
    const { container } = render(<Markdown text={"**bold** *it* ~~gone~~ `code` [site](https://example.com) snake_case_name <b>raw</b> https://x.dev/a."} onLink={onLink} />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("it");
    expect(container.querySelector("del")?.textContent).toBe("gone");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelectorAll("em")).toHaveLength(1); // snake_case stays plain
    expect(container.querySelector("b")).toBeNull(); // markup shows as text
    expect(container.textContent).toContain("<b>raw</b>");
    fireEvent.click(screen.getByText("site"));
    expect(onLink).toHaveBeenCalledWith("https://example.com");
    fireEvent.click(screen.getByText("x.dev/a"));
    expect(onLink).toHaveBeenLastCalledWith("https://x.dev/a");
  });

  it("toggles checklist lines", () => {
    expect(toggleCheckLine("x\n- [ ] milk\n- [x] eggs", 1)).toBe("x\n- [x] milk\n- [x] eggs");
    expect(toggleCheckLine("- [X] eggs", 0)).toBe("- [ ] eggs");
    expect(toggleCheckLine("plain", 0)).toBe("plain");
  });

  it("wraps and unwraps selections", () => {
    expect(wrapSelection("hello world", 6, 11, "**")).toEqual({ value: "hello **world**", start: 8, end: 13 });
    expect(wrapSelection("hello **world**", 8, 13, "**")).toEqual({ value: "hello world", start: 6, end: 11 });
    expect(wrapSelection("ab", 1, 1, "*")).toEqual({ value: "a*text*b", start: 2, end: 6 });
  });

  it("prefixes lines and numbers them", () => {
    expect(prefixLines("a\nb", 0, 3, "- ").value).toBe("- a\n- b");
    expect(prefixLines("- a\n- b", 0, 7, "- ").value).toBe("a\nb");
    expect(prefixLines("a\nb", 0, 3, "1. ").value).toBe("1. a\n2. b");
    expect(prefixLines("- a", 0, 3, "- [ ] ").value).toBe("- [ ] a");
  });

  it("continues lists on Enter", () => {
    expect(continueList("- milk", 6)).toEqual({ value: "- milk\n- ", start: 9, end: 9 });
    expect(continueList("3. c", 4)?.value).toBe("3. c\n4. ");
    expect(continueList("- [x] done", 10)?.value).toBe("- [x] done\n- [ ] ");
    expect(continueList("a\n- ", 4)).toEqual({ value: "a\n", start: 2, end: 2 });
    expect(continueList("plain", 5)).toBeNull();
  });

  it("detects formatting", () => {
    expect(hasFormatting("just words")).toBe(false);
    expect(hasFormatting("- item")).toBe(true);
    expect(hasFormatting("see https://a.b")).toBe(true);
  });
});
