/**
 * Markdown → HTML, the forward pair of {@link htmlToMarkdown} in world-export.ts.
 *
 * Foundry stores journal prose, actor biographies, and quest descriptions as an
 * HTML string (a JournalEntryPage's `text.content`, with `text.format = 1` for
 * HTML). The campaign-sync notes author that prose as Markdown, so importing a note
 * needs this direction. Done here in the service (not improvised by the importing
 * skill) the conversion is deterministic, unit-tested, and — crucially — writes the
 * *right* field: `text.content`, never the non-schema `text.html` Foundry silently
 * drops.
 *
 * Dependency-free on purpose, matching htmlToMarkdown's ethos: it covers the
 * constructs the notes actually use — headings, bold/italic, inline code, links,
 * unordered/ordered lists, paragraphs, horizontal rules, and GFM pipe tables (the
 * notes lean on choice-tables) — rather than pulling in a full CommonMark engine.
 *
 * Security: all text is HTML-escaped first, so only the tags this function emits are
 * real. Authored Markdown can never inject a live `<script>`/`<img onerror=…>` — a
 * literal `<` in the source renders as `&lt;`, the mirror of htmlToMarkdown's care
 * not to *decode* angle brackets back into tags.
 */

export function markdownToHtml(md: string): string {
  if (!md || !md.trim()) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let para: string[] = [];
  let i = 0;

  const flushPara = (): void => {
    if (para.length) {
      blocks.push(`<p>${inline(para.join(" ").trim())}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inline(heading[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    // Thematic break (--- / *** / ___). A table separator is handled below before
    // we reach here, so this only fires on a standalone rule line.
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushPara();
      blocks.push("<hr>");
      i++;
      continue;
    }

    // GFM table: a header row followed by a `| --- | --- |` separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      flushPara();
      const table = parseTable(lines, i);
      blocks.push(table.html);
      i = table.next;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const list = parseList(lines, i, "ul");
      blocks.push(list.html);
      i = list.next;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const list = parseList(lines, i, "ol");
      blocks.push(list.html);
      i = list.next;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks.join("\n");
}

// --- block parsers ----------------------------------------------------------

function parseList(lines: string[], start: number, tag: "ul" | "ol"): { html: string; next: number } {
  const re = tag === "ul" ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+\.\s+(.*)$/;
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = re.exec(lines[i]!);
    if (!m) break;
    items.push(`<li>${inline(m[1]!.trim())}</li>`);
    i++;
  }
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: i };
}

function parseTable(lines: string[], start: number): { html: string; next: number } {
  const header = splitRow(lines[start]!);
  let i = start + 2; // skip header + separator
  const body: string[] = [];
  while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
    const cells = splitRow(lines[i]!);
    body.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
    i++;
  }
  const thead = `<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.join("")}</tbody>`;
  return { html: `<table>${thead}${tbody}</table>`, next: i };
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  return splitRow(t).every((c) => /^:?-+:?$/.test(c));
}

/** Split a GFM table row into trimmed cells, honouring escaped `\|` inside cells. */
function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

// --- inline -----------------------------------------------------------------

/**
 * Inline Markdown on a single span of text. The text is HTML-escaped first; the
 * emphasis/link/code substitutions then insert the only real tags. Only `*`/`**`
 * emphasis is supported (not `_`/`__`) so prose with snake_case (`system_id`) is
 * left alone — and htmlToMarkdown only ever emits asterisks, so round-trips hold.
 */
function inline(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, url: string) => `<a href="${escapeAttr(url)}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute value: text is already &/</>-escaped; only quotes remain to neutralise. */
function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
