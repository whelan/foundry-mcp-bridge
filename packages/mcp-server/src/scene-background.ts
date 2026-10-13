/**
 * Foundry 14 keeps a scene's background on its level(s). A `background` passed to Scene.create is not
 * migrated there, so a freshly created scene shows no picture. After creating a scene, call this: when the
 * scene has a level it sets that level's background, and on Foundry 13 (no levels) it does nothing.
 */

import type { PipelineOptions, ToolOutcome } from "./reliability.js";
import type { RelayTransport } from "./relay-transport.js";
import { runFindDocuments, runUpdateEmbedded } from "./tools.js";

export async function ensureSceneBackground(
  transport: RelayTransport,
  sceneId: string,
  src: string,
  opts: PipelineOptions,
): Promise<ToolOutcome | null> {
  const scene = await runFindDocuments(transport, { documentType: "Scene", id: sceneId, fields: ["_id", "levels"] }, opts);
  if (!scene.ok) return scene;
  const levels = (scene.data as { levels?: Array<{ _id: string; background?: { src?: string | null } }> }).levels ?? [];
  const level = levels.find((l) => l._id);
  if (!level || level.background?.src === src) return null;
  return runUpdateEmbedded(
    transport,
    { parentType: "Scene", parentId: sceneId, embeddedName: "Level", data: [{ _id: level._id, "background.src": src }] },
    opts,
  );
}
