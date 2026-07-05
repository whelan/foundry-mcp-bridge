/**
 * Real-Foundry implementation of {@link FoundryDocumentApi} plus module settings
 * (relay URL + token via game.settings — never hardcoded; see live-api-plan §5).
 *
 * This file talks to Foundry browser globals and is NOT exercised in CI; the
 * protocol logic is tested against the mock. Kept thin and obvious on purpose.
 */

import { COLLECTIONS, getByPath, assetBaseName, applyUpdate, type DocumentType } from "@foundry-mcp-bridge/shared";
import type {
  ExecuteOptions,
  FindSelector,
  FoundryDocumentApi,
  UploadAssetParams,
  BatchUploadAssetsParams,
  WorldInfo,
  CompendiumEntry,
} from "./protocol-executor.js";
import { CommandExecutionError } from "./protocol-executor.js";

export const MODULE_ID = "foundry-mcp-bridge";

/**
 * Convenience default for local development so the module connects out of the
 * box after merely enabling it (no settings to type). It is a non-secret
 * localhost address and is fully overridable in Module Settings — set a real
 * URL + token for anything beyond a local machine.
 */
export const DEFAULT_RELAY_URL = "ws://localhost:8787";

export interface RelaySettings {
  url: string;
  token?: string;
}

export function registerSettings(): void {
  game.settings.register(MODULE_ID, "relayUrl", {
    name: "Relay URL",
    hint: "WebSocket URL of the MCP relay. Defaults to a local dev relay.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_RELAY_URL,
  });
  game.settings.register(MODULE_ID, "relayToken", {
    name: "Relay token",
    hint: "Shared secret matching the MCP server's token. Leave empty for a local ws://localhost relay.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
}

/** Reads relay settings; throws loudly if the required URL is missing. */
export function readSettings(): RelaySettings {
  const url = String(game.settings.get(MODULE_ID, "relayUrl") ?? "").trim();
  const token = String(game.settings.get(MODULE_ID, "relayToken") ?? "").trim();
  if (!url) {
    throw new Error(
      `[${MODULE_ID}] Relay URL is not configured. Set it in Module Settings.`,
    );
  }
  return { url, token: token || undefined };
}

function collection(type: DocumentType): any {
  const accessor = COLLECTIONS[type];
  const coll = game[accessor];
  if (!coll) {
    throw new CommandExecutionError("UNSUPPORTED", `no collection for ${type}`);
  }
  return coll;
}

function requireDoc(type: DocumentType, id: string): any {
  const doc = collection(type).get(id);
  if (!doc) throw new CommandExecutionError("NOT_FOUND", `${type} ${id} not found`);
  return doc;
}

export function createFoundryRuntimeApi(): FoundryDocumentApi {
  return {
    async create(type, data, opts) {
      const cls = getDocumentClass(type);
      if (opts.dryRun) {
        // Construct to trigger validation without persisting.
        return new cls(data).toObject();
      }
      const doc = await cls.create(data, opts.keepId ? { keepId: true } : {});
      return doc.toObject();
    },

    async update(type, id, diff, opts) {
      const doc = requireDoc(type, id);
      if (opts.dryRun) {
        const clone = doc.clone();
        clone.updateSource(diff);
        return clone.toObject();
      }
      await doc.update(diff);
      return doc.toObject();
    },

    async remove(type, id, opts) {
      const doc = requireDoc(type, id);
      if (!opts.dryRun) await doc.delete();
    },

    async duplicate(type, id, overrides, opts) {
      const doc = requireDoc(type, id);
      // doc.clone() merges overrides (dot-notation supported) and assigns a
      // fresh _id; {save:true} persists and returns a promise.
      if (opts.dryRun) return doc.clone(overrides ?? {}).toObject();
      const created = await doc.clone(overrides ?? {}, { save: true });
      return created.toObject();
    },

    async createEmbedded(parentType, parentId, embeddedName, data, opts) {
      const parent = requireDoc(parentType, parentId);
      if (opts.dryRun) return data;
      const created = await parent.createEmbeddedDocuments(embeddedName, data);
      return created.map((d: any) => d.toObject());
    },

    async updateEmbedded(parentType, parentId, embeddedName, data, opts) {
      const parent = requireDoc(parentType, parentId);
      if (opts.dryRun) return data;
      const updated = await parent.updateEmbeddedDocuments(embeddedName, data);
      return updated.map((d: any) => d.toObject());
    },

    async deleteEmbedded(parentType, parentId, embeddedName, ids, opts) {
      const parent = requireDoc(parentType, parentId);
      if (!opts.dryRun) await parent.deleteEmbeddedDocuments(embeddedName, ids);
    },

    async find(type, selector: FindSelector) {
      if (selector.id) return requireDoc(type, selector.id).toObject();
      const all: any[] = collection(type).contents;
      const docs = all.map((d) => d.toObject());
      if (!selector.query) return docs;
      const entries = Object.entries(selector.query);
      return docs.filter((doc) =>
        entries.every(([path, value]) => getByPath(doc, path) === value),
      );
    },

    async getWorldInfo(): Promise<WorldInfo> {
      const folders: any[] = (game as any).folders?.contents ?? [];
      return {
        foundryVersion: String((game as any).version ?? ""),
        system: {
          id: String(game.system?.id ?? ""),
          version: String((game.system as any)?.version ?? ""),
          title: (game.system as any)?.title,
        },
        world: {
          id: String((game.world as any)?.id ?? ""),
          title: String((game.world as any)?.title ?? ""),
        },
        folders: folders.map((f) => ({
          _id: String(f.id),
          name: String(f.name),
          type: String(f.type),
        })),
        forge: {
          active: Boolean((globalThis as any).ForgeVTT?.usingTheForge),
          userId: ((globalThis as any).ForgeVTT?.userId ?? null) as string | null,
        },
      };
    },

    async uploadAsset(params: UploadAssetParams, opts) {
      const target = params.target.replace(/\/$/, "");
      // Dry-run: don't write the file; return the path it would land at.
      if (opts.dryRun) return { path: `${target}/${params.filename}` };
      const bytes = Uint8Array.from(atob(params.contentBase64), (c) => c.charCodeAt(0));
      const file = new File([bytes], params.filename, params.mimeType ? { type: params.mimeType } : undefined);
      const result = await (FilePicker as any).upload(params.source, target, file, {});
      const path = result?.path;
      if (typeof path !== "string" || !path) {
        throw new CommandExecutionError("INTERNAL", "FilePicker.upload returned no path");
      }
      return { path };
    },

    async browseAssets(params, opts) {
      const target = params.target.replace(/\/$/, "");
      // Dry-run: return empty listing (nothing to validate against).
      if (opts.dryRun) return { dirs: [], files: [], target };
      const options: Record<string, unknown> = {};
      if (params.extensions?.length) options.extensions = params.extensions;
      const result = await (FilePicker as any).browse(params.source, target, options);
      return {
        dirs: (result?.dirs ?? []) as string[],
        files: (result?.files ?? []) as string[],
        target: String(result?.target ?? target),
      };
    },

    async batchUploadAssets(params: BatchUploadAssetsParams, opts) {
      const target = params.target.replace(/\/$/, "");
      // Dry-run: return what would be uploaded without writing.
      if (opts.dryRun) {
        return params.files.map((f) => ({ filename: f.filename, path: `${target}/${f.filename}` }));
      }
      // Optional skip: pre-browse the directory to find existing files. Match by
      // basename, not full path: on The Forge `FilePicker.browse("forgevtt", …)`
      // returns absolute CDN URLs (with the user-id prefix / query strings) rather
      // than the relative `target/filename` we construct, so a full-path compare
      // would silently never match and re-upload everything.
      // Map basename → the asset's *actual* stored path, so a skipped entry
      // reports the real existing path (an absolute CDN URL on The Forge), not a
      // reconstructed `target/filename` that wouldn't resolve there.
      const existing = new Map<string, string>();
      if (params.skipExisting) {
        const browse = await (FilePicker as any).browse(params.source, target, {});
        for (const f of browse?.files ?? []) existing.set(assetBaseName(String(f)), String(f));
      }
      const results: Array<{ filename: string; path: string; skipped?: boolean }> = [];
      for (const entry of params.files) {
        const known = existing.get(assetBaseName(entry.filename));
        if (known !== undefined) {
          results.push({ filename: entry.filename, path: known, skipped: true });
          continue;
        }
        const bytes = Uint8Array.from(atob(entry.contentBase64), (c) => c.charCodeAt(0));
        const file = new File([bytes], entry.filename, entry.mimeType ? { type: entry.mimeType } : undefined);
        const result = await (FilePicker as any).upload(params.source, target, file, {});
        const storedPath = result?.path;
        if (typeof storedPath !== "string" || !storedPath) {
          throw new CommandExecutionError("INTERNAL", `FilePicker.upload failed for ${entry.filename}`);
        }
        // Record the stored path so later in-batch duplicates report it and are
        // skipped — but only under skipExisting, which owns the dedup contract.
        // With skipExisting=false the caller asked to upload everything as given.
        if (params.skipExisting) existing.set(assetBaseName(entry.filename), storedPath);
        results.push({ filename: entry.filename, path: storedPath });
      }
      return results;
    },

    async createQuest(data, parentId, opts) {
      const fqlModule = game.modules.get("forien-quest-log");
      if (!fqlModule?.active) {
        throw new CommandExecutionError(
          "UNSUPPORTED",
          "forien-quest-log module is not enabled",
        );
      }

      const QuestAPI = (fqlModule as any).public?.QuestAPI;
      if (!QuestAPI) {
        throw new CommandExecutionError(
          "INTERNAL",
          "forien-quest-log QuestAPI not found",
        );
      }

      const QuestDB = QuestAPI.DB;
      if (!QuestDB) {
        throw new CommandExecutionError(
          "INTERNAL",
          "forien-quest-log QuestDB shim not found",
        );
      }

      if (opts.dryRun) {
        // Dry-run: just validate that the module is ready.
        return { _id: "dry-run", name: (data as any)?.name || "Quest" };
      }

      // Create quest via public API.
      const quest = await QuestDB.createQuest({ data, parentId });
      if (!quest) {
        throw new CommandExecutionError("INTERNAL", "quest creation returned nothing");
      }
      // Quest.toJSON() doesn't include _id, so we need to add it manually.
      const questData = quest.toJSON?.() || {};
      return { ...questData, _id: (quest as any).id };
    },

    async updateQuest(id, data, opts) {
      const fqlModule = game.modules.get("forien-quest-log");
      if (!fqlModule?.active) {
        throw new CommandExecutionError(
          "UNSUPPORTED",
          "forien-quest-log module is not enabled",
        );
      }

      const QuestAPI = (fqlModule as any).public?.QuestAPI;
      const QuestDB = QuestAPI?.DB;
      if (!QuestDB) {
        throw new CommandExecutionError(
          "INTERNAL",
          "forien-quest-log QuestDB shim not found",
        );
      }

      const quest = QuestDB.getQuest(id);
      if (!quest) {
        throw new CommandExecutionError("NOT_FOUND", `quest ${id} not found`);
      }

      if (opts.dryRun) {
        return { _id: id, name: (data as any)?.name || quest.name };
      }

      // Update quest: merge data into quest object and save.
      for (const [key, value] of Object.entries(data)) {
        (quest as any)[key] = value;
      }
      await quest.save();

      const questData = quest.toJSON?.() || {};
      return { ...questData, _id: (quest as any).id };
    },

    async deleteQuest(id, opts) {
      const fqlModule = game.modules.get("forien-quest-log");
      if (!fqlModule?.active) {
        throw new CommandExecutionError(
          "UNSUPPORTED",
          "forien-quest-log module is not enabled",
        );
      }

      const QuestAPI = (fqlModule as any).public?.QuestAPI;
      const QuestDB = QuestAPI?.DB;
      if (!QuestDB) {
        throw new CommandExecutionError(
          "INTERNAL",
          "forien-quest-log QuestDB shim not found",
        );
      }

      const quest = QuestDB.getQuest(id);
      if (!quest) {
        throw new CommandExecutionError("NOT_FOUND", `quest ${id} not found`);
      }

      if (!opts.dryRun) {
        // Delete via backing JournalEntry (public API doesn't expose deleteQuest)
        const entry = (quest as any).entry;
        if (entry) {
          await entry.delete();
        }
      }
    },

    async searchCompendium(packScope, documentType, nameQuery) {
      // Search in world and compendium packs (default to dnd5e if not specified).
      // `pack.metadata.name` is the pack's own short slug (e.g. "actors24"); the
      // fully-qualified `<package>.<name>` id used for scoping is `pack.collection`.
      const scope = packScope ?? "dnd5e";
      const query = nameQuery.toLowerCase();
      const matchingPacks = game.packs.filter(
        (pack: any) => pack.collection.startsWith(`${scope}.`) && pack.metadata.type === documentType,
      );
      // Each pack's index fetch is an independent I/O call; run them concurrently.
      const results = await Promise.all(
        matchingPacks.map(async (pack: any) => {
          const index = await pack.getIndex();
          const entries: CompendiumEntry[] = [];
          for (const entry of index) {
            if (String(entry.name ?? "").toLowerCase().includes(query)) {
              entries.push({
                uuid: entry.uuid ?? `${pack.collection}.${entry._id}`,
                pack: pack.collection,
                name: String(entry.name ?? ""),
                type: String(entry.type ?? documentType),
                cr: typeof entry.cr === "number" ? entry.cr : undefined,
              });
            }
          }
          return entries;
        }),
      );
      return results.flat();
    },

    async importFromCompendium(documentType, uuid, patch, folderId, opts) {
      let source;
      try {
        source = await fromUuid(uuid);
      } catch (e) {
        // fromUuid can throw for reasons other than "doesn't exist" (a
        // malformed uuid, an unindexed pack) -- keep NOT_FOUND as the code
        // (still the most useful default) but preserve the real message
        // instead of discarding it, so a genuine failure is diagnosable.
        throw new CommandExecutionError(
          "NOT_FOUND",
          `compendium entry ${uuid} not found`,
          { cause: (e as Error).message },
        );
      }
      if (!source) {
        throw new CommandExecutionError("NOT_FOUND", `compendium entry ${uuid} not found`);
      }
      const data = patch ? applyUpdate(source.toObject(), patch) : source.toObject();
      if (folderId) {
        data.folder = folderId;
      }
      const cls = getDocumentClass(documentType);
      if (opts.dryRun) {
        return new cls(data).toObject();
      }
      const doc = await cls.create(data);
      return doc.toObject();
    },
  } satisfies FoundryDocumentApi;
}
