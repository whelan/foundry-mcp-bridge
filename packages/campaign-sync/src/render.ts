/**
 * Plan → write-ready journal payloads (pure). For each `create`/`update`
 * JournalEntry in a plan, load the note, convert its Markdown body to HTML, and
 * emit the exact `JournalEntryPage` data the foundry bridge writes — so the
 * importing skill passes the payload straight through instead of reading the body
 * into context and hand-converting it (the slow, lossy, bug-prone step).
 *
 * Faithfully reverses world-export's `journalNote`: a body with `## ` sections
 * becomes one named text page per section; otherwise it's a single "Description"
 * page. Every page carries `text.format = 1` (HTML) and writes `text.content` — the
 * schema field — never the `text.html` Foundry drops on the floor.
 *
 * Pure: the note loader is injected, so this is unit-tested with an in-memory map.
 * The fs wiring lives in cli.ts.
 */

import { parseNote, DEFAULT_TYPE_MAP } from "./notes.js";
import { markdownToHtml } from "./markdown.js";
import type { Plan } from "./types.js";

export interface RenderedPage {
  name: string;
  type: "text";
  text: { content: string; format: 1 };
}

export interface RenderedJournal {
  source: string;
  action: "create" | "update";
  foundryId?: string;
  name: string;
  pages: RenderedPage[];
}

export function renderPlan(plan: Plan, load: (source: string) => string): RenderedJournal[] {
  const out: RenderedJournal[] = [];
  for (const item of plan.items) {
    if (item.action !== "create" && item.action !== "update") continue;
    if (item.documentType !== "JournalEntry") continue;
    const note = parseNote(item.source, load(item.source), DEFAULT_TYPE_MAP);
    const name = typeof note.frontMatter.name === "string" ? note.frontMatter.name : item.source;
    out.push({
      source: item.source,
      action: item.action,
      foundryId: item.foundryId,
      name,
      pages: bodyToPages(note.body),
    });
  }
  return out;
}

/** One page per `## ` section, else a single "Description" page. */
function bodyToPages(body: string): RenderedPage[] {
  const sections = splitSections(body);
  if (sections.length <= 1) {
    return [page("Description", body)];
  }
  return sections.map((s) => page(s.title, s.body));
}

function page(name: string, body: string): RenderedPage {
  return { name, type: "text", text: { content: markdownToHtml(body), format: 1 } };
}

interface Section {
  title: string;
  body: string;
}

/**
 * Split on top-level `## ` headings. Returns a single anonymous section when the
 * body has no leading `## ` (so a plain body stays one page), mirroring the
 * exporter, which only prefixes `## name` when a journal has more than one page.
 */
function splitSections(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const line of lines) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      current = { title: h[1]!.trim(), body: "" };
      sections.push(current);
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    } else if (line.trim()) {
      // Content before the first `## ` → the body isn't section-structured.
      return [{ title: "Description", body }];
    }
  }
  for (const s of sections) s.body = s.body.trim();
  return sections;
}
