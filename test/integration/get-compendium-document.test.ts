import { describe, it, expect } from "vitest";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import { runGetCompendiumDocument } from "../../packages/mcp-server/src/tools.js";

describe("runGetCompendiumDocument", () => {
  it("reads a compendium actor's data + items over the transport", async () => {
    const transport = new MockTransport(new MockFoundry());
    const result = await runGetCompendiumDocument(transport, {
      uuid: "Compendium.dnd5e.actors24.gravemire-stalker",
    });
    expect(result.ok).toBe(true);
    const data = (result as any).data;
    expect(data.name).toBe("Gravemire Stalker");
    expect(data.items.length).toBe(5);
  });
});
