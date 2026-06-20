import { hashContent } from "./hash.js";
import type { QuestState } from "./types.js";

interface RawTask {
  name?: string;
  completed?: boolean;
  failed?: boolean;
}

export function extractQuest(journalEntry: unknown): QuestState {
  const json = (journalEntry as { flags?: Record<string, { json?: unknown }> })?.flags?.[
    "forien-quest-log"
  ]?.json as
    | { status?: string; tasks?: RawTask[]; date?: { start?: number | null; end?: number | null } }
    | undefined;
  if (!json || typeof json.status !== "string") {
    throw new Error("Not a Forien's Quest Log quest: missing flags[\"forien-quest-log\"].json");
  }
  return {
    status: json.status,
    tasks: (json.tasks ?? []).map((t) => ({
      name: String(t.name ?? ""),
      completed: Boolean(t.completed),
      failed: Boolean(t.failed),
    })),
    dateStart: json.date?.start ?? null,
    dateEnd: json.date?.end ?? null,
  };
}

export function questProgressHash(q: QuestState): string {
  return hashContent(
    JSON.stringify({
      status: q.status,
      tasks: q.tasks.map((t) => [t.name, t.completed, t.failed]),
      dateStart: q.dateStart,
      dateEnd: q.dateEnd,
    }),
  );
}

export function renderProgressFrontMatter(q: QuestState): Record<string, unknown> {
  return {
    status: q.status,
    tasks: q.tasks.map((t) => ({ name: t.name, completed: t.completed })),
  };
}
