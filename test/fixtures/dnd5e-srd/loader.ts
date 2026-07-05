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
 * Load all SRD fixtures from the fixture directory. Returns a map keyed by
 * entity type, with each entry a map of {id -> fixture}.
 */
export function loadSrdFixtures(): Map<
  EntityType,
  Map<string, SrdFixture>
> {
  const result = new Map<EntityType, Map<string, SrdFixture>>();
  const types: EntityType[] = ["Actor", "Item"];

  for (const type of types) {
    const dir = getFixtureDirForType(type);
    const fixturesByType = new Map<string, SrdFixture>();

    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = path.join(dir, file);
        const raw = fs.readFileSync(filePath, "utf-8");
        const fixture = JSON.parse(raw) as SrdFixture;
        fixturesByType.set(fixture.id, fixture);
      }
    }

    result.set(type, fixturesByType);
  }

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
  const dirMap: Record<EntityType, string> = {
    Actor: path.join(__dirname, "actors24"),
    Item: path.join(__dirname, "monsterfeatures24"),
    JournalEntry: path.join(__dirname, "journals"),
    Scene: path.join(__dirname, "scenes"),
    Quest: path.join(__dirname, "quests"),
  };
  return dirMap[type] || path.join(__dirname, "actors24");
}

/**
 * List all available fixture ids for a given type.
 */
export function listFixtures(type: EntityType): string[] {
  const fixtures = loadSrdFixtures();
  const byType = fixtures.get(type);
  return byType ? Array.from(byType.keys()) : [];
}
