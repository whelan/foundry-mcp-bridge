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
  COLLECTIONS,
  EMBEDDED_FIELDS,
  checkEnvelopeGuards,
  checkPermission,
  type PermissionCategory,
  type PermissionLevel,
  embeddedField,
  randomID,
  ok,
  err,
  expandObject,
  getByPath,
  applyUpdate,
  isPlainObject,
  buildChatLog,
  buildSceneState,
  type SceneState,
  chatLogWindow,
} from "@foundry-mcp-bridge/shared";
import type { WorldInfo, CompendiumEntry } from "../../packages/foundry-module/src/protocol-executor.js";
import { loadSrdFixtures, PACK_NAME_BY_TYPE } from "../fixtures/dnd5e-srd/loader.js";

/** Deterministic slug for a compendium item's synthetic uuid segment. */
function mockItemSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

/**
 * A compendium entry as the mock stores it: `documentType`/`pack` are kept
 * separate from `data` so filtering by document type never clobbers the
 * fixture's own game-system subtype (`data.type`, e.g. "npc"), matching how
 * real Foundry compendium index entries distinguish the two.
 */
interface CompendiumRecord {
  documentType: DocumentType;
  pack: string;
  data: Json;
}

// ---------------------------------------------------------------------------
// Foundry key conventions
// ---------------------------------------------------------------------------

/** `!actors!{id}` for a top-level document. */
export function documentKey(type: DocumentType, id: string): string {
  return `!${COLLECTIONS[type]}!${id}`;
}

/** `!scenes.tokens!{parentId}.{embeddedId}` for an embedded document. */
export function embeddedKey(
  parentType: DocumentType,
  embeddedName: string,
  parentId: string,
  embeddedId: string,
): string {
  return `!${COLLECTIONS[parentType]}.${embeddedField(embeddedName)}!${parentId}.${embeddedId}`;
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
    return this.put(source, target, file.name);
  }

  /** Synchronous core of upload, callable from the (sync) command dispatch. */
  put(source: FilePickerSource, target: string, name: string): { path: string } {
    const path = `${target.replace(/\/$/, "")}/${name}`;
    this.files[source].add(path);
    this.uploads.push({ source, path, name });
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

  /** Batch variant of put; honours skipExisting against the per-source file set. */
  putBatch(
    source: FilePickerSource,
    target: string,
    files: Array<{ filename: string }>,
    skipExisting?: boolean,
  ): Array<{ filename: string; path: string; skipped?: boolean }> {
    const prefix = target.replace(/\/$/, "");
    return files.map((f) => {
      const path = `${prefix}/${f.filename}`;
      if (skipExisting && this.files[source].has(path)) {
        return { filename: f.filename, path, skipped: true };
      }
      this.put(source, target, f.filename);
      return { filename: f.filename, path };
    });
  }

  /** Extended browse that also returns direct subdirectories, with optional extension filter. */
  browseWithDirs(
    source: FilePickerSource,
    target: string,
    extensions?: string[],
  ): { dirs: string[]; files: string[]; target: string } {
    const prefix = target.replace(/\/$/, "");
    const allPaths = [...this.files[source]];
    const files = allPaths.filter((p) => {
      if (!p.startsWith(prefix + "/")) return false;
      const rel = p.slice(prefix.length + 1);
      if (rel.includes("/")) return false; // not a direct child
      if (extensions?.length) {
        return extensions.some((ext) => p.endsWith(ext));
      }
      return true;
    });
    const dirs = [...new Set(
      allPaths
        .filter((p) => p.startsWith(prefix + "/"))
        .map((p) => {
          const rel = p.slice(prefix.length + 1);
          return rel.includes("/") ? `${prefix}/${rel.split("/")[0]}` : null;
        })
        .filter((d): d is string => d !== null),
    )];
    return { dirs, files, target: prefix };
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
  /** Override the world snapshot returned by getWorldInfo. */
  worldInfo?: Partial<WorldInfo>;
  /** The GM's "Allow the bridge to run macros" setting (off by default, as in the module). */
  allowMacros?: boolean;
  /** Per-category bridge permission, as the GM sets in Module Settings (default: full). */
  permissions?: Partial<Record<PermissionCategory, PermissionLevel>>;
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
  /** World snapshot returned by getWorldInfo (overridable for tests). */
  readonly worldInfo: WorldInfo;
  /** Compendium entries loaded from fixtures. */
  readonly compendium = new Map<string, CompendiumRecord>();
  /**
   * Raw ChatMessage sources. Chat is not a DocumentType — nothing creates or
   * deletes one through the protocol — so tests seed it directly.
   */
  readonly chatMessages: Json[] = [];
  /** Images shared to the players via showImage, in order. */
  readonly shownImages: Array<{ src: string; title?: string; uuid?: string }> = [];
  /** User id → name, for resolving a chat message's author. */
  readonly users = new Map<string, string>();
  /** The GM's "Allow the bridge to run macros" setting; flip it in a test. */
  allowMacros: boolean;
  /** Macros the bridge ran: what was run and the scope it was given, in order. */
  readonly macroRuns: Array<{ id: string; name: string; scope: Json }> = [];
  /** The GM's per-category bridge permissions; flip them in a test. */
  readonly permissions: Partial<Record<PermissionCategory, PermissionLevel>>;
  /** Scene the table sees (activateScene "activate") and the one the GM views. */
  activeSceneId: string | null = null;
  viewedSceneId: string | null = null;
  /** Conditions the world knows (CONFIG.statusEffects ids). */
  readonly knownStatuses = new Set(["prone", "poisoned", "blinded", "dead", "invisible"]);
  /** What the next macro run returns, keyed by macro name (default null). */
  readonly macroResults = new Map<string, unknown>();

  constructor(options: MockFoundryOptions = {}) {
    this.isGM = options.isGM ?? true;
    this.allowMacros = options.allowMacros ?? false;
    this.permissions = { ...options.permissions };
    this.token = options.token;
    this.worldInfo = {
      foundryVersion: "13.0.0",
      system: { id: "dnd5e", version: "3.0.0" },
      world: { id: "test-world", title: "Test World", key: "mock-world-key" },
      folders: [],
      forge: { active: false, userId: null },
      ...options.worldInfo,
    };
    // Load SRD fixtures into compendium
    this.loadFixtures();
  }

  private loadFixtures(): void {
    const fixtures = loadSrdFixtures();
    for (const [type, byId] of fixtures) {
      const pack = `dnd5e.${PACK_NAME_BY_TYPE[type]}`;
      for (const [, fixture] of byId) {
        const uuid = `Compendium.${pack}.${fixture.id}`;
        // Deep-clone off the shared, memoized fixture cache (loader.ts) so
        // later mutations to an imported document's embedded collections
        // (createEmbedded/updateEmbedded/deleteEmbedded) can never leak back
        // into the fixture data other MockFoundry instances read.
        const data = structuredClone({ ...fixture.data, _id: fixture.id, name: fixture.name });
        this.compendium.set(uuid, { documentType: type as DocumentType, pack, data });
      }
    }
  }

  /** Seed a raw ChatMessage source, as Foundry would store it. */
  addChatMessage(raw: Json): void {
    this.chatMessages.push(raw);
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

  /**
   * getSceneState as the module computes it. The origin is an APPROXIMATION of Foundry's
   * `scene.dimensions.sceneX/Y` (padding rounded up to a grid square; shifts ignored) — the
   * real value is only verifiable in a live world.
   */
  private sceneState(scene: Json): SceneState {
    const size = (scene.grid as Json).size as number;
    const padding = (scene.padding as number | undefined) ?? 0.25;
    const conditions: Record<string, string[]> = {};
    for (const token of this.embeddedArray(scene, "Token")) {
      const holder = token.actorLink ? this.get("Actor", String(token.actorId)) : token;
      conditions[String(token._id)] = Array.isArray(holder?.statuses) ? (holder!.statuses as string[]) : [];
    }
    return buildSceneState(scene, {
      active: scene._id === this.activeSceneId,
      origin: {
        x: Math.ceil(((scene.width as number) * padding) / size) * size,
        y: Math.ceil(((scene.height as number) * padding) / size) * size,
      },
      conditions,
    });
  }

  private list(type: DocumentType): Json[] {
    const prefix = `!${COLLECTIONS[type]}!`;
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

    const guardError = checkEnvelopeGuards(envelope, {
      isGM: this.isGM,
      expectedToken: this.token,
    });
    if (guardError) return { id: envelope.id, ok: false, error: guardError };
    const denied = checkPermission(envelope.command, (c) => this.permissions[c] ?? "full");
    if (denied) return { id: envelope.id, ok: false, error: denied };

    try {
      return this.dispatch(envelope.id, envelope.command, envelope.dryRun);
    } catch (e) {
      return err(envelope.id, "INTERNAL", (e as Error).message);
    }
  }

  private dispatch(id: string, command: Command, dryRun: boolean): CommandResult {
    switch (command.action) {
      case "create":
        return this.create(id, command.documentType, command.data, command.keepId ?? false, dryRun);
      case "update":
        return this.update(id, command.documentType, command.id, command.data, dryRun);
      case "delete":
        return this.delete(id, command.documentType, command.id, dryRun);
      case "duplicate":
        return this.duplicate(id, command.documentType, command.id, command.overrides, dryRun);
      case "createEmbedded":
        return this.createEmbedded(id, command, dryRun);
      case "updateEmbedded":
        return this.updateEmbedded(id, command, dryRun);
      case "deleteEmbedded":
        return this.deleteEmbedded(id, command, dryRun);
      case "find":
        return this.find(id, command);
      case "getWorldInfo":
        return ok(id, this.worldInfo as unknown as Json);
      case "uploadAsset": {
        const target = command.target.replace(/\/$/, "");
        if (dryRun) return ok(id, { path: `${target}/${command.filename}` });
        return ok(id, this.filePicker.put(command.source, target, command.filename));
      }
      case "browseAssets": {
        const target = command.target.replace(/\/$/, "");
        if (dryRun) return ok(id, { dirs: [], files: [], target });
        return ok(id, this.filePicker.browseWithDirs(command.source, target, command.extensions));
      }
      case "batchUploadAssets": {
        const target = command.target.replace(/\/$/, "");
        if (dryRun) {
          return ok(id, command.files.map((f) => ({ filename: f.filename, path: `${target}/${f.filename}` })));
        }
        return ok(id, this.filePicker.putBatch(command.source, target, command.files, command.skipExisting));
      }
      case "createQuest":
        return this.createQuest(id, command, dryRun);
      case "updateQuest":
        return this.updateQuest(id, command, dryRun);
      case "deleteQuest":
        return this.deleteQuest(id, command, dryRun);
      case "searchCompendium":
        return this.searchCompendium(id, command);
      case "importFromCompendium":
        return this.importFromCompendium(id, command, dryRun);
      case "importEmbeddedFromCompendium":
        return this.importEmbeddedFromCompendium(id, command, dryRun);
      case "getCompendiumDocument":
        return this.getCompendiumDocument(id, command);
      case "getChatLog": {
        const resolved = chatLogWindow(command.start, command.end, command.limit);
        if ("error" in resolved) return err(id, "VALIDATION", resolved.error);
        const log = buildChatLog(this.chatMessages, resolved.window, (uid) => this.users.get(uid));
        return ok(id, log as unknown as Json);
      }
      case "runMacro": {
        if (Boolean(command.id) === Boolean(command.name)) {
          return err(id, "VALIDATION", "runMacro needs exactly one of id or name");
        }
        if (!this.allowMacros) {
          return err(id, "UNSUPPORTED", "Running macros through the bridge is switched off.");
        }
        const found = this.list("Macro").filter((m) =>
          command.id ? m._id === command.id : m.name === command.name,
        );
        if (found.length === 0) return err(id, "NOT_FOUND", "No such macro");
        if (found.length > 1) return err(id, "CONFLICT", "More than one macro has that name");
        const macro = found[0]!;
        if (macro.type !== "script") return err(id, "VALIDATION", "Only script macros can run");
        const base = { macroId: String(macro._id), name: String(macro.name) };
        if (dryRun) return ok(id, { ...base, ran: false });
        this.macroRuns.push({ id: base.macroId, name: base.name, scope: (command.args ?? {}) as Json });
        return ok(id, { ...base, ran: true, result: this.macroResults.get(base.name) ?? null });
      }
      case "activateScene": {
        const scene = this.get("Scene", command.id);
        if (!scene) return err(id, "NOT_FOUND", `Scene ${command.id} not found`);
        const base = { _id: command.id, name: String(scene.name), mode: command.mode };
        if (dryRun) return ok(id, { ...base, done: false });
        this.viewedSceneId = command.id;
        if (command.mode === "activate") this.activeSceneId = command.id;
        return ok(id, { ...base, done: true });
      }
      case "getSceneState": {
        const sceneId = command.id ?? this.viewedSceneId ?? this.activeSceneId;
        const scene = sceneId ? this.get("Scene", sceneId) : undefined;
        if (!scene) return err(id, "NOT_FOUND", "No scene to describe: pass an id or view a scene");
        return ok(id, this.sceneState(scene) as unknown as Json);
      }
      case "toggleCondition": {
        const scene = this.get("Scene", command.sceneId);
        if (!scene) return err(id, "NOT_FOUND", `Scene ${command.sceneId} not found`);
        const token = this.embeddedArray(scene, "Token").find((t) => t._id === command.tokenId);
        if (!token) return err(id, "NOT_FOUND", `No token ${command.tokenId} in scene ${command.sceneId}`);
        if (!token.actorId) return err(id, "VALIDATION", `Token ${command.tokenId} has no actor`);
        if (!this.knownStatuses.has(command.statusId)) {
          return err(id, "VALIDATION", `Unknown status condition "${command.statusId}"`);
        }
        // Foundry semantics: a linked token shares its world actor's statuses; an unlinked token
        // has its own synthetic actor, so only that token changes.
        const holder = token.actorLink ? this.get("Actor", String(token.actorId)) : token;
        if (!holder) return err(id, "NOT_FOUND", `Actor ${String(token.actorId)} not found`);
        const statuses = new Set<string>(Array.isArray(holder.statuses) ? (holder.statuses as string[]) : []);
        const want = command.active ?? !statuses.has(command.statusId);
        if (!dryRun) {
          if (want) statuses.add(command.statusId);
          else statuses.delete(command.statusId);
          holder.statuses = [...statuses];
        }
        return ok(id, { tokenId: command.tokenId, statusId: command.statusId, active: want });
      }
      case "showImage": {
        if (dryRun) return ok(id, { src: command.src, shown: false });
        this.shownImages.push({ src: command.src, title: command.title, uuid: command.uuid });
        return ok(id, { src: command.src, shown: true, via: "popout" });
      }
    }
  }

  private create(
    id: string,
    type: DocumentType,
    data: Json,
    keepId: boolean,
    dryRun: boolean,
  ): CommandResult {
    // Mirror Foundry: an explicit data._id is honored only with keepId; otherwise
    // a fresh id is minted (so tests can't rely on ids the live system wouldn't keep).
    const _id = keepId && typeof data._id === "string" && data._id ? data._id : randomID();
    const doc: Json = { ...data, _id };
    // Mirror Foundry: _stats is stamped by the server at creation, whatever the payload carried
    // (a re-created document from a snapshot gets new createdTime/modifiedTime).
    const now = Date.now();
    doc._stats = { ...(isPlainObject(data._stats) ? data._stats : {}), createdTime: now, modifiedTime: now };
    // Real Foundry auto-assigns an _id to every embedded document when the
    // parent is created, including ones passed inline in the creation payload
    // (e.g. Actor.create({ items: [...] })) — items without one would be
    // unaddressable by any later updateEmbedded/deleteEmbedded/find call.
    for (const field of new Set(Object.values(EMBEDDED_FIELDS))) {
      const arr = doc[field];
      if (Array.isArray(arr)) {
        doc[field] = arr.map((entry) =>
          isPlainObject(entry) && typeof entry._id === "string" && entry._id
            ? entry
            : { ...(entry as Json), _id: randomID() },
        );
      }
    }
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

  private duplicate(
    id: string,
    type: DocumentType,
    docId: string,
    overrides: Json | undefined,
    dryRun: boolean,
  ): CommandResult {
    const existing = this.get(type, docId);
    if (!existing) return err(id, "NOT_FOUND", `${type} ${docId} not found`);
    // applyUpdate clones the source (structuredClone), so the original is intact;
    // a fresh _id makes the copy a distinct document.
    const newId = randomID();
    const copy = overrides ? applyUpdate(existing, overrides) : structuredClone(existing);
    copy._id = newId;
    if (dryRun) return ok(id, { ...copy, _id: null, _dryRun: true });
    this.store.set(documentKey(type, newId), copy);
    return ok(id, copy);
  }

  private embeddedArray(parent: Json, embeddedName: string): Json[] {
    const field = embeddedField(embeddedName);
    if (!Array.isArray(parent[field])) parent[field] = [];
    return parent[field] as Json[];
  }

  /** Resolve a parent's embedded collection, or a NOT_FOUND result. */
  private resolveEmbedded(
    id: string,
    cmd: { parentType: DocumentType; parentId: string; embeddedName: string },
  ): { arr: Json[] } | { error: CommandResult } {
    const parent = this.get(cmd.parentType, cmd.parentId);
    if (!parent) {
      return { error: err(id, "NOT_FOUND", `${cmd.parentType} ${cmd.parentId} not found`) };
    }
    return { arr: this.embeddedArray(parent, cmd.embeddedName) };
  }

  private createEmbedded(
    id: string,
    cmd: Extract<Command, { action: "createEmbedded" }>,
    dryRun: boolean,
  ): CommandResult {
    const resolved = this.resolveEmbedded(id, cmd);
    if ("error" in resolved) return resolved.error;
    const created = cmd.data.map((entry) => ({
      ...entry,
      _id: typeof entry._id === "string" && entry._id ? entry._id : randomID(),
    }));
    if (dryRun) return ok(id, created.map((c) => ({ ...c, _dryRun: true })));
    resolved.arr.push(...created);
    return ok(id, created);
  }

  private updateEmbedded(
    id: string,
    cmd: Extract<Command, { action: "updateEmbedded" }>,
    dryRun: boolean,
  ): CommandResult {
    const resolved = this.resolveEmbedded(id, cmd);
    if ("error" in resolved) return resolved.error;
    const arr = resolved.arr;
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
    const resolved = this.resolveEmbedded(id, cmd);
    if ("error" in resolved) return resolved.error;
    const arr = resolved.arr;
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

    // Helper function to check if a value matches a query recursively
    const matches = (docValue: unknown, queryValue: unknown): boolean => {
      if (queryValue === null || typeof queryValue !== "object" || Array.isArray(queryValue)) {
        return docValue === queryValue;
      }
      // If queryValue is an object (but not an array), check all its keys
      for (const [key, qv] of Object.entries(queryValue)) {
        if (typeof docValue !== "object" || docValue === null || !(key in docValue)) {
          return false;
        }
        if (!matches((docValue as Record<string, unknown>)[key], qv)) {
          return false;
        }
      }
      return true;
    };

    const matchDocs = all.filter((doc) =>
      Object.entries(cmd.query!).every(([path, value]) => {
        const docValue = getByPath(doc, path);
        return matches(docValue, value);
      }),
    );
    return ok(id, matchDocs);
  }

  private createQuest(
    id: string,
    cmd: Extract<Command, { action: "createQuest" }>,
    dryRun: boolean,
  ): CommandResult {
    const questId = randomID();
    const questData: Json = {
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

  private updateQuest(
    id: string,
    cmd: Extract<Command, { action: "updateQuest" }>,
    dryRun: boolean,
  ): CommandResult {
    const quest = this.quests.get(cmd.id);
    if (!quest) return err(id, "NOT_FOUND", `quest ${cmd.id} not found`);

    const updated = { ...quest, ...cmd.data, _id: cmd.id };
    if (dryRun) {
      return ok(id, { ...updated, _dryRun: true });
    }

    this.quests.set(cmd.id, updated);
    return ok(id, updated);
  }

  private deleteQuest(
    id: string,
    cmd: Extract<Command, { action: "deleteQuest" }>,
    dryRun: boolean,
  ): CommandResult {
    if (!this.quests.has(cmd.id)) {
      return err(id, "NOT_FOUND", `quest ${cmd.id} not found`);
    }

    if (!dryRun) {
      this.quests.delete(cmd.id);
    }

    return ok(id, { _id: cmd.id, deleted: true });
  }

  private searchCompendium(
    id: string,
    cmd: Extract<Command, { action: "searchCompendium" }>,
  ): CommandResult {
    const query = cmd.nameQuery.toLowerCase();
    const scope = cmd.packScope ?? "dnd5e";
    const results: CompendiumEntry[] = [];
    for (const [uuid, record] of this.compendium) {
      if (record.documentType !== cmd.documentType) continue;
      if (!record.pack.startsWith(`${scope}.`)) continue;
      const name = String(record.data.name ?? "");
      if (name.toLowerCase().includes(query)) {
        const system = record.data.system as Record<string, any> | undefined;
        const cr = system?.details?.cr;
        results.push({
          uuid,
          pack: record.pack,
          name,
          type: String(record.data.type ?? record.documentType),
          cr: typeof cr === "number" ? cr : undefined,
        });
      }
    }
    return ok(id, results);
  }

  private importFromCompendium(
    id: string,
    cmd: Extract<Command, { action: "importFromCompendium" }>,
    dryRun: boolean,
  ): CommandResult {
    const record = this.compendium.get(cmd.uuid);
    if (!record) {
      return err(id, "NOT_FOUND", `compendium entry ${cmd.uuid} not found`);
    }
    // Deep-clone (not a shallow spread) so mutating the imported world
    // document's embedded collections can never reach back into the
    // compendium record's own data.
    const data = cmd.patch ? applyUpdate(record.data, cmd.patch) : structuredClone(record.data);
    if (cmd.folderId) {
      data.folder = cmd.folderId;
    }
    const _id = randomID();
    const doc = { ...data, _id };
    if (dryRun) return ok(id, { ...doc, _id: null, _dryRun: true });
    this.store.set(documentKey(cmd.documentType, _id), doc);
    return ok(id, doc);
  }

  private importEmbeddedFromCompendium(
    id: string,
    cmd: Extract<Command, { action: "importEmbeddedFromCompendium" }>,
    dryRun: boolean,
  ): CommandResult {
    const resolved = this.resolveEmbedded(id, cmd);
    if ("error" in resolved) return resolved.error;
    const created: Json[] = [];
    for (const entry of cmd.uuids) {
      const record = this.compendium.get(entry.uuid);
      if (!record) return err(id, "NOT_FOUND", `compendium entry ${entry.uuid} not found`);
      // Deep-clone for the same reason importFromCompendium does: mutating the
      // embedded copy must never reach back into the shared compendium record.
      const data = entry.patch ? applyUpdate(record.data, entry.patch) : structuredClone(record.data);
      // Real Foundry stamps _stats.compendiumSource from the source UUID on
      // createEmbeddedDocuments; the mock replicates it so verify-npc.ts's
      // "is the official item" check is exercisable against the mock too.
      data._stats = { ...(data._stats as Record<string, unknown> | undefined), compendiumSource: entry.uuid };
      created.push({ ...data, _id: randomID() });
    }
    if (dryRun) return ok(id, created.map((c) => ({ ...c, _dryRun: true })));
    resolved.arr.push(...created);
    return ok(id, created);
  }

  private getCompendiumDocument(
    id: string,
    cmd: Extract<Command, { action: "getCompendiumDocument" }>,
  ): CommandResult {
    const record = this.compendium.get(cmd.uuid);
    if (!record) {
      return err(id, "NOT_FOUND", `compendium entry ${cmd.uuid} not found`);
    }
    const data = structuredClone(record.data) as Record<string, any>;
    const rawItems = Array.isArray(data.items) ? (data.items as Record<string, any>[]) : [];
    const items = rawItems.map((it) => ({
      // Real compendium actor items have stable ids; the SRD fixtures omit them,
      // so derive a deterministic per-item uuid from the item name. Two reads
      // (create, then refresh) must address the same item by the same uuid.
      uuid: `${cmd.uuid}.Item.${mockItemSlug(String(it.name ?? ""))}`,
      name: String(it.name ?? ""),
      type: String(it.type ?? "feat"),
      img: it.img as string | undefined,
      system: (it.system ?? {}) as Record<string, unknown>,
      effects: Array.isArray(it.effects) ? (it.effects as Record<string, unknown>[]) : [],
    }));
    return ok(id, {
      name: String(data.name ?? ""),
      img: data.img,
      system: (data.system ?? {}) as Record<string, unknown>,
      items,
    });
  }
}
