import { describe, it, expect } from "vitest";
import { renderPlan } from "./render.js";
import type { Plan, PlanItem } from "./types.js";

function plan(items: Partial<PlanItem>[]): Plan {
  return {
    world: { id: "w1", matches: true },
    blocked: false,
    items: items.map((i) => ({
      source: i.source!,
      documentType: i.documentType ?? "JournalEntry",
      action: i.action ?? "create",
      foundryId: i.foundryId,
      reason: "",
      contentHash: "h",
      assets: [],
    })),
  };
}

const NOTE = `---
id: J1
name: The Worg Cave
---
A dark cave under the cliffs.`;

describe("renderPlan", () => {
  it("renders a single-page journal to one Description page with HTML content", () => {
    const out = renderPlan(plan([{ source: "generated/journals/worg-cave.md" }]), () => NOTE);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("The Worg Cave");
    expect(out[0]!.pages).toEqual([
      {
        name: "Description",
        type: "text",
        text: { content: "<p>A dark cave under the cliffs.</p>", format: 1 },
      },
    ]);
  });

  it("splits a `## ` sectioned body into one named page per section", () => {
    const note = `---
name: Death House
---
## Intro

A creepy house.

## Basement

The ritual chamber.`;
    const out = renderPlan(plan([{ source: "generated/journals/death-house.md" }]), () => note);
    expect(out[0]!.pages.map((p) => p.name)).toEqual(["Intro", "Basement"]);
    expect(out[0]!.pages[0]!.text).toEqual({ content: "<p>A creepy house.</p>", format: 1 });
    expect(out[0]!.pages[1]!.text.content).toBe("<p>The ritual chamber.</p>");
  });

  it("carries action + foundryId through for updates", () => {
    const out = renderPlan(
      plan([{ source: "generated/journals/worg-cave.md", action: "update", foundryId: "abc123" }]),
      () => NOTE,
    );
    expect(out[0]!.action).toBe("update");
    expect(out[0]!.foundryId).toBe("abc123");
  });

  it("skips non-journal and non-write items (no body read into context)", () => {
    const loaded: string[] = [];
    const out = renderPlan(
      plan([
        { source: "generated/journals/keep.md", action: "create" },
        { source: "generated/scenes/map.md", documentType: "Scene", action: "create" },
        { source: "generated/journals/synced.md", action: "unchanged" },
        { source: "generated/quests/q.md", documentType: "Quest", action: "create" },
      ]),
      (source) => {
        loaded.push(source);
        return NOTE;
      },
    );
    expect(out.map((d) => d.source)).toEqual(["generated/journals/keep.md"]);
    // Only the one journal create was ever loaded — the rest never touch the loader.
    expect(loaded).toEqual(["generated/journals/keep.md"]);
  });
});
