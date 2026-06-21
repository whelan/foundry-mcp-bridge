/**
 * World → Obsidian export (pure converter). Turns a dump of live Foundry documents
 * into campaign-sync-convention markdown notes (generated/{journals,npcs,scenes,
 * quests}/*.md) plus a foundry-sync.json manifest, so the result round-trips with
 * the existing foundry-sync push/pull tooling.
 *
 * This module is pure and fully unit-tested with in-memory documents. The LevelDB
 * reading (leveldb.ts) and file writing (cli.ts) are thin I/O layers around it.
 */

import { parseNote, renderNote, DEFAULT_TYPE_MAP } from "./notes.js";
import { extractQuest, questProgressHash, renderProgressFrontMatter } from "./fql.js";
import { emptyManifest } from "./manifest.js";
import type { Manifest, ManifestEntity } from "./types.js";

/** A live Foundry document as read from the world DB (only fields we use are typed). */
export interface WorldDoc {
  _id: string;
  name?: string;
  _stats?: { modifiedTime?: number };
  flags?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface JournalPage {
  name?: string;
  type?: string;
  text?: { content?: string };
}

export interface JournalDoc extends WorldDoc {
  pages?: JournalPage[];
}

export interface WorldDump {
  world: { id: string; system?: string };
  journals: JournalDoc[];
  actors: WorldDoc[];
  scenes: WorldDoc[];
}

export interface ExportedFile {
  /** Repo-relative path, e.g. "generated/npcs/strahd.md". */
  path: string;
  content: string;
}

export interface ExportResult {
  files: ExportedFile[];
  manifest: Manifest;
}

const NOW = () => new Date().toISOString();

export function buildVault(dump: WorldDump, now: () => string = NOW): ExportResult {
  const manifest = emptyManifest({ id: dump.world.id, system: dump.world.system ?? "", forge: false });
  const files: ExportedFile[] = [];
  const used = new Set<string>();

  const emit = (
    dir: string,
    doc: WorldDoc,
    frontMatter: Record<string, unknown>,
    body: string,
    entity: Omit<ManifestEntity, "contentHash" | "lastImportedAt">,
  ): void => {
    const source = `${dir}/${uniqueSlug(used, dir, doc.name, doc._id)}.md`;
    const content = renderNote(frontMatter, body);
    // Hash the rendered file the same way a checkout would, so an immediate
    // `foundry-sync plan` reports `unchanged`.
    const parsed = parseNote(source, content, DEFAULT_TYPE_MAP);
    files.push({ path: source, content });
    manifest.entities[source] = {
      ...entity,
      contentHash: parsed.contentHash,
      lastImportedAt: now(),
    };
  };

  for (const j of dump.journals) {
    if (isQuest(j)) {
      const { frontMatter, body, progressHash } = questNote(j);
      emit("generated/quests", j, frontMatter, body, {
        documentType: "Quest",
        foundryId: j._id,
        remoteModifiedTime: modifiedTime(j),
        progressHash,
        assets: [],
      });
    } else {
      const { frontMatter, body } = journalNote(j);
      emit("generated/journals", j, frontMatter, body, {
        documentType: "JournalEntry",
        foundryId: j._id,
        remoteModifiedTime: modifiedTime(j),
        assets: [],
      });
    }
  }

  for (const a of dump.actors) {
    const { frontMatter, body } = actorNote(a);
    emit("generated/npcs", a, frontMatter, body, {
      documentType: "Actor",
      foundryId: a._id,
      remoteModifiedTime: modifiedTime(a),
      assets: [],
    });
  }

  for (const s of dump.scenes) {
    const { frontMatter, body } = sceneNote(s);
    emit("generated/scenes", s, frontMatter, body, {
      documentType: "Scene",
      foundryId: s._id,
      remoteModifiedTime: modifiedTime(s),
      assets: [],
    });
  }

  return { files, manifest };
}

// --- per-type conversions ---------------------------------------------------

function journalNote(j: JournalDoc): { frontMatter: Record<string, unknown>; body: string } {
  const pages = j.pages ?? [];
  const text = pages.filter((p) => (p.type ?? "text") === "text");
  // One page → body is its content; many → prefix each with its name as an H2.
  const body =
    text.length <= 1
      ? htmlToMarkdown(text[0]?.text?.content ?? "")
      : text
          .map((p) => `## ${p.name ?? "Page"}\n\n${htmlToMarkdown(p.text?.content ?? "")}`.trim())
          .join("\n\n");
  return { frontMatter: { id: j._id, name: j.name ?? "Untitled" }, body: body.trim() };
}

function actorNote(a: WorldDoc): { frontMatter: Record<string, unknown>; body: string } {
  const system = (a.system ?? {}) as Record<string, any>;
  const frontMatter: Record<string, unknown> = { id: a._id, name: a.name ?? "Unnamed" };
  if (typeof a.type === "string") frontMatter.type = a.type;
  if (typeof a.img === "string") frontMatter.img = a.img;
  const cr = system?.details?.cr;
  if (cr !== undefined) frontMatter.cr = cr;
  const hp = system?.attributes?.hp;
  if (hp?.value !== undefined) frontMatter.hp = hp.value;
  if (hp?.max !== undefined) frontMatter.hpMax = hp.max;
  const bio = system?.details?.biography?.value;
  return { frontMatter, body: htmlToMarkdown(typeof bio === "string" ? bio : "").trim() };
}

function sceneNote(s: WorldDoc): { frontMatter: Record<string, unknown>; body: string } {
  const grid = (s.grid ?? {}) as Record<string, any>;
  const background = (s.background ?? {}) as Record<string, any>;
  const frontMatter: Record<string, unknown> = { id: s._id, name: s.name ?? "Untitled Scene" };
  if (typeof s.width === "number") frontMatter.width = s.width;
  if (typeof s.height === "number") frontMatter.height = s.height;
  if (typeof grid.size === "number") frontMatter.gridSize = grid.size;
  if (typeof background.src === "string" && background.src) frontMatter.background = background.src;
  return { frontMatter, body: "" };
}

function questNote(j: JournalDoc): {
  frontMatter: Record<string, unknown>;
  body: string;
  progressHash: string;
} {
  const quest = extractQuest(j);
  const fqlJson = ((j.flags as any)?.["forien-quest-log"]?.json ?? {}) as Record<string, any>;
  const frontMatter: Record<string, unknown> = {
    id: j._id,
    name: j.name ?? fqlJson.name ?? "Quest",
    ...renderProgressFrontMatter(quest), // status + tasks (world-owned MANAGED_KEYS)
  };
  if (fqlJson.giver) frontMatter.giver = fqlJson.giver;
  if (fqlJson.parent) frontMatter.parent = fqlJson.parent;
  const body = htmlToMarkdown(typeof fqlJson.description === "string" ? fqlJson.description : "").trim();
  return { frontMatter, body, progressHash: questProgressHash(quest) };
}

// --- helpers ----------------------------------------------------------------

function isQuest(j: JournalDoc): boolean {
  const json = (j.flags as any)?.["forien-quest-log"]?.json;
  return !!json && typeof json.status === "string";
}

function modifiedTime(doc: WorldDoc): number {
  return doc._stats?.modifiedTime ?? 0;
}

/** A filesystem-safe slug for a document name, unique within its directory. */
function uniqueSlug(used: Set<string>, dir: string, name: string | undefined, id: string): string {
  const base = slugify(name ?? id) || slugify(id) || "untitled";
  let slug = base;
  if (used.has(`${dir}/${slug}`)) slug = `${base}-${id.slice(0, 6).toLowerCase()}`;
  // Extremely unlikely, but guarantee uniqueness even then.
  let n = 2;
  while (used.has(`${dir}/${slug}`)) slug = `${base}-${n++}`;
  used.add(`${dir}/${slug}`);
  return slug;
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Minimal HTML → Markdown. Foundry prose (journal pages, biographies) is stored as
 * HTML; this covers the common tags well enough for readable notes without pulling
 * in a heavy converter. Unknown tags are stripped; entities are decoded.
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  let out = html;
  out = out.replace(/<\s*br\s*\/?>/gi, "\n");
  out = out.replace(/<\s*\/p\s*>/gi, "\n\n").replace(/<\s*p[^>]*>/gi, "");
  out = out.replace(/<\s*h([1-6])[^>]*>([\s\S]*?)<\s*\/h\1\s*>/gi, (_m, lvl, t) => `\n${"#".repeat(Number(lvl))} ${strip(t)}\n\n`);
  out = out.replace(/<\s*(strong|b)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_m, _t, t2) => `**${strip(t2)}**`);
  out = out.replace(/<\s*(em|i)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_m, _t, t2) => `*${strip(t2)}*`);
  out = out.replace(/<\s*li[^>]*>([\s\S]*?)<\s*\/li\s*>/gi, (_m, t) => `- ${strip(t)}\n`);
  out = out.replace(/<\s*a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\s*\/a\s*>/gi, (_m, href, t) => `[${strip(t)}](${href})`);
  out = strip(out);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip remaining tags and decode the handful of entities Foundry emits. */
function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
