import { describe, it, expect } from "vitest";
import { ensureDirectory, type DirectoryCreator } from "./ensure-directory.js";

/** Faithful fake: non-recursive (parent must exist) and throws on existing. */
function fakeFilePicker(preexisting: string[] = []) {
  const dirs = new Set<string>(preexisting);
  const creator: DirectoryCreator = {
    async createDirectory(_source, target) {
      if (dirs.has(target)) throw new Error(`EEXIST: ${target} already exists.`);
      const parent = target.split("/").slice(0, -1).join("/");
      if (parent && !dirs.has(parent)) {
        throw new Error(`Target directory ${target} does not exist.`);
      }
      dirs.add(target);
    },
  };
  return { creator, dirs };
}

describe("ensureDirectory", () => {
  it("creates every missing level of a nested path in order", async () => {
    const { creator, dirs } = fakeFilePicker();
    await ensureDirectory(creator, "data", "worlds/npcs/gravemire-stalker");
    expect([...dirs]).toEqual(["worlds", "worlds/npcs", "worlds/npcs/gravemire-stalker"]);
  });

  it("is idempotent when the path already exists", async () => {
    const { creator, dirs } = fakeFilePicker(["worlds", "worlds/npcs", "worlds/npcs/x"]);
    await ensureDirectory(creator, "data", "worlds/npcs/x");
    expect(dirs.size).toBe(3);
  });

  it("completes a partially existing path", async () => {
    const { creator, dirs } = fakeFilePicker(["worlds"]);
    await ensureDirectory(creator, "data", "worlds/npcs/deep/deeper");
    expect(dirs.has("worlds/npcs/deep/deeper")).toBe(true);
  });

  it("ignores trailing and duplicate slashes", async () => {
    const { creator, dirs } = fakeFilePicker();
    await ensureDirectory(creator, "data", "worlds//npcs/");
    expect([...dirs]).toEqual(["worlds", "worlds/npcs"]);
  });
});
