import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "./scan.js";
import { DEFAULT_TYPE_MAP } from "./notes.js";

describe("scanRepo", () => {
  it("returns a RepoEntity per classified note", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-"));
    mkdirSync(join(dir, "generated/npcs"), { recursive: true });
    writeFileSync(join(dir, "generated/npcs/a.md"), "---\nname: A\n---\nbody\n");
    const entities = scanRepo(dir, DEFAULT_TYPE_MAP);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.source).toBe("generated/npcs/a.md");
    expect(entities[0]?.documentType).toBe("Actor");
    expect(entities[0]?.contentHash).toMatch(/^sha256:/);
  });
});
