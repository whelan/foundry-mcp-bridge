/**
 * In-memory "Foundry" that speaks the Command protocol with Foundry's key
 * conventions, plus a FilePicker mock exposing both a local ("data") and a
 * Forge ("forgevtt") source. Used to develop and test the module executor and
 * the MCP-server reliability pipeline without a real Foundry.
 *
 * See docs/foundry-mcp-bridge-project-plan.md (mock-first test strategy) and
 * docs/foundry-live-api-plan.md §10–§11.
 */

import {
  type Command,
  type CommandEnvelope,
  type CommandResult,
  type DocumentType,
  type CommandError,
  type Json,
  PROTOCOL_VERSION,
  randomID,
  ok,
  err,
  expandObject,
  getByPath,
  applyUpdate,
} from "@foundry-mcp-bridge/shared";

// ---------------------------------------------------------------------------
// Foundry key conventions
// ---------------------------------------------------------------------------

/** Top-level collection name for each document type (Foundry's db key segment). */
const COLLECTION: Record<DocumentType, string> = {
  Actor: "actors",
  Scene: "scenes",
  JournalEntry: "journal",
  RollTable: "tables",
  Item: "items",
  Macro: "macros",
  Playlist: "playlists",
};

/** Field name an embedded document lives under on its parent. */
const EMBEDDED_FIELD: Record<string, string> = {
  Token: "tokens",
  AmbientLight: "lights",
  Note: "notes",
  ActiveEffect: "effects",
  Item: "items",
  Wall: "walls",
  AmbientSound: "sounds",
  Drawing: "drawings",
  MeasuredTemplate: "templates",
  Tile: "tiles",
  Region: "regions",
};

/** `!actors!{id}` for a top-level document. */
export function documentKey(type: DocumentType, id: string): string {
  return `!${COLLECTION[type]}!${id}`;
}

/** `!scenes.tokens!{parentId}.{embeddedId}` for an embedded document. */
export function embeddedKey(
  parentType: DocumentType,
  embeddedName: string,
  parentId: string,
  embeddedId: string,
): string {
  const field = EMBEDDED_FIELD[embeddedName] ?? embeddedName.toLowerCase();
  return `!${COLLECTION[parentType]}.${field}!${parentId}.${embeddedId}`;
}

// Re-export the shared object helpers used to mirror Foundry's update semantics
// so existing importers of the mock keep working.
export { expandObject, getByPath, applyUpdate } from "@foundry-mcp-bridge/shared";

// ---------------------------------------------------------------------------
// FilePicker mock (local "data" + Forge "forgevtt")
// ---------------------------------------------------------------------------

export type FilePickerSource = "data" | "forgevtt";

export interface UploadRecord {
  source: FilePickerSource;
  path: string;
  name: string;
}

export class MockFilePicker {
  readonly uploads: UploadRecord[] = [];
  /** Per-source virtual file listing. */
  private readonly files: Record<FilePickerSource, Set<string>> = {
    data: new Set(),
    forgevtt: new Set(),
  };

  /** Mirrors FilePicker.upload(source, target, file, options). */
  async upload(
    source: FilePickerSource,
    target: string,
    file: { name: string },
  ): Promise<{ path: string }> {
    const path = `${target.replace(/\/$/, "")}/${file.name}`;
    this.files[source].add(path);
    this.uploads.push({ source, path, name: file.name });
    return { path };
  }

  /** Mirrors FilePicker.browse(source, target). */
  async browse(
    source: FilePickerSource,
    target: string,
  ): Promise<{ target: string; files: string[] }> {
    const prefix = target.replace(/\/$/, "");
    const files = [...this.files[source]].filter((p) => p.startsWith(prefix));
    return { target, files };
  }
}

// ---------------------------------------------------------------------------
// Injectable failures
// ---------------------------------------------------------------------------

interface QueuedFailure {
  /** Reject the call with a transport-style error (lost connection / crash). */
  throws?: Error;
  /** Delay (ms) before responding — used to exercise transport timeouts. */
  delayMs?: number;
  /** Return this protocol-level error result instead of executing. */
  result?: CommandError;
}

export interface MockFoundryOptions {
  /** Whether the executing user is a GM (the module's GM-only guard). */
  isGM?: boolean;
  /** Expected auth token; when set, envelopes must match it. */
  token?: string;
}

// ---------------------------------------------------------------------------
// MockFoundry
// ---------------------------------------------------------------------------

export class MockFoundry {
  /** Flat store keyed by Foundry db keys (`!actors!{id}`, embedded keys). */
  readonly store = new Map<string, Json>();
  readonly filePicker = new MockFilePicker();
  isGM: boolean;
  private readonly token?: string;
  private readonly failures: QueuedFailure[] = [];
  /** Forien's Quest Log store — quests are NOT raw JournalEntries (§7.1). */
  readonly quests = new Map<string, Json>();

  constructor(options: MockFoundryOptions = {}) {
    this.isGM = options.isGM ?? true;
    this.token = options.token;
  }

  /** Queue a one-shot injected failure consumed by the next execute(). */
  injectFailure(failure: QueuedFailure): void {
    this.failures.push(failure);
  }

  /** Convenience: next call rejects as if the transport died. */
  failNext(message = "connection lost"): void {
    this.injectFailure({ throws: new Error(message) });
  }

  /** Convenience: next call resolves only after `delayMs`. */
  hangNext(delayMs: number): void {
    this.injectFailure({ delayMs });
  }

  // --- collection helpers -------------------------------------------------

  /** Public read of a whole collection (test convenience). */
  documents(type: DocumentType): Json[] {
    return this.list(type);
  }

  private list(type: DocumentType): Json[] {
    const prefix = `!${COLLECTION[type]}!`;
    return [...this.store.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
  }

  private get(type: DocumentType, id: string): Json | undefined {
    return this.store.get(documentKey(type, id));
  }

  // --- main entry point ---------------------------------------------------

  async execute(envelope: CommandEnvelope): Promise<CommandResult> {
    const failure = this.failures.shift();
    if (failure?.throws) throw failure.throws;
    if (failure?.delayMs) {
      await new Promise((r) => setTimeout(r, failure.delayMs));
    }
    if (failure?.result) {
      return { id: envelope.id, ok: false, error: failure.result };
    }

    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      return err(envelope.id, "VALIDATION", "protocol version mismatch");
    }
    if (this.token !== undefined && envelope.token !== this.token) {
      return err(envelope.id, "AUTH", "invalid or missing token");
    }
    if (!this.isGM) {
      return err(envelope.id, "AUTH", "GM privileges required");
    }

    try {
      return this.dispatch(envelope.id, envelope.command, envelope.dryRun);
    } catch (e) {
      return err(envelope.id, "INTERNAL", (e as Error).message);
    }
  }

  private dispatch(id: string, command: Command, dryRun: boolean): CommandResult {
    switch (command.action) {
      case "create":
        return this.create(id, command.documentType, command.data, dryRun);
      case "update":
        return this.update(id, command.documentType, command.id, command.data, dryRun);
      case "delete":
        return this.delete(id, command.documentType, command.id, dryRun);
      case "createEmbedded":
        return this.createEmbedded(id, command, dryRun);
      case "updateEmbedded":
        return this.updateEmbedded(id, command, dryRun);
      case "deleteEmbedded":
        return this.deleteEmbedded(id, command, dryRun);
      case "find":
        return this.find(id, command);
      case "createQuest":
        return this.createQuest(id, command, dryRun);
    }
  }

  private create(
    id: string,
    type: DocumentType,
    data: Json,
    dryRun: boolean,
  ): CommandResult {
    const _id = typeof data._id === "string" && data._id ? data._id : randomID();
    const doc: Json = { ...data, _id };
    if (dryRun) return ok(id, { ...doc, _id: null, _dryRun: true });
    this.store.set(documentKey(type, _id), doc);
    return ok(id, doc);
  }

  private update(
    id: string,
    type: DocumentType,
    docId: string,
    diff: Json,
    dryRun: boolean,
  ): CommandResult {
    const existing = this.get(type, docId);
    if (!existing) return err(id, "NOT_FOUND", `${type} ${docId} not found`);
    const updated = applyUpdate(existing, diff);
    updated._id = docId;
    if (dryRun) return ok(id, { ...updated, _dryRun: true });
    this.store.set(documentKey(type, docId), updated);
    return ok(id, updated);
  }

  private delete(
    id: string,
    type: DocumentType,
    docId: string,
    dryRun: boolean,
  ): CommandResult {
    const key = documentKey(type, docId);
    if (!this.store.has(key)) return err(id, "NOT_FOUND", `${type} ${docId} not found`);
    if (!dryRun) this.store.delete(key);
    return ok(id, { _id: docId, deleted: true });
  }

  private embeddedArray(parent: Json, embeddedName: string): Json[] {
    const field = EMBEDDED_FIELD[embeddedName] ?? embeddedName.toLowerCase();
    if (!Array.isArray(parent[field])) parent[field] = [];
    return parent[field] as Json[];
  }

  private createEmbedded(
    id: string,
    cmd: Extract<Command, { action: "createEmbedded" }>,
    dryRun: boolean,
  ): CommandResult {
    const parent = this.get(cmd.parentType, cmd.parentId);
    if (!parent) {
      return err(id, "NOT_FOUND", `${cmd.parentType} ${cmd.parentId} not found`);
    }
    const created = cmd.data.map((entry) => ({
      ...entry,
      _id: typeof entry._id === "string" && entry._id ? entry._id : randomID(),
    }));
    if (dryRun) return ok(id, created.map((c) => ({ ...c, _dryRun: true })));
    const arr = this.embeddedArray(parent, cmd.embeddedName);
    arr.push(...created);
    return ok(id, created);
  }

  private updateEmbedded(
    id: string,
    cmd: Extract<Command, { action: "updateEmbedded" }>,
    dryRun: boolean,
  ): CommandResult {
    const parent = this.get(cmd.parentType, cmd.parentId);
    if (!parent) {
      return err(id, "NOT_FOUND", `${cmd.parentType} ${cmd.parentId} not found`);
    }
    const arr = this.embeddedArray(parent, cmd.embeddedName);
    const updated: Json[] = [];
    for (const diff of cmd.data) {
      const idx = arr.findIndex((e) => e._id === diff._id);
      if (idx === -1) {
        return err(id, "NOT_FOUND", `embedded ${String(diff._id)} not found`);
      }
      const merged = applyUpdate(arr[idx]!, diff);
      if (!dryRun) arr[idx] = merged;
      updated.push(merged);
    }
    return ok(id, dryRun ? updated.map((u) => ({ ...u, _dryRun: true })) : updated);
  }

  private deleteEmbedded(
    id: string,
    cmd: Extract<Command, { action: "deleteEmbedded" }>,
    dryRun: boolean,
  ): CommandResult {
    const parent = this.get(cmd.parentType, cmd.parentId);
    if (!parent) {
      return err(id, "NOT_FOUND", `${cmd.parentType} ${cmd.parentId} not found`);
    }
    const arr = this.embeddedArray(parent, cmd.embeddedName);
    const deleted: string[] = [];
    for (const embeddedId of cmd.ids) {
      const idx = arr.findIndex((e) => e._id === embeddedId);
      if (idx === -1) return err(id, "NOT_FOUND", `embedded ${embeddedId} not found`);
      if (!dryRun) arr.splice(idx, 1);
      deleted.push(embeddedId);
    }
    return ok(id, { deleted });
  }

  private find(
    id: string,
    cmd: Extract<Command, { action: "find" }>,
  ): CommandResult {
    if (cmd.id) {
      const doc = this.get(cmd.documentType, cmd.id);
      if (!doc) return err(id, "NOT_FOUND", `${cmd.documentType} ${cmd.id} not found`);
      return ok(id, doc);
    }
    const all = this.list(cmd.documentType);
    if (!cmd.query) return ok(id, all);
    const matches = all.filter((doc) =>
      Object.entries(cmd.query!).every(([path, value]) => getByPath(doc, path) === value),
    );
    return ok(id, matches);
  }

  private createQuest(
    id: string,
    cmd: Extract<Command, { action: "createQuest" }>,
    dryRun: boolean,
  ): CommandResult {
    const questId = randomID();
    const questData = {
      _id: questId,
      name: (cmd.data?.name as string) || "New Quest",
      status: (cmd.data?.status as string) || "inactive",
      ...cmd.data,
    };

    if (cmd.parentId) {
      questData.parent = cmd.parentId;
    }

    if (dryRun) {
      return ok(id, { ...questData, _dryRun: true });
    }

    this.quests.set(questId, questData);
    return ok(id, questData);
  }
}
