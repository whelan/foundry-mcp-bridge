import { describe, it, expect } from "vitest";
import { resolveWhisperRecipients, whisperHtml, escapeChatText, type WhisperUser } from "./whisper.js";

const users: WhisperUser[] = [
  { id: "gm", name: "Lars", isGM: true },
  { id: "u1", name: "Anna", isGM: false, characterName: "Kip Stonebrook" },
  { id: "u2", name: "Bo", isGM: false, characterName: "Pyrax" },
  { id: "u3", name: "Cecilie", isGM: false, characterName: "Ireena Kolyanovich" },
  { id: "u4", name: "Dan", isGM: false, characterName: "Kip Brightwater" },
];

const failure = (to: string[], code: string) => {
  const r = resolveWhisperRecipients(to, users);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe(code);
};

describe("resolveWhisperRecipients", () => {
  it("matches a user name, a character name, and a unique first name, case-insensitively", () => {
    const r = resolveWhisperRecipients(["anna", "Pyrax", "ireena"], users);
    expect(r).toEqual({
      ok: true,
      recipients: [
        { id: "u1", name: "Anna" },
        { id: "u2", name: "Bo" },
        { id: "u3", name: "Cecilie" },
      ],
    });
  });

  it("sends once to a player named twice", () => {
    const r = resolveWhisperRecipients(["Pyrax", "Bo"], users);
    expect(r.ok && r.recipients).toEqual([{ id: "u2", name: "Bo" }]);
  });

  it("refuses broadcast words in either language", () => {
    for (const word of ["all", "Everyone", "alle", "table", "spillere", "*"]) failure([word], "VALIDATION");
    failure(["Pyrax", "alle"], "VALIDATION");
  });

  it("refuses to name every player", () => {
    failure(["Anna", "Bo", "Cecilie", "Dan"], "VALIDATION");
  });

  it("allows a one-player world to name its player", () => {
    const solo = [users[0]!, users[1]!];
    expect(resolveWhisperRecipients(["Anna"], solo).ok).toBe(true);
  });

  it("never addresses a GM", () => {
    failure(["Lars"], "NOT_FOUND");
  });

  it("reports an unknown name with who is available", () => {
    const r = resolveWhisperRecipients(["Nobody"], users);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.details?.available).toContain("Anna (Kip Stonebrook)");
  });

  it("calls an ambiguous first name a conflict", () => {
    failure(["Kip"], "CONFLICT");
    expect(resolveWhisperRecipients(["Kip Stonebrook"], users).ok).toBe(true);
  });

  it("refuses an empty name", () => {
    failure(["  "], "VALIDATION");
  });
});

describe("whisperHtml", () => {
  it("makes paragraphs and line breaks from plain text", () => {
    expect(whisperHtml("Første.\nAnden linje.\n\nTredje.")).toBe("<p>Første.<br>Anden linje.</p><p>Tredje.</p>");
  });

  it("carries no markup", () => {
    expect(whisperHtml(`<img src=x onerror="alert(1)"> & 'q'`)).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;</p>",
    );
    expect(escapeChatText("<b>")).toBe("&lt;b&gt;");
  });
});
