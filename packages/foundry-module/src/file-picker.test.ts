import { describe, expect, it } from "vitest";
import { resolveFilePicker } from "./file-picker.js";

describe("resolveFilePicker", () => {
  const Legacy = { name: "legacy" };
  const Implementation = { name: "implementation" };
  const Forge = { name: "forge" };

  it("prefers CONFIG.ux.FilePicker (where The Forge installs its upload-capable picker)", () => {
    expect(
      resolveFilePicker({
        CONFIG: { ux: { FilePicker: Forge } },
        foundry: { applications: { apps: { FilePicker: { implementation: Implementation } } } },
        FilePicker: Legacy,
      }),
    ).toBe(Forge);
  });

  it("falls back to the namespaced implementation, then the legacy global", () => {
    expect(
      resolveFilePicker({
        foundry: { applications: { apps: { FilePicker: { implementation: Implementation } } } },
        FilePicker: Legacy,
      }),
    ).toBe(Implementation);
    expect(resolveFilePicker({ CONFIG: {}, FilePicker: Legacy })).toBe(Legacy);
  });
});
