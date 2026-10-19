import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION, type CommandError } from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import type { ToolOutcome } from "../../packages/mcp-server/src/reliability.js";
import { runWhisperPlayer } from "../../packages/mcp-server/src/tools.js";

function setup() {
  const mock = new MockFoundry();
  mock.whisperUsers.push(
    { id: "gm", name: "Lars", isGM: true },
    { id: "u1", name: "Anna", isGM: false, characterNames: ["Kip Stonebrook"] },
    { id: "u2", name: "Bo", isGM: false, characterNames: ["Pyrax"] },
    { id: "u3", name: "Cecilie", isGM: false, characterNames: ["Ireena Kolyanovich"] },
  );
  return { mock, transport: new MockTransport(mock) };
}

function expectErr(out: ToolOutcome, code: CommandError["code"]): void {
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error.code).toBe(code);
}

describe("whisper_player", () => {
  it("sends one whisper to the named players and nobody else", async () => {
    const { mock, transport } = setup();
    const out = await runWhisperPlayer(transport, {
      to: ["Kip", "Pyrax"],
      content: "Trappen drejer.\n\nMørket forneden har en højde.",
      flavor: "Før rullet",
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data).toMatchObject({ sent: true, to: [{ id: "u1" }, { id: "u2" }] });
    expect(mock.whispers).toEqual([
      {
        id: "msg1",
        whisper: ["u1", "u2"],
        content: "<p>Trappen drejer.</p><p>Mørket forneden har en højde.</p>",
        flavor: "Før rullet",
      },
    ]);
  });

  it("escapes markup in the text and the flavor", async () => {
    const { mock, transport } = setup();
    await runWhisperPlayer(transport, { to: ["Anna"], content: "<script>x</script>", flavor: "<b>cue</b>" });
    expect(mock.whispers[0]!.content).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
    expect(mock.whispers[0]!.flavor).toBe("&lt;b&gt;cue&lt;/b&gt;");
  });

  it("refuses the whole table, by word and by naming everyone, and sends nothing", async () => {
    const { mock, transport } = setup();
    expectErr(await runWhisperPlayer(transport, { to: ["alle"], content: "hej" }), "VALIDATION");
    expectErr(await runWhisperPlayer(transport, { to: ["Anna", "Bo", "Cecilie"], content: "hej" }), "VALIDATION");
    expect(mock.whispers).toHaveLength(0);
  });

  it("never reaches a GM, and reports an unknown player", async () => {
    const { mock, transport } = setup();
    expectErr(await runWhisperPlayer(transport, { to: ["Lars"], content: "hej" }), "NOT_FOUND");
    expectErr(await runWhisperPlayer(transport, { to: ["Nobody"], content: "hej" }), "NOT_FOUND");
    expect(mock.whispers).toHaveLength(0);
  });

  it("dry-run resolves the recipients without sending", async () => {
    const { mock } = setup();
    const res = await mock.execute({
      id: "dry",
      protocolVersion: PROTOCOL_VERSION,
      dryRun: true,
      command: { action: "whisperPlayer", to: ["Pyrax"], content: "hej" },
    });
    expect(res).toMatchObject({ ok: true, data: { sent: false, to: [{ id: "u2" }] } });
    expect(mock.whispers).toHaveLength(0);
  });
});
