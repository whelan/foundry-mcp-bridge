import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  buildCodexPrompt,
  parseCodexSessionId,
  pickGeneratedImage,
  resolveOutPath,
} from "../../scripts/gen-image.mjs";

const THREAD_ID = "0195d3a1-2b3c-4d5e-8f90-1234567890ab";

describe("parseCodexSessionId", () => {
  it("takes thread_id from the first thread.started JSONL event", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "thread.started", thread_id: "later-id" }),
    ];
    expect(parseCodexSessionId(lines)).toBe(THREAD_ID);
  });

  it("tolerates non-JSON garbage between events", () => {
    const lines = [
      "Reading additional input from stdin...",
      "{not json at all",
      JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }),
    ];
    expect(parseCodexSessionId(lines)).toBe(THREAD_ID);
  });

  it("falls back to the banner's session id line without --json output", () => {
    const lines = [
      "OpenAI Codex v0.143.0",
      `session id: ${THREAD_ID}`,
      "model: gpt-5.5",
    ];
    expect(parseCodexSessionId(lines)).toBe(THREAD_ID);
  });

  it("prefers the JSONL event over a banner line", () => {
    const lines = [
      "session id: 99999999-9999-4999-8999-999999999999",
      JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }),
    ];
    expect(parseCodexSessionId(lines)).toBe(THREAD_ID);
  });

  it("returns null when nothing matches", () => {
    expect(parseCodexSessionId(["hello", "{}", '{"type":"other"}'])).toBeNull();
    expect(parseCodexSessionId([])).toBeNull();
  });

  it("ignores a thread.started event with a non-string thread_id", () => {
    const lines = [JSON.stringify({ type: "thread.started", thread_id: 42 })];
    expect(parseCodexSessionId(lines)).toBeNull();
  });
});

describe("pickGeneratedImage", () => {
  it("returns null chosen for an empty listing", () => {
    expect(pickGeneratedImage([])).toEqual({ chosen: null, extras: [] });
  });

  it("filters out non-image files", () => {
    const result = pickGeneratedImage([
      { name: "notes.txt", mtimeMs: 100 },
      { name: "call_1.png", mtimeMs: 50 },
      { name: "meta.json", mtimeMs: 200 },
    ]);
    expect(result.chosen?.name).toBe("call_1.png");
    expect(result.extras).toEqual([]);
  });

  it("picks the newest image by mtime and returns the rest as extras", () => {
    const result = pickGeneratedImage([
      { name: "call_1.png", mtimeMs: 100 },
      { name: "call_3.webp", mtimeMs: 300 },
      { name: "call_2.jpeg", mtimeMs: 200 },
    ]);
    expect(result.chosen?.name).toBe("call_3.webp");
    expect(result.extras.map((e) => e.name)).toEqual(["call_2.jpeg", "call_1.png"]);
  });

  it("accepts .png .jpg .jpeg .webp regardless of case, nothing else", () => {
    const result = pickGeneratedImage([
      { name: "a.PNG", mtimeMs: 1 },
      { name: "b.JPG", mtimeMs: 2 },
      { name: "c.gif", mtimeMs: 3 },
      { name: "d.svg", mtimeMs: 4 },
    ]);
    expect(result.chosen?.name).toBe("b.JPG");
    expect(result.extras.map((e) => e.name)).toEqual(["a.PNG"]);
  });
});

describe("resolveOutPath", () => {
  const cwd = "/proj";

  it("uses --out verbatim when given, even alongside --name", () => {
    expect(
      resolveOutPath({ out: "tmp/x.png", name: "y.png" }, { outputDir: "art" }, {}, cwd),
    ).toBe("tmp/x.png");
  });

  it("returns null when neither --out nor --name is given", () => {
    expect(resolveOutPath({}, null, {}, cwd)).toBeNull();
  });

  it("prefers --out-dir over env and config for --name", () => {
    const args = { name: "x.png", "out-dir": "cli-dir" };
    const env = { IMAGE_GEN_OUT_DIR: "env-dir" };
    expect(resolveOutPath(args, { outputDir: "cfg-dir" }, env, cwd)).toBe(
      resolve(cwd, "cli-dir", "x.png"),
    );
  });

  it("prefers IMAGE_GEN_OUT_DIR over config", () => {
    const env = { IMAGE_GEN_OUT_DIR: "env-dir" };
    expect(resolveOutPath({ name: "x.png" }, { outputDir: "cfg-dir" }, env, cwd)).toBe(
      resolve(cwd, "env-dir", "x.png"),
    );
  });

  it("uses .imagegen.json outputDir when CLI and env are absent", () => {
    expect(resolveOutPath({ name: "x.png" }, { outputDir: "cfg-dir" }, {}, cwd)).toBe(
      resolve(cwd, "cfg-dir", "x.png"),
    );
  });

  it("defaults to images/ under the cwd", () => {
    expect(resolveOutPath({ name: "x.png" }, null, {}, cwd)).toBe(
      resolve(cwd, "images", "x.png"),
    );
  });

  it("keeps an absolute output directory absolute", () => {
    expect(resolveOutPath({ name: "x.png", "out-dir": "/abs/dir" }, null, {}, cwd)).toBe(
      resolve("/abs/dir", "x.png"),
    );
  });
});

describe("buildCodexPrompt", () => {
  it("wraps the user prompt with generate-only instructions", () => {
    const prompt = buildCodexPrompt({ prompt: "a shiba inu wearing sunglasses" });
    expect(prompt).toContain("generate exactly one image");
    expect(prompt).toContain("a shiba inu wearing sunglasses");
    expect(prompt).toContain("Do not attempt to save, copy, move, or verify");
    expect(prompt).not.toContain("Target size");
  });

  it("appends a size hint when width and height are given", () => {
    const prompt = buildCodexPrompt({ prompt: "p", width: "768", height: "512" });
    expect(prompt).toContain("Target size: 768x512.");
  });

  it("fills a missing dimension from the other one", () => {
    expect(buildCodexPrompt({ prompt: "p", width: "640" })).toContain(
      "Target size: 640x640.",
    );
    expect(buildCodexPrompt({ prompt: "p", height: "480" })).toContain(
      "Target size: 480x480.",
    );
  });
});
