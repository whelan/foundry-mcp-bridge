/**
 * Tool definitions. Framework-agnostic: each tool exposes a zod input shape and
 * a `run` that drives the reliability pipeline against a {@link RelayTransport}.
 * server.ts registers these with the MCP SDK; tests call `run` directly against
 * the mock-foundry-backed transport.
 *
 * Order matches live-api-plan §7: create_document first, then create_scene
 * (reusing the shared scene builders) and update_document.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, basename } from "node:path";
import { z } from "zod";
import {
  DocumentType,
  buildScene,
  buildSceneVerify,
  getByPath,
  expandObject,
  isSafePath,
  filterUnsafePaths,
  WHISPER_MAX_RECIPIENTS,
  WHISPER_MAX_CONTENT,
  WHISPER_MAX_FLAVOR,
  type CompendiumEntry,
  type CompendiumDocument,
} from "@foundry-mcp-bridge/shared";
import type { RelayTransport } from "./relay-transport.js";
import {
  createDocumentReliable,
  updateDocumentReliable,
  deleteDocumentReliable,
  duplicateDocumentReliable,
  createEmbeddedReliable,
  updateEmbeddedReliable,
  deleteEmbeddedReliable,
  createQuestReliable,
  updateQuestReliable,
  deleteQuestReliable,
  uploadAssetReliable,
  browseAssetsReliable,
  batchUploadAssetsReliable,
  searchCompendiumReliable,
  getCompendiumDocumentReliable,
  getChatLogReliable,
  showImageReliable,
  runMacroReliable,
  whisperPlayerReliable,
  importFromCompendiumReliable,
  importEmbeddedFromCompendiumReliable,
  runRead,
  type PipelineOptions,
  type ToolOutcome,
} from "./reliability.js";

const documentData = z.record(z.string(), z.unknown());

/**
 * Optional dot-path projection for a tool's result. Pass e.g. ["_id"] or
 * ["_id","_stats.modifiedTime"] to return only those paths. On reads (find), omit
 * for the full document. On mutations the echo is slim by default (see below);
 * `fields` overrides which paths the slim echo carries.
 */
const fieldsParam = z.array(z.string().min(1)).min(1).optional();

/** On a mutation, return the whole written document instead of the slim echo. */
const fullParam = z.boolean().optional();

/**
 * Default slim echo for mutating tools: a created/updated document is echoed back,
 * but the caller already has the data it sent and only needs the id (and, for the
 * sync, the new modifiedTime). Returning the whole document — a Scene with
 * walls/lights/tokens, an Actor's full system block — is the dominant token cost of
 * a bulk import, so mutations default to these keys. Pass full:true for everything,
 * or fields:[...] for a specific set. (Missing keys are simply dropped.)
 */
const DEFAULT_ECHO_FIELDS = ["_id", "name", "_stats.modifiedTime"];

// --- create_document --------------------------------------------------------

export const CreateDocumentShape = {
  documentType: DocumentType,
  data: documentData,
  keepId: z.boolean().optional(),
  fields: fieldsParam,
  full: fullParam,
};
const CreateDocument = z.object(CreateDocumentShape);
export type CreateDocumentArgs = z.infer<typeof CreateDocument>;

export async function runCreateDocument(
  transport: RelayTransport,
  args: CreateDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return projectEcho(await createDocumentReliable(transport, args, opts), args.fields, args.full);
}

// --- create_scene -----------------------------------------------------------

export const CreateSceneShape = {
  name: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  gridSize: z.number().int().positive().optional(),
  gridType: z.number().int().min(0).max(5).optional(),
  gridDistance: z.number().positive().optional(),
  gridUnits: z.string().optional(),
  background: z.string().optional(),
  backgroundColor: z.string().optional(),
  padding: z.number().min(0).optional(),
  fields: fieldsParam,
  full: fullParam,
};
const CreateScene = z.object(CreateSceneShape);
export type CreateSceneArgs = z.infer<typeof CreateScene>;

export async function runCreateScene(
  transport: RelayTransport,
  args: CreateSceneArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const data = buildScene(args);
  const verifyData = buildSceneVerify(args);
  const outcome = await createDocumentReliable(
    transport,
    { documentType: "Scene", data, verifyData },
    opts,
  );
  return projectEcho(outcome, args.fields, args.full);
}

// --- update_document --------------------------------------------------------

export const UpdateDocumentShape = {
  documentType: DocumentType,
  id: z.string().min(1),
  data: documentData,
  fields: fieldsParam,
  full: fullParam,
};
const UpdateDocument = z.object(UpdateDocumentShape);
export type UpdateDocumentArgs = z.infer<typeof UpdateDocument>;

export async function runUpdateDocument(
  transport: RelayTransport,
  args: UpdateDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Drop unsafe dot-path keys from the outgoing diff so the live runtime never
  // receives a prototype-pollution path (and stays consistent with the mock,
  // whose applyUpdate already drops them via expandObject). updateDocumentReliable
  // rejects an empty-after-filtering diff itself (VALIDATION), so it doesn't
  // need re-checking here.
  const data = filterUnsafePaths(args.data);
  return projectEcho(
    await updateDocumentReliable(transport, { ...args, data }, opts),
    args.fields,
    args.full,
  );
}

// --- delete_document --------------------------------------------------------

export const DeleteDocumentShape = {
  documentType: DocumentType,
  id: z.string().min(1),
};
const DeleteDocument = z.object(DeleteDocumentShape);
export type DeleteDocumentArgs = z.infer<typeof DeleteDocument>;

export function runDeleteDocument(
  transport: RelayTransport,
  args: DeleteDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return deleteDocumentReliable(transport, args, opts);
}

// --- duplicate_document -----------------------------------------------------

export const DuplicateDocumentShape = {
  documentType: DocumentType,
  id: z.string().min(1),
  overrides: documentData.optional(),
  fields: fieldsParam,
  full: fullParam,
};
const DuplicateDocument = z.object(DuplicateDocumentShape);
export type DuplicateDocumentArgs = z.infer<typeof DuplicateDocument>;

export async function runDuplicateDocument(
  transport: RelayTransport,
  args: DuplicateDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // overrides are Foundry dot-notation; drop unsafe keys before they reach the runtime.
  const safe = { ...args, overrides: args.overrides ? filterUnsafePaths(args.overrides) : args.overrides };
  return projectEcho(await duplicateDocumentReliable(transport, safe, opts), args.fields, args.full);
}

// --- find_documents ---------------------------------------------------------

export const FindDocumentsShape = {
  documentType: DocumentType,
  id: z.string().min(1).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  /**
   * Project each result to only these dot-notation paths (e.g.
   * ["_id", "_stats.modifiedTime"]). Strongly recommended for bulk reads — a full
   * document (scene walls/lights/tokens, actor system data) is large; most callers
   * only need a few fields. Omit to return whole documents.
   */
  fields: z.array(z.string().min(1)).min(1).optional(),
};
const FindDocuments = z.object(FindDocumentsShape);
export type FindDocumentsArgs = z.infer<typeof FindDocuments>;

export async function runFindDocuments(
  transport: RelayTransport,
  args: FindDocumentsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const outcome = await runRead(
    transport,
    { action: "find", documentType: args.documentType, id: args.id, query: args.query },
    "find",
    opts,
  );
  return project(outcome, args.fields);
}

/**
 * Read projection (find): opt-in. Returns the full result unless `fields` is given.
 * Trimming happens server-side so only the requested paths reach the model's
 * context — the relay already returned the full doc(s) (the wire/Node hop isn't
 * token-billed, the tool result is).
 */
function project(outcome: ToolOutcome, fields?: string[]): ToolOutcome {
  if (!outcome.ok || !fields) return outcome;
  return { ...outcome, data: projectResult(outcome.data, fields) };
}

/**
 * Mutation echo projection: slim by DEFAULT (DEFAULT_ECHO_FIELDS). `full:true`
 * returns the whole written document; `fields` overrides the slim key set. The
 * read-back verification is unaffected — it uses the server-side re-read, not this
 * echo — so correctness/rollback are intact regardless of what's echoed.
 */
function projectEcho(outcome: ToolOutcome, fields?: string[], full?: boolean): ToolOutcome {
  if (!outcome.ok || full) return outcome;
  return { ...outcome, data: projectResult(outcome.data, fields ?? DEFAULT_ECHO_FIELDS) };
}

/** Apply a dot-path projection to a result (single doc or array of docs). */
function projectResult(data: unknown, fields: string[]): unknown {
  if (Array.isArray(data)) return data.map((d) => projectDoc(d, fields));
  return projectDoc(data, fields);
}

function projectDoc(doc: unknown, fields: string[]): unknown {
  if (doc === null || typeof doc !== "object") return doc;
  const flat: Record<string, unknown> = {};
  for (const path of fields) {
    // Skip prototype-chain paths up-front (consistent with expandObject's guard)
    // so a "__proto__"-style field never even reads an inherited property.
    if (!isSafePath(path)) continue;
    const value = getByPath(doc, path);
    if (value !== undefined) flat[path] = value;
  }
  return expandObject(flat);
}

// --- get_world_info ---------------------------------------------------------

export const GetWorldInfoShape = {};
const GetWorldInfo = z.object(GetWorldInfoShape);
export type GetWorldInfoArgs = z.infer<typeof GetWorldInfo>;

export function runGetWorldInfo(
  transport: RelayTransport,
  _args: GetWorldInfoArgs = {},
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runRead(transport, { action: "getWorldInfo" }, "get-world-info", opts);
}

// --- get_chat_log -----------------------------------------------------------

export const GetChatLogShape = {
  /** Inclusive lower bound, ISO 8601 (e.g. "2026-09-24T17:00:00Z"). */
  start: z.string().min(1).optional(),
  /** Exclusive upper bound, ISO 8601. */
  end: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(5000).default(2000),
};
const GetChatLog = z.object(GetChatLogShape);
export type GetChatLogArgs = z.infer<typeof GetChatLog>;

export function runGetChatLog(
  transport: RelayTransport,
  args: GetChatLogArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return getChatLogReliable(transport, args.start, args.end, args.limit, opts);
}

// --- show_image --------------------------------------------------------------

export const ShowImageShape = {
  /** Stored image path or URL (e.g. what upload_asset returned). */
  src: z.string().min(1),
  /** Popout title the players see. */
  title: z.string().optional(),
  /** Optional UUID of the owning document, e.g. a JournalEntryPage. */
  uuid: z.string().min(1).optional(),
};
const ShowImage = z.object(ShowImageShape);
export type ShowImageArgs = z.infer<typeof ShowImage>;

export function runShowImage(
  transport: RelayTransport,
  args: ShowImageArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return showImageReliable(transport, args, opts);
}

// --- run_macro ---------------------------------------------------------------

export const RunMacroShape = {
  /** Macro id. Pass exactly one of id or name. */
  id: z.string().min(1).optional(),
  /** Exact macro name (must be unique in the world). */
  name: z.string().min(1).optional(),
  /** Passed to the macro as its `scope` object, e.g. { mode: "test" }. */
  args: z.record(z.unknown()).optional(),
  /** How long to wait for the macro to finish, in milliseconds (default 120000, max 600000). */
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
};
const RunMacro = z.object(RunMacroShape);
export type RunMacroArgs = z.infer<typeof RunMacro>;

export function runRunMacro(
  transport: RelayTransport,
  args: RunMacroArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  if (Boolean(args.id) === Boolean(args.name)) {
    return Promise.resolve({
      ok: false,
      error: { code: "VALIDATION", message: "run_macro needs exactly one of id or name" },
      steps: [],
    });
  }
  return runMacroReliable(transport, args, { ...opts, timeoutMs: args.timeoutMs ?? opts.timeoutMs ?? 120000 });
}

// --- whisper_player ----------------------------------------------------------

export const WhisperPlayerShape = {
  /** Players to whisper to, by user name, character name or unique first name. Never "all". */
  to: z.array(z.string().min(1)).min(1).max(WHISPER_MAX_RECIPIENTS),
  /** The message. Blank lines are paragraph breaks; no markup is interpreted. */
  content: z.string().min(1).max(WHISPER_MAX_CONTENT),
  /** Optional line shown above the message, e.g. the cue that fired it. */
  flavor: z.string().min(1).max(WHISPER_MAX_FLAVOR).optional(),
};
const WhisperPlayer = z.object(WhisperPlayerShape);
export type WhisperPlayerArgs = z.infer<typeof WhisperPlayer>;

export function runWhisperPlayer(
  transport: RelayTransport,
  args: WhisperPlayerArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return whisperPlayerReliable(transport, args, opts);
}

// --- show_image_file ---------------------------------------------------------

const IMAGE_MIME: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};
/** Well above any table picture; stops a stray path from shipping a huge file. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export const ShowImageFileShape = {
  /** Absolute path to a local image (.webp/.png/.jpg/.jpeg/.gif) on the machine running the MCP server. */
  filePath: z.string().min(1),
  /** Page name and popout title — what the players see. */
  title: z.string().min(1),
  /** Journal the image is filed in; created (players: Observer) if missing. */
  journal: z.string().min(1).default("Shown to Players"),
  /** Upload directory. */
  target: z.string().min(1).default("shown-images"),
  source: z.enum(["data", "forgevtt"]).default("data"),
  /** false files the page hidden (ownership None) without showing it. */
  show: z.boolean().default(true),
};
const ShowImageFile = z.object(ShowImageFileShape);
export type ShowImageFileArgs = z.infer<typeof ShowImageFile>;

/** `20260924-193012-kistemagerens-vaerksted.webp` — unique, so a CDN never serves an older picture. */
export function showImageFilename(title: string, ext: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slug =
    title
      .replace(/[æÆ]/g, "ae").replace(/[øØ]/g, "oe").replace(/[åÅ]/g, "aa")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .slice(0, 40).replace(/-+$/g, "") || "image";
  return `${stamp}-${slug}${ext}`;
}

/**
 * The whole "show the players this picture" flow in one call, reading the file
 * server-side so no base64 passes through the model's context:
 * read → upload_asset → find/create journal → create image page → show_image.
 */
export async function runShowImageFile(
  transport: RelayTransport,
  input: ShowImageFileArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = [];
  const failWith = (code: "VALIDATION" | "INTERNAL", message: string, details?: unknown): ToolOutcome => ({
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
    steps,
  });

  steps.push("read-file");
  const ext = extname(input.filePath).toLowerCase();
  const mimeType = IMAGE_MIME[ext];
  if (!isAbsolute(input.filePath)) return failWith("VALIDATION", "filePath must be absolute");
  if (!mimeType) return failWith("VALIDATION", `Not an image file: ${basename(input.filePath)} (want ${Object.keys(IMAGE_MIME).join(", ")})`);
  let bytes: Buffer;
  try {
    const info = await stat(input.filePath);
    if (!info.isFile()) return failWith("VALIDATION", `Not a file: ${input.filePath}`);
    if (info.size > MAX_IMAGE_BYTES) return failWith("VALIDATION", `Image is ${info.size} bytes; the limit is ${MAX_IMAGE_BYTES}`);
    bytes = await readFile(input.filePath);
  } catch (e) {
    return failWith("VALIDATION", `Cannot read ${input.filePath}: ${(e as Error).message}`);
  }

  try {
    steps.push("upload");
    const { path: src } = unwrapDep<{ path: string }>(
      "uploadAsset",
      await runUploadAsset(transport, {
        source: input.source,
        target: input.target,
        filename: showImageFilename(input.title, ext),
        contentBase64: bytes.toString("base64"),
        mimeType,
      }, opts),
    );

    steps.push("journal");
    const found = unwrapDep<Array<{ _id: string }>>(
      "findJournal",
      await runFindDocuments(transport, { documentType: "JournalEntry", query: { name: input.journal }, fields: ["_id"] }, opts),
    );
    let journalId = found[0]?._id;
    if (!journalId) {
      const created = unwrapDep<{ _id: string }>(
        "createJournal",
        await runCreateDocument(transport, {
          documentType: "JournalEntry",
          data: { name: input.journal, ownership: { default: 2 } }, // players: Observer
        }, opts),
      );
      journalId = created._id;
    }

    steps.push("page");
    const [page] = unwrapDep<Array<{ _id: string }>>(
      "createPage",
      await runCreateEmbedded(transport, {
        parentType: "JournalEntry",
        parentId: journalId,
        embeddedName: "JournalEntryPage",
        data: [{
          name: input.title,
          type: "image",
          src,
          // Newest on top: a later page gets a lower sort.
          sort: -Math.floor(Date.now() / 1000),
          // Shown pages inherit the journal's Observer; a saved-for-later page stays hidden.
          ownership: { default: input.show ? -1 : 0 },
        }],
      }, opts),
    );
    if (!page?._id) return failWith("INTERNAL", "Journal page create returned no _id");
    const pageUuid = `JournalEntry.${journalId}.JournalEntryPage.${page._id}`;

    let shown = false;
    let via: unknown;
    if (input.show) {
      steps.push("show");
      const result = unwrapDep<{ shown: boolean; via?: string }>(
        "showImage",
        await runShowImage(transport, { src, title: input.title, uuid: pageUuid }, opts),
      );
      shown = result.shown;
      via = result.via;
    }
    return { ok: true, data: { src, journalId, pageId: page._id, pageUuid, shown, ...(via ? { via } : {}) }, steps };
  } catch (e) {
    return failWith("INTERNAL", (e as Error).message, (e as { details?: unknown }).details);
  }
}

// --- upload_asset -----------------------------------------------------------

export const UploadAssetShape = {
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1),
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  mimeType: z.string().optional(),
};
const UploadAsset = z.object(UploadAssetShape);
export type UploadAssetArgs = z.infer<typeof UploadAsset>;

export function runUploadAsset(
  transport: RelayTransport,
  args: UploadAssetArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return uploadAssetReliable(transport, args, opts);
}

// --- browse_assets ----------------------------------------------------------

export const BrowseAssetsShape = {
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1),
  extensions: z.array(z.string()).optional(),
};
const BrowseAssets = z.object(BrowseAssetsShape);
export type BrowseAssetsArgs = z.infer<typeof BrowseAssets>;

export function runBrowseAssets(
  transport: RelayTransport,
  args: BrowseAssetsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return browseAssetsReliable(transport, args, opts);
}

// --- batch_upload_assets ----------------------------------------------------

export const BatchUploadAssetsShape = {
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1),
  files: z.array(
    z.object({
      filename: z.string().min(1),
      contentBase64: z.string().min(1),
      mimeType: z.string().optional(),
    }),
  ).min(1).max(50),
  skipExisting: z.boolean().optional(),
};
const BatchUploadAssets = z.object(BatchUploadAssetsShape);
export type BatchUploadAssetsArgs = z.infer<typeof BatchUploadAssets>;

export function runBatchUploadAssets(
  transport: RelayTransport,
  args: BatchUploadAssetsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return batchUploadAssetsReliable(transport, args, opts);
}

// --- create_embedded --------------------------------------------------------

export const CreateEmbeddedShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  data: z.array(documentData).min(1),
  fields: fieldsParam,
  full: fullParam,
};
const CreateEmbedded = z.object(CreateEmbeddedShape);
export type CreateEmbeddedArgs = z.infer<typeof CreateEmbedded>;

export async function runCreateEmbedded(
  transport: RelayTransport,
  args: CreateEmbeddedArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return projectEcho(await createEmbeddedReliable(transport, args, opts), args.fields, args.full);
}

// --- update_embedded --------------------------------------------------------

export const UpdateEmbeddedShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  data: z.array(documentData.and(z.object({ _id: z.string().min(1) }))).min(1),
  fields: fieldsParam,
  full: fullParam,
};
const UpdateEmbedded = z.object(UpdateEmbeddedShape);
export type UpdateEmbeddedArgs = z.infer<typeof UpdateEmbedded>;

export async function runUpdateEmbedded(
  transport: RelayTransport,
  args: UpdateEmbeddedArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Each embedded diff is dot-notation too — strip unsafe keys (keeping the
  // required _id) before the entries reach the live runtime.
  // updateEmbeddedReliable rejects any entry left with only `_id` itself
  // (VALIDATION), so it doesn't need re-checking here.
  const data = args.data.map(
    (d) => filterUnsafePaths(d) as typeof d,
  );
  return projectEcho(await updateEmbeddedReliable(transport, { ...args, data }, opts), args.fields, args.full);
}

// --- delete_embedded --------------------------------------------------------

export const DeleteEmbeddedShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1),
};
const DeleteEmbedded = z.object(DeleteEmbeddedShape);
export type DeleteEmbeddedArgs = z.infer<typeof DeleteEmbedded>;

export function runDeleteEmbedded(
  transport: RelayTransport,
  args: DeleteEmbeddedArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return deleteEmbeddedReliable(transport, args, opts);
}

// --- create_quest -----------------------------------------------------------

export const CreateQuestShape = {
  data: z.record(z.string(), z.unknown()).optional(),
  parentId: z.string().min(1).optional(),
};
const CreateQuest = z.object(CreateQuestShape);
export type CreateQuestArgs = z.infer<typeof CreateQuest>;

export function runCreateQuest(
  transport: RelayTransport,
  args: CreateQuestArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return createQuestReliable(transport, args, opts);
}

// --- update_quest -----------------------------------------------------------

export const UpdateQuestShape = {
  id: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
};
const UpdateQuest = z.object(UpdateQuestShape);
export type UpdateQuestArgs = z.infer<typeof UpdateQuest>;

export function runUpdateQuest(
  transport: RelayTransport,
  args: UpdateQuestArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return updateQuestReliable(transport, args, opts);
}

// --- delete_quest -----------------------------------------------------------

export const DeleteQuestShape = {
  id: z.string().min(1),
};
const DeleteQuest = z.object(DeleteQuestShape);
export type DeleteQuestArgs = z.infer<typeof DeleteQuest>;

export function runDeleteQuest(
  transport: RelayTransport,
  args: DeleteQuestArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return deleteQuestReliable(transport, args, opts);
}

// --- search_compendium -------------------------------------------------------

export const SearchCompendiumShape = {
  packScope: z.string().optional(),
  documentType: DocumentType,
  nameQuery: z.string().min(1),
};
const SearchCompendium = z.object(SearchCompendiumShape);
export type SearchCompendiumArgs = z.infer<typeof SearchCompendium>;

export function runSearchCompendium(
  transport: RelayTransport,
  args: SearchCompendiumArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return searchCompendiumReliable(transport, args, opts);
}

// --- import_from_compendium --------------------------------------------------

export const ImportFromCompendiumShape = {
  documentType: DocumentType,
  uuid: z.string().min(1),
  patch: documentData.optional(),
  folderId: z.string().optional(),
  fields: fieldsParam,
  full: fullParam,
};
const ImportFromCompendium = z.object(ImportFromCompendiumShape);
export type ImportFromCompendiumArgs = z.infer<typeof ImportFromCompendium>;

export async function runImportFromCompendium(
  transport: RelayTransport,
  args: ImportFromCompendiumArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Drop unsafe dot-path keys from the outgoing patch, consistent with
  // update_document's data and duplicate_document's overrides.
  const safe = { ...args, patch: args.patch ? filterUnsafePaths(args.patch) : args.patch };
  return projectEcho(
    await importFromCompendiumReliable(transport, safe, opts),
    args.fields,
    args.full,
  );
}

// --- get_compendium_document ------------------------------------------------

export const GetCompendiumDocumentShape = {
  uuid: z.string().min(1),
};
const GetCompendiumDocument = z.object(GetCompendiumDocumentShape);
export type GetCompendiumDocumentArgs = z.infer<typeof GetCompendiumDocument>;

export function runGetCompendiumDocument(
  transport: RelayTransport,
  args: GetCompendiumDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return getCompendiumDocumentReliable(transport, args, opts);
}

// --- import_embedded_from_compendium ----------------------------------------

export const ImportEmbeddedFromCompendiumShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  uuids: z.array(z.object({ uuid: z.string().min(1), patch: documentData.optional() })).min(1),
  fields: fieldsParam,
  full: fullParam,
};
const ImportEmbeddedFromCompendium = z.object(ImportEmbeddedFromCompendiumShape);
export type ImportEmbeddedFromCompendiumArgs = z.infer<typeof ImportEmbeddedFromCompendium>;

export async function runImportEmbeddedFromCompendium(
  transport: RelayTransport,
  args: ImportEmbeddedFromCompendiumArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Drop unsafe dot-path keys from each entry's patch, consistent with
  // import_from_compendium's single patch.
  const uuids = args.uuids.map((u) => ({
    ...u,
    patch: u.patch ? filterUnsafePaths(u.patch) : u.patch,
  }));
  return projectEcho(
    await importEmbeddedFromCompendiumReliable(transport, { ...args, uuids }, opts),
    args.fields,
    args.full,
  );
}

// --- import_npc ---------------------------------------------------------

export const ImportNpcShape = {
  markdown: z.string().min(1),
  image: z.object({
    filename: z.string().min(1),
    contentBase64: z.string().min(1),
  }).optional(),
  assetSource: z.enum(["data", "forgevtt"]).default("data"),
  folder: z.string().optional(),
  mode: z.enum(["upsert", "create", "update"]).default("upsert").optional(),
};
const ImportNpc = z.object(ImportNpcShape);
export type ImportNpcArgs = z.infer<typeof ImportNpc>;

/**
 * Resolve or create an Actor folder by name.
 * Returns the folder ID, or undefined if no folder was requested.
 */
async function resolveFolder(
  transport: RelayTransport,
  folderName: string | undefined,
): Promise<string | undefined> {
  if (!folderName) return undefined;

  // Find existing Actor folder by name
  const existing = await runFindDocuments(transport, {
    documentType: "Folder",
    query: { name: folderName, type: "Actor" },
    fields: ["_id"],
  });

  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    const folders = existing.data as Array<{ _id: string }>;
    const firstFolder = folders[0];
    if (firstFolder) {
      return firstFolder._id;
    }
  }

  // Create new folder
  const created = await runCreateDocument(transport, {
    documentType: "Folder",
    data: { name: folderName, type: "Actor" },
  });

  if (!created.ok) {
    throw new Error(
      `Failed to create folder "${folderName}": ${created.error.code}`,
    );
  }

  const doc = created.data as { _id: string };
  return doc._id;
}

/**
 * Unwrap a ToolOutcome for importNpc's injected deps, or throw an Error
 * carrying the original code/message/details — so import-npc.ts's stage
 * tagging (which reads `err.details`) has something real to attach to.
 */
function unwrapDep<T>(opName: string, result: ToolOutcome): T {
  if (!result.ok) {
    throw Object.assign(new Error(`${opName}: ${result.error.code}: ${result.error.message}`), {
      details: result.error.details,
    });
  }
  return result.data as T;
}

/**
 * Import an NPC from a statblock markdown note.
 * Orchestrates: lint → parse → folder → importNpc() → verify.
 */
export async function runImportNpc(
  transport: RelayTransport,
  input: ImportNpcArgs,
): Promise<ToolOutcome> {
  const steps: string[] = [];

  try {
    // Step 1: Lint
    steps.push("lint");
    const { lintStatblockNote } = await import(
      "@foundry-mcp-bridge/statblock-sync"
    );
    const lintFindings = lintStatblockNote(input.markdown);
    const failures = lintFindings.filter(
      (f: { severity: string }) => f.severity === "FAIL",
    );
    if (failures.length > 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Statblock lint found 2014-style or malformed actions",
          details: { findings: failures },
        },
        steps,
      };
    }

    // Step 2: Parse
    steps.push("parse");
    const {
      parseStatblock,
      importNpc,
      verifyImportedNpc,
    } = await import("@foundry-mcp-bridge/statblock-sync");

    let statblock;
    try {
      statblock = parseStatblock(input.markdown);
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Failed to parse statblock",
          details: { cause: (e as any).message },
        },
        steps,
      };
    }

    // Step 3: Resolve folder (if requested)
    steps.push("resolve-folder");
    let folderId: string | undefined;
    try {
      folderId = await resolveFolder(transport, input.folder);
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Folder resolution failed: ${(e as any).message}`,
        },
        steps,
      };
    }

    // Step 4: Prepare deps
    const deps = {
      async searchCompendium(nameQuery: string): Promise<CompendiumEntry[]> {
        const result = await runSearchCompendium(transport, {
          documentType: "Actor",
          nameQuery,
        });
        return unwrapDep("searchCompendium", result);
      },

      async getCompendiumDocument(uuid: string): Promise<CompendiumDocument> {
        const result = await runGetCompendiumDocument(transport, { uuid });
        return unwrapDep("getCompendiumDocument", result);
      },

      async createDocument(data: Record<string, unknown>): Promise<{ _id: string }> {
        const result = await runCreateDocument(transport, {
          documentType: "Actor",
          data: data as Record<string, unknown>,
        });
        return unwrapDep("createDocument", result);
      },

      async uploadImage(
        filename: string,
        contentBase64: string,
        targetFolder?: string,
      ): Promise<string> {
        const result = await runUploadAsset(transport, {
          source: input.assetSource,
          target: targetFolder ?? "worlds/npcs",
          filename,
          contentBase64,
        });
        return unwrapDep<{ path: string }>("uploadAsset", result).path;
      },

      async searchSpellCompendium(nameQuery: string): Promise<CompendiumEntry[]> {
        const result = await runSearchCompendium(transport, {
          documentType: "Item",
          nameQuery,
        });
        return unwrapDep("searchSpellCompendium", result);
      },

      async importEmbeddedFromCompendium(
        parentId: string,
        uuid: string,
        patch?: Record<string, unknown>,
      ): Promise<{ _id: string }> {
        const result = await runImportEmbeddedFromCompendium(transport, {
          parentType: "Actor",
          parentId,
          embeddedName: "Item",
          uuids: [{ uuid, ...(patch && { patch }) }],
        });
        return unwrapDep<Array<{ _id: string }>>("importEmbeddedFromCompendium", result)[0]!;
      },

      async createEmbeddedItem(
        parentId: string,
        data: Record<string, unknown>,
      ): Promise<{ _id: string }> {
        const result = await runCreateEmbedded(transport, {
          parentType: "Actor",
          parentId,
          embeddedName: "Item",
          data: [data],
        });
        return unwrapDep<Array<{ _id: string }>>("createEmbeddedItem", result)[0]!;
      },

      async findActorsByKey(key: string): Promise<Array<{ _id: string; flags?: Record<string, any> }>> {
        // Dot-notation path, not a nested object literal: the wire contract's
        // `find` query is documented (and implemented by foundry-runtime.ts) as
        // shallow equality over dot-notation paths, not deep object matching —
        // a nested literal would compare by reference and never match live.
        const result = await runFindDocuments(transport, {
          documentType: "Actor",
          query: { "flags.foundry-mcp-bridge.statblockKey": key },
          fields: ["_id", "flags"],
        });
        return unwrapDep("findActorsByKey", result);
      },

      async updateDocument(actorId: string, patch: Record<string, unknown>): Promise<{ _id: string }> {
        const result = await runUpdateDocument(transport, {
          documentType: "Actor",
          id: actorId,
          data: patch,
        });
        return unwrapDep("updateDocument", result);
      },

      async findActorItems(
        actorId: string,
      ): Promise<Array<{ _id: string; name: string; type: string; img?: string; system?: any; flags?: Record<string, any>; _stats?: Record<string, any> }>> {
        // Embedded items aren't addressable as top-level Item documents (Item's
        // collection is Foundry's world-level items sidebar) — they live on the
        // actor's own `items` array, so fetch the actor and read it off there.
        const result = await runFindDocuments(transport, {
          documentType: "Actor",
          id: actorId,
        });
        const actor = unwrapDep<{ items?: Array<{ _id: string; name: string; type: string; img?: string; system?: any; flags?: Record<string, any>; _stats?: Record<string, any> }> }>(
          "findActorItems",
          result,
        );
        return actor.items ?? [];
      },

      async updateEmbeddedItem(
        actorId: string,
        itemId: string,
        patch: Record<string, unknown>,
      ): Promise<{ _id: string }> {
        const result = await runUpdateEmbedded(transport, {
          parentType: "Actor",
          parentId: actorId,
          embeddedName: "Item",
          data: [{ _id: itemId, ...patch }],
        });
        return unwrapDep<Array<{ _id: string }>>("updateEmbeddedItem", result)[0]!;
      },

      async deleteEmbeddedItem(actorId: string, itemId: string): Promise<{ _id: string }> {
        const result = await runDeleteEmbedded(transport, {
          parentType: "Actor",
          parentId: actorId,
          embeddedName: "Item",
          ids: [itemId],
        });
        return unwrapDep<Array<{ _id: string }>>("deleteEmbeddedItem", result)[0]!;
      },
    } as any;

    // Step 5: Import (wrap in stage tracking)
    steps.push("import");
    let importResult;
    try {
      importResult = await importNpc(
        statblock,
        deps,
        input.image,
        folderId,
        input.mode,
      );
    } catch (e) {
      const err = e as any;
      const message = err.message || "Unknown error during import";
      const cause = err.cause ? `${err.cause}` : undefined;

      // Extract structured error info from library throws
      const code = err.code || "INTERNAL";
      const stage = err.stage || "actor-create";
      const errorActorId = err.actorId;

      // If actor was created, include its ID in error details
      if (errorActorId) {
        return {
          ok: false,
          error: {
            code,
            message,
            details: { actorId: errorActorId, stage, cause, causeDetails: err.details },
          },
          steps,
        };
      } else {
        return {
          ok: false,
          error: {
            code,
            message,
            details: { stage, cause, causeDetails: err.details },
          },
          steps,
        };
      }
    }

    // Step 6: Read back and verify
    steps.push("read-back");
    const readBackResult = await runFindDocuments(transport, {
      documentType: "Actor",
      id: importResult.actorId,
      fields: ["_id", "name", "type", "system", "items", "folder"],
    });

    if (!readBackResult.ok) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Read-back failed after import",
          details: { actorId: importResult.actorId, cause: readBackResult.error.code },
        },
        steps,
      };
    }

    const readBack = readBackResult.data as any;
    const verification = verifyImportedNpc(readBack, statblock);

    return {
      ok: true,
      data: {
        actorId: importResult.actorId,
        tier: importResult.tier,
        action: importResult.action,
        matchedUuid: importResult.matchedUuid,
        itemChanges: importResult.itemChanges,
        verification: {
          ok: verification.ok,
          checks: verification.checks,
        },
      },
      steps,
    };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Unexpected error: ${(e as any).message}`,
      },
      steps,
    };
  }
}
