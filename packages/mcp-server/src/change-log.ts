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
import { z } from "zod";
import { Command, type Json, buildInverseUpdate, embeddedField } from "@foundry-mcp-bridge/shared";

/** Reads a document through the transport and returns its data, or undefined on any failure. */
export type ReadFn = (command: Command) => Promise<unknown>;

export interface ChangeContext {
  log: ChangeLog;
  /** Problems that must reach the caller without failing a write that already went through. */
  warnings: string[];
  /** One id per MCP tool call; composite tools share it, so a whole request can be undone. */
  requestId: string;
  tool: string;
}

/** The stored contract; log lines are validated against it when loaded. */
const ChangeEntrySchema = z.object({
  id: z.string().min(1),
  ts: z.string(),
  requestId: z.string(),
  tool: z.string(),
  summary: z.string(),
  /** `<world id>:<module-generated key>` of the world the change was made in; absent on old entries. */
  worldKey: z.string().min(1).optional(),
  /** The command that reverses this change, or null when no snapshot was available. */
  undo: Command.nullable(),
  undone: z.object({ ts: z.string(), by: z.string() }).optional(),
});
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

const EntryRow = ChangeEntrySchema.extend({ kind: z.literal("entry") });
const UndoneRow = z.object({ kind: z.literal("undone"), id: z.string().min(1), ts: z.string(), by: z.string() });

const asObj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!asObj(x)) : []);

export class ChangeLog {
  private readonly entries: ChangeEntry[] = [];
  /** True when the file's last line lacks a newline (a torn write): the next append must start a new line. */
  private needsNewline = false;

  /** @param file JSONL path; omit for an in-memory log (tests). */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) this.load(file);
  }

  private load(file: string): void {
    const text = readFileSync(file, "utf8");
    this.needsNewline = text.length > 0 && !text.endsWith("\n");
    const byId = new Map<string, ChangeEntry>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a torn line is skipped; every complete record around it is kept
      }
      const entry = EntryRow.safeParse(row);
      if (entry.success) {
        const { kind: _kind, ...rest } = entry.data;
        byId.set(rest.id, rest);
        this.entries.push(rest);
        continue;
      }
      const undone = UndoneRow.safeParse(row);
      const target = undone.success ? byId.get(undone.data.id) : undefined;
      if (undone.success && target) target.undone = { ts: undone.data.ts, by: undone.data.by };
    }
  }

  private append(row: Record<string, unknown>): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    // Never glue a record onto an unterminated line: that would corrupt both on the next load.
    appendFileSync(this.file, `${this.needsNewline ? "\n" : ""}${JSON.stringify(row)}\n`);
    this.needsNewline = false;
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
  record(ctx: ChangeContext, command: Command, before: unknown, result: unknown, worldKey?: string): ChangeEntry | null {
    const built = this.inverse(command, before, result);
    if (!built) return null;
    const entry: ChangeEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      requestId: ctx.requestId,
      tool: ctx.tool,
      summary: built.summary,
      ...(worldKey ? { worldKey } : {}),
      undo: built.undo,
    };
    // In memory first: if the file write fails, the change stays undoable until the server restarts.
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
          undo: prev ? { action: "update", documentType: command.documentType, id: command.id, data: buildInverseUpdate(prev, command.data) } : null,
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
          return old ? [{ ...buildInverseUpdate(old, diff), _id: String(diff._id) }] : [];
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
