// Unit tests for the pure decision helpers in scripts/gen-image.mjs (codex
// backend). The spawn/filesystem plumbing is deliberately untested here,
// mirroring how foundry-runtime.ts is kept out of CI.
import { describe, expect, test } from "vitest";
import {
  buildCodexArgv,
  buildCodexPrompt,
  parseCodexSessionId,
  pickGeneratedImage,
  resolveOutPath,
} from "../../scripts/gen-image.mjs";

describe("parseCodexSessionId", () => {
  test("takes thread_id from the first thread.started JSONL event", () => {
    const lines = [
      "Reading additional input from stdin...",
      '{"type":"thread.started","thread_id":"019f4389-799a-7db0-aa53-52af7a631892"}',
      '{"type":"turn.started"}',
    ];
    expect(parseCodexSessionId(lines)).toBe(
      "019f4389-799a-7db0-aa53-52af7a631892",
    );
  });

  test("falls back to the 'session id:' banner line when no JSONL matches", () => {
    const lines = [
      "OpenAI Codex v0.143.0",
      "session id: 019f437f-2f2b-7573-af72-7a4c9db9706d",
      "--------",
    ];
    expect(parseCodexSessionId(lines)).toBe(
      "019f437f-2f2b-7573-af72-7a4c9db9706d",
    );
  });

  test("tolerates garbage lines and returns null when nothing matches", () => {
    expect(parseCodexSessionId(["not json", "{broken", ""])).toBe(null);
  });
});

describe("pickGeneratedImage", () => {
  test("returns null when the session dir has no image files", () => {
    expect(pickGeneratedImage([{ name: "notes.txt", mtimeMs: 1 }])).toBe(null);
  });

  test("filters to image extensions and picks the newest by mtime", () => {
    const { chosen, extras } = pickGeneratedImage([
      { name: "call_a.png", mtimeMs: 100 },
      { name: "log.json", mtimeMs: 999 },
      { name: "call_b.PNG", mtimeMs: 300 },
      { name: "call_c.webp", mtimeMs: 200 },
    ]);
    expect(chosen.name).toBe("call_b.PNG");
    expect(extras.map((e) => e.name).sort()).toEqual([
      "call_a.png",
      "call_c.webp",
    ]);
  });

  test("single image has no extras", () => {
    const { chosen, extras } = pickGeneratedImage([
      { name: "call_a.jpg", mtimeMs: 5 },
    ]);
    expect(chosen.name).toBe("call_a.jpg");
    expect(extras).toEqual([]);
  });
});

describe("resolveOutPath", () => {
  const cwd = "/proj";

  test("--out wins verbatim over everything", () => {
    expect(
      resolveOutPath(
        { out: "custom/dir/x.png", name: "y.png", "out-dir": "cli-dir" },
        { outputDir: "cfg-dir" },
        { IMAGE_GEN_OUT_DIR: "env-dir" },
        cwd,
      ),
    ).toBe("custom/dir/x.png");
  });

  test("--name with --out-dir beats env and config", () => {
    expect(
      resolveOutPath(
        { name: "x.png", "out-dir": "cli-dir" },
        { outputDir: "cfg-dir" },
        { IMAGE_GEN_OUT_DIR: "env-dir" },
        cwd,
      ),
    ).toBe("/proj/cli-dir/x.png");
  });

  test("env beats config; config beats the images/ default", () => {
    expect(
      resolveOutPath(
        { name: "x.png" },
        { outputDir: "cfg-dir" },
        { IMAGE_GEN_OUT_DIR: "env-dir" },
        cwd,
      ),
    ).toBe("/proj/env-dir/x.png");
    expect(
      resolveOutPath({ name: "x.png" }, { outputDir: "cfg-dir" }, {}, cwd),
    ).toBe("/proj/cfg-dir/x.png");
    expect(resolveOutPath({ name: "x.png" }, null, {}, cwd)).toBe(
      "/proj/images/x.png",
    );
  });

  test("absolute output dir is used as-is", () => {
    expect(
      resolveOutPath({ name: "x.png" }, null, { IMAGE_GEN_OUT_DIR: "/abs" }, cwd),
    ).toBe("/abs/x.png");
  });

  test("returns null when neither --out nor --name is given", () => {
    expect(resolveOutPath({}, { outputDir: "cfg-dir" }, {}, cwd)).toBe(null);
  });
});

describe("buildCodexPrompt", () => {
  test("wraps the prompt with generate-only instructions", () => {
    const p = buildCodexPrompt({ prompt: "a shiba inu wearing sunglasses" });
    expect(p).toContain("exactly one image");
    expect(p).toContain("a shiba inu wearing sunglasses");
    expect(p).toMatch(/do not attempt to save, copy, move/i);
    expect(p).not.toContain("Target size");
  });

  test("adds a size hint when width and height are given", () => {
    const p = buildCodexPrompt({ prompt: "a map", width: "768", height: "512" });
    expect(p).toContain("Target size: 768x512.");
  });
});

describe("buildCodexArgv", () => {
  test("attaches the guide before the prompt", () => {
    const argv = buildCodexArgv({ prompt: "paint it", image: "/g/guide.png" }, undefined);
    const i = argv.indexOf("-i");
    expect(argv.slice(i, i + 3)).toEqual(["-i", "/g/guide.png", "--"]);
    expect(argv.at(-1)).toContain("paint it");
  });

  test("without a guide is unchanged", () => {
    const argv = buildCodexArgv({ prompt: "paint it" }, "m1");
    expect(argv).not.toContain("-i");
    expect(argv.slice(0, 5)).toEqual(["exec", "--json", "-s", "read-only", "--skip-git-repo-check"]);
    expect(argv).toContain("m1");
  });
});
