/**
 * Real-Foundry implementation of {@link FoundryDocumentApi} plus module settings
 * (relay URL + token via game.settings — never hardcoded; see live-api-plan §5).
 *
 * This file talks to Foundry browser globals and is NOT exercised in CI; the
 * protocol logic is tested against the mock. Kept thin and obvious on purpose.
 */

import type { DocumentType } from "@foundry-mcp-bridge/shared";
import type {
  DocData,
  ExecuteOptions,
  FindSelector,
  FoundryDocumentApi,
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

/** Foundry world-collection accessor name for each document type. */
const COLLECTION: Record<DocumentType, string> = {
  Actor: "actors",
  Scene: "scenes",
  JournalEntry: "journal",
  RollTable: "tables",
  Item: "items",
  Macro: "macros",
  Playlist: "playlists",
};

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
  const accessor = COLLECTION[type];
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
      const doc = await cls.create(data);
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
  } satisfies FoundryDocumentApi;
}

function getByPath(obj: DocData, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}
