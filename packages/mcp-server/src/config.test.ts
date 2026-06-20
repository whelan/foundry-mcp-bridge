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

  it("leaves Forge credentials undefined by default", () => {
    const cfg = loadConfig({ env: { RELAY_URL: "ws://x:1" }, cwd: dir });
    expect(cfg.forgeUserId).toBeUndefined();
    expect(cfg.forgeApiKey).toBeUndefined();
    expect(cfg.forgeApiBaseUrl).toBeUndefined();
  });

  it("reads optional Forge credentials when provided", () => {
    const cfg = loadConfig({
      env: {
        RELAY_URL: "ws://x:1",
        FORGE_USER_ID: "user-123",
        FORGE_API_KEY: "key-abc",
        FORGE_API_BASE_URL: "https://forge.example/api",
      },
      cwd: dir,
    });
    expect(cfg.forgeUserId).toBe("user-123");
    expect(cfg.forgeApiKey).toBe("key-abc");
    expect(cfg.forgeApiBaseUrl).toBe("https://forge.example/api");
  });

  it("rejects a malformed Forge API base URL", () => {
    expect(() =>
      loadConfig({ env: { RELAY_URL: "ws://x:1", FORGE_API_BASE_URL: "not-a-url" }, cwd: dir }),
    ).toThrowError(/forgeApiBaseUrl/);
  });
});
