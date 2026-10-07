/**
 * Per-category write permissions, set by the GM in the Foundry module's settings and
 * enforced by the module executor (and the mock) — never by the MCP side, and not
 * changeable through the bridge. Pure: maps a {@link Command} to the (category, operation)
 * it needs and checks it against a level lookup.
 */

import type { Command, CommandError, DocumentType } from "./protocol.js";

export const PERMISSION_CATEGORIES = [
  "actors",
  "scenes",
  "journals",
  "tables",
  "items",
  "macros",
  "playlists",
  "folders",
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/** read-only: no writes · no-delete: create + update · full: create + update + delete. */
export const PERMISSION_LEVELS = ["read-only", "no-delete", "full"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export type PermissionOp = "create" | "update" | "delete";

/** What a fresh world gets: the bridge may create and edit, but not delete. */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = "no-delete";

const CATEGORY_BY_TYPE: Record<DocumentType, PermissionCategory> = {
  Actor: "actors",
  Scene: "scenes",
  JournalEntry: "journals",
  RollTable: "tables",
  Item: "items",
  Macro: "macros",
  Playlist: "playlists",
  Folder: "folders",
};

/** The category + operation a command needs, or null when it writes no world documents. */
export function commandPermission(command: Command): { category: PermissionCategory; op: PermissionOp } | null {
  switch (command.action) {
    case "create":
    case "duplicate":
    case "importFromCompendium":
      return { category: CATEGORY_BY_TYPE[command.documentType], op: "create" };
    case "update":
      return { category: CATEGORY_BY_TYPE[command.documentType], op: "update" };
    case "delete":
      return { category: CATEGORY_BY_TYPE[command.documentType], op: "delete" };
    case "createEmbedded":
    case "importEmbeddedFromCompendium":
      return { category: CATEGORY_BY_TYPE[command.parentType], op: "create" };
    case "updateEmbedded":
      return { category: CATEGORY_BY_TYPE[command.parentType], op: "update" };
    case "deleteEmbedded":
      return { category: CATEGORY_BY_TYPE[command.parentType], op: "delete" };
    case "createQuest":
      return { category: "journals", op: "create" };
    case "updateQuest":
      return { category: "journals", op: "update" };
    case "deleteQuest":
      return { category: "journals", op: "delete" };
    case "activateScene":
    case "toggleCondition":
      return { category: "scenes", op: "update" };
    default:
      return null;
  }
}

export function levelAllows(level: PermissionLevel, op: PermissionOp): boolean {
  if (level === "full") return true;
  return level === "no-delete" && op !== "delete";
}

/**
 * Returns a FORBIDDEN error when the command needs more than the category's level grants.
 * Run identically by the module executor and the mock, like checkEnvelopeGuards.
 */
export function checkPermission(
  command: Command,
  levelOf: (category: PermissionCategory) => PermissionLevel,
): CommandError | null {
  const needed = commandPermission(command);
  if (!needed) return null;
  const level = levelOf(needed.category);
  if (levelAllows(level, needed.op)) return null;
  return {
    code: "FORBIDDEN",
    message:
      `The bridge may not ${needed.op} ${needed.category} (permission is "${level}"). ` +
      `A GM can change "Bridge permission: ${needed.category}" in the module's settings; the bridge cannot.`,
    details: { category: needed.category, op: needed.op, level },
  };
}
