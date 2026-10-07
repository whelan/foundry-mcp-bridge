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
  resolveWorldKey,
  updateDocumentReliable,
  updateEmbeddedReliable,
  type PipelineOptions,
  type ToolOutcome,
} from "./reliability.js";

const fail = (code: "VALIDATION" | "NOT_FOUND" | "UNSUPPORTED" | "CONFLICT" | "INTERNAL", message: string): ToolOutcome => ({
  ok: false,
  error: { code, message },
  steps: [],
});

const view = (e: ChangeEntry, currentWorld: string | undefined) => ({
  id: e.id,
  ts: e.ts,
  requestId: e.requestId,
  tool: e.tool,
  summary: e.summary,
  undoable: e.undo !== null && !e.undone && e.worldKey !== undefined && e.worldKey === currentWorld,
  ...(e.worldKey === undefined ? { world: "unknown" } : e.worldKey === currentWorld ? {} : { world: "other" }),
  ...(e.undone ? { undone: e.undone } : {}),
});

// --- list_changes ------------------------------------------------------------

export const ListChangesShape = {
  tool: z.string().min(1).optional().describe("Only changes made by this tool, e.g. update_document"),
  requestId: z.string().min(1).optional().describe("Only changes from one tool call"),
  includeUndone: z.boolean().optional(),
  allWorlds: z.boolean().optional().describe("Also list changes made in other Foundry worlds or without a world identity (never undoable here)"),
  limit: z.number().int().min(1).max(200).default(20),
};
export type ListChangesArgs = z.input<z.ZodObject<typeof ListChangesShape>>;

export async function runListChanges(
  log: ChangeLog | null,
  transport: RelayTransport,
  args: ListChangesArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  if (!log) return fail("UNSUPPORTED", "The change log is switched off (CHANGE_LOG=0)");
  const world = await resolveWorldKey(transport, opts);
  if (!world && !args.allWorlds) {
    return fail("INTERNAL", "Cannot tell which Foundry world is connected (is the module connected and up to date?); pass allWorlds:true to list everything");
  }
  // The log is shared by every world this server has talked to, so scope it to the connected one.
  const entries = log.list({ ...args, limit: args.allWorlds ? args.limit : 1000 }).filter((e) => args.allWorlds || e.worldKey === world);
  return { ok: true, data: entries.slice(0, args.limit ?? 20).map((e) => view(e, world)), steps: ["list"] };
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

  // An inverse addresses documents by id, and ids repeat across copied worlds: only undo in the world
  // the change was made in.
  const world = await resolveWorldKey(transport, opts);
  if (!world) return fail("INTERNAL", "Cannot tell which Foundry world is connected, so nothing was undone");
  for (const entry of targets as ChangeEntry[]) {
    if (entry.undone) return fail("VALIDATION", `Change ${entry.id} is already undone`);
    if (!entry.worldKey) return fail("UNSUPPORTED", `Change ${entry.id} was logged without a world identity and cannot be undone safely`);
    if (entry.worldKey !== world) return fail("CONFLICT", `Change ${entry.id} was made in a different Foundry world than the connected one`);
  }

  const results: Array<{ id: string; summary: string; ok: boolean; error?: string }> = [];
  const warnings: string[] = [];
  for (const entry of targets as ChangeEntry[]) {
    if (!entry.undo) {
      results.push({ id: entry.id, summary: entry.summary, ok: false, error: "no snapshot was available, so this change cannot be undone" });
      break;
    }
    const out = await runInverse(transport, entry.undo, opts);
    warnings.push(...(out.warnings ?? []));
    if (!out.ok) {
      results.push({ id: entry.id, summary: entry.summary, ok: false, error: `${out.error.code}: ${out.error.message}` });
      break; // later (older) changes may depend on this one
    }
    try {
      log.markUndone(entry.id, opts.changes?.requestId ?? "undo");
    } catch (e) {
      warnings.push(`Change ${entry.id} was undone but that could not be saved to the log (${(e as Error).message}); after a restart it will look undoable again.`);
    }
    results.push({ id: entry.id, summary: entry.summary, ok: true });
  }
  const failed = results.find((r) => !r.ok);
  const extra = warnings.length ? { warnings } : {};
  return failed
    ? { ok: false, error: { code: "INTERNAL", message: `Undo stopped at ${failed.id}: ${failed.error}`, details: { results } }, steps: ["undo"], ...extra }
    : { ok: true, data: { undone: results }, steps: ["undo"], ...extra };
}
