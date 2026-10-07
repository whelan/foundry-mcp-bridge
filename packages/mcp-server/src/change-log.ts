/**
 * Change log + undo. Every real (non-dry-run) document write that goes through the
 * reliability pipeline is recorded together with the *inverse command* that reverses it,
 * computed at record time from a before-snapshot. Undo is then just "run that command
 * through the normal pipeline", which logs itself in turn.
 *
 * The log lives on the MCP server (JSONL, append-only) — it records what the bridge did,
 * not what other users do in Foundry. Quests, asset uploads and macro runs are not
 * recorded: they have no snapshot the bridge could restore.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Command, type Json, embeddedField, getByPath } from "@foundry-mcp-bridge/shared";

/** Reads a document through the transport and returns its data, or undefined on any failure. */
export type ReadFn = (command: Command) => Promise<unknown>;

export interface ChangeContext {
  log: ChangeLog;
  /** One id per MCP tool call; composite tools share it, so a whole request can be undone. */
  requestId: string;
  tool: string;
}

export interface ChangeEntry {
  id: string;
  ts: string;
  requestId: string;
  tool: string;
  summary: string;
  /** The command that reverses this change, or null when no snapshot was available. */
  undo: Command | null;
  undone?: { ts: string; by: string };
}

const asObj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!asObj(x)) : []);

/** Previous values for the keys a diff touched (dot-notation aware). */
function restoreDiff(before: Json, diff: Json): Json {
  const restore: Json = {};
  for (const key of Object.keys(diff)) {
    if (key !== "_id") restore[key] = getByPath(before, key) ?? null;
  }
  return restore;
}

export class ChangeLog {
  private readonly entries: ChangeEntry[] = [];

  /** @param file JSONL path; omit for an in-memory log (tests). */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) this.load(file);
  }

  private load(file: string): void {
    const byId = new Map<string, ChangeEntry>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { kind: string } & Record<string, any>;
        if (row.kind === "entry") {
          const { kind: _kind, ...entry } = row;
          byId.set(entry.id, entry as ChangeEntry);
          this.entries.push(entry as ChangeEntry);
        } else if (row.kind === "undone") {
          const target = byId.get(row.id);
          if (target) target.undone = { ts: row.ts, by: row.by };
        }
      } catch {
        // A torn last line must not take the whole log down.
      }
    }
  }

  private append(row: Record<string, unknown>): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(row)}\n`);
  }

  /** Snapshot what a write is about to change (only updates and deletes have something to save). */
  async capture(command: Command, read: ReadFn): Promise<unknown> {
    switch (command.action) {
      case "update":
      case "delete":
        return read({ action: "find", documentType: command.documentType, id: command.id });
      case "updateEmbedded":
      case "deleteEmbedded": {
        const parent = asObj(await read({ action: "find", documentType: command.parentType, id: command.parentId }));
        if (!parent) return undefined;
        const ids = new Set(command.action === "deleteEmbedded" ? command.ids : command.data.map((d) => String(d._id)));
        return asList(parent[embeddedField(command.embeddedName)]).filter((e) => ids.has(String(e._id)));
      }
      default:
        return undefined;
    }
  }

  /** Record a successful write with its inverse. Returns the entry, or null for unlogged commands. */
  record(ctx: ChangeContext, command: Command, before: unknown, result: unknown): ChangeEntry | null {
    const built = this.inverse(command, before, result);
    if (!built) return null;
    const entry: ChangeEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      requestId: ctx.requestId,
      tool: ctx.tool,
      summary: built.summary,
      undo: built.undo,
    };
    this.entries.push(entry);
    this.append({ kind: "entry", ...entry });
    return entry;
  }

  private inverse(command: Command, before: unknown, result: unknown): { summary: string; undo: Command | null } | null {
    switch (command.action) {
      case "create":
      case "duplicate":
      case "importFromCompendium": {
        const doc = asObj(result);
        const id = doc && typeof doc._id === "string" ? doc._id : undefined;
        return {
          summary: `${command.action} ${command.documentType} ${id ?? "?"}`,
          undo: id ? { action: "delete", documentType: command.documentType, id } : null,
        };
      }
      case "createEmbedded":
      case "importEmbeddedFromCompendium": {
        const ids = asList(result).map((d) => String(d._id));
        return {
          summary: `${command.action} ${command.parentType}/${command.embeddedName} on ${command.parentId} (${ids.length})`,
          undo: ids.length
            ? { action: "deleteEmbedded", parentType: command.parentType, parentId: command.parentId, embeddedName: command.embeddedName, ids }
            : null,
        };
      }
      case "update": {
        const prev = asObj(before);
        return {
          summary: `update ${command.documentType} ${command.id}`,
          undo: prev ? { action: "update", documentType: command.documentType, id: command.id, data: restoreDiff(prev, command.data) } : null,
        };
      }
      case "delete": {
        const prev = asObj(before);
        return {
          summary: `delete ${command.documentType} ${command.id}`,
          // keepId so references to the document survive the round trip.
          undo: prev ? { action: "create", documentType: command.documentType, data: prev, keepId: true } : null,
        };
      }
      case "updateEmbedded": {
        const prev = asList(before);
        const data = command.data.flatMap((diff) => {
          const old = prev.find((e) => e._id === diff._id);
          return old ? [{ _id: String(diff._id), ...restoreDiff(old, diff) }] : [];
        });
        return {
          summary: `updateEmbedded ${command.parentType}/${command.embeddedName} on ${command.parentId} (${command.data.length})`,
          undo: data.length === command.data.length
            ? { action: "updateEmbedded", parentType: command.parentType, parentId: command.parentId, embeddedName: command.embeddedName, data }
            : null,
        };
      }
      case "deleteEmbedded": {
        const prev = asList(before);
        return {
          summary: `deleteEmbedded ${command.parentType}/${command.embeddedName} on ${command.parentId} (${command.ids.length})`,
          // Foundry assigns fresh ids on re-creation, so ids of restored children change.
          undo: prev.length === command.ids.length && prev.length > 0
            ? { action: "createEmbedded", parentType: command.parentType, parentId: command.parentId, embeddedName: command.embeddedName, data: prev }
            : null,
        };
      }
      default:
        return null;
    }
  }

  /** Newest first. */
  list(filter: { tool?: string; requestId?: string; includeUndone?: boolean; limit?: number } = {}): ChangeEntry[] {
    return this.entries
      .filter((e) => (!filter.tool || e.tool === filter.tool) && (!filter.requestId || e.requestId === filter.requestId))
      .filter((e) => filter.includeUndone || !e.undone)
      .reverse()
      .slice(0, filter.limit ?? 20);
  }

  get(id: string): ChangeEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  markUndone(id: string, by: string): void {
    const entry = this.get(id);
    if (!entry) return;
    entry.undone = { ts: new Date().toISOString(), by };
    this.append({ kind: "undone", id, ts: entry.undone.ts, by });
  }
}
