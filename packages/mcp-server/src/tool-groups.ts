/**
 * Tool profiles. Every registered tool belongs to exactly one group; the
 * FOUNDRY_TOOLS config (comma list of groups, or `all`) picks which groups
 * buildServer registers, so a session only pays context for the tools it uses.
 */

export const TOOL_GROUPS = {
  core: "Generic document CRUD + reads, embedded docs, world info, change log/undo",
  compendium: "Search compendiums and import entries (documents or embedded)",
  statblocks: "Import a Fantasy Statblocks note as an NPC actor",
  scenes: "Scene play: create/list/inspect/switch scenes, tokens, conditions, walls, lights",
  floorplan: "build_floorplan_scene (large schema; implies images for job polling)",
  images: "Codex image generation and its job polling",
  assets: "Upload/browse files in Foundry storage via the running world",
  forge: "Direct Forge REST asset bucket tools (no running world)",
  table: "Player-facing: chat log, whispers, macros, image popouts",
  quests: "Forien's Quest Log quests",
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;
export const ALL_TOOL_GROUPS = Object.keys(TOOL_GROUPS) as ToolGroup[];

/** Tool name -> group. The single source of which group a tool is in. */
export const TOOL_CATALOG = {
  create_document: "core",
  update_document: "core",
  delete_document: "core",
  duplicate_document: "core",
  find_documents: "core",
  get_world_info: "core",
  create_embedded: "core",
  update_embedded: "core",
  delete_embedded: "core",
  list_changes: "core",
  undo_change: "core",
  search_compendium: "compendium",
  import_from_compendium: "compendium",
  import_embedded_from_compendium: "compendium",
  import_npc: "statblocks",
  create_scene: "scenes",
  list_scenes: "scenes",
  get_scene_state: "scenes",
  switch_scene: "scenes",
  place_token: "scenes",
  move_tokens: "scenes",
  remove_tokens: "scenes",
  toggle_condition: "scenes",
  add_walls: "scenes",
  add_lights: "scenes",
  build_floorplan_scene: "floorplan",
  generate_image: "images",
  check_image_job: "images",
  cancel_image_job: "images",
  upload_asset: "assets",
  browse_assets: "assets",
  batch_upload_assets: "assets",
  forge_browse_assets: "forge",
  forge_upload_asset: "forge",
  forge_batch_upload_assets: "forge",
  forge_create_folder: "forge",
  get_chat_log: "table",
  whisper_player: "table",
  run_macro: "table",
  show_image: "table",
  show_image_file: "table",
  create_quest: "quests",
  update_quest: "quests",
  delete_quest: "quests",
} as const satisfies Record<string, ToolGroup>;

export type ToolName = keyof typeof TOOL_CATALOG;

/** Groups another group needs to be usable (floorplan jobs are polled with check_image_job). */
const IMPLIES: Partial<Record<ToolGroup, ToolGroup[]>> = { floorplan: ["images"] };

/**
 * Parse a FOUNDRY_TOOLS value. Undefined/empty/`all` -> every group. Unknown
 * names throw, naming the valid groups.
 */
export function parseToolGroups(spec: string | undefined): ReadonlySet<ToolGroup> {
  const names = (spec ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0 || names.includes("all")) return new Set(ALL_TOOL_GROUPS);
  const unknown = names.filter((n) => !(n in TOOL_GROUPS));
  if (unknown.length) {
    throw new Error(
      `FOUNDRY_TOOLS: unknown tool group(s) ${unknown.map((u) => `"${u}"`).join(", ")}. ` +
        `Valid groups: ${ALL_TOOL_GROUPS.join(", ")} (or "all").`,
    );
  }
  const out = new Set(names as ToolGroup[]);
  for (const g of [...out]) for (const dep of IMPLIES[g] ?? []) out.add(dep);
  return out;
}
