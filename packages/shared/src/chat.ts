/**
 * Chat-log reading: shapes plus the pure mapping from a raw Foundry
 * ChatMessage to the compact record the bridge returns.
 *
 * The mapping lives here rather than in foundry-runtime.ts because it is the
 * part that can be wrong in interesting ways — HTML content, rolls stored as
 * JSON strings, discarded dice — and foundry-runtime.ts is not exercised in CI.
 * The module and the mock both call these functions, so a chat log read from
 * the real world and one read from the mock are shaped by the same code.
 */

/** One die in a stored roll, including results the roll discarded. */
export interface ChatLogDie {
  /** Number of faces; null when the term did not record one. */
  faces: number | null;
  results: Array<{ result: number; discarded: boolean }>;
}

export interface ChatLogRoll {
  formula: string;
  /** null when the message stored an unevaluated roll. */
  total: number | null;
  dice: ChatLogDie[];
}

/**
 * Who could see the message. `blind` outranks `whisper`: a blind roll is
 * addressed to the GM whether or not it also carries whisper recipients.
 */
export type ChatLogVisibility = "public" | "whisper" | "blind";

export interface ChatLogMessage {
  _id: string;
  /** Epoch milliseconds, as Foundry stores it. */
  timestamp: number;
  /** ISO 8601 UTC rendering of `timestamp`, so callers never re-derive it. */
  time: string;
  /** Resolved user name when the user still exists, else the stored id. */
  authorName: string;
  /** Speaker alias (the actor/token the message was spoken as), else "". */
  speakerName: string;
  visibility: ChatLogVisibility;
  /** Roll label / message flavor, as plain text. */
  flavor: string;
  /** Message body, as plain text. */
  text: string;
  rolls: ChatLogRoll[];
}

export interface ChatLogWindow {
  /** Inclusive lower bound, epoch ms; null for unbounded. */
  start: number | null;
  /** Exclusive upper bound, epoch ms; null for unbounded. */
  end: number | null;
  /** Cap on returned messages; the oldest are kept. */
  limit: number;
}

export interface ChatLog {
  /** Bounds actually applied, ISO 8601 UTC; null when unbounded. */
  interval: { start: string | null; end: string | null };
  /** How many messages fell in the interval before `limit` was applied. */
  matched: number;
  /** True when `matched` exceeded `limit` and the tail was dropped. */
  truncated: boolean;
  messages: ChatLogMessage[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Best-effort HTML → plain text for chat content. Not a parser: chat content is
 * evidence to read, and the goal is a line that survives a markdown table and a
 * prompt without carrying markup or a script tag. Block-ish tags become spaces
 * so "<p>a</p><p>b</p>" does not read as "ab".
 */
export function plainText(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull every die out of a roll's term tree. Pool and parenthetical terms nest
 * their own rolls/terms, so this recurses rather than reading the top level —
 * an advantage d20 inside a pool is exactly the evidence worth keeping.
 */
function collectDice(node: unknown, out: ChatLogDie[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectDice(child, out);
    return;
  }
  const term = asRecord(node);
  if (!term) return;
  if (Array.isArray(term.results) && (typeof term.faces === "number" || term.faces === undefined)) {
    out.push({
      faces: typeof term.faces === "number" ? term.faces : null,
      results: term.results.flatMap((entry) => {
        const r = asRecord(entry);
        if (!r || typeof r.result !== "number") return [];
        // Foundry marks a kept die `active: true`; a dropped/rerolled one is
        // either inactive or explicitly discarded.
        return [{ result: r.result, discarded: r.active === false || r.discarded === true }];
      }),
    });
  }
  collectDice(term.terms, out);
  collectDice(term.rolls, out);
}

/**
 * Normalize one stored roll. Foundry persists rolls as JSON strings on the
 * document source, so a string is parsed rather than rejected.
 */
export function toChatLogRoll(stored: unknown): ChatLogRoll | null {
  let value = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored);
    } catch {
      // An unparsable entry is still evidence that something was rolled.
      return { formula: stored, total: null, dice: [] };
    }
  }
  const roll = asRecord(value);
  if (!roll) return null;
  const dice: ChatLogDie[] = [];
  collectDice(roll.terms, dice);
  return {
    formula: typeof roll.formula === "string" ? roll.formula : "",
    total: typeof roll.total === "number" ? roll.total : null,
    dice,
  };
}

/**
 * Map a raw ChatMessage source object to a {@link ChatLogMessage}.
 * `resolveUserName` turns an author id into a name; unresolved ids are kept
 * verbatim so a message from a deleted user is still attributable.
 */
export function toChatLogMessage(
  raw: unknown,
  resolveUserName: (id: string) => string | undefined = () => undefined,
): ChatLogMessage | null {
  const m = asRecord(raw);
  if (!m || typeof m._id !== "string" || !m._id) return null;
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : Number.NaN;
  // v12+ stores the user id on `author`; older worlds used `user`.
  const authorId = typeof m.author === "string" ? m.author : typeof m.user === "string" ? m.user : "";
  const speaker = asRecord(m.speaker);
  const whisper = Array.isArray(m.whisper) ? m.whisper : [];
  const rolls = Array.isArray(m.rolls) ? m.rolls : [];
  return {
    _id: m._id,
    timestamp,
    time: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "",
    authorName: (authorId && resolveUserName(authorId)) || authorId,
    speakerName: typeof speaker?.alias === "string" ? speaker.alias : "",
    visibility: m.blind === true ? "blind" : whisper.length > 0 ? "whisper" : "public",
    flavor: plainText(m.flavor),
    text: plainText(m.content),
    rolls: rolls.map(toChatLogRoll).filter((r): r is ChatLogRoll => r !== null),
  };
}

/**
 * Filter to the window, sort oldest-first and cap at `limit`. Messages without
 * a usable timestamp are dropped: a chat log whose entries cannot be placed in
 * time cannot be lined up against a transcript, which is the whole point.
 */
export function buildChatLog(raws: unknown[], window: ChatLogWindow, resolveUserName?: (id: string) => string | undefined): ChatLog {
  const inWindow = raws
    .map((raw) => toChatLogMessage(raw, resolveUserName))
    .filter((m): m is ChatLogMessage => {
      if (!m || !Number.isFinite(m.timestamp)) return false;
      if (window.start !== null && m.timestamp < window.start) return false;
      if (window.end !== null && m.timestamp >= window.end) return false;
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id));
  return {
    interval: {
      start: window.start === null ? null : new Date(window.start).toISOString(),
      end: window.end === null ? null : new Date(window.end).toISOString(),
    },
    matched: inWindow.length,
    truncated: inWindow.length > window.limit,
    messages: inWindow.slice(0, window.limit),
  };
}

/**
 * Resolve the command's ISO bounds into epoch ms. Returns an error message
 * instead of throwing so both the module and the mock reject an unusable
 * interval with the same VALIDATION text.
 */
export function chatLogWindow(
  start: string | undefined,
  end: string | undefined,
  limit: number,
): { window: ChatLogWindow } | { error: string } {
  const parse = (value: string | undefined, label: string): number | null | string => {
    if (value === undefined) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : `${label} is not a parsable date: ${value}`;
  };
  const startMs = parse(start, "start");
  if (typeof startMs === "string") return { error: startMs };
  const endMs = parse(end, "end");
  if (typeof endMs === "string") return { error: endMs };
  if (startMs !== null && endMs !== null && endMs <= startMs) {
    return { error: "end must be after start" };
  }
  return { window: { start: startMs, end: endMs, limit } };
}
