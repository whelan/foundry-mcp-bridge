/**
 * Loader for dnd5e SRD fixtures used in testing. The fixtures are sourced from
 * the official D&D 5e SRD under CC-BY-4.0 (see README.md).
 *
 * The SRD is vendored here to ensure tests are deterministic and do not depend
 * on external downloads or API availability.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type EntityType = "Actor" | "Item" | "JournalEntry" | "Scene" | "Quest";

export interface SrdFixture {
  id: string;
  name: string;
  type: EntityType;
  version?: string;
  source?: string;
  data: Record<string, unknown>;
}

/**
 * The dnd5e compendium pack (short slug, e.g. "actors24") each entity type's
 * fixtures are sourced from / addressed under. Single source of truth for both
 * the on-disk fixture directory and the `Compendium.dnd5e.<pack>.<id>` uuid
 * consumers (e.g. the mock) construct.
 */
export const PACK_NAME_BY_TYPE: Record<EntityType, string> = {
  Actor: "actors24",
  Item: "monsterfeatures24",
  JournalEntry: "journals",
  Scene: "scenes",
  Quest: "quests",
};

let cached: Map<EntityType, Map<string, SrdFixture>> | undefined;

/**
 * Load all SRD fixtures from the fixture directory. Returns a map keyed by
 * entity type, with each entry a map of {id -> fixture}. The fixture set is
 * static for the process lifetime (tests construct many MockFoundry
 * instances), so the disk read + JSON parse is memoized after the first call.
 *
 * A single malformed fixture file is skipped (with a warning) rather than
 * failing the whole load — MockFoundry's constructor calls this, so an
 * uncaught parse error here would otherwise crash every test in the suite,
 * not just the ones exercising the one bad fixture.
 */
export function loadSrdFixtures(): Map<EntityType, Map<string, SrdFixture>> {
  if (cached) return cached;

  const result = new Map<EntityType, Map<string, SrdFixture>>();
  const types: EntityType[] = ["Actor", "Item"];

  for (const type of types) {
    const dir = getFixtureDirForType(type);
    const fixturesByType = new Map<string, SrdFixture>();

    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const fixture = JSON.parse(raw) as SrdFixture;
          fixturesByType.set(fixture.id, fixture);
        } catch (e) {
          console.warn(`[dnd5e-srd fixtures] skipping unreadable fixture ${filePath}: ${(e as Error).message}`);
        }
      }
    }

    result.set(type, fixturesByType);
  }

  cached = result;
  return result;
}

/**
 * Load a single fixture by type and id. Throws if not found.
 */
export function loadFixture(type: EntityType, id: string): SrdFixture {
  const fixtures = loadSrdFixtures();
  const byType = fixtures.get(type);
  if (!byType) {
    throw new Error(`No fixtures found for type ${type}`);
  }
  const fixture = byType.get(id);
  if (!fixture) {
    throw new Error(`Fixture not found: ${type}/${id}`);
  }
  return fixture;
}

/**
 * Get the fixture directory for a given entity type.
 */
function getFixtureDirForType(type: EntityType): string {
  return path.join(__dirname, PACK_NAME_BY_TYPE[type] ?? PACK_NAME_BY_TYPE.Actor);
}

/**
 * List all available fixture ids for a given type.
 */
export function listFixtures(type: EntityType): string[] {
  const fixtures = loadSrdFixtures();
  const byType = fixtures.get(type);
  return byType ? Array.from(byType.keys()) : [];
}
