import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { Manifest } from "./types.js";

const AssetRecordSchema = z.object({
  localPath: z.string().min(1),
  contentHash: z.string().min(1),
  remotePath: z.string().min(1),
});

const EntitySchema = z.object({
  documentType: z.string().min(1),
  foundryId: z.string().min(1),
  contentHash: z.string().min(1),
  remoteModifiedTime: z.number(),
  progressHash: z.string().min(1).optional(),
  lastImportedAt: z.string().min(1),
  assets: z.array(AssetRecordSchema),
});

const ManifestSchema = z.object({
  version: z.literal(1),
  world: z.object({ id: z.string().min(1), system: z.string(), forge: z.boolean() }),
  entities: z.record(EntitySchema),
});

export function parseManifest(text: string): Manifest {
  return ManifestSchema.parse(JSON.parse(text)) as Manifest;
}

export function serializeManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

export function emptyManifest(world: Manifest["world"]): Manifest {
  return { version: 1, world, entities: {} };
}

export function loadManifest(path: string, world: Manifest["world"]): Manifest {
  return existsSync(path) ? parseManifest(readFileSync(path, "utf8")) : emptyManifest(world);
}

export function saveManifest(path: string, m: Manifest): void {
  writeFileSync(path, serializeManifest(m));
}
