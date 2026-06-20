import { describe, it, expect } from "vitest";
import { parseNote, classifyType, DEFAULT_TYPE_MAP, MANAGED_KEYS } from "./notes.js";

const note = `---
id: ""
name: Strahd
status: active
tasks:
  - name: Find the tome
    completed: true
---
# Strahd

Body text.
`;

describe("notes", () => {
  it("classifies by folder prefix", () => {
    expect(classifyType("generated/npcs/strahd.md", DEFAULT_TYPE_MAP)).toBe("Actor");
    expect(classifyType("generated/quests/escape.md", DEFAULT_TYPE_MAP)).toBe("Quest");
    expect(classifyType("generated/scenes/barovia.md", DEFAULT_TYPE_MAP)).toBe("Scene");
  });

  it("parses front-matter + body and exposes the id", () => {
    const n = parseNote("generated/npcs/strahd.md", note, DEFAULT_TYPE_MAP);
    expect(n.frontMatter.name).toBe("Strahd");
    expect(n.documentType).toBe("Actor");
    expect(n.body.trim()).toContain("Body text.");
  });

  it("parses CRLF notes identically to LF (cross-platform determinism)", () => {
    const lf = parseNote("generated/npcs/strahd.md", note, DEFAULT_TYPE_MAP);
    const crlf = parseNote("generated/npcs/strahd.md", note.replace(/\n/g, "\r\n"), DEFAULT_TYPE_MAP);
    expect(crlf.frontMatter).toEqual(lf.frontMatter);
    expect(crlf.body).toBe(lf.body);
    expect(crlf.contentHash).toBe(lf.contentHash);
  });

  it("contentHash excludes managed (progress) keys", () => {
    const withProgress = parseNote("generated/quests/x.md", note, DEFAULT_TYPE_MAP);
    const noProgress = note.replace("status: active", "status: inactive");
    const other = parseNote("generated/quests/x.md", noProgress, DEFAULT_TYPE_MAP);
    // status is a MANAGED_KEY, so flipping it must NOT change the content hash.
    expect(MANAGED_KEYS).toContain("status");
    expect(withProgress.contentHash).toBe(other.contentHash);
  });
});
