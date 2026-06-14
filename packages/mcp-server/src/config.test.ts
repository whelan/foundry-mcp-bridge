import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fmb-cfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("reads required config from the environment", () => {
    const cfg = loadConfig({ env: { RELAY_URL: "ws://x:1" }, cwd: dir });
    expect(cfg.relayUrl).toBe("ws://x:1");
    expect(cfg.requestTimeoutMs).toBe(10_000);
    expect(cfg.relayToken).toBeUndefined();
  });

  it("fails loudly when the required relay URL is missing", () => {
    expect(() => loadConfig({ env: {}, cwd: dir })).toThrowError(/relayUrl/);
  });

  it("reads a .env file in the working directory", () => {
    writeFileSync(join(dir, ".env"), 'RELAY_URL="ws://env:2"\nRELAY_TOKEN=abc\n');
    const cfg = loadConfig({ env: {}, cwd: dir });
    expect(cfg.relayUrl).toBe("ws://env:2");
    expect(cfg.relayToken).toBe("abc");
  });

  it("ignores dev.config.json unless NODE_ENV=development", () => {
    writeFileSync(join(dir, "dev.config.json"), JSON.stringify({ relayUrl: "ws://dev:3" }));
    expect(() => loadConfig({ env: {}, cwd: dir })).toThrowError(/relayUrl/);

    const cfg = loadConfig({ env: { NODE_ENV: "development" }, cwd: dir });
    expect(cfg.relayUrl).toBe("ws://dev:3");
  });

  it("lets the environment take precedence over dev.config.json", () => {
    writeFileSync(join(dir, "dev.config.json"), JSON.stringify({ relayUrl: "ws://dev:3" }));
    const cfg = loadConfig({ env: { NODE_ENV: "development", RELAY_URL: "ws://env:9" }, cwd: dir });
    expect(cfg.relayUrl).toBe("ws://env:9");
  });
});
