/** list_changes / undo_change: browse the bridge's change log and reverse entries. */

import { z } from "zod";
import type { Command } from "@foundry-mcp-bridge/shared";
import type { ChangeEntry, ChangeLog } from "./change-log.js";
import type { RelayTransport } from "./relay-transport.js";
import {
  createDocumentReliable,
  createEmbeddedReliable,
  deleteDocumentReliable,
  deleteEmbeddedReliable,
  updateDocumentReliable,
  updateEmbeddedReliable,
  type PipelineOptions,
  type ToolOutcome,
} from "./reliability.js";

const fail = (code: "VALIDATION" | "NOT_FOUND" | "UNSUPPORTED", message: string): ToolOutcome => ({
  ok: false,
  error: { code, message },
  steps: [],
});

const view = (e: ChangeEntry) => ({
  id: e.id,
  ts: e.ts,
  requestId: e.requestId,
  tool: e.tool,
  summary: e.summary,
  undoable: e.undo !== null && !e.undone,
  ...(e.undone ? { undone: e.undone } : {}),
});

// --- list_changes ------------------------------------------------------------

export const ListChangesShape = {
  tool: z.string().min(1).optional().describe("Only changes made by this tool, e.g. update_document"),
  requestId: z.string().min(1).optional().describe("Only changes from one tool call"),
  includeUndone: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(20),
};
export type ListChangesArgs = z.input<z.ZodObject<typeof ListChangesShape>>;

export async function runListChanges(log: ChangeLog | null, args: ListChangesArgs): Promise<ToolOutcome> {
  if (!log) return fail("UNSUPPORTED", "The change log is switched off (CHANGE_LOG=0)");
  return { ok: true, data: log.list(args).map(view), steps: ["list"] };
}

// --- undo_change -------------------------------------------------------------

export const UndoChangeShape = {
  id: z.string().min(1).optional().describe("One change id from list_changes"),
  requestId: z.string().min(1).optional().describe("Undo every change of one tool call, newest first"),
};
export type UndoChangeArgs = z.infer<z.ZodObject<typeof UndoChangeShape>>;

/** Run an inverse command through the matching reliability pipeline. */
function runInverse(transport: RelayTransport, command: Command, opts: PipelineOptions): Promise<ToolOutcome> {
  switch (command.action) {
    case "delete":
      return deleteDocumentReliable(transport, command, opts);
    case "create":
      return createDocumentReliable(transport, command, opts);
    case "update":
      return updateDocumentReliable(transport, command, opts);
    case "createEmbedded":
      return createEmbeddedReliable(transport, command, opts);
    case "updateEmbedded":
      return updateEmbeddedReliable(transport, command, opts);
    case "deleteEmbedded":
      return deleteEmbeddedReliable(transport, command, opts);
    default:
      return Promise.resolve(fail("UNSUPPORTED", `Cannot undo with a ${command.action} command`));
  }
}

export async function runUndoChange(
  log: ChangeLog | null,
  transport: RelayTransport,
  args: UndoChangeArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  if (!log) return fail("UNSUPPORTED", "The change log is switched off (CHANGE_LOG=0)");
  if (Boolean(args.id) === Boolean(args.requestId)) return fail("VALIDATION", "undo_change needs exactly one of id or requestId");

  const targets = args.id ? [log.get(args.id)] : log.list({ requestId: args.requestId, limit: 1000 });
  if (!targets.length || targets.some((t) => !t)) return fail("NOT_FOUND", "No such change");
  const results: Array<{ id: string; summary: string; ok: boolean; error?: string }> = [];
  for (const entry of targets as ChangeEntry[]) {
    if (entry.undone) return fail("VALIDATION", `Change ${entry.id} is already undone`);
    if (!entry.undo) {
      results.push({ id: entry.id, summary: entry.summary, ok: false, error: "no snapshot was available, so this change cannot be undone" });
      break;
    }
    const out = await runInverse(transport, entry.undo, opts);
    if (!out.ok) {
      results.push({ id: entry.id, summary: entry.summary, ok: false, error: `${out.error.code}: ${out.error.message}` });
      break; // later (older) changes may depend on this one
    }
    log.markUndone(entry.id, opts.changes?.requestId ?? "undo");
    results.push({ id: entry.id, summary: entry.summary, ok: true });
  }
  const failed = results.find((r) => !r.ok);
  return failed
    ? { ok: false, error: { code: "INTERNAL", message: `Undo stopped at ${failed.id}: ${failed.error}`, details: { results } }, steps: ["undo"] }
    : { ok: true, data: { undone: results }, steps: ["undo"] };
}
