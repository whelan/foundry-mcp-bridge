import { describe, it, expect } from "vitest";
import {
  plainText,
  toChatLogRoll,
  toChatLogMessage,
  buildChatLog,
  chatLogWindow,
} from "./chat.js";

/** A stored roll as Foundry persists it: a JSON string on the message source. */
function storedRoll(json: unknown): string {
  return JSON.stringify(json);
}

describe("plainText", () => {
  it("strips tags and keeps block boundaries readable", () => {
    expect(plainText("<p>Ireena</p><p>slår til</p>")).toBe("Ireena slår til");
    expect(plainText("line<br>break")).toBe("line break");
  });

  it("drops script and style content entirely", () => {
    expect(plainText("<script>alert(1)</script>safe")).toBe("safe");
    expect(plainText("<style>p{}</style>safe")).toBe("safe");
  });

  it("decodes the entities chat content actually carries", () => {
    expect(plainText("a &amp; b &lt;c&gt; &#39;d&#39; &nbsp;e")).toBe("a & b <c> 'd' e");
  });

  it("returns an empty string for non-strings", () => {
    expect(plainText(undefined)).toBe("");
    expect(plainText(42)).toBe("");
  });
});

describe("toChatLogRoll", () => {
  it("parses a stored JSON roll with its dice", () => {
    const roll = toChatLogRoll(
      storedRoll({
        formula: "1d20 + 5",
        total: 18,
        terms: [{ faces: 20, results: [{ result: 13, active: true }] }, { operator: "+" }],
      }),
    );
    expect(roll).toEqual({
      formula: "1d20 + 5",
      total: 18,
      dice: [{ faces: 20, results: [{ result: 13, discarded: false }] }],
    });
  });

  it("keeps discarded dice — an advantage roll shows both results", () => {
    const roll = toChatLogRoll({
      formula: "2d20kh",
      total: 18,
      terms: [
        {
          faces: 20,
          results: [
            { result: 18, active: true },
            { result: 4, active: false },
          ],
        },
      ],
    });
    expect(roll?.dice[0]?.results).toEqual([
      { result: 18, discarded: false },
      { result: 4, discarded: true },
    ]);
  });

  it("finds dice nested inside pool and parenthetical terms", () => {
    const roll = toChatLogRoll({
      formula: "{1d6,1d8}kh",
      total: 8,
      terms: [
        {
          class: "PoolTerm",
          rolls: [
            { terms: [{ faces: 6, results: [{ result: 3, active: true }] }] },
            { terms: [{ faces: 8, results: [{ result: 8, active: true }] }] },
          ],
        },
      ],
    });
    expect(roll?.dice.map((d) => d.faces)).toEqual([6, 8]);
  });

  it("reports an unevaluated roll as a null total rather than dropping it", () => {
    expect(toChatLogRoll({ formula: "1d20", terms: [] })).toEqual({
      formula: "1d20",
      total: null,
      dice: [],
    });
  });

  it("keeps an unparsable stored roll as its raw formula", () => {
    expect(toChatLogRoll("not json")).toEqual({ formula: "not json", total: null, dice: [] });
  });
});

describe("toChatLogMessage", () => {
  const base = {
    _id: "msg1",
    timestamp: Date.parse("2026-09-24T18:30:00Z"),
    author: "user1",
    speaker: { alias: "Ireena" },
    flavor: "<b>Perception</b>",
    content: "<p>18</p>",
    rolls: [storedRoll({ formula: "1d20+5", total: 18, terms: [] })],
  };

  it("maps a public roll message", () => {
    expect(toChatLogMessage(base, (id) => (id === "user1" ? "Niels" : undefined))).toEqual({
      _id: "msg1",
      timestamp: base.timestamp,
      time: "2026-09-24T18:30:00.000Z",
      authorName: "Niels",
      speakerName: "Ireena",
      visibility: "public",
      flavor: "Perception",
      text: "18",
      rolls: [{ formula: "1d20+5", total: 18, dice: [] }],
    });
  });

  it("falls back to the stored id when the user is gone", () => {
    expect(toChatLogMessage(base)?.authorName).toBe("user1");
  });

  it("reads the pre-v12 `user` field when `author` is absent", () => {
    const { author: _author, ...rest } = base;
    const msg = toChatLogMessage({ ...rest, user: "old1" }, () => "Lars");
    expect(msg?.authorName).toBe("Lars");
  });

  it("classifies whispers, and lets blind outrank whisper", () => {
    expect(toChatLogMessage({ ...base, whisper: ["gm"] })?.visibility).toBe("whisper");
    expect(toChatLogMessage({ ...base, whisper: ["gm"], blind: true })?.visibility).toBe("blind");
  });

  it("rejects anything without an id", () => {
    expect(toChatLogMessage({ timestamp: 1 })).toBeNull();
    expect(toChatLogMessage("nonsense")).toBeNull();
  });
});

describe("buildChatLog", () => {
  const at = (id: string, iso: string) => ({ _id: id, timestamp: Date.parse(iso), author: "u" });
  const raws = [
    at("c", "2026-09-24T20:00:00Z"),
    at("a", "2026-09-24T18:00:00Z"),
    at("b", "2026-09-24T19:00:00Z"),
    at("before", "2026-09-24T16:00:00Z"),
    at("after", "2026-09-24T23:00:00Z"),
  ];
  const window = {
    start: Date.parse("2026-09-24T17:00:00Z"),
    end: Date.parse("2026-09-24T22:00:00Z"),
    limit: 100,
  };

  it("keeps the window, sorted oldest first", () => {
    const log = buildChatLog(raws, window);
    expect(log.messages.map((m) => m._id)).toEqual(["a", "b", "c"]);
    expect(log.matched).toBe(3);
    expect(log.truncated).toBe(false);
    expect(log.interval).toEqual({
      start: "2026-09-24T17:00:00.000Z",
      end: "2026-09-24T22:00:00.000Z",
    });
  });

  it("treats start as inclusive and end as exclusive", () => {
    const log = buildChatLog(raws, { ...window, start: Date.parse("2026-09-24T18:00:00Z"), end: Date.parse("2026-09-24T20:00:00Z") });
    expect(log.messages.map((m) => m._id)).toEqual(["a", "b"]);
  });

  it("takes everything when the window is unbounded", () => {
    const log = buildChatLog(raws, { start: null, end: null, limit: 100 });
    expect(log.matched).toBe(5);
    expect(log.interval).toEqual({ start: null, end: null });
  });

  it("truncates to the limit and says so, keeping the oldest", () => {
    const log = buildChatLog(raws, { ...window, limit: 2 });
    expect(log.messages.map((m) => m._id)).toEqual(["a", "b"]);
    expect(log.matched).toBe(3);
    expect(log.truncated).toBe(true);
  });

  it("drops messages that cannot be placed in time", () => {
    const log = buildChatLog([...raws, { _id: "undated", author: "u" }], window);
    expect(log.messages.map((m) => m._id)).not.toContain("undated");
  });
});

describe("chatLogWindow", () => {
  it("resolves ISO bounds to epoch milliseconds", () => {
    expect(chatLogWindow("2026-09-24T17:00:00Z", "2026-09-24T22:00:00Z", 50)).toEqual({
      window: {
        start: Date.parse("2026-09-24T17:00:00Z"),
        end: Date.parse("2026-09-24T22:00:00Z"),
        limit: 50,
      },
    });
  });

  it("allows an open-ended window", () => {
    expect(chatLogWindow(undefined, undefined, 10)).toEqual({
      window: { start: null, end: null, limit: 10 },
    });
  });

  it("rejects an unparsable bound", () => {
    expect(chatLogWindow("torsdag aften", undefined, 10)).toEqual({
      error: "start is not a parsable date: torsdag aften",
    });
  });

  it("rejects an interval that does not move forward", () => {
    const iso = "2026-09-24T17:00:00Z";
    expect(chatLogWindow(iso, iso, 10)).toEqual({ error: "end must be after start" });
  });
});
