// Formatted notes. Things stores notes as Markdown-flavoured plain text and
// renders it on iPhone and Mac; this renders the same subset as React
// elements (never as HTML, so a note can't inject markup):
//
//   # Heading, ## Heading, ### Heading     **bold**  *italic*  ~~strike~~  `code`
//   - bullet, * bullet, 1. numbered         [text](https://…), bare links, things:/// links
//   - [ ] open / - [x] done (clickable)     > quote, ``` code block ```, ---
import { Fragment, type ReactNode } from "react";

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string; line: number }
  | { kind: "paragraph"; lines: string[]; line: number }
  | { kind: "list"; ordered: boolean; start: number; items: { text: string; line: number; check: boolean | null }[] }
  | { kind: "quote"; lines: string[]; line: number }
  | { kind: "code"; text: string; line: number }
  | { kind: "rule"; line: number };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const CHECK = /^\[( |x|X)\]\s+(.*)$/;

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const start = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of text)
      out.push({ kind: "code", text: body.join("\n"), line: start });
      continue;
    }
    const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1].length as 1 | 2 | 3, text: h[2], line: i });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: "rule", line: i });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const start = i;
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", lines: body, line: start });
      continue;
    }
    const b = BULLET.exec(line);
    const n = NUMBERED.exec(line);
    if (b || n) {
      const ordered = !b;
      const start = n ? Number(n[1]) : 1;
      const items: { text: string; line: number; check: boolean | null }[] = [];
      while (i < lines.length) {
        const m = ordered ? NUMBERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!m) break;
        const text = ordered ? m[2] : m[1];
        const c = CHECK.exec(text);
        items.push({ text: c ? c[2] : text, line: i, check: c ? c[1] !== " " : null });
        i++;
      }
      out.push({ kind: "list", ordered, start, items });
      continue;
    }
    const start = i;
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,3}\s|>)/.test(lines[i]) && !RULE.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) para.push(lines[i++]);
    out.push({ kind: "paragraph", lines: para, line: start });
  }
  return out;
}

export interface RenderOptions {
  /** A link was clicked (https://, mailto:, things:///). */
  onLink?: (url: string) => void;
  /** A "- [ ]" item was clicked; `line` is its line in the source. */
  onToggle?: (line: number) => void;
}

// Order matters: code first (its contents aren't formatted), then links, then emphasis.
const INLINE =
  /(`[^`\n]+`)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:|things:\/\/\/)[^)\s]+\))|((?:https?:\/\/|things:\/\/\/)[^\s<>()]*[^\s<>().,;:!?'"*_~])|(\*\*[^*\n]+?\*\*|(?<![\w])__[^_\n]+?__(?![\w]))|(~~[^~\n]+?~~)|(\*[^*\s\n](?:[^*\n]*?[^*\s\n])?\*|(?<![\w])_[^_\s\n](?:[^_\n]*?[^_\s\n])?_(?![\w]))/g;

export function renderInline(text: string, opts: RenderOptions, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(unescape(text.slice(last, m.index)));
    const key = `${keyBase}-${n++}`;
    const [whole, code, mdLink, bare, bold, strike, italic] = m;
    if (code) out.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (mdLink) {
      const sep = mdLink.indexOf("](");
      const label = mdLink.slice(1, sep);
      const url = mdLink.slice(sep + 2, -1);
      out.push(link(url, renderInline(label, opts, key), opts, key));
    } else if (bare) out.push(link(bare, bare.replace(/^https?:\/\/(www\.)?/, ""), opts, key));
    else if (bold) out.push(<strong key={key}>{renderInline(bold.slice(2, -2), opts, key)}</strong>);
    else if (strike) out.push(<del key={key}>{renderInline(strike.slice(2, -2), opts, key)}</del>);
    else if (italic) out.push(<em key={key}>{renderInline(italic.slice(1, -1), opts, key)}</em>);
    else out.push(whole);
    last = m.index + whole.length;
  }
  if (last < text.length) out.push(unescape(text.slice(last)));
  return out;
}

function unescape(s: string): string {
  return s.replace(/\\([\\`*_~[\]()#>-])/g, "$1");
}

function link(url: string, label: ReactNode, opts: RenderOptions, key: string): ReactNode {
  return (
    <a
      key={key}
      href={url}
      className="md-link"
      title={url}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        opts.onLink?.(url);
      }}
    >
      {label}
    </a>
  );
}

export function Markdown({ text, ...opts }: { text: string } & RenderOptions) {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((b) => {
        const k = `b${b.kind === "list" ? b.items[0].line : b.line}`;
        switch (b.kind) {
          case "heading": {
            const H = (["h3", "h4", "h5"] as const)[b.level - 1];
            return (
              <H key={k} className={`md-h md-h${b.level}`}>
                {renderInline(b.text, opts, k)}
              </H>
            );
          }
          case "rule":
            return <hr key={k} className="md-rule" />;
          case "code":
            return (
              <pre key={k} className="md-code">
                <code>{b.text}</code>
              </pre>
            );
          case "quote":
            return (
              <blockquote key={k} className="md-quote">
                {b.lines.map((l, i) => (
                  <Fragment key={i}>
                    {i > 0 && <br />}
                    {renderInline(l, opts, `${k}-${i}`)}
                  </Fragment>
                ))}
              </blockquote>
            );
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            const checklist = b.items.every((it) => it.check !== null);
            return (
              <L key={k} className={`md-list${checklist ? " md-checks" : ""}`} start={b.ordered && b.start !== 1 ? b.start : undefined}>
                {b.items.map((it) => (
                  <li key={it.line} className={it.check === null ? undefined : `md-check${it.check ? " done" : ""}`}>
                    {it.check !== null && (
                      <button
                        type="button"
                        className="md-box"
                        role="checkbox"
                        aria-checked={it.check}
                        disabled={!opts.onToggle}
                        onClick={(e) => {
                          e.stopPropagation();
                          opts.onToggle?.(it.line);
                        }}
                      />
                    )}
                    <span>{renderInline(it.text, opts, `${k}-${it.line}`)}</span>
                  </li>
                ))}
              </L>
            );
          }
          case "paragraph":
            return (
              <p key={k} className="md-p">
                {b.lines.map((l, i) => (
                  <Fragment key={i}>
                    {i > 0 && <br />}
                    {renderInline(l, opts, `${k}-${i}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </>
  );
}

/** Flips "- [ ]" ↔ "- [x]" on one line of the source. */
export function toggleCheckLine(src: string, line: number): string {
  const lines = src.split("\n");
  const l = lines[line];
  if (l === undefined) return src;
  lines[line] = l.replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[( |x|X)\]/, (_, pre: string, mark: string) => `${pre}[${mark === " " ? "x" : " "}]`);
  return lines.join("\n");
}

/** True when the text uses any formatting worth rendering. */
export function hasFormatting(src: string): boolean {
  return /(^|\n)\s*(#{1,3}\s|[-*+]\s|\d+[.)]\s|>|```|---)|\*\*|__|~~|`|\[[^\]]+\]\(|https?:\/\/|things:\/\/\/|(^|\W)[*_]\S/.test(src);
}

// ---------- editing helpers (pure, for the notes textarea) ----------

export interface EditResult {
  value: string;
  start: number;
  end: number;
}

/** Wraps the selection in a marker (e.g. "**"), or removes it if already wrapped. */
export function wrapSelection(value: string, start: number, end: number, marker: string, placeholder = "text"): EditResult {
  const before = value.slice(0, start);
  const sel = value.slice(start, end);
  const after = value.slice(end);
  const m = marker.length;
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return { value: before.slice(0, -m) + sel + after.slice(m), start: start - m, end: end - m };
  }
  if (sel.startsWith(marker) && sel.endsWith(marker) && sel.length >= 2 * m) {
    const inner = sel.slice(m, -m);
    return { value: before + inner + after, start, end: start + inner.length };
  }
  const text = sel || placeholder;
  return { value: before + marker + text + marker + after, start: start + m, end: start + m + text.length };
}

/** Adds (or removes) a line prefix like "- ", "1. ", "- [ ] " or "# " on every selected line. */
export function prefixLines(value: string, start: number, end: number, prefix: string): EditResult {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nl = value.indexOf("\n", end);
  const lineEnd = nl === -1 ? value.length : nl;
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const strip = /^(\s*)(?:#{1,3}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+|>\s?)/;
  const all = lines.every((l) => !l.trim() || l.trimStart().startsWith(prefix.trim()));
  const next = lines.map((l, i) => {
    if (!l.trim() && lines.length > 1) return l;
    const bare = l.replace(strip, "$1");
    if (all) return bare;
    const p = prefix === "1. " ? `${i + 1}. ` : prefix;
    return bare.replace(/^(\s*)/, `$1${p}`);
  });
  const block = next.join("\n");
  const out = value.slice(0, lineStart) + block + value.slice(lineEnd);
  return { value: out, start: lineStart, end: lineStart + block.length };
}

/** Enter inside a list item: continue the list, or end it on an empty item. Null: not in a list. */
export function continueList(value: string, caret: number): EditResult | null {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const line = value.slice(lineStart, caret);
  const m = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|(\d{1,9})([.)])\s+)(.*)$/.exec(line);
  if (!m) return null;
  const [, indent, marker, num, punct, rest] = m;
  if (!rest.trim()) {
    // Empty item: finish the list.
    const v = value.slice(0, lineStart) + value.slice(caret);
    return { value: v, start: lineStart, end: lineStart };
  }
  const nextMarker = num ? `${Number(num) + 1}${punct} ` : marker.replace(/\[[xX]\]/, "[ ]");
  const insert = `\n${indent}${nextMarker}`;
  const v = value.slice(0, caret) + insert + value.slice(caret);
  return { value: v, start: caret + insert.length, end: caret + insert.length };
}
