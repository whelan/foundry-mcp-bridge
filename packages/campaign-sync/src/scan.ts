import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseNote, classifyType, type TypeMap } from "./notes.js";
import type { RepoEntity } from "./types.js";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

export function scanRepo(root: string, map: TypeMap): RepoEntity[] {
  const entities: RepoEntity[] = [];
  for (const file of walk(root)) {
    const source = relative(root, file).split(sep).join("/");
    if (!classifyType(source, map)) continue; // skip reference/unclassified files
    const note = parseNote(source, readFileSync(file, "utf8"), map);
    entities.push({
      source,
      documentType: note.documentType,
      contentHash: note.contentHash,
      assets: [], // asset linkage is resolved by the skill from front-matter; v1 scans documents only
    });
  }
  return entities;
}
