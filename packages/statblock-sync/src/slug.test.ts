import { describe, it, expect } from "vitest";
import { statblockKey } from "./slug.js";

describe("statblockKey", () => {
  it("converts names to lowercase hyphenated slugs", () => {
    expect(statblockKey("Test Archmage")).toBe("test-archmage");
    expect(statblockKey("Young Ash Wyrm")).toBe("young-ash-wyrm");
  });

  it("handles apostrophes by removing them", () => {
    expect(statblockKey("Liar's Guild Master")).toBe("liars-guild-master");
  });

  it("handles commas by removing them", () => {
    expect(statblockKey("Dragon, Ancient")).toBe("dragon-ancient");
  });

  it("collapses multiple spaces into single hyphen", () => {
    expect(statblockKey("Flame   Wizard")).toBe("flame-wizard");
  });

  it("returns empty string for empty input", () => {
    expect(statblockKey("")).toBe("");
  });

  it("trims leading/trailing whitespace before slugifying", () => {
    expect(statblockKey("  Test Archmage  ")).toBe("test-archmage");
  });
});
