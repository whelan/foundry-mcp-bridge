import { describe, it, expect } from "vitest";
import { buildVault, htmlToMarkdown, slugify, type WorldDump } from "./world-export.js";
import { parseNote, DEFAULT_TYPE_MAP } from "./notes.js";

const FIXED_NOW = () => "2026-06-21T00:00:00.000Z";

function emptyDump(): WorldDump {
  return { world: { id: "w1", system: "dnd5e" }, journals: [], actors: [], scenes: [] };
}

describe("world-export buildVault", () => {
  it("exports an actor to generated/npcs with stat front-matter + bio body", () => {
    const dump = emptyDump();
    dump.actors = [
      {
        _id: "A1",
        name: "Strahd von Zarovich",
        type: "npc",
        img: "tokens/strahd.webp",
        system: {
          details: { cr: 15, biography: { value: "<p>Lord of <strong>Barovia</strong>.</p>" } },
          attributes: { hp: { value: 144, max: 144 } },
        },
        _stats: { modifiedTime: 1700 },
      },
    ];
    const { files, manifest } = buildVault(dump, FIXED_NOW);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe("generated/npcs/strahd-von-zarovich.md");
    expect(f.content).toContain("cr: 15");
    expect(f.content).toContain("hp: 144");
    expect(f.content).toContain("Lord of **Barovia**.");

    // Manifest entity round-trips: re-parsing the file yields the recorded hash.
    const entity = manifest.entities[f.path]!;
    expect(entity.documentType).toBe("Actor");
    expect(entity.foundryId).toBe("A1");
    expect(entity.remoteModifiedTime).toBe(1700);
    expect(parseNote(f.path, f.content, DEFAULT_TYPE_MAP).contentHash).toBe(entity.contentHash);
  });

  it("exports a journal's pages into one markdown body", () => {
    const dump = emptyDump();
    dump.journals = [
      {
        _id: "J1",
        name: "Death House",
        pages: [
          { name: "Intro", type: "text", text: { content: "<p>A creepy house.</p>" } },
          { name: "Basement", type: "text", text: { content: "<p>The ritual chamber.</p>" } },
        ],
      },
    ];
    const { files, manifest } = buildVault(dump, FIXED_NOW);
    expect(files[0]!.path).toBe("generated/journals/death-house.md");
    expect(files[0]!.content).toContain("## Intro");
    expect(files[0]!.content).toContain("## Basement");
    expect(manifest.entities[files[0]!.path]!.documentType).toBe("JournalEntry");
  });

  it("routes a Forien's Quest Log journal to generated/quests with progress front-matter", () => {
    const dump = emptyDump();
    dump.journals = [
      {
        _id: "Q1",
        name: "Escape Barovia",
        flags: {
          "forien-quest-log": {
            json: {
              status: "active",
              description: "<p>Find a way out.</p>",
              giver: "G1",
              tasks: [
                { name: "Find the gate", completed: true },
                { name: "Cross the mists", completed: false },
              ],
            },
          },
        },
      },
    ];
    const { files, manifest } = buildVault(dump, FIXED_NOW);
    const f = files[0]!;
    expect(f.path).toBe("generated/quests/escape-barovia.md");
    expect(f.content).toContain("status: active");
    expect(f.content).toContain("Find the gate");
    expect(f.content).toContain("Find a way out.");
    const entity = manifest.entities[f.path]!;
    expect(entity.documentType).toBe("Quest");
    expect(entity.progressHash).toBeDefined();
  });

  it("exports a scene with dimensions + background", () => {
    const dump = emptyDump();
    dump.scenes = [
      {
        _id: "S1",
        name: "Village of Barovia",
        width: 4000,
        height: 3000,
        grid: { size: 100 },
        background: { src: "worlds/cos/scenes/barovia.webp" },
      },
    ];
    const { files } = buildVault(dump, FIXED_NOW);
    expect(files[0]!.path).toBe("generated/scenes/village-of-barovia.md");
    expect(files[0]!.content).toContain("background: worlds/cos/scenes/barovia.webp");
    expect(files[0]!.content).toContain("gridSize: 100");
  });

  it("de-duplicates colliding slugs", () => {
    const dump = emptyDump();
    dump.actors = [
      { _id: "AAAAAA11", name: "Wolf" },
      { _id: "BBBBBB22", name: "Wolf" },
    ];
    const { files } = buildVault(dump, FIXED_NOW);
    const paths = files.map((f) => f.path);
    expect(new Set(paths).size).toBe(2);
    expect(paths[0]).toBe("generated/npcs/wolf.md");
    expect(paths[1]).toBe("generated/npcs/wolf-bbbbbb.md");
  });

  it("carries the world id/system into the manifest", () => {
    const { manifest } = buildVault(emptyDump(), FIXED_NOW);
    expect(manifest.world).toEqual({ id: "w1", system: "dnd5e", forge: false });
    expect(manifest.version).toBe(1);
  });
});

describe("htmlToMarkdown", () => {
  it("converts the common tags and decodes entities", () => {
    expect(htmlToMarkdown("<p>Hello <strong>world</strong> &amp; <em>moon</em></p>")).toBe(
      "Hello **world** & *moon*",
    );
    expect(htmlToMarkdown("<h2>Title</h2><p>Body</p>")).toBe("## Title\n\nBody");
    expect(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
    expect(htmlToMarkdown('<a href="https://x.test">link</a>')).toBe("[link](https://x.test)");
  });

  it("returns empty for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  it("does not re-introduce raw HTML from encoded angle brackets (no injection)", () => {
    const out = htmlToMarkdown("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img"); // stays inert as literal text
  });
});

describe("slugify", () => {
  it("lowercases, strips diacritics, and dashes non-alphanumerics", () => {
    expect(slugify("Strahd von Zarovich")).toBe("strahd-von-zarovich");
    expect(slugify("Château d'Amiens!")).toBe("chateau-d-amiens");
  });
});
