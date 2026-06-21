/**
 * Thin LevelDB reader for a downloaded Foundry world folder (v11+). Reads the
 * journal / actors / scenes stores into the in-memory {@link WorldDump} that the
 * pure {@link buildVault} converter consumes.
 *
 * Like foundry-runtime.ts this is the un-typed I/O edge — it is NOT exercised in
 * CI (no real world DB there) and depends on `classic-level` (the same LevelDB
 * binding Foundry uses), loaded lazily so the package type-checks and the rest of
 * the CLI works without the native module installed. Install it to use `export`:
 *   npm i classic-level
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { WorldDump, WorldDoc, JournalDoc, JournalPage } from "./world-export.js";

interface WorldManifest {
  id?: string;
  name?: string;
  title?: string;
  system?: string;
}

/** Read a world folder into a WorldDump ready for buildVault(). */
export async function readWorld(worldDir: string): Promise<WorldDump> {
  const manifest = readWorldManifest(worldDir);
  const dataDir = join(worldDir, "data");
  const [journals, actors, scenes] = await Promise.all([
    readJournals(join(dataDir, "journal")),
    readPrimary(join(dataDir, "actors"), "actors"),
    readPrimary(join(dataDir, "scenes"), "scenes"),
  ]);
  return {
    world: { id: manifest.id ?? "unknown", system: manifest.system },
    journals,
    actors,
    scenes,
  };
}

function readWorldManifest(worldDir: string): WorldManifest {
  const path = join(worldDir, "world.json");
  if (!existsSync(path)) {
    throw new Error(`No world.json in ${worldDir} — point --world at a Foundry world folder.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as WorldManifest;
}

/** Open a LevelDB store with JSON values, or undefined when the store is absent. */
async function openDb(dir: string): Promise<any | undefined> {
  if (!existsSync(dir)) return undefined;
  let ClassicLevel: any;
  try {
    ({ ClassicLevel } = (await import("classic-level" as string)) as any);
  } catch {
    throw new Error(
      "The `export` command needs the 'classic-level' package to read the world DB. Install it: npm i classic-level",
    );
  }
  const db = new ClassicLevel(dir, { keyEncoding: "utf8", valueEncoding: "json" });
  await db.open();
  return db;
}

/** Read primary documents of a collection (skips embedded `!collection.sub!` keys). */
async function readPrimary(dir: string, collection: string): Promise<WorldDoc[]> {
  const db = await openDb(dir);
  if (!db) return [];
  const prefix = `!${collection}!`;
  const docs: WorldDoc[] = [];
  try {
    for await (const [key, value] of db.iterator()) {
      if (typeof key === "string" && key.startsWith(prefix)) docs.push(value as WorldDoc);
    }
  } finally {
    await db.close();
  }
  return docs;
}

/** Read journal entries and fold their embedded `JournalEntryPage`s back in. */
async function readJournals(dir: string): Promise<JournalDoc[]> {
  const db = await openDb(dir);
  if (!db) return [];
  const entries = new Map<string, JournalDoc>();
  const pagesByEntry = new Map<string, { sort: number; page: JournalPage }[]>();
  try {
    for await (const [key, value] of db.iterator()) {
      if (typeof key !== "string") continue;
      if (key.startsWith("!journal!")) {
        entries.set(key.slice("!journal!".length), { ...(value as JournalDoc), pages: [] });
      } else if (key.startsWith("!journal.pages!")) {
        const entryId = key.slice("!journal.pages!".length).split(".")[0]!;
        const page = value as JournalPage & { sort?: number };
        const list = pagesByEntry.get(entryId) ?? [];
        list.push({ sort: page.sort ?? 0, page });
        pagesByEntry.set(entryId, list);
      }
    }
  } finally {
    await db.close();
  }
  for (const [entryId, list] of pagesByEntry) {
    const entry = entries.get(entryId);
    if (entry) entry.pages = list.sort((a, b) => a.sort - b.sort).map((p) => p.page);
  }
  return [...entries.values()];
}
