/**
 * Whispering to named players: the pure parts.
 *
 * `whisper_player` is the one place the bridge writes a chat message, so it is narrow by
 * construction and the narrowing lives here, where CI runs it: recipients are players
 * the caller names, never the whole table, and the text is escaped into plain paragraphs.
 * The module and the mock both call these functions, so the real world and the tests
 * resolve recipients and shape the message with the same code.
 */

/** Most players one whisper may name. */
export const WHISPER_MAX_RECIPIENTS = 6;
/** Longest whisper body, in characters. */
export const WHISPER_MAX_CONTENT = 4000;
/** Longest flavor line, in characters. */
export const WHISPER_MAX_FLAVOR = 200;

/** What recipient resolution needs to know about a world user. */
export interface WhisperUser {
  id: string;
  name: string;
  isGM: boolean;
  /** Name of the user's assigned character, when there is one. */
  characterName?: string;
}

export interface WhisperRecipient {
  id: string;
  name: string;
}

export type WhisperResolution =
  | { ok: true; recipients: WhisperRecipient[] }
  | {
      ok: false;
      code: "VALIDATION" | "NOT_FOUND" | "CONFLICT";
      message: string;
      details?: Record<string, unknown>;
    };

/** Words that mean "everyone". A whisper never goes to the table, so they are refused by name. */
const BROADCAST = /^(all|everyone|everybody|alle|table|party|players|spillere|\*)$/i;

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Turn the names a caller gave into world users. A name matches, in this order, a player's
 * user name, a player's character name, or the first word of a character name when that
 * is unambiguous ("Kip" for "Kip Stonebrook"). Game masters are never recipients: this
 * tool talks to players. Naming every player in a world with more than one is refused,
 * since that is a broadcast in all but name.
 */
export function resolveWhisperRecipients(to: string[], users: WhisperUser[]): WhisperResolution {
  const players = users.filter((u) => !u.isGM);
  const available = players.map((p) => (p.characterName ? `${p.name} (${p.characterName})` : p.name));
  const found = new Map<string, WhisperRecipient>();

  for (const raw of to) {
    const wanted = norm(raw);
    if (!wanted) return { ok: false, code: "VALIDATION", message: "A recipient name is empty" };
    if (BROADCAST.test(wanted)) {
      return {
        ok: false,
        code: "VALIDATION",
        message: `"${raw}" would address the whole table. A whisper goes only to players you name one by one.`,
      };
    }
    const steps: Array<(u: WhisperUser) => boolean> = [
      (u) => norm(u.name) === wanted,
      (u) => norm(u.characterName ?? "") === wanted,
      (u) => norm(u.characterName ?? "").split(/\s+/)[0] === wanted,
    ];
    let matches: WhisperUser[] = [];
    for (const step of steps) {
      matches = players.filter(step);
      if (matches.length > 0) break;
    }
    if (matches.length === 0) {
      return { ok: false, code: "NOT_FOUND", message: `No player matches "${raw}"`, details: { available } };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: "CONFLICT",
        message: `"${raw}" matches more than one player; use the full user name`,
        details: { matches: matches.map((m) => m.name) },
      };
    }
    found.set(matches[0]!.id, { id: matches[0]!.id, name: matches[0]!.name });
  }

  const recipients = [...found.values()];
  if (players.length > 1 && recipients.length === players.length) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "That names every player, which is a broadcast. Read it aloud or share it as an image instead.",
    };
  }
  return { ok: true, recipients };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text so it can sit inside chat HTML as plain characters. */
export function escapeChatText(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/**
 * Plain text into chat HTML: blank lines separate paragraphs, single newlines become
 * line breaks, and every character is escaped, so the message can carry no markup.
 */
export function whisperHtml(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeChatText(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
